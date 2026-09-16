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
            # The dill payload references this test module for functions defined
            # here; the kernel subprocess needs it importable to restore them.
            "PYTHONPATH": SRC + os.pathsep + os.path.dirname(__file__) + os.pathsep + os.environ.get("PYTHONPATH", ""),
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


class L8DImplTest(unittest.TestCase):
    """L8D-1: the version gate fails closed when the source version is unknown.

    A restore whose request carries no python_version (legacy manifest, missing or
    torn manifest) used to revive by-value functions and classes as if they were
    compatible; cross-interpreter bytecode then executes and kills the kernel with
    SIGSEGV while the host just reported it restored. The gate now quarantines
    code objects whenever the writing interpreter's version is unknown, and plain
    data still revives.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "kernel-state.dill")

    def _writer(self) -> ReplProcess:
        repl = ReplProcess()
        self.addCleanup(repl.close)
        repl.ready()
        return repl

    def _current_version(self) -> str:
        return f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}"

    def test_l8d1_missing_version_quarantines_functions_and_classes(self) -> None:
        import dill

        payload = {
            "helper": dill.dumps(lambda n: n + 1),
            "K": dill.dumps(type("K", (), {})),
            "data": dill.dumps([1, 2, 3]),
        }
        with open(self.path, "wb") as fh:
            dill.dump(payload, fh)

        reader = self._writer()
        # No python_version: the shape a legacy (or missing) manifest produces.
        reader.send({"type": "restore", "id": "r1", "path": self.path})
        done = one(reader.until_done("r1"), "done")
        self.assertEqual(done["status"], "ok")
        self.assertIn("data", done["restored"])
        self.assertNotIn("helper", done["restored"])
        self.assertNotIn("K", done["restored"])
        failed = {entry["name"]: entry["reason"] for entry in done["failed"]}
        self.assertIn("helper", failed)
        self.assertIn("K", failed)
        self.assertIn("python version unknown", failed["helper"])
        # Quarantined means not callable: the name never lands in the namespace.
        events = reader.execute("c1", "helper(1)")
        self.assertIn("NameError", one(events, "error")["ename"])
        events = reader.execute("c2", "sum(data)")
        self.assertEqual(reader.result_text(events), "6")

    def test_l8d1_matching_version_restores_functions(self) -> None:
        import dill

        payload = {"helper": dill.dumps(lambda n: n + 1), "data": dill.dumps([1])}
        with open(self.path, "wb") as fh:
            dill.dump(payload, fh)

        reader = self._writer()
        reader.send({"type": "restore", "id": "r1", "path": self.path, "python_version": self._current_version()})
        done = one(reader.until_done("r1"), "done")
        self.assertEqual(done["status"], "ok")
        self.assertEqual(sorted(done["restored"]), ["data", "helper"])
        self.assertEqual(done["failed"], [])
        events = reader.execute("c1", "helper(1)")
        self.assertEqual(reader.result_text(events), "2")

    def test_l8d1_pid_only_unknown_version_record_is_not_treated_as_known(self) -> None:
        # An empty string is a present-but-empty version field: unparseable, so the
        # source line is still unknown and code objects stay quarantined.
        import dill

        payload = {"helper": dill.dumps(lambda n: n + 1), "data": dill.dumps(7)}
        with open(self.path, "wb") as fh:
            dill.dump(payload, fh)

        reader = self._writer()
        reader.send({"type": "restore", "id": "r1", "path": self.path, "python_version": ""})
        done = one(reader.until_done("r1"), "done")
        self.assertEqual(done["status"], "ok")
        self.assertIn("data", done["restored"])
        self.assertNotIn("helper", done["restored"])
        failed = {entry["name"]: entry["reason"] for entry in done["failed"]}
        self.assertIn("python version unknown", failed.get("helper", ""))



    # ---------------------------------------------------------------- K3L-1
    def test_k3l1_namedtuple_instance_is_quarantined_on_mismatch(self) -> None:
        import dill
        from collections import namedtuple

        class Point(namedtuple("Point", ["x", "y"])):
            def mag(self) -> float:
                return (self.x**2 + self.y**2) ** 0.5

        payload = {
            "pt": dill.dumps(Point(3, 4)),
            "plain": dill.dumps([1, 2]),
        }
        with open(self.path, "wb") as fh:
            dill.dump(payload, fh)

        reader = self._writer()
        reader.send(
            {
                "type": "restore",
                "id": "r1",
                "path": self.path,
                "python_version": self._mismatched_version(),
            }
        )
        done = one(reader.until_done("r1"), "done")
        self.assertEqual(done["status"], "ok")
        self.assertIn("plain", done["restored"])
        # A namedtuple is a tuple subclass, so the container branch used to miss
        # that its type is foreign bytecode: pt.mag() executed for real (K3L-1).
        self.assertNotIn("pt", done["restored"])
        failed = {entry["name"]: entry["reason"] for entry in done["failed"]}
        self.assertIn("pt", failed)
        self.assertIn("python version mismatch", failed["pt"])
        events = reader.execute("c1", "pt.mag()")
        self.assertIn("NameError", one(events, "error")["ename"])

    def test_k3l1_matching_version_restores_namedtuple_instance(self) -> None:
        import dill
        from collections import namedtuple

        class Point(namedtuple("Point", ["x", "y"])):
            def mag(self) -> float:
                return (self.x**2 + self.y**2) ** 0.5

        payload = {"pt": dill.dumps(Point(3, 4))}
        with open(self.path, "wb") as fh:
            dill.dump(payload, fh)

        reader = self._writer()
        reader.send(
            {"type": "restore", "id": "r1", "path": self.path, "python_version": self._current_version()}
        )
        done = one(reader.until_done("r1"), "done")
        self.assertEqual(done["status"], "ok")
        self.assertEqual(done["restored"], ["pt"])
        self.assertEqual(done["failed"], [])
        events = reader.execute("c1", "pt.mag()")
        self.assertEqual(reader.result_text(events), "5.0")

    def _mismatched_version(self) -> str:
        major, minor = sys.version_info[:2]
        return f"{major}.{(minor + 3) % 10}.0"


if __name__ == "__main__":
    unittest.main()
