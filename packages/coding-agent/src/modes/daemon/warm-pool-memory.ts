import { readFileSync } from "node:fs";
import { freemem } from "node:os";
import { execFileSyncHidden } from "../../utils/child-process.js";

/**
 * The warm spare pool's memory-pressure floor must read *available* memory, not
 * `os.freemem()`. On macOS the free list excludes inactive, speculative and
 * purgeable pages that are reclaimable on demand, so a healthy machine reads a
 * few hundred MiB "free" no matter how much RAM is actually spare — and a floor
 * measured against that reading never passes, which kept the pool from stocking
 * at all. Linux gets the same honest figure from MemAvailable.
 *
 * Every probe falls back to `freemem()` when its source is missing or
 * unparseable: a floor read that errs conservative (lower) only ever delays a
 * spare, it never overcommits.
 */

/** `vm_stat` page counters that are reclaimable without swapping. */
const VM_STAT_RECLAIMABLE_FIELDS = ["Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"] as const;

/**
 * Parse available bytes from `vm_stat` output: the reclaimable page counters
 * times the page size from the header. Returns undefined when the page size or
 * the free counter is missing (a later counter absent counts as zero — old
 * macOS versions predating it still answer usefully).
 */
export function parseVmStatAvailableBytes(vmStat: string): number | undefined {
	const header = /page size of (\d+) bytes/.exec(vmStat);
	if (!header) {
		return undefined;
	}
	const pageSize = Number(header[1]);
	if (!Number.isFinite(pageSize) || pageSize <= 0) {
		return undefined;
	}
	let pages = 0;
	for (const field of VM_STAT_RECLAIMABLE_FIELDS) {
		const match = new RegExp(`^${field}:\\s+(\\d+)\\.?\\s*$`, "m").exec(vmStat);
		if (field === "Pages free" && !match) {
			return undefined;
		}
		pages += match ? Number(match[1]) : 0;
	}
	return pages * pageSize;
}

/** Parse available bytes from /proc/meminfo's MemAvailable line (kB). */
export function parseMeminfoAvailableBytes(meminfo: string): number | undefined {
	const match = /^MemAvailable:\s+(\d+)\s*kB\s*$/m.exec(meminfo);
	if (!match) {
		return undefined;
	}
	const value = Number(match[1]);
	return Number.isFinite(value) ? value * 1024 : undefined;
}

/**
 * Memory available without swapping, best effort per platform. The fallback
 * chain ends at `os.freemem()`, so the reading never disappears; it only gets
 * more conservative.
 */
export function availableMemoryBytes(platform: NodeJS.Platform = process.platform): number {
	if (platform === "darwin") {
		try {
			const parsed = parseVmStatAvailableBytes(execFileSyncHidden("vm_stat", [], { encoding: "utf8" }));
			if (parsed !== undefined) {
				return parsed;
			}
		} catch {
			// fall through to the conservative default
		}
	} else if (platform === "linux") {
		try {
			const parsed = parseMeminfoAvailableBytes(readFileSync("/proc/meminfo", "utf8"));
			if (parsed !== undefined) {
				return parsed;
			}
		} catch {
			// fall through to the conservative default
		}
	}
	return freemem();
}
