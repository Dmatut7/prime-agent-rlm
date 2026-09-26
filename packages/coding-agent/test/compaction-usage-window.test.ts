import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	type CompactionSettings,
	type CompactionWindowLimits,
	capKeepRecentTokens,
	compactionThresholdTokens,
	compactionTriggerBaseTokens,
	prepareCompaction,
	shouldCompact,
} from "../src/core/compaction/compaction.js";
import { computeSummarizationInputBudget } from "../src/core/compaction/summarization-budget.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { effectiveInputLimitTokens } from "../src/core/model-input-limits.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { SessionEntry } from "../src/core/session-manager.js";
import { FooterComponent, type FooterTelemetrySnapshot } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * W1 (context-pressure-guard): the compaction trigger must be a ratio of
 * min(contextWindow, usageWindowTokens), where usageWindowTokens is the new
 * optional models.json field declaring a rate-quota heuristic. The matrix
 * below reproduces the production shape that motivated the knob: a model
 * whose catalog window is 1M whose gateway's per-time-window token budget
 * (the live example: 200k tokens/10s, per the provider's models/limits
 * endpoint) sits far below it. That budget is a rate quota, not a
 * per-request wall: the same gateway accepted a 560,938-token single request
 * on the same day, and its 429s arrive with zero usage after large preceding
 * prompts - the shape of a window's budget being burned down, not a single
 * oversized request being rejected. Setting the field is therefore an
 * optional tuning knob (it moves the trigger from 700k to 140k on this
 * model, ~5x more compactions), not a default fix. Absent field => fall back
 * to the declared window.
 */

// The live settings.json value as of 2026-09-25 (reserveTokens 16384, triggerRatio 0.7).
const SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16_384,
	keepRecentTokens: 20_000,
	triggerRatio: 0.7,
};

// tokensBefore of the one compaction in session 01a0d360 (2026-09-25 19:18:05).
// 581,435 is a different number: the 19:17:10 assistant message's usage.totalTokens.
const CONTEXT_581K = 581_244;

// deepseek-v4-pro as declared in ~/.prime/agent/models.json: contextWindow 1,000,000.
// Gateway rate quota (provider models/limits endpoint): 200k tokens per 10s window
// => usageWindowTokens 200000 as the rate-quota heuristic.
const PRO_LIMITS: CompactionWindowLimits = {
	provider: "aliyun-maas",
	modelId: "deepseek-v4-pro",
	usageWindowTokens: 200_000,
};

// qwen3.8-max as declared: contextWindow 1,000,000, no usageWindowTokens field
// (its 500k/6s figure is a rate quota like the above; the operator leaves it
// unset rather than paying the ~5x compaction-frequency cost of guessing).
const QWEN_LIMITS: CompactionWindowLimits = { provider: "aliyun-maas", modelId: "qwen3.8-max" };

describe("W1 threshold matrix: pro@581k triggers / qwen@581k does not / no-field fallback", () => {
	it("pro with usageWindowTokens=200000: 581k context triggers", () => {
		// base = min(1M declared, 200k serving cap) = 200000; threshold =
		// min(0.7*200000, 200000-16384) = 140000. 581435 > 140000.
		expect(compactionTriggerBaseTokens(1_000_000, PRO_LIMITS)).toBe(200_000);
		expect(compactionThresholdTokens(1_000_000, SETTINGS, PRO_LIMITS)).toBe(140_000);
		expect(shouldCompact(CONTEXT_581K, 1_000_000, SETTINGS, PRO_LIMITS)).toBe(true);
	});

	it("qwen without the field: 581k does not trigger (fallback to declared window)", () => {
		// base = 1,000,000 (no field, no measured entry for aliyun-maas/qwen3.8-max);
		// threshold = min(0.7*1M, 1M-16384) = 700000. 581435 < 700000.
		expect(compactionTriggerBaseTokens(1_000_000, QWEN_LIMITS)).toBe(1_000_000);
		expect(compactionThresholdTokens(1_000_000, SETTINGS, QWEN_LIMITS)).toBe(700_000);
		expect(shouldCompact(CONTEXT_581K, 1_000_000, SETTINGS, QWEN_LIMITS)).toBe(false);
	});

	it("no limits object at all: same fallback to the declared window", () => {
		expect(compactionThresholdTokens(1_000_000, SETTINGS, undefined)).toBe(700_000);
		expect(shouldCompact(CONTEXT_581K, 1_000_000, SETTINGS, undefined)).toBe(false);
	});

	it("absent field + measured entry: the measured limit still wins, unchanged (zero-breakage pin)", () => {
		// bailian/qwen3.8-max-0902 declares 1,000,000, measured 983,616: with no
		// usageWindowTokens the trigger base must stay exactly the pre-PR value.
		const limits = { provider: "bailian", modelId: "qwen3.8-max-0902" };
		expect(compactionTriggerBaseTokens(1_000_000, limits)).toBe(983_616);
		expect(effectiveInputLimitTokens(1_000_000, "bailian", "qwen3.8-max-0902", undefined)).toBe(983_616);
	});

	it("a cap above the declared window cannot widen it", () => {
		// Hand-built Model objects bypass registry validation; the clamp holds anyway.
		expect(effectiveInputLimitTokens(1_000_000, undefined, undefined, 2_000_000)).toBe(1_000_000);
	});

	it("a non-positive or zero cap is ignored, not treated as zero window", () => {
		expect(effectiveInputLimitTokens(1_000_000, undefined, undefined, 0)).toBe(1_000_000);
		expect(effectiveInputLimitTokens(1_000_000, undefined, undefined, -5)).toBe(1_000_000);
		// An unset field must never silently disable the trigger.
		expect(shouldCompact(CONTEXT_581K, 1_000_000, SETTINGS, { usageWindowTokens: undefined })).toBe(false);
	});

	it("a declared cap lower than a measured limit wins (min of both)", () => {
		// kimi-k3: declared 1048576, measured 1000000 (bailian/kimi-k3 table entry).
		// A 600k serving cap tightens below the measured limit.
		const limits = { provider: "bailian", modelId: "kimi-k3", usageWindowTokens: 600_000 };
		expect(compactionTriggerBaseTokens(1_048_576, limits)).toBe(600_000);
		expect(compactionThresholdTokens(1_048_576, SETTINGS, limits)).toBe(420_000);
	});

	it("the default 0.8 ratio still applies when no ratio is configured", () => {
		const defaultSettings: CompactionSettings = {
			enabled: true,
			reserveTokens: 16_384,
			keepRecentTokens: 20_000,
			triggerRatio: 0.8,
		};
		expect(compactionThresholdTokens(1_000_000, defaultSettings, PRO_LIMITS)).toBe(160_000);
	});
});

describe("W1 summarization budget: the same serving-window cap clamps the compaction request", () => {
	it("clamps the input limit to usageWindowTokens", () => {
		const budget = computeSummarizationInputBudget({
			contextWindow: 1_000_000,
			reserveTokens: 16_384,
			systemPromptText: "system",
			wrapperText: "wrapper",
			provider: "aliyun-maas",
			modelId: "deepseek-v4-pro",
			usageWindowTokens: 200_000,
		});
		expect(budget.inputLimit).toBe(200_000);
	});

	it("without the field the budget is unchanged (regression guard)", () => {
		const withCap = (cap?: number) =>
			computeSummarizationInputBudget({
				contextWindow: 1_000_000,
				reserveTokens: 16_384,
				systemPromptText: "system",
				wrapperText: "wrapper",
				provider: "aliyun-maas",
				modelId: "deepseek-v4-pro",
				usageWindowTokens: cap,
			});
		// No cap, no measured entry for aliyun-maas/deepseek-v4-pro: 1,000,000.
		expect(withCap(undefined).inputLimit).toBe(1_000_000);
		expect(withCap(undefined).inputLimit).toBe(withCap(2_000_000).inputLimit);
	});
});

describe("W1 keepRecent and boundary: the cap reaches prepareCompaction (R1-M2/M5)", () => {
	// The production shape of the M2 bug: keepRecentTokens 150,000 on a capped
	// model whose threshold is 140,000 - an uncapped keepRecent above the
	// threshold is the "re-fire every turn" mode capKeepRecentTokens exists to
	// prevent, and _performCompaction used to hand it uncapped limits.
	const CAPPED: CompactionWindowLimits = {
		provider: "aliyun-maas",
		modelId: "deepseek-v4-pro",
		usageWindowTokens: 200_000,
	};
	const settings: CompactionSettings = {
		enabled: true,
		reserveTokens: 16_384,
		keepRecentTokens: 150_000,
		triggerRatio: 0.7,
	};

	it("capKeepRecentTokens clamps the retained slice under the capped threshold", () => {
		// threshold = min(0.7*200000, 200000-16384) = 140000; keepRecent 150000 -> 140000.
		expect(capKeepRecentTokens(settings, 1_000_000, CAPPED)).toBe(140_000);
		expect(capKeepRecentTokens(settings, 1_000_000, CAPPED)).toBe(
			compactionThresholdTokens(1_000_000, settings, CAPPED),
		);
		// Without the cap the same settings keep 150000 (threshold 700000 wins).
		expect(capKeepRecentTokens(settings, 1_000_000, { provider: "aliyun-maas", modelId: "deepseek-v4-pro" })).toBe(
			150_000,
		);
	});

	it("prepareCompaction cuts deeper when the cap pulls keepRecent under the threshold", () => {
		const entries: SessionEntry[] = [];
		let lastId: string | null = null;
		let counter = 0;
		const pushEntry = (message: Record<string, unknown>) => {
			const id = `w1-entry-${counter++}`;
			entries.push({
				type: "message",
				id,
				parentId: lastId,
				timestamp: new Date().toISOString(),
				message,
			} as unknown as SessionEntry);
			lastId = id;
		};
		for (let i = 0; i < 40; i++) {
			pushEntry({
				role: "user",
				content: `user ${i} ${"y".repeat(20_000)}`,
				timestamp: Date.now(),
			});
			pushEntry({
				role: "assistant",
				content: [{ type: "text", text: `assistant ${i} ${"a".repeat(400)}` }],
				usage: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
				api: "openai-completions",
				provider: "aliyun-maas",
				model: "deepseek-v4-pro",
			});
		}
		const capped = prepareCompaction(entries, settings, 1_000_000, CAPPED);
		const uncapped = prepareCompaction(entries, settings, 1_000_000, undefined);
		expect(capped).toBeDefined();
		expect(uncapped).toBeDefined();
		// The capped cut point must sit strictly deeper (earlier) in the branch.
		const indexOf = (id: string | undefined) => entries.findIndex((entry) => entry.id === id);
		expect(indexOf(capped!.firstKeptEntryId)).toBeGreaterThan(indexOf(uncapped!.firstKeptEntryId));
	});

	it("a cap at or below reserveTokens stands threshold compaction down (documented M5 boundary)", () => {
		// cap 16384 == reserve: base - reserve = 0, and 0.7 * 16384 < reserve too.
		const atReserve = { ...CAPPED, usageWindowTokens: 16_384 };
		expect(compactionThresholdTokens(1_000_000, settings, atReserve)).toBe(0);
		expect(shouldCompact(50_000, 1_000_000, settings, atReserve)).toBe(false);
		expect(capKeepRecentTokens(settings, 1_000_000, atReserve)).toBe(0);
		// A one-digit typo (20000 meant as 200000) does not zero the threshold but
		// degenerates it to 3616 - the reserve eats the whole capped base. That
		// zone is documented in docs/compaction.md as "stands down".
		const typo = { ...CAPPED, usageWindowTokens: 20_000 };
		expect(compactionThresholdTokens(1_000_000, settings, typo)).toBe(3_616);
	});
});

describe("W1 models.json: usageWindowTokens parses, overrides, and validates", () => {
	// Hermetic by construction (same pattern as model-registry.test.ts): a temp
	// models.json and a sibling temp auth.json, so the real ~/.prime/agent/models.json
	// and the Prime CLI config (~/.prime/config.json, only consulted when
	// usePrimeCliConfig is on, which an explicit auth path turns off) are never read.
	// No vi.resetModules / dynamic import is needed: vitest.config.ts aliases the
	// workspace packages (e.g. @earendil-works/pi-ai) to their src, so the test
	// and any tsx-based probe run against the same sources.

	const MODELS_JSON = {
		providers: {
			"aliyun-maas": {
				name: "Aliyun MaaS",
				baseUrl: "https://example.invalid/v1",
				apiKey: "test-key",
				api: "openai-completions",
				models: [
					{
						id: "deepseek-v4-pro",
						name: "DeepSeek v4 Pro",
						contextWindow: 1_000_000,
						maxTokens: 384_000,
						usageWindowTokens: 200_000,
					},
					{ id: "qwen3.8-max", name: "Qwen 3.8 Max", contextWindow: 1_000_000, maxTokens: 32_768 },
				],
				modelOverrides: {
					"qwen3.8-max": { usageWindowTokens: 400_000 },
				},
			},
		},
	};

	function registryWith(modelsJson: unknown): { registry: ModelRegistry; dir: string } {
		const dir = mkdtempSync(join(tmpdir(), "w1-models-"));
		const path = join(dir, "models.json");
		writeFileSync(path, JSON.stringify(modelsJson));
		// Empty auth store in the same temp dir: no real credentials are read.
		const registry = ModelRegistry.create(AuthStorage.create(join(dir, "auth.json")), path);
		return { registry, dir };
	}

	function cleanup(dir: string): void {
		rmSync(dir, { recursive: true, force: true });
	}

	it("parses the field on a custom model definition; absent field stays undefined", () => {
		const { registry, dir } = registryWith(MODELS_JSON);
		try {
			const models = registry.getAll();
			// A built-in `deepseek/deepseek-v4-pro` also exists; match provider+id.
			const pro = models.find((m) => m.provider === "aliyun-maas" && m.id === "deepseek-v4-pro");
			const qwen = models.find((m) => m.provider === "aliyun-maas" && m.id === "qwen3.8-max");
			expect(pro?.usageWindowTokens).toBe(200_000);
			expect(pro?.contextWindow).toBe(1_000_000);
			expect(qwen?.usageWindowTokens).toBeUndefined();
			expect(qwen?.contextWindow).toBe(1_000_000);
		} finally {
			cleanup(dir);
		}
	});

	it("applies usageWindowTokens to a built-in model through modelOverrides", () => {
		const { registry, dir } = registryWith({
			providers: {
				anthropic: { modelOverrides: { "claude-sonnet-4-5": { usageWindowTokens: 100_000 } } },
			},
		});
		try {
			const model = registry.getAll().find((m) => m.id === "claude-sonnet-4-5");
			expect(model?.usageWindowTokens).toBe(100_000);
			expect(model?.contextWindow).toBeGreaterThan(100_000);
		} finally {
			cleanup(dir);
		}
	});

	it("an invalid override value is rejected too (R1-M4: the override path validates like the definition path)", () => {
		// Non-positive override value.
		const zero = {
			providers: {
				anthropic: { modelOverrides: { "claude-sonnet-4-5": { usageWindowTokens: 0 } } },
			},
		};
		const { registry: zeroRegistry, dir: zeroDir } = registryWith(zero);
		try {
			expect(zeroRegistry.getError() ?? "").toContain("invalid usageWindowTokens");
		} finally {
			cleanup(zeroDir);
		}

		// A value above the built-in model's declared window would widen, not tighten.
		const wide = {
			providers: {
				anthropic: { modelOverrides: { "claude-sonnet-4-5": { usageWindowTokens: 5_000_000 } } },
			},
		};
		const { registry: wideRegistry, dir: wideDir } = registryWith(wide);
		try {
			expect(wideRegistry.getError() ?? "").toContain("exceeds contextWindow");
		} finally {
			cleanup(wideDir);
		}
	});

	it("a definition with only usageWindowTokens above the 128000 default is rejected, not silently clamped away (R1-M4)", () => {
		// No contextWindow: parseModels defaults it to 128000, so a 500000 cap is
		// min-clamped to nothing at runtime - it must be a validation error instead.
		const silent = {
			providers: {
				"custom-proxy": {
					baseUrl: "https://example.invalid/v1",
					apiKey: "test-key",
					api: "openai-completions",
					models: [{ id: "m2", name: "M2", usageWindowTokens: 500_000 }],
				},
			},
		};
		const { registry, dir } = registryWith(silent);
		try {
			expect(registry.getError() ?? "").toContain("exceeds contextWindow (128000)");
		} finally {
			cleanup(dir);
		}
	});

	it("an invalid value on the definition path is rejected: the file is not adopted", () => {
		// Non-positive: invalid usageWindowTokens.
		const zero = JSON.parse(JSON.stringify(MODELS_JSON)) as typeof MODELS_JSON;
		(zero.providers["aliyun-maas"].models as any[])[0].usageWindowTokens = 0;
		const { registry: zeroReg, dir: zeroDir } = registryWith(zero);
		try {
			const error = zeroReg.getError();
			expect(error ?? "").toContain("invalid usageWindowTokens");
			// The custom model with the rejected file is not adopted.
			expect(zeroReg.getAll().some((m) => m.provider === "aliyun-maas" && m.id === "deepseek-v4-pro")).toBe(false);
		} finally {
			cleanup(zeroDir);
		}
	});

	it("a usageWindowTokens above the declared contextWindow is rejected", () => {
		const wide = JSON.parse(JSON.stringify(MODELS_JSON)) as typeof MODELS_JSON;
		(wide.providers["aliyun-maas"].models as any[])[0].usageWindowTokens = 3_000_000;
		const { registry, dir } = registryWith(wide);
		try {
			const error = registry.getError();
			expect(error ?? "").toContain("usageWindowTokens (3000000) exceeds contextWindow (1000000)");
			expect(registry.getAll().some((m) => m.provider === "aliyun-maas" && m.id === "deepseek-v4-pro")).toBe(false);
		} finally {
			cleanup(dir);
		}
	});
});

describe("W1 footer: one hint line when the serving-window cap is below the declared window", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	const provider = { getGitBranch: () => null } as never;

	function footerLine(snapshot: FooterTelemetrySnapshot, width = 120): string {
		const footer = new FooterComponent(provider);
		footer.setTelemetrySource(() => ({ mode: "on", snapshot }));
		return stripAnsi(footer.render(width).join("\n"));
	}

	it("shows the serving-cap hint when usageWindowTokens < contextWindow", () => {
		const line = footerLine({
			modelName: "aliyun-maas/deepseek-v4-pro",
			contextTokens: 130_000,
			contextWindow: 1_000_000,
			compactionThresholdTokens: 140_000,
			usageWindowTokens: 200_000,
		});
		expect(line).toContain("窗限200k");
		// The threshold readout still scales against the declared window.
		expect(line).toContain("130k/1M");
	});

	it("no hint when the cap is absent, equal, or above the window", () => {
		const base = {
			modelName: "aliyun-maas/qwen3.8-max",
			contextTokens: 130_000,
			contextWindow: 1_000_000,
			compactionThresholdTokens: 700_000,
		};
		expect(footerLine({ ...base })).not.toContain("窗限");
		expect(footerLine({ ...base, usageWindowTokens: 1_000_000 })).not.toContain("窗限");
		expect(footerLine({ ...base, usageWindowTokens: 2_000_000 })).not.toContain("窗限");
	});
});
