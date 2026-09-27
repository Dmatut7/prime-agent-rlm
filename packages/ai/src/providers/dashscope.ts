import { getEnvApiKey } from "../env-api-keys.js";
import { getLogger } from "../log.js";
import { calculateCost, clampThinkingLevel, modelCannotDisableThinking } from "../models.js";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	ModelThinkingLevel,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.js";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { recordStreamFailure, StreamFailureError } from "../utils/stream-failure.js";
import { createRetryCapFetch } from "./retry-cap.js";
import { buildBaseOptions } from "./simple-options.js";
import { scrubStrayReasoningTags } from "./stray-reasoning-tags.js";
import { transformMessages } from "./transform-messages.js";

/**
 * DashScope native protocol provider (阿里云百炼 /api/v1 原生接口).
 *
 * Protocol facts from the public DashScope HTTP API docs
 * (help.aliyun.com, 通义千问/百炼 "通过 HTTP 调用"):
 *
 * - Two endpoints split by model class: text models POST
 *   {baseUrl}/services/aigc/text-generation/generation, multimodal models POST
 *   {baseUrl}/services/aigc/multimodal-generation/generation. A wrong pairing
 *   answers HTTP 400 `url error`.
 * - Body shape: { model, input: { messages }, parameters: {...} } — messages
 *   ride inside `input`, not at the top level.
 * - Multimodal user content is an array of bare-key parts {image|video|audio|text},
 *   NOT OpenAI-style {type:"image_url"}.
 * - Streaming is enabled by the `X-DashScope-SSE: enable` header plus
 *   parameters.incremental_output=true.
 * - parameters.result_format="message" makes output.choices[].message the reply
 *   channel; it is mandatory when tools are sent.
 * - enable_thinking gates reasoning, returned as message.reasoning_content.
 *   preserve_thinking defaults to true on qwen3.8-max/qwen3.8-flash and bills
 *   the replayed history reasoning, so this provider pins it to false unless
 *   compat.preserveThinking (per model) or PRIME_DASHSCOPE_PRESERVE_THINKING
 *   (global escape hatch) opts in.
 */

const log = getLogger("ai.provider");

const TEXT_GENERATION_PATH = "/services/aigc/text-generation/generation";
const MULTIMODAL_GENERATION_PATH = "/services/aigc/multimodal-generation/generation";

/**
 * Default model-class routing table, from the 2026-09 probe matrix on the
 * Bailian gateway plus the public docs: qwen3.8-max/flash, deepseek-v4.1-flash
 * and kimi-k3 answered 200 on multimodal-generation; the docs state the whole
 * qwen3.8 series needs the multimodal endpoint and qwen3-vl is multimodal by
 * name. Overridable wholesale via PRIME_DASHSCOPE_MULTIMODAL_MODELS
 * (comma-separated model ids), and per-model force-back via
 * PRIME_DASHSCOPE_TEXT_MODELS.
 */
const DEFAULT_MULTIMODAL_MODEL_IDS = new Set([
	"qwen3.8-max",
	"qwen3.8-flash",
	"qwen3.8-max-0902",
	"qwen3.8-27b",
	"qwen3.8-omni-flash",
	"deepseek-v4.1-flash",
	"kimi-k3",
	"kimi-k2.7-code",
]);

const MULTIMODAL_MODEL_PREFIXES = ["qwen3.8-", "qwen3-vl-", "qwen3.7-plus", "qwen3.6-", "qwen3.5-"];

/** Doc-listed exceptions that must not follow their prefix/class default:
 *  qwen3.8-2.4t-a95b is text-only despite the qwen3.8- prefix; qwen3.6-max-preview
 *  is text-only although qwen3.6- is multimodal; qwen3.7-max and its dated
 *  snapshots are text-only. */
const DEFAULT_TEXT_MODEL_IDS = new Set([
	"qwen3.8-2.4t-a95b",
	"qwen3.6-max-preview",
	"qwen3.7-max",
	"qwen3.7-max-2026-06-08",
]);

function envList(name: string): string[] {
	const raw = process.env[name];
	if (!raw) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** True when the model id routes to multimodal-generation. Exposed for tests. */
export function isMultimodalModelClass(modelId: string): boolean {
	const forcedText = envList("PRIME_DASHSCOPE_TEXT_MODELS");
	if (forcedText.includes(modelId)) return false;
	if (DEFAULT_TEXT_MODEL_IDS.has(modelId)) return false;
	const override = envList("PRIME_DASHSCOPE_MULTIMODAL_MODELS");
	if (override.length > 0) return override.includes(modelId);
	return DEFAULT_MULTIMODAL_MODEL_IDS.has(modelId) || MULTIMODAL_MODEL_PREFIXES.some((p) => modelId.startsWith(p));
}

/** Full request URL for a model: baseUrl (…/api/v1) + endpoint path by model class. */
export function resolveDashScopeEndpoint(baseUrl: string, modelId: string): string {
	const path = isMultimodalModelClass(modelId) ? MULTIMODAL_GENERATION_PATH : TEXT_GENERATION_PATH;
	// baseUrl may or may not carry a trailing slash; join without doubling it.
	const trimmed = baseUrl.replace(/\/+$/, "");
	return `${trimmed}${path}`;
}

function preserveThinkingEnabled(model: Model<"dashscope">): boolean {
	// Per-model compat pin wins; the env var stays as a global escape hatch for
	// configs that do not (or cannot) carry a compat block.
	if (model.compat?.preserveThinking !== undefined) return model.compat.preserveThinking;
	const raw = process.env.PRIME_DASHSCOPE_PRESERVE_THINKING;
	if (!raw) return false;
	return raw === "true" || raw === "1" || raw === "on" || raw === "yes";
}

/** Provider-specific request options for the DashScope native protocol. */
export interface DashScopeOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	/** Explicit reasoning toggle. undefined preserves the provider/model default. */
	reasoningEnabled?: boolean;
	/** Explicit reasoning level; mapped through model.thinkingLevelMap to reasoning_effort. */
	reasoningLevel?: ModelThinkingLevel;
}

// ---------------------------------------------------------------------------
// Wire types (request/response object shapes)
// ---------------------------------------------------------------------------

/** Multimodal user content part: bare keys image/video/audio/text. */
type DashScopeContentPart = { text: string } | { image: string };

export type DashScopeWireMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string | DashScopeContentPart[] }
	| {
			role: "assistant";
			content?: string;
			reasoning_content?: string;
			tool_calls?: Array<{
				id: string;
				type: "function";
				function: { name: string; arguments: string };
			}>;
	  }
	| { role: "tool"; content: string; tool_call_id: string };

export interface DashScopeToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters?: Record<string, unknown>;
	};
}

export interface DashScopeRequestBody {
	model: string;
	input: { messages: DashScopeWireMessage[] };
	parameters: {
		result_format: "message";
		incremental_output: true;
		temperature?: number;
		max_completion_tokens?: number;
		tools?: DashScopeToolDefinition[];
		tool_choice?: string | { type: "function"; function: { name: string } };
		enable_thinking?: boolean;
		reasoning_effort?: string;
		preserve_thinking?: boolean;
	};
}

/** One SSE data frame; shape is identical for streaming and non-streaming. */
interface DashScopeChunk {
	request_id?: string;
	code?: string;
	message?: string;
	output?: {
		choices?: Array<{
			finish_reason?: string | null;
			message?: {
				role?: string;
				content?: string | DashScopeContentPart[] | null;
				reasoning_content?: string | null;
				tool_calls?: Array<{
					function?: { name?: string; arguments?: string };
					index?: number;
					id?: string;
					type?: string;
				}>;
			};
		}>;
	};
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		total_tokens?: number;
		input_tokens_details?: { image_tokens?: number };
		prompt_tokens_details?: { cached_tokens?: number };
	};
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

function isTextContentBlock(block: { type: string }): block is TextContent {
	return block.type === "text";
}

function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
	return block.type === "thinking";
}

function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}

function isImageContentBlock(block: { type: string }): block is ImageContent {
	return block.type === "image";
}

/**
 * Neutral messages → DashScope input.messages. On the multimodal endpoint user
 * content is always the bare-key part array; on the text endpoint it stays a
 * plain string. Tool-result images ride in a follow-up user message because
 * the wire only documents image parts inside user content.
 */
export function convertMessages(
	model: Model<"dashscope">,
	context: Context,
	route: { multimodal: boolean; preserveThinking: boolean },
): DashScopeWireMessage[] {
	const messages: DashScopeWireMessage[] = [];
	const transformed = transformMessages(context.messages, model);

	if (context.systemPrompt) {
		messages.push({ role: "system", content: sanitizeSurrogates(context.systemPrompt) });
	}

	const userContent = (content: string | (TextContent | ImageContent)[]): string | DashScopeContentPart[] => {
		if (typeof content === "string") {
			return route.multimodal ? [{ text: sanitizeSurrogates(content) }] : sanitizeSurrogates(content);
		}
		if (!route.multimodal) {
			// Text endpoint: flatten to a string (images were already downgraded to
			// placeholders by transformMessages for non-vision models).
			return content.map((block) => (isTextContentBlock(block) ? sanitizeSurrogates(block.text) : "")).join("");
		}
		const parts: DashScopeContentPart[] = [];
		for (const block of content) {
			if (isTextContentBlock(block)) {
				parts.push({ text: sanitizeSurrogates(block.text) });
			} else if (isImageContentBlock(block) && model.input.includes("image")) {
				// Native image parts accept a public URL, base64 data URL or local
				// absolute path.
				parts.push({ image: `data:${block.mimeType};base64,${block.data}` });
			}
		}
		return parts;
	};

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (msg.role === "user") {
			const content = userContent(msg.content);
			if (typeof content === "string" ? content.length > 0 : content.length > 0) {
				messages.push({ role: "user", content });
			}
		} else if (msg.role === "assistant") {
			const assistantText = msg.content
				.filter(isTextContentBlock)
				.map((block) => sanitizeSurrogates(block.text))
				.join("");

			// preserve_thinking: replayed reasoning must ride the
			// reasoning_content field (never content), and is only honoured by the
			// server when preserve_thinking is on. With the default off the replay
			// would be dead weight (and billed on qwen3.8), so it is dropped.
			const reasoningText = route.preserveThinking
				? msg.content
						.filter(isThinkingContentBlock)
						.map((block) => sanitizeSurrogates(block.thinking))
						.join("\n")
				: "";

			const toolCalls = msg.content.filter(isToolCallBlock);

			if (assistantText.length === 0 && reasoningText.length === 0 && toolCalls.length === 0) {
				continue; // some providers reject empty assistant messages (content is optional)
			}

			const wire: DashScopeWireMessage = { role: "assistant" };
			if (assistantText.length > 0) wire.content = assistantText;
			if (reasoningText.length > 0) wire.reasoning_content = reasoningText;
			if (toolCalls.length > 0) {
				wire.tool_calls = toolCalls.map((tc) => ({
					id: tc.id,
					type: "function",
					function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
				}));
			}
			// Some reasoning models require the reasoning_content field to exist on
			// every replayed assistant message (same flag and semantics as the
			// OpenAI-compatible provider).
			if (
				model.compat?.requiresReasoningContentOnAssistantMessages === true &&
				model.reasoning &&
				wire.reasoning_content === undefined
			) {
				wire.reasoning_content = "";
			}
			messages.push(wire);
		} else if (msg.role === "toolResult") {
			const imageBlocks: DashScopeContentPart[] = [];
			let j = i;
			for (; j < transformed.length && transformed[j].role === "toolResult"; j++) {
				const toolMsg = transformed[j] as ToolResultMessage;
				const textResult = toolMsg.content
					.filter(isTextContentBlock)
					.map((block) => sanitizeSurrogates(block.text))
					.join("\n");
				const hasImages = toolMsg.content.some((c) => c.type === "image");
				messages.push({
					role: "tool",
					content: hasImages && textResult.length === 0 ? "(see attached image)" : textResult,
					tool_call_id: toolMsg.toolCallId,
				});
				if (route.multimodal && model.input.includes("image")) {
					for (const block of toolMsg.content) {
						if (isImageContentBlock(block)) {
							imageBlocks.push({ image: `data:${block.mimeType};base64,${block.data}` });
						}
					}
				}
			}
			i = j - 1;
			if (imageBlocks.length > 0) {
				// The wire only documents image parts inside user content, so tool
				// images follow the tool results as their own user turn.
				messages.push({ role: "user", content: imageBlocks });
			}
		}
	}

	return messages;
}

/** Neutral tool definitions → parameters.tools. */
export function convertTools(tools: Tool[]): DashScopeToolDefinition[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			// TypeBox schemas are already JSON Schema; parameters may be {} for
			// no-argument tools (the protocol default is {}).
			parameters: (tool.parameters ?? {}) as Record<string, unknown>,
		},
	}));
}

/**
 * Neutral stream options → parameters. Notes:
 * - `n` is never sent: the protocol pins it to 1 whenever tools are present,
 *   only a few models accept it at all, and the default is 1.
 * - max_completion_tokens (recommended by the docs over the deprecated max_tokens).
 * - thinkingLevel maps through model.thinkingLevelMap into reasoning_effort
 *   (deepseek/glm/kimi tiers: low/medium/high/max; qwen3.8: low/medium/xhigh)
 *   — preserving the thinkingLevelMap contract.
 */
export function buildDashScopeParameters(
	model: Model<"dashscope">,
	options: DashScopeOptions | undefined,
	preserveThinking: boolean,
): DashScopeRequestBody["parameters"] {
	const parameters: DashScopeRequestBody["parameters"] = {
		result_format: "message",
		incremental_output: true,
	};

	if (options?.temperature !== undefined) {
		parameters.temperature = options.temperature;
	}
	if (options?.maxTokens !== undefined && options.maxTokens > 0) {
		parameters.max_completion_tokens = options.maxTokens;
	}

	if (options?.toolChoice) {
		parameters.tool_choice = options.toolChoice;
	}

	// Thinking toggle: a model that cannot disable thinking (thinkingLevelMap.off
	// === null) answers 400 to an explicit enable_thinking=false (glm-5.3/kimi-k3
	// only accept true), so the off signal is omitted there. An unspecified
	// preference is also omitted so the model default stands (mirrors the
	// compat-mode wire for these models).
	const level = options?.reasoningLevel;
	const wantThinking = options?.reasoningEnabled === true || (level !== undefined && level !== "off");
	const canSendOffSignal = !modelCannotDisableThinking(model);
	if (model.reasoning && wantThinking) {
		parameters.enable_thinking = true;
	} else if (model.reasoning && options?.reasoningEnabled === false && canSendOffSignal) {
		parameters.enable_thinking = false;
	}

	if (model.reasoning && level !== undefined && level !== "off") {
		// thinkingLevelMap semantics preserved: the map value rides
		// parameters.reasoning_effort (deepseek/glm/kimi: low/medium/high/max;
		// qwen3.8: low/medium/xhigh).
		const mapped = model.thinkingLevelMap?.[level];
		// No raw-level fallback: glm-5.3-prime answers 400 InvalidParameter
		// "Invalid value for parameter reasoning_effort" to unmapped levels such as
		// "medium" (measured on the gateway 2026-09). Models without a
		// thinkingLevelMap entry omit the parameter and keep the server default.
		if (typeof mapped === "string" && mapped.length > 0) {
			parameters.reasoning_effort = mapped;
		}
	}

	if (model.reasoning) {
		// qwen3.8-max/flash default preserve_thinking=true and bill the replayed
		// history; pin false unless opted in.
		parameters.preserve_thinking = preserveThinking;
	}

	return parameters;
}

/** Assemble the full native request body. Exposed for tests. */
export function buildDashScopeRequest(
	model: Model<"dashscope">,
	context: Context,
	options?: DashScopeOptions,
): DashScopeRequestBody {
	const route = {
		multimodal: isMultimodalModelClass(model.id),
		preserveThinking: preserveThinkingEnabled(model),
	};
	const messages = convertMessages(model, context, route);
	const parameters = buildDashScopeParameters(model, options, route.preserveThinking);
	if (context.tools && context.tools.length > 0) {
		parameters.tools = convertTools(context.tools);
	}
	return { model: model.id, input: { messages }, parameters };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** message.content is a string on the text endpoint, [{text}] on multimodal. */
export function parseDashScopeContent(content: string | DashScopeContentPart[] | null | undefined): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
			text += (part as { text: string }).text;
		}
	}
	return text;
}

export function mapDashScopeFinishReason(reason: string | null | undefined): {
	stopReason: StopReason;
	stopReasonRaw?: string;
	errorMessage?: string;
} {
	// Bailian's native SSE sends the *string* "null" in every unfinished frame
	// (`"finish_reason":"null"`), and only the last frame carries a real verdict
	// ("stop" / "tool_calls"). A truthiness check treats that string as a reason,
	// so every intermediate frame used to label the response an error — measured
	// on the gateway, every recorded native-path response carried
	// `Provider finish_reason: null` while its text arrived intact.
	// Absent means "not finished yet", never "failed".
	if (reason === null || reason === undefined || reason === "null" || reason === "") return { stopReason: "stop" };
	switch (reason) {
		case "stop":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "tool_calls":
			return { stopReason: "toolUse" };
		default:
			return {
				stopReason: "error",
				stopReasonRaw: reason,
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

function parseChunkUsage(
	chunk: NonNullable<DashScopeChunk["usage"]>,
	model: Model<"dashscope">,
): AssistantMessage["usage"] {
	const cacheRead = chunk.prompt_tokens_details?.cached_tokens ?? 0;
	// input_tokens already includes the cached portion (total_tokens = input +
	// output holds even with cache hits), while pi-ai counts uncached input and
	// cache hits separately. Reporting the raw input_tokens alongside cacheRead
	// would double-count the hits and make context-overflow checks fire early.
	const input = Math.max(0, (chunk.input_tokens ?? 0) - cacheRead);
	const output = chunk.output_tokens ?? 0;
	const usage: AssistantMessage["usage"] = {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + output + cacheRead,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const imageTokens = chunk.input_tokens_details?.image_tokens;
	if (typeof imageTokens === "number") usage.imageTokens = imageTokens;
	calculateCost(model, usage);
	return usage;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

interface StreamingToolCallBlock extends ToolCall {
	partialArgs?: string;
	streamIndex?: number;
	/** Provider-supplied id as the wire sent it, before de-duplication. */
	sourceId?: string;
}
type StreamingBlock = TextContent | ThinkingContent | StreamingToolCallBlock;
type DashScopeToolCallDelta = NonNullable<
	NonNullable<NonNullable<DashScopeChunk["output"]>["choices"]>[number]["message"]
>["tool_calls"] extends (infer T)[] | undefined
	? T
	: never;

const MAX_ERROR_BODY_CHARS = 4000;

async function dashScopeHttpError(response: Response, url: string): Promise<Error> {
	let code: string | undefined;
	let message: string | undefined;
	let requestId: string | undefined;
	let raw = "";
	try {
		raw = await response.text();
		const parsed = JSON.parse(raw) as DashScopeChunk;
		code = typeof parsed.code === "string" ? parsed.code : undefined;
		message = typeof parsed.message === "string" ? parsed.message : undefined;
		requestId = typeof parsed.request_id === "string" ? parsed.request_id : undefined;
	} catch {
		// Non-JSON error body; fall through with the raw text.
	}
	const summary = `DashScope HTTP ${response.status} at ${url}${code ? ` code=${code}` : ""}: ${
		message ?? raw.slice(0, MAX_ERROR_BODY_CHARS)
	}`;
	const error = new Error(summary) as Error & { status?: number; code?: string; request_id?: string };
	error.status = response.status;
	if (code !== undefined) error.code = code;
	if (requestId !== undefined) error.request_id = requestId;
	return error;
}

/** Parse the native SSE wire: `data:<json>` frames, no documented sentinel. */
async function* iterateSseDataFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (line.startsWith("data:")) {
					yield line.slice(5).trim();
				}
				newline = buffer.indexOf("\n");
			}
		}
		const tail = buffer.trim();
		if (tail.startsWith("data:")) {
			yield tail.slice(5).trim();
		}
	} finally {
		reader.releaseLock();
	}
}

function createOutput(model: Model<"dashscope">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Streams a chat completion over the DashScope native protocol. */
export const streamDashScope: StreamFunction<"dashscope", DashScopeOptions> = (
	model: Model<"dashscope">,
	context: Context,
	options?: DashScopeOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output = createOutput(model);
		const blocks = output.content as StreamingBlock[];
		const getContentIndex = (block: StreamingBlock) => blocks.indexOf(block);

		const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
		const claimedToolCallIds = new Set<string>();
		let generatedToolCallIdCounter = 0;
		const recordToolCallDiagnostic = (type: string, details: Record<string, unknown>) => {
			appendAssistantMessageDiagnostic(output, { type, timestamp: Date.now(), details });
			log.warn("dashscope tool call stream recovery", {
				provider: model.provider,
				model: model.id,
				type,
				...details,
			});
		};
		const claimToolCallId = (block: StreamingToolCallBlock, desired: string | undefined): string => {
			if (!desired) {
				// A call whose id never arrived still needs a pairable id: the
				// native protocol leaves the response id optional in streamed
				// tool-call fragments.
				do {
					generatedToolCallIdCounter += 1;
				} while (claimedToolCallIds.has(`toolcall_${generatedToolCallIdCounter}`));
				const assignedId = `toolcall_${generatedToolCallIdCounter}`;
				claimedToolCallIds.add(assignedId);
				block.id = assignedId;
				recordToolCallDiagnostic("tool_call_missing_id", {
					contentIndex: getContentIndex(block),
					assignedId,
				});
				return assignedId;
			}
			let assignedId = desired;
			let attempt = 1;
			while (claimedToolCallIds.has(assignedId)) {
				assignedId = `${desired}_${attempt}`;
				attempt += 1;
			}
			claimedToolCallIds.add(assignedId);
			block.id = assignedId;
			if (assignedId !== desired) {
				recordToolCallDiagnostic("tool_call_duplicate_id", {
					contentIndex: getContentIndex(block),
					incomingId: desired,
					assignedId,
				});
			}
			return assignedId;
		};

		const finishBlock = (block: StreamingBlock) => {
			const contentIndex = getContentIndex(block);
			if (contentIndex === -1) return;
			if (block.type === "text") {
				stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
			} else if (block.type === "thinking") {
				stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
			} else if (block.type === "toolCall") {
				block.arguments = parseStreamingJson(block.partialArgs);
				delete block.partialArgs;
				delete block.streamIndex;
				delete block.sourceId;
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
			}
		};

		// One text channel and one reasoning channel accumulate into single
		// blocks in arrival order, mirroring the other streaming providers.
		let textBlock: TextContent | null = null;
		let thinkingBlock: ThinkingContent | null = null;
		const ensureTextBlock = (): TextContent => {
			if (!textBlock) {
				textBlock = { type: "text", text: "" };
				blocks.push(textBlock);
				stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
			}
			return textBlock;
		};
		const ensureThinkingBlock = (): ThinkingContent => {
			if (!thinkingBlock) {
				thinkingBlock = { type: "thinking", thinking: "", thinkingSignature: "reasoning_content" };
				blocks.push(thinkingBlock);
				stream.push({
					type: "thinking_start",
					contentIndex: getContentIndex(thinkingBlock),
					partial: output,
				});
			}
			return thinkingBlock;
		};

		const applySourceId = (block: StreamingToolCallBlock, sourceId: string): void => {
			if (block.sourceId !== sourceId) {
				block.sourceId = sourceId;
				claimToolCallId(block, sourceId);
			}
		};
		const startsNewCallAtReusedIndex = (
			block: StreamingToolCallBlock,
			incomingId: string | undefined,
			incomingName: string | undefined,
			incomingArgs: string | undefined,
		): boolean => {
			if (incomingId === undefined || block.sourceId === undefined || block.sourceId === incomingId) {
				return false;
			}
			if (incomingName && block.name && incomingName !== block.name) return true;
			return (block.partialArgs ?? "").trimEnd().endsWith("}") && (incomingArgs ?? "").trimStart().startsWith("{");
		};
		const ensureToolCallBlock = (delta: DashScopeToolCallDelta): StreamingToolCallBlock | undefined => {
			const streamIndex = typeof delta.index === "number" ? delta.index : undefined;
			const incomingId = typeof delta.id === "string" && delta.id.length > 0 ? delta.id : undefined;
			let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
			if (block && startsNewCallAtReusedIndex(block, incomingId, delta.function?.name, delta.function?.arguments)) {
				// Reused index with evidence of a fresh call: start a new block.
				block = undefined;
				toolCallBlocksByIndex.delete(streamIndex!);
				recordToolCallDiagnostic("tool_call_reused_index", { streamIndex, incomingId });
			}
			if (!block) {
				block = {
					type: "toolCall",
					id: "",
					name: "",
					arguments: {},
					partialArgs: "",
					...(streamIndex !== undefined ? { streamIndex } : {}),
				};
				blocks.push(block);
				stream.push({ type: "toolcall_start", contentIndex: getContentIndex(block), partial: output });
				if (streamIndex !== undefined) {
					toolCallBlocksByIndex.set(streamIndex, block);
				}
			}
			if (incomingId && !block.id) {
				applySourceId(block, incomingId);
			}
			return block;
		};

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider);
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			let body = buildDashScopeRequest(model, context, options);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) {
				body = nextBody as DashScopeRequestBody;
			}

			const url = resolveDashScopeEndpoint(model.baseUrl, model.id);
			const headers: Record<string, string> = {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				// Streaming is selected by this header, not parameters.stream.
				"X-DashScope-SSE": "enable",
				...(model.headers ?? {}),
				...(options?.headers ?? {}),
			};

			const timeoutMs = options?.timeoutMs;
			const signal =
				options?.signal && timeoutMs
					? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
					: (options?.signal ?? (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined));

			// Route every attempt through the shared retry-cap wrapper: it counts
			// requests against the shared budget and reports provider-requested waits
			// (a single-attempt provider still must not hide its request from the
			// chain counter or the onProviderRetry/onProviderRequestAttempt sinks).
			const guardedFetch = createRetryCapFetch({
				maxRetryDelayMs: options?.maxRetryDelayMs,
				onProviderRetry: options?.onProviderRetry,
				requestBudget: options?.requestBudget,
				onProviderRequestAttempt: options?.onProviderRequestAttempt,
			});
			const response = await guardedFetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal,
			});
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			if (!response.ok || !response.body) {
				throw await dashScopeHttpError(response, url);
			}

			stream.push({ type: "start", partial: output });

			let sawFinishReason = false;
			let sawChoices = false;
			for await (const frame of iterateSseDataFrames(response.body)) {
				if (frame === "" || frame === "[DONE]") continue;
				let chunk: DashScopeChunk;
				try {
					chunk = JSON.parse(frame) as DashScopeChunk;
				} catch {
					log.warn("dashscope non-JSON SSE frame", { provider: model.provider, model: model.id });
					continue;
				}

				if (chunk.request_id && !output.responseId) {
					output.responseId = chunk.request_id;
				}
				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage, model);
				}
				// Mid-stream error payload: a frame with code but no output.
				if (chunk.code && chunk.code !== "" && !chunk.output) {
					const error = new Error(`DashScope stream error code=${chunk.code}: ${chunk.message ?? ""}`) as Error & {
						code?: string;
						request_id?: string;
					};
					error.code = chunk.code;
					if (chunk.request_id) error.request_id = chunk.request_id;
					throw error;
				}

				const choice = chunk.output?.choices?.[0];
				if (!choice) continue;
				sawChoices = true;

				// Skip the string "null" the gateway sends on every unfinished frame:
				// only a real verdict ends the stream, and a stream that never carried one
				// is reported by the truncation check below instead of being called an error.
				if (choice.finish_reason && choice.finish_reason !== "null") {
					sawFinishReason = true;
					const mapped = mapDashScopeFinishReason(choice.finish_reason);
					output.stopReason = mapped.stopReason;
					if (mapped.stopReasonRaw) output.stopReasonRaw = mapped.stopReasonRaw;
					if (mapped.errorMessage) output.errorMessage = mapped.errorMessage;
				}

				const message = choice.message;
				if (!message) continue;

				const textDelta = parseDashScopeContent(message.content);
				if (textDelta.length > 0) {
					const block = ensureTextBlock();
					block.text += textDelta;
					stream.push({
						type: "text_delta",
						contentIndex: getContentIndex(block),
						delta: textDelta,
						partial: output,
					});
				}

				if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
					const block = ensureThinkingBlock();
					block.thinking += message.reasoning_content;
					stream.push({
						type: "thinking_delta",
						contentIndex: getContentIndex(block),
						delta: message.reasoning_content,
						partial: output,
					});
				}

				if (message.tool_calls) {
					for (const delta of message.tool_calls) {
						const block = ensureToolCallBlock(delta);
						if (!block) continue;
						if (!block.name && delta.function?.name) {
							block.name = delta.function.name;
						}
						let deltaArgs = "";
						if (typeof delta.function?.arguments === "string" && delta.function.arguments.length > 0) {
							deltaArgs = delta.function.arguments;
							block.partialArgs = (block.partialArgs ?? "") + deltaArgs;
						}
						stream.push({
							type: "toolcall_delta",
							contentIndex: getContentIndex(block),
							delta: deltaArgs,
							partial: output,
						});
					}
				}
			}

			// A tool call whose id never arrived still needs a pairable id before
			// the block is finalized: the native protocol leaves the streamed id
			// optional in tool-call fragments.
			for (const block of blocks) {
				if (block.type === "toolCall" && !block.id) {
					claimToolCallId(block, block.sourceId);
				}
			}
			// Qwen-family models leak lone reasoning closing tags into content
			// (observed 2026-09-26: text blocks of nothing but "\n</think>\n\n");
			// scrub them before the blocks are finalized into the message. An
			// emptied block stays in place as "" so later content indices hold.
			scrubStrayReasoningTags(blocks);
			for (const block of blocks) {
				finishBlock(block);
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "aborted") {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}
			// A stream that never carried choices nor a finish_reason was truncated
			// or misrouted upstream; reporting a normal stop would lose the tail.
			if (!sawFinishReason) {
				throw new StreamFailureError(
					sawChoices
						? "DashScope stream ended before a finish_reason"
						: "DashScope stream carried no choices (check endpoint routing: url error)",
					{ kind: "malformed_response", requestId: output.responseId },
				);
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of blocks) {
				delete (block as { partialArgs?: string }).partialArgs;
				delete (block as { streamIndex?: number }).streamIndex;
				delete (block as { sourceId?: string }).sourceId;
			}
			scrubStrayReasoningTags(output.content);
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			recordStreamFailure(model, output, error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/** Maps provider-agnostic `SimpleStreamOptions` to DashScope request options. */
export const streamSimpleDashScope: StreamFunction<"dashscope", SimpleStreamOptions> = (
	model: Model<"dashscope">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	// Same rationale as the openai-completions compat flag: when reasoning
	// counts inside the output-token limit, the shared min(maxTokens, 32k)
	// clamp can be burned by reasoning alone and the turn ends "length" with
	// zero content, so an explicit opt-in honors model.maxTokens instead. An
	// explicit options.maxTokens is never overridden.
	if (
		model.compat?.reasoningCountsTowardMaxTokens === true &&
		!options?.maxTokens &&
		model.maxTokens > (base.maxTokens ?? 0)
	) {
		base.maxTokens = model.maxTokens;
	}
	const requestedReasoning = options?.reasoning;
	const reasoningSpecified = requestedReasoning !== undefined;
	const clampedReasoning = reasoningSpecified
		? clampThinkingLevel(model, requestedReasoning as ModelThinkingLevel)
		: undefined;

	return streamDashScope(model, context, {
		...base,
		reasoningEnabled: reasoningSpecified ? clampedReasoning !== "off" : undefined,
		reasoningLevel: clampedReasoning === "off" ? undefined : clampedReasoning,
		toolChoice: (options as DashScopeOptions | undefined)?.toolChoice,
	} satisfies DashScopeOptions);
};
