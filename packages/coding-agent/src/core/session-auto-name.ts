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
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

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
	// A pasted path or URL often arrives inside prose ("看看 /Users/…"); take the
	// first whitespace-separated token that looks like one, anywhere in the line.
	const token = line
		.split(/\s+/)
		.find((part) => URL_LINE.test(part) || (ABS_PATH_LINE.test(part) && part.split("/").length >= 3));
	if (!token) return undefined;
	if (URL_LINE.test(token)) {
		try {
			const url = new URL(token);
			const segments = url.pathname.split("/").filter((part) => part.length > 0);
			// github.com/4603 names nothing: on code hosts keep owner/repo,
			// elsewhere the last two path segments.
			const isCodeHost = /(^|\.)(github|gitlab|bitbucket|codeberg)\./i.test(url.host);
			const tail = isCodeHost ? segments.slice(0, 2) : segments.slice(-2);
			return tail.length > 0 ? `${url.host}/${tail.join("/")}` : url.host;
		} catch {
			return undefined;
		}
	}
	const segments = token.split("/").filter((part) => part.length > 0);
	return segments[segments.length - 1];
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

const HEAD_WINDOW_BYTES = 512 * 1024;
const TAIL_WINDOW_BYTES = 256 * 1024;

function readWindow(sessionFile: string, kind: "head" | "tail"): string {
	let fd: number | undefined;
	try {
		fd = openSync(sessionFile, "r");
		const size = fstatSync(fd).size;
		const offset = kind === "head" ? 0 : Math.max(0, size - TAIL_WINDOW_BYTES);
		const length = kind === "head" ? Math.min(size, HEAD_WINDOW_BYTES) : Math.min(size, TAIL_WINDOW_BYTES);
		const buffer = Buffer.alloc(length);
		const read = readSync(fd, buffer, 0, length, offset);
		return buffer.toString("utf8", 0, read);
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// fd already gone; nothing to release
			}
		}
	}
}

function inboundSourcesInText(text: string): string[] {
	const sources: string[] = [];
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
		if (source !== undefined && source.trim()) sources.push(source);
	}
	return sources;
}

/**
 * The last `session_info` name visible in bounded head/tail windows: the cheap
 * provenance re-check for writers (a full-file scan on the persist hot path
 * measured half a second on a 33 MB transcript). Names written early sit in the
 * head window; renames land in the tail; a name outside both windows is older
 * than any decision this check protects.
 */
export function readSessionNameBounded(sessionFile: string): SessionLineageName | undefined {
	const tail = inboundLastSessionInfoInText(readWindow(sessionFile, "tail"));
	if (tail) return tail;
	return inboundLastSessionInfoInText(readWindow(sessionFile, "head"));
}

function inboundLastSessionInfoInText(text: string): SessionLineageName | undefined {
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
 * The first inbound source that actually derives a name, in-memory first (the
 * live transcript already holds broadcasts that persistence still suppresses),
 * then the bounded head window of the file (the first inbound always lives near
 * the top). Low-information openers ("继续") are skipped, so a session is named
 * by its first substantive message instead of staying unnamed forever.
 */
export function firstDerivableInboundSource(
	sessionFile: string | undefined,
	messages: readonly AutoNameInboundMessage[],
): { source: string; name: string } | undefined {
	for (const message of messages) {
		const source = inboundNameSource(message);
		if (source === undefined || !source.trim()) continue;
		const name = deriveAutoSessionName(source);
		if (name) return { source, name };
	}
	if (sessionFile) {
		for (const source of inboundSourcesInText(readWindow(sessionFile, "head"))) {
			const name = deriveAutoSessionName(source);
			if (name) return { source, name };
		}
	}
	return undefined;
}

const siblingNameMemo = new Map<string, { mtimeMs: number; name: string | undefined }>();

/**
 * Settled names of sibling transcripts in one directory, via bounded windows and
 * an mtime memo: auto names must never create twins, because name-based
 * agent-message routing throws on ambiguity.
 */
export function readSiblingSessionNames(sessionsDir: string, excludeFile: string): Set<string> {
	const taken = new Set<string>();
	let entries: string[];
	try {
		entries = readdirSync(sessionsDir);
	} catch {
		return taken;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const file = join(sessionsDir, entry);
		if (file === excludeFile) continue;
		let mtimeMs: number;
		try {
			const fd = openSync(file, "r");
			try {
				mtimeMs = fstatSync(fd).mtimeMs;
			} finally {
				closeSync(fd);
			}
		} catch {
			continue;
		}
		const memo = siblingNameMemo.get(file);
		if (memo && memo.mtimeMs === mtimeMs) {
			if (memo.name) taken.add(memo.name);
			continue;
		}
		const name = readSessionNameBounded(file)?.name;
		siblingNameMemo.set(file, { mtimeMs, name });
		if (name) taken.add(name);
	}
	return taken;
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
 * prefer the first derivable inbound name the caller resolved (in-memory
 * messages first, then the transcript head window).
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
	/** The first inbound source that actually derives a name (low-info openers skipped). */
	derivedName: string | undefined;
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
		derivedName: undefined,
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
	for (const source of inboundSourcesInText(text)) {
		const name = deriveAutoSessionName(source);
		if (name) {
			facts.derivedName = name;
			break;
		}
	}
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
