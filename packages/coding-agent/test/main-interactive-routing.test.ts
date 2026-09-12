import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { StaleDaemonError } from "../src/cli/daemon-launch.js";
import { mergeAgentSessionRuntimeConfig } from "../src/core/agent-session-config.js";
import type { CreateAgentSessionOptions } from "../src/core/sdk.js";
import {
	type AppMode,
	type DaemonCreatePrefireDecision,
	type DaemonInteractivePrefire,
	type DaemonInteractiveSessionManagerDecision,
	daemonServerDefaultSessionConfig,
	disposePrefiredDaemonConnection,
	findActiveDaemonSessionSummaryForSessionFile,
	type InteractiveDaemonStartupDecision,
	isClientOwnedDaemonSession,
	parseAgentsViewCommand,
	prefireDaemonInteractiveConnection,
	resolveRuntimeSessionOptions,
	shouldEnsureDaemonBeforeActiveSessionLookup,
	shouldEnsureInteractiveDaemonForStartup,
	shouldOpenAgentsViewForDaemonInteractive,
	shouldPrefireDaemonCreateForDaemonInteractive,
	shouldRejectNonInteractiveAttach,
	shouldRejectNonInteractiveBareResume,
	shouldUseDaemonClient,
	shouldUseDaemonClientRuntime,
	shouldUseDaemonInteractive,
	shouldUseEphemeralSessionManagerForDaemonInteractive,
} from "../src/main.js";
import type { DaemonAgentConnection, SessionSummary } from "../src/modes/index.js";

describe("interactive startup routing", () => {
	test.each([
		["acp", false, undefined, true],
		["acp", true, undefined, true],
		["acp", false, true, false],
		["acp", true, true, true],
		["rpc", false, undefined, true],
		["print", false, undefined, true],
	] as const)("classifies %s noSession=%s acpResident=%s ownership", (appMode, noSession, acpResident, expected) => {
		expect(isClientOwnedDaemonSession(appMode, noSession, acpResident)).toBe(expected);
	});

	test.each(["interactive", "print", "json", "rpc"] as const)(
		"uses the daemon runtime for the %s client",
		(appMode) => {
			expect(
				shouldUseDaemonClient({
					appMode,
					startupBenchmark: false,
				}),
			).toBe(true);
		},
	);

	test("uses a client-owned daemon session for --no-session", () => {
		expect(
			shouldUseDaemonClient({
				appMode: "interactive",
				startupBenchmark: false,
				noSession: true,
			}),
		).toBe(true);
	});

	test("keeps process-local extension factories and rollback workers in process", () => {
		expect(
			shouldUseDaemonClientRuntime({
				appMode: "print",
				startupBenchmark: false,
				hasProcessLocalExtensionFactories: true,
			}),
		).toBe(false);
		expect(
			shouldUseDaemonClientRuntime({
				appMode: "rpc",
				startupBenchmark: false,
				ownedSessionWorker: true,
			}),
		).toBe(false);
	});

	test.each([
		["daemon process", { appMode: "daemon", startupBenchmark: false }],
		["startup benchmark", { appMode: "interactive", startupBenchmark: true }],
		["help", { appMode: "interactive", startupBenchmark: false, help: true }],
		["model listing", { appMode: "interactive", startupBenchmark: false, listModels: true }],
	] satisfies Array<[string, InteractiveDaemonStartupDecision]>)(
		"keeps %s out of daemon client routing",
		(_label, decision) => {
			expect(shouldUseDaemonClient(decision)).toBe(false);
		},
	);

	test("uses daemon-backed interactive mode for normal interactive startup", () => {
		expect(
			shouldUseDaemonInteractive({
				appMode: "interactive",
				startupBenchmark: false,
			}),
		).toBe(true);
	});

	const nonInteractiveModes: Array<[AppMode, string]> = [
		["print", "print mode"],
		["json", "json mode"],
		["rpc", "rpc mode"],
		["daemon", "daemon mode"],
	];

	test.each(nonInteractiveModes)("does not use daemon-backed interactive mode for %s", (appMode) => {
		expect(
			shouldUseDaemonInteractive({
				appMode,
				startupBenchmark: false,
			}),
		).toBe(false);
	});

	type InteractiveFallbackOverrides = Partial<
		Pick<InteractiveDaemonStartupDecision, "startupBenchmark" | "noSession" | "listModels">
	>;

	const fallbackCases: Array<[string, InteractiveFallbackOverrides]> = [
		["startup benchmark", { startupBenchmark: true }],
		["--no-session", { noSession: true }],
		["--list-models", { listModels: true }],
		["--list-models search", { listModels: "claude" }],
	];

	test.each(fallbackCases)("keeps %s on the non-daemon interactive path", (_label, overrides) => {
		expect(
			shouldUseDaemonInteractive({
				appMode: "interactive",
				startupBenchmark: false,
				...overrides,
			}),
		).toBe(false);
	});

	test("rejects interactive-only selectors before non-interactive startup", () => {
		expect(shouldRejectNonInteractiveAttach("worker", "print")).toBe(true);
		expect(shouldRejectNonInteractiveAttach("worker", "interactive")).toBe(false);
		expect(shouldRejectNonInteractiveAttach(undefined, "print")).toBe(false);
		expect(shouldRejectNonInteractiveBareResume(true, "print")).toBe(true);
		expect(shouldRejectNonInteractiveBareResume(true, "rpc")).toBe(true);
		expect(shouldRejectNonInteractiveBareResume("session-id", "print")).toBe(false);
		expect(shouldRejectNonInteractiveBareResume(true, "interactive")).toBe(false);
	});

	test("does not start the daemon for attach", () => {
		expect(shouldEnsureInteractiveDaemonForStartup(true, undefined)).toBe(true);
		expect(shouldEnsureInteractiveDaemonForStartup(true, "worker")).toBe(false);
		expect(shouldEnsureInteractiveDaemonForStartup(false, undefined)).toBe(false);
	});
});

describe("daemon-backed interactive session manager routing", () => {
	test("opens a new chat (not the agents view) for default daemon-backed interactive startup", () => {
		expect(
			shouldOpenAgentsViewForDaemonInteractive({
				useDaemonInteractive: true,
				needsOnboarding: false,
			}),
		).toBe(false);
	});

	test("opens the agents view when explicitly requested", () => {
		expect(
			shouldOpenAgentsViewForDaemonInteractive({
				useDaemonInteractive: true,
				needsOnboarding: false,
				explicitAgentsView: true,
			}),
		).toBe(true);
	});

	const directAttachCases: Array<[string, Parameters<typeof shouldOpenAgentsViewForDaemonInteractive>[0]]> = [
		[
			"non-daemon interactive path",
			{ useDaemonInteractive: false, needsOnboarding: false, explicitAgentsView: true },
		],
		["pending onboarding", { useDaemonInteractive: true, needsOnboarding: true, explicitAgentsView: true }],
		[
			"resume selector",
			{ useDaemonInteractive: true, needsOnboarding: false, explicitAgentsView: true, resume: "active-1" },
		],
		[
			"continue recent",
			{ useDaemonInteractive: true, needsOnboarding: false, explicitAgentsView: true, continue: true },
		],
		[
			"fork",
			{ useDaemonInteractive: true, needsOnboarding: false, explicitAgentsView: true, fork: "source-session-id" },
		],
	];

	test.each(directAttachCases)("does not open agents view for %s", (_label, decision) => {
		expect(shouldOpenAgentsViewForDaemonInteractive(decision)).toBe(false);
	});

	test.each([false, true])("opens the agents view for bare --resume (onboarding=%s)", (needsOnboarding) => {
		expect(
			shouldOpenAgentsViewForDaemonInteractive({
				useDaemonInteractive: true,
				needsOnboarding,
				resume: true,
			}),
		).toBe(true);
	});

	test("prefires the daemon create RPC for startup that cannot detour to the agents view", () => {
		expect(shouldPrefireDaemonCreateForDaemonInteractive({})).toBe(true);
		expect(shouldPrefireDaemonCreateForDaemonInteractive({ resume: "active-1" })).toBe(true);
	});

	const noPrefireCases: Array<[string, DaemonCreatePrefireDecision]> = [
		["bare --resume", { resume: true }],
		["explicit agents view", { explicitAgentsView: true }],
		["agents verb with a resume selector", { resume: "active-1", explicitAgentsView: true }],
	];

	test.each(noPrefireCases)("keeps %s on the sequential create path", (_label, decision) => {
		expect(shouldPrefireDaemonCreateForDaemonInteractive(decision)).toBe(false);
	});

	test("never prefires a create the agents view could leave unconsumed", () => {
		const resumes: Array<true | string | undefined> = [undefined, true, "active-1"];
		const flags = [false, true];
		const combinations: Array<Parameters<typeof shouldOpenAgentsViewForDaemonInteractive>[0]> = [];
		for (const resume of resumes) {
			for (const explicitAgentsView of flags) {
				for (const needsOnboarding of flags) {
					for (const cont of flags) {
						for (const fork of [undefined, "source-session-id"]) {
							combinations.push({
								useDaemonInteractive: true,
								needsOnboarding,
								explicitAgentsView,
								resume,
								continue: cont,
								fork,
							});
						}
					}
				}
			}
		}
		expect(combinations.length).toBeGreaterThan(0);
		for (const combination of combinations) {
			const prefires = shouldPrefireDaemonCreateForDaemonInteractive({
				resume: combination.resume,
				explicitAgentsView: combination.explicitAgentsView,
			});
			if (prefires) {
				expect(shouldOpenAgentsViewForDaemonInteractive(combination)).toBe(false);
			}
		}
	});

	test("ensures daemon is available before probing non-path session selectors", () => {
		expect(
			shouldEnsureDaemonBeforeActiveSessionLookup({
				useDaemonInteractive: true,
				resumeSelector: "active-1",
			}),
		).toBe(true);
		expect(
			shouldEnsureDaemonBeforeActiveSessionLookup({
				useDaemonInteractive: true,
				resumeSelector: "/tmp/session.jsonl",
			}),
		).toBe(false);
		expect(
			shouldEnsureDaemonBeforeActiveSessionLookup({
				useDaemonInteractive: true,
				resumeSelector: "/tmp/session.jsonl",
				explicitAttach: true,
			}),
		).toBe(true);
		expect(
			shouldEnsureDaemonBeforeActiveSessionLookup({
				useDaemonInteractive: false,
				resumeSelector: "active-1",
			}),
		).toBe(false);
	});

	test("uses an ephemeral local session manager for fresh daemon-owned sessions", () => {
		expect(shouldUseEphemeralSessionManagerForDaemonInteractive({})).toBe(true);
	});

	const persistentSelectionCases: Array<[string, DaemonInteractiveSessionManagerDecision]> = [
		["active daemon attach", { hasActiveDaemonSession: true }],
		["explicit saved session", { resume: "saved-session-id" }],
		["continue recent", { continue: true }],
		["fork", { fork: "source-session-id" }],
	];

	test.each(persistentSelectionCases)("keeps %s on a concrete local session manager", (_label, decision) => {
		expect(shouldUseEphemeralSessionManagerForDaemonInteractive(decision)).toBe(false);
	});

	test("uses an ephemeral local session manager for bare --resume", () => {
		expect(shouldUseEphemeralSessionManagerForDaemonInteractive({ resume: true })).toBe(true);
	});

	test("finds an active daemon session by resolved session file", () => {
		const inactiveSummary = makeSessionSummary({
			id: "saved-1",
			activeSessionId: undefined,
			sessionFile: "/tmp/project/session.jsonl",
		});
		const activeSummary = makeSessionSummary({
			id: "active-1",
			activeSessionId: "active-1",
			sessionFile: "/tmp/project/session.jsonl",
		});

		expect(
			findActiveDaemonSessionSummaryForSessionFile(
				[inactiveSummary, activeSummary],
				"/tmp/project/../project/session.jsonl",
			),
		).toBe(activeSummary);
	});

	test("finds an active daemon session through a symlinked resume path", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-agent-resume-"));
		try {
			const sessionFile = join(directory, "session.jsonl");
			const symlink = join(directory, "session-link.jsonl");
			writeFileSync(sessionFile, "");
			symlinkSync(sessionFile, symlink);
			const activeSummary = makeSessionSummary({
				id: "active-1",
				activeSessionId: "active-1",
				sessionFile,
			});

			expect(findActiveDaemonSessionSummaryForSessionFile([activeSummary], symlink)).toBe(activeSummary);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("agents view command parsing", () => {
	test("routes the agents verb to the agents view and strips it", () => {
		expect(parseAgentsViewCommand(["agents"])).toEqual({ explicitAgentsView: true, args: [] });
	});

	test("does not treat manage as an alias", () => {
		expect(parseAgentsViewCommand(["manage", "--verbose"])).toEqual({
			explicitAgentsView: false,
			args: ["manage", "--verbose"],
		});
	});

	test("leaves a normal message untouched", () => {
		expect(parseAgentsViewCommand(["fix the agents view"])).toEqual({
			explicitAgentsView: false,
			args: ["fix the agents view"],
		});
	});

	test("only matches the verb as the first token", () => {
		expect(parseAgentsViewCommand(["--verbose", "agents"])).toEqual({
			explicitAgentsView: false,
			args: ["--verbose", "agents"],
		});
	});
});

describe("runtime session option resolution", () => {
	test("keeps verifier goals per session instead of in the daemon fallback", () => {
		const headlessCreateConfig = {
			cwd: "/repo",
			serializedRefine: true,
			initialGoal: { objective: "solve the verifier task", tokenBudget: 100_000 },
		};

		expect(headlessCreateConfig.initialGoal).toEqual({
			objective: "solve the verifier task",
			tokenBudget: 100_000,
		});
		const daemonFallback = daemonServerDefaultSessionConfig(headlessCreateConfig);
		expect(daemonFallback).toEqual({
			cwd: "/repo",
			serializedRefine: true,
			initialGoal: undefined,
		});
		expect(
			mergeAgentSessionRuntimeConfig(daemonFallback, {
				initialGoal: headlessCreateConfig.initialGoal,
			}),
		).toMatchObject({ initialGoal: headlessCreateConfig.initialGoal });
	});

	test("preserves daemon-provided RLM heartbeat controller when creating sessions", () => {
		const preparedModel = { id: "prepared-model" } as unknown as CreateAgentSessionOptions["model"];
		const runtimeModel = { id: "runtime-model" } as unknown as CreateAgentSessionOptions["model"];
		const rlmHeartbeatController: NonNullable<CreateAgentSessionOptions["rlmHeartbeatController"]> = {
			listRlmHeartbeats: () => [],
			createRlmHeartbeat: () => {
				throw new Error("not used");
			},
			updateRlmHeartbeat: () => undefined,
			deleteRlmHeartbeat: () => undefined,
		};

		const resolved = resolveRuntimeSessionOptions(
			{
				model: preparedModel,
				tools: ["ipython"],
				customTools: [],
			},
			{
				model: runtimeModel,
				rlmHeartbeatController,
				rlmDepth: 1,
				rlmSessionDir: "/tmp/rlm-session",
			},
		);

		expect(resolved).toMatchObject({
			model: runtimeModel,
			tools: ["ipython"],
			customTools: [],
			rlmHeartbeatController,
			rlmDepth: 1,
			rlmSessionDir: "/tmp/rlm-session",
		});
	});

	test("preserves the runtime child parent-agent identity", () => {
		const resolved = resolveRuntimeSessionOptions({}, { rlmDepth: 1, rlmParentAgent: "parent-worker" });

		expect(resolved.rlmParentAgent).toBe("parent-worker");
	});

	test("forwards semantic spawn lineage to the created child session", () => {
		const resolved = resolveRuntimeSessionOptions(
			{},
			{
				rlmDepth: 1,
				semanticParentSessionId: "parent-session-id",
				semanticSpawnedByRequestId: "a".repeat(32),
			},
		);

		expect(resolved.semanticParentSessionId).toBe("parent-session-id");
		expect(resolved.semanticSpawnedByRequestId).toBe("a".repeat(32));
	});

	test("deep-merges autonomous runtime session overrides", () => {
		const resolved = resolveRuntimeSessionOptions(
			{
				autonomous: {
					enabled: true,
					maxTurns: 20,
					gates: { commands: ["npm test"], maxRetries: 3 },
				},
			},
			{
				autonomous: {
					maxContinuations: 5,
					gates: { timeoutMs: 1000 },
				},
			},
		);

		expect(resolved.autonomous).toEqual({
			enabled: true,
			maxTurns: 20,
			maxContinuations: 5,
			gates: { commands: ["npm test"], maxRetries: 3, timeoutMs: 1000 },
		});
	});

	test("disables autonomous mode for subagent runtime sessions", () => {
		const resolved = resolveRuntimeSessionOptions(
			{
				autonomous: {
					enabled: true,
					maxTurns: 20,
					gates: { commands: ["npm test"], maxRetries: 3 },
				},
			},
			{
				rlmDepth: 1,
				autonomous: {
					maxContinuations: 5,
					gates: { timeoutMs: 1000 },
				},
			},
		);

		expect(resolved.autonomous).toEqual({
			enabled: false,
			maxTurns: 20,
			maxContinuations: 5,
			gates: { commands: ["npm test"], maxRetries: 3, timeoutMs: 1000 },
		});
	});
});

describe("prefired daemon create disposal", () => {
	function makePrefire(overrides: Partial<DaemonInteractivePrefire> = {}): DaemonInteractivePrefire {
		return {
			readySettled: Promise.resolve({ ready: undefined }),
			connection: new Promise<{ connection: DaemonAgentConnection; summary: SessionSummary }>(() => {}),
			cancel: () => {},
			...overrides,
		};
	}

	function makeStubConnection(onDispose: () => void): DaemonAgentConnection {
		return { dispose: async () => onDispose() } as unknown as DaemonAgentConnection;
	}

	test("cancelling a prefire stops the create RPC from firing", async () => {
		let fired = 0;
		const prefire = prefireDaemonInteractiveConnection(undefined, () => {
			fired += 1;
			return Promise.resolve({
				connection: makeStubConnection(() => {}),
				summary: makeSessionSummary({ id: "prefired" }),
			});
		});
		prefire.cancel();
		await expect(prefire.connection).rejects.toThrow(/cancelled/);
		expect(fired).toBe(0);
	});

	test("an aborted startup skips the stale-daemon takeover instead of prompting on stdin", async () => {
		const prefire = prefireDaemonInteractiveConnection(
			Promise.reject(new StaleDaemonError("/tmp/prime-agent-aborted-takeover.sock")),
			() =>
				Promise.resolve({
					connection: makeStubConnection(() => {}),
					summary: makeSessionSummary({ id: "prefired" }),
				}),
		);
		prefire.cancel();
		await expect(prefire.readySettled).rejects.toThrow(/aborted before the stale daemon/);
	});

	test("an abort does not stall on a create that never settles", async () => {
		let cancelled = false;
		const started = Date.now();
		await disposePrefiredDaemonConnection(
			makePrefire({
				cancel: () => {
					cancelled = true;
				},
			}),
			50,
		);
		expect(cancelled).toBe(true);
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	test("an abort still detaches a create that already landed", async () => {
		let disposed = 0;
		await disposePrefiredDaemonConnection(
			makePrefire({
				connection: Promise.resolve({
					connection: makeStubConnection(() => {
						disposed += 1;
					}),
					summary: makeSessionSummary({ id: "prefired" }),
				}),
			}),
			5_000,
		);
		expect(disposed).toBe(1);
	});
});

function makeSessionSummary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: "session-1",
		lifecycle: "draft",
		activity: "idle",
		sessionId: "session-1",
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
		isSessionActive: overrides.isSessionActive ?? false,
	};
}
