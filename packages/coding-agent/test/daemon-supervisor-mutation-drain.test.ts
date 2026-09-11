import { afterEach, describe, expect, it } from "vitest";
import type { DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";
import {
	disposeSupervisorHarnesses,
	type SupervisorHarness,
	startSupervisorHarness,
} from "./fixtures/supervisor-harness.js";

/**
 * P1-7c, first half. A `send_message` was a fence-gated mutation, so one
 * delivery whose target took a while to hydrate held the update-restart drain
 * latch and failed the whole prepare at 80s — the drain timeout, not the
 * delivery, was what the operator saw. A long delivery is exempt from the latch;
 * the second half of this change (the pending-delivery queue that tracks it and
 * receipts it at a restart) has its own cases below.
 */

afterEach(async () => {
	await disposeSupervisorHarnesses();
});

async function twoSessionHarness(prefix: string, hangWorkerCommands: readonly string[]): Promise<SupervisorHarness> {
	const harness = await startSupervisorHarness({ prefix, sessionCount: 2, hangWorkerCommands });
	await harness.waitForWorkerReady();
	return harness;
}

function failureText(response: DaemonResponse): string {
	return response.success ? "" : response.error;
}

function deliveryCommand(harness: SupervisorHarness, message: string) {
	const [source, target] = harness.sessions;
	if (!source || !target) throw new Error("Harness did not create two sessions");
	return {
		type: "send_message",
		fromActiveSessionId: source.activeSessionId,
		targetActiveSessionId: target.activeSessionId,
		message,
	} as const;
}

describe("P1-7c send_message and the update-restart drain", () => {
	it("completes the drain while an agent-message delivery is still in flight", async () => {
		const harness = await twoSessionHarness("ma-t4-3-drain-send-", ["worker_deliver_message"]);
		const send = harness.request(deliveryCommand(harness, "wake up"), 30_000);
		void send.catch(() => undefined);
		await harness.settle(300);

		const startedAt = Date.now();
		const prepare = await harness.request({ type: "prepare_update_restart" }, 10_000);
		const elapsedMs = Date.now() - startedAt;

		// RED on HEAD: the delivery held the latch and the prepare died on the drain
		// timeout instead of reaching the workers.
		expect(elapsedMs).toBeLessThan(5_000);
		expect(prepare).toMatchObject({ success: false });
		expect(failureText(prepare)).not.toContain("Timed out draining daemon mutations");
		// It got all the way to fencing the workers, where the fixture worker's
		// manifest-less answer stops it.
		expect(failureText(prepare)).toContain("invalid update manifest");
	});

	it("still waits for a hanging mutation that is not a delivery", async () => {
		const harness = await twoSessionHarness("ma-t4-3-drain-abort-", ["abort"]);
		const abort = harness.request({ type: "abort", activeSessionId: harness.sessions[0]!.activeSessionId }, 30_000);
		void abort.catch(() => undefined);
		await harness.settle(300);

		// Positive control: the latch was not simply removed. The drain still waits
		// for a real mutation, so the caller's own budget runs out first.
		const prepare = await harness.request({ type: "prepare_update_restart" }, 1_500).then(
			(response) => ({ kind: "response" as const, response }),
			(error: unknown) => ({ kind: "error" as const, error: error as Error }),
		);

		expect(prepare.kind).toBe("error");
		expect(prepare.kind === "error" && prepare.error.message).toContain("prepare_update_restart");
	});
});
