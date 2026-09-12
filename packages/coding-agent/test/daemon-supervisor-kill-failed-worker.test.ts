import { afterEach, describe, expect, it } from "vitest";
import {
	disposeSupervisorHarnesses,
	type SupervisorHarness,
	startSupervisorHarness,
} from "./fixtures/supervisor-harness.js";

/**
 * F1. `isWorkerTerminallyUnavailable` read `lifecycle === "failed"` as "the whole
 * tree is gone", but a live worker that stops answering recovery probes parks
 * failed with its process intact (deferWorkerRecovery). A non-root kill on such a
 * worker therefore stopped the whole tree — root and every sibling — and answered
 * `alreadyTerminal: true`, telling the caller nothing had happened. A non-root kill
 * now only takes the tree down when the tree is provably gone.
 */

afterEach(async () => {
	await disposeSupervisorHarnesses();
});

const processIsAlive = (harness: SupervisorHarness): boolean =>
	harness.standIn !== undefined &&
	harness.standIn.child.exitCode === null &&
	harness.standIn.child.signalCode === null;

describe("F1 kill through a failed worker", () => {
	it("refuses a child kill while the failed worker's process is alive, and leaves the tree running", async () => {
		const harness = await startSupervisorHarness({ prefix: "ma-f1-failed-alive-", sessionCount: 2 });
		await harness.waitForWorkerReady();
		const worker = harness.worker;
		if (!worker) throw new Error("Harness started without a fake worker");
		const child = harness.sessions[1];
		if (!child) throw new Error("Harness did not create a child session");
		expect(child.activeSessionId).not.toBe(harness.session.activeSessionId);
		// Positive control: the stand-in process the descriptor claims is really alive.
		expect(processIsAlive(harness)).toBe(true);

		// The live-but-silent park: the worker stops answering, and every recovery
		// attempt fails on a non-timeout error, so it parks failed with its process
		// intact instead of being replaced.
		worker.failWorkerAuth("fixture: worker stopped answering");
		worker.dropConnections();
		await harness.waitForDescriptorLifecycle("failed", 30_000);
		expect(processIsAlive(harness)).toBe(true);

		const kill = await harness.request({ type: "kill", activeSessionId: child.activeSessionId });
		// RED on HEAD: success with `alreadyTerminal: true`, and the whole tree stopped.
		expect(kill.success).toBe(false);
		if (!kill.success) {
			expect(kill.error).toContain("cannot kill");
			// The refusal names the root a tree-kill would take down, so it is actionable.
			expect(kill.error).toContain(harness.session.activeSessionId);
		}
		// No collateral damage: the root and its siblings are still running.
		expect(processIsAlive(harness)).toBe(true);
		expect(harness.readDescriptor()?.lifecycle).toBe("failed");

		// Positive control: the root kill of the same worker still stops the tree (L4).
		const rootKill = await harness.request({ type: "kill", activeSessionId: harness.session.activeSessionId });
		expect(rootKill.success).toBe(true);
		expect(await harness.processIsGone()).toBe(true);
		expect(harness.readDescriptor()).toBeUndefined();
	}, 60_000);

	it("answers alreadyTerminal for a child of a failed worker whose process is gone", async () => {
		const harness = await startSupervisorHarness({ prefix: "ma-f1-failed-dead-", sessionCount: 2 });
		await harness.waitForWorkerReady();
		const child = harness.sessions[1];
		if (!child) throw new Error("Harness did not create a child session");

		// The corpse case the idempotent receipt was written for: the process dies on
		// its own and recovery parks the registration failed.
		harness.standIn?.child.kill("SIGKILL");
		// The fake worker lives in this process, so the supervisor also needs the
		// connection to drop before it can see a registration with a dead process.
		await harness.worker?.close();
		await harness.waitForDescriptorLifecycle("failed", 30_000);

		const kill = await harness.request({ type: "kill", activeSessionId: child.activeSessionId });
		expect(kill.success).toBe(true);
		if (kill.success && kill.data && typeof kill.data === "object") {
			expect(kill.data).toMatchObject({ alreadyTerminal: true });
		} else {
			throw new Error("A child kill on a gone tree returned no already-terminal receipt");
		}
		// The stop still clears the registration and the descriptor.
		expect(harness.readDescriptor()).toBeUndefined();
		// A repeat kill now has nothing to stop, and says so instead of inventing a
		// second terminal receipt (unchanged from before this fix).
		const again = await harness.request({ type: "kill", activeSessionId: child.activeSessionId });
		expect(again.success).toBe(false);
	}, 60_000);
});
