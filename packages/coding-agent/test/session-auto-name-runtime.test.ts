import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, getModel, type Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

/**
 * Runtime red lines for auto session naming (the persist-hot-path hook):
 * the first reply names the thread with provenance, human names are sacred,
 * the setting can switch it off, and a low-information opener waits for a
 * substantive message instead of pinning a useless name.
 */

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function usage(input = 7, output = 3): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
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

function singleAnswerStream(): StreamFn {
	return (_streamModel, _context) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: assistantMessage("收到，正在处理") });
		});
		return stream;
	};
}

describe("AgentSession auto session naming", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-autoname-runtime-"));
		mkdirSync(join(tempDir, "sessions"), { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function createSession(settingsJson?: Record<string, unknown>): AgentSession {
		if (settingsJson) {
			writeFileSync(join(tempDir, "settings.json"), JSON.stringify(settingsJson));
		}
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn: singleAnswerStream(),
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader({}),
			customTools: [],
		});
		return session;
	}

	async function promptOnce(target: AgentSession, text: string): Promise<void> {
		await target.prompt(text);
		await target.waitForSessionInputIdle();
	}

	it("names the thread from the first inbound once the first reply lands", async () => {
		const target = createSession();
		await promptOnce(target, "查最近的记忆线程，有几个我叫ai做并且规划");
		expect(target.sessionManager.getSessionNameInfo()).toEqual({
			name: "查最近的记忆线程，有几个我叫ai做并且规划",
			auto: true,
		});
	});

	it("never overwrites a human name", async () => {
		const target = createSession();
		target.setSessionName("人工名");
		await promptOnce(target, "查最近的记忆线程");
		expect(target.sessionManager.getSessionNameInfo()).toEqual({ name: "人工名", auto: false });
		const infos = target.sessionManager.getEntries().filter((entry) => entry.type === "session_info");
		expect(infos).toHaveLength(1);
	});

	it("stays unnamed when autoSessionName is off", async () => {
		const target = createSession({ autoSessionName: "off" });
		await promptOnce(target, "查最近的记忆线程");
		expect(target.sessionManager.getSessionNameInfo()).toBeUndefined();
	});

	it("skips a low-information opener and names from the first substantive message", async () => {
		const target = createSession();
		await promptOnce(target, "继续");
		expect(target.sessionManager.getSessionNameInfo()).toBeUndefined();
		await promptOnce(target, "修复水务公告越权读取");
		expect(target.sessionManager.getSessionNameInfo()).toEqual({ name: "修复水务公告越权读取", auto: true });
	});

	it("default mode keeps exactly one settled name after the turn (no refinement write)", async () => {
		const target = createSession();
		await promptOnce(target, "同步plantree和最近的记忆");
		await new Promise((resolve) => setTimeout(resolve, 500));
		const infos = target.sessionManager.getEntries().filter((entry) => entry.type === "session_info");
		expect(infos).toHaveLength(1);
		expect(target.sessionManager.getSessionNameInfo()).toEqual({ name: "同步plantree和最近的记忆", auto: true });
	});
});
