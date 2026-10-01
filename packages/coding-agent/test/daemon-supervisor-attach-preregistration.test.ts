import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonCommand,
	type DaemonOutbound,
	type DaemonResponse,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import type { PrivateFrame } from "../src/modes/session-worker/private-framing.js";

/**
 * Wave-9 attach event window: attachClient used to register the client in
 * attachedActiveSessionIds only after the worker snapshot load returned, so an event
 * relayed during the load was dropped by the fan-out gate and the fresh attach's view
 * froze at snapshot time (spinner forever when the dropped event was turn_end). The
 * attach path now pre-registers and reserves the snapshot stream before the load, the
 * pattern reattach already had: window events defer and replay after the response.
 */

const activeSessionId = "active-attach-window";

function summary(): SessionSummary {
	return {
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "session-attach-window",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

function fullResult(): DaemonAttachResult {
	return {
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId,
		snapshot: {
			activeSessionId,
			summary: summary(),
			state: { activeSessionId, sessionId: "session-attach-window" } as DaemonAttachResult["snapshot"]["state"],
			messages: [],
			lastEventSequence: 1,
			lastEventCursor: { generation: "generation-attach-window", sequence: 1 },
		},
		replay: { status: "complete", toSequence: 1 },
		lastEventSequence: 1,
		lastEventCursor: { generation: "generation-attach-window", sequence: 1 },
		client: { id: "client", capabilities: [] },
	};
}

function relayedEvent(sequence: number): PrivateFrame<DaemonWorkerFrameHeader> {
	const outbound: DaemonOutbound = {
		type: "session_event",
		activeSessionId,
		event: { type: "session_info_changed", name: `change-${sequence}` },
		meta: {
			id: `${activeSessionId}:${sequence}`,
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId,
			sequence,
			cursor: { generation: "generation-attach-window", sequence },
			emittedAt: "2026-01-01T00:00:00.000Z",
		},
	};
	return {
		header: {
			kind: "outbound",
			outboundType: "session_event",
			activeSessionId,
			sessionEventType: "session_info_changed",
			payloadEncoding: "jsonl",
		},
		payload: Buffer.from(`${JSON.stringify(outbound)}\n`),
	};
}

function makeWorker() {
	return {
		descriptor: { workerId: "worker-attach-window", lifecycle: "ready" as const, pid: 987_654 },
		client: { close: vi.fn(), isConnected: true, request: vi.fn(async () => ({ success: true })) },
		summaries: new Map([[activeSessionId, summary()]]),
		snapshotCache: new Map<string, DaemonAttachResult>(),
		transcriptCaches: new Map(),
		snapshotGenerations: new Map(),
		snapshotLoads: new Map(),
		intentionalStop: false,
		stopRevision: 0,
	};
}

type WorkerDouble = ReturnType<typeof makeWorker>;

interface SupervisorInternals {
	clients: Set<DaemonSocketClient>;
	workers: Map<string, WorkerDouble>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	findWorkerForClient(
		client: DaemonSocketClient,
		selector: string,
	): Promise<{ worker: WorkerDouble; summary: SessionSummary }>;
	loadWorkerSnapshot(
		worker: WorkerDouble,
		activeSessionId: string,
		env: Record<string, string> | undefined,
		chunked: boolean,
	): Promise<DaemonAttachResult>;
	handleWorkerFrame(worker: WorkerDouble, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
}

function makeHarness(tempDir: string): {
	supervisor: DaemonSupervisor;
	internals: SupervisorInternals;
	worker: WorkerDouble;
	client: DaemonSocketClient;
	written: string[];
	socket: PassThrough;
} {
	const supervisor = new DaemonSupervisor(join(tempDir, "supervisor.sock"), {
		defaultSessionConfig: { agentDir: tempDir, cwd: "/tmp" },
		descriptorDir: join(tempDir, "supervisor-state"),
	});
	const worker = makeWorker();
	const socket = new PassThrough();
	socket.on("error", () => {});
	const written: string[] = [];
	socket.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
	const client: DaemonSocketClient = {
		id: "client",
		socket: socket as unknown as Socket,
		attachedActiveSessionIds: new Set(),
		detachInput: () => {},
		supportsExtensionUi: false,
		capabilities: new Set(),
	};
	const internals = supervisor as unknown as SupervisorInternals;
	internals.clients.add(client);
	internals.workers.set(worker.descriptor.workerId, worker);
	return { supervisor, internals, worker, client, written, socket };
}

describe("attach pre-registration (wave-9 daemon event window)", () => {
	let tempDir: string;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("defers a worker event relayed during the snapshot load and replays it after the attach response", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-attach-prereg-"));
		const { internals, worker, client, written, socket } = makeHarness(tempDir);
		try {
			let releaseLoad!: () => void;
			const loadGate = new Promise<void>((resolve) => {
				releaseLoad = resolve;
			});
			let markLoadStarted!: () => void;
			const loadStarted = new Promise<void>((resolve) => {
				markLoadStarted = resolve;
			});
			vi.spyOn(internals, "findWorkerForClient").mockResolvedValue({ worker, summary: summary() });
			vi.spyOn(internals, "loadWorkerSnapshot").mockImplementation(async () => {
				markLoadStarted();
				await loadGate;
				return fullResult();
			});

			const attach = internals.handleCommand(client, { type: "attach", activeSessionId });
			await loadStarted;
			// The pre-registration is in effect while the load is parked.
			expect(client.attachedActiveSessionIds.has(activeSessionId)).toBe(true);
			expect(client.snapshotActiveSessionIds?.has(activeSessionId)).toBe(true);

			internals.handleWorkerFrame(worker, relayedEvent(2));
			// Withheld, not dropped and not delivered ahead of the snapshot.
			expect(written).toEqual([]);
			expect(client.deferredSessionPayloads?.get(activeSessionId)?.payloads).toHaveLength(1);

			releaseLoad();
			await expect(attach).resolves.toBeUndefined();

			expect(written).toHaveLength(2);
			const response = JSON.parse(written[0]!) as { type: string; command: string; success: boolean };
			expect(response).toMatchObject({ type: "response", command: "attach", success: true });
			const replayed = JSON.parse(written[1]!) as { type: string; activeSessionId: string };
			expect(replayed).toMatchObject({ type: "session_event", activeSessionId });
			// The reservation lifted and the buffer drained.
			expect(client.snapshotActiveSessionIds?.has(activeSessionId) ?? false).toBe(false);
			expect(client.deferredSessionPayloads?.has(activeSessionId) ?? false).toBe(false);
		} finally {
			socket.destroy();
		}
	});

	it("rolls the pre-registration back when the snapshot load fails", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-attach-prereg-fail-"));
		const { internals, worker, client, written, socket } = makeHarness(tempDir);
		try {
			let releaseLoad!: () => void;
			const loadGate = new Promise<void>((resolve) => {
				releaseLoad = resolve;
			});
			let markLoadStarted!: () => void;
			const loadStarted = new Promise<void>((resolve) => {
				markLoadStarted = resolve;
			});
			vi.spyOn(internals, "findWorkerForClient").mockResolvedValue({ worker, summary: summary() });
			vi.spyOn(internals, "loadWorkerSnapshot").mockImplementation(async () => {
				markLoadStarted();
				await loadGate;
				throw new Error("worker gone");
			});

			// handleCommand reports the failure through the caller's catch in the real
			// command loop; driven directly, it rejects.
			const attach = internals.handleCommand(client, { type: "attach", activeSessionId });
			const settled = expect(attach).rejects.toThrow("worker gone");
			await loadStarted;
			internals.handleWorkerFrame(worker, relayedEvent(2));
			releaseLoad();
			await settled;

			expect(client.attachedActiveSessionIds.has(activeSessionId)).toBe(false);
			expect(client.snapshotActiveSessionIds?.has(activeSessionId) ?? false).toBe(false);
			expect(client.snapshotStreaming ?? false).toBe(false);
			expect(client.deferredSessionPayloads?.has(activeSessionId) ?? false).toBe(false);
			// Only the failure report reaches the client; the withheld event is discarded.
			const events = written.filter((line) => (JSON.parse(line) as { type: string }).type === "session_event");
			expect(events).toEqual([]);
		} finally {
			socket.destroy();
		}
	});
});
