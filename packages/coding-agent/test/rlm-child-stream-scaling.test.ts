import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type TextContent,
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AgentSession,
	type AgentSessionEvent,
	compactRlmText,
	type RlmChildAgentSnapshot,
	rlmChildLabel,
} from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function usage(): Usage {
	return {
		input: 7,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 },
	};
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Streams one assistant answer in per-token chunks, exactly the shape a real
 * provider stream produces (faux.js pattern): message content accumulates in
 * place and every delta is forwarded as a message_update carrying the delta.
 * The deltas partition the final text, so the accumulated text always equals a
 * prefix of the final message.
 */
function echoTool(): AgentTool {
	return {
		name: "echo",
		label: "echo",
		description: "Echo test tool.",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "echo result" }], details: {} }),
	};
}

/**
 * Streams a run whose answer spans two assistant messages: the first carries a
 * short text plus a tool call, the tool executes, and the second message
 * streams the final answer. This is the shape any tool-using child produces
 * inside one run (and what an agent_message continuation round reuses the same
 * run for), so the run-level preview state sees message_start twice.
 */
function twoMessageAnswer(firstText: string, secondText: string, secondChunkSize: number): StreamFn {
	let call = 0;
	return () => {
		call += 1;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			if (call === 1) {
				const toolCall: ToolCall = { type: "toolCall", id: "call-echo-1", name: "echo", arguments: {} };
				const final: AssistantMessage = {
					...assistantMessage(firstText),
					content: [{ type: "text", text: firstText } satisfies TextContent, toolCall],
					stopReason: "toolUse",
				};
				const textBlock: TextContent = { type: "text", text: "" };
				const partial: AssistantMessage = { ...final, content: [textBlock, toolCall] };
				stream.push({ type: "start", partial: { ...partial } });
				stream.push({ type: "text_start", contentIndex: 0, partial: { ...partial } });
				textBlock.text = firstText;
				stream.push({ type: "text_delta", contentIndex: 0, delta: firstText, partial: { ...partial } });
				stream.push({ type: "text_end", contentIndex: 0, content: firstText, partial: { ...partial } });
				stream.push({ type: "done", reason: "toolUse", message: final });
				return;
			}
			const deltas: string[] = [];
			for (let offset = 0; offset < secondText.length; offset += secondChunkSize) {
				deltas.push(secondText.slice(offset, offset + secondChunkSize));
			}
			const message = assistantMessage(secondText);
			const textBlock: TextContent = { type: "text", text: "" };
			const partial: AssistantMessage = { ...message, content: [textBlock] };
			stream.push({ type: "start", partial: { ...partial } });
			stream.push({ type: "text_start", contentIndex: 0, partial: { ...partial } });
			for (const delta of deltas) {
				textBlock.text += delta;
				stream.push({ type: "text_delta", contentIndex: 0, delta, partial: { ...partial } });
			}
			stream.push({ type: "text_end", contentIndex: 0, content: secondText, partial: { ...partial } });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
}
function streamingAnswer(finalText: string, chunkSize: number): StreamFn {
	const deltas: string[] = [];
	for (let offset = 0; offset < finalText.length; offset += chunkSize) {
		deltas.push(finalText.slice(offset, offset + chunkSize));
	}
	return () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message = assistantMessage(finalText);
			const textBlock: TextContent = { type: "text", text: "" };
			const partial: AssistantMessage = { ...message, content: [textBlock] };
			stream.push({ type: "start", partial: { ...partial } });
			stream.push({ type: "text_start", contentIndex: 0, partial: { ...partial } });
			for (const delta of deltas) {
				textBlock.text += delta;
				stream.push({ type: "text_delta", contentIndex: 0, delta, partial: { ...partial } });
			}
			stream.push({ type: "text_end", contentIndex: 0, content: finalText, partial: { ...partial } });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
}

describe("RLM child streaming parent-side cost", () => {
	let tempDir: string;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `rlm-stream-scaling-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		while (sessions.length > 0) {
			sessions.pop()?.dispose();
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(
		streamFn: StreamFn,
		options: {
			subagentRuntimeHost?: ConstructorParameters<typeof AgentSession>[0]["subagentRuntimeHost"];
			tools?: AgentTool[];
		} = {},
	): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: "", tools: options.tools ?? [], thinkingLevel: "off" },
				streamFn,
			}),
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
			subagentRuntimeHost: options.subagentRuntimeHost,
		});
		sessions.push(session);
		return session;
	}

	/**
	 * Times the parent-side per-event listener work by wrapping the hosted child's
	 * public subscribe(): the parent's streaming handler is one of its listeners and
	 * runs synchronously inside the child's event emission, so the accumulated
	 * listener wall time is the parent-side CPU the roster updates pay per chunk.
	 */
	function timedHostedChild(
		streamFn: StreamFn,
		perEvent?: (event: AgentSessionEvent) => void,
	): { session: AgentSession; parentListenerMs(): number } {
		const child = createSession(streamFn);
		const originalSubscribe = child.subscribe.bind(child);
		let listenerMs = 0;
		vi.spyOn(child, "subscribe").mockImplementation((listener) =>
			originalSubscribe((event) => {
				const started = performance.now();
				try {
					perEvent?.(event);
					listener(event);
				} finally {
					listenerMs += performance.now() - started;
				}
			}),
		);
		return { session: child, parentListenerMs: () => listenerMs };
	}

	/**
	 * The pre-fix per-chunk work, replicated for calibration: re-derive the preview
	 * from the whole accumulated text, re-derive the label over the 5k-char task
	 * brief, and re-stringify the whole snapshot, once per chunk.
	 */
	function preFixPerChunkWork(prompt: string): (text: string) => void {
		return (text: string) => {
			const preview = compactRlmText(text);
			const label = rlmChildLabel(prompt);
			JSON.stringify({ preview, label, status: "writing" });
		};
	}

	/** Times the pre-fix re-derive over the same growing prefixes the stream produces. */
	function timePreFixWork(prompt: string, finalText: string, chunkCount: number): number {
		const preFixPerChunk = preFixPerChunkWork(prompt);
		const chunkSize = Math.ceil(finalText.length / chunkCount);
		const start = performance.now();
		for (let offset = chunkSize; offset <= finalText.length; offset += chunkSize) {
			preFixPerChunk(finalText.slice(0, offset));
		}
		return performance.now() - start;
	}

	it("does not re-derive the preview, label and snapshot from the full text per chunk", async () => {
		const chunkText = "detail line about the quarterly numbers. ";
		const chunkCount = 400;
		const finalText = `quarterly summary: ${chunkText.repeat(chunkCount)}`;
		const prompt = `Analyze the following report and produce a long answer: ${chunkText.repeat(120)}`;
		// ~430 chunks of 40 chars: the answer grows past 17k characters.
		const hosted = timedHostedChild(streamingAnswer(finalText, Math.ceil(finalText.length / chunkCount)));
		const root = createSession(streamingAnswer("", 1), {
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hosted.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		const updates: RlmChildAgentSnapshot[] = [];
		let resolveDone: (() => void) | undefined;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		root.subscribe((event) => {
			if (event.type === "rlm_child_update") {
				updates.push(event.child);
				if (event.child.status === "done" && resolveDone) resolveDone();
			}
		});

		await root.runRlmChild(prompt);
		await done;
		const parentListenerMs = hosted.parentListenerMs();

		// Positive controls: the update channel keeps its semantics.
		expect(updates.length).toBeGreaterThan(0);
		const finalUpdate = updates.at(-1);
		expect(finalUpdate?.status).toBe("done");
		expect(finalUpdate?.answerPreview).toBe(compactRlmText(finalText));
		expect(finalUpdate?.label).toBe(rlmChildLabel(prompt));
		// Writing was reported while the child streamed (the dedup must not swallow
		// the activity transitions), and the label is constant across every update.
		expect(updates.some((update) => update.activity?.kind === "writing")).toBe(true);
		expect(updates.every((update) => update.label === finalUpdate?.label)).toBe(true);

		// Before the incremental preview/label/snapshot work, each of the ~430 chunks
		// re-joined the accumulated text, re-regexed it and the 5k-char task brief,
		// and re-stringified the whole snapshot, so the parent-side listener work
		// cost dozens of milliseconds. The fixed path folds only the new text, so
		// the same stream costs a fraction of that. Relative bound, both sides
		// measured in the same run: the replicated pre-fix work must cost at least
		// 3x the live listener work. A regressed implementation pays the re-derive
		// inside the listener itself, collapsing the ratio toward 1, while runner
		// load stretches both sides together - so the ratio discriminates where an
		// absolute ms ceiling flakes in both directions (too slow a runner, or a
		// control that no longer clears a fixed floor on a fast one).
		const preFixMs = timePreFixWork(prompt, finalText, chunkCount);
		expect(preFixMs).toBeGreaterThanOrEqual(parentListenerMs * 3);
	});

	it("the relative bound still catches the pre-fix re-derive paid inside the listener", async () => {
		// Bound control: the ratio above only discriminates if the work it forbids,
		// paid where the pre-fix implementation paid it (inside the parent's
		// listener, on every chunk), collapses it. Drive a hosted child whose
		// stream runs the same per-chunk re-derive through the listener path and
		// assert the listener cost itself rises above a third of the replicated
		// re-derive - i.e. the 3x ratio the main test requires is impossible in the
		// pre-fix world. A red control means the bound lost its discriminative
		// power, not that the implementation regressed.
		const chunkText = "detail line about the quarterly numbers. ";
		const chunkCount = 400;
		const finalText = `quarterly summary: ${chunkText.repeat(chunkCount)}`;
		const prompt = `Analyze the following report and produce a long answer: ${chunkText.repeat(120)}`;
		const chunkSize = Math.ceil(finalText.length / chunkCount);
		const preFixPerChunk = preFixPerChunkWork(prompt);
		let accumulatedText = "";
		const hosted = timedHostedChild(streamingAnswer(finalText, chunkSize), (event) => {
			if (event.type !== "message_update" || event.message.role !== "assistant") return;
			for (const block of event.message.content) {
				if (block.type === "text") accumulatedText = block.text;
			}
			preFixPerChunk(accumulatedText);
		});
		const root = createSession(streamingAnswer("", 1), {
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hosted.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		let resolveDone: (() => void) | undefined;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		root.subscribe((event) => {
			if (event.type === "rlm_child_update" && event.child.status === "done" && resolveDone) resolveDone();
		});
		await root.runRlmChild(prompt);
		await done;
		const injectedListenerMs = hosted.parentListenerMs();
		const preFixMs = timePreFixWork(prompt, finalText, chunkCount);
		expect(injectedListenerMs).toBeGreaterThan(preFixMs / 3);
	});

	it("emits correct previews while the answer is still short", async () => {
		// The incremental compactor must stay exact below the cap, where the preview
		// is the whole collapsed text and changes on every chunk.
		const chunkText = "word ";
		const chunkCount = 8;
		const finalText = `short answer: ${chunkText.repeat(chunkCount)}`;
		// Eleven small chunks so the preview crosses whole words while growing.
		const root = createSession(streamingAnswer(finalText, 5));
		const previews: (string | undefined)[] = [];
		let resolveDone: (() => void) | undefined;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		root.subscribe((event) => {
			if (event.type === "rlm_child_update") {
				previews.push(event.child.answerPreview);
				if (event.child.status === "done" && resolveDone) resolveDone();
			}
		});

		await root.runRlmChild("count words");
		await done;

		expect(previews.at(-1)).toBe(compactRlmText(finalText));
		// Every preview the parent ever published was a prefix-consistent compaction
		// of the final text (whitespace collapsed, same order).
		const collapsed = finalText.replace(/\s+/g, " ").trim();
		expect(previews.length).toBeGreaterThan(0);
		for (const preview of previews) {
			if (preview === undefined) continue;
			expect(collapsed.startsWith(preview.replace(/\s+/g, " ").trim())).toBe(true);
		}
	});

	it("resets the streaming preview when a second assistant message starts in the same run", async () => {
		// The preview accumulator is per assistant message. A run folds several
		// assistant messages (tool-call rounds, agent_message continuation rounds);
		// reading the previous message's folded lengths as the new message's
		// consumed prefix glued the old answer onto a mid-word slice of the new one.
		const firstText = "Done.";
		const secondText = "Now here is the real second answer that keeps streaming for a while.";
		const child = createSession(twoMessageAnswer(firstText, secondText, 12), { tools: [echoTool()] });
		const root = createSession(streamingAnswer("", 1), {
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		const previews: (string | undefined)[] = [];
		let resolveDone: (() => void) | undefined;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		root.subscribe((event) => {
			if (event.type === "rlm_child_update") {
				previews.push(event.child.answerPreview);
				if (event.child.status === "done" && resolveDone) resolveDone();
			}
		});

		await root.runRlmChild("do the thing, then answer");
		await done;

		// The message_end recompute keeps the final preview exact in both worlds;
		// the streaming-window previews are the contract under test.
		expect(previews.at(-1)).toBe(compactRlmText(secondText));
		const firstPreview = compactRlmText(firstText);
		const secondCollapsed = secondText.replace(/\s+/g, " ").trim();
		const secondWindowPreviews = previews.filter(
			(preview): preview is string => preview !== undefined && preview !== firstPreview,
		);
		expect(secondWindowPreviews.length).toBeGreaterThan(0);
		for (const preview of secondWindowPreviews) {
			// Every preview the parent published during the second message must be a
			// prefix-consistent compaction of the second message's text - never the
			// first message's answer glued to a mid-word slice ("Done.ere is...").
			expect(secondCollapsed.startsWith(preview.replace(/\s+/g, " ").trim())).toBe(true);
		}
	});

	it("recovers the preview when a capped first message is followed by a longer second message", async () => {
		// Once the first message's window crossed the cap, a second message whose
		// first delta is at least as long as the folded text was misread as the same
		// message still growing, freezing the preview at the first message's cap.
		const firstText = "a".repeat(900);
		const secondText = `${"B".repeat(1_000)} then the tail of the second answer.`;
		const child = createSession(twoMessageAnswer(firstText, secondText, 1_200), { tools: [echoTool()] });
		const root = createSession(streamingAnswer("", 1), {
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		// Close the collection window at the second assistant message's message_end:
		// that handler recomputes the full text and is exact in both worlds, so only
		// the streaming-window previews are the contract under test here.
		let assistantEnds = 0;
		let streamingWindowClosed = false;
		child.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				assistantEnds += 1;
				if (assistantEnds >= 2) streamingWindowClosed = true;
			}
		});
		const previews: (string | undefined)[] = [];
		let resolveDone: (() => void) | undefined;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		root.subscribe((event) => {
			if (event.type === "rlm_child_update") {
				if (!streamingWindowClosed) previews.push(event.child.answerPreview);
				if (event.child.status === "done" && resolveDone) resolveDone();
			}
		});

		await root.runRlmChild("do the thing, then answer at length");
		await done;

		expect(streamingWindowClosed).toBe(true);
		expect(previews.length).toBeGreaterThan(0);
		// While the second message streamed, the published preview had to move past
		// the first message's capped window; a frozen "aaa..." preview never does.
		expect(previews.some((preview) => preview !== undefined && preview.includes("B"))).toBe(true);
	});
});
