import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lockState = vi.hoisted(() => ({ compromiseAsync: false, compromiseSync: false }));

type LockOptions = { onCompromised?: (error: Error) => void };
const releaseAsync = vi.fn(async () => {});
const releaseSync = vi.fn(() => {});

vi.mock("proper-lockfile", () => {
	const lock = vi.fn(async (_path: string, options?: LockOptions) => {
		if (lockState.compromiseAsync) options?.onCompromised?.(new Error("async lock compromised"));
		return releaseAsync;
	});
	const lockSync = vi.fn((_path: string, options?: LockOptions) => {
		if (lockState.compromiseSync) options?.onCompromised?.(new Error("sync lock compromised"));
		return releaseSync;
	});
	return { default: { lock, lockSync }, lock, lockSync };
});

import { acquireDaemonUpdateRestartCoordinator } from "../src/cli/daemon-update-restart.js";
import { FileAuthStorageBackend } from "../src/core/auth-storage.js";
import { AgentCronJobStore } from "../src/core/cron-jobs.js";
import { acquireSessionLeaseAsync, SESSION_LEASES_ENABLED_ENV } from "../src/core/session-lease.js";
import { FileSettingsStorage } from "../src/core/settings-manager.js";
import {
	acquireDaemonSocketPathLease,
	cleanupDaemonSocketPath,
	prepareDaemonSocketPath,
} from "../src/modes/daemon/daemon-socket.js";
import { acquireDaemonSupervisorOwnership } from "../src/modes/daemon/daemon-supervisor-ownership.js";

const tempDirs: string[] = [];

beforeEach(() => {
	lockState.compromiseAsync = false;
	lockState.compromiseSync = false;
	releaseAsync.mockClear();
	releaseSync.mockClear();
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/**
 * A session store holding one job whose dispatch never finished, so recovery has a real
 * mutation to perform: `recoverSessionArtifact` rewrites the file only when a dispatch is open.
 */
function interruptedDispatchState(): string {
	return `${JSON.stringify(
		{
			jobs: [
				{
					id: "job-1",
					status: "active",
					source: "heartbeat",
					activeSessionId: "session-1",
					sessionId: "session-1",
					sessionFile: "/tmp/session-1.jsonl",
					cwd: "/tmp",
					prompt: "run",
					schedule: { kind: "once", expression: "" },
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					nextRunAt: "2026-01-02T00:00:00.000Z",
					runCount: 0,
				},
			],
			dispatches: [
				{
					id: "dispatch-1",
					jobId: "job-1",
					claimedAt: "2026-01-02T00:00:00.000Z",
					scheduledFor: "2026-01-02T00:00:00.000Z",
				},
			],
		},
		null,
		2,
	)}\n`;
}

/** A registered session whose store file exists on disk, with one open dispatch. */
function cronArtifactWithOpenDispatch(prefix: string): { store: AgentCronJobStore; artifactDir: string } {
	const root = tempDir(prefix);
	const artifactDir = join(root, "artifact");
	mkdirSync(artifactDir);
	writeFileSync(join(artifactDir, "scheduled-jobs.json"), interruptedDispatchState());
	const store = AgentCronJobStore.forSessionArtifacts();
	store.registerSessionArtifact("session-1", artifactDir);
	return { store, artifactDir };
}

describe("proper-lockfile compromise boundaries", () => {
	it("records a socket lease compromise and fails before preparing the socket", async () => {
		lockState.compromiseAsync = true;
		const socketPath = join(tempDir("pa-lock-socket-"), "daemon.sock");
		const lease = await acquireDaemonSocketPathLease(socketPath);

		expect(lease?.compromise?.message).toBe("async lock compromised");
		await expect(prepareDaemonSocketPath(socketPath, lease)).rejects.toThrow(/was compromised/);
	});

	it.skipIf(process.platform === "win32")(
		"does not unlink a socket when the cleanup guard is compromised",
		async () => {
			lockState.compromiseSync = true;
			const socketPath = join(tempDir("pa-lock-cleanup-"), "daemon.sock");
			const server = createServer();
			try {
				await new Promise<void>((resolve) => server.listen(socketPath, resolve));
				cleanupDaemonSocketPath(socketPath);
				expect(existsSync(socketPath)).toBe(true);
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
	);

	it("fails the supervisor ownership mutation closed", async () => {
		lockState.compromiseAsync = true;
		const root = tempDir("pa-lock-owner-");
		const registryDir = join(root, "registry");
		await expect(
			acquireDaemonSupervisorOwnership({
				socketPath: join(root, "daemon.sock"),
				descriptorDir: join(root, "descriptors"),
				agentDir: join(root, "agent"),
				generation: "compromised-owner",
				appVersion: "test",
				registryDir,
			}),
		).rejects.toThrow(/registry guard was compromised/);
		expect(existsSync(join(registryDir, "compromised-owner.owner"))).toBe(false);
	});

	it("fails the update coordinator mutation closed", async () => {
		lockState.compromiseAsync = true;
		const root = tempDir("pa-lock-update-");
		const registryDir = join(root, "registry");
		await expect(
			acquireDaemonUpdateRestartCoordinator({
				requestId: "request-1",
				socketPath: join(root, "daemon.sock"),
				statusPath: join(root, "status.json"),
				registryDir,
			}),
		).rejects.toThrow(/Coordinator registry guard was compromised/);
		expect(readdirSync(registryDir).filter((name) => name.endsWith(".json"))).toEqual([]);
	});

	it("does not create a session lease after its guard is compromised", async () => {
		lockState.compromiseSync = true;
		const agentDir = tempDir("pa-lock-session-");
		await expect(
			acquireSessionLeaseAsync(join(agentDir, "session.jsonl"), agentDir, { [SESSION_LEASES_ENABLED_ENV]: "1" }),
		).rejects.toThrow(/Session lease guard was compromised/);
		expect(readdirSync(join(agentDir, "session-leases"))).toEqual([]);
	});

	it("does not mutate auth storage after its lock is compromised", () => {
		lockState.compromiseSync = true;
		const authPath = join(tempDir("pa-lock-auth-"), "auth.json");
		const storage = new FileAuthStorageBackend(authPath);
		expect(() => storage.withLock(() => ({ result: undefined, next: "mutated" }))).toThrow(/lock compromised/);
		expect(readFileSync(authPath, "utf8")).toBe("{}");
	});

	it("does not mutate settings after its lock is compromised", () => {
		lockState.compromiseSync = true;
		const root = tempDir("pa-lock-settings-");
		const storage = new FileSettingsStorage(root, join(root, "agent"));
		expect(() => storage.withLock("global", () => "mutated")).toThrow(/lock compromised/);
		expect(existsSync(join(root, "agent", "settings.json"))).toBe(false);
	});

	/**
	 * 5338afe49 ("reclaim unreferenced disk state with a bounded retention sweep", merged as
	 * d1d66f503) made `recoverSessionArtifact` return early for a registered session whose store
	 * file is absent or tombstoned, and this test's red (`expected [Function] to throw an error`)
	 * is that change. The early return is the more correct behaviour, so the compromised lock is
	 * now driven through a store file that really exists:
	 *
	 * - `withCronJobsStateLocks` starts by `mkdirSync(dirname(path), { recursive: true })` for
	 *   every path it is handed, so locking the store of a deleted session recreated the very
	 *   artifact directory the retention sweep had just removed. Asserting "a compromise must
	 *   surface even when the file is missing" pinned that resurrection, not fail-closed.
	 * - A missing store file holds neither jobs nor dispatches, so the skipped path cannot mutate
	 *   anything; the same invariant now gates `mutateStates` and `writeJobs`, and
	 *   test/retention-root-fix.test.ts pins "recovery must not recreate a deleted store dir".
	 *
	 * The mutation guard itself is unchanged and still asserted below, with a positive control
	 * showing the seeded dispatch is something recovery would really have rewritten.
	 */
	it("does not mutate scheduled jobs after a lock compromise", () => {
		lockState.compromiseSync = true;
		const { store, artifactDir } = cronArtifactWithOpenDispatch("pa-lock-cron-");
		const storePath = join(artifactDir, "scheduled-jobs.json");

		expect(() => store.recoverSessionArtifact("session-1", new Date("2026-01-03T00:00:00.000Z"))).toThrow(
			/Cron jobs lock compromised/,
		);
		// Byte-identical: the interrupted dispatch is still open, nothing was rewritten, and no
		// temp file from a half-finished atomic write was left behind.
		expect(readFileSync(storePath, "utf8")).toBe(interruptedDispatchState());
		expect(readdirSync(artifactDir)).toEqual(["scheduled-jobs.json"]);
	});

	/** Positive control: the state above is one recovery really does rewrite when the lock is healthy. */
	it("recovers the same store when its lock is not compromised", () => {
		const { store, artifactDir } = cronArtifactWithOpenDispatch("pa-lock-cron-healthy-");
		const storePath = join(artifactDir, "scheduled-jobs.json");

		const recovered = store.recoverSessionArtifact("session-1", new Date("2026-01-03T00:00:00.000Z"));

		expect(recovered.map((job) => job.id)).toEqual(["job-1"]);
		expect(readFileSync(storePath, "utf8")).not.toBe(interruptedDispatchState());
		expect(readdirSync(artifactDir)).toEqual(["scheduled-jobs.json"]);
	});

	/** The new half of the contract: no store file means no lock attempt and no created directory. */
	it("does not lock or create anything for a session whose store file is absent", () => {
		// Armed, so reaching `withCronJobsStateLocks` - which also mkdirs - would throw.
		lockState.compromiseSync = true;
		const root = tempDir("pa-lock-cron-absent-");
		const artifactDir = join(root, "artifact");
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact("session-1", artifactDir);

		expect(store.recoverSessionArtifact("session-1")).toEqual([]);
		expect(existsSync(artifactDir)).toBe(false);
	});
});
