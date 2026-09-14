/**
 * PERF-STREAM: the direct session-peer link must accept compact
 * assistant_stream_delta frames (payloadEncoding "assistant-delta") so the
 * default interactive path can use the same compact encoding as the
 * supervisor leg. A malformed delta must still tear down the direct link
 * (the routed client falls back to the supervisor).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CompactAssistantDelta } from "../src/modes/daemon/compact-session-stream.js";
import type { DaemonOutbound, DaemonPeerTransportTicket } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonWorkerClient } from "../src/modes/daemon/daemon-worker-client.js";
import { type DaemonWorkerFrameHeader, isDaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import { PrivateFramedChannel } from "../src/modes/session-worker/private-framing.js";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function ticket(socketPath: string): DaemonPeerTransportTicket {
	return {
		purpose: "session_client",
		socketPath,
		socketIdentity: { dev: 0, ino: 0 },
		workerInstanceId: "instance-1",
		activeSessionId: "active-1",
		grantId: "grant-1",
		token: "token-1",
		expiresAt: new Date(Date.now() + 10_000).toISOString(),
	};
}

function helloPayload(): DaemonOutbound {
	return {
		type: "daemon_hello",
		socketPath: "/tmp/worker.sock",
		protocol: { name: "prime-agent.daemon", version: 7 },
		clientId: "peer",
		serverCapabilities: [],
	};
}

function deltaPayload(): CompactAssistantDelta {
	return {
		type: "assistant_stream_delta",
		activeSessionId: "active-1",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
	};
}

interface ServerHandle {
	socketPath: string;
	sendOutbound(header: DaemonWorkerFrameHeader, payload: unknown): Promise<void>;
}

async function startWorkerServer(): Promise<ServerHandle> {
	const directory = mkdtempSync(join(tmpdir(), "worker-client-delta-"));
	directories.push(directory);
	const socketPath = join(directory, "worker.sock");
	let channel: PrivateFramedChannel<DaemonWorkerFrameHeader> | undefined;
	const server = createServer((socket: Socket) => {
		const framed = new PrivateFramedChannel(socket, isDaemonWorkerFrameHeader);
		channel = framed;
		framed.onFrame((frame) => {
			if (frame.header.kind !== "command" || frame.header.commandType !== "peer_auth") return;
			void framed.send(
				{ kind: "outbound", outboundType: "response", requestId: frame.header.requestId },
				Buffer.from(
					JSON.stringify({
						id: frame.header.requestId,
						type: "response",
						command: "peer_auth",
						success: true,
						data: { workerInstanceId: "instance-1", activeSessionId: "active-1", purpose: "session_client" },
					}),
				),
			);
		});
		void framed.send({ kind: "outbound", outboundType: "daemon_hello" }, Buffer.from(JSON.stringify(helloPayload())));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	return {
		socketPath,
		async sendOutbound(header, payload) {
			if (!channel) throw new Error("no client connected");
			await channel.send(header, Buffer.from(JSON.stringify(payload)));
		},
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("DaemonWorkerClient compact delta frames", () => {
	it("delivers assistant-delta frames to message listeners", async () => {
		const server = await startWorkerServer();
		const client = new DaemonWorkerClient(server.socketPath);
		const messages: DaemonOutbound[] = [];
		const closes: Error[] = [];
		client.onMessage((message) => messages.push(message));
		client.onClose((error) => closes.push(error));
		try {
			await client.connect(2000);
			await client.waitForHello(2000);
			await client.authenticatePeer(ticket(server.socketPath), 2000);
			await server.sendOutbound(
				{
					kind: "outbound",
					outboundType: "session_event",
					activeSessionId: "active-1",
					sessionEventType: "message_update",
					payloadEncoding: "assistant-delta",
				},
				deltaPayload(),
			);
			await waitFor(() => messages.length > 0 || closes.length > 0);
			expect(closes).toHaveLength(0);
			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({
				type: "assistant_stream_delta",
				activeSessionId: "active-1",
				assistantMessageEvent: { type: "text_delta", delta: "hello" },
			});
		} finally {
			client.close();
		}
	});

	it("keeps accepting plain jsonl frames (positive control)", async () => {
		const server = await startWorkerServer();
		const client = new DaemonWorkerClient(server.socketPath);
		const messages: DaemonOutbound[] = [];
		client.onMessage((message) => messages.push(message));
		try {
			await client.connect(2000);
			await client.waitForHello(2000);
			await client.authenticatePeer(ticket(server.socketPath), 2000);
			await server.sendOutbound(
				{
					kind: "outbound",
					outboundType: "session_event",
					activeSessionId: "active-1",
					sessionEventType: "message_start",
					payloadEncoding: "jsonl",
				},
				{
					type: "session_event",
					activeSessionId: "active-1",
					event: {
						type: "message_start",
						message: {
							role: "assistant",
							content: [],
							api: "openai-completions",
							provider: "test",
							model: "test",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: 1,
						},
					},
				},
			);
			await waitFor(() => messages.length > 0);
			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({ type: "session_event", event: { type: "message_start" } });
		} finally {
			client.close();
		}
	});

	it("closes the direct link on a malformed assistant-delta payload", async () => {
		const server = await startWorkerServer();
		const client = new DaemonWorkerClient(server.socketPath);
		const messages: DaemonOutbound[] = [];
		const closes: Error[] = [];
		client.onMessage((message) => messages.push(message));
		client.onClose((error) => closes.push(error));
		try {
			await client.connect(2000);
			await client.waitForHello(2000);
			await client.authenticatePeer(ticket(server.socketPath), 2000);
			await server.sendOutbound(
				{
					kind: "outbound",
					outboundType: "session_event",
					activeSessionId: "active-1",
					sessionEventType: "message_update",
					payloadEncoding: "assistant-delta",
				},
				{ type: "assistant_stream_delta" }, // missing activeSessionId / assistantMessageEvent
			);
			await waitFor(() => closes.length > 0);
			expect(messages).toHaveLength(0);
			expect(closes).toHaveLength(1);
		} finally {
			client.close();
		}
	});
});
