import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { preflightCliModelDiagnostics } from "../src/main.js";

/**
 * wave-38 MODEL-PERSIST (T1): a --model that names nothing, or names a model whose
 * provider has no credentials, must fail at parse time with a distinct, actionable
 * error - never silently fall back to the default and fail at the API later.
 */

function agentDirWith(modelsJson: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "wave38-preflight-"));
	writeFileSync(join(dir, "models.json"), JSON.stringify(modelsJson), "utf-8");
	return dir;
}

function registryFor(agentDir: string): ModelRegistry {
	return ModelRegistry.create(AuthStorage.create(join(agentDir, "auth.json")), join(agentDir, "models.json"));
}

const MODELS_JSON = {
	providers: {
		myco: {
			baseUrl: "https://myco.invalid/v1",
			api: "openai-completions",
			apiKey: "test-key",
			models: [{ id: "myco-model", name: "MyCo Model", reasoning: false, input: ["text"] }],
		},
	},
};

// A built-in catalog model whose provider's env credential is stubbed away stands
// in for "in the catalog, but not runnable here".
const UNAUTHED = { provider: "cerebras", id: "gpt-oss-120b", env: "CEREBRAS_API_KEY" };

describe("preflightCliModelDiagnostics", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("reports nothing when no --model was passed", () => {
		expect(preflightCliModelDiagnostics({ agentDir: agentDirWith(MODELS_JSON) })).toEqual([]);
	});

	it("a model that exists with credentials passes", () => {
		const agentDir = agentDirWith(MODELS_JSON);
		expect(
			preflightCliModelDiagnostics({ cliModel: "myco/myco-model", agentDir, modelRegistry: registryFor(agentDir) }),
		).toEqual([]);
	});

	it("an unknown model name is an error at parse time, not an API surprise later", () => {
		const agentDir = agentDirWith(MODELS_JSON);
		const diagnostics = preflightCliModelDiagnostics({
			cliModel: "totally-nonexistent-model-xyz",
			agentDir,
			modelRegistry: registryFor(agentDir),
		});

		const errors = diagnostics.filter((diagnostic) => diagnostic.type === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]!.message).toContain("totally-nonexistent-model-xyz");
		expect(errors[0]!.message).toContain("not found");
	});

	it("a model whose provider has no credentials says so, apart from 'not found'", () => {
		vi.stubEnv(UNAUTHED.env, undefined as unknown as string);
		const agentDir = agentDirWith(MODELS_JSON);
		const registry = registryFor(agentDir);
		expect(registry.find(UNAUTHED.provider, UNAUTHED.id)).toBeDefined();
		expect(registry.getAvailable().some((m) => m.provider === UNAUTHED.provider)).toBe(false);

		const diagnostics = preflightCliModelDiagnostics({
			cliModel: UNAUTHED.id,
			agentDir,
			modelRegistry: registry,
		});

		const errors = diagnostics.filter((diagnostic) => diagnostic.type === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]!.message).toContain(UNAUTHED.provider);
		expect(errors[0]!.message).toContain("/login");
	});

	it("an unknown provider name is an error naming the provider", () => {
		const agentDir = agentDirWith(MODELS_JSON);
		const diagnostics = preflightCliModelDiagnostics({
			cliProvider: "nosuchprovider",
			cliModel: "anything",
			agentDir,
			modelRegistry: registryFor(agentDir),
		});

		const errors = diagnostics.filter((diagnostic) => diagnostic.type === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]!.message).toContain("nosuchprovider");
	});

	it("the --api-key first-time setup resolves against the full catalog", () => {
		vi.stubEnv(UNAUTHED.env, undefined as unknown as string);
		const agentDir = agentDirWith(MODELS_JSON);
		const diagnostics = preflightCliModelDiagnostics({
			cliModel: UNAUTHED.id,
			allowUnauthenticated: true,
			agentDir,
			modelRegistry: registryFor(agentDir),
		});

		expect(diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
	});
});
