import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import {
	DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES,
	DAEMON_FIRST_PARTY_SESSION_CAPABILITIES,
	type DaemonDeclaredCapability,
} from "../../../src/modes/daemon/daemon-protocol.js";

const cliPath = resolve(__dirname, "../../../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/cli.mjs");

const tempDirs: string[] = [];
const children = new Set<ChildProcess>();

async function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolveWait) => {
		const timer = setTimeout(() => resolveWait(), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolveWait();
		});
	});
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await new Promise<void>((resolveWait) => {
			const timer = setTimeout(() => resolveWait(), 1000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolveWait();
			});
		});
	}
}

afterEach(async () => {
	for (const child of [...children]) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			await waitForExit(child, 3000);
		}
	}
	children.clear();
	if (process.env.W7_KEEP_DIRS !== "1") {
		for (const directory of tempDirs.splice(0)) {
			let lastError: unknown;
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					rmSync(directory, { recursive: true, force: true });
					lastError = undefined;
					break;
				} catch (error) {
					lastError = error;
					await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
				}
			}
			if (lastError) throw lastError;
		}
	}
});

function spawnSupervisor(socketPath: string, agentDir: string): ChildProcess {
	// Scrub inherited RLM_* / PRIME_AGENT_INTERNAL_* / FORCE_COLOR: when the suite
	// itself runs inside a daemon worker or RLM child, those would make the
	// spawned supervisor take the worker path and never listen.
	const scrubbedEnv: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("PRIME_AGENT_INTERNAL_") || key.startsWith("RLM_") || key === "FORCE_COLOR") {
			continue;
		}
		if (value !== undefined) {
			scrubbedEnv[key] = value;
		}
	}
	const child = spawn(
		process.execPath,
		[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline"],
		{
			cwd: agentDir,
			env: {
				...scrubbedEnv,
				[ENV_AGENT_DIR]: agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const debugLog = join(agentDir, "child-output.log");
	child.stdout?.on("data", (chunk: Buffer) => appendFileSync(debugLog, chunk));
	child.stderr?.on("data", (chunk: Buffer) => appendFileSync(debugLog, chunk));
	children.add(child);
	return child;
}

function createClient(socketPath: string, declaredCapabilities?: readonly DaemonDeclaredCapability[]): DaemonClient {
	return declaredCapabilities === undefined
		? new DaemonClient(socketPath)
		: new DaemonClient(socketPath, { declaredCapabilities });
}

async function connectClient(
	socketPath: string,
	declaredCapabilities?: readonly DaemonDeclaredCapability[],
): Promise<DaemonClient> {
	const deadline = Date.now() + 15_000;
	let lastError: unknown;
	for (;;) {
		const client = createClient(socketPath, declaredCapabilities);
		try {
			await client.connect(500);
			await client.waitForHello(1000);
			return client;
		} catch (error) {
			lastError = error;
			client.close();
			if (Date.now() > deadline) throw lastError;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		}
	}
}

describe("W7 capability gating and control-plane auth", () => {
	function createSocket(): { socketPath: string; agentDir: string } {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-w7-supervisor-"));
		tempDirs.push(agentDir);
		const socketPath = join(agentDir, "daemon.sock");
		spawnSupervisor(socketPath, agentDir);
		return { socketPath, agentDir };
	}

	it("keeps the legacy compatibility path for undeclared connections", async () => {
		const { socketPath } = createSocket();
		const child = [...children].at(-1)!;
		const client = await connectClient(socketPath);
		try {
			const heartbeats = await client.request({ type: "heartbeats_list" }, 5000);
			expect(heartbeats.success).toBe(true);
			const shutdown = await client.request({ type: "shutdown" }, 5000);
			expect(shutdown.success).toBe(true);
		} finally {
			client.close();
		}
		await waitForExit(child, 10_000);
	});

	it("refuses a capability-gated command from a connection that declared capabilities without it", async () => {
		const { socketPath } = createSocket();
		const client = await connectClient(socketPath, ["event_sequence"]);
		try {
			const heartbeats = await client.request({ type: "heartbeats_list" }, 5000);
			expect(heartbeats).toMatchObject({
				success: false,
				error: expect.stringContaining("heartbeat_catalog"),
			});
			expect(heartbeats).toMatchObject({
				success: false,
				error: expect.stringContaining("capability"),
			});
			const omitted = await client.request({ type: "list", omitStreamingMessages: true }, 5000);
			expect(omitted).toMatchObject({
				success: false,
				error: expect.stringContaining("list_without_streaming_messages"),
			});
		} finally {
			client.close();
		}
	});

	it("runs a capability-gated command once the connection declares the capability", async () => {
		const { socketPath } = createSocket();
		const client = await connectClient(socketPath, ["heartbeat_catalog"]);
		try {
			const heartbeats = await client.request({ type: "heartbeats_list" }, 5000);
			expect(heartbeats.success).toBe(true);
		} finally {
			client.close();
		}
	});

	it("refuses shutdown, restart, and prepare_update_restart without control_plane", async () => {
		const { socketPath } = createSocket();
		const child = [...children].at(-1)!;
		const client = await connectClient(socketPath, ["event_sequence"]);
		try {
			for (const type of ["shutdown", "restart", "prepare_update_restart"] as const) {
				const response = await client.request({ type }, 5000);
				expect(response).toMatchObject({
					success: false,
					error: expect.stringContaining("control_plane"),
				});
			}
			expect(child.exitCode).toBeNull();
		} finally {
			client.close();
		}
		const probe = await connectClient(socketPath);
		try {
			const heartbeats = await probe.request({ type: "heartbeats_list" }, 5000);
			expect(heartbeats.success).toBe(true);
		} finally {
			probe.close();
		}
	});

	it("lets a session-plane first-party client use gated commands but not shutdown", async () => {
		const { socketPath } = createSocket();
		const child = [...children].at(-1)!;
		const client = await connectClient(socketPath, DAEMON_FIRST_PARTY_SESSION_CAPABILITIES);
		try {
			const heartbeats = await client.request({ type: "heartbeats_list" }, 5000);
			expect(heartbeats.success).toBe(true);
			// Positive control for the omit leg: the same first-party set carries
			// list_without_streaming_messages, so the gate must admit the command
			// instead of naming the capability. This supervisor has no resident
			// session, so the strip itself is pinned in
			// test/daemon-supervisor-streaming-list.test.ts.
			const omitted = await client.request({ type: "list", omitStreamingMessages: true }, 5000);
			expect(omitted.success).toBe(true);
			// DaemonResponse discriminates on success; data only exists on the true arm.
			if (!omitted.success) throw new Error(omitted.error);
			expect(Array.isArray((omitted.data as { sessions: unknown[] }).sessions)).toBe(true);
			const shutdown = await client.request({ type: "shutdown" }, 5000);
			expect(shutdown).toMatchObject({
				success: false,
				error: expect.stringContaining("control_plane"),
			});
			expect(child.exitCode).toBeNull();
		} finally {
			client.close();
		}
	});

	it("shuts down for a connection that declared control_plane", async () => {
		const { socketPath } = createSocket();
		const child = [...children].at(-1)!;
		const client = await connectClient(socketPath, DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES);
		const shutdown = await client.request({ type: "shutdown" }, 5000);
		expect(shutdown.success).toBe(true);
		client.close();
		const exitCode = await new Promise<number | null>((resolveExit) => {
			if (child.exitCode !== null) {
				resolveExit(child.exitCode);
				return;
			}
			child.once("exit", (code) => resolveExit(code));
			setTimeout(() => resolveExit(child.exitCode), 10_000);
		});
		expect(exitCode).not.toBeNull();
	});
});
