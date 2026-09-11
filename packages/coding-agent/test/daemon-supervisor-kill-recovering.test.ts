import { afterEach, describe, expect, it } from "vitest";
import {
	disposeSupervisorHarnesses,
	type SupervisorHarness,
	startSupervisorHarness,
} from "./fixtures/supervisor-harness.js";

/**
 * T3-5 / P1-5-L4: kill could not reach a worker that was not `ready`, so killing a
 * session whose worker was recovering bounced off "Session worker is recovering"
 * and callers spun. Terminal commands (kill / abort / cancel_rlm_child) now work
 * across the whole lifecycle and are idempotent for a target that existed and is
 * gone, while read commands keep failing loudly (C19: a read must not claim
 * success) and a selector that never existed still errors.
 */

afterEach(async () => {
	await disposeSupervisorHarnesses();
});

async function workerStateOf(harness: SupervisorHarness, sessionId: string): Promise<string | undefined> {
	const sessions = await harness.listSessions();
	const row = sessions.find((summary) => summary.sessionId === sessionId);
	return row?.workerState;
}

async function waitForWorkerState(
	harness: SupervisorHarness,
	sessionId: string,
	state: string,
	timeoutMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await workerStateOf(harness, sessionId)) === state) {
			return;
		}
		await harness.settle(50);
	}
	throw new Error(`Worker never reached state ${state}; last was ${await workerStateOf(harness, sessionId)}`);
}

describe("T3-5 kill reachability and terminal command idempotency", () => {
	it("kills a session whose worker is still recovering", async () => {
		const harness = await startSupervisorHarness({ prefix: "ma-t3-5-kill-" });
		const worker = harness.worker;
		if (!worker) {
			throw new Error("Harness started without a fake worker");
		}
		await waitForWorkerState(harness, harness.session.sessionId, "ready");
		// The worker drops off the socket and stops answering, so the supervisor flips
		// it to recovering and starts probing: the state a kill used to bounce off.
		await worker.close();
		await harness.waitForDescriptorLifecycle("recovering");

		const kill = await harness.request({ type: "kill", activeSessionId: harness.session.activeSessionId });

		// RED on HEAD: this threw "Session worker is recovering".
		expect(kill.success).toBe(true);
		// A real semantic kill, not the idempotent already-terminal answer.
		expect(kill.success && kill.data).toBeUndefined();
		// The tombstone cancelled recovery and the stop reaped the process: no orphan.
		expect(await harness.processIsGone()).toBe(true);
		expect(harness.readDescriptor()).toBeUndefined();
	}, 30_000);

	it("still forwards a kill to a ready worker", async () => {
		const harness = await startSupervisorHarness({ prefix: "ma-t3-5-ready-" });
		const worker = harness.worker;
		if (!worker) {
			throw new Error("Harness started without a fake worker");
		}
		// Positive control: the healthy path is unchanged and the worker really is asked.
		await waitForWorkerState(harness, harness.session.sessionId, "ready");
		expect(worker.commands.length).toBeGreaterThan(0);

		const kill = await harness.request({ type: "kill", activeSessionId: harness.session.activeSessionId });
		expect(kill.success).toBe(true);
		expect(worker.commands).toContain("kill");

		// The killed session's row survives as a passivated roster entry, which is what
		// makes a later terminal command idempotent instead of "never existed".
		const abort = await harness.request({ type: "abort", activeSessionId: harness.session.sessionId });
		expect(abort.success).toBe(true);
		if (abort.success && abort.data && typeof abort.data === "object") {
			expect(abort.data).toMatchObject({ alreadyTerminal: true });
		} else {
			throw new Error("Idempotent abort returned no data");
		}
	}, 30_000);

	it("still fails a terminal command for a selector that never existed", async () => {
		const harness = await startSupervisorHarness({ prefix: "ma-t3-5-never-" });
		await harness.waitForWorkerReady();
		const abort = await harness.request({ type: "abort", activeSessionId: "never-existed-9f3a" });
		expect(abort.success).toBe(false);
		if (!abort.success) {
			expect(abort.error).toContain("Unknown active session");
		}
	}, 30_000);

	it("keeps read commands failing for a gone target", async () => {
		const harness = await startSupervisorHarness({ prefix: "ma-t3-5-read-" });
		await harness.waitForWorkerReady();
		const kill = await harness.request({ type: "kill", activeSessionId: harness.session.activeSessionId });
		expect(kill.success).toBe(true);

		// C19: a read must not report success for a session it cannot see.
		const tree = await harness.request({ type: "get_session_tree", activeSessionId: harness.session.sessionId });
		expect(tree.success).toBe(false);
		if (!tree.success) {
			expect(tree.error).toContain("Unknown active session");
		}
	}, 30_000);
});
