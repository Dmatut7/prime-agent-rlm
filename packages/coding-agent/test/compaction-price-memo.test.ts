/**
 * The content-price memo behind the compaction trigger: a transcript is walked
 * character by character once per change, not once per read.
 *
 * Why this exists: the trigger reads the whole context at every turn boundary - the
 * shouldStopAfterTurn hook, agent_end and the admission gate, and
 * `_getThresholdContextTokens` reads twice on its own - and with no provider usage
 * anchor each read prices every character of every message. perfC measured one read
 * of a 50MB branch at p50 468ms / max 1180ms and a turn boundary at p50 1342ms, all
 * of it synchronous (EVIDENCE/compaction/trigger-idle.json). A transcript grows by
 * appending, so nearly all of that is repricing messages that have not changed.
 *
 * The observable here is a call count on `measureContentDensity`, which is the
 * character walk itself: "how many times did the trigger walk the transcript" is a
 * number a test can hold, and the counter wraps the real implementation so every
 * count is a walk that actually happened.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { estimateContextTokens, estimateTokensByContent } from "../src/core/compaction/index.js";

const walks = vi.hoisted(() => ({ count: 0 }));

vi.mock("../src/core/compaction/content-density.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/compaction/content-density.js")>();
	return {
		...actual,
		measureContentDensity: (text: string) => {
			walks.count += 1;
			return actual.measureContentDensity(text);
		},
	};
});

function usage(): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as unknown as AgentMessage;
}

function assistantMessage(text: string, thinking: string, toolArgs: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "thinking", thinking },
			{ type: "toolCall", id: "tc-1", name: "bash", arguments: toolArgs },
		],
		// stopReason "error" keeps this out of the usage anchor, so the estimate has
		// to price the transcript by content - the shape the memo exists for.
		usage: usage(),
		stopReason: "error",
		timestamp: Date.now(),
		api: "faux",
		provider: "faux",
		model: "faux-1",
	} as unknown as AssistantMessage as AgentMessage;
}

function toolResultMessage(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "tc-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

function bashMessage(command: string, output: string): AgentMessage {
	return {
		role: "bashExecution",
		command,
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

function customMessage(content: string): AgentMessage {
	return {
		role: "custom",
		customType: "refinement_outcome",
		content,
		display: true,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

function summaryMessage(role: "compactionSummary" | "branchSummary", summary: string): AgentMessage {
	return { role, summary, tokensBefore: 100, timestamp: Date.now() } as unknown as AgentMessage;
}

function imageMessage(text: string, images: number): AgentMessage {
	const content: Array<Record<string, unknown>> = [{ type: "text", text }];
	for (let i = 0; i < images; i++) content.push({ type: "image", data: "AAAA", mimeType: "image/png" });
	return { role: "user", content, timestamp: Date.now() } as unknown as AgentMessage;
}

/** Every shape collectMessageEstimateParts prices, one message each. */
function shapeCorpus(): AgentMessage[] {
	return [
		userMessage("plain user text"),
		userMessage(""),
		imageMessage("with an image", 1),
		imageMessage("with three images", 3),
		assistantMessage("assistant text", "assistant thinking", { command: "ls -la" }),
		assistantMessage("nested args", "t", { path: "a/b.md", old_str: "x".repeat(50), nested: { deep: [1, 2, 3] } }),
		toolResultMessage("tool output with 中文 and ```ts fences"),
		toolResultMessage(""),
		bashMessage("git status", "On branch main"),
		customMessage("custom content"),
		summaryMessage("compactionSummary", "a compaction summary"),
		summaryMessage("branchSummary", "a branch summary"),
	];
}

/** A transcript with no readable usage anchor, so every read prices every message. */
function transcript(count: number): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let i = 0; i < count; i++) {
		switch (i % 5) {
			case 0:
				messages.push(userMessage(`task ${i} ${"request ".repeat(6)}`));
				break;
			case 1:
				messages.push(assistantMessage(`step ${i} ${"work ".repeat(6)}`, `thinking ${i}`, { command: `cmd-${i}` }));
				break;
			case 2:
				messages.push(toolResultMessage(`output ${i} ${"lines ".repeat(6)}`));
				break;
			case 3:
				messages.push(bashMessage(`command ${i}`, `output ${i} ${"bytes ".repeat(6)}`));
				break;
			default:
				messages.push(customMessage(`notice ${i} ${"text ".repeat(6)}`));
				break;
		}
	}
	return messages;
}

/**
 * The oracle: a copy of the message is a different object, so the memo cannot have
 * priced it yet and the number it returns is the uncached one.
 */
function uncached(message: AgentMessage): number {
	return estimateTokensByContent(structuredClone(message) as AgentMessage);
}

function uncachedTotal(messages: AgentMessage[]): number {
	return messages.reduce((total, message) => total + uncached(message), 0);
}

beforeEach(() => {
	walks.count = 0;
});

describe("estimateTokensByContent memo", () => {
	it("prices every shape the same as an uncached copy, before and after a change", () => {
		const corpus = shapeCorpus();
		expect(corpus.length).toBeGreaterThan(0);
		for (const message of corpus) {
			expect(estimateTokensByContent(message)).toBe(uncached(message));
			// Read again from the memo, then again from a copy: the memoized number has
			// to survive being compared against a price computed from scratch.
			const memoized = estimateTokensByContent(message);
			expect(memoized).toBe(uncached(message));
		}
	});

	it("re-prices a message whose content grew, and reports the grown price", () => {
		const corpus = shapeCorpus();
		expect(corpus.length).toBeGreaterThan(0);
		for (const message of corpus) {
			const before = estimateTokensByContent(message);
			expect(before).toBe(uncached(message));
			grow(message);
			const after = estimateTokensByContent(message);
			expect(after, "a grown message prices at least what it did").toBeGreaterThanOrEqual(before);
			expect(after).toBe(uncached(message));
		}
	});

	it("counts one walk for the whole transcript and none for the reads that follow", () => {
		const messages = transcript(40);
		const first = estimateContextTokens(messages);
		const firstWalks = walks.count;
		// Positive control on the counter itself: the first read of a 40-message
		// transcript with no usage anchor has to walk it, once per priced text - 9 per
		// cycle of the five shapes below, so 72 for 40 messages.
		expect(firstWalks).toBe(72);
		expect(first.lastUsageIndex).toBeNull();
		// The oracle walks the copies it prices, so it moves the counter; what the
		// reads that follow may add is measured from zero.
		expect(first.tokens).toBe(uncachedTotal(messages));
		expect(walks.count).toBe(firstWalks * 2);
		walks.count = 0;

		// A turn boundary reads the trigger three times (hook, agent_end, admission),
		// and _getThresholdContextTokens reads twice on its own: five reads, one walk.
		for (let read = 0; read < 4; read++) {
			const again = estimateContextTokens(messages);
			expect(again).toEqual(first);
			expect(walks.count, `read ${read + 2} walked the transcript again`).toBe(0);
		}
	});

	it("walks only the message that changed, not the transcript around it", () => {
		const messages = transcript(40);
		const cold = estimateContextTokens(messages);
		const coldWalks = walks.count;
		expect(coldWalks).toBeGreaterThan(20);

		// A user message with string content is one priced text.
		walks.count = 0;
		const target = messages[0] as { content: string };
		target.content = `${target.content} and one more sentence`;
		const after = estimateContextTokens(messages);
		expect(walks.count, "only the changed message is walked").toBe(1);
		expect(after.tokens).toBeGreaterThan(cold.tokens);
		expect(after.tokens).toBe(uncachedTotal(messages));

		// A bashExecution prices its command and its output: two texts.
		walks.count = 0;
		const bash = messages[3] as { output: string };
		bash.output = `${bash.output} appended`;
		estimateContextTokens(messages);
		expect(walks.count).toBe(2);

		// Appending a new message walks the new one only.
		walks.count = 0;
		messages.push(userMessage("a brand new message"));
		const appended = estimateContextTokens(messages);
		expect(walks.count).toBe(1);
		expect(appended.tokens).toBe(uncachedTotal(messages));
	});

	it("re-prices a tool call whose arguments were replaced or rewritten", () => {
		const message = assistantMessage("text", "thinking", { command: "ls" });
		const before = estimateTokensByContent(message);
		expect(before).toBe(uncached(message));
		const content = (message as AssistantMessage).content;
		const call = content[2] as { arguments: Record<string, unknown> };

		// Each step reads the memo first and counts only that read: the uncached
		// oracle below walks too, so a count taken after it would pass on its own.
		const changedBy = (change: () => void, label: string): void => {
			change();
			walks.count = 0;
			const memoized = estimateTokensByContent(message);
			const memoWalks = walks.count;
			expect(memoWalks, label).toBeGreaterThan(0);
			expect(memoized, label).toBe(uncached(message));
		};

		// The stream's shape: a freshly parsed arguments object replaces the old one.
		changedBy(() => {
			call.arguments = { command: "ls -la /tmp" };
		}, "a replaced arguments object is a change");
		// The shape a footprint keyed on identity alone would miss: the same object,
		// a different value in it.
		changedBy(() => {
			call.arguments.command = "npm run test -- --run";
		}, "a rewritten argument value is a change");
		// A key added to the same object.
		changedBy(() => {
			call.arguments.timeout = 30;
		}, "an added argument key is a change");
	});

	it("re-prices a text block rewritten in place, including one that keeps its length", () => {
		const message = toolResultMessage("the report says the gate passed");
		const before = estimateTokensByContent(message);
		expect(before).toBe(uncached(message));
		const content = (message as { content: Array<{ type: string; text?: string }> }).content;

		// The memo read is counted on its own: the uncached oracle walks as well, so a
		// counter read after it would pass even for a price the memo wrongly kept.
		const rewritten = (write: () => void, label: string): number => {
			write();
			walks.count = 0;
			const memoized = estimateTokensByContent(message);
			const memoWalks = walks.count;
			expect(memoWalks, label).toBeGreaterThan(0);
			expect(memoized, label).toBe(uncached(message));
			return memoized;
		};

		const grown = rewritten(() => {
			content[0].text = "the report says the gate FAILED, and failed loudly";
		}, "a grown text is a change");

		// Same length, same character class for class, different code units: no length
		// or block count can see this, only the footprint's sampled positions.
		// Upper-casing touches every letter, so the case does not depend on where the
		// sample reads - a rewrite confined to unsampled interior positions is the
		// documented blind spot of a sample, and estimateTokensByContent says so.
		const current = content[0].text ?? "";
		const swapped = current.toUpperCase();
		expect(swapped.length).toBe(current.length);
		expect(swapped).not.toBe(current);
		const afterSwap = rewritten(() => {
			content[0].text = swapped;
		}, "a same-length rewrite is a change");
		// Both spellings are ASCII of one length, so they price alike: no number can
		// prove the memo re-walked here, only the counter read above can. That is why
		// the counter is read before the oracle rather than after it.
		expect(afterSwap, "a same-length ASCII rewrite prices the same").toBe(grown);

		// A block added to the same message.
		rewritten(() => {
			content.push({ type: "text", text: "a second block" });
		}, "an added block is a change");
	});

	it("prices an image by its count, and re-prices when the count changes", () => {
		const message = imageMessage("screenshot attached", 1);
		const one = estimateTokensByContent(message);
		expect(one).toBe(uncached(message));
		const content = (message as unknown as { content: Array<Record<string, unknown>> }).content;

		walks.count = 0;
		content.push({ type: "image", data: "BBBB", mimeType: "image/png" });
		const twoWalks = estimateTokensByContent(message);
		const addedWalks = walks.count;
		expect(twoWalks).toBe(uncached(message));
		expect(twoWalks).toBeGreaterThan(one);
		expect(addedWalks, "an added image is a change").toBeGreaterThan(0);

		// An image swapped for an empty text block keeps the block count and adds no
		// characters, so the image count is the only field of the footprint that can
		// see it - and the price drops by exactly one image.
		walks.count = 0;
		content[content.length - 1] = { type: "text", text: "" };
		const swapped = estimateTokensByContent(message);
		const swappedWalks = walks.count;
		expect(swapped).toBe(uncached(message));
		expect(swapped).toBe(one);
		expect(swappedWalks, "an image replaced by an empty block is a change").toBeGreaterThan(0);
	});

	it("keeps the usage-anchored caliber exact: only the tail after the anchor is priced", () => {
		const messages = transcript(10);
		const anchored = assistantMessage("final answer", "reasoning", { command: "true" });
		(anchored as AssistantMessage).stopReason = "stop";
		messages.push(anchored);
		messages.push(userMessage("and one more request after the anchor"));

		const first = estimateContextTokens(messages);
		expect(first.lastUsageIndex).toBe(messages.length - 2);
		const firstWalks = walks.count;
		expect(firstWalks).toBeGreaterThan(0);
		expect(first.usageTokens).toBe(15);
		const second = estimateContextTokens(messages);
		expect(second).toEqual(first);
		expect(walks.count, "the anchored read is memoized too").toBe(firstWalks);
	});
});

/** Grow whatever a message prices, in the way its own writer would. */
function grow(message: AgentMessage): void {
	switch (message.role) {
		case "user":
		case "custom": {
			const target = message as { content: unknown };
			if (typeof target.content === "string") target.content = `${target.content} more`;
			else if (Array.isArray(target.content)) {
				const block = target.content.find((item) => item?.type === "text") as { text?: string } | undefined;
				if (block) block.text = `${block.text ?? ""} more`;
				else target.content.push({ type: "text", text: "more" });
			}
			return;
		}
		case "toolResult": {
			const content = (message as { content: Array<{ type: string; text?: string }> }).content;
			const block = content.find((item) => item.type === "text");
			if (block) block.text = `${block.text ?? ""} more`;
			else content.push({ type: "text", text: "more" });
			return;
		}
		case "assistant": {
			const content = (message as AssistantMessage).content as unknown as Array<Record<string, unknown>>;
			const text = content.find((block) => block.type === "text");
			if (text) text.text = `${String(text.text)} more`;
			const call = content.find((block) => block.type === "toolCall");
			if (call) {
				const args = call.arguments as Record<string, unknown>;
				args.appended = "a new argument";
			}
			return;
		}
		case "bashExecution": {
			const target = message as { output: string };
			target.output = `${target.output} more`;
			return;
		}
		case "branchSummary":
		case "compactionSummary": {
			const target = message as { summary: string };
			target.summary = `${target.summary} more`;
			return;
		}
	}
}
