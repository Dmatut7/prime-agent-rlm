/**
 * Input budgeting for summarization requests.
 *
 * A summarization call is a single request whose input the provider measures as
 * system prompt + wrapper (elision note, <conversation>/<previous-summary>
 * delimiters, instructions) + serialized conversation. Providers reject the whole
 * call when that input passes their limit, and the limit can sit below the
 * declared context window, so every part has to be paid for out of the same
 * budget. Budgeting only the conversation - the historical behavior - let the
 * wrapper push the request over the limit and turned compaction into a hard 400:
 * the session stayed above its threshold and every later attempt failed the same
 * way.
 */

import { effectiveInputLimitTokens } from "../model-input-limits.js";

/**
 * Fraction of the input limit held back for overhead no character count can see
 * (chat template, per-message framing, tokenizer drift). Two percent of a 1M
 * window is ~20k tokens, which is cheap insurance against a rejected compaction.
 */
export const SUMMARIZATION_SAFETY_MARGIN = 0.02;

/** Floor for the estimator correction: never assume the estimate is too high. */
export const SUMMARIZATION_INFLATION_FLOOR = 1;

/**
 * Ceiling for the estimator correction. The anchor is a whole-turn provider count
 * (system prompt and tool schemas included) divided by the estimate of the slice
 * being summarized, so it can read high when the slice is a small part of the
 * context; past this point extra caution only costs summary content.
 */
export const SUMMARIZATION_INFLATION_CEILING = 4;

/** Keep an estimator correction inside the floor/ceiling band. */
export function clampSummarizationInflation(inflation: number): number {
	if (!Number.isFinite(inflation)) return SUMMARIZATION_INFLATION_FLOOR;
	return Math.min(SUMMARIZATION_INFLATION_CEILING, Math.max(SUMMARIZATION_INFLATION_FLOOR, inflation));
}

/** Bounded retries after a provider rejects the request for input length. */
export const SUMMARIZATION_INPUT_RETRY_LIMIT = 2;

/** How much denser the next attempt assumes the content is (1.25 = +25%). */
export const SUMMARIZATION_INPUT_RETRY_SHRINK = 1.25;

/** Which elision note a request carries; the wording differs per call site. */
export type SummarizationNoteStyle = "history" | "turn-prefix";

/** Token estimate for plain prompt text, in the same chars/4 caliber as estimateTokens. */
export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function elidedNote(elided: number, style: SummarizationNoteStyle): string {
	if (elided <= 0) return "";
	const tail = style === "history" ? " Reflect any preserved prior summary instead of them." : "";
	return `[Note: ${elided} older message(s) were elided to fit the summarization budget.${tail}]\n`;
}

/**
 * Assemble the summarization user prompt: elision note, serialized conversation,
 * optional previous summary, then the instructions.
 */
export function buildSummarizationPromptText(options: {
	conversationText: string;
	elided: number;
	style: SummarizationNoteStyle;
	instructions: string;
	previousSummary?: string;
}): string {
	let text = elidedNote(options.elided, options.style);
	text += `<conversation>\n${options.conversationText}\n</conversation>\n\n`;
	if (options.previousSummary) {
		text += `<previous-summary>\n${options.previousSummary}\n</previous-summary>\n\n`;
	}
	return `${text}${options.instructions}`;
}

/**
 * Measure the request frame: everything the provider will count except the
 * serialized conversation itself. The previous summary and any user instructions
 * live in the frame and can be large, so they are measured before the
 * conversation is given a slice of the budget. The elision note is rendered at its
 * worst-case width (`maxElidedMessages`) because the real count is only known
 * after budgeting.
 */
export function summarizationFrameText(options: {
	style: SummarizationNoteStyle;
	instructions: string;
	previousSummary?: string;
	maxElidedMessages: number;
}): string {
	return buildSummarizationPromptText({
		conversationText: "",
		elided: options.maxElidedMessages,
		style: options.style,
		instructions: options.instructions,
		previousSummary: options.previousSummary,
	});
}

export interface SummarizationInputBudget {
	/** contextWindow as declared by the catalog. */
	declaredContextWindow: number;
	/** What the provider accepts as input: the declaration clamped by any measured limit. */
	inputLimit: number;
	/** Held back for the summary the request asks the model to produce. */
	outputReserve: number;
	systemPromptTokens: number;
	wrapperTokens: number;
	safetyMarginTokens: number;
	/** Provider tokens per estimated token, used to convert the allowance. */
	inflation: number;
	/** Allowance in provider-token caliber. */
	conversationRealTokens: number;
	/**
	 * Allowance in estimateTokens caliber, i.e. what budgetSummarizationInput and
	 * clampConversationText consume. 0 only when the window is unknown, which
	 * disables trimming; otherwise at least 1, so a frame that already fills the
	 * limit still trims to the newest message instead of sending everything.
	 */
	conversationTokens: number;
}

/**
 * Split a model's usable input across the parts of a summarization request.
 *
 * `inflation` converts provider tokens into the chars/4 estimate caliber the
 * trimmer works in; see summarizationInflation for where it comes from.
 *
 * The output reserve is subtracted from a measured input limit as well, even
 * though such a limit already excludes output: the request also asks for
 * `maxTokens` of completion, and spending the last of the input allowance on the
 * conversation is what produced the production 400 in the first place.
 */
export function computeSummarizationInputBudget(options: {
	contextWindow: number | undefined;
	reserveTokens: number;
	systemPromptText: string;
	wrapperText: string;
	provider?: string;
	modelId?: string;
	inflation?: number;
	safetyMargin?: number;
}): SummarizationInputBudget {
	const declaredContextWindow = options.contextWindow && options.contextWindow > 0 ? options.contextWindow : 0;
	const inputLimit = effectiveInputLimitTokens(declaredContextWindow, options.provider, options.modelId);
	const outputReserve = Math.max(0, options.reserveTokens);
	const systemPromptTokens = estimateTextTokens(options.systemPromptText);
	const wrapperTokens = estimateTextTokens(options.wrapperText);
	const inflation = options.inflation && options.inflation > 0 ? options.inflation : 1;
	const safetyMargin = options.safetyMargin ?? SUMMARIZATION_SAFETY_MARGIN;
	const safetyMarginTokens = Math.ceil(inputLimit * safetyMargin);
	if (inputLimit <= 0) {
		return {
			declaredContextWindow,
			inputLimit: 0,
			outputReserve,
			systemPromptTokens,
			wrapperTokens,
			safetyMarginTokens: 0,
			inflation,
			conversationRealTokens: 0,
			conversationTokens: 0,
		};
	}
	const conversationRealTokens = Math.max(
		1,
		inputLimit - outputReserve - systemPromptTokens - wrapperTokens - safetyMarginTokens,
	);
	return {
		declaredContextWindow,
		inputLimit,
		outputReserve,
		systemPromptTokens,
		wrapperTokens,
		safetyMarginTokens,
		inflation,
		conversationRealTokens,
		conversationTokens: Math.max(1, Math.floor(conversationRealTokens / inflation)),
	};
}

/**
 * Clamp a serialized conversation to a token budget by dropping its oldest
 * characters.
 *
 * The message-level trimmer always keeps the newest message, and serialization
 * re-renders tool arguments, so the text can still be over budget after trimming.
 * Sending it anyway means the provider rejects the whole compaction; dropping the
 * oldest characters keeps the request alive and says so in the text. The result is
 * guaranteed to be at most `tokenBudget * 4` characters.
 */
export function clampConversationText(
	conversationText: string,
	tokenBudget: number,
): { text: string; droppedChars: number } {
	if (tokenBudget <= 0) return { text: conversationText, droppedChars: 0 };
	const allowedChars = tokenBudget * 4;
	if (conversationText.length <= allowedChars) return { text: conversationText, droppedChars: 0 };
	const markerFor = (dropped: number) =>
		`[... ${dropped} older characters of the conversation were dropped to fit the summarization input budget]\n`;
	// Nothing larger can be dropped, so this is the widest marker the result can carry.
	const widest = markerFor(conversationText.length).length;
	if (widest >= allowedChars) {
		// Degenerate budget: no room left to disclose the drop, keep only the newest characters.
		return {
			text: conversationText.slice(conversationText.length - allowedChars),
			droppedChars: conversationText.length - allowedChars,
		};
	}
	const keepChars = allowedChars - widest;
	const dropped = conversationText.length - keepChars;
	return {
		text: markerFor(dropped) + conversationText.slice(conversationText.length - keepChars),
		droppedChars: dropped,
	};
}

/**
 * Error strings that mean "the request input was too long", i.e. the same request
 * with less content could succeed. Kept separate from packages/ai's overflow
 * detection because that one answers "did the conversation outgrow the window"
 * for a turn, while this one decides whether shrinking and retrying is worth a
 * second call.
 */
const INPUT_LENGTH_REJECTION_PATTERNS: readonly RegExp[] = [
	/range of input length/i, // Alibaba DashScope / Bailian compatible-mode
	/prompt is too long/i, // Anthropic
	/request_too_large/i, // Anthropic byte-size limit
	/input is too long/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI
	/input token count.*exceeds/i, // Google
	/maximum context length/i, // OpenRouter, LiteLLM
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/too large for model with \d+ maximum context length/i, // Mistral
	/prompt too long/i, // Ollama
	/context[_ ]length[_ ]exceeded/i, // generic
	/too many tokens/i, // generic
	/reduce the length of the messages/i, // Groq
	/token limit exceeded/i, // generic
];

/** Throttling wording that also contains "too many tokens"; never a shrinking target. */
const NOT_INPUT_LENGTH_PATTERNS: readonly RegExp[] = [/throttl/i, /rate limit/i, /too many requests/i];

/** Whether a provider error means the input was too long (retryable with less content). */
export function isInputLengthRejection(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	if (NOT_INPUT_LENGTH_PATTERNS.some((pattern) => pattern.test(errorMessage))) return false;
	return INPUT_LENGTH_REJECTION_PATTERNS.some((pattern) => pattern.test(errorMessage));
}
