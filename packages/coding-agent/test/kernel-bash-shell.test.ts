import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn(),
	spawnSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	// Module-load reads (config.ts) must see the real fs; tests override per case.
	mocks.existsSync.mockImplementation(actual.existsSync);
	return { ...actual, existsSync: mocks.existsSync };
});

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	return { ...actual, spawnSync: mocks.spawnSync };
});

import { resolveKernelBashShell, splitShellWords } from "../src/utils/shell.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function stubWin32(): void {
	Object.defineProperty(process, "platform", { value: "win32" });
}

afterEach(() => {
	if (originalPlatform) {
		Object.defineProperty(process, "platform", originalPlatform);
	}
	mocks.existsSync.mockClear();
	mocks.spawnSync.mockClear();
});

describe("resolveKernelBashShell on win32", () => {
	it("returns undefined without consulting PATH when no Git Bash is installed", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(false);

		expect(resolveKernelBashShell()).toBeUndefined();
		// The old fallback shelled out to `where bash.exe`; a repo-controlled
		// PATH/where.exe must never pick the kernel shell.
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});

	it("returns the canonical Git Bash install path when present", () => {
		stubWin32();
		const canonical = "C:\\Program Files\\Git\\bin\\bash.exe";
		mocks.existsSync.mockImplementation((path: string) => path === canonical);

		expect(resolveKernelBashShell()).toBe(canonical);
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});

	it("returns an explicit shellPath as-is", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(false);

		expect(resolveKernelBashShell("D:\\tools\\bash.exe")).toBe("D:\\tools\\bash.exe");
		expect(mocks.existsSync).not.toHaveBeenCalled();
	});
});

describe("splitShellWords", () => {
	it("splits a command line on unquoted whitespace", () => {
		expect(splitShellWords("code --wait")).toEqual(["code", "--wait"]);
	});

	it("keeps quoted paths with spaces as one word", () => {
		expect(splitShellWords('"/Applications/My Editor.app/bin/edit" --wait')).toEqual([
			"/Applications/My Editor.app/bin/edit",
			"--wait",
		]);
		expect(splitShellWords("'/Applications/My Editor.app/bin/edit'")).toEqual([
			"/Applications/My Editor.app/bin/edit",
		]);
	});

	it("keeps single-quoted content literal", () => {
		expect(splitShellWords("vim '+call cursor(1,1)'")).toEqual(["vim", "+call cursor(1,1)"]);
	});

	it("unescapes backslash-escaped spaces", () => {
		expect(splitShellWords("/path/my\\ editor --wait")).toEqual(["/path/my editor", "--wait"]);
	});

	it("returns no words for blank input", () => {
		expect(splitShellWords("")).toEqual([]);
		expect(splitShellWords("   ")).toEqual([]);
	});
});
