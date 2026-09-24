import { describe, expect, it } from "vitest";
import type { StallDiagnostics } from "../src/core/stall-diagnostics.js";
import {
	formatStallDiagnosticsLines,
	formatStallEventLines,
	formatStallExplanation,
} from "../src/core/stall-diagnostics-render.js";

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

describe("cross-version stall events (K3X-1)", () => {
	it("renders an event without a diagnostics payload instead of crashing", () => {
		// A pre-DO-1 daemon emits the stall events without `diagnostics`; a new
		// attach client must degrade the missing payload to an explicit unknown
		// instead of throwing inside the event handler.
		const legacyEvent = {
			type: "stall_warning",
			message: "Possible stall: no session activity for 61s while a turn is running.",
			silentMs: 61_000,
			thresholdMs: 60_000,
		};
		const lines = formatStallEventLines(legacyEvent);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0]).toContain("Possible stall");
		const text = lines.join("\n");
		expect(text).toContain("unknown");
		expect(text).toContain("stage: stall_warning");
	});

	it("marks a missing busy segment unknown while the rest still renders", () => {
		// JSON round-trip drops the `busy: undefined` field exactly the way an
		// older or partially-degraded producer would leave it off the wire.
		const wireEvent = JSON.parse(
			JSON.stringify({
				type: "stall_abort",
				message: "Turn aborted after stall.",
				silentMs: 300_000,
				thresholdMs: 300_000,
				diagnostics: diagnostics({ busy: undefined }),
			}),
		);
		const lines = formatStallEventLines(wireEvent);
		const text = lines.join("\n");
		expect(text).toContain("busy: unknown");
		// Segments that did arrive still render.
		expect(text).toContain("toolu_01ABC");
		expect(text).toContain("epoch=7");
	});

	/**
	 * X-3: the mixed-version downgrade (no diagnostics payload) must still carry
	 * DO-1's retrievability pointer - the pre-fix early-return swallowed it, so
	 * the one event that most needs "where do I read the forensics" said nothing.
	 * The pointer is resolved in the renderer's own process, so the line has to
	 * say that explicitly rather than imply the daemon wrote there.
	 */
	it("keeps the forensics pointer on the cross-version downgrade, qualified as locally resolved", () => {
		const lines = formatStallEventLines({
			type: "stall_warning",
			message: "Possible stall: no session activity for 300s while a turn is running.",
			silentMs: 300_000,
			thresholdMs: 300_000,
		});
		const text = lines.join("\n");
		expect(text).toContain("diagnostics: unknown (event predates the diagnostics payload)");
		expect(text).toContain("diagnostics file");
		expect(text).toContain("stall-evidence.jsonl");
		// The honesty qualifier: the paths are this client's resolution, not the
		// emitting daemon's.
		expect(text).toContain("resolved locally in this client");
	});

	/**
	 * X-3 small face: the payload-present (normal) path resolves the same
	 * pointer in this client's process, but its line carried no qualifier - the
	 * fix only qualified the degraded path, leaving the two paths with
	 * inconsistent honesty wording.
	 */
	it("qualifies the normal-path pointer as locally resolved too", () => {
		const lines = formatStallDiagnosticsLines(diagnostics());
		const pointerLine = lines.find((line) => line.startsWith("diagnostics file"));
		expect(pointerLine).toBeDefined();
		expect(pointerLine).toContain("resolved locally in this client");
	});
});

describe("stall explanation for the owner", () => {
	const warn = (overrides?: Partial<StallDiagnostics>) => ({
		type: "stall_warning",
		message: "Possible stall: no session activity for 312s while a turn is running.",
		silentMs: 312_000,
		thresholdMs: 300_000,
		diagnostics: diagnostics(overrides),
	});

	it("says what was happening, what it means and what to do, in plain Chinese", () => {
		const lines = formatStallExplanation(warn(), { interruptKey: "Esc" });
		expect(lines).toEqual([
			"发生了什么：这一轮已经 5 分钟没有任何动静，一直在等「bash」这一步（这一步已经跑了 5 分钟）。",
			"这意味着：看不出它在干活：可能是在做一件不出声的长任务，也可能卡住了。",
			"你可以：想等就不用管，它会接着跑；觉得不对就按 Esc 中断这一轮，再告诉它换个办法。",
		]);
		// No machine vocabulary leaks into the owner's part.
		expect(lines.join("")).not.toMatch(/pump|suspended|exemption|stall_warning/);
	});

	it("reads vouched silence as long work and a stalled kernel loop as a likely hang", () => {
		const excused = formatStallExplanation(
			warn({ exemption: { reason: "vouched", reasons: ["live_bash_handles"], exhausted: false } }),
		);
		expect(excused[1]).toBe("这意味着：有证据表明它还在干活（后台命令还在跑），多半是一个不出声的长任务，不是卡死。");
		const wedged = formatStallExplanation(
			warn({ kernel: { protocol: 4, hostRequestCount: 0, reasons: ["loop_stalled"] } }),
		);
		expect(wedged[1]).toContain("很可能真的卡住了");
	});

	it("keeps counting the quiet time a line was left on screen for", () => {
		const lines = formatStallExplanation(warn(), { sinceEventMs: 3 * 3_600_000 });
		expect(lines[0]).toContain("已经 3 小时 5 分没有任何动静");
		expect(lines[2]).toContain("发一句话告诉它换个办法");
	});
});
