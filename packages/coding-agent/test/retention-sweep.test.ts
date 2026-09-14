import type { Dirent } from "node:fs";
import {
	chmodSync,
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
import { retentionRoots } from "../src/core/retention/reports.js";
import { runRetentionSweep } from "../src/core/retention/sweep.js";
import type { RetentionRoots, RetentionSweepReport } from "../src/core/retention/types.js";
import {
	recordSessionArtifactTombstone,
	resetSessionArtifactTombstoneCache,
} from "../src/core/session-artifact-tombstones.js";
import { getProcessStartId } from "../src/core/session-lease.js";
import { resolveRetentionSettings } from "../src/core/settings-manager.js";

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
	const root = mkdtempSync(join(tmpdir(), "retention-sweep-"));
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

describe("retention sweep - multi-root transcript evidence (red test R-2)", () => {
	it("keeps a child's artifact directory whose transcript only lives under sub-*", async () => {
		const f = fixture();
		const parentId = "aaaaaaaa-1111-7111-8111-aaaaaaaaaaaa";
		const childId = "bbbbbbbb-2222-7222-8222-bbbbbbbbbbbb";
		sessionFile(f.agentDir, parentId);
		const parentArtifact = join(f.artifactRoot, parentId);
		mkdirSync(join(parentArtifact, "session-artifacts", childId), { recursive: true });
		const childArtifact = join(parentArtifact, "session-artifacts", childId);
		writeFileSync(join(childArtifact, "semantic-edges.jsonl"), '{"type":"edge"}\n');
		mkdirSync(join(parentArtifact, "sub-12345678"), { recursive: true });
		writeFileSync(join(parentArtifact, "sub-12345678", `${childId}.jsonl`), '{"type":"session"}\n');
		// Old enough to be a candidate by age alone.
		ageTree(childArtifact, 30 * DAY_MS);

		const settings = resolveRetentionSettings({ deletedSessionResidueDays: 7 });
		const report = await runRetentionSweep({ settings, roots: f.roots });
		expect(existsSync(childArtifact)).toBe(true);
		const skipped = allSkipped(report);
		const kept = skipped.find((entry) => entry.path === childArtifact);
		expect(kept?.reason).toMatch(/^reference:transcript:/);
	});

	it("reclaims the same directory once the transcript is gone (positive control)", async () => {
		const f = fixture();
		const parentId = "aaaaaaaa-1111-7111-8111-aaaaaaaaaaaa";
		const childId = "bbbbbbbb-2222-7222-8222-bbbbbbbbbbbb";
		sessionFile(f.agentDir, parentId);
		const childArtifact = join(f.artifactRoot, parentId, "session-artifacts", childId);
		mkdirSync(childArtifact, { recursive: true });
		writeFileSync(join(childArtifact, "semantic-edges.jsonl"), '{"type":"edge"}\n');
		mkdirSync(join(f.artifactRoot, parentId, "sub-12345678"), { recursive: true });
		ageTree(childArtifact, 30 * DAY_MS);
		// The ledger is the positive evidence that this child is gone: it records the
		// spawn, then the delete, against the transcript path that no longer exists.
		const transcriptPath = join(f.artifactRoot, parentId, "sub-12345678", `${childId}.jsonl`);
		writeFileSync(
			join(f.roots.agentDir, "rlm-ledger", "ledger.jsonl"),
			`${JSON.stringify({ v: 1, op: "spawn", at: new Date(0).toISOString(), childId: "sub-12345678", child: transcriptPath })}\n` +
				`${JSON.stringify({ v: 1, op: "delete", at: new Date(0).toISOString(), childId: "sub-12345678", child: transcriptPath })}\n`,
		);

		const settings = resolveRetentionSettings({ deletedSessionResidueDays: 7 });
		const report = await runRetentionSweep({ settings, roots: f.roots });
		expect(existsSync(childArtifact)).toBe(false);
		expect(classResult(report, "artifact-residue-dirs").reclaimed).toBe(1);
	});

	it("keeps a live session's artifact directory even when it is old and empty", async () => {
		const f = fixture();
		const liveId = "cccccccc-3333-7333-8333-cccccccccccc";
		sessionFile(f.agentDir, liveId);
		const artifact = join(f.artifactRoot, liveId);
		mkdirSync(join(artifact, "sub-deadbeef"), { recursive: true });
		ageTree(artifact, 60 * DAY_MS);

		const report = await runRetentionSweep({ settings: resolveRetentionSettings({}), roots: f.roots });
		expect(existsSync(artifact)).toBe(true);
		expect(allSkipped(report).find((entry) => entry.path === artifact)?.reason).toMatch(/^reference:transcript:/);
	});
});

describe("retention sweep - deleted-session residue (ruling 3)", () => {
	it("removes a tombstoned session's leftovers and never the global harness library", async () => {
		const f = fixture();
		const id = "dddddddd-4444-7444-8444-dddddddddddd";
		const artifact = join(f.artifactRoot, id);
		mkdirSync(join(artifact, "harness"), { recursive: true });
		writeFileSync(join(artifact, "semantic-edges.jsonl"), '{"type":"edge"}\n');
		writeFileSync(join(artifact, "harness", "harness_state.json"), "{}");
		mkdirSync(join(f.agentDir, "harness"), { recursive: true });
		const globalHarness = join(f.agentDir, "harness", "harness_state.json");
		writeFileSync(globalHarness, '{"global":true}');
		recordSessionArtifactTombstone(f.artifactRoot, id, { now: new Date(Date.now() - 20 * DAY_MS) });
		ageTree(artifact, 30 * DAY_MS);

		const report = await runRetentionSweep({ settings: resolveRetentionSettings({}), roots: f.roots });
		expect(existsSync(artifact)).toBe(false);
		expect(existsSync(globalHarness)).toBe(true);
		expect(readFileSync(globalHarness, "utf8")).toBe('{"global":true}');
		expect(classResult(report, "artifact-residue-dirs").reclaimed).toBe(1);
	});

	it("reclaims an empty resurrected directory after the window", async () => {
		const f = fixture();
		const id = "eeeeeeee-5555-7555-8555-eeeeeeeeeeee";
		const artifact = join(f.artifactRoot, id);
		mkdirSync(join(artifact, "sub-abcdef12"), { recursive: true });
		recordSessionArtifactTombstone(f.artifactRoot, id, { now: new Date(Date.now() - 20 * DAY_MS) });
		ageTree(artifact, 30 * DAY_MS);

		const report = await runRetentionSweep({ settings: resolveRetentionSettings({}), roots: f.roots });
		expect(existsSync(artifact)).toBe(false);
		expect(classResult(report, "artifact-empty-dirs").reclaimed).toBe(1);
	});

	it("reports the per-sweep cap and finishes the job on the next sweep (red test R-11)", async () => {
		const f = fixture();
		const ids = [
			"11111111-6666-7666-8666-111111111111",
			"22222222-6666-7666-8666-222222222222",
			"33333333-6666-7666-8666-333333333333",
		];
		for (const id of ids) {
			const artifact = join(f.artifactRoot, id);
			mkdirSync(artifact, { recursive: true });
			writeFileSync(join(artifact, "kernel-state.json"), "{}");
			recordSessionArtifactTombstone(f.artifactRoot, id, { now: new Date(Date.now() - 20 * DAY_MS) });
			ageTree(artifact, 30 * DAY_MS);
		}
		const settings = resolveRetentionSettings({ maxDeleteEntriesPerSweep: 1 });
		const first = await runRetentionSweep({ settings, roots: f.roots });
		expect(first.capped).toBe(true);
		expect(first.totals.reclaimed).toBe(1);
		expect(existsSync(join(f.artifactRoot, ids[0]))).toBe(false);
		expect(existsSync(join(f.artifactRoot, ids[1]))).toBe(true);

		const second = await runRetentionSweep({ settings, roots: f.roots });
		expect(second.totals.reclaimed).toBe(1);
		const third = await runRetentionSweep({ settings, roots: f.roots });
		expect(third.totals.reclaimed).toBe(1);
		expect(existsSync(join(f.artifactRoot, ids[1]))).toBe(false);
		expect(existsSync(join(f.artifactRoot, ids[2]))).toBe(false);
	});
});

describe("retention sweep - report discipline", () => {
	it("keeps the dry run and the real run in the same shape (red test R-5)", async () => {
		const f = fixture();
		const ids = ["91000000-7777-7777-8777-910000000000", "92000000-7777-7777-8777-920000000000"];
		for (const id of ids) {
			const artifact = join(f.artifactRoot, id);
			mkdirSync(artifact, { recursive: true });
			writeFileSync(join(artifact, "semantic-edges.jsonl"), '{"type":"edge"}\n');
			recordSessionArtifactTombstone(f.artifactRoot, id, { now: new Date(Date.now() - 20 * DAY_MS) });
			ageTree(artifact, 30 * DAY_MS);
		}
		const settings = resolveRetentionSettings({});
		const dry = await runRetentionSweep({ settings, roots: f.roots, forceDryRun: true });
		expect(dry.dryRun).toBe(true);
		expect(dry.totals.reclaimed).toBe(2);
		for (const id of ids) expect(existsSync(join(f.artifactRoot, id))).toBe(true);

		const real = await runRetentionSweep({ settings, roots: f.roots });
		expect(real.dryRun).toBe(false);
		expect(real.totals.reclaimed).toBe(dry.totals.reclaimed);
		expect(real.totals.bytes).toBe(dry.totals.bytes);
		// Same class order and same well-formed report - only the removal differs. The
		// per-class `scanned` count may differ between the two passes of one sweep
		// because the residue class removes what a later class would have scanned in
		// the real run; the dry run sees the whole tree in every class.
		expect(real.classes.map((entry) => entry.class)).toEqual(dry.classes.map((entry) => entry.class));
		for (const id of ids) expect(existsSync(join(f.artifactRoot, id))).toBe(false);
	});

	it("never lists a reclaimed path as skipped, and gives every skip a reason (red test R-12)", async () => {
		const f = fixture();
		const id = "93000000-7777-7777-8777-930000000000";
		const artifact = join(f.artifactRoot, id);
		mkdirSync(artifact, { recursive: true });
		writeFileSync(join(artifact, "kernel-state.json"), "{}");
		recordSessionArtifactTombstone(f.artifactRoot, id, { now: new Date(Date.now() - 20 * DAY_MS) });
		ageTree(artifact, 30 * DAY_MS);
		// A young sibling that must be skipped.
		const youngId = "94000000-7777-7777-8777-940000000000";
		mkdirSync(join(f.artifactRoot, youngId, "sub-deadbeef"), { recursive: true });

		const report = await runRetentionSweep({ settings: resolveRetentionSettings({}), roots: f.roots });
		const reclaimedPaths = [artifact];
		for (const entry of allSkipped(report)) {
			expect(entry.reason.length).toBeGreaterThan(0);
			expect(reclaimedPaths).not.toContain(entry.path);
		}
		expect(report.totals.reclaimed).toBeGreaterThan(0);
		expect(allSkipped(report).some((entry) => entry.reason.startsWith("young:"))).toBe(true);
	});

	it("reports a refused delete as failed, not as unverifiable (red test R-13)", async () => {
		const f = fixture();
		const id = "95000000-7777-7777-8777-950000000000";
		const artifact = join(f.artifactRoot, id);
		mkdirSync(artifact, { recursive: true });
		writeFileSync(join(artifact, "kernel-state.json"), "{}");
		recordSessionArtifactTombstone(f.artifactRoot, id, { now: new Date(Date.now() - 20 * DAY_MS) });
		ageTree(artifact, 30 * DAY_MS);
		// A read-only parent refuses the rename the delete primitive starts with.
		const locked = process.platform !== "win32" && (process.getuid?.() ?? 0) !== 0;
		chmodSync(f.artifactRoot, 0o500);
		try {
			const report = await runRetentionSweep({ settings: resolveRetentionSettings({}), roots: f.roots });
			if (!locked) return;
			expect(report.totals.reclaimed).toBe(0);
			const failed = allSkipped(report).find((entry) => entry.path === artifact);
			expect(failed?.reason).toMatch(/^failed:/);
		} finally {
			chmodSync(f.artifactRoot, 0o700);
		}
	});

	it("only reports when the master switch is off", async () => {
		const f = fixture();
		const id = "96000000-7777-7777-8777-960000000000";
		const artifact = join(f.artifactRoot, id);
		mkdirSync(artifact, { recursive: true });
		writeFileSync(join(artifact, "kernel-state.json"), "{}");
		recordSessionArtifactTombstone(f.artifactRoot, id, { now: new Date(Date.now() - 20 * DAY_MS) });
		ageTree(artifact, 30 * DAY_MS);

		const report = await runRetentionSweep({
			settings: resolveRetentionSettings({ enabled: false }),
			roots: f.roots,
		});
		expect(report.enabled).toBe(false);
		expect(report.dryRun).toBe(true);
		expect(report.totals.reclaimed).toBeGreaterThan(0);
		expect(existsSync(artifact)).toBe(true);
	});
});

describe("retention sweep - stale leases (red test R-10)", () => {
	function leaseFixture(f: Fixture, name: string, owner: Record<string, unknown>): string {
		// A lease directory is named after the sha256 of the session path.
		const directory = join(f.roots.leasesRoot, `${name.padEnd(64, "0").slice(0, 64)}.lock`);
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, "owner.json"),
			JSON.stringify({
				version: 1,
				token: "t",
				sessionPath: join(f.agentDir, "sessions", "x.jsonl"),
				createdAt: new Date(0).toISOString(),
				...owner,
			}),
		);
		const past = new Date(Date.now() - 30 * DAY_MS);
		utimesSync(join(directory, "owner.json"), past, past);
		return directory;
	}

	it("reclaims a dead owner and a reused pid, keeps the live one", async () => {
		const f = fixture();
		const dead = leaseFixture(f, "a1", { pid: 999_999 });
		const reusedPid = leaseFixture(f, "b2", { pid: process.pid, processStartId: "1970-01-01T00:00:00Z" });
		const live = leaseFixture(f, "c3", {
			pid: process.pid,
			...(getProcessStartId(process.pid) ? { processStartId: getProcessStartId(process.pid) } : {}),
		});

		const report = await runRetentionSweep({ settings: resolveRetentionSettings({}), roots: f.roots });
		expect(existsSync(dead)).toBe(false);
		expect(existsSync(reusedPid)).toBe(false);
		expect(existsSync(live)).toBe(true);
		expect(classResult(report, "stale-leases").reclaimed).toBe(2);
		expect(allSkipped(report).find((entry) => entry.path === live)?.reason).toBe("in-use:pid");
	});

	it("keeps an unreadable owner record as unverifiable", async () => {
		const f = fixture();
		const directory = join(f.roots.leasesRoot, `${"d4".padEnd(64, "0")}.lock`);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "owner.json"), "{ torn");
		const report = await runRetentionSweep({ settings: resolveRetentionSettings({}), roots: f.roots });
		expect(existsSync(directory)).toBe(true);
		expect(allSkipped(report).find((entry) => entry.path === directory)?.reason).toMatch(/^unverifiable:/);
	});
});

describe("retention sweep - kernel snapshot generations (red test R-0/R-15)", () => {
	it("never removes the legacy single-file payload", async () => {
		const f = fixture();
		const id = "97000000-7777-7777-8777-970000000000";
		const artifact = join(f.artifactRoot, id);
		mkdirSync(artifact, { recursive: true });
		writeFileSync(join(artifact, "kernel-state.dill"), "legacy payload");
		writeFileSync(join(artifact, "kernel-state.json"), "{}");
		ageTree(artifact, 30 * DAY_MS);

		const report = await runRetentionSweep({
			settings: resolveRetentionSettings({ kernelSnapshotReclaimEnabled: true }),
			roots: f.roots,
		});
		expect(existsSync(join(artifact, "kernel-state.dill"))).toBe(true);
		expect(classResult(report, "kernel-snapshot-generations").reclaimed).toBe(0);
	});

	it("keeps the referenced generation and the newest retired one", async () => {
		const f = fixture();
		const id = "98000000-7777-7777-8777-980000000000";
		const artifact = join(f.artifactRoot, id);
		const generations = join(artifact, "kernel-state");
		mkdirSync(join(generations, ".in-use"), { recursive: true });
		const names = ["20260101T000000-aaaaaa.dill", "20260102T000000-bbbbbb.dill", "20260103T000000-cccccc.dill"];
		for (const name of names) writeFileSync(join(generations, name), "payload");
		// The oldest generation is referenced by a live kernel; the other two are not.
		writeFileSync(
			join(generations, ".in-use", `${process.pid}.json`),
			JSON.stringify({
				version: 1,
				pid: process.pid,
				processStartId: getProcessStartId(process.pid),
				generation: names[0],
			}),
		);

		const report = await runRetentionSweep({
			settings: resolveRetentionSettings({ kernelSnapshotReclaimEnabled: true, kernelSnapshotGenerations: 1 }),
			roots: f.roots,
		});
		expect(existsSync(join(generations, names[0]))).toBe(true);
		// Newest retired generation is retained; the middle one goes.
		expect(existsSync(join(generations, names[2]))).toBe(true);
		expect(existsSync(join(generations, names[1]))).toBe(false);
		expect(classResult(report, "kernel-snapshot-generations").reclaimed).toBe(1);
	});

	it("is off by default and only reports the generations it sees", async () => {
		const f = fixture();
		const artifact = join(f.artifactRoot, "99000000-7777-7777-8777-990000000000");
		const generations = join(artifact, "kernel-state");
		mkdirSync(join(generations, ".in-use"), { recursive: true });
		writeFileSync(join(generations, "20260101T000000-aaaaaa.dill"), "payload");
		writeFileSync(join(generations, "20260102T000000-bbbbbb.dill"), "payload");

		const report = await runRetentionSweep({ settings: resolveRetentionSettings({}), roots: f.roots });
		const result = classResult(report, "kernel-snapshot-generations");
		expect(result.disabled).toBe(true);
		expect(result.reclaimed).toBe(0);
		expect(existsSync(join(generations, "20260101T000000-aaaaaa.dill"))).toBe(true);
	});
});
