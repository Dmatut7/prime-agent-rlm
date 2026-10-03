/**
 * Stall cluster extracted from agent-session.ts: the session side of the stall
 * watchdog - the wiring that builds the watchdog and its turn-liveness fact
 * source, the predicates it samples (host-phase pause, kernel/host liveness
 * vouch, the silent-step rule behind the per-tool deadline), and the
 * diagnostics collected when a stage fires. The moved methods keep exactly the
 * same bodies; they read the session through {@link StallWatchdogWiringHost},
 * which `AgentSession` satisfies structurally, so the move changes no runtime
 * behavior. The parent-facing diagnostic getters (`stallState`,
 * `lastAgentEventAt`, `excusedNow`, `stallExempted`, `lastStallAbortCause`)
 * stay on the class. This module never imports an agent-session value, so the
 * layering stays acyclic.
 */
import type {
	AgentEvent,
	ToolTimeoutConfig,
	ToolTimeoutVerdict,
	ToolTimeoutVouchInfo,
} from "@earendil-works/pi-agent-core";
import { getLogger } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.js";
import { STEP_TIME_LIMIT_MARKER } from "./duty-log.js";
import { ORPHAN_PROCESS_JOURNAL_ENV, readActiveOrphanProcesses } from "./orphan-process-journal.js";
import { explicitTimeoutMs, readProcessTreeCpuMs } from "./process-tree-cpu.js";
import { readStallKernelReasons } from "./rlm-child-terminal.js";
import type { StallDiagnostics } from "./stall-diagnostics.js";
import {
	buildStallAbortMessage,
	buildStallAbortUnsettledMessage,
	buildStallWarnMessage,
	formatStallExemptionEventLog,
	normalizeStallKernelFacts,
	STALL_VOUCH_REASONS,
	type StallExemptionEvent,
	type StallKernelDiagnostics,
	type StallMessageContext,
	type StallVouchFacts,
	StallWatchdog,
	type StallWatchdogOptions,
	type StallWatchdogStageInfo,
} from "./stall-watchdog.js";
import { previewIpythonCode } from "./tools/code-preview.js";
import {
	createTurnLiveness,
	type TurnLiveness,
	type TurnLivenessEvent,
	type TurnLivenessKernelFacts,
} from "./turn-liveness.js";

// Same logger name as agent-session.ts: the stall paths moved here verbatim and
// their log lines keep the namespace they have always emitted under.
const sessionLog = getLogger("coding-agent.agent-session");

/**
 * The seam of `AgentSession` the extracted stall wiring reads and mutates.
 * Member names mirror the class's own members so the extraction stays a
 * textual `this.` -> `host.` rename; members whose signatures are wide are
 * indexed access types so they stay single-sourced on the class. None of the
 * moved functions keeps a shell on the class: the constructor, the agent-loop
 * wiring and the event dispatch call them here directly.
 */
export interface StallWatchdogWiringHost {
	readonly sessionManager: AgentSession["sessionManager"];
	readonly settingsManager: AgentSession["settingsManager"];
	readonly _actionStore: AgentSession["_actionStore"];
	readonly _ipythonKernelProvisioner?: AgentSession["_ipythonKernelProvisioner"];
	readonly _sessionInputPumpSuspended: AgentSession["_sessionInputPumpSuspended"];
	readonly _sessionInputPumpRequested: AgentSession["_sessionInputPumpRequested"];
	readonly _sessionInputPumpEpoch: AgentSession["_sessionInputPumpEpoch"];
	_stallWatchdog: AgentSession["_stallWatchdog"];
	readonly _stallAbortSettleGraceMs: AgentSession["_stallAbortSettleGraceMs"];
	readonly _stallWatchdogTimers: AgentSession["_stallWatchdogTimers"];
	_turnLiveness: AgentSession["_turnLiveness"];
	readonly _stallKernelLivenessFacts: AgentSession["_stallKernelLivenessFacts"];
	readonly _stallJournaledBashHandles: AgentSession["_stallJournaledBashHandles"];
	readonly _stepCpuProbe: AgentSession["_stepCpuProbe"];
	readonly _stallPredicateFailures: AgentSession["_stallPredicateFailures"];
	readonly _turnLivenessLogged: AgentSession["_turnLivenessLogged"];
	_lastStallAbortCause: AgentSession["_lastStallAbortCause"];
	_stallLastEvent: AgentSession["_stallLastEvent"];
	readonly _stallInFlightTools: AgentSession["_stallInFlightTools"];
	readonly _stepOutputWatch: AgentSession["_stepOutputWatch"];
	readonly _stuckStepsThisRun: AgentSession["_stuckStepsThisRun"];
	readonly _stepStopCauses: AgentSession["_stepStopCauses"];
	_stallState: AgentSession["_stallState"];
	_turnLifecycleEpoch: AgentSession["_turnLifecycleEpoch"];
	_lastTurnAbortReason: AgentSession["_lastTurnAbortReason"];
	_lastStallAbort: AgentSession["_lastStallAbort"];
	readonly _rlmCollectWaits: AgentSession["_rlmCollectWaits"];
	readonly stallExempted: boolean;
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly isRetrying: boolean;
	readonly isBashRunning: boolean;
	requestAbort: AgentSession["requestAbort"];
	_emit: AgentSession["_emit"];
	_recordDutyEvent: AgentSession["_recordDutyEvent"];
	_recordSelfRecovery: AgentSession["_recordSelfRecovery"];
}

export function createSessionStallWatchdog(host: StallWatchdogWiringHost): StallWatchdog {
	const options: StallWatchdogOptions = {
		enabled: () => host.settingsManager.getStallWatchdogSettings().enabled,
		warnAfterMs: () => host.settingsManager.getStallWatchdogSettings().warnAfterSeconds * 1000,
		abortAfterMs: () => {
			const s = host.settingsManager.getStallWatchdogSettings();
			return s.abortAfterSeconds > 0 ? s.abortAfterSeconds * 1000 : undefined;
		},
		// Both predicates are sampled from inside the watchdog's timer callbacks, so an
		// exception would escape into the timer, leave the watchdog with no timer armed, and
		// silently end escalation for this arm cycle (F2). The watchdog is the component that
		// has to survive other components misbehaving, so a throwing predicate degrades to
		// "no exemption" and is logged instead.
		isPaused: () => {
			try {
				return host.stallExempted;
			} catch (error) {
				reportStallPredicateFailure(host, "isPaused", error);
				return false;
			}
		},
		vouch: () => sampleStallVouch(host),
		// The default exemption sink logs without a session identity, and a daemon worker
		// hosts many sessions per process behind one shared stall-evidence file: a line that
		// cannot be attributed to the session it vouched for is a line a post-mortem cannot
		// use (JIT-1B). The formatter is shared with the default sink so the fields cannot drift.
		onExemptionEvent: (event) => logStallExemptionEvent(host, event),
		onStage: (info) => handleStallWatchdogStage(host, info),
		...(host._stallAbortSettleGraceMs === undefined ? {} : { abortSettleGraceMs: host._stallAbortSettleGraceMs }),
		...(host._stallWatchdogTimers === undefined ? {} : { timers: host._stallWatchdogTimers }),
	};
	return new StallWatchdog(options);
}

export function createSessionTurnLiveness(host: StallWatchdogWiringHost): TurnLiveness {
	return createTurnLiveness({
		kernel: () =>
			host._stallKernelLivenessFacts ? host._stallKernelLivenessFacts() : kernelLivenessFactsFromClient(host),
		...(host._stallJournaledBashHandles ? { readJournaledBashHandles: host._stallJournaledBashHandles } : {}),
		// Read live so an operator can widen or disable the bound without a new session (B7).
		revivalVouchMaxAgeMs: () => host.settingsManager.getKernelRestartSettings().revivalVouchMaxAgeMs,
		onEvent: (event) => handleTurnLivenessEvent(host, event),
	});
}

/**
 * Kernel facts for the vouch, adapted from this session's kernel client. O(1) and read-only:
 * the watchdog samples it on every touch. Returns undefined when the session has no kernel,
 * which is "no facts", never "no work in flight".
 */
function kernelLivenessFactsFromClient(host: StallWatchdogWiringHost): TurnLivenessKernelFacts | undefined {
	const kernel = host._ipythonKernelProvisioner?.manager;
	if (!kernel) return undefined;
	const liveness = kernel.kernelLiveness;
	return {
		...(liveness?.protocol === undefined ? {} : { protocol: liveness.protocol }),
		...(liveness?.latest ? { latest: liveness.latest } : {}),
		...(liveness?.previous ? { previous: liveness.previous } : {}),
		rejectedFrames: liveness?.rejectedFrames,
		consecutiveRejectedFrames: liveness?.consecutiveRejectedFrames,
		hostRequestCount: kernel.hostRequestCount,
		hostRequestOldestAgeMs: kernel.hostRequestOldestAgeMs,
		kernelPid: kernel.kernelPid,
		hasActiveExecution: kernel.hasActiveExecution,
		...(kernel.revivalVouch ? { revival: kernel.revivalVouch } : {}),
	};
}

/**
 * The vouch predicate (T1-3). Sampled at the moment of escalation and on every touch, so it
 * caches nothing and adds no timer of its own.
 *
 * The first term is a necessary conjunction, not an optimization: with no tool in flight the
 * silence belongs to the model stream, which `streamStallTimeoutMs` owns. Without it a live
 * kernel handle would excuse a stuck provider response, which is the one case the judgement
 * table explicitly excludes.
 */
function sampleStallVouch(host: StallWatchdogWiringHost): StallVouchFacts | undefined {
	try {
		if (host.settingsManager.getStallWatchdogSettings().toolLivenessExemption === false) return undefined;
		if (host._stallInFlightTools.size === 0) return undefined;
		const facts = host._turnLiveness?.sample();
		if (!facts?.vouched) return undefined;
		return {
			active: true,
			reasons: facts.reasons,
			// Two tiers: movement buys the full budget, mere existence buys the short one that
			// stays near the pre-exemption abort threshold (M3).
			tier: facts.progress ? "progress" : "liveness",
			// The watchdog settles accrued exempt silence when this changes between two samples,
			// which is what keeps a long build that never stops producing from being charged for
			// the wall clock it takes (P1). Existence-only facts carry no token and settle nothing.
			...(facts.movementToken === undefined ? {} : { movementToken: facts.movementToken }),
			kernel: {
				...(facts.protocol === undefined ? {} : { protocol: facts.protocol }),
				...(facts.livenessAgeMs === undefined ? {} : { livenessAgeMs: facts.livenessAgeMs }),
				...(facts.liveBashHandles === undefined ? {} : { liveBashHandles: facts.liveBashHandles }),
				hostRequestCount: facts.hostRequestCount,
				...(facts.kernelPid === undefined ? {} : { kernelPid: facts.kernelPid }),
				reasons: facts.kernelReasons,
			},
		};
	} catch (error) {
		reportStallPredicateFailure(host, "vouch", error);
		return undefined;
	}
}

/**
 * Loop-level per-tool-call deadline config (r4 recovery). Both rollback handles
 * resolve here on every read: `tools.timeout.enabled: false` and
 * `tools.timeout.afterMs: 0` both yield no deadline at all, which also disarms the
 * per-tool `executionTimeoutMs` budgets - the global handles are the master switch.
 */
export function resolvedToolTimeoutConfig(host: StallWatchdogWiringHost): ToolTimeoutConfig | undefined {
	const settings = host.settingsManager.getToolTimeoutSettings();
	if (!settings.enabled || settings.afterMs <= 0) return undefined;
	return {
		afterMs: settings.afterMs,
		...(settings.perTool === undefined ? {} : { perTool: settings.perTool }),
		vouch: (info) => toolTimeoutVouch(host, info),
		describeCancellation: (info) => describeStuckStep(host, info),
	};
}

/** Output bookkeeping behind the silent-step rule: start, last output, end. */
export function trackStallStepOutput(host: StallWatchdogWiringHost, event: AgentEvent): void {
	const now = Date.now();
	if (event.type === "agent_start") {
		host._stepOutputWatch.clear();
		host._stuckStepsThisRun.clear();
		host._stepStopCauses.clear();
	} else if (event.type === "tool_execution_start") {
		host._stepOutputWatch.set(event.toolCallId, {
			toolName: event.toolName,
			args: event.args,
			startedAt: now,
			lastOutputAt: now,
		});
	} else if (event.type === "tool_execution_update") {
		const watch = host._stepOutputWatch.get(event.toolCallId);
		if (watch) watch.lastOutputAt = now;
	} else if (event.type === "tool_execution_end") {
		host._stepOutputWatch.delete(event.toolCallId);
		host._stepStopCauses.delete(event.toolCallId);
	}
}

/**
 * How long a call has produced no output (its elapsed time when untracked). A kernel
 * output-counter token that changed since the previous check counts as output too;
 * the first token seen is only the baseline.
 */
function stepSilentMs(
	host: StallWatchdogWiringHost,
	info: ToolTimeoutVouchInfo,
	movementToken?: string,
	sampleCpu = false,
	hostRequestInFlight = false,
): number {
	const watch = host._stepOutputWatch.get(info.toolCallId);
	if (!watch) return info.elapsedMs;
	const now = Date.now();
	// The host executing a request for this cell (rlm.collect, an agent_message wait) is
	// work in motion; the host-request age bound already stops a wedged handler excusing it.
	if (hostRequestInFlight) watch.lastOutputAt = now;
	if (movementToken !== undefined) {
		if (watch.movementToken !== undefined && watch.movementToken !== movementToken) watch.lastOutputAt = now;
		watch.movementToken = movementToken;
	}
	// CPU of the step's process tree is work too: a quiet compile or test run that keeps
	// computing is busy. Sampled only at a deadline recheck, never on the hot path.
	if (sampleCpu) {
		const cpuMs = sampleStepCpuMs(host);
		if (cpuMs !== undefined) {
			if (watch.cpuMs !== undefined && cpuMs - watch.cpuMs >= host.settingsManager.getSilentStuckCpuMs()) {
				watch.lastOutputAt = now;
			}
			// Keep the baseline where output was last seen, so slow CPU accumulates across checks.
			if (watch.cpuMs === undefined || watch.lastOutputAt === now) watch.cpuMs = cpuMs;
		}
	}
	return Math.max(0, now - watch.lastOutputAt);
}

/**
 * Whether an in-flight collect wait is blocked on a child that is still alive. Such a cell is
 * silent by design for as long as the child works, which is longer than the host-request age
 * bound when the wait is unbounded, and the parent was killed about twenty minutes into a
 * healthy child's job. "Alive" is the child's own evidence: an agent event inside the
 * silent-step window, or its watchdog excusing the silence. A child that went quiet with no
 * excuse stops protecting the wait, so a wedged child cannot hold its parent's step forever.
 */
function rlmCollectWaitsOnLiveChild(host: StallWatchdogWiringHost): boolean {
	if (host._rlmCollectWaits.size === 0) return false;
	const now = Date.now();
	const quietMs = host.settingsManager.getSilentStuckMs();
	for (const run of host._rlmCollectWaits.keys()) {
		if (run.settled || (run.status !== "running" && run.status !== "queued")) continue;
		const child = run.session;
		// Still starting up: admission and runtime construction are the host's own work.
		if (!child) return true;
		const lastEventAt = child.lastAgentEventAt ?? run.lastActivityAt;
		if (lastEventAt !== undefined && now - lastEventAt < quietMs) return true;
		if (child.excusedNow) return true;
	}
	return false;
}

/** The silent-step threshold for one call: the setting, or the call's own explicit timeout if longer. */
function stepStuckAfterMs(host: StallWatchdogWiringHost, toolCallId: string): number {
	const configured = host.settingsManager.getSilentStuckMs();
	const explicit = explicitTimeoutMs(host._stepOutputWatch.get(toolCallId)?.args);
	return explicit === undefined ? configured : Math.max(configured, explicit);
}

/**
 * Cumulative CPU (ms) of the kernel and its bash handles' process trees, or the kernel's
 * own heartbeat CPU when `ps` is unavailable. Undefined means no CPU evidence: the rule
 * then falls back to output alone.
 */
function sampleStepCpuMs(host: StallWatchdogWiringHost): number | undefined {
	try {
		if (host._stepCpuProbe) return host._stepCpuProbe();
		const facts = host._stallKernelLivenessFacts
			? host._stallKernelLivenessFacts()
			: kernelLivenessFactsFromClient(host);
		const kernelPid = facts?.kernelPid;
		const roots = kernelPid === undefined ? [] : [kernelPid];
		const journal = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		if (journal && kernelPid !== undefined) {
			for (const record of readActiveOrphanProcesses(journal, process.pid, { maxBytes: 256 * 1024 })) {
				if (record.kernelPid === kernelPid && record.pid !== kernelPid) roots.push(record.pid);
			}
		}
		return readProcessTreeCpuMs(roots) ?? facts?.latest?.cpuMs;
	} catch {
		return undefined;
	}
}

/** A plain description of a step for the model and the duty log: the command or cell preview. */
function describeStepForRecovery(host: StallWatchdogWiringHost, toolCallId: string, toolName: string): string {
	const args = host._stepOutputWatch.get(toolCallId)?.args as Record<string, unknown> | undefined;
	const pick = (key: string): string | undefined =>
		typeof args?.[key] === "string" && (args[key] as string).trim() ? (args[key] as string).trim() : undefined;
	const code = pick("code");
	const text =
		code !== undefined
			? previewIpythonCode(code).text || code.split("\n")[0] || toolName
			: (pick("command") ?? pick("path") ?? pick("file_path") ?? toolName);
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > 120 ? `${single.slice(0, 119)}…` : single;
}

/**
 * The detail a stopped call's cancellation carries: which step, how long it was
 * silent, that it was stopped, and what to do instead. A step stuck twice in one
 * run is called out so the model stops retrying the same path.
 */
function describeStuckStep(host: StallWatchdogWiringHost, info: ToolTimeoutVouchInfo): string {
	const step = describeStepForRecovery(host, info.toolCallId, info.toolName);
	const silentMs = stepSilentMs(host, info);
	const cause = host._stepStopCauses.get(info.toolCallId);
	host._stepStopCauses.delete(info.toolCallId);
	const seen = (host._stuckStepsThisRun.get(step) ?? 0) + 1;
	host._stuckStepsThisRun.set(step, seen);
	host._recordSelfRecovery({
		kind: "stuck_step_stopped",
		toolCallId: info.toolCallId,
		toolName: info.toolName,
		step,
		silentMs,
		repeated: seen > 1,
		...(cause?.kind === "time_limit" ? { cause: "time_limit" as const } : {}),
		at: Date.now(),
	});
	if (cause?.kind === "time_limit") {
		// Not a hang: the call may have been busy the whole time. Saying "no output" here would
		// send the model hunting for a bug that does not exist.
		const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
		return [
			`Step \`${step}\` was stopped after ${minutes(info.elapsedMs)} min: the ${STEP_TIME_LIMIT_MARKER} for this turn (${minutes(cause.budgetMs)} min, armed because stallWatchdog.abortAfterSeconds is set) is spent. Its last output was ${Math.round(silentMs / 1000)}s ago, so it was not necessarily hung.`,
			"Output that reaches the session is what keeps a long step inside the budget, so rerunning it unchanged will be stopped at the same point: make it report progress as it goes, split it into shorter steps, or run it as a background handle and poll it.",
		].join(" ");
	}
	const lines = [
		`Stuck step: \`${step}\` produced no output for ${Math.round(silentMs / 1000)}s and showed no progress, so it was stopped.`,
		seen > 1
			? "This same step got stuck before in this run: do not run it again. Two identical hangs mean the approach is the problem, not bad luck; take a different path (a smaller input, an explicit timeout, a background handle you poll, or a different tool)."
			: "Running it again unchanged will most likely hang the same way; change what makes it hang first (a smaller input, an explicit timeout, a background handle you poll, or a different tool).",
		"If the next cell reports that the kernel is still busy, retry once: a kernel that stays busy is restarted automatically and its saved state restored.",
	];
	return lines.join(" ");
}

/**
 * Verdict for a fired per-call deadline, with the stall watchdog as the single
 * arbiter (r4 recovery): the extension consumes the same exemption budget the abort
 * stage defers by - never a second pool. A paused turn boundary defers like the abort
 * stage does, and an exhausted budget cancels when the owner armed the abort stage
 * (`stallWatchdog.abortAfterSeconds` > 0). Otherwise the silent-step rule decides,
 * with or without liveness evidence: the call is busy while it produces output (its own
 * updates, the kernel's output counters, its process tree's CPU, an in-flight host
 * request) and stuck once it has produced none for the silent-step threshold
 * (`tools.timeout.silentStuckSeconds`, or the call's own longer explicit timeout).
 *
 * Missing evidence is not proof of a hang: a synchronous cell (subprocess.run, a
 * download, numpy compute) freezes the kernel loop so the kernel cannot vouch for it,
 * and cancelling on missing evidence killed legitimate long work at the first deadline.
 */
function toolTimeoutVouch(host: StallWatchdogWiringHost, info: ToolTimeoutVouchInfo): ToolTimeoutVerdict | undefined {
	try {
		const exemption = host._stallWatchdog?.deferToolTimeout(info.toolCallId);
		// A spent budget is a kill only when the owner armed the watchdog's abort: that budget is
		// what the abort stage defers by, and the per-call deadline must not outlive it. In the
		// default warn-only mode nothing else is ever killed for spending it, so a quiet but busy
		// build (CPU moving, or its own longer explicit timeout) stays with the silent-step rule
		// below instead of dying at the budget's wall-clock mark.
		const abortArmed = host.settingsManager.getStallWatchdogSettings().abortAfterSeconds > 0;
		if (exemption?.exhausted === true && abortArmed) {
			host._stepStopCauses.set(info.toolCallId, {
				kind: "time_limit",
				budgetMs: exemption.budgetMs,
				usedMs: exemption.usedMs,
			});
			return { action: "fail" };
		}
		const remainingMs = exemption?.exhausted === true ? undefined : exemption?.remainingMs;
		if (exemption?.reason === "paused") {
			return {
				action: "extend",
				recheckMs: boundToolTimeoutRecheck(info.timeoutMs, remainingMs),
			};
		}
		const stuckAfterMs = stepStuckAfterMs(host, info.toolCallId);
		const vouch = sampleStallVouch(host);
		const hostRequestInFlight =
			vouch?.reasons?.includes(STALL_VOUCH_REASONS.hostRequestInFlight) === true || rlmCollectWaitsOnLiveChild(host);
		const silentMs = stepSilentMs(host, info, vouch?.movementToken, true, hostRequestInFlight);
		if (silentMs >= stuckAfterMs) {
			host._stepStopCauses.set(info.toolCallId, { kind: "silent" });
			return { action: "fail" };
		}
		const recheckMs = exemption?.tier === "progress" ? info.timeoutMs : Math.round(info.timeoutMs / 2);
		return {
			action: "extend",
			recheckMs: boundToolTimeoutRecheck(Math.max(1_000, Math.min(recheckMs, stuckAfterMs - silentMs)), remainingMs),
		};
	} catch (error) {
		reportStallPredicateFailure(host, "toolTimeout", error);
		// K3 asymmetry: the deadline's judge failing fails towards NOT killing
		// (the turn-level watchdog still guards the call), the way the loop-side
		// vouch throw path does.
		return { action: "extend", recheckMs: info.timeoutMs };
	}
}

/** Re-arm delay for a granted extension: never past the remaining budget, never sub-second. */
function boundToolTimeoutRecheck(recheckMs: number, remainingMs: number | undefined): number {
	if (typeof remainingMs !== "number" || !Number.isFinite(remainingMs) || remainingMs <= 0) return recheckMs;
	return Math.max(1_000, Math.min(recheckMs, remainingMs));
}

function reportStallPredicateFailure(host: StallWatchdogWiringHost, predicate: string, error: unknown): void {
	// One line per predicate per turn: the failure has to be loud (a silently dead watchdog is
	// worse than the bug it was guarding) but sampling happens on every touch.
	if (host._stallPredicateFailures.has(predicate)) return;
	host._stallPredicateFailures.add(predicate);
	sessionLog.warn("stall watchdog predicate failed; treating it as no exemption", {
		predicate,
		error: error instanceof Error ? error.message : String(error),
		sessionId: host.sessionManager.getSessionId(),
	});
}

function logStallExemptionEvent(host: StallWatchdogWiringHost, event: StallExemptionEvent): void {
	const { msg, fields } = formatStallExemptionEventLog(event);
	sessionLog.info(msg, { ...fields, sessionId: host.sessionManager.getSessionId() });
}

function handleTurnLivenessEvent(host: StallWatchdogWiringHost, event: TurnLivenessEvent): void {
	// B4: the degraded path is a fallback, not a silent no-op. One line per kind per turn keeps
	// it countable in the daemon log without repeating it on every sample.
	if (host._turnLivenessLogged.has(event.kind)) return;
	host._turnLivenessLogged.add(event.kind);
	const fields = { ...event, sessionId: host.sessionManager.getSessionId() };
	if (event.kind === "degraded_read") {
		sessionLog.info("stall watchdog: kernel heartbeat unusable, fell back to journaled bash handles", fields);
		return;
	}
	sessionLog.warn(`stall watchdog: kernel liveness ${event.kind.replaceAll("_", " ")}`, fields);
}

/**
 * Re-read the degraded facts when the kernel heartbeat cannot vouch. Bounded to one journal
 * read per stall stage (a sync file read, tens of ms) and only while a tool is in flight, so
 * the fallback cannot become a polling loop. The result lands in time for the next sampling:
 * a deferred abort re-checks at most one warn window later.
 */
function refreshStallDegradedFacts(host: StallWatchdogWiringHost): void {
	try {
		if (host._stallInFlightTools.size === 0) return;
		const facts = host._turnLiveness?.sample();
		if (!facts || facts.state === "fresh") return;
		host._turnLiveness?.refreshDegradedFacts();
	} catch (error) {
		reportStallPredicateFailure(host, "degradedFacts", error);
	}
}

/** Kernel segment for a stall diagnostics payload; undefined when there is no kernel. */
function collectStallKernelDiagnostics(host: StallWatchdogWiringHost): StallKernelDiagnostics | undefined {
	try {
		const facts = host._turnLiveness?.sample();
		if (!facts || facts.protocol === undefined) return undefined;
		return normalizeStallKernelFacts({
			protocol: facts.protocol,
			...(facts.livenessAgeMs === undefined ? {} : { livenessAgeMs: facts.livenessAgeMs }),
			...(facts.liveBashHandles === undefined ? {} : { liveBashHandles: facts.liveBashHandles }),
			hostRequestCount: facts.hostRequestCount,
			...(facts.kernelPid === undefined ? {} : { kernelPid: facts.kernelPid }),
			reasons: facts.kernelReasons,
		});
	} catch (error) {
		reportStallPredicateFailure(host, "diagnostics", error);
		return undefined;
	}
}

/**
 * Feeds the stall watchdog: every agent event counts as activity. `agent_start`
 * arms it, `agent_end` disarms it, so the watchdog only runs while a turn (or a
 * multi-turn run) is in flight.
 */
export function recordStallWatchdogActivity(host: StallWatchdogWiringHost, event: AgentEvent): void {
	const watchdog = host._stallWatchdog;
	if (!watchdog) return;
	const now = Date.now();
	host._stallLastEvent = { type: event.type, at: now };
	if (event.type === "tool_execution_start") {
		host._stallInFlightTools.set(event.toolCallId, { toolName: event.toolName, startedAt: now });
		// B4 ordering: the degraded read is bounded by its own lifetime, so refreshing here lets
		// the first warning already see the journaled handles instead of promising an abort that
		// the next sampling then defers. It only reads at all when the kernel heartbeat cannot
		// vouch (a protocol-3 kernel, or one whose frames stopped arriving).
		refreshStallDegradedFacts(host);
	} else if (event.type === "tool_execution_end") {
		host._stallInFlightTools.delete(event.toolCallId);
	}
	if (event.type === "agent_start") {
		host._stallInFlightTools.clear();
		// A new turn means the aborted turn is history: without this reset a
		// follow-up turn that completes normally would still be classified
		// against the earlier abort reason, and the roster would keep showing a
		// stall marker for a session that recovered.
		host._lastTurnAbortReason = undefined;
		host._stallState = undefined;
		// A new turn also closes every stall-recovery claim scoped to the
		// previous epoch: the episode that claimed it either recovered (this
		// turn is its evidence) or ended, and neither may act again.
		host._turnLifecycleEpoch += 1;
		// Same rule for the vouch's own state: a degraded journal read from the previous turn
		// must not excuse this one, and the once-per-turn log throttles restart with the turn.
		host._lastStallAbortCause = undefined;
		host._turnLiveness?.reset();
		host._stallPredicateFailures.clear();
		host._turnLivenessLogged.clear();
		watchdog.arm();
		return;
	}
	if (event.type === "agent_end") {
		host._stallInFlightTools.clear();
		// The abort took effect: the run produced a terminal event after it.
		if (host._lastStallAbort) host._lastStallAbort = { ...host._lastStallAbort, settled: true };
		watchdog.disarm();
		return;
	}
	watchdog.touch();
}

function collectStallDiagnostics(host: StallWatchdogWiringHost, silentMs: number): StallDiagnostics {
	const now = Date.now();
	const lastEvent = host._stallLastEvent;
	// The exemption segment is measured against the clock without re-sampling the predicates,
	// so collecting diagnostics cannot perturb the watchdog it describes.
	const exemption = host._stallWatchdog?.collectExemptionDiagnostics();
	const kernel = collectStallKernelDiagnostics(host);
	return {
		silentMs,
		busy: {
			streaming: host.isStreaming,
			compacting: host.isCompacting,
			retrying: host.isRetrying,
			bashRunning: host.isBashRunning,
		},
		lastEvent: lastEvent ? { ...lastEvent, ageMs: now - lastEvent.at } : undefined,
		inFlightToolCalls: [...host._stallInFlightTools.entries()].map(([toolCallId, entry]) => ({
			toolCallId,
			toolName: entry.toolName,
			startedAt: entry.startedAt,
			elapsedMs: now - entry.startedAt,
		})),
		pump: {
			suspended: host._sessionInputPumpSuspended,
			requested: host._sessionInputPumpRequested,
			epoch: host._sessionInputPumpEpoch,
		},
		unfinishedActions: host._actionStore.unfinishedActions().length,
		// Only a claimed exemption gets a segment: `collectExemptionDiagnostics` always returns
		// a shape, and an empty one in the payload would read as "an exemption was considered
		// and measured" rather than "nothing was ever excused".
		...(exemption?.reason ? { exemption } : {}),
		...(kernel ? { kernel } : {}),
	};
}

function handleStallWatchdogStage(host: StallWatchdogWiringHost, info: StallWatchdogStageInfo): void {
	const settings = host.settingsManager.getStallWatchdogSettings();
	// The watchdog re-checks its own live flag before firing, but a stage can be in
	// flight when the user disables it. Never warn about, or abort, a live turn the
	// user just put back under their own control.
	if (!settings.enabled) return;
	// B4: when the kernel heartbeat cannot vouch (stale, absent, or all frames rejected), the
	// journaled bash children are the only remaining fact. Read them once per stage, before
	// this stage's diagnostics are collected, so the next sampling sees them: a deferred abort
	// re-checks within one warn window.
	refreshStallDegradedFacts(host);
	const diagnostics = collectStallDiagnostics(host, info.silentMs);
	const logFields = {
		stage: info.stage,
		silentMs: info.silentMs,
		sessionId: host.sessionManager.getSessionId(),
		diagnostics,
	};
	// Roster marker: survives until the next agent_start so a wedged session
	// keeps reporting its silence instead of reading as healthy progress.
	// B9: an unspent exemption means the silence is owned work, not a wedge. The label travels
	// with the facts so every renderer (roster row, agents view, daemon-attached parent) reads
	// the same verdict instead of re-deriving one from `silentMs`.
	const stageExemption = info.exemption;
	const excused = stageExemption !== undefined && !stageExemption.exhausted;
	host._stallState = {
		silentMs: info.silentMs,
		thresholdMs: info.stage === "warn" ? settings.warnAfterSeconds * 1000 : settings.abortAfterSeconds * 1000,
		inFlightTools: diagnostics.inFlightToolCalls.map((call) => call.toolName),
		unsettled: info.stage === "abort_unsettled" || host._stallState?.unsettled === true ? true : undefined,
		...(excused && stageExemption ? { excused: true, excusedReasons: [...stageExemption.reasons] } : {}),
	};
	const kernelReasons = readStallKernelReasons(diagnostics);
	// F3: a warn-only watchdog (abortAfterSeconds 0) has no abort channel, so an exemption
	// defers nothing and the vouched copy would promise a deferral that cannot happen. Such a
	// session gets the unexempted text it has always gotten; the exemption is still in the
	// diagnostics and the log either way.
	const messageContext: StallMessageContext = {
		silentMs: info.silentMs,
		abortAfterSeconds: settings.abortAfterSeconds,
		...(settings.abortAfterSeconds > 0 && info.exemption ? { exemption: info.exemption } : {}),
		...(diagnostics.kernel ? { kernel: diagnostics.kernel } : {}),
	};
	const exemptionFields = info.exemption ? { exemption: info.exemption } : {};
	if (info.stage === "warn") {
		const message = buildStallWarnMessage(messageContext);
		sessionLog.warn("stall watchdog: no activity while turn running", { ...logFields, ...exemptionFields });
		// The warning is the only trace a warn-only watchdog leaves: without it a turn that hung for
		// two days reads as "没出问题" in the duty log. Excused silence is healthy long work, not an
		// incident, so it stays out.
		if (!excused) host._recordDutyEvent({ kind: "stall_warning", silentMs: info.silentMs });
		host._emit({
			type: "stall_warning",
			message,
			silentMs: info.silentMs,
			thresholdMs: settings.warnAfterSeconds * 1000,
			diagnostics,
		});
		return;
	}
	if (info.stage === "abort") {
		const message = buildStallAbortMessage(messageContext);
		sessionLog.error("stall watchdog: aborting silent turn", { ...logFields, ...exemptionFields });
		// Recorded before the abort so the terminal classifier can tell a
		// watchdog kill from an ordinary completion; `settled` starts true and
		// only the abort_unsettled stage below revokes it.
		host._lastStallAbort = {
			silentMs: info.silentMs,
			thresholdMs: settings.abortAfterSeconds * 1000,
			inFlightTools: host._stallState.inFlightTools,
			kernelReasons: kernelReasons.length > 0 ? kernelReasons : undefined,
			settled: true,
		};
		// Structured cause for the aborted cell's own report (T1-5): what was vouching when the
		// budget ran out is part of the story, so both reason lists ride along, deduplicated.
		host._lastStallAbortCause = {
			silentMs: info.silentMs,
			reasons: [...new Set(["stall_watchdog", ...(info.exemption?.reasons ?? []), ...kernelReasons])],
			...(diagnostics.kernel?.kernelPid === undefined ? {} : { kernelPid: diagnostics.kernel.kernelPid }),
			at: Date.now(),
		};
		host._emit({
			type: "stall_abort",
			message,
			silentMs: info.silentMs,
			thresholdMs: settings.abortAfterSeconds * 1000,
			diagnostics,
		});
		host.requestAbort({ reason: "stall_watchdog" });
		return;
	}
	// abort_unsettled: the abort fired but the run never produced agent_end.
	// Emitted as its own type (not a second stall_warning) so "killed but still
	// running" is countable apart from "looks stuck"; a parent that sees it
	// records the fact on the run and keeps the kill classification.
	const message = buildStallAbortUnsettledMessage(messageContext);
	sessionLog.error("stall watchdog: abort did not settle the turn", { ...logFields, ...exemptionFields });
	if (host._lastStallAbort) host._lastStallAbort = { ...host._lastStallAbort, settled: false };
	host._emit({
		type: "stall_unsettled",
		message,
		silentMs: info.silentMs,
		thresholdMs: settings.abortAfterSeconds * 1000,
		diagnostics,
	});
}
