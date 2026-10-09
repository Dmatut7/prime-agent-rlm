import { describe, expect, it } from "vitest";
import {
	type AgentSessionRuntimeConfig,
	durableAgentSessionRuntimeConfig,
	mergeAgentSessionRuntimeConfig,
} from "../src/core/agent-session-config.js";

describe("mergeAgentSessionRuntimeConfig", () => {
	it("applies session overrides without mutating default config", () => {
		const defaults: AgentSessionRuntimeConfig = {
			cwd: "/repo/default",
			agentDir: "/agent/default",
			model: "openai/gpt-4o",
			tools: ["ipython"],
			noTools: true,
			extensionFlagValues: { plan: true },
		};

		const overrides: AgentSessionRuntimeConfig = {
			cwd: "/repo/session",
			model: "anthropic/claude-sonnet-4-5",
			tools: ["bash"],
			noTools: false,
			extensionFlagValues: { mode: "fast" },
		};
		const merged = mergeAgentSessionRuntimeConfig(defaults, overrides);

		expect(merged).toEqual({
			cwd: "/repo/session",
			agentDir: "/agent/default",
			model: "anthropic/claude-sonnet-4-5",
			tools: ["bash"],
			noTools: false,
			extensionFlagValues: { plan: true, mode: "fast" },
		});
		expect(merged.tools).not.toBe(overrides.tools);
		expect(merged.extensionFlagValues).not.toBe(defaults.extensionFlagValues);
		expect(defaults).toEqual({
			cwd: "/repo/default",
			agentDir: "/agent/default",
			model: "openai/gpt-4o",
			tools: ["ipython"],
			noTools: true,
			extensionFlagValues: { plan: true },
		});
	});

	it("keeps default arrays when a session override omits them", () => {
		const defaults: AgentSessionRuntimeConfig = {
			appendSystemPrompt: ["default prompt"],
			models: ["openai/gpt-4o"],
			extensions: ["/agent/ext.js"],
			skills: ["/agent/skill.md"],
			promptTemplates: ["/agent/template.md"],
			themes: ["/agent/theme.json"],
		};

		const merged = mergeAgentSessionRuntimeConfig(defaults, { model: "openai/gpt-4o-mini" });
		expect(merged).toEqual({
			appendSystemPrompt: ["default prompt"],
			models: ["openai/gpt-4o"],
			extensions: ["/agent/ext.js"],
			skills: ["/agent/skill.md"],
			promptTemplates: ["/agent/template.md"],
			themes: ["/agent/theme.json"],
			model: "openai/gpt-4o-mini",
		});
		expect(merged.models).not.toBe(defaults.models);
		expect(merged.extensions).not.toBe(defaults.extensions);
	});

	it("deep-merges autonomous gate overrides", () => {
		const defaults: AgentSessionRuntimeConfig = {
			autonomous: {
				enabled: true,
				maxTurns: 20,
				gates: { commands: ["npm test"], maxRetries: 3 },
			},
		};

		const overrides: AgentSessionRuntimeConfig = {
			autonomous: {
				maxContinuations: 5,
				gates: { timeoutMs: 1000 },
			},
		};

		const merged = mergeAgentSessionRuntimeConfig(defaults, overrides);

		expect(merged.autonomous).toEqual({
			enabled: true,
			maxTurns: 20,
			maxContinuations: 5,
			gates: { commands: ["npm test"], maxRetries: 3, timeoutMs: 1000 },
		});
		expect(merged.autonomous?.gates?.commands).not.toBe(defaults.autonomous?.gates?.commands);
	});

	it("ignores undefined override values", () => {
		const defaults: AgentSessionRuntimeConfig = {
			cwd: "/repo/default",
			agentDir: "/agent/default",
			model: "openai/gpt-4o",
			tools: ["ipython"],
		};

		const merged = mergeAgentSessionRuntimeConfig(defaults, {
			cwd: undefined,
			model: undefined,
			tools: undefined,
			noTools: false,
		});

		expect(merged).toEqual({
			cwd: "/repo/default",
			agentDir: "/agent/default",
			model: "openai/gpt-4o",
			tools: ["ipython"],
			noTools: false,
		});
	});

	it("merges initialGoal from override over base", () => {
		const defaults: AgentSessionRuntimeConfig = {
			cwd: "/repo",
			agentDir: "/agent",
			initialGoal: { objective: "base goal", tokenBudget: 50000 },
		};
		const merged = mergeAgentSessionRuntimeConfig(defaults, {
			cwd: "/override",
			initialGoal: { objective: "override goal" },
		});
		expect(merged.initialGoal).toEqual({ objective: "override goal" });
	});

	it("preserves base initialGoal when override omits it", () => {
		const defaults: AgentSessionRuntimeConfig = {
			cwd: "/repo",
			agentDir: "/agent",
			initialGoal: { objective: "base goal", tokenBudget: 50000 },
		};
		const merged = mergeAgentSessionRuntimeConfig(defaults, { model: "openai/gpt-4o" });
		expect(merged.initialGoal).toEqual({ objective: "base goal", tokenBudget: 50000 });
	});

	it("clones initialGoal so mutating the original does not affect the merged config", () => {
		const base: AgentSessionRuntimeConfig = {
			cwd: "/repo",
			agentDir: "/agent",
			initialGoal: { objective: "base goal", tokenBudget: 50000 },
		};
		const merged = mergeAgentSessionRuntimeConfig(base);
		expect(merged.initialGoal).toEqual({ objective: "base goal", tokenBudget: 50000 });
		// Mutating the original should not affect the clone
		base.initialGoal!.objective = "mutated";
		expect(merged.initialGoal?.objective).toBe("base goal");
	});

	it("preserves and overrides the user-facing execution mode across daemon config merges", () => {
		const base: AgentSessionRuntimeConfig = {
			cwd: "/repo",
			executionMode: "interactive",
		};

		expect(mergeAgentSessionRuntimeConfig(base, { model: "openai/gpt-4o" }).executionMode).toBe("interactive");
		expect(mergeAgentSessionRuntimeConfig(base, { executionMode: "rpc" }).executionMode).toBe("rpc");
		expect(mergeAgentSessionRuntimeConfig(base).executionMode).toBe("interactive");
	});

	it("keeps the daemon telemetry opt-out monotonic across config merges", () => {
		expect(mergeAgentSessionRuntimeConfig({ telemetryDisabled: true }, {}).telemetryDisabled).toBe(true);
		expect(mergeAgentSessionRuntimeConfig({}, { telemetryDisabled: true }).telemetryDisabled).toBe(true);
		expect(mergeAgentSessionRuntimeConfig({}, {}).telemetryDisabled).toBeUndefined();
	});

	it("carries the project trust override and decision through config merges", () => {
		const base: AgentSessionRuntimeConfig = {
			cwd: "/repo",
			projectTrustOverride: true,
			projectTrustDecision: { cwd: "/repo", trusted: true },
		};

		// An unrelated override keeps both trust fields.
		const kept = mergeAgentSessionRuntimeConfig(base, { model: "openai/gpt-4o" });
		expect(kept.projectTrustOverride).toBe(true);
		expect(kept.projectTrustDecision).toEqual({ cwd: "/repo", trusted: true });

		// A later override replaces them (e.g. the worker's per-create config).
		const replaced = mergeAgentSessionRuntimeConfig(base, {
			projectTrustOverride: false,
			projectTrustDecision: { cwd: "/other", trusted: false },
		});
		expect(replaced.projectTrustOverride).toBe(false);
		expect(replaced.projectTrustDecision).toEqual({ cwd: "/other", trusted: false });
	});

	it("clones the project trust decision so the merged config owns its copy", () => {
		const base: AgentSessionRuntimeConfig = {
			cwd: "/repo",
			projectTrustDecision: { cwd: "/repo", trusted: true },
		};
		const merged = mergeAgentSessionRuntimeConfig(base);
		base.projectTrustDecision!.trusted = false;
		expect(merged.projectTrustDecision?.trusted).toBe(true);
	});

	it("persists only typed daemon host settings", () => {
		const durable = durableAgentSessionRuntimeConfig({
			cwd: "/repo",
			agentDir: "/agent",
			sessionDir: "/sessions",
			telemetryDisabled: true,
			provider: "intercept",
			model: "openai/example",
			apiKey: "secret-api-key",
			extensionFlagValues: { providerSecretKey: "secret-extension-key" },
			initialGoal: { objective: "transient" },
		});

		expect(durable).toEqual({
			cwd: "/repo",
			agentDir: "/agent",
			sessionDir: "/sessions",
			telemetryDisabled: true,
		});
		expect(
			durableAgentSessionRuntimeConfig({
				cwd: 1,
				agentDir: "/agent",
				sessionDir: false,
				telemetryDisabled: "yes",
			} as unknown as AgentSessionRuntimeConfig),
		).toEqual({ agentDir: "/agent" });
	});
});
