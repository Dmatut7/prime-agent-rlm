import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getModel, type Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { computeOwnAndTotalUsage, OwnUsageAccumulator } from "../src/core/context-tree.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function usage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: input + output },
	};
}

function assistantMessage(text: string, messageUsage: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: messageUsage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createAgentSession(sessionManager: SessionManager): AgentSession {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	return new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
		}),
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
}

describe("own usage incremental fold vs in-place attribution rewrites (K3X-3)", () => {
	let tempDir: string;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `own-usage-attribution-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		while (sessions.length > 0) {
			sessions.pop()?.dispose();
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("matches the full refold across a child attribution that rewrites the target in place", () => {
		const manager = SessionManager.create(tempDir);
		const targetId = manager.appendMessage(assistantMessage("parent turn", usage(100, 0)));

		const accumulator = new OwnUsageAccumulator();
		const before = accumulator.add(manager.getEntries());
		expect(before.ownUsage.input).toBe(100);
		expect(before.totalUsage.input).toBe(100);

		// appendChildUsageAttribution rewrites target.message.usage to the aggregate
		// in place before appending the attribution entry, so the target the fold
		// already counted silently changed under the cursor.
		manager.appendChildUsageAttribution(targetId, usage(900, 0), usage(1000, 0));

		const live = accumulator.add(manager.getEntries());
		const entries = manager.getEntries();
		const full = computeOwnAndTotalUsage(entries, entries);
		expect(live.ownUsage.input).toBe(full.ownUsage.input);
		expect(live.totalUsage.input).toBe(full.totalUsage.input);
		expect(live.ownUsage.input).toBe(100);
		expect(live.totalUsage.input).toBe(1000);
	});

	it("stays equal to the full refold across successive attributions to one target", () => {
		const manager = SessionManager.create(tempDir);
		const targetId = manager.appendMessage(assistantMessage("parent turn", usage(100, 0)));
		const accumulator = new OwnUsageAccumulator();
		accumulator.add(manager.getEntries());

		manager.appendChildUsageAttribution(targetId, usage(900, 0), usage(1000, 0));
		const first = accumulator.add(manager.getEntries());
		manager.appendChildUsageAttribution(targetId, usage(500, 0), usage(1500, 0));
		const live = accumulator.add(manager.getEntries());

		const entries = manager.getEntries();
		const full = computeOwnAndTotalUsage(entries, entries);
		expect(live.ownUsage.input).toBe(full.ownUsage.input);
		expect(live.totalUsage.input).toBe(full.totalUsage.input);
		expect(first.ownUsage.input).toBe(100);
		expect(live.ownUsage.input).toBe(100);
		expect(live.totalUsage.input).toBe(1500);
	});

	it("the live session summary equals the full-refold basis after an attribution", () => {
		const manager = SessionManager.create(tempDir);
		const session = createAgentSession(manager);
		sessions.push(session);

		const targetId = manager.appendMessage(assistantMessage("parent turn", usage(100, 0)));
		expect(session.getOwnUsageSummary()).toBeDefined();

		manager.appendChildUsageAttribution(targetId, usage(900, 0), usage(1000, 0));

		const entries = manager.getEntries();
		const full = computeOwnAndTotalUsage(entries, entries);
		const liveSummary = session.getOwnUsageSummary();
		expect(liveSummary?.inputTokens).toBe(full.ownUsage.input);
		expect(liveSummary?.inputTokens).toBe(100);
	});
});
