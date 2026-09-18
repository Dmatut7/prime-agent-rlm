/**
 * Upstream #6158 / PR #2334 regression pins, ported to this fork.
 *
 * Upstream's file is `6158-human-message-priority.test.ts`; the name is kept so a future
 * upstream merge finds it. Two adaptations were needed and both are mechanical:
 *   - this fork's harness exposes `session.messages` rather than a `conversationMessages`
 *     helper, so the delivered-order assertion reads the transcript directly;
 *   - the queue assertions compare whole strings instead of `text.split("\n").pop()`,
 *     because a child reply's queued text is the full agent-message prompt and comparing
 *     it exactly is the stronger claim.
 * The semantics asserted are upstream's, unchanged: human input overtakes queued agent
 * traffic inside its own lane, human-to-human order is preserved, a `promptAndWait` id is
 * not agent traffic, the lane still outranks priority, and a restored queue replays its
 * stored order.
 */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
} from "../../../src/core/agent-messages.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";
import { createWaitingHarness } from "../scheduling.js";

/** This fork's harness has no `conversationMessages`; the transcript is public. */
function conversationTexts(harness: Harness): string[] {
	return harness.session.messages.map((message) => getMessageText(message));
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

function agentMessage(id: string, body: string) {
	return createAgentSessionMessage(agentMessagePayload(id, body));
}

async function queueAgentMessage(harness: Harness, id: string, body: string): Promise<void> {
	const message = agentMessage(id, body);
	await harness.session.acceptAgentMessagePrompt(message.content as string, {
		expandPromptTemplates: false,
		streamingBehavior: "steer",
		queueIfBusy: true,
		customMessage: message as never,
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

		const bodies = ["human one", "human two", "agent one", "agent two", "agent three"];
		const delivered = conversationTexts(waiting.harness)
			.map((text) => bodies.find((body) => text.includes(body)))
			.filter((body): body is string => body !== undefined);
		expect(delivered).toEqual(bodies);
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
			customMessage: agentMessage("agentmsg_restored", "agent restored") as never,
		});
		await session.restoreSteeringMessage("human restored");

		expect(session.getSteeringMessages()).toEqual(["agent restored", "human restored"]);
	});
});
