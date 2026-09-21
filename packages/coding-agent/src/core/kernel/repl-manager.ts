// Kernel client for the REPL runtime: the kernel is a JSON-lines subprocess
// (`python -m rlm.repl`) — requests on stdin, events on stdout, stderr relayed by the
// host into a per-session log file under a write budget. The in-memory side is two rings,
// so neither side can crowd the other out of a failure report: kernelStderr holds the
// kernel's own bytes, kernelDiagnostics the host's diagnostics only. The protocol is
// documented in prime-agent-runtime/src/rlm/repl.md.
import type { ChildProcess } from "node:child_process";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	openSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getLogger } from "@earendil-works/pi-ai";
import { v4 as uuid } from "uuid";
import { DEFAULT_SHORT_TARGET_WAIT_MS, withBound } from "../../utils/bounded-wait.js";
import { spawnHidden } from "../../utils/child-process.js";
import { assertRegularFileNoSymlink, ensurePrivateDirectory, requireNoFollow } from "../../utils/private-files.js";
import {
	ORPHAN_PROCESS_JOURNAL_ENV,
	reapKernelOrphanProcesses,
	recordOrphanProcessState,
} from "../orphan-process-journal.js";
import {
	DEFAULT_KERNEL_BASH_RESIDENCY_WARN_AGE_MS,
	kernelVouchedAlive,
	readKernelBashResidency,
	shouldRetainHeartbeatSample,
} from "../turn-liveness.js";
import { ensureKernelPython, KERNEL_PYTHON_SAFE_PATH_ARGS, managedKernelVenvDirForPython } from "./bootstrap.js";
import {
	classifyKernelExit,
	type KernelDeathCause,
	type KernelHostRequestFact,
	type KernelIntentionalExitOrigin,
	type KernelUnexpectedExitFacts,
} from "./death-cause.js";
import { KernelUnavailableError } from "./errors.js";
import { formatKernelResetNotice } from "./reset-notice.js";
import { KernelRestartLedger } from "./restart-ledger.js";
import {
	AGENT_MESSAGE_DISPLAY_MIME,
	ATTACHMENT_DISPLAY_MIME,
	createDeferred,
	createKernelStartupAbortError,
	DEFAULT_KERNEL_RESTART_WINDOW_MS,
	DEFAULT_MAX_OUTPUT_CHARS,
	DEFAULT_MAX_UNEXPECTED_RESTARTS,
	DEFAULT_SNAPSHOT_DEBOUNCE_MS,
	DIFF_DISPLAY_MIME,
	type ExecuteOptions,
	type ExecuteResult,
	errorMessage,
	HOST_REQUEST_SHUTDOWN_TIMEOUT_MS,
	installSignalHandlersOnce,
	isRecord,
	KERNEL_ABORT_GRACE_MS,
	KERNEL_BUSY_INTERRUPT_INTERVAL_MS,
	KERNEL_BUSY_REUSE_WAIT_MS,
	KERNEL_CAPABILITY_PRESERVE_NAMES,
	KERNEL_KILL_GRACE_MS,
	KERNEL_SHUTDOWN_TIMEOUT_MS,
	KERNEL_TERM_GRACE_MS,
	type KernelAttachment,
	KernelBusyAfterInterruptError,
	type KernelCapabilities,
	type KernelDiffDisplay,
	type KernelLiveness,
	type KernelLivenessSample,
	type KernelManagerOptions,
	type KernelRestartPolicy,
	type KernelRevivalVouch,
	type KernelSentAgentMessage,
	type KernelShutdownOptions,
	type KernelStartOptions,
	liveKernels,
	MAX_ATTACHMENT_DATA_CHARS,
	MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS,
	parseAttachmentDisplay,
	parseDiffDisplay,
	parseSentAgentMessage,
	raceStartupWithAbort,
	SNAPSHOT_EXECUTION_TIMEOUT_MS,
} from "./shared.js";
import {
	DEFAULT_SNAPSHOT_MAX_BYTES,
	DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
	isolateCorruptSnapshot,
	type RestoreResult,
	readSnapshotManifest,
	type SnapshotDroppedName,
	type SnapshotPolicyAfterPartialRestore,
	type SnapshotResult,
	type SnapshotWriteBlockReason,
	type SnapshotWritePolicy,
	snapshotWritePolicy,
} from "./state-snapshot.js";
import { claimKernelVenvBootSync, recordKernelVenvInUseSync, releaseKernelVenvInUseSync } from "./venv-in-use.js";

/** Newest kernel protocol this host speaks, and the one it asks the kernel for. */
const kernelLog = getLogger("coding-agent.kernel");

const REPL_PROTOCOL_VERSION = 4;
/**
 * Oldest kernel protocol this host still serves. The handshake is a range, not an
 * exact match: a venv whose runtime predates a protocol addition reports the older
 * value and the session runs with that feature gated off, instead of failing to boot.
 */
const REPL_PROTOCOL_VERSION_MIN = 3;
/** Protocol that introduced gated frames (heartbeat, snapshot `preserve_names`). */
const KERNEL_PROTOCOL_V4 = 4;
/**
 * Negotiation variable. The host only sets it when nobody else did, so
 * `export PRIME_AGENT_KERNEL_PROTOCOL=3` stays a working rollback for every gated
 * feature.
 */
const KERNEL_PROTOCOL_ENV_VAR = "PRIME_AGENT_KERNEL_PROTOCOL";
/**
 * Frame kinds that only a kernel which negotiated at least this protocol may send. Kept apart
 * from PROTOCOL_EVENT_KINDS so the gate is visible at the check site: a host treats a kind it
 * does not know as corruption and repairs (kills) the kernel, so accepting a gated kind from a
 * kernel that negotiated below it is exactly the mixed-version failure the gate prevents.
 */
const GATED_EVENT_KIND_MIN_PROTOCOL: Readonly<Record<string, number>> = {
	heartbeat: KERNEL_PROTOCOL_V4,
};
/**
 * The heartbeat's period and staleness threshold are not this file's to declare: the kernel reports
 * its own period on every frame (`interval_ms`, merged into each sample), and the host mirrors both
 * values exactly once, in `turn-liveness.ts` (`FALLBACK_HEARTBEAT_INTERVAL_MS`,
 * `DEFAULT_STALE_AFTER_INTERVALS`). The copies that used to live here were exported and imported by
 * nobody, so they read as configuration while nothing could read them; a reader that needs either
 * number takes it from turn-liveness, never from a second definition.
 */
/** Retained samples: enough to diff progress, few enough to stay O(1). */
const KERNEL_LIVENESS_MAX_SAMPLES = 2;
/** Rejection streaks are logged at 1 and then every N, so a broken runtime cannot flood the log. */
const KERNEL_LIVENESS_REJECT_LOG_EVERY = 50;
/**
 * Lifetime of a *positive* journal-backed bash count (T3). The count is cached against the
 * journal's identity (path, size, mtime), and identity alone is not quite a content key: a retire
 * and an enrol landing inside one mtime tick with equal line lengths leave both size and mtime
 * unchanged while the count they imply has changed. A positive count is the pinning direction, so
 * it self-heals on this cadence instead; the idle sweep runs 30 minutes apart and therefore always
 * reads a fact no older than this. The bound is per kernel and only paid when a reader asks, so the
 * cost is one small bounded read per kernel per TTL - far below the roster and summary cadence the
 * cache exists to survive.
 */
const KERNEL_BASH_RESIDENCY_CACHE_MS = 5_000;
/** One warn per gap for a handle old enough to be worth naming: visible, not chatty (T2②-2). */
const KERNEL_BASH_RESIDENCY_WARN_GAP_MS = 60 * 60 * 1000;
/**
 * Host-callback failures are reported at 1 and then every N, so one broken handler on a stream
 * that emits thousands of frames cannot flood the log - while the accumulated count on each
 * throttled line keeps the failure from being silent.
 */
const KERNEL_CALLBACK_FAILURE_LOG_EVERY = 25;
const READY_TIMEOUT_MS = 30_000;
const REPAIR_STEP_TIMEOUT_MS = 30_000;
/**
 * A restore that timed out is retried with this multiple of its budget (B5): a large snapshot
 * read cold from disk can legitimately outlast the repair budget, and the alternative - renaming
 * the payload aside - would destroy good state to answer a slow read.
 */
const RESTORE_RETRY_TIMEOUT_MULTIPLIER = 4;
// Runtime-minted host-request ids never repeat; the bound only guards a
// misbehaving runtime from growing the dedup set forever.
const MAX_HANDLED_HOST_REQUEST_IDS = 1024;
// Cap for unattributed background output buffered between and during cells.
const MAX_BACKGROUND_OUTPUT_CHARS = 64 * 1024;
// Largest legit frame is an attachment display event, base64 capped at
// MAX_ATTACHMENT_DATA_CHARS; a line that cannot complete within this ceiling is
// corruption the protocol repair owns, not output worth buffering until OOM.
const MAX_PROTOCOL_LINE_CHARS = 32 * 1024 * 1024;

const MAX_KERNEL_STDERR_CHARS = 8 * 1024;
const MAX_KERNEL_STDERR_LOG_BYTES = 5 * 1024 * 1024;
// Startup-failure report size, split so host diagnostics and the kernel's own tail each
// keep a quota and neither can crowd the other out of the window.
const MAX_KERNEL_STDERR_REPORT_CHARS = 1024;
const KERNEL_STDERR_HOST_TAIL_CHARS = 256;
// O_NONBLOCK degrades to 0 on win32 (as in private-files.ts): a no-op on regular files,
// but a planted FIFO then fails at once instead of blocking the event loop.
const NONBLOCK_FLAG = constants.O_NONBLOCK ?? 0;

// Written into the log once when the per-spawn write budget is spent; the handler keeps
// draining (and feeding the ring) after that, so a blocked pipe never wedges a pre-ready kernel.
const KERNEL_STDERR_LOG_BUDGET_MARKER = "[stderr log budget exhausted]\n";
// Owner-only file bits; kernel stderr can carry exception payloads.
// (The log's directory is handled by ensurePrivateDirectory, which enforces 0700.)
const KERNEL_STDERR_LOG_MODE = 0o600;

/** fs.writeSync may write fewer bytes than asked (partial ENOSPC, signals); loop until done. */
function writeFullySync(fd: number, data: Buffer): void {
	let offset = 0;
	while (offset < data.length) {
		offset += writeSync(fd, data, offset);
	}
}

/** One in-flight host request, with the facts the reset notice needs if the kernel dies. */
interface InFlightHostRequest {
	startedAt: number;
	type: string;
	label?: string;
}

/**
 * Whether the host declared one request type read-only, i.e. cancellable by the cell that
 * triggered it. An entry ending in `*` is a prefix pattern, which is how a whole read-only family
 * (`agent_observe.*`) is whitelisted without listing every member.
 */
export function hostRequestTypeIsCancellable(patterns: readonly string[] | undefined, type: string): boolean {
	if (!patterns || patterns.length === 0) return false;
	for (const pattern of patterns) {
		if (pattern.endsWith("*")) {
			if (type.startsWith(pattern.slice(0, -1))) return true;
			continue;
		}
		if (pattern === type) return true;
	}
	return false;
}

/** Type and human-readable target of one host request. Never throws on a malformed payload. */
function describeHostRequest(data: unknown): { type: string; label?: string } {
	if (!isRecord(data) || typeof data.type !== "string" || data.type.length === 0) {
		return { type: "unknown" };
	}
	const type = data.type;
	const label = hostRequestLabel(type, data);
	return label === undefined ? { type } : { type, label };
}

/** Best-effort target for the notice, so the model can tell two lost requests apart. */
function hostRequestLabel(type: string, data: Record<string, unknown>): string | undefined {
	const cap = (value: string): string => (value.length > 80 ? `${value.slice(0, 80)}...` : value);
	if (type === "rlm.run") {
		const kwargs = isRecord(data.kwargs) ? data.kwargs : {};
		return typeof kwargs.name === "string" && kwargs.name.length > 0 ? cap(`name=${kwargs.name}`) : undefined;
	}
	if (type === "agent_message.send") {
		const role = typeof data.receiver_role === "string" ? data.receiver_role : undefined;
		const name = typeof data.receiver_name === "string" ? data.receiver_name : undefined;
		if (role === "parent") return "receiver=parent";
		if (role && name) return cap(`receiver=${role}:${name}`);
	}
	return typeof data.target === "string" && data.target.length > 0 ? cap(`target=${data.target}`) : undefined;
}

/**
 * Appends one stream chunk under a per-cell character cap.
 *
 * The gate has to be closed (`>=`, as in the background-output path below): a chunk that lands
 * exactly on `maxChars` is stored, so under a strict `<` gate the *next* chunk fails the test
 * (`length === maxChars` is not `<`) and is dropped without ever raising the flag. The cell then
 * reports a complete, untruncated stream with its tail missing - the model cannot tell a short
 * answer from a cut-off one. An empty chunk on a full stream drops nothing, so it never raises
 * the flag.
 */
function capStreamOutput(current: string, text: string, maxChars: number): { text: string; truncated: boolean } {
	if (current.length >= maxChars) {
		return { text: current, truncated: text.length > 0 };
	}
	const appended = current + text;
	if (appended.length > maxChars) {
		return { text: appended.slice(0, maxChars), truncated: true };
	}
	return { text: appended, truncated: false };
}

/** ExecuteResult plus the raw fields of the request's `done` event (state ops). */
interface InternalExecuteResult extends ExecuteResult {
	doneFields?: Record<string, unknown>;
}

interface ActiveExecution {
	requestId: string;
	/** Source of the cell currently executing; surfaced to rlm.run spawns. */
	code: string;
	started: number;
	maxChars: number;
	opts: ExecuteOptions;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	result?: string;
	diffs: KernelDiffDisplay[];
	attachments: KernelAttachment[];
	sentAgentMessages: KernelSentAgentMessage[];
	/** Stream text without this execution's id: user threads, other cells' leftovers, raw fd writes. */
	backgroundOutput: string;
	backgroundOutputTruncated: boolean;
	error?: ExecuteResult["error"];
	status: ExecuteResult["status"];
	doneFields?: Record<string, unknown>;
	settled: boolean;
	resolve: (result: InternalExecuteResult) => void;
	reject: (error: Error) => void;
}

// Complete event vocabulary this host accepts (see prime-agent-runtime/src/rlm/repl.md).
// An unlisted kind is corruption, not a newer runtime: a kernel never sends frames above
// the version it negotiated, so a kind introduced by a future protocol must land here
// together with its negotiation gate (KERNEL_PROTOCOL_V4).
const PROTOCOL_EVENT_KINDS = new Set([
	"ready",
	"stdout",
	"stderr",
	"result",
	"display",
	"host_request",
	"error",
	"done",
	"heartbeat",
]);

/**
 * Reason a JSON object still isn't a valid protocol frame, or undefined.
 * `done` and `host_request` route strictly by non-empty string id (the runtime
 * mints uuid hex ids and echoes the host's uuids); silently dropping an id-less
 * one would leave the awaiting request unsettled forever.
 *
 * `protocol` is the version this kernel negotiated (undefined until its ready frame). A gated
 * kind below its version is corruption: the only thing that can produce one is a runtime that
 * ignores the negotiation gate, and continuing to trust such a runtime's other frames is worse
 * than repairing it. Note this is the *kind* gate only - a well-formed kind carrying bad field
 * values is rejected and counted by the handler instead, never escalated here.
 */
function invalidProtocolFrameReason(event: Record<string, unknown>, protocol: number | undefined): string | undefined {
	if (typeof event.event !== "string" || !PROTOCOL_EVENT_KINDS.has(event.event)) {
		return "unknown protocol event";
	}
	const minProtocol = GATED_EVENT_KIND_MIN_PROTOCOL[event.event];
	if (minProtocol !== undefined && (protocol === undefined || protocol < minProtocol)) {
		return `${event.event} frame from a kernel that negotiated protocol ${protocol ?? "nothing yet"}`;
	}
	if (
		(event.event === "done" || event.event === "host_request") &&
		(typeof event.id !== "string" || event.id === "")
	) {
		return `${event.event} frame without id`;
	}
	return undefined;
}

/** Heartbeat counter fields; every one must be a non-negative integer. */
const HEARTBEAT_COUNTER_FIELDS = [
	"tick",
	"cpu_ms",
	"stream_bytes",
	"cells_done",
	"host_requests",
	"interval_ms",
] as const;
/** Heartbeat bash-fact fields, inside the frame's `bash` object. */
const HEARTBEAT_BASH_FIELDS = ["handles", "cell_handles", "buffered_bytes", "pipe_pending"] as const;

function isCounterField(value: unknown): boolean {
	// Number.isInteger rejects NaN and Infinity, which a JSON literal (`1e999`) can still carry.
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Why one heartbeat frame is unacceptable, or undefined. Field validation lives here rather than
 * in `invalidProtocolFrameReason` because the answer is different: a malformed liveness frame is
 * rejected and counted, never escalated into killing the kernel it is describing (B8).
 */
function heartbeatFrameProblem(event: Record<string, unknown>): string | undefined {
	for (const field of HEARTBEAT_COUNTER_FIELDS) {
		if (!isCounterField(event[field])) {
			return `heartbeat field ${field} is not a non-negative integer`;
		}
	}
	if (event.interval_ms === 0) {
		return "heartbeat field interval_ms must be positive";
	}
	const bash = event.bash;
	if (!isRecord(bash)) {
		return "heartbeat field bash is not an object";
	}
	for (const field of HEARTBEAT_BASH_FIELDS) {
		if (!isCounterField(bash[field])) {
			return `heartbeat field bash.${field} is not a non-negative integer`;
		}
	}
	const id = event.id;
	if (id !== null && id !== undefined && (typeof id !== "string" || id === "")) {
		return "heartbeat field id is neither a non-empty string nor null";
	}
	// Additive and optional: a runtime that predates the finishing-phase marker omits it.
	if (event.finishing !== undefined && typeof event.finishing !== "boolean") {
		return "heartbeat field finishing is not a boolean";
	}
	return undefined;
}

/** Build the retained sample for a frame that passed {@link heartbeatFrameProblem}. */
function heartbeatSample(event: Record<string, unknown>, receivedAt: number): KernelLivenessSample {
	const bash = event.bash as Record<string, number>;
	const id = event.id;
	return {
		receivedAt,
		tick: event.tick as number,
		intervalMs: event.interval_ms as number,
		...(typeof id === "string" && id.length > 0 ? { cellId: id } : {}),
		...(event.finishing === true ? { finishing: true } : {}),
		cpuMs: event.cpu_ms as number,
		streamBytes: event.stream_bytes as number,
		cellsDone: event.cells_done as number,
		hostRequests: event.host_requests as number,
		bashHandles: bash.handles,
		bashCellHandles: bash.cell_handles,
		bashBufferedBytes: bash.buffered_bytes,
		bashPipePending: bash.pipe_pending,
	};
}

/**
 * Whether a raw line that failed to parse was meant to be a heartbeat. A non-finite number
 * (`NaN`, `Infinity`) is legal Python json but not legal JSON, so a runtime that lost its strict
 * serialization gate produces a line JSON.parse rejects: that has to cost one frame, not the
 * kernel (B8), which means recognizing it before the corruption path can claim it.
 */
function isHeartbeatLine(line: string): boolean {
	return /^\{\s*"event"\s*:\s*"heartbeat"/.test(line);
}

/**
 * Protocol version to request from the kernel: the newest this host speaks, unless the
 * caller or the environment already pinned one. Never override an explicit value —
 * `PRIME_AGENT_KERNEL_PROTOCOL=3` is the rollback lever for every gated feature.
 */
function requestedKernelProtocol(optionEnv: Record<string, string> | undefined): string {
	return optionEnv?.[KERNEL_PROTOCOL_ENV_VAR] ?? process.env[KERNEL_PROTOCOL_ENV_VAR] ?? String(REPL_PROTOCOL_VERSION);
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asReasonArray(value: unknown): { name: string; reason: string }[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (isRecord(entry) && typeof entry.name === "string") {
			return [{ name: entry.name, reason: typeof entry.reason === "string" ? entry.reason : "" }];
		}
		return [];
	});
}

export class ReplKernelManager {
	private readonly options: Pick<
		KernelManagerOptions,
		| "python"
		| "cwd"
		| "env"
		| "sessionId"
		| "hostHandlers"
		| "pythonSkills"
		| "snapshot"
		| "bootstrapCode"
		| "stderrLogPath"
		| "onUnexpectedExit"
		| "onSnapshotFailure"
		| "restartPolicy"
		| "cancellableHostRequestTypes"
		| "readOnlyHostRequestTimeoutMs"
		| "onLateHostReply"
	>;
	private readonly handledHostRequestIds = new Set<string>();
	private child?: ChildProcess;
	/** Reference file pinning this kernel's bootstrap generation directory; released by every teardown. */
	private inUseReferencePath?: string;
	private readyDeferred?: ReturnType<typeof createDeferred<number>>;
	/** Set by the ready handshake, cleared by every teardown; see {@link kernelCapabilities}. */
	private negotiatedCapabilities?: KernelCapabilities;
	/** Capability tokens from the current child's ready frame; empty until it arrives. */
	private announcedKernelCapabilities: string[] = [];
	/**
	 * Protocol the current child announced in its `ready` frame, captured synchronously by the
	 * frame loop. `negotiatedCapabilities` is only assigned once `waitForReady` has resolved, so a
	 * gated frame that shares the ready frame's stdout chunk would otherwise be judged against
	 * "nothing negotiated yet" - and a healthy kernel killed for the host's own read latency.
	 * Cleared with the negotiation on every teardown; the range check in `doStart` still owns
	 * whether the announcement is acceptable.
	 */
	private readyAnnouncedProtocol?: number;
	/** The kernel's own stderr bytes, decoded incrementally. Cleared on every wireChild. */
	private kernelStderr = "";
	/**
	 * The host's own narrative (`[kernel] …` diagnostics), kept out of kernelStderr so that
	 * neither side can crowd the other out of a failure report: a 30s pre-ready spew must not
	 * evict the reason the host gave up, and a long diagnostic must not evict the traceback.
	 */
	private kernelDiagnostics = "";
	/** Serializes execute() calls — the runtime runs one request at a time. */
	private executionQueue: Promise<unknown> = Promise.resolve();
	private activeExecution?: ActiveExecution;
	private readonly activeExecutionIdleWaiters = new Set<() => void>();
	private readonly lateSentAgentMessageHandlers = new Map<string, (message: KernelSentAgentMessage) => void>();
	/** Resolvers for done events outside the active execution (the shutdown reply). */
	private readonly pendingDoneWaiters = new Map<string, () => void>();
	// Source of the most recently started cell, retained after it finishes so
	// rlm.run spawns from detached asyncio tasks (cell already idle) can still
	// attribute their spawning program.
	private lastCellCode?: string;
	/** Unattributed stream text that arrived between cells; surfaced on the next execution. */
	private pendingBackgroundOutput = "";
	private pendingBackgroundOutputTruncated = false;
	/**
	 * In-flight host requests, valued with the epoch ms each one started at: the vouch bounds a
	 * request's age, so a handler that wedged stops excusing silence instead of vouching for the
	 * whole exemption budget.
	 */
	private readonly inFlightHostRequests = new Map<Promise<void>, InFlightHostRequest>();
	/** Retained heartbeat samples, newest first; at most KERNEL_LIVENESS_MAX_SAMPLES of them. */
	private readonly livenessSamples: KernelLivenessSample[] = [];
	/** Heartbeat frames rejected for a bad shape. Counted, never fatal (B4/B8). */
	private rejectedHeartbeatFrames = 0;
	private consecutiveRejectedHeartbeatFrames = 0;
	/** Well-formed frames dropped for arriving inside the minimum sample gap. */
	private throttledHeartbeatFrames = 0;
	/**
	 * Last journal-backed bash residency read, keyed on the journal identity it came from. An
	 * unchanged file costs one `statSync`; a positive count is re-probed on a TTL as well, because
	 * the fact it caches can go stale without the file changing (a handle killed without retiring
	 * its record).
	 */
	private journaledBashHandlesCache?: {
		path: string;
		kernelPid: number;
		size: number;
		mtimeMs: number;
		count: number;
		readAt: number;
	};
	/** Last time an age-capped bash handle was reported; one warn per gap, not per read. */
	private lastBashResidencyWarnAt = 0;
	/**
	 * Host callbacks and frame handling contained so far this episode. A callback runs inside a
	 * stdout "data" handler, so an exception escaping it is an uncaught exception - which the
	 * daemon worker turns into `process.exit(1)` for every session it hosts. They are counted,
	 * reported, and never allowed to reach the loop (P2-1).
	 */
	private containedCallbackFailures = 0;
	/** Failed reads of the host's restart policy; reported on every failure (a per-cell path). */
	private restartPolicyFailures = 0;
	/** Aborts every in-flight host request (e.g. admitted rlm.run children) on teardown. */
	private hostRequestController = new AbortController();
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";
	/** Bumped by every teardown so a stale in-flight doStart can never touch a newer kernel. */
	private startGeneration = 0;
	/** Generation whose graceful shutdown() owns the teardown, so the exit handler must not run it. */
	private gracefulShutdownGeneration?: number;
	/**
	 * Set immediately before an intentional kill and read by the exit callback, so a kernel the
	 * host killed on purpose is never attributed as a crash (B6/I-1). `state` cannot serve here:
	 * `killChildToIdle` restores it to `"idle"` before it returns, and `cleanupResources` bumps
	 * `startGeneration`, so both auxiliary facts are already stale by the time the exit lands.
	 */
	private intentionalExitOrigin?: KernelIntentionalExitOrigin;
	/** Set by shutdown()/kill()/disposeSync(): the host declared this kernel gone for good. */
	private disposedByHost = false;
	/**
	 * Epoch ms when the current reprovisioning window opened, or undefined outside one.
	 *
	 * `armReprovisionWindow()` is the single place that opens it and the single place that arms
	 * `pendingRestore`, so the snapshot write block and the revival vouch can never disagree about
	 * whether a namespace is still owed (L10.4). The window outlives that flag on purpose: the
	 * runtime bootstrap runs after the restore lands, and it is the long part.
	 */
	private reprovisionWindowSince?: number;
	/**
	 * Every unexpected exit inside the budget window, oldest first, plus the notice the next
	 * model-reaching cell owes (C8). Shared with the owner that replaces this instance after a
	 * failed startup, so a death counted here is still counted by the manager that serves the
	 * next cell - see {@link KernelRestartLedger}.
	 */
	private readonly restartLedger: KernelRestartLedger;
	/** Outcome of the most recent restore attempt pair, folded into the notice on consumption. */
	private lastRestoreResult?: RestoreResult | null;
	private lastRestoreTimedOut = false;
	/** The last restore needed the longer retry window because its first attempt timed out. */
	private lastRestoreRetried = false;
	/** Unattributed output the dying cell had collected; re-surfaced on the next cell. */
	private dyingBackgroundOutput?: string;
	private dyingBackgroundOutputTruncated = false;
	/** A restore timed out and was not retried successfully: the payload is intact but still owed. */
	private restoreTimedOut = false;
	private gracefulShutdownPromise?: Promise<boolean>;
	/** Memoized so concurrent callers all await the same in-flight startup. */
	private startPromise?: Promise<void>;
	/** Pending debounced auto-snapshot, if one has been scheduled. */
	private snapshotTimer?: ReturnType<typeof globalThis.setTimeout>;
	/** While the final dispose snapshot is flushing, new external executions are rejected. */
	private flushingSnapshotForDispose = false;
	/** In-flight final snapshot flush; concurrent teardowns join it instead of re-flushing. */
	private snapshotFlushForDispose?: Promise<void>;
	/** Repairs a child whose dedicated protocol stream emitted an invalid frame. */
	private protocolRepairPromise?: Promise<void>;
	private protocolRepairOwner?: { superseded: boolean };
	/** Corruption seen while still "starting" (e.g. ready and garbage in one chunk) fails that start. */
	private startupProtocolError?: Error;
	/** A repair discarded its kernel: the next fresh start must re-run the runtime bootstrap. */
	private pendingRebootstrap = false;
	/** Restore the saved namespace on that fresh start too (false when the snapshot itself is the declared culprit). */
	private pendingRestore = false;
	/** A whole-payload load did not finish and the snapshot is still on disk under its real name —
	 * it could not be isolated, or a teardown interrupted the load: the namespace is older than
	 * that snapshot, so no snapshot write may overwrite it. A restore that loads the payload
	 * clears this flag, and so does isolating the file, which leaves nothing to protect. */
	private restoreWriteBlocked = false;
	/** Names the last restore could not revive. Later snapshots ask the runtime to carry their
	 * saved blobs over verbatim instead of banning every write; a fully successful restore, or
	 * isolating the payload, clears the set. */
	private readonly unrestoredNames = new Set<string>();
	/** Last skipped-write reason already sent to the session log, so a blocked session logs the
	 * state change once instead of once per cell. */
	private reportedSnapshotSkipReason?: SnapshotWriteBlockReason;
	/** Set while a snapshot-failure receipt has been sent and no write has succeeded since. */
	private reportedSnapshotFailure = false;
	/** Wall clock of the last successful snapshot write from this process, for the age the reset
	 * notice reports. The payload's manifest is the primary source; this covers a runtime that
	 * did not record a timestamp. */
	private lastSnapshotWrittenAt?: number;
	/** Names the last successful write reported it could not save (minus the ones carried over
	 * from an older payload). Recorded because the write-side report had no consumer at all, and
	 * used as the fallback when the manifest next to the payload cannot be read. */
	private lastSnapshotNotSaved: SnapshotDroppedName[] = [];
	private rebootstrapPromise?: Promise<boolean>;
	private teardownInFlight = 0;

	constructor(options: KernelManagerOptions) {
		this.options = {
			python: options.python,
			cwd: options.cwd,
			env: options.env,
			sessionId: options.sessionId,
			hostHandlers: options.hostHandlers,
			pythonSkills: options.pythonSkills,
			snapshot: options.snapshot,
			bootstrapCode: options.bootstrapCode,
			stderrLogPath: options.stderrLogPath,
			onUnexpectedExit: options.onUnexpectedExit,
			onSnapshotFailure: options.onSnapshotFailure,
			restartPolicy: options.restartPolicy,
			cancellableHostRequestTypes: options.cancellableHostRequestTypes,
			readOnlyHostRequestTimeoutMs: options.readOnlyHostRequestTimeoutMs,
			onLateHostReply: options.onLateHostReply,
		};
		this.restartLedger = options.restartLedger ?? new KernelRestartLedger();
	}

	get ownerSessionId(): string | undefined {
		return this.options.sessionId;
	}

	/** Protocol capabilities agreed at the ready handshake; undefined until ready. */
	get kernelCapabilities(): KernelCapabilities | undefined {
		return this.negotiatedCapabilities;
	}

	/** Protocol version the running kernel announced; undefined until ready. */
	get negotiatedProtocol(): number | undefined {
		return this.negotiatedCapabilities?.protocol;
	}

	/**
	 * Liveness facts from the kernel's heartbeat frames: the two newest samples plus the frame
	 * counters. Diagnostic and stall-watchdog only - a heartbeat never reaches a cell's output,
	 * `onStream`, or the model context. `latest` is absent until the first frame is accepted and
	 * forever absent for a kernel that negotiated protocol 3 (it sends none), which readers must
	 * treat as "no facts", never as "dead" and never as "vouched".
	 */
	get kernelLiveness(): KernelLiveness {
		const [latest, previous] = this.livenessSamples;
		return {
			...(this.negotiatedProtocol === undefined ? {} : { protocol: this.negotiatedProtocol }),
			...(latest ? { latest } : {}),
			...(previous ? { previous } : {}),
			rejectedFrames: this.rejectedHeartbeatFrames,
			consecutiveRejectedFrames: this.consecutiveRejectedHeartbeatFrames,
			throttledFrames: this.throttledHeartbeatFrames,
		};
	}

	/** Host requests the kernel is waiting on, counted by the side that owns answering them. */
	get hostRequestCount(): number {
		return this.inFlightHostRequests.size;
	}

	/**
	 * Age in ms of the oldest in-flight host request; undefined when none is in flight. Bounds how
	 * long one request may vouch for silence (a `run(uv)` with no timeout would otherwise hold the
	 * whole exemption budget).
	 */
	get hostRequestOldestAgeMs(): number | undefined {
		let oldest: number | undefined;
		for (const request of this.inFlightHostRequests.values()) {
			if (oldest === undefined || request.startedAt < oldest) oldest = request.startedAt;
		}
		if (oldest === undefined) return undefined;
		const now = Date.now();
		// A wall clock behind the request's start cannot measure its age: report no age,
		// which the liveness aggregate already treats as aged out (fail closed).
		if (now < oldest) return undefined;
		return Math.max(0, now - oldest);
	}

	/**
	 * Revival-window facts for the stall watchdog, or undefined outside a revival (B7/L10.4).
	 *
	 * The gate is the same flag the snapshot write policy reads, so the two predicates cannot
	 * disagree about whether a namespace is still owed. The window itself is narrower than the
	 * flag: it covers only the work this host is doing to bring the kernel back (spawn, restore,
	 * bootstrap) and closes the moment the replacement serves cells, so a kernel that is merely
	 * waiting for its next cell never excuses a silent turn. Age is the reader's bound.
	 */
	get revivalVouch(): KernelRevivalVouch | undefined {
		const since = this.reprovisionWindowSince;
		if (since === undefined) return undefined;
		const reviving =
			this.state === "starting" || this.rebootstrapPromise !== undefined || this.protocolRepairPromise !== undefined;
		if (!reviving) return undefined;
		return { since };
	}

	/**
	 * The one-shot notice describing the last revival, or undefined when there is nothing to
	 * report. `forCode` is the source of the cell about to receive it, which is what makes a
	 * repeated cell - the model's natural reaction to a lost kernel - say so out loud.
	 */
	consumeRestartNotice(forCode?: string): string | undefined {
		const pending = this.restartLedger.takePendingRestartNotice();
		if (!pending) return undefined;
		const { repeatedCellCode, ...facts } = pending;
		return formatKernelResetNotice({
			...facts,
			restore: this.lastRestoreResult,
			restoreTimedOut: this.lastRestoreTimedOut,
			restoreRetriedAfterTimeout: this.lastRestoreRetried,
			repeatedCell: forCode !== undefined && repeatedCellCode !== undefined && forCode === repeatedCellCode,
		});
	}

	/** Whether a cell is executing right now, from the host side of the request. */
	get hasActiveExecution(): boolean {
		return this.activeExecution !== undefined;
	}

	/** Kernel process id while the child is alive; scopes journaled bash facts to this kernel. */
	get kernelPid(): number | undefined {
		return this.child?.pid;
	}

	/**
	 * Whether this kernel owns a live `bash()` handle right now.
	 *
	 * Two fact sources, because neither alone is both fresh and complete:
	 *
	 * - The orphan-process journal, which is the fresh one. `bash()` enrols the child before it
	 *   returns (and fails closed when a configured journal cannot enrol it) and retires the record
	 *   when the handle exits, so this stays true while an *idle* kernel hosts a background script
	 *   and goes false the moment that script ends. Graded for a residency decision rather than a
	 *   vouch - pid-probed, age-warned, fail-open: see {@link readKernelBashResidency}.
	 * - The newest heartbeat frame, but only while that frame is still fresh. A runtime sends frames
	 *   only while a request is in flight (`_heartbeat_frame` returns nothing for an idle kernel), so
	 *   reading the newest frame alone distorts in *both* directions: a script that finished an hour
	 *   ago still rides the last in-flight window's count and pins its session forever, and a handle
	 *   spawned by a cell shorter than the frame interval never appears in any frame at all and is
	 *   missed. Kept as a source because a host with no journal configured still gets an attestation
	 *   from its own runtime, and a fresh attestation is worth exactly the window it covers.
	 *
	 * Fail-open (T2①): no journal, an unreadable journal, a kernel that is gone (`child` undefined,
	 * including the zombie shape where journal rows were never retired) or a stale frame all read as
	 * "no kernel work", which is the behaviour this getter had before the journal source existed. It
	 * never throws: the callers are an eviction sweep and a summary builder.
	 *
	 * Both residency layers downstream of this getter inherit the change, because both read it
	 * through `AgentSession.isKernelWorkInFlight`: the worker-local passivation snapshot carries it
	 * as its own term (`SessionPassivationSnapshot.hasLiveKernelWork`), and the whole-worker eviction
	 * on the supervisor side receives it inside the summary's existing `isSessionActive` field, which
	 * `summaryForActiveSession` folds from the same getter (daemon-session-list.ts). Fixing the
	 * getter's *reach* was the substantive half of r44 form A; wiring it into the passivation
	 * snapshot was the other half, and neither covers the worker layer without the other's carrier.
	 *
	 * Deliberately not folded into the session's `isBashRunning`, which reports the host's own bash
	 * tool (`_bashAbortControllers`): a kernel handle has a different owner, that set never sees it,
	 * and that field's meaning is already read by the UI. Folding it into `AgentSession.isSessionActive`
	 * is likewise forbidden - that getter feeds `waitForIdle`, RLM quiescence and goal continuation,
	 * where a background handle is not turn work and would park them forever.
	 */
	get isKernelBashRunning(): boolean {
		const kernelPid = this.child?.pid;
		if (kernelPid !== undefined && (this.journaledLiveBashHandles(kernelPid) ?? 0) > 0) return true;
		const latest = this.livenessSamples[0];
		if (latest === undefined || (latest.bashHandles ?? 0) <= 0) return false;
		return kernelVouchedAlive(this.kernelLiveness, Date.now()).state === "fresh";
	}

	/**
	 * Live `bash()` handles this kernel has in the orphan-process journal, or undefined when that
	 * source cannot speak (no journal configured for this host, or a read that failed).
	 *
	 * Cached against the journal's identity plus a TTL: the file is shared by this host and all of
	 * its kernels and is appended to on every spawn and exit, while the readers (summary builders,
	 * roster composition) run far more often than handles come and go, so an unchanged file costs one
	 * `statSync`. Identity is the fast path, not the whole key: a retire and an enrol inside one
	 * mtime tick can leave size and mtime both unchanged while the count they imply changed (T3), so
	 * every entry also expires on a TTL, in both directions - a stale positive would pin a session
	 * that has nothing running, and a stale zero would miss the handle this fact exists to see. The
	 * same TTL re-runs the pid probes behind a positive count, which is what retires a handle killed
	 * without ever writing its exit record (D33).
	 */
	private journaledLiveBashHandles(kernelPid: number): number | undefined {
		const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		if (!path) return undefined;
		let size: number;
		let mtimeMs: number;
		try {
			const stats = statSync(path);
			size = stats.size;
			mtimeMs = stats.mtimeMs;
		} catch {
			// A configured journal that does not exist has no active records in it: an enrolment
			// creates the file, so "no file" is a count of zero rather than a missing fact.
			return 0;
		}
		const now = Date.now();
		const cached = this.journaledBashHandlesCache;
		if (
			cached !== undefined &&
			cached.path === path &&
			cached.kernelPid === kernelPid &&
			cached.size === size &&
			cached.mtimeMs === mtimeMs &&
			now - cached.readAt < KERNEL_BASH_RESIDENCY_CACHE_MS
		) {
			return cached.count;
		}
		const facts = readKernelBashResidency(kernelPid);
		// Fail-open: an unreadable journal is "no fact", which leaves the heartbeat term in charge
		// and, failing that, the behaviour this getter had before the journal source existed.
		if (facts === undefined || "error" in facts) return undefined;
		// Attribution on the transition, not on the state (T2②-1): residency that blocks an eviction
		// has to be traceable to a handle count and an age, and a per-transition line is bounded by
		// how often handles come and go rather than by how often summaries are composed.
		const previousCount = cached?.kernelPid === kernelPid ? cached.count : undefined;
		if (previousCount !== facts.liveBashHandles) {
			const fields = {
				kernelPid,
				liveBashHandles: facts.liveBashHandles,
				...(facts.oldestLiveAgeMs === undefined ? {} : { oldestHandleAgeMs: facts.oldestLiveAgeMs }),
				journalProbedPids: facts.probed,
				probeCapped: facts.capped,
				sessionId: this.options.sessionId,
			};
			if (facts.liveBashHandles > 0) {
				kernelLog.info("kernel bash handles now hold this session resident", fields);
			} else if (previousCount !== undefined) {
				kernelLog.info("kernel bash residency released; the session is reclaimable again", fields);
			}
		}
		this.journaledBashHandlesCache = {
			path,
			kernelPid,
			size,
			mtimeMs,
			count: facts.liveBashHandles,
			readAt: now,
		};
		// Attribution (T2②): residency that outlives a day is legitimate but must not be silent, and
		// it is a warn only - the handle is alive, so nothing here releases the pin or evicts.
		const oldestAgeMs = facts.oldestLiveAgeMs;
		if (
			facts.liveBashHandles > 0 &&
			oldestAgeMs !== undefined &&
			oldestAgeMs >= DEFAULT_KERNEL_BASH_RESIDENCY_WARN_AGE_MS &&
			now - this.lastBashResidencyWarnAt >= KERNEL_BASH_RESIDENCY_WARN_GAP_MS
		) {
			this.lastBashResidencyWarnAt = now;
			kernelLog.warn("kernel bash handle is holding its session resident past the warn age", {
				kernelPid,
				liveBashHandles: facts.liveBashHandles,
				oldestHandleAgeMs: oldestAgeMs,
				journalProbedPids: facts.probed,
				probeCapped: facts.capped,
				sessionId: this.options.sessionId,
			});
		}
		return facts.liveBashHandles;
	}

	/**
	 * Accept one heartbeat frame as liveness evidence, or reject and count it.
	 *
	 * Rejection never escalates to `failProtocolFrame`: the heartbeat describes the kernel, and
	 * killing a kernel over one malformed diagnostic frame is the failure mode this channel exists
	 * to prevent (B8). Rejections are counted and logged, so a runtime that lost its strict
	 * serialization gate is loud rather than silently aging into the degraded path (B4).
	 */
	private recordHeartbeatFrame(event: Record<string, unknown>): void {
		const problem = heartbeatFrameProblem(event);
		if (problem) {
			this.rejectHeartbeatFrame(problem);
			return;
		}
		const now = Date.now();
		const latest = this.livenessSamples[0];
		if (latest && !shouldRetainHeartbeatSample(now, latest.receivedAt)) {
			// Well-formed, but too close to the retained sample to add a fact: keeping the newer
			// one out of the diff pair bounds the host's work no matter how fast a kernel sends.
			// The retained sample can age up to gap + interval, and kernelVouchedAlive sizes its
			// staleness threshold to never sit below that, so throttling cannot age a healthy
			// kernel into looking stale.
			this.throttledHeartbeatFrames++;
			return;
		}
		this.livenessSamples.unshift(heartbeatSample(event, now));
		if (this.livenessSamples.length > KERNEL_LIVENESS_MAX_SAMPLES) {
			this.livenessSamples.pop();
		}
		this.consecutiveRejectedHeartbeatFrames = 0;
	}

	private rejectHeartbeatFrame(reason: string): void {
		this.rejectedHeartbeatFrames++;
		this.consecutiveRejectedHeartbeatFrames++;
		const streak = this.consecutiveRejectedHeartbeatFrames;
		// First rejection of a streak is always logged; after that, once per N so a runtime that
		// broke its serializer cannot bury the stall diagnostics it is supposed to inform.
		if (streak !== 1 && streak % KERNEL_LIVENESS_REJECT_LOG_EVERY !== 0) return;
		kernelLog.warn("kernel heartbeat frame rejected", {
			reason,
			consecutiveRejectedFrames: streak,
			rejectedFrames: this.rejectedHeartbeatFrames,
			kernelPid: this.child?.pid,
			sessionId: this.options.sessionId,
		});
	}

	/**
	 * Run one host-supplied callback and contain what it throws.
	 *
	 * Every callback in this class belongs to somebody else (the tool framework's `onUpdate`, a
	 * session's message recorder, a UI renderer), and the ones on the frame path run inside a
	 * `child.stdout` "data" handler: an exception that escapes there is an uncaught exception, and
	 * the daemon worker's handler for that is `process.exit(1)` - one broken renderer taking every
	 * session the worker hosts with it (P2-1). Containing it costs the host one log line and never
	 * the kernel, the cell, or the frame's own bookkeeping, which is done before the callback runs.
	 */
	private invokeHostCallback(callback: string, invoke: () => void): void {
		try {
			invoke();
		} catch (error) {
			this.containCallbackFailure(callback, error);
		}
	}

	/** One contained callback failure: counted always, reported at 1 and then every N. */
	private containCallbackFailure(what: string, error: unknown): void {
		this.containedCallbackFailures++;
		const failures = this.containedCallbackFailures;
		if (failures !== 1 && failures % KERNEL_CALLBACK_FAILURE_LOG_EVERY !== 0) return;
		this.appendKernelDiagnostic(`kernel ${what} failed: ${errorMessage(error)} (${failures} contained so far)`);
		kernelLog.warn("kernel host callback failed", {
			callback: what,
			error: errorMessage(error),
			failures,
			kernelPid: this.child?.pid,
			sessionId: this.options.sessionId,
		});
	}

	/**
	 * The frame loop's own backstop. The callbacks inside it are contained individually, so this
	 * only fires on a host-side bug in the event handling itself - and even then the verdict is the
	 * same: drop the frame, keep the kernel, say so loudly (P2-1).
	 */
	private containEventHandlingFailure(event: Record<string, unknown>, error: unknown): void {
		const kind = typeof event.event === "string" ? event.event : "unknown";
		this.containedCallbackFailures++;
		const failures = this.containedCallbackFailures;
		if (failures !== 1 && failures % KERNEL_CALLBACK_FAILURE_LOG_EVERY !== 0) return;
		this.appendKernelDiagnostic(
			`kernel event handling failed for ${kind}: ${errorMessage(error)} (${failures} contained so far)`,
		);
		kernelLog.warn("kernel event handling failed", {
			event: kind,
			error: errorMessage(error),
			failures,
			kernelPid: this.child?.pid,
			sessionId: this.options.sessionId,
		});
	}

	private appendKernelDiagnostic(message: string): void {
		const text = `[kernel] ${message.endsWith("\n") ? message : `${message}\n`}`;
		this.kernelDiagnostics = (this.kernelDiagnostics + text).slice(-MAX_KERNEL_STDERR_CHARS);
	}

	private appendKernelStderrText(text: string): void {
		this.kernelStderr = (this.kernelStderr + text).slice(-MAX_KERNEL_STDERR_CHARS);
	}

	/**
	 * The runtime dup2's fd 2 into its protocol pump before ready (repl.py _setup_fds), so
	 * this file only ever receives pre-ready bytes, and the host is their single writer.
	 *
	 * The write budget is the file's remaining capacity, not a fresh allowance, so current
	 * file and `.old` each stay near MAX_KERNEL_STDERR_LOG_BYTES and per-session disk near
	 * 2x — even when rotation fails and the file is kept.
	 */
	private openStderrLog(): { fd: number; budget: number } | undefined {
		const path = this.options.stderrLogPath;
		if (!path) return undefined;
		try {
			ensurePrivateDirectory(dirname(path));
			const exists = existsSync(path);
			// Refuse a planted non-regular file before anything touches it: O_NOFOLLOW covers
			// symlinks only (and degrades to 0 on win32), and opening a FIFO O_WRONLY would
			// block the event loop right here, before the ready timeout is armed.
			if (exists) assertRegularFileNoSymlink(path);
			let size = exists ? statSync(path).size : 0;
			if (size > MAX_KERNEL_STDERR_LOG_BYTES) {
				try {
					// Tighten before the move: a renamed log keeps its mode, and the
					// rotated file holds the exception payloads worth protecting.
					chmodSync(path, KERNEL_STDERR_LOG_MODE);
					// Drop any prior .old first: rename fails on Windows if it exists.
					rmSync(`${path}.old`, { force: true });
					renameSync(path, `${path}.old`);
					size = 0;
				} catch (error) {
					// A failed rotation must not cost the log: keep appending instead.
					this.appendKernelDiagnostic(`cannot rotate kernel stderr log: ${errorMessage(error)}`);
				}
			}
			// Fork policy (#1249 private session files): 0600, and refuse a planted symlink.
			// openSync's mode only applies at creation and this log survives across spawns, so
			// re-assert the mode on the descriptor. requireNoFollow degrades to 0 on win32,
			// matching orphan-process-journal; O_NONBLOCK is a no-op on a regular file, but a
			// planted FIFO then fails at once instead of blocking the event loop.
			const fd = openSync(
				path,
				constants.O_WRONLY |
					constants.O_APPEND |
					constants.O_CREAT |
					requireNoFollow(constants.O_NOFOLLOW) |
					NONBLOCK_FLAG,
				0o600,
			);
			if (process.platform !== "win32") {
				// Exact bits despite the umask; tightens a pre-existing loose log. A failed
				// fchmod closes the descriptor so the outer catch cannot leak it.
				try {
					fchmodSync(fd, 0o600);
				} catch (error) {
					closeSync(fd);
					throw error;
				}
			}
			return { fd, budget: Math.max(0, MAX_KERNEL_STDERR_LOG_BYTES - size) };
		} catch (error) {
			this.appendKernelDiagnostic(`cannot open kernel stderr log: ${errorMessage(error)}`);
			return undefined;
		}
	}

	/**
	 * The failure-report window, split so host diagnostics and the kernel's own tail each keep
	 * a quota and neither can crowd the other out. The kernel part stays last because
	 * errors.ts renders the tail's final line to the model.
	 *
	 * No file read: the host is the log's single writer and fills kernelStderr before it checks
	 * the budget, so the ring holds the last bytes in every case — including past budget
	 * exhaustion, where the file's last bytes are the exhaustion marker rather than the truth.
	 */
	private stderrTail(): string {
		const hostTail = this.kernelDiagnostics.slice(-KERNEL_STDERR_HOST_TAIL_CHARS);
		const kernelTail = this.kernelStderr.slice(-(MAX_KERNEL_STDERR_REPORT_CHARS - KERNEL_STDERR_HOST_TAIL_CHARS));
		return `${hostTail}${kernelTail}`;
	}

	async start(options: KernelStartOptions = {}): Promise<void> {
		if (options.signal?.aborted) {
			throw createKernelStartupAbortError();
		}
		if (!this.startPromise) {
			const startPromise = this.doStart({
				onBootstrapProgress: options.onBootstrapProgress,
				// The bootstrap wait is the one part of a start that has no timeout of its own
				// beyond the lock bound, so it gets the caller's signal too.
				signal: options.signal,
			}).catch((error) => {
				// Only clear our own memoization: a stale start must not evict a newer one.
				if (this.startPromise === startPromise) this.startPromise = undefined;
				throw error;
			});
			this.startPromise = startPromise;
		}
		return raceStartupWithAbort(this.startPromise, options.signal);
	}

	private async doStart(startOptions: KernelStartOptions): Promise<void> {
		if (this.state !== "idle") return;
		// The ledger can already be spent when this instance is brand new: the deaths that spent it
		// belong to the manager this one replaced after a failed startup. Failing closed here is
		// what keeps a broken environment from spawning one more doomed kernel per cell (K-P1-1).
		if (this.restartBudgetExhaustedNow()) throw this.terminalRequestError();
		// A restarted kernel serves new host requests; the previous teardown's
		// abort must not poison them.
		if (this.hostRequestController.signal.aborted) {
			this.hostRequestController = new AbortController();
		}
		const generation = ++this.startGeneration;
		this.state = "starting";
		installSignalHandlersOnce();
		// Tracked from the moment startup begins so session cleanup and signal
		// handlers can dispose a kernel that is still booting.
		liveKernels.add(this);

		let python: string;
		try {
			python =
				this.options.python ??
				(await ensureKernelPython({
					pythonSkills: this.options.pythonSkills,
					onProgress: startOptions.onBootstrapProgress,
					signal: startOptions.signal,
				}));
			if (this.startStale(generation)) throw new Error("Kernel start superseded");
			this.options.python = python;
		} catch (error) {
			if (this.startStale(generation)) throw error; // never touch a newer start's state
			liveKernels.delete(this);
			if ((this.state as string) !== "shutdown") this.state = "idle";
			throw error;
		}

		if ((this.state as string) === "shutdown") {
			throw new Error("Kernel was disposed during startup");
		}

		// Claimed before the spawn, superseded by the reference recorded right after it (P2-2).
		const bootClaimPath = this.claimVenvForSpawn(python);
		// Safe path: the session cwd must never sit at sys.path[0], or a checkout could
		// substitute its own rlm/, dill.py, or stdlib-named module for the runtime's own
		// imports (symptom: "Kernel exited before ready", pointing nowhere near the real cause).
		// spawnHidden adds windowsHide so a windowless daemon worker does not flash a console.
		const child = spawnHidden(python, [...KERNEL_PYTHON_SAFE_PATH_ARGS, "-m", "rlm.repl"], {
			cwd: this.options.cwd,
			// bash.py journals its process groups under this pid so the host can reap them if
			// the runtime dies without running its shutdown hook.
			env: {
				...process.env,
				...this.options.env,
				// The runtime clamps this into the range it speaks and reports the negotiated
				// value in its ready frame; an older runtime ignores it.
				[KERNEL_PROTOCOL_ENV_VAR]: requestedKernelProtocol(this.options.env),
				...(process.platform === "win32" ? { PYTHONUTF8: "1" } : {}),
				PRIME_AGENT_KERNEL_OWNER_PID: String(process.pid),
			},
			// stderr is always a pipe: the host is the log's single writer, which is the only
			// place the write budget can be enforced. An fd handed to the child would leave
			// pre-ready spew bounded by nothing but the 30s ready timeout and disk speed.
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		// A fresh spawn owns its own exit: a marker left over from the previous teardown must not
		// excuse a real crash of this child.
		this.intentionalExitOrigin = undefined;
		if (child.pid !== undefined) {
			recordOrphanProcessState(child.pid, true);
			// Recording the kernel's own reference supersedes - removes - the claim above.
			this.inUseReferencePath = this.recordVenvInUseReference(child.pid);
		} else {
			// No pid means no reference will ever supersede it: drop the claim instead of pinning
			// the generation for this process's lifetime.
			releaseKernelVenvInUseSync(bootClaimPath);
		}
		this.readyDeferred = createDeferred<number>();
		this.startupProtocolError = undefined;
		this.readyAnnouncedProtocol = undefined;
		this.wireChild(child);

		try {
			const protocol = await this.waitForReady(child);
			if (this.startStale(generation)) throw new Error("Kernel start superseded");
			// Ready and a corrupt frame can share one stdout chunk: ready resolved the
			// deferred synchronously before the corruption was parsed, so the rejection
			// in failProtocolFrame was a no-op. Never mark such a child running.
			if (this.startupProtocolError) throw this.startupProtocolError;
			if (!Number.isInteger(protocol) || protocol < REPL_PROTOCOL_VERSION_MIN || protocol > REPL_PROTOCOL_VERSION) {
				throw new Error(
					`Kernel runtime speaks protocol ${protocol}, expected ${REPL_PROTOCOL_VERSION_MIN}-${REPL_PROTOCOL_VERSION}. ` +
						"Update prime-agent-runtime in the kernel Python (PRIME_AGENT_KERNEL_PYTHON) to match this prime-agent.",
				);
			}
			// Recorded only once the announcement passed the range check, so a rejected
			// handshake never leaves capabilities behind for a gated request to trust. Each
			// feature bit needs both the negotiated version and the kernel's own token: a
			// version number cannot tell a runtime that predates a request field from one
			// that honours it.
			this.negotiatedCapabilities = {
				protocol,
				protocol4: protocol >= KERNEL_PROTOCOL_V4,
				preserveNames:
					protocol >= KERNEL_PROTOCOL_V4 &&
					this.announcedKernelCapabilities.includes(KERNEL_CAPABILITY_PRESERVE_NAMES),
			};
		} catch (e) {
			// Both exits report through `startupFailureError`: a kernel that dies before it is ready
			// tears itself down first (which makes this start stale), so the budget fact would
			// otherwise never reach the cell that spent it (K-P1-1).
			// Never tear down a newer start's kernel.
			if (this.startStale(generation)) throw this.startupFailureError(e);
			const canRetryStartup = (this.state as string) !== "shutdown";
			// Only the call that performed the cleanup may resurrect to idle; a
			// concurrent kill()/teardown owns the state otherwise.
			if ((await this.shutdown()) && canRetryStartup) {
				// The teardown here is this failed start's own cleanup, not a host verdict: the
				// manager stays reusable, so it must also stay revivable.
				this.disposedByHost = false;
				this.state = "idle";
			}
			throw this.startupFailureError(e);
		}

		this.state = "running";
	}

	/**
	 * What one failed start reports. Once the shared restart budget is spent, the terminal fact
	 * replaces this attempt's own startup text ("Kernel exited before ready"): the model has to see
	 * the death chain and the two re-arm paths on the cell that failed closed, whichever phase the
	 * death landed in, or it keeps retrying an environment that cannot start (K-P1-1).
	 */
	private startupFailureError(startError: unknown): unknown {
		return this.restartBudgetExhaustedNow() ? this.terminalRequestError() : startError;
	}

	/** True when a teardown (or newer start) superseded the start that captured `generation`. */
	private startStale(generation: number): boolean {
		return generation !== this.startGeneration;
	}

	/**
	 * Pin the generation directory this kernel was spawned from, and return the path to release
	 * at teardown. Bootstrap never rebuilds, renames, or deletes a directory that still has a
	 * live reference, so a runtime identity change elsewhere on the machine cannot pull this
	 * kernel's modules out from under it. An interpreter outside a managed generation
	 * (PRIME_AGENT_KERNEL_PYTHON, a project venv) records nothing.
	 *
	 * A reference write that fails is not silent: the recorder leaves a tombstone in the same
	 * directory, which readers count as a reference and which marks the state unknown, so a
	 * rebuild defers instead of deleting. That is reported to the session log because the
	 * in-memory ring never leaves this process. If the tombstone could not be written either,
	 * the generation is unprotected and the log line is the only trace — the residual case.
	 */
	private recordVenvInUseReference(pid: number): string | undefined {
		const python = this.options.python;
		if (!python) return undefined;
		const venvDir = managedKernelVenvDirForPython(python);
		if (!venvDir) return undefined;
		const record = recordKernelVenvInUseSync(venvDir, { pid, sessionId: this.options.sessionId });
		if (record.unverified) {
			kernelLog.warn("kernel venv in-use reference unavailable", {
				venvDir,
				pid,
				reason: record.reason,
				tombstoneWritten: record.releasePath !== undefined,
				sessionId: this.options.sessionId,
			});
			this.appendKernelDiagnostic(
				`could not record a kernel venv in-use reference in ${venvDir}: ${record.reason ?? "unknown reason"}`,
			);
		}
		return record.releasePath;
	}

	/**
	 * Announce the spawn this manager is about to perform and return the claim's path (P2-2).
	 *
	 * A revival re-spawns from a generation whose previous reference was released with the dead
	 * kernel, so between that release and the new reference there is no pid pointing at the
	 * directory: a concurrent boot's sweep would read it as abandoned and could delete the
	 * interpreter this spawn is about to exec. The claim is superseded by the reference the spawn
	 * records, and swept by any reader once this process is provably gone. Best effort, like every
	 * other piece of this bookkeeping: an interpreter outside a managed generation claims nothing.
	 */
	private claimVenvForSpawn(python: string): string | undefined {
		const venvDir = managedKernelVenvDirForPython(python);
		if (!venvDir) return undefined;
		const claim = claimKernelVenvBootSync(venvDir, { pid: process.pid, sessionId: this.options.sessionId });
		if (claim.reason) {
			kernelLog.warn("kernel venv boot claim unavailable", {
				venvDir,
				reason: claim.reason,
				sessionId: this.options.sessionId,
			});
			this.appendKernelDiagnostic(
				`could not claim the kernel venv generation ${venvDir} before spawning: ${claim.reason}`,
			);
		}
		return claim.claimPath;
	}

	private wireChild(child: ChildProcess): void {
		// A newly wired child owns a fresh stderr window: the previous spawn's bytes must not
		// ride into this one's failure report. This replaces the per-spawn file offset the
		// fd-direct design needed; the host diagnostics ring is the host's own narrative and
		// deliberately spans spawns (restart() clears both).
		this.kernelStderr = "";
		const decoder = new StringDecoder("utf8");
		let buffered = "";
		// A poisoned child's residue must not grow the buffer again before the
		// protocol repair kills it.
		let poisoned = false;
		child.stdout?.on("data", (buf: Buffer) => {
			if (this.child !== child || poisoned) return;
			buffered += decoder.write(buf);
			if (buffered.length > MAX_PROTOCOL_LINE_CHARS) {
				poisoned = true;
				buffered = "";
				this.failProtocolFrame(child, `oversized protocol line: exceeds ${MAX_PROTOCOL_LINE_CHARS} chars`);
				return;
			}
			let newline = buffered.indexOf("\n");
			while (newline !== -1) {
				if (this.child !== child) return;
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
				if (!line.trim()) continue;
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					if (isHeartbeatLine(line)) {
						// A non-finite number is legal Python json but not legal JSON, so a runtime
						// that lost its strict serialization gate lands here. It was describing the
						// kernel's own health: cost one frame, never the kernel (B8).
						this.rejectHeartbeatFrame(`unparseable heartbeat line: ${line.slice(0, 200)}`);
						continue;
					}
					this.failProtocolFrame(child, `unparseable protocol line: ${line.slice(0, 200)}`);
					return;
				}
				if (!isRecord(event)) {
					this.failProtocolFrame(child, `non-object protocol line: ${line.slice(0, 200)}`);
					return;
				}
				// The announcement this child already made covers the frames that share its ready
				// chunk; the negotiated value only exists after the handshake has been validated.
				const invalidReason = invalidProtocolFrameReason(
					event,
					this.negotiatedProtocol ?? this.readyAnnouncedProtocol,
				);
				if (invalidReason) {
					this.failProtocolFrame(child, `${invalidReason}: ${line.slice(0, 200)}`);
					return;
				}
				try {
					this.handleEvent(event);
				} catch (error) {
					// Contained here rather than left to the "data" handler, where it would become
					// an uncaught exception and the daemon worker would exit(1) every session it
					// hosts. The remaining lines of this chunk are still processed (P2-1).
					this.containEventHandlingFailure(event, error);
				}
			}
		});

		// The runtime dup2's fd 2 into its protocol pump before ready (repl.py
		// _setup_fds), so this pipe only ever carries pre-ready bytes; the write
		// budget caps what lands on disk, and once it is spent the handler keeps
		// draining but discards (a blocked pipe would wedge a pre-ready kernel).
		const stderrLog = this.openStderrLog();
		const stderrDecoder = new StringDecoder("utf8");
		let stderrLogBudget = stderrLog?.budget ?? 0;
		let stderrLogWritable = stderrLog !== undefined;
		child.stderr?.on("data", (buf: Buffer) => {
			this.appendKernelStderrText(stderrDecoder.write(buf));
			if (!stderrLogWritable || stderrLog === undefined) return;
			try {
				if (buf.length <= stderrLogBudget) {
					writeFullySync(stderrLog.fd, buf);
					stderrLogBudget -= buf.length;
				} else {
					writeFullySync(stderrLog.fd, Buffer.from(KERNEL_STDERR_LOG_BUDGET_MARKER));
					stderrLogWritable = false;
				}
			} catch (error) {
				stderrLogWritable = false;
				this.appendKernelDiagnostic(`kernel stderr log write failed: ${errorMessage(error)}`);
			}
		});
		// A kernel that dies mid-character leaves bytes buffered in the decoder; flush them so
		// the tail keeps the truncated final character. Both events, because each can be the
		// only one to precede the tail build: 'end' beats 'exit' on natural EOF (whose 'close'
		// emission can land after it), while a drain-destroyed stream skips 'end'. The second
		// end() returns "".
		child.stderr?.once("end", () => this.appendKernelStderrText(stderrDecoder.end()));
		child.stderr?.once("close", () => {
			this.appendKernelStderrText(stderrDecoder.end());
			if (stderrLog === undefined) return;
			try {
				closeSync(stderrLog.fd);
			} catch (error) {
				this.appendKernelDiagnostic(`kernel stderr log close failed: ${errorMessage(error)}`);
			}
		});
		// A pipe write into a dead kernel surfaces as an 'error' event on the stream (write
		// EPIPE); without a listener Node rethrows it as an uncaught exception, and this
		// worker's crash handler turns that into process.exit(1) — taking every other session
		// the worker hosts with it. The pending writeLine rejection and the child 'exit'
		// handler below own the fallout, so this only records the diagnosis. Read-side pipe
		// errors on stdout/stderr land the same way and need the same guard.
		child.stdin?.on("error", (error) => {
			if (this.child !== child) return;
			this.appendKernelDiagnostic(`kernel stdin error: ${errorMessage(error)}`);
		});
		child.stdout?.on("error", (error) => {
			if (this.child !== child) return;
			this.appendKernelDiagnostic(`kernel stdout error: ${errorMessage(error)}`);
		});
		child.stderr?.on("error", (error) => {
			if (this.child !== child) return;
			this.appendKernelDiagnostic(`kernel stderr error: ${errorMessage(error)}`);
		});
		child.once("exit", () => {
			// One turn for the poll phase to deliver the bytes the kernel wrote
			// before dying (the pipe buffer bounds them), then destroy: EOF may
			// never come, and anything later is a surviving grandchild's
			// post-mortem noise, not the kernel's last words.
			globalThis.setImmediate(() => child.stderr?.destroy());
		});

		child.on("error", (err) => {
			if (this.child !== child) return;
			this.appendKernelDiagnostic(`spawn error: ${err.message}`);
			this.state = "shutdown";
			liveKernels.delete(this);
			// Fail a pending start() promptly instead of letting it ride out the
			// ready timeout. cleanupResources clears readyDeferred, so reject first;
			// a late error after ready resolved is a no-op on the settled promise.
			this.readyDeferred?.reject(err);
			this.cleanupResources();
		});

		child.on("exit", (code, signal) => {
			if (this.child !== child) return;
			// Attribution runs before any state mutation: the verdict needs the state this exit
			// interrupted, and the origin marker is single-use (the next spawn clears it too).
			const verdict = classifyKernelExit({
				intentionalOrigin: this.intentionalExitOrigin,
				gracefulShutdownOwned: this.gracefulShutdownGeneration === this.startGeneration,
				state: this.state,
				code,
				signal,
				stderrTail: this.stderrTail(),
				at: Date.now(),
			});
			this.intentionalExitOrigin = undefined;
			if (verdict.unexpected) {
				const facts = this.recordUnexpectedExit(verdict.cause);
				this.reportUnexpectedKernelExit(verdict.cause, child.pid, facts);
				if (facts.decision.revive) {
					this.armRevivalAfterUnexpectedExit(verdict.cause);
					return;
				}
			} else if (
				verdict.origin === "repair_kill" ||
				verdict.origin === "bootstrap_fail_kill" ||
				verdict.origin === "abort_timeout_kill"
			) {
				// Tagged, not silent: this is the only place a repair kill or an abort-timeout
				// kill can be told apart from a crash in the host's own ring, and B6 exists to
				// keep the two from mixing.
				this.appendKernelDiagnostic(`intentional ${verdict.origin} exit code=${code} signal=${signal}`);
			}
			this.state = "shutdown";
			liveKernels.delete(this);
			// This exit is part of an in-flight graceful shutdown(): that call owns the
			// teardown and runs cleanupResources itself. Cleaning up here would bump the
			// generation and misread the owning shutdown as superseded.
			if (this.gracefulShutdownGeneration === this.startGeneration) return;
			// A death that exhausted the budget rejects its own cell with the terminal error too:
			// the model has to see the budget fact on the cell that died, not one cell later.
			this.cleanupResources(
				"SIGTERM",
				verdict.unexpected ? { activeExecutionError: this.terminalRequestError() } : {},
			);
		});
	}

	/**
	 * Bookkeeping for one unowned death: the restart ledger, the requests that were in flight
	 * when it happened, and the notice the next cell owes the model. Runs before the teardown so
	 * the in-flight request list is still the pre-death one.
	 */
	private recordUnexpectedExit(cause: KernelDeathCause): KernelUnexpectedExitFacts {
		const policy = this.currentRestartPolicy();
		// Sliding window: a restart budget that never expired would fail a session closed for a
		// crash it survived hours ago. The ledger is shared with the replacement manager a failed
		// startup produces, so a startup-phase death counts exactly like a mid-cell one (K-P1-1).
		const { restartCount, previous } = this.restartLedger.record(cause, policy);
		const unresolvedHostRequests: KernelHostRequestFact[] = [...this.inFlightHostRequests.values()].map(
			(request) => ({
				type: request.type,
				...(request.label === undefined ? {} : { label: request.label }),
				// Conservative by design: a reply that never arrived is not evidence that the
				// work did not happen, and the model is about to be tempted to repeat it (M10c).
				mayHaveTakenEffect: true,
			}),
		);
		// Measured now, not at render time: by the time the notice reaches the model a replacement
		// kernel may already have overwritten the payload, and "the payload on disk" only means the
		// pre-death one here.
		const snapshotWrittenAt = this.snapshotWrittenAt();
		const dyingCellCode = this.activeExecution?.code ?? this.lastCellCode;
		// Captured before the teardown rejects the cell: its result is thrown away, so the
		// unattributed output it collected is only visible again if the revival keeps it.
		this.dyingBackgroundOutput = this.activeExecution?.backgroundOutput;
		this.dyingBackgroundOutputTruncated = this.activeExecution?.backgroundOutputTruncated ?? false;
		// C8: the budget counts revivals, so the death that exceeds it fails closed instead of
		// arming another one.
		const exhausted = restartCount > policy.maxRestarts;
		this.restartLedger.setPendingRestartNotice({
			cause,
			restartCount,
			snapshotConfigured: this.options.snapshot !== undefined,
			hostRequests: unresolvedHostRequests,
			...(Number.isFinite(policy.maxRestarts) ? { maxRestarts: policy.maxRestarts } : {}),
			windowMinutes: Math.round(policy.windowMs / 60_000),
			...(dyingCellCode === undefined ? {} : { repeatedCellCode: dyingCellCode }),
			...(snapshotWrittenAt === undefined
				? {}
				: { snapshotWrittenBeforeDeathMs: Math.max(0, cause.at - snapshotWrittenAt) }),
		});
		return {
			decision: {
				revive: !exhausted && this.canReviveAfterUnexpectedExit(),
				restartCount,
				windowMs: policy.windowMs,
				budgetRemaining: Math.max(0, policy.maxRestarts - restartCount),
				exhausted,
				...(previous === undefined ? {} : { sincePreviousMs: Math.max(0, cause.at - previous.at) }),
			},
			unresolvedHostRequests,
		};
	}

	/**
	 * Restart budget in force right now; read at every death so a settings edit applies at once.
	 *
	 * The read is guarded because it also runs inside the kernel "exit" handler (P2-1): a policy
	 * callback that throws there is an uncaught exception, which the daemon worker turns into
	 * `process.exit(1)`. The default budget applies instead, and every failure is reported - a
	 * host that cannot read its own settings has to stay visible, not silently lose its budget.
	 */
	private currentRestartPolicy(): KernelRestartPolicy {
		let configured: KernelRestartPolicy | undefined;
		try {
			configured = this.options.restartPolicy?.();
		} catch (error) {
			this.restartPolicyFailures++;
			this.appendKernelDiagnostic(
				`kernel restart policy callback failed: ${errorMessage(error)}; using the default restart budget`,
			);
			kernelLog.warn("kernel restart policy callback failed", {
				error: errorMessage(error),
				failures: this.restartPolicyFailures,
				sessionId: this.options.sessionId,
			});
		}
		return {
			maxRestarts: configured?.maxRestarts ?? DEFAULT_MAX_UNEXPECTED_RESTARTS,
			windowMs: configured?.windowMs ?? DEFAULT_KERNEL_RESTART_WINDOW_MS,
		};
	}

	/**
	 * The error every request gets while this kernel is terminal. A spent restart budget says so
	 * with the death chain and the two re-arm paths; anything else keeps the plain teardown text.
	 */
	private terminalRequestError(): Error {
		const policy = this.currentRestartPolicy();
		const causes = this.restartLedger.exitsInWindow(policy, Date.now());
		if (causes.length <= policy.maxRestarts) return new Error("Kernel has been shut down");
		return new KernelUnavailableError({
			restartCount: causes.length,
			maxRestarts: policy.maxRestarts,
			windowMs: policy.windowMs,
			causes,
		});
	}

	/**
	 * Whether an unexpected death may be revived. Everything that says no is a host decision that
	 * outlives the kernel: an explicit teardown, or a final dispose snapshot still flushing
	 * (reviving under it would splice a live kernel into a session that is closing).
	 */
	private canReviveAfterUnexpectedExit(): boolean {
		return !this.disposedByHost && !this.flushingSnapshotForDispose && !this.restartBudgetExhaustedNow();
	}

	/** Whether the budget is spent right now. Live, because the window slides (L3). */
	private restartBudgetExhaustedNow(): boolean {
		return this.restartLedger.exhausted(this.currentRestartPolicy(), Date.now());
	}

	/**
	 * Re-arm a fail-closed session when its window expires (L3). Lazy on purpose: nothing is
	 * scheduled, so a session that never runs another cell never restarts a kernel, and one that
	 * does gets its revival back without a human. Only an exhausted budget is re-armed here - a
	 * kernel the host tore down stays down.
	 */
	private rearmIfRestartBudgetWindowExpired(): void {
		if (this.state !== "shutdown" || this.disposedByHost) return;
		if (this.restartLedger.count === 0) return;
		if (this.restartBudgetExhaustedNow()) return;
		this.appendKernelDiagnostic("kernel restart budget window expired; the next cell revives the kernel");
		// The failed-closed request memoized a start() that did nothing (the state was terminal
		// then); without dropping it the revived state would never spawn a child.
		this.startPromise = undefined;
		this.pendingRebootstrap = true;
		this.restoreTimedOut = false;
		this.armReprovisionWindow();
		this.state = "idle";
	}

	/**
	 * Settle at idle with the reprovisioning flags armed, so the next `execute()` spawns a
	 * replacement and restores into it. The in-flight host requests are *not* cancelled: they
	 * belong to work the host already admitted (an `rlm.run` child, a message delivery), and a
	 * kernel crash is not a teardown of the family (I-11). Their replies are dropped - by the
	 * generation check in {@link sendHostReply}, which is what makes that unconditional: the
	 * teardown below bumps the generation, so a reply that only becomes ready after the replacement
	 * is up is reported as late instead of being written into a kernel that never asked for it
	 * (P2-3). The drop is what the reset notice reports.
	 */
	private armRevivalAfterUnexpectedExit(cause: KernelDeathCause): void {
		this.pendingRebootstrap = true;
		// A payload that timed out last time is owed another attempt on the new kernel.
		this.restoreTimedOut = false;
		liveKernels.delete(this);
		this.cleanupResources("SIGKILL", {
			keepHostRequests: true,
			keepBackgroundOutput: true,
			activeExecutionError: new Error(
				`Python kernel exited unexpectedly (code=${cause.code}, signal=${cause.signal ?? "null"}, origin=${cause.origin}); the next cell starts a replacement kernel and restores the last snapshot`,
			),
		});
		// The dying cell's result was thrown away with it, so the unattributed output it had
		// collected (an orphan thread, another cell's leftovers) goes back to the pending buffer:
		// it is evidence about the death, and the next cell is the only one that can show it.
		if (this.dyingBackgroundOutput && this.dyingBackgroundOutput.length > 0) {
			this.pendingBackgroundOutput = this.dyingBackgroundOutput;
			this.pendingBackgroundOutputTruncated = this.dyingBackgroundOutputTruncated;
		}
		this.dyingBackgroundOutput = undefined;
		this.dyingBackgroundOutputTruncated = false;
		// Armed after the teardown so the window this revival needs is not the one the teardown
		// just closed, and so its age counts from the death rather than from an earlier window.
		this.armReprovisionWindow();
		this.state = "idle";
	}

	/**
	 * One kernel death the host did not order. The in-memory stderr ring never leaves this
	 * process, so the cause goes out two ways: a countable log line for the machine-wide
	 * signature, and a callback the owning session turns into its own log line.
	 */
	private reportUnexpectedKernelExit(
		cause: KernelDeathCause,
		kernelPid: number | undefined,
		facts: KernelUnexpectedExitFacts,
	): void {
		this.appendKernelDiagnostic(`unexpected exit code=${cause.code} signal=${cause.signal} origin=${cause.origin}`);
		kernelLog.error("kernel exited unexpectedly", {
			code: cause.code,
			signal: cause.signal,
			origin: cause.origin,
			...(kernelPid === undefined ? {} : { kernelPid }),
			sessionId: this.options.sessionId,
		});
		try {
			this.options.onUnexpectedExit?.(cause, facts);
		} catch (error) {
			// A reporting callback must not be able to break the teardown that follows it.
			kernelLog.warn("kernel unexpected-exit callback failed", {
				error: errorMessage(error),
				sessionId: this.options.sessionId,
			});
		}
	}

	private failProtocolFrame(child: ChildProcess, diagnostic: string): void {
		if (this.child !== child) return;
		this.appendKernelDiagnostic(diagnostic);
		const error = new Error(`Kernel protocol error: ${diagnostic}`);
		if (this.state === "starting") this.startupProtocolError = error;
		this.readyDeferred?.reject(error);
		this.rejectActiveExecution(error);
		if (this.teardownInFlight > 0 || this.state !== "running") return;

		if (this.protocolRepairOwner) {
			// A repair's own replacement child corrupted: discard it instead of respawn-looping.
			this.appendKernelDiagnostic("replacement kernel corrupted during protocol repair; giving up");
			this.protocolRepairOwner.superseded = true;
			// performRestore clears pendingRestore, so it still being set means the
			// corruption struck at or before the restore phase: the snapshot stays
			// the prime suspect (ambiguous attribution, loop-safe — retrying it
			// would re-trigger the corruption). Corruption strictly after a
			// successful restore never implicates the snapshot; keeping the flag
			// costs at most one bounded restore per later attempt.
			const snapshotSuspect = this.pendingRestore;
			this.killChildToIdle("repair_kill");
			if (snapshotSuspect) this.clearPendingRestore();
			return;
		}
		const owner = { superseded: false };
		this.protocolRepairOwner = owner;
		const repair = this.repairProtocolChild(child, owner);
		this.protocolRepairPromise = repair;
		void repair.then(
			() => {
				if (this.protocolRepairPromise === repair) this.protocolRepairPromise = undefined;
				if (this.protocolRepairOwner === owner) this.protocolRepairOwner = undefined;
			},
			(repairError) => {
				this.appendKernelDiagnostic(`protocol repair failed: ${errorMessage(repairError)}`);
				if (this.protocolRepairPromise === repair) this.protocolRepairPromise = undefined;
				if (this.protocolRepairOwner === owner) this.protocolRepairOwner = undefined;
			},
		);
	}

	private async repairProtocolChild(child: ChildProcess, owner: { superseded: boolean }): Promise<void> {
		if (this.child !== child || this.state === "shutdown") return;
		this.killChildToIdle("repair_kill");

		const start = this.start();
		const generation = this.startGeneration;
		try {
			await start;
		} catch (error) {
			this.finishFailedProtocolRepair(owner, error);
			return;
		}
		if (this.startStale(generation) || (this.state as string) !== "running") {
			this.finishFailedProtocolRepair(owner);
			return;
		}

		const restored = await this.performRestore(true);
		if (this.startStale(generation) || (this.state as string) !== "running") {
			this.finishFailedProtocolRepair(owner);
			return;
		}
		if (this.options.snapshot && restored === null) {
			if (owner.superseded || this.protocolRepairOwner !== owner) return;
			this.appendKernelDiagnostic("protocol repair restore failed; discarding replacement kernel");
			this.killChildToIdle("repair_kill");
			// The snapshot is the declared culprit; the lazy path must not retry it.
			this.clearPendingRestore();
			return;
		}

		// Restore revives only the user namespace; live handles (rlm, bash, skills)
		// come from the runtime bootstrap, so a repaired kernel must re-run it.
		if (!this.options.bootstrapCode) return;
		const bootstrapped = await this.bootstrapRepairedKernel(this.options.bootstrapCode);
		if (this.startStale(generation) || (this.state as string) !== "running") {
			this.finishFailedProtocolRepair(owner);
			return;
		}
		if (!bootstrapped) {
			if (owner.superseded || this.protocolRepairOwner !== owner) return;
			this.appendKernelDiagnostic("protocol repair bootstrap failed; discarding replacement kernel");
			this.killChildToIdle("bootstrap_fail_kill");
		}
	}

	/** Bounded bootstrap of a repaired kernel; false when it failed. Never throws. */
	private async bootstrapRepairedKernel(code: string): Promise<boolean> {
		try {
			const r = await this.enqueueRequest(
				{ type: "execute", code },
				code,
				{ internal: true, protocolRepair: true },
				REPAIR_STEP_TIMEOUT_MS,
			);
			if (r.status !== "ok") {
				this.appendKernelDiagnostic(
					`protocol repair bootstrap ${r.status === "aborted" ? "timed out" : "failed"}: ${r.error?.evalue ?? r.stderr}`,
				);
				return false;
			}
			this.pendingRebootstrap = false;
			return true;
		} catch (error) {
			this.appendKernelDiagnostic(`protocol repair bootstrap error: ${errorMessage(error)}`);
			return false;
		}
	}

	/**
	 * A fresh kernel started after a discarded repair has none of the runtime
	 * bootstrap's live handles (rlm, bash, skills) and an empty namespace:
	 * reprovision (restore, then bootstrap) before any user request. A failed
	 * re-bootstrap discards the kernel again instead of serving user code on an
	 * unprovisioned namespace.
	 */
	private async ensureKernelRebootstrapped(signal?: AbortSignal): Promise<void> {
		const code = this.options.bootstrapCode;
		const needsRestore = Boolean(this.options.snapshot) && this.pendingRestore;
		const needsBootstrap = Boolean(code) && this.pendingRebootstrap;
		// An in-flight repair owns its kernel's restore/bootstrap sequence, and
		// a teardown's final snapshot must never trigger reprovisioning.
		if (
			(!needsRestore && !needsBootstrap) ||
			this.protocolRepairPromise ||
			this.teardownInFlight > 0 ||
			this.state !== "running"
		) {
			return;
		}
		let task = this.rebootstrapPromise;
		if (!task) {
			const started = this.reprovisionFreshKernel(code);
			task = started;
			this.rebootstrapPromise = started;
			void started.finally(() => {
				if (this.rebootstrapPromise === started) this.rebootstrapPromise = undefined;
			});
		}
		// An aborted request never executes, so it may skip the wait; race the
		// signal like waitForProtocolRepair does instead of riding out the
		// bootstrap bound after a mid-wait abort.
		if (signal) {
			if (signal.aborted) return;
			let onAbort: () => void = () => {};
			const aborted = new Promise<void>((resolve) => {
				onAbort = resolve;
				signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				await Promise.race([task, aborted]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
			if (signal.aborted) return;
		}
		const ok = await task; // bounded by REPAIR_STEP_TIMEOUT_MS
		if (!ok) throw new Error("Kernel bootstrap failed after protocol repair");
	}

	/** Restore (one-shot, best-effort) then bootstrap the lazily started fresh kernel. */
	private async reprovisionFreshKernel(code: string | undefined): Promise<boolean> {
		try {
			return await this.runReprovision(code);
		} finally {
			// The sequence is over either way: a kernel that serves cells again must not keep
			// excusing a silent turn, and the next death has to open a window of its own.
			this.closeReprovisionWindow();
		}
	}

	private async runReprovision(code: string | undefined): Promise<boolean> {
		if (this.options.snapshot && this.pendingRestore && !this.restoreTimedOut) {
			await this.performRestore(true); // clears pendingRestore on success
			// Corrupted during the restore: the spawned repair owns the kernel now.
			if (this.protocolRepairPromise || this.state !== "running") return false;
			// One attempt per discard: a clean restore failure falls back to an
			// empty namespace (ordinary startup semantics), never a retry loop. A restore that
			// only timed out is not retried per cell either (that would tax every cell with two
			// timeouts); it stays owed, keeps snapshot writes paused, and is retried on the next
			// kernel start.
			this.clearPendingRestore();
		} else if (this.pendingRestore && !this.options.snapshot) {
			// A session without a snapshot target has nothing to revive: leaving the window open
			// would keep the revival vouch alive for a kernel that is already serving cells.
			this.clearPendingRestore();
		}
		if (!code || !this.pendingRebootstrap) return true;
		const ok = await this.bootstrapRepairedKernel(code);
		if (!ok && this.state === "running") this.killChildToIdle("bootstrap_fail_kill");
		return ok;
	}

	/**
	 * Open the reprovisioning window. One call arms both facts (L10.4): the snapshot write policy
	 * refuses to overwrite a payload this namespace has not caught up with, and the stall
	 * watchdog's revival vouch excuses silence while the replacement is being built.
	 */
	private armReprovisionWindow(): void {
		this.pendingRestore = true;
		this.reprovisionWindowSince ??= Date.now();
	}

	/** The namespace caught up, or the payload is no longer owed; the vouch window stays open. */
	private clearPendingRestore(): void {
		this.pendingRestore = false;
	}

	/** End the vouch window, so the next death opens a fresh one instead of inheriting this age. */
	private closeReprovisionWindow(): void {
		this.reprovisionWindowSince = undefined;
	}

	/** Kill the current child and settle at clean idle, so the next start spawns fresh. */
	private killChildToIdle(origin: "repair_kill" | "bootstrap_fail_kill"): void {
		// The discarded kernel carried the runtime bootstrap and (possibly) the
		// restored namespace; a lazily started replacement must reprovision both.
		this.pendingRebootstrap = true;
		// Tagged before the kill: by the time the exit event is delivered this call has already
		// put the state back to "idle" and bumped the generation, so nothing else can tell a
		// protocol repair from a crash.
		this.intentionalExitOrigin = origin;
		this.state = "shutdown";
		liveKernels.delete(this);
		this.cleanupResources("SIGKILL");
		// Armed after the teardown: cleanupResources closes the window, and a discarded kernel
		// owes its replacement both a restore and a bootstrap.
		this.armReprovisionWindow();
		this.state = "idle";
	}

	private finishFailedProtocolRepair(owner: { superseded: boolean }, error?: unknown): void {
		if (error) this.appendKernelDiagnostic(`protocol repair start failed: ${errorMessage(error)}`);
		if (owner.superseded || this.protocolRepairOwner !== owner) return;
		if (this.state === "shutdown") this.state = "idle";
	}

	private supersedeProtocolRepair(): void {
		if (this.protocolRepairOwner) this.protocolRepairOwner.superseded = true;
	}

	/** Wait until no protocol repair is pending; resolves early when the signal aborts. */
	private async waitForProtocolRepair(signal?: AbortSignal): Promise<void> {
		while (this.protocolRepairPromise && !signal?.aborted) {
			const repair = this.protocolRepairPromise;
			if (!signal) {
				await repair;
				continue;
			}
			let onAbort: () => void = () => {};
			const aborted = new Promise<void>((resolve) => {
				onAbort = resolve;
				signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				await Promise.race([repair, aborted]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		}
	}

	private async waitForReady(child: ChildProcess): Promise<number> {
		const ready = this.readyDeferred;
		if (!ready) throw new Error("Kernel ready state is missing");
		let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		let onExit: (() => void) | undefined;
		try {
			return await new Promise<number>((resolve, reject) => {
				ready.promise.then(resolve, reject);
				onExit = () => {
					const finish = () => {
						const tail = this.stderrTail();
						reject(new Error(`Kernel exited before ready. stderr:\n${tail || "(empty)"}`));
					};
					// The final stderr chunks can still be in flight at 'exit'; wait for the
					// drained pipe so the tail includes the kernel's last words (the ready
					// timeout stays armed, bounding the wait). The 'close' listener wireChild
					// registered runs first, so the decoder is flushed and the log fd closed
					// by the time the tail is built.
					const stderr = child.stderr;
					if (!stderr || stderr.closed) finish();
					else stderr.once("close", finish);
				};
				if (child.exitCode !== null || child.signalCode !== null) {
					onExit();
					return;
				}
				child.once("exit", onExit);
				timeout = globalThis.setTimeout(() => {
					const tail = this.stderrTail();
					reject(
						new Error(
							`Kernel did not become ready within ${READY_TIMEOUT_MS}ms. stderr tail:\n${tail || "(empty)"}`,
						),
					);
				}, READY_TIMEOUT_MS);
				timeout.unref?.();
			});
		} finally {
			if (timeout) globalThis.clearTimeout(timeout);
			if (onExit) child.removeListener("exit", onExit);
		}
	}

	/** Write one JSON-lines request frame; resolves when the OS accepted the bytes. */
	private writeLine(request: Record<string, unknown>): Promise<void> {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed) {
			return Promise.reject(new Error("Kernel stdin is not connected"));
		}
		return new Promise<void>((resolve, reject) => {
			stdin.write(`${JSON.stringify(request)}\n`, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}

	private handleEvent(event: Record<string, unknown>): void {
		const type = event.event;
		if (type === "ready") {
			// Additive and optional: a runtime that predates capability announcement sends
			// no `capabilities` field and negotiates nothing beyond its protocol version.
			this.announcedKernelCapabilities = asStringArray(event.capabilities);
			// Recorded before the deferred resolves: the rest of this stdout chunk is parsed
			// synchronously, long before `doStart` can validate the announcement and publish it.
			this.readyAnnouncedProtocol = typeof event.protocol === "number" ? event.protocol : undefined;
			this.readyDeferred?.resolve(typeof event.protocol === "number" ? event.protocol : -1);
			return;
		}
		if (type === "host_request") {
			if (typeof event.id === "string") this.startHostRequest(event.id, event.data);
			return;
		}
		if (type === "heartbeat") {
			// Dispatched before id attribution on purpose: a heartbeat is a fact about the kernel,
			// not about a cell, so it must never be merged into an execution's streams, handed to
			// onStream, or buffered as background output.
			this.recordHeartbeatFrame(event);
			return;
		}

		const id = typeof event.id === "string" ? event.id : undefined;
		const execution = this.activeExecution;
		if (!execution || id !== execution.requestId) {
			if (type === "display" && isRecord(event.data)) {
				this.dispatchLateSentAgentMessage(id, event.data[AGENT_MESSAGE_DISPLAY_MIME]);
			} else if (type === "stdout" || type === "stderr") {
				// Unowned output (null id, or another cell's id): never merge it into
				// the active cell's streams; buffer it as background output instead.
				this.appendBackgroundOutput(typeof event.text === "string" ? event.text : "");
			} else if (type === "done" && id) {
				const waiter = this.pendingDoneWaiters.get(id);
				this.pendingDoneWaiters.delete(id);
				waiter?.();
			} else if (type === "error" && id === undefined) {
				this.appendKernelDiagnostic(`protocol error: ${String(event.evalue ?? "")}`);
			}
			return;
		}

		if (execution.settled && type === "display" && isRecord(event.data)) {
			if (this.dispatchLateSentAgentMessage(id, event.data[AGENT_MESSAGE_DISPLAY_MIME])) {
				return;
			}
		}
		if (type === "stdout" || type === "stderr") {
			const text = typeof event.text === "string" ? event.text : "";
			const capped = capStreamOutput(
				type === "stdout" ? execution.stdout : execution.stderr,
				text,
				execution.maxChars,
			);
			if (type === "stdout") {
				execution.stdout = capped.text;
				if (capped.truncated) execution.stdoutTruncated = true;
			} else {
				execution.stderr = capped.text;
				if (capped.truncated) execution.stderrTruncated = true;
			}
			const onStream = execution.opts.onStream;
			if (onStream) this.invokeHostCallback("onStream", () => onStream(text, type));
		} else if (type === "result") {
			if (typeof event.text === "string") execution.result = event.text;
		} else if (type === "display") {
			const data = isRecord(event.data) ? event.data : {};
			const diff = parseDiffDisplay(data[DIFF_DISPLAY_MIME]);
			if (diff) execution.diffs.push(diff);
			const attachment = parseAttachmentDisplay(data[ATTACHMENT_DISPLAY_MIME]);
			if (attachment === "oversized") {
				execution.stderr += `${execution.stderr ? "\n" : ""}attachment dropped: exceeds ${MAX_ATTACHMENT_DATA_CHARS} base64 chars`;
				execution.status = "error";
			} else if (attachment) {
				execution.attachments.push(attachment);
			}
			const sentAgentMessage = parseSentAgentMessage(data[AGENT_MESSAGE_DISPLAY_MIME]);
			if (sentAgentMessage) execution.sentAgentMessages.push(sentAgentMessage);
		} else if (type === "error") {
			execution.error = {
				ename: typeof event.ename === "string" ? event.ename : "Error",
				evalue: typeof event.evalue === "string" ? event.evalue : "",
				traceback: asStringArray(event.traceback),
			};
			execution.status = "error";
		} else if (type === "done") {
			execution.doneFields = event;
			if (event.status !== "ok" && execution.status === "ok") {
				execution.status = "error";
				// State requests report failures as a done reason without an error event.
				if (!execution.error && typeof event.reason === "string") {
					execution.error = { ename: "KernelError", evalue: event.reason, traceback: [] };
				}
			}
			this.finishActiveExecution(execution);
		}
	}

	async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		await this.waitForProtocolRepair(opts.signal);
		const result = await this.enqueueExecute(code, opts);
		// Refresh the on-disk snapshot after real work so a later resume (or a
		// crash before graceful shutdown) revives the most recent namespace.
		//
		// Every cell that ended queues this, not just a successful one: `x = 1` followed by `raise`
		// is a common shape, and it mutates the namespace the same way a successful cell does. The
		// old "ok only" gate left the payload at the last successful cell while the reset notice
		// claimed a debounce-worth of freshness, so a variable defined seconds (or minutes) before
		// the death was simply gone with nothing said about it. An aborted cell can have run
		// partially too, and the debounce below coalesces all of this into one write per quiet
		// period, so the extra queueing costs no extra writes.
		this.scheduleSnapshot();
		return result;
	}

	/** Queue and run a cell, serializing against all other executions. */
	private async enqueueExecute(
		code: string,
		opts: ExecuteOptions,
		executionTimeoutMs?: number,
	): Promise<InternalExecuteResult> {
		return this.enqueueRequest({ type: "execute", code }, code, opts, executionTimeoutMs);
	}

	/** Queue one protocol request (execute or state op) behind every other request. */
	private async enqueueRequest(
		requestFields: Record<string, unknown> & { type: string },
		code: string,
		opts: ExecuteOptions,
		executionTimeoutMs?: number,
	): Promise<InternalExecuteResult> {
		if (opts.signal?.aborted) {
			return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
		}
		// A fail-closed session re-arms itself when its budget window expires (L3), and the
		// check has to run before start(): a spent budget leaves the state at "shutdown", which
		// start() would otherwise treat as a permanent verdict.
		this.rearmIfRestartBudgetWindowExpired();
		await this.start({ signal: opts.signal });
		if ((this.state as string) === "shutdown") {
			throw this.terminalRequestError();
		}
		if (this.flushingSnapshotForDispose && !opts.internal) {
			throw new Error("Kernel is shutting down");
		}
		if (!opts.protocolRepair) await this.ensureKernelRebootstrapped(opts.signal);
		// Aborted while waiting on the re-bootstrap: settle now instead of parking
		// on the queue slot behind the still-running bootstrap.
		if (opts.signal?.aborted) {
			return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
		}
		// Re-check: a final flush may have started while this request awaited the
		// lazy re-bootstrap; admitting it now would splice it between the flush's
		// captured queue and the final snapshot, unbounding the teardown.
		if (this.flushingSnapshotForDispose && !opts.internal) {
			throw new Error("Kernel is shutting down");
		}

		const prev = this.executionQueue;
		let resolveNext: () => void = () => {};
		this.executionQueue = new Promise<void>((r) => {
			resolveNext = r;
		});
		await prev;

		const started = Date.now();
		let executionTimeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		try {
			await this.waitForActiveExecutionToClearForReuse(opts.signal);
			if (opts.signal?.aborted) {
				return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
			}
			if ((this.state as string) === "shutdown") {
				throw this.terminalRequestError();
			}
			// A repair started while this request was queued or busy-waiting: release
			// the slot so the repair's own restore can run, then requeue behind it.
			if (this.protocolRepairPromise && !opts.protocolRepair) {
				resolveNext();
				await this.waitForProtocolRepair(opts.signal);
				return this.enqueueRequest(requestFields, code, opts, executionTimeoutMs);
			}
			if (executionTimeoutMs === undefined) {
				return await this.executeInner(requestFields, code, opts, started);
			}

			const controller = new AbortController();
			executionTimeout = globalThis.setTimeout(() => controller.abort(), executionTimeoutMs);
			executionTimeout.unref?.();
			const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
			return await this.executeInner(requestFields, code, { ...opts, signal }, started);
		} finally {
			if (executionTimeout) globalThis.clearTimeout(executionTimeout);
			resolveNext();
		}
	}

	private async executeInner(
		requestFields: Record<string, unknown> & { type: string },
		code: string,
		opts: ExecuteOptions,
		started: number,
	): Promise<InternalExecuteResult> {
		const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
		const requestId = uuid();

		if (opts.signal?.aborted) {
			return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
		}
		if (this.activeExecution) {
			throw new Error("Kernel already has an active execution");
		}

		const result = createDeferred<InternalExecuteResult>();
		const execution: ActiveExecution = {
			requestId,
			code,
			started,
			maxChars,
			opts,
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			diffs: [],
			attachments: [],
			sentAgentMessages: [],
			// An internal (host-synthesized) cell never reaches the model, so it must not drain
			// the buffer the next real cell is supposed to see.
			backgroundOutput: opts.internal ? "" : this.pendingBackgroundOutput,
			backgroundOutputTruncated: opts.internal ? false : this.pendingBackgroundOutputTruncated,
			status: "ok",
			settled: false,
			resolve: result.resolve,
			reject: result.reject,
		};
		if (!opts.internal) {
			this.pendingBackgroundOutput = "";
			this.pendingBackgroundOutputTruncated = false;
		}
		let abortTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
		const clearAbortTimer = () => {
			if (abortTimer) {
				globalThis.clearTimeout(abortTimer);
				abortTimer = undefined;
			}
		};
		const forceAbort = () => {
			if (this.activeExecution !== execution) {
				return;
			}
			execution.status = "aborted";
			if (opts.killOnAbortTimeout) {
				// Countable on the cell that was interrupted: the model has to learn on this
				// result, not one cell later, that its namespace went with the kernel.
				execution.stderr +=
					`${execution.stderr ? "\n" : ""}Python kernel was killed because the interrupted cell did not stop. ` +
					"Live Python state was lost. The next call starts a new kernel and may restore the last saved snapshot.";
				if (execution.stderr.length > execution.maxChars) {
					execution.stderr = execution.stderr.slice(0, execution.maxChars);
					execution.stderrTruncated = true;
				}
			}
			// The execution stays active until its done event arrives; clearing it
			// early would let a new cell race the interrupted one (see busy-after-interrupt).
			this.resolveExecution(execution, { clearActive: false });
			if (opts.killOnAbortTimeout) {
				// Recorded here, not by the exit handler: cleanupResources drops the child
				// reference before the SIGKILL's exit event is delivered, so the handler's
				// stale-child guard returns before it could classify this death. Without this
				// line the ring would not say why the kernel went away.
				this.appendKernelDiagnostic(
					"killing the kernel because the interrupted cell did not stop (abort_timeout_kill)",
				);
				// Tagged as well, so any exit that is still classified sees the host's own kill
				// instead of a crash: an untagged one would burn restart budget and report a
				// kernel failure nobody caused. The owner sees the instance go defunct and
				// provisions a replacement.
				void this.kill("abort_timeout_kill");
			}
		};
		const onAbort = () => {
			void this.interrupt().catch(() => undefined);
			clearAbortTimer();
			abortTimer = globalThis.setTimeout(forceAbort, KERNEL_ABORT_GRACE_MS);
			if (abortTimer && typeof abortTimer === "object" && "unref" in abortTimer) {
				abortTimer.unref();
			}
		};

		try {
			this.activeExecution = execution;
			opts.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts.signal?.aborted) {
				onAbort();
			}
			if (!opts.internal) {
				this.lastCellCode = code;
			}
			try {
				const sendPromise = this.writeLine({ ...requestFields, id: requestId });
				sendPromise.catch(() => undefined);
				await Promise.race([sendPromise, result.promise.then(() => undefined)]);
				if (this.activeExecution === execution && execution.status !== "aborted") {
					await sendPromise;
				}
			} catch (error) {
				if (this.activeExecution === execution) {
					this.activeExecution = undefined;
				}
				throw error instanceof Error ? error : new Error(String(error));
			}
			return await result.promise;
		} finally {
			clearAbortTimer();
			opts.signal?.removeEventListener("abort", onAbort);
		}
	}

	private appendBackgroundOutput(text: string): void {
		if (!text) return;
		const execution = this.activeExecution;
		// Output arriving during an internal cell (snapshot, restore, bootstrap) is still
		// unattributed as far as the model is concerned: keep it for the next cell it sees.
		if (execution && !execution.opts.internal) {
			if (execution.backgroundOutput.length >= MAX_BACKGROUND_OUTPUT_CHARS) {
				execution.backgroundOutputTruncated = true;
				return;
			}
			execution.backgroundOutput += text;
			if (execution.backgroundOutput.length > MAX_BACKGROUND_OUTPUT_CHARS) {
				execution.backgroundOutput = execution.backgroundOutput.slice(0, MAX_BACKGROUND_OUTPUT_CHARS);
				execution.backgroundOutputTruncated = true;
			}
			return;
		}
		if (this.pendingBackgroundOutput.length >= MAX_BACKGROUND_OUTPUT_CHARS) {
			this.pendingBackgroundOutputTruncated = true;
			return;
		}
		this.pendingBackgroundOutput += text;
		if (this.pendingBackgroundOutput.length > MAX_BACKGROUND_OUTPUT_CHARS) {
			this.pendingBackgroundOutput = this.pendingBackgroundOutput.slice(0, MAX_BACKGROUND_OUTPUT_CHARS);
			this.pendingBackgroundOutputTruncated = true;
		}
	}

	private finishActiveExecution(execution: ActiveExecution): void {
		if (this.activeExecution !== execution) {
			return;
		}
		this.resolveExecution(execution, { clearActive: true });
	}

	private resolveExecution(execution: ActiveExecution, options: { clearActive: boolean }): void {
		const didClearActive = options.clearActive && this.activeExecution === execution;
		if (options.clearActive && this.activeExecution === execution) {
			this.activeExecution = undefined;
		}
		if (!execution.settled) {
			execution.settled = true;
			if (execution.opts.onLateSentAgentMessage) {
				this.registerLateSentAgentMessageHandler(execution.requestId, execution.opts.onLateSentAgentMessage);
			}

			let stdout = execution.stdout;
			let stderr = execution.stderr;
			let result = execution.result;
			let status = execution.status;
			if (execution.stdoutTruncated) stdout += `\n[... output truncated at ${execution.maxChars} chars ...]`;
			if (execution.stderrTruncated) stderr += `\n[... output truncated at ${execution.maxChars} chars ...]`;
			if (result !== undefined && result.length > execution.maxChars) {
				result = `${result.slice(0, execution.maxChars)}\n[... output truncated at ${execution.maxChars} chars ...]`;
			}

			if (execution.opts.signal?.aborted) status = "aborted";

			let backgroundOutput = execution.backgroundOutput;
			if (execution.backgroundOutputTruncated) {
				backgroundOutput += `\n[... background output truncated at ${MAX_BACKGROUND_OUTPUT_CHARS} chars ...]`;
			}

			execution.resolve({
				stdout,
				stderr,
				result,
				diffs: execution.diffs.length > 0 ? execution.diffs : undefined,
				attachments: execution.attachments.length > 0 ? execution.attachments : undefined,
				sentAgentMessages: execution.sentAgentMessages.length > 0 ? execution.sentAgentMessages : undefined,
				backgroundOutput: backgroundOutput.length > 0 ? backgroundOutput : undefined,
				error: execution.error,
				status,
				durationMs: Date.now() - execution.started,
				doneFields: execution.doneFields,
			});
		}
		if (didClearActive) {
			this.notifyActiveExecutionIdle();
		}
	}

	private dispatchLateSentAgentMessage(requestId: string | undefined, value: unknown): boolean {
		const sentAgentMessage = parseSentAgentMessage(value);
		if (!sentAgentMessage || !requestId) {
			return false;
		}
		const handler = this.lateSentAgentMessageHandlers.get(requestId);
		if (!handler) {
			return false;
		}
		this.lateSentAgentMessageHandlers.delete(requestId);
		this.lateSentAgentMessageHandlers.set(requestId, handler);
		this.invokeHostCallback("late agent_message", () => handler(sentAgentMessage));
		return true;
	}

	private registerLateSentAgentMessageHandler(
		requestId: string,
		handler: (message: KernelSentAgentMessage) => void,
	): void {
		this.lateSentAgentMessageHandlers.set(requestId, handler);
		while (this.lateSentAgentMessageHandlers.size > MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS) {
			const oldestRequestId = this.lateSentAgentMessageHandlers.keys().next().value;
			if (oldestRequestId === undefined) {
				break;
			}
			this.lateSentAgentMessageHandlers.delete(oldestRequestId);
		}
	}

	private rejectActiveExecution(error: Error): void {
		const execution = this.activeExecution;
		if (!execution) {
			return;
		}
		this.activeExecution = undefined;
		execution.reject(error);
		this.notifyActiveExecutionIdle();
	}

	private notifyActiveExecutionIdle(): void {
		for (const resolve of this.activeExecutionIdleWaiters) {
			resolve();
		}
		this.activeExecutionIdleWaiters.clear();
	}

	private waitForActiveExecutionToClear(signal: AbortSignal | undefined, timeoutMs: number): Promise<boolean> {
		if (!this.activeExecution) {
			return Promise.resolve(true);
		}
		return new Promise<boolean>((resolve) => {
			let settled = false;
			let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
			const finish = (cleared: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				if (timeout) {
					globalThis.clearTimeout(timeout);
				}
				this.activeExecutionIdleWaiters.delete(onIdle);
				signal?.removeEventListener("abort", onAbort);
				resolve(cleared);
			};
			const onIdle = () => finish(true);
			const onAbort = () => finish(false);
			this.activeExecutionIdleWaiters.add(onIdle);
			signal?.addEventListener("abort", onAbort, { once: true });
			timeout = globalThis.setTimeout(() => finish(false), timeoutMs);
			if (timeout && typeof timeout === "object" && "unref" in timeout) {
				timeout.unref();
			}
		});
	}

	private async waitForActiveExecutionToClearForReuse(signal?: AbortSignal): Promise<void> {
		const started = Date.now();
		while (this.activeExecution && Date.now() - started < KERNEL_BUSY_REUSE_WAIT_MS) {
			if ((this.state as string) === "shutdown") {
				throw this.terminalRequestError();
			}
			void this.interrupt().catch(() => undefined);
			const remaining = KERNEL_BUSY_REUSE_WAIT_MS - (Date.now() - started);
			const cleared = await this.waitForActiveExecutionToClear(
				signal,
				Math.max(1, Math.min(KERNEL_BUSY_INTERRUPT_INTERVAL_MS, remaining)),
			);
			if (cleared || signal?.aborted) {
				return;
			}
		}
		if (this.activeExecution) {
			throw new KernelBusyAfterInterruptError();
		}
	}

	private startHostRequest(requestId: string, data: unknown): void {
		if (this.handledHostRequestIds.has(requestId)) {
			return;
		}
		this.handledHostRequestIds.add(requestId);
		while (this.handledHostRequestIds.size > MAX_HANDLED_HOST_REQUEST_IDS) {
			const oldest = this.handledHostRequestIds.values().next().value;
			if (oldest === undefined) break;
			this.handledHostRequestIds.delete(oldest);
		}

		const startedAt = Date.now();
		const described = describeHostRequest(data);
		const signal = this.hostRequestSignal(described.type);
		// A read-only request is bounded too (C14 family). It cannot tear anything by being cut
		// off, and unbounded it would hold the cell - and the vouch that excuses the cell's
		// silence - for as long as the handler likes. A side-effecting one is never bounded here.
		const readOnlyTimeoutMs = hostRequestTypeIsCancellable(this.options.cancellableHostRequestTypes, described.type)
			? this.readOnlyHostRequestBoundMs()
			: undefined;
		// The kernel this request came from, identified by the start generation it was accepted
		// under. A revival keeps admitted host work alive (I-11) but replaces the kernel underneath
		// it, so a long handler can outlive the kernel that asked it (P2-3).
		const requestGeneration = this.startGeneration;
		// The handler starts on a microtask so the request is registered first: a handler that
		// blocks before its first await is still counted, and still has an age, from the moment
		// the request was accepted.
		const task: Promise<void> = Promise.resolve().then(async () => {
			try {
				const result =
					readOnlyTimeoutMs === undefined
						? await this.handleHostRequest(data, signal)
						: // No signal here on purpose: the bound's job is the timeout. A handler that
							// cares about cancellation already sees the same signal and settles on its
							// own, and racing it here would report "the handler failed" for a request
							// whose real outcome the host never learned.
							await withBound(this.handleHostRequest(data, signal), {
								timeoutMs: readOnlyTimeoutMs,
								phase: "host_request",
								target: described.label === undefined ? described.type : `${described.type} ${described.label}`,
								label: "Kernel host request",
							});
				await this.sendHostReply(requestId, described, requestGeneration, { status: "ok", result }, true);
			} catch (error) {
				this.appendKernelDiagnostic(`host request failed for ${requestId}: ${errorMessage(error)}`);
				await this.sendHostReply(
					requestId,
					described,
					requestGeneration,
					{ status: "error", error: errorMessage(error) },
					false,
				);
			}
		});
		this.inFlightHostRequests.set(task, {
			startedAt,
			type: described.type,
			...(described.label === undefined ? {} : { label: described.label }),
		});
		void task.finally(() => {
			this.inFlightHostRequests.delete(task);
		});
	}

	/**
	 * The bound for one read-only (whitelisted) host request, read live so a settings edit applies
	 * at once. Guarded because this runs inside the frame loop (P2-1): a throwing settings callback
	 * must neither escape as an uncaught exception nor cost the request its reply, which is what
	 * dropping the frame would do - the kernel would wait for a reply that never comes. The default
	 * bound applies and the failure is reported.
	 */
	private readOnlyHostRequestBoundMs(): number {
		const read = this.options.readOnlyHostRequestTimeoutMs;
		if (!read) return DEFAULT_SHORT_TARGET_WAIT_MS;
		try {
			return read();
		} catch (error) {
			this.appendKernelDiagnostic(
				`kernel read-only host request timeout callback failed: ${errorMessage(error)}; using the default bound`,
			);
			kernelLog.warn("kernel read-only host request timeout callback failed", {
				error: errorMessage(error),
				sessionId: this.options.sessionId,
			});
			return DEFAULT_SHORT_TARGET_WAIT_MS;
		}
	}

	/**
	 * The signal one host request waits under (P1-2a).
	 *
	 * Teardown always cancels. A cell abort cancels *only* a type the host declared read-only:
	 * cancelling an admitted `rlm.run` or a message send because the user pressed Esc on the cell
	 * that spawned it would take back the fire-and-forget guarantee the orchestration prompt is
	 * built on (M7). A request with no active cell - a detached spawn firing after its scheduling
	 * cell went idle - keeps the teardown signal too, so work is never bound to a turn that is
	 * already over.
	 */
	private hostRequestSignal(type: string): AbortSignal {
		const teardown = this.hostRequestController.signal;
		if (!hostRequestTypeIsCancellable(this.options.cancellableHostRequestTypes, type)) return teardown;
		const cell = this.activeExecution?.opts.signal;
		if (!cell) return teardown;
		return AbortSignal.any([teardown, cell]);
	}

	/**
	 * Deliver one host reply to the kernel that asked for it, or report it as undeliverable.
	 *
	 * `requestGeneration` is the asking kernel's identity: every teardown and every spawn bumps it,
	 * so a mismatch means the reply outlived that kernel - a revival replaced it (which keeps the
	 * admitted work alive on purpose, I-11), or a repair/shutdown killed it. `writeLine` sends to
	 * whatever `this.child` is *now*, so writing anyway would put a `host_reply` id the current
	 * kernel never minted into its stdin (P2-3). The stale reply takes the same path as one whose
	 * pipe is already gone: reported, never silently dropped (I-6). The check and the write share
	 * one synchronous step, so no teardown can interleave between them.
	 */
	private async sendHostReply(
		requestId: string,
		described: { type: string; label?: string },
		requestGeneration: number,
		data: Record<string, unknown>,
		ok: boolean,
	): Promise<void> {
		if (this.startStale(requestGeneration)) {
			// Named precisely: a revival leaves a replacement running, a teardown leaves nothing,
			// and the session log is the only place this distinction survives.
			const gone = this.child === undefined ? "torn down" : "replaced";
			this.reportLateHostReply(
				requestId,
				described,
				ok,
				new Error(`the kernel that sent this host request was ${gone} before its reply was ready`),
			);
			return;
		}
		try {
			await this.writeLine({ type: "host_reply", id: requestId, data });
		} catch (replyError) {
			this.reportLateHostReply(requestId, described, ok, replyError);
		}
	}

	/**
	 * A reply nobody can receive any more, because the kernel that asked is gone. The request
	 * itself already ran, so this is the only chance to say so: it goes to the machine-wide log and
	 * to the owning session, which can tell the model whether the work is already visible (I-6).
	 */
	private reportLateHostReply(
		requestId: string,
		described: { type: string; label?: string },
		ok: boolean,
		error: unknown,
	): void {
		this.appendKernelDiagnostic(
			`failed to send host request ${ok ? "ok" : "error"} reply for ${requestId}: ${errorMessage(error)}`,
		);
		kernelLog.warn("late kernel host reply dropped", {
			requestId,
			type: described.type,
			ok,
			error: errorMessage(error),
			sessionId: this.options.sessionId,
		});
		try {
			this.options.onLateHostReply?.({
				requestId,
				type: described.type,
				...(described.label === undefined ? {} : { label: described.label }),
				ok,
			});
		} catch (callbackError) {
			kernelLog.warn("late kernel host reply callback failed", {
				error: errorMessage(callbackError),
				sessionId: this.options.sessionId,
			});
		}
	}

	private async handleHostRequest(data: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
		if (!isRecord(data)) {
			throw new Error("host request payload must be an object");
		}
		if (typeof data.type !== "string" || data.type.length === 0) {
			throw new Error("host request payload must have a string type");
		}

		const handler = this.options.hostHandlers?.[data.type];
		if (!handler) {
			throw new Error(`host request type "${data.type}" is not available in this session`);
		}
		// Tag the request with the cell that triggered it. A blocking call is still
		// the in-flight execution; detached spawns (asyncio.create_task) fire after
		// the scheduling cell goes idle, so fall back to that last cell's source.
		const cellSourceCode = this.activeExecution?.code ?? this.lastCellCode;
		return handler({ ...data, cellSourceCode }, signal);
	}

	/** Abort every in-flight host request; idempotent per teardown generation. */
	private abortHostRequests(message: string): void {
		if (!this.hostRequestController.signal.aborted) {
			this.hostRequestController.abort(new Error(message));
		}
	}

	private async interrupt(): Promise<void> {
		const requestId = this.activeExecution?.requestId;
		if (!requestId) return;
		await this.writeLine({ type: "interrupt", id: requestId });
	}

	private cleanupResources(
		killSignal: NodeJS.Signals = "SIGTERM",
		options: { keepHostRequests?: boolean; keepBackgroundOutput?: boolean; activeExecutionError?: Error } = {},
	): void {
		this.startGeneration++; // any teardown invalidates in-flight starts
		// A teardown ends the revival window: what comes next either arms a new one (a revival, a
		// discarded repair kernel) or is a kernel the host closed on purpose, which must not vouch.
		this.closeReprovisionWindow();
		// A revival keeps the admitted host work alive; every real teardown cancels it (I-11).
		if (!options.keepHostRequests) this.abortHostRequests("IPython kernel stopped");
		this.clearSnapshotTimer();
		this.lateSentAgentMessageHandlers.clear();
		this.pendingDoneWaiters.clear();
		if (!options.keepBackgroundOutput) {
			// Stale pre-teardown background output must not surface after a restart. A revival
			// keeps it: an orphan thread's last words are evidence about the death, not noise.
			this.pendingBackgroundOutput = "";
			this.pendingBackgroundOutputTruncated = false;
		}
		this.rejectActiveExecution(options.activeExecutionError ?? new Error("Kernel has been shut down"));
		const child = this.child;
		this.child = undefined;
		this.readyDeferred = undefined;
		// This kernel no longer pins its bootstrap generation directory, so a rebuild
		// elsewhere may reclaim it once no other kernel references it either.
		releaseKernelVenvInUseSync(this.inUseReferencePath);
		this.inUseReferencePath = undefined;
		// A restarted kernel negotiates again; stale capabilities must not authorize a
		// gated request against a replacement that may speak an older protocol.
		this.negotiatedCapabilities = undefined;
		// Cleared as a pair with the negotiation above: the ready handler always overwrites
		// this list, so the clear is hygiene, not correctness — but a future reader must
		// never be able to combine a new negotiation with a previous child's announcement.
		this.announcedKernelCapabilities = [];
		this.readyAnnouncedProtocol = undefined;
		// Liveness facts belong to the child that reported them: a replacement kernel must earn
		// its own first frame before anything vouches for it again, and a rejection streak from a
		// broken predecessor must not pre-age the new episode's log throttling.
		this.livenessSamples.length = 0;
		// The journal count belongs to the child that owned those handles; a replacement kernel
		// starts with no attested work of its own, exactly like the samples cleared above.
		this.journaledBashHandlesCache = undefined;
		this.rejectedHeartbeatFrames = 0;
		this.consecutiveRejectedHeartbeatFrames = 0;
		this.throttledHeartbeatFrames = 0;
		// A replacement kernel is a new episode for the host callbacks too: the first failure
		// against it is reported again instead of landing in a throttled slot.
		this.containedCallbackFailures = 0;
		// A replacement kernel is a new episode: its first refused write must be logged again.
		this.reportedSnapshotSkipReason = undefined;
		if (child) {
			child.stdin?.destroy();
			child.stdout?.destroy();
			// An exited child keeps its stderr: the post-exit drain owns it, and
			// destroying here would drop its buffered last words. A still-alive
			// child may ignore the kill signal and never emit 'exit', so that
			// drain would never run — destroy now to bound the pipe's lifetime.
			if (child.exitCode === null && child.signalCode === null) {
				child.stderr?.destroy();
			}
			const pid = child.pid;
			let signaled = false;
			try {
				signaled = child.kill(killSignal);
			} catch {
				// The kernel has already exited.
			}
			// Inactive only when the signal proved the pid still named our un-reaped child.
			if (pid !== undefined && signaled) recordOrphanProcessState(pid, false);
			// A killed/crashed kernel cannot run its own shutdown hook, so the host
			// reaps the bash() process groups it journaled under this kernel pid.
			if (pid !== undefined) reapKernelOrphanProcesses(pid);
		}
		this.startPromise = undefined;
	}

	private async waitForKernelExit(): Promise<void> {
		const child = this.child;
		if (!child) return;
		if (child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	}

	private async waitForHostRequestsToSettle(tasks: Promise<void>[], timeoutMs: number): Promise<void> {
		let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		const timeoutPromise = new Promise<"timeout">((resolve) => {
			timeout = globalThis.setTimeout(() => resolve("timeout"), timeoutMs);
			if (timeout && typeof timeout === "object" && "unref" in timeout) {
				timeout.unref();
			}
		});

		const result = await Promise.race([Promise.allSettled(tasks).then(() => "settled" as const), timeoutPromise]);
		if (timeout) {
			globalThis.clearTimeout(timeout);
		}
		if (result === "timeout") {
			this.appendKernelDiagnostic(
				`timed out waiting ${timeoutMs}ms for ${tasks.length} host request task(s) during shutdown`,
			);
		}
	}

	/** Resolves true when this call performed the cleanup (false: a concurrent teardown won; a joiner's options are ignored - the first caller's policy wins). */
	async shutdown(opts: KernelShutdownOptions = {}): Promise<boolean> {
		const inFlightShutdown = this.gracefulShutdownPromise;
		if (inFlightShutdown) {
			await inFlightShutdown;
			return false;
		}

		this.teardownInFlight++;
		this.supersedeProtocolRepair();
		const operation = this.performShutdown(opts);
		this.gracefulShutdownPromise = operation;
		try {
			return await operation;
		} finally {
			this.teardownInFlight--;
			if (this.gracefulShutdownPromise === operation) this.gracefulShutdownPromise = undefined;
		}
	}

	private async performShutdown(opts: KernelShutdownOptions): Promise<boolean> {
		this.disposedByHost = true;
		if (this.state === "shutdown") {
			this.intentionalExitOrigin = "shutdown";
			liveKernels.delete(this);
			if (this.gracefulShutdownGeneration === this.startGeneration) return false;
			this.cleanupResources();
			return true;
		}
		// Captured before any await: teardowns and newer starts bump the counter.
		const generation = this.startGeneration;
		if (opts.snapshot) {
			await this.flushSnapshotForDispose();
			if (this.startStale(generation)) return false;
		}
		// Cancel admitted host work (e.g. rlm.run children) before the drain so
		// signal-aware handlers settle promptly instead of riding out the deadline.
		this.abortHostRequests("IPython kernel shut down");
		// Free the runtime's FIFO before asking it to shut down: the queued shutdown
		// request only runs once the active request finishes, so a busy cell would
		// otherwise stall the graceful path all the way to the kill deadline.
		if (this.activeExecution) void this.interrupt().catch(() => undefined);
		// Protocol shutdown first: the runtime closes MCP servers and kills live bash() process groups a bare hard-kill would leak.
		const protocolShutdownAvailable = this.state === "running";
		this.state = "shutdown";
		liveKernels.delete(this);
		this.gracefulShutdownGeneration = generation;
		// Claimed before the kill sequence: the child may exit while this call is still awaiting
		// its reply, and that exit must read as the host's own shutdown rather than a crash.
		this.intentionalExitOrigin = "shutdown";

		let shutdownTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
		let doneWaiterId: string | undefined;
		let performedCleanup = false;
		try {
			if (opts.drainHostRequests) {
				const inFlightHostRequests = [...this.inFlightHostRequests.keys()];
				if (inFlightHostRequests.length > 0) {
					await this.waitForHostRequestsToSettle(inFlightHostRequests, HOST_REQUEST_SHUTDOWN_TIMEOUT_MS);
				}
			}
			if (
				protocolShutdownAvailable &&
				!this.startStale(generation) &&
				this.child?.stdin &&
				!this.child.stdin.destroyed
			) {
				const requestId = uuid();
				doneWaiterId = requestId;
				const doneReply = new Promise<void>((resolve) => {
					this.pendingDoneWaiters.set(requestId, resolve);
				});
				const shutdownDeadline = new Promise<never>((_resolve, reject) => {
					shutdownTimer = globalThis.setTimeout(
						() => reject(new Error(`Kernel did not shut down within ${KERNEL_SHUTDOWN_TIMEOUT_MS}ms`)),
						KERNEL_SHUTDOWN_TIMEOUT_MS,
					);
					shutdownTimer.unref?.();
				});
				const send = this.writeLine({ type: "shutdown", id: requestId });
				send.catch(() => undefined);
				const kernelExit = this.waitForKernelExit();
				const gracefulReply = Promise.all([send, doneReply]);
				gracefulReply.catch(() => undefined);
				await Promise.race([gracefulReply, kernelExit, shutdownDeadline]);
				await Promise.race([kernelExit, shutdownDeadline]);
			}
		} catch (error) {
			this.appendKernelDiagnostic(
				`graceful shutdown failed (killing instead): ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (shutdownTimer) globalThis.clearTimeout(shutdownTimer);
			if (doneWaiterId) this.pendingDoneWaiters.delete(doneWaiterId);
			if (this.gracefulShutdownGeneration === generation) this.gracefulShutdownGeneration = undefined;
			if (!this.startStale(generation)) {
				await this.terminateKernelProcess();
				this.cleanupResources();
				performedCleanup = true;
			}
		}

		return performedCleanup;
	}

	/**
	 * Bounded kill escalation for a kernel that did not exit gracefully: SIGTERM,
	 * wait for a confirmed exit, then SIGKILL and wait again. A cell may rebind or
	 * ignore signal handlers in-process, so TERM alone is not a guaranteed kill;
	 * waiting on each step keeps teardown observers from racing a half-dead child.
	 */
	private async terminateKernelProcess(): Promise<void> {
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		try {
			child.kill("SIGTERM");
		} catch {
			// The kernel has already exited.
		}
		if (await this.waitForChildExit(child, KERNEL_TERM_GRACE_MS)) return;
		this.appendKernelDiagnostic(`kernel did not exit within ${KERNEL_TERM_GRACE_MS}ms of SIGTERM; sending SIGKILL`);
		try {
			child.kill("SIGKILL");
		} catch {
			// The kernel has already exited.
		}
		if (!(await this.waitForChildExit(child, KERNEL_KILL_GRACE_MS))) {
			this.appendKernelDiagnostic("kernel did not exit after SIGKILL; giving up waiting");
		}
	}

	/** Resolves true when the child exits within the timeout (already exited: true). */
	private waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
		if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (exited: boolean) => {
				if (settled) return;
				settled = true;
				globalThis.clearTimeout(timer);
				child.removeListener("exit", onExit);
				resolve(exited);
			};
			const onExit = () => finish(true);
			child.once("exit", onExit);
			const timer = globalThis.setTimeout(() => finish(false), timeoutMs);
			timer.unref?.();
		});
	}

	async restart(): Promise<void> {
		// A final dispose flush owns the queue tail. Taking a slot now and joining
		// the in-flight shutdown would deadlock: the flush's snapshot waits on our
		// slot while we wait on the flush's shutdown.
		if (this.flushingSnapshotForDispose) {
			throw new Error("Kernel is shutting down");
		}
		const prev = this.executionQueue;
		let resolveNext: () => void = () => {};
		this.executionQueue = new Promise<void>((r) => {
			resolveNext = r;
		});
		await prev;

		try {
			const performedCleanup = await this.shutdown();
			if (!performedCleanup) return;
			// An explicit restart is the host asking for a kernel again, so the teardown it just
			// performed does not stand as a permanent verdict.
			this.disposedByHost = false;
			this.state = "idle";
			this.kernelStderr = "";
			this.kernelDiagnostics = "";
			await this.start();
		} finally {
			resolveNext();
		}
	}

	async kill(origin: KernelIntentionalExitOrigin = "kill"): Promise<void> {
		this.supersedeProtocolRepair();
		this.abortHostRequests("IPython kernel killed");
		this.intentionalExitOrigin = origin;
		this.disposedByHost = true;
		this.state = "shutdown";
		liveKernels.delete(this);
		this.cleanupResources("SIGKILL");
	}

	/**
	 * Serialize the user namespace to disk (best-effort, per-variable). No-op when
	 * the kernel isn't running or no snapshot target was configured. Never throws.
	 */
	async snapshotState(): Promise<SnapshotResult | null> {
		return this.captureSnapshot();
	}

	/** Persist the namespace, then remove variables above the per-variable cap. */
	async pruneOversizedVariables(): Promise<SnapshotResult | null> {
		return this.captureSnapshot({ executionTimeoutMs: SNAPSHOT_EXECUTION_TIMEOUT_MS, pruneOversized: true });
	}

	/** The write policy for this kernel's current restore state and negotiated capabilities. */
	private currentSnapshotWritePolicy(): SnapshotWritePolicy {
		return snapshotWritePolicy({
			hasSnapshotConfig: this.options.snapshot !== undefined,
			pendingRestore: this.pendingRestore,
			restoreWriteBlocked: this.restoreWriteBlocked,
			unrestoredNames: [...this.unrestoredNames],
			// A runtime that never announced the capability would ignore preserve_names and
			// drop those blobs, which is worse than not writing: keep the ban for it.
			preserveNamesSupported: this.negotiatedCapabilities?.preserveNames ?? false,
		});
	}

	/**
	 * Wall clock of the write that produced the payload on disk, or undefined when this host
	 * cannot tell.
	 *
	 * The manifest the runtime writes next to the payload is the primary source: it survives the
	 * process boundary a `--resume` crosses, which is exactly where this host has no write of its
	 * own to report. A runtime that records no timestamp falls back to this process's last
	 * successful write, then to the payload's own modification time. The answer feeds the reset
	 * notice, which used to assert a fixed debounce instead of the age it can actually measure.
	 */
	private snapshotWrittenAt(): number | undefined {
		const cfg = this.options.snapshot;
		if (!cfg) return undefined;
		const fromManifest = readSnapshotManifest(cfg.manifestPath)?.writtenAtMs;
		if (fromManifest !== undefined) return fromManifest;
		if (this.lastSnapshotWrittenAt !== undefined) return this.lastSnapshotWrittenAt;
		try {
			return statSync(cfg.path).mtimeMs;
		} catch {
			return undefined;
		}
	}

	/**
	 * Report a refused write. The in-memory stderr ring this also writes to never leaves the
	 * process, so a skipped snapshot used to be invisible everywhere; one session-log line per
	 * reason makes it countable, and a successful write re-arms the report.
	 */
	private reportSnapshotSkipped(reason: SnapshotWriteBlockReason): void {
		this.appendKernelDiagnostic(`state snapshot skipped: ${reason}, so the on-disk snapshot is preserved`);
		if (this.reportedSnapshotSkipReason === reason) return;
		this.reportedSnapshotSkipReason = reason;
		kernelLog.warn("kernel state snapshot skipped", {
			reason,
			names: [...this.unrestoredNames],
			sessionId: this.options.sessionId,
		});
	}

	private async captureSnapshot(
		options: { executionTimeoutMs?: number; pruneOversized?: boolean; final?: boolean } = {},
	): Promise<SnapshotResult | null> {
		const cfg = this.options.snapshot;
		if (!cfg || !this.isRunning) return null;
		const policy = this.currentSnapshotWritePolicy();
		if (!policy.write) {
			this.reportSnapshotSkipped(policy.reason);
			return null;
		}
		this.reportedSnapshotSkipReason = undefined;
		try {
			const r = await this.enqueueRequest(
				{
					type: "snapshot",
					path: cfg.path,
					manifest_path: cfg.manifestPath,
					max_bytes: cfg.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES,
					max_variable_bytes: cfg.maxVariableBytes ?? DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
					prune_oversized: options.pruneOversized ?? false,
					// The terminal (dispose) flush asks the runtime to skip its snapshot replay
					// shortcut: an in-place mutation by a background thread after the last snapshot
					// is invisible to that shortcut's fingerprints, and this write is the last word
					// on the namespace. Additive and deliberately ungated - a runtime without the
					// shortcut has nothing to bypass and ignores the key (unlike preserve_names,
					// where being ignored would lose data).
					...(options.final ? { final: true } : {}),
					// Sent only for names that need it, and only to a runtime that announced the
					// capability (see currentSnapshotWritePolicy).
					...(policy.preserveNames.length > 0 ? { preserve_names: policy.preserveNames } : {}),
				},
				"",
				{ internal: true },
				options.executionTimeoutMs,
			);
			if (r.status !== "ok" || !r.doneFields) {
				const reason = r.status === "aborted" ? "timed out" : "failed";
				const detail = r.error?.evalue ?? r.stderr;
				this.appendKernelDiagnostic(`state snapshot ${reason}: ${detail}`);
				kernelLog.warn("kernel state snapshot failed", {
					reason,
					detail,
					sessionId: this.options.sessionId,
				});
				// RT-2: one model-visible receipt per failure episode (a successful write
				// re-arms it below). Compaction already reports its own null write; this
				// path is the ordinary debounced write, which used to stay invisible.
				if (!this.reportedSnapshotFailure) {
					this.reportedSnapshotFailure = true;
					this.options.onSnapshotFailure?.(`${reason}: ${detail ?? "unknown error"}`);
				}
				return null;
			}
			const pruned = asStringArray(r.doneFields.pruned);
			// What the runtime actually carried over: a size cap may have dropped the oldest
			// preserved names, and reporting the request list instead would claim a save that
			// did not happen.
			const preserved = asStringArray(r.doneFields.preserved);
			if (preserved.length > 0) {
				kernelLog.info("kernel state snapshot preserved unrestored names", {
					count: preserved.length,
					names: preserved,
					sessionId: this.options.sessionId,
				});
			}
			const skipped = asReasonArray(r.doneFields.skipped);
			// The write-side report used to be returned to nobody: a name this snapshot could not
			// serialize vanished with no log line and no notice. Record it, report it once per
			// write, and keep it as the fallback for a notice when the manifest cannot be read.
			// A preserved name is in the payload (carried over verbatim), so it is not dropped.
			const preservedSet = new Set(preserved);
			this.lastSnapshotWrittenAt = Date.now();
			this.reportedSnapshotFailure = false;
			this.lastSnapshotNotSaved = skipped.filter((entry) => !preservedSet.has(entry.name));
			if (this.lastSnapshotNotSaved.length > 0) {
				const names = this.lastSnapshotNotSaved.map((entry) => entry.name);
				this.appendKernelDiagnostic(
					`state snapshot did not save ${this.lastSnapshotNotSaved.length} name(s): ${this.lastSnapshotNotSaved
						.map((entry) => `${entry.name} (${entry.reason})`)
						.join("; ")}`,
				);
				kernelLog.warn("kernel state snapshot could not save names", {
					names,
					sessionId: this.options.sessionId,
				});
			}
			return {
				saved: asStringArray(r.doneFields.saved),
				skipped,
				pruned: pruned.length > 0 ? pruned : undefined,
				preserved: preserved.length > 0 ? preserved : undefined,
				bytes: typeof r.doneFields.bytes === "number" ? r.doneFields.bytes : 0,
				path: cfg.path,
			};
		} catch (error) {
			this.appendKernelDiagnostic(`state snapshot error: ${errorMessage(error)}`);
			kernelLog.warn("kernel state snapshot error", {
				error: errorMessage(error),
				sessionId: this.options.sessionId,
			});
			return null;
		}
	}

	/**
	 * Revive a previously snapshotted namespace into the kernel. Call right after
	 * start() and before the runtime bootstrap, which then refreshes live handles
	 * (rlm, skills) over anything restored. Never throws.
	 */
	async restoreState(): Promise<RestoreResult | null> {
		return this.performRestore(false);
	}

	/**
	 * Every restore (resume and repair alike) is bounded so a stalled kernel cannot wedge it.
	 *
	 * A bound that trips is a *slow* payload, not a corrupt one (B5): a cold read of a large
	 * snapshot can outlast the ordinary repair budget, and renaming the payload aside because it
	 * was slow would destroy good state to answer a timeout. So a timeout retries once with the
	 * longer window and never isolates; only a payload that actually failed to load is isolated,
	 * and a load the host's own teardown cut short is not a failure of the payload either (see
	 * {@link isolateFailedSnapshot}).
	 */
	private async performRestore(protocolRepair: boolean): Promise<RestoreResult | null> {
		const cfg = this.options.snapshot;
		if (!cfg) return null;
		const timeoutMs = cfg.restoreTimeoutMs ?? REPAIR_STEP_TIMEOUT_MS;
		const first = await this.runRestoreAttempt(cfg, protocolRepair, timeoutMs);
		this.lastRestoreTimedOut = first.timedOut;
		this.lastRestoreResult = first.result;
		if (!first.timedOut) {
			this.lastRestoreRetried = false;
			return first.result;
		}
		const retryMs = cfg.restoreRetryTimeoutMs ?? timeoutMs * RESTORE_RETRY_TIMEOUT_MULTIPLIER;
		this.appendKernelDiagnostic(
			`state restore timed out after ${timeoutMs}ms; keeping the snapshot in place and retrying with ${retryMs}ms`,
		);
		const retry = await this.runRestoreAttempt(cfg, protocolRepair, retryMs);
		this.lastRestoreRetried = true;
		this.lastRestoreTimedOut = retry.timedOut;
		this.lastRestoreResult = retry.result;
		if (retry.timedOut) {
			// Still owed: writes stay paused so the newer payload on disk is not overwritten by a
			// namespace that never caught up with it, and the notice tells the model so.
			this.restoreTimedOut = true;
			this.appendKernelDiagnostic(
				`state restore timed out again after ${retryMs}ms; the snapshot is kept and stays unrestored`,
			);
		}
		return retry.result;
	}

	/** One bounded restore request. `timedOut` distinguishes a slow payload from a broken one. */
	private async runRestoreAttempt(
		cfg: NonNullable<KernelManagerOptions["snapshot"]>,
		protocolRepair: boolean,
		timeoutMs: number,
	): Promise<{ result: RestoreResult | null; timedOut: boolean }> {
		// RT-3: forward the writing interpreter's version so the runtime can refuse to
		// revive by-value functions and classes pickled under a different major.minor
		// line. Additive and ungated: a runtime without the field keeps today's
		// behaviour, and an old host simply never sends it.
		const payloadPythonVersion = readSnapshotManifest(cfg.manifestPath)?.pythonVersion;
		try {
			const r = await this.enqueueRequest(
				{
					type: "restore",
					path: cfg.path,
					...(payloadPythonVersion !== undefined ? { python_version: payloadPythonVersion } : {}),
				},
				"",
				{ internal: true, protocolRepair },
				timeoutMs,
			);
			if (r.status === "aborted") {
				this.appendKernelDiagnostic(`state restore timed out after ${timeoutMs}ms`);
				return { result: null, timedOut: true };
			}
			if (r.status !== "ok" || !r.doneFields) {
				const reason = r.error?.evalue ?? r.stderr ?? "failed";
				this.appendKernelDiagnostic(`state restore failed: ${reason}`);
				this.isolateFailedSnapshot(cfg, reason);
				return { result: null, timedOut: false };
			}
			this.restoreTimedOut = false;
			// The namespace caught up with the payload, so a write block left behind by an
			// earlier failed or timed-out load has nothing left to protect.
			this.restoreWriteBlocked = false;
			this.clearPendingRestore();
			const restored = asStringArray(r.doneFields.restored);
			const failed = asReasonArray(r.doneFields.failed);
			// RT-5: names the runtime revived with reduced semantics (a by-value function
			// carrying a frozen copy of its namespace). The runtime already keeps them out
			// of `restored`; the host just has to carry the reason through.
			const degraded = asReasonArray(r.doneFields.degraded);
			// A partial revive no longer freezes persistence. The names that did not come back
			// are remembered so later snapshots ask the runtime to carry their saved blobs over
			// verbatim: new work is persisted, the unrestorable blobs are not overwritten, and a
			// later restore still fails on those same names instead of pretending they are fine.
			// A fully successful restore clears the set and returns to whole-namespace writes.
			this.unrestoredNames.clear();
			for (const failure of failed) this.unrestoredNames.add(failure.name);
			const snapshotPolicy = this.currentSnapshotPolicyAfterRestore(failed.length);
			// Names the payload never held cannot come back through `failed` (the runtime only
			// reports what it tried to load), so they are read from the manifest that belongs to
			// this payload and reported alongside. The in-process record of the last write covers
			// a manifest that cannot be read; both describe the same payload.
			const notSaved = readSnapshotManifest(cfg.manifestPath)?.notSaved ?? this.lastSnapshotNotSaved;
			return {
				result: {
					restored,
					failed,
					path: cfg.path,
					...(snapshotPolicy ? { snapshotPolicy } : {}),
					...(notSaved.length > 0 ? { notSaved: [...notSaved] } : {}),
					...(degraded.length > 0 ? { degraded } : {}),
				},
				timedOut: false,
			};
		} catch (error) {
			this.appendKernelDiagnostic(`state restore error: ${errorMessage(error)}`);
			this.isolateFailedSnapshot(cfg, errorMessage(error));
			return { result: null, timedOut: false };
		}
	}

	/**
	 * Whether the host is tearing this kernel down (shutdown/kill/disposeSync). Every teardown
	 * raises these before it can reject an in-flight request, so a request that fails inside this
	 * window was cut short by the host and says nothing about the payload it was carrying.
	 */
	private get hostTeardownInProgress(): boolean {
		return this.disposedByHost || this.teardownInFlight > 0;
	}

	/** Rename a snapshot that failed to load so a later write can replace it. */
	private isolateFailedSnapshot(cfg: { path: string; manifestPath: string }, reason: string): void {
		if (this.hostTeardownInProgress) {
			// Not a verdict on the payload: the load never finished, so the namespace is still
			// older than what is on disk. Leave the file under its real name for the next kernel
			// to load, and keep writes paused so a teardown's final snapshot of the empty
			// namespace cannot replace it.
			this.restoreWriteBlocked = true;
			this.appendKernelDiagnostic(
				`state restore interrupted by kernel teardown; keeping the snapshot at ${cfg.path}: ${reason}`,
			);
			kernelLog.warn("kernel state restore interrupted by teardown; snapshot kept", {
				path: cfg.path,
				reason,
				sessionId: this.options.sessionId,
			});
			return;
		}
		try {
			const isolated = isolateCorruptSnapshot(cfg.path, cfg.manifestPath);
			this.restoreWriteBlocked = false;
			this.restoreTimedOut = false;
			this.clearPendingRestore();
			// The payload that held those names is gone; nothing is left to preserve.
			this.unrestoredNames.clear();
			const isolatedPath = isolated.isolatedPath ?? `${cfg.path} (missing)`;
			this.appendKernelDiagnostic(`state restore failed; isolated corrupt snapshot to ${isolatedPath}: ${reason}`);
			kernelLog.warn("kernel state restore failed; snapshot isolated", {
				isolatedPath,
				reason,
				sessionId: this.options.sessionId,
			});
		} catch (error) {
			this.restoreWriteBlocked = true;
			this.restoreTimedOut = false;
			this.appendKernelDiagnostic(
				`state restore failed; could not isolate snapshot at ${cfg.path}: ${errorMessage(error)}`,
			);
			kernelLog.error("kernel state restore failed; snapshot could not be isolated", {
				path: cfg.path,
				error: errorMessage(error),
				sessionId: this.options.sessionId,
			});
		}
	}

	/**
	 * How the next snapshot will treat names that failed to revive, for the model-facing
	 * notice: preserving needs the runtime capability, otherwise writes stay paused.
	 */
	private currentSnapshotPolicyAfterRestore(failedCount: number): SnapshotPolicyAfterPartialRestore | undefined {
		if (failedCount === 0) return undefined;
		return this.negotiatedCapabilities?.preserveNames ? "preserve-names" : "write-blocked";
	}

	/** Live user-defined top-level names, or null if the kernel isn't running. Never throws. */
	async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
		if (!this.isRunning) return null;
		try {
			const r = await this.enqueueRequest({ type: "list_names" }, "", { internal: true, signal });
			if (r.status !== "ok" || !r.doneFields) {
				this.appendKernelDiagnostic(`namespace listing failed: ${r.error?.evalue ?? r.stderr}`);
				return null;
			}
			return asStringArray(r.doneFields.names);
		} catch (error) {
			this.appendKernelDiagnostic(`namespace listing error: ${errorMessage(error)}`);
			return null;
		}
	}

	private scheduleSnapshot(): void {
		const cfg = this.options.snapshot;
		if (!cfg) return;
		// A namespace that was never revived — or one this runtime cannot preserve the
		// unrestored names of — is older than the on-disk snapshot; never overwrite it.
		const policy = this.currentSnapshotWritePolicy();
		if (!policy.write) {
			this.reportSnapshotSkipped(policy.reason);
			return;
		}
		this.reportedSnapshotSkipReason = undefined;
		if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
		this.snapshotTimer = globalThis.setTimeout(() => {
			this.snapshotTimer = undefined;
			void this.captureSnapshot({ executionTimeoutMs: SNAPSHOT_EXECUTION_TIMEOUT_MS });
		}, cfg.debounceMs ?? DEFAULT_SNAPSHOT_DEBOUNCE_MS);
		if (this.snapshotTimer && typeof this.snapshotTimer === "object" && "unref" in this.snapshotTimer) {
			this.snapshotTimer.unref();
		}
	}

	private clearSnapshotTimer(): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = undefined;
		}
	}

	private flushSnapshotForDispose(): Promise<void> {
		// Concurrent teardowns (dispose vs a signal-handler shutdown) join one flush:
		// a second flusher would clear the execution guard while the first is still
		// snapshotting and enqueue a duplicate final snapshot behind it.
		this.snapshotFlushForDispose ??= this.runSnapshotFlushForDispose().finally(() => {
			this.snapshotFlushForDispose = undefined;
		});
		return this.snapshotFlushForDispose;
	}

	private async runSnapshotFlushForDispose(): Promise<void> {
		if (!this.options.snapshot || !this.isRunning) return;
		// A kernel that never restored the saved namespace must not overwrite it:
		// the on-disk snapshot is strictly fresher than this namespace. A restore that
		// failed to load the payload must not write either, but it still settles the queue
		// here — skipping the wait would let the teardown race and kill in-flight work
		// (e.g. the lazy re-bootstrap); captureSnapshot enforces the write policy.
		if (this.pendingRestore) return;
		// Block new external executions so none can splice ahead of the final snapshot and stall dispose.
		this.flushingSnapshotForDispose = true;
		try {
			const pendingExecutions = this.executionQueue;
			if (this.activeExecution) void this.interrupt().catch(() => undefined);
			let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
			const queueSettled = await Promise.race([
				pendingExecutions.then(() => true),
				new Promise<false>((resolve) => {
					timeout = globalThis.setTimeout(() => resolve(false), SNAPSHOT_EXECUTION_TIMEOUT_MS);
					timeout.unref?.();
				}),
			]);
			if (timeout) globalThis.clearTimeout(timeout);
			if (!queueSettled) return;
			// Terminal write: `final` keeps the runtime from answering it out of its replay
			// shortcut, so a background mutation since the last snapshot still lands on disk.
			await this.captureSnapshot({ executionTimeoutMs: SNAPSHOT_EXECUTION_TIMEOUT_MS, final: true });
		} finally {
			// Reset: a superseding start() can revive this kernel for new work.
			this.flushingSnapshotForDispose = false;
		}
	}

	/** Synchronous best-effort cleanup. Safe to call from `process.on('exit')`. */
	disposeSync(): void {
		this.supersedeProtocolRepair();
		this.abortHostRequests("IPython kernel disposed");
		this.intentionalExitOrigin = "dispose_sync";
		this.disposedByHost = true;
		this.state = "shutdown";
		liveKernels.delete(this);
		this.cleanupResources();
	}

	get isRunning(): boolean {
		return this.state === "running";
	}

	/**
	 * The host tore this kernel down (kill, shutdown or disposeSync), so this instance will not
	 * serve another cell: `start()` treats the terminal state as a permanent verdict and only
	 * {@link restart} clears it. An owner that memoizes its client - the ipython provisioner -
	 * reads this to drop the memo and provision a replacement instead of handing the next cell a
	 * manager that can only throw.
	 */
	get isDefunct(): boolean {
		return this.disposedByHost;
	}
}
