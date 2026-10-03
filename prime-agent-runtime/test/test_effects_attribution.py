"""Attribution of cell file changes (rlm.effects): this session's own writes vs ambient ones.

A record carries ``origin``: ``"own"`` when the kernel saw this session make the change
(Python file wrappers, the edit skill, or a ``bash()`` command window of this session),
``"ambient"`` when the change only showed up in the before/after workspace comparison at a
moment no command of this session was running (another window, another process). The
comparison runs for every cell, so a pure-read cell still reports what others did to the
workspace while it ran; and each cell's start catches up what was written since the
previous cell's comparison ended, once no cell ran for `GAP_CHECK_MIN_GAP_S` - labeled,
never counted as the session's own.

Every case drives a real `python -m rlm.repl` process; the "other window" is the test
process itself writing mid-cell from a thread.
"""

from __future__ import annotations

import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_effects as te  # noqa: E402


class _AmbientWriter:
    """Writes/removes files from the test process after a delay, while a kernel cell runs."""

    def __init__(self) -> None:
        self._thread: threading.Thread | None = None

    def start(self, delay: float, work) -> None:
        def run() -> None:
            time.sleep(delay)
            work()

        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()

    def join(self) -> None:
        if self._thread is not None:
            self._thread.join(timeout=10)


@unittest.skipUnless(te.HAS_GIT, "git is needed for the work-tree comparison")
class AmbientAttributionTests(te.TrackerCase):
    def test_pure_read_cell_attributes_concurrent_writes_as_ambient(self):
        """A cell that only reads: every change found in the window is another process's."""
        writer = _AmbientWriter()

        def work() -> None:
            self.write("ambient-new.txt", "hello\n")
            self.write("a.txt", "changed by another window\n")

        writer.start(0.6, work)
        cell = self.kernel.run("import time\nopen('a.txt').read()\ntime.sleep(1.6)\n")
        writer.join()
        self.assertEqual(cell.status, "ok")
        files = cell.by_rel()
        self.assertEqual(files["ambient-new.txt"]["kind"], "created")
        self.assertEqual(files["ambient-new.txt"]["origin"], "ambient")
        self.assertEqual(files["ambient-new.txt"]["source"], "shell")
        self.assertEqual(files["a.txt"]["kind"], "modified")
        self.assertEqual(files["a.txt"]["origin"], "ambient")
        # Nothing here is the session's own doing.
        self.assertEqual([r for r in files.values() if r.get("origin") == "own"], [])

    def test_own_python_writes_and_ambient_writes_are_separated(self):
        """A mixed cell: the wrapper-observed write is own, the concurrent outside write is ambient."""
        writer = _AmbientWriter()
        writer.start(0.6, lambda: self.write("ambient.txt", "not us\n"))
        cell = self.kernel.run("import time\nopen('own.txt', 'w').write('ours\\n')\ntime.sleep(1.6)\n")
        writer.join()
        self.assertEqual(cell.status, "ok")
        files = cell.by_rel()
        self.assertEqual(files["own.txt"]["origin"], "own")
        self.assertEqual(files["own.txt"]["source"], "python")
        self.assertEqual(files["ambient.txt"]["origin"], "ambient")
        self.assertEqual(files["ambient.txt"]["source"], "shell")

    def test_own_command_writes_are_own_and_external_ones_ambient(self):
        """A bash() write inside its command window is own; an outside write earlier in the cell is not."""
        writer = _AmbientWriter()
        # Lands inside the cell but well before the command starts: outside every command window.
        writer.start(0.4, lambda: self.write("ambient.txt", "x\n"))
        cell = self.kernel.run("import time\ntime.sleep(1.0)\nawait bash(\"echo ours > cmd.txt\")\ntime.sleep(0.2)\n")
        writer.join()
        self.assertEqual(cell.status, "ok")
        files = cell.by_rel()
        self.assertEqual(files["cmd.txt"]["kind"], "created")
        self.assertEqual(files["cmd.txt"]["origin"], "own")
        self.assertEqual(files["cmd.txt"]["source"], "shell")
        self.assertEqual(files["ambient.txt"]["origin"], "ambient")

    def test_deletions_attribute_by_the_directory_clock(self):
        """Our own `rm` is own; a delete by another process mid-cell is ambient (no mtime, parent dir speaks)."""
        own = self.kernel.run("await bash('rm b.txt')\n")
        self.assertEqual(own.status, "ok")
        self.assertEqual(own.by_rel()["b.txt"]["kind"], "deleted")
        self.assertEqual(own.by_rel()["b.txt"]["origin"], "own")
        writer = _AmbientWriter()
        writer.start(0.5, lambda: os.remove(self.path("a.txt")))
        cell = self.kernel.run("import time\ntime.sleep(1.4)\n")
        writer.join()
        self.assertEqual(cell.status, "ok")
        files = cell.by_rel()
        self.assertEqual(files["a.txt"]["kind"], "deleted")
        self.assertEqual(files["a.txt"]["origin"], "ambient")

    def test_a_background_commands_writes_stay_own_when_it_ends_between_cells(self):
        """A handle the session left running writes in its (still open) window: own, not ambient."""
        first = self.kernel.run("h = bash('sleep 0.3; echo late > bg.txt')\nh.pid")
        self.assertNotIn("bg.txt", first.by_rel())
        time.sleep(1.2)  # the command ends while no cell runs
        second = self.kernel.run("x = 1")
        record = second.by_rel()["bg.txt"]
        self.assertEqual(record["kind"], "created")
        self.assertEqual(record["origin"], "own")

    def test_an_ambient_write_while_no_cell_runs_is_caught_up_at_the_next_cell(self):
        """The idle gap between cells (no command of this session anywhere): the next cell lists it."""
        first = self.kernel.run("x = 1")
        self.assertEqual(first.status, "ok")
        self.write("idle-gap.txt", "written between cells\n")
        time.sleep(1.2)  # past GAP_CHECK_MIN_GAP_S: the catch-up comparison runs at the next begin
        second = self.kernel.run("import time\ntime.sleep(0.6)\n")
        self.assertEqual(second.status, "ok")
        record = second.by_rel()["idle-gap.txt"]
        self.assertEqual(record["kind"], "created")
        self.assertEqual(record["origin"], "ambient")
        self.assertIn("+written between cells\n", record["diff"])

    def test_a_background_commands_gap_writes_are_listed_when_it_outlives_the_gap(self):
        """A command that writes between cells and is still running at the next cell's start:
        its gap writes land in that cell (its own window is still open, so they stay own)."""
        first = self.kernel.run("h = bash('sleep 0.8; echo late > bg-gap.txt; sleep 5')\nh.pid")
        self.assertEqual(first.status, "ok")
        self.assertNotIn("bg-gap.txt", first.by_rel())
        time.sleep(1.4)  # the write lands while no cell runs; no command ends in the gap
        try:
            second = self.kernel.run("import time\ntime.sleep(0.6)\n")
            self.assertEqual(second.status, "ok")
            record = second.by_rel()["bg-gap.txt"]
            self.assertEqual(record["kind"], "created")
            self.assertEqual(record["origin"], "own")
        finally:
            self.kernel.run("h.kill()")

    def test_an_ambient_change_then_our_own_write_to_the_same_file_is_own(self):
        """Once this session writes a file itself, its record is own even if another process touched it first."""
        writer = _AmbientWriter()
        writer.start(0.4, lambda: self.write("shared.txt", "theirs\n"))
        cell = self.kernel.run(
            "import time\ntime.sleep(1.0)\nopen('shared.txt', 'a').write('and ours\\n')\ntime.sleep(0.3)\n"
        )
        writer.join()
        self.assertEqual(cell.status, "ok")
        record = cell.by_rel()["shared.txt"]
        self.assertEqual(record["origin"], "own")


class AmbientNoGitTests(te.TrackerCase):
    use_git = False

    def test_ambient_writes_are_seen_without_git_too(self):
        writer = _AmbientWriter()
        writer.start(0.5, lambda: self.write("ambient.txt", "x\n"))
        cell = self.kernel.run("import time\ntime.sleep(1.4)\n")
        writer.join()
        self.assertEqual(cell.status, "ok")
        files = cell.by_rel()
        self.assertEqual(files["ambient.txt"]["kind"], "created")
        self.assertEqual(files["ambient.txt"]["origin"], "ambient")

    def test_an_ambient_write_while_no_cell_runs_is_caught_up_without_git_too(self):
        first = self.kernel.run("x = 1")
        self.assertEqual(first.status, "ok")
        self.write("idle-gap.txt", "between cells\n")
        time.sleep(1.2)  # past GAP_CHECK_MIN_GAP_S: the catch-up comparison runs at the next begin
        second = self.kernel.run("import time\ntime.sleep(0.6)\n")
        self.assertEqual(second.status, "ok")
        record = second.by_rel()["idle-gap.txt"]
        self.assertEqual(record["kind"], "created")
        self.assertEqual(record["origin"], "ambient")


if __name__ == "__main__":
    unittest.main()
