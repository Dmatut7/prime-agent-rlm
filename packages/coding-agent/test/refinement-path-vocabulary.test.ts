import { describe, expect, it } from "vitest";
import {
	applyRefinementProposal,
	DEFAULT_HARNESS_PATH_VOCABULARY,
	type HarnessState,
} from "../src/core/refinement/refinement.js";

/**
 * Path-classification collapse (memory-recall-design.md stage 2): the real
 * store grew 597+ free-form paths, 538 of them singletons. Writes now get an
 * advisory receipt when the path's first segment falls outside the controlled
 * vocabulary - guidance, never a block - so the classification converges
 * instead of sprawling. The vocabulary covers the observed clusters'
 * canonical names (arch, not architecture; project, not projects).
 */

function emptyState(): HarnessState {
	return { schema: 1, entries: { prompt: {}, memory: {}, skill: {}, subagent: {} }, refinements: [] };
}

function applyEdits(state: HarnessState, edits: Array<Record<string, unknown>>, id = "refine_path") {
	return applyRefinementProposal(
		state,
		{ summary: "s", rationale: "r", expectedOutcome: "o", edits: edits as never },
		{ id },
	);
}

describe("path vocabulary advisory", () => {
	it("ships a controlled vocabulary covering the observed first-segment clusters", () => {
		for (const segment of [
			"general",
			"policy",
			"discipline",
			"arch",
			"analysis",
			"project",
			"tooling",
			"environment",
			"governance",
			"testing",
			"research",
			"communication",
			"process",
			"delegation",
			"operations",
			"review",
			"preference",
		]) {
			expect(DEFAULT_HARNESS_PATH_VOCABULARY).toContain(segment);
		}
	});

	it("advises on an off-vocabulary first segment, naming the segment and the vocabulary", () => {
		const state = emptyState();
		const result = applyEdits(state, [
			{ action: "create", kind: "memory", id: "m1", title: "Fact", content: "c", path: "architecture/module-map" },
		]);
		const edit = result.appliedEdits[0];
		expect(edit.applied).toBe(true);
		expect(edit.pathVocabularyWarning).toBeDefined();
		expect(edit.pathVocabularyWarning).toContain("architecture");
		expect(edit.pathVocabularyWarning).toContain("arch");
		expect(edit.pathVocabularyWarning).toContain("discipline");
		// Advisory, never a block: the entry stored the path as written.
		expect(state.entries.memory.m1?.path).toBe("architecture/module-map");
	});

	it("accepts vocabulary first segments with free subpaths", () => {
		const state = emptyState();
		const result = applyEdits(state, [
			{ action: "create", kind: "memory", id: "m1", title: "Fact", content: "c", path: "discipline/code-review" },
		]);
		expect(result.appliedEdits[0].pathVocabularyWarning).toBeUndefined();
	});

	it("matches the first segment case-insensitively", () => {
		const state = emptyState();
		const result = applyEdits(state, [
			{ action: "create", kind: "memory", id: "m1", title: "Fact", content: "c", path: "Discipline/Code-Review" },
		]);
		expect(result.appliedEdits[0].pathVocabularyWarning).toBeUndefined();
	});

	it("stays silent on updates that do not touch the path", () => {
		const state = emptyState();
		applyEdits(state, [
			{ action: "create", kind: "memory", id: "m1", title: "Fact", content: "c", path: "oneoff/topic" },
		]);
		const result = applyEdits(
			state,
			[{ action: "update", kind: "memory", id: "m1", title: "Fact v2", content: "c2" }],
			"refine_path_update",
		);
		expect(result.appliedEdits[0].applied).toBe(true);
		expect(result.appliedEdits[0].pathVocabularyWarning).toBeUndefined();
	});

	it("honors a caller-supplied vocabulary", () => {
		const state = emptyState();
		const result = applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "create", kind: "memory", id: "m1", title: "Fact", content: "c", path: "general" }],
			},
			{ id: "refine_custom_vocab", pathVocabulary: ["only"] },
		);
		expect(result.appliedEdits[0].pathVocabularyWarning).toContain("general");
	});
});
