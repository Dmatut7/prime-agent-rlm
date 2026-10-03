/**
 * RLM child stall-notice cluster extracted from agent-session.ts: the parent-facing
 * half of a child's stall-watchdog warn stage - the notice admitted as its own
 * turn, the minimum-interval throttle, and the recheck timer that follows an
 * excused silence until the excuse lapses. The moved methods keep exactly the
 * same bodies; they read the session through {@link RlmChildStallNoticeHost},
 * which `AgentSession` satisfies structurally, so the move changes no runtime
 * behavior. `cloneCustomMessage` moved here with the cluster (the deferral path
 * clones): agent-session.ts imports it back, and this module never imports an
 * agent-session value, so the layering stays acyclic.
 */
import { getLogger } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.js";
import { type CustomMessage, createRlmChildStallNoticeMessage } from "./messages.js";
import type { RlmChildRun } from "./rlm-child-run.js";
import type { StallDiagnostics } from "./stall-diagnostics.js";

// Same logger name as agent-session.ts: the stall-notice delivery moved here
// verbatim and its log lines keep the namespace they have always emitted under.
const sessionLog = getLogger("coding-agent.agent-session");

/**
 * Minimum spacing between two parent-facing "this child is still silent" notices for
 * one run. The watchdog's warn stage is already edge-triggered (it fires once per
 * silence episode and re-arms on the child's next event), so this only bounds the
 * case of a child that keeps re-arming the stage with a trickle of events: the
 * parent gets at most one notice per interval instead of one per re-arm.
 */
const RLM_CHILD_STALL_NOTICE_MIN_INTERVAL_MS = 10 * 60_000;

export function cloneCustomMessage(message: CustomMessage): CustomMessage {
	return {
		...message,
		content: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : message.content,
	};
}

/**
 * The seam of `AgentSession` the extracted stall-notice delivery reads and
 * mutates. The pump-admission members are indexed access types so their wide
 * signatures stay single-sourced on the class;
 * `AgentSession._enqueueRlmChildStallNoticeAction`, `_notifyRlmChildStall` and
 * `_armRlmChildStallRecheck` have no shells left: the one caller (the child
 * event subscription in rlm-child-run.ts) calls `notifyRlmChildStall` directly.
 */
export interface RlmChildStallNoticeHost {
	readonly sessionId: string;
	readonly _disposed: boolean;
	readonly _disposing: boolean;
	_createPreparedTurnAction: AgentSession["_createPreparedTurnAction"];
	_turnExecutionPolicy: AgentSession["_turnExecutionPolicy"];
	_admitSessionInput: AgentSession["_admitSessionInput"];
	_scheduleSessionInputPump(): void;
	_pushPendingNextTurnMessages(...messages: CustomMessage[]): void;
	_asError(error: unknown): Error;
}

/**
 * Admit a stall notice as its own turn, the way a terminal notice reaches the
 * parent: the input pump schedules it once the session is free, so a parent that
 * is idle when its child goes quiet still gets told instead of finding out
 * whenever it happens to run next.
 */
function enqueueRlmChildStallNoticeAction(host: RlmChildStallNoticeHost, message: CustomMessage): void {
	const action = host._createPreparedTurnAction("followUp", message.content as string, undefined, {
		message,
		suppressAutonomousContinuation: true,
		resumeIfIdle: false,
		source: "internal",
		executionPolicy: host._turnExecutionPolicy("injected"),
		queueVisible: false,
	});
	const result = host._admitSessionInput(action, { wake: false });
	if (!result.accepted) throw new Error("RLM child stall notice was not admitted.");
}

/**
 * Tell the parent (this session) that a direct child has been silent past the
 * watchdog's warn stage - without killing anything.
 *
 * The warn stage used to be roster-only: the sole stall signal a parent model ever
 * received was the failure notice that a kill produced, so a warn-only watchdog
 * would have traded a false kill for no signal at all. The notice is the signal;
 * whether the silence is genuine work or a wedge is the parent's call, and the
 * parent holds the lever (`rlm.delete_subagent`) for the wedge case.
 */
export function notifyRlmChildStall(
	host: RlmChildStallNoticeHost,
	run: RlmChildRun,
	child: AgentSession,
	sessionName: string,
	event: { silentMs: number; thresholdMs: number; diagnostics: StallDiagnostics },
): void {
	// Same two-flag guard the terminal-notice publication gate uses: a run that is
	// being deleted (detachedDeletion) or whose notices are suppressed must not be
	// pinged - the parent itself asked for this child to go away.
	if (host._disposed || host._disposing || run.detachedDeletion || run.suppressTerminalNotice) return;
	const exemption = event.diagnostics.exemption;
	if (exemption?.reason !== undefined && exemption.exhausted !== true) {
		// Excused silence is healthy long work (a live build, a host-owned phase): the notice would
		// start a paid parent turn only to say "still working", up to every ten minutes per child
		// for the whole job. The roster already shows it as long-running. The parent is told once
		// the excuse lapses while the child is still silent.
		armRlmChildStallRecheck(host, run, child, sessionName, event);
		return;
	}
	const now = Date.now();
	if (run.lastStallNoticeAt !== undefined && now - run.lastStallNoticeAt < RLM_CHILD_STALL_NOTICE_MIN_INTERVAL_MS) {
		return;
	}
	run.lastStallNoticeAt = now;
	const inFlightTools = event.diagnostics.inFlightToolCalls.map((call) =>
		call.elapsedMs > 0 ? `${call.toolName} (${Math.max(1, Math.round(call.elapsedMs / 1000))}s)` : call.toolName,
	);
	// The deadline that matters is the child's own watchdog - it is the one that can
	// abort the turn - so the notice describes the child's configuration, not the
	// parent's. The two differ whenever a project-scope settings file overrides the
	// global one for one side only.
	const abortAfterMs = child.settingsManager.getStallWatchdogSettings().abortAfterSeconds * 1000;
	const message = createRlmChildStallNoticeMessage({
		childId: run.id,
		sessionName,
		silentMs: event.silentMs,
		thresholdMs: event.thresholdMs,
		inFlightTools,
		...(abortAfterMs > 0 ? { abortAfterMs } : {}),
	});
	try {
		enqueueRlmChildStallNoticeAction(host, message);
		host._scheduleSessionInputPump();
	} catch (error) {
		// A paused pump (a user dialog, compaction) must not drop the only signal the
		// parent gets; keep the notice for the next turn boundary instead.
		host._pushPendingNextTurnMessages(cloneCustomMessage(message));
		sessionLog.warn("child stall notice deferred to the next turn boundary", {
			sessionId: host.sessionId,
			childId: run.id,
			message: host._asError(error).message,
		});
	}
}

/**
 * Watch a child whose stall notice was held back because its silence was excused. Re-checked
 * every child warn window: a child that moved again is back under its own watchdog (the next
 * silence warns afresh), one still excused keeps waiting, and one still silent after the excuse
 * lapsed is a real stall the parent must hear about.
 */
function armRlmChildStallRecheck(
	host: RlmChildStallNoticeHost,
	run: RlmChildRun,
	child: AgentSession,
	sessionName: string,
	event: { silentMs: number; thresholdMs: number; diagnostics: StallDiagnostics },
): void {
	if (run.stallRecheckTimer !== undefined) return;
	const warnedAt = Date.now();
	const lastEventAtWarn = child.lastAgentEventAt;
	const recheck = () => {
		run.stallRecheckTimer = undefined;
		if (host._disposed || host._disposing || run.settled || run.stall === undefined) return;
		if (child.lastAgentEventAt !== lastEventAtWarn) return;
		if (child.excusedNow) {
			schedule();
			return;
		}
		const { exemption: _lapsedExemption, ...diagnostics } = event.diagnostics;
		notifyRlmChildStall(host, run, child, sessionName, {
			...event,
			silentMs: event.silentMs + (Date.now() - warnedAt),
			diagnostics,
		});
	};
	const schedule = () => {
		const timer = setTimeout(recheck, Math.max(1_000, event.thresholdMs));
		timer.unref?.();
		run.stallRecheckTimer = timer;
	};
	schedule();
}
