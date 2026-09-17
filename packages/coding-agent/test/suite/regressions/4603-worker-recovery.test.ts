import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_NAME, ENV_AGENT_DIR } from "../../../src/config.js";
import { getProcessStartId } from "../../../src/core/session-lease.js";
import { DaemonAgentConnection } from "../../../src/modes/agent-connection/daemon-agent-connection.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import type { DaemonResponse } from "../../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { defaultDaemonSocketDir } from "../../../src/modes/daemon/daemon-socket.js";
import {
	acquireDaemonShutdownAdmission,
	acquireDaemonSupervisorOwnership,
} from "../../../src/modes/daemon/daemon-supervisor-ownership.js";
import {
	DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	DAEMON_WORKER_ROLE_ENV,
	DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	DAEMON_WORKER_TOKEN_ENV,
	type DaemonWorkerDescriptor,
	type DaemonWorkerFrameHeader,
	isDaemonWorkerFrameHeader,
} from "../../../src/modes/daemon/daemon-worker-protocol.js";
import { serializeJsonLine } from "../../../src/modes/rpc/jsonl.js";
import {
	encodePrivateFrame,
	type PrivateFrame,
	PrivateFrameDecoder,
} from "../../../src/modes/session-worker/private-framing.js";
import { createHarness, type Harness } from "../harness.js";

interface OwnerRecord {
	token: string;
	generation: string;
	pid: number;
	processStartId?: string;
	socketPath: string;
	descriptorDir: string;
	agentDir: string;
}

type FixtureMessage =
	| { type: "booted" }
	| { type: "ready" }
	| { type: "failed"; error: string }
	| { type: "runtime_released" };

interface ProcessHandle {
	child: ChildProcess;
	identity?: FixtureProcessIdentity;
	role: FixtureProcessIdentity["role"];
	stdout: string;
	stderr: string;
	messages: FixtureMessage[];
	waiters: Array<{
		predicate: (message: FixtureMessage) => boolean;
		resolve: (message: FixtureMessage) => void;
		timeout: ReturnType<typeof setTimeout>;
	}>;
}

interface FixtureProcessIdentity {
	pid: number;
	processStartId: string;
	role: "client" | "supervisor" | "worker";
}

interface FixtureProcessSnapshot {
	ppid: number;
	state: string;
}

interface TestPaths {
	agentDir: string;
	descriptorDir: string;
	executablePath: string;
	registryDir: string;
	socketTmpDir: string;
	socketPath: string;
}

const fixturePath = resolve(__dirname, "../../fixtures/eng-4600-supervisor-fixture.ts");
const fauxExtensionPath = resolve(__dirname, "../../fixtures/eng-4600-faux-extension.ts");
const cliPath = resolve(__dirname, "../../../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/cli.mjs");
const tsconfigPath = resolve(__dirname, "../../../../../tsconfig.json");
const supervisorRegistryDirEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const handles = new Set<ProcessHandle>();
const harnesses: Harness[] = [];
const socketTempDirs = new Set<string>();
const fixtureDescriptorDirs = new Set<string>();
const fixtureProcesses = new Map<string, FixtureProcessIdentity>();
const fixtureRegistryDirs = new Set<string>();
// Covers the worker's five second supervisor-availability retry.
const fixtureProcessQuietMs = 5500;

afterEach(async () => {
	registerFixtureOwnedProcesses();
	await stopFixtureOwnedProcesses();
	await Promise.all([...handles].map((handle) => waitForExit(handle)));
	handles.clear();
	fixtureDescriptorDirs.clear();
	fixtureProcesses.clear();
	fixtureRegistryDirs.clear();
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
	for (const path of socketTempDirs) {
		rmSync(path, { recursive: true, force: true, maxRetries: 50, retryDelay: 50 });
	}
	socketTempDirs.clear();
}, 60_000);

async function createPaths(): Promise<TestPaths> {
	const harness = await createHarness();
	harnesses.push(harness);
	const executablePath = join(harness.tempDir, APP_NAME);
	// Never hard-link the signed runner binary: on macOS a link(2) on signed node
	// permanently invalidates the inode's code signature (AMFI), and every later
	// exec of that inode is SIGKILLed machine-wide. Spawn through a wrapper.
	writeFileSync(executablePath, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o700 });
	chmodSync(executablePath, 0o700);
	// Unix socket paths are length limited, so the child TMPDIR stays under a short root.
	const socketTmpRoot = process.platform === "win32" ? tmpdir() : "/tmp";
	mkdirSync(socketTmpRoot, { recursive: true, mode: 0o700 });
	const socketTmpDir = mkdtempSync(join(socketTmpRoot, "eng-4603-"));
	socketTempDirs.add(socketTmpDir);
	fixtureDescriptorDirs.add(join(harness.tempDir, "workers"));
	fixtureRegistryDirs.add(join(harness.tempDir, "registry"));
	return {
		agentDir: harness.tempDir,
		descriptorDir: join(harness.tempDir, "workers"),
		executablePath,
		registryDir: join(harness.tempDir, "registry"),
		socketTmpDir,
		socketPath:
			process.platform === "win32"
				? `\\\\.\\pipe\\prime-agent-eng-4603-${process.pid}-${Date.now()}`
				: join(harness.tempDir, "daemon.sock"),
	};
}

interface SupervisorOverrides {
	/** Socket the supervisor binds; defaults to the fixture's own path. */
	socketPath?: string;
	/** Where the supervisor writes worker descriptors; defaults to the fixture's own dir. */
	descriptorDir?: string;
}

function spawnSupervisor(paths: TestPaths, overrides: SupervisorOverrides = {}): ProcessHandle {
	const socketPath = overrides.socketPath ?? paths.socketPath;
	return trackProcess(
		spawn(paths.executablePath, [tsxPath, fixturePath], {
			cwd: paths.agentDir,
			env: {
				...process.env,
				[supervisorRegistryDirEnv]: paths.registryDir,
				[ENV_AGENT_DIR]: paths.agentDir,
				ENG_4600_AGENT_DIR: paths.agentDir,
				ENG_4600_DESCRIPTOR_DIR: overrides.descriptorDir ?? paths.descriptorDir,
				ENG_4600_FIXTURE_MODE: "supervisor",
				ENG_4600_REGISTRY_DIR: paths.registryDir,
				ENG_4600_SOCKET_PATH: socketPath,
				PI_OFFLINE: "1",
				TMPDIR: paths.socketTmpDir,
				TSX_TSCONFIG_PATH: tsconfigPath,
			},
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		}),
		"supervisor",
	);
}

function spawnStandaloneWorker(
	paths: TestPaths,
	workerSocketPath: string,
	token: string,
	extraEnv: NodeJS.ProcessEnv = {},
): ProcessHandle {
	return trackProcess(
		spawn(
			paths.executablePath,
			[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", workerSocketPath, "--offline"],
			{
				cwd: paths.agentDir,
				env: {
					...process.env,
					...extraEnv,
					[supervisorRegistryDirEnv]: paths.registryDir,
					[ENV_AGENT_DIR]: paths.agentDir,
					[DAEMON_WORKER_ROLE_ENV]: "1",
					[DAEMON_WORKER_TOKEN_ENV]: token,
					[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV]: "eng-4603-worker",
					[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV]: paths.socketPath,
					PI_OFFLINE: "1",
					TSX_TSCONFIG_PATH: tsconfigPath,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		),
		"worker",
	);
}

function trackProcess(child: ChildProcess, role: FixtureProcessIdentity["role"]): ProcessHandle {
	const identity = registerFixtureProcess(child.pid, getProcessStartId(child.pid ?? -1), role);
	const handle: ProcessHandle = { child, identity, role, stdout: "", stderr: "", messages: [], waiters: [] };
	handles.add(handle);
	child.stdout?.on("data", (chunk: Buffer) => {
		handle.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		handle.stderr += chunk.toString("utf8");
	});
	child.on("message", (message: FixtureMessage) => {
		const index = handle.waiters.findIndex((waiter) => waiter.predicate(message));
		if (index === -1) {
			handle.messages.push(message);
			return;
		}
		const [waiter] = handle.waiters.splice(index, 1);
		if (waiter) {
			clearTimeout(waiter.timeout);
			waiter.resolve(message);
		}
	});
	return handle;
}

function fixtureProcessKey(identity: FixtureProcessIdentity): string {
	return `${identity.role}:${identity.pid}:${identity.processStartId}`;
}

function registerFixtureProcess(
	pid: number | undefined,
	processStartId: string | undefined,
	role: FixtureProcessIdentity["role"],
): FixtureProcessIdentity | undefined {
	if (pid === undefined) return undefined;
	if (pid === process.pid) {
		// Leaked in-process ownership records name this runner; cleanup must never
		// stop the test process itself.
		console.warn(`[eng-4603] ignoring fixture registration for the test runner itself (pid ${pid}, role ${role})`);
		return undefined;
	}
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		throw new Error(`Invalid fixture process pid: ${String(pid)}`);
	}
	if (!processStartId) {
		if (fixturePidIsAlive(pid)) {
			throw new Error(`Live fixture process ${pid} has no exact start identity`);
		}
		return undefined;
	}
	const identity = { pid, processStartId, role };
	fixtureProcesses.set(fixtureProcessKey(identity), identity);
	return identity;
}

function registerFixtureOwnedProcesses(): void {
	for (const handle of handles) {
		if (!handle.identity && (handle.child.exitCode !== null || handle.child.signalCode !== null)) {
			continue;
		}
		handle.identity ??= registerFixtureProcess(
			handle.child.pid,
			getProcessStartId(handle.child.pid ?? -1),
			handle.role,
		);
	}
	for (const registryDir of fixtureRegistryDirs) {
		for (const name of readFixtureDirectory(registryDir).filter((entry) => entry.endsWith(".owner"))) {
			const ownerPath = join(registryDir, name, "owner.json");
			const owner = readFixtureJson<unknown>(ownerPath);
			if (owner === undefined) continue;
			registerFixtureRecord(owner, "supervisor", ownerPath);
		}
	}
	for (const descriptorDir of fixtureDescriptorDirs) {
		for (const name of readFixtureDirectory(descriptorDir).filter((entry) => entry.endsWith(".json"))) {
			const descriptorPath = join(descriptorDir, name);
			const descriptor = readFixtureJson<unknown>(descriptorPath);
			if (descriptor === undefined) continue;
			registerFixtureRecord(descriptor, "worker", descriptorPath);
		}
	}
}

function registerFixtureRecord(
	value: unknown,
	role: "supervisor" | "worker",
	path: string,
): FixtureProcessIdentity | undefined {
	if (!value || typeof value !== "object") {
		throw new Error(`Invalid fixture process record: ${path}`);
	}
	const record = value as { pid?: unknown; processStartId?: unknown };
	if (
		typeof record.pid !== "number" ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		typeof record.processStartId !== "string" ||
		record.processStartId.length === 0
	) {
		throw new Error(`Invalid fixture process identity: ${path}`);
	}
	return registerFixtureProcess(record.pid, record.processStartId, role);
}

function readFixtureProcessSnapshot(): Map<number, FixtureProcessSnapshot> {
	const listing = spawnSync("ps", ["-axo", "pid=,ppid=,state="], { encoding: "utf8" });
	if (listing.error) throw listing.error;
	if (listing.status !== 0) {
		throw new Error(`Could not enumerate fixture descendants: ${listing.stderr.trim()}`);
	}
	const processes = new Map<number, FixtureProcessSnapshot>();
	for (const line of listing.stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
		if (!match) continue;
		processes.set(Number(match[1]), { ppid: Number(match[2]), state: match[3]! });
	}
	return processes;
}

function fixtureDescendantPids(rootPid: number, processes: Map<number, FixtureProcessSnapshot>): number[] {
	const childrenByParent = new Map<number, number[]>();
	for (const [pid, process] of processes) {
		const children = childrenByParent.get(process.ppid) ?? [];
		children.push(pid);
		childrenByParent.set(process.ppid, children);
	}
	const descendants: number[] = [];
	const pending = [rootPid];
	while (pending.length > 0) {
		const parentPid = pending.shift()!;
		for (const childPid of childrenByParent.get(parentPid) ?? []) {
			descendants.push(childPid);
			pending.push(childPid);
		}
	}
	return descendants;
}

function isFixtureDescendant(pid: number, rootPid: number, processes: Map<number, FixtureProcessSnapshot>): boolean {
	const visited = new Set<number>();
	let current = pid;
	while (!visited.has(current)) {
		visited.add(current);
		const process = processes.get(current);
		if (!process) return false;
		if (process.ppid === rootPid) return true;
		current = process.ppid;
	}
	return false;
}

function signalFixtureProcess(identity: FixtureProcessIdentity, signal: NodeJS.Signals): boolean {
	const state = fixtureProcessState(identity);
	if (state === "exited") return false;
	if (state === "unverified") {
		throw new Error(`Could not verify fixture process ${identity.pid}/${identity.processStartId}`);
	}
	try {
		process.kill(identity.pid, signal);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

async function terminateFixtureProcessTree(root: FixtureProcessIdentity): Promise<void> {
	if (root.pid === process.pid) {
		// A leaked in-process ownership record can name this runner; never stop it.
		console.warn(`[eng-4603] refusing to terminate the test runner itself (${root.pid}/${root.processStartId})`);
		return;
	}
	if (fixtureProcessState(root) === "exited") return;
	if (process.platform === "win32") {
		if (signalFixtureProcess(root, "SIGKILL")) await waitForFixtureProcessExit(root);
		return;
	}
	if (!signalFixtureProcess(root, "SIGSTOP")) return;
	if (!(await waitForFixtureProcessStopped(root))) {
		throw new Error(`Fixture root ${root.pid}/${root.processStartId} exited before descendant discovery`);
	}
	const tree = new Map<string, FixtureProcessIdentity>([[`${root.pid}:${root.processStartId}`, root]]);
	let unchangedScans = 0;
	while (unchangedScans < 2) {
		const processesBefore = readFixtureProcessSnapshot();
		let discovered = 0;
		for (const pid of fixtureDescendantPids(root.pid, processesBefore)) {
			const processStartId = getProcessStartId(pid);
			if (!processStartId) {
				if (fixturePidIsAlive(pid)) throw new Error(`Live fixture descendant ${pid} has no exact start identity`);
				continue;
			}
			if (
				[...tree.values()].some((identity) => identity.pid === pid && identity.processStartId === processStartId)
			) {
				continue;
			}
			const processesAfter = readFixtureProcessSnapshot();
			const currentStartId = getProcessStartId(pid);
			if (currentStartId !== processStartId) {
				if (currentStartId === undefined && fixturePidIsAlive(pid)) {
					throw new Error(`Could not revalidate fixture descendant ${pid}`);
				}
				continue;
			}
			if (!isFixtureDescendant(pid, root.pid, processesAfter)) {
				throw new Error(`Fixture descendant ${pid}/${processStartId} changed ancestry during cleanup`);
			}
			const identity = registerFixtureProcess(pid, processStartId, "worker")!;
			tree.set(`${identity.pid}:${identity.processStartId}`, identity);
			if (signalFixtureProcess(identity, "SIGSTOP")) {
				await waitForFixtureProcessStopped(identity);
			}
			discovered++;
		}
		unchangedScans = discovered === 0 ? unchangedScans + 1 : 0;
		await delay(25);
	}
	for (const identity of [...tree.values()].reverse()) {
		signalFixtureProcess(identity, "SIGKILL");
	}
	for (const identity of tree.values()) {
		await waitForFixtureProcessExit(identity);
	}
}

async function waitForFixtureProcessStopped(identity: FixtureProcessIdentity, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = fixtureProcessState(identity);
		if (state === "exited") return false;
		if (state === "unverified") {
			throw new Error(`Could not verify fixture process ${identity.pid}/${identity.processStartId}`);
		}
		const processStatus = readFixtureProcessSnapshot().get(identity.pid)?.state;
		if (processStatus && ["T", "Z"].includes(processStatus[0]!) && fixtureProcessState(identity) === "matching") {
			return true;
		}
		await delay(25);
	}
	throw new Error(`Timed out waiting for fixture process ${identity.pid}/${identity.processStartId} to stop`);
}

function readFixtureDirectory(path: string): string[] {
	try {
		return readdirSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function readFixtureJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function fixtureProcessState(identity: FixtureProcessIdentity): "exited" | "matching" | "unverified" {
	const processStartId = getProcessStartId(identity.pid);
	if (processStartId === identity.processStartId) return "matching";
	if (processStartId !== undefined) return "exited";
	return fixturePidIsAlive(identity.pid) ? "unverified" : "exited";
}

function fixturePidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		throw error;
	}
}

async function stopFixtureOwnedProcesses(): Promise<void> {
	const deadline = Date.now() + 30_000;
	let quietSince: number | undefined;
	while (Date.now() < deadline) {
		for (const role of ["supervisor", "worker", "client"] as const) {
			for (const identity of [...fixtureProcesses.values()].filter((process) => process.role === role)) {
				const state = fixtureProcessState(identity);
				if (state === "unverified") {
					throw new Error(`Could not verify fixture process ${identity.pid}/${identity.processStartId}`);
				}
				if (state === "matching") {
					await terminateFixtureProcessTree(identity);
				}
				fixtureProcesses.delete(fixtureProcessKey(identity));
			}
		}
		registerFixtureOwnedProcesses();
		const remaining = [...fixtureProcesses.values()].filter((identity) => fixtureProcessState(identity) !== "exited");
		if (remaining.length > 0) {
			quietSince = undefined;
			continue;
		}
		quietSince ??= Date.now();
		if (Date.now() - quietSince >= fixtureProcessQuietMs) return;
		await delay(25);
	}
	throw new Error("Timed out stopping ENG-4603 fixture processes");
}

async function terminateTrackedFixtureProcess(handle: ProcessHandle): Promise<void> {
	if (!handle.identity && (handle.child.exitCode !== null || handle.child.signalCode !== null)) {
		await waitForExit(handle);
		return;
	}
	const identity =
		handle.identity ??
		registerFixtureProcess(handle.child.pid, getProcessStartId(handle.child.pid ?? -1), handle.role);
	if (identity) await terminateFixtureProcessTree(identity);
	await waitForExit(handle);
}

async function waitForFixtureProcessExit(identity: FixtureProcessIdentity): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (fixtureProcessState(identity) !== "exited" && Date.now() < deadline) {
		await delay(25);
	}
	const state = fixtureProcessState(identity);
	if (state !== "exited") {
		throw new Error(`Timed out waiting for fixture process ${identity.pid}/${identity.processStartId}`);
	}
}

function waitForMessage(
	handle: ProcessHandle,
	predicate: (message: FixtureMessage) => boolean,
	timeoutMs = 30_000,
): Promise<FixtureMessage> {
	const index = handle.messages.findIndex(predicate);
	if (index !== -1) {
		return Promise.resolve(handle.messages.splice(index, 1)[0]!);
	}
	return new Promise((resolveMessage, rejectMessage) => {
		const timeout = setTimeout(() => {
			handle.waiters = handle.waiters.filter((waiter) => waiter.timeout !== timeout);
			rejectMessage(new Error(`Timed out waiting for fixture message\n${handle.stderr}`));
		}, timeoutMs);
		handle.waiters.push({ predicate, resolve: resolveMessage, timeout });
	});
}

function waitForType<T extends FixtureMessage["type"]>(
	handle: ProcessHandle,
	type: T,
	timeoutMs?: number,
): Promise<Extract<FixtureMessage, { type: T }>> {
	return waitForMessage(handle, (message) => message.type === type || message.type === "failed", timeoutMs)
		.then((message) => {
			if (message.type === "failed") throw new Error(message.error);
			return message as Extract<FixtureMessage, { type: T }>;
		})
		.catch((error: unknown) => {
			throw new Error(`Timed out waiting for fixture message ${type}: ${String(error)}`);
		});
}

function waitForExit(handle: ProcessHandle, timeoutMs = 30_000): Promise<void> {
	if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise((resolveExit, rejectExit) => {
		const timeout = setTimeout(
			() => rejectExit(new Error(`Timed out waiting for process exit\n${handle.stderr}`)),
			timeoutMs,
		);
		handle.child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
		});
	});
}

async function waitForPath(path: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path) && Date.now() < deadline) {
		await delay(25);
	}
	if (!existsSync(path)) {
		throw new Error(`Timed out waiting for ${path}`);
	}
}

async function connectEventually(socketPath: string): Promise<DaemonClient> {
	const deadline = Date.now() + 30_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(500);
			await client.waitForHello(2000);
			return client;
		} catch (error) {
			lastError = error;
			client.close();
			await delay(25);
		}
	}
	throw new Error(`Timed out connecting to supervisor: ${String(lastError)}`);
}

function listOwnerRecords(registryDir: string): OwnerRecord[] {
	if (!existsSync(registryDir)) {
		return [];
	}
	const records = readdirSync(registryDir)
		.filter((name) => name.endsWith(".owner"))
		.map((name) => {
			const path = join(registryDir, name, "owner.json");
			const record = JSON.parse(readFileSync(path, "utf8")) as unknown;
			registerFixtureRecord(record, "supervisor", path);
			return record as OwnerRecord;
		});
	return records;
}

function readWorkerDescriptor(descriptorDir: string): DaemonWorkerDescriptor {
	const descriptors = readdirSync(descriptorDir).filter((name) => name.endsWith(".json"));
	expect(descriptors).toHaveLength(1);
	const descriptor = JSON.parse(readFileSync(join(descriptorDir, descriptors[0]!), "utf8")) as DaemonWorkerDescriptor;
	registerFixtureRecord(descriptor, "worker", join(descriptorDir, descriptors[0]!));
	return descriptor;
}

function requireSummary(value: unknown): SessionSummary {
	if (!value || typeof value !== "object" || typeof (value as Partial<SessionSummary>).id !== "string") {
		throw new Error("Daemon returned an invalid session summary");
	}
	return value as SessionSummary;
}

/**
 * The daemon socket dir a CLI run with this TMPDIR would scope a plain
 * `shutdown`/`doctor` to. Resolved through the production helper instead of
 * spelling out `prime-agent-<uid>`, so the fixture cannot drift from the rule.
 */
function scopedDaemonSocketDir(tmpDir: string): string {
	const previousTmpDir = process.env.TMPDIR;
	process.env.TMPDIR = tmpDir;
	try {
		return defaultDaemonSocketDir();
	} finally {
		if (previousTmpDir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpDir;
	}
}

/**
 * The pid that actually holds a supervisor's sockets. The fixture starts its
 * supervisors through the `prime-agent` wrapper plus the tsx CLI, and tsx runs
 * the script in a child process: the tracked pid is a launcher that owns none
 * of the service.
 */
async function servicePidOf(launcher: ProcessHandle, label: string): Promise<FixtureProcessIdentity> {
	const launcherPid = launcher.child.pid;
	if (launcherPid === undefined) throw new Error(`${label} supervisor has no launcher pid`);
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const processes = readFixtureProcessSnapshot();
		const children = [...processes.entries()]
			.filter(([, process]) => process.ppid === launcherPid && !process.state.startsWith("Z"))
			.map(([pid]) => pid);
		if (children.length === 1) {
			const pid = children[0]!;
			const identity = registerFixtureProcess(pid, getProcessStartId(pid), "supervisor");
			if (identity) return identity;
			throw new Error(`Could not identify the ${label} supervisor process ${pid}`);
		}
		if (children.length > 1) {
			throw new Error(
				`${label} supervisor launcher ${launcherPid} has ${children.length} children: ${children.join(", ")}`,
			);
		}
		await delay(25);
	}
	throw new Error(`Launcher ${launcherPid} never spawned the ${label} supervisor process`);
}

/** Every pid named in an `-F pn` lsof record stream. */
function lsofRecordPids(lsofOutput: string): number[] {
	const pids: number[] = [];
	for (const line of lsofOutput.split("\n")) {
		if (line.startsWith("p")) pids.push(Number.parseInt(line.slice(1), 10));
	}
	return pids;
}

/** pids whose lsof record names exactly this socket path (`-F pn` record stream). */
function lsofListenersOf(lsofOutput: string, socketPath: string): number[] {
	const pids: number[] = [];
	let pid: number | undefined;
	for (const line of lsofOutput.split("\n")) {
		if (line.startsWith("p")) pid = Number.parseInt(line.slice(1), 10);
		else if (line.startsWith("n") && pid !== undefined && resolve(line.slice(1)) === resolve(socketPath)) {
			pids.push(pid);
		}
	}
	return pids;
}

interface StopReportEntry {
	socketPath: string;
	pid?: number;
	kind: "service" | "worker" | "listener";
	action?: string;
	reason?: string;
}

interface StopReport {
	discovered: number;
	stopped: StopReportEntry[];
	failed: StopReportEntry[];
	skipped: StopReportEntry[];
	leftRunning: StopReportEntry[];
	stillPresent: string[];
}

/** The accounting identity the four-bucket contract promises: every target lands in exactly one bucket. */
function bucketTotal(report: StopReport): number {
	return report.stopped.length + report.failed.length + report.skipped.length + report.leftRunning.length;
}

function entriesFor(report: StopReport, socketPath: string): StopReportEntry[] {
	return [...report.stopped, ...report.failed, ...report.skipped, ...report.leftRunning].filter(
		(entry) => entry.socketPath === socketPath,
	);
}

function pidsOf(identities: readonly FixtureProcessIdentity[]): string {
	return identities.map((identity) => identity.pid).join(",");
}

/** Pull the accounting fields out of a JSON CLI report, failing on a missing one. */
function pickFields(value: unknown, keys: readonly string[], command: string): Record<string, unknown> {
	const report: Record<string, unknown> = {};
	for (const key of keys) {
		// A renamed or missing field must not read as "nothing to report".
		expect(value, `${command} output`).toHaveProperty(key);
		report[key] = (value as Record<string, unknown>)[key];
	}
	return report;
}

function parseStopReport(stdout: string, command: string): StopReport {
	const report = JSON.parse(stdout) as Partial<StopReport>;
	for (const key of ["stopped", "failed", "skipped", "leftRunning", "stillPresent"] as const) {
		// A renamed or missing field must not read as "nothing to report".
		expect(report[key], `${command} reported: ${stdout}`).toEqual(expect.any(Array));
	}
	expect(report.discovered, `${command} reported: ${stdout}`).toEqual(expect.any(Number));
	return report as StopReport;
}

function exactProcessIsAlive(pid: number, processStartId: string | undefined): boolean {
	if (!processStartId) {
		return false;
	}
	return getProcessStartId(pid) === processStartId;
}

async function waitForExactProcessExit(
	pid: number,
	processStartId: string | undefined,
	label = `${pid}`,
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (exactProcessIsAlive(pid, processStartId) && Date.now() < deadline) {
		await delay(25);
	}
	if (exactProcessIsAlive(pid, processStartId)) {
		throw new Error(`Timed out waiting for exact process ${label} (start ${processStartId ?? "unknown"})`);
	}
}

async function createResidentSession(client: DaemonClient, agentDir: string): Promise<SessionSummary> {
	const response = await client.request(
		{
			type: "create",
			config: {
				agentDir,
				apiKey: "faux-key",
				cwd: agentDir,
				extensions: [fauxExtensionPath],
				model: "faux",
				noContextFiles: true,
				noExtensions: false,
				noSkills: true,
				noTools: true,
				provider: "faux",
			},
		},
		60_000,
	);
	if (!response.success) {
		throw new Error(response.error);
	}
	return requireSummary(response.data);
}

async function runCli(
	paths: TestPaths,
	args: string[],
	timeoutMs = 60_000,
	extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const handle = trackProcess(
		spawn(process.execPath, [tsxPath, cliPath, ...args], {
			cwd: paths.agentDir,
			env: {
				...process.env,
				[supervisorRegistryDirEnv]: paths.registryDir,
				[ENV_AGENT_DIR]: paths.agentDir,
				PI_OFFLINE: "1",
				// The stop scope is derived from TMPDIR, so it comes before extraEnv:
				// a caller that wants to ask what a command refuses to touch has to be
				// able to move it.
				TMPDIR: paths.socketTmpDir,
				...extraEnv,
				TSX_TSCONFIG_PATH: tsconfigPath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		}),
		"client",
	);
	await waitForExit(handle, timeoutMs);
	return { code: handle.child.exitCode ?? 0, stdout: handle.stdout, stderr: handle.stderr };
}

function createFrameReader(socket: Socket): {
	waitFor: (
		predicate: (frame: PrivateFrame<DaemonWorkerFrameHeader>) => boolean,
		timeoutMs?: number,
	) => Promise<PrivateFrame<DaemonWorkerFrameHeader>>;
} {
	const decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
	const frames: PrivateFrame<DaemonWorkerFrameHeader>[] = [];
	const waiters: Array<{
		predicate: (frame: PrivateFrame<DaemonWorkerFrameHeader>) => boolean;
		resolve: (frame: PrivateFrame<DaemonWorkerFrameHeader>) => void;
		timeout: ReturnType<typeof setTimeout>;
	}> = [];
	socket.on("data", (chunk: Buffer) => {
		for (const frame of decoder.push(chunk)) {
			const index = waiters.findIndex((waiter) => waiter.predicate(frame));
			if (index === -1) {
				frames.push(frame);
				continue;
			}
			const waiter = waiters.splice(index, 1)[0];
			if (waiter) {
				clearTimeout(waiter.timeout);
				waiter.resolve(frame);
			}
		}
	});
	return {
		waitFor: (predicate, timeoutMs = 10_000) => {
			const index = frames.findIndex(predicate);
			if (index !== -1) {
				return Promise.resolve(frames.splice(index, 1)[0]!);
			}
			return new Promise((resolveFrame, rejectFrame) => {
				const timeout = setTimeout(() => {
					const waiterIndex = waiters.findIndex((waiter) => waiter.timeout === timeout);
					if (waiterIndex !== -1) waiters.splice(waiterIndex, 1);
					rejectFrame(new Error("Timed out waiting for worker frame"));
				}, timeoutMs);
				waiters.push({ predicate, resolve: resolveFrame, timeout });
			});
		},
	};
}

function decodeResponse(frame: PrivateFrame<DaemonWorkerFrameHeader>): DaemonResponse {
	return JSON.parse(frame.payload.toString("utf8")) as DaemonResponse;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

describe("ENG-4603 worker recovery convergence", () => {
	it("waits for fresh client context before replacing a crashed resident worker", async () => {
		if (process.platform === "win32") return;
		const paths = await createPaths();
		const predecessor = spawnSupervisor(paths);
		await waitForType(predecessor, "booted");
		predecessor.child.send({ type: "go" });
		await waitForType(predecessor, "ready", 60_000);
		const predecessorClient = await connectEventually(paths.socketPath);
		const summary = await createResidentSession(predecessorClient, paths.agentDir);
		const originalWorkerPid = summary.workerPid;
		if (!originalWorkerPid || !summary.sessionFile) throw new Error("Resident worker did not expose its identity");
		const originalWorkerStartId = getProcessStartId(originalWorkerPid);
		const originalWorkerIdentity = registerFixtureProcess(originalWorkerPid, originalWorkerStartId, "worker")!;

		predecessor.child.send({ type: "release_runtime" });
		await waitForType(predecessor, "runtime_released");
		await terminateFixtureProcessTree(originalWorkerIdentity);
		const successor = spawnSupervisor(paths);
		await waitForType(successor, "booted");
		successor.child.send({ type: "go" });
		await waitForType(successor, "ready", 60_000);
		await waitForExactProcessExit(originalWorkerPid, originalWorkerStartId);

		const successorClient = await connectEventually(paths.socketPath);
		let failed: DaemonWorkerDescriptor | undefined;
		const failedDeadline = Date.now() + 30_000;
		while (Date.now() < failedDeadline) {
			const candidate = readWorkerDescriptor(paths.descriptorDir);
			if (candidate.pid === originalWorkerPid && candidate.lifecycle === "failed") {
				failed = candidate;
				break;
			}
			await delay(25);
		}
		if (!failed) throw new Error("Successor did not retain the failed resident");
		// Negative window: the failed-worker reaper runs on a 5-minute cadence, so
		// 1.5s of quiet proves the failed resident is retained, not reaped or
		// restarted; load can only make the reaper later, never earlier.
		await delay(1500);
		expect(readWorkerDescriptor(paths.descriptorDir)).toMatchObject({
			pid: originalWorkerPid,
			lifecycle: "failed",
		});

		const recovered = await successorClient.request(
			{
				type: "create",
				sessionPath: summary.sessionFile,
				continueRecent: false,
				config: {
					agentDir: paths.agentDir,
					apiKey: "faux-key",
					cwd: paths.agentDir,
					extensions: [fauxExtensionPath],
					model: "faux",
					noContextFiles: true,
					noExtensions: false,
					noSkills: true,
					noTools: true,
					provider: "faux",
				},
				launchEnv: { PRIME_AGENT_TEST_FRESH_CONTEXT: "1" },
			},
			60_000,
		);
		if (!recovered.success) throw new Error(recovered.error);
		const recoveredSummary = requireSummary(recovered.data);

		let replacement: DaemonWorkerDescriptor | undefined;
		const replacementDeadline = Date.now() + 30_000;
		while (Date.now() < replacementDeadline) {
			const candidate = readWorkerDescriptor(paths.descriptorDir);
			if (candidate.pid !== originalWorkerPid && candidate.lifecycle === "ready") {
				replacement = candidate;
				break;
			}
			await delay(25);
		}
		if (!replacement) throw new Error("Fresh client context did not replace the failed worker");
		expect(getProcessStartId(replacement.pid)).toBe(replacement.processStartId);
		expect(exactProcessIsAlive(replacement.pid, replacement.processStartId)).toBe(true);
		expect(readdirSync(paths.descriptorDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);

		const connection = await DaemonAgentConnection.attach(
			successorClient,
			recoveredSummary.activeSessionId ?? recoveredSummary.id,
			{ recoverDaemon: async () => {} },
		);
		await connection.getInitialSnapshot();
		await connection.prompt("after recovery");
		await connection.waitForIdle();
		expect(await connection.getMessages()).toContainEqual(
			expect.objectContaining({
				role: "assistant",
				content: [expect.objectContaining({ text: "upgrade response 1" })],
			}),
		);
		await connection.dispose();
		await successorClient.request({ type: "shutdown", force: true }, 10_000);
		successorClient.close();
		predecessorClient.close();
		await waitForExit(successor);
		await waitForExactProcessExit(replacement.pid, replacement.processStartId);
		await terminateTrackedFixtureProcess(predecessor);
	}, 150_000);

	it("rejects stale commands at worker receipt and before public journal insertion", async () => {
		if (process.platform === "win32") return;
		const workerPaths = await createPaths();
		const workerSocketPath = join(workerPaths.agentDir, "worker-command.sock");
		const token = "eng-4603-token";
		const psCountPath = join(workerPaths.agentDir, "ps-count");
		const workerEnvironment: NodeJS.ProcessEnv = {};
		if (process.platform === "darwin") {
			const psWrapperPath = join(workerPaths.agentDir, "ps");
			writeFileSync(psWrapperPath, '#!/bin/sh\nprintf x >> "$ENG_4603_PS_COUNT_PATH"\nexec /bin/ps "$@"\n', {
				mode: 0o700,
			});
			chmodSync(psWrapperPath, 0o700);
			workerEnvironment.ENG_4603_PS_COUNT_PATH = psCountPath;
			workerEnvironment.PATH = `${workerPaths.agentDir}:${process.env.PATH ?? ""}`;
		}
		const oldOwner = await acquireDaemonSupervisorOwnership({
			agentDir: workerPaths.agentDir,
			appVersion: "test",
			descriptorDir: workerPaths.descriptorDir,
			generation: "old-generation",
			registryDir: workerPaths.registryDir,
			socketPath: workerPaths.socketPath,
		});
		const worker = spawnStandaloneWorker(workerPaths, workerSocketPath, token, workerEnvironment);
		// The forged record names this runner; a mid-test failure must not leak it
		// into the cleanup scan.
		const oldOwnerDirectory = join(workerPaths.registryDir, `${oldOwner.record.generation}.owner`);
		try {
			await waitForPath(workerSocketPath);
			const socket = createConnection(workerSocketPath);
			const frames = createFrameReader(socket);
			await new Promise<void>((resolveConnect, rejectConnect) => {
				socket.once("connect", resolveConnect);
				socket.once("error", rejectConnect);
			});
			await frames.waitFor(
				(frame) => frame.header.kind === "outbound" && frame.header.outboundType === "daemon_hello",
			);
			const authId = "auth-old";
			socket.write(
				encodePrivateFrame<DaemonWorkerFrameHeader>(
					{ kind: "command", requestId: authId, commandType: "worker_auth" },
					Buffer.from(
						serializeJsonLine({
							id: authId,
							type: "worker_auth",
							token,
							supervisorGeneration: oldOwner.record.generation,
							supervisorPid: oldOwner.record.pid,
							supervisorProcessStartId: oldOwner.record.processStartId,
							supervisorSocketPath: oldOwner.record.socketPath,
						}),
					),
				),
			);
			expect(
				decodeResponse(
					await frames.waitFor((frame) => frame.header.kind === "outbound" && frame.header.requestId === authId),
				).success,
			).toBe(true);
			if (process.platform === "darwin") {
				const countAfterAuthentication = readFileSync(psCountPath, "utf8").length;
				// Negative window: the worker re-validates the supervisor claim every
				// SUPERVISOR_FENCE_POLL_MS (250ms), and an unchanged owner fingerprint
				// never shells out to `ps`; 1.5s covers six fence polls of quiet.
				await delay(1500);
				expect(readFileSync(psCountPath, "utf8").length).toBe(countAfterAuthentication);
				const ownerPath = join(workerPaths.registryDir, `${oldOwner.record.generation}.owner`, "owner.json");
				const ownerRecord = JSON.parse(readFileSync(ownerPath, "utf8")) as { updatedAt: string };
				ownerRecord.updatedAt = new Date(Date.now() + 1000).toISOString();
				const updatedOwnerPath = `${ownerPath}.updated`;
				writeFileSync(updatedOwnerPath, `${JSON.stringify(ownerRecord, null, 2)}\n`);
				renameSync(updatedOwnerPath, ownerPath);
				// Positive window, event-driven: the changed owner fingerprint makes the
				// next fence check re-validate the supervisor identity, which is the `ps`
				// invocation being counted. FSEvents delivery, the fence poll and the
				// helper round trip all stretch under load, so poll for the first extra
				// invocation instead of asserting it inside a fixed 500ms window.
				await vi.waitFor(
					() => {
						expect(readFileSync(psCountPath, "utf8").length).toBeGreaterThan(countAfterAuthentication);
					},
					{ timeout: 5000, interval: 50 },
				);
				const countAfterOwnerChange = readFileSync(psCountPath, "utf8").length;
				// Negative window again: the new fingerprint is now validated, so six
				// more fence polls of quiet must not re-run the identity check.
				await delay(1500);
				expect(readFileSync(psCountPath, "utf8").length).toBe(countAfterOwnerChange);
			}
			const commandId = "stale-list";
			const commandFrame = encodePrivateFrame<DaemonWorkerFrameHeader>(
				{ kind: "command", requestId: commandId, commandType: "list" },
				Buffer.from(serializeJsonLine({ id: commandId, type: "list" })),
			);
			socket.write(commandFrame.subarray(0, commandFrame.length - 1));
			const ownerPath = join(oldOwnerDirectory, "owner.json");
			const transitionedOwner = JSON.parse(readFileSync(ownerPath, "utf8")) as OwnerRecord & { updatedAt: string };
			transitionedOwner.token = "successor-token";
			transitionedOwner.pid = worker.child.pid!;
			transitionedOwner.processStartId = getProcessStartId(worker.child.pid!);
			transitionedOwner.updatedAt = new Date().toISOString();
			const transitionedOwnerPath = `${ownerPath}.transitioned`;
			writeFileSync(transitionedOwnerPath, `${JSON.stringify(transitionedOwner, null, 2)}\n`);
			renameSync(transitionedOwnerPath, ownerPath);
			socket.write(commandFrame.subarray(commandFrame.length - 1));
			const staleResponse = decodeResponse(
				await frames.waitFor((frame) => frame.header.kind === "outbound" && frame.header.requestId === commandId),
			);
			expect(staleResponse).toMatchObject({ success: false, error: "supervisor_generation_stale" });
			socket.destroy();
		} finally {
			await oldOwner.release();
			rmSync(oldOwnerDirectory, { recursive: true, force: true });
		}
		await terminateTrackedFixtureProcess(worker);

		const publicPaths = await createPaths();
		const staleSupervisor = spawnSupervisor(publicPaths);
		await waitForType(staleSupervisor, "booted");
		staleSupervisor.child.send({ type: "go" });
		await waitForType(staleSupervisor, "ready", 60_000);
		const publicClient = await connectEventually(publicPaths.socketPath);
		const [publishedOwner] = listOwnerRecords(publicPaths.registryDir);
		if (!publishedOwner) throw new Error("Supervisor did not publish its owner");
		const journalPath = join(publicPaths.descriptorDir, "command-journal.jsonl");
		const journalBefore = existsSync(journalPath) ? readFileSync(journalPath, "utf8") : "";
		const displacedOwnerDir = join(publicPaths.registryDir, `${publishedOwner.generation}.displaced`);
		renameSync(join(publicPaths.registryDir, `${publishedOwner.generation}.owner`), displacedOwnerDir);
		const replacementOwner = await acquireDaemonSupervisorOwnership({
			agentDir: publicPaths.agentDir,
			appVersion: "test",
			descriptorDir: publicPaths.descriptorDir,
			generation: "journal-successor",
			registryDir: publicPaths.registryDir,
			socketPath: publicPaths.socketPath,
		});
		try {
			const rejected = await publicClient.request({ type: "create" });
			expect(rejected).toMatchObject({ success: false, error: expect.stringContaining("no longer owns") });
			expect(existsSync(journalPath) ? readFileSync(journalPath, "utf8") : "").toBe(journalBefore);
		} finally {
			// This record also names this runner; never leak it into the cleanup scan.
			publicClient.close();
			await replacementOwner.release();
			rmSync(displacedOwnerDir, { recursive: true, force: true });
		}
		await terminateTrackedFixtureProcess(staleSupervisor);
	}, 90_000);

	it("serializes shutdown admission and keeps a lapsed lease with its live holder", async () => {
		const paths = await createPaths();
		const previousRegistryDir = process.env[supervisorRegistryDirEnv];
		process.env[supervisorRegistryDirEnv] = paths.registryDir;
		try {
			const admissionPath = join(paths.registryDir, "shutdown-admission.json");
			const readRecord = () =>
				JSON.parse(readFileSync(admissionPath, "utf8")) as {
					token: string;
					pid: number;
					processStartId?: string;
					expiresAt: string;
				};
			const first = await acquireDaemonShutdownAdmission();
			const held = readRecord();
			expect(held.pid).toBe(process.pid);
			expect(held.processStartId).toBe(getProcessStartId(process.pid));

			// Stall this thread the way a machine sleep or a synchronous ps|lsof fork does:
			// the holder's 1s refresh cannot run, so its 5s lease lapses with the record on
			// disk still naming this process. That stall used to burn the ticket permanently.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_300);
			expect(Date.parse(readRecord().expiresAt)).toBeLessThan(Date.now());

			// The holder is alive, so a lapsed lease is its own to renew; a second process
			// must never be admitted into the same shutdown.
			await expect(first.assertOrRenew()).resolves.toBeUndefined();
			expect(Date.parse(readRecord().expiresAt)).toBeGreaterThan(Date.now());

			let secondAcquired = false;
			const waiting = acquireDaemonShutdownAdmission().then((admission) => {
				secondAcquired = true;
				return admission;
			});
			await delay(250);
			expect(secondAcquired).toBe(false);
			expect(readRecord().token).toBe(held.token);

			let destructivePasses = 0;
			const destructivePass = async (admission: { assertOrRenew: () => Promise<void> }) => {
				await admission.assertOrRenew();
				destructivePasses++;
			};
			await destructivePass(first);
			expect(destructivePasses).toBe(1);

			await first.release();
			const second = await waiting;
			expect(secondAcquired).toBe(true);
			await destructivePass(second);
			expect(destructivePasses).toBe(2);
			await second.release();
		} finally {
			if (previousRegistryDir === undefined) {
				delete process.env[supervisorRegistryDirEnv];
			} else {
				process.env[supervisorRegistryDirEnv] = previousRegistryDir;
			}
		}
	}, 30_000);

	it("shutdown --force removes hidden supervisors and workers through the public CLI", async () => {
		if (process.platform === "win32") return;
		const paths = await createPaths();
		// A background service the public CLI started listens in this shell's daemon
		// socket dir, and stop commands are scoped to that dir. Bind the fixture
		// there and give it the production worker-descriptor layout, so a plain
		// `shutdown --force` is asked about services it is allowed to touch.
		const serviceDir = scopedDaemonSocketDir(paths.socketTmpDir);
		mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
		const socketPath = join(serviceDir, "daemon.sock");
		const descriptorDir = join(paths.agentDir, "daemon-workers", "eng-4603-shutdown");
		fixtureDescriptorDirs.add(descriptorDir);
		const supervisorOverrides = { socketPath, descriptorDir };

		const predecessor = spawnSupervisor(paths, supervisorOverrides);
		await waitForType(predecessor, "booted");
		predecessor.child.send({ type: "go" });
		await waitForType(predecessor, "ready", 60_000);
		const predecessorService = await servicePidOf(predecessor, "predecessor");
		const client = await connectEventually(socketPath);
		const session = await createResidentSession(client, paths.agentDir);
		const workerPid = session.workerPid;
		if (!workerPid) throw new Error("Resident worker did not expose its pid");
		const workerStartId = getProcessStartId(workerPid);
		registerFixtureProcess(workerPid, workerStartId, "worker");
		predecessor.child.send({ type: "release_runtime" });
		await waitForType(predecessor, "runtime_released");
		const successor = spawnSupervisor(paths, supervisorOverrides);
		await waitForType(successor, "booted");
		successor.child.send({ type: "go" });
		await waitForType(successor, "ready", 60_000);
		const successorService = await servicePidOf(successor, "successor");
		client.close();

		if (!workerStartId) throw new Error("Resident worker did not expose its process identity");
		const services: FixtureProcessIdentity[] = [
			predecessorService,
			successorService,
			{ pid: workerPid, processStartId: workerStartId, role: "worker" },
		];
		const systemLsofPath = spawnSync("which", ["lsof"], { encoding: "utf8" }).stdout.trim();
		if (!systemLsofPath) throw new Error("Could not locate lsof for the shutdown regression");
		const lsofPath = join(paths.agentDir, "lsof");
		writeFileSync(lsofPath, '#!/bin/sh\nexec "$ENG_4603_SYSTEM_LSOF" -nP -F pn -U -a -p "$ENG_4603_LSOF_PIDS"\n', {
			mode: 0o700,
		});
		// The scan the CLI runs is restricted to the processes that own the service
		// sockets, so the command cannot be answered by an unrelated process.
		const lsofEnvironment = {
			ENG_4603_LSOF_PIDS: services.map((service) => service.pid).join(","),
			ENG_4603_SYSTEM_LSOF: systemLsofPath,
			PATH: `${paths.agentDir}:${process.env.PATH ?? ""}`,
		};
		const listenersBeforeShutdown = spawnSync(lsofPath, [], {
			encoding: "utf8",
			env: { ...process.env, ...lsofEnvironment },
		}).stdout;
		// The regression needs two processes holding one supervisor socket: that is
		// the hidden supervisor, and the scan this fixture injects must see both of
		// them. Which *column* a scan reports a socket under is not the same on
		// every platform (the CI scan named these pids and reported no path for
		// this socket), so ownership of the path is pinned by the exit checks below
		// and by `lsofListenersOf` only as a machine-readable extra, never as the
		// proposition itself.
		expect(listenersBeforeShutdown).toContain(`p${predecessorService.pid}`);
		expect(listenersBeforeShutdown).toContain(`p${successorService.pid}`);
		const namedByPath = lsofListenersOf(listenersBeforeShutdown, socketPath);
		if (namedByPath.length > 0) {
			expect(namedByPath.sort()).toEqual(
				[predecessorService.pid, successorService.pid].sort((left, right) => left - right),
			);
		}

		// The default scope is the daemon identity, not the shell's temp dir: a
		// client whose `$TMPDIR` differs from the daemon's still resolves this same
		// daemon through the supervisor registry, so a dry run from another temp
		// dir must name it as a target instead of reporting an empty scope while
		// the daemon keeps running. `--force` answers the confirmation question and
		// never widens a scope, so this is a plan and nothing is touched.
		const foreignTmpDir = join(paths.socketTmpDir, "foreign-tmpdir");
		mkdirSync(foreignTmpDir, { recursive: true, mode: 0o700 });
		const fromOtherTmpDir = await runCli(paths, ["shutdown", "--force", "--dry-run", "--json"], 60_000, {
			...lsofEnvironment,
			TMPDIR: foreignTmpDir,
		});
		expect(fromOtherTmpDir.code, fromOtherTmpDir.stderr).toBe(0);
		const foreignPlan = JSON.parse(fromOtherTmpDir.stdout) as {
			dryRun: boolean;
			scope: { kind: string; agentSocketPaths?: string[] };
			targets: Array<{ socketPath: string }>;
		};
		expect(foreignPlan.dryRun).toBe(true);
		expect(foreignPlan.scope.kind).toBe("daemon-identity");
		expect(foreignPlan.scope.agentSocketPaths).toEqual([socketPath]);
		expect(foreignPlan.targets.map((entry) => entry.socketPath)).toEqual([socketPath]);
		for (const service of services) {
			expect(exactProcessIsAlive(service.pid, service.processStartId), `pid ${service.pid} before shutdown`).toBe(
				true,
			);
		}

		// The stop names its target instead of sweeping a directory: two supervisors
		// hold one socket path here, so each of them has to be a target of its own and
		// `--socket` is the scope that can say one true thing about each process.
		const shutdown = await runCli(
			paths,
			["shutdown", "--socket", socketPath, "--force", "--json"],
			60_000,
			lsofEnvironment,
		);
		expect(shutdown.code, shutdown.stderr).toBe(0);
		const report = parseStopReport(shutdown.stdout, "shutdown --socket --force");
		// Empty here is the command claiming it left nothing running and excluded
		// nothing; the exit checks below are what makes that a fact, not a promise.
		expect(report.failed, shutdown.stdout).toEqual([]);
		expect(report.skipped, shutdown.stdout).toEqual([]);
		expect(report.leftRunning, shutdown.stdout).toEqual([]);

		// The fact first, before any shape is checked: a run that claimed a clean stop
		// left no service of its own running. A survivor is quoted with the report that
		// hid it, so "the accounting looked fine" can never be the answer again.
		for (const service of services) {
			try {
				await waitForExactProcessExit(service.pid, service.processStartId, `${service.role} ${service.pid}`);
			} catch (error) {
				const live = spawnSync("ps", ["-o", "pid=,ppid=,stat=,etime=", "-p", pidsOf(services)], {
					encoding: "utf8",
				});
				throw new Error(
					`${String(error)}; the report said ${JSON.stringify(report.stopped.map((entry) => `${entry.socketPath} pid ${entry.pid} [${entry.kind}] ${entry.action}`))}, still running: ${live.stdout.trim()}`,
				);
			}
		}
		// The same fact from the listener side, and with no wall clock to pay: the scan
		// is restricted to the fixture pids, so a clean stop must leave none of them
		// named as a socket holder. Exact record pids, not substrings of the stream.
		const listenersAfterShutdown = spawnSync(lsofPath, [], {
			encoding: "utf8",
			env: { ...process.env, ...lsofEnvironment },
		}).stdout;
		const pidsAfterShutdown = new Set(lsofRecordPids(listenersAfterShutdown));
		for (const service of services) {
			expect(pidsAfterShutdown.has(service.pid), `${service.role} ${service.pid} still holds a socket`).toBe(false);
		}

		// Then the shape of the claim. One supervisor socket held by two processes and
		// one worker socket: every pid the scope covered is named once, with the pid
		// that died, and the names add up to what was discovered. A survivor must not
		// be able to hide behind another pid's success on the same path.
		const supervisorServices = services.filter((service) => service.role !== "worker");
		const namedSupervisors = entriesFor(report, socketPath);
		expect(namedSupervisors.length, shutdown.stdout).toBe(supervisorServices.length);
		for (const service of supervisorServices) {
			expect(
				namedSupervisors.filter((entry) => entry.pid === service.pid),
				`${service.role} ${service.pid} in ${shutdown.stdout}`,
			).toHaveLength(1);
		}
		expect(
			report.stopped.some((entry) => entry.kind === "worker" && entry.pid === workerPid),
			shutdown.stdout,
		).toBe(true);
		expect(report.stopped.length, shutdown.stdout).toBe(services.length);
		expect(report.discovered, shutdown.stdout).toBe(bucketTotal(report));
		expect(report.stillPresent, shutdown.stdout).toEqual([]);

		// The no-work-to-do run comes first: it is the one that says whether the sweep
		// above really left nothing behind, before `status`/`doctor` read that state.
		// All four buckets plus the identity and the observation diff are pinned, so a
		// renamed field reads as a failure and not as "nothing to report".
		const emptyStopReport = {
			discovered: 0,
			stopped: [],
			failed: [],
			skipped: [],
			leftRunning: [],
			stillPresent: [],
		};
		const stopReportKeys = ["discovered", "stopped", "failed", "skipped", "leftRunning", "stillPresent"];
		const jsonContracts: Array<{ args: string[]; keys?: string[]; expected: unknown }> = [
			{
				args: ["shutdown", "--socket", socketPath, "--force", "--json"],
				keys: stopReportKeys,
				expected: emptyStopReport,
			},
			{ args: ["status", "--json"], expected: [] },
			{ args: ["doctor", "--fix", "--json"], keys: ["reaped", "skipped"], expected: { reaped: [], skipped: [] } },
			{ args: ["shutdown", "--force", "--json"], keys: stopReportKeys, expected: emptyStopReport },
		];
		for (const contract of jsonContracts) {
			const result = await runCli(paths, contract.args, 60_000, lsofEnvironment);
			if (result.code !== 0) {
				throw new Error(`${contract.args.join(" ")} exited ${result.code}: ${result.stderr}`);
			}
			const parsed = JSON.parse(result.stdout) as unknown;
			const reported =
				contract.keys === undefined ? parsed : pickFields(parsed, contract.keys, contract.args.join(" "));
			expect(reported, result.stdout).toEqual(contract.expected);
		}
		// The empty-scope wording differs per command and both say the same thing:
		// this scope holds nothing left to stop.
		// Every human face says the same thing as the JSON above: nothing is
		// discoverable anywhere, so none of them may fall back to the scoped wording
		// ("... in scope: ", "Nothing to stop in this scope."), which is reserved for a
		// machine where services exist somewhere else. Those two wordings only ever
		// appeared here because a leaked supervisor was still discoverable through the
		// owner registry after its stop was reported clean.
		const nothingAnywhere = "No background services found.\n";
		const idleReports: Array<{ args: string[]; text: string }> = [
			{ args: ["status"], text: nothingAnywhere },
			{ args: ["doctor", "--fix"], text: nothingAnywhere },
			{ args: ["shutdown", "--force"], text: nothingAnywhere },
			{ args: ["shutdown", "--socket", socketPath, "--force"], text: nothingAnywhere },
		];
		for (const idle of idleReports) {
			const result = await runCli(paths, idle.args, 60_000, lsofEnvironment);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain(idle.text);
		}
	}, 150_000);

	it("spawns fixture processes through a private wrapper, never a hard link of the runner's node", async () => {
		if (process.platform === "win32") return;
		const paths = await createPaths();
		const executableStat = statSync(paths.executablePath);
		const runnerStat = statSync(process.execPath);
		// macOS AMFI: hard-linking the signed runner binary permanently invalidates
		// the shared inode's code signature, and every later exec of that inode is
		// SIGKILLed machine-wide.
		expect([executableStat.dev, executableStat.ino]).not.toEqual([runnerStat.dev, runnerStat.ino]);
		expect(readFileSync(paths.executablePath, "utf8")).toBe(`#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
		expect(executableStat.mode & 0o111).not.toBe(0);
	});

	it("never registers or terminates the test runner itself when an in-process owner record leaks", async () => {
		if (process.platform === "win32") return;
		const paths = await createPaths();
		const runnerStartId = getProcessStartId(process.pid);
		if (!runnerStartId) throw new Error("Could not identify the test runner");
		// The stale-command test acquires supervisor ownership in-process; a
		// mid-test failure leaks this record into the cleanup scan.
		const leakedOwnerDir = join(paths.registryDir, "leaked-runner.owner");
		mkdirSync(leakedOwnerDir, { recursive: true });
		writeFileSync(
			join(leakedOwnerDir, "owner.json"),
			JSON.stringify({
				token: "leaked",
				generation: "leaked-runner",
				pid: process.pid,
				processStartId: runnerStartId,
				socketPath: paths.socketPath,
				descriptorDir: paths.descriptorDir,
				agentDir: paths.agentDir,
			}),
		);
		registerFixtureOwnedProcesses();
		expect([...fixtureProcesses.values()].some((identity) => identity.pid === process.pid)).toBe(false);
		await terminateFixtureProcessTree({ pid: process.pid, processStartId: runnerStartId, role: "supervisor" });
		expect(fixtureProcessState({ pid: process.pid, processStartId: runnerStartId, role: "supervisor" })).toBe(
			"matching",
		);
	});
});
