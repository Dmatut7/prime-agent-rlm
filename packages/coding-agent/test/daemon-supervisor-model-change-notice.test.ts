import { describe, expect, it, vi } from "vitest";
import { MODEL_CHANGE_ORIGIN_NOTICE_CUSTOM_TYPE } from "../src/core/agent-session.js";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import type { DaemonCommand, DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import type { PrivateFrame } from "../src/modes/session-worker/private-framing.js";

/**
 * wave-42 SETMODEL-VIS (supervisor half): a real client's set_model/cycle_model
 * crosses the supervisor as a forward, so the worker cannot know which real
 * client initiated the switch - exempting at the worker's own broadcast would
 * silence the supervisor link and with it every real client. The supervisor
 * stamps the forward with a changeNoticeToken, registers token -> initiator for
 * the forward's duration, and the relay skips exactly that client for the
 * model_change_origin_notice pair. Direct session-plane peers never cross this
 * path (the worker exempts them itself; covered by
 * daemon-model-change-notice.test.ts).
 *
 * Prototype-only supervisor harness, the daemon-supervisor-worker-frame-dispatch
 * pattern: no constructor, the members the touched paths read are supplied
 * outright, and the layer below the segment under test (forwardRoutedCommand,
 * writeSerialized) is mocked.
 */

type WorkerFixture = {
	descriptor: { workerId: string };
	client?: object;
	lastFrameAt: number;
};

function createWorker(): WorkerFixture {
	return { descriptor: { workerId: "worker-1" }, client: { name: "worker-link" }, lastFrameAt: 0 };
}

function createNoticeClient(id: string): DaemonSocketClient {
	return {
		id,
		attachedActiveSessionIds: new Set(["active-1"]),
		capabilities: new Set(),
		supportsExtensionUi: false,
	} as unknown as DaemonSocketClient;
}

function createNoticeFrame(token: string | undefined, eventType: "message_start" | "message_end") {
	const outbound: DaemonOutbound = {
		type: "session_event",
		activeSessionId: "active-1",
		event: {
			type: eventType,
			message: {
				role: "custom",
				customType: MODEL_CHANGE_ORIGIN_NOTICE_CUSTOM_TYPE,
				content: "模型已切换为「faux/faux-2」（由另一个窗口或客户端发起）。",
				display: true,
				details: {
					provider: "faux",
					modelId: "faux-2",
					origin: "daemon_command",
					...(token === undefined ? {} : { token }),
				},
				timestamp: 1,
			},
		},
	};
	return {
		header: {
			kind: "outbound",
			outboundType: "session_event",
			activeSessionId: "active-1",
			sessionEventType: eventType,
		},
		payload: Buffer.from(JSON.stringify(outbound)),
	} as PrivateFrame<DaemonWorkerFrameHeader>;
}

type SupervisorHarness = {
	clients: Set<DaemonSocketClient>;
	forwardRoutedCommand: ReturnType<typeof vi.fn>;
	writeSerialized: ReturnType<typeof vi.fn>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
	handleWorkerFrame(worker: WorkerFixture, frame: PrivateFrame<DaemonWorkerFrameHeader>, source?: object): void;
};

function createSupervisorHarness(): SupervisorHarness {
	return Object.assign(Object.create(DaemonSupervisor.prototype), {
		clients: new Set<DaemonSocketClient>(),
		modelChangeNoticeInitiators: new Map<string, DaemonSocketClient>(),
		streamReconstructor: { observe: vi.fn() },
		invalidateWorkerSnapshot: vi.fn(),
		writeSerialized: vi.fn(),
		forwardRoutedCommand: vi.fn(),
		log: vi.fn(),
	}) as SupervisorHarness;
}

function clientsWrittenTo(writeSerialized: ReturnType<typeof vi.fn>): DaemonSocketClient[] {
	return writeSerialized.mock.calls.map((call) => call[0] as DaemonSocketClient);
}

describe("supervisor model-change origin notice", () => {
	it("stamps the set_model forward with a notice token and exempts only the initiator at the relay", async () => {
		const supervisor = createSupervisorHarness();
		const { writeSerialized, forwardRoutedCommand } = supervisor;
		const initiator = createNoticeClient("client-a");
		const witness = createNoticeClient("client-b");
		supervisor.clients.add(initiator);
		supervisor.clients.add(witness);
		const worker = createWorker();

		// Hold the forward open so the registration is live when the notice relays.
		let releaseForward: (value: { id?: string; type: string; success: boolean }) => void = () => {};
		let forwardedCommand: Record<string, unknown> | undefined;
		forwardRoutedCommand.mockImplementation(
			(_client: unknown, command: Record<string, unknown>) =>
				new Promise((resolve) => {
					forwardedCommand = command;
					releaseForward = resolve;
				}),
		);
		const pending = supervisor.handleCommand(initiator, {
			id: "cmd-1",
			type: "set_model",
			activeSessionId: "active-1",
			provider: "faux",
			modelId: "faux-2",
		});
		await vi.waitFor(() => {
			if (!forwardedCommand) throw new Error("forward not issued yet");
		});
		if (!forwardedCommand) throw new Error("forward not issued");
		const token: unknown = forwardedCommand.changeNoticeToken;
		expect(typeof token).toBe("string");
		if (typeof token !== "string") throw new Error("forward carried no notice token");

		supervisor.handleWorkerFrame(worker, createNoticeFrame(token, "message_start"), worker.client);
		supervisor.handleWorkerFrame(worker, createNoticeFrame(token, "message_end"), worker.client);

		expect(clientsWrittenTo(writeSerialized)).toEqual([witness, witness]);

		releaseForward({ id: "cmd-1", type: "response", success: true });
		await expect(pending).resolves.toMatchObject({ success: true });

		// The registration ended with the forward: a later notice (say an
		// extension-driven switch, no token) reaches the initiator too.
		supervisor.handleWorkerFrame(worker, createNoticeFrame(undefined, "message_start"), worker.client);
		expect(clientsWrittenTo(writeSerialized)).toEqual([witness, witness, initiator, witness]);
	});

	it("applies the same stamping to cycle_model", async () => {
		const supervisor = createSupervisorHarness();
		const { forwardRoutedCommand } = supervisor;
		const initiator = createNoticeClient("client-a");
		forwardRoutedCommand.mockResolvedValue({ id: "cmd-1", type: "response", success: true });

		await supervisor.handleCommand(initiator, {
			id: "cmd-1",
			type: "cycle_model",
			activeSessionId: "active-1",
			direction: "forward",
		});

		expect(forwardRoutedCommand).toHaveBeenCalledWith(
			initiator,
			expect.objectContaining({ type: "cycle_model", changeNoticeToken: expect.any(String) }),
		);
	});
});
