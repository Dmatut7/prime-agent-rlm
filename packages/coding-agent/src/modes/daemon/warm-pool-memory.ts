import { readFileSync } from "node:fs";
import { freemem } from "node:os";
import { execFileHidden, execFileSyncHidden } from "../../utils/child-process.js";

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
 *
 * The macOS probe shells out to `vm_stat` — a real subprocess spawn — while the
 * pool's probes run on every ensureWarmSpare and every sweep. The reading only
 * needs seconds-scale freshness, so the darwin branch caches it
 * ({@link createAvailableMemoryProbe}): a probe inside the TTL serves the
 * cached value, a probe past it serves the previous value and refreshes in the
 * background. Only the very first probe of a process pays a synchronous
 * vm_stat. linux (/proc/meminfo) and the freemem() fallback are microseconds
 * and stay uncached.
 */

/** `vm_stat` page counters that are reclaimable without swapping. */
const VM_STAT_RECLAIMABLE_FIELDS = ["Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"] as const;

/** How long a probed darwin reading serves before the next probe refreshes it. */
const DEFAULT_AVAILABLE_MEMORY_CACHE_TTL_MS = 7_500;

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

export interface AvailableMemoryProbeOptions {
	/** Platform to probe; defaults to the host platform. */
	platform?: NodeJS.Platform;
	/** How long a cached darwin reading serves; default 7.5s. */
	ttlMs?: number;
	/** Clock override for tests. */
	now?: () => number;
}

export interface AvailableMemoryProbe {
	/**
	 * Memory available without swapping, best effort per platform. Never blocks
	 * on vm_stat past the first darwin probe of this probe's lifetime: a stale
	 * reading answers while a background refresh runs. The fallback chain ends
	 * at `os.freemem()`, so the reading never disappears; it only gets more
	 * conservative.
	 */
	availableMemoryBytes(): number;
	/**
	 * A fresh reading, awaiting the platform probe and updating the cache.
	 * Concurrent samples share one vm_stat spawn.
	 */
	sampleAvailableMemoryBytes(): Promise<number>;
}

export function createAvailableMemoryProbe(options: AvailableMemoryProbeOptions = {}): AvailableMemoryProbe {
	const platform = options.platform ?? process.platform;
	const ttlMs = options.ttlMs ?? DEFAULT_AVAILABLE_MEMORY_CACHE_TTL_MS;
	const now = options.now ?? Date.now;
	let cache: { bytes: number; at: number } | undefined;
	let refresh: Promise<number> | undefined;

	/** The pre-cache read: vm_stat on darwin, /proc/meminfo on linux, freemem() last. */
	const readSync = (): number => {
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
	};

	const sample = (): Promise<number> => {
		if (platform !== "darwin") {
			return Promise.resolve(readSync());
		}
		refresh ??= new Promise<number>((resolveSample) => {
			execFileHidden("vm_stat", [], { encoding: "utf8" }, (error, stdout) => {
				refresh = undefined;
				const parsed = error ? undefined : parseVmStatAvailableBytes(stdout);
				// A failed async probe caches the freemem() fallback too, so a broken
				// vm_stat cannot spawn one subprocess per pool check.
				const reading = parsed ?? freemem();
				cache = { bytes: reading, at: now() };
				resolveSample(reading);
			});
		});
		return refresh;
	};

	return {
		availableMemoryBytes(): number {
			if (platform !== "darwin") {
				return readSync();
			}
			const at = now();
			if (cache !== undefined) {
				if (at - cache.at >= ttlMs) {
					// Stale-while-revalidate: the caller gets the previous reading now,
					// the next one lands in the background.
					void sample();
				}
				return cache.bytes;
			}
			// The first probe of this probe's lifetime has nothing to serve yet;
			// it pays one synchronous vm_stat so the answer stays honest.
			const reading = readSync();
			cache = { bytes: reading, at };
			return reading;
		},
		sampleAvailableMemoryBytes: sample,
	};
}

const defaultProbes = new Map<NodeJS.Platform, AvailableMemoryProbe>();

function defaultProbe(platform: NodeJS.Platform): AvailableMemoryProbe {
	let probe = defaultProbes.get(platform);
	if (probe === undefined) {
		probe = createAvailableMemoryProbe({ platform });
		defaultProbes.set(platform, probe);
	}
	return probe;
}

/**
 * Memory available without swapping, best effort per platform. The darwin
 * reading is cached (see the module header); linux and the freemem() fallback
 * read through every call.
 */
export function availableMemoryBytes(platform: NodeJS.Platform = process.platform): number {
	return defaultProbe(platform).availableMemoryBytes();
}

/** A fresh reading for the shared probe, awaiting the platform probe. */
export function sampleAvailableMemoryBytes(platform: NodeJS.Platform = process.platform): Promise<number> {
	return defaultProbe(platform).sampleAvailableMemoryBytes();
}
