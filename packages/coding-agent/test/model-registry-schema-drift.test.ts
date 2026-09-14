import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

/**
 * Regressions for the config-drift audit finding CD-1: a schema-invalid models.json
 * was adopted by the *first* load inside a process (the schema validator loaded
 * lazily, so that one load skipped it and only printed to stderr) and discarded by
 * every later refresh. Same file, two verdicts: the invalid file's `baseUrl` and
 * `apiKey` went out on real requests before it had ever validated, and the custom
 * provider then vanished the first time `/model` refreshed the registry.
 *
 * Every load path must reach the same verdict, and a file that has never validated
 * must not be adopted. The first test is deliberately the first thing to touch a
 * registry in this file: it is the in-process first load that used to differ.
 */

const PROBE_PROVIDER = "schema-drift-probe";
const PROBE_BASE_URL = "https://schema-drift.invalid/v1";
const PROBE_MODEL_ID = "probe-model";

const VALID_MODEL = {
	id: PROBE_MODEL_ID,
	name: "Probe Model",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 8000,
};

/** `cost` declares all four subkeys, so a partial cost object is schema-invalid. */
const PARTIAL_COST_MODEL = { ...VALID_MODEL, cost: { input: 1, output: 2 } };

describe("models.json load-path drift", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-model-registry-drift-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function writeModelsJson(contents: string): void {
		writeFileSync(modelsJsonPath, contents);
	}

	function writeProviderFile(model: Record<string, unknown>): void {
		writeModelsJson(
			JSON.stringify({
				providers: {
					// A built-in provider name as well: when the file is adopted, the
					// override rewrites every built-in model of that provider, which makes
					// "adopted while invalid" observable on models that exist regardless.
					anthropic: { baseUrl: PROBE_BASE_URL },
					[PROBE_PROVIDER]: {
						baseUrl: PROBE_BASE_URL,
						apiKey: "PROBE-API-KEY",
						api: "anthropic-messages",
						models: [model],
					},
				},
			}),
		);
	}

	function probeModel(registry: ModelRegistry): boolean {
		return registry.getAll().some((model) => model.provider === PROBE_PROVIDER && model.id === PROBE_MODEL_ID);
	}

	function anthropicBaseUrl(registry: ModelRegistry): string | undefined {
		return registry.getAll().find((model) => model.provider === "anthropic")?.baseUrl;
	}

	function verdict(registry: ModelRegistry): {
		error: string | undefined;
		probeModel: boolean;
		baseUrl: string | undefined;
	} {
		return { error: registry.getError(), probeModel: probeModel(registry), baseUrl: anthropicBaseUrl(registry) };
	}

	test("a schema-invalid file is rejected by the first load and keeps that verdict", () => {
		writeProviderFile(PARTIAL_COST_MODEL);

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const firstLoad = verdict(registry);

		// Pre-fix this was the odd load out: no error, model present, and the invalid
		// file's baseUrl applied to the built-in anthropic provider.
		expect(firstLoad.error).toContain("Invalid models.json schema");
		expect(firstLoad.probeModel).toBe(false);
		expect(firstLoad.baseUrl).not.toBe(PROBE_BASE_URL);

		registry.refresh();

		// "Usable, then gone" is the drift: the same file must reach the same verdict.
		expect(verdict(registry)).toEqual(firstLoad);
	});

	test("control: a schema-valid file is adopted by the first load and by every refresh", () => {
		writeProviderFile(VALID_MODEL);

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const firstLoad = verdict(registry);

		expect(firstLoad.error).toBeUndefined();
		expect(firstLoad.probeModel).toBe(true);
		expect(firstLoad.baseUrl).toBe(PROBE_BASE_URL);

		registry.refresh();

		expect(verdict(registry)).toEqual(firstLoad);
	});

	test("parse and semantic failures are reported by the first load too", () => {
		writeModelsJson("{ providers: ");
		const unparsable = ModelRegistry.create(authStorage, modelsJsonPath);
		expect(unparsable.getError()).toContain("Failed to parse models.json");
		unparsable.refresh();
		expect(unparsable.getError()).toContain("Failed to parse models.json");

		// Valid against the schema, rejected by validateConfig(): no baseUrl/apiKey.
		writeModelsJson(JSON.stringify({ providers: { "no-config-provider": {} } }));
		const semanticallyInvalid = ModelRegistry.create(authStorage, modelsJsonPath);
		const firstLoad = verdict(semanticallyInvalid);
		expect(firstLoad.error).toContain('must specify "baseUrl"');
		expect(firstLoad.probeModel).toBe(false);
		semanticallyInvalid.refresh();
		expect(verdict(semanticallyInvalid)).toEqual(firstLoad);
	});

	test("a models.json load failure is reported through session diagnostics", async () => {
		writeProviderFile(PARTIAL_COST_MODEL);

		const faux = registerFauxProvider();
		try {
			const services = await createAgentSessionServices({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage: AuthStorage.inMemory(),
				resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true },
			});

			// Print, RPC and daemon clients see diagnostics and nothing else, so the
			// rejection has to reach them.
			expect(services.diagnostics.some((d) => d.message.includes("Invalid models.json schema"))).toBe(true);
		} finally {
			faux.unregister();
		}
	});

	test("control: a valid models.json adds no diagnostic", async () => {
		writeProviderFile(VALID_MODEL);

		const faux = registerFauxProvider();
		try {
			const services = await createAgentSessionServices({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage: AuthStorage.inMemory(),
				resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true },
			});

			expect(services.diagnostics).toEqual([]);
		} finally {
			faux.unregister();
		}
	});
});
