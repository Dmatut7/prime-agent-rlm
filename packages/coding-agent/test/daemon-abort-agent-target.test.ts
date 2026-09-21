import { describe, expect, it, vi } from "vitest";
import {
	type AgentFamilyCatalogEntry,
	assertDirectAgentMessageTarget,
	createAgentMessageHostHandlers,
} from "../src/core/agent-messages.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { DaemonCapabilityUnavailableError, type DaemonHello } from "../src/modes/daemon/daemon-client.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_SCHEMA_REVISION,
	type DaemonCommand,
	type DaemonCommandCompatibility,
	type DaemonServerCapability,
	getDaemonCommandCompatibilities,
	meetsDaemonCommandCompatibility,
	missingDeclaredCommandCapability,
	success,
} from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

const AGENT_ORIGIN_REQUIREMENT: DaemonCommandCompatibility = {
	minProtocol: 7,
	minSchemaRevision: 39,
	capability: "abort_agent_target",
};

/** A rev-38 peer: every capability except the new one, and the old revision. */
const rev38Hello: DaemonHello = {
	type: "daemon_hello",
	socketPath: "/tmp/rev38.sock",
	protocol: { name: "prime-agent.daemon", version: 7 },
	schemaRevision: 38,
	clientId: "client-1",
	serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES.filter(
		(capability) => capability !== "abort_agent_target",
	) as readonly DaemonServerCapability[],
};

const rev39Hello: DaemonHello = {
	...rev38Hello,
	schemaRevision: 39,
	serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES,
};

const plainAbort: DaemonCommand = { type: "abort", activeSessionId: "active-1" };
const plainAbortAndSend: DaemonCommand = { type: "abort_and_send_queued", activeSessionId: "active-1" };
const agentAbort: DaemonCommand = {
	type: "abort_and_send_queued",
	activeSessionId: "active-1",
	fromActiveSessionId: "active-2",
};

describe("agent abort protocol gates", () => {
	it("keeps the bare abort commands exactly as compatible as before (old clients unaffected)", () => {
		for (const command of [plainAbort, plainAbortAndSend]) {
			expect(getDaemonCommandCompatibilities(command)).toEqual([DAEMON_COMMAND_COMPATIBILITY[command.type]]);
			// A rev-38 peer already serves both bare commands; a new daemon serves them too.
			expect(
				getDaemonCommandCompatibilities(command).every((compatibility) =>
					meetsDaemonCommandCompatibility(rev38Hello, compatibility),
				),
			).toBe(true);
			expect(
				getDaemonCommandCompatibilities(command).every((compatibility) =>
					meetsDaemonCommandCompatibility(rev39Hello, compatibility),
				),
			).toBe(true);
		}
		// The bare shapes carry no agent-origin field at all.
		expect(plainAbort).not.toHaveProperty("fromActiveSessionId");
		expect(plainAbortAndSend).not.toHaveProperty("fromActiveSessionId");
	});

	it("gates the agent-origin shape behind abort_agent_target at schema revision 39", () => {
		expect(getDaemonCommandCompatibilities(agentAbort)).toEqual([
			AGENT_ORIGIN_REQUIREMENT,
			DAEMON_COMMAND_COMPATIBILITY.abort_and_send_queued,
		]);
		expect(getDaemonCommandCompatibilities({ ...plainAbort, fromActiveSessionId: "active-2" })).toEqual([
			AGENT_ORIGIN_REQUIREMENT,
			DAEMON_COMMAND_COMPATIBILITY.abort,
		]);
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("abort_agent_target");
		expect(DAEMON_SCHEMA_REVISION).toBeGreaterThanOrEqual(39);
	});

	it("refuses a new client against an old daemon and admits it against a new one", () => {
		// The rejection path a new client hits when the daemon predates the lever.
		expect(meetsDaemonCommandCompatibility(rev38Hello, AGENT_ORIGIN_REQUIREMENT)).toBe(false);
		expect(meetsDaemonCommandCompatibility(rev39Hello, AGENT_ORIGIN_REQUIREMENT)).toBe(true);
	});

	it("enforces the declared-capability gate for agent-origin aborts only", () => {
		const declared = new Set<string>(["abort_and_send_queued"]) as Set<DaemonServerCapability>;
		expect(missingDeclaredCommandCapability(true, declared, plainAbortAndSend)).toBeUndefined();
		expect(missingDeclaredCommandCapability(true, declared, agentAbort)).toBe("abort_agent_target");
		const withAbort = new Set<string>(["abort_and_send_queued", "abort_agent_target"]) as Set<DaemonServerCapability>;
		expect(missingDeclaredCommandCapability(true, withAbort, agentAbort)).toBeUndefined();
		// Undeclared (legacy) connections keep the old path.
		expect(missingDeclaredCommandCapability(undefined, undefined, agentAbort)).toBeUndefined();
	});
});

// --- daemon-mode: origin reach gate and the controller lever ---

interface AbortFixture {
	daemon: Record<string, unknown>;
	sessions: Map<string, ActiveSessionState>;
	parent: ActiveSessionState;
	child: ActiveSessionState;
	childAbortAndSendQueued: ReturnType<typeof vi.fn>;
	childRequestAbort: ReturnType<typeof vi.fn>;
	linkRequest: ReturnType<typeof vi.fn>;
}

function makeSession(options: {
	activeSessionId: string;
	sessionId: string;
	sessionName: string;
	sessionFile?: string;
	depth: number;
	metadata?: Record<string, unknown>;
	abortAndSendQueued?: () => boolean;
	requestAbort?: () => void;
}): ActiveSessionState {
	return {
		activeSessionId: options.activeSessionId,
		clients: new Set(),
		extensionUiRequests: new Map(),
		lastEventSequence: 0,
		eventGeneration: "gen-1",
		runtime: {
			dispose: async () => {},
			metadata: { kind: options.depth > 0 ? "subagent" : "top-level", createdAt: 1, ...options.metadata },
			diagnostics: [],
			session: {
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				sessionFile: options.sessionFile,
				sessionId: options.sessionId,
				rlmDepth: options.depth,
				sessionName: options.sessionName,
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
				sendCustomMessage: vi.fn(async () => {}),
				abortAndSendQueued: options.abortAndSendQueued ?? (() => false),
				requestAbort: options.requestAbort ?? (() => {}),
			},
		},
	} as unknown as ActiveSessionState;
}

function makeAbortFixture(worker?: object): AbortFixture {
	const childAbortAndSendQueued = vi.fn(() => true);
	const childRequestAbort = vi.fn();
	const parent = makeSession({
		activeSessionId: "parent-active",
		sessionId: "parent-session",
		sessionName: "orchestrator",
		sessionFile: "/tmp/parent.jsonl",
		depth: 0,
	});
	const child = makeSession({
		activeSessionId: "child-active",
		sessionId: "child-session",
		sessionName: "wedged-worker",
		sessionFile: "/tmp/child.jsonl",
		depth: 1,
		metadata: {
			rlmChildId: "child-1",
			parentActiveSessionId: "parent-active",
			parentSessionId: "parent-session",
			parentSessionFile: "/tmp/parent.jsonl",
		},
		abortAndSendQueued: childAbortAndSendQueued,
		requestAbort: childRequestAbort,
	});
	const sessions = new Map<string, ActiveSessionState>([
		["parent-active", parent],
		["child-active", child],
	]);
	const linkRequest = vi.fn(async () => success(undefined, "abort_and_send_queued"));
	const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
		options: worker ? { worker } : {},
		sessions,
		childStallNoticeAt: new Map<string, number>(),
		shuttingDown: false,
		log: vi.fn(),
		supervisorLink: () => ({ request: linkRequest, ensureConnected: async () => {} }),
		getBoundSessionState: (selector: string) => {
			const state = sessions.get(selector);
			if (!state) throw new Error(`Unknown active session: ${selector}`);
			return state;
		},
	}) as unknown as Record<string, unknown>;
	return { daemon, sessions, parent, child, childAbortAndSendQueued, childRequestAbort, linkRequest };
}

type AbortDaemonDouble = {
	assertAgentOriginAbortReach(fromActiveSessionId: string | undefined, targetState: ActiveSessionState): void;
	abortAgentSessionMessage(options: {
		targetSelector: string;
		sendQueued: boolean;
		fromState: ActiveSessionState;
	}): Promise<{
		target: { activeSessionId: string; sessionId: string; sessionName?: string; runtimeKind?: string };
		sendQueued: boolean;
		resumedQueued?: boolean;
	}>;
};

describe("daemon-mode agent abort", () => {
	it("passes agent-origin reach for a local sender inside the family and blocks outsiders", () => {
		const { daemon, parent, child, sessions } = makeAbortFixture();
		const daemonDouble = daemon as unknown as AbortDaemonDouble;

		// No origin marker: the pre-existing client path is untouched.
		expect(() => daemonDouble.assertAgentOriginAbortReach(undefined, child)).not.toThrow();
		// The parent may abort its own child.
		expect(() => daemonDouble.assertAgentOriginAbortReach("parent-active", child)).not.toThrow();
		// Self-targeting is refused outright.
		expect(() => daemonDouble.assertAgentOriginAbortReach("child-active", child)).toThrow(
			"Agent abort cannot target the sending session",
		);
		// A local session outside the child's family is refused.
		const stranger = makeSession({
			activeSessionId: "stranger-active",
			sessionId: "stranger-session",
			sessionName: "stranger",
			depth: 0,
		});
		sessions.set("stranger-active", stranger);
		expect(() => daemonDouble.assertAgentOriginAbortReach("stranger-active", child)).toThrow(
			"Agent reach is limited to parent, siblings, and children",
		);
		// A cross-worker sender is not resolvable here; the supervisor gated it.
		expect(() => daemonDouble.assertAgentOriginAbortReach("remote-active", child)).not.toThrow();
		expect(parent).toBeDefined();
	});

	it("aborts a family child locally and reports whether the queued batch resumed", async () => {
		const { daemon, parent, childAbortAndSendQueued, childRequestAbort } = makeAbortFixture();
		const daemonDouble = daemon as unknown as AbortDaemonDouble;

		const receipt = await daemonDouble.abortAgentSessionMessage({
			targetSelector: "child-active",
			sendQueued: true,
			fromState: parent,
		});
		expect(childAbortAndSendQueued).toHaveBeenCalledTimes(1);
		expect(childRequestAbort).not.toHaveBeenCalled();
		expect(receipt).toMatchObject({
			target: { activeSessionId: "child-active", sessionId: "child-session", sessionName: "wedged-worker" },
			sendQueued: true,
			resumedQueued: true,
		});

		const plain = await daemonDouble.abortAgentSessionMessage({
			targetSelector: "child-active",
			sendQueued: false,
			fromState: parent,
		});
		expect(childRequestAbort).toHaveBeenCalledTimes(1);
		expect(plain.resumedQueued).toBeUndefined();
		expect(plain.sendQueued).toBe(false);
	});

	it("refuses to abort the sending session or a local non-family target", async () => {
		const { daemon, parent, sessions } = makeAbortFixture();
		const daemonDouble = daemon as unknown as AbortDaemonDouble;

		await expect(
			daemonDouble.abortAgentSessionMessage({
				targetSelector: "parent-active",
				sendQueued: true,
				fromState: parent,
			}),
		).rejects.toThrow("Agent abort cannot target the sending session");

		const strangerChild = makeSession({
			activeSessionId: "stranger-active",
			sessionId: "stranger-session",
			sessionName: "stranger",
			depth: 1,
			metadata: { parentSessionId: "unrelated-parent-session", parentSessionFile: "/tmp/unrelated.jsonl" },
		});
		sessions.set("stranger-active", strangerChild);
		await expect(
			daemonDouble.abortAgentSessionMessage({
				targetSelector: "stranger-active",
				sendQueued: true,
				fromState: parent,
			}),
		).rejects.toThrow("Agent reach is limited to parent, siblings, and children");
	});

	it("forwards an unresolvable target to the supervisor with the agent-origin marker", async () => {
		const { daemon, parent, linkRequest } = makeAbortFixture({ authenticationToken: "token" });
		const daemonDouble = daemon as unknown as AbortDaemonDouble;

		const receipt = await daemonDouble.abortAgentSessionMessage({
			targetSelector: "remote-target",
			sendQueued: true,
			fromState: parent,
		});
		expect(linkRequest).toHaveBeenCalledTimes(1);
		expect(linkRequest).toHaveBeenCalledWith(
			{
				type: "abort_and_send_queued",
				activeSessionId: "remote-target",
				fromActiveSessionId: "parent-active",
			},
			30_000,
		);
		expect(receipt).toMatchObject({ target: { activeSessionId: "remote-target" }, sendQueued: true });

		await daemonDouble.abortAgentSessionMessage({
			targetSelector: "remote-target",
			sendQueued: false,
			fromState: parent,
		});
		expect(linkRequest).toHaveBeenLastCalledWith(
			{
				type: "abort",
				activeSessionId: "remote-target",
				fromActiveSessionId: "parent-active",
			},
			30_000,
		);
	});

	it("degrades loudly when the daemon is too old to serve agent aborts", async () => {
		const linkRequest = vi.fn(async () => {
			throw new DaemonCapabilityUnavailableError("abort_and_send_queued", "abort_agent_target");
		});
		const parent = makeSession({
			activeSessionId: "parent-active",
			sessionId: "parent-session",
			sessionName: "orchestrator",
			depth: 0,
		});
		const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
			options: { worker: { authenticationToken: "token" } },
			sessions: new Map<string, ActiveSessionState>([["parent-active", parent]]),
			shuttingDown: false,
			log: vi.fn(),
			supervisorLink: () => ({ request: linkRequest, ensureConnected: async () => {} }),
			getBoundSessionState: () => {
				throw new Error("Unknown active session: remote-target");
			},
		}) as unknown as AbortDaemonDouble;

		await expect(
			daemon.abortAgentSessionMessage({
				targetSelector: "remote-target",
				sendQueued: true,
				fromState: parent,
			}),
		).rejects.toThrow(/not supported by the connected daemon.*abort_agent_target/);
		expect(linkRequest).toHaveBeenCalledTimes(1);
	});
});

// --- supervisor: agent-origin abort routing ---

interface SupervisorFixture {
	supervisor: {
		routeAgentOriginAbort(
			client: unknown,
			command: Extract<DaemonCommand, { type: "abort" | "abort_and_send_queued" }> & {
				fromActiveSessionId: string;
			},
		): Promise<unknown>;
	};
	forwarded: Array<{ worker: string; command: DaemonCommand }>;
}

function entry(summary: {
	sessionId: string;
	name: string;
	depth: number;
	parentSessionId?: string;
	sessionPath?: string;
}): AgentFamilyCatalogEntry {
	return {
		id: summary.sessionId,
		name: summary.name,
		depth: summary.depth,
		status: "running",
		...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
		...(summary.sessionPath ? { sessionPath: summary.sessionPath } : {}),
	};
}

function makeSupervisorFixture(
	source: { workerId: string; activeSessionId: string; entry: AgentFamilyCatalogEntry },
	target: { workerId: string; activeSessionId: string; entry: AgentFamilyCatalogEntry },
): SupervisorFixture {
	const forwarded: Array<{ worker: string; command: DaemonCommand }> = [];
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		findWorkerForClient: vi.fn(async (_client: unknown, selector: string) =>
			selector === source.activeSessionId
				? {
						worker: { workerId: source.workerId },
						summary: {
							activeSessionId: source.activeSessionId,
							sessionId: source.entry.id,
							sessionName: source.entry.name,
							rlmDepth: source.entry.depth,
							parentSessionId: source.entry.parentSessionId,
							sessionFile: source.entry.sessionPath,
						},
					}
				: {
						worker: { workerId: target.workerId },
						summary: {
							activeSessionId: target.activeSessionId,
							sessionId: target.entry.id,
							sessionName: target.entry.name,
							rlmDepth: target.entry.depth,
							parentSessionId: target.entry.parentSessionId,
							sessionFile: target.entry.sessionPath,
						},
					},
		),
		familyCatalogEntry: (summary: {
			sessionId: string;
			sessionName: string;
			rlmDepth: number;
			parentSessionId?: string;
			sessionFile?: string;
		}) =>
			entry({
				sessionId: summary.sessionId,
				name: summary.sessionName,
				depth: summary.rlmDepth,
				parentSessionId: summary.parentSessionId,
				sessionPath: summary.sessionFile,
			}),
		forwardToWorker: vi.fn(async (worker: { workerId: string }, command: DaemonCommand) => {
			forwarded.push({ worker: worker.workerId, command });
			return success(undefined, command.type);
		}),
	}) as unknown as SupervisorFixture["supervisor"];
	return { supervisor, forwarded };
}

describe("supervisor agent-origin abort routing", () => {
	it("proves family reach and forwards to the target worker with the resolved session", async () => {
		const { supervisor, forwarded } = makeSupervisorFixture(
			{
				workerId: "worker-a",
				activeSessionId: "source-active",
				entry: entry({ sessionId: "source-session", name: "sender", depth: 0, sessionPath: "/tmp/a.jsonl" }),
			},
			{
				workerId: "worker-b",
				activeSessionId: "target-active",
				entry: entry({ sessionId: "target-session", name: "child", depth: 1, parentSessionId: "source-session" }),
			},
		);

		const response = await supervisor.routeAgentOriginAbort(
			{ id: "client" },
			{
				type: "abort_and_send_queued",
				activeSessionId: "target-active",
				fromActiveSessionId: "source-active",
			},
		);
		expect(response).toMatchObject({ success: true });
		expect(forwarded).toHaveLength(1);
		expect(forwarded[0]?.worker).toBe("worker-b");
		expect(forwarded[0]?.command).toMatchObject({
			type: "abort_and_send_queued",
			activeSessionId: "target-active",
			fromActiveSessionId: "source-active",
		});
	});

	it("refuses self-targets and non-family targets instead of forwarding", async () => {
		// Both selectors resolve to the same live session: the sender naming itself.
		const sameSummary = {
			activeSessionId: "source-active",
			sessionId: "source-session",
			sessionName: "sender",
			rlmDepth: 0,
			sessionFile: "/tmp/a.jsonl",
		};
		const selfTargetSupervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			findWorkerForClient: vi.fn(async () => ({ worker: { workerId: "worker-a" }, summary: sameSummary })),
			familyCatalogEntry: (summary: typeof sameSummary) =>
				entry({
					sessionId: summary.sessionId,
					name: summary.sessionName,
					depth: summary.rlmDepth,
					sessionPath: summary.sessionFile,
				}),
			forwardToWorker: vi.fn(async () => success(undefined, "abort")),
		}) as unknown as SupervisorFixture["supervisor"];
		await expect(
			selfTargetSupervisor.routeAgentOriginAbort(
				{ id: "client" },
				{
					type: "abort",
					activeSessionId: "source-active",
					fromActiveSessionId: "source-active",
				},
			),
		).rejects.toThrow("Agent abort cannot target the sending session");

		const unrelated = makeSupervisorFixture(
			{
				workerId: "worker-a",
				activeSessionId: "source-active",
				entry: entry({ sessionId: "source-session", name: "sender", depth: 0, sessionPath: "/tmp/a.jsonl" }),
			},
			{
				workerId: "worker-b",
				activeSessionId: "target-active",
				entry: entry({
					sessionId: "target-session",
					name: "stranger-child",
					depth: 1,
					parentSessionId: "unrelated-parent",
				}),
			},
		);
		await expect(
			unrelated.supervisor.routeAgentOriginAbort(
				{ id: "client" },
				{
					type: "abort",
					activeSessionId: "target-active",
					fromActiveSessionId: "source-active",
				},
			),
		).rejects.toThrow("Agent reach is limited to parent, siblings, and children");
		expect(unrelated.forwarded).toHaveLength(0);
	});
});

// --- kernel host handler ---

describe("agent_message.abort host handler", () => {
	function handlers(controller: Record<string, unknown>) {
		return createAgentMessageHostHandlers(controller as never);
	}

	const family = [
		{ relationship: "parent", entry: { id: "parent-id", name: "orchestrator", depth: 0, status: "running" } },
		{ relationship: "child", entry: { id: "child-id", name: "wedged-worker", depth: 1, status: "running" } },
		{ relationship: "sibling", entry: { id: "sibling-id", name: "peer", depth: 1, status: "idle" } },
	] as const;

	it("resolves the receiver by role and name and forwards send_queued", async () => {
		const abort = vi.fn(async () => ({
			target: { activeSessionId: "child-id" },
			sendQueued: true,
			resumedQueued: true,
		}));
		const handler = handlers({
			roster: async () => ({ current: { name: "x", id: "x", depth: 0 }, entries: [] }),
			sendAgentMessage: vi.fn(),
			abortAgentMessage: abort,
			family: async () => [...family],
		})["agent_message.abort"];

		const receipt = await handler({ receiver_role: "child", receiver_name: "wedged-worker" }, undefined);
		expect(abort).toHaveBeenCalledWith({ target: "child-id", sendQueued: true });
		expect(receipt).toMatchObject({ sendQueued: true, resumedQueued: true });

		await handler({ receiver_role: "child", receiver_name: "wedged-worker", send_queued: false }, undefined);
		expect(abort).toHaveBeenLastCalledWith({ target: "child-id", sendQueued: false });
	});

	it("resolves the unique parent without a name", async () => {
		const abort = vi.fn(async () => ({ target: { activeSessionId: "parent-id" }, sendQueued: true }));
		const handler = handlers({
			roster: async () => ({ current: { name: "x", id: "x", depth: 0 }, entries: [] }),
			sendAgentMessage: vi.fn(),
			abortAgentMessage: abort,
			family: async () => [...family],
		})["agent_message.abort"];
		await handler({ receiver_role: "parent" }, undefined);
		expect(abort).toHaveBeenCalledWith({ target: "parent-id", sendQueued: true });
	});

	it("rejects malformed payloads the way send does, plus a raw target", async () => {
		const abort = vi.fn(async () => ({ target: { activeSessionId: "child-id" }, sendQueued: true }));
		const handler = handlers({
			roster: async () => ({ current: { name: "x", id: "x", depth: 0 }, entries: [] }),
			sendAgentMessage: vi.fn(),
			abortAgentMessage: abort,
			family: async () => [...family],
		})["agent_message.abort"];

		await expect(handler({ receiver_role: "nope" }, undefined)).rejects.toThrow(
			'agent_message.abort receiver_role must be "parent", "sibling", or "child"',
		);
		await expect(handler({ receiver_role: "sibling" }, undefined)).rejects.toThrow(
			"agent_message.abort receiver_name is required for sibling and child targets",
		);
		await expect(handler({ receiver_role: "parent", receiver_name: "named" }, undefined)).rejects.toThrow(
			"agent_message.abort receiver_name must be omitted for parent targets",
		);
		await expect(handler({ receiver_role: "child", receiver_name: "missing" }, undefined)).rejects.toThrow(
			"No child matches",
		);
		await expect(
			handler({ receiver_role: "child", receiver_name: "child-id", target: "all" }, undefined),
		).rejects.toThrow("does not accept a raw target");
		expect(abort).not.toHaveBeenCalled();
	});

	it("reports a clean unavailable error when the controller has no abort lever", async () => {
		const handler = handlers({
			roster: async () => ({ current: { name: "x", id: "x", depth: 0 }, entries: [] }),
			sendAgentMessage: vi.fn(),
			family: async () => [...family],
		})["agent_message.abort"];
		await expect(handler({ receiver_role: "child", receiver_name: "wedged-worker" }, undefined)).rejects.toThrow(
			"agent abort is not available in this session",
		);
	});

	it("validates the abort selector through the shared direct-target guard", () => {
		expect(() => assertDirectAgentMessageTarget("")).toThrow();
		expect(assertDirectAgentMessageTarget("wedged-worker")).toBe("wedged-worker");
	});
});
