import {
	appendFileSync,
	copyFileSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeOwnAndTotalUsage } from "../src/core/context-tree.js";
import {
	loadEntriesFromFile,
	readSessionInfo,
	type SessionHeader,
	type SessionInfo,
} from "../src/core/session-manager.js";
import { sessionUsageSummaryFrom } from "../src/core/usage.js";

let dir: string;
let counter = 0;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-incremental-scan-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function headerLine(): string {
	const header: SessionHeader = {
		type: "session",
		id: "session-under-test",
		version: 3,
		timestamp: new Date(0).toISOString(),
		cwd: "/tmp/project",
	};
	return `${JSON.stringify(header)}\n`;
}

function messageLine(role: "user" | "assistant", text: string, timestamp: number): string {
	return `${JSON.stringify({
		type: "message",
		id: `entry-${++counter}`,
		parentId: null,
		message: { role, content: [{ type: "text", text }], timestamp },
	})}\n`;
}

function modelChangeLine(provider: string, modelId: string): string {
	return `${JSON.stringify({ type: "model_change", id: `entry-${++counter}`, parentId: null, provider, modelId })}\n`;
}

function assistantModelLine(provider: string, model: string, text: string, timestamp: number): string {
	return `${JSON.stringify({
		type: "message",
		id: `entry-${++counter}`,
		parentId: null,
		message: { role: "assistant", content: [{ type: "text", text }], timestamp, provider, model },
	})}\n`;
}

function namedLine(name: string): string {
	return `${JSON.stringify({ type: "session_info", id: `entry-${++counter}`, parentId: null, name })}\n`;
}

/**
 * A whole Usage record: every field addAssistantUsage() reads must be present,
 * or the totals come out NaN. cost.total is an integer so the expectations below
 * stay exact instead of needing toBeCloseTo().
 */
function usageLine(input: number, output: number) {
	return {
		input,
		output,
		cacheRead: 1,
		cacheWrite: 2,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: input },
	};
}

/**
 * A cold read of identical bytes at an untouched path, which never resumes and
 * so reports what a full scan would. Every incremental result is compared
 * against this rather than against hand-written expectations.
 */
async function coldRead(path: string): Promise<SessionInfo | null> {
	const copy = join(dir, `cold-${++counter}.jsonl`);
	copyFileSync(path, copy);
	const info = await readSessionInfo(copy);
	return info ? { ...info, path } : info;
}

async function expectMatchesFullScan(path: string): Promise<SessionInfo | null> {
	const incremental = await readSessionInfo(path);
	expect(incremental).toEqual(await coldRead(path));
	return incremental;
}

describe("readSessionInfo incremental rescan", () => {
	it("reports what a full scan would after each append", async () => {
		const path = join(dir, "session.jsonl");
		writeFileSync(path, headerLine() + messageLine("user", "first question", 1000), "utf8");

		let info = await expectMatchesFullScan(path);
		expect(info?.messageCount).toBe(1);
		expect(info?.firstMessage).toBe("first question");

		appendFileSync(path, messageLine("assistant", "first answer", 2000));
		info = await expectMatchesFullScan(path);
		expect(info?.messageCount).toBe(2);

		appendFileSync(path, namedLine("renamed session"));
		appendFileSync(path, messageLine("user", "second question", 3000));
		info = await expectMatchesFullScan(path);
		expect(info?.messageCount).toBe(3);
		expect(info?.name).toBe("renamed session");
		expect(info?.firstMessage).toBe("first question");
		expect(info?.modified.getTime()).toBe(3000);
	});

	it("keeps the newest value when a later entry supersedes an earlier one", async () => {
		const path = join(dir, "session.jsonl");
		writeFileSync(path, headerLine() + namedLine("original"), "utf8");
		expect((await readSessionInfo(path))?.name).toBe("original");

		appendFileSync(path, namedLine("updated"));
		expect((await expectMatchesFullScan(path))?.name).toBe("updated");
	});

	it("counts a line still being written exactly once", async () => {
		const path = join(dir, "session.jsonl");
		writeFileSync(path, headerLine() + messageLine("user", "complete", 1000), "utf8");
		expect((await readSessionInfo(path))?.messageCount).toBe(1);

		// A writer mid-append: the trailing line has no newline yet.
		const pending = messageLine("assistant", "still streaming", 2000);
		const torn = pending.slice(0, pending.length - 5);
		appendFileSync(path, torn);
		expect((await readSessionInfo(path))?.messageCount).toBe(1);

		appendFileSync(path, pending.slice(torn.length));
		const info = await expectMatchesFullScan(path);
		expect(info?.messageCount).toBe(2);
	});

	it("rescans from scratch when the file is replaced rather than appended", async () => {
		const path = join(dir, "session.jsonl");
		writeFileSync(path, headerLine() + messageLine("user", "before rewrite", 1000), "utf8");
		expect((await readSessionInfo(path))?.messageCount).toBe(1);

		// A rewrite renames a fresh inode over the path, and can be longer than
		// what it replaces, so growth alone must not be read as an append.
		const replacement = join(dir, "replacement.jsonl");
		writeFileSync(
			replacement,
			headerLine() + messageLine("user", "after rewrite", 5000) + messageLine("assistant", "reply", 6000),
			"utf8",
		);
		renameSync(replacement, path);

		const info = await expectMatchesFullScan(path);
		expect(info?.messageCount).toBe(2);
		expect(info?.firstMessage).toBe("after rewrite");
	});

	it("returns null for a file whose first entry is not a session header", async () => {
		const path = join(dir, "headerless.jsonl");
		writeFileSync(path, messageLine("user", "orphan", 1000), "utf8");
		expect(await readSessionInfo(path)).toBeNull();

		appendFileSync(path, messageLine("assistant", "still orphan", 2000));
		expect(await readSessionInfo(path)).toBeNull();
	});

	/**
	 * The #2003 usage aggregates are part of what a scan accumulates, so a resumed
	 * scan has to restore them or the reported totals shrink on every append. Each
	 * append is a separate pass: three appends in one write would only ever exercise
	 * the full scan and prove nothing about resume.
	 */
	it("reports the same usage totals on a resumed scan as on a full one", async () => {
		const path = join(dir, "usage.jsonl");
		writeFileSync(path, headerLine() + messageLine("user", "question", 1000), "utf8");
		await expectMatchesFullScan(path);

		// An assistant turn carrying usage. Its entry id is what the attribution fold keys on.
		const assistantId = `entry-${++counter}`;
		appendFileSync(
			path,
			`${JSON.stringify({
				type: "message",
				id: assistantId,
				parentId: null,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
					timestamp: 2000,
					usage: usageLine(100, 20),
				},
			})}\n`,
			"utf8",
		);
		// Non-zero fixture on purpose: sessionUsageSummaryFrom() returns undefined for
		// all-zero totals, and undefined on both sides would pass the comparison vacuously.
		let info = await expectMatchesFullScan(path);
		expect(info?.usage).toBeDefined();
		// 100 input + 1 cacheRead + 2 cacheWrite; 20 output; cost.total 100.
		expect(info?.usage).toEqual({ inputTokens: 103, outputTokens: 20, cost: 100 });

		// A summarization entry carrying its own usage: the grow-only accumulator.
		appendFileSync(
			path,
			`${JSON.stringify({
				type: "compaction",
				id: `entry-${++counter}`,
				parentId: null,
				summary: "s",
				firstKeptEntryId: assistantId,
				tokensBefore: 5000,
				usage: usageLine(10, 5),
			})}\n`,
			"utf8",
		);
		info = await expectMatchesFullScan(path);
		// (100 + 10) input + (1 + 1) cacheRead + (2 + 2) cacheWrite; 20 + 5 output; cost 100 + 10.
		expect(info?.usage).toEqual({ inputTokens: 116, outputTokens: 25, cost: 110 });

		// Attribution arriving in a LATER pass than its target. Only a restored
		// assistantUsageById makes has(targetId) true here, exactly like a full scan;
		// without it the target's usage is silently never folded and never subtracted.
		appendFileSync(
			path,
			`${JSON.stringify({
				type: "child_usage_attributed",
				id: `entry-${++counter}`,
				parentId: null,
				targetId: assistantId,
				childUsage: usageLine(30, 4),
				aggregateUsage: usageLine(130, 24),
			})}\n`,
			"utf8",
		);
		info = await expectMatchesFullScan(path);
		expect(info?.usage).toBeDefined();
		// The target's 100/20 is overwritten by the aggregate 130/24, then the child 30/4 is
		// subtracted back out, so own spend stays 110/25/110 plus the compaction — the fold is
		// value-neutral on the tokens it accounts for, and drops cacheRead/cacheWrite by one each.
		expect(info?.usage).toEqual({ inputTokens: 113, outputTokens: 25, cost: 110 });
	});

	/**
	 * An imported or hand-reordered transcript can place child_usage_attributed
	 * lines before the assistant line they annotate — the writer never produces
	 * this order, but the loader folds it anyway (two passes over the file), and
	 * the writer's whole-file rewrite leaves the assistant line carrying the
	 * aggregate usage. That combination is where a one-pass scan that silently
	 * drops the early attributions counts the child spend as own spend: the
	 * session list would report a different number than /usage and /context for
	 * the same bytes. The scan must fold inverted-order attributions too.
	 */
	it("folds attributions that precede their target like the loader does", async () => {
		const path = join(dir, "inverted-attribution.jsonl");
		const assistantId = `entry-${++counter}`;
		// Post-rewrite disk form: the assistant line carries the aggregate usage
		// (100/16 own + 30/4 child1 + 7/4 child2), not the original turn.
		const assistantLine = {
			type: "message",
			id: assistantId,
			parentId: null,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				timestamp: 2000,
				usage: usageLine(137, 30),
			},
		};
		const attributionLine = (id: string, child: number, aggregate: number) =>
			`${JSON.stringify({
				type: "child_usage_attributed",
				id,
				parentId: null,
				targetId: assistantId,
				childUsage: usageLine(child, 4),
				aggregateUsage: usageLine(aggregate, 24),
			})}
`;
		writeFileSync(
			path,
			`${headerLine()}${attributionLine(`entry-${++counter}`, 30, 130)}${attributionLine(`entry-${++counter}`, 7, 137)}${JSON.stringify(assistantLine)}
`,
			"utf8",
		);

		// Fold side: the loader applies the attributions regardless of line order,
		// then the context-tree basis subtracts the child spend back out.
		const entries = loadEntriesFromFile(path).filter((e) => e.type !== "session");
		expect(entries.length).toBe(3);
		const { ownUsage } = computeOwnAndTotalUsage(entries, entries);
		// Non-zero fixture: sessionUsageSummaryFrom() returns undefined for
		// all-zero totals, which would make the comparison pass vacuously.
		expect(ownUsage.cost.total).toBe(100);

		const info = await readSessionInfo(path);
		expect(info?.usage).toEqual(sessionUsageSummaryFrom(ownUsage));
		expect(info?.usage).toEqual({ inputTokens: 100, outputTokens: 16, cost: 100 });
	});

	/**
	 * A live session whose transcript holds a tool result far longer than the
	 * 64 KiB read chunk, with ordinary entries after it — the shape that makes a
	 * scan's stopping offset fall behind the real file position. That offset is
	 * the resume point for the next append, so the whole tail of already-counted
	 * entries is re-read and counted a second time, which is what makes the
	 * agents list show inflated counts and wrong token totals for exactly the
	 * sessions that are still being appended to.
	 */
	it("reports what a full scan would after appending past an oversized entry", async () => {
		const path = join(dir, "chunked.jsonl");
		writeFileSync(path, headerLine() + messageLine("user", "first question", 1000), "utf8");
		expect((await readSessionInfo(path))?.messageCount).toBe(1);

		// One entry past SESSION_LIST_PARSE_MAX_LINE_CHARS: it spans many read
		// chunks and is counted by the oversized-entry path, exactly like a real
		// multi-megabyte tool result.
		const bigText = "B".repeat(2 * 1024 * 1024);
		appendFileSync(
			path,
			`${JSON.stringify({
				type: "message",
				id: `entry-${++counter}`,
				parentId: null,
				message: {
					role: "assistant",
					content: [{ type: "text", text: bigText }],
					timestamp: 2000,
				},
			})}\n`,
			"utf8",
		);
		// Ordinary entries AFTER the oversized one: these are the ones a lagging
		// resume point re-reads on the next append.
		const tailEntries = 20;
		for (let i = 0; i < tailEntries; i++) {
			appendFileSync(
				path,
				`${JSON.stringify({
					type: "message",
					id: `entry-${++counter}`,
					parentId: null,
					message: {
						role: "assistant",
						content: [{ type: "text", text: `answer ${i}` }],
						timestamp: 3000 + i,
						usage: usageLine(10, 5),
					},
				})}\n`,
				"utf8",
			);
		}
		let info = await expectMatchesFullScan(path);
		expect(info?.messageCount).toBe(2 + tailEntries);

		// The append a live session makes next: only the resumed scan sees it.
		appendFileSync(
			path,
			`${JSON.stringify({
				type: "message",
				id: `entry-${++counter}`,
				parentId: null,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "final answer" }],
					timestamp: 4000,
					usage: usageLine(10, 5),
				},
			})}\n`,
			"utf8",
		);
		info = await expectMatchesFullScan(path);
		// One message per ordinary entry; the oversized entry itself carries no usage.
		expect(info?.messageCount).toBe(3 + tailEntries);
		// usageLine(10, 5) is 10 input + 1 cacheRead + 2 cacheWrite, for every
		// ordinary entry including the one appended after the scan's last offset.
		expect(info?.usage?.inputTokens).toBe((10 + 3) * (tailEntries + 1));
		expect(info?.firstMessage).toBe("first question");
	});

	/**
	 * An in-place rewrite (truncate and write again) keeps the inode and can grow
	 * the file, so inode plus growth alone reads as an append. The recorded
	 * stopping point is then applied to a file it was never derived from, and if
	 * it no longer sits on a line boundary the scan must start over: resuming
	 * mid-record keeps entries and names from the replaced file while silently
	 * dropping the record it landed inside.
	 */
	it("rescans from scratch when the file was rewritten in place and grew", async () => {
		const path = join(dir, "in-place-rewrite.jsonl");
		writeFileSync(
			path,
			headerLine() + messageLine("user", "before rewrite", 1000) + namedLine("legacy name"),
			"utf8",
		);
		const before = statSync(path).size;
		const ino = statSync(path).ino;
		const first = await readSessionInfo(path);
		expect(first?.messageCount).toBe(1);
		expect(first?.name).toBe("legacy name");

		// Same inode, longer, and the old stopping point now falls inside a line.
		writeFileSync(
			path,
			headerLine() + messageLine("user", "after rewrite", 5000) + messageLine("assistant", "x".repeat(4096), 6000),
			"utf8",
		);
		expect(statSync(path).ino).toBe(ino);
		expect(statSync(path).size).toBeGreaterThan(before);
		// State the premise: the byte before the recorded offset is not a newline.
		expect(readFileSync(path)[before - 1]).not.toBe(0x0a);

		const info = await expectMatchesFullScan(path);
		expect(info?.messageCount).toBe(2);
		expect(info?.name).toBeUndefined();
		expect(info?.firstMessage).toBe("after rewrite");
	});
});

describe("readSessionInfo recorded model", () => {
	/**
	 * The recorded model is a fold of the transcript, not session metadata: a
	 * `model_change` entry records a switch, and an assistant message records the
	 * model that produced it, so the last one written wins (#2148).
	 */
	it("reports the last recorded model from model_change entries and assistant messages", async () => {
		const path = join(dir, "recorded-model.jsonl");
		writeFileSync(
			path,
			headerLine() +
				modelChangeLine("openai", "gpt-4o") +
				messageLine("user", "hi", 1000) +
				assistantModelLine("prime-inference", "glm-4.7", "answer", 2000),
			"utf8",
		);
		expect((await readSessionInfo(path))?.model).toEqual({ provider: "prime-inference", modelId: "glm-4.7" });

		// A later switch moves the recorded model, and the resumed scan agrees with
		// a cold one instead of keeping the value it folded first.
		appendFileSync(path, modelChangeLine("anthropic", "claude-sonnet-4.5"));
		expect((await expectMatchesFullScan(path))?.model).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4.5",
		});
	});

	/**
	 * Control side of the same fold: a session that never ran a model records
	 * nothing, and an assistant message without a provider/model pair (older
	 * transcripts, hand-written fixtures) must not invent one.
	 */
	it("leaves the recorded model undefined when the transcript carries none", async () => {
		const bare = join(dir, "no-model.jsonl");
		writeFileSync(bare, headerLine() + messageLine("user", "hi", 1000), "utf8");
		expect((await readSessionInfo(bare))?.model).toBeUndefined();

		const partial = join(dir, "partial-model.jsonl");
		writeFileSync(
			partial,
			headerLine() +
				`${JSON.stringify({
					type: "message",
					id: `entry-${++counter}`,
					parentId: null,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "answer" }],
						timestamp: 2000,
						model: "glm-4.7",
					},
				})}\n`,
			"utf8",
		);
		expect((await readSessionInfo(partial))?.model).toBeUndefined();
	});
});
