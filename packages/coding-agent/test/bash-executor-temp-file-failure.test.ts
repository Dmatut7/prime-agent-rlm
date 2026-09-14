/**
 * H-3: the executor promised "Full output: <path>" for a temp file it never managed to create, and
 * the write failure arrived as an unhandled stream `error` event - which in the daemon host is
 * `uncaughtException` -> `process.exit(1)`. Pinned here: the host survives, a path is handed out
 * only when the file it names really is there, and it already holds the whole output.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.js";
import { bashOutputToText } from "../src/core/messages.js";
import type { BashOperations } from "../src/core/tools/bash.js";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.js";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.js";

const scratchDirs: string[] = [];
const previousTmpdir = process.env.TMPDIR;

afterEach(() => {
	process.env.TMPDIR = previousTmpdir;
	while (scratchDirs.length > 0) {
		const dir = scratchDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

/** Output past both truncation thresholds, so a full-output temp file is required. */
function fillerBuffer(): Buffer {
	const line = `${"x".repeat(256)}\n`;
	return Buffer.from(line.repeat(Math.ceil((DEFAULT_MAX_BYTES + 8192) / line.length)), "utf-8");
}

function emitFiller(onData: (chunk: Buffer) => void): void {
	onData(fillerBuffer());
}

function operationsThat(emit: (onData: (chunk: Buffer) => void) => void): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			emit(onData);
			return { exitCode: 0 };
		},
	};
}

/** A directory standing in for an unwritable tmpdir (TMPDIR on a read-only or full volume). */
function readOnlyTmpdir(): string {
	const root = mkdtempSync(join(tmpdir(), "bash-executor-ro-"));
	const dir = join(root, "ro");
	mkdirSync(dir);
	chmodSync(dir, 0o555);
	scratchDirs.push(root);
	return dir;
}

/** Let any pending stream error arrive, so "the host did not crash" is an observation, not a race. */
async function settleTicks(rounds = 30): Promise<void> {
	for (let index = 0; index < rounds; index++) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

/**
 * A listener of our own keeps an uncaught failure observable instead of terminal: node aborts the
 * process when uncaughtException reaches the default handler, which is what daemon-mode turns into
 * `process.exit(1)` - taking every session in the daemon down with it.
 */
async function expectNoHostCrash<T>(run: () => Promise<T>, then?: (value: T) => void): Promise<T> {
	const uncaught: unknown[] = [];
	const handler = (error: unknown) => {
		uncaught.push(error);
	};
	process.prependListener("uncaughtException", handler);
	try {
		const value = await run();
		// Timing assertions run before the settle: the promise is about what the call returned.
		then?.(value);
		await settleTicks();
		expect(uncaught).toEqual([]);
		return value;
	} finally {
		process.removeListener("uncaughtException", handler);
	}
}

describe("bash executor full-output file", () => {
	it("does not crash the host or promise a path when the tmpdir is not writable", async () => {
		process.env.TMPDIR = readOnlyTmpdir();
		const result = await expectNoHostCrash(() =>
			executeBashWithOperations("filler", process.cwd(), operationsThat(emitFiller)),
		);

		expect(result.truncated).toBe(true);
		// The in-memory tail still has to be delivered; only the file promise is withdrawn.
		expect(result.output.length).toBeGreaterThan(0);
		expect(result.fullOutputPath).toBeUndefined();
	});

	it("does not crash the host or promise a path on the cancelled path", async () => {
		process.env.TMPDIR = readOnlyTmpdir();
		const controller = new AbortController();
		controller.abort();
		const result = await expectNoHostCrash(() =>
			executeBashWithOperations("filler", process.cwd(), operationsThat(emitFiller), { signal: controller.signal }),
		);

		expect(result.cancelled).toBe(true);
		expect(result.output.length).toBeGreaterThan(0);
		expect(result.fullOutputPath).toBeUndefined();
	});

	it("reports a truncation with no path without pointing the reader at a file", () => {
		const text = bashOutputToText({
			output: "tail",
			exitCode: 0,
			cancelled: false,
			truncated: true,
			fullOutputPath: undefined,
		});
		expect(text).toContain("[Output truncated.]");
		expect(text).not.toContain("Full output:");
	});

	/** Positive control: with a writable tmpdir the promise is kept - immediately and completely. */
	it("returns a path whose file already holds the whole output", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bash-executor-rw-"));
		scratchDirs.push(dir);
		process.env.TMPDIR = dir;
		await expectNoHostCrash(
			() => executeBashWithOperations("filler", process.cwd(), operationsThat(emitFiller)),
			(result) => {
				expect(result.truncated).toBe(true);
				const path = result.fullOutputPath;
				expect(path).toBeDefined();
				// Returned, not merely scheduled: a reader pointed at the path can open it at once.
				expect(existsSync(path!)).toBe(true);
				const persisted = readFileSync(path!, "utf-8");
				expect(persisted.length).toBeGreaterThanOrEqual(result.output.length);
				expect(persisted).toContain("xxxx");
			},
		);
	});
});
/**
 * The other full-output writer in the repo, checked against the same two properties. It is the
 * model-facing path, and its error handling only held while closeTempFile() was already awaiting:
 * a stream that failed earlier either took the process down (no listener) or never settled.
 */
describe("output accumulator full-output file", () => {
	it("survives an unwritable tmpdir and reports the failure to the caller", async () => {
		process.env.TMPDIR = readOnlyTmpdir();
		const accumulator = new OutputAccumulator({ tempFilePrefix: "r11-accumulator-fail-test" });
		const outcome = await expectNoHostCrash(async () => {
			accumulator.append(fillerBuffer());
			// Let the open failure arrive while nothing is listening, as it does mid-stream.
			await settleTicks();
			accumulator.finish();
			const snapshot = accumulator.snapshot({ persistIfTruncated: true });
			let closeError: Error | undefined;
			await accumulator.closeTempFile().catch((error: Error) => {
				closeError = error;
			});
			return { snapshot, closeError };
		});

		expect(outcome.snapshot.fullOutputPath).toBeUndefined();
		expect(outcome.closeError?.message).toContain("EACCES");
	});

	it("still writes the whole file when the tmpdir is writable (positive control)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "accumulator-rw-"));
		scratchDirs.push(dir);
		process.env.TMPDIR = dir;
		const accumulator = new OutputAccumulator({ tempFilePrefix: "r11-accumulator-ok-test" });
		const outcome = await expectNoHostCrash(async () => {
			accumulator.append(fillerBuffer());
			accumulator.finish();
			const snapshot = accumulator.snapshot({ persistIfTruncated: true });
			await accumulator.closeTempFile();
			return snapshot;
		});

		expect(outcome.truncation.truncated).toBe(true);
		const path = outcome.fullOutputPath;
		expect(path).toBeDefined();
		expect(existsSync(path!)).toBe(true);
		expect(readFileSync(path!).length).toBeGreaterThanOrEqual(DEFAULT_MAX_BYTES);
	});
});
