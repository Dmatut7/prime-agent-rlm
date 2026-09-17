/**
 * Spend figures for the interactive UI.
 *
 * The numeric unit is whatever unit the `cost` fields in models.json are
 * configured in (per-million-token rates as written by the user); the symbol is
 * presentation only and converts nothing. Keep every money figure in the TUI
 * behind this one formatter so the currency is defined once.
 */
export const SPEND_CURRENCY_SYMBOL = "¥";

/** Fixed two-decimal spend amount, e.g. `¥4.56`. */
export function formatSpendCost(cost: number): string {
	return `${SPEND_CURRENCY_SYMBOL}${cost.toFixed(2)}`;
}
