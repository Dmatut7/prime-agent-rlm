/**
 * Extension factory / awaitWithTimeout liveness backstop.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } from "../src/core/extensions/loader.js";
import { awaitWithTimeout, ExtensionAbortedError, ExtensionTimeoutError } from "../src/core/extensions/timeout.js";

describe("awaitWithTimeout", () => {
	it("resolves when the work finishes before the timeout", async () => {
		await expect(awaitWithTimeout(Promise.resolve("ok"), { timeoutMs: 200, label: "fast" })).resolves.toBe("ok");
	});

	it("rejects with ExtensionTimeoutError when the work never returns", async () => {
		const started = Date.now();
		await expect(awaitWithTimeout(new Promise(() => {}), { timeoutMs: 30, label: "factory" })).rejects.toBeInstanceOf(
			ExtensionTimeoutError,
		);
		expect(Date.now() - started).toBeLessThan(500);
	});

	it("rejects with ExtensionAbortedError when the signal aborts", async () => {
		const controller = new AbortController();
		const started = Date.now();
		const pending = awaitWithTimeout(new Promise(() => {}), {
			timeoutMs: 5_000,
			signal: controller.signal,
			label: "factory",
		});
		setTimeout(() => controller.abort(), 15);
		await expect(pending).rejects.toBeInstanceOf(ExtensionAbortedError);
		expect(Date.now() - started).toBeLessThan(500);
	});

	it("treats timeoutMs 0 as no wall-clock timeout", async () => {
		const controller = new AbortController();
		const pending = awaitWithTimeout(new Promise((resolve) => setTimeout(() => resolve("done"), 20)), {
			timeoutMs: 0,
			signal: controller.signal,
			label: "factory",
		});
		await expect(pending).resolves.toBe("done");
	});

	it("keeps a handler on the input promise when the signal is already aborted", async () => {
		// Daemon mode exits the whole process on unhandledRejection, so the early-abort
		// path must leave the caller's promise handled even though it never settles it.
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const controller = new AbortController();
			controller.abort();
			let rejectInput: (error: Error) => void = () => {};
			const input = new Promise<string>((_resolve, reject) => {
				rejectInput = reject;
			});
			await expect(
				awaitWithTimeout(input, { timeoutMs: 30_000, signal: controller.signal, label: "handler" }),
			).rejects.toBeInstanceOf(ExtensionAbortedError);
			rejectInput(new Error("handler failed after abort"));
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(unhandled).toHaveLength(0);
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});
});

describe("extension factory timeout", () => {
	let tempDir: string;

	afterEach(() => {
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("fails a hanging inline factory without waiting forever", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		const started = Date.now();
		await expect(
			loadExtensionFromFactory(
				async () => {
					await new Promise(() => {});
				},
				process.cwd(),
				eventBus,
				runtime,
				"<hang>",
				40,
			),
		).rejects.toBeInstanceOf(ExtensionTimeoutError);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("records a hanging file factory as a load error and continues", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-timeout-"));
		const hangPath = path.join(tempDir, "hang.ts");
		const okPath = path.join(tempDir, "ok.ts");
		fs.writeFileSync(
			hangPath,
			`
				export default async function() {
					await new Promise(() => {});
				}
			`,
		);
		fs.writeFileSync(
			okPath,
			`
				export default function(pi) {
					pi.on("agent_start", async () => {});
				}
			`,
		);

		const started = Date.now();
		const result = await loadExtensions([hangPath, okPath], tempDir, undefined, 40);
		expect(Date.now() - started).toBeLessThan(1000);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].error).toContain("timed out");
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toBe(okPath);
	});
});
