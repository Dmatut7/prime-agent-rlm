import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage, type AuthStorageBackend } from "../src/core/auth-storage.js";

/**
 * Regression tests for the /login silent-fake-success gap: with a corrupt or
 * unwritable credential store, the plain `set()` updated only process memory, so
 * the login dialog reported success for a credential that never reached disk.
 * `setVerified` throws instead, and the skipped optimistic write is at least
 * drainable via `drainErrors()`.
 */
describe("AuthStorage verified writes", () => {
	let tempDir: string;
	let authJsonPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-auth-verified-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
	});

	function writeCorruptAuthJson(): void {
		writeFileSync(authJsonPath, "{ not json");
	}

	test("setVerified throws when the store failed to load and keeps the credential out of memory", () => {
		writeCorruptAuthJson();
		const storage = AuthStorage.create(authJsonPath);

		expect(() => storage.setVerified("anthropic", { type: "api_key", key: "sk-ant-test" })).toThrow(
			/credential store failed to load/,
		);
		expect(storage.get("anthropic")).toBeUndefined();
	});

	test("set() on a broken store stays optimistic but records the skipped write", () => {
		writeCorruptAuthJson();
		const storage = AuthStorage.create(authJsonPath);
		storage.drainErrors();

		expect(() => storage.set("anthropic", { type: "api_key", key: "sk-ant-test" })).not.toThrow();
		// In-memory only: the process can use the key, but nothing reached disk.
		expect(storage.get("anthropic")?.type).toBe("api_key");
		expect(JSON.parse(readFileSync(authJsonPath, "utf-8").replace("{ not json", "{}"))).toEqual({});

		const errors = storage.drainErrors().map((error) => error.message);
		expect(errors.some((message) => message.includes('Credential change for "anthropic" was not persisted'))).toBe(
			true,
		);
	});

	test("setVerified persists and the credential round-trips through a fresh store", () => {
		const storage = AuthStorage.create(authJsonPath);
		storage.setVerified("anthropic", { type: "api_key", key: "sk-ant-round-trip" });

		const reloaded = AuthStorage.create(authJsonPath);
		expect(reloaded.get("anthropic")).toEqual({ type: "api_key", key: "sk-ant-round-trip" });
	});

	test("setVerified throws when the credential cannot be read back", () => {
		// A backend whose writes silently vanish: withLock runs the updater but drops
		// `next`, so the read-back can never see the credential.
		const silentBackend: AuthStorageBackend = {
			withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
				return fn(undefined).result;
			},
			async withLockAsync<T>(
				fn: (current: string | undefined) => Promise<{ result: T; next?: string }>,
			): Promise<T> {
				return (await fn(undefined)).result;
			},
		};
		const storage = AuthStorage.fromStorage(silentBackend);

		expect(() => storage.setVerified("anthropic", { type: "api_key", key: "sk-ant-test" })).toThrow(
			/could not be read back/,
		);
	});

	test("setVerified works against the in-memory backend", () => {
		const storage = AuthStorage.inMemory();
		storage.setVerified("anthropic", { type: "api_key", key: "sk-ant-mem" });
		expect(storage.get("anthropic")).toEqual({ type: "api_key", key: "sk-ant-mem" });
	});

	test("OAuth login reports failure when the store cannot hold the credential", async () => {
		writeCorruptAuthJson();
		const storage = AuthStorage.create(authJsonPath);
		const providerId = `test-oauth-verified-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		registerOAuthProvider({
			id: providerId,
			name: "Test OAuth Verified",
			async login() {
				return { access: "access-token", refresh: "refresh-token", expires: Date.now() + 60_000 };
			},
			async refreshToken(credentials) {
				return credentials;
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await expect(storage.login(providerId, { onAuth: () => {}, onPrompt: async () => "" })).rejects.toThrow(
			/credential store failed to load/,
		);
	});

	test("OAuth login persists through the verified write on a healthy store", async () => {
		const storage = AuthStorage.create(authJsonPath);
		const providerId = `test-oauth-verified-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		registerOAuthProvider({
			id: providerId,
			name: "Test OAuth Verified",
			async login() {
				return { access: "access-token", refresh: "refresh-token", expires: Date.now() + 60_000 };
			},
			async refreshToken(credentials) {
				return credentials;
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await storage.login(providerId, { onAuth: () => {}, onPrompt: async () => "" });

		const reloaded = AuthStorage.create(authJsonPath);
		const stored = reloaded.get(providerId);
		expect(stored?.type).toBe("oauth");
	});
});
