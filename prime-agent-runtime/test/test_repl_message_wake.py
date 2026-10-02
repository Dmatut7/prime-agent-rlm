"""W21-B: message-wake - a waiting parent cell learns that a message arrived.

EX-6 (swarm fan-out/fan-in) showed the starvation this kills: children report back with
``agent_message.send(..., receiver_role="parent")``, and the reply reaches the parent session
while the parent is parked inside one long cell - typically ``await rlm.collect(timeout_ms=
180_000)`` in a fan-in loop. The message only enters the parent's conversation at the next
turn, the turn only ends when the cell returns, and the cell only returns when the wait ends:
fan-in starves until the quiescence barrier gives up.

The kernel half of the fix, pinned here:

- Protocol 5 adds the ``notify`` request - an out-of-band host push, handled on the reader
  thread like ``host_reply`` (never queued behind the in-flight execute it must wake). The
  kernel announces the ``message_notify`` capability at protocol 5; older hosts never send
  the frame, and a kernel keeps serving whether or not one ever arrives.
- ``rlm.wait_messages(timeout_ms)`` / ``rlm.messages_pending()`` are the wakeable wait
  primitive and its peek: a notification wakes a parked wait at its await point, and the
  message itself still enters the parent's context as an ordinary queued prompt at the next
  turn boundary - a notify never raises into running code and never wakes an unrelated wait.
- ``rlm.collect`` asks the host to end its wait early on a message arrival
  (``wake_on_message`` request field - ignored by older hosts, so a collect against one
  behaves exactly as before) and surfaces a reply's ``messages_pending`` as a printed note
  plus the same pending counter, so the model learns it should end the turn.
"""

from __future__ import annotations

import time
import unittest

from test_repl import ReplProcess, one, stream_text

PROTOCOL_ENV_VAR = "PRIME_AGENT_KERNEL_PROTOCOL"


def spawn(protocol: str | None = None) -> ReplProcess:
    env = {} if protocol is None else {PROTOCOL_ENV_VAR: protocol}
    return ReplProcess(env=env)


def read_until(proc: ReplProcess, predicate, timeout: float = 30.0) -> dict:
    """Read events until one satisfies the predicate; TimeoutError from read_event otherwise."""
    deadline = time.monotonic() + timeout
    while True:
        event = proc.read_event(timeout=max(0.1, deadline - time.monotonic()))
        if predicate(event):
            return event


class MessageWakeHandshakeTest(unittest.TestCase):
    """The capability is announced exactly at the protocol that introduced the frame."""

    def test_ready_protocol_5_announces_message_notify(self):
        proc = spawn("5")
        self.addCleanup(proc.close)
        ready, _ = proc.ready()
        self.assertEqual(ready["event"], "ready")
        self.assertEqual(ready["protocol"], 5)
        self.assertEqual(ready.get("capabilities"), ["preserve_names", "message_notify"])
        self.assertEqual(proc.shutdown(), 0)

    def test_ready_protocol_4_keeps_only_preserve_names(self):
        # Mixed-version pin: a host that negotiated 4 must see the frame it always saw, so it
        # never learns it may send notify.
        proc = spawn("4")
        self.addCleanup(proc.close)
        ready, _ = proc.ready()
        self.assertEqual(ready["protocol"], 4)
        self.assertEqual(ready.get("capabilities"), ["preserve_names"])
        self.assertEqual(proc.shutdown(), 0)


class WaitMessagesTest(unittest.TestCase):
    """The wakeable wait primitive against a real kernel subprocess."""

    def setUp(self):
        self.proc = spawn("5")
        self.addCleanup(self.proc.close)
        ready, _ = self.proc.ready()
        self.assertEqual(ready["protocol"], 5)

    def test_notify_wakes_a_long_wait(self):
        # The EX-6 shape: a cell parked in a long wait, a message landing mid-wait, and the
        # cell completing promptly instead of at the 120s timeout.
        code = "\n".join(
            [
                "import rlm",
                "print('WAITING')",
                "n = await rlm.wait_messages(timeout_ms=120000)",
                "print(f'WOKEN {n}')",
            ]
        )
        self.proc.send({"type": "execute", "id": "w1", "code": code})
        read_until(self.proc, lambda e: e.get("event") == "stdout" and "WAITING" in e.get("text", ""))
        woke_at = time.monotonic()
        self.proc.send({"type": "notify", "kind": "agent_message"})
        events = self.proc.until_done("w1")
        self.assertLess(time.monotonic() - woke_at, 30)
        self.assertEqual(one(events, "done")["status"], "ok")
        self.assertIn("WOKEN 1", stream_text(events, "stdout"))
        # The wake was consumed: nothing lingers for the next wait.
        events = self.proc.execute("w2", "import rlm\nprint(f'PENDING {rlm.messages_pending()}')")
        self.assertIn("PENDING 0", stream_text(events, "stdout"))

    def test_notify_between_cells_is_drained_by_the_next_wait(self):
        # A notification that lands while no cell runs is not lost: the next wait, even a
        # non-blocking one, drains it.
        self.proc.send({"type": "notify", "kind": "agent_message"})
        events = self.proc.execute("b1", "import rlm\nn = await rlm.wait_messages(timeout_ms=0)\nprint(f'DRAIN {n}')")
        self.assertEqual(one(events, "done")["status"], "ok")
        self.assertIn("DRAIN 1", stream_text(events, "stdout"))
        events = self.proc.execute("b2", "import rlm\nn = await rlm.wait_messages(timeout_ms=0)\nprint(f'DRAIN {n}')")
        self.assertIn("DRAIN 0", stream_text(events, "stdout"))

    def test_wait_messages_timeout_returns_zero(self):
        code = "import rlm\nn = await rlm.wait_messages(timeout_ms=200)\nprint(f'TIMEDOUT {n}')"
        started = time.monotonic()
        events = self.proc.execute("t1", code)
        self.assertLess(time.monotonic() - started, 30)
        self.assertEqual(one(events, "done")["status"], "ok")
        self.assertIn("TIMEDOUT 0", stream_text(events, "stdout"))

    def test_messages_pending_peeks_without_draining(self):
        self.proc.send({"type": "notify", "kind": "agent_message"})
        code = "import rlm\nprint(f'PEEK {rlm.messages_pending()} {rlm.messages_pending()}')"
        events = self.proc.execute("p1", code)
        self.assertIn("PEEK 1 1", stream_text(events, "stdout"))

    def test_notify_does_not_interrupt_synchronous_code(self):
        # Safe-point semantics: the notification is recorded by a loop callback, and a
        # synchronous section freezes the loop, so mid-section the count still reads 0; the
        # wake lands at the next await, never by raising into running bytecode. The sleep
        # also runs to completion - nothing about the cell's timing changes.
        code = "\n".join(
            [
                "import asyncio, rlm, time",
                "print('START')",
                "time.sleep(0.6)",
                "print(f'SYNC {rlm.messages_pending()}')",
                "await asyncio.sleep(0)",
                "print(f'SAFE {rlm.messages_pending()}')",
            ]
        )
        self.proc.send({"type": "execute", "id": "s1", "code": code})
        read_until(self.proc, lambda e: e.get("event") == "stdout" and "START" in e.get("text", ""))
        notified_at = time.monotonic()
        self.proc.send({"type": "notify", "kind": "agent_message"})
        events = self.proc.until_done("s1")
        self.assertGreaterEqual(time.monotonic() - notified_at, 0.5)
        self.assertEqual(one(events, "done")["status"], "ok")
        self.assertIsNone(one(events, "error"))
        out = stream_text(events, "stdout")
        self.assertIn("SYNC 0", out)
        self.assertIn("SAFE 1", out)

    def test_notify_does_not_wake_an_unrelated_sleep(self):
        # Only message waits wake: an asyncio.sleep is not one, so the notification waits in
        # the ledger and the sleep finishes on schedule.
        code = "\n".join(
            [
                "import asyncio, rlm",
                "print('SLEEPING')",
                "await asyncio.sleep(1.0)",
                "print(f'SLEPT {rlm.messages_pending()}')",
            ]
        )
        self.proc.send({"type": "execute", "id": "u1", "code": code})
        read_until(self.proc, lambda e: e.get("event") == "stdout" and "SLEEPING" in e.get("text", ""))
        notified_at = time.monotonic()
        self.proc.send({"type": "notify", "kind": "agent_message"})
        events = self.proc.until_done("u1")
        self.assertGreaterEqual(time.monotonic() - notified_at, 0.8)
        self.assertEqual(one(events, "done")["status"], "ok")
        self.assertIn("SLEPT 1", stream_text(events, "stdout"))

    def test_notify_on_a_protocol_3_kernel_still_wakes(self):
        # Robustness pin: a conforming host gates on the capability and never sends notify
        # here, but a frame that arrives anyway must wake waits, not kill the session.
        proc = spawn("3")
        self.addCleanup(proc.close)
        ready, _ = proc.ready()
        self.assertEqual(ready["protocol"], 3)
        self.assertNotIn("capabilities", ready)
        code = "import rlm\nprint('WAITING')\nn = await rlm.wait_messages(timeout_ms=120000)\nprint(f'WOKEN {n}')"
        proc.send({"type": "execute", "id": "w3", "code": code})
        read_until(proc, lambda e: e.get("event") == "stdout" and "WAITING" in e.get("text", ""))
        proc.send({"type": "notify", "kind": "agent_message"})
        events = proc.until_done("w3")
        self.assertEqual(one(events, "done")["status"], "ok")
        self.assertIn("WOKEN 1", stream_text(events, "stdout"))
        self.assertEqual(proc.shutdown(), 0)

    def test_malformed_notify_is_a_protocol_error_and_serving_continues(self):
        self.proc.send({"type": "notify"})
        error = read_until(self.proc, lambda e: e.get("event") == "error")
        self.assertEqual(error["ename"], "ProtocolError")
        self.assertIsNone(error["id"])
        events = self.proc.execute("m1", "'alive'")
        self.assertEqual(one(events, "result")["text"], "'alive'")

    def test_unknown_notify_kind_is_ignored(self):
        # Forward compatibility: a newer host may push kinds this runtime does not wait on;
        # ignoring them is the degrade, never an error.
        self.proc.send({"type": "notify", "kind": "subagent_settled"})
        events = self.proc.execute("k1", "import rlm\nprint(f'PENDING {rlm.messages_pending()}')")
        self.assertEqual(one(events, "done")["status"], "ok")
        self.assertIn("PENDING 0", stream_text(events, "stdout"))
        self.assertFalse([e for e in events if e.get("ename") == "ProtocolError"])


class CollectMessageWakeTest(unittest.TestCase):
    """rlm.collect asks for the early wake and surfaces a messages_pending reply."""

    def setUp(self):
        # collect rides the ungated host bridge: no protocol-5 negotiation needed.
        self.proc = spawn(None)
        self.addCleanup(self.proc.close)
        ready, _ = self.proc.ready()
        self.assertEqual(ready["protocol"], 3)

    def run_collect(self, rid: str, reply_result: dict) -> list[dict]:
        code = "\n".join(
            [
                "import rlm",
                "results = await rlm.collect(['child-1'], timeout_ms=120000)",
                "print(f'COLLECTED {len(results)}')",
            ]
        )
        self.proc.send({"type": "execute", "id": rid, "code": code})
        request = read_until(self.proc, lambda e: e.get("event") == "host_request")
        self.assertEqual(request["data"]["type"], "rlm.collect")
        self.proc.send({"type": "host_reply", "id": request["id"], "data": {"status": "ok", "result": reply_result}})
        return self.proc.until_done(rid)

    def test_collect_requests_message_wake(self):
        self.proc.send(
            {
                "type": "execute",
                "id": "c1",
                "code": "import rlm\nresults = await rlm.collect(timeout_ms=120000)\nprint('NEVER' if False else 'DONE')",
            }
        )
        request = read_until(self.proc, lambda e: e.get("event") == "host_request")
        self.assertEqual(request["data"]["type"], "rlm.collect")
        self.assertEqual(request["data"]["timeout_ms"], 120000)
        # The field a wake-capable host honors; an older host ignores it and waits as before.
        self.assertIs(request["data"].get("wake_on_message"), True)
        self.proc.send(
            {"type": "host_reply", "id": request["id"], "data": {"status": "ok", "result": {"results": []}}}
        )
        self.assertEqual(one(self.proc.until_done("c1"), "done")["status"], "ok")

    def test_collect_early_reply_with_messages_pending_prints_a_note_and_marks_pending(self):
        events = self.run_collect("c2", {"results": [], "messages_pending": 2})
        self.assertEqual(one(events, "done")["status"], "ok")
        out = stream_text(events, "stdout")
        self.assertIn("COLLECTED 0", out)
        # The model-visible signal: end the turn so the queued message can be received.
        self.assertIn("2 agent message(s) pending", out)
        events = self.proc.execute("c2b", "import rlm\nprint(f'PENDING {rlm.messages_pending()}')")
        self.assertIn("PENDING 2", stream_text(events, "stdout"))

    def test_collect_reply_without_messages_pending_stays_quiet(self):
        events = self.run_collect("c3", {"results": []})
        out = stream_text(events, "stdout")
        self.assertIn("COLLECTED 0", out)
        self.assertNotIn("pending", out)
        # A malformed value is not a wake either: ignore it, keep the reply honest.
        events = self.run_collect("c4", {"results": [], "messages_pending": "lots"})
        out = stream_text(events, "stdout")
        self.assertIn("COLLECTED 0", out)
        self.assertNotIn("pending", out)
        events = self.proc.execute("c5", "import rlm\nprint(f'PENDING {rlm.messages_pending()}')")
        self.assertIn("PENDING 0", stream_text(events, "stdout"))


if __name__ == "__main__":
    unittest.main()
