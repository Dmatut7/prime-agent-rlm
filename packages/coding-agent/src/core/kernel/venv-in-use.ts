// Generation management for bootstrap-built kernel venvs.
//
// Every build identity gets its own directory (`<base>-<12 hex suffix>`), and a
// kernel records a reference file inside the directory it was spawned from. A
// directory that still has live references is never renamed, rebuilt in place,
// or deleted: CPython keeps resolving lazy imports (and this repo's skills are
// imported dynamically) against the absolute site-packages path it started with,
// so renaming a directory or swapping content under a running kernel lets one
// kernel mix module versions from two builds. A new build identity therefore
// lands in a new sibling directory, and an old one is reclaimed only after its
// own references drop to zero.
//
// The reference judgement itself - the four states of one entry, the confirmation
// read that authorises an unlink, and the short-write-safe record writer - lives in
// `reference-records.ts`, shared with the kernel snapshot generation layout.
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstatSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { getProcessStartId, getProcessStartIdsAsync, isProcessAlive } from "../session-lease.js";
import {
	confirmReferenceIsStale,
	inspectReferenceEntry,
	REFERENCE_PID_FILE_NAME,
	REFERENCE_RECORD_VERSION,
	type ReferenceEntryFacts,
	releaseReferenceFileSync,
	verdictFromEntryFacts,
	writeReferenceFileSync,
} from "./reference-records.js";

/**
 * Directory inside a generation that holds one reference file per live kernel pid, plus one
 * `boot-<pid>` claim per host process that is about to spawn a kernel from it.
 */
export const VENV_IN_USE_DIR_NAME = ".in-use";
/** Unreferenced generations kept for inspection; referenced ones are always kept. */
export const RETIRED_VENV_RETENTION = 1;
export const KERNEL_VENV_SUFFIX_LENGTH = 12;

/** File name prefix of the tombstone a kernel writes when its reference file could not be written. */
export const UNVERIFIED_REFERENCE_PREFIX = "unverified-";
/**
 * File name prefix of a pending-boot claim: a host process announces "I am about to spawn a kernel
 * from this generation" before it has a kernel pid to reference it with (P2-2). Without it the
 * window between a boot handing back an interpreter path and the spawn recording its reference
 * reads as "zero references" to a concurrent boot's sweep, which may then delete the directory the
 * first boot is about to exec - a self-healing but user-visible failed spawn.
 */
export const BOOT_CLAIM_PREFIX = "boot-";

const GENERATION_SUFFIX = new RegExp(`^[0-9a-f]{${KERNEL_VENV_SUFFIX_LENGTH}}$`);

export interface KernelVenvInUseReference {
	pid: number;
	/** Start identity of the recorded pid, when the writer could query one. */
	processStartId?: string;
	sessionId?: string;
	recordedAt?: string;
	/** Set on a tombstone: this kernel could not write a real reference, so its claim is unverified. */
	unverified?: boolean;
	/**
	 * Set when the entry cannot be disproved: its record does not parse (a short write truncated
	 * it), or it does not name the pid its file name claims while the recorded holder runs. The
	 * entry counts as a reference and makes the state unknown; it is never swept.
	 */
	unverifiable?: boolean;
	/** Absolute path of the reference file; the holder releases exactly this path. */
	referencePath: string;
}

/** Outcome of registering one kernel with the generation it was spawned from. */
export interface KernelVenvInUseRecord {
	/** Path to release at teardown: the reference file, or the tombstone written after a failed reference write. */
	releasePath?: string;
	/** The reference itself could not be written, so readers report this generation's state as unknown. */
	unverified: boolean;
	/** Why the write failed, for the caller's log line. */
	reason?: string;
}

/** Outcome of announcing one pending kernel spawn. */
export interface KernelVenvBootClaim {
	/** Absolute path of the claim file; absent when the claim could not be written. */
	claimPath?: string;
	/** Why the claim could not be written, for the caller's log line. */
	reason?: string;
}

export interface KernelVenvInUseState {
	references: KernelVenvInUseReference[];
	/**
	 * Live pending-boot claims: host processes that announced a spawn from this generation and have
	 * not recorded a kernel reference yet. They are deliberately kept apart from `references` - a
	 * claim is a promise to spawn, not a running kernel, so it protects the directory from being
	 * *deleted* (nothing would be left to spawn from) without deferring a *rebuild* the claimant
	 * itself may be about to perform.
	 */
	bootClaims: KernelVenvInUseReference[];
	/**
	 * The generation exists but its reference state could not be fully established: either the
	 * reference directory could not be read, or a live kernel could not write its reference and
	 * left a tombstone instead. Callers must treat the directory as in use — deleting it would
	 * be the unsafe direction.
	 */
	unknown: boolean;
	/** Reference files removed because their holder is provably gone. */
	swept: string[];
}

export interface KernelVenvPruneReport {
	removed: string[];
	kept: { dir: string; liveReferences: number; protectedByReference: boolean; pendingBoots?: number }[];
}

export type KernelVenvRebuildMode = "replace" | "defer";

export interface KernelVenvRebuildDecision {
	mode: KernelVenvRebuildMode;
	liveReferences: number;
	referenceStateUnknown: boolean;
	platform: NodeJS.Platform;
	reason: string;
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

/** Raised when a generation directory needs a rebuild but a kernel still runs from it. */
export class KernelVenvRebuildDeferredError extends Error {
	readonly code = "kernel_venv_rebuild_deferred" as const;

	constructor(
		readonly venvDir: string,
		readonly liveReferences: number,
		readonly referenceStateUnknown: boolean,
	) {
		super(
			`venv rebuild deferred: ${liveReferences} kernels in use (${path.basename(venvDir)}). ` +
				(referenceStateUnknown
					? liveReferences === 0
						? "Its in-use reference directory could not be read, so it is assumed to be in use. "
						: "At least one running kernel could not write its in-use reference, so the reference state is incomplete. "
					: "") +
				"A running kernel pins the directory it was spawned from, so that directory is neither rebuilt nor " +
				"deleted while the kernel lives; this one needs a rebuild because it is not a usable base install. " +
				"Retry once those kernels exit, or set PRIME_AGENT_KERNEL_PYTHON to a Python with a current " +
				"prime-agent-runtime installed to skip bootstrap entirely.",
		);
		this.name = "KernelVenvRebuildDeferredError";
	}
}

/**
 * Register this kernel with the generation it was spawned from.
 *
 * Returns the path to release at teardown plus whether the registration is unverified. When the
 * reference file itself cannot be written (EMFILE, ENOSPC, EACCES, a planted symlink at the
 * path), a tombstone is written instead so the generation never looks free: with no on-disk
 * trace, the next boot would read "zero references, state known" and could rebuild or reclaim
 * the directory out from under this running kernel — the exact failure generation directories
 * exist to prevent. The tombstone carries the same liveness evidence as a reference, so it
 * protects the directory while this kernel lives and is swept once it dies. If the tombstone
 * write fails too there is nothing left to signal with; the caller logs that and the directory
 * falls back to today's (unprotected) behaviour.
 */
export function recordKernelVenvInUseSync(
	venvDir: string,
	reference: { pid: number; sessionId?: string },
): KernelVenvInUseRecord {
	if (!venvDir || !Number.isInteger(reference.pid) || reference.pid <= 0) {
		return { unverified: false };
	}
	const dir = path.join(venvDir, VENV_IN_USE_DIR_NAME);
	const processStartId = getProcessStartId(reference.pid);
	const identity = {
		version: REFERENCE_RECORD_VERSION,
		pid: reference.pid,
		...(reference.sessionId ? { sessionId: reference.sessionId } : {}),
		...(processStartId ? { processStartId } : {}),
		recordedAt: new Date().toISOString(),
	};
	// This process's pending-boot claim for the same generation is superseded by the reference it
	// is recording now, whichever way the write ends: a reference is the stronger fact, and a
	// tombstone protects the directory too (it makes the state unknown). Removing the claim first
	// keeps a host that never spawns again from pinning a generation for its whole lifetime.
	releaseKernelVenvInUseSync(path.join(dir, `${BOOT_CLAIM_PREFIX}${process.pid}`));
	const referencePath = path.join(dir, String(reference.pid));
	const failure = writeReferenceFileSync(referencePath, dir, identity);
	if (failure === undefined) return { releasePath: referencePath, unverified: false };

	const tombstonePath = path.join(dir, `${UNVERIFIED_REFERENCE_PREFIX}${reference.pid}`);
	const tombstoneFailure = writeReferenceFileSync(tombstonePath, dir, {
		...identity,
		unverified: true,
		reason: failure.reason,
	});
	if (tombstoneFailure === undefined && failure.partialDelete) {
		// A truncated prefix is on disk where a record belongs. The tombstone carries the same
		// evidence in a shape readers accept, so the unusable prefix is removed now that the
		// stronger signal is written: leaving it behind would leave the generation unreadable
		// (and so unrebuildable) for good. The removal happens after the tombstone write, never
		// before, so there is no window in which the directory looks free.
		releaseKernelVenvInUseSync(referencePath);
	}
	return {
		releasePath: tombstoneFailure === undefined ? tombstonePath : undefined,
		unverified: true,
		reason:
			tombstoneFailure === undefined
				? failure.reason
				: `${failure.reason}; tombstone write also failed: ${tombstoneFailure.reason}`,
	};
}

/**
 * Announce that this process is about to spawn a kernel from `venvDir` (P2-2).
 *
 * The claim lives in the same directory as the references and is judged by the same liveness rule,
 * so a host that dies before it spawns is swept by the next reader instead of pinning the
 * generation forever. It is superseded - removed - by {@link recordKernelVenvInUseSync} from the
 * same process, which is the normal end of its life: the spawned kernel's own reference takes over.
 *
 * Best effort and never fatal: a claim that cannot be written costs the boot nothing but the
 * protection, which is the pre-existing behaviour, so the caller logs `reason` and carries on.
 */
export function claimKernelVenvBootSync(
	venvDir: string,
	reference: { pid?: number; sessionId?: string } = {},
): KernelVenvBootClaim {
	const pid = reference.pid ?? process.pid;
	if (!venvDir || !Number.isInteger(pid) || pid <= 0) {
		return { reason: "no directory or pid to claim for" };
	}
	const dir = path.join(venvDir, VENV_IN_USE_DIR_NAME);
	const processStartId = getProcessStartId(pid);
	const identity = {
		version: REFERENCE_RECORD_VERSION,
		pid,
		...(reference.sessionId ? { sessionId: reference.sessionId } : {}),
		...(processStartId ? { processStartId } : {}),
		recordedAt: new Date().toISOString(),
	};
	const claimPath = path.join(dir, `${BOOT_CLAIM_PREFIX}${pid}`);
	const failure = writeReferenceFileSync(claimPath, dir, identity);
	if (failure === undefined) return { claimPath };
	if (failure.partialDelete) {
		// A claim that landed short is not a claim: no reader can parse the promise out of it, and
		// an unreadable entry would keep the directory out of every future reclaim. The boot
		// carries on unprotected, which is the pre-existing behaviour for a claim that cannot be
		// written at all.
		releaseKernelVenvInUseSync(claimPath);
	}
	return { reason: failure.reason };
}

/**
 * Drop this kernel's reference, or a pending-boot claim: both are files in the same directory and
 * both are reclaimed by the same stale sweep. Synchronous because teardown also runs from
 * `process.on("exit")`; a missed release is reclaimed by the next sweep (dead pid, or a live pid
 * whose start identity no longer matches).
 */
export function releaseKernelVenvInUseSync(referencePath: string | undefined): void {
	releaseReferenceFileSync(referencePath);
}

/**
 * Sweep one entry a first read judged stale, after judging it a second time.
 *
 * The writer is another process and neither the record write nor this sweep is atomic, so the
 * file can become a live reference (or an unreadable one) between the read and the unlink. The
 * confirmation read is what stops a live reference from being deleted by a stale verdict, and it
 * is the only thing that authorises the unlink.
 */
export async function sweepStaleVenvReference(referencePath: string, pidName: string): Promise<"swept" | "kept"> {
	if (!confirmReferenceIsStale(referencePath, pidName)) return "kept";
	try {
		await rm(referencePath, { force: true });
		return "swept";
	} catch {
		// Left for the next sweep; it is not counted as a reference either.
		return "kept";
	}
}

/** Live references of one generation, sweeping provably stale entries. */
export async function readKernelVenvInUseState(
	venvDir: string,
	options: { sweepStale?: boolean } = {},
): Promise<KernelVenvInUseState> {
	const dir = path.join(venvDir, VENV_IN_USE_DIR_NAME);
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (error) {
		if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
			return { references: [], bootClaims: [], unknown: false, swept: [] };
		}
		return { references: [], bootClaims: [], unknown: true, swept: [] };
	}
	// First pass: gather every candidate entry and its on-disk evidence without
	// resolving any process identity (RC-4: judging one entry at a time forks one
	// helper process per live holder, ~55ms of synchronous execFileSync each, and
	// a boot pays that tax for every live reference of every retired generation).
	const candidates: Array<{
		pidName: string;
		tombstone: boolean;
		bootClaim: boolean;
		referencePath: string;
		facts: ReferenceEntryFacts;
	}> = [];
	for (const entry of [...entries].sort()) {
		// A tombstone (`unverified-<pid>`) is a reference whose writer could not create the real
		// file; it counts, and it makes the state unknown so a rebuild defers instead of deleting.
		const tombstone = entry.startsWith(UNVERIFIED_REFERENCE_PREFIX);
		// A claim (`boot-<pid>`) is a host about to spawn; it is counted apart from the references
		// so that it protects the directory from deletion without deferring a rebuild (P2-2).
		const bootClaim = !tombstone && entry.startsWith(BOOT_CLAIM_PREFIX);
		const pidName = tombstone
			? entry.slice(UNVERIFIED_REFERENCE_PREFIX.length)
			: bootClaim
				? entry.slice(BOOT_CLAIM_PREFIX.length)
				: entry;
		// Names this bookkeeping never writes are ignored: they neither protect the
		// generation nor get deleted.
		if (!REFERENCE_PID_FILE_NAME.test(pidName)) continue;
		const referencePath = path.join(dir, entry);
		candidates.push({
			pidName,
			tombstone,
			bootClaim,
			referencePath,
			facts: inspectReferenceEntry(referencePath),
		});
	}
	// One batched identity resolution for every pid the evidence will ask about. A
	// pid the batch could not observe is absent from the map, which the verdict
	// reads exactly like a per-pid query that failed: keep, never "gone".
	const pidsToResolve = new Set<number>();
	for (const candidate of candidates) {
		const record = candidate.facts.record;
		if (record?.processStartId !== undefined && isProcessAlive(record.pid)) {
			pidsToResolve.add(record.pid);
		}
	}
	const startIds = await getProcessStartIdsAsync(pidsToResolve);
	const currentStartIdOf = (pid: number): string | undefined => startIds.get(pid);

	const references: KernelVenvInUseReference[] = [];
	const bootClaims: KernelVenvInUseReference[] = [];
	const swept: string[] = [];
	let unknown = false;
	for (const { pidName, tombstone, bootClaim, referencePath, facts } of candidates) {
		const verdict = verdictFromEntryFacts(facts, pidName, currentStartIdOf);
		if (verdict === "foreign") continue;
		if (verdict === "stale") {
			// `sweepStale: false` is the read-only mode: a dry run must not change the filesystem, and
			// unlinking another process's reference is a change (adversarial review N-2). The stale
			// entry is simply not counted; the confirmation read inside the sweep is what authorises
			// the unlink (70a4f18b4).
			if (options.sweepStale !== false) {
				if ((await sweepStaleVenvReference(referencePath, pidName)) === "swept") swept.push(referencePath);
			}
			continue;
		}
		const record = facts.record;
		if (tombstone) unknown = true;
		// An unverifiable entry is the "in use" direction for deletion, and for a *reference* it
		// also makes the rebuild decision defer: a directory whose real state cannot be
		// established is not repairable in place. A boot claim keeps its documented meaning
		// instead - it protects the directory without deferring a rebuild the claimant itself may
		// be about to perform - so it does not raise `unknown`.
		if (verdict === "unverifiable" && !bootClaim) unknown = true;
		const parsed: KernelVenvInUseReference = {
			pid: record?.pid ?? Number(pidName),
			...(record?.processStartId ? { processStartId: record.processStartId } : {}),
			...(record?.sessionId ? { sessionId: record.sessionId } : {}),
			...(record?.recordedAt ? { recordedAt: record.recordedAt } : {}),
			...(tombstone ? { unverified: true } : {}),
			...(verdict === "unverifiable" ? { unverifiable: true } : {}),
			referencePath,
		};
		(bootClaim ? bootClaims : references).push(parsed);
	}
	return { references, bootClaims, unknown, swept };
}

/**
 * Whether an existing generation directory may be rebuilt in place. `defer` is
 * the platform-independent form of the Windows downgrade case: no generation is
 * ever renamed, so there is no rename exchange for Windows to fail at, and a
 * directory that needs a rebuild while in use is reported instead of touched.
 */
export function decideKernelVenvRebuild(input: {
	platform: NodeJS.Platform;
	generationDirExists: boolean;
	liveReferences: number;
	referenceStateUnknown: boolean;
}): KernelVenvRebuildDecision {
	const { platform, generationDirExists, liveReferences, referenceStateUnknown } = input;
	if (!generationDirExists) {
		return {
			mode: "replace",
			liveReferences: 0,
			referenceStateUnknown,
			platform,
			reason: "no directory for this build identity yet",
		};
	}
	if (!referenceStateUnknown && liveReferences === 0) {
		return {
			mode: "replace",
			liveReferences,
			referenceStateUnknown,
			platform,
			reason: "directory exists and no kernel references it",
		};
	}
	return {
		mode: "defer",
		liveReferences,
		referenceStateUnknown,
		platform,
		reason: referenceStateUnknown
			? "reference state incomplete or unreadable, so the directory is assumed in use"
			: `${liveReferences} live kernel reference(s)`,
	};
}

/** Filesystem-safe generation suffix for one build identity. */
export function kernelVenvGenerationSuffix(baseIdentity: string): string {
	return createHash("sha256").update(baseIdentity).digest("hex").slice(0, KERNEL_VENV_SUFFIX_LENGTH);
}

/** `<parent>/<basename>-<suffix>`: a sibling of the base, never a rename of it. */
export function generationDirForSuffix(base: string, suffix: string): string {
	return `${base}-${suffix}`;
}

function isGenerationSuffix(value: string): boolean {
	return GENERATION_SUFFIX.test(value);
}

export function isKernelVenvGenerationDir(base: string, candidate: string): boolean {
	if (path.dirname(candidate) !== path.dirname(base)) return false;
	const prefix = `${path.basename(base)}-`;
	const name = path.basename(candidate);
	return name.startsWith(prefix) && isGenerationSuffix(name.slice(prefix.length));
}

/**
 * The managed generation a kernel python path belongs to, or undefined for an
 * interpreter outside the bootstrap layout (e.g. PRIME_AGENT_KERNEL_PYTHON or
 * the legacy unsuffixed venv). Only managed generations carry references.
 */
export function kernelVenvDirForPython(python: string, bases: readonly string[]): string | undefined {
	const binDir = path.dirname(python);
	const venvDir = path.dirname(binDir);
	const binName = path.basename(binDir).toLowerCase();
	const executable = path.basename(python).toLowerCase();
	if (binName !== "bin" && binName !== "scripts") return undefined;
	if (!executable.startsWith("python")) return undefined;
	return bases.some((candidate) => candidate && isKernelVenvGenerationDir(candidate, venvDir)) ? venvDir : undefined;
}

/** Generation siblings of the base, excluding the base itself and non-directories. */
export async function listKernelVenvGenerations(base: string): Promise<string[]> {
	const parent = path.dirname(base);
	let entries: Dirent[];
	try {
		entries = await readdir(parent, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory() && isKernelVenvGenerationDir(base, path.join(parent, entry.name)))
		.map((entry) => path.join(parent, entry.name))
		.sort();
}

function generationRecencyMs(dir: string): number {
	try {
		return lstatSync(dir).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Reclaim generations no kernel references any more: every referenced generation
 * is kept (one per build identity, however many identities are still running),
 * plus the newest `retention` unreferenced ones. Unreadable reference state
 * counts as referenced, and so does a live pending-boot claim: a host that
 * announced a spawn from a generation but has not recorded its kernel yet would
 * otherwise watch that generation disappear underneath the spawn (P2-2). The
 * generation this boot is about to use is never a candidate, and neither is the
 * legacy unsuffixed base directory: kernels spawned by pre-generation hosts run
 * from it without leaving references, so "no references" is not evidence that it
 * is free.
 */
export interface KernelVenvReclaimPlan {
	/** Generations whose references are all gone, beyond the retention count. */
	remove: { dir: string; bytes: number }[];
	kept: KernelVenvPruneReport["kept"];
}

/** Plain-file bytes in one generation directory; unreadable parts count as 0. */
async function generationBytes(dir: string): Promise<number> {
	let total = 0;
	const queue = [dir];
	while (queue.length > 0) {
		const current = queue.shift()!;
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const child = path.join(current, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				queue.push(child);
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				total += lstatSync(child).size;
			} catch {
				// Vanished or unreadable: it contributes no bytes.
			}
		}
	}
	return total;
}

/**
 * The judgement `pruneKernelVenvGenerations` acts on, exposed so a caller with a
 * deletion budget (the retention sweep) can spend it before removing anything.
 * Every referenced generation is kept (one per build identity, however many
 * identities are still running), plus the newest `retention` unreferenced ones.
 * Unreadable reference state counts as referenced, and so does a live pending-boot
 * claim: a host that announced a spawn from a generation but has not recorded its
 * kernel yet would otherwise watch that generation disappear underneath the spawn
 * (P2-2). The generation a caller names in `activeDir` is never a candidate, and
 * neither is the legacy unsuffixed base directory: kernels spawned by
 * pre-generation hosts run from it without leaving references, so "no references"
 * is not evidence that it is free.
 */
export async function planKernelVenvGenerationReclaim(
	base: string,
	options: { activeDir?: string; retention?: number; sweepStale?: boolean } = {},
): Promise<KernelVenvReclaimPlan> {
	const retention = Math.max(0, options.retention ?? RETIRED_VENV_RETENTION);
	const candidates = (await listKernelVenvGenerations(base)).filter((dir) => dir !== options.activeDir);
	const kept: KernelVenvPruneReport["kept"] = [];
	const unreferenced: { dir: string; recencyMs: number }[] = [];
	for (const dir of candidates) {
		// `sweepStale: false` keeps a read-only caller (a dry run) from removing
		// another process's reference file (adversarial review N-2).
		const state = await readKernelVenvInUseState(dir, {
			...(options.sweepStale !== undefined ? { sweepStale: options.sweepStale } : {}),
		});
		const pendingBoots = state.bootClaims.length;
		if (state.unknown || state.references.length > 0) {
			kept.push({
				dir,
				liveReferences: state.references.length,
				protectedByReference: true,
				...(pendingBoots > 0 ? { pendingBoots } : {}),
			});
			continue;
		}
		if (pendingBoots > 0) {
			kept.push({ dir, liveReferences: 0, protectedByReference: false, pendingBoots });
			continue;
		}
		unreferenced.push({ dir, recencyMs: generationRecencyMs(dir) });
	}
	unreferenced.sort((a, b) => b.recencyMs - a.recencyMs || path.basename(b.dir).localeCompare(path.basename(a.dir)));
	for (const entry of unreferenced.slice(0, retention)) {
		kept.push({ dir: entry.dir, liveReferences: 0, protectedByReference: false });
	}
	const remove: KernelVenvReclaimPlan["remove"] = [];
	for (const entry of unreferenced.slice(retention)) {
		remove.push({ dir: entry.dir, bytes: await generationBytes(entry.dir) });
	}
	return { remove, kept };
}

/**
 * Reclaim generations no kernel references any more. See
 * {@link planKernelVenvGenerationReclaim} for the judgement; this wrapper only
 * performs the removals and reports what could not be removed.
 */
export async function pruneKernelVenvGenerations(
	base: string,
	options: { activeDir?: string; retention?: number } = {},
): Promise<KernelVenvPruneReport> {
	const plan = await planKernelVenvGenerationReclaim(base, options);
	const removed: string[] = [];
	const kept = [...plan.kept];
	for (const entry of plan.remove) {
		try {
			await rm(entry.dir, { recursive: true, force: true });
			removed.push(entry.dir);
		} catch {
			kept.push({ dir: entry.dir, liveReferences: 0, protectedByReference: false });
		}
	}
	return { removed, kept };
}
