import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostRequestTypeIsCancellable, ReplKernelManager } from "../src/core/kernel/index.js";

/**
 * A fake kernel that issues one host request per cell and then waits, so the cell's own abort can
 * be tested against the request's signal without reaching into the manager.
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
    if (request.code.startsWith("ask:")) {
      const requestType = request.code.slice(4);
      emit({ event: "host_request", id: "hr-" + request.id, data: { type: requestType, target: "worker" } });
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
	tempDir = mkdtempSync(join(tmpdir(), "prime-agent-host-cancel-"));
});

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

interface Handler {
	type: string;
	signal?: AbortSignal;
	release: () => void;
	done: Promise<Record<string, unknown>>;
}

function newManager(cancellableHostRequestTypes?: readonly string[]): {
	manager: ReplKernelManager;
	handlers: Map<string, Handler>;
} {
	const python = join(tempDir, "python");
	writeFakeRuntime(python);
	const handlers = new Map<string, Handler>();
	const makeHandler = (type: string) => {
		let release!: () => void;
		const done = new Promise<Record<string, unknown>>((resolve) => {
			release = () => resolve({ ok: type });
		});
		const handler: Handler = { type, release, done };
		handlers.set(type, handler);
		return handler;
	};
	const readOnly = makeHandler("readonly.slow");
	const sideEffecting = makeHandler("rlm.run");
	const manager = new ReplKernelManager({
		python,
		cwd: tempDir,
		...(cancellableHostRequestTypes ? { cancellableHostRequestTypes } : {}),
		hostHandlers: {
			"readonly.slow": async (_payload, signal) => {
				readOnly.signal = signal;
				return readOnly.done;
			},
			"rlm.run": async (_payload, signal) => {
				sideEffecting.signal = signal;
				return sideEffecting.done;
			},
		},
	});
	return { manager, handlers };
}

describe("host request cancellation by cell abort (P1-2a)", () => {
	it("releases a whitelisted read-only request when the cell is aborted", async () => {
		const { manager, handlers } = newManager(["readonly.slow"]);
		try {
			const controller = new AbortController();
			const pending = manager.execute("ask:readonly.slow", { signal: controller.signal });
			await vi.waitFor(() => expect(handlers.get("readonly.slow")?.signal).toBeDefined(), { timeout: 15_000 });
			expect(handlers.get("readonly.slow")?.signal?.aborted).toBe(false);

			controller.abort();
			await vi.waitFor(() => expect(handlers.get("readonly.slow")?.signal?.aborted).toBe(true), {
				timeout: 15_000,
			});
			const result = await pending;
			expect(result.status).toBe("aborted");
		} finally {
			handlers.get("readonly.slow")?.release();
			await manager.shutdown();
		}
	});

	it("keeps a side-effecting request running when the cell is aborted (M7)", async () => {
		const { manager, handlers } = newManager(["readonly.slow"]);
		try {
			const controller = new AbortController();
			const pending = manager.execute("ask:rlm.run", { signal: controller.signal });
			await vi.waitFor(() => expect(handlers.get("rlm.run")?.signal).toBeDefined(), { timeout: 15_000 });

			controller.abort();
			const result = await pending;
			expect(result.status).toBe("aborted");
			// The admission the model was told would outlive its turn is still alive: this is the
			// guarantee "start the work, record its handle, then end your turn" rests on.
			expect(handlers.get("rlm.run")?.signal?.aborted).toBe(false);
			handlers.get("rlm.run")?.release();
			await expect(handlers.get("rlm.run")?.done).resolves.toEqual({ ok: "rlm.run" });
		} finally {
			handlers.get("rlm.run")?.release();
			await manager.shutdown();
		}
	});

	it("cancels nothing on a cell abort when no whitelist is configured", async () => {
		const { manager, handlers } = newManager();
		try {
			const controller = new AbortController();
			const pending = manager.execute("ask:readonly.slow", { signal: controller.signal });
			await vi.waitFor(() => expect(handlers.get("readonly.slow")?.signal).toBeDefined(), { timeout: 15_000 });
			controller.abort();
			await pending;
			expect(handlers.get("readonly.slow")?.signal?.aborted).toBe(false);
		} finally {
			handlers.get("readonly.slow")?.release();
			await manager.shutdown();
		}
	});

	it("still cancels a whitelisted request on teardown", async () => {
		const { manager, handlers } = newManager(["readonly.slow"]);
		try {
			const pending = manager.execute("ask:readonly.slow").catch(() => undefined);
			await vi.waitFor(() => expect(handlers.get("readonly.slow")?.signal).toBeDefined(), { timeout: 15_000 });
			await manager.shutdown();
			expect(handlers.get("readonly.slow")?.signal?.aborted).toBe(true);
			await pending;
		} finally {
			handlers.get("readonly.slow")?.release();
		}
	});

	it("still cancels a side-effecting request on teardown (the whitelist narrows cell aborts only)", async () => {
		const { manager, handlers } = newManager(["readonly.slow"]);
		try {
			const pending = manager.execute("ask:rlm.run").catch(() => undefined);
			await vi.waitFor(() => expect(handlers.get("rlm.run")?.signal).toBeDefined(), { timeout: 15_000 });
			await manager.shutdown();
			expect(handlers.get("rlm.run")?.signal?.aborted).toBe(true);
			await pending;
		} finally {
			handlers.get("rlm.run")?.release();
		}
	});
});
describe("hostRequestTypeIsCancellable", () => {
	it("matches exactly, by prefix pattern, and not at all when nothing is declared", () => {
		expect(hostRequestTypeIsCancellable(["rlm.find_models"], "rlm.find_models")).toBe(true);
		expect(hostRequestTypeIsCancellable(["rlm.find_models"], "rlm.run")).toBe(false);
		expect(hostRequestTypeIsCancellable(["agent_observe.*"], "agent_observe.recent")).toBe(true);
		expect(hostRequestTypeIsCancellable(["agent_observe.*"], "agent_message.send")).toBe(false);
		// A bare "*" would cancel everything, which is the one mistake that loses admitted work.
		expect(hostRequestTypeIsCancellable(["*"], "rlm.run")).toBe(true);
		expect(hostRequestTypeIsCancellable([], "rlm.find_models")).toBe(false);
		expect(hostRequestTypeIsCancellable(undefined, "rlm.find_models")).toBe(false);
	});
});
