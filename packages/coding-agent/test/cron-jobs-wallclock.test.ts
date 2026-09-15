import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCronJobStore, nextRunAtForSchedule, parseAgentCronSchedule } from "../src/core/cron-jobs.js";

/**
 * The schedule search reads the process's local wall clock, so the DST cases can
 * only be pinned by pinning TZ for the duration of one assertion (Node re-reads
 * TZ for every Date operation). Every helper restores the previous value.
 */
const originalTimeZone = process.env.TZ;

function withTimeZone<T>(timeZone: string, action: () => T): T {
	process.env.TZ = timeZone;
	try {
		return action();
	} finally {
		if (originalTimeZone === undefined) delete process.env.TZ;
		else process.env.TZ = originalTimeZone;
	}
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): { store: AgentCronJobStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "cron-wallclock-"));
	tempDirs.push(dir);
	mkdirSync(dir, { recursive: true });
	return { store: new AgentCronJobStore(join(dir, "cron-jobs.json")), dir };
}

describe("cron wall-clock semantics across DST transitions", () => {
	it("runs a wall time that the zone skips at the first instant after the gap", () => {
		withTimeZone("America/New_York", () => {
			// 2026-03-08: local 02:00 does not exist (01:59 EST -> 03:00 EDT).
			const from = new Date("2026-03-08T00:30:00-05:00");
			const next = parseAgentCronSchedule("0 2 * * *", from).nextRunAt;

			expect(next.getTime()).toBe(new Date("2026-03-08T07:00:00.000Z").getTime());
			expect(next.getHours()).toBe(3);
			// The day is not skipped: the trigger stays inside the transition day.
			expect(next.getDate()).toBe(8);
			// The same expression and minute under another zone must not reuse the entry
			// above: in UTC the 02:00 wall time exists but is already past at that instant
			// (00:30 EST is 05:30 UTC), so the trigger lands on the next day instead.
			process.env.TZ = "UTC";
			const utc = parseAgentCronSchedule("0 2 * * *", new Date("2026-03-08T00:30:00-05:00")).nextRunAt;
			expect(utc.toISOString()).toBe("2026-03-09T02:00:00.000Z");
		});
	});

	it("runs a wall time that occurs twice only once, at the first occurrence", () => {
		withTimeZone("America/New_York", () => {
			// 2026-11-01: local 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST).
			const first = parseAgentCronSchedule("30 1 * * *", new Date("2026-11-01T00:30:00-04:00")).nextRunAt;
			expect(first.getTime()).toBe(new Date("2026-11-01T05:30:00.000Z").getTime());

			// A trigger computed after the first occurrence must move to the next day,
			// not repeat the same wall time an hour later.
			const afterFirst = nextRunAtForSchedule(
				{ kind: "cron", expression: "30 1 * * *" },
				new Date("2026-11-01T05:45:00.000Z"),
			);
			expect(afterFirst?.toISOString()).toBe("2026-11-02T06:30:00.000Z");
		});
	});

	it("keeps ordinary wall-clock schedules unchanged", () => {
		withTimeZone("Asia/Shanghai", () => {
			const from = new Date("2026-09-15T10:00:00+08:00");
			expect(parseAgentCronSchedule("0 9 * * *", from).nextRunAt.toISOString()).toBe("2026-09-16T01:00:00.000Z");
			// 2026-09-16 00:00 and 02:30 local (UTC+8).
			expect(parseAgentCronSchedule("@daily", from).nextRunAt.toISOString()).toBe("2026-09-15T16:00:00.000Z");
			expect(parseAgentCronSchedule("30 2 * * *", from).nextRunAt.toISOString()).toBe("2026-09-15T18:30:00.000Z");
		});
	});
});

describe("cron schedules whose next match is more than a year out", () => {
	it("creates the job and reports the far trigger instead of rejecting it", () => {
		withTimeZone("UTC", () => {
			const from = new Date("2026-09-15T10:00:00.000Z");
			const parsed = parseAgentCronSchedule("0 3 29 2 *", from);
			expect(parsed.schedule).toEqual({ kind: "cron", expression: "0 3 29 2 *" });
			expect(parsed.nextRunAt.toISOString()).toBe("2028-02-29T03:00:00.000Z");
		});
	});

	it("persists such a job through the store", () => {
		withTimeZone("UTC", () => {
			const { store } = makeStore();
			const created = store.create({
				activeSessionId: "session",
				sessionId: "session",
				sessionFile: "/tmp/session.jsonl",
				cwd: "/tmp",
				prompt: "leaf day",
				scheduleText: "0 3 29 2 *",
				now: new Date("2026-09-15T10:00:00.000Z"),
			});
			expect(created.nextRunAt).toBe("2028-02-29T03:00:00.000Z");
			expect(store.list().map((job) => job.nextRunAt)).toEqual(["2028-02-29T03:00:00.000Z"]);
		});
	});

	it("rejects a schedule that never matches, and says so", () => {
		withTimeZone("UTC", () => {
			expect(() => parseAgentCronSchedule("0 0 30 2 *", new Date("2026-09-15T10:00:00.000Z"))).toThrow(
				/never matches/,
			);
		});
	});
});

describe("cron trigger lookup cost", () => {
	it("does not walk minutes across days", () => {
		withTimeZone("UTC", () => {
			const from = new Date("2026-09-15T10:00:00.000Z");
			const schedule = { kind: "cron", expression: "0 0 1 1 *" } as const;
			const iterations = 50;
			// Positive control first: the same call must answer, not throw.
			expect(nextRunAtForSchedule(schedule, from)?.toISOString()).toBe("2027-01-01T00:00:00.000Z");

			const started = process.hrtime.bigint();
			for (let i = 0; i < iterations; i++) nextRunAtForSchedule(schedule, from);
			const perCallMs = Number(process.hrtime.bigint() - started) / 1e6 / iterations;

			// The previous implementation walked local minutes one at a time (~13ms per
			// call for this expression, inside the cron store's cross-process lock).
			expect(perCallMs).toBeLessThan(4);
		});
	});
});
