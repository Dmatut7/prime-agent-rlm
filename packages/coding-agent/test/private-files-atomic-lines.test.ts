import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePrivateFileAtomicLines } from "../src/utils/private-files.js";

describe("writePrivateFileAtomicLines", () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory) {
			rmSync(directory, { recursive: true, force: true });
			directory = undefined;
		}
	});

	function tempDir(): string {
		directory = mkdtempSync(join(tmpdir(), "pi-private-lines-"));
		return directory;
	}

	it("writes every line exactly once across batch boundaries", () => {
		const path = join(tempDir(), "session.jsonl");
		// Callers pass a per-entry generator, so this crosses several write batches and
		// stops part-way through the last one: both the flush path and the trailing
		// partial batch have to land.
		const lineCount = 4000;
		function* lines(): Iterable<string> {
			for (let i = 0; i < lineCount; i++) {
				yield `${JSON.stringify({ i, pad: "x".repeat(40) })}\n`;
			}
		}

		writePrivateFileAtomicLines(path, lines());

		const written = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
		expect(written).toHaveLength(lineCount);
		expect(JSON.parse(written[0]).i).toBe(0);
		expect(JSON.parse(written[lineCount - 1]).i).toBe(lineCount - 1);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("leaves no temp file behind and writes an empty iterable as an empty file", () => {
		const dir = tempDir();
		const path = join(dir, "empty.jsonl");

		writePrivateFileAtomicLines(path, []);

		expect(readFileSync(path, "utf8")).toBe("");
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});
