import { afterEach, describe, expect, it } from "vitest";
import type { DaemonCommand, DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";
import { disposeSupervisorHarnesses, startSupervisorHarness } from "./fixtures/supervisor-harness.js";

/**
 * #16. The worker side of `send_message` validates its target with
 * `assertDirectAgentMessageTarget`; the supervisor side did not, so an empty
 * target fell through to the catalog where `"".startsWith` matches every saved
 * session: in a cwd with exactly one saved session the message was silently
 * retargeted to it, and anywhere else the same command came back "ambiguous".
 * Both sides now refuse it the same way.
 */

afterEach(async () => {
	await disposeSupervisorHarnesses();
});

/** Fails the test when the command was accepted: the proposition is a refusal. */
function refusalText(response: DaemonResponse): string {
	if (response.success) {
		throw new Error(`Expected the command to be refused, got ${JSON.stringify(response)}`);
	}
	return response.error ?? "";
}

function sendCommand(targetActiveSessionId: string, fromActiveSessionId: string): DaemonCommand {
	return {
		type: "send_message",
		fromActiveSessionId,
		targetActiveSessionId,
		message: "nobody should receive this",
	} as DaemonCommand;
}

describe("supervisor send_message target validation", () => {
	it("refuses an empty target instead of retargeting the only saved session", async () => {
		const harness = await startSupervisorHarness({ prefix: "ma-send-empty-target-", sessionCount: 2 });
		await harness.waitForWorkerReady();
		const source = harness.sessions[0];
		if (!source) throw new Error("Harness did not create a source session");

		const response = await harness.request(sendCommand("", source.activeSessionId));

		expect(refusalText(response)).toContain("Agent message target cannot be empty");
		// Nothing was queued for delivery either.
		expect(harness.logText()).not.toContain("deliver message");
	}, 60_000);

	it("refuses a whitespace-only target", async () => {
		const harness = await startSupervisorHarness({ prefix: "ma-send-blank-target-", sessionCount: 2 });
		await harness.waitForWorkerReady();
		const source = harness.sessions[0];
		if (!source) throw new Error("Harness did not create a source session");

		const response = await harness.request(sendCommand("", source.activeSessionId));

		expect(refusalText(response)).toContain("Agent message target cannot be empty");
	}, 60_000);

	it("refuses a broadcast target the worker side refuses too", async () => {
		const harness = await startSupervisorHarness({ prefix: "ma-send-broadcast-target-", sessionCount: 2 });
		await harness.waitForWorkerReady();
		const source = harness.sessions[0];
		if (!source) throw new Error("Harness did not create a source session");

		const response = await harness.request(sendCommand("all", source.activeSessionId));

		expect(refusalText(response)).toContain("Broadcast agent messaging is not supported");
	}, 60_000);
});
