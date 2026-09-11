import { describe, expect, it } from "vitest";
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
	type DaemonSessionSnapshot,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

/**
 * T3-2 / P0-5c: the client only ever took the max sequence, so a hole in one event
 * generation was invisible. The detector now records the hole — log-only by default
 * (C11), with the recovery switch gated behind a zero-false-positive window (T4-4).
 * The four anti-false-positive rules are the point of this file: a reseed, a
 * generation change, a frame without a cursor and a repeated hole must stay quiet.
 */

const activeSessionId = "active-gap";
const generation = "generation-gap";

class FakeTransport implements DaemonTransportClient {
	readonly hello: DaemonHello | undefined = {
		type: "daemon_hello",
		socketPath: "/tmp/fake-daemon.sock",
		protocol: DAEMON_PROTOCOL_INFO,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		clientId: "fake-gap-client",
		serverCapabilities: [],
	};
	isConnected = true;
	/** Every request the connection issued, in order. */
	readonly requests: DaemonCommandBody[] = [];
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
		this.requests.push(command);
		return { type: "response", command: command.type, success: false, error: "fixture transport" };
	}
	emit(message: DaemonOutbound): void {
		for (const listener of [...this.messageListeners]) listener(message);
	}
}

function sequencedEvent(sequence: number, eventGeneration = generation): DaemonOutbound {
	return {
		type: "session_event",
		activeSessionId,
		event: { type: "session_info_changed", name: undefined },
		meta: createDaemonEventMeta(activeSessionId, sequence, undefined, eventGeneration),
	};
}

function unsequencedEvent(): DaemonOutbound {
	return {
		type: "session_event",
		activeSessionId,
		event: { type: "session_info_changed", name: undefined },
	};
}

function resyncFrame(sequence: number): DaemonOutbound {
	const summary = {
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "session-gap",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 1,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	} as SessionSummary;
	const snapshot = {
		activeSessionId,
		summary,
		state: { activeSessionId, sessionId: "session-gap" } as DaemonSessionSnapshot["state"],
		messages: [],
		lastEventSequence: sequence,
		lastEventCursor: { generation, sequence },
	} as DaemonSessionSnapshot;
	return { type: "session_resynced", activeSessionId, snapshot };
}

function startConnection(options: { eventGapRecovery?: "log" | "recover" } = {}) {
	const transport = new FakeTransport();
	const connection = new DaemonAgentConnection(transport, activeSessionId, options);
	return { transport, connection };
}

/** handleDaemonMessage runs on a detached promise chain; let it drain. */
async function settled(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("T3-2 daemon event sequence gap detection", () => {
	it("defaults to log-only and records a hole without re-pulling", async () => {
		const { transport, connection } = startConnection();
		expect(connection.eventGapDiagnostics.mode).toBe("log");

		transport.emit(sequencedEvent(5));
		await settled();
		// Rule 1: the first observed frame only establishes the baseline.
		expect(connection.eventGapDiagnostics.detected).toBe(0);

		transport.emit(sequencedEvent(7));
		await settled();
		expect(connection.eventGapDiagnostics).toMatchObject({ detected: 1, lastExpected: 6, lastGot: 7 });
		// Log-only means no recovery traffic at all.
		expect(transport.requests.filter((command) => command.type === "attach")).toHaveLength(0);

		// Positive control: consecutive frames are not gaps. This is the mutation
		// anchor for writing `last + 1` as `last + 0`.
		transport.emit(sequencedEvent(8));
		transport.emit(sequencedEvent(9));
		await settled();
		expect(connection.eventGapDiagnostics.detected).toBe(1);

		// A frame that goes backwards is a duplicate, handled by the stale filter.
		transport.emit(sequencedEvent(6));
		await settled();
		expect(connection.eventGapDiagnostics.detected).toBe(1);

		// Rule 3: a frame without a cursor is skipped, and it must not move the baseline.
		transport.emit(unsequencedEvent());
		transport.emit(sequencedEvent(10));
		await settled();
		expect(connection.eventGapDiagnostics.detected).toBe(1);
		connection.dispose();
	});

	it("re-baselines on a generation change instead of reporting a gap", async () => {
		const { transport, connection } = startConnection();
		transport.emit(sequencedEvent(5));
		await settled();
		// Rule 2: a new generation starts a new sequence space.
		transport.emit(sequencedEvent(900, "generation-next"));
		await settled();
		expect(connection.eventGapDiagnostics.detected).toBe(0);
		transport.emit(sequencedEvent(901, "generation-next"));
		await settled();
		expect(connection.eventGapDiagnostics.detected).toBe(0);
		connection.dispose();
	});

	it("re-arms the baseline after a resync reseed", async () => {
		const { transport, connection } = startConnection();
		transport.emit(sequencedEvent(5));
		await settled();
		transport.emit(resyncFrame(40));
		await settled();
		// The reseed is a new baseline, so the jump from 5 to 41 is not a gap.
		transport.emit(sequencedEvent(41));
		await settled();
		expect(connection.eventGapDiagnostics.detected).toBe(0);
		// The detector is live again after the reseed.
		transport.emit(sequencedEvent(50));
		await settled();
		expect(connection.eventGapDiagnostics.detected).toBe(1);
		connection.dispose();
	});

	it("throttles repeated holes into one report", async () => {
		const { transport, connection } = startConnection();
		transport.emit(sequencedEvent(1));
		await settled();
		transport.emit(sequencedEvent(10));
		transport.emit(sequencedEvent(20));
		transport.emit(sequencedEvent(30));
		await settled();
		const diagnostics = connection.eventGapDiagnostics;
		// Every hole is counted; only the first one inside the window is written out.
		expect(diagnostics.detected).toBe(3);
		expect(diagnostics.suppressed).toBe(2);
		expect(diagnostics.lastExpected).toBe(21);
		expect(diagnostics.lastGot).toBe(30);
		connection.dispose();
	});

	it("re-pulls once per hole in recover mode", async () => {
		const { transport, connection } = startConnection({ eventGapRecovery: "recover" });
		expect(connection.eventGapDiagnostics.mode).toBe("recover");
		transport.emit(sequencedEvent(5));
		await settled();
		transport.emit(sequencedEvent(9));
		await settled();
		// Single flight: later frames of the same hole do not stack re-pulls.
		transport.emit(sequencedEvent(12));
		transport.emit(sequencedEvent(15));
		await settled();
		expect(connection.eventGapDiagnostics.detected).toBe(3);
		// The re-pull is a full snapshot fetch; single flight means one, not three.
		const repulls = transport.requests.filter((command) => command.type === "get_connection_state");
		expect(repulls.length).toBeGreaterThan(0);
		expect(repulls).toHaveLength(1);
		expect(connection.eventGapDiagnostics.recoveryInFlight).toBe(true);
		connection.dispose();
	});
});
