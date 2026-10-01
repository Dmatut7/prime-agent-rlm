/**
 * W9-A (agent-223, finding 6): restoring a quota park whose wake already passed.
 *
 * A park whose resumeAt elapsed while the session was down is left to the durable
 * wake job - but when that job is gone (artifact store lost, or never persisted),
 * the parked task silently never resumed: no log, no transcript record. The restore
 * now records a provider_quota_resume { outcome: "wake-lost" } entry and warns when
 * the wake is definitely gone. A wake the user cancelled stays quiet (their choice),
 * and a live job still owns the wake with no record.
 *
 * The same change persists wakeRetries on re-arm entries, so a restart no longer
 * resets the QUOTA_WAKE_MAX_RETRIES budget.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Settings } from "../../../src/core/settings-manager.js";
import { createHarness, type Harness } from "../harness.js";

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

function resumeOutcomes(harness: Harness): Array<Record<string, unknown>> {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "provider_quota_resume")
		.map((entry) => (entry as { data?: Record<string, unknown> }).data ?? {});
}

async function parkSession(settings: Partial<Settings>): Promise<Harness> {
	const harness = await createHarness({ persistSession: true, settings });
	harness.sessionManager.materializeSessionFile();
	harness.setResponses([quotaFailure({ retryAfterMs: 3_600_000 })]);
	await harness.session.prompt("do the work");
	await harness.session.waitForIdle();
	return harness;
}

describe("W9-A quota park restore with a lost wake", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("records a wake-lost resume entry when the expired park's durable wake job is gone", async () => {
		// maxPauseMs caps the park at 50ms, so the park is expired by the time the
		// restart below restores it. dispose() (not cleanup, which would remove the
		// session file) kills the in-process wake timer; the durable job and the
		// park entries survive on disk.
		const parked = await parkSession(parkSettings(50));
		harnesses.push(parked);
		expect(parked.session.isQuotaParked).toBe(true);
		const sessionFile = parked.session.sessionFile;
		if (!sessionFile) throw new Error("expected a persisted session");
		const artifactDir = parked.sessionManager.getSessionArtifactDir()!;
		parked.session.dispose();
		// The durable wake job is lost (artifact store damage), and the park's wake
		// time passes before the restart.
		rmSync(join(artifactDir, "scheduled-jobs.json"), { force: true });
		await new Promise((resolve) => setTimeout(resolve, 80));

		const restarted = await createHarness({ existingSessionFile: sessionFile, settings: parkSettings(50) });
		harnesses.push(restarted);

		expect(restarted.session.isQuotaParked).toBe(false);
		const outcomes = resumeOutcomes(restarted);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ outcome: "wake-lost", parkCount: 1, provider: "faux" });
	});

	it("records nothing when the expired park's durable wake job still exists", async () => {
		const parked = await parkSession(parkSettings(50));
		harnesses.push(parked);
		const sessionFile = parked.session.sessionFile;
		if (!sessionFile) throw new Error("expected a persisted session");
		parked.session.dispose();
		await new Promise((resolve) => setTimeout(resolve, 80));

		const restarted = await createHarness({ existingSessionFile: sessionFile, settings: parkSettings(50) });
		harnesses.push(restarted);

		// The job survives, so the daemon still fires it: the restore stays quiet.
		expect(restarted.session.isQuotaParked).toBe(false);
		expect(resumeOutcomes(restarted)).toHaveLength(0);
	});

	it("persists wakeRetries on a re-arm so a restart cannot reset the wake budget", async () => {
		// maxPauseMs 60ms: the in-process wake fires on its own, with admission
		// paused so the marker is refused and the park re-arms (wakeRetries: 1).
		const parked = await parkSession(parkSettings(60));
		harnesses.push(parked);
		const pause = parked.session.acquireSessionInputPause();
		try {
			await new Promise((resolve) => setTimeout(resolve, 200));
		} finally {
			pause.release();
		}
		const parkEntries = parked.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "provider_quota_park")
			.map((entry) => (entry as { data?: Record<string, unknown> }).data ?? {});
		expect(parkEntries.length).toBe(2);
		expect(parkEntries[1]).toMatchObject({ parkCount: 1, wakeRetries: 1 });

		const sessionFile = parked.session.sessionFile;
		if (!sessionFile) throw new Error("expected a persisted session");
		parked.session.dispose();
		const restarted = await createHarness({ existingSessionFile: sessionFile, settings: parkSettings(60_000) });
		harnesses.push(restarted);
		expect(restarted.session.isQuotaParked).toBe(true);
		type QuotaParkInternals = { _quotaPark: { wakeRetries?: number } | undefined };
		// test-hygiene-allow: no public read seam for the restored wake budget; the write side is pinned via the persisted entries above (same probe shape as the grandfathered park tests in agent-session-retry-events.test.ts).
		const restoredPark = (restarted.session as unknown as QuotaParkInternals)._quotaPark;
		expect(restoredPark?.wakeRetries).toBe(1);
	});
});
