import { describe, expect, it } from "vitest";
import {
	type AgentFamilyRosterResult,
	type AgentSessionMessageReceipt,
	createAgentMessageHostHandlers,
	formatAgentSessionNameReserved,
	formatAgentSessionNameUnavailable,
	HANDLED_AGENT_MESSAGE_ID_LIMIT,
	HandledAgentMessageIds,
} from "../src/core/agent-messages.js";

const ROSTER: AgentFamilyRosterResult = {
	current: { name: "parent", id: "parent-1", depth: 0 },
	entries: [
		{ relationship: "child", name: "worker", id: "child-1", depth: 1, status: "running" },
		{ relationship: "parent", name: "parent", id: "parent-1", depth: 0, status: "running" },
	],
};

interface Delivery {
	target: string;
	message: string;
}

function harness(options: { handled?: HandledAgentMessageIds; status?: "delivered" | "queued" } = {}) {
	const deliveries: Delivery[] = [];
	const status = options.status ?? "delivered";
	const handlers = createAgentMessageHostHandlers(
		{
			roster: async () => ROSTER,
			sendAgentMessage: async (input: { target: string; message: string }) => {
				deliveries.push({ target: input.target, message: input.message });
				return {
					id: `agentmsg_${deliveries.length}`,
					source: "agent_message",
					target: { activeSessionId: input.target, sessionId: input.target },
					message: input.message,
					deliveryStatus: status,
					deliveredAt: new Date().toISOString(),
				} satisfies AgentSessionMessageReceipt;
			},
		},
		{ ...(options.handled ? { handledMessageIds: options.handled } : {}) },
	);
	return { handlers, deliveries };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "agent_message.send",
		message: "the answer is 42",
		receiver_role: "child",
		receiver_name: "worker",
		...overrides,
	};
}

describe("agent message exactly-once delivery (C15)", () => {
	it("delivers one message_id once and says so the second time", async () => {
		const { handlers, deliveries } = harness();
		const first = await handlers["agent_message.send"]!(payload({ message_id: "id-1" }));
		const second = await handlers["agent_message.send"]!(payload({ message_id: "id-1" }));

		expect(deliveries).toHaveLength(1);
		expect(first).toMatchObject({ deliveryStatus: "delivered" });
		expect((first as { duplicateSuppressed?: boolean }).duplicateSuppressed).toBeUndefined();
		expect(second).toMatchObject({ duplicateSuppressed: true, deliveryStatus: "delivered", id: "id-1" });
		expect((second as { notice: string }).notice).toContain("NOT delivered again");
		expect((second as { notice: string }).notice).toContain("agent_observe");
	});

	it("delivers two different ids, including the same text twice on purpose", async () => {
		const { handlers, deliveries } = harness();
		await handlers["agent_message.send"]!(payload({ message_id: "id-1" }));
		await handlers["agent_message.send"]!(payload({ message_id: "id-2" }));
		// The content key this batch deliberately does not add: two calls, two deliveries.
		expect(deliveries).toHaveLength(2);
	});

	it("keeps today's behaviour for a kernel that sends no id", async () => {
		const { handlers, deliveries } = harness();
		await handlers["agent_message.send"]!(payload());
		await handlers["agent_message.send"]!(payload());
		expect(deliveries).toHaveLength(2);
	});

	it("records the queued status so a duplicate reply tells the truth", async () => {
		const { handlers, deliveries } = harness({ status: "queued" });
		await handlers["agent_message.send"]!(payload({ message_id: "id-q" }));
		const duplicate = await handlers["agent_message.send"]!(payload({ message_id: "id-q" }));
		expect(deliveries).toHaveLength(1);
		expect(duplicate).toMatchObject({ duplicateSuppressed: true, deliveryStatus: "queued" });
	});

	it("suppresses a repeated broadcast as one delivery", async () => {
		const { handlers, deliveries } = harness();
		const broadcast = { type: "agent_message.send", target: "all", message: "stand up", message_id: "id-b" };
		await handlers["agent_message.send"]!(broadcast);
		const duplicate = await handlers["agent_message.send"]!(broadcast);
		expect(deliveries).toHaveLength(2); // the roster has two entries
		expect(duplicate).toMatchObject({ duplicateSuppressed: true });
	});

	it("carries the sender id to the controller for correlation", async () => {
		const seen: (string | undefined)[] = [];
		const handlers = createAgentMessageHostHandlers({
			roster: async () => ROSTER,
			sendAgentMessage: async (input: { target: string; messageId?: string }) => {
				seen.push(input.messageId);
				return {
					id: "agentmsg_x",
					source: "agent_message",
					target: { activeSessionId: input.target, sessionId: input.target },
					message: "m",
					deliveryStatus: "delivered",
				} satisfies AgentSessionMessageReceipt;
			},
		});
		await handlers["agent_message.send"]!(payload({ message_id: "id-c" }));
		await handlers["agent_message.send"]!(payload());
		expect(seen).toEqual(["id-c", undefined]);
	});
});

describe("HandledAgentMessageIds", () => {
	it("evicts the least recently handled id at the limit and degrades to today's behaviour", () => {
		const handled = new HandledAgentMessageIds(3);
		handled.record("a", { deliveryStatus: "delivered", at: 1 });
		handled.record("b", { deliveryStatus: "delivered", at: 2 });
		handled.record("c", { deliveryStatus: "delivered", at: 3 });
		// Touching "a" makes "b" the oldest.
		expect(handled.find("a")).toBeDefined();
		handled.record("d", { deliveryStatus: "delivered", at: 4 });
		expect(handled.size).toBe(3);
		expect(handled.find("b")).toBeUndefined();
		expect(handled.find("a")).toBeDefined();
		expect(handled.find("d")).toBeDefined();
	});

	it("ships a limit big enough that eviction is not a normal event", () => {
		expect(HANDLED_AGENT_MESSAGE_ID_LIMIT).toBe(1024);
		const handled = new HandledAgentMessageIds();
		for (let index = 0; index < HANDLED_AGENT_MESSAGE_ID_LIMIT + 10; index++) {
			handled.record(`id-${index}`, { deliveryStatus: "delivered", at: index });
		}
		expect(handled.size).toBe(HANDLED_AGENT_MESSAGE_ID_LIMIT);
		expect(handled.find("id-9")).toBeUndefined();
		expect(handled.find(`id-${HANDLED_AGENT_MESSAGE_ID_LIMIT + 9}`)).toBeDefined();
	});
});

describe("name-occupied copy (C15)", () => {
	it("tells a retry of its own spawn to look for the handle instead of renaming", () => {
		const reserved = formatAgentSessionNameReserved("worker", 1);
		expect(reserved).toContain('Agent name "worker" is unavailable');
		expect(reserved).toContain("admission for this name is already in flight");
		expect(reserved).toContain("rlm.list_subagents()");
		expect(reserved).toContain("instead of spawning a second one");
	});

	it("tells a genuine name clash to list or rename", () => {
		const taken = formatAgentSessionNameUnavailable("worker", 1);
		expect(taken).toContain('Agent name "worker" is unavailable');
		expect(taken).toContain("rlm.list_subagents()");
		expect(taken).toContain("different `name=`");
		expect(taken).not.toContain("already in flight");
	});

	it("keeps the shared prefix both callers and tests already match on", () => {
		const prefix =
			'Agent name "shared" is unavailable: an agent of that name already exists at depth 2 under this parent';
		expect(formatAgentSessionNameReserved("shared", 2).startsWith(prefix)).toBe(true);
		expect(formatAgentSessionNameUnavailable("shared", 2).startsWith(prefix)).toBe(true);
	});
});
