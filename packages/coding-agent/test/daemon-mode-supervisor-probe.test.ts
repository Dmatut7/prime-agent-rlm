import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkSupervisorAvailability,
	probeSupervisorAvailability,
	SUPERVISOR_PROBE_ATTEMPTS,
	SUPERVISOR_RECHECK_BACKOFF_MS,
	SUPERVISOR_RECHECK_MAX_MS,
	SUPERVISOR_SHUTDOWN_ADMISSION_RECHECK_MS,
	type SupervisorAvailabilityDeps,
	type SupervisorAvailabilityState,
	supervisorRecheckDelayMs,
} from "../src/modes/daemon/supervisor-availability.js";

/**
 * P1-7b, 250ms tier. One 250ms connect probe used to decide the supervisor was
 * dead, so every worker on a host raced to launch a replacement at once — the
 * `Lock file is already being held` storm. Death now takes a whole failed probe
 * round, and the recheck between rounds backs off.
 *
 * `daemon-mode.ts` wires these two functions into its monitor round; the launch
 * stub below reproduces the first observable effect of the real
 * `launchReplacementSupervisor` (creating its lock directory), so "did not
 * launch" is asserted on the filesystem and not only on a call count.
 */

const roots: string[] = [];

afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop()!, { recursive: true, force: true });
	}
});

function launchStub(socketPath: string): {
	launch: (path: string) => Promise<void>;
	lockDirectory: string;
	calls: number;
} {
	const key = createHash("sha256").update(socketPath).digest("hex").slice(0, 12);
	const lockDirectory = join(dirname(socketPath), `.supervisor-launch-${key}.lock`);
	const stub = {
		calls: 0,
		lockDirectory,
		launch: async (_path: string) => {
			stub.calls++;
			// Same first move as daemon-mode's launchReplacementSupervisor.
			mkdirSync(lockDirectory, { recursive: true });
		},
	};
	return stub;
}

function makeDeps(socketPath: string, overrides: Partial<SupervisorAvailabilityDeps> = {}) {
	const stub = launchStub(socketPath);
	const deps: SupervisorAvailabilityDeps = {
		probe: (path) => probeSupervisorAvailability(path, { intervalMs: 1, connect: async () => false }),
		launchReplacement: stub.launch,
		isConnected: () => false,
		isShuttingDown: () => false,
		isShutdownAdmissionActive: async () => false,
		...overrides,
	};
	return { deps, stub };
}

describe("P1-7b supervisor availability round", () => {
	it("does not launch a replacement when the second probe connects", async () => {
		const root = mkdtempSync(join(tmpdir(), "ma-t4-2-probe-"));
		roots.push(root);
		const socketPath = join(root, "supervisor.sock");
		let probes = 0;
		const { deps, stub } = makeDeps(socketPath, {
			probe: (path) =>
				probeSupervisorAvailability(path, {
					intervalMs: 1,
					connect: async () => {
						probes++;
						return probes >= 2;
					},
				}),
		});
		const state: SupervisorAvailabilityState = { consecutiveFailures: 0 };

		const outcome = await checkSupervisorAvailability(socketPath, state, deps);

		// RED on HEAD: the first failed probe launched a replacement and took the lock.
		expect(existsSync(stub.lockDirectory)).toBe(false);
		expect(stub.calls).toBe(0);
		expect(outcome.launchedReplacement).toBe(false);
		expect(outcome.probe).toEqual({ available: true, attempts: 2 });
		expect(probes).toBe(2);
		expect(state.consecutiveFailures).toBe(0);
		// A socket that accepts is not an authenticated supervisor yet: between this
		// probe and `worker_auth` (adoption queuing can stretch that to minutes) the
		// supervisor can still die, so the round stays armed on the slow tier instead
		// of ending the monitoring for good.
		expect(outcome.nextDelayMs).toBe(SUPERVISOR_RECHECK_MAX_MS);
	});

	it("stops monitoring once the supervisor has authenticated", async () => {
		const root = mkdtempSync(join(tmpdir(), "ma-t4-2-probe-authenticated-"));
		roots.push(root);
		const socketPath = join(root, "supervisor.sock");
		const { deps, stub } = makeDeps(socketPath, {
			isConnected: () => true,
			probe: async () => ({ available: true, attempts: 1 }),
		});
		const state: SupervisorAvailabilityState = { consecutiveFailures: 0 };

		const outcome = await checkSupervisorAvailability(socketPath, state, deps);

		expect(outcome.nextDelayMs).toBeUndefined();
		expect(outcome.launchedReplacement).toBe(false);
		expect(stub.calls).toBe(0);
	});

	it("keeps a slow round armed while the socket answers but nobody authenticated", async () => {
		const root = mkdtempSync(join(tmpdir(), "ma-t4-2-probe-unauthenticated-"));
		roots.push(root);
		const socketPath = join(root, "supervisor.sock");
		let connected = false;
		const { deps, stub } = makeDeps(socketPath, {
			isConnected: () => connected,
			probe: async () => ({ available: true, attempts: 1 }),
		});
		const state: SupervisorAvailabilityState = { consecutiveFailures: 0 };

		// The window the fix is about: the probe succeeds, `worker_auth` has not landed.
		expect((await checkSupervisorAvailability(socketPath, state, deps)).nextDelayMs).toBe(SUPERVISOR_RECHECK_MAX_MS);
		expect((await checkSupervisorAvailability(socketPath, state, deps)).nextDelayMs).toBe(SUPERVISOR_RECHECK_MAX_MS);
		expect(stub.calls).toBe(0);

		// Authentication ends it, and a shutdown ends it too.
		connected = true;
		expect((await checkSupervisorAvailability(socketPath, state, deps)).nextDelayMs).toBeUndefined();
		connected = false;
		const shuttingDown = makeDeps(socketPath, {
			isConnected: () => false,
			isShuttingDown: () => true,
			probe: async () => ({ available: true, attempts: 1 }),
		});
		expect((await checkSupervisorAvailability(socketPath, state, shuttingDown.deps)).nextDelayMs).toBeUndefined();
	});

	it("launches a replacement after a whole round fails, and backs off the recheck", async () => {
		const root = mkdtempSync(join(tmpdir(), "ma-t4-2-probe-dead-"));
		roots.push(root);
		const socketPath = join(root, "supervisor.sock");
		const failedAttempts: string[] = [];
		const { deps, stub } = makeDeps(socketPath, {
			probe: (path) =>
				probeSupervisorAvailability(path, {
					intervalMs: 1,
					onFailedAttempt: (attempt, attempts) => failedAttempts.push(`${attempt}/${attempts}`),
				}),
		});
		const state: SupervisorAvailabilityState = { consecutiveFailures: 0 };

		const first = await checkSupervisorAvailability(socketPath, state, deps);
		const afterFirstRound = [...failedAttempts];
		const second = await checkSupervisorAvailability(socketPath, state, deps);

		// Positive control: self-healing is preserved, one launch per failed round.
		expect(stub.calls).toBe(2);
		expect(existsSync(stub.lockDirectory)).toBe(true);
		expect(first.launchedReplacement).toBe(true);
		expect(first.probe).toEqual({ available: false, attempts: SUPERVISOR_PROBE_ATTEMPTS });
		// The countable signature carries the attempt number, one line per failed probe.
		expect(afterFirstRound).toEqual(["1/3", "2/3", "3/3"]);
		expect(failedAttempts).toHaveLength(2 * SUPERVISOR_PROBE_ATTEMPTS);
		// The recheck backs off with the number of rounds that failed in a row.
		expect(state.consecutiveFailures).toBe(2);
		expect(first.nextDelayMs).toBe(SUPERVISOR_RECHECK_BACKOFF_MS[0]);
		expect(second.nextDelayMs).toBe(SUPERVISOR_RECHECK_BACKOFF_MS[1]);
	});

	it("stops monitoring once the supervisor authenticated or the worker is shutting down", async () => {
		const root = mkdtempSync(join(tmpdir(), "ma-t4-2-probe-stop-"));
		roots.push(root);
		const socketPath = join(root, "supervisor.sock");
		const state: SupervisorAvailabilityState = { consecutiveFailures: 2 };
		const cases = [
			{ name: "authenticated", overrides: { isConnected: () => true } },
			{ name: "shutting down", overrides: { isShuttingDown: () => true } },
		];
		expect(cases.length).toBeGreaterThan(0);
		for (const testCase of cases) {
			let probed = 0;
			const { deps, stub } = makeDeps(socketPath, {
				...testCase.overrides,
				probe: async () => {
					probed++;
					return { available: false, attempts: 0 };
				},
			});

			const outcome = await checkSupervisorAvailability(socketPath, state, deps);

			expect(probed, testCase.name).toBe(0);
			expect(stub.calls, testCase.name).toBe(0);
			expect(outcome.nextDelayMs, testCase.name).toBeUndefined();
		}
	});

	it("rechecks a shutdown admission in progress without counting it as a failure", async () => {
		const root = mkdtempSync(join(tmpdir(), "ma-t4-2-probe-admission-"));
		roots.push(root);
		const socketPath = join(root, "supervisor.sock");
		const { deps, stub } = makeDeps(socketPath, { isShutdownAdmissionActive: async () => true });
		const state: SupervisorAvailabilityState = { consecutiveFailures: 3 };

		const outcome = await checkSupervisorAvailability(socketPath, state, deps);

		expect(stub.calls).toBe(0);
		expect(outcome.launchedReplacement).toBe(false);
		expect(outcome.nextDelayMs).toBe(SUPERVISOR_SHUTDOWN_ADMISSION_RECHECK_MS);
		expect(state.consecutiveFailures).toBe(3);
	});

	it("ends a probe round early when the worker stops caring mid-round", async () => {
		const root = mkdtempSync(join(tmpdir(), "ma-t4-2-probe-cancel-"));
		roots.push(root);
		let probes = 0;

		const result = await probeSupervisorAvailability(join(root, "supervisor.sock"), {
			intervalMs: 1,
			connect: async () => {
				probes++;
				return false;
			},
			isCancelled: () => probes >= 2,
		});

		expect(result.available).toBe(false);
		expect(probes).toBe(2);
		// `attempts` counts the probes that actually ran, so a cancelled round reports 2.
		expect(result.attempts).toBe(2);
	});

	it("grows the recheck delay along the ladder and caps it", () => {
		const cases = [
			{ failures: 0, expected: SUPERVISOR_SHUTDOWN_ADMISSION_RECHECK_MS },
			{ failures: 1, expected: 5_000 },
			{ failures: 2, expected: 10_000 },
			{ failures: 3, expected: 20_000 },
			{ failures: 4, expected: SUPERVISOR_RECHECK_MAX_MS },
			{ failures: 50, expected: SUPERVISOR_RECHECK_MAX_MS },
		];
		expect(cases.length).toBeGreaterThan(0);
		for (const testCase of cases) {
			expect(supervisorRecheckDelayMs(testCase.failures), `${testCase.failures} failures`).toBe(testCase.expected);
		}
		expect(SUPERVISOR_RECHECK_MAX_MS).toBe(60_000);
	});
});
