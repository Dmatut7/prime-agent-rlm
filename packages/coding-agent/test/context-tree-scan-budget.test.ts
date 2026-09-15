/**
 * Bounded, observable on-disk context tree scans (PERF-TREE).
 *
 * `/context` used to walk the persisted RLM session dirs recursively and read
 * every session file it found with no limit and no report of what it covered:
 * one directory of 544 finished children cost 2.2s and ~1.08GB of reads, and a
 * nested `sub-*` dir pointing back at an ancestor walked the JS stack until it
 * died. These tests pin the replacement: iterative traversal, an explicit
 * budget, and structured diagnostics for whatever the budget refused.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type {
	ContextTreeNode,
	ContextTreeScanBudget,
	ContextTreeScanDiagnostics,
	ContextTreeScanResult,
} from "../src/core/context-tree.js";
import * as contextTree from "../src/core/context-tree.js";

const model = { provider: "anthropic", id: "claude-sonnet-4-5" };
const resolveContextWindow = () => 200000;
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const KIB = 1024;
const MIB = 1024 * KIB;

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

/** Persist a child session the way an RLM child run does, sized to at least `bytes`. */
function writeSession(dir: string, sessionId: string, prompt: string, bytes: number, mtimeMs?: number): number {
	mkdirSync(dir, { recursive: true });
	const entry = (id: string, parentId: string | null, message: unknown) => ({
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message,
	});
	const base = [
		{ type: "session", version: 3, id: sessionId, timestamp: TIMESTAMP, cwd: process.cwd() },
		{
			type: "model_change",
			id: "m1",
			parentId: null,
			timestamp: TIMESTAMP,
			provider: model.provider,
			modelId: model.id,
		},
		entry("u1", "m1", { role: "user", content: prompt, timestamp: Date.now() }),
		entry("a1", "u1", assistantMessage()),
	];
	const serialize = (lines: readonly unknown[]): string => `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
	const lines = [...base];
	const probe = serialize([...lines, entry("u2", "a1", { role: "user", content: "", timestamp: 1 })]).length;
	if (probe < bytes) {
		lines.push(entry("u2", "a1", { role: "user", content: "x".repeat(bytes - probe), timestamp: 1 }));
	}
	const file = join(dir, `${sessionId}.jsonl`);
	writeFileSync(file, serialize(lines));
	if (mtimeMs !== undefined) {
		// Rosters are ordered by session dir mtime; pin it so a scan's cut point
		// is the same on every run.
		const when = new Date(mtimeMs);
		utimesSync(dir, when, when);
	}
	return statSync(file).size;
}

/** A roster of `count` sibling child sessions, all the same size. */
function writeSiblings(rlmDir: string, count: number, bytes: number): number {
	let size = 0;
	for (let index = 0; index < count; index++) {
		size = writeSession(
			join(rlmDir, `sub-${String(index).padStart(4, "0")}`),
			`s${String(index).padStart(4, "0")}`,
			`task ${index}`,
			bytes,
			1_700_000_000_000 + index * 1000,
		);
	}
	return size;
}

/**
 * Nested chain of child sessions, each one a `sub-*` dir inside the previous.
 * The dir name stays as short as `sub-` allows so the deepest chain the
 * filesystem (`PATH_MAX`) accepts is the thing under test.
 */
function writeChain(root: string, levels: number): { built: number; hitPathLimit: boolean } {
	let dir = root;
	let built = 0;
	for (let level = 0; level < levels; level++) {
		dir = join(dir, "sub-a");
		try {
			writeSession(dir, `chain-${String(level).padStart(4, "0")}`, `nested level ${level}`, 256);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENAMETOOLONG") {
				rmSync(dir, { recursive: true, force: true });
				return { built, hitPathLimit: true };
			}
			throw error;
		}
		built++;
	}
	return { built, hitPathLimit: false };
}

function chainDepth(nodes: readonly ContextTreeNode[]): number {
	return nodes.length === 0 ? 0 : 1 + chainDepth(nodes[0].children);
}

function totalNodes(nodes: readonly ContextTreeNode[]): number {
	return nodes.reduce((total, node) => total + 1 + totalNodes(node.children), 0);
}

let tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "context-tree-scan-"));
	tempDirs.push(dir);
	return dir;
}

/** One scan, budget and diagnostics through the public entry point. */
function scan(
	rlmDir: string | undefined,
	budget?: ContextTreeScanBudget,
	skipIds?: ReadonlySet<string>,
): ContextTreeScanResult {
	return contextTree.scanContextTreeChildrenFromDisk(rlmDir, resolveContextWindow, { budget, skipIds });
}

function expectDiagnostics(result: ContextTreeScanResult, expected: Partial<ContextTreeScanDiagnostics>): void {
	expect(result.diagnostics).toEqual(expect.objectContaining(expected));
}

/**
 * Depth: a `sub-*` dir pointing back at its own parent is nesting without
 * bound. The path grows one component per lap, so the filesystem is what
 * stopped the old recursive walk (macOS gives up resolving symlinks after 16
 * hops with ELOOP) and it stopped as a duplicated chain, with nothing said
 * about it. A JS stack overflow is not reachable from real disk content here:
 * `PATH_MAX` caps a chain of legal `sub-*` dir names at ~155 levels while V8
 * takes ~8800 plain frames, so nesting was bounded by the filesystem long
 * before it was bounded by the stack. The depth budget is what makes that bound
 * explicit, reported, and independent of how the walk is written.
 */
afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

describe("disk scan is bounded by depth", () => {
	/**
	 * A `sub-*` dir pointing back at its own parent: nesting without bound. The
	 * path grows by one component per lap, so the filesystem stops the old
	 * recursive walk (macOS turns this into ELOOP after 16 symlink hops) and it
	 * ended as a duplicated chain with nothing said about it.
	 */
	function cycleFixture(): string {
		const rlmDir = makeTempDir();
		const childDir = join(rlmDir, "sub-loop0001");
		writeSession(childDir, "loop-1", "loops forever", 512);
		symlinkSync(childDir, join(childDir, "sub-loop0002"));
		return rlmDir;
	}

	it("survives a nested sub-* dir cycle and reports the depth cut", () => {
		const rlmDir = cycleFixture();
		expect(() => contextTree.loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow)).not.toThrow();

		const result = scan(rlmDir, { maxDepth: 5 });
		expect(chainDepth(result.nodes)).toBe(5);
		expectDiagnostics(result, {
			scannedChildren: 5,
			depthLimitReached: true,
			truncated: true,
			truncatedReason: "depth",
			skippedByBudget: 1,
		});
	});

	it("stops a transcript chain deeper than the default depth limit", () => {
		const rlmDir = makeTempDir();
		const { built, hitPathLimit } = writeChain(rlmDir, 600);
		// Deep enough to be a nesting test, and bounded only by PATH_MAX.
		expect(hitPathLimit).toBe(true);
		expect(built).toBeGreaterThan(60);

		// The same entry point /context uses: the walk no longer mirrors the tree on
		// disk one node per level, whatever the caller asked for. 16 is the
		// documented default depth cap (DEFAULT_CONTEXT_TREE_SCAN_BUDGET).
		const nodes = contextTree.loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow);
		expect(chainDepth(nodes)).toBeLessThanOrEqual(16);

		const result = scan(rlmDir);
		expect(chainDepth(result.nodes)).toBe(contextTree.DEFAULT_CONTEXT_TREE_SCAN_BUDGET.maxDepth);
		expectDiagnostics(result, {
			scannedChildren: contextTree.DEFAULT_CONTEXT_TREE_SCAN_BUDGET.maxDepth,
			truncated: true,
			truncatedReason: "depth",
			depthLimitReached: true,
			skippedByBudget: 1,
		});
	});

	it("reads a deep chain to its end when the budget allows it", () => {
		const rlmDir = makeTempDir();
		const { built } = writeChain(rlmDir, 600);
		expect(built).toBeGreaterThan(60);

		// Traversal depth is no longer coupled to the JS stack: the same 60-level
		// budget that stops a runaway tree completes a deep but small one.
		const result = scan(rlmDir, { maxChildren: 10000, maxBytes: 100 * MIB, maxDepth: 10000 });
		expect(chainDepth(result.nodes)).toBe(built);
		expectDiagnostics(result, { scannedChildren: built, truncated: false, depthLimitReached: false });
	});
});

describe("scan budget", () => {
	it("caps the number of child sessions read and reports the ones it skipped", () => {
		const rlmDir = makeTempDir();
		const size = writeSiblings(rlmDir, 40, 16 * KIB);

		const result = scan(rlmDir, { maxChildren: 8 });
		expect(result.nodes).toHaveLength(8);
		expect(new Set(result.nodes.map((node) => node.id)).size).toBe(8);
		expect(totalNodes(result.nodes)).toBe(8);
		// A visible node is a fully folded session, not a stub.
		expect(result.nodes[0].totalUsage.input).toBe(1000);
		expect(result.nodes[0].contextUsage?.contextWindow).toBe(200000);
		expectDiagnostics(result, {
			scannedChildren: 8,
			bytesRead: 8 * size,
			bytesPlanned: 40 * size,
			skippedByBudget: 32,
			truncated: true,
			truncatedReason: "children",
			depthLimitReached: false,
		});
	});

	it("caps the bytes read and reports what a full scan would have needed", () => {
		const rlmDir = makeTempDir();
		const size = writeSiblings(rlmDir, 30, 16 * KIB);
		const maxBytes = 5 * size;

		const result = scan(rlmDir, { maxBytes });
		expect(result.nodes).toHaveLength(5);
		expectDiagnostics(result, {
			scannedChildren: 5,
			bytesRead: maxBytes,
			bytesPlanned: 30 * size,
			skippedByBudget: 25,
			truncated: true,
			truncatedReason: "bytes",
		});
	});

	it("cuts breadth first so the visible roster is the top-level fan-out", () => {
		const rlmDir = makeTempDir();
		for (let index = 0; index < 3; index++) {
			const name = `sub-parent${index}`;
			writeSession(join(rlmDir, name), `p${index}`, `parent ${index}`, KIB);
			for (let grand = 0; grand < 2; grand++) {
				writeSession(
					join(rlmDir, name, `sub-kid${index}${grand}`),
					`k${index}${grand}`,
					`kid ${index}${index}`,
					KIB,
				);
			}
		}

		// Three top-level children plus one grandchild are the four allowed reads;
		// the remaining five candidates are discovered and refused.
		const result = scan(rlmDir, { maxChildren: 4 });
		expect(result.nodes).toHaveLength(3);
		expect(result.nodes.map((node) => node.children.length)).toEqual([1, 0, 0]);
		expect(totalNodes(result.nodes)).toBe(4);
		expectDiagnostics(result, {
			scannedChildren: 4,
			skippedByBudget: 5,
			truncated: true,
			truncatedReason: "children",
		});
	});

	it("applies the budget to the subtree of a single child read from disk", () => {
		const rlmDir = makeTempDir();
		const childDir = join(rlmDir, "sub-parent1");
		writeSession(childDir, "parent-1", "parented", KIB);
		for (let index = 0; index < 6; index++) {
			writeSession(join(childDir, `sub-kid${index}`), `k${index}`, `kid ${index}`, KIB);
		}

		const node = contextTree.loadContextTreeChildFromDisk(childDir, resolveContextWindow, { maxChildren: 3 });
		expect(node?.label).toBe("parented");
		expect(node?.children).toHaveLength(3);
	});
});

describe("default behavior is unchanged", () => {
	it("scans an ordinary roster completely with the default budget", () => {
		const rlmDir = makeTempDir();
		writeSiblings(rlmDir, 40, 16 * KIB);

		const legacy = contextTree.loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow);
		expect(legacy).toHaveLength(40);

		const result = scan(rlmDir);
		expect(result.nodes).toEqual(legacy);
		expectDiagnostics(result, {
			scannedChildren: 40,
			skippedByBudget: 0,
			truncated: false,
			truncatedReason: undefined,
			depthLimitReached: false,
		});
	});

	it("scans a nested tree completely when it is within the default depth limit", () => {
		const rlmDir = makeTempDir();
		expect(writeChain(rlmDir, 16).built).toBe(16);

		const legacy = contextTree.loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow);
		expect(chainDepth(legacy)).toBe(16);
		expect(scan(rlmDir).nodes).toEqual(legacy);
	});

	it("truncates and reports a tree nested deeper than the default depth limit", () => {
		const rlmDir = makeTempDir();
		expect(writeChain(rlmDir, 17).built).toBe(17);

		const result = scan(rlmDir);
		expect(chainDepth(result.nodes)).toBe(contextTree.DEFAULT_CONTEXT_TREE_SCAN_BUDGET.maxDepth);
		expectDiagnostics(result, {
			truncated: true,
			truncatedReason: "depth",
			depthLimitReached: true,
			skippedByBudget: 1,
		});
	});

	it("honors skipIds and counts only read children", () => {
		const rlmDir = makeTempDir();
		writeSiblings(rlmDir, 6, KIB);

		const result = scan(rlmDir, undefined, new Set(["sub-0000", "sub-0001"]));
		expect(result.nodes.map((node) => node.id)).toEqual(["sub-0002", "sub-0003", "sub-0004", "sub-0005"]);
		expectDiagnostics(result, { scannedChildren: 4, skippedByBudget: 0, truncated: false });
	});

	it("returns no nodes and idle diagnostics for a missing or empty dir", () => {
		const missing = scan(join(makeTempDir(), "nope"));
		expect(missing.nodes).toEqual([]);
		expect(missing.diagnostics).toEqual({
			scannedChildren: 0,
			bytesRead: 0,
			bytesPlanned: 0,
			skippedByBudget: 0,
			depthLimitReached: false,
			truncated: false,
			truncatedReason: undefined,
		});
		expect(contextTree.loadContextTreeChildrenFromDisk(undefined, resolveContextWindow)).toEqual([]);
	});
});
