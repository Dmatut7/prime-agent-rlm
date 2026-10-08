import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { PRIME_AGENT_META_NAMESPACE, type PrimeAgentSessionMeta } from "../src/modes/acp/acp-meta.js";
import { runAcpModeWithConnection } from "../src/modes/acp/acp-mode.js";
import type {
	AgentConnection,
	AgentConnectionEvent,
	AgentConnectionEventListener,
} from "../src/modes/agent-connection/types.js";

interface ConnectionEventHarness {
	connection: AgentConnection;
	emit(event: AgentConnectionEvent): void;
}

/**
 * Connection stub exposing the subscription listener so a test can inject the
 * connection-scoped events the daemon emits, exactly as acp-extension-error
 * does for extension failures.
 */
function fakeConnection(): ConnectionEventHarness {
	let listener: AgentConnectionEventListener | undefined;
	const cwd = process.cwd();
	const connection = {
		subscribe(next: AgentConnectionEventListener) {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		async getState() {
			return { cwd };
		},
		async getInitialSnapshot() {
			return { state: { cwd }, messages: [], children: [] };
		},
		async dispose() {},
	} as unknown as AgentConnection;
	return {
		connection,
		emit(event: AgentConnectionEvent) {
			void listener?.(event);
		},
	};
}

function primeMeta(notification: acp.SessionNotification): PrimeAgentSessionMeta | undefined {
	const update = notification.update;
	if (update.sessionUpdate !== "session_info_update") return undefined;
	const meta = update._meta?.[PRIME_AGENT_META_NAMESPACE];
	return meta && typeof meta === "object" ? (meta as PrimeAgentSessionMeta) : undefined;
}

describe("ACP connection-level event forwarding", () => {
	it("publishes quota park heartbeats and daemon reconnect status as namespaced session updates", async () => {
		const { connection, emit } = fakeConnection();
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		const notifications: acp.SessionNotification[] = [];
		const modeDone = runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
		});
		const handle = acp
			.client({ name: "connection-events-client" })
			.onNotification("session/update", (ctx) => {
				notifications.push(ctx.params);
			})
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));

		try {
			await handle.agent.request("initialize", {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: {},
			});
			const session = await handle.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
			expect(session.sessionId).toBeTruthy();
			expect(notifications).toHaveLength(0);

			// R5-M22: these events used to vanish in the subscription, so an
			// in-flight prompt hung with zero signal during a quota park (up to
			// 24h) and the client's state went stale after a daemon restart.
			emit({
				type: "quota_park_status",
				parked: true,
				resumeAt: "2026-10-08T12:00:00.000Z",
				remainingMs: 86_400_000,
				parkCount: 1,
				provider: "anthropic",
			});

			await vi.waitFor(() => {
				expect(notifications.filter((n) => primeMeta(n)?.quotaPark?.parked === true)).toHaveLength(1);
			});
			const park = notifications.map(primeMeta).find((meta) => meta?.quotaPark?.parked === true);
			expect(park).toMatchObject({
				promptTurnId: 0,
				phase: "event",
				quotaPark: {
					parked: true,
					resumeAt: "2026-10-08T12:00:00.000Z",
					remainingMs: 86_400_000,
					parkCount: 1,
					provider: "anthropic",
				},
			});

			emit({ type: "connection_status", status: "reconnecting", error: "socket hang up" });
			await vi.waitFor(() => {
				expect(notifications.filter((n) => primeMeta(n)?.connectionStatus?.status === "reconnecting")).toHaveLength(
					1,
				);
			});
			const reconnecting = notifications
				.map(primeMeta)
				.find((meta) => meta?.connectionStatus?.status === "reconnecting");
			expect(reconnecting).toMatchObject({
				promptTurnId: 0,
				connectionStatus: { status: "reconnecting", error: "socket hang up" },
			});

			// A resync marker tells the client its event-built view is stale.
			emit({
				type: "session_resynced",
				snapshot: { state: { cwd: process.cwd() }, messages: [] },
			} as unknown as AgentConnectionEvent);
			await vi.waitFor(() => {
				expect(notifications.filter((n) => primeMeta(n)?.sessionSync?.kind === "resynced")).toHaveLength(1);
			});
			const sync = notifications.map(primeMeta).find((meta) => meta?.sessionSync?.kind === "resynced");
			expect(sync).toMatchObject({ sessionSync: { kind: "resynced", messageCount: 0 } });
		} finally {
			handle.close();
			await toAgent.writable.close().catch(() => undefined);
			await modeDone;
		}
	}, 30_000);
});
