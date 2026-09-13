import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateTextTokensByContent } from "../src/core/compaction/content-density.js";
import {
	buildUserRequestLedger,
	clipUserRequest,
	collectUserRequests,
	emptyUserRequestLedger,
	mergeUserRequests,
	parseUserRequests,
	pruneUserRequests,
	renderUserRequests,
	USER_REQUEST_COMPRESSED_CHARS,
	USER_REQUEST_ENTRY_MAX_CHARS,
	USER_REQUESTS_BUDGET_MINIMUM,
	USER_REQUESTS_TOKEN_BUDGET,
	type UserRequestLedger,
	userRequestLedgerFromDetails,
	userRequestsTokenBudget,
} from "../src/core/compaction/index.js";

function usage(): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function userBlocksMessage(texts: string[]): AgentMessage {
	return {
		role: "user",
		content: [
			...texts.map((text) => ({ type: "text" as const, text })),
			{ type: "image" as const, data: "x", mimeType: "image/png" },
		],
		timestamp: Date.now(),
	} as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "faux",
		provider: "faux",
		model: "faux-1",
	} as AssistantMessage as AgentMessage;
}

function bashMessage(command: string, output: string): AgentMessage {
	return {
		role: "bashExecution",
		command,
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

function toolResultMessage(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "tc1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

/** The rendered header has to fit inside the smallest budget with room for requests. */
const BLOCK_HEADER_CHARS = 280;

const INSTRUCTIONS = [
	"能不能提点速啊 他妈效率太差了",
	"不要居高临下的 就说一下我们做了什么嘛",
	'Error: Failed to resolve API key for provider "bailian" from shell command: cat /Users/a1/.prime/agent/bailian.key',
	"点了之后大概需要1~2秒才会进去界面 赶紧多个代理审查",
	"我们最开始是从8.0拉取的好像",
];

describe("user request collection", () => {
	it("keeps what the user said byte-for-byte, including CJK, quotes and newlines", () => {
		const ledger = buildUserRequestLedger({ messages: INSTRUCTIONS.map(userMessage), generation: 1 });

		expect(ledger.records.map((record) => record.text)).toEqual(INSTRUCTIONS);
		// Round trip through the rendered block: JSON encoding is what makes it byte-exact.
		expect(parseUserRequests(renderUserRequests(ledger))?.records.map((record) => record.text)).toEqual(INSTRUCTIONS);
	});

	it("keeps a multi-line instruction exactly, tabs and trailing spaces included", () => {
		const text = "first line\twith a tab\n\n  indented\ntrailing   ";
		const ledger = buildUserRequestLedger({ messages: [userMessage(text)], generation: 1 });

		expect(ledger.records[0].text).toBe(text);
		expect(parseUserRequests(renderUserRequests(ledger))?.records[0].text).toBe(text);
	});

	it("joins the text blocks of one message and ignores its images", () => {
		const ledger = buildUserRequestLedger({ messages: [userBlocksMessage(["part one", "part two"])], generation: 1 });
		expect(ledger.records).toHaveLength(1);
		expect(ledger.records[0].text).toBe("part one\npart two");
	});

	it("takes a user-initiated command but not its output, and not what the assistant said", () => {
		const ledger = buildUserRequestLedger({
			messages: [
				bashMessage("git log --oneline -3", "31964efbd docs(fork): log the daemon sweep fixes"),
				assistantMessage("I will run the tests for you"),
				toolResultMessage("Tests  4603 failed"),
			],
			generation: 1,
		});

		expect(ledger.records).toHaveLength(1);
		expect(ledger.records[0].text).toBe("git log --oneline -3");
		expect(ledger.records[0].kind).toBe("bash");
	});

	it("collapses a re-sent message into a repeat count instead of a second record", () => {
		const ledger = buildUserRequestLedger({
			messages: [userMessage("赶紧多个代理审查"), userMessage("赶紧多个代理审查")],
			generation: 1,
		});

		expect(ledger.records).toHaveLength(1);
		expect(ledger.records[0].repeats).toBe(2);
	});

	it("collapses duplicates inside a single slice before the ledger is merged", () => {
		const collected = collectUserRequests([userMessage("same"), userMessage("same"), userMessage("other")], 1);
		expect(collected.map((record) => [record.text, record.repeats])).toEqual([
			["same", 2],
			["other", 1],
		]);
	});

	it("skips empty and whitespace-only messages", () => {
		expect(
			buildUserRequestLedger({ messages: [userMessage("   "), userMessage("")], generation: 1 }).records,
		).toEqual([]);
	});

	it("clips a pasted transcript to head and tail and says how much went", () => {
		const paste = `${"A".repeat(2000)}\nTHE SENTINEL LINE\n${"B".repeat(2000)}`;
		const clipped = clipUserRequest(paste, USER_REQUEST_ENTRY_MAX_CHARS);

		expect(clipped.text.length).toBeLessThanOrEqual(USER_REQUEST_ENTRY_MAX_CHARS + 80);
		expect(clipped.originalChars).toBe(paste.length);
		expect(clipped.text).toContain("A".repeat(200));
		expect(clipped.text).toContain("B".repeat(200));
		expect(clipped.text).toContain("characters elided");
		expect(clipUserRequest("short", USER_REQUEST_ENTRY_MAX_CHARS)).toEqual({ text: "short" });
		// A cap too small for head plus tail still degrades to a prefix, not to a throw.
		expect(clipUserRequest(paste, 20).text.length).toBeLessThanOrEqual(20);
	});

	it("collects in slice order and stamps the generation", () => {
		const collected = collectUserRequests([userMessage("one"), userMessage("two")], 4);
		expect(collected.map((record) => [record.text, record.generation, record.sequence])).toEqual([
			["one", 4, 0],
			["two", 4, 1],
		]);
	});
});

describe("user request ledger", () => {
	it("carries a request forward when the next slice never mentions it", () => {
		const first = buildUserRequestLedger({ messages: [userMessage("禁止 push，只能本地提交")], generation: 1 });
		const second = buildUserRequestLedger({ messages: [userMessage("continue")], generation: 2, previous: first });

		expect(second.records.map((record) => record.text)).toEqual(["禁止 push，只能本地提交", "continue"]);
		expect(second.records[0].generation).toBe(1);
		expect(second.records[1].generation).toBe(2);
		expect(second.generation).toBe(2);
	});

	it("keeps every request for five generations of compaction that add nothing", () => {
		const first = buildUserRequestLedger({ messages: INSTRUCTIONS.map(userMessage), generation: 1 });
		let carried: UserRequestLedger = first;
		for (let generation = 2; generation <= 6; generation++) {
			carried = buildUserRequestLedger({ messages: [], generation, previous: carried });
			expect(carried.records.map((record) => record.text)).toEqual(INSTRUCTIONS);
			expect(carried.elided).toBe(0);
			// The rendered-text fallback path carries the same content.
			const viaText = parseUserRequests(renderUserRequests(carried));
			expect(viaText?.records.map((record) => record.text)).toEqual(INSTRUCTIONS);
		}
		expect(parseUserRequests(renderUserRequests(carried))?.generation).toBe(6);
	});

	it("merges without a previous ledger and starts empty", () => {
		expect(emptyUserRequestLedger(1).records).toEqual([]);
		expect(mergeUserRequests(undefined, collectUserRequests([userMessage("one")], 1), 1).records).toHaveLength(1);
	});

	it("drops a pasted log before it drops a one-line instruction", () => {
		const directive = "不要 push";
		const messages: AgentMessage[] = [userMessage(directive)];
		for (let i = 0; i < 40; i++) {
			messages.push(userMessage(`pasted log ${i}\n${"x".repeat(900)}\nend of paste ${i}`));
		}
		const wide = buildUserRequestLedger({ messages, generation: 1, tokenBudget: 100_000 });
		expect(wide.records).toHaveLength(41);
		expect(wide.elided).toBe(0);

		const tight = pruneUserRequests(wide, 400);
		expect(tight.records.map((record) => record.text)).toContain(directive);
		expect(tight.records.length).toBeLessThan(wide.records.length);
		expect(tight.elided).toBe(wide.records.length - tight.records.length);
		expect(tight.elided).toBeGreaterThan(0);
	});

	it("compresses the oldest requests before dropping any", () => {
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 30; i++) {
			messages.push(userMessage(`request ${i} ${"y".repeat(600)}`));
		}
		const wide = buildUserRequestLedger({ messages, generation: 1, tokenBudget: 100_000 });
		expect(wide.records).toHaveLength(30);
		expect(wide.records[0].text.length).toBeGreaterThan(USER_REQUEST_COMPRESSED_CHARS);

		// Find the smallest budget that still keeps every request: at that budget the
		// ledger must have compressed rather than dropped, and one token less must drop.
		let low = 1;
		let high = estimateTextTokensByContent(renderUserRequests(wide));
		while (low < high) {
			const mid = (low + high) >> 1;
			if (pruneUserRequests(wide, mid).records.length === 30) high = mid;
			else low = mid + 1;
		}
		const smallestFullBudget = low;
		const squeezed = pruneUserRequests(wide, smallestFullBudget);

		expect(squeezed.records).toHaveLength(30);
		expect(squeezed.elided).toBe(0);
		expect(squeezed.records[0].text.length).toBeLessThanOrEqual(USER_REQUEST_COMPRESSED_CHARS + 80);
		expect(squeezed.records[0].originalChars).toBe(wide.records[0].text.length);
		expect(estimateTextTokensByContent(renderUserRequests(squeezed))).toBeLessThanOrEqual(smallestFullBudget);
		const oneTokenShorter = pruneUserRequests(wide, smallestFullBudget - 1);
		expect(oneTokenShorter.records.length).toBeLessThan(30);
		expect(oneTokenShorter.elided).toBe(30 - oneTokenShorter.records.length);
	});

	it("counts what it had to drop, so the block never implies completeness", () => {
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 200; i++) messages.push(userMessage(`short instruction number ${i}`));
		const ledger = buildUserRequestLedger({ messages, generation: 1, tokenBudget: 500 });

		expect(ledger.records.length).toBeLessThan(200);
		expect(ledger.elided).toBe(200 - ledger.records.length);
		// The newest instructions are the ones that stay.
		expect(ledger.records[ledger.records.length - 1].text).toBe("short instruction number 199");
		expect(renderUserRequests(ledger)).toContain(`elided="${ledger.elided}"`);
	});

	it("never renders past its token budget", () => {
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 120; i++)
			messages.push(userMessage(`第 ${i} 条指令：不要推送，先跑测试，然后把结果贴回来给我看`));
		const ledger = buildUserRequestLedger({ messages, generation: 1, tokenBudget: 300 });

		expect(ledger.records.length).toBeGreaterThan(0);
		expect(renderUserRequests(ledger).length).toBeLessThanOrEqual(300 * 4);
	});

	it("renders nothing for an empty ledger", () => {
		expect(renderUserRequests(emptyUserRequestLedger(1))).toBe("");
	});

	it("skips malformed lines and reports no block when there is none", () => {
		const ledger = buildUserRequestLedger({ messages: INSTRUCTIONS.map(userMessage), generation: 2 });
		const corrupted = renderUserRequests(ledger).replace(
			"</user-requests>",
			'{not json}\n{"t":""}\n{"g":1,"s":9,"k":"user","r":1,"t":"recovered line"}\n</user-requests>',
		);
		const parsed = parseUserRequests(corrupted);

		expect(parsed?.records.map((record) => record.text)).toEqual([...INSTRUCTIONS, "recovered line"]);
		expect(parseUserRequests("## Goal\nno block here")).toBeUndefined();
	});

	it("recovers from entry details and refuses a malformed payload", () => {
		const ledger = buildUserRequestLedger({ messages: INSTRUCTIONS.map(userMessage), generation: 3 });
		expect(userRequestLedgerFromDetails({ userRequests: ledger }, 9)?.records).toEqual(ledger.records);
		expect(userRequestLedgerFromDetails({ userRequests: ledger }, 9)?.generation).toBe(3);
		expect(userRequestLedgerFromDetails({ readFiles: [] }, 9)).toBeUndefined();
		expect(userRequestLedgerFromDetails({ userRequests: { records: "nope" } }, 9)).toBeUndefined();
		expect(userRequestLedgerFromDetails(undefined, 9)).toBeUndefined();
		expect(
			userRequestLedgerFromDetails({ userRequests: { generation: 5, records: [{ text: "kept", kind: "bash" }] } }, 9)
				?.records,
		).toEqual([{ text: "kept", generation: 5, sequence: 0, repeats: 1, originalChars: undefined, kind: "bash" }]);
	});

	it("sizes itself from the context the compaction keeps", () => {
		expect(userRequestsTokenBudget(20000)).toBe(6000);
		expect(userRequestsTokenBudget(2000)).toBe(1000);
		expect(userRequestsTokenBudget(100000)).toBe(16000);
		// Degenerate windows still get a block that can hold its header plus a request.
		expect(userRequestsTokenBudget(0)).toBe(USER_REQUESTS_BUDGET_MINIMUM);
		expect(userRequestsTokenBudget(200)).toBe(USER_REQUESTS_BUDGET_MINIMUM);
		expect(USER_REQUESTS_BUDGET_MINIMUM * 4).toBeGreaterThan(BLOCK_HEADER_CHARS);
		expect(USER_REQUESTS_TOKEN_BUDGET).toBe(6000);
	});
});
