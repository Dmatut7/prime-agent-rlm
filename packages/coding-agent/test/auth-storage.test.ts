import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider } from "@earendil-works/pi-ai/oauth";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";

describe("AuthStorage", () => {
	let tempDir: string;
	let authJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
	});

	function writeAuthJson(data: Record<string, unknown>) {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	describe("API key resolution", () => {
		test("literal API key is returned directly", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "sk-ant-literal-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("sk-ant-literal-key");
		});

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo test-api-key-from-command" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo '  spaced-key  '" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf 'line1\\nline2'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix returns undefined on command failure", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!exit 1" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!nonexistent-command-12345" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on empty output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf ''" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey as environment variable name resolves to env value", async () => {
			const originalEnv = process.env.TEST_AUTH_API_KEY_12345;
			process.env.TEST_AUTH_API_KEY_12345 = "env-api-key-value";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: "TEST_AUTH_API_KEY_12345" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("ambient environment credentials count as available auth", async () => {
			const originalAwsProfile = process.env.AWS_PROFILE;
			process.env.AWS_PROFILE = "pi-test-profile";

			try {
				authStorage = AuthStorage.inMemory();

				expect(authStorage.hasAuth("amazon-bedrock")).toBe(true);
				await expect(authStorage.getApiKey("amazon-bedrock")).resolves.toBe("<authenticated>");
				expect(authStorage.getAuthStatus("amazon-bedrock")).toEqual({
					configured: false,
					source: "environment",
					label: "ambient credentials",
				});
			} finally {
				if (originalAwsProfile === undefined) {
					delete process.env.AWS_PROFILE;
				} else {
					process.env.AWS_PROFILE = originalAwsProfile;
				}
			}
		});

		test("changed ambient environment credential no longer matches stale auth marker", async () => {
			const originalAwsProfile = process.env.AWS_PROFILE;
			process.env.AWS_PROFILE = "stale-profile";

			try {
				authStorage = AuthStorage.inMemory();
				expect(authStorage.markAuthStale("amazon-bedrock")).toBe(true);
				expect(authStorage.hasAuth("amazon-bedrock")).toBe(false);
				await expect(authStorage.getApiKey("amazon-bedrock")).resolves.toBeUndefined();

				process.env.AWS_PROFILE = "fresh-profile";

				expect(authStorage.hasAuth("amazon-bedrock")).toBe(true);
				await expect(authStorage.getApiKey("amazon-bedrock")).resolves.toBe("<authenticated>");
			} finally {
				if (originalAwsProfile === undefined) {
					delete process.env.AWS_PROFILE;
				} else {
					process.env.AWS_PROFILE = originalAwsProfile;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			delete process.env.literal_api_key_value;

			writeAuthJson({
				anthropic: { type: "api_key", key: "literal_api_key_value" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("prime inference falls back to Prime CLI config when enabled", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("prime-cli-key");
			expect(authStorage.hasAuth("prime-inference")).toBe(true);
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "prime_cli",
				label: "Prime CLI",
			});
		});

		test("prime cli config changes are picked up without reload", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("prime-cli-key");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "changed-prime-key" }));
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("changed-prime-key");
		});

		test("prime inference marks current Prime CLI auth stale", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.markAuthStale("prime-inference")).toBe(true);

			expect(authStorage.hasAuth("prime-inference")).toBe(false);
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBeUndefined();
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "stale",
				label: "expired",
			});
		});

		test("changed Prime CLI key no longer matches stale auth marker", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});
			authStorage.markAuthStale("prime-inference");

			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "changed-prime-key" }));

			expect(authStorage.hasAuth("prime-inference")).toBe(true);
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("changed-prime-key");
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "prime_cli",
				label: "Prime CLI",
			});
		});

		test("setPrimeInferenceApiKey clears stale Prime CLI auth marker", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});
			authStorage.markAuthStale("prime-inference");

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			expect(authStorage.hasAuth("prime-inference")).toBe(true);
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("new-prime-key");
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "prime_cli",
				label: "Prime CLI",
			});
		});

		test("stored credential updates do not revive stale runtime auth", async () => {
			authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			expect(authStorage.markAuthStale("anthropic")).toBe(true);

			authStorage.set("anthropic", { type: "api_key", key: "stored-key" });

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("stored-key");

			authStorage.remove("anthropic");

			expect(authStorage.getAuthStatus("anthropic")).toEqual({
				configured: false,
				source: "stale",
				label: "expired",
			});
			await expect(authStorage.getApiKey("anthropic")).resolves.toBeUndefined();
		});

		test("changed command-backed stored key no longer matches stale auth marker", async () => {
			const tokenFile = join(tempDir, "command-token");
			writeFileSync(tokenFile, "stale-key");
			const tokenPath = toShPath(tokenFile);
			writeAuthJson({
				anthropic: { type: "api_key", key: `!sh -c 'cat "${tokenPath}"'` },
			});

			authStorage = AuthStorage.create(authJsonPath);
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("stale-key");
			expect(authStorage.markAuthStale("anthropic")).toBe(true);
			expect(authStorage.hasAuth("anthropic")).toBe(false);
			await expect(authStorage.getApiKey("anthropic")).resolves.toBeUndefined();

			writeFileSync(tokenFile, "fresh-key");

			expect(authStorage.hasAuth("anthropic")).toBe(true);
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("fresh-key");
			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
		});

		test("prime inference uses Prime CLI auth over stored auth", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("prime-cli-key");
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "prime_cli",
				label: "Prime CLI",
			});
		});

		test("prime inference uses environment auth over Prime CLI and stored auth", async () => {
			const originalPrimeApiKey = process.env.PRIME_API_KEY;
			const originalPrimeTeamId = process.env.PRIME_TEAM_ID;
			process.env.PRIME_API_KEY = "env-prime-key";
			delete process.env.PRIME_TEAM_ID;
			try {
				const primeConfigPath = join(tempDir, "prime-config.json");
				writeFileSync(
					primeConfigPath,
					JSON.stringify({ api_key: "prime-cli-key", team_id: "cli-team", team_name: "CLI Research" }),
				);
				writeAuthJson({
					"prime-inference": {
						type: "api_key",
						key: "agent-key",
						primeTeam: { teamId: "stored-team", name: "Stored Research" },
					},
				});

				authStorage = AuthStorage.create(authJsonPath, {
					primeCliConfigPath: primeConfigPath,
					usePrimeCliConfig: true,
				});

				await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("env-prime-key");
				expect(authStorage.getAuthStatus("prime-inference")).toEqual({
					configured: false,
					source: "environment",
					label: "PRIME_API_KEY",
				});
				expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
				expect(authStorage.getPrimeInferenceTeamSelection()).toBeUndefined();
			} finally {
				if (originalPrimeApiKey === undefined) {
					delete process.env.PRIME_API_KEY;
				} else {
					process.env.PRIME_API_KEY = originalPrimeApiKey;
				}
				if (originalPrimeTeamId === undefined) {
					delete process.env.PRIME_TEAM_ID;
				} else {
					process.env.PRIME_TEAM_ID = originalPrimeTeamId;
				}
			}
		});

		test("prime inference provider headers use selected Prime CLI team", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "prime-cli-key",
					team_id: "cli-team",
					team_name: "CLI Research",
					team_role: "admin",
				}),
			);
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research", slug: "research", role: "admin" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "cli-team" });
			expect(authStorage.getPrimeInferenceTeamSelection()).toEqual({
				teamId: "cli-team",
				name: "CLI Research",
				role: "admin",
			});
		});

		test("prime inference legacy personal selection suppresses Prime CLI team fallback without Prime CLI key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ team_id: "cli-team" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: null,
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
			expect(authStorage.getPrimeInferenceTeamSelection()).toBeNull();
		});

		test("prime inference legacy personal selection suppresses Prime CLI team with Prime CLI key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "cli-team" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: null,
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
			expect(authStorage.getPrimeInferenceTeamSelection()).toBeNull();
		});

		test("prime inference environment team overrides legacy personal selection", () => {
			const originalPrimeTeamId = process.env.PRIME_TEAM_ID;
			process.env.PRIME_TEAM_ID = "env-team";
			try {
				const primeConfigPath = join(tempDir, "prime-config.json");
				writeFileSync(primeConfigPath, JSON.stringify({ team_id: "cli-team" }));
				writeAuthJson({
					"prime-inference": {
						type: "api_key",
						key: "agent-key",
						primeTeam: null,
					},
				});

				authStorage = AuthStorage.create(authJsonPath, {
					primeCliConfigPath: primeConfigPath,
					usePrimeCliConfig: true,
				});

				expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "env-team" });
				expect(authStorage.getPrimeInferenceTeamSelection()).toBeUndefined();
			} finally {
				if (originalPrimeTeamId === undefined) {
					delete process.env.PRIME_TEAM_ID;
				} else {
					process.env.PRIME_TEAM_ID = originalPrimeTeamId;
				}
			}
		});

		test("prime inference missing Agent team selection falls back to Prime CLI team", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "cli-team" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "cli-team" });
		});

		test("prime inference provider header changes are picked up without reload", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "team-1" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "team-1" });
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "team-2" }));
			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "team-2" });
		});

		test("setPrimeInferenceApiKey creates Prime CLI config", async () => {
			const primeConfigPath = join(tempDir, "prime", "config.json");
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("new-prime-key");
			expect(statSync(primeConfigPath).mode & 0o777).toBe(0o600);
			expect(authStorage.has("prime-inference")).toBe(false);
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("new-prime-key");
		});

		test("setPrimeInferenceApiKey clears stale Prime CLI team selection", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "old-prime-key",
					team_id: "old-team",
					team_name: "Old Team",
					team_role: "admin",
				}),
			);
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("new-prime-key");
			expect(config.team_id).toBeUndefined();
			expect(config.team_name).toBeUndefined();
			expect(config.team_role).toBeUndefined();
		});

		test("setPrimeInferenceApiKey preserves Prime CLI team selection for the same key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "prime-cli-key",
					team_id: "team-1",
					team_name: "Research",
					team_role: "admin",
				}),
			);
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("prime-cli-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("prime-cli-key");
			expect(config.team_id).toBe("team-1");
			expect(config.team_name).toBe("Research");
			expect(config.team_role).toBe("admin");
			expect(authStorage.has("prime-inference")).toBe(false);
		});

		test("setPrimeInferenceApiKey migrates legacy team selection for the same Prime CLI key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research", slug: "research", role: "admin" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("prime-cli-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("prime-cli-key");
			expect(config.team_id).toBe("team-1");
			expect(config.team_name).toBe("Research");
			expect(config.team_role).toBe("admin");
			expect(authStorage.has("prime-inference")).toBe(false);
			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "team-1" });
		});

		test("setPrimeInferenceApiKey migrates legacy personal selection for the same Prime CLI key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "prime-cli-key",
					team_id: "team-1",
					team_name: "Research",
				}),
			);
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: null,
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("prime-cli-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("prime-cli-key");
			expect(config.team_id).toBeUndefined();
			expect(config.team_name).toBeUndefined();
			expect(authStorage.has("prime-inference")).toBe(false);
			expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
		});

		test("setPrimeInferenceApiKey removes legacy Prime Agent credential after Prime CLI save", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			const agentAuth = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, unknown>;
			expect(agentAuth["prime-inference"]).toBeUndefined();
			expect(authStorage.has("prime-inference")).toBe(false);
		});

		test("setPrimeInferenceApiKey throws when Prime CLI config cannot be written", () => {
			const primeConfigPath = join(tempDir, "prime-config-dir");
			mkdirSync(primeConfigPath);
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(() => authStorage.setPrimeInferenceApiKey("new-prime-key")).toThrow();
			expect(authStorage.drainErrors()).toHaveLength(1);
		});

		test("setPrimeInferenceApiKey preserves team selection when Prime CLI config is disabled", () => {
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			expect(authStorage.get("prime-inference")).toEqual({
				type: "api_key",
				key: "new-prime-key",
				primeTeam: { teamId: "team-1", name: "Research" },
			});
		});

		test("logout clears Prime CLI credentials when enabled", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "prime-cli-key",
					team_id: "team-1",
					team_name: "Research",
				}),
			);
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.logout("prime-inference");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBeUndefined();
			expect(config.team_id).toBeUndefined();
			expect(config.team_name).toBeUndefined();
			expect(authStorage.has("prime-inference")).toBe(false);
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBeUndefined();
		});

		test("logout reports that it also cleared the shared Prime CLI config", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "team-1" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.drainNotices()).toEqual([]);
			authStorage.logout("prime-inference");

			const notices = authStorage.drainNotices();
			expect(notices).toHaveLength(1);
			expect(notices[0]?.provider).toBe("prime-inference");
			expect(notices[0]?.message).toContain("Prime CLI config");
			expect(notices[0]?.message).toContain(primeConfigPath);
			// Drained, not replayed: the notice describes one removal.
			expect(authStorage.drainNotices()).toEqual([]);
		});

		test("logout stays quiet when the shared Prime CLI config held nothing to remove", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ base_url: "https://prime-api.example" }));
			writeAuthJson({ "prime-inference": { type: "api_key", key: "agent-key" } });

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.logout("prime-inference");

			expect(authStorage.drainNotices()).toEqual([]);
		});

		test("setPrimeInferenceTeamSelection writes Prime CLI config", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceTeamSelection({ teamId: "team-1", name: "Research", role: "admin" });

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.team_id).toBe("team-1");
			expect(config.team_name).toBe("Research");
			expect(config.team_role).toBe("admin");
			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "team-1" });
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo 'hello world' | tr ' ' '-'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("hello-world");
		});

		describe("caching", () => {
			test("command is only executed once per process", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("cache persists across AuthStorage instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				const storage1 = AuthStorage.create(authJsonPath);
				await storage1.getApiKey("anthropic");

				const storage2 = AuthStorage.create(authJsonPath);
				await storage2.getApiKey("anthropic");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("different commands are cached separately", async () => {
				writeAuthJson({
					anthropic: { type: "api_key", key: "!echo key-anthropic" },
					openai: { type: "api_key", key: "!echo key-openai" },
				});

				authStorage = AuthStorage.create(authJsonPath);

				const keyA = await authStorage.getApiKey("anthropic");
				const keyB = await authStorage.getApiKey("openai");

				expect(keyA).toBe("key-anthropic");
				expect(keyB).toBe("key-openai");
			});

			test("failed commands are cached (not retried)", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				const key1 = await authStorage.getApiKey("anthropic");
				const key2 = await authStorage.getApiKey("anthropic");

				expect(key1).toBeUndefined();
				expect(key2).toBeUndefined();

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_AUTH_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeAuthJson({
						anthropic: { type: "api_key", key: envVarName },
					});

					authStorage = AuthStorage.create(authJsonPath);

					const key1 = await authStorage.getApiKey("anthropic");
					expect(key1).toBe("first-value");

					process.env[envVarName] = "second-value";

					const key2 = await authStorage.getApiKey("anthropic");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});
		});
	});

	describe("oauth lock compromise handling", () => {
		test("returns undefined on compromised lock and allows a later retry", async () => {
			const providerId = `test-oauth-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			registerOAuthProvider({
				id: providerId,
				name: "Test OAuth Provider",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken(credentials) {
					return {
						...credentials,
						access: "refreshed-access-token",
						expires: Date.now() + 60_000,
					};
				},
				getApiKey(credentials) {
					return `Bearer ${credentials.access}`;
				},
			});

			writeAuthJson({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "expired-access-token",
					expires: Date.now() - 10_000,
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			const realLock = lockfile.lock.bind(lockfile);
			const lockSpy = vi.spyOn(lockfile, "lock");
			lockSpy.mockImplementationOnce(async (file, options) => {
				options?.onCompromised?.(new Error("Unable to update lock within the stale threshold"));
				return realLock(file, options);
			});

			const firstTry = await authStorage.getApiKey(providerId);
			expect(firstTry).toBeUndefined();

			lockSpy.mockRestore();

			const secondTry = await authStorage.getApiKey(providerId);
			expect(secondTry).toBe("Bearer refreshed-access-token");
		});
	});

	describe("persistence semantics", () => {
		test("set preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.set("anthropic", { type: "api_key", key: "new-anthropic" });

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic.key).toBe("new-anthropic");
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("remove preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.remove("anthropic");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic).toBeUndefined();
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("does not overwrite malformed auth file after load error", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();
			authStorage.set("openai", { type: "api_key", key: "openai-key" });

			const raw = readFileSync(authJsonPath, "utf-8");
			expect(raw).toBe("{invalid-json");
		});

		test.each([
			["an array", "[]"],
			["a string", '"x"'],
			["null", "null"],
		])("rejects %s auth file instead of silently treating it as a store", (_shape, rawContent) => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, rawContent, "utf-8");

			authStorage.reload();

			const errors = authStorage.drainErrors();
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]?.message).toContain("Invalid auth storage");
			// The last good store survives: malformed bytes must not read as "no credentials".
			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });

			// A disk-authoritative removal refuses loudly instead of reporting a no-op success.
			expect(() => authStorage.removeVerified("anthropic")).toThrow(/Invalid auth storage/);
		});

		test("a well-formed auth file still loads and writes unchanged", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.set("openai", { type: "api_key", key: "openai-key" });

			expect(authStorage.drainErrors()).toHaveLength(0);
			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });
			expect(JSON.parse(readFileSync(authJsonPath, "utf-8"))).toEqual({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
			});
		});
		test("removeVerified deletes from disk and memory", () => {
			writeAuthJson({
				"mcp:remote": { type: "api_key", key: "token" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.removeVerified("mcp:remote");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, unknown>;
			expect(updated["mcp:remote"]).toBeUndefined();
			expect(authStorage.get("mcp:remote")).toBeUndefined();
			expect((updated.openai as { key: string }).key).toBe("openai-key");
		});

		test("removeVerified throws while the credential may still exist on disk", () => {
			writeAuthJson({
				"mcp:remote": { type: "api_key", key: "token" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			expect(() => authStorage.removeVerified("mcp:remote")).toThrow();
		});

		test("reload records parse errors and drainErrors clears buffer", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();

			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });

			const firstDrain = authStorage.drainErrors();
			expect(firstDrain.length).toBeGreaterThan(0);
			expect(firstDrain[0]).toBeInstanceOf(Error);

			const secondDrain = authStorage.drainErrors();
			expect(secondDrain).toHaveLength(0);
		});
	});

	describe("auth status", () => {
		test("does not expose stored API keys or OAuth tokens", () => {
			authStorage = AuthStorage.inMemory({
				anthropic: { type: "api_key", key: "secret-api-key" },
				openai: {
					type: "oauth",
					access: "secret-access-token",
					refresh: "secret-refresh-token",
					expires: Date.now() + 1000,
				},
			});

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			expect(authStorage.getAuthStatus("openai")).toEqual({ configured: true, source: "stored" });
			expect(JSON.stringify(authStorage.getAuthStatus("anthropic"))).not.toContain("secret-api-key");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-access-token");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-refresh-token");
		});
	});

	describe("runtime overrides", () => {
		test("runtime override takes priority over auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("runtime-key");
		});

		test("removing runtime override falls back to auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			authStorage.removeRuntimeApiKey("anthropic");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("stored-key");
		});
	});

	describe("logout", () => {
		const ACCESS_SECRET = "ACCESS-TOKEN-SECRET-abc123def456";
		const REFRESH_SECRET = "REFRESH-TOKEN-SECRET-xyz789uvw012";
		const codexCredential = {
			type: "oauth" as const,
			access: ACCESS_SECRET,
			refresh: REFRESH_SECRET,
			expires: Date.now() + 3_600_000,
			accountId: "acct_1",
		};

		function topLevelFiles(): string[] {
			return readdirSync(tempDir, { withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) => join(tempDir, entry.name));
		}

		function filesHolding(secret: string): string[] {
			return topLevelFiles().filter((path) => readFileSync(path, "utf-8").includes(secret));
		}

		function writeLegacyCopy(name: string, data: Record<string, unknown>): string {
			const path = join(tempDir, name);
			writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o644 });
			return path;
		}

		// Positive control for every "no file holds the token" assertion below: the
		// same detector must flag a planted copy, otherwise a green result would only
		// prove that the detector cannot see anything.
		test("positive control: the token detector finds a planted copy", () => {
			writeLegacyCopy("oauth.json", { "openai-codex": { access: ACCESS_SECRET, refresh: REFRESH_SECRET } });

			expect(filesHolding(REFRESH_SECRET)).toEqual([join(tempDir, "oauth.json")]);
		});

		test("removes the migrated copy of the credential store, not just auth.json", () => {
			writeAuthJson({ "openai-codex": codexCredential });
			const migratedPath = writeLegacyCopy("oauth.json.migrated", {
				"openai-codex": { access: ACCESS_SECRET, refresh: REFRESH_SECRET },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.logout("openai-codex");

			expect(existsSync(migratedPath)).toBe(false);
			expect(filesHolding(ACCESS_SECRET)).toEqual([]);
			expect(filesHolding(REFRESH_SECRET)).toEqual([]);
			expect(authStorage.has("openai-codex")).toBe(false);
			expect(statSync(authJsonPath).mode & 0o777).toBe(0o600);
		});

		test("removes every historical credential-store name a logout could leave behind", () => {
			writeAuthJson({
				"openai-codex": codexCredential,
				anthropic: { type: "api_key", key: "unrelated-anthropic-key-000111" },
			});
			const leftovers = [
				"oauth.json",
				"oauth.json.bak",
				"oauth.json.migrated.2026-09-14",
				"auth.json.old",
				".auth.json.4242.abcdef.tmp",
			];
			for (const name of leftovers) {
				writeLegacyCopy(name, { "openai-codex": { access: ACCESS_SECRET, refresh: REFRESH_SECRET } });
			}

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.logout("openai-codex");

			for (const name of leftovers) {
				expect(existsSync(join(tempDir, name))).toBe(false);
			}
			expect(filesHolding(REFRESH_SECRET)).toEqual([]);
			// The unrelated provider stays logged in, and its live copy is private.
			expect(authStorage.has("anthropic")).toBe(true);
			expect(topLevelFiles().every((path) => (statSync(path).mode & 0o777) === 0o600)).toBe(true);
		});

		test("fails visibly when a legacy copy survives the removal", () => {
			writeAuthJson({ "openai-codex": codexCredential });
			// A directory where a file is expected: unlink cannot remove it, so the
			// caller must learn about the copy instead of seeing a success message.
			mkdirSync(join(tempDir, "oauth.json.migrated"));

			authStorage = AuthStorage.create(authJsonPath);

			expect(() => authStorage.logout("openai-codex")).toThrow(/oauth\.json\.migrated/);
		});

		test("fails visibly when another file still holds the credential", () => {
			writeAuthJson({ "openai-codex": codexCredential });
			writeLegacyCopy("creds-manual-copy.json", { refresh: REFRESH_SECRET });

			authStorage = AuthStorage.create(authJsonPath);

			expect(() => authStorage.logout("openai-codex")).toThrow(/creds-manual-copy\.json/);
		});

		test("in-memory storage has no state directory to clean", () => {
			authStorage = AuthStorage.inMemory({ "openai-codex": codexCredential });

			expect(() => authStorage.logout("openai-codex")).not.toThrow();
			expect(authStorage.has("openai-codex")).toBe(false);
		});
	});
});
