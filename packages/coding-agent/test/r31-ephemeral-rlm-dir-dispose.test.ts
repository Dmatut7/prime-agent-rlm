import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

describe("r31 RC-6 ephemeral rlm session directory cleanup", () => {
	let tempDir: string;
	let root: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-r31-rlm-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		root?.dispose();
		root = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("removes the prime-agent-rlm-* temp directory when the session is disposed", async () => {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		// An in-memory session manager has no artifact dir, so spawning a child
		// falls back to the ephemeral mkdtemp under tmpdir().
		const streamFn: StreamFn = (_model, context) => {
			const last = context.messages[context.messages.length - 1];
			const text = typeof last?.content === "string" ? last.content : "child done";
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				});
			});
			return stream;
		};
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn,
		});
		root = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
		});

		const run = await root.runRlmChild("ephemeral child", { name: "ephemeral-worker" });
		const childSessionDir = run.session_dir;
		expect(childSessionDir).toContain("prime-agent-rlm-");
		const ephemeralRoot = dirname(childSessionDir);
		expect(existsSync(ephemeralRoot)).toBe(true);

		root.dispose();
		root = undefined;
		expect(existsSync(ephemeralRoot)).toBe(false);
	}, 30_000);
});
