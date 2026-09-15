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
	SESSION_TREE_MAX_WIRE_NODES,
	type SessionEntry,
	type SessionFlatTreeStats,
	type SessionHeader,
	SessionManager,
	type SessionTreeDepthStats,
	type SessionTreeNode,
} from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createAgentConnectionSnapshot } from "../src/modes/agent-connection/snapshot.js";
import type {
	AgentConnectionSessionTreeBound,
	AgentConnectionSessionTreeFlatStats,
} from "../src/modes/agent-connection/types.js";
import { serializeJsonLine } from "../src/modes/rpc/jsonl.js";
import { createTestResourceLoader } from "./utilities.js";

/** Deep enough that an unbounded JSON.stringify of the nested tree cannot survive it. */
const CHAIN_LENGTH = 20_000;

/** The scale a real long-running session reaches: one parent chain, no branching. */
const DEEP_CHAIN_LENGTH = 100_000;

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

/**
 * A session file that is one root with `children` sibling entries: depth 1, width
 * `children`. This is the shape a rewind-fork-heavy or multi-branch session produces -
 * shallow, but O(entries) nodes wide.
 */
function writeStarSession(children: number): string {
	const header: SessionHeader = {
		type: "session",
		id: "star-tree-session",
		version: 3,
		timestamp: new Date(0).toISOString(),
		cwd: tempDir,
	};
	const lines: string[] = [JSON.stringify(header)];
	const rootEntry: SessionEntry = {
		type: "custom",
		id: "star-root",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: "probe",
		data: {},
	};
	lines.push(JSON.stringify(rootEntry));
	for (let index = 0; index < children; index++) {
		const entry: SessionEntry = {
			type: "custom",
			id: `star-${index}`,
			parentId: "star-root",
			timestamp: new Date(index + 1).toISOString(),
			customType: "probe",
			data: { index },
		};
		lines.push(JSON.stringify(entry));
	}
	const path = join(tempDir, `star-tree-${children}.jsonl`);
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
	return path;
}

/** The node with this entry id anywhere in the returned tree, or undefined. */
function findNode(roots: readonly SessionTreeNode[], entryId: string): SessionTreeNode | undefined {
	const stack: SessionTreeNode[] = [...roots];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.entry.id === entryId) {
			return node;
		}
		stack.push(...node.children);
	}
	return undefined;
}

/** Whether a node with this entry id is anywhere in the returned tree. */
function treeContains(roots: readonly SessionTreeNode[], entryId: string): boolean {
	const stack: SessionTreeNode[] = [...roots];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.entry.id === entryId) {
			return true;
		}
		stack.push(...node.children);
	}
	return false;
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
			// Depth is parent edges, so the kept window is `depthLimit` levels plus the
			// shallowest retained node that stands as their root.
			expect(tree?.bound?.returnedNodes).toBe(SESSION_TREE_MAX_WIRE_DEPTH + 1);
			// The bound is on the tree, not on the session: the leaf is what the session
			// resumes on, so it is in the kept window rather than below the cut.
			expect(snapshot.state.leafId).toBe(`entry-${CHAIN_LENGTH - 1}`);
			expect(tree?.bound?.leafIncluded).toBe(true);
			expect(tree?.bound?.retainedFromDepth).toBe(CHAIN_LENGTH - 1 - SESSION_TREE_MAX_WIRE_DEPTH);
			expect(treeContains(tree?.tree ?? [], `entry-${CHAIN_LENGTH - 1}`)).toBe(true);
			// The cut took the old top of the chain, not the recent tail.
			expect(treeContains(tree?.tree ?? [], "entry-0")).toBe(false);

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

		// The flat stats ride get_session_tree's treeBound, so the connection contract
		// owns a wire DTO for them (AgentConnectionSessionTreeFlatStats). Pin the two
		// field sets to each other, both directions, exactly like the depth-bound mirror:
		// a field added to or dropped from either side must fail here instead of silently
		// narrowing the wire shape (treeBound was a dead wire field precisely because no
		// pin and no consumer existed).
		expect(Object.keys(bounded.stats).sort()).toEqual([
			"maxNodes",
			"omittedNodes",
			"returnedNodes",
			"totalEntries",
			"truncated",
		]);
		const flatMirror: AgentConnectionSessionTreeFlatStats = bounded.stats;
		const statsMirror: SessionFlatTreeStats = flatMirror;
		expect(Object.keys(flatMirror).sort()).toEqual(Object.keys(statsMirror).sort());
	});

	/**
	 * X-7: after a rewind, the leaf is an *early* entry and the file's last line is the
	 * leaf_position marker `branch()` appends, so the leaf is not the last entry in file
	 * order. A flat bound that keeps only the newest tail cut the entry the session
	 * resumes on while `leafId` still pointed at it - a dangling reference, and the
	 * opposite truncation from the nested bound (r19), which keeps the live leaf. The
	 * daemon's `get_session_tree` and the snapshot's sessionTree are the two connection
	 * paths, so both bounds must keep the leaf, and both must do it inside the cap.
	 */
	it("keeps the rewound live leaf inside both the flat and the nested bound", () => {
		const sessionManager = SessionManager.open(writeChainSession(20_010), tempDir);
		sessionManager.branch("entry-5");
		expect(sessionManager.getLeafId()).toBe("entry-5");

		const flat = sessionManager.getBoundedFlatTree();
		// 20_010 chain entries plus the leaf_position marker branch() appends.
		expect(flat.stats.totalEntries).toBe(20_011);
		expect(flat.stats.truncated).toBe(true);
		expect(flat.stats.returnedNodes).toBeLessThanOrEqual(SESSION_TREE_FLAT_MAX_NODES);
		expect(flat.stats.returnedNodes + flat.stats.omittedNodes).toBe(flat.stats.totalEntries);
		expect(flat.nodes.map((node) => node.entry.id)).toContain("entry-5");

		const nested = sessionManager.getBoundedTree();
		expect(nested.stats.leafIncluded).toBe(true);
		expect(nested.stats.returnedNodes).toBeLessThanOrEqual(SESSION_TREE_MAX_WIRE_NODES);
		expect(nested.stats.returnedNodes + nested.stats.omittedNodes).toBe(nested.stats.entries);
		expect(treeContains(nested.tree, "entry-5")).toBe(true);

		// Positive control, no rewind: the leaf is the newest entry, so the flat bound
		// keeps the plain newest tail exactly as it did before the fix.
		const control = SessionManager.open(writeChainSession(20_010), tempDir);
		const controlFlat = control.getBoundedFlatTree();
		expect(controlFlat.stats.returnedNodes).toBe(SESSION_TREE_FLAT_MAX_NODES);
		expect(controlFlat.nodes.map((node) => node.entry.id)).toContain("entry-20009");
		expect(controlFlat.nodes.map((node) => node.entry.id)).not.toContain("entry-5");
		expect(controlFlat.stats.returnedNodes + controlFlat.stats.omittedNodes).toBe(controlFlat.stats.totalEntries);
	});

	/**
	 * The wire bound used to keep the *oldest* `depthLimit` layers: on a chain longer than
	 * the limit, the returned tree was the head of the session and the entry the session
	 * resumes on was the one thing guaranteed to be missing - the opposite side from the
	 * flat bound, which keeps the newest entries. A 100k-entry session is the shape a real
	 * long-running agent produces, so it is the shape the direction is pinned on.
	 */
	it("keeps the live leaf of a 100k-deep chain inside the bounded tree", () => {
		const sessionManager = SessionManager.open(writeChainSession(DEEP_CHAIN_LENGTH), tempDir);
		const bounded = sessionManager.getBoundedTree();
		const leafId = sessionManager.getLeafId();

		expect(bounded.stats.entries).toBe(DEEP_CHAIN_LENGTH);
		expect(bounded.stats.truncated).toBe(true);
		expect(leafId).toBe(`entry-${DEEP_CHAIN_LENGTH - 1}`);
		expect(bounded.stats.leafIncluded).toBe(true);
		expect(treeContains(bounded.tree, leafId!)).toBe(true);
		expect(bounded.stats.retainedFromDepth).toBe(DEEP_CHAIN_LENGTH - 1 - SESSION_TREE_MAX_WIRE_DEPTH);
		expect(bounded.stats.omittedNodes).toBe(DEEP_CHAIN_LENGTH - 1 - SESSION_TREE_MAX_WIRE_DEPTH);
		expect(bounded.stats.returnedNodes).toBe(SESSION_TREE_MAX_WIRE_DEPTH + 1);
		// Still serializer-safe: the window is the newest `depthLimit` levels.
		expect(depthOfTree(bounded.tree)).toBeLessThanOrEqual(SESSION_TREE_MAX_WIRE_DEPTH);
		expect(serializeJsonLine({ tree: bounded.tree }).length).toBeGreaterThan(0);
	});

	it("keeps a rewound leaf and its ancestor chain visible even when a deeper branch owns the deep window", () => {
		const sessionManager = SessionManager.open(writeChainSession(10), tempDir);
		// Move the leaf back up the chain: the deepest entries are now an abandoned branch,
		// so a window anchored only at the global deepest entry would cut the entry the
		// session actually resumes on down to a detached leaf.
		sessionManager.branch("entry-2");
		expect(sessionManager.getLeafId()).toBe("entry-2");

		const bounded = sessionManager.getBoundedTree(3);
		expect(bounded.stats.maxDepth).toBe(9);
		// The live window reaches the root (leaf depth 2, limit 3), so the shallowest
		// retained node is entry-0.
		expect(bounded.stats.retainedFromDepth).toBe(0);
		expect(bounded.stats.leafIncluded).toBe(true);
		// The live branch's ancestor chain stays a chain, not just a floating leaf.
		expect(treeContains(bounded.tree, "entry-2")).toBe(true);
		expect(treeContains(bounded.tree, "entry-1")).toBe(true);
		expect(treeContains(bounded.tree, "entry-0")).toBe(true);
		const liveParent = findNode(bounded.tree, "entry-1");
		expect(liveParent?.children.map((child) => child.entry.id)).toContain("entry-2");
		// The deep window still keeps the abandoned branch's newest layers.
		expect(treeContains(bounded.tree, "entry-9")).toBe(true);
		expect(treeContains(bounded.tree, "entry-5")).toBe(false);
		// Depth bound still holds, and the counts still add up to the session.
		expect(depthOfTree(bounded.tree)).toBeLessThanOrEqual(3);
		expect(bounded.stats.returnedNodes + bounded.stats.omittedNodes).toBe(bounded.stats.entries);
	});

	/**
	 * GL-1: the depth window used to be anchored at the *global* max depth, so a
	 * rewind-and-fork session (live leaf shallow, abandoned branch deep) kept the dead
	 * branch's bottom layers and cut the live branch's ancestor chain - the leaf only
	 * survived as a detached root with no ancestors. The window must also anchor at the
	 * live leaf's own depth, so the branch the session resumes on stays navigable.
	 */
	it("keeps the live branch's ancestor chain in a rewind-and-fork session", () => {
		const sessionManager = SessionManager.open(writeChainSession(10), tempDir);
		sessionManager.branch("entry-2");
		const forkId = sessionManager.appendCustomEntry("probe", { fork: true });
		expect(sessionManager.getLeafId()).toBe(forkId);

		const bounded = sessionManager.getBoundedTree(3);
		// The live path (entry-0 -> entry-1 -> entry-2 -> fork) is retained as a chain,
		// not just its leaf.
		for (const id of ["entry-0", "entry-1", "entry-2", forkId]) {
			expect(treeContains(bounded.tree, id)).toBe(true);
		}
		// The fork rides under its real parent instead of floating as a detached root.
		const liveParent = findNode(bounded.tree, "entry-2");
		expect(liveParent?.children.map((child) => child.entry.id)).toContain(forkId);
		// The deep window (the "new" side) is still kept for the abandoned branch.
		expect(treeContains(bounded.tree, "entry-9")).toBe(true);
		expect(bounded.stats.leafIncluded).toBe(true);
		expect(depthOfTree(bounded.tree)).toBeLessThanOrEqual(3);
	});

	/**
	 * GL-2: a leaf returned as a detached root was counted in both `omittedNodes` and
	 * `returnedNodes`, so the stats over-reported the session by one (entries=1204,
	 * returned+omitted=1205). Every bounded view must satisfy the identity
	 * returned + omitted == entries.
	 */
	it("never double-counts a detached leaf: returned plus omitted equals entries", () => {
		// X-13: a width cap below the live chain's own length is the one shape where the
		// leaf genuinely comes back detached - a root with no ancestors and no children.
		// The pre-fix version of this test never constructed one (the safety net that
		// detaches a leaf is unreachable while the leaf anchors its own window), so the
		// "counted once" proposition held by construction, not by evidence.
		const detached = SessionManager.open(writeChainSession(10), tempDir);
		const detachedBounded = detached.getBoundedTree(Number.POSITIVE_INFINITY, 1);
		expect(detachedBounded.stats.maxNodes).toBe(1);
		expect(detachedBounded.stats.returnedNodes).toBe(1);
		expect(detachedBounded.stats.omittedNodes).toBe(9);
		expect(detachedBounded.stats.leafIncluded).toBe(true);
		expect(detachedBounded.tree).toHaveLength(1);
		expect(detachedBounded.tree[0]?.entry.id).toBe("entry-9");
		expect(detachedBounded.tree[0]?.children).toEqual([]);
		expect(detachedBounded.stats.returnedNodes + detachedBounded.stats.omittedNodes).toBe(
			detachedBounded.stats.entries,
		);

		const rewound = SessionManager.open(writeChainSession(10), tempDir);
		rewound.branch("entry-2");
		const rewoundBounded = rewound.getBoundedTree(3);
		// 10 chain entries plus the leaf_position marker branch() appends.
		expect(rewoundBounded.stats.entries).toBe(11);
		expect(rewoundBounded.stats.returnedNodes + rewoundBounded.stats.omittedNodes).toBe(rewoundBounded.stats.entries);

		const forked = SessionManager.open(writeChainSession(10), tempDir);
		forked.branch("entry-2");
		forked.appendCustomEntry("probe", { fork: true });
		const forkedBounded = forked.getBoundedTree(3);
		expect(forkedBounded.stats.returnedNodes + forkedBounded.stats.omittedNodes).toBe(forkedBounded.stats.entries);

		const deep = SessionManager.open(writeChainSession(DEEP_CHAIN_LENGTH), tempDir);
		const deepBounded = deep.getBoundedTree();
		expect(deepBounded.stats.returnedNodes + deepBounded.stats.omittedNodes).toBe(deepBounded.stats.entries);

		const unbounded = SessionManager.open(writeChainSession(10), tempDir);
		const unboundedStats = unbounded.getBoundedTree(Number.POSITIVE_INFINITY).stats;
		expect(unboundedStats.returnedNodes + unboundedStats.omittedNodes).toBe(unboundedStats.entries);
	});

	/**
	 * The TUI tree selector consumes `getSessionTree()`, which prefers the snapshot's
	 * `sessionTree` (built by `createAgentConnectionSnapshot` via `getBoundedTree()`),
	 * so the GL-1 anchor fix has to be observable at that boundary, not only on the
	 * SessionManager. A 1200-deep chain with a rewind-and-fork reproduces the selector's
	 * view of a session whose live branch is shallower than an abandoned deep branch.
	 */
	it("ships the live branch's ancestor chain through the snapshot the tree selector consumes", () => {
		const FORK_CHAIN_LENGTH = 1200;
		const { session, dispose } = openDeepSession(FORK_CHAIN_LENGTH);
		try {
			session.sessionManager.branch("entry-2");
			const forkId = session.sessionManager.appendCustomEntry("probe", { fork: true });

			const snapshot = createAgentConnectionSnapshot({ session } as unknown as AgentSessionRuntime);
			const tree = snapshot.sessionTree?.tree ?? [];
			expect(snapshot.state.leafId).toBe(forkId);
			for (const id of ["entry-0", "entry-1", "entry-2", forkId]) {
				expect(treeContains(tree, id)).toBe(true);
			}
			const liveParent = findNode(tree, "entry-2");
			expect(liveParent?.children.map((child) => child.entry.id)).toContain(forkId);
			// The abandoned branch's newest layers are still in the snapshot tree.
			expect(treeContains(tree, `entry-${FORK_CHAIN_LENGTH - 1}`)).toBe(true);

			const bound = snapshot.sessionTree?.bound;
			if (!bound) {
				throw new Error("snapshot tree stats missing");
			}
			expect(bound.leafIncluded).toBe(true);
			expect(bound.returnedNodes + bound.omittedNodes).toBe(bound.entries);
			expect(depthOfTree(tree)).toBeLessThanOrEqual(SESSION_TREE_MAX_WIRE_DEPTH);
			// The bounded snapshot still serializes.
			expect(serializeJsonLine(snapshot).length).toBeGreaterThan(0);
		} finally {
			dispose();
		}
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
		// The r19 anchor semantics widened the shape: `retainedFromDepth` now reports the depth
		// of the shallowest retained node (how many top layers were cut) and `leafIncluded`
		// says whether the entry the session resumes on survived the bound, so both must ride
		// on the wire DTO too.
		expect(Object.keys(stats).sort()).toEqual([
			"depthLimit",
			"entries",
			"leafIncluded",
			"maxDepth",
			"maxNodes",
			"omittedNodes",
			"retainedFromDepth",
			"returnedNodes",
			"truncated",
		]);
		// The mirror pin, both directions: the DTO must not name a field the stats lack, and
		// the stats must not gain a field the DTO hides. tsgo fails on either drift.
		const boundMirror: AgentConnectionSessionTreeBound = stats;
		const statsMirror: SessionTreeDepthStats = boundMirror;
		expect(Object.keys(boundMirror).sort()).toEqual(Object.keys(statsMirror).sort());
	});

	/**
	 * CM-3: a depth bound cannot bound the frame on its own. A star-shaped session
	 * (one root, 30k children) has maxDepth 1, so every node passed the depth window,
	 * the whole tree went on the wire (~6.4MB serialized) and the stats said
	 * truncated:false while the flat view of the *same* session cut at 20k nodes and
	 * said truncated:true. The nested bound needs a total node cap, and it must keep
	 * the same side as every other bound: the newest entries plus the live leaf's
	 * retained ancestors.
	 */
	it("bounds the total node count of a wide tree, not only its depth", () => {
		const sessionManager = SessionManager.open(writeStarSession(30_000), tempDir);
		const bounded = sessionManager.getBoundedTree();

		expect(bounded.stats.entries).toBe(30_001);
		expect(bounded.stats.maxDepth).toBe(1);
		// X-13: the cap is hard. It used to be soft - the live leaf's retained ancestors
		// were exempt from the window, so the bound returned 20_001 nodes while the stats
		// said the cap was 20k. The live chain is now kept first and the window shrinks by
		// what it cost, so the returned count never exceeds the cap.
		expect(bounded.stats.maxNodes).toBe(SESSION_TREE_MAX_WIRE_NODES);
		expect(bounded.stats.returnedNodes).toBe(SESSION_TREE_MAX_WIRE_NODES);
		expect(bounded.stats.omittedNodes).toBe(30_001 - bounded.stats.returnedNodes);
		expect(bounded.stats.truncated).toBe(true);
		expect(bounded.stats.leafIncluded).toBe(true);
		expect(bounded.stats.returnedNodes + bounded.stats.omittedNodes).toBe(bounded.stats.entries);
		// The kept side is the newest one; the root survives as the leaf's ancestor.
		expect(treeContains(bounded.tree, "star-29999")).toBe(true);
		expect(treeContains(bounded.tree, "star-0")).toBe(false);
		expect(treeContains(bounded.tree, "star-root")).toBe(true);
		// The capped tree is both smaller than the whole star and bounded in node count,
		// which is what keeps the frame from growing with the session's width.
		const boundedLine = serializeJsonLine({ tree: bounded.tree });
		const unboundedLine = serializeJsonLine({ tree: sessionManager.getTree() });
		expect(boundedLine.length).toBeLessThan(unboundedLine.length);
		expect(boundedLine.length).toBeLessThan(4_000_000);
	});
});
