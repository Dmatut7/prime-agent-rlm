import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

/**
 * T1-2 acceptance on a real runtime: the machine proof behind the probe-silent / probe-tick
 * evidence. A fake kernel can claim any tick it likes, so the contrast that the whole vouch rests
 * on - an awaited sleep keeps the loop ticking while a blocking one freezes it, and the frames
 * arrive either way - has to be shown against `python -m rlm.repl` itself.
 *
 * The candidate interpreter must be one whose `rlm.repl` actually has the heartbeat: an installed
 * kernel venv built before this change reports protocol 3 and sends nothing, which would turn
 * every assertion below into a vacuous pass. Hence the capability probe in `resolveReplPython`.
 */
const HEARTBEAT_INTERVAL_MS = 200;
/** Long enough for the host to retain two samples (its minimum gap is 1s). */
const CELL_SECONDS = 2.5;

function hasHeartbeat(python: string): boolean {
	const check = spawnSync(
		python,
		["-c", "import rlm.repl as r; print(r.PROTOCOL_VERSION, hasattr(r, 'heartbeat_interval_ms'))"],
		{ encoding: "utf8" },
	);
	if (check.status !== 0) return false;
	const [protocol, hasInterval] = (check.stdout ?? "").trim().split(/\s+/);
	return Number(protocol) >= 4 && hasInterval === "True";
}

function resolveReplPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		resolve(
			dirname(new URL(import.meta.url).pathname),
			"..",
			"..",
			"..",
			"prime-agent-runtime",
			".venv",
			"bin",
			"python",
		),
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl, dill"], { encoding: "utf8" });
		if (check.status !== 0) continue;
		if (hasHeartbeat(python)) return python;
	}
	return null;
}

const python = resolveReplPython();
/** Named predicate: a runtime without the heartbeat cannot prove anything here, so it skips. */
const kernelPythonWithoutHeartbeat = python === null;

/**
 * Whether the resolved runtime marks the post-run finishing phase in its frames. A kernel venv
 * built before that change still reports protocol 4 and still sends heartbeats, so the capability
 * cannot be inferred from the protocol number - and asserting the marker against a stale runtime
 * would be a false red in exactly the mixed-version window this fork lives in.
 */
function hasFinishingMarker(runtimePython: string): boolean {
	const check = spawnSync(
		runtimePython,
		["-c", "import inspect, rlm.repl as r; print('finishing' in inspect.getsource(r._heartbeat_frame))"],
		{ encoding: "utf8" },
	);
	return check.status === 0 && (check.stdout ?? "").trim() === "True";
}

/** Named predicate: a runtime that does not mark the phase cannot prove the host reads it. */
const runtimeWithoutFinishingMarker = python === null || !hasFinishingMarker(python);

function tickProbe(body: string): string {
	return ["import rlm.repl as _r", "before = _r.loop_tick()", body, "str(before) + ',' + str(_r.loop_tick())"].join(
		"\n",
	);
}

function ticksOf(resultText: string | undefined): { before: number; after: number } {
	const [before, after] = (resultText ?? "")
		.replace(/'/g, "")
		.split(",")
		.map((part) => Number(part));
	return { before: before ?? Number.NaN, after: after ?? Number.NaN };
}

describe.skipIf(kernelPythonWithoutHeartbeat)(
	"kernel heartbeat liveness (real runtime)",
	{ tags: ["kernel-heavy"] },
	() => {
		let dir = "";

		beforeAll(() => {
			dir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-heartbeat-live-"));
		});

		afterAll(() => {
			if (dir) rmSync(dir, { recursive: true, force: true });
		});

		function newManager(protocol?: string): ReplKernelManager {
			return new ReplKernelManager({
				python: python as string,
				cwd: dir,
				env: {
					KERNEL_HEARTBEAT_INTERVAL_MS: String(HEARTBEAT_INTERVAL_MS),
					...(protocol === undefined ? {} : { PRIME_AGENT_KERNEL_PROTOCOL: protocol }),
				},
			});
		}

		it("ticks through an awaited sleep and freezes under a blocking one", async () => {
			const manager = newManager();
			try {
				await manager.start();
				expect(manager.negotiatedProtocol).toBe(4);

				const awaited = await manager.execute(tickProbe(`import asyncio\nawait asyncio.sleep(${CELL_SECONDS})`));
				expect(awaited.status).toBe("ok");
				const awaitedTicks = ticksOf(awaited.result);
				expect(awaitedTicks.after).toBeGreaterThan(awaitedTicks.before);
				const liveLiveness = manager.kernelLiveness;
				expect(liveLiveness.latest).toBeDefined();
				expect(liveLiveness.previous).toBeDefined();
				expect((liveLiveness.latest?.tick ?? 0) > (liveLiveness.previous?.tick ?? 0)).toBe(true);
				expect(liveLiveness.rejectedFrames).toBe(0);

				const blocking = await manager.execute(tickProbe(`import time\ntime.sleep(${CELL_SECONDS})`));
				expect(blocking.status).toBe("ok");
				const blockedTicks = ticksOf(blocking.result);
				// The cell itself is the witness: the loop never ran a callback.
				expect(blockedTicks.after).toBe(blockedTicks.before);
				const blockedLiveness = manager.kernelLiveness;
				// ... and the frames kept arriving anyway, from the thread, with the tick frozen.
				// That is the whole distinction: silence with a live sender and a dead loop.
				expect(blockedLiveness.latest).toBeDefined();
				expect(blockedLiveness.previous).toBeDefined();
				expect(blockedLiveness.latest?.tick).toBe(blockedLiveness.previous?.tick);
				expect((blockedLiveness.latest?.receivedAt ?? 0) > (blockedLiveness.previous?.receivedAt ?? 0)).toBe(true);
				expect(blockedLiveness.latest?.tick).toBe(blockedTicks.before);
			} finally {
				await manager.shutdown({ snapshot: false, drainHostRequests: true });
			}
		}, 60_000);

		it.skipIf(runtimeWithoutFinishingMarker)(
			"attributes the post-run finishing phase to its cell, with the loop frozen (K-P2-2)",
			async () => {
				const manager = newManager();
				try {
					await manager.start();
					// The trailing expression's `repr` runs after the cell body: the runtime is in
					// its finishing phase, the event loop is blocked by design, and the frames keep
					// coming from the sender thread. This is the shape the host used to read as "no
					// cell in flight" (the frame carried no id) and therefore could not vouch for.
					const cell = [
						"import time",
						"class _SlowRepr:",
						"    def __repr__(self):",
						`        time.sleep(${CELL_SECONDS})`,
						"        return 'slow'",
						"_SlowRepr()",
					].join("\n");
					const result = await manager.execute(cell);
					expect(result.status).toBe("ok");
					expect(result.result).toBe("slow");

					const liveness = manager.kernelLiveness;
					expect(liveness.latest?.finishing).toBe(true);
					expect(typeof liveness.latest?.cellId).toBe("string");
					expect(liveness.previous).toBeDefined();
					// The tick is frozen, and that is now evidence *for* the kernel rather than
					// against it: the phase marker is what tells the two apart.
					expect(liveness.latest?.tick).toBe(liveness.previous?.tick);
					expect(liveness.rejectedFrames).toBe(0);
				} finally {
					await manager.shutdown({ snapshot: false, drainHostRequests: true });
				}
			},
			60_000,
		);

		it("reports the live bash handle of a running command", async () => {
			const manager = newManager();
			try {
				await manager.start();
				const cell = [
					"import asyncio",
					"from rlm import bash",
					"handle = bash('sleep 30')",
					"print('streamed while the handle is live', flush=True)",
					`await asyncio.sleep(${CELL_SECONDS})`,
					"handle.kill(grace=1.0)",
				].join("\n");
				const pending = manager.execute(cell);
				// Sampled mid-cell: this is the fact the vouch reads while a turn is silent.
				await vi.waitFor(
					() => {
						expect(manager.kernelLiveness.latest?.bashHandles ?? 0).toBeGreaterThanOrEqual(1);
					},
					{ timeout: 15_000, interval: 50 },
				);
				expect(manager.isKernelBashRunning).toBe(true);
				expect(manager.hasActiveExecution).toBe(true);
				const result = await pending;
				expect(result.status).toBe("ok");
				expect(result.stdout).toContain("streamed while the handle is live");
				// The heartbeat never leaked into the cell's own output stream.
				expect(result.stdout).not.toContain("heartbeat");
			} finally {
				await manager.shutdown({ snapshot: false, drainHostRequests: true });
			}
		}, 60_000);

		it("stays silent while idle and while the host asked for protocol 3", async () => {
			const manager = newManager();
			try {
				await manager.start();
				// Positive control for "only while a cell is in flight": ten intervals pass with no
				// request in flight and not one frame is retained.
				await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_INTERVAL_MS * 10));
				expect(manager.kernelLiveness.latest).toBeUndefined();
				const result = await manager.execute(`import asyncio\nawait asyncio.sleep(1)`);
				expect(result.status).toBe("ok");
				expect(manager.kernelLiveness.latest).toBeDefined();
			} finally {
				await manager.shutdown({ snapshot: false, drainHostRequests: true });
			}

			// B11 reverse, on a real runtime: an old host (protocol 3) never meets the new kind, so
			// the corruption path cannot fire in the mixed-version window.
			const legacy = newManager("3");
			try {
				await legacy.start();
				expect(legacy.negotiatedProtocol).toBe(3);
				const result = await legacy.execute(`import time\ntime.sleep(1.2)`);
				expect(result.status).toBe("ok");
				expect(legacy.kernelLiveness.latest).toBeUndefined();
				expect(legacy.isRunning).toBe(true);
			} finally {
				await legacy.shutdown({ snapshot: false, drainHostRequests: true });
			}
		}, 60_000);
	},
);
