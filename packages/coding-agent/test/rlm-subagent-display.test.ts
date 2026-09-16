import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type RlmSubagentDisplayEntry,
	readRlmSubagentDisplayEntry,
	rlmSubagentDisplayPath,
	writeRlmSubagentDisplayEntry,
} from "../src/modes/daemon/rlm-subagent-display.js";

function makeEntry(sessionDir: string, overrides: Partial<RlmSubagentDisplayEntry> = {}): RlmSubagentDisplayEntry {
	return {
		type: "rlm_subagent",
		childId: "sub-1234abcd",
		sessionName: "worker",
		sessionDir,
		sessionFile: join(sessionDir, "01a0-child.jsonl"),
		rlmMaxDepth: 4,
		rlmParentNodeId: "sub-1234abcd",
		prompt: "do the work",
		spawnCode: "await rlm('do the work')",
		model: { provider: "test", modelId: "model" },
		status: "running",
		createdAt: 1,
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("rlm subagent display files", () => {
	it("round-trips an entry and replaces it atomically without temp-file residue", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			const entry = makeEntry(sessionDir);
			writeRlmSubagentDisplayEntry(entry);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(entry);

			const updated = makeEntry(sessionDir, { status: "deleted", updatedAt: "2026-01-01T00:00:01.000Z" });
			writeRlmSubagentDisplayEntry(updated);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(updated);
			expect(readdirSync(sessionDir)).toEqual(["rlm-subagent.json"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reads tolerantly: missing, malformed, and invalid files are undefined", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-tolerant-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toBeUndefined();

			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(rlmSubagentDisplayPath(sessionDir), "{not json");
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toBeUndefined();

			writeFileSync(rlmSubagentDisplayPath(sessionDir), JSON.stringify({ type: "rlm_subagent", childId: 42 }));
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toBeUndefined();

			writeFileSync(
				rlmSubagentDisplayPath(sessionDir),
				JSON.stringify(makeEntry(sessionDir, { status: "exploded" as RlmSubagentDisplayEntry["status"] })),
			);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("re-reads a rewrite that a stat cannot distinguish from the cached entry", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-cache-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			const path = rlmSubagentDisplayPath(sessionDir);
			// Equal-length names serialize to identical byte counts, and a whole-second
			// timestamp survives the stat round-trip exactly, so both writes report the
			// same (size, mtimeMs). That reproduces two writes landing in one mtime
			// tick, where the writer rather than the stat has to invalidate.
			const pinnedSeconds = 1_700_000_000;
			const first = makeEntry(sessionDir, { sessionName: "workerA" });
			writeRlmSubagentDisplayEntry(first);
			utimesSync(path, pinnedSeconds, pinnedSeconds);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(first);
			const pinned = statSync(path);

			const second = makeEntry(sessionDir, { sessionName: "workerB" });
			writeRlmSubagentDisplayEntry(second);
			utimesSync(path, pinnedSeconds, pinnedSeconds);
			const rewritten = statSync(path);
			expect(rewritten.size).toBe(pinned.size);
			expect(rewritten.mtimeMs).toBe(pinned.mtimeMs);

			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(second);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("re-reads a cross-process rewrite whose stat cannot be distinguished (r38 LIFE-3)", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-xproc-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			const path = rlmSubagentDisplayPath(sessionDir);
			const pinnedSeconds = 1_700_000_000;
			const first = makeEntry(sessionDir, { sessionName: "workerA", status: "running" });
			writeRlmSubagentDisplayEntry(first);
			utimesSync(path, pinnedSeconds, pinnedSeconds);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(first);
			const pinned = statSync(path);

			// An out-of-process writer never runs this process's cache invalidation:
			// "running" and "deleted" serialize to the same byte length, and the pinned
			// whole-second mtime survives the stat round trip exactly, so only the
			// content can tell the two files apart.
			const second = makeEntry(sessionDir, { sessionName: "workerB", status: "deleted" });
			writeFileSync(path, `${JSON.stringify(second)}\n`);
			utimesSync(path, pinnedSeconds, pinnedSeconds);
			const rewritten = statSync(path);
			expect(rewritten.size).toBe(pinned.size);
			expect(rewritten.mtimeMs).toBe(pinned.mtimeMs);

			// Red before the fix: the stat match alone returned the cached "running".
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(second);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("stops reporting an entry once its file is removed", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-removed-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			const entry = makeEntry(sessionDir);
			writeRlmSubagentDisplayEntry(entry);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(entry);

			rmSync(sessionDir, { recursive: true, force: true });
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("accepts unknown extra fields from newer writers", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-forward-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			const entry = makeEntry(sessionDir);
			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(rlmSubagentDisplayPath(sessionDir), JSON.stringify({ ...entry, futureField: true }));
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toMatchObject({
				childId: entry.childId,
				status: "running",
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
