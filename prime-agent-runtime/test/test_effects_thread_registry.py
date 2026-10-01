"""The change tracker's own threads belong to the kernel-owned thread registry.

The snapshot replay shortcut (rlm.repl._replayable_snapshot) vetoes the replay while
any live thread sits outside bash's kernel-thread registry. The tracker's threads
(watcher, snapshot/compare workers, gap checker, git-root resolver) only observe
files and never touch the user namespace, so they are registered on spawn. Before
they were, enabling change tracking - the default - left the long-lived watcher
unregistered, and every later snapshot replay was vetoed for the rest of the
process.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from test_repl import ReplProcess, one, stream_text


class TrackerThreadRegistryTest(unittest.TestCase):
    def setUp(self) -> None:
        # Change tracking stays at its default (on): the regression is its own threads.
        self.repl = ReplProcess()
        self.addCleanup(self.repl.close)
        self.repl.ready()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def test_tracker_threads_are_registered_kernel_threads(self) -> None:
        probe = os.path.join(self._tmp.name, "probe.txt")
        code = (
            "import json, sys, threading, time\n"
            # `rlm.bash` the attribute is the user-facing bash() function; the module
            # holding the registry lives in sys.modules.
            "bash_module = sys.modules['rlm.bash']\n"
            f"open({probe!r}, 'w').write('x')\n"  # the write wrapper wakes the watcher thread
            "time.sleep(0.5)\n"
            "live = [t for t in threading.enumerate() if t.name.startswith('rlm-change-')]\n"
            "print(json.dumps({\n"
            "    'names': sorted(t.name for t in live),\n"
            "    'unregistered': sorted(t.name for t in live if t not in bash_module._kernel_threads),\n"
            "}))\n"
        )
        events = self.repl.execute("c1", code)
        self.assertEqual(one(events, "done")["status"], "ok")
        facts = json.loads(stream_text(events, "stdout"))
        self.assertIn("rlm-change-watch", facts["names"], "a write in the cell must have woken the watcher")
        self.assertEqual(facts["unregistered"], [])

    def test_replay_stays_on_with_change_tracking_enabled(self) -> None:
        """End-to-end: a cell that writes a file must not kill the snapshot replay shortcut."""
        path = os.path.join(self._tmp.name, "kernel-state.dill")
        manifest = os.path.join(self._tmp.name, "kernel-state.json")
        work = os.path.join(self._tmp.name, "work.txt")
        done = one(self.repl.execute("c1", f"open({work!r}, 'w').write('x')\nx = 41\n"), "done")
        self.assertEqual(done["status"], "ok")
        self.repl.send({"type": "snapshot", "id": "s1", "path": path, "manifest_path": manifest})
        d1 = one(self.repl.until_done("s1"), "done")
        self.assertEqual(d1["status"], "ok")

        def pair_facts() -> tuple:
            def facts(p: str) -> tuple:
                st = os.lstat(p)
                return (st.st_ino, st.st_mtime_ns, st.st_size)

            return facts(path), facts(manifest)

        before = pair_facts()
        self.repl.send({"type": "snapshot", "id": "s2", "path": path, "manifest_path": manifest})
        d2 = one(self.repl.until_done("s2"), "done")
        self.assertEqual(d2["status"], "ok")
        self.assertEqual(before, pair_facts(), "registered tracker threads must not veto the replay")
        for field in ("saved", "skipped", "pruned", "bytes"):
            self.assertEqual(d1[field], d2[field], field)


if __name__ == "__main__":
    unittest.main()
