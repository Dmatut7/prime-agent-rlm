import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDaemonShutdownAdmission } from "../../../src/modes/daemon/daemon-supervisor-ownership.js";

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

/**
 * Block this thread the way a synchronous `ps`/`lsof` fork, a machine sleep, or a
 * wedged syscall blocks the daemon: no timer of ours can fire for the whole window,
 * so the holder's 1s lease refresh does not run and its 5s lease lapses.
 */
function stallEventLoop(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function readAdmission(registryDir: string): AdmissionRecord {
	return JSON.parse(readFileSync(join(registryDir, ADMISSION_FILE), "utf8")) as AdmissionRecord;
}

describe("shutdown admission survives a stall without handing the ticket to a second process", () => {
	let registryDir: string;
	let previousRegistryDir: string | undefined;

	beforeEach(() => {
		registryDir = mkdtempSync(join(tmpdir(), "r08-shutdown-admission-"));
		previousRegistryDir = process.env[supervisorRegistryDirEnv];
		process.env[supervisorRegistryDirEnv] = registryDir;
	});

	afterEach(() => {
		if (previousRegistryDir === undefined) delete process.env[supervisorRegistryDirEnv];
		else process.env[supervisorRegistryDirEnv] = previousRegistryDir;
		rmSync(registryDir, { recursive: true, force: true });
	});

	it("re-acquires its own lapsed admission after a stall instead of losing it permanently", async () => {
		const admission = await acquireDaemonShutdownAdmission();
		const held = readAdmission(registryDir);
		expect(held.pid).toBe(process.pid);

		stallEventLoop(ADMISSION_LEASE_MS + 300);
		// Precondition: the stall really lapsed the lease the holder is supposed to renew.
		expect(Date.parse(readAdmission(registryDir).expiresAt)).toBeLessThan(Date.now());

		// The holder is alive and the record on disk is still its own: it must be able to
		// re-compete for it under the registry guard and carry on.
		await expect(admission.assertOrRenew()).resolves.toBeUndefined();

		const renewed = readAdmission(registryDir);
		expect(renewed.token).toBe(held.token);
		expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.now());

		await admission.release();
		expect(existsSync(join(registryDir, ADMISSION_FILE))).toBe(false);
	}, 30_000);

	it("never lets a waiter take the ticket from a live holder whose lease lapsed", async () => {
		const holder = await acquireDaemonShutdownAdmission();
		const held = readAdmission(registryDir);
		stallEventLoop(ADMISSION_LEASE_MS + 300);
		expect(Date.parse(readAdmission(registryDir).expiresAt)).toBeLessThan(Date.now());

		let waiterAcquired = false;
		const waiting = acquireDaemonShutdownAdmission().then((admission) => {
			waiterAcquired = true;
			return admission;
		});
		await delay(300);

		// The holder is still alive (this very process): a lapsed lease is its own problem
		// to renew, never a licence for a second process to run shutdown work concurrently.
		expect(waiterAcquired).toBe(false);
		expect(readAdmission(registryDir).token).toBe(held.token);

		await holder.release();
		const second = await waiting;
		expect(waiterAcquired).toBe(true);
		await expect(second.assertOrRenew()).resolves.toBeUndefined();
		await second.release();
	}, 30_000);

	it("reports an explicit refusal instead of hanging when a live holder stops renewing", async () => {
		const holder = await acquireDaemonShutdownAdmission();
		stallEventLoop(ADMISSION_LEASE_MS + 300);

		const refusal = await acquireDaemonShutdownAdmission(250).then(
			() => undefined,
			(error: unknown) => error as Error & { code?: string },
		);
		if (!refusal) throw new Error("the waiter was admitted while a live holder owned the ticket");
		expect(refusal.code).toBe("daemon_shutdown_in_progress");
		expect(refusal.message).toContain(`process ${process.pid}`);
		expect(refusal.message).toContain("this shutdown cannot continue");

		// Only the holder's exit frees the ticket: the next waiter is admitted after release.
		await holder.release();
		const successor = await acquireDaemonShutdownAdmission(2_000);
		await successor.release();
	}, 30_000);

	it("reclaims an abandoned admission whose owner process is gone", async () => {
		const abandoned: AdmissionRecord = {
			version: 1,
			token: "abandoned-token",
			createdAt: new Date(Date.now() - ADMISSION_LEASE_MS).toISOString(),
			// Beyond any usable pid: kill(0) fails with ESRCH, so the record names no live process.
			pid: 0x7ffffffe,
			expiresAt: new Date(Date.now() - ADMISSION_LEASE_MS).toISOString(),
			updatedAt: new Date(Date.now() - ADMISSION_LEASE_MS).toISOString(),
		};
		writeFileSync(join(registryDir, ADMISSION_FILE), `${JSON.stringify(abandoned, null, 2)}\n`);

		const admission = await acquireDaemonShutdownAdmission(2_000);
		expect(readAdmission(registryDir).token).not.toBe("abandoned-token");
		expect(readAdmission(registryDir).pid).toBe(process.pid);
		await admission.release();
	}, 30_000);

	it("keeps its ticket when the registry guard cannot be taken, instead of burning it", async () => {
		const admission = await acquireDaemonShutdownAdmission();
		const held = readAdmission(registryDir);
		// Simulate the guard changing hands under a stalled renew: a peer (or a real
		// successor) holds the registry guard for longer than one renew budget.
		const releaseGuard = await lockfile.lock(registryDir, {
			realpath: false,
			lockfilePath: join(registryDir, ".guard"),
			stale: ADMISSION_LEASE_MS,
			update: 1_000,
		});
		try {
			// Settles only once the renew path has spent its whole retry budget on the guard.
			await admission.assertOrRenew().then(
				() => {
					throw new Error("the renew succeeded while a foreign process held the registry guard");
				},
				() => undefined,
			);
		} finally {
			await releaseGuard();
		}

		// The guard failure said nothing about ownership: the ticket must still be ours.
		await expect(admission.assertOrRenew()).resolves.toBeUndefined();
		const renewed = readAdmission(registryDir);
		expect(renewed.token).toBe(held.token);
		expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.now());

		await admission.release();
	}, 60_000);
});
