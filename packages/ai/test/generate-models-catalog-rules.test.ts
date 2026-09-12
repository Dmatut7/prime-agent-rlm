/**
 * Pins the catalog rules this fork took from upstream 3b51ce330 (#2057).
 *
 * scripts/generate-models.ts calls generateModels() at import time (four live
 * endpoints, and it rewrites the committed src/models.generated.ts), so it has
 * no importable seam; like build-catalog-determinism.test.ts, these assertions
 * read the generator source. The last case reads the committed catalog and
 * fails if a regeneration ever loses the OpenRouter-derived limits for the
 * renamed Qwen route - which is exactly what the alias mapping prevents.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generator = readFileSync(join(packageRoot, "scripts", "generate-models.ts"), "utf8");
const catalog = readFileSync(join(packageRoot, "src", "models.generated.ts"), "utf8");

function primeInferenceOpenRouterAliases(): Record<string, string> {
	const declaration = generator.match(
		/const PRIME_INFERENCE_OPENROUTER_ALIASES: Record<string, string> = \{([\s\S]*?)\n\};/,
	);
	expect(declaration, "PRIME_INFERENCE_OPENROUTER_ALIASES declaration").toBeTruthy();
	return Object.fromEntries([...declaration![1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
}

function primeInferenceCatalogRow(modelId: string): string {
	const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const row = catalog.match(
		new RegExp(`"${escaped}": \\{[\\s\\S]*?provider: "prime-inference"[\\s\\S]*?\\} satisfies Model<`),
	);
	expect(row, `prime-inference catalog row for ${modelId}`).toBeTruthy();
	return row![0];
}

describe("generator catalog rules", () => {
	it("maps Prime ids whose OpenRouter route was renamed", () => {
		// OpenRouter serves the dated id; Prime Inference still serves the undated
		// one, so metadata lookups have to cross the rename or miss entirely.
		expect(primeInferenceOpenRouterAliases()["qwen/qwen3.8-max"]).toBe("qwen/qwen3.8-max-0902");
	});

	it("keeps the renamed Qwen route off the conservative Prime fallback", () => {
		// A miss falls back to PRIME_INFERENCE_DEFAULT_CONTEXT_WINDOW/MAX_TOKENS,
		// which would under-declare this model's window by ~8x on the next regen.
		expect(generator).toContain("const PRIME_INFERENCE_DEFAULT_CONTEXT_WINDOW = 128000");
		const row = primeInferenceCatalogRow("qwen/qwen3.8-max");
		expect(row).toContain("contextWindow: 1000000");
		expect(row).toContain("maxTokens: 131072");
	});

	it("classifies gpt-6 reasoning as mandatory with xhigh and max efforts", () => {
		const rule = generator.match(/if \(model\.id\.includes\("gpt-6"\)\) \{([\s\S]*?)\n\t\}/);
		expect(rule, "gpt-6 thinking-level rule").toBeTruthy();
		expect(rule![1]).toContain('mergeThinkingLevelMap(model, { minimal: null, xhigh: "xhigh", max: "max" })');
		// Responses-API gpt-6 rows additionally drop the "off" effort.
		const responsesRule = generator.match(
			/if \(\s*\(model\.api === "openai-responses" \|\| model\.api === "azure-openai-responses"\) &&\s*model\.id\.startsWith\("gpt-6"\),?\s*\) \{([\s\S]*?)\n\t\}/,
		);
		expect(responsesRule, "gpt-6 responses thinking-level rule").toBeTruthy();
		expect(responsesRule![1]).toContain("mergeThinkingLevelMap(model, { off: null })");
	});

	it("routes Copilot gpt-6 models through the Responses API", () => {
		const routing = generator.match(/const needsResponsesApi =[\s\S]*?;/);
		expect(routing, "copilot needsResponsesApi rule").toBeTruthy();
		expect(routing![0]).toContain('modelId.startsWith("gpt-5")');
		expect(routing![0]).toContain('modelId.startsWith("gpt-6")');
	});
});
