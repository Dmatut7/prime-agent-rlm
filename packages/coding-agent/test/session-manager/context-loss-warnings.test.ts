import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildSessionContext,
	type CompactionEntry,
	clearTranscriptLineSkips,
	getTranscriptLineSkips,
	loadEntriesFromFile,
	type SessionEntry,
	SessionManager,
	type SessionMessageEntry,
} from "../../src/core/session-manager.js";

/**
 * 记忆-1: three silent memory-loss points in session-manager must surface as
 * consumable warnings. The transcript-line-skip ledger already records file,
 * line and reason per skip for the daemon/TUI; these tests pin the log-side
 * signal at the load path, at the parentId chain walk, and at the compaction
 * retention anchor, plus the warn-once bound that keeps a damaged session from
 * re-logging on every rebuild.
 */

const COMPONENT = "coding-agent.session-manager";

const roots: string[] = [];
let logEntries: LogEntry[] = [];

function sessionManagerWarns(): LogEntry[] {
	return logEntries.filter((entry) => entry.component === COMPONENT && entry.level === "warn");
}

beforeEach(() => {
	clearTranscriptLineSkips();
	logEntries = [];
	setLogSink((entry) => {
		logEntries.push(entry);
	});
});

afterEach(() => {
	setLogSink(undefined);
	clearTranscriptLineSkips();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HEADER_LINE = JSON.stringify({
	type: "session",
	version: 3,
	id: "01contextloss-session",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/tmp/prime-under-test",
});

function transcriptFile(lines: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "prime-context-loss-"));
	roots.push(root);
	const dir = join(root, "sessions");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "01contextloss.jsonl");
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

function userLine(id: string, parentId: string | null): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text: `q-${id}` }], timestamp: 1 },
	});
}

function messageEntry(id: string, parentId: string | null): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text: `q-${id}` }], timestamp: 1 },
	};
}

function compactionEntry(id: string, parentId: string | null, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:02.000Z",
		summary: "summary",
		firstKeptEntryId,
		tokensBefore: 100,
	};
}

function legacyCompactionEntry(id: string, parentId: string | null): CompactionEntry {
	// Pre-anchor shape: migrateV1ToV2 leaves firstKeptEntryId unset when the old
	// index pointed at the header, so real transcripts can carry this.
	const entry = compactionEntry(id, parentId, "");
	delete (entry as { firstKeptEntryId?: string }).firstKeptEntryId;
	return entry;
}

describe("transcript line skip warnings on the load path", () => {
	it("warns once per lossy load with file, line and reason context", () => {
		const file = transcriptFile([HEADER_LINE, userLine("u1", null), "null", userLine("u2", "u1")]);
		loadEntriesFromFile(file);
		const warns = sessionManagerWarns();
		expect(warns).toHaveLength(1);
		expect(warns[0]?.msg).toContain("transcript lines skipped");
		expect(warns[0]?.sessionFile).toBe(file);
		expect(warns[0]?.skippedLines).toBe(1);
		expect(warns[0]?.firstSkippedLine).toBe(3);
		expect(warns[0]?.firstReason).toBeTruthy();
		// The consumable record carries the same context per skip.
		expect(getTranscriptLineSkips()).toEqual([{ sessionFile: file, line: 3, reason: "not an object" }]);
	});

	it("positive control: a clean transcript loads without a warning", () => {
		const file = transcriptFile([HEADER_LINE, userLine("u1", null)]);
		loadEntriesFromFile(file);
		expect(sessionManagerWarns()).toHaveLength(0);
		expect(getTranscriptLineSkips()).toHaveLength(0);
	});
});

describe("buildSessionContext loss warnings", () => {
	it("warns once when the parent chain is broken, and keeps the truncated context", () => {
		const entries: SessionEntry[] = [messageEntry("leaf-x", "gone-x")];
		const context = buildSessionContext(entries, "leaf-x");
		expect(context.messages).toHaveLength(1);
		const warns = sessionManagerWarns();
		expect(warns).toHaveLength(1);
		expect(warns[0]?.msg).toContain("chain broken");
		expect(warns[0]?.entryId).toBe("leaf-x");
		expect(warns[0]?.missingParentId).toBe("gone-x");
		// Warn-once: rebuilding the same damaged session must not re-log.
		buildSessionContext(entries, "leaf-x");
		expect(sessionManagerWarns()).toHaveLength(1);
	});

	it("positive control: an intact chain does not warn", () => {
		const entries: SessionEntry[] = [messageEntry("root-y", null), messageEntry("leaf-y", "root-y")];
		const context = buildSessionContext(entries, "leaf-y");
		expect(context.messages).toHaveLength(2);
		expect(sessionManagerWarns()).toHaveLength(0);
	});

	it("warns when firstKeptEntryId matches nothing on the walked path", () => {
		const entries: SessionEntry[] = [
			messageEntry("kept-z", null),
			compactionEntry("comp-z", "kept-z", "anchor-missing-z"),
			messageEntry("after-z", "comp-z"),
		];
		const context = buildSessionContext(entries, "after-z");
		// The summary still renders; the retained half collapsed to zero messages.
		expect(context.messages.length).toBeGreaterThan(0);
		const warns = sessionManagerWarns();
		expect(warns).toHaveLength(1);
		expect(warns[0]?.msg).toContain("firstKeptEntryId");
		expect(warns[0]?.compactionId).toBe("comp-z");
		expect(warns[0]?.firstKeptEntryId).toBe("anchor-missing-z");
	});

	it("does not warn for a resolvable anchor or a pre-anchor legacy compaction", () => {
		const resolvable: SessionEntry[] = [
			messageEntry("kept-w", null),
			compactionEntry("comp-w", "kept-w", "kept-w"),
			messageEntry("after-w", "comp-w"),
		];
		buildSessionContext(resolvable, "after-w");
		const legacy: SessionEntry[] = [
			messageEntry("kept-v", null),
			legacyCompactionEntry("comp-v", "kept-v"),
			messageEntry("after-v", "comp-v"),
		];
		buildSessionContext(legacy, "after-v");
		expect(sessionManagerWarns()).toHaveLength(0);
	});
});

describe("getBranch loss warnings (批E遗留②)", () => {
	const getBranchWarns = () => sessionManagerWarns().filter((entry) => entry.msg?.includes("getBranch"));

	it("warns once when the parent chain is broken, and keeps the truncated branch", () => {
		const file = transcriptFile([
			HEADER_LINE,
			userLine("gb-root", null),
			userLine("gb-mid", "gb-gone"),
			userLine("gb-leaf", "gb-mid"),
		]);
		const mgr = SessionManager.open(file);
		// A non-leaf walk skips the leaf-branch cache, so the second call walks again
		// and the warn-once bound is what keeps it quiet.
		const branch = mgr.getBranch("gb-mid");
		expect(branch.map((entry) => entry.id)).toEqual(["gb-mid"]);
		expect(getBranchWarns()).toHaveLength(1);
		expect(getBranchWarns()[0]?.entryId).toBe("gb-mid");
		expect(getBranchWarns()[0]?.missingParentId).toBe("gb-gone");
		mgr.getBranch("gb-mid");
		expect(getBranchWarns()).toHaveLength(1);
	});

	it("positive control: an intact chain does not warn", () => {
		const file = transcriptFile([HEADER_LINE, userLine("gb2-root", null), userLine("gb2-leaf", "gb2-root")]);
		const mgr = SessionManager.open(file);
		expect(mgr.getBranch().map((entry) => entry.id)).toEqual(["gb2-root", "gb2-leaf"]);
		expect(getBranchWarns()).toHaveLength(0);
	});
});
