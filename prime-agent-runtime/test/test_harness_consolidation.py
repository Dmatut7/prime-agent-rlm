"""Consolidation pass (memory-recall-design.md stage 3).

plan_consolidation() proposes merge/delete/rename operations that shrink the
compact id+title index toward its byte cap; it is a dry-run and never writes.
apply_consolidation() executes an explicit plan in one locked pass. The
fixtures below mirror packages/coding-agent/test/refinement-consolidation.test.ts
verbatim so both faces are pinned against the same store content: same
tokenizer, same idf-weighted cosine, same canonical/merge/rename rules.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from rlm.harness import (
    CONSOLIDATION_MERGE_MIN_SCORE,
    ConsolidationOperation,
    ConsolidationPlan,
    HarnessState,
)

DUP_TITLE_A = "platform_go后台建群与访客群体系是两套不相交的表"
DUP_CONTENT_A = (
    "platform_go 的后台建群表与访客群体系表是两套完全不相交的表，"
    "跨表查询必须走显式 join 服务，禁止假设外键一致；实测两套表的群 id 命名空间相互独立。"
)
DUP_TITLE_B = "platform_go后台建群与访客群体系两套表不相交"
DUP_CONTENT_B = (
    "platform_go 的后台建群表与访客群体系表是两套完全不相交的表，"
    "跨表查询必须走显式 join 服务，禁止假设外键一致；实测两套表群 id 命名空间各自独立。"
)
# The one sentence A carries that B lacks, bullet-unioned into the merged body.
DUP_UNIQUE_PIECE = "实测两套表的群 id 命名空间相互独立"

DISTINCT_TITLE = "安装器审计打法"
DISTINCT_CONTENT = (
    "install.sh 安装面端到端审计：沙箱内用假 HOME 与假 prefix 跑官方安装器，"
    "核对落盘文件清单与权限位，再对真实路径做一次干跑比对。"
)

NOW = datetime(2026, 10, 3, tzinfo=timezone.utc)


def make_state(temp_dir: str) -> HarnessState:
    return HarnessState(Path(temp_dir) / "harness_state.json", scope="global")


def seed_duplicates(state: HarnessState) -> None:
    state.create_memory(DUP_TITLE_A, DUP_CONTENT_A, id="mem_original")
    state.create_memory(DUP_TITLE_B, DUP_CONTENT_B, id="mem_rewrite")
    state.create_memory(DISTINCT_TITLE, DISTINCT_CONTENT, id="mem_distinct")


class PlanMergeTest(unittest.TestCase):
    def test_plan_is_a_dry_run_and_proposes_the_duplicate_merge(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            state = make_state(temp_dir)
            seed_duplicates(state)
            on_disk_before = state_path.read_bytes()
            plan = state.plan_consolidation(now=NOW)
            # Dry-run: neither the in-memory store nor the file moved.
            self.assertEqual(sorted(state.entries["memory"]), ["mem_distinct", "mem_original", "mem_rewrite"])
            self.assertEqual(state_path.read_bytes(), on_disk_before)

            self.assertEqual(plan.stats, {"merges": 1, "absorbed_entries": 1, "stale_deletes": 0, "renames": 0})
            self.assertLess(plan.index_bytes_after, plan.index_bytes_before)
            self.assertTrue(plan.fits_cap)
            (merge,) = plan.operations
            self.assertEqual(merge.action, "merge")
            self.assertEqual(merge.kind, "memory")
            # Canonical is the most recently updated cluster member.
            self.assertEqual(merge.id, "mem_rewrite")
            self.assertEqual(merge.absorb_ids, ("mem_original",))
            self.assertEqual(merge.title, DUP_TITLE_B)
            assert merge.content is not None
            self.assertTrue(merge.content.startswith(DUP_CONTENT_B))
            self.assertIn(f"\n\n合并补充：\n- {DUP_UNIQUE_PIECE}", merge.content)
            self.assertGreaterEqual(merge.score or 0, CONSOLIDATION_MERGE_MIN_SCORE)

    def test_plan_is_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            seed_duplicates(state)
            first = state.plan_consolidation(now=NOW)
            second = state.plan_consolidation(now=NOW)
            self.assertEqual(first.to_dict(), second.to_dict())

    def test_merge_threshold_is_respected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            seed_duplicates(state)
            # Above the pair's score: no merge is suggested.
            high = state.plan_consolidation(merge_min_score=0.99, now=NOW)
            self.assertEqual(high.operations, [])
            # At the default the pair merges.
            default = state.plan_consolidation(now=NOW)
            self.assertEqual(len(default.operations), 1)

    def test_distinct_entries_are_not_merged(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            state.create_memory(DUP_TITLE_A, DUP_CONTENT_A, id="mem_a")
            state.create_memory(DISTINCT_TITLE, DISTINCT_CONTENT, id="mem_b")
            plan = state.plan_consolidation(now=NOW)
            self.assertEqual(plan.operations, [])
            self.assertEqual(plan.index_bytes_after, plan.index_bytes_before)

    def test_exact_content_duplicates_merge_with_no_appendix(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            state.create_memory("同一条规则", "完全相同的两条正文。", id="mem_old")
            state.create_memory("同一条规则 v2", "完全相同的两条正文。", id="mem_new")
            plan = state.plan_consolidation(now=NOW)
            (merge,) = plan.operations
            self.assertEqual(merge.action, "merge")
            self.assertEqual(merge.content, "完全相同的两条正文。")

    def test_non_memory_kinds_are_untouched_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            state.create_prompt_note(DUP_TITLE_A, DUP_CONTENT_A, id="prompt_a")
            state.create_prompt_note(DUP_TITLE_B, DUP_CONTENT_B, id="prompt_b")
            plan = state.plan_consolidation(now=NOW)
            self.assertEqual(plan.operations, [])
            widened = state.plan_consolidation(kinds=("prompt",), now=NOW)
            self.assertEqual(len(widened.operations), 1)
            self.assertEqual(widened.operations[0].kind, "prompt")

    def test_unknown_kind_and_bad_score_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            with self.assertRaises(ValueError):
                state.plan_consolidation(kinds=("bogus",))
            with self.assertRaises(ValueError):
                state.plan_consolidation(merge_min_score=1.5)

    def test_empty_store_plans_nothing_and_fits(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            plan = state.plan_consolidation(now=NOW)
            self.assertEqual(plan.operations, [])
            self.assertEqual(plan.index_bytes_before, 0)
            self.assertEqual(plan.index_bytes_after, 0)
            self.assertTrue(plan.fits_cap)


class PlanStaleTest(unittest.TestCase):
    def test_contained_and_similar_pair_merges_instead_of_deleting(self) -> None:
        # A fully contained body is usually also a high-cosine near-duplicate;
        # the merge pass runs first and claims it (absorption keeps the audit
        # trail a delete would not).
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            contained_body = "提交前必须逐路径核对归属判据，别扫整个工作树；提交说明里每个路径都要对着 git show --stat 的数字核一遍。"
            state.create_memory("短规则", contained_body, id="mem_small")
            state.create_memory(
                "长规则",
                contained_body + "此外，壁挂时钟计时器预算用假时钟注入，跨席红名对账用程序化派生清单。",
                id="mem_large",
            )
            plan = state.plan_consolidation(now=NOW)
            self.assertEqual([(op.action, op.id, op.absorb_ids) for op in plan.operations],
                             [("merge", "mem_large", ("mem_small",))])
            self.assertLess(plan.index_bytes_after, plan.index_bytes_before)

    def test_contained_entry_in_a_dissimilar_container_is_suggested_for_delete(self) -> None:
        # Cosine dilutes below the merge threshold when the container is much
        # larger; containment still recognizes the short entry as redundant.
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            contained_body = "提交前必须逐路径核对归属判据，别扫整个工作树；提交说明里每个路径都要对着 git show --stat 的数字核一遍。"
            padding = " ".join(f"word{i}" for i in range(110))
            state.create_memory("短规则", contained_body, id="mem_small")
            state.create_memory("大杂烩手册", f"{contained_body} {padding}", id="mem_large")
            plan = state.plan_consolidation(now=NOW)
            deletes = [op for op in plan.operations if op.action == "delete"]
            self.assertEqual([(op.id, op.reason) for op in deletes], [("mem_small", "contained:mem_large")])
            self.assertLess(plan.index_bytes_after, plan.index_bytes_before)

    def test_short_bodies_are_not_containment_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            state.create_memory("短", "短正文。", id="mem_small")
            state.create_memory("长", "短正文。这是一条长很多的正文，包含前面那条短正文的全部内容。", id="mem_large")
            plan = state.plan_consolidation(now=NOW)
            self.assertEqual([op for op in plan.operations if op.action == "delete"], [])

    def test_age_stale_is_opt_in_and_uses_the_injected_clock(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            state.create_memory("旧条目", "一条足够长的正文，用来触发陈旧检测的条目。", id="mem_old")
            entry = state.get("memory", "mem_old")
            assert entry is not None
            entry.updated_at = "2026-08-01T00:00:00+00:00"
            state.save()
            # Off by default.
            self.assertEqual(state.plan_consolidation(now=NOW).operations, [])
            plan = state.plan_consolidation(stale_days=60, now=NOW)
            deletes = [op for op in plan.operations if op.action == "delete"]
            self.assertEqual([(op.id, op.reason) for op in deletes], [("mem_old", "stale:63d")])
            # A fresh clock that predates the threshold deletes nothing.
            fresh = state.plan_consolidation(stale_days=60, now=datetime(2026, 8, 15, tzinfo=timezone.utc))
            self.assertEqual(fresh.operations, [])

    def test_unparseable_timestamp_is_not_age_stale(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            state.create_memory("坏时间戳", "一条足够长的正文，用来触发陈旧检测的条目。", id="mem_bad_ts")
            entry = state.get("memory", "mem_bad_ts")
            assert entry is not None
            entry.updated_at = "not-a-timestamp"
            entry.created_at = "also-bad"
            state.save()
            plan = state.plan_consolidation(stale_days=1, now=NOW)
            self.assertEqual(plan.operations, [])


class PlanRenameTest(unittest.TestCase):
    def test_titles_over_the_slim_cap_are_suggested_for_rename(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            long_title = "这是一条很长的标题" * 20  # 180 code points
            state.create_memory(long_title, "正文", id="mem_long")
            plan = state.plan_consolidation(now=NOW)
            (rename,) = plan.operations
            self.assertEqual(rename.action, "rename")
            self.assertEqual(rename.id, "mem_long")
            assert rename.title is not None
            self.assertEqual(len(rename.title), 120)
            self.assertEqual(rename.previous_title_chars, 180)
            # The default slim cap is the index render cap: the rename costs the
            # digest face nothing, so the index byte math is unchanged.
            self.assertEqual(plan.index_bytes_after, plan.index_bytes_before)

    def test_slim_cap_below_the_render_cap_saves_index_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            long_title = "这是一条很长的标题" * 20
            state.create_memory(long_title, "正文", id="mem_long")
            plan = state.plan_consolidation(slim_title_chars=40, now=NOW)
            (rename,) = plan.operations
            self.assertEqual(len(rename.title), 40)
            self.assertLess(plan.index_bytes_after, plan.index_bytes_before)

    def test_slim_pass_disabled_with_zero_or_none(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            state.create_memory("这是一条很长的标题" * 20, "正文", id="mem_long")
            self.assertEqual(state.plan_consolidation(slim_title_chars=0, now=NOW).operations, [])
            self.assertEqual(state.plan_consolidation(slim_title_chars=None, now=NOW).operations, [])

    def test_newline_carrying_titles_slim_flattened(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            state.create_memory("标题\n换行 " * 20, "正文", id="mem_newline")
            plan = state.plan_consolidation(slim_title_chars=10, now=NOW)
            (rename,) = plan.operations
            assert rename.title is not None
            self.assertNotIn("\n", rename.title)
            self.assertEqual(len(rename.title), 10)


class ApplyTest(unittest.TestCase):
    def test_apply_merges_persists_and_records_a_refinement_event(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            state = make_state(temp_dir)
            seed_duplicates(state)
            plan = state.plan_consolidation(now=NOW)
            result = state.apply_consolidation(plan)
            self.assertTrue(result.consolidation_id.startswith("consolidate_"))
            self.assertEqual([(edit.action, edit.id, edit.applied) for edit in result.edits],
                             [("update", "mem_rewrite", True), ("delete", "mem_original", True)])
            self.assertEqual(result.index_bytes_after, plan.index_bytes_after)
            self.assertTrue(result.fits_cap)

            merged = state.get("memory", "mem_rewrite")
            assert merged is not None
            self.assertEqual(merged.version, 2)
            self.assertEqual(merged.source, "refine")
            self.assertIn(DUP_UNIQUE_PIECE, merged.content)
            self.assertIsNone(state.get("memory", "mem_original"))

            (event,) = state.refinements[-1:]
            self.assertEqual(event.id, result.consolidation_id)
            self.assertIn("Consolidation pass: 1 merges", event.trigger)
            self.assertIn("update memory:mem_rewrite", event.changes)
            self.assertIn("delete memory:mem_original", event.changes)

            reloaded = make_state(temp_dir)
            self.assertEqual(sorted(reloaded.entries["memory"]), ["mem_distinct", "mem_rewrite"])
            assert reloaded.get("memory", "mem_rewrite") is not None
            self.assertIn(DUP_UNIQUE_PIECE, reloaded.get("memory", "mem_rewrite").content)  # type: ignore[union-attr]

    def test_apply_refuses_a_stale_plan(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            seed_duplicates(state)
            plan = state.plan_consolidation(now=NOW)
            state.create_memory("新条目", "planning 之后又写入了一条。", id="mem_new")
            with self.assertRaises(ValueError) as raised:
                state.apply_consolidation(plan)
            self.assertIn("stale", str(raised.exception))
            # Nothing was applied.
            self.assertEqual(len(state.list("memory")), 4)
            # The explicit override applies anyway.
            result = state.apply_consolidation(plan, allow_stale_plan=True)
            self.assertTrue(all(edit.applied for edit in result.edits))
            self.assertEqual(sorted(state.entries["memory"]), ["mem_distinct", "mem_new", "mem_rewrite"])

    def test_apply_is_not_gated_by_the_index_cap(self) -> None:
        # Consolidation is how an over-cap store gets back under the cap: the
        # merge/delete/rename operations must land even with enforcement on.
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            seed_duplicates(state)
            plan = state.plan_consolidation(now=NOW)
            with mock.patch.dict(
                os.environ,
                {"PRIME_AGENT_HARNESS_INDEX_MAX_BYTES": "1", "PRIME_AGENT_HARNESS_ENFORCE_INDEX_CAP": "1"},
            ):
                result = state.apply_consolidation(plan)
            self.assertTrue(all(edit.applied for edit in result.edits))
            self.assertEqual(sorted(state.entries["memory"]), ["mem_distinct", "mem_rewrite"])

    def test_apply_reports_missing_entries_without_failing_the_batch(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            seed_duplicates(state)
            plan = state.plan_consolidation(now=NOW)
            state.delete_memory("mem_original")
            result = state.apply_consolidation(plan, allow_stale_plan=True)
            by_id = {(edit.action, edit.id): edit for edit in result.edits}
            self.assertTrue(by_id[("update", "mem_rewrite")].applied)
            self.assertFalse(by_id[("delete", "mem_original")].applied)
            self.assertEqual(by_id[("delete", "mem_original")].error, "entry not found")

    def test_failed_save_rolls_the_in_memory_store_back(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            seed_duplicates(state)
            plan = state.plan_consolidation(now=NOW)
            with mock.patch.object(HarnessState, "save", side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    state.apply_consolidation(plan)
            # In-memory entries and the refinement log are back at the pre-apply state.
            self.assertEqual(sorted(state.entries["memory"]), ["mem_distinct", "mem_original", "mem_rewrite"])
            entry = state.get("memory", "mem_rewrite")
            assert entry is not None
            self.assertEqual(entry.version, 1)
            self.assertEqual(entry.content, DUP_CONTENT_B)

    def test_plan_applies_round_trip_through_dict_form(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            seed_duplicates(state)
            plan = state.plan_consolidation(now=NOW)
            as_dict = plan.to_dict()
            # The dict form is JSON-round-trippable (dry-run output is printed).
            json.dumps(as_dict)
            self.assertEqual(as_dict["stats"]["merges"], 1)

    def test_apply_rejects_a_non_plan(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = make_state(temp_dir)
            with self.assertRaises(TypeError):
                state.apply_consolidation({"operations": []})  # type: ignore[arg-type]

    def test_noop_plan_applies_without_touching_the_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            state = make_state(temp_dir)
            state.create_memory(DISTINCT_TITLE, DISTINCT_CONTENT, id="mem_distinct")
            on_disk_before = state_path.read_bytes()
            plan = ConsolidationPlan(
                store_digest=state.plan_consolidation(now=NOW).store_digest,
                options={"index_max_bytes": 12288},
                index_bytes_before=0,
                index_bytes_after=0,
                fits_cap=True,
                operations=[],
                stats={"merges": 0, "absorbed_entries": 0, "stale_deletes": 0, "renames": 0},
            )
            result = state.apply_consolidation(plan)
            self.assertEqual(result.edits, [])
            self.assertEqual(state_path.read_bytes(), on_disk_before)
            self.assertEqual(len(state.refinements), 0)


if __name__ == "__main__":
    unittest.main()
