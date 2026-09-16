import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	compactOrphanProcessJournal,
	readActiveOrphanProcesses,
	reapForeignOrphanProcessRecords,
} from "../src/core/orphan-process-journal.js";
import { getProcessStartId } from "../src/core/session-lease.js";

/**
 * L9F-1 / audit F1: a worker's orphan journal also carries records written by
 * foreign owners (a session host that inherited the journal env writes with its
 * own pid as ownerPid). Every reader is owner-filtered and every reaper is
 * owner- or kernel-scoped, so once the foreign writer dies nothing ever
 * deactivates its records: they sit `active` forever and compaction keeps the
 * newest one per (ownerPid, pid) indefinitely. The reclaim here retires exactly
 * the demonstrably dead ones - a pid that no longer exists, or now belongs to a
 * different start id - by appending the deactivation record the writer would
 * have written. The rejection semantics are unchanged: a foreign record whose
 * pid is still live is never killed and never rewritten, and the journal
 * owner's own records stay the business of the owner-filtered reapers.
 */

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function tempJournal(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(directory);
	return join(directory, "worker.orphans.jsonl");
}

function recordLine(input: { pid: number; ownerPid: number; active: boolean; processStartId?: string }): string {
	return `${JSON.stringify({
		version: 1,
		pid: input.pid,
		ownerPid: input.ownerPid,
		...(input.processStartId === undefined ? {} : { processStartId: input.processStartId }),
		active: input.active,
		recordedAt: new Date().toISOString(),
	})}\n`;
}

describe("L9F-1: foreign-owner records are reaped once their pid is dead", () => {
	it("retires dead and reused foreign pids and leaves live pids and owner records alone", () => {
		const path = tempJournal("prime-orphan-foreign-reap-");
		const owner = 111_000; // the worker whose journal this is
		const foreignWriter = 222_000; // an external writer (a session host), long gone
		const deadPid = 333_000; // its bash child, exited
		const reusedPid = 334_000; // pid recycled to an unrelated process
		const livePid = process.pid; // still running under the recorded identity
		const ownerDeadPid = 335_000; // the owner's own dead child: not this reaper's business
		const unknownLivePid = 336_000; // pid-only record, pid exists, identity unprovable

		appendFileSync(
			path,
			[
				recordLine({ pid: deadPid, ownerPid: foreignWriter, active: true }),
				recordLine({ pid: reusedPid, ownerPid: foreignWriter, active: true, processStartId: "ps:old" }),
				recordLine({ pid: livePid, ownerPid: foreignWriter, active: true, processStartId: "ps:live" }),
				recordLine({ pid: ownerDeadPid, ownerPid: owner, active: true }),
				recordLine({ pid: unknownLivePid, ownerPid: foreignWriter, active: true }),
			].join(""),
		);

		const query = (pid: number): string | undefined => {
			if (pid === livePid) return "ps:live";
			if (pid === reusedPid) return "ps:current-holder";
			if (pid === unknownLivePid) return "ps:somebody";
			return undefined; // deadPid, ownerDeadPid: the pid is gone
		};

		const reaped = reapForeignOrphanProcessRecords(path, owner, query);
		// RED on HEAD: no such reaper existed; the dead foreign records stayed active forever.
		expect(reaped).toBe(2);
		// The foreign owner's reader now sees only genuinely live pids.
		expect(readActiveOrphanProcesses(path, foreignWriter).map((orphan) => orphan.pid)).toEqual([
			livePid,
			unknownLivePid,
		]);
		// The journal owner's records are untouched (owner-filtered reapers own them).
		expect(readActiveOrphanProcesses(path, owner).map((orphan) => orphan.pid)).toEqual([ownerDeadPid]);

		// The retirement must survive compaction - that is the buildup path: the
		// rewrite keeps the newest record per (ownerPid, pid), so the appended
		// deactivations are what stop dead foreign records piling up forever.
		compactOrphanProcessJournal(path);
		expect(readActiveOrphanProcesses(path, foreignWriter).map((orphan) => orphan.pid)).toEqual([
			livePid,
			unknownLivePid,
		]);
		expect(readActiveOrphanProcesses(path, owner).map((orphan) => orphan.pid)).toEqual([ownerDeadPid]);

		// Idempotent: a second sweep has nothing new to retire.
		expect(reapForeignOrphanProcessRecords(path, owner, query)).toBe(0);
	});

	it("reaps a real child once it exits and keeps it while it runs (real identity queries)", async () => {
		const path = tempJournal("prime-orphan-foreign-reap-real-");
		const owner = 111_000;
		const foreignWriter = 222_000;
		const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
		child.unref();
		expect(child.pid).toBeTypeOf("number");
		const startId = getProcessStartId(child.pid!);
		expect(startId).toBeDefined();
		appendFileSync(
			path,
			recordLine({ pid: child.pid!, ownerPid: foreignWriter, active: true, processStartId: startId }),
		);

		// Positive control: the pid is alive under the recorded identity, so the
		// record stays exactly as the (dead) writer left it.
		expect(reapForeignOrphanProcessRecords(path, owner)).toBe(0);
		expect(readActiveOrphanProcesses(path, foreignWriter).map((orphan) => orphan.pid)).toEqual([child.pid]);

		process.kill(child.pid!, "SIGKILL");
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		expect(reapForeignOrphanProcessRecords(path, owner)).toBe(1);
		expect(readActiveOrphanProcesses(path, foreignWriter)).toEqual([]);
	});
});
