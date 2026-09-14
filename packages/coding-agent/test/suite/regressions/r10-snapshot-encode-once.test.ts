import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { DaemonCatalogClient } from "../../../src/modes/daemon/daemon-catalog-process.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import {
	createDaemonCommandEnvelope,
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonOutbound,
} from "../../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import {
	DAEMON_WORKER_ROSTER_CAPABILITY,
	type DaemonWorkerDescriptor,
	type DaemonWorkerFrameHeader,
	isDaemonWorkerFrameHeader,
} from "../../../src/modes/daemon/daemon-worker-protocol.js";
import {
	createSnapshotTranscriptChunks,
	SNAPSHOT_TARGET_CHUNK_BYTES,
	SnapshotTranscriptCache,
} from "../../../src/modes/daemon/snapshot-transcript-cache.js";
import { encodePrivateFrame, PrivateFrameDecoder } from "../../../src/modes/session-worker/private-framing.js";
import { spawnStandInProcess, writeWorkerDescriptor } from "../../fixtures/supervisor-fake-worker.js";

/**
 * One transcript, one encoding.
 *
 * The worker owns the only JSON pass over a snapshot transcript: it hands the supervisor
 * an encoded chunk transfer, chunked clients are forwarded those bytes, and a client that
 * cannot consume chunks is served by decoding them. Before this, a legacy (non-chunked)
 * attach made the supervisor serialize the same messages into new chunk frames when a
 * chunked client showed up, and every legacy attach after a chunked one reloaded the whole
 * snapshot from the worker.
 *
 * Everything here drives public surfaces: a real supervisor on a real socket, a fake
 * worker speaking the real private-frame protocol, and real client connections.
 */

type OutboundWorkerHeader = Extract<DaemonWorkerFrameHeader, { kind: "outbound" }>;

const activeSessionId = "active-r10-encode-once";
const workerSnapshotId = `${activeSessionId}-generation-r10-1`;
const MESSAGE_COUNT = 60;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups
			.pop()?.()
			.catch(() => undefined);
	}
	vi.restoreAllMocks();
});

function transcript(): UserMessage[] {
	const messages: UserMessage[] = [];
	for (let index = 0; index < MESSAGE_COUNT; index++) {
		messages.push({
			role: "user",
			content: `transcript line ${index} ${"x".repeat(4096 + (index % 7) * 512)}`,
			timestamp: 1_700_000_000 + index,
		});
	}
	return messages;
}

function summary(messageCount: number, sessionFile: string, sessionId: string, cwd: string): SessionSummary {
	return {
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId,
		sessionFile,
		cwd,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

interface FakeWorker {
	readonly socketPath: string;
	/** Capabilities of every attach the supervisor sent, in arrival order. */
	readonly attachCapabilities: string[][];
	/** Raw chunk lines the worker itself encoded and pushed, in order. */
	readonly emittedChunkLines: Buffer[];
	attachCount(): number;
	close(): Promise<void>;
}

interface FakeWorkerOptions {
	socketPath: string;
	sessionSummary: SessionSummary;
	messages: readonly AgentMessage[];
	/** `false` answers every attach with inline messages, like a worker that predates the chunk transfer. */
	streamTransfers?: boolean;
}

async function startFakeWorker(options: FakeWorkerOptions): Promise<FakeWorker> {
	const attachCapabilities: string[][] = [];
	const emittedChunkLines: Buffer[] = [];
	let attachCount = 0;
	const sockets = new Set<Socket>();

	const headerFor = (outboundType: OutboundWorkerHeader["outboundType"]): OutboundWorkerHeader => ({
		kind: "outbound",
		outboundType,
		activeSessionId,
		snapshotId: workerSnapshotId,
		payloadEncoding: "jsonl",
	});
	const writeFrame = (socket: Socket, header: DaemonWorkerFrameHeader, payload: Uint8Array): void => {
		if (!socket.destroyed) {
			socket.write(encodePrivateFrame<DaemonWorkerFrameHeader>(header, Buffer.from(payload)));
		}
	};
	const attachResult = (messages: readonly AgentMessage[], sequence: number): DaemonAttachResult => {
		const cursor = { generation: "generation-r10", sequence };
		return {
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId,
			snapshot: {
				activeSessionId,
				summary: options.sessionSummary,
				state: {
					activeSessionId,
					sessionId: options.sessionSummary.sessionId,
					sessionFile: options.sessionSummary.sessionFile,
				} as DaemonAttachResult["snapshot"]["state"],
				messages: [...messages],
				lastEventSequence: sequence,
				lastEventCursor: cursor,
			},
			replay: { status: "complete", toSequence: sequence, toCursor: cursor },
			lastEventSequence: sequence,
			lastEventCursor: cursor,
			client: { id: "fake-worker", capabilities: ["attach_snapshot", "event_sequence"] },
		};
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
				let command: { type?: string; activeSessionId?: string; capabilities?: readonly string[] };
				try {
					command = JSON.parse(frame.payload.toString("utf8")) as typeof command;
				} catch {
					continue;
				}
				const type = command.type ?? frame.header.commandType;
				if (type === "shutdown" || type === "worker_archive_and_shutdown") {
					respond(frame.header.requestId, type, { success: true });
					continue;
				}
				if (type === "worker_auth") {
					respond(frame.header.requestId, type, {
						success: true,
						data: { capabilities: [DAEMON_WORKER_ROSTER_CAPABILITY] },
					});
					continue;
				}
				if (type === "list") {
					respond(frame.header.requestId, type, {
						success: true,
						data: { sessions: [options.sessionSummary] },
					});
					continue;
				}
				if (type === "attach") {
					attachCount++;
					const capabilities = [...(command.capabilities ?? [])];
					attachCapabilities.push(capabilities);
					const sequence = attachCount;
					const streams = options.streamTransfers !== false && capabilities.includes("chunked_snapshot");
					if (!streams) {
						respond(frame.header.requestId, type, {
							success: true,
							data: attachResult(options.messages, sequence),
						});
						continue;
					}
					const streamed = attachResult([], sequence);
					respond(frame.header.requestId, type, {
						success: true,
						data: {
							...streamed,
							snapshotStream: {
								id: workerSnapshotId,
								messageCount: options.messages.length,
								targetChunkBytes: SNAPSHOT_TARGET_CHUNK_BYTES,
							},
						},
					});
					// A real worker streams after answering, on the next turn of the loop.
					setImmediate(() => {
						const { messages: _messages, ...snapshotHeader } = streamed.snapshot;
						writeFrame(
							socket,
							headerFor("session_snapshot_begin"),
							Buffer.from(
								`${JSON.stringify({
									type: "session_snapshot_begin",
									activeSessionId,
									snapshotId: workerSnapshotId,
									snapshot: snapshotHeader,
									messageCount: options.messages.length,
									targetChunkBytes: SNAPSHOT_TARGET_CHUNK_BYTES,
								})}\n`,
							),
						);
						let chunkCount = 0;
						for (const encoded of createSnapshotTranscriptChunks({
							activeSessionId,
							snapshotId: workerSnapshotId,
							messages: options.messages,
							targetChunkBytes: SNAPSHOT_TARGET_CHUNK_BYTES,
						})) {
							emittedChunkLines.push(Buffer.from(encoded));
							writeFrame(socket, headerFor("session_snapshot_chunk"), encoded);
							chunkCount++;
						}
						writeFrame(
							socket,
							headerFor("session_snapshot_end"),
							Buffer.from(
								`${JSON.stringify({
									type: "session_snapshot_end",
									activeSessionId,
									snapshotId: workerSnapshotId,
									chunkCount,
									lastEventSequence: sequence,
									lastEventCursor: { generation: "generation-r10", sequence },
								})}\n`,
							),
						);
					});
					continue;
				}
				respond(frame.header.requestId, type, { success: true });
			}
		});
	});
	await new Promise<void>((resolveListen) => server.listen(options.socketPath, resolveListen));
	return {
		socketPath: options.socketPath,
		attachCapabilities,
		emittedChunkLines,
		attachCount: () => attachCount,
		close(): Promise<void> {
			for (const socket of [...sockets]) {
				socket.destroy();
			}
			sockets.clear();
			return new Promise((resolveClose) => server.close(() => resolveClose()));
		},
	};
}

interface Fixture {
	worker: FakeWorker;
	supervisor: DaemonSupervisor;
	socketPath: string;
	messages: UserMessage[];
	connectLegacyClient(): Promise<DaemonClient>;
	attachLegacy(client: DaemonClient): Promise<DaemonAttachResult>;
	attachChunked(): Promise<{ chunkLines: Buffer[]; outbound: DaemonOutbound[] }>;
	settle(ms: number): Promise<void>;
}

async function startFixture(options: { streamTransfers?: boolean } = {}): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "r10-encode-once-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const sessionDir = join(agentDir, "sessions");
	const descriptorDir = join(agentDir, "daemon-workers");
	const socketPath = join(root, "daemon.sock");
	const workerSocketPath = join(root, "worker.sock");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(descriptorDir, { recursive: true });

	const messages = transcript();
	const manager = SessionManager.create(projectDir, sessionDir);
	for (const message of messages) {
		manager.appendMessage(message);
	}
	manager.flushNow();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) {
		throw new Error("Fixture session did not persist");
	}
	const sessionSummary = summary(messages.length, sessionFile, manager.getSessionId(), projectDir);

	const standIn = spawnStandInProcess();
	const worker = await startFakeWorker({
		socketPath: workerSocketPath,
		sessionSummary,
		messages,
		...(options.streamTransfers === false ? { streamTransfers: false } : {}),
	});

	const now = new Date().toISOString();
	const descriptor: DaemonWorkerDescriptor = {
		version: 2,
		workerId: "worker-r10-encode-once",
		pid: standIn.pid,
		...(standIn.processStartId ? { processStartId: standIn.processStartId } : {}),
		socketPath: workerSocketPath,
		recoveryJournalPath: join(descriptorDir, "worker-r10.recovery.jsonl"),
		orphanProcessJournalPath: join(descriptorDir, "worker-r10.orphans.jsonl"),
		supervisorSocketPath: socketPath,
		authenticationToken: "token-r10",
		rootActiveSessionId: activeSessionId,
		rootSessionId: sessionSummary.sessionId,
		sessionFile,
		sessionDir,
		createdAt: now,
		updatedAt: now,
		lifecycle: "ready",
		createCommand: { type: "create", sessionPath: sessionFile },
		consecutiveFailures: 0,
	};
	writeWorkerDescriptor(descriptor, join(descriptorDir, "worker-r10-encode-once.json"));

	const previousAgentDirEnv = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = agentDir;
	vi.spyOn(DaemonCatalogClient.prototype, "start").mockResolvedValue();
	vi.spyOn(DaemonCatalogClient.prototype, "archive").mockResolvedValue(true);

	const supervisor = new DaemonSupervisor(socketPath, {
		defaultSessionConfig: { cwd: projectDir, agentDir },
		descriptorDir,
	});
	await supervisor.start();

	const clients: DaemonClient[] = [];
	const settle = (ms: number) => new Promise<void>((resolveSettle) => setTimeout(resolveSettle, ms));
	const fixture: Fixture = {
		worker,
		supervisor,
		socketPath,
		messages,
		settle,
		connectLegacyClient: async () => {
			const client = new DaemonClient(socketPath);
			clients.push(client);
			await client.connect(5_000);
			await client.waitForHello(5_000);
			return client;
		},
		attachLegacy: async (client) => {
			const response = await client.request({ type: "attach", activeSessionId }, 15_000);
			if (!response.success || !response.data || typeof response.data !== "object") {
				throw new Error(`Legacy attach failed: ${response.success ? "no data" : response.error}`);
			}
			return response.data as DaemonAttachResult;
		},
		attachChunked: () => attachChunkedClient(socketPath),
	};

	cleanups.push(async () => {
		for (const client of clients.splice(0)) {
			client.close();
		}
		await supervisor.dispose().catch(() => undefined);
		await worker.close().catch(() => undefined);
		if (standIn.child.exitCode === null && standIn.child.signalCode === null) {
			standIn.child.kill("SIGKILL");
		}
		if (previousAgentDirEnv === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDirEnv;
		}
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	await waitForWorkerReady(fixture);
	return fixture;
}

async function waitForWorkerReady(fixture: Fixture): Promise<void> {
	const deadline = Date.now() + 20_000;
	const client = await fixture.connectLegacyClient();
	while (Date.now() < deadline) {
		const response = await client.request({ type: "list" }, 10_000);
		const sessions =
			response.success && response.data && typeof response.data === "object"
				? ((response.data as { sessions?: SessionSummary[] }).sessions ?? [])
				: [];
		if (sessions.some((entry) => entry.workerState === "ready")) {
			return;
		}
		await fixture.settle(50);
	}
	throw new Error("Fixture worker never became ready");
}

/** A raw jsonl client that declares chunked_snapshot and keeps every received line's bytes. */
async function attachChunkedClient(
	socketPath: string,
	timeoutMs = 15_000,
): Promise<{ chunkLines: Buffer[]; outbound: DaemonOutbound[] }> {
	const socket = connect(socketPath);
	const lines: Buffer[] = [];
	const outbound: DaemonOutbound[] = [];
	let pending = Buffer.alloc(0);
	await new Promise<void>((resolveConnect, rejectConnect) => {
		socket.once("connect", () => resolveConnect());
		socket.once("error", rejectConnect);
	});
	socket.on("data", (chunk: Buffer) => {
		pending = Buffer.concat([pending, chunk]);
		let newline = pending.indexOf(0x0a);
		while (newline !== -1) {
			const line = pending.subarray(0, newline + 1);
			pending = pending.subarray(newline + 1);
			lines.push(Buffer.from(line));
			try {
				outbound.push(JSON.parse(line.toString("utf8")) as DaemonOutbound);
			} catch {
				// A partial or non-json line is not part of the assertions below.
			}
			newline = pending.indexOf(0x0a);
		}
	});
	const finished = new Promise<void>((resolveEnd, rejectEnd) => {
		const deadline = Date.now() + timeoutMs;
		const timer = setInterval(() => {
			if (outbound.some((message) => message.type === "session_snapshot_end")) {
				clearInterval(timer);
				resolveEnd();
				return;
			}
			if (Date.now() > deadline) {
				clearInterval(timer);
				rejectEnd(new Error(`No snapshot end frame; saw ${JSON.stringify(outbound).slice(0, 2000)}`));
			}
		}, 10);
	});
	socket.write(
		`${JSON.stringify(
			createDaemonCommandEnvelope(
				{
					type: "attach",
					activeSessionId,
					capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"],
				},
				"chunked-attach",
			),
		)}\n`,
	);
	try {
		await finished;
	} finally {
		socket.destroy();
	}
	await new Promise((resolveSettle) => setTimeout(resolveSettle, 25));
	return {
		chunkLines: lines.filter((line) => line.includes(Buffer.from('"session_snapshot_chunk"'))),
		outbound,
	};
}

function snapshotIdOf(outbound: readonly DaemonOutbound[]): string | undefined {
	for (const message of outbound) {
		if (message.type === "session_snapshot_begin") {
			return message.snapshotId;
		}
	}
	return undefined;
}

function messagesFromChunkLines(chunkLines: readonly Buffer[]): unknown[] {
	const decoded: unknown[] = [];
	for (const line of chunkLines) {
		const frame = JSON.parse(line.toString("utf8")) as { messages?: unknown[] };
		for (const message of frame.messages ?? []) {
			decoded.push(message);
		}
	}
	return decoded;
}

describe("round-10 snapshot transcript is encoded once", () => {
	it("serves a legacy attach from the worker chunk transfer and forwards those exact bytes to a chunked client", async () => {
		const fixture = await startFixture();

		const legacy = await fixture.connectLegacyClient();
		const legacyResult = await fixture.attachLegacy(legacy);

		// The worker was asked for its chunk transfer even though this client cannot read it.
		expect(fixture.worker.attachCapabilities[0]).toContain("chunked_snapshot");
		expect(fixture.worker.attachCount()).toBe(1);
		expect(fixture.worker.emittedChunkLines.length).toBeGreaterThan(0);
		// The legacy client still reads the transcript off the response.
		expect(legacyResult.snapshot.messages).toEqual(fixture.messages);
		expect(legacyResult.snapshotStream).toBeUndefined();

		const chunked = await fixture.attachChunked();
		expect(snapshotIdOf(chunked.outbound)).toBe(workerSnapshotId);
		expect(chunked.chunkLines.length).toBe(fixture.worker.emittedChunkLines.length);
		for (let index = 0; index < chunked.chunkLines.length; index++) {
			// Forwarded bytes, not a second encoding: a re-serialized transfer carries the
			// supervisor's own snapshot id and differs from the worker's line for line.
			expect(chunked.chunkLines[index]!.equals(fixture.worker.emittedChunkLines[index]!)).toBe(true);
		}
		expect(messagesFromChunkLines(chunked.chunkLines)).toEqual(
			fixture.messages.map((message) => JSON.parse(JSON.stringify(message))),
		);
		// The chunked client was served from the cached transfer: no second worker load.
		expect(fixture.worker.attachCount()).toBe(1);
	});

	it("answers a later legacy attach from the cached transfer instead of reloading the snapshot", async () => {
		const fixture = await startFixture();

		const chunked = await fixture.attachChunked();
		expect(chunked.chunkLines.length).toBeGreaterThan(0);
		const attachesAfterChunked = fixture.worker.attachCount();

		const legacy = await fixture.connectLegacyClient();
		const legacyResult = await fixture.attachLegacy(legacy);

		expect(legacyResult.snapshot.messages).toEqual(fixture.messages);
		expect(legacyResult.snapshotStream).toBeUndefined();
		expect(fixture.worker.attachCount()).toBe(attachesAfterChunked);
	});

	it("still serves both client shapes when the worker answers without a chunk transfer", async () => {
		const fixture = await startFixture({ streamTransfers: false });

		const legacy = await fixture.connectLegacyClient();
		const legacyResult = await fixture.attachLegacy(legacy);
		expect(legacyResult.snapshot.messages).toEqual(fixture.messages);
		expect(fixture.worker.emittedChunkLines.length).toBe(0);

		const chunked = await fixture.attachChunked();
		expect(chunked.chunkLines.length).toBeGreaterThan(0);
		// Positive control for the byte-identity check above: it has teeth. When the
		// supervisor is the encoder the transfer carries its own snapshot id, so the
		// worker's id in the first test is what proves those bytes were forwarded.
		expect(snapshotIdOf(chunked.outbound)).not.toBe(workerSnapshotId);
		expect(messagesFromChunkLines(chunked.chunkLines)).toEqual(
			fixture.messages.map((message) => JSON.parse(JSON.stringify(message))),
		);
	});

	it("decodes encoded chunks back into the transcript and refuses a transfer it cannot vouch for", async () => {
		const messages = transcript();
		const cacheRoot = mkdtempSync(join(tmpdir(), "r10-decode-"));
		cleanups.push(async () => {
			rmSync(cacheRoot, { recursive: true, force: true });
		});
		const encoded = [
			...createSnapshotTranscriptChunks({
				activeSessionId,
				snapshotId: workerSnapshotId,
				messages,
				targetChunkBytes: 8 * 1024,
			}),
		];
		expect(encoded.length).toBeGreaterThan(1);

		const cache = new SnapshotTranscriptCache({
			activeSessionId,
			snapshotId: workerSnapshotId,
			cacheRoot,
			targetChunkBytes: 8 * 1024,
		});
		// Incomplete: nothing to vouch for yet.
		cache.appendEncodedChunk(encoded[0]!);
		expect(cache.decodeMessages()).toBeUndefined();
		for (const chunk of encoded.slice(1)) {
			cache.appendEncodedChunk(chunk);
		}
		expect(cache.decodeMessages()).toBeUndefined();
		cache.markComplete();
		expect(cache.decodeMessages()).toEqual(messages.map((message) => JSON.parse(JSON.stringify(message))));
		expect(cache.decodeMessages(messages.length)).toHaveLength(messages.length);
		// A count that does not match the summary is a changed generation, not a transcript.
		expect(cache.decodeMessages(messages.length + 1)).toBeUndefined();
		cache.dispose();
	});
});
