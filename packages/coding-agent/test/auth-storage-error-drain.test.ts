import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type LogEntry, type Model, setLogSink } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

/**
 * The credential store records what failed and carries on, so a caller that never
 * drains is a caller that never learns: an OAuth refresh failure ended up as a bare
 * "No API key found", and the recorded buffer grew without bound.
 *
 * These regressions pin the two halves of the fix: the buffer is bounded and says
 * when it dropped something, and a production caller (ModelRegistry, on the auth
 * failure it is about to report) consumes it.
 */

const RECORDED_ERROR_CAP = 20;

const testModelDef = {
	id: "creds-model",
	name: "Creds Model",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 8000,
};

describe("AuthStorage recorded errors", () => {
	let tempDir: string;
	let authPath: string;
	const sinkEntries: LogEntry[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-auth-error-drain-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authPath = join(tempDir, "auth.json");
		sinkEntries.length = 0;
		setLogSink((entry) => sinkEntries.push(entry));
	});

	afterEach(() => {
		setLogSink(undefined);
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	function breakStoreWithSymlink(): void {
		rmSync(authPath, { force: true });
		symlinkSync(join(tempDir, "target.json"), authPath);
	}

	function breakStoreWithInvalidJson(): void {
		rmSync(authPath, { force: true });
		writeFileSync(authPath, "{ not json", { mode: 0o600 });
	}

	test("bounds the recorded buffer instead of growing it without limit", () => {
		const store = AuthStorage.create(authPath);
		expect(store.drainErrors()).toEqual([]);

		// 25 unreadable-store failures, then 5 parse failures: the newest must win.
		breakStoreWithSymlink();
		for (let i = 0; i < 25; i++) store.reload();
		expect(store.drainErrors()).toHaveLength(RECORDED_ERROR_CAP);

		breakStoreWithSymlink();
		for (let i = 0; i < 25; i++) store.reload();
		breakStoreWithInvalidJson();
		for (let i = 0; i < 5; i++) store.reload();

		const drained = store.drainErrors();
		expect(drained).toHaveLength(RECORDED_ERROR_CAP);
		expect(drained.filter((error) => /JSON|Unexpected|Expected/.test(error.message))).toHaveLength(5);
		expect(store.drainErrors()).toEqual([]);
	});

	test("reports that it dropped older errors instead of truncating them silently", () => {
		const store = AuthStorage.create(authPath);
		breakStoreWithSymlink();
		for (let i = 0; i < RECORDED_ERROR_CAP + 3; i++) store.reload();

		const warnings = sinkEntries.filter((entry) => entry.level === "warn" && /dropped/.test(String(entry.msg)));
		expect(warnings.map((entry) => entry.dropped)).toEqual([1, 2, 3]);
		expect(warnings[0]?.component).toBe("coding-agent.auth-storage");
	});

	const model = {
		id: testModelDef.id,
		name: testModelDef.name,
		api: "anthropic-messages",
		provider: "creds-provider",
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: testModelDef.contextWindow,
		maxTokens: testModelDef.maxTokens,
	} as Model<Api>;

	test("a recorded credential error reaches the caller that reports the auth failure", async () => {
		const registry = ModelRegistry.inMemory(AuthStorage.create(authPath));
		const brokenStore = registry.authStorage;
		// The production shape of a failed load/refresh: the store carries on and records.
		breakStoreWithSymlink();
		brokenStore.reload();
		brokenStore.reload();

		const result = await registry.getApiKeyAndHeaders(model);

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain("non-regular private file");
		expect(result.ok === false && result.error).toContain('No API key is available for "creds-provider"');
		// Drained, not read: the same failure is not reported by the next request.
		expect(brokenStore.drainErrors()).toEqual([]);
	});

	test("does not invent a credential error when the store recorded none", async () => {
		const registry = ModelRegistry.inMemory(AuthStorage.create(authPath));

		const result = await registry.getApiKeyAndHeaders(model);

		// Positive control for the drain: no recorded error means the old shape is kept.
		expect(result).toMatchObject({ ok: true, apiKey: undefined });
	});
});
