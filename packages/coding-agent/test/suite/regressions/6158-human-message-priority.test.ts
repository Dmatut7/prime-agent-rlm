/**
 * Upstream #6158 / PR #2334 regression pins, ported to this fork.
 *
 * Upstream's file is `6158-human-message-priority.test.ts`; the name is kept so a future
 * upstream merge finds it. One adaptation was needed and it is mechanical: the queue
 * assertions compare whole strings instead of `text.split("\n").pop()`, because a child
 * reply's queued text is the full agent-message prompt and comparing it exactly is the
 * stronger claim. The delivered-order assertion reads the conversation through this
 * fork's `conversationMessages()` helper (the live-conversation view, #2098) exactly as
 * upstream does, and identifies each delivered receipt by its agent-message id rather
 * than by searching for its body text, so a transcript entry that mentions two bodies
 * cannot be credited to the wrong one.
 * The semantics asserted are upstream's, unchanged: human input overtakes queued agent
 * traffic inside its own lane, human-to-human order is preserved, a `promptAndWait` id is
 * not agent traffic, the lane still outranks priority, and a restored queue replays its
 * stored order.
 */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessage,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
	isAgentSessionMessage,
} from "../../../src/core/agent-messages.js";
import { conversationMessages, createHarness, getMessageText, type Harness } from "../harness.js";
import { createWaitingHarness } from "../scheduling.js";

/**
 * The delivered order, read off the live conversation: an agent receipt is identified by
 * its own message id, a human prompt by its exact text, and anything else is ignored.
 */
function deliveredKeys(harness: Harness, humanTexts: readonly string[]): string[] {
	const keys: string[] = [];
	for (const message of conversationMessages(harness.session)) {
		if (isAgentSessionMessage(message)) {
			keys.push(message.details.id);
			continue;
		}
		if (message.role === "user") {
			const text = getMessageText(message);
			if (humanTexts.includes(text)) keys.push(text);
		}
	}
	return keys;
}

function agentMessagePayload(id: string, message: string): AgentSessionMessagePayload {
	return {
		id,
		source: AGENT_MESSAGE_SOURCE,
		message,
		from: { activeSessionId: "child-active", sessionId: "child-session", sessionName: "Child" },
		fromRelationship: "child",
		target: { activeSessionId: "parent-active", sessionId: "parent-session" },
	};
}

function agentMessage(id: string, body: string): AgentSessionMessage {
	return createAgentSessionMessage(agentMessagePayload(id, body));
}

async function queueAgentMessage(harness: Harness, id: string, body: string): Promise<void> {
	const message = agentMessage(id, body);
	await harness.session.acceptAgentMessagePrompt(message.content, {
		expandPromptTemplates: false,
		streamingBehavior: "steer",
		queueIfBusy: true,
		customMessage: message,
	});
}

describe("#6158 human messages outrank agent messages in the queue", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("queues human input ahead of pending agent messages and keeps human order", async () => {
		const waiting = await createWaitingHarness();
		harnesses.push(waiting.harness);
		const session = waiting.harness.session;
		waiting.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 6 }, (_, index) => fauxAssistantMessage(`reply ${index}`)),
		]);
		await waiting.waitForToolStart;

		await queueAgentMessage(waiting.harness, "agentmsg_one", "agent one");
		await session.prompt("human one", { streamingBehavior: "steer", queueIfBusy: true });
		await queueAgentMessage(waiting.harness, "agentmsg_two", "agent two");
		await session.prompt("human two", { streamingBehavior: "steer", queueIfBusy: true });
		await queueAgentMessage(waiting.harness, "agentmsg_three", "agent three");

		const queued = session.getSteeringMessages();
		expect(queued.slice(0, 2)).toEqual(["human one", "human two"]);
		expect(queued.slice(2)).toEqual([
			agentMessage("agentmsg_one", "agent one").content,
			agentMessage("agentmsg_two", "agent two").content,
			agentMessage("agentmsg_three", "agent three").content,
		]);

		waiting.releaseToolExecution();
		await waiting.promptPromise;
		await session.waitForIdle();

		// Delivery order, not just queue order: both humans were delivered before any
		// receipt, and no receipt was swallowed by the human overtaking it.
		expect(deliveredKeys(waiting.harness, ["human one", "human two"])).toEqual([
			"human one",
			"human two",
			"agentmsg_one",
			"agentmsg_two",
			"agentmsg_three",
		]);
	});

	it("keeps a prompt that waits for its own completion at human priority", async () => {
		const waiting = await createWaitingHarness();
		harnesses.push(waiting.harness);
		const session = waiting.harness.session;
		waiting.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 4 }, (_, index) => fauxAssistantMessage(`reply ${index}`)),
		]);
		await waiting.waitForToolStart;

		await queueAgentMessage(waiting.harness, "agentmsg_wait", "agent wait");
		const pending = session.promptAndWait("human wait", { streamingBehavior: "steer", queueIfBusy: true });
		await vi.waitFor(() => expect(session.getSteeringMessages()).toHaveLength(2));

		expect(session.getSteeringMessages()[0]).toBe("human wait");

		waiting.releaseToolExecution();
		await pending;
		await session.waitForIdle();
	});

	it("keeps an agent message ahead of a human follow-up the user deferred to its own lane", async () => {
		const waiting = await createWaitingHarness();
		harnesses.push(waiting.harness);
		const session = waiting.harness.session;
		waiting.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 4 }, (_, index) => fauxAssistantMessage(`reply ${index}`)),
		]);
		await waiting.waitForToolStart;

		await queueAgentMessage(waiting.harness, "agentmsg_lane", "agent lane");
		await session.prompt("human lane", { streamingBehavior: "followUp", queueIfBusy: true });

		// r39 QP-4: the steering lane drains first, so the human follow-up waits even
		// though it outranks the reply inside its own lane.
		expect(session.getSteeringMessages()).toHaveLength(1);
		expect(session.getFollowUpMessages()).toEqual(["human lane"]);

		waiting.releaseToolExecution();
		await session.dispose();
	});

	it("restores a persisted queue in its stored order", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.session;
		await session.restoreSteeringMessage("agent restored", undefined, {
			agentMessageId: "agentmsg_restored",
			customMessage: agentMessage("agentmsg_restored", "agent restored"),
		});
		await session.restoreSteeringMessage("human restored");

		expect(session.getSteeringMessages()).toEqual(["agent restored", "human restored"]);
	});
});
