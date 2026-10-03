import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DAEMON_RECONNECT_TIMEOUT_MS,
	DaemonAgentConnection,
} from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnectionEvent } from "../src/modes/agent-connection/types.js";
import {
	type DaemonClientCloseListener,
	type DaemonClientMessageListener,
	type DaemonCommandBody,
	type DaemonHello,
	DaemonSocketClosedError,
	type DaemonTransportClient,
} from "../src/modes/daemon/daemon-client.js";
import {
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_REVISION,
	type DaemonResponse,
	type DaemonServerCapability,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

/**
 * W27-A: a client holding a dead session id used to poll it forever — after a
 * daemon restart the attached session is gone, yet the spend cell's 15s idle tick
 * kept issuing get_context_tree and every poll hit the wire as a hard
 * "Unknown active session" error (observed for 48 minutes straight on
 * 2026-10-03, sessions 9808c441bb66 and 9d127ead57d4).
 *
 * The daemon already distinguishes the terminal answer ("Unknown active session")
 * from the retryable ones ("session_recovering" / "Session worker is recovering");
 * what was missing is the connection learning the terminal answer once: emit the
 * terminal close a missed session_closed would have caused, then fail later
 * requests for the dead id locally instead of re-asking the daemon.
 */

const activeSessionId = "active-gone";
const sessionFile = "/tmp/fake-gone-session.jsonl";

class FakeTransport implements DaemonTransportClient {
	readonly hello: DaemonHello | undefined = {
		type: "daemon_hello",
		socketPath: "/tmp/fake-gone.sock",
		protocol: DAEMON_PROTOCOL_INFO,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		clientId: "fake-gone-client",
		serverCapabilities: [],
	};
	isConnected = true;
	closed = false;
	readonly requests: DaemonCommandBody[] = [];
	/** Per-command responder; defaults to a minimal success. */
	handler?: (command: DaemonCommandBody) => DaemonResponse;
	private readonly messageListeners = new Set<DaemonClientMessageListener>();
	private readonly closeListeners = new Set<DaemonClientCloseListener>();

	supportsServerCapability(_capability: DaemonServerCapability): boolean {
		return false;
	}
	async waitForHello(): Promise<DaemonHello> {
		if (!this.hello) throw new Error("no hello");
		return this.hello;
	}
	async connect(): Promise<void> {
		this.isConnected = true;
	}
	async reconnect(): Promise<void> {
		await this.connect();
	}
	disconnectForReconnect(): void {
		this.isConnected = false;
	}
	resetTransportForReconnect(): void {
		this.isConnected = false;
	}
	enableRequestRecovery(): void {}
	close(): void {
		this.closed = true;
		this.isConnected = false;
	}
	onMessage(listener: DaemonClientMessageListener): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}
	onClose(listener: DaemonClientCloseListener): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}
	async request(command: DaemonCommandBody): Promise<DaemonResponse> {
		this.requests.push(command);
		if (this.handler) {
			return this.handler(command);
		}
		return { type: "response", command: command.type, success: true, data: dataFor(command.type) };
	}
	emitClose(error: Error): void {
		this.isConnected = false;
		for (const listener of [...this.closeListeners]) listener(error);
	}
	requestCount(type: DaemonCommandBody["type"]): number {
		return this.requests.filter((command) => command.type === type).length;
	}
}

function summaryFor(id: string): SessionSummary {
	return {
		id,
		activeSessionId: id,
		sessionId: "session-gone",
		sessionFile,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 1,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	} satisfies SessionSummary as unknown as SessionSummary;
}

function dataFor(commandType: string): unknown {
	switch (commandType) {
		case "attach":
			return summaryFor(activeSessionId);
		case "list":
			return { sessions: [] };
		case "get_messages":
			return { messages: [] };
		case "get_session_context":
			return { context: { activeSessionId, sessionId: "session-gone" } };
		case "get_context_tree":
			return { id: "root", children: [] };
		default:
			return { activeSessionId, sessionId: "session-gone" };
	}
}

function start(options: { backgroundReconnectRetryMs?: number } = {}) {
	const transport = new FakeTransport();
	const events: AgentConnectionEvent[] = [];
	const connection = new DaemonAgentConnection(transport, activeSessionId, {
		recoverDaemon: async () => undefined,
		...options,
	});
	connection.subscribe((event) => {
		events.push(event);
	});
	return { transport, connection, events };
}

function closedEvents(events: AgentConnectionEvent[]): AgentConnectionEvent[] {
	return events.filter((event) => event.type === "closed");
}

async function advance(ms: number, stepMs = 1_000): Promise<void> {
	for (let done = 0; done < ms; done += stepMs) {
		await vi.advanceTimersByTimeAsync(Math.min(stepMs, ms - done));
	}
}

describe("session-gone terminal answers (W27-A)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("learns the terminal answer once: one closed event, then later polls fail without hitting the wire", async () => {
		const { transport, connection, events } = start();
		// The daemon restarted without this session; the socket itself is healthy.
		transport.handler = (command) =>
			command.type === "get_context_tree"
				? {
						type: "response",
						command: command.type,
						success: false,
						error: `Unknown active session: ${activeSessionId}`,
					}
				: { type: "response", command: command.type, success: true, data: dataFor(command.type) };

		await expect(connection.getContextTree()).rejects.toThrow(`Unknown active session: ${activeSessionId}`);

		const closed = closedEvents(events);
		expect(closed).toHaveLength(1);
		expect(closed[0]).toMatchObject({ type: "closed", sessionClosedReason: "killed" });
		expect(closed[0]?.type === "closed" ? closed[0].error : "").toContain("no longer has this session");
		expect(transport.requestCount("get_context_tree")).toBe(1);

		// The 15s spend-cell tick keeps firing after the close; every later poll for the
		// dead id must be answered locally instead of spamming the daemon.
		await expect(connection.getContextTree()).rejects.toThrow(`Unknown active session: ${activeSessionId}`);
		await expect(connection.getSessionStats()).rejects.toThrow(`Unknown active session: ${activeSessionId}`);
		expect(transport.requestCount("get_context_tree")).toBe(1);
		expect(transport.requestCount("get_session_stats")).toBe(0);
		await connection.dispose();
	});

	it("does not trip on retryable or unrelated failures", async () => {
		const { transport, connection, events } = start();
		transport.handler = (command) => ({
			type: "response",
			command: command.type,
			success: false,
			error: "Session worker is recovering",
		});

		await expect(connection.getContextTree()).rejects.toThrow("Session worker is recovering");
		expect(closedEvents(events)).toHaveLength(0);

		transport.handler = (command) =>
			command.type === "get_context_tree"
				? {
						type: "response",
						command: command.type,
						success: false,
						error: "Unknown active session: some-other-session",
					}
				: { type: "response", command: command.type, success: true, data: dataFor(command.type) };
		await expect(connection.getContextTree()).rejects.toThrow("Unknown active session: some-other-session");
		expect(closedEvents(events)).toHaveLength(0);
		await connection.dispose();
	});

	it("a shutdown restore in flight keeps the wire open and the flag off, then re-attaches", async () => {
		const { transport, connection, events } = start();
		await connection.attach();
		let restored = false;
		transport.handler = (command) => {
			if (command.type === "get_context_tree" && !restored) {
				return {
					type: "response",
					command: command.type,
					success: false,
					error: `Unknown active session: ${activeSessionId}`,
				};
			}
			if (command.type === "list") {
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { sessions: restored ? [summaryFor(activeSessionId)] : [] },
				};
			}
			return { type: "response", command: command.type, success: true, data: dataFor(command.type) };
		};

		transport.emitClose(new DaemonSocketClosedError("/tmp/fake-gone.sock", "shutdown"));
		// The restore loop lists while the daemon comes back; a poll landing in that
		// window still reaches the wire (it cannot be told apart from a restore probe).
		await advance(250, 50);
		await expect(connection.getContextTree()).rejects.toThrow(`Unknown active session: ${activeSessionId}`);
		expect(transport.requestCount("get_context_tree")).toBe(1);
		expect(closedEvents(events)).toHaveLength(0);

		restored = true;
		await advance(1_000, 100);
		expect(events.some((event) => event.type === "session_resynced")).toBe(true);
		expect(closedEvents(events)).toHaveLength(0);

		await expect(connection.getContextTree()).resolves.toMatchObject({ id: "root" });
		expect(transport.requestCount("get_context_tree")).toBe(2);
		await connection.dispose();
	});

	it("caps the reported zombie shape: after the reconnect budget and the terminal background stop, polls go silent", async () => {
		const { transport, connection, events } = start();
		transport.handler = (command) =>
			command.type === "attach" || command.type === "get_context_tree"
				? {
						type: "response",
						command: command.type,
						success: false,
						error: `Unknown active session: ${activeSessionId}`,
					}
				: { type: "response", command: command.type, success: true, data: dataFor(command.type) };
		transport.emitClose(new Error("socket gone"));

		// Fast budget ends in one terminal close; the background retry takes over and
		// stops on the terminal answer (I-9), closing the transport.
		await advance(DAEMON_RECONNECT_TIMEOUT_MS + 10_000);
		expect(closedEvents(events)).toHaveLength(1);
		await advance(35_000);
		expect(transport.closed).toBe(true);

		// The spend cell keeps ticking anyway. The first poll is answered by the daemon
		// (and learns nothing new); from the second on the connection answers locally.
		await expect(connection.getContextTree()).rejects.toThrow(`Unknown active session: ${activeSessionId}`);
		await expect(connection.getContextTree()).rejects.toThrow(`Unknown active session: ${activeSessionId}`);
		expect(transport.requestCount("get_context_tree")).toBeLessThanOrEqual(1);
		expect(closedEvents(events)).toHaveLength(1);
		await connection.dispose();
	});
});
