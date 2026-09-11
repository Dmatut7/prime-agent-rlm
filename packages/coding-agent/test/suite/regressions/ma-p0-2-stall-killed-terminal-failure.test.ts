/**
 * P0-2a: a child killed by the stall watchdog must reach its parent as a
 * failure with the death cause, not as "completed without sending a reply".
 *
 * Red at HEAD: the terminal path only checked `stopReason === "error"`, so a
 * watchdog abort (whose transcript ends on the aborted tool call) fell through to
 * the completed_without_reply notice - the ma-evidence / probe-silent实态.
 *
 * The parent is deliberately NOT suspended here: delivery of a notice into a
 * suspended parent pump is the persistence case, covered by
 * ma-p0-3-terminal-notice-persistence.test.ts.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentFamilyRosterResult, AgentSessionMessageReceipt } from "../../../src/core/agent-messages.js";
import { SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX } from "../../../src/core/agent-messages.js";
import type { CustomMessage } from "../../../src/core/messages.js";
import { RLM_CHILD_FAILURE_CUSTOM_TYPE, RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE } from "../../../src/core/messages.js";
import { createHarness, type Harness } from "../harness.js";

const hangTool: AgentTool = {
	name: "hang_forever",
	label: "Hang Forever",
	description: "A tool that never returns",
	parameters: Type.Object({}),
	execute: () => new Promise<never>(() => {}),
};

function customMessages(messages: readonly unknown[], customType: string): CustomMessage[] {
	return messages.filter(
		(message): message is CustomMessage =>
			typeof message === "object" &&
			message !== null &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === customType,
	);
}

function childHost(ChildSessionProvider: () => Harness) {
	return {
		createRlmSubagentRuntime: async () => ({ session: ChildSessionProvider().session }),
		deleteRlmSubagentRuntime: async () => {},
	};
}

describe("P0-2a stall-killed child reports a failure to its parent", () => {
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

	it("reports stall_killed with silence and in-flight tools instead of a no-reply notice", async () => {
		const sendAgentMessage = vi.fn(async () => {
			throw new Error("synthesized terminal notices must not use agent_message");
		});
		const child = track(
			await createHarness({
				tools: [hangTool],
				settings: {
					stallWatchdog: { enabled: true, warnAfterSeconds: 0.05, abortAfterSeconds: 0.1 },
					retry: { enabled: false },
				},
				agentMessageController: { listAgents: () => ({ agents: [] }), sendAgentMessage },
			}),
		);
		const parent = track(
			await createHarness({
				rlmDepth: 0,
				rlmMaxDepth: 1,
				subagentRuntimeHost: childHost(() => child),
			}),
		);
		child.setResponses([
			fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("the turn ended after the abort"),
		]);

		const spawned = await parent.session.runRlmChild("hang inside a tool", { name: "stall-worker" });

		const failures = await vi
			.waitFor(
				() => {
					const found = customMessages(parent.session.messages, RLM_CHILD_FAILURE_CUSTOM_TYPE);
					expect(found).toHaveLength(1);
					return found;
				},
				{ timeout: 15_000, interval: 20 },
			)
			.catch(() => undefined);
		expect(failures, "parent never received an rlm_child_failure notice").toBeDefined();
		if (!failures) throw new Error("unreachable");

		// The parent is live: this case is about classification, not about a
		// suspended pump swallowing the notice.
		expect(parent.session.isQueuedWorkSuspended).toBe(false);
		expect(sendAgentMessage).not.toHaveBeenCalled();

		const failure = failures[0]!;
		expect(failure.details).toMatchObject({
			kind: "stall_killed",
			childId: spawned.rlm_child_id,
			sessionName: "stall-worker",
		});
		const stall = (failure.details as { stall?: { silentMs: number; inFlightTools: string[] } }).stall;
		expect(stall, "failure details must carry the watchdog facts").toBeDefined();
		expect(stall?.inFlightTools).toContain("hang_forever");
		expect(stall?.silentMs).toBeGreaterThan(0);
		expect(failure.content).toContain("stall watchdog");
		expect(failure.content).toContain("hang_forever");
		expect(failure.content).toContain(`silentMs=${stall?.silentMs}`);

		// HEAD's wrong answer must be gone: no synthesized "completed without a
		// reply" notice for a child that was killed.
		expect(customMessages(parent.session.messages, RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE)).toEqual([]);
	});

	it("keeps the completed_without_reply notice for a healthy child that never replied", async () => {
		const child = track(
			await createHarness({
				agentMessageController: {
					listAgents: () => ({ agents: [] }),
					sendAgentMessage: vi.fn(async () => {
						throw new Error("synthesized terminal notices must not use agent_message");
					}),
				},
			}),
		);
		const parent = track(
			await createHarness({
				rlmDepth: 0,
				rlmMaxDepth: 1,
				subagentRuntimeHost: childHost(() => child),
			}),
		);
		child.setResponses([fauxAssistantMessage("finished quietly")]);

		await parent.session.runRlmChild("finish without replying", { name: "quiet-worker" });

		const notices = await vi
			.waitFor(
				() => {
					const found = customMessages(parent.session.messages, RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE);
					expect(found).toHaveLength(1);
					return found;
				},
				{ timeout: 15_000, interval: 20 },
			)
			.catch(() => undefined);
		expect(notices, "the fourth state must survive the classification rewrite").toBeDefined();
		expect(notices?.[0]?.details).toMatchObject({ kind: "completed_without_reply", sessionName: "quiet-worker" });
		expect(customMessages(parent.session.messages, RLM_CHILD_FAILURE_CUSTOM_TYPE)).toEqual([]);
	});

	it("does not double-report a child whose own terminal-error notice was delivered", async () => {
		const sent: string[] = [];
		const roster: AgentFamilyRosterResult = {
			current: { name: "failing-child", id: "child-session", depth: 1 },
			entries: [
				{ relationship: "parent", name: "parent-session", id: "parent-session", depth: 0, status: "running" },
			],
		};
		const receipt: AgentSessionMessageReceipt = {
			id: "agentmsg_terminal",
			source: "agent_message",
			target: { activeSessionId: "parent-active", sessionId: "parent-session" },
			message: "",
			deliveryStatus: "delivered",
		};
		const child = track(
			await createHarness({
				rlmDepth: 1,
				settings: { retry: { enabled: false } },
				agentMessageController: {
					listAgents: () => ({ agents: [] }),
					roster: async () => roster,
					sendAgentMessage: async (input) => {
						sent.push(input.message);
						return { ...receipt, message: input.message };
					},
				},
			}),
		);
		const parent = track(
			await createHarness({
				rlmDepth: 0,
				rlmMaxDepth: 1,
				subagentRuntimeHost: childHost(() => child),
			}),
		);
		child.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		await parent.session.runRlmChild("fail terminally", { name: "failing-child" });

		await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
		expect(sent[0]).toContain(SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX);
		// Give the terminal path a chance to double-report before asserting silence.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(customMessages(parent.session.messages, RLM_CHILD_FAILURE_CUSTOM_TYPE)).toEqual([]);
		expect(customMessages(parent.session.messages, RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE)).toEqual([]);
	});
});
