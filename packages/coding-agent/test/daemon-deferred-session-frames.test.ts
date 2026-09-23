import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { DAEMON_CLIENT_STALL_BYTES, type DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonCommand,
	type DaemonOutbound,
	type DaemonResponse,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor, DEFAULT_CLIENT_CATCHUP_RETRY_POLICY } from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import { SnapshotTranscriptCache } from "../src/modes/daemon/snapshot-transcript-cache.js";
import type { PrivateFrame } from "../src/modes/session-worker/private-framing.js";

const activeSessionId = "active-deferred";
const snapshotId = "snapshot-deferred";

function summary(): SessionSummary {
	return {
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "session-deferred",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

function streamedResult(): DaemonAttachResult {
	return {
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId,
		snapshot: {
			activeSessionId,
			summary: summary(),
			state: { activeSessionId, sessionId: "session-deferred" } as DaemonAttachResult["snapshot"]["state"],
			messages: [],
			lastEventSequence: 1,
			lastEventCursor: { generation: "generation-deferred", sequence: 1 },
		},
		replay: { status: "complete", toSequence: 1 },
		lastEventSequence: 1,
		lastEventCursor: { generation: "generation-deferred", sequence: 1 },
		snapshotStream: { id: snapshotId, messageCount: 0, targetChunkBytes: 512 * 1024 },
		client: { id: "client", capabilities: ["chunked_snapshot"] },
	};
}

function sessionEventMessage(sequence: number): DaemonOutbound {
	return {
		type: "session_event",
		activeSessionId,
		event: { type: "session_info_changed", name: `change-${sequence}` },
		meta: {
			id: `${activeSessionId}:${sequence}`,
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId,
			sequence,
			cursor: { generation: "generation-deferred", sequence },
			emittedAt: "2026-01-01T00:00:00.000Z",
		},
	};
}

function socketClient(socket: PassThrough, extra: Partial<DaemonSocketClient> = {}): DaemonSocketClient {
	return {
		id: "client",
		socket: socket as unknown as Socket,
		attachedActiveSessionIds: new Set([activeSessionId]),
		catchupActiveSessionIds: new Set(),
		detachInput: () => {},
		supportsExtensionUi: false,
		capabilities: new Set(["chunked_snapshot"]),
		...extra,
	} as DaemonSocketClient;
}

async function nextMacroTaskTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

interface SupervisorWorkerHarness {
	descriptor: { workerId: string; lifecycle: "ready"; pid: number };
	client?: { close: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> };
	summaries: Map<string, SessionSummary>;
	snapshotCache: Map<string, DaemonAttachResult>;
	transcriptCaches: Map<string, SnapshotTranscriptCache>;
	snapshotGenerations: Map<string, Map<string, unknown>>;
	snapshotLoads: Map<string, Promise<DaemonAttachResult>>;
	intentionalStop: boolean;
	stopRevision: number;
}

describe("deferred session frames during snapshot streams", () => {
	// Dropped upstream worker-side cases (delivers extension prompts / worker: replay /
	// freezes mutable streaming frames / worker deferral limits / worker: stop after *):
	// they pin the worker half of #2260 (deferredSessionOutbounds in daemon-mode.ts),
	// which this merge window did not take. They return with the daemon-mode face; the
	// supervisor half below is complete.

	it.each(["resync", "replacement"] as const)(
		"supervisor: failed %s does not block healthy sessions",
		async (purpose) => {
			const supervisor = new DaemonSupervisor(join(tmpdir(), "catchup-fairness.sock"), {
				defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
				descriptorDir: join(tmpdir(), "catchup-fairness-state"),
				// The fork's catch-up budget retries only transient failures; drive the retryable
				// class with zero jitter so the second pass lands inside vi.waitFor's window.
				catchupRetryPolicy: { ...DEFAULT_CLIENT_CATCHUP_RETRY_POLICY, jitterMs: 0 },
			});
			const socket = new PassThrough();
			const written: DaemonOutbound[] = [];
			socket.on("data", (chunk: Buffer) => written.push(JSON.parse(chunk.toString())));
			const sessions = [activeSessionId, "also-failing", "healthy"];
			const client = socketClient(socket, {
				capabilities: new Set(),
				attachedActiveSessionIds: new Set(sessions),
				catchupActiveSessionIds: new Set(sessions),
				catchupPurposes: new Map(sessions.map((id) => [id, purpose])),
			});
			const internals = supervisor as unknown as {
				attachClient(
					client: DaemonSocketClient,
					command: { activeSessionId: string },
				): Promise<{ result: DaemonAttachResult }>;
				catchUpClient(client: DaemonSocketClient): Promise<void>;
			};
			const attach = vi.spyOn(internals, "attachClient").mockImplementation(async (_client, command) => {
				if (command.activeSessionId !== "healthy")
					throw new Error("Timed out waiting for daemon worker response to attach");
				const result = streamedResult();
				result.activeSessionId =
					result.snapshot.activeSessionId =
					result.snapshot.state.activeSessionId =
						"healthy";
				return { result };
			});
			try {
				await internals.catchUpClient(client);
				expect(attach.mock.calls.map(([, command]) => command.activeSessionId)).toEqual(sessions);
				expect(written).toEqual([
					expect.objectContaining({
						type: purpose === "replacement" ? "session_replaced" : "session_resynced",
						activeSessionId: "healthy",
					}),
				]);
				expect(client.catchupActiveSessionIds).toEqual(new Set(sessions.slice(0, 2)));
				expect(client.catchupRetryTimer).toBeDefined();
				client.catchupActiveSessionIds?.add("healthy");
				client.catchupPurposes?.set("healthy", purpose);
				await vi.waitFor(() => expect(written).toHaveLength(2));
				expect(attach.mock.calls.map(([, command]) => command.activeSessionId)).toEqual([...sessions, ...sessions]);
				expect(written[1]).toMatchObject({ type: written[0]?.type, activeSessionId: "healthy" });
				expect(client.catchupPurposes).toEqual(new Map(sessions.slice(0, 2).map((id) => [id, purpose])));
				expect(client.snapshotActiveSessionCounts?.size ?? 0).toBe(0);
			} finally {
				clearTimeout(client.catchupRetryTimer);
				socket.destroy();
			}
		},
	);

	const supervisorScenarios = [
		"attached",
		"catchup",
		"inline-catchup",
		"failed-catchup",
		"failed-replacement-catchup",
		"failed-inline-catchup",
		"inline-reattach",
		"failed-reattach",
		"failed-new-reattach",
		"detached",
		"replaced",
		"failed",
		"failed-detached",
		"oversized",
		"byte-limit",
		"count-limit",
		"closed",
		"oversized-closed",
		"replaced-closed",
		"pending-closed",
		"backpressured-closed",
	];
	it.each(supervisorScenarios)("supervisor: replay (%s)", async (scenario) => {
		const overflow = scenario.startsWith("oversized") || scenario.endsWith("-limit");
		const closed = scenario.endsWith("closed");
		const reattach = scenario.endsWith("reattach");
		const catchup = scenario.endsWith("catchup");
		const failedCatchup = catchup && scenario.startsWith("failed");
		const purpose = scenario.includes("replacement") ? "replacement" : "resync";
		const supervisor = new DaemonSupervisor(join(tmpdir(), "deferred-frames-supervisor.sock"), {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: join(tmpdir(), "deferred-frames-supervisor-state"),
			// The fork's catch-up budget retries transient failures on a backoff; pin jitter to
			// zero so the 250ms first retry lands inside vi.waitFor's default 1s window.
			catchupRetryPolicy: { ...DEFAULT_CLIENT_CATCHUP_RETRY_POLICY, jitterMs: 0 },
		});
		const worker: SupervisorWorkerHarness = {
			descriptor: { workerId: "worker-deferred", lifecycle: "ready", pid: 987_654 },
			client: { close: vi.fn(), request: vi.fn(async () => ({ success: true })) },
			summaries: new Map([[activeSessionId, summary()]]),
			snapshotCache: new Map<string, DaemonAttachResult>(),
			transcriptCaches: new Map<string, SnapshotTranscriptCache>(),
			snapshotGenerations: new Map<string, Map<string, unknown>>(),
			snapshotLoads: new Map<string, Promise<DaemonAttachResult>>(),
			intentionalStop: false,
			stopRevision: 0,
		};
		const socket = new PassThrough();
		socket.on("error", () => {});
		const written: string[] = [];
		socket.on("data", (chunk: Buffer) => {
			written.push(chunk.toString("utf8"));
			if (scenario === "backpressured-closed" && written.length === 1) socket.pause();
		});
		const client = socketClient(socket);
		const internals = supervisor as unknown as {
			clients: Set<DaemonSocketClient>;
			workers: Map<string, SupervisorWorkerHarness>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
			findWorkerForClient(): Promise<{ worker: SupervisorWorkerHarness; summary: SessionSummary }>;
			attachClient(): Promise<{
				worker: SupervisorWorkerHarness;
				result: DaemonAttachResult;
				transcript?: SnapshotTranscriptCache;
			}>;
			drainClientCatchups(client: DaemonSocketClient): Promise<void>;
			catchUpClient(client: DaemonSocketClient): Promise<void>;
			streamSnapshot(
				client: DaemonSocketClient,
				worker: SupervisorWorkerHarness,
				result: DaemonAttachResult,
				transcript: SnapshotTranscriptCache,
				purpose: "attach",
			): Promise<void>;
			handleWorkerFrame(worker: SupervisorWorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		};
		if (!failedCatchup) vi.spyOn(internals, "catchUpClient").mockResolvedValue();
		internals.clients.add(client);
		internals.workers.set(worker.descriptor.workerId, worker);

		const messages: AgentMessage[] = [
			{
				role: "user",
				content: scenario === "backpressured-closed" ? "x".repeat(128 * 1024) : "stable",
				timestamp: 1,
			},
		];
		const transcript = new SnapshotTranscriptCache({
			activeSessionId,
			snapshotId,
			messages: scenario === "pending-closed" ? undefined : messages,
			cacheRoot: tmpdir(),
		});
		let releaseChunk: () => void = () => {};
		const chunkGate = new Promise<void>((resolve) => {
			releaseChunk = resolve;
		});
		const waitForChunk = transcript.waitForChunk.bind(transcript);
		transcript.waitForChunk = async (index: number, signal?: AbortSignal) => {
			if (index === 1) {
				await chunkGate;
				if (scenario.startsWith("failed")) throw new Error("snapshot failed");
			}
			return waitForChunk(index, signal);
		};

		let stream: Promise<unknown>;
		if (reattach || catchup) {
			if (reattach || scenario.includes("inline")) client.capabilities.clear();
			if (scenario === "failed-new-reattach") client.attachedActiveSessionIds.delete(activeSessionId);
			vi.spyOn(internals, "findWorkerForClient").mockResolvedValue({ worker, summary: summary() });
			vi.spyOn(internals, "attachClient").mockImplementation(async () => {
				const result = { ...streamedResult(), snapshotStream: undefined };
				await chunkGate;
				if (scenario.startsWith("failed")) {
					// The fork's catch-up budget only retries transient failures; a permanent one
					// is a loud give-up (F8) that writes session_snapshot_failed and drops the
					// session from the queue. This file owns deferred replay, so it drives the
					// retryable class; the give-up class is pinned by
					// daemon-supervisor-catchup-retry.test.ts.
					throw new Error(catchup ? "Timed out waiting for daemon worker response to attach" : "reattach failed");
				}
				return { worker, result, transcript };
			});
			if (catchup) {
				client.deferredSessionPayloadsDropped = new Set([activeSessionId]);
				client.catchupActiveSessionIds?.add(activeSessionId);
				client.catchupPurposes = new Map([[activeSessionId, purpose]]);
				stream = failedCatchup ? internals.catchUpClient(client) : internals.drainClientCatchups(client);
			} else {
				client.attachedActiveSessionIds.add("old-session");
				stream = internals.handleCommand(client, {
					type: "reattach",
					activeSessionId: "old-session",
					targetActiveSessionId: activeSessionId,
				});
			}
		} else {
			stream = internals.streamSnapshot(client, worker, streamedResult(), transcript, "attach");
		}
		// The fork's catch-up contract returns a status ("drained" | "retry-later") instead
		// of throwing; normalize it so `error` only ever carries a real rejection.
		const completion = Promise.resolve(stream).then(
			(result) => (result === "drained" || result === "retry-later" ? undefined : result),
			(error: unknown) => error,
		);
		await nextMacroTaskTurn();
		// The stream is parked before the end record; relayed frames are withheld.
		if (scenario.startsWith("replaced")) {
			internals.handleWorkerFrame(worker, {
				header: {
					kind: "outbound",
					outboundType: "session_replaced",
					activeSessionId,
					payloadEncoding: "jsonl",
				},
				payload: Buffer.from(
					`${JSON.stringify({ type: "session_replaced", activeSessionId, state: streamedResult().snapshot.state, messages: [] })}\n`,
				),
			});
		}
		const eventFrame: PrivateFrame<DaemonWorkerFrameHeader> = {
			header: {
				kind: "outbound",
				outboundType: "session_event",
				activeSessionId,
				sessionEventType: "session_info_changed",
				payloadEncoding: "jsonl",
			},
			payload: Buffer.from(
				`${JSON.stringify({
					...sessionEventMessage(2),
					padding: "x".repeat(
						scenario.startsWith("oversized") ? 8 * 1024 * 1024 : scenario === "byte-limit" ? 4 * 1024 * 1024 : 0,
					),
				})}\n`,
			),
		};
		internals.handleWorkerFrame(worker, eventFrame);
		if (scenario === "byte-limit") internals.handleWorkerFrame(worker, eventFrame);
		if (scenario === "count-limit") {
			for (let index = 1; index < 257; index++) internals.handleWorkerFrame(worker, eventFrame);
		}
		if (overflow) {
			expect(client.deferredSessionPayloads?.size ?? 0).toBe(0);
			expect(client.catchupActiveSessionIds?.has(activeSessionId)).toBe(true);
		}
		internals.handleWorkerFrame(worker, {
			header: {
				kind: "outbound",
				outboundType: "session_event",
				activeSessionId,
				sessionEventType: "session_info_changed",
				payloadEncoding: "jsonl",
			},
			payload: Buffer.from(`${JSON.stringify(sessionEventMessage(3))}\n`),
		});

		const closeFrame: PrivateFrame<DaemonWorkerFrameHeader> = {
			header: { kind: "outbound", outboundType: "session_closed", activeSessionId, payloadEncoding: "jsonl" },
			payload: Buffer.from(`${JSON.stringify({ type: "session_closed", activeSessionId, reason: "killed" })}\n`),
		};
		if (catchup) expect(client.deferredSessionPayloads?.get(activeSessionId)?.payloads).toHaveLength(2);
		if (closed && !overflow) internals.handleWorkerFrame(worker, closeFrame);
		if (scenario.endsWith("detached")) client.attachedActiveSessionIds.delete(activeSessionId);
		releaseChunk();
		const error = await completion;
		if (scenario === "backpressured-closed") {
			socket.resume();
			await nextMacroTaskTurn();
		}
		if (closed && overflow) internals.handleWorkerFrame(worker, closeFrame);
		if (scenario.startsWith("failed") && !catchup) expect(error).toBeInstanceOf(Error);
		else expect(error).toBeUndefined();

		const lines = written.join("").split("\n").filter(Boolean);
		const parsed = lines.map((line) => JSON.parse(line) as { type: string });
		expect(parsed.map((entry) => entry.type)).toEqual(
			failedCatchup
				? []
				: scenario === "inline-catchup"
					? ["session_resynced", "session_event", "session_event"]
					: reattach
						? [
								...(scenario === "inline-reattach" ? ["response", "session_detached"] : []),
								...(scenario === "failed-new-reattach"
									? ["session_detached"]
									: ["session_event", "session_event"]),
							]
						: [
								"session_snapshot_begin",
								...(scenario === "pending-closed" ? [] : ["session_snapshot_chunk"]),
								...(closed && !overflow ? ["session_closed"] : []),
								...(closed && !overflow
									? []
									: [scenario.startsWith("failed") ? "session_snapshot_failed" : "session_snapshot_end"]),
								...(closed && overflow ? ["session_closed"] : []),
								...(scenario === "attached" || scenario === "catchup"
									? ["session_event", "session_event"]
									: []),
							],
		);
		expect(client.deferredSessionPayloads?.size ?? 0).toBe(0);
		expect(client.snapshotActiveSessionCounts?.size ?? 0).toBe(0);
		expect(client.snapshotTransferAbortControllers?.size ?? 0).toBe(0);
		expect(client.catchupActiveSessionIds?.size ?? 0).toBe(
			!closed && (scenario === "replaced" || scenario === "failed" || failedCatchup || overflow) ? 1 : 0,
		);
		if (failedCatchup) {
			expect(client.catchupPurposes?.get(activeSessionId)).toBe(purpose);
			expect(client.catchupRetryTimer).toBeDefined();
			internals.handleWorkerFrame(worker, eventFrame);
			await internals.catchUpClient(client);
			expect(written).toHaveLength(0);
			expect(internals.attachClient).toHaveBeenCalledOnce();
			transcript.waitForChunk = waitForChunk;
			const result = streamedResult();
			result.lastEventSequence = result.snapshot.lastEventSequence = 3;
			result.lastEventCursor = result.snapshot.lastEventCursor = { generation: "generation-deferred", sequence: 3 };
			vi.mocked(internals.attachClient).mockResolvedValue({ worker, result, transcript });
			const expected = client.capabilities.has("chunked_snapshot")
				? [
						...(purpose === "replacement" ? ["session_replaced"] : []),
						"session_snapshot_begin",
						"session_snapshot_chunk",
						"session_snapshot_end",
					]
				: ["session_resynced"];
			await vi.waitFor(() => expect(written.map((line) => JSON.parse(line).type)).toEqual(expected));
			expect(client.catchupActiveSessionIds?.size).toBe(0);
			expect(client.catchupRetryTimer).toBeUndefined();
			expect(client.snapshotActiveSessionCounts?.size ?? 0).toBe(0);
			internals.handleWorkerFrame(worker, {
				...eventFrame,
				payload: Buffer.from(`${JSON.stringify(sessionEventMessage(4))}\n`),
			});
			expect(JSON.parse(written.at(-1)!).type).toBe("session_event");
		}
		if (!closed && (scenario === "replaced" || overflow)) {
			const before = written.length;
			const frame: PrivateFrame<DaemonWorkerFrameHeader> = {
				header: { kind: "outbound", outboundType: "session_event", activeSessionId, payloadEncoding: "jsonl" },
				payload: Buffer.from(`${JSON.stringify(sessionEventMessage(4))}\n`),
			};
			internals.handleWorkerFrame(worker, frame);
			expect(written).toHaveLength(before);
			const replacement = internals.streamSnapshot(client, worker, streamedResult(), transcript, "attach");
			internals.handleWorkerFrame(worker, frame);
			await replacement;
			expect(written.map((line) => JSON.parse(line).type).slice(before)).toEqual([
				"session_snapshot_begin",
				"session_snapshot_chunk",
				"session_snapshot_end",
				"session_event",
			]);
		}
		transcript.dispose();
		socket.destroy();
	});

	it("supervisor: preserves replay backpressure when another session's snapshot finishes", () => {
		const supervisor = new DaemonSupervisor(join(tmpdir(), "deferred-backpressure-supervisor.sock"), {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: join(tmpdir(), "deferred-backpressure-state"),
		});
		const socket = new PassThrough();
		const client = socketClient(socket, {
			deferredSessionPayloads: new Map([
				[
					activeSessionId,
					{
						// Past the stall cap: the socket is genuinely stalled, not merely above highWaterMark.
						payloads: [Buffer.alloc(DAEMON_CLIENT_STALL_BYTES + 1), Buffer.from("later")],
						bytes: DAEMON_CLIENT_STALL_BYTES + 6,
					},
				],
			]),
		});
		const internals = supervisor as unknown as {
			reserveSnapshotStream(client: DaemonSocketClient, activeSessionId: string): () => void;
			flushDeferredSessionPayloads(client: DaemonSocketClient, activeSessionId: string): void;
		};
		try {
			const finishOtherSnapshot = internals.reserveSnapshotStream(client, "other-session");
			const write = vi.spyOn(socket, "write");
			internals.flushDeferredSessionPayloads(client, activeSessionId);
			finishOtherSnapshot();
			expect(write).toHaveBeenCalledOnce();
			expect(client.backpressured).toBe(true);
			expect(client.catchupActiveSessionIds?.has(activeSessionId)).toBe(true);
			expect(client.deferredSessionPayloads?.size ?? 0).toBe(0);
		} finally {
			socket.destroy();
		}
	});
});
