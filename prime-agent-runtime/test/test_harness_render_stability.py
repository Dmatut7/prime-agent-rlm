"""MEM-STABLE (wave-32): the kernel-side harness overview renders byte-identical
text for the same logical store.

The host's cached prompt prefix carries the TS-rendered digest; the kernel's
``overview()`` is the same store's other face, and both must serialize one
logical state to one byte sequence. The CC 2.1.275 regression this pins
against: a recovered memory file whose rendered age note moved between
requests invalidated the whole prompt cache every turn. These tests pin:
permuted dict insertion order, a real wall-clock gap between renders, a
save/load round-trip, and a permuted ``arguments`` dict all leave every
rendered byte untouched, and the render contains no relative-time text.
"""

from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

from rlm.harness import HarnessState, _harness_store_digest

PYTHON_REFERENCE = {
    "type": "python",
    "import": "agent_skills.example",
    "callable": "run",
    "call_pattern": "await run(...)",
}


def _build_state(directory: str) -> HarnessState:
    """One shared logical store, rich enough to reach every overview branch:
    the detail window, the overflow catalog, the omitted-ids tail, a skill's
    args/ref contract, and the refinements tail."""
    state = HarnessState(Path(directory) / "harness_state.json")
    # 60 memories over a window of 3 force the overflow catalog past its
    # 50-line cap, so the omitted-ids tail renders too.
    for i in range(60):
        state.create_memory(
            f"memory {i} cache 缓存",
            f"memory {i} body: prompt cache digest stability 缓存",
            id=f"mem_{i:02d}",
            metadata={"ordinal": i},
        )
    state.create_memory("修复登录 title", "locale probe content", id="修复登录")
    state.create_memory("登录故障 title", "locale probe content", id="登录故障")
    state.create_skill(
        "review skill",
        "review a patch",
        id="skill_review",
        reference=PYTHON_REFERENCE,
        arguments={
            "target": {"type": "string", "required": True},
            "mode": {"type": "string"},
        },
    )
    state.create_prompt_note("tone note", "keep answers short", id="prompt_tone")
    state.create_subagent("scout spec", "explore the repo", id="sub_scout")
    for i in range(7):
        state.record_refinement(
            f"refinement {i}: record the cache lesson", [f"memory:mem_{i:02d}"]
        )
    return state


def _reversed_entries(state: HarnessState) -> None:
    """Rebuild every per-kind records dict in reversed insertion order."""
    state.entries = {
        kind: dict(reversed(list(records.items())))
        for kind, records in state.entries.items()
    }


class HarnessRenderStabilityTest(unittest.TestCase):
    def test_overview_is_byte_identical_across_insertion_orders(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = _build_state(temp_dir)
            forward = str(state.overview(max_entries_per_kind=3))
            # The fixture really exercises the branches this pin exists for.
            self.assertIn("+59 more (id + title only; fetch with get):", forward)
            self.assertIn("more ids omitted", forward)
            self.assertIn(" args=", forward)
            self.assertIn(" ref=", forward)
            _reversed_entries(state)
            self.assertEqual(str(state.overview(max_entries_per_kind=3)), forward)
            # Same pin for the plan-apply freshness token.
            digest = _harness_store_digest(state.entries)
            _reversed_entries(state)
            self.assertEqual(_harness_store_digest(state.entries), digest)

    def test_overview_is_byte_identical_across_a_wall_clock_gap(self) -> None:
        # The CC 2.1.275 failure class: an age note recomputed per request. The
        # overview must carry stored timestamps only, never a render-time clock.
        with tempfile.TemporaryDirectory() as temp_dir:
            state = _build_state(temp_dir)
            before = str(state.overview(max_entries_per_kind=3))
            time.sleep(0.02)
            after = str(state.overview(max_entries_per_kind=3))
            self.assertEqual(after, before)
            for unit in ("second", "minute", "hour", "day"):
                self.assertNotIn(f" {unit}s ago", before)
                self.assertNotIn(f" {unit} ago", before)

    def test_overview_is_byte_identical_after_a_save_load_round_trip(self) -> None:
        # A kernel restart re-parses the store from disk; the reloaded state
        # must render the same bytes the live state rendered before it.
        with tempfile.TemporaryDirectory() as temp_dir:
            state = _build_state(temp_dir)
            live = str(state.overview(max_entries_per_kind=3))
            state.save()
            reloaded = HarnessState(Path(temp_dir) / "harness_state.json")
            self.assertEqual(str(reloaded.overview(max_entries_per_kind=3)), live)

    def test_overview_is_byte_identical_when_skill_argument_key_order_flips(
        self,
    ) -> None:
        # The overview serializes skill contracts with sort_keys=True, so the
        # on-disk key order of arguments/reference cannot move a rendered byte.
        with tempfile.TemporaryDirectory() as temp_dir:
            state = _build_state(temp_dir)
            before = str(state.overview(max_entries_per_kind=3))
            skill = state.entries["skill"]["skill_review"]
            skill.arguments = dict(reversed(list(skill.arguments.items())))
            skill.reference = dict(reversed(list(skill.reference.items())))
            self.assertEqual(str(state.overview(max_entries_per_kind=3)), before)

    def test_state_file_round_trip_is_byte_identical(self) -> None:
        # The persisted file itself must not drift either: save, reload, save
        # again, and the second save writes exactly the first save's bytes.
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "harness_state.json"
            state = _build_state(temp_dir)
            state.save()
            first = path.read_bytes()
            reloaded = HarnessState(path)
            reloaded.save()
            self.assertEqual(path.read_bytes(), first)
            # Guard against an empty-file pass: the store really is on disk.
            self.assertGreater(len(json.loads(first)["entries"]["memory"]), 0)


if __name__ == "__main__":
    unittest.main()
