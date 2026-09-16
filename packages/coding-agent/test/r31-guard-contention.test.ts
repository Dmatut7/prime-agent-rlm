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

		const contentionStartMs = Date.now();
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
		const contentionMs = Date.now() - contentionStartMs;

		expect(caught).toBeInstanceOf(Error);
		const message = (caught as Error).message;
		// Holder attribution: the owner record of the contended lease directory.
		expect(message).toContain(String(process.pid));
		expect(message).toContain("holder-marker");

		// The event loop must keep servicing 10ms timers while the guard retries
		// (pre-fix: Atomics.wait 100 x 10ms blocked the loop for the whole ~1s
		// budget and starved them). Every bound is derived from the contention
		// window this run actually measured, so a loaded runner that stretches all
		// the timers cannot fake either direction:
		// 1. the full 100 x 10ms retry budget must elapse contending - load only
		//    stretches this, an early give-up shrinks it below half;
		// 2. at most 5% of the observed beats may fire >500ms late, and no single
		//    beat may be starved for the whole budget. The pre-fix block left ~2
		//    ticks with one ~1s late, which fails both.
		expect(contentionMs).toBeGreaterThanOrEqual(500);
		const late = ticks.filter((tick) => tick.fired - tick.scheduled > 500);
		expect(late.length).toBeLessThanOrEqual(Math.floor(ticks.length / 20));
		const maxLatenessMs = Math.max(0, ...ticks.map((tick) => tick.fired - tick.scheduled));
		expect(maxLatenessMs).toBeLessThan(1000);
	}, 30_000);
});
