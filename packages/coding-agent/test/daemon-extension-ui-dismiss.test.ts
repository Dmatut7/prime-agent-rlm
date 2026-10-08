import { describe, expect, it, vi } from "vitest";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	AgentDaemon,
	cancelPendingExtensionUiRequests,
	shouldSendDaemonOutboundToClient,
} from "../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_OUTBOUND_COMPATIBILITY,
	DAEMON_SCHEMA_REVISION,
	DAEMON_SUPPORTED_CLIENT_CAPABILITIES,
	type DaemonOutbound,
} from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import type { PrivateFrame } from "../src/modes/session-worker/private-framing.js";

/**
 * Wave-7 R3-M3: the capability-gated extension_ui_dismiss outbound event. When a
 * daemon-hosted extension dialog settles without a client answer (timeout, abort,
 * session close, another client answering first), the daemon tells the remaining
 * dialog holders to close instead of leaving them up to answer a dead request.
 */

const activeSessionId = "active-dismiss";

function makeClient(id: string, capabilities: readonly string[]): DaemonSocketClient {
	return {
		id,
		socket: { destroyed: false } as DaemonSocketClient["socket"],
		attachedActiveSessionIds: new Set([activeSessionId]),
		detachInput: () => {},
		supportsExtensionUi: capabilities.includes("extension_ui"),
		capabilities: new Set(capabilities as DaemonSocketClient["capabilities"] extends Set<infer C> ? C[] : never),
	} as DaemonSocketClient;
}

function makeState(overrides: Partial<ActiveSessionState> = {}): ActiveSessionState {
	return {
		activeSessionId,
		clients: new Set<DaemonSocketClient>(),
		pendingAttaches: 0,
		extensionUiRequests: new Map(),
		eventGeneration: "generation-dismiss",
		lastEventSequence: 0,
		runtime: { metadata: { kind: "top-level", createdAt: 1 } },
		...overrides,
	} as unknown as ActiveSessionState;
}

describe("extension_ui_dismiss wire registration", () => {
	it("registers the capability and the outbound event at its introducing revision", () => {
		expect(DAEMON_SUPPORTED_CLIENT_CAPABILITIES).toContain("extension_ui_dismiss");
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("extension_ui_dismiss");
		expect(DAEMON_OUTBOUND_COMPATIBILITY.extension_ui_dismiss).toEqual({
			minProtocol: 7,
			minSchemaRevision: 48,
			capability: "extension_ui_dismiss",
		});
		expect(DAEMON_SCHEMA_REVISION).toBeGreaterThanOrEqual(48);
	});
});

describe("extension_ui_dismiss worker-side gate", () => {
	const dismiss: DaemonOutbound = {
		type: "extension_ui_dismiss",
		activeSessionId,
		id: "request-1",
		reason: "timeout",
	};

	it("goes only to clients that declared the capability for that session", () => {
		const declared = makeClient("declared", ["extension_ui", "extension_ui_dismiss"]);
		const undeclared = makeClient("undeclared", ["extension_ui"]);

		expect(shouldSendDaemonOutboundToClient(declared, dismiss)).toBe(true);
		expect(shouldSendDaemonOutboundToClient(undeclared, dismiss)).toBe(false);
	});

	it("follows the per-session capability set over the connection-wide one", () => {
		const client = makeClient("mixed", ["extension_ui", "extension_ui_dismiss"]);
		client.capabilitiesByActiveSessionId = new Map([
			[activeSessionId, new Set(["extension_ui"] as never)],
			["other", new Set(["extension_ui", "extension_ui_dismiss"] as never)],
		]);

		expect(shouldSendDaemonOutboundToClient(client, dismiss)).toBe(false);
		expect(shouldSendDaemonOutboundToClient(client, { ...dismiss, activeSessionId: "other" })).toBe(true);
	});
});

describe("cancelPendingExtensionUiRequests dismissal (R3-M3 'closed')", () => {
	it("announces one closed dismissal per cancelled request, then resolves it cancelled", () => {
		const order: string[] = [];
		const emitExtensionUiDismiss = vi.fn((requestId: string) => {
			order.push(`dismiss:${requestId}`);
		});
		const resolve = vi.fn(() => {
			order.push("resolve");
		});
		const state = makeState({
			emitExtensionUiDismiss,
			extensionUiRequests: new Map([
				["request-1", { resolve }],
				["request-2", { resolve }],
			]),
		});

		cancelPendingExtensionUiRequests(state);

		expect(emitExtensionUiDismiss.mock.calls).toEqual([
			["request-1", "closed"],
			["request-2", "closed"],
		]);
		expect(resolve).toHaveBeenCalledTimes(2);
		expect(resolve).toHaveBeenCalledWith({ cancelled: true });
		// The dismissal lands before the cancelled resolution reaches the extension.
		expect(order).toEqual(["dismiss:request-1", "resolve", "dismiss:request-2", "resolve"]);
		expect(state.extensionUiRequests.size).toBe(0);
	});
});

describe("worker capability normalization", () => {
	function makeWorkerDaemon() {
		const daemon = new AgentDaemon("/tmp/prime-agent-dismiss-normalize.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-dismiss-normalize-agent", cwd: "/tmp" },
			createRuntime: vi.fn(),
			worker: { authenticationToken: "worker-token", workerInstanceId: "instance-1" },
		});
		return daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleWorkerCommand(client: DaemonSocketClient, command: unknown): Promise<void>;
		};
	}

	it("keeps extension_ui_dismiss for a peer that knows it and drops unknown capability names", async () => {
		const daemon = makeWorkerDaemon();
		const state = makeState({
			runtime: {
				metadata: { kind: "top-level", createdAt: 1 },
				diagnostics: [],
				modelFallbackMessage: undefined,
				session: {
					sessionId: "session-dismiss",
					sessionManager: { getCwd: () => "/tmp", getHeader: () => undefined },
					messages: [],
					state: { streamingMessage: undefined, pendingToolCalls: new Set() },
					unfinishedActionCount: 0,
					getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
					isStreaming: false,
					isCompacting: false,
					isSessionActive: false,
					isKernelWorkInFlight: false,
					hasRunningRlmChildren: () => false,
				},
			} as never,
		});
		daemon.sessions.set(activeSessionId, state);
		const supervisor = makeClient("supervisor", []);
		const written: DaemonOutbound[] = [];
		supervisor.socket = {
			destroyed: false,
			write: vi.fn((data: string | Uint8Array) => {
				written.push(JSON.parse(String(data)) as DaemonOutbound);
				return true;
			}),
			writableLength: 0,
		} as unknown as DaemonSocketClient["socket"];

		await daemon.handleWorkerCommand(supervisor, {
			id: "sub-1",
			type: "worker_subscribe",
			activeSessionId,
			capabilities: ["extension_ui", "extension_ui_dismiss", "extension_ui_future" as never],
			supportsExtensionUi: true,
		});

		expect(written.at(-1)).toMatchObject({ id: "sub-1", success: true });
		const perSession = supervisor.capabilitiesByActiveSessionId?.get(activeSessionId);
		expect(perSession).toBeDefined();
		expect([...(perSession ?? [])].sort()).toEqual(["extension_ui", "extension_ui_dismiss"]);
		// The unknown name an old daemon would drop stays dropped here too.
		expect(perSession?.has("extension_ui_future" as never) ?? false).toBe(false);
	});
});

describe("supervisor extension_ui_dismiss relay", () => {
	type RelayHarness = {
		handleWorkerFrame(worker: unknown, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		writeSerialized: ReturnType<typeof vi.fn>;
	};

	function makeRelaySupervisor(clients: DaemonSocketClient[]): {
		supervisor: RelayHarness;
		worker: Record<string, unknown>;
	} {
		const worker = {
			descriptor: { workerId: "worker-dismiss", lifecycle: "ready", pid: 1234 },
			client: { isConnected: true },
			snapshotCache: new Map(),
			snapshotLoads: new Map(),
			transcriptCaches: new Map(),
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			clients: new Set(clients),
			modelChangeNoticeInitiators: new Map(),
			log: vi.fn(),
			writeSerialized: vi.fn(),
		}) as RelayHarness;
		return { supervisor, worker };
	}

	function dismissFrame(): PrivateFrame<DaemonWorkerFrameHeader> {
		const outbound: DaemonOutbound = {
			type: "extension_ui_dismiss",
			activeSessionId,
			id: "request-1",
			reason: "timeout",
		};
		return {
			header: { kind: "outbound", outboundType: "extension_ui_dismiss", activeSessionId, payloadEncoding: "jsonl" },
			payload: Buffer.from(`${JSON.stringify(outbound)}\n`),
		} as PrivateFrame<DaemonWorkerFrameHeader>;
	}

	it("relays to clients that declared the capability, skipping the rest", () => {
		const declared = makeClient("declared", ["extension_ui", "extension_ui_dismiss"]);
		const undeclared = makeClient("undeclared", ["extension_ui"]);
		const { supervisor, worker } = makeRelaySupervisor([declared, undeclared]);

		supervisor.handleWorkerFrame(worker, dismissFrame());

		expect(supervisor.writeSerialized).toHaveBeenCalledTimes(1);
		expect(supervisor.writeSerialized.mock.calls[0]?.[0]).toBe(declared);
		const relayed = JSON.parse(String(supervisor.writeSerialized.mock.calls[0]?.[1])) as DaemonOutbound;
		expect(relayed).toMatchObject({ type: "extension_ui_dismiss", id: "request-1", reason: "timeout" });
	});

	it("never enters snapshot deferral or backpressure catch-up, like the request it settles", () => {
		const declared = makeClient("declared", ["extension_ui", "extension_ui_dismiss"]);
		// A snapshot stream is in flight for this session: ordinary events would be
		// deferred or swapped for a catch-up; a dismissal must not be.
		declared.snapshotActiveSessionIds = new Set([activeSessionId]);
		declared.backpressured = true;
		const { supervisor, worker } = makeRelaySupervisor([declared]);

		supervisor.handleWorkerFrame(worker, dismissFrame());

		expect(supervisor.writeSerialized).toHaveBeenCalledTimes(1);
		expect(declared.deferredSessionPayloads?.size ?? 0).toBe(0);
		expect(declared.catchupActiveSessionIds?.size ?? 0).toBe(0);
	});

	it("sends nothing when no attached client declared the capability", () => {
		const undeclared = makeClient("undeclared", ["extension_ui"]);
		const { supervisor, worker } = makeRelaySupervisor([undeclared]);

		supervisor.handleWorkerFrame(worker, dismissFrame());

		expect(supervisor.writeSerialized).not.toHaveBeenCalled();
	});
});

describe("supervisor worker_subscribe declaration", () => {
	type RequestWorker = (command: unknown, timeoutMs?: number) => Promise<{ success: boolean }>;
	type SubscribeWorkerHarness = {
		subscribeWorker(worker: { client: { requestWorker: RequestWorker } }, activeSessionId: string): Promise<void>;
	};

	function makeDeclarationSupervisor(client: DaemonSocketClient): {
		supervisor: SubscribeWorkerHarness;
		requestWorker: ReturnType<typeof vi.fn<RequestWorker>>;
	} {
		const requestWorker = vi.fn<RequestWorker>(async () => ({ success: true }));
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			clients: new Set([client]),
		}) as SubscribeWorkerHarness;
		return { supervisor, requestWorker };
	}

	function subscribeCommand(requestWorker: ReturnType<typeof vi.fn<RequestWorker>>): {
		type?: string;
		capabilities?: string[];
		supportsExtensionUi?: boolean;
	} {
		const command = requestWorker.mock.calls[0]?.[0] as
			| { type?: string; capabilities?: string[]; supportsExtensionUi?: boolean }
			| undefined;
		if (command === undefined) throw new Error("worker_subscribe was never sent");
		return command;
	}

	it("declares extension_ui_dismiss toward the worker when an attached client shows extension UI", async () => {
		const { supervisor, requestWorker } = makeDeclarationSupervisor(
			makeClient("ui-client", ["extension_ui", "extension_ui_dismiss"]),
		);

		await supervisor.subscribeWorker({ client: { requestWorker } }, activeSessionId);

		const command = subscribeCommand(requestWorker);
		expect(command.type).toBe("worker_subscribe");
		expect(command.supportsExtensionUi).toBe(true);
		expect(command.capabilities).toContain("extension_ui");
		expect(command.capabilities).toContain("extension_ui_dismiss");
	});

	it("omits extension_ui_dismiss when no attached client shows extension UI", async () => {
		const { supervisor, requestWorker } = makeDeclarationSupervisor(makeClient("plain-client", []));

		await supervisor.subscribeWorker({ client: { requestWorker } }, activeSessionId);

		const command = subscribeCommand(requestWorker);
		expect(command.supportsExtensionUi).toBe(false);
		expect(command.capabilities).not.toContain("extension_ui_dismiss");
	});
});
