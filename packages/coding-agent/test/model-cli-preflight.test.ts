import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { cliExtensionsMayLoad, preflightCliModelDiagnostics } from "../src/main.js";

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

	it("downgrades the unknown-model error to a warning when extensions may register the model", () => {
		const agentDir = agentDirWith(MODELS_JSON);
		const diagnostics = preflightCliModelDiagnostics({
			cliModel: "totally-nonexistent-model-xyz",
			agentDir,
			modelRegistry: registryFor(agentDir),
			extensionsMayLoad: true,
		});

		expect(diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
		const warnings = diagnostics.filter((diagnostic) => diagnostic.type === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]!.message).toContain("totally-nonexistent-model-xyz");
	});

	it("keeps the hard error when extensions cannot load", () => {
		const agentDir = agentDirWith(MODELS_JSON);
		const diagnostics = preflightCliModelDiagnostics({
			cliModel: "totally-nonexistent-model-xyz",
			agentDir,
			modelRegistry: registryFor(agentDir),
			extensionsMayLoad: false,
		});

		expect(diagnostics.filter((diagnostic) => diagnostic.type === "error")).toHaveLength(1);
	});
});

describe("cliExtensionsMayLoad", () => {
	function tempRoot(): { cwd: string; agentDir: string } {
		const root = mkdtempSync(join(tmpdir(), "wave-preflight-ext-"));
		return { cwd: join(root, "project"), agentDir: join(root, "agent") };
	}

	it("is false when no extension source exists", () => {
		const { cwd, agentDir } = tempRoot();
		expect(cliExtensionsMayLoad({ settingsManager: SettingsManager.inMemory(), cwd, agentDir })).toBe(false);
	});

	it("is true when --extension paths were passed on the command line", () => {
		const { cwd, agentDir } = tempRoot();
		expect(
			cliExtensionsMayLoad({
				cliExtensions: ["./my-extension.ts"],
				settingsManager: SettingsManager.inMemory(),
				cwd,
				agentDir,
			}),
		).toBe(true);
	});

	it("is true when settings name extension paths", () => {
		const { cwd, agentDir } = tempRoot();
		const settingsManager = SettingsManager.inMemory({ extensions: ["./settings-extension.ts"] });
		expect(cliExtensionsMayLoad({ settingsManager, cwd, agentDir })).toBe(true);
	});

	it("is true when settings name packages, which may declare extensions", () => {
		const { cwd, agentDir } = tempRoot();
		const settingsManager = SettingsManager.inMemory({ packages: ["npm:some-extension-pack"] });
		expect(cliExtensionsMayLoad({ settingsManager, cwd, agentDir })).toBe(true);
	});

	it("is true when the project extensions directory has entries", () => {
		const { cwd, agentDir } = tempRoot();
		const projectExtensions = join(cwd, CONFIG_DIR_NAME, "extensions");
		mkdirSync(projectExtensions, { recursive: true });
		writeFileSync(join(projectExtensions, "project-ext.ts"), "export default function () {}\n", "utf-8");
		expect(cliExtensionsMayLoad({ settingsManager: SettingsManager.inMemory(), cwd, agentDir })).toBe(true);
	});

	it("is true when the user-level extensions directory has entries", () => {
		const { cwd, agentDir } = tempRoot();
		const userExtensions = join(agentDir, "extensions");
		mkdirSync(userExtensions, { recursive: true });
		writeFileSync(join(userExtensions, "user-ext.ts"), "export default function () {}\n", "utf-8");
		expect(cliExtensionsMayLoad({ settingsManager: SettingsManager.inMemory(), cwd, agentDir })).toBe(true);
	});

	it("ignores empty extensions directories", () => {
		const { cwd, agentDir } = tempRoot();
		mkdirSync(join(cwd, CONFIG_DIR_NAME, "extensions"), { recursive: true });
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		expect(cliExtensionsMayLoad({ settingsManager: SettingsManager.inMemory(), cwd, agentDir })).toBe(false);
	});
});
