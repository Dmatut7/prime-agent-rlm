import * as acp from "@agentclientprotocol/sdk";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { AgentAutonomousStatus } from "../src/core/autonomous.js";
import { PRIME_AGENT_META_NAMESPACE } from "../src/modes/acp/acp-meta.js";
import { runAcpModeWithConnection } from "../src/modes/acp/acp-mode.js";
import type { AgentConnection, AgentConnectionEventListener } from "../src/modes/agent-connection/types.js";

const autonomousStatus: AgentAutonomousStatus = {
	enabled: false,
	continuationsUsed: 0,
	turnsUsed: 0,
	tokensUsed: 0,
	limits: { maxContinuations: 3, maxTurns: 12, maxTokens: 80_000, timeoutMs: 1_800_000 },
	gates: { commands: [], maxRetries: 3, timeoutMs: 300_000 },
	gateAttempts: {},
};

function abortedAssistant(): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "partial work" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		// A stall-watchdog kill lands here: the turn was aborted by the host, not
		// ended by the model.
		stopReason: "aborted",
		timestamp: 2,
	} as AgentMessage;
}

/**
 * Connection stub whose promptAndWait appends a transcript the way a real
 * aborted turn does, so the ACP prompt handler reads the failure off it.
 */
function abortedTurnConnection(): { connection: AgentConnection } {
	const messages: AgentMessage[] = [];
	const cwd = process.cwd();
	const connection = {
		// This test drives the prompt flow, not the event stream, so the
		// subscription is a no-op that simply stays open for the session lifetime.
		subscribe(_next: AgentConnectionEventListener) {
			return () => {};
		},
		async getState() {
			return { cwd };
		},
		async getInitialSnapshot() {
			return { state: { cwd }, messages: [], children: [] };
		},
		async getMessages() {
			return [...messages];
		},
		async promptAndWait(_text: string, _options: unknown) {
			messages.push({ role: "user", content: _text, timestamp: 1 } as AgentMessage);
			messages.push(abortedAssistant());
		},
		async waitForHeadlessCompletion() {
			return autonomousStatus;
		},
		async getRlmChildSnapshots() {
			return [];
		},
		async dispose() {},
	} as unknown as AgentConnection;
	return { connection };
}

describe("ACP reports an aborted turn as a failure", () => {
	it("rejects session/prompt instead of resolving end_turn when the watchdog killed the turn", async () => {
		const { connection } = abortedTurnConnection();
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		const updates: acp.SessionNotification[] = [];
		const modeDone = runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
		});
		const handle = acp
			.client({ name: "aborted-turn-client" })
			.onNotification("session/update", (ctx) => {
				updates.push(ctx.params);
			})
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));

		try {
			await handle.agent.request("initialize", {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: {},
			});
			const session = await handle.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });

			// R5-M23: a stall-watchdog kill ends the assistant turn with
			// stopReason "aborted"; the sibling headless paths already treat that
			// as a failure. ACP must not resolve the prompt as a normal end_turn.
			// The JSON-RPC layer wraps a plain handler throw as -32603 with the
			// text in data.details, so that is where the failure text is asserted.
			let rejection: unknown;
			try {
				await handle.agent.request("session/prompt", {
					sessionId: session.sessionId,
					prompt: [{ type: "text", text: "run" }],
				});
			} catch (error) {
				rejection = error;
			}
			const details = (rejection as { data?: { details?: unknown } } | undefined)?.data?.details;
			expect(rejection).toBeInstanceOf(Error);
			expect((rejection as Error).message).toBe("Internal error");
			expect(String(details)).toContain("prime-agent turn failed: Request aborted");

			// The correlated terminal envelope must also carry the error outcome, so
			// a client that keys on _meta rather than the request sees the failure.
			const terminal = updates
				.map((notification) => notification.update)
				.filter((update) => update.sessionUpdate === "session_info_update")
				.map((update) => update._meta?.[PRIME_AGENT_META_NAMESPACE])
				.filter((meta) => meta && typeof meta === "object")
				.some((meta) => (meta as { outcome?: string }).outcome === "error");
			expect(terminal).toBe(true);
		} finally {
			handle.close();
			await toAgent.writable.close().catch(() => undefined);
			await modeDone;
		}
	}, 30_000);
});
