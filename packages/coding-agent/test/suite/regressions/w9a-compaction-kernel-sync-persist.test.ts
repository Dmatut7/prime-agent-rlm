/**
 * W9-A (agent-224, findings 1+2): kernel-state sync after a committed compaction
 * must be post-commit best-effort, and the agent_end compaction check must never
 * reject out of the terminal flow.
 *
 * 1. `_syncKernelStateAfterCompaction` ran two bare appendCustomMessageEntry calls
 *    AFTER the compaction committed. A persist failure there threw back through
 *    _performCompaction, so a committed compaction was reported as failed, the
 *    failure streak was poisoned, and an overflow recovery lost its retry. The
 *    appends now use the rollback variant behind try/catch, report through
 *    _reportSessionPersistFailure, and keep the model-visible block in
 *    _unpersistedOutcomes so context rebuilds still carry it.
 * 2. A throw escaping `_checkCompaction` at agent_end used to reject
 *    _processAgentEvent into the event queue's silent catch, skipping the retry
 *    chain's close-out and goal finalization (the wedge shape the neighboring
 *    parent-notice guard already armors against). The call site now catches, logs,
 *    and treats the turn as terminal without compaction.
 *
 * Fault injection is at public seams: SessionManager's public append/build methods
 * are spied on the instance; the kernel provisioner swap mirrors the pinned
 * approach in agent-session-compaction.test.ts.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/index.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

/** Extension that supplies compaction content so no provider call is needed. */
function extensionCompaction(summary: string): ExtensionFactory {
	return (pi) => {
		pi.on("session_before_compact", async (event) => ({
			compaction: {
				summary,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: { source: "extension" },
			},
		}));
	};
}

describe("W9-A compaction kernel sync persist failure", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("a failed kernel-state append no longer flips a committed compaction to failed", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [extensionCompaction("summary from extension")],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		// A live kernel makes _syncKernelStateAfterCompaction write the state block.
		// test-hygiene-allow: the kernel provisioner has no harness-level injection seam; mirrors agent-session-compaction.test.ts.
		const internals = harness.session as unknown as { _ipythonKernelProvisioner?: unknown };
		internals._ipythonKernelProvisioner = {
			hasRunningKernel: true,
			pruneOversizedVariables: async () => ({ pruned: ["large_text"] }),
			listNamespaceNames: async () => ["small_value"],
		};
		// Both kernel-sync appends fail (the state block and the prune notice).
		const originalAppend = harness.sessionManager.appendCustomMessageEntry;
		vi.spyOn(harness.sessionManager, "appendCustomMessageEntry").mockImplementation((customType: string, ...rest) => {
			if (customType === "ipython_state" || customType === "ipython_state_pruned") {
				throw new Error("injected kernel-sync append failure");
			}
			return originalAppend.call(harness.sessionManager, customType, ...rest);
		});

		const result = await harness.session.compact();

		// The compaction itself committed and reports success.
		expect(result.summary).toBe("summary from extension");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "manual", aborted: false });
		// The failure surfaced as a persist failure, not as a compaction failure.
		expect(harness.eventsOfType("session_persist_failed").length).toBeGreaterThan(0);
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "compaction_outcome",
			),
		).toBe(false);
		// The model-visible state block is in the live context and survives a
		// context rebuild through _unpersistedOutcomes.
		const inLiveContext = (messages: readonly { role: string; customType?: string }[]) =>
			messages.some((message) => message.role === "custom" && message.customType === "ipython_state");
		expect(inLiveContext(harness.session.messages)).toBe(true);
		expect(inLiveContext(harness.session.buildSessionContext().messages)).toBe(true);
	});

	it("a compaction check that throws at agent_end does not skip the terminal flow", async () => {
		// Overflow -> compact-and-retry -> overflow again -> forced shrink; the
		// shrink's context rebuild is made to throw once, escaping _checkCompaction
		// at agent_end. The catch must close the episode out: the subagent's
		// terminal-error parent notice and the retry resolution below still run.
		const sendAgentMessage = vi.fn(async () => ({
			id: "agentmsg_w9a_compaction",
			source: "agent_message" as const,
			target: { activeSessionId: "parent-active", sessionId: "parent-session-id" },
			message: "",
			deliveryStatus: "delivered" as const,
		}));
		const harness = await createHarness({
			rlmDepth: 1,
			models: [{ id: "small-window", contextWindow: 10_000, maxTokens: 200 }],
			settings: {
				autoRefine: { enabled: false },
				compaction: { enabled: true, reserveTokens: 800, keepRecentTokens: 6000, triggerRatio: 0.8 },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
			},
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: async () => ({
					current: { name: "child", id: "child-session-id", depth: 1 },
					entries: [
						{
							relationship: "parent",
							name: "parent-session",
							id: "parent-session-id",
							depth: 0,
							status: "running",
						},
					],
				}),
				sendAgentMessage,
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(`noted ${"n".repeat(12_000)}`)]);
		await harness.session.prompt(`first ${"z".repeat(12_000)}`);

		const overflowStep = () =>
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long: 99999 tokens > 8000 maximum",
				timestamp: Date.now() + 5000,
			});
		harness.setResponses([
			overflowStep,
			() => fauxAssistantMessage("Summary of earlier work."),
			overflowStep,
			fauxAssistantMessage("after the wedge"),
		]);
		// Make the forced shrink's post-commit context rebuild throw once. Arming
		// on a compaction_end event races the retry chain (it runs at microtask
		// speed, faster than vi.waitFor's timer poll), so the mock keys on the
		// branch shape instead: the shrink's rebuild is the first
		// buildSessionContext call after the shrink entry commits, i.e. the first
		// call with two compaction entries on the branch. It must not fire at the
		// overflow compaction's own post-commit rebuild (one entry) - a throw
		// there is digested by _runAutoCompaction's catch into a failed
		// compaction, and the agent_end guard under test never runs.
		let shrinkRebuildFailed = false;
		const originalBuild = harness.sessionManager.buildSessionContext;
		vi.spyOn(harness.sessionManager, "buildSessionContext").mockImplementation(() => {
			if (
				!shrinkRebuildFailed &&
				harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length >= 2
			) {
				shrinkRebuildFailed = true;
				throw new Error("injected shrink rebuild failure");
			}
			return originalBuild.call(harness.sessionManager);
		});
		const secondTurn = harness.session.prompt(`second ${"y".repeat(20_000)}`);
		await secondTurn;

		// The throw did not wedge the episode: the retry continuation re-issued the
		// request, overflowed again, the forced shrink committed and its rebuild
		// threw out of _checkCompaction, and the terminal flow still ran - the
		// parent heard about the terminal failure.
		await vi.waitFor(() => {
			expect(sendAgentMessage).toHaveBeenCalled();
		});
		// The throw really escaped _checkCompaction at agent_end: the forced
		// shrink's entry committed before its rebuild threw, and no compaction_end
		// digests the injected failure (a throw inside _runAutoCompaction would
		// surface as one more failed compaction_end instead).
		expect(shrinkRebuildFailed).toBe(true);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(2);
		expect(
			harness
				.eventsOfType("compaction_end")
				.every((event) => !event.errorMessage?.includes("injected shrink rebuild failure")),
		).toBe(true);
		expect(harness.session.isRetrying).toBe(false);
		await harness.session.waitForIdle();

		// And the session still serves the next prompt.
		await harness.session.prompt("again");
		await vi.waitFor(() => {
			expect(
				harness.session.messages.some(
					(message) => message.role === "assistant" && getMessageText(message) === "after the wedge",
				),
			).toBe(true);
		});
	});
});
