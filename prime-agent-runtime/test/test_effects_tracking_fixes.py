"""Change tracking fixes from the lu/final-fixes review, group b.

Like test_effects, these cases drive a real `python -m rlm.repl` process in a throwaway
directory, so the wrappers, the mtime scan and the protocol framing are the shipped ones.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_effects import SRC, STATUS, TrackerCase  # noqa: E402


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


# Drives rlm.effects through its public entry points in a fresh interpreter, with a sender that can park
# a record on its way out. What the sender logs, in order, is what would reach the wire.
_HAND_OFF_SCRIPT = """
import json
import sys
import threading

from rlm import effects

mode, cwd = sys.argv[1], sys.argv[2]
log = []
entered = threading.Event()
release = threading.Event()


def hold_when(record):
    return False


def sender(cell_id, data):
    record = data.get(effects.ACTIVITY_MIME)
    if record is None:
        return
    if hold_when(record):
        entered.set()
        release.wait(20)
    log.append({"cell": cell_id, "id": record["id"], "status": record["status"]})


def end(cell_id):
    effects.end_cell(cell_id)
    log.append({"cell": cell_id, "done": True})


assert effects.install(sender, cwd)
effects.begin_cell("c1")
old = effects.command_started("old job")
old_id = log[-1]["id"]
end("c1")
effects.begin_cell("c2")
if mode == "ends-while-its-record-is-in-flight":
    hold_when = lambda record: record["id"] == old_id and record["status"] == "ok"
    ender = threading.Thread(target=old.finish, args=(0, "finished\\n"))
    ender.start()
    assert entered.wait(20)
    threading.Timer(0.4, release.set).start()
    end("c2")
    ender.join()
else:
    new = effects.command_started("new job")
    new_id = log[-1]["id"]
    hold_when = lambda record: record["id"] == new_id and record.get("background") is True
    ender = threading.Thread(target=end, args=("c2",))
    ender.start()
    assert entered.wait(20)
    old.finish(0, "finished\\n")
    release.set()
    ender.join()
effects.begin_cell("c3")
end("c3")
print(json.dumps({"log": log, "old_id": old_id}))
"""


class BackgroundOutcomeOrderTests(unittest.TestCase):
    """A background command's outcome never reaches a cell after that cell's `done`."""

    def run_hand_off(self, mode: str) -> tuple[list[dict], str]:
        with tempfile.TemporaryDirectory(prefix="rlm-handoff-") as agent_dir:
            env = {k: v for k, v in os.environ.items() if not k.startswith(("RLM_", "PRIME_AGENT_", "PI_"))}
            env["PYTHONPATH"] = SRC
            env["PRIME_AGENT_CODING_AGENT_DIR"] = agent_dir
            proc = subprocess.run(
                [sys.executable, "-c", _HAND_OFF_SCRIPT, mode, agent_dir],
                env=env,
                capture_output=True,
                text=True,
                timeout=120,
            )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout.strip().splitlines()[-1])
        return result["log"], result["old_id"]

    def assert_outcome_before_its_cells_done(self, log: list[dict], old_id: str) -> dict:
        outcomes = [(i, entry) for i, entry in enumerate(log) if entry.get("id") == old_id and entry.get("status") == "ok"]
        self.assertEqual(len(outcomes), 1, log)
        index, outcome = outcomes[0]
        done = log.index({"cell": outcome["cell"], "done": True})
        self.assertLess(index, done, log)
        return outcome

    def test_an_outcome_already_on_its_way_to_the_running_cell_lands_before_the_cell_ends(self):
        # The command's thread has picked the running cell and is about to write when the cell finishes.
        log, old_id = self.run_hand_off("ends-while-its-record-is-in-flight")
        outcome = self.assert_outcome_before_its_cells_done(log, old_id)
        self.assertEqual(outcome["cell"], "c2")

    def test_an_outcome_that_arrives_while_the_cell_is_closing_waits_for_the_next_cell(self):
        log, old_id = self.run_hand_off("ends-while-the-cell-is-closing")
        outcome = self.assert_outcome_before_its_cells_done(log, old_id)
        self.assertEqual(outcome["cell"], "c3")


if __name__ == "__main__":
    unittest.main()
