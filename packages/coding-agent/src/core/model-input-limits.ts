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
	{
		provider: "bailian",
		model: "kimi-k3",
		maxInputTokens: 1000000,
		evidence:
			'DashScope compatible-mode rejection, verbatim: "400 <400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 1000000]" (2026-09-16, manual /compact on a kimi-k3@max session, boss screenshot evidence). Direct probe of the same conversation line: 986755 input tokens still returned HTTP 200, so 1000000 is the accepted bound, not a per-request artifact; ~/.prime/agent/models.json declares contextWindow: 1048576, of which the provider accepts 1000000.',
		measuredAt: "2026-09-16",
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
 * Three inputs, one minimum: the declared contextWindow, the provider's
 * measured input limit, and a config-declared serving-window cap
 * (`usageWindowTokens`). The lowest wins - the cap can tighten below the
 * measured limit, and a measured limit can tighten below the cap. An unknown
 * or non-positive declared window yields 0, which callers treat as "unknown"
 * rather than "unlimited"; an absent or non-positive cap is ignored (the
 * declared window stays the cap) rather than treated as a zero window.
 */
export function effectiveInputLimitTokens(
	contextWindow: number | undefined,
	provider?: string,
	model?: string,
	usageWindowTokens?: number,
): number {
	const declared = contextWindow && contextWindow > 0 ? contextWindow : 0;
	// A config-declared rate-quota heuristic can only tighten the declared window
	// (a value above it is a registry validation error, but the clamp here also
	// guards hand-built Model objects that bypass validation). Absent or
	// non-positive means "no declared cap" - fall back to the declared window,
	// never to 0, so an unset field cannot silently disable budgeting.
	const declaredCap =
		usageWindowTokens && usageWindowTokens > 0 ? Math.min(declared || usageWindowTokens, usageWindowTokens) : 0;
	const measured = measuredInputLimit(provider, model);
	if (measured === undefined) return declaredCap > 0 ? declaredCap : declared;
	if (declaredCap > 0) return Math.min(declaredCap, measured);
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
