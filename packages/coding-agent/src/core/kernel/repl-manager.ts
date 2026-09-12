// Kernel client for the REPL runtime: the kernel is a JSON-lines subprocess
// (`python -m rlm.repl`) — requests on stdin, events on stdout, the process's stderr
// appended to a per-session log file (the in-memory tail holds host diagnostics only).
// The protocol is documented in prime-agent-runtime/src/rlm/repl.md.
import { type ChildProcess, spawn } from "node:child_process";
import {
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fstatSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getLogger } from "@earendil-works/pi-ai";
import { v4 as uuid } from "uuid";
import { DEFAULT_SHORT_TARGET_WAIT_MS, withBound } from "../../utils/bounded-wait.js";
import { assertRegularFileNoSymlink, ensurePrivateDirectory, requireNoFollow } from "../../utils/private-files.js";
import { reapKernelOrphanProcesses, recordOrphanProcessState } from "../orphan-process-journal.js";
import { ensureKernelPython, KERNEL_PYTHON_SAFE_PATH_ARGS, managedKernelVenvDirForPython } from "./bootstrap.js";
import {
	classifyKernelExit,
	type KernelDeathCause,
	type KernelHostRequestFact,
	type KernelIntentionalExitOrigin,
	type KernelUnexpectedExitFacts,
} from "./death-cause.js";
import { KernelUnavailableError } from "./errors.js";
import { formatKernelResetNotice, type KernelResetNoticeFacts } from "./reset-notice.js";
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
	type SnapshotPolicyAfterPartialRestore,
	type SnapshotResult,
	type SnapshotWriteBlockReason,
	type SnapshotWritePolicy,
	snapshotWritePolicy,
} from "./state-snapshot.js";
import { recordKernelVenvInUseSync, releaseKernelVenvInUseSync } from "./venv-in-use.js";

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
/** Heartbeat period the runtime uses by default; every frame carries the kernel's own value. */
export const DEFAULT_KERNEL_HEARTBEAT_INTERVAL_MS = 5_000;
/** A heartbeat older than this many of its own intervals is stale and stops vouching for work. */
export const KERNEL_LIVENESS_STALE_INTERVALS = 3;
/** Minimum gap between two retained samples, so a kernel that floods frames cannot churn the host. */
const KERNEL_LIVENESS_MIN_SAMPLE_GAP_MS = 1_000;
/** Retained samples: enough to diff progress, few enough to stay O(1). */
const KERNEL_LIVENESS_MAX_SAMPLES = 2;
/** Rejection streaks are logged at 1 and then every N, so a broken runtime cannot flood the log. */
const KERNEL_LIVENESS_REJECT_LOG_EVERY = 50;
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

const MAX_KERNEL_STDERR_CHARS = 8 * 1024;
const MAX_KERNEL_STDERR_LOG_BYTES = 5 * 1024 * 1024;
// Startup-failure report size, split so host diagnostics and the kernel's own tail each
// keep a quota and neither can crowd the other out of the window.
const MAX_KERNEL_STDERR_REPORT_CHARS = 1024;
const KERNEL_STDERR_HOST_TAIL_CHARS = 256;
// O_NONBLOCK degrades to 0 on win32 (as in private-files.ts): a no-op on regular files,
// but a planted FIFO then fails at once instead of blocking the event loop.
const NONBLOCK_FLAG = constants.O_NONBLOCK ?? 0;

/** A kernel revival that has not been reported to the model yet. */
interface PendingRestartNotice extends Omit<KernelResetNoticeFacts, "restore" | "restoreTimedOut" | "repeatedCell"> {
	/** Source of the cell that was running when the kernel died, for the repeat check. */
	repeatedCellCode?: string;
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
	private kernelStderr = "";
	/** Byte offset this spawn's kernel started at in the stderr log, so a failure report
	 * never shows a previous incarnation's bytes; undefined when this spawn has no log fd. */
	private stderrLogWindowStart?: number;
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
	/** Every unexpected exit inside the budget window, oldest first (C8). */
	private readonly unexpectedExits: KernelDeathCause[] = [];

	/** Revival facts awaiting the next cell that reaches the model; consumed once. */
	private pendingRestartNotice?: PendingRestartNotice;
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
	/** A whole-payload load failed and the on-disk snapshot could not be isolated: the namespace
	 * is older than that snapshot, so no snapshot write may overwrite it. Isolating the file
	 * clears this flag so a rebuilt namespace can persist again. */
	private restoreWriteBlocked = false;
	/** Names the last restore could not revive. Later snapshots ask the runtime to carry their
	 * saved blobs over verbatim instead of banning every write; a fully successful restore, or
	 * isolating the payload, clears the set. */
	private readonly unrestoredNames = new Set<string>();
	/** Last skipped-write reason already sent to the session log, so a blocked session logs the
	 * state change once instead of once per cell. */
	private reportedSnapshotSkipReason?: SnapshotWriteBlockReason;
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
			restartPolicy: options.restartPolicy,
			cancellableHostRequestTypes: options.cancellableHostRequestTypes,
			readOnlyHostRequestTimeoutMs: options.readOnlyHostRequestTimeoutMs,
			onLateHostReply: options.onLateHostReply,
		};
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
		return oldest === undefined ? undefined : Math.max(0, Date.now() - oldest);
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
		const pending = this.pendingRestartNotice;
		if (!pending) return undefined;
		this.pendingRestartNotice = undefined;
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
	 * Whether the newest heartbeat reports live `bash()` handles. Deliberately not folded into the
	 * session's `isBashRunning`, which reports the host's own bash tool: a kernel handle has a
	 * different owner, and that field's meaning is already read by the UI.
	 */
	get isKernelBashRunning(): boolean {
		return (this.livenessSamples[0]?.bashHandles ?? 0) > 0;
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
		if (latest && now - latest.receivedAt < KERNEL_LIVENESS_MIN_SAMPLE_GAP_MS) {
			// Well-formed, but too close to the retained sample to add a fact: keeping the newer
			// one out of the diff pair bounds the host's work no matter how fast a kernel sends.
			// The retained sample stays under a second old, so throttling cannot age it into
			// looking stale.
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

	private appendKernelDiagnostic(message: string): void {
		this.appendKernelStderrText(`[kernel] ${message.endsWith("\n") ? message : `${message}\n`}`);
	}

	private appendKernelStderrText(text: string): void {
		this.kernelStderr = (this.kernelStderr + text).slice(-MAX_KERNEL_STDERR_CHARS);
	}

	/**
	 * The runtime dup2's fd 2 into its protocol pump before ready (repl.py
	 * _setup_fds), so this file only ever receives startup-bounded pre-ready
	 * bytes; rotating once per spawn is enough.
	 */
	private openStderrLogFd(): number | undefined {
		const path = this.options.stderrLogPath;
		this.stderrLogWindowStart = undefined;
		if (!path) return undefined;
		try {
			ensurePrivateDirectory(dirname(path));
			const exists = existsSync(path);
			// Refuse a planted non-regular file before anything touches it: O_NOFOLLOW covers
			// symlinks only (and degrades to 0 on win32), and opening a FIFO O_WRONLY would
			// block the event loop inside the kernel boot permit.
			if (exists) assertRegularFileNoSymlink(path);
			if (exists && statSync(path).size > MAX_KERNEL_STDERR_LOG_BYTES) {
				try {
					// Drop any prior .old first: rename fails on Windows if it exists.
					rmSync(`${path}.old`, { force: true });
					renameSync(path, `${path}.old`);
				} catch (error) {
					// A failed rotation must not cost the log: keep appending instead.
					this.appendKernelDiagnostic(`cannot rotate kernel stderr log: ${errorMessage(error)}`);
				}
			}
			// Fork policy (#1249 private session files): 0600, and refuse a planted
			// symlink. openSync's mode only applies at creation and this log survives
			// across spawns, so re-assert the mode on the descriptor. requireNoFollow
			// degrades to 0 on win32, matching orphan-process-journal.
			const fd = openSync(
				path,
				constants.O_WRONLY |
					constants.O_APPEND |
					constants.O_CREAT |
					requireNoFollow(constants.O_NOFOLLOW) |
					NONBLOCK_FLAG,
				0o600,
			);
			if (process.platform !== "win32") fchmodSync(fd, 0o600);
			// O_APPEND put the write offset at EOF, so this is exactly the byte the kernel starts at.
			this.stderrLogWindowStart = fstatSync(fd).size;
			return fd;
		} catch (error) {
			this.appendKernelDiagnostic(`cannot open kernel stderr log: ${errorMessage(error)}`);
			return undefined;
		}
	}

	private stderrTail(): string {
		let fileTail = "";
		const windowStart = this.stderrLogWindowStart;
		if (this.options.stderrLogPath && windowStart !== undefined) {
			try {
				// Positional read of this spawn's bytes only: a kernel that spewed until the
				// ready timeout can leave a log far too large to read whole, and the log
				// survives across spawns, so the window starts where this kernel started.
				assertRegularFileNoSymlink(this.options.stderrLogPath);
				const fd = openSync(this.options.stderrLogPath, constants.O_RDONLY | requireNoFollow(constants.O_NOFOLLOW));
				try {
					const size = fstatSync(fd).size;
					const start = Math.min(windowStart, size);
					const length = Math.min(size - start, MAX_KERNEL_STDERR_REPORT_CHARS - KERNEL_STDERR_HOST_TAIL_CHARS);
					const buffer = Buffer.alloc(length);
					// A short read (the file shrank under us) must not surface as NUL padding.
					const bytesRead = readSync(fd, buffer, 0, length, size - length);
					fileTail = buffer.toString("utf8", 0, bytesRead);
				} finally {
					closeSync(fd);
				}
			} catch {
				// Unreadable log; the host diagnostics still surface on their own.
			}
		}
		return `${this.kernelStderr.slice(-KERNEL_STDERR_HOST_TAIL_CHARS)}${fileTail}`;
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

		const stderrLogFd = this.openStderrLogFd();
		let child: ChildProcess;
		try {
			// Safe path: the session cwd must never sit at sys.path[0], or a checkout
			// could substitute its own rlm/, dill.py, or stdlib-named module for the
			// runtime's own imports (symptom: "Kernel exited before ready", pointing
			// nowhere near the real cause).
			child = spawn(python, [...KERNEL_PYTHON_SAFE_PATH_ARGS, "-m", "rlm.repl"], {
				cwd: this.options.cwd,
				// bash.py journals its process groups under this pid so the host can
				// reap them if the runtime dies without running its shutdown hook.
				env: {
					...process.env,
					...this.options.env,
					// The runtime clamps this into the range it speaks and reports the
					// negotiated value in its ready frame; an older runtime ignores it.
					[KERNEL_PROTOCOL_ENV_VAR]: requestedKernelProtocol(this.options.env),
					PRIME_AGENT_KERNEL_OWNER_PID: String(process.pid),
				},
				stdio: ["pipe", "pipe", stderrLogFd ?? "pipe"],
			});
		} finally {
			if (stderrLogFd !== undefined) closeSync(stderrLogFd);
		}
		this.child = child;
		// A fresh spawn owns its own exit: a marker left over from the previous teardown must not
		// excuse a real crash of this child.
		this.intentionalExitOrigin = undefined;
		if (child.pid !== undefined) {
			recordOrphanProcessState(child.pid, true);
			this.inUseReferencePath = this.recordVenvInUseReference(child.pid);
		}
		this.readyDeferred = createDeferred<number>();
		this.startupProtocolError = undefined;
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
			if (this.startStale(generation)) throw e; // never tear down a newer start's kernel
			const canRetryStartup = (this.state as string) !== "shutdown";
			// Only the call that performed the cleanup may resurrect to idle; a
			// concurrent kill()/teardown owns the state otherwise.
			if ((await this.shutdown()) && canRetryStartup) {
				// The teardown here is this failed start's own cleanup, not a host verdict: the
				// manager stays reusable, so it must also stay revivable.
				this.disposedByHost = false;
				this.state = "idle";
			}
			throw e;
		}

		this.state = "running";
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

	private wireChild(child: ChildProcess): void {
		const decoder = new StringDecoder("utf8");
		let buffered = "";
		child.stdout?.on("data", (buf: Buffer) => {
			if (this.child !== child) return;
			buffered += decoder.write(buf);
			let newline = buffered.indexOf("\n");
			while (newline !== -1) {
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
				const invalidReason = invalidProtocolFrameReason(event, this.negotiatedProtocol);
				if (invalidReason) {
					this.failProtocolFrame(child, `${invalidReason}: ${line.slice(0, 200)}`);
					return;
				}
				this.handleEvent(event);
			}
		});

		child.stderr?.on("data", (buf: Buffer) => {
			this.appendKernelStderrText(buf.toString());
		});

		// A write into a kernel that already died surfaces as an 'error' event on the
		// pipe (write EPIPE). Without a listener Node rethrows it as an uncaught
		// exception, and this worker's crash handler turns that into process.exit(1) -
		// taking every other session the worker hosts with it. The pending writeLine
		// rejection and the exit handler below own the fallout; this records the cause.
		child.stdin?.on("error", (error) => {
			if (this.child !== child) return;
			this.appendKernelDiagnostic(`kernel stdin error: ${errorMessage(error)}`);
		});
		child.stdout?.on("error", (error) => {
			if (this.child !== child) return;
			this.appendKernelDiagnostic(`kernel stdout error: ${errorMessage(error)}`);
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
		// crash it survived hours ago.
		const windowStart = cause.at - policy.windowMs;
		while (this.unexpectedExits.length > 0 && (this.unexpectedExits[0]?.at ?? 0) < windowStart) {
			this.unexpectedExits.shift();
		}
		const previous = this.unexpectedExits[this.unexpectedExits.length - 1];
		this.unexpectedExits.push(cause);
		const unresolvedHostRequests: KernelHostRequestFact[] = [...this.inFlightHostRequests.values()].map(
			(request) => ({
				type: request.type,
				...(request.label === undefined ? {} : { label: request.label }),
				// Conservative by design: a reply that never arrived is not evidence that the
				// work did not happen, and the model is about to be tempted to repeat it (M10c).
				mayHaveTakenEffect: true,
			}),
		);
		const dyingCellCode = this.activeExecution?.code ?? this.lastCellCode;
		// Captured before the teardown rejects the cell: its result is thrown away, so the
		// unattributed output it collected is only visible again if the revival keeps it.
		this.dyingBackgroundOutput = this.activeExecution?.backgroundOutput;
		this.dyingBackgroundOutputTruncated = this.activeExecution?.backgroundOutputTruncated ?? false;
		const restartCount = this.unexpectedExits.length;
		// C8: the budget counts revivals, so the death that exceeds it fails closed instead of
		// arming another one.
		const exhausted = restartCount > policy.maxRestarts;
		this.pendingRestartNotice = {
			cause,
			restartCount,
			snapshotConfigured: this.options.snapshot !== undefined,
			hostRequests: unresolvedHostRequests,
			...(Number.isFinite(policy.maxRestarts) ? { maxRestarts: policy.maxRestarts } : {}),
			windowMinutes: Math.round(policy.windowMs / 60_000),
			...(dyingCellCode === undefined ? {} : { repeatedCellCode: dyingCellCode }),
		};
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

	/** Restart budget in force right now; read at every death so a settings edit applies at once. */
	private currentRestartPolicy(): KernelRestartPolicy {
		const configured = this.options.restartPolicy?.();
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
		if (!this.restartBudgetExhaustedNow()) return new Error("Kernel has been shut down");
		const policy = this.currentRestartPolicy();
		return new KernelUnavailableError({
			restartCount: this.unexpectedExits.length,
			maxRestarts: policy.maxRestarts,
			windowMs: policy.windowMs,
			causes: this.unexpectedExits,
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

	/** Drop the exits that fell out of the sliding window. */
	private pruneUnexpectedExits(at: number): void {
		const windowStart = at - this.currentRestartPolicy().windowMs;
		while (this.unexpectedExits.length > 0 && (this.unexpectedExits[0]?.at ?? 0) < windowStart) {
			this.unexpectedExits.shift();
		}
	}

	/** Whether the budget is spent right now. Live, because the window slides (L3). */
	private restartBudgetExhaustedNow(): boolean {
		this.pruneUnexpectedExits(Date.now());
		return this.unexpectedExits.length > this.currentRestartPolicy().maxRestarts;
	}

	/**
	 * Re-arm a fail-closed session when its window expires (L3). Lazy on purpose: nothing is
	 * scheduled, so a session that never runs another cell never restarts a kernel, and one that
	 * does gets its revival back without a human. Only an exhausted budget is re-armed here - a
	 * kernel the host tore down stays down.
	 */
	private rearmIfRestartBudgetWindowExpired(): void {
		if (this.state !== "shutdown" || this.disposedByHost) return;
		if (this.unexpectedExits.length === 0) return;
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
	 * kernel crash is not a teardown of the family (I-11). Their replies are dropped, which is
	 * what the reset notice reports.
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
					const tail = this.stderrTail();
					reject(new Error(`Kernel exited before ready. stderr:\n${tail || "(empty)"}`));
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
			if (type === "stdout") {
				if (execution.stdout.length < execution.maxChars) {
					execution.stdout += text;
					if (execution.stdout.length > execution.maxChars) {
						execution.stdout = execution.stdout.slice(0, execution.maxChars);
						execution.stdoutTruncated = true;
					}
				}
			} else {
				if (execution.stderr.length < execution.maxChars) {
					execution.stderr += text;
					if (execution.stderr.length > execution.maxChars) {
						execution.stderr = execution.stderr.slice(0, execution.maxChars);
						execution.stderrTruncated = true;
					}
				}
			}
			execution.opts.onStream?.(text, type);
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
		if (result.status === "ok") {
			this.scheduleSnapshot();
		}
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
		handler(sentAgentMessage);
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
			? (this.options.readOnlyHostRequestTimeoutMs?.() ?? DEFAULT_SHORT_TARGET_WAIT_MS)
			: undefined;
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
				try {
					await this.writeLine({ type: "host_reply", id: requestId, data: { status: "ok", result } });
				} catch (replyError) {
					this.reportLateHostReply(requestId, described, true, replyError);
				}
			} catch (error) {
				this.appendKernelDiagnostic(`host request failed for ${requestId}: ${errorMessage(error)}`);
				try {
					await this.writeLine({
						type: "host_reply",
						id: requestId,
						data: { status: "error", error: errorMessage(error) },
					});
				} catch (replyError) {
					this.reportLateHostReply(requestId, described, false, replyError);
				}
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
		// Liveness facts belong to the child that reported them: a replacement kernel must earn
		// its own first frame before anything vouches for it again, and a rejection streak from a
		// broken predecessor must not pre-age the new episode's log throttling.
		this.livenessSamples.length = 0;
		this.rejectedHeartbeatFrames = 0;
		this.consecutiveRejectedHeartbeatFrames = 0;
		this.throttledHeartbeatFrames = 0;
		// A replacement kernel is a new episode: its first refused write must be logged again.
		this.reportedSnapshotSkipReason = undefined;
		if (child) {
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
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
		options: { executionTimeoutMs?: number; pruneOversized?: boolean } = {},
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
			return {
				saved: asStringArray(r.doneFields.saved),
				skipped: asReasonArray(r.doneFields.skipped),
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
	 * longer window and never isolates; only a payload that actually failed to load is isolated.
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
		try {
			const r = await this.enqueueRequest(
				{ type: "restore", path: cfg.path },
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
			// A partial revive no longer freezes persistence. The names that did not come back
			// are remembered so later snapshots ask the runtime to carry their saved blobs over
			// verbatim: new work is persisted, the unrestorable blobs are not overwritten, and a
			// later restore still fails on those same names instead of pretending they are fine.
			// A fully successful restore clears the set and returns to whole-namespace writes.
			this.unrestoredNames.clear();
			for (const failure of failed) this.unrestoredNames.add(failure.name);
			const snapshotPolicy = this.currentSnapshotPolicyAfterRestore(failed.length);
			return {
				result: { restored, failed, path: cfg.path, ...(snapshotPolicy ? { snapshotPolicy } : {}) },
				timedOut: false,
			};
		} catch (error) {
			this.appendKernelDiagnostic(`state restore error: ${errorMessage(error)}`);
			this.isolateFailedSnapshot(cfg, errorMessage(error));
			return { result: null, timedOut: false };
		}
	}

	/** Rename a snapshot that failed to load so a later write can replace it. */
	private isolateFailedSnapshot(cfg: { path: string; manifestPath: string }, reason: string): void {
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
			await this.captureSnapshot({ executionTimeoutMs: SNAPSHOT_EXECUTION_TIMEOUT_MS });
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
