/**
 * LIVE-1 (r44): a session whose kernel hosts live work must not look idle to the residency
 * policies that would close it. The 90-minute kill chain is
 * kernel facts -> session getter -> summaryForActiveSession -> sessionPassivationSnapshot ->
 * canPassivateSession (child passivation), and the whole-worker eviction variant reads the same
 * summary through the roster, so the kernel term has to survive the summary boundary. The
 * getter itself is pinned here too, including the split that keeps `isSessionActive` (RLM
 * quiescence, goal continuation) turn-level while the summary carries the kernel term.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import {
	canEvictWorker,
	canPassivateSession,
	type SessionPassivationSnapshot,
	type WorkerEvictionSnapshot,
} from "../../src/core/session-action-store.js";
import type { ActiveSessionState } from "../../src/modes/daemon/active-session-state.js";
import { summaryForActiveSession } from "../../src/modes/daemon/daemon-session-list.js";
import { createHarness, type Harness } from "./harness.js";

/** A resident subagent state wrapping a real session, in the shape the daemon snapshots. */
function stateFor(session: AgentSession): ActiveSessionState {
	return {
		activeSessionId: "active-1",
		clients: new Set(),
		lastEventSequence: 0,
		runtime: {
			metadata: { kind: "subagent", parentActiveSessionId: "parent-1", rlmChildId: "child-1" },
			modelFallbackMessage: undefined,
			diagnostics: [],
			session,
		},
	} as unknown as ActiveSessionState;
}

function passivationSnapshot(isSessionActive: boolean): SessionPassivationSnapshot {
	return {
		isSessionActive,
		attachedClients: 0,
		hasRegisteredCronJob: false,
		// Hardcoded so the red hinges on the activity term alone, not on timestamp plumbing.
		lastActivityAt: Date.parse("2026-01-01T00:00:00.000Z"),
		hasParent: true,
		hasNonPassiveDescendants: false,
		isHydrating: false,
	};
}

function workerSnapshot(isSessionActive: boolean): WorkerEvictionSnapshot {
	return {
		lifecycle: "ready",
		isConnected: true,
		isStopping: false,
		hasOwnerClient: false,
		isPreparingUpdateRestart: false,
		hasWakeBlindSchedule: false,
		sessions: [
			{
				isSessionActive,
				attachedClients: 0,
				hasRegisteredCronJob: false,
				lastActivityAt: Date.parse("2026-01-01T00:00:00.000Z"),
			},
		],
	};
}

/** 95 minutes after the (hardcoded) last activity: the shape the 90-minute sweep evaluates. */
const EVICTION_NOW = Date.parse("2026-01-01T01:35:00.000Z");

describe("LIVE-1 kernel-owned work keeps a session resident", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function track(harness: Harness): Harness {
		harnesses.push(harness);
		return harness;
	}

	it("counts live kernel bash handles and an executing cell as work in flight", async () => {
		const live = track(
			await createHarness({
				kernelResidencyFacts: () => ({ hasActiveExecution: false, isKernelBashRunning: true }),
			}),
		);
		expect(live.session.isKernelWorkInFlight).toBe(true);

		const executing = track(
			await createHarness({
				kernelResidencyFacts: () => ({ hasActiveExecution: true, isKernelBashRunning: false }),
			}),
		);
		expect(executing.session.isKernelWorkInFlight).toBe(true);
	});

	it("leaves a session with no kernel work idle, and keeps isSessionActive turn-level", async () => {
		const noKernel = track(await createHarness({ kernelResidencyFacts: () => undefined }));
		const quietKernel = track(
			await createHarness({
				kernelResidencyFacts: () => ({ hasActiveExecution: false, isKernelBashRunning: false }),
			}),
		);
		const live = track(
			await createHarness({
				kernelResidencyFacts: () => ({ hasActiveExecution: false, isKernelBashRunning: true }),
			}),
		);
		expect(noKernel.session.isKernelWorkInFlight).toBe(false);
		expect(quietKernel.session.isKernelWorkInFlight).toBe(false);
		// The split: kernel work is residency evidence, not turn work. RLM quiescence and goal
		// continuation read isSessionActive and must not park behind a background handle.
		expect(noKernel.session.isSessionActive).toBe(false);
		expect(live.session.isSessionActive).toBe(false);
	});

	it("carries the kernel term through the summary, blocking child passivation", async () => {
		const harness = track(
			await createHarness({
				kernelResidencyFacts: () => ({ hasActiveExecution: false, isKernelBashRunning: true }),
			}),
		);
		const summary = summaryForActiveSession(stateFor(harness.session));
		expect(summary.isSessionActive).toBe(true);

		const snapshot = passivationSnapshot(summary.isSessionActive);
		expect(canPassivateSession(snapshot, 90, EVICTION_NOW)).toBe(false);

		// Positive control: the same idle subagent with no kernel work passivates as before.
		const idle = track(await createHarness({ kernelResidencyFacts: () => undefined }));
		const idleSummary = summaryForActiveSession(stateFor(idle.session));
		expect(idleSummary.isSessionActive).toBe(false);
		expect(canPassivateSession(passivationSnapshot(idleSummary.isSessionActive), 90, EVICTION_NOW)).toBe(true);
	});

	it("blocks whole-worker eviction through the same summary", async () => {
		const harness = track(
			await createHarness({
				kernelResidencyFacts: () => ({ hasActiveExecution: false, isKernelBashRunning: true }),
			}),
		);
		const summary = summaryForActiveSession(stateFor(harness.session));
		const worker = workerSnapshot(summary.isSessionActive);
		expect(canEvictWorker(worker, 90, EVICTION_NOW)).toBe(false);

		// Positive control: an all-idle worker with no kernel work is evicted as before.
		const idle = track(await createHarness({ kernelResidencyFacts: () => undefined }));
		const idleSummary = summaryForActiveSession(stateFor(idle.session));
		expect(canEvictWorker(workerSnapshot(idleSummary.isSessionActive), 90, EVICTION_NOW)).toBe(true);
	});
});
