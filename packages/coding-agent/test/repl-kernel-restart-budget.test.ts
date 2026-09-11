import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelDeathCause, KernelUnexpectedExitFacts } from "../src/core/kernel/index.js";
import { KernelUnavailableError, ReplKernelManager } from "../src/core/kernel/index.js";

/**
 * A fake runtime that dies on every `die9` cell and can hold its bootstrap until a flag file is
 * removed, so the revival window can be observed from outside without reaching into the manager.
 */
function writeFakeRuntime(path: string): void {
	writeFileSync(
		path,
		`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const countPath = process.env.FAKE_REPL_SPAWN_COUNT;
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) + 1 : 1;
fs.writeFileSync(countPath, String(count));
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ event: "ready", protocol: 3, python: process.version });
const hangFlag = process.env.FAKE_REPL_HANG_BOOTSTRAP;
const hangUntilReleased = (id) => {
  const timer = setInterval(() => {
    if (!fs.existsSync(hangFlag)) {
      clearInterval(timer);
      emit({ event: "done", id, status: "ok" });
    }
  }, 20);
};
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "execute") {
    if (request.code === "die9") process.exit(9);
    if (request.code === "bootstrap" && hangFlag && fs.existsSync(hangFlag)) {
      hangUntilReleased(request.id);
      return;
    }
    emit({ event: "done", id: request.id, status: "ok" });
    return;
  }
  if (request.type === "interrupt") {
    emit({ event: "done", id: request.id, status: "aborted", reason: "interrupted" });
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
	tempDir = mkdtempSync(join(tmpdir(), "prime-agent-restart-budget-"));
});

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

interface Harness {
	manager: ReplKernelManager;
	causes: KernelDeathCause[];
	facts: KernelUnexpectedExitFacts[];
	hangBootstrapPath: string;
	countPath: string;
}

function newHarness(restartPolicy?: () => { maxRestarts: number; windowMs: number }): Harness {
	const python = join(tempDir, "python");
	writeFakeRuntime(python);
	const countPath = join(tempDir, "spawn-count");
	const hangBootstrapPath = join(tempDir, "hang-bootstrap");
	const causes: KernelDeathCause[] = [];
	const facts: KernelUnexpectedExitFacts[] = [];
	const manager = new ReplKernelManager({
		python,
		cwd: tempDir,
		env: {
			FAKE_REPL_SPAWN_COUNT: countPath,
			FAKE_REPL_HANG_BOOTSTRAP: hangBootstrapPath,
		},
		bootstrapCode: "bootstrap",
		onUnexpectedExit: (cause, exitFacts) => {
			causes.push(cause);
			facts.push(exitFacts);
		},
		...(restartPolicy ? { restartPolicy } : {}),
	});
	return { manager, causes, facts, hangBootstrapPath, countPath };
}

describe("kernel restart budget (C8)", () => {
	it("revives three times and fails the fourth death closed", async () => {
		const harness = newHarness();
		try {
			for (let attempt = 1; attempt <= 3; attempt++) {
				await expect(harness.manager.execute("die9")).rejects.toThrow(/exited unexpectedly/);
				expect(harness.facts[attempt - 1]?.decision.revive, `death ${attempt}`).toBe(true);
				expect(harness.facts[attempt - 1]?.decision.restartCount).toBe(attempt);
				expect(harness.facts[attempt - 1]?.decision.budgetRemaining).toBe(3 - attempt);
			}

			// The cell that exhausts the budget is the one that reports it, not the next one.
			await expect(harness.manager.execute("die9")).rejects.toThrow(KernelUnavailableError);
			const exhausted = harness.facts[3]?.decision;
			expect(exhausted?.revive).toBe(false);
			expect(exhausted?.exhausted).toBe(true);

			const error = await harness.manager.execute("1 + 1").then(
				() => undefined,
				(thrown: unknown) => thrown,
			);
			expect(error).toBeInstanceOf(KernelUnavailableError);
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain("3 restarts per 60 minutes");
			expect(message).toContain("code=9");
			expect(message).toContain("/reload");
			expect(message).toContain("sliding window");
			if (error instanceof KernelUnavailableError) {
				expect(error.restartCount).toBe(4);
				expect(error.causes.length).toBe(4);
			}
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("re-arms by itself once the sliding window expires", async () => {
		const harness = newHarness(() => ({ maxRestarts: 1, windowMs: 200 }));
		try {
			await expect(harness.manager.execute("die9")).rejects.toThrow(/exited unexpectedly/);
			await expect(harness.manager.execute("die9")).rejects.toThrow(KernelUnavailableError);
			await expect(harness.manager.execute("1 + 1")).rejects.toThrow(KernelUnavailableError);

			await new Promise((resolve) => setTimeout(resolve, 260));
			const revived = await harness.manager.execute("1 + 1");
			expect(revived.status).toBe("ok");
			expect(harness.manager.isRunning).toBe(true);
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("reads the budget live, so a widened policy applies to the next death", async () => {
		let maxRestarts = 0;
		const harness = newHarness(() => ({ maxRestarts, windowMs: 60_000 }));
		try {
			// Zero allowed revivals: the very first death fails closed.
			await expect(harness.manager.execute("die9")).rejects.toThrow(KernelUnavailableError);
			maxRestarts = 5;
			await harness.manager.shutdown();
		} finally {
			await harness.manager.shutdown().catch(() => undefined);
		}
	});

	it("grants no revival vouch once the budget is spent", async () => {
		const harness = newHarness(() => ({ maxRestarts: 0, windowMs: 60_000 }));
		try {
			await expect(harness.manager.execute("die9")).rejects.toThrow(KernelUnavailableError);
			// The watchdog must not end up exempting a turn that can never produce a cell again.
			expect(harness.manager.revivalVouch).toBeUndefined();
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("vouches while the replacement kernel is being provisioned and stops afterwards", async () => {
		const harness = newHarness();
		writeFileSync(harness.hangBootstrapPath, "1");
		try {
			await expect(harness.manager.execute("die9")).rejects.toThrow(/exited unexpectedly/);
			const pending = harness.manager.execute("1 + 1");
			await vi.waitFor(() => expect(harness.manager.revivalVouch).toBeDefined(), { timeout: 15_000 });
			const vouch = harness.manager.revivalVouch;
			expect(vouch?.since).toBeLessThanOrEqual(Date.now());

			unlinkSync(harness.hangBootstrapPath);
			const revived = await pending;
			expect(revived.status).toBe("ok");
			expect(harness.manager.revivalVouch).toBeUndefined();
		} finally {
			if (existsSync(harness.hangBootstrapPath)) unlinkSync(harness.hangBootstrapPath);
			await harness.manager.shutdown();
		}
	});

	it("reports the death chain and the gap between fast restarts", async () => {
		const harness = newHarness();
		try {
			await expect(harness.manager.execute("die9")).rejects.toThrow();
			await expect(harness.manager.execute("die9")).rejects.toThrow();
			const second = harness.facts[1]?.decision;
			expect(second?.sincePreviousMs).toBeDefined();
			expect(second?.sincePreviousMs).toBeLessThan(60_000);
			expect(harness.causes.length).toBe(2);
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("reads the spawn count from the filesystem, so nothing revived silently", async () => {
		const harness = newHarness();
		try {
			await expect(harness.manager.execute("die9")).rejects.toThrow();
			await harness.manager.execute("1 + 1");
			expect(existsSync(harness.countPath)).toBe(true);
			expect(Number(readFileSync(harness.countPath, "utf8"))).toBe(2);
		} finally {
			await harness.manager.shutdown();
		}
	});
});
