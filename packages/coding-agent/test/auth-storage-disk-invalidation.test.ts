import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage, FileAuthStorageBackend } from "../src/core/auth-storage.js";

/**
 * Round-27 SEC-6 (F3): auth.json edits made by other processes — a /login, a /logout,
 * a manual revoke — reach a resident worker through no channel at all, so the store
 * it constructed keeps serving the in-memory copy forever (an `api_key` has no
 * expiry). The fix is lazy: every credential read stats the file and reloads when the
 * on-disk identity moved.
 */

describe("AuthStorage lazy on-disk invalidation", () => {
	let tempDir: string;
	let authJsonPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-auth-disk-invalidation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
	});

	/** Overwrite the store as another process would, with a deterministically moved mtime. */
	let nextStamp = Date.now();
	function overwriteAuthJson(data: Record<string, unknown>): void {
		writeFileSync(authJsonPath, JSON.stringify(data, null, 2), { mode: 0o600 });
		nextStamp += 10_000;
		const stamp = new Date(nextStamp);
		utimesSync(authJsonPath, stamp, stamp);
	}

	test("serves a credential that another process rotated on disk after the store loaded", async () => {
		overwriteAuthJson({ anthropic: { type: "api_key", key: "sk-ant-first-key" } });
		const store = AuthStorage.create(authJsonPath);
		await expect(store.getApiKey("anthropic")).resolves.toBe("sk-ant-first-key");

		overwriteAuthJson({ anthropic: { type: "api_key", key: "sk-ant-second-rotated-key" } });

		await expect(store.getApiKey("anthropic")).resolves.toBe("sk-ant-second-rotated-key");
	});

	test("stops serving a credential another process revoked on disk", async () => {
		overwriteAuthJson({ anthropic: { type: "api_key", key: "sk-ant-live-key" } });
		const store = AuthStorage.create(authJsonPath);
		await expect(store.getApiKey("anthropic")).resolves.toBe("sk-ant-live-key");

		overwriteAuthJson({});

		await expect(store.getApiKey("anthropic")).resolves.toBeUndefined();
		expect(store.hasAuth("anthropic")).toBe(false);
	});

	test("a touch that leaves the bytes identical does not re-read the store", async () => {
		overwriteAuthJson({ anthropic: { type: "api_key", key: "sk-ant-live-key" } });
		const store = AuthStorage.create(authJsonPath);
		await expect(store.getApiKey("anthropic")).resolves.toBe("sk-ant-live-key");

		// Same bytes, new stat identity: not a credential change.
		nextStamp += 10_000;
		const stamp = new Date(nextStamp);
		utimesSync(authJsonPath, stamp, stamp);

		const withLockSpy = vi.spyOn(FileAuthStorageBackend.prototype, "withLock");
		await expect(store.getApiKey("anthropic")).resolves.toBe("sk-ant-live-key");
		expect(withLockSpy).not.toHaveBeenCalled();
	});

	test("an unchanged file costs no re-read (positive control)", async () => {
		overwriteAuthJson({ anthropic: { type: "api_key", key: "sk-ant-live-key" } });
		const store = AuthStorage.create(authJsonPath);

		const withLockSpy = vi.spyOn(FileAuthStorageBackend.prototype, "withLock");
		const readsAtConstruction = withLockSpy.mock.calls.length;

		await expect(store.getApiKey("anthropic")).resolves.toBe("sk-ant-live-key");
		expect(store.get("anthropic")).toBeDefined();
		expect(store.has("anthropic")).toBe(true);
		store.getAll();
		store.hasAuth("anthropic");

		expect(withLockSpy.mock.calls.length).toBe(readsAtConstruction);
	});
});
