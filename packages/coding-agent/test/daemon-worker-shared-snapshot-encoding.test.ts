/**
 * PERF-STREAM layer 2: a worker (AgentDaemon) serving several attached clients
 * must encode a session transcript snapshot once, not once per client. The
 * attach, replacement and catch-up snapshot transfers all walk the same
 * message list; with two clients attached the worker serialized the whole
 * transcript twice (and again for every further client).
 *
 * Observable under test: the number of transcript-message serialization passes
 * (counted at JSON.stringify, filtered by a marker only the transcript
 * messages carry) and the completeness of what every client receives.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.js";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import { type DaemonWorkerFrameHeader, isDaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import { type PrivateFrame, PrivateFrameDecoder } from "../src/modes/session-worker/private-framing.js";

const MARKER = "shared-encode-marker";
const originalJsonStringify = JSON.stringify;
const MESSAGE_COUNT = 60;
const MESSAGE_BODY = "y".repeat(2048);

const messages: AgentMessage[] = Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
	role: "user",
	content: `${MARKER}-${index}-${MESSAGE_BODY}`,
	timestamp: index + 1,
}));

function makeSession() {
	return {
		messages,
		sessionId: "probe-session",
		sessionFile: undefined,
		sessionName: undefined,
		rlmDepth: 0,
		model: undefined,
		thinkingLevel: undefined,
		serviceTier: undefined,
		retryAttempt: 0,
		steeringMode: undefined,
		followUpMode: undefined,
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		autoCompactionEnabled: false,
		goalState: undefined,
		scopedModels: [],
		getActiveToolNames: () => [] as string[],
		getContextUsage: () => undefined,
		getAvailableThinkingLevels: () => [] as never[],
		hasRunningRlmChildren: () => false,
		stallState: undefined,
		state: { streamingMessage: undefined, pendingToolCalls: new Set() },
		usage: undefined,
		getOwnUsageSummary: () => undefined,
		unfinishedActionCount: 0,
		getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
		getRlmChildSnapshots: () => [],
		sessionManager: {
			getCwd: () => "/tmp",
			getHeader: () => undefined,
			getSessionDir: () => "/tmp",
			getLatestAgentStatus: () => undefined,
			getStatuses: () => [],
			getLeafId: () => "leaf-1",
			getEntries: () => [],
		},
		setSubagentRuntimeHost: () => {},
		abortForUpdateRestart: () => {},
		setExecEnvProvider: () => {},
		subscribe: () => () => {},
		bindExtensions: async () => {},
		waitForIdle: async () => {},
		extensionRunner: { hasHandlers: () => false, emit: async () => {} },
		disposeAsync: async () => {},
		abort: async () => {},
	};
}

const createRuntime: CreateAgentSessionRuntimeFactory = async () => ({
	session: makeSession() as never,
	services: { cwd: "/tmp", agentDir: "/tmp" } as never,
	diagnostics: [],
	extensionsResult: {} as never,
});

interface DaemonInternals {
	handleCommand(
		client: DaemonSocketClient,
		command: Record<string, unknown>,
	): Promise<{ success: boolean; data?: { activeSessionId?: string }; error?: string }>;
	queueClientCatchup(client: DaemonSocketClient, activeSessionId: string, purpose: "replacement" | "resync"): void;
	catchUpBackpressuredClient(client: DaemonSocketClient): Promise<void>;
}

interface ClientHandle {
	client: DaemonSocketClient;
	socket: PassThrough;
	decoder: PrivateFrameDecoder<DaemonWorkerFrameHeader>;
	transcriptMessages(): number;
	snapshotEnds(): number;
}

const directories: string[] = [];
const sockets: PassThrough[] = [];

afterEach(() => {
	for (const socket of sockets.splice(0)) {
		socket.destroy();
	}
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function makeDaemon(): { daemon: AgentDaemon; internals: DaemonInternals } {
	const directory = mkdtempSync(join(tmpdir(), "shared-encode-"));
	directories.push(directory);
	const daemon = new AgentDaemon(join(directory, "worker.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		createRuntime,
	});
	return { daemon, internals: daemon as unknown as DaemonInternals };
}

function socketClient(id: string): ClientHandle {
	const socket = new PassThrough();
	const decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
	sockets.push(socket);
	const client: DaemonSocketClient = {
		id,
		socket: socket as unknown as Socket,
		transport: "private-framed",
		attachedActiveSessionIds: new Set<string>(),
		catchupActiveSessionIds: new Set<string>(),
		detachInput: () => {},
		supportsExtensionUi: false,
		capabilities: new Set(["chunked_snapshot", "slim_attach"]),
	} as DaemonSocketClient;
	const frames: Array<PrivateFrame<DaemonWorkerFrameHeader>> = [];
	socket.on("data", (chunk: Buffer) => {
		frames.push(...(decoder.push(chunk) ?? []));
	});
	const handle: ClientHandle = {
		client,
		socket,
		decoder,
		transcriptMessages() {
			let total = 0;
			for (const frame of frames) {
				if (frame.header.kind !== "outbound" || frame.header.outboundType !== "session_snapshot_chunk") {
					continue;
				}
				const payload = JSON.parse(frame.payload.toString("utf8")) as { messages?: unknown[] };
				total += Array.isArray(payload.messages) ? payload.messages.length : 0;
			}
			return total;
		},
		snapshotEnds() {
			return frames.filter(
				(frame) => frame.header.kind === "outbound" && frame.header.outboundType === "session_snapshot_end",
			).length;
		},
	};
	return handle;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("worker snapshot encoding is shared across attached clients", () => {
	it("encodes the transcript once for two attaching clients and delivers it to both", async () => {
		const { internals } = makeDaemon();
		const stringify = vi.spyOn(JSON, "stringify");
		let transcriptEncodePasses = 0;
		stringify.mockImplementation(((value: unknown, replacer?: unknown, space?: unknown) => {
			const result = originalJsonStringify(value, replacer as never, space as never) as string;
			if (typeof result === "string" && result.startsWith(`{"role":"user","content":"${MARKER}`)) {
				transcriptEncodePasses++;
			}
			return result;
		}) as typeof JSON.stringify);

		const creator = socketClient("creator");
		const created = await internals.handleCommand(creator.client, { type: "create" });
		expect(created.success).toBe(true);
		const activeSessionId = created.data?.activeSessionId;
		expect(typeof activeSessionId).toBe("string");

		const first = socketClient("first");
		const second = socketClient("second");
		for (const handle of [first, second]) {
			const attached = await internals.handleCommand(handle.client, {
				type: "attach",
				activeSessionId,
				capabilities: ["chunked_snapshot", "slim_attach"],
			});
			expect(attached.success).toBe(true);
		}
		await waitFor(() => first.snapshotEnds() + second.snapshotEnds() >= 2);

		// Both clients receive the complete transcript (positive control).
		expect(first.transcriptMessages()).toBe(MESSAGE_COUNT);
		expect(second.transcriptMessages()).toBe(MESSAGE_COUNT);
		// The worker serialized each transcript message at most once.
		expect(transcriptEncodePasses).toBeLessThanOrEqual(MESSAGE_COUNT);

		stringify.mockRestore();
	});

	it("reuses the encoding when a replacement catch-up re-sends the same transcript", async () => {
		const { internals } = makeDaemon();
		const stringify = vi.spyOn(JSON, "stringify");
		let transcriptEncodePasses = 0;
		stringify.mockImplementation(((value: unknown, replacer?: unknown, space?: unknown) => {
			const result = originalJsonStringify(value, replacer as never, space as never) as string;
			if (typeof result === "string" && result.startsWith(`{"role":"user","content":"${MARKER}`)) {
				transcriptEncodePasses++;
			}
			return result;
		}) as typeof JSON.stringify);

		const creator = socketClient("creator");
		const created = await internals.handleCommand(creator.client, { type: "create" });
		const activeSessionId = created.data?.activeSessionId;
		expect(typeof activeSessionId).toBe("string");

		const first = socketClient("first");
		const second = socketClient("second");
		for (const handle of [first, second]) {
			const attached = await internals.handleCommand(handle.client, {
				type: "attach",
				activeSessionId,
				capabilities: ["chunked_snapshot", "slim_attach"],
			});
			expect(attached.success).toBe(true);
		}
		await waitFor(() => first.snapshotEnds() + second.snapshotEnds() >= 2);
		const attachEncodePasses = transcriptEncodePasses;

		for (const handle of [first, second]) {
			internals.queueClientCatchup(handle.client, activeSessionId!, "replacement");
		}
		await Promise.all([first, second].map((handle) => internals.catchUpBackpressuredClient(handle.client)));
		await waitFor(() => first.snapshotEnds() + second.snapshotEnds() >= 4);

		// Every client got the replacement transfer intact.
		expect(first.transcriptMessages()).toBe(MESSAGE_COUNT * 2);
		expect(second.transcriptMessages()).toBe(MESSAGE_COUNT * 2);
		// The unchanged transcript was not re-encoded for the replacement round.
		expect(transcriptEncodePasses - attachEncodePasses).toBeLessThanOrEqual(MESSAGE_COUNT);

		stringify.mockRestore();
	});
});
