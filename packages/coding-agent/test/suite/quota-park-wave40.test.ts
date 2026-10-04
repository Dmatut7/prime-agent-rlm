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
 *
 * Follow-up pins (audit F1 + domain-7):
 * - a restart after the in-process timer took the wake over (durable job
 *   cancelled by the timer, probe in flight) must not read the takeover as a
 *   user cancellation: the park is restored with its count and re-woken;
 * - the update-restart abort cascade is not a user abort: a parked child whose
 *   wake probe is aborted by it keeps the park (wake re-armed), with no
 *   "user-aborted" record.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCronJobStore, QUOTA_WAKE_TIMER_CANCEL_ORIGIN } from "../../src/core/cron-jobs.js";
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

/** Store over the harness session's artifact file, mirroring the session's own. */
function sessionStore(harness: Harness): AgentCronJobStore {
	const artifactDir = harness.sessionManager.getSessionArtifactDir();
	if (!artifactDir) throw new Error("expected an artifact dir");
	const store = AgentCronJobStore.forSessionArtifacts();
	store.registerSessionArtifact(harness.session.sessionId, artifactDir);
	return store;
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

describe("a user abort of an unrelated turn keeps a future-scheduled park", () => {
	it("Esc while parked for hours does not cancel the pending wake", async () => {
		const parked = await parkSession(parkSettings(3_600_000));
		expect(parked.session.isQuotaParked).toBe(true);
		// The user keeps driving the parked session; the wake is an hour out and the
		// turn they abort is theirs, not the wake probe.
		parked.setResponses([() => new Promise<never>(() => {})]);
		void parked.session.prompt("a question while parked");
		await waitFor(() => parked.eventsOfType("agent_start").length >= 2, "the new turn to start");

		parked.session.requestAbort({ reason: "user" });
		await parked.session.waitForIdle();

		expect(parked.session.isQuotaParked).toBe(true);
		expect(resumeOutcomes(parked)).toEqual([]);
	});
});

describe("a skipped or errored durable wake is not a delivery", () => {
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

describe("restart after the in-process timer took the wake over", () => {
	it("restores the park with its count instead of reading the takeover as a user cancellation", async () => {
		const parked = await parkSession(parkSettings(60));
		expect(parked.session.isQuotaParked).toBe(true);
		const jobId = parkEntries(parked).at(-1)?.jobId;
		if (typeof jobId !== "string") throw new Error("expected a durable wake job on the park entry");
		// The wake fires while the probe turn hangs: the in-process timer cancels the
		// durable job and owns the resume. A restart in this window must not read the
		// timer's takeover as the user cancelling the wake.
		parked.setResponses([() => new Promise<never>(() => {})]);
		await waitFor(() => parked.eventsOfType("agent_start").length >= 2, "the wake probe turn to start");
		const takenOver = sessionStore(parked)
			.list()
			.find((job) => job.id === jobId);
		if (takenOver?.status !== "cancelled") throw new Error("the wake timer did not take over the durable job");
		expect(takenOver.cancelledBy).toBe(QUOTA_WAKE_TIMER_CANCEL_ORIGIN);
		const sessionFile = parked.session.sessionFile;
		if (!sessionFile) throw new Error("expected a persisted session");
		parked.session.dispose();
		await new Promise((resolve) => setTimeout(resolve, 80));

		const restarted = await createHarness({ existingSessionFile: sessionFile, settings: parkSettings(60) });
		harnesses.push(restarted);

		expect(restarted.session.isQuotaParked).toBe(true);
		// The restored wake drives at once; the probe hits the still-exhausted quota
		// and re-parks with the episode count continued, not reset.
		restarted.setResponses([quotaFailure({ retryAfterMs: 3_600_000 })]);
		await waitFor(
			() => parkEntries(restarted).some((entry) => entry.parkCount === 2),
			"the re-park with parkCount 2",
		);
	});

	it("a wake the user cancelled before the restart still ends the episode (due-past branch)", async () => {
		const parked = await parkSession(parkSettings(60));
		expect(parked.session.isQuotaParked).toBe(true);
		const jobId = parkEntries(parked).at(-1)?.jobId;
		if (typeof jobId !== "string") throw new Error("expected a durable wake job on the park entry");
		// The user cancels the wake (a plain cancel, no machine origin) before the
		// timer fires; the live session honors it, then the wake time passes while
		// the session is down.
		sessionStore(parked).cancel(jobId);
		await waitFor(() => !parked.session.isQuotaParked, "the live session to honor the user cancellation");
		const sessionFile = parked.session.sessionFile;
		if (!sessionFile) throw new Error("expected a persisted session");
		parked.session.dispose();

		const restarted = await createHarness({ existingSessionFile: sessionFile, settings: parkSettings(60) });
		harnesses.push(restarted);

		expect(restarted.session.isQuotaParked).toBe(false);
		expect(parkEntries(restarted)).toHaveLength(1);
		expect(resumeOutcomes(restarted)).toEqual([]);
	});

	it("a wake the user cancelled while parked still ends the episode (future branch)", async () => {
		const parked = await parkSession(parkSettings(3_600_000));
		expect(parked.session.isQuotaParked).toBe(true);
		const jobId = parkEntries(parked).at(-1)?.jobId;
		if (typeof jobId !== "string") throw new Error("expected a durable wake job on the park entry");
		sessionStore(parked).cancel(jobId);
		const sessionFile = parked.session.sessionFile;
		if (!sessionFile) throw new Error("expected a persisted session");
		parked.session.dispose();

		const restarted = await createHarness({ existingSessionFile: sessionFile, settings: parkSettings(60) });
		harnesses.push(restarted);

		expect(restarted.session.isQuotaParked).toBe(false);
		expect(parkEntries(restarted)).toHaveLength(1);
		expect(resumeOutcomes(restarted)).toEqual([]);
	});
});

describe("an update-restart cascade abort of a parked child's wake probe", () => {
	it("is not a user abort: the park survives with its wake re-armed, and no user-aborted record lands", async () => {
		const child = await createHarness({ persistSession: true, settings: parkSettings(60) });
		harnesses.push(child);
		child.sessionManager.materializeSessionFile();
		child.setResponses([quotaFailure({ retryAfterMs: 3_600_000 })]);
		await child.session.prompt("child task work");
		await child.session.waitForIdle();
		expect(child.session.isQuotaParked).toBe(true);
		const parksBefore = parkEntries(child).length;

		// The wake probe turn hangs so the cascade has something to abort.
		child.setResponses([() => new Promise<never>(() => {})]);
		await waitFor(() => child.eventsOfType("agent_start").length >= 2, "the child wake probe turn to start");

		const parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		harnesses.push(parent);
		await parent.session.runRlmChild("more work", { name: "worker" });

		parent.session.abortForUpdateRestart();
		// The cascade is synchronous: the reason stamp is visible before the aborted
		// turn's message_end (and before any later agent_start clears it).
		expect(child.session.lastTurnAbortReason).toBe("update_restart");
		await waitFor(() => !child.session.isStreaming, "the cascade to stop the child probe turn");

		// Not the user taking the session back: the park survives and the wake is
		// re-armed (one more park entry carrying the retry budget), with no
		// user-aborted record that a restart would read as the end of the episode.
		expect(child.session.isQuotaParked).toBe(true);
		expect(resumeOutcomes(child)).toEqual([]);
		expect(parkEntries(child).length).toBe(parksBefore + 1);
		expect(parkEntries(child).at(-1)).toEqual(expect.objectContaining({ parkCount: 1, wakeRetries: 1 }));
	});
});
