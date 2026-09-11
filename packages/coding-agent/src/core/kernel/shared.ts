import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import type { KernelBootstrapProgressHandler, KernelPythonSkill } from "./bootstrap.js";
import type { KernelDeathCause, KernelUnexpectedExitFacts } from "./death-cause.js";
import type { RestoreResult, SnapshotResult } from "./state-snapshot.js";

export const DEFAULT_MAX_OUTPUT_CHARS = 65536;
export const HOST_REQUEST_SHUTDOWN_TIMEOUT_MS = 5000;
export const KERNEL_SHUTDOWN_TIMEOUT_MS = 5000;
/** How long a SIGTERM'd kernel gets to exit before escalating to SIGKILL. */
export const KERNEL_TERM_GRACE_MS = 2000;
/** How long to wait for a SIGKILL'd kernel's confirmed exit. */
export const KERNEL_KILL_GRACE_MS = 2000;
export const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 1500;
export const SNAPSHOT_EXECUTION_TIMEOUT_MS = 5000;
export const KERNEL_ABORT_GRACE_MS = 1000;
export const KERNEL_BUSY_REUSE_WAIT_MS = 5000;
export const KERNEL_BUSY_INTERRUPT_INTERVAL_MS = 500;
export const MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS = 256;
const KERNEL_BUSY_AFTER_INTERRUPT_MESSAGE =
	"The Python kernel is still running the previously interrupted cell. Wait and try again, or kill the kernel to start fresh.";

export class KernelBusyAfterInterruptError extends Error {
	constructor() {
		super(KERNEL_BUSY_AFTER_INTERRUPT_MESSAGE);
		this.name = "KernelBusyAfterInterruptError";
	}
}

/**
 * Handles one typed request from Python code running in the kernel.
 * The returned record is delivered verbatim to the Python caller.
 * The signal aborts when the kernel host tears down, so long-running
 * handlers (e.g. admitted rlm.run children) can cancel promptly.
 */
export type HostRequestHandler = (
	payload: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

/** Host request handlers keyed by request type (e.g. "rlm.run", "goal.complete"). */
export type HostRequestHandlers = Record<string, HostRequestHandler>;

/** Where and how to persist the kernel's user namespace so it survives resume. */
export interface KernelSnapshotConfig {
	/** Absolute path for the dill payload. */
	path: string;
	/** Absolute path for the JSON manifest written alongside the payload. */
	manifestPath: string;
	/** Maximum aggregate snapshot size. Default 256 MiB. */
	maxBytes?: number;
	/** Maximum serialized size of one variable. Default 16 MiB. */
	maxVariableBytes?: number;
	/** Debounce window for the auto-snapshot after a successful execution. Default 1500 ms. */
	debounceMs?: number;
	/**
	 * Bound for one restore request. Default 30 s. A restore that exceeds it is *slow*, not
	 * corrupt: the payload stays where it is and the attempt is retried with the longer retry
	 * window below (B5).
	 */
	restoreTimeoutMs?: number;
	/** Bound for the retry of a restore that timed out. Default four times `restoreTimeoutMs`. */
	restoreRetryTimeoutMs?: number;
}

export interface KernelManagerOptions {
	/** Python interpreter with the kernel runtime available. Defaults to the auto-bootstrapped kernel. */
	python?: string;
	cwd?: string;
	env?: Record<string, string>;
	sessionId?: string;
	hostHandlers?: HostRequestHandlers;
	pythonSkills?: readonly KernelPythonSkill[];
	/** Persist/revive the user namespace across kernel restarts and session resume. */
	snapshot?: KernelSnapshotConfig;
	/** Runtime bootstrap re-run on a protocol-repaired kernel so live handles (rlm, bash, skills) exist again. */
	bootstrapCode?: string;
	/** File receiving the kernel process's stderr, rotated once at each spawn. */
	stderrLogPath?: string;
	/**
	 * One kernel death the host did not order (a crash, an OOM kill). Fired from the exit
	 * callback before the teardown, so the owner can log a cause that the in-memory stderr ring
	 * would otherwise keep to this process. Never fired for shutdown/kill/disposeSync or for the
	 * protocol-repair kills.
	 */
	onUnexpectedExit?: (cause: KernelDeathCause, facts: KernelUnexpectedExitFacts) => void;
	/**
	 * Live restart-budget policy, read at every unexpected exit so a settings edit applies
	 * without a new kernel. Defaults: {@link DEFAULT_MAX_UNEXPECTED_RESTARTS} revivals inside
	 * {@link DEFAULT_KERNEL_RESTART_WINDOW_MS}. A non-finite `maxRestarts` disables the budget
	 * (the rollback lever for unbounded lazy revival).
	 */
	restartPolicy?: () => KernelRestartPolicy;
	/**
	 * Host request types whose wait may be cancelled by the cell that triggered it (P1-2a).
	 *
	 * Only read-only types belong here. A side-effecting request - `rlm.run` admission, a message
	 * send, a harness write - keeps the teardown-only signal, because the whole point of admitting
	 * it is that the work outlives the turn: the system prompt tells a model to start the work,
	 * record the handle and end the turn, and a user pressing Esc on that cell must not kill the
	 * child it just spawned (M7). An entry ending in `*` is a prefix pattern (`agent_observe.*`).
	 * Absent or empty: nothing is cancellable by a cell abort, which is today's behaviour.
	 */
	cancellableHostRequestTypes?: readonly string[];
	/**
	 * Bound on one read-only (whitelisted) host request, read live so a settings edit applies at
	 * once. Default {@link DEFAULT_SHORT_TARGET_WAIT_MS}. A side-effecting request is never bounded
	 * here: cutting one off mid-flight is exactly what the whitelist exists to prevent.
	 */
	readOnlyHostRequestTimeoutMs?: () => number;
	/**
	 * A host request finished after the kernel that asked for it was gone, so its reply could not
	 * be delivered. The work may well have happened (a child was admitted, a message was sent),
	 * which is why this is reported rather than dropped (I-6).
	 */
	onLateHostReply?: (reply: KernelLateHostReply) => void;
}

/** One host reply that could not be delivered because the kernel was already gone. */
export interface KernelLateHostReply {
	requestId: string;
	type: string;
	/** Target read off the request payload when the type carries one. */
	label?: string;
	/** Whether the handler succeeded; the work happened either way. */
	ok: boolean;
}

/** How often one session may revive its kernel before it fails closed (C8). */
export interface KernelRestartPolicy {
	/** Revivals allowed inside the window; `Infinity` disables the budget. */
	maxRestarts: number;
	/** Rolling window in ms. */
	windowMs: number;
}

/** Default revival budget: three unexpected exits per rolling hour, then fail closed. */
export const DEFAULT_MAX_UNEXPECTED_RESTARTS = 3;
/** Default rolling window for the revival budget. */
export const DEFAULT_KERNEL_RESTART_WINDOW_MS = 60 * 60 * 1000;

export interface KernelStartOptions {
	onBootstrapProgress?: KernelBootstrapProgressHandler;
	signal?: AbortSignal;
}

/**
 * Capability token a kernel announces in its `ready` frame's `capabilities` array when its
 * runtime honours snapshot `preserve_names` (merge-write of unrestorable blobs). Announced
 * per kernel and never inferred from the protocol number: protocol 4 ships before the
 * runtime change that understands the field, and a stale venv still announces 4.
 */
export const KERNEL_CAPABILITY_PRESERVE_NAMES = "preserve_names";

/**
 * What the kernel's `ready` handshake agreed to. Absent until the kernel is ready
 * and cleared on every teardown, so a gated request is never sent on the strength
 * of a previous incarnation's negotiation.
 */
export interface KernelCapabilities {
	/** Protocol version the kernel announced in its `ready` frame. */
	protocol: number;
	/**
	 * True when the negotiated protocol admits the version-4 additions. Anything
	 * gated on this must stay off for a kernel that negotiated 3: the host treats an
	 * unknown frame kind as protocol corruption and repairs (kills) the kernel.
	 */
	protocol4: boolean;
	/**
	 * True only when the kernel negotiated protocol 4 *and* announced
	 * {@link KERNEL_CAPABILITY_PRESERVE_NAMES}. Snapshot writes must gate on this bit
	 * rather than on `protocol4`, so a runtime that predates the request field is never
	 * sent something it would silently ignore.
	 */
	preserveNames: boolean;
}

export interface ExecuteOptions {
	/** Aborting interrupts the kernel out-of-band. */
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	onLateSentAgentMessage?: (message: KernelSentAgentMessage) => void;
	/** Cap stdout / stderr / result at this many characters. Default 65536. */
	maxOutputChars?: number;
	/** Synthetic host cell (snapshot/restore/list); excluded from lastCellCode attribution. */
	internal?: boolean;
	/** The protocol repair's own restore; exempt from waiting on the repair it belongs to. */
	protocolRepair?: boolean;
}

/** MIME tag the `edit` skill emits diff payloads under. */
export const DIFF_DISPLAY_MIME = "application/vnd.prime-agent.diff+json";

/** MIME tag the `attach-image` skill emits media payloads under. */
export const ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json";

/** MIME tag the `agent-message` skill emits after sending a message. */
export const AGENT_MESSAGE_DISPLAY_MIME = "application/vnd.prime-agent.agent-message+json";

/**
 * Hard ceiling on a single attachment's base64 payload, a defensive guard
 * against a runaway direct display emit. The `attach-image` skill caps
 * its own images well under this (see `_MAX_IMAGE_BYTES`), so a skill-produced
 * attachment is never dropped here — only a non-skill emit can hit this.
 */
export const MAX_ATTACHMENT_DATA_CHARS = 10_000_000;

/** One file edit, captured from a {@link DIFF_DISPLAY_MIME} display payload. */
export interface KernelDiffDisplay {
	path: string;
	oldStr: string;
	newStr: string;
	/** 1-based line where `oldStr` begins in the file, for absolute line numbers. */
	startLine?: number;
}

/** One media attachment, captured from an {@link ATTACHMENT_DISPLAY_MIME} display payload. */
export interface KernelAttachment {
	mimeType: string;
	/** base64-encoded bytes. */
	data: string;
	/** Source path, surfaced to the TUI renderer. */
	path?: string;
}

export interface KernelSentAgentMessage {
	id: string;
	message: string;
	deliveryStatus: "delivered" | "queued";
	receiverRole?: "parent" | "sibling" | "child";
	target: {
		activeSessionId: string;
		sessionId: string;
		sessionName?: string;
	};
}

export interface ExecuteResult {
	stdout: string;
	stderr: string;
	/** Text of the cell's trailing expression value, if the cell produced one. */
	result?: string;
	/** Diffs emitted via display events, in order. */
	diffs?: KernelDiffDisplay[];
	/** Media attachments emitted via display events, in order. */
	attachments?: KernelAttachment[];
	/** Agent messages sent from this cell, in order. */
	sentAgentMessages?: KernelSentAgentMessage[];
	/** Output that arrived without this cell's id (user threads, other cells' leftovers, raw fd writes). */
	backgroundOutput?: string;
	status: "ok" | "error" | "aborted";
	error?: { ename: string; evalue: string; traceback: string[] };
	durationMs: number;
}

/** Parse a {@link DIFF_DISPLAY_MIME} payload, tolerating malformed input. */
export function parseDiffDisplay(payload: unknown): KernelDiffDisplay | undefined {
	if (!isRecord(payload)) {
		return undefined;
	}
	const { path, old_str: oldStr, new_str: newStr, start_line: startLine } = payload;
	if (typeof path !== "string" || typeof oldStr !== "string" || typeof newStr !== "string") {
		return undefined;
	}
	return { path, oldStr, newStr, startLine: typeof startLine === "number" ? startLine : undefined };
}

/**
 * Parse an {@link ATTACHMENT_DISPLAY_MIME} payload. Malformed payloads are
 * tolerantly ignored (`undefined`); a well-formed payload exceeding
 * {@link MAX_ATTACHMENT_DATA_CHARS} is reported as `"oversized"` so the caller
 * can fail the cell loudly rather than silently dropping the image.
 */
export function parseAttachmentDisplay(payload: unknown): KernelAttachment | "oversized" | undefined {
	if (!isRecord(payload)) {
		return undefined;
	}
	const { mime_type: mimeType, data, path } = payload;
	if (typeof mimeType !== "string" || typeof data !== "string") {
		return undefined;
	}
	if (data.length > MAX_ATTACHMENT_DATA_CHARS) {
		return "oversized";
	}
	return { mimeType, data, path: typeof path === "string" ? path : undefined };
}

export function parseSentAgentMessage(payload: unknown): KernelSentAgentMessage | undefined {
	if (!isRecord(payload) || !isRecord(payload.target)) {
		return undefined;
	}
	const { id, message, deliveryStatus, receiverRole, target } = payload;
	const { activeSessionId, sessionId, sessionName } = target;
	if (
		typeof id !== "string" ||
		typeof message !== "string" ||
		(deliveryStatus !== "delivered" && deliveryStatus !== "queued") ||
		typeof activeSessionId !== "string" ||
		typeof sessionId !== "string"
	) {
		return undefined;
	}
	return {
		id,
		message,
		deliveryStatus,
		...(receiverRole === "parent" || receiverRole === "sibling" || receiverRole === "child" ? { receiverRole } : {}),
		target: {
			activeSessionId,
			sessionId,
			...(typeof sessionName === "string" ? { sessionName } : {}),
		},
	};
}

export function createKernelStartupAbortError(): Error {
	return new Error("Kernel startup aborted");
}

export function raceStartupWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) {
		return promise;
	}
	if (signal.aborted) {
		return Promise.reject(createKernelStartupAbortError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", abort);
		const abort = () => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(createKernelStartupAbortError());
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

export interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

export interface KernelShutdownOptions {
	snapshot?: boolean;
	drainHostRequests?: boolean;
}

/**
 * One accepted kernel heartbeat frame (protocol 4). Every counter is monotonic on the kernel
 * side, so the host diffs two retained samples instead of trusting a rate: a frame it never
 * saw (throttled, rejected, lost) cannot make the next one lie.
 */
export interface KernelLivenessSample {
	/** Host clock (epoch ms) when the frame was accepted. */
	receivedAt: number;
	/** Kernel event-loop tick counter; it stops advancing while the loop is blocked. */
	tick: number;
	/** The kernel's own heartbeat period, reported in the frame. */
	intervalMs: number;
	/** Request id the kernel says is in flight; absent when it reported none. */
	cellId?: string;
	/** Kernel process cpu (user + system) in ms. */
	cpuMs: number;
	/** Streamed stdout/stderr characters since the kernel started. */
	streamBytes: number;
	/** Requests finished since the kernel started. */
	cellsDone: number;
	/** Host requests the kernel is waiting on, from the kernel's side. */
	hostRequests: number;
	/** Live `bash()` handles. */
	bashHandles: number;
	/** Live `bash()` handles attributed to `cellId`. */
	bashCellHandles: number;
	/** Buffered output bytes across the probed handles. */
	bashBufferedBytes: number;
	/** Probed handles with bytes pending on their capture pipe. */
	bashPipePending: number;
}

/**
 * Retained kernel liveness state: the two newest samples plus the frame counters. Reading it
 * is diagnostic-only; it never feeds a cell's output and never reaches the model context.
 */
export interface KernelLiveness {
	/** Negotiated protocol of the kernel these samples came from; undefined before its ready frame. */
	protocol?: number;
	/** Newest retained sample; absent until the first frame is accepted. */
	latest?: KernelLivenessSample;
	/** Sample before the newest; absent until two are retained. */
	previous?: KernelLivenessSample;
	/** Frames rejected for a bad shape. Never fatal: one bad frame must not kill the kernel. */
	rejectedFrames: number;
	/** Rejections since the last accepted frame. */
	consecutiveRejectedFrames: number;
	/** Well-formed frames dropped for arriving inside the minimum sample gap. */
	throttledFrames: number;
}

/** Public surface every kernel client exposes to the provisioner and session layer. */
export interface KernelClient {
	readonly ownerSessionId: string | undefined;
	readonly isRunning: boolean;
	/**
	 * Revival-window vouch facts, present while a replacement kernel is being spawned, restored
	 * and bootstrapped. Absent once the kernel serves cells again, and bounded by age on the
	 * reader's side so a wedged revival stops excusing silence (B7).
	 */
	readonly revivalVouch?: KernelRevivalVouch;
	/**
	 * Liveness facts from protocol-4 heartbeat frames. Optional and absent for a kernel that
	 * negotiated protocol 3: readers must treat "no facts" as "no evidence either way", never
	 * as "dead", and never as permission to skip the stall watchdog.
	 */
	readonly kernelLiveness?: KernelLiveness;
	/** Host requests currently in flight for this kernel (the host's own authoritative count). */
	readonly hostRequestCount?: number;
	/** Age in ms of the oldest in-flight host request; undefined when there is none. */
	readonly hostRequestOldestAgeMs?: number;
	/** Whether a cell is executing right now. */
	readonly hasActiveExecution?: boolean;
	/** Kernel process id while the child is alive. */
	readonly kernelPid?: number;
	/** Whether the newest heartbeat reports live bash handles; false when it reports none. */
	readonly isKernelBashRunning?: boolean;
	start(options?: KernelStartOptions): Promise<void>;
	execute(code: string, opts?: ExecuteOptions): Promise<ExecuteResult>;
	shutdown(opts?: KernelShutdownOptions): Promise<boolean>;
	restart(): Promise<void>;
	kill(): Promise<void>;
	disposeSync(): void;
	snapshotState(): Promise<SnapshotResult | null>;
	pruneOversizedVariables(): Promise<SnapshotResult | null>;
	restoreState(): Promise<RestoreResult | null>;
	listNamespaceNames(signal?: AbortSignal): Promise<string[] | null>;
	/**
	 * The one-shot model-facing notice describing a kernel revival, or undefined when there is
	 * nothing pending. Called with the cell's source so a repeat of the cell that was running
	 * when the kernel died can be flagged. Consuming it is the caller's commitment that the
	 * result reaches the model: an error path must not consume it.
	 */
	consumeRestartNotice?(forCode?: string): string | undefined;
}

/**
 * One kernel revival window, for the stall watchdog. The window opens when a kernel dies or is
 * discarded and closes when the replacement serves cells again.
 */
export interface KernelRevivalVouch {
	/**
	 * Epoch ms the window opened at. The reader computes the age against its own clock, so a
	 * stale number cannot extend its own vouch; deliberately no `ageMs` field for the same reason.
	 */
	since: number;
}

// One registry serves every client kind; two parallel registries would
// double-install process signal handlers.
export const liveKernels = new Set<KernelClient>();
let signalHandlersInstalled = false;

registerSessionResourceCleanup((sessionId) => {
	for (const k of liveKernels) {
		if (!sessionId || k.ownerSessionId === sessionId) {
			void k.shutdown({ snapshot: true, drainHostRequests: true });
		}
	}
});

export function installSignalHandlersOnce(): void {
	if (signalHandlersInstalled) return;
	signalHandlersInstalled = true;

	const asyncShutdown = async (): Promise<void> => {
		// These paths can await, so flush the namespace snapshot before tearing down.
		await Promise.allSettled([...liveKernels].map((k) => k.shutdown({ snapshot: true })));
	};

	// `beforeExit` and signal handlers can await async cleanup. `exit`
	// can only do sync work (Node won't run pending microtasks past it),
	// so it falls back to `disposeSync()` which kills the child synchronously.
	process.on("beforeExit", () => {
		void asyncShutdown();
	});
	process.on("SIGINT", () => {
		void asyncShutdown().finally(() => process.exit(130));
	});
	process.on("SIGTERM", () => {
		void asyncShutdown().finally(() => process.exit(143));
	});
	process.on("exit", () => {
		for (const k of liveKernels) k.disposeSync();
	});
}
