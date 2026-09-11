import { describe, expect, it, vi } from "vitest";
import {
	classifyRlmChildTerminalOutcome,
	classifyRlmChildTerminalOutcomeSafely,
	formatStallKilledReason,
	type RlmChildStallAbortFacts,
	type RlmChildTerminalFacts,
	readStallKernelReasons,
} from "../src/core/rlm-child-terminal.js";

/**
 * The ma-evidence / probe-silent实态: a child whose turn was aborted by the stall
 * watchdog while a tool was in flight, with the last assistant message still
 * carrying stopReason "toolUse". HEAD reported this as completed_without_reply.
 */
function stallAbort(overrides: Partial<RlmChildStallAbortFacts> = {}): RlmChildStallAbortFacts {
	return {
		silentMs: 933_000,
		thresholdMs: 900_000,
		inFlightTools: ["ipython"],
		settled: true,
		...overrides,
	};
}

function facts(overrides: Partial<RlmChildTerminalFacts> = {}): RlmChildTerminalFacts {
	return {
		runStatus: "done",
		repliedDuringRun: false,
		terminalErrorNoticeDelivered: false,
		...overrides,
	};
}

describe("classifyRlmChildTerminalOutcome", () => {
	interface Case {
		name: string;
		facts: RlmChildTerminalFacts;
		expect: { kind: string; channel: string; reasonIncludes?: string[]; degraded?: "indeterminate_facts" };
	}

	const cases: Case[] = [
		{
			// verify-A Q3: the killed child's transcript ends on a tool call.
			name: "stall abort during an in-flight tool is stall_killed, not a no-reply",
			facts: facts({ lastStopReason: "toolUse", stallAbort: stallAbort() }),
			expect: {
				kind: "stall_killed",
				channel: "failure",
				reasonIncludes: ["stall watchdog", "silentMs=933000", "ipython"],
			},
		},
		{
			// The解闸 nail: if the stallAbort check moved after repliedDuringRun this
			// row would report "none" and the kill would stay invisible.
			name: "a child that replied and was then killed is still stall_killed",
			facts: facts({ repliedDuringRun: true, stallAbort: stallAbort() }),
			expect: { kind: "stall_killed", channel: "failure", reasonIncludes: ["stall watchdog"] },
		},
		{
			// Esc x stall race, row 1: the watchdog fired first, the user's Esc landed
			// on the way down. The kill is the more specific fact.
			name: "stall abort wins the race against a later user abort",
			facts: facts({ lastStopReason: "aborted", turnAbortReason: "user", stallAbort: stallAbort() }),
			expect: { kind: "stall_killed", channel: "failure" },
		},
		{
			// Esc x stall race, row 2: the user got there first, no watchdog facts.
			name: "a user abort without watchdog facts is aborted",
			facts: facts({ lastStopReason: "aborted", turnAbortReason: "user" }),
			expect: { kind: "aborted", channel: "failure", reasonIncludes: ["turn aborted before completion"] },
		},
		{
			// F7: abort_unsettled, then the run recovered and replied. It survived;
			// reporting it dead would send the parent re-dispatching live work.
			name: "an unsettled abort followed by a reply is a survivor, not a kill",
			facts: facts({ repliedDuringRun: true, stallAbort: stallAbort({ settled: false }) }),
			expect: { kind: "none", channel: "none", reasonIncludes: ["stall_survived"] },
		},
		{
			name: "an unsettled abort with no reply is still a kill",
			facts: facts({ stallAbort: stallAbort({ settled: false }) }),
			expect: { kind: "stall_killed", channel: "failure" },
		},
		{
			// 乙 input union: the watchdog reason alone (diagnostics lost) still classifies.
			name: "a stall_watchdog turn abort without diagnostics is stall_killed",
			facts: facts({ turnAbortReason: "stall_watchdog" }),
			expect: { kind: "stall_killed", channel: "failure" },
		},
		{
			// Positive control: the pre-existing cancel notice path is unchanged.
			name: "a cancelled run keeps the cancelled notice",
			facts: facts({ runStatus: "cancelled", runError: "Cancelled by user" }),
			expect: { kind: "cancelled", channel: "notice", reasonIncludes: ["Cancelled by user"] },
		},
		{
			name: "a provider error is a failure",
			facts: facts({ lastStopReason: "error", lastErrorMessage: "overloaded_error" }),
			expect: { kind: "error", channel: "failure", reasonIncludes: ["overloaded_error"] },
		},
		{
			name: "a run that threw carries the run error",
			facts: facts({ runStatus: "error", runError: "startup failed" }),
			expect: { kind: "error", channel: "failure", reasonIncludes: ["startup failed"] },
		},
		{
			// C7 double-send suppression: the child already told the parent itself.
			name: "a delivered terminal-error notice suppresses the synthesized failure",
			facts: facts({
				runStatus: "error",
				lastErrorMessage: "overloaded_error",
				terminalErrorNoticeDelivered: true,
			}),
			expect: { kind: "none", channel: "none", reasonIncludes: ["already delivered"] },
		},
		{
			name: "a delivered terminal-error notice suppresses a stall kill too",
			facts: facts({ stallAbort: stallAbort(), terminalErrorNoticeDelivered: true }),
			expect: { kind: "none", channel: "none" },
		},
		{
			// Positive control: the ordinary healthy completion stays silent.
			name: "a child that replied with no failure needs no notice",
			facts: facts({ repliedDuringRun: true }),
			expect: { kind: "none", channel: "none", reasonIncludes: ["replied"] },
		},
		{
			// Positive control: the fourth state keeps its original meaning.
			name: "a completed child that never replied keeps the completed_without_reply notice",
			facts: facts({}),
			expect: { kind: "completed_without_reply", channel: "notice" },
		},
		{
			// FINAL (4): indeterminate facts fall back to the legacy notice, marked so
			// the caller logs the gap instead of silently guessing.
			name: "indeterminate facts fall back to the legacy notice and are marked degraded",
			facts: facts({ runStatus: "running" }),
			expect: { kind: "completed_without_reply", channel: "notice", degraded: "indeterminate_facts" },
		},
	];

	it("classifies every pinned row of the terminal table", () => {
		// Guard: an empty table would pass without asserting anything.
		expect(cases.length).toBeGreaterThan(0);
		for (const testCase of cases) {
			const outcome = classifyRlmChildTerminalOutcome(testCase.facts);
			expect(outcome.kind, testCase.name).toBe(testCase.expect.kind);
			expect(outcome.channel, testCase.name).toBe(testCase.expect.channel);
			if (outcome.channel === "notice") {
				expect(outcome.degraded, testCase.name).toBe(testCase.expect.degraded);
			}
			for (const fragment of testCase.expect.reasonIncludes ?? []) {
				expect(outcome.reason, testCase.name).toContain(fragment);
			}
		}
	});

	it("reports a classifier that throws instead of swallowing it", () => {
		const onDegraded = vi.fn();
		// A facts object that throws on read stands in for any unexpected shape; the
		// terminal path must not be able to fail because classification failed.
		const throwing = {
			runStatus: "done",
			repliedDuringRun: false,
			terminalErrorNoticeDelivered: false,
			get stallAbort(): never {
				throw new Error("facts reader exploded");
			},
		} as unknown as RlmChildTerminalFacts;

		const outcome = classifyRlmChildTerminalOutcomeSafely(throwing, onDegraded);

		expect(onDegraded).toHaveBeenCalledWith({
			reason: "classifier_error",
			error: "facts reader exploded",
		});
		// Legacy two-state fallback: no failure facts reachable => the old notice.
		expect(outcome).toEqual({
			kind: "completed_without_reply",
			channel: "notice",
			reason: "completed without sending a reply",
		});
	});

	it("falls back to the legacy error failure when the classifier throws on a failed run", () => {
		const onDegraded = vi.fn();
		const throwing = {
			runStatus: "error",
			repliedDuringRun: false,
			terminalErrorNoticeDelivered: false,
			get lastStopReason(): never {
				throw new Error("transcript reader exploded");
			},
		} as unknown as RlmChildTerminalFacts;

		const outcome = classifyRlmChildTerminalOutcomeSafely(throwing, onDegraded);

		expect(onDegraded).toHaveBeenCalledOnce();
		expect(outcome.kind).toBe("error");
		expect(outcome.channel).toBe("failure");
	});

	it("reports degraded indeterminate facts through the callback", () => {
		const onDegraded = vi.fn();
		const outcome = classifyRlmChildTerminalOutcomeSafely(facts({ runStatus: "queued" }), onDegraded);
		expect(onDegraded).toHaveBeenCalledWith({ reason: "indeterminate_facts" });
		expect(outcome.channel).toBe("notice");
	});

	it("does not report a healthy classification as degraded", () => {
		const onDegraded = vi.fn();
		classifyRlmChildTerminalOutcomeSafely(facts({ stallAbort: stallAbort() }), onDegraded);
		expect(onDegraded).not.toHaveBeenCalled();
	});

	it("formats the stall kill reason with silence, tools and kernel reasons", () => {
		const reason = formatStallKilledReason({
			silentMs: 933_000,
			inFlightTools: ["ipython"],
			kernelReasons: ["no kernel heartbeat for 45s"],
		});
		expect(reason).toContain("killed by the stall watchdog after 933s of silence");
		expect(reason).toContain("silentMs=933000");
		expect(reason).toContain("in-flight tools: ipython");
		expect(reason).toContain("kernel: no kernel heartbeat for 45s");
		expect(reason).toContain("re-dispatch");
	});

	it("says so when no in-flight tool was recorded instead of implying none stalled", () => {
		const reason = formatStallKilledReason({ silentMs: 900_000, inFlightTools: [] });
		expect(reason).toContain("in-flight tools: none recorded");
	});

	it("reads kernel reasons only when the diagnostics carry them", () => {
		const diagnostics = {
			silentMs: 1000,
			inFlightToolCalls: [{ toolName: "bash", elapsedMs: 2000 }],
		};
		expect(readStallKernelReasons(diagnostics)).toEqual([]);
		expect(readStallKernelReasons({ ...diagnostics, kernel: { reasons: ["loop stalled"] } })).toEqual([
			"loop stalled",
		]);
		// Positive control for the tool formatting path used when diagnostics are present.
		expect(formatStallKilledReason({ silentMs: 1000, inFlightTools: [] }, diagnostics)).toContain(
			"in-flight tools: bash (2s)",
		);
	});
});
