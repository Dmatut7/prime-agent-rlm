import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearTranscriptLineSkips,
	findMostRecentSession,
	findMostRecentSessionForCwd,
	getTranscriptLineSkips,
	loadEntriesFromFile,
	SessionManager,
} from "../../src/core/session-manager.js";
import { FirstLineTooLongError, MAX_FIRST_LINE_BYTES, readFirstLineSync } from "../../src/utils/file-lines.js";

const OLD_PROBE_BYTES = 64 * 1024;

function sessionId(tag: string): string {
	return `01a0bf40${tag.padEnd(8, "0")}80009000a000b0c0`;
}

function writeHeaderFile(dir: string, id: string, padding: number): { file: string; headerBytes: number } {
	const header = {
		type: "session",
		version: 3,
		id,
		timestamp: "2026-01-01T00:00:00Z",
		cwd: dir,
		// A header field no realistic session writes, but one JSON preserves: the point
		// is the line's length, not the field.
		note: "x".repeat(padding),
	};
	const file = join(dir, `${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify(header)}\n`);
	return { file, headerBytes: Buffer.byteLength(JSON.stringify(header)) };
}

describe("first-line boundary", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `first-line-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		clearTranscriptLineSkips();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		clearTranscriptLineSkips();
	});

	it("reads a header line past the old 64 KiB probe instead of returning a prefix", () => {
		const { file, headerBytes } = writeHeaderFile(tempDir, sessionId("a"), OLD_PROBE_BYTES + 4 * 1024);
		expect(headerBytes, "the fixture must exceed the old probe").toBeGreaterThan(OLD_PROBE_BYTES);

		const firstLine = readFirstLineSync(file);
		expect(firstLine?.length).toBeGreaterThan(OLD_PROBE_BYTES);
		expect(Buffer.byteLength(firstLine!)).toBe(headerBytes);
		expect(JSON.parse(firstLine!)?.type).toBe("session");
	});

	it("keeps a session whose header exceeds the old probe visible to the listing and to -c", () => {
		const { file } = writeHeaderFile(tempDir, sessionId("b"), OLD_PROBE_BYTES + 4 * 1024);

		expect(findMostRecentSession(tempDir)).toBe(file);
		expect(findMostRecentSessionForCwd(tempDir, tempDir)).toBe(file);
		expect(SessionManager.open(file).getSessionId()).toBe(sessionId("b"));
		expect(loadEntriesFromFile(file)[0]?.type).toBe("session");
		expect(getTranscriptLineSkips()).toEqual([]);
	});

	it("throws a named error for a first line with no newline inside the ceiling", () => {
		expect(MAX_FIRST_LINE_BYTES, "the read must tolerate headers past the old probe").toBeGreaterThan(
			OLD_PROBE_BYTES,
		);
		const { file, headerBytes } = writeHeaderFile(tempDir, sessionId("c"), MAX_FIRST_LINE_BYTES + 4096);

		// The old shape returned the first 64 KiB and let the caller parse a record that
		// is intact on disk; a prefix is not a line and must not be handed back as one.
		let thrown: unknown;
		try {
			readFirstLineSync(file);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(FirstLineTooLongError);
		expect((thrown as FirstLineTooLongError).filePath).toBe(file);
		expect((thrown as FirstLineTooLongError).maxBytes).toBe(MAX_FIRST_LINE_BYTES);
		expect(headerBytes).toBeGreaterThan(MAX_FIRST_LINE_BYTES);
	});

	it("records a diagnostic when an unreadable header keeps a session out of the listing", () => {
		expect(Number.isFinite(MAX_FIRST_LINE_BYTES), "the ceiling must be a real byte count").toBe(true);
		const { file } = writeHeaderFile(tempDir, sessionId("d"), MAX_FIRST_LINE_BYTES + 4096);

		// Nothing can be done with a line this long, but the session must not vanish
		// without a trace.
		expect(findMostRecentSession(tempDir)).toBeNull();
		const skips = getTranscriptLineSkips();
		expect(skips).toHaveLength(1);
		expect(skips[0]?.sessionFile).toBe(file);
		expect(skips[0]?.reason).toContain("no newline");
	});

	it("still returns an unterminated first line as-is and undefined for an empty file", () => {
		const unterminated = join(tempDir, "01a0bf400000700080009000a000b0c1.jsonl");
		writeFileSync(unterminated, JSON.stringify({ type: "session", id: sessionId("e") }));
		expect(JSON.parse(readFirstLineSync(unterminated)!).id).toBe(sessionId("e"));

		const empty = join(tempDir, "01a0bf400000700080009000a000b0c2.jsonl");
		writeFileSync(empty, "");
		expect(readFirstLineSync(empty)).toBeUndefined();
	});
});
