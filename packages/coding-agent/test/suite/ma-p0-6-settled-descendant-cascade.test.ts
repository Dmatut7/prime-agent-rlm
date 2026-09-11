/**
 * P0-6: the abort cascade must reach running work retained under a settled
 * descendant.
 *
 * Red at HEAD: abort()/abortForUpdateRestart() cancelled only the runs in this
 * session's own `_activeRlmChildRuns` map, while `hasRunningRlmChildren()`
 * already walked the whole subtree. A child that had settled, been followed up,
 * and then spawned a child of its own kept running (and burning tokens) after the
 * root was killed, and nothing could reach it.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import type { CreateRlmSubagentRuntimeOptions } from "../../src/core/rlm-runtime.js";
import { createHarness, type Harness } from "./harness.js";

function hangTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: "A tool that never returns",
		parameters: Type.Object({}),
		execute: () => new Promise<never>(() => {}),
	};
}

function messageController() {
	return {
		listAgents: () => ({ agents: [] }),
		sendAgentMessage: vi.fn(async () => {
			throw new Error("synthesized terminal notices must not use agent_message");
		}),
	};
}

interface Family {
	root: Harness;
	childA: Harness;
	grandchildB: Harness;
	/** Releases a gated grandchild runtime construction. */
	releaseGrandchildRuntime(): void;
	/** Publishes the grandchild session late, the way an async host would. */
	publishGrandchildLate(): void;
	latePublicationOptions: CreateRlmSubagentRuntimeOptions | undefined;
}

describe("P0-6 abort cascade reaches settled descendants", () => {
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

	async function createFamily(options: { gateGrandchildRuntime?: boolean } = {}): Promise<Family> {
		let releaseGate = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const family: Family = {
			root: undefined as unknown as Harness,
			childA: undefined as unknown as Harness,
			grandchildB: undefined as unknown as Harness,
			releaseGrandchildRuntime: releaseGate,
			publishGrandchildLate: () => {},
			latePublicationOptions: undefined,
		};

		const grandchildB = track(
			await createHarness({
				rlmDepth: 2,
				rlmMaxDepth: 2,
				tools: [hangTool("hang_b")],
				agentMessageController: messageController(),
			}),
		);
		const childA = track(
			await createHarness({
				rlmDepth: 1,
				rlmMaxDepth: 2,
				tools: [hangTool("hang_a")],
				agentMessageController: messageController(),
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async (runtimeOptions: CreateRlmSubagentRuntimeOptions) => {
						family.latePublicationOptions = runtimeOptions;
						family.publishGrandchildLate = () => {
							runtimeOptions.onSessionPublished?.(grandchildB.session);
						};
						if (options.gateGrandchildRuntime) await gate;
						return { session: grandchildB.session };
					},
					deleteRlmSubagentRuntime: async () => {},
				},
			}),
		);
		const root = track(
			await createHarness({
				rlmDepth: 0,
				rlmMaxDepth: 2,
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async () => ({ session: childA.session }),
					deleteRlmSubagentRuntime: async () => {},
				},
			}),
		);
		family.root = root;
		family.childA = childA;
		family.grandchildB = grandchildB;
		family.releaseGrandchildRuntime = releaseGate;
		return family;
	}

	/** A settles, is followed up, and spawns B from that follow-up turn. */
	async function arrangeOrphanRing(family: Family): Promise<void> {
		family.childA.setResponses([
			fauxAssistantMessage("a finished the first task"),
			fauxAssistantMessage(fauxToolCall("hang_a", {}), { stopReason: "toolUse" }),
		]);
		family.grandchildB.setResponses([fauxAssistantMessage(fauxToolCall("hang_b", {}), { stopReason: "toolUse" })]);

		await family.root.session.runRlmChild("first task", { name: "worker-a" });
		// The run settled: A left _activeRlmChildRuns and is retained for follow-ups.
		await vi.waitFor(() => expect(family.root.session.hasRunningRlmChildren()).toBe(false), {
			timeout: 15_000,
			interval: 20,
		});
		expect(family.root.session.getRlmChildSnapshots().length).toBeGreaterThan(0);

		void family.childA.session.promptAndWait("follow up").catch(() => undefined);
		await vi.waitFor(() => expect(family.childA.session.isStreaming).toBe(true), { timeout: 15_000, interval: 20 });

		void family.childA.session.runRlmChild("nested task", { name: "worker-b" });
		await vi.waitFor(() => expect(family.childA.session.hasRunningRlmChildren()).toBe(true), {
			timeout: 15_000,
			interval: 20,
		});
	}

	it("cancels the grandchild and stops the followed-up child's own turn", async () => {
		const family = await createFamily();
		await arrangeOrphanRing(family);

		// Positive control before the kill: the family really is running, and the
		// judgement (hasRunningRlmChildren) sees it from the root.
		expect(family.root.session.hasRunningRlmChildren()).toBe(true);
		const grandchildAbort = vi.spyOn(family.grandchildB.session, "abort");

		await family.root.session.abort();

		await vi.waitFor(() => expect(family.root.session.hasRunningRlmChildren()).toBe(false), {
			timeout: 15_000,
			interval: 20,
		});
		// Step 2 of the cascade: the retained child's own in-flight turn is stopped,
		// not just the runs the root tracks.
		await vi.waitFor(() => expect(family.childA.session.isStreaming).toBe(false), { timeout: 15_000, interval: 20 });
		const snapshots = family.childA.session.getRlmChildSnapshots();
		expect(snapshots.every((snapshot) => snapshot.status === "cancelled")).toBe(true);
		expect(family.childA.session.listRlmSubagents().then).toBeTypeOf("function");
		expect(grandchildAbort).toHaveBeenCalledOnce();

		// A second cascade must not cancel the same grandchild again: the cancelled
		// run's abort handle is dropped, so a repeated kill is a no-op.
		await family.root.session.abort();
		expect(grandchildAbort).toHaveBeenCalledOnce();
		expect(family.root.session.hasRunningRlmChildren()).toBe(false);
	});

	it("leaves the family running when nothing aborts", async () => {
		const family = await createFamily();
		await arrangeOrphanRing(family);

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(family.root.session.hasRunningRlmChildren()).toBe(true);
		expect(family.childA.session.isStreaming).toBe(true);
		const running = family.childA.session.getRlmChildSnapshots().filter((snapshot) => snapshot.status === "running");
		expect(running.length).toBeGreaterThan(0);
	});

	it("aborts a grandchild published after its run was cancelled and untracked", async () => {
		const family = await createFamily({ gateGrandchildRuntime: true });
		family.childA.setResponses([fauxAssistantMessage(fauxToolCall("hang_a", {}), { stopReason: "toolUse" })]);
		family.grandchildB.setResponses([fauxAssistantMessage(fauxToolCall("hang_b", {}), { stopReason: "toolUse" })]);

		void family.childA.session.promptAndWait("work").catch(() => undefined);
		await vi.waitFor(() => expect(family.childA.session.isStreaming).toBe(true), { timeout: 15_000, interval: 20 });

		void family.childA.session.runRlmChild("nested task", { name: "worker-b" });
		await vi.waitFor(() => expect(family.latePublicationOptions).toBeDefined(), { timeout: 15_000, interval: 20 });

		// Cancel while the runtime construction is still blocked, then let the run
		// finish its cleanup so it leaves the active map.
		await family.childA.session.abort();
		family.releaseGrandchildRuntime();
		await vi.waitFor(() => expect(family.childA.session.hasRunningRlmChildren()).toBe(false), {
			timeout: 15_000,
			interval: 20,
		});

		const grandchildAbort = vi.spyOn(family.grandchildB.session, "abort");
		// I-11: a host that learns the child session asynchronously publishes after
		// the cancellation. Map membership is not evidence the cascade reached this
		// child, so the cancelled run must still stop it.
		family.publishGrandchildLate();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(grandchildAbort).toHaveBeenCalledOnce();
		expect(family.grandchildB.session.messages.some((message) => message.role === "assistant")).toBe(false);
	});

	it("does not re-wire a settled run when a publication arrives late", async () => {
		const family = await createFamily();
		family.childA.setResponses([fauxAssistantMessage("done")]);
		await family.root.session.runRlmChild("quick task", { name: "worker-a" });
		await vi.waitFor(() => expect(family.root.session.hasRunningRlmChildren()).toBe(false), {
			timeout: 15_000,
			interval: 20,
		});

		// A settled (done) run that is published again must not be revived: the
		// accounting stays as the settle path left it, so no invisible live child
		// session appears under the parent.
		const before = family.root.session.getRlmChildSnapshots();
		expect(before.length).toBeGreaterThan(0);
		expect(before[0]?.status).toBe("done");
		family.publishGrandchildLate();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const after = family.root.session.getRlmChildSnapshots();
		expect(after.map((snapshot) => snapshot.id)).toEqual(before.map((snapshot) => snapshot.id));
		expect(after[0]?.status).toBe("done");
		expect(family.root.session.hasRunningRlmChildren()).toBe(false);
	});

	it("does not cascade a subtree kill when the stall watchdog aborts a turn", async () => {
		const family = await createFamily();
		await arrangeOrphanRing(family);

		// requestAbort is turn-level by ruling (C1乙): a watchdog kill or a user Esc
		// on the root must not take the whole family down with it. Only the explicit
		// abort()/abortForUpdateRestart()/kill paths cascade.
		family.root.session.requestAbort({ reason: "stall_watchdog" });
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(family.root.session.isQueuedWorkSuspended).toBe(true);
		expect(family.childA.session.hasRunningRlmChildren()).toBe(true);
		expect(family.childA.session.isStreaming).toBe(true);
	});

	it("cascades over the same subtree on the update-restart path", async () => {
		const family = await createFamily();
		await arrangeOrphanRing(family);
		expect(family.root.session.hasRunningRlmChildren()).toBe(true);

		family.root.session.abortForUpdateRestart();

		await vi.waitFor(() => expect(family.root.session.hasRunningRlmChildren()).toBe(false), {
			timeout: 15_000,
			interval: 20,
		});
		await vi.waitFor(() => expect(family.childA.session.isStreaming).toBe(false), { timeout: 15_000, interval: 20 });
		// The update-restart fence itself is untouched: queued work still survives.
		expect(family.root.session.isQueuedWorkSuspended).toBe(true);
	});

	it("keeps a single-session abort free of cascade side effects", async () => {
		// G6: with no subagents the walk only contains self, so abort stays a
		// turn-level operation.
		const lone = track(await createHarness({ tools: [hangTool("hang_a")] }));
		lone.setResponses([fauxAssistantMessage(fauxToolCall("hang_a", {}), { stopReason: "toolUse" })]);
		const session: AgentSession = lone.session;
		expect(session.hasRunningRlmChildren()).toBe(false);
		void session.promptAndWait("work").catch(() => undefined);
		await vi.waitFor(() => expect(session.isStreaming).toBe(true), { timeout: 15_000, interval: 20 });

		await session.abort();
		expect(session.isStreaming).toBe(false);
		expect(session.getRlmChildSnapshots()).toEqual([]);
	});
});
