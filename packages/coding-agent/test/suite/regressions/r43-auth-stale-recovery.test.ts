import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../../src/core/agent-session-runtime.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createHarness, type Harness } from "../harness.js";

function provider401Message(): AssistantMessage {
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "401 Unauthorized: invalid API key",
		}),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind: "auth", status: 401 },
			},
		],
	};
}

function registryModel(id: string) {
	return {
		id,
		name: id,
		api: "faux" as const,
		reasoning: true,
		input: ["text" as const],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

describe("r43 MC-2 stale auth recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("same-process /login clears stale records for every auth source, not just stored", () => {
		const authStorage = AuthStorage.inMemory();
		const registry = ModelRegistry.inMemory(authStorage);
		registry.registerProvider("faux", {
			api: "faux",
			baseUrl: "https://faux.example",
			apiKey: "registry-key",
			models: [registryModel("m1")],
		});
		authStorage.setRuntimeApiKey("faux", "k1");

		expect(authStorage.hasAuth("faux")).toBe(true);
		expect(registry.markProviderAuthStale("faux")).toBe(true);
		expect(authStorage.hasAuth("faux")).toBe(false);
		expect(authStorage.getAuthStatus("faux")).toEqual({ configured: false, source: "stale", label: "expired" });

		// /login writes a stored credential with the same value.
		authStorage.set("faux", { type: "api_key", key: "k1" });
		expect(authStorage.hasAuth("faux")).toBe(true);

		// The stale runtime record must be gone too: dropping the stored credential
		// must not fall back into the stale runtime key.
		authStorage.remove("faux");
		expect(authStorage.hasAuth("faux")).toBe(true);
		const model = registry.find("faux", "m1");
		expect(model).toBeDefined();
		expect(registry.hasConfiguredAuth(model!)).toBe(true);
		expect(registry.getAvailable().map((m) => m.id)).toContain("m1");
	});

	it("an external same-value auth.json write recovers a stale stored credential (r42 ⑤F1)", () => {
		const dir = mkdtempSync(join(tmpdir(), "mc2-xproc-"));
		const authPath = join(dir, "auth.json");
		const authStorage = AuthStorage.create(authPath);
		const registry = ModelRegistry.inMemory(authStorage);
		registry.registerProvider("faux", {
			api: "faux",
			baseUrl: "https://faux.example",
			apiKey: "registry-key",
			models: [registryModel("m1")],
		});

		authStorage.set("faux", { type: "api_key", key: "k1" });
		expect(authStorage.hasAuth("faux")).toBe(true);
		expect(registry.markProviderAuthStale("faux")).toBe(true);
		expect(authStorage.hasAuth("faux")).toBe(false);

		// Another process /logins with the SAME value: fresh bytes, new stat identity.
		writeFileSync(authPath, `${JSON.stringify({ faux: { type: "api_key", key: "k1" } }, null, 2)}\n`);
		expect(authStorage.getAuthStatus("faux").configured).toBe(true);
		expect(authStorage.hasAuth("faux")).toBe(true);
		const model = registry.find("faux", "m1");
		expect(registry.hasConfiguredAuth(model!)).toBe(true);
		expect(registry.getAvailable()).toHaveLength(1);
	});

	it("stale marks expire after the cooldown window and the provider self-heals (both layers)", () => {
		vi.useFakeTimers();
		try {
			// Two providers so each stale layer is asserted in isolation: the
			// registry layer (a models.json-style key, no authStorage credential)
			// and the authStorage layer (a runtime key).
			const authStorage = AuthStorage.inMemory();
			const registry = ModelRegistry.inMemory(authStorage);
			registry.registerProvider("faux", {
				api: "faux",
				baseUrl: "https://faux.example",
				apiKey: "static-key",
				models: [registryModel("m1")],
			});
			registry.registerProvider("faux-b", {
				api: "faux",
				baseUrl: "https://faux.example",
				apiKey: "other-key",
				models: [registryModel("m1")],
			});
			const model = registry.find("faux", "m1");
			const modelB = registry.find("faux-b", "m1");
			expect(model).toBeDefined();
			expect(modelB).toBeDefined();

			expect(registry.markProviderAuthStale("faux")).toBe(true);
			expect(registry.hasConfiguredAuth(model!)).toBe(false);
			expect(registry.getProviderAuthStatus("faux")).toEqual({
				configured: false,
				source: "stale",
				label: "expired",
			});

			authStorage.setRuntimeApiKey("faux-b", "k1");
			expect(authStorage.hasAuth("faux-b")).toBe(true);
			authStorage.markAuthStale("faux-b");
			expect(authStorage.hasAuth("faux-b")).toBe(false);

			vi.setSystemTime(Date.now() + 16 * 60_000);
			expect(registry.hasConfiguredAuth(model!)).toBe(true);
			expect(registry.getProviderAuthStatus("faux")).toEqual({ configured: true, source: "models_json_key" });
			expect(authStorage.hasAuth("faux-b")).toBe(true);
			expect(authStorage.getAuthStatus("faux-b").source).toBe("runtime");
		} finally {
			vi.useRealTimers();
		}
	});

	it("a stale provider reports the stale reason instead of 'No API key found' on the next run", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([provider401Message(), provider401Message()]);

		await harness.session.prompt("hello");

		const provider = harness.getModel().provider;
		expect(harness.authStorage.getAuthStatus(provider)).toEqual({
			configured: false,
			source: "stale",
			label: "expired",
		});
		// Positive control: the model itself must not have been switched mid-run.
		expect(harness.session.model?.provider).toBe(provider);

		// Mark the registry-layer (models.json) credential stale as well, so the
		// provider is fully unusable - the state a stale 401 leaves on a real machine.
		harness.authStorage.removeRuntimeApiKey(provider);
		expect(harness.modelRegistry.markProviderAuthStale(provider)).toBe(true);
		expect(harness.modelRegistry.getProviderAuthStatus(provider)).toEqual({
			configured: false,
			source: "stale",
			label: "expired",
		});

		harness.setResponses([fauxAssistantMessage("ok")]);
		let message: string | undefined;
		try {
			await harness.session.prompt("again");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toBeDefined();
		expect(message).not.toContain("No API key found");
		expect(message).toMatch(/rejected|disabled|stale|expired/i);
		expect(message).toContain("/login");
	});

	it("an explicit re-login resets registry-layer stale marks too", () => {
		const authStorage = AuthStorage.inMemory();
		const registry = ModelRegistry.inMemory(authStorage);
		registry.registerProvider("faux", {
			api: "faux",
			baseUrl: "https://faux.example",
			apiKey: "static-key",
			models: [registryModel("m1")],
		});
		const model = registry.find("faux", "m1");
		expect(model).toBeDefined();

		expect(registry.markProviderAuthStale("faux")).toBe(true);
		expect(registry.hasConfiguredAuth(model!)).toBe(false);
		expect(registry.getProviderAuthStatus("faux")).toEqual({ configured: false, source: "stale", label: "expired" });

		// /login writes a stored credential and resets the provider's stale state.
		authStorage.set("faux", { type: "api_key", key: "fresh" });
		registry.clearProviderAuthStale("faux");
		expect(registry.hasConfiguredAuth(model!)).toBe(true);
		expect(registry.getProviderAuthStatus("faux").configured).toBe(true);
	});

	it("resuming a session whose saved model lost auth records the fallback in the model ledger", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "mc2-ledger-"));
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const faux = registerFauxProvider();
		try {
			const scratch = join(dirname(sessionDir), `.scratch-${Math.random().toString(36).slice(2)}`);
			const manager = SessionManager.create(tempDir, scratch);
			manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
			manager.appendMessage(fauxAssistantMessage("hi"));
			manager.appendModelChange("ghost-provider", "ghost-model");
			const created = manager.getSessionFile();
			if (!created) throw new Error("scratch session file was never written");
			const sessionFile = join(sessionDir, "ledger.jsonl");
			renameSync(created, sessionFile);
			rmSync(scratch, { recursive: true, force: true });

			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			const services = await createAgentSessionServices({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
			});
			const sessionManager = SessionManager.open(sessionFile, sessionDir, tempDir);
			const { session } = await createAgentSessionFromServices({
				services,
				sessionManager,
				model: faux.getModel(),
			});

			const modelChanges = sessionManager.getBranch().filter((entry) => entry.type === "model_change");
			const last = modelChanges[modelChanges.length - 1];
			expect(last?.type).toBe("model_change");
			expect(last?.provider).toBe(faux.getModel().provider);
			expect((last as { modelId?: string }).modelId).toBe(faux.getModel().id);
			expect(session.model?.provider).toBe(faux.getModel().provider);
			await Promise.resolve(session.dispose()).catch(() => undefined);
		} finally {
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
			}
		}
	});
});
