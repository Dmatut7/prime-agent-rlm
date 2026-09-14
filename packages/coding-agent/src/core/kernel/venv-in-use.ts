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
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
	closeSync,
	constants,
	fchmodSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeSync,
} from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { requireNoFollow } from "../../utils/private-files.js";
import { getProcessStartId } from "../session-lease.js";

/**
 * Directory inside a generation that holds one reference file per live kernel pid, plus one
 * `boot-<pid>` claim per host process that is about to spawn a kernel from it.
 */
export const VENV_IN_USE_DIR_NAME = ".in-use";
/** Unreferenced generations kept for inspection; referenced ones are always kept. */
export const RETIRED_VENV_RETENTION = 1;
export const KERNEL_VENV_SUFFIX_LENGTH = 12;

const REFERENCE_RECORD_VERSION = 1;
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
const PID_FILE_NAME = /^[1-9][0-9]*$/;
const GENERATION_SUFFIX = new RegExp(`^[0-9a-f]{${KERNEL_VENV_SUFFIX_LENGTH}}$`);

interface ReferenceRecord {
	pid: number;
	processStartId?: string;
	sessionId?: string;
	recordedAt?: string;
}

export interface KernelVenvInUseReference {
	pid: number;
	/** Start identity of the recorded pid, when the writer could query one. */
	processStartId?: string;
	sessionId?: string;
	recordedAt?: string;
	/** Set on a tombstone: this kernel could not write a real reference, so its claim is unverified. */
	unverified?: boolean;
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

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the pid exists and belongs to somebody else.
		return isNodeError(error, "EPERM");
	}
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

/** Create the reference directory and write one record; returns the failure reason, if any. */
function writeReferenceFile(filePath: string, dir: string, record: Record<string, unknown>): string | undefined {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		// O_NOFOLLOW: a planted symlink at the reference path must not be written through. The
		// mode is re-asserted on the descriptor because the create mode only applies to a new
		// file (as in orphan-process-journal.ts).
		const descriptor = openSync(
			filePath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | requireNoFollow(constants.O_NOFOLLOW),
			0o600,
		);
		try {
			writeSync(descriptor, `${JSON.stringify(record)}\n`);
			if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
		} finally {
			closeSync(descriptor);
		}
		return undefined;
	} catch (error) {
		return errorMessage(error);
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
	const failure = writeReferenceFile(referencePath, dir, identity);
	if (failure === undefined) return { releasePath: referencePath, unverified: false };

	const tombstonePath = path.join(dir, `${UNVERIFIED_REFERENCE_PREFIX}${reference.pid}`);
	const tombstoneFailure = writeReferenceFile(tombstonePath, dir, { ...identity, unverified: true, reason: failure });
	return {
		releasePath: tombstoneFailure === undefined ? tombstonePath : undefined,
		unverified: true,
		reason: tombstoneFailure === undefined ? failure : `${failure}; tombstone write also failed: ${tombstoneFailure}`,
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
	const failure = writeReferenceFile(claimPath, dir, identity);
	return failure === undefined ? { claimPath } : { reason: failure };
}

/**
 * Drop this kernel's reference, or a pending-boot claim: both are files in the same directory and
 * both are reclaimed by the same stale sweep. Synchronous because teardown also runs from
 * `process.on("exit")`; a missed release is reclaimed by the next sweep (dead pid, or a live pid
 * whose start identity no longer matches).
 */
export function releaseKernelVenvInUseSync(referencePath: string | undefined): void {
	if (!referencePath) return;
	try {
		rmSync(referencePath, { force: true });
	} catch {
		// Best effort: the stale sweep reclaims it.
	}
}

function readReferenceRecord(filePath: string): ReferenceRecord | undefined {
	try {
		const stats = lstatSync(filePath);
		if (stats.isSymbolicLink() || !stats.isFile()) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as {
			version?: unknown;
			pid?: unknown;
			processStartId?: unknown;
			sessionId?: unknown;
			recordedAt?: unknown;
		};
		if (record.version !== REFERENCE_RECORD_VERSION) return undefined;
		if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) return undefined;
		return {
			pid: record.pid as number,
			...(typeof record.processStartId === "string" ? { processStartId: record.processStartId } : {}),
			...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
			...(typeof record.recordedAt === "string" ? { recordedAt: record.recordedAt } : {}),
		};
	} catch {
		return undefined;
	}
}

/**
 * A live pid is only the recorded kernel when its start identity still matches;
 * pids get reused. When the start identity cannot be queried the reference is
 * kept: this decides whether a directory may be deleted, so "cannot disprove"
 * must not read as "gone". (The orphan reaper judges the same evidence the other
 * way round because it decides whether to kill.)
 */
function referenceIsLive(record: ReferenceRecord): boolean {
	if (!processIsRunning(record.pid)) return false;
	if (record.processStartId === undefined) return true;
	const current = getProcessStartId(record.pid);
	return current === undefined || current === record.processStartId;
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
	const references: KernelVenvInUseReference[] = [];
	const bootClaims: KernelVenvInUseReference[] = [];
	const swept: string[] = [];
	let unknown = false;
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
		if (!PID_FILE_NAME.test(pidName)) continue;
		const referencePath = path.join(dir, entry);
		const record = readReferenceRecord(referencePath);
		const stale = record === undefined || Number(pidName) !== record.pid || !referenceIsLive(record);
		if (stale) {
			// `sweepStale: false` is the read-only mode: a dry run must not change the
			// filesystem, and removing another process's reference is a change
			// (adversarial review N-2). The stale file is simply not counted.
			if (options.sweepStale !== false) {
				try {
					await rm(referencePath, { force: true });
					swept.push(referencePath);
				} catch {
					// Left for the next sweep; it is not counted as a reference either.
				}
			}
			continue;
		}
		if (tombstone) unknown = true;
		const parsed: KernelVenvInUseReference = {
			pid: record?.pid as number,
			...(record?.processStartId ? { processStartId: record.processStartId } : {}),
			...(record?.sessionId ? { sessionId: record.sessionId } : {}),
			...(record?.recordedAt ? { recordedAt: record.recordedAt } : {}),
			...(tombstone ? { unverified: true } : {}),
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
