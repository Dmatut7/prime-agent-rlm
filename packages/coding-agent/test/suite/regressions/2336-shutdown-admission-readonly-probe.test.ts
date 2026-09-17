import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProcessStartId } from "../../../src/core/session-lease.js";
import {
	acquireDaemonShutdownAdmission,
	isDaemonShutdownAdmissionActive,
} from "../../../src/modes/daemon/daemon-supervisor-ownership.js";

/**
 * Upstream #2336 bullet 2, second half: the advisory probe is read-only.
 *
 * `isDaemonShutdownAdmissionActive` answers a question - "is a shutdown running right now?" - and
 * it is called by bystanders (a starting daemon, `daemon ps`, the supervisor). Reclaiming an
 * admission record from a *read* makes a bystander's liveness comparison the thing that deletes
 * authority state, and the comparison is exactly what cannot be trusted from there: a record whose
 * process identity does not verify may still name a live holder (a recycled pid, a start id a
 * different platform spells differently, an unverifiable record). Reclaim stays with
 * `acquireDaemonShutdownAdmission`, which revalidates under the registry guard and only removes an
 * admission it can prove abandoned.
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

function admissionPath(registryDir: string): string {
	return join(registryDir, ADMISSION_FILE);
}

function writeAdmission(registryDir: string, record: Partial<AdmissionRecord> & { token: string }): void {
	const now = Date.now();
	const full: AdmissionRecord = {
		version: 1,
		createdAt: new Date(now).toISOString(),
		updatedAt: new Date(now).toISOString(),
		expiresAt: new Date(now + ADMISSION_LEASE_MS).toISOString(),
		pid: process.pid,
		...record,
	};
	writeFileSync(admissionPath(registryDir), `${JSON.stringify(full, null, 2)}\n`);
}

function readAdmission(registryDir: string): AdmissionRecord {
	return JSON.parse(readFileSync(admissionPath(registryDir), "utf8")) as AdmissionRecord;
}

describe("the shutdown-admission probe reports without reclaiming", () => {
	let registryDir: string;
	let previousRegistryDir: string | undefined;

	beforeEach(() => {
		registryDir = mkdtempSync(join(tmpdir(), "r2336-admission-probe-"));
		previousRegistryDir = process.env[supervisorRegistryDirEnv];
		process.env[supervisorRegistryDirEnv] = registryDir;
	});

	afterEach(() => {
		if (previousRegistryDir === undefined) delete process.env[supervisorRegistryDirEnv];
		else process.env[supervisorRegistryDirEnv] = previousRegistryDir;
		rmSync(registryDir, { recursive: true, force: true });
	});

	it("answers 'no shutdown' without deleting a record whose process identity does not verify", async () => {
		// A live pid (this one) with an identity that cannot be the live process: the shape a
		// recycled pid, or a record written under a different start-id spelling, has on disk.
		writeAdmission(registryDir, {
			token: "unverifiable-holder",
			processStartId: `${getProcessStartId(process.pid) ?? "none"}-stale`,
		});

		expect(await isDaemonShutdownAdmissionActive()).toBe(false);
		expect(existsSync(admissionPath(registryDir))).toBe(true);
		expect(readAdmission(registryDir).token).toBe("unverifiable-holder");

		// Reclaim is still the acquire path's call, and it still works: the probe left the record
		// for it to revalidate under the registry guard.
		const admission = await acquireDaemonShutdownAdmission(2_000);
		expect(readAdmission(registryDir).token).not.toBe("unverifiable-holder");
		expect(readAdmission(registryDir).pid).toBe(process.pid);
		await admission.release();
	}, 30_000);

	it("leaves a lapsed lease of a live holder on disk", async () => {
		const now = Date.now();
		writeAdmission(registryDir, {
			token: "stalled-holder",
			// A live holder whose lease lapsed while it was stalled: the record is still its own,
			// and only its own renew (or its exit) may change that.
			expiresAt: new Date(now - 1_000).toISOString(),
		});

		expect(await isDaemonShutdownAdmissionActive()).toBe(false);
		const kept = readAdmission(registryDir);
		expect(kept.token).toBe("stalled-holder");
		expect(Date.parse(kept.expiresAt)).toBeLessThan(Date.now());

		// A live holder keeps its ticket: a waiter is refused instead of taking it.
		const refusal = await acquireDaemonShutdownAdmission(250).then(
			() => undefined,
			(error: unknown) => error as Error & { code?: string },
		);
		expect(refusal?.code).toBe("daemon_shutdown_in_progress");
		expect(readAdmission(registryDir).token).toBe("stalled-holder");
	}, 30_000);
});
