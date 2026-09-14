// R4 retention classes: `TMPDIR/prime-agent-*` directories, split into families
// so that no rule can ever run over the whole prefix.
//
// Design: /tmp/audit_r/round-08/disk-retention.md §1 R4 and D-3 (90% of the
// `prime-agent-*` entries are 0-byte directories that share a namespace with the
// live daemon socket dir), §3 (realpath containment, symlink refusal, the
// "cannot disprove" law), §4 (fixed reasons, dry-run parity).
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { type ReclaimRequest, reclaimWithinBudget, statSignature } from "./delete.js";
import type {
	ResolvedRetentionSettings,
	RetentionClassContext,
	RetentionClassId,
	RetentionClassModule,
	RetentionClassResult,
} from "./types.js";
import { SKIP } from "./types.js";

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const RLM_DIR_PREFIX = "prime-agent-rlm-";
const MANAGED_DIR_PREFIX = "prime-agent-";

/**
 * Hard rule (design §1 R4): `prime-agent-<uid>`, the live daemon socket dir, is
 * never a candidate, never a skip entry and never counted in `scanned`. The
 * family whitelist below rejects it before any lstat, so a sweep cannot even
 * look at it. `user` is `defaultDaemonSocketDir()`'s suffix when `getuid` is
 * absent, and is reserved the same way.
 */
const DAEMON_SOCKET_DIR_SHAPE = /^prime-agent-(?:[0-9]+|user)$/;

/**
 * The shape of a live holder (design §1 R4 safety check ③): anything holding a
 * socket, a lock or a guard in the subtree means a process still owns the dir.
 */
const IN_USE_ENTRY_SHAPE = /\.(?:sock|lock|guard)$/;

type TmpFamily = "rlm" | "other";

interface TmpFamilySpec {
	id: RetentionClassId;
	/** Family the class owns; `readdir` names outside it are not even counted. */
	owns: (name: string) => boolean;
	/** `0` or negative switches the class off (repo convention: settings-manager.ts:224). */
	off: (settings: ResolvedRetentionSettings) => boolean;
	offDetail: (settings: ResolvedRetentionSettings) => string;
	/** A candidate must be older than this: the knob, floored by the shared cooldown. */
	thresholdMs: (settings: ResolvedRetentionSettings) => number;
	/** `young:` reason suffix for this family. */
	young: string;
}

function isRlmFamily(name: string): boolean {
	return name.startsWith(RLM_DIR_PREFIX);
}

function isOtherFamily(name: string): boolean {
	if (!name.startsWith(MANAGED_DIR_PREFIX)) return false;
	if (isRlmFamily(name)) return false;
	return !DAEMON_SOCKET_DIR_SHAPE.test(name);
}

const FAMILIES: Record<TmpFamily, TmpFamilySpec> = {
	rlm: {
		id: "tmp-rlm-dirs",
		owns: isRlmFamily,
		off: (settings) => settings.tmpRlmDirHours <= 0,
		offDetail: (settings) => `retention.tmpRlmDirHours=${settings.tmpRlmDirHours}`,
		thresholdMs: (settings) =>
			Math.max(settings.tmpRlmDirHours * MS_PER_HOUR, settings.cooldownMinutes * MS_PER_MINUTE),
		young: "tmp-rlm-dir",
	},
	other: {
		id: "tmp-other-dirs",
		owns: isOtherFamily,
		off: (settings) => settings.tmpOtherDirDays <= 0,
		offDetail: (settings) => `retention.tmpOtherDirDays=${settings.tmpOtherDirDays}`,
		thresholdMs: (settings) =>
			Math.max(settings.tmpOtherDirDays * MS_PER_DAY, settings.cooldownMinutes * MS_PER_MINUTE),
		young: "tmp-other-dir",
	},
};

function errnoCode(error: unknown): string {
	return (error as NodeJS.ErrnoException).code ?? "unknown";
}

function isInsideRoot(rootReal: string, candidateReal: string): boolean {
	if (candidateReal === rootReal) return true;
	return candidateReal.startsWith(rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`);
}

interface SubtreeScan {
	bytes: number;
	/** Newest mtime anywhere in the subtree; the candidate's own mtime is seeded in. */
	newestMtimeMs: number;
	/** First `*.sock` / `*.lock` / `*.guard` found, if any. */
	livePath?: string;
	/** First non-directory entry found, if any; proves the subtree is not empty. */
	contentPath?: string;
	/** errno of the first failed read; a walk that cannot prove emptiness keeps the dir. */
	failed?: string;
}

/**
 * Recursive walk (design D-3 measured 3022/3022 `prime-agent-rlm-*` dirs at 0
 * bytes, so "provably empty" is the whole criterion). Any read error stops the
 * walk and is reported as `unverifiable:` — the dir is then kept.
 */
function scanSubtree(root: string, state: SubtreeScan): void {
	let names: string[];
	try {
		names = readdirSync(root).sort();
	} catch (error) {
		state.failed = errnoCode(error);
		return;
	}
	for (const name of names) {
		const path = join(root, name);
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(path);
		} catch (error) {
			state.failed = errnoCode(error);
			return;
		}
		if (stats.mtimeMs > state.newestMtimeMs) state.newestMtimeMs = stats.mtimeMs;
		if (stats.isDirectory() && !stats.isSymbolicLink()) {
			scanSubtree(path, state);
			if (state.failed !== undefined) return;
			continue;
		}
		state.bytes += Math.max(0, stats.size);
		if (IN_USE_ENTRY_SHAPE.test(name)) {
			state.livePath ??= path;
			continue;
		}
		// A file, a symlink, a fifo — anything that is not a directory counts as content.
		state.contentPath ??= path;
	}
}

async function scanTmpFamily(context: RetentionClassContext, family: TmpFamily): Promise<RetentionClassResult> {
	const spec = FAMILIES[family];
	const { settings, roots } = context;
	const result: RetentionClassResult = {
		class: spec.id,
		scanned: 0,
		reclaimed: 0,
		bytes: 0,
		skipped: [],
		capped: false,
		disabled: false,
	};
	if (spec.off(settings)) {
		// Off by default: report the switch instead of a silent zero (design §4.4).
		context.log(`retention ${spec.id}: disabled (${spec.offDetail(settings)})`);
		return { ...result, disabled: true };
	}

	let names: string[];
	try {
		names = readdirSync(roots.tmpDir).sort();
	} catch (error) {
		const code = errnoCode(error);
		if (code === "ENOENT") return result;
		return {
			...result,
			skipped: [{ path: roots.tmpDir, reason: SKIP.unverifiable(code), detail: `readdir failed: ${code}` }],
		};
	}
	let rootReal: string;
	try {
		rootReal = realpathSync(roots.tmpDir);
	} catch (error) {
		const code = errnoCode(error);
		return {
			...result,
			skipped: [{ path: roots.tmpDir, reason: SKIP.unverifiable(`realpath-${code}`), detail: "tmp root" }],
		};
	}

	const thresholdMs = spec.thresholdMs(settings);
	const requests: ReclaimRequest[] = [];

	for (const name of names) {
		// Family whitelist first: `prime-agent-<uid>` and every non-managed name
		// (e.g. `rlm-tmp`) never reach lstat, `scanned` or `skipped`.
		if (!spec.owns(name)) continue;
		const path = join(roots.tmpDir, name);
		result.scanned += 1;
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(path);
		} catch (error) {
			result.skipped.push({ path, reason: SKIP.unverifiable(errnoCode(error)) });
			continue;
		}
		if (stats.isSymbolicLink()) {
			result.skipped.push({ path, reason: SKIP.unverifiable("symlink"), detail: "candidate is a symlink" });
			continue;
		}
		if (!stats.isDirectory()) {
			result.skipped.push({ path, reason: SKIP.unverifiable("not-directory") });
			continue;
		}
		let candidateReal: string;
		try {
			candidateReal = realpathSync(path);
		} catch (error) {
			result.skipped.push({ path, reason: SKIP.unverifiable(`realpath-${errnoCode(error)}`) });
			continue;
		}
		if (!isInsideRoot(rootReal, candidateReal)) {
			result.skipped.push({ path, reason: SKIP.unverifiable("outside-tmpdir"), detail: candidateReal });
			continue;
		}
		const subtree: SubtreeScan = { bytes: 0, newestMtimeMs: stats.mtimeMs };
		scanSubtree(path, subtree);
		if (subtree.failed !== undefined) {
			result.skipped.push({ path, reason: SKIP.unverifiable(subtree.failed), detail: "subtree walk failed" });
			continue;
		}
		if (subtree.livePath !== undefined) {
			result.skipped.push({ path, reason: SKIP.inUse("pid"), detail: subtree.livePath });
			continue;
		}
		if (subtree.contentPath !== undefined) {
			result.skipped.push({ path, reason: SKIP.notEmpty, detail: subtree.contentPath });
			continue;
		}
		const ageMs = context.now - subtree.newestMtimeMs;
		if (ageMs <= thresholdMs) {
			result.skipped.push({
				path,
				reason: SKIP.young(spec.young),
				detail: `newest mtime age ${Math.round(ageMs / MS_PER_MINUTE)}m <= ${Math.round(thresholdMs / MS_PER_MINUTE)}m`,
			});
			continue;
		}
		requests.push({ path, kind: "dir", bytes: subtree.bytes, entries: 1, signature: statSignature(path) });
	}

	const outcome = await reclaimWithinBudget(context, requests);
	result.reclaimed = outcome.reclaimed;
	result.bytes = outcome.bytes;
	result.capped = outcome.capped;
	result.skipped.push(...outcome.skipped);
	return result;
}

/** R4 `prime-agent-rlm-*`: recursively empty ephemeral session dirs, past the cooldown. */
export const tmpRlmDirsModule: RetentionClassModule = {
	id: "tmp-rlm-dirs",
	scanAndReclaim: (context) => scanTmpFamily(context, "rlm"),
};

/** R4 other `prime-agent-*` families (telemetry, `*-test-*`): off by default. */
export const tmpOtherDirsModule: RetentionClassModule = {
	id: "tmp-other-dirs",
	scanAndReclaim: (context) => scanTmpFamily(context, "other"),
};
