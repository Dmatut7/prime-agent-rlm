import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { APP_NAME } from "../../src/config.js";
import { isDaemonCatalogProcess, runDaemonCatalogProcess } from "../../src/modes/daemon/daemon-catalog-process.js";
import { DaemonSupervisor } from "../../src/modes/daemon/daemon-supervisor.js";
import { acquireDaemonSupervisorOwnership } from "../../src/modes/daemon/daemon-supervisor-ownership.js";

type ControlMessage = { type: "go" | "probe" | "release" | "release_runtime" | "shutdown" | "cleanup" };

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing ${name}`);
	}
	return value;
}

function send(message: Record<string, unknown>): void {
	process.send?.(message);
}

function waitForControl(type: ControlMessage["type"]): Promise<void> {
	return new Promise((resolve) => {
		const onMessage = (message: unknown) => {
			if (!message || typeof message !== "object" || (message as Partial<ControlMessage>).type !== type) {
				return;
			}
			process.off("message", onMessage);
			resolve();
		};
		process.on("message", onMessage);
	});
}

async function runOwnershipHolder(): Promise<never> {
	const ownership = await acquireDaemonSupervisorOwnership({
		socketPath: requiredEnvironment("ENG_4600_SOCKET_PATH"),
		descriptorDir: requiredEnvironment("ENG_4600_DESCRIPTOR_DIR"),
		agentDir: requiredEnvironment("ENG_4600_AGENT_DIR"),
		generation: requiredEnvironment("ENG_4600_GENERATION"),
		appVersion: "test",
		registryDir: requiredEnvironment("ENG_4600_REGISTRY_DIR"),
	});
	send({ type: "ready", owner: ownership.record });
	await waitForControl("release");
	await ownership.release();
	send({ type: "owner_released" });
	await waitForControl("shutdown");
	process.exit(0);
}

/**
 * Arms a startup failure at a real post-bind step.
 *
 * The unwind phase of ENG-4600 needs `start()` to fail *after* the socket is
 * bound, so there is a live socket, lock and owner record to unwind. Its
 * original trigger - a malformed legacy cron store - was deliberately degraded
 * to best-effort (a corrupt legacy store must never keep the daemon from
 * starting), and every other post-bind step either cannot throw or is wrapped
 * in a catch. `seedAdoptingWorkerRosterRows` runs after `listen()` and is not
 * caught, so failing there reproduces the exact shape the unwind must survive.
 * The thrown message reports whether the socket was bound, so the test proves
 * the failure really was post-bind instead of trusting the call order.
 */
function armPostBindStartupFailure(socketPath: string): void {
	if (process.env.ENG_4600_FAIL_AFTER_BIND !== "1") {
		return;
	}
	const prototype: object = DaemonSupervisor.prototype;
	if (typeof Reflect.get(prototype, "seedAdoptingWorkerRosterRows") !== "function") {
		throw new Error("ENG-4600 post-bind injection point moved; update this fixture");
	}
	Reflect.set(prototype, "seedAdoptingWorkerRosterRows", () => {
		throw new Error(`ENG-4600 injected post-bind startup failure (socket bound: ${existsSync(socketPath)})`);
	});
}

async function runSupervisor(): Promise<never> {
	process.argv[1] = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
	process.title = APP_NAME;
	const socketPath = requiredEnvironment("ENG_4600_SOCKET_PATH");
	const agentDir = requiredEnvironment("ENG_4600_AGENT_DIR");
	const descriptorDir = requiredEnvironment("ENG_4600_DESCRIPTOR_DIR");
	const supervisor = new DaemonSupervisor(socketPath, {
		descriptorDir,
		defaultSessionConfig: {
			agentDir,
			cwd: agentDir,
			noContextFiles: true,
			noExtensions: true,
			noSkills: true,
			noTools: true,
		},
	});
	armPostBindStartupFailure(socketPath);
	try {
		await supervisor.start();
		send({ type: "ready" });
		process.on("message", (message: unknown) => {
			if (
				!message ||
				typeof message !== "object" ||
				(message as Partial<ControlMessage>).type !== "release_runtime"
			) {
				return;
			}
			void releaseSupervisorRuntime(supervisor);
		});
		return await new Promise<never>(() => {});
	} catch (error) {
		send({ type: "failed", error: error instanceof Error ? error.message : String(error) });
		process.exit(0);
	}
}

async function releaseSupervisorRuntime(supervisor: DaemonSupervisor): Promise<void> {
	const ownership = Reflect.get(supervisor, "ownership") as { release: () => Promise<void> } | undefined;
	await ownership?.release();
	Reflect.set(supervisor, "ownership", undefined);
	const cleanupSocket = Reflect.get(supervisor, "cleanupSocket");
	if (typeof cleanupSocket === "function") {
		Reflect.apply(cleanupSocket, supervisor, []);
	}
	const lease = Reflect.get(supervisor, "socketLease") as { release: () => Promise<void> } | undefined;
	await lease?.release();
	Reflect.set(supervisor, "socketLease", undefined);
	send({ type: "runtime_released" });
}

async function runLegacyCleanup(): Promise<never> {
	const socketPath = requiredEnvironment("ENG_4600_SOCKET_PATH");
	send({ type: "ready" });
	await waitForControl("cleanup");
	let skipped = false;
	// This lock/unlink sequence is frozen from the v0.3.0 daemon socket cleanup.
	if (process.platform !== "win32") {
		let releaseLock: (() => void) | undefined;
		try {
			releaseLock = lockfile.lockSync(socketPath, {
				realpath: false,
				stale: 5000,
				update: 1000,
				retries: 0,
			});
		} catch {
			skipped = true;
		}
		if (releaseLock) {
			try {
				if (existsSync(socketPath)) {
					unlinkSync(socketPath);
				}
			} finally {
				releaseLock();
			}
		}
	}
	send({ type: "cleanup_complete", skipped });
	process.exit(0);
}

async function main(): Promise<never> {
	if (isDaemonCatalogProcess()) {
		return runDaemonCatalogProcess();
	}
	send({ type: "booted" });
	process.on("message", (message: unknown) => {
		if (message && typeof message === "object" && (message as Partial<ControlMessage>).type === "probe") {
			send({ type: "probe_ack" });
		}
	});
	const mode = requiredEnvironment("ENG_4600_FIXTURE_MODE");
	if (mode === "legacy_cleanup") {
		return runLegacyCleanup();
	}
	await waitForControl("go");
	if (mode === "owner") {
		return runOwnershipHolder();
	}
	if (mode === "supervisor") {
		return runSupervisor();
	}
	throw new Error(`Unknown fixture mode: ${mode}`);
}

void main().catch((error) => {
	send({ type: "failed", error: error instanceof Error ? error.message : String(error) });
	process.exit(1);
});
