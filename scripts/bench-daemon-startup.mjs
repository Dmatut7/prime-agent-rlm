#!/usr/bin/env node
/**
 * Measures daemon cold-start latency: spawn `--mode daemon` and poll the unix
 * socket until it accepts a connection. This is the readiness gate every
 * interactive cold start waits on.
 *
 * Each run gets an isolated PRIME_AGENT_CODING_AGENT_DIR so the benchmark
 * daemon never touches the real agent dir (logs, session catalog) or shakes
 * hands with a daemon already running on the default socket.
 *
 *   node scripts/bench-daemon-startup.mjs [--runs N]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const entrypoint = join(repoRoot, "packages", "coding-agent", "dist", "bundle", "cli.js");
const runsIndex = process.argv.indexOf("--runs");
const runs = Number(runsIndex !== -1 ? process.argv[runsIndex + 1] : 3) || 3;

if (!existsSync(entrypoint)) {
	console.error(`CLI entrypoint not found: ${entrypoint} (run npm run build first)`);
	process.exit(1);
}

function tryConnect(socketPath) {
	return new Promise((resolve) => {
		const socket = connect(socketPath);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

function killTree(child, signal) {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Already gone.
		}
	}
}

function waitForExit(child, timeoutMs) {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

async function measureOnce(i) {
	const dir = mkdtempSync(join(tmpdir(), "prime-daemon-bench-"));
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	const socketPath = join(dir, "daemon.sock");
	const start = performance.now();
	const child = spawn(process.execPath, [entrypoint, "--mode", "daemon", "--daemon-socket", socketPath], {
		stdio: "ignore",
		detached: true, // own process group so teardown reaches the whole tree
		env: { ...process.env, PRIME_AGENT_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
	});
	try {
		let ready;
		const deadline = performance.now() + 30000;
		for (;;) {
			if (await tryConnect(socketPath)) {
				ready = performance.now() - start;
				break;
			}
			if (performance.now() > deadline) {
				ready = Number.NaN;
				break;
			}
			await new Promise((r) => setTimeout(r, 5));
		}
		console.log(`run ${i + 1}: socket ready in ${ready.toFixed(0)} ms`);
		return ready;
	} finally {
		// No sessions exist here, so SIGTERM shuts an idle daemon down; escalate
		// only if it ignores the signal, and never leave the dir behind.
		killTree(child, "SIGTERM");
		if (!(await waitForExit(child, 10000))) {
			killTree(child, "SIGKILL");
			await waitForExit(child, 5000);
		}
		rmSync(dir, { recursive: true, force: true });
	}
}

const results = [];
for (let i = 0; i < runs; i++) {
	results.push(await measureOnce(i));
}
const valid = results.filter((r) => !Number.isNaN(r));
console.log(`\nmean: ${(valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(0)} ms over ${valid.length} runs`);
