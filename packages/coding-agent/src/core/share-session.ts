/**
 * /share preflight: detect common secret shapes and create a private temp HTML file.
 *
 * Hits list pattern types only — never the matched secret text.
 */

import { createPrivateTempFile, type PrivateTempFile } from "../utils/private-files.js";
import { decodeEmbeddedSessionData } from "./export-html/session-data-embedding.js";

export interface ShareSecretPattern {
	/** User-visible type label. Must not include matched content. */
	type: string;
	pattern: RegExp;
}

export const SHARE_SECRET_PATTERNS: readonly ShareSecretPattern[] = [
	{ type: "API key (sk-)", pattern: /\bsk-[A-Za-z0-9_-]{8,}/g },
	{ type: "AWS access key (AKIA)", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
	{ type: "GitHub token (ghp_)", pattern: /\bghp_[A-Za-z0-9_]{20,}/g },
	{ type: "GitHub token (github_pat_)", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
	{ type: "Bearer token", pattern: /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi },
	{ type: "PEM private key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
];

/** Unique secret types found in `content`. Never returns matched secret text. */
export function findShareSecretHits(content: string): string[] {
	const hits: string[] = [];
	const seen = new Set<string>();
	for (const { type, pattern } of SHARE_SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		if (pattern.test(content) && !seen.has(type)) {
			seen.add(type);
			hits.push(type);
		}
	}
	return hits;
}

export function formatShareSecretWarning(types: readonly string[]): { title: string; message: string } {
	const list = types.map((type) => `- ${type}`).join("\n");
	return {
		title: "Share session",
		message:
			`This session looks like it contains secrets:\n${list}\n\n` +
			"/share uploads the exported session (messages, system prompt, tools, and the\n" +
			"working-directory context the exporter adds) as a private GitHub gist.\n\n" +
			"Upload anyway?",
	};
}

/**
 * JSON string escapes hide the separators a secret shape is delimited by: in the
 * exported payload `...\nAKIA...` puts a literal `n` in front of the key, so the
 * `\b` anchors of the patterns above never fire. Unescape the two-character forms
 * before scanning. Scan-only normalization: the result is never stored, shown or
 * returned, and it can only widen what the preflight sees.
 */
const SCAN_JSON_ESCAPES = /\\(?:([nrtbf"\\/])|u([0-9a-fA-F]{4}))/g;

function unescapeForScan(text: string): string {
	return text.replace(SCAN_JSON_ESCAPES, (_match, single?: string, hex?: string) => {
		if (hex !== undefined) {
			return String.fromCharCode(Number.parseInt(hex, 16));
		}
		switch (single) {
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "b":
				return "\b";
			case "f":
				return "\f";
			default:
				return single ?? "";
		}
	});
}

/**
 * Every text view of the uploaded artifact that can carry a secret: the bytes as
 * uploaded (plaintext the exporter adds around the payload), the payload recovered
 * from the base64 container, and that payload with its JSON escapes resolved.
 */
function shareUploadScanTargets(uploadedContent: string): string[] {
	const targets = [uploadedContent];
	const payload = decodeEmbeddedSessionData(uploadedContent);
	if (payload !== undefined) {
		targets.push(payload, unescapeForScan(payload));
	}
	return targets;
}

/**
 * Unique secret types reachable from the bytes that will actually be uploaded, in
 * SHARE_SECRET_PATTERNS order. The exported session travels as base64 inside the
 * document, so scanning the uploaded text alone scans an encoding of the session
 * and passes every secret it contains.
 */
export function findShareUploadSecretHits(uploadedContent: string): string[] {
	const found = new Set<string>();
	for (const target of shareUploadScanTargets(uploadedContent)) {
		for (const type of findShareSecretHits(target)) {
			found.add(type);
		}
	}
	return SHARE_SECRET_PATTERNS.map((pattern) => pattern.type).filter((type) => found.has(type));
}

/**
 * Gate an upload on a secret scan of `content`. Callers must pass the bytes that
 * will actually be uploaded, not a proxy for them: a narrower shape silently
 * passes every secret that lives outside it. Everything a viewer can recover from
 * those bytes is scanned too (see findShareUploadSecretHits).
 */
export async function confirmShareIfSecrets(
	content: string,
	confirm: (title: string, message: string) => Promise<boolean>,
): Promise<boolean> {
	const hits = findShareUploadSecretHits(content);
	if (hits.length === 0) {
		return true;
	}
	const warning = formatShareSecretWarning(hits);
	return confirm(warning.title, warning.message);
}

/**
 * Upper bound on one `gh gist create` upload. A lower bound on how long the
 * preflight waits, not a target: it has to sit above a large session export on a
 * slow link, because cutting a working upload off is worse than waiting. The
 * loader stays cancellable the whole time, so this only catches an upload whose
 * process stops reporting anything at all.
 */
export const SHARE_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export function createShareTempHtmlFile(): PrivateTempFile {
	return createPrivateTempFile("prime-agent-share-", ".html");
}
