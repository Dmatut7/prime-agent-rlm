import { spawn } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ActiveOrphanProcess,
	clearOrphanProcessJournal,
	flushOrphanProcessJournal,
	isOrphanPidReused,
	isOrphanProcessIdentityCurrent,
	ORPHAN_PROCESS_JOURNAL_ENV,
	readActiveOrphanProcesses,
	reapKernelOrphanProcesses,
	recordOrphanProcessState,
	shouldReapOrphanProcess,
} from "../src/core/orphan-process-journal.js";
import * as sessionLease from "../src/core/session-lease.js";
import { getProcessStartId } from "../src/core/session-lease.js";

const tempDirs: string[] = [];
const originalJournalPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];

afterEach(async () => {
	// Land or cancel every scheduled capture before the journals disappear, so a
	// capture from one test can never write into the next one's journal.
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

describe("orphan process journal", () => {
	it("repairs a torn trailing line before appending and repairs legacy journal modes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-torn-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;

		recordOrphanProcessState(process.pid, true);
		chmodSync(path, 0o644); // legacy mode must be repaired on the next append
		appendFileSync(path, '{"version":1,"pid":999999,"ownerPid":'); // crash mid-append

		recordOrphanProcessState(process.pid, false);
		await flushOrphanProcessJournal();

		const lines = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		expect(lines.some((line) => line.includes("999999"))).toBe(false);
		expect(lines.length).toBeGreaterThanOrEqual(2);
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
	});

	it("retains only detached processes still active for the crashed owner", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;

		recordOrphanProcessState(process.pid, true);
		await flushOrphanProcessJournal();

		const active = readActiveOrphanProcesses(path, process.pid);
		expect(active).toHaveLength(1);
		expect(active[0]?.pid).toBe(process.pid);
		expect(active[0] && isOrphanProcessIdentityCurrent(active[0])).toBe(true);
		expect(readActiveOrphanProcesses(path, process.pid + 1)).toEqual([]);

		recordOrphanProcessState(process.pid, false);
		expect(readActiveOrphanProcesses(path, process.pid)).toEqual([]);
		clearOrphanProcessJournal(path);
		expect(existsSync(path)).toBe(false);
	});

	it("journals the pid before the call returns and enriches it with the start id", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		const expectedStartId = getProcessStartId(process.pid);

		recordOrphanProcessState(process.pid, true);
		// Durable without awaiting anything: a host killed right after the spawn still
		// leaves the child journaled for the reaper.
		expect(readActiveOrphanProcesses(path, process.pid).map((orphan) => orphan.pid)).toEqual([process.pid]);

		await flushOrphanProcessJournal();
		const active = readActiveOrphanProcesses(path, process.pid);
		// The enriched record supersedes the pid-only one instead of adding a second active.
		expect(active).toHaveLength(1);
		expect(active[0]?.processStartId).toBe(expectedStartId);
		expect(active[0] && isOrphanProcessIdentityCurrent(active[0])).toBe(true);

		recordOrphanProcessState(process.pid, false);
		expect(readActiveOrphanProcesses(path, process.pid)).toEqual([]);
	});

	it("captures a helper-process start id off the blocking path", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		const expectedStartId = getProcessStartId(process.pid);
		// Forces the macOS/BSD/win32 shape on every platform: no cheap identity, so the
		// record goes out pid-only and the helper-process query is awaited afterwards.
		const noCheapStartId = vi.spyOn(sessionLease, "getProcProcessStartId").mockReturnValue(undefined);
		try {
			recordOrphanProcessState(process.pid, true);
			const pending = readActiveOrphanProcesses(path, process.pid);
			expect(pending).toHaveLength(1);
			expect(pending[0]?.processStartId).toBeUndefined();
			// Identity-free does not mean unprotected: the record still bounds pid reuse.
			expect(pending[0] && isOrphanPidReused(pending[0])).toBe(false);

			await flushOrphanProcessJournal();
			const enriched = readActiveOrphanProcesses(path, process.pid);
			expect(enriched).toHaveLength(1);
			expect(enriched[0]?.processStartId).toBe(expectedStartId);
			expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
			recordOrphanProcessState(process.pid, false);
		} finally {
			noCheapStartId.mockRestore();
		}
	});

	it("does not resurrect a pid deactivated while its capture was in flight", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		const noCheapStartId = vi.spyOn(sessionLease, "getProcProcessStartId").mockReturnValue(undefined);
		try {
			recordOrphanProcessState(process.pid, true);
			recordOrphanProcessState(process.pid, false);
			await flushOrphanProcessJournal();

			expect(readActiveOrphanProcesses(path, process.pid)).toEqual([]);
			const lines = readFileSync(path, "utf8")
				.split("\n")
				.filter((line) => line.length > 0);
			expect(lines).toHaveLength(2);
			expect(lines.map((line) => (JSON.parse(line) as { active: boolean }).active)).toEqual([true, false]);
		} finally {
			noCheapStartId.mockRestore();
		}
	});

	it("drops a capture whose journal was cleared before it landed", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		const noCheapStartId = vi.spyOn(sessionLease, "getProcProcessStartId").mockReturnValue(undefined);
		try {
			recordOrphanProcessState(process.pid, true);
			clearOrphanProcessJournal(path);
			await flushOrphanProcessJournal();

			expect(existsSync(path)).toBe(false);
		} finally {
			noCheapStartId.mockRestore();
		}
	});

	it("reaps only the given kernel's still-active bash children", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;

		// Stands in for a detached bash() child: own session so SIGKILL of the group is observable.
		const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
		child.unref();
		const childPid = child.pid;
		expect(childPid).toBeTypeOf("number");
		const kernelPid = 999_999;
		const appendRecord = (pid: number, recordKernelPid: number) => {
			appendFileSync(
				path,
				`${JSON.stringify({
					version: 1,
					pid,
					ownerPid: process.pid,
					kernelPid: recordKernelPid,
					processStartId: getProcessStartId(pid),
					active: true,
					recordedAt: new Date().toISOString(),
				})}\n`,
			);
		};
		appendRecord(childPid!, kernelPid);
		// A sibling kernel's record and the kernel's own pid record must be untouched.
		appendRecord(process.pid, kernelPid + 1);
		appendRecord(kernelPid, kernelPid);

		reapKernelOrphanProcesses(kernelPid);
		// Double reaping an already-dead pid must be a no-op.
		reapKernelOrphanProcesses(kernelPid);

		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		await exited;
		expect(child.signalCode).toBe("SIGKILL");
		const remaining = readActiveOrphanProcesses(path, process.pid).map((orphan) => orphan.pid);
		expect(remaining).not.toContain(childPid);
		expect(remaining).toContain(process.pid);
	});

	it("accepts pid-only active records and lets enriched records supersede them", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const appendRecord = (record: Record<string, unknown>) => {
			appendFileSync(path, `${JSON.stringify(record)}\n`);
		};
		const base = { version: 1, pid: process.pid, ownerPid: process.pid, recordedAt: new Date().toISOString() };

		// Pid-only pre-record (Windows pre-enrollment window): returned, never identity-current.
		appendRecord({ ...base, active: true });
		let active = readActiveOrphanProcesses(path, process.pid);
		expect(active).toHaveLength(1);
		expect(active[0]?.processStartId).toBeUndefined();
		expect(active[0] && isOrphanProcessIdentityCurrent(active[0])).toBe(false);

		// The enriched record supersedes the pid-only one (last record per pid wins).
		appendRecord({ ...base, active: true, processStartId: getProcessStartId(process.pid) });
		active = readActiveOrphanProcesses(path, process.pid);
		expect(active).toHaveLength(1);
		expect(active[0]?.processStartId).toBeTypeOf("string");
		expect(active[0] && isOrphanProcessIdentityCurrent(active[0])).toBe(true);

		// An inactive record supersedes both.
		appendRecord({ ...base, active: false });
		expect(readActiveOrphanProcesses(path, process.pid)).toEqual([]);
	});

	// POSIX behavior: CI runs Ubuntu, so this exercises the real kill path.
	it("best-effort kills pid-only records in the kernel crash-reap path", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;

		const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
		child.unref();
		const childPid = child.pid;
		expect(childPid).toBeTypeOf("number");
		const kernelPid = 999_999;
		// Pid-only record: the kernel crashed before the start-id query landed.
		appendFileSync(
			path,
			`${JSON.stringify({
				version: 1,
				pid: childPid,
				ownerPid: process.pid,
				kernelPid,
				active: true,
				recordedAt: new Date().toISOString(),
			})}\n`,
		);

		reapKernelOrphanProcesses(kernelPid);

		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		await exited;
		expect(child.signalCode).toBe("SIGKILL");
	});

	it("win32 reapers ignore identity-free records", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;

		const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
		child.unref();
		const childPid = child.pid;
		expect(childPid).toBeTypeOf("number");
		const kernelPid = 999_999;
		appendFileSync(
			path,
			`${JSON.stringify({
				version: 1,
				pid: childPid,
				ownerPid: process.pid,
				kernelPid,
				active: true,
				recordedAt: new Date().toISOString(),
			})}\n`,
		);

		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		try {
			Object.defineProperty(process, "platform", { value: "win32" });
			expect(shouldReapOrphanProcess({ pid: childPid!, kernelPid })).toBe(false);
			// The kernel's kill-on-close job already reaped the tree; a bare-pid
			// taskkill could only hit a reused pid, so the reaper must skip it.
			reapKernelOrphanProcesses(kernelPid);
		} finally {
			if (originalPlatform) {
				Object.defineProperty(process, "platform", originalPlatform);
			}
		}

		expect(child.exitCode).toBeNull();
		expect(child.signalCode).toBeNull();
		process.kill(childPid!, "SIGKILL");
	});
});

describe("orphan journal concurrency and pid reuse", () => {
	it("still journals records through the append lock", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-lock-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;

		recordOrphanProcessState(process.pid, true);
		recordOrphanProcessState(process.pid, false);

		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	it("refuses a symlinked journal path without touching its target", async () => {
		if (process.platform === "win32") {
			return;
		}
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-symlink-"));
		tempDirs.push(directory);
		const target = join(directory, "target.jsonl");
		writeFileSync(target, "sentinel\n");
		const alias = join(directory, "orphans.jsonl");
		symlinkSync(target, alias);
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = alias;
		const noCheapStartId = vi.spyOn(sessionLease, "getProcProcessStartId").mockReturnValue(undefined);

		try {
			recordOrphanProcessState(process.pid, true);
			// The deferred start-id capture takes the same O_NOFOLLOW path as the record.
			await flushOrphanProcessJournal();
			expect(readFileSync(target, "utf8")).toBe("sentinel\n");
		} finally {
			noCheapStartId.mockRestore();
		}
	});

	it("treats a pid younger than the record as reused", () => {
		const orphan: ActiveOrphanProcess = { pid: 4242, recordedAt: "2026-01-01T00:00:00.000Z" };
		const psQuery = (start: string) => () => `ps:${start}`;

		// Started a day after the record: a reused pid, never reap it.
		expect(isOrphanPidReused(orphan, psQuery("Fri Jan  2 00:00:00 2026"))).toBe(true);
		expect(shouldReapOrphanProcess(orphan, psQuery("Fri Jan  2 00:00:00 2026"))).toBe(false);

		// Started before the record: plausibly the journaled process.
		expect(isOrphanPidReused(orphan, psQuery("Wed Dec 31 23:59:00 2025"))).toBe(false);
		if (process.platform !== "win32") {
			expect(shouldReapOrphanProcess(orphan, psQuery("Wed Dec 31 23:59:00 2025"))).toBe(true);
		}

		// Unparseable or missing data keeps the historical best-effort behavior.
		expect(isOrphanPidReused(orphan, () => "proc:12345")).toBe(false);
		expect(isOrphanPidReused({ pid: 4242 }, psQuery("Fri Jan  2 00:00:00 2026"))).toBe(false);
	});
});
