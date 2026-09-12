import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repairOwnedSessionFile } from "../../src/core/session-manager.js";

// The tail repair exists to keep a clean open off any whole-file scan, so these
// tests count the reads it performs instead of inferring the cost from timing.
const calls = vi.hoisted(() => ({
	wholeFileReads: [] as string[],
	positionalBytes: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const readFileSync = ((...args: unknown[]) => {
		calls.wholeFileReads.push(String(args[0]));
		return (actual.readFileSync as unknown as (...readArgs: unknown[]) => unknown)(...args);
	}) as typeof actual.readFileSync;
	const readSync = ((...args: unknown[]) => {
		const read = (actual.readSync as unknown as (...readArgs: unknown[]) => number)(...args);
		calls.positionalBytes += read;
		return read;
	}) as typeof actual.readSync;
	return { ...actual, readFileSync, readSync };
});

const REPAIR_SUSPICION_WINDOW_BYTES = 1024 * 1024;

describe("tail repair with a final line larger than its scan window", () => {
	const roots: string[] = [];

	beforeEach(() => {
		calls.wholeFileReads = [];
		calls.positionalBytes = 0;
	});

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createFile(name: string, content: string | Buffer): string {
		const root = mkdtempSync(join(tmpdir(), "prime-large-tail-"));
		roots.push(root);
		const path = join(root, name);
		writeFileSync(path, content);
		calls.wholeFileReads = [];
		calls.positionalBytes = 0;
		return path;
	}

	// ~6MB of ordinary entries so a whole-file re-read is unmistakably larger
	// than the tail the gate is allowed to touch.
	function bodyLines(count: number, fillChars: number): string[] {
		const lines: string[] = [];
		for (let i = 0; i < count; i++) {
			lines.push(JSON.stringify({ type: "session_info", id: `info-${i}`, name: "x".repeat(fillChars) }));
		}
		return lines;
	}

	function keptBody(count: number): string {
		return bodyLines(count, 10)
			.map((line) => `${line}\n`)
			.join("");
	}

	it("does not re-read an intact transcript whose final entry exceeds the window", () => {
		const bigEntry = JSON.stringify({
			type: "message",
			id: "big-final",
			name: "y".repeat(2 * 1024 * 1024),
		});
		const content = `${[...bodyLines(600, 10_000), bigEntry].join("\n")}\n`;
		const path = createFile("intact.jsonl", content);
		expect(content.length).toBeGreaterThan(6 * 1024 * 1024);
		expect(bigEntry.length).toBeGreaterThan(REPAIR_SUSPICION_WINDOW_BYTES);

		repairOwnedSessionFile(path);

		// A newline-terminated tail needs no repair: judged from the final byte
		// alone, no whole-file read, no rewrite, and almost nothing read.
		expect(calls.wholeFileReads).toEqual([]);
		expect(calls.positionalBytes).toBeLessThan(content.length);
		expect(readFileSync(path, "utf8")).toBe(content);
	});

	it("still drops a torn final entry that exceeds the window", () => {
		const torn = `{"type":"message","id":"big-torn","name":"${"y".repeat(2 * 1024 * 1024)}`;
		const content = `${keptBody(2)}${torn}`;
		const path = createFile("torn.jsonl", content);
		expect(torn.length).toBeGreaterThan(REPAIR_SUSPICION_WINDOW_BYTES);

		repairOwnedSessionFile(path);

		// The repair walks the tail backwards in bounded chunks and truncates the
		// unterminated entry: no whole-file read, and the kept body survives.
		expect(calls.wholeFileReads).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe(keptBody(2));
	});
});
