import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelDeathCause, KernelUnexpectedExitFacts } from "../src/core/kernel/index.js";
import { KernelRestartLedger, KernelUnavailableError, ReplKernelManager } from "../src/core/kernel/index.js";
import { KERNEL_RESET_NOTICE_TAG } from "../src/core/kernel/reset-notice.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

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

/**
 * A kernel that dies before it is ready: the broken-environment shape (a broken venv, a
 * `Killed:9` signature kill, a misconfigured `PRIME_AGENT_KERNEL_PYTHON`, an import-time OOM).
 * Nothing about it is specific to one manager instance, which is the point of K-P1-1.
 */
function writeDyingFakeRuntime(path: string): void {
	writeFileSync(
		path,
		`#!/usr/bin/env node
const fs = require("node:fs");
const countPath = process.env.FAKE_REPL_SPAWN_COUNT;
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) + 1 : 1;
fs.writeFileSync(countPath, String(count));
process.stderr.write("fake kernel: simulated startup crash\\n");
process.exit(3);
`,
	);
	chmodSync(path, 0o755);
}

function spawnCount(path: string): number {
	return existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
}

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

describe("kernel restart budget across replacement managers (K-P1-1)", () => {
	it("fails closed once a kernel that dies before ready has spent the shared budget", async () => {
		const python = join(tempDir, "python");
		writeDyingFakeRuntime(python);
		const countPath = join(tempDir, "spawn-count");
		const provisioner = new IpythonKernelProvisioner(tempDir, {
			python,
			sessionId: "budget-provisioner",
			env: { FAKE_REPL_SPAWN_COUNT: countPath },
		});
		const seen: unknown[] = [];
		try {
			for (let cell = 1; cell <= 6; cell++) {
				seen.push(
					await provisioner
						.ensure()
						.then((manager) => manager.execute("print(1)"))
						.then(
							() => undefined,
							(error: unknown) => error,
						),
				);
			}
			expect(seen).toHaveLength(6);
			// Three revivals per window, so the first three cells report the startup death itself...
			for (const [index, error] of seen.slice(0, 3).entries()) {
				expect(messageOf(error), `cell ${index + 1}`).toContain("exited before ready");
			}
			// ...the fourth death spends the budget, and that cell is the one told so...
			expect(seen[3]).toBeInstanceOf(KernelUnavailableError);
			const exhausted = seen[3];
			expect(messageOf(exhausted)).toContain("3 restarts per 60 minutes");
			expect(messageOf(exhausted)).toContain("code=3");
			expect(messageOf(exhausted)).toContain("/reload");
			if (exhausted instanceof KernelUnavailableError) {
				expect(exhausted.restartCount).toBe(4);
				expect(exhausted.causes).toHaveLength(4);
			}
			// ...and every later cell fails closed instead of spawning one more doomed kernel.
			expect(seen[4]).toBeInstanceOf(KernelUnavailableError);
			expect(seen[5]).toBeInstanceOf(KernelUnavailableError);
			expect(spawnCount(countPath)).toBe(4);
		} finally {
			await provisioner.dispose({ snapshot: false }).catch(() => undefined);
		}
	});

	it("counts a death recorded by a replaced manager against its replacement", async () => {
		const python = join(tempDir, "python");
		writeFakeRuntime(python);
		const countPath = join(tempDir, "spawn-count");
		const env = { FAKE_REPL_SPAWN_COUNT: countPath };
		const options = {
			python,
			cwd: tempDir,
			env,
			bootstrapCode: "bootstrap",
			restartPolicy: () => ({ maxRestarts: 0, windowMs: 60_000 }),
		};
		const ledger = new KernelRestartLedger();
		const first = new ReplKernelManager({ ...options, restartLedger: ledger });
		try {
			// Zero allowed revivals: the first death spends the budget on the spot.
			await expect(first.execute("die9")).rejects.toThrow(KernelUnavailableError);
			// The host verdict that makes the provisioner replace the instance.
			await first.shutdown({ snapshot: false });
			expect(first.isDefunct).toBe(true);
			expect(spawnCount(countPath)).toBe(1);

			const second = new ReplKernelManager({ ...options, restartLedger: ledger });
			try {
				await expect(second.execute("1 + 1")).rejects.toThrow(KernelUnavailableError);
				// The whole point: the replacement refuses to spawn at all.
				expect(spawnCount(countPath)).toBe(1);
			} finally {
				await second.shutdown({ snapshot: false }).catch(() => undefined);
			}

			// Positive control: an unshared ledger starts from zero, which is exactly the shape
			// that let a doomed kernel be respawned once per cell.
			const independent = new ReplKernelManager(options);
			try {
				await expect(independent.execute("1 + 1")).resolves.toMatchObject({ status: "ok" });
				expect(spawnCount(countPath)).toBe(2);
			} finally {
				await independent.shutdown({ snapshot: false }).catch(() => undefined);
			}
		} finally {
			await first.shutdown({ snapshot: false }).catch(() => undefined);
		}
	});

	it("delivers the reset notice of a death its own manager never served", async () => {
		const python = join(tempDir, "python");
		writeFakeRuntime(python);
		const countPath = join(tempDir, "spawn-count");
		const env = { FAKE_REPL_SPAWN_COUNT: countPath };
		const options = {
			python,
			cwd: tempDir,
			env,
			sessionId: "notice-across-managers",
			bootstrapCode: "bootstrap",
		};
		const ledger = new KernelRestartLedger();
		const first = new ReplKernelManager({ ...options, restartLedger: ledger });
		try {
			await expect(first.execute("die9")).rejects.toThrow(/exited unexpectedly/);
			// The notice is armed on the ledger, and this instance is about to be discarded by its
			// owner without ever serving a cell that could carry it.
		} finally {
			await first.shutdown({ snapshot: false }).catch(() => undefined);
		}

		const second = new ReplKernelManager({ ...options, restartLedger: ledger });
		try {
			await expect(second.execute("1 + 1")).resolves.toMatchObject({ status: "ok" });
			const notice = second.consumeRestartNotice("1 + 1");
			expect(notice).toBeDefined();
			expect(notice).toContain(KERNEL_RESET_NOTICE_TAG);
			expect(notice).toContain("code=9");
			// Consumed once: the second read is empty.
			expect(second.consumeRestartNotice("1 + 1")).toBeUndefined();
		} finally {
			await second.shutdown({ snapshot: false }).catch(() => undefined);
		}
	});
});
