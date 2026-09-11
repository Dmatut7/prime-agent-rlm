import { describe, expect, it } from "vitest";
import type { AgentFamilyRosterResult } from "../src/core/agent-messages.js";
import {
	type AgentSessionMessageReceipt,
	createAgentMessageHostHandlers,
	isRetryableAgentMessageSendError,
} from "../src/core/agent-messages.js";

/**
 * The duplicate-delivery window, closed mechanically (review of 4b3399eb6).
 *
 * The shape that matters is not "the host delivered twice". It is: the delivery leg *ran*, the
 * target got the message, and the answer never made it back to the caller - a sender-side budget
 * expiring, a worker connection dropping, a kernel dying between the write and the reply. The
 * caller sees an error and cannot tell that from "nothing happened", so it retries, and the target
 * gets a second copy. An id gate that only remembers *receipts* is blind to exactly this case,
 * because there is no receipt.
 *
 * So a failed delivery leg is recorded as `uncertain`, and a repeat of the same id is refused
 * until the sender has checked with the recipient. Errors the host raises *before* handing the
 * message over (a full queue, the rate limiter, a refused admission) are the opposite case: those
 * provably delivered nothing, and recording them would block the retry that is the correct action.
 */
const ROSTER: AgentFamilyRosterResult = {
	current: { name: "parent", id: "parent-1", depth: 0 },
	entries: [{ relationship: "child", name: "worker", id: "child-1", depth: 1, status: "running" }],
};

interface Target {
	transcript: string[];
	failAfterDelivery?: string;
	refuseBeforeDelivery?: string;
}

function harness(target: Target = { transcript: [] }) {
	const handlers = createAgentMessageHostHandlers({
		roster: async () => ROSTER,
		sendAgentMessage: async (input: { target: string; message: string }) => {
			if (target.refuseBeforeDelivery) {
				// Raised before the message is handed over: provably undelivered.
				throw new Error(target.refuseBeforeDelivery);
			}
			target.transcript.push(input.message);
			if (target.failAfterDelivery) {
				// The delivery landed; only the answer was lost.
				throw new Error(target.failAfterDelivery);
			}
			return {
				id: "agentmsg_1",
				source: "agent_message",
				target: { activeSessionId: input.target, sessionId: input.target },
				message: input.message,
				deliveryStatus: "delivered",
				deliveredAt: new Date().toISOString(),
			} satisfies AgentSessionMessageReceipt;
		},
	});
	return handlers;
}

function payload(messageId?: string, message = "the report is ready") {
	return {
		type: "agent_message.send",
		message,
		receiver_role: "child",
		receiver_name: "worker",
		...(messageId === undefined ? {} : { message_id: messageId }),
	};
}

describe("the errored-first-send duplicate window (four-step check)", () => {
	it("delivers once when the first attempt delivered and then lost its reply", async () => {
		const target: Target = { transcript: [], failAfterDelivery: "worker request timed out after 30000ms" };
		const handlers = harness(target);

		// ① first attempt: the caller learns only that something went wrong.
		await expect(handlers["agent_message.send"]!(payload("dup-1"))).rejects.toThrow(/timed out/);
		expect(target.transcript).toEqual(["the report is ready"]);

		// ②③ same id again: refused, and the target still holds exactly one copy.
		const resend = await handlers["agent_message.send"]!(payload("dup-1")).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(resend).toBeInstanceOf(Error);
		expect(target.transcript).toEqual(["the report is ready"]);
		const message = resend instanceof Error ? resend.message : String(resend);
		expect(message).toContain("dup-1");
		expect(message).toContain("not delivered");
		// Fail closed, and say what to do instead of guessing.
		expect(message).toContain("agent_observe");
		expect(message).toMatch(/new message_id|fresh id|new call/i);
		expect(isRetryableAgentMessageSendError(message)).toBe(false);
	});

	it("does not block the retry that is the correct action after a pre-delivery refusal", async () => {
		const target: Target = { transcript: [], refuseBeforeDelivery: "rate limit exceeded for this target" };
		const handlers = harness(target);

		await expect(handlers["agent_message.send"]!(payload("dup-2"))).rejects.toThrow(/rate limit/);
		expect(target.transcript).toEqual([]);

		// Nothing was handed over, so the same id may be used again: once the limiter refills, the
		// message goes through exactly once.
		target.refuseBeforeDelivery = undefined;
		const receipt = await handlers["agent_message.send"]!(payload("dup-2"));
		expect(receipt).toMatchObject({ deliveryStatus: "delivered" });
		expect(target.transcript).toEqual(["the report is ready"]);

		// And now the id is spent: a third attempt is suppressed rather than delivered again.
		const third = await handlers["agent_message.send"]!(payload("dup-2"));
		expect(third).toMatchObject({ duplicateSuppressed: true });
		expect(target.transcript).toEqual(["the report is ready"]);
	});

	it("still double-delivers for a kernel that sends no id (positive control)", async () => {
		const target: Target = { transcript: [], failAfterDelivery: "worker request timed out" };
		const handlers = harness(target);
		await expect(handlers["agent_message.send"]!(payload())).rejects.toThrow(/timed out/);
		await expect(handlers["agent_message.send"]!(payload())).rejects.toThrow(/timed out/);
		expect(target.transcript).toHaveLength(2);
	});

	it("leaves the window open for a genuinely new call, which is the registered residual", async () => {
		// C15 first half only: identity is per call, not per content. A model that retries by
		// writing a new send() mints a new id and is not stopped here - the copy in the reset
		// notice and in the duplicate receipt is what addresses that, not this gate.
		const target: Target = { transcript: [], failAfterDelivery: "worker request timed out" };
		const handlers = harness(target);
		await expect(handlers["agent_message.send"]!(payload("call-1"))).rejects.toThrow();
		await expect(handlers["agent_message.send"]!(payload("call-2"))).rejects.toThrow();
		expect(target.transcript).toHaveLength(2);
	});

	it("keeps a queued first attempt honest on the duplicate reply", async () => {
		const target: Target = { transcript: [] };
		const handlers = createAgentMessageHostHandlers({
			roster: async () => ROSTER,
			sendAgentMessage: async (input: { target: string; message: string }) =>
				({
					id: "agentmsg_q",
					source: "agent_message",
					target: { activeSessionId: input.target, sessionId: input.target },
					message: input.message,
					deliveryStatus: "queued",
					queuedAt: new Date().toISOString(),
				}) satisfies AgentSessionMessageReceipt,
		});
		await handlers["agent_message.send"]!(payload("dup-q"));
		const duplicate = await handlers["agent_message.send"]!(payload("dup-q"));
		expect(duplicate).toMatchObject({ duplicateSuppressed: true, deliveryStatus: "queued" });
		expect(target.transcript).toEqual([]);
	});
});
