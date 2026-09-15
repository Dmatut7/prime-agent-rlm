import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forceKillDaemon, killDaemon, stopTrackedProcess } from "../src/cli/daemon-ps.js";
import { getProcessStartId } from "../src/core/session-lease.js";
import * as childProcessModule from "../src/utils/child-process.js";
import { signalProcessGroupOrProcess } from "../src/utils/child-process.js";

/**
 * Round-23 K3X-6: the stop ledger recorded the *intention* to signal rather than
 * the delivery. `recordSignal(pid)` ran before the primitive, and every primitive
 * swallowed EPERM/ESRCH, so a stop this run never delivered was still credited as
 * a stop in the causal ledger (`converge()` promotes a vanished target whose pid
 * is in the ledger to "converged during shutdown").
 *
 * These tests pin the two halves of the contract: every signal primitive answers
 * "was it delivered?", and the ledger is written only when the answer is yes.
 */

const children = new Set<ChildProcess>();

/** A pid no process has, so ESRCH is a fact and not a fixture accident. */
const DEAD_PIDS = [99_999_999, 99_999_998, 99_999_997];

function spawnSleeper(ignoreSigterm = false): ChildProcess {
	const script = ignoreSigterm
		? ["process.on('SIGTERM', () => {});", "setTimeout(() => process.exit(0), 60_000);"].join("\n")
		: ["setTimeout(() => process.exit(0), 60_000);"].join("\n");
	const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "ignore"] });
	children.add(child);
	return child;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitForDead(pid: number, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!alive(pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`pid ${pid} was still alive after ${timeoutMs}ms`);
}

afterEach(() => {
	for (const child of children) {
		child.kill("SIGKILL");
	}
	children.clear();
	vi.restoreAllMocks();
});

describe("signal primitives report delivery, not intention", () => {
	it("answers false for a pid that cannot be signalled", () => {
		for (const pid of DEAD_PIDS) {
			expect(getProcessStartId(pid), `premise: pid ${pid} must be free`).toBeUndefined();
		}
		const dead = DEAD_PIDS[0]!;
		expect(signalProcessGroupOrProcess(dead, "SIGTERM")).toBe(false);
		expect(killDaemon(dead)).toBe(false);
	});

	it("answers true and really kills when the signal goes through", async () => {
		const child = spawnSleeper();
		const pid = child.pid!;
		expect(getProcessStartId(pid)).toBeDefined();

		expect(signalProcessGroupOrProcess(pid, "SIGTERM")).toBe(true);
		await waitForDead(pid);
	});

	it("forceKillDaemon counts the escalation leg as a delivery too", async () => {
		// The SIGTERM is delivered but ignored, so only the SIGKILL actually stops it.
		const child = spawnSleeper(true);
		const pid = child.pid!;

		await expect(forceKillDaemon(pid)).resolves.toBe(true);
		await waitForDead(pid);
	});

	it("forceKillDaemon answers false when nothing could be signalled", async () => {
		const dead = DEAD_PIDS[1]!;
		expect(getProcessStartId(dead), `premise: pid ${dead} must be free`).toBeUndefined();

		await expect(forceKillDaemon(dead)).resolves.toBe(false);
	});
});

describe("the stop ledger records delivered signals only", () => {
	it("does not credit a signal the primitive never delivered", async () => {
		const child = spawnSleeper();
		const pid = child.pid!;
		const startId = getProcessStartId(pid);
		expect(startId).toBeDefined();
		// EPERM/ESRCH, the two ways a primitive finds it cannot signal this pid.
		const deliver = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockReturnValue(false);
		const onSignal = vi.fn();

		const stopped = await stopTrackedProcess(pid, startId, async () => {}, onSignal);

		expect(deliver).toHaveBeenCalled();
		// The regression: this was 2 — one record per attempted signal (SIGTERM, SIGKILL).
		expect(onSignal).not.toHaveBeenCalled();
		expect(stopped).toBe(false);
	}, 15_000);

	it("credits a worker whose SIGTERM really went out", async () => {
		const child = spawnSleeper();
		const pid = child.pid!;
		const startId = getProcessStartId(pid);
		expect(startId).toBeDefined();
		const onSignal = vi.fn();

		// The positive control for the test above: the same path with a real primitive.
		const stopped = await stopTrackedProcess(pid, startId, async () => {}, onSignal);

		expect(stopped).toBe(true);
		expect(onSignal).toHaveBeenCalledTimes(1);
		// The callback is pid-bound by the caller (the ledger closure), so it takes no argument.
		expect(onSignal).toHaveBeenCalledWith();
	}, 15_000);
});
