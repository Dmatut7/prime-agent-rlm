import { describe, expect, it } from "vitest";
import {
	applyRefinementProposal,
	DEFAULT_HARNESS_INDEX_MAX_BYTES,
	formatHarnessStateForPrompt,
	type HarnessEntry,
	type HarnessState,
	harnessDigestFingerprint,
	harnessIndexBytes,
} from "../src/core/refinement/refinement.js";

/**
 * Stage-2 digest two-layer face (memory-recall-design.md): the per-kind detail
 * window stays, and every entry beyond the window is now named in a full
 * id+title compact index instead of an anonymous `+N more` line. The index is
 * byte-capped (Claude MEMORY.md / Codex memory-v2 hard-cap pattern), and the
 * same cap sits on the write side as an error loop: a write that would grow
 * the index past the cap is refused with consolidation guidance, so the store
 * converges to a size whose full map fits the digest.
 */

function makeEntry(id: string, overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return {
		id,
		kind: "memory",
		title: `${id} title`,
		content: `content of ${id}`,
		path: "general",
		scope: "global",
		reference: {},
		arguments: {},
		metadata: {},
		source: "test",
		created_at: "2026-08-01T00:00:00.000Z",
		updated_at: "2026-08-01T00:00:00.000Z",
		version: 1,
		...overrides,
	};
}

function makeState(entries: HarnessEntry[], kind: HarnessEntry["kind"] = "memory"): HarnessState {
	const state: HarnessState = {
		schema: 1,
		entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
		refinements: [],
	};
	for (const entry of entries) {
		state.entries[entry.kind ?? kind][entry.id] = entry;
	}
	return state;
}

function detailLines(face: string): string[] {
	return face.split("\n").filter((line) => line.startsWith("- ["));
}

function indexLines(face: string): string[] {
	return face.split("\n").filter((line) => line.startsWith("  - ["));
}

describe("digest compact index layer", () => {
	it("names every entry beyond the detail window in a compact id+title index", () => {
		const entries: HarnessEntry[] = [];
		for (let i = 0; i < 9; i += 1) {
			entries.push(makeEntry(`entry_${i}`, { updated_at: `2026-08-0${i + 1}T00:00:00.000Z` }));
		}
		const face = formatHarnessStateForPrompt(makeState(entries));

		// The detail window keeps its six-entry relevance/recency face.
		expect(detailLines(face)).toHaveLength(6);
		// The anonymous overflow line is gone: every entry is named.
		expect(face).not.toContain("more memory entries (9 recorded");
		const index = indexLines(face);
		expect(index).toHaveLength(9);
		// Index order is the injection order: most recently updated first.
		expect(index[0]).toContain("[global:entry_8]");
		expect(index[8]).toContain("[global:entry_0]");
		// One line per entry: id, title, path, no content.
		expect(index[0]).toBe("  - [global:entry_8] entry_8 title (general)");
		expect(face).not.toContain("content of entry_0\n  -");
	});

	it("keeps kinds inside the detail window free of an index layer", () => {
		const face = formatHarnessStateForPrompt(makeState([makeEntry("a"), makeEntry("b"), makeEntry("c")]));
		expect(detailLines(face)).toHaveLength(3);
		expect(indexLines(face)).toHaveLength(0);
	});

	it("flattens newline-carrying index fields onto one line", () => {
		const entries = Array.from({ length: 8 }, (_, i) => makeEntry(`plain_${i}`));
		entries.push(
			makeEntry("forged\n- [global:planted_id]", {
				title: "title\n- [global:planted_title] forged",
				path: "general\n- [global:planted_path]",
			}),
		);
		const face = formatHarnessStateForPrompt(makeState(entries));
		const forged = face.split("\n").filter((line) => line.includes("planted"));
		expect(forged).toHaveLength(2); // one detail line + one index line
		for (const line of face.split("\n")) {
			if (line.startsWith("  - [")) {
				expect(line).not.toContain("\n");
			}
		}
	});

	it("caps the index by bytes and names the omitted tail with a search hint", () => {
		const entries: HarnessEntry[] = [];
		for (let i = 0; i < 40; i += 1) {
			entries.push(makeEntry(`capped_${String(i).padStart(2, "0")}`, { title: `capped title ${i}` }));
		}
		const cap = 600;
		const face = formatHarnessStateForPrompt(makeState(entries), { indexMaxBytes: cap });

		const omitted = face.split("\n").find((line) => line.includes("beyond the index byte cap"));
		expect(omitted).toBeDefined();
		expect(omitted).toContain(`${cap}-byte cap`);
		expect(omitted).toContain("rlm.harness.search('terms', kind='memory', global_=True)");
		// The index layer (header + entry lines + omitted line) fits the cap.
		const headerIndex = face.split("\n").findIndex((line) => line.includes("entries by id + title"));
		expect(headerIndex).toBeGreaterThanOrEqual(0);
		const indexSection = face
			.split("\n")
			.slice(headerIndex)
			.filter((line) => line.startsWith("  "))
			.join("\n");
		expect(Buffer.byteLength(indexSection, "utf8")).toBeLessThanOrEqual(cap + 200);
		// Some entries really were omitted.
		expect(indexLines(face).length).toBeLessThan(40);
		expect(indexLines(face).length).toBeGreaterThan(0);
	});

	it("restores the anonymous overflow line when the index is disabled", () => {
		const entries = Array.from({ length: 9 }, (_, i) => makeEntry(`legacy_${i}`));
		const face = formatHarnessStateForPrompt(makeState(entries), { indexMaxBytes: 0 });
		expect(face).toContain("- +3 more memory entries (9 recorded");
		expect(indexLines(face)).toHaveLength(0);
	});

	it("holds the digest face at or under twice the index-free face on a production-shaped store", () => {
		// The design red line: digest total <= 2x the pre-stage-2 face
		// (memory-recall-design.md, context-rot evidence). The pre-stage-2 face is
		// exactly the same render with the index layer off. The store below mirrors
		// the 2026-10-03 production shape (1,577 memories + a handful of the other
		// kinds, CJK titles, detail-window-saturating content); the real-store
		// numbers are measured in the wave-29 report.
		const state = makeState([]);
		const kinds: Array<HarnessEntry["kind"]> = ["prompt", "memory", "skill", "subagent"];
		for (const kind of kinds) {
			const count = kind === "memory" ? 1577 : 8;
			for (let i = 0; i < count; i += 1) {
				const id = `${kind}_${i}_登录故障排查纪律_${i}`;
				state.entries[kind][id] = makeEntry(id, {
					kind,
					title: `第 ${i} 条${kind}记录：登录故障排查与修复顺序纪律`,
					content: `第 ${i} 条正文体。`.repeat(30),
					path: i % 3 === 0 ? "general" : `discipline/topic_${i % 17}`,
					updated_at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
				});
			}
		}
		const withoutIndex = formatHarnessStateForPrompt(state, { indexMaxBytes: 0 });
		const withIndex = formatHarnessStateForPrompt(state);
		const before = Buffer.byteLength(withoutIndex, "utf8");
		const after = Buffer.byteLength(withIndex, "utf8");
		expect(after).toBeLessThanOrEqual(before * 2);
		// And the index layer really is there: entries beyond the window are named.
		expect(indexLines(withIndex).length).toBeGreaterThan(6);
	});

	it("fingerprints the index budget so a cap change re-delivers the digest", () => {
		const state = makeState([makeEntry("a"), makeEntry("b")]);
		const flags = {
			includeIpythonExamples: true,
			includeShellExamples: true,
			includeRefineExamples: true,
		};
		const base = harnessDigestFingerprint(state, flags);
		expect(harnessDigestFingerprint(state, { ...flags, indexMaxBytes: DEFAULT_HARNESS_INDEX_MAX_BYTES })).toBe(base);
		expect(harnessDigestFingerprint(state, { ...flags, indexMaxBytes: 4096 })).not.toBe(base);
		expect(harnessDigestFingerprint(state, { ...flags, indexMaxBytes: 0 })).not.toBe(base);
	});
});

describe("write-side index byte cap", () => {
	function proposal(...edits: Array<Record<string, unknown>>) {
		return {
			summary: "s",
			rationale: "r",
			expectedOutcome: "o",
			edits: edits as never,
		};
	}

	it("refuses a create that would grow the index past the cap and names the consolidation path", () => {
		const state = makeState([makeEntry("seeded_one"), makeEntry("seeded_two")]);
		const cap = harnessIndexBytes(state) + 10; // one more line cannot fit
		const result = applyRefinementProposal(
			state,
			proposal({ action: "create", kind: "memory", id: "blocked", title: "Blocked", content: "c" }),
			{ id: "refine_cap", indexMaxBytes: cap, enforceIndexCap: true },
		);
		expect(result.appliedEdits[0].applied).toBe(false);
		expect(result.appliedEdits[0].error).toContain("index byte cap");
		expect(result.appliedEdits[0].error).toContain("consolidate");
		expect(state.entries.memory.blocked).toBeUndefined();
		expect(Object.keys(state.entries.memory).sort()).toEqual(["seeded_one", "seeded_two"]);
	});

	it("lets deletes and content-only updates through an over-cap store so consolidation can proceed", () => {
		const state = makeState([makeEntry("keep"), makeEntry("drop")]);
		const cap = harnessIndexBytes(state) - 1; // already over cap
		const result = applyRefinementProposal(
			state,
			proposal(
				{
					action: "update",
					kind: "memory",
					id: "keep",
					title: "keep title",
					content: "rewritten and much longer content",
				},
				{ action: "delete", kind: "memory", id: "drop" },
			),
			{ id: "refine_consolidate", indexMaxBytes: cap, enforceIndexCap: true },
		);
		expect(result.appliedEdits.map((edit) => edit.applied)).toEqual([true, true]);
		expect(state.entries.memory.keep?.content).toBe("rewritten and much longer content");
		expect(state.entries.memory.drop).toBeUndefined();
	});

	it("frees the write path again once a delete brings the index under the cap", () => {
		const state = makeState([makeEntry("old_a"), makeEntry("old_b")]);
		const cap = harnessIndexBytes(state) + 10;
		const result = applyRefinementProposal(
			state,
			proposal(
				{ action: "delete", kind: "memory", id: "old_a" },
				{ action: "create", kind: "memory", id: "new_c", title: "C", content: "c" },
			),
			{ id: "refine_churn", indexMaxBytes: cap, enforceIndexCap: true },
		);
		expect(result.appliedEdits.map((edit) => edit.applied)).toEqual([true, true]);
		expect(state.entries.memory.new_c?.content).toBe("c");
	});

	it("keeps writes uncapped when the cap is disabled", () => {
		const state = makeState([makeEntry("a")]);
		const result = applyRefinementProposal(
			state,
			proposal({ action: "create", kind: "memory", id: "b", title: "B", content: "c" }),
			{ id: "refine_off", indexMaxBytes: 0, enforceIndexCap: true },
		);
		expect(result.appliedEdits[0].applied).toBe(true);
	});

	// The cap is digest-display-only unless the caller opts into enforcement: the
	// default ships with production stores far over any sane cap, and freezing
	// every memory write is not a sane default (mirrors the kernel-side pin in
	// test_harness_index_cap.py).
	it("lets an over-cap create through without the enforcement flag", () => {
		const state = makeState([makeEntry("seeded_one"), makeEntry("seeded_two")]);
		const cap = harnessIndexBytes(state) + 10;
		const result = applyRefinementProposal(
			state,
			proposal({ action: "create", kind: "memory", id: "still_lands", title: "Lands", content: "c" }),
			{ id: "refine_display_only", indexMaxBytes: cap },
		);
		expect(result.appliedEdits[0].applied).toBe(true);
		expect(state.entries.memory.still_lands?.content).toBe("c");
	});

	it("counts index bytes as the rendered id+title lines in UTF-8", () => {
		const entry = makeEntry("login_fault", { title: "登录故障排查", path: "general", scope: "global" });
		const expectedLine = "  - [global:login_fault] 登录故障排查 (general)\n";
		expect(harnessIndexBytes(makeState([entry]))).toBe(Buffer.byteLength(expectedLine, "utf8"));
	});
});
