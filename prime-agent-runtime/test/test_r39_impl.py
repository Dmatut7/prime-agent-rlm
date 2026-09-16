"""r39 impl-tails: bash heartbeat facts are fleet sums (r35 H-2)."""

from __future__ import annotations

import importlib

bash = importlib.import_module("rlm.bash")


class _FakeBuffer:
    def __init__(self, size: int) -> None:
        self._size = size

    def size(self) -> int:
        return self._size


class _FakeHandle:
    def __init__(self, buffered: int, pending: bool = False, reaped: bool = False) -> None:
        self._buffer = _FakeBuffer(buffered)
        self._pending = pending
        self._reaped = reaped

    def _pipe_pending(self) -> bool:
        return self._pending


def _with_live_handles(handles):
    saved = bash._live_handles
    bash._live_handles = set(handles)
    try:
        return bash.live_handle_facts(None)
    finally:
        bash._live_handles = saved


def test_buffered_bytes_is_a_fleet_sum_not_a_subset() -> None:
    # 10 handles x 10 bytes: the <=8-handle subset probe reported 80 and the sum
    # moved with set membership, which the host read as output movement (r35 H-2).
    facts = _with_live_handles([_FakeHandle(10) for _ in range(10)])
    assert facts["handles"] == 10
    assert facts["buffered_bytes"] == 100


def test_pipe_pending_counts_the_whole_fleet() -> None:
    handles = [_FakeHandle(0, pending=i >= 8) for i in range(10)]
    facts = _with_live_handles(handles)
    assert facts["pipe_pending"] == 2


def test_reaped_handles_stay_excluded() -> None:
    handles = [_FakeHandle(5) for _ in range(4)] + [_FakeHandle(5, reaped=True)]
    facts = _with_live_handles(handles)
    assert facts["handles"] == 4
    assert facts["buffered_bytes"] == 20
