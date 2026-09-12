import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

/**
 * P2-1: every host-supplied callback the kernel event loop reaches is contained.
 *
 * These callbacks run inside a `child.stdout` "data" handler or a `child` "exit" handler, so an
 * exception that escapes them is an uncaught exception - and the daemon worker's handler for that
 * is `process.exit(1)`, which takes every other session the worker hosts down with it. Nothing
 * here may depend on a callback behaving: a UI renderer that throws mid-frame must cost one log
 * line, never the kernel, never the cell's own output, and never the worker.
 */

const AGENT_MESSAGE_MIME = "application/vnd.prime-agent.agent-message+json";
/** Must match KERNEL_CALLBACK_FAILURE_LOG_EVERY in repl-manager.ts. */
const LOG_EVERY = 25;

function writeFakeRuntime(path: string): void {
	writeFileSync(
		path,
		`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const countPath = process.env.FAKE_REPL_SPAWN_COUNT;
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) + 1 : 1;
fs.writeFileSync(countPath, String(count));
const chunks = Number(process.env.FAKE_REPL_STDOUT_CHUNKS || "2");
// The cell a host_request was emitted for, so its reply can finish the cell.
let pendingExecuteId = null;
emit({ event: "ready", protocol: 4, python: process.version });
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
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
    if (request.code === "die9") process.exit(9);
    if (request.code === "request-fast") {
      pendingExecuteId = request.id;
      emit({ event: "host_request", id: "hr-fast-" + count, data: { type: "fast", target: "worker" } });
      return;
    }
    if (request.code === "late-message") {
      emit({ event: "done", id: request.id, status: "ok" });
      // After the cell settled, so the frame reaches the registered late handler.
      setTimeout(() => {
        emit({
          event: "display",
          id: request.id,
          data: {
            "${AGENT_MESSAGE_MIME}": {
              id: "msg-1",
              message: "late",
              deliveryStatus: "delivered",
              receiverRole: "parent",
              target: { activeSessionId: "active-1", sessionId: "session-1" },
            },
          },
        });
        // Unattributed, so it lands in the next cell's background output: proof the frame
        // loop kept running after the handler above it threw.
        emit({ event: "stdout", id: null, text: "frame-after-late-handler" });
      }, 40);
      return;
    }
    for (let i = 0; i < chunks; i++) emit({ event: "stdout", id: request.id, text: "chunk-" + i + ";" });
    emit({ event: "stderr", id: request.id, text: "err-text" });
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
let entries: LogEntry[] = [];

function kernelWarnings(message: string): LogEntry[] {
	return entries.filter((entry) => entry.level === "warn" && entry.msg === message);
}

interface Harness {
	manager: ReplKernelManager;
	countPath: string;
}

function newHarness(
	options: { stdoutChunks?: number; restartPolicyThrows?: boolean; hostRequest?: boolean } = {},
): Harness {
	const python = join(tempDir, "python");
	writeFakeRuntime(python);
	const countPath = join(tempDir, "spawn-count");
	const manager = new ReplKernelManager({
		python,
		cwd: tempDir,
		sessionId: "session-callback",
		env: {
			FAKE_REPL_SPAWN_COUNT: countPath,
			FAKE_REPL_STDOUT_CHUNKS: String(options.stdoutChunks ?? 2),
		},
		...(options.restartPolicyThrows
			? {
					restartPolicy: () => {
						throw new Error("settings reader exploded");
					},
				}
			: {}),
		...(options.hostRequest
			? {
					hostHandlers: { fast: async () => ({ fast: true }) },
					cancellableHostRequestTypes: ["fast"],
					readOnlyHostRequestTimeoutMs: () => {
						throw new Error("timeout setting exploded");
					},
				}
			: {}),
	});
	return { manager, countPath };
}

function spawnCount(harness: Harness): number {
	return existsSync(harness.countPath) ? Number(readFileSync(harness.countPath, "utf8")) : 0;
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "prime-agent-callback-isolation-"));
	entries = [];
	setLogSink((entry) => {
		entries.push(entry);
	});
});

afterEach(() => {
	setLogSink(undefined);
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
	entries = [];
});

describe("kernel host callback failures are contained (P2-1)", () => {
	it("keeps the cell, the kernel and the worker alive when onStream throws", async () => {
		const harness = newHarness();
		try {
			const streamed: string[] = [];
			const result = await harness.manager.execute("print(1)", {
				onStream: (chunk, name) => {
					streamed.push(`${name}:${chunk}`);
					throw new Error("ui renderer exploded");
				},
			});

			// The cell still completes, and the frame's text is still captured for the model:
			// containing the callback must not cost the output it was streaming.
			expect(result.status).toBe("ok");
			expect(result.stdout).toBe("chunk-0;chunk-1;");
			expect(result.stderr).toBe("err-text");
			expect(streamed).toEqual(["stdout:chunk-0;", "stdout:chunk-1;", "stderr:err-text"]);
			// One kernel, still running: the throw never reached the exit path.
			expect(spawnCount(harness)).toBe(1);
			expect(harness.manager.isRunning).toBe(true);

			const warnings = kernelWarnings("kernel host callback failed");
			expect(warnings.length).toBeGreaterThan(0);
			expect(warnings[0]).toMatchObject({ component: "coding-agent.kernel", callback: "onStream" });
			expect(String(warnings[0]?.error)).toContain("ui renderer exploded");
			expect(warnings[0]?.sessionId).toBe("session-callback");

			// The next cell is served by the same kernel.
			const next = await harness.manager.execute("print(2)", {
				onStream: () => {
					throw new Error("still broken");
				},
			});
			expect(next.status).toBe("ok");
			expect(spawnCount(harness)).toBe(1);
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("reports a throwing callback once and then once per interval, with the running total", async () => {
		// LOG_EVERY stdout frames plus the one stderr frame: the first failure and the LOG_EVERYth
		// are logged, everything between is counted instead of flooding the log.
		const harness = newHarness({ stdoutChunks: LOG_EVERY });
		try {
			const result = await harness.manager.execute("print(1)", {
				onStream: () => {
					throw new Error("flood");
				},
			});
			expect(result.status).toBe("ok");
			const warnings = kernelWarnings("kernel host callback failed");
			expect(warnings).toHaveLength(2);
			expect(warnings[0]?.failures).toBe(1);
			expect(warnings[1]?.failures).toBe(LOG_EVERY);
			// Nothing was swallowed: the throttled line carries the accumulated count.
			expect(result.stdout.split(";").filter(Boolean)).toHaveLength(LOG_EVERY);
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("keeps the frame loop running when a late agent_message handler throws", async () => {
		const harness = newHarness();
		try {
			let lateCalls = 0;
			const first = await harness.manager.execute("late-message", {
				onLateSentAgentMessage: () => {
					lateCalls++;
					throw new Error("late handler exploded");
				},
			});
			expect(first.status).toBe("ok");
			await vi.waitFor(() => expect(lateCalls).toBe(1), { timeout: 15_000 });

			const next = await harness.manager.execute("print(3)");
			// The frame emitted right after the throwing handler was still processed, which is
			// only true if the stdout loop survived the throw.
			expect(next.backgroundOutput).toContain("frame-after-late-handler");
			expect(spawnCount(harness)).toBe(1);

			const warnings = kernelWarnings("kernel host callback failed");
			expect(warnings.length).toBeGreaterThan(0);
			expect(warnings[0]?.callback).toBe("late agent_message");
			expect(String(warnings[0]?.error)).toContain("late handler exploded");
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("still serves a read-only host request when its timeout setting throws", async () => {
		const harness = newHarness({ hostRequest: true });
		try {
			const result = await harness.manager.execute("request-fast");
			// Dropping the frame instead of containing the read would leave the kernel waiting for
			// a reply that never comes, so the cell has to finish.
			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("reply-ok");
			const warnings = kernelWarnings("kernel read-only host request timeout callback failed");
			expect(warnings).toHaveLength(1);
			expect(String(warnings[0]?.error)).toContain("timeout setting exploded");
		} finally {
			await harness.manager.shutdown();
		}
	});

	it("survives a restartPolicy callback that throws inside the kernel exit handler", async () => {
		const harness = newHarness({ restartPolicyThrows: true });
		try {
			await expect(harness.manager.execute("die9")).rejects.toThrow(/exited unexpectedly/);

			// The budget fell back to its defaults instead of taking the worker down, so the
			// session is still revivable and still reports the death.
			const warnings = kernelWarnings("kernel restart policy callback failed");
			expect(warnings.length).toBeGreaterThan(0);
			expect(String(warnings[0]?.error)).toContain("settings reader exploded");

			const revived = await harness.manager.execute("print(4)");
			expect(revived.status).toBe("ok");
			expect(revived.stdout).toContain("chunk-0;");
			expect(spawnCount(harness)).toBe(2);
		} finally {
			await harness.manager.shutdown();
		}
	});
});
