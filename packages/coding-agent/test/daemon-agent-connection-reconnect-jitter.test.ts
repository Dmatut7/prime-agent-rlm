import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DaemonAgentConnection,
	reconnectDelayWithJitterMs,
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

/**
 * Codex #50465's jitter half, ported: reconnect delays draw uniformly from
 * [base/2, base] instead of landing on the exact backoff, so windows knocked off
 * by one shared outage (a daemon restart) stop pulsing in lockstep for the life
 * of the outage. The base stays the cap.
 *
 * RED on HEAD: the transient loop's first retry sleeps the full 100ms backoff
 * and the background retry sleeps the full injected interval, so the low-draw
 * assertions below (retry landed by half the base) fail before the fix.
 */

const activeSessionId = "active-jitter";

class FakeTransport implements DaemonTransportClient {
	readonly hello: DaemonHello | undefined = {
		type: "daemon_hello",
		socketPath: "/tmp/fake-jitter.sock",
		protocol: DAEMON_PROTOCOL_INFO,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		clientId: "fake-jitter-client",
		serverCapabilities: [],
	};
	isConnected = true;
	/** While set, connect() rejects with it. */
	connectError?: string;
	closed = false;
	connectAttempts = 0;
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
		return { type: "response", command: command.type, success: false, error: "no daemon in this test" };
	}
	emitClose(error: Error): void {
		for (const listener of [...this.closeListeners]) listener(error);
	}
}

function backgroundAttempts(events: AgentConnectionEvent[]): number[] {
	return events
		.filter((event) => event.type === "connection_status" && event.backgroundAttempt !== undefined)
		.map((event) => (event.type === "connection_status" ? event.backgroundAttempt : undefined))
		.filter((attempt): attempt is number => attempt !== undefined);
}

async function advance(ms: number, stepMs = 25): Promise<void> {
	for (let done = 0; done < ms; done += stepMs) {
		await vi.advanceTimersByTimeAsync(Math.min(stepMs, ms - done));
	}
}

describe("reconnectDelayWithJitterMs", () => {
	it("draws from [base/2, base] and keeps the base as the cap", () => {
		expect(reconnectDelayWithJitterMs(1000, () => 0)).toBe(500);
		expect(reconnectDelayWithJitterMs(100, () => 0)).toBe(50);
		expect(reconnectDelayWithJitterMs(1000, () => 0.5)).toBe(750);
		// A draw at the very top of Math.random's range must not overshoot the base.
		expect(reconnectDelayWithJitterMs(1000, () => 1)).toBe(1000);
		expect(reconnectDelayWithJitterMs(1000, () => 0.999999)).toBeLessThanOrEqual(1000);
		for (let sample = 0; sample < 200; sample++) {
			const delay = reconnectDelayWithJitterMs(1000);
			expect(delay).toBeGreaterThanOrEqual(500);
			expect(delay).toBeLessThanOrEqual(1000);
			expect(Number.isInteger(delay)).toBe(true);
		}
	});

	it("never inflates a degenerate base", () => {
		expect(reconnectDelayWithJitterMs(1, () => 0)).toBe(1);
		expect(reconnectDelayWithJitterMs(0, () => 0)).toBe(0);
	});
});

describe("reconnect jitter (Codex #50465 shape)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("jitters the transient reconnect backoff: a low draw retries at half the fixed base", async () => {
		// Bottom of the range: every jittered delay is exactly half its fixed base.
		vi.spyOn(Math, "random").mockReturnValue(0);
		const transport = new FakeTransport();
		transport.connectError = "connect ECONNREFUSED";
		const connection = new DaemonAgentConnection(transport, activeSessionId, {
			recoverDaemon: async () => undefined,
			reconnectTimeoutMs: 60_000,
		});
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});

		transport.emitClose(new Error("socket gone"));
		// Fixed schedule: attempt 2 at 100ms, attempt 3 at 300ms. Halved schedule:
		// attempt 2 at 50ms, attempt 3 at 150ms (50 + 100).
		await advance(75);
		expect(transport.connectAttempts).toBeGreaterThanOrEqual(2);
		await advance(125);
		expect(transport.connectAttempts).toBeGreaterThanOrEqual(3);
		expect(events.some((event) => event.type === "connection_status" && event.status === "reconnecting")).toBe(true);
		await connection.dispose();
	});

	it("jitters the background retry: a low draw fires the first attempt within half the interval", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const transport = new FakeTransport();
		transport.connectError = "connect ECONNREFUSED";
		const connection = new DaemonAgentConnection(transport, activeSessionId, {
			recoverDaemon: async () => undefined,
			reconnectTimeoutMs: 100,
			backgroundReconnectRetryMs: 1_000,
		});
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});

		transport.emitClose(new Error("socket gone"));
		// The 100ms fast budget ends in the terminal close that hands over to the
		// background retry.
		await advance(200);
		expect(events.filter((event) => event.type === "closed")).toHaveLength(1);

		// Halved: the first background attempt lands at ~100ms + 500ms. The full
		// interval would fire it at ~1100ms, so 500ms of advance separates them.
		await advance(500);
		expect(backgroundAttempts(events)).toEqual([1]);
		await connection.dispose();
	});
});
