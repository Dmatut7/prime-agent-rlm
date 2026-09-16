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


class K3GTest(unittest.TestCase):
    """Round-37 K3G remediation tests: memory streams, nested foreign code."""

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

    # ---------------------------------------------------------------- K3G-2
    def test_k3g2_memory_streams_snapshot_and_restore_with_position(self) -> None:
        target = os.path.join(self.tmp.name, "data.txt")
        writer = self._writer()
        writer.execute(
            "c1",
            "import io, tempfile\n"
            "buf = io.BytesIO(b'payload-bytes')\n"
            "buf.seek(7)\n"
            "text = io.StringIO('memo-head')\n"
            "text.seek(6)\n"
            "spool = tempfile.SpooledTemporaryFile(max_size=1_000_000)\n"
            "spool.write(b'spooled-memo')\n"
            "spool.seek(3)\n"
            f"fh = open({target!r}, 'w')\n"
            "fh.write('0123456789')\n"
            "fh.flush()\n"
            "plain = 41\n",
        )
        writer.send(
            {
                "type": "snapshot",
                "id": "s1",
                "path": self.path,
                "manifest_path": self.manifest_path,
            }
        )
        done = one(writer.until_done("s1"), "done")
        self.assertEqual(done["status"], "ok")
        # In-memory streams serialize by value with content and cursor: they must
        # be saved, not skipped as "open file handles" (the K3G-2 punch: before the
        # fix buf/text/spool all landed in skipped and were lost across restart).
        for name in ("buf", "text", "spool", "plain"):
            self.assertIn(name, done["saved"])
            self.assertNotIn(name, [entry["name"] for entry in done["skipped"]])
        # Positive control: a real open file handle is still evicted.
        skipped_names = [entry["name"] for entry in done["skipped"]]
        self.assertIn("fh", skipped_names)
        self.assertIn("open file", done["skipped"][skipped_names.index("fh")]["reason"])

        reader = self._writer()
        reader.send({"type": "restore", "id": "r1", "path": self.path})
        done = one(reader.until_done("r1"), "done")
        self.assertEqual(done["status"], "ok")
        for name in ("buf", "text", "spool", "plain"):
            self.assertIn(name, done["restored"])
        # seek(6) on 'memo-head' resumes at 'e': both cursors prove the memory
        # streams revived with their position, not just their content.
        events = reader.execute("c2", "buf.read().decode() + '|' + text.read() + '|' + str(plain + 1)")
        self.assertEqual(
            reader.result_text(events),
            "'-bytes|ead|42'",
        )
        events = reader.execute("c3", "spool.read().decode()")
        self.assertEqual(reader.result_text(events), "'oled-memo'")
        # The real file stays gone from the namespace and untouched on disk.
        self.assertNotIn("fh", done["restored"])
        with open(target) as fh:
            self.assertEqual(fh.read(), "0123456789")

    def test_k3g2_rolled_spooled_file_is_still_evicted(self) -> None:
        target = os.path.join(self.tmp.name, "rolled.txt")
        writer = self._writer()
        writer.execute(
            "c1",
            "import tempfile\n"
            "spool = tempfile.SpooledTemporaryFile(max_size=10)\n"
            "spool.write(b'x' * 100)\n"
            "spool.rollover()\n"
            f"fh = open({target!r}, 'w')\n"
            "fh.write('0123456789')\n"
            "fh.flush()\n",
        )
        writer.send(
            {"type": "snapshot", "id": "s1", "path": self.path, "manifest_path": self.manifest_path}
        )
        done = one(writer.until_done("s1"), "done")
        self.assertEqual(done["status"], "ok")
        # A rolled-over spooled file is backed by a real descriptor: it must stay
        # in the evicted class, only the in-memory state is safe to snapshot.
        skipped_names = [entry["name"] for entry in done["skipped"]]
        self.assertIn("spool", skipped_names)
        self.assertIn("open file", done["skipped"][skipped_names.index("spool")]["reason"])
        self.assertIn("fh", skipped_names)
        with open(target) as fh:
            self.assertEqual(fh.read(), "0123456789")

    # ---------------------------------------------------------------- K3G-3
    def _version_mismatch_string(self) -> str:
        major, minor = sys.version_info[:2]
        return f"{major}.{(minor + 3) % 10}.0"

    def test_k3g3_version_mismatch_quarantines_nested_foreign_code(self) -> None:
        import dill

        def nested(n: int) -> int:
            return n + 1

        class Carrier:
            def m(self) -> int:
                return 42

        carrier = Carrier()
        payload = {
            "handlers": dill.dumps({"f": nested}),
            "wrapped": dill.dumps({"obj": carrier, "g": nested}),
            "obj": dill.dumps(carrier),
            "fn_list": dill.dumps([nested]),
            "plain": dill.dumps([1, 2, 3]),
        }
        with open(self.path, "wb") as fh:
            dill.dump(payload, fh)

        reader = self._writer()
        reader.send(
            {
                "type": "restore",
                "id": "r1",
                "path": self.path,
                "python_version": self._version_mismatch_string(),
            }
        )
        done = one(reader.until_done("r1"), "done")
        self.assertEqual(done["status"], "ok")
        # Plain data revives; every name that carries foreign bytecode one level
        # deep (dict values, list items, instances of a foreign class) is
        # quarantined with the same reason as a bare function.
        self.assertIn("plain", done["restored"])
        failed_names = [entry["name"] for entry in done["failed"]]
        for name in ("handlers", "wrapped", "obj", "fn_list"):
            self.assertIn(name, failed_names)
            self.assertNotIn(name, done["restored"])
            self.assertIn(
                "python version mismatch",
                done["failed"][failed_names.index(name)]["reason"],
            )
        for name in ("handlers", "wrapped", "obj", "fn_list"):
            events = reader.execute(f"c_{name}", f"{name}['f'](41)" if name == "handlers" else name)
            self.assertIn("NameError", one(events, "error")["ename"])

    def test_k3g3_matching_version_restores_nested_functions(self) -> None:
        import dill

        def nested(n: int) -> int:
            return n + 1

        class Carrier:
            def m(self) -> int:
                return 42

        payload = {
            "handlers": dill.dumps({"f": nested}),
            "obj": dill.dumps(Carrier()),
            "plain": dill.dumps([1, 2, 3]),
        }
        with open(self.path, "wb") as fh:
            dill.dump(payload, fh)

        reader = self._writer()
        version = f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}"
        reader.send({"type": "restore", "id": "r1", "path": self.path, "python_version": version})
        done = one(reader.until_done("r1"), "done")
        self.assertEqual(done["status"], "ok")
        self.assertEqual(sorted(done["restored"]), ["handlers", "obj", "plain"])
        self.assertEqual(done["failed"], [])
        events = reader.execute("c1", "handlers['f'](41)")
        self.assertEqual(reader.result_text(events), "42")
        events = reader.execute("c2", "obj.m()")
        self.assertEqual(reader.result_text(events), "42")


if __name__ == "__main__":
    unittest.main()
