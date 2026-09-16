import { describe, expect, it } from "vitest";
import { CURRENT_SESSION_VERSION, type FileEntry, migrateSessionEntries } from "../../src/core/session-manager.js";

function sessionHeader(version: number): FileEntry {
	return {
		type: "session",
		id: "sess-r36",
		version,
		timestamp: "2026-01-01T00:00:00Z",
		cwd: "/tmp",
	} as FileEntry;
}

describe("migrateSessionEntries with a newer session format version", () => {
	it("errors explicitly instead of silently skipping a file from a newer CLI", () => {
		const entries: FileEntry[] = [sessionHeader(CURRENT_SESSION_VERSION + 1)];

		expect(() => migrateSessionEntries(entries)).toThrow(/newer/);
	});

	it("still migrates older formats to the current version", () => {
		const entries: FileEntry[] = [sessionHeader(2)];

		migrateSessionEntries(entries);

		expect((entries[0] as { version?: number }).version).toBe(CURRENT_SESSION_VERSION);
	});

	it("leaves a current-version file untouched without erroring", () => {
		const entries: FileEntry[] = [sessionHeader(CURRENT_SESSION_VERSION)];

		expect(() => migrateSessionEntries(entries)).not.toThrow();
		expect((entries[0] as { version?: number }).version).toBe(CURRENT_SESSION_VERSION);
	});
});
