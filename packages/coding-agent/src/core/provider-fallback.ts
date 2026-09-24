import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

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

/** How long a session stays on a fallback before the next turn probes the primary again. */
export const PROVIDER_FALLBACK_RETURN_AFTER_MS = 30 * 60_000;

/** Consecutive invalid tool calls from one model that count as a storm. */
export const BAD_TOOL_CALL_STORM_THRESHOLD = 3;

/** First long wait once the whole chain failed; doubles per round. */
export const PROVIDER_LONG_WAIT_BASE_MS = 5 * 60_000;
/** Ceiling of one long wait. */
export const PROVIDER_LONG_WAIT_MAX_MS = 20 * 60_000;
/**
 * The durable wake of a long wait fires this long after the in-process one, so a live
 * process always resumes first (and cancels the job); only a restart leaves it to fire.
 */
export const PROVIDER_LONG_WAIT_WAKE_GRACE_MS = 60_000;
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
	/**
	 * Switches: what moved. `session` (the default) moved the session model; `image`
	 * moved only the routed image model of one run, which the next dispatch re-decides,
	 * so a restart has no episode to rebuild from it.
	 */
	scope?: "session" | "image";
	/**
	 * Switches: `provider/model` the episode returns to. Differs from `from` when a
	 * backup-model retry had already moved the session before the chain took over.
	 */
	primary?: string;
	/** Switches: the primary's thinking level and service tier, restored on return. */
	thinkingLevel?: string;
	serviceTier?: string;
	/** Long waits: the durable wake job and its time, so a restart still resumes the task. */
	jobId?: string;
	resumeAt?: string;
}

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

/** The episode a session was in when it stopped, as the branch recorded it. */
export interface PersistedFallbackEpisode {
	/** `provider/model` to return to. */
	primary: string;
	/** `provider/model` serving when the branch ended. */
	current: string;
	/** Epoch milliseconds of the last switch: the cooldown counts from here. */
	switchedAtMs: number;
	/** Every model the episode already moved to, oldest first. */
	tried: string[];
	thinkingLevel?: string;
	serviceTier?: string;
}

type BranchEntry = { type: string; customType?: string; data?: unknown; message?: unknown };

/**
 * Rebuild the fallback episode a branch ended in, so a restart during an episode
 * still returns to the primary after the cooldown instead of staying on the backup
 * forever. The episode is live only when the branch's last fallback record is a
 * session switch and nothing changed the model after it: every switch writes its
 * model change just before the record, so a later model change is the owner's pick
 * (or a return), which ends the episode.
 */
export function readPersistedFallbackEpisode(
	entries: ReadonlyArray<BranchEntry>,
): PersistedFallbackEpisode | undefined {
	let lastSwitch = -1;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type === "model_change") return undefined;
		if (entry.type !== "custom" || entry.customType !== PROVIDER_FALLBACK_ENTRY_TYPE) continue;
		if (!isProviderFallbackEntryData(entry.data)) continue;
		if (entry.data.kind !== "switch") return undefined;
		if (entry.data.scope === "image") continue;
		lastSwitch = index;
		break;
	}
	if (lastSwitch < 0) return undefined;
	const switches: ProviderFallbackEntryData[] = [];
	// Each switch is preceded by its own model change; any other model change
	// before it started a different episode (or none).
	let ownModelChangePending = false;
	for (let index = lastSwitch; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type === "model_change") {
			if (!ownModelChangePending) break;
			ownModelChangePending = false;
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== PROVIDER_FALLBACK_ENTRY_TYPE) continue;
		if (!isProviderFallbackEntryData(entry.data)) continue;
		if (entry.data.kind !== "switch") break;
		if (entry.data.scope === "image") continue;
		switches.unshift(entry.data);
		ownModelChangePending = true;
	}
	const first = switches[0];
	const last = switches.at(-1);
	const primary = last?.primary ?? first?.from;
	if (!primary || !last?.to) return undefined;
	return {
		primary,
		current: last.to,
		switchedAtMs: last.at,
		tried: switches.flatMap((record) => (record.to ? [record.to] : [])),
		...(last.thinkingLevel ? { thinkingLevel: last.thinkingLevel } : {}),
		...(last.serviceTier ? { serviceTier: last.serviceTier } : {}),
	};
}

/**
 * The long-wait round a branch ended on, and its durable wake, so the round bound
 * survives a restart and a later success can still cancel the wake. A successful
 * answer after the last long wait ended that failure episode.
 */
export function readPersistedLongWait(entries: ReadonlyArray<BranchEntry>): { round: number; jobId?: string } {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type === "message") {
			const message = entry.message as { role?: unknown; stopReason?: unknown } | undefined;
			if (message?.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
				return { round: 0 };
			}
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== PROVIDER_FALLBACK_ENTRY_TYPE) continue;
		if (isProviderFallbackEntryData(entry.data) && entry.data.kind === "long_wait") {
			return {
				round: typeof entry.data.round === "number" ? entry.data.round : 0,
				...(typeof entry.data.jobId === "string" ? { jobId: entry.data.jobId } : {}),
			};
		}
	}
	return { round: 0 };
}

/**
 * Owner-facing notice of a fallback transition (a return to the primary, a chain
 * entry that cannot be used, an unread image, a request the provider's content
 * inspection refused). Shown in the chat and kept in the transcript for an owner
 * who comes back days later; never part of the model's context.
 */
export const PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE = "provider_fallback_notice";

/** In-context marker the durable long-wait wake delivers after a restart lost the in-process wait. */
export const PROVIDER_LONG_WAIT_RESUME_MARKER_TEXT =
	"<provider_long_wait_resumed>\n" +
	"Every model of the fallback chain was failing, so this session was waiting to try again; the process restarted during that wait, and this resume is automatic. Continue the interrupted task from where it stopped.\n" +
	"</provider_long_wait_resumed>";

/**
 * Whether a failure is the provider's content inspection refusing the request's
 * input (Bailian `data_inspection_failed`: `Input text data may contain
 * inappropriate content`). Resending the same history is refused the same way
 * forever, so it needs different bytes, not a retry. Output inspection (the
 * model's own reply was blocked) is not this: a resend can answer differently.
 */
export function isInputContentInspectionRejection(text: string | undefined): boolean {
	if (!text) return false;
	if (!/data.?inspection.?failed/i.test(text)) return false;
	return !/output data/i.test(text);
}

/** Batches of tool output a content-inspection recovery withholds before it looks elsewhere. */
export const CONTENT_INSPECTION_WITHHOLD_STEPS = 3;

/** Custom entry listing the tool results withheld from the context, so a rebuild withholds them again. */
export const PROVIDER_INSPECTION_WITHHELD_ENTRY_TYPE = "provider_inspection_withheld";

const WITHHELD_PREFIX = "[Tool output withheld:";

/** Whether a message is a tool result already replaced by the inspection placeholder. */
export function isWithheldToolResult(message: AgentMessage): boolean {
	if (message.role !== "toolResult") return false;
	const first = message.content[0];
	return first?.type === "text" && first.text.startsWith(WITHHELD_PREFIX);
}

/** A copy of a tool result with its content replaced by the inspection placeholder. */
export function withheldToolResult(message: ToolResultMessage): ToolResultMessage {
	const chars = message.content.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0);
	return { ...message, content: [{ type: "text", text: contentInspectionPlaceholder(chars) }] };
}

/**
 * What the model reads in place of a tool output the provider's inspection
 * refused. The reason comes first, so the model re-fetches narrower instead of
 * re-running the same command and tripping the filter again.
 */
export function contentInspectionPlaceholder(originalChars: number): string {
	return (
		`${WITHHELD_PREFIX} ${originalChars} characters. The model provider's content inspection rejected the request that carried this output ` +
		"(data_inspection_failed), most likely because its raw wording - security, attack or firewall terms in web pages, logs or scan output - tripped the provider's filter. " +
		"Nothing is wrong with the task itself, and the output still exists wherever it came from; only this conversation no longer carries it. " +
		"If you still need it, fetch it again in a narrower form (filter, summarize, or take a smaller slice) instead of the same raw text, which the filter would reject again.]"
	);
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
	if (isInputContentInspectionRejection(errorMessage)) return `${name}内容审核拒绝了请求`;
	if (waitClass === "permanent" && /\b40[13]\b|auth|api.?key|credential|expired/i.test(errorMessage ?? "")) {
		return `${name}密钥无效或已过期`;
	}
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

/** Whether any message in a context carries an image block. */
export function contextHasImages(messages: readonly AgentMessage[]): boolean {
	return messages.some(
		(message) =>
			"content" in message &&
			Array.isArray(message.content) &&
			message.content.some((block) => typeof block === "object" && block !== null && block.type === "image"),
	);
}

/** Model-context notice for a turn whose image went unread (see {@link createImageUnreadNotice}). */
export const PROVIDER_IMAGE_UNREAD_CUSTOM_TYPE = "provider_image_unread";

/**
 * What the session model reads when the routed image model failed and no model
 * of the chain can take image input: the turn goes on without the image, and the
 * model has to know nobody read it, or it would answer as if someone had.
 */
export function createImageUnreadNoticeText(imageModel: string, sessionModel: string, error: string): string {
	const detail = error.replace(/\s+/g, " ").trim().slice(0, 200);
	return (
		"[Image not read] Automatic session notice, not a message from the owner: " +
		`the image model that reads images for this session (${imageModel}) failed${detail ? ` (${detail})` : ""}, ` +
		`and no model in the fallback chain takes image input, so this turn continues on ${sessionModel}, which cannot see images. ` +
		"Nobody has read the image(s) in this turn. Work from the text you have and tell the owner the image went unread; " +
		"do not describe its content as if you had seen it. Once the image model recovers, attaching the image again lets a model read it."
	);
}
