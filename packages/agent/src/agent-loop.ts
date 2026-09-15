/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	appendAssistantMessageDiagnostic,
	type Context,
	classifyStreamFailure,
	EventStream,
	getProviderRequestBudget,
	type ImageContent,
	isContextOverflow,
	type ProviderRequestAttemptNotice,
	ProviderRequestBudget,
	type ProviderRetryNotice,
	streamSimple,
	type TextContent,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { deduplicateToolCallIds, formatToolCallIdCollisions, type ToolCallIdCollision } from "./tool-call-dedupe.js";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	EmptyTurnRetryConfig,
	StreamFn,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

const ABORT_ERROR_MESSAGE = "Request was aborted";

/** Result stub for a tool call the abort caught in flight; long-standing signature, kept as the last resort. */
export const TOOL_ABORT_FALLBACK_MESSAGE = "Tool execution aborted";
/**
 * Appended to a tool result whose turn was aborted mid-flight, so the model knows
 * the output it is looking at is partial instead of treating it as the whole answer.
 */
export const ABORT_TRUNCATION_MARKER = "[tool result truncated: the turn was aborted while this tool was in flight]";
/**
 * How long the abort path waits for an in-flight tool to settle so its partial
 * output can be preserved. Sized against the kernel's own force-abort grace
 * (`KERNEL_ABORT_GRACE_MS` = 1000ms in the coding-agent kernel) plus slack: the
 * harvest must not outlive the interrupt it is collecting evidence for.
 */
export const ABORT_HARVEST_TIMEOUT_MS = 1250;
/** Hard byte bound on harvested text: a print-heavy cell must not inject megabytes into the model. */
export const ABORT_HARVEST_MAX_BYTES = 8 * 1024;

const abortTextEncoder = new TextEncoder();
const abortTextDecoder = new TextDecoder();
const EMPTY_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createAbortError(): Error {
	return new Error(ABORT_ERROR_MESSAGE);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw createAbortError();
	}
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
	if (!signal) {
		return operation;
	}
	if (signal.aborted) {
		onAbort?.();
		void operation.catch(() => undefined);
		return Promise.reject(createAbortError());
	}

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			signal.removeEventListener("abort", abort);
		};
		const abort = () => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			onAbort?.();
			reject(createAbortError());
		};
		signal.addEventListener("abort", abort, { once: true });
		operation.then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

function maybePromiseWithAbort<T>(
	operation: T | Promise<T>,
	signal: AbortSignal | undefined,
	onAbort?: () => void,
): Promise<T> {
	return raceWithAbort(Promise.resolve(operation), signal, onAbort);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.message === ABORT_ERROR_MESSAGE || error.name === "AbortError");
}

type PostTurnResult<T> = { status: "completed"; value: T } | { status: "aborted" };

async function settlePostTurn<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<PostTurnResult<T>> {
	try {
		return { status: "completed", value: await operation };
	} catch (error) {
		if (signal?.aborted && isAbortError(error)) {
			return { status: "aborted" };
		}
		throw error;
	}
}

/**
 * Waits up to `timeoutMs` for a tool operation that was still in flight when the
 * turn was aborted, so its partial output can be preserved as evidence.
 *
 * Resolves `undefined` when the operation does not settle in time or fails. The
 * operation always keeps a rejection sink, so losing the race can never surface
 * later as an unhandledRejection.
 */
export async function harvestAbortedToolResult<T>(
	operation: Promise<T>,
	timeoutMs: number = ABORT_HARVEST_TIMEOUT_MS,
): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), timeoutMs);
	});
	try {
		return await Promise.race([operation.catch(() => undefined), timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Whether a tool result carries anything the tool itself produced. */
function hasToolOutput(result: AgentToolResult<any> | undefined): result is AgentToolResult<any> {
	if (!result || !Array.isArray(result.content) || result.content.length === 0) return false;
	return result.content.some((block) => (block.type === "text" ? block.text.trim().length > 0 : true));
}

/** Keeps the last `maxBytes` of UTF-8 text, never splitting a multi-byte sequence. */
function truncateTextTailBytes(text: string, maxBytes: number): string {
	const bytes = abortTextEncoder.encode(text);
	if (bytes.byteLength <= maxBytes) return text;
	let start = bytes.byteLength - maxBytes;
	// Skip UTF-8 continuation bytes so the tail starts on a sequence boundary.
	while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) {
		start += 1;
	}
	return abortTextDecoder.decode(bytes.subarray(start));
}

function resultTextBytes(result: AgentToolResult<any>): number {
	return result.content.reduce(
		(total, block) => (block.type === "text" ? total + abortTextEncoder.encode(block.text).byteLength : total),
		0,
	);
}

/** Bounds the text of a harvested result to its last {@link ABORT_HARVEST_MAX_BYTES}; non-text blocks are kept. */
function boundHarvestedTextTail(result: AgentToolResult<any>, maxBytes: number): AgentToolResult<any> {
	if (resultTextBytes(result) <= maxBytes) return result;
	const kept: (TextContent | ImageContent)[] = [];
	let budget = maxBytes;
	for (let index = result.content.length - 1; index >= 0 && budget > 0; index -= 1) {
		const block = result.content[index]!;
		if (block.type !== "text") {
			kept.unshift(block);
			continue;
		}
		const text = truncateTextTailBytes(block.text, budget);
		budget -= abortTextEncoder.encode(text).byteLength;
		kept.unshift({ type: "text", text });
	}
	return { ...result, content: kept };
}

/**
 * Builds the result for a tool call whose turn was aborted while it was in flight.
 *
 * Preference order: output the tool already returned, then a bounded harvest of the
 * still-running operation, then the historical abort stub. Whatever is preserved is
 * marked as an error and tagged with {@link ABORT_TRUNCATION_MARKER}, so the model
 * reads it as partial evidence instead of a completed answer.
 */
async function preserveAbortedToolResult(
	executed: ExecutedToolCallOutcome,
	result: AgentToolResult<any>,
): Promise<AgentToolResult<any>> {
	// A result synthesized by the abort path is a stub, not tool output: go straight
	// to the harvest for it.
	let preserved = !executed.abortedInFlight && hasToolOutput(result) ? result : undefined;
	if (!preserved && executed.pendingOperation) {
		const harvested = await harvestAbortedToolResult(executed.pendingOperation);
		if (hasToolOutput(harvested)) {
			preserved = boundHarvestedTextTail(harvested, ABORT_HARVEST_MAX_BYTES);
		}
	}
	if (!preserved) {
		return createErrorToolResult(TOOL_ABORT_FALLBACK_MESSAGE);
	}
	return {
		content: [...preserved.content, { type: "text", text: ABORT_TRUNCATION_MARKER }],
		details: preserved.details,
		...(preserved.terminate === undefined ? {} : { terminate: preserved.terminate }),
	};
}

function cloneAssistantContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
	return content.map((part) => {
		if (part.type === "toolCall") {
			return { ...part, arguments: { ...part.arguments } };
		}
		return { ...part };
	});
}

function cloneUsage(usage: AssistantMessage["usage"]): AssistantMessage["usage"] {
	return { ...usage, cost: { ...usage.cost } };
}

function createAbortedAssistantMessage(
	config: AgentLoopConfig,
	partialMessage: AssistantMessage | null,
): AssistantMessage {
	return {
		role: "assistant",
		content: partialMessage ? cloneAssistantContent(partialMessage.content) : [{ type: "text", text: "" }],
		api: partialMessage?.api ?? config.model.api,
		provider: partialMessage?.provider ?? config.model.provider,
		model: partialMessage?.model ?? config.model.id,
		usage: cloneUsage(partialMessage?.usage ?? EMPTY_USAGE),
		stopReason: "aborted",
		errorMessage: ABORT_ERROR_MESSAGE,
		timestamp: Date.now(),
	};
}

function getTerminalMessage(event: Extract<AssistantMessageEvent, { type: "done" | "error" }>): AssistantMessage {
	return event.type === "done" ? event.message : event.error;
}

/**
 * Raised by the stream stall timer when the assistant response stream produces no
 * events for `AgentLoopConfig.streamStallTimeoutMs`. The loop settles the turn with
 * a `stopReason: "error"` assistant message instead of hanging on a dead connection.
 */
export class StreamStallError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Stream stalled: no events for ${timeoutMs}ms`);
		this.name = "StreamStallError";
		this.timeoutMs = timeoutMs;
	}
}

function formatStreamStallErrorMessage(timeoutMs: number): string {
	const seconds = Math.max(1, Math.round(timeoutMs / 1000));
	return (
		`Stream stalled: no response events arrived for ${seconds}s, so the provider request was aborted as likely dead. ` +
		"This usually indicates a dead or half-open provider connection and a retry normally succeeds. " +
		"If this repeats on a healthy but slow provider, raise streamStallTimeoutMs or set it to 0 to disable."
	);
}

/**
 * Synthetic `stopReasonRaw` for a stall that happened while the client was obeying a
 * wait the provider itself asked for (HTTP 429/408/5xx with `Retry-After`). The
 * provider answered, so the connection is not the suspect; callers use this marker to
 * keep the shape out of the "resend the whole context" retry class.
 */
export const SERVER_DIRECTED_RETRY_STALL_STOP_REASON_RAW = "stalled_during_provider_retry";

/** Whether a message is a stall that the provider's own throttling instruction explains. */
export function isServerDirectedRetryStall(message: AssistantMessage): boolean {
	return message.stopReason === "error" && message.stopReasonRaw === SERVER_DIRECTED_RETRY_STALL_STOP_REASON_RAW;
}

function formatProviderRetryStallMessage(notice: ProviderRetryNotice, retries: number, timeoutMs: number): string {
	const seconds = Math.max(1, Math.round(timeoutMs / 1000));
	const asked = notice.retryAfter ? `${notice.delayMs}ms (${notice.retryAfter})` : `${notice.delayMs}ms`;
	return (
		`Provider is throttling this request: it answered HTTP ${notice.status} asking to wait ${asked}, ` +
		`and no stream events arrived within the ${seconds}s stall window, so the wait was aborted after ${retries} such attempt(s). ` +
		"This is a rate limit, not a dead connection: resending the full conversation now would add load, so it is not retried automatically. " +
		"Wait for the delay the provider stated, then retry with a smaller request, or raise retry.provider.streamStallTimeoutMs / retry.provider.maxRetryDelayMs for a slow but healthy provider."
	);
}

function createStalledAssistantMessage(
	config: AgentLoopConfig,
	partialMessage: AssistantMessage | null,
	timeoutMs: number,
	providerRetries: readonly ProviderRetryNotice[] = [],
): AssistantMessage {
	const message: AssistantMessage = {
		role: "assistant",
		content: partialMessage ? cloneAssistantContent(partialMessage.content) : [{ type: "text", text: "" }],
		api: partialMessage?.api ?? config.model.api,
		provider: partialMessage?.provider ?? config.model.provider,
		model: partialMessage?.model ?? config.model.id,
		usage: cloneUsage(partialMessage?.usage ?? EMPTY_USAGE),
		stopReason: "error",
		errorMessage: formatStreamStallErrorMessage(timeoutMs),
		timestamp: Date.now(),
	};
	const lastRetry = providerRetries[providerRetries.length - 1];
	// The server answered and told us how long to wait: classify the silence as
	// throttling instead of a dead connection, and keep the structured diagnostic so
	// kind-based routing downstream sees rate_limit rather than nothing.
	if (lastRetry) {
		message.errorMessage = formatProviderRetryStallMessage(lastRetry, providerRetries.length, timeoutMs);
		message.stopReasonRaw = SERVER_DIRECTED_RETRY_STALL_STOP_REASON_RAW;
		appendAssistantMessageDiagnostic(message, {
			type: "provider_stream_failure",
			timestamp: Date.now(),
			details: {
				kind: classifyStreamFailure(undefined, lastRetry.status),
				status: lastRetry.status,
				retryAfterMs: lastRetry.delayMs,
				retryAfter: lastRetry.retryAfter,
				capped: lastRetry.capped,
				retryAttempts: providerRetries.length,
				stallTimeoutMs: timeoutMs,
			},
		});
	}
	return message;
}

function endAgentStreamOnError(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	promise: Promise<AgentMessage[]>,
): void {
	void promise.then(
		(messages) => {
			stream.end(messages);
		},
		() => {
			stream.end([]);
		},
	);
}

async function pollMessagesUnlessAborted(
	poll: (() => AgentMessage[] | Promise<AgentMessage[]>) | undefined,
	signal: AbortSignal | undefined,
): Promise<AgentMessage[]> {
	if (!poll || signal?.aborted) {
		return [];
	}
	return (await maybePromiseWithAbort(poll(), signal)) || [];
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	endAgentStreamOnError(
		stream,
		runAgentLoop(
			prompts,
			context,
			config,
			async (event) => {
				stream.push(event);
			},
			signal,
			streamFn,
		),
	);

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	endAgentStreamOnError(
		stream,
		runAgentLoopContinue(
			context,
			config,
			async (event) => {
				stream.push(event);
			},
			signal,
			streamFn,
		),
	);

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	let lastTurn: Parameters<NonNullable<AgentLoopConfig["getContinuationMessages"]>>[0] | undefined;
	let pendingMessages: AgentMessage[] = await pollMessagesUnlessAborted(config.getSteeringMessages, signal);

	const shouldStopBeforeTurn = (): boolean => !firstTurn && (config.shouldStopBeforeTurn?.() ?? false);

	while (true) {
		throwIfAborted(signal);
		let hasMoreToolCalls = true;

		while (hasMoreToolCalls || pendingMessages.length > 0) {
			throwIfAborted(signal);
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				const executedToolBatch = await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });
			if (signal?.aborted) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}
			lastTurn = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};

			const shouldStopResult = await settlePostTurn(
				maybePromiseWithAbort(
					config.shouldStopAfterTurn?.({
						message,
						toolResults,
						context: currentContext,
						newMessages,
					}) ?? false,
					signal,
				),
				signal,
			);
			if (shouldStopResult.status === "aborted") {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}
			if (shouldStopResult.value || shouldStopBeforeTurn()) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const steeringMessagesResult = await settlePostTurn(
				pollMessagesUnlessAborted(config.getSteeringMessages, signal),
				signal,
			);
			if (steeringMessagesResult.status === "aborted") {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}
			pendingMessages = steeringMessagesResult.value;
			// Steering drained by this poll owns the turn boundary; stop only when it was empty.
			if (pendingMessages.length === 0 && shouldStopBeforeTurn()) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}
		}

		if (shouldStopBeforeTurn()) break;
		const followUpMessagesResult = await settlePostTurn(
			pollMessagesUnlessAborted(config.getFollowUpMessages, signal),
			signal,
		);
		if (followUpMessagesResult.status === "aborted") {
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}
		const followUpMessages = followUpMessagesResult.value;
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue;
		}

		if (shouldStopBeforeTurn()) break;
		const continuationMessagesResult = lastTurn
			? await settlePostTurn(
					maybePromiseWithAbort(config.getContinuationMessages?.(lastTurn, signal) ?? [], signal),
					signal,
				)
			: ({ status: "completed", value: [] } satisfies PostTurnResult<AgentMessage[]>);
		if (continuationMessagesResult.status === "aborted") {
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}
		const continuationMessages = continuationMessagesResult.value || [];
		if (continuationMessages.length > 0) {
			pendingMessages = continuationMessages;
			continue;
		}

		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/** Defaults for the in-place empty-turn retry policy; overridable via `AgentLoopConfig.emptyTurnRetry`. */
export const EMPTY_TURN_RETRY_DEFAULTS = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 4000 } as const;

/**
 * Wait between in-place empty-turn retries. Resolves early when the run signal fires,
 * so an abort is never delayed by the backoff (the next attempt takes the abort path).
 */
function waitAbortably(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	if (delayMs <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		const timer = setTimeout(finish, delayMs);
		const onAbort = () => finish();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) finish();
	});
}

/**
 * Synthetic `stopReasonRaw` for a turn that exhausted the empty-response retries.
 * This is not a provider value: callers use it to tell this terminal case apart
 * from a provider error that is worth retrying.
 */
export const EMPTY_TURN_RETRY_EXHAUSTED_STOP_REASON_RAW = "empty_response_retry_exhausted";

/** Whether a message is the terminal empty-turn-retry failure. */
export function isEmptyTurnRetryExhausted(message: AssistantMessage): boolean {
	return message.stopReason === "error" && message.stopReasonRaw === EMPTY_TURN_RETRY_EXHAUSTED_STOP_REASON_RAW;
}

/** Diagnostic type on the terminal empty-turn failure: attempts, waits, and the effective policy. */
export const EMPTY_TURN_RETRY_EXHAUSTED_DIAGNOSTIC_TYPE = "empty_turn_retry_exhausted";

function resolveEmptyTurnRetryPolicy(options?: EmptyTurnRetryConfig): {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
	maxTotalDelayMs: number;
} {
	const maxAttempts = Math.max(1, Math.floor(options?.maxAttempts ?? EMPTY_TURN_RETRY_DEFAULTS.maxAttempts));
	const baseDelayMs = Math.max(0, options?.baseDelayMs ?? EMPTY_TURN_RETRY_DEFAULTS.baseDelayMs);
	const maxDelayMs = Math.max(baseDelayMs, options?.maxDelayMs ?? EMPTY_TURN_RETRY_DEFAULTS.maxDelayMs);
	const maxTotalDelayMs = Math.max(0, options?.maxTotalDelayMs ?? maxDelayMs * Math.max(0, maxAttempts - 1));
	return { maxAttempts, baseDelayMs, maxDelayMs, maxTotalDelayMs };
}

function emptyTurnExhaustedMessage(
	attempts: number,
	discarded: { waitedMs: number },
	terminatedBy: "attempts" | "budget" | "abort" | "request_budget",
	requestBudget: { used: number; maxRequests?: number } = { used: 0 },
): string {
	const waited = `waited ${discarded.waitedMs}ms between attempts`;
	const why =
		terminatedBy === "request_budget"
			? `the shared provider request budget ran out after ${requestBudget.used} request(s) in this chain` +
				(requestBudget.maxRequests === undefined ? "" : ` (ceiling ${requestBudget.maxRequests})`) +
				`, so the resends stopped instead of spending more (attempted ${attempts} replies, ${waited})`
			: terminatedBy === "budget"
				? `the retry wait budget ran out (attempted ${attempts} replies, ${waited})`
				: terminatedBy === "abort"
					? `the run was aborted between attempts (got ${attempts} empty replies, ${waited})`
					: `the provider answered ${attempts} times in a row with no output content or tool calls (${waited})`;
	return (
		`Model returned an empty response ${attempts} times in a row: ${why}. ` +
		"This is the provider returning a clean stop turn with nothing in it, not a connection failure. " +
		"Adjust retry.emptyTurn.maxAttempts/baseDelayMs/maxTotalDelayMs for more or longer in-place retries, or resend the turn when the upstream recovers."
	);
}

function recordEmptyTurnExhaustion(
	message: AssistantMessage,
	attempts: number,
	discarded: { waitedMs: number },
	policy: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; maxTotalDelayMs: number },
	requestBudget: { used: number; maxRequests?: number },
	terminatedBy: "attempts" | "budget" | "abort" | "request_budget",
): void {
	appendAssistantMessageDiagnostic(message, {
		type: EMPTY_TURN_RETRY_EXHAUSTED_DIAGNOSTIC_TYPE,
		timestamp: Date.now(),
		details: {
			attempts,
			waitedMs: discarded.waitedMs,
			maxAttempts: policy.maxAttempts,
			baseDelayMs: policy.baseDelayMs,
			maxDelayMs: policy.maxDelayMs,
			maxTotalDelayMs: policy.maxTotalDelayMs,
			terminatedBy,
			requestBudget,
		},
	});
}

/**
 * Diagnostic type for a chain that issued more than one provider request, or that was cut
 * short by the shared budget. SDK-level retries used to leave no trace at all in the
 * transcript, so a turn that quietly spent four requests read exactly like one that spent
 * one; this puts the attempt list, the chain total and the ceiling on the message.
 */
export const PROVIDER_REQUEST_BUDGET_DIAGNOSTIC_TYPE = "provider_request_budget";

function recordProviderRequestAttempts(
	message: AssistantMessage,
	attempts: readonly ProviderRequestAttemptNotice[],
	budget: { used: number; maxRequests?: number },
): void {
	if (attempts.length <= 1 && !attempts.some((attempt) => attempt.retrySuppressedBy !== undefined)) {
		return;
	}
	appendAssistantMessageDiagnostic(message, {
		type: PROVIDER_REQUEST_BUDGET_DIAGNOSTIC_TYPE,
		timestamp: Date.now(),
		details: {
			attempts: attempts.map((attempt) => ({
				attempt: attempt.attempt,
				status: attempt.status,
				networkError: attempt.networkError,
				retrySuppressedBy: attempt.retrySuppressedBy,
			})),
			used: budget.used,
			maxRequests: budget.maxRequests,
		},
	});
}

/**
 * A final turn with no tool calls and no non-thinking content. Providers occasionally
 * end a stream like this with a normal stop reason; treating it as completion would
 * silently abandon the task, so it is retried instead. Error, abort, and length turns
 * are excluded: they are signals of their own, and an identical resend cannot help.
 */
function isEmptyAssistantTurn(message: AssistantMessage): boolean {
	if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") {
		return false;
	}
	return !message.content.some(
		(part) => part.type === "toolCall" || (part.type === "text" && part.text.trim().length > 0),
	);
}

async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// A discarded attempt emits no message_end, so its spend would vanish from any
	// accounting that reads usage off the transcript. Carry cost and output tokens
	// forward onto the terminal message. Input tokens, cacheRead, cacheWrite and
	// totalTokens are deliberately left at the final attempt's values: they describe
	// the context that attempt actually occupied, and summing attempts would report a
	// context size no single request ever had.
	//
	// That is a data-semantics rule, and it is the only reason that holds on every
	// terminal shape. The carry below runs for whichever message ends the loop, so the
	// terminal may be the synthesized error, a successful stop turn, or a length turn
	// passing through - and on the latter two the overflow check is live: its case 2
	// reads input + cacheRead on stop turns and its case 3 reads output on length
	// turns. Inflating the context fields would therefore misclassify a real stop turn
	// as an overflow, which is why they are never summed on any path.
	const discarded = { cost: { ...EMPTY_USAGE.cost }, output: 0, attempts: 0, waitedMs: 0 };
	const emptyTurnPolicy = resolveEmptyTurnRetryPolicy(config.emptyTurnRetry);
	// One request budget for every layer that can issue a provider request for this
	// chain: the SDK's own retries (via the provider fetch wrapper) and the in-place
	// resends below all count into the same pool, so the layers cannot multiply.
	const requestBudget =
		config.requestBudget ??
		(config.sessionId ? getProviderRequestBudget(config.sessionId) : new ProviderRequestBudget());
	const providerAttempts: ProviderRequestAttemptNotice[] = [];
	const callerAttemptSink = config.onProviderRequestAttempt;
	const loopConfig: AgentLoopConfig = {
		...config,
		requestBudget,
		onProviderRequestAttempt: (notice) => {
			providerAttempts.push(notice);
			callerAttemptSink?.(notice);
		},
	};
	for (let attempt = 1; ; attempt++) {
		const message = await streamAssistantResponseAttempt(context, loopConfig, signal, emit, streamFn);
		// Overflow turns are never discarded, so compaction recovery can still see them.
		// "Untouched" covers the retry decision and the token fields; when earlier attempts
		// were discarded, their cost is still carried onto this message below.
		const overflow = isContextOverflow(message, config.model.contextWindow);
		// A real answer ends the chain, so the next request starts from a clean pool. An
		// empty turn does not: it is exactly the shape the resends below exist for.
		if (
			!overflow &&
			!isEmptyAssistantTurn(message) &&
			message.stopReason !== "error" &&
			message.stopReason !== "aborted"
		) {
			requestBudget.reset();
		}
		if (isEmptyAssistantTurn(message) && !overflow) {
			// Resend gaps: an empty reply usually means the upstream is queued or
			// overloaded, and three requests inside the same millisecond are the worst
			// thing to do to it. The wait is exponential, capped per wait and per turn,
			// and honors the run signal (an abort continues into the attempt's own abort
			// path instead of being delayed by us).
			const delayMs = Math.min(emptyTurnPolicy.baseDelayMs * 2 ** (attempt - 1), emptyTurnPolicy.maxDelayMs);
			const withinAttempts = attempt < emptyTurnPolicy.maxAttempts;
			const withinWaitBudget = discarded.waitedMs + delayMs <= emptyTurnPolicy.maxTotalDelayMs;
			// The shared budget is the outer bound: when the SDK already spent the chain's
			// last request, this layer must not start another one.
			if (withinAttempts && withinWaitBudget && !requestBudget.exhausted) {
				discarded.attempts += 1;
				discarded.waitedMs += delayMs;
				discarded.output += message.usage.output;
				discarded.cost.input += message.usage.cost.input;
				discarded.cost.output += message.usage.cost.output;
				discarded.cost.cacheRead += message.usage.cost.cacheRead;
				discarded.cost.cacheWrite += message.usage.cost.cacheWrite;
				discarded.cost.total += message.usage.cost.total;
				// Drop the empty attempt so it is neither resent to the provider nor
				// finalized as a transcript turn (message_end is what makes it durable).
				context.messages.pop();
				await waitAbortably(delayMs, signal);
				continue;
			}
			// Which limit actually stopped the resends, in the order they are checked:
			// the container abort, the attempt count, the wait budget, then the shared
			// request budget - naming the wrong one sends the reader at the wrong knob.
			const terminatedBy: "attempts" | "budget" | "abort" | "request_budget" = signal?.aborted
				? "abort"
				: !withinAttempts
					? "attempts"
					: !withinWaitBudget
						? "budget"
						: "request_budget";
			message.stopReason = "error";
			message.stopReasonRaw = EMPTY_TURN_RETRY_EXHAUSTED_STOP_REASON_RAW;
			message.errorMessage = emptyTurnExhaustedMessage(attempt, discarded, terminatedBy, requestBudget);
			recordEmptyTurnExhaustion(message, attempt, discarded, emptyTurnPolicy, requestBudget, terminatedBy);
		}
		if (discarded.attempts > 0) {
			// Carry the discarded spend onto whichever message ends the loop: the synthesized
			// error, or a later attempt that succeeded. Without this the successful case loses
			// every discarded attempt, because only the terminal message reaches message_end.
			//
			// Output tokens are added only when the terminal is not an overflow turn. Case 3 of
			// isContextOverflow keys on usage.output === 0, and callers downstream re-run that
			// check on this same message, so inflating it here would hide an overflow from
			// compaction recovery. Cost has no such reader and is always carried.
			//
			// The guard is deliberately wider than the harm: only case 3 reads output, so a
			// stop-turn overflow terminal also forgoes the discarded output tokens. That
			// under-reports tokens on a path where the money is still carried in full, which
			// is the conservative direction; narrowing it to stopReason === "length" would buy
			// minor precision at the cost of tracking the check's internals here.
			message.usage = {
				...message.usage,
				output: overflow ? message.usage.output : message.usage.output + discarded.output,
				cost: {
					input: message.usage.cost.input + discarded.cost.input,
					output: message.usage.cost.output + discarded.cost.output,
					cacheRead: message.usage.cost.cacheRead + discarded.cost.cacheRead,
					cacheWrite: message.usage.cost.cacheWrite + discarded.cost.cacheWrite,
					total: message.usage.cost.total + discarded.cost.total,
				},
			};
		}
		recordProviderRequestAttempts(message, providerAttempts, requestBudget);
		await emit({ type: "message_end", message });
		return message;
	}
}

/**
 * Diagnostic type attached to an assistant message whose tool call ids had to be
 * renamed. `details.collisions` carries the per-call rewrite (original id, tool
 * name, replacement), so a reused id is visible in the transcript, not silent.
 */
export const TOOL_CALL_ID_COLLISION_DIAGNOSTIC_TYPE = "tool_call_id_collision";

type ToolCallIdCollisionLog = Map<string, ToolCallIdCollision>;

function recordToolCallIdCollisions(
	message: AssistantMessage,
	collisions: ReadonlyMap<string, ToolCallIdCollision>,
): void {
	if (collisions.size === 0) {
		return;
	}
	const list = [...collisions.values()];
	appendAssistantMessageDiagnostic(message, {
		type: TOOL_CALL_ID_COLLISION_DIAGNOSTIC_TYPE,
		timestamp: Date.now(),
		details: { message: formatToolCallIdCollisions(list), collisions: list },
	});
}

/** Runs one assistant stream and places the final message in context, without emitting message_end. */
async function streamAssistantResponseAttempt(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// A message that reuses a tool call id is repaired by renaming the later calls,
	// so no downstream consumer (UI rows, stall bookkeeping, the next request body)
	// has to guess which result belongs to which call. The rewrite is reported once,
	// on the finalized message, instead of per stream chunk.
	const idCollisions: ToolCallIdCollisionLog = new Map();
	const message = await runAssistantStreamAttempt(context, config, signal, emit, streamFn, idCollisions);
	recordToolCallIdCollisions(message, idCollisions);
	return message;
}

async function runAssistantStreamAttempt(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn: StreamFn | undefined,
	idCollisions: ToolCallIdCollisionLog,
): Promise<AssistantMessage> {
	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;
	/**
	 * Renames repeated tool call ids in a streamed message. The provider re-delivers
	 * the whole partial message on every chunk, so this runs per chunk and must stay
	 * a pure function of the content: ids are assigned left to right, which is what
	 * keeps an id stable once a consumer has seen it.
	 */
	const normalizeToolCallIds = (message: AssistantMessage): AssistantMessage => {
		const { content, collisions } = deduplicateToolCallIds(message.content);
		if (collisions.length === 0) {
			return message;
		}
		for (const collision of collisions) {
			idCollisions.set(`${collision.contentIndex}:${collision.originalId}`, collision);
		}
		return { ...message, content };
	};
	/** Applies the same rename to the event, so `partial` and `toolCall` agree with `message`. */
	const normalizeStreamEvent = (event: AssistantMessageEvent): AssistantMessageEvent => {
		if (!("partial" in event)) {
			return event;
		}
		const partial = normalizeToolCallIds(event.partial);
		if (event.type !== "toolcall_end") {
			return partial === event.partial ? event : { ...event, partial };
		}
		const part = partial.content[event.contentIndex];
		const toolCall = part?.type === "toolCall" ? part : event.toolCall;
		return partial === event.partial && toolCall === event.toolCall ? event : { ...event, partial, toolCall };
	};
	const finishAbortedMessage = async () => {
		const finalMessage = createAbortedAssistantMessage(config, partialMessage);
		if (addedPartial) {
			context.messages[context.messages.length - 1] = finalMessage;
		} else {
			context.messages.push(finalMessage);
			await emit({ type: "message_start", message: { ...finalMessage } });
		}
		return finalMessage;
	};

	const streamStallTimeoutMs =
		typeof config.streamStallTimeoutMs === "number" && config.streamStallTimeoutMs > 0
			? config.streamStallTimeoutMs
			: undefined;
	const stallController = streamStallTimeoutMs !== undefined ? new AbortController() : undefined;
	let stallTimer: ReturnType<typeof setTimeout> | undefined;
	let stallReject!: (error: StreamStallError) => void;
	// Server-directed retry waits observed during this attempt: proof the provider
	// answered, so a following silence is throttling, not a dead connection.
	const providerRetries: ProviderRetryNotice[] = [];
	const stallPromise = new Promise<never>((_resolve, reject) => {
		stallReject = reject;
	});
	const clearStallTimer = (): void => {
		if (stallTimer !== undefined) {
			clearTimeout(stallTimer);
			stallTimer = undefined;
		}
	};
	const armStallTimer = (): void => {
		if (streamStallTimeoutMs === undefined) return;
		clearStallTimer();
		const timeoutMs = streamStallTimeoutMs;
		stallTimer = setTimeout(() => {
			stallTimer = undefined;
			const error = new StreamStallError(timeoutMs);
			// Kill the provider request too, so the dead connection doesn't linger.
			stallController?.abort(error);
			stallReject(error);
		}, timeoutMs);
	};
	const raceStall = <T>(operation: Promise<T>): Promise<T> =>
		streamStallTimeoutMs === undefined ? operation : Promise.race([operation, stallPromise]);
	let closeIterator: (() => void) | undefined;
	const finishStalledMessage = async (error: StreamStallError) => {
		const finalMessage = createStalledAssistantMessage(config, partialMessage, error.timeoutMs, providerRetries);
		if (addedPartial) {
			context.messages[context.messages.length - 1] = finalMessage;
		} else {
			context.messages.push(finalMessage);
			await emit({ type: "message_start", message: { ...finalMessage } });
		}
		// The empty-turn retry wrapper owns message_end for every attempt path; this
		// fork-local stall return kept its own emit, which persisted the stalled turn
		// twice (appendMessage has no dedupe) and double-fired extension handlers.
		return finalMessage;
	};

	try {
		throwIfAborted(signal);
		let messages = context.messages;
		if (config.transformContext) {
			messages = await maybePromiseWithAbort(config.transformContext(messages, signal), signal);
		}

		const llmMessages = await maybePromiseWithAbort(config.convertToLlm(messages), signal);

		const streamFunction = streamFn || streamSimple;

		const resolvedApiKey =
			(config.getApiKey
				? await maybePromiseWithAbort(config.getApiKey(config.model.provider), signal)
				: undefined) || config.apiKey;

		const llmContext: Context = {
			systemPrompt: config.getSystemPrompt?.() ?? context.systemPrompt,
			messages: llmMessages,
			tools: context.tools,
		};

		// The stall deadline covers the provider call itself and every gap between
		// events; the run signal aborts the race like before, the stall controller
		// additionally reaches the provider so a dead connection is torn down.
		const streamSignal =
			signal && stallController
				? AbortSignal.any([signal, stallController.signal])
				: (signal ?? stallController?.signal);

		armStallTimer();
		const response = await raceStall(
			maybePromiseWithAbort(
				streamFunction(config.model, llmContext, {
					...config,
					apiKey: resolvedApiKey,
					signal: streamSignal,
					onProviderRetry: (notice: ProviderRetryNotice) => {
						providerRetries.push(notice);
					},
				}),
				signal,
			),
		);
		const iterator = response[Symbol.asyncIterator]();
		closeIterator = () => {
			void Promise.resolve(iterator.return?.()).catch(() => undefined);
		};
		while (true) {
			const next = await raceStall(
				raceWithAbort<IteratorResult<AssistantMessageEvent>>(iterator.next(), signal, closeIterator),
			);
			if (next.done) {
				clearStallTimer();
				break;
			}
			const event = normalizeStreamEvent(next.value);
			armStallTimer();
			switch (event.type) {
				case "start":
					partialMessage = event.partial;
					context.messages.push(partialMessage);
					addedPartial = true;
					await emit({ type: "message_start", message: { ...partialMessage } });
					break;

				case "text_start":
				case "text_delta":
				case "text_end":
				case "thinking_start":
				case "thinking_delta":
				case "thinking_end":
				case "toolcall_start":
				case "toolcall_delta":
				case "toolcall_end":
					if (partialMessage) {
						partialMessage = event.partial;
						context.messages[context.messages.length - 1] = partialMessage;
						await emit({
							type: "message_update",
							assistantMessageEvent: event,
							message: { ...partialMessage },
						});
					}
					break;

				case "done":
				case "error": {
					clearStallTimer();
					let finalMessage = normalizeToolCallIds(getTerminalMessage(event));
					try {
						finalMessage = normalizeToolCallIds(await maybePromiseWithAbort(response.result(), signal));
					} catch (error) {
						if (!signal?.aborted || !isAbortError(error)) {
							throw error;
						}
					}
					if (addedPartial) {
						context.messages[context.messages.length - 1] = finalMessage;
					} else {
						context.messages.push(finalMessage);
					}
					if (!addedPartial) {
						await emit({ type: "message_start", message: { ...finalMessage } });
					}
					return finalMessage;
				}
			}
		}

		const finalMessage = normalizeToolCallIds(await maybePromiseWithAbort(response.result(), signal));
		if (addedPartial) {
			context.messages[context.messages.length - 1] = finalMessage;
		} else {
			context.messages.push(finalMessage);
			await emit({ type: "message_start", message: { ...finalMessage } });
		}
		return finalMessage;
	} catch (error) {
		clearStallTimer();
		if (signal?.aborted && isAbortError(error)) {
			return finishAbortedMessage();
		}
		if (error instanceof StreamStallError || (stallController?.signal.aborted && isAbortError(error))) {
			closeIterator?.();
			return finishStalledMessage(
				error instanceof StreamStallError ? error : new StreamStallError(streamStallTimeoutMs ?? 0),
			);
		}
		throw error;
	}
}

async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		if (signal?.aborted) {
			break;
		}

		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
	/** True when the abort raced an in-flight execute, so `result` is a stub carrying no tool output. */
	abortedInFlight?: boolean;
	/** The still-running execute promise; harvested (bounded) for partial output on the abort path. */
	pendingOperation?: Promise<AgentToolResult<any>>;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await maybePromiseWithAbort(
				config.beforeToolCall(
					{
						assistantMessage,
						toolCall,
						args: validatedArgs,
						context: currentContext,
					},
					signal,
				),
				signal,
			);
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;
	/** The raw execute promise, kept so an abort can still harvest what the tool produced. */
	let operation: Promise<AgentToolResult<any>> | undefined;

	try {
		throwIfAborted(signal);
		operation = prepared.tool.execute(prepared.toolCall.id, prepared.args as never, signal, (partialResult) => {
			if (!acceptingUpdates || signal?.aborted) {
				return;
			}
			updateEvents.push(
				Promise.resolve(
					emit({
						type: "tool_execution_update",
						toolCallId: prepared.toolCall.id,
						toolName: prepared.toolCall.name,
						args: prepared.toolCall.arguments,
						partialResult,
					}),
				),
			);
		});
		// Sink: the abort can settle the race long before the tool does, and a late
		// rejection must never escape as an unhandledRejection.
		void operation.catch(() => undefined);
		const result = await raceWithAbort(operation, signal);
		acceptingUpdates = false;
		try {
			await raceWithAbort(
				Promise.all(updateEvents).then(() => undefined),
				signal,
			);
		} catch (error) {
			if (!signal?.aborted || !isAbortError(error)) {
				throw error;
			}
		}
		return { result, isError: false };
	} catch (error) {
		acceptingUpdates = false;
		await raceWithAbort(
			Promise.all(updateEvents).then(() => undefined),
			signal,
		).catch(() => undefined);
		const abortedInFlight = signal?.aborted === true;
		return {
			result: createErrorToolResult(
				abortedInFlight ? TOOL_ABORT_FALLBACK_MESSAGE : error instanceof Error ? error.message : String(error),
			),
			isError: true,
			// Keep the in-flight promise so finalize can harvest partial output instead
			// of reporting a 19-character riddle.
			...(abortedInFlight && operation ? { abortedInFlight: true, pendingOperation: operation } : {}),
			...(abortedInFlight && !operation ? { abortedInFlight: true } : {}),
		};
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;
	let abortedDuringFinalize = false;

	if (config.afterToolCall) {
		try {
			const afterResult = await maybePromiseWithAbort(
				config.afterToolCall(
					{
						assistantMessage,
						toolCall: prepared.toolCall,
						args: prepared.args,
						result,
						isError,
						context: currentContext,
					},
					signal,
				),
				signal,
			);
			if (afterResult) {
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			if (signal?.aborted && isAbortError(error)) {
				// The turn was aborted while this result was being finalized. Keep what the
				// tool produced instead of overwriting it with the abort message: the model
				// needs the partial output to tell whether the work already happened, which
				// is what stops a blind re-run of a long command.
				abortedDuringFinalize = true;
			} else {
				result = createErrorToolResult(error instanceof Error ? error.message : String(error));
				isError = true;
			}
		}
	}

	if (abortedDuringFinalize || executed.abortedInFlight === true) {
		return {
			toolCall: prepared.toolCall,
			result: await preserveAbortedToolResult(executed, result),
			isError: true,
		};
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
