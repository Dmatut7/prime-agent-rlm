import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		constants: { ...actual.constants, O_NOFOLLOW: undefined },
	};
});

import {
	ensurePrivateFile,
	readPrivateFile,
	requireNoFollow,
	writePrivateFileAtomic,
} from "../src/utils/private-files.js";

let directory: string;

afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("O_NOFOLLOW fallback when the flag is undefined (win32)", () => {
	it("degrades requireNoFollow to 0 instead of throwing", () => {
		expect(requireNoFollow(undefined)).toBe(0);
		expect(requireNoFollow(0x20000)).toBe(0x20000);
	});

	it("writes a private file when O_NOFOLLOW is undefined and keeps 0600 on POSIX", () => {
		directory = mkdtempSync(join(tmpdir(), "pi-private-nofollow-fallback-"));
		const path = join(directory, "session.json");

		writePrivateFileAtomic(path, '{"ok":true}');

		expect(readFileSync(path, "utf8")).toBe('{"ok":true}');
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}

		ensurePrivateFile(join(directory, "auth.json"), "secret");
		expect(readPrivateFile(join(directory, "auth.json"), "utf8")).toBe("secret");
		if (process.platform !== "win32") {
			expect(statSync(join(directory, "auth.json")).mode & 0o777).toBe(0o600);
		}

		// win32 chmod is a no-op: writing must still succeed after an explicit mode repair.
		chmodSync(path, 0o644);
		writePrivateFileAtomic(path, '{"again":true}');
		expect(readFileSync(path, "utf8")).toBe('{"again":true}');
	});
});
