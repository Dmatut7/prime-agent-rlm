import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import {
	DaemonSocketPathLease,
	acquireDaemonSocketPathLease,
	DaemonSocketInUseError,
	defaultDaemonSocketPath,
	prepareDaemonSocketPath,
} from "../src/modes/daemon/daemon-socket.js";
import {
	DaemonSupervisorAlreadyRunningError,
} from "../src/modes/daemon/daemon-supervisor-ownership.js";
import {
	isDaemonSingleInstanceConflict,
	judgeDaemonSocketOccupancy,
	runDaemonStandby,
	type DaemonStandbyOwner,
} from "../src/modes/daemon/daemon-single-instance.js";
import { DaemonAgentDirAlreadyRunningError } from "../src/modes/daemon/daemon-supervisor-ownership.js";

const cleanup: string[] = [];

afterEach(() => {
	while (cleanup.length > 0) {
		const dir = cleanup.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("judgeDaemonSocketOccupancy (no-response determination)", () => {
	it("reports absent when no socket file exists", async () => {
		if (process.platform === "win32") return;
		const dir = mkdtempSync(join(tmpdir(), "w2-occ-"));
		cleanup.push(dir);
		const probe = await judgeDaemonSocketOccupancy(join(dir, "daemon.sock"), {
			connect: () => Promise.resolve(false),
		});
		expect(probe.kind).toBe("absent");
		expect(probe.connects).toBe(false);
	});

	it("reports listening when a connection succeeds, even without a hello", async () => {
		if (process.platform === "win32") return;
		const dir = mkdtempSync(join(tmpdir(), "w2-occ-live-"));
		cleanup.push(dir);
		const socketPath = join(dir, "daemon.sock");
		// A server that accepts but never sends hello: a booting daemon must
		// still count as present (never race a live daemon into a duplicate).
		const server = createServer((socket) => {
			// hold the socket open, send nothing
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		try {
			const probe = await judgeDaemonSocketOccupancy(socketPath);
			expect(probe.kind).toBe("listening");
			expect(probe.connects).toBe(true);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("reports unresponsive after consecutive failed probes on an existing file", async () => {
		if (process.platform === "win32") return;
		const dir = mkdtempSync(join(tmpdir(), "w2-occ-stale-"));
		cleanup.push(dir);
		const socketPath = join(dir, "daemon.sock");
		writeFileSync(socketPath, "stale"); // a socket file nothing listens on

		let attempts = 0;
		const probe = await judgeDaemonSocketOccupancy(socketPath, {
			connect: () => {
				attempts++;
				return Promise.resolve(false);
			},
			sleep: () => Promise.resolve(),
		});
		expect(probe.kind).toBe("unresponsive");
		expect(probe.connects).toBe(false);
		expect(attempts).toBe(3);
	});

	it("flips to listening mid-probe sequence when the daemon boots", async () => {
		if (process.platform === "win32") return;
		const dir = mkdtempSync(join(tmpdir(), "w2-occ-boot-"));
		cleanup.push(dir);
		const socketPath = join(dir, "daemon.sock");
		writeFileSync(socketPath, "stale");
		let calls = 0;
		const probe = await judgeDaemonSocketOccupancy(socketPath, {
			connect: () => {
				calls++;
				return Promise.resolve(calls >= 2);
			},
			sleep: () => Promise.resolve(),
		});
		expect(probe.kind).toBe("listening");
		expect(probe.connects).toBe(true);
	});
});

describe("isDaemonSingleInstanceConflict (downgrade classification)", () => {
	it("classifies the three single-instance conflicts as downgrade", () => {
		expect(isDaemonSingleInstanceConflict(new DaemonSocketInUseError("/tmp/w2.sock"))).toBe(true);
		const owner = {
			version: 1 as const,
			role: "supervisor" as const,
			token: "t",
			generation: "g",
			socketPath: "/tmp/w2.sock",
			descriptorDir: "/tmp/w2-workers",
			agentDir: "/tmp/w2-agent",
			appVersion: "test",
			phase: "running" as const,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			pid: 123,
			processStartId: "s",
		};
		expect(isDaemonSingleInstanceConflict(new DaemonSupervisorAlreadyRunningError(owner))).toBe(true);
		const summary = {
			generation: "g",
			pid: 123,
			socketPath: "/tmp/w2.sock",
			agentDir: "/tmp/w2-agent",
			phase: "running" as const,
			createdAt: new Date().toISOString(),
		};
		expect(isDaemonSingleInstanceConflict(new DaemonAgentDirAlreadyRunningError(summary, "/tmp/w2-agent"))).toBe(true);
	});

	it("propagates ordinary failures", () => {
		expect(isDaemonSingleInstanceConflict(new Error("disk on fire"))).toBe(false);
		expect(isDaemonSingleInstanceConflict(undefined)).toBe(false);
	});
});

describe("stale socket takeover (atomic takeover of an unresponsive socket)", () => {
	it("prepares an unresponsive socket file for rebinding under the lease", async () => {
		if (process.platform === "win32") return;
		const dir = mkdtempSync(join(tmpdir(), "w2-takeover-"));
		cleanup.push(dir);
		const socketPath = join(dir, "daemon.sock");
		// A real socket file nothing listens on (the SIGKILLed-daemon shape):
		// a child binds it, we SIGKILL the child, the file survives.
		const staleOwner = spawn(
			process.execPath,
			[
				"-e",
				"const { createServer } = require('node:net'); const server = createServer(); server.listen(process.argv[1], () => process.stdout.write('ready'));",
				socketPath,
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		await new Promise<void>((resolve, reject) => {
			staleOwner.stdout?.once("data", () => resolve());
			staleOwner.once("error", reject);
		});
		staleOwner.kill("SIGKILL");
		await new Promise<void>((resolve) => staleOwner.once("close", () => resolve()));
		expect(existsSync(socketPath)).toBe(true);

		const lease = await acquireDaemonSocketPathLease(socketPath);
		try {
			await prepareDaemonSocketPath(socketPath, lease);
			// The stale file was unlinked (identity-checked, lease-held).
			expect(existsSync(socketPath)).toBe(false);
		} finally {
			await lease?.release();
		}
	});

	it("refuses takeover while the socket still accepts connections", async () => {
		if (process.platform === "win32") return;
		const dir = mkdtempSync(join(tmpdir(), "w2-takeover-live-"));
		cleanup.push(dir);
		const socketPath = join(dir, "daemon.sock");
		const server = createServer((socket) => {
			socket.destroy();
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		try {
			await expect(prepareDaemonSocketPath(socketPath)).rejects.toThrow(DaemonSocketInUseError);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

describe("concurrent bind: two racers, exactly one listener", () => {
	it("binds exactly one server when two race for the same socket path", async () => {
		if (process.platform === "win32") return;
		const dir = mkdtempSync(join(tmpdir(), "w2-bindrace-"));
		cleanup.push(dir);
		const socketPath = join(dir, "daemon.sock");
		const servers = [createServer(() => {}), createServer(() => {})];
		const outcomes = await Promise.all(
			servers.map(
				(server) =>
					new Promise<"listening" | "error">((resolveOutcome) => {
						server.once("error", () => resolveOutcome("error"));
						server.listen(socketPath, () => resolveOutcome("listening"));
					}),
			),
		);
		expect(outcomes.filter((outcome) => outcome === "listening")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome === "error")).toHaveLength(1);
		for (const server of servers) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("holds the socket path lease exclusively and hands it over on release", async () => {
		if (process.platform === "win32") return;
		const dir = mkdtempSync(join(tmpdir(), "w2-leaserace-"));
		cleanup.push(dir);
		const socketPath = join(dir, "daemon.sock");

		const holder = await acquireDaemonSocketPathLease(socketPath);
		expect(holder).toBeDefined();
		const contender = acquireDaemonSocketPathLease(socketPath);
		// While the holder keeps the lease the contender waits (it must not bind).
		const waiting = await Promise.race([
			contender.then(
				() => "granted",
				() => "rejected",
			),
			new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 400)),
		]);
		expect(waiting).toBe("waiting");

		// Release hands the path over: the contender becomes the new holder.
		await holder?.release();
		const granted = await contender;
		expect(granted).toBeDefined();
		await granted?.release();
		expect(lockfile.checkSync(socketPath, { realpath: false, lockfilePath: `${socketPath}.lock` })).toBe(false);
	});
});

describe("runDaemonStandby (downgrade to client watcher)", () => {
	it("exits for relaunch only after the owner pid dies and the socket goes silent", async () => {
		if (process.platform === "win32") return;
		let polls = 0;
		const owners: DaemonStandbyOwner[] = [{ socketPath: "/tmp/w2.sock", pid: 42, generation: "g1" }];
		const listening: string[] = [];
		const logs: string[] = [];
		const gone: string[] = [];
		await runDaemonStandby({
			socketPath: "/tmp/w2.sock",
			owner: owners[0],
			pollMs: 1,
			sleep: () => {
				polls++;
				return Promise.resolve();
			},
			readOwners: () => owners,
			isProcessAlive: () => polls < 3,
			isSocketListening: (p) => {
				listening.push(p);
				return Promise.resolve(polls < 3);
			},
			log: (message) => logs.push(message),
			onOwnerGone: () => gone.push("gone"),
		});
		// polls 1 (pid alive) and 2 (pid alive) keep waiting; poll 3: pid dead
		// and socket silent -> onOwnerGone. The socket check at poll 2 (pid
		// alive) short-circuits, so only the silent polls reach it.
		expect(polls).toBe(3);
		expect(gone).toEqual(["gone"]);
		expect(logs.some((line) => /standing by/.test(line))).toBe(true);
		expect(logs.some((line) => /gone/.test(line))).toBe(true);
	});

	it("keeps waiting while the pid is dead but the socket still accepts (bound-but-recordless daemon)", async () => {
		if (process.platform === "win32") return;
		const owners: DaemonStandbyOwner[] = [{ socketPath: "/tmp/w2.sock", pid: 42 }];
		let socketChecks = 0;
		await runDaemonStandby({
			socketPath: "/tmp/w2.sock",
			owner: owners[0],
			pollMs: 1,
			maxPolls: 4,
			sleep: () => Promise.resolve(),
			readOwners: () => owners,
			isProcessAlive: () => false,
			isSocketListening: () => {
				socketChecks++;
				return Promise.resolve(true);
			},
			onOwnerGone: () => {
				throw new Error("must not exit while the socket accepts");
			},
		});
		// Every bounded poll re-checked the socket and never called onOwnerGone.
		expect(socketChecks).toBe(4);
	});

	it("watches the socket itself when no owner record exists at all", async () => {
		if (process.platform === "win32") return;
		let socketChecks = 0;
		const gone: string[] = [];
		await runDaemonStandby({
			socketPath: "/tmp/w2.sock",
			pollMs: 1,
			sleep: () => Promise.resolve(),
			readOwners: () => [],
			isProcessAlive: () => {
				throw new Error("no pid should be checked");
			},
			isSocketListening: () => {
				socketChecks++;
				return Promise.resolve(socketChecks < 2);
			},
			onOwnerGone: () => gone.push("gone"),
		});
		expect(gone).toEqual(["gone"]);
	});
});
