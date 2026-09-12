"""FIX-4: snapshot dirty-tracking and stream-frame coalescing.

The host snapshots after every cell (debounced) and again on dispose, and kills a
snapshot at 5s; re-serializing every value after every turn thrashes data-heavy
sessions. These tests pin the two shortcuts and their invalidation:

- blob reuse: a name still bound to the identical deeply-immutable object reuses its
  serialized blob, and the payload stays byte-identical to a full re-serialization;
- replay: a snapshot request with no cell executed, no restore applied, every eligible
  binding identical, and the committed pair intact on disk replays the previous result
  without touching the files;
- coalescing: tagged stream writes batch into one frame per short window while frame
  ordering, attribution, and the before-done drain guarantee stay exactly as they were.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

import dill

from test_repl import ReplProcess, one, stream_text

SRC = os.path.join(os.path.dirname(__file__), "..", "src")


def run_src_python(code: str) -> str:
    """Run a snippet against the src tree in a fresh interpreter; return its stdout."""
    env = {**os.environ, "PYTHONPATH": SRC + os.pathsep + os.environ.get("PYTHONPATH", "")}
    result = subprocess.run(
        [sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=120
    )
    if result.returncode != 0:
        raise AssertionError(f"driver failed ({result.returncode}):\n{result.stderr}")
    return result.stdout.strip()


class DeeplyImmutableTest(unittest.TestCase):
    def test_exact_builtin_types_only(self) -> None:
        out = run_src_python(
            "import json\n"
            "from rlm.repl import _deeply_immutable as di\n"
            "class S(str): pass\n"
            "print(json.dumps({\n"
            "  'str': di('x'), 'bytes': di(b'x'), 'int': di(3), 'float': di(1.5),\n"
            "  'complex': di(1j), 'bool': di(True), 'none': di(None), 'range': di(range(3)),\n"
            "  'tuple_imm': di((1, 'a', (2.0,))), 'frozenset_imm': di(frozenset({1, 'b'})),\n"
            "  'list': di([1]), 'dict': di({1: 2}), 'set': di({1}),\n"
            "  'bytearray': di(bytearray()), 'tuple_with_list': di((1, [2])),\n"
            "  'str_subclass': di(S('x')),\n"
            "}))\n"
        )
        verdicts = json.loads(out)
        self.assertEqual(len(verdicts), 16)
        immutable = {
            "str", "bytes", "int", "float", "complex", "bool", "none", "range",
            "tuple_imm", "frozenset_imm",
        }
        for name, verdict in verdicts.items():
            self.assertEqual(verdict, name in immutable, name)


class BlobReuseTest(unittest.TestCase):
    """Direct `_snapshot_state` calls in a fresh process: reuse, parity, and pruning."""

    def test_immutable_blobs_are_reused_and_the_payload_stays_byte_identical(self) -> None:
        out = run_src_python(
            "import dill, json, os, tempfile\n"
            "import rlm.repl as repl\n"
            "tmp = tempfile.mkdtemp()\n"
            "fresh = os.path.join(tmp, 'fresh.dill'); fresh_m = os.path.join(tmp, 'fresh.json')\n"
            "cached = os.path.join(tmp, 'cached.dill'); cached_m = os.path.join(tmp, 'cached.json')\n"
            "big = 'x' * 200_000\n"
            "ns = {'big': big, 'n': 7, 'lst': [1, 2, 3]}\n"
            "r_fresh = repl._snapshot_state(ns, fresh, fresh_m, 1 << 40, 1 << 40, False)\n"
            "assert 'error' not in r_fresh, r_fresh\n"
            "cache = {}\n"
            "r1 = repl._snapshot_state(ns, cached, cached_m, 1 << 40, 1 << 40, False, blob_cache=cache)\n"
            "assert 'error' not in r1, r1\n"
            "calls = []\n"
            "real_dump = dill.dump\n"
            "def counting(obj, fh, *a, **k):\n"
            "    calls.append(obj)\n"
            "    return real_dump(obj, fh, *a, **k)\n"
            "dill.dump = counting\n"
            "try:\n"
            "    r2 = repl._snapshot_state(ns, cached, cached_m, 1 << 40, 1 << 40, False, blob_cache=cache)\n"
            "finally:\n"
            "    dill.dump = real_dump\n"
            "assert 'error' not in r2, r2\n"
            "with open(fresh, 'rb') as fh: fresh_bytes = fh.read()\n"
            "with open(cached, 'rb') as fh: cached_bytes = fh.read()\n"
            "print(json.dumps({\n"
            "    'saved_equal': r_fresh['saved'] == r1['saved'] == r2['saved'],\n"
            "    'bytes_equal': fresh_bytes == cached_bytes,\n"
            "    'big_redumped': any(c is big for c in calls),\n"
            "    'n_redumped': any(c is ns['n'] for c in calls),\n"
            "    'lst_redumped': sum(1 for c in calls if c is ns['lst']),\n"
            "    'total_dumps': len(calls),\n"
            "    'cache_names': sorted(cache),\n"
            "}))\n"
        )
        facts = json.loads(out)
        self.assertTrue(facts["saved_equal"])
        self.assertTrue(facts["bytes_equal"], "reuse must keep the payload byte-identical")
        self.assertFalse(facts["big_redumped"], "the identical immutable string must not be re-dumped")
        self.assertFalse(facts["n_redumped"])
        self.assertEqual(facts["lst_redumped"], 1, "a mutable value is always re-dumped")
        # The only other dump is the outer payload dict itself.
        self.assertEqual(facts["total_dumps"], 2)
        self.assertEqual(facts["cache_names"], ["big", "n"], "only immutable values are cached")

    def test_rebinds_subclasses_and_removed_names_never_reuse(self) -> None:
        out = run_src_python(
            "import dill, json, os, tempfile\n"
            "import rlm.repl as repl\n"
            "tmp = tempfile.mkdtemp()\n"
            "p = os.path.join(tmp, 's.dill'); m = os.path.join(tmp, 's.json')\n"
            "class S(str): pass\n"
            "s = S('sub')\n"
            "calls = []\n"
            "real_dump = dill.dump\n"
            "def counting(obj, fh, *a, **k):\n"
            "    calls.append(obj)\n"
            "    return real_dump(obj, fh, *a, **k)\n"
            "dill.dump = counting\n"
            "cache = {}\n"
            "try:\n"
            "    ns = {'s': s}\n"
            "    r1 = repl._snapshot_state(ns, p, m, 1 << 40, 1 << 40, False, blob_cache=cache)\n"
            "    subclass_dumped = sum(1 for c in calls if c is s)\n"
            "    r2 = repl._snapshot_state(ns, p, m, 1 << 40, 1 << 40, False, blob_cache=cache)\n"
            "    subclass_dumped_again = sum(1 for c in calls if c is s)\n"
            "    calls.clear()\n"
            "    ns2 = {'v': 'a' * 10}\n"
            "    repl._snapshot_state(ns2, p, m, 1 << 40, 1 << 40, False, blob_cache=cache)\n"
            "    first_v_dumps = sum(1 for c in calls if c == ns2['v'])\n"
            "    ns2['v'] = 'b' * 10\n"
            "    calls.clear()\n"
            "    repl._snapshot_state(ns2, p, m, 1 << 40, 1 << 40, False, blob_cache=cache)\n"
            "    rebound_v_dumps = sum(1 for c in calls if c == ns2['v'])\n"
            "    del ns2['v']\n"
            "    ns2['other'] = 1\n"
            "    repl._snapshot_state(ns2, p, m, 1 << 40, 1 << 40, False, blob_cache=cache)\n"
            "    cache_after_removal = sorted(cache)\n"
            "finally:\n"
            "    dill.dump = real_dump\n"
            "print(json.dumps({\n"
            "    'subclass_dumped': subclass_dumped, 'subclass_dumped_again': subclass_dumped_again,\n"
            "    'first_v_dumps': first_v_dumps, 'rebound_v_dumps': rebound_v_dumps,\n"
            "    'cache_after_removal': cache_after_removal,\n"
            "}))\n"
        )
        facts = json.loads(out)
        # A str subclass can carry a mutable __dict__ that dill serializes: never cached.
        self.assertEqual(facts["subclass_dumped"], 1)
        self.assertEqual(facts["subclass_dumped_again"], 2)
        self.assertEqual(facts["first_v_dumps"], 1)
        self.assertEqual(facts["rebound_v_dumps"], 1, "a rebind is a new object and must be dumped")
        # The removed name's entry is dropped so the cache cannot pin dead values.
        self.assertEqual(facts["cache_after_removal"], ["other"])

    def test_reused_blob_over_a_smaller_cap_gets_the_fresh_dump_verdict(self) -> None:
        out = run_src_python(
            "import json, os, tempfile\n"
            "import rlm.repl as repl\n"
            "tmp = tempfile.mkdtemp()\n"
            "big = 'x' * 100_000\n"
            "ns = {'big': big, 'small': 1}\n"
            "cache = {}\n"
            "warm = repl._snapshot_state(ns, os.path.join(tmp, 'w.dill'), os.path.join(tmp, 'w.json'),\n"
            "                            1 << 40, 1 << 40, False, blob_cache=cache)\n"
            "assert 'error' not in warm, warm\n"
            "capped = repl._snapshot_state(ns, os.path.join(tmp, 'c.dill'), os.path.join(tmp, 'c.json'),\n"
            "                              1 << 40, 1024, False, blob_cache=cache)\n"
            "plain = repl._snapshot_state(ns, os.path.join(tmp, 'p.dill'), os.path.join(tmp, 'p.json'),\n"
            "                             1 << 40, 1024, False)\n"
            "print(json.dumps({'saved': capped['saved'], 'skipped_parity': capped['skipped'] == plain['skipped'],\n"
            "                'saved_parity': capped['saved'] == plain['saved'],\n"
            "                'prunable': [e['name'] for e in capped['skipped']\n"
            "                             if e['reason'] == 'exceeds per-variable snapshot size cap']}))\n"
        )
        facts = json.loads(out)
        self.assertEqual(facts["saved"], ["small"])
        self.assertTrue(facts["skipped_parity"])
        self.assertTrue(facts["saved_parity"])
        self.assertEqual(facts["prunable"], ["big"])


class SnapshotReplayProtocolTest(unittest.TestCase):
    """End-to-end over the protocol: when the whole write is skipped, and when it is not."""

    def setUp(self) -> None:
        self.repl = ReplProcess()
        self.addCleanup(self.repl.close)
        self.repl.ready()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = os.path.join(self._tmp.name, "kernel-state.dill")
        self.manifest = os.path.join(self._tmp.name, "kernel-state.json")

    def snapshot(self, rid: str, **extra: object) -> dict:
        self.repl.send(
            {"type": "snapshot", "id": rid, "path": self.path, "manifest_path": self.manifest, **extra}
        )
        return one(self.repl.until_done(rid), "done")

    def pair_facts(self) -> tuple:
        def facts(p: str) -> tuple:
            st = os.lstat(p)
            return (st.st_ino, st.st_mtime_ns, st.st_size)

        return facts(self.path), facts(self.manifest)

    def test_identical_request_without_a_cell_replays_without_rewriting(self) -> None:
        self.assertEqual(one(self.repl.execute("c1", "x = 41\ndata = 'doc' * 5000"), "done")["status"], "ok")
        d1 = self.snapshot("s1")
        self.assertEqual(d1["status"], "ok")
        self.assertEqual(sorted(d1["saved"]), ["data", "x"])
        before = self.pair_facts()
        d2 = self.snapshot("s2")
        self.assertEqual(d2["status"], "ok")
        self.assertEqual(before, self.pair_facts(), "neither file may be touched by a replay")
        for field in ("saved", "skipped", "pruned", "bytes"):
            self.assertEqual(d1[field], d2[field], field)

    def test_an_executed_cell_invalidates_the_replay(self) -> None:
        self.assertEqual(one(self.repl.execute("c1", "x = 41"), "done")["status"], "ok")
        self.assertEqual(self.snapshot("s1")["status"], "ok")
        before = self.pair_facts()
        self.assertEqual(one(self.repl.execute("c2", "y = 'new'"), "done")["status"], "ok")
        d2 = self.snapshot("s2")
        self.assertEqual(d2["status"], "ok")
        self.assertNotEqual(before, self.pair_facts())
        self.assertEqual(sorted(d2["saved"]), ["x", "y"])

    def test_a_removed_payload_invalidates_the_replay(self) -> None:
        self.assertEqual(one(self.repl.execute("c1", "x = 41"), "done")["status"], "ok")
        self.assertEqual(self.snapshot("s1")["status"], "ok")
        os.remove(self.path)
        d2 = self.snapshot("s2")
        self.assertEqual(d2["status"], "ok")
        self.assertTrue(os.path.exists(self.path), "the missing payload must be rewritten")
        self.assertEqual(sorted(d2["saved"]), ["x"])

    def test_changed_parameters_never_replay(self) -> None:
        self.assertEqual(one(self.repl.execute("c1", "x = 41"), "done")["status"], "ok")
        self.assertEqual(self.snapshot("s1")["status"], "ok")
        before = self.pair_facts()
        d2 = self.snapshot("s2", max_variable_bytes=8 << 20)
        self.assertEqual(d2["status"], "ok")
        self.assertNotEqual(before[0][0], self.pair_facts()[0][0], "a new key means a physical write")

    def test_a_restore_invalidates_the_replay(self) -> None:
        self.assertEqual(one(self.repl.execute("c1", "x = 41"), "done")["status"], "ok")
        self.assertEqual(self.snapshot("s1")["status"], "ok")
        before = self.pair_facts()
        self.repl.send({"type": "restore", "id": "r1", "path": self.path})
        self.assertEqual(one(self.repl.until_done("r1"), "done")["status"], "ok")
        d2 = self.snapshot("s2")
        self.assertEqual(d2["status"], "ok")
        self.assertNotEqual(before, self.pair_facts())

    def test_a_swapped_payload_is_refused_not_replayed(self) -> None:
        # Corrupt-snapshot isolation must survive the shortcut: a payload replaced by a
        # symlink may never be answered from the cache; the full snapshot refuses it.
        self.assertEqual(one(self.repl.execute("c1", "x = 41"), "done")["status"], "ok")
        self.assertEqual(self.snapshot("s1")["status"], "ok")
        outside = os.path.join(self._tmp.name, "outside.bin")
        with open(outside, "wb") as fh:
            fh.write(b"sentinel")
        os.remove(self.path)
        os.symlink(outside, self.path)
        d2 = self.snapshot("s2")
        self.assertEqual(d2["status"], "error")
        self.assertIn("unsafe", d2["reason"])
        with open(outside, "rb") as fh:
            self.assertEqual(fh.read(), b"sentinel")


    def test_a_final_request_writes_through_the_replay_shortcut(self) -> None:
        """`final` is the host's dispose flush: it must never be answered from the record.

        A background thread mutating a value IN PLACE between two snapshots is invisible to
        every fingerprint the shortcut checks (no cell ran, no binding was replaced, the
        committed pair is intact), so a plain request legitimately replays a stale payload.
        The terminal request is the last word on this namespace, so it writes through.
        """
        code = (
            "import threading, time\n"
            "box = ['initial']\n"
            "def mutate_later():\n"
            "    time.sleep(1.5)\n"
            "    box.append('late')\n"
            "threading.Thread(target=mutate_later, daemon=True).start()\n"
        )
        self.assertEqual(one(self.repl.execute("c1", code), "done")["status"], "ok")
        self.assertEqual(self.snapshot("s1")["status"], "ok")

        def box_on_disk() -> object:
            with open(self.path, "rb") as fh:
                return dill.loads(dill.load(fh)["box"])

        self.assertEqual(box_on_disk(), ["initial"])
        before = self.pair_facts()
        # The background mutation lands here; no cell runs, so no fingerprint invalidates.
        time.sleep(2.0)
        replayed = self.snapshot("s2")
        self.assertEqual(replayed["status"], "ok")
        self.assertEqual(before, self.pair_facts(), "a replayed snapshot must not touch the pair")
        self.assertEqual(box_on_disk(), ["initial"], "documented approximation: the replay is stale")

        final = self.snapshot("s3", final=True)
        self.assertEqual(final["status"], "ok")
        self.assertNotEqual(before, self.pair_facts(), "a final snapshot must physically write")
        self.assertEqual(box_on_disk(), ["initial", "late"])
        self.assertIn("box", final["saved"])

    def test_a_malformed_final_flag_is_refused(self) -> None:
        self.assertEqual(one(self.repl.execute("c1", "x = 1"), "done")["status"], "ok")
        refused = self.snapshot("s1", final="yes")
        self.assertEqual(refused["status"], "error")
        self.assertIn("final must be a boolean", refused["reason"])
        self.assertFalse(os.path.exists(self.path), "a refused request must not write")


class StreamCoalescingProtocolTest(unittest.TestCase):
    """End-to-end over the protocol: fewer frames, same text, same guarantees."""

    def setUp(self) -> None:
        self.repl = ReplProcess()
        self.addCleanup(self.repl.close)
        self.repl.ready()

    def test_rapid_prints_coalesce_into_few_frames(self) -> None:
        events = self.repl.execute("coal1", "for i in range(300):\n    print('line', i)")
        self.assertEqual(one(events, "done")["status"], "ok")
        frames = [e for e in events if e.get("event") == "stdout"]
        self.assertGreater(len(frames), 0)
        # Uncoalesced, print() alone would emit 600 frames (text + newline per call).
        self.assertLessEqual(len(frames), 100)
        self.assertEqual(stream_text(events, "stdout"), "".join(f"line {i}\n" for i in range(300)))
        self.assertTrue(all(e.get("id") == "coal1" for e in frames))
        done_index = next(i for i, e in enumerate(events) if e.get("event") == "done")
        self.assertTrue(all(i < done_index for i, e in enumerate(events) if e.get("event") == "stdout"))

    def test_streams_stay_separate_and_attributed_under_coalescing(self) -> None:
        code = "import sys\nfor i in range(50):\n    print('out', i)\n    print('err', i, file=sys.stderr)"
        events = self.repl.execute("sep1", code)
        self.assertEqual(one(events, "done")["status"], "ok")
        self.assertEqual(stream_text(events, "stdout"), "".join(f"out {i}\n" for i in range(50)))
        self.assertEqual(stream_text(events, "stderr"), "".join(f"err {i}\n" for i in range(50)))
        streams = [e for e in events if e.get("event") in ("stdout", "stderr")]
        self.assertGreater(len(streams), 0)
        self.assertTrue(all(e.get("id") == "sep1" for e in streams))

    def test_partial_line_arrives_while_a_sync_cell_blocks_the_loop(self) -> None:
        # The window flush runs on its own thread: a partial line must reach the host
        # long before the synchronous cell (which freezes the loop) finishes.
        code = "import sys, time\nsys.stdout.write('prompt: ')\ntime.sleep(1.0)\nprint('done')"
        self.repl.send({"type": "execute", "id": "part1", "code": code})
        events: list[dict] = []
        prompt_at: float | None = None
        done_at: float | None = None
        deadline = time.monotonic() + 15
        while done_at is None and time.monotonic() < deadline:
            event = self.repl.read_event(timeout=10)
            now = time.monotonic()
            events.append(event)
            if prompt_at is None and event.get("event") == "stdout" and "prompt:" in event.get("text", ""):
                self.assertEqual(event.get("id"), "part1")
                prompt_at = now
            if event.get("event") == "done" and event.get("id") == "part1":
                done_at = now
        self.assertIsNotNone(prompt_at, "the partial line never arrived")
        self.assertIsNotNone(done_at, "the cell never finished")
        self.assertGreater(done_at - prompt_at, 0.3, "the partial line waited for the cell end")
        self.assertEqual(stream_text(events, "stdout"), "prompt: done\n")

    def test_emit_flushes_buffered_text_first(self) -> None:
        code = (
            "import sys\n"
            "from rlm.repl import emit\n"
            "sys.stdout.write('before')\n"
            "emit({'probe': 'display'})\n"
        )
        events = self.repl.execute("ord1", code)
        self.assertEqual(one(events, "done")["status"], "ok")
        stdout_i = next(
            i for i, e in enumerate(events) if e.get("event") == "stdout" and "before" in e.get("text", "")
        )
        display_i = next(i for i, e in enumerate(events) if e.get("event") == "display")
        self.assertLess(stdout_i, display_i, "buffered text must precede the display frame")
        self.assertEqual(events[stdout_i]["id"], "ord1")


if __name__ == "__main__":
    unittest.main()
