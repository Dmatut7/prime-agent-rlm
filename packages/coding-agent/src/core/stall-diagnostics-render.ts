import type { StallDiagnostics } from "./stall-diagnostics.js";
import { resolveStallDiagnosticsPointer } from "./stall-evidence.js";

/**
 * One stall event as the UI ends receive it (all three stages share this shape).
 *
 * `diagnostics` is optional because the wire crosses versions: a daemon from
 * before the diagnostics payload emits the stall events without it, and the
 * renderer must degrade that to an explicit "unknown" line instead of throwing
 * inside an event handler.
 */
export interface StallEventView {
	type: string;
	message: string;
	silentMs: number;
	thresholdMs: number;
	diagnostics?: StallDiagnostics | undefined;
}

function seconds(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function yesNo(value: boolean): string {
	return value ? "yes" : "no";
}

function isSegment(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** X-3: both pointer paths resolve in this client, not in the emitting daemon. */
const RESOLVED_LOCALLY_QUALIFIER =
	"resolved locally in this client; the emitting daemon may record under its own logs dir";

function flag(segment: Record<string, unknown>, key: string): string {
	const value = segment[key];
	return typeof value === "boolean" ? yesNo(value) : "unknown";
}

/**
 * The actionable fields of a stall diagnostics payload, one line each.
 *
 * A stall event carries the full forensic snapshot, but rendering only `message` leaves the
 * operator with "something was silent" and no way to act: which tool call to interrupt, whether
 * the pump is wedged, what the kernel last said. These are the fields that change what you do
 * next.
 *
 * Every segment is guarded: the payload crosses the daemon wire, and a producer whose shape
 * drifts (an older daemon, a partially-written entry) must degrade to an explicit `unknown`
 * line rather than crash the renderer that consumes the event.
 */
export function formatStallDiagnosticsLines(diagnostics: StallDiagnostics | undefined): string[] {
	const lines: string[] = [];
	const payload = isSegment(diagnostics) ? (diagnostics as Record<string, unknown>) : undefined;
	if (!payload) {
		lines.push("diagnostics: unknown (event predates the diagnostics payload)");
		// X-3: the downgrade must still point somewhere. DO-1's retrievability
		// promise is exactly for this mixed-version event, and the pre-fix
		// early-return swallowed the pointer line with the payload. The pointer
		// below is resolved in *this* process (the renderer/client), not by the
		// daemon that emitted the event: when the daemon runs under a different
		// agent dir, its own logs hold the record and these paths do not.
		const degradedPointer = resolveStallDiagnosticsPointer();
		lines.push(
			`diagnostics file (${RESOLVED_LOCALLY_QUALIFIER}): ${degradedPointer.evidencePath} (also ${degradedPointer.agentLogPath})`,
		);
		return lines;
	}
	const busy = payload.busy;
	if (isSegment(busy)) {
		lines.push(
			`busy: streaming=${flag(busy, "streaming")} compacting=${flag(busy, "compacting")} ` +
				`retrying=${flag(busy, "retrying")} bashRunning=${flag(busy, "bashRunning")}`,
		);
	} else {
		lines.push("busy: unknown");
	}
	const inFlightCalls = payload.inFlightToolCalls;
	if (Array.isArray(inFlightCalls)) {
		const inFlight = inFlightCalls.map((call) => {
			if (!isSegment(call)) return "unknown (malformed tool call)";
			const toolName = typeof call.toolName === "string" ? call.toolName : "unknown";
			const toolCallId = typeof call.toolCallId === "string" ? call.toolCallId : "unknown";
			const elapsed = typeof call.elapsedMs === "number" ? seconds(call.elapsedMs) : "unknown";
			return `${toolName} (id=${toolCallId}, ${elapsed})`;
		});
		lines.push(`in-flight tools: ${inFlight.length > 0 ? inFlight.join(", ") : "none"}`);
	} else {
		lines.push("in-flight tools: unknown");
	}
	const lastEvent = payload.lastEvent;
	lines.push(
		isSegment(lastEvent)
			? `last event: ${typeof lastEvent.type === "string" ? lastEvent.type : "unknown"} ` +
					`(${typeof lastEvent.ageMs === "number" ? seconds(lastEvent.ageMs) : "unknown"} ago)`
			: "last event: none recorded",
	);
	const pump = payload.pump;
	if (isSegment(pump)) {
		lines.push(
			`pump: suspended=${flag(pump, "suspended")} requested=${flag(pump, "requested")} ` +
				`epoch=${typeof pump.epoch === "number" ? pump.epoch : "unknown"}`,
		);
	} else {
		lines.push("pump: unknown");
	}
	const unfinishedActions = payload.unfinishedActions;
	lines.push(`unfinished actions: ${typeof unfinishedActions === "number" ? unfinishedActions : "unknown"}`);
	const exemption = payload.exemption;
	if (exemption !== undefined) {
		if (isSegment(exemption)) {
			const reasonsValue = exemption.reasons;
			const reasons = Array.isArray(reasonsValue)
				? reasonsValue.filter((reason): reason is string => typeof reason === "string")
				: [];
			const remainingMs = exemption.budgetRemainingMs;
			const remaining = typeof remainingMs === "number" ? seconds(remainingMs) : undefined;
			lines.push(
				`exemption: ${typeof exemption.reason === "string" ? exemption.reason : "unspecified"} [${reasons.join(", ") || "none"}]` +
					`${remaining ? ` budget left ${remaining}` : ""}` +
					`${exemption.exhausted === true ? " (exhausted)" : ""}`,
			);
		} else {
			lines.push("exemption: unknown");
		}
	}
	const kernel = payload.kernel;
	if (kernel !== undefined) {
		if (isSegment(kernel)) {
			const kernelPid = kernel.kernelPid;
			const livenessAgeMs = kernel.livenessAgeMs;
			const liveBashHandles = kernel.liveBashHandles;
			const hostRequestCount = kernel.hostRequestCount;
			const reasonsValue = kernel.reasons;
			const reasons = Array.isArray(reasonsValue)
				? reasonsValue.filter((reason): reason is string => typeof reason === "string")
				: [];
			const facts = [
				`kernel pid ${typeof kernelPid === "number" ? kernelPid : "unknown"}`,
				`reasons: ${reasons.length > 0 ? reasons.join(", ") : "none"}`,
				...(typeof livenessAgeMs === "number" ? [`livenessAgeMs ${livenessAgeMs}`] : []),
				...(typeof liveBashHandles === "number" ? [`liveBashHandles ${liveBashHandles}`] : []),
				...(typeof hostRequestCount === "number" ? [`hostRequests ${hostRequestCount}`] : []),
			];
			lines.push(facts.join("; "));
		} else {
			lines.push("kernel: unknown");
		}
	}
	// X-3: this path resolves the pointer in *this* process too, so it carries
	// the same locality qualifier as the degraded path above - without it the
	// payload-present wording implied the emitting daemon wrote these paths.
	const pointer = resolveStallDiagnosticsPointer();
	lines.push(
		`diagnostics file (${RESOLVED_LOCALLY_QUALIFIER}): ${pointer.evidencePath} (also ${pointer.agentLogPath})`,
	);
	return lines;
}

/** Message first (so existing renderers keep their one-line behaviour), then the diagnostics. */
/** Where a terminal stall left its evidence, as one short line. */
export function stallEvidenceHint(): string {
	return `诊断记录：${resolveStallDiagnosticsPointer().evidencePath}`;
}

/** `45 秒`, `5 分钟`, `3 小时 5 分`: a bar left up overnight reads in hours. */
function durationText(ms: number): string {
	const secondsValue = Math.max(1, Math.round(ms / 1000));
	if (secondsValue < 90) return `${secondsValue} 秒`;
	const minutes = Math.round(secondsValue / 60);
	if (minutes < 90) return `${minutes} 分钟`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest > 0 ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

/**
 * The stall event as one line a person can act on: how long it has been quiet,
 * what it is waiting for, and what is still running. The forensic lines
 * ({@link formatStallEventLines}) stay one key away (stall diagnostics).
 *
 * `sinceEventMs` is how much longer the quiet has lasted since the event was measured, so a line
 * kept on screen keeps telling the truth.
 */
export function formatStallSummary(event: StallEventView, sinceEventMs = 0): string {
	const payload = isSegment(event.diagnostics) ? (event.diagnostics as Record<string, unknown>) : undefined;
	const extraMs = Math.max(0, sinceEventMs);
	const quiet = durationText(event.silentMs + extraMs);
	if (event.type === "stall_abort") return `\u2717 已经 ${quiet}没有动静，这一轮被自动中断了`;
	if (event.type === "stall_unsettled") return "\u2717 这一轮已经中断，但还有工作没停下来";
	const calls = Array.isArray(payload?.inFlightToolCalls) ? payload.inFlightToolCalls.filter(isSegment) : [];
	const first = calls[0];
	const kernel = isSegment(payload?.kernel) ? payload.kernel : undefined;
	const handles = typeof kernel?.liveBashHandles === "number" ? kernel.liveBashHandles : 0;
	const background = handles > 0 ? `，后台还有 ${handles} 个命令在跑` : "";
	if (first) {
		const tool = typeof first.toolName === "string" ? first.toolName : "工具";
		const elapsed = typeof first.elapsedMs === "number" ? `（已 ${durationText(first.elapsedMs + extraMs)}）` : "";
		const more = calls.length > 1 ? `等 ${calls.length} 步` : "这一步";
		return `\u26a0 已经 ${quiet}没有动静：正在等 ${tool} ${more}${elapsed}${background}`;
	}
	const busy = isSegment(payload?.busy) ? payload.busy : undefined;
	if (busy?.streaming === true) return `\u26a0 已经 ${quiet}没有动静：正在等模型回复${background}`;
	return `\u26a0 已经 ${quiet}没有动静${background}`;
}

/** What an exemption reason means to the owner, in the words they would use. */
const EXCUSE_TEXT: Record<string, string> = {
	live_bash_handles: "后台命令还在跑",
	host_request_in_flight: "程序在等主机把一件事办完（比如等子代理）",
	kernel_loop_awaiting_cell: "Python 还在正常运行",
	kernel_reviving: "Python 内核正在重启恢复",
	kernel_finishing_result: "Python 正在整理这一步的结果",
	degraded_journal: "记录里还有后台命令在跑",
};

function stringsOf(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The opening of the diagnostics block, for the owner rather than a developer: what was
 * happening and for how long, what it most likely means, and what they can do about it. The raw
 * lines ({@link formatStallEventLines}) follow it as reference.
 */
export function formatStallExplanation(
	event: StallEventView,
	options: { interruptKey?: string; sinceEventMs?: number } = {},
): string[] {
	const payload = isSegment(event.diagnostics) ? (event.diagnostics as Record<string, unknown>) : undefined;
	const extraMs = Math.max(0, options.sinceEventMs ?? 0);
	const quiet = durationText(event.silentMs + extraMs);
	const calls = Array.isArray(payload?.inFlightToolCalls) ? payload.inFlightToolCalls.filter(isSegment) : [];
	const first = calls[0];
	const busy = isSegment(payload?.busy) ? payload.busy : undefined;
	const exemption = isSegment(payload?.exemption) ? payload.exemption : undefined;
	const kernel = isSegment(payload?.kernel) ? payload.kernel : undefined;
	const key = options.interruptKey?.trim() ?? "";

	let happened: string;
	if (event.type === "stall_abort") {
		happened = `这一轮已经 ${quiet}没有任何动静，被自动中断了。`;
	} else if (event.type === "stall_unsettled") {
		happened = "这一轮已经被中断，但还有工作没有停下来。";
	} else if (first) {
		const tool = typeof first.toolName === "string" ? first.toolName : "工具";
		const ran =
			typeof first.elapsedMs === "number" ? `（这一步已经跑了 ${durationText(first.elapsedMs + extraMs)}）` : "";
		happened = `这一轮已经 ${quiet}没有任何动静，一直在等「${tool}」这一步${ran}。`;
	} else if (busy?.streaming === true) {
		happened = `这一轮已经 ${quiet}没有任何动静，一直在等模型回复。`;
	} else {
		happened = `这一轮已经 ${quiet}没有任何动静。`;
	}

	const excuses = stringsOf(exemption?.reasons)
		.map((reason) => EXCUSE_TEXT[reason])
		.filter((text): text is string => text !== undefined);
	const kernelReasons = stringsOf(kernel?.reasons);
	let meaning: string;
	if (exemption?.reason === "paused") {
		meaning = "它在等一件正常要花时间的事（比如你还没处理的弹窗，或正在整理上下文），不是卡死。";
	} else if (exemption?.reason !== undefined && exemption.exhausted !== true) {
		const why = excuses.length > 0 ? `（${excuses.join("，")}）` : "";
		meaning = `有证据表明它还在干活${why}，多半是一个不出声的长任务，不是卡死。`;
	} else if (kernelReasons.includes("loop_stalled")) {
		meaning = "Python 内核没有反应，很可能真的卡住了（比如在等一个不会结束的命令）。";
	} else if (kernelReasons.includes("heartbeat_stale")) {
		meaning = "Python 内核很久没有报平安，可能卡住了。";
	} else if (!first && busy?.streaming === true) {
		meaning = "模型那边一直没有回音，通常是网络或服务器慢，也可能是请求卡住了。";
	} else if (busy?.retrying === true) {
		meaning = "它在重试一个失败的请求，等服务器恢复。";
	} else {
		meaning = "看不出它在干活：可能是在做一件不出声的长任务，也可能卡住了。";
	}

	let canDo: string;
	if (event.type === "stall_abort") {
		canDo = "发一句话让它接着做就行，它会看到被中断的原因，换个办法继续。";
	} else if (event.type === "stall_unsettled") {
		canDo = key ? `可以按 ${key} 再中断一次；还不行就关掉这个会话重新开。` : "可以关掉这个会话重新开。";
	} else {
		canDo = key
			? `想等就不用管，它会接着跑；觉得不对就按 ${key} 中断这一轮，再告诉它换个办法。`
			: "想等就不用管，它会接着跑；觉得不对就发一句话告诉它换个办法。";
	}
	return [`发生了什么：${happened}`, `这意味着：${meaning}`, `你可以：${canDo}`];
}

export function formatStallEventLines(event: StallEventView): string[] {
	return [
		event.message,
		`  stage: ${event.type}; silent ${seconds(event.silentMs)} of ${seconds(event.thresholdMs)} threshold`,
		...formatStallDiagnosticsLines(event.diagnostics).map((line) => `  ${line}`),
	];
}

/**
 * The action view the interactive host mounts for one stall event (r4
 * recovery-shell), or undefined when no action bar mounts.
 *
 * Kept beside the stall renderers because it is the same degrade family: an
 * event without usable actions must fall back to the plain error text the host
 * already shows. The host resolves the two facts from its own state - the
 * interrupt key label from its real `app.input.clear` binding (B2), the
 * diagnostics availability from the registered handler - so the view always
 * reflects what this host actually honors, never a hardcoded key.
 */
export interface StallActionBarView {
	/** Whether the current turn can still be interrupted. */
	canAbort: boolean;
	/** Whether stall diagnostics can be shown for the current turn. */
	canDiagnose: boolean;
}

/** Host facts the view resolution needs; all three are local to the host. */
export interface StallActionBarHostFacts {
	/**
	 * Label of the host's real interrupt binding, resolved from the binding the
	 * host honors (B2). Empty or blank means unbound: the interrupt action is
	 * not offered, because a hint naming a key that does nothing is a lie.
	 */
	interruptKeyLabel: string;
	/** Whether the host currently has an interrupt handler behind that key. */
	canInterrupt: boolean;
	/** Whether the host can show stall diagnostics. */
	canDiagnose: boolean;
}

/**
 * S1: terminal stall stages never offer actions - the turn is already dead, so
 * an "interrupt this turn" hint would promise an action that cannot happen.
 */
const STALL_TERMINAL_EVENT_TYPES = new Set(["stall_abort", "stall_unsettled"]);

/**
 * Resolve the action-bar view for one stall event. Returns undefined when no
 * bar should mount: a terminal stage (S1), or an event whose only offered
 * actions are unusable in this host (B2's empty interrupt label, F1's missing
 * handler). The caller then keeps its existing plain-text error channel, which
 * is the old-client degrade - not a second, bar-shaped report of the same text
 * (B3: the two channels never double-report).
 */
export function stallActionBarView(
	event: { type: string },
	host: StallActionBarHostFacts,
): StallActionBarView | undefined {
	if (STALL_TERMINAL_EVENT_TYPES.has(event.type)) return undefined;
	const canAbort = host.canInterrupt && host.interruptKeyLabel.trim().length > 0;
	const canDiagnose = host.canDiagnose;
	if (!canAbort && !canDiagnose) return undefined;
	return { canAbort, canDiagnose };
}
