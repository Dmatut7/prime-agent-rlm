import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { type DaemonCommand, type DaemonResponse, failure, success } from "../src/modes/daemon/daemon-protocol.js";
import {
	DaemonSupervisor,
	HEARTBEAT_LIST_FANOUT_TIMEOUT_MS,
	HEARTBEAT_LIST_FORWARD_TIMEOUT_MS,
	HEARTBEAT_LIST_LAUNCH_WAIT_MS,
} from "../src/modes/daemon/daemon-supervisor.js";

interface SupervisorHarness {
	workers: Map<string, unknown>;
	openingWorkers: Map<string, Promise<unknown>>;
	catalogOpeningWorkers: Map<string, Promise<unknown>>;
	findWorkerForClient(client: DaemonSocketClient, selector: string): Promise<{ worker: unknown }>;
	log(message: string): void;
	forwardToWorker(worker: unknown, command: DaemonCommand, timeoutMs?: number): Promise<DaemonResponse>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	handleWorkerFrame(worker: unknown, frame: unknown): void;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createSupervisorHarness(): SupervisorHarness {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-heartbeats-"));
	tempDirs.push(directory);
	return new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorHarness;
}

function worker(lifecycle: "starting" | "ready" | "recovering" | "failed", connected = true, workerId = "worker") {
	return {
		descriptor: { lifecycle, workerId },
		...(connected ? { client: {} } : {}),
	};
}

describe("daemon supervisor heartbeat aggregation", () => {
	it.each([true, false])("waits for startup before listing heartbeats (registered: %s)", async (registered) => {
		const supervisor = createSupervisorHarness();
		const target = worker("starting");
		if (registered) supervisor.workers.set("target", target);
		let finishStartup = () => {};
		const opening = new Promise<unknown>((resolve) => {
			finishStartup = () => resolve(target);
		});
		supervisor.openingWorkers.set("target", opening);
		supervisor.catalogOpeningWorkers.set("target", opening);
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] }),
		);

		const pending = supervisor.handleCommand({} as DaemonSocketClient, { type: "heartbeats_list" });
		expect(supervisor.forwardToWorker).not.toHaveBeenCalled();
		target.descriptor.lifecycle = "ready";
		supervisor.workers.set("target", target);
		finishStartup();

		await expect(pending).resolves.toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
	});

	it("skips client-owned launches without waiting on them", async () => {
		const supervisor = createSupervisorHarness();
		supervisor.workers.set("public", worker("ready"));
		// A client-owned create can never join the public catalog (isVisibleWorker),
		// so a launch that never settles must not gate the global list.
		supervisor.openingWorkers.set("private", new Promise<unknown>(() => {}));
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] }),
		);

		const watchdog = new Promise<never>((_, reject) => {
			const timer = globalThis.setTimeout(
				() => reject(new Error("heartbeats_list waited on a client-owned launch")),
				1_000,
			);
			timer.unref?.();
		});
		const response = await Promise.race([
			supervisor.handleCommand({} as DaemonSocketClient, { id: "list-1", type: "heartbeats_list" }),
			watchdog,
		]);

		expect(response).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
	});

	it("stops waiting on slow catalog launches after the launch wait budget", async () => {
		vi.useFakeTimers();
		try {
			const supervisor = createSupervisorHarness();
			supervisor.workers.set("public", worker("ready"));
			supervisor.openingWorkers.set("slow", new Promise<unknown>(() => {}));
			supervisor.catalogOpeningWorkers.set("slow", new Promise<unknown>(() => {}));
			supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
				success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] }),
			);

			const pending = supervisor.handleCommand({} as DaemonSocketClient, {
				id: "list-1",
				type: "heartbeats_list",
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(supervisor.forwardToWorker).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(HEARTBEAT_LIST_LAUNCH_WAIT_MS);
			await expect(pending).resolves.toMatchObject({
				success: true,
				data: { heartbeats: [{ job: { id: "heartbeat-1" } }] },
			});
			expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("counts a still-starting worker as absent instead of failing the launch-wait list", async () => {
		vi.useFakeTimers();
		try {
			const supervisor = createSupervisorHarness();
			supervisor.workers.set("public", worker("ready", true, "public"));
			supervisor.openingWorkers.set("slow", new Promise<unknown>(() => {}));
			supervisor.catalogOpeningWorkers.set("slow", new Promise<unknown>(() => {}));
			supervisor.log = vi.fn();
			supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
				success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] }),
			);

			const pending = supervisor.handleCommand({} as DaemonSocketClient, {
				id: "list-1",
				type: "heartbeats_list",
			});
			await vi.advanceTimersByTimeAsync(0);
			// The slow launch registers mid-wait but never becomes ready.
			supervisor.workers.set("slow", worker("starting", true, "slow"));

			await vi.advanceTimersByTimeAsync(HEARTBEAT_LIST_LAUNCH_WAIT_MS);
			// The ready worker's catalog is still the answer; the worker that never came
			// up is reported as a counted absence rather than taking the list down with it.
			await expect(pending).resolves.toMatchObject({
				success: true,
				data: { heartbeats: [{ job: { id: "heartbeat-1" } }] },
			});
			expect(supervisor.log).toHaveBeenCalledWith(expect.stringContaining("slow"));
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails the session-scoped list when the forward outlives its budget", async () => {
		vi.useFakeTimers();
		try {
			const supervisor = createSupervisorHarness();
			supervisor.findWorkerForClient = vi.fn(async () => ({ worker: worker("ready") }));
			supervisor.forwardToWorker = vi.fn(() => new Promise<DaemonResponse>(() => {}));

			const pending = supervisor.handleCommand({} as DaemonSocketClient, {
				id: "list-1",
				type: "heartbeats_list",
				activeSessionId: "session-1",
			});
			await vi.advanceTimersByTimeAsync(HEARTBEAT_LIST_FORWARD_TIMEOUT_MS);
			await expect(pending).resolves.toMatchObject({
				success: false,
				error: expect.stringContaining("Timed out waiting for session worker to list heartbeats"),
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("bounds the session-scoped list forward inside the client request budget", async () => {
		const supervisor = createSupervisorHarness();
		const target = worker("ready");
		supervisor.findWorkerForClient = vi.fn(async () => ({ worker: target }));
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] }),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-1",
			type: "heartbeats_list",
			activeSessionId: "session-1",
		});

		expect(response).toMatchObject({ success: true });
		expect(supervisor.forwardToWorker).toHaveBeenCalledWith(
			target,
			expect.objectContaining({ type: "heartbeats_list" }),
			HEARTBEAT_LIST_FORWARD_TIMEOUT_MS,
		);
	});

	it("uses the last complete worker snapshot during recovery", async () => {
		const supervisor = createSupervisorHarness();
		const first = worker("ready");
		const second = worker("ready");
		supervisor.workers.set("first", first);
		supervisor.workers.set("second", second);
		supervisor.forwardToWorker = vi.fn(async (target, command) =>
			success(command.id, command.type, {
				heartbeats: [{ job: { id: target === first ? "heartbeat-1" : "heartbeat-2" } }],
			}),
		);

		const initial = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-1",
			type: "heartbeats_list",
		});
		expect(initial).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }, { job: { id: "heartbeat-2" } }] },
		});

		second.descriptor.lifecycle = "recovering";
		delete second.client;
		const recovered = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});

		expect(recovered).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }, { job: { id: "heartbeat-2" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(3);
	});

	it("keeps the healthy workers when one worker's list fails", async () => {
		const supervisor = createSupervisorHarness();
		const first = worker("ready", true, "first");
		const second = worker("ready", true, "second");
		supervisor.workers.set("first", first);
		supervisor.workers.set("second", second);
		supervisor.log = vi.fn();
		supervisor.forwardToWorker = vi.fn(async (target, command) =>
			target === first
				? success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] })
				: failure(command.id, command.type, "worker unavailable"),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});

		// One worker's failure is that worker's absence, not the whole catalog's: the
		// healthy worker's heartbeats are the answer and the failure is counted.
		expect(response).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(2);
		expect(supervisor.log).toHaveBeenCalledWith(expect.stringContaining("second"));
	});

	it("fails when no worker can answer at all", async () => {
		const supervisor = createSupervisorHarness();
		supervisor.workers.set("first", worker("ready", true, "first"));
		supervisor.workers.set("second", worker("ready", true, "second"));
		supervisor.log = vi.fn();
		supervisor.forwardToWorker = vi.fn(async (_target, command) =>
			failure(command.id, command.type, "worker unavailable"),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-blind",
			type: "heartbeats_list",
		});

		// Total blindness stays a failure: an empty success would tell every client
		// "no heartbeats armed" when nothing could be asked.
		expect(response).toMatchObject({ success: false, error: "worker unavailable" });
	});

	it("does not fall back to a snapshot after the worker reports heartbeat changes", async () => {
		const supervisor = createSupervisorHarness();
		const target = {
			...worker("ready"),
			heartbeatSnapshot: [{ job: { id: "heartbeat-1" } }],
			heartbeatSnapshotStale: false,
		};
		supervisor.workers.set("target", target);
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			failure(command.id, command.type, "worker unavailable"),
		);

		supervisor.handleWorkerFrame(target, {
			header: { kind: "outbound", outboundType: "heartbeats_changed" },
			payload: Buffer.alloc(0),
		});
		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-stale",
			type: "heartbeats_list",
		});

		expect(target.heartbeatSnapshotStale).toBe(true);
		expect(response).toMatchObject({ success: false, error: "worker unavailable" });
	});

	it("counts a recovering worker without a snapshot instead of failing the list", async () => {
		const supervisor = createSupervisorHarness();
		supervisor.workers.set("ready", worker("ready", true, "ready"));
		supervisor.workers.set("recovering", worker("recovering", false, "recovering"));
		supervisor.log = vi.fn();
		supervisor.forwardToWorker = vi.fn(async (_target, command) =>
			success(command.id, command.type, { heartbeats: [] }),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-3",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({ success: true, data: { heartbeats: [] } });
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
		expect(supervisor.log).toHaveBeenCalledWith(
			expect.stringContaining("Cannot list heartbeats while session worker is recovering"),
		);
	});

	it("skips terminally failed workers without blocking healthy heartbeats", async () => {
		const supervisor = createSupervisorHarness();
		supervisor.workers.set("healthy", worker("ready"));
		supervisor.workers.set("failed", worker("failed", false));
		supervisor.forwardToWorker = vi.fn(async (_target, command) =>
			success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] }),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-failed-worker",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
	});

	it("answers inside the fanout budget while one worker never responds", async () => {
		const supervisor = createSupervisorHarness();
		const healthy = worker("ready", true, "healthy");
		const wedged = worker("ready", true, "wedged");
		supervisor.workers.set("healthy", healthy);
		supervisor.workers.set("wedged", wedged);
		supervisor.log = vi.fn();
		supervisor.forwardToWorker = vi.fn(async (target, command) => {
			if (target === wedged) {
				// The 2026-09-19 incident: a worker spinning inside its own event loop
				// never answers the forward, and no client budget is going to fire first.
				return new Promise<DaemonResponse>(() => {});
			}
			return success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-healthy" } }] });
		});

		const startedAt = Date.now();
		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-wedged",
			type: "heartbeats_list",
		});
		const elapsedMs = Date.now() - startedAt;

		// A literal, not the constant: the budget is a policy about what a session switch
		// may cost, and a self-referential bound moves with the number it is meant to pin.
		expect(elapsedMs).toBeLessThan(2_500);
		expect(response).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-healthy" } }] },
		});
		expect(supervisor.log).toHaveBeenCalledWith(expect.stringContaining("wedged"));
	}, 10_000);

	it("bounds the whole fanout attempt, not just the worker request", async () => {
		vi.useFakeTimers();
		try {
			const supervisor = createSupervisorHarness();
			const healthy = worker("ready", true, "healthy");
			// Stuck joining an in-flight recovery: forwardToWorker awaits that before the
			// request is ever sent, so the request budget alone would not bound the attempt.
			const recovering = worker("ready", true, "recovering");
			supervisor.workers.set("healthy", healthy);
			supervisor.workers.set("recovering", recovering);
			supervisor.log = vi.fn();
			supervisor.forwardToWorker = vi.fn(async (target, command) => {
				if (target === recovering) return new Promise<DaemonResponse>(() => {});
				return success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-healthy" } }] });
			});

			const pending = supervisor.handleCommand({} as DaemonSocketClient, {
				id: "list-budget",
				type: "heartbeats_list",
			});
			await vi.advanceTimersByTimeAsync(0);
			// The policy half of the pin: one second is already generous for a read of
			// in-memory cron state, and it is what keeps a wedged worker from becoming a
			// session switch's latency.
			expect(HEARTBEAT_LIST_FANOUT_TIMEOUT_MS).toBeLessThanOrEqual(1_000);
			expect(supervisor.forwardToWorker).toHaveBeenCalledWith(
				recovering,
				expect.objectContaining({ type: "heartbeats_list" }),
				HEARTBEAT_LIST_FANOUT_TIMEOUT_MS,
			);

			await vi.advanceTimersByTimeAsync(HEARTBEAT_LIST_FANOUT_TIMEOUT_MS);
			await expect(pending).resolves.toMatchObject({
				success: true,
				data: { heartbeats: [{ job: { id: "heartbeat-healthy" } }] },
			});
			expect(supervisor.log).toHaveBeenCalledWith(expect.stringContaining("recovering"));
		} finally {
			vi.useRealTimers();
		}
	});

	it("routes management by cached job ownership after a session unloads", async () => {
		const supervisor = createSupervisorHarness();
		const target = {
			...worker("ready"),
			heartbeatSnapshot: [{ job: { id: "heartbeat-1", activeSessionId: "unloaded-session" } }],
		};
		supervisor.workers.set("target", target);
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			success(command.id, command.type, {
				heartbeat: { id: "heartbeat-1", activeSessionId: "unloaded-session", status: "cancelled" },
			}),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "manage-1",
			type: "heartbeat_manage",
			activeSessionId: "unloaded-session",
			jobId: "heartbeat-1",
			action: "stop",
		});

		expect(response).toMatchObject({ success: true });
		expect(supervisor.forwardToWorker).toHaveBeenCalledWith(
			target,
			expect.objectContaining({ type: "heartbeat_manage", jobId: "heartbeat-1" }),
		);
		expect(target.heartbeatSnapshot).toEqual([]);
	});
});
