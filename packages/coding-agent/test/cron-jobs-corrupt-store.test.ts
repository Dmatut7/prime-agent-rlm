import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentCronDispatch,
	AgentCronJobStore,
	AgentCronScheduler,
	CRON_STORE_FAILURE_RETRY_MS,
	SESSION_SCHEDULED_JOBS_FILENAME,
} from "../src/core/cron-jobs.js";

const start = new Date("2026-01-01T12:34:00.000Z");
const dueAt = new Date("2026-01-01T12:35:00.000Z");

const tempDirs: string[] = [];

afterEach(() => {
	setLogSink(undefined);
	vi.useRealTimers();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "prime-agent-cron-corrupt-"));
	tempDirs.push(dir);
	return dir;
}

interface TwoSessionFixture {
	root: string;
	store: AgentCronJobStore;
	goodFile: string;
	badFile: string;
	goodJobId: string;
	badJobId: string;
}

/** Two registered sessions, one due job each, then session-bad's store file is wrecked. */
function makeCorruptFixture(corruptContent = '{"jobs": [{"id": "half-writ'): TwoSessionFixture {
	const root = makeTempDir();
	const goodDir = join(root, "session-artifacts", "session-good");
	const badDir = join(root, "session-artifacts", "session-bad");
	mkdirSync(goodDir, { recursive: true, mode: 0o700 });
	mkdirSync(badDir, { recursive: true, mode: 0o700 });
	const store = AgentCronJobStore.forSessionArtifacts();
	store.registerSessionArtifact("session-good", goodDir);
	store.registerSessionArtifact("session-bad", badDir);
	const goodJob = store.create({
		activeSessionId: "active-good",
		sessionId: "session-good",
		sessionFile: join(root, "sessions", "session-good.jsonl"),
		cwd: root,
		scheduleText: "in 1m",
		prompt: "keep the good session going",
		now: start,
	});
	const badJob = store.create({
		activeSessionId: "active-bad",
		sessionId: "session-bad",
		sessionFile: join(root, "sessions", "session-bad.jsonl"),
		cwd: root,
		scheduleText: "in 1m",
		prompt: "keep the bad session going",
		now: start,
	});
	const badFile = join(badDir, SESSION_SCHEDULED_JOBS_FILENAME);
	writeFileSync(badFile, corruptContent);
	return {
		root,
		store,
		goodFile: join(goodDir, SESSION_SCHEDULED_JOBS_FILENAME),
		badFile,
		goodJobId: goodJob.id,
		badJobId: badJob.id,
	};
}

function captureLogs(): LogEntry[] {
	const entries: LogEntry[] = [];
	setLogSink((entry) => {
		entries.push(entry);
	});
	return entries;
}

describe("AgentCronJobStore with one corrupt session store file", () => {
	it("costs that session its jobs and nothing else", () => {
		const fixture = makeCorruptFixture();
		const logs = captureLogs();

		// Pre-fix this throws straight out of the read path, which is how one wrecked
		// file took every session's scheduling down with it.
		const listed = fixture.store.list();
		expect(listed.map((job) => job.id)).toEqual([fixture.goodJobId]);
		expect(fixture.store.nextActiveRunAt()?.toISOString()).toBe(dueAt.toISOString());
		expect(fixture.store.due(dueAt).map((job) => job.id)).toEqual([fixture.goodJobId]);

		const warned = logs.filter((entry) => entry.level === "warn" && String(entry.path ?? "") === fixture.badFile);
		expect(warned.length).toBeGreaterThan(0);
		// The file stays corrupt across every tick, so the report has to be deduplicated:
		// one incident, one line, not one line per read.
		fixture.store.list();
		fixture.store.due(dueAt);
		expect(
			logs.filter((entry) => entry.level === "warn" && String(entry.path ?? "") === fixture.badFile),
		).toHaveLength(warned.length);
		// The prompt text of a half-written file is not ours to spread into the logs.
		expect(JSON.stringify(warned[0])).not.toContain("half-writ");
	});

	it("claims the healthy session's job while the corrupt one stays out of the way", () => {
		const fixture = makeCorruptFixture();
		captureLogs();

		const claimed: AgentCronDispatch[] = fixture.store.claimDue(dueAt, dueAt);
		expect(claimed.map((dispatch) => dispatch.job.id)).toEqual([fixture.goodJobId]);
	});

	it("leaves the corrupt bytes alone: a read path does not destroy data", () => {
		const corruptContent = '{"jobs": [{"id": "half-writ';
		const fixture = makeCorruptFixture(corruptContent);
		captureLogs();

		fixture.store.list();
		fixture.store.nextActiveRunAt();

		expect(readFileSync(fixture.badFile, "utf-8")).toBe(corruptContent);
	});

	it("heals the file on the next write to that session", () => {
		const fixture = makeCorruptFixture();
		captureLogs();

		const created = fixture.store.create({
			activeSessionId: "active-bad",
			sessionId: "session-bad",
			sessionFile: join(fixture.root, "sessions", "session-bad.jsonl"),
			cwd: fixture.root,
			scheduleText: "in 2m",
			prompt: "replace the wrecked state",
			now: start,
		});

		const healed = JSON.parse(readFileSync(fixture.badFile, "utf-8")) as { jobs: Array<{ id: string }> };
		expect(healed.jobs.map((job) => job.id)).toEqual([created.id]);
	});

	it("treats a JSON document that is not an object the same way", () => {
		// Valid JSON, wrong shape: `parsed.jobs` on an array or a number is either
		// undefined or a TypeError, and neither may take the healthy session down.
		const fixture = makeCorruptFixture("[1,2,3]");
		const logs = captureLogs();

		expect(fixture.store.list().map((job) => job.id)).toEqual([fixture.goodJobId]);
		expect(fixture.store.nextActiveRunAt()?.toISOString()).toBe(dueAt.toISOString());
		expect(
			logs.filter((entry) => entry.level === "warn" && String(entry.path ?? "") === fixture.badFile).length,
		).toBeGreaterThan(0);
	});
});

/** A store whose read path fails outright: the shape a wedged lock or dead directory presents. */
class FlakyStore extends AgentCronJobStore {
	failing = true;

	constructor() {
		super(undefined, true);
	}

	override nextActiveRunAt(): Date | undefined {
		if (this.failing) {
			throw new Error("store file unreadable");
		}
		return super.nextActiveRunAt();
	}

	override claimDue(due?: Date, claimed?: Date): AgentCronDispatch[] {
		if (this.failing) {
			throw new Error("store file unreadable");
		}
		return super.claimDue(due, claimed);
	}
}

describe("AgentCronScheduler against a store that cannot be read", () => {
	it("never disarms: it keeps ticking and picks the jobs up once the store answers", async () => {
		vi.useFakeTimers();
		const root = makeTempDir();
		const artifactDir = join(root, "session-artifacts", "session-flaky");
		mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
		const store = new FlakyStore();
		store.registerSessionArtifact("session-flaky", artifactDir);
		store.failing = false;
		const job = store.create({
			activeSessionId: "active-flaky",
			sessionId: "session-flaky",
			sessionFile: join(root, "sessions", "session-flaky.jsonl"),
			cwd: root,
			scheduleText: "in 1m",
			prompt: "survive the outage",
			now: start,
		});
		store.failing = true;

		const logs = captureLogs();
		const prompts: string[] = [];
		const scheduler = new AgentCronScheduler(store, {
			now: () => dueAt,
			runJob: async (dueJob) => {
				prompts.push(dueJob.prompt);
				return undefined;
			},
		});

		// Pre-fix start() throws here (scheduleNext dies before arming a timer), and even
		// a scheduler that survived would never tick again.
		scheduler.start();
		await vi.advanceTimersByTimeAsync(CRON_STORE_FAILURE_RETRY_MS + 1000);
		expect(
			logs.filter((entry) => entry.level === "warn" && String(entry.msg).includes("cron")).length,
		).toBeGreaterThan(0);
		expect(prompts).toEqual([]);

		store.failing = false;
		await vi.advanceTimersByTimeAsync(CRON_STORE_FAILURE_RETRY_MS + 1000);

		expect(prompts).toEqual(["survive the outage"]);
		expect(store.list().map((entry) => entry.id)).toEqual([job.id]);
		scheduler.stop();
	});
});
