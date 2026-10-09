import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { DaemonShutdownTombstonedRecoveryError } from "../src/modes/daemon/daemon-supervisor-ownership.js";

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((resolveClose) => server.close(resolveClose));
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const sessionSummary = {
	id: "active-1",
	sessionId: "session-1",
	activeSessionId: "active-1",
	sessionFile: "/tmp/session-1.jsonl",
	lifecycle: "live",
	activity: "idle",
	isSessionActive: true,
	cwd: "/tmp/project",
	isStreaming: false,
	isCompacting: false,
	attachedClients: 1,
	messageCount: 0,
	sessionActions: { queuedCount: 0, steering: [], followUps: [] },
};

/** Serves attach and lets everything else succeed vacuously. */
function respondAll(): (command: { type: string }, socket: Socket, reply: (data?: unknown) => void) => void {
	return (command, _socket, reply) => {
		switch (command.type) {
			case "attach":
				reply(sessionSummary);
				return;
			default:
				reply();
		}
	};
}

async function startDaemon(socketPath: string): Promise<{ sockets: Socket[] }> {
	const sockets: Socket[] = [];
	const server = createServer((socket) => {
		sockets.push(socket);
		socket.on("error", () => undefined);
		socket.write(`${JSON.stringify({ type: "daemon_hello", protocol: { version: 7 }, serverCapabilities: [] })}\n`);
		let buffered = "";
		socket.on("data", (chunk: Buffer) => {
			buffered += chunk.toString("utf8");
			let newlineIndex = buffered.indexOf("\n");
			while (newlineIndex !== -1 && !socket.destroyed) {
				const line = buffered.slice(0, newlineIndex);
				buffered = buffered.slice(newlineIndex + 1);
				newlineIndex = buffered.indexOf("\n");
				if (!line.trim()) continue;
				const wire = JSON.parse(line) as { id?: string; type?: string; command?: { type: string } };
				const command = wire.type === "command" && wire.command ? wire.command : (wire as { type: string });
				if (command.type === "ack_result") continue;
				respondAll()(command, socket, (data?: unknown) => {
					socket.write(
						`${JSON.stringify({ type: "response", id: wire.id, command: command.type, success: true, data })}\n`,
					);
				});
			}
		});
	});
	servers.push(server);
	await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
	return { sockets };
}

/**
 * w13 lane, QA finding 2: when the daemon was shut down deliberately, the
 * reconnect loop's recoverDaemon refused with the tombstone error on every
 * attempt, but the loop never told the UI — the banner stayed at the generic
 * "正在重连…" for the whole fast budget. The connection must surface the
 * deliberate-stop reason as a reconnecting status the UI can phrase honestly.
 */
describe("daemon agent connection deliberate-stop status", () => {
	it("emits a reconnecting status flagged daemonStopped when recoverDaemon refuses via the tombstone", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-tombstone-status-"));
		tempDirs.push(directory);
		const socketPath = join(directory, "daemon.sock");
		const { sockets } = await startDaemon(socketPath);
		const client = new DaemonClient(socketPath);
		try {
			await client.connect();
			await client.waitForHello();
			const connection = await DaemonAgentConnection.attach(client, "active-1", {
				recoverDaemon: async () => {
					throw new DaemonShutdownTombstonedRecoveryError(socketPath);
				},
				reconnectTimeoutMs: 5_000,
			});

			const daemonStoppedStatus = new Promise<void>((resolveStatus) => {
				connection.subscribe((event) => {
					if (event.type === "connection_status" && event.status === "reconnecting" && event.daemonStopped) {
						resolveStatus();
					}
				});
			});
			// The daemon goes away without a tombstone-carrying close handshake:
			// the socket dies, the reconnect loop starts, and recoverDaemon
			// refuses on every attempt.
			for (const socket of sockets) socket.destroy();
			await daemonStoppedStatus;

			await connection.dispose();
		} finally {
			client.close();
		}
	});

	it("an orderly shutdown close announces itself as a deliberate stop too (the banner chain the QA walked)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-shutdown-status-"));
		tempDirs.push(directory);
		const socketPath = join(directory, "daemon.sock");
		const { sockets } = await startDaemon(socketPath);
		const client = new DaemonClient(socketPath);
		try {
			await client.connect();
			await client.waitForHello();
			const connection = await DaemonAgentConnection.attach(client, "active-1", {
				reconnectTimeoutMs: 5_000,
			});

			const daemonStoppedStatus = new Promise<void>((resolveStatus) => {
				connection.subscribe((event) => {
					if (event.type === "connection_status" && event.status === "reconnecting" && event.daemonStopped) {
						resolveStatus();
					}
				});
			});

			// The orderly `shutdown` the QA reproduced: the daemon announces
			// daemon_closing(shutdown), relays session_closed, and goes away.
			// reconnectAfterShutdown never relaunches it, so the status must say
			// so instead of a bare "reconnecting" that outlives the budget.
			const socket = sockets[0];
			socket.write(`${JSON.stringify({ type: "daemon_closing", reason: "shutdown" })}\n`);
			socket.write(
				`${JSON.stringify({ type: "session_closed", activeSessionId: "active-1", reason: "shutdown" })}\n`,
			);
			await daemonStoppedStatus;

			await connection.dispose();
		} finally {
			client.close();
		}
	});
});
