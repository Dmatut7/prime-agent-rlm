/**
 * wave-40 lane E pins for the RLM child run lifecycle.
 *
 * 1. A quota-parked child is paused, not dead: its own wake resumes the task at the
 *    provider's usage reset. The parent's run used to settle the moment the parked
 *    turn ended, classify the quota error stop as the child's death, and deliver a
 *    failure notice - so the parent re-did work the child was about to finish, and
 *    the resumed child later delivered the same result a second time. The run must
 *    stay live while `child.isQuotaParked` and settle only at the real end.
 * 2. The live-child cap checked the admitted runs only after the async admission
 *    round-trip, so two parallel spawns both passed the check on the same count.
 *    An admitted-but-not-yet-registered spawn must hold a cap slot.
 * 3. A child that failed before its session existed never left the active run map,
 *    nailing its name down forever; it settles into the bounded closed records
 *    instead, which frees the name (a re-spawn numbers the successor).
 * 4. `rlm.prune_subagents` could retire a run that had reached a terminal status but
 *    not settled yet, severing its in-flight terminal bookkeeping and freezing a
 *    `settled: false` lie into its closed collect record. Unsettled runs are not
 *    prunable.
 */
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../../src/core/agent-session.js";
import {
	type CustomMessage,
	RLM_CHILD_FAILURE_CUSTOM_TYPE,
	RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
} from "../../src/core/messages.js";
import type { ClosedRlmChildCollectEntry } from "../../src/core/rlm-child-collect.js";
import type { RlmChildRetentionHost } from "../../src/core/rlm-child-retention.js";
import { removeRlmSubagentTracking } from "../../src/core/rlm-child-retention.js";
import { pruneRlmSubagents, type RlmChildRosterHost } from "../../src/core/rlm-child-roster.js";
import { createAgentMessageDeferred, type RlmChildRun } from "../../src/core/rlm-child-run.js";
import type { Settings } from "../../src/core/settings-manager.js";
import { createHarness, type Harness } from "./harness.js";

function messagesOfType(messages: readonly unknown[], customType: string): CustomMessage[] {
	return messages.filter(
		(message): message is CustomMessage =>
			typeof message === "object" &&
			message !== null &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === customType,
	);
}

/** A provider quota failure whose reported reset is an hour out: beyond any wait bound, so the session parks. */
function quotaFailureFarReset(): AssistantMessage {
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "429 You have hit your ChatGPT usage limit",
		}),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind: "rate_limit", status: 429, retryAfterMs: 3_600_000 },
			},
		],
	};
}

/** Child-side retry policy that parks on the first far-reset quota failure and stays parked (the wake is an hour out). */
const parkSettings: Partial<Settings> = {
	stallWatchdog: { enabled: false },
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 1,
		provider: {
			waitForUsage: { baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 5, maxWaitMs: 1_000, maxPauseMs: 3_600_000 },
		},
	},
};

describe("a quota-parked child is paused, not failed", () => {
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

	async function parkedChild(responses: AssistantMessage[]): Promise<{ parent: Harness; child: Harness }> {
		const child = track(await createHarness({ rlmDepth: 1, settings: parkSettings }));
		child.setResponses(responses);
		const parent = track(
			await createHarness({
				rlmDepth: 0,
				rlmMaxDepth: 1,
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async () => ({ session: child.session }),
					deleteRlmSubagentRuntime: async () => {},
				},
			}),
		);
		await parent.session.runRlmChild("do the assigned work", { name: "worker" });
		await vi.waitFor(() => expect(child.session.isQuotaParked).toBe(true), { timeout: 10_000, interval: 20 });
		return { parent, child };
	}

	it("keeps the run live while the child is parked and settles it after the resume", async () => {
		const { parent, child } = await parkedChild([
			quotaFailureFarReset(),
			fauxAssistantMessage("side answer"),
			fauxAssistantMessage("task answer"),
		]);

		// The pause is not a death: no failure notice, and the run still reads as live work.
		expect(messagesOfType(parent.session.messages, RLM_CHILD_FAILURE_CUSTOM_TYPE)).toEqual([]);
		const running = await parent.session.collectRlmChildren(["worker"], 0);
		expect(running.results[0]).toMatchObject({ status: "running", settled: false });
		// The false failure used to land within microseconds of the park; give it every chance.
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(messagesOfType(parent.session.messages, RLM_CHILD_FAILURE_CUSTOM_TYPE)).toEqual([]);
		expect(messagesOfType(parent.session.messages, RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE)).toEqual([]);

		// Quota returns while the child is parked (a side turn completes a model call):
		// the park lifts and the parked task resumes automatically.
		await child.session.prompt("side question");
		await vi.waitFor(
			async () => {
				const collected = await parent.session.collectRlmChildren(["worker"], 0);
				expect(collected.results[0]).toMatchObject({ status: "done", settled: true });
			},
			{ timeout: 10_000, interval: 20 },
		);

		// Exactly one terminal outcome, and it is the real one: the resumed child
		// finished without replying, not a quota failure.
		const collected = await parent.session.collectRlmChildren(["worker"], 0);
		expect(collected.results[0]?.terminal_kind).toBe("completed_without_reply");
		expect(messagesOfType(parent.session.messages, RLM_CHILD_FAILURE_CUSTOM_TYPE)).toEqual([]);
		expect(messagesOfType(parent.session.messages, RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE)).toHaveLength(1);
	});

	it("settles a deleted child whose run is waiting out the park", async () => {
		const { parent } = await parkedChild([quotaFailureFarReset()]);

		const deleted = await parent.session.deleteRlmSubagent("worker");
		expect(deleted.subagent.session_name).toBe("worker");
		await vi.waitFor(
			async () => {
				expect((await parent.session.listRlmSubagents({ includeTerminal: true })).subagents).toEqual([]);
			},
			{ timeout: 10_000, interval: 20 },
		);
		// The delete path owns its own (cancelled) notice; the park must not become a failure report.
		expect(messagesOfType(parent.session.messages, RLM_CHILD_FAILURE_CUSTOM_TYPE)).toEqual([]);
	});
});

describe("the live-child cap counts admissions in flight", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		vi.unstubAllEnvs();
	});

	it("refuses the second of two parallel spawns at cap 1 and releases the slot afterwards", async () => {
		vi.stubEnv("RLM_MAX_CHILDREN", "1");
		const parent = await createHarness({ rlmDepth: 0, rlmMaxDepth: 1 });
		harnesses.push(parent);
		parent.setResponses([fauxAssistantMessage("first child done")]);

		// Both spawns start before either reaches registration: the cap check used to
		// read a count neither had joined yet, so both passed.
		const first = parent.session.runRlmChild("first task", { name: "w1" });
		const second = parent.session.runRlmChild("second task", { name: "w2" });
		await expect(second).rejects.toThrow("RLM subagent limit reached");
		await expect(first).resolves.toMatchObject({ name: "w1" });

		await vi.waitFor(
			async () => {
				const collected = await parent.session.collectRlmChildren(["w1"], 0);
				expect(collected.results[0]?.settled).toBe(true);
			},
			{ timeout: 10_000, interval: 20 },
		);

		// The refused spawn held nothing: once the first child settles the cap admits again.
		parent.appendResponses([fauxAssistantMessage("third child done")]);
		await expect(parent.session.runRlmChild("third task", { name: "w3" })).resolves.toMatchObject({ name: "w3" });
	});
});

describe("a child that failed before its session existed releases its name", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("moves the session-less errored run into the closed records and numbers the re-spawn", async () => {
		const parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					throw new Error("startup failed");
				},
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		harnesses.push(parent);

		await parent.session.runRlmChild("doomed task", { name: "worker" });
		await vi.waitFor(
			async () => {
				const collected = await parent.session.collectRlmChildren(["worker"], 0);
				expect(collected.results[0]).toMatchObject({ status: "error", settled: true });
			},
			{ timeout: 10_000, interval: 20 },
		);

		// No resident session holds the name anymore: the re-spawn is admitted, and the
		// historical-name rule numbers it instead of merging it into the failure's rows.
		const respawn = await parent.session.runRlmChild("retry task", { name: "worker" });
		expect(respawn.name).toBe("worker-2");

		// The failure stays on the audit surfaces through its closed record: collect
		// resolves it, and delete still retires it.
		const collected = await parent.session.collectRlmChildren(["worker"], 0);
		expect(collected.results[0]).toMatchObject({ status: "error", session_name: "worker", settled: true });
		await expect(parent.session.deleteRlmSubagent("worker")).resolves.toMatchObject({
			subagent: { session_name: "worker" },
		});
	});
});

describe("prune skips a terminal run that has not settled", () => {
	type FakeHost = RlmChildRosterHost & RlmChildRetentionHost;

	function fakeHostWithRun(run: RlmChildRun): FakeHost {
		const host: FakeHost = {
			_activeRlmChildRuns: new Map([[run.id, run]]),
			_rlmChildSessions: new Map(),
			_closedRlmChildCollectEntries: new Map(),
			_rlmCollectWaits: new Map(),
			_closedRlmChildrenDaemonScanned: false,
			_deletedRlmChildIds: new Set(),
			_rlmChildCleanupFailures: new Map(),
			_deletingRlmChildren: new Map(),
			_prunedRlmChildIds: new Set(),
			_retiredRlmChildRuns: new Map(),
			_rlmChildUnsubscribes: new Map(),
			_abandonedRlmQuiescenceChildIds: new Set(),
			_disposed: false,
			_disposing: false,
			*_rlmSubtreeSessions(): Generator<AgentSession> {},
			_rlmHistoricalChildNamesNow: () => new Set(),
			_stopRlmChildFollowUpWatch: () => {},
			_watchRlmChildFollowUps: () => {},
			_emit: (_event: AgentSessionEvent) => {},
			_isRlmChildHiddenFromCollect(childId: string, hiddenRun?: RlmChildRun): boolean {
				return (
					hiddenRun?.detachedDeletion !== undefined ||
					host._deletingRlmChildren.has(childId) ||
					host._deletedRlmChildIds.has(childId) ||
					host._rlmChildCleanupFailures.has(childId)
				);
			},
			_rememberClosedRlmChild(childId: string, record: ClosedRlmChildCollectEntry): void {
				host._closedRlmChildCollectEntries.delete(childId);
				host._closedRlmChildCollectEntries.set(childId, record);
			},
			_removeRlmSubagentTracking(childId: string, trackingRun?: RlmChildRun): void {
				removeRlmSubagentTracking(host, childId, trackingRun);
			},
		};
		return host;
	}

	function fakeRun(model: Model<Api>, overrides: { status: RlmChildRun["status"]; settled: boolean }): RlmChildRun {
		return {
			id: "child-1",
			prompt: "do the work",
			sessionName: "worker",
			sessionDir: "/tmp/rlm-child-1",
			model,
			status: overrides.status,
			toolUseCount: 0,
			settled: overrides.settled,
			abort: () => {},
			publication: createAgentMessageDeferred(),
			settlement: createAgentMessageDeferred(),
			deletionReservation: createAgentMessageDeferred(),
		};
	}

	it("refuses the unsettled run and retires it with a truthful record once settled", async () => {
		const faux = registerFauxProvider({ provider: "faux-prune-unit", models: [{ id: "m" }] });
		try {
			const model = faux.getModel() as Model<Api>;
			const run = fakeRun(model, { status: "done", settled: false });
			const host = fakeHostWithRun(run);

			// Untargeted prune: a run whose terminal bookkeeping is still in flight is not eligible.
			await expect(pruneRlmSubagents(host)).resolves.toEqual({ pruned: [] });
			expect(host._activeRlmChildRuns.has(run.id)).toBe(true);
			expect(host._closedRlmChildCollectEntries.has(run.id)).toBe(false);

			// Targeted prune refuses it like a running child.
			await expect(pruneRlmSubagents(host, ["worker"])).rejects.toThrow("has not settled");
			expect(host._activeRlmChildRuns.has(run.id)).toBe(true);

			// Once settled, prune retires it and the closed record says so.
			run.settled = true;
			const pruned = await pruneRlmSubagents(host, ["worker"]);
			expect(pruned.pruned).toHaveLength(1);
			expect(host._closedRlmChildCollectEntries.get(run.id)?.entry.settled).toBe(true);
			expect(host._activeRlmChildRuns.has(run.id)).toBe(false);
			expect(host._prunedRlmChildIds.has(run.id)).toBe(true);
		} finally {
			faux.unregister();
		}
	});
});
