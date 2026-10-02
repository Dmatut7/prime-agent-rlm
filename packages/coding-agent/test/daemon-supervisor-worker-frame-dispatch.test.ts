import { describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import type { PrivateFrame } from "../src/modes/session-worker/private-framing.js";

/**
 * Characterization pins for DaemonSupervisor.handleWorkerFrame's dispatch edges:
 * non-outbound and foreign-source frames are ignored before liveness is touched,
 * roster and heartbeat frames short-circuit the relay, control frames without a
 * session id are swallowed, and every other outbound session frame relays to the
 * attached clients. All tests drive a prototype-only supervisor (no constructor).
 */

type WorkerFixture = {
	descriptor: { workerId: string };
	client?: object;
	pendingClient?: object;
	lastFrameAt: number;
	rosterStale?: boolean;
	heartbeatSnapshotStale?: boolean;
};

type FrameHarness = {
	handleWorkerFrame(worker: WorkerFixture, frame: PrivateFrame<DaemonWorkerFrameHeader>, source?: object): void;
};

function createFrame(
	header: Extract<DaemonWorkerFrameHeader, { kind: "outbound" | "command" }>,
	payload: unknown = {},
): PrivateFrame<DaemonWorkerFrameHeader> {
	return { header, payload: Buffer.from(JSON.stringify(payload)) } as PrivateFrame<DaemonWorkerFrameHeader>;
}

function createWorker(overrides: Partial<WorkerFixture> = {}): WorkerFixture {
	return {
		descriptor: { workerId: "worker-1" },
		client: { name: "live-client" },
		lastFrameAt: 0,
		...overrides,
	};
}

function createSupervisor(overrides: Record<string, unknown> = {}) {
	return Object.assign(Object.create(DaemonSupervisor.prototype), {
		clients: new Set<DaemonSocketClient>(),
		log: vi.fn(),
		...overrides,
	}) as FrameHarness & Record<string, unknown>;
}

describe("daemon supervisor worker frame dispatch", () => {
	it("ignores non-outbound frames without touching liveness", () => {
		const worker = createWorker();
		const supervisor = createSupervisor();

		supervisor.handleWorkerFrame(worker, createFrame({ kind: "command", requestId: "r1", commandType: "attach" }));

		expect(worker.lastFrameAt).toBe(0);
	});

	it("ignores frames from a connection that is neither the live nor the pending client", () => {
		const worker = createWorker({ pendingClient: { name: "pending-client" } });
		const supervisor = createSupervisor();

		supervisor.handleWorkerFrame(worker, createFrame({ kind: "outbound", outboundType: "roster_heartbeat" }), {
			name: "foreign",
		});

		expect(worker.lastFrameAt).toBe(0);
	});

	it("accepts frames from the pending client while the live client is still unauthenticated", () => {
		const pendingClient = { name: "pending-client" };
		const worker = createWorker({ pendingClient });
		const supervisor = createSupervisor();

		supervisor.handleWorkerFrame(
			worker,
			createFrame({ kind: "outbound", outboundType: "roster_heartbeat" }),
			pendingClient,
		);

		expect(worker.lastFrameAt).toBeGreaterThan(0);
	});

	it("consumes roster deltas without relaying them to attached clients", () => {
		const worker = createWorker();
		const consumeWorkerRosterDelta = vi.fn();
		const writeSerialized = vi.fn();
		const client = { attachedActiveSessionIds: new Set(["active-1"]) } as unknown as DaemonSocketClient;
		const supervisor = createSupervisor({
			consumeWorkerRosterDelta,
			writeSerialized,
			clients: new Set([client]),
		});
		const frame = createFrame(
			{ kind: "outbound", outboundType: "roster_delta", activeSessionId: "active-1" },
			{ type: "roster_delta", entries: [] },
		);

		supervisor.handleWorkerFrame(worker, frame, worker.client);

		expect(worker.lastFrameAt).toBeGreaterThan(0);
		expect(consumeWorkerRosterDelta).toHaveBeenCalledWith(worker, frame.payload, worker.client);
		expect(writeSerialized).not.toHaveBeenCalled();
	});

	it("marks heartbeats stale and broadcasts on heartbeats_changed without relaying", () => {
		const worker = createWorker({ heartbeatSnapshotStale: false });
		const broadcastHeartbeatsChanged = vi.fn();
		const writeSerialized = vi.fn();
		const client = { attachedActiveSessionIds: new Set(["active-1"]) } as unknown as DaemonSocketClient;
		const supervisor = createSupervisor({
			broadcastHeartbeatsChanged,
			writeSerialized,
			clients: new Set([client]),
		});

		supervisor.handleWorkerFrame(worker, createFrame({ kind: "outbound", outboundType: "heartbeats_changed" }));

		expect(worker.heartbeatSnapshotStale).toBe(true);
		expect(broadcastHeartbeatsChanged).toHaveBeenCalledTimes(1);
		expect(writeSerialized).not.toHaveBeenCalled();
	});

	it("swallows connection-scoped outbound types even when a session id is present", () => {
		const worker = createWorker();
		const writeSerialized = vi.fn();
		const client = { attachedActiveSessionIds: new Set(["active-1"]) } as unknown as DaemonSocketClient;
		const supervisor = createSupervisor({ writeSerialized, clients: new Set([client]) });

		for (const outboundType of [
			"daemon_hello",
			"response",
			"session_list_progress",
			"session_list_item",
			"session_attached",
			"session_detached",
		] as const) {
			supervisor.handleWorkerFrame(
				worker,
				createFrame({ kind: "outbound", outboundType, activeSessionId: "active-1" }),
			);
		}

		expect(writeSerialized).not.toHaveBeenCalled();
	});

	it("swallows snapshot control frames that carry no session id", () => {
		const worker = createWorker();
		const snapshotGenerationsFor = vi.fn();
		const failWorkerSnapshotCache = vi.fn();
		const log = vi.fn();
		const supervisor = createSupervisor({ snapshotGenerationsFor, failWorkerSnapshotCache, log });

		for (const outboundType of [
			"session_snapshot_begin",
			"session_snapshot_chunk",
			"session_snapshot_end",
			"session_snapshot_failed",
		] as const) {
			supervisor.handleWorkerFrame(worker, createFrame({ kind: "outbound", outboundType }));
		}

		expect(snapshotGenerationsFor).not.toHaveBeenCalled();
		expect(failWorkerSnapshotCache).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
	});

	it("swallows session events that carry no session id", () => {
		const worker = createWorker();
		const writeSerialized = vi.fn();
		const invalidateWorkerSnapshot = vi.fn();
		const client = { attachedActiveSessionIds: new Set(["active-1"]) } as unknown as DaemonSocketClient;
		const supervisor = createSupervisor({ writeSerialized, invalidateWorkerSnapshot, clients: new Set([client]) });

		supervisor.handleWorkerFrame(
			worker,
			createFrame({ kind: "outbound", outboundType: "session_event" }, { type: "session_event" }),
		);

		expect(writeSerialized).not.toHaveBeenCalled();
		expect(invalidateWorkerSnapshot).not.toHaveBeenCalled();
	});

	it("relays a plain session event to attached clients and skips the rest", () => {
		const worker = createWorker();
		const writeSerialized = vi.fn();
		const invalidateWorkerSnapshot = vi.fn();
		const attached = { attachedActiveSessionIds: new Set(["active-1"]) } as unknown as DaemonSocketClient;
		const elsewhere = { attachedActiveSessionIds: new Set(["other"]) } as unknown as DaemonSocketClient;
		const supervisor = createSupervisor({
			writeSerialized,
			invalidateWorkerSnapshot,
			clients: new Set([attached, elsewhere]),
		});
		const frame = createFrame(
			{
				kind: "outbound",
				outboundType: "session_event",
				activeSessionId: "active-1",
				sessionEventType: "agent_end",
			},
			{ type: "session_event" },
		);

		supervisor.handleWorkerFrame(worker, frame);

		expect(invalidateWorkerSnapshot).toHaveBeenCalledTimes(1);
		expect(writeSerialized).toHaveBeenCalledTimes(1);
		expect(writeSerialized).toHaveBeenCalledWith(attached, frame.payload);
	});
});
