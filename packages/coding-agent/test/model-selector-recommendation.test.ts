import type { Model } from "@earendil-works/pi-ai";
import { Container, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	ModelSelectorComponent,
	type ModelSessionProfile,
	recommendModelForSession,
} from "../src/modes/interactive/components/model-selector.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "./suite/harness.js";

/**
 * The /model recommendation: one suggested model plus the reasons for it, both
 * derived from the session profile (what this session is doing) crossed with the
 * model's own metadata (reasoning, image input, context window, featured flag) -
 * never a hardcoded blurb.
 */

function model(id: string, overrides: Partial<Model<any>> = {}): Model<any> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test",
		baseUrl: "http://localhost",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_000,
		...overrides,
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("recommendModelForSession", () => {
	it("prefers a vision-capable model when the session works with images, and says why", () => {
		const textOnly = model("text-only");
		const vision = model("vision", { input: ["text", "image"] });

		const recommendation = recommendModelForSession([textOnly, vision], { hasImages: true });

		expect(recommendation?.model.id).toBe("vision");
		expect(recommendation?.reasons.join("\n")).toContain("图片");
	});

	it("recommends nothing for an image session when no candidate can see", () => {
		const recommendation = recommendModelForSession([model("a"), model("b")], { hasImages: true });
		expect(recommendation).toBeUndefined();
	});

	it("prefers a reasoning model when the session runs a deep thinking level", () => {
		const plain = model("plain", { reasoning: false });
		const thinker = model("thinker", { reasoning: true });

		const recommendation = recommendModelForSession([plain, thinker], { thinkingLevel: "high" });

		expect(recommendation?.model.id).toBe("thinker");
		expect(recommendation?.reasons.join("\n")).toContain("high");
		expect(recommendation?.reasons.join("\n")).toContain("推理");
	});

	it("points at a bigger window when the session is filling the current one", () => {
		const current = model("current", { contextWindow: 100_000 });
		const same = model("same", { contextWindow: 100_000 });
		const bigger = model("bigger", { contextWindow: 400_000 });

		const recommendation = recommendModelForSession(
			[same, bigger],
			{ contextTokens: 70_000, contextPercent: 70 },
			current,
		);

		expect(recommendation?.model.id).toBe("bigger");
		expect(recommendation?.reasons.join("\n")).toContain("400k");
	});

	it("does not sell window size when the session is nowhere near full", () => {
		const current = model("current", { contextWindow: 100_000 });
		const bigger = model("bigger", { contextWindow: 400_000 });

		const recommendation = recommendModelForSession([bigger], { contextTokens: 5_000, contextPercent: 5 }, current);

		expect(recommendation?.reasons.join("\n") ?? "").not.toContain("400k");
	});

	it("never recommends the model the session is already on", () => {
		const current = model("current", { reasoning: true, input: ["text", "image"] });

		const recommendation = recommendModelForSession([current], { hasImages: true, thinkingLevel: "high" }, current);

		expect(recommendation).toBeUndefined();
	});

	it("falls back to the provider's featured model when the session gives no signal", () => {
		const plain = model("plain");
		const flagship = model("flagship", { featured: true });

		const recommendation = recommendModelForSession([plain, flagship], {});

		expect(recommendation?.model.id).toBe("flagship");
		expect(recommendation?.reasons.join("\n")).toContain("旗舰");
	});

	it("recommends nothing at all when nothing is worth saying", () => {
		expect(recommendModelForSession([model("a"), model("b")], {})).toBeUndefined();
	});

	it("breaks ties on the cheaper model, deterministically", () => {
		const dear = model("dear", { featured: true, cost: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } });
		const cheap = model("cheap", { featured: true, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });

		const recommendation = recommendModelForSession([dear, cheap], {});

		expect(recommendation?.model.id).toBe("cheap");
	});
});

describe("ModelSelectorComponent recommendation", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createSelector(
		models: Model<any>[],
		options: { currentModel?: Model<any>; sessionProfile?: ModelSessionProfile } = {},
	) {
		const harness = await createHarness({ models: [{ id: "faux-1", name: "One", reasoning: true }] });
		harnesses.push(harness);
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			options.currentModel,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			undefined,
			{
				availableModels: models,
				configuredProviders: new Set(models.map((candidate) => candidate.provider)),
				sessionProfile: options.sessionProfile,
			},
		);
		return selector;
	}

	it("shows the recommendation line with its reason, and badges the recommended row", async () => {
		const selector = await createSelector([model("text-only"), model("vision", { input: ["text", "image"] })], {
			sessionProfile: { hasImages: true },
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("推荐");
		expect(output).toContain("vision");
		expect(output).toContain("图片");
	});

	it("shows no recommendation when the session profile has nothing to say", async () => {
		const selector = await createSelector([model("plain-a"), model("plain-b")], { sessionProfile: {} });

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).not.toContain("推荐");
	});

	it("updates the recommendation live when the session profile lands after the menu opened", async () => {
		const selector = await createSelector([model("plain"), model("thinker", { reasoning: true })]);

		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("推荐");

		selector.setSessionProfile({ thinkingLevel: "xhigh" });

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("推荐");
		expect(output).toContain("thinker");
		expect(output).toContain("推理");
	});

	it("never recommends a model from an unconfigured provider", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", name: "One", reasoning: true }] });
		harnesses.push(harness);
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			undefined,
			{
				availableModels: [model("locked-vision", { provider: "locked", input: ["text", "image"] })],
				configuredProviders: new Set<string>(),
				sessionProfile: { hasImages: true },
			},
		);

		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("推荐");
	});
});

describe("interactive-mode /model profile wiring", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("hands the live session profile to the selector inside the open menu", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", name: "One", reasoning: true }] });
		harnesses.push(harness);
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			undefined,
			{
				availableModels: [model("plain"), model("vision", { input: ["text", "image"] })],
				configuredProviders: new Set(["test"]),
			},
		);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			connectionState: {
				thinkingLevel: "high",
				contextUsage: { tokens: 70_000, contextWindow: 100_000, percent: 70 },
			},
			sessionHasImages: true,
		});
		const apply = Reflect.get(InteractiveMode.prototype, "applyModelSessionProfile") as (
			this: typeof mode,
			menu: { children: readonly unknown[] },
		) => void;

		// A menu that opened on another tab has no selector in its tree: no profile lands.
		apply.call(mode, { children: [new Container()] });
		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("推荐");

		apply.call(mode, { children: [selector] });
		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("推荐");
		expect(output).toContain("vision");
		expect(output).toContain("图片");
	});
});
