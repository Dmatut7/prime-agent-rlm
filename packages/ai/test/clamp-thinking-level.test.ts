import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getSupportedThinkingLevels } from "../src/models.js";
import type { Model } from "../src/types.js";

type TestModel = Model<"openai-completions">;

function modelWithMap(thinkingLevelMap: Record<string, string | null>): TestModel {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
		thinkingLevelMap,
	} as TestModel;
}

// Map shapes taken from the local bailian models.json (r42 ④) plus restricted
// variants that exercise the clamp direction.
const deepseekFull = modelWithMap({
	off: "none",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "max",
	max: "max",
});
// Levels are disabled by explicit null entries (a missing key defaults the level
// on for off..high), so these shapes are the real restricted-support cases.
const deepseekRestricted = modelWithMap({ off: "none", minimal: null, low: "low", medium: null, high: "high" });
const restrictedMinimal = modelWithMap({ off: "none", minimal: "low", low: null, medium: null, high: "high" });
const lowHighMax = modelWithMap({ off: "none", low: "low", high: "high", max: "max" });
const kimiK3 = modelWithMap({
	off: null,
	minimal: "low",
	low: "low",
	medium: "high",
	high: "high",
	xhigh: "max",
	max: "max",
});
const offHighOnly = modelWithMap({ off: "none", minimal: null, low: null, medium: null, high: "high" });
const noMap = { ...deepseekFull, thinkingLevelMap: undefined } as TestModel;
const nonReasoning = { ...deepseekFull, reasoning: false, thinkingLevelMap: undefined } as TestModel;

describe("clampThinkingLevel (r43 MC-3)", () => {
	it("is the identity for every supported level (equivalence rows)", () => {
		for (const model of [deepseekFull, kimiK3, deepseekRestricted, restrictedMinimal, offHighOnly]) {
			for (const level of getSupportedThinkingLevels(model)) {
				expect(clampThinkingLevel(model, level)).toBe(level);
			}
		}
	});

	it("clamps downward on the enabled side instead of rounding up", () => {
		// deepseek-restricted (off, low, high): medium used to clamp UP to high.
		expect(clampThinkingLevel(deepseekRestricted, "medium")).toBe("low");
		expect(clampThinkingLevel(deepseekRestricted, "minimal")).toBe("low");
		expect(clampThinkingLevel(restrictedMinimal, "medium")).toBe("minimal");
		// [low, high, max]: an unsupported xhigh still maps to the model's own top
		// tier (max) - the same shape the shipped anthropic opus-4.6 test pins. The
		// r42 ④F4 complaint was mid-range requests rounding UP; the top-tier request
		// mapping to the top tier is the intended semantics.
		expect(clampThinkingLevel(lowHighMax, "xhigh")).toBe("max");
	});

	it("never silently crosses the on/off boundary", () => {
		// [off, high] only: no enabled tier exists at or below medium, so the
		// minimum enabled tier is used (unchanged row - high, not off).
		expect(clampThinkingLevel(offHighOnly, "medium")).toBe("high");
		expect(clampThinkingLevel(offHighOnly, "low")).toBe("high");
	});

	it("off on a model without off stays at the minimum enabled tier, not max", () => {
		// kimi-k3 / glm-5.3 shape (off: null): today this already lands on minimal;
		// pin it so the downward-first rewrite cannot jump to max or silently off.
		expect(clampThinkingLevel(kimiK3, "off")).toBe("minimal");
		expect(getSupportedThinkingLevels(kimiK3)).not.toContain("off");
	});

	it("keeps the default-set behavior for models without a map (equivalence)", () => {
		expect(getSupportedThinkingLevels(noMap)).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(clampThinkingLevel(noMap, "xhigh")).toBe("high");
		expect(clampThinkingLevel(noMap, "max")).toBe("high");
		expect(clampThinkingLevel(noMap, "medium")).toBe("medium");
		expect(getSupportedThinkingLevels(nonReasoning)).toEqual(["off"]);
		expect(clampThinkingLevel(nonReasoning, "high")).toBe("off");
	});

	it("falls back to the first available level for invalid levels", () => {
		expect(clampThinkingLevel(deepseekRestricted, "bogus" as never)).toBe("off");
	});
});
