"""T0-5 / P1-4a: snapshot preserve_names — the merge write that ends the封笔 self-lock.

A restore that failed on some names used to ban every later snapshot write for the rest of
the session, so the payload on disk (still holding the unrestorable blobs) was never improved
and the next restore failed on exactly the same names forever. These tests pin the runtime
half of the fix: the requested names' blobs are copied verbatim from the previous payload,
everything else comes from the live namespace, and an unreadable previous payload costs the
merge step only — never the write.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest

import dill

from rlm import repl
from test_repl import ReplProcess, one

MB = 1 << 20


def write_payload(path: str, mapping: dict[str, bytes]) -> None:
    with open(path, "wb") as fh:
        dill.dump(mapping, fh)


def read_payload(path: str) -> dict:
    with open(path, "rb") as fh:
        return dill.load(fh)


def read_manifest(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def snapshot(
    ns: dict,
    path: str,
    manifest_path: str,
    *,
    max_bytes: int = MB,
    max_variable_bytes: int = MB,
    prune_oversized: bool = False,
    preserve_names: list[str] | None = None,
) -> dict:
    return repl._snapshot_state(
        ns,
        path,
        manifest_path,
        max_bytes,
        max_variable_bytes,
        prune_oversized,
        None,
        preserve_names,
    )


class MergeWriteTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name
        self.path = os.path.join(self.dir, "state.dill")
        self.manifest = os.path.join(self.dir, "state.json")

    def assertNoError(self, result: dict) -> None:
        self.assertNotIn("error", result, result.get("error"))

    def test_carries_the_previous_blob_for_a_requested_name(self):
        previous_bad = dill.dumps("the-original")
        write_payload(self.path, {"bad": previous_bad, "good": dill.dumps(1)})

        result = snapshot({"good": 2, "fresh": 42}, self.path, self.manifest, preserve_names=["bad"])

        self.assertNoError(result)
        self.assertEqual(result["preserved"], ["bad"])
        self.assertEqual(sorted(result["saved"]), ["bad", "fresh", "good"])
        payload = read_payload(self.path)
        # The unrestorable value is carried over byte-for-byte...
        self.assertEqual(payload["bad"], previous_bad)
        self.assertEqual(dill.loads(payload["bad"]), "the-original")
        # ...while every other name comes from the live namespace.
        self.assertEqual(dill.loads(payload["good"]), 2)
        self.assertEqual(dill.loads(payload["fresh"]), 42)
        manifest = read_manifest(self.manifest)
        self.assertEqual(manifest["preserved"], ["bad"])
        self.assertEqual(manifest["savedNames"], result["saved"])
        self.assertEqual(manifest["version"], 1)

    def test_a_requested_name_keeps_its_saved_blob_over_a_rebuilt_live_value(self):
        # Documented semantics (TASKS.md T0-5): a requested name reuses the OLD payload's blob.
        # The host clears its request list after a fully successful restore, so the window in
        # which a rebuilt value is not persisted is bounded by the next clean restore.
        previous = dill.dumps("original")
        write_payload(self.path, {"bad": previous})

        result = snapshot({"bad": "rebuilt"}, self.path, self.manifest, preserve_names=["bad"])

        self.assertNoError(result)
        self.assertEqual(result["preserved"], ["bad"])
        self.assertEqual(dill.loads(read_payload(self.path)["bad"]), "original")

    def test_an_unreadable_previous_payload_costs_the_merge_only(self):
        good = dill.dumps(1)
        cases = {
            "missing": None,
            "truncated": good[: max(1, len(good) // 2)],
            "not a dict": None,
        }
        self.assertGreater(len(cases), 0)
        for name, torn in cases.items():
            with self.subTest(previous=name):
                for suffix in (".dill", ".json"):
                    try:
                        os.remove(self.path if suffix == ".dill" else self.manifest)
                    except FileNotFoundError:
                        pass
                if name == "missing":
                    pass
                elif name == "truncated":
                    write_payload(self.path, {"bad": good})
                    with open(self.path, "wb") as fh:
                        fh.write(torn)
                else:
                    with open(self.path, "wb") as fh:
                        dill.dump(["not", "a", "dict"], fh)

                result = snapshot(
                    {"fresh": 42}, self.path, self.manifest, preserve_names=["bad", "worse"]
                )

                # Not blocked: the fresh work is on disk, and each requested name says why it
                # could not be carried over.
                self.assertNoError(result)
                self.assertEqual(result["preserved"], [])
                self.assertIn("fresh", result["saved"])
                reasons = {entry["name"]: entry["reason"] for entry in result["skipped"]}
                self.assertEqual(sorted(reasons), ["bad", "worse"])
                for reason in reasons.values():
                    self.assertIn("preserved blob unavailable", reason)
                self.assertEqual(dill.loads(read_payload(self.path)["fresh"]), 42)

    def test_a_requested_name_absent_from_the_previous_payload_is_reported(self):
        write_payload(self.path, {"other": dill.dumps(1)})

        result = snapshot({"fresh": 42}, self.path, self.manifest, preserve_names=["bad"])

        self.assertNoError(result)
        self.assertEqual(result["preserved"], [])
        self.assertEqual(
            [entry["reason"] for entry in result["skipped"] if entry["name"] == "bad"],
            ["preserved blob unavailable: absent from the previous snapshot payload"],
        )
        self.assertIn("fresh", result["saved"])

    def test_the_aggregate_cap_drops_the_oldest_preserved_name_first(self):
        # Request order is oldest first, which is how the host reports its unrestored names.
        write_payload(
            self.path,
            {"old": b"o" * 400, "mid": b"m" * 400, "new": b"n" * 400},
        )

        result = snapshot(
            {},
            self.path,
            self.manifest,
            max_bytes=1100,
            preserve_names=["old", "mid", "new"],
        )

        self.assertNoError(result)
        self.assertEqual(result["preserved"], ["mid", "new"])
        self.assertNotIn("old", result["saved"])
        self.assertEqual(
            [entry["name"] for entry in result["skipped"] if "aggregate" in entry["reason"]],
            ["old"],
        )
        payload = read_payload(self.path)
        self.assertEqual(sorted(payload), ["mid", "new"])
        self.assertEqual(payload["new"], b"n" * 400)
        self.assertEqual(read_manifest(self.manifest)["preserved"], ["mid", "new"])

    def test_preserve_wins_over_prune_oversized(self):
        write_payload(self.path, {"big": dill.dumps("the-saved-value")})
        ns = {"big": "x" * 5000, "small": 1}

        result = snapshot(
            ns,
            self.path,
            self.manifest,
            max_variable_bytes=50,
            prune_oversized=True,
            preserve_names=["big"],
        )

        self.assertNoError(result)
        self.assertEqual(result["preserved"], ["big"])
        # The saved blob is what landed, and the live oversized value was not pruned away:
        # preserving a name outranks pruning it.
        self.assertEqual(dill.loads(read_payload(self.path)["big"]), "the-saved-value")
        self.assertNotIn("big", result["pruned"])
        self.assertIn("big", ns)
        self.assertEqual(result["pruned"], [])

    def test_a_snapshot_without_the_field_keeps_the_protocol_3_shape(self):
        write_payload(self.path, {"bad": dill.dumps("original")})

        result = snapshot({"fresh": 42}, self.path, self.manifest)

        self.assertNoError(result)
        # The done frame gains a field only for a request that used it.
        self.assertNotIn("preserved", result)
        self.assertEqual(result["saved"], ["fresh"])
        self.assertEqual(read_manifest(self.manifest)["preserved"], [])


class PreserveNamesWireTest(unittest.TestCase):
    """The request field is gated on the negotiated protocol, not on the version constant."""

    def spawn(self, protocol_env: str | None) -> ReplProcess:
        env = {} if protocol_env is None else {"PRIME_AGENT_KERNEL_PROTOCOL": protocol_env}
        process = ReplProcess(env=env)
        self.addCleanup(process.close)
        return process

    def test_a_negotiated_4_session_announces_the_capability_and_merges(self):
        process = self.spawn("4")
        ready, _ = process.ready()
        self.assertEqual(ready["protocol"], 4)
        self.assertEqual(ready.get("capabilities"), ["preserve_names"])

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.dill")
            manifest_path = os.path.join(tmp, "state.json")
            blob = dill.dumps("the-original")
            # Underscore names stay out of the snapshot, so the assertions below only see the
            # names this test means to write.
            setup = "\n".join(
                [
                    "import dill as _dill",
                    f"_blob = {blob!r}",
                    f"with open({path!r}, 'wb') as _fh:",
                    "    _dill.dump({'bad': _blob}, _fh)",
                ]
            )
            self.assertEqual(one(process.execute("c1", setup), "done")["status"], "ok")

            process.send(
                {
                    "type": "snapshot",
                    "id": "s1",
                    "path": path,
                    "manifest_path": manifest_path,
                    "preserve_names": ["bad"],
                }
            )
            done = one(process.until_done("s1"), "done")
            self.assertEqual(done["status"], "ok")
            self.assertEqual(done["preserved"], ["bad"])
            self.assertIn("bad", done["saved"])
            self.assertEqual(dill.loads(read_payload(path)["bad"]), "the-original")
            self.assertEqual(read_manifest(manifest_path)["preserved"], ["bad"])

            # And the carried blob still revives in this very kernel.
            process.send({"type": "restore", "id": "r1", "path": path})
            restored = one(process.until_done("r1"), "done")
            self.assertEqual(restored["status"], "ok")
            self.assertIn("bad", restored["restored"])
        self.assertEqual(process.shutdown(), 0)

    def test_a_negotiated_3_session_refuses_the_field_and_keeps_today_frames(self):
        process = self.spawn(None)
        ready, _ = process.ready()
        self.assertEqual(ready["protocol"], 3)
        self.assertNotIn("capabilities", ready)

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.dill")
            manifest_path = os.path.join(tmp, "state.json")
            process.send(
                {
                    "type": "snapshot",
                    "id": "s1",
                    "path": path,
                    "manifest_path": manifest_path,
                    "preserve_names": ["bad"],
                }
            )
            refused = one(process.until_done("s1"), "done")
            self.assertEqual(refused["status"], "error")
            self.assertIn("preserve_names requires kernel protocol 4", refused["reason"])
            self.assertFalse(os.path.exists(path))

            # Positive control: the same session still snapshots, with no protocol-4 field.
            self.assertEqual(one(process.execute("c1", "fresh = 42"), "done")["status"], "ok")
            process.send(
                {
                    "type": "snapshot",
                    "id": "s2",
                    "path": path,
                    "manifest_path": manifest_path,
                }
            )
            plain = one(process.until_done("s2"), "done")
            self.assertEqual(plain["status"], "ok")
            self.assertNotIn("preserved", plain)
            self.assertEqual(plain["saved"], ["fresh"])
        self.assertEqual(process.shutdown(), 0)

    def test_a_malformed_preserve_list_is_refused(self):
        process = self.spawn("4")
        process.ready()
        for index, malformed in enumerate(["bad", [1], {"name": "bad"}]):
            with self.subTest(malformed=malformed):
                with tempfile.TemporaryDirectory() as tmp:
                    process.send(
                        {
                            "type": "snapshot",
                            "id": f"s{index}",
                            "path": os.path.join(tmp, "state.dill"),
                            "manifest_path": os.path.join(tmp, "state.json"),
                            "preserve_names": malformed,
                        }
                    )
                    done = one(process.until_done(f"s{index}"), "done")
                self.assertEqual(done["status"], "error")
                self.assertIn("preserve_names must be a list of strings", done["reason"])
        self.assertEqual(process.shutdown(), 0)


if __name__ == "__main__":
    unittest.main()
