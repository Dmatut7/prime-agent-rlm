import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.js";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.js";
import { isProcessAlive } from "../src/utils/child-process.js";

const SIGKILL_EXIT_CODE = 128 + constants.signals.SIGKILL;

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error("Child did not become ready");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function readPidFile(path: string): number | undefined {
	try {
		const raw = readFileSync(path, "utf8").trim();
		if (!raw) return undefined;
		const pid = Number.parseInt(raw, 10);
		return Number.isFinite(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

/** Spawns a shell that starts a long-lived grandchild and records its pid. */
function grandchildScript(testDir: string): string {
	const pidFile = join(testDir, "grandchild.pid");
	const readyFile = join(testDir, "ready");
	return `sleep 60 & echo $! > "${pidFile}"; touch "${readyFile}"; wait`;
}

describe.skipIf(process.platform === "win32")("execCommand", () => {
	it("kills a SIGTERM-ignoring process via process-group SIGKILL", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "prime-agent-exec-test-"));
		const readyFile = join(testDir, "ready");
		const controller = new AbortController();
		let resultPromise: Promise<Awaited<ReturnType<typeof execCommand>>> | undefined;
		try {
			resultPromise = execCommand(
				process.execPath,
				[
					"-e",
					`const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); writeFileSync(process.argv[1], ""); setInterval(() => {}, 1000);`,
					readyFile,
				],
				process.cwd(),
				{ signal: controller.signal },
			);
			await waitForFile(readyFile);

			vi.useFakeTimers();
			controller.abort();

			await vi.advanceTimersByTimeAsync(5000);
			const result = await resultPromise;

			expect(result.killed).toBe(true);
			expect(result.code).toBe(SIGKILL_EXIT_CODE);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
			controller.abort();
			await resultPromise;
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("kills the entire process group on abort so grandchildren do not survive", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "prime-agent-exec-group-"));
		const pidFile = join(testDir, "grandchild.pid");
		const readyFile = join(testDir, "ready");
		const controller = new AbortController();
		let resultPromise: Promise<Awaited<ReturnType<typeof execCommand>>> | undefined;
		try {
			resultPromise = execCommand("bash", ["-c", grandchildScript(testDir)], process.cwd(), {
				signal: controller.signal,
			});
			await waitForFile(readyFile);
			await waitFor(() => readPidFile(pidFile) !== undefined);
			const grandchildPid = readPidFile(pidFile)!;
			expect(isProcessAlive(grandchildPid)).toBe(true);

			controller.abort();
			const result = await resultPromise;

			expect(result.killed).toBe(true);
			await waitFor(() => !isProcessAlive(grandchildPid));
		} finally {
			controller.abort();
			if (resultPromise) await resultPromise.catch(() => {});
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("kills the entire process group on timeout so grandchildren do not survive", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "prime-agent-exec-timeout-"));
		const pidFile = join(testDir, "grandchild.pid");
		const readyFile = join(testDir, "ready");
		try {
			const resultPromise = execCommand("bash", ["-c", grandchildScript(testDir)], process.cwd(), {
				timeout: 500,
			});
			await waitForFile(readyFile);
			await waitFor(() => readPidFile(pidFile) !== undefined);
			const grandchildPid = readPidFile(pidFile)!;
			expect(isProcessAlive(grandchildPid)).toBe(true);

			const result = await resultPromise;

			expect(result.killed).toBe(true);
			expect(result.code).toBe(SIGKILL_EXIT_CODE);
			await waitFor(() => !isProcessAlive(grandchildPid));
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("truncates oversized stdout, keeps the tail, and annotates the result", async () => {
		const totalLines = 20_000;
		const result = await execCommand(
			process.execPath,
			["-e", `for (let i = 0; i < ${totalLines}; i++) console.log("line-" + i + "-" + "x".repeat(40));`],
			process.cwd(),
		);

		expect(result.code).toBe(0);
		expect(result.killed).toBe(false);
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.stdout)).toBeLessThan(DEFAULT_MAX_BYTES + 4096);
		expect(result.stdout).toMatch(/\[Output truncated: showing last .+ of .+\.\]$/);
		// Tail truncation keeps the final output.
		expect(result.stdout).toContain(`line-${totalLines - 1}-`);
		// Early output was dropped.
		expect(result.stdout).not.toContain("line-0-");
	});

	it("annotates line-limit truncation with the total line count", async () => {
		const totalLines = 5_000;
		// Short lines: total stays under the byte limit but exceeds the line limit.
		const result = await execCommand(
			process.execPath,
			["-e", `for (let i = 0; i < ${totalLines}; i++) console.log("l" + i);`],
			process.cwd(),
		);

		expect(result.code).toBe(0);
		expect(result.truncated).toBe(true);
		// Annotation counts lines the same way truncateTail does (the trailing
		// newline adds one empty final segment).
		expect(result.stdout).toMatch(/\[Output truncated: showing last 2000 of \d+ lines\.\]$/);
		expect(result.stdout).toContain(`l${totalLines - 1}`);
		expect(result.stdout).not.toContain("l0\n");
	});

	it("leaves small output untouched and reports truncated=false", async () => {
		const result = await execCommand(
			process.execPath,
			["-e", 'console.log("hello"); console.error("world");'],
			process.cwd(),
		);
		expect(result).toEqual({ stdout: "hello\n", stderr: "world\n", code: 0, killed: false, truncated: false });
	});
});
