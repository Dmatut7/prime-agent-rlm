import { describe, expect, it, vi } from "vitest";
import { DaemonAgentConnection } from "../../../src/modes/agent-connection/daemon-agent-connection.js";
import type {
	DaemonClientCloseListener,
	DaemonClientMessageListener,
	DaemonCommandBody,
	DaemonHello,
	DaemonTransportClient,
} from "../../../src/modes/daemon/daemon-client.js";
import {
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_REVISION,
	type DaemonResponse,
	type DaemonServerCapability,
} from "../../../src/modes/daemon/daemon-protocol.js";
import { runPrintModeWithConnection } from "../../../src/modes/print-mode.js";

/**
 * F4 (r30 protocol-chain): the rlmQuiescence field on wait_for_headless_completion
 * (K3Q-1, rev36) is optional and rides the rlm_quiescence_barrier capability, which
 * predates the field by many revisions. A daemon built between rev18 and rev35
 * advertises the barrier, honors the barrier wait, and answers without the
 * rlmQuiescence field. The rev36 claim is that such a daemon degrades to the
 * pre-fix behavior for a new client: the run completes as it did before K3Q-1
 * (clean exit, normal teardown) instead of failing closed on the missing field.
 * No test covered that path; this one pins it.
 */

vi.mock("../../../src/core/output-guard.js", () => ({
	writeRawStdout: vi.fn(),
	flushRawStdout: vi.fn(async () => {}),
}));

const activeSessionId = "active-k3q";

class FakeTransport implements DaemonTransportClient {
	readonly hello: DaemonHello | undefined = {
		type: "daemon_hello",
		socketPath: "/tmp/fake-k3q.sock",
		protocol: DAEMON_PROTOCOL_INFO,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		clientId: "fake-k3q-client",
		serverCapabilities: [],
	};
	isConnected = true;
	closed = false;
	readonly requests: DaemonCommandBody[] = [];
	private readonly messageListeners = new Set<DaemonClientMessageListener>();
	private readonly closeListeners = new Set<DaemonClientCloseListener>();

	/** An old daemon: it advertises the barrier (rev18+) but predates the field (rev36). */
	supportsServerCapability(capability: DaemonServerCapability): boolean {
		return capability === "rlm_quiescence_barrier";
	}
	async waitForHello(): Promise<DaemonHello> {
		if (!this.hello) throw new Error("no hello");
		return this.hello;
	}
	async connect(): Promise<void> {
		this.isConnected = true;
	}
	async reconnect(): Promise<void> {
		this.isConnected = true;
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
		return { type: "response", command: command.type, success: true, data: dataFor(command.type) };
	}
}

function dataFor(commandType: string): unknown {
	switch (commandType) {
		case "wait_for_headless_completion":
			// The pre-rev36 wire shape: the daemon ran the barrier wait but its
			// response predates the rlmQuiescence field, so the outcome is simply
			// not reported.
			return {
				enabled: false,
				continuationsUsed: 0,
				turnsUsed: 0,
				tokensUsed: 0,
				limits: { maxContinuations: 3, maxTurns: 12, maxTokens: 80_000, timeoutMs: 30 * 60_000 },
				gates: { commands: [], maxRetries: 3, timeoutMs: 5 * 60_000 },
				gateAttempts: {},
			};
		case "get_messages":
			return { messages: [] };
		default:
			return { activeSessionId, sessionId: "session-k3q" };
	}
}

function startOwned() {
	const transport = new FakeTransport();
	const connection = new DaemonAgentConnection(transport, activeSessionId, {
		ownedSession: true,
		recoverDaemon: async () => undefined,
	});
	return { transport, connection };
}

describe("K3Q-1/F4: quiescence field absent on an old barrier-capable daemon", () => {
	it("degrades to the pre-fix behavior: clean exit and normal teardown", async () => {
		const { transport, connection } = startOwned();
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		let stderrCalls: string[] = [];
		try {
			const exitCode = await runPrintModeWithConnection(connection, { mode: "text" });
			expect(exitCode).toBe(0);
			stderrCalls = stderr.mock.calls.map((call) => String(call[0]));
		} finally {
			stderr.mockRestore();
		}

		// The client asked for the barrier (the daemon advertises it)...
		const waitRequest = transport.requests.find((command) => command.type === "wait_for_headless_completion");
		expect(waitRequest).toMatchObject({ waitForRlmQuiescence: true });
		// ...got a field-less answer, and degraded instead of failing closed: no
		// give-up signal, exit 0, and the pre-fix teardown (complete the owned
		// session) still fires.
		expect(stderrCalls.some((text) => text.includes("still running"))).toBe(false);
		expect(transport.requests.some((command) => command.type === "complete_owned_session")).toBe(true);
	});
});
