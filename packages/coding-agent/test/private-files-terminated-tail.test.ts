import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendPrivateFile, UnterminatedTailError } from "../src/utils/private-files.js";

describe("appendPrivateFile requireTerminatedTail", () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory) {
			rmSync(directory, { recursive: true, force: true });
			directory = undefined;
		}
	});

	function tempDir(): string {
		directory = mkdtempSync(join(tmpdir(), "pi-private-tail-"));
		return directory;
	}

	it("refuses to append onto an unterminated tail and leaves the file untouched", () => {
		// perfB③: the tail check rides the append descriptor itself. Refusing must
		// not cost the bytes already on disk, and the error must be distinguishable
		// from a generic fs failure so the caller can repair-and-retry.
		const path = join(tempDir(), "torn.jsonl");
		writeFileSync(path, '{"line":1}\n{"torn":');
		const before = readFileSync(path);

		expect(() => appendPrivateFile(path, '{"line":2}\n', { requireTerminatedTail: true })).toThrow(
			UnterminatedTailError,
		);
		expect(readFileSync(path).equals(before)).toBe(true);
	});

	it("appends onto a terminated tail through the same descriptor it checked", () => {
		const path = join(tempDir(), "whole.jsonl");
		writeFileSync(path, '{"line":1}\n');

		appendPrivateFile(path, '{"line":2}\n', { requireTerminatedTail: true });

		expect(readFileSync(path, "utf8")).toBe('{"line":1}\n{"line":2}\n');
	});

	it("creates the file when the path does not exist yet", () => {
		// An absent file has no tail to violate; the option must not turn creation
		// into a failure.
		const path = join(tempDir(), "fresh.jsonl");

		appendPrivateFile(path, '{"line":1}\n', { requireTerminatedTail: true });

		expect(readFileSync(path, "utf8")).toBe('{"line":1}\n');
	});

	it("keeps the default option-free shape appending regardless of the tail", () => {
		// The option is opt-in: every other caller keeps the pre-existing contract.
		const path = join(tempDir(), "legacy.jsonl");
		writeFileSync(path, "no-newline");

		appendPrivateFile(path, "-more");

		expect(readFileSync(path, "utf8")).toBe("no-newline-more");
	});
});
