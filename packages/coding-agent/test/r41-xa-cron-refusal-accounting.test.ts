import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentCronJob,
	type AgentCronJobRunResult,
	AgentCronJobStore,
	AgentCronScheduler,
	CRON_DEFER_BACKOFF_CAP_MS,
	CRON_DEFER_ESCALATED_RECHECK_MS,
	CRON_DEFER_FAST_ATTEMPTS,
	CRON_DEFER_MAX_ATTEMPTS,
	CRON_DEFERRED_RETRY_MS,
	CRON_FENCE_RETRY_MS,
} from "../src/core/cron-jobs.js";
import { SessionInputAdmissionPausedError, SessionInputSuspendedError } from "../src/core/prompt-admission.js";

/**
 * r41 XA-1/XA-2: a cron/heartbeat tick that hits an update-restart admission
 * fence must be recorded as deferred, not as a burned run, and the deferred
 * retry cadence must be bounded (fast window -> doubling backoff -> cap ->
 * escalation visibility) instead of spinning at the fast cadence forever.
 *
 * Red guards (each fails against the pre-fix implementation):
 * - A: once + fence -> HEAD records runCount 1 / status completed (never ran).
 * - D: once + parked suspension (typed field says retry succeeds now) ->
 *   HEAD still burns the run: the old allow-list never read the field.
 * - C: recurring + fence -> HEAD records runCount 1 / lastError.
 * - bounded cadence: HEAD has no counter, no backoff, no escalation.
 * Guard B (once + pause lease) is the r40 positive control: its deferral
 * behavior must survive the fix unchanged.
 */

const start = new Date("2026-01-01T12:34:00.000Z");

function jobById(store: AgentCronJobStore, id: string): AgentCronJob {
	const job = store.list().find((candidate) => candidate.id === id);
	if (!job) {
		throw new Error(`job ${id} is not in the store`);
	}
	return job;
}

function makeOnceInput(now: Date) {
	return {
		activeSessionId: "active-1",
		sessionId: "session-1",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp/project",
		scheduleText: "in 1m",
		prompt: "continue the audit",
		source: "cron" as const,
		now,
	};
}

describe("r41 XA: admission-fence refusals defer the tick with a bounded cadence", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeStore(): AgentCronJobStore {
		const dir = mkdtempSync(join(tmpdir(), "prime-agent-r41xa-"));
		tempDirs.push(dir);
		return new AgentCronJobStore(join(dir, "cron-jobs.json"));
	}

	function makeScheduler(
		store: AgentCronJobStore,
		refusal: () => Error | undefined,
	): { scheduler: AgentCronScheduler; setNow: (now: Date) => void; errors: unknown[] } {
		let currentNow = start;
		const errors: unknown[] = [];
		const scheduler = new AgentCronScheduler(store, {
			now: () => currentNow,
			runJob: async () => {
				const error = refusal();
				if (error) {
					throw error;
				}
				return undefined;
			},
			onError: (_job, error) => {
				errors.push(error);
			},
		});
		return {
			scheduler,
			setNow: (now: Date) => {
				currentNow = now;
			},
			errors,
		};
	}

	it("A) once job refused by the update-restart fence defers on the fence cadence instead of completing", async () => {
		const store = makeStore();
		const once = store.create(makeOnceInput(start));
		const { scheduler, setNow, errors } = makeScheduler(
			store,
			() => new SessionInputSuspendedError({ queuedActionCount: 0, suspendedForUpdateRestart: true }),
		);
		const tick = new Date("2026-01-01T12:35:01.000Z");
		setNow(tick);
		const ran = await scheduler.runDue(tick);

		expect(ran).toBe(0);
		expect(errors).toEqual([]);
		const after = jobById(store, once.id);
		expect(after.status).toBe("active");
		expect(after.runCount).toBe(0);
		expect(after.lastRunAt).toBeUndefined();
		expect(after.lastError).toBeUndefined();
		expect(after.lastDeferredAt).toBe("2026-01-01T12:35:01.000Z");
		expect(after.deferCount).toBe(1);
		// Fence tier: restart-aware cadence, not the 5s transient cadence.
		expect(after.nextRunAt).toBe(new Date(tick.getTime() + CRON_FENCE_RETRY_MS).toISOString());
	});

	it("D) once job refused by a parked suspension (retry succeeds now) defers on the transient cadence", async () => {
		const store = makeStore();
		const once = store.create(makeOnceInput(start));
		const { scheduler, setNow, errors } = makeScheduler(
			store,
			() => new SessionInputSuspendedError({ queuedActionCount: 0, suspendedForUpdateRestart: false }),
		);
		const tick = new Date("2026-01-01T12:35:01.000Z");
		setNow(tick);
		const ran = await scheduler.runDue(tick);

		expect(ran).toBe(0);
		expect(errors).toEqual([]);
		const after = jobById(store, once.id);
		expect(after.status).toBe("active");
		expect(after.runCount).toBe(0);
		expect(after.lastRunAt).toBeUndefined();
		expect(after.lastError).toBeUndefined();
		expect(after.lastDeferredAt).toBe("2026-01-01T12:35:01.000Z");
		expect(after.nextRunAt).toBe(new Date(tick.getTime() + CRON_DEFERRED_RETRY_MS).toISOString());
	});

	it("C) recurring heartbeat refused by the fence records neither a run nor an error", async () => {
		const store = makeStore();
		const heartbeat = store.create({
			...makeOnceInput(start),
			scheduleText: "every 30s",
			prompt: "check on me",
			source: "heartbeat",
		});
		const { scheduler, setNow, errors } = makeScheduler(
			store,
			() => new SessionInputSuspendedError({ queuedActionCount: 0, suspendedForUpdateRestart: true }),
		);
		const tick = new Date("2026-01-01T12:35:01.000Z");
		setNow(tick);
		const ran = await scheduler.runDue(tick);

		expect(ran).toBe(0);
		expect(errors).toEqual([]);
		const after = jobById(store, heartbeat.id);
		expect(after.status).toBe("active");
		expect(after.runCount).toBe(0);
		expect(after.lastRunAt).toBeUndefined();
		expect(after.lastError).toBeUndefined();
		expect(after.lastDeferredAt).toBe("2026-01-01T12:35:01.000Z");
		// Recurring: the next slot, no cadence intervention.
		expect(after.nextRunAt).toBe("2026-01-01T12:35:31.000Z");
	});

	it("B) once job refused by a pause lease still defers at the r40 cadence (positive control)", async () => {
		const store = makeStore();
		const once = store.create(makeOnceInput(start));
		const { scheduler, setNow, errors } = makeScheduler(
			store,
			() => new SessionInputAdmissionPausedError({ pausedCount: 1 }),
		);
		const tick = new Date("2026-01-01T12:35:01.000Z");
		setNow(tick);
		const ran = await scheduler.runDue(tick);

		expect(ran).toBe(0);
		expect(errors).toEqual([]);
		const after = jobById(store, once.id);
		expect(after.status).toBe("active");
		expect(after.runCount).toBe(0);
		expect(after.lastRunAt).toBeUndefined();
		expect(after.lastError).toBeUndefined();
		expect(after.lastDeferredAt).toBe("2026-01-01T12:35:01.000Z");
		expect(after.deferCount).toBe(1);
		expect(after.nextRunAt).toBe(new Date(tick.getTime() + CRON_DEFERRED_RETRY_MS).toISOString());
	});

	it("a plain failure is still recorded as a run (the fence predicate is not over-broad)", async () => {
		const store = makeStore();
		const once = store.create(makeOnceInput(start));
		const { scheduler, setNow, errors } = makeScheduler(store, () => new Error("kernel exploded"));
		const tick = new Date("2026-01-01T12:35:01.000Z");
		setNow(tick);
		const ran = await scheduler.runDue(tick);

		expect(ran).toBe(1);
		expect(errors.length).toBe(1);
		const after = jobById(store, once.id);
		expect(after.status).toBe("completed");
		expect(after.runCount).toBe(1);
		expect(after.lastRunAt).toBe("2026-01-01T12:35:01.000Z");
		expect(after.lastError).toBe("kernel exploded");
	});

	it("consecutive deferrals back off, cap, escalate, and never complete the once job", async () => {
		// Write-amplification bound: one recordDispatchResult (one store write) per
		// deferral, counted through the public store API.
		class CountingStore extends AgentCronJobStore {
			recordCount = 0;
			recordDispatchResult(dispatchId: string, result: Parameters<AgentCronJobStore["recordDispatchResult"]>[1]) {
				this.recordCount += 1;
				return super.recordDispatchResult(dispatchId, result);
			}
		}
		const dir = mkdtempSync(join(tmpdir(), "prime-agent-r41xa-count-"));
		tempDirs.push(dir);
		const store = new CountingStore(join(dir, "cron-jobs.json"));
		const once = store.create(makeOnceInput(start));
		const { scheduler, setNow } = makeScheduler(
			store,
			() => new SessionInputAdmissionPausedError({ pausedCount: 1 }),
		);
		const cadences: number[] = [];
		let tick = new Date("2026-01-01T12:35:01.000Z");
		let lastNext = tick.getTime();
		for (let i = 0; i < 12; i += 1) {
			setNow(tick);
			expect(await scheduler.runDue(tick)).toBe(0);
			const after = jobById(store, once.id);
			const next = new Date(after.nextRunAt ?? "invalid").getTime();
			expect(Number.isFinite(next)).toBe(true);
			const cadence = next - tick.getTime();
			if (cadence >= 0) {
				cadences.push(cadence);
			}
			expect(after.deferCount).toBe(i + 1);
			// Escalation is visibility, not a fuse: the once job stays scheduled.
			expect(after.status).toBe("active");
			expect(after.runCount).toBe(0);
			lastNext = next;
			tick = new Date(next);
		}
		expect(store.recordCount).toBeLessThanOrEqual(12 + 1);

		// Fast attempts, then doubling backoff capped at CRON_DEFER_BACKOFF_CAP_MS.
		expect(cadences.slice(0, CRON_DEFER_FAST_ATTEMPTS)).toEqual(
			Array.from({ length: CRON_DEFER_FAST_ATTEMPTS }, () => CRON_DEFERRED_RETRY_MS),
		);
		expect(cadences.slice(CRON_DEFER_FAST_ATTEMPTS, CRON_DEFER_FAST_ATTEMPTS + 6)).toEqual([
			10_000,
			20_000,
			40_000,
			80_000,
			160_000,
			CRON_DEFER_BACKOFF_CAP_MS,
		]);
		// Pre-escalation cadences are all capped; the escalated entries (below) are
		// the hourly re-check instead.
		expect(cadences.slice(0, -2).every((cadence) => cadence <= CRON_DEFER_BACKOFF_CAP_MS)).toBe(true);
		expect(cadences.at(-2)).toBe(CRON_DEFER_ESCALATED_RECHECK_MS);
		expect(cadences.at(-1)).toBe(CRON_DEFER_ESCALATED_RECHECK_MS);

		// The chain age (15m) crossed before the count limit: the escalation
		// stamps lastError and re-checks hourly while the job stays active.
		const after = jobById(store, once.id);
		expect(after.lastError).toMatch(/Deferred \d+ times since/);
		expect(after.status).toBe("active");
		expect(after.nextRunAt).toBe(new Date(lastNext).toISOString());

		// The count limit still escalates a recurring job whose defers come fast
		// (healthy cadence, no write amplification to dampen).
		const recStore = makeStore();
		const heartbeat = recStore.create({
			...makeOnceInput(start),
			scheduleText: "every 30s",
			prompt: "check on me",
			source: "heartbeat",
		});
		const recHarness = makeScheduler(recStore, () => new SessionInputAdmissionPausedError({ pausedCount: 1 }));
		let recTick = new Date("2026-01-01T12:35:00.000Z");
		for (let i = 0; i < CRON_DEFER_MAX_ATTEMPTS; i += 1) {
			recHarness.setNow(recTick);
			expect(await recHarness.scheduler.runDue(recTick)).toBe(0);
			const recAfter = jobById(recStore, heartbeat.id);
			recTick = new Date(recAfter.nextRunAt ?? "invalid");
		}
		const recAfter = jobById(recStore, heartbeat.id);
		expect(recAfter.deferCount).toBe(CRON_DEFER_MAX_ATTEMPTS);
		expect(recAfter.lastError).toMatch(/Deferred \d+ times since/);
		expect(recAfter.status).toBe("active");
		expect(recAfter.runCount).toBe(0);
	});

	it("a run or skip resets the deferral chain (count and cadence start over)", async () => {
		const store = makeStore();
		const heartbeat = store.create({
			...makeOnceInput(start),
			scheduleText: "every 30s",
			prompt: "check on me",
			source: "heartbeat",
		});
		let refuse = true;
		const { scheduler, setNow } = makeScheduler(store, () =>
			refuse ? new SessionInputAdmissionPausedError({ pausedCount: 1 }) : undefined,
		);

		const first = new Date("2026-01-01T12:35:01.000Z");
		setNow(first);
		expect(await scheduler.runDue(first)).toBe(0);
		const deferredOnce = jobById(store, heartbeat.id);
		expect(deferredOnce.deferCount).toBe(1);
		expect(deferredOnce.lastDeferredAt).toBe("2026-01-01T12:35:01.000Z");

		// The window releases: the tick runs and clears the deferral chain.
		refuse = false;
		const second = new Date("2026-01-01T12:35:31.000Z");
		setNow(second);
		expect(await scheduler.runDue(second)).toBe(1);
		const ran = jobById(store, heartbeat.id);
		expect(ran.runCount).toBe(1);
		expect(ran.deferCount).toBeUndefined();
		expect(ran.deferredSince).toBeUndefined();

		// A later refusal starts a fresh chain, not a continuation.
		refuse = true;
		const third = new Date("2026-01-01T12:36:01.000Z");
		setNow(third);
		expect(await scheduler.runDue(third)).toBe(0);
		const fresh = jobById(store, heartbeat.id);
		expect(fresh.deferCount).toBe(1);
		expect(fresh.lastDeferredAt).toBe("2026-01-01T12:36:01.000Z");
		expect(fresh.deferredSince).toBe("2026-01-01T12:36:01.000Z");
	});

	it("reads deferral fields tolerantly: present, absent, and corrupt records", () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-agent-r41xa-compat-"));
		tempDirs.push(dir);
		const storePath = join(dir, "cron-jobs.json");
		const baseJob = {
			id: "job-compat",
			status: "active" as const,
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			prompt: "compat",
			schedule: { kind: "once" as const, expression: "in 1m" },
			createdAt: "2026-01-01T12:00:00.000Z",
			updatedAt: "2026-01-01T12:00:00.000Z",
			nextRunAt: "2026-01-01T12:35:00.000Z",
			runCount: 0,
		};
		// Well-formed new fields survive a round trip.
		writeFileSync(
			storePath,
			JSON.stringify({
				jobs: [
					{
						...baseJob,
						deferCount: 2,
						lastDeferredAt: "2026-01-01T12:30:00.000Z",
						deferredSince: "2026-01-01T12:30:00.000Z",
					},
				],
			}),
		);
		const wellFormed = new AgentCronJobStore(storePath).list();
		expect(wellFormed).toHaveLength(1);
		expect(wellFormed[0]?.deferCount).toBe(2);
		// A record without the new fields reads as a fresh chain (old store shape).
		writeFileSync(storePath, JSON.stringify({ jobs: [baseJob] }));
		const legacy = new AgentCronJobStore(storePath).list();
		expect(legacy).toHaveLength(1);
		expect(legacy[0]?.deferCount).toBeUndefined();
		expect(legacy[0]?.lastDeferredAt).toBeUndefined();
		// Ill-typed new fields degrade to "no chain" instead of dropping the job.
		writeFileSync(
			storePath,
			JSON.stringify({ jobs: [{ ...baseJob, deferCount: "x", lastDeferredAt: 7, deferredSince: false }] }),
		);
		const corrupt = new AgentCronJobStore(storePath).list();
		expect(corrupt).toHaveLength(1);
		expect(corrupt[0]?.deferCount).toBeUndefined();
		expect(corrupt[0]?.lastDeferredAt).toBeUndefined();
		expect(corrupt[0]?.deferredSince).toBeUndefined();
	});

	it("a wall-clock step back between the deferral write and the re-arm cannot stretch the 5s retry", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T12:34:00.000Z"));
		let scheduler: AgentCronScheduler | undefined;
		try {
			const dir = mkdtempSync(join(tmpdir(), "prime-agent-r41xa-clock-"));
			tempDirs.push(dir);
			// The scheduler wall clock steps back 30 minutes right after the deferral
			// write lands and before the scheduler re-arms for the retry (an NTP
			// correction inside the same tick). The deferral's nextRunAt is honest wall
			// time (5s ahead of the pre-step wall); only the step-compensated schedule
			// base keeps the arm at the real 5s instead of 30m05s.
			let wallMs = new Date("2026-01-01T12:34:00.000Z").getTime();
			let steppedBack = false;
			const store = new (class extends AgentCronJobStore {
				recordDispatchResult(
					dispatchId: string,
					result: { now?: Date; outcome: AgentCronJobRunResult; error?: unknown },
				): AgentCronJob | undefined {
					const updated = super.recordDispatchResult(dispatchId, result);
					if (updated !== undefined && result.outcome === "deferred" && !steppedBack) {
						steppedBack = true;
						wallMs -= 30 * 60_000;
					}
					return updated;
				}
			})(join(dir, "cron-jobs.json"));
			const once = store.create(makeOnceInput(new Date("2026-01-01T12:34:00.000Z")));
			let refused = false;
			scheduler = new AgentCronScheduler(store, {
				now: () => new Date(wallMs),
				runJob: async () => {
					if (refused) return undefined;
					refused = true;
					throw new SessionInputAdmissionPausedError({ pausedCount: 1 });
				},
			});
			scheduler.start();
			// The once job is due at 12:35:00; the wall clock reads 12:35:01 when the
			// tick fires and defers.
			wallMs = new Date("2026-01-01T12:35:01.000Z").getTime();
			await vi.advanceTimersByTimeAsync(61_000);
			const deferred = jobById(store, once.id);
			expect(deferred.status).toBe("active");
			expect(deferred.runCount).toBe(0);
			expect(deferred.nextRunAt).toBe("2026-01-01T12:35:06.000Z");
			// The retry still fires after the real 5s, not 30 minutes later.
			await vi.advanceTimersByTimeAsync(CRON_DEFERRED_RETRY_MS);
			const completed = jobById(store, once.id);
			expect(completed.status).toBe("completed");
			expect(completed.runCount).toBe(1);
		} finally {
			scheduler?.stop();
			vi.useRealTimers();
		}
	});
});
