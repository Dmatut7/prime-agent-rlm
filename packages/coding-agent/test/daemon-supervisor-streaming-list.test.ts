import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { AgentRoster, type WorkerRosterEntry } from "../src/modes/daemon/agent-roster.js";
import type { DaemonCommand, DaemonResponse, DaemonServerCapability } from "../src/modes/daemon/daemon-protocol.js";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

/**
 * A row's in-flight assistant message grows for the whole turn, so a reader
 * that only wants counters and roster state must not pay for it. Two legs
 * carry that guarantee:
 *
 * - the worker pull, where `refreshWorkerSummaries`' fifth positional
 *   (`omitStreamingMessages`) asks a capable worker to leave the field out.
 *   No production caller passes it today; the positional seam stays because a
 *   streaming-cadence pull is exactly the pass that needs it.
 * - the client `list`, where the supervisor strips the field off the roster
 *   row it answers with. Roster rows drop the field by type already, so this
 *   is the belt that holds the wire guarantee if one ever carries it again.
 */

const ROOT = "active-root";

function assistant(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as AgentMessage;
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: ROOT,
		activeSessionId: ROOT,
		lifecycle: "live",
		activity: "working",
		isSessionActive: true,
		sessionId: "session-root",
		sessionFile: "/tmp/root.jsonl",
		cwd: "/tmp/project",
		isStreaming: true,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 3,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	} as SessionSummary;
}

function stripped(rows: SessionSummary[]): SessionSummary[] {
	return rows.map((row) => {
		const { streamingMessage: _streamingMessage, ...rest } = row;
		return rest as SessionSummary;
	});
}

function createHarness(options: {
	capabilities?: readonly DaemonServerCapability[];
	rows: SessionSummary[];
	cached?: Map<string, SessionSummary>;
}) {
	const capabilities = options.capabilities ?? ["list_without_streaming_messages"];
	const requests: DaemonCommand[] = [];
	const worker = {
		descriptor: {
			workerId: "worker-1",
			rootActiveSessionId: ROOT,
			lifecycle: "ready",
			pid: 7,
			createCommand: { type: "create" },
		},
		summaries: options.cached ?? new Map<string, SessionSummary>(),
		client: {
			supports: (capability: DaemonServerCapability) => capabilities.includes(capability),
			request: (command: DaemonCommand) => {
				requests.push(command);
				const rows =
					command.type === "list" && command.omitStreamingMessages ? stripped(options.rows) : options.rows;
				return Promise.resolve(success(undefined, "list", { sessions: rows }));
			},
		},
	};
	const seed = vi.fn();
	const clear = vi.fn();
	const log = vi.fn();
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		streamReconstructor: { seed, clear, hasPartial: vi.fn(() => false) },
		isWorkerStopping: () => false,
		persistWorker: vi.fn(),
		assertRecoveryAllowed: async () => {},
		syncRosterFromWorkerSummaries: vi.fn(),
		// The roster apply chain only runs while its own worker and connection are current.
		workers: new Map([[worker.descriptor.workerId, worker]]),
		clients: new Set(),
		log,
	}) as unknown as {
		refreshWorkerSummaries(
			worker: unknown,
			recovery?: boolean,
			fillGaps?: boolean,
			retried?: boolean,
			omitStreamingMessages?: boolean,
		): Promise<void>;
	};
	return { requests, seed, clear, log, supervisor, worker };
}

describe("streaming-driven summary refresh", () => {
	it("asks the worker to leave in-flight messages out and keeps the row it already held", async () => {
		const held = assistant("first half");
		const { requests, seed, log, supervisor, worker } = createHarness({
			rows: [summary({ streamingMessage: assistant("first half plus more") })],
			cached: new Map([[ROOT, summary({ streamingMessage: held })]]),
		});

		await supervisor.refreshWorkerSummaries(worker, false, false, false, true);

		expect(requests).toEqual([{ type: "list", omitStreamingMessages: true }]);
		// Nothing may observe the field disappearing, so the held message stands
		// until a pass that carries authoritative content replaces it.
		expect(worker.summaries.get(ROOT)?.streamingMessage).toBe(held);
		// Re-seeding is drift correction against the worker's authoritative copy;
		// a response without one must not overwrite the reconstructor.
		expect(seed).not.toHaveBeenCalled();
		// A swallowed roster-apply failure would leave the descriptor stale without reddening anything above.
		expect(log).not.toHaveBeenCalled();
	});

	it("sends a plain list when the worker does not advertise the capability", async () => {
		const inFlight = assistant("in flight");
		const { requests, seed, supervisor, worker } = createHarness({
			capabilities: [],
			rows: [summary({ streamingMessage: inFlight })],
		});

		await supervisor.refreshWorkerSummaries(worker, false, false, false, true);

		expect(requests).toEqual([{ type: "list" }]);
		expect(worker.summaries.get(ROOT)?.streamingMessage).toBe(inFlight);
		expect(seed).toHaveBeenCalledWith(ROOT, inFlight);
	});

	it("keeps roster-level refreshes on the full response", async () => {
		const inFlight = assistant("in flight");
		const { requests, seed, supervisor, worker } = createHarness({
			rows: [summary({ streamingMessage: inFlight })],
		});

		await supervisor.refreshWorkerSummaries(worker);

		expect(requests).toEqual([{ type: "list" }]);
		expect(seed).toHaveBeenCalledWith(ROOT, inFlight);
	});

	it("reads the second positional as recovery, never as an options bag", async () => {
		const inFlight = assistant("in flight");
		const { requests, log, supervisor, worker } = createHarness({
			rows: [summary({ streamingMessage: inFlight })],
		});

		// The retired call shape put an object here; under the positional
		// signature an object reads as a truthy recovery and the omit flag stays
		// off, which is the silent fail-open this pins against.
		await supervisor.refreshWorkerSummaries(worker, true);

		expect(requests).toEqual([{ type: "list" }]);
		expect(worker.summaries.get(ROOT)?.streamingMessage).toBe(inFlight);
		expect(log).not.toHaveBeenCalled();
	});

	it("carries a row with no cached message through untouched", async () => {
		const { supervisor, worker } = createHarness({
			rows: [summary({ streamingMessage: assistant("in flight") })],
		});

		await supervisor.refreshWorkerSummaries(worker, false, false, false, true);

		expect(worker.summaries.get(ROOT)?.streamingMessage).toBeUndefined();
		expect(worker.summaries.get(ROOT)?.messageCount).toBe(3);
	});

	it("still retires the reconstructor when a row stops streaming", async () => {
		const { clear, supervisor, worker } = createHarness({
			rows: [summary({ isStreaming: false, activity: "idle" })],
			cached: new Map([[ROOT, summary({ streamingMessage: assistant("stale") })]]),
		});

		await supervisor.refreshWorkerSummaries(worker, false, false, false, true);

		expect(clear).toHaveBeenCalledWith(ROOT);
	});
});

describe("client-driven list that omits in-flight messages", () => {
	function rosterRow(row: SessionSummary): WorkerRosterEntry {
		const { sessionActions: _sessionActions, diagnostics: _diagnostics, ...slim } = row;
		// The roster type drops streamingMessage; handleList strips it again in
		// case a row ever carries one, so the fixture forces the field back in.
		return { agentId: row.sessionId, summary: slim as WorkerRosterEntry["summary"] };
	}

	function createListHarness(rows: SessionSummary[]) {
		const requests: DaemonCommand[] = [];
		const worker = {
			descriptor: {
				workerId: "worker-1",
				rootActiveSessionId: ROOT,
				lifecycle: "ready",
				pid: 7,
				createCommand: { type: "create" },
			},
			summaries: new Map<string, SessionSummary>(),
			client: {
				supports: () => true,
				request: (command: DaemonCommand) => {
					requests.push(command);
					const sessions = command.type === "list" && command.omitStreamingMessages ? stripped(rows) : rows;
					return Promise.resolve(success(undefined, "list", { sessions }));
				},
			},
		};
		const roster = new AgentRoster((path) => path);
		for (const row of rows) roster.write(rosterRow(row), worker.descriptor.workerId);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set(),
			rosterStore: roster,
			isWorkerStopping: () => false,
			isVisibleWorker: () => true,
			log: vi.fn(),
		}) as unknown as {
			handleList(client: unknown, command: Extract<DaemonCommand, { type: "list" }>): Promise<DaemonResponse>;
		};
		return { requests, supervisor, worker };
	}

	function listedRows(response: DaemonResponse): SessionSummary[] {
		if (!response.success) throw new Error(response.error);
		return (response.data as { sessions: SessionSummary[] }).sessions;
	}

	it("answers from the roster without the message and leaves the worker socket alone", async () => {
		const { requests, supervisor } = createListHarness([summary({ streamingMessage: assistant("in flight") })]);

		const response = await supervisor.handleList({}, { type: "list", omitStreamingMessages: true });

		// The list is served off the roster the worker's frames already fed, so a
		// reader that drops the field pays for neither hop.
		expect(requests).toEqual([]);
		const rows = listedRows(response);
		expect(rows[0]?.streamingMessage).toBeUndefined();
		expect(rows[0]?.messageCount).toBe(3);
	});

	it("keeps answering a plain list with the full rows", async () => {
		const inFlight = assistant("in flight");
		const { requests, supervisor } = createListHarness([summary({ streamingMessage: inFlight })]);

		const response = await supervisor.handleList({}, { type: "list" });

		expect(requests).toEqual([]);
		expect(listedRows(response)[0]?.streamingMessage).toEqual(inFlight);
	});
});
