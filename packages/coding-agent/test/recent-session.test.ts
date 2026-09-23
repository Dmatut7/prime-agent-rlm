import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRecentSession, formatAgo } from "../src/modes/interactive/recent-session.js";

function transcript(cwd: string, prompt: string | undefined, extra: object[] = [], rlmDepth = 0): string {
	const lines: object[] = [{ type: "session", version: 3, id: "x", timestamp: "2026-09-24T00:00:00Z", cwd, rlmDepth }];
	if (prompt !== undefined) {
		lines.push({ type: "message", id: "m1", parentId: null, message: { role: "user", content: prompt } });
	}
	lines.push(...extra);
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

describe("findRecentSession", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function sessionDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "recent-session-"));
		dirs.push(dir);
		return dir;
	}

	function write(dir: string, name: string, body: string, mtimeSeconds: number): string {
		const path = join(dir, name);
		writeFileSync(path, body);
		utimesSync(path, mtimeSeconds, mtimeSeconds);
		return path;
	}

	it("picks the newest top-level session of this directory with a prompt", async () => {
		const dir = sessionDir();
		write(dir, "a.jsonl", transcript("/work", "older task"), 1_000);
		write(dir, "b.jsonl", transcript("/work", "fix the footer numbers"), 2_000);
		write(dir, "c.jsonl", transcript("/elsewhere", "other project"), 3_000);
		write(dir, "d.jsonl", transcript("/work", "child work", [], 1), 4_000);
		write(dir, "e.jsonl", transcript("/work", undefined), 5_000);
		const recent = await findRecentSession(dir, "/work");
		expect(recent?.title).toBe("fix the footer numbers");
		expect(recent?.modified.getTime()).toBe(2_000_000);
	});

	it("prefers the session name, truncates long titles, and skips the excluded file", async () => {
		const dir = sessionDir();
		write(dir, "a.jsonl", transcript("/work", "x".repeat(60)), 1_000);
		const named = write(
			dir,
			"b.jsonl",
			transcript("/work", "prompt", [{ type: "session_info", name: "统一上下文数字" }]),
			2_000,
		);
		expect((await findRecentSession(dir, "/work"))?.title).toBe("统一上下文数字");
		const fallback = await findRecentSession(dir, "/work", named);
		expect(fallback?.title).toHaveLength(28);
		expect(fallback?.title.endsWith("…")).toBe(true);
	});

	it("is undefined for a missing directory", async () => {
		expect(await findRecentSession(join(tmpdir(), "does-not-exist-recent-session"), "/work")).toBeUndefined();
	});
});

describe("formatAgo", () => {
	it("reads in minutes, hours and days", () => {
		const now = 10 * 24 * 3_600_000;
		expect(formatAgo(new Date(now - 10_000), now)).toBe("刚刚");
		expect(formatAgo(new Date(now - 12 * 60_000), now)).toBe("12 分钟前");
		expect(formatAgo(new Date(now - 3 * 3_600_000), now)).toBe("3 小时前");
		expect(formatAgo(new Date(now - 2 * 24 * 3_600_000), now)).toBe("2 天前");
	});
});
