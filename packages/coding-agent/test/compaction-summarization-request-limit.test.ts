import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	generateBranchSummary,
	generateSummary,
} from "../src/core/compaction/index.js";
import type { SessionMessageEntry } from "../src/core/session-manager.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

/**
 * A provider stub that enforces a hard input limit the way Bailian does: it
 * counts the whole request (system prompt + every message + per-message chat
 * template overhead) in ITS OWN caliber, which is `realTokensPerChar` and not
 * necessarily the chars/4 the estimator uses, and rejects the call wholesale
 * when the input is over the limit.
 */
interface RecordedRequest {
	tokens: number;
	chars: number;
	headers?: Record<string, string>;
}

function createLimitProvider(options: {
	hardInputLimit: number;
	realTokensPerChar?: number;
	perMessageTokens?: number;
	/** Reject the first N requests even when they are within the limit. */
	rejectFirst?: number;
}) {
	const realTokensPerChar = options.realTokensPerChar ?? 0.25;
	const perMessageTokens = options.perMessageTokens ?? 0;
	const recorded: RecordedRequest[] = [];
	let rejected = 0;
	completeSimpleMock.mockImplementation(
		async (
			_model: unknown,
			context: { systemPrompt?: string; messages: Array<{ content: Array<{ type: string; text?: string }> }> },
			callOptions?: { headers?: Record<string, string> },
		) => {
			const systemChars = (context.systemPrompt ?? "").length;
			let chars = systemChars;
			let tokens = Math.ceil(systemChars * realTokensPerChar);
			for (const message of context.messages) {
				tokens += perMessageTokens;
				for (const block of message.content) {
					if (block.type === "text" && block.text) {
						chars += block.text.length;
						tokens += Math.ceil(block.text.length * realTokensPerChar);
					}
				}
			}
			recorded.push({ tokens, chars, headers: callOptions?.headers });
			if (tokens > options.hardInputLimit || rejected < (options.rejectFirst ?? 0)) {
				rejected += 1;
				return errorResponse(
					`400 <400> InternalError.Algo.InvalidParameter: Range of input length should be [1, ${options.hardInputLimit}]`,
				);
			}
			return okResponse();
		},
	);
	return { recorded };
}

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function okResponse(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "## Goal\nSummarized." }],
		api: "openai-completions",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: createUsage(20),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function errorResponse(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: createUsage(0),
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

function createModel(options: { contextWindow: number; provider?: string; id?: string }): Model<"openai-completions"> {
	return {
		id: options.id ?? "claude-sonnet-4-5",
		name: "Test Model",
		api: "openai-completions",
		provider: options.provider ?? "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: options.contextWindow,
		maxTokens: 8192,
	};
}

function userMessage(chars: number, label: string): AgentMessage {
	return { role: "user", content: `${label}${"z".repeat(Math.max(0, chars - label.length))}`, timestamp: Date.now() };
}

/** ~1000 estimated tokens per message in the chars/4 caliber. */
function bigUserMessage(label: string): AgentMessage {
	return userMessage(4000, label);
}

function assistantMessageWithUsage(text: string, totalTokens: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp: Date.now(),
	} as AgentMessage;
}

function createPreparation(messages: AgentMessage[]): CompactionPreparation {
	return {
		firstKeptEntryId: "keep-1",
		messagesToSummarize: messages,
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 0,
		fileOps: createFileOps(),
		settings: { enabled: true, reserveTokens: RESERVE_TOKENS, keepRecentTokens: 20_000 },
	};
}

let branchEntryCounter = 0;
let branchParentId: string | null = null;

function branchEntry(message: AgentMessage): SessionMessageEntry {
	const id = `branch-entry-${branchEntryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: branchParentId,
		timestamp: new Date().toISOString(),
		message,
	};
	branchParentId = id;
	return entry;
}

function branchEntries(count: number, dense: boolean): SessionMessageEntry[] {
	const entries: SessionMessageEntry[] = [];
	for (let i = 0; i < count; i++) entries.push(branchEntry(bigUserMessage(`b${i} `)));
	if (dense) {
		// The provider's own count for this branch, 1.6x the chars/4 estimate.
		entries.push(branchEntry(assistantMessageWithUsage("done", Math.ceil(count * 1000 * 1.6))));
	}
	return entries;
}

function promptOf(callIndex: number): string {
	const context = completeSimpleMock.mock.calls[callIndex]?.[1] as {
		messages: Array<{ content: Array<{ type: string; text?: string }> }>;
	};
	return context.messages
		.flatMap((message) => message.content)
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Scaled-down stand-in for the production shape: window 1_000_000, provider input limit 983_616. */
const CONTEXT_WINDOW = 20_000;
const RESERVE_TOKENS = 512;
const HARD_INPUT_LIMIT = CONTEXT_WINDOW - RESERVE_TOKENS;

describe("summarization request stays inside the provider's real input limit", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
	});

	it("fits a provider whose input limit sits below the declared context window", async () => {
		const { recorded } = createLimitProvider({ hardInputLimit: HARD_INPUT_LIMIT, perMessageTokens: 4 });
		// Small messages fill the budget tightly, so the wrapper (system prompt,
		// instructions, <conversation> delimiters) is what pushes the request over.
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 400; i++) messages.push(userMessage(400, `m${i} `));

		const result = await generateSummary(
			messages,
			createModel({ contextWindow: CONTEXT_WINDOW }),
			RESERVE_TOKENS,
			"test-key",
		);

		expect(result.summary).toContain("Summarized");
		expect(recorded).toHaveLength(1);
		expect(recorded[0].tokens).toBeLessThanOrEqual(HARD_INPUT_LIMIT);
		expect(promptOf(0)).toContain("were elided");
	});

	it("holds back a margin for request overhead the estimator cannot see", async () => {
		// Chat-template/system overhead no char count can measure. The output reserve
		// is deliberately tiny here so the margin is the only thing covering it.
		const { recorded } = createLimitProvider({ hardInputLimit: CONTEXT_WINDOW, perMessageTokens: 300 });
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 400; i++) messages.push(userMessage(400, `m${i} `));

		const result = await generateSummary(messages, createModel({ contextWindow: CONTEXT_WINDOW }), 64, "test-key");

		expect(result.summary).toContain("Summarized");
		expect(recorded).toHaveLength(1);
		expect(recorded[0].tokens).toBeLessThanOrEqual(CONTEXT_WINDOW);
	});

	it("fits a provider that counts the same content denser than chars/4", async () => {
		// Production caliber: the failing session measured 614k estimated tokens
		// against 982k provider-reported prompt tokens (ratio ~1.6).
		const { recorded } = createLimitProvider({
			hardInputLimit: HARD_INPUT_LIMIT,
			realTokensPerChar: 0.4,
			perMessageTokens: 4,
		});
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 40; i++) messages.push(bigUserMessage(`m${i} `));
		// The provider's own accounting for this content anchors the ratio: every
		// message above is ~1000 estimated tokens and the provider counts 1.6x that.
		messages.push(assistantMessageWithUsage("done", Math.ceil(messages.length * 1000 * 1.6)));

		const result = await generateSummary(
			messages,
			createModel({ contextWindow: CONTEXT_WINDOW }),
			RESERVE_TOKENS,
			"test-key",
		);

		expect(result.summary).toContain("Summarized");
		expect(recorded).toHaveLength(1);
		expect(recorded[0].tokens).toBeLessThanOrEqual(HARD_INPUT_LIMIT);
	});

	it("retries with a smaller slice when the provider still rejects for input length", async () => {
		const { recorded } = createLimitProvider({ hardInputLimit: HARD_INPUT_LIMIT, rejectFirst: 1 });
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 40; i++) messages.push(bigUserMessage(`m${i} `));

		const identities: string[] = [];
		const result = await compact(
			createPreparation(messages),
			createModel({ contextWindow: CONTEXT_WINDOW }),
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			async (call) => {
				const identity = `req-${identities.length + 1}`;
				identities.push(identity);
				return call({ "x-request-id": identity });
			},
		);

		expect(result.summary).toContain("Summarized");
		expect(recorded).toHaveLength(2);
		expect(recorded[1].tokens).toBeLessThan(recorded[0].tokens);
		expect(recorded[1].tokens).toBeLessThanOrEqual(HARD_INPUT_LIMIT);
		// A shrunk body is a different wire call and must not reuse the first identity.
		expect(recorded[0].headers).toEqual({ "x-request-id": "req-1" });
		expect(recorded[1].headers).toEqual({ "x-request-id": "req-2" });
	});

	it("stops retrying and reports the provider error", async () => {
		const { recorded } = createLimitProvider({ hardInputLimit: HARD_INPUT_LIMIT, rejectFirst: 99 });
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 40; i++) messages.push(bigUserMessage(`m${i} `));

		await expect(
			compact(createPreparation(messages), createModel({ contextWindow: CONTEXT_WINDOW }), "test-key"),
		).rejects.toThrow(
			`Summarization failed: 400 <400> InternalError.Algo.InvalidParameter: Range of input length should be [1, ${HARD_INPUT_LIMIT}]`,
		);
		// One attempt plus the bounded retry budget, never an unbounded loop.
		expect(recorded).toHaveLength(3);
	});

	it("budgets the retry against the cap the provider announced", async () => {
		// A model with no measured limit on file whose provider accepts far less than
		// the catalog declares. The rejection states the real cap, so the retry is
		// exact instead of another guess: one rejection, then one fitting request.
		const REAL_LIMIT = 12_000;
		const { recorded } = createLimitProvider({ hardInputLimit: REAL_LIMIT, perMessageTokens: 4 });
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 40; i++) messages.push(bigUserMessage(`m${i} `));

		const result = await compact(
			createPreparation(messages),
			createModel({ contextWindow: CONTEXT_WINDOW }),
			"test-key",
		);

		expect(result.summary).toContain("Summarized");
		expect(recorded).toHaveLength(2);
		expect(recorded[0].tokens).toBeGreaterThan(REAL_LIMIT);
		expect(recorded[1].tokens).toBeLessThanOrEqual(REAL_LIMIT);
	});

	it("clamps a single newest message that alone exceeds the limit", async () => {
		const { recorded } = createLimitProvider({ hardInputLimit: HARD_INPUT_LIMIT, perMessageTokens: 4 });
		// budgetSummarizationInput always keeps the newest message, so one huge
		// paste used to be sent verbatim and rejected.
		const huge: AgentMessage = { role: "user", content: "h".repeat(400_000), timestamp: Date.now() };

		const result = await generateSummary(
			[huge],
			createModel({ contextWindow: CONTEXT_WINDOW }),
			RESERVE_TOKENS,
			"test-key",
		);

		expect(result.summary).toContain("Summarized");
		expect(recorded).toHaveLength(1);
		expect(recorded[0].tokens).toBeLessThanOrEqual(HARD_INPUT_LIMIT);
		expect(promptOf(0)).toContain("older characters");
	});

	it("counts a large previous summary and user instructions as request overhead", async () => {
		const { recorded } = createLimitProvider({ hardInputLimit: HARD_INPUT_LIMIT, perMessageTokens: 4 });
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 40; i++) messages.push(bigUserMessage(`m${i} `));
		const previousSummary = `## Goal\n${"s".repeat(20_000)}`;
		const customInstructions = `focus on ${"i".repeat(8_000)}`;

		const result = await generateSummary(
			messages,
			createModel({ contextWindow: CONTEXT_WINDOW }),
			RESERVE_TOKENS,
			"test-key",
			undefined,
			undefined,
			customInstructions,
			previousSummary,
		);

		expect(result.summary).toContain("Summarized");
		expect(recorded).toHaveLength(1);
		expect(recorded[0].tokens).toBeLessThanOrEqual(HARD_INPUT_LIMIT);
		expect(promptOf(0)).toContain("<previous-summary>");
	});

	it("surfaces a non-input-length provider error unchanged", async () => {
		completeSimpleMock.mockResolvedValue(errorResponse("500 upstream exploded"));
		await expect(
			generateSummary(
				[bigUserMessage("only ")],
				createModel({ contextWindow: CONTEXT_WINDOW }),
				RESERVE_TOKENS,
				"test-key",
			),
		).rejects.toThrow("Summarization failed: 500 upstream exploded");
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("keeps a branch summary request inside the provider's input limit", async () => {
		const { recorded } = createLimitProvider({ hardInputLimit: HARD_INPUT_LIMIT, perMessageTokens: 4 });

		const result = await generateBranchSummary(branchEntries(40, false), {
			model: createModel({ contextWindow: CONTEXT_WINDOW }),
			apiKey: "test-key",
			signal: new AbortController().signal,
			reserveTokens: RESERVE_TOKENS,
		});

		expect(result.error).toBeUndefined();
		expect(result.summary).toContain("Summarized");
		expect(recorded).toHaveLength(1);
		expect(recorded[0].tokens).toBeLessThanOrEqual(HARD_INPUT_LIMIT);
	});

	it("keeps a branch summary inside the limit when the provider counts denser than chars/4", async () => {
		const { recorded } = createLimitProvider({
			hardInputLimit: HARD_INPUT_LIMIT,
			realTokensPerChar: 0.4,
			perMessageTokens: 4,
		});

		const result = await generateBranchSummary(branchEntries(40, true), {
			model: createModel({ contextWindow: CONTEXT_WINDOW }),
			apiKey: "test-key",
			signal: new AbortController().signal,
			reserveTokens: RESERVE_TOKENS,
		});

		expect(result.error).toBeUndefined();
		expect(result.summary).toContain("Summarized");
		expect(recorded).toHaveLength(1);
		expect(recorded[0].tokens).toBeLessThanOrEqual(HARD_INPUT_LIMIT);
	});
	it("keeps a branch summary inside the limit when only the margin covers the framing", async () => {
		const { recorded } = createLimitProvider({ hardInputLimit: CONTEXT_WINDOW, perMessageTokens: 300 });
		// Small entries fill the budget tightly, so the frame (system prompt plus the
		// <conversation> wrapper and the instruction block) is what overflows it.
		const entries: SessionMessageEntry[] = [];
		for (let i = 0; i < 300; i++) entries.push(branchEntry(userMessage(400, `b${i} `)));

		const result = await generateBranchSummary(entries, {
			model: createModel({ contextWindow: CONTEXT_WINDOW }),
			apiKey: "test-key",
			signal: new AbortController().signal,
			reserveTokens: 64,
		});

		expect(result.error).toBeUndefined();
		expect(recorded).toHaveLength(1);
		expect(recorded[0].tokens).toBeLessThanOrEqual(CONTEXT_WINDOW);
	});
});
