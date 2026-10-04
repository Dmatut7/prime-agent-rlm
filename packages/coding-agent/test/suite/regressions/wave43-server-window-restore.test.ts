import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { restoreSavedSessionModel } from "../../../src/core/model-resolver.js";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";

/**
 * wave-43 SERVER-WINDOW: a resumed session's first pre-prompt compaction
 * evaluation reads the registry live, so it must see the server-reported
 * window once the catalog refresh lands. The bundled prime-inference
 * z-ai/glm-5.3 entry declares contextWindow 1048576; a gateway that re-routes
 * it to a 200K variant reports specs.context_window 200000 through the catalog
 * fetch. restoreSavedSessionModel kicks that refresh and waits for it, bounded
 * by SESSION_RESTORE_CATALOG_WAIT_MS.
 */

const SAVED_PROVIDER = "prime-inference";
const SAVED_MODEL_ID = "z-ai/glm-5.3";
const BUNDLED_WINDOW = 1048576;
const SERVER_WINDOW = 200_000;
/** A public Prime Inference model that exists only in the live catalog. */
const CATALOG_ONLY_MODEL_ID = "openai/gpt-6-astra-canary";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function catalogEntry(id: string, contextWindow: number) {
	return {
		id,
		pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 1 },
		specs: {
			context_window: contextWindow,
			max_output_tokens: 32000,
			modalities: { input: ["text"], output: ["text"] },
			supports_reasoning: false,
		},
	};
}

/**
 * A catalog payload that covers the bundled Prime Inference snapshot (so the
 * fetch survives the coverage check), reports the server-side window for the
 * saved model, and additionally carries a catalog-only canary model.
 */
function catalogPayloadWithServerWindow(): unknown {
	const bundled = getModels(SAVED_PROVIDER);
	expect(bundled.length).toBeGreaterThan(0);
	return {
		data: [
			...bundled.map((model) =>
				catalogEntry(model.id, model.id === SAVED_MODEL_ID ? SERVER_WINDOW : model.contextWindow),
			),
			catalogEntry(CATALOG_ONLY_MODEL_ID, 256_000),
		],
	};
}

/** Stubs the catalog fetch to resolve with the server-window catalog after delayMs. */
function stubDelayedCatalogFetch(delayMs: number) {
	const fetchMock = vi.fn(async () => {
		await sleep(delayMs);
		return new Response(JSON.stringify(catalogPayloadWithServerWindow()), { status: 200 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function primeAuthStorage(): AuthStorage {
	return AuthStorage.inMemory({
		"prime-inference": { type: "api_key", key: "test-key" },
	});
}

describe("session restore waits for the server-reported window", () => {
	const tempDirs: string[] = [];

	beforeEach(() => {
		tempDirs.push(mkdtempSync(join(tmpdir(), "wave43-server-window-")));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("restore waits for the catalog refresh; the trigger's registry read sees the server window", async () => {
		stubDelayedCatalogFetch(40);
		const registry = ModelRegistry.create(primeAuthStorage(), join(tempDirs[0]!, "models.json"));
		expect(registry.find(SAVED_PROVIDER, SAVED_MODEL_ID)?.contextWindow).toBe(BUNDLED_WINDOW);

		const restored = await restoreSavedSessionModel({
			provider: SAVED_PROVIDER,
			modelId: SAVED_MODEL_ID,
			modelRegistry: registry,
		});

		expect(restored.model).toMatchObject({ provider: SAVED_PROVIDER, id: SAVED_MODEL_ID });
		expect(restored.model?.contextWindow).toBe(SERVER_WINDOW);
		// The compaction trigger reads the registry live (wave-35): this is the
		// exact read _registryContextWindow performs before the first request.
		expect(registry.find(SAVED_PROVIDER, SAVED_MODEL_ID)?.contextWindow).toBe(SERVER_WINDOW);
	});

	test("restore proceeds on bundled values when the bounded wait expires, and the late refresh self-corrects", async () => {
		stubDelayedCatalogFetch(200);
		const registry = ModelRegistry.create(primeAuthStorage(), join(tempDirs[0]!, "models.json"));

		const restored = await restoreSavedSessionModel({
			provider: SAVED_PROVIDER,
			modelId: SAVED_MODEL_ID,
			modelRegistry: registry,
			catalogReadyWaitMs: 25,
		});

		expect(restored.model).toMatchObject({ provider: SAVED_PROVIDER, id: SAVED_MODEL_ID });
		expect(restored.model?.contextWindow).toBe(BUNDLED_WINDOW);

		// Recovery half of the bounded wait: the refresh keeps running in the
		// background and reloads the registry in place, so the next trigger
		// evaluation sees the server-reported window.
		await sleep(500);
		expect(registry.find(SAVED_PROVIDER, SAVED_MODEL_ID)?.contextWindow).toBe(SERVER_WINDOW);
	});

	test("restore judges availability against the post-refresh catalog (catalog-only model restores)", async () => {
		stubDelayedCatalogFetch(40);
		const registry = ModelRegistry.create(primeAuthStorage(), join(tempDirs[0]!, "models.json"));
		expect(registry.find(SAVED_PROVIDER, CATALOG_ONLY_MODEL_ID)).toBeUndefined();

		const restored = await restoreSavedSessionModel({
			provider: SAVED_PROVIDER,
			modelId: CATALOG_ONLY_MODEL_ID,
			modelRegistry: registry,
		});

		expect(restored.model).toMatchObject({ provider: SAVED_PROVIDER, id: CATALOG_ONLY_MODEL_ID });
		expect(restored.reason).toBeUndefined();
	});

	test("offline mode does not fetch and restores on bundled values immediately", async () => {
		vi.stubEnv("PI_OFFLINE", "1");
		const fetchMock = stubDelayedCatalogFetch(0);
		const registry = ModelRegistry.create(primeAuthStorage(), join(tempDirs[0]!, "models.json"));

		const restored = await restoreSavedSessionModel({
			provider: SAVED_PROVIDER,
			modelId: SAVED_MODEL_ID,
			modelRegistry: registry,
		});

		expect(restored.model).toMatchObject({ provider: SAVED_PROVIDER, id: SAVED_MODEL_ID });
		expect(restored.model?.contextWindow).toBe(BUNDLED_WINDOW);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("createAgentSession restores a resumed session model with the server-reported window", async () => {
		stubDelayedCatalogFetch(40);
		const cwd = tempDirs[0]!;
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });

		const authStorage = primeAuthStorage();
		const modelRegistry = ModelRegistry.create(authStorage, join(cwd, "models.json"));
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		sessionManager.appendModelChange(SAVED_PROVIDER, SAVED_MODEL_ID);

		const result = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			sessionManager,
			telemetryDisabled: true,
		});

		expect(result.session.model).toMatchObject({ provider: SAVED_PROVIDER, id: SAVED_MODEL_ID });
		expect(result.session.model?.contextWindow).toBe(SERVER_WINDOW);
		expect(result.modelFallbackMessage).toBeUndefined();

		result.session.dispose();
	}, 15_000);
});
