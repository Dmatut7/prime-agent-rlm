import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as sessionManagerModule from "../../src/core/session-manager.js";

const { loadEntriesFromFile, readSessionInfo, SessionManager } = sessionManagerModule;

/**
 * The loader documents "skip malformed or blank lines", and the session-list scan
 * parses every line under one catch that turns any throw into "this session does not
 * exist". A line that is valid JSON but the wrong shape - a message entry with no
 * message, a bare `null` - broke both promises: it reached `applyChildUsageAttributions`
 * and `message.role` unprotected, threw a bare TypeError that cost the whole
 * transcript, and in the listing paths disappeared without a diagnostic.
 */

const SESSION_ID = "01badshape-session";

function headerLine(): string {
	return JSON.stringify({
		type: "session",
		version: 3,
		id: SESSION_ID,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/tmp/prime-under-test",
	});
}

const USER_LINE = JSON.stringify({
	type: "message",
	id: "u1",
	parentId: null,
	timestamp: "2026-01-01T00:00:01.000Z",
	message: { role: "user", content: [{ type: "text", text: "the question" }], timestamp: 1 },
});

const ASSISTANT_LINE = JSON.stringify({
	type: "message",
	id: "a1",
	parentId: "u1",
	timestamp: "2026-01-01T00:00:02.000Z",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "the answer" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	},
});

/** Lines that parse as JSON but carry nothing a transcript can index. */
const UNINDEXABLE_SHAPES: Record<string, string> = {
	missing_message_key: JSON.stringify({ type: "message", id: "bad", parentId: null, timestamp: "t" }),
	message_null: JSON.stringify({ type: "message", id: "bad", parentId: null, timestamp: "t", message: null }),
	null_line: "null",
	flat_message: JSON.stringify({
		type: "message",
		id: "bad",
		parentId: null,
		timestamp: "t",
		role: "user",
		content: [{ type: "text", text: "flat" }],
	}),
};

/** Positive controls: JSON values that were never entries either way. */
const CONTROL_SHAPES: Record<string, string> = {
	array_line: "[]",
	number_line: "5",
	string_line: '"x"',
	true_line: "true",
};

const roots: string[] = [];

function transcriptWith(line: string): { file: string; dir: string } {
	const root = mkdtempSync(join(tmpdir(), "prime-bad-shape-"));
	roots.push(root);
	const dir = join(root, "sessions");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${SESSION_ID}.jsonl`);
	writeFileSync(file, `${[headerLine(), USER_LINE, line, ASSISTANT_LINE].join("\n")}\n`);
	return { file, dir };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const cases = [...Object.entries(UNINDEXABLE_SHAPES), ...Object.entries(CONTROL_SHAPES)];
expect(cases).toHaveLength(8);

describe.each(cases)("a transcript with a $null_line-shaped line in it (%s)", (_name, line) => {
	it("keeps every real entry and skips only the unusable line", () => {
		const { file } = transcriptWith(line);
		const entries = loadEntriesFromFile(file);
		expect(entries.map((entry) => entry.type)).toEqual(["session", "message", "message"]);
		expect(entries.map((entry) => entry.id)).toEqual([SESSION_ID, "u1", "a1"]);
	});

	it("still opens as the same session with a readable branch", () => {
		const { file, dir } = transcriptWith(line);
		const manager = SessionManager.open(file, dir);
		expect(manager.getSessionId()).toBe(SESSION_ID);
		expect(manager.getEntries().map((entry) => entry.id)).toEqual(["u1", "a1"]);
		expect(manager.buildSessionContext().messages).toHaveLength(2);
	});

	it("stays visible to the session list, where a throw becomes silence", async () => {
		const { file } = transcriptWith(line);
		const info = await readSessionInfo(file);
		expect(info).not.toBeNull();
		expect(info?.id).toBe(SESSION_ID);
		expect(info?.messageCount).toBe(2);
		expect(info?.firstMessage).toContain("the question");
		// Reading a damaged transcript must not rewrite it.
		expect(readFileSync(file, "utf8")).toContain(line);
	});
});

describe("diagnostics for skipped transcript lines", () => {
	it("names the line it skipped instead of dropping it silently", () => {
		for (const [name, line] of Object.entries(UNINDEXABLE_SHAPES)) {
			sessionManagerModule.clearTranscriptLineSkips();
			const { file } = transcriptWith(line);
			loadEntriesFromFile(file);
			const diagnostics = sessionManagerModule.getTranscriptLineSkips();
			expect(diagnostics, name).toHaveLength(1);
			expect(diagnostics[0]?.sessionFile, name).toBe(file);
			expect(diagnostics[0]?.line, name).toBe(3);
			expect(diagnostics[0]?.reason, name).toBeTruthy();
		}
	});

	it("positive control: leaves no diagnostic for a transcript of real entries", () => {
		sessionManagerModule.clearTranscriptLineSkips();
		const root = mkdtempSync(join(tmpdir(), "prime-clean-transcript-"));
		roots.push(root);
		const dir = join(root, "sessions");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `${SESSION_ID}.jsonl`);
		writeFileSync(file, `${[headerLine(), USER_LINE, ASSISTANT_LINE].join("\n")}\n`);
		loadEntriesFromFile(file);
		expect(sessionManagerModule.getTranscriptLineSkips()).toHaveLength(0);
	});
});
