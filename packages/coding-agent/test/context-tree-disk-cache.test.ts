import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, getModel, type Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	ContextTreeDiskScanCache,
	loadContextTreeChildFromDisk,
	loadContextTreeChildrenFromDisk,
} from "../src/core/context-tree.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

/**
 * The on-disk half of the context tree is what a /context paint and every sub-agents
 * tray refresh pay for, and it is the same directory tree almost every time. These pins
 * hold the two things that make reusing it safe: a change anywhere the scan reads must
 * invalidate the remembered answer, and reusing one must be indistinguishable from
 * walking it - including the budget report that says how much of the tree was skipped.
 */

const model = getModel("anthropic", "claude-sonnet-4-5")!;

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

/** The bytes a `writeChildSession`-style transcript holds for one assistant turn. */
function transcriptText(cost: number): string {
	const header = {
		type: "session",
		version: 3,
		id: `child-${cost}`,
		timestamp: new Date().toISOString(),
		cwd: process.cwd(),
	};
	const user = {
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "child task", timestamp: Date.now() },
	};
	const assistant = {
		type: "message",
		id: "a1",
		parentId: "u1",
		timestamp: new Date().toISOString(),
		message: assistantMessage("done", usage(1000, 100, cost)),
	};
	return `${[header, user, assistant].map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** One persisted child dir with a transcript, as an RLM child run leaves it behind. */
function writeChildDir(parentDir: string, name: string, cost: number): string {
	const dir = join(parentDir, name);
	mkdirSync(dir, { recursive: true });
	const { writeFileSync } = require("node:fs") as typeof import("node:fs");
	writeFileSync(join(dir, "session.jsonl"), transcriptText(cost));
	return dir;
}

let tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "context-tree-cache-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

const resolveContextWindow = () => 200000;

describe("ContextTreeDiskScanCache", () => {
	it("reuses an unchanged dir tree, and hands out copies of what it remembered", () => {
		const rlmDir = makeTempDir();
		writeChildDir(rlmDir, "sub-aaaa1111", 0.1);
		writeChildDir(join(rlmDir, "sub-aaaa1111"), "sub-bbbb2222", 0.05);
		const cache = new ContextTreeDiskScanCache();

		const first = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow, undefined, undefined, cache);
		expect(first).toHaveLength(1);
		expect(first[0].children).toHaveLength(1);
		expect(cache.stats.subtreeHits).toBe(0);

		const second = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow, undefined, undefined, cache);
		expect(second).toEqual(first);
		// The root dir's subtree was served from the fingerprint: no walk, no reads.
		expect(cache.stats.subtreeHits).toBeGreaterThan(0);
		expect(cache.stats.nodeMisses).toBe(2);

		// A caller that mutates its tree cannot corrupt the remembered one: the next
		// reuse must still report the figure that is on disk, not the caller's edit.
		first[0].ownUsage.cost.total = -1;
		first[0].children[0].ownUsage.input = -1;
		const third = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow, undefined, undefined, cache);
		expect(third[0].ownUsage.cost.total).toBeCloseTo(0.1);
		expect(third[0].children[0].ownUsage.input).toBe(1000);
	});

	it("re-reads a child whose transcript moved, and only that child", () => {
		const rlmDir = makeTempDir();
		const stable = writeChildDir(rlmDir, "sub-aaaa1111", 0.1);
		const moving = writeChildDir(rlmDir, "sub-bbbb2222", 0.2);
		const cache = new ContextTreeDiskScanCache();

		loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow, undefined, undefined, cache);
		const missesAfterFirst = cache.stats.nodeMisses;
		expect(missesAfterFirst).toBe(2);

		// A resumed child appends: its own transcript grows, nothing else moves.
		const { writeFileSync } = require("node:fs") as typeof import("node:fs");
		writeFileSync(join(moving, "session.jsonl"), `${transcriptText(0.2)}${transcriptText(0.3)}`);
		expect(existsSync(stable)).toBe(true);

		const second = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow, undefined, undefined, cache);
		// The subtree fingerprint moved, so the walk ran; only the changed transcript was
		// parsed again.
		expect(cache.stats.nodeMisses).toBe(missesAfterFirst + 1);
		const byId = new Map(second.map((node) => [node.id, node]));
		expect(byId.get("sub-bbbb2222")?.ownUsage.cost.total).toBeCloseTo(0.5);
		expect(byId.get("sub-aaaa1111")?.ownUsage.cost.total).toBeCloseTo(0.1);
	});

	it("notices a change that only a deeper level can see", () => {
		const rlmDir = makeTempDir();
		const childDir = writeChildDir(rlmDir, "sub-aaaa1111", 0.1);
		const cache = new ContextTreeDiskScanCache();

		const first = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow, undefined, undefined, cache);
		expect(first[0].children).toHaveLength(0);
		expect(cache.stats.subtreeHits).toBe(0);

		// A grandchild appears one level below the dir whose fingerprint would have been
		// reused: the listing fingerprint covers every level the scan can read.
		writeChildDir(childDir, "sub-cccc3333", 0.3);
		const second = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow, undefined, undefined, cache);
		expect(second[0].children.map((node) => node.id)).toEqual(["sub-cccc3333"]);
		expect(second[0].children[0].ownUsage.cost.total).toBeCloseTo(0.3);
	});

	it("keys reuse on the live ids as well as on the disk", () => {
		const rlmDir = makeTempDir();
		writeChildDir(rlmDir, "sub-aaaa1111", 0.1);
		const cache = new ContextTreeDiskScanCache();

		const withLive = loadContextTreeChildrenFromDisk(
			rlmDir,
			resolveContextWindow,
			new Set(["sub-aaaa1111"]),
			undefined,
			cache,
		);
		expect(withLive).toEqual([]);

		// The child settles: it is no longer represented live, so its persisted subtree
		// must appear even though the disk has not moved a byte.
		const settled = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow, undefined, undefined, cache);
		expect(settled.map((node) => node.id)).toEqual(["sub-aaaa1111"]);
		expect(settled[0].ownUsage.cost.total).toBeCloseTo(0.1);
	});

	it("charges a reused subtree exactly what the walk charged, so the budget report stands", () => {
		const rlmDir = makeTempDir();
		for (let index = 0; index < 5; index++) {
			writeChildDir(rlmDir, `sub-aaaa000${index}`, 0.1 + index);
		}
		const budget = { maxChildren: 2, maxBytes: 64 * 1024 * 1024, maxDepth: 4 };

		// Two scans, one walked and one reused, must report the same omission: a cached
		// answer that looks complete would tell /context it is showing the whole roster.
		const walkedCache = new ContextTreeDiskScanCache();
		const walked = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow, undefined, budget, walkedCache);
		const reused = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow, undefined, budget, walkedCache);
		const uncached = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow, undefined, budget);

		expect(walked).toHaveLength(2);
		expect(reused).toEqual(walked);
		expect(uncached).toEqual(walked);
	});

	it("treats a vanished child dir as nothing persisted rather than as a failed scan", () => {
		const rlmDir = makeTempDir();
		const childDir = writeChildDir(rlmDir, "sub-aaaa1111", 0.1);
		rmSync(childDir, { recursive: true, force: true });

		// Both the walk and the single-dir loader are called on dirs that can disappear
		// under them (retention sweeps, a hand-cleaned tree); neither may throw, because a
		// tray refresh that throws loses the whole figure.
		expect(loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow)).toEqual([]);
		expect(loadContextTreeChildFromDisk(childDir, resolveContextWindow)).toBeUndefined();
	});

	it("re-derives a node whose model context window changed under it", () => {
		const rlmDir = makeTempDir();
		const childDir = writeChildDir(rlmDir, "sub-aaaa1111", 0.1);
		const { writeFileSync } = require("node:fs") as typeof import("node:fs");
		writeFileSync(
			join(childDir, "session.jsonl"),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "child-model",
				timestamp: new Date().toISOString(),
				cwd: process.cwd(),
			})}\n${JSON.stringify({
				type: "model_change",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				provider: model.provider,
				modelId: model.id,
			})}\n${JSON.stringify({
				type: "message",
				id: "u1",
				parentId: "m1",
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "child task", timestamp: Date.now() },
			})}\n${JSON.stringify({
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: new Date().toISOString(),
				message: assistantMessage("done", usage(1000, 100, 0.1)),
			})}\n`,
		);
		const cache = new ContextTreeDiskScanCache();

		const narrow = loadContextTreeChildrenFromDisk(rlmDir, () => 1000, undefined, undefined, cache);
		expect(narrow[0].contextUsage?.contextWindow).toBe(1000);
		const wide = loadContextTreeChildrenFromDisk(rlmDir, () => 200000, undefined, undefined, cache);
		expect(wide[0].contextUsage?.contextWindow).toBe(200000);
		expect(wide[0].ownUsage.cost.total).toBeCloseTo(0.1);
	});
});

describe("AgentSession.getContextTree with a resident child", () => {
	function createSession(rlmDir: string, streamFn?: StreamFn) {
		const tempDir = makeTempDir();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				convertToLlm: (messages) => messages as never,
				initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
				streamFn:
					streamFn ??
					(() => {
						const stream = createAssistantMessageEventStream();
						queueMicrotask(() =>
							stream.push({
								type: "done",
								reason: "stop",
								message: assistantMessage("child answer", usage(1000, 100, 0.4)),
							}),
						);
						return stream;
					}),
			}),
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
			rlmMaxDepth: 2,
			rlmSessionDir: rlmDir,
		});
		return session;
	}

	it("reports a tracked child whose transcript vanished instead of failing the tree", async () => {
		const rlmDir = makeTempDir();
		const session = createSession(join(rlmDir, "rlm"));
		try {
			const spawned = await session.runRlmChild("read the transcripts");
			expect(existsSync(spawned.session_dir)).toBe(true);

			// A live child is answered from its resident session, not from the disk: its
			// transcript is still growing while its turn is in flight.
			const live = session.getContextTree().children.find((node) => node.id === spawned.rlm_child_id);
			expect(live?.status).toBe("running");

			// The unfinished corner a tray refresh can reach: the run is still tracked but
			// has no session handle (a publication that never landed, a run whose handle was
			// dropped), and there is nothing on disk to fall back to (retention, a
			// hand-cleaned tree). The cell is best-effort, so the child reports no spend
			// instead of the whole tree failing on a `scandir` of a directory that is gone.
			const runs = Reflect.get(session, "_activeRlmChildRuns") as Map<string, Record<string, unknown>>;
			const run = runs.get(spawned.rlm_child_id);
			expect(run).toBeDefined();
			Reflect.set(run as Record<string, unknown>, "session", undefined);
			rmSync(spawned.session_dir, { recursive: true, force: true });

			const tree = session.getContextTree();
			const child = tree.children.find((node) => node.id === spawned.rlm_child_id);
			expect(child).toBeDefined();
			// The run is still the child's row, and with nothing readable behind it the
			// node carries no spend rather than a stale figure or a thrown refresh.
			expect(child?.ownUsage.cost.total).toBe(0);
			expect(child?.status).toBe("running");
		} finally {
			session.dispose();
		}
	});

	it("reuses its own disk scan across calls", async () => {
		const rlmDir = makeTempDir();
		const session = createSession(join(rlmDir, "rlm"));
		try {
			writeChildDir(join(rlmDir, "rlm"), "sub-persisted1", 0.7);

			const first = session.getContextTree();
			const firstChild = first.children.find((node) => node.id === "sub-persisted1");
			expect(firstChild?.ownUsage.cost.total).toBeCloseTo(0.7);

			const cache = Reflect.get(session, "_contextTreeDiskCache") as ContextTreeDiskScanCache;
			expect(cache).toBeInstanceOf(ContextTreeDiskScanCache);
			const misses = cache.stats.subtreeMisses;

			const second = session.getContextTree();
			expect(second).toEqual(first);
			expect(cache.stats.subtreeMisses).toBe(misses);
			expect(cache.stats.subtreeHits).toBeGreaterThan(0);
		} finally {
			session.dispose();
		}
	});
});
