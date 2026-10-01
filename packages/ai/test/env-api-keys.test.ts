import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findClaudeCodeExecutable, findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";

/**
 * An installed `claude` binary is ambient machine state: getEnvApiKey("claude-code") treats
 * it as a credential so the claude-code catalog models enter getAvailable(). That made
 * availability assertions machine-dependent (4620/4649/r43 went red on any dev box with the
 * CLI). PI_DISABLE_CLAUDE_CODE_DETECTION is the opt-out the test harness pins; these cases
 * pin the contract: the flag gates the credential mapping, never the executable locator,
 * and never the plain env-var providers.
 */

const DETECTION_FLAG = "PI_DISABLE_CLAUDE_CODE_DETECTION";

describe("PI_DISABLE_CLAUDE_CODE_DETECTION", () => {
	let root: string;
	let fakeCli: string;

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "env-api-keys-test-"));
		const binDir = join(root, "bin");
		mkdirSync(binDir);
		fakeCli = join(binDir, process.platform === "win32" ? "claude.exe" : "claude");
		writeFileSync(fakeCli, "#!/bin/sh\nexit 0\n");
		chmodSync(fakeCli, 0o755);
		vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
		// env-api-keys loads node:fs asynchronously on runtimes without
		// process.getBuiltinModule; wait until the locator can see the fake CLI.
		for (let attempt = 0; attempt < 50 && findClaudeCodeExecutable() !== fakeCli; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(findClaudeCodeExecutable()).toBe(fakeCli);
	});

	afterAll(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("treats an installed CLI as the credential when the flag is unset", () => {
		vi.stubEnv(DETECTION_FLAG, "");
		expect(getEnvApiKey("claude-code")).toBe("<authenticated>");
	});

	it("withholds the ambient credential when the flag is enabled", () => {
		vi.stubEnv(DETECTION_FLAG, "1");
		expect(getEnvApiKey("claude-code")).toBeUndefined();
	});

	it("accepts the truthy spellings used by the other PI_* flags", () => {
		vi.stubEnv(DETECTION_FLAG, "true");
		expect(getEnvApiKey("claude-code")).toBeUndefined();
		vi.stubEnv(DETECTION_FLAG, "yes");
		expect(getEnvApiKey("claude-code")).toBeUndefined();
	});

	it("keeps detecting for disabled spellings", () => {
		vi.stubEnv(DETECTION_FLAG, "0");
		expect(getEnvApiKey("claude-code")).toBe("<authenticated>");
		vi.stubEnv(DETECTION_FLAG, "false");
		expect(getEnvApiKey("claude-code")).toBe("<authenticated>");
	});

	it("gates the credential mapping only: the CLI locator is unaffected", () => {
		vi.stubEnv(DETECTION_FLAG, "1");
		expect(findClaudeCodeExecutable()).toBe(fakeCli);
	});

	it("does not change env-var providers", () => {
		vi.stubEnv(DETECTION_FLAG, "1");
		vi.stubEnv("OPENAI_API_KEY", "sk-test-env-key");
		expect(findEnvKeys("openai")).toEqual(["OPENAI_API_KEY"]);
		expect(getEnvApiKey("openai")).toBe("sk-test-env-key");
	});
});
