import { type ChildProcess, spawn } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMPACT_AFTER_BYTES,
	COMPACT_AFTER_RECORDS,
	WorkerRecoveryJournal,
	type WorkerRecoveryRecord,
} from "../src/modes/daemon/worker-recovery-journal.js";

const crashWriterPath = resolve(__dirname, "fixtures/worker-recovery-journal-writer.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const children = new Set<ChildProcess>();
const writerPids = new Set<number>();

describe("WorkerRecoveryJournal", () => {
	const roots: string[] = [];

	it("drops a torn trailing line so the next append does not glue onto it", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			busy: true,
			operation: "prompt_accepted",
		});
		// Simulate a crash mid-append of the next record.
		appendFileSync(path, '{"version":1,"activeSessionId":"active-2","torn');

		const reopened = new WorkerRecoveryJournal(path);
		reopened.record({
			activeSessionId: "active-2",
			sessionId: "session-2",
			busy: false,
			operation: "prompt_complete",
		});

		const lines = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		expect(lines.some((line) => line.includes("active-2"))).toBe(true);
		expect(
			reopened
				.getLatest()
				.map((record) => record.activeSessionId)
				.sort(),
		).toEqual(["active-1", "active-2"]);
	});

	it("cleans stale compaction temp files left by a crash", () => {
		const path = createPath();
		writeFileSync(`${path}.4242.tmp`, "stale");
		new WorkerRecoveryJournal(path);
		expect(existsSync(`${path}.4242.tmp`)).toBe(false);
	});

	afterEach(() => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
			}
		}
		children.clear();
		for (const pid of writerPids) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		writerPids.clear();
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createPath(): string {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-worker-recovery-"));
		roots.push(root);
		return join(root, "worker.recovery.jsonl");
	}

	it("restores the latest operation state per session", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.jsonl",
			busy: true,
			operation: "prompt_accepted",
		});
		journal.record({
			activeSessionId: "active-2",
			sessionId: "session-2",
			busy: false,
			operation: "ready",
		});

		expect(WorkerRecoveryJournal.readLatest(path)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ activeSessionId: "active-1", busy: true, operation: "prompt_accepted" }),
				expect.objectContaining({ activeSessionId: "active-2", busy: false, operation: "ready" }),
			]),
		);
	});

	it("compacts stable checkpoints and ignores a truncated final record", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			busy: true,
			operation: "bash_start",
		});
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			busy: false,
			operation: "bash_end",
		});
		appendFileSync(path, "{truncated");

		expect(WorkerRecoveryJournal.readLatest(path)).toEqual([
			expect.objectContaining({ activeSessionId: "active-1", busy: false, operation: "bash_end" }),
		]);
	});
	it("compacts a busy journal once it passes the record bound", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		const sessions = ["active-1", "active-2", "active-3"];
		const lastOperation = new Map<string, string>();
		let previousBytes = 0;
		let compactions = 0;
		let maxBytes = 0;
		const total = COMPACT_AFTER_RECORDS * 2;
		for (let index = 0; index < total; index++) {
			const activeSessionId = sessions[index % sessions.length] as string;
			const operation = `op-${index}`;
			journal.record({
				activeSessionId,
				sessionId: activeSessionId.replace("active-", "session-"),
				sessionFile: `/tmp/${activeSessionId}.jsonl`,
				// Never all idle at once: this is the workload whose journal the
				// idle-only gate let grow without bound.
				busy: true,
				operation,
			});
			lastOperation.set(activeSessionId, operation);
			const bytes = statSync(path).size;
			if (bytes < previousBytes) {
				compactions++;
			}
			previousBytes = bytes;
			maxBytes = Math.max(maxBytes, bytes);
		}
		expect(compactions).toBeGreaterThan(0);
		expect(maxBytes).toBeLessThan(COMPACT_AFTER_BYTES);
		expect(readLines(path).length).toBeLessThanOrEqual(COMPACT_AFTER_RECORDS + sessions.length);
		expect(journal.getLatest()).toHaveLength(sessions.length);
		// Compaction drops superseded records, never a session's latest state.
		expect(WorkerRecoveryJournal.readLatest(path).map((record) => record.operation)).toEqual(
			sessions.map((activeSessionId) => lastOperation.get(activeSessionId)),
		);
	});

	it("compacts when long records push the journal past the byte bound", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		const sessions = ["active-1", "active-2", "active-3"];
		const longSessionFile = `/tmp/${"s".repeat(64 * 1024)}.jsonl`;
		const needed = Math.ceil(COMPACT_AFTER_BYTES / (64 * 1024)) + sessions.length;
		let previousBytes = 0;
		let compactions = 0;
		let appendedBytes = 0;
		for (let index = 0; index < needed; index++) {
			const activeSessionId = sessions[index % sessions.length] as string;
			journal.record({
				activeSessionId,
				sessionId: activeSessionId.replace("active-", "session-"),
				sessionFile: longSessionFile,
				busy: true,
				operation: `op-${index}`,
			});
			appendedBytes += longSessionFile.length;
			const bytes = statSync(path).size;
			if (bytes < previousBytes) {
				compactions++;
			}
			previousBytes = bytes;
		}
		expect(compactions).toBeGreaterThan(0);
		expect(statSync(path).size).toBeLessThan(COMPACT_AFTER_BYTES);
		expect(statSync(path).size).toBeLessThan(appendedBytes / 2);
		expect(WorkerRecoveryJournal.readLatest(path)).toHaveLength(sessions.length);
	});

	it("compacts when the last busy session goes idle, and not before", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		for (const activeSessionId of ["active-1", "active-2", "active-3"]) {
			journal.record({
				activeSessionId,
				sessionId: activeSessionId.replace("active-", "session-"),
				busy: true,
				operation: "turn_start",
			});
		}
		let previousBytes = statSync(path).size;
		for (const activeSessionId of ["active-1", "active-2"]) {
			journal.record({
				activeSessionId,
				sessionId: activeSessionId.replace("active-", "session-"),
				busy: false,
				operation: "turn_end",
			});
			// One session is still busy, so the journal must keep appending.
			expect(statSync(path).size).toBeGreaterThan(previousBytes);
			previousBytes = statSync(path).size;
		}
		journal.record({ activeSessionId: "active-3", sessionId: "session-3", busy: false, operation: "turn_end" });
		expect(statSync(path).size).toBeLessThan(previousBytes);
		expect(readLines(path)).toHaveLength(3);
	});

	it("recounts busy sessions when it reloads an existing journal", () => {
		const path = createPath();
		const writer = new WorkerRecoveryJournal(path);
		for (const activeSessionId of ["active-1", "active-2"]) {
			writer.record({
				activeSessionId,
				sessionId: activeSessionId.replace("active-", "session-"),
				busy: true,
				operation: "turn_start",
			});
		}
		const reopened = new WorkerRecoveryJournal(path);
		reopened.record({ activeSessionId: "active-1", sessionId: "session-1", busy: false, operation: "turn_end" });
		const bytesBeforeLastIdle = statSync(path).size;
		expect(readLines(path)).toHaveLength(3);
		reopened.record({ activeSessionId: "active-2", sessionId: "session-2", busy: false, operation: "turn_end" });
		expect(statSync(path).size).toBeLessThan(bytesBeforeLastIdle);
		expect(readLines(path)).toHaveLength(2);
	});

	it("keeps compacting when a stale temp holds the name compaction used to reuse", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({ activeSessionId: "active-1", sessionId: "session-1", busy: true, operation: "turn_start" });
		// The one name every compaction used to reuse, left behind by an earlier
		// process whose cleanup also failed. A directory survives rmSync without
		// recursive, so neither the startup sweep nor the failure cleanup clears it.
		const stale = `${path}.${process.pid}.tmp`;
		mkdirSync(stale);
		writeFileSync(join(stale, "keep"), "x");
		expect(() =>
			journal.record({ activeSessionId: "active-1", sessionId: "session-1", busy: false, operation: "turn_end" }),
		).not.toThrow();
		expect(readLines(path)).toHaveLength(1);
		expect(existsSync(stale)).toBe(true);
		journal.record({ activeSessionId: "active-1", sessionId: "session-1", busy: true, operation: "turn_start#2" });
		expect(() =>
			journal.record({
				activeSessionId: "active-1",
				sessionId: "session-1",
				busy: false,
				operation: "turn_end#2",
			}),
		).not.toThrow();
		expect(readLines(path)).toHaveLength(1);
	});

	it("retries a compaction whose temp name a stale leftover already occupies", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({ activeSessionId: "active-1", sessionId: "session-1", busy: true, operation: "turn_start" });
		// Occupy, unremovably, both the name compaction used to reuse and the first
		// name this process generates, so the retry has to move to a fresh one.
		const staleNames = [`${path}.${process.pid}.tmp`, `${path}.${process.pid}.0.tmp`];
		for (const stale of staleNames) {
			mkdirSync(stale);
			writeFileSync(join(stale, "keep"), "x");
		}
		expect(() =>
			journal.record({ activeSessionId: "active-1", sessionId: "session-1", busy: false, operation: "turn_end" }),
		).not.toThrow();
		expect(readLines(path)).toHaveLength(1);
		expect(WorkerRecoveryJournal.readLatest(path)).toEqual([
			expect.objectContaining({ activeSessionId: "active-1", busy: false, operation: "turn_end" }),
		]);
		// Only the unremovable leftovers are still there; the retry cleaned up after
		// itself through the rename.
		expect(
			readdirSync(dirname(path))
				.filter((name) => name.endsWith(".tmp"))
				.sort(),
		).toEqual(staleNames.map((stale) => stale.split("/").pop()).sort());
	});

	it("tightens a loose pre-existing journal file at construction", () => {
		const path = createPath();
		writeFileSync(
			path,
			`${JSON.stringify({
				version: 1,
				activeSessionId: "active-old",
				sessionId: "session-old",
				busy: false,
				operation: "ready",
				recordedAt: "2026-01-01T00:00:00.000Z",
			})}\n`,
		);
		chmodSync(path, 0o644);
		expect(fileMode(path)).toBe("644");
		const journal = new WorkerRecoveryJournal(path);
		// openSync(path, "a", 0o600) only applies the mode when it creates the file,
		// so construction is the one place an existing journal gets tightened.
		expect(fileMode(path)).toBe("600");
		for (let index = 0; index < 3; index++) {
			journal.record({
				activeSessionId: "active-1",
				sessionId: "session-1",
				busy: true,
				operation: `op-${index}`,
			});
		}
		expect(fileMode(path)).toBe("600");
	});

	it("creates a journal file with owner-only permissions and keeps them", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		expect(existsSync(path)).toBe(false);
		journal.record({ activeSessionId: "active-1", sessionId: "session-1", busy: true, operation: "turn_start" });
		expect(fileMode(path)).toBe("600");
		journal.record({ activeSessionId: "active-1", sessionId: "session-1", busy: false, operation: "turn_end" });
		expect(fileMode(path)).toBe("600");
	});

	it("loads a journal whose unflushed tail a power loss dropped mid-line", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.jsonl",
			busy: true,
			operation: "turn_start",
		});
		// Up to here the record is on disk; everything below is still in the page
		// cache, which a machine-wide power loss drops.
		const durableBytes = statSync(path).size;
		for (let index = 0; index < 20; index++) {
			journal.record({
				activeSessionId: `active-tail-${index}`,
				sessionId: `session-tail-${index}`,
				busy: true,
				operation: `op-${index}`,
			});
		}
		expect(statSync(path).size).toBeGreaterThan(durableBytes);
		writeFileSync(path, readFileSync(path).subarray(0, durableBytes + 7));

		const reopened = new WorkerRecoveryJournal(path);
		expect(reopened.getLatest()).toEqual([
			expect.objectContaining({
				activeSessionId: "active-1",
				sessionId: "session-1",
				busy: true,
				operation: "turn_start",
			}),
		]);
		// Only the unflushed tail is gone, and the torn line was repaired away so
		// the next append cannot glue onto it.
		expect(statSync(path).size).toBe(durableBytes);
		for (const line of readLines(path)) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		reopened.record({ activeSessionId: "active-2", sessionId: "session-2", busy: false, operation: "ready" });
		expect(readLines(path)).toHaveLength(2);
	});

	it("recovers every appended record after the writer process is SIGKILLed", async () => {
		const path = createPath();
		const readyPath = `${path}.ready`;
		const sessions = 5;
		const perSession = 40;
		const diagnostics = { stderr: "" };
		const child = spawn(
			process.execPath,
			[tsxPath, crashWriterPath, path, readyPath, String(sessions), String(perSession)],
			{
				env: { ...process.env, TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json") },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		children.add(child);
		child.stderr?.on("data", (chunk: Buffer) => {
			diagnostics.stderr += chunk.toString("utf8");
		});
		// tsx runs the fixture in a child of its own, so the pid that published the
		// ready marker is the process that wrote the journal: kill that one.
		const pid = await waitForWriterPid(readyPath, diagnostics);
		writerPids.add(pid);
		process.kill(pid, "SIGKILL");
		await waitForProcessGone(pid);
		child.kill("SIGKILL");
		await waitForChildExit(child);

		const expected = expectedRecords(sessions, perSession);
		const expectedLatest: typeof expected = [];
		for (let session = 0; session < sessions; session++) {
			expectedLatest.push(expected[(session + 1) * perSession - 1] as (typeof expected)[number]);
		}
		// The killed writer never fsync-ed these records, but they are in the page
		// cache, so another process still reads every one of them. This is what
		// recoverUncertainWorkerOperations relies on when it SIGKILLs a worker.
		expect(WorkerRecoveryJournal.readLatest(path).map(maskRecordedAt)).toEqual(expectedLatest);

		const rawLines = readLines(path);
		expect(rawLines).toHaveLength(sessions * perSession + 1);
		expect(() => JSON.parse(rawLines[rawLines.length - 1] as string)).toThrow();

		const reopened = new WorkerRecoveryJournal(path);
		expect(reopened.getLatest().map(maskRecordedAt)).toEqual(expectedLatest);
		// One JSON line per record, in order, byte for byte (wall clock masked).
		expect(maskLines(readLines(path))).toEqual(expected.map((record) => JSON.stringify(record)));
	}, 60_000);

	function readLines(path: string): string[] {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
	}

	function fileMode(path: string): string {
		return (statSync(path).mode & 0o777).toString(8);
	}

	function maskRecordedAt(record: WorkerRecoveryRecord): WorkerRecoveryRecord {
		return { ...record, recordedAt: "<masked>" };
	}

	function maskLines(lines: string[]): string[] {
		return lines.map((line) => line.replace(/"recordedAt":"[^"]*"/, '"recordedAt":"<masked>"'));
	}

	function expectedRecords(sessions: number, perSession: number): WorkerRecoveryRecord[] {
		const records: WorkerRecoveryRecord[] = [];
		for (let session = 0; session < sessions; session++) {
			for (let index = 0; index < perSession; index++) {
				records.push({
					version: 1,
					activeSessionId: `active-${session}`,
					sessionId: `session-${session}`,
					sessionFile: `/tmp/sessions/session-${session}.jsonl`,
					busy: true,
					operation: `op-${session}-${index}`,
					recordedAt: "<masked>",
				});
			}
		}
		return records;
	}

	async function waitForWriterPid(path: string, diagnostics: { stderr: string }): Promise<number> {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (existsSync(path)) {
				const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
				if (Number.isInteger(pid) && pid > 0) {
					return pid;
				}
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		throw new Error(`journal writer fixture did not publish its pid: ${diagnostics.stderr.slice(0, 2000)}`);
	}

	async function waitForProcessGone(pid: number): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			try {
				process.kill(pid, 0);
			} catch {
				return;
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
		}
		throw new Error(`journal writer process ${pid} survived SIGKILL`);
	}

	async function waitForChildExit(child: ChildProcess): Promise<void> {
		if (child.exitCode !== null || child.signalCode !== null) {
			return;
		}
		await new Promise<void>((resolveExit) => {
			child.once("exit", () => resolveExit());
		});
	}
});
