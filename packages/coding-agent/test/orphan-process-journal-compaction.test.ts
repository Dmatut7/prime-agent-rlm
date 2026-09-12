import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMPACT_AFTER_BYTES,
	COMPACT_AFTER_RECORDS,
	compactOrphanProcessJournal,
	DEGRADED_READ_MAX_BYTES,
	flushOrphanProcessJournal,
	ORPHAN_PROCESS_JOURNAL_ENV,
	readActiveOrphanProcesses,
	recordOrphanProcessState,
} from "../src/core/orphan-process-journal.js";

const tempDirs: string[] = [];
const originalJournalPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];

afterEach(async () => {
	// Land or cancel every scheduled start-id capture before the journals disappear.
	await flushOrphanProcessJournal();
	if (originalJournalPath === undefined) {
		delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	} else {
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = originalJournalPath;
	}
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function tempJournal(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(directory);
	return join(directory, "worker.orphans.jsonl");
}

function recordLine(input: {
	pid: number;
	ownerPid: number;
	active: boolean;
	kernelPid?: number;
	processStartId?: string;
	pad?: string;
}): string {
	return `${JSON.stringify({
		version: 1,
		pid: input.pid,
		ownerPid: input.ownerPid,
		...(input.kernelPid === undefined ? {} : { kernelPid: input.kernelPid }),
		...(input.processStartId === undefined ? {} : { processStartId: input.processStartId }),
		active: input.active,
		recordedAt: new Date().toISOString(),
		...(input.pad === undefined ? {} : { pad: input.pad }),
	})}\n`;
}

function lines(path: string): string[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0);
}

describe("orphan process journal compaction", () => {
	it("rewrites to the live records at the record bound without changing what any reader sees", async () => {
		const path = tempJournal("prime-orphan-journal-records-");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		// Two owners share the journal (a worker host and an unrelated reader pid),
		// and the same pid appears under both: compaction must key on the pair, or
		// one owner's live record is dropped because another owner's dead one is newer.
		const ownerA = process.pid + 1000;
		const ownerB = process.pid + 2000;
		const records: string[] = [];
		for (let index = 0; index < COMPACT_AFTER_RECORDS + 40; index++) {
			const pid = 900_000 + index;
			const ownerPid = index % 2 === 0 ? ownerA : ownerB;
			records.push(recordLine({ pid, ownerPid, active: true, processStartId: `ps:stamp-${index}` }));
			// Half of them are superseded by a later record for the same pair, and a
			// quarter end up inactive: both are dead weight the rewrite must drop.
			if (index % 2 === 0) {
				records.push(recordLine({ pid, ownerPid, active: index % 4 !== 0, processStartId: `ps:stamp-${index}` }));
			}
		}
		// The same pid under the other owner, still active, written before ownerA's
		// inactive one: keyed by pid alone this record would be lost.
		const sharedPid = 900_000;
		records.push(recordLine({ pid: sharedPid, ownerPid: ownerB, active: true, processStartId: "ps:shared" }));
		records.push(recordLine({ pid: sharedPid, ownerPid: ownerA, active: false, processStartId: "ps:shared" }));
		appendFileSync(path, records.join(""));

		const beforeA = readActiveOrphanProcesses(path, ownerA);
		const beforeB = readActiveOrphanProcesses(path, ownerB);
		expect(beforeA.length).toBeGreaterThan(0);
		expect(beforeB.length).toBeGreaterThan(0);
		expect(lines(path).length).toBeGreaterThanOrEqual(COMPACT_AFTER_RECORDS);

		// One real append from this process trips the bound and compacts.
		recordOrphanProcessState(process.pid, true);
		await flushOrphanProcessJournal();

		const after = lines(path);
		expect(after.length).toBeLessThan(COMPACT_AFTER_RECORDS);
		for (const line of after) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		// Every live record survives, for both owners.
		const afterA = readActiveOrphanProcesses(path, ownerA);
		const afterB = readActiveOrphanProcesses(path, ownerB);
		expect(afterA.map((orphan) => orphan.pid).sort((a, b) => a - b)).toEqual(
			beforeA.map((orphan) => orphan.pid).sort((a, b) => a - b),
		);
		expect(afterB.map((orphan) => orphan.pid).sort((a, b) => a - b)).toEqual(
			beforeB.map((orphan) => orphan.pid).sort((a, b) => a - b),
		);
		expect(afterB.some((orphan) => orphan.pid === sharedPid)).toBe(true);
		expect(afterA.some((orphan) => orphan.pid === sharedPid)).toBe(false);
		// The appending pid is now journaled too, with its enrichment landed.
		expect(readActiveOrphanProcesses(path, process.pid).map((orphan) => orphan.pid)).toEqual([process.pid]);
		expect(statSync(path).size).toBeGreaterThan(0);
	});

	it("rewrites at the byte bound and drops records whose latest state is inactive", async () => {
		const path = tempJournal("prime-orphan-journal-bytes-");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		const ownerPid = process.pid + 3000;
		const pad = "x".repeat(64 * 1024);
		const records: string[] = [];
		// Few records, well under the record bound, but past the byte bound; each pid
		// ends inactive so a correct rewrite leaves nothing of them behind.
		const pidCount = Math.ceil(COMPACT_AFTER_BYTES / (pad.length + 256)) + 2;
		expect(pidCount).toBeLessThan(COMPACT_AFTER_RECORDS);
		for (let index = 0; index < pidCount; index++) {
			const pid = 800_000 + index;
			records.push(recordLine({ pid, ownerPid, active: true, pad }));
			records.push(recordLine({ pid, ownerPid, active: false, pad: "" }));
		}
		appendFileSync(path, records.join(""));
		expect(statSync(path).size).toBeGreaterThanOrEqual(COMPACT_AFTER_BYTES);
		expect(lines(path).length).toBeLessThan(COMPACT_AFTER_RECORDS);
		expect(readActiveOrphanProcesses(path, ownerPid)).toEqual([]);

		recordOrphanProcessState(process.pid, true);
		await flushOrphanProcessJournal();

		expect(statSync(path).size).toBeLessThan(COMPACT_AFTER_BYTES);
		expect(readActiveOrphanProcesses(path, ownerPid)).toEqual([]);
		// Only this process's own pid remains: the rewrite kept the live record and
		// dropped every inactive one instead of carrying the padding forward.
		expect(readActiveOrphanProcesses(path, process.pid).map((orphan) => orphan.pid)).toEqual([process.pid]);
		expect(lines(path).length).toBeLessThanOrEqual(2);
	});

	it("keeps the newest record per owner and pid when asked to compact directly", () => {
		const path = tempJournal("prime-orphan-journal-direct-");
		const ownerPid = process.pid + 4000;
		appendFileSync(
			path,
			[
				recordLine({ pid: 700_001, ownerPid, active: true, processStartId: "ps:old" }),
				recordLine({ pid: 700_001, ownerPid, active: true, processStartId: "ps:new" }),
				recordLine({ pid: 700_002, ownerPid, active: true }),
				recordLine({ pid: 700_002, ownerPid, active: false }),
				// A torn line and a foreign-version line are dead weight for every reader.
				'{"version":1,"pid":700003,"ownerPid":',
				recordLine({ pid: 700_004, ownerPid, active: true }).replace('"version":1', '"version":2'),
			].join("\n"),
		);

		compactOrphanProcessJournal(path);

		const parsed = lines(path).map((line) => {
			const { pid, processStartId, active } = JSON.parse(line) as {
				pid: number;
				processStartId?: string;
				active: boolean;
			};
			return { pid, processStartId, active };
		});
		expect(parsed).toEqual([{ pid: 700_001, processStartId: "ps:new", active: true }]);
		expect(readActiveOrphanProcesses(path, ownerPid).map((orphan) => orphan.processStartId)).toEqual(["ps:new"]);
	});

	it("leaves no compaction temp behind and stays readable while a journal is under the bounds", () => {
		const path = tempJournal("prime-orphan-journal-temps-");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		recordOrphanProcessState(process.pid, true);
		recordOrphanProcessState(process.pid, false);

		compactOrphanProcessJournal(path);

		expect(readActiveOrphanProcesses(path, process.pid)).toEqual([]);
		expect(leftoverTemps(path)).toEqual([]);
		// An empty rewrite must not break the next append.
		recordOrphanProcessState(process.pid, true);
		expect(readActiveOrphanProcesses(path, process.pid).map((orphan) => orphan.pid)).toEqual([process.pid]);
	});
});

function leftoverTemps(path: string): string[] {
	return readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"));
}

describe("orphan process journal bounded reads", () => {
	it("parses at most the bounded tail of an oversized journal and says so", () => {
		const path = tempJournal("prime-orphan-journal-bounded-");
		const ownerPid = process.pid + 5000;
		const kernelPid = 600_000;
		// A live handle whose only record sits in the head of an oversized journal.
		const head = recordLine({ pid: 610_000, ownerPid, active: true, kernelPid });
		const filler = "y".repeat(64 * 1024);
		const fillerCount = Math.ceil(DEGRADED_READ_MAX_BYTES / (filler.length + 256)) + 2;
		const body: string[] = [head];
		for (let index = 0; index < fillerCount; index++) {
			body.push(recordLine({ pid: 620_000 + index, ownerPid, active: false, pad: filler }));
		}
		// The record the degraded stall path actually needs is the most recent one.
		const tail = recordLine({ pid: 610_001, ownerPid, active: true, kernelPid });
		writeFileSync(path, `${body.join("")}${tail}`);
		expect(statSync(path).size).toBeGreaterThan(DEGRADED_READ_MAX_BYTES);

		const bounded = readActiveOrphanProcesses(path, ownerPid, { maxBytes: DEGRADED_READ_MAX_BYTES });
		// Positive control: the same call over a journal under the bound sees both.
		const small = tempJournal("prime-orphan-journal-bounded-small-");
		writeFileSync(small, `${head}${tail}`);
		expect(readActiveOrphanProcesses(small, ownerPid, { maxBytes: DEGRADED_READ_MAX_BYTES })).toHaveLength(2);

		// The bounded read never parses more than its window: the head-only record is
		// out of it, so the count is a lower bound rather than a full scan of a file
		// that compaction failed to shrink.
		expect(bounded.map((orphan) => orphan.pid)).toEqual([610_001]);
		// An unbounded read still answers completely.
		expect(
			readActiveOrphanProcesses(path, ownerPid, { maxBytes: Number.MAX_SAFE_INTEGER })
				.map((orphan) => orphan.pid)
				.sort((a, b) => a - b),
		).toEqual([610_000, 610_001]);
	});
});
