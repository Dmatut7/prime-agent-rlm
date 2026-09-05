/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	isContextOverflow,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

const ABORT_ERROR_MESSAGE = "Request was aborted";
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

function createStalledAssistantMessage(
	config: AgentLoopConfig,
	partialMessage: AssistantMessage | null,
	timeoutMs: number,
): AssistantMessage {
	return {
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

const MAX_EMPTY_TURN_ATTEMPTS = 3;

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
	const discarded = { cost: { ...EMPTY_USAGE.cost }, output: 0, attempts: 0 };
	for (let attempt = 1; ; attempt++) {
		const message = await streamAssistantResponseAttempt(context, config, signal, emit, streamFn);
		// Overflow turns are never discarded, so compaction recovery can still see them.
		// "Untouched" covers the retry decision and the token fields; when earlier attempts
		// were discarded, their cost is still carried onto this message below.
		const overflow = isContextOverflow(message, config.model.contextWindow);
		if (isEmptyAssistantTurn(message) && !overflow) {
			if (attempt < MAX_EMPTY_TURN_ATTEMPTS) {
				discarded.attempts += 1;
				discarded.output += message.usage.output;
				discarded.cost.input += message.usage.cost.input;
				discarded.cost.output += message.usage.cost.output;
				discarded.cost.cacheRead += message.usage.cost.cacheRead;
				discarded.cost.cacheWrite += message.usage.cost.cacheWrite;
				discarded.cost.total += message.usage.cost.total;
				// Drop the empty attempt so it is neither resent to the provider nor
				// finalized as a transcript turn (message_end is what makes it durable).
				context.messages.pop();
				continue;
			}
			message.stopReason = "error";
			message.stopReasonRaw = EMPTY_TURN_RETRY_EXHAUSTED_STOP_REASON_RAW;
			message.errorMessage = `Model returned an empty response (no output content or tool calls) ${MAX_EMPTY_TURN_ATTEMPTS} times in a row`;
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
		await emit({ type: "message_end", message });
		return message;
	}
}

/** Runs one assistant stream and places the final message in context, without emitting message_end. */
async function streamAssistantResponseAttempt(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;
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
		const finalMessage = createStalledAssistantMessage(config, partialMessage, error.timeoutMs);
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
			const event = next.value;
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
					let finalMessage = getTerminalMessage(event);
					try {
						finalMessage = await maybePromiseWithAbort(response.result(), signal);
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

		const finalMessage = await maybePromiseWithAbort(response.result(), signal);
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

	try {
		throwIfAborted(signal);
		const result = await raceWithAbort(
			prepared.tool.execute(prepared.toolCall.id, prepared.args as never, signal, (partialResult) => {
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
			}),
			signal,
		);
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
		return {
			result: createErrorToolResult(
				signal?.aborted ? "Tool execution aborted" : error instanceof Error ? error.message : String(error),
			),
			isError: true,
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
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
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
