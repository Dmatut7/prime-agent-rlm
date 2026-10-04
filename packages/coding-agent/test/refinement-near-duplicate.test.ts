import { describe, expect, it } from "vitest";
import {
	applyRefinementProposal,
	formatRefinementNoticeBody,
	type HarnessEntry,
	type HarnessState,
	harnessSearchQueryTerms,
	nearDuplicateMemoryMatches,
} from "../src/core/refinement/refinement.js";

/**
 * W26-D parity: the TS /refine write path surfaces the same near-duplicate
 * advisory the Python harness write path has attached since wave-26
 * (prime-agent-runtime/test/test_harness_near_duplicate.py). The fixtures
 * below mirror the Python ones verbatim so both faces are pinned against the
 * same store content: same tokenizer (harnessSearchQueryTerms is the port of
 * Python's `_harness_query_terms`), same idf-weighted cosine, same two-band
 * threshold (0.40, rising to 0.55 below ten memories), same top-3 naming,
 * same warning text.
 */

const DUP_TITLE_A = "platform_go后台建群与访客群体系是两套不相交的表";
const DUP_CONTENT_A =
	"platform_go 的后台建群表与访客群体系表是两套完全不相交的表，" +
	"跨表查询必须走显式 join 服务，禁止假设外键一致；实测两套表的群 id 命名空间相互独立。";
const DUP_TITLE_B = "platform_go后台建群与访客群体系两套表不相交";
const DUP_CONTENT_B =
	"platform_go 的后台建群表与访客群体系表是两套完全不相交的表，" +
	"跨表查询必须走显式 join 服务，禁止假设外键一致；实测两套表群 id 命名空间各自独立。";

const DISTINCT_TITLE = "安装器审计打法";
const DISTINCT_CONTENT =
	"install.sh 安装面端到端审计：沙箱内用假 HOME 与假 prefix 跑官方安装器，" +
	"核对落盘文件清单与权限位，再对真实路径做一次干跑比对。";

const RELATED_SHARED = "审查纪律 共享工作树 提交前必须 逐路径核对 归属判据";
const RELATED_TITLE_A = "审查并发提交仓_提交说明必须按git_show_stat核";
const RELATED_CONTENT_A =
	`${RELATED_SHARED}。` +
	"声称修的文件零行差异是最危险的一类假修复，提交说明里每个路径都要对着 git show --stat 的数字核一遍。" +
	"壁挂时钟计时器预算用假时钟注入，跨席红名对账用程序化派生清单。";
const RELATED_TITLE_B = "只读审查车道在共享worktree见脏文件只能报告不能回滚";
const RELATED_CONTENT_B =
	`${RELATED_SHARED}。` +
	"回滚前必查归属与 blob 内容指纹，并发修复车道改完即提交；脏窗期间的临时镜像即删，" +
	"干净窗落地逐字节 md5 对拍，受控差集回执。";

function emptyState(): HarnessState {
	return { schema: 1, entries: { prompt: {}, memory: {}, skill: {}, subagent: {} }, refinements: [] };
}

function createEdit(id: string, title: string, content: string, kind = "memory") {
	return { action: "create", kind, id, title, content } as const;
}

function updateEdit(id: string, title: string, content: string) {
	return { action: "update", kind: "memory", id, title, content } as const;
}

function applyEdits(state: HarnessState, edits: Array<Record<string, unknown>>, id = "refine_nd") {
	return applyRefinementProposal(
		state,
		{ summary: "s", rationale: "r", expectedOutcome: "o", edits: edits as never },
		{ id },
	);
}

describe("harnessSearchQueryTerms (port of the harness search tokenizer)", () => {
	it("cuts spacing-free CJK runs into overlapping bigrams", () => {
		expect(harnessSearchQueryTerms("修复登录")).toEqual(["修复", "复登", "登录"]);
		expect(harnessSearchQueryTerms("修")).toEqual(["修"]);
	});

	it("keeps three-letter ASCII runs and drops shorter ones", () => {
		expect(harnessSearchQueryTerms("rlm api cli")).toEqual(["rlm", "api", "cli"]);
		expect(harnessSearchQueryTerms("go to it")).toEqual([]);
	});

	it("splits mixed CJK/ASCII runs at the script boundary", () => {
		expect(harnessSearchQueryTerms("修复login")).toEqual(["修复", "login"]);
	});

	it("keeps two-character runs of other scripts and dedupes terms", () => {
		expect(harnessSearchQueryTerms("Привет Привет мир")).toEqual(["привет", "мир"]);
	});
});

describe("near-duplicate memory advisory on the refine write path", () => {
	it("warns on a create that lands near an existing entry, and the write still stands", () => {
		const state = emptyState();
		const first = applyEdits(state, [createEdit("mem_original", DUP_TITLE_A, DUP_CONTENT_A)], "refine_a");
		expect(first.appliedEdits[0].applied).toBe(true);
		expect(first.appliedEdits[0].nearDuplicateWarning).toBeUndefined();

		const second = applyEdits(state, [createEdit("mem_rewrite", DUP_TITLE_B, DUP_CONTENT_B)], "refine_b");
		const edit = second.appliedEdits[0];
		expect(edit.applied).toBe(true);
		expect(edit.nearDuplicateWarning).toBeDefined();
		expect(edit.nearDuplicateWarning).toContain("近重复警告");
		expect(edit.nearDuplicateWarning).toContain("mem_original");
		// The advisory must ask the writer to confirm sameness first: update_memory
		// overwrites the whole entry, so "update instead of create" is only right
		// when both entries are the same fact.
		expect(edit.nearDuplicateWarning).toContain("先确认是不是同一件事");
		expect(edit.nearDuplicateWarning).not.toContain("而不是新建");
		expect(edit.nearDuplicateWarning).not.toContain("mem_rewrite");
		// Advisory only: the duplicate landed in the store.
		expect(state.entries.memory.mem_rewrite?.content).toBe(DUP_CONTENT_B);
		expect(Object.keys(state.entries.memory)).toHaveLength(2);
	});

	it("does not warn for a distinct memory", () => {
		const state = emptyState();
		applyEdits(state, [createEdit("mem_original", DUP_TITLE_A, DUP_CONTENT_A)], "refine_a");
		const result = applyEdits(state, [createEdit("mem_distinct", DISTINCT_TITLE, DISTINCT_CONTENT)], "refine_b");
		expect(result.appliedEdits[0].nearDuplicateWarning).toBeUndefined();
	});

	it("does not warn for related-but-distinct entries sharing boilerplate (calibrated threshold)", () => {
		const state = emptyState();
		applyEdits(state, [createEdit("mem_rule_a", RELATED_TITLE_A, RELATED_CONTENT_A)], "refine_a");
		const result = applyEdits(state, [createEdit("mem_rule_b", RELATED_TITLE_B, RELATED_CONTENT_B)], "refine_b");
		expect(result.appliedEdits[0].applied).toBe(true);
		expect(result.appliedEdits[0].nearDuplicateWarning).toBeUndefined();
	});

	it("warns for an ASCII near-duplicate pair", () => {
		const state = emptyState();
		applyEdits(
			state,
			[
				createEdit(
					"mem_secret_a",
					"secret masking whitelist output",
					"Secret masking must use whitelist output, not blacklist regex; " +
						"the four config shapes each need explicit allow rules, and dotenv-adjacent " +
						"files never match on basename alone.",
				),
			],
			"refine_a",
		);
		const result = applyEdits(
			state,
			[
				createEdit(
					"mem_secret_b",
					"secret masking whitelist output rule",
					"Secret masking must use whitelist output, not blacklist regex; " +
						"the four config shapes each need explicit allow rules, and dotenv-adjacent " +
						"files never match on basename alone. Verified again in review.",
				),
			],
			"refine_b",
		);
		expect(result.appliedEdits[0].nearDuplicateWarning).toContain("mem_secret_a");
	});

	it("names up to three matches, best first", () => {
		const state = emptyState();
		applyEdits(state, [createEdit("mem_original", DUP_TITLE_A, DUP_CONTENT_A)], "refine_a");
		applyEdits(state, [createEdit("mem_rewrite", DUP_TITLE_B, DUP_CONTENT_B)], "refine_b");
		const third = applyEdits(
			state,
			[createEdit("mem_third", DUP_TITLE_A, `${DUP_CONTENT_A} 补充：同上。`)],
			"refine_c",
		);
		const warning = third.appliedEdits[0].nearDuplicateWarning;
		expect(warning).toBeDefined();
		expect(warning).toContain("mem_original");
		expect(warning).toContain("mem_rewrite");
		expect(warning).not.toContain("mem_third");
	});

	it("warns on an update that moves an entry onto another one, with merge wording", () => {
		const state = emptyState();
		applyEdits(
			state,
			[
				createEdit("mem_original", DUP_TITLE_A, DUP_CONTENT_A),
				createEdit("mem_distinct", DISTINCT_TITLE, DISTINCT_CONTENT),
			],
			"refine_a",
		);
		const result = applyEdits(state, [updateEdit("mem_distinct", DUP_TITLE_B, DUP_CONTENT_B)], "refine_b");
		const warning = result.appliedEdits[0].nearDuplicateWarning;
		expect(warning).toBeDefined();
		expect(warning).toContain("近重复警告");
		expect(warning).toContain("mem_original");
		expect(warning).toContain("合并");
		expect(warning).not.toContain("mem_distinct");
	});

	it("does not warn when an update only rewords the entry itself", () => {
		const state = emptyState();
		applyEdits(
			state,
			[
				createEdit("mem_original", DUP_TITLE_A, DUP_CONTENT_A),
				createEdit("mem_distinct", DISTINCT_TITLE, DISTINCT_CONTENT),
			],
			"refine_a",
		);
		const result = applyEdits(
			state,
			[updateEdit("mem_original", DUP_TITLE_A, `${DUP_CONTENT_A} 版本二，措辞微调。`)],
			"refine_b",
		);
		expect(result.appliedEdits[0].nearDuplicateWarning).toBeUndefined();
	});

	it("never warns for non-memory kinds", () => {
		const state = emptyState();
		const result = applyEdits(
			state,
			[
				createEdit("prompt_a", DUP_TITLE_A, DUP_CONTENT_A, "prompt"),
				createEdit("prompt_b", DUP_TITLE_B, DUP_CONTENT_B, "prompt"),
				createEdit("sub_a", DUP_TITLE_A, DUP_CONTENT_A, "subagent"),
				createEdit("sub_b", DUP_TITLE_B, DUP_CONTENT_B, "subagent"),
			],
			"refine_kinds",
		);
		for (const edit of result.appliedEdits) {
			expect(edit.applied).toBe(true);
			expect(edit.nearDuplicateWarning).toBeUndefined();
		}
	});

	it("compares only within the target store", () => {
		const globalState = emptyState();
		applyEdits(globalState, [createEdit("mem_global_dup", DUP_TITLE_A, DUP_CONTENT_A)], "refine_g");
		const localState = emptyState();
		const local = applyEdits(localState, [createEdit("mem_local", DUP_TITLE_B, DUP_CONTENT_B)], "refine_l");
		expect(local.appliedEdits[0].nearDuplicateWarning).toBeUndefined();
		const global = applyEdits(globalState, [createEdit("mem_global_twin", DUP_TITLE_B, DUP_CONTENT_B)], "refine_g2");
		expect(global.appliedEdits[0].nearDuplicateWarning).toContain("mem_global_dup");
	});

	it("keeps the warning on the receipt only: the stored entry and its snapshot stay clean", () => {
		const state = emptyState();
		applyEdits(state, [createEdit("mem_original", DUP_TITLE_A, DUP_CONTENT_A)], "refine_a");
		const result = applyEdits(state, [createEdit("mem_rewrite", DUP_TITLE_B, DUP_CONTENT_B)], "refine_b");
		const edit = result.appliedEdits[0];
		expect(edit.nearDuplicateWarning).toBeDefined();
		expect(edit.after).toBeDefined();
		expect("nearDuplicateWarning" in (edit.after as HarnessEntry)).toBe(false);
		expect("nearDuplicateWarning" in state.entries.memory.mem_rewrite).toBe(false);
	});

	it("renders the warning into the refinement notice body", () => {
		const state = emptyState();
		applyEdits(state, [createEdit("mem_original", DUP_TITLE_A, DUP_CONTENT_A)], "refine_a");
		const result = applyEdits(state, [createEdit("mem_rewrite", DUP_TITLE_B, DUP_CONTENT_B)], "refine_b");
		const body = formatRefinementNoticeBody(result);
		expect(body).toContain("近重复警告");
		expect(body).toContain("mem_original");
	});

	it("matches the harness warning scores on a fixed store (cross-face pin)", () => {
		const entries: HarnessEntry[] = [
			{
				id: "mem_original",
				kind: "memory",
				title: DUP_TITLE_A,
				content: DUP_CONTENT_A,
				path: "general",
				scope: "global",
				reference: {},
				arguments: {},
				metadata: {},
				source: "test",
				created_at: "2026-08-01T00:00:00.000Z",
				updated_at: "2026-08-01T00:00:00.000Z",
				version: 1,
			},
		];
		const candidate: HarnessEntry = {
			...entries[0],
			id: "mem_rewrite",
			title: DUP_TITLE_B,
			content: DUP_CONTENT_B,
		};
		const matches = nearDuplicateMemoryMatches([...entries, candidate], candidate);
		expect(matches).toHaveLength(1);
		expect(matches[0].id).toBe("mem_original");
		// The Python face scores this pair 0.7463 (verified against
		// HarnessState._near_duplicate_memory_matches); pin the band so a
		// tokenizer or weighting drift on either side fails loudly.
		expect(matches[0].score).toBeGreaterThan(0.7);
		expect(matches[0].score).toBeLessThan(0.8);
	});
});

// Two-band threshold parity (python NearDuplicateSmallCorpusTest): below ten
// memories the idf weights are too coarse for the production-calibrated 0.40
// band (every term is rare, so generic shared bigrams score like distinctive
// ones), and the gate moves to the consolidation-grade 0.55 floor. Fixtures
// mirror the Python ones verbatim.
describe("near-duplicate small-corpus band (python parity)", () => {
	it("does not warn for shared boilerplate in a tiny corpus", () => {
		// Genuinely different rules (a session-directory convention vs a lease
		// rule) score 0.515 at N=2 - above 0.40, below the small-corpus floor -
		// so the old single band advised overwriting the old entry on a false
		// positive.
		const state = emptyState();
		applyEdits(state, [createEdit("mem_dir", "会话目录", "每个会话一个目录")], "refine_a");
		const result = applyEdits(state, [createEdit("mem_lease", "会话 lease", "每个会话一个 lease")], "refine_b");
		expect(result.appliedEdits[0].applied).toBe(true);
		expect(result.appliedEdits[0].nearDuplicateWarning).toBeUndefined();
	});

	it("still warns for a true duplicate in a tiny corpus", () => {
		// The production-calibrated rewrite pair scores 0.746 at N=2, above the
		// small-corpus floor.
		const state = emptyState();
		applyEdits(state, [createEdit("mem_original", DUP_TITLE_A, DUP_CONTENT_A)], "refine_a");
		const result = applyEdits(state, [createEdit("mem_rewrite", DUP_TITLE_B, DUP_CONTENT_B)], "refine_b");
		expect(result.appliedEdits[0].nearDuplicateWarning).toContain("mem_original");
	});

	it("keeps the calibrated 0.40 band at ten memories and above", () => {
		// At eleven memories a 0.44 match still advises: the 0.40 band is
		// production-calibrated, only tiny corpora move off it. The fixture
		// shares 7 of 12 terms with the target (measured 0.4427 at N=11).
		const state = emptyState();
		applyEdits(
			state,
			[createEdit("mem_target", "alpha bravo charlie", "delta echo foxtrot golf hotel india juliet kilo lima")],
			"refine_a",
		);
		const pads: [string, string][] = [
			["romeo sierra tango", "uniform victor whiskey xray yankee zulu"],
			["cache warmup", "cache warmup runs after every deploy to keep latency flat"],
			["queue draining", "queue draining must finish before the workers scale down"],
			["secret rotation", "secret rotation happens monthly with dual control approval"],
			["index rebuild", "index rebuild runs nightly against the replica cluster"],
			["log retention", "log retention keeps thirty days of structured request logs"],
			["schema migration", "schema migration requires a dry run against staging first"],
			["alert routing", "alert routing pages the oncall for sev1 and tickets sev3"],
			["build cache", "build cache invalidation keys on the lockfile digest"],
		];
		for (const [index, [title, content]] of pads.entries()) {
			applyEdits(state, [createEdit(`mem_pad${index}`, title, content)], `refine_pad${index}`);
		}
		const result = applyEdits(
			state,
			[createEdit("mem_cand", "alpha bravo charlie", "delta echo foxtrot golf mike november oscar papa quebec")],
			"refine_b",
		);
		expect(result.appliedEdits[0].nearDuplicateWarning).toContain("mem_target");
	});
});
