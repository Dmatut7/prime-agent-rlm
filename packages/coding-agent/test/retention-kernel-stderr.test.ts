// B4-08: the kernel crash log's retention contract, made explicit.
//
// `kernel-stderr.log` - and the `.old` sibling the kernel's stderr write budget rotates
// into - is written by the ipython tool at `join(snapshotDir, "kernel-stderr.log")`
// (src/core/tools/ipython.ts), and that `snapshotDir` is the session's artifact directory
// (agent-session.ts feeds the provisioner from `sessionManager.ensureSessionArtifactDir()`).
// Two retention classes could plausibly own those bytes and neither does:
//
//   * R3 `logs` judges by file-name shape - `<basename>.<8 hex>.log` plus its rotation
//     siblings - because that shape is what makes its age criterion sound: the 8 hex digits
//     are a socket path's hash, so "14 days old and no socket claims this hash" is evidence
//     the bytes are residue (logs.ts:1-7 says exactly this: R3 is "the one class where age
//     is the correct criterion"). A crash log carries no socket hash, so its age says
//     nothing about whether the session that crashed is coming back; the shape whitelist is
//     what keeps the class from claiming it. That is the correct behaviour, and it is also
//     the part nobody states out loud today.
//   * `kernel-snapshot` judges `<artifactDir>/kernel-state/*.dill` generations only
//     (kernel-snapshot.ts:9-19), so a sibling of `kernel-state/` is outside its candidate
//     set by construction - `isKernelSnapshotGenerationName` says no to it.
//
// The class that does reclaim it is `artifact-residue-dirs`, which removes a whole artifact
// directory once the session is *provably* deleted, and keeps it at any age while the
// session may still come back (artifact-dirs.ts:18-20: "Nothing here deletes bytes that
// belong to a session that may come back"). That is the right owner: a crash log is exactly
// the byte worth still having when a session returns to debug itself.
//
// The tests below make the contract mechanical, so both ways it can silently break go red:
// renaming the file into the `<...>.<8 hex>.log` family (which would hand a session's crash
// log to an age criterion that knows nothing about sessions), and widening R3's shape to
// reach the name it has today. Every name and shape assertion reads the shipped source
// instead of copying it, and carries a positive control so a botched extraction cannot pass
// as "does not match".

import type { Dirent } from "node:fs";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isKernelSnapshotGenerationName, kernelSnapshotGenerationName } from "../src/core/retention/kernel-snapshot.js";
import { logsModule, socketLogFileName } from "../src/core/retention/logs.js";
import { retentionRoots } from "../src/core/retention/reports.js";
import { runRetentionSweep } from "../src/core/retention/sweep.js";
import type { RetentionClassContext, RetentionRoots, RetentionSweepReport } from "../src/core/retention/types.js";
import {
	recordSessionArtifactTombstone,
	resetSessionArtifactTombstoneCache,
} from "../src/core/session-artifact-tombstones.js";
import { resolveRetentionSettings } from "../src/core/settings-manager.js";

const DAY_MS = 86_400_000;
const SESSION_ID = "cccccccc-3333-7333-8333-cccccccccccc";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	resetSessionArtifactTombstoneCache();
});

function sourceOf(relativePath: string): string {
	return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), "utf-8");
}

// ---------------------------------------------------------------------------
// the shipped source, read rather than copied
// ---------------------------------------------------------------------------

interface LogShapes {
	file: RegExp;
	rotation: RegExp;
}

/**
 * R3's two name shapes, extracted from logs.ts. Reading them is the point: a hand copy here
 * would keep passing after the real shape was widened, which is the drift this file exists to
 * catch. `logShapesAreLive` is the positive control that makes the extraction trustworthy.
 */
function logShapes(): LogShapes {
	const source = sourceOf("core/retention/logs.ts");
	const pick = (name: string): RegExp => {
		const declared = new RegExp(`^const ${name} = /(.*)/;$`, "m").exec(source);
		if (declared === null) throw new Error(`logs.ts no longer declares ${name} as a regex literal on one line`);
		return new RegExp(declared[1]);
	};
	return { file: pick("LOG_FILE_SHAPE"), rotation: pick("LOG_ROTATION_SIBLING_SHAPE") };
}

interface StderrLogConstruction {
	/** The file name the ipython tool hands the kernel manager. */
	name: string;
	/** The whole construction site, so a change of directory relation is visible. */
	site: string;
}

/**
 * How the crash log path is built: `stderrLogPath: snapshotDir ? join(snapshotDir, "<name>") : undefined`.
 * The two-argument `join` is load-bearing - it is what puts the log *directly* in the session
 * artifact directory rather than inside `kernel-state/`, which is why the snapshot class cannot
 * see it and the residue class can.
 */
function stderrLogConstruction(): StderrLogConstruction {
	const source = sourceOf("core/tools/ipython.ts");
	const site =
		/stderrLogPath:\s*snapshotDir\s*\?\s*join\(\s*snapshotDir,\s*("(?:[^"\\]|\\.)*")\s*\)\s*:\s*undefined/.exec(
			source,
		);
	if (site === null) {
		throw new Error(
			'ipython.ts no longer builds the crash log path as `join(snapshotDir, "<name>")`: its directory relation changed, so re-derive which retention class owns it',
		);
	}
	return { name: JSON.parse(site[1]) as string, site: site[0] };
}

/** The field agent-session.ts feeds the provisioner's `snapshotDir` from, and where it comes from. */
function snapshotDirWiring(): { field: string; fromArtifactDir: boolean } {
	const source = sourceOf("core/agent-session.ts");
	const wired = /\bsnapshotDir:\s*this\.([A-Za-z_$][\w$]*)/.exec(source);
	if (wired === null) throw new Error("agent-session.ts no longer passes a `snapshotDir: this.<field>` to the kernel");
	const field = wired[1];
	const assigned = new RegExp(`this\\.${field}\\s*=\\s*this\\.sessionManager\\.ensureSessionArtifactDir\\(\\)`);
	return { field, fromArtifactDir: assigned.test(source) };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

interface Fixture {
	root: string;
	agentDir: string;
	roots: RetentionRoots;
	artifactRoot: string;
}

function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "retention-kstderr-"));
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

/** Age a whole subtree: a directory is judged by its newest mtime. */
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

function settings() {
	// Explicit windows, so this file judges *which class owns the bytes* and not what the
	// shipped defaults happen to be this week.
	return resolveRetentionSettings({ logFileDays: 14, deletedSessionResidueDays: 7, cooldownMinutes: 10 });
}

function makeContext(f: Fixture): RetentionClassContext {
	const resolved = settings();
	return {
		settings: resolved,
		roots: f.roots,
		now: Date.now(),
		dryRun: false,
		budget: {
			remainingBytes: resolved.maxDeleteBytesPerSweep,
			remainingEntries: resolved.maxDeleteEntriesPerSweep,
			capped: false,
		},
		live: {},
		log: () => {},
	};
}

function classResult(report: RetentionSweepReport, id: string) {
	const entry = report.classes.find((candidate) => candidate.class === id);
	if (!entry) throw new Error(`no class result for ${id}`);
	return entry;
}

function skipReason(report: RetentionSweepReport, path: string): string | undefined {
	return report.classes.flatMap((entry) => entry.skipped).find((entry) => entry.path === path)?.reason;
}

/** A session artifact directory holding a crash log and the residue that makes it a session's. */
function crashedSessionDir(f: Fixture): { sessionDir: string; crashLog: string; rotated: string } {
	const sessionDir = join(f.artifactRoot, SESSION_ID);
	mkdirSync(join(sessionDir, "harness"), { recursive: true });
	writeFileSync(join(sessionDir, "harness", "harness_state.json"), "{}");
	const { name } = stderrLogConstruction();
	const crashLog = join(sessionDir, name);
	const rotated = `${crashLog}.old`;
	writeFileSync(crashLog, "Traceback (most recent call last):\n  kernel died\n");
	writeFileSync(rotated, "an earlier incarnation's stderr\n");
	return { sessionDir, crashLog, rotated };
}

// ---------------------------------------------------------------------------

describe("kernel-stderr.log retention contract (B4-08)", () => {
	it("names the crash log outside both R3 shapes, with the shapes proven live", () => {
		const shapes = logShapes();
		const { name } = stderrLogConstruction();

		// Positive control: the extraction really produced R3's shapes. Without this a botched
		// extraction would yield patterns that match nothing and every "does not match" below
		// would pass for the wrong reason.
		const daemonLog = socketLogFileName(join("/tmp", "prime-agent-501", "daemon.sock"));
		expect(shapes.file.test(daemonLog)).toBe(true);
		expect(shapes.rotation.test(`${daemonLog}.old`)).toBe(true);
		expect(daemonLog).toMatch(/\.[0-9a-f]{8}\.log$/);

		// The contract: neither the crash log nor its rotated sibling is an R3 candidate, so
		// R3's 14-day age criterion never reaches them.
		expect(shapes.file.test(name)).toBe(false);
		expect(shapes.rotation.test(name)).toBe(false);
		expect(shapes.file.test(`${name}.old`)).toBe(false);
		expect(shapes.rotation.test(`${name}.old`)).toBe(false);
	});

	it("pins the crash log's name and its place directly inside the session artifact directory", () => {
		const { name, site } = stderrLogConstruction();
		expect(name).toBe("kernel-stderr.log");
		// Two arguments, the first of them the snapshot directory: the log is a sibling of
		// `kernel-state/`, not a generation inside it.
		expect(site).toMatch(/join\(\s*snapshotDir,\s*"kernel-stderr\.log"\s*\)/);

		const wiring = snapshotDirWiring();
		expect(wiring.fromArtifactDir).toBe(true);
	});

	it("is invisible to the kernel-snapshot class, which judges generations only", () => {
		const { name } = stderrLogConstruction();
		// Positive control: the predicate can say yes.
		expect(isKernelSnapshotGenerationName(kernelSnapshotGenerationName())).toBe(true);
		expect(isKernelSnapshotGenerationName(name)).toBe(false);
		expect(isKernelSnapshotGenerationName(`${name}.old`)).toBe(false);
	});

	it("is not an R3 candidate even when it sits in the log directory next to real socket logs", async () => {
		const f = fixture();
		const { name } = stderrLogConstruction();
		const deadSocketLog = socketLogFileName(join(f.roots.tmpDir, "gone-1234", "custom.sock"));

		// The control that proves R3 is running and reclaiming by age in this very directory.
		const control = join(f.roots.logsDir, deadSocketLog);
		writeFileSync(control, "dead socket\n");
		const crashLog = join(f.roots.logsDir, name);
		const rotated = join(f.roots.logsDir, `${name}.old`);
		for (const path of [control, crashLog, rotated]) {
			writeFileSync(path, "aged\n");
			ageTree(path, 60 * DAY_MS);
		}

		const result = await logsModule.scanAndReclaim(makeContext(f));

		expect(result.reclaimed).toBe(1);
		expect(existsSync(control)).toBe(false);
		// Not reclaimed, not scanned, not even reported as skipped: the shape whitelist means
		// R3 never looks at them, so no age judgement was made about them at all.
		expect(existsSync(crashLog)).toBe(true);
		expect(existsSync(rotated)).toBe(true);
		expect(result.scanned).toBe(1);
		expect(result.skipped.some((entry) => entry.path === crashLog)).toBe(false);
		expect(result.skipped.some((entry) => entry.path === rotated)).toBe(false);
	});

	it("is reclaimed with its directory by artifact-residue once the session is provably deleted", async () => {
		const f = fixture();
		const { sessionDir, crashLog, rotated } = crashedSessionDir(f);
		recordSessionArtifactTombstone(f.artifactRoot, SESSION_ID, { now: new Date(Date.now() - 20 * DAY_MS) });
		ageTree(sessionDir, 30 * DAY_MS);

		const report = await runRetentionSweep({ settings: settings(), roots: f.roots });

		expect(existsSync(crashLog)).toBe(false);
		expect(existsSync(rotated)).toBe(false);
		expect(existsSync(sessionDir)).toBe(false);
		expect(classResult(report, "artifact-residue-dirs").reclaimed).toBe(1);
		// The age-based class never saw a thing: it scans the log directory by shape.
		expect(classResult(report, "logs").scanned).toBe(0);
		expect(classResult(report, "logs").reclaimed).toBe(0);
		expect(skipReason(report, crashLog)).toBeUndefined();
	});

	it("keeps the crash log at any age while the session may still come back", async () => {
		const f = fixture();
		const { sessionDir, crashLog, rotated } = crashedSessionDir(f);
		// A transcript anywhere in the tree is the session's own claim on its bytes; there is
		// no tombstone, so nothing proves the session is gone.
		writeFileSync(join(f.roots.sessionsDir, `${SESSION_ID}.jsonl`), '{"type":"session"}\n');
		ageTree(sessionDir, 300 * DAY_MS);

		const report = await runRetentionSweep({ settings: settings(), roots: f.roots });

		expect(existsSync(crashLog)).toBe(true);
		expect(existsSync(rotated)).toBe(true);
		expect(existsSync(sessionDir)).toBe(true);
		expect(classResult(report, "artifact-residue-dirs").reclaimed).toBe(0);
		expect(skipReason(report, sessionDir)).toMatch(/^reference:transcript:/);
		// And still no age criterion touched it, however old it is.
		expect(classResult(report, "logs").scanned).toBe(0);
	});
});
