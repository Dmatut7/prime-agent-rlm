import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMostRecentSessionForCwd } from "../../src/core/session-manager.js";

function sessionId(tag: string): string {
	return `01a0bf40${tag.padEnd(8, "0")}80009000a000b0c0`;
}

function writeSessionFile(sessionDir: string, id: string, cwd: string): string {
	const header = {
		type: "session",
		version: 3,
		id,
		timestamp: "2026-01-01T00:00:00Z",
		cwd,
	};
	const file = join(sessionDir, `${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify(header)}\n`);
	return file;
}

/**
 * The trust gate's grandfather evidence (hasPriorSession) compares the session
 * header cwd with the live process cwd. The trust store keys by realpath, so a
 * directory entered through a symlink must still match the header recorded
 * under another spelling of the same directory - otherwise an unattended
 * upgrade silently holds the extensions back.
 */
describe("findMostRecentSessionForCwd symlink spelling", () => {
	let tempDir: string;
	let sessionDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-cwd-canonical-"));
		sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("matches a header recorded from the physical path when queried through a symlink", () => {
		const projectDir = join(tempDir, "project");
		mkdirSync(projectDir);
		const linkDir = join(tempDir, "link");
		symlinkSync(projectDir, linkDir);

		const file = writeSessionFile(sessionDir, sessionId("phys"), projectDir);

		expect(findMostRecentSessionForCwd(sessionDir, linkDir)).toBe(file);
	});

	it("matches a header recorded through a symlink when queried with the physical path", () => {
		const projectDir = join(tempDir, "project");
		mkdirSync(projectDir);
		const linkDir = join(tempDir, "link");
		symlinkSync(projectDir, linkDir);

		const file = writeSessionFile(sessionDir, sessionId("link"), linkDir);

		expect(findMostRecentSessionForCwd(sessionDir, projectDir)).toBe(file);
	});

	it("still matches the identical spelling it matched before canonicalization", () => {
		const projectDir = join(tempDir, "project");
		mkdirSync(projectDir);

		const file = writeSessionFile(sessionDir, sessionId("same"), projectDir);

		expect(findMostRecentSessionForCwd(sessionDir, projectDir)).toBe(file);
	});

	it("does not match a different directory", () => {
		const projectDir = join(tempDir, "project");
		const otherDir = join(tempDir, "other");
		mkdirSync(projectDir);
		mkdirSync(otherDir);

		writeSessionFile(sessionDir, sessionId("diff"), otherDir);

		expect(findMostRecentSessionForCwd(sessionDir, projectDir)).toBeNull();
	});
});
