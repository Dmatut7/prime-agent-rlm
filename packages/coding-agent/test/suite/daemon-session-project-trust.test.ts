/**
 * Real daemon-backed tests for session-scoped project trust survival.
 *
 * The interactive client resolves a session-only trust answer ("trust this
 * session, do not remember") in its own process and ships it in the create
 * command's config. The durable create a worker replays after a crash
 * (durableDaemonCreateCommand) strips config, so the recovered runtime used to
 * find no decision, fall back to the undecided trust store, fail closed, and
 * silently strip the extensions of an unattended task. The fix records the
 * decision in the session's own transcript (a custom entry) and reads it back
 * on a config-less create.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../../src/core/agent-session-runtime.js";
import { ProjectTrustStore } from "../../src/core/project-trust.js";
import { SessionManager } from "../../src/core/session-manager.js";
import type { ActiveSessionState } from "../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand } from "../../src/modes/daemon/daemon-protocol.js";
import { createHarness } from "./harness.js";

type DaemonInternals = {
	createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
};

function daemonInternals(daemon: AgentDaemon): DaemonInternals {
	// test-hygiene-allow: AgentDaemon has no public client-less create entry; this mirrors the frozen worker-create cast in test/suite/daemon-serialized-refine.test.ts and touches nothing else
	return daemon as unknown as DaemonInternals;
}

/** A persisted session file for cwd, as a resumed interactive session has on disk. */
function createSessionFile(cwd: string, sessionDir: string): string {
	const sessionManager = SessionManager.create(cwd, sessionDir);
	sessionManager.newSession();
	const sessionFile = sessionManager.getSessionFile()!;
	writeFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd,
		})}\n`,
		"utf-8",
	);
	return sessionFile;
}

/** A worker incarnation whose createRuntime factory records the merged session config. */
function capturingWorker(): { createRuntime: CreateAgentSessionRuntimeFactory; captured: () => unknown } {
	let sessionConfig: unknown;
	const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
		sessionConfig = options.sessionConfig;
		const harness = await createHarness({ persistSession: true });
		return {
			session: harness.session,
			extensionsResult: { extensions: [], errors: [], runtime: {} } as never,
			services: { cwd: options.cwd, agentDir: options.agentDir } as never,
			diagnostics: [],
		} as never;
	});
	return { createRuntime, captured: () => sessionConfig };
}

describe("daemon session-scoped project trust", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("restores a session-only trust decision when a worker re-creates the session from the durable command", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-daemon-session-trust-"));
		tempDirs.push(tempDir);
		const sessionDir = join(tempDir, "sessions");
		const defaultSessionConfig = { agentDir: tempDir, cwd: tempDir, sessionDir };

		// Worker incarnation 1: the interactive client's create carries the
		// session-only decision in its config.
		const first = capturingWorker();
		const daemonOne = new AgentDaemon(join(tempDir, "daemon-one.sock"), {
			defaultSessionConfig,
			createRuntime: first.createRuntime,
		});

		const sessionFile = createSessionFile(tempDir, sessionDir);

		const state = await daemonInternals(daemonOne).createRuntime({
			type: "create",
			sessionPath: sessionFile,
			config: { cwd: tempDir, agentDir: tempDir, projectTrustDecision: { cwd: tempDir, trusted: true } },
		});
		expect(
			(first.captured() as { projectTrustDecision?: { cwd: string; trusted: boolean } }).projectTrustDecision,
		).toEqual({
			cwd: tempDir,
			trusted: true,
		});
		state.runtime.session.dispose();

		// Worker incarnation 2 (crash recovery): the durable create command
		// carries no config at all.
		const second = capturingWorker();
		const daemonTwo = new AgentDaemon(join(tempDir, "daemon-two.sock"), {
			defaultSessionConfig,
			createRuntime: second.createRuntime,
		});

		const recovered = await daemonInternals(daemonTwo).createRuntime({ type: "create", sessionPath: sessionFile });

		// The session-scoped decision survived the worker restart in the
		// session transcript, so the recovered runtime still loads extensions.
		expect(
			(second.captured() as { projectTrustDecision?: { cwd: string; trusted: boolean } }).projectTrustDecision,
		).toEqual({ cwd: tempDir, trusted: true });
		recovered.runtime.session.dispose();
	});

	it("lets a persisted store decision outrank the session-scoped entry", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-daemon-session-trust-store-"));
		tempDirs.push(tempDir);
		const sessionDir = join(tempDir, "sessions");
		const defaultSessionConfig = { agentDir: tempDir, cwd: tempDir, sessionDir };

		const first = capturingWorker();
		const daemonOne = new AgentDaemon(join(tempDir, "daemon-one.sock"), {
			defaultSessionConfig,
			createRuntime: first.createRuntime,
		});

		const sessionFile = createSessionFile(tempDir, sessionDir);

		const state = await daemonInternals(daemonOne).createRuntime({
			type: "create",
			sessionPath: sessionFile,
			config: { cwd: tempDir, agentDir: tempDir, projectTrustDecision: { cwd: tempDir, trusted: true } },
		});
		state.runtime.session.dispose();

		// The user later marks the directory not trusted in the persisted store.
		new ProjectTrustStore(tempDir).set(tempDir, false);

		const second = capturingWorker();
		const daemonTwo = new AgentDaemon(join(tempDir, "daemon-two.sock"), {
			defaultSessionConfig,
			createRuntime: second.createRuntime,
		});

		const recovered = await daemonInternals(daemonTwo).createRuntime({ type: "create", sessionPath: sessionFile });

		// A persisted decision (either direction) wins: the loader fails closed
		// off the store instead of resurrecting the stale session grant.
		expect((second.captured() as { projectTrustDecision?: unknown }).projectTrustDecision).toBeUndefined();
		recovered.runtime.session.dispose();
	});

	it("never records a run-wide --approve override as a session-scoped grant", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-daemon-session-trust-override-"));
		tempDirs.push(tempDir);
		const sessionDir = join(tempDir, "sessions");
		const defaultSessionConfig = { agentDir: tempDir, cwd: tempDir, sessionDir };

		const first = capturingWorker();
		const daemonOne = new AgentDaemon(join(tempDir, "daemon-one.sock"), {
			defaultSessionConfig,
			createRuntime: first.createRuntime,
		});

		const sessionFile = createSessionFile(tempDir, sessionDir);

		const state = await daemonInternals(daemonOne).createRuntime({
			type: "create",
			sessionPath: sessionFile,
			config: {
				cwd: tempDir,
				agentDir: tempDir,
				projectTrustOverride: true,
				projectTrustDecision: { cwd: tempDir, trusted: true },
			},
		});
		state.runtime.session.dispose();

		const second = capturingWorker();
		const daemonTwo = new AgentDaemon(join(tempDir, "daemon-two.sock"), {
			defaultSessionConfig,
			createRuntime: second.createRuntime,
		});

		const recovered = await daemonInternals(daemonTwo).createRuntime({ type: "create", sessionPath: sessionFile });

		// A single-run --approve must not escalate into a permanent session grant.
		expect((second.captured() as { projectTrustDecision?: unknown }).projectTrustDecision).toBeUndefined();
		recovered.runtime.session.dispose();
	});
});
