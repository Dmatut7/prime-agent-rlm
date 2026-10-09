import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HostRequestHandlers, ReplKernelManager } from "../src/core/kernel/index.js";

// The kernel caps its own host_request/traceback payloads (repl.py `_check_payload` /
// `_cap_traceback_lines`), but the host must not trust that: a runtime that predates those caps
// - or a corrupt frame - can otherwise hand it an unbounded error chain or an oversized request.
// These cases drive a fake runtime that emits exactly those oversized frames.

let tempDir = "";

function writeFakeRuntime(filePath: string): void {
	writeFileSync(
		filePath,
		`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const requestLog = process.env.FAKE_REPL_REQUEST_LOG;
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ event: "ready", protocol: 5, python: process.version });
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (requestLog) fs.appendFileSync(requestLog, line + "\\n");
  const request = JSON.parse(line);
  if (request.type === "execute") {
    if (request.code === "big-traceback") {
      const lines = [];
      for (let i = 0; i < 4000; i++) lines.push("frame " + i + " " + "y".repeat(400) + "\\n");
      emit({ event: "error", id: request.id, ename: "ValueError", evalue: "boom", traceback: lines });
      emit({ event: "done", id: request.id, status: "error" });
      return;
    }
    if (request.code === "big-host-request") {
      emit({ event: "host_request", id: "hr-big", data: { type: "test.big", d: "x".repeat(17_000_000) } });
      emit({ event: "done", id: request.id, status: "ok" });
      return;
    }
    if (request.code === "say-hi") emit({ event: "stdout", id: request.id, text: "hi" });
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
	chmodSync(filePath, 0o755);
}

function requestLines(requestLogPath: string): string[] {
	return existsSync(requestLogPath)
		? readFileSync(requestLogPath, "utf8")
				.split("\n")
				.filter((line) => line.length > 0)
		: [];
}

describe("kernel payload caps", () => {
	let manager: ReplKernelManager | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-payload-"));
	});

	afterEach(async () => {
		await manager?.shutdown({ snapshot: true, drainHostRequests: true });
		manager = undefined;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	function newManager(hostHandlers?: HostRequestHandlers): { manager: ReplKernelManager; requestLogPath: string } {
		const python = join(tempDir, "python");
		const requestLogPath = join(tempDir, "requests.log");
		writeFakeRuntime(python);
		manager = new ReplKernelManager({
			python,
			cwd: tempDir,
			env: { FAKE_REPL_REQUEST_LOG: requestLogPath },
			...(hostHandlers === undefined ? {} : { hostHandlers }),
		});
		return { manager, requestLogPath };
	}

	it("bounds an inbound error traceback's aggregate, keeping the newest entries", async () => {
		const { manager } = newManager();
		await manager.start();

		const result = await manager.execute("big-traceback");
		expect(result.status).toBe("error");
		const traceback = result.error?.traceback ?? [];
		expect(traceback.length).toBeGreaterThan(1);
		expect(traceback[0]).toContain("traceback truncated: kept the newest");
		// The aggregate of the retained entries stays within the cap, and the newest entry survives.
		expect(traceback.slice(1).join("").length).toBeLessThanOrEqual(1_048_576);
		expect(traceback[traceback.length - 1]).toMatch(/^frame 3999 /);
	});

	it("refuses an oversized host_request payload instead of invoking the handler", async () => {
		const handled: unknown[] = [];
		const { manager, requestLogPath } = newManager({
			"test.big": async (payload) => {
				handled.push(payload);
				return {};
			},
		});
		await manager.start();

		const result = await manager.execute("big-host-request");
		expect(result.status).toBe("ok");

		await vi.waitFor(() => {
			const replies = requestLines(requestLogPath).filter((line) => JSON.parse(line).type === "host_reply");
			expect(replies.length).toBe(1);
		});
		const reply = JSON.parse(
			requestLines(requestLogPath).find((line) => JSON.parse(line).type === "host_reply") as string,
		);
		expect(reply.id).toBe("hr-big");
		expect(reply.data.status).toBe("error");
		expect(String(reply.data.error)).toContain("frame cap");
		// The oversized payload never reached the handler.
		expect(handled).toEqual([]);
	});
});
