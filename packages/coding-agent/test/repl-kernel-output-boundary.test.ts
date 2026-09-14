import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

function resolveReplPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		resolve(__dirname, "..", "..", "..", "prime-agent-runtime", ".venv", "bin", "python"),
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl, dill"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveReplPython();
const kernelPythonMissing = python === null;

const CAP = 10;
const NOTICE = `[... output truncated at ${CAP} chars ...]`;

/** Write a run of one letter to a stream, flushing each write, so the runtime emits one frame per write. */
function writeCells(chunks: { stream: "stdout" | "stderr"; letter: string; size: number }[]): string {
	const lines = ["import sys"];
	for (const { stream, letter, size } of chunks) {
		lines.push(`sys.${stream}.write(${JSON.stringify(letter.repeat(size))})`, `sys.${stream}.flush()`);
	}
	return lines.join("\n");
}

describe.skipIf(kernelPythonMissing)("ReplKernelManager output cap boundary", () => {
	let dir = "";
	let manager: ReplKernelManager | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-output-cap-"));
	});

	afterEach(async () => {
		await manager?.shutdown({ snapshot: false, drainHostRequests: true });
		manager = undefined;
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = "";
		}
	});

	it("does not silently drop stdout that arrives after the cap is exactly filled", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const code = writeCells([
			{ stream: "stdout", letter: "A", size: CAP },
			{ stream: "stdout", letter: "B", size: CAP },
		]);
		const result = await manager.execute(code, { maxOutputChars: CAP });

		expect(result.status).toBe("ok");
		// The runtime sends one frame per flush, so the first frame lands exactly on the cap.
		expect(result.stdout.startsWith("A".repeat(CAP))).toBe(true);
		// Either the tail survived, or the result says it did not: never neither.
		expect(result.stdout.includes("B") || result.stdout.includes(NOTICE)).toBe(true);
		// Bounded as well as honest: the fix must not buy honesty by uncapping the stream.
		expect(result.stdout.length).toBeLessThanOrEqual(CAP + NOTICE.length + 1);
	}, 60_000);

	it("does not silently drop stderr that arrives after the cap is exactly filled", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const code = writeCells([
			{ stream: "stderr", letter: "A", size: CAP },
			{ stream: "stderr", letter: "B", size: CAP },
		]);
		const result = await manager.execute(code, { maxOutputChars: CAP });

		expect(result.status).toBe("ok");
		expect(result.stderr.startsWith("A".repeat(CAP))).toBe(true);
		expect(result.stderr.includes("B") || result.stderr.includes(NOTICE)).toBe(true);
		expect(result.stderr.length).toBeLessThanOrEqual(CAP + NOTICE.length + 1);
	}, 60_000);

	it("does not silently drop stdout that lands on the cap by accumulation", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const code = writeCells([
			{ stream: "stdout", letter: "A", size: 4 },
			{ stream: "stdout", letter: "B", size: CAP - 4 },
			{ stream: "stdout", letter: "C", size: 5 },
		]);
		const result = await manager.execute(code, { maxOutputChars: CAP });

		expect(result.status).toBe("ok");
		expect(result.stdout.startsWith("AAAABBBBBB")).toBe(true);
		expect(result.stdout.includes("C") || result.stdout.includes(NOTICE)).toBe(true);
	}, 60_000);

	it("reports an exactly full stream as complete when nothing follows it", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const code = writeCells([{ stream: "stdout", letter: "A", size: CAP }]);
		const result = await manager.execute(code, { maxOutputChars: CAP });

		expect(result.status).toBe("ok");
		// No chunk was dropped, so there is nothing to warn about.
		expect(result.stdout).toBe("A".repeat(CAP));
		expect(result.stdout).not.toContain("output truncated");
	}, 60_000);

	it("still truncates and flags a chunk that overshoots the cap in one write", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const code = writeCells([{ stream: "stdout", letter: "C", size: CAP * 3 }]);
		const result = await manager.execute(code, { maxOutputChars: CAP });

		expect(result.status).toBe("ok");
		expect(result.stdout).toBe(`${"C".repeat(CAP)}\n${NOTICE}`);
	}, 60_000);
});
