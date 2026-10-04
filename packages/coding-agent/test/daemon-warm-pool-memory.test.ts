import { freemem } from "node:os";
import { describe, expect, it } from "vitest";
import {
	availableMemoryBytes,
	parseMeminfoAvailableBytes,
	parseVmStatAvailableBytes,
} from "../src/modes/daemon/warm-pool-memory.js";

/**
 * Real `vm_stat` output shape from an Apple Silicon macOS host (page size
 * 16384); the counters are scaled down, the layout is verbatim.
 */
const VM_STAT_16K = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            500000.
Pages inactive:                          200000.
Pages speculative:                        30000.
Pages throttled:                              0.
Pages wired down:                       1000000.
Pages purgeable:                          4000.
"Translation faults":                1234567890.
Pages copy-on-write:                     654321.
Pages zero filled:                     12345678.
Pages reactivated:                      123456.
Pages purged:                             12345.
File-backed pages:                       234000.
Anonymous pages:                         566000.
Pages stored in compressor:                   0.
Pages occupied by compressor:                 0.
Decompressions:                                 0.
Compressions:                                   0.
Pageins:                                1234567.
Pageouts:                                   123.
Swapins:                                      0.
Swapouts:                                     0.
`;

const VM_STAT_4K = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                                1000.
Pages active:                            50000.
Pages inactive:                          20000.
Pages speculative:                        3000.
Pages purgeable:                           400.
`;

const MEMINFO = `MemTotal:       32768000 kB
MemFree:         1024000 kB
MemAvailable:   16777216 kB
Buffers:          512000 kB
Cached:          8192000 kB
`;

describe("parseVmStatAvailableBytes", () => {
	it("counts free, inactive, speculative and purgeable pages at the header's page size", () => {
		// (10000 + 200000 + 30000 + 4000) * 16384
		expect(parseVmStatAvailableBytes(VM_STAT_16K)).toBe(244000 * 16384);
	});

	it("honours a 4096-byte page size", () => {
		// (1000 + 20000 + 3000 + 400) * 4096
		expect(parseVmStatAvailableBytes(VM_STAT_4K)).toBe(24400 * 4096);
	});

	it("counts a missing reclaimable counter as zero but requires the free counter", () => {
		const withoutSpeculative = VM_STAT_4K.replace(/^Pages speculative:.*\n/m, "");
		expect(parseVmStatAvailableBytes(withoutSpeculative)).toBe((1000 + 20000 + 400) * 4096);
		const withoutFree = VM_STAT_4K.replace(/^Pages free:.*\n/m, "");
		expect(parseVmStatAvailableBytes(withoutFree)).toBeUndefined();
	});

	it("refuses output without a page-size header", () => {
		expect(parseVmStatAvailableBytes("Pages free: 1000.\n")).toBeUndefined();
		expect(parseVmStatAvailableBytes("")).toBeUndefined();
	});
});

describe("parseMeminfoAvailableBytes", () => {
	it("reads MemAvailable in kB", () => {
		expect(parseMeminfoAvailableBytes(MEMINFO)).toBe(16777216 * 1024);
	});

	it("refuses meminfo without MemAvailable rather than guessing from MemFree", () => {
		expect(parseMeminfoAvailableBytes(MEMINFO.replace(/^MemAvailable:.*\n/m, ""))).toBeUndefined();
		expect(parseMeminfoAvailableBytes("")).toBeUndefined();
	});
});

describe("availableMemoryBytes", () => {
	it("returns a positive reading on this host", () => {
		expect(availableMemoryBytes()).toBeGreaterThan(0);
	});

	it("falls back to freemem() where the platform probes cannot read", () => {
		// linux on this macOS host: no /proc/meminfo, so the conservative fallback
		// answers; win32 has no probe at all.
		expect(availableMemoryBytes("linux")).toBe(freemem());
		expect(availableMemoryBytes("win32")).toBe(freemem());
	});

	it.runIf(process.platform === "darwin")("reads reclaimable memory on macOS, above the bare free list", () => {
		// The whole point of the metric: inactive+speculative+purgeable pages count.
		// freemem() alone stays under a few hundred MiB on any healthy macOS host that
		// has been up long enough to fill its caches; the available reading must not
		// be smaller than the free list it includes.
		expect(availableMemoryBytes("darwin")).toBeGreaterThanOrEqual(freemem());
	});
});
