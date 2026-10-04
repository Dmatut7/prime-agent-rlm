"""Write-side near-duplicate gate for harness memory entries.

``create_memory``/``update_memory`` (and every other path funneling through
``HarnessState._upsert`` for kind ``memory``) compare the written entry against
the store's existing memories with the same bigram tokenizer and tf-idf
weighting ``search`` uses. A high-cosine match attaches a
``near_duplicate_warning`` to the returned receipt entry: advisory feedback
only, the write always stands.

The warning is receipt plumbing, not entry data: it must show up in the
receipt's ``repr`` (the model-visible channel, see repl.md's result event), it
must never persist into the state file, and it must not leak onto the stored
entry a later ``get`` returns.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from rlm.harness import HarnessState

PYTHON_REFERENCE = {
    "type": "python",
    "import": "agent_skills.example",
    "callable": "run",
    "call_pattern": "await run(...)",
}

# A CJK pair mirroring the production near-duplicate class (same-day rewrites
# under date-stamped ids): identical rule text, one clause reworded.
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

DISTINCT_TITLE = "安装器审计打法"
DISTINCT_CONTENT = (
    "install.sh 安装面端到端审计：沙箱内用假 HOME 与假 prefix 跑官方安装器，"
    "核对落盘文件清单与权限位，再对真实路径做一次干跑比对。"
)

# Same stock phrase (the shared 10-ish terms), bulk disjoint: the related-but-
# distinct case the gate must NOT fire on. Two ~40-term entries sharing only
# the discipline boilerplate land far below the threshold.
_RELATED_SHARED = "审查纪律 共享工作树 提交前必须 逐路径核对 归属判据"
RELATED_TITLE_A = "审查并发提交仓_提交说明必须按git_show_stat核"
RELATED_CONTENT_A = (
    f"{_RELATED_SHARED}。"
    "声称修的文件零行差异是最危险的一类假修复，提交说明里每个路径都要对着 git show --stat 的数字核一遍。"
    "壁挂时钟计时器预算用假时钟注入，跨席红名对账用程序化派生清单。"
)
RELATED_TITLE_B = "只读审查车道在共享worktree见脏文件只能报告不能回滚"
RELATED_CONTENT_B = (
    f"{_RELATED_SHARED}。"
    "回滚前必查归属与 blob 内容指纹，并发修复车道改完即提交；脏窗期间的临时镜像即删，"
    "干净窗落地逐字节 md5 对拍，受控差集回执。"
)


def _write_pair(state: HarnessState) -> tuple[object, object]:
    first = state.create_memory(DUP_TITLE_A, DUP_CONTENT_A, id="mem_original")
    second = state.create_memory(DUP_TITLE_B, DUP_CONTENT_B, id="mem_rewrite")
    return first, second


class NearDuplicateCreateTest(unittest.TestCase):
    def test_create_near_duplicate_warns_and_still_writes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            first, second = _write_pair(state)

            self.assertIsNone(first.near_duplicate_warning)
            warning = second.near_duplicate_warning
            self.assertIsNotNone(warning)
            assert warning is not None
            self.assertIn("近重复警告", warning)
            self.assertIn("mem_original", warning)
            # 先确认是不是同一件事：同一件事才更新（update 会整条覆盖旧条目），不同就保持新建。
            self.assertIn("先确认是不是同一件事", warning)
            self.assertNotIn("而不是新建", warning)
            self.assertNotIn("mem_rewrite", warning)
            # 写入自由：the gate never blocks; the duplicate lands in the store.
            self.assertIsNotNone(state.get("memory", "mem_rewrite"))
            self.assertEqual(len(state.list("memory")), 2)

    def test_create_distinct_memory_does_not_warn(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory(DUP_TITLE_A, DUP_CONTENT_A, id="mem_original")
            receipt = state.create_memory(DISTINCT_TITLE, DISTINCT_CONTENT, id="mem_distinct")
            self.assertIsNone(receipt.near_duplicate_warning)

    def test_create_related_but_distinct_memory_does_not_warn(self) -> None:
        # Same topic family and shared boilerplate, different rule: below the
        # threshold calibrated on the production store.
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory(RELATED_TITLE_A, RELATED_CONTENT_A, id="mem_rule_a")
            receipt = state.create_memory(RELATED_TITLE_B, RELATED_CONTENT_B, id="mem_rule_b")
            self.assertIsNone(receipt.near_duplicate_warning)

    def test_ascii_near_duplicate_warns(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory(
                "secret masking whitelist output",
                "Secret masking must use whitelist output, not blacklist regex; "
                "the four config shapes each need explicit allow rules, and dotenv-adjacent "
                "files never match on basename alone.",
                id="mem_secret_a",
            )
            receipt = state.create_memory(
                "secret masking whitelist output rule",
                "Secret masking must use whitelist output, not blacklist regex; "
                "the four config shapes each need explicit allow rules, and dotenv-adjacent "
                "files never match on basename alone. Verified again in review.",
                id="mem_secret_b",
            )
            warning = receipt.near_duplicate_warning
            self.assertIsNotNone(warning)
            assert warning is not None
            self.assertIn("mem_secret_a", warning)

    def test_first_memory_in_store_never_warns(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            receipt = state.create_memory(DUP_TITLE_A, DUP_CONTENT_A, id="mem_original")
            self.assertIsNone(receipt.near_duplicate_warning)

    def test_memory_without_tokenizable_terms_does_not_warn(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            first = state.create_memory("ab", "!! ?? ..", id="mem_punct_a")
            second = state.create_memory("cd", "!! ?? ..", id="mem_punct_b")
            self.assertIsNone(first.near_duplicate_warning)
            self.assertIsNone(second.near_duplicate_warning)
            self.assertEqual(len(state.list("memory")), 2)

    def test_warning_names_top_matches_best_first(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory(DUP_TITLE_A, DUP_CONTENT_A, id="mem_original")
            state.create_memory(DUP_TITLE_B, DUP_CONTENT_B, id="mem_rewrite")
            # A third write near-identical to both existing entries must name
            # both, capped and deterministically ordered.
            third = state.create_memory(DUP_TITLE_A, DUP_CONTENT_A + " 补充：同上。", id="mem_third")
            warning = third.near_duplicate_warning
            self.assertIsNotNone(warning)
            assert warning is not None
            self.assertIn("mem_original", warning)
            self.assertIn("mem_rewrite", warning)


class NearDuplicateUpdateTest(unittest.TestCase):
    def test_update_onto_another_entry_warns_and_names_the_other(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory(DUP_TITLE_A, DUP_CONTENT_A, id="mem_original")
            state.create_memory(DISTINCT_TITLE, DISTINCT_CONTENT, id="mem_distinct")

            receipt = state.update_memory("mem_distinct", DUP_TITLE_B, DUP_CONTENT_B)
            warning = receipt.near_duplicate_warning
            self.assertIsNotNone(warning)
            assert warning is not None
            self.assertIn("近重复警告", warning)
            self.assertIn("mem_original", warning)
            # The updated entry itself is excluded from its own match list.
            self.assertNotIn("mem_distinct", warning)
            self.assertIn("合并", warning)

    def test_update_own_content_does_not_warn_about_itself(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory(DUP_TITLE_A, DUP_CONTENT_A, id="mem_original")
            state.create_memory(DISTINCT_TITLE, DISTINCT_CONTENT, id="mem_distinct")
            receipt = state.update_memory("mem_original", DUP_TITLE_A, DUP_CONTENT_A + " 版本二，措辞微调。")
            self.assertIsNone(receipt.near_duplicate_warning)

    def test_upsert_existing_memory_uses_update_wording(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory(DUP_TITLE_A, DUP_CONTENT_A, id="mem_original")
            receipt = state.upsert("memory", DUP_TITLE_B, DUP_CONTENT_B, id="mem_original")
            # Rewriting the same id is an update: no *other* entry is similar.
            self.assertIsNone(receipt.near_duplicate_warning)
            state.create_memory(DISTINCT_TITLE, DISTINCT_CONTENT, id="mem_distinct")
            receipt = state.upsert("memory", DUP_TITLE_B, DUP_CONTENT_B, id="mem_distinct")
            warning = receipt.near_duplicate_warning
            self.assertIsNotNone(warning)
            assert warning is not None
            self.assertIn("合并", warning)


class NearDuplicateReceiptPlumbingTest(unittest.TestCase):
    def test_receipt_repr_carries_the_warning(self) -> None:
        # The REPL reports the trailing expression's repr to the model; the
        # warning must be visible there, not only via attribute access.
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            _first, second = _write_pair(state)
            text = repr(second)
            self.assertIn("近重复警告", text)
            self.assertIn("mem_original", text)

    def test_stored_entry_stays_clean_and_receipt_still_equals_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            _first, second = _write_pair(state)
            stored = state.get("memory", "mem_rewrite")
            assert stored is not None
            self.assertIsNone(stored.near_duplicate_warning)
            # The warned receipt is feedback on a copy; it still *is* the entry
            # for equality and field access.
            self.assertEqual(second, stored)
            self.assertEqual(second.id, stored.id)
            self.assertEqual(second.version, stored.version)
            # A later get/overview-style read shows no stale advice.
            self.assertIsNone(state.get("memory", "mem_rewrite").near_duplicate_warning)

    def test_warning_is_never_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            state = HarnessState(state_path)
            _write_pair(state)
            raw = json.loads(state_path.read_text(encoding="utf-8"))
            entries = raw["entries"]["memory"]
            self.assertGreater(len(entries), 0)
            for record in entries.values():
                self.assertNotIn("near_duplicate_warning", record)
            for record in state.snapshot()["entries"]["memory"].values():
                self.assertNotIn("near_duplicate_warning", record)
            # Reloading from disk yields a clean entry too.
            reloaded = HarnessState(state_path)
            self.assertIsNone(reloaded.get("memory", "mem_rewrite").near_duplicate_warning)

    def test_non_memory_kinds_never_warn(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_prompt_note(DUP_TITLE_A, DUP_CONTENT_A, id="prompt_a")
            prompt_receipt = state.create_prompt_note(DUP_TITLE_B, DUP_CONTENT_B, id="prompt_b")
            state.create_subagent(DUP_TITLE_A, DUP_CONTENT_A, id="sub_a")
            subagent_receipt = state.create_subagent(DUP_TITLE_B, DUP_CONTENT_B, id="sub_b")
            state.create_skill(DUP_TITLE_A, DUP_CONTENT_A, id="skill_a", reference=PYTHON_REFERENCE)
            skill_receipt = state.create_skill(DUP_TITLE_B, DUP_CONTENT_B, id="skill_b", reference=PYTHON_REFERENCE)
            self.assertIsNone(prompt_receipt.near_duplicate_warning)
            self.assertIsNone(subagent_receipt.near_duplicate_warning)
            self.assertIsNone(skill_receipt.near_duplicate_warning)

    def test_in_memory_state_warns_without_persistence(self) -> None:
        state = HarnessState(in_memory=True)
        first, second = _write_pair(state)
        self.assertIsNone(first.near_duplicate_warning)
        self.assertIsNotNone(second.near_duplicate_warning)


class NearDuplicateSmallCorpusTest(unittest.TestCase):
    """Two-band threshold: below ten memories the idf weights are too coarse
    for the production-calibrated 0.40 band (every term is rare, so generic
    shared bigrams score like distinctive ones), and the gate moves to the
    consolidation-grade 0.55 floor."""

    def test_tiny_corpus_shared_boilerplate_does_not_warn(self) -> None:
        # Genuinely different rules (a session-directory convention vs a lease
        # rule) score 0.515 at N=2 - above 0.40, below the small-corpus floor -
        # so the old gate advised overwriting the old entry on a false positive.
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("会话目录", "每个会话一个目录", id="mem_dir")
            receipt = state.create_memory("会话 lease", "每个会话一个 lease", id="mem_lease")
            self.assertIsNone(receipt.near_duplicate_warning)

    def test_tiny_corpus_true_duplicate_still_warns(self) -> None:
        # The production-calibrated rewrite pair scores 0.746 at N=2, above the
        # small-corpus floor.
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory(DUP_TITLE_A, DUP_CONTENT_A, id="mem_original")
            receipt = state.create_memory(DUP_TITLE_B, DUP_CONTENT_B, id="mem_rewrite")
            warning = receipt.near_duplicate_warning
            self.assertIsNotNone(warning)
            assert warning is not None
            self.assertIn("mem_original", warning)

    def test_larger_corpus_keeps_the_calibrated_band(self) -> None:
        # At eleven memories a 0.44 match still advises: the 0.40 band is
        # production-calibrated, only tiny corpora move off it. The fixture
        # shares 7 of 12 terms with the target (measured 0.4427 at N=11).
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory(
                "alpha bravo charlie", "delta echo foxtrot golf hotel india juliet kilo lima", id="mem_target"
            )
            pads = [
                ("romeo sierra tango", "uniform victor whiskey xray yankee zulu"),
                ("cache warmup", "cache warmup runs after every deploy to keep latency flat"),
                ("queue draining", "queue draining must finish before the workers scale down"),
                ("secret rotation", "secret rotation happens monthly with dual control approval"),
                ("index rebuild", "index rebuild runs nightly against the replica cluster"),
                ("log retention", "log retention keeps thirty days of structured request logs"),
                ("schema migration", "schema migration requires a dry run against staging first"),
                ("alert routing", "alert routing pages the oncall for sev1 and tickets sev3"),
                ("build cache", "build cache invalidation keys on the lockfile digest"),
            ]
            for index, (title, content) in enumerate(pads):
                state.create_memory(title, content, id=f"mem_pad{index}")
            receipt = state.create_memory(
                "alpha bravo charlie", "delta echo foxtrot golf mike november oscar papa quebec", id="mem_cand"
            )
            warning = receipt.near_duplicate_warning
            self.assertIsNotNone(warning)
            assert warning is not None
            self.assertIn("mem_target", warning)


class NearDuplicateScopeTest(unittest.TestCase):
    def test_each_store_compares_against_its_own_memories(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            local = HarnessState(Path(temp_dir) / "local" / "harness_state.json", scope="local")
            global_state = HarnessState(Path(temp_dir) / "global" / "harness_state.json", scope="global")
            global_state.create_memory(DUP_TITLE_A, DUP_CONTENT_A, id="mem_global_dup")

            # The local store has no memories: writing the near-duplicate of a
            # *global* entry into the local store must not warn.
            local_receipt = local.create_memory(DUP_TITLE_B, DUP_CONTENT_B, id="mem_local")
            self.assertIsNone(local_receipt.near_duplicate_warning)

            # Writing it into the store that already holds the twin must warn.
            global_receipt = global_state.create_memory(DUP_TITLE_B, DUP_CONTENT_B, id="mem_global_twin")
            warning = global_receipt.near_duplicate_warning
            self.assertIsNotNone(warning)
            assert warning is not None
            self.assertIn("mem_global_dup", warning)

    def test_deleted_twin_stops_warning(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            _write_pair(state)
            self.assertTrue(state.delete_memory("mem_original"))
            receipt = state.create_memory(DUP_TITLE_A, DUP_CONTENT_A, id="mem_third")
            warning = receipt.near_duplicate_warning
            self.assertIsNotNone(warning)
            assert warning is not None
            # Only the surviving twin is named.
            self.assertIn("mem_rewrite", warning)
            self.assertNotIn("mem_original", warning)


if __name__ == "__main__":
    unittest.main()
