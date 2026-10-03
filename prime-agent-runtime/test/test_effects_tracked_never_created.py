"""Regression: a file git knew about before the cell is never reported as created.

W21-F: a tracked file whose before-content the tracker failed to capture was minted an
absent baseline, so the cell's record said kind=created with the whole file as added
lines (the turn strip's "+23442" for a +169/-14 edit). The hard rule: an entry the
before-state knows about whose real old content is unavailable degrades to unknown
(0/0, diffOmitted), never to created.

Like test_effects, these cases drive a real `python -m rlm.repl` process in a throwaway
directory, so the wrappers, the git before/after comparison and the mtime scan are the
shipped ones.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_effects import HAS_GIT, TrackerCase, _git  # noqa: E402
from rlm import effects  # noqa: E402


@unittest.skipUnless(HAS_GIT, "git is needed for the work-tree comparison")
class TrackedNeverCreatedTests(TrackerCase):
    def commit(self, rel: str, text: str) -> None:
        self.write(rel, text)
        _git(self.root, "add", rel)
        _git(self.root, "commit", "-qm", f"add {rel}")

    def test_a_tracked_file_the_before_snapshot_could_not_stat_is_not_a_creation(self):
        # A fifo where a tracked file sits: git lists it as modified, but lstat gives no
        # regular-file signature, so the before-snapshot holds no stat and no content for it.
        # That is the same slot a transient stat failure (an atomic save landing mid-snapshot)
        # leaves, and it must not read as "the file was absent".
        self.commit("victim.txt", "one\ntwo\nthree\n")
        os.remove(self.path("victim.txt"))
        os.mkfifo(self.path("victim.txt"))
        cell = self.kernel.run("await bash('rm victim.txt && printf \"new\\ncontent\\n\" > victim.txt')")
        record = cell.by_rel()["victim.txt"]
        self.assertEqual(record["kind"], "modified", record)
        self.assertEqual((record["added"], record["removed"]), (0, 0))
        self.assertEqual(record.get("diffOmitted"), "no_baseline", record)

    def test_a_file_deleted_before_the_cell_and_recreated_inside_it_is_a_creation(self):
        # The one absent baseline that stays: git said the worktree side was deleted, so the
        # file really was not there when the cell started.
        self.commit("gone.txt", "old\n")
        os.remove(self.path("gone.txt"))
        cell = self.kernel.run("await bash('echo back > gone.txt')")
        record = cell.by_rel()["gone.txt"]
        self.assertEqual(record["kind"], "created", record)
        self.assertEqual((record["added"], record["removed"]), (1, 0))

    def test_untracking_a_committed_file_does_not_turn_it_into_a_creation(self):
        # `git rm --cached` keeps the worktree file but untracks it: the after-state says
        # "??" for a file the before-commit still holds. The before-commit decides.
        self.commit("cached.txt", "one\ntwo\nthree\n")
        cell = self.kernel.run("await bash('git rm --cached -q cached.txt && echo four >> cached.txt')")
        record = cell.by_rel()["cached.txt"]
        self.assertEqual(record["kind"], "modified", record)
        self.assertEqual((record["added"], record["removed"]), (1, 0))
        self.assertIn("+four\n", record["diff"])

    def test_a_genuinely_new_untracked_file_is_still_a_creation(self):
        cell = self.kernel.run("await bash('echo fresh > fresh.txt')")
        record = cell.by_rel()["fresh.txt"]
        self.assertEqual(record["kind"], "created", record)
        self.assertEqual((record["added"], record["removed"]), (1, 0))

    def test_a_large_tracked_file_still_gets_a_real_diff(self):
        # Bigger than the old 1MiB baseline cap: sources this repo edits itself reach that
        # size (packages/coding-agent/src/core/agent-session.ts is ~1MiB), and they deserve
        # a real diff, not "no_baseline".
        body = "".join(f"row {i:05d} {'x' * 44}\n" for i in range(30000))
        self.assertGreater(len(body), 1 << 20)
        self.commit("big.txt", body)
        cell = self.kernel.run("await bash('echo extra >> big.txt')")
        record = cell.by_rel()["big.txt"]
        self.assertEqual(record["kind"], "modified", record)
        self.assertEqual((record["added"], record["removed"]), (1, 0))
        self.assertIn("+extra\n", record["diff"])


@unittest.skipIf(os.name != "posix" or os.geteuid() == 0, "needs an unreadable directory")
class LossyScanNeverCreatedTests(TrackerCase):
    """Outside a git work tree the before-state is an mtime scan; a directory it could not
    read is a gap in it, not proof the files inside are new."""

    use_git = False

    def test_a_file_the_before_scan_could_not_see_is_not_a_creation(self):
        self.write("locked/inner.txt", "old\n")
        os.chmod(self.path("locked"), 0o000)
        cell = self.kernel.run("await bash('chmod 755 locked && echo more >> locked/inner.txt')")
        record = cell.by_rel()["locked/inner.txt"]
        self.assertEqual(record["kind"], "modified", record)
        self.assertEqual((record["added"], record["removed"]), (0, 0))
        self.assertEqual(record.get("diffOmitted"), "no_baseline", record)

    def test_a_genuinely_new_file_outside_the_unread_gap_is_still_a_creation(self):
        # The degrade is scoped to what the scan could not see: a new file elsewhere in the
        # same cell still reads as a creation.
        self.write("locked/inner.txt", "old\n")
        os.chmod(self.path("locked"), 0o000)
        cell = self.kernel.run("await bash('chmod 755 locked && echo fresh > fresh.txt')")
        files = cell.by_rel()
        record = files["fresh.txt"]
        self.assertEqual(record["kind"], "created", record)
        self.assertEqual((record["added"], record["removed"]), (1, 0))
        # Unseen and untouched: the scan cannot tell whether the cell changed it, so it says
        # so (0/0, no_baseline) instead of claiming a creation.
        record = files["locked/inner.txt"]
        self.assertEqual(record["kind"], "modified", record)
        self.assertEqual((record["added"], record["removed"]), (0, 0))
        self.assertEqual(record.get("diffOmitted"), "no_baseline", record)


@unittest.skipUnless(HAS_GIT, "git is needed for the work-tree comparison")
class CompareRepoBaselineTests(unittest.TestCase):
    """The hard rule at the site that mints baselines: a path the before-state listed whose
    before-content the snapshot failed to capture degrades to unknown, never to absent -
    whatever its porcelain status, unless git said it was deleted.

    A listed-but-unstattable entry is a race (an atomic save landing mid-snapshot) or a
    non-regular placeholder that git still lists, so no end-to-end run produces every shape
    of it on command; this drives _compare_repo with the before-state the race leaves behind.
    """

    def setUp(self) -> None:
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="rlm-effects-baseline-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = os.path.join(self.tmp, "project")
        os.makedirs(self.root)
        _git(self.root, "init", "-q", "-b", "main")
        self.victim = os.path.join(self.root, "victim.txt")
        with open(self.victim, "w") as handle:
            handle.write("one\ntwo\nthree\n")
        _git(self.root, "add", ".")
        _git(self.root, "commit", "-qm", "init")
        self.oid = _git(self.root, "rev-parse", "HEAD").strip()
        patcher = mock.patch.dict(
            os.environ,
            {
                "PRIME_AGENT_CODING_AGENT_DIR": os.path.join(self.tmp, "agent"),
                "RLM_HARNESS_STATE_DIR": os.path.join(self.tmp, "harness-local"),
                "RLM_GLOBAL_HARNESS_STATE_DIR": os.path.join(self.tmp, "harness-global"),
            },
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        self.tracker = effects._Tracker(lambda cell_id, data: None, self.root, 5.0)

    def baseline_for(self, xy: str, sig: tuple[int, int] | None) -> effects._Content:
        before = effects._RepoState(self.root, self.oid, {self.victim: xy}, {self.victim: sig})
        cell = effects._Cell("cell", 5.0)
        changes: list[tuple[str, effects._Content, tuple[int, int] | None]] = []
        self.tracker._compare_repo(cell, before, time.perf_counter() + 5.0, changes)
        self.assertEqual([path for path, _baseline, _after_sig in changes], [self.victim])
        return changes[0][1]

    def test_a_listed_entry_without_a_stat_signature_degrades_to_unknown(self):
        for xy in (".M", "M.", "??", "A."):
            with self.subTest(xy=xy):
                self.assertEqual(self.baseline_for(xy, None).state, "unknown")

    def test_a_deleted_entry_without_a_stat_signature_keeps_the_absent_baseline(self):
        for xy in (".D", "D.", "DD"):
            with self.subTest(xy=xy):
                self.assertEqual(self.baseline_for(xy, None).state, "absent")
