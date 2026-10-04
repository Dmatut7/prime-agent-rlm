import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { emptyGoalState } from "../src/core/goals.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	createAgentConnectionResourceSnapshot,
	createAgentConnectionState,
} from "../src/modes/agent-connection/snapshot.js";

describe("agent connection snapshots", () => {
	it("adds remote-friendly artifact references to resource snapshots", () => {
		const session = {
			sessionId: "session-1",
			sessionManager: {
				getCwd: () => "/workspace/project",
			},
			resourceLoader: {
				getAgentsFiles: () => ({
					agentsFiles: [{ path: "/workspace/project/AGENTS.md" }],
				}),
				getSkills: () => ({
					skills: [
						{
							name: "commit",
							description: "Commit changes",
							filePath: "/workspace/project/.prime/skills/commit/SKILL.md",
						},
					],
					diagnostics: [],
				}),
				getPrompts: () => ({
					prompts: [],
					diagnostics: [],
				}),
				getThemes: () => ({
					themes: [],
					diagnostics: [],
				}),
				getExtensions: () => ({
					extensions: [{ path: "/opt/prime/extensions/review/index.ts" }],
					errors: [],
				}),
			},
		} as unknown as AgentSession;

		const snapshot = createAgentConnectionResourceSnapshot(session);

		expect(snapshot.contextFiles[0]).toMatchObject({
			path: "/workspace/project/AGENTS.md",
			artifact: {
				id: expect.stringMatching(/^artifact_[a-f0-9]{16}$/),
				sessionId: "session-1",
				type: "context_file",
				logicalPath: "AGENTS.md",
				relativePath: "AGENTS.md",
			},
		});
		expect(snapshot.skills[0]?.artifact).toMatchObject({
			type: "skill",
			logicalPath: ".prime/skills/commit/SKILL.md",
			relativePath: ".prime/skills/commit/SKILL.md",
		});
		expect(snapshot.extensions[0]).toMatchObject({
			path: "/opt/prime/extensions/review/index.ts",
			artifact: {
				type: "extension",
				logicalPath: "index.ts",
			},
		});
		expect(snapshot.extensions[0]?.artifact).not.toHaveProperty("relativePath");
	});
});

describe("agent connection state auto-compaction flag", () => {
	const testDir = join(process.cwd(), "test-connection-state-autocompact-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	function sessionWith(
		settingsManager: SettingsManager,
		model: { provider: string; id: string } | undefined,
	): AgentSession {
		return {
			sessionId: "session-1",
			sessionManager: {
				getCwd: () => "/workspace/project",
				getSessionDir: () => "/workspace/project/.prime/sessions",
				getLeafId: () => "leaf-1",
				getEntries: () => [],
			},
			model,
			thinkingLevel: "medium",
			serviceTier: undefined,
			getAvailableThinkingLevels: () => ["medium"],
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			retryAttempt: 0,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionFile: "/tmp/session-1.jsonl",
			sessionName: "session-1 name",
			// The state builder must resolve the value on the settings side; touching
			// the session's own flag means the per-model resolution was skipped.
			get autoCompactionEnabled(): boolean {
				throw new Error("connection state must resolve auto-compaction from the settings side");
			},
			messages: [],
			getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
			goalState: emptyGoalState(),
			scopedModels: [],
			getActiveToolNames: () => [],
			getContextUsage: () => undefined,
			settingsManager,
		} as unknown as AgentSession;
	}

	function stateOf(settingsManager: SettingsManager, model: { provider: string; id: string } | undefined) {
		const runtime = { session: sessionWith(settingsManager, model) } as unknown as AgentSessionRuntime;
		return createAgentConnectionState(runtime);
	}

	it("reports the serving model's per-model entry, not the bare default", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setCompactionEnabledForModel("openai/gpt-5.1", false);

		const state = stateOf(manager, { provider: "openai", id: "gpt-5.1" });

		expect(state.autoCompactionEnabled).toBe(false);
		expect(manager.getCompactionEnabled()).toBe(true);
	});

	it("falls back to the bare default for a model without an entry", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setCompactionEnabled(false);
		manager.setCompactionEnabledForModel("openai/gpt-5.1", true);

		const withEntry = stateOf(manager, { provider: "openai", id: "gpt-5.1" });
		const withoutEntry = stateOf(manager, { provider: "anthropic", id: "claude-sonnet" });

		expect(withEntry.autoCompactionEnabled).toBe(true);
		expect(withoutEntry.autoCompactionEnabled).toBe(false);
	});

	it("reports the bare default when no model is in service", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setCompactionEnabled(false);

		expect(stateOf(manager, undefined).autoCompactionEnabled).toBe(false);
	});
});
