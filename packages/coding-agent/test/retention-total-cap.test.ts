// Tests for the wave-5 文档-5 additions to the disk-retention sweep:
//   * the `artifact-total-cap` class (retention.sessionArtifactsMaxBytes +
//     retention.sessionArtifactsCapMinAgeDays),
//   * the bash-temp count cap (retention.bashTempFileMaxCount),
//   * the warn-once record when a delete tombstone suppresses recreation of a
//     deleted session's artifact directory.
//
// Every test builds its own tree under `mkdtemp` and removes it in `afterEach`;
// nothing here reads or writes the real `~/.prime/agent`.

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { artifactTotalCapModule } from "../src/core/retention/artifact-total-cap.js";
import { bashTempFilesModule } from "../src/core/retention/bash-temp.js";
import type { RetentionClassContext, RetentionRoots } from "../src/core/retention/types.js";
import { recordSessionArtifactTombstone } from "../src/core/session-artifact-tombstones.js";
import { getSessionArtifactsRoot, SessionManager } from "../src/core/session-manager.js";
import { resolveRetentionSettings } from "../src/core/settings-manager.js";

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const SANDBOX_PREFIX = "retcap-";

const sandboxes: string[] = [];

afterEach(() => {
	setLogSink(undefined);
	for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Sandbox {
	root: string;
	roots: RetentionRoots;
}

function createSandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), SANDBOX_PREFIX));
	sandboxes.push(root);
	const roots: RetentionRoots = {
		agentDir: root,
		sessionsDir: join(root, "sessions"),
		artifactRoot: join(root, "session-artifacts"),
		logsDir: join(root, "logs"),
		tmpDir: join(root, "tmp"),
		leasesRoot: join(root, "session-leases"),
		retentionDir: join(root, "retention"),
	};
	mkdirSync(roots.sessionsDir, { recursive: true, mode: 0o700 });
	mkdirSync(roots.artifactRoot, { recursive: true, mode: 0o700 });
	mkdirSync(roots.tmpDir, { recursive: true, mode: 0o700 });
	return { root, roots };
}

function makeContext(
	roots: RetentionRoots,
	settingsOverrides: Parameters<typeof resolveRetentionSettings>[0] = {},
	options: { dryRun?: boolean; now?: number; residentSessionIds?: ReadonlySet<string> } = {},
): RetentionClassContext {
	const dryRun = options.dryRun ?? false;
	const settings = resolveRetentionSettings({ dryRun, ...settingsOverrides });
	return {
		settings,
		roots,
		now: options.now ?? Date.now(),
		dryRun,
		budget: {
			remainingBytes: settings.maxDeleteBytesPerSweep,
			remainingEntries: settings.maxDeleteEntriesPerSweep,
			capped: false,
		},
		live: {
			residentSessionIds: options.residentSessionIds ?? new Set<string>(),
			ledgerScanned: true,
		},
		log: () => {},
	};
}

function agePath(path: string, ageMs: number, now: number): void {
	const when = new Date(now - ageMs);
	utimesSync(path, when, when);
}

/**
 * One session's artifact directory with a kernel snapshot payload of exactly
 * `bytes` and every entry (files first, then the directory itself) aged to
 * `ageMs`. `withMemory` adds the local harness store (`harness/harness_state.json`,
 * the session's continual memory); `imageBytes` adds a pasted-image payload.
 */
function makeArtifactDir(
	roots: RetentionRoots,
	sessionId: string,
	options: {
		bytes: number;
		ageMs: number;
		now: number;
		scheduledJobs?: boolean;
		childTranscriptId?: string;
		withMemory?: boolean;
		imageBytes?: number;
	},
): string {
	const dir = join(roots.artifactRoot, sessionId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, "kernel-state.dill"), Buffer.alloc(options.bytes, 1));
	if (options.scheduledJobs === true) {
		writeFileSync(join(dir, "scheduled-jobs.json"), '{"jobs":[],"dispatches":[]}\n');
	}
	if (options.withMemory === true) {
		const harnessDir = join(dir, "harness");
		mkdirSync(harnessDir, { recursive: true, mode: 0o700 });
		writeFileSync(join(harnessDir, "harness_state.json"), '{"entries":{"m1":{"content":"remember the dag"}}}\n');
		agePath(join(harnessDir, "harness_state.json"), options.ageMs, options.now);
		agePath(harnessDir, options.ageMs, options.now);
	}
	if (options.imageBytes !== undefined) {
		writeFileSync(join(dir, "image-1.png"), Buffer.alloc(options.imageBytes, 7));
		agePath(join(dir, "image-1.png"), options.ageMs, options.now);
	}
	if (options.childTranscriptId !== undefined) {
		const childDir = join(dir, "sub-deadbeef");
		mkdirSync(childDir, { recursive: true, mode: 0o700 });
		writeFileSync(join(childDir, `${options.childTranscriptId}.jsonl`), '{"type":"session"}\n');
		agePath(childDir, options.ageMs, options.now);
	}
	agePath(join(dir, "kernel-state.dill"), options.ageMs, options.now);
	if (options.scheduledJobs === true) agePath(join(dir, "scheduled-jobs.json"), options.ageMs, options.now);
	if (options.childTranscriptId !== undefined) {
		agePath(join(dir, "sub-deadbeef", `${options.childTranscriptId}.jsonl`), options.ageMs, options.now);
	}
	// The directory's own mtime is part of the tree's newest write: age it last.
	agePath(dir, options.ageMs, options.now);
	return dir;
}

function writeBashTemp(roots: RetentionRoots, name: string, body: string, ageMs: number, now: number): string {
	const path = join(roots.tmpDir, name);
	writeFileSync(path, body, "utf8");
	agePath(path, ageMs, now);
	return path;
}

describe("resolveRetentionSettings wave-5 knobs", () => {
	it("ships conservative defaults", () => {
		const resolved = resolveRetentionSettings({});
		expect(resolved.bashTempFileMaxCount).toBe(100);
		expect(resolved.sessionArtifactsMaxBytes).toBe(8 * 1024 * 1024 * 1024);
		expect(resolved.sessionArtifactsCapMinAgeDays).toBe(7);
	});

	it("treats 0 or negative as off and non-numbers as the default", () => {
		const off = resolveRetentionSettings({
			bashTempFileMaxCount: 0,
			sessionArtifactsMaxBytes: 0,
			sessionArtifactsCapMinAgeDays: -3,
		});
		expect(off.bashTempFileMaxCount).toBe(0);
		expect(off.sessionArtifactsMaxBytes).toBe(0);
		expect(off.sessionArtifactsCapMinAgeDays).toBe(0);
		const invalid = resolveRetentionSettings({
			bashTempFileMaxCount: "many" as unknown as number,
			sessionArtifactsMaxBytes: Number.NaN,
		});
		expect(invalid.bashTempFileMaxCount).toBe(100);
		expect(invalid.sessionArtifactsMaxBytes).toBe(8 * 1024 * 1024 * 1024);
	});
});

describe("bash-temp count cap", () => {
	it("keeps the newest maxCount files past the cooldown floor and reclaims the oldest", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		// All four inside the 24h age window, all past the 10m cooldown floor.
		const oldest = writeBashTemp(roots, "pi-bash-0000000000000001.log", "1", 4 * MS_PER_HOUR, now);
		const second = writeBashTemp(roots, "pi-bash-0000000000000002.log", "2", 3 * MS_PER_HOUR, now);
		const third = writeBashTemp(roots, "pi-bash-0000000000000003.log", "3", 2 * MS_PER_HOUR, now);
		const newest = writeBashTemp(roots, "pi-bash-0000000000000004.log", "4", 1 * MS_PER_HOUR, now);

		const result = await bashTempFilesModule.scanAndReclaim(makeContext(roots, { bashTempFileMaxCount: 2 }, { now }));

		expect(result.reclaimed).toBe(2);
		expect(existsSync(oldest)).toBe(false);
		expect(existsSync(second)).toBe(false);
		expect(existsSync(third)).toBe(true);
		expect(existsSync(newest)).toBe(true);
	});

	it("never count-caps a file inside the cooldown floor", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		const a = writeBashTemp(roots, "pi-bash-0000000000000001.log", "1", 4 * MS_PER_MINUTE, now);
		const b = writeBashTemp(roots, "pi-bash-0000000000000002.log", "2", 3 * MS_PER_MINUTE, now);
		const c = writeBashTemp(roots, "pi-bash-0000000000000003.log", "3", 2 * MS_PER_MINUTE, now);

		const result = await bashTempFilesModule.scanAndReclaim(makeContext(roots, { bashTempFileMaxCount: 1 }, { now }));

		expect(result.reclaimed).toBe(0);
		expect(existsSync(a)).toBe(true);
		expect(existsSync(b)).toBe(true);
		expect(existsSync(c)).toBe(true);
		const cooldownKept = result.skipped.filter((entry) => entry.reason === "young:bash-temp-file");
		expect(cooldownKept.length).toBeGreaterThan(0);
		expect(cooldownKept.some((entry) => entry.detail?.includes("count cap"))).toBe(true);
	});

	it("still enforces the count cap when the age window is off", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		const old1 = writeBashTemp(roots, "pi-bash-0000000000000001.log", "1", 30 * MS_PER_DAY, now);
		const old2 = writeBashTemp(roots, "pi-bash-0000000000000002.log", "2", 20 * MS_PER_DAY, now);
		const kept = writeBashTemp(roots, "pi-bash-0000000000000003.log", "3", 10 * MS_PER_DAY, now);

		const result = await bashTempFilesModule.scanAndReclaim(
			makeContext(roots, { bashTempFileHours: 0, bashTempFileMaxCount: 1 }, { now }),
		);

		expect(result.disabled).toBe(false);
		expect(result.reclaimed).toBe(2);
		expect(existsSync(old1)).toBe(false);
		expect(existsSync(old2)).toBe(false);
		expect(existsSync(kept)).toBe(true);
	});

	it("is disabled only when both the age window and the count cap are off", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		writeBashTemp(roots, "pi-bash-0000000000000001.log", "1", 30 * MS_PER_DAY, now);

		const disabled = await bashTempFilesModule.scanAndReclaim(
			makeContext(roots, { bashTempFileHours: 0, bashTempFileMaxCount: 0 }, { now }),
		);
		expect(disabled.disabled).toBe(true);
		expect(disabled.reclaimed).toBe(0);

		const ageOnly = await bashTempFilesModule.scanAndReclaim(
			makeContext(roots, { bashTempFileHours: 24, bashTempFileMaxCount: 0 }, { now }),
		);
		expect(ageOnly.disabled).toBe(false);
		expect(ageOnly.reclaimed).toBe(1);
	});

	it("reports the same reclaims in a dry run without deleting", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		const oldest = writeBashTemp(roots, "pi-bash-0000000000000001.log", "1", 4 * MS_PER_HOUR, now);
		writeBashTemp(roots, "pi-bash-0000000000000002.log", "2", 1 * MS_PER_HOUR, now);

		const result = await bashTempFilesModule.scanAndReclaim(
			makeContext(roots, { bashTempFileMaxCount: 1, dryRun: true }, { now, dryRun: true }),
		);

		expect(result.reclaimed).toBe(1);
		expect(existsSync(oldest)).toBe(true);
	});
});

describe("bash-temp age pass reclaim order", () => {
	it("spends a capped per-sweep budget on the oldest files first, not on dictionary order", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		// Dictionary order puts the newer file (0000...) ahead of the older one
		// (ffff...); the mtime order must be the one the budget is spent in.
		const newer = writeBashTemp(roots, "pi-bash-0000000000000001.log", "1", 3 * MS_PER_HOUR, now);
		const older = writeBashTemp(roots, "pi-bash-ffffffffffffffff.log", "2", 5 * MS_PER_HOUR, now);

		const result = await bashTempFilesModule.scanAndReclaim(
			makeContext(roots, { bashTempFileHours: 1, bashTempFileMaxCount: 0, maxDeleteEntriesPerSweep: 1 }, { now }),
		);

		expect(result.reclaimed).toBe(1);
		expect(existsSync(older)).toBe(false);
		expect(existsSync(newer)).toBe(true);
		const capped = result.skipped.find((entry) => entry.path === newer);
		expect(capped?.reason).toBe("cap-hit");
	});
});

describe("artifact-total-cap", () => {
	it("is disabled at 0 and scans nothing", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		makeArtifactDir(roots, "aa01", { bytes: 100, ageMs: 30 * MS_PER_DAY, now });

		const result = await artifactTotalCapModule.scanAndReclaim(
			makeContext(roots, { sessionArtifactsMaxBytes: 0 }, { now }),
		);

		expect(result.disabled).toBe(true);
		expect(result.scanned).toBe(0);
		expect(existsSync(join(roots.artifactRoot, "aa01"))).toBe(true);
	});

	it("does nothing while the countable snapshot payloads fit under the ceiling", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		makeArtifactDir(roots, "aa01", { bytes: 100, ageMs: 30 * MS_PER_DAY, now });

		const result = await artifactTotalCapModule.scanAndReclaim(
			makeContext(roots, { sessionArtifactsMaxBytes: 10 * 1024 * 1024 }, { now }),
		);

		expect(result.scanned).toBe(1);
		expect(result.reclaimed).toBe(0);
		expect(result.skipped).toEqual([]);
	});

	it("reclaims only the kernel snapshot and keeps the session's memory and pasted images", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		const dir = makeArtifactDir(roots, "aa01", {
			bytes: 800,
			ageMs: 30 * MS_PER_DAY,
			now,
			withMemory: true,
			imageBytes: 300,
		});

		const result = await artifactTotalCapModule.scanAndReclaim(
			makeContext(roots, { sessionArtifactsMaxBytes: 100 }, { now }),
		);

		expect(result.reclaimed).toBe(1);
		expect(result.bytes).toBe(800);
		// The kernel namespace is the reclaimable payload; the session's own state is not.
		expect(existsSync(join(dir, "kernel-state.dill"))).toBe(false);
		expect(existsSync(dir)).toBe(true);
		expect(existsSync(join(dir, "harness", "harness_state.json"))).toBe(true);
		expect(existsSync(join(dir, "image-1.png"))).toBe(true);
	});

	it("reclaims the largest snapshots first until the counted bytes fit", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		// Oldest-first would take the small one; byte pressure takes the payload that
		// actually moves the total, costing the fewest sessions their kernel state.
		const smallOldest = makeArtifactDir(roots, "aa01", { bytes: 400, ageMs: 30 * MS_PER_DAY, now });
		const large = makeArtifactDir(roots, "aa02", { bytes: 800, ageMs: 20 * MS_PER_DAY, now });
		const middle = makeArtifactDir(roots, "aa03", { bytes: 600, ageMs: 10 * MS_PER_DAY, now });

		const result = await artifactTotalCapModule.scanAndReclaim(
			makeContext(roots, { sessionArtifactsMaxBytes: 1000 }, { now }),
		);

		expect(result.reclaimed).toBe(1);
		expect(result.bytes).toBe(800);
		expect(existsSync(join(large, "kernel-state.dill"))).toBe(false);
		expect(existsSync(join(smallOldest, "kernel-state.dill"))).toBe(true);
		expect(existsSync(join(middle, "kernel-state.dill"))).toBe(true);
	});

	it("does not count a protected session's bytes toward the ceiling", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		const resident = makeArtifactDir(roots, "aa01", { bytes: 800, ageMs: 30 * MS_PER_DAY, now });
		const cold = makeArtifactDir(roots, "aa02", { bytes: 600, ageMs: 20 * MS_PER_DAY, now });

		const result = await artifactTotalCapModule.scanAndReclaim(
			makeContext(roots, { sessionArtifactsMaxBytes: 1000 }, { now, residentSessionIds: new Set(["aa01"]) }),
		);

		// The resident session's 800 bytes are unreachable, so they cannot push the
		// tree over the ceiling: counted bytes are 600, nothing is reclaimed, and the
		// report stays silent instead of naming a protection that decided nothing.
		expect(result.reclaimed).toBe(0);
		expect(result.skipped).toEqual([]);
		expect(existsSync(join(resident, "kernel-state.dill"))).toBe(true);
		expect(existsSync(join(cold, "kernel-state.dill"))).toBe(true);
	});

	it("does not count harness memory or other irreplaceable payload bytes toward the ceiling", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		const dir = makeArtifactDir(roots, "aa01", {
			bytes: 600,
			ageMs: 30 * MS_PER_DAY,
			now,
			withMemory: true,
			imageBytes: 5000,
		});

		const result = await artifactTotalCapModule.scanAndReclaim(
			makeContext(roots, { sessionArtifactsMaxBytes: 1000 }, { now }),
		);

		// The tree holds 5600+ bytes, but only the 600 snapshot bytes are this class's
		// to reclaim: the ceiling never fires on bytes no sweep may take.
		expect(result.reclaimed).toBe(0);
		expect(existsSync(join(dir, "kernel-state.dill"))).toBe(true);
		expect(existsSync(join(dir, "harness", "harness_state.json"))).toBe(true);
	});

	it("keeps a resident session's snapshot while reclaiming the largest eligible one", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		const resident = makeArtifactDir(roots, "aa01", { bytes: 800, ageMs: 30 * MS_PER_DAY, now });
		const next = makeArtifactDir(roots, "aa02", { bytes: 600, ageMs: 20 * MS_PER_DAY, now });
		const last = makeArtifactDir(roots, "aa03", { bytes: 600, ageMs: 10 * MS_PER_DAY, now });

		const result = await artifactTotalCapModule.scanAndReclaim(
			makeContext(roots, { sessionArtifactsMaxBytes: 1000 }, { now, residentSessionIds: new Set(["aa01"]) }),
		);

		// Counted bytes are 1200 (the resident's 800 are excluded): one 600-byte
		// payload brings them under the ceiling, and the tie goes to the first path.
		expect(result.reclaimed).toBe(1);
		expect(existsSync(join(resident, "kernel-state.dill"))).toBe(true);
		expect(existsSync(join(next, "kernel-state.dill"))).toBe(false);
		expect(existsSync(join(last, "kernel-state.dill"))).toBe(true);
		const kept = result.skipped.find((entry) => entry.path === resident);
		expect(kept?.reason).toBe("in-use:resident");
	});

	it("keeps the snapshot of a directory holding scheduled cron jobs", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		const withJobs = makeArtifactDir(roots, "aa01", { bytes: 800, ageMs: 30 * MS_PER_DAY, now, scheduledJobs: true });
		const plain = makeArtifactDir(roots, "aa02", { bytes: 600, ageMs: 20 * MS_PER_DAY, now });

		const result = await artifactTotalCapModule.scanAndReclaim(
			makeContext(roots, { sessionArtifactsMaxBytes: 500 }, { now }),
		);

		expect(result.reclaimed).toBe(1);
		expect(existsSync(join(withJobs, "kernel-state.dill"))).toBe(true);
		expect(existsSync(join(withJobs, "scheduled-jobs.json"))).toBe(true);
		expect(existsSync(join(plain, "kernel-state.dill"))).toBe(false);
		expect(existsSync(plain)).toBe(true);
		const kept = result.skipped.find((entry) => entry.path === withJobs);
		expect(kept?.reason).toBe("reference:scheduled-jobs.json");
	});

	it("reclaims the parent's snapshot without touching a nested live transcript", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		const parent = makeArtifactDir(roots, "aa01", {
			bytes: 800,
			ageMs: 30 * MS_PER_DAY,
			now,
			childTranscriptId: "cc01",
		});

		const result = await artifactTotalCapModule.scanAndReclaim(
			makeContext(roots, { sessionArtifactsMaxBytes: 100 }, { now }),
		);

		// The transcript guard exists against recursive directory deletion; a
		// file-level reclaim cannot reach `sub-*/`, so the payload goes and the
		// transcript stays.
		expect(result.reclaimed).toBe(1);
		expect(existsSync(join(parent, "kernel-state.dill"))).toBe(false);
		expect(existsSync(parent)).toBe(true);
		expect(existsSync(join(parent, "sub-deadbeef", "cc01.jsonl"))).toBe(true);
	});

	it("counts a nested session-artifacts payload once, under its own eligibility", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		const parent = makeArtifactDir(roots, "aa01", { bytes: 600, ageMs: 30 * MS_PER_DAY, now });
		const nestedRoot = join(parent, "session-artifacts");
		mkdirSync(nestedRoot, { recursive: true, mode: 0o700 });
		const child = join(nestedRoot, "bb01");
		mkdirSync(child, { recursive: true, mode: 0o700 });
		writeFileSync(join(child, "kernel-state.dill"), Buffer.alloc(600, 2));
		agePath(join(child, "kernel-state.dill"), 20 * MS_PER_DAY, now);
		agePath(child, 20 * MS_PER_DAY, now);
		agePath(nestedRoot, 20 * MS_PER_DAY, now);
		// Re-age the parent last: creating the nested root touched its mtime.
		agePath(parent, 30 * MS_PER_DAY, now);

		const result = await artifactTotalCapModule.scanAndReclaim(
			makeContext(roots, { sessionArtifactsMaxBytes: 1000 }, { now }),
		);

		// Counted once each, the payloads total 1200; one 600-byte reclaim fits the
		// ceiling. Double-counted (the parent's tree includes the child's bytes) the
		// same tree reads 1800+ and the sweep takes both.
		expect(result.scanned).toBe(2);
		expect(result.reclaimed).toBe(1);
		expect(result.bytes).toBe(600);
		expect(existsSync(join(parent, "kernel-state.dill"))).toBe(false);
		expect(existsSync(join(child, "kernel-state.dill"))).toBe(true);
	});

	it("keeps snapshots written within the age floor and excludes them from the count", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		const warm = makeArtifactDir(roots, "aa01", { bytes: 800, ageMs: 1 * MS_PER_DAY, now });
		const cold = makeArtifactDir(roots, "aa02", { bytes: 600, ageMs: 40 * MS_PER_DAY, now });

		const silent = await artifactTotalCapModule.scanAndReclaim(
			makeContext(roots, { sessionArtifactsMaxBytes: 700, sessionArtifactsCapMinAgeDays: 7 }, { now }),
		);
		// The warm 800 bytes are floored, so only the cold 600 count: under the
		// ceiling, nothing is reclaimed and nothing is reported.
		expect(silent.reclaimed).toBe(0);
		expect(silent.skipped).toEqual([]);
		expect(existsSync(join(cold, "kernel-state.dill"))).toBe(true);

		const result = await artifactTotalCapModule.scanAndReclaim(
			makeContext(roots, { sessionArtifactsMaxBytes: 500, sessionArtifactsCapMinAgeDays: 7 }, { now }),
		);

		expect(result.reclaimed).toBe(1);
		expect(existsSync(join(warm, "kernel-state.dill"))).toBe(true);
		expect(existsSync(join(cold, "kernel-state.dill"))).toBe(false);
		const kept = result.skipped.find((entry) => entry.path === warm);
		expect(kept?.reason).toBe("young:artifact-cap-floor");
	});

	it("skips a snapshot too large for the per-sweep breaker and still reclaims the rest", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		const huge = makeArtifactDir(roots, "aa01", { bytes: 2000, ageMs: 40 * MS_PER_DAY, now });
		const small = makeArtifactDir(roots, "aa02", { bytes: 600, ageMs: 30 * MS_PER_DAY, now });

		const result = await artifactTotalCapModule.scanAndReclaim(
			makeContext(roots, { sessionArtifactsMaxBytes: 1200, maxDeleteBytesPerSweep: 1000 }, { now }),
		);

		expect(existsSync(join(huge, "kernel-state.dill"))).toBe(true);
		expect(existsSync(join(small, "kernel-state.dill"))).toBe(false);
		const oversized = result.skipped.find((entry) => entry.path === join(huge, "kernel-state.dill"));
		expect(oversized?.reason).toBe("cap-hit");
		expect(oversized?.detail).toContain("maxDeleteBytesPerSweep");
	});

	it("never spends per-sweep entries on directories without a snapshot payload", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		// The payload-less directory is the oldest, so any age-ordered pass meets it
		// first; with one entry of budget it must not be spent.
		const empty = join(roots.artifactRoot, "aa01");
		mkdirSync(empty, { recursive: true, mode: 0o700 });
		agePath(empty, 40 * MS_PER_DAY, now);
		const payload = makeArtifactDir(roots, "aa02", { bytes: 600, ageMs: 30 * MS_PER_DAY, now });

		const result = await artifactTotalCapModule.scanAndReclaim(
			makeContext(roots, { sessionArtifactsMaxBytes: 100, maxDeleteEntriesPerSweep: 1 }, { now }),
		);

		// The single entry goes to the session that actually holds reclaimable
		// bytes; the empty one is the empty-dirs class's to judge by age.
		expect(result.reclaimed).toBe(1);
		expect(existsSync(join(payload, "kernel-state.dill"))).toBe(false);
		expect(existsSync(empty)).toBe(true);
		expect(result.skipped.filter((entry) => entry.reason === "cap-hit")).toEqual([]);
	});

	it("reports the same reclaims in a dry run without deleting", async () => {
		const { roots } = createSandbox();
		const now = Date.now();
		const largest = makeArtifactDir(roots, "aa01", { bytes: 800, ageMs: 30 * MS_PER_DAY, now });
		makeArtifactDir(roots, "aa02", { bytes: 600, ageMs: 20 * MS_PER_DAY, now });

		const result = await artifactTotalCapModule.scanAndReclaim(
			makeContext(roots, { sessionArtifactsMaxBytes: 1000, dryRun: true }, { now, dryRun: true }),
		);

		expect(result.reclaimed).toBe(1);
		expect(existsSync(join(largest, "kernel-state.dill"))).toBe(true);
	});
});

describe("tombstone-suppressed artifact recreation", () => {
	it("does not recreate the directory and records one warning per session", () => {
		const root = mkdtempSync(join(tmpdir(), `${SANDBOX_PREFIX}sm-`));
		sandboxes.push(root);
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
		const manager = SessionManager.create(root, sessionDir);
		const sessionId = manager.getSessionId();
		const artifactDir = manager.ensureSessionArtifactDir();
		expect(artifactDir).toBeDefined();
		expect(existsSync(artifactDir!)).toBe(true);

		const artifactRoot = getSessionArtifactsRoot(sessionDir);
		expect(recordSessionArtifactTombstone(artifactRoot, sessionId)).toBe(true);
		rmSync(artifactDir!, { recursive: true, force: true });

		const logs: LogEntry[] = [];
		setLogSink((entry) => logs.push(entry));

		const first = manager.getSessionArtifactDir({ create: true });
		const second = manager.getSessionArtifactDir({ create: true });

		expect(first).toBe(second);
		expect(existsSync(first!)).toBe(false);
		const warnings = logs.filter(
			(entry) => entry.level === "warn" && entry.msg.includes("recreation suppressed by a delete tombstone"),
		);
		expect(warnings).toHaveLength(1);
	});
});
