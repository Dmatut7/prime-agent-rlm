import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	ContextTreeDiskScanCache,
	type ContextTreeNode,
	loadContextTreeChildFromDisk,
	loadContextTreeChildrenFromDisk,
	scanContextTreeChildrenFromDisk,
} from "../src/core/context-tree.js";

/**
 * Which file a disk scan reads, and which files its cache fingerprint watches.
 *
 * Both pins came from the same real shape: an RLM child flushes `semantic-edges.jsonl`
 * into its own session dir when it finishes, next to the transcript it had been appending
 * to, usually inside the same millisecond. A `sub-*` dir therefore holds two `.jsonl`
 * files, one of which is not a session at all, and the two selectors that used to pick
 * between them disagreed:
 *
 * - the walk picked the newest by suffix, so an edges flush over the transcript made it
 *   fold 30 KB of edges into `undefined`: the child left `/context` and its spend left the
 *   top bar, while `scannedChildren` had already charged for the read (60 of 2374 dirs in
 *   the measured corpus);
 * - the fingerprint picked the newest by a *finer* key, so it could be watching the edges
 *   file while the walk read the transcript: an append to the transcript then left the
 *   fingerprint untouched and the reuse served the previous refresh's money (48 of 2374).
 *
 * Every pin here names the mutation that turns it red, and each was mutated once and
 * restored byte-for-byte (see EVIDENCE).
 */

const resolveContextWindow = () => 200_000;
const model = { provider: "anthropic", id: "claude-sonnet-4-5" };

function usage(cost: number): Usage {
	return {
		input: 1000,
		output: 100,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function sessionHeader(id: string): string {
	return JSON.stringify({
		type: "session",
		version: 3,
		id,
		timestamp: new Date().toISOString(),
		cwd: process.cwd(),
	});
}

/** One user turn and the assistant answer that carries `cost` and the model. */
function turn(id: string, parentId: string | null, cost: number, text: string): string {
	const stamp = new Date().toISOString();
	return [
		JSON.stringify({
			type: "message",
			id,
			parentId,
			timestamp: stamp,
			message: { role: "user", content: text, timestamp: Date.now() },
		}),
		JSON.stringify({
			type: "message",
			id: `a-${id}`,
			parentId: id,
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "anthropic-messages",
				provider: model.provider,
				model: model.id,
				usage: usage(cost),
				stopReason: "stop",
				timestamp: Date.now(),
			},
		}),
	].join("\n");
}

/** The model a disk node reports comes from a `model_change` entry on the branch it sits on. */
function modelChange(): string {
	return JSON.stringify({
		type: "model_change",
		id: "m1",
		parentId: null,
		timestamp: new Date().toISOString(),
		provider: model.provider,
		modelId: model.id,
	});
}

function transcript(id: string, cost: number, text = "child task"): string {
	return `${sessionHeader(id)}\n${modelChange()}\n${turn("u1", "m1", cost, text)}\n`;
}

/** The next turn on the same branch, so an append keeps the label and grows the spend. */
function followUp(afterAssistantId: string, id: string, cost: number, text: string): string {
	return `${turn(id, afterAssistantId, cost, text)}\n`;
}

/**
 * The sibling a child's teardown flushes: valid JSONL, one record per line, and not a
 * session - its first line is the registration record the edge writer starts with.
 */
function semanticEdges(sessionId: string, edges = 2): string {
	const lines = [JSON.stringify({ type: "session_registered", sessionId, at: new Date().toISOString() })];
	for (let index = 0; index < edges; index++) {
		lines.push(
			JSON.stringify({
				type: "edge",
				sessionId,
				from: `n${index}`,
				to: `n${index + 1}`,
				kind: "causal",
				weight: 0.5,
				pad: "x".repeat(200),
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

let tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "context-tree-selection-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

/** A child dir holding a transcript that folds to `cost`, and nothing else. */
function writeChild(root: string, name: string, cost: number, text = "child task"): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "session.jsonl"), transcript(name, cost, text));
	return dir;
}

/** Pin one file's mtime, in seconds with the fraction the filesystem keeps. */
function pinFile(path: string, seconds: number): void {
	utimesSync(path, seconds, seconds);
}

function totalCost(nodes: ContextTreeNode[]): number {
	return nodes.reduce((sum, node) => sum + node.ownUsage.cost.total, 0);
}

describe("which file a disk scan reads", () => {
	it("folds the transcript when an edges flush is newer than it", () => {
		const root = makeTempDir();
		const child = writeChild(root, "sub-aaaa1111", 0.7, "ship the roster");
		const edges = join(child, "semantic-edges.jsonl");
		writeFileSync(edges, semanticEdges("sub-aaaa1111"));
		// The teardown order that broke it: the transcript was appended first, the edge file
		// landed after, so the newest `.jsonl` in the dir is the one that is not a session.
		pinFile(join(child, "session.jsonl"), 1_700_000_001);
		pinFile(edges, 1_700_000_002);
		expect(statSync(edges).mtimeMs).toBeGreaterThan(statSync(join(child, "session.jsonl")).mtimeMs);

		const node = loadContextTreeChildFromDisk(child, resolveContextWindow);
		// Not undefined: the transcript is still there, and it is what the child's row is made of.
		expect(node, "an edges sibling must not hide the transcript it was flushed over").toBeDefined();
		expect(node?.id).toBe("sub-aaaa1111");
		expect(node?.label).toBe("ship the roster");
		expect(node?.model).toEqual(model);
		expect(node?.ownUsage.cost.total).toBeCloseTo(0.7, 5);

		// End to end: the child is on the roster, and the scan's own accounting says it read
		// exactly one transcript to get it.
		const scanned = scanContextTreeChildrenFromDisk(root, resolveContextWindow);
		expect(scanned.nodes.map((entry) => entry.id)).toEqual(["sub-aaaa1111"]);
		expect(totalCost(scanned.nodes)).toBeCloseTo(0.7, 5);
		expect(scanned.diagnostics.scannedChildren).toBe(1);
		// Mutation: selecting candidates on the `.jsonl` suffix alone folds the edge file and
		// reads undefined here, an empty roster below, and 0 spent on the top bar.
	});

	it("tries the next candidate when the newest one is not a session, and charges one read", () => {
		const root = makeTempDir();
		const child = writeChild(root, "sub-aaaa1111", 0.3);
		// Two non-sessions stacked over the transcript: the walk has to pass both.
		writeFileSync(join(child, "semantic-edges.jsonl"), semanticEdges("sub-aaaa1111"));
		writeFileSync(join(child, "zzz-later.jsonl"), `${JSON.stringify({ type: "index", version: 1 })}\n`);
		pinFile(join(child, "session.jsonl"), 1_700_000_001);
		pinFile(join(child, "semantic-edges.jsonl"), 1_700_000_002);
		pinFile(join(child, "zzz-later.jsonl"), 1_700_000_003);

		const scanned = scanContextTreeChildrenFromDisk(root, resolveContextWindow);
		expect(scanned.nodes.map((entry) => entry.id)).toEqual(["sub-aaaa1111"]);
		expect(totalCost(scanned.nodes)).toBeCloseTo(0.3, 5);
		// One child read, and the bytes charged are the transcript's, not the two decoys'.
		expect(scanned.diagnostics.scannedChildren).toBe(1);
		expect(scanned.diagnostics.bytesRead).toBe(statSync(join(child, "session.jsonl")).size);
		// Mutation: suffix-only selection reads `zzz-later.jsonl`, so the roster is empty and
		// bytesRead is the decoy's size.
	});

	it("leaves an ambiguous dir with no transcript in it out of the roster and out of the bill", () => {
		const root = makeTempDir();
		const child = join(root, "sub-bbbb2222");
		mkdirSync(child, { recursive: true });
		// Two `.jsonl`, neither a session: the dir is ambiguous, so it is pre-read, and the
		// walk finds nothing it could fold.
		writeFileSync(join(child, "semantic-edges.jsonl"), semanticEdges("sub-bbbb2222"));
		writeFileSync(join(child, "zzz-index.jsonl"), `${JSON.stringify({ type: "index", version: 1 })}\n`);

		expect(loadContextTreeChildFromDisk(child, resolveContextWindow)).toBeUndefined();
		const scanned = scanContextTreeChildrenFromDisk(root, resolveContextWindow);
		expect(scanned.nodes).toEqual([]);
		// No transcript, no read, no budget: the old walk opened and folded one of these files
		// and charged `scannedChildren` for a node it could never produce.
		expect(scanned.diagnostics.scannedChildren).toBe(0);
		expect(scanned.diagnostics.bytesRead).toBe(0);
		expect(scanned.diagnostics.skippedByBudget).toBe(0);
		// Mutation: suffix-only selection reads the newest of the two, so scannedChildren is 1
		// and bytesRead is its size, for the same empty roster.
	});

	it("folds a single-candidate dir without pre-reading it, and bills what it opens", () => {
		const root = makeTempDir();
		const child = join(root, "sub-cccc3333");
		mkdirSync(child, { recursive: true });
		const only = join(child, "semantic-edges.jsonl");
		writeFileSync(only, semanticEdges("sub-cccc3333"));

		// One `.jsonl` is one candidate, so there is nothing to choose between and the selection
		// does not open it: the fold does, and an edge file folds to no branch. The roster is
		// what the pre-read would have produced - no phantom child - and the read the fold made
		// is still on the bill, exactly as it was before the header check existed. This is the
		// pin that dies if the single-candidate branch is ever removed: the roster stays empty
		// either way, but the bill does not.
		expect(loadContextTreeChildFromDisk(child, resolveContextWindow)).toBeUndefined();
		const scanned = scanContextTreeChildrenFromDisk(root, resolveContextWindow);
		expect(scanned.nodes).toEqual([]);
		expect(scanned.diagnostics.scannedChildren).toBe(1);
		expect(scanned.diagnostics.bytesRead).toBe(statSync(only).size);
		// Mutation: pre-reading single-candidate dirs too (deleting the `candidates.length === 1`
		// branch) rejects this file before the fold, so scannedChildren reads 0 and bytesRead 0.
	});
});

describe("what the reuse fingerprint watches", () => {
	it("invalidates when the transcript moves inside the millisecond an edges flush owns", () => {
		const root = makeTempDir();
		const child = writeChild(root, "sub-aaaa1111", 0.1);
		const session = join(child, "session.jsonl");
		const edges = join(child, "semantic-edges.jsonl");
		writeFileSync(edges, semanticEdges("sub-aaaa1111"));
		// The measured shape: one millisecond, two files, the edge file last inside it. The
		// ms-rounded comparator the walk orders by ties; the full-precision `mtimeMs` the
		// fingerprint used to record separates - which is how the two picked different files.
		const base = 1_700_000_000;
		pinFile(session, base + 0.9411);
		pinFile(edges, base + 0.9414);
		expect(statSync(session).mtime.getTime()).toBe(statSync(edges).mtime.getTime());
		expect(statSync(edges).mtimeMs).toBeGreaterThan(statSync(session).mtimeMs);

		const cache = new ContextTreeDiskScanCache({ busyCooldownMs: 0 });
		expect(
			totalCost(loadContextTreeChildrenFromDisk(root, resolveContextWindow, undefined, undefined, cache)),
		).toBeCloseTo(0.1, 5);
		// Positive control: with nothing moving, the second scan really is served from cache.
		const hitsBefore = cache.stats.subtreeHits;
		expect(
			totalCost(loadContextTreeChildrenFromDisk(root, resolveContextWindow, undefined, undefined, cache)),
		).toBeCloseTo(0.1, 5);
		expect(cache.stats.subtreeHits).toBeGreaterThan(hitsBefore);

		// The child appends one more paid turn. The flush that owns the newer mtime is not
		// part of this change: the transcript moved and stayed the older file.
		appendFileSync(session, followUp("a-u1", "u2", 0.4, "and the follow-up"));
		pinFile(session, base + 0.9411);
		const missesBefore = cache.stats.subtreeMisses;
		const third = loadContextTreeChildrenFromDisk(root, resolveContextWindow, undefined, undefined, cache);
		expect(totalCost(third)).toBeCloseTo(0.5, 5);
		expect(cache.stats.subtreeMisses).toBeGreaterThan(missesBefore);
		expect(third[0].label).toBe("child task");
		// Mutation: recording only the newest `.jsonl` in the dir leaves the fingerprint on
		// the edge file, which did not move, so the third scan is a hit and still reports 0.1
		// - the previous refresh's money, on the tray, after the child was paid again.
	});

	it("invalidates when a sibling the walk never reads is rewritten, and re-reads the same answer", () => {
		const root = makeTempDir();
		const child = writeChild(root, "sub-aaaa1111", 0.25);
		const edges = join(child, "semantic-edges.jsonl");
		writeFileSync(edges, semanticEdges("sub-aaaa1111"));
		// The transcript is the newest file here, so a fingerprint that records only the newest
		// `.jsonl` watches the transcript and sees nothing when the *edges* move: this pin is
		// red under that mutation, which the same-ms pin above is not.
		pinFile(join(child, "session.jsonl"), 1_700_000_009);
		pinFile(edges, 1_700_000_001);

		const cache = new ContextTreeDiskScanCache({ busyCooldownMs: 0 });
		const scanOnce = (): ContextTreeNode[] =>
			loadContextTreeChildrenFromDisk(root, resolveContextWindow, undefined, undefined, cache);
		expect(totalCost(scanOnce())).toBeCloseTo(0.25, 5);
		const hitsBefore = cache.stats.subtreeHits;
		expect(totalCost(scanOnce())).toBeCloseTo(0.25, 5);
		expect(cache.stats.subtreeHits).toBeGreaterThan(hitsBefore);

		// Only the edge file moves. This is the over-invalidation the fix buys on purpose: a
		// file no walk reads still costs one re-read, because deciding whether it is one is
		// an open, and the fingerprint is stat-only. The answer does not change.
		writeFileSync(edges, semanticEdges("sub-aaaa1111", 9));
		pinFile(edges, 1_700_000_002);
		const missesBefore = cache.stats.subtreeMisses;
		expect(totalCost(scanOnce())).toBeCloseTo(0.25, 5);
		expect(cache.stats.subtreeMisses).toBeGreaterThan(missesBefore);
		// Mutation: fingerprinting only the newest `.jsonl` - the transcript here, which did not
		// move - turns this into a hit and the assertion above red. That is the cheap direction
		// of the same mistake the stale-money pin makes: the fingerprint watches one file, and
		// the walk's answer depends on more than one.
		expect(cache.subtreeEntries).toBeGreaterThan(0);
	});
});
