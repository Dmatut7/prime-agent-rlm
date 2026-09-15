import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function transcriptLines(entryCount: number, sessionInfoNames: string[] = []): string[] {
	const lines: string[] = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "session-under-test",
			timestamp: "2026-01-01T00:00:00Z",
			cwd: "/tmp/project",
		}),
	];
	const infoAt = new Set(
		sessionInfoNames.map((_, index) => Math.floor((entryCount / (sessionInfoNames.length + 1)) * (index + 1))),
	);
	let emittedInfo = 0;
	for (let index = 0; index < entryCount; index++) {
		if (infoAt.has(index) && emittedInfo < sessionInfoNames.length) {
			lines.push(
				JSON.stringify({
					type: "session_info",
					id: `info-${emittedInfo}`,
					parentId: null,
					name: sessionInfoNames[emittedInfo],
				}),
			);
			emittedInfo += 1;
		}
		lines.push(
			JSON.stringify({
				type: "message",
				id: `e${index}`,
				parentId: index === 0 ? null : `e${index - 1}`,
				message: index % 2 === 0 ? userMessage(`turn ${index}`) : assistantMessage(`answer ${index}`),
			}),
		);
	}
	return lines;
}

function transcriptFile(dir: string, name: string, entryCount: number, sessionInfoNames: string[] = []): string {
	const path = join(dir, `${name}.jsonl`);
	writeFileSync(path, `${transcriptLines(entryCount, sessionInfoNames).join("\n")}\n`);
	return path;
}

/** The pre-cache implementation: reverse scan over getEntries(), last session_info wins. */
function fullReverseScan(manager: SessionManager): string | undefined {
	const entries = manager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "session_info") {
			return entry.name?.trim() || undefined;
		}
	}
	return undefined;
}

function createAgentSession(manager: SessionManager): AgentSession {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	return new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
		}),
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory(),
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
}

describe("SessionManager sessionName read cache", () => {
	let tempDir: string;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-name-cache-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		while (sessions.length > 0) {
			sessions.pop()?.dispose();
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("repeated reads of an unnamed transcript do not rescan the transcript", () => {
		// A transcript without session_info entries never early-exits the reverse
		// scan: every read filters and scans all entries. The roster flush pays this
		// per dirty-row rebuild, so a 20k-entry window reads it thousands of times.
		const manager = SessionManager.open(transcriptFile(tempDir, "unnamed", 20_000));
		const getEntries = vi.spyOn(manager, "getEntries");

		for (let index = 0; index < 100; index++) {
			manager.getSessionName();
		}

		// One scan may prime the cache; a hundred reads must not be a hundred
		// O(entries) filter+scans.
		expect(getEntries.mock.calls.length).toBeLessThanOrEqual(1);
	});

	it("the roster's sessionName getter path stays off the transcript after the first read", () => {
		const manager = SessionManager.open(transcriptFile(tempDir, "getter", 20_000));
		const session = createAgentSession(manager);
		sessions.push(session);
		const getEntries = vi.spyOn(manager, "getEntries");

		expect(session.sessionName).toBeUndefined();
		for (let index = 0; index < 100; index++) {
			void session.sessionName;
		}

		expect(getEntries.mock.calls.length).toBeLessThanOrEqual(1);
	});

	it("appendSessionInfo invalidates the cache so renames are visible", () => {
		const manager = SessionManager.open(transcriptFile(tempDir, "renames", 3));

		expect(manager.getSessionName()).toBeUndefined();
		manager.appendSessionInfo("first name");
		expect(manager.getSessionName()).toBe("first name");
		// A second write must invalidate again: the cache cannot pin the stale name.
		manager.appendSessionInfo("renamed");
		expect(manager.getSessionName()).toBe("renamed");
		// Unrelated appends must not lose the name.
		manager.appendMessage(userMessage("unrelated"));
		expect(manager.getSessionName()).toBe("renamed");
		// Blank names read back as undefined, exactly like the reverse scan.
		manager.appendSessionInfo("   ");
		expect(manager.getSessionName()).toBeUndefined();
		expect(manager.getEntries().at(-1)?.type).toBe("session_info");
	});

	it("matches the full reverse scan across name placements", () => {
		const cases: Array<{ name: string; names: string[]; expected: string | undefined }> = [
			{ name: "no-name", names: [], expected: undefined },
			{ name: "one-mid", names: ["alpha"], expected: "alpha" },
			{ name: "two-last-wins", names: ["alpha", "beta"], expected: "beta" },
			{ name: "padded-name", names: ["  gamma  "], expected: "gamma" },
		];
		expect(cases.length).toBeGreaterThan(0);
		for (const { name, names, expected } of cases) {
			const manager = SessionManager.open(transcriptFile(tempDir, name, 2_000, names));
			expect(manager.getSessionName()).toBe(expected);
			// Positive control: the cache agrees with a real full scan of the same file.
			expect(manager.getSessionName()).toBe(fullReverseScan(manager));
			// And a fresh open of the same bytes (no cache carryover) agrees too.
			const reopened = SessionManager.open(manager.getSessionFile() ?? "");
			expect(reopened.getSessionName()).toBe(expected);
			expect(reopened.getSessionName()).toBe(fullReverseScan(reopened));
		}
	});
});
