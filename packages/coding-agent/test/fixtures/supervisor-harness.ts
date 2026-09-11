import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { ENV_AGENT_DIR, getDaemonLogPath } from "../../src/config.js";
import { SESSION_SCHEDULED_JOBS_FILENAME } from "../../src/core/cron-jobs.js";
import { getProcessStartId } from "../../src/core/session-lease.js";
import { getSessionArtifactPathForFile, SessionManager } from "../../src/core/session-manager.js";
import { DaemonCatalogClient } from "../../src/modes/daemon/daemon-catalog-process.js";
import { DaemonClient } from "../../src/modes/daemon/daemon-client.js";
import type { DaemonCommand, DaemonOutbound, DaemonResponse } from "../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../src/modes/daemon/daemon-session-list.js";
import {
	type ClientCatchupRetryPolicy,
	DaemonSupervisor,
	type DaemonSupervisorOptions,
} from "../../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerDescriptor, DaemonWorkerLifecycle } from "../../src/modes/daemon/daemon-worker-protocol.js";
import {
	type FakeWorkerHandle,
	type FakeWorkerSession,
	startFakeWorker,
	writeWorkerDescriptor,
} from "./supervisor-fake-worker.js";

/**
 * A supervisor test harness that stays on public surfaces: a real socket, a real
 * descriptor directory, an in-process fake worker socket, and a stand-in process
 * whose pid/start identity the descriptor claims. Nothing here reaches into
 * supervisor privates, so a rename cannot silently break a test.
 */

export interface SupervisorHarnessOptions {
	/** Prefix for the temp directory, so failures are attributable. */
	prefix: string;
	/** The fake worker answers hello/auth/subscribe/list; `false` leaves adoption hanging or probing. */
	adopt?: boolean;
	/** Skip the fake worker socket entirely (a descriptor whose worker is simply gone). */
	noWorkerSocket?: boolean;
	/** The fake worker answers hello and auth only, so adoption wedges on its next request. */
	hangAfterAuth?: boolean;
	/** Claim a pid that is already dead, so adoption fails on identity. */
	deadWorkerPid?: boolean;
	descriptorLifecycle?: DaemonWorkerLifecycle;
	descriptorOverrides?: Partial<DaemonWorkerDescriptor>;
	supervisorOptions?: Partial<DaemonSupervisorOptions>;
	catchupRetryPolicy?: ClientCatchupRetryPolicy;
	/** Connect a client and wait for daemon_hello (default true). */
	connectClient?: boolean;
	sessionCount?: number;
	/** Write a scheduled-jobs artifact for the root session, so the tree counts as unattended. */
	scheduledJobsArtifact?: boolean;
	/** Extra files to drop into the descriptor directory before startup. */
	descriptorFiles?: Record<string, string>;
}

export interface SupervisorHarness {
	root: string;
	agentDir: string;
	projectDir: string;
	sessionDir: string;
	socketPath: string;
	descriptorDir: string;
	descriptorPath: string;
	session: FakeWorkerSession;
	sessions: FakeWorkerSession[];
	worker?: FakeWorkerHandle;
	standIn?: { child: ChildProcess; pid: number; processStartId: string | undefined };
	pid: number;
	client?: DaemonClient;
	hello?: Extract<DaemonOutbound, { type: "daemon_hello" }>;
	messages: DaemonOutbound[];
	supervisor: DaemonSupervisor;
	waitFor(predicate: (message: DaemonOutbound) => boolean, timeoutMs?: number): Promise<DaemonOutbound>;
	waitForCount(predicate: (message: DaemonOutbound) => boolean, count: number, timeoutMs?: number): Promise<void>;
	settle(ms: number): Promise<void>;
	request(command: DaemonCommand, timeoutMs?: number): Promise<DaemonResponse>;
	listSessions(): Promise<SessionSummary[]>;
	readDescriptor(): DaemonWorkerDescriptor | undefined;
	logText(): string;
	/** Path of the root session's scheduled-jobs artifact, when the harness wrote one. */
	scheduledJobsArtifactPath(): string;
	/** Connects an extra client and returns the hello it was greeted with. */
	connectClient(): Promise<{
		client: DaemonClient;
		hello: Extract<DaemonOutbound, { type: "daemon_hello" }>;
		messages: DaemonOutbound[];
	}>;
	waitForDescriptorLifecycle(lifecycle: DaemonWorkerLifecycle | undefined, timeoutMs?: number): Promise<void>;
	/** Waits until adoption has seeded the roster and the worker answers as ready. */
	waitForWorkerReady(timeoutMs?: number): Promise<void>;
	descriptorNames(): string[];
	waitForSessionCount(predicate: (count: number) => boolean, timeoutMs?: number): Promise<void>;
	processIsGone(): Promise<boolean>;
	dispose(): Promise<void>;
}

const liveHarnesses: SupervisorHarness[] = [];

/** Shuts down every harness the test file started; call it from afterEach. */
export async function disposeSupervisorHarnesses(): Promise<void> {
	while (liveHarnesses.length > 0) {
		const harness = liveHarnesses.pop();
		await harness?.dispose().catch(() => undefined);
	}
	vi.restoreAllMocks();
}

export function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export async function startSupervisorHarness(options: SupervisorHarnessOptions): Promise<SupervisorHarness> {
	const root = makeTempDir(options.prefix);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const sessionDir = join(agentDir, "sessions");
	const socketPath = join(root, "daemon.sock");
	const workerSocketPath = join(root, "worker.sock");
	const descriptorDir = options.supervisorOptions?.descriptorDir ?? join(agentDir, "daemon-workers");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(descriptorDir, { recursive: true });

	const sessionCount = options.sessionCount ?? 1;
	const sessions: FakeWorkerSession[] = [];
	for (let index = 0; index < sessionCount; index++) {
		const manager = SessionManager.create(projectDir, sessionDir);
		manager.appendMessage({ role: "user", content: `supervisor fixture ${index}`, timestamp: 1 });
		manager.flushNow();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}
		sessions.push({
			activeSessionId: index === 0 ? "active-root" : `active-child-${index}`,
			sessionId: manager.getSessionId(),
			sessionFile,
			cwd: projectDir,
			messageCount: 1,
		});
	}
	const session = sessions[0]!;

	let standIn: SupervisorHarness["standIn"];
	let pid = 0;
	let processStartId: string | undefined;
	if (options.deadWorkerPid) {
		// A pid that existed and is now gone: identity checks read it as dead.
		const doomed = spawnShortLivedProcess();
		pid = doomed.pid;
		processStartId = doomed.processStartId;
		doomed.child.kill("SIGKILL");
		await waitForExit(doomed.child);
		standIn = doomed;
	} else {
		standIn = spawnShortLivedProcess();
		pid = standIn.pid;
		processStartId = standIn.processStartId;
	}

	let worker: FakeWorkerHandle | undefined;
	if (!options.noWorkerSocket) {
		worker = await startFakeWorker({
			socketPath: workerSocketPath,
			session,
			...(options.adopt === false ? { adopt: false } : {}),
			...(options.hangAfterAuth ? { hangAfterAuth: true } : {}),
			// Mirror a real worker: an asked-for shutdown takes the process with it.
			onShutdownRequest: () => {
				if (standIn && standIn.child.exitCode === null && standIn.child.signalCode === null) {
					standIn.child.kill("SIGTERM");
				}
			},
		});
	}

	const now = new Date().toISOString();
	const descriptor: DaemonWorkerDescriptor = {
		version: 2,
		workerId: "worker-fixture",
		pid,
		...(processStartId ? { processStartId } : {}),
		socketPath: workerSocketPath,
		recoveryJournalPath: join(descriptorDir, "worker-fixture.recovery.jsonl"),
		orphanProcessJournalPath: join(descriptorDir, "worker-fixture.orphans.jsonl"),
		supervisorSocketPath: socketPath,
		authenticationToken: "token-fixture",
		rootActiveSessionId: session.activeSessionId,
		rootSessionId: session.sessionId,
		sessionFile: session.sessionFile,
		sessionDir,
		createdAt: now,
		updatedAt: now,
		lifecycle: options.descriptorLifecycle ?? "ready",
		createCommand: { type: "create", sessionPath: session.sessionFile },
		consecutiveFailures: 0,
		...options.descriptorOverrides,
	};
	const descriptorPath = join(descriptorDir, "worker-fixture.json");
	writeWorkerDescriptor(descriptor, descriptorPath);
	for (const [name, contents] of Object.entries(options.descriptorFiles ?? {})) {
		writeFileSync(join(descriptorDir, name), contents);
	}

	// The catalog subprocess is out of scope for supervisor tests: stub the two
	// calls the startup and stop paths make so no unhandled rejection escapes.
	// Keep every artifact (including the rotating daemon log) inside the temp tree.
	const previousAgentDirEnv = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = agentDir;
	if (options.scheduledJobsArtifact) {
		const artifactDir = getSessionArtifactPathForFile(session.sessionFile, session.sessionId);
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(
			join(artifactDir, SESSION_SCHEDULED_JOBS_FILENAME),
			`${JSON.stringify({ version: 1, jobs: [] })}\n`,
		);
	}

	vi.spyOn(DaemonCatalogClient.prototype, "start").mockResolvedValue();
	vi.spyOn(DaemonCatalogClient.prototype, "archive").mockResolvedValue(true);
	const supervisor = new DaemonSupervisor(socketPath, {
		defaultSessionConfig: { cwd: projectDir, agentDir },
		descriptorDir,
		...(options.catchupRetryPolicy ? { catchupRetryPolicy: options.catchupRetryPolicy } : {}),
		...options.supervisorOptions,
	});
	await supervisor.start();

	const messages: DaemonOutbound[] = [];
	const extraClients: DaemonClient[] = [];
	let client: DaemonClient | undefined;
	let hello: Extract<DaemonOutbound, { type: "daemon_hello" }> | undefined;
	if (options.connectClient !== false) {
		client = new DaemonClient(socketPath);
		await client.connect(5_000);
		hello = await client.waitForHello(5_000);
		client.onMessage((message) => {
			messages.push(message);
		});
	}

	const settle = (ms: number) => new Promise<void>((resolveSettle) => setTimeout(resolveSettle, ms));
	const waitFor = async (
		predicate: (message: DaemonOutbound) => boolean,
		timeoutMs = 10_000,
	): Promise<DaemonOutbound> => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const found = messages.find(predicate);
			if (found) {
				return found;
			}
			await settle(20);
		}
		throw new Error(`Timed out waiting for a daemon frame; saw ${JSON.stringify(messages.map((m) => m.type))}`);
	};
	const waitForCount = async (
		predicate: (message: DaemonOutbound) => boolean,
		count: number,
		timeoutMs = 10_000,
	): Promise<void> => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (messages.filter(predicate).length >= count) {
				return;
			}
			await settle(20);
		}
		throw new Error(
			`Timed out waiting for ${count} frames, saw ${messages.filter(predicate).length}: ${JSON.stringify(
				messages.map((message) => message.type),
			)}`,
		);
	};

	const harness: SupervisorHarness = {
		root,
		agentDir,
		projectDir,
		sessionDir,
		socketPath,
		descriptorDir,
		descriptorPath,
		session,
		sessions,
		worker,
		standIn,
		pid,
		client,
		hello,
		messages,
		supervisor,
		waitFor,
		waitForCount,
		settle,
		request: async (command, timeoutMs = 10_000) => {
			if (!client) {
				throw new Error("Harness was started without a client connection");
			}
			return client.request(command, timeoutMs);
		},
		listSessions: async () => {
			const response = await harness.request({ type: "list" });
			if (!response.success || !response.data || typeof response.data !== "object") {
				throw new Error(`Fixture list failed: ${response.success ? "no data" : response.error}`);
			}
			const data = response.data as { sessions?: SessionSummary[] };
			return data.sessions ?? [];
		},
		connectClient: async () => {
			const extra = new DaemonClient(socketPath);
			extraClients.push(extra);
			await extra.connect(5_000);
			const extraHello = await extra.waitForHello(5_000);
			const extraMessages: DaemonOutbound[] = [];
			extra.onMessage((message) => {
				extraMessages.push(message);
			});
			return { client: extra, hello: extraHello, messages: extraMessages };
		},
		scheduledJobsArtifactPath: () =>
			join(getSessionArtifactPathForFile(session.sessionFile, session.sessionId), SESSION_SCHEDULED_JOBS_FILENAME),
		logText: () => {
			const logPath = getDaemonLogPath(socketPath);
			return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
		},
		readDescriptor: () => {
			if (!existsSync(harness.descriptorPath)) {
				return undefined;
			}
			return JSON.parse(readFileSync(harness.descriptorPath, "utf8")) as DaemonWorkerDescriptor;
		},
		waitForDescriptorLifecycle: async (lifecycle, timeoutMs = 15_000) => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const descriptor = harness.readDescriptor();
				if ((descriptor?.lifecycle ?? undefined) === lifecycle) {
					return;
				}
				await settle(25);
			}
			throw new Error(
				`Timed out waiting for descriptor lifecycle ${lifecycle ?? "gone"}; last was ${
					harness.readDescriptor()?.lifecycle ?? "absent"
				}`,
			);
		},
		waitForWorkerReady: async (timeoutMs = 20_000) => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const listed = await harness.listSessions();
				if (listed.some((summary) => summary.workerState === "ready")) {
					return;
				}
				await settle(50);
			}
			throw new Error(`Worker never became ready; descriptor was ${JSON.stringify(harness.readDescriptor())}`);
		},
		descriptorNames: () =>
			readdirSync(harness.descriptorDir).filter((name) => name.endsWith(".json") && name !== "supervisor-config"),
		waitForSessionCount: async (predicate, timeoutMs = 10_000) => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const listed = await harness.listSessions();
				if (predicate(listed.length)) {
					return;
				}
				await settle(50);
			}
			throw new Error("Timed out waiting for the session list to satisfy the predicate");
		},
		processIsGone: async () => {
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				if (standIn && (standIn.child.exitCode !== null || standIn.child.signalCode !== null)) {
					return true;
				}
				await settle(25);
			}
			return false;
		},
		dispose: async () => {
			for (const extra of extraClients.splice(0)) {
				extra.close();
			}
			if (client) {
				client.close();
			}
			// dispose() releases the socket and timers without process.exit, which the
			// shutdown command would call and take the test worker down with it.
			await supervisor.dispose().catch(() => undefined);
			await worker?.close().catch(() => undefined);
			if (previousAgentDirEnv === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDirEnv;
			}
			if (standIn && standIn.child.exitCode === null && standIn.child.signalCode === null) {
				standIn.child.kill("SIGKILL");
			}
			rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		},
	};
	liveHarnesses.push(harness);
	return harness;
}

function spawnShortLivedProcess(): { child: ChildProcess; pid: number; processStartId: string | undefined } {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
	const pid = child.pid;
	if (pid === undefined) {
		throw new Error("Stand-in process did not report a pid");
	}
	return { child, pid, processStartId: getProcessStartId(pid) };
}

function waitForExit(child: ChildProcess): Promise<void> {
	return new Promise((resolveExit) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolveExit();
			return;
		}
		child.once("exit", () => resolveExit());
	});
}
