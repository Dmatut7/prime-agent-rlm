/**
 * Wire正控 for the revision-28 stall additions: a client must survive an unknown
 * or newly added session event, and must downgrade stall state it is not allowed
 * to render.
 */
import { describe, expect, it, vi } from "vitest";
import {
	type AgentConnectionEvent,
	type AgentConnectionRlmChildAgentSnapshot,
	DaemonAgentConnection,
} from "../src/modes/agent-connection/index.js";
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
	type DaemonOutbound,
	type DaemonResponse,
	type DaemonServerCapability,
} from "../src/modes/daemon/daemon-protocol.js";

class FakeTransport implements DaemonTransportClient {
	readonly hello: DaemonHello | undefined = {
		type: "daemon_hello",
		socketPath: "/tmp/fake.sock",
		protocol: DAEMON_PROTOCOL_INFO,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		clientId: "fake-client",
		serverCapabilities: [],
	};
	isConnected = true;
	capabilities = new Set<DaemonServerCapability>();
	private readonly messageListeners = new Set<DaemonClientMessageListener>();
	private readonly closeListeners = new Set<DaemonClientCloseListener>();

	supportsServerCapability(capability: DaemonServerCapability): boolean {
		return this.capabilities.has(capability);
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
	async request(_command: DaemonCommandBody): Promise<DaemonResponse> {
		return { type: "response", command: "request", success: true, data: {} };
	}
	emit(message: DaemonOutbound): void {
		for (const listener of [...this.messageListeners]) listener(message);
	}
}

function stalledChild(
	overrides: Partial<AgentConnectionRlmChildAgentSnapshot> = {},
): AgentConnectionRlmChildAgentSnapshot {
	return {
		id: "sub-1",
		label: "wedged worker",
		status: "running",
		sessionDir: "/tmp/sub-1",
		activity: { kind: "stalled" },
		stall: { silentMs: 933_000, thresholdMs: 900_000, inFlightTools: ["ipython"] },
		...overrides,
	};
}

async function settled(_connection: DaemonAgentConnection): Promise<void> {
	// handleDaemonMessage runs on a detached promise chain; let it drain.
	await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("daemon connection stall events", () => {
	it("passes a stall_unsettled session event through without throwing", async () => {
		const transport = new FakeTransport();
		transport.capabilities.add("rlm_child_stall_activity");
		const connection = new DaemonAgentConnection(transport, "active-1");
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});

		transport.emit({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "stall_unsettled",
				message: "auto-abort fired but the run did not settle",
				silentMs: 933_000,
				thresholdMs: 900_000,
				diagnostics: {
					silentMs: 933_000,
					busy: { streaming: true, compacting: false, retrying: false, bashRunning: false },
					lastEvent: undefined,
					inFlightToolCalls: [],
					pump: { suspended: false, requested: false, epoch: 0 },
					unfinishedActions: 1,
				},
			},
		});
		await settled(connection);

		const forwarded = events.filter(
			(event): event is Extract<AgentConnectionEvent, { type: "session_event" }> => event.type === "session_event",
		);
		expect(forwarded).toHaveLength(1);
		expect(forwarded[0]?.event.type).toBe("stall_unsettled");
		if (forwarded[0]?.event.type !== "stall_unsettled") throw new Error("unreachable");
		expect(forwarded[0].event.message).toContain("did not settle");
		connection.dispose();
	});

	it("keeps stall activity and facts when the server declares the capability", async () => {
		const transport = new FakeTransport();
		transport.capabilities.add("rlm_child_stall_activity");
		const connection = new DaemonAgentConnection(transport, "active-1");
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});

		transport.emit({
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "rlm_child_update", child: stalledChild() },
		});
		await settled(connection);

		const update = events.find(
			(event): event is Extract<AgentConnectionEvent, { type: "session_event" }> =>
				event.type === "session_event" && event.event.type === "rlm_child_update",
		);
		expect(update).toBeDefined();
		if (update?.type !== "session_event" || update.event.type !== "rlm_child_update") throw new Error("unreachable");
		expect(update.event.child.activity?.kind).toBe("stalled");
		expect(update.event.child.stall?.inFlightTools).toEqual(["ipython"]);
		connection.dispose();
	});

	it("downgrades stalled activity and drops stall facts for a server without the capability", async () => {
		const transport = new FakeTransport();
		const connection = new DaemonAgentConnection(transport, "active-1");
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});

		transport.emit({
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "rlm_child_update", child: stalledChild() },
		});
		await settled(connection);

		const update = events.find(
			(event): event is Extract<AgentConnectionEvent, { type: "session_event" }> =>
				event.type === "session_event" && event.event.type === "rlm_child_update",
		);
		if (update?.type !== "session_event" || update.event.type !== "rlm_child_update") throw new Error("unreachable");
		// Old servers never report a stall; a client must not invent one either.
		expect(update.event.child.activity?.kind).toBe("waiting");
		expect(update.event.child.stall).toBeUndefined();
		connection.dispose();
	});

	it("leaves non-stall activity alone when the capability is missing", async () => {
		const transport = new FakeTransport();
		const connection = new DaemonAgentConnection(transport, "active-1");
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});

		transport.emit({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "rlm_child_update",
				child: stalledChild({ activity: { kind: "executing", toolName: "bash" }, stall: undefined }),
			},
		});
		await settled(connection);

		const update = events.find(
			(event): event is Extract<AgentConnectionEvent, { type: "session_event" }> =>
				event.type === "session_event" && event.event.type === "rlm_child_update",
		);
		if (update?.type !== "session_event" || update.event.type !== "rlm_child_update") throw new Error("unreachable");
		expect(update.event.child.activity).toEqual({ kind: "executing", toolName: "bash" });
		connection.dispose();
	});

	it("exposes the capability gate as a spy-observable check", () => {
		const transport = new FakeTransport();
		const spy = vi.spyOn(transport, "supportsServerCapability");
		const connection = new DaemonAgentConnection(transport, "active-1");
		transport.emit({
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "rlm_child_update", child: stalledChild() },
		});
		// Positive control for the two downgrade cases above: the gate is consulted,
		// so their result is a decision and not an accident of construction.
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(spy).toHaveBeenCalledWith("rlm_child_stall_activity");
				connection.dispose();
				resolve();
			}, 20);
		});
	});
});
