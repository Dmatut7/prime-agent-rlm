"""Change tracking fixes from the lu/final-fixes review, group b.

Like test_effects, these cases drive a real `python -m rlm.repl` process in a throwaway
directory, so the wrappers, the mtime scan and the protocol framing are the shipped ones.
"""

from __future__ import annotations

import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_effects import STATUS, TrackerCase  # noqa: E402


@unittest.skipUnless(os.name == "posix", "needs symlinks")
class NoGitSymlinkTests(TrackerCase):
    """Outside a git work tree a command's changes come from an mtime scan; links belong in it."""

    use_git = False

    def assert_link_record(self, record: dict, kind: str) -> None:
        self.assertEqual(record["kind"], kind)
        self.assertEqual(record["source"], "shell")
        self.assertTrue(record.get("symlink"), record)
        self.assertEqual((record["added"], record["removed"]), (0, 0))
        self.assertNotIn("diff", record)
        self.assertNotIn("diffOmitted", record)

    def test_a_new_link_is_listed_as_a_link_without_its_targets_lines(self):
        cell = self.kernel.run("await bash('ln -s a.txt alias')")
        files = cell.by_rel()
        self.assertEqual(sorted(files), ["alias"])
        self.assert_link_record(files["alias"], "created")

    def test_a_dangling_link_is_listed(self):
        cell = self.kernel.run("await bash('ln -s no-such-target dangling')")
        files = cell.by_rel()
        self.assertEqual(sorted(files), ["dangling"])
        self.assert_link_record(files["dangling"], "created")
        self.assertFalse(os.path.exists(self.path("dangling")))

    def test_a_removed_link_is_listed_as_a_deleted_link_and_its_target_is_left_alone(self):
        os.symlink("a.txt", self.path("old-link"))
        cell = self.kernel.run("await bash('rm old-link')")
        files = cell.by_rel()
        self.assertEqual(sorted(files), ["old-link"])
        self.assert_link_record(files["old-link"], "deleted")
        self.assertTrue(os.path.exists(self.path("a.txt")))

    def test_a_removed_dangling_link_is_listed_too(self):
        os.symlink("no-such-target", self.path("stale"))
        cell = self.kernel.run("await bash('rm stale')")
        files = cell.by_rel()
        self.assertEqual(sorted(files), ["stale"])
        self.assert_link_record(files["stale"], "deleted")

    def test_a_re_pointed_link_is_a_modified_link(self):
        os.symlink("a.txt", self.path("hop"))
        cell = self.kernel.run("await bash('ln -sfn b.txt hop')")
        files = cell.by_rel()
        self.assertEqual(sorted(files), ["hop"])
        self.assert_link_record(files["hop"], "modified")
        self.assertEqual(os.readlink(self.path("hop")), "b.txt")

    def test_a_link_to_a_directory_is_the_link_itself_and_is_not_walked(self):
        self.write("sub/inner.txt", "one\n")
        cell = self.kernel.run("await bash('ln -s sub dirlink')")
        files = cell.by_rel()
        self.assertEqual(sorted(files), ["dirlink"])
        self.assert_link_record(files["dirlink"], "created")
        # A write through the link lands in the real file and is filed there, once.
        cell = self.kernel.run("await bash('echo more >> dirlink/inner.txt')")
        files = cell.by_rel()
        self.assertEqual(sorted(files), ["sub/inner.txt"])
        self.assertEqual((files["sub/inner.txt"]["kind"], files["sub/inner.txt"]["added"]), ("modified", 1))

    def test_an_existing_link_does_not_double_a_change_to_its_target(self):
        os.symlink("a.txt", self.path("alias"))
        cell = self.kernel.run("await bash('echo q >> a.txt')")
        files = cell.by_rel()
        self.assertEqual(sorted(files), ["a.txt"])
        self.assertEqual(files["a.txt"]["added"], 1)

    def test_a_link_to_a_pipe_is_never_read_through(self):
        # Reading a link's target for the content cache would block on a pipe nobody writes to.
        os.mkfifo(self.path("pipe"))
        os.symlink("pipe", self.path("pipe-link"))
        cell = self.kernel.run("await bash('echo x > fresh.txt')")
        self.assertEqual(cell.payloads(STATUS), [])
        files = cell.by_rel()
        self.assertEqual(sorted(files), ["fresh.txt"])
        self.assertEqual(files["fresh.txt"]["kind"], "created")

    def test_links_a_background_command_makes_and_removes_between_cells_show_in_the_next_cell(self):
        os.symlink("a.txt", self.path("gone-link"))
        first = self.kernel.run("h = bash('sleep 0.3; rm gone-link; ln -s b.txt late-link')\nh.pid")
        self.assertEqual(first.files(), {})
        time.sleep(1.2)  # the command ends while no cell runs
        second = self.kernel.run("x = 1")
        files = second.by_rel()
        self.assertEqual(sorted(files), ["gone-link", "late-link"])
        self.assert_link_record(files["late-link"], "created")
        self.assert_link_record(files["gone-link"], "deleted")


if __name__ == "__main__":
    unittest.main()
