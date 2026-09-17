import { describe, expect, it, vi } from "vitest";
import {
	checkSupervisorAvailability,
	SUPERVISOR_SHUTDOWN_ADMISSION_RECHECK_MS,
	type SupervisorAvailabilityState,
} from "../src/modes/daemon/supervisor-availability.js";

/**
 * #2246 dep-4 (P3 verification): the orphan worker exit gate must not fire while a
 * planned shutdown/restart holds a shutdown admission. The admission is a 5s lease
 * with a 1s refresh held by the update coordinator; the orphan window is 5min.
 */

function orphanDeps(overrides: {
	admissionActive: boolean;
	probeAvailable?: boolean;
	connectAfterLaunch?: boolean;
	orphanedLongEnough?: boolean;
	onOrphaned?: () => Promise<void>;
}) {
	return {
		isShuttingDown: () => false,
		isConnected: () => false,
		isShutdownAdmissionActive: async () => overrides.admissionActive,
		probe: async () => ({ available: overrides.probeAvailable ?? false, attempts: 1 }),
		launchReplacement: async () => {},
		connectAfterLaunch: async () => overrides.connectAfterLaunch ?? false,
		isOrphanedLongEnough: () => overrides.orphanedLongEnough ?? true,
		onOrphaned: overrides.onOrphaned ?? (async () => {}),
	};
}

describe("supervisor availability: orphan gate vs shutdown admission", () => {
	it("a pending shutdown admission suppresses the orphan exit even when the window ran out", async () => {
		const state: SupervisorAvailabilityState = {
			consecutiveFailures: 0,
			supervisorAbsentSince: Date.now() - 10 * 60_000,
		};
		const onOrphaned = vi.fn(async () => {});
		const outcome = await checkSupervisorAvailability(
			"/tmp/supervisor.sock",
			state,
			orphanDeps({ admissionActive: true, orphanedLongEnough: true, onOrphaned }),
		);
		expect(onOrphaned).not.toHaveBeenCalled();
		expect(state.supervisorAbsentSince).toBeUndefined();
		expect(outcome.nextDelayMs).toBe(SUPERVISOR_SHUTDOWN_ADMISSION_RECHECK_MS);
		expect(outcome.launchedReplacement).toBe(false);
	});

	it("fires the orphan exit once the admission is gone and the window ran out (positive control)", async () => {
		const state: SupervisorAvailabilityState = {
			consecutiveFailures: 0,
			supervisorAbsentSince: Date.now() - 10 * 60_000,
		};
		const onOrphaned = vi.fn(async () => {});
		const outcome = await checkSupervisorAvailability(
			"/tmp/supervisor.sock",
			state,
			orphanDeps({ admissionActive: false, orphanedLongEnough: true, onOrphaned }),
		);
		expect(onOrphaned).toHaveBeenCalledOnce();
		expect(outcome.launchedReplacement).toBe(true);
	});

	it("does not fire while the window is still running (negative control)", async () => {
		const state: SupervisorAvailabilityState = { consecutiveFailures: 0, supervisorAbsentSince: Date.now() - 1_000 };
		const onOrphaned = vi.fn(async () => {});
		await checkSupervisorAvailability(
			"/tmp/supervisor.sock",
			state,
			orphanDeps({ admissionActive: false, orphanedLongEnough: false, onOrphaned }),
		);
		expect(onOrphaned).not.toHaveBeenCalled();
	});
});
