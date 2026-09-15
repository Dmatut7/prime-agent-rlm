import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PiAi from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	applyRefinementProposal,
	formatHarnessStateForPrompt,
	getGlobalHarnessStateDir,
	getRefinementFailuresPath,
	loadHarnessState,
	mergeHarnessStates,
	type RefinementFailureRecord,
	refineHarness,
	reviewAutoRefine,
} from "../src/core/refinement/index.js";

/**
 * M5: the harness overview mixes both stores and prefixes every id with the store
 * it lives in (`[global:foo]`), while reads and `refine.run()` default to the
 * local store. Seats read `memory: 0` from the local store and concluded the
 * harness was empty; an edit that copied the prefix failed as "entry not found".
 *
 * M6: a provider error (`stopReason === "error"`) and a proposal whose `edits`
 * field was not a list of edit objects both lost the refinement without leaving
 * any record in `refinement-failures.jsonl`.
 */
const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return { ...actual, completeSimple: completeSimpleMock };
});

let tempDirs: string[] = [];
let agentDir = "";
let previousAgentDir: string | undefined;

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "prime-agent-refine-scope-"));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	completeSimpleMock.mockReset();
	agentDir = makeTempDir();
	previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = agentDir;
});

afterEach(() => {
	vi.restoreAllMocks();
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

function globalMemoryEntry(id: string) {
	return {
		id,
		kind: "memory" as const,
		title: id,
		content: "global fact",
		path: "general",
		scope: "global" as const,
		reference: {},
		arguments: {},
		metadata: {},
		source: "refine",
		created_at: "2026-09-15T00:00:00.000Z",
		updated_at: "2026-09-15T00:00:00.000Z",
		version: 3,
	};
}

function globalOnlyState() {
	const state = loadHarnessState(makeTempDir(), "global");
	state.entries.memory.shared_fact = globalMemoryEntry("shared_fact");
	return state;
}

function failureRecords(): RefinementFailureRecord[] {
	const content = readFileSync(getRefinementFailuresPath(getGlobalHarnessStateDir()), "utf8");
	return content
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as RefinementFailureRecord);
}

function refineModel(): Model<"openai-completions"> {
	return {
		id: "openai/gpt-5.5",
		name: "GPT 5.5",
		api: "openai-completions",
		provider: "prime-inference",
		baseUrl: "https://inference.primeintelligence.ai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
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
		stopReason,
		timestamp: Date.now(),
	};
}

describe("refinement scope routing (M5)", () => {
	it("tells the model that the store prefix is routing, not decoration", () => {
		const overview = formatHarnessStateForPrompt(globalOnlyState());

		expect(overview).toContain("[global:shared_fact]");
		expect(overview).toContain("default to this session's local store");
		expect(overview).toContain("global_=True");
	});

	it("refuses an edit that names the other store, with the way out in the message", () => {
		const localState = loadHarnessState(makeTempDir(), "local");
		const result = applyRefinementProposal(
			localState,
			{
				summary: "update the global fact",
				rationale: "copied the id from the overview",
				expectedOutcome: "fact updated",
				edits: [
					{
						action: "update",
						kind: "memory",
						id: "global:shared_fact",
						title: "shared_fact",
						content: "local rewrite",
					},
				],
			},
			{ id: "refine_test", scope: "local" },
		);

		expect(result.appliedEdits[0].applied).toBe(false);
		expect(result.appliedEdits[0].error).toContain("global refinement");
		expect(result.appliedEdits[0].error).toContain("global_=True");
		// The edit really did not land anywhere.
		expect(localState.entries.memory.shared_fact).toBeUndefined();
	});

	it("applies the same prefixed id once the refinement targets that store", () => {
		const globalState = globalOnlyState();
		const result = applyRefinementProposal(
			globalState,
			{
				summary: "update the global fact",
				rationale: "the caller asked for a global refinement",
				expectedOutcome: "fact updated",
				edits: [
					{
						action: "update",
						kind: "memory",
						id: "global:shared_fact",
						title: "shared_fact",
						content: "global rewrite",
					},
				],
			},
			{ id: "refine_test", scope: "global" },
		);

		expect(result.appliedEdits[0].applied).toBe(true);
		expect(globalState.entries.memory.shared_fact.content).toBe("global rewrite");
	});

	it("keeps the merged view honest about which store an entry lives in", () => {
		const merged = mergeHarnessStates(globalOnlyState(), loadHarnessState(makeTempDir(), "local"));
		expect(merged.entries.memory.shared_fact.scope).toBe("global");
	});
});

describe("refinement failure records (M6)", () => {
	it("records a provider error that lost the proposal", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...assistantMessage("", "error"),
			errorMessage: "upstream 503",
		});

		await expect(
			refineHarness([], loadHarnessState(makeTempDir()), [], refineModel(), "api-key", {}),
		).rejects.toThrow(/upstream 503/);

		const records = failureRecords();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ source: "refinement", reason: "provider-error" });
		expect(records[0].error).toContain("upstream 503");
	});

	it("records a malformed edits field instead of reporting a silent empty refinement", async () => {
		completeSimpleMock.mockResolvedValueOnce(
			assistantMessage(
				JSON.stringify({ summary: "s", rationale: "r", expectedOutcome: "o", edits: "create a memory" }),
			),
		);

		const state = loadHarnessState(makeTempDir());
		const result = await refineHarness([], state, [], refineModel(), "api-key", {});

		expect(result.appliedEdits).toHaveLength(0);
		const records = failureRecords();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ source: "refinement", reason: "malformed-proposal" });
		expect(records[0].error).toContain("edits");
		// The reply is preserved, so the dropped proposal can be read afterwards.
		expect(records[0].raw).toContain("create a memory");
	});

	it("records a non-object edit element too", async () => {
		completeSimpleMock.mockResolvedValueOnce(
			assistantMessage(JSON.stringify({ summary: "s", edits: [{ action: "create", kind: "memory" }, 7] })),
		);

		await refineHarness([], loadHarnessState(makeTempDir()), [], refineModel(), "api-key", {});

		expect(failureRecords()[0]).toMatchObject({ reason: "malformed-proposal" });
	});

	it("records a provider error from the auto-refine review", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...assistantMessage("", "error"),
			errorMessage: "socket hang up",
		});

		await expect(
			reviewAutoRefine([], loadHarnessState(makeTempDir()), [], refineModel(), "api-key", {
				reason: "turn_interval",
				turnsSinceLastReview: 25,
			}),
		).rejects.toThrow(/socket hang up/);

		expect(failureRecords()[0]).toMatchObject({ source: "auto-refine-review", reason: "provider-error" });
	});

	it("still records nothing for a healthy empty proposal", async () => {
		completeSimpleMock.mockResolvedValueOnce(
			assistantMessage(JSON.stringify({ summary: "s", edits: [], rationale: "nothing useful" })),
		);

		await refineHarness([], loadHarnessState(makeTempDir()), [], refineModel(), "api-key", {});

		expect(() => failureRecords()).toThrow();
	});
});
