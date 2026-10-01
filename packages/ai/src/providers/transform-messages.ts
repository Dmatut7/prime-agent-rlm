import { getLogger } from "../log.js";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.js";

// A conversation can hand a turn with images to an image-capable model and the rest
// back to a text-only one. Read bare, "omitted" made the text-only model conclude that
// nobody had seen the image and disown the reply that described it, so the placeholder
// says who did. It also says how to get another look: a text-only model that only
// knows the image is gone guesses at details the description left out.
const SEEN_BY_OTHER_MODEL_NOTE =
	"If the next assistant reply describes it, an image-capable model that did see it wrote that reply. " +
	"If a detail you need is not in that description and the conversation gives the image's file path, " +
	"loading that file again as an image lets an image-capable model look at it.";
const NON_VISION_USER_IMAGE_PLACEHOLDER = `(image not shown to this model, which does not take image input. ${SEEN_BY_OTHER_MODEL_NOTE})`;
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = `(tool image not shown to this model, which does not take image input. ${SEEN_BY_OTHER_MODEL_NOTE})`;

const logger = getLogger("transform-messages");

// Cross-model replay flattens thinking into assistant text, so under a provider
// fallback chain every older turn's full reasoning would be re-sent on every
// request. Only the most recent replayed turn keeps the flattened text; earlier
// turns get this marker, which is enough to tell the new model that reasoning
// happened there without paying for it again.
const CROSS_MODEL_THINKING_PLACEHOLDER = "[prior reasoning omitted]";

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

/**
 * Bounded trace of an abort cause: REPL-visible evidence the turn was cut short (MV-4).
 */
const ABORT_TRACE_TEXT_LIMIT = 200;

function abortTraceText(errorMessage: string | undefined): string | undefined {
	if (typeof errorMessage !== "string" || errorMessage.trim() === "") return undefined;
	const compact = errorMessage.trim().replace(/\s+/g, " ");
	// Codepoint-aware truncation: slicing a surrogate pair in half breaks providers.
	const chars = Array.from(compact);
	if (chars.length <= ABORT_TRACE_TEXT_LIMIT) return `[assistant turn aborted: ${compact}]`;
	return `[assistant turn aborted: ${chars.slice(0, ABORT_TRACE_TEXT_LIMIT - 1).join("")}…]`;
}

/**
 * An aborted assistant turn replays only what is safe: its text blocks plus a
 * bounded trace of the abort cause. Partial thinking and incomplete tool calls
 * are dropped (replaying them causes API errors), and a turn with neither text
 * nor cause disappears unless one of its orphaned tool results materializes a
 * trace (see the toolResult branch of transformMessages).
 */
function abortedAssistantTrace(message: AssistantMessage): AssistantMessage | undefined {
	const textBlocks = message.content.filter(
		(block): block is TextContent => block.type === "text" && block.text.trim().length > 0,
	);
	const trace = abortTraceText(message.errorMessage);
	if (textBlocks.length === 0 && trace === undefined) return undefined;
	const content: AssistantMessage["content"] = [...textBlocks];
	if (trace !== undefined) {
		content.push({ type: "text", text: trace });
	}
	return { ...message, content };
}

/**
 * Bound on one folded tool-result text. Harvested results are already capped at
 * the producer's 8 KiB; this keeps a replayed transcript from injecting more.
 */
const ABORT_TRACE_TOOL_RESULT_TEXT_LIMIT = 8 * 1024;

/**
 * Text of a tool result orphaned by an aborted turn, folded into the abort trace
 * so the partial evidence the abort harvest preserved reaches the model after
 * recovery instead of being dropped with its stripped tool call.
 */
function abortedToolResultText(message: ToolResultMessage): string | undefined {
	const text = message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (text.length === 0) return undefined;
	// Codepoint-aware truncation, same as the cause trace above.
	const chars = Array.from(text);
	const bounded =
		chars.length <= ABORT_TRACE_TOOL_RESULT_TEXT_LIMIT
			? text
			: `${chars.slice(0, ABORT_TRACE_TOOL_RESULT_TEXT_LIMIT - 1).join("")}…`;
	return `[tool result from aborted turn (${message.toolName})]\n${bounded}`;
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	const toolCallIdMap = new Map<string, string>();
	const imageAwareMessages = downgradeUnsupportedImages(messages, model);

	// Errored turns are skipped in the pairing pass below and never reach the
	// provider, so the most recent turn they could shadow is the one before them.
	let lastReplayableAssistantIndex = -1;
	for (let i = 0; i < imageAwareMessages.length; i++) {
		const candidate = imageAwareMessages[i];
		if (candidate.role === "assistant" && (candidate as AssistantMessage).stopReason !== "error") {
			lastReplayableAssistantIndex = i;
		}
	}

	const transformed = imageAwareMessages.map((msg, index) => {
		if (msg.role === "user") {
			return msg;
		}

		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;
			const isMostRecentTurn = index === lastReplayableAssistantIndex;
			let crossModelThinkingOmitted = false;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// Redacted thinking is opaque encrypted content, only valid for the same model.
					// Drop it for cross-model to avoid API errors.
					if (block.redacted) {
						return isSameModel ? block : [];
					}
					// For same model: keep thinking blocks with signatures (needed for replay)
					// even if the thinking text is empty (OpenAI encrypted reasoning)
					if (isSameModel && block.thinkingSignature) return block;
					// Skip empty thinking blocks, convert others to plain text
					if (!block.thinking || block.thinking.trim() === "") return [];
					if (isSameModel) return block;
					if (isMostRecentTurn) {
						return {
							type: "text" as const,
							text: block.thinking,
						};
					}
					// One placeholder per older turn, not one per block.
					if (crossModelThinkingOmitted) return [];
					crossModelThinkingOmitted = true;
					return {
						type: "text" as const,
						text: CROSS_MODEL_THINKING_PLACEHOLDER,
					};
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// This preserves thinking signatures and satisfies API requirements
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	// The most recent aborted assistant turn, whose stripped tool calls leave the
	// turn's tool results orphaned: their text folds into this turn's trace.
	let pendingAbortedTurn: { source: AssistantMessage; trace: AssistantMessage | undefined } | undefined;
	const insertSyntheticToolResults = () => {
		if (pendingToolCalls.length > 0) {
			for (const tc of pendingToolCalls) {
				if (!existingToolResultIds.has(tc.id)) {
					// The provider requires a result for every call, so the missing one is
					// replaced with an explicit error result. Log it: the transcript on disk
					// says nothing about a result the provider will see.
					logger.warn("Synthesized a tool result for a call without one", {
						toolCallId: tc.id,
						toolName: tc.name,
						replacement: "No result provided",
					});
					result.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: "No result provided" }],
						isError: true,
						timestamp: Date.now(),
					} as ToolResultMessage);
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}
	};

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (msg.role === "assistant") {
			insertSyntheticToolResults();
			pendingAbortedTurn = undefined;

			// Skip errored assistant messages entirely.
			// These are incomplete turns that shouldn't be replayed:
			// - May have partial content (reasoning without message, incomplete tool calls)
			// - Replaying them can cause API errors (e.g., OpenAI "reasoning without following item")
			// - The model should retry from the last valid state
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error") {
				continue;
			}
			if (assistantMsg.stopReason === "aborted") {
				// An aborted turn has no tool result of its own to carry the abort
				// cause (MV-4), so drop it entirely only when there is nothing safe
				// to keep: partial thinking and incomplete tool calls are still
				// stripped, because replaying them is what the omission was for.
				// The results those calls left behind fold into the trace as they
				// arrive (see the toolResult branch), so the abort harvest is not
				// silently lost.
				const abortedTrace = abortedAssistantTrace(assistantMsg);
				if (abortedTrace) {
					result.push(abortedTrace);
				}
				pendingAbortedTurn = { source: assistantMsg, trace: abortedTrace };
				continue;
			}

			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			if (!pendingToolCalls.some((toolCall) => toolCall.id === msg.toolCallId)) {
				// A result whose call was stripped with its aborted turn still carries
				// the partial evidence the abort harvest preserved: fold its text into
				// the abort trace (materializing one when the turn left neither text
				// nor cause) instead of dropping it.
				if (pendingAbortedTurn) {
					const folded = abortedToolResultText(msg);
					if (folded !== undefined) {
						if (!pendingAbortedTurn.trace) {
							pendingAbortedTurn.trace = { ...pendingAbortedTurn.source, content: [] };
							result.push(pendingAbortedTurn.trace);
						}
						pendingAbortedTurn.trace.content.push({ type: "text", text: folded });
					}
					continue;
				}
				// Dropping is required (a result without its call is rejected by the API), but it
				// must not be silent: the caller has to be able to see that the context changed.
				logger.warn("Dropped a tool result that matches no tool call in the preceding assistant turn", {
					toolCallId: msg.toolCallId,
					toolName: msg.toolName,
					pendingToolCallIds: pendingToolCalls.map((toolCall) => toolCall.id),
				});
				continue;
			}
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "user") {
			insertSyntheticToolResults();
			pendingAbortedTurn = undefined;
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	insertSyntheticToolResults();

	return result;
}
