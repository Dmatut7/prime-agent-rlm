import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import { disposeSupervisorHarnesses, startSupervisorHarness } from "../../fixtures/supervisor-harness.js";
import {
	realSupervisorRegistryDir,
	SUPERVISOR_REGISTRY_DIR_ENV,
	supervisorRegistryEntries,
} from "../../fixtures/supervisor-registry-isolation.js";

/**
 * REG-1: a test daemon must never write the developer's real supervisor registry.
 *
 * `~/.prime/supervisor-owners` is user-wide authority state. A test that starts a
 * daemon without relocating that root leaves owner records behind (with a live pid
 * for as long as its process lives), and the real `status`, endpoint discovery and
 * same-agent-dir startup gate then read those ghosts as supervisors.
 *
 * These two tests are the regression gate: the user's real registry must gain zero
 * `*.owner` entries while a real CLI daemon and an in-process supervisor start, and
 * the isolated root must gain them instead (the positive control that proves the
 * counter can see a record at all).
 */

const cliPath = resolve(__dirname, "../../../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/cli.mjs");
const repoTsconfigPath = resolve(__dirname, "../../../../../tsconfig.json");

const children = new Set<ChildProcess>();
const tempRoots = new Set<string>();

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}
	children.clear();
	await disposeSupervisorHarnesses();
	for (const root of tempRoots) {
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
	tempRoots.clear();
});

function tempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.add(root);
	return root;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * The environment a daemon started from this test must see.
 *
 * Every inherited `PRIME_AGENT_INTERNAL_*` / `RLM_*` belongs to the agent run this test
 * is itself nested in, and the daemon-worker role vars would make the spawned daemon
 * take the worker path and never listen. The registry root is kept on purpose: a daemon
 * that inherits the test run's relocated root is what this file is about.
 */
function isolatedDaemonEnv(agentDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("RLM_") || (key.startsWith("PRIME_AGENT_INTERNAL_") && key !== SUPERVISOR_REGISTRY_DIR_ENV)) {
			continue;
		}
		if (value !== undefined) {
			env[key] = value;
		}
	}
	return { ...env, [ENV_AGENT_DIR]: agentDir, PI_OFFLINE: "1", TSX_TSCONFIG_PATH: repoTsconfigPath };
}

/** Connects to a daemon that is still booting, and returns the client once it has said hello. */
async function connectToDaemon(socketPath: string, diagnostics: () => string): Promise<DaemonClient> {
	const deadline = Date.now() + 45_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(2_000);
			await client.waitForHello(10_000);
			return client;
		} catch (error) {
			lastError = error;
			client.close();
			await delay(200);
		}
	}
	throw new Error(`daemon never served ${socketPath}: ${String(lastError)}\n${diagnostics()}`);
}

describe("REG-1 daemon supervisor registry isolation", () => {
	it("relocates the registry root for the whole test run", () => {
		const configured = process.env[SUPERVISOR_REGISTRY_DIR_ENV];
		expect(configured, "the test runner must relocate the daemon supervisor registry").toBeDefined();
		expect(configured).not.toBe(realSupervisorRegistryDir());
	});

	it("keeps the real registry unchanged while a real CLI daemon starts", async () => {
		const root = tempRoot("reg-1-cli-daemon-");
		const agentDir = join(root, "agent");
		const socketPath = join(root, "daemon.sock");
		mkdirSync(agentDir, { recursive: true });
		const before = supervisorRegistryEntries(realSupervisorRegistryDir());

		const child = spawn(
			process.execPath,
			[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline"],
			{
				cwd: agentDir,
				// Deliberately no registry override here: the daemon inherits the relocation
				// from the test runner, the way a leaked test used to leak into the real one.
				env: isolatedDaemonEnv(agentDir),
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		children.add(child);
		let childOutput = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			childOutput += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			childOutput += chunk.toString("utf8");
		});

		const client = await connectToDaemon(socketPath, () => `daemon output:\n${childOutput}`);
		try {
			// The regression: the user's real registry gained nothing at all.
			expect(supervisorRegistryEntries(realSupervisorRegistryDir())).toEqual(before);

			// Positive control: the daemon really did acquire durable ownership, so a zero
			// count above is a statement about where the record went, not about no record.
			const isolatedRegistryDir = process.env[SUPERVISOR_REGISTRY_DIR_ENV];
			expect(isolatedRegistryDir, "the test process must have a relocated registry root").toBeDefined();
			const records = supervisorRegistryEntries(isolatedRegistryDir).map(
				(name) =>
					JSON.parse(readFileSync(join(isolatedRegistryDir as string, name, "owner.json"), "utf8")) as {
						agentDir: string;
					},
			);
			expect(records.length, "the started daemon must have written an owner record").toBeGreaterThan(0);
			expect(records.map((record) => record.agentDir)).toContain(realpathSync(agentDir));
		} finally {
			await client.request({ type: "shutdown" }, 5_000).catch(() => undefined);
			client.close();
		}
	}, 90_000);

	it("keeps the real registry unchanged while an in-process supervisor starts", async () => {
		const before = supervisorRegistryEntries(realSupervisorRegistryDir());
		const harness = await startSupervisorHarness({ prefix: "reg-1-harness-" });

		expect(supervisorRegistryEntries(realSupervisorRegistryDir())).toEqual(before);
		expect(supervisorRegistryEntries(join(harness.root, "supervisor-registry")).length).toBeGreaterThan(0);
	}, 60_000);
});
