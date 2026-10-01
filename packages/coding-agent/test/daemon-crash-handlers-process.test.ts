import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerRecoveryJournal } from "../src/modes/daemon/worker-recovery-journal.js";

/**
 * W4-D process half: the assertions that need a real process. A session-hosting
 * daemon (worker) that hits an uncaught exception or an unhandled rejection must
 * exit(1) — the fail-fast half of the policy — and the recovery journal it leaves
 * on disk must still carry the busy record the supervisor will recover from.
 * The mocked-exit policy half lives in daemon-crash-handlers.test.ts.
 *
 * The fixture is self-contained (a tmpdir journal, no sockets, no registry), so
 * these run in the default shard rather than under the process-stress tag.
 */

const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const fixturePath = resolve(__dirname, "fixtures/daemon-crash-handlers-fixture.ts");

const children = new Set<ChildProcess>();
const tempDirs: string[] = [];

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
		}
	}
	await Promise.all([...children].map((child) => waitForExit(child).catch(() => undefined)));
	children.clear();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/**
 * A leaked session env would change what the fixture process believes about
 * itself; the daemon settings it may read come from the run-scoped agent dir
 * vitest config installs, which stays.
 */
function scrubbedEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: "1" };
	for (const key of Object.keys(env)) {
		if (key.startsWith("RLM_") || key.startsWith("PRIME_AGENT_INTERNAL_")) {
			delete env[key];
		}
	}
	return env;
}

/** Waits for `close`, not `exit`: the last stderr chunk can land after the process is gone. */
function waitForExit(child: ChildProcess): Promise<void> {
	return new Promise((resolveExit) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolveExit();
			return;
		}
		child.once("close", () => resolveExit());
		child.once("exit", () => {
			// A detached stdio pipe would otherwise hold the promise open.
			setTimeout(resolveExit, 500).unref();
		});
	});
}

async function runFixture(
	mode: string,
	journalPath: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const child = spawn(process.execPath, [tsxPath, fixturePath, mode, journalPath], {
		cwd: tmpdir(),
		env: scrubbedEnv(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.add(child);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	await waitForExit(child);
	return { exitCode: child.exitCode, stdout, stderr };
}

describe("daemon crash handlers in a real process", () => {
	it("exits(1) on an unhandled rejection and leaves the busy journal record on disk", {
		timeout: 60_000,
	}, async () => {
		const journalPath = join(tempDir("prime-agent-daemon-crash-proc-"), "worker.recovery.jsonl");

		const result = await runFixture("rejection", journalPath);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("unhandled rejection");
		expect(result.stderr).toContain("fixture unhandled rejection");
		// The in-flight session inventory is logged between the error and the exit.
		expect(result.stderr).toContain("crash context: 1 session(s) in flight: active-fixture");
		// The recovery input survived the process.
		expect(WorkerRecoveryJournal.readLatest(journalPath)).toEqual([
			expect.objectContaining({ activeSessionId: "active-fixture", busy: true, operation: "tool_execution_start" }),
		]);
	});

	it("exits(1) on an uncaught exception and leaves the busy journal record on disk", { timeout: 60_000 }, async () => {
		const journalPath = join(tempDir("prime-agent-daemon-crash-proc-"), "worker.recovery.jsonl");

		const result = await runFixture("uncaught", journalPath);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("uncaught exception");
		expect(result.stderr).toContain("fixture uncaught exception");
		expect(WorkerRecoveryJournal.readLatest(journalPath)).toEqual([
			expect.objectContaining({ activeSessionId: "active-fixture", busy: true, operation: "tool_execution_start" }),
		]);
	});
});
