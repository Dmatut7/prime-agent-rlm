import { describe, expect, it } from "vitest";
import {
	applyHarnessConsolidation,
	CONSOLIDATION_MERGE_MIN_SCORE,
	type ConsolidationPlan,
	harnessEntrySimilarityPairs,
	harnessStoreDigest,
	planHarnessConsolidation,
} from "../src/core/refinement/consolidation.js";
import { type HarnessEntry, type HarnessState, harnessIndexBytes } from "../src/core/refinement/refinement.js";

/**
 * Consolidation pass (memory-recall-design.md stage 3). The fixtures below
 * mirror prime-agent-runtime/test/test_harness_consolidation.py verbatim so
 * both faces are pinned against the same store content: same tokenizer, same
 * idf-weighted cosine, same canonical/merge/rename rules.
 */

const DUP_TITLE_A = "platform_go后台建群与访客群体系是两套不相交的表";
const DUP_CONTENT_A =
	"platform_go 的后台建群表与访客群体系表是两套完全不相交的表，" +
	"跨表查询必须走显式 join 服务，禁止假设外键一致；实测两套表的群 id 命名空间相互独立。";
const DUP_TITLE_B = "platform_go后台建群与访客群体系两套表不相交";
const DUP_CONTENT_B =
	"platform_go 的后台建群表与访客群体系表是两套完全不相交的表，" +
	"跨表查询必须走显式 join 服务，禁止假设外键一致；实测两套表群 id 命名空间各自独立。";
// The one sentence A carries that B lacks, bullet-unioned into the merged body.
const DUP_UNIQUE_PIECE = "实测两套表的群 id 命名空间相互独立";

const DISTINCT_TITLE = "安装器审计打法";
const DISTINCT_CONTENT =
	"install.sh 安装面端到端审计：沙箱内用假 HOME 与假 prefix 跑官方安装器，" +
	"核对落盘文件清单与权限位，再对真实路径做一次干跑比对。";

const NOW = "2026-10-03T00:00:00.000Z";
let timestampCounter = 0;

function makeEntry(id: string, overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	timestampCounter += 1;
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
		// Monotonically later timestamps: entry creation order in a test is the
		// recency order the canonical selection reads.
		updated_at: `2026-09-01T00:00:${String(timestampCounter).padStart(2, "0")}.000Z`,
		version: 1,
		...overrides,
	};
}

function makeState(entries: HarnessEntry[]): HarnessState {
	const state: HarnessState = {
		schema: 1,
		entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
		refinements: [],
	};
	for (const entry of entries) {
		state.entries[entry.kind][entry.id] = entry;
	}
	return state;
}

function seedDuplicates(): HarnessState {
	return makeState([
		makeEntry("mem_original", { title: DUP_TITLE_A, content: DUP_CONTENT_A }),
		makeEntry("mem_rewrite", { title: DUP_TITLE_B, content: DUP_CONTENT_B }),
		makeEntry("mem_distinct", { title: DISTINCT_TITLE, content: DISTINCT_CONTENT }),
	]);
}

describe("planHarnessConsolidation merges", () => {
	it("is a dry-run and proposes the duplicate merge", () => {
		const state = seedDuplicates();
		const snapshot = JSON.stringify(state);
		const plan = planHarnessConsolidation(state, { now: NOW });
		expect(JSON.stringify(state)).toBe(snapshot);

		expect(plan.stats).toEqual({ merges: 1, absorbedEntries: 1, staleDeletes: 0, renames: 0 });
		expect(plan.indexBytesAfter).toBeLessThan(plan.indexBytesBefore);
		expect(plan.fitsCap).toBe(true);
		expect(plan.operations).toHaveLength(1);
		const merge = plan.operations[0];
		if (merge.action !== "merge") throw new Error("expected a merge operation");
		// Canonical is the most recently updated cluster member.
		expect(merge.targetId).toBe("mem_rewrite");
		expect(merge.absorbIds).toEqual(["mem_original"]);
		expect(merge.title).toBe(DUP_TITLE_B);
		expect(merge.content.startsWith(DUP_CONTENT_B)).toBe(true);
		expect(merge.content).toContain(`\n\n合并补充：\n- ${DUP_UNIQUE_PIECE}`);
		expect(merge.score).toBeGreaterThanOrEqual(CONSOLIDATION_MERGE_MIN_SCORE);
	});

	it("is deterministic", () => {
		const state = seedDuplicates();
		const first = planHarnessConsolidation(state, { now: NOW });
		const second = planHarnessConsolidation(state, { now: NOW });
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});

	it("respects the merge threshold", () => {
		const state = seedDuplicates();
		expect(planHarnessConsolidation(state, { mergeMinScore: 0.99, now: NOW }).operations).toEqual([]);
		expect(planHarnessConsolidation(state, { now: NOW }).operations).toHaveLength(1);
	});

	it("does not merge distinct entries", () => {
		const state = makeState([
			makeEntry("mem_a", { title: DUP_TITLE_A, content: DUP_CONTENT_A }),
			makeEntry("mem_b", { title: DISTINCT_TITLE, content: DISTINCT_CONTENT }),
		]);
		const plan = planHarnessConsolidation(state, { now: NOW });
		expect(plan.operations).toEqual([]);
		expect(plan.indexBytesAfter).toBe(plan.indexBytesBefore);
	});

	it("merges exact-content duplicates with no appendix", () => {
		const state = makeState([
			makeEntry("mem_old", { title: "同一条规则", content: "完全相同的两条正文。" }),
			makeEntry("mem_new", { title: "同一条规则 v2", content: "完全相同的两条正文。" }),
		]);
		const plan = planHarnessConsolidation(state, { now: NOW });
		expect(plan.operations).toHaveLength(1);
		const merge = plan.operations[0];
		if (merge.action !== "merge") throw new Error("expected a merge operation");
		expect(merge.content).toBe("完全相同的两条正文。");
	});

	it("leaves non-memory kinds untouched by default", () => {
		const state = makeState([
			makeEntry("prompt_a", { kind: "prompt", title: DUP_TITLE_A, content: DUP_CONTENT_A }),
			makeEntry("prompt_b", { kind: "prompt", title: DUP_TITLE_B, content: DUP_CONTENT_B }),
		]);
		expect(planHarnessConsolidation(state, { now: NOW }).operations).toEqual([]);
		const widened = planHarnessConsolidation(state, { kinds: ["prompt"], now: NOW });
		expect(widened.operations).toHaveLength(1);
		expect(widened.operations[0].kind).toBe("prompt");
	});

	it("rejects unknown kinds and out-of-range scores", () => {
		const state = makeState([]);
		expect(() => planHarnessConsolidation(state, { kinds: ["bogus" as never] })).toThrow("unknown harness kind");
		expect(() => planHarnessConsolidation(state, { mergeMinScore: 1.5 })).toThrow("mergeMinScore");
	});

	it("plans nothing on an empty store and fits the cap", () => {
		const plan = planHarnessConsolidation(makeState([]), { now: NOW });
		expect(plan.operations).toEqual([]);
		expect(plan.indexBytesBefore).toBe(0);
		expect(plan.indexBytesAfter).toBe(0);
		expect(plan.fitsCap).toBe(true);
	});
});

describe("planHarnessConsolidation stale deletes", () => {
	it("never marks the merge target for a containment delete", () => {
		// The merge canonical's planned body is its original plus the absorbed
		// appendix, but the containment pass reads the pre-merge store: without
		// protection it marks the canonical contained in a larger survivor, and
		// the apply would delete the entry the merge just wrote into.
		const padding = Array.from({ length: 110 }, (_, i) => `word${i}`).join(" ");
		const state = makeState([
			makeEntry("mem_original", { title: DUP_TITLE_A, content: DUP_CONTENT_A }),
			makeEntry("mem_rewrite", { title: DUP_TITLE_B, content: DUP_CONTENT_B }),
			makeEntry("mem_handbook", { title: "大杂烩手册", content: `${DUP_CONTENT_B} ${padding}` }),
		]);
		const plan = planHarnessConsolidation(state, { now: NOW });
		expect(plan.operations.map((op) => [op.action, op.action === "merge" ? op.targetId : op.id])).toEqual([
			["merge", "mem_rewrite"],
		]);
	});

	it("never age-deletes the merge target", () => {
		// Both cluster members are older than the stale window; the canonical is
		// about to receive the absorbed content, so the plan must not age it out
		// from under the merge.
		const state = makeState([
			makeEntry("mem_original", {
				title: DUP_TITLE_A,
				content: DUP_CONTENT_A,
				updated_at: "2026-08-01T00:00:00.000Z",
			}),
			makeEntry("mem_rewrite", {
				title: DUP_TITLE_B,
				content: DUP_CONTENT_B,
				updated_at: "2026-08-02T00:00:00.000Z",
			}),
		]);
		const plan = planHarnessConsolidation(state, { staleDays: 30, now: NOW });
		expect(plan.operations.map((op) => [op.action, op.action === "merge" ? op.targetId : op.id])).toEqual([
			["merge", "mem_rewrite"],
		]);
	});

	it("merges a contained and similar pair instead of deleting", () => {
		// A fully contained body is usually also a high-cosine near-duplicate;
		// the merge pass runs first and claims it.
		const containedBody =
			"提交前必须逐路径核对归属判据，别扫整个工作树；提交说明里每个路径都要对着 git show --stat 的数字核一遍。";
		const state = makeState([
			makeEntry("mem_small", { title: "短规则", content: containedBody }),
			makeEntry("mem_large", {
				title: "长规则",
				content: `${containedBody}此外，壁挂时钟计时器预算用假时钟注入，跨席红名对账用程序化派生清单。`,
			}),
		]);
		const plan = planHarnessConsolidation(state, { now: NOW });
		expect(plan.operations).toHaveLength(1);
		const merge = plan.operations[0];
		if (merge.action !== "merge") throw new Error("expected a merge operation");
		expect(merge.targetId).toBe("mem_large");
		expect(merge.absorbIds).toEqual(["mem_small"]);
		expect(plan.indexBytesAfter).toBeLessThan(plan.indexBytesBefore);
	});

	it("deletes a contained entry in a dissimilar container", () => {
		// Cosine dilutes below the merge threshold when the container is much
		// larger; containment still recognizes the short entry as redundant.
		const containedBody =
			"提交前必须逐路径核对归属判据，别扫整个工作树；提交说明里每个路径都要对着 git show --stat 的数字核一遍。";
		const padding = Array.from({ length: 110 }, (_, i) => `word${i}`).join(" ");
		const state = makeState([
			makeEntry("mem_small", { title: "短规则", content: containedBody }),
			makeEntry("mem_large", { title: "大杂烩手册", content: `${containedBody} ${padding}` }),
		]);
		const plan = planHarnessConsolidation(state, { now: NOW });
		expect(plan.operations).toHaveLength(1);
		expect(plan.operations[0]).toMatchObject({ action: "delete", id: "mem_small", reason: "contained:mem_large" });
		expect(plan.indexBytesAfter).toBeLessThan(plan.indexBytesBefore);
	});

	it("ignores bodies shorter than the containment floor", () => {
		const state = makeState([
			makeEntry("mem_small", { title: "短", content: "短正文。" }),
			makeEntry("mem_large", {
				title: "长",
				content: "短正文。这是一条长很多的正文，包含前面那条短正文的全部内容。",
			}),
		]);
		const plan = planHarnessConsolidation(state, { now: NOW });
		expect(plan.operations.filter((op) => op.action === "delete")).toEqual([]);
	});

	it("treats age staleness as opt-in and reads the injected clock", () => {
		const state = makeState([
			makeEntry("mem_old", {
				title: "旧条目",
				content: "一条足够长的正文，用来触发陈旧检测的条目。",
				updated_at: "2026-08-01T00:00:00.000Z",
			}),
		]);
		expect(planHarnessConsolidation(state, { now: NOW }).operations).toEqual([]);
		const plan = planHarnessConsolidation(state, { staleDays: 60, now: NOW });
		expect(plan.operations).toHaveLength(1);
		expect(plan.operations[0]).toMatchObject({ action: "delete", id: "mem_old", reason: "stale:63d" });
		const fresh = planHarnessConsolidation(state, { staleDays: 60, now: "2026-08-15T00:00:00.000Z" });
		expect(fresh.operations).toEqual([]);
	});

	it("never age-deletes an entry with an unparseable timestamp", () => {
		const state = makeState([
			makeEntry("mem_bad_ts", {
				title: "坏时间戳",
				content: "一条足够长的正文，用来触发陈旧检测的条目。",
				updated_at: "not-a-timestamp",
				created_at: "also-bad",
			}),
		]);
		expect(planHarnessConsolidation(state, { staleDays: 1, now: NOW }).operations).toEqual([]);
	});
});

describe("planHarnessConsolidation renames", () => {
	it("treats title slimming as opt-in", () => {
		// Off by default: slimming rewrites the stored title, while the digest's
		// index layer already truncates its own rendering - so the pass runs only
		// when a caller explicitly asks for it.
		const longTitle = "这是一条很长的标题".repeat(20); // 180 code points
		const state = makeState([makeEntry("mem_long", { title: longTitle, content: "正文" })]);
		expect(planHarnessConsolidation(state, { now: NOW }).operations).toEqual([]);
		const plan = planHarnessConsolidation(state, { slimTitleChars: 120, now: NOW });
		expect(plan.operations).toHaveLength(1);
		const rename = plan.operations[0];
		if (rename.action !== "rename") throw new Error("expected a rename operation");
		expect(rename.id).toBe("mem_long");
		expect(Array.from(rename.title)).toHaveLength(120);
		expect(rename.title.endsWith("...")).toBe(true);
		expect(rename.previousTitleChars).toBe(180);
		// Slimming to the render cap renders byte-identically to the truncated
		// face it replaces, so the index byte math is unchanged.
		expect(plan.indexBytesAfter).toBe(plan.indexBytesBefore);
	});

	it("saves index bytes when the slim cap is below the render cap", () => {
		const longTitle = "这是一条很长的标题".repeat(20);
		const state = makeState([makeEntry("mem_long", { title: longTitle, content: "正文" })]);
		const plan = planHarnessConsolidation(state, { slimTitleChars: 40, now: NOW });
		const rename = plan.operations[0];
		if (rename.action !== "rename") throw new Error("expected a rename operation");
		expect(Array.from(rename.title)).toHaveLength(40);
		expect(plan.indexBytesAfter).toBeLessThan(plan.indexBytesBefore);
	});

	it("disables the slim pass at zero", () => {
		const state = makeState([makeEntry("mem_long", { title: "这是一条很长的标题".repeat(20), content: "正文" })]);
		expect(planHarnessConsolidation(state, { slimTitleChars: 0, now: NOW }).operations).toEqual([]);
	});

	it("slims newline-carrying titles in flattened form", () => {
		const state = makeState([makeEntry("mem_newline", { title: "标题\n换行 ".repeat(20), content: "正文" })]);
		const plan = planHarnessConsolidation(state, { slimTitleChars: 10, now: NOW });
		const rename = plan.operations[0];
		if (rename.action !== "rename") throw new Error("expected a rename operation");
		expect(rename.title).not.toContain("\n");
		expect(Array.from(rename.title)).toHaveLength(10);
	});
});

describe("planHarnessConsolidation merge content", () => {
	it("keeps URLs and code whole in the merge appendix", () => {
		// The sentence splitter must not cut inside a URL (?, !) or a code block
		// (newlines, ?, !): a split URL is a dead link and split code is garbage
		// in the appendix. Mirrored verbatim in test_harness_consolidation.py.
		const canonicalContent =
			"部署前必须逐路径核对归属判据，别扫整个工作树；提交说明里每个路径都要对着 git show --stat 的数字核一遍。";
		const absorbedContent =
			canonicalContent +
			"排查手册见 https://wiki.example.com/dev?topic=review&lang=zh！" +
			"命令序列：\n```\ngit status\nmake build? no!\n```\n跑完再收尾。";
		const expected =
			`${canonicalContent}\n\n合并补充：\n- 排查手册见 https://wiki.example.com/dev?topic=review&lang=zh` +
			"\n- 命令序列：\n- ```\ngit status\nmake build? no!\n```\n- 跑完再收尾";
		const state = makeState([
			makeEntry("mem_old", { title: "部署核对清单旧版", content: absorbedContent }),
			makeEntry("mem_new", { title: "部署核对清单", content: canonicalContent }),
		]);
		const plan = planHarnessConsolidation(state, { now: NOW });
		expect(plan.operations).toHaveLength(1);
		const merge = plan.operations[0];
		if (merge.action !== "merge") throw new Error("expected a merge operation");
		expect(merge.targetId).toBe("mem_new");
		expect(merge.absorbIds).toEqual(["mem_old"]);
		expect(merge.content).toBe(expected);
	});
});

describe("applyHarnessConsolidation", () => {
	it("applies the merge through the refinement machinery and records the event", () => {
		const state = seedDuplicates();
		const plan = planHarnessConsolidation(state, { now: NOW });
		const result = applyHarnessConsolidation(state, plan, { id: "consolidate_test" });
		expect(result.id).toBe("consolidate_test");
		expect(result.appliedEdits.map((edit) => [edit.action, edit.id, edit.applied])).toEqual([
			["update", "mem_rewrite", true],
			["delete", "mem_original", true],
		]);
		// Rollback data rides the existing machinery.
		expect(result.appliedEdits[0].before?.content).toBe(DUP_CONTENT_B);
		expect(result.appliedEdits[1].before?.content).toBe(DUP_CONTENT_A);

		const merged = state.entries.memory.mem_rewrite;
		expect(merged.version).toBe(2);
		expect(merged.source).toBe("refine");
		expect(merged.content).toContain(DUP_UNIQUE_PIECE);
		expect(state.entries.memory.mem_original).toBeUndefined();
		expect(harnessIndexBytes(state)).toBe(plan.indexBytesAfter);

		const event = state.refinements.at(-1);
		expect(event?.id).toBe("consolidate_test");
		expect(event?.trigger).toContain("Consolidation pass: 1 merges");
		expect(event?.changes).toEqual(["update memory:mem_rewrite", "delete memory:mem_original"]);
	});

	it("passes the enforced index cap on an over-cap store", () => {
		// Consolidation is how an over-cap store gets back under the cap: the
		// merge/delete/rename edits must land even with enforcement on.
		const state = seedDuplicates();
		const plan = planHarnessConsolidation(state, { now: NOW });
		const result = applyHarnessConsolidation(state, plan, { enforceIndexCap: true });
		expect(result.appliedEdits.every((edit) => edit.applied)).toBe(true);
		expect(Object.keys(state.entries.memory).sort()).toEqual(["mem_distinct", "mem_rewrite"]);
	});

	it("refuses a stale plan", () => {
		const state = seedDuplicates();
		const plan = planHarnessConsolidation(state, { now: NOW });
		state.entries.memory.mem_new = makeEntry("mem_new");
		expect(() => applyHarnessConsolidation(state, plan)).toThrow("stale");
		const result = applyHarnessConsolidation(state, plan, { allowStalePlan: true });
		expect(result.appliedEdits.every((edit) => edit.applied)).toBe(true);
		expect(Object.keys(state.entries.memory).sort()).toEqual(["mem_distinct", "mem_new", "mem_rewrite"]);
	});

	it("reports missing entries without failing the batch", () => {
		const state = seedDuplicates();
		const plan = planHarnessConsolidation(state, { now: NOW });
		delete state.entries.memory.mem_original;
		const result = applyHarnessConsolidation(state, plan, { allowStalePlan: true });
		const byId = new Map(result.appliedEdits.map((edit) => [`${edit.action}:${edit.id}`, edit]));
		expect(byId.get("update:mem_rewrite")?.applied).toBe(true);
		expect(byId.get("delete:mem_original")?.applied).toBe(false);
		expect(byId.get("delete:mem_original")?.error).toBe("entry not found");
	});

	it("records no refinement event when nothing applied", () => {
		const state = seedDuplicates();
		const emptyPlan: ConsolidationPlan = {
			version: 1,
			storeDigest: harnessStoreDigest(state),
			options: { kinds: ["memory"], mergeMinScore: 0.55, staleMinContentChars: 40, indexMaxBytes: 12288 },
			indexBytesBefore: 0,
			indexBytesAfter: 0,
			fitsCap: true,
			operations: [],
			stats: { merges: 0, absorbedEntries: 0, staleDeletes: 0, renames: 0 },
		};
		const refinementsBefore = state.refinements.length;
		const result = applyHarnessConsolidation(state, emptyPlan);
		expect(result.appliedEdits).toEqual([]);
		expect(state.refinements).toHaveLength(refinementsBefore);
	});

	it("rejects a rename whose entry vanished", () => {
		const longTitle = "这是一条很长的标题".repeat(20);
		const state = makeState([makeEntry("mem_long", { title: longTitle, content: "正文" })]);
		const plan = planHarnessConsolidation(state, { slimTitleChars: 120, now: NOW });
		delete state.entries.memory.mem_long;
		const result = applyHarnessConsolidation(state, plan, { allowStalePlan: true });
		expect(result.appliedEdits[0].applied).toBe(false);
		expect(result.appliedEdits[0].error).toContain("requires title and content");
	});
});

describe("cross-face pins", () => {
	it("computes the store digest the Python face computes", () => {
		// harness.py `_harness_store_digest` over the same logical store yields
		// the same sha256 (pinned in test_harness_consolidation.py).
		const state = makeState([
			makeEntry("mem_a", {
				title: "甲规则",
				content: "甲内容。",
				created_at: "2026-09-01T00:00:00.000Z",
				updated_at: "2026-09-01T00:00:00.000Z",
				version: 1,
			}),
			makeEntry("mem_b", {
				title: "乙规则",
				content: "乙内容。",
				created_at: "2026-09-02T00:00:00.000Z",
				updated_at: "2026-09-02T00:00:00.000Z",
				version: 3,
			}),
		]);
		expect(harnessStoreDigest(state)).toBe("89fec07216db9130b6094a42b25d4233f12348729532dc498b081e9d89475739");
	});

	it("scores the duplicate fixture pair in the same band as the write gate", () => {
		const entries = [
			makeEntry("mem_original", { title: DUP_TITLE_A, content: DUP_CONTENT_A }),
			makeEntry("mem_rewrite", { title: DUP_TITLE_B, content: DUP_CONTENT_B }),
		];
		const pairs = harnessEntrySimilarityPairs(entries, 0);
		expect(pairs).toHaveLength(1);
		expect([pairs[0].idA, pairs[0].idB]).toEqual(["mem_original", "mem_rewrite"]);
		// Same band pin as the near-duplicate write-gate parity test: a tokenizer
		// or weighting drift on either face fails loudly.
		expect(pairs[0].score).toBeGreaterThan(0.5);
		expect(pairs[0].score).toBeLessThan(0.9);
	});
});
