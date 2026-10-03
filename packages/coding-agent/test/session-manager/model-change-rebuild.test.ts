import { describe, expect, it } from "vitest";
import { isModelChangeMessage } from "../../src/core/messages.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

/**
 * wave-40 must-1 (rebuild half): the context rebuild synthesizes a model-change
 * notice from the durable model_change ledger, but only when it can see the model
 * the branch was on before the switch. Pre-compaction ledger entries are
 * summarized away, so the first switch after a compaction used to compare against
 * nothing and synthesize no notice at all: the rebuilt context carried messages
 * written by one model while the next request silently ran on another. The
 * rebuild now seeds the comparison from the last model_change before the
 * compaction point.
 */
describe("model-change notice rebuild across a compaction", () => {
	it("synthesizes the post-compaction switch back to the pre-compaction model", () => {
		const manager = SessionManager.inMemory();
		manager.appendModelChange("primary-provider", "primary-model");
		manager.appendMessage(userMsg("work on it"));
		manager.appendMessage(assistantMsg("on it"));
		// A mid-session switch (fallback episode) that the compaction summarizes away.
		manager.appendModelChange("backup-provider", "backup-model");
		const keptId = manager.appendMessage(assistantMsg("backup answering"));
		manager.appendCompaction("summary of the pre-compaction era", keptId, 4200);
		// After the compaction the episode ends: back to the primary.
		manager.appendModelChange("primary-provider", "primary-model");
		manager.appendMessage(assistantMsg("primary again"));

		const messages = manager.buildSessionContext().messages;
		const notices = messages.filter(
			(message) => isModelChangeMessage(message) && message.details.modelId === "primary-model",
		);
		expect(notices).toHaveLength(1);
		// The notice stands at the switch point: after the summarized era, before the
		// first answer the restored primary produced.
		const noticeIndex = messages.indexOf(notices[0]!);
		const summaryIndex = messages.findIndex((message) => message.role === "compactionSummary");
		expect(summaryIndex).toBeGreaterThanOrEqual(0);
		expect(noticeIndex).toBeGreaterThan(summaryIndex);
		expect(messages[messages.length - 1]?.role).toBe("assistant");
		expect(noticeIndex).toBeLessThan(messages.length - 1);
	});

	it("still suppresses a post-compaction repeat of the pre-compaction model", () => {
		const manager = SessionManager.inMemory();
		manager.appendModelChange("primary-provider", "primary-model");
		manager.appendMessage(userMsg("work on it"));
		manager.appendMessage(assistantMsg("on it"));
		manager.appendModelChange("backup-provider", "backup-model");
		const keptId = manager.appendMessage(assistantMsg("backup answering"));
		manager.appendCompaction("summary", keptId, 4200);
		// A same-model record after the compaction is adoption bookkeeping, not a switch.
		manager.appendModelChange("backup-provider", "backup-model");
		manager.appendMessage(assistantMsg("still the backup"));

		const messages = manager.buildSessionContext().messages;
		expect(messages.filter((message) => isModelChangeMessage(message))).toHaveLength(0);
	});

	it("keeps the creation prefix quiet without a compaction", () => {
		const manager = SessionManager.inMemory();
		manager.appendModelChange("primary-provider", "primary-model");
		manager.appendMessage(userMsg("hello"));
		manager.appendMessage(assistantMsg("hi"));

		const messages = manager.buildSessionContext().messages;
		expect(messages.filter((message) => isModelChangeMessage(message))).toHaveLength(0);
	});
});
