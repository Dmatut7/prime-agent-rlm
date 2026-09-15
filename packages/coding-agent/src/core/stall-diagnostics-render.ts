import type { StallDiagnostics } from "./stall-diagnostics.js";
import { resolveStallDiagnosticsPointer } from "./stall-evidence.js";

/** One stall event as the UI ends receive it (all three stages share this shape). */
export interface StallEventView {
	type: string;
	message: string;
	silentMs: number;
	thresholdMs: number;
	diagnostics: StallDiagnostics;
}

function seconds(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function yesNo(value: boolean): string {
	return value ? "yes" : "no";
}

/**
 * The actionable fields of a stall diagnostics payload, one line each.
 *
 * A stall event carries the full forensic snapshot, but rendering only `message` leaves the
 * operator with "something was silent" and no way to act: which tool call to interrupt, whether
 * the pump is wedged, what the kernel last said. These are the fields that change what you do
 * next.
 */
export function formatStallDiagnosticsLines(diagnostics: StallDiagnostics): string[] {
	const lines: string[] = [];
	const busy = diagnostics.busy;
	lines.push(
		`busy: streaming=${yesNo(busy.streaming)} compacting=${yesNo(busy.compacting)} ` +
			`retrying=${yesNo(busy.retrying)} bashRunning=${yesNo(busy.bashRunning)}`,
	);
	const inFlight = diagnostics.inFlightToolCalls.map(
		(call) => `${call.toolName} (id=${call.toolCallId}, ${seconds(call.elapsedMs)})`,
	);
	lines.push(`in-flight tools: ${inFlight.length > 0 ? inFlight.join(", ") : "none"}`);
	lines.push(
		diagnostics.lastEvent
			? `last event: ${diagnostics.lastEvent.type} (${seconds(diagnostics.lastEvent.ageMs)} ago)`
			: "last event: none recorded",
	);
	const pump = diagnostics.pump;
	lines.push(`pump: suspended=${yesNo(pump.suspended)} requested=${yesNo(pump.requested)} epoch=${pump.epoch}`);
	lines.push(`unfinished actions: ${diagnostics.unfinishedActions}`);
	const exemption = diagnostics.exemption;
	if (exemption) {
		const reasons = exemption.reasons.length > 0 ? exemption.reasons.join(", ") : "none";
		const remaining = exemption.budgetRemainingMs === undefined ? undefined : seconds(exemption.budgetRemainingMs);
		lines.push(
			`exemption: ${exemption.reason ?? "unspecified"} [${reasons}]` +
				`${remaining ? ` budget left ${remaining}` : ""}` +
				`${exemption.exhausted ? " (exhausted)" : ""}`,
		);
	}
	const kernel = diagnostics.kernel;
	if (kernel) {
		const facts = [
			`kernel pid ${kernel.kernelPid ?? "unknown"}`,
			`reasons: ${kernel.reasons.length > 0 ? kernel.reasons.join(", ") : "none"}`,
			...(kernel.livenessAgeMs === undefined ? [] : [`livenessAgeMs ${kernel.livenessAgeMs}`]),
			...(kernel.liveBashHandles === undefined ? [] : [`liveBashHandles ${kernel.liveBashHandles}`]),
			...(kernel.hostRequestCount === undefined ? [] : [`hostRequests ${kernel.hostRequestCount}`]),
		];
		lines.push(facts.join("; "));
	}
	const pointer = resolveStallDiagnosticsPointer();
	lines.push(`diagnostics file: ${pointer.evidencePath} (also ${pointer.agentLogPath})`);
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
