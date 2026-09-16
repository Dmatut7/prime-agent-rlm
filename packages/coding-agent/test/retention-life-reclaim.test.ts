import type { Dirent } from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { retentionRoots } from "../src/core/retention/reports.js";
import { runRetentionSweep } from "../src/core/retention/sweep.js";
import type { RetentionRoots, RetentionSweepReport } from "../src/core/retention/types.js";
import { resetSessionArtifactTombstoneCache } from "../src/core/session-artifact-tombstones.js";
import { resolveRetentionSettings } from "../src/core/settings-manager.js";

// r38 LIFE-2: the only reclaimer of deleted sub-agent transcripts shipped with
// `childTranscriptDays = 0` (disabled), and the residue class demanded deletion
// evidence it refused to derive, leaving a permanent dead zone. These tests pin
// the new defaults and the new dead-zone judgement.

const DAY_MS = 86_400_000;
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	resetSessionArtifactTombstoneCache();
});

interface Fixture {
	root: string;
	agentDir: string;
	roots: RetentionRoots;
	artifactRoot: string;
}

function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "retention-life-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const tmpDir = join(root, "tmp");
	for (const dir of [
		agentDir,
		tmpDir,
		join(agentDir, "sessions"),
		join(agentDir, "session-artifacts"),
		join(agentDir, "logs"),
		join(agentDir, "session-leases"),
		join(agentDir, "rlm-ledger"),
	]) {
		mkdirSync(dir, { recursive: true });
	}
	const retentionRootsValue: RetentionRoots = {
		...retentionRoots({ agentDir }),
		tmpDir,
		kernelVenvBase: join(root, "kernel-venv"),
	};
	return { root, agentDir, roots: retentionRootsValue, artifactRoot: retentionRootsValue.artifactRoot };
}

/** Age a whole subtree: the sweep judges a directory by its newest mtime. */
function ageTree(path: string, ageMs: number): void {
	const when = new Date(Date.now() - ageMs);
	const walk = (current: string): void => {
		let entries: Dirent[] = [];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			entries = [];
		}
		for (const entry of entries) {
			if (entry.isDirectory()) walk(join(current, entry.name));
			else {
				try {
					utimesSync(join(current, entry.name), when, when);
				} catch {
					// A file whose mtime cannot be set keeps its own timestamp.
				}
			}
		}
		try {
			utimesSync(current, when, when);
		} catch {
			// A path whose mtime cannot be set is judged by its contents instead.
		}
	};
	walk(path);
}

function sessionFile(agentDir: string, id: string): string {
	const path = join(agentDir, "sessions", `${id}.jsonl`);
	writeFileSync(path, '{"type":"session"}\n');
	return path;
}

function classResult(report: RetentionSweepReport, id: string) {
	const entry = report.classes.find((candidate) => candidate.class === id);
	if (!entry) throw new Error(`no class result for ${id}`);
	return entry;
}

function allSkipped(report: RetentionSweepReport) {
	return report.classes.flatMap((entry) => entry.skipped);
}

/** Ledger records for one child: spawn only (live), or spawn + delete (gone). */
function writeLedger(agentDir: string, records: unknown[]): void {
	writeFileSync(
		join(agentDir, "rlm-ledger", "ledger.jsonl"),
		`${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
	);
}

describe("retention sweep - child transcript reclamation (r38 LIFE-2)", () => {
	it("reclaims a deleted child's transcript after the default window instead of staying disabled", async () => {
		const f = fixture();
		const parentId = "aaaaaaaa-1111-7111-8111-aaaaaaaaaaaa";
		const childId = "bbbbbbbb-2222-7222-8222-bbbbbbbbbbbb";
		sessionFile(f.agentDir, parentId);
		const subDir = join(f.artifactRoot, parentId, "sub-12345678");
		mkdirSync(subDir, { recursive: true });
		const transcript = join(subDir, `${childId}.jsonl`);
		writeFileSync(transcript, '{"type":"session"}\n');
		ageTree(subDir, 31 * DAY_MS);
		const transcriptPath = join(f.artifactRoot, parentId, "sub-12345678", `${childId}.jsonl`);
		writeLedger(f.agentDir, [
			{ v: 1, op: "spawn", at: new Date(0).toISOString(), childId: "sub-12345678", child: transcriptPath },
			{ v: 1, op: "delete", at: new Date(0).toISOString(), childId: "sub-12345678", child: transcriptPath },
		]);

		// Red before the fix: the shipped default was 0, so the class reported
		// disabled and the deleted child's transcript was never a candidate.
		const report = await runRetentionSweep({ settings: resolveRetentionSettings({}), roots: f.roots });
		expect(classResult(report, "child-transcripts").disabled).toBe(false);
		expect(existsSync(transcript)).toBe(false);
		expect(classResult(report, "child-transcripts").reclaimed).toBe(1);
	});

	it("keeps a live child's transcript on its ledger edge (boundary control)", async () => {
		const f = fixture();
		const parentId = "aaaaaaaa-1111-7111-8111-aaaaaaaaaaaa";
		const childId = "bbbbbbbb-2222-7222-8222-bbbbbbbbbbbb";
		sessionFile(f.agentDir, parentId);
		const subDir = join(f.artifactRoot, parentId, "sub-12345678");
		mkdirSync(subDir, { recursive: true });
		const transcript = join(subDir, `${childId}.jsonl`);
		writeFileSync(transcript, '{"type":"session"}\n');
		ageTree(subDir, 60 * DAY_MS);
		// Live edge only: spawn, no delete. The window is pinned so the boundary is
		// independent of the shipped default.
		const transcriptPath = join(f.artifactRoot, parentId, "sub-12345678", `${childId}.jsonl`);
		writeLedger(f.agentDir, [
			{ v: 1, op: "spawn", at: new Date(0).toISOString(), childId: "sub-12345678", child: transcriptPath },
		]);

		const report = await runRetentionSweep({
			settings: resolveRetentionSettings({ childTranscriptDays: 30 }),
			roots: f.roots,
		});
		expect(existsSync(transcript)).toBe(true);
		expect(allSkipped(report).find((entry) => entry.path === transcript)?.reason).toBe("reference:ledger-live");
	});

	it("keeps every transcript when the ledger scan failed (unknown is not no-live-edge)", async () => {
		const f = fixture();
		const parentId = "aaaaaaaa-1111-7111-8111-aaaaaaaaaaaa";
		const childId = "bbbbbbbb-2222-7222-8222-bbbbbbbbbbbb";
		sessionFile(f.agentDir, parentId);
		const subDir = join(f.artifactRoot, parentId, "sub-12345678");
		mkdirSync(subDir, { recursive: true });
		const transcript = join(subDir, `${childId}.jsonl`);
		writeFileSync(transcript, '{"type":"session"}\n');
		ageTree(subDir, 60 * DAY_MS);
		// No ledger file at all: the scan cannot report live edges, so the class must
		// not treat "unknown" as "no live edge" now that a window ships by default.
		const report = await runRetentionSweep({
			settings: resolveRetentionSettings({ childTranscriptDays: 30 }),
			roots: f.roots,
		});
		expect(existsSync(transcript)).toBe(true);
		expect(allSkipped(report).find((entry) => entry.path === transcript)?.reason).toBe("unverifiable:ledger-scan");
	});
});

describe("retention sweep - no-tombstone dead zone (r38 LIFE-2)", () => {
	it("reclaims an old unreferenced directory without a tombstone once the ledger is scanned", async () => {
		const f = fixture();
		const parentId = "aaaaaaaa-1111-7111-8111-aaaaaaaaaaaa";
		const deadId = "cccccccc-3333-7333-8333-cccccccccccc";
		const liveId = "dddddddd-4444-7444-8444-dddddddddddd";
		sessionFile(f.agentDir, parentId);
		const parentArtifact = join(f.artifactRoot, parentId);
		const deadDir = join(parentArtifact, "session-artifacts", deadId);
		mkdirSync(deadDir, { recursive: true });
		writeFileSync(join(deadDir, "semantic-edges.jsonl"), '{"type":"edge"}\n');
		const liveDir = join(parentArtifact, "session-artifacts", liveId);
		mkdirSync(liveDir, { recursive: true });
		writeFileSync(join(liveDir, "semantic-edges.jsonl"), '{"type":"edge"}\n');
		ageTree(join(parentArtifact, "session-artifacts"), 30 * DAY_MS);
		// The ledger is scanned and positively reports a live edge for liveId; it
		// knows nothing about deadId (no transcript, no edge, no tombstone).
		writeLedger(f.agentDir, [
			{
				v: 1,
				op: "spawn",
				at: new Date(0).toISOString(),
				childId: "sub-99999999",
				child: join(parentArtifact, "sub-99999999", `${liveId}.jsonl`),
			},
		]);

		// Red before the fix: SKIP.no-tombstone kept the dead zone forever. The age
		// window (deletedSessionResidueDays) still guards the reclaim.
		const report = await runRetentionSweep({
			settings: resolveRetentionSettings({ deletedSessionResidueDays: 7 }),
			roots: f.roots,
		});
		expect(existsSync(deadDir)).toBe(false);
		expect(classResult(report, "artifact-residue-dirs").reclaimed).toBe(1);
		// Boundary control (r34 ruling 1): a live ledger edge keeps its directory.
		expect(existsSync(liveDir)).toBe(true);
		expect(allSkipped(report).find((entry) => entry.path === liveDir)?.reason).toBe("reference:ledger-live");
	});

	it("keeps the dead zone when the ledger scan failed, because liveness is unknown", async () => {
		const f = fixture();
		const parentId = "aaaaaaaa-1111-7111-8111-aaaaaaaaaaaa";
		const deadId = "cccccccc-3333-7333-8333-cccccccccccc";
		sessionFile(f.agentDir, parentId);
		const deadDir = join(f.artifactRoot, parentId, "session-artifacts", deadId);
		mkdirSync(deadDir, { recursive: true });
		writeFileSync(join(deadDir, "semantic-edges.jsonl"), '{"type":"edge"}\n');
		ageTree(deadDir, 30 * DAY_MS);

		const report = await runRetentionSweep({
			settings: resolveRetentionSettings({ deletedSessionResidueDays: 7 }),
			roots: f.roots,
		});
		expect(existsSync(deadDir)).toBe(true);
		expect(allSkipped(report).find((entry) => entry.path === deadDir)?.reason).toBe("no-tombstone");
	});
});
