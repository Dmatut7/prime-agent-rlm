import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelDeathCause } from "../src/core/kernel/index.js";
import { classifyKernelExit, ReplKernelManager } from "../src/core/kernel/index.js";

/**
 * A fake kernel runtime that can die on demand: `exit(9)` for a plain crash, a stderr
 * MemoryError plus SIGKILL for the OOM shape, and a corrupt frame for the protocol-repair
 * kill (the intentional path that must never be counted as an unexpected exit).
 */
function writeFakeRuntime(path: string): void {
	writeFileSync(
		path,
		`#!/usr/bin/env node
const readline = require("node:readline");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ event: "ready", protocol: 3, python: process.version });
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "execute") {
    if (request.code === "die9") {
      process.stderr.write("cell failed hard\\n");
      setTimeout(() => process.exit(9), 20);
      return;
    }
    if (request.code === "oom") {
      process.stderr.write("MemoryError: out of memory allocating 4096 MiB\\n");
      setTimeout(() => process.kill(process.pid, "SIGKILL"), 60);
      return;
    }
    if (request.code === "sigkill-plain") {
      setTimeout(() => process.kill(process.pid, "SIGKILL"), 20);
      return;
    }
    if (request.code === "corrupt") {
      process.stdout.write("BROKEN-FRAME\\n");
      return;
    }
    if (request.code === "hang") return;
    emit({ event: "stdout", id: request.id, text: "ok" });
    emit({ event: "done", id: request.id, status: "ok" });
    return;
  }
  if (request.type === "shutdown") {
    emit({ event: "done", id: request.id, status: "ok" });
    process.exit(0);
  }
});
`,
	);
	chmodSync(path, 0o755);
}

let tempDir = "";

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "prime-agent-unexpected-exit-"));
});

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

let managerCount = 0;

function newManager(options: {
	onUnexpectedExit?: (cause: KernelDeathCause) => void;
	bootstrapCode?: string;
}): ReplKernelManager {
	// One script per manager: rewriting a shared file under a still-exiting child makes the next
	// spawn read a half-written script, which is a test artifact, not a kernel fact.
	managerCount += 1;
	const python = join(tempDir, `python-${managerCount}`);
	writeFakeRuntime(python);
	return new ReplKernelManager({
		python,
		cwd: tempDir,
		...(options.onUnexpectedExit ? { onUnexpectedExit: options.onUnexpectedExit } : {}),
		...(options.bootstrapCode ? { bootstrapCode: options.bootstrapCode } : {}),
	});
}

describe("classifyKernelExit", () => {
	const facts = {
		code: 9 as number | null,
		signal: null as NodeJS.Signals | null,
		stderrTail: "",
		at: 1_700_000_000_000,
	};

	it("reports an unowned exit as an unexpected death with origin unknown", () => {
		const verdict = classifyKernelExit({
			...facts,
			intentionalOrigin: undefined,
			gracefulShutdownOwned: false,
			state: "running",
		});
		expect(verdict.unexpected).toBe(true);
		if (verdict.unexpected !== true) return;
		expect(verdict.cause.origin).toBe("unknown");
		expect(verdict.cause.code).toBe(9);
		expect(verdict.cause.at).toBe(facts.at);
	});

	it("separates a SIGKILL with memory evidence from an unexplained SIGKILL", () => {
		const withEvidence = classifyKernelExit({
			...facts,
			code: null,
			signal: "SIGKILL",
			stderrTail: "Traceback ...\\nMemoryError: out of memory",
			intentionalOrigin: undefined,
			gracefulShutdownOwned: false,
			state: "running",
		});
		expect(withEvidence.unexpected).toBe(true);
		if (withEvidence.unexpected) expect(withEvidence.cause.origin).toBe("oom_suspect");

		const withoutEvidence = classifyKernelExit({
			...facts,
			code: null,
			signal: "SIGKILL",
			stderrTail: "cell failed hard",
			intentionalOrigin: undefined,
			gracefulShutdownOwned: false,
			state: "running",
		});
		expect(withoutEvidence.unexpected).toBe(true);
		// Not provable from these facts, so it stays unknown instead of guessing (B6).
		if (withoutEvidence.unexpected) expect(withoutEvidence.cause.origin).toBe("unknown");
	});

	it("never counts an intentional origin, including the two repair kills", () => {
		const origins = ["shutdown", "kill", "dispose_sync", "repair_kill", "bootstrap_fail_kill"] as const;
		expect(origins.length).toBeGreaterThan(0);
		for (const origin of origins) {
			const verdict = classifyKernelExit({
				...facts,
				intentionalOrigin: origin,
				gracefulShutdownOwned: false,
				state: "running",
			});
			expect(verdict.unexpected).toBe(false);
			if (verdict.unexpected) continue;
			expect(verdict.origin).toBe(origin);
		}
	});

	it("treats a protocol-repair kill as intentional even after the state returned to idle", () => {
		// killChildToIdle sets state="shutdown" and then back to "idle" before it returns, and
		// cleanupResources bumped startGeneration on the way: both auxiliary facts already say
		// "not a graceful shutdown". Only the explicit origin keeps this out of the budget.
		const verdict = classifyKernelExit({
			...facts,
			intentionalOrigin: "repair_kill",
			gracefulShutdownOwned: false,
			state: "idle",
		});
		expect(verdict).toEqual({ unexpected: false, origin: "repair_kill" });
	});

	it("treats a graceful-shutdown-owned exit and a teardown state as intentional", () => {
		const owned = classifyKernelExit({
			...facts,
			intentionalOrigin: undefined,
			gracefulShutdownOwned: true,
			state: "shutdown",
		});
		expect(owned).toEqual({ unexpected: false, origin: "graceful_shutdown" });
		const teardownState = classifyKernelExit({
			...facts,
			intentionalOrigin: undefined,
			gracefulShutdownOwned: false,
			state: "shutdown",
		});
		expect(teardownState.unexpected).toBe(false);
	});
});

describe("ReplKernelManager unexpected exit", () => {
	it("reports a crashing kernel once, with its code and stderr tail", async () => {
		const causes: KernelDeathCause[] = [];
		const manager = newManager({ onUnexpectedExit: (cause) => causes.push(cause) });
		try {
			await expect(manager.execute("die9")).rejects.toThrow();
			await vi.waitFor(() => expect(causes.length).toBe(1), { timeout: 15_000 });
			expect(causes[0]!.code).toBe(9);
			expect(causes[0]!.origin).toBe("unknown");
			expect(causes[0]!.stderrTail).toContain("cell failed hard");
			expect(manager.isRunning).toBe(false);
		} finally {
			manager.disposeSync();
		}
	});

	it("classifies a SIGKILL with memory evidence as oom_suspect", async () => {
		const causes: KernelDeathCause[] = [];
		const manager = newManager({ onUnexpectedExit: (cause) => causes.push(cause) });
		try {
			await expect(manager.execute("oom")).rejects.toThrow();
			await vi.waitFor(() => expect(causes.length).toBe(1), { timeout: 15_000 });
			expect(causes[0]!.signal).toBe("SIGKILL");
			expect(causes[0]!.origin).toBe("oom_suspect");
		} finally {
			manager.disposeSync();
		}
	});

	it("does not report a protocol-repair kill as an unexpected exit", async () => {
		const causes: KernelDeathCause[] = [];
		const manager = newManager({
			onUnexpectedExit: (cause) => causes.push(cause),
			bootstrapCode: "bootstrap",
		});
		try {
			await manager.start();
			// Corruption while running triggers failProtocolFrame -> killChildToIdle, whose exit
			// callback runs after cleanupResources cleared the child: the guard, not the
			// classification, keeps it quiet. The classification must hold anyway.
			await expect(manager.execute("corrupt")).rejects.toThrow();
			await vi.waitFor(() => expect(manager.isRunning).toBe(true), { timeout: 15_000 });
			const result = await manager.execute("1+1");
			expect(result.status).toBe("ok");
			expect(causes).toEqual([]);
		} finally {
			manager.disposeSync();
		}
	});

	// Split per teardown so a failure names the path, and so one child's exit cannot be attributed
	// to the next manager's startup.
	const teardowns: [string, (manager: ReplKernelManager) => Promise<void>][] = [
		["shutdown", (manager) => manager.shutdown().then(() => undefined)],
		["kill", (manager) => manager.kill()],
		["disposeSync", async (manager) => manager.disposeSync()],
	];
	expect(teardowns.length).toBeGreaterThan(0);
	for (const [name, teardown] of teardowns) {
		it(`reports no unexpected exit for ${name}`, async () => {
			const causes: KernelDeathCause[] = [];
			const manager = newManager({ onUnexpectedExit: (cause) => causes.push(cause) });
			await manager.start();
			expect(manager.isRunning).toBe(true);
			await teardown(manager);
			// Give a late exit event a chance to be misclassified before asserting silence.
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(causes).toEqual([]);
		});
	}
});
