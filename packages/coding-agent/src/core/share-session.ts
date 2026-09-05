/**
 * /share preflight: detect common secret shapes and create a private temp HTML file.
 *
 * Hits list pattern types only — never the matched secret text.
 */

import { createPrivateTempFile, type PrivateTempFile } from "../utils/private-files.js";

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
 * Gate an upload on a secret scan of `content`. Callers must pass the bytes that
 * will actually be uploaded, not a proxy for them: a narrower shape silently
 * passes every secret that lives outside it.
 */
export async function confirmShareIfSecrets(
	content: string,
	confirm: (title: string, message: string) => Promise<boolean>,
): Promise<boolean> {
	const hits = findShareSecretHits(content);
	if (hits.length === 0) {
		return true;
	}
	const warning = formatShareSecretWarning(hits);
	return confirm(warning.title, warning.message);
}

export function createShareTempHtmlFile(): PrivateTempFile {
	return createPrivateTempFile("prime-agent-share-", ".html");
}
