import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { lockSync } from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireSessionLeaseAsync,
	canonicalSessionPath,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
} from "../src/core/session-lease.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-r31-guard-red-"));
	tempDirs.push(directory);
	return directory;
}

describe("r31 RC-2 guard contention", () => {
	it("keeps the event loop responsive while the guard is held and names the holder pid on failure", async () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "session.jsonl");
		const environment = {
			[SESSION_LEASES_ENABLED_ENV]: "1",
			[SESSION_LEASE_OWNER_ID_ENV]: "holder-marker",
		};
		const lease = await acquireSessionLeaseAsync(sessionPath, agentDir, environment);
		expect(lease).toBeDefined();
		if (!lease) return;

		const canonical = canonicalSessionPath(sessionPath);
		const directory = join(
			agentDir,
			"session-leases",
			`${createHash("sha256").update(canonical).digest("hex")}.lock`,
		);
		const releaseGuard = lockSync(directory, {
			realpath: false,
			lockfilePath: `${directory}.guard`,
			stale: 60_000,
		});

		const ticks: Array<{ scheduled: number; fired: number }> = [];
		let observing = true;
		const observer = (async () => {
			while (observing) {
				const scheduled = Date.now();
				await sleep(10);
				ticks.push({ scheduled, fired: Date.now() });
			}
		})();

		let caught: unknown;
		try {
			await acquireSessionLeaseAsync(sessionPath, agentDir, {
				[SESSION_LEASES_ENABLED_ENV]: "1",
				[SESSION_LEASE_OWNER_ID_ENV]: "second-opener",
			});
		} catch (error) {
			caught = error;
		} finally {
			observing = false;
			await observer;
			releaseGuard();
		}

		expect(caught).toBeInstanceOf(Error);
		const message = (caught as Error).message;
		// Holder attribution: the owner record of the contended lease directory.
		expect(message).toContain(String(process.pid));
		expect(message).toContain("holder-marker");

		// The event loop must keep servicing 10ms timers while the guard retries:
		// a blocked loop starves them (pre-fix: Atomics.wait 100 x 10ms).
		const late = ticks.filter((tick) => tick.fired - tick.scheduled > 50);
		expect(late).toEqual([]);
		expect(ticks.length).toBeGreaterThan(20);
	}, 30_000);
});
