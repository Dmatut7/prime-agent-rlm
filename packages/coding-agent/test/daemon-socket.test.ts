import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import {
	cleanupDaemonSocketPath,
	DaemonSocketPathLease,
	defaultDaemonSocketPath,
	getDaemonSocketIdentity,
	legacyDefaultDaemonSocketPath,
	normalizeSocketPath,
	prepareDaemonSocketPath,
} from "../src/modes/daemon/daemon-socket.js";
import { isWindowsNamedPipePath } from "../src/modes/daemon/windows-named-pipe.js";

describe("normalizeSocketPath", () => {
	it("normalizes equivalent Unix spellings", () => {
		if (process.platform === "win32") return;
		expect(normalizeSocketPath("/a//b.sock/")).toBe("/a/b.sock");
	});
});

describe("defaultDaemonSocketPath", () => {
	it("uses a per-user Windows named pipe path", () => {
		if (process.platform !== "win32") {
			return;
		}

		const socketPath = defaultDaemonSocketPath();
		expect(isWindowsNamedPipePath(socketPath)).toBe(true);
		expect(socketPath).toContain("prime-agent-S-");
	});

	it("uses a stable Unix socket directory outside $TMPDIR, overridable for tests", () => {
		if (process.platform === "win32") {
			return;
		}

		// The vitest run pins the directory so no test binds the developer's real
		// one; unset it to pin the shipped default.
		const previous = process.env.PRIME_AGENT_INTERNAL_DAEMON_SOCKET_DIR;
		delete process.env.PRIME_AGENT_INTERNAL_DAEMON_SOCKET_DIR;
		try {
			const socketPath = defaultDaemonSocketPath();
			const home = homedir();
			if (home && home !== "/") {
				// launchd shells, manual shells and TMPDIR-injecting tools each
				// resolve a different $TMPDIR root, which split supervisor
				// generations across sockets; the default must not depend on it.
				expect(dirname(socketPath)).toBe(join(home, ".prime", "daemon"));
			}
			expect(basename(socketPath)).toBe("daemon.sock");
			expect(dirname(socketPath)).not.toBe(join(tmpdir(), "prime-agent-501"));
		} finally {
			if (previous !== undefined) {
				process.env.PRIME_AGENT_INTERNAL_DAEMON_SOCKET_DIR = previous;
			}
		}
	});

	it("honors the internal socket-dir override (test isolation)", () => {
		if (process.platform === "win32") {
			return;
		}
		const previous = process.env.PRIME_AGENT_INTERNAL_DAEMON_SOCKET_DIR;
		process.env.PRIME_AGENT_INTERNAL_DAEMON_SOCKET_DIR = "/tmp/w2-override-dir";
		try {
			expect(defaultDaemonSocketPath()).toBe("/tmp/w2-override-dir/daemon.sock");
		} finally {
			if (previous === undefined) {
				delete process.env.PRIME_AGENT_INTERNAL_DAEMON_SOCKET_DIR;
			} else {
				process.env.PRIME_AGENT_INTERNAL_DAEMON_SOCKET_DIR = previous;
			}
		}
	});

	it("still exposes the legacy $TMPDIR socket path for discovery", () => {
		if (process.platform === "win32") {
			return;
		}

		const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
		expect(dirname(legacyDefaultDaemonSocketPath())).toBe(join(tmpdir(), `prime-agent-${suffix}`));
		expect(basename(legacyDefaultDaemonSocketPath())).toBe("daemon.sock");
	});

	it("checks a live daemon before acquiring the socket path lock", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-live-"));
		const socketPath = join(dir, "daemon.sock");
		let observedLock: boolean | undefined;
		const server = createServer((socket) => {
			observedLock = existsSync(`${socketPath}.lock`);
			socket.destroy();
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});

			await expect(prepareDaemonSocketPath(socketPath)).rejects.toThrow(/socket already in use/i);
			expect(observedLock).toBe(false);
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not wait on a stale lock when no socket path exists", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-stale-lock-"));
		const socketPath = join(dir, "daemon.sock");
		mkdirSync(`${socketPath}.lock`);
		let prepared = false;
		try {
			await Promise.race([
				prepareDaemonSocketPath(socketPath).then(() => {
					prepared = true;
				}),
				new Promise<void>((resolve) => setTimeout(resolve, 250)),
			]);
			expect(prepared).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not unlink a replacement daemon's socket during delayed cleanup", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-ownership-"));
		const socketPath = join(dir, "daemon.sock");
		const oldServer = createServer();
		const replacementServer = createServer();
		try {
			await new Promise<void>((resolve, reject) => {
				oldServer.once("error", reject);
				oldServer.listen(socketPath, resolve);
			});
			const oldIdentity = getDaemonSocketIdentity(socketPath);
			if (!oldIdentity) {
				throw new Error("Expected a Unix daemon socket identity");
			}

			unlinkSync(socketPath);
			await new Promise<void>((resolve, reject) => {
				replacementServer.once("error", reject);
				replacementServer.listen(socketPath, resolve);
			});

			cleanupDaemonSocketPath(socketPath, oldIdentity);

			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			await Promise.all(
				[oldServer, replacementServer].map(
					(server) =>
						new Promise<void>((resolve) => {
							server.close(() => resolve());
						}),
				),
			);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not unlink a socket while another daemon owns the path lock", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-lock-"));
		const socketPath = join(dir, "daemon.sock");
		const server = createServer();
		let releaseLock: (() => Promise<void>) | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			const identity = getDaemonSocketIdentity(socketPath);
			if (!identity) {
				throw new Error("Expected a Unix daemon socket identity");
			}
			releaseLock = await lockfile.lock(socketPath, { realpath: false });

			cleanupDaemonSocketPath(socketPath, identity);

			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			await releaseLock?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not remove a replacement socket that appears while stale cleanup is pending", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-startup-"));
		const socketPath = join(dir, "daemon.sock");
		const staleOwner = spawn(
			process.execPath,
			[
				"-e",
				"const { createServer } = require('node:net'); const server = createServer(); server.listen(process.argv[1], () => process.stdout.write('ready'));",
				socketPath,
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		const replacementServer = createServer();
		let replacementTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				staleOwner.stdout?.once("data", () => resolve());
				staleOwner.once("error", reject);
				staleOwner.once("exit", (code) => {
					if (code !== null && code !== 0) {
						reject(new Error(`Stale socket owner exited before listening: ${code}`));
					}
				});
			});
			staleOwner.kill("SIGKILL");
			await new Promise<void>((resolve) => staleOwner.once("close", () => resolve()));
			expect(existsSync(socketPath)).toBe(true);

			const replacementListening = new Promise<void>((resolve, reject) => {
				replacementTimer = setTimeout(() => {
					try {
						if (existsSync(socketPath)) {
							unlinkSync(socketPath);
						}
						replacementServer.once("error", reject);
						replacementServer.listen(socketPath, resolve);
					} catch (error) {
						reject(error);
					}
				}, 50);
			});

			await expect(prepareDaemonSocketPath(socketPath)).rejects.toThrow(
				/socket (already in use|changed ownership)/i,
			);
			await replacementListening;
			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			if (replacementTimer) {
				clearTimeout(replacementTimer);
			}
			if (staleOwner.exitCode === null && staleOwner.signalCode === null) {
				staleOwner.kill("SIGKILL");
			}
			if (replacementServer.listening) {
				await new Promise<void>((resolve) => replacementServer.close(() => resolve()));
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe.skipIf(process.platform === "win32")("DaemonSocketPathLease compromise hardening", () => {
	it("records compromise without rethrowing listener failures", () => {
		const lease = new DaemonSocketPathLease("/tmp/test.sock", () => Promise.resolve());
		const observed: Error[] = [];
		lease.onCompromised(() => {
			throw new Error("listener failed");
		});
		lease.onCompromised((error) => observed.push(error));

		expect(() => lease.recordCompromise(new Error("lock update failed"))).not.toThrow();
		expect(lease.compromise?.message).toBe("lock update failed");
		expect(observed).toHaveLength(1);
	});

	it("does not unlink a successor socket after the old lease is compromised", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-socket-compromise-"));
		const socketPath = join(dir, "daemon.sock");
		const server = createServer();
		try {
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));
			const identity = getDaemonSocketIdentity(socketPath);
			const lease = new DaemonSocketPathLease(socketPath, () => Promise.resolve());
			lease.recordCompromise(new Error("lock stolen"));

			cleanupDaemonSocketPath(socketPath, identity, lease);
			expect(existsSync(socketPath)).toBe(true);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
