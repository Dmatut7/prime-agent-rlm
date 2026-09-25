import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { getProcessStartId } from "../src/core/session-lease.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import {
	acquireDaemonShutdownAdmission,
	acquireDaemonSupervisorOwnership,
	assertDaemonSupervisorOwnerCurrent,
	legacyDaemonSupervisorRegistryDir,
	persistDaemonStartupFenceFromOwner,
	waitForDaemonStartupFence,
} from "../src/modes/daemon/daemon-supervisor-ownership.js";
import { legacyDaemonSocketDir } from "../src/modes/daemon/daemon-socket.js";

type Ownership = Awaited<ReturnType<typeof acquireDaemonSupervisorOwnership>>;

interface OwnerRecord {
	token: string;
	generation: string;
	updatedAt: string;
	[key: string]: unknown;
}

const registryDirEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const previousRegistryDirEnv = process.env[registryDirEnv];
const cleanupDirs: string[] = [];

afterEach(() => {
	if (previousRegistryDirEnv === undefined) {
		delete process.env[registryDirEnv];
	} else {
		process.env[registryDirEnv] = previousRegistryDirEnv;
	}
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function createPaths(): {
	root: string;
	registryDir: string;
	socketPath: string;
	agentDir: string;
	descriptorDir: string;
} {
	const root = mkdtempSync(join(tmpdir(), "ownership-registry-"));
	cleanupDirs.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	return {
		root,
		registryDir: join(root, "registry"),
		socketPath: join(root, "daemon.sock"),
		agentDir,
		descriptorDir: join(root, "workers"),
	};
}

async function acquire(paths: ReturnType<typeof createPaths>, generation = "registry-owner"): Promise<Ownership> {
	return acquireDaemonSupervisorOwnership({
		agentDir: paths.agentDir,
		appVersion: "test",
		descriptorDir: paths.descriptorDir,
		generation,
		registryDir: paths.registryDir,
		socketPath: paths.socketPath,
	});
}

function ownerDir(paths: ReturnType<typeof createPaths>, generation: string): string {
	return join(paths.registryDir, `${generation}.owner`);
}

function readJson(path: string): OwnerRecord {
	return JSON.parse(readFileSync(path, "utf8")) as OwnerRecord;
}

/**
 * Writes an owner record into the registry without going through acquisition, so a
 * test can describe an owner this process would never legitimately be: dead, or live
 * on another socket.
 */
function plantOwner(
	paths: ReturnType<typeof createPaths>,
	shape: OwnerRecord,
	generation: string,
	pid: number,
	overrides: { socketPath: string; descriptorDir: string; agentDir: string; phase?: string },
): string {
	const directory = join(paths.registryDir, `${generation}.owner`);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const processStartId = getProcessStartId(pid);
	writeFileSync(
		join(directory, "owner.json"),
		`${JSON.stringify(
			{
				...shape,
				token: randomUUID(),
				generation,
				pid,
				...(processStartId ? { processStartId } : {}),
				...overrides,
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
	return directory;
}

describe("daemon supervisor ownership registry reclamation", () => {
	it("pins the legacy registry fallback to the pre-stable $TMPDIR socket dir", () => {
		if (process.platform === "win32") {
			return;
		}
		// The vitest env pins the registry override, so the fallback must be
		// inspected with a clean environment. The stable-path move must not
		// redirect this read-only fallback into the new socket directory:
		// pre-move daemons registered next to their legacy socket.
		expect(legacyDaemonSupervisorRegistryDir({} as NodeJS.ProcessEnv)).toBe(
			join(legacyDaemonSocketDir(), "supervisor-owners"),
		);
	});

	it("reclaims a dead owner that never conflicted and keeps a live one", async () => {
		const paths = createPaths();
		// A valid record to copy the shape from; released, so it does not conflict.
		const template = await acquire(paths, "template-owner");
		const shape = { ...template.record };
		await template.release();

		const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		expect(dead.pid).toBeTypeOf("number");
		// Socket path, descriptor directory and agent dir all differ from the acquisition
		// below: this owner could never be reached by conflict.
		const deadDirectory = plantOwner(paths, shape, "dead-other-owner", dead.pid as number, {
			socketPath: join(paths.root, "other-dead.sock"),
			descriptorDir: join(paths.root, "other-workers-dead"),
			agentDir: join(paths.root, "other-agent-dead"),
		});
		// A live owner still has its world: its agent dir and descriptor dir exist and its
		// socket file is on disk. Only a footprint that was deleted under the record (see
		// the abandoned-footprint test) makes a live pid reclaimable.
		const liveAgentDir = join(paths.root, "other-agent-live");
		const liveDescriptorDir = join(paths.root, "other-workers-live");
		const liveSocketPath = join(paths.root, "other-live.sock");
		mkdirSync(liveAgentDir, { recursive: true });
		mkdirSync(liveDescriptorDir, { recursive: true });
		writeFileSync(liveSocketPath, "");
		const liveDirectory = plantOwner(paths, shape, "live-other-owner", process.pid, {
			socketPath: liveSocketPath,
			descriptorDir: liveDescriptorDir,
			agentDir: liveAgentDir,
			phase: "owner",
		});

		const acquired = await acquire(paths, "reclaiming-owner");

		// RED before the fix: reclamation was keyed on a conflict, so a dead owner
		// recorded for another socket stayed in the global registry forever and every
		// later acquire paid a full-table read for it.
		expect(existsSync(deadDirectory)).toBe(false);
		expect(existsSync(liveDirectory)).toBe(true);
		expect(existsSync(ownerDir(paths, "reclaiming-owner"))).toBe(true);
		expect(readdirSync(paths.registryDir).some((name) => name.startsWith("dead-other-owner.owner.stale-"))).toBe(
			false,
		);

		await acquired.release();
		rmSync(liveDirectory, { recursive: true, force: true });
	});

	it("reclaims a live owner whose whole footprint was deleted", async () => {
		const paths = createPaths();
		const template = await acquire(paths, "template-owner");
		await template.updatePhase("owner");
		const shape = { ...template.record };
		await template.release();

		// REG-1: the shape a leaked test daemon leaves behind. Its agent dir, socket and
		// descriptor dir all lived under one temp root that is now gone, while the recorded
		// pid is still alive — the leaked daemon itself, or a recycled pid. kill(0) alone
		// said "alive", so the record survived every later acquire and the startup gate kept
		// reasoning about a supervisor that cannot exist.
		const standIn = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
		const standInPid = standIn.pid;
		if (standInPid === undefined) throw new Error("Stand-in process did not report a pid");
		const abandonedRoot = mkdtempSync(join(tmpdir(), "ownership-abandoned-"));
		cleanupDirs.push(abandonedRoot);
		const abandonedDirectory = plantOwner(paths, shape, "abandoned-owner", standInPid, {
			socketPath: join(abandonedRoot, "daemon.sock"),
			descriptorDir: join(abandonedRoot, "workers"),
			agentDir: join(abandonedRoot, "agent"),
			phase: "owner",
		});
		rmSync(abandonedRoot, { recursive: true, force: true });

		const acquired = await acquire(paths, "after-abandoned-owner");

		expect(existsSync(abandonedDirectory)).toBe(false);
		expect(existsSync(ownerDir(paths, "after-abandoned-owner"))).toBe(true);
		await acquired.release();
		standIn.kill("SIGKILL");
	});

	it("still refuses by agent dir for a live owner whose world exists", async () => {
		const paths = createPaths();
		const template = await acquire(paths, "template-owner");
		await template.updatePhase("owner");
		const shape = { ...template.record };
		await template.release();

		// The same leaked shape, but with its footprint intact: a live owner of another
		// agent dir is neither reclaimed nor allowed to start a second daemon for that dir.
		const otherAgentDir = join(paths.root, "other-agent-live");
		const otherDescriptorDir = join(paths.root, "other-workers-live");
		const otherSocketPath = join(paths.root, "other-live.sock");
		mkdirSync(otherAgentDir, { recursive: true });
		mkdirSync(otherDescriptorDir, { recursive: true });
		writeFileSync(otherSocketPath, "");
		const liveDirectory = plantOwner(paths, shape, "live-other-owner", process.pid, {
			socketPath: otherSocketPath,
			descriptorDir: otherDescriptorDir,
			// The gate compares canonical agent dirs; a planted record must name the same one.
			agentDir: realpathSync(otherAgentDir),
			phase: "owner",
		});

		await expect(
			acquireDaemonSupervisorOwnership({
				agentDir: otherAgentDir,
				appVersion: "test",
				descriptorDir: join(paths.root, "conflicting-workers"),
				generation: "conflicting-owner",
				registryDir: paths.registryDir,
				socketPath: join(paths.root, "conflicting.sock"),
			}),
		).rejects.toThrow(/already owns agent dir/);
		expect(existsSync(liveDirectory)).toBe(true);
		expect(existsSync(ownerDir(paths, "conflicting-owner"))).toBe(false);
		rmSync(liveDirectory, { recursive: true, force: true });
	});

	it("refuses a live daemon that holds the same agent dir on another socket", async () => {
		const paths = createPaths();
		const template = await acquire(paths, "template-owner");
		const shape = { ...template.record };
		await template.release();

		// The daemon identity is the agent dir, not the socket: a shell with a different
		// $TMPDIR reaches a different socket path for the same sessions, harness state and
		// leases, so this owner must block the second daemon rather than be sidestepped.
		const liveDirectory = plantOwner(paths, shape, "live-same-agent-dir", process.pid, {
			socketPath: join(paths.root, "other-live.sock"),
			descriptorDir: join(paths.root, "other-workers-live"),
			agentDir: shape.agentDir as string,
		});

		await expect(acquire(paths, "second-owner")).rejects.toThrow(/already owns agent dir/);
		expect(existsSync(liveDirectory)).toBe(true);
		expect(existsSync(ownerDir(paths, "second-owner"))).toBe(false);
		rmSync(liveDirectory, { recursive: true, force: true });
	});

	it("quarantines an unreadable startup fence instead of failing every later start", async () => {
		const paths = createPaths();
		const owner = await acquire(paths, "fenced-owner");
		const record = owner.record;
		await persistDaemonStartupFenceFromOwner(
			paths.socketPath,
			{
				supervisorGeneration: record.generation,
				supervisorOwnerToken: record.token,
				supervisorPid: record.pid,
				supervisorProcessStartId: record.processStartId,
				supervisorSocketPath: record.socketPath,
			},
			paths.registryDir,
		);
		const fenceDirectory = join(paths.registryDir, "startup-fences");
		const fences = readdirSync(fenceDirectory).filter((name) => name.endsWith(".json"));
		expect(fences).toHaveLength(1);
		const fencePath = join(fenceDirectory, fences[0]!);
		// A machine crash mid-write: the name is there, the JSON is not.
		writeFileSync(fencePath, '{"version":1,"ownerTo');

		// RED before the fix: this threw "Invalid daemon startup fence", and since the
		// only clearer needs a supervisor that can start, that socket was dead for good.
		await expect(waitForDaemonStartupFence(paths.socketPath, 2_000, paths.registryDir)).resolves.toBeUndefined();

		const after = readdirSync(fenceDirectory);
		expect(after.some((name) => name.endsWith(".json"))).toBe(false);
		expect(after.filter((name) => name.includes(".corrupt-"))).toHaveLength(1);
		// The bytes are kept for whoever investigates.
		expect(readFileSync(join(fenceDirectory, after.find((name) => name.includes(".corrupt-"))!), "utf8")).toContain(
			"ownerTo",
		);

		await owner.release();
	});
});

describe("daemon supervisor ownership registry", () => {
	it("finds a live pre-move owner through the legacy registry when persisting a fence", async () => {
		const paths = createPaths();
		const legacyDir = join(paths.root, "legacy-registry");
		const legacyOwner = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "legacy-owner",
			registryDir: legacyDir,
			socketPath: paths.socketPath,
		});
		const record = legacyOwner.record;
		expect(record.processStartId).toBeDefined();
		const hello = {
			supervisorGeneration: record.generation,
			supervisorOwnerToken: record.token,
			supervisorPid: record.pid,
			supervisorProcessStartId: record.processStartId,
			supervisorSocketPath: record.socketPath,
		};
		const legacyOwnerPath = join(legacyDir, "legacy-owner.owner", "owner.json");
		const legacyBytes = readFileSync(legacyOwnerPath, "utf8");

		await persistDaemonStartupFenceFromOwner(paths.socketPath, hello, paths.registryDir, legacyDir);

		expect(readdirSync(join(paths.registryDir, "startup-fences"))).toHaveLength(1);
		expect(readFileSync(legacyOwnerPath, "utf8")).toBe(legacyBytes);

		await expect(persistDaemonStartupFenceFromOwner(paths.socketPath, hello, paths.registryDir)).rejects.toThrow(
			/does not match/,
		);
		await legacyOwner.release();
	});

	it("validates a pre-move owner claim through the legacy registry", async () => {
		const paths = createPaths();
		const legacyDir = join(paths.root, "legacy-registry");
		const legacyOwner = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "legacy-claim-owner",
			registryDir: legacyDir,
			socketPath: paths.socketPath,
		});
		const identity = {
			generation: legacyOwner.record.generation,
			pid: legacyOwner.record.pid,
			...(legacyOwner.record.processStartId ? { processStartId: legacyOwner.record.processStartId } : {}),
			socketPath: legacyOwner.record.socketPath,
		};
		mkdirSync(paths.registryDir, { recursive: true });

		await expect(
			assertDaemonSupervisorOwnerCurrent(identity, undefined, paths.registryDir, legacyDir),
		).resolves.toEqual(expect.any(String));

		await expect(assertDaemonSupervisorOwnerCurrent(identity, undefined, paths.registryDir)).rejects.toMatchObject({
			code: "supervisor_generation_stale",
		});
		await legacyOwner.release();
	});

	it("legacy registry reads never reclaim abandoned legacy directories", async () => {
		const paths = createPaths();
		const legacyDir = join(paths.root, "legacy-registry");
		const abandoned = join(legacyDir, "abandoned.owner");
		mkdirSync(abandoned, { recursive: true });

		await expect(
			persistDaemonStartupFenceFromOwner(paths.socketPath, {}, paths.registryDir, legacyDir),
		).rejects.toThrow(/does not match/);

		expect(existsSync(abandoned)).toBe(true);
	});

	it("marks ownership lost when the record is mismatched or absent", async () => {
		const paths = createPaths();
		const mismatched = await acquire(paths, "mismatched-owner");
		const mismatchedPath = join(ownerDir(paths, "mismatched-owner"), "owner.json");
		const foreign = { ...readJson(mismatchedPath), token: "successor-token" };
		writeFileSync(mismatchedPath, `${JSON.stringify(foreign, null, 2)}\n`);

		await expect(mismatched.assertCurrent()).rejects.toMatchObject({
			code: "supervisor_generation_stale",
			name: "DaemonSupervisorOwnershipLostError",
		});
		expect(readJson(mismatchedPath).token).toBe("successor-token");
		await mismatched.release();
		rmSync(ownerDir(paths, "mismatched-owner"), { recursive: true, force: true });

		const reaped = await acquire(paths, "reaped-owner");
		const reapedDir = ownerDir(paths, "reaped-owner");
		rmSync(reapedDir, { recursive: true, force: true });
		await expect(reaped.assertCurrent()).rejects.toMatchObject({ code: "supervisor_generation_stale" });
		expect(existsSync(reapedDir)).toBe(false);
		await reaped.release();
	});

	it("does not resurrect the shutdown admission when release overtakes an in-flight renew", async () => {
		const paths = createPaths();
		mkdirSync(paths.registryDir, { recursive: true, mode: 0o700 });
		process.env[registryDirEnv] = paths.registryDir;
		const admission = await acquireDaemonShutdownAdmission();
		const admissionPath = join(paths.registryDir, "shutdown-admission.json");
		expect(existsSync(admissionPath)).toBe(true);
		const dropGuard = await lockfile.lock(paths.registryDir, {
			realpath: false,
			lockfilePath: join(paths.registryDir, ".guard"),
		});
		const pending = admission.assertOrRenew();
		pending.catch(() => undefined);
		const releasing = admission.release();
		await dropGuard();
		await expect(pending).rejects.toMatchObject({ code: "daemon_shutdown_in_progress" });
		await releasing;
		expect(existsSync(admissionPath)).toBe(false);
	});

	it("disambiguates never-acquired from lost-on-disk ownership errors", async () => {
		const paths = createPaths();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype) as object, {
			ownership: undefined,
			generation: "unowned-generation",
			socketPath: paths.socketPath,
		});
		const assertCurrentOwnership = Reflect.get(supervisor, "assertCurrentOwnership") as () => Promise<void>;
		const neverAcquired = await assertCurrentOwnership
			.call(supervisor)
			.then(() => undefined)
			.catch((error: unknown) => error as Error & { code?: string });
		if (!neverAcquired) throw new Error("assertCurrentOwnership did not throw");
		expect(neverAcquired.code).toBe("supervisor_generation_stale");
		expect(neverAcquired.message).toContain("holds no registry ownership");
		expect(neverAcquired.message).toContain(paths.socketPath);
		expect(neverAcquired.message).toContain("sessions are preserved");

		const ownership = await acquire(paths);
		const ownerPath = join(ownerDir(paths, ownership.record.generation), "owner.json");
		const foreign = { ...readJson(ownerPath), token: "successor-token" };
		writeFileSync(ownerPath, `${JSON.stringify(foreign, null, 2)}\n`);
		const lostOnDisk = await ownership
			.assertCurrent()
			.then(() => undefined)
			.catch((error: unknown) => error as Error & { code?: string });
		if (!lostOnDisk) throw new Error("assertCurrent did not throw");
		expect(lostOnDisk.code).toBe("supervisor_generation_stale");
		expect(lostOnDisk.message).toContain("no longer owns its registry entry");
		expect(lostOnDisk.message).toContain(paths.socketPath);
		expect(lostOnDisk.message).toContain(paths.registryDir);
		expect(lostOnDisk.message).toContain("sessions are preserved");
		expect(lostOnDisk.message).not.toBe(neverAcquired.message);
		await ownership.release();
	});
});
