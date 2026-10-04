import type { Socket } from "node:net";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { MODEL_CHANGE_ORIGIN_NOTICE_CUSTOM_TYPE } from "../src/core/agent-session.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand, DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";

/**
 * wave-42 SETMODEL-VIS (daemon half): a set_model/cycle_model command switches
 * the session model for every attached window, but only the initiating client
 * gets an answer - the others used to learn nothing until a lazy footer
 * refresh. The session emits a visible notice pair (message_start/message_end
 * with the model_change_origin_notice customType) stamped with a per-command
 * token; the daemon registers token -> initiator for the duration of the
 * command and skips that client when broadcasting the notice, so the
 * initiator keeps exactly its existing local feedback and every witness gets
 * the chat line.
 *
 * The session itself is mocked here (its emission half is covered by
 * test/suite/agent-session-model-change-origin-notice.test.ts); the segment
 * under test is the daemon's token registration and per-client broadcast
 * exemption, driven through the real handleCommand + broadcastToSession.
 */

const MODEL: Model<Api> = {
	provider: "faux",
	id: "faux-2",
	name: "Two",
	api: "openai-completions",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

function makeNoticeClient(id: string, activeSessionId: string): DaemonSocketClient {
	return {
		id,
		socket: { destroyed: false, writableLength: 0, write: vi.fn(() => true) } as unknown as Socket,
		attachedActiveSessionIds: new Set([activeSessionId]),
		detachInput: vi.fn(),
		supportsExtensionUi: false,
		capabilities: new Set(),
	};
}

function makeNoticeState(activeSessionId: string, clients: DaemonSocketClient[]): ActiveSessionState {
	return {
		activeSessionId,
		clients: new Set(clients),
		pendingAttaches: 0,
		lastEventSequence: 0,
		runtime: { metadata: { kind: "top-level", createdAt: 1 } },
	} as unknown as ActiveSessionState;
}

function noticeFramesFor(client: DaemonSocketClient): Array<Record<string, unknown>> {
	const write = client.socket.write as ReturnType<typeof vi.fn>;
	return write.mock.calls
		.map((call) => String(call[0]))
		.flatMap((line) => line.split("\n").filter((chunk) => chunk.length > 0))
		.map((chunk) => JSON.parse(chunk) as Record<string, unknown>)
		.filter((frame) => {
			if (frame.type !== "session_event") return false;
			const event = frame.event as { type?: string; message?: { customType?: string } };
			return (
				(event.type === "message_start" || event.type === "message_end") &&
				event.message?.customType === MODEL_CHANGE_ORIGIN_NOTICE_CUSTOM_TYPE
			);
		});
}

interface NoticeOptions {
	changeNotice?: { origin: string; token?: string };
}

/** The session half, faithfully replayed: emit the token-stamped notice pair through the real broadcast. */
function emitNoticeThrough(
	broadcast: (state: ActiveSessionState, message: DaemonOutbound) => void,
	state: ActiveSessionState,
	options: NoticeOptions | undefined,
): void {
	const message = {
		role: "custom" as const,
		customType: MODEL_CHANGE_ORIGIN_NOTICE_CUSTOM_TYPE,
		content: "模型已切换为「faux/faux-2」（由另一个窗口或客户端发起）。",
		display: true,
		details: {
			provider: "faux",
			modelId: "faux-2",
			origin: options?.changeNotice?.origin,
			token: options?.changeNotice?.token,
		},
		timestamp: Date.now(),
	};
	broadcast(state, {
		type: "session_event",
		activeSessionId: state.activeSessionId,
		event: { type: "message_start", message },
	});
	broadcast(state, {
		type: "session_event",
		activeSessionId: state.activeSessionId,
		event: { type: "message_end", message },
	});
}

function createDaemonInternals() {
	const daemon = new AgentDaemon("/tmp/prime-agent-test-model-notice.sock", {
		defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
		createRuntime: async () => {
			throw new Error("unexpected runtime creation");
		},
	});
	return daemon as unknown as {
		sessions: Map<string, ActiveSessionState>;
		handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonOutbound | undefined>;
		broadcastToSession(state: ActiveSessionState, message: DaemonOutbound): void;
	};
}

describe("daemon model-change origin notice", () => {
	it("broadcasts the set_model notice to witness clients but not the initiator", async () => {
		const internals = createDaemonInternals();
		const initiator = makeNoticeClient("client-a", "active-1");
		const witness = makeNoticeClient("client-b", "active-1");
		const state = makeNoticeState("active-1", [initiator, witness]);
		state.runtime = {
			...state.runtime,
			session: {
				modelRegistry: { refreshAvailableModels: vi.fn(async () => [MODEL]) },
				isStreaming: false,
				isCompacting: false,
				setModel: vi.fn(async (_model: unknown, options?: NoticeOptions) => {
					emitNoticeThrough((s, m) => internals.broadcastToSession(s, m), state, options);
				}),
			},
		} as never;
		internals.sessions.set(state.activeSessionId, state);

		const response = await internals.handleCommand(initiator, {
			id: "cmd-1",
			type: "set_model",
			activeSessionId: "active-1",
			provider: "faux",
			modelId: "faux-2",
		});

		expect(response).toMatchObject({ success: true });
		// The witness sees both halves of the chat notice...
		expect(noticeFramesFor(witness).map((frame) => (frame.event as { type: string }).type)).toEqual([
			"message_start",
			"message_end",
		]);
		// ...and the initiator gets neither (its own window already fed back locally).
		expect(noticeFramesFor(initiator)).toEqual([]);
	});

	it("exempts only the command window: a later identical broadcast reaches everyone again", async () => {
		const internals = createDaemonInternals();
		const initiator = makeNoticeClient("client-a", "active-1");
		const witness = makeNoticeClient("client-b", "active-1");
		const state = makeNoticeState("active-1", [initiator, witness]);
		state.runtime = {
			...state.runtime,
			session: {
				modelRegistry: { refreshAvailableModels: vi.fn(async () => [MODEL]) },
				isStreaming: false,
				isCompacting: false,
				setModel: vi.fn(async (_model: unknown, options?: NoticeOptions) => {
					emitNoticeThrough((s, m) => internals.broadcastToSession(s, m), state, options);
				}),
			},
		} as never;
		internals.sessions.set(state.activeSessionId, state);

		await internals.handleCommand(initiator, {
			id: "cmd-1",
			type: "set_model",
			activeSessionId: "active-1",
			provider: "faux",
			modelId: "faux-2",
		});
		expect(noticeFramesFor(initiator)).toEqual([]);

		// Token registration ends with the command: the same notice shape emitted
		// afterwards (say an extension-driven switch, which carries no token) is
		// broadcast to every attached client, initiator included.
		emitNoticeThrough((s, m) => internals.broadcastToSession(s, m), state, undefined);
		expect(noticeFramesFor(initiator)).toHaveLength(2);
		expect(noticeFramesFor(witness)).toHaveLength(4);
	});

	it("applies the same exemption to cycle_model", async () => {
		const internals = createDaemonInternals();
		const initiator = makeNoticeClient("client-a", "active-1");
		const witness = makeNoticeClient("client-b", "active-1");
		const state = makeNoticeState("active-1", [initiator, witness]);
		state.runtime = {
			...state.runtime,
			session: {
				isStreaming: false,
				isCompacting: false,
				cycleModel: vi.fn(async (_direction?: string, options?: NoticeOptions) => {
					emitNoticeThrough((s, m) => internals.broadcastToSession(s, m), state, options);
					return { model: MODEL, thinkingLevel: "off", isScoped: false };
				}),
			},
		} as never;
		internals.sessions.set(state.activeSessionId, state);

		const response = await internals.handleCommand(initiator, {
			id: "cmd-1",
			type: "cycle_model",
			activeSessionId: "active-1",
			direction: "forward",
		});

		expect(response).toMatchObject({ success: true });
		expect(noticeFramesFor(witness)).toHaveLength(2);
		expect(noticeFramesFor(initiator)).toEqual([]);
	});

	it("passes a supervisor-stamped changeNoticeToken through without exempting the supervisor link", async () => {
		const internals = createDaemonInternals();
		// The supervisor link is the session's only worker-side client in the routed
		// topology; exempting it would silence every real client, so a forwarded
		// token must broadcast untouched (the supervisor relay exempts instead).
		const supervisorLink = makeNoticeClient("supervisor-link", "active-1");
		supervisorLink.authenticationRole = "supervisor";
		const state = makeNoticeState("active-1", [supervisorLink]);
		const setModel = vi.fn(async (_model: unknown, options?: NoticeOptions) => {
			emitNoticeThrough((s, m) => internals.broadcastToSession(s, m), state, options);
		});
		state.runtime = {
			...state.runtime,
			session: {
				modelRegistry: { refreshAvailableModels: vi.fn(async () => [MODEL]) },
				isStreaming: false,
				isCompacting: false,
				setModel,
			},
		} as never;
		internals.sessions.set(state.activeSessionId, state);

		await internals.handleCommand(supervisorLink, {
			id: "cmd-1",
			type: "set_model",
			activeSessionId: "active-1",
			provider: "faux",
			modelId: "faux-2",
			changeNoticeToken: "tok-from-supervisor",
		});

		expect(setModel).toHaveBeenCalledWith(MODEL, {
			waitForExtensions: true,
			changeNotice: { origin: "daemon_command", token: "tok-from-supervisor" },
		});
		expect(noticeFramesFor(supervisorLink)).toHaveLength(2);
	});

	it("never exempts a supervisor link, even for an old supervisor's tokenless forward", async () => {
		const internals = createDaemonInternals();
		const supervisorLink = makeNoticeClient("supervisor-link", "active-1");
		supervisorLink.authenticationRole = "supervisor";
		const directPeer = makeNoticeClient("direct-peer", "active-1");
		directPeer.authenticationRole = "session_client";
		const state = makeNoticeState("active-1", [supervisorLink, directPeer]);
		state.runtime = {
			...state.runtime,
			session: {
				modelRegistry: { refreshAvailableModels: vi.fn(async () => [MODEL]) },
				isStreaming: false,
				isCompacting: false,
				setModel: vi.fn(async (_model: unknown, options?: NoticeOptions) => {
					emitNoticeThrough((s, m) => internals.broadcastToSession(s, m), state, options);
				}),
			},
		} as never;
		internals.sessions.set(state.activeSessionId, state);

		await internals.handleCommand(supervisorLink, {
			id: "cmd-1",
			type: "set_model",
			activeSessionId: "active-1",
			provider: "faux",
			modelId: "faux-2",
		});

		// No token on the command, but the issuer is the supervisor link: nobody is
		// exempt, so the notice still reaches the supervisor (and through it every
		// real client) plus the direct peer.
		expect(noticeFramesFor(supervisorLink)).toHaveLength(2);
		expect(noticeFramesFor(directPeer)).toHaveLength(2);
	});
});
