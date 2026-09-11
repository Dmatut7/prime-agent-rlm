import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DAEMON_RECONNECT_TIMEOUT_MS,
	DaemonAgentConnection,
} from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnectionEvent } from "../src/modes/agent-connection/types.js";
import type {
	DaemonClientCloseListener,
	DaemonClientMessageListener,
	DaemonCommandBody,
	DaemonHello,
	DaemonTransportClient,
} from "../src/modes/daemon/daemon-client.js";
import {
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_REVISION,
	type DaemonResponse,
	type DaemonServerCapability,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DAEMON_BACKGROUND_RECONNECT_RETRY_MS } from "../src/modes/daemon/daemon-timeouts.js";

/**
 * P1-7b, 60s tier. The fast reconnect budget was 60s: a daemon that took longer
 * to come back (a supervisor replacement, an adoption still running) ended in a
 * terminal `closed` and the user had to reopen the session by hand. The budget is
 * now derived from the recovery ladder it waits for, and after it ends a
 * low-speed background retry keeps going until it succeeds, the connection is
 * disposed, or the target answers with a terminal error (I-9).
 *
 * Timers are fake, so the 90s and 330s waits cost nothing; the budget is the
 * default (not injected) on purpose — that default is what changed.
 */

const activeSessionId = "active-budget";

class FakeTransport implements DaemonTransportClient {
	readonly hello: DaemonHello | undefined = {
		type: "daemon_hello",
		socketPath: "/tmp/fake-budget.sock",
		protocol: DAEMON_PROTOCOL_INFO,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		clientId: "fake-budget-client",
		serverCapabilities: [],
	};
	isConnected = true;
	/** While set, connect() rejects with it. */
	connectError?: string;
	/** While set, every request fails with it. */
	requestError?: string;
	closed = false;
	resetCount = 0;
	connectAttempts = 0;
	readonly requests: string[] = [];
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
		this.connectAttempts++;
		if (this.connectError) {
			this.isConnected = false;
			throw new Error(this.connectError);
		}
		this.isConnected = true;
	}
	async reconnect(): Promise<void> {
		await this.connect();
	}
	disconnectForReconnect(): void {
		this.isConnected = false;
	}
	resetTransportForReconnect(): void {
		this.resetCount++;
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
		this.requests.push(command.type);
		if (this.requestError) {
			return { type: "response", command: command.type, success: false, error: this.requestError };
		}
		return { type: "response", command: command.type, success: true, data: dataFor(command.type) };
	}
	emitClose(error: Error): void {
		for (const listener of [...this.closeListeners]) listener(error);
	}
}

function dataFor(commandType: string): unknown {
	switch (commandType) {
		case "attach":
			return {
				id: activeSessionId,
				activeSessionId,
				sessionId: "session-budget",
				lifecycle: "live",
				activity: "idle",
				isSessionActive: false,
				cwd: "/tmp",
				isStreaming: false,
				isCompacting: false,
				attachedClients: 1,
				messageCount: 0,
				sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			} satisfies SessionSummary as unknown;
		case "get_messages":
			return { messages: [] };
		case "get_session_context":
			return { context: { activeSessionId, sessionId: "session-budget" } };
		default:
			return { activeSessionId, sessionId: "session-budget" };
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

function backgroundAttempts(events: AgentConnectionEvent[]): number[] {
	return events
		.filter((event) => event.type === "connection_status" && event.backgroundAttempt !== undefined)
		.map((event) => (event.type === "connection_status" ? event.backgroundAttempt : undefined))
		.filter((attempt): attempt is number => attempt !== undefined);
}

async function advance(ms: number, stepMs = 5_000): Promise<void> {
	for (let done = 0; done < ms; done += stepMs) {
		await vi.advanceTimersByTimeAsync(Math.min(stepMs, ms - done));
	}
}

describe("P1-7b reconnect budget and background retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps recovering when the daemon returns after 90s and never reports a terminal close", async () => {
		const { transport, connection, events } = start();
		transport.connectError = "connect ECONNREFUSED";
		transport.emitClose(new Error("socket gone"));

		await advance(90_000);
		// RED on HEAD: the 60s budget ended in a terminal close at 60s.
		expect(closedEvents(events)).toHaveLength(0);
		expect(transport.connectAttempts).toBeGreaterThan(1);

		transport.connectError = undefined;
		await advance(10_000);

		expect(events.some((event) => event.type === "session_resynced")).toBe(true);
		expect(events.some((event) => event.type === "connection_status" && event.status === "connected")).toBe(true);
		expect(closedEvents(events)).toHaveLength(0);
		expect(transport.requests).toContain("attach");
		await connection.dispose();
	});

	it("reports the terminal close once the extended budget is spent, then retries in the background", async () => {
		const { transport, connection, events } = start();
		transport.connectError = "connect ECONNREFUSED";
		transport.emitClose(new Error("socket gone"));

		await advance(DAEMON_RECONNECT_TIMEOUT_MS - 10_000);
		expect(closedEvents(events)).toHaveLength(0);
		await advance(20_000);

		expect(closedEvents(events)).toHaveLength(1);
		// The transport stays usable: the background retry re-attaches through it.
		expect(transport.closed).toBe(false);
		expect(transport.resetCount).toBeGreaterThan(0);

		await advance(3 * DAEMON_BACKGROUND_RECONNECT_RETRY_MS);
		expect(backgroundAttempts(events)).toEqual([1, 2, 3]);

		// The daemon comes back: the next background attempt re-attaches and resyncs.
		transport.connectError = undefined;
		await advance(DAEMON_BACKGROUND_RECONNECT_RETRY_MS);
		expect(backgroundAttempts(events)).toEqual([1, 2, 3, 4]);
		expect(events.filter((event) => event.type === "session_resynced")).toHaveLength(1);
		expect(events.filter((event) => event.type === "connection_status" && event.status === "connected")).toHaveLength(
			1,
		);
		await connection.dispose();
	});

	it("stops the background retry on a terminal answer instead of retrying forever", async () => {
		const { transport, connection, events } = start();
		transport.connectError = "connect ECONNREFUSED";
		transport.emitClose(new Error("socket gone"));
		await advance(DAEMON_RECONNECT_TIMEOUT_MS + 10_000);
		expect(closedEvents(events)).toHaveLength(1);

		// I-9: the session was reaped, so the target answers terminally (C19).
		transport.connectError = undefined;
		transport.requestError = `Unknown active session: ${activeSessionId}`;
		await advance(DAEMON_BACKGROUND_RECONNECT_RETRY_MS);
		const attemptsAfterTerminal = backgroundAttempts(events).length;
		expect(attemptsAfterTerminal).toBe(1);
		expect(transport.closed).toBe(true);

		await advance(5 * DAEMON_BACKGROUND_RECONNECT_RETRY_MS);
		expect(backgroundAttempts(events)).toHaveLength(attemptsAfterTerminal);
		await connection.dispose();
	});

	it("stops the background retry on dispose", async () => {
		const { transport, connection, events } = start();
		transport.connectError = "connect ECONNREFUSED";
		transport.emitClose(new Error("socket gone"));
		await advance(DAEMON_RECONNECT_TIMEOUT_MS + 10_000);
		expect(closedEvents(events)).toHaveLength(1);

		const armedBeforeDispose = vi.getTimerCount();
		expect(armedBeforeDispose).toBeGreaterThan(0);
		await connection.dispose();
		// A dispose must not leave the retry interval armed: it would keep the
		// process alive for another period after the connection is gone.
		expect(vi.getTimerCount()).toBe(0);
		await advance(4 * DAEMON_BACKGROUND_RECONNECT_RETRY_MS);

		expect(backgroundAttempts(events)).toHaveLength(0);
	});

	it("runs the background retry at the injected interval", async () => {
		const { transport, connection, events } = start({ backgroundReconnectRetryMs: 1_000 });
		transport.connectError = "connect ECONNREFUSED";
		transport.emitClose(new Error("socket gone"));
		await advance(DAEMON_RECONNECT_TIMEOUT_MS + 10_000);
		const alreadyTried = backgroundAttempts(events).length;
		expect(alreadyTried).toBeGreaterThan(0);

		await advance(3_000, 500);

		// The injected 1s interval, not the 30s default, spaces these three.
		expect(backgroundAttempts(events).slice(alreadyTried)).toEqual([
			alreadyTried + 1,
			alreadyTried + 2,
			alreadyTried + 3,
		]);
		await connection.dispose();
	});
});
