"""Out-of-band bash activity queries (protocol 5 `bash_activity`).

The host inspects or stops the background commands a kernel created without waiting behind the
cell execution queue, so a stuck or long-running cell cannot hide what it spawned. These cases
drive the request on the reader thread (bypassing the FIFO), which is the whole point: a query
must answer while another cell is still running.
"""

from __future__ import annotations

import unittest

from test_repl import ReplProcess, one


class BashActivityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.repl = ReplProcess()
        self.addCleanup(self.repl.close)
        self.repl.ready()

    def activity(self, rid: str, action: str, **fields: object) -> dict:
        """Send one out-of-band bash_activity request and return its done frame."""
        self.repl.send({"type": "bash_activity", "id": rid, "action": action, **fields})
        while True:
            event = self.repl.read_event()
            if event.get("event") == "done" and event.get("id") == rid:
                return event

    def test_list_tail_and_kill_answer(self):
        events = self.repl.execute("spawn", "from rlm import bash\nbash('sleep 600')\n'spawned'")
        self.assertEqual(one(events, "done")["status"], "ok")

        listed = self.activity("q-list", "list")
        self.assertEqual(listed["status"], "ok")
        running = [row for row in listed["activities"] if row["status"] == "running"]
        self.assertEqual(len(running), 1)
        activity_id = running[0]["id"]
        self.assertIsInstance(activity_id, str)
        self.assertGreater(running[0]["pid"], 0)
        self.assertFalse(running[0]["pid"] == 0)

        tailed = self.activity("q-tail", "tail", activityId=activity_id, lines=10)
        self.assertEqual(tailed["status"], "ok")
        self.assertEqual(tailed["activityId"], activity_id)
        self.assertIsInstance(tailed["tail"], str)

        killed = self.activity("q-kill", "kill", activityId=activity_id)
        self.assertEqual(killed["status"], "ok")
        self.assertEqual(killed["activityId"], activity_id)
        self.assertTrue(killed["killed"])

    def test_query_answers_while_a_cell_is_running(self):
        self.repl.execute("spawn2", "from rlm import bash\nbash('sleep 600')\n'ok'")
        # Start a cell that will not finish, then ask about the background handle mid-flight.
        self.repl.send({"type": "execute", "id": "block", "code": "import asyncio\nawait asyncio.sleep(3600)"})
        self.repl.send({"type": "bash_activity", "id": "mid", "action": "list"})

        saw_block_done = False
        while True:
            event = self.repl.read_event()
            if event.get("event") == "done" and event.get("id") == "block":
                saw_block_done = True
            if event.get("event") == "done" and event.get("id") == "mid":
                self.assertEqual(event["status"], "ok")
                running = [row for row in event["activities"] if row["status"] == "running"]
                self.assertEqual(len(running), 1)
                break
        # The reply came while the blocking cell was still running: it never queued behind it.
        self.assertFalse(saw_block_done)

        self.repl.send({"type": "interrupt", "id": "block"})
        self.repl.until_done("block")

    def test_unknown_activity_and_bad_action_are_reported(self):
        listed = self.activity("q-empty", "list")
        self.assertEqual(listed["status"], "ok")
        self.assertEqual(listed["activities"], [])

        unknown = self.activity("q-unknown", "tail", activityId="nope")
        self.assertEqual(unknown["status"], "error")
        self.assertIn("unknown kernel bash activity", unknown["reason"])

        # A bad action is a protocol error, not a done frame (nothing to answer).
        self.repl.send({"type": "bash_activity", "id": "q-bad", "action": "explode"})
        event = self.repl.read_event()
        self.assertEqual(event["event"], "error")
        self.assertEqual(event["ename"], "ProtocolError")

    def test_capability_is_gated_to_protocol_5(self):
        # The token must not appear below the protocol that introduced it: a protocol-3 ready
        # frame stays byte-identical to a pre-feature runtime's, and the host never gates on it.
        repl = ReplProcess(env={"PRIME_AGENT_KERNEL_PROTOCOL": "3"})
        self.addCleanup(repl.close)
        ready, _ = repl.ready()
        self.assertEqual(ready["protocol"], 3)
        self.assertNotIn("bash_activity", ready.get("capabilities", []))

    def test_capability_announced_at_protocol_5(self):
        repl = ReplProcess(env={"PRIME_AGENT_KERNEL_PROTOCOL": "5"})
        self.addCleanup(repl.close)
        ready, _ = repl.ready()
        self.assertEqual(ready["protocol"], 5)
        self.assertIn("bash_activity", ready["capabilities"])


if __name__ == "__main__":
    unittest.main()