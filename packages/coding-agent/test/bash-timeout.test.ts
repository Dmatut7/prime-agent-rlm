import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBashToolDefinition, DEFAULT_BASH_TIMEOUT_SECONDS } from "../src/core/tools/bash.js";

describe("bash tool timeout policy", () => {
	const tempDirs: string[] = [];

	function makeCwd(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-bash-timeout-"));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	async function runBash(args: { command: string; timeout?: number }, options?: { defaultTimeoutSeconds?: number }) {
		const definition = createBashToolDefinition(makeCwd(), options);
		const startedAt = Date.now();
		try {
			const result = await definition.execute("call-1", args, undefined, undefined, undefined as never);
			return { elapsedMs: Date.now() - startedAt, result, error: undefined as Error | undefined };
		} catch (error) {
			return { elapsedMs: Date.now() - startedAt, result: undefined, error: error as Error };
		}
	}

	it("applies the default timeout when the model passes none", async () => {
		const { elapsedMs, error } = await runBash({ command: "sleep 5" }, { defaultTimeoutSeconds: 0.3 });
		expect(error).toBeDefined();
		expect(elapsedMs).toBeLessThan(3000);
		expect(error?.message).toContain("timed out after 0.3 seconds");
		expect(error?.message).toContain("was killed");
	});

	it("timeout error tells the model how to extend it (unit, default, escape hatch)", async () => {
		const { error } = await runBash({ command: "sleep 5" }, { defaultTimeoutSeconds: 0.3 });
		expect(error?.message).toContain("timeout parameter");
		expect(error?.message).toContain("seconds");
		expect(error?.message).toContain("0.3s");
		expect(error?.message).toContain("timeout: 0");
	});

	it("an explicit timeout overrides the default", async () => {
		const { elapsedMs, error } = await runBash({ command: "sleep 5", timeout: 0.2 }, { defaultTimeoutSeconds: 30 });
		expect(error).toBeDefined();
		expect(elapsedMs).toBeLessThan(3000);
		expect(error?.message).toContain("timed out after 0.2 seconds");
	});

	it("timeout: 0 disables the timeout (escape hatch)", async () => {
		const { result, error, elapsedMs } = await runBash(
			{ command: "sleep 0.6 && echo survived", timeout: 0 },
			{ defaultTimeoutSeconds: 0.2 },
		);
		expect(error).toBeUndefined();
		expect(elapsedMs).toBeGreaterThanOrEqual(500);
		const text = result?.content?.[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("survived");
	});

	it("a negative timeout also disables the timeout", async () => {
		const { result, error } = await runBash(
			{ command: "sleep 0.6 && echo survived", timeout: -1 },
			{ defaultTimeoutSeconds: 0.2 },
		);
		expect(error).toBeUndefined();
		const text = result?.content?.[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("survived");
	});

	it("built-in default is a bounded 600s and appears in the schema/description", () => {
		expect(DEFAULT_BASH_TIMEOUT_SECONDS).toBe(600);
		const definition = createBashToolDefinition(makeCwd());
		expect(definition.description).toContain("600s");
		const timeoutSchema = (definition.parameters.properties as Record<string, { description?: string }>).timeout;
		expect(timeoutSchema?.description).toContain("600");
		const unlimited = createBashToolDefinition(makeCwd(), { defaultTimeoutSeconds: 0 });
		expect(unlimited.description).toContain("no default timeout");
	});
});
