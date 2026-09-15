import { describe, expect, it } from "vitest";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	stripMachineBlocks,
} from "../src/core/compaction/index.js";
import type { SessionEntry, SessionMessageEntry } from "../src/core/session-manager.js";

/**
 * MVS-3 (r32 model-visible): the post-compaction kernel roster notice is a
 * machine-authored `<ipython_state>` custom message. When the summarizer
 * restates it into the summary narrative, the next compaction fed that stale
 * roster back through previousSummary, where nothing protected it: it is not a
 * machine-block tag, so it could ride into the next narrative restated and
 * stale while the fresh notice piles up behind it.
 */

const NARRATIVE = "## Goal\nShip the release checklist\n\n## Critical Context\nvault path /srv/releases";

function messageEntry(text: string): SessionMessageEntry {
	return {
		type: "message",
		id: `k3r2-${text.length}-${text.charCodeAt(0)}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text, timestamp: Date.now() },
	};
}

describe("K3R2/MVS-3: <ipython_state> is protected like a machine block", () => {
	it("strips an ipython_state block out of a summary and keeps the narrative", () => {
		const summary = [
			NARRATIVE,
			"<ipython_state>",
			"These names are still defined: A, B",
			"Variables above the limit were removed: X",
			"</ipython_state>",
		].join("\n");

		const stripped = stripMachineBlocks(summary);
		expect(stripped).toBe(NARRATIVE);
		expect(stripped).not.toContain("ipython_state");
		expect(stripped).not.toContain("These names are still defined");
	});

	it("strips an ipython_state_restored block the same way", () => {
		const summary = `${NARRATIVE}\n\n<ipython_state_restored>\nrestored from snapshot: A\n</ipython_state_restored>`;
		expect(stripMachineBlocks(summary)).toBe(NARRATIVE);
	});

	it("does not feed a stale roster back through previousSummary on the next compaction", () => {
		// Compaction #1 stored a summary whose narrative carries the roster the
		// summarizer restated (tags and all). Compaction #2 must not hand that
		// stale roster back to the summarizer as previousSummary.
		const firstSummary = [
			NARRATIVE,
			"<ipython_state>",
			"These names are still defined: A, B",
			"</ipython_state>",
		].join("\n");
		const kept = [
			messageEntry("user msg 2 - kept by compaction1 ".repeat(12)),
			messageEntry("user msg 3 - kept by compaction1 ".repeat(12)),
		];
		const compaction1: SessionEntry = {
			type: "compaction",
			id: "k3r2-compaction-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: firstSummary,
			firstKeptEntryId: kept[0].id,
			tokensBefore: 10000,
		} as SessionEntry;
		const after = [messageEntry("user msg 4 (new after compaction1) ".repeat(12))];

		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 100 };
		const preparation = prepareCompaction([compaction1, ...kept, ...after], settings);
		expect(preparation).toBeDefined();

		// Before the fix, the stale roster rode previousSummary into the
		// summarizer, where the next narrative restated it (stale names and all).
		expect(preparation!.previousSummary).not.toContain("ipython_state");
		expect(preparation!.previousSummary).not.toContain("These names are still defined");
	});
});
