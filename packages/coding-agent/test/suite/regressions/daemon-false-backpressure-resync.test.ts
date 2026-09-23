import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
	type ActiveSessionState,
	DAEMON_CLIENT_STALL_BYTES,
	type DaemonSocketClient,
} from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import type { DaemonAttachResult } from "../../../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerFrameHeader } from "../../../src/modes/daemon/daemon-worker-protocol.js";
import type { PrivateFrame } from "../../../src/modes/session-worker/private-framing.js";

/**
 * `socket.write()` returning false only means the queue passed highWaterMark (64 KiB).
 * On macOS' 8 KiB unix-socket buffer one ~16 KB tool result written four times trips
 * it, and the daemon used to treat that as a stalled client: it dropped every later
 * event and sent a full `session_resynced` snapshot on drain, rebuilding the whole
 * chat every few seconds. Only a queue past DAEMON_CLIENT_STALL_BYTES is a stall.
 */

const activeSessionId = "active-false-backpressure";
const BUFFERED_BELOW_CAP = 256 * 1024;

type FakeSocket = EventEmitter & {
	destroyed: boolean;
	writableLength: number;
	write: ReturnType<typeof vi.fn>;
};

function fakeSocket(writableLength: number, writes: string[]): FakeSocket {
	const write = vi.fn((data: unknown) => {
		writes.push(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
		return false;
	});
	return Object.assign(new EventEmitter(), { destroyed: false, writableLength, write });
}

function errorMessage(error: string) {
	return {
		type: "extension_error" as const,
		activeSessionId,
		extensionPath: "/tmp/extension.ts",
		event: "load",
		error,
	};
}

function workerDaemon(writableLength: number) {
	const daemon = new AgentDaemon("/tmp/prime-agent-false-backpressure.sock", {
		defaultSessionConfig: { agentDir: "/tmp/prime-agent-false-backpressure-agent", cwd: "/tmp" },
		createRuntime: async () => {
			throw new Error("unexpected runtime creation");
		},
	});
	const state = {
		activeSessionId,
		clients: new Set(),
		pendingAttaches: 0,
		lastEventSequence: 0,
		eventGeneration: "generation-1",
		runtime: { metadata: { kind: "subagent", createdAt: 1 } },
	} as unknown as ActiveSessionState;
	const writes: string[] = [];
	const socket = fakeSocket(0, writes);
	const internals = daemon as unknown as {
		clients: Set<DaemonSocketClient>;
		sessions: Map<string, ActiveSessionState>;
		handleConnection(socket: Socket): void;
		createAttachResult(client: DaemonSocketClient, state: ActiveSessionState): DaemonAttachResult;
		broadcastToSession(state: ActiveSessionState, message: ReturnType<typeof errorMessage>): void;
	};
	internals.handleConnection(socket as unknown as Socket);
	const client = [...internals.clients][0]!;
	client.attachedActiveSessionIds.add(activeSessionId);
	state.clients.add(client);
	internals.sessions.set(activeSessionId, state);
	internals.createAttachResult = () =>
		({
			activeSessionId,
			snapshot: { lastEventSequence: state.lastEventSequence },
			lastEventSequence: state.lastEventSequence,
		}) as unknown as DaemonAttachResult;
	// Drop the daemon_hello written on connect, then apply the queue depth under test.
	writes.length = 0;
	socket.writableLength = writableLength;
	return { internals, state, client, socket, writes };
}

function supervisorRelay(writableLength: number) {
	const writes: string[] = [];
	const socket = fakeSocket(writableLength, writes);
	const client = {
		id: "client-1",
		socket,
		attachedActiveSessionIds: new Set([activeSessionId]),
		catchupActiveSessionIds: new Set<string>(),
		backpressured: false,
		supportsExtensionUi: false,
		capabilities: new Set(),
	} as unknown as DaemonSocketClient;
	const worker = {
		snapshotCache: new Map(),
		transcriptCaches: new Map(),
		incomingTranscriptActiveSessionIds: new Set(),
		duplicateIncomingTranscriptChunkIndexes: new Map(),
		snapshotTransferFrames: new Map(),
	};
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		clients: new Set([client]),
		streamReconstructor: { observe: vi.fn(), hasPartial: vi.fn(() => false) },
		catchUpClient: vi.fn(async () => undefined),
		invalidateWorkerSnapshot: vi.fn(),
	}) as {
		handleWorkerFrame(residentWorker: typeof worker, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		flushDeferredSessionPayloads(client: DaemonSocketClient, activeSessionId: string): void;
		writeSnapshotBuffer(client: DaemonSocketClient, buffer: Uint8Array): Promise<boolean>;
	};
	const frame = (error: string): PrivateFrame<DaemonWorkerFrameHeader> => ({
		header: { kind: "outbound", outboundType: "extension_error", activeSessionId },
		payload: Buffer.from(`${JSON.stringify(errorMessage(error))}\n`),
	});
	return { supervisor, worker, client, socket, writes, frame };
}

function errorsOf(writes: string[]): string[] {
	return writes.map((line) => (JSON.parse(line) as { error?: string }).error ?? "");
}

describe("daemon false backpressure resync", () => {
	it("worker: keeps streaming in order while the queue is above highWaterMark but below the stall cap", async () => {
		const { internals, state, client, socket, writes } = workerDaemon(BUFFERED_BELOW_CAP);

		for (const error of ["first", "second", "third"]) {
			internals.broadcastToSession(state, errorMessage(error));
		}

		expect(errorsOf(writes)).toEqual(["first", "second", "third"]);
		expect(client.backpressured).not.toBe(true);
		expect(client.catchupActiveSessionIds).toEqual(new Set());

		socket.emit("drain");
		await Promise.resolve();
		expect(writes.some((line) => line.includes('"session_resynced"'))).toBe(false);
	});

	it("worker: a queue past the stall cap still drops events and catches up on drain", async () => {
		const { internals, state, client, socket, writes } = workerDaemon(DAEMON_CLIENT_STALL_BYTES + 1);

		internals.broadcastToSession(state, errorMessage("first"));
		expect(client.backpressured).toBe(true);
		internals.broadcastToSession(state, errorMessage("skipped"));

		expect(errorsOf(writes)).toEqual(["first"]);
		expect(client.catchupActiveSessionIds).toEqual(new Set([activeSessionId]));

		socket.writableLength = 0;
		socket.write.mockImplementation((data: unknown) => {
			writes.push(String(data));
			return true;
		});
		socket.emit("drain");
		await vi.waitFor(() => expect(writes).toHaveLength(2));
		expect(JSON.parse(writes[1]!)).toMatchObject({ type: "session_resynced", activeSessionId });
		expect(client.catchupActiveSessionIds).toEqual(new Set());
	});

	it("supervisor: relays in order while the queue is above highWaterMark but below the stall cap", () => {
		const { supervisor, worker, client, writes, frame } = supervisorRelay(BUFFERED_BELOW_CAP);

		for (const error of ["first", "second", "third"]) {
			supervisor.handleWorkerFrame(worker, frame(error));
		}

		expect(errorsOf(writes)).toEqual(["first", "second", "third"]);
		expect(client.backpressured).toBe(false);
		expect(client.catchupActiveSessionIds).toEqual(new Set());
	});

	it("supervisor: replays every deferred payload while below the stall cap", () => {
		const { supervisor, client, writes } = supervisorRelay(BUFFERED_BELOW_CAP);
		const payloads = ["first", "second"].map((error) => Buffer.from(`${JSON.stringify(errorMessage(error))}\n`));
		client.deferredSessionPayloads = new Map([[activeSessionId, { payloads, bytes: 64 }]]);

		supervisor.flushDeferredSessionPayloads(client, activeSessionId);

		expect(errorsOf(writes)).toEqual(["first", "second"]);
		expect(client.backpressured).toBe(false);
		expect(client.catchupActiveSessionIds).toEqual(new Set());
	});

	it("supervisor: a queue past the stall cap still drops relays and queues a catch-up", () => {
		const { supervisor, worker, client, writes, frame } = supervisorRelay(DAEMON_CLIENT_STALL_BYTES + 1);

		supervisor.handleWorkerFrame(worker, frame("first"));
		expect(client.backpressured).toBe(true);
		supervisor.handleWorkerFrame(worker, frame("skipped"));

		expect(errorsOf(writes)).toEqual(["first"]);
		expect(client.catchupActiveSessionIds).toEqual(new Set([activeSessionId]));
	});

	it("supervisor: snapshot chunks still pace on drain below the cap without marking the client stalled", async () => {
		const { supervisor, client, socket } = supervisorRelay(BUFFERED_BELOW_CAP);

		let settled = false;
		const pending = supervisor.writeSnapshotBuffer(client, Buffer.from("chunk")).then((value) => {
			settled = true;
			return value;
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		expect(client.backpressured).toBe(false);

		socket.emit("drain");
		await expect(pending).resolves.toBe(true);
	});
});
