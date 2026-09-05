import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrivateDirectory } from "../src/utils/private-files.js";

/**
 * The memo fast path skips the ancestor walk, so when an ancestor is swapped for a
 * non-directory the lstat it does pay for fails with a bare ENOTDIR instead of the
 * "Refusing to use non-directory private path: <segment>" message the full validation
 * produces. Both are fail-closed; this nails the property that matters - it still
 * refuses - and accepts either wording, because the memo path cannot name a segment
 * it never walked.
 */
describe("private directory memo with a non-directory ancestor", () => {
	const made: string[] = [];

	afterEach(() => {
		while (made.length > 0) {
			const dir = made.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still refuses when an ancestor is swapped for a regular file after a memo hit", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-private-memo-ancestor-"));
		made.push(base);
		const mid = join(base, "mid");
		const leaf = join(mid, "leaf");
		mkdirSync(leaf, { recursive: true });

		// First call validates for real and populates the memo.
		expect(() => ensurePrivateDirectory(leaf)).not.toThrow();

		// Swap an ancestor for a regular file. The memo entry for the leaf survives, so
		// the next call takes the fast path and its lstat hits the non-directory ancestor.
		rmSync(mid, { recursive: true, force: true });
		writeFileSync(mid, "now a regular file");

		expect(() => ensurePrivateDirectory(leaf)).toThrow(/non-directory|ENOTDIR/);
	});
});
