import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

/** Wire name of the negotiation variable; spelled out because it is the contract. */
const KERNEL_PROTOCOL_ENV_VAR = "PRIME_AGENT_KERNEL_PROTOCOL";
/** Frame kinds protocol 4 introduces: a kernel that negotiated 3 must never emit one. */
const PROTOCOL4_EVENT_KINDS = ["heartbeat"];
/** Complete protocol-3 vocabulary; anything else on the wire is corruption. */
const PROTOCOL3_EVENT_KINDS = ["ready", "stdout", "stderr", "result", "display", "host_request", "error", "done"];

let tempDir = "";
let savedProtocolEnv: string | undefined;

function writeFakeRuntime(filePath: string): void {
	writeFileSync(
		filePath,
		`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const MIN = 3;
const MAX = 4;
const frameLog = process.env.FAKE_REPL_FRAME_LOG;
const requested = process.env.${KERNEL_PROTOCOL_ENV_VAR};
fs.writeFileSync(process.env.FAKE_REPL_ENV_LOG, requested === undefined ? "unset" : requested);
const clamp = (raw) => {
  const parsed = Number.parseInt(raw === undefined ? "" : raw, 10);
  return Number.isInteger(parsed) ? Math.min(MAX, Math.max(MIN, parsed)) : MIN;
};
// An out-of-range announcement simulates a runtime from another protocol generation.
const forced = process.env.FAKE_REPL_FORCE_READY_PROTOCOL;
const protocol = forced === undefined ? clamp(requested) : Number(forced);
// Capability tokens this runtime announces. The field is omitted when there are none,
// which is exactly what a runtime predating capability announcement puts on the wire.
const announced = (process.env.FAKE_REPL_ANNOUNCE || "").split(",").filter((token) => token.length > 0);
const emit = (event) => {
  fs.appendFileSync(frameLog, event.event + "\\n");
  process.stdout.write(JSON.stringify(event) + "\\n");
};
emit({
  event: "ready",
  protocol,
  python: process.version,
  ...(announced.length > 0 ? { capabilities: announced } : {}),
});
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "execute") {
    if (request.code === "emit-v4-frame") {
      emit({ event: "heartbeat", id: request.id, alive: true });
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

function frameKinds(frameLogPath: string): string[] {
	return existsSync(frameLogPath)
		? readFileSync(frameLogPath, "utf8")
				.split("\n")
				.filter((line) => line.length > 0)
		: [];
}

describe("kernel protocol negotiation", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-protocol-"));
		savedProtocolEnv = process.env[KERNEL_PROTOCOL_ENV_VAR];
		delete process.env[KERNEL_PROTOCOL_ENV_VAR];
	});

	afterEach(() => {
		if (savedProtocolEnv === undefined) delete process.env[KERNEL_PROTOCOL_ENV_VAR];
		else process.env[KERNEL_PROTOCOL_ENV_VAR] = savedProtocolEnv;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	function newManager(options: { env?: Record<string, string>; forcedProtocol?: number; announce?: string[] } = {}): {
		manager: ReplKernelManager;
		envLogPath: string;
		frameLogPath: string;
	} {
		const python = join(tempDir, "python");
		const envLogPath = join(tempDir, "env-probe");
		const frameLogPath = join(tempDir, "frames.log");
		writeFakeRuntime(python);
		const manager = new ReplKernelManager({
			python,
			cwd: tempDir,
			env: {
				FAKE_REPL_ENV_LOG: envLogPath,
				FAKE_REPL_FRAME_LOG: frameLogPath,
				...(options.forcedProtocol === undefined
					? {}
					: { FAKE_REPL_FORCE_READY_PROTOCOL: String(options.forcedProtocol) }),
				...(options.announce === undefined ? {} : { FAKE_REPL_ANNOUNCE: options.announce.join(",") }),
				...options.env,
			},
		});
		return { manager, envLogPath, frameLogPath };
	}

	it("reports no capabilities before the kernel is ready", () => {
		const { manager } = newManager();

		expect(manager.kernelCapabilities).toBeUndefined();
		expect(manager.negotiatedProtocol).toBeUndefined();
	});

	it("asks the kernel for protocol 4 and records the negotiated capabilities", async () => {
		const { manager, envLogPath, frameLogPath } = newManager();

		try {
			await manager.start();

			expect(readFileSync(envLogPath, "utf8")).toBe("4");
			expect(manager.negotiatedProtocol).toBe(4);
			expect(manager.kernelCapabilities).toEqual({ protocol: 4, protocol4: true, preserveNames: false });
			// Positive control: a protocol-3 round trip still works under protocol 4.
			const result = await manager.execute("say-hi");
			expect(result.stdout).toContain("hi");
			expect(frameKinds(frameLogPath)).toEqual(expect.arrayContaining(["ready", "stdout", "done"]));
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("gates preserve_names on the kernel's own capability announcement", async () => {
		const { manager } = newManager({ announce: ["preserve_names"] });

		try {
			await manager.start();

			// The protocol number alone must not unlock a request field: a runtime built
			// between the protocol bump and the preserve_names change still announces 4.
			expect(manager.kernelCapabilities).toEqual({ protocol: 4, protocol4: true, preserveNames: true });
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("keeps preserve_names off when the kernel negotiated 3, whatever it announces", async () => {
		const { manager } = newManager({ forcedProtocol: 3, announce: ["preserve_names"] });

		try {
			await manager.start();

			expect(manager.kernelCapabilities).toEqual({ protocol: 3, protocol4: false, preserveNames: false });
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("ignores capability tokens it does not know", async () => {
		const { manager, frameLogPath } = newManager({ announce: ["heartbeat", "preserve_names_v9"] });

		try {
			await manager.start();

			expect(manager.kernelCapabilities).toEqual({ protocol: 4, protocol4: true, preserveNames: false });
			// Positive control: the kernel really did announce tokens, and the session works.
			expect((await manager.execute("say-hi")).stdout).toContain("hi");
			expect(frameKinds(frameLogPath)).toContain("ready");
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("never overrides an operator-set protocol request", async () => {
		process.env[KERNEL_PROTOCOL_ENV_VAR] = "3";
		const { manager, envLogPath } = newManager();

		try {
			await manager.start();

			// `export PRIME_AGENT_KERNEL_PROTOCOL=3` is the documented rollback lever for
			// every gated feature, so the host must pass it through instead of forcing 4.
			expect(readFileSync(envLogPath, "utf8")).toBe("3");
			expect(manager.kernelCapabilities).toEqual({ protocol: 3, protocol4: false, preserveNames: false });
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("lets a per-kernel env override win over the process environment", async () => {
		process.env[KERNEL_PROTOCOL_ENV_VAR] = "4";
		const { manager, envLogPath } = newManager({ env: { [KERNEL_PROTOCOL_ENV_VAR]: "3" } });

		try {
			await manager.start();

			expect(readFileSync(envLogPath, "utf8")).toBe("3");
			expect(manager.kernelCapabilities).toEqual({ protocol: 3, protocol4: false, preserveNames: false });
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("serves an older runtime that only speaks protocol 3", async () => {
		const { manager, frameLogPath } = newManager({ forcedProtocol: 3 });

		try {
			await manager.start();

			expect(manager.kernelCapabilities).toEqual({ protocol: 3, protocol4: false, preserveNames: false });
			expect((await manager.execute("say-hi")).stdout).toContain("hi");
			// The negotiated ceiling really bound the kernel: no protocol-4 frame was sent.
			const kinds = frameKinds(frameLogPath);
			expect(kinds.length).toBeGreaterThan(0);
			expect(kinds.filter((kind) => PROTOCOL4_EVENT_KINDS.includes(kind))).toEqual([]);
			expect(kinds.filter((kind) => !PROTOCOL3_EVENT_KINDS.includes(kind))).toEqual([]);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("rejects a runtime announcing a protocol outside the supported range", async () => {
		// 3.5 pins the integer check: a fractional announcement is a corrupt frame, not a
		// version this host could serve.
		const outOfRange = [2, 5, 3.5];
		expect(outOfRange.length).toBeGreaterThan(0);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			for (const protocol of outOfRange) {
				const { manager } = newManager({ forcedProtocol: protocol });
				try {
					await expect(manager.start()).rejects.toThrow(new RegExp(`speaks protocol ${protocol}, expected 3-4`));
					expect(manager.kernelCapabilities).toBeUndefined();
				} finally {
					await manager.shutdown({ snapshot: true, drainHostRequests: true });
				}
			}
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("clears the negotiated capabilities when the kernel goes away", async () => {
		const { manager } = newManager();

		await manager.start();
		expect(manager.kernelCapabilities).toEqual({ protocol: 4, protocol4: true, preserveNames: false });

		await manager.shutdown({ snapshot: true, drainHostRequests: true });

		expect(manager.kernelCapabilities).toBeUndefined();
		expect(manager.negotiatedProtocol).toBeUndefined();
	});

	it("treats a protocol-4 frame from a protocol-3 kernel as corruption", async () => {
		process.env[KERNEL_PROTOCOL_ENV_VAR] = "3";
		const { manager, frameLogPath } = newManager();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await manager.start();
			expect(manager.negotiatedProtocol).toBe(3);
			// Positive control: the same kernel serves a known frame kind first, so the
			// rejection below is about the injected protocol-4 kind, not a broken fake.
			expect((await manager.execute("say-hi")).stdout).toContain("hi");

			await expect(manager.execute("emit-v4-frame")).rejects.toThrow(
				/Kernel protocol error: unknown protocol event: heartbeat|Kernel protocol error/,
			);
			expect(frameKinds(frameLogPath)).toContain("heartbeat");
		} finally {
			errorSpy.mockRestore();
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});
});
