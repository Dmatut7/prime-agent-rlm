import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionMessageController } from "../../src/core/agent-messages.js";
import { createHarness } from "./harness.js";

const provider = "faux-roster-retirement";

/**
 * W21-A: the kernel roster is the parent's active-work list. A child whose run
 * reached a terminal state (completed or error) retires from the default
 * `rlm.list_subagents()` view; the full view (`includeTerminal`), `rlm.collect`
 * and `rlm.delete_subagent` keep addressing it, and `rlm.prune_subagents`
 * forgets a terminal child from the roster views entirely.
 *
 * W23-A: a settled errored child never leaves `_activeRlmChildRuns`, so a
 * `releaseRlmChildSession` that only accepts "done" can never hand it to the
 * daemon's idle passivation - the resident session leaked for the worker's
 * lifetime. The release must accept it and keep the audit surfaces (the closed
 * collect entry, the terminal roster row, the rlm_child_update publication).
 */
describe("subagent roster retirement (W21-A)", () => {
	it("retires a completed child from the default roster while collect and delete still address it", async () => {
		const harness = await createHarness({ provider, models: [{ id: "parent-model" }] });
		try {
			harness.setResponses([fauxAssistantMessage("child answer")]);
			const handle = await harness.session.runRlmChild("inspect the API", { name: "worker" });
			await vi.waitFor(async () => {
				const full = await harness.session.listRlmSubagents({ includeTerminal: true });
				expect(full.subagents.map((row) => row.status)).toEqual(["completed"]);
			});

			// The default roster is the active list: nothing is working anymore.
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);

			// rlm.collect still fans in the finished child.
			const collected = await harness.session.collectRlmChildren(["worker"], 0);
			expect(collected.results).toHaveLength(1);
			expect(collected.results[0]).toMatchObject({
				rlm_child_id: handle.rlm_child_id,
				session_name: "worker",
				status: "done",
				settled: true,
			});

			// rlm.delete_subagent still resolves a child the default list hides.
			await expect(harness.session.deleteRlmSubagent("worker")).resolves.toMatchObject({
				subagent: { session_name: "worker" },
			});
			expect((await harness.session.listRlmSubagents({ includeTerminal: true })).subagents).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("retires an errored child from the default roster", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model" }],
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					throw new Error("startup failed");
				},
				deleteRlmSubagentRuntime: async () => undefined,
			},
		});
		try {
			await harness.session.runRlmChild("failing startup", { name: "doomed" });
			await vi.waitFor(async () => {
				const collected = await harness.session.collectRlmChildren(["doomed"], 0);
				expect(collected.results[0]).toMatchObject({ status: "error", settled: true });
			});
			const full = await harness.session.listRlmSubagents({ includeTerminal: true });
			expect(full.subagents[0]).toMatchObject({ session_name: "doomed", status: "error" });
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);

			await expect(harness.session.deleteRlmSubagent("doomed")).resolves.toMatchObject({
				subagent: { session_name: "doomed" },
			});
		} finally {
			harness.cleanup();
		}
	});

	it("hides passive daemon-listed children from the default roster", async () => {
		const agentMessageController: AgentSessionMessageController = {
			listAgents: () => ({
				current: { activeSessionId: "parent-active", sessionId: "parent-session" },
				agents: [
					{
						activeSessionId: "ghost-active",
						sessionId: "ghost-session",
						sessionName: "ghost-worker",
						runtimeKind: "subagent",
						cwd: "/tmp",
						isStreaming: false,
						unfinishedActionCount: 0,
						parentActiveSessionId: "parent-active",
						rlmChildId: "ghost-child",
						rlmChildRegistryStatus: "completed",
						sessionDir: "/tmp/ghost-child",
					},
				],
			}),
			sendAgentMessage: async () => {
				throw new Error("unexpected send");
			},
		};
		const harness = await createHarness({ provider, models: [{ id: "parent-model" }], agentMessageController });
		try {
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);
			const full = await harness.session.listRlmSubagents({ includeTerminal: true });
			expect(full.subagents).toEqual([
				expect.objectContaining({ rlm_child_id: "ghost-child", session_name: "ghost-worker", status: "completed" }),
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps running children on the default roster and refuses to prune them", async () => {
		const harness = await createHarness({ provider, models: [{ id: "parent-model" }] });
		try {
			let releaseChild!: () => void;
			const gate = new Promise<void>((resolve) => {
				releaseChild = resolve;
			});
			harness.setResponses([
				async () => {
					await gate;
					return fauxAssistantMessage("late answer");
				},
			]);
			await harness.session.runRlmChild("slow task", { name: "slow-worker" });
			await vi.waitFor(async () => {
				expect((await harness.session.listRlmSubagents()).subagents[0]).toMatchObject({
					session_name: "slow-worker",
					status: "running",
				});
			});

			await expect(harness.session.pruneRlmSubagents(["slow-worker"])).rejects.toThrow("still running");
			await expect(harness.session.pruneRlmSubagents()).resolves.toEqual({ pruned: [] });
			expect((await harness.session.listRlmSubagents()).subagents[0]?.status).toBe("running");

			releaseChild();
			await vi.waitFor(async () => {
				const full = await harness.session.listRlmSubagents({ includeTerminal: true });
				expect(full.subagents[0]?.status).toBe("completed");
			});
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("prunes terminal children from every roster view while collect and delete still resolve them", async () => {
		const harness = await createHarness({ provider, models: [{ id: "parent-model" }] });
		try {
			harness.setResponses([fauxAssistantMessage("child answer")]);
			const handle = await harness.session.runRlmChild("inspect the API", { name: "worker" });
			await vi.waitFor(async () => {
				const full = await harness.session.listRlmSubagents({ includeTerminal: true });
				expect(full.subagents[0]?.status).toBe("completed");
			});

			const pruned = await harness.session.pruneRlmSubagents();
			expect(pruned.pruned).toHaveLength(1);
			expect(pruned.pruned[0]).toMatchObject({ rlm_child_id: handle.rlm_child_id, session_name: "worker" });

			// Pruned rows leave even the terminal-inclusive roster.
			expect((await harness.session.listRlmSubagents({ includeTerminal: true })).subagents).toEqual([]);
			// A second prune finds nothing left to retire.
			await expect(harness.session.pruneRlmSubagents()).resolves.toEqual({ pruned: [] });

			// rlm.collect keeps the result addressable after the roster forgot it.
			const collected = await harness.session.collectRlmChildren(["worker"], 0);
			expect(collected.results[0]).toMatchObject({ status: "done", settled: true });

			// Deletion still resolves a pruned child through the internal full registry.
			await expect(harness.session.deleteRlmSubagent("worker")).resolves.toMatchObject({
				subagent: { session_name: "worker" },
			});
		} finally {
			harness.cleanup();
		}
	});

	it("prunes a terminal child selected by name", async () => {
		const harness = await createHarness({ provider, models: [{ id: "parent-model" }] });
		try {
			harness.setResponses([fauxAssistantMessage("child answer")]);
			await harness.session.runRlmChild("inspect the API", { name: "worker" });
			await vi.waitFor(async () => {
				const full = await harness.session.listRlmSubagents({ includeTerminal: true });
				expect(full.subagents[0]?.status).toBe("completed");
			});

			const pruned = await harness.session.pruneRlmSubagents(["worker"]);
			expect(pruned.pruned[0]?.session_name).toBe("worker");
			expect((await harness.session.listRlmSubagents({ includeTerminal: true })).subagents).toEqual([]);
			await expect(harness.session.pruneRlmSubagents(["worker"])).rejects.toThrow("No direct RLM subagent matches");
		} finally {
			harness.cleanup();
		}
	});

	it("releases a settled errored child to idle passivation and keeps its audit surfaces", async () => {
		// A runtime host without releaseRlmSubagentRuntime leaves the errored
		// child's session resident (the daemon closes an errored child only through
		// that hook), which is exactly the shape idle passivation must then reap
		// through releaseRlmChildSession.
		const child = await createHarness({
			rlmDepth: 1,
			settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } },
		});
		const harness = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } },
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child.session }),
				deleteRlmSubagentRuntime: async () => undefined,
			},
		});
		try {
			// A post-bind failure: the child session exists (the daemon's resident
			// session in production) and the run itself errors underneath it.
			child.session.promptAndWait = async () => {
				throw new Error("turn exploded");
			};
			const handle = await harness.session.runRlmChild("doomed task", { name: "doomed" });
			await vi.waitFor(async () => {
				const atSettle = await harness.session.collectRlmChildren(["doomed"], 0);
				expect(atSettle.results[0]).toMatchObject({ status: "error", settled: true });
			});

			// The errored child is still resident with the parent.
			const resident = harness.session.getRlmChildSession(handle.rlm_child_id);
			expect(resident).toBe(child.session);
			const release = harness.session.releaseRlmChildSession(handle.rlm_child_id, child.session);
			expect(release).not.toBe(false);
			if (release === false) throw new Error("releaseRlmChildSession refused a settled errored child");
			release();

			// The audit surfaces keep the errored child: the terminal roster row and
			// the collect result survive the release.
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);
			const full = await harness.session.listRlmSubagents({ includeTerminal: true });
			expect(full.subagents[0]).toMatchObject({
				rlm_child_id: handle.rlm_child_id,
				session_name: "doomed",
				status: "error",
				active_session_id: null,
			});
			const collected = await harness.session.collectRlmChildren(["doomed"], 0);
			expect(collected.results[0]).toMatchObject({
				status: "error",
				settled: true,
				error: "turn exploded",
				terminal_kind: "error",
			});

			// The release published the closed roster row instead of dropping the
			// child silently (no activeSessionId = no longer resident).
			const updates = harness
				.eventsOfType("rlm_child_update")
				.filter((event) => event.child.id === handle.rlm_child_id);
			expect(updates.at(-1)?.child.status).toBe("error");
			expect(updates.at(-1)?.child.activeSessionId).toBeUndefined();

			// A second release finds nothing to let go of.
			expect(harness.session.releaseRlmChildSession(handle.rlm_child_id, child.session)).toBe(false);
		} finally {
			harness.cleanup();
			child.cleanup();
		}
	});

	it("refuses to release a child whose run is still in flight", async () => {
		const harness = await createHarness({ provider, models: [{ id: "parent-model" }] });
		try {
			let releaseChild!: () => void;
			const gate = new Promise<void>((resolve) => {
				releaseChild = resolve;
			});
			harness.setResponses([
				async () => {
					await gate;
					return fauxAssistantMessage("late answer");
				},
			]);
			const handle = await harness.session.runRlmChild("slow task", { name: "slow-worker" });
			await vi.waitFor(async () => {
				expect((await harness.session.listRlmSubagents()).subagents[0]?.status).toBe("running");
			});

			const resident = harness.session.getRlmChildSession(handle.rlm_child_id);
			expect(resident).toBeDefined();
			if (!resident) throw new Error("a running child must be resident");
			expect(harness.session.releaseRlmChildSession(handle.rlm_child_id, resident)).toBe(false);

			releaseChild();
			await vi.waitFor(async () => {
				const full = await harness.session.listRlmSubagents({ includeTerminal: true });
				expect(full.subagents[0]?.status).toBe("completed");
			});
		} finally {
			harness.cleanup();
		}
	});
});
