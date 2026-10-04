/**
 * The wake_on_message collect baseline (rlm-runtime's `since = deliveredCount()`)
 * is only truthful when the session's arrival and delivered ledgers pair up.
 * Review 2026-10-04 (domain 3, must-1) found two same-root leaks in that pairing:
 *
 * 1. Idle-session direct admission (`starts_when_admitted`): the message_start
 *    handler notes the delivery inside the `await ticket.delivered` window, but
 *    the arrival note ran only after `_prompt` returned - so the delivered note
 *    found no pending id and no-opped, and the arrival note then parked the id in
 *    the pending set forever. From then on arrival - delivered >= 1 and every
 *    wake_on_message collect answered instantly with a phantom messages_pending,
 *    sending the model to end turns for news that did not exist.
 * 2. A coalesced duplicate admission (accepted: false) still ran the arrival
 *    note: +1 per merged duplicate, with no delivery ever coming.
 *
 * Red at HEAD: both collects answer with messages_pending present.
 */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessage,
	createAgentSessionMessage,
	createAgentSessionMessageId,
} from "../../../src/core/agent-messages.js";
import type { AgentSession } from "../../../src/core/agent-session.js";
import type { HostRequestHandlers } from "../../../src/core/kernel/index.js";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";
import { createWaitingHarness } from "../scheduling.js";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

function track(harness: Harness): Harness {
	harnesses.push(harness);
	return harness;
}

type KernelHostSession = {
	_createKernelHostHandlers(): HostRequestHandlers;
};

function kernelHandlers(harness: Harness): HostRequestHandlers {
	// test-hygiene-allow: the session-side ledger's only public consumer is the rlm.collect host handler; driving it directly is the kernel-less seam the frozen agent-session-queue helper uses for the same class of assertion
	return (harness.session as unknown as KernelHostSession)._createKernelHostHandlers();
}

interface CollectAnswer {
	results: unknown[];
	timeout_ms: number;
	messages_pending?: number;
}

async function collectWithMessageWake(harness: Harness): Promise<CollectAnswer> {
	const collect = kernelHandlers(harness)["rlm.collect"];
	if (!collect) throw new Error("missing rlm.collect host handler");
	return (await collect({ timeout_ms: 250, wake_on_message: true })) as unknown as CollectAnswer;
}

function childReply(receiver: AgentSession, message: string): AgentSessionMessage {
	return createAgentSessionMessage({
		id: createAgentSessionMessageId(),
		source: AGENT_MESSAGE_SOURCE,
		message,
		from: {
			activeSessionId: "child-active",
			sessionId: "child-session",
			sessionName: "worker",
		},
		fromRelationship: "child",
		target: {
			activeSessionId: "parent-active",
			sessionId: receiver.sessionId,
			sessionName: "parent",
		},
	});
}

/**
 * The daemon's delivery leg (minus the daemon): hand a child's reply to the
 * receiving session with the options `acceptAgentSessionMessage` uses, and
 * report what the preflight receipt said.
 */
async function deliverChildReply(
	receiver: AgentSession,
	reply: AgentSessionMessage,
	options: { streamingBehavior?: "steer" | "followUp"; followUpQueueKey?: string } = {},
): Promise<"delivered" | "queued"> {
	let accepted = true;
	let queued = false;
	await receiver.acceptAgentMessagePrompt(reply.content as string, {
		expandPromptTemplates: false,
		streamingBehavior: options.streamingBehavior ?? "steer",
		queueIfBusy: true,
		customMessage: reply,
		...(options.followUpQueueKey !== undefined ? { followUpQueueKey: options.followUpQueueKey } : {}),
		preflightResult: (success, didQueue) => {
			accepted = success;
			queued = success && didQueue === true;
		},
	});
	if (!accepted) throw new Error("the receiving session refused the child reply");
	return queued ? "queued" : "delivered";
}

describe("agent-message wake ledger pairing", () => {
	it("pairs arrival with delivery on the idle-session direct path, so no phantom wake follows", async () => {
		const harness = track(await createHarness());
		harness.setResponses([fauxAssistantMessage("reply noted")]);

		// The fan-in shape: the parent is idle when the child's reply arrives, so
		// admission starts the turn immediately and the delivery settles inside the
		// admission's own await.
		await expect(deliverChildReply(harness.session, childReply(harness.session, "child result"))).resolves.toBe(
			"delivered",
		);
		await harness.session.waitForIdle();
		expect(getAssistantTexts(harness)).toEqual(["reply noted"]);

		// The delivered reply is the baseline, not news: a collect armed after it
		// must park on its bound instead of reporting a phantom pending message.
		const answer = await collectWithMessageWake(harness);
		expect(answer.messages_pending).toBeUndefined();
	});

	it("does not count a coalesced duplicate admission as an arrival", async () => {
		const waiting = await createWaitingHarness();
		const harness = track(waiting.harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("turn one done"),
			fauxAssistantMessage("reply read"),
		]);
		await waiting.waitForToolStart;

		// The retry leg re-sends the same message while the first copy is still
		// queued; the second admission coalesces into it and is not an arrival.
		const reply = childReply(harness.session, "duplicate payload");
		await expect(
			deliverChildReply(harness.session, reply, { streamingBehavior: "followUp", followUpQueueKey: "dup" }),
		).resolves.toBe("queued");
		await expect(
			deliverChildReply(harness.session, reply, { streamingBehavior: "followUp", followUpQueueKey: "dup" }),
		).rejects.toThrow("refused the child reply");

		waiting.releaseToolExecution();
		await waiting.promptPromise;
		await harness.session.waitForIdle();
		expect(getAssistantTexts(harness)).toEqual(["", "turn one done", "reply read"]);

		const answer = await collectWithMessageWake(harness);
		expect(answer.messages_pending).toBeUndefined();
	});
});
