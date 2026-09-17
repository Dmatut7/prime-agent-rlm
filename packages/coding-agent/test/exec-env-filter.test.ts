import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.js";
import { getShellEnv } from "../src/utils/shell.js";

/**
 * exec()/bash-tool children run model-authored or third-party code (npm
 * postinstall scripts, test suites). The worker's own env — its supervisor auth
 * token, provider credentials, the user's agent socket — must not ride along,
 * while a usable shell env (PATH/HOME/TMPDIR) and the explicit passthrough
 * hatch keep commands working.
 */
describe("shell child env filtering", () => {
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

	it("exec children do not inherit worker tokens, provider keys, or agent sockets", async () => {
		vi.stubEnv("SERPER_API_KEY", "serper-secret-xyz");
		vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN", "worker-token-xyz");
		vi.stubEnv("SSH_AUTH_SOCK", "/tmp/ssh-agent-sock");
		vi.stubEnv("GITHUB_TOKEN", "gh-token-xyz");
		const dir = tempDir("exec-env-");

		const result = await execCommand("/usr/bin/env", [], dir, {});

		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain("SERPER_API_KEY=");
		expect(result.stdout).not.toContain("PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN=");
		expect(result.stdout).not.toContain("SSH_AUTH_SOCK=");
		expect(result.stdout).not.toContain("GITHUB_TOKEN=");
		expect(result.stdout).not.toContain("serper-secret-xyz");
		expect(result.stdout).not.toContain("worker-token-xyz");
		// Positive control: the child still gets a usable environment.
		expect(result.stdout).toContain("PATH=");
	});

	it("getShellEnv drops the same secrets while keeping PATH", () => {
		vi.stubEnv("SERPER_API_KEY", "serper-secret-xyz");
		vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN", "worker-token-xyz");

		const env = getShellEnv();

		expect(env.SERPER_API_KEY).toBeUndefined();
		expect(env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN).toBeUndefined();
		expect(env.PATH).toBeTruthy();
	});

	it("children receive non-interactive terminal defaults over inherited settings", async () => {
		vi.stubEnv("EDITOR", "vim");
		vi.stubEnv("PAGER", "less");
		const dir = tempDir("exec-env-ni-");

		const result = await execCommand(
			"/bin/sh",
			["-c", 'echo "$GIT_EDITOR|$GIT_SEQUENCE_EDITOR|$GIT_TERMINAL_PROMPTS|$SSH_ASKPASS_REQUIRE"'],
			dir,
			{},
		);

		expect(result.code).toBe(0);
		// stdin is ignored for exec children, so an inherited EDITOR must not
		// survive into the child: an interactive editor would hang the shell.
		expect(result.stdout).toContain("true|true|0|never");
	});

	it("forwards names opted in through PRIME_AGENT_ENV_PASSTHROUGH", async () => {
		vi.stubEnv("PRIME_AGENT_ENV_PASSTHROUGH", "SERPER_API_KEY");
		vi.stubEnv("SERPER_API_KEY", "serper-secret-xyz");
		const dir = tempDir("exec-env-pass-");

		const result = await execCommand("/bin/sh", ["-c", "printenv SERPER_API_KEY"], dir, {});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("serper-secret-xyz");
	});
});
