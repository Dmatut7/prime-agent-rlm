/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
	HARNESS_DIGEST_CUSTOM_TYPE,
} from "../messages.js";
import { effectiveInputLimitTokens } from "../model-input-limits.js";
import type { ProviderRetryPolicy } from "../provider-retry.js";
import { buildSessionContext, type CompactionEntry, type SessionEntry } from "../session-manager.js";
import { addAssistantUsage, emptyUsage } from "../usage.js";
import { ASCII_CHARS_PER_TOKEN, measureContentDensity } from "./content-density.js";
import {
	buildFactLedger,
	type FactLedger,
	factAppendixTokenBudget,
	factLedgerFromDetails,
	parseFactAppendix,
	renderFactAppendix,
} from "./fact-appendix.js";
import { stripMachineBlocks } from "./machine-blocks.js";
import {
	announcedInputLimit,
	buildSummarizationPromptText,
	clampConversationText,
	clampSummarizationInflation,
	computeSummarizationInputBudget,
	isInputLengthRejection,
	SUMMARIZATION_INFLATION_FLOOR,
	SUMMARIZATION_INPUT_RETRY_LIMIT,
	SUMMARIZATION_INPUT_RETRY_SHRINK,
	type SummarizationNoteStyle,
	summarizationFrameText,
} from "./summarization-budget.js";
import {
	buildUserRequestLedger,
	isUserIntentMessage,
	parseUserRequests,
	renderUserRequests,
	type UserRequestLedger,
	userRequestLedgerFromDetails,
	userRequestsTokenBudget,
} from "./user-requests.js";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	extractFileOpsFromSummary,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.js";
/**
 * Details stored in CompactionEntry.details.
 *
 * Everything here is machine-derived and is the structured carry-forward for the
 * next compaction: the file lists, the fact ledger behind <fact-appendix> and the
 * ledger behind <user-requests>. Carrying them structurally is what keeps those
 * blocks byte-stable across generations; the rendered blocks in the summary text are
 * the fallback for entries whose details are missing.
 */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
	/** Fact ledger behind the rendered <fact-appendix> block. */
	facts?: FactLedger;
	/** Ledger behind the rendered <user-requests> block. */
	userRequests?: UserRequestLedger;
}

export interface SummarySlice {
	summary: string;
	usage?: Usage;
	/** Messages the input budget elided from this slice's head (budgetSummarizationInput). */
	elidedMessages?: number;
	/** Characters clampConversationText dropped from this slice's serialized conversation. */
	elidedChars?: number;
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
/** Preserve file operations recorded by prior compactions and current tool calls. */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook field kept for session file compatibility
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}
/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(
			entry.summary,
			entry.tokensBefore,
			entry.timestamp,
			entry.customInstructions,
			undefined,
			// Fork addition (upstream #2098 left this path untouched): a rebuilt head
			// that drops the snapshot would silently downgrade a digest-carrying
			// compaction entry to a digest-free one.
			entry.harnessDigest,
		);
	}
	return undefined;
}

/** A boundary-injected harness digest entry (#2098): mechanical context, never history. */
function isHarnessDigestEntry(entry: SessionEntry | undefined): boolean {
	return entry?.type === "custom_message" && entry.customType === HARNESS_DIGEST_CUSTOM_TYPE;
}

function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	// Harness digests are regenerated on the new compaction head; never summarizer input.
	if (isHarnessDigestEntry(entry)) {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
	/** What the summarization call(s) billed; persisted on the compaction entry. */
	usage?: Usage;
}
export const COMPACT_SKILL_NAME = "compact";

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	/**
	 * Share of the provider's real input limit at which threshold compaction fires.
	 * See compactionThresholdTokens for why this is a ratio of the measured limit
	 * and not `window - reserveTokens`.
	 */
	triggerRatio: number;
}

/**
 * Default trigger ratio: fire at 80% of the input limit the provider accepts.
 *
 * The old trigger was `contextWindow - reserveTokens`, i.e. ~98.4% of a 1M window.
 * Two independent measurement errors sat under it and both pushed the same way:
 * the estimate priced text at chars/4, which under-counts CJK (one recorded session
 * read 1.60x low; content-density.ts carries the table of every multiplier this fork
 * quotes), and the catalog window can exceed what the provider accepts as input (DashScope answers
 * an oversized prompt with HTTP 400 instead of truncating). Together they let a
 * session reach the provider's wall on an ordinary request before the trigger
 * ever fired, so compaction woke up after the 400 - sometimes too late to run.
 * 80% leaves room for both errors on the same context.
 */
export const DEFAULT_COMPACTION_TRIGGER_RATIO = 0.8;

/** Configurable bounds for compaction.triggerRatio. */
export const MIN_COMPACTION_TRIGGER_RATIO = 0.5;
export const MAX_COMPACTION_TRIGGER_RATIO = 0.95;

/**
 * Validate a configured trigger ratio: anything non-finite or out of
 * [MIN_COMPACTION_TRIGGER_RATIO, MAX_COMPACTION_TRIGGER_RATIO] is clamped, so a
 * typo in settings.jsonl degrades to a usable trigger instead of disabling
 * compaction (ratio <= 0) or firing it every turn (ratio >= 1).
 */
export function clampCompactionTriggerRatio(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_COMPACTION_TRIGGER_RATIO;
	return Math.min(MAX_COMPACTION_TRIGGER_RATIO, Math.max(MIN_COMPACTION_TRIGGER_RATIO, value));
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	triggerRatio: DEFAULT_COMPACTION_TRIGGER_RATIO,
};

/** Failed compactions in a row before the failure notice carries recovery options. */
export const COMPACTION_RECOVERY_HINT_THRESHOLD = 3;

/**
 * Recovery options for a session whose compaction keeps failing.
 *
 * A context above the compaction threshold whose compaction cannot run does not
 * recover by itself: every later turn re-triggers the same failing call, so the
 * notice has to say what the user can do instead of repeating the provider error.
 */
export function buildCompactionRecoveryHint(consecutiveFailures: number): string {
	return [
		"",
		`Compaction has now failed ${consecutiveFailures} times in a row. The context stays above the compaction threshold, so it will not shrink on its own - pick one:`,
		"1. /compact <instructions> - retry now; instructions narrow what the summary has to carry.",
		"2. /tree, or /fork from an earlier user message - continue from a smaller context and leave the oversized tail behind.",
		"3. /model - switch to a model with a larger context window or a different provider, then compact again.",
		"4. /new - start a fresh session; /export first if you need this transcript.",
		"If the error mentions the input length, the summarization request itself is over the provider's input limit: lowering compaction.reserveTokens in settings widens that request's budget, at the cost of summary length rather than context.",
	].join("\n");
}
/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 *
 * Includes output: the assistant's response becomes part of the prompt on the next
 * request, so it counts toward the context the next turn will send.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Whether a message can serve as the context-usage source.
 *
 * One predicate for both calibers on purpose: `estimateContextTokens` (the
 * compaction trigger) and `AgentSession.getContextUsage` (/usage, /context,
 * compact.status) must agree on which assistant usage is readable, or one reports
 * a number while the other reports "unknown". Aborted and errored turns carry no
 * usable usage; a provider that reports zeros is still a source, so the estimate
 * then counts only the messages that follow it.
 */
export function isAssistantUsageSource(message: AgentMessage): message is AssistantMessage {
	return (
		message.role === "assistant" &&
		message.stopReason !== "aborted" &&
		message.stopReason !== "error" &&
		Boolean(message.usage)
	);
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	return isAssistantUsageSource(msg) ? msg.usage : undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 *
 * The anchored part is the provider's own count, so it needs no correction; the
 * messages after it (or every message, when no assistant has reported usage yet)
 * are priced by content density, because this number is compared against a
 * provider-measured limit. See estimateTokensByContent.
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokensByContent(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokensByContent(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * Model identity for the trigger base: a catalog `contextWindow` can be larger
 * than the input the provider actually accepts, and only the measured table in
 * model-input-limits.ts knows that. Both fields optional because callers that
 * have no model (a pure-function test, a settings preview) still get the declared
 * window.
 */
export interface CompactionWindowLimits {
	provider?: string;
	modelId?: string;
}

/**
 * The token count the compaction trigger is a ratio of: the declared window
 * clamped to the provider's measured input limit.
 */
export function compactionTriggerBaseTokens(contextWindow: number, limits?: CompactionWindowLimits): number {
	return effectiveInputLimitTokens(contextWindow, limits?.provider, limits?.modelId);
}

/**
 * Context token count at which threshold compaction fires.
 *
 * Two ceilings, the lower one wins:
 * - `base * triggerRatio` (base = the provider's real input limit) buys headroom
 *   for the two measurement errors that both push the same way: the estimator's
 *   chars/4 caliber under-counts dense (CJK/code) text, and a catalog window can
 *   over-declare what the provider accepts as input. A session that triggers at
 *   ~98% of an over-declared window reaches the provider's 400 first.
 * - `base - reserveTokens` keeps the old invariant: the retained slice plus the
 *   response reserve has to fit, or compaction re-fires every turn.
 *
 * When the configured reserve consumes the whole base (or more), no sustainable
 * threshold exists: any retained context, including a fresh summary, would sit
 * above it again immediately and retrigger every turn. Threshold compaction is
 * then disabled; overflow recovery remains the backstop.
 */
export function compactionThresholdTokens(
	contextWindow: number,
	settings: CompactionSettings,
	limits?: CompactionWindowLimits,
): number {
	const base = compactionTriggerBaseTokens(contextWindow, limits);
	if (base <= 0) return 0;
	const reserveCeiling = base - settings.reserveTokens;
	if (reserveCeiling <= 0) return 0;
	return Math.floor(Math.min(base * clampCompactionTriggerRatio(settings.triggerRatio), reserveCeiling));
}

/**
 * Check if compaction should trigger based on context usage.
 *
 * The single trigger predicate: the threshold-compaction hook, the agent_end
 * check and the admission gate all call this, so one context cannot be over the
 * threshold for one of them and under it for another.
 */
export function shouldCompact(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
	limits?: CompactionWindowLimits,
): boolean {
	if (!settings.enabled) return false;
	if (contextWindow <= 0) return false;
	const threshold = compactionThresholdTokens(contextWindow, settings, limits);
	if (threshold <= 0) return false;
	return contextTokens > threshold;
}

/**
 * Cap keepRecentTokens so the retained slice can fit under the trigger threshold.
 * An uncapped keepRecent above the threshold makes every compaction re-trigger on
 * the very next turn, because the retained context already exceeds the threshold
 * by construction.
 */
export function capKeepRecentTokens(
	settings: CompactionSettings,
	contextWindow?: number,
	limits?: CompactionWindowLimits,
): number {
	if (!contextWindow || contextWindow <= 0) return settings.keepRecentTokens;
	const threshold = compactionThresholdTokens(contextWindow, settings, limits);
	if (threshold <= 0) return 0;
	return Math.min(settings.keepRecentTokens, threshold);
}
/**
 * The text a message contributes to a prompt, as separate runs, plus how many
 * images it carries. One collector for both token calibers below, so the two can
 * never disagree about *which* characters count - only about what a character
 * costs. A run boundary costs nothing: the calibers sum run lengths, and images
 * are priced as a flat token count rather than as characters.
 */
export interface MessageEstimateParts {
	texts: string[];
	images: number;
}

/** Flat token cost of one image, in both calibers (the old 4800 chars / 4). */
export const IMAGE_TOKEN_ESTIMATE = 1200;

function pushContentBlocks(parts: MessageEstimateParts, content: unknown): void {
	if (typeof content === "string") {
		parts.texts.push(content);
		return;
	}
	if (!Array.isArray(content)) return;
	for (const block of content as Array<{ type: string; text?: string; thinking?: string }>) {
		if (block.type === "text" && block.text) parts.texts.push(block.text);
		else if (block.type === "image") parts.images += 1;
	}
}

function collectMessageEstimateParts(message: AgentMessage): MessageEstimateParts {
	const parts: MessageEstimateParts = { texts: [], images: 0 };
	switch (message.role) {
		case "user":
			pushContentBlocks(parts, (message as { content: unknown }).content);
			break;
		case "assistant": {
			for (const block of (message as AssistantMessage).content) {
				if (block.type === "text") parts.texts.push(block.text);
				else if (block.type === "thinking") parts.texts.push(block.thinking);
				else if (block.type === "toolCall") {
					parts.texts.push(block.name, JSON.stringify(block.arguments));
				}
			}
			break;
		}
		case "custom":
		case "toolResult":
			pushContentBlocks(parts, message.content);
			break;
		case "bashExecution":
			parts.texts.push(message.command, message.output);
			break;
		case "branchSummary":
		case "compactionSummary":
			parts.texts.push(message.summary);
			break;
	}
	return parts;
}

/**
 * Estimate token count for a message with the flat chars/4 heuristic.
 *
 * It is no longer the caliber of the retained slice: cut points, keepRecentTokens,
 * the trigger and the emergency shrink are all priced by estimateTokensByContent,
 * so a nominal token means an estimated real token everywhere the compaction
 * decides how much context to keep. This flat caliber survives only where the
 * provider's own count already anchors the number - budgetSummarizationInput trims
 * the summarization request in it and summarizationInflation converts that budget
 * back with a measured provider ratio - so the two corrections cannot
 * double-count. See content-density.ts for the ratio table and its sources.
 */
export function estimateTokens(message: AgentMessage): number {
	const parts = collectMessageEstimateParts(message);
	let chars = parts.images * IMAGE_TOKEN_ESTIMATE * ASCII_CHARS_PER_TOKEN;
	for (const text of parts.texts) chars += text.length;
	return Math.ceil(chars / ASCII_CHARS_PER_TOKEN);
}

/**
 * The content a price was computed from, in numbers cheap enough to re-read on every
 * call: how many blocks the message has, how many characters those blocks hold, how
 * many images, and a hash of the tool-call arguments.
 */
interface ContentFootprint {
	blocks: number;
	chars: number;
	images: number;
	argsHash: number;
	/** Sampled character codes, so a rewrite that keeps every length still shows. */
	sample: number;
}

interface PricedContent extends ContentFootprint {
	tokens: number;
}

/**
 * Prices already computed, per message object.
 *
 * The trigger reads the whole context at every turn boundary - three sites, and five
 * full reads when the tail has to be repriced - and with no provider usage anchor
 * each read prices every character of every message (measured: 50MB branch, one read
 * p50 468ms / max 1180ms, a turn boundary p50 1342ms, all of it synchronous;
 * perfC EVIDENCE/compaction/trigger-idle.json). A transcript grows by appending, so
 * almost all of that work is repricing messages that were priced a moment ago and
 * have not changed. The memo keeps the price on the message object it was computed
 * from and re-reads it when the object still holds the same content, which turns a
 * repeated full read into one cheap footprint pass per message.
 *
 * A WeakMap, so a price lives exactly as long as the message it belongs to: a
 * compaction that drops the head of a transcript drops its prices with it.
 */
const pricedContent = new WeakMap<AgentMessage, PricedContent>();

/** Identity of each tool-call arguments object, so a footprint can tell two apart without serializing them. */
const argumentObjectIds = new WeakMap<object, number>();
let argumentObjectCount = 0;

/**
 * Fold eight character codes of one priced text into the footprint sample.
 *
 * Length alone would let a rewrite that keeps the length pass as unchanged, so the
 * first and last code unit and six spread through the interior are read as well. It
 * is a sample, not a hash of the text: reading every character is the walk this memo
 * exists to avoid. The shape it cannot see is a rewrite confined to the unsampled
 * positions of one block that also keeps its length - and the writers in the tree do
 * not produce it: the stream replaces a tool call's `arguments` with a fresh object,
 * the daemon's compact stream appends to `text`, the queue replaces a whole `content`
 * array, and the failure-receipt path appends to a string. Eight reads per text cost
 * a fraction of a millisecond on a 20k-message transcript, which is the whole point.
 */
function mixTextSample(hash: number, text: string): number {
	const last = text.length - 1;
	if (last < 0) return (hash * 31 + 1) >>> 0;
	let mixed = (hash * 31 + text.charCodeAt(0) + text.charCodeAt(last)) >>> 0;
	for (let step = 1; step <= 6; step++) {
		mixed = (mixed * 31 + text.charCodeAt(Math.floor((last * step) / 7))) >>> 0;
	}
	return mixed;
}

/**
 * Fold one tool call's arguments into a footprint hash.
 *
 * Serializing them is what the price itself does and is a large part of what the memo
 * saves, so the hash reads the object's identity plus a one-level probe of its keys
 * instead. That covers both shapes a tool call changes by: the stream replaces
 * `block.arguments` with a freshly parsed object (new identity), and a writer that
 * puts a value into the existing object changes a key set or a value length. It does
 * not cover a value rewritten in place to another value of the same length and type;
 * seeing that would cost the serialization the hash exists to avoid.
 */
function mixArguments(hash: number, args: unknown): number {
	if (!args || typeof args !== "object") {
		return (hash * 31 + (args === undefined ? 1 : 2)) >>> 0;
	}
	let id = argumentObjectIds.get(args);
	if (id === undefined) {
		argumentObjectCount += 1;
		id = argumentObjectCount;
		argumentObjectIds.set(args, id);
	}
	let mixed = (hash * 31 + id) >>> 0;
	const record = args as Record<string, unknown>;
	// Every key is probed, so the footprint is O(keys) - which for every tool call in
	// this tree is a handful, and in general is bounded by the serialization the price
	// itself pays for the same object. A cap would trade that for a blind spot past the
	// cap, and the shape that actually changes arguments (the stream replacing the
	// object wholesale) is caught by identity, not by the probe.
	for (const key in record) {
		if (!Object.hasOwn(record, key)) continue;
		const value = record[key];
		if (typeof value === "string") {
			mixed = mixTextSample((mixed * 31 + key.length + value.length) >>> 0, value);
			continue;
		}
		const probe = typeof value === "number" ? Math.trunc(value) : typeof value === "boolean" ? 1 : 0;
		mixed = (mixed * 31 + key.length + probe) >>> 0;
	}
	return mixed;
}

/**
 * What collectMessageEstimateParts would price, counted without building the strings.
 *
 * The two have to stay in step: a character this misses is a character a stale price
 * can keep, so every shape collectMessageEstimateParts reads appears here, and
 * test/compaction-price-memo.test.ts pins the pairing per message shape. Block count
 * and character count are O(1) reads, so the whole footprint costs one pass over the
 * block list and no allocation.
 */
function messageContentFootprint(message: AgentMessage): ContentFootprint {
	let blocks = 0;
	let chars = 0;
	let images = 0;
	let argsHash = 0;
	let sample = 7;
	const addText = (text: string): void => {
		chars += text.length;
		sample = mixTextSample(sample, text);
	};
	const addContent = (content: unknown): void => {
		if (typeof content === "string") {
			blocks += 1;
			addText(content);
			return;
		}
		if (!Array.isArray(content)) return;
		for (const block of content as Array<{ type: string; text?: string }>) {
			blocks += 1;
			if (block.type === "text" && block.text) addText(block.text);
			else if (block.type === "image") images += 1;
		}
	};
	switch (message.role) {
		case "user":
			addContent((message as { content: unknown }).content);
			break;
		case "assistant":
			for (const block of (message as AssistantMessage).content) {
				blocks += 1;
				if (block.type === "text") addText(block.text);
				else if (block.type === "thinking") addText(block.thinking);
				else if (block.type === "toolCall") {
					addText(block.name);
					argsHash = mixArguments(argsHash, block.arguments);
				}
			}
			break;
		case "custom":
		case "toolResult":
			addContent(message.content);
			break;
		case "bashExecution":
			blocks += 2;
			addText(message.command);
			addText(message.output);
			break;
		case "branchSummary":
		case "compactionSummary":
			blocks += 1;
			addText(message.summary);
			break;
	}
	return { blocks, chars, images, argsHash, sample };
}

function sameFootprint(a: ContentFootprint, b: ContentFootprint): boolean {
	return (
		a.blocks === b.blocks &&
		a.chars === b.chars &&
		a.images === b.images &&
		a.argsHash === b.argsHash &&
		a.sample === b.sample
	);
}

/**
 * Estimate token count for a message priced by content density: CJK and fenced
 * code cost what they actually cost a tokenizer instead of the flat chars/4.
 *
 * This is the caliber of everything that decides how much context is retained or
 * reported: the trigger and /usage (both compared against a number the provider
 * measured), the cut point, keepRecentTokens and the emergency shrink. A
 * Chinese-heavy session estimated at chars/4 read 1.60x low, so the trigger fired
 * after the provider had already rejected the request; the table in
 * content-density.ts lists every multiplier this correction may produce and where
 * each reading comes from.
 */
export function estimateTokensByContent(message: AgentMessage): number {
	const footprint = messageContentFootprint(message);
	const priced = pricedContent.get(message);
	if (priced && sameFootprint(priced, footprint)) return priced.tokens;
	const parts = collectMessageEstimateParts(message);
	let tokens = parts.images * IMAGE_TOKEN_ESTIMATE;
	for (const text of parts.texts) tokens += measureContentDensity(text).tokens;
	const total = Math.ceil(tokens);
	pricedContent.set(message, { ...footprint, tokens: total });
	return total;
}

/**
 * Find valid cut points: indices of user, assistant, custom, or bashExecution messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 * BashExecutionMessage is treated like a user message (user-initiated context).
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
			case "session_info":
				break;
		}
		// Branch summaries and custom messages are user-role turn boundaries.
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the user message (or bashExecution) that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 * BashExecutionMessage is treated like a user message for turn boundaries.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

/**
 * Whether an entry begins a turn, so the retained region can start here without
 * splitting anything: a user message, a user-initiated bash execution, or one of the
 * entry types that stand in for a user turn (branch summary, custom message).
 */
export function isTurnStartEntry(entry: SessionEntry): boolean {
	if (entry.type === "branch_summary" || entry.type === "custom_message") return true;
	if (entry.type !== "message") return false;
	return entry.message.role === "user" || entry.message.role === "bashExecution";
}

/**
 * Estimated tokens of the message entries in [fromIndex, toIndex), priced by
 * content density: this is the caliber every keepRecentTokens comparison is made
 * in, so the alignment slack below is real tokens and not chars/4 tokens.
 */
function estimateEntryRangeTokens(entries: SessionEntry[], fromIndex: number, toIndex: number): number {
	let total = 0;
	for (let i = fromIndex; i < toIndex; i++) {
		const entry = entries[i];
		if (entry.type === "message") total += estimateTokensByContent(entry.message);
	}
	return total;
}

/**
 * How much more than keepRecentTokens a turn-aligned cut may retain, as a share of
 * keepRecentTokens. 1 allows the aligned cut to keep up to twice the budget.
 */
export const TURN_ALIGNMENT_EXTRA_SHARE = 1;

/**
 * Move a mid-turn cut back to the start of its turn, when that is affordable.
 *
 * A cut in the middle of a turn retains recent bytes but summarizes the message that
 * started the turn, so the retained work loses its own request: all three sessions
 * measured for the fidelity audit were cut this way. Moving the cut back keeps the
 * turn whole - "what am I doing" stays verbatim - and costs one prefix summary fewer.
 *
 * The move is bounded because a turn can be arbitrarily large. When retaining the
 * whole turn would cost more than keepRecentTokens on top of the cut that was
 * chosen, the mid-turn cut stands and the split-turn prefix summary still covers it:
 * a compaction that keeps everything and summarizes nothing re-fires every turn.
 * Aligning to `startIndex` is refused for the same reason.
 */
export function alignCutToTurnStart(
	entries: SessionEntry[],
	cutIndex: number,
	startIndex: number,
	keepRecentTokens: number,
	extraShare: number = TURN_ALIGNMENT_EXTRA_SHARE,
): number {
	if (cutIndex <= startIndex) return cutIndex;
	const cutEntry = entries[cutIndex];
	if (!cutEntry || isTurnStartEntry(cutEntry)) return cutIndex;
	const turnStart = findTurnStartIndex(entries, cutIndex, startIndex);
	if (turnStart <= startIndex) return cutIndex;
	const extra = estimateEntryRangeTokens(entries, turnStart, cutIndex);
	if (extra > keepRecentTokens * extraShare) return cutIndex;
	return turnStart;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * The accumulation is priced by content density (estimateTokensByContent), the same
 * caliber as the trigger and the emergency shrink: a Chinese- or code-heavy turn
 * costs what the provider charges for it, so the retained slice lands on the
 * configured budget instead of on a chars/4 reading that could be 2.7x low.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const messageTokens = estimateTokensByContent(entry.message);
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			let nearestCut: number | undefined;
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					nearestCut = cutPoints[c];
					break;
				}
			}
			// The budget can be crossed at an entry with no cut point at or after it
			// (typically one huge trailing tool result). Cutting at the first cut
			// point then keeps everything and summarizes nothing, so the threshold
			// re-fires every turn. Cut at the closest valid point before it instead:
			// its tool results still follow, and everything older gets summarized.
			cutIndex = nearestCut ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			break;
		}
		cutIndex--;
	}
	// Prefer a cut that starts a turn: the retained region then carries the request it
	// is answering instead of a lossy summary of it. Bounded, so an oversized turn
	// still takes the split-turn path.
	cutIndex = alignCutToTurnStart(entries, cutIndex, startIndex, keepRecentTokens);
	const isTurnStart = isTurnStartEntry(entries[cutIndex]);
	// A cut inside a turn requires a prefix summary; a cut at a turn start does not.
	const turnStartIndex = isTurnStart ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isTurnStart && turnStartIndex !== -1,
	};
}
/**
 * How far under the trigger threshold the emergency shrink has to land, so the
 * session does not re-trigger on the very next message.
 */
export const EMERGENCY_SHRINK_TARGET_RATIO = 0.7;

/**
 * Consecutive compaction failures from which the retry halves keepRecentTokens: 1,
 * so the second attempt - the first retry - already carries a smaller tail.
 */
export const COMPACTION_KEEP_RECENT_SHRINK_START = 1;

/** Floor for a halved keepRecentTokens budget. */
export const MIN_SHRUNK_KEEP_RECENT_TOKENS = 4096;

/** Consecutive compaction failures at which the lossy emergency shrink runs. */
export const COMPACTION_EMERGENCY_SHRINK_FAILURES = 4;

/**
 * keepRecentTokens for a retry after `consecutiveFailures` failed compactions.
 *
 * A summarization request that keeps failing is often failing because the slice it
 * has to carry is too big for the provider's input limit; halving the retained
 * tail from the second failure on gives each retry a smaller request without
 * touching the user's configured budget. The floor keeps the retained slice usable,
 * and the result never exceeds the configured value - a session configured below
 * the floor keeps its own number instead of being raised to it.
 */
export function shrunkKeepRecentTokens(configured: number, consecutiveFailures: number): number {
	if (consecutiveFailures < COMPACTION_KEEP_RECENT_SHRINK_START) return configured;
	const halvings = consecutiveFailures - COMPACTION_KEEP_RECENT_SHRINK_START + 1;
	let value = configured;
	for (let i = 0; i < halvings; i++) value = Math.floor(value / 2);
	return Math.max(Math.min(configured, value), Math.min(MIN_SHRUNK_KEEP_RECENT_TOKENS, configured));
}

/** What the emergency shrink counted in the span it drops. */
export interface EmergencyShrinkSpan {
	/** Non-summary context entries replaced by the notice. */
	droppedEntries: number;
	/** Estimated tokens those entries carried. */
	droppedTokens: number;
	/** Roles of the dropped entries, so the notice can name what was lost. */
	droppedRoles: Record<string, number>;
	/** Timestamps of the oldest and newest dropped entry, when they have one. */
	firstDroppedTimestamp?: string;
	lastDroppedTimestamp?: string;
}

export interface EmergencyShrinkPlan {
	/** Entry the shrunken context starts at; everything older becomes the notice. */
	firstKeptEntryId: string;
	/** Index of that entry in the branch handed to the planner. */
	firstKeptEntryIndex: number;
	/** Estimated tokens of the context before the shrink, in the planner's own caliber. */
	tokensBefore: number;
	/** Estimated tokens of the context the plan produces, notice text excluded. */
	tokensAfter: number;
	/** The target the plan aimed at: thresholdTokens * EMERGENCY_SHRINK_TARGET_RATIO. */
	targetTokens: number;
	/** False when even the deepest cut cannot reach the target; the notice must say so. */
	reachedTarget: boolean;
	span: EmergencyShrinkSpan;
	/**
	 * Summary text carried forward from the dropped span (the previous compaction
	 * summary, branch summaries). A shrink drops non-summary context; summaries move
	 * into the notice instead of being lost.
	 */
	carriedSummaries: Array<{ kind: "compaction" | "branch"; text: string }>;
}

/** Whether an entry is one of the summary-carrying kinds the shrink refuses to drop. */
function isSummaryEntry(entry: SessionEntry): boolean {
	if (entry.type === "compaction" || entry.type === "branch_summary") return true;
	if (entry.type !== "message") return false;
	return entry.message.role === "compactionSummary" || entry.message.role === "branchSummary";
}

function entrySummaryText(entry: SessionEntry): string {
	if (entry.type === "compaction" || entry.type === "branch_summary") return entry.summary ?? "";
	if (entry.type !== "message") return "";
	const message = entry.message;
	return message.role === "compactionSummary" || message.role === "branchSummary" ? message.summary : "";
}

function entryContextTokens(entry: SessionEntry): number {
	const message = getMessageFromEntry(entry);
	return message ? estimateTokensByContent(message) : 0;
}

interface ShrinkAttempt {
	cut: number;
	tokensAfter: number;
	span: EmergencyShrinkSpan;
	carriedSummaries: Array<{ kind: "compaction" | "branch"; text: string }>;
}

function measureShrinkAttempt(pathEntries: SessionEntry[], spanStart: number, cut: number): ShrinkAttempt {
	const carriedSummaries: Array<{ kind: "compaction" | "branch"; text: string }> = [];
	let carriedTokens = 0;
	let droppedEntries = 0;
	let droppedTokens = 0;
	const droppedRoles: Record<string, number> = {};
	let firstDroppedTimestamp: string | undefined;
	let lastDroppedTimestamp: string | undefined;
	let suffixTokens = 0;
	for (let i = spanStart; i < pathEntries.length; i++) {
		const entry = pathEntries[i];
		if (i >= cut) {
			suffixTokens += entryContextTokens(entry);
			continue;
		}
		if (isSummaryEntry(entry)) {
			const text = entrySummaryText(entry);
			if (!text) continue;
			carriedSummaries.push({ kind: summaryEntryKind(entry), text });
			carriedTokens += entryContextTokens(entry);
			continue;
		}
		const message = getMessageFromEntry(entry);
		if (!message) continue;
		const tokens = estimateTokensByContent(message);
		droppedEntries += 1;
		droppedTokens += tokens;
		const role = entry.type === "message" ? entry.message.role : entry.type;
		droppedRoles[role] = (droppedRoles[role] ?? 0) + 1;
		firstDroppedTimestamp ??= entry.timestamp;
		lastDroppedTimestamp = entry.timestamp;
	}
	return {
		cut,
		tokensAfter: carriedTokens + suffixTokens,
		span: { droppedEntries, droppedTokens, droppedRoles, firstDroppedTimestamp, lastDroppedTimestamp },
		carriedSummaries,
	};
}

/**
 * The two running totals the cut search reads, so the span is priced once.
 *
 * measureShrinkAttempt walks spanStart..end for one cut; the search used to call it
 * for every candidate, which is O(cutPoints x entries) content-density scans and
 * fully synchronous - measured 27.5s at 2025 entries and 54.8s at 3200 on a real
 * threshold, i.e. the event loop froze for the whole walk at exactly the moment the
 * context was largest (perfC, EVIDENCE/compaction/shrink-idle.txt). Both halves of
 * `tokensAfter` are running sums over the same per-entry prices, so one pricing pass
 * plus two folds makes the search O(entries), and the chosen cut stays the only one
 * that pays a full walk for the span details the plan reports.
 */
interface ShrinkSpanTotals {
	/** suffixTokens[i]: price of entries i..end, the context a cut at i keeps. */
	suffixTokens: Float64Array;
	/** carriedTokens[i]: price of the summary entries in spanStart..i that a cut after i carries forward. */
	carriedTokens: Float64Array;
}

/**
 * Price every entry of the span once and fold both running totals.
 *
 * Each price is an integer (estimateTokensByContent ends in Math.ceil), so the folds
 * are exact and a cut reads the same total the per-cut walk produced whichever order
 * its two halves were summed in - that is what makes the search equivalent rather
 * than merely close.
 */
function measureShrinkSpanTotals(pathEntries: SessionEntry[], spanStart: number): ShrinkSpanTotals {
	const count = pathEntries.length;
	const entryTokens = new Float64Array(count);
	// One slot past the end so the fold at the last entry reads a zero.
	const suffixTokens = new Float64Array(count + 1);
	const carriedTokens = new Float64Array(count);
	let carried = 0;
	for (let i = spanStart; i < count; i++) {
		const entry = pathEntries[i];
		const tokens = entryContextTokens(entry);
		entryTokens[i] = tokens;
		// The condition measureShrinkAttempt carries a summary under: an empty
		// summary text has nothing to carry forward, so it does not add to the total.
		if (isSummaryEntry(entry) && entrySummaryText(entry)) carried += tokens;
		carriedTokens[i] = carried;
	}
	for (let i = count - 1; i >= spanStart; i--) {
		suffixTokens[i] = suffixTokens[i + 1] + entryTokens[i];
	}
	return { suffixTokens, carriedTokens };
}

/** What a cut leaves behind, read off the folded totals instead of a span walk. */
function shrinkTokensAfter(totals: ShrinkSpanTotals, spanStart: number, cut: number): number {
	const carried = cut > spanStart ? totals.carriedTokens[cut - 1] : 0;
	return totals.suffixTokens[cut] + carried;
}

function summaryEntryKind(entry: SessionEntry): "compaction" | "branch" {
	if (entry.type === "compaction") return "compaction";
	if (entry.type === "message" && entry.message.role === "compactionSummary") return "compaction";
	return "branch";
}

/**
 * Plan a lossy emergency shrink: the last resort when compaction keeps failing
 * while the context sits above the trigger threshold, so every further request is
 * headed for the provider's input wall.
 *
 * It drops the oldest NON-summary context entries until the estimate lands under
 * `thresholdTokens * EMERGENCY_SHRINK_TARGET_RATIO`, carrying any summary inside
 * the dropped span forward instead of losing it. The cut is always a valid cut
 * point, so no tool result is separated from the tool call it answers - a provider
 * rejects that pair outright, which would turn the shrink into a new failure.
 *
 * Both token figures are pure content-density sums over the same entries, so the
 * comparison is self-consistent; they are not the usage-anchored caliber
 * estimateContextTokens reports while a readable assistant usage exists.
 *
 * The search is linear in the span: every entry is priced once, each candidate cut
 * reads a folded total, and only the chosen cut walks the span again for the details
 * the notice reports. It has to be - this valve runs on the largest context the
 * session ever reaches, synchronously, with the event loop frozen for its duration.
 *
 * Returns undefined when there is nothing to do: no threshold, already under the
 * target, or no cut point to move to.
 */
export function planEmergencyShrink(
	pathEntries: SessionEntry[],
	thresholdTokens: number,
	targetRatio: number = EMERGENCY_SHRINK_TARGET_RATIO,
): EmergencyShrinkPlan | undefined {
	if (thresholdTokens <= 0 || pathEntries.length === 0) return undefined;
	const targetTokens = Math.floor(thresholdTokens * targetRatio);

	let lastCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			lastCompactionIndex = i;
			break;
		}
	}
	// The context a new compaction entry would replace starts at the newest
	// boundary's retained entry (or at the head of the branch when there is none);
	// the cut itself stays after the boundary, because entries before it are already
	// represented by that boundary's summary.
	let spanStart = 0;
	let cutStart = 0;
	if (lastCompactionIndex >= 0) {
		const boundary = pathEntries[lastCompactionIndex] as CompactionEntry;
		const keptIndex = pathEntries.findIndex((entry) => entry.id === boundary.firstKeptEntryId);
		spanStart = keptIndex >= 0 ? keptIndex : lastCompactionIndex;
		cutStart = lastCompactionIndex + 1;
	}
	const cutPoints = findValidCutPoints(pathEntries, cutStart, pathEntries.length).filter((index) => index > spanStart);
	if (cutPoints.length === 0) return undefined;

	const totals = measureShrinkSpanTotals(pathEntries, spanStart);
	const tokensBefore = shrinkTokensAfter(totals, spanStart, spanStart);
	if (tokensBefore <= targetTokens) return undefined;

	// The deepest cut is the fallback, which is what the per-cut walk this replaced
	// ended up holding: it kept the last candidate it measured.
	let cut = cutPoints[cutPoints.length - 1];
	let reachedTarget = false;
	for (const candidate of cutPoints) {
		if (shrinkTokensAfter(totals, spanStart, candidate) <= targetTokens) {
			cut = candidate;
			reachedTarget = true;
			break;
		}
	}
	// Only the chosen cut pays a span walk, for the dropped-span details (roles,
	// timestamps, carried summaries) the plan and its notice report.
	const attempt = measureShrinkAttempt(pathEntries, spanStart, cut);
	return toPlan(pathEntries, attempt, tokensBefore, targetTokens, reachedTarget);
}

function toPlan(
	pathEntries: SessionEntry[],
	attempt: ShrinkAttempt,
	tokensBefore: number,
	targetTokens: number,
	reachedTarget: boolean,
): EmergencyShrinkPlan {
	const entry = pathEntries[attempt.cut];
	return {
		firstKeptEntryId: entry.id,
		firstKeptEntryIndex: attempt.cut,
		tokensBefore,
		tokensAfter: attempt.tokensAfter,
		targetTokens,
		reachedTarget,
		span: attempt.span,
		carriedSummaries: attempt.carriedSummaries,
	};
}

/**
 * The loud notice that replaces the dropped span.
 *
 * It is the summary of a real compaction entry, so it is what the model reads next
 * turn; it names the loss first, in caps, and states where the dropped text still
 * exists. A silent shrink here would leave the user believing the session simply
 * forgot, with no way to tell a bug from the valve.
 */
export function buildEmergencyShrinkSummary(
	plan: EmergencyShrinkPlan,
	context: { consecutiveFailures: number; lastError?: string; thresholdTokens: number },
): string {
	const roles = Object.entries(plan.span.droppedRoles)
		.sort((a, b) => b[1] - a[1])
		.map(([role, count]) => `${role} ${count}`)
		.join(", ");
	const spanned =
		plan.span.firstDroppedTimestamp && plan.span.lastDroppedTimestamp
			? `, spanning ${plan.span.firstDroppedTimestamp} .. ${plan.span.lastDroppedTimestamp}`
			: "";
	const lines = [
		"EMERGENCY CONTEXT SHRINK - OLDEST MESSAGES WERE DROPPED WITHOUT BEING SUMMARIZED.",
		"",
		`Compaction failed ${context.consecutiveFailures} times in a row${
			context.lastError ? ` (last error: ${context.lastError})` : ""
		}, and the context stayed above the compaction threshold (${plan.tokensBefore} estimated tokens vs a ${context.thresholdTokens} threshold). Rather than keep sending requests the provider rejects, the valve dropped the oldest ${plan.span.droppedEntries} context entries (~${plan.span.droppedTokens} tokens${roles ? `: ${roles}` : ""}${spanned}) from what the model sees.`,
		"They are NOT deleted: the session transcript on disk still holds every one of them, and /export, /tree and /fork can still reach them.",
	];
	if (!plan.reachedTarget) {
		lines.push(
			"",
			`The shrink could not reach its ${plan.targetTokens} token target: even the deepest cut leaves ~${plan.tokensAfter} tokens, so the newest turn is larger than the target on its own. /model (a larger context window) or /new is the remaining way out.`,
		);
	}
	if (plan.carriedSummaries.length > 0) {
		lines.push("", "Summaries inside the dropped span are carried forward verbatim below, not lost:");
		for (const carried of plan.carriedSummaries) {
			const tag = carried.kind === "compaction" ? "carried-compaction-summary" : "carried-branch-summary";
			lines.push("", `<${tag}>`, carried.text, `</${tag}>`);
		}
	}
	return lines.join("\n");
}

/**
 * The transcript notice for an emergency shrink: what the user reads, as opposed to
 * the replacement summary the model reads. Same facts, without the carried summaries
 * (the shrink just wrote those into the summary), and it states where the dropped
 * text still exists - a shrink that reads like data loss invites the wrong recovery.
 */
export function buildEmergencyShrinkNotice(plan: EmergencyShrinkPlan, lastError?: string): string {
	const roles = Object.entries(plan.span.droppedRoles)
		.sort((a, b) => b[1] - a[1])
		.map(([role, count]) => `${role} ${count}`)
		.join(", ");
	const spanned =
		plan.span.firstDroppedTimestamp && plan.span.lastDroppedTimestamp
			? `, spanning ${plan.span.firstDroppedTimestamp} .. ${plan.span.lastDroppedTimestamp},`
			: ",";
	const outcome = plan.reachedTarget
		? `The context is now ~${plan.tokensAfter} estimated tokens, under the ${plan.targetTokens} emergency target.`
		: `It could not reach the ${plan.targetTokens} emergency target: ~${plan.tokensAfter} estimated tokens remain, so the newest turn is larger than the target on its own. /model or /new is the remaining way out.`;
	return [
		`EMERGENCY CONTEXT SHRINK: compaction kept failing${
			lastError ? ` (last error: ${lastError})` : ""
		}, and the context stayed over the compaction threshold, so the oldest ${plan.span.droppedEntries} context entries (~${plan.span.droppedTokens} tokens${
			roles ? `: ${roles}` : ""
		})${spanned} were dropped from what the model sees, without being summarized.`,
		outcome,
		"Nothing was deleted: the session transcript on disk still holds every dropped message, and /export, /tree and /fork can still reach them. The summary that replaced them names the dropped span and carries the older summaries forward verbatim.",
	].join("\n");
}

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const KERNEL_PERSIST_SUMMARY_NOTE =
	"Note: the Python kernel keeps running after this summary — every Python variable, import, and helper you defined stays available. The cells that defined them won't appear above, so record in the summary any names worth remembering so you reuse them instead of redefining them.";

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Tells the summarizer that the deterministic blocks exist and are not its job.
 *
 * Without it the model restates the fact tables in its own words, which is how a
 * SHA gains a digit and a threshold drifts: the restated copy is what a later
 * generation then reads. The blocks are appended after the narrative and rebuilt
 * from the transcript every compaction, so the only thing the narrative has to carry
 * is what a fact means and whether the work around it is done.
 *
 * The inventory of what each block holds has to match what the renderer actually
 * puts in it, or the model is told the appendix keeps five kinds while it is reading
 * six: the kind the note omits is the one the model concludes it is still responsible
 * for writing out by hand, which is the restatement this note exists to prevent. That
 * is what happened to `decision` when the fact ledger grew the kind - the block's own
 * header was updated and this note was not, so the summarizer kept rewriting decisions
 * into `## Key Decisions` prose that a later generation would then read as the record.
 */
const MACHINE_BLOCKS_NOTE = `Machine-generated blocks are appended after your summary and are not part of it: <read-files> and <modified-files>, <fact-appendix> (commit SHAs, paths, threshold numbers, error signatures, issue references and stated decisions or conclusions, extracted from the transcript by regex) and <user-requests> (the user's own words, verbatim). They are rebuilt every compaction and never pass through you, so do not restate, renumber, re-spell or "correct" their contents anywhere in your sections - a restated SHA or threshold is a second, unreliable copy of a value that is already preserved exactly, and a retold decision is a paraphrase standing in for a sentence that is already kept verbatim. Where one of them matters to the plan, refer to it and record its status (done, in progress, blocked, or still owed to the user) instead: in Key Decisions, name the decision and say whether it still stands, rather than writing the same sentence out again in your own words.`;

/**
 * Build the instruction portion of the summarization prompt: the initial or
 * update template, optional user instructions, the kernel persistence note and the
 * machine-block note.
 */
export function buildSummarizationPrompt(customInstructions?: string, previousSummary?: string): string {
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt += `\n\n<user-instructions>\nThe user provided these instructions for this summary. Follow them with high priority while keeping the section format above: emphasize what they ask to focus on, and preserve verbatim anything they ask to remember.\n${customInstructions}\n</user-instructions>`;
	}
	return `${basePrompt}\n\n${KERNEL_PERSIST_SUMMARY_NOTE}\n\n${MACHINE_BLOCKS_NOTE}`;
}

/** Index of the first user-intent message before `limit`, or -1 when there is none. */
function firstUserIntentIndex(messages: AgentMessage[], limit: number): number {
	for (let i = 0; i < limit && i < messages.length; i++) {
		if (isUserIntentMessage(messages[i])) return i;
	}
	return -1;
}

/**
 * Trim summarization input to fit a token budget, keeping the newest messages.
 * Returns the kept messages and how many older messages were elided. A budget of
 * 0 (or unknown window) disables trimming. The newest message is always kept so
 * summarization has something to work with.
 *
 * The first user-intent message is pinned against head elision (the
 * fact-appendix minimum-set precedent: significance outranks recency for a small
 * protected set). A summarizer whose input no longer contains the request it is
 * summarizing cannot answer "## Original Request" or "## Goal" from anything but
 * its own invention, and the single-turn RLM shape - task brief at the head,
 * everything after it tool-shaped - made that elision the rule rather than the
 * corner: the brief was the first thing the budget ate. Pinning trades the oldest
 * retained messages for the request when the budget binds, which the elided
 * count discloses. A first request too large for the whole budget is not pinned;
 * the newest-message guarantee then stands alone.
 */
export function budgetSummarizationInput(
	messages: AgentMessage[],
	tokenBudget: number,
): { messages: AgentMessage[]; elided: number } {
	if (tokenBudget <= 0) return { messages, elided: 0 };
	let totalTokens = 0;
	let start = messages.length;
	for (let i = messages.length - 1; i >= 0; i--) {
		const tokens = estimateTokens(messages[i]);
		if (totalTokens + tokens > tokenBudget) break;
		totalTokens += tokens;
		start = i;
	}
	if (start === messages.length && messages.length > 0) start = messages.length - 1;
	const pinnedIndex = start > 0 ? firstUserIntentIndex(messages, start) : -1;
	if (pinnedIndex < 0) return { messages: messages.slice(start), elided: start };
	const pinnedTokens = estimateTokens(messages[pinnedIndex]);
	if (pinnedTokens > tokenBudget) return { messages: messages.slice(start), elided: start };
	// Make room inside the same budget: give up the oldest retained messages before
	// giving up the request. The newest message always survives the shrink.
	while (start < messages.length && totalTokens + pinnedTokens > tokenBudget) {
		totalTokens -= estimateTokens(messages[start]);
		start++;
	}
	if (start >= messages.length) start = messages.length - 1;
	const kept = start <= pinnedIndex ? messages.slice(start) : [messages[pinnedIndex], ...messages.slice(start)];
	return { messages: kept, elided: messages.length - kept.length };
}

/**
 * Provider-anchored correction for the chars/4 estimator.
 *
 * estimateTokens reads CJK- and code-heavy transcripts low by a wide margin. The
 * session that produced the production 400 measured 614k estimated tokens against
 * 982k provider-reported prompt tokens for the same content (ratio 1.60), so a
 * budget expressed in raw estimates approves a request the provider rejects. The
 * newest assistant usage inside the slice is the provider's own count of nearly
 * this content, which makes it the cheapest honest anchor available. It covers the
 * agent system prompt and tool schemas too, so it errs high - the safe direction.
 * Returns the floor when the slice carries no usage to anchor on.
 */
export function summarizationInflation(messages: AgentMessage[]): number {
	let estimated = 0;
	let anchorTokens = 0;
	let anchorEstimated = 0;
	for (const message of messages) {
		estimated += estimateTokens(message);
		if (!isAssistantUsageSource(message)) continue;
		anchorTokens = calculateContextTokens(message.usage);
		anchorEstimated = estimated;
	}
	if (anchorTokens <= 0 || anchorEstimated <= 0) return SUMMARIZATION_INFLATION_FLOOR;
	return clampSummarizationInflation(anchorTokens / anchorEstimated);
}

/** Per-call overrides for one summarization request. */
export interface SummarizationRequestOptions {
	/**
	 * Provider tokens per estimated token. Defaults to the anchor measured from the
	 * slice itself; a retry raises it so the next attempt carries less content.
	 */
	inflation?: number;
	/**
	 * Input cap the provider announced when it rejected an earlier attempt. A
	 * retry passes it back so the next budget is exact instead of guessed.
	 */
	inputLimit?: number;
	/**
	 * Newest retained assistant text (upstream #2385): the prompt marks it as the
	 * current state so the summary cannot lag behind the kept tail.
	 */
	recentStateAnchor?: string;
}

/**
 * A summarization call the provider rejected because the request input was too
 * long - the one compaction failure that a smaller request can fix.
 */
export class SummarizationInputLengthError extends Error {
	/** Input cap the provider stated in its rejection, when it stated one. */
	readonly announcedInputLimit: number | undefined;

	constructor(errorLabel: string, errorMessage: string, announcedLimit: number | undefined) {
		super(`${errorLabel}: ${errorMessage}`);
		this.name = "SummarizationInputLengthError";
		this.announcedInputLimit = announcedLimit;
	}
}

interface SummarizationCallOptions extends SummarizationRequestOptions {
	currentMessages: AgentMessage[];
	model: Model<any>;
	reserveTokens: number;
	apiKey: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	thinkingLevel?: ThinkingLevel;
	/** Output cap for this call. */
	maxTokens: number;
	/** Instruction block that follows the conversation. */
	instructions: string;
	style: SummarizationNoteStyle;
	previousSummary?: string;
	/** Error prefix, e.g. "Summarization failed". */
	errorLabel: string;
	/** Newest retained assistant text; anchors the summary to kept-tail state. */
	recentStateAnchor?: string;
}

/**
 * Build and send one summarization request.
 *
 * The provider measures system prompt + wrapper + serialized conversation against
 * a single input limit that can sit below the declared context window, so the
 * conversation only gets what is left after the frame, the output reserve, a
 * measured-limit clamp and a safety margin are paid for, converted into the
 * estimator's caliber. Two failure modes the old `contextWindow - reserveTokens`
 * budget had are closed here: the frame was unbudgeted, and one oversized newest
 * message was always sent verbatim.
 */
async function completeSummarizationRequest(options: SummarizationCallOptions): Promise<SummarySlice> {
	const {
		currentMessages,
		model,
		reserveTokens,
		apiKey,
		headers,
		signal,
		thinkingLevel,
		maxTokens,
		instructions,
		style,
		previousSummary,
		errorLabel,
	} = options;
	// An abort that landed while the caller was parked - the gate watchdog cutting
	// a hung hook is the live example - must not still spend a wire call. Throw the
	// same AbortError shape the aborted request itself produces, so every catch
	// site (manual and auto compaction alike) settles this as a cancellation, and
	// the retry loop's own signal check keeps covering mid-flight aborts.
	if (signal?.aborted) {
		throw new DOMException("This operation was aborted", "AbortError");
	}
	const inflation = clampSummarizationInflation(options.inflation ?? summarizationInflation(currentMessages));
	const wrapperText = summarizationFrameText({
		style,
		instructions,
		previousSummary,
		maxElidedMessages: currentMessages.length,
		recentStateAnchor: options.recentStateAnchor,
	});
	const budget = computeSummarizationInputBudget({
		contextWindow: model.contextWindow,
		reserveTokens,
		systemPromptText: SUMMARIZATION_SYSTEM_PROMPT,
		wrapperText,
		provider: model.provider,
		modelId: model.id,
		inflation,
		announcedInputLimit: options.inputLimit,
	});
	const { messages: budgetedMessages, elided } = budgetSummarizationInput(currentMessages, budget.conversationTokens);
	// Serialize before the LLM call so it summarizes rather than continues this conversation.
	const conversationText = serializeConversation(convertToLlm(budgetedMessages));
	const clamped = clampConversationText(conversationText, budget.conversationTokens);
	const promptText = buildSummarizationPromptText({
		conversationText: clamped.text,
		elided,
		style,
		instructions,
		previousSummary,
		recentStateAnchor: options.recentStateAnchor,
	});

	const completionOptions =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel }
			: { maxTokens, signal, apiKey, headers };

	const response = await completeSimple(
		model,
		{
			systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: promptText }],
					timestamp: Date.now(),
				},
			],
		},
		completionOptions,
	);

	if (response.stopReason === "error") {
		const errorMessage = response.errorMessage || "Unknown error";
		if (isInputLengthRejection(errorMessage)) {
			// Carry the cap the provider announced, so a retry budgets against the
			// number this provider actually refused instead of a guess.
			throw new SummarizationInputLengthError(errorLabel, errorMessage, announcedInputLimit(errorMessage));
		}
		throw new Error(`${errorLabel}: ${errorMessage}`);
	}

	const summary = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	return { summary, usage: response.usage, elidedMessages: elided, elidedChars: clamped.droppedChars };
}

/**
 * Retry a summarization call with a smaller slice while the provider says the
 * input was too long.
 *
 * The estimator's caliber is the one thing the budget cannot know exactly, so an
 * input-length rejection is treated as a measurement: assume the content is denser
 * than assumed and try again. Bounded, because a rejection can also be permanent.
 * `run` is called once per attempt and must produce a fresh request identity, so
 * two attempts never share an idempotency key. When the rejection announced the
 * provider's cap, the next attempt is budgeted against that exact number.
 */
export async function summarizeWithInputLengthRetry(
	run: (options: SummarizationRequestOptions) => Promise<SummarySlice>,
	initialInflation: number,
	signal?: AbortSignal,
	isRetryable: (error: unknown) => boolean = (error) => error instanceof SummarizationInputLengthError,
): Promise<SummarySlice> {
	let inflation = clampSummarizationInflation(initialInflation);
	let inputLimit: number | undefined;
	for (let attempt = 0; ; attempt++) {
		try {
			return await run({ inflation, inputLimit });
		} catch (error) {
			if (attempt >= SUMMARIZATION_INPUT_RETRY_LIMIT || signal?.aborted || !isRetryable(error)) throw error;
			// Assume the content is denser than measured; and when the provider stated
			// its cap, budget the next attempt against that number instead of a guess.
			inflation = clampSummarizationInflation(inflation * SUMMARIZATION_INPUT_RETRY_SHRINK);
			if (error instanceof SummarizationInputLengthError) {
				inputLimit = error.announcedInputLimit ?? inputLimit;
			}
		}
	}
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 *
 * The input is trimmed to what the summarization request itself can carry
 * (mirroring branch summarization) so a large context cannot overflow it. Oldest
 * messages are elided first; file-operation tracking is computed from the full
 * preparation elsewhere and is unaffected.
 * If recentStateAnchor is provided (newest retained assistant text), the
 * prompt marks it as the current state so the summary cannot lag behind the
 * kept tail.
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	options?: SummarizationRequestOptions,
): Promise<SummarySlice> {
	return completeSummarizationRequest({
		...options,
		currentMessages,
		model,
		reserveTokens,
		apiKey,
		headers,
		signal,
		thinkingLevel,
		maxTokens: Math.floor(0.8 * reserveTokens),
		instructions: buildSummarizationPrompt(customInstructions, previousSummary),
		style: "history",
		previousSummary,
		errorLabel: "Summarization failed",
	});
}
export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/**
	 * Summary from previous compaction, for iterative update. Machine-generated blocks
	 * are stripped out of it: they are rebuilt by compact() rather than summarized.
	 */
	previousSummary?: string;
	/** Fact ledger carried forward from the previous compaction, if it had one. */
	previousFacts?: FactLedger;
	/** Verbatim user-request ledger carried forward from the previous compaction. */
	previousUserRequests?: UserRequestLedger;
	/** Compaction generation being written; 1 for a session's first compaction. */
	generation?: number;
	/** Effective keepRecentTokens after the window cap; sizes the machine blocks. */
	keepRecentTokens?: number;
	/** Newest retained assistant text; anchors the summary to kept-tail state */
	recentStateAnchor?: string;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

/** Compaction generation recorded in an entry's details, or 0 when it carries none. */
function detailsGeneration(details: unknown): number {
	if (typeof details !== "object" || details === null) return 0;
	const typed = details as { facts?: { generation?: number }; userRequests?: { generation?: number } };
	const fromFacts = Number.isFinite(typed.facts?.generation) ? (typed.facts?.generation ?? 0) : 0;
	const fromUsers = Number.isFinite(typed.userRequests?.generation) ? (typed.userRequests?.generation ?? 0) : 0;
	return Math.max(fromFacts, fromUsers);
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	contextWindow?: number,
	limits?: CompactionWindowLimits,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	// A hook-authored previous entry is not pi's own machine output: the
	// session_before_compact hook supplies the summary, the details and the file lists as
	// one opaque bundle, so its details are extension data (CompactionResult.details is
	// documented as extension-specific) and its text is extension prose. extractFileOperations
	// already refuses such an entry's details; everything read out of the same entry has to be
	// refused too, or the gate covers half the entry and believes the other half.
	const previousEntry = prevCompactionIndex >= 0 ? (pathEntries[prevCompactionIndex] as CompactionEntry) : undefined;
	const machineAuthored = previousEntry !== undefined && !previousEntry.fromHook;

	let previousSummary: string | undefined;
	let previousSummarySource: string | undefined;
	let previousFacts: FactLedger | undefined;
	let previousUserRequests: UserRequestLedger | undefined;
	let previousGeneration = 0;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = previousEntry as CompactionEntry;
		const storedSummary = prevCompaction.summary ?? "";
		previousSummarySource = storedSummary;
		// The machine-generated blocks never go back to the summarizer. They are
		// rebuilt from the slice every generation, so sending them only spends frame
		// budget and hands the model values it can silently alter - the measured
		// failure was a SHA restated with one extra digit, which breaks every git
		// command that uses it. What they carried is recovered structurally instead:
		// details first, the rendered block as the fallback for entries without them.
		previousSummary = stripCompactionElision(stripMachineBlocks(storedSummary)) || undefined;
		const renderedFacts = machineAuthored ? parseFactAppendix(storedSummary) : undefined;
		const renderedUserRequests = machineAuthored ? parseUserRequests(storedSummary) : undefined;
		// Metadata is text too. The rendered block's `generation` used to enter through
		// Math.max, so a forged header carrying generation="99" was enough to push every
		// later generation up by a hundred and write that number into the next entry's
		// details - details protected the content but not the counter. Details are
		// authoritative here exactly as they are for content; the rendered values are read
		// only when details carry no generation at all (an entry from a build that had none).
		const storedGeneration = machineAuthored ? detailsGeneration(prevCompaction.details) : 0;
		previousGeneration =
			storedGeneration > 0
				? storedGeneration
				: Math.max(renderedFacts?.generation ?? 0, renderedUserRequests?.generation ?? 0);
		const generation = previousGeneration + 1;
		previousFacts =
			(machineAuthored ? factLedgerFromDetails(prevCompaction.details, generation) : undefined) ?? renderedFacts;
		previousUserRequests =
			(machineAuthored ? userRequestLedgerFromDetails(prevCompaction.details, generation) : undefined) ??
			renderedUserRequests;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	// A leading harness digest is boundary furniture, not history. Leaving it at
	// index 0 moves the session's first real turn off `startIndex`, which flips
	// alignCutToTurnStart's `turnStart <= startIndex` guard: an oversized first turn
	// then aligns the cut to its own start, the only entry left before the cut is the
	// excluded digest, and the compaction reports "too short" instead of taking the
	// split-turn path that summarizes the turn's prefix.
	while (isHarnessDigestEntry(pathEntries[boundaryStart])) {
		boundaryStart++;
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const keepRecentTokens = capKeepRecentTokens(settings, contextWindow, limits);
	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, keepRecentTokens);
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// Recency anchor: the summarizer sees only messages before the cut, so its
	// summary would describe pre-tail state. The newest retained assistant
	// text is the state the next turn actually sees; pass it to the summarizer.
	const recentStateAnchor = extractRecentStateAnchor(pathEntries, cutPoint.firstKeptEntryIndex, pathEntries.length);

	// Avoid a compaction that would summarize no history: it keeps the same
	// firstKeptEntryId, so the context it produces is no smaller than the one it
	// replaces, and a threshold compaction would re-fire every turn.
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return undefined;
	}
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
	// Split turns retain their suffix, but their prefix file operations still belong in the summary.
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}
	// The file lists are stripped out of the previous summary above, so an entry whose
	// details are missing recovers them from the rendered blocks instead of losing them.
	// Same gate as the details above: a hook-authored entry's blocks are extension text,
	// so they are not a source of file operations either.
	if (previousSummarySource && machineAuthored) {
		extractFileOpsFromSummary(previousSummarySource, fileOps);
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		previousFacts,
		previousUserRequests,
		generation: previousGeneration + 1,
		keepRecentTokens,
		recentStateAnchor,
		fileOps,
		settings,
	};
}

/**
 * Maximum characters kept from the retained tail for the recency anchor.
 * The end of a message holds the newest state, so long text keeps its tail.
 */
const RECENT_STATE_ANCHOR_MAX_CHARS = 2000;

/**
 * Extract the newest retained assistant text (the recency anchor) from the
 * kept tail [keptStart, keptEnd). Returns undefined when the tail has no
 * assistant text; long text is tail-truncated to the anchor budget.
 */
function extractRecentStateAnchor(entries: SessionEntry[], keptStart: number, keptEnd: number): string | undefined {
	for (let i = keptEnd - 1; i >= keptStart; i--) {
		const msg = getMessageFromEntryForCompaction(entries[i]);
		if (!msg || msg.role !== "assistant" || !("content" in msg) || !Array.isArray(msg.content)) continue;
		const text = msg.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (!text) continue;
		return text.length > RECENT_STATE_ANCHOR_MAX_CHARS
			? text.slice(text.length - RECENT_STATE_ANCHOR_MAX_CHARS)
			: text;
	}
	return undefined;
}
const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
/** Runs one summary wire call; hosts decorate each call with its own request identity. */
export type SummaryCallRunner = <T>(
	call: (callHeaders: Record<string, string> | undefined) => Promise<T>,
) => Promise<T>;

/** Machine-readable elision disclosure block, rendered at the head of a summary. */
const ELISION_DISCLOSURE_TAG = "compaction-elision";

/**
 * Render the summary's self-describing elision header.
 *
 * The counts come from the summarizer request itself (budgetSummarizationInput's
 * message elision and clampConversationText's character drop), so the summary can
 * say what it did not see. The tag is deliberately not a machine-block tag: it is
 * not rebuilt deterministically or carried in details, it is a fact about one
 * summarization pass, and `stripCompactionElision` removes it before the next
 * generation re-enters, so disclosures do not accumulate.
 */
export function compactionElisionDisclosure(elidedMessages: number, elidedChars: number): string {
	const counts = [`${elidedMessages} older message(s)`, `${elidedChars} character(s)`];
	return `<${ELISION_DISCLOSURE_TAG} messages="${elidedMessages}" chars="${elidedChars}">
This summary has omissions: ${counts.join(" and ")} were elided from the input the summarizer saw, to fit its budget. Content the elided part carried may be missing entirely - check the machine blocks below, the retained transcript and other persistent records before concluding anything was never said.
</${ELISION_DISCLOSURE_TAG}>`;
}

/** Remove a leading elision disclosure block from a stored summary. */
export function stripCompactionElision(text: string): string {
	const pattern = new RegExp(
		`^\\s*<${ELISION_DISCLOSURE_TAG}\\b[^>]*>[\\s\\S]*?</${ELISION_DISCLOSURE_TAG}>\\s*\\n*`,
		"",
	);
	return text.replace(pattern, "");
}

export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	summaryCall: SummaryCallRunner = (call) => call(headers),
	// biome-ignore lint/correctness/noUnusedFunctionParameters: upstream #2045 threads a provider retry policy and the session id into compact(); this fork's summarization runner (completeSummarizationRequest) owns the wire call and budgets/ retries on input length itself, so the policy has no consumer yet. Kept in the signature because the call site (agent-session.ts) already passes both.
	retry?: ProviderRetryPolicy,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: same as retry above - accepted at the boundary, not yet threaded into the fork's summarization runner.
	sessionId?: string,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		recentStateAnchor,
		fileOps,
		settings,
	} = preparation;
	let summary: string;
	const slices: SummarySlice[] = [];

	// Each attempt is a separate wire call, so it goes through summaryCall again and
	// gets its own request identity: a shrunk body must never reuse an idempotency key.
	const runHistorySummary = (requestOptions: SummarizationRequestOptions) =>
		summaryCall((callHeaders) =>
			generateSummary(
				messagesToSummarize,
				model,
				settings.reserveTokens,
				apiKey,
				callHeaders,
				signal,
				customInstructions,
				previousSummary,
				thinkingLevel,
				{ ...requestOptions, recentStateAnchor },
			),
		);
	const runTurnPrefixSummary = (requestOptions: SummarizationRequestOptions) =>
		summaryCall((callHeaders) =>
			generateTurnPrefixSummary(
				turnPrefixMessages,
				model,
				settings.reserveTokens,
				apiKey,
				callHeaders,
				signal,
				thinkingLevel,
				requestOptions,
			),
		);

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		// Split turns make two wire calls with different bodies; each needs its own identity.
		const [historyResult, turnPrefixResult] = await Promise.all([
			// An empty history slice still replaces the previous compaction in the
			// rebuilt context, so carry its summary forward instead of dropping
			// everything summarized before it.
			messagesToSummarize.length > 0
				? summarizeWithInputLengthRetry(runHistorySummary, summarizationInflation(messagesToSummarize), signal)
				: Promise.resolve<SummarySlice>({ summary: previousSummary ?? "No prior history." }),
			summarizeWithInputLengthRetry(runTurnPrefixSummary, summarizationInflation(turnPrefixMessages), signal),
		]);
		slices.push(historyResult, turnPrefixResult);
		summary = `${historyResult.summary}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.summary}`;
	} else {
		const result = await summarizeWithInputLengthRetry(
			runHistorySummary,
			summarizationInflation(messagesToSummarize),
			signal,
		);
		slices.push(result);
		summary = result.summary;
	}
	// The elision the summarizer's own input suffered is disclosed in the summary's
	// self-describing header, machine-readably, so the continuation knows the summary
	// is a partial record instead of assuming it covers the compacted history.
	const elidedMessages = slices.reduce((total, slice) => total + (slice.elidedMessages ?? 0), 0);
	const elidedChars = slices.reduce((total, slice) => total + (slice.elidedChars ?? 0), 0);
	if (elidedMessages > 0 || elidedChars > 0) {
		summary = `${compactionElisionDisclosure(elidedMessages, elidedChars)}\n\n${summary}`;
	}
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);
	// Deterministic blocks: no model involvement, so nothing here can be dropped,
	// restated or altered by the summarizer, and nothing here decays with the
	// generation count.
	const appendix = buildCompactionAppendix(preparation);
	summary += appendix.text;

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	let usage: Usage | undefined;
	for (const slice of slices) {
		if (!slice.usage) continue;
		usage ??= emptyUsage();
		addAssistantUsage(usage, slice.usage);
	}
	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: {
			readFiles,
			modifiedFiles,
			facts: appendix.facts,
			userRequests: appendix.userRequests,
		} as CompactionDetails,
		usage,
	};
}

export interface CompactionAppendix {
	/** Fact ledger behind the rendered <fact-appendix> block; carried in entry details. */
	facts: FactLedger;
	/** Ledger behind the rendered <user-requests> block; carried in entry details. */
	userRequests: UserRequestLedger;
	/** Both blocks rendered, in summary order; empty when neither ledger has content. */
	text: string;
}

/**
 * Build the machine-generated part of a compaction summary.
 *
 * The input is the slice being summarized plus, for a split turn, the turn prefix -
 * both are leaving the context, so both have to be harvested. Budgets come from the
 * effective keepRecentTokens and the size of what is being replaced, which keeps the
 * blocks proportionate on a 128k window and on a 1M one without a setting to tune.
 *
 * Pure and synchronous: it can be replayed over a stored slice without a model, which
 * is how the generational-decay guarantee is tested.
 */
export function buildCompactionAppendix(preparation: CompactionPreparation): CompactionAppendix {
	const { messagesToSummarize, turnPrefixMessages, settings } = preparation;
	const generation = preparation.generation !== undefined && preparation.generation > 0 ? preparation.generation : 1;
	const keepRecentTokens = preparation.keepRecentTokens ?? capKeepRecentTokens(settings, undefined);
	const source = turnPrefixMessages.length > 0 ? [...messagesToSummarize, ...turnPrefixMessages] : messagesToSummarize;
	// Same caliber as keepRecentTokens above and as the ledger that spends the
	// budget: the facts are priced by content density when they are fitted, so a
	// slice-share cut in the flat chars/4 caliber would size a CJK-heavy appendix
	// up to 2.67x below what it costs.
	const summarizedTokens = source.reduce((total, message) => total + estimateTokensByContent(message), 0);
	const facts = buildFactLedger({
		messages: source,
		generation,
		previous: preparation.previousFacts,
		tokenBudget: factAppendixTokenBudget(keepRecentTokens, summarizedTokens),
	});
	const userRequests = buildUserRequestLedger({
		messages: source,
		generation,
		previous: preparation.previousUserRequests,
		tokenBudget: userRequestsTokenBudget(keepRecentTokens),
	});
	return {
		facts,
		userRequests,
		text: `${renderFactAppendix(facts)}${renderUserRequests(userRequests)}`,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 *
 * Same request budget as generateSummary: an oversized turn prefix must not
 * overflow the summarization request itself.
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	options?: SummarizationRequestOptions,
): Promise<SummarySlice> {
	return completeSummarizationRequest({
		...options,
		currentMessages: messages,
		model,
		reserveTokens,
		apiKey,
		headers,
		signal,
		thinkingLevel,
		maxTokens: Math.floor(0.5 * reserveTokens), // Smaller budget for turn prefix
		instructions: TURN_PREFIX_SUMMARIZATION_PROMPT,
		style: "turn-prefix",
		errorLabel: "Turn prefix summarization failed",
	});
}
