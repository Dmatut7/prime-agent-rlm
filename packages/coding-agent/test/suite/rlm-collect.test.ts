/**
 * Typed fan-in for direct RLM children (`rlm.collect`), hand-ported from upstream
 * PR #2223 and extended with this fork's terminal-classification facts.
 *
 * Red at HEAD (pinned sha, pristine tree): `AgentSession` had no
 * `collectRlmChildren` and `rlm-runtime.ts` exported no `rlm.collect` handler, so
 * a parent's only fan-in was steering messages, files, or rate-limited roster
 * reads - and none of them could tell a watchdog kill from a child that finished
 * without replying.
 *
 * The fork-specific rows are the ones asserting `terminal_kind` / `stall_abort`:
 * upstream's envelope stops at `status`, which reports "done" for a child the
 * stall watchdog killed.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RlmSpawnHandle } from "../../src/core/rlm-runtime.js";
import {
	clampRlmCollectWaitMs,
	createRlmCollectHostHandler,
	RLM_COLLECT_WAIT_MARGIN_MS,
} from "../../src/core/rlm-runtime.js";
import { createHarness, type Harness } from "./harness.js";

const hangTool: AgentTool = {
	name: "hang_forever",
	label: "Hang Forever",
	description: "A tool that never returns",
	parameters: Type.Object({}),
	execute: () => new Promise<never>(() => {}),
};

/** Bound for a wait that must not block: generous enough for a slow CI box. */
const NON_BLOCKING_BUDGET_MS = 2_000;

describe("rlm.collect typed fan-in", () => {
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

	async function spawn(options: {
		name: string;
		responses: FauxResponseStep[];
		tools?: AgentTool[];
		warnAfterSeconds?: number;
		abortAfterSeconds?: number;
		parent?: Harness;
	}): Promise<{ parent: Harness; child: Harness; handle: RlmSpawnHandle }> {
		const child = track(
			await createHarness({
				tools: options.tools,
				settings: {
					stallWatchdog: {
						enabled: true,
						warnAfterSeconds: options.warnAfterSeconds ?? 30,
						abortAfterSeconds: options.abortAfterSeconds ?? 60,
					},
					retry: { enabled: false },
				},
				agentMessageController: {
					listAgents: () => ({ agents: [] }),
					sendAgentMessage: vi.fn(async () => {
						throw new Error("synthesized terminal notices must not use agent_message");
					}),
				},
			}),
		);
		child.setResponses(options.responses);
		const parent = options.parent ?? (await makeParent([child]));
		const handle = await parent.session.runRlmChild("do the assigned work", { name: options.name });
		return { parent, child, handle };
	}

	/** A parent whose subagent runtime host hands out the given child sessions by name. */
	async function makeParent(children: Harness[], names?: string[]): Promise<Harness> {
		const byName = new Map<string, Harness>();
		children.forEach((child, index) => {
			byName.set(names?.[index] ?? child.session.sessionName ?? `child-${index}`, child);
		});
		let next = 0;
		return track(
			await createHarness({
				rlmDepth: 0,
				rlmMaxDepth: 1,
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async (runtimeOptions) => {
						const named = byName.get(runtimeOptions.sessionName);
						const child = named ?? children[next++];
						if (!child) throw new Error(`no fixture child for ${runtimeOptions.sessionName}`);
						return { session: child.session };
					},
					deleteRlmSubagentRuntime: async () => {},
				},
			}),
		);
	}

	it("returns a settled typed envelope for a completed child", async () => {
		const { parent, handle } = await spawn({
			name: "worker-a",
			responses: [fauxAssistantMessage("child answer: 42")],
		});

		const collected = await parent.session.collectRlmChildren([handle.rlm_child_id], 20_000);
		expect(collected.results).toHaveLength(1);
		const entry = collected.results[0]!;
		expect(entry.rlm_child_id).toBe(handle.rlm_child_id);
		expect(entry.session_name).toBe("worker-a");
		expect(entry.session_dir).toBe(handle.session_dir);
		expect(entry.status).toBe("done");
		expect(entry.settled).toBe(true);
		expect(entry.answer_preview).toContain("child answer: 42");
		expect(entry.error).toBeUndefined();
		expect(entry.duration_ms).toBeGreaterThanOrEqual(0);
		// The child never sent a reply, so the terminal path classified it as the
		// fourth state - the fact upstream's envelope cannot express.
		expect(entry.terminal_kind).toBe("completed_without_reply");
		expect(entry.terminal_reason).toContain("without sending a reply");
		expect(entry.stall_abort).toBeUndefined();
	});

	it("collects every direct child when no targets are given", async () => {
		const first = track(
			await createHarness({
				settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } },
				agentMessageController: { listAgents: () => ({ agents: [] }), sendAgentMessage: vi.fn() },
			}),
		);
		const second = track(
			await createHarness({
				settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } },
				agentMessageController: { listAgents: () => ({ agents: [] }), sendAgentMessage: vi.fn() },
			}),
		);
		first.setResponses([fauxAssistantMessage("first answer")]);
		second.setResponses([fauxAssistantMessage("second answer")]);
		const parent = await makeParent([first, second], ["worker-a", "worker-b"]);

		const firstHandle = await parent.session.runRlmChild("first task", { name: "worker-a" });
		const secondHandle = await parent.session.runRlmChild("second task", { name: "worker-b" });

		const collected = await parent.session.collectRlmChildren([], 20_000);
		const ids = collected.results.map((entry) => entry.rlm_child_id).sort();
		expect(ids).toEqual([firstHandle.rlm_child_id, secondHandle.rlm_child_id].sort());
		expect(collected.results).toHaveLength(2);
		expect(collected.results.every((entry) => entry.settled && entry.status === "done")).toBe(true);
		const previews = collected.results.map((entry) => entry.answer_preview ?? "").sort();
		expect(previews).toEqual(["first answer", "second answer"]);
	});

	it("re-collects a settled child after terminal cleanup moved it out of the active map", async () => {
		const { parent, child, handle } = await spawn({
			name: "worker-a",
			responses: [fauxAssistantMessage("child answer: 42")],
		});

		const settled = await parent.session.collectRlmChildren([handle.rlm_child_id], 20_000);
		expect(settled.results[0]?.settled).toBe(true);
		// Positive control for the retained-candidate merge: the terminal path drops
		// a settled run from the active map, so a collect that only read that map
		// would report the child as gone.
		await vi.waitFor(() => expect(parent.session.getRlmChildRunStatus(handle.rlm_child_id)).toBeUndefined(), {
			timeout: 10_000,
			interval: 20,
		});

		const byId = await parent.session.collectRlmChildren([handle.rlm_child_id], 0);
		expect(byId.results).toHaveLength(1);
		expect(byId.results[0]?.rlm_child_id).toBe(handle.rlm_child_id);
		expect(byId.results[0]?.status).toBe("done");
		expect(byId.results[0]?.settled).toBe(true);
		expect(byId.results[0]?.answer_preview).toContain("child answer");
		expect(byId.results[0]?.terminal_kind).toBe("completed_without_reply");

		const byName = await parent.session.collectRlmChildren(["worker-a"], 0);
		expect(byName.results[0]?.rlm_child_id).toBe(handle.rlm_child_id);

		const bySessionId = await parent.session.collectRlmChildren([child.session.sessionId], 0);
		expect(bySessionId.results[0]?.rlm_child_id).toBe(handle.rlm_child_id);

		const all = await parent.session.collectRlmChildren([], 0);
		expect(all.results.map((entry) => entry.rlm_child_id)).toContain(handle.rlm_child_id);
	});

	it("returns only the selected child from a targeted collect", async () => {
		const first = track(
			await createHarness({
				settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } },
				agentMessageController: { listAgents: () => ({ agents: [] }), sendAgentMessage: vi.fn() },
			}),
		);
		const second = track(
			await createHarness({
				settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } },
				agentMessageController: { listAgents: () => ({ agents: [] }), sendAgentMessage: vi.fn() },
			}),
		);
		first.setResponses([fauxAssistantMessage("first answer")]);
		second.setResponses([fauxAssistantMessage("second answer")]);
		const parent = await makeParent([first, second], ["worker-a", "worker-b"]);
		const firstHandle = await parent.session.runRlmChild("first task", { name: "worker-a" });
		const secondHandle = await parent.session.runRlmChild("second task", { name: "worker-b" });
		await parent.session.collectRlmChildren([], 20_000);

		const targeted = await parent.session.collectRlmChildren([firstHandle.rlm_child_id], 0);
		expect(targeted.results.map((entry) => entry.rlm_child_id)).toEqual([firstHandle.rlm_child_id]);
		const byName = await parent.session.collectRlmChildren(["worker-b"], 0);
		expect(byName.results.map((entry) => entry.rlm_child_id)).toEqual([secondHandle.rlm_child_id]);
	});

	it("returns current snapshots on timeout without rejecting or cancelling the child", async () => {
		const { parent, handle } = await spawn({
			name: "worker-a",
			responses: [fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" })],
			tools: [hangTool],
		});
		await vi.waitFor(() => expect(parent.session.hasRunningRlmChildren()).toBe(true), {
			timeout: 10_000,
			interval: 20,
		});

		const started = Date.now();
		const collected = await parent.session.collectRlmChildren([handle.rlm_child_id], 150);
		const waited = Date.now() - started;

		expect(waited).toBeLessThan(10_000);
		expect(collected.results).toHaveLength(1);
		expect(collected.results[0]?.rlm_child_id).toBe(handle.rlm_child_id);
		expect(collected.results[0]?.settled).toBe(false);
		expect(["queued", "running"]).toContain(collected.results[0]?.status);
		expect(collected.results[0]?.terminal_kind).toBeUndefined();
		// The child is inside its hanging tool, and the envelope says so: activity is
		// the only "still working" fact a snapshot of an unsettled run carries.
		expect(["executing", "stalled", "writing", "waiting"]).toContain(collected.results[0]?.activity_kind);
		// The bound is patience, not cancellation: the child is still running.
		expect(parent.session.hasRunningRlmChildren()).toBe(true);
	});

	it("treats timeout_ms=0 as a guaranteed non-blocking read", async () => {
		const { parent, handle } = await spawn({
			name: "worker-a",
			responses: [fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" })],
			tools: [hangTool],
		});
		await vi.waitFor(() => expect(parent.session.hasRunningRlmChildren()).toBe(true), {
			timeout: 10_000,
			interval: 20,
		});

		const started = Date.now();
		const collected = await parent.session.collectRlmChildren([handle.rlm_child_id], 0);
		expect(Date.now() - started).toBeLessThan(NON_BLOCKING_BUDGET_MS);
		expect(collected.results[0]?.settled).toBe(false);
		expect(parent.session.hasRunningRlmChildren()).toBe(true);
	});

	it("ends an aborted wait with snapshots instead of rejecting", async () => {
		const { parent, handle } = await spawn({
			name: "worker-a",
			responses: [fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" })],
			tools: [hangTool],
		});
		await vi.waitFor(() => expect(parent.session.hasRunningRlmChildren()).toBe(true), {
			timeout: 10_000,
			interval: 20,
		});

		const controller = new AbortController();
		controller.abort(new Error("cell aborted"));
		const started = Date.now();
		const collected = await parent.session.collectRlmChildren([handle.rlm_child_id], 60_000, controller.signal);
		expect(Date.now() - started).toBeLessThan(NON_BLOCKING_BUDGET_MS);
		expect(collected.results[0]?.settled).toBe(false);
		expect(parent.session.hasRunningRlmChildren()).toBe(true);
	});

	it("collects a retained child that has no run (the daemon-recovery shape)", async () => {
		const child = track(
			await createHarness({ settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } } }),
		);
		child.setResponses([fauxAssistantMessage("recovered answer")]);
		await child.session.promptAndWait("say something");
		const parent = track(await createHarness({ rlmDepth: 0, rlmMaxDepth: 1 }));
		const childId = "sub-recovered";
		expect(parent.session.registerRlmChildSession(childId, child.session)).toBe(true);

		const all = await parent.session.collectRlmChildren([], 0);
		expect(all.results.map((entry) => entry.rlm_child_id)).toContain(childId);

		const byId = await parent.session.collectRlmChildren([childId], 0);
		expect(byId.results).toHaveLength(1);
		// No run exists, so there is no settlement to wait for and no classification
		// was ever recorded: the transcript is the whole result.
		expect(byId.results[0]?.settled).toBe(true);
		expect(byId.results[0]?.status).toBe("done");
		expect(byId.results[0]?.terminal_kind).toBeUndefined();
		expect(byId.results[0]?.stall_abort).toBeUndefined();
		expect(byId.results[0]?.answer_preview).toContain("recovered answer");
		expect(byId.results[0]?.tool_use_count).toBeUndefined();

		const bySessionId = await parent.session.collectRlmChildren([child.session.sessionId], 0);
		expect(bySessionId.results[0]?.rlm_child_id).toBe(childId);
	});

	it("throws for an unknown selector", async () => {
		const { parent } = await spawn({ name: "worker-a", responses: [fauxAssistantMessage("done")] });
		await expect(parent.session.collectRlmChildren(["no-such-child"], 0)).rejects.toThrow(
			'No direct RLM child matches "no-such-child"',
		);
	});

	it("stops collecting a child the parent is deleting", async () => {
		// A running child is the deletable one here: the registry row a delete
		// resolves comes from the run, and this fixture's child session has no
		// session dir of its own (the runtime host hands out a pre-made session).
		const { parent, handle } = await spawn({
			name: "worker-a",
			responses: [fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" })],
			tools: [hangTool],
		});
		await vi.waitFor(() => expect(parent.session.hasRunningRlmChildren()).toBe(true), {
			timeout: 10_000,
			interval: 20,
		});
		const before = await parent.session.collectRlmChildren([handle.rlm_child_id], 0);
		expect(before.results).toHaveLength(1);

		await parent.session.deleteRlmSubagent(handle.rlm_child_id);

		// The delete path owns the selector from here: a fan-in that kept reporting
		// the child would race the deletion it can no longer act on.
		const all = await parent.session.collectRlmChildren([], 0);
		expect(all.results.map((entry) => entry.rlm_child_id)).not.toContain(handle.rlm_child_id);
		await expect(parent.session.collectRlmChildren([handle.rlm_child_id], 0)).rejects.toThrow(
			/No direct RLM child matches/,
		);
	});
});

describe("rlm.collect carries this fork's terminal facts", () => {
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

	it("marks a stall-killed child as stall_killed with the watchdog facts", async () => {
		const child = track(
			await createHarness({
				tools: [hangTool],
				settings: {
					stallWatchdog: { enabled: true, warnAfterSeconds: 0.05, abortAfterSeconds: 0.1 },
					retry: { enabled: false },
				},
				agentMessageController: {
					listAgents: () => ({ agents: [] }),
					sendAgentMessage: vi.fn(async () => {
						throw new Error("synthesized terminal notices must not use agent_message");
					}),
				},
			}),
		);
		child.setResponses([
			fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("the turn ended after the abort"),
		]);
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

		const handle = await parent.session.runRlmChild("hang inside a tool", { name: "stall-worker" });
		const collected = await vi.waitFor(
			async () => {
				const result = await parent.session.collectRlmChildren([handle.rlm_child_id], 1_000);
				expect(result.results[0]?.settled).toBe(true);
				return result;
			},
			{ timeout: 30_000, interval: 50 },
		);

		const entry = collected.results[0]!;
		// `status` alone is the trap this fork's fields defuse: a watchdog kill
		// finishes the turn, so the raw run status reads "done".
		expect(entry.status).toBe("done");
		expect(entry.settled).toBe(true);
		expect(entry.terminal_kind).toBe("stall_killed");
		expect(entry.terminal_reason).toContain("stall watchdog");
		expect(entry.terminal_kind).not.toBe("completed_without_reply");
		expect(entry.stall_abort, "the envelope must carry the watchdog facts").toBeDefined();
		expect(entry.stall_abort?.in_flight_tools).toContain("hang_forever");
		expect(entry.stall_abort?.threshold_ms).toBe(100);
		expect(entry.stall_abort?.silent_ms).toBeGreaterThan(0);
		expect(entry.stall_abort?.settled).toBe(true);
	});
});

describe("rlm.collect host handler", () => {
	it("validates the payload shape", async () => {
		const handler = createRlmCollectHostHandler(async () => ({ results: [] }));
		await expect(handler({ targets: "worker-a" })).rejects.toThrow("targets must be an array");
		await expect(handler({ targets: [""] })).rejects.toThrow("non-empty strings");
		await expect(handler({ targets: [42] })).rejects.toThrow("non-empty strings");
		await expect(handler({ timeout_ms: -1 })).rejects.toThrow("non-negative integer");
		await expect(handler({ timeout_ms: "soon" })).rejects.toThrow("non-negative integer");
		await expect(handler({ timeout_ms: 1.5 })).rejects.toThrow("non-negative integer");
		// Node clamps setTimeout delays above 2^31-1 to 1ms, so an oversized timeout
		// must be rejected instead of turning into an immediate snapshot.
		await expect(handler({ timeout_ms: 2_147_483_648 })).rejects.toThrow("2147483647");
		const ok = await handler({ targets: [" worker-a "], timeout_ms: 5 });
		expect(ok).toMatchObject({ results: [], timeout_ms: 5 });
		const defaults = await handler({});
		expect(defaults).toMatchObject({ results: [], timeout_ms: 0 });
	});

	it("trims selectors and forwards them with the cell abort signal", async () => {
		const seen: { targets?: string[]; timeoutMs?: number; signal?: AbortSignal } = {};
		const controller = new AbortController();
		const handler = createRlmCollectHostHandler(async (targets, timeoutMs, signal) => {
			seen.targets = targets;
			seen.timeoutMs = timeoutMs;
			seen.signal = signal;
			return { results: [] };
		});
		await handler({ targets: [" worker-a ", "sub-1"], timeout_ms: 250 }, controller.signal);
		expect(seen.targets).toEqual(["worker-a", "sub-1"]);
		expect(seen.timeoutMs).toBe(250);
		expect(seen.signal).toBe(controller.signal);
	});

	it("clamps the wait inside the kernel's read-only host-request bound", async () => {
		const seen: number[] = [];
		const handler = createRlmCollectHostHandler(
			async (_targets, timeoutMs) => {
				seen.push(timeoutMs);
				return { results: [] };
			},
			{
				maxWaitMs: () => 60_000,
				onClamped: () => {},
			},
		);
		const payload = await handler({ timeout_ms: 600_000 });
		expect(seen).toEqual([60_000 - RLM_COLLECT_WAIT_MARGIN_MS]);
		// The effective bound is reported so a clamped wait is never mistaken for a
		// wait that ran to the requested length.
		expect(payload).toMatchObject({ timeout_ms: 60_000 - RLM_COLLECT_WAIT_MARGIN_MS });
	});
});

describe("clampRlmCollectWaitMs", () => {
	const cases: Array<[number, number | undefined, number]> = [
		[0, 60_000, 0],
		[-5, 60_000, 0],
		[1_000, 60_000, 1_000],
		[600_000, 60_000, 60_000 - RLM_COLLECT_WAIT_MARGIN_MS],
		// A bound smaller than the margin keeps half of itself instead of collapsing to 0.
		[5_000, 2_000, 1_000],
		[5_000, Number.POSITIVE_INFINITY, 5_000],
		[5_000, undefined, 5_000],
	];

	it("keeps a requested wait inside the host's read-only bound", () => {
		expect(cases.length).toBeGreaterThan(0);
		for (const [requested, bound, expected] of cases) {
			expect(clampRlmCollectWaitMs(requested, bound), `requested=${requested} bound=${bound}`).toBe(expected);
		}
	});
});
