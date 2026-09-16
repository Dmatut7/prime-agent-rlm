import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRlmLedgerDirectory } from "../src/core/retention/ledger-scan.js";
import { rlmLedgerCompactionModule } from "../src/core/retention/rlm-ledger-compaction.js";
import type { RetentionClassContext, RetentionRoots } from "../src/core/retention/types.js";
import { projectRlmLedgerFile } from "../src/core/rlm-ledger-compaction.js";
import { canonicalSessionPath } from "../src/core/session-lease.js";
import { resolveRetentionSettings } from "../src/core/settings-manager.js";
import {
	RLM_LEDGER_MAX_BYTES,
	RLM_LEDGER_MAX_RECORDS,
	type RlmLedgerEdge,
	RlmLedgerOverBoundError,
	RlmSpawnLedger,
	tombstoneSavedSessionDelete,
} from "../src/modes/daemon/rlm-ledger.js";

/** One spawn line for a child session file that lives in `<root>/sub-<id>/<id>.jsonl`. */
function spawnLine(childId: string, child: string, parent: string, name: string, depth = 1): string {
	return `${JSON.stringify({ v: 1, op: "spawn", at: "2026-01-01T00:00:00.000Z", childId, parent, child, depth, name })}\n`;
}

function renameLine(childId: string, child: string, name: string): string {
	return `${JSON.stringify({ v: 1, op: "rename", at: "2026-01-01T00:00:00.000Z", childId, child, name })}\n`;
}

function deleteLine(childId: string, child: string, reason = "user"): string {
	return `${JSON.stringify({ v: 1, op: "delete", at: "2026-01-01T00:00:00.000Z", childId, child, reason })}\n`;
}

function metaLine(sessionsDir: string): string {
	return `${JSON.stringify({ v: 1, op: "meta", at: "2026-01-01T00:00:00.000Z", sessionsDir })}\n`;
}

/** Deterministic PRNG so the equivalence fixture is reproducible. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

/** A child session file inside its own `sub-*` directory (the shape the death predicate probes). */
function makeChild(root: string, childId: string): string {
	const dir = join(root, `sub-${childId}`);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${childId}.jsonl`);
	writeFileSync(file, "");
	return file;
}

/** The six fields the equivalence assertion is about, keyed by childId+child. */
function edgeFingerprint(edges: RlmLedgerEdge[]): Map<string, string> {
	return new Map(
		edges.map((edge) => [
			`${edge.childId}\u0000${canonicalSessionPath(edge.child)}`,
			[edge.childId, edge.parent, edge.child, edge.depth, edge.name, edge.deleted ?? ""].join("|"),
		]),
	);
}

function familyFingerprint(rows: Awaited<ReturnType<RlmSpawnLedger["family"]>>): string[] {
	return rows.map((row) => [row.path, row.rlmDepth, row.parentSessionPath ?? "", row.name ?? "", row.id].join("|"));
}

function ledgerContext(root: string, overrides: Partial<RetentionClassContext> = {}): RetentionClassContext {
	const roots: RetentionRoots = {
		agentDir: root,
		sessionsDir: join(root, "sessions"),
		artifactRoot: join(root, "session-artifacts"),
		logsDir: join(root, "logs"),
		tmpDir: join(root, "tmp"),
		leasesRoot: join(root, "session-leases"),
		retentionDir: join(root, "retention"),
	};
	mkdirSync(roots.sessionsDir, { recursive: true });
	return {
		settings: resolveRetentionSettings({}),
		roots,
		now: Date.now(),
		dryRun: false,
		budget: { remainingBytes: 512 * 1024 * 1024, remainingEntries: 20000, capped: false },
		live: {},
		log: () => {},
		...overrides,
	};
}

describe("rlm ledger reader alignment (retention scan)", () => {
	it("reports scanned:false for a ledger file over the byte bound", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-ledger-scan-bytes-"));
		try {
			const ledgerDir = join(root, "rlm-ledger");
			mkdirSync(ledgerDir, { recursive: true });
			writeFileSync(join(ledgerDir, "aaaaaaaaaaaaaaaa.jsonl"), Buffer.alloc(RLM_LEDGER_MAX_BYTES + 1, 0x0a));
			const scan = scanRlmLedgerDirectory(ledgerDir);
			expect(scan.scanned).toBe(false);
			expect(scan.liveChildIds.size).toBe(0);
			expect(scan.deletedChildIds.size).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports scanned:false for a ledger file over the record bound", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-ledger-scan-records-"));
		try {
			const ledgerDir = join(root, "rlm-ledger");
			mkdirSync(ledgerDir, { recursive: true });
			const line = renameLine("sub-11111111", join(root, "c.jsonl"), "n");
			writeFileSync(join(ledgerDir, "bbbbbbbbbbbbbbbb.jsonl"), line.repeat(RLM_LEDGER_MAX_RECORDS + 1));
			const scan = scanRlmLedgerDirectory(ledgerDir);
			expect(scan.scanned).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not consume a v:2 record as a deletion", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-ledger-scan-v2-"));
		try {
			const ledgerDir = join(root, "rlm-ledger");
			mkdirSync(ledgerDir, { recursive: true });
			const child = join(root, "sub-11111111", "11111111.jsonl");
			const parent = join(root, "p.jsonl");
			const futureDelete = `${JSON.stringify({
				v: 2,
				op: "delete",
				at: "2026-01-01T00:00:00.000Z",
				childId: "sub-11111111",
				child,
				reason: "user",
			})}\n`;
			writeFileSync(
				join(ledgerDir, "cccccccccccccccc.jsonl"),
				metaLine(root) + spawnLine("sub-11111111", child, parent, "worker") + futureDelete,
			);
			const scan = scanRlmLedgerDirectory(ledgerDir);
			// Positive control: the v:1 spawn is read, so the gate below is not
			// passing because nothing was parsed at all.
			expect(scan.scanned).toBe(true);
			expect([...scan.liveChildIds]).toEqual(["11111111"]);
			expect(scan.deletedChildIds.has("11111111")).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("rlm ledger append ladder", () => {
	it("compacts an over-bound ledger instead of failing the append closed", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-ledger-ladder-"));
		try {
			const sessionsDir = join(root, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const ledger = new RlmSpawnLedger(root, sessionsDir);
			mkdirSync(dirname(ledger.ledgerPath), { recursive: true });
			const parent = join(sessionsDir, "p.jsonl");
			writeFileSync(parent, "");
			// ~3000 keys, each one spawn plus 29 renames with a padded name: the
			// file crosses the byte bound while staying under the record bound,
			// and every record but the last rename per key is replay-invisible.
			const pad = "x".repeat(300);
			let payload = metaLine(canonicalSessionPath(sessionsDir));
			const keys = 3000;
			for (let index = 0; index < keys; index++) {
				const childId = `sub-${String(index).padStart(8, "0")}`;
				const child = join(root, childId, `${childId}.jsonl`);
				payload += spawnLine(childId, child, parent, `worker-${index}-${pad}`);
				for (let rename = 0; rename < 29; rename++) {
					payload += renameLine(childId, child, `worker-${index}-${rename}-${pad}`);
				}
			}
			writeFileSync(ledger.ledgerPath, payload);
			const before = statSync(ledger.ledgerPath).size;
			expect(before).toBeGreaterThan(RLM_LEDGER_MAX_BYTES);

			// A brand-new spawn is the record the ladder has to make room for
			// (a delete without a spawn is a replay no-op, so it proves nothing).
			await ledger.appendSpawn({
				childId: "sub-newchild",
				parent,
				child: join(root, "sub-newchild", "new.jsonl"),
				depth: 1,
				name: "fresh-worker",
			});

			const after = statSync(ledger.ledgerPath).size;
			expect(after).toBeLessThan(before);
			expect(after).toBeLessThanOrEqual(RLM_LEDGER_MAX_BYTES);
			const edges = await ledger.edges(true);
			expect(edges).toHaveLength(keys + 1);
			expect(edges.find((edge) => edge.childId === "sub-newchild")?.name).toBe("fresh-worker");
			expect(edges.find((edge) => edge.childId === "sub-00000000")?.name).toBe(`worker-0-28-${pad}`);
			expect(existsSync(ledger.ledgerPath)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps reading a ledger the retention scan refuses to scan", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-ledger-scan-readable-"));
		try {
			const ledgerDir = join(root, "rlm-ledger");
			mkdirSync(ledgerDir, { recursive: true });
			const child = join(root, "sub-11111111", "11111111.jsonl");
			writeFileSync(
				join(ledgerDir, "dddddddddddddddd.jsonl"),
				metaLine(root) +
					spawnLine("sub-11111111", child, join(root, "p.jsonl"), "worker") +
					deleteLine("sub-11111111", child),
			);
			const scan = scanRlmLedgerDirectory(ledgerDir);
			expect(scan.scanned).toBe(true);
			expect([...scan.deletedChildIds]).toEqual(["11111111"]);
			expect(scan.liveChildIds.size).toBe(0);
			expect(readFileSync(join(ledgerDir, "dddddddddddddddd.jsonl"), "utf8").split("\n").length).toBeGreaterThan(3);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("rlm ledger equivalence compaction", () => {
	it("is replay-equivalent for a random interleaving of spawn, rename and delete", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-ledger-equivalence-"));
		try {
			const sessionsDir = join(root, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const parent = join(sessionsDir, "p.jsonl");
			writeFileSync(parent, "");
			const ledger = new RlmSpawnLedger(root, sessionsDir);
			const random = mulberry32(20260916);
			const children: Array<{ childId: string; child: string; name: string }> = [];
			for (let index = 0; index < 40; index++) {
				const childId = `sub-${String(index).padStart(8, "0")}`;
				const child = makeChild(root, childId);
				children.push({ childId, child, name: `worker-${index}` });
				await ledger.appendSpawn({ childId, parent, child, depth: 1, name: `worker-${index}` });
			}
			// 240 interleaved overwrites: renames rewrite an existing edge, deletes
			// tombstone one, and a re-spawn of a deleted key revives it. Every one
			// of these is replay-invisible once a later record supersedes it.
			for (let step = 0; step < 240; step++) {
				const pick = children[Math.floor(random() * children.length)];
				if (!pick) continue;
				const roll = random();
				if (roll < 0.55) {
					const name = `worker-${step}`;
					await ledger.appendRename({ childId: pick.childId, child: pick.child, name });
					pick.name = name;
				} else if (roll < 0.8) {
					await ledger.appendDelete({ childId: pick.childId, child: pick.child, reason: "user" });
				} else {
					await ledger.appendSpawn({
						childId: pick.childId,
						parent,
						child: pick.child,
						depth: 1,
						name: pick.name,
					});
				}
			}
			const beforeBytes = statSync(ledger.ledgerPath).size;
			const beforeRecords = readFileSync(ledger.ledgerPath, "utf8").trim().split("\n").length;
			const preRaw = edgeFingerprint(await ledger.edges(true));
			const preLive = edgeFingerprint(await ledger.edges());
			const preFamily = familyFingerprint(await ledger.family());
			expect(preRaw.size).toBeGreaterThan(0);
			expect(beforeRecords).toBeGreaterThan(100);

			// The compaction rung: a second writer instance whose bounds the current
			// file exceeds, appending a record that changes nothing observable (the
			// rename restates the edge's current name).
			const probe = children.find((candidate) =>
				preLive.has(`${candidate.childId}\u0000${canonicalSessionPath(candidate.child)}`),
			);
			expect(probe).toBeDefined();
			const small = new RlmSpawnLedger(root, sessionsDir, undefined, () => {}, {
				maxRecords: 100,
				maxBytes: 1024 * 1024,
			});
			await small.appendRename({
				childId: probe?.childId ?? "",
				child: probe?.child ?? "",
				name: probe?.name ?? "",
			});

			const afterBytes = statSync(ledger.ledgerPath).size;
			expect(afterBytes).toBeLessThan(beforeBytes);
			const postRaw = edgeFingerprint(await ledger.edges(true));
			const postLive = edgeFingerprint(await ledger.edges());
			// The mechanical equivalence claim: identical key sets, identical
			// six-tuples, identical live view, identical family rows.
			expect([...postRaw.keys()].sort()).toEqual([...preRaw.keys()].sort());
			expect([...postRaw.values()].sort()).toEqual([...preRaw.values()].sort());
			expect([...postLive.entries()].sort()).toEqual([...preLive.entries()].sort());
			expect(familyFingerprint(await ledger.family())).toEqual(preFamily);
			// The compaction left no side files behind.
			expect(readdirSync(dirname(ledger.ledgerPath)).filter((name) => name !== basename(ledger.ledgerPath))).toEqual(
				[],
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a tombstone whose child directory still exists and retires one whose directory is gone", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-ledger-death-"));
		try {
			const sessionsDir = join(root, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const parent = join(sessionsDir, "p.jsonl");
			writeFileSync(parent, "");
			const keptChild = makeChild(root, "sub-kept0001");
			const goneChild = makeChild(root, "sub-gone0001");
			const liveChild = makeChild(root, "sub-live0001");
			const ledger = new RlmSpawnLedger(root, sessionsDir);
			for (const [childId, child] of [
				["sub-kept0001", keptChild],
				["sub-gone0001", goneChild],
				["sub-live0001", liveChild],
			]) {
				await ledger.appendSpawn({ childId, parent, child, depth: 1, name: childId });
			}
			await ledger.appendDelete({ childId: "sub-kept0001", child: keptChild, reason: "user" });
			await ledger.appendDelete({ childId: "sub-gone0001", child: goneChild, reason: "parent-teardown" });
			// The deleted child's directory is removed with its artifact tree: the
			// read-side reconciliation already drops that edge from every live view.
			rmSync(dirname(goneChild), { recursive: true, force: true });

			const preLive = edgeFingerprint(await ledger.edges());
			const preRaw = edgeFingerprint(await ledger.edges(true));
			const preAlive = edgeFingerprint(await ledger.liveEdges());
			expect(preRaw.size).toBe(3);

			// Terminal set is meta + one live spawn + one kept spawn/delete pair =
			// 4 records, so the bound has to leave room for the pending record too
			// (that is the write rung; the read rung still accepts 4 records).
			const small = new RlmSpawnLedger(root, sessionsDir, undefined, () => {}, {
				maxRecords: 5,
				maxBytes: 1024 * 1024,
			});
			await small.appendRename({ childId: "sub-live0001", child: liveChild, name: "sub-live0001" });

			const postRaw = edgeFingerprint(await ledger.edges(true));
			// The retired tombstone is gone from the raw view too; the kept one
			// survived with its child path intact (a delete retry still knows what
			// to sweep), and both live views are unchanged.
			expect(postRaw.has(`sub-gone0001\u0000${canonicalSessionPath(goneChild)}`)).toBe(false);
			expect(postRaw.get(`sub-kept0001\u0000${canonicalSessionPath(keptChild)}`)).toBe(
				preRaw.get(`sub-kept0001\u0000${canonicalSessionPath(keptChild)}`),
			);
			expect(edgeFingerprint(await ledger.edges())).toEqual(preLive);
			expect(edgeFingerprint(await ledger.liveEdges())).toEqual(preAlive);

			// Consumer 1 (raw view): tombstoning the surviving live child still works
			// after the rewrite, and re-tombstoning an already deleted child is a
			// no-op rather than a duplicate record.
			const linesBefore = readFileSync(ledger.ledgerPath, "utf8").trim().split("\n").length;
			const second = await tombstoneSavedSessionDelete(ledger, keptChild, { runtimeKind: "subagent" });
			expect(second.ledgerEdge).toBeUndefined();
			expect(readFileSync(ledger.ledgerPath, "utf8").trim().split("\n").length).toBe(linesBefore);
			const third = await tombstoneSavedSessionDelete(ledger, liveChild, { runtimeKind: "subagent" });
			expect(third.ledgerEdge?.childId).toBe("sub-live0001");
			const raw = await ledger.edges(true);
			expect(raw.find((edge) => edge.childId === "sub-live0001")?.deleted).toBe("user");
			// Consumer 2 (delete retry): the tombstone the retry sweeps from still
			// names the child session file, and compaction touched no artifact.
			const retried = raw.find((edge) => edge.childId === "sub-kept0001");
			expect(retried?.deleted).toBe("user");
			expect(canonicalSessionPath(retried?.child ?? "")).toBe(canonicalSessionPath(keptChild));
			expect(existsSync(keptChild)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses the append with a typed error when the terminal record set itself is over bound", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-ledger-gate-"));
		try {
			const sessionsDir = join(root, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const parent = join(sessionsDir, "p.jsonl");
			writeFileSync(parent, "");
			const ledger = new RlmSpawnLedger(root, sessionsDir);
			const children: string[] = [];
			for (const childId of ["sub-gate0001", "sub-gate0002", "sub-gate0003"]) {
				const child = makeChild(root, childId);
				children.push(child);
				await ledger.appendSpawn({ childId, parent, child, depth: 1, name: childId });
			}
			// meta + 3 terminal spawns = 4 records: the read bound still accepts
			// the file, but one more record does not fit. Write bound and read
			// bound are separate rungs.
			const tight = new RlmSpawnLedger(root, sessionsDir, undefined, () => {}, { maxRecords: 4 });
			let caught: unknown;
			try {
				await tight.appendRename({ childId: "sub-gate0001", child: children[0] ?? "", name: "renamed" });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(RlmLedgerOverBoundError);
			const overBound = caught as RlmLedgerOverBoundError;
			expect(overBound.liveEdges).toBe(3);
			expect(overBound.bounds.maxRecords).toBe(4);
			expect(overBound.message).toContain("3 live edge(s)");
			expect(overBound.message).toContain("retention sweep");
			// Nothing was lost: the compaction published the terminal set, the read
			// side still answers from both instances.
			expect(readFileSync(ledger.ledgerPath, "utf8").trim().split("\n")).toHaveLength(4);
			expect(await ledger.edges()).toHaveLength(3);
			expect(await tight.edges(true)).toHaveLength(3);
			// The delete path a daemon wraps propagates the typed error instead of
			// an anonymous "refusing to read".
			await expect(
				tombstoneSavedSessionDelete(tight, children[1] ?? "", { runtimeKind: "subagent" }),
			).rejects.toBeInstanceOf(RlmLedgerOverBoundError);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("retention class rlm-ledger-compaction", () => {
	it("compacts an over-bound ledger file the sweep finds and reports the reduction", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-ledger-sweep-class-"));
		try {
			const ledgerDir = join(root, "rlm-ledger");
			mkdirSync(ledgerDir, { recursive: true });
			const path = join(ledgerDir, "eeeeeeeeeeeeeeee.jsonl");
			const line = renameLine("sub-11111111", join(root, "c.jsonl"), "n");
			writeFileSync(path, line.repeat(RLM_LEDGER_MAX_RECORDS + 1));
			expect(projectRlmLedgerFile(path).overBound).toBe(true);

			const result = await rlmLedgerCompactionModule.scanAndReclaim(ledgerContext(root));
			expect(result.class).toBe("rlm-ledger-compaction");
			expect(result.disabled).toBe(false);
			expect(result.scanned).toBe(1);
			// Every one of the 100_001 rename records is superseded (a rename
			// without a spawn reduces to nothing); the meta line is all that stays.
			expect(result.reclaimed).toBe(RLM_LEDGER_MAX_RECORDS);
			expect(result.bytes).toBeGreaterThan(0);
			expect(result.capped).toBe(false);
			expect(projectRlmLedgerFile(path).overBound).toBe(false);
			// The rewrite is replay-equivalent: every record was a rename without a
			// spawn, so the terminal set is the meta line alone.
			expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports disabled when the compaction switch is off and predicts under a dry run", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-ledger-sweep-off-"));
		try {
			const ledgerDir = join(root, "rlm-ledger");
			mkdirSync(ledgerDir, { recursive: true });
			const path = join(ledgerDir, "ffffffffffffffff.jsonl");
			const line = renameLine("sub-11111111", join(root, "c.jsonl"), "n");
			writeFileSync(path, line.repeat(RLM_LEDGER_MAX_RECORDS + 1));
			const before = statSync(path).size;

			const off = await rlmLedgerCompactionModule.scanAndReclaim(
				ledgerContext(root, {
					settings: resolveRetentionSettings({ ledgerCompactionEnabled: false }),
				}),
			);
			expect(off.disabled).toBe(true);
			expect(off.scanned).toBe(0);
			expect(statSync(path).size).toBe(before);

			const predicted = await rlmLedgerCompactionModule.scanAndReclaim(ledgerContext(root, { dryRun: true }));
			expect(predicted.disabled).toBe(false);
			expect(predicted.scanned).toBe(1);
			expect(predicted.reclaimed).toBe(0);
			expect(predicted.skipped.map((entry) => entry.reason)).toEqual(["reference:dry-run"]);
			expect(statSync(path).size).toBe(before);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
