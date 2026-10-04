import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { recordStallWatchdogActivity, type StallWatchdogWiringHost } from "../src/core/stall-watchdog-wiring.js";

/**
 * A new turn closes the previous turn's abort reason whether or not a stall
 * watchdog exists: the clear used to sit behind the `if (!watchdog) return` gate,
 * so a session whose watchdog was never created carried a stale "user" reason into
 * the next turn's abort classification — and a quota park read it as the user
 * cancelling a wake that was still hours out.
 */
describe("recordStallWatchdogActivity without a watchdog", () => {
	it("agent_start still clears the previous turn's abort reason", () => {
		const host = {
			_stallWatchdog: undefined,
			_lastTurnAbortReason: "user",
		} as unknown as StallWatchdogWiringHost;
		const event: AgentEvent = { type: "agent_start" };

		recordStallWatchdogActivity(host, event);

		expect(host._lastTurnAbortReason).toBeUndefined();
	});
});
