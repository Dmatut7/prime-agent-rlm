// R5 retention class (read side): `pi-bash-*.log` temp files left by bash runs.
//
// Design: /tmp/audit_r/round-08/disk-retention.md §1 R5 — the write-side cap
// (`retention.bashTempFileMaxBytes`, owned elsewhere) and this age sweep are two
// halves of one fix; sweeping without capping refills the dir next week.
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
	if (!(settings.bashTempFileHours > 0)) {
		context.log(`retention bash-temp-files: disabled (retention.bashTempFileHours=${settings.bashTempFileHours})`);
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
	const thresholdMs = Math.max(settings.bashTempFileHours * MS_PER_HOUR, settings.cooldownMinutes * MS_PER_MINUTE);
	const requests: ReclaimRequest[] = [];

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
		if (ageMs <= thresholdMs) {
			result.skipped.push({
				path,
				reason: SKIP.young("bash-temp-file"),
				detail: `age ${Math.round(ageMs / MS_PER_MINUTE)}m <= ${Math.round(thresholdMs / MS_PER_MINUTE)}m`,
			});
			continue;
		}
		requests.push({ path, kind: "file", bytes: stats.size, entries: 1, signature: statSignature(path) });
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
