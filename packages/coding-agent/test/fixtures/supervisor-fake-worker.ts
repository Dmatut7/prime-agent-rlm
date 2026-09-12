import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { getProcessStartId } from "../../src/core/session-lease.js";
import { DAEMON_PROTOCOL_INFO, type DaemonAttachResult } from "../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../src/modes/daemon/daemon-session-list.js";
import {
	DAEMON_WORKER_ROSTER_CAPABILITY,
	type DaemonWorkerDescriptor,
	type DaemonWorkerFrameHeader,
	isDaemonWorkerFrameHeader,
} from "../../src/modes/daemon/daemon-worker-protocol.js";
import { encodePrivateFrame, PrivateFrameDecoder } from "../../src/modes/session-worker/private-framing.js";

/**
 * In-process stand-ins for the pieces a supervisor test needs around a resident
 * worker: a live pid whose identity matches the descriptor, a socket that speaks
 * the worker framing protocol, and the descriptor file the supervisor adopts.
 * Tests drive the supervisor through public surfaces only (sockets and files).
 */

export interface FakeWorkerSession {
	activeSessionId: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	messageCount: number;
}

export interface FakeWorkerOptions {
	socketPath: string;
	session: FakeWorkerSession;
	/** `false` answers nothing after the hello frame, so adoption hangs on its own request. */
	adopt?: boolean;
	/** Answer hello and worker_auth only, so adoption wedges on its next request. */
	hangAfterAuth?: boolean;
	/** Command types this worker never answers, so the supervisor's leg stays in flight. */
	hangCommands?: readonly string[];
	/** Additional sessions this worker reports from `list`, so a roster holds more than the root. */
	extraSessions?: readonly FakeWorkerSession[];
	/**
	 * A real worker exits after the supervisor asks it to shut down; the stand-in
	 * process has to do the same or a stop waits for a process that never leaves.
	 */
	onShutdownRequest?: () => void;
}

export interface FakeWorkerHandle {
	readonly socketPath: string;
	/** Command types the supervisor sent, in arrival order. */
	readonly commands: string[];
	attachCount(): number;
	/** Live supervisor connections to this worker socket. */
	connectionCount(): number;
	/** Makes the next `times` attach requests fail with `message`. */
	failNextAttaches(message: string, times: number): void;
	/** Rejects every later `worker_auth`, so a recovery attempt fails on a non-timeout error. */
	failWorkerAuth(message: string): void;
	/** Destroys the live supervisor connections but keeps listening, so recovery reconnects. */
	dropConnections(): void;
	/** Starts hanging every later request of this type, e.g. `worker_subscribe`. */
	hangCommand(type: string): void;
	/** Pushes a delta frame the supervisor cannot reconstruct, which queues a catch-up for attached clients. */
	pushUnreconstructableDelta(): void;
	/** Pushes an arbitrary outbound frame, e.g. a worker-side session_replaced with a new generation. */
	pushFrame(header: DaemonWorkerFrameHeader, payload: Uint8Array): void;
	close(): Promise<void>;
}

export function fakeWorkerSummary(session: FakeWorkerSession): SessionSummary {
	return {
		id: session.activeSessionId,
		activeSessionId: session.activeSessionId,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		cwd: session.cwd,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: session.messageCount,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

export function fakeWorkerAttachResult(session: FakeWorkerSession, sequence = 1): DaemonAttachResult {
	const summary = fakeWorkerSummary(session);
	const cursor = { generation: `generation-${session.activeSessionId}`, sequence };
	return {
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId: session.activeSessionId,
		snapshot: {
			activeSessionId: session.activeSessionId,
			summary,
			state: {
				activeSessionId: session.activeSessionId,
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
			} as DaemonAttachResult["snapshot"]["state"],
			messages: [],
			lastEventSequence: sequence,
			lastEventCursor: cursor,
		},
		replay: { status: "complete", toSequence: sequence },
		lastEventSequence: sequence,
		lastEventCursor: cursor,
		client: { id: "fake-worker", capabilities: ["attach_snapshot", "event_sequence"] },
	};
}

/** Starts a socket that answers the worker protocol; `adopt: false` leaves every request unanswered. */
export async function startFakeWorker(options: FakeWorkerOptions): Promise<FakeWorkerHandle> {
	const session = options.session;
	const allSessions = [session, ...(options.extraSessions ?? [])];
	const commands: string[] = [];
	const sockets = new Set<Socket>();
	const attachFailures: string[] = [];
	let attachCount = 0;
	let authFailure: string | undefined;
	const hungCommands = new Set<string>(options.hangCommands ?? []);

	const writeFrame = (socket: Socket, header: DaemonWorkerFrameHeader, payload: Uint8Array): void => {
		if (socket.destroyed) {
			return;
		}
		socket.write(encodePrivateFrame<DaemonWorkerFrameHeader>(header, Buffer.from(payload)));
	};

	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => sockets.delete(socket));
		const respond = (requestId: string, command: string, body: Record<string, unknown>): void => {
			writeFrame(
				socket,
				{ kind: "outbound", outboundType: "response", requestId },
				Buffer.from(`${JSON.stringify({ id: requestId, type: "response", command, ...body })}\n`),
			);
		};
		writeFrame(
			socket,
			{ kind: "outbound", outboundType: "daemon_hello" },
			Buffer.from(`${JSON.stringify({ type: "daemon_hello" })}\n`),
		);
		const decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
		socket.on("data", (chunk: Buffer) => {
			for (const frame of decoder.push(chunk)) {
				if (frame.header.kind !== "command") {
					continue;
				}
				let command: { type?: string; activeSessionId?: string };
				try {
					command = JSON.parse(frame.payload.toString("utf8")) as { type?: string };
				} catch {
					continue;
				}
				const type = command.type ?? frame.header.commandType;
				commands.push(type);
				// A shutdown is answered even by a wedged worker: the stand-in process
				// has to leave when the supervisor stops it, or a stop times out.
				if (type === "shutdown" || type === "worker_archive_and_shutdown") {
					respond(frame.header.requestId, type, { success: true });
					options.onShutdownRequest?.();
					continue;
				}
				if (type === "worker_auth") {
					if (authFailure !== undefined) {
						respond(frame.header.requestId, type, { success: false, error: authFailure });
						continue;
					}
					respond(frame.header.requestId, type, {
						success: true,
						data: { capabilities: [DAEMON_WORKER_ROSTER_CAPABILITY] },
					});
					continue;
				}
				if (options.adopt === false || options.hangAfterAuth === true) {
					continue;
				}
				if (hungCommands.has(type)) {
					continue;
				}
				if (type === "list") {
					respond(frame.header.requestId, type, {
						success: true,
						data: {
							sessions: [fakeWorkerSummary(session), ...(options.extraSessions ?? []).map(fakeWorkerSummary)],
						},
					});
					continue;
				}
				if (type === "attach") {
					attachCount++;
					const failure = attachFailures.shift();
					// Answer for the session that was asked about: a supervisor test with
					// more than the root drives catch-ups per session.
					const requested = allSessions.find((candidate) => candidate.activeSessionId === command.activeSessionId);
					if (failure !== undefined) {
						respond(frame.header.requestId, type, { success: false, error: failure });
					} else {
						respond(frame.header.requestId, type, {
							success: true,
							data: fakeWorkerAttachResult(requested ?? session, attachCount),
						});
					}
					continue;
				}
				respond(frame.header.requestId, type, { success: true });
			}
		});
	});
	await new Promise<void>((resolveListen) => server.listen(options.socketPath, resolveListen));
	return {
		socketPath: options.socketPath,
		commands,
		attachCount: () => attachCount,
		connectionCount: () => sockets.size,
		failNextAttaches(message: string, times: number): void {
			for (let index = 0; index < times; index++) {
				attachFailures.push(message);
			}
		},
		failWorkerAuth(message: string): void {
			authFailure = message;
		},
		dropConnections(): void {
			for (const socket of [...sockets]) {
				socket.destroy();
			}
			sockets.clear();
		},
		hangCommand(type: string): void {
			hungCommands.add(type);
		},
		pushUnreconstructableDelta(): void {
			for (const socket of sockets) {
				writeFrame(
					socket,
					{
						kind: "outbound",
						outboundType: "session_event",
						activeSessionId: session.activeSessionId,
						sessionEventType: "message_update",
						payloadEncoding: "assistant-delta",
					},
					Buffer.from("this payload is not json\n"),
				);
			}
		},
		pushFrame(header: DaemonWorkerFrameHeader, payload: Uint8Array): void {
			for (const socket of sockets) {
				writeFrame(socket, header, payload);
			}
		},
		close(): Promise<void> {
			for (const socket of [...sockets]) {
				socket.destroy();
			}
			sockets.clear();
			return new Promise((resolveClose) => server.close(() => resolveClose()));
		},
	};
}

/** A real process whose pid/start identity the descriptor can claim, so identity checks pass. */
export function spawnStandInProcess(): { child: ChildProcess; pid: number; processStartId: string | undefined } {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
	const pid = child.pid;
	if (pid === undefined) {
		throw new Error("Stand-in process did not report a pid");
	}
	return { child, pid, processStartId: getProcessStartId(pid) };
}

export function writeWorkerDescriptor(descriptor: DaemonWorkerDescriptor, descriptorPath: string): void {
	mkdirSync(dirname(descriptorPath), { recursive: true, mode: 0o700 });
	writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
}
