import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, ServiceTier, TextContent, Usage } from "@earendil-works/pi-ai";
import { randomUUID } from "crypto";
import {
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "fs";
import { lstat, readdir, readFile, stat } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { v7 as uuidv7 } from "uuid";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.js";
import {
	endsWithNewlineSync,
	isLineBoundarySync,
	isUsableResumePoint,
	readFileLines,
	readFirstLineSync,
	repairTruncatedTrailingLine,
} from "../utils/file-lines.js";
import { captureGitContext, type GitContext, gitContextsEqual } from "../utils/git.js";
import { DEFAULT_MAP_CONCURRENCY_LIMIT, mapConcurrent } from "../utils/map-concurrent.js";
import {
	appendPrivateFile,
	assertRegularFileNoSymlink,
	ensurePrivateDirectory,
	requireNoFollow,
	writePrivateFileAtomicLines,
} from "../utils/private-files.js";
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
const SESSION_ASYNC_PARSE_YIELD_BYTES = 4 * 1024 * 1024;
/** A session header is one short line; anything longer than this is not recoverable as one. */
const SESSION_HEADER_SCAN_MAX_BYTES = 64 * 1024;

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

export type AgentTaskState = "needs_input" | "completed";

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

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	serviceTier: ServiceTier;
	model: { provider: string; modelId: string } | null;
}

export interface SessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	state?: SessionState;
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

export function getSessionArtifactPathForFile(sessionFile: string, sessionId?: string): string {
	return getSessionArtifactPath(
		dirname(sessionFile),
		sessionId ?? basename(sessionFile).replace(/\.jsonl$/, ""),
		false,
	);
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
 * Restore the terminating newline of a last line that is a whole record - see
 * `parseUnterminatedHeader`. Only the write owner may call it: completing a line
 * another process is still appending to would split its write in two. Returns whether
 * the byte was written, so a torn tail keeps falling through to the torn-tail repair.
 */
function completeTrailingRecordNewline(filePath: string, ownsSessionDir: boolean): boolean {
	// A header is a short line. Bounding the read by size keeps a transcript whose
	// last line really was torn from re-reading the whole file to learn nothing.
	let size: number;
	try {
		size = statSync(filePath).size;
	} catch {
		return false;
	}
	if (size === 0 || size > SESSION_HEADER_SCAN_MAX_BYTES) return false;
	let buffer: Buffer;
	try {
		buffer = readFileSync(filePath);
	} catch {
		return false;
	}
	if (!parseUnterminatedHeader(buffer)) return false;
	appendPrivateFile(filePath, "\n", { privateParent: ownsSessionDir });
	return true;
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
export function repairOwnedSessionFile(sessionFile: string | undefined): void {
	if (!sessionFile || !existsSync(sessionFile)) return;
	assertRegularFileNoSymlink(sessionFile);
	// A header that lost only its terminator is a whole record, not a torn append:
	// truncating it away would leave the transcript with no header at all.
	if (completeTrailingRecordNewline(sessionFile, true)) return;
	repairTruncatedTrailingLine(sessionFile);
}

function readSessionHeader(filePath: string): Partial<SessionHeader> | undefined {
	assertRegularFileNoSymlink(filePath);
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

function isValidSessionFile(filePath: string): boolean {
	try {
		const header = readSessionHeader(filePath);
		return header?.type === "session" && typeof header.id === "string" && SESSION_ID_PATTERN.test(header.id);
	} catch {
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
				} catch {
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

/**
 * Everything a scan accumulates, so a later scan of the same file can pick up
 * where this one stopped instead of starting over. Every field either only ever
 * grows (counts, search text, the usage aggregates), keeps the newest value
 * (name, state, status, per-entry usage attribution), or is fixed by the first
 * line (header, first message) — which is what makes a resumed scan equivalent
 * to a full one.
 */
interface SessionScanState {
	header: SessionHeader;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	name: string | undefined;
	state: SessionState | undefined;
	agentStatus: AgentStatus | undefined;
	lastActivityTime: number | undefined;
	/** Byte offset just past the last newline-terminated line consumed. */
	offset: number;
	/**
	 * Byte position the read actually reached: `offset`, or past it when a torn
	 * trailing line was skipped. Kept so a later read can tell a scan that covered
	 * the bytes it claims from one whose offset fell behind them.
	 */
	reachedBytes: number;
	/** Newest-wins per entry id (#2003): a later attribution overwrites the target's usage. */
	assistantUsageById: Map<string, Usage>;
	/** Grow-only: one push per child_usage_attributed entry whose target was already seen. */
	attributedChildUsages: Usage[];
	/** Grow-only: one push per compaction / branch_summary entry that carries usage. */
	summarizationUsages: Usage[];
}

interface SessionInfoCacheEntry {
	size: number;
	mtimeMs: number;
	/** Distinguishes an append from a whole-file rewrite, which renames a new inode into place. */
	ino: number;
	info: SessionInfo | null;
	scan?: SessionScanState;
}

// An unchanged (size, mtimeMs) means identical content, so list metadata is
// served straight from the cache. A live session appends on every message, so
// that check always misses for exactly the sessions asked about most; the
// retained scan state lets those reads cover only the appended bytes.
const sessionInfoCache = new Map<string, SessionInfoCacheEntry>();

/**
 * Which layer served each `readSessionInfo` call. The point is not telemetry for
 * its own sake: "the disk layer absorbed what a fresh process would otherwise
 * have re-scanned" is the whole claim behind the durable cache, and it is only
 * checkable if the layers are counted.
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
 * memory, everything on disk still there.
 */
export function clearSessionInfoCaches(): void {
	sessionInfoCache.clear();
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
	sessionInfoCache.delete(filePath);
	await removeCachedSessionInfo(filePath);
}

export async function readSessionInfo(filePath: string): Promise<SessionInfo | null> {
	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		const lexicalStats = await lstat(filePath);
		if (lexicalStats.isSymbolicLink() || !lexicalStats.isFile()) return null;
		stats = await stat(filePath);
	} catch {
		return null;
	}
	const cached = sessionInfoCache.get(filePath);
	if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ino === stats.ino) {
		sessionInfoReadStats.memoryHits++;
		return cached.info;
	}
	// Resume only on a plain append to the same file: same inode, grown, and a
	// previous stopping point that is still usable. A rewrite renames a fresh
	// inode over the path, and anything else falls back to a full scan. The
	// stopping point is checked, not trusted: it is only a resume point while it
	// sits on a line boundary and can account for the bytes the scan that
	// recorded it claims to have read, so a state recorded by a reader that lost
	// bytes across chunk boundaries is rescanned instead of being re-counted from.
	const resumable =
		cached?.scan !== undefined &&
		cached.ino === stats.ino &&
		stats.size > cached.size &&
		cached.scan.offset <= stats.size &&
		isUsableResumePoint(cached.scan, cached.size) &&
		isLineBoundarySync(filePath, cached.scan.offset)
			? cached.scan
			: undefined;
	if (!resumable) {
		// A full scan is the expensive branch, so try the durable layer first: a
		// summary another process already computed for this exact (dev, ino, size,
		// mtimeMs) is equivalent to scanning again. Resumable reads skip this — a
		// few appended bytes are cheaper to parse than a whole summary is to load,
		// and a resume keeps the incremental state that the next append needs.
		const fingerprint = { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
		const durable = await readCachedSessionInfo(filePath, fingerprint);
		if (durable) {
			sessionInfoReadStats.diskHits++;
			sessionInfoCache.set(filePath, {
				size: stats.size,
				mtimeMs: stats.mtimeMs,
				ino: stats.ino,
				info: durable,
			});
			return durable;
		}
	}
	const scanned = await scanSessionInfo(filePath, stats, resumable);
	sessionInfoCache.set(filePath, {
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		ino: stats.ino,
		info: scanned.info,
		...(scanned.scan ? { scan: scanned.scan } : {}),
	});
	if (resumable) {
		sessionInfoReadStats.resumedScans++;
	} else {
		sessionInfoReadStats.fullScans++;
		if (scanned.info) {
			// Only a full scan is persisted: it is the one that just paid for the
			// whole file. A resumed scan's summary would be rewritten on every
			// append of a live session, and the next process cannot use it anyway
			// until the file stops growing.
			await writeCachedSessionInfo(
				filePath,
				{ dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs },
				scanned.info,
			);
			scheduleSessionInfoCachePrune();
		}
	}
	return scanned.info;
}

async function scanSessionInfo(
	filePath: string,
	stats: Awaited<ReturnType<typeof stat>>,
	resume?: SessionScanState,
): Promise<{ info: SessionInfo | null; scan?: SessionScanState }> {
	try {
		let header: SessionHeader | undefined = resume?.header;
		let messageCount = resume?.messageCount ?? 0;
		let firstMessage = resume?.firstMessage ?? "";
		let allMessagesText = resume?.allMessagesText ?? "";
		let name: string | undefined = resume?.name;
		let state: SessionState | undefined = resume?.state;
		let agentStatus: AgentStatus | undefined = resume?.agentStatus;
		let lastActivityTime: number | undefined = resume?.lastActivityTime;
		let offset = resume?.offset ?? 0;
		let reachedBytes = resume?.reachedBytes ?? 0;
		// Fold attribution aggregates like the loader: either disk representation cancels to the same own spend.
		// Copied, not shared: readSessionInfo() reads the cache entry, awaits this scan, then stores a new
		// entry, so two concurrent scans of one live file can both resume from the same object and would
		// otherwise push the same usage twice.
		const assistantUsageById = new Map(resume?.assistantUsageById);
		const attributedChildUsages: Usage[] = resume ? [...resume.attributedChildUsages] : [];
		const summarizationUsages: Usage[] = resume ? [...resume.summarizationUsages] : [];

		let lineCount = 0;
		for await (const fileLine of readFileLines(filePath, offset)) {
			lineCount++;
			// Where the read got, terminated or not: the resume offset only advances
			// past terminated lines, the reached position moves on every line.
			reachedBytes = fileLine.endOffset;
			// A trailing unterminated line is a torn append still in flight (or a
			// crash remnant): never count it, and never advance the resume offset
			// past it, so a completed rewrite of the same bytes is seen exactly once.
			// A file that is nothing but such a line is the header-only transcript
			// whose terminator went missing; that head is real, so it still names a
			// session rather than letting the listing drop it.
			if (!fileLine.terminated) {
				if (!header) header = parseUnterminatedHeader(fileLine.line);
				break;
			}
			offset = fileLine.endOffset;
			const line = fileLine.line.toString("utf8");
			if (!line.trim()) continue;

			// Large tool-result entries can be many MB. They do not carry the
			// session-list metadata we need, and parsing them during every refresh
			// can exhaust the daemon heap.
			if (line.length > SESSION_LIST_PARSE_MAX_LINE_CHARS) {
				if (looksLikeMessageEntry(line)) {
					messageCount++;
					const summary = extractOversizedMessageSummary(line);
					if (typeof summary.timestamp === "number" && (summary.role === "user" || summary.role === "assistant")) {
						lastActivityTime = Math.max(lastActivityTime ?? 0, summary.timestamp);
					}
					if (summary.role === "user" && !firstMessage) {
						firstMessage = summary.textPreview || "(large message)";
					}
				}
				continue;
			}

			const trimmed = line.trim();
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				continue;
			}
			// One unusable line is skipped, not fatal: it used to throw here, and the
			// catch around this scan turned that throw into "no such session".
			const reason = unindexableEntryReason(parsed);
			if (reason !== undefined) {
				noteTranscriptLineSkip(filePath, lineCount, reason);
				continue;
			}
			const entry = parsed as FileEntry;

			if (entry.type === "session_info") {
				const infoEntry = entry as SessionInfoEntry;
				name = infoEntry.name?.trim() || undefined;
			}
			if (entry.type === "session_state") {
				const stateEntry = entry as SessionStateEntry;
				const status = normalizeSessionStateStatus(stateEntry.state?.status);
				if (status) {
					state = { status };
				}
			}
			// Keep the latest recap/verdict so off-daemon sessions don't all show as
			// unjudged in the agents view. Append-only, so last seen wins.
			if (entry.type === "agent_status") {
				agentStatus = (entry as AgentStatusEntry).status;
			}
			if (entry.type === "child_usage_attributed") {
				const attribution = entry as ChildUsageAttributionEntry;
				if (assistantUsageById.has(attribution.targetId)) {
					assistantUsageById.set(attribution.targetId, attribution.aggregateUsage);
					attributedChildUsages.push(attribution.childUsage);
				}
			}
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				const summarizationUsage = (entry as CompactionEntry | BranchSummaryEntry).usage;
				if (summarizationUsage) summarizationUsages.push(summarizationUsage);
			}
			if (!header) {
				if (entry.type !== "session") {
					return { info: null };
				}
				header = entry as SessionHeader;
				if (typeof header.id !== "string" || !SESSION_ID_PATTERN.test(header.id)) {
					return { info: null };
				}
			}

			lastActivityTime = updateLastActivityTime(lastActivityTime, entry);

			if (entry.type !== "message") continue;
			messageCount++;

			const message = (entry as SessionMessageEntry).message;
			if (message.role === "assistant" && (message as { usage?: Usage }).usage) {
				assistantUsageById.set(entry.id, (message as { usage: Usage }).usage);
			}
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessagesText = appendCappedSearchText(allMessagesText, textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		if (!header) return { info: null };
		const usageTotal = emptyUsage();
		for (const usage of assistantUsageById.values()) {
			addAssistantUsage(usageTotal, usage);
		}
		for (const usage of summarizationUsages) {
			addAssistantUsage(usageTotal, usage);
		}
		for (const childUsage of attributedChildUsages) {
			subtractAssistantUsage(usageTotal, childUsage);
		}
		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = header.parentSession;
		const rlmDepth = resolveSessionRlmDepth(header, filePath);
		const modified = getSessionModifiedDateFromLastActivity(lastActivityTime, header, stats.mtime);

		return {
			info: {
				path: filePath,
				id: header.id,
				cwd,
				name,
				state,
				parentSessionPath,
				rlmDepth,
				created: new Date(header.timestamp),
				modified,
				messageCount,
				firstMessage: firstMessage || "(no messages)",
				allMessagesText,
				agentStatus,
				usage: sessionUsageSummaryFrom(usageTotal),
			},
			scan: {
				header,
				messageCount,
				firstMessage,
				allMessagesText,
				name,
				state,
				agentStatus,
				lastActivityTime,
				offset,
				reachedBytes,
				assistantUsageById,
				attributedChildUsages,
				summarizationUsages,
			},
		};
	} catch (error) {
		// The session stays out of the listing - there is nothing safe to show - but a
		// transcript that cannot be read is not the same thing as no transcript, and a
		// swallowed error is how "my session disappeared" ends up undiagnosable.
		noteTranscriptLineSkip(
			filePath,
			0,
			`unreadable transcript: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { info: null };
	}
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
		return sessions;
	}

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
		const total = progressTotal ?? files.length;

		const present = new Set(files);
		for (const key of sessionInfoCache.keys()) {
			if (dirname(key) === dir && !present.has(key)) {
				sessionInfoCache.delete(key);
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
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;
	private persistListeners = new Set<SessionPersistListener>();
	private persistFailureListeners = new Set<SessionPersistFailureListener>();

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
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
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
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			this.byId.set(entry.id, entry);
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

		const hasAssistant = this.fileEntries.some(isAssistantMessageEntry);
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
				appendPrivateFile(this.sessionFile, `${JSON.stringify(entry)}\n`, { privateParent: this.ownsSessionDir });
			} catch (error) {
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
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		this._persist(entry);
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
		options?: { leafId?: string; usage?: Usage },
	): string {
		const targetLeaf = options?.leafId ?? this.leafId;
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
		};
		// A pinned leaf means the session moved (branch navigation) while the
		// summary was being generated. The entry still belongs to the branch it
		// summarized, but it must not drag the current position back to it.
		if (targetLeaf === this.leafId) {
			this._appendEntry(entry);
		} else {
			this._appendEntryKeepingLeaf(entry);
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
		this._appendEntry(entry);
		return entry.id;
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
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
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

	getFlatTree(): SessionTreeFlatNode[] {
		return this.getEntries().map((entry) => ({
			entry,
			label: this.labelsById.get(entry.id),
			labelTimestamp: this.labelTimestampsById.get(entry.id),
		}));
	}

	getTree(): SessionTreeNode[] {
		const entries = this.getFlatTree();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const flatNode of entries) {
			nodeMap.set(flatNode.entry.id, { ...flatNode, children: [] });
		}

		for (const flatNode of entries) {
			const entry = flatNode.entry;
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					roots.push(node);
				}
			}
		}

		// Sort children by timestamp (oldest first, newest at bottom)
		// Use iterative approach to avoid stack overflow on deep trees
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
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
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
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
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this._persist(entry);
		this._recordLeafPosition(this.leafId);
	}

	private _setLeaf(targetId: string | null): void {
		// A no-op move needs no marker: the leaf already resolves to this position,
		// either because it is the last entry in the file or because an earlier
		// marker recorded it.
		if (targetId === this.leafId) return;
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
			// no-assistant guard later resets flushed to false.
			const hasAssistant = this.fileEntries.some(isAssistantMessageEntry);
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
