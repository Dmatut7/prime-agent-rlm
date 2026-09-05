import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerRecoveryJournal } from "../src/modes/daemon/worker-recovery-journal.js";

// The journal's durability policy is a syscall policy, so these tests observe the
// syscalls instead of inferring them from timing: appends must not fsync, and a
// compaction must fsync its temp before the rename exposes it.
const calls = vi.hoisted(() => ({
	order: [] as string[],
	fsyncTargets: [] as string[],
	renameTargets: [] as string[],
	failRenames: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const descriptorPaths = new Map<number, string>();
	const openSync = ((...args: unknown[]) => {
		const descriptor = (actual.openSync as unknown as (...openArgs: unknown[]) => number)(...args);
		descriptorPaths.set(descriptor, String(args[0]));
		return descriptor;
	}) as typeof actual.openSync;
	const closeSync = ((descriptor: number) => {
		descriptorPaths.delete(descriptor);
		return actual.closeSync(descriptor);
	}) as typeof actual.closeSync;
	const fsyncSync = ((descriptor: number) => {
		calls.order.push("fsync");
		calls.fsyncTargets.push(descriptorPaths.get(descriptor) ?? `fd:${descriptor}`);
		return actual.fsyncSync(descriptor);
	}) as typeof actual.fsyncSync;
	const renameSync = ((...args: unknown[]) => {
		calls.order.push("rename");
		calls.renameTargets.push(`${String(args[0])} -> ${String(args[1])}`);
		if (calls.failRenames > 0) {
			calls.failRenames--;
			const error = new Error("ENOSPC: no space left on device, rename") as NodeJS.ErrnoException;
			error.code = "ENOSPC";
			throw error;
		}
		return (actual.renameSync as unknown as (...renameArgs: unknown[]) => void)(...args);
	}) as typeof actual.renameSync;
	return { ...actual, openSync, closeSync, fsyncSync, renameSync };
});

describe("WorkerRecoveryJournal durability syscalls", () => {
	const roots: string[] = [];
	const logEntries: LogEntry[] = [];

	beforeEach(() => {
		calls.order = [];
		calls.fsyncTargets = [];
		calls.renameTargets = [];
		calls.failRenames = 0;
		logEntries.length = 0;
		setLogSink((entry) => {
			logEntries.push(entry);
		});
	});

	afterEach(() => {
		setLogSink(undefined);
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createPath(): string {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-worker-journal-fsync-"));
		roots.push(root);
		return join(root, "worker.recovery.jsonl");
	}

	function readLines(path: string): string[] {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
	}

	it("appends records without fsync-ing them", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		calls.order = [];
		calls.fsyncTargets = [];
		for (let index = 0; index < 50; index++) {
			journal.record({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile: "/tmp/session-1.jsonl",
				// Stays busy, so no compaction can account for an fsync either.
				busy: true,
				operation: `op-${index}`,
			});
		}
		expect(calls.order).toEqual([]);
		// Not fsync-ed, but written: another reader sees all 50 records already.
		expect(readLines(path)).toHaveLength(50);
		for (const line of readLines(path)) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		expect(WorkerRecoveryJournal.readLatest(path)).toEqual([
			expect.objectContaining({ activeSessionId: "active-1", busy: true, operation: "op-49" }),
		]);
	});

	it("fsyncs the compaction temp before renaming it onto the journal", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({ activeSessionId: "active-1", sessionId: "session-1", busy: true, operation: "turn_start" });
		journal.record({ activeSessionId: "active-2", sessionId: "session-2", busy: true, operation: "turn_start" });
		calls.order = [];
		calls.fsyncTargets = [];
		calls.renameTargets = [];
		journal.record({ activeSessionId: "active-1", sessionId: "session-1", busy: false, operation: "turn_end" });
		// One session is still busy: the append alone must not fsync.
		expect(calls.order).toEqual([]);
		journal.record({ activeSessionId: "active-2", sessionId: "session-2", busy: false, operation: "turn_end" });
		// Compaction is exactly fsync(temp) then rename: dropping that fsync would
		// let a crash expose a truncated file as the whole recovered state.
		expect(calls.order).toEqual(["fsync", "rename"]);
		expect(calls.fsyncTargets).toHaveLength(1);
		expect(calls.fsyncTargets[0]).toSatisfy((target: string) => target.endsWith(".tmp"));
		expect(calls.renameTargets).toEqual([`${calls.fsyncTargets[0]} -> ${path}`]);
		expect(readLines(path)).toHaveLength(2);
		expect(WorkerRecoveryJournal.readLatest(path).map((record) => record.activeSessionId)).toEqual([
			"active-1",
			"active-2",
		]);
		expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("reports a compaction failure it cannot retry instead of swallowing it", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({ activeSessionId: "active-1", sessionId: "session-1", busy: true, operation: "turn_start" });
		calls.order = [];
		calls.failRenames = 2;
		expect(() =>
			journal.record({ activeSessionId: "active-1", sessionId: "session-1", busy: false, operation: "turn_end" }),
		).toThrow(/ENOSPC/);
		// Callers are allowed to catch and continue, so the journal says so itself.
		const failure = logEntries.find((entry) => entry.msg === "could not compact the worker recovery journal");
		expect(failure).toBeDefined();
		expect(failure?.level).toBe("warn");
		expect(failure?.path).toBe(path);
		expect(String(failure?.error)).toContain("ENOSPC");
		expect(String(failure?.firstAttemptError)).toContain("ENOSPC");
		// The record itself is still on disk and in memory; only compaction failed.
		expect(readLines(path)).toHaveLength(2);
		expect(journal.getLatest()).toEqual([
			expect.objectContaining({ activeSessionId: "active-1", busy: false, operation: "turn_end" }),
		]);
		expect(statSync(path).size).toBeGreaterThan(0);
	});

	it("recovers from a compaction failure on the first temp name", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({ activeSessionId: "active-1", sessionId: "session-1", busy: true, operation: "turn_start" });
		calls.order = [];
		calls.failRenames = 1;
		expect(() =>
			journal.record({ activeSessionId: "active-1", sessionId: "session-1", busy: false, operation: "turn_end" }),
		).not.toThrow();
		// Attempt one fsyncs and then fails at the rename; attempt two repeats both
		// on a fresh temp name and succeeds.
		expect(calls.order).toEqual(["fsync", "rename", "fsync", "rename"]);
		expect(readLines(path)).toHaveLength(1);
		expect(logEntries.find((entry) => entry.msg === "could not compact the worker recovery journal")).toBeUndefined();
	});

	it("tightens permissions without touching the mode on every append", () => {
		const path = createPath();
		mkdirSync(dirname(path), { recursive: true });
		const journal = new WorkerRecoveryJournal(path);
		for (let index = 0; index < 10; index++) {
			journal.record({
				activeSessionId: "active-1",
				sessionId: "session-1",
				busy: true,
				operation: `op-${index}`,
			});
		}
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readLines(path)).toHaveLength(10);
	});
});
