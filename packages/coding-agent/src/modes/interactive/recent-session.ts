import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** The session a fresh start offers to continue. */
export interface RecentSession {
	path: string;
	title: string;
	modified: Date;
}

/** Newest transcripts examined; the rest are never opened, so startup stays cheap. */
const MAX_CANDIDATES = 40;
/** Bytes read from the head of each candidate: the header and the first prompt live there. */
const HEAD_BYTES = 64 * 1024;
const TITLE_MAX_CHARS = 28;

async function readHead(path: string): Promise<string> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text ?? "") : ""))
		.join(" ");
}

function titleFromHead(head: string, cwd: string): string | undefined {
	const lines = head.split("\n");
	let header: { type?: string; cwd?: string; rlmDepth?: number } | undefined;
	try {
		header = JSON.parse(lines[0] ?? "");
	} catch {
		return undefined;
	}
	if (header?.type !== "session" || header.cwd !== cwd || (header.rlmDepth ?? 0) > 0) {
		return undefined;
	}
	let name: string | undefined;
	let firstPrompt: string | undefined;
	for (const line of lines.slice(1)) {
		if (!line.trim()) continue;
		let entry: { type?: string; name?: string; message?: { role?: string; content?: unknown } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "session_info" && entry.name) name = entry.name;
		if (!firstPrompt && entry.type === "message" && entry.message?.role === "user") {
			firstPrompt = userText(entry.message.content).replace(/\s+/g, " ").trim();
		}
	}
	const title = name ?? firstPrompt;
	if (!title) return undefined;
	return title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS - 1)}…` : title;
}

/**
 * The most recently touched top-level session of this directory, other than
 * `excludePath`. Reads only the newest few transcript heads.
 */
export async function findRecentSession(
	sessionDir: string,
	cwd: string,
	excludePath?: string,
): Promise<RecentSession | undefined> {
	let names: string[];
	try {
		names = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return undefined;
	}
	const stamped = await Promise.all(
		names.map(async (name) => {
			const path = join(sessionDir, name);
			try {
				return { path, modified: (await stat(path)).mtime };
			} catch {
				return undefined;
			}
		}),
	);
	const candidates = stamped
		.filter((entry): entry is { path: string; modified: Date } => entry !== undefined && entry.path !== excludePath)
		.sort((a, b) => b.modified.getTime() - a.modified.getTime())
		.slice(0, MAX_CANDIDATES);
	for (const candidate of candidates) {
		try {
			const title = titleFromHead(await readHead(candidate.path), cwd);
			if (title) return { ...candidate, title };
		} catch {
			// An unreadable transcript is skipped, not fatal.
		}
	}
	return undefined;
}

/** `刚刚`, `12 分钟前`, `3 小时前`, `2 天前`. */
export function formatAgo(date: Date, now = Date.now()): string {
	const minutes = Math.floor(Math.max(0, now - date.getTime()) / 60_000);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	return `${Math.floor(hours / 24)} 天前`;
}
