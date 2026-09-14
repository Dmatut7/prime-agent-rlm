import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import * as compactStream from "../src/modes/daemon/compact-session-stream.js";
import {
	type CompactAssistantDelta,
	CompactAssistantStreamReconstructor,
	createCompactAssistantDelta,
} from "../src/modes/daemon/compact-session-stream.js";
import { DAEMON_PROTOCOL_INFO, type DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("compact daemon assistant streaming", () => {
	it("reconstructs the legacy full message_update from start and delta frames", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		reconstructor.observe({
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "message_start", message: assistant([]) },
		});

		const started = assistant([{ type: "text", text: "" }]);
		const startFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "message_update",
				message: started,
				assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: started },
			},
		});
		expect(startFrame).toBeDefined();
		expect(reconstructor.reconstruct(startFrame!)).toMatchObject({
			event: { type: "message_update", message: { content: [{ type: "text", text: "" }] } },
		});

		const updated = assistant([{ type: "text", text: "hello" }]);
		const deltaFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "message_update",
				message: updated,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: updated },
			},
			meta: {
				id: "active-1:2",
				protocol: DAEMON_PROTOCOL_INFO,
				activeSessionId: "active-1",
				sequence: 2,
				cursor: { generation: "generation-1", sequence: 2 },
				emittedAt: "2026-01-01T00:00:00.000Z",
			},
		});
		if (!deltaFrame) {
			throw new Error("Expected a compact delta frame");
		}
		const reconstructed = reconstructor.reconstruct(deltaFrame);
		expect(reconstructed).toMatchObject({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "message_update",
				message: { content: [{ type: "text", text: "hello" }] },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
			},
			meta: { cursor: { generation: "generation-1", sequence: 2 } },
		});
		expect((reconstructed as Extract<DaemonOutbound, { type: "session_event" }>).event).not.toHaveProperty(
			"assistantMessageEvent.partial",
		);
	});

	it("keeps delta payload size independent of the growing assistant message", () => {
		const text = "x".repeat(1024 * 1024);
		const partial = assistant([{ type: "text", text }]);
		const full: DaemonOutbound = {
			type: "session_event",
			activeSessionId: "active-large",
			event: {
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial },
			},
		};
		const compact = createCompactAssistantDelta(full);
		expect(compact).toBeDefined();
		expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(1024);
		expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(2 * 1024 * 1024);
	});

	it("does not duplicate text already present on a provider start event", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		reconstructor.observe({
			type: "session_event",
			activeSessionId: "active-start-text",
			event: { type: "message_start", message: assistant([]) },
		});
		const started = assistant([{ type: "text", text: "Hello" }]);
		const startFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-start-text",
			event: {
				type: "message_update",
				message: started,
				assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: started },
			},
		});
		const deltaFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-start-text",
			event: {
				type: "message_update",
				message: started,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: started },
			},
		});

		expect(reconstructor.reconstruct(startFrame!)).toMatchObject({
			event: { message: { content: [{ type: "text", text: "" }] } },
		});
		expect(reconstructor.reconstruct(deltaFrame!)).toMatchObject({
			event: { message: { content: [{ type: "text", text: "Hello" }] } },
		});
	});

	it("continues tool arguments after reconstructing from a snapshot", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		reconstructor.seed(
			"active-tool",
			assistant([{ type: "toolCall", id: "tool-1", name: "search", arguments: { query: "hel" } }]),
		);
		const updated = assistant([{ type: "toolCall", id: "tool-1", name: "search", arguments: { query: "hello" } }]);
		const delta = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-tool",
			event: {
				type: "message_update",
				message: updated,
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: 'lo"}',
					partial: updated,
				},
			},
		});

		expect(reconstructor.reconstruct(delta!)).toMatchObject({
			event: {
				message: {
					content: [{ type: "toolCall", id: "tool-1", name: "search", arguments: { query: "hello" } }],
				},
			},
		});
	});

	it("observe does not mutate the original message_start message", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		const original = assistant([{ type: "text", text: "" }]);
		reconstructor.observe({
			type: "session_event",
			activeSessionId: "active-clone",
			event: { type: "message_start", message: original },
		});

		const startFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-clone",
			event: {
				type: "message_update",
				message: assistant([{ type: "text", text: "" }]),
				assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: original },
			},
		});
		const deltaFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-clone",
			event: {
				type: "message_update",
				message: assistant([{ type: "text", text: "mutated" }]),
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "mutated", partial: original },
			},
		});

		reconstructor.reconstruct(startFrame!);
		reconstructor.reconstruct(deltaFrame!);

		// The original message_start message must not be mutated by reconstruct().
		expect(original.content[0]).toMatchObject({ type: "text", text: "" });
	});
});

const activeSessionId = "active-1";

function toolCallMessage(json: string): AssistantMessage {
	return assistant([{ type: "toolCall", id: "call-1", name: "bash", arguments: JSON.parse(json) }]);
}

function toolCallDeltaMessage(partialJson: string, delta: string): DaemonOutbound {
	// The worker-side message carries the *parsed* partial arguments snapshot.
	const partial = assistant([{ type: "toolCall", id: "call-1", name: "bash", arguments: tryParse(partialJson) }]);
	return {
		type: "session_event",
		activeSessionId,
		event: {
			type: "message_update",
			message: partial,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta,
				partial,
			},
		},
	};
}

function tryParse(json: string): Record<string, unknown> {
	try {
		return JSON.parse(json) as Record<string, unknown>;
	} catch {
		return {};
	}
}

describe("planCompactAssistantDelta", () => {
	const plan = (
		compactStream as unknown as {
			planCompactAssistantDelta?: (
				transport: string,
				role: string | undefined,
				capabilities: ReadonlySet<string>,
			) => { compact: boolean; toolCallArguments: "snapshot" | "fragments" } | undefined;
		}
	).planCompactAssistantDelta;

	it("exists and keeps the supervisor leg compact with snapshot arguments", () => {
		expect(typeof plan).toBe("function");
		expect(plan?.("private-framed", "supervisor", new Set())).toEqual({
			compact: true,
			toolCallArguments: "snapshot",
		});
	});

	it("keeps direct session clients on full jsonl unless they declare streaming_deltas", () => {
		expect(plan?.("private-framed", "session_client", new Set())).toEqual({
			compact: false,
			toolCallArguments: "snapshot",
		});
		expect(plan?.("private-framed", "session_client", new Set(["streaming_deltas"]))).toEqual({
			compact: true,
			toolCallArguments: "snapshot",
		});
	});

	it("only drops the arguments snapshot when the consumer declares streaming_delta_fragments", () => {
		expect(plan?.("private-framed", "supervisor", new Set(["streaming_delta_fragments"]))).toEqual({
			compact: true,
			toolCallArguments: "fragments",
		});
		expect(
			plan?.("private-framed", "session_client", new Set(["streaming_deltas", "streaming_delta_fragments"])),
		).toEqual({ compact: true, toolCallArguments: "fragments" });
	});

	it("never sends compact deltas on the plain jsonl transport", () => {
		expect(plan?.("jsonl", "supervisor", new Set(["streaming_deltas", "streaming_delta_fragments"]))).toEqual({
			compact: false,
			toolCallArguments: "snapshot",
		});
	});
});

describe("createCompactAssistantDelta toolCallArguments modes", () => {
	it("defaults to the parsed arguments snapshot (legacy wire behavior)", () => {
		const delta = createCompactAssistantDelta(toolCallDeltaMessage('{"command":"ls', '"command":"ls'));
		expect(delta?.assistantMessageEvent.type).toBe("toolcall_delta");
		expect(delta?.toolCallArguments).toEqual({});
	});

	it("omits toolCallArguments in fragments mode and keeps only the new fragment", () => {
		const delta = createCompactAssistantDelta(toolCallDeltaMessage('{"command":"ls', '"command":"ls'), {
			toolCallArguments: "fragments",
		});
		expect(delta?.assistantMessageEvent.type).toBe("toolcall_delta");
		expect(delta?.toolCallArguments).toBeUndefined();
		expect(delta?.assistantMessageEvent).toMatchObject({ type: "toolcall_delta", delta: '"command":"ls' });
	});
});

describe("isFragmentOnlyToolCallDelta", () => {
	it("flags exactly the fragment-mode tool-call deltas", () => {
		const helper = (
			compactStream as unknown as {
				isFragmentOnlyToolCallDelta?: (delta: CompactAssistantDelta) => boolean;
			}
		).isFragmentOnlyToolCallDelta;
		expect(typeof helper).toBe("function");
		const fragment = createCompactAssistantDelta(toolCallDeltaMessage('{"command":"ls', '"command":"ls'), {
			toolCallArguments: "fragments",
		});
		const snapshot = createCompactAssistantDelta(toolCallDeltaMessage('{"command":"ls', '"command":"ls'));
		expect(fragment && helper?.(fragment)).toBe(true);
		expect(snapshot && helper?.(snapshot)).toBe(false);
	});
});

describe("CompactAssistantStreamReconstructor fragment mode", () => {
	function seed(reconstructor: CompactAssistantStreamReconstructor): void {
		reconstructor.observe({
			type: "session_event",
			activeSessionId,
			event: { type: "message_start", message: assistant([]) },
		});
		const started = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId,
			event: {
				type: "message_update",
				message: toolCallMessage("{}"),
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 0,
					partial: toolCallMessage("{}"),
				},
			},
		});
		expect(started).toBeDefined();
		expect(reconstructor.reconstruct(started!)).toBeDefined();
	}

	it("rebuilds arguments from fragments and takes the authoritative toolcall_end", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		seed(reconstructor);
		const json = JSON.stringify({ command: "echo hello world", timeout: 30 });
		const pieces = json.match(/.{1,7}/g) ?? [];
		let accumulated = "";
		let lastUpdate: DaemonOutbound | undefined;
		for (const piece of pieces) {
			accumulated += piece;
			const delta = createCompactAssistantDelta(toolCallDeltaMessage(accumulated, piece), {
				toolCallArguments: "fragments",
			});
			expect(delta).toBeDefined();
			const reconstructed = reconstructor.reconstruct(delta!);
			expect(reconstructed).toBeDefined();
			lastUpdate = reconstructed;
		}
		const finalToolCall = toolCallMessage(json).content[0];
		if (finalToolCall?.type !== "toolCall") throw new Error("expected toolCall");
		const endDelta: CompactAssistantDelta = {
			type: "assistant_stream_delta",
			activeSessionId,
			assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: finalToolCall },
		};
		const ended = reconstructor.reconstruct(endDelta);
		if (ended?.type !== "session_event" || ended.event.type !== "message_update") {
			throw new Error("expected message_update");
		}
		const endedMessage = ended.event.message;
		if (endedMessage.role !== "assistant") throw new Error("expected assistant message");
		expect(endedMessage.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { command: "echo hello world", timeout: 30 },
		});
		void lastUpdate;
	});

	it("does not hand a fresh arguments object on every fragment (throttled parse)", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		seed(reconstructor);
		// 200 small fragments inside the throttle window: after the first parse,
		// the arguments object identity must stay stable (no per-delta reparse).
		const fragments = Array.from({ length: 200 }, () => `{"command":"${"x".repeat(7)}`.slice(0, 4));
		let accumulated = "";
		const identities: unknown[] = [];
		for (const piece of fragments) {
			accumulated += piece;
			const delta = createCompactAssistantDelta(toolCallDeltaMessage(accumulated, piece), {
				toolCallArguments: "fragments",
			});
			const reconstructed = reconstructor.reconstruct(delta!);
			const event = (reconstructed as Extract<DaemonOutbound, { type: "session_event" }>).event;
			if (event.type !== "message_update") throw new Error("expected message_update");
			const block = (event.message as AssistantMessage).content[0];
			if (block?.type !== "toolCall") throw new Error("expected toolCall");
			identities.push(block.arguments);
		}
		const distinct = new Set(identities);
		// An unthrottled per-delta parse produces one fresh object per delta.
		expect(distinct.size).toBeLessThan(identities.length / 2);
	});
});
