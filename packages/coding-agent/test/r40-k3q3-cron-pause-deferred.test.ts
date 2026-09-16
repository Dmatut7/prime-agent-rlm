import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentCronJob,
	AgentCronJobStore,
	AgentCronScheduler,
	CRON_DEFERRED_RETRY_MS,
} from "../src/core/cron-jobs.js";
import { SessionInputAdmissionPausedError, SessionInputCoalescingError } from "../src/core/prompt-admission.js";

/**
 * r40 K3Q-3: a cron/heartbeat tick that lands in a retryable admission window
 * must not burn a run. QP-2 refuses admission with
 * SessionInputAdmissionPausedError (an MCP reload, an ACP stop, an
 * update-restart teardown holds a pause lease) and QP-3 refuses a same-key
 * admission with SessionInputCoalescingError while its owner is committing.
 * Both are typed, both carry retryable: true, and both fire before anything is
 * queued or delivered - exactly what daemon-mode's runCronJob sees when a tick
 * hits the window. The dispatch must be deferred (no runCount, no lastRunAt,
 * no lastError, lastSkippedAt stamped) and a once job must stay scheduled for
 * its retry instead of being completed as if it had run.
 */

const start = new Date("2026-01-01T12:34:00.000Z");

function jobById(store: AgentCronJobStore, id: string): AgentCronJob {
	const job = store.list().find((candidate) => candidate.id === id);
	if (!job) {
		throw new Error(`job ${id} is not in the store`);
	}
	return job;
}

describe("r40 K3Q-3: retryable admission refusals defer the tick instead of burning a run", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeStore(): AgentCronJobStore {
		const dir = mkdtempSync(join(tmpdir(), "prime-agent-cron-"));
		tempDirs.push(dir);
		return new AgentCronJobStore(join(dir, "cron-jobs.json"));
	}

	function makeScheduler(
		store: AgentCronJobStore,
		refusal: () => Error | undefined,
	): { scheduler: AgentCronScheduler; setNow: (now: Date) => void } {
		let currentNow = start;
		const scheduler = new AgentCronScheduler(store, {
			now: () => currentNow,
			runJob: async () => {
				const error = refusal();
				if (error) {
					throw error;
				}
				return undefined;
			},
		});
		return {
			scheduler,
			setNow: (now: Date) => {
				currentNow = now;
			},
		};
	}

	it("records a pause-window tick as a deferral, not a run, and keeps the once job scheduled", async () => {
		const store = makeStore();
		const heartbeat = store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 30s",
			prompt: "check on me",
			source: "heartbeat",
			now: start,
		});
		const once = store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1m",
			prompt: "continue the audit",
			now: start,
		});
		const { scheduler, setNow } = makeScheduler(
			store,
			() => new SessionInputAdmissionPausedError({ pausedCount: 1 }),
		);

		const tick = new Date("2026-01-01T12:35:01.000Z");
		setNow(tick);
		const ran = await scheduler.runDue(tick);

		expect(ran).toBe(0);
		const hbAfter = jobById(store, heartbeat.id);
		expect(hbAfter.status).toBe("active");
		expect(hbAfter.runCount).toBe(0);
		expect(hbAfter.lastRunAt).toBeUndefined();
		expect(hbAfter.lastError).toBeUndefined();
		expect(hbAfter.lastDeferredAt).toBe("2026-01-01T12:35:01.000Z");
		expect(hbAfter.nextRunAt).toBe("2026-01-01T12:35:31.000Z");

		const onceAfter = jobById(store, once.id);
		expect(onceAfter.status).toBe("active");
		expect(onceAfter.runCount).toBe(0);
		expect(onceAfter.lastRunAt).toBeUndefined();
		expect(onceAfter.lastError).toBeUndefined();
		expect(onceAfter.lastDeferredAt).toBe("2026-01-01T12:35:01.000Z");
		expect(onceAfter.deferCount).toBe(1);
		expect(onceAfter.nextRunAt).toBe(new Date(tick.getTime() + CRON_DEFERRED_RETRY_MS).toISOString());
	});

	it("records a committing-window refusal the same way", async () => {
		const store = makeStore();
		const once = store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1m",
			prompt: "continue the audit",
			now: start,
		});
		const { scheduler, setNow } = makeScheduler(
			store,
			() => new SessionInputCoalescingError({ queueKey: "heartbeat:job-1", ownerActionId: "action-1" }),
		);

		const tick = new Date("2026-01-01T12:35:00.000Z");
		setNow(tick);
		const ran = await scheduler.runDue(tick);

		expect(ran).toBe(0);
		const onceAfter = jobById(store, once.id);
		expect(onceAfter.status).toBe("active");
		expect(onceAfter.runCount).toBe(0);
		expect(onceAfter.lastRunAt).toBeUndefined();
		expect(onceAfter.lastError).toBeUndefined();
		expect(onceAfter.lastDeferredAt).toBe("2026-01-01T12:35:00.000Z");
		expect(onceAfter.nextRunAt).toBe(new Date(tick.getTime() + CRON_DEFERRED_RETRY_MS).toISOString());
	});

	it("still runs the deferred jobs once the window releases (positive control)", async () => {
		const store = makeStore();
		const heartbeat = store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 30s",
			prompt: "check on me",
			source: "heartbeat",
			now: start,
		});
		const once = store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1m",
			prompt: "continue the audit",
			now: start,
		});
		let paused = true;
		const { scheduler, setNow } = makeScheduler(store, () =>
			paused ? new SessionInputAdmissionPausedError({ pausedCount: 1 }) : undefined,
		);

		const pausedTick = new Date("2026-01-01T12:35:01.000Z");
		setNow(pausedTick);
		expect(await scheduler.runDue(pausedTick)).toBe(0);

		paused = false;
		const onceTick = new Date("2026-01-01T12:35:07.000Z");
		setNow(onceTick);
		expect(await scheduler.runDue(onceTick)).toBe(1);

		const onceAfter = jobById(store, once.id);
		expect(onceAfter.status).toBe("completed");
		expect(onceAfter.runCount).toBe(1);
		expect(onceAfter.lastRunAt).toBe("2026-01-01T12:35:07.000Z");
		expect(onceAfter.lastError).toBeUndefined();
		expect(onceAfter.lastDeferredAt).toBe("2026-01-01T12:35:01.000Z");
		expect(onceAfter.deferCount).toBeUndefined();

		const heartbeatTick = new Date("2026-01-01T12:35:35.000Z");
		setNow(heartbeatTick);
		expect(await scheduler.runDue(heartbeatTick)).toBe(1);

		const hbAfter = jobById(store, heartbeat.id);
		expect(hbAfter.status).toBe("active");
		expect(hbAfter.runCount).toBe(1);
		expect(hbAfter.lastRunAt).toBe("2026-01-01T12:35:35.000Z");
		expect(hbAfter.lastError).toBeUndefined();
		expect(hbAfter.lastDeferredAt).toBe("2026-01-01T12:35:01.000Z");
		expect(hbAfter.deferCount).toBeUndefined();
		expect(hbAfter.nextRunAt).toBe("2026-01-01T12:36:05.000Z");
	});
});
