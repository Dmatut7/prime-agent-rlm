import { describe, expect, it } from "vitest";
// The root entry on purpose: #14 asserts the new named export is reachable from
// `@earendil-works/pi-ai`, and src/index.ts is what that specifier resolves to.
import {
	adjustMaxTokensForThinking,
	getModels,
	getSupportedThinkingLevels,
	modelCannotDisableThinking,
} from "../src/index.js";
import type { Api, Model } from "../src/types.js";

/** glm-5.3 shape from ~/.prime/agent/models.json: zai, reasoning, `off` unsupported. */
const glmShape = {
	id: "glm-5.3",
	provider: "bailian",
	reasoning: true,
	maxTokens: 131_072,
	thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
} as unknown as Model<"openai-completions">;

/** deepseek-v4.1-flash shape: can disable thinking (`off: "none"`). */
const deepseekShape = {
	id: "deepseek-v4.1-flash",
	provider: "bailian",
	reasoning: true,
	maxTokens: 384_000,
	thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high" },
} as unknown as Model<"openai-completions">;

/** kimi-k3 shape: `openai` thinking format, but `off` is still unsupported. */
const kimiShape = {
	id: "kimi-k3",
	provider: "bailian",
	reasoning: true,
	maxTokens: 131_072,
	thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high" },
} as unknown as Model<"openai-completions">;

const nonReasoningShape = {
	id: "qwen3-30b-a3b-instruct-2507",
	provider: "prime-inference",
	reasoning: false,
	maxTokens: 32_768,
	thinkingLevelMap: { off: null },
} as unknown as Model<"openai-completions">;

const undeclaredShape = {
	id: "undeclared",
	provider: "bailian",
	reasoning: true,
	maxTokens: 65_536,
} as unknown as Model<"openai-completions">;

describe("#14 adjustMaxTokensForThinking is reachable from the package root entry", () => {
	it("is a function exported by src/index.ts", () => {
		expect(typeof adjustMaxTokensForThinking).toBe("function");
	});

	it("reserves the medium budget (8192) and stays under model.maxTokens", () => {
		// The assumed level is hard-wired to "medium" at every budget call site.
		expect(adjustMaxTokensForThinking(400, 131_072, "medium")).toEqual({ maxTokens: 8592, thinkingBudget: 8192 });
		expect(adjustMaxTokensForThinking(400, 4_096, "medium")).toEqual({ maxTokens: 4_096, thinkingBudget: 3072 });
	});

	it('negative control: "off" is not assignable and would silently produce NaN', () => {
		// Compile-time control: if "off" ever becomes a valid ThinkingLevel, tsgo reports
		// this directive as unused and the build fails, which is the point - the default
		// budget table has no "off" key, so the arithmetic degrades to NaN instead of
		// throwing. Call sites must keep hard-wiring a real level.
		// @ts-expect-error "off" is a ModelThinkingLevel, not a ThinkingLevel
		const result = adjustMaxTokensForThinking(400, 131_072, "off");
		expect(Number.isNaN(result.maxTokens)).toBe(true);
	});
});

describe("#15 the thinking reserve is keyed on modelCannotDisableThinking", () => {
	it("is true for a reasoning model whose capability table marks off unsupported", () => {
		expect(modelCannotDisableThinking(glmShape)).toBe(true);
		expect(modelCannotDisableThinking(kimiShape)).toBe(true);
	});

	it('is false for a reasoning model that can disable thinking (off:"none")', () => {
		expect(modelCannotDisableThinking(deepseekShape)).toBe(false);
	});

	it("is false for a non-reasoning model even when off is null in its map", () => {
		// getSupportedThinkingLevels() answers ["off"] for a non-reasoning model, so the
		// `reasoning` conjunct is what keeps it out of the reserve path.
		expect(modelCannotDisableThinking(nonReasoningShape)).toBe(false);
		expect(getSupportedThinkingLevels(nonReasoningShape)).toEqual(["off"]);
	});

	it("is false when the model never declared a capability table", () => {
		expect(modelCannotDisableThinking(undeclaredShape)).toBe(false);
	});

	it("holds for every model in the generated registry", () => {
		const models: Model<Api>[] = [...getModels("openai"), ...getModels("anthropic")];
		expect(models.length).toBeGreaterThan(0);
		const nonReasoning = models.filter((model) => !model.reasoning);
		// Positive control for the non-reasoning half: the registry really contains such models.
		expect(nonReasoning.length).toBeGreaterThan(0);
		for (const model of models) {
			const cannotDisable = modelCannotDisableThinking(model);
			expect(cannotDisable && !model.reasoning, `${model.provider}/${model.id}`).toBe(false);
			if (cannotDisable) {
				expect(getSupportedThinkingLevels(model), `${model.provider}/${model.id}`).not.toContain("off");
			} else if (!model.reasoning) {
				expect(getSupportedThinkingLevels(model), `${model.provider}/${model.id}`).toEqual(["off"]);
			}
		}
	});
});
