import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, LogEntry, Model } from "@earendil-works/pi-ai";
import { adjustMaxTokensForThinking, modelCannotDisableThinking, setLogSink } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { branchSummaryMaxTokens, generateBranchSummary } from "../src/core/compaction/branch-summarization.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { autoRefineReviewMaxOutputTokens, refinementMaxOutputTokens } from "../src/core/refinement/refinement.js";
import type { SessionMessageEntry } from "../src/core/session-manager.js";
import {
	agentStatusMaxTokens,
	generateAgentStatus,
	parseAgentStatusResponse,
} from "../src/modes/daemon/daemon-session-summarizer.js";

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

/**
 * #14 first half: the budget arithmetic and the shared capability predicate must both be
 * reachable from the package root entry, otherwise every call site below would have to
 * keep its own copy of the reserve rule.
 */
const RESERVE_LEVEL = "medium" as const;

function testModel(overrides: Partial<Model<Api>> & { id: string }): Model<Api> {
	return {
		name: overrides.id,
		api: "openai-completions",
		provider: "bailian",
		baseUrl: "https://example.invalid/compatible-mode/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		...overrides,
	} as Model<Api>;
}

/** glm-5.3: reasoning, `off` unsupported -> the reserve applies. */
const cannotDisable = (id = "glm-5.3") =>
	testModel({
		id,
		maxTokens: 131_072,
		thinkingLevelMap: {
			off: null,
			minimal: "low",
			low: "low",
			medium: "high",
			high: "high",
			xhigh: "max",
			max: "max",
		},
	});

/** deepseek-v4.1-flash: reasoning, `off: "none"` -> no reserve, budgets unchanged. */
const canDisable = (id = "deepseek-v4.1-flash") =>
	testModel({
		id,
		maxTokens: 384_000,
		thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high" },
	});

/** The daemon status model today: not a reasoning model at all. */
const nonReasoning = (id = "qwen3-30b-a3b-instruct-2507") =>
	testModel({ id, provider: "prime-inference", reasoning: false, maxTokens: 32_768 });

const BASE = { plan: 32_000, review: 4_096, branch: 2_048, status: 400 } as const;
const SITE_CAP = { branch: 4_096, status: 2_048 } as const;

function expectedBudget(base: number, model: Model<Api>, siteCap?: number): number {
	if (!modelCannotDisableThinking(model)) return base;
	const adjusted = adjustMaxTokensForThinking(base, model.maxTokens, RESERVE_LEVEL).maxTokens;
	return siteCap === undefined ? adjusted : Math.min(adjusted, siteCap);
}

const logEntries: LogEntry[] = [];

beforeEach(() => {
	completeSimpleMock.mockReset();
	logEntries.length = 0;
	setLogSink((entry) => {
		logEntries.push(entry);
	});
});

afterEach(() => {
	setLogSink(undefined);
});

describe("#12 the four budget call sites reserve thinking room only when it cannot be disabled", () => {
	it("glm-5.3 shape: plan 40192, review 12288, branch 4096, status 2048", () => {
		const model = cannotDisable();
		expect(refinementMaxOutputTokens(model)).toBe(40_192);
		expect(autoRefineReviewMaxOutputTokens(model)).toBe(12_288);
		expect(branchSummaryMaxTokens(model)).toBe(4_096);
		expect(agentStatusMaxTokens(model)).toBe(2_048);
	});

	it("every site equals the unified formula min(adjust(base, model.maxTokens, medium), siteCap)", () => {
		for (const model of [cannotDisable("glm-a"), canDisable("ds-a"), nonReasoning("plain-a")]) {
			expect(refinementMaxOutputTokens(model), model.id).toBe(
				expectedBudget(Math.min(model.maxTokens, BASE.plan), model),
			);
			expect(autoRefineReviewMaxOutputTokens(model), model.id).toBe(
				expectedBudget(Math.min(model.maxTokens, BASE.review), model),
			);
			expect(branchSummaryMaxTokens(model), model.id).toBe(expectedBudget(BASE.branch, model, SITE_CAP.branch));
			expect(agentStatusMaxTokens(model), model.id).toBe(expectedBudget(BASE.status, model, SITE_CAP.status));
		}
	});

	it('a model that can disable thinking (off:"none") keeps all four base budgets byte for byte', () => {
		const model = canDisable();
		expect(refinementMaxOutputTokens(model)).toBe(BASE.plan);
		expect(autoRefineReviewMaxOutputTokens(model)).toBe(BASE.review);
		expect(branchSummaryMaxTokens(model)).toBe(BASE.branch);
		expect(agentStatusMaxTokens(model)).toBe(BASE.status);
		expect(logEntries).toHaveLength(0);
	});

	it("#15 a non-reasoning model keeps all four base budgets unchanged", () => {
		const model = nonReasoning();
		expect(modelCannotDisableThinking(model)).toBe(false);
		expect(refinementMaxOutputTokens(model)).toBe(BASE.plan);
		expect(autoRefineReviewMaxOutputTokens(model)).toBe(BASE.review);
		expect(branchSummaryMaxTokens(model)).toBe(BASE.branch);
		expect(agentStatusMaxTokens(model)).toBe(BASE.status);
	});

	it("keeps model.maxTokens as the hard ceiling on a small model", () => {
		const model = testModel({ id: "tiny-thinking", maxTokens: 4_096, thinkingLevelMap: { off: null } });
		expect(refinementMaxOutputTokens(model)).toBe(4_096);
		expect(autoRefineReviewMaxOutputTokens(model)).toBe(4_096);
		expect(branchSummaryMaxTokens(model)).toBe(4_096);
		expect(agentStatusMaxTokens(model)).toBe(2_048);
	});

	it("warns once per model when maxTokens eats the reserve, instead of degrading silently", () => {
		const model = testModel({ id: "warn-once", maxTokens: 2_048, thinkingLevelMap: { off: null } });
		expect(refinementMaxOutputTokens(model)).toBe(2_048);
		expect(refinementMaxOutputTokens(model)).toBe(2_048);
		const warnings = logEntries.filter((entry) => entry.msg === "thinking reserve truncated by model maxTokens");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.level).toBe("warn");
		expect(warnings[0]?.model).toContain("warn-once");
		expect(warnings[0]?.wantedMaxTokens).toBeGreaterThan(Number(warnings[0]?.maxTokens));
	});

	it("never lowers the status budget back into the truncating range", () => {
		// Measured on glm-5.3 with the production status prompt: 400 and 512 both end in
		// finish=length with the closing tag cut off, which parses as undefined.
		expect(agentStatusMaxTokens(cannotDisable("glm-floor"))).toBeGreaterThan(512);
	});
});

describe("#13 daemon status path", () => {
	function fakeRegistry(model: Model<Api>): ModelRegistry {
		return {
			find: () => model,
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: undefined }),
		} as unknown as ModelRegistry;
	}

	function statusMessages(): AgentMessage[] {
		return [
			{ role: "user", content: "check the diff", timestamp: 0 },
			{ role: "assistant", content: [{ type: "text", text: "reading the diff now" }], timestamp: 0 },
		] as unknown as AgentMessage[];
	}

	it("requests the bounded cap and returns a parseable idle verdict end to end", async () => {
		completeSimpleMock.mockResolvedValue({
			stopReason: "stop",
			content: [
				{
					type: "text",
					text: "<recap>Reviewing the diff for the budget change</recap>\n<status>NEEDS_INPUT</status>",
				},
			],
			usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
		});

		const result = await generateAgentStatus({
			registry: fakeRegistry(cannotDisable("glm-e2e")),
			messages: statusMessages(),
			isWorking: false,
		});

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const options = completeSimpleMock.mock.calls[0]?.[2] as { maxTokens?: number };
		expect(options.maxTokens).toBe(2_048);
		// The whole point of the cap: a bounded but sufficient budget, not 400 and not 8592.
		expect(options.maxTokens).toBeGreaterThanOrEqual(1_024);
		expect(options.maxTokens).toBeLessThanOrEqual(2_048);
		expect(result).toEqual({ summary: "Reviewing the diff for the budget change", taskState: "needs_input" });
	});

	it("keeps the working case verdict-free and the budget unchanged for a non-reasoning model", async () => {
		completeSimpleMock.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<recap>Running the test suite</recap>\n<status>COMPLETED</status>" }],
			usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
		});

		const result = await generateAgentStatus({
			registry: fakeRegistry(nonReasoning()),
			messages: statusMessages(),
			isWorking: true,
		});

		const options = completeSimpleMock.mock.calls[0]?.[2] as { maxTokens?: number };
		expect(options.maxTokens).toBe(BASE.status);
		expect(result).toEqual({ summary: "Running the test suite" });
	});

	it("shows what a truncated reply costs: the status line dies silently", () => {
		// The two shapes measured at cap 400 and cap 512 on glm-5.3.
		expect(parseAgentStatusResponse("<", false)).toBeUndefined();
		expect(parseAgentStatusResponse("<recap>Reviewing the diff", false)).toBeUndefined();
		// And the same reply with room to close its tags parses.
		expect(parseAgentStatusResponse("<recap>Reviewing the diff</recap>\n<status>COMPLETED</status>", false)).toEqual({
			summary: "Reviewing the diff",
			taskState: "completed",
		});
	});

	it("puts the branch summary in the same assertion face", async () => {
		completeSimpleMock.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "## Goal\nShip the thinking reserve\n" }],
			usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
		});

		const result = await generateBranchSummary(branchEntries(4), {
			model: cannotDisable("glm-branch"),
			apiKey: "test-key",
			signal: new AbortController().signal,
		});

		expect(result.error).toBeUndefined();
		expect(result.aborted).toBeUndefined();
		expect(result.summary).toContain("Ship the thinking reserve");
		const options = completeSimpleMock.mock.calls[0]?.[2] as { maxTokens?: number };
		expect(options.maxTokens).toBe(SITE_CAP.branch);
	});

	it("leaves the branch budget at its base for a model that can disable thinking", async () => {
		completeSimpleMock.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "## Goal\nNothing to reserve\n" }],
			usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
		});

		await generateBranchSummary(branchEntries(4), {
			model: canDisable("ds-branch"),
			apiKey: "test-key",
			signal: new AbortController().signal,
		});

		const options = completeSimpleMock.mock.calls[0]?.[2] as { maxTokens?: number };
		expect(options.maxTokens).toBe(BASE.branch);
	});
});

let entryCounter = 0;
let entryParentId: string | null = null;

function branchEntry(text: string): SessionMessageEntry {
	const id = `budget-entry-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: entryParentId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text, timestamp: Date.now() } as unknown as AgentMessage,
	};
	entryParentId = id;
	return entry;
}

function branchEntries(count: number): SessionMessageEntry[] {
	const entries: SessionMessageEntry[] = [];
	for (let i = 0; i < count; i++) entries.push(branchEntry(`explored option ${i} `.repeat(20)));
	return entries;
}
