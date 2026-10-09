import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

// A background bash handle must be inspectable and killable without waiting behind the cell
// execution queue: `queryBashActivity` writes its frame straight to the kernel's stdin, so a
// long or stuck cell cannot hide what it spawned. The fake runtime here blocks one execute
// forever to prove the query still answers.

let tempDir = "";

function writeFakeRuntime(filePath: string, announce: string[]): void {
	writeFileSync(
		filePath,
		`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const requestLog = process.env.FAKE_REPL_REQUEST_LOG;
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const announced = ${JSON.stringify(announce)};
emit({ event: "ready", protocol: 5, python: process.version, ...(announced.length ? { capabilities: announced } : {}) });
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (requestLog) fs.appendFileSync(requestLog, line + "\\n");
  const request = JSON.parse(line);
  if (request.type === "execute") {
    if (request.code === "hang") return; // never finishes, holds the FIFO
    emit({ event: "done", id: request.id, status: "ok" });
    return;
  }
  if (request.type === "bash_activity") {
    if (request.action === "list") {
      emit({ event: "done", id: request.id, status: "ok", activities: [
        { id: "act-1", command: "sleep 600", pid: 4242, startedAt: 1000, durationMs: 5, status: "running", exitCode: null },
      ] });
    } else if (request.action === "tail") {
      emit({ event: "done", id: request.id, status: "ok", activityId: request.activityId, tail: "line-a\\nline-b" });
    } else if (request.action === "kill") {
      emit({ event: "done", id: request.id, status: "ok", activityId: request.activityId, killed: true });
    }
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

describe("kernel out-of-band bash activity", () => {
	let manager: ReplKernelManager | undefined;
	let requestLogPath = "";

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-bash-activity-"));
	});

	afterEach(async () => {
		await manager?.shutdown({ snapshot: true, drainHostRequests: true });
		manager = undefined;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	function newManager(announce: string[] = ["bash_activity"]): ReplKernelManager {
		const python = join(tempDir, "python");
		requestLogPath = join(tempDir, "requests.log");
		writeFakeRuntime(python, announce);
		manager = new ReplKernelManager({
			python,
			cwd: tempDir,
			env: { FAKE_REPL_REQUEST_LOG: requestLogPath },
		});
		return manager;
	}

	it("answers a list query while a cell is running (never queued behind it)", async () => {
		const manager = newManager();
		await manager.start();
		expect(manager.supportsBashActivity).toBe(true);

		// A cell that never finishes occupies the execution FIFO.
		void manager.execute("hang").catch(() => undefined);

		const result = await manager.queryBashActivity({ action: "list" });
		expect(result?.status).toBe("ok");
		expect(result?.activities).toEqual([
			{
				id: "act-1",
				command: "sleep 600",
				pid: 4242,
				startedAt: 1000,
				durationMs: 5,
				status: "running",
				exitCode: null,
			},
		]);
		// The hang never completed; the query answered anyway, so it bypassed the queue.

		// The query frame really went out, in order, as a bash_activity request.
		const sent = requestLines(requestLogPath).map((line) => JSON.parse(line));
		const activity = sent.find((request) => request.type === "bash_activity");
		expect(activity).toMatchObject({ action: "list", id: expect.any(String) });
	});

	it("round-trips tail and kill with the requested activity id", async () => {
		const manager = newManager();
		await manager.start();

		const tailed = await manager.queryBashActivity({ action: "tail", activityId: "act-1", lines: 10 });
		expect(tailed).toMatchObject({ status: "ok", activityId: "act-1", tail: "line-a\nline-b" });

		const killed = await manager.queryBashActivity({ action: "kill", activityId: "act-1" });
		expect(killed).toMatchObject({ status: "ok", activityId: "act-1", killed: true });

		const sent = requestLines(requestLogPath).map((line) => JSON.parse(line));
		expect(sent.find((request) => request.type === "bash_activity" && request.action === "tail")).toMatchObject({
			activityId: "act-1",
			lines: 10,
		});
	});

	it("stays unavailable without the kernel's bash_activity token", async () => {
		const manager = newManager([]);
		await manager.start();
		expect(manager.supportsBashActivity).toBe(false);

		await expect(manager.queryBashActivity({ action: "list" })).resolves.toBeUndefined();

		// No frame went out on the strength of the protocol version alone.
		expect((await manager.execute("noop")).status).toBe("ok");
		await vi.waitFor(() => {
			expect(requestLines(requestLogPath).some((line) => JSON.parse(line).type === "execute")).toBe(true);
		});
		expect(requestLines(requestLogPath).filter((line) => JSON.parse(line).type === "bash_activity")).toEqual([]);
	});
});
