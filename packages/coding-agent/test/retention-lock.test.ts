// r42 PR-C3 (ADC-3, candidate 3A): the cross-process sweep guard.
//
// Every trigger shares `runRetentionSweepOnce`, so that one function owns the
// mutex. These tests drive the public entry point and assert on observable disk
// state: a sweep another process already holds must not start, must not move the
// report or the history account, and must not spend the per-sweep breaker twice.
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockSync } from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { lastSweepPath, retentionHistoryPath, retentionRoots } from "../src/core/retention/reports.js";
import {
	runRetentionSweepOnce,
	SWEEP_GUARD_FILE_NAME,
	SWEEP_IN_PROGRESS_FILE_NAME,
} from "../src/core/retention/runner.js";
import type { RetentionRoots, RetentionSweepReport } from "../src/core/retention/types.js";
import { type RetentionSettings, resolveRetentionSettings } from "../src/core/settings-manager.js";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** chmod only blocks writes for a non-root POSIX process. */
const permissionDenialIsEnforced = process.platform !== "win32" && (process.getuid?.() ?? 0) !== 0;
/** history.jsonl's cap in reports.ts: the read-modify-write branch starts here. */
const HISTORY_LIMIT = 200;

const guardPath = (roots: RetentionRoots): string => join(roots.retentionDir, SWEEP_GUARD_FILE_NAME);
const inProgressPath = (roots: RetentionRoots): string => join(roots.retentionDir, SWEEP_IN_PROGRESS_FILE_NAME);

/** One stored history line, shaped like what `writeRetentionReport` appends. */
function historyLine(index: number): string {
	const report: RetentionSweepReport = {
		at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
		durationMs: 1,
		dryRun: false,
		enabled: true,
		classes: [{ class: "logs", scanned: 1, reclaimed: 0, bytes: 0, skipped: [], capped: false, disabled: false }],
		totals: { scanned: 1, reclaimed: 0, bytes: 0, entries: 0 },
		capped: false,
		stalled: [],
	};
	return JSON.stringify(report);
}

const sandboxes: string[] = [];
let previousTmpDir: string | undefined;
let previousKernelVenv: string | undefined;

interface Fixture {
	agentDir: string;
	roots: RetentionRoots;
	/** The log file the `logs` class reclaims: the older of one family. */
	oldLog: string;
}

/**
 * An agent dir holding one reclaimable log family (the class keeps the newest file
 * of a family and reclaims the older one), with TMPDIR and the kernel venv base
 * pointed into the sandbox so no class can reach the machine's own state.
 */
function fixture(options: { retentionDirMode?: number; family?: string } = {}): Fixture {
	const root = mkdtempSync(join(tmpdir(), "retention-lock-"));
	sandboxes.push(root);
	previousTmpDir ??= process.env.TMPDIR;
	previousKernelVenv ??= process.env.PRIME_AGENT_KERNEL_VENV;
	const agentDir = join(root, "agent");
	const logsDir = join(agentDir, "logs");
	for (const dir of [
		agentDir,
		logsDir,
		join(root, "tmp"),
		join(agentDir, "sessions"),
		join(agentDir, "session-artifacts"),
		join(agentDir, "session-leases"),
		join(agentDir, "rlm-ledger"),
		join(agentDir, "retention"),
	]) {
		mkdirSync(dir, { recursive: true });
	}
	process.env.TMPDIR = join(root, "tmp");
	process.env.PRIME_AGENT_KERNEL_VENV = join(root, "kernel-venv");
	const family = options.family ?? "1111aaaa";
	const oldLog = join(logsDir, `aaa.${family}.log`);
	const newestLog = join(logsDir, `bbb.${family}.log`);
	writeFileSync(oldLog, "old\n");
	writeFileSync(newestLog, "new\n");
	const older = new Date(Date.now() - 40 * DAY_MS);
	const newer = new Date(Date.now() - 20 * DAY_MS);
	utimesSync(oldLog, older, older);
	utimesSync(newestLog, newer, newer);
	const roots = retentionRoots({ agentDir });
	if (options.retentionDirMode !== undefined) chmodSync(roots.retentionDir, options.retentionDirMode);
	return { agentDir, roots, oldLog };
}

/** One more reclaimable family inside an existing fixture: the retry control. */
function addFamily(f: Fixture, family: string): string {
	const oldLog = join(f.roots.logsDir, `aaa.${family}.log`);
	const newestLog = join(f.roots.logsDir, `bbb.${family}.log`);
	writeFileSync(oldLog, "old\n");
	writeFileSync(newestLog, "new\n");
	const older = new Date(Date.now() - 40 * DAY_MS);
	const newer = new Date(Date.now() - 20 * DAY_MS);
	utimesSync(oldLog, older, older);
	utimesSync(newestLog, newer, newer);
	return oldLog;
}

/** Only the `logs` class is live, so every number in a report is assertable. */
function settings(overrides: Partial<RetentionSettings> = {}) {
	return resolveRetentionSettings({
		tmpRlmDirHours: 0,
		tmpOtherDirDays: 0,
		bashTempFileHours: 0,
		emptyArtifactDirDays: 0,
		deletedSessionResidueDays: 0,
		childTranscriptDays: 0,
		staleLeaseHours: 0,
		logFileDays: 14,
		...overrides,
	});
}

/** How many entries the `logs` class reclaimed. Absolute counts are not assertable across
 *  several sweeps of one family (the newest-of-family rule only guards a multi-file group),
 *  so these tests pair this with an existsSync check on the specific candidate. */
const logsReclaimed = (report: RetentionSweepReport | undefined): number =>
	report?.classes.find((entry) => entry.class === "logs")?.reclaimed ?? -1;

/** Hold the guard the way another process does: the same lockfile, a live mtime. */
function holdGuard(roots: RetentionRoots): () => void {
	return lockSync(roots.retentionDir, {
		realpath: false,
		lockfilePath: guardPath(roots),
		stale: 10 * MINUTE_MS,
		onCompromised: () => undefined,
	});
}

/** A guard directory of a given age, as a holder that died would leave behind. */
function plantGuard(roots: RetentionRoots, ageMs: number): void {
	mkdirSync(guardPath(roots), { recursive: true });
	const when = new Date(Date.now() - ageMs);
	utimesSync(guardPath(roots), when, when);
}

afterEach(() => {
	if (previousTmpDir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = previousTmpDir;
	if (previousKernelVenv === undefined) delete process.env.PRIME_AGENT_KERNEL_VENV;
	else process.env.PRIME_AGENT_KERNEL_VENV = previousKernelVenv;
	previousTmpDir = undefined;
	previousKernelVenv = undefined;
	for (const root of sandboxes.splice(0)) {
		try {
			chmodSync(join(root, "agent", "retention"), 0o700);
		} catch {
			// The fixture never got as far as creating it.
		}
		rmSync(root, { recursive: true, force: true });
	}
});

describe("retention sweep guard - one sweep per agent dir at a time", () => {
	it("runs nothing and moves no account while another process holds the guard", async () => {
		const f = fixture();
		const first = await runRetentionSweepOnce({ agentDir: f.agentDir, settings: settings() });
		expect(logsReclaimed(first.report)).toBeGreaterThanOrEqual(1);
		expect(existsSync(f.oldLog)).toBe(false);

		const nextLog = addFamily(f, "2222bbbb");
		const lastSweepBefore = readFileSync(lastSweepPath(f.roots), "utf8");
		const historyBefore = readFileSync(retentionHistoryPath(f.roots), "utf8");
		const release = holdGuard(f.roots);
		try {
			const skipped = await runRetentionSweepOnce({ agentDir: f.agentDir, settings: settings() });
			// Red today: there is no guard, so this sweep runs, reclaims and writes.
			expect(skipped.lockHeld).toBe(true);
			expect(skipped.report).toBeUndefined();
			expect(skipped.lastReport?.at).toBe(first.report?.at);
			expect(existsSync(nextLog)).toBe(true);
			expect(readFileSync(lastSweepPath(f.roots), "utf8")).toBe(lastSweepBefore);
			expect(readFileSync(retentionHistoryPath(f.roots), "utf8")).toBe(historyBefore);
		} finally {
			release();
		}

		// Positive control: the same trigger on the same fixture with the guard free.
		const after = await runRetentionSweepOnce({ agentDir: f.agentDir, settings: settings() });
		expect(after.lockHeld).toBe(false);
		expect(logsReclaimed(after.report)).toBeGreaterThanOrEqual(1);
		expect(existsSync(nextLog)).toBe(false);
	});

	it("serializes the history read-modify-write instead of losing a line", async () => {
		const f = fixture();
		const seeded = Array.from({ length: HISTORY_LIMIT }, (_, index) => historyLine(index));
		expect(seeded.length).toBe(HISTORY_LIMIT);
		writeFileSync(retentionHistoryPath(f.roots), `${seeded.join("\n")}\n`);

		const release = holdGuard(f.roots);
		try {
			const skipped = await runRetentionSweepOnce({ agentDir: f.agentDir, settings: settings() });
			expect(skipped.lockHeld).toBe(true);
			// The contended trigger leaves the account byte-for-byte as it found it.
			expect(readFileSync(retentionHistoryPath(f.roots), "utf8")).toBe(`${seeded.join("\n")}\n`);
		} finally {
			release();
		}

		const ran = await runRetentionSweepOnce({ agentDir: f.agentDir, settings: settings() });
		expect(ran.lockHeld).toBe(false);
		const lines = readFileSync(retentionHistoryPath(f.roots), "utf8")
			.split("\n")
			.filter((line) => line !== "");
		// The cap drops exactly one old line to make room; nothing else disappears.
		expect(lines.length).toBeGreaterThanOrEqual(HISTORY_LIMIT);
		expect(lines.slice(0, HISTORY_LIMIT - 1)).toEqual(seeded.slice(1));
		expect(JSON.parse(lines[lines.length - 1] ?? "{}").at).toBe(ran.report?.at);
	});

	it.skipIf(!permissionDenialIsEnforced)(
		"still sweeps when the guard cannot be created, and reports the missing lock",
		async () => {
			const f = fixture({ retentionDirMode: 0o500 });
			const result = await runRetentionSweepOnce({ agentDir: f.agentDir, settings: settings() });
			// A lock that is unavailable is a bookkeeping risk, never a cleanup stop.
			expect(result.lockHeld).toBe(false);
			expect(result.lockUnavailable).toBe(true);
			expect(logsReclaimed(result.report)).toBeGreaterThanOrEqual(1);
			expect(existsSync(f.oldLog)).toBe(false);
		},
	);

	it("breaks a guard older than the stale threshold instead of skipping forever", async () => {
		const f = fixture();
		plantGuard(f.roots, 2 * 60 * MINUTE_MS);
		const recovered = await runRetentionSweepOnce({ agentDir: f.agentDir, settings: settings() });
		expect(recovered.lockHeld).toBe(false);
		expect(recovered.lockUnavailable).toBe(false);
		expect(logsReclaimed(recovered.report)).toBeGreaterThanOrEqual(1);

		// Positive control on the same shape: the identical directory, freshly made.
		plantGuard(f.roots, 0);
		const held = await runRetentionSweepOnce({ agentDir: f.agentDir, settings: settings() });
		expect(held.lockHeld).toBe(true);
		expect(held.report).toBeUndefined();
	});

	it("publishes who holds the guard for exactly the duration of the sweep", async () => {
		const f = fixture();
		// The guard and its owner record exist before the sweep's first await, so a
		// contended caller always has a holder to name.
		const pending = runRetentionSweepOnce({ agentDir: f.agentDir, settings: settings() });
		expect(existsSync(inProgressPath(f.roots))).toBe(true);
		const record = JSON.parse(readFileSync(inProgressPath(f.roots), "utf8")) as {
			pid?: number;
			startedAt?: string;
			agentDir?: string;
		};
		expect(record.pid).toBe(process.pid);
		expect(record.agentDir).toBe(f.roots.agentDir);
		expect(typeof record.startedAt).toBe("string");
		const result = await pending;
		expect(result.lockHeld).toBe(false);
		// Released: the owner record and the guard directory both go away.
		expect(existsSync(inProgressPath(f.roots))).toBe(false);
		expect(existsSync(guardPath(f.roots))).toBe(false);

		// A leftover record from a holder that died is what a skipped trigger names.
		writeFileSync(inProgressPath(f.roots), JSON.stringify({ pid: 4242, startedAt: "2026-01-01T00:00:00.000Z" }));
		plantGuard(f.roots, 0);
		const skipped = await runRetentionSweepOnce({ agentDir: f.agentDir, settings: settings() });
		expect(skipped.lockHeld).toBe(true);
		expect(skipped.holder).toContain("4242");
		expect(skipped.holder).toContain("2026-01-01T00:00:00.000Z");
		// The skipped trigger never deletes an owner record that is not its own.
		expect(existsSync(inProgressPath(f.roots))).toBe(true);
	});

	it("goes back to concurrent sweeps when retention.sweepLockEnabled is off", async () => {
		const f = fixture();
		const release = holdGuard(f.roots);
		try {
			const result = await runRetentionSweepOnce({
				agentDir: f.agentDir,
				settings: settings({ sweepLockEnabled: false }),
			});
			expect(result.lockHeld).toBe(false);
			// Off is a choice, not a failed lock: the outcome only calls a lock
			// unavailable when a guard was wanted and could not be taken.
			expect(result.lockUnavailable).toBe(false);
			expect(logsReclaimed(result.report)).toBeGreaterThanOrEqual(1);
			// The lever takes no guard of its own and publishes no owner record.
			expect(existsSync(inProgressPath(f.roots))).toBe(false);
		} finally {
			release();
		}
	});
});
