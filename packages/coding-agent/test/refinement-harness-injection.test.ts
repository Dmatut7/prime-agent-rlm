import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PiAi from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	applyRefinementProposal,
	formatHarnessStateForPrompt,
	type HarnessEntry,
	type HarnessState,
	loadHarnessState,
	planRefinement,
	type RefinementProposal,
} from "../src/core/refinement/index.js";

/**
 * Two harness properties the model depends on but cannot observe directly:
 * every recorded fact gets its own identity, and the facts that reach the prompt
 * are the ones written most recently rather than the ones whose path sorts first.
 */

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return { ...actual, completeSimple: completeSimpleMock };
});

let tempDir: string | undefined;
let ambientAgentDir: string | undefined;
let previousAgentDirEnv: string | undefined;

beforeEach(() => {
	completeSimpleMock.mockReset();
	// Refinement failure evidence is appended under the ambient agent dir.
	ambientAgentDir = mkdtempSync(join(tmpdir(), "prime-agent-injection-agent-dir-"));
	previousAgentDirEnv = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = ambientAgentDir;
});

afterEach(() => {
	if (previousAgentDirEnv === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDirEnv;
	if (ambientAgentDir) {
		rmSync(ambientAgentDir, { recursive: true, force: true });
		ambientAgentDir = undefined;
	}
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function makeTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "prime-agent-injection-test-"));
	return tempDir;
}

function localState(): HarnessState {
	return loadHarnessState(join(makeTempDir(), "harness"), "local");
}

function proposal(summary: string, edits: RefinementProposal["edits"]): RefinementProposal {
	return {
		summary,
		rationale: `${summary} rationale`,
		expectedOutcome: `${summary} outcome`,
		edits,
	};
}

function recordMemory(title: string, content: string): RefinementProposal["edits"][number] {
	return { action: "create", kind: "memory", title, content };
}

function seededMemory(id: string, title: string, path: string, updatedAt: string): HarnessEntry {
	return {
		id,
		kind: "memory",
		title,
		content: `${title} content`,
		path,
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "refine",
		created_at: updatedAt,
		updated_at: updatedAt,
		version: 1,
	};
}

function injectedEntryLines(face: string): string[] {
	return face.split("\n").filter((line) => line.startsWith("- [local:") || line.startsWith("- [global:"));
}

function injectedIds(face: string): string[] {
	return injectedEntryLines(face).map((line) => line.slice(line.indexOf(":") + 1, line.indexOf("]")));
}

function overflowLine(face: string, kind: string): string | undefined {
	return face.split("\n").find((line) => line.startsWith("- +") && line.includes(` more ${kind} entries`));
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

function emptyProposalJson(): string {
	return JSON.stringify({
		summary: "Nothing to record",
		rationale: "no evidence",
		expectedOutcome: "no change",
		edits: [],
	});
}

describe("identity for titles that are not ASCII", () => {
	it("gives two CJK titles distinct ids and applies both recordings", () => {
		const state = localState();

		const first = applyRefinementProposal(
			state,
			proposal("Record lesson A", [recordMemory("中文标题甲", "第一条。")]),
			{
				id: "refine_a",
			},
		);
		const second = applyRefinementProposal(
			state,
			proposal("Record lesson B", [recordMemory("中文标题乙", "第二条。")]),
			{
				id: "refine_b",
			},
		);

		const firstEdit = first.appliedEdits[0];
		const secondEdit = second.appliedEdits[0];
		expect(firstEdit.applied).toBe(true);
		expect(secondEdit.applied).toBe(true);
		expect(firstEdit.error).toBeUndefined();
		expect(secondEdit.error).toBeUndefined();
		expect(firstEdit.id).not.toBe(secondEdit.id);
		expect(Object.keys(state.entries.memory).sort()).toEqual([firstEdit.id, secondEdit.id].sort());
		expect(state.entries.memory[firstEdit.id]?.content).toBe("第一条。");
		expect(state.entries.memory[secondEdit.id]?.content).toBe("第二条。");
	});

	it("keeps the ASCII slug shape", () => {
		const state = localState();

		const result = applyRefinementProposal(
			state,
			proposal("Record an English lesson", [recordMemory("English Title Three", "content")]),
			{ id: "refine_en" },
		);

		expect(result.appliedEdits[0]).toMatchObject({ id: "english_title_three", applied: true });
	});

	it("keeps two distinct titles that slug alike as two entries", () => {
		const state = localState();

		const first = applyRefinementProposal(state, proposal("Record one", [recordMemory("Foo Bar", "first")]), {
			id: "refine_one",
		});
		const second = applyRefinementProposal(state, proposal("Record two", [recordMemory("foo-bar", "second")]), {
			id: "refine_two",
		});

		expect(first.appliedEdits[0]).toMatchObject({ id: "foo_bar", applied: true });
		expect(second.appliedEdits[0].applied).toBe(true);
		expect(second.appliedEdits[0].id).not.toBe("foo_bar");
		expect(
			Object.values(state.entries.memory)
				.map((entry) => entry.content)
				.sort(),
		).toEqual(["first", "second"]);
	});

	it("still refuses a re-recording of the same title and keeps the first content visible", () => {
		const state = localState();

		applyRefinementProposal(state, proposal("Record once", [recordMemory("中文标题甲", "第一条。")]), {
			id: "refine_once",
		});
		const again = applyRefinementProposal(state, proposal("Record twice", [recordMemory("中文标题甲", "第二条。")]), {
			id: "refine_twice",
		});

		expect(again.appliedEdits[0]).toMatchObject({ applied: false, error: "entry already exists" });
		expect(again.appliedEdits[0].id).toBe("中文标题甲");
		expect(Object.values(state.entries.memory)).toHaveLength(1);
		expect(Object.values(state.entries.memory)[0]?.content).toBe("第一条。");
	});
});

describe("which entries reach the prompt", () => {
	it("shows a freshly recorded default-path memory even when older entries fill the view", () => {
		const state = localState();
		for (let i = 0; i < 8; i++) {
			state.entries.memory[`older_${i}`] = seededMemory(
				`older_${i}`,
				`Older ${i}`,
				"aaa/notes",
				`2026-01-0${i + 1}T00:00:00.000Z`,
			);
		}

		const created = applyRefinementProposal(
			state,
			proposal("Record a fresh note", [recordMemory("Fresh note", "recorded now")]),
			{ id: "refine_fresh" },
		);
		const createdId = created.appliedEdits[0].id;
		expect(created.appliedEdits[0].applied).toBe(true);
		expect(state.entries.memory[createdId]?.path).toBe("general");

		const face = formatHarnessStateForPrompt(state);

		expect(injectedIds(face)[0]).toBe(createdId);
		expect(injectedEntryLines(face)).toHaveLength(6);
		const overflow = overflowLine(face, "memory") ?? "";
		expect(overflow).toContain("- +3 more memory entries");
		expect(overflow).toContain("9 recorded");
		expect(overflow).toContain("rlm.get_harness_state()");
	});

	it("breaks ties by id so the same state renders the same text every turn", () => {
		const forward = localState();
		for (const id of ["b_entry", "a_entry", "c_entry"]) {
			forward.entries.memory[id] = seededMemory(id, id, "general", "2026-01-01T00:00:00.000Z");
		}
		const reversed = localState();
		for (const id of ["c_entry", "a_entry", "b_entry"]) {
			reversed.entries.memory[id] = seededMemory(id, id, "general", "2026-01-01T00:00:00.000Z");
		}

		expect(injectedIds(formatHarnessStateForPrompt(forward))).toEqual(["a_entry", "b_entry", "c_entry"]);
		expect(formatHarnessStateForPrompt(reversed)).toBe(formatHarnessStateForPrompt(forward));
	});

	it("gives the refinement planner the most recently updated entries", async () => {
		const state = localState();
		for (let i = 0; i < 41; i++) {
			const day = String((i % 28) + 1).padStart(2, "0");
			state.entries.memory[`older_${i}`] = seededMemory(
				`older_${i}`,
				`Older ${i}`,
				"aaa/notes",
				`2026-01-${day}T00:00:00.000Z`,
			);
		}
		state.entries.memory.fresh_note = seededMemory("fresh_note", "Fresh note", "general", new Date().toISOString());
		expect(Object.keys(state.entries.memory)).toHaveLength(42);

		completeSimpleMock.mockResolvedValueOnce(assistantText(emptyProposalJson()));
		await planRefinement([], state, [], refineModel(), "api-key", {});

		const request = completeSimpleMock.mock.calls[0][1] as { messages: Array<{ content: Array<{ text: string }> }> };
		const userPrompt = request.messages[0].content[0].text;
		const block = userPrompt.slice(
			userPrompt.indexOf("<current_harness_state>"),
			userPrompt.indexOf("</current_harness_state>"),
		);

		const blockEntryIds = block
			.split("\n")
			.filter((line) => line.startsWith("- [local:"))
			.map((line) => line.slice(line.indexOf(":") + 1, line.indexOf("]")));
		expect(blockEntryIds).toHaveLength(40);
		expect(blockEntryIds[0]).toBe("fresh_note");
		expect(block).toContain("- +2 more memory entries");
		expect(block).toContain("harness state file");
	});
});
