import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { PROJECT_TRUST_FILE_NAME, ProjectTrustStore } from "../src/core/project-trust.js";

/**
 * Fault injection for the machine-mode half of the extension trust gate
 * (GHSA-mqxh-6gq7-558m port). The nightmare scenario is an unattended
 * `-p`/`--mode` run sitting on a trust prompt nobody answers overnight, or a
 * cloned repository's extension executing without any prompt at all. Each case
 * here starts the real CLI in a project directory whose `.prime/agent/extensions`
 * holds an extension that leaves a beacon file when its factory runs, then
 * asserts the process actually exited (bounded wait = it did not hang), and
 * whether the beacon appeared.
 */
const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");

const tempRoots: string[] = [];

afterEach(() => {
	for (const dir of tempRoots.splice(0)) {
		// The CLI's daemon/kernel children may still be flushing caches under this
		// dir when the child exits; retry the ENOTEMPTY/EBUSY window.
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

interface CliRunResult {
	exitCode: number | null;
	signal: string | null;
	stderr: string;
	timedOut: boolean;
}

function runPrintModeCli(options: {
	projectDir: string;
	agentDir: string;
	socketPath: string;
	extraArgs?: string[];
	timeoutMs: number;
}): Promise<CliRunResult> {
	const { projectDir, agentDir, socketPath, extraArgs = [], timeoutMs } = options;

	return new Promise<CliRunResult>((resolveRun) => {
		const child = spawn(
			process.execPath,
			[
				tsxPath,
				cliPath,
				"-p",
				"say hi",
				"--no-session",
				"--no-tools",
				"--offline",
				"--daemon-socket",
				socketPath,
				...extraArgs,
			],
			{
				cwd: projectDir,
				env: {
					...process.env,
					// The vitest config pins a shared test agent dir; this run needs its own
					// so the trust store under test is this test's file.
					[ENV_AGENT_DIR]: agentDir,
					HOME: agentDir,
					TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		let stderr = "";
		let timedOut = false;
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const finish = (exitCode: number | null, signal: string | null) => {
			resolveRun({ exitCode, signal, stderr, timedOut });
		};

		const timer = setTimeout(() => {
			// The failure this test guards against is a hang: the run must be observed
			// hanging here for the assertion to fail, so record it and tear the process
			// down instead of waiting forever.
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.once("exit", (exitCode, signal) => {
			clearTimeout(timer);
			finish(exitCode, signal);
		});
	});
}

function makeProject(tempRoot: string): { projectDir: string; agentDir: string; beaconPath: string } {
	const projectDir = join(tempRoot, "project");
	const agentDir = join(tempRoot, "agent");
	mkdirSync(agentDir, { recursive: true });
	const extensionsDir = join(projectDir, ".prime/agent/extensions");
	mkdirSync(extensionsDir, { recursive: true });

	// The "malicious" extension: repo-controlled code that records its own execution.
	writeFileSync(
		join(extensionsDir, "beacon.ts"),
		[
			'import { appendFileSync } from "node:fs";',
			'import { join, dirname } from "node:path";',
			"export default function () {",
			'	try { appendFileSync(join(dirname(new URL(import.meta.url).pathname), "beacon-ran.txt"), "ran"); } catch {}',
			"}",
		].join("\n"),
	);

	return { projectDir, agentDir, beaconPath: join(extensionsDir, "beacon-ran.txt") };
}

describe("machine-mode extension trust gate over a real CLI process", () => {
	it("refuses an undecided project's extensions without hanging and explains why", {
		tags: ["process-stress"],
		timeout: 120_000,
	}, async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-trust-machine-"));
		tempRoots.push(tempRoot);
		const { projectDir, agentDir, beaconPath } = makeProject(tempRoot);

		const result = await runPrintModeCli({
			projectDir,
			agentDir,
			socketPath: join(tempRoot, "d.sock"),
			timeoutMs: 90_000,
		});

		// The load-bearing assertion: a machine run must terminate on its own.
		expect(result.timedOut).toBe(false);
		expect(result.exitCode).not.toBeNull();
		// No models are configured, so the run legitimately fails - after startup.
		expect(result.exitCode).toBe(1);
		// The refusal must not be silent.
		expect(result.stderr).toContain("not trusted");
		expect(result.stderr).toContain("--approve");
		// And the repository's extension code must never have run.
		expect(existsSync(beaconPath)).toBe(false);
	});

	it("executes the project's extensions when --approve is passed for the run", {
		tags: ["process-stress"],
		timeout: 120_000,
	}, async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-trust-machine-"));
		tempRoots.push(tempRoot);
		const { projectDir, agentDir, beaconPath } = makeProject(tempRoot);

		const result = await runPrintModeCli({
			projectDir,
			agentDir,
			socketPath: join(tempRoot, "d.sock"),
			extraArgs: ["--approve"],
			timeoutMs: 90_000,
		});

		expect(result.timedOut).toBe(false);
		// The extension factory ran inside the daemon worker: the one-run
		// override must reach the process that actually loads extensions.
		expect(existsSync(beaconPath)).toBe(true);
	});

	it("executes the project's extensions when a saved trust decision exists", {
		tags: ["process-stress"],
		timeout: 120_000,
	}, async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-trust-machine-"));
		tempRoots.push(tempRoot);
		const { projectDir, agentDir, beaconPath } = makeProject(tempRoot);
		// The store is written the way the interactive prompt would have written it.
		new ProjectTrustStore(agentDir).set(projectDir, true);
		// Sanity: the decision really is on disk in this agent dir.
		expect(existsSync(join(agentDir, PROJECT_TRUST_FILE_NAME))).toBe(true);

		const result = await runPrintModeCli({
			projectDir,
			agentDir,
			socketPath: join(tempRoot, "d.sock"),
			timeoutMs: 90_000,
		});

		expect(result.timedOut).toBe(false);
		expect(existsSync(beaconPath)).toBe(true);
	});
});
