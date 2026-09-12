import { randomBytes } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.js";
import type { BashOperations } from "../src/core/tools/bash.js";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.js";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.js";

const made: string[] = [];

afterEach(() => {
	while (made.length > 0) {
		const path = made.pop();
		if (path) rmSync(path, { force: true });
	}
});

function operationsThat(emit: (onData: (chunk: Buffer) => void) => void, exitCode: number | null = 0): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			emit(onData);
			return { exitCode };
		},
	};
}

/** Output past both truncation thresholds (bytes and lines), so a temp file is required. */
function fillerBytes(): Buffer {
	const line = `${randomBytes(8).toString("hex")}\n`;
	return Buffer.from(line.repeat(Math.ceil((DEFAULT_MAX_BYTES + 4096) / line.length)), "utf-8");
}

function emitFiller(onData: (chunk: Buffer) => void): void {
	onData(fillerBytes());
}

/** createWriteStream opens asynchronously, so the file appears a tick after the path is known. */
async function modeOfOncePresent(path: string): Promise<number> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			return statSync(path).mode & 0o777;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
	throw new Error(`temp output file never appeared: ${path}`);
}

describe("bash executor full-output temp file", () => {
	it("is private to the owner, like every other artifact the agent writes", async () => {
		// The file carries the complete command output, including whatever the context
		// truncation dropped from the model's view - credentials a command printed on
		// its last lines, for instance. os.tmpdir() is shared, so 0644 means every local
		// user can read it.
		const result = await executeBashWithOperations("filler", process.cwd(), operationsThat(emitFiller));

		expect(result.truncated).toBe(true);
		const path = result.fullOutputPath;
		expect(path).toBeDefined();
		made.push(path!);
		expect(await modeOfOncePresent(path!)).toBe(0o600);
	});

	it("keeps the persisted output private on the cancelled path too", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await executeBashWithOperations("filler", process.cwd(), operationsThat(emitFiller), {
			signal: controller.signal,
		});

		expect(result.cancelled).toBe(true);
		const path = result.fullOutputPath;
		expect(path).toBeDefined();
		made.push(path!);
		expect(await modeOfOncePresent(path!)).toBe(0o600);
	});
});

describe("output accumulator full-output temp file", () => {
	it("is private to the owner", async () => {
		const accumulator = new OutputAccumulator({ tempFilePrefix: "pi-output-hygiene-test" });
		accumulator.append(fillerBytes());
		accumulator.finish();
		const snapshot = accumulator.snapshot({ persistIfTruncated: true });
		await accumulator.closeTempFile();

		expect(snapshot.truncation.truncated).toBe(true);
		const path = snapshot.fullOutputPath;
		expect(path).toBeDefined();
		made.push(path!);
		expect(await modeOfOncePresent(path!)).toBe(0o600);
	});
});

describe("bash executor decoder tail", () => {
	/**
	 * A command cut off mid-character (timeout, abort, a killed producer) leaves an
	 * incomplete UTF-8 sequence inside the streaming decoder. The accumulator used by
	 * the bash tool flushes it and reports the break; the executor dropped it, so the
	 * two disagreed about the same byte stream and the tail vanished without a trace.
	 */
	function cutTailChunks(): Buffer[] {
		const euro = Buffer.from("€", "utf-8");
		expect(euro.length).toBe(3);
		return [Buffer.from("total: ", "utf-8"), euro.subarray(0, 2)];
	}

	it("reports the same tail as the output accumulator for a stream cut mid-character", async () => {
		const accumulator = new OutputAccumulator();
		for (const chunk of cutTailChunks()) {
			accumulator.append(chunk);
		}
		accumulator.finish();
		const accumulatorText = accumulator.snapshot().content;
		expect(accumulatorText).toContain("\uFFFD");

		const chunks = cutTailChunks();
		const result = await executeBashWithOperations(
			"cut",
			process.cwd(),
			operationsThat((onData) => {
				for (const chunk of chunks) onData(chunk);
			}),
		);

		expect(result.output).toBe(accumulatorText);
		expect(result.output).toBe("total: \uFFFD");
	});

	it("flushes the tail on the cancelled path as well", async () => {
		const controller = new AbortController();
		const chunks = cutTailChunks();
		const result = await executeBashWithOperations(
			"cut",
			process.cwd(),
			{
				exec: async (_command, _cwd, { onData }) => {
					for (const chunk of chunks) onData(chunk);
					controller.abort();
					throw new Error("command aborted");
				},
			},
			{ signal: controller.signal },
		);

		expect(result.cancelled).toBe(true);
		expect(result.output).toBe("total: \uFFFD");
	});

	it("delivers a complete multi-byte character split across chunks unchanged", async () => {
		const text = "preis: 1.234,56 € — ok";
		const bytes = Buffer.from(text, "utf-8");
		const result = await executeBashWithOperations(
			"split",
			process.cwd(),
			operationsThat((onData) => {
				onData(bytes.subarray(0, bytes.length - 2));
				onData(bytes.subarray(bytes.length - 2));
			}),
		);

		expect(result.output).toBe(text);
	});
});
