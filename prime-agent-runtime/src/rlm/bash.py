"""Async-by-default shell execution: bash() spawns immediately and returns a live handle."""

from __future__ import annotations

import contextvars
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
from collections import deque
from collections.abc import Callable, Generator
from dataclasses import dataclass
from typing import Any, cast

from . import _winjob

# Boot-lean imports: asyncio, secrets, shutil, datetime, selectors, struct,
# fcntl/termios, and atexit load on first use below so `import rlm` (and with
# it the kernel's pre-ready startup path) stays small. asyncio is bound onto
# this module's globals by BashHandle.__init__ before any code path here can
# touch it; every other user imports inside the function that needs it.

_IS_POSIX = os.name == "posix"

_HEAD_CAP = 512 * 1024
_TAIL_CAP = 3 * 512 * 1024
_READ_CHUNK = 65536
# Fixed child-side fd for the status channel; POSIX shells (notably dash) only
# guarantee single-digit fds in redirection syntax.
_STATUS_FD = 9
_OUTPUT_FD = 8
_COMPLETION_PREFIX = b"\x1eprime-agent-complete:"
_COMPLETION_SUFFIX = b"\x1f"
# Cancelled one-shot awaits: TERM grace before the group KILL, then the bounded
# wait for a confirmed group exit before CancelledError propagates.
_CANCEL_TERM_GRACE = 0.5
_CANCEL_KILL_WAIT = 2.0

_live_handles: set["BashHandle"] = set()
_live_lock = threading.Lock()
_hook_installed = False
_hook_lock = threading.Lock()

# Cell attribution for interrupt kills: repl.py sets the active cell id around
# each execute; asyncio tasks spawned by the cell copy the context and keep the
# attribution, threads start with the None default and stay unattributed.
_current_cell: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "_prime_agent_bash_cell", default=None
)
# Live handles by spawning cell id; an interrupt TERM/KILLs the interrupted
# cell's handles (one-shot parity). Guarded by _live_lock.
_cell_handles: dict[str, set["BashHandle"]] = {}


@dataclass(frozen=True)
class BashResult:
    exit_code: int
    output: str
    duration: float


class _BoundedBuffer:
    """First _HEAD_CAP bytes plus a rolling _TAIL_CAP-byte tail; the middle is dropped."""

    def __init__(self) -> None:
        self._head = bytearray()
        self._tail: deque[bytes] = deque()
        self._tail_size = 0
        self._dropped = 0
        self._lock = threading.Lock()

    def write(self, chunk: bytes) -> None:
        with self._lock:
            if len(self._head) < _HEAD_CAP:
                take = _HEAD_CAP - len(self._head)
                self._head.extend(chunk[:take])
                chunk = chunk[take:]
            if not chunk:
                return
            self._tail.append(chunk)
            self._tail_size += len(chunk)
            # Trim the oldest chunk instead of dropping it whole so exactly _TAIL_CAP bytes stay.
            while self._tail_size > _TAIL_CAP:
                excess = self._tail_size - _TAIL_CAP
                oldest = self._tail[0]
                if len(oldest) <= excess:
                    self._tail.popleft()
                    self._tail_size -= len(oldest)
                    self._dropped += len(oldest)
                else:
                    self._tail[0] = oldest[excess:]
                    self._tail_size -= excess
                    self._dropped += excess

    def size(self) -> int:
        with self._lock:
            return len(self._head) + self._tail_size

    def text(self) -> str:
        with self._lock:
            head = bytes(self._head)
            tail = b"".join(self._tail)
            dropped = self._dropped
        if not dropped:
            return (head + tail).decode("utf-8", errors="replace")
        marker = f"\n... [{dropped} bytes dropped] ...\n"
        return head.decode("utf-8", errors="replace") + marker + tail.decode("utf-8", errors="replace")


class BashHandle:
    """Live handle to a shell command; await it for the BashResult.

    A handle awaited before any other API use (the `await bash(cmd)` one-shot
    form, including `h = bash(cmd)` awaited immediately) owns the command:
    cancelling that await kills the process group. Touching .pid/.running/
    .output()/.tail()/.poll()/.kill() first marks the handle as a background
    handle; later awaits only wait and cancelling them leaves it running.

    Interrupt parity: an interrupt delivered to the spawning cell TERM/KILLs
    every handle that cell created, one-shot and background alike; handles
    created by other cells survive it.
    """

    def __init__(self, command: str) -> None:
        # Every asyncio use in this module runs on a handle path (bash() is the
        # only constructor), so bind the module global here, before
        # _schedule_background_completion_notice or any await can run.
        global asyncio
        import asyncio

        self.command = command
        self._buffer = _BoundedBuffer()
        self._done = threading.Event()
        self._eof = threading.Event()
        self._completion_terminal = threading.Event()
        self._completion_output: str | None = None
        self._completion_lock = threading.Lock()
        self._completion_pending = b""
        self._status: int | None = None
        self._status_known = threading.Event()
        self._reaped = False
        self._result: BashResult | None = None
        self._callbacks: list[Callable[[], None]] = []
        self._callback_lock = threading.Lock()
        # Serializes kill/reap so a pid fallback can never outlive the process handle.
        self._kill_lock = threading.Lock()
        self._started = time.monotonic()
        # POSIX: own process group so kill() signals the whole pipeline; Windows
        # contains the tree in a kill-on-close job object.
        self._status_read = -1
        self._wake_read = -1
        self._wake_write = -1
        # True only while the pump moves a chunk from the pipe into the buffer.
        self._pump_transfer = False
        self._job: int | None = None
        self._completion_marker: bytes | None = None
        status_write = -1
        if _IS_POSIX:
            import secrets

            # Full-duplex status channel: the child end rides in as stdin (fd 0)
            # and the script remaps it to _STATUS_FD before swapping in /dev/null
            # (dash rejects multi-digit fds in redirections at parse time). The
            # parent end doubles as the gate: the child blocks on it until the
            # pid is journaled, so a kernel kill in that window cannot leak an
            # unjournaled command (parent death closes the socket -> child exits).
            parent_sock, child_sock = socket.socketpair()
            self._status_read = parent_sock.detach()
            status_write = child_sock.detach()
            try:
                self._wake_read, self._wake_write = os.pipe()
            except BaseException:
                os.close(self._status_read)
                os.close(status_write)
                raise
            completion_token = secrets.token_hex(32)
            # Halves stop passive echoes; a deliberate forgery freezes only this call while later bytes stay live.
            token_midpoint = len(completion_token) // 2
            self._completion_marker = (
                _COMPLETION_PREFIX + completion_token.encode("ascii") + _COMPLETION_SUFFIX
            )
            script = _status_script(
                _with_prefix(command),
                completion_token[:token_midpoint],
                completion_token[token_midpoint:],
            )
        else:
            # Windows lacks a foreground-status channel, so its exit drain stays best-effort.
            script = _with_prefix(command)
            self._job = _winjob.create_job()
            if self._job is None:
                # Nothing spawned yet, so nothing can leak: refuse to start.
                raise RuntimeError("bash(): Windows job containment could not be established")
        try:
            self._proc: subprocess.Popen[bytes] | _winjob.JobProcess
            if _IS_POSIX:
                self._proc = subprocess.Popen(
                    [_shell(), "-c", script],
                    cwd=os.getcwd(),
                    env=_child_env(),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                    stdin=status_write,
                )
            else:
                self._proc = _winjob.spawn_in_job(
                    self._job, [_shell(), "-c", script], cwd=os.getcwd(), env=_child_env()
                )
        except BaseException:
            for fd in (self._status_read, self._wake_read, self._wake_write):
                if fd >= 0:
                    os.close(fd)
            if self._job is not None:
                job, self._job = self._job, None
                _winjob.close(job)
            raise
        finally:
            if status_write >= 0:
                os.close(status_write)
        self._pid: int = self._proc.pid
        self._released = False
        # The spawning cell (when any) owns this handle for interrupt kills.
        self._cell_id: str | None = _current_cell.get()
        with _live_lock:
            _live_handles.add(self)
            if self._cell_id is not None:
                _cell_handles.setdefault(self._cell_id, set()).add(self)
        enrolled = _record_journal(self._pid, active=True)
        if not enrolled:
            # Fail closed: a configured journal that cannot enroll the pid must
            # not let the command run (the host reaper would never see it).
            self._abort_spawn()
            raise RuntimeError(
                "bash(): orphan-journal enrollment failed (journal configured but the "
                "pid could not be recorded); the spawned process was killed"
            )
        if _IS_POSIX:
            # Journal first, then open the gate: the child does not run the user
            # command until this byte arrives. A failed write means the child
            # already died; the status/EOF paths report that normally.
            try:
                os.write(self._status_read, b"\n")
            except OSError:
                pass
        else:
            # The child is already job-contained and journaled; resume is the
            # last step. A failed resume would strand a permanently suspended
            # child: fail closed via the assigned job.
            if not cast("_winjob.JobProcess", self._proc).resume():
                self._abort_spawn()
                raise RuntimeError("bash(): Windows job containment could not be established")
        threading.Thread(target=self._pump, daemon=True).start()
        threading.Thread(target=self._report, daemon=True).start()
        threading.Thread(target=self._watch, daemon=True).start()

    @property
    def pid(self) -> int:
        self._released = True
        return self._pid

    @property
    def running(self) -> bool:
        # Group liveness, matching kill()'s guard and the journal; poll()/await
        # keep foreground result semantics after `cmd &` returns early.
        self._released = True
        return not self._reaped

    def output(self) -> str:
        self._released = True
        return self._buffer.text()

    def tail(self, n: int = 50) -> str:
        self._released = True
        return "\n".join(self._buffer.text().splitlines()[-n:])

    def poll(self) -> BashResult | None:
        self._released = True
        return self._result if self._done.is_set() else None

    def kill(self, sig: int = signal.SIGTERM, grace: float = 5.0) -> None:
        # Guard on group death, not _done: kill() must still reach a lingering
        # background group after the foreground result was already delivered.
        self._released = True
        if self._reaped:
            return
        if not _IS_POSIX:
            with self._kill_lock:
                if self._reaped:  # re-check: _watch may have reaped while we waited
                    return
                if self._job is not None and _winjob.terminate(self._job):
                    return
                # TerminateJobObject failed or reap raced: taskkill fallback.
                if not _taskkill_tree(self._pid):
                    try:
                        self._proc.kill()
                    except OSError:
                        pass
            return
        _signal_group(self._pid, sig)
        if sig == signal.SIGTERM:
            timer = threading.Timer(grace, self._force_kill)
            timer.daemon = True
            timer.start()

    def _force_kill(self) -> None:
        if not self._reaped:
            _signal_group(self._pid, signal.SIGKILL)

    def _pump(self) -> None:
        import selectors

        stdout = self._proc.stdout
        assert stdout is not None
        if not _IS_POSIX:
            try:
                while chunk := stdout.read1(_READ_CHUNK):
                    self._buffer.write(chunk)
            except (OSError, ValueError):
                pass
            stdout.close()
            self._eof.set()
            return
        fd = stdout.fileno()
        try:
            with selectors.DefaultSelector() as sel:
                sel.register(fd, selectors.EVENT_READ)
                while True:
                    sel.select()
                    self._pump_transfer = True
                    try:
                        chunk = os.read(fd, _READ_CHUNK)
                        if not chunk:
                            break
                        self._consume_output(chunk)
                    finally:
                        self._pump_transfer = False
        except (OSError, ValueError):
            pass
        self._abandon_completion()
        try:
            stdout.close()
        except OSError:
            pass
        self._eof.set()

    def _consume_output(self, chunk: bytes) -> None:
        marker = self._completion_marker
        assert marker is not None
        with self._completion_lock:
            if self._completion_terminal.is_set():
                self._buffer.write(chunk)
                return
            data = self._completion_pending + chunk
            marker_at = data.find(marker)
            if marker_at >= 0:
                self._buffer.write(data[:marker_at])
                self._completion_pending = b""
                self._completion_output = self._buffer.text()
                self._completion_terminal.set()
                self._buffer.write(data[marker_at + len(marker) :])
                return
            retained = 0
            for size in range(min(len(data), len(marker) - 1), 0, -1):
                if data.endswith(marker[:size]):
                    retained = size
                    break
            self._buffer.write(data[:-retained] if retained else data)
            self._completion_pending = data[-retained:] if retained else b""

    def _abandon_completion(self) -> None:
        with self._completion_lock:
            if self._completion_terminal.is_set():
                return
            self._buffer.write(self._completion_pending)
            self._completion_pending = b""
            self._completion_terminal.set()

    def _wait_for_completion(self) -> str | None:
        self._completion_terminal.wait()
        return self._completion_output

    def _report(self) -> None:
        # Finalize at foreground completion (status channel), not EOF, so
        # `cmd &` does not hang the await; the shell then `wait`s for its
        # background jobs, keeping the journaled group identity alive.
        status: int | None = None
        try:
            status = self._read_status()
            # Reserve the delivered status before draining so a shell death during
            # the drain window cannot override it with wait()'s signal exit code.
            with self._callback_lock:
                self._status = status
        finally:
            # _watch blocks on this event without a timeout, so every exit path
            # (parsed status, EOF, garbage, exception) must set it.
            self._status_known.set()
        if status is not None:
            output = self._wait_for_completion()
            if output is None:
                self._drain_grace()
            self._finalize(status, output)

    def _watch(self) -> None:
        # Observe shell death independently of the status socket: an early
        # `exit`/`exec`/`set -e`/fatal signal skips `printf`, and background
        # children can hold the socket open past the shell's lifetime.
        exit_code = self._proc.wait()
        if self._wake_write >= 0:
            # Unblock _read_status: background children can hold the status socket
            # open past the shell's lifetime via bash's saved-fd duplicate.
            try:
                os.write(self._wake_write, b"x")
            except OSError:
                pass
            os.close(self._wake_write)
        # _report always sets _status_known (try/finally), so wait indefinitely:
        # a slow reporter can never lose a delivered status to wait()'s code.
        self._status_known.wait()
        with self._callback_lock:
            delivered = self._status
        if delivered is None and not self._done.is_set():
            self._abandon_completion()
            self._drain_grace()
            self._finalize(exit_code)
        with self._kill_lock:
            delivered = self._reap_group()
            self._reaped = True
            if not _IS_POSIX:
                # Reaped: pid fallbacks are gone, so the handle may finally close.
                cast("_winjob.JobProcess", self._proc).close()
        if delivered:
            _record_journal(self._pid, active=False)
        with _live_lock:
            _live_handles.discard(self)
            self._untrack_cell_handle()

    def _untrack_cell_handle(self) -> None:
        """The caller must hold _live_lock."""
        if self._cell_id is None:
            return
        group = _cell_handles.get(self._cell_id)
        if group is None:
            return
        group.discard(self)
        if not group:
            del _cell_handles[self._cell_id]

    def _reap_group(self) -> bool:
        # Group liveness, not leader death, gates the inactive record: members
        # that outlive the leader would leak behind a stale journal anchor.
        if not _IS_POSIX:
            # Terminate then close the last handle: kill-on-close reaps
            # stragglers. An unproven terminate falls back to taskkill; if
            # that also fails the record stays active for the host reaper.
            delivered = False
            if self._job is not None:
                delivered = _winjob.terminate(self._job)
                job, self._job = self._job, None
                _winjob.close(job)
            return delivered or _taskkill_tree(self._pid)
        try:
            os.killpg(self._pid, 0)
        except ProcessLookupError:
            return True  # group already gone
        except PermissionError:
            pass
        return _signal_group(self._pid, signal.SIGKILL)

    def _read_status(self) -> int | None:
        if self._status_read < 0:
            return None
        import selectors

        try:
            # DefaultSelector (kqueue/epoll) instead of select(): select() rejects
            # fds >= FD_SETSIZE (1024) even when the process fd limit is higher.
            with selectors.DefaultSelector() as sel:
                sel.register(self._status_read, selectors.EVENT_READ)
                sel.register(self._wake_read, selectors.EVENT_READ)
                line = b""
                while b"\n" not in line:
                    ready = {key.fd for key, _ in sel.select()}
                    # Prefer status bytes: any status write happens before shell exit,
                    # so it is already readable whenever the wake fd fires.
                    if self._status_read not in ready:
                        break  # shell died without writing a status
                    chunk = os.read(self._status_read, 64)
                    if not chunk:
                        break  # EOF without a full status line
                    line += chunk
            return int(line)
        except (OSError, ValueError):
            return None
        finally:
            os.close(self._status_read)
            os.close(self._wake_read)

    def _drain_grace(self) -> None:
        # Best-effort fallback when process exit/EOF arrives without a sentinel.
        deadline = time.monotonic() + 0.5
        size = self._buffer.size()
        while time.monotonic() < deadline:
            if self._eof.wait(0.05):
                return
            # A chunk between pipe read and buffer commit (transfer flag) is
            # invisible to both FIONREAD and the buffer size; wait it out.
            if self._pipe_pending() or self._pump_transfer:
                size = self._buffer.size()
                continue
            current = self._buffer.size()
            if current == size:
                return
            size = current

    def _pipe_pending(self) -> bool:
        # POSIX only: FIONREAD on the capture pipe; Windows keeps the
        # quiescence heuristic (best-effort parity).
        if not _IS_POSIX or self._eof.is_set():
            return False
        import fcntl
        import struct
        import termios
        stdout = self._proc.stdout
        if stdout is None:
            return False
        try:
            pending = struct.unpack("i", fcntl.ioctl(stdout.fileno(), termios.FIONREAD, struct.pack("i", 0)))[0]
        except (OSError, ValueError):
            return False
        return pending > 0

    def _finalize(self, exit_code: int, output: str | None = None) -> None:
        with self._callback_lock:
            if self._done.is_set():
                return
            self._result = BashResult(
                exit_code=exit_code,
                output=self._buffer.text() if output is None else output,
                duration=time.monotonic() - self._started,
            )
            self._done.set()
            callbacks = self._callbacks
            self._callbacks = []
        for callback in callbacks:
            callback()

    def _add_done_callback(self, callback: Callable[[], None]) -> None:
        with self._callback_lock:
            if not self._done.is_set():
                self._callbacks.append(callback)
                return
        callback()

    async def _wait(self) -> BashResult:
        # Asyncio-native wakeup: no executor thread is parked for the command's
        # duration, so many concurrent awaits cannot exhaust the default pool.
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[None] = loop.create_future()

        def _wake() -> None:
            try:
                loop.call_soon_threadsafe(lambda: fut.done() or fut.set_result(None))
            except RuntimeError:
                pass  # awaiting loop already closed

        self._add_done_callback(_wake)
        await fut
        assert self._result is not None
        return self._result

    async def _wait_owned(self) -> BashResult:
        # One-shot `await bash(cmd)` owns the process: a cancelled await (e.g.
        # a kernel interrupt) must not leave the command running. TERM, bounded
        # grace, group KILL, then a bounded confirmed-exit wait before the
        # CancelledError propagates, so no side effect can land after it.
        try:
            return await self._wait()
        except asyncio.CancelledError:
            # Signal synchronously first: even if the cleanup awaits below are
            # re-cancelled, TERM is already delivered and the escalation timer
            # armed. The confirm wait runs as a shielded task so repeated
            # cancels of this task cannot skip it (they re-raise into awaits
            # inside this except block); the loop re-awaits until it finishes
            # (the confirm coroutine itself is bounded).
            self.kill(grace=_CANCEL_TERM_GRACE)
            confirm = asyncio.ensure_future(self._confirm_group_exit())
            while not confirm.done():
                try:
                    await asyncio.shield(confirm)
                except asyncio.CancelledError:
                    continue
            raise

    async def _confirm_group_exit(self) -> None:
        if not await self._await_group_death(_CANCEL_TERM_GRACE):
            if _IS_POSIX:
                _signal_group(self._pid, signal.SIGKILL)
            else:
                # kill() holds the escalation lock; to_thread keeps the loop free.
                await asyncio.to_thread(self.kill)
            await self._await_group_death(_CANCEL_KILL_WAIT)

    def _group_alive(self) -> bool:
        if not _IS_POSIX:
            job = self._job  # snapshot: _watch may clear it concurrently
            if job is not None:
                # Job accounting sees detached descendants a dead leader hides.
                empty = _winjob.is_empty(job)
                if empty is not None:
                    return not empty
            return self._proc.poll() is None
        try:
            os.killpg(self._pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            pass
        return True

    async def _await_group_death(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while self._group_alive():
            if time.monotonic() >= deadline:
                return False
            await asyncio.sleep(0.02)
        return True

    def _abort_spawn(self) -> None:
        # Enrollment or containment failed before the gate opened (POSIX) or
        # while the child is still suspended, before resume (Windows): kill
        # the child and unwind the handle before threads start.
        if _IS_POSIX:
            for fd in (self._status_read, self._wake_read, self._wake_write):
                if fd >= 0:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            self._status_read = self._wake_read = self._wake_write = -1
            delivered = _signal_group(self._pid, signal.SIGKILL)
        else:
            with self._kill_lock:
                delivered = False
                if self._job is not None:
                    delivered = _winjob.terminate(self._job)
                    job, self._job = self._job, None
                    _winjob.close(job)
                if not delivered:
                    # Pre-resume abort: the never-run leader has no descendants, so a
                    # delivered kill retires the journal record.
                    try:
                        self._proc.kill()
                        delivered = True
                    except OSError:
                        pass
        if self._proc.stdout is not None:
            self._proc.stdout.close()
        # The blocking wait stays outside the lock: hProcess is still open, so a
        # concurrent raw-pid fallback stays pinned to the right process.
        try:
            self._proc.wait(timeout=5)
        except (OSError, subprocess.SubprocessError):
            pass
        with self._kill_lock:
            self._reaped = True
            if not _IS_POSIX:
                # Reaped commits before close: later lock holders skip raw-pid fallbacks.
                cast("_winjob.JobProcess", self._proc).close()
        with _live_lock:
            _live_handles.discard(self)
            self._untrack_cell_handle()
        if delivered:
            _record_journal(self._pid, active=False)

    def __await__(self) -> Generator[Any, None, BashResult]:
        # A handle awaited before any other API use is a one-shot command tied
        # to the await (kill-on-cancel); touching the handle API first marks it
        # as a deliberate background handle whose awaits only wait.
        if self._released:
            return self._wait().__await__()
        self._released = True
        return self._wait_owned().__await__()

    def __repr__(self) -> str:
        state = f"exit_code={self._result.exit_code}" if self._result else "running"
        return f"<BashHandle pid={self._pid} {state} command={self.command!r}>"


# ---------------------------------------------------------------------------
# Destructive-git dirty-tree guard (Python-face port of the TS guard,
# b0aeef69a / upstream PrimeIntellect-ai/prime-agent#2275).
#
# The kernel's bash() is the shell the model actually drives, and the TS-face
# guard cannot reach it. Matcher semantics are shared with the TS face; the
# probe-target scope is a documented subset:
#
# Two mode groups, both ported from the TS face: destructive discards
# (checkout / restore / reset --hard / clean -f, b0aeef69a) and
# shared-worktree sweeps (git add -A / git add . / git stash, 15437361f), which
# do not delete work themselves but sweep other lanes' uncommitted changes
# into one index or stash on a shared worktree. Both groups share the probe,
# the bypass and the fail-open scope below.
#
# Covered: direct discard forms plus `git -C <dir>` (plain paths, repeated -C
# included) and wrapper/env-assignment prefixes that do not relocate the
# repository (sudo, env, path-qualified, NAME=value).
# Beyond the scope the guard FAILS OPEN - the command runs unchecked - rather
# than guessing at or blocking the target: cd/pushd chains, GIT_DIR=/GIT_WORK
# _TREE= assignment prefixes, --git-dir/--work-tree/--prefix or core.worktree
# /core.bare relocators, quoted or substituted -C paths, and a configured
# PRIME_AGENT_BASH_COMMAND_PREFIX (the TS face replays cd chains and refuses
# relocations it cannot replay; porting that machinery is future work).
# A second, deliberate delta: this face has no per-command timeout, so the
# probe carries its own bound instead of the guarded command's effective
# timeout; a probe that exceeds it fails open like any other probe failure.
#
# Bypass: only the kernel process env below. There is no parameter bypass on
# this face, and an inline `PI_BASH_ALLOW_DESTRUCTIVE_GIT=1 git ...` prefix
# sets the variable only in the child shell, so it does not bypass either.

# Bypass env var for the destructive-git dirty-tree guard; mirrors the TS face.
BASH_DESTRUCTIVE_GIT_BYPASS_ENV = "PI_BASH_ALLOW_DESTRUCTIVE_GIT"

# The probe is a synchronous subprocess on the bash() spawn path (like
# _process_start_id's `ps` call), runs only when a command matches a discard
# pattern, and must never wedge the REPL for long.
_PROBE_TIMEOUT_SECONDS = 10.0

# How many dirty paths the refusal lists before eliding the rest.
_MAX_DIRTY_PATHS_LISTED = 10

_GIT_STATUS_ARGS = ("status", "--porcelain", "--untracked-files=all")


class DestructiveGitRefusalError(RuntimeError):
    """A destructive git discard was refused because the target tree is dirty."""


# Optional git global options between `git` and the subcommand, for example
# `git -C dir reset --hard` or `git -c key=value checkout -- .`; kept within
# one shell segment (no ;&|) so it cannot swallow a chained command.
_GIT_GLOBAL_OPTIONS = r"(?:-{1,2}[^\s;&|]+(?:\s+(?:\"[^\"]*\"|'[^']*'|[^\s;&|]+))?\s+)*"

_DISCARD_CHECKOUT_PATTERN = re.compile(
    r"\bgit\s+" + _GIT_GLOBAL_OPTIONS + r"checkout\s+"
    r"(?:(?:(?:-[fm]|--ours|--theirs|--conflict=\S+)\s+)*(?:--\s+)?(?:\./?|:/)"
    r"|[^\s;&|()]+\s+(?:--\s+)?(?:\./?|:/)"
    r"|(?:-f|--force)\s+[^\s;&|()]+)"
    r"(?=\s|$|[;&|)])"
)
_DISCARD_RESTORE_PATTERN = re.compile(
    r"\bgit\s+" + _GIT_GLOBAL_OPTIONS + r"restore\s+"
    r"(?:(?:--source|--worktree)(?:=\S+)?\s+|-s(?:\s+\S+|[^\s]+)\s+|-W\s+|--\s+)?"
    r"(?:\./?|:/)(?=\s|$|[;&|)])"
)
_DISCARD_RESET_PATTERN = re.compile(
    r"\bgit\s+" + _GIT_GLOBAL_OPTIONS + r"reset\s+(?:(?:-[^\s;&|]+)\s+)*--hard\b"
)
_DISCARD_CLEAN_PATTERN = re.compile(r"\bgit\s+" + _GIT_GLOBAL_OPTIONS + r"clean\s+([^;&|]*)")

# Sweep family: commands that stage or stash the whole shared worktree
# (git add -A / git add . / git stash). Port of the TS face's second mode group
# (15437361f); see the guard section comment for why they are refused.
_SWEEP_ADD_PATTERN = re.compile(r"\bgit\s+" + _GIT_GLOBAL_OPTIONS + r"add\s+([^;&|]*)")
_SWEEP_STASH_PATTERN = re.compile(
    r"\bgit\s+" + _GIT_GLOBAL_OPTIONS + r"stash(?=\s|$|[;&|)])(?:\s+([^;&|]*))?"
)

# Command segments before the git token, and the wrappers that cannot change
# directory or select another repository.
_PREFIX_SEPARATORS = re.compile(r"&&|\|\||;|\||\n")
_CD_PATTERN = re.compile(r"\b(?:cd|pushd)\b")
_WRAPPER_TOKENS = frozenset({"sudo", "env", "command", "builtin"})
_ENV_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_RELOCATING_ASSIGNMENTS = ("GIT_DIR=", "GIT_WORK_TREE=")
_RELOCATING_GLOBAL_OPTIONS = ("--git-dir", "--work-tree", "--prefix")
_RELOCATING_CONFIGS = ("core.worktree", "core.bare")
_UNSAFE_DASH_C_CHARS = set("\"'\\$`")
_GIT_SUBCOMMANDS = frozenset({"reset", "checkout", "clean", "restore", "add", "stash"})
# git add options that stage the whole worktree unless a non-root pathspec
# narrows them (git add -A docs/ stays scoped).
_SWEEP_ADD_ALL_OPTIONS = frozenset({"-A", "--all", "--no-ignore-removal"})
_ROOT_PATHSPECS = frozenset({".", "./", ":/"})
# git stash subcommands that push a stash; every other subcommand
# (list/show/pop/apply/drop/clear/branch/create/store) and the help flags do
# not sweep the worktree into one.
_SWEEP_STASH_SUBCOMMANDS = frozenset({"push", "save"})


def _is_forced_clean_segment(args: str) -> bool:
    tokens = [token for token in args.split() if token]
    # Everything after -- is a pathspec, not an option (git clean -f -- -n is
    # forced: -n names a file there).
    option_end = tokens.index("--") if "--" in tokens else -1
    option_tokens = tokens if option_end == -1 else tokens[:option_end]
    forces = []
    for token in option_tokens:
        # Long form: --force...; short form: any -f... flag cluster.
        forced = token.startswith("--force") if token.startswith("--") else token.startswith("-") and "f" in token
        if forced:
            forces.append(token)
    if not forces:
        return False
    return not any(
        token == "--dry-run" or (token.startswith("-") and not token.startswith("--") and "n" in token)
        for token in option_tokens
    )


def _is_sweep_add_segment(args: str) -> bool:
    tokens = [token for token in args.split() if token]
    # Everything after -- is a pathspec, not an option.
    option_end = tokens.index("--") if "--" in tokens else -1
    options = tokens if option_end == -1 else tokens[:option_end]
    pathspec = [] if option_end == -1 else tokens[option_end + 1 :]
    has_all = False
    has_pathspec = bool(pathspec)
    for token in options:
        if token in _SWEEP_ADD_ALL_OPTIONS:
            has_all = True
        elif token.startswith("-"):
            continue  # other options do not widen the staged set
        else:
            has_pathspec = True  # a bare pathspec token
            if token in _ROOT_PATHSPECS:
                return True
    if any(token in _ROOT_PATHSPECS for token in pathspec):
        return True
    # -A with an explicit non-root pathspec stays scoped (git add -A docs/).
    return has_all and not has_pathspec


def _is_sweep_stash_segment(args: str | None) -> bool:
    tokens = [token for token in (args or "").split() if token]
    if not tokens:
        return True  # bare `git stash` pushes
    return tokens[0] in _SWEEP_STASH_SUBCOMMANDS


def _mask_quoted_spans(command: str) -> str:
    """Blank characters inside quotes/comments so discard matching cannot fire
    on quoted data (for example `echo 'git reset --hard'`).

    Positions stay identical to the original string, so match indices remain
    valid. Command substitution (``$(...)``, backticks) inside double quotes
    stays live because it executes. Port of the TS maskQuotedSpans.
    """
    if not any(ch in command for ch in "\"'#"):
        return command
    chars = list(command)
    quote: str | None = None
    i = 0
    n = len(chars)
    while i < n:
        ch = chars[i]
        if quote is None:
            prev = chars[i - 1] if i > 0 else None
            if ch == "#" and (prev is None or prev.isspace() or prev in ";&|(){}"):
                # An unquoted # at a word boundary starts a comment.
                while i < n and chars[i] != "\n":
                    chars[i] = " "
                    i += 1
                continue
            if ch in "\"'":
                quote = ch
        elif quote == "'":
            # No expansion happens inside single quotes; mask it all.
            if ch == "'":
                quote = None
            else:
                chars[i] = " "
        elif quote == '"':
            if ch == '"':
                quote = None
            elif ch == "\\" and i + 1 < n:
                chars[i] = " "
                chars[i + 1] = " "
                i += 1
            elif ch == "$" and i + 1 < n and chars[i + 1] == "(":
                # Command substitution inside double quotes still executes.
                depth = 0
                j = i
                while j < n:
                    if chars[j] == "(":
                        depth += 1
                    elif chars[j] == ")":
                        depth -= 1
                        if depth == 0:
                            break
                    j += 1
                i = j - 1
            elif ch == "`":
                j = i + 1
                while j < n and chars[j] != "`":
                    j += 1
                i = j - 1
            else:
                chars[i] = " "
        i += 1
    return "".join(chars)


def _find_destructive_git_discard_commands(command: str) -> list[int]:
    """Match starts of every destructive git discard or shared-worktree sweep in
    `command` (empty when none match). Best-effort shell-text heuristics, not a
    parse; a false positive costs one `git status` probe, a false negative
    silently loses work."""
    masked = _mask_quoted_spans(command)
    indices: list[int] = []
    for pattern in (_DISCARD_CHECKOUT_PATTERN, _DISCARD_RESTORE_PATTERN, _DISCARD_RESET_PATTERN):
        indices.extend(match.start() for match in pattern.finditer(masked))
    for match in _DISCARD_CLEAN_PATTERN.finditer(masked):
        if _is_forced_clean_segment(match.group(1)):
            indices.append(match.start())
    for match in _SWEEP_ADD_PATTERN.finditer(masked):
        if _is_sweep_add_segment(match.group(1)):
            indices.append(match.start())
    for match in _SWEEP_STASH_PATTERN.finditer(masked):
        if _is_sweep_stash_segment(match.group(1)):
            indices.append(match.start())
    return sorted(indices)


def _resolve_discard_probe(command: str, discard_index: int) -> tuple[list[str], bool] | None:
    """Map the discard at `discard_index` to its probe spec.

    Returns ``(git argv prefix, includes_ignored)`` - for example
    ``(["-C", "sub"], False)`` - or None when the target repository cannot be
    resolved within this face's covered scope and the guard must fail open.
    """
    prefix = command[:discard_index]
    if _CD_PATTERN.search(_mask_quoted_spans(prefix)):
        return None  # cd/pushd chains relocate; not replayed on this face
    # Tokens directly before the git token: wrappers are safe, env
    # assignments only relocate for GIT_DIR/GIT_WORK_TREE, anything else
    # (time, escaped or aliased commands) is out of scope.
    last_segment = _PREFIX_SEPARATORS.split(prefix)[-1] if prefix else ""
    for token in last_segment.split():
        if token in _WRAPPER_TOKENS or token.endswith("/"):
            continue
        if _ENV_ASSIGNMENT.match(token):
            if token.startswith(_RELOCATING_ASSIGNMENTS):
                return None
            continue
        return None
    tokens = command[discard_index:].split()
    git_args: list[str] = []
    includes_ignored = False
    subcommand: str | None = None
    i = 1
    while i < len(tokens):
        token = tokens[i]
        if subcommand is None:
            if token in _GIT_SUBCOMMANDS:
                subcommand = token
            elif token == "-C":
                i += 1
                if i >= len(tokens):
                    return None
                directory = tokens[i]
                # A quoted, escaped, or substituted path cannot be replayed as
                # a single token; out of scope rather than probing a partial
                # directory.
                if any(ch in directory for ch in _UNSAFE_DASH_C_CHARS):
                    return None
                git_args.extend(["-C", directory])
            elif token.startswith(_RELOCATING_GLOBAL_OPTIONS):
                return None
            elif token == "-c":
                i += 1
                if i >= len(tokens):
                    return None
                config = tokens[i]
                if config.startswith(_RELOCATING_CONFIGS):
                    return None
        elif subcommand == "clean":
            if token == "--":
                break  # everything after -- is a pathspec
            if token.startswith("--"):
                i += 1
                continue
            if token.startswith("-") and ("x" in token or "X" in token):
                includes_ignored = True  # git clean -x/-X also deletes ignored files
                break
        i += 1
    return git_args, includes_ignored


def _is_truthy_env(value: str | None) -> bool:
    return value is not None and value not in ("", "0")


def _probe_uncommitted_changes(git_args: list[str], includes_ignored: bool) -> list[str] | None:
    """Dirty paths in the repository the discard targets, or None when
    dirtiness cannot be determined (git missing, not a repository, probe error
    or timeout): the guard fails open instead of blocking on a guess."""
    argv = ["git", *git_args, *_GIT_STATUS_ARGS]
    if includes_ignored:
        argv.append("--ignored=matching")
    try:
        proc = subprocess.run(
            argv,
            cwd=os.getcwd(),
            env=_child_env(),
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=_PROBE_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return [line.rstrip("\r") for line in proc.stdout.split("\n") if line.strip()]


def _format_dirty_tree_refusal(dirty_paths: list[str], includes_ignored: bool = False) -> str:
    listed = dirty_paths[:_MAX_DIRTY_PATHS_LISTED]
    elided = len(dirty_paths) - len(listed)
    noun = "uncommitted or ignored file(s)" if includes_ignored else "uncommitted change(s)"
    lines = [
        f"Refusing to run this destructive git command: the working tree has {len(dirty_paths)} {noun}.",
        *(f"  {line}" for line in listed),
    ]
    if elided > 0:
        lines.append(f"  ... and {elided} more")
    lines.append("")
    lines.append("Commit, stash, or stage your work first.")
    lines.append(
        "To discard these changes intentionally, set "
        f"{BASH_DESTRUCTIVE_GIT_BYPASS_ENV}=1 in the kernel environment and retry."
    )
    return "\n".join(lines)


def _guard_destructive_git(command: str) -> None:
    """Refuse destructive git discards while the tree they target is dirty.

    Raises DestructiveGitRefusalError listing the at-risk paths; returns
    (fails open) on the env bypass and whenever the target cannot be probed
    within the covered scope. The match is string-only and the probe runs only
    on a match, so clean commands pay one regex pass.
    """
    if _is_truthy_env(os.environ.get(BASH_DESTRUCTIVE_GIT_BYPASS_ENV)):
        return
    # A configured command prefix runs before every command and may relocate
    # the discard (for example a sandbox cd); this face does not replay it.
    if os.environ.get("PRIME_AGENT_BASH_COMMAND_PREFIX"):
        return
    indices = _find_destructive_git_discard_commands(command)
    if not indices:
        return
    probed: set[tuple[tuple[str, ...], bool]] = set()
    for index in indices:
        spec = _resolve_discard_probe(command, index)
        if spec is None:
            continue  # out of the covered scope: fail open
        git_args, includes_ignored = spec
        key = (tuple(git_args), includes_ignored)
        if key in probed:
            continue
        probed.add(key)
        dirty_paths = _probe_uncommitted_changes(git_args, includes_ignored)
        if dirty_paths:
            raise DestructiveGitRefusalError(_format_dirty_tree_refusal(dirty_paths, includes_ignored))


def bash(command: str) -> BashHandle:
    """Start a shell command immediately; await the handle for the result.

    `await bash(cmd)` is a one-shot: cancelling the await (e.g. an interrupt)
    kills the command's process group. `h = bash(cmd)` used as a background
    handle (any .pid/.running/.output()/.tail()/.poll()/.kill() access before
    the first await) survives cancelling its own awaits; awaiting it only
    waits. Either way, an interrupt delivered to the cell that spawned the
    handle kills that cell's handles; handles from other cells are untouched.
    Leak containment is per-platform: process groups plus the orphan journal on
    POSIX; a kill-on-close job object on Windows entered while the child is
    still suspended, so no descendant can escape it and kill()/crash cleanup
    are unconditional -- bash() raises if containment cannot be established.
    Output written after the completion fence (e.g. by an EXIT trap or a
    background job) is not in BashResult.output but stays visible via
    handle.output()/tail().
    Environment: children run on a child-safe whitelist of the kernel env
    (plus NO_COLOR/TERM=dumb), not on os.environ - a variable set in the REPL
    reaches Python subprocesses but is silently dropped here. Set a value for
    one command as a shell prefix (`bash('VAR=value cmd')`), or list names in
    os.environ['PRIME_AGENT_ENV_PASSTHROUGH'] before the call to pass them
    through.
    Guard: destructive git discards (git checkout -- ., git clean -f...,
    git reset --hard, git restore .) and shared-worktree sweeps (git add -A,
    git add ., git stash), with git -C, are refused with the dirty paths while
    the tree they target has uncommitted changes; scoped forms (git add
    docs/, git add <paths>) run, and setting PI_BASH_ALLOW_DESTRUCTIVE_GIT=1
    in the kernel environment bypasses intentionally. Fails open outside a
    repository and beyond the covered probe scope (cd chains, GIT_DIR
    prefixes); see the guard section above.
    """
    if not isinstance(command, str) or not command:
        raise TypeError("command must be a non-empty str")
    _guard_destructive_git(command)
    _install_shutdown_hook()
    return BashHandle(command)


def _shell() -> str:
    import shutil

    # Read per call so env changes made in the REPL apply to later commands.
    override = os.environ.get("PRIME_AGENT_BASH_SHELL")
    if override:
        if not os.path.isabs(override):
            raise ValueError("PRIME_AGENT_BASH_SHELL must be an absolute path")
        return override
    if not _IS_POSIX:
        # Never consult PATH on Windows: a repo-controlled PATH could supply
        # the shell. The host injects PRIME_AGENT_BASH_SHELL when one exists.
        raise RuntimeError(
            "bash() needs PRIME_AGENT_BASH_SHELL set to the absolute path of a "
            "POSIX shell on Windows (e.g. install Git Bash in its default "
            "location so the host injects it)"
        )
    # PATH fallback only serves bare/standalone POSIX runtime use: the host
    # always injects PRIME_AGENT_BASH_SHELL (an absolute path) when a shell exists.
    shell = shutil.which("bash")
    return shell or "/bin/sh"


def _with_prefix(command: str) -> str:
    prefix = os.environ.get("PRIME_AGENT_BASH_COMMAND_PREFIX")
    return f"{prefix}\n{command}" if prefix else command


def _fence_printf() -> str:
    import shutil

    # `\command -p printf` defeats alias expansion but not a user-defined shell
    # function named `command`, which would swallow both fence frames and leave
    # the await hanging until the shell dies (wedged behind background jobs). A
    # slash-qualified command name bypasses function and alias lookup for
    # ordinary command names, so resolve printf on the system default utility PATH.
    path = shutil.which("printf", path=os.confstr("CS_PATH") or os.defpath)
    if path and "'" not in path:
        return f"'{path}'"
    return "\\command -p printf"


def _status_script(command: str, completion_a: str, completion_b: str) -> str:
    # Closed control fds preserve background behavior; supported shells atomically write the frame.
    emit = _fence_printf()
    return (
        f"exec {_STATUS_FD}>&0 {_OUTPUT_FD}>&1 0</dev/null\n"
        f"read -r _prime_agent_gate <&{_STATUS_FD} || exit 127\n"
        "{\n"
        f"{command}\n"
        f"}} {_OUTPUT_FD}>&- {_STATUS_FD}>&-\n"
        "__prime_status=$?\n"
        "\\set +x\n"
        f"{emit} '\\036prime-agent-complete:%s%s\\037' "
        f"'{completion_a}' '{completion_b}' >&{_OUTPUT_FD} || exit \"$__prime_status\"\n"
        f"{emit} '%s\\n' \"$__prime_status\" >&{_STATUS_FD}\n"
        f"exec {_OUTPUT_FD}>&- {_STATUS_FD}>&-\n"
        "wait\n"
        'exit "$__prime_status"\n'
    )


# bash()/helper children run model-authored shell code, so their env is an
# allowlist rather than an inheritance of the kernel env: the worker auth token
# (PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN), recursion bookkeeping (RLM_*),
# provider credentials injected for in-kernel skills (SERPER_API_KEY,
# ANTHROPIC_*, ...) and the user's agent sockets (SSH_AUTH_SOCK) must not reach
# arbitrary commands. Mirrors rlm.mcp._SAFE_ENV; PRIME_AGENT_ENV_PASSTHROUGH
# (comma-separated names) opts specific variables back in for commands that
# genuinely need them.
#
# The agent's own CLI also travels through this channel (self-update, nested
# prime-agent runs), so the non-secret routing and opt-out names that CLI reads
# are forwarded: the update routing pair (supervisor socket path, origin session
# id - paths and ids, never the worker token), the agentDir/sessionDir pins and
# supervisor registry dir, and the documented privacy opt-outs
# (DO_NOT_TRACK/PI_OFFLINE/PRIME_AGENT_TELEMETRY - losing them would silently
# undo the offline/telemetry switches for nested runs). Keep the host table
# (packages/coding-agent/src/utils/shell.ts SHELL_CHILD_SAFE_ENV_KEYS) in sync.
_CHILD_SAFE_ENV = (
    "HOME",
    "PATH",
    "SHELL",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "OS",
    "SYSTEMDRIVE",
    "USERPROFILE",
    # Non-secret routing/opt-out names for the agent's own CLI (see above).
    "PRIME_AGENT_CODING_AGENT_DIR",
    "PRIME_AGENT_SESSION_DIR",
    "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET",
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID",
    "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR",
    "DO_NOT_TRACK",
    "PI_OFFLINE",
    "PRIME_AGENT_TELEMETRY",
    "PRIME_AGENT_TRUSTED_UPDATE_ORIGINS",
)
_ENV_PASSTHROUGH_VAR = "PRIME_AGENT_ENV_PASSTHROUGH"


def _passthrough_env() -> dict[str, str]:
    passthrough: dict[str, str] = {}
    for name in os.environ.get(_ENV_PASSTHROUGH_VAR, "").split(","):
        name = name.strip()
        value = os.environ.get(name) if name else None
        if value is not None:
            passthrough[name] = value
    return passthrough


def _child_env() -> dict[str, str]:
    """Environment for kernel-spawned shell commands.

    Same non-interactive guard as the host shell env
    (packages/coding-agent/src/utils/shell.ts sanitizedChildEnv, which also
    feeds getShellEnv): agent shell commands have no usable stdin, so
    interactive prompts (git commit without -m opening $EDITOR, credential
    asks, pagers) can only hang. Fail fast or no-op instead. Deliberately
    overrides inherited terminal settings - a passthrough EDITOR=vim is
    exactly the hang this prevents; a per-command inline assignment
    (`GIT_EDITOR=vim git commit`) still wins because it replaces the
    exported value for that command.
    """
    env = {key: value for key in _CHILD_SAFE_ENV if (value := os.environ.get(key)) is not None}
    env.update(_passthrough_env())
    env.update(
        {
            "NO_COLOR": "1",
            "TERM": "dumb",
            "CLICOLOR": "0",
            "FORCE_COLOR": "0",
            "GIT_EDITOR": "true",
            "GIT_SEQUENCE_EDITOR": "true",
            "GIT_TERMINAL_PROMPTS": "0",
            "GIT_ASKPASS": "true",
            "SSH_ASKPASS_REQUIRE": "never",
            "EDITOR": "true",
            "VISUAL": "true",
            "PAGER": "cat",
            "GIT_PAGER": "cat",
            "DEBIAN_FRONTEND": "noninteractive",
        }
    )
    return env


def _signal_group(pid: int, sig: int) -> bool:
    """True when the signal was delivered or the group is already gone."""
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        return True  # already dead: safe to mark the journal record inactive
    except OSError:
        return False  # not delivered: the record must stay active for the host reaper
    return True


def _system32(*parts: str) -> str:
    # Absolute paths for Windows helper binaries: PATH (and CWD on Windows
    # CPython) lookup could resolve a planted taskkill.exe/powershell.exe.
    root = os.environ.get("SystemRoot", r"C:\Windows")
    return os.path.join(root, "System32", *parts)


def _helper_env() -> dict[str, str]:
    return {**_child_env(), "NoDefaultCurrentDirectoryInExePath": "1"}


def _ps_env() -> dict[str, str]:
    # `lstart` is rendered in the subprocess timezone and locale, and the host
    # recomputes this same identity with both pinned to C/UTC (session-lease.ts
    # psStartIdQuery). An unpinned render never compares equal on a non-UTC or
    # non-C host, so identity-verified reaping would refuse to fire.
    return {**_child_env(), "LC_ALL": "C", "LC_TIME": "C", "LANG": "C", "TZ": "UTC"}


def _taskkill_tree(pid: int) -> bool:
    # Windows has no process groups to signal; taskkill /T kills the whole tree.
    try:
        return (
            subprocess.run(
                [_system32("taskkill.exe"), "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                timeout=10,
                env=_helper_env(),
            ).returncode
            == 0
        )
    except (OSError, subprocess.SubprocessError):
        return False


def _process_start_id(pid: int) -> str | None:
    if os.name == "nt":
        # Mirrors getWindowsProcessStartId in session-lease.ts byte-for-byte so
        # the host's identity comparison matches the journaled string.
        try:
            out = subprocess.run(
                [
                    _system32("WindowsPowerShell", "v1.0", "powershell.exe"),
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    f"([System.Diagnostics.Process]::GetProcessById({pid})).StartTime.ToUniversalTime().Ticks",
                ],
                capture_output=True,
                text=True,
                timeout=5,
                env=_helper_env(),
            ).stdout.strip()
            return f"win:{out}" if out.isdigit() else None
        except (OSError, subprocess.SubprocessError):
            return None
    try:
        with open(f"/proc/{pid}/stat", "r") as f:
            stat = f.read()
        fields = stat[stat.rindex(")") + 2 :].split(" ")
        if len(fields) > 19 and fields[19]:
            return f"proc:{fields[19]}"
    except (OSError, ValueError):
        pass
    try:
        # macOS has no /proc; /bin/ps is always present there, so use the
        # absolute path (bare `ps` stays only as the exotic-POSIX last resort).
        ps = "/bin/ps" if sys.platform == "darwin" else "ps"
        out = subprocess.run(
            [ps, "-p", str(pid), "-o", "lstart="],
            capture_output=True,
            text=True,
            timeout=5,
            env=_ps_env(),
        ).stdout.strip()
        return f"ps:{out}" if out else None
    except (OSError, subprocess.SubprocessError):
        return None


# Journal durability: an appended record is visible to the host reaper as soon as
# the write returns, and it outlives this kernel's death because the page cache
# belongs to the OS -- so the fsync wait, not the write, is what leaves the spawn
# path. The only durability it adds is against machine power loss, where no
# orphan can survive to be reaped either. One shared flusher coalesces a burst of
# appends into a single fsync.
_journal_dirty = threading.Event()
_journal_flusher: threading.Thread | None = None
_journal_flusher_lock = threading.Lock()


def _fsync_journal() -> None:
    """Best-effort durability flush; the record is already readable without it."""
    path = os.environ.get("PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL")
    if not path:
        return
    try:
        fd = os.open(path, os.O_WRONLY)
    except OSError:
        return  # cleared or unwritable in the meantime: nothing left to flush
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _journal_flush_loop() -> None:
    while True:
        _journal_dirty.wait()
        _journal_dirty.clear()
        _fsync_journal()


def _queue_journal_fsync() -> None:
    global _journal_flusher
    _journal_dirty.set()
    with _journal_flusher_lock:
        if _journal_flusher is not None and _journal_flusher.is_alive():
            return
        flusher = threading.Thread(
            target=_journal_flush_loop, name="rlm-journal-fsync", daemon=True
        )
        try:
            flusher.start()
        except RuntimeError:
            # No thread available: keep the wait on the caller instead of dropping it.
            _journal_dirty.clear()
            _fsync_journal()
            return
        _journal_flusher = flusher


def _record_journal(pid: int, active: bool) -> bool:
    # Returns False only when the journal is configured but enrollment failed;
    # active-record callers must then fail closed. Active records always carry
    # a processStartId so host reaping stays identity-verified.
    from datetime import datetime, timezone

    path = os.environ.get("PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL")
    owner = os.environ.get("PRIME_AGENT_KERNEL_OWNER_PID")
    if not path or not owner:
        return True
    try:
        owner_pid = int(owner)
    except ValueError:
        return False
    start_id = _process_start_id(pid) if active else None
    if active and start_id is None:
        return False
    record: dict[str, Any] = {
        "version": 1,
        "pid": pid,
        "ownerPid": owner_pid,
        # The host reaps bash children per kernel pid when it kills or loses this kernel.
        "kernelPid": os.getpid(),
        **({"processStartId": start_id} if start_id else {}),
        "active": active,
        "recordedAt": datetime.now(timezone.utc).isoformat(),
    }
    data = (json.dumps(record) + "\n").encode()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            # Complete-write loop: a short write would leave a truncated JSON
            # line that the host discards, which must count as failure.
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    return False
                view = view[written:]
        finally:
            os.close(fd)
    except OSError:
        return False
    # The append is what the host reaper reads and what every fail-closed
    # condition (unwritable path, no space, short write) reports through, so it
    # stays on the calling thread; only the durability wait moves off it.
    _queue_journal_fsync()
    return True


def _set_current_cell(cell_id: str | None) -> contextvars.Token:
    """repl.py hook: attribute handles spawned while this cell executes."""
    return _current_cell.set(cell_id)


def _reset_current_cell(token: contextvars.Token) -> None:
    _current_cell.reset(token)


def _kill_cell_handles(cell_id: str) -> None:
    """TERM (escalating to KILL) every live handle spawned by one cell.

    The runtime calls this when an interrupt lands on that cell, matching
    one-shot cancellation semantics: an interrupted cell must not leave its
    commands running. Handles from other cells are untouched.
    """
    with _live_lock:
        handles = list(_cell_handles.get(cell_id, ()))
    for handle in handles:
        try:
            handle.kill(signal.SIGTERM, grace=_CANCEL_TERM_GRACE)
        except Exception:  # noqa: BLE001 - one broken handle must not shield the rest
            pass


def _forget_cell(cell_id: str) -> None:
    """Drop per-cell bookkeeping when the request finishes.

    The handles themselves keep running as background handles; they only stop
    being killable by interrupts that target the finished cell.
    """
    with _live_lock:
        _cell_handles.pop(cell_id, None)


def _kill_live_handles() -> None:
    with _live_lock:
        handles = list(_live_handles)
    for handle in handles:
        if _IS_POSIX:
            delivered = _signal_group(handle._pid, signal.SIGKILL)
        else:
            with handle._kill_lock:
                if handle._reaped:
                    continue
                delivered = handle._job is not None and _winjob.terminate(handle._job)
                if not delivered:
                    delivered = _taskkill_tree(handle._pid)
                if not delivered:
                    # Leader-only fallback cannot prove the tree died: never
                    # justifies an inactive record.
                    try:
                        handle._proc.kill()
                    except OSError:
                        pass
        if delivered:
            _record_journal(handle._pid, active=False)


def _install_shutdown_hook() -> None:
    global _hook_installed
    import atexit

    with _hook_lock:
        if _hook_installed:
            return
        _hook_installed = True
    atexit.register(_kill_live_handles)


def live_handle_facts(cell_id: str | None) -> dict[str, int]:
    """Read-only liveness snapshot of the bash() registries, for the kernel heartbeat.

    Copies the registries under ``_live_lock`` and probes the pipes only after releasing
    it: that lock guards the sets and must never be held across an ioctl. The sums cover
    the whole live fleet, so a frame reports real movement only. Every value is a plain
    int, because the caller serializes
    the frame with ``allow_nan=False`` and a non-finite float would drop the frame.
    """
    with _live_lock:
        # `_reaped` (not the `running` property, which marks the handle released as a
        # side effect): a reaped handle is still in the set until its watcher discards it.
        handles = [handle for handle in _live_handles if not handle._reaped]
        cell_handles = len(_cell_handles.get(cell_id, ())) if cell_id is not None else 0
    # Full-fleet sums, not a bounded subset: a subset's membership changes when handles
    # are reaped, so its totals could move with no output at all, and the host reads these
    # numbers as movement evidence. ``_buffer.size()`` is O(1) bookkeeping and FIONREAD is
    # a ~microsecond ioctl, so a realistic fleet (tens of handles) costs far less than one
    # heartbeat interval (r35 H-2).
    buffered_bytes = 0
    pipe_pending = 0
    for handle in handles:
        try:
            buffered_bytes += handle._buffer.size()
        except BaseException:  # noqa: BLE001 - a fact probe must never end the heartbeat
            continue
        try:
            if handle._pipe_pending():
                pipe_pending += 1
        except BaseException:  # noqa: BLE001 - a fact probe must never end the heartbeat
            continue
    return {
        "handles": len(handles),
        "cell_handles": cell_handles,
        "buffered_bytes": buffered_bytes,
        "pipe_pending": pipe_pending,
    }
