import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type HostRequestHandlers, ReplKernelManager } from "../src/core/kernel/index.js";
import { createRlmRunHostHandler } from "../src/core/rlm-runtime.js";

type AbortInternals = {
	state: "running";
	writeLine: (request: Record<string, unknown>) => Promise<void>;
	handleEvent: (event: Record<string, unknown>) => void;
	wireChild: (child: AbortInternals["child"]) => void;
	inFlightHostRequests: Set<Promise<void>>;
	kernelStderr: string;
	child: EventEmitter & {
		exitCode: number | null;
		signalCode: NodeJS.Signals | null;
		kill: (signal?: NodeJS.Signals | number) => boolean;
		pid?: number;
		stdin: { destroyed: boolean; destroy: () => void };
		stdout?: { destroy: () => void; on: (event: string, listener: (...args: unknown[]) => void) => void };
		stderr?: { destroy: () => void; on: (event: string, listener: (...args: unknown[]) => void) => void };
	};
};

function configuredManager(
	onSend: (request: Record<string, unknown>, internals: AbortInternals) => void | Promise<void>,
	hostHandlers?: HostRequestHandlers,
): {
	manager: ReplKernelManager;
	internals: AbortInternals;
} {
	const manager = new ReplKernelManager({ cwd: process.cwd(), hostHandlers });
	const internals = manager as unknown as AbortInternals;
	const child = Object.assign(new EventEmitter(), {
		exitCode: null,
		signalCode: null,
		kill: vi.fn(() => true),
		pid: undefined,
		stdin: { destroyed: false, destroy: vi.fn() },
		stdout: { destroy: vi.fn(), on: vi.fn() },
		stderr: { destroy: vi.fn(), on: vi.fn() },
	});
	Object.assign(internals, {
		state: "running",
		writeLine: vi.fn(async (request: Record<string, unknown>) => onSend(request, internals)),
		child,
	});
	internals.wireChild(child);
	return { manager, internals };
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await sleep(10);
	}
}

async function expectSettlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
	let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
	const result = await Promise.race([
		promise.then(() => "settled" as const),
		new Promise<"timeout">((resolve) => {
			timeout = globalThis.setTimeout(() => resolve("timeout"), timeoutMs);
		}),
	]);
	if (timeout) globalThis.clearTimeout(timeout);
	expect(result).toBe("settled");
}

/** A signal-aware rlm.run handler: settles (rejecting) the moment the host signal aborts. */
function abortAwareRunHandler(observed: { started?: boolean; signal?: AbortSignal; settled?: boolean }) {
	return createRlmRunHostHandler(async (_request, signal) => {
		observed.started = true;
		observed.signal = signal;
		try {
			await new Promise<void>((_resolve, reject) => {
				const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
			return {};
		} finally {
			observed.settled = true;
		}
	});
}

describe("ReplKernelManager host request abort on teardown", () => {
	it("hands host handlers a live signal until teardown aborts it", async () => {
		const observed: { started?: boolean; signal?: AbortSignal; settled?: boolean } = {};
		const { manager, internals } = configuredManager(
			(request, state) => {
				if (request.type !== "shutdown") return;
				state.handleEvent({ event: "done", id: request.id, status: "ok" });
				state.child.exitCode = 0;
				state.child.emit("exit", 0, null);
			},
			{ "rlm.run": abortAwareRunHandler(observed) },
		);

		internals.handleEvent({ event: "host_request", id: "hr-live", data: { type: "rlm.run", prompt: "live child" } });
		await waitFor(() => observed.started === true);
		expect(observed.signal).toBeInstanceOf(AbortSignal);
		expect(observed.signal?.aborted).toBe(false);

		const shutdown = manager.shutdown({ drainHostRequests: true });
		// The aborted handler rejects at once, so the drain settles far below the
		// HOST_REQUEST_SHUTDOWN_TIMEOUT_MS deadline instead of waiting the handler out.
		await expectSettlesWithin(shutdown, 2000);
		expect(observed.signal?.aborted).toBe(true);
		expect(observed.settled).toBe(true);
		expect(observed.signal?.reason).toBeInstanceOf(Error);
		expect((observed.signal?.reason as Error).message).toBe("IPython kernel shut down");
		expect(internals.kernelStderr).toContain("host request failed for hr-live");
		expect(internals.inFlightHostRequests.size).toBe(0);
	});

	it("kill() aborts in-flight host requests with the kill reason", async () => {
		const observed: { started?: boolean; signal?: AbortSignal } = {};
		const { manager, internals } = configuredManager(() => {}, {
			"rlm.run": createRlmRunHostHandler(async (_request, signal) => {
				observed.started = true;
				observed.signal = signal;
				return {};
			}),
		});

		internals.handleEvent({ event: "host_request", id: "hr-kill", data: { type: "rlm.run", prompt: "kill child" } });
		await waitFor(() => observed.started === true);
		expect(observed.signal?.aborted).toBe(false);

		await manager.kill();
		expect(observed.signal?.aborted).toBe(true);
		expect((observed.signal?.reason as Error).message).toBe("IPython kernel killed");
	});

	it("disposeSync() aborts in-flight host requests with the dispose reason", async () => {
		const observed: { started?: boolean; signal?: AbortSignal } = {};
		const { manager, internals } = configuredManager(() => {}, {
			"rlm.run": createRlmRunHostHandler(async (_request, signal) => {
				observed.started = true;
				observed.signal = signal;
				return {};
			}),
		});

		internals.handleEvent({
			event: "host_request",
			id: "hr-dispose",
			data: { type: "rlm.run", prompt: "dispose child" },
		});
		await waitFor(() => observed.started === true);

		manager.disposeSync();
		expect(observed.signal?.aborted).toBe(true);
		expect((observed.signal?.reason as Error).message).toBe("IPython kernel disposed");
	});

	it("a kernel child exit aborts in-flight host requests", async () => {
		const observed: { started?: boolean; signal?: AbortSignal } = {};
		const { internals } = configuredManager(() => {}, {
			"rlm.run": createRlmRunHostHandler(async (_request, signal) => {
				observed.started = true;
				observed.signal = signal;
				return {};
			}),
		});

		internals.handleEvent({ event: "host_request", id: "hr-exit", data: { type: "rlm.run", prompt: "exit child" } });
		await waitFor(() => observed.started === true);

		// An unexpected kernel exit runs the exit handler's cleanup path.
		internals.child.exitCode = 1;
		internals.child.emit("exit", 1, null);
		expect(observed.signal?.aborted).toBe(true);
		expect((observed.signal?.reason as Error).message).toBe("IPython kernel stopped");
	});
});

describe("ReplKernelManager host request signal across restart", () => {
	let tempDir: string;
	let stubPython: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-repl-host-abort-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		// Minimal REPL-protocol kernel: ready handshake, acknowledges executes, exits on shutdown.
		stubPython = join(tempDir, "stub-repl.py");
	});

	it("issues a live host request signal again after a restart", async () => {
		writeFileSync(
			stubPython,
			[
				"#!/usr/bin/env python3",
				"import sys, json",
				"def send(obj):",
				"    sys.stdout.write(json.dumps(obj) + '\\n')",
				"    sys.stdout.flush()",
				"send({'event': 'ready', 'protocol': 3})",
				"for line in sys.stdin:",
				"    line = line.strip()",
				"    if not line:",
				"        continue",
				"    try:",
				"        req = json.loads(line)",
				"    except Exception:",
				"        continue",
				"    if req.get('type') == 'shutdown':",
				"        send({'event': 'done', 'id': req.get('id'), 'status': 'ok'})",
				"        sys.exit(0)",
				"    if req.get('type') == 'execute':",
				"        send({'event': 'done', 'id': req.get('id'), 'status': 'ok'})",
				"",
			].join("\n"),
		);
		chmodSync(stubPython, 0o755);

		const signals: Array<AbortSignal | undefined> = [];
		let releaseAll: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseAll = resolve;
		});
		const manager = new ReplKernelManager({
			python: stubPython,
			cwd: tempDir,
			hostHandlers: {
				"rlm.run": createRlmRunHostHandler(async (_request, signal) => {
					signals.push(signal);
					await gate;
					return { rlm_child_id: "stub-child", name: "stub-child", session_dir: tempDir, model: "test/model" };
				}),
			},
		});
		const internals = manager as unknown as { handleEvent: (event: Record<string, unknown>) => void };

		try {
			await manager.start();
			internals.handleEvent({ event: "host_request", id: "hr-before", data: { type: "rlm.run", prompt: "first" } });
			await waitFor(() => signals.length === 1);
			expect(signals[0]?.aborted).toBe(false);

			await manager.restart();

			internals.handleEvent({ event: "host_request", id: "hr-after", data: { type: "rlm.run", prompt: "second" } });
			await waitFor(() => signals.length === 2);
			// The teardown aborted the first kernel's controller; the restarted kernel
			// must serve new requests from a fresh, live one.
			expect(signals[0]?.aborted).toBe(true);
			expect(signals[1]?.aborted).toBe(false);
		} finally {
			releaseAll();
			await manager.shutdown({ drainHostRequests: true }).catch(() => undefined);
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
