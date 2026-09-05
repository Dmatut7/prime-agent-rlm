import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrivateDirectory } from "../src/utils/private-files.js";

/**
 * The memo on validated private directories skips the ancestor walk only. These
 * pin the three properties a memo hit must not lose.
 */
describe("ensurePrivateDirectory memoization", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) {
			rmSync(root, { recursive: true, force: true });
			root = undefined;
		}
	});

	function tempRoot(): string {
		root = mkdtempSync(join(tmpdir(), "pi-private-memo-"));
		return root;
	}

	it("re-tightens a directory whose mode was loosened after validation", () => {
		const target = join(tempRoot(), "sessions");
		ensurePrivateDirectory(target);
		expect(statSync(target).mode & 0o777).toBe(0o700);

		// Warm the memo, then loosen the mode behind its back. The next call is a memo
		// hit, and the lstat it already pays for has to notice.
		ensurePrivateDirectory(target);
		chmodSync(target, 0o755);
		ensurePrivateDirectory(target);

		expect(statSync(target).mode & 0o777).toBe(0o700);
	});

	it("recreates a memoized directory that was removed", () => {
		// tempRoot() makes a fresh directory per call, so capture it once.
		const dir = tempRoot();
		const target = join(dir, "sessions", "nested");
		ensurePrivateDirectory(target);
		expect(existsSync(target)).toBe(true);

		rmSync(join(dir, "sessions"), { recursive: true, force: true });
		expect(existsSync(target)).toBe(false);

		ensurePrivateDirectory(target);

		expect(statSync(target).isDirectory()).toBe(true);
		expect(statSync(target).mode & 0o777).toBe(0o700);
	});

	it("refuses a memoized directory swapped for a symlink however the path is spelled", () => {
		const dir = tempRoot();
		const outside = join(dir, "outside");
		ensurePrivateDirectory(outside);

		// Each spelling needs its own memo entry: the unnormalized-spelling case is only
		// reachable through a memo hit, and the first refusal would drop the entry that
		// the later spellings depend on.
		// Spellings that resolve() folds onto the same memo key. A "./" suffix is not
		// one of them: it names a different path, which is legitimately created.
		const spellings = ["", "/", "/.", "//", "/./"];
		spellings.forEach((suffix, index) => {
			const target = join(dir, `target-${index}`);
			mkdirSync(target, { mode: 0o700 });
			ensurePrivateDirectory(target); // memoize it as a real directory
			rmSync(target, { recursive: true, force: true });
			symlinkSync(outside, target, "dir"); // swap it for a link to another 0700 dir

			// resolve() strips the suffix, so the key still hits; a trailing slash or
			// "/." makes POSIX lstat follow the link and see the 0700 target.
			const spelled = `${target}${suffix}`;
			expect(() => ensurePrivateDirectory(spelled), JSON.stringify(spelled)).toThrow("non-directory private path");
		});
	});

	it("refuses a memoized directory replaced by a regular file", () => {
		const dir = tempRoot();
		const target = join(dir, "target");
		mkdirSync(target, { mode: 0o700 });
		ensurePrivateDirectory(target);

		rmSync(target, { recursive: true, force: true });
		writeFileSync(target, "not a directory");
		// 0700 on purpose: a regular file at the private mode passes the symlink and
		// mode conditions, so only isDirectory() can catch it.
		chmodSync(target, 0o700);

		expect(() => ensurePrivateDirectory(target)).toThrow("non-directory private path");
	});

	it("refuses a memoized directory swapped for a symlink", () => {
		const dir = tempRoot();
		const target = join(dir, "sessions");
		const outside = join(dir, "outside");
		ensurePrivateDirectory(target);
		ensurePrivateDirectory(outside);
		// Warm the memo for this exact path.
		ensurePrivateDirectory(target);

		rmSync(target, { recursive: true, force: true });
		symlinkSync(outside, target, "dir");

		expect(() => ensurePrivateDirectory(target)).toThrow("non-directory private path");
	});
});
