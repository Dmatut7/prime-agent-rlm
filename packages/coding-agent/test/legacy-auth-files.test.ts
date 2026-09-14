import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	findFilesHoldingSecrets,
	findLegacyTokenStores,
	purgeLegacyTokenStores,
	readLegacyTokenStore,
} from "../src/core/legacy-auth-files.js";

let directory: string;

afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

function newDirectory(): string {
	directory = mkdtempSync(join(tmpdir(), "pi-legacy-stores-"));
	return directory;
}

function touch(dir: string, name: string, content = "{}", mode = 0o644): string {
	const path = join(dir, name);
	writeFileSync(path, content, { mode });
	return path;
}

describe("legacy credential store names", () => {
	it("finds the copies older versions left and ignores the live store", () => {
		const dir = newDirectory();
		// The live store, its lock, and files that are not credential stores.
		touch(dir, "auth.json");
		mkdirSync(join(dir, "auth.json.lock"));
		touch(dir, "settings.json");
		touch(dir, "models.json");
		touch(dir, "keybindings.json");
		const copies = [
			"oauth.json",
			"oauth.json.migrated",
			"oauth.json.migrated.2026-09-14",
			"oauth.json.bak",
			"auth.json.old",
			".auth.json.4242.6d1b9e3f-2b0a-4c6d-8e1f-000000000000.tmp",
		];
		for (const name of copies) touch(dir, name);

		expect(findLegacyTokenStores(dir)).toEqual(copies.map((name) => join(dir, name)).sort());
	});

	it("does not claim a name it has no evidence for", () => {
		const dir = newDirectory();
		touch(dir, "creds-manual-copy.json");

		expect(findLegacyTokenStores(dir)).toEqual([]);
	});

	it("returns nothing for a directory that does not exist", () => {
		expect(findLegacyTokenStores(join(tmpdir(), "pi-legacy-stores-missing-000"))).toEqual([]);
	});
});

describe("purgeLegacyTokenStores", () => {
	it("deletes the copies and reports what it deleted", () => {
		const dir = newDirectory();
		const oauthPath = touch(dir, "oauth.json", '{"openai-codex":{"refresh":"r"}}');
		const migratedPath = touch(dir, "oauth.json.migrated", '{"openai-codex":{"refresh":"r"}}');
		const livePath = touch(dir, "auth.json", "{}");

		expect(purgeLegacyTokenStores(dir).sort()).toEqual([migratedPath, oauthPath].sort());
		expect(existsSync(oauthPath)).toBe(false);
		expect(existsSync(migratedPath)).toBe(false);
		expect(existsSync(livePath)).toBe(true);
	});

	it("keeps the paths it is told to keep, tightened to private", () => {
		const dir = newDirectory();
		const keptPath = touch(dir, "oauth.json", '{"openai-codex":{"refresh":"r"}}', 0o644);
		const otherPath = touch(dir, "oauth.json.migrated", '{"openai-codex":{"refresh":"r"}}');

		purgeLegacyTokenStores(dir, { keep: [keptPath] });

		expect(existsSync(keptPath)).toBe(true);
		expect(existsSync(otherPath)).toBe(false);
		expect(readFileSync(keptPath, "utf-8")).toBe('{"openai-codex":{"refresh":"r"}}');
		if (process.platform !== "win32") {
			expect(statSync(keptPath).mode & 0o777).toBe(0o600);
		}
	});

	it("throws and names every copy it could not delete", () => {
		const dir = newDirectory();
		const stuckPath = join(dir, "oauth.json.migrated");
		mkdirSync(stuckPath);
		const removablePath = touch(dir, "auth.json.bak", "{}");

		expect(() => purgeLegacyTokenStores(dir)).toThrow(/Could not remove legacy credential file\(s\)/);
		try {
			purgeLegacyTokenStores(dir);
		} catch (error) {
			expect((error as Error).message).toContain(stuckPath);
		}
		// A copy it can delete is deleted even when another one is stuck.
		expect(existsSync(removablePath)).toBe(false);
	});
});

describe("readLegacyTokenStore", () => {
	it("reads provider entries and rejects anything that is not one", () => {
		const dir = newDirectory();

		expect(readLegacyTokenStore(touch(dir, "oauth.json", '{"openai-codex":{"refresh":"r"}}'))).toEqual({
			"openai-codex": { refresh: "r" },
		});
		expect(readLegacyTokenStore(touch(dir, "oauth.json.bak", "{truncated"))).toBeUndefined();
		expect(readLegacyTokenStore(touch(dir, "auth.json.old", "[1,2,3]"))).toBeUndefined();
		expect(readLegacyTokenStore(join(dir, "missing.json"))).toBeUndefined();
	});
});

describe("findFilesHoldingSecrets", () => {
	const SECRET = "REFRESH-TOKEN-SECRET-xyz789uvw012";

	it("reports every file that still holds a credential value", () => {
		const dir = newDirectory();
		const holder = touch(dir, "creds-manual-copy.json", JSON.stringify({ refresh: SECRET }));
		touch(dir, "settings.json", JSON.stringify({ theme: "dark" }));

		expect(findFilesHoldingSecrets(dir, [SECRET])).toEqual([holder]);
		// Positive control for the sweep: the value it is told about is the one it finds.
		expect(findFilesHoldingSecrets(dir, ["REFRESH-TOKEN-SECRET-000000000000"])).toEqual([]);
	});

	it("does not treat references to a secret as the secret", () => {
		const dir = newDirectory();
		// An env var name and a `!command` are how a key can be stored without its value;
		// failing a logout over either of them would be a false alarm.
		touch(
			dir,
			"models.json",
			JSON.stringify({ apiKey: "ANTHROPIC_API_KEY_REFERENCE", command: "!security find-generic" }),
		);

		expect(findFilesHoldingSecrets(dir, ["ANTHROPIC_API_KEY_REFERENCE", "!security find-generic"])).toEqual([]);
	});

	it("leaves subdirectories alone", () => {
		const dir = newDirectory();
		mkdirSync(join(dir, "sessions"));
		touch(dir, join("sessions", "session-1.jsonl"), JSON.stringify({ secret: SECRET }));

		expect(findFilesHoldingSecrets(dir, [SECRET])).toEqual([]);
	});
});
