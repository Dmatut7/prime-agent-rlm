import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendOwnedSessionLineAsync, loadEntriesFromFile } from "../src/core/session-manager.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-r31-k3p45-red-"));
	tempDirs.push(directory);
	return directory;
}

describe("r31 K3P-45 unverifiable trailing record refuses the append", () => {
	it("refuses the rename append and leaves the file byte-for-byte untouched", async () => {
		const root = createTempDir();
		const dir = join(root, "sessions");
		mkdirSync(dir, { recursive: true });
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "01r31k3p45red",
			timestamp: new Date(0).toISOString(),
			cwd: dir,
		});
		// A complete, valid message record of ~17 MiB on one line, terminator
		// torn off: longer than the verification bound, so repair must leave it
		// exactly as it is, and the append must refuse to glue onto it.
		const big = JSON.stringify({
			type: "message",
			id: "big1",
			parentId: null,
			timestamp: new Date(1).toISOString(),
			message: { role: "user", content: "x".repeat(17 * 1024 * 1024), timestamp: 1 },
		});
		const file = join(dir, "punch.jsonl");
		writeFileSync(file, `${header}\n${big}`);
		const before = readFileSync(file);

		let appendError: unknown;
		try {
			await appendOwnedSessionLineAsync(file, root, (manager) => manager.appendSessionInfo("renamed-session"));
		} catch (error) {
			appendError = error;
		}

		expect(appendError).toBeInstanceOf(Error);
		expect((appendError as Error).message).toContain("Refusing to append");
		const after = readFileSync(file);
		expect(after.equals(before)).toBe(true);

		// No rename receipt landed: the append was refused, not silently glued.
		// The 17 MiB record stays on disk byte-for-byte (readers still skip the
		// unterminated tail, which is exactly the state the repair left).
		const entries = loadEntriesFromFile(file);
		expect(entries.some((entry) => (entry as { type?: string }).type === "session_info")).toBe(false);
	}, 60_000);
});
