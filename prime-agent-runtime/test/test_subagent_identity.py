"""Subagent identity in activity records (R5-M7 / R5-M8).

R5-M7: the spawn step's finished record carried the child's session name only
as its display label - blanks collapsed, long names clipped, secret-looking
names replaced - while every host consumer (timeline lanes, turn box rows, the
compaction handoff ledger) keyed subagent rows by the exact session name. The
finished record now also carries `name`, untouched by the display pipeline.

R5-M8: activity ids were a process-local counter, so a restarted kernel's
`subagent-1` collided with the pre-restart `subagent-1` and the host attached
the new records to the old id (a background command resolved by a record that
belonged to a different command). Ids now mix a per-boot nonce.
"""

from __future__ import annotations

import os
import sys
import unittest

SRC = os.path.join(os.path.dirname(__file__), "..", "src")
sys.path.insert(0, SRC)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_effects import ACTIVITY, HAS_GIT, Kernel, TrackerCase  # noqa: E402


def subagent_records(cell) -> list[dict]:
    return [record for record in cell.payloads(ACTIVITY) if record["kind"] == "subagent"]


@unittest.skipUnless(HAS_GIT, "git is needed for the work-tree comparison")
class SubagentNameTests(TrackerCase):
    def host_replies(self) -> dict:
        # Read at request time, so a test can retarget the child name after setUp.
        self._child = {
            "rlm_child_id": "c1",
            "name": "researcher",
            "session_dir": "/tmp/child",
            "model": "prov/model-x",
        }
        return {"rlm.run": self._child}

    def test_the_finished_record_carries_the_exact_name_beside_the_display_label(self):
        name = "wide   spaced   worker"  # blanks the display label collapses
        self._child["name"] = name
        cell = self.kernel.run("handle = await rlm.run('look into the flaky test')\nhandle.name")
        records = subagent_records(cell)
        finished = records[-1]
        self.assertEqual(finished["status"], "ok")
        # The display label collapses the blanks; the name field must not.
        self.assertEqual(finished["label"], " ".join(name.split()))
        self.assertEqual(finished.get("name"), name)
        # The running record has no name yet: admission has not completed.
        self.assertNotIn("name", records[0])

    def test_a_long_name_is_clipped_only_in_the_label(self):
        name = "worker-" + "x" * 200  # far past MAX_LABEL
        self._child["name"] = name
        cell = self.kernel.run("handle = await rlm.run('check the build')\nhandle.name")
        finished = subagent_records(cell)[-1]
        self.assertLess(len(finished["label"]), 200)
        self.assertEqual(finished.get("name"), name)

    def test_a_secret_looking_name_stays_off_the_record_entirely(self):
        # A name that trips the secret scan is redacted from the display label
        # and omitted from the identity field too: the record is persisted and
        # model-facing, so what it looked like must not ride along (the row
        # keeps the label fallback, as before).
        name = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"  # secret-scan: allow (obvious fake, asserts the name stays off the record)
        self._child["name"] = name
        cell = self.kernel.run("handle = await rlm.run('probe')\nhandle.name")
        finished = subagent_records(cell)[-1]
        self.assertNotIn(name, finished["label"])
        self.assertNotIn("name", finished)


@unittest.skipUnless(HAS_GIT, "git is needed for the work-tree comparison")
class ActivityIdUniquenessTests(TrackerCase):
    """Two kernel processes model a kernel restart: ids must not collide (R5-M8)."""

    def host_replies(self) -> dict:
        return {
            "rlm.run": {
                "rlm_child_id": "c1",
                "name": "researcher",
                "session_dir": "/tmp/child",
                "model": "prov/model-x",
            }
        }

    def test_two_kernel_boots_never_reuse_an_activity_id(self):
        first = subagent_records(self.kernel.run("handle = await rlm.run('first boot')\nhandle.name"))
        second_kernel = Kernel(self.root, host_replies=self.host_replies())
        try:
            # The same warm-up the case's own setUp runs: `rlm` must be imported.
            second_kernel.run("import rlm")
            second = subagent_records(second_kernel.run("handle = await rlm.run('second boot')\nhandle.name"))
        finally:
            second_kernel.close()
        self.assertGreater(len(first), 0)
        self.assertGreater(len(second), 0)
        self.assertNotEqual(first[0]["id"], second[0]["id"], "kernel restart reused an activity id")
        # Both ids stay kind-prefixed so host-side diagnostics still read them.
        for value in (first[0]["id"], second[0]["id"]):
            self.assertTrue(value.startswith("subagent-"), value)


if __name__ == "__main__":
    unittest.main()
