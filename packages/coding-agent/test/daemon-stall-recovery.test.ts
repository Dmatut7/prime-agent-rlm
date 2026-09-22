/**
 * Daemon-level stall recovery (r4 recovery-shell, mechanisms ③ + ④-B): the
 * 15s sweep, the epoch claim, the dual evidence, the wait windows, the stop
 * line, the escalation, and the rollback handles - driven through the real
 * sweep method on session doubles, so the policy itself is what is pinned.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RlmChildStallState } from "../src/core/agent-session.js";
import { RLM_CHILD_RECOVERY_ACTION_CUSTOM_TYPE, SYSTEM_INTERRUPTION_CUSTOM_TYPE } from "../src/core/messages.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";

type StallWarningEvent = Extract<
	Extract<DaemonOutbound, { type: "session_event" }>["event"],
	{ type: "stall_warning" }
>;

interface RecoverySettings {
	childEnabled: boolean;
	childGraceSeconds: number;
	rootEnabled: boolean;
	rootHumanWindowSeconds: number;
	maxPerSession: number;
}

interface SessionDoubleOptions {
	activeSessionId: string;
	metadata?: ActiveSessionState["runtime"]["metadata"];
	settings?: Partial<RecoverySettings>;
	clients?: number;
	sessionName?: string;
}

function stallMarker(overrides: Partial<RlmChildStallState> = {}): RlmChildStallState {
	return {
		silentMs: 312_000,
		thresholdMs: 300_000,
		inFlightTools: ["hang_forever"],
		...overrides,
	};
}

interface DaemonDoubleSession {
	stallState?: RlmChildStallState;
	turnLifecycleEpoch: number;
	isStreaming: boolean;
	messages: unknown[];
	settingsManager: {
		getSubagentStallRecoverySettings(): {
			enabled: boolean;
			graceSeconds: number;
			maxPerSession: number;
		};
		getRootStallRecoverySettings(): {
			enabled: boolean;
			humanWindowSeconds: number;
			maxPerSession: number;
		};
	};
	sendCustomMessage: ReturnType<typeof vi.fn>;
	abortAndSendQueued: ReturnType<typeof vi.fn>;
	resumeQueuedWork: ReturnType<typeof vi.fn>;
	sessionName?: string;
	sessionManager: { getSessionDir(): string };
	getRlmChildRerouteCandidate?: (childId: string) => { prompt: string; model: string } | undefined;
}

function makeSessionDouble(
	options: SessionDoubleOptions,
): ActiveSessionState & { runtime: { session: DaemonDoubleSession } } {
	const settings: RecoverySettings = {
		childEnabled: true,
		childGraceSeconds: 300,
		rootEnabled: true,
		rootHumanWindowSeconds: 120,
		maxPerSession: 3,
		...options.settings,
	};
	const session: DaemonDoubleSession = {
		stallState: undefined,
		turnLifecycleEpoch: 7,
		isStreaming: true,
		messages: [],
		settingsManager: {
			getSubagentStallRecoverySettings: () => ({
				enabled: settings.childEnabled,
				graceSeconds: settings.childGraceSeconds,
				maxPerSession: settings.maxPerSession,
			}),
			getRootStallRecoverySettings: () => ({
				enabled: settings.rootEnabled,
				humanWindowSeconds: settings.rootHumanWindowSeconds,
				maxPerSession: settings.maxPerSession,
			}),
		},
		sendCustomMessage: vi.fn(async () => {}),
		abortAndSendQueued: vi.fn(() => false),
		resumeQueuedWork: vi.fn(() => true),
		sessionName: options.sessionName ?? `name-${options.activeSessionId}`,
		sessionManager: { getSessionDir: () => "/tmp/child-session" },
	};
	const clients = new Set();
	// private-framed keeps the broadcast loop on the daemon's own write() (the
	// double stubs it), instead of the module-level serialized writer.
	for (let i = 0; i < (options.clients ?? 0); i++) clients.add({ id: i, transport: "private-framed" });
	return {
		activeSessionId: options.activeSessionId,
		clients,
		extensionUiRequests: new Map(),
		lastEventSequence: 0,
		eventGeneration: "gen-1",
		stallRecovery: undefined,
		runtime: {
			dispose: async () => {},
			metadata: options.metadata ?? { kind: "top-level", createdAt: 1 },
			diagnostics: [],
			session: session as unknown as ActiveSessionState["runtime"]["session"],
		},
	} as unknown as ActiveSessionState & { runtime: { session: DaemonDoubleSession } };
}

interface Fixture {
	daemon: {
		sessions: Map<string, ActiveSessionState>;
		childSessions(): DaemonDoubleSession[];
		log: ReturnType<typeof vi.fn>;
		sweepStallRecovery(now?: number): Promise<void>;
		noteExternalSessionInput(state: ActiveSessionState): void;
		noteStallForRecovery(
			state: ActiveSessionState,
			event: StallWarningEvent & { type: "stall_warning" | "stall_abort" | "stall_unsettled" },
		): void;
	};
	states: Map<string, ActiveSessionState & { runtime: { session: DaemonDoubleSession } }>;
}

function makeFixture(states: ActiveSessionState[]): Fixture {
	const sessions = new Map(states.map((state) => [state.activeSessionId, state]));
	const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
		options: {},
		sessions,
		shuttingDown: false,
		updateRestart: undefined,
		stallRecoveryEpisodes: new Map(),
		stallRecoveryActionCounts: new Map(),
		stallRecoveryNoticedAt: new Map(),
		scheduleRosterFlush: vi.fn(),
		log: vi.fn(),
	});
	return {
		daemon: daemon as unknown as Fixture["daemon"],
		states: sessions as unknown as Fixture["states"],
	};
}

function childMetadata(parentActiveSessionId: string, rlmChildId: string) {
	return { kind: "subagent", createdAt: 1, rlmChildId, parentActiveSessionId } as const;
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
			lastEvent: { type: "message_end", at: 1, ageMs: silentMs },
			inFlightToolCalls: [{ toolCallId: "call-1", toolName: "hang_forever", startedAt: 0, elapsedMs: 12_000 }],
			pump: { suspended: false, requested: true, epoch: 1 },
			unfinishedActions: 1,
		},
	};
}

describe("daemon stall recovery sweep", () => {
	const realNow = Date.now;

	afterEach(() => {
		Date.now = realNow;
		vi.restoreAllMocks();
	});

	it("acts in the load-bearing order: queue the system instruction, then abort and resume", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
			settings: { childGraceSeconds: 0 },
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		child.runtime.session.stallState = stallMarker();
		const order: string[] = [];
		child.runtime.session.sendCustomMessage.mockImplementation(async () => {
			order.push("send");
		});
		child.runtime.session.abortAndSendQueued.mockImplementation(() => {
			order.push("abort_and_send");
			return false;
		});
		child.runtime.session.resumeQueuedWork.mockImplementation(() => {
			order.push("resume");
			return true;
		});
		const now = 1_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);

		// First sighting only records; the second confirms the frozen transcript.
		await fixture.daemon.sweepStallRecovery(now);
		expect(order).toEqual([]);
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		expect(order).toEqual(["send", "abort_and_send", "resume"]);
		// The system interruption carries the "NOT a user Esc" clause.
		const [notice] = child.runtime.session.sendCustomMessage.mock.calls[0]!;
		expect(notice.customType).toBe(SYSTEM_INTERRUPTION_CUSTOM_TYPE);
		expect(notice.content).toContain("NOT a user Esc");
		expect(notice.details).toMatchObject({ trigger: "stall_recovery", isChild: true });
	});

	it("claims the epoch: exactly one action per (session, turn)", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
			settings: { childGraceSeconds: 0 },
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		child.runtime.session.stallState = stallMarker();
		const now = 1_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);

		await fixture.daemon.sweepStallRecovery(now);
		for (let i = 0; i < 5; i++) {
			await fixture.daemon.sweepStallRecovery(now + 15_000 + i * 15_000);
		}
		expect(child.runtime.session.sendCustomMessage).toHaveBeenCalledTimes(1);
		expect(child.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(1);

		// A new turn (epoch advance) is a new episode: the claim is fresh.
		child.runtime.session.turnLifecycleEpoch += 1;
		await fixture.daemon.sweepStallRecovery(now + 200_000);
		await fixture.daemon.sweepStallRecovery(now + 215_000);
		expect(child.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(2);
	});

	it("a child waits its grace window: 299s is too early, 301s acts", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		child.runtime.session.stallState = stallMarker();
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now);
		// Grace (default 300s) is the window in which the parent model may answer
		// the stall notice itself; the sweep holds off inside it.
		await fixture.daemon.sweepStallRecovery(now + 299_000);
		expect(child.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
		await fixture.daemon.sweepStallRecovery(now + 301_000);
		expect(child.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(1);
	});

	it("never kills an excused stall: the watchdog's exemption is the single arbiter", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		child.runtime.session.stallState = stallMarker({ excused: true, excusedReasons: ["live_bash_handles"] });
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now);
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		await fixture.daemon.sweepStallRecovery(now + 3_000_000);
		expect(child.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
	});

	it("depth-0 with no attached client acts as soon as the evidence confirms; 119s is too early", async () => {
		const root = makeSessionDouble({ activeSessionId: "root-active", clients: 0 });
		const fixture = makeFixture([root]);
		root.runtime.session.stallState = stallMarker();
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now);
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		expect(root.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(1);
	});

	it("depth-0 with an attached client waits the human window, then acts", async () => {
		const root = makeSessionDouble({ activeSessionId: "root-active", clients: 1 });
		const fixture = makeFixture([root]);
		root.runtime.session.stallState = stallMarker();
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now);
		// 119s since first sighting: still inside the 120s window.
		await fixture.daemon.sweepStallRecovery(now + 119_000);
		expect(root.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
		await fixture.daemon.sweepStallRecovery(now + 121_000);
		expect(root.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(1);
		// The root action injects the root variant of the system instruction.
		const [notice] = root.runtime.session.sendCustomMessage.mock.calls[0]!;
		expect(notice.details).toMatchObject({ isChild: false });
	});

	it("external input during the window keeps the episode alive: never auto-acted", async () => {
		const root = makeSessionDouble({ activeSessionId: "root-active", clients: 1 });
		const fixture = makeFixture([root]);
		root.runtime.session.stallState = stallMarker();
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now);
		// The user answered inside the window.
		fixture.daemon.noteExternalSessionInput(root);
		await fixture.daemon.sweepStallRecovery(now + 121_000);
		await fixture.daemon.sweepStallRecovery(now + 3_000_000);
		expect(root.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
	});

	it("external input in the event-to-first-sweep gap also counts (keptAlive is seeded)", async () => {
		const root = makeSessionDouble({ activeSessionId: "root-active", clients: 1 });
		const fixture = makeFixture([root]);
		const now = 1_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);

		// The stall event seeds the observation; the user reacts before the sweep
		// ever polls.
		fixture.daemon.noteStallForRecovery(root, stallWarning(45_000, 30_000));
		fixture.daemon.noteExternalSessionInput(root);
		root.runtime.session.stallState = stallMarker();
		await fixture.daemon.sweepStallRecovery(now);
		await fixture.daemon.sweepStallRecovery(now + 121_000);
		expect(root.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
	});

	it("advancing messages refresh the observation instead of acting on stale evidence", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		child.runtime.session.stallState = stallMarker();
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now);
		// The model produced output: the transcript moved, so the episode is
		// refreshed (the wait window restarts) rather than concluded.
		child.runtime.session.messages.push({ role: "assistant", content: "progress" });
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		await fixture.daemon.sweepStallRecovery(now + 30_000);
		expect(child.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
	});

	it("a session whose turn ended is left alone (nothing to abort)", async () => {
		const root = makeSessionDouble({ activeSessionId: "root-active" });
		const fixture = makeFixture([root]);
		// The marker survives to the next agent_start, but no turn is streaming.
		root.runtime.session.stallState = stallMarker();
		root.runtime.session.isStreaming = false;
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now);
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		expect(root.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
	});

	it("stop line: three consecutive actions, then notification only", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
			settings: { childGraceSeconds: 0 },
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		const now = 1_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);

		// Three stall episodes, each a fresh epoch, all without external input.
		for (let episode = 0; episode < 4; episode++) {
			child.runtime.session.stallState = stallMarker();
			child.runtime.session.turnLifecycleEpoch = 7 + episode;
			await fixture.daemon.sweepStallRecovery(now + episode * 100_000);
			await fixture.daemon.sweepStallRecovery(now + episode * 100_000 + 15_000);
		}
		expect(child.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(3);
		// The fourth episode logged the stop line instead of acting.
		const stopLine = fixture.daemon.log.mock.calls.find((call) => String(call[0]).includes("stop line reached"));
		expect(stopLine).toBeDefined();
		// The count resets on external input: the chain is "actions without input".
		fixture.daemon.noteExternalSessionInput(child);
		child.runtime.session.turnLifecycleEpoch += 1;
		child.runtime.session.stallState = stallMarker();
		await fixture.daemon.sweepStallRecovery(now + 500_000);
		await fixture.daemon.sweepStallRecovery(now + 515_000);
		expect(child.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(4);
	});

	it("escalation: still dead 15 minutes after the action gets one parent notice, no second action", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
			settings: { childGraceSeconds: 0 },
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		parent.runtime.session.getRlmChildRerouteCandidate = () => ({
			prompt: "hang inside a tool",
			model: "faux/mini",
			sessionName: "name-child-active",
		});
		const fixture = makeFixture([child, parent]);
		child.runtime.session.stallState = stallMarker();
		const now = 1_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);

		await fixture.daemon.sweepStallRecovery(now);
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		// The action receipt went to the parent in this worker.
		expect(parent.runtime.session.sendCustomMessage).toHaveBeenCalledTimes(1);
		const [receipt, receiptOptions] = parent.runtime.session.sendCustomMessage.mock.calls[0]!;
		expect(receipt.customType).toBe(RLM_CHILD_RECOVERY_ACTION_CUSTOM_TYPE);
		expect(receiptOptions).toEqual({ deliverAs: "followUp" });
		expect(receipt.content).toContain("child-1");
		expect(receipt.content).toContain("No automatic re-dispatch");

		// Still dead 15 minutes later (same epoch, frozen transcript): exactly one
		// escalation notice, never a second action.
		await fixture.daemon.sweepStallRecovery(now + 15_000 + 15 * 60_000 + 1_000);
		expect(parent.runtime.session.sendCustomMessage).toHaveBeenCalledTimes(2);
		const [escalation] = parent.runtime.session.sendCustomMessage.mock.calls[1]!;
		expect(escalation.details).toMatchObject({ escalated: true });
		expect(escalation.content).toContain("still silent");
		// The escalation carries the pasteable re-dispatch line with the run's facts.
		expect(escalation.content).toContain("await rlm(");
		expect(escalation.content).toContain("name-child-active-retry");
		expect(escalation.content).toContain("faux/mini");
		expect(child.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(1);
		// A later sweep does not repeat the escalation.
		await fixture.daemon.sweepStallRecovery(now + 15_000 + 20 * 60_000);
		expect(parent.runtime.session.sendCustomMessage).toHaveBeenCalledTimes(2);
	});

	it("rollback handles: child disabled and root disabled each stop their half", async () => {
		const disabledChild = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
			settings: { childEnabled: false },
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const childFixture = makeFixture([disabledChild, parent]);
		disabledChild.runtime.session.stallState = stallMarker();
		await childFixture.daemon.sweepStallRecovery(1_000_000);
		await childFixture.daemon.sweepStallRecovery(1_060_000);
		expect(disabledChild.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();

		const disabledRoot = makeSessionDouble({ activeSessionId: "root-active", settings: { rootEnabled: false } });
		const rootFixture = makeFixture([disabledRoot]);
		disabledRoot.runtime.session.stallState = stallMarker();
		await rootFixture.daemon.sweepStallRecovery(1_000_000);
		await rootFixture.daemon.sweepStallRecovery(1_060_000);
		expect(disabledRoot.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
	});

	it("admission failure releases the claim so the next sweep retries", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
			settings: { childGraceSeconds: 0 },
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		child.runtime.session.stallState = stallMarker();
		const now = 1_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		let failNext = true;
		child.runtime.session.sendCustomMessage.mockImplementation(async () => {
			if (failNext) throw new Error("admission paused");
		});

		await fixture.daemon.sweepStallRecovery(now);
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		// The failed attempt did not abort the turn and did not burn the claim.
		expect(child.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
		failNext = false;
		// The released claim means the retry starts a fresh episode: one sweep to
		// observe, one to confirm and act.
		await fixture.daemon.sweepStallRecovery(now + 30_000);
		await fixture.daemon.sweepStallRecovery(now + 45_000);
		expect(child.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(1);
	});

	it("excused stays excused across sweeps; the marker clears with the stall", async () => {
		const root = makeSessionDouble({ activeSessionId: "root-active" });
		const fixture = makeFixture([root]);
		root.runtime.session.stallState = stallMarker({ excused: true });
		await fixture.daemon.sweepStallRecovery(1_000_000);
		await fixture.daemon.sweepStallRecovery(1_060_000);
		expect(root.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
		// The stall clearing forgets the episode entirely.
		root.runtime.session.stallState = undefined;
		await fixture.daemon.sweepStallRecovery(1_120_000);
		root.runtime.session.stallState = stallMarker();
		await fixture.daemon.sweepStallRecovery(1_180_000);
		await fixture.daemon.sweepStallRecovery(1_195_000);
		expect(root.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(1);
	});
});

describe("stall event enrichment and S1", () => {
	interface BroadcastDaemonDouble {
		sessions: Map<string, ActiveSessionState>;
		broadcastToSession(state: ActiveSessionState, message: DaemonOutbound): void;
	}

	function makeBroadcastFixture(root: ActiveSessionState): {
		daemon: BroadcastDaemonDouble;
		captured: DaemonOutbound[];
	} {
		const sessions = new Map([[root.activeSessionId, root]]);
		const captured: DaemonOutbound[] = [];
		const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
			options: {},
			sessions,
			shuttingDown: false,
			updateRestart: undefined,
			stallRecoveryEpisodes: new Map(),
			stallRecoveryActionCounts: new Map(),
			stallRecoveryNoticedAt: new Map(),
			scheduleRosterFlush: vi.fn(),
			summarizer: { notifyActivity: vi.fn() },
			isDiscardableDraft: vi.fn(() => false),
			stampRlmChildActiveSessionId: vi.fn(),
			observeRosterEvent: vi.fn(),
			addSessionEventMeta: vi.fn((_state: unknown, message: DaemonOutbound) => {
				captured.push(message);
				return message;
			}),
			write: vi.fn(),
			log: vi.fn(),
		});
		return { daemon: daemon as unknown as BroadcastDaemonDouble, captured };
	}

	it("stall_warning carries the actions field once recovery is armed", () => {
		const root = makeSessionDouble({ activeSessionId: "root-active", clients: 1 });
		const fixture = makeBroadcastFixture(root);
		const now = 1_000_000;
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
		fixture.daemon.broadcastToSession(root, {
			type: "session_event",
			activeSessionId: "root-active",
			event: stallWarning(45_000, 30_000),
		});
		nowSpy.mockRestore();

		expect(fixture.captured).toHaveLength(1);
		const event = (fixture.captured[0] as { event: StallWarningEvent }).event;
		// The daemon offers both actions and reports the armed auto recovery with
		// its expected time: the event was seeded at `now`, and an attached client
		// means a 120s human window on top of it.
		expect(event.actions).toMatchObject({
			canAbort: true,
			canDiagnose: true,
			autoRecoveryArmed: true,
			executor: "daemon",
		});
		expect(event.actions?.autoRecoveryAtMs).toBe(now + 120_000);
	});

	it("stall_warning without an armed recovery still carries canAbort/canDiagnose, disarmed", () => {
		const root = makeSessionDouble({ activeSessionId: "root-active", settings: { rootEnabled: false } });
		const fixture = makeBroadcastFixture(root);
		fixture.daemon.broadcastToSession(root, {
			type: "session_event",
			activeSessionId: "root-active",
			event: stallWarning(45_000, 30_000),
		});

		const event = (fixture.captured[0] as { event: StallWarningEvent }).event;
		expect(event.actions).toMatchObject({ autoRecoveryArmed: false });
		expect(event.actions?.autoRecoveryAtMs).toBeUndefined();
	});

	it("S1: terminal stall stages never carry actions - the branch only enriches stall_warning", () => {
		const root = makeSessionDouble({ activeSessionId: "root-active" });
		const fixture = makeBroadcastFixture(root);
		const event = { ...stallWarning(45_000, 30_000), type: "stall_abort" } as StallWarningEvent & {
			type: "stall_abort";
		};
		fixture.daemon.broadcastToSession(root, {
			type: "session_event",
			activeSessionId: "root-active",
			event,
		});

		const capturedEvent = (fixture.captured[0] as { event: StallWarningEvent }).event;
		// Positive control for the detector: the warn branch above adds the field,
		// so its absence here is the S1 degrade, not a broken capture.
		expect("actions" in (capturedEvent as object)).toBe(false);
	});
});
