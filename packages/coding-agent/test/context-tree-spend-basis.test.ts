import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getModel, type Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { loadContextTreeChildFromDisk } from "../src/core/context-tree.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { readSessionInfo, SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

/** 10 (a1) + 20 (a2) + 0.05 (c1) + 0.03 (s1) + 50 (a3) once the rollback has happened. */
const OWN_COST = 80.08;
const OWN_INPUT = 6160;
const OWN_OUTPUT = 628;

function usage(input: number, output: number, cost: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
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

function createAgentSession(sessionManager: SessionManager): AgentSession {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
	session.agent.state.messages = sessionManager.buildSessionContext().messages;
	return session;
}

/**
 * Append a transcript that rolled back, so the file holds paid work the active
 * branch no longer reaches: an assistant turn, an assistant turn plus its
 * compaction, and the branch summary written when the branch was left. Only the
 * last turn is on the active branch.
 */
function appendRolledBackTranscript(sessionManager: SessionManager): void {
	const firstTurn = sessionManager.appendMessage(userMessage("turn 1"));
	sessionManager.appendMessage(assistantMessage("answer 1", usage(1000, 100, 10)));
	sessionManager.appendMessage(userMessage("turn 2"));
	const abandonedTail = sessionManager.appendMessage(assistantMessage("answer 2", usage(2000, 200, 20)));
	sessionManager.appendCompaction(
		"abandoned compaction summary",
		abandonedTail,
		5000,
		undefined,
		undefined,
		undefined,
		{ usage: usage(100, 20, 0.05) },
	);
	sessionManager.branchWithSummary(firstTurn, "left the abandoned tail", undefined, false, usage(60, 8, 0.03));
	sessionManager.branch(firstTurn);
	sessionManager.appendMessage(assistantMessage("answer 3 on the new branch", usage(3000, 300, 50)));
}

/** The same transcript as JSONL, with ids and parentIds written by hand. */
function rolledBackTranscriptLines(sessionId: string, cwd: string): string[] {
	const message = (id: string, parentId: string | null, role: string, messageUsage?: Usage) =>
		JSON.stringify({
			type: "message",
			id,
			parentId,
			timestamp: "2026-01-01T00:00:0" + id.slice(-1) + "Z",
			message: { role, content: "x", timestamp: 1, usage: messageUsage },
		});
	return [
		JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00Z", cwd }),
		message("u1", null, "user"),
		message("a1", "u1", "assistant", usage(1000, 100, 10)),
		message("u2", "a1", "user"),
		message("a2", "u2", "assistant", usage(2000, 200, 20)),
		JSON.stringify({
			type: "compaction",
			id: "c1",
			parentId: "a2",
			timestamp: "2026-01-01T00:00:00Z",
			summary: "abandoned compaction summary",
			firstKeptEntryId: "a2",
			tokensBefore: 5000,
			usage: usage(100, 20, 0.05),
		}),
		JSON.stringify({
			type: "branch_summary",
			id: "s1",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:00Z",
			fromId: "u1",
			summary: "left the abandoned tail",
			usage: usage(60, 8, 0.03),
		}),
		message("a3", "u1", "assistant", usage(3000, 300, 50)),
	];
}

describe("session spend has one basis", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-spend-basis-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("/context, getSessionStats and the roster summary agree after a rollback", async () => {
		const sessionManager = SessionManager.create(process.cwd(), tempDir);
		appendRolledBackTranscript(sessionManager);
		const session = createAgentSession(sessionManager);

		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile, "the scenario must persist for the catalog scan below").toBeDefined();
		// Sanity: the rollback really did move three paid entries off the branch.
		expect(sessionManager.getBranch().length).toBe(2);

		const tree = session.getContextTree();
		const stats = session.getSessionStats();
		const roster = session.getOwnUsageSummary();
		const catalog = (await readSessionInfo(sessionFile!))?.usage;

		expect(tree.ownUsage.cost.total).toBeCloseTo(OWN_COST);
		expect(tree.totalUsage.cost.total).toBeCloseTo(OWN_COST);
		expect(stats.cost).toBeCloseTo(OWN_COST);
		expect(roster?.cost).toBeCloseTo(OWN_COST);
		expect(catalog?.cost).toBeCloseTo(OWN_COST);

		expect(tree.ownUsage.input).toBe(OWN_INPUT);
		expect(tree.ownUsage.output).toBe(OWN_OUTPUT);
		expect(stats.tokens.input).toBe(OWN_INPUT);
		expect(stats.tokens.total).toBe(OWN_INPUT + OWN_OUTPUT);
		expect(roster?.inputTokens).toBe(OWN_INPUT);
		expect(catalog?.inputTokens).toBe(OWN_INPUT);
	});

	it("the abandoned branch's assistants, compaction and branch summary stay in the totals", async () => {
		const sessionManager = SessionManager.create(process.cwd(), tempDir);
		appendRolledBackTranscript(sessionManager);
		const session = createAgentSession(sessionManager);

		const tree = session.getContextTree();
		// 10 + 20 + 0.05 + 0.03 was paid on the abandoned branch; only the 50 of the
		// branch the session sits on is reachable from the leaf.
		expect(tree.ownUsage.cost.total - 50).toBeCloseTo(30.08);
		expect(session.getSessionStats().cost).toBeCloseTo(80.08);
	});

	it("a completed child node reports the same spend as its session file", async () => {
		const childDir = join(tempDir, "sub-abcd0001");
		mkdirSync(childDir, { recursive: true });
		const sessionId = "01a0c0de0000700080009000a000b0c0";
		const childFile = join(childDir, `${sessionId}.jsonl`);
		writeFileSync(childFile, `${rolledBackTranscriptLines(sessionId, tempDir).join("\n")}\n`);

		const node = loadContextTreeChildFromDisk(childDir, () => model.contextWindow);
		const catalog = (await readSessionInfo(childFile))?.usage;

		expect(node, "the child directory must hold the transcript just written").toBeDefined();
		expect(node!.ownUsage.cost.total).toBeCloseTo(OWN_COST);
		expect(catalog?.cost).toBeCloseTo(OWN_COST);
		expect(node!.ownUsage.input).toBe(catalog?.inputTokens);
		expect(node!.ownUsage.output).toBe(catalog?.outputTokens);
	});
});
