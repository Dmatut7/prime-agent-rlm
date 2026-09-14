import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removePrivateFile, tightenPrivateFileMode } from "../src/utils/private-files.js";

let directory: string;

afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

function newDirectory(): string {
	directory = mkdtempSync(join(tmpdir(), "pi-private-removal-"));
	return directory;
}

describe("removePrivateFile", () => {
	it("deletes a file and reports that it did", () => {
		const dir = newDirectory();
		const path = join(dir, "oauth.json.migrated");
		writeFileSync(path, '{"openai-codex":{"refresh":"secret"}}', { mode: 0o644 });

		expect(removePrivateFile(path)).toBe(true);
		expect(existsSync(path)).toBe(false);
		// Already gone is not a failure: cleanup runs on every startup.
		expect(removePrivateFile(path)).toBe(false);
	});

	it("refuses a directory instead of removing it recursively", () => {
		const dir = newDirectory();
		const path = join(dir, "oauth.json.migrated");
		mkdirSync(path);
		writeFileSync(join(path, "inner.json"), "{}");

		expect(() => removePrivateFile(path)).toThrow(/non-regular private file/);
		expect(existsSync(join(path, "inner.json"))).toBe(true);
	});

	it("removes a symlink without touching what it points at", () => {
		const dir = newDirectory();
		const target = join(dir, "real-store.json");
		writeFileSync(target, '{"refresh":"secret"}');
		const link = join(dir, "oauth.json.migrated");
		symlinkSync(target, link);

		expect(removePrivateFile(link)).toBe(true);
		expect(existsSync(link)).toBe(false);
		expect(readFileSync(target, "utf-8")).toBe('{"refresh":"secret"}');
	});
});

describe("tightenPrivateFileMode", () => {
	it("makes a readable file private without rewriting it", () => {
		const dir = newDirectory();
		const path = join(dir, "oauth.json");
		writeFileSync(path, '{"refresh":"secret"}', { mode: 0o644 });

		tightenPrivateFileMode(path);

		const stats = statSync(path);
		if (process.platform !== "win32") {
			expect(stats.mode & 0o777).toBe(0o600);
		}
		expect(readFileSync(path, "utf-8")).toBe('{"refresh":"secret"}');
	});
});
