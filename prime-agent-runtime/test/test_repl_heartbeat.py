"""T1-2 / P0-1b: the kernel liveness heartbeat.

Protocol 4 adds one out-of-band frame per interval while a request is in flight, carrying the
event-loop tick and monotonic progress counters. It exists so the host can tell a wedged kernel
from one that is waiting on work it does not own - the distinction the stall watchdog could not
make before, which is why a healthy long ``await bash(...)`` was aborted at 15 minutes of
silence and a genuinely dead loop was not distinguishable from it.

Pinned here (the runtime half): the env gate is a single point - a host that negotiated 3 must
never see the kind, because it reads an unknown kind as protocol corruption and kills the
kernel; frames only go out while a request is in flight; a value that cannot be serialized
strictly costs one frame instead of tearing the stream; and the tick A/B that makes the frame
mean something - ``await asyncio.sleep`` advances it, ``time.sleep`` freezes it while the frames
keep arriving.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
from unittest import mock

from rlm import repl
from test_repl import ReplProcess, one

HEARTBEAT_INTERVAL_ENV_VAR = "KERNEL_HEARTBEAT_INTERVAL_MS"
PROTOCOL_ENV_VAR = "PRIME_AGENT_KERNEL_PROTOCOL"

# Frame fields the host validates; a missing or non-integer one is a rejected frame there.
REQUIRED_INT_FIELDS = ("tick", "cpu_ms", "stream_bytes", "cells_done", "host_requests", "interval_ms")
REQUIRED_BASH_FIELDS = ("handles", "cell_handles", "buffered_bytes", "pipe_pending")


def drain(proc: ReplProcess, seconds: float) -> list[dict]:
    """Every event that arrives inside the window.

    `ReplProcess.raw_lines` only grows when an event is read, so "nothing was sent" has to be
    proved by reading with a deadline rather than by looking at the buffer.
    """
    events: list[dict] = []
    deadline = time.monotonic() + seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return events
        try:
            events.append(proc.read_event(timeout=remaining))
        except TimeoutError:
            return events


def heartbeats(events: list[dict]) -> list[dict]:
    return [event for event in events if event.get("event") == "heartbeat"]


class HeartbeatGateTest(unittest.TestCase):
    """In-process: the two gates, the frame contract, and strict serialization."""

    def setUp(self) -> None:
        self._saved = {
            "protocol": repl._negotiated_protocol,
            "rid": repl._active["rid"],
            "interval": repl._heartbeat_interval_ms,
            "finishing": repl._finishing_rid,
        }
        repl._negotiated_protocol = 4
        repl._heartbeat_interval_ms = 5000
        repl._finishing_rid = None

    def tearDown(self) -> None:
        repl._negotiated_protocol = self._saved["protocol"]
        repl._active["rid"] = self._saved["rid"]
        repl._heartbeat_interval_ms = self._saved["interval"]
        repl._finishing_rid = self._saved["finishing"]
        with repl._interrupt_lock:
            repl._inflight.clear()

    def test_interval_clamps_and_defaults(self) -> None:
        cases: list[tuple[object, int]] = [
            (None, repl.DEFAULT_HEARTBEAT_INTERVAL_MS),
            ("", repl.DEFAULT_HEARTBEAT_INTERVAL_MS),
            ("abc", repl.DEFAULT_HEARTBEAT_INTERVAL_MS),
            ("1", repl.MIN_HEARTBEAT_INTERVAL_MS),
            ("-5", repl.MIN_HEARTBEAT_INTERVAL_MS),
            ("250", 250),
            ("99999999", repl.MAX_HEARTBEAT_INTERVAL_MS),
        ]
        self.assertGreater(len(cases), 0)
        for raw, expected in cases:
            with self.subTest(raw=raw):
                with mock.patch.dict(os.environ, {}, clear=False):
                    os.environ.pop(HEARTBEAT_INTERVAL_ENV_VAR, None)
                    if raw is not None:
                        os.environ[HEARTBEAT_INTERVAL_ENV_VAR] = str(raw)
                    self.assertEqual(repl.heartbeat_interval_ms(), expected)

    def test_no_frame_when_the_host_negotiated_below_protocol_4(self) -> None:
        repl._active["rid"] = "cell-1"
        with mock.patch.object(repl, "_negotiated_protocol", 4):
            self.assertIsNotNone(repl._heartbeat_frame())
        # The env gate is a single point: a host that asked for 3 reads this kind as
        # corruption and repairs (kills) the kernel, so nothing may be built at all.
        with mock.patch.object(repl, "_negotiated_protocol", 3):
            self.assertIsNone(repl._heartbeat_frame())

    def test_no_frame_while_the_kernel_is_idle(self) -> None:
        repl._active["rid"] = None
        with repl._interrupt_lock:
            repl._inflight.clear()
        self.assertIsNone(repl._heartbeat_frame())

        # A request that is in flight but not activated and not finishing (a queued state op)
        # still counts as in flight, and still gets no attribution the runtime does not have.
        with repl._interrupt_lock:
            repl._inflight.add("cell-9")
        frame = repl._heartbeat_frame()
        self.assertIsNotNone(frame)
        assert frame is not None
        self.assertIsNone(frame["id"])
        self.assertNotIn("finishing", frame)

    def test_the_finishing_phase_names_its_request_and_says_it_is_finishing(self) -> None:
        """K-P2-2: the post-run repr/drain is the slow phase the frame exists to cover.

        It clears `_active` before the request leaves `_inflight`, so an id-less frame told the
        host "no cell in flight" for exactly the window a huge `repr` spends minutes in - and a
        frozen tick there (the repr blocks the loop) then read as a stall with nothing vouching
        against it. The frame names the request and marks the phase, so the host can tell a
        synchronous finishing phase from a deadlocked cell body.
        """
        repl._active["rid"] = None
        with repl._interrupt_lock:
            repl._inflight.add("cell-9")
            repl._finishing_rid = "cell-9"
        frame = repl._heartbeat_frame()
        self.assertIsNotNone(frame)
        assert frame is not None
        self.assertEqual(frame["id"], "cell-9")
        self.assertIs(frame["finishing"], True)
        # The attributed bash facts follow the request that is still in flight.
        self.assertEqual(frame["bash"]["cell_handles"], 0)
        json.dumps(frame, allow_nan=False)

        # A stale marker whose request already left `_inflight` names nothing: the finish path
        # clears both under one lock, and a frame must not resurrect a completed request.
        with repl._interrupt_lock:
            repl._inflight.clear()
        self.assertIsNone(repl._heartbeat_frame())

        # An activated request keeps the plain frame: `finishing` is only the post-run phase.
        repl._active["rid"] = "cell-9"
        with repl._interrupt_lock:
            repl._inflight.add("cell-9")
        active = repl._heartbeat_frame()
        assert active is not None
        self.assertEqual(active["id"], "cell-9")
        self.assertNotIn("finishing", active)

    def test_frame_carries_the_cell_id_and_monotonic_integer_facts(self) -> None:
        repl._active["rid"] = "cell-7"
        frame = repl._heartbeat_frame()
        self.assertIsNotNone(frame)
        assert frame is not None
        self.assertEqual(frame["event"], "heartbeat")
        self.assertEqual(frame["id"], "cell-7")
        for field in REQUIRED_INT_FIELDS:
            with self.subTest(field=field):
                self.assertIsInstance(frame[field], int)
                self.assertNotIsInstance(frame[field], bool)
        bash_facts = frame["bash"]
        for field in REQUIRED_BASH_FIELDS:
            with self.subTest(field=f"bash.{field}"):
                self.assertIsInstance(bash_facts[field], int)
        self.assertEqual(frame["interval_ms"], 5000)
        # The phase marker belongs to the finishing phase alone.
        self.assertNotIn("finishing", frame)
        # Strict serialization is the gate the host's framing depends on.
        json.dumps(frame, allow_nan=False)

    def test_a_non_finite_fact_costs_one_frame_and_never_tears_the_stream(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "protocol")
            fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o600)
            try:
                with mock.patch.object(repl, "_protocol_fd", fd):
                    # B8: NaN is the only corruption vector json.dumps would otherwise paper
                    # over, and a torn frame is fatal host-side, so the frame dies here.
                    self.assertFalse(repl._send_heartbeat({"event": "heartbeat", "tick": float("nan")}))
                    self.assertFalse(repl._send_heartbeat({"event": "heartbeat", "tick": float("inf")}))
                    self.assertFalse(repl._send_heartbeat({"event": "heartbeat", "tick": object()}))
                    os.fsync(fd)
                    with open(path, "rb") as handle:
                        self.assertEqual(handle.read(), b"")
                    # Positive control: a well-formed frame from the same fd really is written.
                    self.assertTrue(repl._send_heartbeat({"event": "heartbeat", "tick": 1}))
                    os.fsync(fd)
                    with open(path, "rb") as handle:
                        written = handle.read().decode()
                    self.assertEqual(json.loads(written.strip())["tick"], 1)
            finally:
                os.close(fd)

    def test_a_raising_fact_source_costs_one_round_and_not_the_heartbeat(self) -> None:
        repl._active["rid"] = "cell-1"
        with mock.patch.object(repl, "live_handle_facts", side_effect=RuntimeError("registry broke")):
            self.assertFalse(repl._heartbeat_once())
        # The thread survives the bad round: the very next one goes out.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "protocol")
            fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o600)
            try:
                with mock.patch.object(repl, "_protocol_fd", fd):
                    self.assertTrue(repl._heartbeat_once())
                    os.fsync(fd)
                    with open(path, "rb") as handle:
                        self.assertIn(b"heartbeat", handle.read())
            finally:
                os.close(fd)

    def test_live_handle_facts_reports_a_running_command(self) -> None:
        # The package re-exports the bash() function under the module's own name, so reach
        # the module through sys.modules (same route test_bash.py takes).
        import rlm.bash  # noqa: F401
        import sys

        bash_module = sys.modules["rlm.bash"]

        idle = bash_module.live_handle_facts(None)
        self.assertEqual(idle["handles"], 0)
        self.assertEqual(idle["cell_handles"], 0)

        token = bash_module._set_current_cell("cell-facts")
        handle = bash_module.bash("sleep 30")
        try:
            facts = bash_module.live_handle_facts("cell-facts")
            self.assertEqual(facts["handles"], 1)
            self.assertEqual(facts["cell_handles"], 1)
            self.assertIsInstance(facts["buffered_bytes"], int)
            self.assertIsInstance(facts["pipe_pending"], int)
            # Another cell's id does not inherit this cell's attribution.
            self.assertEqual(bash_module.live_handle_facts("other-cell")["cell_handles"], 0)
        finally:
            handle.kill(grace=1.0)
            bash_module._reset_current_cell(token)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if bash_module.live_handle_facts("cell-facts")["handles"] == 0:
                return
            time.sleep(0.05)
        self.fail("a killed handle kept reporting as live")


class HeartbeatProcessTest(unittest.TestCase):
    """Real `python -m rlm.repl`: the gate on the wire, and the tick A/B."""

    def spawn(self, protocol: str, interval_ms: int) -> ReplProcess:
        proc = ReplProcess(
            env={
                PROTOCOL_ENV_VAR: protocol,
                HEARTBEAT_INTERVAL_ENV_VAR: str(interval_ms),
            }
        )
        self.addCleanup(proc.close)
        ready, _ = proc.ready()
        self.assertEqual(ready["protocol"], int(protocol))
        return proc

    def test_a_negotiated_3_session_never_sees_the_kind(self) -> None:
        proc = self.spawn("3", 100)
        events = proc.execute("c1", "import time\ntime.sleep(0.8)\nprint('done sleeping')")
        kinds = [json.loads(line)["event"] for line in proc.raw_lines if line.strip()]
        self.assertNotIn("heartbeat", kinds)
        # Positive control: the session really ran and streamed for long enough to have
        # produced frames had the gate been open (8 intervals elapsed).
        self.assertEqual(one(events, "done")["status"], "ok")
        self.assertIn("done sleeping", "".join(e.get("text", "") for e in events))
        self.assertGreater(len(kinds), 2)
        self.assertEqual(proc.shutdown(), 0)

    def test_an_idle_kernel_sends_no_frames(self) -> None:
        proc = self.spawn("4", 100)
        # Positive control first: nothing at all arrives while no request is in flight, even
        # though five intervals pass.
        self.assertEqual(drain(proc, 0.5), [])
        events = proc.execute("c1", "import time\ntime.sleep(0.6)")
        frames = heartbeats(events)
        self.assertGreaterEqual(len(frames), 2)
        # A tick that lands between the request's receipt (`_inflight.add` on the
        # reader thread) and its activation (`_run_guarded` setting `_active["rid"]`
        # on the loop thread) builds an id-less frame by contract: the runtime
        # deliberately attributes nothing to a request it has not started serving
        # (pinned by HeartbeatGateTest.test_no_frame_while_the_kernel_is_idle), and
        # the host accepts id:null with cellId read as "absent when it reported
        # none". On a loaded CI runner that dispatch window can span an interval, so
        # the strict all-c1 claim flakes there. The ordering claim below keeps the
        # same teeth on the contract's actual shape: un-attributed frames are only
        # the queued prefix, every frame after activation names the request, and a
        # run that never attributes (or loses attribution mid-request) still fails.
        ids = [frame["id"] for frame in frames]
        first_c1 = ids.index("c1") if "c1" in ids else len(ids)
        self.assertTrue(all(frame["id"] is None for frame in frames[:first_c1]))
        self.assertTrue(all(frame["id"] == "c1" for frame in frames[first_c1:]))
        self.assertLess(first_c1, len(frames))
        # And the kernel goes quiet again once the cell is done. A frame built microseconds
        # before the finish may still land after `done`; what must not happen is the idle
        # kernel keeping up a 10Hz stream (four intervals pass in this window).
        self.assertEqual(one(events, "done")["status"], "ok")
        stragglers = drain(proc, 0.4)
        self.assertLessEqual(len(stragglers), 1)
        self.assertEqual(heartbeats(stragglers), stragglers)
        self.assertEqual(proc.shutdown(), 0)

    def _tick_probe(self, proc: ReplProcess, rid: str, body: str) -> tuple[int, int, list[dict]]:
        code = f"import rlm.repl as _r\nbefore = _r.loop_tick()\n{body}\nstr(before) + ',' + str(_r.loop_tick())"
        events = proc.execute(rid, code)
        self.assertEqual(one(events, "done")["status"], "ok")
        result = one(events, "result")
        self.assertIsNotNone(result)
        before, after = (int(part) for part in result["text"].strip("'").split(","))
        return before, after, heartbeats(events)

    def test_an_awaited_sleep_advances_the_tick_and_a_sync_sleep_freezes_it(self) -> None:
        proc = self.spawn("4", 200)

        # A wider window than the minimum: the tick period is 0.5s, so 2.5s leaves several ticks
        # even on a loaded machine, where a 1.2s window could show a single value and flake.
        before, after, frames = self._tick_probe(proc, "async1", "import asyncio\nawait asyncio.sleep(2.5)")
        self.assertGreaterEqual(len(frames), 2)
        self.assertGreater(after, before, "the loop tick must advance while the cell awaits")
        self.assertGreater(max(f["tick"] for f in frames), min(f["tick"] for f in frames))

        before, after, frames = self._tick_probe(proc, "sync1", "import time\ntime.sleep(1.5)")
        # The machine proof behind probe-silent/probe-tick: the frames keep arriving from the
        # sender thread while the loop is blocked, and every one of them carries the frozen tick.
        self.assertGreaterEqual(len(frames), 2, "a blocked loop must not stop the frames")
        self.assertEqual(after, before, "a synchronous cell must freeze the loop tick")
        self.assertEqual(max(f["tick"] for f in frames), before)
        self.assertEqual(proc.shutdown(), 0)

    def test_a_slow_finishing_phase_keeps_naming_its_request(self) -> None:
        """K-P2-2 on the wire: a slow post-run `repr` keeps sending attributed, phase-marked frames.

        The finishing phase is the one a huge repr spends minutes in, and it blocks the event
        loop, so its frames carry a frozen tick. Naming the request and marking the phase is what
        lets the host read that as "still serializing this cell's result" instead of "deadlocked".
        """
        proc = self.spawn("4", 200)
        cell = "\n".join(
            [
                "import time",
                "class _SlowRepr:",
                "    def __repr__(self):",
                "        time.sleep(1.5)",
                "        return 'slow'",
                "_SlowRepr()",
            ]
        )
        events = proc.execute("fin1", cell)
        self.assertEqual(one(events, "done")["status"], "ok")
        result = one(events, "result")
        self.assertIsNotNone(result)
        self.assertEqual(result["text"], "slow")
        frames = heartbeats(events)
        self.assertGreaterEqual(len(frames), 2, "a 1.5s finishing phase at a 200ms period must emit frames")
        finishing = [frame for frame in frames if frame.get("finishing") is True]
        # Positive control for the phase itself: most of the window is repr, not cell body.
        self.assertGreaterEqual(len(finishing), 2)
        self.assertTrue(all(frame["id"] == "fin1" for frame in finishing))
        ticks = [frame["tick"] for frame in finishing]
        self.assertLessEqual(max(ticks) - min(ticks), 1, "a synchronous repr must not advance the loop tick")
        self.assertEqual(proc.shutdown(), 0)

    def test_frames_report_a_live_bash_handle_and_stream_progress(self) -> None:
        proc = self.spawn("4", 200)
        cell = "\n".join(
            [
                "import asyncio",
                "from rlm import bash",
                "handle = bash('sleep 30')",
                "print('streamed while the handle is live')",
                "await asyncio.sleep(2.0)",
                "handle.kill(grace=1.0)",
            ]
        )
        events = proc.execute("bash1", cell)
        frames = heartbeats(events)
        self.assertEqual(one(events, "done")["status"], "ok")
        self.assertGreaterEqual(len(frames), 2)
        self.assertGreaterEqual(max(f["bash"]["handles"] for f in frames), 1)
        self.assertGreaterEqual(max(f["bash"]["cell_handles"] for f in frames), 1)
        self.assertGreater(max(f["stream_bytes"] for f in frames), 0)
        # The next cell sees the finished one in the monotonic completion counter.
        events = proc.execute("bash2", "import asyncio\nawait asyncio.sleep(0.9)")
        frames = heartbeats(events)
        self.assertGreaterEqual(len(frames), 1)
        self.assertGreaterEqual(max(f["cells_done"] for f in frames), 1)
        self.assertEqual(proc.shutdown(), 0)


if __name__ == "__main__":
    unittest.main()
