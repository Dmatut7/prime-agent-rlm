from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

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


class R35ImplTest(unittest.TestCase):
    """Round-35 remediation tests: open files, non-str keys, version gate, refinement types."""

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

    # ---------------------------------------------------------------- RT-1
    def test_rt1_open_file_not_persisted_and_disk_untouched(self) -> None:
        target = os.path.join(self.tmp.name, "data.txt")
        writer = self._writer()
        writer.execute(
            "c1",
            f"fh = open({target!r}, 'w')\nfh.write('0123456789')\nfh.flush()\nplain = 41\n",
        )
        with open(target) as fh:
            self.assertEqual(fh.read(), "0123456789")
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
        self.assertIn("plain", done["saved"])
        skipped_names = [entry["name"] for entry in done["skipped"]]
        self.assertIn("fh", skipped_names)
        self.assertIn("open file", done["skipped"][skipped_names.index("fh")]["reason"])

        reader = self._writer()
        reader.send({"type": "restore", "id": "r1", "path": self.path})
        done = one(reader.until_done("r1"), "done")
        self.assertEqual(done["status"], "ok")
        self.assertIn("plain", done["restored"])
        self.assertNotIn("fh", done["restored"])
        with open(self.manifest_path) as fh:
            manifest = json.load(fh)
        self.assertIn("fh", [entry["name"] for entry in manifest["skipped"]])
        # The core RT-1 assertion: the restore must not reopen the real file, so the
        # disk content survives byte-for-byte (before the fix it was truncated to "").
        with open(target) as fh:
            self.assertEqual(fh.read(), "0123456789")
        events = reader.execute("c2", "plain + 1")
        self.assertEqual(reader.result_text(events), "42")

    def test_rt1_legacy_payload_with_file_blob_leaves_disk_untouched(self) -> None:
        import dill

        target = os.path.join(self.tmp.name, "legacy.txt")
        with open(target, "w") as fh:
            fh.write("0123456789")
        handle = open(target, "a")
        try:
            payload = {"fh": dill.dumps(handle), "plain": dill.dumps(7)}
            with open(self.path, "wb") as fh:
                dill.dump(payload, fh)
        finally:
            handle.close()

        reader = self._writer()
        reader.send({"type": "restore", "id": "r1", "path": self.path})
        done = one(reader.until_done("r1"), "done")
        self.assertEqual(done["status"], "ok")
        self.assertIn("plain", done["restored"])
        failed_names = [entry["name"] for entry in done["failed"]]
        self.assertIn("fh", failed_names)
        with open(target) as fh:
            self.assertEqual(fh.read(), "0123456789")

    # ---------------------------------------------------------------- RT-2
    def test_rt2_non_string_key_skips_variable_and_snapshot_succeeds(self) -> None:
        writer = self._writer()
        writer.execute("c1", "globals()[1] = 'x'\nnormal = 1\n")
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
        self.assertIn("normal", done["saved"])
        self.assertTrue(any("non-string" in entry["reason"] for entry in done["skipped"]))
        self.assertTrue(os.path.exists(self.path))
        with open(self.manifest_path) as fh:
            manifest = json.load(fh)
        self.assertIn("normal", manifest["savedNames"])

        reader = self._writer()
        reader.send({"type": "restore", "id": "r1", "path": self.path})
        done = one(reader.until_done("r1"), "done")
        self.assertEqual(done["status"], "ok")
        self.assertIn("normal", done["restored"])
        events = reader.execute("c2", "normal + 1")
        self.assertEqual(reader.result_text(events), "2")

    # ---------------------------------------------------------------- RT-3
    def _version_mismatch_string(self) -> str:
        major, minor = sys.version_info[:2]
        return f"{major}.{(minor + 3) % 10}.0"

    def test_rt3_version_mismatch_quarantines_functions_keeps_data(self) -> None:
        import dill

        payload = {
            "helper": dill.dumps(lambda n: n + 1),
            "K": dill.dumps(type("K", (), {})),
            "data": dill.dumps([1, 2, 3]),
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
        self.assertIn("data", done["restored"])
        self.assertNotIn("helper", done["restored"])
        self.assertNotIn("K", done["restored"])
        failed_names = [entry["name"] for entry in done["failed"]]
        self.assertIn("helper", failed_names)
        self.assertIn("K", failed_names)
        self.assertIn("python version mismatch", done["failed"][failed_names.index("helper")]["reason"])
        events = reader.execute("c1", "helper(1)")
        self.assertIn("NameError", one(events, "error")["ename"])
        events = reader.execute("c2", "sum(data)")
        self.assertEqual(reader.result_text(events), "6")

    def test_rt3_matching_version_restores_functions(self) -> None:
        import dill

        payload = {"helper": dill.dumps(lambda n: n + 1), "data": dill.dumps([1])}
        with open(self.path, "wb") as fh:
            dill.dump(payload, fh)

        reader = self._writer()
        version = f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}"
        reader.send({"type": "restore", "id": "r1", "path": self.path, "python_version": version})
        done = one(reader.until_done("r1"), "done")
        self.assertEqual(done["status"], "ok")
        self.assertEqual(sorted(done["restored"]), ["data", "helper"])
        self.assertEqual(done["failed"], [])
        events = reader.execute("c1", "helper(1)")
        self.assertEqual(reader.result_text(events), "2")

    def test_rt3_missing_version_field_keeps_current_behaviour(self) -> None:
        import dill

        payload = {"helper": dill.dumps(lambda n: n + 1)}
        with open(self.path, "wb") as fh:
            dill.dump(payload, fh)

        reader = self._writer()
        reader.send({"type": "restore", "id": "r1", "path": self.path})
        done = one(reader.until_done("r1"), "done")
        self.assertEqual(done["status"], "ok")
        self.assertEqual(done["restored"], ["helper"])

    def test_rt3_non_string_version_rejected(self) -> None:
        reader = self._writer()
        reader.send({"type": "restore", "id": "r1", "path": self.path, "python_version": 3})
        done = one(reader.until_done("r1"), "done")
        self.assertEqual(done["status"], "error")
        self.assertIn("python_version must be a string", done["reason"])


class RecordRefinementValidationTest(unittest.TestCase):
    """RT-4: record_refinement rejects malformed fields before anything hits disk."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.file_path = Path(self.tmp.name) / "harness_state.json"

    def _state(self):
        from rlm.harness import HarnessState

        return HarnessState(self.file_path)

    def test_rt4_none_trigger_rejected_without_disk_write(self) -> None:
        state = self._state()
        with self.assertRaisesRegex(ValueError, "trigger"):
            state.record_refinement(None, ["change"])
        self.assertFalse(self.file_path.exists())

    def test_rt4_bad_changes_rejected(self) -> None:
        state = self._state()
        for changes in (None, 7, {"not": "a list"}, [1, 2]):
            with self.assertRaisesRegex(ValueError, "changes"):
                state.record_refinement("trigger", changes)
        self.assertFalse(self.file_path.exists())

    def test_rt4_bad_evidence_outcome_id_rejected(self) -> None:
        state = self._state()
        with self.assertRaisesRegex(ValueError, "evidence"):
            state.record_refinement("trigger", ["change"], evidence=None)
        with self.assertRaisesRegex(ValueError, "outcome"):
            state.record_refinement("trigger", ["change"], outcome=3)
        with self.assertRaisesRegex(ValueError, "id"):
            state.record_refinement("trigger", ["change"], id=9)
        self.assertFalse(self.file_path.exists())

    def test_rt4_valid_call_still_writes(self) -> None:
        state = self._state()
        event = state.record_refinement(
            "trigger", "single change", evidence="ev", outcome="out", id="custom_id"
        )
        self.assertEqual(event.changes, ["single change"])
        with open(self.file_path) as fh:
            on_disk = json.load(fh)
        self.assertEqual(on_disk["refinements"][0]["id"], "custom_id")
        self.assertEqual(on_disk["refinements"][0]["trigger"], "trigger")


if __name__ == "__main__":
    unittest.main()
