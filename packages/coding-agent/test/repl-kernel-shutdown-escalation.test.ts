import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

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

function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describeIfKernel("repl kernel shutdown under busy cells (real runtime)", { tags: ["kernel-heavy"] }, () => {
	let dir = "";

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-shutdown-busy-"));
	});

	afterAll(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("interrupts a busy-loop cell and shuts down gracefully in bounded time", async () => {
		const manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const kernelPid = Number((await manager.execute("import os\nprint(os.getpid(), flush=True)")).stdout.trim());
		expect(kernelPid).toBeGreaterThan(0);

		// Fire a cell that never yields; shutdown must interrupt it out of the FIFO.
		const busy = manager.execute("while True: pass");
		busy.catch(() => undefined);
		await new Promise((resolveTimer) => globalThis.setTimeout(resolveTimer, 500));

		const startedAt = Date.now();
		await manager.shutdown();
		const elapsed = Date.now() - startedAt;
		// The interrupt frees the FIFO, so the graceful path wins well under the
		// 5s protocol deadline; without it this would take >= 5s.
		expect(elapsed).toBeLessThan(4_000);
		await expect.poll(() => pidExists(kernelPid), { timeout: 5_000 }).toBe(false);
	}, 60_000);

	it("escalates to SIGKILL when the cell ignores SIGINT and SIGTERM", async () => {
		const manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const kernelPid = Number((await manager.execute("import os\nprint(os.getpid(), flush=True)")).stdout.trim());
		expect(kernelPid).toBeGreaterThan(0);

		const busy = manager.execute(
			[
				"import signal",
				"signal.signal(signal.SIGINT, signal.SIG_IGN)",
				"signal.signal(signal.SIGTERM, signal.SIG_IGN)",
				"while True: pass",
			].join("\n"),
		);
		busy.catch(() => undefined);
		await new Promise((resolveTimer) => globalThis.setTimeout(resolveTimer, 500));

		const startedAt = Date.now();
		await manager.shutdown();
		const elapsed = Date.now() - startedAt;
		// 5s protocol deadline + 2s TERM grace + SIGKILL: bounded, and SIGKILL
		// cannot be ignored, so the kernel must be dead afterwards.
		expect(elapsed).toBeLessThan(12_000);
		await expect.poll(() => pidExists(kernelPid), { timeout: 5_000 }).toBe(false);
	}, 60_000);
});
