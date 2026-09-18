import { afterEach, describe, expect, it } from "vitest";
import { HARNESS_DIGEST_CUSTOM_TYPE } from "../../src/core/messages.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { resolveCompleteToolPairLeaf } from "../../src/core/session-tool-pair.js";
import { assistantMsg, createTestSession, userMsg } from "../utilities.js";

function assistantWithTools(toolIds: string[]) {
	return {
		...assistantMsg("calling tools"),
		content: [
			{ type: "text" as const, text: "calling tools" },
			...toolIds.map((id) => ({
				type: "toolCall" as const,
				id,
				name: "read",
				arguments: { path: id },
			})),
		],
		stopReason: "toolUse" as const,
	};
}

function toolResultMsg(id: string) {
	return {
		role: "toolResult" as const,
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text" as const, text: `result for ${id}` }],
		isError: false,
		timestamp: Date.now(),
	};
}

function unpairedToolCallIds(messages: Array<{ role: string; content?: unknown; toolCallId?: string }>): string[] {
	const pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (
					typeof block === "object" &&
					block !== null &&
					(block as { type?: unknown }).type === "toolCall" &&
					typeof (block as { id?: unknown }).id === "string"
				) {
					pending.add((block as { id: string }).id);
				}
			}
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			pending.delete(message.toolCallId);
		} else if (message.role === "user") {
			pending.clear();
		}
	}
	return [...pending];
}

describe("resolveCompleteToolPairLeaf", () => {
	it("keeps a complete tool pair ending on the last toolResult", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("hi"));
		session.appendMessage(assistantWithTools(["tc-a", "tc-b"]));
		session.appendMessage(toolResultMsg("tc-a"));
		const last = session.appendMessage(toolResultMsg("tc-b"));
		const path = session.getBranch(last);
		expect(resolveCompleteToolPairLeaf(path)?.id).toBe(last);
	});

	it("snaps back before an assistant when the path ends on a partial toolResult", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage(userMsg("hi"));
		session.appendMessage(assistantWithTools(["tc-a", "tc-b"]));
		const partial = session.appendMessage(toolResultMsg("tc-a"));
		const path = session.getBranch(partial);
		expect(resolveCompleteToolPairLeaf(path)?.id).toBe(userId);
	});

	it("snaps back before an assistant when the path ends on unmatched toolCalls", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage(userMsg("hi"));
		const assistantId = session.appendMessage(assistantWithTools(["tc-a", "tc-b"]));
		const path = session.getBranch(assistantId);
		expect(resolveCompleteToolPairLeaf(path)?.id).toBe(userId);
	});

	it("keeps an assistant with no tool calls", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("hi"));
		const assistantId = session.appendMessage(assistantMsg("done"));
		const path = session.getBranch(assistantId);
		expect(resolveCompleteToolPairLeaf(path)?.id).toBe(assistantId);
	});
});

describe("SessionManager branch/fork cut points", () => {
	it("branch() refuses to sit on a partial tool pair", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage(userMsg("hi"));
		session.appendMessage(assistantWithTools(["tc-a", "tc-b"]));
		const partial = session.appendMessage(toolResultMsg("tc-a"));

		session.branch(partial);

		expect(session.getLeafId()).toBe(userId);
		expect(unpairedToolCallIds(session.buildSessionContext().messages)).toEqual([]);
	});

	it("createBranchedSession drops an incomplete tool pair so the new context has no orphan toolCall", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage(userMsg("hi"));
		session.appendMessage(assistantWithTools(["tc-a", "tc-b"]));
		const partial = session.appendMessage(toolResultMsg("tc-a"));
		session.appendMessage(toolResultMsg("tc-b"));
		session.appendMessage(userMsg("later"));

		session.createBranchedSession(partial);

		expect(session.getEntries().map((entry) => entry.id)).toEqual([userId]);
		expect(unpairedToolCallIds(session.buildSessionContext().messages)).toEqual([]);
	});

	it("createBranchedSession keeps a complete tool pair", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage(userMsg("hi"));
		const assistantId = session.appendMessage(assistantWithTools(["tc-a", "tc-b"]));
		const firstResult = session.appendMessage(toolResultMsg("tc-a"));
		const lastResult = session.appendMessage(toolResultMsg("tc-b"));

		session.createBranchedSession(lastResult);

		expect(session.getEntries().map((entry) => entry.id)).toEqual([userId, assistantId, firstResult, lastResult]);
		expect(unpairedToolCallIds(session.buildSessionContext().messages)).toEqual([]);
	});
});

describe("navigateTree cut points", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	it("navigating to a partial toolResult leaves no orphan toolCall in the new branch context", async () => {
		const ctx = createTestSession({ inMemory: true });
		cleanups.push(ctx.cleanup);

		const userId = ctx.sessionManager.appendMessage(userMsg("hi"));
		ctx.sessionManager.appendMessage(assistantWithTools(["tc-a", "tc-b"]));
		const partial = ctx.sessionManager.appendMessage(toolResultMsg("tc-a"));
		ctx.sessionManager.appendMessage(toolResultMsg("tc-b"));
		ctx.sessionManager.appendMessage(userMsg("later"));

		const result = await ctx.session.navigateTree(partial, { summarize: false });

		expect(result.cancelled).toBe(false);
		// Tree navigation is a cold boundary (#2098): a fresh harness digest rides on top
		// of the navigated-to node, so the snap-back target is that entry's parent. The
		// pin still names the exact entry the tool-pair walk landed on.
		const leafId = ctx.sessionManager.getLeafId();
		const leaf = leafId === null ? undefined : ctx.sessionManager.getEntry(leafId);
		const navigatedLeafId =
			leaf?.type === "custom_message" && leaf.customType === HARNESS_DIGEST_CUSTOM_TYPE ? leaf.parentId : leafId;
		expect(navigatedLeafId).toBe(userId);
		expect(unpairedToolCallIds(ctx.session.agent.state.messages)).toEqual([]);
	});
});

describe("branch away-and-back idempotency (B2)", () => {
	it("restores the exact original context when the head tail is a complete tool pair", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage(userMsg("hi"));
		session.appendMessage(assistantWithTools(["tc-1"]));
		const headId = session.appendMessage(toolResultMsg("tc-1"));
		const before = session.buildSessionContext().messages;

		session.branch(userId);
		session.branch(headId);

		expect(session.getLeafId()).toBe(headId);
		expect(session.buildSessionContext().messages).toEqual(before);
	});

	it("restores the exact original context when a trailing user message abandoned the unpaired toolCall", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage(userMsg("hi"));
		session.appendMessage(assistantWithTools(["tc-a"]));
		const headId = session.appendMessage(userMsg("after"));
		const before = session.buildSessionContext().messages;

		session.branch(userId);
		session.branch(headId);

		expect(session.getLeafId()).toBe(headId);
		expect(session.buildSessionContext().messages).toEqual(before);
	});

	it("lands away-and-back on the snapped cut deterministically and keeps the dropped entry in the transcript", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("hi"));
		session.appendMessage(assistantWithTools(["tc-1"]));
		const resultId = session.appendMessage(toolResultMsg("tc-1"));
		const orphanAssistantId = session.appendMessage(assistantWithTools(["tc-2"]));

		for (let round = 0; round < 2; round++) {
			session.branch(resultId);
			session.branch(orphanAssistantId);

			// The snap from the tool-pair cut: branch never sits on an unpaired
			// toolCall, so returning to this head lands one entry short of the
			// leaf the session held before the round trip.
			expect(session.getLeafId()).toBe(resultId);
			expect(session.buildSessionContext().messages).toEqual([
				expect.objectContaining({ role: "user" }),
				expect.objectContaining({ role: "assistant" }),
				expect.objectContaining({ role: "toolResult", toolCallId: "tc-1" }),
			]);
		}

		// The excluded entry is dropped from the context, not from the transcript.
		expect(session.getEntries().map((entry) => entry.id)).toContain(orphanAssistantId);
	});
});
