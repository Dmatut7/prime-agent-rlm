import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.js";
import { appendPrivateFile, readPrivateFile, writePrivateFileAtomic } from "../../utils/private-files.js";
import { serializeConversation } from "../compaction/utils.js";
import { convertToLlm } from "../messages.js";
import type { CustomEntry } from "../session-manager.js";

export const REFINEMENT_CUSTOM_TYPE = "prime-agent.refinement";

export const HARNESS_CONCURRENT_WRITE_ERROR = "Harness state changed on disk during apply; refusing to overwrite";

export const REFINE_SKILL_NAME = "refine";

export const WINDOWS_HARNESS_PERSISTENCE_UNSUPPORTED_ERROR = "Persistent harness storage is unsupported on Windows";

export function isPersistentHarnessStorageSupported(): boolean {
	return process.platform !== "win32";
}

function assertPersistentHarnessStorageSupported(): void {
	if (!isPersistentHarnessStorageSupported()) throw new Error(WINDOWS_HARNESS_PERSISTENCE_UNSUPPORTED_ERROR);
}

const HARNESS_STATE_DIR_NAME = "harness";
const REFINEMENT_HISTORY_FILE_NAME = "refinements.jsonl";
const REFINEMENT_FAILURES_FILE_NAME = "refinement-failures.jsonl";
/** Raw model output preserved per parse failure, in UTF-8 bytes: ~8KiB per record. */
const REFINEMENT_FAILURE_RAW_BYTE_LIMIT = 8 * 1024;
const DEFAULT_OVERVIEW_ENTRY_LIMIT = 6;
const DEFAULT_OVERVIEW_REFINEMENT_LIMIT = 5;
const DEFAULT_OVERVIEW_CONTENT_LIMIT = 180;
/** The refiner's own view is wider than the injected face but still truncated. */
const REFINER_OVERVIEW_ENTRY_LIMIT = 40;
/** How to read entries the view had to drop, per session capability. */
const KERNEL_FULL_LIST_HINT =
	"read them all with `rlm.harness.overview(max_entries_per_kind=...)` (`global_=True` for global entries)";
const HARNESS_STATE_FILE_HINT = "the full list stays in the harness state file";

export type RefinementKind = "prompt" | "memory" | "skill" | "subagent";
export type RefinementAction = "create" | "update" | "delete";
export type HarnessScope = "local" | "global";

export interface HarnessEntry {
	id: string;
	kind: RefinementKind;
	title: string;
	content: string;
	path: string;
	scope?: HarnessScope;
	reference: Record<string, unknown>;
	arguments: Record<string, unknown>;
	metadata: Record<string, unknown>;
	source: string;
	created_at: string;
	updated_at: string;
	version: number;
}

export interface HarnessRefinementEvent {
	id: string;
	trigger: string;
	changes: string[];
	evidence: string;
	outcome: string;
	created_at: string;
}

export interface HarnessState {
	schema: number;
	/** Unsafe on-disk state is readable only; mutations must fail closed. */
	persistentWriteError?: string;
	entries: Record<RefinementKind, Record<string, HarnessEntry>>;
	refinements: HarnessRefinementEvent[];
}

export interface RefinementEdit {
	action: RefinementAction;
	kind: RefinementKind;
	id?: string;
	title?: string;
	content?: string;
	path?: string;
	reference?: Record<string, unknown>;
	arguments?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	reason?: string;
	/**
	 * The store the refiner named in front of the id, when it wrote the id with
	 * the `[global:foo]` prefix the overview uses (M5). Stripped from `id`, kept
	 * here so an edit aimed at the other store can be refused with a reason
	 * instead of failing as a plain "entry not found".
	 */
	idScope?: HarnessScope;
}

const SCOPE_PREFIX_PATTERN = /^\[?(global|local):/;

export interface RefinementProposal {
	summary: string;
	rationale: string;
	edits: RefinementEdit[];
	expectedOutcome: string;
}

export interface AppliedRefinementEdit extends RefinementEdit {
	id: string;
	before?: HarnessEntry;
	after?: HarnessEntry;
	applied: boolean;
	error?: string;
}

export interface RefinementResult {
	id: string;
	summary: string;
	rationale: string;
	expectedOutcome: string;
	appliedEdits: AppliedRefinementEdit[];
	harnessStatePath: string;
	rollbackOf?: string;
	scope?: HarnessScope;
}

export interface RefineOptions {
	instructions?: string;
	rollbackId?: string;
	global?: boolean;
}

export type AutoRefineReason = "turn_interval" | "compact";

export interface AutoRefineReviewContext {
	reason: AutoRefineReason;
	turnsSinceLastReview: number;
	/** Store the review is deciding about; auto-refine is local, and that is the default here. */
	scope?: HarnessScope;
}

export interface AutoRefineReview {
	shouldRefine: boolean;
	rationale: string;
	instructions?: string;
}

const REFINEMENT_SYSTEM_PROMPT = `You are Prime Agent's /refine continual harness subsystem.

Your job is to improve the editable continual harness state from the current trajectory.
This is similar in spirit to context compaction, but instead of summarizing the
conversation you emit precise Create, Update, or Delete edits to reusable state.
The continual harness is the persistent, editable set of prompt notes, memories,
skills, and subagent specs that lets Prime Agent improve reusable behavior
outside the token history.
Use "continual harness" for that persistent artifact layer; keep "RLM" for the
runtime, Python REPL kernel, and native call interface that executes those artifacts.

Continual harness components:
- prompt: supplemental prompt notes only. The base system prompt is immutable and MUST NOT be rewritten.
- memory: durable facts, decisions, failures, preferences, and outcomes.
- skill: installed Python REPL skill. Skill create/update edits MUST include a \`reference\` object with \`{"type":"python"}\`, a Python import, and a callable or call pattern; they also MUST include an \`arguments\` object describing accepted inputs, required fields, defaults, and constraints. Use \`{}\` for \`arguments\` only when the Python callable truly needs no external inputs. Include the RLM-native call form \`await <skill_import>(...)\`.
- subagent: reusable delegation specs, including purpose, instructions, and when to invoke. Include the RLM-native call form: compose a concise task prompt and spawn with \`handle = await rlm("sub-task")\`; admission returns immediately with \`rlm_child_id\`, \`name\`, \`session_dir\`, and \`model\`, never the child's answer. Results arrive only through explicit \`agent_message\` replies or files; children reply with \`await agent_message.send(message, receiver_role="parent")\`. Use \`await rlm.list_subagents()\` to recover direct child handles and \`await agent_message.send(..., receiver_role="child", receiver_name=handle.name)\` for follow-ups. Do not invent wrappers like \`run_subagent(...)\`.

Scope and persistence policy:
- The default editable continual harness store is local to the current Prime Agent session. Use it for session-specific progress, active task state, current-run coordination notes, temporary blockers, and project facts that should not affect other sessions.
- A caller may explicitly request global refinement. Global edits must be stable cross-session lessons, durable user preferences, reusable skills/subagents, or tool/environment facts that should affect future sessions.
- Entry ids in the harness overview may carry a display-only \`local:\` or \`global:\` prefix. Always use the bare id (no prefix) in edits.
- All edits in one refinement apply only to the requested scope's store. During a local refinement, global entries are read-only context: never propose update or delete edits for them; create a local entry instead when a session-specific override is genuinely needed.
- Project/workspace-specific lessons may be persisted globally only when the title, path, or content explicitly names the project/workspace and the lesson is likely to be reused in future sessions for that project. Prefer local edits when the lesson only belongs in the current conversation.
- Use memory for declarative facts and preferences, skill for repeatable procedures exposed as Python calls, prompt for narrow behavioral policy addendums, and subagent for reusable delegation roles.
- Create or update the smallest relevant component: repeated delegation roles should become subagent specs, repeated procedures should become skills, durable facts/preferences should become memories, and narrow behavioral policies should become prompt addendums.
- When an edit is persisted, include metadata such as \`{"scope":"local"}\` or \`{"scope":"global"}\` when that helps future review understand the intended blast radius.

Use the trajectory, current continual harness state, and prior refinement history. Prefer
small evidence-backed edits. If prior refinements caused issues, rollback or
replace the faulty editable entries. Never edit source files directly. Output
JSON only with this exact shape:

{
  "summary": "one sentence",
  "rationale": "why these edits are justified by trajectory evidence",
  "expectedOutcome": "what should improve and how to validate it",
  "edits": [
    {
      "action": "create|update|delete",
      "kind": "prompt|memory|skill|subagent",
      "id": "stable id for update/delete, optional for create",
      "title": "required for create/update except delete",
      "content": "required for create/update except delete",
      "path": "optional grouping path",
      "reference": {"type": "python", "import": "package.module", "callable": "function_name", "call_pattern": "await function_name(...)"},
      "arguments": {"name": {"type": "string", "required": true, "description": "accepted input"}},
      "metadata": {},
      "reason": "why this edit is useful"
    }
  ]
}`;

const AUTO_REFINE_REVIEW_SYSTEM_PROMPT = `You are Prime Agent's automatic /refine review gate.

Decide whether this checkpoint should run /refine. Auto /refine writes local continual harness state by default, so approve when the trajectory contains evidence useful to this session's future turns.
Reject one-off noise, unsupported hypotheses, and transient tool outputs. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified lessons likely to be reused in future sessions.

Return JSON only:
{
  "shouldRefine": true|false,
  "rationale": "short reason",
  "instructions": "optional concise instructions for /refine if shouldRefine is true"
}`;

/**
 * Output budgets are derived from the selected model instead of fixed literals.
 * /refine input scales with harness size (entry overview, refinement history, and
 * the trajectory slice), so a constant output cap silently truncates exactly the
 * large multi-edit proposals that matter most. Math.min keeps small models honest.
 */
const REFINEMENT_MAX_OUTPUT_TOKENS = 32_000;
const AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS = 4_096;

const TRUNCATED_JSON_ERROR =
	"the model stopped before completing its JSON object. This usually means the output budget was exhausted; retry with a smaller request.";

function refinementMaxOutputTokens(model: Model<any>): number {
	return Math.min(model.maxTokens, REFINEMENT_MAX_OUTPUT_TOKENS);
}

function autoRefineReviewMaxOutputTokens(model: Model<any>): number {
	return Math.min(model.maxTokens, AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS);
}

function now(): string {
	return new Date().toISOString();
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function emptyHarnessState(): HarnessState {
	return {
		schema: 1,
		entries: {
			prompt: {},
			memory: {},
			skill: {},
			subagent: {},
		},
		refinements: [],
	};
}

function slug(raw: string, fallback: string): string {
	const normalized = raw
		.trim()
		.toLowerCase()
		// Unicode letters and digits survive: stripping CJK would collapse every
		// non-Latin title onto the kind name and give unrelated facts one identity.
		.replace(/[^\p{L}\p{N}]+/gu, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return normalized || fallback;
}

function comparableTitle(title: string): string {
	return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Titles can normalize onto one id (case, punctuation, or a title with no usable
 * characters that falls back to the kind name). Give the newcomer a deterministic
 * suffix instead of dropping the edit, so distinct facts keep distinct identities.
 * A candidate that already holds the same title is returned unchanged, which keeps
 * a redundant re-recording a visible "entry already exists" refusal rather than a
 * silent duplicate.
 */
function uniqueEntryId(records: Record<string, HarnessEntry>, baseId: string, title: string): string {
	const targetTitle = comparableTitle(title);
	let candidate = baseId;
	for (let suffix = 2; records[candidate]; suffix += 1) {
		if (comparableTitle(records[candidate].title) === targetTitle) {
			break;
		}
		candidate = `${baseId}_${suffix}`;
	}
	return candidate;
}

/** Most recent write first; a missing timestamp sorts last. */
function entryRecency(entry: HarnessEntry): string {
	const updated = entry.updated_at;
	if (typeof updated === "string" && updated.length > 0) {
		return updated;
	}
	const created = entry.created_at;
	return typeof created === "string" ? created : "";
}

/**
 * Injection order is "most recently updated first", with the id as a tie-break so the
 * same state always renders the same text: an ordering that drifts between turns would
 * invalidate the prompt cache and let a fresh fact fall out of view.
 */
function compareEntriesForInjection(a: HarnessEntry, b: HarnessEntry): number {
	const recency = entryRecency(b).localeCompare(entryRecency(a));
	if (recency !== 0) {
		return recency;
	}
	const byId = a.id.localeCompare(b.id);
	if (byId !== 0) {
		return byId;
	}
	return (a.scope ?? "").localeCompare(b.scope ?? "");
}

function entriesForInjection(state: HarnessState, kind: RefinementKind): HarnessEntry[] {
	return Object.values(state.entries[kind]).sort(compareEntriesForInjection);
}

/**
 * A bare count hides that the view is truncated. Name how many entries are missing and
 * how to read them, so a missing fact reads as a visible gap instead of an absent one.
 */
function overflowLine(kind: RefinementKind, hidden: number, total: number, hint: string): string {
	return `- +${hidden} more ${kind} entries (${total} recorded; ${hint})`;
}

function cloneEntry(entry: HarnessEntry | undefined): HarnessEntry | undefined {
	return entry ? JSON.parse(JSON.stringify(entry)) : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function normalizeHarnessScope(value: unknown, fallback: HarnessScope): HarnessScope {
	return value === "global" || value === "local" ? value : fallback;
}

export function inferRefinementResultScope(result: RefinementResult): HarnessScope | undefined {
	if (result.scope) {
		return result.scope;
	}

	const scopes = new Set<HarnessScope>();
	for (const edit of result.appliedEdits) {
		const scope = edit.after?.scope ?? edit.before?.scope;
		if (scope) {
			scopes.add(scope);
		}
	}
	return scopes.size === 1 ? [...scopes][0] : undefined;
}

function withDefaultRefinementScope(result: RefinementResult, scope: HarnessScope): RefinementResult {
	const inferred = inferRefinementResultScope(result);
	return { ...result, scope: inferred ?? scope };
}

export function getGlobalHarnessStateDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, HARNESS_STATE_DIR_NAME);
}

export function getLocalHarnessStateDir(sessionArtifactDir: string | undefined): string | undefined {
	return sessionArtifactDir ? join(sessionArtifactDir, HARNESS_STATE_DIR_NAME) : undefined;
}

export function getHarnessStatePath(harnessStateDir: string = getGlobalHarnessStateDir()): string {
	return join(harnessStateDir, "harness_state.json");
}

function unsafeHarnessDirectoryError(path: string): string {
	return `Refusing to use non-directory private path: ${path}`;
}

function validateHarnessDirectory(path: string): string | undefined {
	const target = resolve(path);
	const root = parse(target).root;
	const components = target.slice(root.length).split(/[/\\]/).filter(Boolean);
	let current = root;
	for (const [index, component] of components.entries()) {
		current = join(current, component);
		try {
			const info = lstatSync(current);
			if (info.isSymbolicLink()) {
				// Intermediate symlinks (e.g. a relocated ~/.prime) are legitimate
				// layouts and are followed after resolution; only the harness
				// directory itself keeps the O_NOFOLLOW refusal.
				if (index === components.length - 1) return unsafeHarnessDirectoryError(current);
				current = realpathSync(current);
				continue;
			}
			if (!info.isDirectory()) return unsafeHarnessDirectoryError(current);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			return unsafeHarnessDirectoryError(current);
		}
	}
	return undefined;
}

export function loadHarnessState(
	harnessStateDir: string = getGlobalHarnessStateDir(),
	scope: HarnessScope = "global",
): HarnessState {
	if (!isPersistentHarnessStorageSupported()) return emptyHarnessState();
	const directoryError = validateHarnessDirectory(harnessStateDir);
	if (directoryError) {
		const state = emptyHarnessState();
		state.persistentWriteError = directoryError;
		return state;
	}
	const statePath = getHarnessStatePath(harnessStateDir);
	try {
		const info = lstatSync(statePath);
		if (info.isSymbolicLink() || !info.isFile()) {
			const state = emptyHarnessState();
			state.persistentWriteError = `Refusing to use non-regular private file: ${statePath}`;
			return state;
		}
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptyHarnessState();
		throw error;
	}
	let parsed: Partial<HarnessState>;
	try {
		const raw = JSON.parse(readPrivateFile(statePath, "utf8"));
		// loadHarnessState runs on every system-prompt build and before each /refine, so
		// a corrupt or unreadable (or non-object) state file must degrade to empty rather
		// than throw and break the session. The next saveHarnessState rewrites it cleanly.
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return emptyHarnessState();
		}
		parsed = raw as Partial<HarnessState>;
	} catch {
		return emptyHarnessState();
	}
	const state = emptyHarnessState();
	state.schema = typeof parsed.schema === "number" ? parsed.schema : 1;
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const records = parsed.entries?.[kind];
		if (records && typeof records === "object") {
			for (const [id, rawEntry] of Object.entries(records)) {
				const entry = objectRecord(rawEntry);
				if (!entry) continue;
				state.entries[kind][id] = {
					...(entry as unknown as HarnessEntry),
					scope: normalizeHarnessScope(entry.scope, scope),
					reference: objectRecord(entry.reference) ?? {},
					arguments: objectRecord(entry.arguments) ?? {},
					metadata: objectRecord(entry.metadata) ?? {},
				};
			}
		}
	}
	if (Array.isArray(parsed.refinements)) {
		state.refinements = parsed.refinements;
	}
	return state;
}

export function assertHarnessStateWritable(state: HarnessState): void {
	if (state.persistentWriteError) throw new Error(state.persistentWriteError);
}

export function mergeHarnessStates(globalState: HarnessState, localState?: HarnessState): HarnessState {
	const merged = emptyHarnessState();
	merged.schema = Math.max(globalState.schema, localState?.schema ?? 1);
	for (const kind of Object.keys(merged.entries) as RefinementKind[]) {
		for (const [id, entry] of Object.entries(globalState.entries[kind])) {
			const cloned = cloneEntry(entry)!;
			merged.entries[kind][id] = { ...cloned, scope: normalizeHarnessScope(cloned.scope, "global") };
		}
		for (const [id, entry] of Object.entries(localState?.entries[kind] ?? {})) {
			const cloned = cloneEntry(entry)!;
			const scopedEntry = { ...cloned, scope: normalizeHarnessScope(cloned.scope, "local") };
			const mergedId = merged.entries[kind][id] ? `${scopedEntry.scope}:${id}` : id;
			merged.entries[kind][mergedId] = scopedEntry;
		}
	}
	merged.refinements = [...globalState.refinements, ...(localState?.refinements ?? [])];
	return merged;
}

export interface HarnessStateStamp {
	mtimeMs: number;
	size: number;
	ino: number;
}

export function readHarnessStateStamp(harnessStateDir: string): HarnessStateStamp | null {
	if (!isPersistentHarnessStorageSupported()) return null;
	const statePath = getHarnessStatePath(harnessStateDir);
	try {
		const info = lstatSync(statePath);
		if (info.isSymbolicLink() || !info.isFile()) return null;
		return { mtimeMs: info.mtimeMs, size: info.size, ino: info.ino };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

function harnessStateStampsEqual(left: HarnessStateStamp | null, right: HarnessStateStamp | null): boolean {
	if (left === null || right === null) return left === right;
	return left.mtimeMs === right.mtimeMs && left.size === right.size && left.ino === right.ino;
}

export function saveHarnessState(
	harnessStateDir: string,
	state: HarnessState,
	options?: { expectedStamp?: HarnessStateStamp | null },
): string {
	assertPersistentHarnessStorageSupported();
	assertHarnessStateWritable(state);
	if (options && "expectedStamp" in options) {
		const current = readHarnessStateStamp(harnessStateDir);
		if (!harnessStateStampsEqual(current, options.expectedStamp ?? null)) {
			throw new Error(HARNESS_CONCURRENT_WRITE_ERROR);
		}
	}
	const statePath = getHarnessStatePath(harnessStateDir);
	writePrivateFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
	return statePath;
}

export function getRefinementHistoryPath(harnessStateDir: string = getGlobalHarnessStateDir()): string {
	return join(harnessStateDir, REFINEMENT_HISTORY_FILE_NAME);
}

/** Append-only evidence log for model replies lost before becoming a refinement. */
export function getRefinementFailuresPath(harnessStateDir: string = getGlobalHarnessStateDir()): string {
	return join(harnessStateDir, REFINEMENT_FAILURES_FILE_NAME);
}

export type RefinementFailureSource = "refinement" | "auto-refine-review";

/**
 * Why the reply was lost: it could not be parsed, the output budget cut it off,
 * the provider returned an error instead of a reply, or the reply parsed into a
 * proposal whose `edits` field could not describe any edit (M6).
 */
export type RefinementFailureReason = "parse" | "length" | "provider-error" | "malformed-proposal";

export interface RefinementFailureRecord {
	ts: string;
	source: RefinementFailureSource;
	reason: RefinementFailureReason;
	error: string;
	/** The reply was cut off: a length stop reason, or a parse diagnosed as incomplete. */
	truncated: boolean;
	/** Digest of the full raw reply, so a bounded record still reconciles with a warn log. */
	sha256: string;
	rawChars: number;
	/** `raw` is a bounded prefix rather than the whole reply. */
	rawTruncated: boolean;
	raw: string;
}

/**
 * Keeps a bounded prefix of the reply. Iterating code points means the bound is
 * exact in UTF-8 bytes (CJK-heavy replies are the common case here) and never
 * cuts a surrogate pair or a multi-byte character in half.
 */
function boundedRawText(text: string, byteLimit: number): { raw: string; rawTruncated: boolean } {
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > byteLimit) break;
		bytes += size;
		end += char.length;
	}
	if (end >= text.length) return { raw: text, rawTruncated: false };
	return { raw: text.slice(0, end), rawTruncated: true };
}

/**
 * A lost refinement used to leave only a parser message or a stop reason behind,
 * so a dropped durable preference or authorization could not be recovered or
 * audited afterwards: the error arrived, but nobody could read what the model
 * had written. Keep the model's own words next to the cause, for both an
 * unparseable reply and one the output budget cut off. Evidence is best-effort -
 * a recorder failure must never replace the error the caller is about to surface.
 */
export function recordRefinementFailure(
	rawText: string,
	error: unknown,
	options: {
		source?: RefinementFailureSource;
		reason?: RefinementFailureReason;
		harnessStateDir?: string;
	} = {},
): void {
	try {
		if (!isPersistentHarnessStorageSupported()) return;
		const harnessStateDir = options.harnessStateDir ?? getGlobalHarnessStateDir();
		if (validateHarnessDirectory(harnessStateDir)) return;
		const message = error instanceof Error ? error.message : String(error);
		const reason = options.reason ?? "parse";
		const { raw, rawTruncated } = boundedRawText(rawText, REFINEMENT_FAILURE_RAW_BYTE_LIMIT);
		const record: RefinementFailureRecord = {
			ts: now(),
			source: options.source ?? "refinement",
			reason,
			error: message,
			truncated: reason === "length" || message.includes(TRUNCATED_JSON_ERROR),
			sha256: sha256Hex(rawText),
			rawChars: rawText.length,
			rawTruncated,
			raw,
		};
		appendPrivateFile(getRefinementFailuresPath(harnessStateDir), `${JSON.stringify(record)}\n`);
	} catch {
		// Losing the evidence is not a reason to lose the refinement error too.
	}
}

function isRefinementResult(data: unknown): data is RefinementResult {
	return typeof data === "object" && data !== null && "id" in data && "appliedEdits" in data;
}

/**
 * Append a global-scope refinement to the cross-session history log so it can be
 * rolled back from any session. Local-scope refinements are recorded only in the
 * session JSONL and roll back via their recorded harnessStatePath.
 */
export function appendGlobalRefinement(harnessStateDir: string, result: RefinementResult): string {
	assertPersistentHarnessStorageSupported();
	const historyPath = getRefinementHistoryPath(harnessStateDir);
	appendPrivateFile(historyPath, `${JSON.stringify(result)}\n`);
	return historyPath;
}

/**
 * Persist a refinement that has already been applied in memory.
 * Writes the harness state first, then the rollback audit (session jsonl and
 * global history) only after the state write succeeded. `expectedStamp` refuses
 * to clobber a concurrent kernel write.
 *
 * K3Q-2: the order used to be audit/history first, "so a crash after the audit
 * still lets `/refine rollback` find the id". But the stamp check happens at the
 * state write, so a *losing concurrent writer* still left rollback-selectable
 * audit and history rows for a refinement whose failure receipt said nothing was
 * recorded - a ghost a later rollback could act on. Writing the state first
 * means a rejected stamp refuses before any history lands; the crash window
 * moves to "state written, audit not yet", the safer side of the trade: an
 * applied refinement rollback cannot find is un-actionable, while a ghost row
 * for an unapplied refinement is not.
 */
export function persistAppliedRefinement(options: {
	harnessStateDir: string;
	state: HarnessState;
	result: RefinementResult;
	expectedStamp: HarnessStateStamp | null;
	appendSessionAudit: (result: RefinementResult) => void;
	globalHarnessStateDir?: string;
}): string {
	const statePath = saveHarnessState(options.harnessStateDir, options.state, {
		expectedStamp: options.expectedStamp,
	});
	options.result.harnessStatePath = statePath;
	options.appendSessionAudit(options.result);
	if (options.globalHarnessStateDir) {
		appendGlobalRefinement(options.globalHarnessStateDir, options.result);
	}
	return statePath;
}

export function loadGlobalRefinementHistory(harnessStateDir: string = getGlobalHarnessStateDir()): RefinementResult[] {
	if (!isPersistentHarnessStorageSupported() || validateHarnessDirectory(harnessStateDir)) return [];
	const historyPath = getRefinementHistoryPath(harnessStateDir);
	if (!existsSync(historyPath)) {
		return [];
	}
	const results: RefinementResult[] = [];
	let content: string;
	try {
		content = readPrivateFile(historyPath, "utf8");
	} catch {
		return results;
	}
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (isRefinementResult(parsed)) {
				results.push(withDefaultRefinementScope(parsed, "global"));
			}
		} catch {
			// Skip malformed lines so a single bad append cannot break rollback.
		}
	}
	return results;
}

/**
 * Merge global and session refinement history, de-duplicating by id. Session entries
 * win on conflict so a session that is mid-flight still resolves its own latest result.
 */
export function mergeRefinementHistory(
	global: readonly RefinementResult[],
	session: readonly RefinementResult[],
): RefinementResult[] {
	const byId = new Map<string, RefinementResult>();
	for (const result of global) {
		byId.set(result.id, result);
	}
	for (const result of session) {
		const existing = byId.get(result.id);
		byId.set(result.id, result.scope || !existing?.scope ? result : { ...result, scope: existing.scope });
	}
	return [...byId.values()];
}

function compactText(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function formatHarnessStateForPrompt(
	state: HarnessState,
	options: {
		maxEntriesPerKind?: number;
		maxRefinements?: number;
		maxContentLength?: number;
		includeIpythonExamples?: boolean;
		includeShellExamples?: boolean;
		includeRefineExamples?: boolean;
	} = {},
): string {
	const maxEntriesPerKind = options.maxEntriesPerKind ?? DEFAULT_OVERVIEW_ENTRY_LIMIT;
	const maxRefinements = options.maxRefinements ?? DEFAULT_OVERVIEW_REFINEMENT_LIMIT;
	const maxContentLength = options.maxContentLength ?? DEFAULT_OVERVIEW_CONTENT_LIMIT;
	const includeIpythonExamples = options.includeIpythonExamples ?? true;
	const includeRefineExamples = options.includeRefineExamples ?? includeIpythonExamples;
	const lines = [
		"# Continual Harness State",
		"",
		"Local continual harness entries belong to this Prime Agent session. Global continual harness entries persist across Prime Agent sessions.",
		// M5: the overview mixes both stores and every id carries its store as a
		// `[global:…]` prefix, while the read and refine defaults are local. Without
		// this line the prefix reads as decoration, a seat that sees 1005 global
		// memories still asks for a local refinement, and a local store that is
		// simply empty reads as "there are no memories at all".
		"Every entry id below is prefixed with the store it lives in, as in `[global:foo]` or `[local:foo]`; edits always use the bare id. Reads and `refine.run()` default to this session's local store, so an entry shown as `[global:foo]` is only addressable with an explicitly global request (`await refine.run(..., global_=True)`), and a local refinement cannot update or delete it.",
		"The continual harness entries below are compact summaries, not full descriptions. Use them as routing/context hints; inspect or refine the underlying continual harness entry only when detail matters.",
		"Default to local continual harness refinement for current task progress, temporary blockers, and session coordination. Use global continual harness refinement only for stable cross-session lessons, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts.",
		"Use these continual harness prompt notes, memories, skills, and subagent specs when they are relevant. The base system prompt is immutable; prompt entries below are supplemental notes only.",
		"",
		includeRefineExamples
			? "When to call `await refine.run()`: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep `await refine.run()` continual harness edits small and evidence-backed."
			: "When to refine the continual harness: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep continual harness edits small and evidence-backed.",
		"",
		includeIpythonExamples
			? "Call contract: read each installed Python skill's SKILL.md and call its documented module function in the Python REPL; do not assume a `.run` entrypoint. A skill name is a kernel module name, not a shell command: skill packages live in the kernel venv, whose bin directory is not on the `bash()` PATH, so there is no `<skill_import> ...` form to run from shell. Continual harness skill entries are Python REPL skills with an explicit Python `reference` and `arguments` contract. Spawn a continual harness subagent spec by composing a concise task prompt and calling `handle = await rlm('sub-task')`; admission returns immediately with `rlm_child_id`, `name`, `session_dir`, and `model`, never the child's answer. Results arrive only through explicit `agent_message` replies or files; children reply with `await agent_message.send(message, receiver_role='parent')`. Use `await rlm.list_subagents()` to recover direct child handles and `await agent_message.send(..., receiver_role='child', receiver_name=handle.name)` for follow-ups. Do not invent wrappers such as `call_skill(...)`, `run_subagent(...)`, or named subagent registries."
			: options.includeShellExamples
				? "Call contract: installed Python skills are kernel modules and are not shell commands; without the ipython tool there is no way to invoke them, so read their SKILL.md files and follow the documented steps with the tools this session has. Continual harness entries are routing/context hints only in sessions without the Python REPL; do not use Python `await`, `asyncio`, or `rlm` examples unless the prompt also documents a Python kernel."
				: "Call contract: continual harness entries are routing/context hints only in sessions without the Python REPL or shell access; do not use Python `await`, `asyncio`, `rlm`, or shell skill commands unless the prompt also documents those interfaces.",
		"",
	];

	let totalEntries = 0;
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const entries = entriesForInjection(state, kind);
		totalEntries += entries.length;
		// Render subagent specs as a task-shaped roster the model can match against — the
		// analogue of Claude Code's agent-type menu — rather than a bare count. In
		// REPL sessions, include the native `rlm` invocation hint.
		if (kind === "subagent" && entries.length > 0 && includeIpythonExamples) {
			lines.push(
				`${kind}: ${entries.length} (invoke a spec by turning it into a concise task prompt and spawning with \`await rlm('<task>')\`; admission returns a child handle, never the answer)`,
			);
		} else {
			lines.push(`${kind}: ${entries.length}`);
		}
		for (const entry of entries.slice(0, maxEntriesPerKind)) {
			const argumentsText =
				entry.kind === "skill" && Object.keys(entry.arguments).length > 0
					? ` args=${compactText(JSON.stringify(entry.arguments), maxContentLength)}`
					: "";
			const referenceText =
				entry.kind === "skill" && Object.keys(entry.reference).length > 0
					? ` ref=${compactText(JSON.stringify(entry.reference), maxContentLength)}`
					: "";
			lines.push(
				`- [${entry.scope ?? "global"}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${referenceText}${argumentsText}: ${compactText(
					entry.content,
					maxContentLength,
				)}`,
			);
		}
		const overflow = entries.length - Math.min(entries.length, maxEntriesPerKind);
		if (overflow > 0) {
			lines.push(
				overflowLine(
					kind,
					overflow,
					entries.length,
					includeIpythonExamples ? KERNEL_FULL_LIST_HINT : HARNESS_STATE_FILE_HINT,
				),
			);
		}
		lines.push("");
	}

	if (totalEntries === 0) {
		lines.push("No saved harness entries yet.", "");
	}

	lines.push(`recent refinements: ${state.refinements.length}`);
	for (const event of state.refinements.slice(-maxRefinements)) {
		const changes = event.changes.length > 0 ? event.changes.join(", ") : "no applied edits";
		const outcome = event.outcome ? `; outcome: ${compactText(event.outcome, maxContentLength)}` : "";
		lines.push(`- [${event.id}] ${compactText(event.trigger, maxContentLength)}: ${changes}${outcome}`);
	}
	const refinementOverflow = state.refinements.length - Math.min(state.refinements.length, maxRefinements);
	if (refinementOverflow > 0) {
		lines.push(`- +${refinementOverflow} older refinement events`);
	}

	return lines.join("\n").trim();
}

function overviewForPrompt(state: HarnessState, scope: HarnessScope = "local"): string {
	const lines: string[] = [
		`Entries are listed from both stores; each id carries its store as a \`[global:…]\` or \`[local:…]\` prefix. Use the bare id in edits. This request targets the ${scope} store, so an update or delete of an entry whose prefix names the other store is refused with a reason: ask for a ${scope === "global" ? "local" : "global"} refinement instead of guessing.`,
		"",
	];
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const entries = entriesForInjection(state, kind);
		lines.push(`${kind}: ${entries.length}`);
		for (const entry of entries.slice(0, REFINER_OVERVIEW_ENTRY_LIMIT)) {
			const content = entry.content.replace(/\s+/g, " ").slice(0, 240);
			const argumentsText =
				entry.kind === "skill" && Object.keys(entry.arguments).length > 0
					? ` args=${JSON.stringify(entry.arguments).slice(0, 240)}`
					: "";
			const referenceText =
				entry.kind === "skill" && Object.keys(entry.reference).length > 0
					? ` ref=${JSON.stringify(entry.reference).slice(0, 240)}`
					: "";
			lines.push(
				`- [${entry.scope ?? "global"}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${referenceText}${argumentsText}: ${content}`,
			);
		}
		if (entries.length > REFINER_OVERVIEW_ENTRY_LIMIT) {
			lines.push(
				overflowLine(kind, entries.length - REFINER_OVERVIEW_ENTRY_LIMIT, entries.length, HARNESS_STATE_FILE_HINT),
			);
		}
	}
	return lines.join("\n");
}

function historyForPrompt(history: RefinementResult[]): string {
	if (history.length === 0) {
		return "No prior refinement history.";
	}
	return history
		.slice(-20)
		.map((item) => {
			const edits = item.appliedEdits
				.map((edit) => `${edit.applied ? "applied" : "failed"} ${edit.action} ${edit.kind}:${edit.id}`)
				.join(", ");
			const rollback = item.rollbackOf ? ` rollbackOf=${item.rollbackOf}` : "";
			return `[${item.id}]${rollback} ${item.summary}\n${edits}\nExpected outcome: ${item.expectedOutcome}`;
		})
		.join("\n\n");
}

/**
 * Whether a JSON candidate ends mid-value: an unterminated string, or unclosed
 * objects/arrays. A reply cut off by an exhausted output budget is incomplete in
 * this sense, while a complete-but-malformed reply is balanced. Brace slicing can
 * also produce a balanced fragment, so callers treat "balanced" as malformed.
 */
function isIncompleteJson(candidate: string): boolean {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (const char of candidate) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") depth--;
	}
	return inString || depth > 0;
}

/** Short JSON escapes for the control characters that have one. */
const JSON_STRING_CONTROL_ESCAPES: Record<string, string> = {
	"\b": "\\b",
	"\t": "\\t",
	"\n": "\\n",
	"\f": "\\f",
	"\r": "\\r",
};

/**
 * Escape raw control characters that appear inside JSON string literals - the
 * shape a model produces when it writes a literal newline into a sentence, which
 * is common with multi-line content and makes JSON.parse reject an otherwise
 * complete reply. Structural whitespace outside strings is left untouched and
 * nothing else is rewritten: this is an escape pass, not a guess at intent.
 * Returns undefined when there is nothing to escape, so callers keep their
 * original diagnosis instead of a repair artifact.
 */
function escapeRawControlCharsInJsonStrings(candidate: string): string | undefined {
	let repaired = "";
	let inString = false;
	let escaped = false;
	let changed = false;
	for (const char of candidate) {
		if (escaped) {
			escaped = false;
			repaired += char;
			continue;
		}
		if (char === "\\") {
			escaped = inString;
			repaired += char;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			repaired += char;
			continue;
		}
		const code = char.codePointAt(0)!;
		if (inString && code < 0x20) {
			repaired += JSON_STRING_CONTROL_ESCAPES[char] ?? `\\u${code.toString(16).padStart(4, "0")}`;
			changed = true;
			continue;
		}
		repaired += char;
	}
	return changed ? repaired : undefined;
}

interface RepairedJson {
	value: unknown;
}

/**
 * Re-parse a candidate after escaping raw control characters in its string
 * literals, warning with the candidate digest so a recovered refinement can be
 * reconciled against what the model sent. Returns undefined when the candidate
 * needed no such repair or the repair did not make it parse.
 */
function parseWithControlCharRepair(candidate: string): RepairedJson | undefined {
	const repaired = escapeRawControlCharsInJsonStrings(candidate);
	if (repaired === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(repaired);
		console.warn(
			`refinement JSON recovered by escaping raw control characters inside string literals (candidate sha256 ${sha256Hex(candidate)})`,
		);
		return { value };
	} catch {
		return undefined;
	}
}

function parseJsonCandidate(candidate: string): unknown {
	try {
		return JSON.parse(candidate);
	} catch (error) {
		// A truncated reply and a malformed one both fail here, and JSON.parse
		// describes the fragment rather than the cause. Name the cause instead.
		if (isIncompleteJson(candidate)) {
			throw new Error(TRUNCATED_JSON_ERROR);
		}
		// A complete reply can still be unparseable for one mechanical reason: raw
		// control characters in string literals. Repair exactly that, and only that.
		const repaired = parseWithControlCharRepair(candidate);
		if (repaired) return repaired.value;
		throw new Error(`the model did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		// A reply truncated after a nested closing brace still looks well-formed
		// here, so this path needs the same diagnosis as the slicing fallback.
		return parseJsonCandidate(trimmed);
	}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) {
		return parseJsonCandidate(fenced[1].trim());
	}
	// Brace slicing recovers JSON wrapped in prose. On a reply truncated inside the
	// edits array it slices to an earlier edit's closing brace, so a failure here
	// is diagnosed against the original text rather than the balanced fragment.
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) {
		const fragment = trimmed.slice(start, end + 1);
		try {
			return JSON.parse(fragment);
		} catch {
			// The balanced fragment is the only part of a prose-wrapped reply that can
			// parse, so offer the control-character repair that same candidate before
			// diagnosing the whole (possibly truncated) text.
			const repaired = parseWithControlCharRepair(fragment);
			if (repaired) return repaired.value;
			return parseJsonCandidate(trimmed.slice(start));
		}
	}
	if (isIncompleteJson(trimmed)) {
		throw new Error(TRUNCATED_JSON_ERROR);
	}
	throw new Error("Refiner did not return a JSON object");
}

/**
 * Split an id the refiner copied from the overview, where every entry is shown
 * as `[global:foo]`. The bare id is what the stores are keyed by; the prefix is
 * routing information (M5). The verbatim bracketed form (and clipped variants
 * missing one bracket) is accepted too (MV-1): copying the displayed token is
 * the natural move, and it used to fall back to "entry not found" or mint a
 * literal `[global:foo]` id on create.
 */
function stripScopePrefix(id: string): { id: string; scope?: HarnessScope } {
	const match = SCOPE_PREFIX_PATTERN.exec(id);
	if (!match) return { id };
	// A copied token may still carry the overview's closing bracket.
	let bare = id.slice(match[0].length);
	if (bare.endsWith("]")) bare = bare.slice(0, -1);
	return { id: bare, scope: match[1] as HarnessScope };
}

/**
 * Normalizes an untrusted refinement proposal while preserving invalid edit
 * fields for apply-time validation.
 */
export function normalizeRefinementProposal(value: unknown): RefinementProposal {
	const record =
		typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const edits = Array.isArray(record.edits) ? record.edits : [];
	return {
		summary: typeof record.summary === "string" ? record.summary : "Refined continual harness state",
		rationale: typeof record.rationale === "string" ? record.rationale : "",
		expectedOutcome: typeof record.expectedOutcome === "string" ? record.expectedOutcome : "",
		edits: edits
			.filter((edit): edit is Record<string, unknown> => typeof edit === "object" && edit !== null)
			.map((edit) => {
				const bareId = typeof edit.id === "string" ? stripScopePrefix(edit.id) : undefined;
				return {
					action: edit.action as RefinementAction,
					kind: edit.kind as RefinementKind,
					id: bareId?.id,
					idScope: bareId?.scope,
					title: typeof edit.title === "string" ? edit.title : undefined,
					content: typeof edit.content === "string" ? edit.content : undefined,
					path: typeof edit.path === "string" ? edit.path : undefined,
					reference: objectRecord(edit.reference),
					arguments: objectRecord(edit.arguments),
					metadata:
						typeof edit.metadata === "object" && edit.metadata !== null && !Array.isArray(edit.metadata)
							? (edit.metadata as Record<string, unknown>)
							: undefined,
					reason: typeof edit.reason === "string" ? edit.reason : undefined,
				};
			}),
	};
}

/**
 * Parse a model reply into a JSON object, preserving the raw output when that
 * fails so a dropped refinement stays auditable.
 */
function parseModelJsonObject(
	text: string,
	source: RefinementFailureSource,
	objectError: string,
): Record<string, unknown> {
	let value: unknown;
	try {
		value = extractJsonObject(text);
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(objectError);
		}
	} catch (error) {
		recordRefinementFailure(text, error, { source, reason: "parse" });
		throw error;
	}
	return value as Record<string, unknown>;
}

/**
 * A proposal whose `edits` field is present but is not a list of edit objects
 * applies zero edits while looking like a successful, empty refinement. Keep the
 * reply as evidence: that is exactly the case that used to leave no record at
 * all (M6).
 */
function malformedEditsError(edits: unknown): Error | undefined {
	if (edits === undefined) return undefined;
	if (!Array.isArray(edits)) {
		return new Error(
			`the refiner returned \`edits\` as ${edits === null ? "null" : typeof edits} instead of a list, so no edit could be applied`,
		);
	}
	const badIndex = edits.findIndex((edit) => typeof edit !== "object" || edit === null || Array.isArray(edit));
	if (badIndex === -1) return undefined;
	return new Error(
		`the refiner returned \`edits[${badIndex}]\` as ${edits[badIndex] === null ? "null" : typeof edits[badIndex]} instead of an edit object, so no edit could be applied`,
	);
}

function parseProposal(text: string): RefinementProposal {
	const record = parseModelJsonObject(text, "refinement", "Refiner JSON must be an object");
	const malformed = malformedEditsError(record.edits);
	if (malformed) {
		// Recorded, not thrown: the tolerant normalization below already turns this
		// into "no applied edits", and the caller shows that. What was missing was
		// the evidence that the proposal was dropped for a reason.
		recordRefinementFailure(text, malformed, { source: "refinement", reason: "malformed-proposal" });
	}
	return normalizeRefinementProposal(record);
}

function validateEdit(edit: RefinementEdit, computedId?: string): string | undefined {
	if (!["create", "update", "delete"].includes(edit.action)) {
		return `unsupported action ${String(edit.action)}`;
	}
	if (!["prompt", "memory", "skill", "subagent"].includes(edit.kind)) {
		return `unsupported kind ${String(edit.kind)}`;
	}
	if (edit.kind === "prompt" && (edit.id === "base_system_prompt" || computedId === "base_system_prompt")) {
		return "base system prompt is not editable";
	}
	if (edit.action !== "create" && !edit.id) {
		return `${edit.action} requires id`;
	}
	if (edit.action !== "delete" && (!edit.title || !edit.content)) {
		return `${edit.action} requires title and content`;
	}
	if (edit.action !== "delete" && edit.kind === "skill" && edit.arguments === undefined) {
		return `${edit.action} skill requires arguments`;
	}
	if (edit.action !== "delete" && edit.kind === "skill") {
		const reference = edit.reference;
		if (!reference) {
			return `${edit.action} skill requires python reference`;
		}
		if (reference.type !== "python") {
			return `${edit.action} skill reference.type must be python`;
		}
		const hasImport =
			(typeof reference.import === "string" && reference.import.length > 0) ||
			(typeof reference.python_import === "string" && reference.python_import.length > 0);
		const hasCallable =
			(typeof reference.callable === "string" && reference.callable.length > 0) ||
			(typeof reference.call_pattern === "string" && reference.call_pattern.length > 0);
		if (!hasImport) {
			return `${edit.action} skill requires python import`;
		}
		if (!hasCallable) {
			return `${edit.action} skill requires callable or call_pattern`;
		}
	}
	return undefined;
}

export function applyRefinementProposal(
	state: HarnessState,
	proposal: RefinementProposal,
	options: { id: string; rollbackOf?: string; scope?: HarnessScope; baselineState?: HarnessState },
): RefinementResult {
	const appliedEdits: AppliedRefinementEdit[] = [];
	const proposalModifiedKeys = new Set<string>();
	for (const edit of proposal.edits) {
		// The overview shows every id with its store prefix (`[global:foo]`), and a
		// refiner that copies one is naming the other store, not inventing an id
		// (M5). Strip it here as well as at parse time so a directly constructed
		// proposal is diagnosed the same way.
		const stripped = edit.id === undefined ? undefined : stripScopePrefix(edit.id);
		const claimedScope = edit.idScope ?? stripped?.scope;
		const editId = stripped?.id ?? edit.id;
		const derivedId = editId ?? (edit.action === "create" ? slug(edit.title ?? edit.kind, edit.kind) : undefined);
		// Validate against the derived id first: a derived `base_system_prompt` must stay
		// blocked even when that id is already taken.
		const validationError = validateEdit(edit, derivedId ?? "");
		if (validationError) {
			appliedEdits.push({ ...edit, id: derivedId ?? "", applied: false, error: validationError });
			continue;
		}

		// An id copied from the overview with its store prefix names the other store:
		// refuse it with an actionable reason instead of letting it fall through to
		// "entry not found", which is what made the local/global split a trap (M5).
		// Creates are exempt: a fresh id cannot collide with an entry that lives
		// elsewhere, so the prefix is just formatting there.
		const targetScope = options.scope ?? "local";
		if (claimedScope && claimedScope !== targetScope && edit.action !== "create") {
			appliedEdits.push({
				...edit,
				id: derivedId ?? "",
				applied: false,
				error:
					`entry id "${derivedId ?? ""}" is prefixed [${claimedScope}:] in the harness overview, but this refinement targets the ` +
					`${targetScope} store: ask for a ${claimedScope} refinement (for example \`await refine.run(..., global_=True)\`) instead of a local one.`,
			});
			continue;
		}

		const records = state.entries[edit.kind];
		// An explicitly requested id keeps the original refuse-on-collision behavior; a
		// derived id is de-collided so two distinct titles cannot silently share one fact.
		const id =
			edit.id === undefined && edit.action === "create"
				? uniqueEntryId(records, derivedId ?? "", edit.title ?? edit.kind)
				: (derivedId as string);
		const before = cloneEntry(records[id]);
		const entryKey = `${edit.kind}:${id}`;
		const baseline = cloneEntry(options.baselineState?.entries[edit.kind][id]);
		if (
			options.baselineState &&
			!proposalModifiedKeys.has(entryKey) &&
			JSON.stringify(before) !== JSON.stringify(baseline)
		) {
			appliedEdits.push({
				...edit,
				id,
				before,
				applied: false,
				error: "entry changed during refinement planning",
			});
			continue;
		}
		if (edit.action === "delete") {
			if (!before) {
				appliedEdits.push({ ...edit, id, applied: false, error: "entry not found" });
				continue;
			}
			delete records[id];
			proposalModifiedKeys.add(entryKey);
			appliedEdits.push({ ...edit, id, before, applied: true });
			continue;
		}
		if (edit.action === "create" && before) {
			appliedEdits.push({ ...edit, id, before, applied: false, error: "entry already exists" });
			continue;
		}
		if (edit.action === "update" && !before) {
			appliedEdits.push({ ...edit, id, applied: false, error: "entry not found" });
			continue;
		}

		const createdAt = before?.created_at ?? now();
		const version = before ? before.version + 1 : 1;
		const after: HarnessEntry = {
			id,
			kind: edit.kind,
			title: edit.title ?? before?.title ?? id,
			content: edit.content ?? before?.content ?? "",
			path: edit.path ?? before?.path ?? "general",
			scope: before?.scope ?? options.scope ?? "local",
			reference: edit.reference ?? before?.reference ?? {},
			arguments: edit.arguments ?? before?.arguments ?? {},
			metadata: edit.metadata ?? before?.metadata ?? {},
			source: "refine",
			created_at: createdAt,
			updated_at: now(),
			version,
		};
		records[id] = after;
		proposalModifiedKeys.add(entryKey);
		appliedEdits.push({ ...edit, id, before, after: cloneEntry(after), applied: true });
	}

	const changes = appliedEdits.filter((edit) => edit.applied).map((edit) => `${edit.action} ${edit.kind}:${edit.id}`);
	state.refinements.push({
		id: options.id,
		trigger: proposal.summary,
		changes,
		evidence: proposal.rationale,
		outcome: proposal.expectedOutcome,
		created_at: now(),
	});

	return {
		id: options.id,
		summary: proposal.summary,
		rationale: proposal.rationale,
		expectedOutcome: proposal.expectedOutcome,
		appliedEdits,
		harnessStatePath: "",
		rollbackOf: options.rollbackOf,
		scope: options.scope,
	};
}

function rollbackProposal(target: RefinementResult): RefinementProposal {
	const edits: RefinementEdit[] = [];
	for (const edit of [...target.appliedEdits].reverse()) {
		if (!edit.applied) continue;
		if (edit.before) {
			edits.push({
				action: edit.after ? "update" : "create",
				kind: edit.kind,
				id: edit.id,
				title: edit.before.title,
				content: edit.before.content,
				path: edit.before.path,
				reference: edit.before.reference,
				arguments: edit.before.arguments,
				metadata: edit.before.metadata,
				reason: `Rollback ${target.id}`,
			});
		} else if (edit.after) {
			edits.push({
				action: "delete",
				kind: edit.kind,
				id: edit.id,
				reason: `Rollback ${target.id}`,
			});
		}
	}
	return {
		summary: `Rollback refinement ${target.id}`,
		rationale: `Restores continual harness state snapshots from refinement ${target.id}.`,
		expectedOutcome: "Faulty refinement edits are reverted.",
		edits,
	};
}

export function getRefinementHistory(entries: readonly CustomEntry[]): RefinementResult[] {
	return entries
		.filter((entry) => entry.customType === REFINEMENT_CUSTOM_TYPE)
		.map((entry) => entry.data)
		.filter((data): data is RefinementResult => {
			return typeof data === "object" && data !== null && "id" in data && "appliedEdits" in data;
		});
}

export interface RefinementPlan {
	proposal: RefinementProposal;
	id: string;
	rollbackOf?: string;
	rollbackScope?: HarnessScope;
	/** Target-scope state captured before planning, used to reject conflicting edits at apply time. */
	baselineState?: HarnessState;
}

/**
 * Produce a refinement proposal (the LLM pass, or a rollback proposal) without
 * mutating any harness state. Separated from {@link applyRefinementProposal} so
 * callers can re-read the harness file immediately before applying — the LLM call
 * here can take many seconds, during which the kernel or another session may write
 * the shared `harness_state.json`.
 */
/** Mint a refinement id in the canonical `refine_<timestamp>` format. */
export function generateRefinementId(): string {
	return `refine_${new Date()
		.toISOString()
		.replace(/[^0-9]/g, "")
		.slice(0, 17)}`;
}

export async function planRefinement(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	options: RefineOptions = {},
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<RefinementPlan> {
	const id = generateRefinementId();
	if (options.rollbackId) {
		const target = history.find((item) => item.id === options.rollbackId);
		if (!target) {
			throw new Error(`Refinement ${options.rollbackId} not found`);
		}
		const fallbackScope: HarnessScope = options.global ? "global" : "local";
		return {
			proposal: rollbackProposal(target),
			id,
			rollbackOf: target.id,
			rollbackScope: inferRefinementResultScope(target) ?? fallbackScope,
		};
	}

	const conversationText = serializeConversation(convertToLlm(messages)).slice(-80_000);
	const scopeInstruction = options.global
		? "Requested refinement scope: global. Only propose stable cross-session continual harness edits, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts that should affect future Prime Agent sessions. Do not persist session-only progress, temporary blockers, or current-run coordination globally."
		: "Requested refinement scope: local. Prefer local continual harness edits for current task progress, temporary blockers, current-run coordination, and project facts that are not clearly reusable across Prime Agent sessions. Global entries in the overview are read-only context: do not propose update or delete edits for them; create a local entry instead if an override is needed.";
	const userPrompt = [
		`<current_harness_state>\n${overviewForPrompt(state, options.global ? "global" : "local")}\n</current_harness_state>`,
		`<refinement_history>\n${historyForPrompt(history)}\n</refinement_history>`,
		`<conversation>\n${conversationText}\n</conversation>`,
		`<scope_policy>\n${scopeInstruction}\n</scope_policy>`,
		options.instructions ? `<user_refine_instructions>\n${options.instructions}\n</user_refine_instructions>` : "",
		"Return only JSON edits. If no useful edit is justified, return an empty edits array with a rationale.",
	]
		.filter(Boolean)
		.join("\n\n");

	// /refine requires a parseable JSON object in the final text. Some reasoning-capable
	// OpenAI-compatible models can spend the response on visible thinking and return no
	// final text, which makes otherwise successful daemon /refine calls fail parsing.
	// Keep the refinement request non-reasoning regardless of the interactive session
	// thinking level so the model uses its output budget for the JSON object.
	void thinkingLevel;
	const response = await completeSimple(
		model,
		{
			systemPrompt: REFINEMENT_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
		},
		{ maxTokens: refinementMaxOutputTokens(model), signal, apiKey, headers },
	);

	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");

	if (response.stopReason === "error") {
		// A provider error loses the proposal the same way a parse failure does, and
		// it used to leave no record at all: only parse and length were recorded, so
		// a refinement that never happened could not be explained afterwards (M6).
		const error = new Error(`Refinement failed: ${response.errorMessage || "Unknown error"}`);
		recordRefinementFailure(text, error, { source: "refinement", reason: "provider-error" });
		throw error;
	}
	if (response.stopReason === "length") {
		// An exhausted budget loses the proposal exactly like a parse failure does,
		// so keep the partial reply: it shows how far the model got.
		const error = new Error(`Refinement failed: ${TRUNCATED_JSON_ERROR}`);
		recordRefinementFailure(text, error, { source: "refinement", reason: "length" });
		throw error;
	}
	return { proposal: parseProposal(text), id };
}

function parseAutoRefineReview(text: string): AutoRefineReview {
	const record = parseModelJsonObject(text, "auto-refine-review", "Auto-refine review JSON must be an object");
	return {
		shouldRefine: record.shouldRefine === true,
		rationale: typeof record.rationale === "string" ? record.rationale : "No rationale provided.",
		instructions: typeof record.instructions === "string" ? record.instructions : undefined,
	};
}

export async function reviewAutoRefine(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	context: AutoRefineReviewContext,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<AutoRefineReview> {
	const conversationText = serializeConversation(convertToLlm(messages)).slice(-40_000);
	const userPrompt = [
		`<trigger>
${context.reason}; ${context.turnsSinceLastReview} assistant turns since last auto-refine review
</trigger>`,
		`<current_harness_state>
${overviewForPrompt(state, context.scope ?? "local")}
</current_harness_state>`,
		`<refinement_history>
${historyForPrompt(history)}
</refinement_history>`,
		`<conversation>
${conversationText}
</conversation>`,
		"Return shouldRefine=true when the trajectory contains evidence useful to this session's future turns. Prefer local harness edits for current task progress, temporary blockers, and current-run coordination. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified facts likely to be reused in future sessions.",
	].join("\n\n");
	// Auto-refine review requires parseable JSON. Keep it non-reasoning so
	// reasoning-capable models use final text budget for the JSON object.
	void thinkingLevel;
	const response = await completeSimple(
		model,
		{
			systemPrompt: AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
		},
		{ maxTokens: autoRefineReviewMaxOutputTokens(model), signal, apiKey, headers },
	);
	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	if (response.stopReason === "error") {
		const error = new Error(`Auto-refine review failed: ${response.errorMessage || "Unknown error"}`);
		recordRefinementFailure(text, error, { source: "auto-refine-review", reason: "provider-error" });
		throw error;
	}
	if (response.stopReason === "length") {
		const error = new Error(`Auto-refine review failed: ${TRUNCATED_JSON_ERROR}`);
		recordRefinementFailure(text, error, { source: "auto-refine-review", reason: "length" });
		throw error;
	}
	return parseAutoRefineReview(text);
}

export async function refineHarness(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	options: RefineOptions = {},
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<RefinementResult> {
	const plan = await planRefinement(messages, state, history, model, apiKey, options, headers, signal, thinkingLevel);
	return applyRefinementProposal(state, plan.proposal, {
		id: plan.id,
		rollbackOf: plan.rollbackOf,
		scope: plan.rollbackScope ?? (options.global ? "global" : "local"),
	});
}
