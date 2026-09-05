/**
 * B2 regression: streaming_deltas capability. The supervisor forwards compact
 * assistant_stream_delta frames verbatim to clients that negotiated the
 * capability, keeps rebuilding the full message_update payload only for
 * legacy clients, and never changes what legacy clients see.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { createCompactAssistantDelta } from "../../../src/modes/daemon/compact-session-stream.js";
import type { DaemonAttachResult, DaemonOutbound } from "../../../src/modes/daemon/daemon-protocol.js";
import { DAEMON_PROTOCOL_INFO } from "../../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerFrameHeader } from "../../../src/modes/daemon/daemon-worker-protocol.js";
import { SnapshotTranscriptCache } from "../../../src/modes/daemon/snapshot-transcript-cache.js";
import type { PrivateFrame } from "../../../src/modes/session-worker/private-framing.js";

const activeSessionId = "active-b2";
const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function tempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "b2-deltas-"));
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

function summary(): SessionSummary {
	return {
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "session-b2",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

function attachResult(): DaemonAttachResult {
	return {
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId,
		snapshot: {
			activeSessionId,
			summary: summary(),
			state: { activeSessionId, sessionId: "session-b2" } as DaemonAttachResult["snapshot"]["state"],
			messages: [],
			lastEventSequence: 1,
		},
		replay: { status: "complete", toSequence: 1 },
		lastEventSequence: 1,
		client: { id: "supervisor", capabilities: ["chunked_snapshot"] },
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
		descriptor: { workerId: "worker-b2", rootActiveSessionId: activeSessionId, lifecycle: "ready", pid: 4711 },
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
					snapshotId: "snapshot-b2",
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

function socketClient(
	id: string,
	capabilities: readonly string[],
): { client: DaemonSocketClient; lines: () => unknown[] } {
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
		capabilities: new Set(capabilities as never),
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
	if (!delta) {
		throw new Error("expected a compact assistant delta");
	}
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

describe("B2 supervisor streaming deltas", () => {
	it("sends compact deltas to streaming_deltas clients and full updates to legacy clients", async () => {
		const root = tempDirectory();
		const supervisor = new DaemonSupervisor(join(root, "supervisor.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
			descriptorDir: join(root, "state"),
		});
		const worker = workerHarness(root);
		const legacy = socketClient("legacy-client", ["chunked_snapshot"]);
		const modern = socketClient("delta-client", ["chunked_snapshot", "streaming_deltas"]);
		const internals = supervisor as unknown as {
			clients: Set<DaemonSocketClient>;
			handleWorkerFrame(worker: WorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		};
		internals.clients.add(legacy.client);
		internals.clients.add(modern.client);

		internals.handleWorkerFrame(
			worker,
			jsonlFrame({
				type: "session_event",
				activeSessionId,
				event: { type: "message_start", message: assistant([]) },
			}),
		);
		const textStart = assistant([{ type: "text", text: "" }]);
		internals.handleWorkerFrame(
			worker,
			deltaFrame({
				type: "session_event",
				activeSessionId,
				event: {
					type: "message_update",
					message: textStart,
					assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: textStart },
				},
			}),
		);
		const textUpdate = assistant([{ type: "text", text: "hello world" }]);
		internals.handleWorkerFrame(
			worker,
			deltaFrame({
				type: "session_event",
				activeSessionId,
				event: {
					type: "message_update",
					message: textUpdate,
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: "hello world",
						partial: textUpdate,
					},
				},
			}),
		);
		internals.handleWorkerFrame(
			worker,
			jsonlFrame({
				type: "session_event",
				activeSessionId,
				event: { type: "message_end", message: textUpdate },
			}),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));

		const modernMessages = modern.lines() as DaemonOutbound[];
		expect(modernMessages.map((message) => message.type)).toEqual([
			"session_event",
			"assistant_stream_delta",
			"assistant_stream_delta",
			"session_event",
		]);
		const deltas = modernMessages.filter(
			(message): message is Extract<DaemonOutbound, { type: "assistant_stream_delta" }> =>
				message.type === "assistant_stream_delta",
		);
		expect(deltas[0]?.assistantMessageEvent.type).toBe("text_start");
		expect(deltas[1]?.assistantMessageEvent).toMatchObject({ type: "text_delta", delta: "hello world" });

		const legacyMessages = legacy.lines() as DaemonOutbound[];
		// Legacy clients keep seeing ordinary session events with the full message.
		expect(legacyMessages.map((message) => message.type)).toEqual([
			"session_event",
			"session_event",
			"session_event",
			"session_event",
		]);
		const legacyUpdates = legacyMessages.filter(
			(message) => message.type === "session_event" && message.event.type === "message_update",
		);
		// One rebuilt update per compact delta; the last carries the accumulated text.
		expect(legacyUpdates).toHaveLength(2);
		expect(legacyUpdates.at(-1)).toMatchObject({
			type: "session_event",
			event: { type: "message_update", message: { content: [{ type: "text", text: "hello world" }] } },
		});
	});

	it("does not emit any rebuilt full message_update when only streaming_deltas clients are attached", async () => {
		const root = tempDirectory();
		const supervisor = new DaemonSupervisor(join(root, "supervisor.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
			descriptorDir: join(root, "state"),
		});
		const worker = workerHarness(root);
		const modern = socketClient("delta-only-client", ["chunked_snapshot", "streaming_deltas"]);
		const internals = supervisor as unknown as {
			clients: Set<DaemonSocketClient>;
			handleWorkerFrame(worker: WorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		};
		internals.clients.add(modern.client);

		internals.handleWorkerFrame(
			worker,
			jsonlFrame({
				type: "session_event",
				activeSessionId,
				event: { type: "message_start", message: assistant([]) },
			}),
		);
		const textStart = assistant([{ type: "text", text: "" }]);
		internals.handleWorkerFrame(
			worker,
			deltaFrame({
				type: "session_event",
				activeSessionId,
				event: {
					type: "message_update",
					message: textStart,
					assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: textStart },
				},
			}),
		);
		const textUpdate = assistant([{ type: "text", text: "delta only" }]);
		internals.handleWorkerFrame(
			worker,
			deltaFrame({
				type: "session_event",
				activeSessionId,
				event: {
					type: "message_update",
					message: textUpdate,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "delta only", partial: textUpdate },
				},
			}),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));

		const messages = modern.lines() as DaemonOutbound[];
		expect(messages.map((message) => message.type)).toEqual([
			"session_event",
			"assistant_stream_delta",
			"assistant_stream_delta",
		]);
		expect(
			messages.some((message) => message.type === "session_event" && message.event.type === "message_update"),
		).toBe(false);
	});
});
