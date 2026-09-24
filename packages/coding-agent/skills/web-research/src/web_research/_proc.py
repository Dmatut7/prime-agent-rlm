"""Child processes (curl, playwright install, docker) that never outlive the call that started them.

A cell interrupted with Esc is cancelled while it awaits; a plain `proc.communicate()` then leaves
the child running with nobody reading it (a 95 MB curl download, or `playwright install` with its
Node child). Every child here runs in its own process group, and the whole group is killed on
timeout, on a stall, on cancellation and at interpreter exit.
"""

from __future__ import annotations

import asyncio
import atexit
import os
import signal
import time

_LIVE: set[int] = set()
_TAIL_BYTES = 8192


def _kill_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except (OSError, AttributeError):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


@atexit.register
def _kill_all() -> None:
    for pid in list(_LIVE):
        _kill_group(pid)
    _LIVE.clear()


async def run(
    args: list[str],
    timeout: float,
    *,
    idle_timeout: float | None = None,
    env: dict[str, str] | None = None,
) -> tuple[int, str]:
    """Run args, return (exit code, last ~8 KB of stdout+stderr).

    timeout bounds the whole run; idle_timeout, when given, ends a run that printed nothing for
    that long (a stalled download). Both return code -1 with the reason as output. Cancellation
    and KeyboardInterrupt kill the process group and propagate.
    """
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        stdin=asyncio.subprocess.DEVNULL,
        env=dict(os.environ) if env is None else env,
        start_new_session=True,
    )
    _LIVE.add(proc.pid)
    tail = bytearray()
    started = time.monotonic()
    try:
        assert proc.stdout is not None
        while True:
            left = timeout - (time.monotonic() - started)
            if left <= 0:
                _kill_group(proc.pid)
                return -1, f"timed out after {timeout:.0f}s\n{tail.decode(errors='replace')[-400:]}"
            wait = left if idle_timeout is None else min(left, idle_timeout)
            try:
                chunk = await asyncio.wait_for(proc.stdout.read(4096), timeout=wait)
            except asyncio.TimeoutError:
                if time.monotonic() - started >= timeout:
                    continue  # the loop head reports the overall timeout
                _kill_group(proc.pid)
                return -1, f"no progress for {idle_timeout:.0f}s\n{tail.decode(errors='replace')[-400:]}"
            if not chunk:
                break
            tail.extend(chunk)
            del tail[:-_TAIL_BYTES]
        code = await asyncio.wait_for(proc.wait(), timeout=max(1.0, timeout - (time.monotonic() - started)))
        return code or 0, tail.decode(errors="replace")
    except BaseException:
        _kill_group(proc.pid)
        raise
    finally:
        _LIVE.discard(proc.pid)
