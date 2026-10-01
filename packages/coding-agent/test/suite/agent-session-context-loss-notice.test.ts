import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearTranscriptLineSkips } from "../../src/core/session-manager.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * 半落地尾巴① (记忆-1 surface half): session-manager's context-loss warnings
 * (transcript lines skipped on load, a broken entry chain, a compaction retention
 * anchor that matches nothing) used to be log-only. On load the session now writes
 * one user-visible `session_context_loss` notice into the transcript naming the
 * loss and its consequence, deduped by defect signature across resumes.
 */

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	clearTranscriptLineSkips();
});

function writeTranscript(harness: Harness, name: string, lines: object[]): string {
	const dir = join(harness.tempDir, "sessions");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

const header = {
	type: "session",
	version: 3,
	id: "01contextlossnotice",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/tmp/prime-under-test",
};

function userLine(id: string, parentId: string | null): object {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text: `q-${id}` }], timestamp: 1 },
	};
}

function contextLossNotices(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === "session_context_loss",
	);
}

async function openDamaged(lines: object[], name = "damaged.jsonl"): Promise<Harness> {
	// A scratch harness only for its temp dir; the damaged transcript is opened next.
	const scratch = await createHarness();
	harnesses.push(scratch);
	const file = writeTranscript(scratch, name, lines);
	const harness = await createHarness({ existingSessionFile: file });
	harnesses.push(harness);
	return harness;
}

describe("session context-loss notice on load (半落地尾巴①)", () => {
	it("notifies when the load skipped transcript lines, and names the count and the first cause", async () => {
		const scratch = await createHarness();
		harnesses.push(scratch);
		// A raw "null" line is the documented unparseable shape the loader skips.
		const file = join(scratch.tempDir, "sessions", "badlines.jsonl");
		mkdirSync(join(scratch.tempDir, "sessions"), { recursive: true });
		writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(userLine("u1", null))}\nnull\n`);
		const harness = await createHarness({ existingSessionFile: file });
		harnesses.push(harness);

		const notices = contextLossNotices(harness);
		expect(notices).toHaveLength(1);
		const content = String((notices[0] as { content: unknown }).content);
		expect(content).toContain("1 transcript line could not be read");
		expect(content).toContain("line 3");
		expect(content).toContain("missing from the context");
		expect(notices[0]).toMatchObject({ display: true });
		// Transcript + UI only: the notice itself must never become model input.
		expect(harness.session.agent.convertToLlm(notices)).toEqual([]);
	});

	it("notifies when the entry chain is broken, naming the missing parent", async () => {
		const harness = await openDamaged([header, userLine("root", null), userLine("leaf", "gone")]);

		const notices = contextLossNotices(harness);
		expect(notices).toHaveLength(1);
		const content = String((notices[0] as { content: unknown }).content);
		expect(content).toContain("entry chain is broken");
		expect(content).toContain("gone");
	});

	it("notifies when the newest compaction's retention anchor matches nothing", async () => {
		const compaction = {
			type: "compaction",
			id: "comp-1",
			parentId: "kept-1",
			timestamp: "2026-01-01T00:00:02.000Z",
			summary: "summary",
			firstKeptEntryId: "anchor-missing",
			tokensBefore: 100,
		};
		const harness = await openDamaged([header, userLine("kept-1", null), compaction, userLine("after-1", "comp-1")]);

		const notices = contextLossNotices(harness);
		expect(notices).toHaveLength(1);
		expect(String((notices[0] as { content: unknown }).content)).toContain("retained tail");
	});

	it("persists the notice and does not stack a second copy on the next resume of the same damage", async () => {
		const first = await openDamaged([header, userLine("root", null), userLine("leaf", "gone")], "dedup.jsonl");
		expect(contextLossNotices(first)).toHaveLength(1);
		const persisted = first.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "session_context_loss");
		expect(persisted).toHaveLength(1);
		const sessionFile = first.session.sessionFile!;
		first.session.dispose();

		const second = await createHarness({ existingSessionFile: sessionFile });
		harnesses.push(second);
		expect(contextLossNotices(second)).toHaveLength(1);
		expect(
			second.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "session_context_loss"),
		).toHaveLength(1);
	});

	it("positive control: an intact transcript loads without the notice", async () => {
		const harness = await openDamaged([header, userLine("root", null), userLine("leaf", "root")], "clean.jsonl");
		expect(contextLossNotices(harness)).toHaveLength(0);
	});
});
