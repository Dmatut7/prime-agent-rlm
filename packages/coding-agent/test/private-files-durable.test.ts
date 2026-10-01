import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendPrivateFile, UnterminatedTailError } from "../src/utils/private-files.js";

/**
 * The `durable` append option fsyncs before close; the behavior a caller can
 * observe in-process is that the option composes with the existing append
 * contract (creation mode, terminated-tail guard) rather than weakening it.
 */
describe("appendPrivateFile durable option", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-append-durable-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("appends durably to a new file with private mode", () => {
		const file = join(tempDir, "session.jsonl");

		appendPrivateFile(file, '{"a":1}\n', { durable: true });

		expect(readFileSync(file, "utf-8")).toBe('{"a":1}\n');
		if (process.platform !== "win32") {
			expect(statSync(file).mode & 0o777).toBe(0o600);
		}
	});

	it("accumulates repeated durable appends in order", () => {
		const file = join(tempDir, "session.jsonl");

		appendPrivateFile(file, '{"a":1}\n', { durable: true });
		appendPrivateFile(file, '{"b":2}\n', { durable: true, requireTerminatedTail: true });

		expect(readFileSync(file, "utf-8")).toBe('{"a":1}\n{"b":2}\n');
	});

	it("keeps the terminated-tail refusal with durable set", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(file, '{"a":1}', { mode: 0o600 });

		expect(() => appendPrivateFile(file, '{"b":2}\n', { durable: true, requireTerminatedTail: true })).toThrow(
			UnterminatedTailError,
		);
		expect(readFileSync(file, "utf-8")).toBe('{"a":1}');
	});
});
