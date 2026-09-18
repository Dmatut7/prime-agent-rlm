import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, ServiceTier, TextContent, Usage } from "@earendil-works/pi-ai";
import { randomUUID } from "crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
} from "fs";
import { lstat, readdir, readFile, stat } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { v7 as uuidv7 } from "uuid";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.js";
import {
	endsWithNewlineSync,
	FirstLineTooLongError,
	readBytesSync,
	readFileLines,
	readFirstLineSync,
	readLinesAsBuffers,
	repairTruncatedTrailingLine,
} from "../utils/file-lines.js";
import { captureGitContext, type GitContext, gitContextsEqual } from "../utils/git.js";
import { DEFAULT_MAP_CONCURRENCY_LIMIT, mapConcurrent } from "../utils/map-concurrent.js";
import {
	appendPrivateFile,
	assertRegularFileNoSymlink,
	ensurePrivateDirectory,
	requireNoFollow,
	UnterminatedTailError,
	writePrivateFileAtomicLines,
} from "../utils/private-files.js";
import type { AgentTaskState } from "./agent-task-state.js";
import {
	type BashExecutionMessage,
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./messages.js";
import {
	artifactDirectoryWriteMs,
	clearSessionArtifactTombstone,
	readSessionArtifactTombstone,
	tombstoneInForce,
} from "./session-artifact-tombstones.js";
import { assertValidSessionId, isValidSessionId, SESSION_ID_PATTERN } from "./session-id.js";
import {
	readCachedSessionInfo,
	removeCachedSessionInfo,
	SESSION_ARTIFACTS_DIR_NAME,
	scheduleSessionInfoCachePrune,
	writeCachedSessionInfo,
} from "./session-info-disk-cache.js";
import { acquireSessionLeaseAsync, SESSION_LEASES_ENABLED_ENV } from "./session-lease.js";
import { resolveCompleteToolPairLeaf } from "./session-tool-pair.js";
import {
	addAssistantUsage,
	cloneUsage,
	emptyUsage,
	type SessionUsageSummary,
	sessionUsageSummaryFrom,
	subtractAssistantUsage,
} from "./usage.js";

export const CURRENT_SESSION_VERSION = 3;
const SESSION_LIST_SEARCH_TEXT_MAX_CHARS = 64 * 1024;
const SESSION_LIST_PARSE_MAX_LINE_CHARS = 1024 * 1024;
const SESSION_LIST_LARGE_MESSAGE_PREVIEW_MAX_CHARS = 256;
const SESSION_STREAMING_LOAD_THRESHOLD_BYTES = 128 * 1024 * 1024;
/**
 * LAT-3: one child_usage_attributed line per streamed child assistant message
 * made the ledger 55.8% of a real 101,481-line transcript (56,622 lines for 288
 * child targets). Consecutive attributions for the same target are coalesced on
 * disk: the first lands immediately, later deltas merge into one line per
 * window. In-memory entries and every usage fold stay per-merge exact.
 */
const CHILD_USAGE_ATTRIBUTION_COALESCE_MAX_MERGES = 32;
const CHILD_USAGE_ATTRIBUTION_COALESCE_MAX_AGE_MS = 120_000;
const SESSION_ASYNC_PARSE_YIELD_BYTES = 4 * 1024 * 1024;
/** A session header is one short line; anything longer than this is not recoverable as one. */
const SESSION_HEADER_SCAN_MAX_BYTES = 64 * 1024;
/**
 * Upper bound on a trailing line that `completeTrailingRecordNewline` will read
 * back in full to decide whether it is a whole record (K3P-4). Real single-line
 * records (large tool results, base64 images) are megabytes at most; a line past
 * this bound is left untouched rather than risk truncating a record we cannot
 * verify: better an unrepaired tail than a destroyed record.
 */
const SESSION_TRAILING_RECORD_VERIFY_MAX_BYTES = 16 * 1024 * 1024;

// Entry types that can represent user intent (vs. daemon bookkeeping like
// session_state/agent_status/git_state/child_usage_attributed). Used by
// hasUserContent to decide whether a message-less draft is safe to discard.
const CONTENT_ENTRY_TYPES = new Set([
	"message",
	"custom_message",
	"custom",
	"model_change",
	"thinking_level_change",
	"service_tier_change",
	"session_info",
	"label",
	"compaction",
	"branch_summary",
]);

export interface SessionHeader {
	type: "session";
	version?: number; // v1 sessions don't have this
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	rlmDepth?: number;
	git?: GitContext;
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
	rlmDepth?: number;
}

export type SessionPersistListener = (sessionFile: string) => void;
export type SessionPersistFailureListener = (error: unknown) => void;

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

type AssistantSessionMessageEntry = SessionMessageEntry & { message: AssistantMessage };

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ServiceTierChangeEntry extends SessionEntryBase {
	type: "service_tier_change";
	serviceTier: ServiceTier;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	fromHook?: boolean;
	customInstructions?: string;
	usage?: Usage;
	/**
	 * Harness digest snapshot taken at compaction time; rendered before the summary
	 * in LLM context. Rides the schema-tolerant entry stream as an optional field,
	 * so entries written before it existed simply have no snapshot.
	 */
	harnessDigest?: string;
	/** Fingerprint of the harness state behind `harnessDigest` at compaction time; lets cold boundaries skip re-delivery. */
	harnessStateFingerprint?: string;
}

/**
 * Forensic record of one compaction commit, handed to `options.onCommit`.
 *
 * The classification exists because "the pinned leaf is not the current leaf" used to
 * be read as exactly one thing - branch navigation - when it can mean two: the session
 * may merely have appended forward while the summary was in flight (a child usage
 * attribution, a label write). Reading the second as the first parked the summary on a
 * side branch and left the live context uncompacted forever (issue #19).
 *
 * These fields are for the caller's log and for post-mortems only. They must NOT be
 * written into `CompactionEntry.details`: the next compaction reads the previous
 * entry's details back to seed its fact and user-request ledgers, so logging fields
 * there would feed the following summarization.
 *
 * Contract for `options.onCommit`: it must not throw. It runs after the entry is
 * durable and the leaf has moved, and a throw is swallowed so an observer cannot turn
 * a committed compaction into a reported failure (the caller's catch block would mark
 * it failed while the transcript already carries it, and would skip rebuilding the
 * agent state). There is no logger in this class, hence the silent swallow.
 */
export interface CompactionCommitInfo {
	classification:
		| "same_branch_forward"
		| "same_branch_no_window_append"
		| "branch_navigation"
		| "unknown_target_leaf"
		/**
		 * No pin reached this call. Named for what is observable rather than for one of its
		 * causes: the production caller passes `compactionLeafId ?? undefined`, so "the
		 * session was empty when the pin was taken" and "the caller supplied no pin" are
		 * indistinguishable here, and both behave as a same-branch commit.
		 */
		| "no_pin_supplied";
	/** The leaf the caller pinned when summarization started; null when no pin was supplied. */
	pinnedLeafId: string | null;
	/** The leaf after the commit. */
	currentLeafId: string | null;
	/**
	 * Entries appended between the pin and the compaction entry, on the branch the
	 * summary now sits on.
	 *
	 * ⚠️ Read this before using the field for forensics: under `branch_navigation` the
	 * count is STRUCTURALLY zero, because the entry's parent is the pin itself, so
	 * nothing can sit between them. Zero therefore does NOT mean "nothing was appended
	 * during the window" - appends made before the session navigated away do exist, they
	 * are simply not on this slice (they hang off the pin, and `getChildren(pin)` shows
	 * them). Reporting the whole-window total would need the entry count bookkept at pin
	 * time, which is deliberately not done. Drawing the inverse conclusion from a zero
	 * here is exactly the mistake this field exists to prevent.
	 */
	windowEntriesOnSummarizedBranch: number;
	windowEntryTypesOnSummarizedBranch: readonly string[];
	/** The cut point named a deferred attribution id and was walked back to a persisted ancestor. */
	firstKeptRewritten: boolean;
	/**
	 * The cut point named a deferred id with no persisted ancestor to walk back to.
	 *
	 * Defensive only, and deliberately untested: no public call sequence can make it
	 * true. `deferredAttributionIds` is populated solely by live attribution appends and
	 * `_buildIndex()` clears it on load, so a reopened session never gates; and in a live
	 * session the first attribution for a target is persisted immediately and is the
	 * parent of every later merge, so the upward walk always terminates at a persisted
	 * ancestor. Exercising this branch would require probing private state, which the
	 * repo forbids - the absence of a test here is a ruling, not an oversight.
	 */
	firstKeptUnresolvable: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: T;
	fromHook?: boolean;
	usage?: Usage;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

/**
 * Records usage folded into a parent assistant message after an RLM child run.
 * The child usage is kept separately so audit/UI code can explain why the
 * parent turn's aggregate usage exceeds the parent model response itself.
 */
export interface ChildUsageAttributionEntry extends SessionEntryBase {
	type: "child_usage_attributed";
	targetId: string;
	childUsage: Usage;
	aggregateUsage: Usage;
	origin?: "spawn_task" | "agent_message" | "direct_user";
}

/**
 * Deltas from child_usage_attributed merges that have not been written to the
 * session file yet. The flush line carries the summed childUsage, the newest
 * aggregateUsage, and splices the chain (id of the last merge, parentId of the
 * first unwritten merge) so a reload folds the same totals.
 *
 * LAT-4: the flush row's parent must reference an id a disk line carries, so
 * it is resolved at flush time by walking the live chain from the last merge
 * up to the nearest ancestor that is not a deferred merge id (a persisted
 * entry or an earlier flush row) - this keeps mid-window messages, markers and
 * compaction entries on the reloaded chain. anchorId (this target's newest
 * on-disk row) is the terminal fallback for a malformed chain.
 */
interface PendingAttributionWrite {
	anchorId: string;
	childUsage: Usage;
	aggregateUsage: Usage;
	origin?: ChildUsageAttributionEntry["origin"];
	lastId: string;
	lastTimestamp: string;
	merges: number;
	startedAt: number;
}

export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

export type SessionStateStatus = "active" | "archived" | "crash";

export interface SessionState {
	status: SessionStateStatus;
}

export interface SessionStateEntry extends SessionEntryBase {
	type: "session_state";
	state: SessionState;
}

// The verdict enum lives in its own leaf module (./agent-task-state.ts) so the receive side -
// modes/daemon/daemon-client.ts's saved-session validator - derives its guard from the same array
// instead of hand-writing a second copy of it. Re-exported here because AgentStatus, the session
// JSONL entry that carries it, is this module's shape.
export type { AgentTaskState };

export interface AgentStatus {
	summary: string;
	taskState?: AgentTaskState;
	basedOnMessageCount: number;
}

export interface AgentStatusEntry extends SessionEntryBase {
	type: "agent_status";
	status: AgentStatus;
}

export interface GitStateEntry extends SessionEntryBase {
	type: "git_state";
	git: GitContext;
}

/**
 * Records where the session was left by an explicit position change (`branch()`,
 * `resetLeaf()`).
 *
 * Resume resolves the active leaf from the last line of the session file, so a
 * leaf that only lives in process memory is silently undone by a restart: the
 * abandoned branch tip comes back into the model context. The marker is metadata
 * about the position, not the position itself - it hangs off the entry it points
 * at, `_buildIndex` resolves it back to that entry, and it never reaches the
 * model.
 */
export interface LeafPositionEntry extends SessionEntryBase {
	type: "leaf_position";
	/** Entry the session moved to, or null when the leaf was cleared. */
	targetId: string | null;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ServiceTierChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| ChildUsageAttributionEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry
	| SessionStateEntry
	| AgentStatusEntry
	| GitStateEntry
	| LeafPositionEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionTreeFlatNode {
	entry: SessionEntry;
	label?: string;
	labelTimestamp?: string;
}

export interface SessionTreeNode extends SessionTreeFlatNode {
	children: SessionTreeNode[];
}

/**
 * Nesting bound for a session tree handed to a client or embedded in a snapshot.
 *
 * A session tree is as deep as its longest parent chain, and a linear session's chain is
 * as long as the file: a real 101k-entry session produces one root nested 101,473 levels
 * deep. Every structured consumer pays per level, and `JSON.stringify` (which every JSONL
 * frame goes through) recurses per level until the stack is gone. 1000 levels is already
 * far past what a tree view renders, and it keeps the serializer's recursion depth two
 * orders of magnitude below the engine limit, so the wire stays serializable by construction.
 */
export const SESSION_TREE_MAX_WIRE_DEPTH = 1000;

/**
 * Node bound for the flat tree returned by the `get_session_tree` command.
 *
 * The flat tree ships every entry whole, so its cost is O(entries): a 101,514-entry
 * session is ~90MB of JSON per call, transferred whenever the tree/branch selector opens.
 * The bound keeps the newest entries (the leaf is always last in file order, so the branch
 * the session would resume on stays present) and reports how many were left out.
 */
export const SESSION_TREE_FLAT_MAX_NODES = 20_000;

/**
 * Total node bound for the nested tree returned by `getBoundedTree`, i.e. for every
 * tree a snapshot or client view embeds.
 *
 * Depth alone cannot bound the frame: a tree is only as deep as its longest parent
 * chain, but it is as wide as its branching, and a rewind-fork-heavy session is one
 * shallow root with tens of thousands of children. Such a tree passed the depth
 * window whole (O(entries) bytes, `truncated:false`) while the flat view of the same
 * session cut at {@link SESSION_TREE_FLAT_MAX_NODES}. The cap keeps the same side as
 * the flat bound - the newest entries, plus the live leaf's retained ancestor chain -
 * so one session never presents two opposite truncations.
 */
export const SESSION_TREE_MAX_WIRE_NODES = 20_000;

/** What a bounded nested tree left out, so a truncation is never silent. */
export interface SessionTreeDepthStats {
	/** Entries in the session. */
	entries: number;
	/** Nodes the caller receives. */
	returnedNodes: number;
	/**
	 * Nodes outside both retained depth windows: present in the session, absent from the
	 * returned tree. The windows are anchored at the deepest entry and at the live leaf's
	 * own depth, so these are the *older* ancestors of either chain - the same side of the
	 * session the flat bound drops.
	 */
	omittedNodes: number;
	/** Depth (parent edges) of the deepest entry in the session. */
	maxDepth: number;
	depthLimit: number;
	/**
	 * Depth of the shallowest retained node, i.e. how many top layers were cut. 0 does not
	 * by itself mean the whole tree fit: a width-only cut (see {@link maxNodes}) can drop
	 * the oldest siblings while the session's root-depth layer survives, so
	 * {@link truncated} is the field that says whether anything was dropped. A retained
	 * node whose parent is not retained comes back as a root, so a client can tell a
	 * truncated view from a session that really starts there.
	 */
	retainedFromDepth: number;
	/**
	 * The node cap the returned tree honors: `returnedNodes` never exceeds it. Absent on
	 * the pre-34 wire (older daemons do not send it), and `Number.MAX_SAFE_INTEGER` for
	 * an unbounded build, since the stats ride the wire and JSON has no Infinity.
	 */
	maxNodes: number;
	/**
	 * The session's live leaf is a node in the returned tree. A depth bound must not hide
	 * the entry the session resumes on: the window is anchored at the leaf's own depth, so
	 * the leaf keeps its retained ancestor chain, and a leaf that somehow falls outside
	 * every window is returned as a detached root (no ancestors, no children) instead of
	 * being dropped; this says whether either held. False when the session has no leaf.
	 */
	leafIncluded: boolean;
	truncated: boolean;
}

/** What a bounded flat tree left out, so a truncation is never silent. */
export interface SessionFlatTreeStats {
	totalEntries: number;
	returnedNodes: number;
	omittedNodes: number;
	maxNodes: number;
	truncated: boolean;
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	serviceTier: ServiceTier;
	model: { provider: string; modelId: string } | null;
}

export interface SessionModelRef {
	provider: string;
	modelId: string;
}

export interface SessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	state?: SessionState;
	/** Last model the session ran with, from model_change entries and assistant messages. */
	model?: SessionModelRef;
	parentSessionPath?: string;
	rlmDepth: number;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	agentStatus?: AgentStatus;
	usage?: SessionUsageSummary;
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getSessionName"
>;

/** Generate a fresh session id (uuidv7, so session files stay time-ordered). */
export function createSessionId(): string {
	return uuidv7();
}

export { assertValidSessionId, isValidSessionId };

function getSessionFilePath(sessionDir: string, sessionId: string): string {
	assertValidSessionId(sessionId);
	return join(sessionDir, `${sessionId}.jsonl`);
}

function createUniqueSessionFileTarget(sessionDir: string): { sessionId: string; sessionFile: string } {
	for (let i = 0; i < 100; i++) {
		const sessionId = createSessionId();
		const sessionFile = getSessionFilePath(sessionDir, sessionId);
		if (!existsSync(sessionFile)) {
			return { sessionId, sessionFile };
		}
	}
	throw new Error("Unable to create a unique session file");
}

export function getSessionArtifactsRoot(sessionDir: string): string {
	return resolve(dirname(sessionDir), SESSION_ARTIFACTS_DIR_NAME);
}

const tightenedArtifactDirectories = new Set<string>();

/** Transcripts already tightened in this process, so the warning is emitted once each. */
const tightenedTranscripts = new Set<string>();

/**
 * Tighten a transcript left with a pre-hardening mode on a read path.
 *
 * A session file holds the whole conversation, including anything a tool or a provider
 * error echoed into it, and pre-hardening versions wrote it with the default 0644, so
 * every account on the machine could read it. Read paths repair that in place and say
 * so once, the way `enforceArtifactDirectoryMode` repairs a legacy artifact directory:
 * a listing or a resume must not fail on a layout the reader can fix, and it must not
 * silently leave the credential-bearing file readable either.
 *
 * A mode that exposes nothing to other accounts (0600, 0400, 0000) is left alone, so a
 * deliberately fenced layout is not rewritten behind the operator's back. Refusals
 * stay with the caller's `assertRegularFileNoSymlink`: nothing is chmod'ed through a
 * symlink or on a path that is not a regular file.
 */
function enforcePrivateTranscriptMode(filePath: string): void {
	if (process.platform === "win32") return;
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(filePath);
	} catch {
		return;
	}
	if (stats.isSymbolicLink() || !stats.isFile()) return;
	const mode = stats.mode & 0o777;
	if ((mode & 0o077) === 0) return;
	chmodSync(filePath, 0o600);
	if (tightenedTranscripts.has(filePath)) return;
	tightenedTranscripts.add(filePath);
	console.error(`Tightened legacy session transcript to 0600: ${filePath}`);
}

/**
 * Enforce the private mode of an existing artifact directory on a read path.
 * Over-permissive directories with owner write (the default 0755/0775 that
 * pre-hardening versions created) are legacy layouts and are tightened in
 * place: an upgrade must not break supervisor startup, session listing, or
 * sweeps. Anything else (e.g. an operator-locked 0555) keeps the strict
 * refusal so deliberately fenced layouts are never silently altered.
 */
function enforceArtifactDirectoryMode(path: string, rawMode: number): void {
	if (process.platform === "win32") return;
	const mode = rawMode & 0o777;
	if (mode === 0o700) return;
	if ((mode & 0o077) !== 0 && (mode & 0o200) !== 0) {
		tightenLegacyArtifactDirectory(path);
		return;
	}
	throw new Error(`Refusing to read non-private session artifact directory: ${path}`);
}

/**
 * Pre-hardening versions created artifact directories with default 0755 modes.
 * Read paths tighten such legacy owner-owned directories instead of throwing:
 * an upgrade must not break supervisor startup, session listing, or artifact
 * sweeps. Symlinks and non-directories are still rejected before this runs; a
 * directory we do not own (fchmod refused) still fails closed.
 */
function tightenLegacyArtifactDirectory(path: string): void {
	const descriptor = openSync(
		path,
		constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | requireNoFollow(constants.O_NOFOLLOW),
	);
	try {
		fchmodSync(descriptor, 0o700);
	} finally {
		closeSync(descriptor);
	}
	if (!tightenedArtifactDirectories.has(path)) {
		tightenedArtifactDirectories.add(path);
		console.error(`Tightened legacy session artifact directory to 0700: ${path}`);
	}
}

export function getSessionArtifactPath(
	sessionDir: string,
	sessionId: string,
	create = false,
	enforcePrivateMode = true,
): string {
	assertValidSessionId(sessionId);
	const artifactRoot = getSessionArtifactsRoot(sessionDir);
	const artifactPath = resolve(artifactRoot, sessionId);
	const lexicalRelativePath = relative(artifactRoot, artifactPath);
	if (lexicalRelativePath.startsWith("..") || isAbsolute(lexicalRelativePath)) {
		throw new Error(`Session artifact path escapes its root: ${artifactPath}`);
	}

	if (!create) {
		if (!existsSync(artifactRoot)) return artifactPath;
		const rootStats = lstatSync(artifactRoot);
		if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
			throw new Error(`Refusing to use non-directory private path: ${artifactRoot}`);
		}
		if (enforcePrivateMode) {
			enforceArtifactDirectoryMode(artifactRoot, rootStats.mode);
		}
		if (!existsSync(artifactPath)) return artifactPath;
		const artifactStats = lstatSync(artifactPath);
		if (artifactStats.isSymbolicLink() || !artifactStats.isDirectory()) {
			throw new Error(`Refusing to use non-directory private path: ${artifactPath}`);
		}
		if (enforcePrivateMode) {
			enforceArtifactDirectoryMode(artifactPath, artifactStats.mode);
		}
		const canonicalRoot = realpathSync(artifactRoot);
		const canonicalArtifactPath = realpathSync(artifactPath);
		const canonicalRelativePath = relative(canonicalRoot, canonicalArtifactPath);
		if (canonicalRelativePath.startsWith("..") || isAbsolute(canonicalRelativePath)) {
			throw new Error(`Session artifact path escapes its canonical root: ${artifactPath}`);
		}
		return canonicalArtifactPath;
	}
	ensurePrivateDirectory(artifactRoot);
	ensurePrivateDirectory(artifactPath);
	const canonicalRoot = realpathSync(artifactRoot);
	const canonicalArtifactPath = realpathSync(artifactPath);
	const canonicalRelativePath = relative(canonicalRoot, canonicalArtifactPath);
	if (canonicalRelativePath.startsWith("..") || isAbsolute(canonicalRelativePath)) {
		throw new Error(`Session artifact path escapes its canonical root: ${artifactPath}`);
	}
	return canonicalArtifactPath;
}

/**
 * The session id a transcript declares in its own header, which is the id the running session
 * uses for `--resume` and for its artifact directory. `undefined` when the file has no readable
 * or well-formed header, when it is a symlink, or when it is gone.
 */
export function readSessionHeaderId(sessionFile: string): string | undefined {
	try {
		const header = readSessionHeader(sessionFile);
		if (header?.type !== "session" || typeof header.id !== "string") return undefined;
		return SESSION_ID_PATTERN.test(header.id) ? header.id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The id whose artifact directory holds this transcript's state. The header is the authority: a
 * file that was renamed, or imported under its export name, still writes into `<header id>`. The
 * file stem is only a fallback for a transcript whose header cannot be read.
 */
export function resolveSessionArtifactId(sessionFile: string): string {
	return readSessionHeaderId(sessionFile) ?? basename(sessionFile).replace(/\.jsonl$/, "");
}

export function getSessionArtifactPathForFile(sessionFile: string, sessionId?: string): string {
	return getSessionArtifactPath(dirname(sessionFile), sessionId ?? resolveSessionArtifactId(sessionFile), false);
}

function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	return randomUUID();
}

function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		// Without this the collision set stays empty and a repeated draw is handed
		// out twice: the duplicate id makes byId resolve an entry's parentId forward
		// to a later entry, and the parent walk from there closes a cycle.
		ids.add(entry.id);
		entry.parentId = prevId;
		prevId = entry.id;

		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (version > CURRENT_SESSION_VERSION) {
		// A file stamped by a newer CLI cannot be migrated down; silently skipping the
		// migration would let this CLI append its own older-format entries to it.
		throw new Error(
			`Session file uses format v${version}, which is newer than this Prime Agent supports (v${CURRENT_SESSION_VERSION}). Upgrade Prime Agent to open it.`,
		);
	}
	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);

	return true;
}

export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}

export function parseSessionEntries(content: string, sessionFile = "<inline transcript>"): FileEntry[] {
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");

	let lineNumber = 0;
	for (const line of lines) {
		lineNumber++;
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// Skip malformed lines.
			continue;
		}
		// Skip the lines that are not entries either: same tolerance as the file
		// loaders, so one bad line cannot take the transcript or the caller down.
		const reason = unindexableEntryReason(parsed);
		if (reason !== undefined) {
			noteTranscriptLineSkip(sessionFile, lineNumber, reason);
			continue;
		}
		entries.push(parsed as FileEntry);
	}

	applyChildUsageAttributions(entries);
	return entries;
}

/**
 * Why a parsed transcript line cannot be indexed, or undefined when it can.
 *
 * JSON.parse answers "is this text a JSON value", not "is this an entry". The
 * loaders promised to skip lines they cannot use but only guarded the parse, so a
 * line that is valid JSON of the wrong shape - a bare `null`, a message entry with
 * no message - reached the consumers below unprotected, where `entry.type` /
 * `entry.message.role` threw a bare TypeError. One such line cost the whole
 * transcript, and in the listing paths the catch turned that into "no such session".
 */
function unindexableEntryReason(entry: unknown): string | undefined {
	if (typeof entry !== "object" || entry === null) return "not an object";
	if (Array.isArray(entry)) return "array, not an entry object";
	if (typeof (entry as { type?: unknown }).type !== "string") return "missing or non-string entry type";
	if ((entry as { type: string }).type === "message") {
		const message = (entry as { message?: unknown }).message;
		if (typeof message !== "object" || message === null || Array.isArray(message)) {
			return "message entry without a message object";
		}
	}
	return undefined;
}

/** Whether an entry can be walked, indexed and rendered as the message it claims to be. */
function isAssistantMessageEntry(entry: FileEntry): entry is AssistantSessionMessageEntry {
	return (
		entry.type === "message" &&
		typeof (entry as SessionMessageEntry).message === "object" &&
		(entry as SessionMessageEntry).message?.role === "assistant"
	);
}

function applyChildUsageAttributions(entries: FileEntry[]): void {
	const assistantEntriesById = new Map<string, AssistantSessionMessageEntry>();
	for (const entry of entries) {
		if (isAssistantMessageEntry(entry)) {
			assistantEntriesById.set(entry.id, entry as AssistantSessionMessageEntry);
		}
	}

	for (const entry of entries) {
		if (entry.type !== "child_usage_attributed") continue;
		const target = assistantEntriesById.get(entry.targetId);
		if (!target) continue;
		target.message.usage = cloneUsage(entry.aggregateUsage);
	}
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
		}
	}

	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		return { messages: [], thinkingLevel: "off", serviceTier: "default", model: null };
	}
	if (leafId) {
		leaf = byId.get(leafId);
	}
	if (!leaf) {
		leaf = entries[entries.length - 1];
	}

	if (!leaf) {
		return { messages: [], thinkingLevel: "off", serviceTier: "default", model: null };
	}

	// push+reverse, not unshift-per-entry: unshift is O(n), making this O(n^2) on long sessions.
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();

	let thinkingLevel = "off";
	let serviceTier: ServiceTier = "default";
	let model: { provider: string; modelId: string } | null = null;
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "service_tier_change") {
			serviceTier = entry.serviceTier;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (isAssistantMessageEntry(entry)) {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	// Build messages and collect corresponding entries
	// When there's a compaction, model context remains summary-first while the
	// summary records where clients should present it among retained messages.
	const messages: AgentMessage[] = [];

	const appendMessage = (entry: SessionEntry, target = messages) => {
		if (entry.type === "message") {
			target.push(entry.message);
		} else if (entry.type === "custom_message") {
			target.push(
				createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp),
			);
		} else if (entry.type === "branch_summary" && entry.summary) {
			target.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	};

	if (compaction) {
		const compactionIdx = path.findIndex((e) => e.type === "compaction" && e.id === compaction.id);

		// Collect kept messages (before compaction, starting from firstKeptEntryId).
		// The context remains summary-first for the model; retainedMessageCount records
		// the exact chronological presentation boundary for clients.
		const retainedMessages: AgentMessage[] = [];
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = path[i];
			if (entry.id === compaction.firstKeptEntryId) {
				foundFirstKept = true;
			}
			if (foundFirstKept) {
				appendMessage(entry, retainedMessages);
			}
		}

		messages.push(
			createCompactionSummaryMessage(
				compaction.summary,
				compaction.tokensBefore,
				compaction.timestamp,
				compaction.customInstructions,
				retainedMessages.length,
				compaction.harnessDigest,
				compaction.harnessStateFingerprint,
			),
			...retainedMessages,
		);

		for (let i = compactionIdx + 1; i < path.length; i++) {
			const entry = path[i];
			appendMessage(entry);
		}
	} else {
		for (const entry of path) {
			appendMessage(entry);
		}
	}

	return { messages, thinkingLevel, serviceTier, model };
}

export function getDefaultSessionDir(_cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const sessionDir = getSessionsDir(agentDir);
	ensurePrivateDirectory(sessionDir);
	return sessionDir;
}

// Decode per line off a Buffer: toString("utf8") on a whole large file is far slower
// (one giant UTF-16 string). Splitting on 0x0a is UTF-8-safe.
/** A transcript line a load or scan had to ignore, and where it came from. */
export interface TranscriptLineSkip {
	sessionFile: string;
	/**
	 * 1-based line number within the range that was read: the whole file for a load
	 * or a cold listing scan, the appended tail for a resumed scan. 0 means the read
	 * as a whole failed, which is a different complaint from one bad line.
	 */
	line: number;
	/** Why the line could not be used. Kept short: it is shown to a human reading a report. */
	reason: string;
}

const transcriptLineSkips: TranscriptLineSkip[] = [];
const TRANSCRIPT_LINE_SKIP_LIMIT = 256;

function noteTranscriptLineSkip(sessionFile: string, line: number, reason: string): void {
	// Bounded and oldest-evicted: a damaged transcript scanned by every listing
	// refresh must not grow this without limit, and the skips worth reading are the
	// ones at the head of the file.
	if (transcriptLineSkips.length >= TRANSCRIPT_LINE_SKIP_LIMIT) transcriptLineSkips.shift();
	transcriptLineSkips.push({ sessionFile, line, reason });
}

/**
 * Lines the transcript loaders skipped rather than failing on. Skipping is the
 * documented behaviour; skipping silently is not, so every skip is recorded here
 * for the daemon and a human running `prime-agent` against a damaged file.
 */
export function getTranscriptLineSkips(): TranscriptLineSkip[] {
	return transcriptLineSkips.map((skip) => ({ ...skip }));
}

export function clearTranscriptLineSkips(): void {
	transcriptLineSkips.length = 0;
}

/**
 * The one unterminated line a reader must not drop: a session header that is the
 * whole file. Readers skip a trailing line with no newline because it is normally a
 * write still in flight, and a header truncated halfway through cannot parse - a
 * JSON object is missing its closing brace. So a tail that does parse as a session
 * header is a complete record whose terminating byte went missing (an external
 * truncate, a short write, an editor that strips the tail), and reading it as "no
 * session" cost the transcript its identity.
 */
function parseUnterminatedHeader(buffer: Buffer): SessionHeader | undefined {
	if (buffer.length === 0 || buffer.indexOf(0x0a) !== -1) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(buffer.toString("utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const header = parsed as Partial<SessionHeader>;
	if (header.type !== "session" || typeof header.id !== "string" || !SESSION_ID_PATTERN.test(header.id)) {
		return undefined;
	}
	return header as SessionHeader;
}

/**
 * Outcome of trying to restore the terminating newline of a whole trailing record.
 * - "completed": the byte was written, the record is whole again.
 * - "torn": the trailing line is not a whole record; the torn-tail repair may drop it.
 * - "unverifiable": the trailing line is longer than we are willing to parse, so
 *   whether it is a whole record cannot be decided. The file must be left exactly
 *   as it is: truncating it would destroy a record that may be complete (K3P-4).
 */
type TrailingRecordNewlineOutcome = "completed" | "torn" | "unverifiable";

/**
 * Restore the terminating newline of a last line that is a whole record - see
 * `parseUnterminatedHeader`. Any entry shape counts, not only a session header: an
 * append torn on its final byte leaves a complete message/state record with no
 * terminator, and the loaders drop exactly that line, so a non-header tail loses a
 * whole record where a header tail keeps its identity. Only the write owner may call
 * it: completing a line another process is still appending to would split its write
 * in two.
 */
function completeTrailingRecordNewline(filePath: string, ownsSessionDir: boolean): TrailingRecordNewlineOutcome {
	// Only the trailing line is inspected, bounded by size: a transcript whose last
	// line really was torn must not be re-read whole to learn nothing. But when the
	// window holds no newline at all, the trailing line is simply longer than the
	// window (a big tool result, a base64 image) and its true start is found by
	// scanning backwards, so the whole record can be verified instead of being
	// truncated away as "torn" (K3P-4).
	let fd: number | undefined;
	let tailLongerThanWindow = false;
	try {
		fd = openSync(filePath, constants.O_RDONLY);
		const { size } = fstatSync(fd);
		if (size === 0) return "torn";
		const length = Math.min(size, SESSION_HEADER_SCAN_MAX_BYTES);
		const tail = Buffer.allocUnsafe(length);
		if (readSync(fd, tail, 0, length, size - length) !== length) return "torn";
		const lastNewline = tail.lastIndexOf(0x0a);
		if (lastNewline === -1 && size > SESSION_HEADER_SCAN_MAX_BYTES) {
			tailLongerThanWindow = true;
		}
		const line = lastNewline === -1 ? readTrailingLine(fd, size, length) : tail.subarray(lastNewline + 1);
		if (line === undefined) return "unverifiable";
		if (line.length === 0) return "torn";
		if (!isCompleteUnterminatedEntryLine(line)) return "torn";
		appendPrivateFile(filePath, "\n", { privateParent: ownsSessionDir });
		return "completed";
	} catch {
		// A failure while handling a line that may be a whole oversized record must
		// not fall through to the truncating repair.
		return tailLongerThanWindow ? "unverifiable" : "torn";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * The whole trailing line of a file whose last `knownClean` bytes contain no
 * newline: its start is found by scanning backwards for the previous newline
 * (the same unbounded back-scan `repairTruncatedTrailingLine` already does), and
 * the line is read in full when it fits the verification bound. `undefined` when
 * the line is too long to verify or cannot be read: the caller must then leave
 * the file alone rather than treat it as torn (K3P-4).
 */
function readTrailingLine(fd: number, size: number, knownClean: number): Buffer | undefined {
	const lineStart = findTrailingLineStart(fd, size, knownClean);
	const lineLength = size - lineStart;
	if (lineLength > SESSION_TRAILING_RECORD_VERIFY_MAX_BYTES) {
		return undefined;
	}
	const line = Buffer.allocUnsafe(lineLength);
	if (readSync(fd, line, 0, lineLength, lineStart) !== lineLength) {
		return undefined;
	}
	return line;
}

/**
 * Byte offset just past the last newline before the final `knownClean` bytes (0
 * when there is none): where the trailing line starts.
 */
function findTrailingLineStart(fd: number, size: number, knownClean: number): number {
	const chunkSize = 64 * 1024;
	const scanEnd = Math.max(0, size - knownClean);
	let offset = Math.max(0, scanEnd - chunkSize);
	for (;;) {
		const length = Math.min(chunkSize, scanEnd - offset);
		if (length <= 0) return 0;
		const chunk = Buffer.allocUnsafe(length);
		if (readSync(fd, chunk, 0, length, offset) !== length) return 0;
		const index = chunk.lastIndexOf(0x0a);
		if (index !== -1) return offset + index + 1;
		if (offset === 0) return 0;
		offset = Math.max(0, offset - chunkSize);
	}
}

/**
 * The whole-record test for a trailing line that lost its terminator: it must parse
 * as JSON and be a loadable entry, exactly what `appendEntryFromBuffer` would have
 * accepted had the newline survived. Anything else is a torn write that
 * `repairTruncatedTrailingLine` drops.
 */
function isCompleteUnterminatedEntryLine(line: Buffer): boolean {
	if (line.indexOf(0x0a) !== -1) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line.toString("utf8"));
	} catch {
		return false;
	}
	return unindexableEntryReason(parsed) === undefined;
}

function appendEntryFromBuffer(
	entries: FileEntry[],
	buffer: Buffer,
	skipContext?: { sessionFile: string; line: number },
	start = 0,
	end = buffer.length,
): void {
	if (end <= start) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(buffer.toString("utf8", start, end));
	} catch {
		// Skip malformed or blank lines.
		return;
	}
	const reason = unindexableEntryReason(parsed);
	if (reason !== undefined) {
		if (skipContext) noteTranscriptLineSkip(skipContext.sessionFile, skipContext.line, reason);
		return;
	}
	entries.push(parsed as FileEntry);
}

function parseEntriesFromBuffer(buffer: Buffer, sessionFile: string): FileEntry[] {
	const entries: FileEntry[] = [];
	let start = 0;
	let line = 0;
	while (start < buffer.length) {
		line++;
		const end = buffer.indexOf(0x0a, start);
		// A trailing unterminated line is a torn append: every reader skips it,
		// and repairTruncatedTrailingLine removes it before the next write.
		if (end === -1) break;
		appendEntryFromBuffer(entries, buffer, { sessionFile, line }, start, end);
		start = end + 1;
	}
	const unterminatedHeader = parseUnterminatedHeader(buffer);
	if (entries.length === 0 && unterminatedHeader) entries.push(unterminatedHeader);
	return entries;
}

async function parseEntriesFromBufferAsync(buffer: Buffer, sessionFile: string): Promise<FileEntry[]> {
	const entries: FileEntry[] = [];
	let start = 0;
	let line = 0;
	let bytesSinceYield = 0;
	while (start < buffer.length) {
		line++;
		const end = buffer.indexOf(0x0a, start);
		// A trailing unterminated line is a torn append; see parseEntriesFromBuffer.
		if (end === -1) break;
		appendEntryFromBuffer(entries, buffer, { sessionFile, line }, start, end);
		bytesSinceYield += end - start + 1;
		start = end + 1;
		if (bytesSinceYield >= SESSION_ASYNC_PARSE_YIELD_BYTES) {
			bytesSinceYield = 0;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
	const unterminatedHeader = parseUnterminatedHeader(buffer);
	if (entries.length === 0 && unterminatedHeader) entries.push(unterminatedHeader);
	return entries;
}

/**
 * Zero-filled crash damage on the trailing record: upstream #2028's NUL rescue,
 * narrowed to this fork's tail-only, write-owned repair.
 *
 * A crash mid-append can leave the last line as `\0…\0{…json…}` with no
 * terminator. Every reader skips that line, and the torn-tail repair truncates it
 * away, so an intact record is lost. Upstream recovers those by rebuilding the
 * whole file; this fork only ever touches the trailing line and only under write
 * ownership, so the recovery rewrites just that line: drop the damaged tail, then
 * append the record back without its NUL prefix and with its terminator, through
 * the private-append path (0o600 / O_NOFOLLOW / fsync).
 *
 * Interior NUL-filled lines are deliberately NOT recovered: that needs the
 * whole-file rewrite this fork rejects (a read-only open must not write, and a
 * synchronous rewrite costs 2-3x the file size on the event loop). The caller
 * (`repairOwnedSessionFile`) has already asserted a regular, non-symlink file, so
 * the descriptor here is opened read-only like the neighbouring tail reader.
 *
 * True only when a record was recovered, so the caller can report "repaired".
 */
function recoverNulPrefixedTrailingRecord(filePath: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(filePath, constants.O_RDONLY);
		const { size } = fstatSync(fd);
		if (size === 0) return false;
		const window = Math.min(size, SESSION_HEADER_SCAN_MAX_BYTES);
		const tail = Buffer.allocUnsafe(window);
		if (readSync(fd, tail, 0, window, size - window) !== window) return false;
		// A terminated file has no crash-damaged trailing record to rescue.
		if (tail[window - 1] === 0x0a) return false;
		const lastNewline = tail.lastIndexOf(0x0a);
		const line = lastNewline === -1 ? readTrailingLine(fd, size, window) : tail.subarray(lastNewline + 1);
		// Too long to verify as a whole record (K3P-4): leave it to the unverifiable verdict.
		if (line === undefined) return false;
		let recordStart = 0;
		while (recordStart < line.length && line[recordStart] === 0) recordStart++;
		if (recordStart === 0) return false;
		const record = line.subarray(recordStart);
		if (record.length === 0 || !isCompleteUnterminatedEntryLine(record)) return false;
		const recovered = `${record.toString("utf8")}\n`;
		closeSync(fd);
		fd = undefined;
		// Both primitives are the ones the existing repair already uses. A crash
		// between them loses a line no reader could parse anyway, so the window is
		// not a regression against the truncation it replaces.
		repairTruncatedTrailingLine(filePath);
		appendPrivateFile(filePath, recovered, { privateParent: true });
		return true;
	} catch {
		// An unreadable tail stays exactly as it was: the caller's torn/unverifiable
		// verdicts own every case this recovery does not prove it can fix.
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
function parsesAsJson(line: Buffer): boolean {
	try {
		JSON.parse(line.toString("utf8"));
		return true;
	} catch {
		return false;
	}
}

function finalizeLoadedEntries(entries: FileEntry[]): FileEntry[] {
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (
		typeof header !== "object" ||
		header === null ||
		header.type !== "session" ||
		typeof (header as { id?: unknown }).id !== "string" ||
		!SESSION_ID_PATTERN.test((header as { id: string }).id)
	) {
		return [];
	}
	applyChildUsageAttributions(entries);
	return entries;
}

/**
 * Recover a transcript whose first line is damaged. finalizeLoadedEntries
 * rejects a file whose head is not a valid session header, which used to cost
 * the whole transcript: setSessionFile then started a fresh session and rewrote
 * the file, dropping every entry and leaving the session with a new id that no
 * longer matched its file name. Keep the entries that still parse — a damaged
 * head costs the header, not the transcript — and rebuild the header, taking
 * the id from the file name so the two stay in sync and the version the
 * salvaged body still needs. Returns undefined when there is nothing to
 * salvage: an empty file, an intact head (a file that simply never had a
 * header), or a body without a parseable entry.
 */
function salvageDamagedHeadEntries(filePath: string, cwd: string): FileEntry[] | undefined {
	let buffer: Buffer;
	try {
		buffer = readFileSync(filePath);
	} catch {
		return undefined;
	}
	if (buffer.length === 0) return undefined;

	const headEnd = buffer.indexOf(0x0a);
	const head = headEnd === -1 ? buffer : buffer.subarray(0, headEnd);
	if (parsesAsJson(head)) return undefined;

	const body = headEnd === -1 ? [] : parseEntriesFromBuffer(buffer.subarray(headEnd + 1), filePath);
	const entries = body.filter((entry): entry is SessionEntry => entry.type !== "session");
	if (entries.length === 0) return undefined;

	const firstTimestamp = entries[0].timestamp;
	const fileNameId = basename(filePath).replace(/\.jsonl$/, "");
	// A pre-v2 body carries no id/parentId. Stamp version 1 so the caller runs the
	// migration that assigns the chain; stamping the current version instead would
	// persist id-less entries under a header no later load migrates, leaving the
	// salvaged transcript on disk but invisible to every branch walk.
	const preV2Body = entries.every((entry) => typeof entry.id !== "string");
	const header: SessionHeader = {
		type: "session",
		version: preV2Body ? 1 : CURRENT_SESSION_VERSION,
		id: SESSION_ID_PATTERN.test(fileNameId) ? fileNameId : createSessionId(),
		timestamp: typeof firstTimestamp === "string" ? firstTimestamp : new Date().toISOString(),
		cwd,
	};
	const salvaged: FileEntry[] = [header, ...entries];
	applyChildUsageAttributions(salvaged);
	return salvaged;
}

/** Exported for testing */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	if (!existsSync(filePath)) return [];
	assertRegularFileNoSymlink(filePath);
	enforcePrivateTranscriptMode(filePath);
	return finalizeLoadedEntries(parseEntriesFromBuffer(readFileSync(filePath), filePath));
}

// Async loader for the daemon: reads off the event loop and yields while parsing so a
// large load doesn't freeze other sessions. Large files stream to avoid retaining both
// the full input Buffer and the parsed entry graph at the same time.
export async function loadEntriesFromFileAsync(
	filePath: string,
	options: { streamThresholdBytes?: number } = {},
): Promise<FileEntry[]> {
	if (!existsSync(filePath)) return [];
	assertRegularFileNoSymlink(filePath);
	enforcePrivateTranscriptMode(filePath);
	const streamThresholdBytes = options.streamThresholdBytes ?? SESSION_STREAMING_LOAD_THRESHOLD_BYTES;
	if ((await stat(filePath)).size < streamThresholdBytes) {
		return finalizeLoadedEntries(await parseEntriesFromBufferAsync(await readFile(filePath), filePath));
	}

	const entries: FileEntry[] = [];
	let line = 0;
	let bytesSinceYield = 0;
	for await (const fileLine of readFileLines(filePath)) {
		line++;
		// A trailing unterminated line is a torn append; see parseEntriesFromBuffer. The
		// one exception is a header that lost only its newline: it is a whole record, and
		// dropping it reads as an empty transcript.
		if (!fileLine.terminated) {
			// Line 1 with no terminator means the whole file is that line, which is how
			// the buffered loader reads the same shape: both paths must agree, or the
			// threshold that picks one over the other decides whether a session exists.
			if (entries.length === 0 && line === 1) {
				const unterminatedHeader = parseUnterminatedHeader(fileLine.line);
				if (unterminatedHeader) entries.push(unterminatedHeader);
			}
			break;
		}
		appendEntryFromBuffer(entries, fileLine.line, { sessionFile: filePath, line });
		bytesSinceYield += fileLine.line.length + 1;
		if (bytesSinceYield >= SESSION_ASYNC_PARSE_YIELD_BYTES) {
			bytesSinceYield = 0;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
	return finalizeLoadedEntries(entries);
}

/**
 * Drop a crash-torn trailing line from a session file the caller owns the
 * write side of (holds the lease / is the sole writer). Read-only opens —
 * agents-view attach, summaries, pre-lease opens — must never call this:
 * repairing a file another process is writing can truncate its in-flight
 * append. Validates the path first so a swapped-in symlink is rejected before
 * any truncation.
 *
 * A trailing line that parses as a complete record is not crash damage, it is a
 * whole record whose terminator went missing, and dropping it would throw away the
 * only session header a file like that has. Those get the terminator back instead.
 */
/**
 * Append-safety verdict of a repair pass over a write-owned session file:
 * - "repaired": something was fixed (terminator completed or torn tail
 *   truncated); the file now ends on a newline, so an append is safe.
 * - "clean": nothing needed repairing; an append is safe.
 * - "unverifiable": the trailing line is too long to verify as a whole record
 *   (K3P-4) and was left byte-for-byte in place. Appending now would glue the
 *   new line onto it, and the glued line then parses as nothing - both the
 *   record and the append vanish from every reader. Callers that append after
 *   a repair MUST refuse on this outcome instead of appending (K3P-45).
 */
export type SessionFileRepairOutcome = "repaired" | "clean" | "unverifiable";

export function repairOwnedSessionFile(sessionFile: string | undefined): SessionFileRepairOutcome {
	if (!sessionFile || !existsSync(sessionFile)) return "clean";
	assertRegularFileNoSymlink(sessionFile);
	// A zero-filled trailing record is still a whole record (upstream #2028's NUL
	// rescue): recover it before the torn-tail path below truncates it away.
	if (recoverNulPrefixedTrailingRecord(sessionFile)) return "repaired";
	// A header that lost only its terminator is a whole record, not a torn append:
	// truncating it away would leave the transcript with no header at all.
	const outcome = completeTrailingRecordNewline(sessionFile, true);
	if (outcome === "completed") return "repaired";
	if (outcome === "unverifiable") {
		// K3P-4: the trailing line is too long to verify as a whole record.
		// Dropping it as torn would destroy a record that may be complete, so the
		// file is left as it is. Returning the outcome lets the append callers
		// refuse instead of gluing (K3P-45); a manual repair can still complete
		// the terminator later, which is the only lossless way forward.
		return "unverifiable";
	}
	repairTruncatedTrailingLine(sessionFile);
	return "repaired";
}

/**
 * The transcript's trailing record is unterminated and too large to verify, so
 * the write owner refuses to append onto it (K3P-45): gluing would make the
 * record and the append both unreadable while the receipt claimed success.
 */
export class SessionTailUnverifiableError extends Error {
	constructor(readonly sessionFile: string) {
		super(
			`Refusing to append to ${sessionFile}: its trailing record is unterminated and too large to verify, so appending would glue the lines together and hide both`,
		);
		this.name = "SessionTailUnverifiableError";
	}
}

/**
 * Append one line to a session file this process does not otherwise own, under a
 * write lease taken for the duration of the append (K3P-5, the
 * `daemon-catalog-process.ts` precedent). The catalog comment, verbatim in spirit:
 * repair only under the lease - the torn tail belongs to whoever was writing, and
 * truncating a live writer's in-flight append corrupts it. Without a lease the
 * append is refused rather than performed blind: `acquireSessionLease` either
 * grants the lease or throws (a live owner holds it), and the forced
 * `SESSION_LEASES_ENABLED_ENV` keeps the "no lease" fallback from silently
 * degrading into an unguarded write.
 */
export async function appendOwnedSessionLineAsync(
	sessionPath: string,
	agentDir: string,
	append: (manager: SessionManager) => void,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const lease = await acquireSessionLeaseAsync(sessionPath, agentDir, {
		...environment,
		[SESSION_LEASES_ENABLED_ENV]: "1",
	});
	if (!lease) {
		throw new Error(`Refusing to append to a session without a write lease: ${sessionPath}`);
	}
	try {
		const repair = repairOwnedSessionFile(sessionPath);
		if (repair === "unverifiable") {
			// K3P-45: the trailing record could not be verified whole, and the
			// repair left it in place on purpose. Appending would glue both lines
			// into one unparsable interior line - the record AND this append would
			// vanish from every reader while the caller's receipt said success.
			throw new Error(
				`Refusing to append to ${sessionPath}: its trailing record is unterminated and too large to verify, so appending would glue the lines together and hide both`,
			);
		}
		append(SessionManager.open(sessionPath));
	} finally {
		lease.release();
	}
}

function readSessionHeader(filePath: string): Partial<SessionHeader> | undefined {
	assertRegularFileNoSymlink(filePath);
	enforcePrivateTranscriptMode(filePath);
	const firstLine = readFirstLineSync(filePath);
	if (!firstLine) {
		return undefined;
	}
	return JSON.parse(firstLine) as Partial<SessionHeader>;
}

function isValidRlmDepth(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function resolveSessionRlmDepth(
	header: { rlmDepth?: number; parentSession?: string },
	sessionPath: string,
): number {
	return resolveLegacySessionRlmDepth(header, sessionPath, new Set()) ?? legacyChildDepthFromPath(sessionPath);
}

function resolveLegacySessionRlmDepth(
	header: { rlmDepth?: number; parentSession?: string },
	sessionPath: string,
	visitedPaths: Set<string>,
): number | undefined {
	if (isValidRlmDepth(header.rlmDepth)) {
		return header.rlmDepth;
	}
	if (!header.parentSession) {
		return 0;
	}

	const resolvedSessionPath = resolve(sessionPath);
	if (visitedPaths.has(resolvedSessionPath)) {
		return undefined;
	}
	visitedPaths.add(resolvedSessionPath);

	const pathDepth = legacyChildDepthFromPath(sessionPath);
	const parentSessionPath = resolve(dirname(sessionPath), header.parentSession);
	try {
		const parentHeader = readSessionHeader(parentSessionPath);
		if (parentHeader) {
			const parentDepth = resolveLegacySessionRlmDepth(parentHeader, parentSessionPath, visitedPaths);
			if (parentDepth !== undefined) {
				return pathDepth > 0 ? parentDepth + 1 : parentDepth;
			}
		}
	} catch {
		// Fall back to artifact ancestry for unavailable or invalid legacy parents.
	} finally {
		visitedPaths.delete(resolvedSessionPath);
	}
	return pathDepth;
}

function legacyChildDepthFromPath(sessionPath: string): number {
	let depth = 0;
	for (const segment of dirname(sessionPath)
		.split(/[\\/]+/)
		.reverse()) {
		if (!/^sub-[0-9a-f]{8}$/.test(segment)) {
			break;
		}
		depth += 1;
	}
	return depth;
}

function deriveChildRlmDepth(parentHeader: Partial<SessionHeader> | undefined): number | undefined {
	const depth = parentHeader?.rlmDepth;
	return isValidRlmDepth(depth) && depth < Number.MAX_SAFE_INTEGER ? depth + 1 : undefined;
}

function rootRlmDepthFromEnv(): number {
	const value = process.env.RLM_DEPTH;
	if (value === undefined || value === "") {
		return 0;
	}
	const parsed = Number(value);
	if (!/^\d+$/.test(value) || !isValidRlmDepth(parsed)) {
		throw new Error("RLM_DEPTH must be a non-negative integer");
	}
	return parsed;
}

/**
 * A header that could not be read at all is not the same as a file that has no
 * header: the first is a transcript this process is hiding from the listing and
 * `-c`, the second is not a session. Only the first is worth a diagnostic.
 */
function noteUnreadableHeader(filePath: string, error: unknown): void {
	if (error instanceof FirstLineTooLongError) {
		noteTranscriptLineSkip(filePath, 0, error.message);
	}
}

function isValidSessionFile(filePath: string): boolean {
	try {
		const header = readSessionHeader(filePath);
		return header?.type === "session" && typeof header.id === "string" && SESSION_ID_PATTERN.test(header.id);
	} catch (error) {
		noteUnreadableHeader(filePath, error);
		return false;
	}
}

export function findMostRecentSession(sessionDir: string): string | null {
	try {
		const files = readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(sessionDir, f))
			.filter(isValidSessionFile)
			.map((path) => ({ path, mtime: statSync(path).mtime }))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files[0]?.path || null;
	} catch {
		return null;
	}
}

function normalizeCwd(cwd: string): string {
	return resolve(cwd);
}

function sessionInfoMatchesCwd(session: SessionInfo, cwd: string): boolean {
	return !!session.cwd && normalizeCwd(session.cwd) === normalizeCwd(cwd);
}

function sessionHeaderMatchesCwd(header: Partial<SessionHeader> | undefined, cwd: string): boolean {
	return (
		header?.type === "session" &&
		typeof header.id === "string" &&
		SESSION_ID_PATTERN.test(header.id) &&
		typeof header.cwd === "string" &&
		normalizeCwd(header.cwd) === normalizeCwd(cwd)
	);
}

export function findMostRecentSessionForCwd(sessionDir: string, cwd: string): string | null {
	try {
		const files = readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(sessionDir, f))
			.map((path) => {
				try {
					const header = readSessionHeader(path);
					if (!sessionHeaderMatchesCwd(header, cwd)) {
						return undefined;
					}
					return { path, mtime: statSync(path).mtime };
				} catch (error) {
					noteUnreadableHeader(path, error);
					return undefined;
				}
			})
			.filter((entry): entry is { path: string; mtime: Date } => entry !== undefined)
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files[0]?.path || null;
	} catch {
		return null;
	}
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function normalizeSessionStateStatus(value: unknown): SessionStateStatus | undefined {
	if (value === "active" || value === "archived" || value === "crash") {
		return value;
	}
	if (value === "hidden" || value === "sleep") {
		return "archived";
	}
	return undefined;
}

function updateLastActivityTime(lastActivityTime: number | undefined, entry: FileEntry): number | undefined {
	if (entry.type !== "message") {
		return lastActivityTime;
	}

	const message = (entry as SessionMessageEntry).message;
	if (!isMessageWithContent(message)) {
		return lastActivityTime;
	}
	if (message.role !== "user" && message.role !== "assistant") {
		return lastActivityTime;
	}

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return Math.max(lastActivityTime ?? 0, msgTimestamp);
	}

	const entryTimestamp = (entry as SessionEntryBase).timestamp;
	if (typeof entryTimestamp === "string") {
		const t = new Date(entryTimestamp).getTime();
		if (!Number.isNaN(t)) {
			return Math.max(lastActivityTime ?? 0, t);
		}
	}

	return lastActivityTime;
}

function getSessionModifiedDateFromLastActivity(
	lastActivityTime: number | undefined,
	header: SessionHeader,
	statsMtime: Date,
): Date {
	if (typeof lastActivityTime === "number" && lastActivityTime > 0) {
		return new Date(lastActivityTime);
	}

	const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
	return !Number.isNaN(headerTime) ? new Date(headerTime) : statsMtime;
}

function appendCappedSearchText(current: string, text: string): string {
	if (!text || current.length >= SESSION_LIST_SEARCH_TEXT_MAX_CHARS) {
		return current;
	}
	const next = current ? ` ${text}` : text;
	return current + next.slice(0, SESSION_LIST_SEARCH_TEXT_MAX_CHARS - current.length);
}

function looksLikeMessageEntry(line: string): boolean {
	return line.includes('"type":"message"') || line.includes('"type": "message"');
}

function extractJsonStringPropertyPrefix(
	text: string,
	propertyName: string,
	maxChars: number,
	startIndex = 0,
): string | undefined {
	const propertyIndex = text.indexOf(`"${propertyName}"`, startIndex);
	if (propertyIndex < 0) {
		return undefined;
	}
	let index = propertyIndex + propertyName.length + 2;
	while (index < text.length && /\s/.test(text[index] ?? "")) index++;
	if (text[index] !== ":") {
		return undefined;
	}
	index++;
	while (index < text.length && /\s/.test(text[index] ?? "")) index++;
	if (text[index] !== '"') {
		return undefined;
	}
	index++;

	let result = "";
	let escaped = false;
	for (; index < text.length && result.length < maxChars; index++) {
		const char = text[index];
		if (escaped) {
			result += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') {
			break;
		}
		result += char;
	}
	return result;
}

function extractOversizedMessageSummary(line: string): {
	role?: string;
	timestamp?: number;
	textPreview?: string;
} {
	const timestampText = extractJsonStringPropertyPrefix(line, "timestamp", 64);
	const timestamp = timestampText ? new Date(timestampText).getTime() : NaN;
	const messageIndex = line.indexOf('"message"');
	const role =
		messageIndex >= 0
			? extractJsonStringPropertyPrefix(line, "role", 64, messageIndex)
			: extractJsonStringPropertyPrefix(line, "role", 64);
	let textPreview: string | undefined;
	if (messageIndex >= 0) {
		textPreview =
			extractJsonStringPropertyPrefix(line, "content", SESSION_LIST_LARGE_MESSAGE_PREVIEW_MAX_CHARS, messageIndex) ??
			extractJsonStringPropertyPrefix(line, "text", SESSION_LIST_LARGE_MESSAGE_PREVIEW_MAX_CHARS, messageIndex);
	}
	return {
		role,
		...(Number.isNaN(timestamp) ? {} : { timestamp }),
		...(textPreview ? { textPreview } : {}),
	};
}

interface SessionScanAccumulator {
	header?: SessionHeader;
	model?: SessionModelRef;
	/** The first parsed entry was not a session header; appends cannot repair this. */
	invalid: boolean;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	name?: string;
	state?: SessionState;
	agentStatus?: AgentStatus;
	lastActivityTime?: number;
	// Fold attribution aggregates like the loader: either disk representation cancels to the same own spend.
	assistantUsageById: Map<string, Usage>;
	attributedChildUsage: Usage;
	summarizationUsage: Usage;
	/**
	 * Attributions read before the assistant line they annotate, in file order:
	 * an imported or hand-reordered transcript can invert the writer's order. Held
	 * until the target line arrives so the one-pass scan folds them exactly like the
	 * loader's order-insensitive two-pass fold instead of dropping them (fork port).
	 */
	pendingAttributions: ChildUsageAttributionEntry[];
}

interface SessionScanState {
	fileSize: number;
	mtimeMs: number;
	/** Identity of the scanned file: a rename rewrite replaces the inode and invalidates the resume state. */
	dev: number;
	ino: number;
	/** Bytes consumed as complete newline-terminated lines; the resume point for the next scan. */
	offset: number;
	/** Last bytes of the consumed prefix; a resume only proceeds while the file still starts with them. */
	tail: Buffer;
	acc: SessionScanAccumulator;
	info: SessionInfo | null;
	/** Usage entries counted against the retained bound at the last store. */
	accountedUsageEntries: number;
}

const SESSION_SCAN_RESUME_TAIL_BYTES = 16;
const NEWLINE_BUFFER = Buffer.from("\n");
// Memory/performance budget: whole-state LRU eviction can force a full catalog rescan every refresh.
// Keep large families (~2k sessions, 150k usage entries) and growth headroom resident.
const SESSION_SCAN_MAX_RETAINED_USAGE_ENTRIES = 400_000;

// Session files are append-only between whole-file rewrites, so scans resume
// from the last consumed byte offset; rewrites are detected by shrink,
// same-size mtime change, replaced inode, or a changed prefix tail. In-place
// interior edits that defeat all four are outside the writer model.
const sessionScanStates = new Map<string, SessionScanState>();
// Scans of a path run one at a time; a later caller chains its own pass (its
// stat sees every prior append) instead of joining an earlier scan's result.
const sessionScanQueue = new Map<string, Promise<SessionInfo | null>>();

export function readSessionInfo(filePath: string): Promise<SessionInfo | null> {
	const previous = sessionScanQueue.get(filePath);
	const scan = previous
		? previous.then(
				() => scanSessionInfo(filePath),
				() => scanSessionInfo(filePath),
			)
		: scanSessionInfo(filePath);
	sessionScanQueue.set(filePath, scan);
	void scan.finally(() => {
		if (sessionScanQueue.get(filePath) === scan) sessionScanQueue.delete(filePath);
	});
	return scan;
}

let retainedUsageEntries = 0;

function dropSessionScanState(filePath: string): void {
	const state = sessionScanStates.get(filePath);
	if (!state) return;
	retainedUsageEntries -= state.accountedUsageEntries;
	sessionScanStates.delete(filePath);
}

/** Refresh LRU recency and enforce the retained-usage bound. */
function storeSessionScanState(filePath: string, state: SessionScanState): void {
	dropSessionScanState(filePath);
	state.accountedUsageEntries = state.acc.assistantUsageById.size;
	retainedUsageEntries += state.accountedUsageEntries;
	sessionScanStates.set(filePath, state);
	for (const key of sessionScanStates.keys()) {
		if (retainedUsageEntries <= SESSION_SCAN_MAX_RETAINED_USAGE_ENTRIES) break;
		dropSessionScanState(key);
	}
}

function createSessionScanAccumulator(): SessionScanAccumulator {
	return {
		invalid: false,
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
		assistantUsageById: new Map<string, Usage>(),
		attributedChildUsage: emptyUsage(),
		summarizationUsage: emptyUsage(),
		pendingAttributions: [],
	};
}

function scannedPrefixIntact(filePath: string, state: SessionScanState): boolean {
	if (state.offset === 0) return true;
	try {
		const start = Math.max(0, state.offset - SESSION_SCAN_RESUME_TAIL_BYTES);
		return readBytesSync(filePath, start, state.offset).equals(state.tail);
	} catch {
		return false;
	}
}

/** Last bytes of the consumed prefix after appending one line and its newline, copied out of the stream chunk. */
function advanceScanTail(tail: Buffer, line: Buffer): Buffer {
	if (line.length >= SESSION_SCAN_RESUME_TAIL_BYTES - 1) {
		return Buffer.concat([line.subarray(line.length - (SESSION_SCAN_RESUME_TAIL_BYTES - 1)), NEWLINE_BUFFER]);
	}
	const combined = Buffer.concat([tail, line, NEWLINE_BUFFER]);
	return combined.length <= SESSION_SCAN_RESUME_TAIL_BYTES
		? combined
		: Buffer.from(combined.subarray(combined.length - SESSION_SCAN_RESUME_TAIL_BYTES));
}

/**
 * Which layer served each `readSessionInfo` call. The point is not telemetry for
 * its own sake: "the disk layer absorbed what a fresh process would otherwise
 * have re-scanned" is the whole claim behind the durable cache, and it is only
 * checkable if the layers are counted. Memory hits are the upstream scan-state
 * map, disk hits the fork's durable summary layer, and the two scan counters
 * distinguish a resumed pass from one that paid for the whole file.
 */
export interface SessionInfoReadStats {
	memoryHits: number;
	diskHits: number;
	fullScans: number;
	resumedScans: number;
}

const sessionInfoReadStats: SessionInfoReadStats = {
	memoryHits: 0,
	diskHits: 0,
	fullScans: 0,
	resumedScans: 0,
};

export function getSessionInfoReadStats(): SessionInfoReadStats {
	return { ...sessionInfoReadStats };
}

/**
 * Drop the process-local summary cache (and its counters) so a caller can
 * reproduce the state a freshly spawned worker starts in: no summaries in
 * memory, everything on disk still there. Eviction goes through
 * `dropSessionScanState` so the retained-usage accounting stays exact.
 */
export function clearSessionInfoCaches(): void {
	for (const key of [...sessionScanStates.keys()]) {
		dropSessionScanState(key);
	}
	sessionInfoReadStats.memoryHits = 0;
	sessionInfoReadStats.diskHits = 0;
	sessionInfoReadStats.fullScans = 0;
	sessionInfoReadStats.resumedScans = 0;
}

/**
 * Drop every summary held for a transcript that no longer exists, in both cache
 * layers. Called on delete so a removed session does not leave a durable entry
 * behind for the weekly prune to find.
 */
export async function forgetSessionInfo(filePath: string): Promise<void> {
	dropSessionScanState(filePath);
	await removeCachedSessionInfo(filePath);
}

async function scanSessionInfo(filePath: string, retryOnReplacement = true): Promise<SessionInfo | null> {
	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		const lexicalStats = await lstat(filePath);
		if (lexicalStats.isSymbolicLink() || !lexicalStats.isFile()) return null;
		enforcePrivateTranscriptMode(filePath);
		stats = await stat(filePath);
	} catch {
		dropSessionScanState(filePath);
		return null;
	}
	const previous = sessionScanStates.get(filePath);
	const sameFile = previous !== undefined && previous.dev === stats.dev && previous.ino === stats.ino;
	if (sameFile && previous.fileSize === stats.size && previous.mtimeMs === stats.mtimeMs) {
		sessionInfoReadStats.memoryHits++;
		storeSessionScanState(filePath, previous);
		return previous.info;
	}
	const resume = sameFile && stats.size > previous.fileSize && scannedPrefixIntact(filePath, previous);
	if (!resume) {
		// A full scan is the expensive branch, so try the fork's durable layer first:
		// a summary another process already computed for this exact (dev, ino, size,
		// mtimeMs) is equivalent to scanning again. Resumable reads skip it - a few
		// appended bytes are cheaper to parse than a whole summary is to load, and a
		// resume keeps the incremental state that the next append needs.
		const durable = await readCachedSessionInfo(filePath, {
			dev: stats.dev,
			ino: stats.ino,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
		});
		if (durable) {
			sessionInfoReadStats.diskHits++;
			// Drop any stale scan state with it: that accumulator stopped before this
			// summary's bytes, so a later append must not resume from it and silently
			// lose the range the durable summary already covered.
			dropSessionScanState(filePath);
			return durable;
		}
	}
	const state: SessionScanState = resume
		? previous
		: {
				fileSize: 0,
				mtimeMs: 0,
				dev: stats.dev,
				ino: stats.ino,
				offset: 0,
				tail: Buffer.alloc(0),
				acc: createSessionScanAccumulator(),
				info: null,
				accountedUsageEntries: 0,
			};
	try {
		const tornTail = await scanSessionLines(filePath, state, stats.size);
		state.info = snapshotSessionInfo(state.acc, tornTail, filePath, stats);
	} catch {
		dropSessionScanState(filePath);
		return null;
	}
	// A rename rewrite racing the scan can mix two files' bytes into one
	// accumulator: a changed inode afterwards discards the state and rescans.
	let after: Awaited<ReturnType<typeof stat>> | undefined;
	try {
		after = await stat(filePath);
	} catch {
		after = undefined;
	}
	if (!after || after.dev !== stats.dev || after.ino !== stats.ino) {
		dropSessionScanState(filePath);
		return retryOnReplacement ? scanSessionInfo(filePath, false) : null;
	}
	state.fileSize = stats.size;
	state.mtimeMs = stats.mtimeMs;
	storeSessionScanState(filePath, state);
	if (resume) {
		sessionInfoReadStats.resumedScans++;
	} else {
		sessionInfoReadStats.fullScans++;
		if (state.info) {
			// Only a full scan is persisted: it is the one that just paid for the whole
			// file. A resumed scan's summary would be rewritten on every append of a
			// live session, and the next process cannot use it anyway until the file
			// stops growing.
			await writeCachedSessionInfo(
				filePath,
				{ dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs },
				state.info,
			);
			scheduleSessionInfoCachePrune();
		}
	}
	return state.info;
}

/**
 * Fold the complete lines in [state.offset, size) into the accumulator. An
 * unterminated final line may be an in-progress append: it is returned for
 * snapshot-only folding, never consumed into the resumable accumulator.
 */
async function scanSessionLines(filePath: string, state: SessionScanState, size: number): Promise<Buffer | undefined> {
	if (state.acc.invalid || state.offset >= size) return undefined;
	// Pass-relative line numbers: a skip note names the line this read could not
	// use, and a resumed pass starts counting at its own first line.
	let lineNo = 0;
	for await (const lineBuffer of readLinesAsBuffers(filePath, { start: state.offset, end: size - 1 })) {
		lineNo++;
		const lineEnd = state.offset + lineBuffer.length;
		if (lineEnd >= size) return lineBuffer;
		foldSessionScanLine(state.acc, lineBuffer, { filePath, line: lineNo });
		state.tail = advanceScanTail(state.tail, lineBuffer);
		state.offset = lineEnd + 1;
		if (state.acc.invalid) break;
	}
	return undefined;
}

function foldSessionScanLine(
	acc: SessionScanAccumulator,
	lineBuffer: Buffer,
	ctx?: { filePath: string; line: number },
): void {
	const line = lineBuffer.toString("utf8");
	if (!line.trim()) return;

	// Large tool-result entries can be many MB. They do not carry the
	// session-list metadata we need, and parsing them during every refresh
	// can exhaust the daemon heap.
	if (line.length > SESSION_LIST_PARSE_MAX_LINE_CHARS) {
		if (looksLikeMessageEntry(line)) {
			acc.messageCount++;
			const summary = extractOversizedMessageSummary(line);
			if (typeof summary.timestamp === "number" && (summary.role === "user" || summary.role === "assistant")) {
				acc.lastActivityTime = Math.max(acc.lastActivityTime ?? 0, summary.timestamp);
			}
			if (summary.role === "user" && !acc.firstMessage) {
				acc.firstMessage = summary.textPreview || "(large message)";
			}
		}
		return;
	}

	const trimmed = line.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return;
	}
	// One unusable line is skipped, not fatal - and it is countable: the loader and
	// the scan must agree on what a transcript contains.
	const skipReason = unindexableEntryReason(parsed);
	if (skipReason !== undefined) {
		if (ctx) noteTranscriptLineSkip(ctx.filePath, ctx.line, skipReason);
		return;
	}
	const entry = parsed as FileEntry;

	if (entry.type === "session_info") {
		const infoEntry = entry as SessionInfoEntry;
		acc.name = infoEntry.name?.trim() || undefined;
	}
	if (entry.type === "session_state") {
		const stateEntry = entry as SessionStateEntry;
		const status = normalizeSessionStateStatus(stateEntry.state?.status);
		if (status) {
			acc.state = { status };
		}
	}
	// Keep the latest recap/verdict so off-daemon sessions don't all show as
	// unjudged in the agents view. Append-only, so last seen wins.
	if (entry.type === "agent_status") {
		acc.agentStatus = (entry as AgentStatusEntry).status;
	}
	if (entry.type === "model_change") {
		const modelEntry = entry as ModelChangeEntry;
		acc.model = { provider: modelEntry.provider, modelId: modelEntry.modelId };
	}
	if (entry.type === "child_usage_attributed") {
		const attribution = entry as ChildUsageAttributionEntry;
		if (acc.assistantUsageById.has(attribution.targetId)) {
			acc.assistantUsageById.set(attribution.targetId, attribution.aggregateUsage);
			addAssistantUsage(acc.attributedChildUsage, attribution.childUsage);
		} else {
			// Target not seen yet: hold the attribution and fold it when the target
			// line arrives, so this scan and the loader agree on files whose lines are
			// not in writer order (fork port; upstream dropped them).
			acc.pendingAttributions.push(attribution);
		}
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		const summarizationUsage = (entry as CompactionEntry | BranchSummaryEntry).usage;
		if (summarizationUsage) addAssistantUsage(acc.summarizationUsage, summarizationUsage);
	}
	if (!acc.header) {
		if (entry.type !== "session") {
			acc.invalid = true;
			return;
		}
		const header = entry as SessionHeader;
		// A first line that cannot name the transcript is not a session: refuse the
		// listing row instead of showing a bogus id (fork port of the scan's check).
		if (typeof header.id !== "string" || !SESSION_ID_PATTERN.test(header.id)) {
			acc.invalid = true;
			return;
		}
		acc.header = header;
	}

	acc.lastActivityTime = updateLastActivityTime(acc.lastActivityTime, entry);

	if (entry.type !== "message") return;
	acc.messageCount++;

	const message = (entry as SessionMessageEntry).message;
	if (message.role === "assistant" && (message as { usage?: Usage }).usage) {
		acc.assistantUsageById.set(entry.id, (message as { usage: Usage }).usage);
		// Attributions read before this line fold now, in file order, so newest-wins
		// matches the loader for inverted-order transcripts too.
		for (let index = 0; index < acc.pendingAttributions.length; ) {
			const attribution = acc.pendingAttributions[index];
			if (attribution.targetId !== entry.id) {
				index++;
				continue;
			}
			acc.pendingAttributions.splice(index, 1);
			acc.assistantUsageById.set(entry.id, attribution.aggregateUsage);
			addAssistantUsage(acc.attributedChildUsage, attribution.childUsage);
		}
	}
	if (message.role === "assistant") {
		const assistant = message as { provider?: string; model?: string };
		if (typeof assistant.provider === "string" && typeof assistant.model === "string") {
			acc.model = { provider: assistant.provider, modelId: assistant.model };
		}
	}
	if (!isMessageWithContent(message)) return;
	if (message.role !== "user" && message.role !== "assistant") return;

	const textContent = extractTextContent(message);
	if (!textContent) return;

	acc.allMessagesText = appendCappedSearchText(acc.allMessagesText, textContent);
	if (!acc.firstMessage && message.role === "user") {
		acc.firstMessage = textContent;
	}
}

function snapshotSessionInfo(
	persistent: SessionScanAccumulator,
	tornTail: Buffer | undefined,
	filePath: string,
	stats: Awaited<ReturnType<typeof stat>>,
): SessionInfo | null {
	let acc = persistent;
	if (tornTail !== undefined && tornTail.length > 0 && !acc.invalid) {
		acc = {
			...persistent,
			assistantUsageById: new Map(persistent.assistantUsageById),
			attributedChildUsage: cloneUsage(persistent.attributedChildUsage),
			summarizationUsage: cloneUsage(persistent.summarizationUsage),
			pendingAttributions: [...persistent.pendingAttributions],
		};
		foldSessionScanLine(acc, tornTail);
	}
	if (acc.invalid || !acc.header) return null;
	const usageTotal = emptyUsage();
	for (const usage of acc.assistantUsageById.values()) {
		addAssistantUsage(usageTotal, usage);
	}
	addAssistantUsage(usageTotal, acc.summarizationUsage);
	subtractAssistantUsage(usageTotal, acc.attributedChildUsage);
	const header = acc.header;
	const cwd = typeof header.cwd === "string" ? header.cwd : "";
	const parentSessionPath = header.parentSession;
	const rlmDepth = resolveSessionRlmDepth(header, filePath);
	const modified = getSessionModifiedDateFromLastActivity(acc.lastActivityTime, header, stats.mtime);

	return {
		path: filePath,
		id: header.id,
		cwd,
		name: acc.name,
		state: acc.state,
		model: acc.model,
		parentSessionPath,
		rlmDepth,
		created: new Date(header.timestamp),
		modified,
		messageCount: acc.messageCount,
		firstMessage: acc.firstMessage || "(no messages)",
		allMessagesText: acc.allMessagesText,
		agentStatus: acc.agentStatus,
		usage: sessionUsageSummaryFrom(usageTotal),
	};
}

export type SessionListProgress = (loaded: number, total: number) => void;
export type SessionListItem = (session: SessionInfo) => void;

export interface SessionListCallbacks {
	onProgress?: SessionListProgress;
	onSession?: SessionListItem;
}

async function listSessionsFromDir(
	dir: string,
	callbacks?: SessionListCallbacks,
	progressOffset = 0,
	progressTotal?: number,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) {
		for (const key of sessionScanStates.keys()) {
			if (dirname(key) === dir) dropSessionScanState(key);
		}
		return sessions;
	}

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
		const total = progressTotal ?? files.length;

		const present = new Set(files);
		for (const key of sessionScanStates.keys()) {
			if (dirname(key) === dir && !present.has(key)) {
				dropSessionScanState(key);
			}
		}

		let loaded = 0;
		// The files are independent, so their reads overlap; the emit callback keeps
		// progress counts and streamed sessions in the directory order the serial
		// loop produced, which is what the catalog's progressive rows assume.
		await mapConcurrent(
			files,
			DEFAULT_MAP_CONCURRENCY_LIMIT,
			(file) => readSessionInfo(file),
			(info) => {
				loaded++;
				callbacks?.onProgress?.(progressOffset + loaded, total);
				if (info) {
					sessions.push(info);
					callbacks?.onSession?.(info);
				}
			},
		);
	} catch {
		// Return no sessions when the directory cannot be read.
	}

	return sessions;
}

export class SessionManager {
	private sessionId: string = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	private ownsSessionDir: boolean;
	private flushed: boolean = false;
	private fileEntries: FileEntry[] = [];
	/** Incrementally maintained (count, tailId) of what getEntries() returns; see getEntryStats(). */
	private entryCount = 0;
	private entryTailId: string | undefined;
	/**
	 * Flip-once cache for "this transcript contains an assistant message"
	 * (upstream #2276): `_persist`'s no-assistant guard runs on every append and
	 * must not rescan the whole entry list. `_pushIndexedEntry` flips it to true
	 * and never back; every fileEntries replacement funnels through
	 * `_buildIndex()` or `_rescanEntryStats()`, which recompute it, so the cache
	 * can never go stale on rebuild, rollback, reset, branch or reopen.
	 */
	private hasAssistantEntry = false;
	/**
	 * Cached getSessionName() answer. The name only changes when a session_info
	 * entry lands (or the transcript is rebuilt/reset), so reads - the roster
	 * flush pays one per dirty row rebuild - must not re-filter and re-scan the
	 * whole transcript. Undefined-dirty is tracked separately: a nameless
	 * transcript also resolves to a cached answer.
	 */
	private sessionNameCache: string | undefined;
	private sessionNameDirty = true;
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;
	private persistListeners = new Set<SessionPersistListener>();
	private persistFailureListeners = new Set<SessionPersistFailureListener>();
	/** LAT-3: per-target attribution deltas not yet written to the file; see PendingAttributionWrite. */
	private readonly pendingAttributionWrites = new Map<string, PendingAttributionWrite>();
	/** LAT-4: ids of deferred attribution merges that no disk line carries yet. */
	private readonly deferredAttributionIds = new Set<string>();
	/** LAT-3: last persisted agent_status, so byte-identical re-writes can be skipped. */
	private lastAgentStatusWrite: { id: string; status: AgentStatus } | undefined;

	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		preloadedEntries?: FileEntry[],
		ownsSessionDir = true,
	) {
		this.cwd = cwd;
		this.sessionDir = sessionDir;
		this.persist = persist;
		this.ownsSessionDir = ownsSessionDir;
		if (persist && sessionDir && ownsSessionDir) {
			ensurePrivateDirectory(sessionDir);
		}

		if (sessionFile) {
			this.setSessionFile(sessionFile, preloadedEntries);
		} else if (preloadedEntries) {
			this.fileEntries = preloadedEntries;
			this.sessionId = (preloadedEntries[0] as SessionHeader).id;
			this._buildIndex();
		} else {
			this.newSession();
		}
	}

	/**
	 * Switch to a different session file (used for resume and branching).
	 * preloadedEntries must be loadEntriesFromFile(sessionFile) for the same path; it
	 * lets the async daemon path skip the synchronous re-read.
	 */
	setSessionFile(sessionFile: string, preloadedEntries?: FileEntry[]): void {
		this.pendingAttributionWrites.clear();
		this.deferredAttributionIds.clear();
		this.sessionFile = resolve(sessionFile);
		if (existsSync(this.sessionFile)) {
			try {
				const firstHeader = readSessionHeader(this.sessionFile);
				if (firstHeader?.type === "session" && typeof firstHeader.id === "string") {
					assertValidSessionId(firstHeader.id);
				}
			} catch (error) {
				// A malformed first line is handled by the existing corrupt-file recovery
				// path below. Preserve errors from filesystem safety checks and invalid IDs.
				if (!(error instanceof SyntaxError)) throw error;
			}
			this.fileEntries = preloadedEntries ?? loadEntriesFromFile(this.sessionFile);

			// The loaders read a header whose terminating newline went missing, but the
			// next append would glue itself onto that line. This caller owns the write
			// side, so put the missing byte back before anything can land on it.
			if (this.persist && !endsWithNewlineSync(this.sessionFile)) {
				completeTrailingRecordNewline(this.sessionFile, this.ownsSessionDir);
			}

			// If file was empty or corrupted (no valid header), truncate and start fresh
			// to avoid appending messages without a session header (which breaks the session)
			if (this.fileEntries.length === 0) {
				// A damaged first line loses the header, not the transcript: keep the
				// entries that still parse instead of truncating them away.
				const salvaged = salvageDamagedHeadEntries(this.sessionFile, this.cwd);
				if (salvaged) {
					this.fileEntries = salvaged;
					this.sessionId = (salvaged[0] as SessionHeader).id;
					// A salvaged pre-v2 body arrives stamped version 1 and needs the
					// migration before it is indexed or written back.
					migrateToCurrentVersion(this.fileEntries);
					this._buildIndex();
					this._rewriteFile();
					this.flushed = true;
					return;
				}
				const explicitPath = this.sessionFile;
				this.newSession();
				this.sessionFile = explicitPath;
				this._rewriteFile();
				this.flushed = true;
				return;
			}

			const header = this.fileEntries.find((e) => e.type === "session") as SessionHeader | undefined;
			if (!header) {
				throw new Error(`Session file is missing a valid header: ${this.sessionFile}`);
			}
			assertValidSessionId(header.id);
			this.sessionId = header.id;

			let shouldRewrite = migrateToCurrentVersion(this.fileEntries);
			if (header?.parentSession && !isValidRlmDepth(header.rlmDepth)) {
				header.rlmDepth = resolveSessionRlmDepth(header, this.sessionFile);
				shouldRewrite = true;
			}
			if (shouldRewrite) {
				this._rewriteFile();
			}

			this._buildIndex();
			this.flushed = true;
		} else {
			const explicitPath = this.sessionFile;
			this.newSession();
			this.sessionFile = explicitPath; // preserve explicit path from --resume selector
		}
	}

	newSession(options?: NewSessionOptions): string | undefined {
		let sessionId = options?.id ?? createSessionId();
		assertValidSessionId(sessionId);
		let sessionFile: string | undefined;
		const hasExplicitRlmDepth = options !== undefined && Object.hasOwn(options, "rlmDepth");
		let parentHeader: Partial<SessionHeader> | undefined;
		if (options?.parentSession && !hasExplicitRlmDepth) {
			try {
				parentHeader = readSessionHeader(options.parentSession);
			} catch {
				// Unavailable parent metadata leaves the child depth unknown.
			}
		}
		if (this.persist) {
			if (options?.id) {
				sessionFile = getSessionFilePath(this.getSessionDir(), sessionId);
				if (existsSync(sessionFile)) {
					throw new Error(`Session file already exists for id "${sessionId}": ${sessionFile}`);
				}
			} else {
				const target = createUniqueSessionFileTarget(this.getSessionDir());
				sessionId = target.sessionId;
				sessionFile = target.sessionFile;
			}
		}

		this.sessionId = sessionId;
		const timestamp = new Date().toISOString();
		const git = this.persist ? (captureGitContext(this.cwd) ?? undefined) : undefined;
		const rlmDepth = hasExplicitRlmDepth
			? options?.rlmDepth
			: options?.parentSession
				? deriveChildRlmDepth(parentHeader)
				: rootRlmDepthFromEnv();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
			rlmDepth,
			git,
		};
		this.fileEntries = [header];
		this.hasAssistantEntry = false;
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		this.pendingAttributionWrites.clear();
		this.deferredAttributionIds.clear();
		this.lastAgentStatusWrite = undefined;
		this._rescanEntryStats();
		this.flushed = false;

		if (this.persist) {
			this.sessionFile = sessionFile;
		}
		return this.sessionFile;
	}

	private _buildIndex(): void {
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		this.lastAgentStatusWrite = undefined;
		this._rescanEntryStats();
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			this.byId.set(entry.id, entry);
			if (entry.type === "agent_status") {
				const statusEntry = entry as AgentStatusEntry;
				this.lastAgentStatusWrite = { id: statusEntry.id, status: { ...statusEntry.status } };
			}
			if (entry.type === "leaf_position") {
				// A position marker resolves to the entry it points at, not to itself,
				// and the last entry in the file still wins: transcripts written before
				// the marker existed keep resolving by their last line. An unknown
				// target (truncated or hand-edited file) falls back to that same rule
				// instead of inventing a position.
				if (entry.targetId === null || this.byId.has(entry.targetId)) {
					this.leafId = entry.targetId;
				}
			} else {
				this.leafId = entry.id;
			}
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
	}

	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		// A rewrite materializes every in-memory entry as its own line, so any
		// deferred attribution deltas are already on disk afterwards.
		this.pendingAttributionWrites.clear();
		this.deferredAttributionIds.clear();
		const content = `${this.fileEntries.map((e) => JSON.stringify(e)).join("\n")}\n`;
		writePrivateFileAtomicLines(this.sessionFile, [content], {
			preserveOwnership: true,
			privateParent: this.ownsSessionDir,
		});
		this._notifyPersistListeners();
	}

	private _notifyPersistListeners(): void {
		if (!this.sessionFile) {
			return;
		}
		for (const listener of this.persistListeners) {
			try {
				listener(this.sessionFile);
			} catch {
				// Persistence observers must not break session writes.
			}
		}
	}

	onPersist(listener: SessionPersistListener): () => void {
		this.persistListeners.add(listener);
		return () => {
			this.persistListeners.delete(listener);
		};
	}

	/** Observe failed writes. The failed entry stays in memory and the next
	 * successful persist backfills it via a full rewrite. */
	onPersistFailure(listener: SessionPersistFailureListener): () => void {
		this.persistFailureListeners.add(listener);
		return () => {
			this.persistFailureListeners.delete(listener);
		};
	}

	private _notifyPersistFailureListeners(error: unknown): void {
		for (const listener of this.persistFailureListeners) {
			try {
				listener(error);
			} catch {
				// Persistence observers must not break session writes.
			}
		}
	}

	allowsPersistence(): boolean {
		return this.persist;
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	materializeSessionFile(sessionDir?: string): string {
		if (this.sessionFile) return this.sessionFile;
		const target = this.writeCheckpointFile(sessionDir);
		this.sessionDir = dirname(target);
		this.sessionFile = target;
		this.ownsSessionDir = true;
		this.persist = true;
		this.flushed = true;
		this._notifyPersistListeners();
		return target;
	}

	writeCheckpointFile(sessionDir?: string): string {
		if (this.sessionFile) return this.sessionFile;
		const dir = sessionDir ?? (this.sessionDir || getDefaultSessionDir(this.cwd));
		ensurePrivateDirectory(dir);
		const target = createUniqueSessionFileTarget(dir);
		const header = this.getHeader();
		const checkpointHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp: new Date().toISOString(),
			cwd: this.cwd,
			parentSession: header?.parentSession,
			rlmDepth: resolveSessionRlmDepth(header ?? {}, target.sessionFile),
			git: captureGitContext(this.cwd) ?? undefined,
		};
		const checkpointEntries = [checkpointHeader, ...this.getEntries()];
		function* serializedEntries(): Iterable<string> {
			for (const entry of checkpointEntries) yield `${JSON.stringify(entry)}\n`;
		}
		writePrivateFileAtomicLines(target.sessionFile, serializedEntries());
		return target.sessionFile;
	}

	/**
	 * This session's artifact directory. Read paths get the path whether or not it
	 * exists and never create it: the old default (`create: true`) meant any read
	 * resurrected a deleted session's directory, which in turn kept that session's
	 * cron registration alive forever (round-08 S1). Writers that own this session
	 * call {@link ensureSessionArtifactDir}.
	 */
	getSessionArtifactDir(options: { create?: boolean } = {}): string | undefined {
		if (!this.persist) return undefined;
		if (options.create !== true) {
			return getSessionArtifactPath(this.sessionDir, this.sessionId, false);
		}
		if (this.sessionArtifactCreationSuppressed()) {
			return getSessionArtifactPath(this.sessionDir, this.sessionId, false);
		}
		return getSessionArtifactPath(this.sessionDir, this.sessionId, true);
	}

	/**
	 * Write-side twin of {@link getSessionArtifactDir}: create the directory and
	 * retire the tombstone. A session that is running owns its id again, and the
	 * tombstone exists only to stop *reads* from recreating a deleted session's
	 * directory - it must never make a live session's writes fail (red test R-6).
	 */
	ensureSessionArtifactDir(): string | undefined {
		if (!this.persist) return undefined;
		const artifactRoot = getSessionArtifactsRoot(this.sessionDir);
		const artifactDir = getSessionArtifactPath(this.sessionDir, this.sessionId, true);
		clearSessionArtifactTombstone(artifactRoot, this.sessionId);
		return artifactDir;
	}

	/**
	 * True while a tombstone for this id still describes the directory on disk:
	 * the session was deleted and nothing has been written into the directory
	 * since. A new session that reuses the id writes after `deletedAt`, so the
	 * window closes by itself.
	 */
	private sessionArtifactCreationSuppressed(): boolean {
		const artifactRoot = getSessionArtifactsRoot(this.sessionDir);
		const tombstone = readSessionArtifactTombstone(artifactRoot, this.sessionId);
		if (!tombstone) return false;
		const readPath = getSessionArtifactPath(this.sessionDir, this.sessionId, false);
		return tombstoneInForce(tombstone, artifactDirectoryWriteMs(readPath));
	}

	/**
	 * Force-write all in-memory entries to the session file immediately.
	 * This bypasses the no-assistant guard in {@link _persist} so that
	 * pre-model entries (session header, goal state, settings changes)
	 * are durable on disk before the first assistant response.
	 * No-op for in-memory (non-persisted) sessions.
	 */
	flushNow(): void {
		if (!this.persist || !this.sessionFile) return;
		if (this.flushed && existsSync(this.sessionFile)) return;
		this._rewriteFile();
		this.flushed = true;
	}

	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.sessionFile) return;

		// Flip-once cache: the scan this replaced walked every entry on every
		// append (O(n) per append on the suppressed pre-assistant path).
		const hasAssistant = this.hasAssistantEntry;
		// Position markers join session_state/session_info: they are written by the
		// app rather than by a model turn and must be durable even in a session that
		// has no assistant message yet, otherwise a rewind before the first answer
		// is exactly the position that a restart loses.
		const shouldPersistWithoutAssistant =
			entry.type === "session_state" || entry.type === "session_info" || entry.type === "leaf_position";
		if (!hasAssistant && !shouldPersistWithoutAssistant) {
			this.flushed = false;
			return;
		}

		// The existsSync check is what lets the next append recover from the session
		// file being deleted underneath a live session: without it appendFileSync
		// would recreate a headerless stub (pinned by session-state.test.ts's
		// "rewrites the full session if the session file disappears after flushing").
		if (!this.flushed || !existsSync(this.sessionFile)) {
			try {
				this._rewriteFile();
			} catch (error) {
				this.flushed = false;
				this._notifyPersistFailureListeners(error);
				throw error;
			}
			this.flushed = true;
		} else {
			try {
				// K3P-45: never append onto an unterminated tail. The check now rides
				// the append descriptor (O_RDWR|O_APPEND + fstat + one pread of the
				// last byte, perfB③), which removes a stat/open/read/close pass per
				// append and closes the window between the check and the write. An
				// oversized trailing record is still left in place (K3P-4), so the
				// refusal path below is unchanged: re-repair once (a tail torn by a
				// crash since open is still fixable), then refuse loudly.
				try {
					appendPrivateFile(this.sessionFile, `${JSON.stringify(entry)}\n`, {
						privateParent: this.ownsSessionDir,
						requireTerminatedTail: true,
					});
				} catch (error) {
					if (!(error instanceof UnterminatedTailError)) throw error;
					const repair = repairOwnedSessionFile(this.sessionFile);
					if (repair !== "repaired" || !endsWithNewlineSync(this.sessionFile)) {
						throw new SessionTailUnverifiableError(this.sessionFile);
					}
					appendPrivateFile(this.sessionFile, `${JSON.stringify(entry)}\n`, {
						privateParent: this.ownsSessionDir,
						requireTerminatedTail: true,
					});
				}
			} catch (error) {
				if (error instanceof SessionTailUnverifiableError) {
					// Deliberately NOT clearing `flushed`: the self-heal path below
					// rewrites the transcript from memory, and a rewrite would drop the
					// unverifiable record the repair just chose to preserve (K3P-4).
					// The append is refused loudly every time until the tail is fixed.
					this._notifyPersistFailureListeners(error);
					throw error;
				}
				// The entry stays in fileEntries: drop the flushed mark so the next
				// persist rewrites the whole transcript and backfills the gap instead
				// of appending past a lost line.
				this.flushed = false;
				this._notifyPersistFailureListeners(error);
				throw error;
			}
			this._notifyPersistListeners();
		}
	}

	private _appendEntry(entry: SessionEntry): void {
		// LAT-4: an entry appended while attribution merges are deferred would
		// reference an in-memory merge id that no disk line carries (its parent
		// is the current leaf); cut the coalescing window first so the parent
		// resolves after a reload.
		this.flushChildUsageAttributions();
		this._pushIndexedEntry(entry);
		this.leafId = entry.id;
		this._persist(entry);
	}

	/**
	 * Push one entry and advance the incremental (count, tailId) stats with it, so
	 * {@link getEntryStats} stays O(1) on the append-heavy write path.
	 */
	private _pushIndexedEntry(entry: SessionEntry): void {
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.entryCount += 1;
		this.entryTailId = entry.id;
		if (!this.hasAssistantEntry && isAssistantMessageEntry(entry)) {
			this.hasAssistantEntry = true;
		}
		if (entry.type === "session_info") this.sessionNameDirty = true;
	}

	/** Recompute the incremental entry stats from fileEntries (rebuild, rollback, reset). */
	private _rescanEntryStats(): void {
		let count = 0;
		let tailId: string | undefined;
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			count += 1;
			tailId = entry.id;
		}
		this.entryCount = count;
		this.entryTailId = tailId;
		// The guard cache is only written here and in _pushIndexedEntry, and
		// every fileEntries replacement funnels through _buildIndex() or this
		// method, so one recompute keeps it exact for all of them at once.
		this.hasAssistantEntry = this.fileEntries.some(isAssistantMessageEntry);
		// A rebuilt, rolled-back or reset transcript may have gained, moved or lost
		// its last session_info entry; the next read rescans instead of trusting the
		// cache. Every fileEntries replacement funnels through _buildIndex() or here.
		this.sessionNameDirty = true;
	}

	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendServiceTierChange(serviceTier: ServiceTier): string {
		const entry: ServiceTierChangeEntry = {
			type: "service_tier_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			serviceTier,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendModelChange(provider: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		customInstructions?: string,
		options?: {
			leafId?: string;
			usage?: Usage;
			/** Harness digest snapshot for the new compaction head (never summarizer input). */
			harnessDigest?: string;
			/** Fingerprint of the harness state behind `harnessDigest`. */
			harnessStateFingerprint?: string;
			onCommit?: (info: CompactionCommitInfo) => void;
		},
	): string {
		const pinnedLeafId = options?.leafId ?? null;
		const targetLeaf = pinnedLeafId ?? this.leafId;
		// Everything the classification reads is sampled here, in the same synchronous
		// block as the commit. The leaf captured at pin time is the one fact that must
		// not drive the decision on its own: reading "the leaf moved" as "the session
		// navigated away" is exactly issue #19.
		const leafAtCommit = this.leafId;
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id: generateId(this.byId),
			parentId: targetLeaf,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
			customInstructions,
			usage: options?.usage,
			harnessDigest: options?.harnessDigest,
			harnessStateFingerprint: options?.harnessStateFingerprint,
		};

		// The cut point can name a deferred attribution merge, and those ids never reach
		// disk: after a reopen, buildSessionContext() would never match firstKeptEntryId
		// and the whole kept tail would silently vanish. Walk back to the nearest
		// persisted ancestor - backwards only ever keeps more, so it is the safe
		// direction. Both branches need this: a summary parked on a side branch is still
		// readable later through branch().
		this.flushChildUsageAttributions();
		let firstKeptRewritten = false;
		let firstKeptUnresolvable = false;
		if (this.deferredAttributionIds.has(entry.firstKeptEntryId)) {
			const persisted = this._nearestPersistedAncestor(entry.firstKeptEntryId);
			if (persisted === null) {
				// A corrupt chain leaves nowhere to walk back to. Keep the id rather than
				// throw, and report it, so a lost kept tail stays attributable.
				firstKeptUnresolvable = true;
			} else {
				entry.firstKeptEntryId = persisted;
				firstKeptRewritten = true;
			}
		}

		// "The pinned leaf is not the current leaf" has two very different meanings: the
		// session navigated to another branch, or it merely appended forward while the
		// summary was being generated. Only the first may park the summary off the live
		// chain; the second still describes the live history (issue #19).
		const sameBranch =
			targetLeaf === null ||
			targetLeaf === leafAtCommit ||
			(leafAtCommit !== null && this._isOnCurrentBranch(targetLeaf));

		let classification: CompactionCommitInfo["classification"];
		if (sameBranch) {
			// _appendEntry() uses entry.parentId as-is, so it must be retargeted: left
			// pointing at the pinned leaf it would fork the chain there and orphan every
			// entry appended during the window.
			entry.parentId = leafAtCommit;
			this._appendEntry(entry);
			classification =
				pinnedLeafId === null
					? "no_pin_supplied"
					: leafAtCommit === targetLeaf
						? "same_branch_no_window_append"
						: "same_branch_forward";
		} else {
			// A pinned leaf the session really left: the entry belongs to the branch it
			// summarized, and it must not drag the current position back to it.
			this._appendEntryKeepingLeaf(entry);
			// Sampled at commit time on purpose: at pin time the id was necessarily known,
			// and only something like newSession() during the window can remove it.
			classification =
				targetLeaf !== null && this.byId.get(targetLeaf) === undefined
					? "unknown_target_leaf"
					: "branch_navigation";
		}

		// The observer runs after the entry is durable and the leaf has moved, so a
		// throwing callback must not turn a successful commit into a reported failure:
		// the caller's catch block would mark the compaction failed while the transcript
		// already carries it. There is no logger in this class, hence the swallow - the
		// contract is that onCommit does not throw (see CompactionCommitInfo).
		try {
			options?.onCommit?.({
				classification,
				pinnedLeafId,
				currentLeafId: this.leafId,
				...this._compactionWindowFacts(targetLeaf, entry.id),
				firstKeptRewritten,
				firstKeptUnresolvable,
			});
		} catch {
			// Deliberately ignored; see above.
		}
		return entry.id;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendCustomEntryWithRollback(customType: string, data?: unknown): string {
		return this._appendEntryWithRollback(() => this.appendCustomEntry(customType, data));
	}

	appendChildUsageAttribution(
		targetId: string,
		childUsage: Usage,
		aggregateUsage: Usage,
		origin?: ChildUsageAttributionEntry["origin"],
	): string {
		const target = this.byId.get(targetId);
		if (!target || !isAssistantMessageEntry(target)) {
			throw new Error(`Assistant message entry ${targetId} not found`);
		}

		target.message.usage = cloneUsage(aggregateUsage);
		const entry: ChildUsageAttributionEntry = {
			type: "child_usage_attributed",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			childUsage: cloneUsage(childUsage),
			aggregateUsage: cloneUsage(aggregateUsage),
			...(origin ? { origin } : {}),
		};
		this._pushIndexedEntry(entry);
		this.leafId = entry.id;
		// LAT-3: the first attribution lands on disk exactly as before, so a
		// single-shot child run (and every reader of a short transcript) sees
		// unchanged behavior. Later merges for the same target only join the
		// in-memory ledger; their deltas are summed into one file line at the
		// next flush instead of one line per streamed child message.
		const pending = this.pendingAttributionWrites.get(targetId);
		if (!pending) {
			// LAT-4: this entry is persisted immediately, so its parent (the leaf
			// at append time) must already exist on disk - flush the deferred
			// merges the leaf may point at, e.g. another child's streamed usage.
			this.flushChildUsageAttributions();
			this._persist(entry);
			this.pendingAttributionWrites.set(targetId, {
				anchorId: entry.id,
				childUsage: emptyUsage(),
				aggregateUsage: cloneUsage(aggregateUsage),
				origin,
				lastId: entry.id,
				lastTimestamp: entry.timestamp,
				merges: 0,
				startedAt: Date.now(),
			});
			return entry.id;
		}
		this.deferredAttributionIds.add(entry.id);
		addAssistantUsage(pending.childUsage, entry.childUsage);
		pending.aggregateUsage = cloneUsage(aggregateUsage);
		if (origin) pending.origin = origin;
		pending.lastId = entry.id;
		pending.lastTimestamp = entry.timestamp;
		pending.merges += 1;
		if (
			pending.merges >= CHILD_USAGE_ATTRIBUTION_COALESCE_MAX_MERGES ||
			Date.now() - pending.startedAt >= CHILD_USAGE_ATTRIBUTION_COALESCE_MAX_AGE_MS
		) {
			this._flushPendingAttributionWrite(targetId);
		}
		return entry.id;
	}

	/**
	 * Write one coalesced line for a target's deferred attribution deltas. The
	 * line reuses the last merge's id and the first unwritten merge's parentId,
	 * so the reloaded chain splices past the merges whose lines were skipped;
	 * childUsage carries exactly the deferred delta sum, so every delta-based
	 * fold (readSessionInfo scan, OwnUsageAccumulator, whole-file refold) totals
	 * the same as one line per merge.
	 */
	/**
	 * Whether `id` sits on the current leaf's parent chain - i.e. the session only
	 * appended forward since `id` was written, rather than navigating to another branch.
	 * Walks parent pointers with an early exit and a cycle guard; the shape follows
	 * _nearestPersistedAncestor so the file does not grow a third, subtly different
	 * upward walk.
	 */
	private _isOnCurrentBranch(id: string): boolean {
		let cursor: SessionEntry | undefined = this.leafId === null ? undefined : this.byId.get(this.leafId);
		const seen = new Set<string>();
		while (cursor) {
			if (cursor.id === id) return true;
			if (seen.has(cursor.id)) return false;
			seen.add(cursor.id);
			const parentId = cursor.parentId;
			cursor = parentId === null || parentId === undefined ? undefined : this.byId.get(parentId);
		}
		return false;
	}

	/**
	 * Entries written between the pinned leaf and the compaction entry, on the branch the
	 * summary now sits on. Read from `getBranch(compactionId)` and sliced - never by
	 * diffing `getBranch(pinned)` before and after the commit: that is the pinned leaf's
	 * ANCESTOR chain, which window appends (its descendants) never change, so such a diff
	 * is always empty and the field would forever report "nothing was appended".
	 */
	private _compactionWindowFacts(
		targetLeaf: string | null,
		compactionId: string,
	): Pick<CompactionCommitInfo, "windowEntriesOnSummarizedBranch" | "windowEntryTypesOnSummarizedBranch"> {
		const chain = this.getBranch(compactionId);
		const pinnedIndex = targetLeaf === null ? -1 : chain.findIndex((entry) => entry.id === targetLeaf);
		// No pinned leaf, or one that is not on this chain (an unknown/corrupt id): there
		// is no window to speak of, and guessing one would be worse than reporting none.
		if (pinnedIndex < 0) {
			return { windowEntriesOnSummarizedBranch: 0, windowEntryTypesOnSummarizedBranch: [] };
		}
		const window = chain.slice(pinnedIndex + 1, chain.length - 1);
		return {
			windowEntriesOnSummarizedBranch: window.length,
			windowEntryTypesOnSummarizedBranch: window.map((entry) => entry.type),
		};
	}

	/**
	 * LAT-4: walk the live parent chain from `id` up to the nearest ancestor
	 * whose id a disk line carries (every id not in deferredAttributionIds is a
	 * persisted entry or an earlier flush row). Returns null when the chain
	 * reaches the root or a missing id before finding one.
	 */
	private _nearestPersistedAncestor(id: string): string | null {
		let current: SessionEntry | undefined = this.byId.get(id);
		const seen = new Set<string>([id]);
		while (current && current.parentId !== null && current.parentId !== undefined) {
			const parentId = current.parentId;
			if (seen.has(parentId)) return null;
			seen.add(parentId);
			if (!this.deferredAttributionIds.has(parentId)) return parentId;
			current = this.byId.get(parentId);
		}
		return null;
	}

	private _flushPendingAttributionWrite(targetId: string): void {
		const pending = this.pendingAttributionWrites.get(targetId);
		if (!pending || pending.merges === 0) return;
		// LAT-4: the row's parent must resolve on reload. Splice at the nearest
		// on-disk ancestor of the last merge so the reloaded chain keeps every
		// entry the live chain keeps; only deferred merge ids (all of the row's
		// own type) are spliced past, so the reload folds identical totals.
		const parentId = this._nearestPersistedAncestor(pending.lastId) ?? pending.anchorId;
		const entry: ChildUsageAttributionEntry = {
			type: "child_usage_attributed",
			id: pending.lastId,
			parentId,
			timestamp: pending.lastTimestamp,
			targetId,
			childUsage: pending.childUsage,
			aggregateUsage: pending.aggregateUsage,
			...(pending.origin ? { origin: pending.origin } : {}),
		};
		this._persist(entry);
		this.deferredAttributionIds.delete(pending.lastId);
		// Re-seed instead of dropping the pending state: the next merge for this
		// target stays deferred, so each window costs one line rather than one
		// line plus a new immediate line. The anchor is the row just written, so
		// the next fallback parent also exists on disk.
		pending.anchorId = entry.id;
		pending.childUsage = emptyUsage();
		pending.merges = 0;
		pending.startedAt = Date.now();
	}

	/**
	 * Persist every deferred attribution delta now. Called at child-run settle
	 * and other close boundaries so the file ledger matches what a reload folds
	 * instead of holding deltas back for the next window flush.
	 */
	flushChildUsageAttributions(): void {
		for (const targetId of [...this.pendingAttributionWrites.keys()]) {
			this._flushPendingAttributionWrite(targetId);
		}
	}

	appendSessionInfo(name: string): string {
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: name.trim(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendSessionState(state: SessionState): string {
		const entry: SessionStateEntry = {
			type: "session_state",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			state: { status: state.status },
		};
		this._appendEntry(entry);
		return entry.id;
	}

	getSessionName(): string | undefined {
		if (this.sessionNameDirty) {
			this.sessionNameCache = this._scanSessionName();
			this.sessionNameDirty = false;
		}
		return this.sessionNameCache;
	}

	/**
	 * The value getSessionName() caches: the last session_info entry wins. Walks
	 * fileEntries directly (skipping the header) so the one scan a write pays does
	 * not also allocate the getEntries() copy.
	 */
	private _scanSessionName(): string | undefined {
		for (let i = this.fileEntries.length - 1; i >= 0; i--) {
			const entry = this.fileEntries[i];
			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}
		return undefined;
	}

	getSessionState(): SessionState | undefined {
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "session_state") {
				const status = normalizeSessionStateStatus(entry.state.status);
				if (status) {
					return { status };
				}
			}
		}
		return undefined;
	}

	/**
	 * True when the session holds user-meaningful persisted content, as opposed to
	 * only daemon-written bookkeeping (session_state, agent_status, git_state) or
	 * the default model/thinking entries every new session is created with. Used by
	 * the daemon discard guard to decide whether a message-less draft is safe to
	 * delete (that guard always also requires zero messages).
	 *
	 * createAgentSession opens a new session with an optional leading `model_change`
	 * followed by `thinking_level_change` and `service_tier_change`. That creation
	 * prefix is skipped; anything beyond it is user content.
	 */
	hasUserContent(): boolean {
		const contentEntries = this.getEntries().filter((entry) => CONTENT_ENTRY_TYPES.has(entry.type));
		let start = 0;
		if (contentEntries[start]?.type === "model_change") {
			start++;
		}
		if (contentEntries[start]?.type === "thinking_level_change") {
			start++;
		}
		if (contentEntries[start]?.type === "service_tier_change") {
			start++;
		}
		return contentEntries.length > start;
	}

	appendAgentStatus(status: AgentStatus): string {
		// LAT-3: the summarizer persists on every idle settle, even when the
		// verdict is byte-identical to the last one (16,158 of 17,081 lines on
		// the real 101,481-line transcript). Every reader folds newest-wins, so
		// an identical consecutive write carries no information: skip it.
		const last = this.lastAgentStatusWrite;
		if (
			last &&
			last.status.summary === status.summary &&
			last.status.taskState === status.taskState &&
			last.status.basedOnMessageCount === status.basedOnMessageCount
		) {
			return last.id;
		}
		const entry: AgentStatusEntry = {
			type: "agent_status",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			status: {
				summary: status.summary,
				taskState: status.taskState,
				basedOnMessageCount: status.basedOnMessageCount,
			},
		};
		this._appendEntry(entry);
		this.lastAgentStatusWrite = { id: entry.id, status: { ...entry.status } };
		return entry.id;
	}

	appendGitState(git: GitContext): string {
		const entry: GitStateEntry = {
			type: "git_state",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			git,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	recordGitStateIfChanged(): string | undefined {
		if (!this.persist) return undefined;
		const git = captureGitContext(this.cwd);
		if (!git) return undefined;
		const last = this.getActiveGitContext();
		if (last && gitContextsEqual(last, git)) return undefined;
		return this.appendGitState(git);
	}

	private getActiveGitContext(): GitContext | undefined {
		let current = this.leafId ? this.byId.get(this.leafId) : undefined;
		while (current) {
			if (current.type === "git_state") return current.git;
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		const header = this.fileEntries[0];
		return header?.type === "session" ? header.git : undefined;
	}

	getLatestAgentStatus(): AgentStatus | undefined {
		// Walk the current leaf to root so we only read status on the active branch,
		// not a sibling branch's status that happens to sit later in the file.
		let current = this.leafId ? this.byId.get(this.leafId) : undefined;
		while (current) {
			if (current.type === "agent_status") {
				return { ...current.status };
			}
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		return undefined;
	}

	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * Append a custom message, undoing the append if persistence fails so a
	 * best-effort record never leaves an unsaved leaf for later entries.
	 */
	appendCustomMessageEntryWithRollback<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): string {
		return this._appendEntryWithRollback(() => this.appendCustomMessageEntry(customType, content, display, details));
	}

	private _appendEntryWithRollback(append: () => string): string {
		const previousLeafId = this.leafId;
		try {
			const entryId = append();
			this.flushNow();
			return entryId;
		} catch (error) {
			// The append indexes the entry before persisting it; undo exactly that.
			if (this.leafId !== null && this.leafId !== previousLeafId) {
				this.byId.delete(this.leafId);
				this.fileEntries.pop();
				this._rescanEntryStats();
				this.leafId = previousLeafId;
				// The failed append may have left a torn line on disk. Restore the file
				// from the rolled-back entries now; if that also fails (e.g. the disk is
				// still full), fall back to forcing the next persist to rewrite.
				this.flushed = false;
				try {
					this.flushNow();
				} catch {
					this.flushed = false;
				}
			}
			throw error;
		}
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this._appendEntry(entry);
		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}
		return entry.id;
	}

	getBranch(fromId?: string): SessionEntry[] {
		// push+reverse, not unshift-per-entry: unshift is O(n), which makes this O(n^2) on long sessions.
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.leafId;
		let current = startId ? this.byId.get(startId) : undefined;
		while (current) {
			path.push(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		path.reverse();
		return path;
	}

	buildSessionContext(): SessionContext {
		// Pass fileEntries directly rather than getEntries(): the resolved context
		// is computed from the leaf-to-root walk over byId (which already excludes
		// the header), so the entries argument is only a fallback for an undefined
		// leaf — never hit here since leafId is always set or null. Avoids an O(n)
		// array copy on every call (attach, get_session_context, agent init, ...).
		return buildSessionContext(this.fileEntries as SessionEntry[], this.leafId, this.byId);
	}

	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	getEntries(): SessionEntry[] {
		return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
	}

	/**
	 * O(1) count and tail id of the entries getEntries() would return. The roster
	 * usage memo compares these on every republication; going through
	 * getEntries() there cost an O(transcript) array copy per memo HIT, which
	 * made the "cheap" check the same order as the fold it avoids.
	 */
	getEntryStats(): { count: number; tailId: string | undefined } {
		return { count: this.entryCount, tailId: this.entryTailId };
	}

	getFlatTree(): SessionTreeFlatNode[] {
		return this.getEntries().map((entry) => ({
			entry,
			label: this.labelsById.get(entry.id),
			labelTimestamp: this.labelTimestampsById.get(entry.id),
		}));
	}

	/**
	 * The whole tree, unbounded in depth: the caller asked for it, so nothing is left out.
	 * Do not hand the result to a serializer or a structured clone without a bound - use
	 * {@link getBoundedTree}, whose stats say what was dropped.
	 */
	getTree(): SessionTreeNode[] {
		return this.buildTree(this.getFlatTree(), Number.POSITIVE_INFINITY).tree;
	}

	/**
	 * The tree cut to the newest `maxDepth` parent edges, plus what the cut dropped.
	 *
	 * The bound exists because a tree's depth is a property of the transcript, not of the
	 * view: one long session is one chain of 100k nodes, and a serializer that recurses per
	 * level dies on it. Cutting instead of serializing deeper keeps the frame's size and its
	 * recursion depth bounded, and the stats make the omission reportable rather than silent.
	 * The cut keeps the deepest layers and the live leaf's ancestor chain, i.e. the same side
	 * of the session {@link getBoundedFlatTree} keeps, so a client reading either view sees
	 * the recent past - including, after a rewind-and-fork, the branch the session actually
	 * resumes on.
	 *
	 * A second, total-node cap (`maxNodes`) bounds the width the depth bound cannot see:
	 * a shallow wide tree fits any depth window but is still O(entries) nodes. The cap is
	 * hard: the live leaf's retained ancestor chain is kept first and the newest entries
	 * fill the rest of the budget, so any tree shape - deep, wide, or both - comes back
	 * with at most `maxNodes` nodes and reports the cut (including the cap, in
	 * `stats.maxNodes`).
	 */
	getBoundedTree(
		maxDepth: number = SESSION_TREE_MAX_WIRE_DEPTH,
		maxNodes: number = SESSION_TREE_MAX_WIRE_NODES,
	): {
		tree: SessionTreeNode[];
		stats: SessionTreeDepthStats;
	} {
		return this.buildTree(this.getFlatTree(), maxDepth, maxNodes);
	}

	/**
	 * The flat tree for the wire, capped at `maxNodes` nodes.
	 *
	 * Entries are shipped whole, so an uncapped response is O(entries) bytes per call. The
	 * live leaf's entry and ancestor chain are kept first and the newest entries fill the
	 * rest of the budget: after a rewind the leaf is an early entry while the file's last
	 * line is the leaf_position marker `branch()` appends, so a pure tail cut would drop
	 * the entry the session resumes on while `leafId` still points at it. The branch the
	 * session would resume on stays navigable, older branches are reported as omitted
	 * instead of silently disappearing, and the returned count never exceeds the cap.
	 */
	getBoundedFlatTree(maxNodes: number = SESSION_TREE_FLAT_MAX_NODES): {
		nodes: SessionTreeFlatNode[];
		stats: SessionFlatTreeStats;
	} {
		const entries = this.getFlatTree();
		const floored = Math.floor(maxNodes);
		const limit = Number.isFinite(floored) ? Math.max(1, floored) : Number.POSITIVE_INFINITY;
		if (entries.length <= limit) {
			return {
				nodes: entries,
				stats: {
					totalEntries: entries.length,
					returnedNodes: entries.length,
					omittedNodes: 0,
					maxNodes: limit,
					truncated: false,
				},
			};
		}
		const entryById = new Map<string, SessionEntry>();
		for (const flatNode of entries) {
			entryById.set(flatNode.entry.id, flatNode.entry);
		}
		// The live chain outranks the newest tail, leaf first, up to the cap; the window
		// then shrinks by exactly what it cost, so the hard bound holds.
		const keep = new Set<string>();
		for (const id of this.livePathOrder(entryById)) {
			if (keep.size >= limit) {
				break;
			}
			keep.add(id);
		}
		const windowFromIndex = entries.length - (limit - keep.size);
		const nodes = entries.filter((flatNode, index) => keep.has(flatNode.entry.id) || index >= windowFromIndex);
		return {
			nodes,
			stats: {
				totalEntries: entries.length,
				returnedNodes: nodes.length,
				omittedNodes: entries.length - nodes.length,
				maxNodes: limit,
				truncated: true,
			},
		};
	}

	/**
	 * The live leaf's ancestor chain, leaf first, with the same cycle guard the depth
	 * walk uses, so a cycle reads as a chain that stops.
	 */
	private livePathOrder(entryById: Map<string, SessionEntry>): string[] {
		const leafId = this.getLeafId();
		if (leafId === null) {
			return [];
		}
		const path: string[] = [];
		const seen = new Set<string>();
		let current: SessionEntry | undefined = entryById.get(leafId);
		while (current && !seen.has(current.id)) {
			seen.add(current.id);
			path.push(current.id);
			const parentId = current.parentId;
			current = parentId === null || parentId === current.id ? undefined : entryById.get(parentId);
		}
		return path;
	}

	/**
	 * Build the tree iteratively, from per-entry depths up.
	 *
	 * Two walks are explicit here on purpose: the depth of an entry is its parent chain's
	 * length, and both the chain walk and the child aggregation would recurse as deep as the
	 * transcript is long. A bounded build keeps the newest `depthLimit` layers - windows
	 * anchored at the deepest entry *and* at the live leaf's own depth, so what it drops is
	 * the oldest ancestors of either chain - and always keeps the live leaf with its
	 * retained ancestor chain, detached only if it somehow falls outside its own window. A
	 * tree that fits under the limit is returned whole and unchanged.
	 */
	private buildTree(
		entries: readonly SessionTreeFlatNode[],
		depthLimit: number,
		nodeLimit: number = Number.POSITIVE_INFINITY,
	): { tree: SessionTreeNode[]; stats: SessionTreeDepthStats } {
		const nodeMap = new Map<string, SessionTreeNode>();
		for (const flatNode of entries) {
			nodeMap.set(flatNode.entry.id, { ...flatNode, children: [] });
		}

		const entryById = new Map<string, SessionEntry>();
		for (const flatNode of entries) {
			entryById.set(flatNode.entry.id, flatNode.entry);
		}

		const depths = new Map<string, number>();
		const onPath = new Set<string>();
		for (const flatNode of entries) {
			if (depths.has(flatNode.entry.id)) {
				continue;
			}
			const chain: SessionEntry[] = [];
			let current: SessionEntry | undefined = flatNode.entry;
			while (current && !depths.has(current.id) && !onPath.has(current.id)) {
				onPath.add(current.id);
				chain.push(current);
				const parentId = current.parentId;
				if (parentId === null || parentId === current.id) {
					current = undefined;
					break;
				}
				current = entryById.get(parentId);
			}
			// The walk stopped on either a root/orphan (depth 0) or an already-measured
			// ancestor; a cycle stops it too, and the cycle members all read as roots. That
			// matches the aggregation below, where an entry whose parent is unknown is a root.
			const known = current ? depths.get(current.id) : undefined;
			let depth = known === undefined ? 0 : known + 1;
			for (let index = chain.length - 1; index >= 0; index--) {
				depths.set(chain[index].id, depth);
				depth += 1;
			}
			for (const entry of chain) {
				onPath.delete(entry.id);
			}
		}

		// The depth window has two anchors, and both cut the same side: the *old* top of
		// the session. The deep window is anchored at the deepest entry - a bound has to
		// cut something, and which side it cuts is the whole difference between a view of
		// the session you are in and a view of the session you started: cutting the old
		// top layers keeps the newest layers, the same side the flat bound keeps (newest
		// entries), so one session never presents two opposite truncations. The live
		// window is anchored at the live leaf's own depth: after a rewind-and-fork the
		// leaf sits on a branch shallower than an abandoned deep branch, and a window
		// anchored only at the global deepest entry would keep the dead branch's bottom
		// while cutting the *live* branch's ancestor chain, leaving the leaf a detached
		// root the branch selector cannot navigate up from. A node is retained when
		// either window wants it, and the leaf always falls inside its own window, so
		// the entry the session resumes on keeps its ancestors. The serializer bound
		// holds for the union, not per window: when the leaf is within `depthLimit+1`
		// of the global deepest entry the live window's cut rises to the deep window's
		// (see depthRetained), so every retained parent chain is at most `depthLimit`
		// edges deep in any shape; the pre-fix union stacked the two windows into
		// chains up to `2 * depthLimit + 1` edges deep.
		let maxDepth = 0;
		for (const depth of depths.values()) {
			if (depth > maxDepth) {
				maxDepth = depth;
			}
		}
		const leafId = this.getLeafId();
		const deepWindowFrom = Number.isFinite(depthLimit) ? Math.max(0, maxDepth - depthLimit) : 0;
		const leafDepth = leafId === null ? undefined : depths.get(leafId);
		const liveWindowFrom =
			Number.isFinite(depthLimit) && leafDepth !== undefined ? Math.max(0, leafDepth - depthLimit) : 0;

		// The live path: the leaf plus its ancestor chain, leaf first, with the same cycle
		// guard the depth walk uses, so a cycle reads as a chain that stops.
		const livePathOrder = this.livePathOrder(entryById);
		const livePath = new Set<string>(livePathOrder);
		// The width bound: a tree that fits the depth windows can still be O(entries) nodes
		// (a star: one shallow root with every entry as a child). The cap is hard: the live
		// leaf's retained ancestor chain is kept first, leaf first, and the remaining budget
		// fills with the newest entries by file order - the same side the depth windows and
		// the flat bound keep. The live chain is kept *inside* the budget rather than exempt
		// from it: the exemption let the bound return more nodes than the cap declared
		// (20_001 on a star, more after a rewind), so `returnedNodes` could exceed the cap
		// while the stats said it could not. A retained node whose parent falls outside the
		// kept set comes back as a root, exactly like a depth-cut node.
		const nodeCapLimit = Math.max(1, Math.floor(nodeLimit));
		const nodeCapActive = Number.isFinite(nodeLimit) && entries.length > nodeCapLimit;
		// K3X-4: the live window rises to the deep window's cut when the leaf sits
		// within depthLimit+1 of the global deepest entry. The two windows cut the
		// same side, but their union could stack: the live window keeps the leaf's
		// ancestor chain and the deep window keeps the deepest layers, and when the
		// leaf is that deep the two retained segments are contiguous on one parent
		// chain (or the live chain feeds the deep one through a shared trunk), so the
		// returned tree was up to maxDepth - liveWindowFrom = 2*depthLimit+1 edges
		// deep (measured 1149 on a depthLimit-1000 bound) while `depthLimit` rides
		// the wire as the tree's bound and the serializer budget. Rising to the deep
		// cut in that regime keeps every retained run at most depthLimit edges; the
		// leaf itself stays inside the deep window, and only when the leaf sits
		// exactly one below the cut does it come back detached through the safety
		// net below. When the leaf is further above the deepest entry (the GL-1
		// rewind-and-fork shape), the gap between the two windows is unretained, the
		// runs stay separate, and the live window keeps its own cut.
		const liveWindowCutsToDeep =
			leafDepth !== undefined && Number.isFinite(depthLimit) && deepWindowFrom <= leafDepth + 1;
		const effectiveLiveWindowFrom = liveWindowCutsToDeep ? deepWindowFrom : liveWindowFrom;
		const depthRetained = (entry: SessionEntry, depth: number): boolean => {
			if (!Number.isFinite(depthLimit)) {
				return true;
			}
			return depth >= deepWindowFrom || (livePath.has(entry.id) && depth >= effectiveLiveWindowFrom);
		};
		const capKept = new Set<string>();
		if (nodeCapActive) {
			let budget = nodeCapLimit;
			for (const id of livePathOrder) {
				if (budget === 0) {
					break;
				}
				const entry = entryById.get(id);
				if (entry === undefined || !depthRetained(entry, depths.get(id) ?? 0)) {
					continue;
				}
				capKept.add(id);
				budget -= 1;
			}
			for (let index = entries.length - 1; index >= 0 && budget > 0; index--) {
				const entry = entries[index]!.entry;
				if (capKept.has(entry.id) || !depthRetained(entry, depths.get(entry.id) ?? 0)) {
					continue;
				}
				capKept.add(entry.id);
				budget -= 1;
			}
		}
		const isRetained = (entry: SessionEntry, depth: number): boolean => {
			if (!depthRetained(entry, depth)) {
				return false;
			}
			return nodeCapActive ? capKept.has(entry.id) : true;
		};

		const roots: SessionTreeNode[] = [];
		let returned = 0;
		let omitted = 0;
		let shallowestRetained: number | undefined;
		let detachedLeaf: SessionTreeNode | undefined;
		for (const flatNode of entries) {
			const entry = flatNode.entry;
			const depth = depths.get(entry.id) ?? 0;
			const node = nodeMap.get(entry.id)!;
			if (!isRetained(entry, depth)) {
				// The leaf anchors its own window, so in practice it is always retained;
				// this is the safety net for a leaf that falls outside both windows -
				// reachable when the K3X-4 live-window rise puts the cut exactly one
				// above the leaf (deepWindowFrom == leafDepth + 1). It comes back
				// detached and is counted once, in `returned` only - counting it in
				// both buckets made the stats report one more node than the session has.
				if (entry.id === leafId) {
					detachedLeaf = node;
					returned += 1;
				} else {
					omitted += 1;
				}
				continue;
			}
			returned += 1;
			if (shallowestRetained === undefined || depth < shallowestRetained) {
				shallowestRetained = depth;
			}
			const parentId = entry.parentId;
			const parent = parentId === null || parentId === entry.id ? undefined : nodeMap.get(parentId);
			if (parent && isRetained(parent.entry, depths.get(parent.entry.id) ?? 0)) {
				parent.children.push(node);
			} else {
				roots.push(node);
			}
		}
		if (detachedLeaf) {
			// The bound must not hide the entry the session resumes on, so an out-of-window
			// leaf comes back detached. Detached means no ancestors and no children: its
			// retained descendants (a deeper branch) already stand as roots of their own, and
			// re-attaching them here would rebuild exactly the chain depth the bound exists
			// to prevent.
			roots.push(detachedLeaf);
		}
		const leafNode = leafId === null ? undefined : nodeMap.get(leafId);
		const leafIncluded =
			leafNode !== undefined &&
			(leafNode === detachedLeaf || isRetained(leafNode.entry, depths.get(leafNode.entry.id) ?? 0));

		// Sort children by timestamp (oldest first, newest at bottom)
		// Use iterative approach to avoid stack overflow on deep trees
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return {
			tree: roots,
			stats: {
				entries: entries.length,
				returnedNodes: returned,
				omittedNodes: omitted,
				maxDepth,
				// The stats ride the wire, and JSON has no Infinity: an unbounded build reports
				// the largest representable depth instead of a null that reads as "unknown".
				depthLimit: Number.isFinite(depthLimit) ? depthLimit : Number.MAX_SAFE_INTEGER,
				maxNodes: Number.isFinite(nodeLimit) ? nodeCapLimit : Number.MAX_SAFE_INTEGER,
				retainedFromDepth: shallowestRetained ?? 0,
				leafIncluded,
				truncated: omitted > 0,
			},
		};
	}

	/**
	 * Move the leaf to `branchFromId` (a rewind or tree navigation) and record the
	 * new position so it survives a restart.
	 *
	 * The position cannot live in memory alone: resume resolves the leaf from the
	 * last line of the session file, so an unrecorded rewind is silently undone
	 * when the process stops before the next append - the abandoned turn comes
	 * back into the model context while the UI and the transcript show no
	 * difference.
	 */
	branch(branchFromId: string): void {
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this._setLeaf(resolveCompleteToolPairLeaf(this.getBranch(branchFromId))?.id ?? null);
	}

	/** Clear the leaf (rewind past the first entry) and record that position. */
	resetLeaf(): void {
		this._setLeaf(null);
	}

	/**
	 * Append a position marker for the leaf this session was moved to.
	 *
	 * Written as a transcript entry rather than a sidecar so the position can never
	 * fork from the transcript: it is appended by the same writer as every other
	 * entry, travels with the file through fork/export/checkpoint, and cannot point
	 * at an entry that the file does not contain. It is deliberately not an
	 * `_appendEntry`: the marker describes the leaf, so the leaf stays where the
	 * caller put it and the marker hangs off that entry.
	 */
	private _recordLeafPosition(targetId: string | null): void {
		const entry: LeafPositionEntry = {
			type: "leaf_position",
			id: generateId(this.byId),
			parentId: targetId,
			timestamp: new Date().toISOString(),
			targetId,
		};
		this._pushIndexedEntry(entry);
		this._persist(entry);
	}

	/**
	 * Append an entry that must not become the leaf (a compaction of a branch the
	 * session has already left).
	 *
	 * The file's last line decides the leaf on resume, so the entry would drag the
	 * position back to the branch it belongs to; the current position is therefore
	 * re-asserted behind it.
	 */
	private _appendEntryKeepingLeaf(entry: SessionEntry): void {
		// LAT-4: same window cut as _appendEntry - the pinned entry's parent and
		// the position marker behind it must not reference deferred merge ids.
		this.flushChildUsageAttributions();
		this._pushIndexedEntry(entry);
		this._persist(entry);
		this._recordLeafPosition(this.leafId);
	}

	private _setLeaf(targetId: string | null): void {
		// A no-op move needs no marker: the leaf already resolves to this position,
		// either because it is the last entry in the file or because an earlier
		// marker recorded it.
		if (targetId === this.leafId) return;
		// LAT-4: cut the attribution window before the leaf moves, so a deferred
		// flush cannot splice the disk chain back into the abandoned branch or
		// land behind the position marker that records the rewind.
		this.flushChildUsageAttributions();
		// LAT-5: the agent_status no-op dedupe key must follow the active branch.
		// After a rewind the last written verdict can sit off-branch, and the
		// summarizer re-publishing that same verdict must not be dropped.
		this.lastAgentStatusWrite = undefined;
		this.leafId = targetId;
		this._recordLeafPosition(targetId);
	}

	branchWithSummary(
		branchFromId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		const snappedId =
			branchFromId === null ? null : (resolveCompleteToolPairLeaf(this.getBranch(branchFromId))?.id ?? null);
		// LAT-4: cut the attribution window before the leaf moves to the summary,
		// so later merges splice onto the summary entry instead of the branch it
		// summarized away.
		this.flushChildUsageAttributions();
		this.leafId = snappedId;
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.byId),
			parentId: snappedId,
			timestamp: new Date().toISOString(),
			fromId: snappedId ?? "root",
			summary,
			details,
			fromHook,
			usage,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	createBranchedSession(leafId: string): string | undefined {
		const previousSessionFile = this.sessionFile;
		const path = this.getBranch(leafId);
		if (path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		const snapped = resolveCompleteToolPairLeaf(path);
		const cutPath = snapped ? path.slice(0, path.indexOf(snapped) + 1) : [];
		const pathWithoutLabels = cutPath.filter((e) => e.type !== "label");

		const target = this.persist
			? createUniqueSessionFileTarget(this.getSessionDir())
			: { sessionId: createSessionId(), sessionFile: undefined };
		const newSessionId = target.sessionId;
		const timestamp = new Date().toISOString();
		const newSessionFile = target.sessionFile;

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: this.persist ? previousSessionFile : undefined,
			rlmDepth: resolveSessionRlmDepth(this.getHeader() ?? {}, previousSessionFile ?? newSessionFile ?? ""),
			git: this.persist ? (captureGitContext(this.cwd) ?? undefined) : undefined,
		};

		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({ targetId, label, timestamp: this.labelTimestampsById.get(targetId)! });
			}
		}

		if (this.persist) {
			const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
			let parentId = lastEntryId;
			const labelEntries: LabelEntry[] = [];
			for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
				const labelEntry: LabelEntry = {
					type: "label",
					id: generateId(new Set(pathEntryIds)),
					parentId,
					timestamp: labelTimestamp,
					targetId,
					label,
				};
				pathEntryIds.add(labelEntry.id);
				labelEntries.push(labelEntry);
				parentId = labelEntry.id;
			}

			this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
			this.sessionId = newSessionId;
			this.sessionFile = newSessionFile;
			this._buildIndex();

			// Only write the file now if it contains an assistant message.
			// Otherwise defer to _persist(), which creates the file on the
			// first assistant response, matching the newSession() contract
			// and avoiding the duplicate-header bug when _persist()'s
			// no-assistant guard later resets flushed to false. The
			// _buildIndex() above just recomputed the guard cache.
			const hasAssistant = this.hasAssistantEntry;
			if (hasAssistant) {
				this._rewriteFile();
				this.flushed = true;
			} else {
				this.flushed = false;
			}

			return newSessionFile;
		}

		const labelEntries: LabelEntry[] = [];
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
		for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
				parentId,
				timestamp: labelTimestamp,
				targetId,
				label,
			};
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}
		this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
		this.sessionId = newSessionId;
		this._buildIndex();
		return undefined;
	}

	static create(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ?? getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, undefined, true);
	}

	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		// Only the header's cwd is needed to construct the manager; the constructor
		// (setSessionFile) performs the full parse. Read just the first line here
		// instead of parsing the entire file a second time — that double parse is a
		// needless O(n) cost on open and is noticeable for long sessions.
		let cwd = cwdOverride;
		if (cwd === undefined) {
			let header: Partial<SessionHeader> | undefined;
			try {
				header = readSessionHeader(path);
			} catch {
				header = undefined;
			}
			// readSessionHeader only inspects the first physical line. If that isn't a
			// valid session header (e.g. a leading blank/whitespace or malformed line),
			// fall back to the full loader, which trims and skips such lines exactly
			// like setSessionFile does — so this.cwd stays consistent with the header
			// the session is actually loaded with. This slow path is rare.
			if (header?.type !== "session" || typeof header.id !== "string") {
				header = loadEntriesFromFile(path).find((e) => e.type === "session") as SessionHeader | undefined;
			}
			cwd = header?.cwd;
		}
		const dir = sessionDir ?? resolve(path, "..");
		return new SessionManager(cwd ?? process.cwd(), dir, path, true, undefined, sessionDir !== undefined);
	}

	static async openAsync(path: string, sessionDir?: string, cwdOverride?: string): Promise<SessionManager> {
		if (!existsSync(path)) {
			return SessionManager.open(path, sessionDir, cwdOverride);
		}
		const entries = await loadEntriesFromFileAsync(path);
		if (entries.length === 0) {
			return SessionManager.open(path, sessionDir, cwdOverride);
		}
		const cwd = cwdOverride ?? (entries[0] as SessionHeader).cwd;
		const dir = sessionDir ?? resolve(path, "..");
		return new SessionManager(cwd ?? process.cwd(), dir, path, true, entries, sessionDir !== undefined);
	}

	static async openInMemoryAsync(path: string, sessionDir?: string, cwdOverride?: string): Promise<SessionManager> {
		const entries = await loadEntriesFromFileAsync(path);
		if (entries.length === 0) throw new Error(`Session file is empty or invalid: ${path}`);
		migrateToCurrentVersion(entries);
		const cwd = cwdOverride ?? (entries[0] as SessionHeader).cwd;
		const dir = sessionDir ?? resolve(path, "..");
		return new SessionManager(cwd ?? process.cwd(), dir, undefined, false, entries);
	}

	/**
	 * Continue the most recent session, or create new if none.
	 * @param cwd Working directory
	 * @param sessionDir Optional session directory. If omitted, uses the configured session root.
	 */
	static continueRecent(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ?? getDefaultSessionDir(cwd);
		const mostRecent = findMostRecentSessionForCwd(dir, cwd);
		if (mostRecent) {
			return new SessionManager(cwd, dir, mostRecent, true);
		}
		return new SessionManager(cwd, dir, undefined, true);
	}

	static inMemory(cwd: string = process.cwd(), sessionDir = ""): SessionManager {
		return new SessionManager(cwd, sessionDir, undefined, false);
	}

	static forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): SessionManager {
		const sourceEntries = loadEntriesFromFile(sourcePath);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${sourcePath}`);
		}

		const sourceHeader = sourceEntries.find((e) => e.type === "session") as SessionHeader | undefined;
		if (!sourceHeader) {
			throw new Error(`Cannot fork: source session has no header: ${sourcePath}`);
		}
		migrateToCurrentVersion(sourceEntries);

		const dir = sessionDir ?? getDefaultSessionDir(targetCwd);
		ensurePrivateDirectory(dir);

		const target = createUniqueSessionFileTarget(dir);
		const newSessionId = target.sessionId;
		const timestamp = new Date().toISOString();
		const newSessionFile = target.sessionFile;

		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: targetCwd,
			parentSession: sourcePath,
			rlmDepth: resolveSessionRlmDepth(sourceHeader, sourcePath),
			git: captureGitContext(targetCwd) ?? undefined,
		};
		const forkedEntries: FileEntry[] = [newHeader];

		// Drop the source's git_state entries (re-linking children): they describe the source repo,
		// so the fork would otherwise report the source's git instead of its own target context.
		const droppedParent = new Map<string, string | null>();
		for (const entry of sourceEntries) {
			if (entry.type === "git_state") droppedParent.set(entry.id, entry.parentId);
		}
		const liveParent = (parentId: string | null): string | null => {
			let pid = parentId;
			while (pid !== null && droppedParent.has(pid)) pid = droppedParent.get(pid) ?? null;
			return pid;
		};
		for (const entry of sourceEntries) {
			if (entry.type === "session" || entry.type === "git_state") continue;
			const parentId = liveParent(entry.parentId);
			if (entry.type === "leaf_position") {
				// The marker's targetId must follow the same re-linking as parentId:
				// left as-is it points at the removed git_state, a marker that
				// contradicts itself (parentId !== targetId) and _buildIndex
				// silently falls back to the last-line rule, drifting the fork's
				// resume position away from the source's recorded rollback point.
				const targetId = entry.targetId === null ? null : liveParent(entry.targetId);
				if (parentId === entry.parentId && targetId === entry.targetId) {
					forkedEntries.push(entry);
				} else {
					forkedEntries.push({ ...entry, parentId, targetId });
				}
				continue;
			}
			const out = parentId === entry.parentId ? entry : { ...entry, parentId };
			forkedEntries.push(out);
		}
		function* serializedEntries(): Iterable<string> {
			for (const entry of forkedEntries) yield `${JSON.stringify(entry)}\n`;
		}
		writePrivateFileAtomicLines(newSessionFile, serializedEntries());

		return new SessionManager(targetCwd, dir, newSessionFile, true);
	}

	static async list(cwd: string, sessionDir?: string, callbacks?: SessionListCallbacks): Promise<SessionInfo[]> {
		const dir = sessionDir ?? getDefaultSessionDir(cwd);
		const matchesCwd = (session: SessionInfo) => sessionInfoMatchesCwd(session, cwd);
		const sessions = (
			await listSessionsFromDir(dir, {
				onProgress: callbacks?.onProgress,
				onSession: callbacks?.onSession
					? (session) => {
							if (matchesCwd(session)) {
								callbacks.onSession?.(session);
							}
						}
					: undefined,
			})
		).filter(matchesCwd);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	static async listAll(callbacks?: SessionListCallbacks, sessionDir?: string): Promise<SessionInfo[]> {
		const sessionsDir = sessionDir ?? getSessionsDir();
		const sessions = await listSessionsFromDir(sessionsDir, callbacks);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}
}
