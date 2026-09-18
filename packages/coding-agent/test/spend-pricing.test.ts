import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ContextTreeNode } from "../src/core/context-tree.js";
import {
	collectSpendPriceSources,
	createSpendPricing,
	nodeSpendMoney,
	readSpendPriceOverrides,
	SPEND_PRICE_OVERRIDES_PATH,
	type SpendPriceRates,
	spendOverrideCorrection,
} from "../src/core/spend-pricing.js";

/**
 * `ui.subagentSpendCell.priceOverrides` exists because a wrong rate in
 * `models.json` left the user with no place to fix it. These pins cover the
 * resolution rules the two spend surfaces share: the override wins field by
 * field, `models.json` fills the rest, a model without an override keeps the
 * money recorded on its messages, and an unusable value is refused loudly
 * enough for the settings layer to report it.
 */

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

/** The models.json rates every fixture model is billed at unless a test says otherwise. */
const MODELS_JSON_RATES: SpendPriceRates = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 4 };

function pricing(
	overrides: Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>,
	ratesFor: (model: { provider: string; id: string }) => SpendPriceRates | undefined = () => MODELS_JSON_RATES,
) {
	return createSpendPricing({ overrides, ratesFor });
}

function node(overrides: Partial<ContextTreeNode>): ContextTreeNode {
	return {
		id: "sub-1",
		label: "worker",
		status: "done" as const,
		ownUsage: usage(0, 0),
		totalUsage: usage(0, 0),
		children: [],
		...overrides,
	};
}

describe("spend price overrides", () => {
	const model = { provider: "bailian", id: "kimi-k3" };

	it("prices a model's tokens with the override, and leaves other models on their recorded money", () => {
		const cost = pricing({ "bailian/kimi-k3": { input: 7, output: 9 } });
		const billed = usage(1_000_000, 1_000_000);

		// 1M input at 7 + 1M output at 9; models.json's own rates never apply here.
		expect(cost.attribute(model, billed)).toEqual({ cost: 16, source: "override" });
		// A model the user did not correct has no attribution at all: its messages
		// already carry the money they were billed, and re-pricing them would move
		// figures nobody asked to move.
		expect(cost.attribute({ provider: "bailian", id: "qwen3.8-flash" }, billed)).toBeUndefined();
		// No model on the node (a legacy entry): the recorded money stands too.
		expect(cost.attribute(undefined, billed)).toBeUndefined();
	});

	it("falls back to the models.json rate for every field the override leaves out", () => {
		const cost = pricing({ "bailian/kimi-k3": { input: 7 } });
		// input from the override (7), output/cacheRead/cacheWrite from models.json
		// (2 / 0.5 / 4) - the same field-wise fallback `modelOverrides` uses.
		expect(cost.attribute(model, usage(1_000_000, 1_000_000, 1_000_000, 1_000_000))).toEqual({
			cost: 13.5,
			source: "override",
		});
	});

	it("makes a model that models.json has no rates for billable at all", () => {
		const noRates = () => undefined;
		const before = pricing({}, noRates);
		expect(before.isPriced(model)).toBe(false);
		expect(before.attribute(model, usage(1_000_000, 1_000_000))).toBeUndefined();

		const corrected = pricing({ "bailian/kimi-k3": { input: 3, output: 15 } }, noRates);
		expect(corrected.isPriced(model)).toBe(true);
		expect(corrected.attribute(model, usage(1_000_000, 1_000_000))).toEqual({ cost: 18, source: "override" });
	});

	it("reads an all-zero models.json cost block as unpriced, like the registry does", () => {
		const zeros = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(pricing({}, zeros).isPriced(model)).toBe(false);
		// An override field turns it billable without inventing rates it does not set.
		expect(pricing({ "bailian/kimi-k3": { output: 15 } }, zeros).isPriced(model)).toBe(true);
	});

	it("keeps the usable fields of an override and names every value it refused", () => {
		const { overrides, problems } = readSpendPriceOverrides(
			{
				"bailian/kimi-k3": { input: 3, output: -1, cacheRead: "0.5", cacheWrite: 0 },
				"bailian/qwen3.8-flash": { cachRead: 1, output: 15 },
				"bailian/glm-5.3": 7,
				"not-a-model-key": { input: 1 },
				"bailian/empty": {},
			},
			SPEND_PRICE_OVERRIDES_PATH,
		);

		// A refused field never takes its model's other fields (or another model)
		// down with it: input 3 and cacheWrite 0 survive, the other two fall back.
		expect(overrides).toEqual({
			"bailian/kimi-k3": { input: 3, cacheWrite: 0 },
			"bailian/qwen3.8-flash": { output: 15 },
		});
		expect(problems).toEqual([
			{
				kind: "value",
				path: `${SPEND_PRICE_OVERRIDES_PATH}["bailian/kimi-k3"].output`,
				found: "-1",
			},
			{
				kind: "value",
				path: `${SPEND_PRICE_OVERRIDES_PATH}["bailian/kimi-k3"].cacheRead`,
				found: '"0.5"',
			},
			{
				kind: "unknown-field",
				path: `${SPEND_PRICE_OVERRIDES_PATH}["bailian/qwen3.8-flash"].cachRead`,
				found: "1",
			},
			{
				kind: "entry",
				path: `${SPEND_PRICE_OVERRIDES_PATH}["bailian/glm-5.3"]`,
				found: "7",
			},
			{
				kind: "key",
				path: `${SPEND_PRICE_OVERRIDES_PATH}["not-a-model-key"]`,
				found: '"not-a-model-key"',
			},
		]);
		// An entry with no usable field is the no-op it is: dropped, not reported,
		// and never mistaken for a correction that took effect.
		expect(pricing(overrides).hasOverrides).toBe(true);
	});

	it("refuses a rate that is not a finite number >= 0", () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.5, "5", null, [1], { input: 1 }]) {
			const { overrides, problems } = readSpendPriceOverrides({ "p/m": { input: bad } }, "overrides");
			expect(overrides).toEqual({});
			expect(problems).toHaveLength(1);
			expect(problems[0]?.kind).toBe("value");
			expect(problems[0]?.path).toBe('overrides["p/m"].input');
		}
		// Zero is a rate, not a missing value: providers really do charge nothing
		// for some cache writes, and dropping it would resurrect a rate the user
		// explicitly cleared.
		expect(readSpendPriceOverrides({ "p/m": { cacheWrite: 0 } }, "overrides").overrides).toEqual({
			"p/m": { cacheWrite: 0 },
		});
	});

	it("reports a whole block that is not an object", () => {
		const { overrides, problems } = readSpendPriceOverrides("bailian/kimi-k3", "overrides");
		expect(overrides).toEqual({});
		expect(problems).toEqual([{ kind: "entry", path: "overrides", found: '"bailian/kimi-k3"' }]);
		// Absent is not broken: no override configured is the normal case.
		expect(readSpendPriceOverrides(undefined, "overrides")).toEqual({ overrides: {}, problems: [] });
	});

	it("leaves a node's recorded money alone unless its model is overridden", () => {
		const recorded = node({ model, ownUsage: usage(2_000, 1_000, 0, 0, 1.2) });
		expect(nodeSpendMoney(recorded, undefined)).toBe(1.2);
		expect(nodeSpendMoney(recorded, pricing({}))).toBe(1.2);

		const overridden = node({ model, ownUsage: usage(1_000_000, 0, 0, 0, 1.2) });
		// 1M input at the corrected 3, not the recorded 1.2.
		expect(nodeSpendMoney(overridden, pricing({ "bailian/kimi-k3": { input: 3 } }))).toBe(3);
	});

	it("sums every node's correction, so a published total can be corrected by the same amount", () => {
		const root = node({
			id: "root",
			model: { provider: "bailian", id: "kimi-k3" },
			ownUsage: usage(1_000_000, 0, 0, 0, 1),
			children: [node({ id: "sub-1", model, ownUsage: usage(1_000_000, 0, 0, 0, 1) })],
		});
		// Root and child both move from 1 (recorded) to 3 (corrected): +2 each.
		expect(spendOverrideCorrection(root, pricing({ "bailian/kimi-k3": { input: 3 } }))).toBeCloseTo(4);
		// Nothing overridden, nothing corrected: the header figure is untouched.
		expect(spendOverrideCorrection(root, pricing({}))).toBe(0);
	});

	it("lists each model that spent money with the rates that priced it", () => {
		const root = node({
			id: "root",
			model: { provider: "bailian", id: "kimi-k3" },
			ownUsage: usage(1_000_000, 0, 0, 0, 1),
			children: [
				node({ id: "sub-1", model, ownUsage: usage(1_000_000, 0, 0, 0, 1) }),
				node({
					id: "sub-2",
					model: { provider: "bailian", id: "qwen3.8-flash" },
					ownUsage: usage(1_000_000, 0, 0, 0, 1),
				}),
				// Never spent anything: nothing to explain about its price.
				node({ id: "sub-3", model: { provider: "bailian", id: "glm-5.3" }, ownUsage: usage(0, 0) }),
			],
		});

		expect(collectSpendPriceSources(root, pricing({ "bailian/kimi-k3": { input: 3 } }))).toEqual([
			{ model: "bailian/kimi-k3", tokens: 2_000_000, cost: 6, source: "override" },
			{ model: "bailian/qwen3.8-flash", tokens: 1_000_000, cost: 1, source: "models.json" },
		]);
	});
});
