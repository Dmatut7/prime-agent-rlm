import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

/**
 * Regressions for the config-drift audit finding CD-7: `compat.reasoningEffortMap` was
 * replaced by model-level `thinkingLevelMap` (docs/models.md, "Thinking Level Map"), but
 * `ProviderCompatSchema` is a non-strict `Type.Object`, so the removed key still
 * validates and is then ignored - thinking levels silently fall back to provider
 * defaults. The load path must say so, with the full path, and must not migrate the
 * mapping on the user's behalf (that would change behavior without consent).
 */

const PROBE_PROVIDER = "legacy-compat-probe";
const MODEL_ID = "probe-model";
const PROBE_BASE_URL = "https://legacy-compat.invalid/v1";
const LEGACY = "reasoningEffortMap";
const LEGACY_MODEL_PATH = `providers.${PROBE_PROVIDER}.models[0].compat.${LEGACY}`;
const LEGACY_PROVIDER_PATH = `providers.${PROBE_PROVIDER}.compat.${LEGACY}`;
const LEGACY_OVERRIDE_PATH = `providers.${PROBE_PROVIDER}.modelOverrides.${MODEL_ID}.compat.${LEGACY}`;

describe("deprecated compat.reasoningEffortMap diagnostic", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-legacy-compat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function writeConfig(config: unknown): void {
		writeFileSync(modelsJsonPath, JSON.stringify(config));
	}

	function legacyFile(compat: Record<string, unknown>, modelCompat?: Record<string, unknown>): unknown {
		return {
			providers: {
				[PROBE_PROVIDER]: {
					baseUrl: PROBE_BASE_URL,
					apiKey: "PROBE-API-KEY",
					api: "openai-completions",
					compat,
					models: [
						{
							id: MODEL_ID,
							name: "Legacy Probe Model",
							reasoning: true,
							contextWindow: 100000,
							maxTokens: 8000,
							...(modelCompat ? { compat: modelCompat } : {}),
						},
					],
					modelOverrides: { [MODEL_ID]: { compat: { [LEGACY]: { low: "low" } } } },
				},
			},
		};
	}

	function warningsMentioningLegacy(registry: ModelRegistry): string[] {
		return registry.getWarnings().filter((warning) => warning.includes(LEGACY));
	}

	test("warns with the full path for provider, model and override compat, and does not migrate the mapping", () => {
		writeConfig(legacyFile({ [LEGACY]: { high: "high" } }, { [LEGACY]: { high: "high", xhigh: "max" } }));

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);

		// The key is not an error: the file is adopted and the built-in models still work.
		expect(registry.getError()).toBeUndefined();
		const warnings = registry.getWarnings();
		expect(warnings).toHaveLength(3);
		const expectedPaths = [LEGACY_PROVIDER_PATH, LEGACY_MODEL_PATH, LEGACY_OVERRIDE_PATH];
		expect(expectedPaths.length).toBeGreaterThan(0);
		for (const path of expectedPaths) {
			expect(
				warnings.filter((warning) => warning.includes(path)),
				`no warning names ${path}`,
			).toHaveLength(1);
		}
		for (const warning of warnings) {
			expect(warning).toContain("deprecated");
			expect(warning).toContain("thinkingLevelMap");
		}
		// No silent migration: the mapping is still ignored, exactly as before the diagnostic.
		expect(registry.find(PROBE_PROVIDER, MODEL_ID)?.thinkingLevelMap).toBeUndefined();
	});

	test("control: model-level thinkingLevelMap warns nothing and is adopted", () => {
		writeConfig({
			providers: {
				[PROBE_PROVIDER]: {
					baseUrl: PROBE_BASE_URL,
					apiKey: "PROBE-API-KEY",
					api: "openai-completions",
					models: [
						{
							id: MODEL_ID,
							name: "Migrated Probe Model",
							reasoning: true,
							thinkingLevelMap: { high: "high", xhigh: "max" },
							contextWindow: 100000,
							maxTokens: 8000,
						},
					],
				},
			},
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);

		expect(registry.getError()).toBeUndefined();
		expect(warningsMentioningLegacy(registry)).toEqual([]);
		expect(registry.find(PROBE_PROVIDER, MODEL_ID)?.thinkingLevelMap).toEqual({ high: "high", xhigh: "max" });

		// Two-phase: a clean file must stay clean after a refresh too.
		registry.refresh();

		expect(registry.getError()).toBeUndefined();
		expect(warningsMentioningLegacy(registry)).toEqual([]);
		expect(registry.find(PROBE_PROVIDER, MODEL_ID)?.thinkingLevelMap).toEqual({ high: "high", xhigh: "max" });
	});

	test("boundary: null and an empty mapping are not reported", () => {
		// An empty map (and null, which the tristate schema otherwise means "unsupported")
		// maps no level at all, so nothing changes behavior when it is ignored and there is
		// nothing to migrate. Only a mapping with entries is worth a warning.
		writeConfig({
			providers: {
				nullCompat: {
					baseUrl: PROBE_BASE_URL,
					apiKey: "PROBE-API-KEY",
					api: "openai-completions",
					compat: { [LEGACY]: null },
					models: [{ id: MODEL_ID, name: "Null Compat", contextWindow: 100000, maxTokens: 8000 }],
				},
				emptyCompat: {
					baseUrl: PROBE_BASE_URL,
					apiKey: "PROBE-API-KEY",
					api: "openai-completions",
					compat: { [LEGACY]: {} },
					models: [{ id: MODEL_ID, name: "Empty Compat", contextWindow: 100000, maxTokens: 8000 }],
				},
			},
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);

		expect(registry.getError()).toBeUndefined();
		expect(registry.getWarnings()).toEqual([]);
		expect(registry.find("nullCompat", MODEL_ID)).toBeDefined();
		expect(registry.find("emptyCompat", MODEL_ID)).toBeDefined();
	});

	test("the warning survives a refresh without accumulating", () => {
		writeConfig(legacyFile({ [LEGACY]: { high: "high" } }, { [LEGACY]: { xhigh: "max" } }));

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		// legacyFile() carries the key at provider, model and override level.
		const firstLoad = warningsMentioningLegacy(registry);
		expect(firstLoad).toHaveLength(3);

		registry.refresh();

		expect(registry.getError()).toBeUndefined();
		expect(warningsMentioningLegacy(registry)).toEqual(firstLoad);
	});

	test("a client sees the migration hint through session diagnostics", async () => {
		writeConfig(legacyFile({ [LEGACY]: { high: "high" } }, { [LEGACY]: { xhigh: "max" } }));

		const faux = registerFauxProvider();
		try {
			const services = await createAgentSessionServices({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage: AuthStorage.inMemory(),
				resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true },
			});

			// Print, RPC and daemon clients see diagnostics and nothing else: a silent
			// behavior change must reach them as a warning, not live in the registry alone.
			const surfaced = services.diagnostics.filter((diagnostic) => diagnostic.message.includes(LEGACY));
			expect(surfaced.length).toBeGreaterThan(0);
			expect(surfaced.every((diagnostic) => diagnostic.type === "warning")).toBe(true);
			expect(surfaced.some((diagnostic) => diagnostic.message.includes(LEGACY_MODEL_PATH))).toBe(true);
		} finally {
			faux.unregister();
		}
	});
});
