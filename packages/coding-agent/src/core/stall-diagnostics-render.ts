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
