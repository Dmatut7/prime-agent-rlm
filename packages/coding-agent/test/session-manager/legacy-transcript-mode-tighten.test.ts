import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEntriesFromFile, readSessionInfo } from "../../src/core/session-manager.js";

/**
 * A transcript carries the whole conversation, including whatever a tool echoed into
 * it. Write paths harden to 0600 (see issue #1105), but transcripts written by
 * pre-hardening versions are still on disk at 0644, world-readable to every account on
 * the machine, and a read path that only reads keeps them that way.
 *
 * The read paths therefore tighten a legacy mode in place and say so once, the same
 * way a legacy artifact directory is tightened on read.
 */

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("legacy transcript permissions on read paths", () => {
	let tempRoot: string;
	let consoleError: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-legacy-transcript-"));
		consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleError.mockRestore();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	function writeTranscript(fileName: string, mode: number): string {
		const sessionDir = join(tempRoot, "sessions");
		mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
		const sessionFile = join(sessionDir, fileName);
		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: fileName.replace(/\.jsonl$/, ""),
				timestamp: new Date().toISOString(),
				cwd: tempRoot,
			})}\n`,
		);
		chmodSync(sessionFile, mode);
		return sessionFile;
	}

	function modeOf(path: string): number {
		return statSync(path).mode & 0o777;
	}

	function tightenWarnings(): string[] {
		return consoleError.mock.calls
			.map((call: unknown[]) => String(call[0]))
			.filter((message: string) => message.includes("Tightened legacy session transcript"));
	}

	it("tightens a world-readable transcript when listing reads it", async () => {
		const sessionFile = writeTranscript("legacy-listing.jsonl", 0o644);

		expect(await readSessionInfo(sessionFile)).not.toBeNull();

		expect(modeOf(sessionFile)).toBe(0o600);
		expect(tightenWarnings()).toHaveLength(1);
		expect(tightenWarnings()[0]).toContain(sessionFile);
	});

	it("tightens a group-readable transcript when the entries are loaded", () => {
		const sessionFile = writeTranscript("legacy-entries.jsonl", 0o640);

		expect(loadEntriesFromFile(sessionFile).length).toBeGreaterThan(0);

		expect(modeOf(sessionFile)).toBe(0o600);
		expect(tightenWarnings()).toHaveLength(1);
	});

	it("warns once per transcript per process", async () => {
		const sessionFile = writeTranscript("legacy-once.jsonl", 0o644);

		await readSessionInfo(sessionFile);
		expect(modeOf(sessionFile)).toBe(0o600);
		await readSessionInfo(sessionFile);
		loadEntriesFromFile(sessionFile);
		await readSessionInfo(sessionFile);

		expect(tightenWarnings()).toHaveLength(1);
	});

	it("leaves a transcript that exposes nothing to other accounts untouched", async () => {
		const privateFile = writeTranscript("already-private.jsonl", 0o600);
		const ownerReadOnly = writeTranscript("owner-read-only.jsonl", 0o400);

		expect(await readSessionInfo(privateFile)).not.toBeNull();
		expect(await readSessionInfo(ownerReadOnly)).not.toBeNull();

		expect(modeOf(privateFile)).toBe(0o600);
		expect(modeOf(ownerReadOnly)).toBe(0o400);
		expect(tightenWarnings()).toEqual([]);
	});
});
