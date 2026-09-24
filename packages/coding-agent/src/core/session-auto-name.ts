/**
 * Deterministic auto-naming for session threads.
 *
 * A session transcript carries its display name in `session_info` entries
 * (last one wins). Before this module those entries were only ever written by
 * hand (/name, rlm spawn name=, daemon rename), so root sessions and
 * message-triggered sessions stayed nameless and every roster/tab/list surface
 * fell back to UUIDs. This module derives a readable name from the first
 * inbound content, inherits names across compaction/fork lineage, and sanitizes
 * best-effort LLM-refined titles. Pure string logic lives here so tests can pin
 * every rule; the AgentSession hook and the `autotitle` backfill command are
 * thin callers.
 */
import { readFileSync } from "node:fs";

import { AGENT_MESSAGE_CUSTOM_TYPE } from "./agent-messages.js";

/** Stored auto names cap at 32 code points so CJK titles stay readable in tabs and rosters. */
export const AUTO_SESSION_NAME_MAX_CODE_POINTS = 32;
/** A refined (LLM) title longer than this is refused rather than truncated: it is not a title. */
export const REFINED_TITLE_MAX_CODE_POINTS = 40;

const UUID_LIKE = /^[0-9a-fA-F]{6,}-?[0-9a-fA-F-]*$/;
const FENCE_LINE = /^(```|~~~)/;
const RULE_LINE = /^[-*_]{3,}$/;
const ABS_PATH_LINE = /^\/\S+$/;
const URL_LINE = /^https?:\/\/\S+$/i;
/**
 * Acknowledgements and probes make terrible thread names and collide across
 * sessions ("继续", "ok"); a session whose first word is one stays unnamed
 * until a message with content arrives.
 */
const LOW_INFORMATION_NAME =
	/^([好嗯哦呵行对是呀哈]|[oO][kK][aA]?[yY]?|[hH][iIiIeElLlLoO]{2,5}|[yY][eE][sS]|[nN][oO]|继续|继续吧|测试|test|testing|ping|pong)$/;

export interface AutoNameInboundMessage {
	role: string;
	customType?: string;
	content?: unknown;
	details?: unknown;
}

export interface SessionLineageName {
	name: string;
	auto: boolean;
}

export type AutoSessionNameMode = "off" | "first-message" | "llm";

/**
 * The first line of `text` that carries meaning: fences, horizontal rules and
 * empty lines are skipped, blockquote markers stripped. Undefined when nothing
 * remains (image-only prompts, empty broadcasts).
 */
function firstMeaningfulLine(text: string): string | undefined {
	for (const rawLine of text.split(/\r?\n/)) {
		let line = rawLine.trim();
		if (!line) continue;
		if (FENCE_LINE.test(line) || RULE_LINE.test(line)) continue;
		line = line.replace(/^>\s?/, "").trim();
		if (!line) continue;
		return line;
	}
	return undefined;
}

/**
 * A first message that is nothing but a path or URL names nothing ("find the
 * thread" dies on `/Users/x/Library/Containers/...`). Relocate it to the piece
 * a human recognizes: the basename, or host plus last path segment.
 */
function relocatePathOrUrl(line: string): string | undefined {
	// A pasted path or URL often arrives with trailing prose or a second token;
	// judge the first whitespace-separated token, not the whole line.
	const token = line.split(/\s+/)[0] ?? "";
	if (URL_LINE.test(token)) {
		try {
			const url = new URL(token);
			const segments = url.pathname.split("/").filter((part) => part.length > 0);
			const last = segments[segments.length - 1];
			return last ? `${url.host}/${last}` : url.host;
		} catch {
			return undefined;
		}
	}
	if (ABS_PATH_LINE.test(token) && token.split("/").length >= 3) {
		const segments = token.split("/").filter((part) => part.length > 0);
		return segments[segments.length - 1];
	}
	return undefined;
}

/**
 * Derive the stored auto name for raw inbound text: first meaningful line,
 * paths/URLs relocated, whitespace collapsed, 32 code points plus an ellipsis.
 * Undefined for degenerate input (empty, uuid-like, punctuation-only).
 */
export function deriveAutoSessionName(text: string): string | undefined {
	const line = firstMeaningfulLine(text);
	if (line === undefined) return undefined;
	const relocated = relocatePathOrUrl(line);
	const cleaned = (relocated ?? line)
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	if (UUID_LIKE.test(cleaned)) return undefined;
	if (LOW_INFORMATION_NAME.test(cleaned)) return undefined;
	const points = Array.from(cleaned);
	if (points.length <= AUTO_SESSION_NAME_MAX_CODE_POINTS) return cleaned;
	return `${points.slice(0, AUTO_SESSION_NAME_MAX_CODE_POINTS).join("")}\u2026`;
}

function textOfContent(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const joined = content
			.map((block) =>
				block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
					? (block as { text: string }).text
					: "",
			)
			.join(" ");
		return joined.trim() ? joined : undefined;
	}
	return undefined;
}

/** Strip the `[from ...] / Agent-to-agent message received.` header block, keeping the payload. */
export function stripAgentMessageEnvelope(text: string): string {
	const index = text.indexOf("\n\n");
	return index >= 0 ? text.slice(index + 2) : text;
}

/**
 * The last `session_info` entry of a transcript, scanned tail-first: the name a
 * lineage ancestor settled on, with its provenance. An entry without a name
 * counts as a decision (someone renamed to empty) and stops the walk.
 */
export function scanLastSessionInfoEntry(sessionFile: string): SessionLineageName | undefined {
	let text: string;
	try {
		text = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim();
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object") continue;
		const entry = parsed as { type?: unknown; name?: unknown; auto?: unknown };
		if (entry.type !== "session_info") continue;
		if (typeof entry.name === "string" && entry.name.trim()) {
			return { name: entry.name.trim(), auto: entry.auto === true };
		}
		return undefined;
	}
	return undefined;
}

/**
 * The naming source of an inbound message: a human-typed user message speaks
 * for itself; an agent-to-agent broadcast names the session by its payload
 * (details.message carries it raw; the persisted content needs envelope
 * stripping). Anything else (heartbeat, harness digest, tool results) is not a
 * naming source.
 */
export function inboundNameSource(message: AutoNameInboundMessage): string | undefined {
	if (message.role === "user") return textOfContent(message.content);
	if (message.role === "custom" && message.customType === AGENT_MESSAGE_CUSTOM_TYPE) {
		const details = message.details as { message?: unknown } | undefined;
		if (typeof details?.message === "string" && details.message.trim()) return details.message;
		const content = textOfContent(message.content);
		return content === undefined ? undefined : stripAgentMessageEnvelope(content);
	}
	return undefined;
}

/**
 * The first naming source among in-memory messages. Live persistence suppresses
 * custom entries until the first assistant reply lands, so at the assistant tick
 * the broadcast that triggered the turn can still be disk-absent; the in-memory
 * transcript already holds it and names the session without waiting for a
 * second inbound.
 */
export function firstInboundSourceFromMessages(messages: readonly AutoNameInboundMessage[]): string | undefined {
	for (const message of messages) {
		const source = inboundNameSource(message);
		if (source !== undefined && source.trim()) return source;
	}
	return undefined;
}

/**
 * The first inbound naming source already on disk for a transcript: the first
 * user message text, or the first agent-to-agent broadcast payload. A resumed
 * session names the thread by its origin, not by whatever message happened to
 * resume it, so runtime naming and `autoname` backfill agree on one label.
 */
export function scanFirstInboundSource(sessionFile: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object") continue;
		const record = parsed as {
			type?: unknown;
			message?: AutoNameInboundMessage;
			customType?: string;
			content?: unknown;
			details?: unknown;
		};
		if (record.type !== "message" && record.type !== "custom_message") continue;
		const message: AutoNameInboundMessage =
			record.type === "message"
				? (record.message as AutoNameInboundMessage)
				: { role: "custom", customType: record.customType, content: record.content, details: record.details };
		if (!message) continue;
		const source = inboundNameSource(message);
		if (source !== undefined && source.trim()) return source;
	}
	return undefined;
}

/**
 * The single decision point the AgentSession hook and tests share: never name
 * when disabled or when a name already exists (manual names are sacred),
 * prefer the derived first-inbound name (disk origin first, then the live
 * message), fall back to lineage inheritance.
 */
export function autoNameForInbound(options: {
	mode: AutoSessionNameMode;
	currentName: string | undefined;
	message: AutoNameInboundMessage;
	diskSource?: string | undefined;
}): SessionLineageName | undefined {
	if (options.mode === "off") return undefined;
	if (options.currentName !== undefined) return undefined;
	const source = options.diskSource ?? inboundNameSource(options.message);
	const derived = source === undefined ? undefined : deriveAutoSessionName(source);
	return derived ? { name: derived, auto: true } : undefined;
}

/**
 * Keep auto names unambiguous: sibling sessions are addressable by name
 * (agent-message send/abort resolve receivers by name and throw on ambiguity),
 * so a collision gets a numeric suffix instead of a twin.
 */
export function uniquifyAutoName(name: string, taken: ReadonlySet<string>): string {
	if (!taken.has(name)) return name;
	for (let suffix = 2; suffix < 1000; suffix++) {
		const candidate = `${name} ${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${name} ${Date.now()}`;
}

export interface SessionNamingFacts {
	nameInfo: SessionLineageName | undefined;
	firstInbound: string | undefined;
	hasAssistant: boolean;
	headerVersion: number | undefined;
}

/**
 * One pass over a transcript for the backfill command: the settled name (with
 * provenance), the first inbound naming source, whether any assistant reply
 * ever landed (empty drafts stay discardable and unnamed), and the file
 * version (legacy files must not be migrated just to decorate them).
 */
export function scanSessionNamingFacts(sessionFile: string): SessionNamingFacts {
	const facts: SessionNamingFacts = {
		nameInfo: undefined,
		firstInbound: undefined,
		hasAssistant: false,
		headerVersion: undefined,
	};
	let text: string;
	try {
		text = readFileSync(sessionFile, "utf8");
	} catch {
		return facts;
	}
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim();
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object") continue;
		const entry = parsed as {
			type?: unknown;
			version?: unknown;
			name?: unknown;
			auto?: unknown;
			message?: AutoNameInboundMessage;
			customType?: string;
			content?: unknown;
			details?: unknown;
		};
		if (entry.type === "session") {
			facts.headerVersion = typeof entry.version === "number" ? entry.version : 1;
			continue;
		}
		if (entry.type === "session_info" && facts.nameInfo === undefined) {
			if (typeof entry.name === "string" && entry.name.trim()) {
				facts.nameInfo = { name: entry.name.trim(), auto: entry.auto === true };
			}
			continue;
		}
		if (entry.type === "message") {
			const role = (entry.message as { role?: string } | undefined)?.role;
			if (role === "assistant") facts.hasAssistant = true;
		}
	}
	facts.firstInbound = scanFirstInboundSource(sessionFile);
	return facts;
}

/**
 * Clean an LLM-refined title: one line, no fences/quotes/markdown emphasis.
 * Undefined when the model returned prose instead of a title (too long) or
 * something degenerate - the caller then keeps the deterministic name.
 */
export function sanitizeRefinedTitle(raw: string): string | undefined {
	const firstLine = raw.replace(/```/g, " ").split(/\r?\n/)[0] ?? "";
	const cleaned = firstLine
		.trim()
		.replace(/^["'\u201c\u2018`*#\s]+/, "")
		.replace(/["'\u201d\u2019`*#\s]+$/, "")
		.trim();
	if (!cleaned) return undefined;
	if (UUID_LIKE.test(cleaned)) return undefined;
	if (Array.from(cleaned).length > REFINED_TITLE_MAX_CODE_POINTS) return undefined;
	return cleaned;
}

/** Base output budget for one title-refinement call; thinking-capable models get a reserve on top. */
export const AUTO_TITLE_BASE_MAX_TOKENS = 256;
/** Refinement waits at most this long before the deterministic name stands. */
export const AUTO_TITLE_TIMEOUT_MS = 20_000;

export const AUTO_TITLE_SYSTEM_PROMPT =
	"You name conversation threads for a terminal session picker. Reply with ONLY the title: at most 20 Chinese characters (or 8 English words), no quotes, no trailing punctuation. Keep the user's own nouns and verbs so the thread stays findable by their words.";

export function buildAutoTitlePrompt(inbound: string, assistantText: string): string {
	return [
		"First inbound message:",
		'"""',
		inbound.slice(0, 800),
		'"""',
		"",
		"First assistant reply (excerpt):",
		'"""',
		assistantText.slice(0, 500),
		'"""',
		"",
		"Title:",
	].join("\n");
}
