import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonCommand, DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

type ClientFixture = {
	id: string;
	socket: { destroy: ReturnType<typeof vi.fn> };
	attachedActiveSessionIds: Set<string>;
	capabilities: Set<string>;
	rosterSubscribed?: boolean;
	rosterResyncPending?: boolean;
};

type WorkerFixture = {
	descriptor: { workerId: string };
	client?: { close: ReturnType<typeof vi.fn> };
};

type SupervisorInternals = {
	clients: Set<ClientFixture>;
	workers: Map<string, WorkerFixture>;
	findWorkerForClient: ReturnType<typeof vi.fn>;
	forwardToWorker: ReturnType<typeof vi.fn>;
	handleCommand(client: ClientFixture, command: DaemonCommand): Promise<DaemonResponse | undefined>;
};

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createHarness() {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-dispatch-"));
	tempDirs.push(directory);
	const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorInternals;
	const worker: WorkerFixture = { descriptor: { workerId: "worker-1" }, client: { close: vi.fn() } };
	supervisor.workers.set(worker.descriptor.workerId, worker);
	supervisor.findWorkerForClient = vi.fn(async () => ({
		worker,
		summary: { id: "resolved-1", activeSessionId: "resolved-1" },
	}));
	supervisor.forwardToWorker = vi.fn(
		async (_worker: WorkerFixture, command: DaemonCommand) =>
			({ type: "response", command: command.type, success: true }) satisfies DaemonResponse,
	);
	const client: ClientFixture = {
		id: "client-1",
		socket: { destroy: vi.fn() },
		attachedActiveSessionIds: new Set(["resolved-1"]),
		capabilities: new Set<string>(),
	};
	supervisor.clients.add(client);
	return { supervisor, worker, client };
}

describe("daemon supervisor command dispatch", () => {
	it("routes delete_saved_session with an active session through the generic worker forward", async () => {
		const { supervisor, worker, client } = createHarness();

		const response = await supervisor.handleCommand(client, {
			id: "delete-1",
			type: "delete_saved_session",
			activeSessionId: "requested-1",
			sessionPath: "/tmp/session.jsonl",
		});

		expect(response).toMatchObject({ success: true });
		expect(supervisor.forwardToWorker).toHaveBeenCalledWith(worker, {
			id: "delete-1",
			type: "delete_saved_session",
			activeSessionId: "resolved-1",
			sessionPath: "/tmp/session.jsonl",
		});
	});

	it("rejects a routed command whose active session id is missing", async () => {
		const { supervisor, client } = createHarness();

		await expect(
			supervisor.handleCommand(client, { id: "state-1", type: "get_state" } as unknown as DaemonCommand),
		).rejects.toThrow("Supervisor cannot route daemon command: get_state");
		expect(supervisor.forwardToWorker).not.toHaveBeenCalled();
	});

	it("answers roster_subscribe from the switch half of the dispatcher", async () => {
		const { supervisor, client } = createHarness();

		const response = await supervisor.handleCommand(client, { id: "sub-1", type: "roster_subscribe" });

		expect(response).toMatchObject({ success: true, data: { roster: [] } });
		expect(client.rosterSubscribed).toBe(true);
		expect(supervisor.findWorkerForClient).not.toHaveBeenCalled();
	});

	it("ack_result returns no response and never reaches the worker forward", async () => {
		const { supervisor, client } = createHarness();
		const journal = { acknowledge: vi.fn() };
		(supervisor as unknown as { commandJournal: unknown }).commandJournal = journal;

		const response = await supervisor.handleCommand(client, { type: "ack_result", commandId: "cmd-1" });

		expect(response).toBeUndefined();
		expect(journal.acknowledge).toHaveBeenCalledWith("client-1", "cmd-1");
		expect(supervisor.forwardToWorker).not.toHaveBeenCalled();
	});
});
