/**
 * Terminal classification for a run whose turn was killed by the automatic
 * stall-recovery executor (r4 recovery-shell, mechanism ③).
 *
 * `stall_recovery` is "someone took over", not "the child failed on its own":
 * the classifier must rank it with the stall kills (a reply cannot swallow the
 * intervention), and the reason text must read as an auto-recovery so the
 * parent does not mistake a kept-alive child for a corpse.
 */
import { describe, expect, it } from "vitest";
import {
	classifyRlmChildTerminalOutcome,
	type RlmChildTerminalFacts,
	type RlmChildTurnAbortReason,
} from "../src/core/rlm-child-terminal.js";

function facts(overrides: Partial<RlmChildTerminalFacts> = {}): RlmChildTerminalFacts {
	return {
		runStatus: "done",
		repliedDuringRun: false,
		terminalErrorNoticeDelivered: false,
		...overrides,
	};
}

describe("stall_recovery terminal classification", () => {
	it("ranks an automatic stall-recovery interrupt with the stall kills, not the user aborts", () => {
		const outcome = classifyRlmChildTerminalOutcome(facts({ turnAbortReason: "stall_recovery" }));

		// "someone took over" is kill-class: the parent must not read it as an
		// ordinary abort or a completed-without-reply.
		expect(outcome).toMatchObject({ kind: "stall_killed", channel: "failure" });
	});

	it("keeps the rank when the run also replied: a reply does not swallow the intervention", () => {
		const outcome = classifyRlmChildTerminalOutcome(
			facts({ turnAbortReason: "stall_recovery", repliedDuringRun: true }),
		);

		expect(outcome).toMatchObject({ kind: "stall_killed", channel: "failure" });
	});

	it("the reason text says auto-recovered, not merely killed", () => {
		const outcome = classifyRlmChildTerminalOutcome(facts({ turnAbortReason: "stall_recovery" }));

		expect(outcome.channel).toBe("failure");
		if (outcome.channel !== "failure") return;
		expect(outcome.reason).toContain("auto-recovered");
		// The parent must also learn the child was kept alive to retry: the
		// receipt says the same, the failure notice must not contradict it.
		expect(outcome.reason).toContain("session was kept");
	});

	it("a watchdog kill with recorded facts stays a watchdog kill (the reason names the watchdog)", () => {
		const outcome = classifyRlmChildTerminalOutcome(
			facts({
				stallAbort: {
					silentMs: 312_000,
					thresholdMs: 300_000,
					inFlightTools: ["bash"],
					settled: true,
				},
			}),
		);

		expect(outcome).toMatchObject({ kind: "stall_killed", channel: "failure" });
		if (outcome.channel !== "failure") return;
		expect(outcome.reason).toContain("stall watchdog");
		expect(outcome.reason).not.toContain("auto-recovered");
	});

	it("the abort reason union admits stall_recovery", () => {
		const reasons: RlmChildTurnAbortReason[] = ["user", "stall_watchdog", "stall_recovery"];
		expect(reasons).toContain("stall_recovery");
	});
});
