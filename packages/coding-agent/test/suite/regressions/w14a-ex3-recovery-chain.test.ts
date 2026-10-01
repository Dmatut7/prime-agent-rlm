import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import { readRecordedDaemonSocketOwners } from "../../../src/modes/daemon/daemon-supervisor-ownership.js";
import {
	isolatedSupervisorRegistryEnv,
	SUPERVISOR_REGISTRY_DIR_ENV,
} from "../../fixtures/supervisor-registry-isolation.js";

/**
 * W14-A: the exam-v1 EX-3 recovery chain as a suite test (driver:
 * scripts/evals/exam-v1/ex3-recovery/run_ex3.py, graded model-free there).
 * A real CLI subprocess runs a scripted faux-model phase A (write
 * phase-a.txt, then a heartbeat cell), gets SIGTERMed mid-cell (print mode
 * maps that to exit 143), the detached daemon is stopped through the daemon
 * shutdown envelope, and a second CLI resumes the same session file for
 * phase B, which must read the kill-point state back instead of redoing
 * phase A.
 *
 * The kernel is a fixture process speaking the REPL protocol
 * (PRIME_AGENT_KERNEL_PYTHON), so the chain runs without a real model or a
 * real Python runtime; the phase-B script fails the run unless the resumed
 * context still carries the phase-A prompt, which is what makes this a
 * resume test and not two unrelated runs.
 */

const cliPath = resolve(__dirname, "../../../src/cli.ts");
const fauxExtensionPath = resolve(__dirname, "../../fixtures/w14a-ex3-faux-extension.ts");
const repoTsconfigPath = resolve(__dirname, "../../../../../tsconfig.json");
// The daemon respawns the CLI entrypoint with the client's execArgv from the
// session cwd: a bare `--import tsx` resolves the specifier from that cwd and
// fails outside the repo, so the loader is pinned by absolute path.
const tsxLoaderPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/loader.mjs");
const children = new Set<ChildProcess>();
const tempRoots = new Set<string>();
const daemonSockets = new Map<string, string>();

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function lineCount(path: string): number {
	try {
		return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string | (() => string)): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await delay(50);
	}
	throw new Error(`Timed out waiting for ${typeof label === "function" ? label() : label}`);
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The daemon pid that owns `socketPath`, from the isolated supervisor registry. */
function daemonPidForSocket(socketPath: string, registryDir: string): number | undefined {
	const owners = readRecordedDaemonSocketOwners({
		...process.env,
		[SUPERVISOR_REGISTRY_DIR_ENV]: registryDir,
	});
	const owner = owners.find((candidate) => candidate.socketPath === socketPath);
	return owner && owner.pid > 0 ? owner.pid : undefined;
}

/**
 * Deliver the daemon shutdown envelope and wait for the daemon process to
 * exit, mirroring examlib.shutdown_daemon plus the wave13 driver teardown.
 */
async function shutdownDaemon(socketPath: string, registryDir: string): Promise<void> {
	const daemonPid = daemonPidForSocket(socketPath, registryDir);
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(2000);
		await client.request({ type: "shutdown" }, 10_000);
	} finally {
		client.close();
	}
	await waitFor(() => !existsSync(socketPath), 10_000, `daemon socket ${socketPath} to be removed`);
	if (daemonPid !== undefined) {
		await waitFor(() => !isPidAlive(daemonPid), 10_000, `daemon pid ${daemonPid} to exit`);
	}
}

/**
 * A fake kernel python: answers the host's `-c` readiness probes with exit 0
 * and speaks the REPL protocol (ready frame, execute/interrupt/shutdown) for
 * `-m rlm.repl`. The #w14a:* cell markers perform the exam's file IO; the
 * heartbeat cell appends one tick per 100ms and never finishes on its own
 * within the test window.
 */
const FAKE_KERNEL = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
if (process.argv.includes("-c")) process.exit(0);
const fixtureDir = process.env.W14A_EX3_FIXTURE || process.cwd();
const heartbeatPath = path.join(fixtureDir, "heartbeat.log");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let ticks = 0;
emit({ event: "ready", protocol: 3 });
process.stdin.on("end", () => process.exit(0));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "interrupt") return;
	if (request.type === "shutdown") process.exit(0);
	const code = String(request.code || "");
	const done = () => emit({ event: "done", id: request.id, status: "ok" });
	if (code.startsWith("#w14a:write-phase-a\\n")) {
		const token = code.split("\\n")[1].trim();
		fs.writeFileSync(path.join(fixtureDir, "phase-a.txt"), token + "\\n");
		emit({ event: "result", id: request.id, text: "phase-a written" });
		return done();
	}
	if (code === "#w14a:heartbeat") {
		const timer = setInterval(() => {
			fs.appendFileSync(heartbeatPath, "tick\\n");
			ticks += 1;
			if (ticks >= 600) {
				clearInterval(timer);
				done();
			}
		}, 100);
		return;
	}
	if (code === "#w14a:probe") {
		const token = fs.readFileSync(path.join(fixtureDir, "phase-a.txt"), "utf8").split("\\n")[0].trim();
		let held = 0;
		try {
			held = fs.readFileSync(heartbeatPath, "utf8").split("\\n").filter(Boolean).length;
		} catch {}
		emit({ event: "result", id: request.id, text: "TOKEN=" + token + "\\nTICKS=" + held });
		return done();
	}
	if (code.startsWith("#w14a:write-phase-b\\n")) {
		const parts = code.split("\\n");
		fs.writeFileSync(path.join(fixtureDir, "phase-b.txt"), "token: " + parts[1] + "\\nheartbeat_ticks: " + parts[2] + "\\n");
		emit({ event: "result", id: request.id, text: "phase-b written" });
		return done();
	}
	done();
});
`;

interface CliRun {
	child: ChildProcess;
	stdout: () => string;
	stderr: () => string;
	exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnCli(
	args: string[],
	options: { agentDir: string; fixtureDir: string; phase: "A" | "B"; fakePython: string },
): CliRun {
	const child = spawn(process.execPath, ["--import", tsxLoaderPath, cliPath, ...args], {
		env: {
			...process.env,
			TSX_TSCONFIG_PATH: repoTsconfigPath,
			[ENV_AGENT_DIR]: options.agentDir,
			// The CLI auto-spawns a real daemon; without this it registers its
			// ownership in the developer's real ~/.prime/supervisor-owners.
			...isolatedSupervisorRegistryEnv(options.agentDir),
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PRIME_AGENT_KERNEL_PYTHON: options.fakePython,
			W14A_EX3_FIXTURE: options.fixtureDir,
			W14A_EX3_PHASE: options.phase,
			PRIME_AGENT_INTERNAL_DAEMON_WORKER: undefined,
			PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: undefined,
			PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: undefined,
			PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET: undefined,
			PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL: undefined,
			RLM_DEPTH: undefined,
			RLM_MAX_DEPTH: undefined,
			RLM_SESSION_DIR: undefined,
		},
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
	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			children.delete(child);
			resolveExit({ code, signal: signal as NodeJS.Signals | null });
		});
		const timeout = setTimeout(() => {
			rejectExit(new Error(`phase ${options.phase} CLI did not exit in time\n${stderr}`));
		}, 120_000);
	});
	return { child, stdout: () => stdout, stderr: () => stderr, exit };
}

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}
	children.clear();
	for (const [socketPath] of daemonSockets) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(500);
			await client.request({ type: "shutdown" }, 5000);
		} catch {
			// The daemon may already be down (the test shut it down itself).
		} finally {
			client.close();
		}
	}
	daemonSockets.clear();
	for (const root of tempRoots) {
		rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 50 });
	}
	tempRoots.clear();
}, 60_000);

describe.skipIf(process.platform === "win32")("W14-A EX-3 recovery chain", () => {
	it("SIGTERM (143) -> daemon shutdown envelope -> --resume continues the same session", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-w14a-ex3-"));
		tempRoots.add(root);
		const agentDir = join(root, "agent");
		const fixtureDir = join(root, "fixture");
		const sessionsDir = join(root, "sessions");
		mkdirSync(fixtureDir, { recursive: true });
		mkdirSync(sessionsDir, { recursive: true });
		const socketA = join(root, "d1.sock");
		const socketB = join(root, "d2.sock");
		daemonSockets.set(socketA, isolatedSupervisorRegistryEnv(agentDir)[SUPERVISOR_REGISTRY_DIR_ENV]!);
		daemonSockets.set(socketB, isolatedSupervisorRegistryEnv(agentDir)[SUPERVISOR_REGISTRY_DIR_ENV]!);
		const fakePython = join(root, "fake-python");
		writeFileSync(fakePython, FAKE_KERNEL, { mode: 0o700 });
		chmodSync(fakePython, 0o700);
		const token = `W14A-${Date.now().toString(36).toUpperCase().slice(-6).padStart(6, "0")}`;

		const baseArgs = (socketPath: string) => [
			"--mode",
			"json",
			"--daemon-socket",
			socketPath,
			"--cwd",
			fixtureDir,
			"--session-dir",
			sessionsDir,
			"--model",
			"faux/faux",
			"--extension",
			fauxExtensionPath,
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
		];

		// ---- phase A: run until phase-a.txt + first heartbeat, then SIGTERM ----
		const phaseA = spawnCli(
			[
				...baseArgs(socketA),
				"--",
				`Two-phase benchmark run, phase A. Phase A token: ${token}\n` +
					`1. Create phase-a.txt in the current directory holding exactly one line: ${token}\n` +
					"2. Then append one line per tick to heartbeat.log and keep ticking until interrupted.\n" +
					"3. When the loop has finished, reply with only: PHASE-A-DONE",
			],
			{ agentDir, fixtureDir, phase: "A", fakePython },
		);
		await waitFor(
			() =>
				existsSync(join(fixtureDir, "phase-a.txt")) &&
				readFileSync(join(fixtureDir, "phase-a.txt"), "utf8").includes(token) &&
				lineCount(join(fixtureDir, "heartbeat.log")) >= 1,
			120_000,
			() =>
				`phase A artifacts (alive=${phaseA.child.exitCode === null && phaseA.child.signalCode === null}, ` +
				`stderr: ${phaseA.stderr().slice(0, 2000)}, stdout: ${phaseA.stdout().slice(0, 2000)})`,
		);
		phaseA.child.kill("SIGTERM");
		const exitA = await phaseA.exit;
		// print-mode.ts maps SIGTERM to 143: proof the run was live at kill time.
		expect(exitA, `phase A stderr: ${phaseA.stderr()}`).toEqual({ code: 143, signal: null });

		// The CLI is gone; the detached daemon still owns the worker and kernel.
		// Stop it through the daemon shutdown envelope before snapshotting.
		await shutdownDaemon(socketA, daemonSockets.get(socketA)!);
		// The kernel dies with the daemon's teardown, a moment past the socket's
		// removal; the kill-point tick count is stable only once appends stop.
		// Samples sit 500ms apart, four heartbeat intervals, so a live loop
		// cannot read as stable.
		let ticksAtKill = lineCount(join(fixtureDir, "heartbeat.log"));
		{
			const deadline = Date.now() + 30_000;
			let stable = false;
			while (Date.now() < deadline) {
				await delay(500);
				const current = lineCount(join(fixtureDir, "heartbeat.log"));
				if (current === ticksAtKill) {
					stable = true;
					break;
				}
				ticksAtKill = current;
			}
			if (!stable) throw new Error("heartbeat.log kept growing after the daemon exited");
		}

		const phaseASha = sha256File(join(fixtureDir, "phase-a.txt"));
		expect(ticksAtKill).toBeGreaterThanOrEqual(1);
		const sessionFiles = readdirSync(sessionsDir).filter((name) => name.endsWith(".jsonl"));
		expect(sessionFiles).toHaveLength(1);
		const sessionFile = join(sessionsDir, sessionFiles[0]!);
		const sessionSizeAfterA = readFileSync(sessionFile, "utf8").length;

		// ---- phase B: resume the same session file ----
		const phaseB = spawnCli(
			[
				...baseArgs(socketB),
				"--resume",
				sessionFile,
				"--",
				"This is phase B of the same benchmark run; the session was interrupted and resumed. " +
					"Do NOT redo phase A work: phase-a.txt and heartbeat.log already exist from before the interruption. " +
					"Create phase-b.txt in the current directory with exactly two lines: " +
					"`token: <the exact token line that phase-a.txt already holds>` and " +
					"`heartbeat_ticks: <the number of lines heartbeat.log held when phase A was interrupted>`. " +
					"Then reply with only: PHASE-B-DONE",
			],
			{ agentDir, fixtureDir, phase: "B", fakePython },
		);
		const exitB = await phaseB.exit;
		expect(exitB, `phase B stderr: ${phaseB.stderr()}`).toEqual({ code: 0, signal: null });
		expect(phaseB.stdout()).toContain("PHASE-B-DONE");
		await shutdownDaemon(socketB, daemonSockets.get(socketB)!);

		// The resumed session recalled phase A state: exact token and the
		// kill-point heartbeat count, not a restarted loop.
		const phaseBText = readFileSync(join(fixtureDir, "phase-b.txt"), "utf8");
		expect(phaseBText).toMatch(new RegExp(`^token:\\s*${token}\\s*$`, "m"));
		expect(phaseBText).toMatch(new RegExp(`^heartbeat_ticks:\\s*${ticksAtKill}\\s*$`, "m"));
		// Phase A artifacts are untouched by the resume.
		expect(sha256File(join(fixtureDir, "phase-a.txt"))).toBe(phaseASha);
		expect(lineCount(join(fixtureDir, "heartbeat.log"))).toBe(ticksAtKill);
		// Resume continued the same session file instead of opening a new one.
		expect(readdirSync(sessionsDir).filter((name) => name.endsWith(".jsonl"))).toEqual(sessionFiles);
		expect(readFileSync(sessionFile, "utf8").length).toBeGreaterThan(sessionSizeAfterA);
	}, 300_000);
});
