import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type AuthRecord, loadAuth, saveAuth } from "../src/utils/auth-store.js";
import { writePrivateFileAtomic } from "../src/utils/private-file.js";

/**
 * A10: auth.json holds OAuth credentials. The old save wrote it with a bare
 * writeFileSync: default 0644 (readable by every account on the machine) and a
 * symlink planted at the file's path was followed, writing the credentials to
 * the attacker's target. The private write must land 0600, replace atomically,
 * and refuse the symlink.
 */

let directory: string;

afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
	directory = mkdtempSync(join(tmpdir(), "pi-ai-auth-private-"));
	return directory;
}

const sampleAuth: AuthRecord = {
	anthropic: {
		type: "oauth",
		// Shape-trimmed stand-in for real credentials; only the store contract matters.
		refresh: "rt_sample",
		access: "at_sample",
		expires: 4102444800,
	},
};

describe("auth.json private write", () => {
	it("saves credentials with 0600 permissions", () => {
		const path = join(tempDir(), "auth.json");

		saveAuth(sampleAuth, path);

		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
		expect(loadAuth(path)).toEqual(sampleAuth);
	});

	it("re-tightens permissions when replacing an existing world-readable auth.json", () => {
		const path = join(tempDir(), "auth.json");
		writeFileSync(path, "{}", "utf-8");
		if (process.platform !== "win32") chmodSync(path, 0o644);

		saveAuth(sampleAuth, path);

		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
		expect(readFileSync(path, "utf-8")).toBe(JSON.stringify(sampleAuth, null, 2));
	});

	it("refuses to write through a symlink planted at the auth.json path", () => {
		const dir = tempDir();
		const path = join(dir, "auth.json");
		const target = join(dir, "captured.txt");
		writeFileSync(target, "attacker controlled", "utf-8");
		if (process.platform === "win32") {
			// symlinkSync needs privileges on win32; the refusal is POSIX behaviour.
			return;
		}
		symlinkSync(target, path);

		expect(() => saveAuth(sampleAuth, path)).toThrow();

		// Neither the credentials nor the temp file landed; the symlink is untouched.
		expect(readFileSync(target, "utf-8")).toBe("attacker controlled");
		expect(lstatSync(path).isSymbolicLink()).toBe(true);
	});
});

describe("writePrivateFileAtomic", () => {
	it("replaces the whole file content atomically", () => {
		const path = join(tempDir(), "auth.json");
		writePrivateFileAtomic(path, "first");
		writePrivateFileAtomic(path, "second");

		expect(readFileSync(path, "utf-8")).toBe("second");
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
	});

	it("leaves no temp file behind", () => {
		const dir = tempDir();
		writePrivateFileAtomic(join(dir, "auth.json"), "content");

		const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp"));
		expect(leftovers).toEqual([]);
	});
});

describe("cli wiring", () => {
	it("persists credentials through the private-file helper, not a bare writeFileSync", () => {
		const cliSource = readFileSync(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "utf-8");
		// The CLI owns the login flow but must delegate persistence to the store.
		expect(cliSource).toContain("auth-store");
		expect(cliSource).not.toMatch(/writeFileSync\s*\(/);

		const storeSource = readFileSync(fileURLToPath(new URL("../src/utils/auth-store.ts", import.meta.url)), "utf-8");
		expect(storeSource).toContain("writePrivateFileAtomic");
		expect(storeSource).not.toMatch(/writeFileSync\s*\(/);
	});
});
