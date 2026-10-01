import { describe, expect, it } from "vitest";
import { sleep } from "../src/utils/sleep.js";

describe("sleep options", () => {
	it("resolves after the requested delay with no options", async () => {
		const startedAt = Date.now();
		await sleep(20);
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
	});

	it("rejects on abort by default", async () => {
		const controller = new AbortController();
		const pending = sleep(30_000, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow("Aborted");
	});

	it("rejects immediately on an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(sleep(1, controller.signal)).rejects.toThrow("Aborted");
	});

	it("resolves on abort with resolveOnAbort, for loops that re-check the signal themselves", async () => {
		const controller = new AbortController();
		const pending = sleep(30_000, { signal: controller.signal, resolveOnAbort: true });
		controller.abort();
		await expect(pending).resolves.toBeUndefined();
	});

	it("resolves immediately on an already-aborted signal with resolveOnAbort", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(sleep(30_000, { signal: controller.signal, resolveOnAbort: true })).resolves.toBeUndefined();
	});

	it("still waits out an unaborted resolveOnAbort sleep", async () => {
		const controller = new AbortController();
		const startedAt = Date.now();
		await sleep(20, { signal: controller.signal, resolveOnAbort: true });
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
	});

	it("resolves with an unref'd timer", async () => {
		await expect(sleep(10, { unref: true })).resolves.toBeUndefined();
	});

	it("keeps accepting a bare AbortSignal as the second argument", async () => {
		const controller = new AbortController();
		const pending = sleep(30_000, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow("Aborted");
	});
});
