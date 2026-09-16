from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import unittest

SRC = os.path.join(os.path.dirname(__file__), "..", "src")

_EOF = object()


class ReplProcess:
    """Drives one `python -m rlm.repl` subprocess over the JSON-lines protocol."""

    def __init__(self) -> None:
        env = {
            **os.environ,
            "PYTHONPATH": SRC + os.pathsep + os.environ.get("PYTHONPATH", ""),
        }
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "rlm.repl"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            env=env,
        )
        self._lines: queue.Queue[object] = queue.Queue()
        threading.Thread(target=self._read_lines, daemon=True).start()

    def _read_lines(self) -> None:
        assert self.proc.stdout is not None
        try:
            for line in self.proc.stdout:
                self._lines.put(line)
        except ValueError:
            pass
        self._lines.put(_EOF)

    def read_event(self, timeout: float = 30.0) -> dict:
        line = self._lines.get(timeout=timeout)
        if line is _EOF:
            raise EOFError("runtime closed its protocol stream")
        assert isinstance(line, str)
        return json.loads(line)

    def ready(self) -> dict:
        return self.read_event()

    def send(self, request: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(request) + "\n")
        self.proc.stdin.flush()

    def execute(self, rid: str, code: str) -> list[dict]:
        self.send({"type": "execute", "id": rid, "code": code})
        return self.until_done(rid)

    def until_done(self, rid: str) -> list[dict]:
        events = []
        while True:
            event = self.read_event()
            events.append(event)
            if event.get("event") == "done" and event.get("id") == rid:
                return events

    def result_text(self, events: list[dict]) -> str:
        for event in events:
            if event.get("event") == "result":
                return event["text"]
        return ""

    def close(self) -> None:
        try:
            if self.proc.poll() is None:
                self.proc.kill()
                self.proc.wait(timeout=5)
        except Exception:
            pass


def one(events: list[dict], kind: str) -> dict | None:
    matches = [e for e in events if e.get("event") == kind]
    return matches[0] if matches else None


class Rt5RestoreHonestyTest(unittest.TestCase):
    """RT-5: dill revivals that succeed but with reduced semantics must be reported."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "kernel-state.dill")
        self.manifest_path = os.path.join(self.tmp.name, "kernel-state.json")

    def _writer(self) -> ReplProcess:
        repl = ReplProcess()
        self.addCleanup(repl.close)
        repl.ready()
        return repl

    def _snapshot(self, writer: ReplProcess) -> None:
        writer.send(
            {
                "type": "snapshot",
                "id": "s1",
                "path": self.path,
                "manifest_path": self.manifest_path,
            }
        )
        done = one(writer.until_done("s1"), "done")
        self.assertEqual(done["status"], "ok", msg=json.dumps(done))

    def _restore(self, reader: ReplProcess) -> dict:
        # L8D-1: a version-less restore now quarantines code objects, so these
        # degraded-revival tests state the compatible version a real host would
        # forward from the manifest the writer just wrote.
        version = f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}"
        reader.send({"type": "restore", "id": "r1", "path": self.path, "python_version": version})
        return one(reader.until_done("r1"), "done")

    def test_rt5_frozen_globals_function_is_degraded_not_restored(self) -> None:
        writer = self._writer()
        writer.execute(
            "c1",
            "plain = 1\nlst = [1, 2, 3]\nalias = lst\n"
            "def helper():\n    return len(lst)\n",
        )
        self._snapshot(writer)

        reader = self._writer()
        done = self._restore(reader)
        self.assertEqual(done["status"], "ok")
        degraded = done.get("degraded", [])
        degraded_names = [entry["name"] for entry in degraded]
        # The alias/frozen-copy scenario from the round-35 audit: `helper` revives with
        # a private copy of its defining namespace instead of the live one, so it must
        # not ride in `restored` (which the host renders as "available again").
        self.assertIn("helper", degraded_names)
        self.assertNotIn("helper", done["restored"])
        self.assertIn("plain", done["restored"])
        self.assertIn("lst", done["restored"])
        self.assertTrue(degraded[degraded_names.index("helper")]["reason"])

        # The value is still applied and callable; the report is honest about the caveat,
        # not a refusal. And the divergence the reason describes is real: rebinding the
        # live name does not reach the frozen copy.
        events = reader.execute("c2", "helper()")
        self.assertEqual(reader.result_text(events), "3")
        reader.execute("c3", "lst = [1]")
        events = reader.execute("c4", "helper()")
        self.assertEqual(reader.result_text(events), "3")

    def test_rt5_imported_function_stays_fully_restored(self) -> None:
        # A function from a real module revives by reference with its module's live
        # globals: it must not be reported degraded.
        writer = self._writer()
        writer.execute("c1", "from json import dumps\nplain = 2\n")
        self._snapshot(writer)

        reader = self._writer()
        done = self._restore(reader)
        self.assertEqual(done["status"], "ok")
        self.assertEqual(done.get("degraded", []), [])
        self.assertIn("dumps", done["restored"])
        events = reader.execute("c2", "dumps({'ok': plain})")
        self.assertEqual(reader.result_text(events), repr('{"ok": 2}'))

    def test_rt5_self_contained_function_stays_fully_restored(self) -> None:
        # A function that reads no revived name has nothing to diverge from: reporting
        # it degraded would be crying wolf.
        writer = self._writer()
        writer.execute("c1", "def pure(n):\n    return n + 1\nplain = 5\n")
        self._snapshot(writer)

        reader = self._writer()
        done = self._restore(reader)
        self.assertEqual(done["status"], "ok")
        self.assertEqual(done.get("degraded", []), [])
        self.assertIn("pure", done["restored"])
        events = reader.execute("c2", "pure(plain)")
        self.assertEqual(reader.result_text(events), "6")


if __name__ == "__main__":
    unittest.main()
