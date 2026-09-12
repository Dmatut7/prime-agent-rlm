import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { PRIME_AGENT_META_NAMESPACE, type PrimeAgentSessionMeta } from "../src/modes/acp/acp-meta.js";
import { runAcpModeWithConnection } from "../src/modes/acp/acp-mode.js";
import type {
	AgentConnection,
	AgentConnectionEvent,
	AgentConnectionEventListener,
} from "../src/modes/agent-connection/types.js";

interface ExtensionErrorHarness {
	connection: AgentConnection;
	emit(event: AgentConnectionEvent): void;
}

/**
 * Connection stub exposing the subscription listener so a test can inject
 * connection-scoped events the same way the kernel's extension binding does.
 */
function fakeConnection(): ExtensionErrorHarness {
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

describe("ACP extension error forwarding", () => {
	it("publishes extension failures to the client as namespaced session updates", async () => {
		const { connection, emit } = fakeConnection();
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		const notifications: acp.SessionNotification[] = [];
		const modeDone = runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
		});
		const handle = acp
			.client({ name: "extension-error-client" })
			.onNotification("session/update", (ctx) => {
				notifications.push(ctx.params);
			})
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
		const extensionErrors = () =>
			notifications.filter((notification) => primeMeta(notification)?.extensionError !== undefined);

		try {
			await handle.agent.request("initialize", {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: {},
			});
			const session = await handle.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
			expect(session.sessionId).toBeTruthy();
			expect(extensionErrors()).toHaveLength(0);

			emit({
				type: "extension_error",
				extensionPath: "/extensions/broken.ts",
				event: "tool_call",
				error: "handler exploded",
			});

			await vi.waitFor(() => expect(extensionErrors()).toHaveLength(1));
			const notification = extensionErrors()[0];
			expect(notification.sessionId).toBe(session.sessionId);
			expect(primeMeta(notification)).toMatchObject({
				promptTurnId: 0,
				phase: "event",
				extensionError: {
					extensionPath: "/extensions/broken.ts",
					event: "tool_call",
					error: "handler exploded",
				},
			});
		} finally {
			handle.close();
			await toAgent.writable.close().catch(() => undefined);
			await modeDone;
		}
	}, 30_000);
});
