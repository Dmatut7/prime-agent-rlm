/**
 * wave-40 lane H: quota-park lifecycle fixes.
 *
 * - early wake re-arms: a wake fired before its time (a wall-clock step-back
 *   after the timer was armed) used to consume the only in-process timer and
 *   leave the park asleep forever;
 * - sleep catch-up: a host sleep pauses the wake timer's countdown, so an
 *   overdue park is noticed by a periodic wall-clock check instead of waiting
 *   out the full original delay after the machine wakes;
 * - a user Esc during the wake probe cancels the park instead of re-arming it
 *   (the task used to auto-resume 60s after the user stopped it);
 * - a wake whose durable job was skipped or errored is not "delivered": the
 *   prompt never ran, so the in-process wake owns the resume;
 * - a failed park-record write no longer wedges the session in "retrying";
 * - a restart with the wake overdue and the durable job alive restores the
 *   park with its parkCount, so waitForUsage.maxParks survives restarts.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCronJobStore } from "../../src/core/cron-jobs.js";
import { createQuotaResumeJob, resolveQuotaResumeJob } from "../../src/core/quota-park.js";
import type { Settings } from "../../src/core/settings-manager.js";
import { createHarness, type Harness } from "./harness.js";

function quotaFailure(options?: { retryAfterMs?: number }): AssistantMessage {
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "429 You have hit your ChatGPT usage limit",
		}),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: {
					kind: "rate_limit",
					status: 429,
					...(options?.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
				},
			},
		],
	};
}

const parkSettings = (maxPauseMs: number): Partial<Settings> => ({
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 1,
		provider: {
			waitForUsage: { baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 5, maxWaitMs: 1_000, maxPauseMs },
		},
	},
});

function parkEntries(harness: Harness): Array<Record<string, unknown>> {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "provider_quota_park")
		.map((entry) => (entry as { data?: Record<string, unknown> }).data ?? {});
}

function resumeOutcomes(harness: Harness): Array<Record<string, unknown>> {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "provider_quota_resume")
		.map((entry) => (entry as { data?: Record<string, unknown> }).data ?? {});
}

async function parkSession(settings: Partial<Settings>): Promise<Harness> {
	const harness = await createHarness({ persistSession: true, settings });
	harnesses.push(harness);
	harness.sessionManager.materializeSessionFile();
	harness.setResponses([quotaFailure({ retryAfterMs: 3_600_000 })]);
	await harness.session.prompt("do the work");
	await harness.session.waitForIdle();
	return harness;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timed out waiting for ${what}`);
}

const harnesses: Harness[] = [];

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

describe("early wake re-arms instead of dropping the park", () => {
	it("a wake fired before its time (wall clock stepped back) re-arms for the remainder", async () => {
		const harness = await createHarness({ persistSession: true, settings: parkSettings(400) });
		harnesses.push(harness);
		harness.sessionManager.materializeSessionFile();
		harness.setResponses([quotaFailure({ retryAfterMs: 3_600_000 })]);
		vi.useFakeTimers();
		try {
			const done = harness.session.prompt("do the work");
			for (let i = 0; i < 200 && !harness.session.isQuotaParked; i++) {
				await vi.advanceTimersByTimeAsync(20);
			}
			if (!harness.session.isQuotaParked) throw new Error("session did not park");
			await done;

			// The wall clock steps back after the wake timer was armed: when the
			// timer fires, the park is not due yet.
			vi.setSystemTime(Date.now() - 10_000);
			await vi.advanceTimersByTimeAsync(410);
			expect(harness.session.isQuotaParked).toBe(true);

			// The re-armed wake still fires once the remaining wall time has passed.
			harness.setResponses([fauxAssistantMessage("resumed after the clock step")]);
			await vi.advanceTimersByTimeAsync(11_000);
			const texts = harness.session.messages.map((message) => JSON.stringify(message)).join("\n");
			expect(texts).toContain("<provider_quota_resumed>");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("host sleep catch-up", () => {
	it("a periodic wall-clock check fires an overdue wake whose timer is still counting down", async () => {
		const harness = await createHarness({ persistSession: true, settings: parkSettings(3_600_000) });
		harnesses.push(harness);
		harness.sessionManager.materializeSessionFile();
		harness.setResponses([quotaFailure({ retryAfterMs: 3_600_000 })]);
		vi.useFakeTimers();
		try {
			const done = harness.session.prompt("do the work");
			for (let i = 0; i < 400 && !harness.session.isQuotaParked; i++) {
				await vi.advanceTimersByTimeAsync(20);
			}
			if (!harness.session.isQuotaParked) throw new Error("session did not park");
			await done;

			// The host sleeps two hours: Date.now() jumps past the wake time while
			// the wake timer's countdown stays frozen.
			vi.setSystemTime(Date.now() + 2 * 3_600_000);
			harness.setResponses([fauxAssistantMessage("resumed after sleep")]);
			// One clock-check interval is enough to notice the overdue wake; the
			// original one-hour timer is still far from firing.
			await vi.advanceTimersByTimeAsync(61_000);
			const texts = harness.session.messages.map((message) => JSON.stringify(message)).join("\n");
			expect(texts).toContain("<provider_quota_resumed>");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a user abort during the wake probe cancels the park", () => {
	it("does not re-arm the wake after the user presses Esc", async () => {
		const parked = await parkSession(parkSettings(60));
		expect(parked.session.isQuotaParked).toBe(true);
		const parksBefore = parkEntries(parked).length;
		// The wake probe turn hangs so the user has something to abort.
		parked.setResponses([() => new Promise<never>(() => {})]);
		await waitFor(() => parked.eventsOfType("agent_start").length >= 2, "the wake probe turn to start");

		parked.session.requestAbort({ reason: "user" });
		await parked.session.waitForIdle();

		expect(parked.session.isQuotaParked).toBe(false);
		expect(resumeOutcomes(parked)).toEqual([expect.objectContaining({ outcome: "user-aborted" })]);
		expect(parkEntries(parked)).toHaveLength(parksBefore);
	});
});

describe("a skipped or errored durable wake is not a delivery", () => {
	function sessionStore(harness: Harness): AgentCronJobStore {
		const artifactDir = harness.sessionManager.getSessionArtifactDir();
		if (!artifactDir) throw new Error("expected an artifact dir");
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(harness.session.sessionId, artifactDir);
		return store;
	}

	it("a skipped once job does not count as delivered", async () => {
		const harness = await parkSession(parkSettings(3_600_000));
		const jobId = createQuotaResumeJob(harness.session, Date.now() + 60_000);
		if (!jobId) throw new Error("expected a durable wake job");
		const store = sessionStore(harness);
		const [dispatch] = store.claimDue(new Date(Date.now() + 120_000), new Date());
		if (!dispatch) throw new Error("expected the job to be due");
		store.recordDispatchResult(dispatch.id, { outcome: "skipped" });

		expect(resolveQuotaResumeJob(harness.session, jobId)).toBe("gone");
	});

	it("an errored run does not count as delivered", async () => {
		const harness = await parkSession(parkSettings(3_600_000));
		const jobId = createQuotaResumeJob(harness.session, Date.now() + 60_000);
		if (!jobId) throw new Error("expected a durable wake job");
		const store = sessionStore(harness);
		const [dispatch] = store.claimDue(new Date(Date.now() + 120_000), new Date());
		if (!dispatch) throw new Error("expected the job to be due");
		store.recordDispatchResult(dispatch.id, { outcome: "ran", error: new Error("dispatch blew up") });

		expect(resolveQuotaResumeJob(harness.session, jobId)).toBe("gone");
	});

	it("a clean run still counts as delivered", async () => {
		const harness = await parkSession(parkSettings(3_600_000));
		const jobId = createQuotaResumeJob(harness.session, Date.now() + 60_000);
		if (!jobId) throw new Error("expected a durable wake job");
		const store = sessionStore(harness);
		const [dispatch] = store.claimDue(new Date(Date.now() + 120_000), new Date());
		if (!dispatch) throw new Error("expected the job to be due");
		store.recordDispatchResult(dispatch.id, { outcome: "ran" });

		expect(resolveQuotaResumeJob(harness.session, jobId)).toBe("delivered");
	});
});

describe("a failed park-record write does not wedge the session in retrying", () => {
	it("the turn still ends and the in-memory park survives", async () => {
		const harness = await createHarness({ persistSession: true, settings: parkSettings(50) });
		harnesses.push(harness);
		harness.sessionManager.materializeSessionFile();
		const original = harness.sessionManager.appendCustomEntry.bind(harness.sessionManager);
		vi.spyOn(harness.sessionManager, "appendCustomEntry").mockImplementation((customType, data) => {
			if (customType === "provider_quota_park") throw new Error("disk full");
			return original(customType, data);
		});
		harness.setResponses([quotaFailure({ retryAfterMs: 3_600_000 })]);

		await harness.session.prompt("do the work").catch(() => undefined);
		await harness.session.waitForIdle();

		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.isQuotaParked).toBe(true);
		expect(harness.eventsOfType("agent_end").length).toBeGreaterThan(0);
	});
});

describe("restart restores the park with its count when the durable wake survived", () => {
	it("the re-park after the restored wake continues the episode count", async () => {
		const parked = await parkSession(parkSettings(50));
		expect(parked.session.isQuotaParked).toBe(true);
		const sessionFile = parked.session.sessionFile;
		if (!sessionFile) throw new Error("expected a persisted session");
		parked.session.dispose();
		await new Promise((resolve) => setTimeout(resolve, 80));

		const restarted = await createHarness({ existingSessionFile: sessionFile, settings: parkSettings(50) });
		harnesses.push(restarted);

		// The wake time passed while the session was down and the durable job is
		// still there: the park is back, and its wake drives at once.
		expect(restarted.session.isQuotaParked).toBe(true);
		// The wake probe hits the still-exhausted quota and re-parks: the count
		// continues the episode instead of restarting at 1.
		restarted.setResponses([quotaFailure({ retryAfterMs: 3_600_000 })]);
		await waitFor(
			() => parkEntries(restarted).some((entry) => entry.parkCount === 2),
			"the re-park with parkCount 2",
		);
	});
});
