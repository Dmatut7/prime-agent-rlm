import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PiAi from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	getGlobalHarnessStateDir,
	getRefinementFailuresPath,
	loadHarnessState,
	type RefinementParseFailureRecord,
	recordRefinementParseFailure,
	refineHarness,
	reviewAutoRefine,
} from "../src/core/refinement/index.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

const RAW_BYTE_LIMIT = 8 * 1024;

let tempDirs: string[] = [];
let agentDir = "";
let previousAgentDir: string | undefined;

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "prime-agent-refinement-json-"));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	completeSimpleMock.mockReset();
	agentDir = makeTempDir();
	previousAgentDir = process.env[ENV_AGENT_DIR];
	// Parse-failure evidence is appended under the ambient agent dir, so isolate it
	// instead of writing into the real ~/.prime/agent.
	process.env[ENV_AGENT_DIR] = agentDir;
});

afterEach(() => {
	vi.restoreAllMocks();
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function failuresPath(): string {
	return getRefinementFailuresPath(getGlobalHarnessStateDir());
}

function readFailureRecords(): RefinementParseFailureRecord[] {
	const content = readFileSync(failuresPath(), "utf8");
	const lines = content.split("\n").filter((line) => line.trim().length > 0);
	return lines.map((line) => JSON.parse(line) as RefinementParseFailureRecord);
}

function refineModel(): Model<"openai-completions"> {
	return {
		id: "openai/gpt-5.5",
		name: "GPT 5.5",
		api: "openai-completions",
		provider: "prime-inference",
		baseUrl: "https://inference.primeintellect.ai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "prime-inference",
		model: "openai/gpt-5.5",
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
	};
}

/**
 * Turn correctly escaped JSON into the shape the failure was reported from: the
 * same text with every escaped control character replaced by the raw character a
 * model emits when it writes a literal newline into a sentence.
 */
function withRawControlChars(json: string): string {
	return json
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\u0001/g, "\u0001");
}

function memoryProposal(content: string) {
	return {
		summary: "记录老板授权",
		rationale: "老板在对话里明确授权",
		expectedOutcome: "未来会话直接照办",
		edits: [
			{
				action: "create",
				kind: "memory",
				id: "boss_authorization",
				title: "老板授权",
				content,
			},
		],
	};
}

/** The parser's own message, so "throws the original error" is engine-independent. */
function jsonParseMessage(text: string): string {
	try {
		JSON.parse(text);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error(`test fixture must be invalid JSON: ${text.slice(0, 80)}`);
}

/** Runs /refine against whatever reply the caller queued on the model mock. */
async function refineWithMockedReply() {
	return refineHarness([], loadHarnessState(makeTempDir()), [], refineModel(), "api-key", {});
}

describe("refinement JSON recovery from raw control characters", () => {
	it("applies a proposal whose content holds a literal newline", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const content = "第一行：对官方上游的反馈帖由根代理自主发布\n第二行：发后给老板留链接";
		const reply = JSON.stringify(memoryProposal(content), null, 2).replace(/\\n/g, "\n");
		completeSimpleMock.mockResolvedValueOnce(assistantText(reply));
		const state = loadHarnessState(makeTempDir());

		const result = await refineHarness([], state, [], refineModel(), "api-key", {});

		expect(result.appliedEdits[0]).toMatchObject({ action: "create", kind: "memory", applied: true });
		expect(state.entries.memory.boss_authorization.content).toBe(content);
		// The recovery is announced with the digest of exactly the candidate that was
		// repaired, so the warn line reconciles with the preserved raw output.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain("raw control characters");
		expect(warn.mock.calls[0][0]).toContain(sha256(reply));
		// A recovered refinement is not a failure: no evidence record is written.
		expect(existsSync(failuresPath())).toBe(false);
	});

	it("recovers tab, carriage return, and C1-free control escapes without loss", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const content = "制表\there\r回车\u0001控制\n换行";
		const payload = memoryProposal(content);
		const reply = `\`\`\`json\n${withRawControlChars(JSON.stringify(payload))}\n\`\`\``;
		completeSimpleMock.mockResolvedValueOnce(assistantText(reply));
		const state = loadHarnessState(makeTempDir());

		await refineHarness([], state, [], refineModel(), "api-key", {});

		// Every escaped form must round-trip to the same characters the proposal held.
		expect(state.entries.memory.boss_authorization.content).toBe(content);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("recovers a JSON object wrapped in prose", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const content = "老板偏好：回复要短\n不要表情";
		const payload = memoryProposal(content);
		const reply = `Here is the refinement:\n${withRawControlChars(JSON.stringify(payload))}\nLet me know if it looks wrong.`;
		completeSimpleMock.mockResolvedValueOnce(assistantText(reply));
		const state = loadHarnessState(makeTempDir());

		await refineHarness([], state, [], refineModel(), "api-key", {});

		expect(state.entries.memory.boss_authorization.content).toBe(content);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("recovers an auto-refine review whose rationale holds a literal newline", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const payload = {
			shouldRefine: true,
			rationale: "老板授权需要跨会话记住\n属于稳定的用户偏好",
			instructions: "记为全局记忆",
		};
		completeSimpleMock.mockResolvedValueOnce(assistantText(withRawControlChars(JSON.stringify(payload))));

		const review = await reviewAutoRefine([], loadHarnessState(makeTempDir()), [], refineModel(), "api-key", {
			reason: "turn_interval",
			turnsSinceLastReview: 4,
		});

		expect(review.shouldRefine).toBe(true);
		expect(review.rationale).toBe(payload.rationale);
		expect(review.instructions).toBe(payload.instructions);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("stays silent and leaves no evidence for a well-formed reply", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const content = "第一行\n第二行";
		completeSimpleMock.mockResolvedValueOnce(assistantText(JSON.stringify(memoryProposal(content))));
		const state = loadHarnessState(makeTempDir());

		await refineHarness([], state, [], refineModel(), "api-key", {});

		expect(state.entries.memory.boss_authorization.content).toBe(content);
		expect(warn).not.toHaveBeenCalled();
		expect(existsSync(failuresPath())).toBe(false);
	});

	it("does not repair a defect that is not a raw control character", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const reply = '{"summary": "s", "edits": [oops]}';
		completeSimpleMock.mockResolvedValueOnce(assistantText(reply));

		await expect(refineWithMockedReply()).rejects.toThrow(
			`the model did not return valid JSON: ${jsonParseMessage(reply)}`,
		);
		expect(warn).not.toHaveBeenCalled();
	});

	it("leaves control characters outside string literals alone", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// A form feed between tokens is not JSON whitespace, and escaping it would
		// mean rewriting structure rather than string contents.
		const reply = '{"summary":\u000c"s", "edits": []}';
		completeSimpleMock.mockResolvedValueOnce(assistantText(reply));

		await expect(refineWithMockedReply()).rejects.toThrow(
			`the model did not return valid JSON: ${jsonParseMessage(reply)}`,
		);
		expect(warn).not.toHaveBeenCalled();
	});

	it("reports truncation instead of repairing a reply cut inside a string", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const reply = `{
  "summary": "s",
  "edits": [
    { "action": "create", "kind": "memory", "id": "a", "title": "t", "content": "first
line" },
    { "action": "create", "kind": "memory", "id": "b", "title": "t2", "content": "second`;
		completeSimpleMock.mockResolvedValueOnce(assistantText(reply));

		await expect(refineWithMockedReply()).rejects.toThrow(/stopped before completing its JSON object/);
		expect(warn).not.toHaveBeenCalled();
		// Truncation is still a lost refinement, so the raw reply is preserved.
		expect(readFailureRecords()[0].raw).toBe(reply);
	});
});

describe("refinement parse failure evidence", () => {
	it("preserves the raw reply next to the parse error", async () => {
		const reply = 'Here is the result: {"edits": [oops]}';
		completeSimpleMock.mockResolvedValueOnce(assistantText(reply));

		await expect(refineWithMockedReply()).rejects.toThrow(/did not return valid JSON/);

		expect(failuresPath()).toBe(join(agentDir, "harness", "refinement-failures.jsonl"));
		const records = readFailureRecords();
		expect(records).toHaveLength(1);
		expect(records[0].source).toBe("refinement");
		expect(records[0].raw).toBe(reply);
		expect(records[0].rawChars).toBe(reply.length);
		expect(records[0].truncated).toBe(false);
		expect(records[0].sha256).toBe(sha256(reply));
		expect(records[0].error).toMatch(/did not return valid JSON/);
		expect(Number.isNaN(Date.parse(records[0].ts))).toBe(false);
	});

	it("keeps the original parser error when escaping does not make the reply parse", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Both defects at once: a raw newline inside a string and a bare token. The
		// repair runs, does not help, and must not mask the parser's own diagnosis.
		const reply = '{"summary":"第一行\n第二行","edits":[oops]}';
		completeSimpleMock.mockResolvedValueOnce(assistantText(reply));

		await expect(refineWithMockedReply()).rejects.toThrow(
			`the model did not return valid JSON: ${jsonParseMessage(reply)}`,
		);
		expect(warn).not.toHaveBeenCalled();
		expect(readFailureRecords()[0].raw).toBe(reply);
	});

	it("preserves the raw reply of a malformed auto-refine review", async () => {
		const reply = '{"shouldRefine": yes}';
		completeSimpleMock.mockResolvedValueOnce(assistantText(reply));

		await expect(
			reviewAutoRefine([], loadHarnessState(makeTempDir()), [], refineModel(), "api-key", {
				reason: "compact",
				turnsSinceLastReview: 2,
			}),
		).rejects.toThrow(/did not return valid JSON/);

		const records = readFailureRecords();
		expect(records).toHaveLength(1);
		expect(records[0].source).toBe("auto-refine-review");
		expect(records[0].raw).toBe(reply);
	});

	it("preserves the raw reply when the refiner returns no JSON object", async () => {
		const reply = "I could not find anything worth persisting this time.";
		completeSimpleMock.mockResolvedValueOnce(assistantText(reply));

		await expect(refineWithMockedReply()).rejects.toThrow(/Refiner did not return a JSON object/);

		expect(readFailureRecords()[0]).toMatchObject({ source: "refinement", raw: reply });
	});

	it("bounds the preserved reply in bytes and marks the record truncated", async () => {
		const reply = `{"summary":"${"x".repeat(20_000)}","edits":[oops]}`;
		completeSimpleMock.mockResolvedValueOnce(assistantText(reply));

		await expect(refineWithMockedReply()).rejects.toThrow(/did not return valid JSON/);

		const content = readFileSync(failuresPath(), "utf8");
		expect(content.trim().split("\n")).toHaveLength(1);
		const [record] = readFailureRecords();
		expect(record.truncated).toBe(true);
		expect(record.rawChars).toBe(reply.length);
		expect(Buffer.byteLength(record.raw, "utf8")).toBeLessThanOrEqual(RAW_BYTE_LIMIT);
		expect(reply.startsWith(record.raw)).toBe(true);
		// The digest covers the full reply, so the bound is visible, not silent.
		expect(record.sha256).toBe(sha256(reply));
	});

	it("bounds a CJK-heavy reply by bytes without splitting a character", async () => {
		// Three bytes per character: a character-count bound would preserve ~24KiB.
		const reply = `{"summary":"${"记".repeat(6_000)}","edits":[oops]}`;
		completeSimpleMock.mockResolvedValueOnce(assistantText(reply));

		await expect(refineWithMockedReply()).rejects.toThrow(/did not return valid JSON/);

		const [record] = readFailureRecords();
		expect(record.truncated).toBe(true);
		expect(record.rawChars).toBe(reply.length);
		expect(Buffer.byteLength(record.raw, "utf8")).toBeLessThanOrEqual(RAW_BYTE_LIMIT);
		expect(reply.startsWith(record.raw)).toBe(true);
		// The cut lands on a character boundary: no lone surrogate, no replacement.
		expect(record.raw).not.toMatch(/[\ud800-\udfff\ufffd]/);
	});

	it("appends one line per failure", async () => {
		const first = '{"edits": [oops]}';
		const second = '{"edits": [also bad]}';
		completeSimpleMock.mockResolvedValueOnce(assistantText(first));
		await expect(refineWithMockedReply()).rejects.toThrow(/did not return valid JSON/);
		completeSimpleMock.mockResolvedValueOnce(assistantText(second));
		await expect(refineWithMockedReply()).rejects.toThrow(/did not return valid JSON/);

		const records = readFailureRecords();
		expect(records.map((record) => record.raw)).toEqual([first, second]);
	});

	it("writes the evidence log with private permissions", async () => {
		const reply = '{"edits": [oops]}';
		completeSimpleMock.mockResolvedValueOnce(assistantText(reply));

		await expect(refineWithMockedReply()).rejects.toThrow(/did not return valid JSON/);

		expect(statSync(join(agentDir, "harness")).mode & 0o777).toBe(0o700);
		expect(statSync(failuresPath()).mode & 0o777).toBe(0o600);
	});

	it("keeps the parse error when the evidence log cannot be written", async () => {
		// A directory where the append-only log must go makes every append fail.
		mkdirSync(failuresPath(), { recursive: true });
		const reply = '{"edits": [oops]}';
		completeSimpleMock.mockResolvedValueOnce(assistantText(reply));

		await expect(refineWithMockedReply()).rejects.toThrow(/did not return valid JSON/);
	});

	it("keeps the parse error when the agent dir is not usable", async () => {
		const blocker = join(makeTempDir(), "not-a-dir");
		writeFileSync(blocker, "a regular file where the agent dir should be\n");
		process.env[ENV_AGENT_DIR] = blocker;
		const reply = '{"edits": [oops]}';
		completeSimpleMock.mockResolvedValueOnce(assistantText(reply));

		await expect(refineWithMockedReply()).rejects.toThrow(/did not return valid JSON/);
		expect(existsSync(join(blocker, "harness"))).toBe(false);
	});

	it("records nothing where persistent harness storage is unsupported", () => {
		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		try {
			const harnessStateDir = join(makeTempDir(), "harness");
			recordRefinementParseFailure('{"edits": [oops]}', new Error("boom"), { harnessStateDir });
			expect(existsSync(getRefinementFailuresPath(harnessStateDir))).toBe(false);
		} finally {
			platform.mockRestore();
		}
	});

	it("swallows its own write failure", () => {
		const harnessStateDir = join(makeTempDir(), "harness");
		mkdirSync(getRefinementFailuresPath(harnessStateDir), { recursive: true });

		expect(() =>
			recordRefinementParseFailure('{"edits": [oops]}', new Error("boom"), { harnessStateDir }),
		).not.toThrow();
	});
});
