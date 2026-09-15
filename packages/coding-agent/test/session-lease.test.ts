import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lockSync } from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireSessionLeaseAsync,
	canonicalSessionPath,
	getProcessStartId,
	getWindowsProcessStartId,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
	SessionAlreadyActiveError,
} from "../src/core/session-lease.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-session-lease-test-"));
	tempDirs.push(directory);
	return directory;
}

function enabledEnvironment(owner: string): NodeJS.ProcessEnv {
	return {
		[SESSION_LEASES_ENABLED_ENV]: "1",
		[SESSION_LEASE_OWNER_ID_ENV]: owner,
	};
}

function leaseDirectoryFor(agentDir: string, sessionPath: string): string {
	const key = createHash("sha256").update(sessionPath).digest("hex");
	return join(agentDir, "session-leases", `${key}.lock`);
}

// chmod 000 cannot hide a file from its owner when the test process runs as root,
// so the unreadable-owner path is only observable for a non-root uid.
const chmodCanBlockReads = typeof process.getuid === "function" && process.getuid() !== 0;

describe("session leases", () => {
	it("reads an invariant process start identity on Windows", () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const processStartId = getWindowsProcessStartId(42, (command, args) => {
			calls.push({ command, args });
			return "638880485801234567\r\n";
		});

		expect(processStartId).toBe("win:638880485801234567");
		expect(calls).toEqual([
			{
				command: "powershell.exe",
				args: [
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"([System.Diagnostics.Process]::GetProcessById(42)).StartTime.ToUniversalTime().Ticks",
				],
			},
		]);
	});

	it("rejects invalid Windows process start identities", () => {
		let queryCount = 0;
		const query = () => {
			queryCount++;
			return "not-a-start-time";
		};

		expect(getWindowsProcessStartId(42, query)).toBeUndefined();
		expect(getWindowsProcessStartId(0, query)).toBeUndefined();
		expect(queryCount).toBe(1);
	});

	it("rejects a second live owner with a typed active-session error", async () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "session.jsonl");
		const first = await acquireSessionLeaseAsync(sessionPath, agentDir, enabledEnvironment("resident-a"));

		await expect(acquireSessionLeaseAsync(sessionPath, agentDir, enabledEnvironment("owned-b"))).rejects.toThrow(
			SessionAlreadyActiveError,
		);
		try {
			await acquireSessionLeaseAsync(sessionPath, agentDir, enabledEnvironment("owned-b"));
		} catch (error) {
			expect(error).toMatchObject({
				code: "session_already_active",
				activeSessionId: "resident-a",
				sessionPath: canonicalSessionPath(sessionPath),
			});
		}

		first?.release();
		const second = await acquireSessionLeaseAsync(sessionPath, agentDir, enabledEnvironment("owned-b"));
		expect(second?.sessionPath).toBe(canonicalSessionPath(sessionPath));
		second?.release();
	});

	it("lets an interactive launch force leases without a daemon owner id", async () => {
		// Interactive mode enables leases per-acquire (no SESSION_LEASE_OWNER_ID).
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(resolve(agentDir, "interactive.jsonl"));
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const lockDirectory = join(agentDir, "session-leases", `${key}.lock`);

		// A different live process (pid 1, no start id recorded) owns the lease:
		// the interactive acquire must collide loudly.
		mkdirSync(lockDirectory, { recursive: true });
		writeFileSync(
			join(lockDirectory, "owner.json"),
			JSON.stringify({
				version: 1,
				token: "other",
				pid: 1,
				sessionPath,
				createdAt: new Date(0).toISOString(),
			}),
		);
		const environment: NodeJS.ProcessEnv = { ...process.env, [SESSION_LEASES_ENABLED_ENV]: "1" };
		delete environment[SESSION_LEASE_OWNER_ID_ENV];
		let caught: unknown;
		try {
			await acquireSessionLeaseAsync(sessionPath, agentDir, environment);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(SessionAlreadyActiveError);
		expect((caught as SessionAlreadyActiveError).activeSessionId).toBeUndefined();

		// Our own (leaked) lease with the same owner identity is taken over.
		writeFileSync(
			join(lockDirectory, "owner.json"),
			JSON.stringify({
				version: 1,
				token: "self",
				pid: process.pid,
				sessionPath,
				createdAt: new Date(0).toISOString(),
			}),
		);
		const lease = await acquireSessionLeaseAsync(sessionPath, agentDir, environment);
		expect(lease?.sessionPath).toBe(sessionPath);
		lease?.release();
	});

	it("keeps an actively held in-process lease conflicting", async () => {
		// A live SessionLease in this process (e.g. an in-process RLM child
		// runtime) must still conflict even under the same pid and owner
		// identity; only leaked leases are reclaimable.
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "held.jsonl");
		const environment = enabledEnvironment("held-owner");
		const first = await acquireSessionLeaseAsync(sessionPath, agentDir, environment);
		expect(first).toBeDefined();
		await expect(acquireSessionLeaseAsync(sessionPath, agentDir, environment)).rejects.toThrow(
			SessionAlreadyActiveError,
		);
		first?.release();
		const second = await acquireSessionLeaseAsync(sessionPath, agentDir, environment);
		expect(second?.sessionPath).toBe(canonicalSessionPath(sessionPath));
		second?.release();
	});

	it("reclaims a lease owned by this process instead of deadlocking on itself", async () => {
		// A prior acquire in this process can leak its lease (failed release,
		// unavailable start-id detection). Re-acquiring must take it over rather
		// than raise SessionAlreadyActiveError against its own pid.
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(resolve(agentDir, "self-owned.jsonl"));
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const lockDirectory = join(agentDir, "session-leases", `${key}.lock`);
		mkdirSync(lockDirectory, { recursive: true });
		writeFileSync(
			join(lockDirectory, "owner.json"),
			JSON.stringify({
				version: 1,
				token: "self",
				pid: process.pid,
				activeSessionId: "self-session",
				sessionPath,
				createdAt: new Date(0).toISOString(),
			}),
		);

		const lease = await acquireSessionLeaseAsync(sessionPath, agentDir, enabledEnvironment("self-session"));
		expect(lease?.sessionPath).toBe(sessionPath);
		lease?.release();
	});

	it("keeps the process start id stable across timezone environments", () => {
		if (process.platform === "win32") {
			return;
		}
		const originalTz = process.env.TZ;
		try {
			process.env.TZ = "America/New_York";
			const first = getProcessStartId(process.pid);
			process.env.TZ = "Australia/Sydney";
			const second = getProcessStartId(process.pid);
			expect(first).toBeDefined();
			expect(second).toBe(first);
		} finally {
			if (originalTz === undefined) {
				delete process.env.TZ;
			} else {
				process.env.TZ = originalTz;
			}
		}
	});

	it("reclaims a lease whose owner process is gone", async () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(resolve(agentDir, "stale.jsonl"));
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const lockDirectory = join(agentDir, "session-leases", `${key}.lock`);
		mkdirSync(lockDirectory, { recursive: true });
		writeFileSync(
			join(lockDirectory, "owner.json"),
			JSON.stringify({
				version: 1,
				token: "stale",
				pid: 2_147_483_647,
				activeSessionId: "dead-owner",
				sessionPath,
				createdAt: new Date(0).toISOString(),
			}),
		);

		const lease = await acquireSessionLeaseAsync(sessionPath, agentDir, enabledEnvironment("replacement"));
		expect(lease?.sessionPath).toBe(sessionPath);
		lease?.release();
	});

	it("reports guard contention as a coordination failure", async () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(join(agentDir, "session.jsonl"));
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const leaseRoot = join(agentDir, "session-leases");
		const lockDirectory = join(leaseRoot, `${key}.lock`);
		mkdirSync(leaseRoot, { recursive: true });
		const release = lockSync(lockDirectory, {
			realpath: false,
			lockfilePath: `${lockDirectory}.guard`,
			stale: 5000,
		});

		try {
			let thrown: unknown;
			try {
				await acquireSessionLeaseAsync(sessionPath, agentDir, enabledEnvironment("resident-a"));
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(Error);
			expect(thrown).not.toBeInstanceOf(SessionAlreadyActiveError);
			expect((thrown as Error).message).toContain("Could not coordinate session lease");
		} finally {
			release();
		}
	});

	it("treats symlink aliases as the same persisted session", async () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "session.jsonl");
		const aliasPath = join(agentDir, "session-alias.jsonl");
		writeFileSync(sessionPath, "");
		symlinkSync(sessionPath, aliasPath);
		const first = await acquireSessionLeaseAsync(sessionPath, agentDir, enabledEnvironment("resident-a"));

		await expect(acquireSessionLeaseAsync(aliasPath, agentDir, enabledEnvironment("owned-b"))).rejects.toThrow(
			SessionAlreadyActiveError,
		);
		first?.release();
	});

	it("reclaims a lease after its pid has been reused", async () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(resolve(agentDir, "reused-pid.jsonl"));
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const lockDirectory = join(agentDir, "session-leases", `${key}.lock`);
		mkdirSync(lockDirectory, { recursive: true });
		writeFileSync(
			join(lockDirectory, "owner.json"),
			JSON.stringify({
				version: 1,
				token: "stale",
				pid: process.pid,
				processStartId: "different-process",
				activeSessionId: "old-owner",
				sessionPath,
				createdAt: new Date(0).toISOString(),
			}),
		);

		const lease = await acquireSessionLeaseAsync(sessionPath, agentDir, enabledEnvironment("replacement"));
		expect(lease?.sessionPath).toBe(sessionPath);
		lease?.release();
	});

	it("reclaims a lease whose owner.json was torn by a crash", async () => {
		// A truncated owner.json names no process, so the next acquire takes the lease
		// over. That reclaim is long-standing behavior, pinned here; what is new is the
		// atomic owner write, which stops fresh tears and leaves no temp file behind.
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(resolve(agentDir, "torn.jsonl"));
		const lockDirectory = leaseDirectoryFor(agentDir, sessionPath);
		mkdirSync(lockDirectory, { recursive: true });
		const tornRecord = JSON.stringify({
			version: 1,
			token: "torn",
			pid: 1,
			activeSessionId: "crashed-owner",
			sessionPath,
			createdAt: new Date(0).toISOString(),
		}).slice(0, 40);
		expect(() => JSON.parse(tornRecord)).toThrow();
		writeFileSync(join(lockDirectory, "owner.json"), tornRecord);

		const lease = await acquireSessionLeaseAsync(sessionPath, agentDir, enabledEnvironment("replacement"));
		expect(lease?.sessionPath).toBe(sessionPath);

		// The replacement record is complete, and the atomic write left no temp file.
		expect(readdirSync(lockDirectory)).toEqual(["owner.json"]);
		const owner = JSON.parse(readFileSync(join(lockDirectory, "owner.json"), "utf8")) as {
			version: number;
			token: string;
			pid: number;
			activeSessionId: string;
			sessionPath: string;
			createdAt: string;
		};
		expect(owner).toMatchObject({ version: 1, pid: process.pid, activeSessionId: "replacement", sessionPath });
		expect(typeof owner.token).toBe("string");
		expect(typeof owner.createdAt).toBe("string");

		// Reclaiming torn bytes must not weaken the collision guard: the fresh
		// record still fails closed against another owner identity.
		await expect(acquireSessionLeaseAsync(sessionPath, agentDir, enabledEnvironment("intruder"))).rejects.toThrow(
			SessionAlreadyActiveError,
		);

		lease?.release();
		expect(existsSync(lockDirectory)).toBe(false);
	});

	it("reclaims a lease whose owner.json cannot be decoded", async () => {
		const payloads = [
			"",
			"this is not json",
			'{"version": 1, "token": "half-written", "pi',
			"null",
			"[]",
			"{}",
			JSON.stringify({ version: 1, token: "orphan" }),
			JSON.stringify({ version: 1, token: "orphan", pid: "not-a-pid", sessionPath: "/x", createdAt: "now" }),
		];
		expect(payloads.length).toBeGreaterThan(0);
		for (const [index, payload] of payloads.entries()) {
			const agentDir = createTempDir();
			const sessionPath = canonicalSessionPath(resolve(agentDir, `undecodable-${index}.jsonl`));
			const lockDirectory = leaseDirectoryFor(agentDir, sessionPath);
			mkdirSync(lockDirectory, { recursive: true });
			writeFileSync(join(lockDirectory, "owner.json"), payload);

			const lease = await acquireSessionLeaseAsync(sessionPath, agentDir, enabledEnvironment("replacement"));
			expect(lease?.sessionPath, `payload ${index}: ${JSON.stringify(payload)}`).toBe(sessionPath);
			lease?.release();
		}
	});

	it("reclaims a lease when owner.json is absent", async () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(resolve(agentDir, "absent-lock.jsonl"));
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const lockDirectory = join(agentDir, "session-leases", `${key}.lock`);
		mkdirSync(lockDirectory, { recursive: true });
		const lease = await acquireSessionLeaseAsync(sessionPath, agentDir, enabledEnvironment("replacement"));
		expect(lease?.sessionPath).toBe(sessionPath);
		lease?.release();
	});

	it.skipIf(!chmodCanBlockReads)("fails closed while owner.json cannot be read", async () => {
		// An owner record this process cannot *read* is not the same as a missing
		// one: reading it is the only way to learn whether its owner is still alive,
		// and a reclaim only needs write access to the parent directory. Taking over
		// an unreadable record would steal a lease that may still be held, so acquire
		// must fail closed for as long as the record stays opaque.
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(resolve(agentDir, "unreadable.jsonl"));
		const lockDirectory = leaseDirectoryFor(agentDir, sessionPath);
		mkdirSync(lockDirectory, { recursive: true });
		const ownerPath = join(lockDirectory, "owner.json");
		const recordedOwner = `${JSON.stringify(
			{
				version: 1,
				token: "opaque",
				pid: 2_147_483_647,
				activeSessionId: "opaque-owner",
				sessionPath,
				createdAt: new Date(0).toISOString(),
			},
			null,
			2,
		)}\n`;
		writeFileSync(ownerPath, recordedOwner, { mode: 0o600 });

		try {
			chmodSync(ownerPath, 0o000);

			let thrown: unknown;
			let acquired: Awaited<ReturnType<typeof acquireSessionLeaseAsync>> | undefined;
			try {
				acquired = await acquireSessionLeaseAsync(sessionPath, agentDir, enabledEnvironment("replacement"));
			} catch (error) {
				thrown = error;
			}
			acquired?.release();

			// Fail closed: refuse the session instead of taking over an opaque lease.
			expect(acquired).toBeUndefined();
			expect(thrown).toBeInstanceOf(Error);
			expect(thrown).not.toBeInstanceOf(SessionAlreadyActiveError);
			expect((thrown as Error).message).toContain("Could not acquire session lease");

			// The unreadable record survived untouched: nothing was reclaimed, renamed
			// away, or replaced by this process's own record.
			chmodSync(ownerPath, 0o600);
			expect(readdirSync(lockDirectory)).toEqual(["owner.json"]);
			expect(readFileSync(ownerPath, "utf8")).toBe(recordedOwner);
		} finally {
			// A stolen (reclaimed) record leaves nothing to restore; keep the failure
			// on the assertion that caught the steal instead of masking it with ENOENT.
			if (existsSync(ownerPath)) {
				chmodSync(ownerPath, 0o600);
			}
		}

		// Fail-closed is scoped to the unreadable window, not a permanent lockout:
		// once the record is readable again the ordinary stale-owner path reclaims it
		// (its recorded pid is long gone).
		const lease = await acquireSessionLeaseAsync(sessionPath, agentDir, enabledEnvironment("replacement"));
		expect(lease?.sessionPath).toBe(sessionPath);
		lease?.release();
	});

	it("is inert for direct SDK runtimes unless worker isolation enables it", async () => {
		const agentDir = createTempDir();
		await expect(acquireSessionLeaseAsync(join(agentDir, "session.jsonl"), agentDir, {})).resolves.toBeUndefined();
	});
});
