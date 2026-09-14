import { type AssistantMessage, type AssistantMessageEvent, parseStreamingJson } from "@earendil-works/pi-ai";
import type { CompactAssistantDelta, CompactAssistantMessageEvent, DaemonOutbound } from "./daemon-protocol.js";

export type { CompactAssistantDelta, CompactAssistantMessageEvent };

type SessionEvent = Extract<DaemonOutbound, { type: "session_event" }>["event"];
type MessageUpdateEvent = Extract<SessionEvent, { type: "message_update" }>;

export interface CompactAssistantDeltaOptions {
	/**
	 * "snapshot" (default) attaches the parsed arguments snapshot to every
	 * tool-call delta — O(arguments²) on the wire per tool call. "fragments"
	 * omits it; consumers accumulate event.delta and parse throttled instead.
	 * Only for consumers that negotiated the streaming_delta_fragments
	 * capability.
	 */
	toolCallArguments?: "snapshot" | "fragments";
}

export interface CompactDeltaPlan {
	compact: boolean;
	toolCallArguments: "snapshot" | "fragments";
}

/**
 * Which encoding a session outbound gets on one client link. The supervisor
 * leg always takes compact deltas (it reconstructs and redistributes); a
 * direct session peer takes them only when it declared the streaming_deltas
 * capability on attach, and fragment-only tool-call deltas only with the
 * streaming_delta_fragments capability. Plain jsonl links never take deltas.
 */
export function planCompactAssistantDelta(
	transport: "jsonl" | "private-framed" | undefined,
	authenticationRole: "supervisor" | "session_client" | undefined,
	capabilities: ReadonlySet<string>,
): CompactDeltaPlan {
	const compact =
		transport === "private-framed" &&
		(authenticationRole !== "session_client" || capabilities.has("streaming_deltas"));
	return {
		compact,
		toolCallArguments: compact && capabilities.has("streaming_delta_fragments") ? "fragments" : "snapshot",
	};
}

/**
 * True for tool-call deltas that carry only the new fragment (no parsed
 * arguments snapshot). Consumers without the streaming_delta_fragments
 * capability must receive a rebuilt full message_update for these instead,
 * so forwarders use this to pick the payload per client.
 */
export function isFragmentOnlyToolCallDelta(delta: CompactAssistantDelta): boolean {
	return delta.assistantMessageEvent.type === "toolcall_delta" && delta.toolCallArguments === undefined;
}

export function createCompactAssistantDelta(
	message: DaemonOutbound,
	options: CompactAssistantDeltaOptions = {},
): CompactAssistantDelta | undefined {
	if (message.type !== "session_event" || message.event.type !== "message_update") {
		return undefined;
	}
	if (message.event.message.role !== "assistant") {
		return undefined;
	}
	const { partial: _partial, ...assistantMessageEvent } = message.event
		.assistantMessageEvent as AssistantMessageEvent & {
		partial?: AssistantMessage;
	};
	const contentStart = compactContentStart(message.event.message, assistantMessageEvent);
	const toolCallArguments =
		options.toolCallArguments === "fragments"
			? undefined
			: compactToolCallArguments(message.event.message, assistantMessageEvent);
	return {
		type: "assistant_stream_delta",
		activeSessionId: message.activeSessionId,
		assistantMessageEvent: assistantMessageEvent as CompactAssistantMessageEvent,
		...(contentStart ? { contentStart } : {}),
		...(toolCallArguments ? { toolCallArguments } : {}),
		...(message.meta ? { meta: message.meta } : {}),
	};
}

function compactToolCallArguments(
	message: AssistantMessage,
	event: CompactAssistantMessageEvent,
): Record<string, unknown> | undefined {
	if (event.type !== "toolcall_delta") {
		return undefined;
	}
	const content = message.content[event.contentIndex];
	return content?.type === "toolCall" ? content.arguments : undefined;
}

function compactContentStart(
	message: AssistantMessage,
	event: CompactAssistantMessageEvent,
): AssistantMessage["content"][number] | undefined {
	if (event.type !== "text_start" && event.type !== "thinking_start" && event.type !== "toolcall_start") {
		return undefined;
	}
	const content = message.content[event.contentIndex];
	if (event.type === "text_start" && content?.type === "text") {
		return { ...content, text: "" };
	}
	if (event.type === "thinking_start" && content?.type === "thinking") {
		return { ...content, thinking: "" };
	}
	if (event.type === "toolcall_start" && content?.type === "toolCall") {
		return { ...content, arguments: {} };
	}
	return undefined;
}

// Mid-stream argument parses are throttled exactly like the provider-side
// streaming-json throttle (packages/ai/src/utils/streaming-json-throttle.ts):
// re-parsing the whole accumulated buffer on every fragment is quadratic.
// toolcall_end carries the authoritative final toolCall, so skipped parses
// only make the mid-stream preview lag.
const MIN_PARSE_GROWTH_CHARS = 1024;
const MIN_PARSE_INTERVAL_MS = 50;

interface ToolCallParseState {
	json: string;
	lastParsedLength: number;
	lastParseTime: number;
}

export class CompactAssistantStreamReconstructor {
	private readonly partialMessages = new Map<string, AssistantMessage>();
	private readonly toolCallJson = new Map<string, ToolCallParseState>();

	seed(activeSessionId: string, message: AssistantMessage): void {
		// Own the partial: reconstruct() mutates content blocks in place, and
		// seeds typically reference snapshot/summary messages that must stay
		// unmodified.
		this.partialMessages.set(activeSessionId, {
			...message,
			content: message.content.map((block) => ({ ...block })),
		});
	}

	/** Whether a live partial message is currently tracked for the session. */
	hasPartial(activeSessionId: string): boolean {
		return this.partialMessages.has(activeSessionId);
	}

	observe(message: DaemonOutbound): void {
		if (message.type !== "session_event") {
			if (
				message.type === "session_replaced" ||
				message.type === "session_resynced" ||
				message.type === "session_closed"
			) {
				this.clear(message.activeSessionId);
			}
			return;
		}
		if (message.event.type === "message_start" && message.event.message.role === "assistant") {
			// Own the partial: reconstruct() mutates content blocks in place, and
			// the incoming message_start event may be referenced elsewhere.
			this.partialMessages.set(message.activeSessionId, {
				...message.event.message,
				content: message.event.message.content.map((block) => ({ ...block })),
			});
			return;
		}
		if (message.event.type === "message_end") {
			this.clear(message.activeSessionId);
		}
	}

	reconstruct(delta: CompactAssistantDelta): DaemonOutbound | undefined {
		const partial = this.partialMessages.get(delta.activeSessionId);
		if (!partial) {
			return undefined;
		}
		const event = delta.assistantMessageEvent;
		switch (event.type) {
			case "text_start":
				partial.content[event.contentIndex] = delta.contentStart ?? { type: "text", text: "" };
				break;
			case "text_delta": {
				const content = partial.content[event.contentIndex];
				if (content?.type !== "text") {
					return undefined;
				}
				content.text += event.delta;
				break;
			}
			case "text_end": {
				const content = partial.content[event.contentIndex];
				if (content?.type !== "text") {
					return undefined;
				}
				content.text = event.content;
				break;
			}
			case "thinking_start":
				partial.content[event.contentIndex] = delta.contentStart ?? { type: "thinking", thinking: "" };
				break;
			case "thinking_delta": {
				const content = partial.content[event.contentIndex];
				if (content?.type !== "thinking") {
					return undefined;
				}
				content.thinking += event.delta;
				break;
			}
			case "thinking_end": {
				const content = partial.content[event.contentIndex];
				if (content?.type !== "thinking") {
					return undefined;
				}
				content.thinking = event.content;
				break;
			}
			case "toolcall_start":
				if (!delta.contentStart || delta.contentStart.type !== "toolCall") {
					return undefined;
				}
				partial.content[event.contentIndex] = delta.contentStart;
				this.toolCallJson.set(this.toolCallKey(delta.activeSessionId, event.contentIndex), {
					json: "",
					lastParsedLength: 0,
					lastParseTime: 0,
				});
				break;
			case "toolcall_delta": {
				const content = partial.content[event.contentIndex];
				if (content?.type !== "toolCall") {
					return undefined;
				}
				if (delta.toolCallArguments) {
					content.arguments = delta.toolCallArguments;
				} else {
					const key = this.toolCallKey(delta.activeSessionId, event.contentIndex);
					const state = this.toolCallJson.get(key) ?? { json: "", lastParsedLength: 0, lastParseTime: 0 };
					state.json += event.delta;
					this.toolCallJson.set(key, state);
					const now = Date.now();
					if (
						state.json.length - state.lastParsedLength >= MIN_PARSE_GROWTH_CHARS ||
						now - state.lastParseTime >= MIN_PARSE_INTERVAL_MS
					) {
						state.lastParsedLength = state.json.length;
						state.lastParseTime = now;
						content.arguments = parseStreamingJson<Record<string, unknown>>(state.json);
					}
					// A skipped parse keeps the previous arguments: toolcall_end
					// replaces the block with the authoritative final toolCall.
				}
				break;
			}
			case "toolcall_end":
				partial.content[event.contentIndex] = event.toolCall;
				this.toolCallJson.delete(this.toolCallKey(delta.activeSessionId, event.contentIndex));
				break;
			case "start":
			case "done":
			case "error":
				return undefined;
		}
		return {
			type: "session_event",
			activeSessionId: delta.activeSessionId,
			event: {
				type: "message_update",
				message: { ...partial, content: [...partial.content] },
				assistantMessageEvent: event as MessageUpdateEvent["assistantMessageEvent"],
			},
			...(delta.meta ? { meta: delta.meta } : {}),
		};
	}

	clear(activeSessionId: string): void {
		this.partialMessages.delete(activeSessionId);
		for (const key of this.toolCallJson.keys()) {
			if (key.startsWith(`${activeSessionId}:`)) {
				this.toolCallJson.delete(key);
			}
		}
	}

	private toolCallKey(activeSessionId: string, contentIndex: number): string {
		return `${activeSessionId}:${contentIndex}`;
	}
}

export function isCompactAssistantDelta(value: unknown): value is CompactAssistantDelta {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; activeSessionId?: unknown; assistantMessageEvent?: unknown };
	return (
		candidate.type === "assistant_stream_delta" &&
		typeof candidate.activeSessionId === "string" &&
		typeof candidate.assistantMessageEvent === "object" &&
		candidate.assistantMessageEvent !== null
	);
}
