import { type ChildProcess, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

/**
 * The wiring seam. Pipe listeners are registered by wireChild, so a fake child put
 * through it exercises the same registration path a real spawn takes. No member here
 * is underscore-prefixed: this is the same shadow-shape the neighbouring kernel
 * teardown tests use, not a probe into a private field.
 */
type WiredKernelManager = {
	state: "running";
	child: ChildProcess | undefined;
	kernelStderr: string;
	wireChild: (child: unknown) => void;
};

type FakePipe = EventEmitter;

type FakeKernelChild = EventEmitter & {
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	kill: (signal?: NodeJS.Signals | number) => boolean;
	pid?: number;
	stdin: FakePipe;
	stdout: FakePipe;
	stderr: FakePipe;
};

function fakeKernelChild(): FakeKernelChild {
	return Object.assign(new EventEmitter(), {
		exitCode: null,
		signalCode: null,
		kill: vi.fn(() => true),
		pid: undefined,
		stdin: new EventEmitter(),
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
	});
}

function wiredManager(): { manager: ReplKernelManager; internals: WiredKernelManager; child: FakeKernelChild } {
	const manager = new ReplKernelManager({ cwd: process.cwd() });
	const internals = manager as unknown as WiredKernelManager;
	const child = fakeKernelChild();
	internals.state = "running";
	internals.child = child as unknown as ChildProcess;
	internals.wireChild(child);
	return { manager, internals, child };
}

describe("ReplKernelManager kernel pipe errors", () => {
	it("absorbs a stdin pipe error as a diagnostic instead of throwing it at the worker", () => {
		const { internals, child } = wiredManager();
		// No listener on a stream's 'error' makes emit() throw, which is how an
		// unhandled write EPIPE became "uncaught exception" in the session worker.
		expect(() => child.stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
		expect(internals.kernelStderr).toContain("kernel stdin error: write EPIPE");
	});

	it("absorbs a stdout pipe error as a diagnostic instead of throwing it at the worker", () => {
		const { internals, child } = wiredManager();
		expect(() => child.stdout.emit("error", new Error("read ECONNRESET"))).not.toThrow();
		expect(internals.kernelStderr).toContain("kernel stdout error: read ECONNRESET");
	});

	it("ignores pipe errors from a child a newer spawn superseded", () => {
		const { internals, child } = wiredManager();
		const replacement = fakeKernelChild();
		internals.child = replacement as unknown as ChildProcess;
		internals.wireChild(replacement);
		internals.kernelStderr = "";

		expect(() => child.stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
		expect(() => child.stdout.emit("error", new Error("read ECONNRESET"))).not.toThrow();
		expect(internals.kernelStderr).toBe("");

		// The live child still reports: the guard is about attribution, not silence.
		expect(() => replacement.stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
		expect(internals.kernelStderr).toContain("kernel stdin error: write EPIPE");
	});
});

function resolveReplPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		resolve(__dirname, "..", "..", "..", "prime-agent-runtime", ".venv", "bin", "python"),
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl, dill"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveReplPython();
const describeIfKernel = python ? describe : describe.skip;

describeIfKernel("ReplKernelManager pipe errors (real runtime)", { tags: ["kernel-heavy"] }, () => {
	let dir = "";
	let manager: ReplKernelManager | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-pipe-"));
	});

	afterEach(async () => {
		await manager?.shutdown({ snapshot: true, drainHostRequests: true });
		manager = undefined;
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = "";
		}
	});

	it("keeps the kernel usable after a pipe write error", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const first = await manager.execute("x = 1");
		expect(first.status).toBe("ok");

		const child = (manager as unknown as { child?: ChildProcess }).child;
		expect(child?.stdin).toBeDefined();
		expect(child?.stdout).toBeDefined();
		// A write racing the kernel's death lands as an 'error' event on the pipe;
		// without a listener Node crashes the worker (observed in production as
		// "uncaught exception: Error: write EPIPE").
		expect(() => child?.stdin?.emit("error", new Error("write EPIPE"))).not.toThrow();
		expect(() => child?.stdout?.emit("error", new Error("read ECONNRESET"))).not.toThrow();

		// The kernel is still healthy: further cells keep executing and shutdown
		// (afterEach) still completes.
		const second = await manager.execute("x + 1");
		expect(second.status).toBe("ok");
		expect(second.result).toBe("2");
	}, 30_000);
});
