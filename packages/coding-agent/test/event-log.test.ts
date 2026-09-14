import { spawn } from "node:child_process";
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

	it("refuses the append instead of blanking a tail that keeps being appended", async () => {
		const path = join(dir, "log.jsonl");
		// Default quiescence window: the observation budget is a few windows, far
		// shorter than the writer below keeps its tail growing.
		const log = new EventLog(path);
		log.appendSync([{ v: 1, before: true }]);

		const writer = spawnChurningWriter(path);
		try {
			await waitForTornTail(path);
			// A tail that is still growing is a live writer's record: destroying its
			// bytes would poison the log, so the append is refused instead.
			expect(() => log.appendSync([{ v: 9, ours: true }])).toThrow(/still being appended/);
		} finally {
			await waitForExit(writer);
		}

		// The refusal wrote nothing, so the writer's record completed and the retry
		// lands after a whole line.
		log.appendSync([{ v: 9, ours: true }]);
		expect(new EventLog(path).replaySync((line) => JSON.parse(line))).toEqual([
			{ v: 1, before: true },
			{ v: 7, pad: `${"p".repeat(30)}tail` },
			{ v: 9, ours: true },
		]);
	});

	it("does not destroy a record a live writer is still appending in several writes", async () => {
		const path = join(dir, "log.jsonl");
		// A wide quiescence window so the writer's pause between its two writes is
		// inside the observation, and the fix's outcome is not a timing race.
		const log = new EventLog(path, { tailQuiescenceMs: 200 });
		log.appendSync([{ v: 1, before: true }]);

		const writer = spawnAppendingWriter(path);
		try {
			await waitForTornTail(path);
			// The repair runs while the writer is between two writes of ONE record.
			log.appendSync([{ v: 9, ours: true }]);
		} finally {
			await waitForExit(writer);
		}

		const records = new EventLog(path).replaySync((line) => ({
			value: JSON.parse(line) as Record<string, unknown>,
		}));
		const values = records.map((record) => record.value);
		// The writer's split record survives as one record: its first write was never
		// blanked, so the second one completed it instead of leaving "spaces+half a
		// record" as a malformed interior line that fails the whole replay closed.
		expect(values).toContainEqual({ v: 7, pad: "tail" });
		expect(values).toContainEqual({ v: 8, after: true });
		expect(values).toContainEqual({ v: 9, ours: true });
	});
});

/**
 * Keep one record's tail torn and growing for longer than the repair's observation
 * budget, then complete the record. A writer that never lets the tail settle.
 */
function spawnChurningWriter(path: string) {
	const script = [
		'const fs = require("node:fs");',
		"const path = process.env.PRIME_TEST_EVENT_LOG;",
		'fs.appendFileSync(path, \'{"v":7,"pad":"\');',
		"let written = 0;",
		"const timer = setInterval(() => {",
		"\twritten += 1;",
		"\tif (written <= 30) {",
		'\t\tfs.appendFileSync(path, "p");',
		"\t\treturn;",
		"\t}",
		"\tclearInterval(timer);",
		"\tfs.appendFileSync(path, 'tail\"}');",
		'\tfs.appendFileSync(path, "\\n");',
		"}, 10);",
	].join("\n");
	return spawn(process.execPath, ["-e", script], {
		env: { ...process.env, PRIME_TEST_EVENT_LOG: path },
		stdio: "ignore",
	});
}

/**
 * Append one record in two writes with a pause in between, then a complete record.
 *
 * This is the shape a foreign appender (or an append split by a short write)
 * leaves behind: a tail that is mid-record rather than dead while a repair looks
 * at it.
 */
function spawnAppendingWriter(path: string) {
	const script = [
		'const fs = require("node:fs");',
		"const path = process.env.PRIME_TEST_EVENT_LOG;",
		'fs.appendFileSync(path, \'{"v":7,"pad":"ta\');',
		"setTimeout(() => {",
		"\tfs.appendFileSync(path, 'il\"}');",
		'\tfs.appendFileSync(path, "\\n");',
		'\tfs.appendFileSync(path, JSON.stringify({ v: 8, after: true }) + "\\n");',
		"}, 40);",
	].join("\n");
	return spawn(process.execPath, ["-e", script], {
		env: { ...process.env, PRIME_TEST_EVENT_LOG: path },
		stdio: "ignore",
	});
}

/** Resolve once the file's last byte is not a newline: a writer's fragment is on disk. */
async function waitForTornTail(path: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const contents = readFileSync(path);
		if (contents.length > 0 && contents[contents.length - 1] !== 0x0a) return;
		if (Date.now() > deadline) throw new Error("writer did not leave a torn tail in time");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", () => resolve());
	});
}
