import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildCompactionRecoveryHint,
	buildSummarizationPromptText,
	COMPACTION_RECOVERY_HINT_THRESHOLD,
	clampConversationText,
	clampSummarizationInflation,
	computeSummarizationInputBudget,
	estimateTextTokens,
	isInputLengthRejection,
	SUMMARIZATION_INFLATION_CEILING,
	SUMMARIZATION_INPUT_RETRY_LIMIT,
	SUMMARIZATION_SAFETY_MARGIN,
	SUMMARIZATION_SYSTEM_PROMPT,
	type SummarySlice,
	summarizationFrameText,
	summarizationInflation,
	summarizeWithInputLengthRetry,
} from "../src/core/compaction/index.js";
import {
	catalogOverDeclaration,
	effectiveInputLimitTokens,
	MEASURED_PROVIDER_INPUT_LIMITS,
	measuredInputLimit,
} from "../src/core/model-input-limits.js";
import { isBuiltinSlashCommandName } from "../src/core/slash-commands.js";

/** The production shape: catalog says 1000000, DashScope accepts 983616 of input. */
const PROD = { provider: "bailian", modelId: "qwen3.8-max-0902" };
const PROD_WINDOW = 1_000_000;
const PROD_RESERVE = 16_384;
const PROD_INPUT_LIMIT = 983_616;
const DASHSCOPE_400 = "400 <400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 983616]";

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

function assistant(text: string, usage?: Usage, stopReason: AssistantMessage["stopReason"] = "stop"): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: usage ?? createUsage(0),
		stopReason,
		timestamp: Date.now(),
	} as AgentMessage;
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

describe("computeSummarizationInputBudget", () => {
	it("pays for the output reserve, system prompt, wrapper and margin before the conversation", () => {
		const budget = computeSummarizationInputBudget({
			contextWindow: PROD_WINDOW,
			reserveTokens: PROD_RESERVE,
			systemPromptText: "s".repeat(400), // 100 estimated tokens
			wrapperText: "w".repeat(2400), // 600 estimated tokens
			...PROD,
		});

		expect(budget.systemPromptTokens).toBe(100);
		expect(budget.wrapperTokens).toBe(600);
		expect(budget.outputReserve).toBe(PROD_RESERVE);
		expect(budget.safetyMarginTokens).toBe(Math.ceil(PROD_INPUT_LIMIT * SUMMARIZATION_SAFETY_MARGIN));
		expect(budget.conversationRealTokens).toBe(
			PROD_INPUT_LIMIT - PROD_RESERVE - 100 - 600 - budget.safetyMarginTokens,
		);
		// The pin: every part of the request the provider counts adds up to what it accepts.
		expect(
			budget.conversationRealTokens +
				budget.outputReserve +
				budget.systemPromptTokens +
				budget.wrapperTokens +
				budget.safetyMarginTokens,
		).toBeLessThanOrEqual(PROD_INPUT_LIMIT);
	});

	it("clamps a catalog window that declares more than the provider measured", () => {
		const budget = computeSummarizationInputBudget({
			contextWindow: PROD_WINDOW,
			reserveTokens: PROD_RESERVE,
			systemPromptText: SUMMARIZATION_SYSTEM_PROMPT,
			wrapperText: "",
			...PROD,
		});
		expect(budget.declaredContextWindow).toBe(PROD_WINDOW);
		expect(budget.inputLimit).toBe(PROD_INPUT_LIMIT);
		expect(budget.inputLimit).toBeLessThan(budget.declaredContextWindow);
	});

	it("keeps an unmeasured model on its declared window", () => {
		const budget = computeSummarizationInputBudget({
			contextWindow: 200_000,
			reserveTokens: 16_384,
			systemPromptText: SUMMARIZATION_SYSTEM_PROMPT,
			wrapperText: "",
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		});
		expect(budget.inputLimit).toBe(200_000);
	});

	it("converts the allowance into the estimator's caliber", () => {
		const budget = computeSummarizationInputBudget({
			contextWindow: PROD_WINDOW,
			reserveTokens: PROD_RESERVE,
			systemPromptText: SUMMARIZATION_SYSTEM_PROMPT,
			wrapperText: "",
			inflation: 1.6,
			...PROD,
		});
		expect(budget.conversationTokens).toBe(Math.floor(budget.conversationRealTokens / 1.6));
		expect(budget.conversationTokens).toBeLessThan(budget.conversationRealTokens);
	});

	it("honors an explicit margin and treats a non-positive one as none", () => {
		const common = {
			contextWindow: 100_000,
			reserveTokens: 1_000,
			systemPromptText: "s".repeat(400),
			wrapperText: "w".repeat(400),
		};
		expect(computeSummarizationInputBudget({ ...common, safetyMargin: 0 }).conversationRealTokens).toBe(
			100_000 - 1_000 - 100 - 100,
		);
		expect(computeSummarizationInputBudget({ ...common, safetyMargin: 0.1 }).conversationRealTokens).toBe(
			100_000 - 10_000 - 1_000 - 100 - 100,
		);
	});

	it("disables trimming when the window is unknown", () => {
		for (const contextWindow of [0, undefined]) {
			const budget = computeSummarizationInputBudget({
				contextWindow,
				reserveTokens: PROD_RESERVE,
				systemPromptText: SUMMARIZATION_SYSTEM_PROMPT,
				wrapperText: "",
			});
			expect(budget.inputLimit).toBe(0);
			expect(budget.conversationTokens).toBe(0);
		}
	});

	it("never returns a zero budget for a known window, because zero disables trimming", () => {
		// A frame that already fills the window must still trim to the newest message
		// instead of sending the whole conversation.
		const budget = computeSummarizationInputBudget({
			contextWindow: 10_000,
			reserveTokens: 1_000,
			systemPromptText: "s".repeat(200_000),
			wrapperText: "w".repeat(200_000),
		});
		expect(budget.conversationRealTokens).toBe(1);
		expect(budget.conversationTokens).toBe(1);
	});

	it("ignores a nonsensical inflation and falls back to the raw estimate", () => {
		for (const inflation of [0, -1, Number.NaN]) {
			const budget = computeSummarizationInputBudget({
				contextWindow: 100_000,
				reserveTokens: 0,
				systemPromptText: "",
				wrapperText: "",
				inflation,
				safetyMargin: 0,
			});
			expect(budget.inflation).toBe(1);
			expect(budget.conversationTokens).toBe(100_000);
		}
	});
});

describe("summarization request frame", () => {
	it("renders the history prompt exactly as the wire text", () => {
		expect(
			buildSummarizationPromptText({
				conversationText: "BODY",
				elided: 2,
				style: "history",
				instructions: "INSTR",
				previousSummary: "PREV",
			}),
		).toBe(
			"[Note: 2 older message(s) were elided to fit the summarization budget. Reflect any preserved prior summary instead of them.]\n" +
				"<conversation>\nBODY\n</conversation>\n\n" +
				"<previous-summary>\nPREV\n</previous-summary>\n\n" +
				"INSTR",
		);
	});

	it("renders the turn-prefix prompt without the previous-summary sentence", () => {
		expect(
			buildSummarizationPromptText({
				conversationText: "BODY",
				elided: 1,
				style: "turn-prefix",
				instructions: "INSTR",
			}),
		).toBe(
			"[Note: 1 older message(s) were elided to fit the summarization budget.]\n" +
				"<conversation>\nBODY\n</conversation>\n\n" +
				"INSTR",
		);
	});

	it("omits the note when nothing was elided", () => {
		const text = buildSummarizationPromptText({
			conversationText: "BODY",
			elided: 0,
			style: "history",
			instructions: "INSTR",
		});
		expect(text).not.toContain("were elided");
		expect(text).toBe("<conversation>\nBODY\n</conversation>\n\nINSTR");
	});

	it("measures the frame without the conversation and at the widest possible note", () => {
		const widest = summarizationFrameText({
			style: "history",
			instructions: "INSTR",
			previousSummary: "PREV",
			maxElidedMessages: 999,
		});
		expect(widest).toContain("999 older message(s)");
		expect(widest).toContain("<previous-summary>\nPREV\n</previous-summary>");
		expect(widest).toContain("<conversation>\n\n</conversation>");
		expect(widest).toContain("INSTR");
		// Any real elision count is at most this wide, so the measured frame can
		// never come out smaller than the request that is actually sent.
		for (const elided of [1, 7, 42, 999]) {
			const real = buildSummarizationPromptText({
				conversationText: "",
				elided,
				style: "history",
				instructions: "INSTR",
				previousSummary: "PREV",
			});
			expect(real.length).toBeLessThanOrEqual(widest.length);
		}
		expect(estimateTextTokens(widest)).toBe(Math.ceil(widest.length / 4));
	});
});

describe("clampConversationText", () => {
	it("leaves a conversation inside the budget alone", () => {
		expect(clampConversationText("abc", 10)).toEqual({ text: "abc", droppedChars: 0 });
		expect(clampConversationText("abcd".repeat(25), 25)).toEqual({ text: "abcd".repeat(25), droppedChars: 0 });
	});

	it("disables clamping with a non-positive budget", () => {
		const text = "z".repeat(1000);
		expect(clampConversationText(text, 0)).toEqual({ text, droppedChars: 0 });
	});

	it("keeps the newest characters and discloses the drop", () => {
		const text = "0123456789".repeat(200); // 2000 chars
		const budget = 100; // 400 chars
		const result = clampConversationText(text, budget);
		expect(result.text.length).toBeLessThanOrEqual(budget * 4);
		expect(result.droppedChars).toBeGreaterThan(0);
		expect(result.text).toContain(`${result.droppedChars} older characters`);
		expect(text.endsWith(result.text.slice(-100))).toBe(true);
		expect(result.droppedChars + (result.text.length - result.text.indexOf("\n") - 1)).toBe(text.length);
	});

	it("stays inside the budget for every size, including a degenerate one", () => {
		const budgets = [1, 2, 8, 30, 31, 100, 5000];
		expect(budgets.length).toBeGreaterThan(0);
		for (const budget of budgets) {
			const result = clampConversationText("q".repeat(50_000), budget);
			expect(result.text.length).toBeLessThanOrEqual(budget * 4);
			expect(result.droppedChars).toBeGreaterThan(0);
		}
	});
});

describe("isInputLengthRejection", () => {
	const positives = [
		DASHSCOPE_400,
		"prompt is too long: 213462 tokens > 200000 maximum",
		"Your input exceeds the context window of this model",
		"Requested token count exceeds the model's maximum context length of 262144 tokens",
		"context_length_exceeded",
		"Please reduce the length of the messages or completion",
	];
	expect(positives.length).toBeGreaterThan(0);
	it.each(positives)("treats an input-length rejection as retryable: %s", (message) => {
		expect(isInputLengthRejection(message)).toBe(true);
	});

	const negatives = [
		undefined,
		"",
		"500 upstream exploded",
		"Throttling error: Too many tokens, please wait before trying again.",
		"429 rate limit: too many tokens",
		"400 <400> InternalError.Algo.InvalidParameter: Range of max_tokens should be [1, 32768]",
	];
	expect(negatives.length).toBeGreaterThan(0);
	it.each(negatives)("does not treat %s as an input-length rejection", (message) => {
		expect(isInputLengthRejection(message)).toBe(false);
	});
});

describe("summarizationInflation", () => {
	it("anchors on the provider's own count of the slice", () => {
		const messages = [user("z".repeat(3990)), assistant("y".repeat(3990), createUsage(3200))];
		// 2 x ~1000 estimated tokens against 3200 provider tokens.
		expect(summarizationInflation(messages)).toBeCloseTo(1.6, 2);
	});

	it("falls back to the raw estimate without a usage anchor", () => {
		expect(summarizationInflation([user("z".repeat(4000))])).toBe(1);
		expect(summarizationInflation([])).toBe(1);
	});

	it("ignores aborted and errored turns, which carry no usable usage", () => {
		const messages = [
			user("z".repeat(3990)),
			assistant("y".repeat(3990), createUsage(99_999), "aborted"),
			assistant("y".repeat(3990), createUsage(99_999), "error"),
		];
		expect(summarizationInflation(messages)).toBe(1);
	});

	it("caps a slice that is only a fraction of the turn it was measured in", () => {
		const messages = [user("tiny"), assistant("ok", createUsage(500_000))];
		expect(summarizationInflation(messages)).toBe(SUMMARIZATION_INFLATION_CEILING);
	});

	it("clamps nonsense to the floor", () => {
		expect(clampSummarizationInflation(0.2)).toBe(1);
		expect(clampSummarizationInflation(Number.NaN)).toBe(1);
		expect(clampSummarizationInflation(Number.POSITIVE_INFINITY)).toBe(1);
		expect(clampSummarizationInflation(99)).toBe(SUMMARIZATION_INFLATION_CEILING);
	});
});

describe("summarizeWithInputLengthRetry", () => {
	const rejection = new Error(`Summarization failed: ${DASHSCOPE_400}`);

	it("shrinks the slice on every retry and stops at the bound", async () => {
		const inflations: number[] = [];
		let calls = 0;
		const result = await summarizeWithInputLengthRetry(async (options) => {
			inflations.push(options.inflation ?? 1);
			calls += 1;
			if (calls <= SUMMARIZATION_INPUT_RETRY_LIMIT) throw rejection;
			return { summary: "ok" } satisfies SummarySlice;
		}, 2);

		expect(result.summary).toBe("ok");
		expect(inflations).toEqual([2, 2.5, 3.125]);
	});

	it("gives up after the bounded number of attempts and reports the provider error", async () => {
		let calls = 0;
		await expect(
			summarizeWithInputLengthRetry(async () => {
				calls += 1;
				throw rejection;
			}, 1),
		).rejects.toThrow(/Range of input length/);
		expect(calls).toBe(SUMMARIZATION_INPUT_RETRY_LIMIT + 1);
	});

	it("does not retry an error that a smaller request cannot fix", async () => {
		let calls = 0;
		await expect(
			summarizeWithInputLengthRetry(async () => {
				calls += 1;
				throw new Error("Summarization failed: 500 upstream exploded");
			}, 1),
		).rejects.toThrow(/upstream exploded/);
		expect(calls).toBe(1);
	});

	it("does not retry once the caller aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		await expect(
			summarizeWithInputLengthRetry(
				async () => {
					calls += 1;
					throw rejection;
				},
				1,
				controller.signal,
			),
		).rejects.toThrow(/Range of input length/);
		expect(calls).toBe(1);
	});
});

describe("measured provider input limits", () => {
	it("records evidence for every measured limit and no duplicates", () => {
		expect(MEASURED_PROVIDER_INPUT_LIMITS.length).toBeGreaterThan(0);
		const keys = new Set<string>();
		for (const entry of MEASURED_PROVIDER_INPUT_LIMITS) {
			expect(entry.maxInputTokens).toBeGreaterThan(0);
			expect(entry.evidence.length).toBeGreaterThan(20);
			expect(entry.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			const key = `${entry.provider}/${entry.model}`;
			expect(keys.has(key)).toBe(false);
			keys.add(key);
		}
	});

	it("pins the measured Bailian limit that the production 400 reported", () => {
		expect(measuredInputLimit(PROD.provider, PROD.modelId)).toBe(PROD_INPUT_LIMIT);
		expect(effectiveInputLimitTokens(PROD_WINDOW, PROD.provider, PROD.modelId)).toBe(PROD_INPUT_LIMIT);
		expect(catalogOverDeclaration(PROD_WINDOW, PROD.provider, PROD.modelId)).toEqual({
			declared: PROD_WINDOW,
			measured: PROD_INPUT_LIMIT,
		});
	});

	it("reports no over-declaration for a catalog that stays within the measured limit", () => {
		expect(catalogOverDeclaration(PROD_INPUT_LIMIT, PROD.provider, PROD.modelId)).toBeUndefined();
		expect(catalogOverDeclaration(PROD_WINDOW, "anthropic", "claude-sonnet-4-5")).toBeUndefined();
	});

	it("falls back to the declaration for models that were never measured", () => {
		expect(effectiveInputLimitTokens(128_000, "bailian", "some-unmeasured-model")).toBe(128_000);
		expect(measuredInputLimit(undefined, undefined)).toBeUndefined();
		expect(effectiveInputLimitTokens(0, PROD.provider, PROD.modelId)).toBe(PROD_INPUT_LIMIT);
	});
});

describe("buildCompactionRecoveryHint", () => {
	it("names ways out of a session that cannot compact", () => {
		const hint = buildCompactionRecoveryHint(COMPACTION_RECOVERY_HINT_THRESHOLD);
		expect(hint).toContain(`${COMPACTION_RECOVERY_HINT_THRESHOLD} times in a row`);
		expect(hint).toContain("compaction.reserveTokens");
	});

	it("only advertises commands that exist", () => {
		const hint = buildCompactionRecoveryHint(4);
		const commands = [...hint.matchAll(/\/([a-z-]+)/g)].map((match) => match[1]);
		expect(commands.length).toBeGreaterThanOrEqual(5);
		for (const command of commands) {
			expect(isBuiltinSlashCommandName(command), `/${command} is not a builtin command`).toBe(true);
		}
	});
});
