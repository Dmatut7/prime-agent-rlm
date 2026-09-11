import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type {
	DaemonClientCloseListener,
	DaemonClientMessageListener,
	DaemonCommandBody,
	DaemonHello,
	DaemonTransportClient,
} from "../src/modes/daemon/daemon-client.js";
import {
	createDaemonEventMeta,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_REVISION,
	type DaemonOutbound,
	type DaemonResponse,
	type DaemonServerCapability,
} from "../src/modes/daemon/daemon-protocol.js";

/**
 * T4-4/F9: the gap detector's recover mode re-pulls the session, and a hole that
 * a re-pull cannot close would loop "re-pull, still gapped, re-pull" forever — a
 * resync storm on top of the original fault. The breaker caps that: a streak of
 * consecutive gap re-pulls, or too many inside one window, drops this connection
 * back to log-only and says so in the log. The shipped default stays "log": the
 * breaker only ever limits a mode an operator turned on.
 */

const activeSessionId = "active-breaker";
const generation = "generation-breaker";

class FakeTransport implements DaemonTransportClient {
	readonly hello: DaemonHello | undefined = {
		type: "daemon_hello",
		socketPath: "/tmp/fake-breaker.sock",
		protocol: DAEMON_PROTOCOL_INFO,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		clientId: "fake-breaker-client",
		serverCapabilities: [],
	};
	isConnected = true;
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
	async connect(): Promise<void> {}
	async reconnect(): Promise<void> {}
	disconnectForReconnect(): void {}
	resetTransportForReconnect(): void {}
	enableRequestRecovery(): void {}
	close(): void {
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
		return { type: "response", command: command.type, success: true, data: dataFor(command.type) };
	}
	rePulls(): number {
		return this.requests.filter((type) => type === "get_connection_state").length;
	}
	emit(message: DaemonOutbound): void {
		for (const listener of [...this.messageListeners]) listener(message);
	}
}

function dataFor(commandType: string): unknown {
	if (commandType === "get_messages") return { messages: [] };
	if (commandType === "get_session_context") return { context: { activeSessionId, sessionId: "session-breaker" } };
	return { activeSessionId, sessionId: "session-breaker" };
}

function start(options: { eventGapRecovery?: "log" | "recover" } = {}) {
	const transport = new FakeTransport();
	const connection = new DaemonAgentConnection(transport, activeSessionId, options);
	return { transport, connection };
}

function sequencedEvent(sequence: number): DaemonOutbound {
	return {
		type: "session_event",
		activeSessionId,
		event: { type: "session_info_changed", name: undefined },
		meta: createDaemonEventMeta(activeSessionId, sequence, undefined, generation),
	};
}

async function settled(): Promise<void> {
	if (vi.isFakeTimers()) {
		await vi.advanceTimersByTimeAsync(50);
		return;
	}
	await new Promise((resolve) => setTimeout(resolve, 25));
}

/** One hole: arm the baseline, then jump past it. */
async function oneGap(transport: FakeTransport, from: number): Promise<void> {
	transport.emit(sequencedEvent(from));
	await settled();
	transport.emit(sequencedEvent(from + 9));
	await settled();
	await settled();
}

describe("T4-4 gap recovery circuit breaker", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("opens after a streak of gaps the re-pull did not close, then stays log-only", async () => {
		const { transport, connection } = start({ eventGapRecovery: "recover" });

		await oneGap(transport, 5);
		await oneGap(transport, 20);
		expect(connection.eventGapDiagnostics.breakerOpen).toBe(false);
		expect(transport.rePulls()).toBe(2);

		await oneGap(transport, 40);
		const diagnostics = connection.eventGapDiagnostics;
		// RED on HEAD: recover mode re-pulled forever, one storm per real hole.
		expect(diagnostics.breakerOpen).toBe(true);
		expect(diagnostics.breakerReason).toContain("3 consecutive gap re-pulls");
		expect(diagnostics.configuredMode).toBe("recover");
		expect(diagnostics.mode).toBe("log");
		expect(transport.rePulls()).toBe(3);

		// Later holes are still counted and logged, but no longer re-pull.
		await oneGap(transport, 60);
		expect(connection.eventGapDiagnostics.detected).toBe(4);
		expect(transport.rePulls()).toBe(3);
		await connection.dispose();
	});

	it("keeps recovering an occasional gap", async () => {
		const { transport, connection } = start({ eventGapRecovery: "recover" });

		await oneGap(transport, 5);
		await oneGap(transport, 20);

		// Positive control: the breaker must not fire on ordinary self-healing.
		expect(connection.eventGapDiagnostics.breakerOpen).toBe(false);
		expect(connection.eventGapDiagnostics.recoveryStreak).toBe(2);
		expect(transport.rePulls()).toBe(2);
		await connection.dispose();
	});

	it("bounds the re-pull rate over a long-lived connection", async () => {
		vi.useFakeTimers();
		const { transport, connection } = start({ eventGapRecovery: "recover" });

		await oneGap(transport, 5);
		// Far enough apart that the streak restarts, close enough that all three
		// land inside one rate window.
		await vi.advanceTimersByTimeAsync(6 * 60_000);
		await oneGap(transport, 20);
		expect(connection.eventGapDiagnostics.breakerOpen).toBe(false);
		expect(connection.eventGapDiagnostics.recoveryStreak).toBe(1);
		await vi.advanceTimersByTimeAsync(60_000);
		await oneGap(transport, 40);

		const diagnostics = connection.eventGapDiagnostics;
		expect(diagnostics.breakerOpen).toBe(true);
		expect(diagnostics.breakerReason).toContain("gap re-pulls within");
		expect(transport.rePulls()).toBe(3);
		await connection.dispose();
	});

	it("stays log-only by default, so the breaker has nothing to limit", async () => {
		const { transport, connection } = start();

		await oneGap(transport, 5);
		await oneGap(transport, 20);

		const diagnostics = connection.eventGapDiagnostics;
		expect(diagnostics.mode).toBe("log");
		// Log-only never reseeds, so both frames of the second hole count as gaps.
		expect(diagnostics.detected).toBe(3);
		expect(diagnostics.breakerOpen).toBe(false);
		expect(transport.rePulls()).toBe(0);
		await connection.dispose();
	});
});
