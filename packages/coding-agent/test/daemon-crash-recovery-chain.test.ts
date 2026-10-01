import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import type { AgentSession } from "../src/core/agent-session.js";
import type { CustomMessageEntry, SessionMessageEntry } from "../src/core/session-manager.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon, flushWorkerRecoveryJournalFile } from "../src/modes/daemon/daemon-mode.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { WorkerRecoveryJournal } from "../src/modes/daemon/worker-recovery-journal.js";
import {
	findUnconsumedWorkerRecoveryMarker,
	WORKER_RECOVERY_MARKER_CUSTOM_TYPE,
	WORKER_RECOVERY_RESUME_PROMPT,
} from "../src/modes/daemon/worker-recovery-resume.js";

/**
 * W4-D chain test: the daemon-crash recovery loop end to end, at the seams where
 * the pieces hand off. A session-hosting daemon (worker) dies mid-turn after its
 * crash handler ran; what survives is the recovery journal on disk. The
 * supervisor (restarted or still running - both paths converge on
 * recoverUncertainWorkerOperations) turns busy journal records into one
 * interruption marker per transcript; the next worker to bind the session finds
 * the marker unconsumed and queues the automatic resume prompt.
 *
 * The pieces each have their own coverage (journal durability in
 * worker-recovery-journal*.test.ts, the catalog append in
 * r2-catalog-append-tail-repair.test.ts, the bind half in
 * daemon-worker-recovery-resume.test.ts); this file pins the joins between them.
 */

const roots: string[] = [];
const savedAgentDir: string | undefined = process.env[ENV_AGENT_DIR];

afterEach(() => {
	if (savedAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = savedAgentDir;
	}
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-crash-chain-"));
	roots.push(root);
	return root;
}

let entrySeq = 0;
function entryBase(): { id: string; parentId: string | null; timestamp: string } {
	entrySeq += 1;
	return {
		id: `e${entrySeq}`,
		parentId: entrySeq > 1 ? `e${entrySeq - 1}` : null,
		timestamp: new Date().toISOString(),
	};
}

function userMessageEntry(): SessionMessageEntry {
	return {
		...entryBase(),
		type: "message",
		message: { role: "user", content: "do the work", timestamp: Date.now() } as SessionMessageEntry["message"],
	};
}

/** The entry the supervisor's catalog appends for mark_interrupted (daemon-catalog-process.ts). */
function interruptionMarkerEntry(activeSessionId: string, operations: string[]): CustomMessageEntry {
	return {
		...entryBase(),
		type: "custom_message",
		customType: WORKER_RECOVERY_MARKER_CUSTOM_TYPE,
		content:
			"<prime_agent_worker_interrupted>\nThe isolated session worker stopped during in-flight work. The saved transcript was recovered, but uncertain model, tool, bash, or child-agent work was not replayed. Inspect external side effects before continuing.\n</prime_agent_worker_interrupted>",
		display: false,
		details: { activeSessionId, operations },
	};
}

interface RecoveryWorker {
	descriptor: {
		workerId: string;
		pid: number;
		rootActiveSessionId: string;
		recoveryJournalPath: string;
		orphanProcessJournalPath: string;
	};
}

interface CapturedInterruption {
	sessionFile: string;
	activeSessionId: string;
	operations: string[];
}

function recoverySupervisor(worker: RecoveryWorker): {
	supervisor: { recoverUncertainWorkerOperations(target: RecoveryWorker): Promise<void> };
	interruptions: CapturedInterruption[];
	catalogStart: ReturnType<typeof vi.fn>;
} {
	const interruptions: CapturedInterruption[] = [];
	const catalogStart = vi.fn(async () => undefined);
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		workers: new Map([[worker.descriptor.workerId, worker]]),
		shuttingDown: false,
		catalog: {
			start: catalogStart,
			markInterrupted: vi.fn(async (sessionFile: string, activeSessionId: string, operations: string[]) => {
				interruptions.push({ sessionFile, activeSessionId, operations });
			}),
		},
		log: vi.fn(),
		assertRecoveryAllowed: vi.fn(async () => undefined),
	}) as { recoverUncertainWorkerOperations(target: RecoveryWorker): Promise<void> };
	return { supervisor, interruptions, catalogStart };
}

function makeBoundState(activeSessionId: string, session: AgentSession): ActiveSessionState {
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

/** The bind half of daemon-worker-recovery-resume.test.ts, reduced to what the chain asserts. */
interface BindInternals {
	resumeWorkerInterruptedSession(state: ActiveSessionState): void;
}

function makeBindingDaemon(root: string): BindInternals {
	// The bind path logs the queued resume through getDaemonLogPath; keep it in the sandbox.
	process.env[ENV_AGENT_DIR] = join(root, "agent");
	const daemon = new AgentDaemon(join(root, "worker.sock"), {
		defaultSessionConfig: { agentDir: join(root, "agent"), cwd: root },
		createRuntime: async () => {
			throw new Error("unexpected runtime creation");
		},
	});
	return daemon as unknown as BindInternals;
}

describe("daemon crash recovery chain", () => {
	it("crashed worker's journal drives exactly one interruption marker, and the rebind resumes it", async () => {
		const root = tempRoot();
		const journalPath = join(root, "worker.recovery.jsonl");
		const orphanJournalPath = join(root, "worker.orphans.jsonl");
		writeFileSync(orphanJournalPath, "");
		const sessionFileA = join(root, "session-a.jsonl");
		const sessionFileB = join(root, "session-b.jsonl");

		// --- Worker side, up to the crash. Session A was mid-tool-call; session B
		// had finished its turn. The crash handler's flush is the last write.
		const workerJournal = new WorkerRecoveryJournal(journalPath);
		workerJournal.record({
			activeSessionId: "active-a",
			sessionId: "session-a",
			sessionFile: sessionFileA,
			busy: true,
			operation: "tool_execution_start",
		});
		workerJournal.record({
			activeSessionId: "active-b",
			sessionId: "session-b",
			sessionFile: sessionFileB,
			busy: false,
			operation: "turn_end",
		});
		flushWorkerRecoveryJournalFile(journalPath);
		// The process dies here.

		// --- The journal survives the process: a fresh reader sees both records.
		const survived = WorkerRecoveryJournal.readLatest(journalPath);
		expect(survived).toContainEqual(
			expect.objectContaining({ activeSessionId: "active-a", busy: true, operation: "tool_execution_start" }),
		);
		expect(survived).toContainEqual(expect.objectContaining({ activeSessionId: "active-b", busy: false }));

		// --- Supervisor side: a dead worker (a pid nothing runs on) with that journal.
		const worker: RecoveryWorker = {
			descriptor: {
				workerId: "worker-crashed",
				pid: 987_654,
				rootActiveSessionId: "active-a",
				recoveryJournalPath: journalPath,
				orphanProcessJournalPath: orphanJournalPath,
			},
		};
		const { supervisor, interruptions, catalogStart } = recoverySupervisor(worker);

		await supervisor.recoverUncertainWorkerOperations(worker);

		// Exactly the busy session is marked, with the operation it died in.
		expect(catalogStart).toHaveBeenCalledOnce();
		expect(interruptions).toEqual([
			{ sessionFile: sessionFileA, activeSessionId: "active-a", operations: ["tool_execution_start"] },
		]);
		// The journal is resolved, so the corpse is not kept for its unconsumed records.
		for (const record of WorkerRecoveryJournal.readLatest(journalPath)) {
			expect(record.busy).toBe(false);
			expect(record.operation).toBe("recovery_hold");
		}

		// --- Bind side: a fresh worker re-opens session A's transcript, whose tail is
		// the marker the catalog wrote, and queues the automatic resume.
		const marker = interruptionMarkerEntry(interruptions[0].activeSessionId, interruptions[0].operations);
		const branch = [userMessageEntry(), marker];
		expect(findUnconsumedWorkerRecoveryMarker(branch)).toBe(marker);

		const followUp = vi.fn(async () => true);
		const session = {
			sessionManager: { getBranch: () => branch },
			followUp,
		} as unknown as AgentSession;
		const daemon = makeBindingDaemon(root);
		daemon.resumeWorkerInterruptedSession(makeBoundState("active-a", session));
		// The followUp promise chain is fire-and-forget; one microtask drain observes it.
		await Promise.resolve();

		expect(followUp).toHaveBeenCalledOnce();
		expect(followUp).toHaveBeenCalledWith(WORKER_RECOVERY_RESUME_PROMPT, undefined, { resumeIfIdle: true });
	});

	it("leaves an already-answered interruption alone on the rebind", async () => {
		const root = tempRoot();
		const marker = interruptionMarkerEntry("active-a", ["tool_execution_start"]);
		// A user message after the marker means the interruption was already continued.
		const branch = [marker, userMessageEntry()];
		expect(findUnconsumedWorkerRecoveryMarker(branch)).toBeUndefined();

		const followUp = vi.fn(async () => true);
		const session = {
			sessionManager: { getBranch: () => branch },
			followUp,
		} as unknown as AgentSession;
		makeBindingDaemon(root).resumeWorkerInterruptedSession(makeBoundState("active-a", session));
		await Promise.resolve();

		expect(followUp).not.toHaveBeenCalled();
	});

	it("marks nothing for a worker whose journal shows no in-flight work", async () => {
		const root = tempRoot();
		const journalPath = join(root, "worker.recovery.jsonl");
		const orphanJournalPath = join(root, "worker.orphans.jsonl");
		writeFileSync(orphanJournalPath, "");
		const journal = new WorkerRecoveryJournal(journalPath);
		journal.record({
			activeSessionId: "active-b",
			sessionId: "session-b",
			sessionFile: join(root, "session-b.jsonl"),
			busy: false,
			operation: "turn_end",
		});

		const worker: RecoveryWorker = {
			descriptor: {
				workerId: "worker-idle-crash",
				pid: 987_653,
				rootActiveSessionId: "active-b",
				recoveryJournalPath: journalPath,
				orphanProcessJournalPath: orphanJournalPath,
			},
		};
		const { supervisor, interruptions, catalogStart } = recoverySupervisor(worker);

		await supervisor.recoverUncertainWorkerOperations(worker);

		// No busy records: the catalog is never started and no marker is written.
		expect(catalogStart).not.toHaveBeenCalled();
		expect(interruptions).toEqual([]);
	});
});
