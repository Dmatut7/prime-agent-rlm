import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMAND_FAILURE_RETRY_AFTER_MS, resolveConfigValue } from "../src/core/resolve-config-value.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

/**
 * The cache is keyed by the command text, so every case needs its own command. A real
 * shell and a real counter file keep the execution count an observable fact instead of
 * a spy assertion: `echo run >> counter` costs one line per execution and leaves stdout
 * (the credential) untouched.
 */
describePosix("resolveConfigValue command cache", () => {
	const dirs: string[] = [];
	let workDir = "";
	let counter = "";

	beforeEach(() => {
		// Only the clock is faked: the shell still has to run for real.
		vi.useFakeTimers({ toFake: ["Date"] });
		workDir = mkdtempSync(join(tmpdir(), "prime-resolve-command-"));
		dirs.push(workDir);
		counter = join(workDir, "runs.txt");
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function executions(): number {
		if (!existsSync(counter)) return 0;
		return readFileSync(counter, "utf-8")
			.split("\n")
			.filter((line) => line.length > 0).length;
	}

	/** Counts each run in `counter`, then fails like a missing token file does. */
	function failingCommand(missing: string): string {
		return `!echo run >> ${counter}; cat ${missing}`;
	}

	function succeedingCommand(value: string): string {
		return `!echo run >> ${counter}; echo ${value}`;
	}

	it("retries a failed credential command instead of caching the failure forever", () => {
		// `!cat /run/secrets/token` is a common auth.json shape. If the file is not there
		// yet on the first call, a permanently cached undefined means the key never works
		// again without a restart, even seconds later when the token has been written.
		const tokenFile = join(workDir, "token");
		const command = failingCommand(tokenFile);

		expect(resolveConfigValue(command)).toBeUndefined();
		writeFileSync(tokenFile, "recovered-token\n", { mode: 0o600 });

		// Inside the retry window the failure is still served from the cache: a command
		// that fails permanently must not be re-spawned on every single model call.
		expect(resolveConfigValue(command)).toBeUndefined();
		expect(executions()).toBe(1);

		vi.setSystemTime(Date.now() + COMMAND_FAILURE_RETRY_AFTER_MS + 1000);
		expect(resolveConfigValue(`!cat ${tokenFile}`)).toBe("recovered-token");
		expect(resolveConfigValue(command)).toBe("recovered-token");
		expect(executions()).toBe(2);
	});

	it("keeps serving a resolved credential without running the command again", () => {
		const command = succeedingCommand("cached-credential-value");

		expect(resolveConfigValue(command)).toBe("cached-credential-value");
		expect(resolveConfigValue(command)).toBe("cached-credential-value");
		vi.setSystemTime(Date.now() + COMMAND_FAILURE_RETRY_AFTER_MS * 10);
		expect(resolveConfigValue(command)).toBe("cached-credential-value");

		expect(executions()).toBe(1);
	});

	it("bounds how often a permanently failing command is spawned", () => {
		const command = failingCommand(join(workDir, "never-exists"));

		for (let attempt = 0; attempt < 20; attempt++) {
			expect(resolveConfigValue(command)).toBeUndefined();
		}
		expect(executions()).toBe(1);

		for (let round = 0; round < 3; round++) {
			vi.setSystemTime(Date.now() + COMMAND_FAILURE_RETRY_AFTER_MS + 1000);
			expect(resolveConfigValue(command)).toBeUndefined();
		}
		expect(executions()).toBe(4);
	});
});
