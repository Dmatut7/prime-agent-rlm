/**
 * A long session's tree is as deep as its longest parent chain, and the snapshot that
 * carries it is a JSONL frame: `JSON.stringify` recurses per nesting level and dies around
 * 5k levels, so a 20k-deep chain made `serializeJsonLine(createAgentConnectionSnapshot(...))`
 * throw `RangeError: Maximum call stack size exceeded`. The same shape shipped whole through
 * `get_session_tree` too: every entry is sent as-is, so the frame is O(entries) bytes.
 *
 * These tests pin the two bounds and the diagnostics that make a truncation reportable:
 * a bounded snapshot tree serializes, and the flat tree says how many entries it left out.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import {
	SESSION_TREE_FLAT_MAX_NODES,
	SESSION_TREE_MAX_WIRE_DEPTH,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createAgentConnectionSnapshot } from "../src/modes/agent-connection/snapshot.js";
import { serializeJsonLine } from "../src/modes/rpc/jsonl.js";
import { createTestResourceLoader } from "./utilities.js";

/** Deep enough that an unbounded JSON.stringify of the nested tree cannot survive it. */
const CHAIN_LENGTH = 20_000;

const tempDir = mkdtempSync(join(tmpdir(), "session-tree-depth-"));
afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

/** A session file that is one parent chain of `length` entries, i.e. a 20k-deep tree. */
function writeChainSession(length: number): string {
	const header: SessionHeader = {
		type: "session",
		id: "deep-tree-session",
		version: 3,
		timestamp: new Date(0).toISOString(),
		cwd: tempDir,
	};
	const lines: string[] = [JSON.stringify(header)];
	let parentId: string | null = null;
	for (let index = 0; index < length; index++) {
		const entry: SessionEntry = {
			type: "custom",
			id: `entry-${index}`,
			parentId,
			timestamp: new Date(index).toISOString(),
			customType: "probe",
			data: { index },
		};
		lines.push(JSON.stringify(entry));
		parentId = entry.id;
	}
	const path = join(tempDir, `deep-tree-${length}.jsonl`);
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
	return path;
}

function depthOfTree(roots: readonly { children: unknown[] }[]): number {
	let maxDepth = 0;
	const stack = roots.map((node) => ({ node, depth: 0 }));
	while (stack.length > 0) {
		const { node, depth } = stack.pop()!;
		if (depth > maxDepth) maxDepth = depth;
		for (const child of node.children) {
			stack.push({ node: child as { children: unknown[] }, depth: depth + 1 });
		}
	}
	return maxDepth;
}

function openDeepSession(length: number): { session: AgentSession; dispose: () => void } {
	const faux = registerFauxProvider({});
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const sessionManager = SessionManager.open(writeChainSession(length), tempDir);
	const agent = new Agent({
		getApiKey: () => "faux-key",
		initialState: { model, systemPrompt: "probe", tools: [] },
		convertToLlm,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		cwd: tempDir,
		modelRegistry,
		resourceLoader: createTestResourceLoader(),
	});
	return {
		session,
		dispose: () => {
			session.dispose();
			faux.unregister();
		},
	};
}

describe("session tree wire bounds", () => {
	it("serializes a snapshot of a deep session instead of overflowing the stack", () => {
		const { session, dispose } = openDeepSession(CHAIN_LENGTH);
		try {
			const snapshot = createAgentConnectionSnapshot({ session } as unknown as AgentSessionRuntime);
			const tree = snapshot.sessionTree;
			expect(tree).toBeDefined();
			expect(tree?.bound).toBeDefined();
			expect(tree?.bound?.entries).toBe(CHAIN_LENGTH);
			expect(tree?.bound?.depthLimit).toBe(SESSION_TREE_MAX_WIRE_DEPTH);
			expect(tree?.bound?.truncated).toBe(true);
			expect(tree?.bound?.omittedNodes).toBeGreaterThan(0);
			expect(tree?.bound?.maxDepth).toBe(CHAIN_LENGTH - 1);
			// Depth is parent edges, so the kept subtree is the root plus `depthLimit` levels.
			expect(tree?.bound?.returnedNodes).toBe(SESSION_TREE_MAX_WIRE_DEPTH + 1);
			// The bound is on the tree, not on the session: the leaf is what the session resumes on.
			expect(snapshot.state.leafId).toBe(`entry-${CHAIN_LENGTH - 1}`);

			const line = serializeJsonLine(snapshot);
			expect(line.length).toBeGreaterThan(0);
			// Bounded frame: the unbounded tree alone is >100k nodes of nesting.
			expect(line.length).toBeLessThan(2_000_000);
			expect(depthOfTree(tree?.tree ?? [])).toBeLessThanOrEqual(SESSION_TREE_MAX_WIRE_DEPTH);
		} finally {
			dispose();
		}
	});

	it("reports what the flat tree bound left out and keeps the newest entries", () => {
		const sessionManager = SessionManager.open(writeChainSession(5), tempDir);
		const bounded = sessionManager.getBoundedFlatTree(3);
		expect(bounded.stats).toEqual({
			totalEntries: 5,
			returnedNodes: 3,
			omittedNodes: 2,
			maxNodes: 3,
			truncated: true,
		});
		expect(bounded.nodes.map((node) => node.entry.id)).toEqual(["entry-2", "entry-3", "entry-4"]);
		expect(sessionManager.getLeafId()).toBe("entry-4");

		const unbounded = sessionManager.getBoundedFlatTree(SESSION_TREE_FLAT_MAX_NODES);
		expect(unbounded.stats.truncated).toBe(false);
		expect(unbounded.stats.totalEntries).toBe(5);
	});

	it("keeps the unbounded tree request unmodified for callers that ask for it", () => {
		const sessionManager = SessionManager.open(writeChainSession(5), tempDir);
		const tree = sessionManager.getTree();
		const stats = sessionManager.getBoundedTree(Number.POSITIVE_INFINITY).stats;
		expect(depthOfTree(tree)).toBe(4);
		expect(stats.truncated).toBe(false);
		expect(stats.omittedNodes).toBe(0);
		expect(stats.entries).toBe(5);
		// The connection contract owns its wire DTO (`AgentConnectionSessionTreeBound`) and may
		// not import this module, so pin the two field sets to each other: a field added to or
		// dropped from these stats must fail here instead of silently narrowing the wire shape.
		expect(Object.keys(stats).sort()).toEqual([
			"depthLimit",
			"entries",
			"maxDepth",
			"omittedNodes",
			"returnedNodes",
			"truncated",
		]);
	});
});
