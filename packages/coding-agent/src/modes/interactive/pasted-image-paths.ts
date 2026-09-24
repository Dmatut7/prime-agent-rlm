/**
 * Image file paths pasted into the editor - typed, copied, or dropped from Finder,
 * which quotes or backslash-escapes spaces, and macOS screenshot names that carry a
 * U+202F narrow no-break space before AM/PM - so the host can attach each file as an
 * image the way Ctrl+V does, instead of relying on the model to load it.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveReadPath } from "../../core/tools/path-utils.js";

/** Matches the attach-image skill's source cap: larger files are left as text. */
const MAX_IMAGE_FILE_BYTES = 20_000_000;
const MAX_PASTED_IMAGE_PATHS = 10;

/** Supported image type from the file's leading bytes (PNG, JPEG, GIF, WebP). */
export function sniffImageMimeType(head: Uint8Array): string | undefined {
	const starts = (...bytes: number[]) => bytes.every((byte, index) => head[index] === byte);
	if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
	const riff = String.fromCharCode(...head.subarray(0, 4));
	const webp = String.fromCharCode(...head.subarray(8, 12));
	if (riff === "RIFF" && webp === "WEBP") return "image/webp";
	return undefined;
}

/** Split a line like a shell does: quotes group, a backslash escapes the next character. */
function shellWords(line: string): string[] | undefined {
	const words: string[] = [];
	let current = "";
	let inWord = false;
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"' && index + 1 < line.length) current += line[++index];
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			inWord = true;
		} else if (char === "\\" && index + 1 < line.length) {
			current += line[++index];
			inWord = true;
		} else if (/\s/.test(char)) {
			if (inWord) words.push(current);
			current = "";
			inWord = false;
		} else {
			current += char;
			inWord = true;
		}
	}
	if (quote) return undefined;
	if (inWord) words.push(current);
	return words;
}

function looksLikePath(candidate: string): boolean {
	return /^(?:\/|~\/|\.{1,2}\/|file:\/\/)/.test(candidate);
}

/** The image file `candidate` names on disk, or undefined when it is not one. */
function resolveImageFile(candidate: string, cwd: string): { path: string; mimeType: string } | undefined {
	if (!looksLikePath(candidate)) return undefined;
	let raw = candidate;
	if (raw.startsWith("file://")) {
		try {
			raw = fileURLToPath(raw);
		} catch {
			return undefined;
		}
	}
	const path = resolveReadPath(raw, cwd);
	try {
		const stats = statSync(path);
		if (!stats.isFile() || stats.size === 0 || stats.size > MAX_IMAGE_FILE_BYTES) return undefined;
		const head = new Uint8Array(16);
		const fd = openSync(path, "r");
		try {
			readSync(fd, head, 0, head.length, 0);
		} finally {
			closeSync(fd);
		}
		const mimeType = sniffImageMimeType(head);
		return mimeType ? { path, mimeType } : undefined;
	} catch {
		return undefined;
	}
}

function resolveAll(candidates: string[], cwd: string): { path: string; mimeType: string }[] | undefined {
	if (candidates.length === 0 || candidates.length > MAX_PASTED_IMAGE_PATHS) return undefined;
	const files: { path: string; mimeType: string }[] = [];
	for (const candidate of candidates) {
		const file = resolveImageFile(candidate, cwd);
		if (!file) return undefined;
		files.push(file);
	}
	return files;
}

function stripOuterQuotes(text: string): string {
	const match = /^(['"])(.*)\1$/s.exec(text);
	return match ? match[2] : text;
}

/**
 * The image files a paste consists of, when it is exactly one or more existing image
 * file paths (one per line, or space separated with quotes / backslash escapes as a
 * Finder drop produces them). Anything else - prose around a path, a missing file, a
 * file that is not an image - returns undefined and the paste stays plain text.
 */
export function imageFilesInPaste(text: string, cwd: string): { path: string; mimeType: string }[] | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed.length > 8_000) return undefined;
	const lines = trimmed
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length > 1) {
		const perLine = resolveAll(
			lines.map((line) => stripOuterQuotes(line)),
			cwd,
		);
		if (perLine) return perLine;
	}
	const whole = resolveAll([stripOuterQuotes(trimmed)], cwd);
	if (whole) return whole;
	const words: string[] = [];
	for (const line of lines) {
		const lineWords = shellWords(line);
		if (!lineWords) return undefined;
		words.push(...lineWords);
	}
	return resolveAll(words, cwd);
}

/** `path` with the home directory shortened to `~`, as the owner would type it. */
export function displayPath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
