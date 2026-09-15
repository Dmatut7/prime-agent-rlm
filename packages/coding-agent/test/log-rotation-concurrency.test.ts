import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { appendRotatingLog } from "../src/config.js";

/**
 * The shared log is written by the daemon, its workers and its clients at the same time,
 * and a writer that finds the size cap crossed rotates the file. Unserialized, the writers
 * that find the cap crossed at the same moment delete the generation another of them just
 * rotated out (`rm <log>.old` of a fresh rotation), so the whole rotated file is lost.
 *
 * The race is a file-level interleaving, so the writers here are real processes running the
 * real function. They are also aligned: the log is pre-filled to just under the cap, and
 * every writer starts appending at the same wall-clock moment, which is what makes several
 * of them find the cap crossed together instead of one at a time.
 */
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const configSourcePath = fileURLToPath(new URL("../src/config.ts", import.meta.url));

const WRITERS = 8;
const LINES_PER_WRITER = 5;
const PAD = "x".repeat(976);
const MAX_BYTES = 200_000;
const LINE_BYTES = JSON.stringify({ w: 7, seq: 4, pad: PAD }).length + 1;

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Line {
	w: number;
	seq: number;
}

function readLines(path: string): Line[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Line);
}

describe("writers rotating one shared log", () => {
	it("keeps every line and rotates at a single boundary", async () => {
		const dir = mkdtempSync(join(tmpdir(), "log-rotation-"));
		tempDirs.push(dir);
		const logPath = join(dir, "agent.jsonl");

		// Pre-fill to just under the cap through the same entry point the writers use.
		while (statSyncOrZero(logPath) + LINE_BYTES <= MAX_BYTES) {
			appendRotatingLog(logPath, JSON.stringify({ w: -1, seq: -1, pad: PAD }), MAX_BYTES);
		}
		const prefillLines = readLines(logPath).length;

		const scriptPath = join(dir, "writer.mjs");
		writeFileSync(
			scriptPath,
			[
				`import { appendRotatingLog } from ${JSON.stringify(configSourcePath)};`,
				"const [logPath, writerId, lineCount, maxBytes, startAt] = process.argv.slice(2);",
				"const waitBuffer = new Int32Array(new SharedArrayBuffer(4));",
				"while (Date.now() < Number(startAt)) Atomics.wait(waitBuffer, 0, 0, 1);",
				"for (let seq = 0; seq < Number(lineCount); seq++) {",
				"\tappendRotatingLog(logPath, JSON.stringify({ w: Number(writerId), seq, pad: 'x'.repeat(976) }), Number(maxBytes));",
				"}",
				"",
			].join("\n"),
		);
		const startAt = Date.now() + 2000;
		const runs = Array.from({ length: WRITERS }, (_, writerId) => {
			const child = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					scriptPath,
					logPath,
					String(writerId),
					String(LINES_PER_WRITER),
					String(MAX_BYTES),
					String(startAt),
				],
				{ cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
			);
			const stderr: Buffer[] = [];
			child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
			return new Promise<void>((resolve, reject) => {
				child.on("exit", (code) => {
					if (code !== 0) {
						reject(new Error(`writer ${writerId} exited with ${code}: ${Buffer.concat(stderr).toString()}`));
						return;
					}
					resolve();
				});
			});
		});
		await Promise.all(runs);

		// Positive control: the writers crossed the cap, so a rotation did happen.
		const current = readLines(logPath);
		const rotated = readLines(`${logPath}.old`);
		expect(prefillLines).toBeGreaterThan(0);
		expect(current.length).toBeGreaterThan(0);
		expect(rotated.length).toBeGreaterThan(0);

		// 1. No line lost, none duplicated, none torn (every line parsed above).
		const written = [...rotated, ...current].filter((line) => line.w >= 0);
		const ids = written.map((line) => `${line.w}:${line.seq}`);
		expect(ids.length).toBe(WRITERS * LINES_PER_WRITER);
		expect(new Set(ids).size).toBe(WRITERS * LINES_PER_WRITER);

		// 2. No writer split across the rotation: the rotated file is a prefix and the
		//    live file a suffix of that writer's own sequence.
		for (let writer = 0; writer < WRITERS; writer++) {
			const sequence = [...rotated, ...current].filter((line) => line.w === writer).map((line) => line.seq);
			expect(sequence.length).toBe(LINES_PER_WRITER);
			expect(sequence).toEqual([...sequence].sort((left, right) => left - right));
		}
	});
});

function statSyncOrZero(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}
