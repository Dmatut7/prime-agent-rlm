import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/core/event-log.js";

describe("event log substrate", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-event-log-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("throws for an unserializable event before any byte reaches the log", () => {
		const log = new EventLog(join(dir, "log.jsonl"));
		log.appendSync([{ ok: 1 }]);
		const before = readFileSync(log.path, "utf8");
		expect(() => log.appendSync([{ ok: 2 }, undefined])).toThrow(TypeError);
		expect(readFileSync(log.path, "utf8")).toBe(before);
	});

	it("drops an unterminated tail even when it parses as JSON, keeping strict replays clean", () => {
		const path = join(dir, "log.jsonl");
		const log = new EventLog(path);
		log.appendSync([{ v: 1, keep: true }]);
		// A newline-completion here would hand this line to strict parsers as
		// permanent fail-closed interior poison; neutralizing it must win.
		writeFileSync(path, `${readFileSync(path, "utf8")}{"not":"a valid record"}`);
		log.appendSync([{ v: 1, second: true }]);
		const strict = new EventLog(path).replaySync((line, index) => {
			const value = JSON.parse(line) as { v?: number };
			if (value.v !== 1) throw new Error(`invalid record on line ${index + 1}`);
			return value;
		});
		expect(strict).toEqual([
			{ v: 1, keep: true },
			{ v: 1, second: true },
		]);
	});

	it("neutralizes an unterminated tail without deleting bytes a concurrent writer could own", () => {
		const path = join(dir, "log.jsonl");
		const log = new EventLog(path);
		log.appendSync([{ v: 1, keep: true }]);
		const intact = readFileSync(path);
		const fragment = '{"v":1,"op":"spa';
		writeFileSync(path, Buffer.concat([intact, Buffer.from(fragment)]));
		log.appendSync([{ v: 1, second: true }]);
		// Every append lands at or above the EOF, so a repair that removes bytes
		// below it removes whatever another process appended inside its window.
		// The repair must not shorten the log; it blanks the fragment in place.
		const after = readFileSync(path);
		const appended = Buffer.byteLength(`${JSON.stringify({ v: 1, second: true })}\n`);
		expect(after.length).toBe(intact.length + fragment.length + appended);
		expect(
			after.subarray(intact.length, intact.length + fragment.length).equals(Buffer.alloc(fragment.length, 0x20)),
		).toBe(true);
		expect(new EventLog(path).replaySync((line) => JSON.parse(line))).toEqual([
			{ v: 1, keep: true },
			{ v: 1, second: true },
		]);
	});

	it("fails closed on an oversized log through the descriptor without a full allocation", () => {
		const path = join(dir, "log.jsonl");
		writeFileSync(path, `${"x".repeat(64)}\n`.repeat(4));
		const log = new EventLog(path, { maxBytes: 100 });
		expect(() => log.replaySync((line) => line)).toThrow("bytes");
		expect(() => log.appendSync([{ v: 1 }])).toThrow("bytes");
	});
});
