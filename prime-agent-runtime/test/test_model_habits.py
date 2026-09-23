"""The kernel API tolerates the spellings models reach for most often.

Real sessions show the same misuses again and again even when the prompt names
the right API: ``r.duration_ms`` and ``r.output()`` on a finished command,
``await`` on synchronous harness calls, ``.get()`` / ``.name`` on subagent
records. Each tolerated spelling returns the same value as the canonical one,
so a cell that uses it simply works instead of burning a turn on a traceback.
"""

from __future__ import annotations

import pickle
import tempfile
import unittest
from pathlib import Path

import rlm
from rlm import bash
from rlm.bash import BashResult
from rlm.harness import HarnessState


class BashResultHabitsTest(unittest.IsolatedAsyncioTestCase):
    def test_output_is_text_and_callable(self) -> None:
        result = BashResult(exit_code=0, output="hi\n", duration=1.2344)
        self.assertEqual(result.output, "hi\n")
        self.assertEqual(result.output(), "hi\n")
        self.assertEqual(result.output.strip(), "hi")
        self.assertEqual(result.duration_ms, 1234)

    def test_survives_pickling_for_kernel_snapshots(self) -> None:
        result = BashResult(exit_code=3, output="out", duration=0.5)
        restored = pickle.loads(pickle.dumps(result))
        self.assertEqual(restored, result)
        self.assertEqual(restored.output(), "out")

    async def test_awaiting_a_result_again_returns_it(self) -> None:
        result = BashResult(exit_code=0, output="", duration=0.0)
        self.assertIs(await result, result)

    async def test_handle_reports_exit_code_and_duration_once_finished(self) -> None:
        handle = bash("printf done")
        self.assertIsNone(handle.duration_ms if handle.exit_code is None else None)
        result = await handle
        self.assertEqual(result.output(), "done")
        self.assertEqual(handle.exit_code, 0)
        self.assertEqual(handle.duration, result.duration)
        self.assertEqual(handle.duration_ms, result.duration_ms)
        self.assertIs(await result, result)


class HarnessAwaitHabitsTest(unittest.IsolatedAsyncioTestCase):
    async def test_awaited_crud_returns_the_same_entry_once(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            entry = await state.create_memory("exam-note", "hello")
            self.assertEqual(entry.title, "exam-note")
            self.assertEqual(len(state.list("memory")), 1)
            updated = await state.update_memory(entry.id, "exam-note", "hello again")
            self.assertEqual(updated.content, "hello again")
            overview = await state.overview()
            self.assertIn("exam-note", overview)
            self.assertIn("exam-note", state.overview())
            event = await state.record_refinement("trigger", ["change"])
            self.assertEqual(event.trigger, "trigger")


class SubagentRecordHabitsTest(unittest.TestCase):
    def test_rows_answer_dict_reads_and_the_handle_name(self) -> None:
        row = rlm.RLMSubagent(
            rlm_child_id="c1",
            active_session_id=None,
            session_id="s1",
            session_name="counter",
            session_dir=Path("/tmp/c1"),
            status="idle",
        )
        self.assertEqual(row.name, "counter")
        self.assertEqual(row.get("status"), "idle")
        self.assertEqual(row["session_name"], "counter")
        self.assertIsNone(row.get("missing"))
        with self.assertRaises(KeyError):
            row["missing"]

    def test_spawn_handles_and_collect_snapshots_answer_dict_reads(self) -> None:
        handle = rlm.RLMSpawnHandle(rlm_child_id="c1", name="counter", session_dir=Path("/tmp/c1"), model="m")
        self.assertEqual(handle.get("name"), "counter")
        snapshot = rlm.RLMChildResult(
            rlm_child_id="c1",
            session_name="counter",
            session_dir=None,
            status="done",
            settled=True,
            answer_preview="3",
            error=None,
            duration_ms=10,
            tool_use_count=1,
            replied_since_task=True,
            activity_kind=None,
            terminal_kind="completed",
            terminal_reason=None,
            stall_abort=None,
        )
        self.assertEqual(snapshot.name, "counter")
        self.assertEqual(snapshot.get("answer_preview"), "3")


if __name__ == "__main__":
    unittest.main()
