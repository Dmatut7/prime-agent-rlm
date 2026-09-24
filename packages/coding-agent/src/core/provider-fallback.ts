/**
 * Unattended self-recovery across models (the fallback chain).
 *
 * The retry ladder keeps a turn alive on one model: quick retries, then a
 * bounded wait for an unavailable provider, then a quota park. An owner who
 * leaves a task running for days also needs the turn to move to another model
 * when the serving one keeps failing, and to come back once it recovers. This
 * module holds the policy constants, the storm detector, and the persisted
 * record of every switch, return and long wait (the duty log reads it).
 */

/**
 * Chain tried in order when `providerFallbackModels` is unset. Only entries the
 * registry can serve with configured auth are used, so on a machine without
 * these models the chain is simply empty.
 */
export const DEFAULT_PROVIDER_FALLBACK_MODELS: readonly string[] = [
	"bailian/glm-5.3-prime",
	"bailian/kimi-k3",
	"bailian/qwen3.8-max-0902",
];

/** How long a session stays on a fallback before the next turn probes the primary again. */
export const PROVIDER_FALLBACK_RETURN_AFTER_MS = 30 * 60_000;

/** Consecutive invalid tool calls from one model that count as a storm. */
export const BAD_TOOL_CALL_STORM_THRESHOLD = 3;

/** First long wait once the whole chain failed; doubles per round. */
export const PROVIDER_LONG_WAIT_BASE_MS = 5 * 60_000;
/** Ceiling of one long wait. */
export const PROVIDER_LONG_WAIT_MAX_MS = 20 * 60_000;
/** Long-wait rounds before the turn finally ends (about a day at the ceiling). */
export const PROVIDER_LONG_WAIT_MAX_ROUNDS = 72;

/** Delay of the given 1-based long-wait round: 5, 10, 20, 20, ... minutes by default. */
export function providerLongWaitDelayMs(
	round: number,
	baseDelayMs = PROVIDER_LONG_WAIT_BASE_MS,
	maxDelayMs = PROVIDER_LONG_WAIT_MAX_MS,
): number {
	const exponent = Math.max(0, Math.min(20, round - 1));
	return Math.min(baseDelayMs * 2 ** exponent, maxDelayMs);
}

/** Custom session entry recording one fallback-chain transition. */
export const PROVIDER_FALLBACK_ENTRY_TYPE = "provider_fallback";

export type ProviderFallbackEntryKind = "switch" | "return" | "long_wait";

export interface ProviderFallbackEntryData {
	kind: ProviderFallbackEntryKind;
	/** Epoch milliseconds of the transition. */
	at: number;
	/** `provider/model` the session left (switch, return). */
	from?: string;
	/** `provider/model` the session moved to (switch, return). */
	to?: string;
	/** Plain-words cause shown to the owner, e.g. `百炼连续 500`. */
	cause?: string;
	/** The provider's own error text for the failure that triggered it. */
	errorMessage?: string;
	/** Long waits: 1-based round and its delay. */
	round?: number;
	delayMs?: number;
}

/**
 * The duty log's shared event entry (owned by the duty-log lane; this module
 * only writes the provider-recovery kinds). Plain data, reconciled at merge.
 */
export const DUTY_EVENT_ENTRY_TYPE = "duty_event";

export type ProviderDutyEvent =
	| { kind: "provider_retry"; provider?: string; model?: string; error?: string; waitMs?: number }
	| { kind: "model_fallback"; from?: string; to: string; reason?: "provider_errors" | "bad_tool_calls" }
	| { kind: "model_restored"; to: string };

export function isProviderFallbackEntryData(value: unknown): value is ProviderFallbackEntryData {
	if (!value || typeof value !== "object") return false;
	const data = value as Record<string, unknown>;
	return (
		(data.kind === "switch" || data.kind === "return" || data.kind === "long_wait") && typeof data.at === "number"
	);
}

/** Every fallback transition recorded in a session's entries, oldest first. */
export function readProviderFallbackEntries(
	entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
): ProviderFallbackEntryData[] {
	const records: ProviderFallbackEntryData[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PROVIDER_FALLBACK_ENTRY_TYPE) continue;
		if (isProviderFallbackEntryData(entry.data)) records.push(entry.data);
	}
	return records;
}

const PROVIDER_NAMES: Record<string, string> = {
	bailian: "百炼",
	dashscope: "百炼",
	stepfun: "阶跃",
	deepseek: "DeepSeek",
	openai: "OpenAI",
	anthropic: "Anthropic",
};

function providerName(provider: string | undefined): string {
	if (!provider) return "服务";
	return PROVIDER_NAMES[provider] ?? provider;
}

/** The owner-facing cause of a provider failure: `百炼连续 500`, `百炼额度用完`. */
export function describeProviderFailureCause(
	provider: string | undefined,
	errorMessage: string | undefined,
	waitClass: "quota" | "transient" | "permanent",
): string {
	const name = providerName(provider);
	if (waitClass === "quota") return `${name}额度用完或被限流`;
	const status = /\b(5\d\d)\b/.exec(errorMessage ?? "")?.[1];
	if (status) return `${name}连续 ${status}`;
	if (/overload|throttl|rate.?limit|too many requests|429/i.test(errorMessage ?? "")) return `${name}过载限流`;
	if (/timeout|timed out|stall/i.test(errorMessage ?? "")) return `${name}响应超时`;
	return `${name}连续出错`;
}

const TOOL_NOT_FOUND_PATTERN = /^Tool (.+) not found$/;

/** The text blocks of a tool result (`{ content: [{ type: "text", text }] }`), joined. */
export function toolResultText(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			block && typeof block === "object" && (block as { type?: unknown }).type === "text"
				? String((block as { text?: unknown }).text ?? "")
				: "",
		)
		.join("\n");
}

/**
 * Whether a finished tool call was a broken call the model should not have
 * made: an unknown tool name (garbage streamed names land here) or a call to a
 * known tool with no arguments at all.
 */
export function isBadToolCall(result: { isError: boolean; text: string; args?: unknown }): boolean {
	if (!result.isError) return false;
	if (TOOL_NOT_FOUND_PATTERN.test(result.text.trim())) return true;
	return (
		result.args === undefined ||
		(typeof result.args === "object" && result.args !== null && Object.keys(result.args).length === 0)
	);
}
