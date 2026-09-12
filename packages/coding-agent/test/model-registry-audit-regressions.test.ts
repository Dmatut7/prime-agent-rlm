import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

/**
 * Regressions for the model-config audit findings:
 * 1. apiKey-only models.json provider entries were rejected, discarding the whole file.
 * 2. getExecutableModels' stale-cache fallback re-checked the fresh-cache guard and
 *    could never fire, so a transient catalog failure dropped every codex model.
 * 3. `!command` credential resolution shelled out synchronously on every request,
 *    blocking the daemon worker's event loop.
 */

function codexAccessToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

const testModelDef = {
	id: "test-model",
	name: "Test Model",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 8000,
};

describe("ModelRegistry audit regressions", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	const savedEnv = new Map<string, string | undefined>();

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-model-registry-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		for (const [name, value] of savedEnv) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		savedEnv.clear();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function setEnv(name: string, value: string | undefined): void {
		if (!savedEnv.has(name)) {
			savedEnv.set(name, process.env[name]);
		}
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}

	function writeRawModelsJson(providers: Record<string, unknown>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	describe("apiKey-only provider config", () => {
		test("models.json with an apiKey-only built-in provider is kept, not discarded", async () => {
			const envVarName = "TEST_API_KEY_ONLY_AUDIT_98765";
			setEnv(envVarName, "key-only-value");
			setEnv("ANTHROPIC_API_KEY", undefined);
			setEnv("ANTHROPIC_OAUTH_TOKEN", undefined);

			writeRawModelsJson({
				anthropic: { apiKey: envVarName },
				"custom-provider": {
					baseUrl: "https://example.com/v1",
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					models: [testModelDef],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			// Pre-fix, validateConfig rejected the apiKey-only entry and the whole file was dropped.
			expect(registry.getError()).toBeUndefined();
			expect(registry.find("custom-provider", "test-model")).toBeDefined();

			const anthropicModel = registry.getAll().find((model) => model.provider === "anthropic");
			expect(anthropicModel).toBeDefined();
			expect(registry.getAvailable().some((model) => model.provider === "anthropic")).toBe(true);
			await expect(registry.getApiKeyAndHeaders(anthropicModel!)).resolves.toMatchObject({
				ok: true,
				apiKey: "key-only-value",
			});
		});

		test("provider config without any usable field is still rejected", () => {
			writeRawModelsJson({ anthropic: { authHeader: true } });

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			expect(registry.getError()).toContain(
				'must specify "baseUrl", "apiKey", "headers", "compat", "modelOverrides", or "models"',
			);
			expect(registry.getAll().some((model) => model.provider === "custom-provider")).toBe(false);
		});
	});

	// Upstream pins the expired-catalog contract (test/suite/regressions/4649-subagent-model-selection.test.ts
	// "does not reuse an expired ChatGPT model catalog after a refresh failure"): a refetch failure
	// drops the codex pool rather than serving a catalog past its TTL. PR #13 proposed reusing the
	// stale catalog; that half is deferred, so only the no-cache control is pinned here.
	describe("getExecutableModels catalog-refresh failure", () => {
		function writeCodexAuth(): string {
			const authPath = join(tempDir, "auth.json");
			writeFileSync(
				authPath,
				JSON.stringify({
					"openai-codex": {
						type: "oauth",
						access: codexAccessToken("account-123"),
						refresh: "refresh-token",
						expires: Date.now() + 60 * 60 * 1000,
						accountId: "account-123",
					},
				}),
			);
			return authPath;
		}

		test("catalog failure without a usable cache still drops codex models", async () => {
			const authPath = writeCodexAuth();
			const registry = ModelRegistry.create(AuthStorage.create(authPath), join(tempDir, "models.json"));
			expect(registry.getAvailable().some((model) => model.provider === "openai-codex")).toBe(true);

			const originalFetch = globalThis.fetch;
			let fetchCount = 0;
			globalThis.fetch = (async () => {
				fetchCount += 1;
				throw new Error("transient network failure");
			}) as typeof globalThis.fetch;
			try {
				const result = await registry.getExecutableModels();
				expect(fetchCount).toBeGreaterThan(0);
				expect(result.some((model) => model.provider === "openai-codex")).toBe(false);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	});

	describe("request-time !command resolution", () => {
		test("getApiKeyAndHeaders resolves a command apiKey without blocking the event loop", async () => {
			writeRawModelsJson({
				"custom-provider": {
					baseUrl: "https://example.com/v1",
					apiKey: "!sleep 0.5 && echo command-resolved-key",
					api: "anthropic-messages",
					models: [testModelDef],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("custom-provider", "test-model");
			expect(model).toBeDefined();

			let ticks = 0;
			const interval = setInterval(() => {
				ticks += 1;
			}, 20);
			const auth = await registry.getApiKeyAndHeaders(model!);
			clearInterval(interval);

			expect(auth).toMatchObject({ ok: true, apiKey: "command-resolved-key" });
			// The synchronous execSync path held the event loop for the whole command,
			// so not a single timer tick could fire while it ran.
			expect(ticks).toBeGreaterThan(0);
		});

		test("command-backed provider headers resolve without blocking the event loop", async () => {
			setEnv("TEST_LITERAL_HEADER_KEY_AUDIT", undefined);
			writeRawModelsJson({
				"custom-provider": {
					baseUrl: "https://example.com/v1",
					apiKey: "TEST_LITERAL_HEADER_KEY_AUDIT",
					api: "anthropic-messages",
					headers: { "x-secret": "!sleep 0.5 && echo header-secret" },
					models: [testModelDef],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("custom-provider", "test-model");
			expect(model).toBeDefined();

			let ticks = 0;
			const interval = setInterval(() => {
				ticks += 1;
			}, 20);
			const auth = await registry.getApiKeyAndHeaders(model!);
			clearInterval(interval);

			expect(auth).toMatchObject({
				ok: true,
				apiKey: "TEST_LITERAL_HEADER_KEY_AUDIT",
				headers: { "x-secret": "header-secret" },
			});
			expect(ticks).toBeGreaterThan(0);
		});

		test("command-backed credentials are still resolved fresh on every request", async () => {
			const counterFile = join(tempDir, "counter");
			writeFileSync(counterFile, "0");
			const counterPath = toShPath(counterFile);

			writeRawModelsJson({
				"custom-provider": {
					baseUrl: "https://example.com/v1",
					apiKey: `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`,
					authHeader: true,
					api: "anthropic-messages",
					models: [testModelDef],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("custom-provider", "test-model");
			expect(model).toBeDefined();

			await expect(registry.getApiKeyAndHeaders(model!)).resolves.toMatchObject({
				ok: true,
				apiKey: "key-value",
				headers: { Authorization: "Bearer key-value" },
			});
			await expect(registry.getApiKeyAndHeaders(model!)).resolves.toMatchObject({ ok: true, apiKey: "key-value" });
			await expect(registry.getApiKeyForProvider("custom-provider")).resolves.toBe("key-value");

			const count = Number.parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
			expect(count).toBe(3);
		});

		test("failed command credentials surface the same resolution error", async () => {
			writeRawModelsJson({
				"custom-provider": {
					baseUrl: "https://example.com/v1",
					apiKey: "!exit 1",
					authHeader: true,
					api: "anthropic-messages",
					models: [testModelDef],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("custom-provider", "test-model");
			expect(model).toBeDefined();

			const auth = await registry.getApiKeyAndHeaders(model!);
			expect(auth.ok).toBe(false);
			if (!auth.ok) {
				expect(auth.error).toContain('Failed to resolve API key for provider "custom-provider"');
			}
			await expect(registry.getApiKeyForProvider("custom-provider")).resolves.toBeUndefined();
		});
	});
});
