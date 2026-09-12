import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HostRequestHandlers, ReplKernelManager } from "../src/core/kernel/index.js";

/**
 * T1-2 host half: what a kernel heartbeat is worth, and what it must never cost.
 *
 * The frames are the only evidence that separates a wedged kernel from one waiting on work it
 * does not own, so two properties are load bearing and pinned here. They may not touch a cell's
 * output (they are dispatched before id attribution, never through `onStream`), and a malformed
 * one may not kill the kernel it was describing - it is rejected and counted instead, loudly
 * enough that a runtime which lost its strict serialization gate is a log line and not a mystery.
 * The corruption path stays armed for a kind nobody negotiated, which is what keeps the protocol
 * gate meaningful in the mixed-version window.
 */
const KERNEL_PROTOCOL_ENV_VAR = "PRIME_AGENT_KERNEL_PROTOCOL";

let tempDir = "";
let entries: LogEntry[] = [];

/** One well-formed heartbeat frame, with the counters a test wants to vary. */
function fakeRuntimeSource(): string {
	return `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const MIN = 3;
const MAX = 4;
const frameLog = process.env.FAKE_REPL_FRAME_LOG;
const countPath = process.env.FAKE_REPL_SPAWN_COUNT;
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) + 1 : 1;
fs.writeFileSync(countPath, String(count));
const requested = process.env.${KERNEL_PROTOCOL_ENV_VAR};
const clamp = (raw) => {
  const parsed = Number.parseInt(raw === undefined ? "" : raw, 10);
  return Number.isInteger(parsed) ? Math.min(MAX, Math.max(MIN, parsed)) : MIN;
};
const forced = process.env.FAKE_REPL_FORCE_READY_PROTOCOL;
const protocol = forced === undefined ? clamp(requested) : Number(forced);
const emit = (event) => {
  fs.appendFileSync(frameLog, event.event + "\\n");
  process.stdout.write(JSON.stringify(event) + "\\n");
};
// Raw line writer: JSON.stringify cannot produce NaN, and a runtime that lost its strict
// serialization gate is exactly the case the host has to survive.
const emitRaw = (line) => {
  fs.appendFileSync(frameLog, "raw\\n");
  process.stdout.write(line + "\\n");
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = (overrides) => ({
  event: "heartbeat",
  id: null,
  tick: 1,
  cpu_ms: 10,
  stream_bytes: 0,
  cells_done: 0,
  host_requests: 0,
  interval_ms: 5000,
  bash: { handles: 0, cell_handles: 0, buffered_bytes: 0, pipe_pending: 0 },
  ...overrides,
});
const NaN_FRAME =
  '{"event":"heartbeat","id":null,"tick":NaN,"cpu_ms":1,"stream_bytes":0,"cells_done":0,' +
  '"host_requests":0,"interval_ms":5000,"bash":{"handles":0,"cell_handles":0,"buffered_bytes":0,"pipe_pending":0}}';
if (process.env.FAKE_REPL_READY_WITH_HEARTBEAT === "1") {
  // One write, so the host reads both frames in a single stdout chunk: the shape a real
  // runtime produces when the host's event loop stalls across one heartbeat interval.
  fs.appendFileSync(frameLog, "ready\\nheartbeat\\n");
  process.stdout.write(
    JSON.stringify({ event: "ready", protocol, python: process.version }) +
      "\\n" +
      JSON.stringify(frame({ id: null, tick: 1 })) +
      "\\n",
  );
} else {
  emit({ event: "ready", protocol, python: process.version });
}
const input = readline.createInterface({ input: process.stdin });
let awaitingReplyId = null;
input.on("line", async (line) => {
  const request = JSON.parse(line);
  if (request.type === "host_reply") {
    // The cell that asked is still the in-flight execution: finish it once the host answered.
    if (awaitingReplyId !== null) {
      const finished = awaitingReplyId;
      awaitingReplyId = null;
      emit({ event: "done", id: finished, status: "ok" });
    }
    return;
  }
  if (request.type === "execute") {
    const id = request.id;
    const code = request.code;
    if (code === "work") {
      emit({ event: "stdout", id, text: "hi" });
      emit(
        frame({
          id,
          tick: 7,
          cpu_ms: 12,
          stream_bytes: 2,
          cells_done: 1,
          bash: { handles: 1, cell_handles: 1, buffered_bytes: 64, pipe_pending: 1 },
        }),
      );
      emit({ event: "done", id, status: "ok" });
      return;
    }
    if (code === "progress") {
      emit(frame({ id, tick: 1, stream_bytes: 0 }));
      // Inside the host's minimum sample gap: retained as a throttle count, not as a sample.
      emit(frame({ id, tick: 2, stream_bytes: 5 }));
      await sleep(1200);
      emit(frame({ id, tick: 9, cpu_ms: 40, stream_bytes: 45, cells_done: 2 }));
      emit({ event: "done", id, status: "ok" });
      return;
    }
    if (code === "finishing") {
      // The post-run phase: the request is still in flight, its loop is blocked by the repr,
      // and the frame says both.
      emit(frame({ id, tick: 21, finishing: true }));
      emit({
        event: "heartbeat",
        id,
        tick: 22,
        finishing: "yes",
        cpu_ms: 1,
        stream_bytes: 0,
        cells_done: 0,
        host_requests: 0,
        interval_ms: 5000,
        bash: { handles: 0, cell_handles: 0, buffered_bytes: 0, pipe_pending: 0 },
      });
      emit({ event: "done", id, status: "ok" });
      return;
    }
    if (code === "malformed") {
      emitRaw(NaN_FRAME);
      emit({ event: "heartbeat", id, tick: 3, cpu_ms: 5 });
      emit({ event: "heartbeat", id, tick: 4, cpu_ms: 6, stream_bytes: 1, cells_done: 0, host_requests: 0, interval_ms: 5000, bash: { handles: "one", cell_handles: 0, buffered_bytes: 0, pipe_pending: 0 } });
      emit(frame({ id, tick: 5 }));
      emit({ event: "done", id, status: "ok" });
      return;
    }
    if (code === "malformed-again") {
      emit({ event: "heartbeat", id, tick: 6, interval_ms: 0, cpu_ms: 1, stream_bytes: 0, cells_done: 0, host_requests: 0, bash: { handles: 0, cell_handles: 0, buffered_bytes: 0, pipe_pending: 0 } });
      emit({ event: "done", id, status: "ok" });
      return;
    }
    if (code === "bogus-kind") {
      emit({ event: "totally_unknown", id });
      return;
    }
    if (code === "host-request") {
      awaitingReplyId = id;
      emit(frame({ id, tick: 11, host_requests: 1 }));
      emit({ event: "host_request", id: "hr-probe", data: { type: "probe" } });
      return;
    }
    if (code === "say-hi") {
      emit({ event: "stdout", id, text: "hi" });
      emit({ event: "done", id, status: "ok" });
      return;
    }
    emit({ event: "done", id, status: "ok" });
    return;
  }
  if (request.type === "shutdown") {
    emit({ event: "done", id: request.id, status: "ok" });
    process.exit(0);
  }
});
`;
}

function writeFakeRuntime(filePath: string): void {
	writeFileSync(filePath, fakeRuntimeSource());
	chmodSync(filePath, 0o755);
}

function spawnCount(path: string): number {
	return existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
}

function frameKinds(path: string): string[] {
	return existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter((line) => line.length > 0)
		: [];
}

function rejectionWarnings(): LogEntry[] {
	return entries.filter((entry) => entry.level === "warn" && entry.msg === "kernel heartbeat frame rejected");
}

function newManager(
	options: { forcedProtocol?: number; hostHandlers?: HostRequestHandlers; readyWithHeartbeat?: boolean } = {},
): {
	manager: ReplKernelManager;
	countPath: string;
	frameLogPath: string;
} {
	const python = join(tempDir, "python");
	const countPath = join(tempDir, "spawn-count");
	const frameLogPath = join(tempDir, "frames.log");
	writeFakeRuntime(python);
	const manager = new ReplKernelManager({
		python,
		cwd: tempDir,
		env: {
			FAKE_REPL_SPAWN_COUNT: countPath,
			FAKE_REPL_FRAME_LOG: frameLogPath,
			...(options.forcedProtocol === undefined
				? {}
				: { FAKE_REPL_FORCE_READY_PROTOCOL: String(options.forcedProtocol) }),
			...(options.readyWithHeartbeat ? { FAKE_REPL_READY_WITH_HEARTBEAT: "1" } : {}),
		},
		...(options.hostHandlers ? { hostHandlers: options.hostHandlers } : {}),
	});
	return { manager, countPath, frameLogPath };
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-heartbeat-"));
	entries = [];
	setLogSink((entry) => {
		entries.push(entry);
	});
	delete process.env[KERNEL_PROTOCOL_ENV_VAR];
});

afterEach(() => {
	setLogSink(undefined);
	delete process.env[KERNEL_PROTOCOL_ENV_VAR];
	if (tempDir) {
		chmodSync(tempDir, 0o755);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

describe("kernel heartbeat liveness", () => {
	it("records liveness facts and keeps them out of the cell's output", async () => {
		const { manager, frameLogPath } = newManager();
		const onStream = vi.fn();

		try {
			await manager.start();
			const result = await manager.execute("work", { onStream });

			// The architectural red line: a heartbeat is not cell output.
			expect(result.stdout).toBe("hi");
			expect(result.status).toBe("ok");
			expect(onStream).toHaveBeenCalledTimes(1);
			expect(onStream).toHaveBeenCalledWith("hi", "stdout");

			const liveness = manager.kernelLiveness;
			expect(liveness.protocol).toBe(4);
			expect(liveness.rejectedFrames).toBe(0);
			expect(liveness.latest).toBeDefined();
			expect(liveness.latest).toMatchObject({
				tick: 7,
				cpuMs: 12,
				streamBytes: 2,
				cellsDone: 1,
				hostRequests: 0,
				intervalMs: 5000,
				bashHandles: 1,
				bashCellHandles: 1,
				bashBufferedBytes: 64,
				bashPipePending: 1,
			});
			// The kernel attributes the frame to the cell it was executing.
			expect(typeof liveness.latest?.cellId).toBe("string");
			expect(liveness.latest?.receivedAt).toBeGreaterThan(0);
			// Acceptance (2): a live bash handle is visible to the host.
			expect(manager.isKernelBashRunning).toBe(true);
			expect(manager.hasActiveExecution).toBe(false);
			expect(frameKinds(frameLogPath)).toContain("heartbeat");
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("keeps the two newest samples and rate-limits a kernel that floods frames", async () => {
		const { manager } = newManager();

		try {
			await manager.start();
			await manager.execute("progress");

			const liveness = manager.kernelLiveness;
			expect(liveness.latest?.tick).toBe(9);
			expect(liveness.previous?.tick).toBe(1);
			// The diff is what turns two frames into a progress fact.
			expect((liveness.latest?.streamBytes ?? 0) - (liveness.previous?.streamBytes ?? 0)).toBe(45);
			expect((liveness.latest?.cpuMs ?? 0) - (liveness.previous?.cpuMs ?? 0)).toBe(30);
			// The second frame arrived inside the minimum sample gap: counted, not retained.
			expect(liveness.throttledFrames).toBeGreaterThanOrEqual(1);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("rejects malformed frames without killing the kernel, and says so once per streak", async () => {
		const { manager, countPath } = newManager();

		try {
			await manager.start();
			const result = await manager.execute("malformed");
			expect(result.status).toBe("ok");

			const liveness = manager.kernelLiveness;
			// NaN line, missing fields, wrong field type: three rejections, one accepted frame.
			expect(liveness.rejectedFrames).toBe(3);
			expect(liveness.consecutiveRejectedFrames).toBe(0);
			expect(liveness.latest?.tick).toBe(5);
			// B4: the first rejection of a streak is loud, the rest of the streak is not a flood.
			expect(rejectionWarnings()).toHaveLength(1);
			// B8: rejecting a frame is not repairing the kernel - no replacement was spawned and
			// the same kernel still serves the next cell.
			expect(spawnCount(countPath)).toBe(1);
			expect(manager.isRunning).toBe(true);
			await expect(manager.execute("malformed-again")).resolves.toMatchObject({ status: "ok" });
			expect(spawnCount(countPath)).toBe(1);
			// A new streak starts a new line, so a permanently broken runtime stays countable.
			expect(rejectionWarnings()).toHaveLength(2);
			expect(manager.kernelLiveness.rejectedFrames).toBe(4);
			expect(manager.kernelLiveness.consecutiveRejectedFrames).toBe(1);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("keeps the finishing phase attributed to its cell, and rejects a malformed marker", async () => {
		const { manager, countPath } = newManager();

		try {
			await manager.start();
			await expect(manager.execute("finishing")).resolves.toMatchObject({ status: "ok" });

			const liveness = manager.kernelLiveness;
			// The phase marker survives the trip: a synchronous repr freezes the tick while the
			// request is still in flight, and this is the fact that tells the two apart.
			expect(liveness.latest?.finishing).toBe(true);
			expect(typeof liveness.latest?.cellId).toBe("string");
			expect(liveness.latest?.tick).toBe(21);
			// A wrong-typed marker costs one frame, never the kernel (B8).
			expect(liveness.rejectedFrames).toBe(1);
			expect(manager.isRunning).toBe(true);
			expect(spawnCount(countPath)).toBe(1);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("still repairs the kernel for a frame kind nobody negotiated", async () => {
		const { manager, countPath } = newManager();

		try {
			await manager.start();
			// Positive control for the rejection path above: the corruption channel is reserved
			// for kinds outside the vocabulary, and it still fires.
			await expect(manager.execute("bogus-kind")).rejects.toThrow(/Kernel protocol error: unknown protocol event/);
			await expect(manager.execute("say-hi")).resolves.toMatchObject({ status: "ok", stdout: "hi" });
			// The repair really replaced the child (the next cell waited for it).
			expect(spawnCount(countPath)).toBe(2);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("accepts a heartbeat that shares the ready frame's stdout chunk", async () => {
		// A host whose event loop stalls across one heartbeat interval reads `ready` and the first
		// frame in a single chunk, and that chunk's parse loop is synchronous: the negotiated
		// protocol is still unset when the second line reaches the gate. The healthy kernel must
		// not be judged corrupt (and killed) for the host's own read latency.
		const { manager, countPath, frameLogPath } = newManager({ readyWithHeartbeat: true });

		try {
			await manager.start();
			expect(manager.isRunning).toBe(true);
			expect(manager.negotiatedProtocol).toBe(4);
			// The frame that shared the chunk is a retained fact, not a rejection.
			expect(manager.kernelLiveness.latest?.tick).toBe(1);
			expect(manager.kernelLiveness.rejectedFrames).toBe(0);
			expect(frameKinds(frameLogPath)).toEqual(["ready", "heartbeat"]);
			await expect(manager.execute("say-hi")).resolves.toMatchObject({ status: "ok", stdout: "hi" });
			// No repair: the same child served the next cell.
			expect(spawnCount(countPath)).toBe(1);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("still treats a same-chunk heartbeat from a protocol-3 kernel as corruption", async () => {
		// The chunk-timing tolerance above is about the host not having finished negotiating yet,
		// not about letting an ungated kind through: a kernel that announced 3 and sent a
		// heartbeat anyway is still corrupt, in the same chunk or a later one.
		const { manager, countPath } = newManager({ forcedProtocol: 3, readyWithHeartbeat: true });

		try {
			await expect(manager.start()).rejects.toThrow(/Kernel protocol error: heartbeat frame/);
			expect(manager.kernelLiveness.latest).toBeUndefined();
			expect(spawnCount(countPath)).toBe(1);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("treats a heartbeat from a protocol-3 kernel as corruption, not as a fact", async () => {
		// The env gate is a single point: a runtime that ignores it is not a newer runtime, it is
		// a broken one, and trusting its other frames is worse than repairing it.
		const { manager, countPath } = newManager({ forcedProtocol: 3 });

		try {
			await manager.start();
			expect(manager.negotiatedProtocol).toBe(3);
			await expect(manager.execute("work")).rejects.toThrow(/Kernel protocol error: heartbeat frame/);
			expect(manager.kernelLiveness.latest).toBeUndefined();
			await expect(manager.execute("say-hi")).resolves.toMatchObject({ status: "ok", stdout: "hi" });
			expect(spawnCount(countPath)).toBe(2);
			// The replacement negotiated the same ceiling, so still no facts.
			expect(manager.kernelLiveness.latest).toBeUndefined();
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("reports no liveness facts for a kernel that negotiated protocol 3", async () => {
		const { manager, frameLogPath } = newManager({ forcedProtocol: 3 });

		try {
			await manager.start();
			// A runtime that respects the gate sends no heartbeat at all under protocol 3.
			await expect(manager.execute("say-hi")).resolves.toMatchObject({ status: "ok", stdout: "hi" });

			const liveness = manager.kernelLiveness;
			expect(liveness.protocol).toBe(3);
			expect(liveness.latest).toBeUndefined();
			expect(liveness.previous).toBeUndefined();
			expect(liveness.rejectedFrames).toBe(0);
			expect(manager.isKernelBashRunning).toBe(false);
			expect(frameKinds(frameLogPath).filter((kind) => kind === "heartbeat")).toEqual([]);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("counts in-flight host requests and how long the oldest has been waiting", async () => {
		const observed: { count: number; oldestAgeMs: number | undefined }[] = [];
		let reply!: (value: unknown) => void;
		const gate = new Promise((resolve) => {
			reply = resolve;
		});
		const { manager } = newManager({
			hostHandlers: {
				probe: async () => {
					observed.push({ count: manager.hostRequestCount, oldestAgeMs: manager.hostRequestOldestAgeMs });
					await gate;
					observed.push({ count: manager.hostRequestCount, oldestAgeMs: manager.hostRequestOldestAgeMs });
					return { ok: true };
				},
			},
		});

		try {
			await manager.start();
			const pending = manager.execute("host-request");
			await vi.waitFor(() => expect(manager.hostRequestCount).toBe(1));
			expect(manager.kernelLiveness.latest?.hostRequests).toBe(1);
			await new Promise((resolve) => setTimeout(resolve, 30));
			reply(undefined);
			await pending;

			expect(observed.length).toBe(2);
			expect(observed[0]?.count).toBe(1);
			expect(observed[0]?.oldestAgeMs).toBeGreaterThanOrEqual(0);
			// The age is what bounds a vouch: a wedged handler must stop excusing silence.
			expect(observed[1]?.oldestAgeMs).toBeGreaterThan(observed[0]?.oldestAgeMs ?? 0);
			expect(manager.hostRequestCount).toBe(0);
			expect(manager.hostRequestOldestAgeMs).toBeUndefined();
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("drops the facts of a kernel that is gone", async () => {
		const { manager } = newManager();

		await manager.start();
		await manager.execute("work");
		expect(manager.kernelLiveness.latest).toBeDefined();

		await manager.shutdown({ snapshot: true, drainHostRequests: true });

		// A replacement kernel must earn its own first frame: stale facts from a dead child
		// would vouch for work nothing is doing anymore.
		const liveness = manager.kernelLiveness;
		expect(liveness.latest).toBeUndefined();
		expect(liveness.previous).toBeUndefined();
		expect(liveness.protocol).toBeUndefined();
		expect(manager.isKernelBashRunning).toBe(false);
		expect(manager.hasActiveExecution).toBe(false);
		expect(manager.kernelPid).toBeUndefined();
	});
});
