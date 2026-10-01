// R5 retention class (read side): `pi-bash-*.log` temp files left by bash runs.
//
// Design: /tmp/audit_r/round-08/disk-retention.md §1 R5 — the write-side cap
// (`retention.bashTempFileMaxBytes`, owned elsewhere), this age sweep and the
// count cap (`retention.bashTempFileMaxCount`) are the three halves of one fix;
// sweeping without capping refills the dir next week, and an age window alone
// does not bound how many files a busy day creates (round-09 S3).
// §3: regular files only, non-following lstat, `unverifiable:` on anything else.
// §4: fixed reasons, dry-run parity.

import type { Stats } from "node:fs";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ReclaimRequest, reclaimWithinBudget, statSignature } from "./delete.js";
import type {
	RetentionClassContext,
	RetentionClassModule,
	RetentionClassResult,
	RetentionSkipReason,
} from "./types.js";
import { SKIP } from "./types.js";

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * Exact name shape from the producer (`bash-executor.ts:59`:
 * `join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`)`). Not `pi-*`:
 * that prefix also covers unrelated tooling, and a wildcard would delete it.
 */
const BASH_TEMP_FILE_SHAPE = /^pi-bash-[0-9a-f]+\.log$/;

function errnoCode(error: unknown): string {
	return (error as NodeJS.ErrnoException).code ?? "unknown";
}

function nonRegularReason(stats: Stats): RetentionSkipReason {
	if (stats.isSymbolicLink()) return SKIP.unverifiable("symlink");
	if (stats.isSocket()) return SKIP.unverifiable("socket");
	return SKIP.unverifiable("not-regular-file");
}

async function scanAndReclaim(context: RetentionClassContext): Promise<RetentionClassResult> {
	const { settings, roots } = context;
	const result: RetentionClassResult = {
		class: "bash-temp-files",
		scanned: 0,
		reclaimed: 0,
		bytes: 0,
		skipped: [],
		capped: false,
		disabled: false,
	};
	const ageHours = settings.bashTempFileHours > 0 ? settings.bashTempFileHours : 0;
	const maxCount = settings.bashTempFileMaxCount > 0 ? Math.floor(settings.bashTempFileMaxCount) : 0;
	if (ageHours === 0 && maxCount === 0) {
		context.log(
			`retention bash-temp-files: disabled (retention.bashTempFileHours=${settings.bashTempFileHours}, retention.bashTempFileMaxCount=${settings.bashTempFileMaxCount})`,
		);
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

	// The cooldown floor keeps a file that a running bash command is still appending to.
	// It gates both passes: the age pass never goes below it, and the count pass uses
	// it directly (a file young enough to be mid-write is kept however many there are).
	const cooldownMs = settings.cooldownMinutes * MS_PER_MINUTE;
	const ageThresholdMs = Math.max(ageHours * MS_PER_HOUR, cooldownMs);
	const agedOut: { path: string; bytes: number; mtimeMs: number }[] = [];
	const survivors: { path: string; bytes: number; mtimeMs: number }[] = [];

	for (const name of names) {
		if (!BASH_TEMP_FILE_SHAPE.test(name)) continue;
		const path = join(roots.tmpDir, name);
		result.scanned += 1;
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(path);
		} catch (error) {
			result.skipped.push({ path, reason: SKIP.unverifiable(errnoCode(error)) });
			continue;
		}
		if (!stats.isFile()) {
			// Direct child of the tmp root plus a non-following lstat: nothing outside is reachable.
			result.skipped.push({ path, reason: nonRegularReason(stats) });
			continue;
		}
		const ageMs = context.now - stats.mtimeMs;
		if (ageHours > 0 && ageMs > ageThresholdMs) {
			agedOut.push({ path, bytes: stats.size, mtimeMs: stats.mtimeMs });
			continue;
		}
		survivors.push({ path, bytes: stats.size, mtimeMs: stats.mtimeMs });
	}

	const requests: ReclaimRequest[] = [];
	for (const file of agedOut) {
		requests.push({
			path: file.path,
			kind: "file",
			bytes: file.bytes,
			entries: 1,
			signature: statSignature(file.path),
		});
	}

	// Count pass (round-09 S3's second half): the age window bounds how old a file
	// gets, not how many a busy day creates. Over the cap the newest `maxCount`
	// survivors stay; the oldest of the rest go, down to the cooldown floor.
	const cooldownKept = new Set<string>();
	if (maxCount > 0 && survivors.length > maxCount) {
		const oldestFirst = [...survivors].sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
		const excess = survivors.length - maxCount;
		let dropped = 0;
		for (const file of oldestFirst) {
			if (dropped >= excess) break;
			if (context.now - file.mtimeMs <= cooldownMs) {
				cooldownKept.add(file.path);
				continue;
			}
			dropped += 1;
			requests.push({
				path: file.path,
				kind: "file",
				bytes: file.bytes,
				entries: 1,
				signature: statSignature(file.path),
			});
		}
	}

	// Kept files report why, one entry per path: the cooldown floor when it is what
	// saved an over-cap file, otherwise the age window (the pre-count-cap report).
	const requestedPaths = new Set(requests.map((request) => request.path));
	for (const file of survivors) {
		if (requestedPaths.has(file.path)) continue;
		const ageMs = context.now - file.mtimeMs;
		if (cooldownKept.has(file.path)) {
			result.skipped.push({
				path: file.path,
				reason: SKIP.young("bash-temp-file"),
				detail: `age ${Math.round(ageMs / MS_PER_MINUTE)}m <= ${Math.round(cooldownMs / MS_PER_MINUTE)}m (count cap keeps the cooldown floor)`,
			});
			continue;
		}
		if (ageHours > 0) {
			result.skipped.push({
				path: file.path,
				reason: SKIP.young("bash-temp-file"),
				detail: `age ${Math.round(ageMs / MS_PER_MINUTE)}m <= ${Math.round(ageThresholdMs / MS_PER_MINUTE)}m`,
			});
		}
	}

	const outcome = await reclaimWithinBudget(context, requests);
	result.reclaimed = outcome.reclaimed;
	result.bytes = outcome.bytes;
	result.capped = outcome.capped;
	result.skipped.push(...outcome.skipped);
	return result;
}

/** R5 read side: reclaim old `pi-bash-<hex>.log` temp files. */
export const bashTempFilesModule: RetentionClassModule = {
	id: "bash-temp-files",
	scanAndReclaim,
};
