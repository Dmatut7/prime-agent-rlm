/**
 * Session stall watchdog: escalates when a running turn goes silent.
 *
 * The host arms the watchdog when a turn starts and feeds it every observed
 * session/agent event via `touch()`. If no activity arrives within
 * `warnAfterMs` the watchdog fires the `"warn"` stage; if silence then reaches
 * `abortAfterMs` it fires the `"abort"` stage. After an abort it waits a grace
 * period for the run to settle and fires `"abort_unsettled"` once if it never
 * does, then gives up (no infinite abort loops).
 *
 * Silence that somebody else owns is not stall evidence, so escalation can be
 * exempted by two injected predicates:
 *
 * - `isPaused()` — a host phase owns the turn boundary (compaction, branch
 *   summaries, auto-refine, a UI dialog). Exempts both channels: warnings are
 *   snoozed too, because the user cannot act on a compaction "stall".
 * - `vouch()` — kernel/host facts say externally owned work is genuinely in
 *   flight (a live bash handle, a pending host request, a live kernel loop
 *   awaiting the cell). Exempts the abort escalation only: the warning still
 *   fires, with copy that says the abort is deferred instead of promising a
 *   deadline that will not be met.
 *
 * Both exemptions draw on one combined budget per arm cycle. The budget is
 * bounded by "is any exemption active", never by which reason currently claims
 * it, so a predicate that flaps between reasons cannot buy unlimited silence:
 * a genuine wedge is killed once the budget is spent. Touches re-evaluate the
 * predicates and only drop the accumulated budget when no exemption is active —
 * clearing it unconditionally would let a slow-drip wedge (an event every few
 * minutes) run forever.
 *
 * Timers and the clock are injectable so tests can drive it deterministically
 * without fake global timers.
 */

import { getLogger } from "@earendil-works/pi-ai";
import { DEFAULT_STALL_ABORT_AFTER_SECONDS, DEFAULT_STALL_WARN_AFTER_SECONDS } from "./settings-manager.js";

const stallLog = getLogger("coding-agent.stall-watchdog");

export interface StallWatchdogTimers {
	setTimeout: (callback: () => void, delayMs: number) => unknown;
	clearTimeout: (handle: unknown) => void;
	now: () => number;
}

const defaultTimers: StallWatchdogTimers = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	now: () => Date.now(),
};

export type StallWatchdogStage = "warn" | "abort" | "abort_unsettled";

/** Why silence is currently being excused. */
export type StallExemptionReason = "paused" | "vouched";

/**
 * Evidence tier behind a vouch. Liveness-only facts (a handle exists, but nothing
 * is observably moving) buy a short budget; progress facts (streamed bytes,
 * pipe backlog, kernel loop ticks advancing) buy the full combined budget. A hung
 * interactive command looks exactly like a long job on liveness alone, so the
 * short tier keeps its rescue near the pre-exemption abort threshold.
 */
export type StallVouchBudgetTier = "liveness" | "progress";

/** Kernel-side facts sampled at exemption evaluation time. All fields optional: protocol 3 kernels report none. */
export interface StallKernelFacts {
	/** Negotiated kernel protocol version. */
	protocol?: number;
	/** Age of the newest kernel liveness frame in ms; undefined when the kernel sends none. */
	livenessAgeMs?: number;
	/** Live bash handles owned by the kernel. */
	liveBashHandles?: number;
	/** Host requests the kernel is currently waiting on. */
	hostRequestCount?: number;
	/** Kernel process id, when the host knows it (used by abort-cause evidence). */
	kernelPid?: number;
	/** Kernel-side stall/liveness reasons (e.g. `loop_stalled`). */
	reasons?: readonly string[];
}

/** Result of one vouch sampling. Must be O(1): it is read on every touch and every timer fire. */
export interface StallVouchFacts {
	/** True when externally owned work is verifiably in flight. */
	active: boolean;
	/** Machine-readable sub-reasons, surfaced in diagnostics and humanized in the warn copy. */
	reasons?: readonly string[];
	/** Budget tier; defaults to `"liveness"` (the shorter budget) when omitted. */
	tier?: StallVouchBudgetTier;
	/** Kernel facts snapshot for the diagnostics `kernel` segment. */
	kernel?: StallKernelFacts;
}

export type StallVouchProvider = () => StallVouchFacts | undefined;

/** Normalized kernel segment for stall diagnostics: the raw facts with `reasons` always present. */
export interface StallKernelDiagnostics extends StallKernelFacts {
	reasons: readonly string[];
}

/** Budget/exemption state at a point in time. */
export interface StallExemptionSnapshot {
	reason: StallExemptionReason;
	/** Sub-reasons behind a vouch; empty for a paused phase. */
	reasons: readonly string[];
	/** Epoch ms at which the current continuous exemption segment started. */
	since: number;
	/** Budget consumed by the current segment. */
	usedMs: number;
	/** Budget cap for the current reason/tier. */
	budgetMs: number;
	remainingMs: number;
	exhausted: boolean;
	tier?: StallVouchBudgetTier;
	/** Raw kernel facts as sampled with the exemption (normalized by `collectExemptionDiagnostics`). */
	kernel?: StallKernelFacts;
}

/** Exemption segment for a diagnostics payload: same facts, all-optional shape. */
export interface StallExemptionDiagnostics {
	reason?: StallExemptionReason;
	reasons: readonly string[];
	budgetUsedMs?: number;
	budgetRemainingMs?: number;
	budgetMs?: number;
	exhausted?: boolean;
	tier?: StallVouchBudgetTier;
	kernel?: StallKernelDiagnostics;
}

export type StallExemptionEventKind = "started" | "reason_switch" | "abort_deferred" | "exhausted" | "cleared";

/** Forensic record of one exemption-budget transition; defaults to `sessionLog.info`. */
export interface StallExemptionEvent {
	kind: StallExemptionEventKind;
	reason: StallExemptionReason;
	previousReason?: StallExemptionReason;
	/** Budget already consumed by the segment when the event happened. */
	usedMs: number;
	budgetMs: number;
	reasons: readonly string[];
	at: number;
}

export interface StallWatchdogStageInfo {
	stage: StallWatchdogStage;
	/** Milliseconds without activity when the stage fired. */
	silentMs: number;
	armedAt: number;
	lastActivityAt: number;
	/** Exemption in effect when the stage fired, if any. */
	exemption?: StallExemptionSnapshot;
}

export interface StallWatchdogOptions {
	/** Whether the watchdog is active. Pass a function to read live from settings. */
	enabled: boolean | (() => boolean);
	/**
	 * Silence duration that fires the `"warn"` stage. Must be > 0 when enabled.
	 * Pass a function to read the threshold live so settings changes take effect
	 * without re-constructing the watchdog.
	 */
	warnAfterMs: number | (() => number);
	/**
	 * Silence duration that fires the `"abort"` stage. Must be greater than
	 * `warnAfterMs`; undefined disables auto-abort (warn-only watchdog).
	 * Pass a function to read the threshold live so settings changes take effect.
	 */
	abortAfterMs?: number | (() => number | undefined);
	/** How long to wait after the abort stage for the run to settle. Default: 10s. */
	abortSettleGraceMs?: number;
	/**
	 * Checked when a timer fires and on every touch. While true, escalation is
	 * deferred by one full `warnAfterMs` window instead of firing, so phases that
	 * legitimately own the turn boundary (compaction, branch summaries) cannot
	 * trigger false alarms. Warnings are snoozed too.
	 */
	isPaused?: () => boolean;
	/**
	 * Checked alongside `isPaused`. While it reports an active vouch, the abort
	 * escalation is deferred within the combined budget but warnings still fire
	 * (with copy that says the abort is deferred). Must be O(1) and side-effect
	 * free: it is sampled on every touch.
	 */
	vouch?: StallVouchProvider;
	/**
	 * Budget for a vouch backed by liveness-only evidence. Defaults to
	 * {@link STALL_VOUCH_LIVENESS_BUDGET_MS}; pass a function to read live from settings.
	 */
	vouchLivenessBudgetMs?: number | (() => number);
	/** Exemption-budget transitions, for forensics. Defaults to one `sessionLog.info` line each. */
	onExemptionEvent?: (event: StallExemptionEvent) => void;
	onStage: (info: StallWatchdogStageInfo) => void;
	timers?: StallWatchdogTimers;
}

export type StallWatchdogState = "idle" | "armed" | "warned" | "aborting";

const DEFAULT_ABORT_SETTLE_GRACE_MS = 10_000;
/** Floor for the combined exemption budget; the budget also scales with `warnAfterMs`. */
export const STALL_EXEMPTION_BUDGET_FLOOR_MS = 30 * 60 * 1000;
export const STALL_EXEMPTION_BUDGET_WARN_MULTIPLIER = 10;
/** Default budget for a liveness-only vouch: near the pre-exemption abort threshold (15min). */
export const STALL_VOUCH_LIVENESS_BUDGET_MS = 20 * 60 * 1000;

/** Vouch sub-reasons produced by the kernel/host liveness aggregate. */
export const STALL_VOUCH_REASONS = {
	liveBashHandles: "live_bash_handles",
	hostRequestInFlight: "host_request_in_flight",
	kernelLoopAwaitingCell: "kernel_loop_awaiting_cell",
} as const;

/** Kernel-side reasons reported when silence is *not* excused. */
export const STALL_KERNEL_REASONS = {
	loopStalled: "loop_stalled",
	heartbeatStale: "heartbeat_stale",
	noKernelFacts: "no_kernel_facts",
} as const;

interface ExemptionSegment {
	since: number;
	reason: StallExemptionReason;
	reasons: readonly string[];
	tier?: StallVouchBudgetTier;
	/** Observed reason awaiting debounce before it may start snoozing warnings. */
	pendingReason?: { reason: StallExemptionReason; since: number };
	exhaustedLogged: boolean;
}

export class StallWatchdog {
	private readonly options: StallWatchdogOptions;
	private readonly timers: StallWatchdogTimers;
	private state: StallWatchdogState = "idle";
	private armedAt = 0;
	private lastActivityAt = 0;
	private timerHandle: unknown = undefined;
	private exemptionSegment: ExemptionSegment | undefined = undefined;
	private lastKernelFacts: StallKernelFacts | undefined = undefined;
	private abortDeferredLogged = false;

	constructor(options: StallWatchdogOptions) {
		this.options = options;
		this.timers = options.timers ?? defaultTimers;
	}

	private get warnAfterMs(): number {
		const v = this.options.warnAfterMs;
		return typeof v === "function" ? v() : v;
	}

	private get abortAfterMs(): number | undefined {
		const v = this.options.abortAfterMs;
		return typeof v === "function" ? v() : v;
	}

	private get livenessBudgetMs(): number {
		const v = this.options.vouchLivenessBudgetMs;
		if (v === undefined) return STALL_VOUCH_LIVENESS_BUDGET_MS;
		return typeof v === "function" ? v() : v;
	}

	get currentState(): StallWatchdogState {
		return this.state;
	}

	get lastActivity(): number {
		return this.lastActivityAt;
	}

	/** Whether an abort stage can fire at all (warn-only watchdogs have nothing to escalate to). */
	private get hasAbortEscalation(): boolean {
		const abortAfterMs = this.abortAfterMs;
		return abortAfterMs !== undefined && abortAfterMs > this.warnAfterMs;
	}

	private get active(): boolean {
		const enabled = typeof this.options.enabled === "function" ? this.options.enabled() : this.options.enabled;
		return enabled && this.warnAfterMs > 0;
	}

	/** Start watching a turn. Re-arming resets the escalation state and the exemption budget. */
	arm(): void {
		if (!this.active) {
			// Disabling the watchdog must also drop a timer armed by an earlier turn.
			this.clearTimer();
			return;
		}
		this.armedAt = this.timers.now();
		this.lastActivityAt = this.armedAt;
		this.resetExemption();
		this.state = "armed";
		this.scheduleWarn();
	}

	/** Record activity: resets the warn deadline and cancels any pending escalation. */
	touch(): void {
		if (!this.active || this.state === "idle") return;
		// While aborting (waiting for settle), touches must not re-arm: doing so
		// cancels the settle timer and restarts the warn→abort cycle, contradicting
		// the "no infinite abort loops" guarantee in fireAbortUnsettled.
		if (this.state === "aborting") return;
		const now = this.timers.now();
		// Sampling on touch is what makes the budget honest: an exemption that is no
		// longer claimed drops its accumulated time here instead of at the next fire,
		// and one that is still claimed keeps it (never cleared unconditionally, or a
		// slow-drip wedge would refresh its budget forever).
		const exemption = this.evaluateExemption(now);
		if (exemption?.exhausted && this.hasAbortEscalation) {
			// Budget spent while the predicate still claims the turn is owned
			// elsewhere: keep the accumulated silence and let the pending escalation
			// fire instead of rebasing it.
			if (this.timerHandle === undefined) {
				this.scheduleWarn(Math.max(0, this.warnAfterMs - (now - this.lastActivityAt)));
			}
			return;
		}
		this.lastActivityAt = now;
		this.state = "armed";
		this.scheduleWarn();
	}

	/** Stop watching: the turn ended (or the session is going away). */
	disarm(): void {
		this.clearTimer();
		this.resetExemption();
		this.state = "idle";
	}

	/** Alias of `disarm()` for ownership-clarity at teardown. */
	dispose(): void {
		this.disarm();
	}

	/**
	 * Exemption currently in effect, measured against the clock without
	 * re-sampling the predicates (diagnostics must not perturb the watchdog).
	 */
	get exemption(): StallExemptionSnapshot | undefined {
		const segment = this.exemptionSegment;
		if (!segment) return undefined;
		const now = this.timers.now();
		const budgetMs = this.exemptionBudgetMs(segment.reason, segment.tier);
		const usedMs = Math.max(0, now - segment.since);
		return {
			reason: segment.reason,
			reasons: segment.reasons,
			since: segment.since,
			usedMs,
			budgetMs,
			remainingMs: Math.max(0, budgetMs - usedMs),
			exhausted: usedMs >= budgetMs,
			tier: segment.tier,
			kernel: this.lastKernelFacts,
		};
	}

	/** Exemption + kernel segment for a stall diagnostics payload. */
	collectExemptionDiagnostics(): StallExemptionDiagnostics {
		const kernel = this.lastKernelFacts ? normalizeStallKernelFacts(this.lastKernelFacts) : undefined;
		const snapshot = this.exemption;
		if (!snapshot) {
			return { reasons: [], ...(kernel ? { kernel } : {}) };
		}
		return {
			reason: snapshot.reason,
			reasons: snapshot.reasons,
			budgetUsedMs: snapshot.usedMs,
			budgetRemainingMs: snapshot.remainingMs,
			budgetMs: snapshot.budgetMs,
			exhausted: snapshot.exhausted,
			...(snapshot.tier ? { tier: snapshot.tier } : {}),
			...(kernel ? { kernel } : {}),
		};
	}

	private resetExemption(): void {
		this.exemptionSegment = undefined;
		this.lastKernelFacts = undefined;
		this.abortDeferredLogged = false;
	}

	private clearTimer(): void {
		if (this.timerHandle !== undefined) {
			this.timers.clearTimeout(this.timerHandle);
			this.timerHandle = undefined;
		}
	}

	/** Combined exemption budget cap: `max(10 x warnAfterMs, 30min)`. */
	private get exemptionBudgetCapMs(): number {
		return Math.max(STALL_EXEMPTION_BUDGET_WARN_MULTIPLIER * this.warnAfterMs, STALL_EXEMPTION_BUDGET_FLOOR_MS);
	}

	private exemptionBudgetMs(reason: StallExemptionReason, tier: StallVouchBudgetTier | undefined): number {
		const cap = this.exemptionBudgetCapMs;
		if (reason === "paused" || tier === "progress") return cap;
		// Liveness-only evidence: a shorter budget, so a hung handle that produces
		// nothing is rescued close to the threshold that applied before exemptions.
		return Math.min(this.livenessBudgetMs, cap);
	}

	/**
	 * Samples both exemption predicates and maintains the shared budget segment.
	 *
	 * The segment is bounded by "any exemption is active": it starts at the first
	 * exempted sample, ends at the first unexempted one, and is *not* restarted by a
	 * reason switch — otherwise a predicate alternating between two true reasons
	 * would refresh the budget forever and the "a real wedge dies within the cap"
	 * invariant would be false. Reasons only drive logging, the warn channel, and
	 * the copy.
	 */
	private evaluateExemption(now: number): StallExemptionSnapshot | undefined {
		const paused = this.options.isPaused?.() === true;
		const vouchFacts = this.options.vouch?.();
		this.lastKernelFacts = vouchFacts?.kernel;
		const observed: StallExemptionReason | undefined = paused ? "paused" : vouchFacts?.active ? "vouched" : undefined;

		if (observed === undefined) {
			const previous = this.exemptionSegment;
			this.exemptionSegment = undefined;
			if (previous) {
				this.emitExemptionEvent(
					{
						kind: "cleared",
						reason: previous.reason,
						usedMs: Math.max(0, now - previous.since),
						reasons: previous.reasons,
						tier: previous.tier,
					},
					now,
				);
			}
			return undefined;
		}

		if (!this.exemptionSegment) {
			this.exemptionSegment = {
				since: now,
				reason: observed,
				reasons: observed === "vouched" ? (vouchFacts?.reasons ?? []) : [],
				tier: vouchFacts?.tier,
				exhaustedLogged: false,
			};
			this.emitExemptionEvent(
				{
					kind: "started",
					reason: observed,
					usedMs: 0,
					reasons: this.exemptionSegment.reasons,
					tier: this.exemptionSegment.tier,
				},
				now,
			);
		} else {
			const segment = this.exemptionSegment;
			if (observed === "vouched") {
				segment.reasons = vouchFacts?.reasons ?? [];
			} else {
				segment.reasons = [];
			}
			if (vouchFacts) segment.tier = vouchFacts.tier;
			this.commitReasonSwitch(segment, observed, now);
		}

		const snapshot = this.exemption;
		// One line per segment: the moment the budget stops excusing silence is the
		// single most load-bearing fact in a stall post-mortem.
		if (snapshot && snapshot.exhausted && !this.exemptionSegment?.exhaustedLogged) {
			if (this.exemptionSegment) this.exemptionSegment.exhaustedLogged = true;
			this.emitExemptionEvent(
				{
					kind: "exhausted",
					reason: snapshot.reason,
					usedMs: snapshot.usedMs,
					reasons: snapshot.reasons,
					tier: snapshot.tier,
				},
				now,
			);
		}
		return snapshot;
	}

	/**
	 * Commits a paused↔vouched switch for logging and channel purposes only.
	 * Switching to the warn-snoozing reason is debounced by one full warn window so
	 * a flapping pause flag cannot suppress warnings; switching away from it commits
	 * immediately, because a late warning is the cheaper mistake.
	 */
	private commitReasonSwitch(segment: ExemptionSegment, observed: StallExemptionReason, now: number): void {
		if (segment.reason === observed) {
			segment.pendingReason = undefined;
			return;
		}
		if (observed === "paused") {
			const pending = segment.pendingReason;
			if (!pending || pending.reason !== observed) {
				segment.pendingReason = { reason: observed, since: now };
				return;
			}
			if (now - pending.since < this.warnAfterMs) return;
		}
		const previousReason = segment.reason;
		segment.reason = observed;
		segment.pendingReason = undefined;
		// Deliberately keeps `segment.since`: the budget survives a reason switch.
		this.emitExemptionEvent(
			{
				kind: "reason_switch",
				reason: observed,
				previousReason,
				usedMs: Math.max(0, now - segment.since),
				reasons: segment.reasons,
				tier: segment.tier,
			},
			now,
		);
	}

	private emitExemptionEvent(
		event: Omit<StallExemptionEvent, "at" | "budgetMs"> & { tier?: StallVouchBudgetTier },
		now: number,
	): void {
		const { tier, ...rest } = event;
		const budgetMs = this.exemptionBudgetMs(event.reason, tier ?? this.exemptionSegment?.tier);
		const full: StallExemptionEvent = { ...rest, budgetMs, at: now };
		if (this.options.onExemptionEvent) {
			this.options.onExemptionEvent(full);
			return;
		}
		stallLog.info(`stall watchdog: exemption ${full.kind}`, {
			reason: full.reason,
			...(full.previousReason ? { previousReason: full.previousReason } : {}),
			budgetUsedMs: full.usedMs,
			budgetMs: full.budgetMs,
			reasons: full.reasons,
		});
	}

	private noteAbortDeferred(now: number): void {
		// At most one line per arm cycle: the deferral re-checks every warn window,
		// and repeating it would bury the stall diagnostics it points at.
		if (this.abortDeferredLogged) return;
		this.abortDeferredLogged = true;
		this.emitExemptionEvent(
			{
				kind: "abort_deferred",
				reason: "vouched",
				usedMs: Math.max(0, now - (this.exemptionSegment?.since ?? now)),
				reasons: this.exemptionSegment?.reasons ?? [],
				tier: this.exemptionSegment?.tier,
			},
			now,
		);
	}

	private scheduleWarn(delayMs: number = this.warnAfterMs): void {
		this.clearTimer();
		this.timerHandle = this.timers.setTimeout(() => this.fireWarn(), delayMs);
	}

	private fireWarn(): void {
		if (!this.active) {
			this.disarm();
			return;
		}
		this.timerHandle = undefined;
		if (this.state === "idle") return;
		const now = this.timers.now();
		const exemption = this.evaluateExemption(now);
		if (exemption && !exemption.exhausted && exemption.reason === "paused") {
			// Snooze: the paused phase legitimately owns the turn boundary, so its
			// silent time is not stall evidence. Rebase activity and re-check after
			// another full warn window once the pause lifts.
			this.lastActivityAt = now;
			this.scheduleWarn();
			return;
		}
		this.state = "warned";
		this.emitStage("warn", exemption);
		const abortAfterMs = this.abortAfterMs;
		if (abortAfterMs === undefined || !this.hasAbortEscalation) return;
		const delayMs = Math.max(0, abortAfterMs - (this.timers.now() - this.lastActivityAt));
		this.timerHandle = this.timers.setTimeout(() => this.fireAbort(), delayMs);
	}

	private fireAbort(): void {
		if (!this.active) {
			this.disarm();
			return;
		}
		this.timerHandle = undefined;
		if (this.state !== "warned") return;
		const now = this.timers.now();
		const exemption = this.evaluateExemption(now);
		if (exemption && !exemption.exhausted) {
			if (exemption.reason === "paused") {
				// Same snooze as fireWarn: paused silence is not stall evidence.
				this.lastActivityAt = now;
				this.state = "armed";
				this.scheduleWarn();
				return;
			}
			// Vouched: the warning already fired (an exemption never swallows it), so
			// only the abort escalation is deferred — and only for what is left of the
			// combined budget. Re-check at most one warn window later.
			this.noteAbortDeferred(now);
			const delayMs = Math.max(1, Math.min(this.warnAfterMs, exemption.remainingMs));
			this.timerHandle = this.timers.setTimeout(() => this.fireAbort(), delayMs);
			return;
		}
		this.state = "aborting";
		this.emitStage("abort", exemption);
		const graceMs = this.options.abortSettleGraceMs ?? DEFAULT_ABORT_SETTLE_GRACE_MS;
		this.timerHandle = this.timers.setTimeout(() => this.fireAbortUnsettled(), graceMs);
	}

	private fireAbortUnsettled(): void {
		if (!this.active) {
			this.disarm();
			return;
		}
		this.timerHandle = undefined;
		if (this.state !== "aborting") return;
		// Carry the final exemption state into the stage info: the unsettled copy and
		// diagnostics are the last forensic record of this arm cycle.
		this.emitStage("abort_unsettled", this.exemption);
		// Give up: repeated aborts cannot fix a wedged runtime and would loop forever.
		this.state = "idle";
		this.resetExemption();
	}

	private emitStage(stage: StallWatchdogStage, exemption?: StallExemptionSnapshot): void {
		this.options.onStage({
			stage,
			silentMs: this.timers.now() - this.lastActivityAt,
			armedAt: this.armedAt,
			lastActivityAt: this.lastActivityAt,
			...(exemption ? { exemption } : {}),
		});
	}
}

/** Normalize kernel facts into the diagnostics segment shape (dropping absent fields). */
export function normalizeStallKernelFacts(facts: StallKernelFacts): StallKernelDiagnostics {
	return {
		...(facts.protocol === undefined ? {} : { protocol: facts.protocol }),
		...(facts.livenessAgeMs === undefined ? {} : { livenessAgeMs: facts.livenessAgeMs }),
		...(facts.liveBashHandles === undefined ? {} : { liveBashHandles: facts.liveBashHandles }),
		...(facts.hostRequestCount === undefined ? {} : { hostRequestCount: facts.hostRequestCount }),
		...(facts.kernelPid === undefined ? {} : { kernelPid: facts.kernelPid }),
		reasons: [...(facts.reasons ?? [])],
	};
}

/** `key=value` rendering for log lines and the abort_unsettled copy; undefined when there is nothing to say. */
export function formatStallKernelFacts(kernel: StallKernelFacts | undefined): string | undefined {
	if (!kernel) return undefined;
	const parts: string[] = [];
	if (kernel.protocol !== undefined) parts.push(`protocol=${kernel.protocol}`);
	if (kernel.livenessAgeMs !== undefined) parts.push(`livenessAgeMs=${kernel.livenessAgeMs}`);
	if (kernel.liveBashHandles !== undefined) parts.push(`liveBashHandles=${kernel.liveBashHandles}`);
	if (kernel.hostRequestCount !== undefined) parts.push(`hostRequestCount=${kernel.hostRequestCount}`);
	if (kernel.kernelPid !== undefined) parts.push(`kernelPid=${kernel.kernelPid}`);
	const reasons = kernel.reasons ?? [];
	if (reasons.length > 0) parts.push(`reasons=${reasons.join(",")}`);
	return parts.length > 0 ? parts.join(" ") : undefined;
}

const REASON_PHRASES: Record<string, string> = {
	[STALL_VOUCH_REASONS.liveBashHandles]: "live bash handles",
	[STALL_VOUCH_REASONS.hostRequestInFlight]: "an in-flight host request",
	[STALL_VOUCH_REASONS.kernelLoopAwaitingCell]: "a live kernel loop awaiting this cell",
	[STALL_KERNEL_REASONS.loopStalled]: "the kernel event loop looks stalled",
	[STALL_KERNEL_REASONS.heartbeatStale]: "the kernel heartbeat is stale",
	[STALL_KERNEL_REASONS.noKernelFacts]: "no kernel facts",
};

/** Human-readable rendering of vouch reasons for user-facing copy. */
export function humanizeStallReasons(reasons: readonly string[]): string {
	if (reasons.length === 0) return "in-flight work";
	return reasons.map((reason) => REASON_PHRASES[reason] ?? reason.replaceAll("_", " ")).join(", ");
}

/**
 * Stall watchdog settings. Mirrors `settings.stallWatchdog`; registering the two
 * keys below in the settings schema is a separate one-line change.
 */
export interface StallWatchdogConfig {
	enabled?: boolean;
	warnAfterSeconds?: number;
	/** 0 means warn-only (no auto-abort). */
	abortAfterSeconds?: number;
	/**
	 * Defer the abort escalation while kernel/host facts vouch that externally owned
	 * work is in flight. Never suppresses the warning itself.
	 */
	toolLivenessExemption?: boolean;
	/**
	 * Reserved, no effect: treating kernel CPU progress as activity is a pending
	 * product decision. The watchdog never reads this key; it exists so the setting
	 * can be registered and round-tripped without a schema change later.
	 */
	treatKernelCpuProgressAsActivity?: boolean;
}

export type ResolvedStallWatchdogConfig = Required<StallWatchdogConfig>;

export const DEFAULT_STALL_WATCHDOG_CONFIG: ResolvedStallWatchdogConfig = {
	enabled: true,
	warnAfterSeconds: DEFAULT_STALL_WARN_AFTER_SECONDS,
	abortAfterSeconds: DEFAULT_STALL_ABORT_AFTER_SECONDS,
	toolLivenessExemption: true,
	treatKernelCpuProgressAsActivity: false,
};

/** Fill defaults and keep the escalation gap rule used by the settings manager. */
export function resolveStallWatchdogConfig(config: StallWatchdogConfig | undefined): ResolvedStallWatchdogConfig {
	const warnAfterSeconds = config?.warnAfterSeconds ?? DEFAULT_STALL_WATCHDOG_CONFIG.warnAfterSeconds;
	let abortAfterSeconds = config?.abortAfterSeconds ?? DEFAULT_STALL_WATCHDOG_CONFIG.abortAfterSeconds;
	// 0 means "warn-only". Any other value at or below the warn threshold would fire
	// both stages at once; keep an escalation gap instead.
	if (abortAfterSeconds !== 0 && abortAfterSeconds <= warnAfterSeconds) {
		abortAfterSeconds = warnAfterSeconds * 2;
	}
	return {
		enabled: config?.enabled ?? DEFAULT_STALL_WATCHDOG_CONFIG.enabled,
		warnAfterSeconds,
		abortAfterSeconds,
		toolLivenessExemption: config?.toolLivenessExemption ?? DEFAULT_STALL_WATCHDOG_CONFIG.toolLivenessExemption,
		treatKernelCpuProgressAsActivity:
			config?.treatKernelCpuProgressAsActivity ?? DEFAULT_STALL_WATCHDOG_CONFIG.treatKernelCpuProgressAsActivity,
	};
}

/** Inputs for the stall copy builders. */
export interface StallMessageContext {
	/** Milliseconds without observed session activity. */
	silentMs: number;
	/** `settings.abortAfterSeconds`, used by the warn copy's escalation promise. */
	abortAfterSeconds?: number;
	/** Exemption in effect when the stage fired (`StallWatchdogStageInfo.exemption`). */
	exemption?: StallExemptionSnapshot;
	/** Kernel facts to append to the abort_unsettled copy. */
	kernel?: StallKernelFacts;
}

function silentSecondsOf(silentMs: number): number {
	return Math.max(1, Math.round(silentMs / 1000));
}

/**
 * Warning copy. A vouched stall says the abort is deferred and how much budget is
 * left instead of promising an abort deadline that the exemption will not keep.
 * The unexempted copy is byte-identical to the pre-exemption message.
 */
export function buildStallWarnMessage(context: StallMessageContext): string {
	const seconds = silentSecondsOf(context.silentMs);
	const exemption = context.exemption;
	if (exemption && exemption.reason === "vouched" && !exemption.exhausted) {
		const remainingMinutes = Math.max(1, Math.round(exemption.remainingMs / 60_000));
		return `Possible stall: no session activity for ${seconds}s while a turn is running. In-flight kernel work detected (${humanizeStallReasons(exemption.reasons)}), so the automatic abort is deferred and ${remainingMinutes}min of exemption budget is left. If the process is actually wedged, interrupt the turn manually to recover faster; check the daemon log for stall diagnostics.`;
	}
	return `Possible stall: no session activity for ${seconds}s while a turn is running. If nothing recovers, the turn will be aborted automatically after ${context.abortAfterSeconds ?? 0}s of silence. If a tool appears stuck, interrupt the turn manually to recover faster; check the daemon log for stall diagnostics.`;
}

/** Abort copy: unchanged by the exemption work (an abort only fires once the budget is spent). */
export function buildStallAbortMessage(context: StallMessageContext): string {
	return `Suspected stall: no session activity for ${silentSecondsOf(context.silentMs)}s. The current turn is being aborted automatically; diagnostics were logged.`;
}

/** Abort-unsettled copy: the pre-existing sentence plus the kernel facts, when there are any. */
export function buildStallAbortUnsettledMessage(context: StallMessageContext): string {
	const base = `Suspected stall: auto-abort fired ${silentSecondsOf(context.silentMs)}s into silence but the run did not settle; the session may need a restart. Diagnostics were logged.`;
	const kernel = formatStallKernelFacts(context.kernel ?? context.exemption?.kernel);
	return kernel ? `${base} Kernel facts: ${kernel}.` : base;
}

/** Copy for one stage; keeps the three builders behind a single call site. */
export function buildStallStageMessage(stage: StallWatchdogStage, context: StallMessageContext): string {
	if (stage === "warn") return buildStallWarnMessage(context);
	if (stage === "abort") return buildStallAbortMessage(context);
	return buildStallAbortUnsettledMessage(context);
}
