import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, repairOwnedSessionFile } from "../../src/core/session-manager.js";

/**
 * K3P-4 (round-30 K3 review F4): `completeTrailingRecordNewline` only looked at
 * the last 64 KiB of the file, so a complete trailing record longer than that
 * (a big tool result, a base64 image) never had its newline restored - instead
 * the torn-tail repair truncated the whole intact record away.
 */

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sessionDir(): string {
	const root = mkdtempSync(join(tmpdir(), "prime-k3p4-"));
	roots.push(root);
	const dir = join(root, "sessions");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function headerLine(dir: string): string {
	return JSON.stringify({
		type: "session",
		version: 3,
		id: "01k3p4-oversize-tail",
		timestamp: new Date(0).toISOString(),
		cwd: dir,
	});
}

/** A complete message record of roughly `bytes` bytes on a single line. */
function messageLine(bytes: number): string {
	const filler = "x".repeat(Math.max(0, bytes - 200));
	return JSON.stringify({
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: { role: "user", content: filler, timestamp: 1 },
	});
}

describe("a complete trailing record longer than the 64 KiB scan window", () => {
	it("survives repairOwnedSessionFile and stays readable", () => {
		const dir = sessionDir();
		const entry = messageLine(200 * 1024);
		expect(Buffer.byteLength(entry)).toBeGreaterThan(64 * 1024);
		const file = join(dir, "oversize-tail.jsonl");
		// A complete record whose terminating newline was torn off.
		writeFileSync(file, `${headerLine(dir)}\n${entry}`);

		repairOwnedSessionFile(file);

		// The record is still on disk, still readable, and got its newline back.
		expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
		expect(readFileSync(file, "utf8")).toContain(entry);
		const entries = loadEntriesFromFile(file);
		expect(entries.filter((entry) => entry.type === "message")).toHaveLength(1);
	});

	it("control: a complete trailing record inside the 64 KiB window still gets its newline back", () => {
		const dir = sessionDir();
		const entry = messageLine(10 * 1024);
		expect(Buffer.byteLength(entry)).toBeLessThanOrEqual(64 * 1024);
		const file = join(dir, "window-tail.jsonl");
		writeFileSync(file, `${headerLine(dir)}\n${entry}`);

		repairOwnedSessionFile(file);

		expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
		expect(readFileSync(file, "utf8")).toContain(entry);
		expect(loadEntriesFromFile(file).filter((entry) => entry.type === "message")).toHaveLength(1);
	});

	it("control: a genuinely torn oversize tail is still dropped", () => {
		const dir = sessionDir();
		const entry = messageLine(200 * 1024);
		const file = join(dir, "oversize-torn.jsonl");
		// Half a record, no newline: nothing can save the partial line.
		writeFileSync(file, `${headerLine(dir)}\n${entry.slice(0, Math.floor(entry.length / 2))}`);

		repairOwnedSessionFile(file);

		const after = readFileSync(file, "utf8");
		expect(after).toBe(`${headerLine(dir)}\n`);
		expect(loadEntriesFromFile(file).filter((entry) => entry.type === "message")).toHaveLength(0);
	});
});
