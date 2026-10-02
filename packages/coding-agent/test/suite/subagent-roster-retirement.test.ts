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
});
