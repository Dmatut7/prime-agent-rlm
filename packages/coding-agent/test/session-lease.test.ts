import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lockSync } from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireSessionLease,
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

	it("rejects a second live owner with a typed active-session error", () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "session.jsonl");
		const first = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident-a"));

		expect(() => acquireSessionLease(sessionPath, agentDir, enabledEnvironment("owned-b"))).toThrow(
			SessionAlreadyActiveError,
		);
		try {
			acquireSessionLease(sessionPath, agentDir, enabledEnvironment("owned-b"));
		} catch (error) {
			expect(error).toMatchObject({
				code: "session_already_active",
				activeSessionId: "resident-a",
				sessionPath: canonicalSessionPath(sessionPath),
			});
		}

		first?.release();
		const second = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("owned-b"));
		expect(second?.sessionPath).toBe(canonicalSessionPath(sessionPath));
		second?.release();
	});

	it("lets an interactive launch force leases without a daemon owner id", () => {
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
			acquireSessionLease(sessionPath, agentDir, environment);
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
		const lease = acquireSessionLease(sessionPath, agentDir, environment);
		expect(lease?.sessionPath).toBe(sessionPath);
		lease?.release();
	});

	it("keeps an actively held in-process lease conflicting", () => {
		// A live SessionLease in this process (e.g. an in-process RLM child
		// runtime) must still conflict even under the same pid and owner
		// identity; only leaked leases are reclaimable.
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "held.jsonl");
		const environment = enabledEnvironment("held-owner");
		const first = acquireSessionLease(sessionPath, agentDir, environment);
		expect(first).toBeDefined();
		expect(() => acquireSessionLease(sessionPath, agentDir, environment)).toThrow(SessionAlreadyActiveError);
		first?.release();
		const second = acquireSessionLease(sessionPath, agentDir, environment);
		expect(second?.sessionPath).toBe(canonicalSessionPath(sessionPath));
		second?.release();
	});

	it("reclaims a lease owned by this process instead of deadlocking on itself", () => {
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

		const lease = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("self-session"));
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

	it("reclaims a lease whose owner process is gone", () => {
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

		const lease = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("replacement"));
		expect(lease?.sessionPath).toBe(sessionPath);
		lease?.release();
	});

	it("reports guard contention as a coordination failure", () => {
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
				acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident-a"));
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

	it("treats symlink aliases as the same persisted session", () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "session.jsonl");
		const aliasPath = join(agentDir, "session-alias.jsonl");
		writeFileSync(sessionPath, "");
		symlinkSync(sessionPath, aliasPath);
		const first = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident-a"));

		expect(() => acquireSessionLease(aliasPath, agentDir, enabledEnvironment("owned-b"))).toThrow(
			SessionAlreadyActiveError,
		);
		first?.release();
	});

	it("reclaims a lease after its pid has been reused", () => {
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

		const lease = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("replacement"));
		expect(lease?.sessionPath).toBe(sessionPath);
		lease?.release();
	});

	it("is inert for direct SDK runtimes unless worker isolation enables it", () => {
		const agentDir = createTempDir();
		expect(acquireSessionLease(join(agentDir, "session.jsonl"), agentDir, {})).toBeUndefined();
	});
});
