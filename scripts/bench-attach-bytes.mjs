#!/usr/bin/env node
/**
 * Measures attach payload bytes and latency for legacy vs first-party slim
 * clients against a daemon session loaded from a given session file. Uses an
 * isolated agent dir (and an isolated TMPDIR, which is where worker sockets
 * live) so no test sessions or sockets leak into the shared locations.
 *
 * The daemon requires protocol v7 command envelopes; bare commands are
 * rejected with "Daemon commands require protocol 7 or newer".
 *
 *   node scripts/bench-attach-bytes.mjs <session.jsonl>
 *
 * env: ATTACH_RUNS (default 5)
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const entrypoint = join(repoRoot, "packages", "coding-agent", "dist", "cli.js");
const sourceSession = process.argv[2];
if (!sourceSession) {
	console.error("usage: bench-attach-bytes.mjs <session.jsonl>");
	process.exit(1);
}
if (!existsSync(entrypoint)) {
	console.error(`CLI entrypoint not found: ${entrypoint} (run npm run build first)`);
	process.exit(1);
}
const RUNS = Number(process.env.ATTACH_RUNS ?? 5) || 5;

const base = mkdtempSync(join(tmpdir(), "prime-attach-bench-"));
const agentDir = join(base, "agent");
mkdirSync(agentDir, { recursive: true });
const socketPath = join(base, "daemon.sock");
const sessionPath = join(base, basename(sourceSession));
copyFileSync(sourceSession, sessionPath);

const PROTOCOL = { name: "prime-agent.daemon", version: 7 };
const envelope = (id, command) => `${JSON.stringify({ type: "command", id, protocol: PROTOCOL, command })}\n`;

// The real client's attach capability set (daemon-agent-connection.ts). The
// transcript slimming lives in rev-44 "slim_attach_transcript"; a set without
// it measures a -0.0% "reduction" that no real client sees.
const SLIM_CAPABILITIES = [
	"attach_snapshot",
	"event_sequence",
	"extension_ui",
	"slim_attach",
	"chunked_snapshot",
	"streaming_deltas",
	"streaming_delta_fragments",
	"quota_park_status",
	"slim_attach_transcript",
];

const daemon = spawn(process.execPath, [entrypoint, "--mode", "daemon", "--daemon-socket", socketPath], {
	stdio: "ignore",
	detached: true, // own process group so teardown can kill the whole tree
	env: {
		...process.env,
		PRIME_AGENT_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
	},
});

function killDaemonTree(signal) {
	try {
		process.kill(-daemon.pid, signal);
	} catch {
		try {
			daemon.kill(signal);
		} catch {
			// Already gone.
		}
	}
}

function waitForDaemonExit(timeoutMs) {
	if (daemon.exitCode !== null || daemon.signalCode !== null) {
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		daemon.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

/** Ask the daemon to shut down over the wire; resolves false when unreachable. */
function requestDaemonShutdown() {
	return new Promise((resolve) => {
		connectWhenReady(2000).then(
			(socket) => {
				let buffer = "";
				const finish = (ok) => {
					socket.destroy();
					resolve(ok);
				};
				const timer = setTimeout(() => finish(false), 5000);
				socket.on("data", (chunk) => {
					buffer += chunk.toString("utf8");
					let idx = buffer.indexOf("\n");
					while (idx !== -1) {
						const line = buffer.slice(0, idx);
						buffer = buffer.slice(idx + 1);
						idx = buffer.indexOf("\n");
						let msg;
						try {
							msg = JSON.parse(line);
						} catch {
							continue;
						}
						if (msg.type === "daemon_hello") {
							socket.write(envelope("s1", { type: "shutdown" }));
						} else if (msg.type === "response" && msg.id === "s1") {
							clearTimeout(timer);
							finish(msg.success === true);
							return;
						}
					}
				});
				socket.once("error", () => {
					clearTimeout(timer);
					finish(false);
				});
			},
			() => resolve(false),
		);
	});
}

function connectWhenReady(deadlineMs = 30000) {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + deadlineMs;
		const tryOnce = () => {
			const socket = connect(socketPath);
			socket.once("connect", () => resolve(socket));
			socket.once("error", () => {
				if (Date.now() > deadline) reject(new Error("daemon did not start"));
				else setTimeout(tryOnce, 50);
			});
		};
		tryOnce();
	});
}

/** One measured exchange on a fresh connection: send commands after daemon_hello, resolve at the attach response. */
function measure(name, commands, isDone) {
	return new Promise((resolve, reject) => {
		const t0 = performance.now();
		let helloAt;
		connectWhenReady().then((socket) => {
			let bytes = 0;
			let buffer = "";
			const t = setTimeout(() => {
				socket.destroy();
				reject(new Error(`${name}: timeout`));
			}, 60000);
			socket.on("data", (chunk) => {
				bytes += chunk.length;
				buffer += chunk.toString("utf8");
				let idx = buffer.indexOf("\n");
				while (idx !== -1) {
					const line = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 1);
					idx = buffer.indexOf("\n");
					let msg;
					try {
						msg = JSON.parse(line);
					} catch {
						// non-JSON noise on the stream; skip the line
						continue;
					}
					if (msg.type === "daemon_hello" && helloAt === undefined) {
						helloAt = performance.now();
						for (const cmd of commands) socket.write(cmd);
						continue;
					}
					let done;
					try {
						done = isDone(msg);
					} catch (error) {
						clearTimeout(t);
						socket.destroy();
						reject(error);
						return;
					}
					if (done) {
						clearTimeout(t);
						const end = performance.now();
						socket.destroy();
						resolve({ bytes, totalMs: end - t0, afterHelloMs: end - helloAt });
						return;
					}
				}
			});
		}, reject);
	});
}

const stats = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return {
		min: s[0],
		median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2,
		max: s[s.length - 1],
	};
};

let cleanupPromise;
function cleanup() {
	// One shared teardown: a signal-driven cleanup must still finish when the
	// main flow errors out underneath it (both callers await the same promise).
	cleanupPromise ??= (async () => {
		// SIGTERM only detaches the daemon from its session workers — workers run
		// in their own sessions and are designed to survive the daemon for
		// re-adoption (one was observed respawning a daemon on this socket). The
		// shutdown command is the only path that stops workers (stopWorkers=true),
		// and undeclared connections like this one are exempt from the
		// control_plane capability gate.
		await requestDaemonShutdown();
		if (!(await waitForDaemonExit(15000))) {
			killDaemonTree("SIGTERM");
			if (!(await waitForDaemonExit(5000))) {
				killDaemonTree("SIGKILL");
				await waitForDaemonExit(5000);
			}
		}
		rmSync(base, { recursive: true, force: true });
	})();
	return cleanupPromise;
}

// Ctrl-C mid-run must not leak the daemon either.
process.on("SIGINT", () => {
	void cleanup().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
	void cleanup().finally(() => process.exit(143));
});

try {
	// Open the session in the daemon once.
	let activeSessionId;
	await measure(
		"create",
		[envelope("c1", { type: "create", sessionPath })],
		(msg) => {
			if (msg.type === "response" && msg.id === "c1") {
				if (!msg.success) throw new Error(`create failed: ${msg.error}`);
				activeSessionId = msg.data.activeSessionId ?? msg.data.id;
				return true;
			}
			return false;
		},
	);
	console.log(`session loaded: ${activeSessionId}`);

	const attachRun = (capabilities) =>
		measure(
			"attach",
			[
				envelope("a1", {
					type: "attach",
					activeSessionId,
					...(capabilities ? { capabilities } : {}),
				}),
			],
			(msg) => {
				if (msg.type === "response" && msg.id === "a1") {
					if (!msg.success) throw new Error(`attach failed: ${msg.error}`);
					return true;
				}
				return false;
			},
		);

	const legacy = [];
	const slim = [];
	for (let i = 0; i < RUNS; i++) legacy.push(await attachRun(undefined));
	for (let i = 0; i < RUNS; i++) slim.push(await attachRun(SLIM_CAPABILITIES));

	const legacyBytes = stats(legacy.map((r) => r.bytes));
	const slimBytes = stats(slim.map((r) => r.bytes));
	const legacyLatency = stats(legacy.map((r) => r.afterHelloMs));
	const slimLatency = stats(slim.map((r) => r.afterHelloMs));

	console.log(
		`legacy attach: bytes median=${legacyBytes.median.toLocaleString()} (min ${legacyBytes.min.toLocaleString()}, max ${legacyBytes.max.toLocaleString()}) | post-hello median=${legacyLatency.median.toFixed(1)}ms`,
	);
	console.log(
		`slim attach:   bytes median=${slimBytes.median.toLocaleString()} (min ${slimBytes.min.toLocaleString()}, max ${slimBytes.max.toLocaleString()}) | post-hello median=${slimLatency.median.toFixed(1)}ms`,
	);
	console.log(`reduction:     ${(100 * (1 - slimBytes.median / legacyBytes.median)).toFixed(1)}%`);
} finally {
	await cleanup();
}
