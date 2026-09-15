/**
 * The `/context` scan budget decides *which* children a truncated roster keeps,
 * and the roster has to say that it was truncated.
 *
 * Both halves regressed together in the bounded-scan change (d38613676): child
 * dirs were listed oldest-first, so the 256-child cap on the measured 544-child
 * directory kept the *oldest* 256 and silently dropped every recent agent, and
 * the structured diagnostics that describe the cut stopped at the scan function -
 * the production caller (`AgentSession.getContextTree`) returned `.nodes` only, so
 * `/context` showed a partial roster that read as complete. These tests pin the
 * two fixes: newest-first eviction, and diagnostics that reach the renderer.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getModel, type Usage } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { DEFAULT_CONTEXT_TREE_SCAN_BUDGET, scanContextTreeChildrenFromDisk } from "../src/core/context-tree.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { formatContextTree } from "../src/modes/interactive/components/context-tree-format.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;
const resolveContextWindow = () => 200000;
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** The directory count the original `/context` measurement found in the wild. */
const MEASURED_CHILDREN = 544;

function usage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: input * 1e-6, output: 0, cacheRead: 0, cacheWrite: 0, total: input * 1e-6 },
	};
}

const assistantMessage = (): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "done" }],
	api: "anthropic-messages",
	provider: model.provider,
	model: model.id,
	usage: usage(1000, 100),
	stopReason: "stop",
	timestamp: Date.now(),
});

let tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "context-tree-newest-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

/**
 * One persisted child session, with its dir mtime pinned.
 *
 * The mtime is the recency signal the roster orders by, so a fixture that lets
 * the filesystem choose it makes "which side got dropped" undecidable.
 */
function writeChild(rlmDir: string, index: number, mtimeMs: number): string {
	const name = `sub-${String(index).padStart(4, "0")}`;
	const dir = join(rlmDir, name);
	mkdirSync(dir, { recursive: true });
	const lines = [
		{ type: "session", version: 3, id: `s${index}`, timestamp: TIMESTAMP, cwd: process.cwd() },
		{
			type: "model_change",
			id: "m1",
			parentId: null,
			timestamp: TIMESTAMP,
			provider: model.provider,
			modelId: model.id,
		},
		{
			type: "message",
			id: "u1",
			parentId: "m1",
			timestamp: TIMESTAMP,
			message: { role: "user", content: `task ${index}`, timestamp: Date.now() },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: TIMESTAMP,
			message: assistantMessage(),
		},
	];
	writeFileSync(join(dir, `s${index}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	const when = new Date(mtimeMs);
	utimesSync(dir, when, when);
	return name;
}

/** `count` siblings whose mtimes ascend with their index: the last one is the newest. */
function writeRoster(rlmDir: string, count: number): string[] {
	const names: string[] = [];
	for (let index = 0; index < count; index++) {
		names.push(writeChild(rlmDir, index, 1_700_000_000_000 + index * 1000));
	}
	return names;
}

beforeAll(() => {
	initTheme("dark");
});

describe("a capped scan keeps the newest branches", () => {
	it("orders child dirs newest-first so the budget drops the oldest", () => {
		const rlmDir = makeTempDir();
		writeRoster(rlmDir, 30);

		const result = scanContextTreeChildrenFromDisk(rlmDir, resolveContextWindow, {
			budget: { maxChildren: 8 },
		});
		expect(result.nodes.map((node) => node.id)).toEqual([
			"sub-0029",
			"sub-0028",
			"sub-0027",
			"sub-0026",
			"sub-0025",
			"sub-0024",
			"sub-0023",
			"sub-0022",
		]);
		expect(result.diagnostics).toEqual(
			expect.objectContaining({ skippedByBudget: 22, truncated: true, truncatedReason: "children" }),
		);
	});

	it("shows the most recent agents on the 544-child directory the cap was measured on", () => {
		const rlmDir = makeTempDir();
		const names = writeRoster(rlmDir, MEASURED_CHILDREN);
		const newest = names.at(-1)!;
		const oldest = names[0];

		const result = scanContextTreeChildrenFromDisk(rlmDir, resolveContextWindow);
		const ids = new Set(result.nodes.map((node) => node.id));

		// The newest branch survives the default budget...
		expect(ids.has(newest)).toBe(true);
		expect(result.nodes[0].id).toBe(newest);
		// ...and the oldest is what the budget gave up.
		expect(ids.has(oldest)).toBe(false);
		expect(result.nodes).toHaveLength(DEFAULT_CONTEXT_TREE_SCAN_BUDGET.maxChildren);
		expect(ids.size).toBe(DEFAULT_CONTEXT_TREE_SCAN_BUDGET.maxChildren);
		// Exactly the most recently active slice of the roster.
		expect(ids).toEqual(new Set(names.slice(-DEFAULT_CONTEXT_TREE_SCAN_BUDGET.maxChildren)));
		expect(result.diagnostics).toEqual(
			expect.objectContaining({
				scannedChildren: DEFAULT_CONTEXT_TREE_SCAN_BUDGET.maxChildren,
				skippedByBudget: MEASURED_CHILDREN - DEFAULT_CONTEXT_TREE_SCAN_BUDGET.maxChildren,
				truncated: true,
				truncatedReason: "children",
			}),
		);
	});
});

describe("the truncation reaches the user", () => {
	/**
	 * A session backed by a real file inside `dir`.
	 *
	 * The transcript lives one level down because session artifacts are rooted at
	 * `dirname(sessionDir)/session-artifacts`: nesting keeps the RLM dir this test
	 * writes its children into inside the temp dir the test cleans up, and a fresh
	 * session id keeps two tests from sharing one artifact dir.
	 */
	function createFileBackedSession(dir: string): { session: AgentSession; rlmDir: string } {
		const sessionDir = join(dir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const sessionId = randomUUID();
		const sessionFile = join(sessionDir, "main.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: TIMESTAMP,
				cwd: sessionDir,
			})}\n`,
		);
		const sessionManager = SessionManager.open(sessionFile, sessionDir);
		const rlmDir = sessionManager.getSessionArtifactDir({ create: true })!;
		expect(rlmDir).toBeTruthy();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "test-key");
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
			cwd: sessionDir,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			resourceLoader: createTestResourceLoader(),
		});
		return { session, rlmDir };
	}

	it("reports the skipped children on the tree /context actually renders", () => {
		const dir = makeTempDir();
		const { session, rlmDir } = createFileBackedSession(dir);
		const budget = DEFAULT_CONTEXT_TREE_SCAN_BUDGET.maxChildren;
		const count = budget + 4;
		const names = writeRoster(rlmDir, count);
		try {
			// The production entry point: no diagnostics argument, no test-only helper.
			const tree = session.getContextTree();
			expect(tree.scan).toBeDefined();
			expect(tree.scan?.truncated).toBe(true);
			expect(tree.scan?.truncatedReason).toBe("children");
			expect(tree.scan?.skippedByBudget).toBe(4);
			expect(tree.scan?.scannedChildren).toBe(budget);
			expect(tree.scan?.bytesRead).toBeGreaterThan(0);
			// The newest branch is the one still on screen.
			expect(tree.children.map((node) => node.id)).toContain(names.at(-1));
			expect(tree.children.map((node) => node.id)).not.toContain(names[0]);

			const output = stripAnsi(formatContextTree(tree, 120));
			expect(output).toContain("4+ more agents not shown");
			expect(output).toContain("scan budget: children");
			expect(output).toContain(`${budget} child sessions read`);
		} finally {
			session.dispose();
		}
	});

	it("says nothing when the whole roster fit", () => {
		const dir = makeTempDir();
		const { session, rlmDir } = createFileBackedSession(dir);
		writeRoster(rlmDir, 6);
		try {
			const tree = session.getContextTree();
			expect(tree.scan).toBeUndefined();
			expect(tree.children).toHaveLength(6);
			expect(stripAnsi(formatContextTree(tree, 120))).not.toContain("not shown");
		} finally {
			session.dispose();
		}
	});
});
