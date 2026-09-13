/**
 * Provider-measured input limits.
 *
 * A catalog entry's `contextWindow` is what a provider advertises for a whole
 * conversation. Several providers reject a request once the INPUT alone passes a
 * lower figure, and they reject the call wholesale (HTTP 400) instead of
 * truncating: Bailian's DashScope compatible-mode answers an oversized prompt
 * with `Range of input length should be [1, 983616]` for a model whose catalog
 * entry declares `contextWindow: 1000000`. Budgeting a request from the declared
 * window alone therefore spends tokens the provider never accepted.
 *
 * Rules for this table:
 * - Only record a limit that was actually observed or documented. `evidence` must
 *   stay verifiable; an unmeasured model is absent from the table, never guessed.
 * - A declared `contextWindow` above the measured input limit is a catalog bug.
 *   `effectiveInputLimitTokens` clamps it so request budgeting stays correct, and
 *   `catalogOverDeclaration` reports the mismatch so the catalog can be fixed.
 */

export interface MeasuredInputLimit {
	provider: string;
	model: string;
	/** Largest input the provider accepts, in the provider's own token caliber. */
	maxInputTokens: number;
	/** Where the number came from, quoted closely enough to re-verify. */
	evidence: string;
	measuredAt: string;
}

export const MEASURED_PROVIDER_INPUT_LIMITS: readonly MeasuredInputLimit[] = [
	{
		provider: "bailian",
		model: "qwen3.8-max-0902",
		maxInputTokens: 983616,
		evidence:
			'DashScope compatible-mode rejection, verbatim: "400 <400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 983616]" - 52 occurrences across 4 local session transcripts between 2026-09-01 and 2026-09-13 (16 of them in session 01a07767: 14 consecutive failed threshold compactions plus a failed manual /compact), while ~/.prime/agent/models.json declares contextWindow: 1000000 (= 983616 + 16384).',
		measuredAt: "2026-09-13",
	},
];

const MEASURED_BY_KEY = new Map(
	MEASURED_PROVIDER_INPUT_LIMITS.map((entry) => [`${entry.provider}/${entry.model}`, entry]),
);

/** The measured input limit for a model, or undefined when it was never measured. */
export function measuredInputLimit(provider: string | undefined, model: string | undefined): number | undefined {
	if (!provider || !model) return undefined;
	return MEASURED_BY_KEY.get(`${provider}/${model}`)?.maxInputTokens;
}

/**
 * The input token count a provider will actually accept for a model.
 *
 * A measured limit always wins over the declaration; an unknown or non-positive
 * window yields 0, which callers treat as "unknown" rather than "unlimited".
 */
export function effectiveInputLimitTokens(
	contextWindow: number | undefined,
	provider?: string,
	model?: string,
): number {
	const declared = contextWindow && contextWindow > 0 ? contextWindow : 0;
	const measured = measuredInputLimit(provider, model);
	if (measured === undefined) return declared;
	if (declared <= 0) return measured;
	return Math.min(declared, measured);
}

/**
 * Report a catalog entry that declares more window than the provider accepts, so
 * the declaration can be corrected instead of silently clamped forever.
 */
export function catalogOverDeclaration(
	contextWindow: number | undefined,
	provider?: string,
	model?: string,
): { declared: number; measured: number } | undefined {
	const measured = measuredInputLimit(provider, model);
	const declared = contextWindow ?? 0;
	if (measured === undefined || declared <= measured) return undefined;
	return { declared, measured };
}
