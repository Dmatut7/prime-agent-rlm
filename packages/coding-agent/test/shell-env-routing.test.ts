import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.js";
import { getShellEnv } from "../src/utils/shell.js";

const here = dirname(fileURLToPath(import.meta.url));
const tsxPath = resolve(here, "../../../node_modules/tsx/dist/cli.mjs");
const childFixturePath = resolve(here, "fixtures/env-routing-child.ts");

/**
 * The bash tool is also the channel the agent's own CLI travels through
 * (self-update, nested `prime-agent` runs). SEC-4 must strip credentials there
 * while still forwarding the non-secret names product code reads: a nested CLI
 * that loses them silently targets the default daemon instead of its supervisor
 * (the eng-4606 shape) and ignores the documented privacy opt-outs that SEC-1
 * routes through backgroundNetworkOptOut(). The child fixture below is real
 * product-adjacent code: it imports the production opt-out helper and prints the
 * routing names, exactly like a nested CLI would read them.
 */
describe("shell child env keeps routing and opt-out names", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function tempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	function shellQuote(value: string): string {
		return `'${value.replaceAll("'", `'"'"'`)}'`;
	}

	interface ChildReport {
		optOut: string | null;
		supervisorSocket: string | null;
		activeSessionId: string | null;
		agentDir: string | null;
		sessionDir: string | null;
		supervisorRegistryDir: string | null;
		workerToken: string | null;
		serperApiKey: string | null;
	}

	/** Run the fixture through the production bash-tool spawn path (getShellEnv). */
	async function runChildThroughBashTool(): Promise<ChildReport> {
		const ops = createLocalBashOperations({});
		let output = "";
		const command = [process.execPath, tsxPath, childFixturePath].map(shellQuote).join(" ");
		const { exitCode } = await ops.exec(command, tempDir("env-routing-"), {
			onData: (chunk) => {
				output += chunk.toString("utf8");
			},
			timeout: 60,
		});
		expect(exitCode).toBe(0);
		const lastLine = output.trim().split("\n").at(-1);
		return JSON.parse(lastLine ?? "{}") as ChildReport;
	}

	it("bash-tool children honor DO_NOT_TRACK through backgroundNetworkOptOut", async () => {
		vi.stubEnv("DO_NOT_TRACK", "1");
		vi.stubEnv("PI_OFFLINE", "0");
		const report = await runChildThroughBashTool();
		expect(report.optOut).toBe("DO_NOT_TRACK");
	});

	it("bash-tool children honor PI_OFFLINE through backgroundNetworkOptOut", async () => {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("PI_OFFLINE", "1");
		const report = await runChildThroughBashTool();
		expect(report.optOut).toBe("PI_OFFLINE");
	});

	it("bash-tool children forward the update routing names (supervisor socket, origin session id)", async () => {
		vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET", "/tmp/bsh-supervisor.sock");
		vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID", "origin-session-42");
		vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR", "/tmp/bsh-registry");
		const report = await runChildThroughBashTool();
		expect(report.supervisorSocket).toBe("/tmp/bsh-supervisor.sock");
		expect(report.activeSessionId).toBe("origin-session-42");
		expect(report.supervisorRegistryDir).toBe("/tmp/bsh-registry");
	});

	it("bash-tool children keep the agentDir/sessionDir pins a nested CLI targets", async () => {
		vi.stubEnv("PRIME_AGENT_CODING_AGENT_DIR", "/tmp/bsh-agentdir");
		vi.stubEnv("PRIME_AGENT_SESSION_DIR", "/tmp/bsh-sessiondir");
		const report = await runChildThroughBashTool();
		expect(report.agentDir).toBe("/tmp/bsh-agentdir");
		expect(report.sessionDir).toBe("/tmp/bsh-sessiondir");
	});

	it("bash-tool children still strip worker tokens and provider keys", async () => {
		vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN", "worker-token-xyz");
		vi.stubEnv("SERPER_API_KEY", "serper-secret-xyz");
		vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET", "/tmp/bsh-supervisor.sock");
		const report = await runChildThroughBashTool();
		expect(report.workerToken).toBeNull();
		expect(report.serperApiKey).toBeNull();
		expect(report.supervisorSocket).toBe("/tmp/bsh-supervisor.sock");
	});

	it("getShellEnv forwards the same names without the secrets", () => {
		vi.stubEnv("DO_NOT_TRACK", "1");
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "0");
		vi.stubEnv("PRIME_AGENT_TRUSTED_UPDATE_ORIGINS", "https://mirror.example");
		vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET", "/tmp/bsh-supervisor.sock");
		vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID", "origin-session-42");
		vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR", "/tmp/bsh-registry");
		vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN", "worker-token-xyz");

		const env = getShellEnv();

		expect(env.DO_NOT_TRACK).toBe("1");
		expect(env.PI_OFFLINE).toBe("1");
		expect(env.PRIME_AGENT_TELEMETRY).toBe("0");
		expect(env.PRIME_AGENT_TRUSTED_UPDATE_ORIGINS).toBe("https://mirror.example");
		expect(env.PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET).toBe("/tmp/bsh-supervisor.sock");
		expect(env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID).toBe("origin-session-42");
		expect(env.PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR).toBe("/tmp/bsh-registry");
		expect(env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN).toBeUndefined();
		expect(env.PATH).toBeTruthy();
	});
});

describe("getShellEnv non-interactive defaults", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("sets non-interactive defaults for agent-spawned shells", () => {
		const env = getShellEnv();
		// Agent shells never have a usable stdin, so interactive prompts (git
		// commit without -m opening $EDITOR, credential asks, pagers) can only
		// hang; these defaults make them fail fast or no-op.
		expect(env.GIT_EDITOR).toBe("true");
		expect(env.GIT_SEQUENCE_EDITOR).toBe("true");
		expect(env.GIT_TERMINAL_PROMPTS).toBe("0");
		expect(env.GIT_ASKPASS).toBe("true");
		expect(env.SSH_ASKPASS_REQUIRE).toBe("never");
		expect(env.EDITOR).toBe("true");
		expect(env.VISUAL).toBe("true");
		expect(env.PAGER).toBe("cat");
		expect(env.GIT_PAGER).toBe("cat");
		expect(env.DEBIAN_FRONTEND).toBe("noninteractive");
	});

	it("overrides inherited terminal settings instead of honoring them", () => {
		vi.stubEnv("EDITOR", "vim");
		vi.stubEnv("PAGER", "less");
		vi.stubEnv("GIT_SEQUENCE_EDITOR", "vim");
		const env = getShellEnv();
		// stdin is never a TTY for agent shells, so an inherited EDITOR/PAGER is
		// exactly the hang this guard prevents; it must be replaced, not kept.
		expect(env.EDITOR).toBe("true");
		expect(env.PAGER).toBe("cat");
		// GIT_SEQUENCE_EDITOR outranks GIT_EDITOR for `git rebase -i`, so an
		// inherited value would still hang the interactive todo editor.
		expect(env.GIT_SEQUENCE_EDITOR).toBe("true");
	});
});
