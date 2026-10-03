/**
 * 记忆-4: a /tree branch summary used to append only the file blocks, so SHAs,
 * thresholds and the user's own words rode the same low-fidelity narrative
 * channel compaction was measured to lose. The branch path now builds the same
 * <fact-appendix>/<user-requests> ledgers over the summarized slice, on small
 * fixed budgets, and harvests file operations from tool-result details even
 * though tool results never become summarizer messages.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateBranchSummary, prepareBranchEntries } from "../src/core/compaction/branch-summarization.js";
import type { SessionMessageEntry } from "../src/core/session-manager.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function testModel(id = "branch-blocks-model"): Model<Api> {
	return {
		name: id,
		id,
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	} as Model<Api>;
}

let entryCounter = 0;
let entryParentId: string | null = null;

function messageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `branch-block-entry-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: entryParentId,
		timestamp: new Date().toISOString(),
		message,
	};
	entryParentId = id;
	return entry;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		api: "faux",
		provider: "faux",
		model: "faux-1",
	} as AgentMessage;
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const USER_WORDS = "please keep the retry budget at four";

function branchEntries(): SessionMessageEntry[] {
	entryParentId = null;
	return [
		messageEntry(userMessage(USER_WORDS)),
		messageEntry(assistantMessage(`Fixed in commit ${SHA}, read the config first.`)),
		// Tool results are not summarizer messages, but their details carry the
		// kernel's read/edit reports; the branch file lists must still see them.
		messageEntry({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "ipython",
			content: [{ type: "text", text: "ok" }],
			details: {
				activities: [{ id: "read-1", kind: "read", label: "src/read-via-kernel.ts", status: "ok", startedAt: 1 }],
				diffs: [{ path: "src/edited-via-kernel.ts", oldStr: "a", newStr: "b" }],
			},
			isError: false,
			timestamp: Date.now(),
		} as AgentMessage),
	];
}

beforeEach(() => {
	completeSimpleMock.mockReset();
	completeSimpleMock.mockResolvedValue({
		stopReason: "stop",
		content: [{ type: "text", text: "## Goal\nExplore the branch\n" }],
		usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
	});
});

describe("branch summary machine blocks (记忆-4)", () => {
	it("harvests file operations from tool-result details outside the message slice", () => {
		const { messages, fileOps } = prepareBranchEntries(branchEntries(), 0);
		// Tool results stay out of the summarizer input...
		expect(messages.some((m) => m.role === "toolResult")).toBe(false);
		// ...but their structured reports still feed the file lists.
		expect([...fileOps.read]).toEqual(["src/read-via-kernel.ts"]);
		expect([...fileOps.edited]).toEqual(["src/edited-via-kernel.ts"]);
	});

	it("appends fact-appendix and user-requests ledgers after the narrative", async () => {
		const result = await generateBranchSummary(branchEntries(), {
			model: testModel(),
			apiKey: "test-key",
			signal: new AbortController().signal,
		});
		expect(result.error).toBeUndefined();
		const summary = result.summary ?? "";
		expect(summary).toContain("Summary of that exploration:");
		// The verbatim ledger keeps the user's own words out of the narrative channel.
		expect(summary).toContain("<user-requests");
		expect(summary).toContain(USER_WORDS);
		// The fact ledger keeps the SHA byte-exact.
		expect(summary).toContain("<fact-appendix");
		expect(summary).toContain(SHA);
		// The file blocks still render, now with the kernel read channel filled.
		expect(summary).toContain("<read-files>\nsrc/read-via-kernel.ts\n</read-files>");
		expect(summary).toContain("<modified-files>\nsrc/edited-via-kernel.ts\n</modified-files>");
		// Machine blocks anchor the tail, after the model's narrative.
		expect(summary.indexOf("<fact-appendix")).toBeGreaterThan(summary.indexOf("## Goal"));
		expect(summary.indexOf("<user-requests")).toBeGreaterThan(summary.indexOf("## Goal"));
	});

	it("labels the user-requests block as the abandoned branch's words, not live obligations", async () => {
		// The block's compaction header tells the reader to "treat every unresolved
		// instruction and reported problem here as a live obligation". Inside a branch
		// summary that header promotes the abandoned branch's requests to current
		// instructions: after returning, the model would start finishing work the user
		// navigated away from.
		const result = await generateBranchSummary(branchEntries(), {
			model: testModel(),
			apiKey: "test-key",
			signal: new AbortController().signal,
		});
		expect(result.error).toBeUndefined();
		const summary = result.summary ?? "";
		expect(summary).toContain("<user-requests");
		expect(summary).toContain(USER_WORDS);
		expect(summary).not.toContain("live obligation");
		expect(summary).toContain("left behind");
	});
});
