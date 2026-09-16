import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCronJobStore, AgentCronScheduler } from "../../src/core/cron-jobs.js";

/**
 * Exit-hygiene fixture: arms the scheduler with a job far in the future (the arm clamps
 * to the 24.8-day setTimeout ceiling) and then lets the script end. An armed timer that
 * keeps the event loop referenced keeps this process alive until the arm fires.
 */
const root = join(tmpdir(), `r41-cron-unref-${Math.random().toString(36).slice(2)}`);
mkdirSync(root, { recursive: true });
try {
	const store = new AgentCronJobStore(join(root, "cron-jobs.json"));
	store.create({
		activeSessionId: "active-1",
		sessionId: "session-1",
		sessionFile: join(root, "sessions", "session-1.jsonl"),
		cwd: root,
		scheduleText: "in 100d",
		prompt: "far future arm",
		now: new Date(),
	});
	const scheduler = new AgentCronScheduler(store, {
		runJob: async () => "ran" as const,
	});
	scheduler.start();
	console.log("armed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
