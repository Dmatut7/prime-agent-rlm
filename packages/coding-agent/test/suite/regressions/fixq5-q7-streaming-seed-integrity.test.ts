/**
 * FIX-Q5/FIX-Q7 regressions: streaming-seed continuity around catch-up and
 * attach. During a catch-up the snapshot reservation must cover the whole
 * snapshot load so window deltas are queued instead of forwarded into a
 * cleared client, and attach seeding must never rewind or corrupt the shared
 * reconstruction state.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import type { AgentRosterEntry } from "../../../src/modes/daemon/agent-roster.js";
import {
	CompactAssistantStreamReconstructor,
	createCompactAssistantDelta,
} from "../../../src/modes/daemon/compact-session-stream.js";
import {
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonOutbound,
} from "../../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerFrameHeader } from "../../../src/modes/daemon/daemon-worker-protocol.js";
import { SnapshotTranscriptCache } from "../../../src/modes/daemon/snapshot-transcript-cache.js";
import type { PrivateFrame } from "../../../src/modes/session-worker/private-framing.js";

const activeSessionId = "active-seed-integrity";
const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function tempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "seed-integrity-"));
	directories.push(directory);
	return directory;
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
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
	};
}

function summaryRow(): SessionSummary {
	return {
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "session-seed-integrity",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

/**
 * Upstream moved matchWorkers from worker.summaries to the roster store, so a
 * fake supervisor has to carry the row there or findWorker matches nothing and
 * throws "Unknown active session". The roster row type drops streamingMessage;
 * attach seeding reads that off the cached snapshot summary instead, so the
 * fixture loses nothing by going through the roster shape.
 */
function rosterStub(workerId: string, row: SessionSummary): () => { values: () => AgentRosterEntry[] } {
	const { sessionActions: _sessionActions, diagnostics: _diagnostics, ...slim } = row;
	const entry: AgentRosterEntry = {
		agentId: row.sessionId,
		workerId,
		status: "idle",
		summary: slim as AgentRosterEntry["summary"],
	};
	return () => ({ values: () => [entry] });
}

function attachResult(): DaemonAttachResult {
	return {
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId,
		snapshot: {
			activeSessionId,
			summary: summaryRow(),
			state: { activeSessionId, sessionId: "session-seed-integrity" } as DaemonAttachResult["snapshot"]["state"],
			messages: [],
			lastEventSequence: 1,
		},
		replay: { status: "complete", toSequence: 1 },
		lastEventSequence: 1,
		client: { id: "supervisor", capabilities: ["chunked_snapshot"] },
	};
}

function jsonlFrame(message: DaemonOutbound): PrivateFrame<DaemonWorkerFrameHeader> {
	return {
		header: {
			kind: "outbound",
			outboundType: message.type,
			activeSessionId,
			sessionEventType: message.type === "session_event" ? message.event.type : undefined,
			payloadEncoding: "jsonl",
		},
		payload: Buffer.from(`${JSON.stringify(message)}\n`),
	};
}

function deltaFrame(message: DaemonOutbound): PrivateFrame<DaemonWorkerFrameHeader> {
	const delta = createCompactAssistantDelta(message);
	if (!delta) throw new Error("expected a compact assistant delta");
	return {
		header: {
			kind: "outbound",
			outboundType: "session_event",
			activeSessionId,
			sessionEventType: "message_update",
			payloadEncoding: "assistant-delta",
		},
		payload: Buffer.from(`${JSON.stringify(delta)}\n`),
	};
}

function textUpdateEvent(text: string, delta: string): DaemonOutbound {
	const message = assistant([{ type: "text", text }]);
	return {
		type: "session_event",
		activeSessionId,
		event: {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
		},
	};
}

interface WorkerHarness {
	descriptor: { workerId: string; rootActiveSessionId: string; lifecycle: "ready"; pid: number };
	client: { request: ReturnType<typeof vi.fn> };
	summaries: Map<string, SessionSummary>;
	snapshotCache: Map<string, DaemonAttachResult>;
	transcriptCaches: Map<string, SnapshotTranscriptCache>;
	snapshotGenerations: Map<string, Map<string, unknown>>;
	snapshotLoads: Map<string, Promise<DaemonAttachResult>>;
	intentionalStop: boolean;
	stopRevision: number;
}

function workerHarness(root: string): WorkerHarness {
	const result = attachResult();
	return {
		descriptor: { workerId: "worker-seed", rootActiveSessionId: activeSessionId, lifecycle: "ready", pid: 4712 },
		client: {
			request: vi.fn(async () => {
				throw new Error("unexpected snapshot reload");
			}),
		},
		summaries: new Map([[activeSessionId, result.snapshot.summary]]),
		snapshotCache: new Map([[activeSessionId, result]]),
		transcriptCaches: new Map([
			[
				activeSessionId,
				new SnapshotTranscriptCache({
					activeSessionId,
					snapshotId: "snapshot-seed-integrity",
					cacheRoot: root,
					targetChunkBytes: 1,
				}),
			],
		]),
		snapshotGenerations: new Map(),
		snapshotLoads: new Map(),
		intentionalStop: false,
		stopRevision: 0,
	};
}

function socketClient(id: string): { client: DaemonSocketClient; lines: () => unknown[] } {
	const socket = new PassThrough();
	const received: string[] = [];
	socket.on("data", (chunk: Buffer) => {
		received.push(chunk.toString("utf8"));
	});
	const client: DaemonSocketClient = {
		id,
		socket: socket as unknown as Socket,
		attachedActiveSessionIds: new Set([activeSessionId]),
		catchupActiveSessionIds: new Set(),
		detachInput: () => {},
		supportsExtensionUi: false,
		capabilities: new Set(["chunked_snapshot"]),
	};
	return {
		client,
		lines: () =>
			received
				.join("")
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line)),
	};
}

describe("FIX-Q5 catch-up reservation covers the snapshot load window", () => {
	it("queues window deltas instead of forwarding them into a clearing client", async () => {
		const root = tempDirectory();
		const supervisor = new DaemonSupervisor(join(root, "supervisor.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
			descriptorDir: join(root, "state"),
		});
		const worker = workerHarness(root);
		const legacy = socketClient("legacy-client");
		const internals = supervisor as unknown as {
			clients: Set<DaemonSocketClient>;
			workers: Map<string, WorkerHarness>;
			attachClient: (
				client: DaemonSocketClient,
				command: { type: "attach"; activeSessionId: string; capabilities: unknown[]; supportsExtensionUi: boolean },
			) => Promise<{
				worker: WorkerHarness;
				result: DaemonAttachResult;
				transcript: SnapshotTranscriptCache;
				releaseTranscript?: () => void;
			}>;
			streamSnapshot: ReturnType<typeof vi.fn>;
			queueCatchup: (client: DaemonSocketClient, activeSessionId: string, purpose: "replacement" | "resync") => void;
			catchUpClient: (client: DaemonSocketClient) => Promise<void>;
		};
		internals.clients.add(legacy.client);
		internals.workers.set(worker.descriptor.workerId, worker);

		// Seed the shared reconstructor so the window delta reconstructs cleanly.
		const handleWorkerFrame = (
			supervisor as unknown as {
				handleWorkerFrame(worker: WorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
			}
		).handleWorkerFrame.bind(supervisor);
		handleWorkerFrame(
			worker,
			jsonlFrame({
				type: "session_event",
				activeSessionId,
				event: { type: "message_start", message: assistant([{ type: "text", text: "" }]) },
			}),
		);

		const transcript = worker.transcriptCaches.get(activeSessionId)!;
		let windowDeltaFed = false;
		internals.attachClient = vi.fn(async () => {
			if (!windowDeltaFed) {
				windowDeltaFed = true;
				// A live delta arrives while the replacement snapshot loads.
				handleWorkerFrame(worker, deltaFrame(textUpdateEvent("window-token", "window-token")));
			}
			return { worker, result: attachResult(), transcript, releaseTranscript: undefined };
		});
		internals.streamSnapshot = vi.fn(async () => {});

		internals.queueCatchup(legacy.client, activeSessionId, "replacement");
		await internals.catchUpClient(legacy.client);
		// Round 2 drains the re-queued window delta inside the same catch-up.
		expect(internals.attachClient).toHaveBeenCalledTimes(2);
		expect(legacy.client.catchupActiveSessionIds?.size ?? 0).toBe(0);

		// The window delta must never reach the client mid catch-up; it is
		// re-queued and only delivered by a later, consistent catch-up round.
		const forwarded = legacy.lines() as DaemonOutbound[];
		expect(
			forwarded.some(
				(message) =>
					message.type === "session_event" &&
					message.event.type === "message_update" &&
					JSON.stringify(message).includes("window-token"),
			),
		).toBe(false);
		expect(internals.streamSnapshot).toHaveBeenCalled();
	});
});

describe("FIX-Q7 attach seeding never rewinds or corrupts reconstruction", () => {
	it("does not reseed a live partial when a second client attaches mid-stream", async () => {
		const streamingMessage = assistant([{ type: "text", text: "snapshot-time state" }]);
		const summary = {
			...summaryRow(),
			isStreaming: true,
			activity: "working" as const,
			isSessionActive: true,
			streamingMessage,
			messageCount: 0,
		};
		const result = {
			activeSessionId,
			snapshot: { summary, messages: [] },
		} as unknown as DaemonAttachResult;
		const worker = {
			descriptor: { workerId: "worker-rewind", lifecycle: "ready", pid: 1 },
			client: {},
			summaries: new Map([[activeSessionId, summary]]),
			snapshotCache: new Map([[activeSessionId, result]]),
			snapshotLoads: new Map(),
		};
		const client = {
			id: "client-2",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const seed = vi.fn();
		const clear = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
			streamReconstructor: { seed, clear, hasPartial: vi.fn(() => true) },
			syncWorkerExtensionUi: vi.fn(async () => {}),
			roster: rosterStub(worker.descriptor.workerId, summary),
		}) as {
			attachClient(client: unknown, command: { type: "attach"; activeSessionId: string }): Promise<unknown>;
		};

		await supervisor.attachClient(client, { type: "attach", activeSessionId });

		// A tracked live partial is newer than the attach snapshot; reseeding
		// would rewind every other client's rebuilt stream.
		expect(seed).not.toHaveBeenCalled();
		expect(clear).not.toHaveBeenCalled();
	});

	it("clears instead of seeding from historical messages when idle", async () => {
		const historical = assistant([{ type: "text", text: "old turn" }]);
		const summary = { ...summaryRow(), isStreaming: false };
		const result = {
			activeSessionId,
			snapshot: { summary, messages: [historical] },
		} as unknown as DaemonAttachResult;
		const worker = {
			descriptor: { workerId: "worker-idle", lifecycle: "ready", pid: 1 },
			client: {},
			summaries: new Map([[activeSessionId, summary]]),
			snapshotCache: new Map([[activeSessionId, result]]),
			snapshotLoads: new Map(),
		};
		const client = {
			id: "client-3",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const seed = vi.fn();
		const clear = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
			streamReconstructor: { seed, clear, hasPartial: vi.fn(() => false) },
			syncWorkerExtensionUi: vi.fn(async () => {}),
			roster: rosterStub(worker.descriptor.workerId, summary),
		}) as {
			attachClient(client: unknown, command: { type: "attach"; activeSessionId: string }): Promise<unknown>;
		};

		await supervisor.attachClient(client, { type: "attach", activeSessionId });

		expect(seed).not.toHaveBeenCalled();
		expect(clear).toHaveBeenCalledWith(activeSessionId);
	});

	it("seed clones the message so reconstruction cannot mutate the source", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		const source = assistant([{ type: "text", text: "seed" }]);
		reconstructor.seed(activeSessionId, source);

		const reconstructed = reconstructor.reconstruct({
			type: "assistant_stream_delta",
			activeSessionId,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " grew" },
		});

		expect(reconstructed).toMatchObject({
			event: { type: "message_update", message: { content: [{ type: "text", text: "seed grew" }] } },
		});
		// The seeded source object (a snapshot/summary message) stays untouched.
		expect(source.content[0]).toMatchObject({ type: "text", text: "seed" });
	});
});
