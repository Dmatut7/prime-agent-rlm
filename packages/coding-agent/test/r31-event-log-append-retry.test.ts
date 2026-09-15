import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/core/event-log.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-r31-elog-red-"));
	tempDirs.push(directory);
	return directory;
}

/**
 * A foreign writer in another process: it appends one record one byte at a
 * time (10ms apart, ~220ms total), terminator last, then exits. Growth a
 * same-process writer cannot show (the sync observation blocks the loop) is
 * exactly what the contended-tail detection has to see.
 */
function startForeignWriter(path: string) {
	const script = join(path, "..", "foreign-writer.mjs");
	writeFileSync(
		script,
		[
			"import { appendFileSync } from 'node:fs';",
			"const [target] = process.argv.slice(2);",
			"const payload = JSON.stringify({ v: 1, op: 'spawn', note: 'yyyyyyyyyy' });",
			"appendFileSync(target, payload.slice(0, 1));",
			"for (const byte of payload.slice(1)) {",
			"  await new Promise((resolve) => setTimeout(resolve, 10));",
			"  appendFileSync(target, byte);",
			"}",
			"appendFileSync(target, '\\n');",
		].join("\n"),
	);
	return spawn(process.execPath, [script, path], { stdio: "ignore" });
}

describe("r31 RC-5 event-log append against a live slow writer", () => {
	it("lands the append after the live writer finishes instead of losing it", async () => {
		const dir = createTempDir();
		const path = join(dir, "ledger.jsonl");
		writeFileSync(path, `${JSON.stringify({ v: 1, op: "meta" })}\n`);

		const writer = startForeignWriter(path);
		const writerExit = new Promise<number | null>((resolve) => writer.on("exit", (code) => resolve(code)));
		// Let the foreign writer put its first bytes down before we append.
		await sleep(30);

		const log = new EventLog(path);
		const record = { v: 1, op: "delete", childId: "child-1" };
		let appendError: unknown;
		try {
			await log.appendAsync([record], { durable: true });
		} catch (error) {
			appendError = error;
		}
		await writerExit;
		expect(appendError).toBeUndefined();

		const text = readFileSync(path, "utf8");
		expect(text).toContain(JSON.stringify(record));
	}, 30_000);
});
