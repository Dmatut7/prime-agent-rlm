import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelDeathCause } from "../src/core/kernel/index.js";
import { ReplKernelManager } from "../src/core/kernel/index.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

/**
 * A fake kernel runtime that dies on demand and can hang a restore, so the revival path can be
 * driven through the public API: no private member is reached for, and every fact asserted here
 * (spawn count, restore attempts, snapshot file identity) is read back from the filesystem.
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
const flag = (name) => Boolean(process.env[name]) && fs.existsSync(process.env[name]);
const bump = (name) => {
  const path = process.env[name];
  if (!path) return 0;
  const n = (fs.existsSync(path) ? Number(fs.readFileSync(path, "utf8")) : 0) + 1;
  fs.writeFileSync(path, String(n));
  return n;
};
emit({ event: "ready", protocol: 3, python: process.version });
// Only the first incarnation emits it: the assertion has to fail if the revival drops the
// dying cell's buffer instead of handing it to the next cell.
if (count === 1 && flag("FAKE_REPL_BACKGROUND_LINE")) {
  emit({ event: "stdout", id: null, text: "orphan-thread-output" });
}
const requestLog = process.env.FAKE_REPL_REQUEST_LOG;
// The cell a host_request was emitted for, so a reply can finish it (positive control).
let pendingExecuteId = null;
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (requestLog) fs.appendFileSync(requestLog, line + "\\n");
  const request = JSON.parse(line);
  if (request.type === "host_reply") {
    if (pendingExecuteId === null) return;
    const id = pendingExecuteId;
    pendingExecuteId = null;
    emit({ event: "stdout", id, text: "reply-" + request.data.status });
    emit({ event: "done", id, status: "ok" });
    return;
  }
  if (request.type === "execute") {
    if (request.code === "die9" || request.code.endsWith("die9")) {
      process.exit(9);
    }
    if (request.code === "request-then-die") {
      emit({ event: "host_request", id: "hr-" + count, data: { type: "slow", target: "worker-" + count } });
      setTimeout(() => process.exit(9), 60);
      return;
    }
    if (request.code === "request-and-hang") {
      emit({ event: "host_request", id: "hr-hang-" + count, data: { type: "slow", target: "worker" } });
      return;
    }
    if (request.code === "request-then-reply") {
      pendingExecuteId = request.id;
      emit({ event: "host_request", id: "hr-live-" + count, data: { type: "fast", target: "worker" } });
      return;
    }
    if (request.code === "boom") {
      emit({ event: "error", id: request.id, ename: "RuntimeError", evalue: "boom", traceback: [] });
      emit({ event: "done", id: request.id, status: "error" });
      return;
    }
    emit({ event: "stdout", id: request.id, text: "alive:" + count });
    emit({ event: "done", id: request.id, status: "ok" });
    return;
  }
  if (request.type === "interrupt") {
    emit({ event: "done", id: request.id, status: "aborted", reason: "interrupted" });
    return;
  }
  if (request.type === "restore") {
    fs.appendFileSync(process.env.FAKE_REPL_RESTORE_LOG, "r");
    const hung = bump("FAKE_REPL_RESTORE_HANG_COUNT");
    const hangFirst = Number(process.env.FAKE_REPL_HANG_FIRST_RESTORES || "0");
    if (hung <= hangFirst) return;
    const restored = fs.existsSync(request.path) ? ["saved_name"] : [];
    emit({ event: "done", id: request.id, status: "ok", restored, failed: [] });
    return;
  }
  if (request.type === "snapshot") {
    // A faithful manifest (the payload's own record of what it holds), so the host-side reader
    // sees the same facts the runtime reports in the done frame.
    const skipped = process.env.FAKE_REPL_SNAPSHOT_SKIPPED
      ? JSON.parse(process.env.FAKE_REPL_SNAPSHOT_SKIPPED)
      : [];
    fs.writeFileSync(request.path, "payload");
    fs.writeFileSync(request.manifest_path, JSON.stringify({ savedNames: ["saved_name"], skipped }));
    emit({ event: "done", id: request.id, status: "ok", saved: ["saved_name"], skipped, bytes: 7 });
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

interface Harness {
	manager: ReplKernelManager;
	countPath: string;
	restoreLogPath: string;
	snapshotPath: string;
	manifestPath: string;
	backgroundFlagPath: string;
	causes: KernelDeathCause[];
	handlerSignals: AbortSignal[];
	lateReplies: { requestId: string; type: string; ok: boolean }[];
	requestLogPath: string;
	releaseHandlers: () => void;
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "prime-agent-revival-"));
});

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

function newHarness(
	options: {
		snapshot?: boolean;
		hangFirstRestores?: number;
		backgroundLine?: boolean;
		hostHandlers?: boolean;
		restartPolicy?: () => { maxRestarts: number; windowMs: number };
		/** Names the fake snapshot reports it could not save, as the real runtime would. */
		snapshotSkipped?: { name: string; reason: string }[];
	} = {},
): Harness {
	const python = join(tempDir, "python");
	writeFakeRuntime(python);
	const countPath = join(tempDir, "spawn-count");
	const restoreLogPath = join(tempDir, "restore-log");
	const restoreHangCountPath = join(tempDir, "restore-hang-count");
	const snapshotPath = join(tempDir, "kernel-state.dill");
	const manifestPath = join(tempDir, "kernel-state.json");
	const backgroundFlagPath = join(tempDir, "background-line");
	const requestLogPath = join(tempDir, "kernel-requests.jsonl");
	if (options.backgroundLine) writeFileSync(backgroundFlagPath, "1");
	const causes: KernelDeathCause[] = [];
	const handlerSignals: AbortSignal[] = [];
	const lateReplies: { requestId: string; type: string; ok: boolean }[] = [];
	let release: Array<() => void> = [];
	const manager = new ReplKernelManager({
		python,
		cwd: tempDir,
		env: {
			FAKE_REPL_SPAWN_COUNT: countPath,
			FAKE_REPL_RESTORE_LOG: restoreLogPath,
			FAKE_REPL_RESTORE_HANG_COUNT: restoreHangCountPath,
			FAKE_REPL_BACKGROUND_LINE: backgroundFlagPath,
			FAKE_REPL_REQUEST_LOG: requestLogPath,
			FAKE_REPL_HANG_FIRST_RESTORES: String(options.hangFirstRestores ?? 0),
			...(options.snapshotSkipped ? { FAKE_REPL_SNAPSHOT_SKIPPED: JSON.stringify(options.snapshotSkipped) } : {}),
		},
		onLateHostReply: (reply) => lateReplies.push(reply),
		bootstrapCode: "bootstrap",
		onUnexpectedExit: (cause) => causes.push(cause),
		...(options.restartPolicy ? { restartPolicy: options.restartPolicy } : {}),
		snapshot: options.snapshot
			? {
					path: snapshotPath,
					manifestPath,
					debounceMs: 1,
					restoreTimeoutMs: 150,
					restoreRetryTimeoutMs: 250,
				}
			: undefined,
		hostHandlers: options.hostHandlers
			? {
					slow: (_payload, signal) =>
						new Promise<Record<string, unknown>>((resolve) => {
							if (signal) handlerSignals.push(signal);
							release.push(() => resolve({ ok: true }));
						}),
					fast: async () => ({ fast: true }),
				}
			: undefined,
	});
	return {
		manager,
		countPath,
		restoreLogPath,
		snapshotPath,
		manifestPath,
		backgroundFlagPath,
		causes,
		handlerSignals,
		lateReplies,
		requestLogPath,
		releaseHandlers: () => {
			const pending = release;
			release = [];
			for (const resolve of pending) resolve();
		},
	};
}

function spawnCount(harness: Harness): number {
	return existsSync(harness.countPath) ? Number(readFileSync(harness.countPath, "utf8")) : 0;
}

/** Every request frame the kernel actually received, in order. */
function requestsSeenByKernel(harness: Harness): Record<string, unknown>[] {
	if (!existsSync(harness.requestLogPath)) return [];
	return readFileSync(harness.requestLogPath, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function restoreAttempts(harness: Harness): number {
	return existsSync(harness.restoreLogPath) ? readFileSync(harness.restoreLogPath, "utf8").length : 0;
}

function snapshotSiblings(): string[] {
	return readdirSync(tempDir).filter((name) => name.startsWith("kernel-state.dill"));
}

describe("kernel revival after an unexpected exit", () => {
	it("serves the next cell on a replacement kernel and reports the reset", async () => {
		const harness = newHarness({ snapshot: true });
		try {
			await expect(harness.manager.execute("die9")).rejects.toThrow(/exited unexpectedly/);
			expect(harness.causes.length).toBe(1);
			expect(harness.causes[0]!.code).toBe(9);

			const revived = await harness.manager.execute("1 + 1");
			expect(revived.status).toBe("ok");
			expect(revived.stdout).toContain("alive:2");
			expect(harness.manager.isRunning).toBe(true);
			expect(spawnCount(harness)).toBe(2);

			const notice = harness.manager.consumeRestartNotice();
			expect(notice).toBeDefined();
			expect(notice).toContain("code=9");
			// The three facts the model needs before it re-runs anything (M10 a/b/c).
			expect(notice).toContain("snapshot");
			expect(notice).toContain("Side effects were not rolled back");
			expect(notice).toContain("rlm.list_subagents()");
			// One-shot: a second read must not repeat it.
			expect(harness.manager.consumeRestartNotice()).toBeUndefined();
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("restores the saved namespace on the replacement kernel", async () => {
		const harness = newHarness({ snapshot: true });
		try {
			await harness.manager.execute("seed");
			await vi.waitFor(() => expect(existsSync(harness.snapshotPath)).toBe(true), { timeout: 15_000 });
			await expect(harness.manager.execute("die9")).rejects.toThrow();
			const revived = await harness.manager.execute("1 + 1");
			expect(revived.status).toBe("ok");
			expect(restoreAttempts(harness)).toBe(1);
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("names the names the snapshot could not save, and measures the age it reports", async () => {
		const harness = newHarness({
			snapshot: true,
			snapshotSkipped: [{ name: "gen", reason: "TypeError: cannot pickle 'generator' object" }],
		});
		try {
			await harness.manager.execute("seed");
			await vi.waitFor(() => expect(existsSync(harness.snapshotPath)).toBe(true), { timeout: 15_000 });
			await expect(harness.manager.execute("die9")).rejects.toThrow();
			await harness.manager.execute("1 + 1");
			const notice = harness.manager.consumeRestartNotice();
			expect(notice).toBeDefined();
			// The payload never held `gen`, so no restore failure can report it: the only channel is
			// the manifest the write left next to the payload.
			expect(notice).toContain("gen (TypeError: cannot pickle 'generator' object)");
			// And the rollback point is the measured write age, not a fixed debounce claim.
			expect(notice).not.toContain("1.5s");
			expect(notice).toMatch(/written about \d+(\.\d+)?s before the death/);
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("keeps an in-flight host request alive instead of cancelling it with the kernel", async () => {
		const harness = newHarness({ hostHandlers: true });
		try {
			await expect(harness.manager.execute("request-then-die")).rejects.toThrow();
			await vi.waitFor(() => expect(harness.handlerSignals.length).toBe(1), { timeout: 15_000 });
			// I-11: an unexpected death is not a teardown, so admitted host work survives it.
			expect(harness.handlerSignals[0]!.aborted).toBe(false);
			harness.releaseHandlers();
			const revived = await harness.manager.execute("1 + 1");
			expect(revived.status).toBe("ok");
			const notice = harness.manager.consumeRestartNotice();
			expect(notice).toContain("1 host request");
			expect(notice).toContain("slow");
			expect(notice).toContain("may already have");
			await vi.waitFor(() => expect(harness.manager.hostRequestCount).toBe(0), { timeout: 15_000 });
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("never writes a stale host reply into the replacement kernel (P2-3)", async () => {
		const harness = newHarness({ hostHandlers: true });
		try {
			await expect(harness.manager.execute("request-then-die")).rejects.toThrow();
			await vi.waitFor(() => expect(harness.handlerSignals.length).toBe(1), { timeout: 15_000 });
			// The admitted work outlives the death (I-11), and it also outlives the revival: the
			// replacement kernel is up and serving cells before this handler settles.
			const revived = await harness.manager.execute("1 + 1");
			expect(revived.status).toBe("ok");
			expect(spawnCount(harness)).toBe(2);

			harness.releaseHandlers();

			// The reply is reported as undeliverable instead of being handed to a kernel that
			// never minted its id.
			await vi.waitFor(() => expect(harness.lateReplies.length).toBe(1), { timeout: 15_000 });
			expect(harness.lateReplies[0]).toMatchObject({ requestId: "hr-1", type: "slow", ok: true });
			await vi.waitFor(() => expect(harness.manager.hostRequestCount).toBe(0), { timeout: 15_000 });
			const replies = requestsSeenByKernel(harness).filter((request) => request.type === "host_reply");
			expect(replies).toEqual([]);
			// The replacement kernel is still usable after the dropped reply.
			expect((await harness.manager.execute("1 + 1")).stdout).toContain("alive:2");
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("still delivers a host reply to the kernel that asked for it (positive control)", async () => {
		const harness = newHarness({ hostHandlers: true });
		try {
			const result = await harness.manager.execute("request-then-reply");
			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("reply-ok");
			const replies = requestsSeenByKernel(harness).filter((request) => request.type === "host_reply");
			expect(replies).toHaveLength(1);
			expect(replies[0]?.id).toBe("hr-live-1");
			expect(replies[0]?.data).toMatchObject({ status: "ok", result: { fast: true } });
			expect(harness.lateReplies).toEqual([]);
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("still cancels in-flight host requests on a real teardown", async () => {
		const harness = newHarness({ hostHandlers: true });
		try {
			const pending = harness.manager.execute("request-and-hang").catch(() => undefined);
			await vi.waitFor(() => expect(harness.handlerSignals.length).toBe(1), { timeout: 15_000 });
			expect(harness.handlerSignals[0]!.aborted).toBe(false);
			const shutdown = harness.manager.shutdown();
			await vi.waitFor(() => expect(harness.handlerSignals[0]!.aborted).toBe(true), { timeout: 15_000 });
			await shutdown;
			await pending;
			expect(harness.causes).toEqual([]);
		} finally {
			harness.releaseHandlers();
		}
	});

	it("keeps unattributed background output across the revival", async () => {
		const harness = newHarness({ backgroundLine: true });
		try {
			await expect(harness.manager.execute("die9")).rejects.toThrow();
			const revived = await harness.manager.execute("1 + 1");
			expect(revived.backgroundOutput).toContain("orphan-thread-output");
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("flags a repeated cell so a doubled side effect is visible", async () => {
		const harness = newHarness();
		try {
			await expect(harness.manager.execute("write_and_commit(); die9")).rejects.toThrow();
			const same = harness.manager.consumeRestartNotice("write_and_commit(); die9");
			expect(same).toContain("identical to the cell that was running");
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("does not flag a different cell", async () => {
		const harness = newHarness();
		try {
			await expect(harness.manager.execute("write_and_commit(); die9")).rejects.toThrow();
			const other = harness.manager.consumeRestartNotice("something_else");
			expect(other).toBeDefined();
			expect(other).not.toContain("identical to the cell that was running");
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("keeps an intentional shutdown and kill terminal", async () => {
		const shutdownHarness = newHarness();
		await shutdownHarness.manager.start();
		await shutdownHarness.manager.shutdown();
		await expect(shutdownHarness.manager.execute("1 + 1")).rejects.toThrow(/Kernel has been shut down/);
		expect(shutdownHarness.causes).toEqual([]);

		const killHarness = newHarness();
		await killHarness.manager.start();
		await killHarness.manager.kill();
		await expect(killHarness.manager.execute("1 + 1")).rejects.toThrow(/Kernel has been shut down/);
		expect(killHarness.causes).toEqual([]);
	});
});

describe("restore timeout during revival (B5)", () => {
	it("retries a timed-out restore and never renames the snapshot aside", async () => {
		const harness = newHarness({ snapshot: true, hangFirstRestores: 1 });
		try {
			writeFileSync(harness.snapshotPath, "payload");
			writeFileSync(harness.manifestPath, "{}");
			await expect(harness.manager.execute("die9")).rejects.toThrow();
			const revived = await harness.manager.execute("1 + 1");
			expect(revived.status).toBe("ok");
			// One retry with the longer window, and the payload is still where it was:
			// isolation is reserved for a payload that failed to load, not for a slow read.
			expect(restoreAttempts(harness)).toBe(2);
			expect(snapshotSiblings()).toEqual(["kernel-state.dill"]);
			const notice = harness.manager.consumeRestartNotice();
			expect(notice).toContain("timed out");
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("gives up on a restore that times out twice and says the state is still owed", async () => {
		const harness = newHarness({ snapshot: true, hangFirstRestores: 99 });
		try {
			writeFileSync(harness.snapshotPath, "payload");
			writeFileSync(harness.manifestPath, "{}");
			await expect(harness.manager.execute("die9")).rejects.toThrow();
			const revived = await harness.manager.execute("1 + 1");
			expect(revived.status).toBe("ok");
			expect(restoreAttempts(harness)).toBe(2);
			expect(snapshotSiblings()).toEqual(["kernel-state.dill"]);
			const notice = harness.manager.consumeRestartNotice();
			expect(notice).toContain("timed out");
			expect(notice).toContain("older than");
		} finally {
			await harness.manager.shutdown();
		}
	});
});

describe("provisioner-level revival", () => {
	function newProvisioner(): { provisioner: IpythonKernelProvisioner; countPath: string } {
		const python = join(tempDir, "python");
		writeFakeRuntime(python);
		const countPath = join(tempDir, "spawn-count");
		const provisioner = new IpythonKernelProvisioner(tempDir, {
			python,
			env: {
				FAKE_REPL_SPAWN_COUNT: countPath,
				FAKE_REPL_RESTORE_LOG: join(tempDir, "restore-log"),
				FAKE_REPL_RESTORE_HANG_COUNT: join(tempDir, "restore-hang-count"),
				FAKE_REPL_HANG_FIRST_RESTORES: "0",
			},
		});
		return { provisioner, countPath };
	}

	it("hands out a manager that can execute after the kernel died", async () => {
		const { provisioner } = newProvisioner();
		try {
			const manager = await provisioner.ensure();
			await expect(manager.execute("die9")).rejects.toThrow();
			expect(provisioner.hasRunningKernel).toBe(false);
			const revived = await provisioner.ensure();
			const result = await revived.execute("1 + 1");
			expect(result.status).toBe("ok");
			expect(provisioner.hasRunningKernel).toBe(true);
		} finally {
			await provisioner.dispose({ snapshot: false });
		}
	});

	it("does not revive a kernel the host disposed", async () => {
		const { provisioner } = newProvisioner();
		const manager = await provisioner.ensure();
		expect(manager.isRunning).toBe(true);
		await provisioner.dispose({ snapshot: false });
		await expect(provisioner.ensure()).rejects.toThrow();
	});
});
