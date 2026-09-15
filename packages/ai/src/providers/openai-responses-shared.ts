import type OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseFunctionCallOutputItemList,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { getLogger } from "../log.js";
import { calculateCost } from "../models.js";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	StopReason,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "../types.js";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { shortHash } from "../utils/hash.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { classifyStreamFailure, StreamFailureError } from "../utils/stream-failure.js";
import { finalizeThrottledStreamingJson, updateThrottledStreamingJson } from "../utils/streaming-json-throttle.js";
import { transformMessages } from "./transform-messages.js";

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

export interface OpenAIResponsesStreamOptions {
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
}

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInput = [];

	const normalizeIdPart = (part: string): string => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};

	const buildForeignResponsesItemId = (itemId: string): string => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};

	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API requires item id to start with "fc"
		if (!normalizedItemId.startsWith("fc_")) {
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	if (includeSystemPrompt && context.systemPrompt) {
		const role = model.reasoning ? "developer" : "system";
		messages.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						} satisfies ResponseInputText;
					}
					return {
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`,
					} satisfies ResponseInputImage;
				});
				if (content.length === 0) continue;
				messages.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const assistantMsg = msg as AssistantMessage;
			const isDifferentModel =
				assistantMsg.model !== model.id &&
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api;

			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
						output.push(reasoningItem);
					}
				} else if (block.type === "text") {
					const textBlock = block as TextContent;
					const parsedSignature = parseTextSignature(textBlock.textSignature);
					// OpenAI requires id to be max 64 characters
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = `msg_${msgIndex}`;
					} else if (msgId.length > 64) {
						msgId = `msg_${shortHash(msgId)}`;
					}
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					} satisfies ResponseOutputMessage);
				} else if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					const [callId, itemIdRaw] = toolCall.id.split("|");
					let itemId: string | undefined = itemIdRaw;

					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which fc_xxx IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					if (isDifferentModel && itemId?.startsWith("fc_")) {
						itemId = undefined;
					}

					output.push({
						type: "function_call",
						id: itemId,
						call_id: callId,
						name: toolCall.name,
						arguments: JSON.stringify(toolCall.arguments),
					});
				}
			}
			if (output.length === 0) continue;
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			const textResult = msg.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const hasImages = msg.content.some((c): c is ImageContent => c.type === "image");
			const hasText = textResult.length > 0;
			const [callId] = msg.toolCallId.split("|");

			let output: string | ResponseFunctionCallOutputItemList;
			if (hasImages && model.input.includes("image")) {
				const contentParts: ResponseFunctionCallOutputItemList = [];

				if (hasText) {
					contentParts.push({
						type: "input_text",
						text: sanitizeSurrogates(textResult),
					});
				}

				for (const block of msg.content) {
					if (block.type === "image") {
						contentParts.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${block.mimeType};base64,${block.data}`,
						});
					}
				}

				output = contentParts;
			} else {
				output = sanitizeSurrogates(hasText ? textResult : hasImages ? "(see attached image)" : "");
			}

			messages.push({
				type: "function_call_output",
				call_id: callId,
				output,
			});
		}
		msgIndex++;
	}

	return messages;
}

export function convertResponsesTools(tools: Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const strict = options?.strict === undefined ? false : options.strict;
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as any, // TypeBox already generates JSON Schema
		strict,
	}));
}

type ResponsesUsageFrame = {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
};

/**
 * Merge a new usage frame over the previously seen one. Fields the new frame
 * leaves undefined keep the earlier value, so a partial late frame cannot zero
 * out counts already recorded from an earlier terminal frame.
 */
function mergeResponsesUsage(
	previous: ResponsesUsageFrame | undefined,
	current: ResponsesUsageFrame,
): ResponsesUsageFrame {
	return {
		input_tokens: current.input_tokens ?? previous?.input_tokens,
		output_tokens: current.output_tokens ?? previous?.output_tokens,
		total_tokens: current.total_tokens ?? previous?.total_tokens,
		input_tokens_details: {
			cached_tokens: current.input_tokens_details?.cached_tokens ?? previous?.input_tokens_details?.cached_tokens,
		},
	};
}

/**
 * Map incomplete_details.reason: max_output_tokens means the reply was cut off
 * by the token budget (length); content_filter is a provider-side block (error)
 * so the failure surfaces with the raw reason attached.
 */
function mapIncompleteStopReason(reason: string): StopReason {
	if (reason === "content_filter") return "error";
	return "length";
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	type Item = ResponseOutputItem;
	type Block = ThinkingContent | TextContent | (ToolCall & { partialJson: string });
	let currentItem: Item | null = null;
	let currentBlock: Block | null = null;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;
	const indexOfBlock = (block: Block): number => blocks.indexOf(block);

	const log = getLogger("ai.provider");
	// The Responses protocol tags every item-scoped event with item_id/output_index,
	// but some gateways replay events interleaved or without those coordinates.
	// Every recovery below is persisted as a message diagnostic so a mangled
	// stream is never silent (same contract as the completions tool-call recovery).
	const recordDeltaDiagnostic = (type: string, details: Record<string, unknown>): void => {
		appendAssistantMessageDiagnostic(output, { type, timestamp: Date.now(), details });
		log.warn("openai responses stream event recovery", {
			provider: model.provider,
			model: model.id,
			type,
			...details,
		});
	};

	interface ResponsesItemSlot {
		item: Item;
		block: Block | null;
		itemId: string | undefined;
		outputIndex: number | undefined;
	}
	const slotsByItemId = new Map<string, ResponsesItemSlot>();
	const slotsByOutputIndex = new Map<number, ResponsesItemSlot>();
	let sawTerminalResponseEvent = false;
	let lastRawUsage: ResponsesUsageFrame | undefined;

	const releaseSlot = (slot: ResponsesItemSlot): void => {
		if (slot.itemId !== undefined && slotsByItemId.get(slot.itemId) === slot) {
			slotsByItemId.delete(slot.itemId);
		}
		if (slot.outputIndex !== undefined && slotsByOutputIndex.get(slot.outputIndex) === slot) {
			slotsByOutputIndex.delete(slot.outputIndex);
		}
	};

	const registerSlot = (slot: ResponsesItemSlot): void => {
		if (slot.itemId !== undefined) {
			const existing = slotsByItemId.get(slot.itemId);
			if (existing && existing !== slot) {
				releaseSlot(existing);
			}
			slotsByItemId.set(slot.itemId, slot);
		}
		if (slot.outputIndex !== undefined) {
			const existing = slotsByOutputIndex.get(slot.outputIndex);
			if (existing && existing !== slot) {
				releaseSlot(existing);
			}
			slotsByOutputIndex.set(slot.outputIndex, slot);
		}
	};

	interface ItemScopedCoordinates {
		readonly itemId: string | undefined;
		readonly outputIndex: number | undefined;
	}
	const itemScoped = (event: ResponseStreamEvent): ItemScopedCoordinates => {
		const scoped = event as { item_id?: unknown; output_index?: unknown };
		return {
			itemId: typeof scoped.item_id === "string" ? scoped.item_id : undefined,
			outputIndex: typeof scoped.output_index === "number" ? scoped.output_index : undefined,
		};
	};

	// Resolution order: item_id, then output_index, then the legacy last-added
	// slot. Events without either coordinate cannot be dispatched any other way.
	const resolveItemAndBlock = (event: ResponseStreamEvent): { item: Item | null; block: Block | null } => {
		const { itemId, outputIndex } = itemScoped(event);
		if (itemId !== undefined) {
			const slot = slotsByItemId.get(itemId);
			if (slot) {
				return { item: slot.item, block: slot.block };
			}
			return { item: null, block: null };
		}
		if (outputIndex !== undefined) {
			const slot = slotsByOutputIndex.get(outputIndex);
			if (slot) {
				return { item: slot.item, block: slot.block };
			}
		}
		return { item: currentItem, block: currentBlock };
	};

	const recordUnroutedDiagnostic = (event: ResponseStreamEvent): void => {
		const { itemId, outputIndex } = itemScoped(event);
		recordDeltaDiagnostic("responses_delta_unrouted", { eventType: event.type, itemId, outputIndex });
	};

	// Mid-stream parses are throttled and callers strip the partialJson scratch on
	// their error paths. Run the authoritative final parse when iteration ends
	// (failure or stall) so the freshest arguments survive before the scratch is
	// discarded.
	const eventsWithFinalParse = async function* (): AsyncGenerator<ResponseStreamEvent> {
		try {
			yield* openaiStream;
		} finally {
			finalizeThrottledStreamingJson(blocks);
		}
	};

	for await (const event of eventsWithFinalParse()) {
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			const item = event.item;
			const { outputIndex } = itemScoped(event);
			const slot: ResponsesItemSlot = {
				item,
				block: null,
				itemId: typeof item.id === "string" ? item.id : undefined,
				outputIndex,
			};
			registerSlot(slot);
			if (item.type === "reasoning") {
				currentItem = item;
				currentBlock = { type: "thinking", thinking: "" };
				slot.block = currentBlock;
				output.content.push(currentBlock);
				stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
			} else if (item.type === "message") {
				currentItem = item;
				currentBlock = { type: "text", text: "" };
				slot.block = currentBlock;
				output.content.push(currentBlock);
				stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
			} else if (item.type === "function_call") {
				currentItem = item;
				currentBlock = {
					type: "toolCall",
					id: `${item.call_id}|${item.id}`,
					name: item.name,
					arguments: {},
					partialJson: item.arguments || "",
				};
				slot.block = currentBlock;
				output.content.push(currentBlock);
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
			}
		} else if (event.type === "response.reasoning_summary_part.added") {
			const { item } = resolveItemAndBlock(event);
			if (item?.type === "reasoning") {
				item.summary = item.summary || [];
				item.summary.push(event.part);
			} else {
				recordUnroutedDiagnostic(event);
			}
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const { item, block } = resolveItemAndBlock(event);
			if (item?.type === "reasoning" && block?.type === "thinking") {
				item.summary = item.summary || [];
				let lastPart = item.summary[item.summary.length - 1];
				if (!lastPart) {
					// Upstream skipped summary_part.added; recover by starting the
					// part from the delta so the thinking stream is not empty.
					lastPart = { type: "summary_text", text: "" };
					item.summary.push(lastPart);
					recordDeltaDiagnostic("responses_summary_part_recovered", { itemId: item.id });
				}
				block.thinking += event.delta;
				lastPart.text += event.delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: indexOfBlock(block),
					delta: event.delta,
					partial: output,
				});
			} else {
				recordUnroutedDiagnostic(event);
			}
		} else if (event.type === "response.reasoning_summary_part.done") {
			const { item, block } = resolveItemAndBlock(event);
			if (item?.type === "reasoning" && block?.type === "thinking") {
				item.summary = item.summary || [];
				const lastPart = item.summary[item.summary.length - 1];
				if (lastPart) {
					block.thinking += "\n\n";
					lastPart.text += "\n\n";
					stream.push({
						type: "thinking_delta",
						contentIndex: indexOfBlock(block),
						delta: "\n\n",
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_text.delta") {
			const { item, block } = resolveItemAndBlock(event);
			if (item?.type === "reasoning" && block?.type === "thinking") {
				block.thinking += event.delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: indexOfBlock(block),
					delta: event.delta,
					partial: output,
				});
			} else {
				recordUnroutedDiagnostic(event);
			}
		} else if (event.type === "response.content_part.added") {
			const { item } = resolveItemAndBlock(event);
			if (item?.type === "message") {
				item.content = item.content || [];
				if (event.part.type === "output_text" || event.part.type === "refusal") {
					item.content.push(event.part);
				}
			} else {
				recordUnroutedDiagnostic(event);
			}
		} else if (event.type === "response.output_text.delta") {
			const { item, block } = resolveItemAndBlock(event);
			if (item?.type === "message" && block?.type === "text") {
				item.content = item.content || [];
				let lastPart = item.content[item.content.length - 1];
				if (!lastPart) {
					// Upstream skipped content_part.added; recover by starting the
					// part from the delta so the text stream is not empty.
					lastPart = { type: "output_text", text: "", annotations: [] };
					item.content.push(lastPart);
					recordDeltaDiagnostic("responses_content_part_recovered", { itemId: item.id });
				}
				if (lastPart.type === "output_text") {
					block.text += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: indexOfBlock(block),
						delta: event.delta,
						partial: output,
					});
				}
			} else {
				recordUnroutedDiagnostic(event);
			}
		} else if (event.type === "response.refusal.delta") {
			const { item, block } = resolveItemAndBlock(event);
			if (item?.type === "message" && block?.type === "text") {
				item.content = item.content || [];
				let lastPart = item.content[item.content.length - 1];
				if (!lastPart) {
					lastPart = { type: "refusal", refusal: "" };
					item.content.push(lastPart);
					recordDeltaDiagnostic("responses_content_part_recovered", { itemId: item.id });
				}
				if (lastPart.type === "refusal") {
					block.text += event.delta;
					lastPart.refusal += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: indexOfBlock(block),
						delta: event.delta,
						partial: output,
					});
				}
			} else {
				recordUnroutedDiagnostic(event);
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			const { item, block } = resolveItemAndBlock(event);
			if (item?.type === "function_call" && block?.type === "toolCall") {
				block.partialJson += event.delta;
				// Throttled mid-stream parse; the arguments.done/output_item.done parses are authoritative.
				const parsedArgs = updateThrottledStreamingJson(block, block.partialJson);
				if (parsedArgs) {
					block.arguments = parsedArgs;
				}
				stream.push({
					type: "toolcall_delta",
					contentIndex: indexOfBlock(block),
					delta: event.delta,
					partial: output,
				});
			} else {
				recordUnroutedDiagnostic(event);
			}
		} else if (event.type === "response.function_call_arguments.done") {
			const { item, block } = resolveItemAndBlock(event);
			if (item?.type === "function_call" && block?.type === "toolCall") {
				const previousPartialJson = block.partialJson;
				block.partialJson = event.arguments;
				block.arguments = parseStreamingJson(block.partialJson);

				if (event.arguments.startsWith(previousPartialJson)) {
					const delta = event.arguments.slice(previousPartialJson.length);
					if (delta.length > 0) {
						stream.push({
							type: "toolcall_delta",
							contentIndex: indexOfBlock(block),
							delta,
							partial: output,
						});
					}
				}
			} else {
				recordUnroutedDiagnostic(event);
			}
		} else if (event.type === "response.output_item.done") {
			const item = event.item;
			const { outputIndex } = itemScoped(event);
			let slot: ResponsesItemSlot | null = null;
			if (typeof item.id === "string") {
				slot = slotsByItemId.get(item.id) ?? null;
			}
			if (!slot && outputIndex !== undefined) {
				slot = slotsByOutputIndex.get(outputIndex) ?? null;
			}
			const block: Block | null = slot?.block ?? currentBlock;

			if (item.type === "reasoning" && block?.type === "thinking") {
				const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
				const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
				block.thinking = summaryText || contentText || block.thinking;
				block.thinkingSignature = JSON.stringify(item);
				stream.push({
					type: "thinking_end",
					contentIndex: indexOfBlock(block),
					content: block.thinking,
					partial: output,
				});
			} else if (item.type === "message" && block?.type === "text") {
				const payloadText = item.content.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("");
				// An empty done payload must not wipe text recovered from deltas
				// that arrived without content_part.added.
				block.text = payloadText || block.text;
				block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: indexOfBlock(block),
					content: block.text,
					partial: output,
				});
			} else if (item.type === "function_call") {
				const args =
					block?.type === "toolCall" && block.partialJson
						? parseStreamingJson(block.partialJson)
						: parseStreamingJson(item.arguments || "{}");

				let toolCall: ToolCall;
				if (block?.type === "toolCall") {
					// Finalize in-place and strip the scratch buffer so replay only
					// carries parsed arguments.
					block.arguments = args;
					delete (block as { partialJson?: string }).partialJson;
					toolCall = block;
				} else {
					toolCall = {
						type: "toolCall",
						id: `${item.call_id}|${item.id}`,
						name: item.name,
						arguments: args,
					};
				}

				stream.push({
					type: "toolcall_end",
					contentIndex: block ? indexOfBlock(block) : blockIndex(),
					toolCall,
					partial: output,
				});
			}

			if (slot) {
				releaseSlot(slot);
				slot.block = null;
			}
			if (block && currentBlock === block) {
				currentBlock = null;
			}
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			sawTerminalResponseEvent = true;
			const response = event.response;
			if (response?.id) {
				output.responseId = response.id;
			}
			if (response?.usage) {
				// Merge per field: a late usage frame that leaves fields undefined
				// (or omits usage entirely, as response.incomplete may) must not
				// zero out counts recorded from an earlier terminal frame.
				lastRawUsage = mergeResponsesUsage(lastRawUsage, response.usage);
			}
			if (lastRawUsage) {
				const cachedTokens = lastRawUsage.input_tokens_details?.cached_tokens || 0;
				output.usage = {
					// OpenAI includes cached tokens in input_tokens, so subtract to get non-cached input
					input: (lastRawUsage.input_tokens || 0) - cachedTokens,
					output: lastRawUsage.output_tokens || 0,
					cacheRead: cachedTokens,
					cacheWrite: 0,
					// Fall back to the component sum when the provider does not
					// report total_tokens (same invariant as compaction).
					totalTokens:
						lastRawUsage.total_tokens || (lastRawUsage.input_tokens || 0) + (lastRawUsage.output_tokens || 0),
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
			}
			calculateCost(model, output.usage);
			if (options?.applyServiceTierPricing) {
				const serviceTier = options.resolveServiceTier
					? options.resolveServiceTier(response?.service_tier, options.serviceTier)
					: (response?.service_tier ?? options.serviceTier);
				options.applyServiceTierPricing(output.usage, serviceTier);
			}
			if (event.type === "response.incomplete") {
				// Incomplete responses are truncated, not completed: map the stop
				// reason from incomplete_details.reason so the reason and the usage
				// survive instead of the event being ignored as a normal stop.
				const reason = response?.incomplete_details?.reason;
				output.stopReason = reason ? mapIncompleteStopReason(reason) : mapStopReason(response?.status);
				if (output.stopReason === "error") {
					output.stopReasonRaw = reason ?? response?.status;
				}
				appendAssistantMessageDiagnostic(output, {
					type: "responses_incomplete",
					timestamp: Date.now(),
					details: { reason: reason ?? null, status: response?.status ?? null },
				});
			} else {
				output.stopReason = mapStopReason(response?.status);
				if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
					output.stopReason = "toolUse";
				}
				if (output.stopReason === "error" && response?.status) {
					output.stopReasonRaw = response.status;
				}
			}
		} else if (event.type === "error") {
			throw new StreamFailureError(`Error Code ${event.code}: ${event.message}`, {
				kind: classifyStreamFailure(event.code ?? undefined),
				providerErrorType: event.code ?? undefined,
			});
		} else if (event.type === "response.failed") {
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			const providerErrorType = error?.code ?? details?.reason;
			const msg = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new StreamFailureError(msg, {
				kind: classifyStreamFailure(providerErrorType),
				providerErrorType,
			});
		}
	}

	// A stream that ends without a terminal response event (completed or
	// incomplete) was truncated upstream; reporting it as a normal stop would
	// silently lose the tail. error/response.failed throw instead of ending the
	// loop, so they are terminal by construction.
	if (!sawTerminalResponseEvent) {
		throw new StreamFailureError("Responses stream ended before a terminal response event", {
			kind: "malformed_response",
		});
	}
}

function mapStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
