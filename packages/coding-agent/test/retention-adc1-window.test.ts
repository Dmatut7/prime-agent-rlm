import type { Dirent } from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { retentionRoots } from "../src/core/retention/reports.js";
import { runRetentionSweep } from "../src/core/retention/sweep.js";
import type { RetentionRoots, RetentionSweepReport } from "../src/core/retention/types.js";
import {
	recordSessionArtifactTombstone,
	resetSessionArtifactTombstoneCache,
} from "../src/core/session-artifact-tombstones.js";
import { resolveRetentionSettings } from "../src/core/settings-manager.js";

// ADC-1 (r41 delete-chain-unify, PR-C1): one window per product identity.
//
// A deleted session's artifact directory is swept by `artifact-residue-dirs` on
// `deletedSessionResidueDays` (7), while a deleted sub-agent's transcript under
// `sub-*` is swept by `child-transcripts` on `childTranscriptDays` (30). Before
// this change the residue class exempted every ledger-deleted child transcript in
// its subtree and removed the whole directory at 7 days, so a mixed directory lost
// bytes the transcript class had promised 30 days for. The window judgement now has
// one authority (one exported function, two call sites) and a directory whose
// protected bytes are still inside their own window is kept as a whole.
//
// The tests below are the probe from the audit, promoted to a regression: the first
// one fails against the unpatched code (the whole directory, transcript included,
// is reclaimed at day 9).

const DAY_MS = 86_400_000;
const PARENT_ID = "aaaaaaaa-1111-7111-8111-aaaaaaaaaaaa";
const CHILD_ID = "bbbbbbbb-2222-7222-8222-bbbbbbbbbbbb";
const SUB_DIR = "sub-abcdefgh";
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
	const root = mkdtempSync(join(tmpdir(), "retention-adc1-"));
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
			// Children first: a directory's own mtime must not be re-set by the walk
			// after its contents, or the judgement would see a fresh directory.
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

/** One ledger file with a spawn and (optionally) a delete record for the child. */
function writeChildLedger(f: Fixture, transcriptPath: string, options: { deleted: boolean }): void {
	const records: unknown[] = [
		{ v: 1, op: "spawn", at: new Date(0).toISOString(), childId: SUB_DIR, child: transcriptPath },
	];
	if (options.deleted) {
		records.push({ v: 1, op: "delete", at: new Date(0).toISOString(), childId: SUB_DIR, child: transcriptPath });
	}
	writeFileSync(
		join(f.agentDir, "rlm-ledger", "x.jsonl"),
		`${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
	);
}

interface MixedFixture extends Fixture {
	parentDir: string;
	transcriptPath: string;
}

/**
 * The probe shape: a deleted parent session's artifact directory that holds both
 * its own residue (`harness/`) and a deleted child's transcript under `sub-*`.
 * The parent was deleted 8 days ago and nothing wrote into it for 9 days; the
 * child's transcript is 9 days old and the ledger records its delete.
 */
function mixedFixture(): MixedFixture {
	const f = fixture();
	const parentDir = join(f.artifactRoot, PARENT_ID);
	const transcriptPath = join(parentDir, SUB_DIR, `${CHILD_ID}.jsonl`);
	mkdirSync(join(parentDir, SUB_DIR), { recursive: true });
	writeFileSync(transcriptPath, '{"type":"session"}\n');
	mkdirSync(join(parentDir, "harness"), { recursive: true });
	writeFileSync(join(parentDir, "harness", "harness_state.json"), "{}");
	writeChildLedger(f, transcriptPath, { deleted: true });
	recordSessionArtifactTombstone(f.artifactRoot, PARENT_ID, { now: new Date(Date.now() - 8 * DAY_MS) });
	ageTree(parentDir, 9 * DAY_MS);
	return { ...f, parentDir, transcriptPath };
}

/** Every path inside a root, relative and sorted, for an end-state comparison. */
function snapshotPaths(root: string): string[] {
	const found: string[] = [];
	const queue = [root];
	while (queue.length > 0) {
		const current = queue.shift()!;
		let entries: Dirent[] = [];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const child = join(current, entry.name);
			found.push(relative(root, child));
			if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(child);
		}
	}
	return found.sort();
}

function classResult(report: RetentionSweepReport, id: string) {
	const entry = report.classes.find((candidate) => candidate.class === id);
	if (!entry) throw new Error(`no class result for ${id}`);
	return entry;
}

function classShape(report: RetentionSweepReport) {
	return report.classes.map((entry) => ({
		class: entry.class,
		scanned: entry.scanned,
		reclaimed: entry.reclaimed,
		bytes: entry.bytes,
	}));
}

function allSkipped(report: RetentionSweepReport) {
	return report.classes.flatMap((entry) => entry.skipped);
}

function skipReason(report: RetentionSweepReport, path: string) {
	return allSkipped(report).find((entry) => entry.path === path)?.reason;
}

describe("retention sweep - one age window per bytes identity (ADC-1)", () => {
	it("keeps a deleted child's transcript, and its parent directory, until the transcript window passes", async () => {
		const f = mixedFixture();

		const report = await runRetentionSweep({ settings: resolveRetentionSettings({}), roots: f.roots });

		expect(existsSync(f.transcriptPath)).toBe(true);
		expect(existsSync(f.parentDir)).toBe(true);
		expect(skipReason(report, f.parentDir)).toBe("young:child-transcript:30d");
		expect(classResult(report, "artifact-residue-dirs").reclaimed).toBe(0);
		// The transcript class judges the same bytes and reports the same window.
		expect(skipReason(report, f.transcriptPath)).toBe("young:30d");
	});

	it("reclaims the whole directory once the transcript window passes (positive control)", async () => {
		const f = mixedFixture();

		const report = await runRetentionSweep({
			settings: resolveRetentionSettings({}),
			roots: f.roots,
			now: Date.now() + 31 * DAY_MS,
		});

		expect(existsSync(f.transcriptPath)).toBe(false);
		expect(existsSync(f.parentDir)).toBe(false);
		expect(classResult(report, "artifact-residue-dirs").reclaimed).toBe(1);
		expect(skipReason(report, f.parentDir)).toBeUndefined();
	});

	it("keeps the whole directory in the middle of the two windows and reports the transcript as young", async () => {
		const f = mixedFixture();

		const report = await runRetentionSweep({
			settings: resolveRetentionSettings({}),
			roots: f.roots,
			now: Date.now() + 20 * DAY_MS,
		});

		expect(existsSync(f.parentDir)).toBe(true);
		expect(existsSync(f.transcriptPath)).toBe(true);
		// The residue window (7d) passed at 29 days of age: only the transcript
		// window holds the directory back.
		expect(skipReason(report, f.parentDir)).toBe("young:child-transcript:30d");
		expect(skipReason(report, f.transcriptPath)).toBe("young:30d");
	});

	it("reclaims a pure residue directory on the residue window, with no protected bytes inside", async () => {
		const f = fixture();
		const parentDir = join(f.artifactRoot, PARENT_ID);
		mkdirSync(join(parentDir, "harness"), { recursive: true });
		writeFileSync(join(parentDir, "harness", "harness_state.json"), "{}");
		recordSessionArtifactTombstone(f.artifactRoot, PARENT_ID, { now: new Date(Date.now() - 20 * DAY_MS) });
		ageTree(parentDir, 30 * DAY_MS);

		const report = await runRetentionSweep({
			settings: resolveRetentionSettings({ deletedSessionResidueDays: 7 }),
			roots: f.roots,
		});

		expect(existsSync(parentDir)).toBe(false);
		expect(classResult(report, "artifact-residue-dirs").reclaimed).toBe(1);
	});

	it("keeps an unrecorded transcript directory unconditionally when the ledger was not scanned", async () => {
		const f = fixture();
		const parentDir = join(f.artifactRoot, PARENT_ID);
		const transcriptPath = join(parentDir, SUB_DIR, `${CHILD_ID}.jsonl`);
		mkdirSync(join(parentDir, SUB_DIR), { recursive: true });
		writeFileSync(transcriptPath, '{"type":"session"}\n');
		mkdirSync(join(parentDir, "harness"), { recursive: true });
		writeFileSync(join(parentDir, "harness", "harness_state.json"), "{}");
		// No ledger directory at all: the scan cannot report a delete for the child,
		// so the transcript is not a deletion candidate and keeps its parent.
		rmSync(join(f.agentDir, "rlm-ledger"), { recursive: true, force: true });
		recordSessionArtifactTombstone(f.artifactRoot, PARENT_ID, { now: new Date(Date.now() - 20 * DAY_MS) });
		ageTree(parentDir, 30 * DAY_MS);

		const report = await runRetentionSweep({
			settings: resolveRetentionSettings({ deletedSessionResidueDays: 7 }),
			roots: f.roots,
		});

		expect(existsSync(parentDir)).toBe(true);
		expect(existsSync(transcriptPath)).toBe(true);
		expect(skipReason(report, parentDir)).toBe(`reference:descendant-transcript:${CHILD_ID}`);
	});

	it("has the same end state at 7d/childTranscriptDays=7 as at 31d/childTranscriptDays=30", async () => {
		const early = mixedFixture();
		const late = mixedFixture();
		const earlyBefore = snapshotPaths(early.artifactRoot);
		const lateBefore = snapshotPaths(late.artifactRoot);

		const earlyReport = await runRetentionSweep({
			settings: resolveRetentionSettings({ childTranscriptDays: 7 }),
			roots: early.roots,
			now: Date.now() + 7 * DAY_MS,
		});
		const lateReport = await runRetentionSweep({
			settings: resolveRetentionSettings({ childTranscriptDays: 30 }),
			roots: late.roots,
			now: Date.now() + 31 * DAY_MS,
		});

		// The fixtures are identical, and both runs removed something: the equality
		// below must not be true by vacuity.
		expect(earlyBefore).toEqual(lateBefore);
		expect(earlyBefore.length).toBeGreaterThan(0);
		const earlyAfter = snapshotPaths(early.artifactRoot);
		const lateAfter = snapshotPaths(late.artifactRoot);
		const earlyRemoved = earlyBefore.filter((path) => !earlyAfter.includes(path));
		const lateRemoved = lateBefore.filter((path) => !lateAfter.includes(path));
		expect(earlyRemoved.length).toBeGreaterThan(0);
		expect(earlyRemoved).toEqual(lateRemoved);
		expect(earlyAfter).toEqual(lateAfter);
		expect(classShape(earlyReport)).toEqual(classShape(lateReport));
	});
});
