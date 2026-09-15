import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { handlePackageCommand } from "../src/package-manager-cli.js";

/**
 * K3R2-3 (round-31 F4a): the package/config CLI surfaces drained settings
 * errors only. A broken ancestor settings file is a warning, not an error (the
 * rest of the project scope still loads), so `prime-agent package` reported
 * nothing at all while quietly running without that file.
 */
describe("K3R2-3: the package CLI reports settings warnings", () => {
	let testDir = "";
	let agentDir = "";
	let repoRoot = "";
	let subDir = "";
	let rootSettingsPath = "";
	let originalCwd = "";
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-k3r2-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(testDir, "agent");
		repoRoot = join(testDir, "repo");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		subDir = join(repoRoot, "packages", "app");
		mkdirSync(subDir, { recursive: true });
		mkdirSync(join(repoRoot, ".prime", "agent"), { recursive: true });
		rootSettingsPath = join(repoRoot, ".prime", "agent", "settings.json");
		writeFileSync(rootSettingsPath, "{ broken json");
		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(subDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		rmSync(testDir, { recursive: true, force: true });
	});

	it("prints the broken-ancestor warning during package list", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await expect(handlePackageCommand(["list"])).resolves.toBe(true);
		} finally {
			vi.restoreAllMocks();
		}
		// Before the fix, reportSettingsErrors drained only errors, so the broken
		// ancestor - a warning - never reached the console from this CLI.
		// chdir resolves /var -> /private/var on macOS, so compare the real path.
		const realSettingsPath = realpathSync(rootSettingsPath);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining(`Warning (package command, project settings): settings.json at ${realSettingsPath}`),
		);
	});
});
