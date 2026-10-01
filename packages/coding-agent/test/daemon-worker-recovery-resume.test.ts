import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "../src/core/session-manager.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import {
	findUnconsumedWorkerRecoveryMarker,
	WORKER_RECOVERY_MARKER_CUSTOM_TYPE,
	WORKER_RECOVERY_RESUME_PROMPT,
} from "../src/modes/daemon/worker-recovery-resume.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 中断-6: a worker that dies mid-turn leaves a prime-agent.worker_recovery
 * marker on the transcript (supervisor catalog, from the dead worker's
 * recovery-journal busy records). On bind, a marker still tailing the branch
 * queues one automatic resume prompt; a message of either role after the marker
 * means the interruption was already answered.
 */

let entrySeq = 0;
function entryBase(): { id: string; parentId: string | null; timestamp: string } {
	entrySeq += 1;
	return {
		id: `e${entrySeq}`,
		parentId: entrySeq > 1 ? `e${entrySeq - 1}` : null,
		timestamp: new Date().toISOString(),
	};
}

function markerEntry(): CustomMessageEntry {
	return {
		...entryBase(),
		type: "custom_message",
		customType: WORKER_RECOVERY_MARKER_CUSTOM_TYPE,
		content: "<prime_agent_worker_interrupted>…</prime_agent_worker_interrupted>",
		display: false,
		details: { activeSessionId: "dead-worker-session", operations: ["turn_end"] },
	};
}

function messageEntry(role: "user" | "assistant"): SessionMessageEntry {
	return {
		...entryBase(),
		type: "message",
		message: { role, content: "text", timestamp: Date.now() } as SessionMessageEntry["message"],
	};
}

function stateEntry(): SessionEntry {
	return { ...entryBase(), type: "session_state", state: { status: "active" } };
}

describe("findUnconsumedWorkerRecoveryMarker", () => {
	it("returns the marker when it tails the branch", () => {
		const marker = markerEntry();
		expect(findUnconsumedWorkerRecoveryMarker([messageEntry("user"), marker])).toBe(marker);
	});

	it("stays armed across non-message entries appended after the marker (bind-time session_state)", () => {
		const marker = markerEntry();
		expect(findUnconsumedWorkerRecoveryMarker([messageEntry("user"), marker, stateEntry()])).toBe(marker);
	});

	it("is consumed by any message after the marker - user or assistant", () => {
		expect(findUnconsumedWorkerRecoveryMarker([markerEntry(), messageEntry("user")])).toBeUndefined();
		expect(findUnconsumedWorkerRecoveryMarker([markerEntry(), messageEntry("assistant")])).toBeUndefined();
	});

	it("returns only the newest of stacked markers (a session that died twice)", () => {
		const first = markerEntry();
		const second = markerEntry();
		expect(findUnconsumedWorkerRecoveryMarker([first, second])).toBe(second);
	});

	it("returns undefined without a marker", () => {
		expect(findUnconsumedWorkerRecoveryMarker([messageEntry("user")])).toBeUndefined();
		expect(findUnconsumedWorkerRecoveryMarker([])).toBeUndefined();
	});
});

describe("worker-recovery marker registration", () => {
	it("pins the marker type against the catalog writer it mirrors", () => {
		// The supervisor's catalog owns the literal (daemon-catalog-process.ts
		// mark_interrupted); a rename there must fail here instead of silently
		// blinding the resume.
		const source = readFileSync(resolve(__dirname, "../src/modes/daemon/daemon-catalog-process.ts"), "utf8");
		expect(source).toContain(`"${WORKER_RECOVERY_MARKER_CUSTOM_TYPE}"`);
	});
});

interface DaemonInternals {
	resumeWorkerInterruptedSession(state: ActiveSessionState): void;
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

describe("daemon worker-recovery resume on bind", () => {
	function makeDaemon(): DaemonInternals {
		const daemon = new AgentDaemon("/tmp/prime-agent-worker-recovery-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-worker-recovery-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		return daemon as unknown as DaemonInternals;
	}

	it("queues the automatic resume prompt for a session whose transcript tails an interruption marker", async () => {
		const internals = makeDaemon();
		const followUp = vi.fn(async () => true);
		const session = {
			sessionManager: { getBranch: () => [messageEntry("user"), markerEntry()] },
			followUp,
		} as unknown as AgentSession;
		const state = makeBoundState("active-1", session);

		internals.resumeWorkerInterruptedSession(state);
		// The followUp promise chain is fire-and-forget; one microtask drain observes it.
		await Promise.resolve();

		expect(followUp).toHaveBeenCalledOnce();
		expect(followUp).toHaveBeenCalledWith(WORKER_RECOVERY_RESUME_PROMPT, undefined, { resumeIfIdle: true });
		expect(WORKER_RECOVERY_RESUME_PROMPT).toContain("this resume is automatic");
		expect(WORKER_RECOVERY_RESUME_PROMPT).toContain("Inspect external side effects");
	});

	it("leaves a session whose marker was already answered alone", () => {
		const internals = makeDaemon();
		const followUp = vi.fn(async () => true);
		const session = {
			sessionManager: { getBranch: () => [markerEntry(), messageEntry("user")] },
			followUp,
		} as unknown as AgentSession;

		internals.resumeWorkerInterruptedSession(makeBoundState("active-2", session));

		expect(followUp).not.toHaveBeenCalled();
	});

	it("leaves a session with no marker alone", () => {
		const internals = makeDaemon();
		const followUp = vi.fn(async () => true);
		const session = {
			sessionManager: { getBranch: () => [messageEntry("user")] },
			followUp,
		} as unknown as AgentSession;

		internals.resumeWorkerInterruptedSession(makeBoundState("active-3", session));

		expect(followUp).not.toHaveBeenCalled();
	});
});
