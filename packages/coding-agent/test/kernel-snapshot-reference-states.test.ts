// Kernel snapshot reference states.
//
// `<artifactDir>/kernel-state/.in-use/<pid>.json` is the only evidence that a
// running kernel still reads a generation, so reading it is a deletion decision:
// it shares the venv law (kernel/venv-in-use.ts), where "cannot be disproved"
// must never read as "gone". These tests pin the four states of one entry, and
// the red one first: a *truncated* reference (a short write) of a live pid used
// to read as "no record", so the entry was swept and the generation it named was
// offered to the sweep - the payload of a kernel that is still running.

import { spawnSync } from "node:child_process";
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
import {
	KERNEL_SNAPSHOT_IN_USE_DIR_NAME,
	kernelSnapshotGenerationsDir,
	planKernelSnapshotReclaim,
	readKernelSnapshotGenerationState,
	sweepStaleKernelSnapshotReference,
} from "../src/core/retention/kernel-snapshot.js";
import { retentionRoots } from "../src/core/retention/reports.js";
import { runRetentionSweep } from "../src/core/retention/sweep.js";
import type { RetentionRoots, RetentionSweepReport } from "../src/core/retention/types.js";
import {
	recordSessionArtifactTombstone,
	resetSessionArtifactTombstoneCache,
} from "../src/core/session-artifact-tombstones.js";
import { getProcessStartId } from "../src/core/session-lease.js";
import { resolveRetentionSettings } from "../src/core/settings-manager.js";

const SESSION_ID = "98000000-7777-7777-8777-980000000000";
const DAY_MS = 86_400_000;

/** Roots of a real retention sweep, for the two end-to-end tests below. */
function sweepFixture(): { root: string; artifactRoot: string; roots: RetentionRoots } {
	const root = mkdtempSync(join(tmpdir(), "kernel-snapshot-sweep-"));
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
	const value: RetentionRoots = {
		...retentionRoots({ agentDir }),
		tmpDir,
		kernelVenvBase: join(root, "kernel-venv"),
	};
	return { root, artifactRoot: value.artifactRoot, roots: value };
}

/**
 * One artifact directory holding a generation layout whose `<pid>.json` reference is a truncated
 * record of this (live) test process, naming `references` when the layout also holds a second
 * generation.
 */
function kernelSnapshotArtifact(
	f: { artifactRoot: string },
	referencedGeneration: string,
	...rest: [string, { secondGeneration?: boolean }?]
): { artifact: string; generations: string; references: string; truncated: string } {
	const artifact = join(f.artifactRoot, SESSION_ID);
	const generations = kernelSnapshotGenerationsDir(artifact);
	const references = join(generations, KERNEL_SNAPSHOT_IN_USE_DIR_NAME);
	mkdirSync(references, { recursive: true, mode: 0o700 });
	writeFileSync(join(generations, referencedGeneration), "payload");
	if (rest[1]?.secondGeneration) writeFileSync(join(generations, NEWER), "payload");
	const complete = record({ pid: process.pid, sessionId: "s".repeat(2000), generation: referencedGeneration });
	const truncated = join(references, `${process.pid}.json`);
	writeFileSync(truncated, complete.slice(0, 1024), { mode: 0o600 });
	return { artifact, generations, references, truncated };
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
			// Children first: a directory's own mtime must not be re-set by the walk after its
			// contents, or the judgement would see a fresh directory.
			if (entry.isDirectory()) walk(join(current, entry.name));
			else utimesSync(join(current, entry.name), when, when);
		}
		utimesSync(current, when, when);
	};
	walk(path);
}

/** A pid that existed a moment ago and is reaped now: never a live reference holder. */
function deadPid(): number {
	const result = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
		encoding: "utf8",
	});
	expect(result.status).toBe(0);
	const pid = Number.parseInt(result.stdout.trim(), 10);
	expect(Number.isInteger(pid) && pid > 0).toBe(true);
	return pid;
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	resetSessionArtifactTombstoneCache();
});

const OLDER = "20260101T000000-aaaaaa.dill";
const NEWER = "20260102T000000-bbbbbb.dill";

interface Fixture {
	root: string;
	artifact: string;
	generations: string;
	references: string;
}

function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "kernel-snapshot-states-"));
	roots.push(root);
	const artifact = join(root, "artifact");
	const generations = kernelSnapshotGenerationsDir(artifact);
	const references = join(generations, KERNEL_SNAPSHOT_IN_USE_DIR_NAME);
	mkdirSync(references, { recursive: true, mode: 0o700 });
	return { root, artifact, generations, references };
}

function addGeneration(f: Fixture, name: string): string {
	const path = join(f.generations, name);
	writeFileSync(path, "payload");
	return path;
}

function referencePath(f: Fixture, name: string): string {
	return join(f.references, name);
}

function record(fields: Record<string, unknown>): string {
	return `${JSON.stringify({ version: 1, recordedAt: new Date().toISOString(), ...fields })}\n`;
}

describe("kernel snapshot reference states", () => {
	it("keeps a truncated reference of a live pid and never reclaims its generation", () => {
		// A full disk truncates the record write (POSIX write returns a short count), so the
		// bytes on disk are a prefix of the JSON. The holder is alive: "cannot be parsed" must
		// read as "in use", because unlinking that entry is what frees a generation a running
		// kernel is still importing from.
		const f = fixture();
		const generation = addGeneration(f, OLDER);
		const complete = record({ pid: process.pid, sessionId: "s".repeat(2000), generation: OLDER });
		const truncated = referencePath(f, `${process.pid}.json`);
		writeFileSync(truncated, complete.slice(0, 1024), { mode: 0o600 });
		expect(() => JSON.parse(complete.slice(0, 1024))).toThrow();

		const state = readKernelSnapshotGenerationState(f.artifact);
		expect(state.swept).toEqual([]);
		expect(state.unknown).toBe(true);
		expect(state.references.map((reference) => reference.pid)).toEqual([process.pid]);
		expect(existsSync(truncated)).toBe(true);

		// With every retired generation reclaimable (retention 0), an unreferenced one would be
		// removed. The truncated entry keeps the generation instead.
		const plan = planKernelSnapshotReclaim(f.artifact, { retention: 0 });
		expect(plan.remove).toEqual([]);
		expect(plan.kept).toEqual([{ path: generation, reason: "unknown" }]);
		expect(existsSync(generation)).toBe(true);
	});

	it("keeps a reference whose file name does not name the pid running inside it", () => {
		// The name and the record disagree while the recorded holder runs: nothing proves the
		// entry is stale, so it is kept as unverifiable. (The venv rule; the snapshot side used
		// to call this stale and unlink it.)
		const f = fixture();
		addGeneration(f, OLDER);
		const path = referencePath(f, `${deadPid()}.json`);
		writeFileSync(path, record({ pid: process.pid, generation: OLDER }), { mode: 0o600 });

		const state = readKernelSnapshotGenerationState(f.artifact);
		expect(state.swept).toEqual([]);
		expect(state.unknown).toBe(true);
		expect(existsSync(path)).toBe(true);
		expect(planKernelSnapshotReclaim(f.artifact, { retention: 0 }).remove).toEqual([]);
	});

	it("sweeps a reference whose holder is provably gone (positive control)", () => {
		// The other direction still has to work: a dead holder frees its generation, or nothing
		// is ever reclaimed.
		const f = fixture();
		const generation = addGeneration(f, OLDER);
		const dead = deadPid();
		const path = referencePath(f, `${dead}.json`);
		writeFileSync(path, record({ pid: dead, generation: OLDER }), { mode: 0o600 });

		const state = readKernelSnapshotGenerationState(f.artifact);
		expect(state.unknown).toBe(false);
		expect(state.references).toEqual([]);
		expect(state.swept).toEqual([path]);
		expect(existsSync(path)).toBe(false);

		const plan = planKernelSnapshotReclaim(f.artifact, { retention: 0 });
		expect(plan.remove).toEqual([{ path: generation, bytes: "payload".length }]);
	});

	it("sweeps a reference whose live pid was reused by another process", () => {
		// A live pid alone is not identity: a start-id mismatch means the recorded kernel is gone.
		const f = fixture();
		addGeneration(f, OLDER);
		const path = referencePath(f, `${process.pid}.json`);
		writeFileSync(
			path,
			record({ pid: process.pid, processStartId: "ps:Mon Jan  1 00:00:00 2001", generation: OLDER }),
			{ mode: 0o600 },
		);
		expect(typeof getProcessStartId(process.pid)).toBe("string");

		const state = readKernelSnapshotGenerationState(f.artifact);
		expect(state.references).toEqual([]);
		expect(state.swept).toEqual([path]);
	});

	it("keeps a reference it cannot disprove when the start id is unavailable", () => {
		const f = fixture();
		const generation = addGeneration(f, OLDER);
		const path = referencePath(f, `${process.pid}.json`);
		writeFileSync(path, record({ pid: process.pid, generation: OLDER }), { mode: 0o600 });

		const state = readKernelSnapshotGenerationState(f.artifact);
		expect(state.references.map((reference) => reference.pid)).toEqual([process.pid]);
		expect(state.swept).toEqual([]);
		expect(planKernelSnapshotReclaim(f.artifact, { retention: 0 }).remove).toEqual([]);
		expect(existsSync(generation)).toBe(true);
	});

	it("re-reads a reference before unlinking it, so a rewritten one is not deleted", () => {
		// Judging and unlinking are two steps, and the writer is another process: the entry can
		// be rewritten in between. The second read is the only thing that authorises the unlink.
		const f = fixture();
		const staleName = `${deadPid()}.json`;
		const rewritten = referencePath(f, staleName);
		writeFileSync(rewritten, record({ pid: process.pid, sessionId: "rewritten" }), { mode: 0o600 });

		expect(sweepStaleKernelSnapshotReference(rewritten, staleName.replace(/\.json$/, ""))).toBe("kept");
		expect(existsSync(rewritten)).toBe(true);

		// Positive control: an entry whose record is still provably gone is removed.
		const gone = deadPid();
		const gonePath = referencePath(f, `${gone}.json`);
		writeFileSync(gonePath, record({ pid: gone }), { mode: 0o600 });
		expect(sweepStaleKernelSnapshotReference(gonePath, String(gone))).toBe("swept");
		expect(existsSync(gonePath)).toBe(false);
	});

	it("does not reclaim a live kernel's generation through the retention sweep", async () => {
		// End to end, the way the sweep actually runs: two generations, the older one named by a
		// truncated reference of a live pid. Retention 1 keeps the newest unreferenced one, so the
		// older one is removed the moment its reference reads as "no record".
		const f = sweepFixture();
		const { generations, references, truncated } = kernelSnapshotArtifact(f, OLDER, OLDER, {
			secondGeneration: true,
		});

		const report: RetentionSweepReport = await runRetentionSweep({
			settings: resolveRetentionSettings({ kernelSnapshotReclaimEnabled: true, kernelSnapshotGenerations: 1 }),
			roots: f.roots,
		});

		expect(existsSync(truncated)).toBe(true);
		expect(existsSync(join(generations, OLDER))).toBe(true);
		expect(existsSync(join(generations, NEWER))).toBe(true);
		expect(readdirSync(references)).toEqual([`${process.pid}.json`]);
		expect(report.classes.find((entry) => entry.class === "kernel-snapshot-generations")?.reclaimed).toBe(0);
	});

	it("keeps a deleted session's artifact directory and the generation a live kernel reads", async () => {
		// The compound case: the session is on record as deleted, so the artifact-residue class
		// would reclaim the directory - which holds the snapshot of a kernel that is still
		// running. The truncated reference makes the reference state unknown, and that is what
		// keeps the directory (the skip reason is the reference state, not the tombstone).
		// Before the fix the entry was swept and the generation the live kernel reads was
		// reclaimed in the same pass; the directory only survived because that unlink had just
		// made it look newer than the tombstone - protection by accident.
		const f = sweepFixture();
		const { artifact, generations, truncated } = kernelSnapshotArtifact(f, OLDER, OLDER, {
			secondGeneration: true,
		});
		recordSessionArtifactTombstone(f.roots.artifactRoot, SESSION_ID, {
			now: new Date(Date.now() - 20 * DAY_MS),
			reason: "deleted",
		});
		resetSessionArtifactTombstoneCache();
		ageTree(artifact, 30 * DAY_MS);

		const report: RetentionSweepReport = await runRetentionSweep({
			settings: resolveRetentionSettings({ kernelSnapshotReclaimEnabled: true, kernelSnapshotGenerations: 1 }),
			roots: f.roots,
		});

		expect(existsSync(artifact)).toBe(true);
		expect(existsSync(join(generations, OLDER))).toBe(true);
		expect(existsSync(truncated)).toBe(true);
		const kept = report.classes.flatMap((entry) => entry.skipped).find((entry) => entry.path === artifact);
		expect(kept?.reason).toMatch(/^unverifiable:kernel-snapshot-reference-state$/);
	});

	it.skipIf(process.platform === "win32")("reports a short write instead of storing a truncated record", () => {
		// The third clause of the law, on the write side: a full disk makes writeSync stop at the
		// limit and return the partial count rather than throw, so a writer that ignores the count
		// publishes a truncated record while believing it recorded a reference. The shared writer
		// checks the count, so the failure is reported (and the caller can publish a stronger
		// signal), and the truncated bytes are then kept by the reader - never swept.
		const root = mkdtempSync(join(tmpdir(), "kernel-snapshot-shortwrite-"));
		roots.push(root);
		const artifact = join(root, "artifact");
		const generations = kernelSnapshotGenerationsDir(artifact);
		const references = join(generations, KERNEL_SNAPSHOT_IN_USE_DIR_NAME);
		mkdirSync(references, { recursive: true, mode: 0o700 });
		const moduleUrl = new URL("../src/core/kernel/reference-records.js", import.meta.url).pathname;
		const driver = join(root, "short-write-driver.ts");
		writeFileSync(
			driver,
			[
				`import { writeReferenceFileSync } from ${JSON.stringify(moduleUrl)};`,
				'import { join } from "node:path";',
				"const [dir, generation] = process.argv.slice(2) as [string, string];",
				// The reference is named for its holder, and a long session id pushes the record
				// well past the 1 KiB file size limit of this child.
				'const file = join(dir, String(process.pid) + ".json");',
				"const failure = writeReferenceFileSync(file, dir, {",
				"  version: 1,",
				"  pid: process.pid,",
				'  sessionId: "s".repeat(4096),',
				"  generation,",
				"});",
				"process.stdout.write(JSON.stringify({ file, failure: failure ?? null }));",
			].join("\n"),
		);
		const result = spawnSync(
			"bash",
			[
				"-c",
				`ulimit -f 1; exec ${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(driver)} ${JSON.stringify(references)} ${JSON.stringify(OLDER)}`,
			],
			{
				// tsx must stay out of its cache here: this process may not write a file larger than
				// the limit either, and a truncated cache would poison other runs.
				env: { ...process.env, TSX_DISABLE_CACHE: "1" },
				encoding: "utf8",
			},
		);
		expect(result.stderr).toBe("");
		expect(result.signal).toBeNull();
		expect(result.status).toBe(0);
		const report = JSON.parse(result.stdout) as {
			file: string;
			failure: { reason: string; partialDelete: boolean } | null;
		};
		expect(report.failure).not.toBeNull();
		// macOS raises the file-size limit as EFBIG after filling to the limit; a plain full disk
		// makes writeSync return a short count. Both are reported, and both say bytes landed.
		expect(report.failure?.reason).toBeTruthy();
		expect(report.failure?.partialDelete).toBe(true);

		// The bytes are on disk, they are not a record, and the reader keeps the generation: the
		// entry is unverifiable, so it counts as a reference and makes this directory unknown.
		addGeneration({ root, artifact, generations, references }, OLDER);
		const onDisk = readFileSync(report.file, "utf8");
		expect(onDisk.length).toBeGreaterThan(0);
		expect(() => JSON.parse(onDisk)).toThrow();

		const state = readKernelSnapshotGenerationState(artifact);
		expect(state.swept).toEqual([]);
		expect(state.unknown).toBe(true);
		expect(existsSync(report.file)).toBe(true);
		expect(planKernelSnapshotReclaim(artifact, { retention: 0 }).remove).toEqual([]);
	});

	it("sweeps a stale reference and claims nothing when the sweep is off (positive control)", () => {
		// The staleness sweep itself is not disabled by the reclaim switch: a provably dead
		// reference is this module's own bookkeeping. Pinned so the red tests above cannot be
		// satisfied by turning the sweep off wholesale.
		const f = fixture();
		const dead = deadPid();
		const path = referencePath(f, `${dead}.json`);
		writeFileSync(path, record({ pid: dead }), { mode: 0o600 });
		readKernelSnapshotGenerationState(f.artifact);
		expect(readdirSync(f.references)).toEqual([]);
	});
});
