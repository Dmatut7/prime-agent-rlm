import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

let tempDir = "";

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

describe("ReplKernelManager startup", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-startup-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("surfaces kernels that exit before ready with the stderr tail", async () => {
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", 'echo "fake runtime died before ready" >&2', "exit 42", ""].join("\n"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(
				/Kernel exited before ready[\s\S]*fake runtime died before ready/,
			);
		} finally {
			errorSpy.mockRestore();
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("lands the exact kernel stderr bytes in the log file", async () => {
		const python = join(tempDir, "python");
		writeExecutable(
			python,
			[
				"#!/bin/sh",
				"printf 'progress 1\\rprogress 2\\rcaf\\303' >&2",
				"sleep 0.2",
				"printf '\\251\\n' >&2",
				'printf "final stderr line" >&2',
				"exit 42",
				"",
			].join("\n"),
		);
		const stderrLogPath = join(tempDir, "kernel-stderr.log");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir, stderrLogPath });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(
				/Kernel exited before ready[\s\S]*caf\u00e9[\s\S]*final stderr line/,
			);
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			const expected = Buffer.from("progress 1\rprogress 2\rcaf\u00e9\nfinal stderr line", "utf8");
			expect(readFileSync(stderrLogPath).equals(expected)).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("rotates an oversized stderr log at spawn", async () => {
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", 'echo "fresh incarnation" >&2', "exit 42", ""].join("\n"));
		const stderrLogPath = join(tempDir, "kernel-stderr.log");
		const previous = Buffer.alloc(5 * 1024 * 1024 + 1, "x");
		writeFileSync(stderrLogPath, previous);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir, stderrLogPath });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(/Kernel exited before ready/);
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			expect(statSync(`${stderrLogPath}.old`).size).toBe(previous.length);
			expect(readFileSync(stderrLogPath, "utf8")).toBe("fresh incarnation\n");
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("creates the stderr log 0600 for the session owner only", async () => {
		if (process.platform === "win32") return;
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", 'echo "boom before ready" >&2', "exit 42", ""].join("\n"));
		const stderrLogPath = join(tempDir, "kernel-stderr.log");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir, stderrLogPath });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(/Kernel exited before ready/);
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			// Fork policy #1249: session artifacts stay owner-only, and openSync's mode
			// applies at creation only, so the descriptor is re-asserted as well.
			expect(statSync(stderrLogPath).mode & 0o777).toBe(0o600);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("refuses a planted symlink at the stderr log path and still reports stderr", async () => {
		if (process.platform === "win32") return;
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", 'echo "boom before ready" >&2', "exit 42", ""].join("\n"));
		const stderrLogPath = join(tempDir, "kernel-stderr.log");
		const victimPath = join(tempDir, "victim.log");
		writeFileSync(victimPath, "");
		symlinkSync(victimPath, stderrLogPath);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir, stderrLogPath });

		try {
			// The log open must fail closed and fall back to a pipe, so the startup error
			// still carries the kernel's last words while the link target stays untouched.
			await expect(manager.execute("print(1)")).rejects.toThrow(
				/Kernel exited before ready[\s\S]*boom before ready/,
			);
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			expect(lstatSync(stderrLogPath).isSymbolicLink()).toBe(true);
			expect(readFileSync(victimPath, "utf8")).toBe("");
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("keeps logging when stderr log rotation fails", async () => {
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", 'echo "fresh incarnation" >&2', "exit 42", ""].join("\n"));
		const stderrLogPath = join(tempDir, "kernel-stderr.log");
		const previous = Buffer.alloc(5 * 1024 * 1024 + 1, "x");
		writeFileSync(stderrLogPath, previous);
		// rmSync(.old, { force: true }) throws ERR_FS_EISDIR on a directory, so rotation
		// fails deterministically without depending on the platform's rename-over rules.
		mkdirSync(`${stderrLogPath}.old`);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir, stderrLogPath });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(
				/Kernel exited before ready[\s\S]*fresh incarnation/,
			);
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			// A failed rotation must not cost the log: the new bytes are appended to the
			// oversized file instead of the whole log being dropped for this spawn.
			expect(statSync(stderrLogPath).size).toBe(previous.length + "fresh incarnation\n".length);
			expect(statSync(`${stderrLogPath}.old`).isDirectory()).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("reports only the current incarnation's stderr from the log", async () => {
		const python = join(tempDir, "python");
		const stderrLogPath = join(tempDir, "kernel-stderr.log");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const failOnce = async (stderrLine: string): Promise<string> => {
			writeExecutable(python, ["#!/bin/sh", `echo "${stderrLine}" >&2`, "exit 42", ""].join("\n"));
			const manager = new ReplKernelManager({ python, cwd: tempDir, stderrLogPath });
			const message = await manager.execute("print(1)").then(
				() => "",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			return message;
		};

		try {
			await failOnce("first incarnation");
			const second = await failOnce("second incarnation");
			expect(second).toMatch(/second incarnation/);
			// Both lines are under 20 bytes, so without a per-spawn window start the tail
			// still carries the previous incarnation's bytes into this failure report.
			expect(second).not.toMatch(/first incarnation/);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("fails a runtime announcing an unexpected protocol version", async () => {
		const python = join(tempDir, "python");
		writeExecutable(
			python,
			["#!/bin/sh", `echo '{"event":"ready","protocol":1,"python":"3.13.0"}'`, "exec sleep 60", ""].join("\n"),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(/speaks protocol 1, expected 3/);
		} finally {
			errorSpy.mockRestore();
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("rejects promptly when the kernel process fails to spawn", async () => {
		const python = join(tempDir, "does-not-exist");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir });

		try {
			// Without prompt rejection this would ride out the 30s ready timeout.
			await expect(manager.start()).rejects.toThrow(/ENOENT/);
		} finally {
			errorSpy.mockRestore();
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("times out a runtime that never sends ready", async () => {
		vi.useFakeTimers();
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", "exec sleep 120", ""].join("\n"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir });

		try {
			const startPromise = manager.start();
			const expectation = expect(startPromise).rejects.toThrow(/did not become ready within 30000ms/);
			await vi.advanceTimersByTimeAsync(30_000);
			// The failure path runs a graceful shutdown bounded by its own deadline.
			await vi.advanceTimersByTimeAsync(5_000);
			await expectation;
		} finally {
			vi.useRealTimers();
			errorSpy.mockRestore();
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});
});
