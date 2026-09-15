import { describe, expect, it, vi } from "vitest";
import { writeRawStdout } from "../../../src/core/output-guard.js";
import { DaemonAgentConnection } from "../../../src/modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnectionDisposeOptions } from "../../../src/modes/agent-connection/types.js";
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
 * K3R-1/K3R-2: a headless run that gave up waiting for RLM descendants disposes
 * with keepSessionRunning. When the owned-session promotion fails, the dispose
 * must not fall back to complete_owned_session (its worker shutdown cascades
 * into aborting the descendants), the stderr story must match what actually
 * happened, and json mode must carry a structured give-up outcome event.
 */

vi.mock("../../../src/core/output-guard.js", () => ({
	writeRawStdout: vi.fn(),
	flushRawStdout: vi.fn(async () => {}),
}));

const activeSessionId = "active-k3r";

class FakeTransport implements DaemonTransportClient {
	readonly hello: DaemonHello | undefined = {
		type: "daemon_hello",
		socketPath: "/tmp/fake-k3r.sock",
		protocol: DAEMON_PROTOCOL_INFO,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		clientId: "fake-k3r-client",
		serverCapabilities: [],
	};
	isConnected = true;
	/** While set, promote_owned_session fails with this message. */
	promoteError?: string;
	closed = false;
	readonly requests: string[] = [];
	private readonly messageListeners = new Set<DaemonClientMessageListener>();
	private readonly closeListeners = new Set<DaemonClientCloseListener>();

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
		this.requests.push(command.type);
		if (command.type === "promote_owned_session" && this.promoteError) {
			return { type: "response", command: command.type, success: false, error: this.promoteError };
		}
		return { type: "response", command: command.type, success: true, data: dataFor(command.type) };
	}
}

function dataFor(commandType: string): unknown {
	switch (commandType) {
		case "wait_for_headless_completion":
			// Descendants never settled: the barrier gave up on its deadline.
			return {
				enabled: false,
				continuationsUsed: 0,
				turnsUsed: 0,
				tokensUsed: 0,
				limits: { maxContinuations: 3, maxTurns: 12, maxTokens: 80_000, timeoutMs: 30 * 60_000 },
				gates: { commands: [], maxRetries: 3, timeoutMs: 5 * 60_000 },
				gateAttempts: {},
				rlmQuiescence: { settled: false, timedOut: true },
			};
		case "get_messages":
			return { messages: [] };
		default:
			return { activeSessionId, sessionId: "session-k3r" };
	}
}

function startOwned(options: { promoteError?: string } = {}) {
	const transport = new FakeTransport();
	transport.promoteError = options.promoteError;
	const connection = new DaemonAgentConnection(transport, activeSessionId, {
		ownedSession: true,
		recoverDaemon: async () => undefined,
	});
	return { transport, connection };
}

describe("K3R-1: keepSessionRunning dispose when the promote fails", () => {
	it("does not send complete_owned_session and detaches instead, with retries", async () => {
		const { transport, connection } = startOwned({ promoteError: "persist failed" });

		await connection.dispose({ keepSessionRunning: true } as AgentConnectionDisposeOptions);

		// RED on HEAD: the swallowed promote failure fell through to
		// complete_owned_session, whose worker shutdown aborts the descendants.
		expect(transport.requests).not.toContain("complete_owned_session");
		expect(transport.requests).toContain("detach");
		// A transient promote failure gets retried instead of being dropped after one try.
		expect(transport.requests.filter((type) => type === "promote_owned_session").length).toBeGreaterThan(1);
	});

	it("completes the owned session when no keepSessionRunning was requested", async () => {
		const { transport, connection } = startOwned();

		await connection.dispose();

		expect(transport.requests).toContain("complete_owned_session");
		expect(transport.requests).not.toContain("promote_owned_session");
	});
});

describe("K3R-1/K3R-2: print mode over a daemon connection whose promote fails", () => {
	it("stderr tells the truth instead of promising the session was left running", async () => {
		const { connection } = startOwned({ promoteError: "persist failed" });
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		let stderrCalls: string[] = [];
		try {
			const exitCode = await runPrintModeWithConnection(connection, { mode: "text" });
			expect(exitCode).toBe(1);
			stderrCalls = stderr.mock.calls.map((call) => String(call[0]));
		} finally {
			stderr.mockRestore();
		}

		// RED on HEAD: stderr said "the session was left running - re-attach"
		// while the dispose path was stopping the worker.
		expect(stderrCalls.some((text) => text.includes("could not be left running"))).toBe(true);
		expect(stderrCalls.some((text) => text.includes("was left running"))).toBe(false);
	});

	it("json mode emits a structured give-up outcome event carrying the promote failure", async () => {
		const { connection } = startOwned({ promoteError: "persist failed" });
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const exitCode = await runPrintModeWithConnection(connection, { mode: "json" });
			expect(exitCode).toBe(1);
		} finally {
			stderr.mockRestore();
		}

		const lines = vi.mocked(writeRawStdout).mock.calls.map((call) => String(call[0]));
		const parsed = lines
			.map((line) => {
				try {
					return JSON.parse(line) as Record<string, unknown>;
				} catch {
					return undefined;
				}
			})
			.filter((event): event is Record<string, unknown> => event !== undefined);
		const outcome = parsed.find((event) => event.type === "run_outcome");
		// RED on HEAD: json mode carried no structured signal for the give-up.
		expect(outcome).toBeDefined();
		expect(outcome?.reason).toBe("rlm_quiescence_give_up");
		expect(outcome?.gaveUp).toBe(true);
		expect(outcome?.leftRunning).toBe(false);
		expect(String(outcome?.errorMessage)).toContain("persist failed");
	});
});
