import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type TextContent,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, compactRlmText, type RlmChildAgentSnapshot, rlmChildLabel } from "../src/core/agent-session.js";
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
		options: { subagentRuntimeHost?: ConstructorParameters<typeof AgentSession>[0]["subagentRuntimeHost"] } = {},
	): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
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
	function timedHostedChild(streamFn: StreamFn): { session: AgentSession; parentListenerMs(): number } {
		const child = createSession(streamFn);
		const originalSubscribe = child.subscribe.bind(child);
		let listenerMs = 0;
		vi.spyOn(child, "subscribe").mockImplementation((listener) =>
			originalSubscribe((event) => {
				const started = performance.now();
				try {
					listener(event);
				} finally {
					listenerMs += performance.now() - started;
				}
			}),
		);
		return { session: child, parentListenerMs: () => listenerMs };
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
		// and re-stringified the whole snapshot; the parent-side listener work for the
		// same stream measured dozens of milliseconds on this machine. The fixed path
		// folds only the new text, so the same stream costs a fraction of that.
		expect(parentListenerMs).toBeLessThan(12);
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
});
