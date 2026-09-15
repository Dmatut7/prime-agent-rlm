import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getModel, type Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
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

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function transcriptFile(dir: string, name: string, messageCount: number): string {
	const lines: string[] = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: `scaling-${name}`,
			timestamp: "2026-01-01T00:00:00Z",
			cwd: dir,
		}),
	];
	for (let index = 0; index < messageCount; index++) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `e${index + 1}`,
				parentId: index === 0 ? null : `e${index}`,
				timestamp: "2026-01-01T00:00:00Z",
				message:
					index % 2 === 0
						? userMessage(`turn ${index}`)
						: assistantMessage(`answer ${index}`, usage(10 + index, 2)),
			}),
		);
	}
	const path = join(dir, `${name}.jsonl`);
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
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

function medianHitCheckMs(session: AgentSession, reps: number): number {
	// Warm once so the fold runs and the memo is populated; then measure the
	// republished-usage path the roster drives on every event flush.
	session.getOwnUsageSummary();
	const times: number[] = [];
	for (let index = 0; index < reps; index++) {
		const start = performance.now();
		session.getOwnUsageSummary();
		times.push(performance.now() - start);
	}
	times.sort((a, b) => a - b);
	return times[Math.floor(times.length / 2)]!;
}

describe("own-usage memo hit check stays O(1) in the transcript size", () => {
	let tempDir: string;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `own-usage-scaling-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		while (sessions.length > 0) {
			sessions.pop()?.dispose();
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not grow with the transcript between 1k/20k/100k entries", () => {
		const sizes = [1000, 20000, 100000];
		const medians: number[] = [];
		for (const size of sizes) {
			const manager = SessionManager.open(transcriptFile(tempDir, `n${size}`, size));
			const session = createAgentSession(manager);
			sessions.push(session);
			medians.push(medianHitCheckMs(session, 51));
		}

		// Positive control: the summary is defined and identical on repeated reads.
		const manager = SessionManager.open(transcriptFile(tempDir, "control", 4));
		const session = createAgentSession(manager);
		sessions.push(session);
		const first = session.getOwnUsageSummary();
		expect(first).toBeDefined();
		expect(session.getOwnUsageSummary()).toEqual(first);
		// And a new entry invalidates the memo instead of losing the hit forever.
		manager.appendMessage(assistantMessage("after", usage(999, 9)));
		const updated = session.getOwnUsageSummary();
		expect(updated).toBeDefined();
		expect(updated?.inputTokens).toBeGreaterThan(first?.inputTokens ?? 0);

		// The hit check must not scale with the transcript: the 100k median stays
		// far under the ~2.2ms the O(n) array copy cost, and under a small multiple
		// of the 1k median (linear growth would be ~100x between them).
		expect(medians[2]!).toBeLessThan(0.4);
		expect(medians[2]!).toBeLessThan(medians[0]! * 10 + 0.05);
	});
});
