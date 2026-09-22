import type { Usage } from "@earendil-works/pi-ai";
import type { ContextTreeNode } from "./context-tree.js";

/**
 * Pricing for the TUI's spend figures: which rates a model's spend is billed at,
 * and where those rates came from.
 *
 * The baseline is `models.json` (read through the model registry): its `cost`
 * block is the per-million-token rate the provider already used to record the
 * money on every assistant message. When a rate there is wrong,
 * `ui.subagentSpendCell.priceOverrides` corrects it without editing that file -
 * and the correction re-prices the model's recorded tokens, so the figure on
 * screen is fixed too, not only the turns that follow. A field left out of an
 * override keeps the `models.json` rate (the same field-wise fallback
 * `modelOverrides` uses), so a single wrong number is fixable on its own.
 */

/** Per-million-token rates: the unit a `models.json` `cost` block is written in. */
export interface SpendPriceRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** One model's price correction; a field left out falls back to the `models.json` rate. */
export type SpendPriceRateOverride = Partial<SpendPriceRates>;

/** The rate fields an override may name, in the order warnings list them. */
export const SPEND_PRICE_RATE_FIELDS: readonly SpendPriceRateField[] = ["input", "output", "cacheRead", "cacheWrite"];

export type SpendPriceRateField = keyof SpendPriceRates;

/** `ui.subagentSpendCell.priceOverrides`: `"<provider>/<model-id>"` -> correction. */
export type SpendPriceOverrides = Readonly<Record<string, SpendPriceRateOverride>>;

/** Which rates priced a model's money. */
export type SpendPriceSource = "override" | "models.json";

/** Full settings path of the override block, so warnings and annotations name the same key. */
export const SPEND_PRICE_OVERRIDES_PATH = "ui.subagentSpendCell.priceOverrides";

/** The settings key one model is corrected under. */
export function spendPriceKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/** A usable rate: money per token, so finite and never negative. */
export function isUsableSpendRate(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Spend-relevant tokens: the four billed fields, matching the "Total" line of /usage. */
export function spendRelevantTokens(usage: Usage): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** What priced one usage, when an override applies. */
export interface SpendPriceAttribution {
	cost: number;
	source: SpendPriceSource;
}

/** Why one value in the override block could not be used. */
export type SpendPriceOverrideProblemKind = "value" | "unknown-field" | "entry" | "key";

export interface SpendPriceOverrideProblem {
	kind: SpendPriceOverrideProblemKind;
	/** Full settings path of the offending value, e.g. `...priceOverrides["p/m"].input`. */
	path: string;
	/** The offending value, already rendered for a one-line warning. */
	found: string;
}

export interface SpendPriceOverrideRead {
	/** The usable part of the block, per model key. */
	overrides: Record<string, SpendPriceRateOverride>;
	/** Everything refused, so the caller can report it instead of silently dropping it. */
	problems: SpendPriceOverrideProblem[];
}

/** One rejected value, rendered without echoing a whole settings file. */
function describeRejectedValue(value: unknown): string {
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (value === undefined) {
		return "undefined";
	}
	if (typeof value === "number") {
		return Number.isNaN(value) ? "NaN" : String(value);
	}
	try {
		const rendered = JSON.stringify(value);
		return rendered === undefined ? String(value) : rendered;
	} catch {
		return String(value);
	}
}

function isOverridableEntry(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the override block: keep what is usable, name what is not.
 *
 * A refused field falls back to the `models.json` rate on its own - it never
 * takes the rest of that model's correction (or any other model's) down with
 * it. An entry that is not an object, a key that cannot match a model (a
 * `"<provider>/<model-id>"` key always carries one "/"), a field name this
 * version does not know, and a value that is not a finite number >= 0 are all
 * reported: a correction that quietly does nothing is the failure this whole
 * setting exists to prevent. An entry with no usable field at all is dropped
 * as the no-op it is.
 */
export function readSpendPriceOverrides(raw: unknown, basePath: string): SpendPriceOverrideRead {
	const overrides: Record<string, SpendPriceRateOverride> = {};
	const problems: SpendPriceOverrideProblem[] = [];
	if (raw === undefined) {
		return { overrides, problems };
	}
	if (!isOverridableEntry(raw)) {
		problems.push({ kind: "entry", path: basePath, found: describeRejectedValue(raw) });
		return { overrides, problems };
	}
	for (const [key, entry] of Object.entries(raw)) {
		const entryPath = `${basePath}[${JSON.stringify(key)}]`;
		const slash = key.indexOf("/");
		if (key.trim().length === 0 || slash <= 0 || slash === key.length - 1) {
			problems.push({ kind: "key", path: entryPath, found: describeRejectedValue(key) });
			continue;
		}
		if (!isOverridableEntry(entry)) {
			problems.push({ kind: "entry", path: entryPath, found: describeRejectedValue(entry) });
			continue;
		}
		const override: SpendPriceRateOverride = {};
		for (const [field, value] of Object.entries(entry)) {
			const fieldPath = `${entryPath}.${field}`;
			if (!SPEND_PRICE_RATE_FIELDS.includes(field as SpendPriceRateField)) {
				problems.push({ kind: "unknown-field", path: fieldPath, found: describeRejectedValue(value) });
				continue;
			}
			if (!isUsableSpendRate(value)) {
				problems.push({ kind: "value", path: fieldPath, found: describeRejectedValue(value) });
				continue;
			}
			override[field as SpendPriceRateField] = value;
		}
		if (Object.keys(override).length > 0) {
			overrides[key] = override;
		}
	}
	return { overrides, problems };
}

export interface SpendPricing {
	/** Whether the user configured at least one usable override (any model, used or not). */
	readonly hasOverrides: boolean;
	/** The model keys the user configured, in settings order (usable entries only). */
	readonly overrideKeys: readonly string[];
	/**
	 * Money for one usage under this model's effective rates, or `undefined` when
	 * no override applies - the caller then keeps the money recorded at generation
	 * time, so a session without overrides keeps every figure it had before.
	 */
	attribute(model: { provider: string; id: string } | undefined, usage: Usage): SpendPriceAttribution | undefined;
	/** Whether the model has rates at all; an all-zero block (or a registry miss) has none. */
	isPriced(model: { provider: string; id: string }): boolean;
}

export interface SpendPricingOptions {
	overrides: SpendPriceOverrides;
	/** The `models.json` rates behind a model, as the registry resolves them. */
	ratesFor: (model: { provider: string; id: string }) => SpendPriceRates | undefined;
}

/**
 * Build the price book the spend surfaces share: the override wins field by
 * field, the `models.json` rate fills the rest, and a model without an override
 * is left to the money already recorded on its messages.
 */
export function createSpendPricing(options: SpendPricingOptions): SpendPricing {
	const { overrides, ratesFor } = options;
	const effectiveRates = (model: {
		provider: string;
		id: string;
	}): { rates: SpendPriceRates | undefined; overridden: boolean } => {
		const override = overrides[spendPriceKey(model)];
		const rates = ratesFor(model);
		if (!override) {
			return { rates, overridden: false };
		}
		return {
			rates: {
				input: override.input ?? rates?.input ?? 0,
				output: override.output ?? rates?.output ?? 0,
				cacheRead: override.cacheRead ?? rates?.cacheRead ?? 0,
				cacheWrite: override.cacheWrite ?? rates?.cacheWrite ?? 0,
			},
			overridden: true,
		};
	};
	return {
		hasOverrides: Object.keys(overrides).length > 0,
		overrideKeys: Object.keys(overrides),
		attribute(model, usage) {
			if (!model) {
				return undefined;
			}
			const { rates, overridden } = effectiveRates(model);
			if (!overridden || !rates) {
				return undefined;
			}
			return { cost: priceSpendTokens(usage, rates), source: "override" };
		},
		isPriced(model) {
			const { rates } = effectiveRates(model);
			if (!rates) return false;
			return rates.input > 0 || rates.output > 0 || rates.cacheRead > 0 || rates.cacheWrite > 0;
		},
	};
}

/** Money for one usage at the given rates: tokens are counted, rates are per million. */
export function priceSpendTokens(usage: Usage, rates: SpendPriceRates): number {
	return (
		(usage.input * rates.input +
			usage.output * rates.output +
			usage.cacheRead * rates.cacheRead +
			usage.cacheWrite * rates.cacheWrite) /
		1_000_000
	);
}

/** The money one tree node contributed: the corrected figure when its model is overridden. */
export function nodeSpendMoney(
	node: Pick<ContextTreeNode, "model" | "ownUsage">,
	pricing: SpendPricing | undefined,
): number {
	return pricing?.attribute(node.model, node.ownUsage)?.cost ?? node.ownUsage.cost.total;
}

/** One model's money in a tree, with the rates that priced it. */
export interface SpendPriceSourceRow {
	/** `"<provider>/<model-id>"`. */
	model: string;
	tokens: number;
	cost: number;
	source: SpendPriceSource;
}

/**
 * Every model that contributed money to a tree, with where its rates came from
 * - the answer to "which price is being used for this model, and therefore
 * where do I fix it". Models that spent nothing are left out.
 */
export function collectSpendPriceSources(root: ContextTreeNode, pricing: SpendPricing): SpendPriceSourceRow[] {
	const rows = new Map<string, SpendPriceSourceRow>();
	const walk = (node: ContextTreeNode): void => {
		if (node.model) {
			const attributed = pricing.attribute(node.model, node.ownUsage);
			const tokens = spendRelevantTokens(node.ownUsage);
			const cost = attributed?.cost ?? node.ownUsage.cost.total;
			if (tokens > 0 || cost > 0) {
				const key = spendPriceKey(node.model);
				const row = rows.get(key) ?? {
					model: key,
					tokens: 0,
					cost: 0,
					source: attributed?.source ?? "models.json",
				};
				row.tokens += tokens;
				row.cost += cost;
				rows.set(key, row);
			}
		}
		for (const child of node.children) {
			walk(child);
		}
	};
	walk(root);
	return [...rows.values()].sort((a, b) => b.cost - a.cost || (a.model < b.model ? -1 : 1));
}
