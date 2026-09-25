import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildCompactionAppendix,
	type CompactionDetails,
	type CompactionPreparation,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	parseFactAppendix,
	parseUserRequests,
	prepareCompaction,
	stripMachineBlocks,
} from "../src/core/compaction/index.js";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "../src/core/session-manager.js";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return { ...actual, completeSimple: completeSimpleMock };
});

const ANCHOR_SHA = "4871d9223bac88ac6da9796f4b0c4d33b7566178";
const ANCHOR_PATH = "/tmp/ma_audit/rollback-anchor.md";
const ANCHOR_NUMBER = "reserveTokens: 16384";
const USER_INSTRUCTION = "不要 push，先跑测试，然后把 4871d9223 的结果贴回来";
const USER_REPORT =
	'Error: Failed to resolve API key for provider "bailian" from shell command: cat /Users/a1/.prime/agent/bailian.key';

/** What a lossy summarizer does in the wild: restates a SHA with one digit added. */
const CORRUPTING_NARRATIVE = `## Goal
Ship the audit fixes.

## Critical Context
- Rolled back to 4871d92223 and the worktree grew to 372-399MB.
`;

function createUsage(): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function assistantMessage(
	text: string,
	toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>,
): AgentMessage {
	const content: AssistantMessage["content"] = [{ type: "text", text } as AssistantMessage["content"][number]];
	for (const call of toolCalls ?? []) {
		content.push({
			type: "toolCall",
			id: `tc-${content.length}`,
			name: call.name,
			arguments: call.arguments,
		} as never);
	}
	return {
		role: "assistant",
		content,
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	} as AssistantMessage as AgentMessage;
}

function toolResultMessage(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "tc-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

/** The ipython tool result shape the kernel edit skill produces: details.diffs[]. */
function kernelEditToolResult(paths: string[]): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "tc-1",
		toolName: "ipython",
		content: [{ type: "text", text: paths.map((path) => `Edited ${path}`).join("\n") }],
		details: { diffs: paths.map((path) => ({ path, oldStr: "a", newStr: "b", startLine: 1 })) },
		isError: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

let entryCounter = 0;
let lastId: string | null = null;

beforeEach(() => {
	entryCounter = 0;
	lastId = null;
	completeSimpleMock.mockReset();
	completeSimpleMock.mockImplementation(async () => ({
		role: "assistant",
		content: [{ type: "text", text: "## Goal\nan honest narrative" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	}));
});

function messageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `entry-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

function compactionEntry(summary: string, firstKeptEntryId: string, details?: CompactionDetails): CompactionEntry {
	const id = `entry-${entryCounter++}`;
	const entry: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 100000,
		details,
	};
	lastId = id;
	return entry;
}

/** A slice carrying the facts the audit found disappearing. */
function auditedTurn(): SessionEntry[] {
	return [
		messageEntry(userMessage(`${USER_INSTRUCTION}\n${USER_REPORT}`)),
		messageEntry(
			assistantMessage(`read ${ANCHOR_PATH} then revert ${ANCHOR_SHA}`, [
				{ name: "write", arguments: { path: "/tmp/ma_audit/patched.ts" } },
			]),
		),
		messageEntry(toolResultMessage(`npm run check exited 0 with ${ANCHOR_NUMBER} and 900s of runtime`)),
		messageEntry(assistantMessage(`done, ${"x".repeat(2000)}`)),
	];
}

function sentPrompts(): string[] {
	return completeSimpleMock.mock.calls.map((call: unknown[]) => {
		const request = call[1] as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
		return request.messages
			.flatMap((message) => message.content)
			.filter((block): block is { type: string; text: string } => typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
	});
}

/** Retained window small enough to cut, large enough that both blocks get a real budget. */
const settings = (): typeof DEFAULT_COMPACTION_SETTINGS => ({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 2000 });

/** A trailing turn bigger than the retained window, so the cut lands on its user message. */
const TAIL_FILLER = "x".repeat(12000);

describe("compaction summary carries machine-generated blocks", () => {
	it("appends the fact appendix and the verbatim user requests after the narrative", async () => {
		const entries = [
			...auditedTurn(),
			messageEntry(userMessage("next task")),
			messageEntry(assistantMessage(TAIL_FILLER)),
		];
		const preparation = prepareCompaction(entries, settings(), 200000);
		expect(preparation).toBeDefined();

		const result = await compact(preparation!, createModel(), "test-key");
		const facts = parseFactAppendix(result.summary);
		const requests = parseUserRequests(result.summary);

		expect(result.summary.startsWith("## Goal")).toBe(true);
		expect(facts?.records.some((record) => record.kind === "sha" && record.value === ANCHOR_SHA)).toBe(true);
		expect(facts?.records.some((record) => record.kind === "path" && record.value === ANCHOR_PATH)).toBe(true);
		expect(facts?.records.some((record) => record.kind === "number" && record.value === "reserveTokens=16384")).toBe(
			true,
		);
		expect(
			facts?.records.some((record) => record.kind === "error" && record.value.includes("Failed to resolve API key")),
		).toBe(true);
		expect(requests?.records.some((record) => record.text.includes(USER_INSTRUCTION))).toBe(true);
		// The file lists keep working alongside the new blocks.
		expect(result.summary).toContain("<modified-files>");
		expect(result.summary).toContain("/tmp/ma_audit/patched.ts");
	});

	it("carries kernel-reported edits into <modified-files> and the compaction details", async () => {
		const KERNEL_EDIT = "/tmp/ma_audit/kernel-edit.ts";
		const entries = [
			messageEntry(userMessage("edit through the kernel")),
			messageEntry(assistantMessage("editing", [{ name: "ipython", arguments: { code: "await edit(...)" } }])),
			messageEntry(kernelEditToolResult([KERNEL_EDIT])),
			messageEntry(userMessage("next task")),
			messageEntry(assistantMessage(TAIL_FILLER)),
		];
		const preparation = prepareCompaction(entries, settings(), 200000);
		expect(preparation).toBeDefined();

		const result = await compact(preparation!, createModel(), "test-key");

		// The default toolset performs edits inside the kernel: without the diff
		// channel <modified-files> never renders, and the model loses the file
		// orientation the block exists to carry across the cold boundary.
		expect(result.summary).toContain("<modified-files>");
		expect(result.summary).toContain(KERNEL_EDIT);
		expect((result.details as CompactionDetails).modifiedFiles).toContain(KERNEL_EDIT);
	});

	it("harvests a split turn's prefix as well as the history it summarizes", () => {
		// A split turn keeps its suffix, but the prefix is leaving the context too, so
		// its facts and its user words have to be harvested from the prefix slice.
		const prefixSha = "aaaaaaaa1234567890aaaaaaaa1234567890abcd";
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept",
			messagesToSummarize: [assistantMessage(`history mentions ${ANCHOR_PATH}`)],
			turnPrefixMessages: [
				userMessage("prefix instruction: 先别 push"),
				assistantMessage(`prefix reverted ${prefixSha}`),
			],
			isSplitTurn: true,
			tokensBefore: 1000,
			fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
			settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 20000 },
			generation: 2,
			keepRecentTokens: 20000,
		};
		const appendix = buildCompactionAppendix(preparation);

		expect(appendix.facts.records.some((record) => record.value === prefixSha)).toBe(true);
		expect(appendix.facts.records.some((record) => record.value === ANCHOR_PATH)).toBe(true);
		expect(appendix.userRequests.records.some((record) => record.text.includes("先别 push"))).toBe(true);
		expect(appendix.facts.generation).toBe(2);
	});

	it("persists both ledgers in the entry details for the next generation", async () => {
		const entries = [
			...auditedTurn(),
			messageEntry(userMessage("next task")),
			messageEntry(assistantMessage(TAIL_FILLER)),
		];
		const preparation = prepareCompaction(entries, settings(), 200000);
		const result = await compact(preparation!, createModel(), "test-key");
		const details = result.details as CompactionDetails;

		expect(details.facts?.generation).toBe(1);
		expect(details.facts?.records.length).toBeGreaterThan(0);
		expect(details.userRequests?.records.length).toBeGreaterThan(0);
		expect(preparation?.generation).toBe(1);
	});

	it("keeps the truth when the summarizer restates a SHA with a digit added", async () => {
		completeSimpleMock.mockImplementation(async () => ({
			role: "assistant",
			content: [{ type: "text", text: CORRUPTING_NARRATIVE }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: createUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		}));
		const entries = [
			...auditedTurn(),
			messageEntry(userMessage("next task")),
			messageEntry(assistantMessage(TAIL_FILLER)),
		];
		const preparation = prepareCompaction(entries, settings(), 200000);

		const result = await compact(preparation!, createModel(), "test-key");
		const narrative = stripMachineBlocks(result.summary);
		const facts = parseFactAppendix(result.summary);

		// The model's copy is wrong, as measured in the audit; the machine copy is not.
		expect(narrative).toContain("4871d92223");
		expect(narrative).toContain("372-399MB");
		expect(facts?.records.some((record) => record.value === ANCHOR_SHA)).toBe(true);
		expect(result.summary).toContain(ANCHOR_SHA);
	});

	it("never sends a previous summary's machine blocks back to the model", async () => {
		const entries = [
			...auditedTurn(),
			messageEntry(userMessage("next task")),
			messageEntry(assistantMessage(TAIL_FILLER)),
		];
		const first = await compact(prepareCompaction(entries, settings(), 200000)!, createModel(), "test-key");
		expect(first.summary).toContain("<fact-appendix");
		completeSimpleMock.mockClear();

		const continued: SessionEntry[] = [
			...entries,
			compactionEntry(first.summary, first.firstKeptEntryId, first.details as CompactionDetails),
			messageEntry(userMessage("a later task")),
			messageEntry(assistantMessage(`still tracking the anchor ${"y".repeat(11000)}`)),
			messageEntry(userMessage("and one more")),
			messageEntry(assistantMessage(`z${"z".repeat(11000)}`)),
		];
		const preparation = prepareCompaction(continued, settings(), 200000);
		expect(preparation?.previousSummary).toBeDefined();
		expect(preparation?.previousSummary).not.toContain("<fact-appendix");
		expect(preparation?.previousSummary).not.toContain("<user-requests");
		expect(preparation?.previousSummary).toContain("an honest narrative");

		await compact(preparation!, createModel(), "test-key");
		const prompt = sentPrompts().join("\n");
		const previousSection = /<previous-summary>\n([\s\S]*?)\n<\/previous-summary>/.exec(prompt)?.[1] ?? "";

		// The narrative goes back to the model; the machine blocks do not.
		expect(previousSection).toContain("an honest narrative");
		expect(previousSection).not.toContain("<fact-appendix");
		expect(previousSection).not.toContain("<user-requests");
		expect(previousSection).not.toContain("<modified-files>");
		expect(previousSection).not.toContain(ANCHOR_PATH);
		expect(prompt).not.toContain('{"k":"sha"');
		expect(prompt).not.toContain("不要 push");
		// The prompt does name the blocks, so the model knows not to restate them.
		expect(prompt).toContain("Machine-generated blocks are appended after your summary");
	});

	it("carries the ledger forward through five generations of destructive summarization", async () => {
		const entries: SessionEntry[] = [...auditedTurn()];
		let summary = "";
		for (let generation = 1; generation <= 5; generation++) {
			entries.push(messageEntry(userMessage(`task for generation ${generation}`)));
			entries.push(messageEntry(assistantMessage(`${"filler".repeat(2400)} generation ${generation}`)));
			// The summarizer is adversarial: it returns a narrative that keeps nothing.
			completeSimpleMock.mockImplementation(async () => ({
				role: "assistant",
				content: [{ type: "text", text: "## Goal\nnothing worth repeating" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: createUsage(),
				stopReason: "stop",
				timestamp: Date.now(),
			}));
			const preparation = prepareCompaction(entries, settings(), 200000);
			expect(preparation, `generation ${generation} prepared`).toBeDefined();
			expect(preparation?.generation).toBe(generation);
			const result = await compact(preparation!, createModel(), "test-key");
			summary = result.summary;
			entries.push(compactionEntry(summary, result.firstKeptEntryId, result.details as CompactionDetails));

			const facts = parseFactAppendix(summary);
			const requests = parseUserRequests(summary);
			expect(facts?.generation).toBe(generation);
			expect(
				facts?.records.some((record) => record.value === ANCHOR_SHA),
				`sha at generation ${generation}`,
			).toBe(true);
			expect(
				facts?.records.some((record) => record.value === ANCHOR_PATH),
				`path at generation ${generation}`,
			).toBe(true);
			expect(
				facts?.records.some((record) => record.value === "reserveTokens=16384"),
				`number at generation ${generation}`,
			).toBe(true);
			expect(
				requests?.records.some((record) => record.text.includes("不要 push")),
				`instruction at generation ${generation}`,
			).toBe(true);
			expect(requests?.records.some((record) => record.text.includes("Failed to resolve API key"))).toBe(true);
		}
		// The generation-5 block is byte-identical to the generation-1 block's facts.
		expect(summary).toContain(ANCHOR_SHA);
		// The report is JSON-encoded inside the block; decoded it is byte-identical.
		expect(parseUserRequests(summary)?.records.some((record) => record.text.includes(USER_REPORT))).toBe(true);
		expect(parseFactAppendix(summary)?.records.length).toBeGreaterThan(3);
	});

	it("recovers both ledgers and the file lists from a summary whose details are gone", async () => {
		const entries = [
			...auditedTurn(),
			messageEntry(userMessage("next task")),
			messageEntry(assistantMessage(TAIL_FILLER)),
		];
		const first = await compact(prepareCompaction(entries, settings(), 200000)!, createModel(), "test-key");
		expect((first.details as CompactionDetails).facts).toBeDefined();

		// An entry written by an older build, or stripped by a migration: no details at all.
		const continued: SessionEntry[] = [
			...entries,
			compactionEntry(first.summary, first.firstKeptEntryId),
			messageEntry(userMessage("a later task")),
			messageEntry(assistantMessage(`y${"y".repeat(11000)}`)),
			messageEntry(userMessage("and one more")),
			messageEntry(assistantMessage(`z${"z".repeat(11000)}`)),
		];
		const preparation = prepareCompaction(continued, settings(), 200000);
		expect(preparation?.previousFacts?.records.some((record) => record.value === ANCHOR_SHA)).toBe(true);
		expect(preparation?.previousUserRequests?.records.some((record) => record.text.includes("不要 push"))).toBe(true);

		const second = await compact(preparation!, createModel(), "test-key");
		expect(second.summary).toContain(ANCHOR_SHA);
		expect(second.summary).toContain("不要 push");
		// The file list recovered from the rendered block survives the round trip too.
		expect(second.summary).toContain("/tmp/ma_audit/patched.ts");
		expect(
			(second.details as CompactionDetails).readFiles.length +
				(second.details as CompactionDetails).modifiedFiles.length,
		).toBeGreaterThan(0);
	});

	it("stamps an undated fact record with the generation being written", async () => {
		const entries = [
			...auditedTurn(),
			messageEntry(userMessage("next task")),
			messageEntry(assistantMessage(TAIL_FILLER)),
		];
		const first = await compact(prepareCompaction(entries, settings(), 200000)!, createModel(), "test-key");
		const details = first.details as CompactionDetails;
		// A ledger written without stamps next to one that carries a generation: the
		// undated records inherit the generation being written, not a hardcoded 1.
		const continued: SessionEntry[] = [
			...entries,
			compactionEntry(first.summary, first.firstKeptEntryId, {
				readFiles: details.readFiles,
				modifiedFiles: details.modifiedFiles,
				userRequests: { ...details.userRequests!, generation: 5 },
				facts: { generation: 0 as number, records: [{ kind: "sha", value: "cafe1234", weight: 2 }] } as never,
			}),
			messageEntry(userMessage("a later task")),
			messageEntry(assistantMessage(`y${"y".repeat(11000)}`)),
			messageEntry(userMessage("and one more")),
			messageEntry(assistantMessage(`z${"z".repeat(11000)}`)),
		];
		const preparation = prepareCompaction(continued, settings(), 200000);

		expect(preparation?.generation).toBe(6);
		expect(preparation?.previousFacts?.records[0]).toMatchObject({
			value: "cafe1234",
			firstGeneration: 6,
			lastGeneration: 6,
		});
	});

	it("numbers generations from what the previous entry recorded", async () => {
		const entries = [
			...auditedTurn(),
			messageEntry(userMessage("next task")),
			messageEntry(assistantMessage(TAIL_FILLER)),
		];
		const first = await compact(prepareCompaction(entries, settings(), 200000)!, createModel(), "test-key");
		const details = first.details as CompactionDetails;
		const continued: SessionEntry[] = [
			...entries,
			compactionEntry(first.summary, first.firstKeptEntryId, {
				...details,
				facts: { ...details.facts!, generation: 7 },
			}),
			messageEntry(userMessage("a later task")),
			messageEntry(assistantMessage(`y${"y".repeat(11000)}`)),
			messageEntry(userMessage("and one more")),
			messageEntry(assistantMessage(`z${"z".repeat(11000)}`)),
		];
		const preparation = prepareCompaction(continued, settings(), 200000);
		expect(preparation?.generation).toBe(8);
	});

	it("carries a stated decision into the compacted summary, and into the next generation's ledger", async () => {
		const DECISION = "结论是回滚到 4871d9223bac88ac6da9796f4b0c4d33b7566178 之前，理由是主分支已经带了那次修复。";
		const entries = [
			messageEntry(userMessage("先查一下这次回归的根因")),
			messageEntry(assistantMessage(`查清了。${DECISION}`)),
			messageEntry(userMessage("next task")),
			messageEntry(assistantMessage(TAIL_FILLER)),
		];
		const preparation = prepareCompaction(entries, settings(), 200000);
		expect(preparation).toBeDefined();

		// The decision is authored assistant prose, so the ledger takes it and the
		// block carries it into the context the continuation actually reads.
		const result = await compact(preparation!, createModel(), "test-key");
		const decisions = (parseFactAppendix(result.summary)?.records ?? []).filter(
			(record) => record.kind === "decision",
		);
		expect(decisions.map((record) => record.value)).toContain(DECISION);
		expect(decisions[0].firstGeneration).toBe(1);
		expect((result.details as CompactionDetails).facts?.records.some((r) => r.value === DECISION)).toBe(true);

		// Nothing carries it in the summarizer's own narrative - it returns one line -
		// so a second generation can only keep it through the ledger.
		completeSimpleMock.mockClear();
		const continued: SessionEntry[] = [
			...entries,
			compactionEntry(result.summary, result.firstKeptEntryId, result.details as CompactionDetails),
			messageEntry(userMessage("a later task")),
			messageEntry(assistantMessage(`y${"y".repeat(11000)}`)),
			messageEntry(userMessage("and one more")),
			messageEntry(assistantMessage(`z${"z".repeat(11000)}`)),
		];
		const next = prepareCompaction(continued, settings(), 200000);
		expect(next?.previousFacts?.records.some((record) => record.value === DECISION)).toBe(true);
		const second = await compact(next!, createModel(), "test-key");
		const carried = (parseFactAppendix(second.summary)?.records ?? []).filter((record) => record.kind === "decision");
		expect(carried.map((record) => record.value)).toContain(DECISION);
		expect(carried).toHaveLength(1);
		// `g` stamps when a value was mentioned, not when it was carried: the slice of
		// generation 2 no longer holds the message that stated it, so the anchor keeps
		// its generation-1 mention and rides along instead of looking freshly restated.
		expect(carried[0].firstGeneration).toBe(1);
		expect(carried[0].lastGeneration).toBe(1);
	});

	it("keeps a decision through five generations of destructive summarization", async () => {
		const DECISION = "我们决定采用 PostgreSQL 作为主数据库，理由是事务一致性和现成运维。";
		const entries: SessionEntry[] = [
			messageEntry(userMessage("选一个数据库")),
			messageEntry(assistantMessage(`调研完了。${DECISION}`)),
		];
		let summary = "";
		for (let generation = 1; generation <= 5; generation++) {
			entries.push(messageEntry(userMessage(`task for generation ${generation}`)));
			entries.push(messageEntry(assistantMessage(`${"filler".repeat(2400)} generation ${generation}`)));
			// The summarizer keeps nothing: only the deterministic block can carry it.
			completeSimpleMock.mockImplementation(async () => ({
				role: "assistant",
				content: [{ type: "text", text: "## Goal\nnothing worth repeating" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: createUsage(),
				stopReason: "stop",
				timestamp: Date.now(),
			}));
			const preparation = prepareCompaction(entries, settings(), 200000);
			expect(preparation, `generation ${generation} prepared`).toBeDefined();
			const result = await compact(preparation!, createModel(), "test-key");
			summary = result.summary;
			entries.push(compactionEntry(summary, result.firstKeptEntryId, result.details as CompactionDetails));

			const decisions = (parseFactAppendix(summary)?.records ?? []).filter((record) => record.kind === "decision");
			expect(decisions.map((record) => record.value), `decision at generation ${generation}`).toContain(DECISION);
			// One anchor, one slot: the narrative never restates it and the ledger never
			// books a second copy of it.
			expect(decisions, `decision count at generation ${generation}`).toHaveLength(1);
			// Carried, not re-mentioned: `g` stays at the generation that stated it, so
			// the block tells a reader the anchor is old rather than freshly restated.
			expect(decisions[0].firstGeneration).toBe(1);
			expect(decisions[0].lastGeneration).toBe(1);
			expect(decisions[0].value).toBe(DECISION);
		}
	});

	it("adds no decision record, and no empty block, when the slice states none", async () => {
		const entries = [
			messageEntry(userMessage("just reading")),
			messageEntry(assistantMessage("Reading the file now.")),
			messageEntry(userMessage("next task")),
			messageEntry(assistantMessage(TAIL_FILLER)),
		];
		const preparation = prepareCompaction(entries, settings(), 200000);
		const result = await compact(preparation!, createModel(), "test-key");
		const records = parseFactAppendix(result.summary)?.records ?? [];
		expect(records.filter((record) => record.kind === "decision")).toHaveLength(0);
		expect((result.details as CompactionDetails).facts?.records.filter((r) => r.kind === "decision")).toHaveLength(0);
	});
});
