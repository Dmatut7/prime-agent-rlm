import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES,
	DAEMON_FIRST_PARTY_SESSION_CAPABILITIES,
	DAEMON_SCHEMA_REVISION,
	DAEMON_SLIM_ATTACH_MESSAGE_TAIL,
	DAEMON_SUPPORTED_CLIENT_CAPABILITIES,
	type DaemonAttachResult,
	type DaemonClientCapability,
	type DaemonCommand,
	type DaemonResponse,
	type DaemonSessionSnapshot,
	getDaemonCommandCompatibilities,
	getMessagesWindow,
	meetsDaemonCommandCompatibility,
	missingDeclaredCommandCapability,
	normalizeDeclaredCapabilities,
	slimAttachTranscriptWindow,
	success,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { SnapshotTranscriptCache } from "../src/modes/daemon/snapshot-transcript-cache.js";
import { seedSupervisorRoster } from "./fixtures/roster-seed.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 文档-11 (rev 44): slim attach transcripts. A client that declares the
 * slim_attach_transcript capability attaches with only the tail window of the
 * transcript (DAEMON_SLIM_ATTACH_MESSAGE_TAIL messages) plus the messagesOmitted
 * count, instead of re-receiving and re-parsing the full history on every
 * attach; get_messages before/limit is the backfill path for older pages. The
 * capability is separate from slim_attach because today's first-party client
 * already declares slim_attach while expecting snapshot.messages to be complete.
 */

function fakeMessages(count: number): AgentMessage[] {
	return Array.from({ length: count }, (_, index) => ({
		role: "user",
		content: `message ${index}`,
		timestamp: index,
	}));
}

describe("slimAttachTranscriptWindow", () => {
	it("returns the whole transcript when it fits the window", () => {
		const messages = fakeMessages(3);
		const window = slimAttachTranscriptWindow(messages, 100);
		expect(window.omittedMessages).toBe(0);
		expect(window.messages).toEqual(messages);
	});

	it("keeps only the tail when the transcript exceeds the window", () => {
		const messages = fakeMessages(150);
		const window = slimAttachTranscriptWindow(messages, 100);
		expect(window.messages).toHaveLength(100);
		expect(window.messages[0]).toEqual(messages[50]);
		expect(window.messages[99]).toEqual(messages[149]);
		expect(window.omittedMessages).toBe(50);
		expect(window.messages.length + window.omittedMessages).toBe(messages.length);
	});

	it("clamps a degenerate tail to one message instead of emptying the transcript", () => {
		const messages = fakeMessages(5);
		expect(slimAttachTranscriptWindow(messages, 0).messages).toHaveLength(1);
		expect(slimAttachTranscriptWindow(messages, -3).messages).toHaveLength(1);
		expect(slimAttachTranscriptWindow(messages, 2.7).messages).toHaveLength(2);
	});

	it("handles the empty transcript", () => {
		expect(slimAttachTranscriptWindow([], 100)).toEqual({ messages: [], omittedMessages: 0 });
	});

	it("pins the daemon-side default window size", () => {
		expect(DAEMON_SLIM_ATTACH_MESSAGE_TAIL).toBe(100);
	});
});

describe("getMessagesWindow", () => {
	it("returns the full transcript with its facts when no window is requested", () => {
		const messages = fakeMessages(4);
		expect(getMessagesWindow(messages)).toEqual({ messages, totalMessages: 4, firstIndex: 0 });
	});

	it("returns the page before an exclusive end index", () => {
		const messages = fakeMessages(150);
		const window = getMessagesWindow(messages, 50, 20);
		expect(window.messages).toEqual(messages.slice(30, 50));
		expect(window.totalMessages).toBe(150);
		expect(window.firstIndex).toBe(30);
	});

	it("clamps an out-of-range end index and an overlong limit to the transcript", () => {
		const messages = fakeMessages(10);
		expect(getMessagesWindow(messages, 999)).toEqual({ messages, totalMessages: 10, firstIndex: 0 });
		expect(getMessagesWindow(messages, 4, 999)).toEqual({
			messages: messages.slice(0, 4),
			totalMessages: 10,
			firstIndex: 0,
		});
		expect(getMessagesWindow(messages, 4, 0)).toEqual({ messages: [], totalMessages: 10, firstIndex: 4 });
	});

	it("rejects malformed window fields instead of silently clamping them", () => {
		const messages = fakeMessages(3);
		expect(() => getMessagesWindow(messages, -1)).toThrow(RangeError);
		expect(() => getMessagesWindow(messages, undefined, 1.5)).toThrow(RangeError);
		expect(() => getMessagesWindow(messages, Number.NaN)).toThrow(RangeError);
	});
});

describe("slim_attach_transcript wire registration (rev 44)", () => {
	it("is client-declarable and server-advertised, and survives declaration normalization", () => {
		expect(DAEMON_SUPPORTED_CLIENT_CAPABILITIES).toContain("slim_attach_transcript");
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("slim_attach_transcript");
		expect(DAEMON_FIRST_PARTY_SESSION_CAPABILITIES).toContain("slim_attach_transcript");
		expect(DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES).toContain("slim_attach_transcript");
		expect(normalizeDeclaredCapabilities(["slim_attach_transcript"])).toEqual(["slim_attach_transcript"]);
		expect(DAEMON_SCHEMA_REVISION).toBeGreaterThanOrEqual(44);
	});

	it("keeps bare get_messages legacy and gates only the paginated form", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.get_messages).toEqual({ minProtocol: 7 });
		expect(getDaemonCommandCompatibilities({ type: "get_messages", activeSessionId: "active-1" })).toEqual([
			{ minProtocol: 7 },
		]);
		const gate = { minProtocol: 7, minSchemaRevision: 44, capability: "slim_attach_transcript" };
		expect(
			getDaemonCommandCompatibilities({ type: "get_messages", activeSessionId: "active-1", before: 50 }),
		).toEqual([gate, { minProtocol: 7 }]);
		expect(getDaemonCommandCompatibilities({ type: "get_messages", activeSessionId: "active-1", limit: 50 })).toEqual(
			[gate, { minProtocol: 7 }],
		);
	});

	it("refuses a paginated get_messages for declared connections lacking the capability", () => {
		const command: DaemonCommand = { type: "get_messages", activeSessionId: "active-1", before: 10 };
		// A connection that declared a command-capability set must include the
		// capability to send the paginated form...
		expect(missingDeclaredCommandCapability(true, new Set(["event_sequence"]), command)).toBe(
			"slim_attach_transcript",
		);
		expect(missingDeclaredCommandCapability(true, new Set(["slim_attach_transcript"]), command)).toBeUndefined();
		// ...while an undeclared (legacy) connection keeps the old path and is simply
		// ignored by an old daemon, exactly like omitStreamingMessages on list.
		expect(missingDeclaredCommandCapability(undefined, undefined, command)).toBeUndefined();
	});

	it("stops a new client from depending on the window against an old daemon", () => {
		// Old-daemon direction: the hello advertises neither the revision nor the
		// capability, so the client-side preflight (daemon-client.ts request())
		// refuses to send the paginated command instead of letting the old daemon
		// silently answer with the full list.
		const gate = getDaemonCommandCompatibilities({
			type: "get_messages",
			activeSessionId: "active-1",
			limit: 10,
		})[0]!;
		const oldHello = {
			protocol: { name: "prime-agent.daemon" as const, version: 7 },
			schemaRevision: 43,
			serverCapabilities: ["quota_park_status"] as const,
		};
		expect(meetsDaemonCommandCompatibility(oldHello, gate)).toBe(false);
		const newHello = {
			protocol: { name: "prime-agent.daemon" as const, version: 7 },
			schemaRevision: DAEMON_SCHEMA_REVISION,
			serverCapabilities: [...DAEMON_DEFAULT_SERVER_CAPABILITIES],
		};
		expect(meetsDaemonCommandCompatibility(newHello, gate)).toBe(true);
	});

	it("keeps the supervisor's internal snapshot loads free of the capability so the cache stays full", () => {
		// The supervisor serves slim tails from its one cached full snapshot; if its
		// internal worker load ever declared slim_attach_transcript, the worker would
		// window the cached snapshot itself and every later full attach would be
		// served a tail. Pin the load's capability lists against that drift.
		const source = readFileSync(resolve(__dirname, "../src/modes/daemon/daemon-supervisor.ts"), "utf8");
		const loadBody = source.slice(
			source.indexOf("private async loadWorkerSnapshot("),
			source.indexOf("private async snapshotWithDecodedTranscript("),
		);
		expect(loadBody).toContain('"slim_attach"');
		expect(loadBody).toContain('"quota_park_status"');
		expect(loadBody).not.toContain("slim_attach_transcript");
	});
});

describe("SnapshotTranscriptCache.decodeTailMessages", () => {
	function makeCache(
		messages: AgentMessage[],
		options: { targetChunkBytes?: number } = {},
	): { cache: SnapshotTranscriptCache; dispose: () => void } {
		const cacheRoot = mkdtempSync(join(tmpdir(), "prime-agent-slim-tail-cache-"));
		const cache = new SnapshotTranscriptCache({
			activeSessionId: "active-1",
			snapshotId: "snap-1",
			messages,
			cacheRoot,
			targetChunkBytes: options.targetChunkBytes,
		});
		return { cache, dispose: () => rmSync(cacheRoot, { recursive: true, force: true }) };
	}

	it("reads a tail that fits inside the last chunk", () => {
		const messages = fakeMessages(6);
		const { cache, dispose } = makeCache(messages);
		try {
			expect(cache.chunkCount).toBe(1);
			expect(cache.decodeTailMessages(2)).toEqual(messages.slice(4));
		} finally {
			dispose();
		}
	});

	it("walks chunk boundaries from the end without parsing the whole transfer", () => {
		// Small target chunks spread the messages across many frames; the tail walk
		// must stop as soon as enough messages were collected.
		const messages = fakeMessages(40);
		const { cache, dispose } = makeCache(messages, { targetChunkBytes: 120 });
		try {
			expect(cache.chunkCount).toBeGreaterThan(3);
			expect(cache.decodeTailMessages(7)).toEqual(messages.slice(33));
		} finally {
			dispose();
		}
	});

	it("returns the whole transfer when the count covers it, validating the expected total", () => {
		const messages = fakeMessages(12);
		const { cache, dispose } = makeCache(messages, { targetChunkBytes: 120 });
		try {
			expect(cache.decodeTailMessages(100, 12)).toEqual(messages);
			expect(cache.decodeTailMessages(100, 13)).toBeUndefined();
		} finally {
			dispose();
		}
	});

	it("is not usable while the transfer is incomplete, failed, disposed, or corrupt", () => {
		const cacheRoot = mkdtempSync(join(tmpdir(), "prime-agent-slim-tail-cache-"));
		try {
			const incomplete = new SnapshotTranscriptCache({
				activeSessionId: "active-1",
				snapshotId: "snap-incomplete",
				cacheRoot,
			});
			incomplete.appendEncodedChunk(
				Buffer.from(
					`${JSON.stringify({
						type: "session_snapshot_chunk",
						activeSessionId: "active-1",
						snapshotId: "snap-incomplete",
						index: 0,
						messages: fakeMessages(2),
					})}\n`,
				),
			);
			expect(incomplete.decodeTailMessages(1)).toBeUndefined();

			const failed = new SnapshotTranscriptCache({
				activeSessionId: "active-1",
				snapshotId: "snap-failed",
				messages: fakeMessages(3),
				cacheRoot,
			});
			failed.markFailed(new Error("boom"));
			expect(failed.decodeTailMessages(1)).toBeUndefined();

			const disposed = new SnapshotTranscriptCache({
				activeSessionId: "active-1",
				snapshotId: "snap-disposed",
				messages: fakeMessages(3),
				cacheRoot,
			});
			disposed.dispose();
			expect(disposed.decodeTailMessages(1)).toBeUndefined();

			const corrupt = new SnapshotTranscriptCache({
				activeSessionId: "active-1",
				snapshotId: "snap-corrupt",
				cacheRoot,
			});
			corrupt.appendEncodedChunk(Buffer.from('{"type":"something_else"}\n'));
			corrupt.markComplete();
			expect(corrupt.decodeTailMessages(1)).toBeUndefined();
		} finally {
			rmSync(cacheRoot, { recursive: true, force: true });
		}
	});

	it("rejects a non-positive count", () => {
		const { cache, dispose } = makeCache(fakeMessages(3));
		try {
			expect(cache.decodeTailMessages(0)).toBeUndefined();
		} finally {
			dispose();
		}
	});
});

interface WorkerInternals {
	sessions: Map<string, ActiveSessionState>;
	createSessionSnapshot(
		state: ActiveSessionState,
		capabilities: ReadonlySet<DaemonClientCapability>,
	): Promise<DaemonSessionSnapshot>;
	createConnectionState: ReturnType<typeof vi.fn>;
	buildRlmChildSnapshotsWithPassiveRlmSubagents: ReturnType<typeof vi.fn>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
}

function makeWorkerState(activeSessionId: string, messages: AgentMessage[]): ActiveSessionState {
	return {
		activeSessionId,
		clients: new Set<DaemonSocketClient>(),
		pendingAttaches: 0,
		extensionUiRequests: new Map(),
		eventGeneration: "gen-1",
		lastEventSequence: 0,
		runtime: {
			cwd: "/tmp",
			diagnostics: [],
			metadata: { kind: "top-level", createdAt: 1 },
			session: {
				sessionId: `${activeSessionId}-session`,
				sessionManager: {
					getCwd: () => "/tmp",
					getHeader: () => undefined,
					getBranch: () => [],
				},
				messages,
				state: { streamingMessage: undefined, pendingToolCalls: new Set() },
				unfinishedActionCount: 0,
				getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
				isStreaming: false,
				isCompacting: false,
				isBashRunning: false,
				isSessionActive: false,
				isKernelWorkInFlight: false,
				isQuotaParked: false,
				hasRunningRlmChildren: () => false,
			},
		},
	} as unknown as ActiveSessionState;
}

function makeWorkerDaemon(tempDir: string): { daemon: AgentDaemon; internals: WorkerInternals } {
	const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
		defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
		createRuntime: async () => {
			throw new Error("unexpected runtime creation");
		},
	});
	const internals = daemon as unknown as WorkerInternals;
	internals.createConnectionState = vi.fn(() => ({}));
	internals.buildRlmChildSnapshotsWithPassiveRlmSubagents = vi.fn(async () => []);
	return { daemon, internals };
}

describe("worker slim attach snapshot (rev 44)", () => {
	it("windows the snapshot transcript only for clients that declared the capability", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-slim-attach-worker-"));
		try {
			const { internals } = makeWorkerDaemon(tempDir);
			const messages = fakeMessages(DAEMON_SLIM_ATTACH_MESSAGE_TAIL + 50);
			const state = makeWorkerState("active-slim", messages);

			const slim = await internals.createSessionSnapshot(state, new Set(["slim_attach_transcript"]));
			expect(slim.messages).toHaveLength(DAEMON_SLIM_ATTACH_MESSAGE_TAIL);
			expect(slim.messages[0]).toEqual(messages[50]);
			expect(slim.messagesOmitted).toBe(50);
			// The summary keeps counting the full transcript: the client reconciles
			// messages.length + messagesOmitted against summary.messageCount.
			expect(slim.summary.messageCount).toBe(messages.length);

			// Old clients (and old daemons serving them) get the complete transcript
			// with no marker, on exactly the pre-44 wire.
			const full = await internals.createSessionSnapshot(state, new Set(["slim_attach"]));
			expect(full.messages).toHaveLength(messages.length);
			expect("messagesOmitted" in full).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("omits the marker when the transcript fits the window", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-slim-attach-worker-"));
		try {
			const { internals } = makeWorkerDaemon(tempDir);
			const messages = fakeMessages(3);
			const state = makeWorkerState("active-small", messages);

			const snapshot = await internals.createSessionSnapshot(state, new Set(["slim_attach_transcript"]));
			expect(snapshot.messages).toHaveLength(3);
			expect("messagesOmitted" in snapshot).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("serves paginated get_messages reads with full-transcript facts", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-slim-attach-worker-"));
		try {
			const { internals } = makeWorkerDaemon(tempDir);
			const messages = fakeMessages(150);
			internals.sessions.set("active-paged", makeWorkerState("active-paged", messages));
			const client = { id: "client-1" } as DaemonSocketClient;

			const paged = (await internals.handleCommand(client, {
				type: "get_messages",
				activeSessionId: "active-paged",
				before: 50,
				limit: 20,
			})) as { data: { messages: AgentMessage[]; totalMessages: number; firstIndex: number } };
			expect(paged.data.messages).toEqual(messages.slice(30, 50));
			expect(paged.data.totalMessages).toBe(150);
			expect(paged.data.firstIndex).toBe(30);

			// The bare command keeps its legacy shape: the full list, with the
			// additive facts an old client simply ignores.
			const full = (await internals.handleCommand(client, {
				type: "get_messages",
				activeSessionId: "active-paged",
			})) as { data: { messages: AgentMessage[]; totalMessages: number; firstIndex: number } };
			expect(full.data.messages).toHaveLength(150);
			expect(full.data.totalMessages).toBe(150);
			expect(full.data.firstIndex).toBe(0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("supervisor slim attach serve (rev 44)", () => {
	const activeSessionId = "active-slim-serve";

	function makeSupervisorFixture(options: {
		messageCount: number;
		/** When set, the cached snapshot is in the chunked shape (messages emptied) behind this transfer. */
		chunked?: { targetChunkBytes?: number; fail?: boolean };
		/** Full-attach response the worker serves when a reload fallback runs. */
		workerReloadMessages?: AgentMessage[];
	}) {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-slim-attach-supervisor-"));
		const messages = fakeMessages(options.messageCount);
		const summary: SessionSummary = {
			id: activeSessionId,
			activeSessionId,
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			sessionId: "session-slim",
			cwd: "/tmp/project",
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: options.messageCount,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		};
		let transcript: SnapshotTranscriptCache | undefined;
		const cached = {
			activeSessionId,
			snapshot: { summary, messages: options.chunked ? [] : messages },
			...(options.chunked
				? {
						snapshotStream: {
							id: "snap-slim-1",
							messageCount: options.messageCount,
							targetChunkBytes: options.chunked.targetChunkBytes ?? 4096,
						},
					}
				: {}),
			replay: { status: "complete", toSequence: 0 },
			lastEventSequence: 0,
		} as unknown as DaemonAttachResult;
		if (options.chunked) {
			transcript = new SnapshotTranscriptCache({
				activeSessionId,
				snapshotId: "snap-slim-1",
				messages,
				cacheRoot: tempDir,
				targetChunkBytes: options.chunked.targetChunkBytes,
			});
			if (options.chunked.fail) {
				transcript.markFailed(new Error("transfer died"));
			}
		}
		const worker = {
			descriptor: { workerId: "worker-slim", lifecycle: "ready", pid: 1234 },
			// A connected transport: requireAvailableWorkerClient refuses a client
			// whose socket is gone, which is the state this fixture must not be in.
			client: {
				isConnected: true,
				request: vi.fn(async (command: { type: string }) => {
					if (command.type !== "attach" || options.workerReloadMessages === undefined) {
						throw new Error(`unexpected worker request: ${command.type}`);
					}
					return success(undefined, "attach", {
						activeSessionId,
						snapshot: { summary, messages: options.workerReloadMessages },
						replay: { status: "complete", toSequence: 0 },
						lastEventSequence: 0,
						client: { id: "worker-slim", capabilities: [] },
					});
				}),
			},
			summaries: new Map([[activeSessionId, summary]]),
			snapshotCache: new Map([[activeSessionId, cached]]),
			snapshotTransferFrames: new Map(),
			snapshotLoads: new Map(),
			transcriptCaches: transcript ? new Map([[activeSessionId, transcript]]) : new Map(),
		};
		const client = {
			id: "client-1",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
			streamReconstructor: { seed: vi.fn(), hasPartial: vi.fn(() => false), clear: vi.fn() },
			syncWorkerExtensionUi: vi.fn(async () => {}),
			snapshotCacheRoot: tempDir,
		}) as {
			attachClient(
				socketClient: typeof client,
				command: { type: "attach"; activeSessionId: string; capabilities?: readonly DaemonClientCapability[] },
			): Promise<{
				result: DaemonAttachResult;
				transcript?: SnapshotTranscriptCache;
				releaseTranscript?: () => void;
			}>;
		};
		seedSupervisorRoster(supervisor, worker);
		return {
			supervisor,
			worker,
			client,
			messages,
			cached,
			transcript,
			dispose: () => rmSync(tempDir, { recursive: true, force: true }),
		};
	}

	it("serves the tail window inline from an in-memory cached snapshot, leaving the cache full", async () => {
		const fixture = makeSupervisorFixture({ messageCount: DAEMON_SLIM_ATTACH_MESSAGE_TAIL + 50 });
		try {
			const attached = await fixture.supervisor.attachClient(fixture.client, {
				type: "attach",
				activeSessionId,
				capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "slim_attach_transcript"],
			});
			expect(attached.result.snapshot.messages).toHaveLength(DAEMON_SLIM_ATTACH_MESSAGE_TAIL);
			expect(attached.result.snapshot.messages[0]).toEqual(fixture.messages[50]);
			expect(attached.result.snapshot.messagesOmitted).toBe(50);
			// The window crosses inline: no stream id the client would wait on, and no
			// transfer handoff left pinned for a stream that never starts.
			expect(attached.result.snapshotStream).toBeUndefined();
			expect(attached.transcript).toBeUndefined();
			expect(attached.releaseTranscript).toBeUndefined();

			// The cached snapshot keeps the full transcript (possibly moved behind the
			// chunk cache, exactly like any chunked-capable attach): a later full
			// attach must still decode all messages from it.
			const cachedResult = fixture.worker.snapshotCache.get(activeSessionId) as DaemonAttachResult;
			expect("messagesOmitted" in cachedResult.snapshot).toBe(false);
			const cachedTranscript = fixture.worker.transcriptCaches?.get(activeSessionId);
			expect(cachedTranscript?.decodeMessages(fixture.messages.length)).toHaveLength(fixture.messages.length);
		} finally {
			fixture.dispose();
		}
	});

	it("decodes the tail from the trailing chunks without parsing the whole transfer", async () => {
		const fixture = makeSupervisorFixture({
			messageCount: DAEMON_SLIM_ATTACH_MESSAGE_TAIL + 50,
			chunked: { targetChunkBytes: 4096 },
		});
		try {
			expect(fixture.transcript?.chunkCount).toBeGreaterThan(1);
			const attached = await fixture.supervisor.attachClient(fixture.client, {
				type: "attach",
				activeSessionId,
				// The realistic first-party shape: slim transcript on top of the
				// chunked attach machinery.
				capabilities: [
					"attach_snapshot",
					"event_sequence",
					"slim_attach",
					"chunked_snapshot",
					"slim_attach_transcript",
				],
			});
			expect(attached.result.snapshot.messages).toHaveLength(DAEMON_SLIM_ATTACH_MESSAGE_TAIL);
			expect(attached.result.snapshot.messages[0]).toEqual(fixture.messages[50]);
			expect(attached.result.snapshot.messagesOmitted).toBe(50);
			expect(attached.result.snapshotStream).toBeUndefined();
			expect(attached.transcript).toBeUndefined();
			expect(attached.releaseTranscript).toBeUndefined();
			// The shared chunk cache is untouched and still serves full attaches.
			expect(
				fixture.worker.transcriptCaches?.get(activeSessionId)?.decodeMessages(fixture.messages.length),
			).toHaveLength(fixture.messages.length);
			expect(fixture.transcript?.complete).toBe(true);
		} finally {
			fixture.dispose();
		}
	});

	it("reloads the full snapshot when the cached transfer is not decodable, then windows it", async () => {
		const messages = fakeMessages(DAEMON_SLIM_ATTACH_MESSAGE_TAIL + 10);
		const fixture = makeSupervisorFixture({
			messageCount: DAEMON_SLIM_ATTACH_MESSAGE_TAIL + 10,
			chunked: { fail: true },
			workerReloadMessages: messages,
		});
		try {
			const attached = await fixture.supervisor.attachClient(fixture.client, {
				type: "attach",
				activeSessionId,
				capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "slim_attach_transcript"],
			});
			expect(fixture.worker.client.request).toHaveBeenCalledOnce();
			expect(attached.result.snapshot.messages).toHaveLength(DAEMON_SLIM_ATTACH_MESSAGE_TAIL);
			expect(attached.result.snapshot.messagesOmitted).toBe(10);
		} finally {
			fixture.dispose();
		}
	});

	it("serves an unwindowed transcript when the session fits the window", async () => {
		const fixture = makeSupervisorFixture({ messageCount: 3 });
		try {
			const attached = await fixture.supervisor.attachClient(fixture.client, {
				type: "attach",
				activeSessionId,
				capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "slim_attach_transcript"],
			});
			expect(attached.result.snapshot.messages).toHaveLength(3);
			expect("messagesOmitted" in attached.result.snapshot).toBe(false);
		} finally {
			fixture.dispose();
		}
	});

	it("serves the full transcript to a client that never declared the capability", async () => {
		const fixture = makeSupervisorFixture({ messageCount: DAEMON_SLIM_ATTACH_MESSAGE_TAIL + 50 });
		try {
			const attached = await fixture.supervisor.attachClient(fixture.client, {
				type: "attach",
				activeSessionId,
				capabilities: ["attach_snapshot", "event_sequence", "slim_attach"],
			});
			expect(attached.result.snapshot.messages).toHaveLength(fixture.messages.length);
			expect("messagesOmitted" in attached.result.snapshot).toBe(false);
		} finally {
			fixture.dispose();
		}
	});

	it("never serves a windowed cache entry to a full-transcript client", async () => {
		// A windowed snapshot can enter the supervisor cache only through a worker
		// that filled messagesOmitted unasked; the attach must reload the full
		// snapshot instead of forwarding the gap (and instead of stripping the
		// marker, which would be the same lie without the evidence).
		const messages = fakeMessages(DAEMON_SLIM_ATTACH_MESSAGE_TAIL + 10);
		const fixture = makeSupervisorFixture({ messageCount: 60, workerReloadMessages: messages });
		(fixture.cached.snapshot as DaemonSessionSnapshot).messagesOmitted = 10;
		try {
			const attached = await fixture.supervisor.attachClient(fixture.client, {
				type: "attach",
				activeSessionId,
				capabilities: ["attach_snapshot", "event_sequence", "slim_attach"],
			});
			expect(fixture.worker.client.request).toHaveBeenCalledOnce();
			expect(attached.result.snapshot.messages).toHaveLength(messages.length);
			expect("messagesOmitted" in attached.result.snapshot).toBe(false);
		} finally {
			fixture.dispose();
		}
	});
});
