/**
 * P0-2b: the parent's subscription must see a child's stall, and the label must
 * be honest about it.
 *
 * Red at HEAD: the subscription callback had no branch for stall_warning /
 * stall_abort / stall_unsettled, so a child sitting 15 minutes inside a wedged
 * tool looked exactly like a healthy one on the parent side (zero user-visible
 * signal, zero roster trace).
 *
 * B9/I-13 caveat, recorded on purpose: a *vouched* long task must never be shown
 * as stalled. The exemption input is `AgentSession.stallExempted` (host-owned
 * phases today, the kernel-liveness vouch when it lands). The "warn fires while
 * vouched" integration row is not reachable until the watchdog warns without
 * snoozing a vouched turn, so this file pins the seam's inputs instead of
 * asserting an empty set: the exemption getter is proven true under a real
 * host-owned phase and false for a healthy session.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RlmChildAgentSnapshot } from "../../src/core/agent-session.js";
import { createHarness, type Harness } from "./harness.js";

function hangTool(): AgentTool {
	return {
		name: "hang_forever",
		label: "Hang Forever",
		description: "A tool that never returns",
		parameters: Type.Object({}),
		execute: () => new Promise<never>(() => {}),
	};
}

function quickTool(log: string[]): AgentTool {
	return {
		name: "quick",
		label: "Quick",
		description: "A tool that returns at once",
		parameters: Type.Object({}),
		execute: async () => {
			log.push("quick");
			return { content: [{ type: "text" as const, text: "ok" }], details: {} };
		},
	};
}

function childUpdates(parent: Harness): RlmChildAgentSnapshot[] {
	return parent.eventsOfType("rlm_child_update").map((event) => event.child);
}

describe("P0-2b parent sees a stalled child", () => {
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

	async function spawnChild(options: {
		childTools: AgentTool[];
		childResponses: FauxResponseStep[];
		warnAfterSeconds: number;
		abortAfterSeconds: number;
		name: string;
	}): Promise<{ parent: Harness; child: Harness }> {
		const child = track(
			await createHarness({
				tools: options.childTools,
				settings: {
					stallWatchdog: {
						enabled: true,
						warnAfterSeconds: options.warnAfterSeconds,
						abortAfterSeconds: options.abortAfterSeconds,
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
		child.setResponses(options.childResponses);
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
		await parent.session.runRlmChild("work in a tool", { name: options.name });
		return { parent, child };
	}

	it("labels a child stalled when a warn-only watchdog fires", async () => {
		const { parent } = await spawnChild({
			childTools: [hangTool()],
			childResponses: [fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" })],
			warnAfterSeconds: 0.05,
			// 0 = warn-only: no abort, so the label is the only signal there is.
			abortAfterSeconds: 0,
			name: "warn-only-worker",
		});

		await vi.waitFor(
			() => {
				expect(childUpdates(parent).some((child) => child.activity?.kind === "stalled")).toBe(true);
			},
			{ timeout: 15_000, interval: 20 },
		);

		const stalled = childUpdates(parent).find((child) => child.activity?.kind === "stalled");
		expect(stalled?.stall, "the roster row must carry the forensic facts").toBeDefined();
		expect(stalled?.stall?.inFlightTools).toContain("hang_forever");
		expect(stalled?.stall?.silentMs).toBeGreaterThan(0);
		expect(stalled?.stall?.unsettled).toBeUndefined();
		// The parent's own roster projection carries the same marker.
		expect(parent.session.getRlmChildSnapshots().some((child) => child.activity?.kind === "stalled")).toBe(true);
	});

	it("records the abort on the child row and on the child session", async () => {
		const { parent, child } = await spawnChild({
			childTools: [hangTool()],
			childResponses: [fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" })],
			warnAfterSeconds: 0.05,
			abortAfterSeconds: 0.1,
			name: "abort-worker",
		});

		// thresholdMs 100 is the abort stage (the warn stage reports the warn
		// threshold), so waiting on it proves the abort was recorded, not just the warn.
		await vi.waitFor(
			() => {
				expect(child.session.stallState?.thresholdMs).toBe(100);
			},
			{ timeout: 15_000, interval: 20 },
		);
		const withFacts = childUpdates(parent).filter((update) => update.stall !== undefined);
		expect(withFacts.length).toBeGreaterThan(0);
		expect(withFacts.at(-1)?.stall?.inFlightTools).toContain("hang_forever");
	});

	it("keeps a healthy child on executing and never labels it stalled", async () => {
		const runs: string[] = [];
		const { parent, child } = await spawnChild({
			childTools: [quickTool(runs)],
			childResponses: [
				fauxAssistantMessage(fauxToolCall("quick", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("all done"),
			],
			warnAfterSeconds: 5,
			abortAfterSeconds: 10,
			name: "healthy-worker",
		});

		await vi.waitFor(
			() => {
				expect(childUpdates(parent).some((update) => update.activity?.kind === "executing")).toBe(true);
			},
			{ timeout: 15_000, interval: 20 },
		);
		expect(runs).toEqual(["quick"]);
		// Wait for the run to finish so "never stalled" covers the whole lifecycle.
		await vi.waitFor(
			() => {
				expect(parent.session.hasRunningRlmChildren()).toBe(false);
			},
			{ timeout: 15_000, interval: 20 },
		);
		expect(childUpdates(parent).some((update) => update.activity?.kind === "stalled")).toBe(false);
		expect(child.session.stallState).toBeUndefined();
	});

	it("clears the stall marker when the child starts a new turn", async () => {
		const { parent, child } = await spawnChild({
			childTools: [hangTool()],
			childResponses: [
				fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("recovered and working"),
			],
			warnAfterSeconds: 0.05,
			abortAfterSeconds: 0.1,
			name: "recovering-worker",
		});

		await vi.waitFor(
			() => {
				expect(childUpdates(parent).some((update) => update.activity?.kind === "stalled")).toBe(true);
			},
			{ timeout: 15_000, interval: 20 },
		);
		// The aborted turn has to end before a follow-up can start one.
		await vi.waitFor(
			() => {
				expect(child.session.isStreaming).toBe(false);
			},
			{ timeout: 15_000, interval: 20 },
		);

		// A follow-up turn is the recovery path: agent_start must drop the marker so a
		// recovered child is not advertised as wedged forever.
		await child.session.promptAndWait("carry on");

		expect(child.session.stallState).toBeUndefined();
		const last = childUpdates(parent).at(-1);
		expect(last?.activity?.kind === "stalled").toBe(false);
		expect(last?.stall).toBeUndefined();
	});

	it("clears the turn abort reason when a new turn starts", async () => {
		const harness = track(await createHarness({ tools: [quickTool([])], settings: { retry: { enabled: false } } }));
		expect(harness.session.lastTurnAbortReason).toBeUndefined();

		harness.session.requestAbort({ reason: "user" });
		expect(harness.session.lastTurnAbortReason).toBe("user");

		// A follow-up turn that completes normally must not inherit the old abort
		// reason, or the terminal classifier would report a healthy child as aborted.
		harness.setResponses([fauxAssistantMessage("all good")]);
		await harness.session.promptAndWait("carry on");
		expect(harness.session.lastTurnAbortReason).toBeUndefined();

		harness.setResponses([fauxAssistantMessage("wedged")]);
		harness.session.requestAbort({ reason: "stall_watchdog" });
		expect(harness.session.lastTurnAbortReason).toBe("stall_watchdog");
	});

	it("reports the stall exemption that keeps a healthy long task off the stalled label", async () => {
		const healthy = track(await createHarness());
		expect(healthy.session.stallExempted).toBe(false);

		// A host-owned phase (compaction here) is today's exemption: the watchdog
		// snoozes instead of escalating, and the parent must not label the child.
		const compacting = track(await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } }));
		const hangingSummary = () => new Promise<never>(() => {});
		compacting.setResponses([
			fauxAssistantMessage("first turn"),
			fauxAssistantMessage("second turn"),
			// Compaction makes several summarizer calls; every one of them hangs so
			// the host-owned phase stays in flight.
			hangingSummary,
			hangingSummary,
			hangingSummary,
			hangingSummary,
		]);
		await compacting.session.promptAndWait("one");
		await compacting.session.promptAndWait("two");
		// Not awaited on purpose: the summarizer never returns, and the point is the
		// state observed *while* the host-owned phase is in flight. Cleanup disposes
		// the session; the dangling promise settles nowhere and holds nothing open.
		void compacting.session.compact().catch(() => undefined);
		await vi.waitFor(
			() => {
				expect(compacting.session.isCompacting).toBe(true);
			},
			{ timeout: 10_000, interval: 10 },
		);
		// Precondition self-proof: the exemption is actually in force for this
		// session, so a "no stalled label" assertion is not an empty-set pass.
		expect(compacting.session.stallExempted).toBe(true);
		compacting.session.requestAbort();
	});
});
