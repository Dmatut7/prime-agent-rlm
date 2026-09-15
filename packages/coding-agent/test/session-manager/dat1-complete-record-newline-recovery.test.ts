import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, repairOwnedSessionFile, SessionManager } from "../../src/core/session-manager.js";

/**
 * DAT-1: a complete record whose write lost only the terminating newline is not a
 * torn line. The header case already gets its byte back (unterminated-header-identity);
 * a non-header tail (a message, a session_info) used to be dropped by every loader and
 * then ftruncated away by repairOwnedSessionFile, silently losing a whole record.
 */

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sessionDir(): string {
	const root = mkdtempSync(join(tmpdir(), "prime-dat1-"));
	roots.push(root);
	const dir = join(root, "sessions");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeFile(dir: string, content: string): string {
	const file = join(dir, "01dat1-newline-recovery.jsonl");
	writeFileSync(file, content);
	return file;
}

function headerLine(dir: string): string {
	return JSON.stringify({
		type: "session",
		version: 3,
		id: "01dat1-newline-recovery",
		timestamp: new Date().toISOString(),
		cwd: dir,
	});
}

function infoLine(id: string, name: string): string {
	return JSON.stringify({
		type: "session_info",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		name,
	});
}

describe("a complete non-header record that lost only its newline", () => {
	it("survives repairOwnedSessionFile and stays readable", () => {
		const dir = sessionDir();
		const file = writeFile(
			dir,
			`${[headerLine(dir), infoLine("info-1", "first")].join("\n") + "\n" + infoLine("info-2", "second")}`,
		);

		repairOwnedSessionFile(file);

		// The record is readable: the newline came back, the entry was not truncated.
		const entries = loadEntriesFromFile(file);
		const names = entries.filter((entry) => entry.type === "session_info").map((entry) => entry.name);
		expect(names).toEqual(["first", "second"]);
		expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
	});

	it("survives a write-owning SessionManager.open (setSessionFile persist path)", () => {
		const dir = sessionDir();
		const file = writeFile(
			dir,
			`${[headerLine(dir), infoLine("info-1", "first")].join("\n") + "\n" + infoLine("info-2", "second")}`,
		);

		// The write-owning open restores the terminator before anything can append
		// onto the record; a reload therefore reads it back instead of losing it.
		SessionManager.open(file, dir);

		expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
		const entries = loadEntriesFromFile(file);
		const names = entries.filter((entry) => entry.type === "session_info").map((entry) => entry.name);
		expect(names).toEqual(["first", "second"]);
	});

	it("control: a genuinely torn tail is still dropped, not restored", () => {
		const dir = sessionDir();
		const torn = '{"type":"session_info","id":"info-torn","nam';
		const file = writeFile(dir, `${[headerLine(dir), infoLine("info-1", "first")].join("\n") + "\n" + torn}`);

		repairOwnedSessionFile(file);

		const entries = loadEntriesFromFile(file);
		expect(entries.filter((entry) => entry.type === "session_info")).toHaveLength(1);
		expect(readFileSync(file, "utf8")).not.toContain("info-torn");
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});
});
