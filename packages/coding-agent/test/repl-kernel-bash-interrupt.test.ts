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

describeIfKernel("repl kernel interrupt kills bash handles (real runtime)", { tags: ["kernel-heavy"] }, () => {
	let dir = "";

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-bash-interrupt-"));
	});

	afterAll(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("aborting a cell kills its background bash handles before their side effects land", async () => {
		const marker = join(dir, "marker");
		const manager = new ReplKernelManager({ python: python as string, cwd: dir });
		try {
			const controller = new AbortController();
			let pid: number | undefined;
			let accumulated = "";
			const cell = manager.execute(
				[
					"import asyncio",
					"from rlm import bash",
					// Background handle: pid touched before any await.
					`h = bash('sleep 3 && touch ${marker}')`,
					"print('spawned', h.pid, flush=True)",
					"await asyncio.sleep(30)",
				].join("\n"),
				{
					signal: controller.signal,
					// print() ships each argument as its own frame; accumulate.
					onStream: (text) => {
						if (pid === undefined) {
							accumulated += text;
							const match = /spawned\s+(\d+)/.exec(accumulated);
							if (match) pid = Number(match[1]);
						}
					},
				},
			);
			await expect.poll(() => pid, { timeout: 10_000 }).toBeDefined();

			controller.abort();
			await expect(cell).resolves.toMatchObject({ status: "aborted" });

			// TERM grace (0.5s) escalates to KILL; the reaped group leader must vanish.
			await expect.poll(() => pidExists(pid as number), { timeout: 10_000 }).toBe(false);

			// Wait past the command's own window: the side effect must never land.
			await new Promise((resolveTimer) => globalThis.setTimeout(resolveTimer, 3_500));
			expect(existsSync(marker)).toBe(false);
		} finally {
			await manager.shutdown({ drainHostRequests: true });
		}
	}, 60_000);

	it("an interrupt of a later cell leaves an earlier cell's background handle running", async () => {
		const marker = join(dir, "marker-early");
		const manager = new ReplKernelManager({ python: python as string, cwd: dir });
		try {
			const setup = await manager.execute(
				["from rlm import bash", `early = bash('sleep 1 && touch ${marker}')`, "early_pid = early.pid"].join("\n"),
			);
			expect(setup.status).toBe("ok");

			const controller = new AbortController();
			const blocking = manager.execute("import asyncio\nawait asyncio.sleep(30)", {
				signal: controller.signal,
			});
			await new Promise((resolveTimer) => globalThis.setTimeout(resolveTimer, 500));
			controller.abort();
			await expect(blocking).resolves.toMatchObject({ status: "aborted" });

			const check = await manager.execute("result = await early\nprint(result.exit_code)");
			expect(check.stdout.trim()).toBe("0");
			expect(existsSync(marker)).toBe(true);
		} finally {
			await manager.shutdown({ drainHostRequests: true });
		}
	}, 60_000);
});
