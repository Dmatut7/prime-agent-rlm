/**
 * Subprocess entry for the daemon (session-host) crash-handler tests: wires the
 * production handler pair the way AgentDaemon does - a real recovery journal on
 * disk, a context snapshot, the crash-time journal flush - then triggers the
 * failure mode named on the command line, so the assertion is on a real
 * process's exit code, its stderr, and the journal bytes the crash left behind.
 */
import { flushWorkerRecoveryJournalFile, installDaemonCrashHandlers } from "../../src/modes/daemon/daemon-mode.js";
import { WorkerRecoveryJournal } from "../../src/modes/daemon/worker-recovery-journal.js";

const mode = process.argv[2] ?? "rejection";
const journalPath = process.argv[3];
if (!journalPath) {
	throw new Error("fixture needs a journal path as argv[3]");
}

const journal = new WorkerRecoveryJournal(journalPath);
journal.record({
	activeSessionId: "active-fixture",
	sessionId: "session-fixture",
	sessionFile: "/tmp/fixture-session.jsonl",
	busy: true,
	operation: "tool_execution_start",
});

installDaemonCrashHandlers({
	log: (message) => console.error(message),
	captureContext: () => "1 session(s) in flight: active-fixture (session session-fixture, busy)",
	flushRecoveryState: () => flushWorkerRecoveryJournalFile(journalPath),
});

if (mode === "uncaught") {
	setTimeout(() => {
		throw new Error("fixture uncaught exception");
	}, 20);
} else {
	Promise.reject(new Error("fixture unhandled rejection"));
}
