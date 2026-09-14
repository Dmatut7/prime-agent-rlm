import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { sleepSync } from "../src/utils/sleep.js";

/**
 * The settings and auth backends back off between lock retries with a synchronous sleep, because
 * their callers cannot be made async. That sleep used to be `while (Date.now() - start < delayMs)`:
 * an unbounded spin whose only exit condition was the wall clock moving forward. A clock corrected
 * backwards inside the spin (NTP after a sleeping laptop, a manual change, container/host skew)
 * leaves that condition true forever, and the spinning caller owns the event loop, so the process
 * stops responding and never reaches its next retry or its error.
 *
 * The rollback case runs in a child process on purpose: the failure mode is "never returns", so an
 * in-process assertion could not report the regression, only hang the suite. The child holds the
 * locks the callers need, shifts its wall clock backwards, and reports how long each caller took.
 */

const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const fixturePath = resolve(__dirname, "fixtures/sync-sleep-clock-rollback-fixture.ts");

interface RollbackReport {
	wallClockShiftMs: number;
	wallClockReads: number;
	settings: { outcome: string; elapsedMs: number };
	auth: { outcome: string; elapsedMs: number };
	sleep: { outcome: string; elapsedMs: number };
}

describe("sleepSync", () => {
	it("waits the requested delay", () => {
		const started = performance.now();
		sleepSync(30);
		const elapsedMs = performance.now() - started;

		expect(elapsedMs).toBeGreaterThanOrEqual(25);
		expect(elapsedMs).toBeLessThan(1_000);
	});

	/**
	 * The blocking wait is the idle path, not the only path. A host that refuses
	 * `Atomics.wait` on this thread (the constructor succeeds, the call throws) has to
	 * fall back to something that still waits: the iteration cap is a backstop against a
	 * clock that never advances, and reading it as the sleep's actual length turns every
	 * caller's lock backoff into "retry immediately" - measured at 11-29ms for a
	 * requested 200ms, at the price of 10000 thrown exceptions.
	 */
	it("still waits its delay on a host that refuses the blocking wait", () => {
		const waitSpy = vi.spyOn(Atomics, "wait").mockImplementation(() => {
			throw new Error("Atomics.wait is not permitted on this thread");
		});
		try {
			const started = performance.now();
			sleepSync(200);
			const elapsedMs = performance.now() - started;

			// Red today: ~11ms and 10000 refused calls.
			expect(elapsedMs).toBeGreaterThanOrEqual(150);
			expect(elapsedMs).toBeLessThan(2_000);
			// One refused attempt per call, not one per loop iteration.
			expect(waitSpy.mock.calls.length).toBeLessThanOrEqual(2);
		} finally {
			waitSpy.mockRestore();
		}

		// Positive control: with the blocking wait back, the sleep is still accurate.
		const after = performance.now();
		sleepSync(50);
		expect(performance.now() - after).toBeGreaterThanOrEqual(40);
	});

	it("returns from a held-lock retry after the wall clock jumps backwards", () => {
		const result = spawnSync(process.execPath, [tsxPath, fixturePath], {
			cwd: resolve(__dirname, ".."),
			env: { ...process.env, TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json") },
			encoding: "utf8",
			timeout: 30_000,
		});

		// A caller that never returns is killed by the timeout, which is the regression this test
		// exists for: the contention below is real, so the caller's only way out is its sleep. The
		// child's own stderr goes into the failure message, because a killed probe prints nothing.
		expect(result.error, `probe stderr: ${result.stderr}`).toBeUndefined();
		expect(result.status, `probe stderr: ${result.stderr}`).toBe(0);
		const report = JSON.parse(result.stdout.trim()) as RollbackReport;
		expect(report.wallClockShiftMs).toBe(3_600_000);
		expect(report.wallClockReads).toBeGreaterThan(3);

		// Both backends exhaust their retries against the held lock and give up, on time.
		expect(report.settings.outcome).toBe("ELOCKED");
		expect(report.auth.outcome).toBe("ELOCKED");
		expect(report.settings.elapsedMs).toBeLessThan(2_000);
		expect(report.auth.elapsedMs).toBeLessThan(2_000);

		// And the sleep itself still waits for its delay while the wall clock runs backwards.
		expect(report.sleep.outcome).toBe("returned");
		expect(report.sleep.elapsedMs).toBeGreaterThanOrEqual(30);
		expect(report.sleep.elapsedMs).toBeLessThan(1_000);
	});
});
