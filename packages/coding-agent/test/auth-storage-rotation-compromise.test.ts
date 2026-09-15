import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A thief that breaks the auth.json lock while the holder's refresh HTTP call is
 * still in flight fires proper-lockfile's onCompromised mid-critical-section.
 * The mock reproduces exactly that timing: `deferred` arms the callback so the
 * test can fire it from inside `fn`, after the refresh "succeeded" but before
 * the holder has written the rotated pair.
 */
const stolen = vi.hoisted(() => ({ deferred: true, trigger: null as null | (() => void) }));

vi.mock("proper-lockfile", () => {
	const lock = vi.fn(async (_path: string, options?: { onCompromised?: (error: Error) => void }) => {
		if (!stolen.deferred) {
			options?.onCompromised?.(new Error("auth storage lock was compromised at acquisition"));
		} else {
			stolen.trigger = () => options?.onCompromised?.(new Error("auth storage lock was stolen mid-refresh"));
		}
		return async () => {};
	});
	const lockSync = vi.fn(() => () => {});
	return { default: { lock, lockSync }, lock, lockSync };
});

import { FileAuthStorageBackend } from "../src/core/auth-storage.js";

const tempDirs: string[] = [];

afterEach(() => {
	stolen.deferred = true;
	stolen.trigger = null;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** The pre-refresh state: one oauth credential whose refresh token is single-use. */
function oldAuthJson(): string {
	return JSON.stringify(
		{ anthropic: { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 1 } },
		null,
		2,
	);
}

/** What a successful refresh hands back: the server has already revoked old-refresh. */
function rotatedAuthJson(): string {
	return JSON.stringify(
		{
			anthropic: {
				type: "oauth",
				access: "fresh-access",
				refresh: "fresh-refresh",
				expires: 4102444800000,
			},
		},
		null,
		2,
	);
}

describe("auth storage async lock stolen mid-refresh", () => {
	it("persists the rotated pair before surfacing the stolen lock", async () => {
		const authPath = join(tempDir("pa-auth-rotate-"), "auth.json");
		writeFileSync(authPath, oldAuthJson());
		const storage = new FileAuthStorageBackend(authPath);

		const refresh = storage.withLockAsync(async () => {
			// The thief breaks the lock while the refresh HTTP call is in flight; the
			// call still completes and the server has rotated the refresh token.
			stolen.trigger?.();
			return { result: "fresh-access", next: rotatedAuthJson() };
		});

		// The compromise still surfaces: the caller falls into its reload() recovery.
		await expect(refresh).rejects.toThrow(/stolen mid-refresh/);
		// The fresh pair must already be on disk. Dropping it (the old order:
		// throw before write) leaves auth.json holding a refresh token the server
		// has revoked, and every later refresh fails with invalid_grant until a
		// manual /login.
		const onDisk = JSON.parse(readFileSync(authPath, "utf8")) as { anthropic?: { refresh?: string } };
		expect(onDisk.anthropic?.refresh).toBe("fresh-refresh");
	});

	it("refuses the mutation before running it when the lock is compromised at acquisition", async () => {
		stolen.deferred = false;
		const authPath = join(tempDir("pa-auth-acq-"), "auth.json");
		writeFileSync(authPath, oldAuthJson());
		const storage = new FileAuthStorageBackend(authPath);

		await expect(storage.withLockAsync(async () => ({ result: "never", next: rotatedAuthJson() }))).rejects.toThrow(
			/compromised at acquisition/,
		);
		// Nothing to persist: fn never ran, and no write may happen.
		expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual(JSON.parse(oldAuthJson()));
	});

	it("positive control: a healthy lock writes the rotation and returns the result", async () => {
		const authPath = join(tempDir("pa-auth-healthy-"), "auth.json");
		writeFileSync(authPath, oldAuthJson());
		const storage = new FileAuthStorageBackend(authPath);

		const result = await storage.withLockAsync(async () => ({
			result: "fresh-access",
			next: rotatedAuthJson(),
		}));

		expect(result).toBe("fresh-access");
		const onDisk = JSON.parse(readFileSync(authPath, "utf8")) as { anthropic?: { refresh?: string } };
		expect(onDisk.anthropic?.refresh).toBe("fresh-refresh");
	});
});
