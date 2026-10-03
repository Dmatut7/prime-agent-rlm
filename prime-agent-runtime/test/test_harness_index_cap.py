"""Stage-2 write-side index byte cap and path-vocabulary advisory.

The digest's compact id+title index layer is byte-capped (Claude MEMORY.md /
Codex memory-v2 hard-cap pattern). The same cap sits on the write side as an
error loop: a create/update that would grow the index past the cap is refused
with consolidation guidance, while deletes and content-only updates always go
through, so an over-cap store can always be consolidated back under it.

The path advisory guides the collapsed path classification (597+ free-form
paths in the production store, 538 singletons) toward the controlled
first-segment vocabulary. Advisory only: the write stands either way.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from rlm.harness import (
    DEFAULT_HARNESS_INDEX_MAX_BYTES,
    DEFAULT_HARNESS_PATH_VOCABULARY,
    HarnessState,
)


class IndexByteCapTest(unittest.TestCase):
    def test_cap_is_display_only_without_the_enforcement_flag(self) -> None:
        """Default off: the cap shapes the digest display; writes are never refused
        until the consolidation pass exists (memory design stage 3)."""
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("First", "content one", id="first")
            with mock.patch.dict(os.environ, {"PRIME_AGENT_HARNESS_INDEX_MAX_BYTES": "1"}):
                os.environ.pop("PRIME_AGENT_HARNESS_ENFORCE_INDEX_CAP", None)
                state.create_memory("Second", "content two", id="second")
            self.assertIsNotNone(state.get("memory", "second"))


    def test_create_over_the_cap_is_refused_with_consolidation_guidance(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("First", "content one", id="first")
            state.create_memory("Second", "content two", id="second")
            cap = state.index_bytes() + 10  # one more line cannot fit
            with (
                mock.patch.dict(os.environ, {"PRIME_AGENT_HARNESS_INDEX_MAX_BYTES": str(cap), "PRIME_AGENT_HARNESS_ENFORCE_INDEX_CAP": "1"}),
                self.assertRaises(ValueError) as raised,
            ):
                state.create_memory("Third", "content three", id="third")
            message = str(raised.exception)
            self.assertIn("index byte cap", message)
            self.assertIn("consolidate", message)
            # The refusal is total: nothing half-written.
            self.assertIsNone(state.get("memory", "third"))
            self.assertEqual(sorted(entry.id for entry in state.list("memory")), ["first", "second"])

    def test_deletes_and_content_only_updates_pass_an_over_cap_store(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("Keep", "content", id="keep")
            state.create_memory("Drop", "content", id="drop")
            cap = state.index_bytes() - 1  # already over cap
            with mock.patch.dict(os.environ, {"PRIME_AGENT_HARNESS_INDEX_MAX_BYTES": str(cap), "PRIME_AGENT_HARNESS_ENFORCE_INDEX_CAP": "1"}):
                updated = state.update_memory("keep", "Keep", "rewritten and much longer content")
                self.assertEqual(updated.content, "rewritten and much longer content")
                self.assertTrue(state.delete_memory("drop"))
                # Freed room makes creates possible again.
                created = state.create_memory("New", "content", id="new")
                self.assertEqual(created.id, "new")

    def test_zero_cap_disables_the_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            with mock.patch.dict(os.environ, {"PRIME_AGENT_HARNESS_INDEX_MAX_BYTES": "0", "PRIME_AGENT_HARNESS_ENFORCE_INDEX_CAP": "1"}):
                state.create_memory("A", "content", id="a")
                state.create_memory("B", "content", id="b")
            self.assertEqual(len(state.list("memory")), 2)

    def test_invalid_env_value_falls_back_to_the_default(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            with mock.patch.dict(os.environ, {"PRIME_AGENT_HARNESS_INDEX_MAX_BYTES": "not-a-number", "PRIME_AGENT_HARNESS_ENFORCE_INDEX_CAP": "1"}):
                state.create_memory("A", "content", id="a")
            self.assertEqual(state.get("memory", "a").content, "content")
            self.assertGreater(DEFAULT_HARNESS_INDEX_MAX_BYTES, 0)

    def test_index_bytes_counts_rendered_lines_in_utf8(self) -> None:
        # Cross-face pin: refinement-digest-index.test.ts asserts the same line
        # and byte count for the same entry.
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json", scope="global")
            state.create_memory("登录故障排查", "content", id="login_fault", path="general")
            expected_line = "  - [global:login_fault] 登录故障排查 (general)\n"
            self.assertEqual(state.index_bytes(), len(expected_line.encode("utf-8")))

    def test_default_cap_keeps_a_small_store_writable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            with mock.patch.dict(os.environ, {"PRIME_AGENT_HARNESS_ENFORCE_INDEX_CAP": "1"}):
                os.environ.pop("PRIME_AGENT_HARNESS_INDEX_MAX_BYTES", None)
                for index in range(50):
                    state.create_memory(f"Fact {index}", f"content {index}", id=f"fact_{index}")
            self.assertEqual(len(state.list("memory")), 50)


class PathVocabularyAdvisoryTest(unittest.TestCase):
    def test_default_vocabulary_covers_the_observed_clusters(self) -> None:
        for segment in (
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
        ):
            self.assertIn(segment, DEFAULT_HARNESS_PATH_VOCABULARY)

    def test_off_vocabulary_first_segment_advises_and_still_writes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            receipt = state.create_memory("Fact", "content", id="m1", path="architecture/module-map")
            warning = receipt.path_vocabulary_warning
            self.assertIsNotNone(warning)
            assert warning is not None
            self.assertIn("architecture", warning)
            self.assertIn("arch", warning)
            self.assertIn("discipline", warning)
            # Advisory only: the path stored as written.
            self.assertEqual(state.get("memory", "m1").path, "architecture/module-map")

    def test_vocabulary_first_segment_with_subpath_is_silent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            receipt = state.create_memory("Fact", "content", id="m1", path="discipline/code-review")
            self.assertIsNone(receipt.path_vocabulary_warning)

    def test_first_segment_matching_is_case_insensitive(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            receipt = state.create_memory("Fact", "content", id="m1", path="Discipline/Code-Review")
            self.assertIsNone(receipt.path_vocabulary_warning)

    def test_update_without_a_path_stays_silent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("Fact", "content", id="m1", path="oneoff/topic")
            receipt = state.update_memory("m1", "Fact v2", "content v2")
            self.assertIsNone(receipt.path_vocabulary_warning)

    def test_advisory_is_receipt_only_and_never_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            state = HarnessState(state_path)
            receipt = state.create_memory("Fact", "content", id="m1", path="oneoff/topic")
            self.assertIsNotNone(receipt.path_vocabulary_warning)
            stored = state.get("memory", "m1")
            assert stored is not None
            self.assertIsNone(stored.path_vocabulary_warning)
            self.assertEqual(receipt, stored)
            raw = json.loads(state_path.read_text(encoding="utf-8"))
            for record in raw["entries"]["memory"].values():
                self.assertNotIn("path_vocabulary_warning", record)
            reloaded = HarnessState(state_path)
            self.assertIsNone(reloaded.get("memory", "m1").path_vocabulary_warning)

    def test_receipt_repr_carries_the_advisory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            receipt = state.create_memory("Fact", "content", id="m1", path="oneoff/topic")
            self.assertIn("oneoff", repr(receipt))

    def test_both_advisories_can_ride_one_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory(
                "platform_go后台建群与访客群体系是两套不相交的表",
                "platform_go 的后台建群表与访客群体系表是两套完全不相交的表，"
                "跨表查询必须走显式 join 服务，禁止假设外键一致；实测两套表的群 id 命名空间相互独立。",
                id="mem_original",
            )
            receipt = state.create_memory(
                "platform_go后台建群与访客群体系两套表不相交",
                "platform_go 的后台建群表与访客群体系表是两套完全不相交的表，"
                "跨表查询必须走显式 join 服务，禁止假设外键一致；实测两套表群 id 命名空间各自独立。",
                id="mem_rewrite",
                path="oneoff/topic",
            )
            self.assertIsNotNone(receipt.near_duplicate_warning)
            self.assertIsNotNone(receipt.path_vocabulary_warning)


if __name__ == "__main__":
    unittest.main()
