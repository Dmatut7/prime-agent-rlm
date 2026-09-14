// Kernel snapshot generations.
//
// The kernel's persisted namespace lives in `<artifactDir>/kernel-state.dill`,
// written in place (state-snapshot.ts). In-place overwrite means there is no
// "generation" to reclaim, so the design's R0 ("reclaim only unreferenced
// generations, keep the newest" - round-09 ruling 2) is implemented here as the
// generation layout a writer can adopt:
//
//   <artifactDir>/kernel-state/<stamp>-<rand>.dill      one generation per payload
//   <artifactDir>/kernel-state/.in-use/<pid>.json       one reference per live kernel
//
// One entry here is judged by the shared reference law (kernel/reference-records.ts),
// which is also the venv one: it decides whether a directory may be deleted, so
// `cannot disprove` must not read as `gone`. An entry that cannot be parsed (a
// truncated write) or that does not name the pid running inside it is therefore
// kept, counts as a reference, and makes the whole directory's state unknown - all
// of its generations are kept, not just the one the entry names.
//
// The legacy single-file layout (`<artifactDir>/kernel-state.dill`) is NEVER a
// generation here: kernels spawned by hosts that predate this module run from it
// without leaving references, so "no references" is not evidence that it is free
// (red test R-15). Deleting a deleted session's snapshot is the artifact-residue
// class's job, and only for a session that is provably gone.
import type { Dirent } from "node:fs";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	confirmReferenceIsStale,
	judgeReferenceEntry,
	parseReferenceRecord,
	REFERENCE_PID_FILE_NAME,
	type ReferenceRecord,
} from "../kernel/reference-records.js";
import { reclaimWithinBudget } from "./delete.js";
import {
	type RetentionClassContext,
	type RetentionClassModule,
	type RetentionClassResult,
	type RetentionSkip,
	SKIP,
} from "./types.js";

export const KERNEL_SNAPSHOT_GENERATIONS_DIR_NAME = "kernel-state";
export const KERNEL_SNAPSHOT_IN_USE_DIR_NAME = ".in-use";
/** Unreferenced generations kept for inspection; referenced ones are always kept. */
export const RETIRED_KERNEL_SNAPSHOT_RETENTION = 1;
/** File name of the legacy in-place payload, never judged as a generation. */
export const LEGACY_KERNEL_SNAPSHOT_BASENAME = "kernel-state.dill";

/** `<YYYYMMDDTHHMMSS>-<6 hex>`: sortable, and impossible to confuse with a pid file. */
const GENERATION_NAME = /^[0-9]{8}T[0-9]{6}-[0-9a-f]{6}\.dill$/;

export function kernelSnapshotGenerationsDir(artifactDir: string): string {
	return join(artifactDir, KERNEL_SNAPSHOT_GENERATIONS_DIR_NAME);
}

/** A fresh generation file name. The writer decides the directory; this is pure. */
export function kernelSnapshotGenerationName(now: Date = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
	const random = Math.random().toString(16).slice(2, 8).padEnd(6, "0");
	return `${stamp}-${random}.dill`;
}

export function isKernelSnapshotGenerationName(name: string): boolean {
	return GENERATION_NAME.test(name);
}

export function kernelSnapshotReferencePath(artifactDir: string, pid: number): string {
	return join(kernelSnapshotGenerationsDir(artifactDir), KERNEL_SNAPSHOT_IN_USE_DIR_NAME, `${pid}.json`);
}

export interface KernelSnapshotReference {
	pid: number;
	processStartId?: string;
	sessionId?: string;
	recordedAt?: string;
	referencePath: string;
}

export interface KernelSnapshotGenerationState {
	/** Generation file names (basenames) with at least one live reference. */
	referenced: Set<string>;
	/** Reference entries seen (live holders, and entries that cannot be disproved), for the report. */
	references: KernelSnapshotReference[];
	/** Reference files swept because their holder is provably gone. */
	swept: string[];
	/**
	 * The reference state could not be fully established: the reference directory
	 * could not be read, or an entry proves nothing either way (an unparseable
	 * record, a name that disagrees with a holder that runs). Callers must treat
	 * every generation as referenced: "cannot disprove" is not "gone".
	 */
	unknown: boolean;
	/** Generation file names present on disk. */
	generations: string[];
}

/** Generation this reference was recorded for, when the writer said so. */
function referenceGeneration(record: ReferenceRecord | undefined): string | undefined {
	const value = record?.raw.generation;
	return typeof value === "string" ? value : undefined;
}

function isNodeError(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException)?.code === code;
}

/**
 * Sweep one entry a first read judged stale, after judging it a second time.
 *
 * The writer is another process and neither the record write nor this sweep is atomic, so the
 * file can become a live reference (or an unreadable one) between the read and the unlink. The
 * confirmation read is the only thing that authorises the removal.
 */
export function sweepStaleKernelSnapshotReference(referencePath: string, pidName: string): "swept" | "kept" {
	if (!confirmReferenceIsStale(referencePath, pidName)) return "kept";
	try {
		rmSync(referencePath, { force: true });
		return "swept";
	} catch {
		// Left for the next sweep; it is not counted as a reference either.
		return "kept";
	}
}

/**
 * Reference state of one artifact directory's generations. Provably stale
 * reference files are removed in passing (they are this module's own
 * bookkeeping, not user data) and the stale holder frees its generation.
 */
export function readKernelSnapshotGenerationState(
	artifactDir: string,
	options: { sweepStale?: boolean } = {},
): KernelSnapshotGenerationState {
	const dir = kernelSnapshotGenerationsDir(artifactDir);
	const state: KernelSnapshotGenerationState = {
		referenced: new Set(),
		references: [],
		swept: [],
		unknown: false,
		generations: [],
	};
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return state;
		state.unknown = true;
		return state;
	}
	for (const entry of entries) {
		if (entry.isFile() && !entry.isSymbolicLink() && isKernelSnapshotGenerationName(entry.name)) {
			state.generations.push(entry.name);
		}
	}
	let referenceEntries: Dirent[];
	try {
		referenceEntries = readdirSync(join(dir, KERNEL_SNAPSHOT_IN_USE_DIR_NAME), { withFileTypes: true });
	} catch (error) {
		if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return state;
		state.unknown = true;
		return state;
	}
	for (const entry of [...referenceEntries].sort((a, b) => a.name.localeCompare(b.name))) {
		// One reference file per live kernel pid, named `<pid>.json`. A name this
		// bookkeeping never writes is ignored: it neither protects a generation nor
		// gets deleted.
		const pidName = entry.name.endsWith(".json") ? entry.name.slice(0, -".json".length) : entry.name;
		if (!REFERENCE_PID_FILE_NAME.test(pidName)) continue;
		const referencePath = join(dir, KERNEL_SNAPSHOT_IN_USE_DIR_NAME, entry.name);
		const verdict = judgeReferenceEntry(referencePath, pidName);
		// A symlink or a directory is not a record this bookkeeping writes.
		if (verdict === "foreign") continue;
		if (verdict === "stale") {
			// Read-only mode for a dry run: dropping a stale reference is a filesystem
			// change, so a dry run only reports that it is not counted (review N-2). The
			// second read inside the sweep is what authorises the unlink.
			if (options.sweepStale !== false && sweepStaleKernelSnapshotReference(referencePath, pidName) === "swept") {
				state.swept.push(referencePath);
			}
			continue;
		}
		const record = parseReferenceRecord(referencePath);
		// `unverifiable` proves nothing either way: an unparseable record is a truncated
		// write, and a name that disagrees with a record whose holder runs is not a dead
		// holder. It counts as a reference and makes this directory's state unknown, so
		// none of its generations is a candidate. Reading it as stale (which this module
		// used to do) unlinks the entry of a live kernel and frees the generation that
		// kernel is still reading from.
		if (verdict === "unverifiable") state.unknown = true;
		const generation = verdict === "live" ? referenceGeneration(record) : undefined;
		if (generation !== undefined) state.referenced.add(generation);
		state.references.push({
			pid: record?.pid ?? Number(pidName),
			...(record?.processStartId ? { processStartId: record.processStartId } : {}),
			...(record?.sessionId ? { sessionId: record.sessionId } : {}),
			...(record?.recordedAt ? { recordedAt: record.recordedAt } : {}),
			referencePath,
		});
	}
	return state;
}

export interface KernelSnapshotReclaimPlan {
	remove: { path: string; bytes: number }[];
	kept: { path: string; reason: "referenced" | "retained" | "unknown" }[];
	/**
	 * The in-place payload (`kernel-state.dill`) is present. It is never a
	 * generation candidate: a kernel spawned by a host that predates this module
	 * runs from it without leaving a reference, so "no references" is not evidence
	 * that it is free (red test R-15). Reported so a reader can see why a directory
	 * that holds a payload produced no generation work.
	 */
	legacyPayload: boolean;
}

/**
 * Which generations a sweep may remove: every referenced generation is kept, plus
 * the newest `retention` unreferenced ones. Unreadable reference state keeps all
 * of them (the venv-in-use rule), and a missing generation directory is a no-op.
 */
export function planKernelSnapshotReclaim(
	artifactDir: string,
	options: { retention?: number; now?: number; sweepStale?: boolean } = {},
): KernelSnapshotReclaimPlan {
	const retention = Math.max(0, options.retention ?? RETIRED_KERNEL_SNAPSHOT_RETENTION);
	const state = readKernelSnapshotGenerationState(artifactDir, {
		...(options.sweepStale !== undefined ? { sweepStale: options.sweepStale } : {}),
	});
	const plan: KernelSnapshotReclaimPlan = { remove: [], kept: [], legacyPayload: false };
	plan.legacyPayload = existsSync(join(artifactDir, LEGACY_KERNEL_SNAPSHOT_BASENAME));
	const dir = kernelSnapshotGenerationsDir(artifactDir);
	const unreferenced: { path: string; bytes: number; recencyMs: number }[] = [];
	for (const name of state.generations) {
		const path = join(dir, name);
		if (state.unknown || state.referenced.has(name)) {
			plan.kept.push({ path, reason: state.unknown ? "unknown" : "referenced" });
			continue;
		}
		let stats: ReturnType<typeof lstatSync> | undefined;
		try {
			stats = lstatSync(path);
		} catch {
			// Vanished between listdir and stat: nothing to plan.
			continue;
		}
		if (stats.isSymbolicLink() || !stats.isFile()) {
			plan.kept.push({ path, reason: "unknown" });
			continue;
		}
		unreferenced.push({ path, bytes: stats.size, recencyMs: stats.mtimeMs });
	}
	unreferenced.sort((a, b) => b.recencyMs - a.recencyMs || b.path.localeCompare(a.path));
	for (const entry of unreferenced.slice(0, retention)) {
		plan.kept.push({ path: entry.path, reason: "retained" });
	}
	for (const entry of unreferenced.slice(retention)) {
		plan.remove.push({ path: entry.path, bytes: entry.bytes });
	}
	return plan;
}

/** Artifact directories that carry a generation layout (bounded walk). */
function findGenerationRoots(artifactRoot: string, maxDepth = 8): string[] {
	const found: string[] = [];
	const queue: { path: string; depth: number }[] = [{ path: artifactRoot, depth: 0 }];
	while (queue.length > 0) {
		const current = queue.shift()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(current.path, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
			const child = join(current.path, entry.name);
			if (entry.name === KERNEL_SNAPSHOT_GENERATIONS_DIR_NAME) {
				found.push(current.path);
				continue;
			}
			if (current.depth >= maxDepth) continue;
			queue.push({ path: child, depth: current.depth + 1 });
		}
	}
	return found.sort();
}

function signatureFor(path: string): string | undefined {
	try {
		const stats = lstatSync(path);
		return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
	} catch {
		return undefined;
	}
}

/**
 * Reclaim unreferenced kernel snapshot generations, keeping the newest
 * `retention` retired ones. Off by default (`kernelSnapshotReclaimEnabled`):
 * round-08 D-1 measured the snapshot bytes riding on live references, so the
 * switch exists for the owner to turn on after the writer adopts the layout -
 * until then this class reports what it sees and removes nothing.
 *
 * The legacy single-file payload is never a candidate here (red test R-15): a
 * kernel spawned by an older host runs from it without leaving a reference.
 */
export const kernelSnapshotGenerationsModule: RetentionClassModule = {
	id: "kernel-snapshot-generations",
	async scanAndReclaim(context: RetentionClassContext): Promise<RetentionClassResult> {
		const artifactRoots = findGenerationRoots(context.roots.artifactRoot);
		const skipped: RetentionSkip[] = [];
		const requests = [];
		let scanned = 0;
		for (const artifactDir of artifactRoots) {
			const plan = planKernelSnapshotReclaim(artifactDir, {
				retention: context.settings.kernelSnapshotGenerations,
				now: context.now,
				sweepStale: !context.dryRun,
			});
			scanned += plan.kept.length + plan.remove.length;
			for (const kept of plan.kept) {
				skipped.push({
					path: kept.path,
					reason:
						kept.reason === "referenced"
							? SKIP.reference("kernel-snapshot-reference")
							: kept.reason === "unknown"
								? SKIP.unverifiable("kernel-snapshot-reference-state")
								: SKIP.reference("retained-generation"),
				});
			}
			if (!context.settings.kernelSnapshotReclaimEnabled) continue;
			for (const entry of plan.remove) {
				requests.push({
					path: entry.path,
					kind: "file" as const,
					bytes: entry.bytes,
					entries: 1,
					...(signatureFor(entry.path) ? { signature: signatureFor(entry.path) } : {}),
				});
			}
		}
		if (!context.settings.kernelSnapshotReclaimEnabled) {
			return {
				class: "kernel-snapshot-generations",
				scanned,
				reclaimed: 0,
				bytes: 0,
				skipped,
				capped: false,
				disabled: true,
			};
		}
		const outcome = await reclaimWithinBudget(context, requests);
		return {
			class: "kernel-snapshot-generations",
			scanned,
			reclaimed: outcome.reclaimed,
			bytes: outcome.bytes,
			skipped: [...skipped, ...outcome.skipped],
			capped: outcome.capped,
			disabled: false,
		};
	},
};
