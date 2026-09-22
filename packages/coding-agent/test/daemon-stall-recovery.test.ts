/**
 * Daemon-level stall recovery (r4 recovery-shell, mechanisms ③ + ④-B): the
 * 15s sweep, the epoch claim, the dual evidence, the wait windows, the stop
 * line, the escalation, and the rollback handles - driven through the real
 * sweep method on session doubles, so the policy itself is what is pinned.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessageDeliveryStatus,
	type AgentSessionMessagePayload,
} from "../src/core/agent-messages.js";
import type { RlmChildStallState } from "../src/core/agent-session.js";
import {
	RLM_CHILD_RECOVERY_ACTION_CUSTOM_TYPE,
	STALL_RECOVERY_ESCALATION_CUSTOM_TYPE,
	SYSTEM_INTERRUPTION_CUSTOM_TYPE,
} from "../src/core/messages.js";
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
	/** r4-p2 fix A: the measured event clock, live liveness facts, and the watchdog's live verdict. */
	lastAgentEventAt?: number;
	isBashRunning?: boolean;
	isRetrying?: boolean;
	isCompacting?: boolean;
	excusedNow?: boolean;
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
	/** Command-surface stubs: the user-input wiring tests drive the real handleCommand against these. */
	requestAbort: ReturnType<typeof vi.fn>;
	promptUntilAccepted: ReturnType<typeof vi.fn>;
	promptAndWait: ReturnType<typeof vi.fn>;
	steer: ReturnType<typeof vi.fn>;
	followUp: ReturnType<typeof vi.fn>;
	resumeQueuedWorkFromConnection: ReturnType<typeof vi.fn>;
	acceptAgentMessagePrompt: ReturnType<typeof vi.fn>;
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
		requestAbort: vi.fn(),
		promptUntilAccepted: vi.fn(async () => {}),
		promptAndWait: vi.fn(async () => {}),
		steer: vi.fn(async () => {}),
		followUp: vi.fn(async () => true),
		resumeQueuedWorkFromConnection: vi.fn(() => true),
		acceptAgentMessagePrompt: vi.fn(async () => {}),
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
		write: ReturnType<typeof vi.fn>;
		promptAdmissions: Map<string, unknown>;
		sweepStallRecovery(now?: number): Promise<void>;
		noteExternalSessionInput(state: ActiveSessionState): void;
		noteStallForRecovery(
			state: ActiveSessionState,
			event: StallWarningEvent & { type: "stall_warning" | "stall_abort" | "stall_unsettled" },
		): void;
		getBoundSessionState(activeSessionId: string): ActiveSessionState;
		getSessionState(activeSessionId: string): ActiveSessionState;
		handleCommand(client: unknown, command: unknown, onPromptHandlerOwnsAdmission?: () => void): Promise<unknown>;
		acceptAgentSessionMessage(
			targetState: ActiveSessionState,
			payload: AgentSessionMessagePayload,
		): Promise<{ status: AgentSessionMessageDeliveryStatus }>;
	};
	states: Map<string, ActiveSessionState & { runtime: { session: DaemonDoubleSession } }>;
}

function makeFixture(states: ActiveSessionState[]): Fixture {
	const sessions = new Map(states.map((state) => [state.activeSessionId, state]));
	const resolveState = (activeSessionId: string): ActiveSessionState => {
		const state = sessions.get(activeSessionId);
		if (!state) throw new Error(`Unknown active session: ${activeSessionId}`);
		return state;
	};
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
		write: vi.fn(),
		promptAdmissions: new Map(),
		getBoundSessionState: resolveState,
		getSessionState: resolveState,
	});
	return {
		daemon: daemon as unknown as Fixture["daemon"],
		states: sessions as unknown as Fixture["states"],
	};
}

/** A minimal command-sending client: the command cases under test only need an addressable peer. */
function makeClient(): unknown {
	return { id: "client-1", transport: "private-framed" };
}

function childMetadata(parentActiveSessionId: string, rlmChildId: string) {
	return { kind: "subagent", createdAt: 1, rlmChildId, parentActiveSessionId } as const;
}

/** A minimal agent-message payload for the delivery-path pins. */
function nudgePayload(activeSessionId: string): AgentSessionMessagePayload {
	return {
		id: "agentmsg_pin-1",
		source: AGENT_MESSAGE_SOURCE,
		message: "status?",
		target: { activeSessionId, sessionId: `${activeSessionId}-session` },
	};
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

	it("never kills an excused stall while the watchdog's exemption still holds (live arbiter)", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		child.runtime.session.stallState = stallMarker({ excused: true, excusedReasons: ["live_bash_handles"] });
		// A (blind-3 P8 fix): the sweep asks the watchdog now - `excusedNow` is its
		// live, unexhausted verdict, not the marker's warn-time snapshot.
		child.runtime.session.excusedNow = true;
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now);
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		await fixture.daemon.sweepStallRecovery(now + 3_000_000);
		expect(child.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
	});

	it("P8: an excused stall whose watchdog budget has run out is still acted on", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
			settings: { childGraceSeconds: 0 },
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		// The marker still carries the warn-time excuse; the live sample says the
		// budget is spent. The single arbiter has spoken: the sweep acts.
		child.runtime.session.stallState = stallMarker({ excused: true, excusedReasons: ["live_bash_handles"] });
		child.runtime.session.excusedNow = false;
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now);
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		expect(child.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(1);
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

	it("advancing events refresh the observation instead of acting on stale evidence", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		child.runtime.session.stallState = stallMarker();
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now);
		// The model produced output: agent events flowed (message_end would land
		// too), so the episode is refreshed (the wait window restarts) rather than
		// concluded - the moved check is measured, not transcript-inferred.
		child.runtime.session.lastAgentEventAt = now + 14_000;
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
		root.runtime.session.excusedNow = true;
		await fixture.daemon.sweepStallRecovery(1_000_000);
		await fixture.daemon.sweepStallRecovery(1_060_000);
		expect(root.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
		// The stall clearing forgets the episode entirely.
		root.runtime.session.stallState = undefined;
		await fixture.daemon.sweepStallRecovery(1_120_000);
		root.runtime.session.stallState = stallMarker();
		root.runtime.session.excusedNow = false;
		await fixture.daemon.sweepStallRecovery(1_180_000);
		await fixture.daemon.sweepStallRecovery(1_195_000);
		expect(root.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(1);
	});

	it("probe B (blind-2 F1): a streaming turn is never killed by the transcript-freeze heuristic", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
			settings: { childGraceSeconds: 0 },
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		// An earlier warn left the marker; the model recovered and is streaming:
		// token deltas keep arriving while messages.length stays frozen.
		child.runtime.session.stallState = stallMarker();
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now); // first sighting: the episode exists
		for (let i = 1; i <= 10; i++) {
			// Events keep flowing (deltas, tool starts/ends) - none landed a message yet.
			child.runtime.session.lastAgentEventAt = now + i * 15_000 - 1_000;
			await fixture.daemon.sweepStallRecovery(now + i * 15_000);
		}
		expect(child.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();

		// True silence still acts: events stop, the measured silence crosses the
		// threshold, the wait window (0 here) is spent.
		const stillAt = now + 11 * 15_000;
		child.runtime.session.lastAgentEventAt = stillAt - 301_000;
		await fixture.daemon.sweepStallRecovery(stillAt);
		expect(child.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(1);
		// A: the notice and the marker report the measured action-time silence,
		// not the warn-time snapshot (312s) the marker still carries.
		const [notice] = child.runtime.session.sendCustomMessage.mock.calls[0]!;
		expect(notice.details).toMatchObject({ silentMs: 301_000 });
		expect(child.stallRecovery).toMatchObject({ silentMs: 301_000 });
	});

	it("P6 (blind-3): a healthy turn running a legal long bash is never acted on", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
			settings: { childGraceSeconds: 0 },
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		child.runtime.session.stallState = stallMarker();
		child.runtime.session.isBashRunning = true;
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now);
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		// Deep past every window: the liveness fact owns the silence, no action.
		await fixture.daemon.sweepStallRecovery(now + 3_000_000);
		expect(child.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
		expect(child.runtime.session.sendCustomMessage).not.toHaveBeenCalled();
	});

	it("P7 (blind-3): a depth-0 session in a provider retry is never acted on", async () => {
		const root = makeSessionDouble({ activeSessionId: "root-active", clients: 0 });
		const fixture = makeFixture([root]);
		root.runtime.session.stallState = stallMarker();
		root.runtime.session.isRetrying = true;
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now);
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		await fixture.daemon.sweepStallRecovery(now + 3_000_000);
		expect(root.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
		expect(root.runtime.session.sendCustomMessage).not.toHaveBeenCalled();
	});

	it("B (blind-3 finding 2): a slow admission cannot stack executors - three ticks, one action", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
			settings: { childGraceSeconds: 0 },
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		child.runtime.session.stallState = stallMarker();
		const now = 1_000_000;
		// A controlled admission that stays pending across three sweep ticks.
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		child.runtime.session.sendCustomMessage.mockImplementation(() => pending);

		await fixture.daemon.sweepStallRecovery(now); // first sighting
		await fixture.daemon.sweepStallRecovery(now + 15_000); // claim + launch; admission pends
		await fixture.daemon.sweepStallRecovery(now + 30_000); // tick 2 while pending
		await fixture.daemon.sweepStallRecovery(now + 45_000); // tick 3 while pending
		expect(child.runtime.session.sendCustomMessage).toHaveBeenCalledTimes(1);
		expect(child.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
		expect(child.stallRecovery).toBeUndefined();

		release();
		await vi.waitFor(() => {
			expect(child.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(1);
		});
		// One action, one stop-line count, one receipt - not three.
		expect(child.stallRecovery).toMatchObject({ count: 1 });
		expect(parent.runtime.session.sendCustomMessage).toHaveBeenCalledTimes(1);
	});

	it("C (blind-3 finding 4): a queued agent message does not disarm the episode", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
			settings: { childGraceSeconds: 0 },
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		child.runtime.session.stallState = stallMarker();
		const now = 1_000_000;
		await fixture.daemon.sweepStallRecovery(now); // first sighting: the episode exists

		// The parent nudges the wedged child; the message queues behind the wedged
		// turn (the target never read it).
		child.runtime.session.acceptAgentMessagePrompt.mockImplementation(
			async (
				_content: unknown,
				options: { preflightResult?: (didSucceed: boolean, didQueue?: boolean) => void },
			) => {
				options.preflightResult?.(true, true);
			},
		);
		const receipt = await fixture.daemon.acceptAgentSessionMessage(child, nudgePayload("child-active"));
		expect(receipt.status).toBe("queued");
		// The nudge did not mark kept-alive: the sweep still acts, and its action
		// is what delivers the queued nudge in the first place.
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		expect(child.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(1);
	});

	it("C: an agent message that was actually delivered marks the episode kept-alive", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
			settings: { childGraceSeconds: 0 },
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		child.runtime.session.stallState = stallMarker();
		const now = 1_000_000;
		await fixture.daemon.sweepStallRecovery(now); // first sighting: the episode exists

		// The target read the message: delivery, not queueing.
		child.runtime.session.acceptAgentMessagePrompt.mockImplementation(
			async (
				_content: unknown,
				options: { preflightResult?: (didSucceed: boolean, didQueue?: boolean) => void },
			) => {
				options.preflightResult?.(true, false);
			},
		);
		const receipt = await fixture.daemon.acceptAgentSessionMessage(child, nudgePayload("child-active"));
		expect(receipt.status).toBe("delivered");
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		await fixture.daemon.sweepStallRecovery(now + 3_000_000);
		expect(child.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
	});

	it("C (blind-1 F1): every user-source command marks external input at case entry", async () => {
		const commands: Array<{
			name: string;
			build: (activeSessionId: string) => Record<string, unknown>;
			driven: (session: DaemonDoubleSession) => ReturnType<typeof vi.fn>;
		}> = [
			{
				name: "prompt",
				build: (id) => ({ type: "prompt", activeSessionId: id, message: "keep going" }),
				driven: (session) => session.promptUntilAccepted,
			},
			{
				name: "prompt_and_wait",
				build: (id) => ({ type: "prompt_and_wait", activeSessionId: id, message: "keep going" }),
				driven: (session) => session.promptAndWait,
			},
			{
				name: "steer",
				build: (id) => ({ type: "steer", activeSessionId: id, message: "try another approach" }),
				driven: (session) => session.steer,
			},
			{
				name: "follow_up",
				build: (id) => ({ type: "follow_up", activeSessionId: id, message: "queued follow-up" }),
				driven: (session) => session.followUp,
			},
			{
				name: "resume_queue",
				build: (id) => ({ type: "resume_queue", activeSessionId: id }),
				driven: (session) => session.resumeQueuedWorkFromConnection,
			},
			{
				name: "abort",
				build: (id) => ({ type: "abort", activeSessionId: id }),
				driven: (session) => session.requestAbort,
			},
			{
				name: "abort_and_send_queued",
				build: (id) => ({ type: "abort_and_send_queued", activeSessionId: id }),
				driven: (session) => session.abortAndSendQueued,
			},
		];
		// Guard the data-driven loop: an empty list would pass without asserting.
		expect(commands.length).toBeGreaterThan(0);
		const now = 1_000_000;
		for (const command of commands) {
			const child = makeSessionDouble({
				activeSessionId: "child-active",
				metadata: childMetadata("parent-active", "child-1"),
				settings: { childGraceSeconds: 0 },
			});
			const parent = makeSessionDouble({ activeSessionId: "parent-active" });
			const fixture = makeFixture([child, parent]);
			child.runtime.session.stallState = stallMarker();
			await fixture.daemon.sweepStallRecovery(now); // first sighting: the episode exists
			// The real command surface, not a direct private call.
			await fixture.daemon.handleCommand(makeClient(), command.build("child-active"));
			// Positive control: the command really drove the session.
			expect(command.driven(child.runtime.session), command.name).toHaveBeenCalled();
			// The abort_and_send_queued command itself calls the abort lever: clear
			// it so the remaining assertion sees only what the sweep would do.
			if (command.name === "abort_and_send_queued") child.runtime.session.abortAndSendQueued.mockClear();
			await fixture.daemon.sweepStallRecovery(now + 15_000);
			await fixture.daemon.sweepStallRecovery(now + 30_000);
			// External input marked the episode kept-alive: never auto-acted.
			expect(child.runtime.session.abortAndSendQueued, command.name).not.toHaveBeenCalled();
		}
	});

	it("C: a user steer inside the human window keeps a depth-0 episode alive - never auto-acted", async () => {
		const root = makeSessionDouble({ activeSessionId: "root-active", clients: 1 });
		const fixture = makeFixture([root]);
		root.runtime.session.stallState = stallMarker();
		const now = 1_000_000;
		await fixture.daemon.sweepStallRecovery(now); // first sighting: the episode exists

		await fixture.daemon.handleCommand(makeClient(), {
			type: "steer",
			activeSessionId: "root-active",
			message: "try a different approach",
		});
		expect(root.runtime.session.steer).toHaveBeenCalledTimes(1);
		// Past the 120s human window and far beyond: a human-driven episode is
		// never auto-acted.
		await fixture.daemon.sweepStallRecovery(now + 121_000);
		await fixture.daemon.sweepStallRecovery(now + 3_000_000);
		expect(root.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
	});

	it("C: an abort command resets the stop-line count", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
			settings: { childGraceSeconds: 0 },
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		const now = 1_000_000;
		// Three stall episodes, each a fresh epoch, all without external input.
		for (let episode = 0; episode < 3; episode++) {
			child.runtime.session.stallState = stallMarker();
			child.runtime.session.turnLifecycleEpoch = 7 + episode;
			await fixture.daemon.sweepStallRecovery(now + episode * 100_000);
			await fixture.daemon.sweepStallRecovery(now + episode * 100_000 + 15_000);
		}
		expect(child.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(3);
		// The fourth episode hits the stop line: notify only.
		child.runtime.session.stallState = stallMarker();
		child.runtime.session.turnLifecycleEpoch = 10;
		await fixture.daemon.sweepStallRecovery(now + 400_000);
		await fixture.daemon.sweepStallRecovery(now + 415_000);
		expect(child.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(3);
		// The user aborts: the count resets, so the mechanism is re-armed.
		await fixture.daemon.handleCommand(makeClient(), { type: "abort", activeSessionId: "child-active" });
		expect(child.runtime.session.requestAbort).toHaveBeenCalledTimes(1);
		child.runtime.session.stallState = stallMarker();
		child.runtime.session.turnLifecycleEpoch = 11;
		await fixture.daemon.sweepStallRecovery(now + 500_000);
		await fixture.daemon.sweepStallRecovery(now + 515_000);
		expect(child.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(4);
	});

	it("stop line 0: an explicit maxPerSession of 0 means notify-only, zero actions", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
			settings: { childGraceSeconds: 0, maxPerSession: 0 },
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		child.runtime.session.stallState = stallMarker();
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now);
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		expect(child.runtime.session.abortAndSendQueued).not.toHaveBeenCalled();
		expect(child.runtime.session.sendCustomMessage).not.toHaveBeenCalled();
		const stopLine = fixture.daemon.log.mock.calls.find((call) => String(call[0]).includes("stop line reached"));
		expect(stopLine).toBeDefined();
		expect(String(stopLine?.[0])).toContain("(limit 0)");
	});

	it("G (blind-3 finding 9): the escalation is reachable with the injected clock alone", async () => {
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
		// No Date.now mock anywhere: the only clock is the injected sweep `now`.
		// (Pre-fix, actedAt came from the real clock and now - actedAt was a huge
		// negative, so this escalation could never fire under a test clock.)

		await fixture.daemon.sweepStallRecovery(now);
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		expect(parent.runtime.session.sendCustomMessage).toHaveBeenCalledTimes(1);
		await fixture.daemon.sweepStallRecovery(now + 15_000 + 15 * 60_000 + 1_000);
		expect(parent.runtime.session.sendCustomMessage).toHaveBeenCalledTimes(2);
		const [escalation] = parent.runtime.session.sendCustomMessage.mock.calls[1]!;
		expect(escalation.details).toMatchObject({
			escalated: true,
			// G (blind-3 finding 10): the policy window and the measured gap are
			// separate fields now.
			escalateAfterMs: 15 * 60_000,
			silentSinceActionMs: 15 * 60_000 + 1_000,
		});
		expect(escalation.content).toContain("still silent 901s after the automatic stall-recovery action");
	});

	it("G (blind-3 finding 5): the escalation receipt reports the action that actually ran", async () => {
		const child = makeSessionDouble({
			activeSessionId: "child-active",
			metadata: childMetadata("parent-active", "child-1"),
			settings: { childGraceSeconds: 0 },
		});
		const parent = makeSessionDouble({ activeSessionId: "parent-active" });
		const fixture = makeFixture([child, parent]);
		child.runtime.session.stallState = stallMarker();
		// The queue cannot deliver: the action degrades to a plain abort.
		child.runtime.session.abortAndSendQueued.mockImplementation(() => false);
		child.runtime.session.resumeQueuedWork.mockImplementation(() => false);
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now);
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		const [receipt] = parent.runtime.session.sendCustomMessage.mock.calls[0]!;
		expect(receipt.details).toMatchObject({ action: "abort" });
		await fixture.daemon.sweepStallRecovery(now + 15_000 + 15 * 60_000 + 1_000);
		const [escalation] = parent.runtime.session.sendCustomMessage.mock.calls[1]!;
		// The escalation variant reports the same truth (pre-fix: hardcoded
		// "abort_and_send", which lied about the degrade).
		expect(escalation.details).toMatchObject({ action: "abort", escalated: true });
		expect(escalation.content).toContain("action: abort");
	});

	it("F2 (blind-1): a depth-0 escalation lands in the session's own transcript once the turn has ended", async () => {
		const root = makeSessionDouble({ activeSessionId: "root-active", clients: 0 });
		const fixture = makeFixture([root]);
		root.runtime.session.stallState = stallMarker();
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now);
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		expect(root.runtime.session.abortAndSendQueued).toHaveBeenCalledTimes(1);
		// Call 1 was the action's own system instruction; the escalation is call 2.
		const [interruption] = root.runtime.session.sendCustomMessage.mock.calls[0]!;
		expect(interruption.customType).toBe(SYSTEM_INTERRUPTION_CUSTOM_TYPE);
		// The abort degrade: the turn ended, nothing restarted, the marker stayed.
		root.runtime.session.isStreaming = false;
		await fixture.daemon.sweepStallRecovery(now + 15_000 + 15 * 60_000 + 1_000);
		expect(root.runtime.session.sendCustomMessage).toHaveBeenCalledTimes(2);
		const [notice] = root.runtime.session.sendCustomMessage.mock.calls[1]!;
		expect(notice.customType).toBe(STALL_RECOVERY_ESCALATION_CUSTOM_TYPE);
		expect(notice.details).toMatchObject({
			executor: "daemon",
			actedAt: now + 15_000,
			silentSinceActionMs: 15 * 60_000 + 1_000,
			action: "abort_and_send",
			count: 1,
		});
		expect(notice.content).toContain("still silent 15m after the automatic stall-recovery action");
		expect(notice.content).toContain("prime-agent attach name-root-active");
		// One-shot: a later sweep does not repeat the notice.
		await fixture.daemon.sweepStallRecovery(now + 40 * 60_000);
		expect(root.runtime.session.sendCustomMessage).toHaveBeenCalledTimes(2);
	});

	it("F2: a depth-0 escalation never lands while a turn is still streaming, and is not lost when it ends", async () => {
		const root = makeSessionDouble({ activeSessionId: "root-active", clients: 0 });
		const fixture = makeFixture([root]);
		root.runtime.session.stallState = stallMarker();
		const now = 1_000_000;

		await fixture.daemon.sweepStallRecovery(now);
		await fixture.daemon.sweepStallRecovery(now + 15_000);
		// Call 1 is the action's own system instruction; nothing else may land.
		expect(root.runtime.session.sendCustomMessage).toHaveBeenCalledTimes(1);
		// The abort did not settle: the run is still "streaming" 15 minutes later.
		await fixture.daemon.sweepStallRecovery(now + 15_000 + 15 * 60_000 + 1_000);
		expect(root.runtime.session.sendCustomMessage).toHaveBeenCalledTimes(1);
		// The stream finally ends: the deferred notice goes out on a later tick
		// (the one-shot was not burned by the streaming deferral).
		root.runtime.session.isStreaming = false;
		await fixture.daemon.sweepStallRecovery(now + 15_000 + 16 * 60_000);
		expect(root.runtime.session.sendCustomMessage).toHaveBeenCalledTimes(2);
		const [notice] = root.runtime.session.sendCustomMessage.mock.calls[1]!;
		expect(notice.customType).toBe(STALL_RECOVERY_ESCALATION_CUSTOM_TYPE);
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
