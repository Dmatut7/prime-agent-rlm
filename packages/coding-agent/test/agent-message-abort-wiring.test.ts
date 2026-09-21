import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionMessageController } from "../src/core/agent-messages.js";
import type { Skill } from "../src/core/skills.js";
import { createHarness, type Harness } from "./suite/harness.js";
import { createTestResourceLoader } from "./utilities.js";

type KernelHostHandlers = Record<
	string,
	(payload: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>
>;
type KernelHostSession = { _createKernelHostHandlers(): KernelHostHandlers };

const agentMessageSkill = {
	name: "agent-message",
	description: "test stub so the session wires the agent-message host handlers",
	filePath: "/tmp/skills/agent-message/SKILL.md",
	baseDir: "/tmp/skills/agent-message",
	sourceInfo: { kind: "project" },
	disableModelInvocation: false,
	kind: "markdown",
} as unknown as Skill;

const roster = {
	current: { name: "orchestrator", id: "parent-id", depth: 0 },
	entries: [
		{ relationship: "parent", name: "orchestrator", id: "parent-id", depth: 0, status: "running" },
		{ relationship: "child", name: "wedged", id: "child-id", depth: 1, status: "running" },
	],
};

describe("agent_message.abort kernel wiring", () => {
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

	function kernelHandlers(harness: Harness): KernelHostHandlers {
		return (
			// test-hygiene-allow: agent_message.abort kernel wiring; driving the kernel host handlers directly is the only seam for the adapter in a kernel-less harness
			(harness.session as unknown as KernelHostSession)._createKernelHostHandlers()
		);
	}

	it("routes the host request through the adapter into the controller abort lever", async () => {
		const abortAgentMessage = vi.fn(async (input: { target: string; sendQueued?: boolean }) => ({
			target: { activeSessionId: input.target, sessionId: input.target },
			sendQueued: input.sendQueued ?? true,
			resumedQueued: true,
		}));
		const controller = {
			listAgents: () => ({ agents: [] }),
			roster: async () => roster,
			sendAgentMessage: vi.fn(async () => {
				throw new Error("the abort test never sends a message");
			}),
			abortAgentMessage,
		} as unknown as AgentSessionMessageController;

		const harness = track(
			await createHarness({
				agentMessageController: controller,
				resourceLoader: createTestResourceLoader({ skills: [agentMessageSkill] }),
			}),
		);
		const abort = kernelHandlers(harness)["agent_message.abort"];
		expect(abort).toBeDefined();

		const receipt = await abort!({ receiver_role: "child", receiver_name: "wedged" }, undefined);
		expect(abortAgentMessage).toHaveBeenCalledTimes(1);
		// The adapter forwards the resolved target and the send_queued default (true).
		expect(abortAgentMessage).toHaveBeenCalledWith({ target: "child-id", sendQueued: true });
		expect(receipt).toMatchObject({ sendQueued: true, resumedQueued: true });

		await abort!({ receiver_role: "child", receiver_name: "wedged", send_queued: false }, undefined);
		expect(abortAgentMessage).toHaveBeenLastCalledWith({ target: "child-id", sendQueued: false });
	});

	it("surfaces the session-level unavailable error when the controller has no abort lever", async () => {
		const controller = {
			listAgents: () => ({ agents: [] }),
			roster: async () => roster,
			sendAgentMessage: vi.fn(async () => {
				throw new Error("the abort test never sends a message");
			}),
		} as unknown as AgentSessionMessageController;

		const harness = track(
			await createHarness({
				agentMessageController: controller,
				resourceLoader: createTestResourceLoader({ skills: [agentMessageSkill] }),
			}),
		);
		const abort = kernelHandlers(harness)["agent_message.abort"];
		await expect(abort!({ receiver_role: "child", receiver_name: "wedged" }, undefined)).rejects.toThrow(
			"agent abort is not available in this session",
		);
	});

	it("rejects the abort before the controller when the payload is malformed", async () => {
		const abortAgentMessage = vi.fn(async (input: { target: string }) => ({
			target: { activeSessionId: input.target, sessionId: input.target },
			sendQueued: true,
		}));
		const controller = {
			listAgents: () => ({ agents: [] }),
			roster: async () => roster,
			sendAgentMessage: vi.fn(async () => {
				throw new Error("the abort test never sends a message");
			}),
			abortAgentMessage,
		} as unknown as AgentSessionMessageController;

		const harness = track(
			await createHarness({
				agentMessageController: controller,
				resourceLoader: createTestResourceLoader({ skills: [agentMessageSkill] }),
			}),
		);
		const abort = kernelHandlers(harness)["agent_message.abort"];
		await expect(abort!({ receiver_role: "child" }, undefined)).rejects.toThrow(
			"agent_message.abort receiver_name is required for sibling and child targets",
		);
		await expect(abort!({ receiver_role: "child", receiver_name: "missing" }, undefined)).rejects.toThrow(
			"No child matches",
		);
		expect(abortAgentMessage).not.toHaveBeenCalled();
	});
});
