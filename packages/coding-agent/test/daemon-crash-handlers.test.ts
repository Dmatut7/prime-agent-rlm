import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import {
	AgentDaemon,
	flushWorkerRecoveryJournalFile,
	installDaemonCrashHandlers,
} from "../src/modes/daemon/daemon-mode.js";
import { DAEMON_WORKER_RECOVERY_JOURNAL_ENV } from "../src/modes/daemon/daemon-worker-protocol.js";
import { WorkerRecoveryJournal } from "../src/modes/daemon/worker-recovery-journal.js";

/**
 * W4-D: the session-hosting daemon's crash contract. The policy is fail-fast -
 * one uncaught exception or unhandled rejection exits the process, because its
 * per-session state may already be corrupt and the supervisor owns the recovery
 * (the dead worker's recovery journal drives the interruption markers and the
 * automatic resume). Before the exit, the handler must leave a diagnosable
 * crash log (error, stack, in-flight session inventory) and flush the recovery
 * journal, so both the crash site and the recovery inputs survive the process.
 *
 * The supervisor half of the policy (log-and-isolate for rejections) lives in
 * daemon-supervisor-crash-handlers.test.ts; the real-process half of this one
 * (exit codes, journal bytes on disk) lives in daemon-crash-handlers-process.test.ts.
 */

const uninstalls: Array<() => void> = [];
const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of [DAEMON_WORKER_RECOVERY_JOURNAL_ENV, ENV_AGENT_DIR]) {
		savedEnv[key] = process.env[key];
	}
});

afterEach(() => {
	while (uninstalls.length > 0) {
		uninstalls.pop()?.();
	}
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-daemon-crash-"));
	roots.push(root);
	return root;
}

function emitRejection(reason: unknown): void {
	process.emit("unhandledRejection", reason, Promise.resolve());
}

function emitUncaught(error: Error): void {
	process.emit("uncaughtException", error);
}

describe("installDaemonCrashHandlers policy", () => {
	it("exits(1) on an unhandled rejection after logging the stack, the context, and flushing the journal", () => {
		const logged: string[] = [];
		const flushed: string[] = [];
		const exit = vi.fn();
		uninstalls.push(
			installDaemonCrashHandlers({
				log: (message) => logged.push(message),
				captureContext: () => "1 session(s) in flight: active-1 (busy)",
				flushRecoveryState: () => flushed.push("flush"),
				exit,
			}),
		);

		emitRejection(new Error("leaked session promise"));

		expect(exit).toHaveBeenCalledWith(1);
		expect(flushed).toEqual(["flush"]);
		expect(logged[0]).toContain("unhandled rejection");
		expect(logged[0]).toContain("leaked session promise");
		// The inventory lands between the error line and the exit.
		expect(logged[1]).toBe("crash context: 1 session(s) in flight: active-1 (busy)");
	});

	it("exits(1) on an uncaught exception", () => {
		const logged: string[] = [];
		const exit = vi.fn();
		uninstalls.push(installDaemonCrashHandlers({ log: (message) => logged.push(message), exit }));

		emitUncaught(new Error("fatal session-host bug"));

		expect(exit).toHaveBeenCalledWith(1);
		expect(logged.join("\n")).toContain("uncaught exception");
		expect(logged.join("\n")).toContain("fatal session-host bug");
	});

	it("stringifies a non-Error rejection reason", () => {
		const logged: string[] = [];
		const exit = vi.fn();
		uninstalls.push(installDaemonCrashHandlers({ log: (message) => logged.push(message), exit }));

		emitRejection("plain string rejection");

		expect(exit).toHaveBeenCalledWith(1);
		expect(logged[0]).toContain("plain string rejection");
	});

	it("still exits when the log sink is the thing that failed", () => {
		const flushed: string[] = [];
		const exit = vi.fn();
		uninstalls.push(
			installDaemonCrashHandlers({
				log: () => {
					throw new Error("disk full");
				},
				flushRecoveryState: () => flushed.push("flush"),
				exit,
			}),
		);

		emitRejection(new Error("boom"));

		expect(flushed).toEqual(["flush"]);
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("still exits when the context snapshot throws", () => {
		const logged: string[] = [];
		const exit = vi.fn();
		uninstalls.push(
			installDaemonCrashHandlers({
				log: (message) => logged.push(message),
				captureContext: () => {
					throw new Error("sessions map half-mutated");
				},
				exit,
			}),
		);

		emitRejection(new Error("boom"));

		expect(exit).toHaveBeenCalledWith(1);
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain("unhandled rejection");
	});

	it("still exits when the recovery flush throws", () => {
		const logged: string[] = [];
		const exit = vi.fn();
		uninstalls.push(
			installDaemonCrashHandlers({
				log: (message) => logged.push(message),
				flushRecoveryState: () => {
					throw new Error("journal fsync failed");
				},
				exit,
			}),
		);

		emitRejection(new Error("boom"));

		expect(exit).toHaveBeenCalledWith(1);
		expect(logged[0]).toContain("unhandled rejection");
	});

	it("stops handling once uninstalled", () => {
		const logged: string[] = [];
		const exit = vi.fn();
		const uninstall = installDaemonCrashHandlers({ log: (message) => logged.push(message), exit });
		uninstall();
		// Something has to consume the event, or Node treats it as a real crash; the
		// consumer also proves the event was delivered and simply not to our handler.
		const consumed: unknown[] = [];
		const consumer = (reason: unknown): void => {
			consumed.push(reason);
		};
		process.on("unhandledRejection", consumer);
		try {
			emitRejection(new Error("after uninstall"));
		} finally {
			process.off("unhandledRejection", consumer);
		}
		expect(consumed).toHaveLength(1);
		expect(logged).toHaveLength(0);
		expect(exit).not.toHaveBeenCalled();
	});
});

describe("flushWorkerRecoveryJournalFile", () => {
	it("fsyncs an existing journal without changing its records", () => {
		const path = join(tempRoot(), "worker.recovery.jsonl");
		const journal = new WorkerRecoveryJournal(path);
		journal.record({ activeSessionId: "active-1", sessionId: "session-1", busy: true, operation: "turn_start" });

		expect(() => flushWorkerRecoveryJournalFile(path)).not.toThrow();
		expect(WorkerRecoveryJournal.readLatest(path)).toEqual([
			expect.objectContaining({ activeSessionId: "active-1", busy: true, operation: "turn_start" }),
		]);
	});

	it("treats a missing file as 'no record was ever written'", () => {
		expect(() => flushWorkerRecoveryJournalFile(join(tempRoot(), "never-written.jsonl"))).not.toThrow();
	});

	it("no-ops without a path", () => {
		expect(() => flushWorkerRecoveryJournalFile(undefined)).not.toThrow();
	});

	it("propagates a non-ENOENT failure so the crash handler can isolate it", () => {
		// A directory cannot be opened "r+": EISDIR on POSIX, EACCES/ENOENT-adjacent
		// errors on other platforms - anything but a silent pass proves propagation.
		expect(() => flushWorkerRecoveryJournalFile(tempRoot())).toThrow();
	});
});

interface FakeSessionOptions {
	sessionId?: string;
	sessionFile?: string;
	busy?: boolean;
	retrying?: boolean;
	acceptedPrompt?: boolean;
}

function fakeSession(options: FakeSessionOptions = {}): AgentSession {
	return {
		sessionId: options.sessionId ?? "session-1",
		sessionFile: options.sessionFile,
		isRetrying: options.retrying ?? false,
		hasAcceptedPromptInFlight: options.acceptedPrompt ?? false,
		isSessionActive: options.busy ?? false,
		hasRunningRlmChildren: () => false,
	} as unknown as AgentSession;
}

function makeState(activeSessionId: string, session: AgentSession): ActiveSessionState {
	return {
		activeSessionId,
		clients: new Set(),
		pendingAttaches: 0,
		extensionUiRequests: new Map(),
		eventGeneration: "gen-1",
		lastEventSequence: 0,
		runtime: {
			metadata: { kind: "top-level", createdAt: 1 },
			session,
		},
	} as unknown as ActiveSessionState;
}

/** The glue between AgentDaemon and installDaemonCrashHandlers is private but not `_`-prefixed. */
interface DaemonCrashInternals {
	installCrashHandlers(): void;
	uninstallCrashHandlers?: () => void;
	crashContextSnapshot(): string;
	flushRecoveryStateForCrash(): void;
	sessions: Map<string, ActiveSessionState>;
	bindingSessions: Set<string>;
}

function makeWorkerDaemon(root: string, journalPath?: string): DaemonCrashInternals {
	if (journalPath !== undefined) {
		process.env[DAEMON_WORKER_RECOVERY_JOURNAL_ENV] = journalPath;
	}
	// The crash-path log writes through getDaemonLogPath; pin it into the sandbox.
	process.env[ENV_AGENT_DIR] = join(root, "agent");
	const daemon = new AgentDaemon(join(root, "worker.sock"), {
		defaultSessionConfig: { agentDir: join(root, "agent"), cwd: root },
		createRuntime: async () => {
			throw new Error("unexpected runtime creation");
		},
		worker: { authenticationToken: "test-token" },
	});
	const internals = daemon as unknown as DaemonCrashInternals;
	uninstalls.push(() => internals.uninstallCrashHandlers?.());
	return internals;
}

describe("AgentDaemon crash glue", () => {
	it("snapshots the in-flight session inventory with busy flags", () => {
		const root = tempRoot();
		const internals = makeWorkerDaemon(root);
		internals.sessions.set(
			"active-1",
			makeState("active-1", fakeSession({ sessionId: "s-1", sessionFile: "/tmp/s-1.jsonl", busy: true })),
		);
		internals.sessions.set(
			"active-2",
			makeState("active-2", fakeSession({ sessionId: "s-2", acceptedPrompt: true })),
		);
		internals.sessions.set("active-3", makeState("active-3", fakeSession({ sessionId: "s-3" })));
		internals.bindingSessions.add("active-2");

		const snapshot = internals.crashContextSnapshot();

		expect(snapshot).toContain("3 session(s) in flight");
		expect(snapshot).toContain("active-1 (session s-1, /tmp/s-1.jsonl, busy)");
		expect(snapshot).toContain("active-2 (session s-2, busy, binding)");
		expect(snapshot).toContain("active-3 (session s-3, idle)");
	});

	it("reports an empty inventory plainly", () => {
		const internals = makeWorkerDaemon(tempRoot());
		expect(internals.crashContextSnapshot()).toBe("no sessions in flight");
	});

	it("keeps a corrupt session from losing the rest of the inventory", () => {
		const root = tempRoot();
		const internals = makeWorkerDaemon(root);
		const corrupt = Object.defineProperty({}, "isSessionActive", {
			get() {
				throw new Error("half-mutated");
			},
		}) as AgentSession;
		internals.sessions.set("active-corrupt", makeState("active-corrupt", corrupt));
		internals.sessions.set("active-ok", makeState("active-ok", fakeSession({ sessionId: "s-ok" })));

		const snapshot = internals.crashContextSnapshot();

		expect(snapshot).toContain("active-corrupt (unreadable: Error: half-mutated)");
		expect(snapshot).toContain("active-ok (session s-ok, idle)");
	});

	it("caps the inventory so a crash line stays one line", () => {
		const root = tempRoot();
		const internals = makeWorkerDaemon(root);
		for (let index = 0; index < 40; index++) {
			internals.sessions.set(
				`active-${index}`,
				makeState(`active-${index}`, fakeSession({ sessionId: `s-${index}` })),
			);
		}

		const snapshot = internals.crashContextSnapshot();

		expect(snapshot).toContain("40 session(s) in flight");
		expect(snapshot).toContain("+8 more");
		expect(snapshot).not.toContain("active-39 (");
	});

	it("repairs journal drift at crash time: a busy session whose last checkpoint said idle", () => {
		const root = tempRoot();
		const journalPath = join(root, "worker.recovery.jsonl");
		// The turn_end checkpoint landed; the session went busy again and the next
		// checkpoint was lost (the journal's own writes are isolated and logged by
		// recordWorkerRecoveryState, so a transient failure never propagates).
		const journal = new WorkerRecoveryJournal(journalPath);
		journal.record({ activeSessionId: "active-1", sessionId: "s-1", busy: false, operation: "turn_end" });
		// The daemon's journal instance is built after the records exist, so its
		// in-memory latest set sees them.
		const internals = makeWorkerDaemon(root, journalPath);
		internals.sessions.set("active-1", makeState("active-1", fakeSession({ sessionId: "s-1", busy: true })));

		internals.flushRecoveryStateForCrash();

		expect(WorkerRecoveryJournal.readLatest(journalPath)).toEqual([
			expect.objectContaining({ activeSessionId: "active-1", busy: true, operation: "crash" }),
		]);
	});

	it("repairs journal drift in the other direction: a stale busy record for a now-idle session", () => {
		const root = tempRoot();
		const journalPath = join(root, "worker.recovery.jsonl");
		const journal = new WorkerRecoveryJournal(journalPath);
		journal.record({ activeSessionId: "active-1", sessionId: "s-1", busy: true, operation: "turn_start" });
		const internals = makeWorkerDaemon(root, journalPath);
		internals.sessions.set("active-1", makeState("active-1", fakeSession({ sessionId: "s-1" })));

		internals.flushRecoveryStateForCrash();

		expect(WorkerRecoveryJournal.readLatest(journalPath)).toEqual([
			expect.objectContaining({ activeSessionId: "active-1", busy: false, operation: "crash" }),
		]);
	});

	it("leaves a current record alone, preserving the in-flight operation name", () => {
		const root = tempRoot();
		const journalPath = join(root, "worker.recovery.jsonl");
		const journal = new WorkerRecoveryJournal(journalPath);
		journal.record({ activeSessionId: "active-1", sessionId: "s-1", busy: true, operation: "tool_execution_start" });
		const internals = makeWorkerDaemon(root, journalPath);
		internals.sessions.set("active-1", makeState("active-1", fakeSession({ sessionId: "s-1", busy: true })));

		internals.flushRecoveryStateForCrash();

		// No rewrite: the supervisor's interruption marker keeps "tool_execution_start".
		expect(WorkerRecoveryJournal.readLatest(journalPath)).toEqual([
			expect.objectContaining({ activeSessionId: "active-1", busy: true, operation: "tool_execution_start" }),
		]);
	});

	it("records a busy session that has no journal record yet, and skips an idle one", () => {
		const root = tempRoot();
		const journalPath = join(root, "worker.recovery.jsonl");
		const internals = makeWorkerDaemon(root, journalPath);
		// Both sessions bound after the daemon's journal loaded: neither has a record.
		internals.sessions.set("active-busy", makeState("active-busy", fakeSession({ sessionId: "s-1", busy: true })));
		internals.sessions.set("active-idle", makeState("active-idle", fakeSession({ sessionId: "s-2" })));

		internals.flushRecoveryStateForCrash();

		// Only the busy one lands: the supervisor acts on busy records, and an idle
		// noise record would just be one more line to compact.
		expect(WorkerRecoveryJournal.readLatest(journalPath)).toEqual([
			expect.objectContaining({ activeSessionId: "active-busy", busy: true, operation: "crash" }),
		]);
	});

	it("keeps a corrupt session's last journaled record instead of dropping the flush", () => {
		const root = tempRoot();
		const journalPath = join(root, "worker.recovery.jsonl");
		const journal = new WorkerRecoveryJournal(journalPath);
		journal.record({ activeSessionId: "active-corrupt", sessionId: "s-1", busy: true, operation: "turn_start" });
		journal.record({ activeSessionId: "active-idle", sessionId: "s-2", busy: true, operation: "turn_start" });
		const internals = makeWorkerDaemon(root, journalPath);
		const corrupt = Object.defineProperty({}, "isSessionActive", {
			get() {
				throw new Error("half-mutated");
			},
		}) as AgentSession;
		internals.sessions.set("active-corrupt", makeState("active-corrupt", corrupt));
		internals.sessions.set("active-idle", makeState("active-idle", fakeSession({ sessionId: "s-2" })));

		internals.flushRecoveryStateForCrash();

		const latest = WorkerRecoveryJournal.readLatest(journalPath);
		// The corrupt session keeps its honest busy record; the readable idle one is repaired.
		expect(latest).toContainEqual(
			expect.objectContaining({ activeSessionId: "active-corrupt", busy: true, operation: "turn_start" }),
		);
		expect(latest).toContainEqual(
			expect.objectContaining({ activeSessionId: "active-idle", busy: false, operation: "crash" }),
		);
	});

	it("no-ops the flush for a daemon without a recovery journal", () => {
		const root = tempRoot();
		// No journal env: a standalone daemon has no supervisor-side recovery contract.
		delete process.env[DAEMON_WORKER_RECOVERY_JOURNAL_ENV];
		const internals = makeWorkerDaemon(root);
		internals.sessions.set("active-1", makeState("active-1", fakeSession({ busy: true })));

		expect(() => internals.flushRecoveryStateForCrash()).not.toThrow();
	});

	it("drives the real wiring: rejection exits(1), logs the inventory, and leaves the journal intact", () => {
		const root = tempRoot();
		const journalPath = join(root, "worker.recovery.jsonl");
		const journal = new WorkerRecoveryJournal(journalPath);
		journal.record({ activeSessionId: "active-1", sessionId: "s-1", busy: true, operation: "tool_execution_start" });
		const internals = makeWorkerDaemon(root, journalPath);
		internals.sessions.set("active-1", makeState("active-1", fakeSession({ sessionId: "s-1", busy: true })));
		const exitCodes: number[] = [];
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
		}) as never);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

		internals.installCrashHandlers();
		emitRejection(new Error("simulated worker crash"));

		expect(exitCodes).toEqual([1]);
		const output = consoleError.mock.calls.map((call) => String(call[0])).join("\n");
		expect(output).toContain("unhandled rejection");
		expect(output).toContain("simulated worker crash");
		expect(output).toContain("crash context: 1 session(s) in flight");
		expect(output).toContain("active-1 (session s-1, busy)");
		// The recovery input survived: the supervisor's reader sees the busy record.
		expect(WorkerRecoveryJournal.readLatest(journalPath)).toEqual([
			expect.objectContaining({ activeSessionId: "active-1", busy: true, operation: "tool_execution_start" }),
		]);
	});
});
