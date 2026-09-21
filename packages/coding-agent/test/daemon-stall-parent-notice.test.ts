import { afterEach, describe, expect, it, vi } from "vitest";
import type { RlmChildAgentSnapshot } from "../src/core/agent-session.js";
import { RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE } from "../src/core/messages.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";

type StallWarningEvent = Extract<
	Extract<DaemonOutbound, { type: "session_event" }>["event"],
	{ type: "stall_warning" }
>;

interface NoticeFixture {
	daemon: {
		sessions: Map<string, ActiveSessionState>;
		childStallNoticeAt: Map<string, number>;
		broadcastToSession(state: ActiveSessionState, message: DaemonOutbound): void;
		log: ReturnType<typeof vi.fn>;
	};
	parentSendCustomMessage: ReturnType<typeof vi.fn>;
	childSendCustomMessage: ReturnType<typeof vi.fn>;
	parent: ActiveSessionState;
	child: ActiveSessionState;
}

function stallWarning(silentMs: number, thresholdMs: number): StallWarningEvent {
	return {
		type: "stall_warning",
		message: "no activity while turn running",
		silentMs,
		thresholdMs,
		diagnostics: {
			silentMs,
			busy: { streaming: true, compacting: false, retrying: false, bashRunning: false },
			lastEvent: { type: "message_end", at: Date.now() - silentMs, ageMs: silentMs },
			inFlightToolCalls: [{ toolCallId: "call-1", toolName: "hang_forever", startedAt: 0, elapsedMs: 12_000 }],
			pump: { suspended: false, requested: true, epoch: 1 },
			unfinishedActions: 1,
		},
	};
}

function makeDaemon(sessions: Map<string, ActiveSessionState>): NoticeFixture["daemon"] {
	return Object.assign(Object.create(AgentDaemon.prototype), {
		options: {},
		sessions,
		childStallNoticeAt: new Map<string, number>(),
		rosterReporter: {
			lastComposed: new Map(),
			lastComposedJson: new Map(),
			queuedChildren: new Map(),
			removedAgentIds: new Map(),
			snapshotPending: false,
		},
		rosterFlushScheduled: false,
		shuttingDown: false,
		log: vi.fn(),
	}) as unknown as NoticeFixture["daemon"];
}

function makeSessionDouble(options: {
	activeSessionId: string;
	sessionName?: string;
	sendCustomMessage?: ReturnType<typeof vi.fn>;
	metadata?: ActiveSessionState["runtime"]["metadata"];
}): ActiveSessionState {
	return {
		activeSessionId: options.activeSessionId,
		clients: new Set(),
		extensionUiRequests: new Map(),
		lastEventSequence: 0,
		eventGeneration: "gen-1",
		runtime: {
			dispose: async () => {},
			metadata: options.metadata ?? { kind: "top-level", createdAt: 1 },
			diagnostics: [],
			session: {
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				sessionFile: undefined,
				sessionId: `session-${options.activeSessionId}`,
				rlmDepth: 0,
				sessionName: options.sessionName ?? `name-${options.activeSessionId}`,
				sessionManager: {
					getCwd: () => "/tmp/project",
					getHeader: () => ({ timestamp: "2026-09-22T00:00:00.000Z" }),
					getSessionDir: () => "/tmp/sessions",
					hasUserContent: () => false,
					appendSessionState: () => {},
				},
				messages: [],
				getRlmChildSnapshots: () => [],
				hasRunningRlmChildren: () => false,
				hasAcceptedPromptInFlight: false,
				unfinishedActionCount: 0,
				abort: async () => {},
				isSessionActive: false,
				getCurrentRecap: () => undefined,
				_contextTokensForCurrentMessages: () => undefined,
				getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
				state: { streamingMessage: undefined, pendingToolCalls: new Set() },
				settingsManager: {
					getStallWatchdogSettings: () => ({
						enabled: true,
						warnAfterSeconds: 30,
						abortAfterSeconds: 120,
						toolLivenessExemption: true,
					}),
				},
				sendCustomMessage: options.sendCustomMessage ?? vi.fn(async () => {}),
			},
		},
	} as unknown as ActiveSessionState;
}

function makeFixture(childSnapshots: () => RlmChildAgentSnapshot[]): NoticeFixture {
	const parentSendCustomMessage = vi.fn(async () => {});
	const childSendCustomMessage = vi.fn(async () => {});
	const parent = makeSessionDouble({ activeSessionId: "parent-active", sendCustomMessage: parentSendCustomMessage });
	parent.runtime.session.getRlmChildSnapshots = childSnapshots;
	const child = makeSessionDouble({
		activeSessionId: "child-active",
		sendCustomMessage: childSendCustomMessage,
		metadata: {
			kind: "subagent",
			createdAt: 1,
			rlmChildId: "child-1",
			parentActiveSessionId: "parent-active",
		},
	});
	const sessions = new Map<string, ActiveSessionState>([
		["parent-active", parent],
		["child-active", child],
	]);
	return {
		daemon: makeDaemon(sessions),
		parentSendCustomMessage,
		childSendCustomMessage,
		parent,
		child,
	};
}

function settledChildSnapshot(status: RlmChildAgentSnapshot["status"] = "done"): RlmChildAgentSnapshot {
	return {
		id: "child-1",
		label: "follow-up work",
		status,
		sessionDir: "/tmp/child-1",
	};
}

describe("daemon-level stall notice to the parent session", () => {
	const realNow = Date.now;

	afterEach(() => {
		Date.now = realNow;
		vi.restoreAllMocks();
	});

	it("delivers an rlm_child_stall_notice to the parent of a retained child in a follow-up turn", async () => {
		const fixture = makeFixture(() => [settledChildSnapshot("done")]);
		fixture.daemon.broadcastToSession(fixture.child, {
			type: "session_event",
			activeSessionId: "child-active",
			event: stallWarning(45_000, 30_000),
		});

		expect(fixture.parentSendCustomMessage).toHaveBeenCalledTimes(1);
		const [notice, options] = fixture.parentSendCustomMessage.mock.calls[0]!;
		expect(notice).toMatchObject({
			customType: RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE,
			details: {
				childId: "child-1",
				sessionName: "name-child-active",
				silentMs: 45_000,
				thresholdMs: 30_000,
			},
		});
		expect(notice.content).toContain("child-1");
		expect(notice.content).toContain("hang_forever");
		// This daemon build serves the agent abort lever, so the notice names it.
		expect(notice.content).toContain('agent_message.abort(receiver_role="child", receiver_name="name-child-active")');
		expect(notice.details).toMatchObject({ canAbortAgentTarget: true });
		expect(options).toEqual({ deliverAs: "followUp" });
		// The notice goes to the parent only; the wedged child gets nothing injected.
		expect(fixture.childSendCustomMessage).not.toHaveBeenCalled();
	});

	it("does not duplicate the notice while the parent tracks a live run for the child", () => {
		for (const status of ["running", "queued"] as const) {
			const fixture = makeFixture(() => [settledChildSnapshot(status)]);
			fixture.daemon.broadcastToSession(fixture.child, {
				type: "session_event",
				activeSessionId: "child-active",
				event: stallWarning(45_000, 30_000),
			});
			expect(fixture.parentSendCustomMessage).not.toHaveBeenCalled();
		}
	});

	it("notifies when the parent tracks no snapshot for the child at all", () => {
		const fixture = makeFixture(() => []);
		fixture.daemon.broadcastToSession(fixture.child, {
			type: "session_event",
			activeSessionId: "child-active",
			event: stallWarning(45_000, 30_000),
		});
		expect(fixture.parentSendCustomMessage).toHaveBeenCalledTimes(1);
	});

	it("rate-limits repeats per child and recovers after the window", () => {
		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(1_000_000);
		const fixture = makeFixture(() => [settledChildSnapshot()]);
		const deliver = () =>
			fixture.daemon.broadcastToSession(fixture.child, {
				type: "session_event",
				activeSessionId: "child-active",
				event: stallWarning(45_000, 30_000),
			});

		deliver();
		now.mockReturnValue(1_000_000 + 5_000);
		deliver();
		expect(fixture.parentSendCustomMessage).toHaveBeenCalledTimes(1);

		now.mockReturnValue(1_000_000 + 10 * 60_000 + 1);
		deliver();
		expect(fixture.parentSendCustomMessage).toHaveBeenCalledTimes(2);
	});

	it("releases the rate-limit stamp when delivery fails so the next warning retries", async () => {
		const sendCustomMessage = vi.fn(async () => {
			throw new Error("admission paused");
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active", sendCustomMessage });
		parent.runtime.session.getRlmChildSnapshots = () => [settledChildSnapshot()];
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: {
				kind: "subagent",
				createdAt: 1,
				rlmChildId: "child-1",
				parentActiveSessionId: "parent-active",
			},
		});
		const sessions = new Map<string, ActiveSessionState>([
			["parent-active", parent],
			["child-active", child],
		]);
		const daemon = makeDaemon(sessions);
		const deliver = () =>
			daemon.broadcastToSession(child, {
				type: "session_event",
				activeSessionId: "child-active",
				event: stallWarning(45_000, 30_000),
			});

		deliver();
		// The rejection handler runs on a later microtask; flush it.
		return new Promise<void>((resolveFlush) => {
			setImmediate(() => {
				expect(sendCustomMessage).toHaveBeenCalledTimes(1);
				deliver();
				expect(sendCustomMessage).toHaveBeenCalledTimes(2);
				resolveFlush();
			});
		});
	});

	it("ignores stalls from sessions without a live parent in this worker", () => {
		const fixture = makeFixture(() => [settledChildSnapshot()]);
		fixture.daemon.sessions.delete("parent-active");
		fixture.daemon.broadcastToSession(fixture.child, {
			type: "session_event",
			activeSessionId: "child-active",
			event: stallWarning(45_000, 30_000),
		});

		const topLevel = makeSessionDouble({ activeSessionId: "root-active" });
		fixture.daemon.sessions.set("root-active", topLevel);
		fixture.daemon.broadcastToSession(topLevel, {
			type: "session_event",
			activeSessionId: "root-active",
			event: stallWarning(45_000, 30_000),
		});
		expect(fixture.parentSendCustomMessage).not.toHaveBeenCalled();
	});

	it("degrades to a notice without diagnostics when the wire event carries none", () => {
		const fixture = makeFixture(() => [settledChildSnapshot()]);
		fixture.daemon.broadcastToSession(fixture.child, {
			type: "session_event",
			activeSessionId: "child-active",
			event: {
				type: "stall_warning",
				message: "no activity while turn running",
				silentMs: 45_000,
				thresholdMs: 30_000,
			},
		});
		expect(fixture.parentSendCustomMessage).toHaveBeenCalledTimes(1);
		const [notice] = fixture.parentSendCustomMessage.mock.calls[0]!;
		expect(notice.content).toContain("In-flight tools: none recorded");
		expect(notice.details).not.toHaveProperty("workEvidence");
	});
});
