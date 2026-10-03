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
	workerRecoveryResumeVerdict,
} from "../src/modes/daemon/worker-recovery-resume.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 中断-6: a worker that dies mid-turn leaves a prime-agent.worker_recovery
 * marker on the transcript (supervisor catalog, from the dead worker's
 * recovery-journal busy records). On bind, a marker still tailing the branch
 * queues one automatic resume prompt; a message of either role, or a
 * continuation custom message (self-recovery continue, failure-recovery turn),
 * after the marker means the interruption was already answered.
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

function markerEntry(options?: { queuedInputs?: string[]; timestamp?: string }): CustomMessageEntry {
	const base = entryBase();
	return {
		...base,
		...(options?.timestamp === undefined ? {} : { timestamp: options.timestamp }),
		type: "custom_message",
		customType: WORKER_RECOVERY_MARKER_CUSTOM_TYPE,
		content: "<prime_agent_worker_interrupted>…</prime_agent_worker_interrupted>",
		display: false,
		details: {
			activeSessionId: "dead-worker-session",
			operations: ["turn_end"],
			...(options?.queuedInputs === undefined ? {} : { queuedInputs: options.queuedInputs }),
		},
	};
}

function customMessageEntry(customType: string): CustomMessageEntry {
	return {
		...entryBase(),
		type: "custom_message",
		customType,
		content: "continuation or notice text",
		display: true,
	};
}

function messageEntry(role: "user" | "assistant", text = "text"): SessionMessageEntry {
	return {
		...entryBase(),
		type: "message",
		message: { role, content: text, timestamp: Date.now() } as SessionMessageEntry["message"],
	};
}

/** The resume prompt as it lands in the transcript: a user message carrying it. */
function resumePromptEntry(): SessionMessageEntry {
	return messageEntry("user", WORKER_RECOVERY_RESUME_PROMPT);
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

	it("is consumed by a continuation custom message after the marker", () => {
		// Self-recovery continues and the one-shot failure-recovery turns land as custom
		// messages (the recovery turns through the prepared action's message override), so
		// a session that continued past the interruption can tail one with no intervening
		// message entry; queueing the resume again would double-continue the same work.
		expect(findUnconsumedWorkerRecoveryMarker([markerEntry(), customMessageEntry("auto_continue")])).toBeUndefined();
		expect(
			findUnconsumedWorkerRecoveryMarker([markerEntry(), customMessageEntry("provider_failure_recovery")]),
		).toBeUndefined();
		expect(
			findUnconsumedWorkerRecoveryMarker([markerEntry(), customMessageEntry("empty_response_recovery")]),
		).toBeUndefined();
	});

	it("stays armed across notice custom messages - they record state, no turn answered them", () => {
		const marker = markerEntry();
		expect(findUnconsumedWorkerRecoveryMarker([marker, customMessageEntry("session_context_loss")])).toBe(marker);
		expect(findUnconsumedWorkerRecoveryMarker([marker, customMessageEntry("ipython_state")])).toBe(marker);
		expect(findUnconsumedWorkerRecoveryMarker([marker, customMessageEntry("finish_gate_released")])).toBe(marker);
	});

	it("a continuation consumes every older marker, while a newer marker still re-arms", () => {
		const first = markerEntry();
		const second = markerEntry();
		expect(findUnconsumedWorkerRecoveryMarker([first, second, customMessageEntry("auto_continue")])).toBeUndefined();
		expect(findUnconsumedWorkerRecoveryMarker([first, customMessageEntry("auto_continue"), second])).toBe(second);
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

	it("leaves a session whose marker was answered by a continuation custom message alone", () => {
		const internals = makeDaemon();
		const followUp = vi.fn(async () => true);
		const session = {
			sessionManager: { getBranch: () => [markerEntry(), customMessageEntry("auto_continue")] },
			followUp,
		} as unknown as AgentSession;

		internals.resumeWorkerInterruptedSession(makeBoundState("active-4", session));

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

describe("workerRecoveryResumeVerdict: the crash loop guard", () => {
	it("resumes a fresh interruption and carries the marker's queued inputs", () => {
		const marker = markerEntry({ queuedInputs: ["继续把测试修完", "然后看一眼 lint"] });
		const verdict = workerRecoveryResumeVerdict([messageEntry("user"), marker]);
		expect(verdict.kind).toBe("resume");
		if (verdict.kind !== "resume") throw new Error("expected resume");
		expect(verdict.marker).toBe(marker);
		expect(verdict.queuedInputs).toEqual(["继续把测试修完", "然后看一眼 lint"]);
	});

	it("skips when there is nothing to answer", () => {
		expect(workerRecoveryResumeVerdict([messageEntry("user")]).kind).toBe("skip");
		expect(workerRecoveryResumeVerdict([markerEntry(), messageEntry("user")]).kind).toBe("skip");
	});

	it("one previous auto-resume still allows the next", () => {
		const branch = [markerEntry(), resumePromptEntry(), messageEntry("assistant"), markerEntry()];
		expect(workerRecoveryResumeVerdict(branch).kind).toBe("resume");
	});

	it("stops auto-resuming after two consecutive crash-resume cycles", () => {
		const branch = [
			markerEntry(),
			resumePromptEntry(),
			messageEntry("assistant"),
			markerEntry(),
			resumePromptEntry(),
			messageEntry("assistant"),
			markerEntry(),
		];
		const verdict = workerRecoveryResumeVerdict(branch);
		expect(verdict.kind).toBe("skip");
		if (verdict.kind !== "skip") throw new Error("expected skip");
		expect(verdict.reason).toBe("resume-loop");
	});

	it("a real user message resets the consecutive count", () => {
		const branch = [
			markerEntry(),
			resumePromptEntry(),
			markerEntry(),
			resumePromptEntry(),
			messageEntry("user", "别管了，换个方向"),
			markerEntry(),
		];
		expect(workerRecoveryResumeVerdict(branch).kind).toBe("resume");
	});

	it("replayed queued inputs do not reset the count (they are the resume's own cargo)", () => {
		const branch = [
			markerEntry({ queuedInputs: ["排队的活"] }),
			messageEntry("user", "排队的活"),
			resumePromptEntry(),
			markerEntry({ queuedInputs: ["排队的活"] }),
			messageEntry("user", "排队的活"),
			resumePromptEntry(),
			markerEntry(),
		];
		const verdict = workerRecoveryResumeVerdict(branch);
		expect(verdict.kind).toBe("skip");
		if (verdict.kind !== "skip") throw new Error("expected skip");
		expect(verdict.reason).toBe("resume-loop");
	});

	it("does not auto-resume an interruption older than a day", () => {
		const stale = markerEntry({ timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
		const verdict = workerRecoveryResumeVerdict([messageEntry("user"), stale]);
		expect(verdict.kind).toBe("skip");
		if (verdict.kind !== "skip") throw new Error("expected skip");
		expect(verdict.reason).toBe("stale");
	});
});

describe("daemon worker-recovery resume on bind: replay and loop guard", () => {
	function makeDaemon(): DaemonInternals {
		const daemon = new AgentDaemon("/tmp/prime-agent-worker-recovery-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-worker-recovery-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		return daemon as unknown as DaemonInternals;
	}

	it("replays the marker's queued inputs before the resume prompt", async () => {
		const internals = makeDaemon();
		const followUp = vi.fn(async () => true);
		const session = {
			sessionManager: {
				getBranch: () => [messageEntry("user"), markerEntry({ queuedInputs: ["先跑测试", "再修 lint"] })],
			},
			followUp,
		} as unknown as AgentSession;

		internals.resumeWorkerInterruptedSession(makeBoundState("active-r1", session));
		await vi.waitFor(() => expect(followUp).toHaveBeenCalledTimes(3));

		expect(followUp.mock.calls[0]).toEqual(["先跑测试", undefined, { resumeIfIdle: false }]);
		expect(followUp.mock.calls[1]).toEqual(["再修 lint", undefined, { resumeIfIdle: false }]);
		expect(followUp.mock.calls[2]).toEqual([WORKER_RECOVERY_RESUME_PROMPT, undefined, { resumeIfIdle: true }]);
	});

	it("does not auto-resume a session caught in a crash-resume loop", async () => {
		const internals = makeDaemon();
		const followUp = vi.fn(async () => true);
		const session = {
			sessionManager: {
				getBranch: () => [
					markerEntry(),
					resumePromptEntry(),
					messageEntry("assistant"),
					markerEntry(),
					resumePromptEntry(),
					messageEntry("assistant"),
					markerEntry(),
				],
			},
			followUp,
		} as unknown as AgentSession;

		internals.resumeWorkerInterruptedSession(makeBoundState("active-r2", session));
		await Promise.resolve();

		expect(followUp).not.toHaveBeenCalled();
	});
});
