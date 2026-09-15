import { describe, expect, it } from "vitest";
import type { StallDiagnostics } from "../src/core/stall-diagnostics.js";
import { formatStallDiagnosticsLines, formatStallEventLines } from "../src/core/stall-diagnostics-render.js";

function diagnostics(overrides?: Partial<StallDiagnostics>): StallDiagnostics {
	return {
		silentMs: 300_000,
		busy: { streaming: false, compacting: false, retrying: false, bashRunning: true },
		lastEvent: { type: "tool_execution_start", at: 1_700_000_000_000, ageMs: 300_000 },
		inFlightToolCalls: [
			{ toolCallId: "toolu_01ABC", toolName: "bash", startedAt: 1_700_000_000_000, elapsedMs: 300_000 },
		],
		pump: { suspended: false, requested: true, epoch: 7 },
		unfinishedActions: 2,
		...overrides,
	};
}

describe("stall diagnostics rendering (DO-1b)", () => {
	it("surfaces the actionable fields, not just the message", () => {
		const text = formatStallDiagnosticsLines(diagnostics()).join("\n");
		// In-flight tool identity: what to interrupt, and how long it has been out.
		expect(text).toContain("bash");
		expect(text).toContain("toolu_01ABC");
		expect(text).toContain("300s");
		// Session state flags an operator can act on.
		expect(text).toContain("bashRunning=yes");
		expect(text).toContain("streaming=no");
		expect(text).toContain("tool_execution_start");
		expect(text).toContain("pump:");
		expect(text).toContain("epoch=7");
		expect(text).toContain("unfinished actions: 2");
	});

	it("says so when there is nothing in flight instead of implying a hidden tool", () => {
		const text = formatStallDiagnosticsLines(
			diagnostics({
				inFlightToolCalls: [],
				busy: { streaming: false, compacting: false, retrying: false, bashRunning: false },
			}),
		).join("\n");
		expect(text).toContain("in-flight tools: none");
	});

	it("renders exemption and kernel segments when present", () => {
		const text = formatStallDiagnosticsLines(
			diagnostics({
				exemption: {
					reason: "vouched",
					reasons: ["live_bash_handles"],
					budgetRemainingMs: 1_700_000,
					budgetMs: 1_800_000,
					exhausted: false,
				},
				kernel: { protocol: 4, kernelPid: 4242, livenessAgeMs: 1200, reasons: ["loop_stalled"] },
			}),
		).join("\n");
		expect(text).toContain("vouched");
		expect(text).toContain("live_bash_handles");
		expect(text).toContain("kernel pid 4242");
		expect(text).toContain("loop_stalled");
	});

	it("keeps the event message first and appends every diagnostic line", () => {
		const cases = ["stall_warning", "stall_abort", "stall_unsettled"];
		expect(cases.length).toBe(3);
		for (const type of cases) {
			const lines = formatStallEventLines({
				type,
				message: "Possible stall: no session activity for 300s while a turn is running.",
				silentMs: 300_000,
				thresholdMs: 300_000,
				diagnostics: diagnostics(),
			});
			expect(lines.length).toBeGreaterThan(1);
			expect(lines[0]).toContain("Possible stall");
			expect(lines.join("\n")).toContain("toolu_01ABC");
		}
	});
});
