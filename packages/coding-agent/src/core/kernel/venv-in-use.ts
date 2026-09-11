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

/** Directory inside a generation that holds one reference file per live kernel pid. */
export const VENV_IN_USE_DIR_NAME = ".in-use";
/** Unreferenced generations kept for inspection; referenced ones are always kept. */
export const RETIRED_VENV_RETENTION = 1;
export const KERNEL_VENV_SUFFIX_LENGTH = 12;

const REFERENCE_RECORD_VERSION = 1;
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
	/** Absolute path of the reference file; the holder releases exactly this path. */
	referencePath: string;
}

export interface KernelVenvInUseState {
	references: KernelVenvInUseReference[];
	/**
	 * The generation exists but its references could not be read. Callers must
	 * treat the directory as in use: deleting it would be the unsafe direction.
	 */
	unknown: boolean;
	/** Reference files removed because their holder is provably gone. */
	swept: string[];
}

export interface KernelVenvPruneReport {
	removed: string[];
	kept: { dir: string; liveReferences: number; protectedByReference: boolean }[];
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
					? "Its in-use reference directory could not be read, so it is assumed to be in use. "
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
 * Write this kernel's reference into the generation it was spawned from.
 * Returns the reference file path (the caller releases exactly that path), or
 * undefined when the write failed; a failed write leaves the generation's
 * reference state unverifiable, which the rebuild decision treats as in use.
 */
export function recordKernelVenvInUseSync(
	venvDir: string,
	reference: { pid: number; sessionId?: string },
): string | undefined {
	if (!venvDir || !Number.isInteger(reference.pid) || reference.pid <= 0) return undefined;
	const dir = path.join(venvDir, VENV_IN_USE_DIR_NAME);
	const referencePath = path.join(dir, String(reference.pid));
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const processStartId = getProcessStartId(reference.pid);
		const record = {
			version: REFERENCE_RECORD_VERSION,
			pid: reference.pid,
			...(reference.sessionId ? { sessionId: reference.sessionId } : {}),
			...(processStartId ? { processStartId } : {}),
			recordedAt: new Date().toISOString(),
		};
		// O_NOFOLLOW: a planted symlink at the reference path must not be written
		// through. The mode is re-asserted on the descriptor because the create mode
		// only applies to a new file (as in orphan-process-journal.ts).
		const descriptor = openSync(
			referencePath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | requireNoFollow(constants.O_NOFOLLOW),
			0o600,
		);
		try {
			writeSync(descriptor, `${JSON.stringify(record)}\n`);
			if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
		} finally {
			closeSync(descriptor);
		}
		return referencePath;
	} catch {
		return undefined;
	}
}

/**
 * Drop this kernel's reference. Synchronous because teardown also runs from
 * `process.on("exit")`; a missed release is reclaimed by the next stale sweep
 * (dead pid, or a live pid whose start identity no longer matches).
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
export async function readKernelVenvInUseState(venvDir: string): Promise<KernelVenvInUseState> {
	const dir = path.join(venvDir, VENV_IN_USE_DIR_NAME);
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (error) {
		if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
			return { references: [], unknown: false, swept: [] };
		}
		return { references: [], unknown: true, swept: [] };
	}
	const references: KernelVenvInUseReference[] = [];
	const swept: string[] = [];
	for (const entry of [...entries].sort()) {
		// Names this bookkeeping never writes are ignored: they neither protect the
		// generation nor get deleted.
		if (!PID_FILE_NAME.test(entry)) continue;
		const referencePath = path.join(dir, entry);
		const record = readReferenceRecord(referencePath);
		const stale = record === undefined || Number(entry) !== record.pid || !referenceIsLive(record);
		if (stale) {
			try {
				await rm(referencePath, { force: true });
				swept.push(referencePath);
			} catch {
				// Left for the next sweep; it is not counted as a reference either.
			}
			continue;
		}
		references.push({
			pid: record?.pid as number,
			...(record?.processStartId ? { processStartId: record.processStartId } : {}),
			...(record?.sessionId ? { sessionId: record.sessionId } : {}),
			...(record?.recordedAt ? { recordedAt: record.recordedAt } : {}),
			referencePath,
		});
	}
	return { references, unknown: false, swept };
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
			? "reference state unreadable, so the directory is assumed in use"
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

async function generationRecencyMs(dir: string): Promise<number> {
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
 * counts as referenced. The generation this boot is about to use is never a
 * candidate, and neither is the legacy unsuffixed base directory: kernels
 * spawned by pre-generation hosts run from it without leaving references, so
 * "no references" is not evidence that it is free.
 */
export async function pruneKernelVenvGenerations(
	base: string,
	options: { activeDir?: string; retention?: number } = {},
): Promise<KernelVenvPruneReport> {
	const retention = Math.max(0, options.retention ?? RETIRED_VENV_RETENTION);
	const candidates = (await listKernelVenvGenerations(base)).filter((dir) => dir !== options.activeDir);
	const kept: KernelVenvPruneReport["kept"] = [];
	const unreferenced: { dir: string; recencyMs: number }[] = [];
	for (const dir of candidates) {
		const state = await readKernelVenvInUseState(dir);
		if (state.unknown || state.references.length > 0) {
			kept.push({ dir, liveReferences: state.references.length, protectedByReference: true });
			continue;
		}
		unreferenced.push({ dir, recencyMs: await generationRecencyMs(dir) });
	}
	unreferenced.sort((a, b) => b.recencyMs - a.recencyMs || path.basename(b.dir).localeCompare(path.basename(a.dir)));
	for (const entry of unreferenced.slice(0, retention)) {
		kept.push({ dir: entry.dir, liveReferences: 0, protectedByReference: false });
	}
	const removed: string[] = [];
	for (const entry of unreferenced.slice(retention)) {
		try {
			await rm(entry.dir, { recursive: true, force: true });
			removed.push(entry.dir);
		} catch {
			kept.push({ dir: entry.dir, liveReferences: 0, protectedByReference: false });
		}
	}
	return { removed, kept };
}
