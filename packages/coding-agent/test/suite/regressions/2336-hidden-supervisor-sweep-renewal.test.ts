import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createDaemonTargetVerifier,
	ShutdownReport,
	type ShutdownSweep,
	stopHiddenSupervisors,
} from "../../../src/cli/daemon-ps.js";
import { MACHINE_STOP_SELECTION } from "../../../src/cli/daemon-stop-scope.js";
import { acquireDaemonShutdownAdmission } from "../../../src/modes/daemon/daemon-supervisor-ownership.js";

/**
 * Upstream #2336 bullet 4: the hidden-supervisor sweep renews the shutdown ticket before it
 * blocks on its listener scan.
 *
 * The ticket is a lease this process renews on a 1s interval, and the scan is the one place the
 * sweep gives up the event loop that interval needs: `ps`/`lsof`/`ss` are synchronous forks, so a
 * machine with many sockets freezes the loop for the whole scan — the same stall that used to let
 * the lease lapse under a holder that was still inside the shutdown it was admitted for. Every
 * other signalling loop already renews at its head (`terminateVerifiedResiduals`); the scan is
 * injected here so the stall can be driven without forking the real tools.
 */

const supervisorRegistryDirEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
/** Tracks SHUTDOWN_ADMISSION_LEASE_MS: the holder's lease window. */
const ADMISSION_LEASE_MS = 5_000;
const ADMISSION_FILE = "shutdown-admission.json";

interface AdmissionRecord {
	version: 1;
	token: string;
	createdAt: string;
	pid: number;
	processStartId?: string;
	expiresAt: string;
	updatedAt: string;
}

/** The stall a blocking discovery scan is: no timer of ours can fire for the whole window. */
function stallEventLoop(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readAdmission(registryDir: string): AdmissionRecord {
	return JSON.parse(readFileSync(join(registryDir, ADMISSION_FILE), "utf8")) as AdmissionRecord;
}

describe("hidden-supervisor sweep renews its shutdown ticket before the blocking scan", () => {
	let registryDir: string;
	let previousRegistryDir: string | undefined;

	beforeEach(() => {
		registryDir = mkdtempSync(join(tmpdir(), "r2336-hidden-supervisor-"));
		previousRegistryDir = process.env[supervisorRegistryDirEnv];
		process.env[supervisorRegistryDirEnv] = registryDir;
	});

	afterEach(() => {
		if (previousRegistryDir === undefined) delete process.env[supervisorRegistryDirEnv];
		else process.env[supervisorRegistryDirEnv] = previousRegistryDir;
		rmSync(registryDir, { recursive: true, force: true });
	});

	it("holds a live ticket at the moment the listener scan starts", async () => {
		const admission = await acquireDaemonShutdownAdmission();
		const sweep: ShutdownSweep = {
			report: new ShutdownReport(),
			verifier: createDaemonTargetVerifier(),
			handledPids: new Set<number>(),
			assertAdmission: () => admission.assertOrRenew(),
			force: true,
		};

		// The stall that lapses the lease: a synchronous scan, a machine sleep, a wedged fork.
		stallEventLoop(ADMISSION_LEASE_MS + 300);
		// Precondition: the ticket really is lapsed when the sweep starts looping.
		expect(Date.parse(readAdmission(registryDir).expiresAt)).toBeLessThan(Date.now());

		let ticketWasLive: boolean | undefined;
		await stopHiddenSupervisors(sweep, MACHINE_STOP_SELECTION, new Set<number>(), () => {
			ticketWasLive = Date.parse(readAdmission(registryDir).expiresAt) > Date.now();
			// Nothing else is on the path: the scan is the leg under test, and an empty machine
			// ends the sweep after it.
			return [];
		});

		// The ticket has to be fresh before the loop blocks in the scan, not after it: the scan
		// itself is what stops the refresh timer from running.
		expect(ticketWasLive).toBe(true);

		await admission.release();
	}, 30_000);
});
