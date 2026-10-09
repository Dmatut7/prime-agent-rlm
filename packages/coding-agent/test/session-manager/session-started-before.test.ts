import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMostRecentSessionForCwd } from "../../src/core/session-manager.js";

function sessionId(tag: string): string {
	return `01a0bf40${tag.padEnd(8, "0")}80009000a000b0c0`;
}

function writeSessionFile(sessionDir: string, id: string, cwd: string, timestamp: string | undefined): string {
	const header: Record<string, unknown> = {
		type: "session",
		version: 3,
		id,
		cwd,
	};
	if (timestamp !== undefined) {
		header.timestamp = timestamp;
	}
	const file = join(sessionDir, `${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify(header)}\n`);
	return file;
}

/**
 * The trust gate's grandfather evidence must only count sessions that started
 * before the gate landed on the machine (the store's pinned createdAt). A
 * session created after the gate - including the one a --resume run is itself
 * reopening - proves nothing about pre-gate use, yet the unbounded lookup
 * trusted it, flipping a session-only refusal into permanent trust.
 */
describe("findMostRecentSessionForCwd startedBefore bound", () => {
	let tempDir: string;
	let sessionDir: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-started-before-"));
		sessionDir = join(tempDir, "sessions");
		projectDir = join(tempDir, "project");
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(projectDir);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("counts a session whose header timestamp predates the bound", () => {
		const gateLandedAt = Date.parse("2026-09-01T00:00:00Z");
		const file = writeSessionFile(sessionDir, sessionId("pre"), projectDir, "2026-08-30T12:00:00Z");

		expect(findMostRecentSessionForCwd(sessionDir, projectDir, { startedBefore: gateLandedAt })).toBe(file);
	});

	it("ignores a session that started after the bound", () => {
		const gateLandedAt = Date.parse("2026-09-01T00:00:00Z");
		writeSessionFile(sessionDir, sessionId("post"), projectDir, "2026-09-02T00:00:00Z");

		expect(findMostRecentSessionForCwd(sessionDir, projectDir, { startedBefore: gateLandedAt })).toBeNull();
	});

	it("ignores a session started exactly at the bound: the boundary belongs to the closed side", () => {
		const gateLandedAt = Date.parse("2026-09-01T00:00:00Z");
		writeSessionFile(sessionDir, sessionId("edge"), projectDir, "2026-09-01T00:00:00Z");

		expect(findMostRecentSessionForCwd(sessionDir, projectDir, { startedBefore: gateLandedAt })).toBeNull();
	});

	it("fails closed for a session whose header timestamp is missing or unparsable", () => {
		const gateLandedAt = Date.parse("2026-09-01T00:00:00Z");
		writeSessionFile(sessionDir, sessionId("none"), projectDir, undefined);
		writeSessionFile(sessionDir, sessionId("junk"), projectDir, "not-a-timestamp");

		expect(findMostRecentSessionForCwd(sessionDir, projectDir, { startedBefore: gateLandedAt })).toBeNull();
	});

	it("prefers the newest session that satisfies the bound, not the newest overall", () => {
		const gateLandedAt = Date.parse("2026-09-01T00:00:00Z");
		const pre = writeSessionFile(sessionDir, sessionId("pr1"), projectDir, "2026-08-01T00:00:00Z");
		writeSessionFile(sessionDir, sessionId("po1"), projectDir, "2026-09-05T00:00:00Z");

		expect(findMostRecentSessionForCwd(sessionDir, projectDir, { startedBefore: gateLandedAt })).toBe(pre);
	});

	it("keeps the unbounded behavior when no bound is given", () => {
		writeSessionFile(sessionDir, sessionId("any"), projectDir, "2026-09-05T00:00:00Z");

		expect(findMostRecentSessionForCwd(sessionDir, projectDir)).not.toBeNull();
	});
});
