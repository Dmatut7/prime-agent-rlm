"""Display-only reporting of what a cell changed and what it did.

The host UI cannot see a cell's effects on its own: files are written from Python
or from ``bash()`` children, and harness memory is edited in place. This module
observes those effects and ships records to the host as ``display`` events under
the MIME types below. None of it reaches the model: the records ride the display
channel, which the host keeps out of the tool result text, and every observation
path swallows its own failures, so a cell does, prints and raises exactly what it
would without tracking.

Observation paths:

- Thin wrappers around the file APIs that write (``open``/``io.open`` and
  ``os.open`` with write flags, ``os.rename``/``replace``/``remove``/``unlink``/
  ``truncate``, ``shutil.rmtree``). pathlib, shutil's copy and move helpers and
  tempfile all go through these. A wrapper captures a file's content when it is
  opened for writing - before the truncation - so the record can carry a diff.
  Nothing else in the interpreter is hooked, so CPU-bound cell code pays nothing,
  and a host that turns tracking off gets no wrappers at all.
- A bounded before/after comparison catches what child processes did (``sed -i``,
  formatters, ``git checkout``). Inside a git work tree it compares ``git status``
  snapshots plus stat and content caches; elsewhere it compares a bounded mtime
  scan. It runs only for a cell that starts a process, while ``bash()`` handles
  from earlier cells are still alive, or when such a handle ends between cells,
  because nothing else can change a file behind Python's back.
- ``bash()``, ``rlm.run()``, harness writes and the web skills report their own
  steps through the helpers at the bottom of this module.

Every record is complete on its own and the host keeps the latest one per file
path, per activity id and per memory entry, so a record re-sent after a later write
replaces the earlier one. A record carrying ``retracted: true`` withdraws an earlier
one (a file that ended the cell exactly as it started).
"""

from __future__ import annotations

import contextvars
import functools
import io
import itertools
import os
import re
import stat
import subprocess
import sys
import threading
import time
from collections import Counter, OrderedDict
from collections.abc import Callable
from typing import Any

FILE_CHANGE_MIME = "application/vnd.prime-agent.file-change+json"
MEMORY_CHANGE_MIME = "application/vnd.prime-agent.memory-change+json"
ACTIVITY_MIME = "application/vnd.prime-agent.activity+json"
# At most one per cell: why the change lists of that cell are partial.
TRACKING_STATUS_MIME = "application/vnd.prime-agent.change-tracking+json"

ENABLE_ENV_VAR = "PRIME_AGENT_CHANGE_TRACKING"
BUDGET_ENV_VAR = "PRIME_AGENT_CHANGE_TRACKING_BUDGET_MS"

# Tracker time a cell may cost (wrapper work, snapshots, diffs) before tracking gives up for it.
DEFAULT_CELL_BUDGET_S = 0.5
# Time the tracker's own threads (the watcher, before-state snapshots) may spend per cell before
# live mid-cell comparisons stop. They never block the cell, so they do not count against its budget.
BACKGROUND_BUDGET_S = 1.0
# At most one mid-cell command comparison per interval; the final one at the cell's end always runs.
LIVE_SHELL_CHECK_INTERVAL_S = 1.0
# Longest a watcher tick may hold the cell's work lock while publishing live records.
WATCH_TICK_BUDGET_S = 0.1
# A file whose size and mtime held still across one interval is reported live.
WATCH_INTERVAL_S = 0.15
MAX_FILES_PER_CELL = 400
MAX_BASELINE_FILE_BYTES = 1 << 20
MAX_BASELINE_BYTES_PER_CELL = 24 << 20
MAX_COUNT_FILE_BYTES = 8 << 20
MAX_DIFF_LINES = 400
MAX_DIFF_CHARS = 64 * 1024
MAX_DIFF_CHARS_PER_CELL = 256 * 1024
# Lines left on each side after trimming the common head and tail; above it only counts are kept.
MAX_DIFF_MIDDLE_LINES = 3000
MAX_READ_ACTIVITIES = 64
MAX_MEMORY_TEXT = 4000
MAX_LABEL = 160
MAX_DETAIL = 160
GIT_TIMEOUT_S = 2.0
MAX_GIT_ENTRIES = 5000
MAX_GIT_BLOBS = 200
MAX_SCAN_FILES = 5000
MAX_ROOTS_PER_CELL = 3
SNAPSHOT_CONTENT_FILE_BYTES = 256 * 1024
SNAPSHOT_CONTENT_FILES = 300
SNAPSHOT_CONTENT_BYTES = 4 << 20
CONTENT_CACHE_BYTES = 8 << 20
CONTENT_CACHE_ENTRIES = 512
COMMAND_UPDATE_INTERVAL_S = 0.5
# Completions of background commands held while no cell is running, sent at the next cell's start;
# past it the oldest are dropped and that cell says how many were lost.
MAX_PENDING_COMPLETIONS = 64
_PATH_CACHE_LIMIT = 4096

RULES_FILE_NAMES = frozenset({"AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"})
HARNESS_STATE_FILE_NAME = "harness_state.json"
# Never reported, wherever they sit: version control, dependencies, caches, environments.
_SKIP_DIR_NAMES = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        "site-packages",
        "dist-packages",
        ".tox",
        ".nox",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".cache",
        ".next",
        ".nuxt",
        ".turbo",
        ".parcel-cache",
        ".gradle",
        ".idea",
    }
)
# Build output: skipped outside git work trees, where no ignore file says what is generated.
_BUILD_DIR_NAMES = frozenset({"dist", "build", "out", "target", "coverage", ".output"})
_SKIP_SUFFIXES = (".pyc", ".pyo", ".swp", ".swx")
_SKIP_FILE_NAMES = frozenset({".DS_Store"})
# BSD `sed -i` (macOS) writes the new content to `.!<pid>!<name>` and renames it over the file.
_SED_TEMP = re.compile(r"\.![0-9]+!.")
_ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")

# Secrets are withheld from records: the host saves them with the session, so a diff or memory text
# holding a credential would put it on disk. A withheld record keeps its path, kind and line counts.
SENSITIVE = "sensitive"
# Files that hold credentials by convention: their diffs are never kept, whatever they contain.
_SENSITIVE_FILE_NAMES = frozenset(
    {
        ".env",
        ".netrc",
        "_netrc",
        ".npmrc",
        ".pypirc",
        ".pgpass",
        ".htpasswd",
        ".git-credentials",
        ".dockercfg",
        ".boto",
        ".s3cfg",
        "credentials",
    }
)
_SENSITIVE_PREFIXES = (".env.", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519")
_SENSITIVE_SUFFIXES = (
    ".env",
    ".pem",
    ".key",
    ".p8",
    ".p12",
    ".pfx",
    ".ppk",
    ".keystore",
    ".jks",
    ".kdbx",
    ".tfvars",
    ".tfstate",
)
# Every file under these directories (ssh keys, gpg keyrings, cloud and registry logins).
_SENSITIVE_DIR_NAMES = frozenset({".ssh", ".gnupg", ".aws", ".kube", ".docker"})
# `secrets.yaml`, `db-credentials.json`: a name about secrets on a config or data file, not on source code.
_SENSITIVE_CONFIG = re.compile(
    r"(?:secret|credential)[^/]*\.(?:json|ya?ml|toml|ini|cfg|conf|env|properties|txt|xml|plist)$|^[^.]*(?:secret|credential)[^.]*$",
    re.IGNORECASE,
)
# Credential shapes that are distinctive on their own. Each runs only when one of its literal markers
# occurs (a plain substring test), so a diff without any marker costs a few substring scans.
_SECRET_SHAPES: tuple[tuple[tuple[str, ...], bool, re.Pattern[str]], ...] = tuple(
    (markers, lower, re.compile(pattern))
    for markers, lower, pattern in (
        (("PRIVATE KEY",), False, r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----"),
        (("sk-",), False, r"(?<![A-Za-z0-9])sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}"),
        (("k_live_", "k_test_"), False, r"(?<![A-Za-z0-9])[rs]k_(?:live|test)_[A-Za-z0-9]{16,}"),
        (("AKIA", "ASIA"), False, r"(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])"),
        (("ghp_", "gho_", "ghu_", "ghs_", "ghr_"), False, r"(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}"),
        (("github_pat_",), False, r"github_pat_[A-Za-z0-9_]{20,}"),
        (("xox",), False, r"(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}"),
        (("glpat-",), False, r"(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}"),
        (("AIza",), False, r"(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}"),
        (("hf_",), False, r"(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}"),
        (("npm_",), False, r"(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}"),
        (("pypi-AgE",), False, r"pypi-AgE[A-Za-z0-9_-]{20,}"),
        (("eyJ",), False, r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
        (("bearer",), True, r"\bbearer\s+[a-z0-9._~+/=-]{20,}"),
        (("://",), True, r"\b[a-z][a-z0-9+.-]*://[^\s:/@\"']+:[^\s:/@\"']{6,}@"),
    )
)
# `name = value` assignments whose name ends in one of these words (matched on the lower-cased text).
_SECRET_NAMES = (
    "password",
    "passwd",
    "secret",
    "token",
    "credential",
    "api_key",
    "api-key",
    "apikey",
    "access_key",
    "access-key",
    "private_key",
    "private-key",
)
# What may follow the name: `secret_key`, `credentials`, a closing quote, then `=` or `:` (not `==`)
# and a quoted or bare value.
_SECRET_ASSIGNMENT_TAIL = re.compile(
    r"(?:[_-]?key)?s?[\"']?\s*(?<![=!<>])[:=](?!=)\s*(?:([\"'])([^\"'\s]{8,})\1|([^\s\"'#,;.(){}\[\]<>]{8,}))"
)
_SECRET_PLACEHOLDER = re.compile(
    r"(?i)^(?:x+|\*+|\.+|changeme|change_me|placeholder|example\w*|dummy\w*|redacted|none|null|true|false|"
    r"your[_-]?\w*|replace[_-]?me\w*|\$\{?\w+\}?|%\(\w+\)s|\{\{.*\}\})$"
)
_IDENTIFIER_LIKE = re.compile(r"^[A-Za-z_-]+$")


def _sensitive_path(path: str | None) -> bool:
    """Whether a file's name or folder marks it as a credential store."""
    if not path:
        return False
    directory, name = os.path.split(path)
    lower = name.lower()
    if lower in _SENSITIVE_FILE_NAMES or lower.startswith(_SENSITIVE_PREFIXES) or lower.endswith(_SENSITIVE_SUFFIXES):
        return True
    if _SENSITIVE_CONFIG.search(lower):
        return True
    return any(part.lower() in _SENSITIVE_DIR_NAMES for part in directory.split(os.sep))


def _looks_secret(text: str | None) -> bool:
    """Whether a text holds a likely credential. Callers bound the text; an error counts as a secret."""
    if not text:
        return False
    try:
        lower = text.lower()
        for markers, use_lower, pattern in _SECRET_SHAPES:
            haystack = lower if use_lower else text
            if any(marker in haystack for marker in markers) and pattern.search(haystack):
                return True
        for name in _SECRET_NAMES:
            start = lower.find(name)
            while start >= 0:
                match = _SECRET_ASSIGNMENT_TAIL.match(lower, start + len(name))
                if match:
                    value = match.group(2) or match.group(3) or ""
                    if not (_SECRET_PLACEHOLDER.match(value) or value.isdigit() or _IDENTIFIER_LIKE.match(value)):
                        return True
                start = lower.find(name, start + 1)
        return False
    except Exception:  # noqa: BLE001 - withholding is the safe answer
        return True


def _withhold_memory_texts(record: dict[str, Any], withheld: bool = False) -> None:
    """Drop both texts of a memory record when either holds a likely credential (or `withheld` says so)."""
    if withheld or _looks_secret(record.get("before")) or _looks_secret(record.get("after")):
        record.pop("before", None)
        record.pop("after", None)
        record["textOmitted"] = SENSITIVE

_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND

_Sender = Callable[[str, dict[str, Any]], None]

# Set by write_source(): who is writing, when it is not plain Python (the edit skill).
_write_source: contextvars.ContextVar[str | None] = contextvars.ContextVar("_prime_agent_write_source", default=None)
# Set by untracked(): writes that report themselves another way (harness saves emit memory records).
_untracked: contextvars.ContextVar[bool] = contextvars.ContextVar("_prime_agent_untracked", default=False)

_tracker: _Tracker | None = None
_ids = itertools.count(1)
# The real functions, captured when this module loads (before any wrapper exists). The
# tracker's own reads and stats go through these, so it never observes itself.
_real_open = io.open
_installed = False


def _now_ms() -> int:
    return int(time.time() * 1000)


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _one_line(text: str, limit: int) -> str:
    return _clip(" ".join(text.split()), limit)


def _safe_detail(text: str, limit: int) -> str | None:
    """`text` one-lined and capped, or None when it looks like it holds a credential.

    A command's last output line (``echo $API_KEY``, ``cat .env``) is display text like a diff or
    memory text, so it gets the same scan before it ever reaches an activity record.
    """
    if _looks_secret(text):
        return None
    return _one_line(text, limit)


def _under(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def _stat_sig(path: str) -> tuple[int, int] | None:
    """(size, mtime_ns) of a regular file, None when it is missing or not a regular file."""
    try:
        info = os.stat(path)
    except (OSError, ValueError):
        return None
    if not stat.S_ISREG(info.st_mode):
        return None
    return (info.st_size, info.st_mtime_ns)


# The size slot of a symlink's own signature: a link is compared as itself, never as its target.
_LINK_SIZE = -1


def _entry_sig(path: str) -> tuple[int, int] | None:
    """`_stat_sig` of the path itself: a symlink gives (`_LINK_SIZE`, its own mtime_ns)."""
    try:
        info = os.lstat(path)
    except (OSError, ValueError):
        return None
    if stat.S_ISLNK(info.st_mode):
        return (_LINK_SIZE, info.st_mtime_ns)
    if not stat.S_ISREG(info.st_mode):
        return None
    return (info.st_size, info.st_mtime_ns)


def _read_file(path: str, limit: int) -> bytes | None:
    """Whole content when it fits under `limit`, else None."""
    try:
        with _real_open(path, "rb") as handle:
            data = handle.read(limit + 1)
    except (OSError, ValueError):
        return None
    return data if len(data) <= limit else None


def _line_total(data: bytes) -> int:
    if not data:
        return 0
    return data.count(b"\n") + (0 if data.endswith(b"\n") else 1)


def _count_lines(path: str) -> int | None:
    data = _read_file(path, MAX_COUNT_FILE_BYTES)
    if data is None or b"\0" in data[:8192]:
        return None
    return _line_total(data)


class _Content:
    """A file's state at one moment: absent, its bytes, or only that it existed."""

    __slots__ = ("state", "data", "sig", "why")

    def __init__(
        self, state: str, data: bytes | None = None, sig: tuple[int, int] | None = None, why: str | None = None
    ) -> None:
        # state: "absent" | "bytes" | "large" (exists, too big to keep) | "unknown" (exists, not captured)
        # | "link" (a symlink; `data` is its target)
        self.state = state
        self.data = data
        self.sig = sig
        self.why = why

    @property
    def exists(self) -> bool:
        return self.state != "absent"


_ABSENT = _Content("absent")
_UNKNOWN = _Content("unknown", why="no_baseline")
# A path the before-commit does not contain (see _Tracker.blobs).
_MISSING = b"\0missing"


def _link_content(path: str, sig: tuple[int, int]) -> _Content:
    try:
        target = os.fsencode(os.readlink(path))
    except (OSError, ValueError):
        target = None
    return _Content("link", target, sig)


class _ContentCache:
    """Bounded LRU of file contents keyed by path and (size, mtime_ns).

    It is what lets a file that was already dirty before a cell get a real diff when a
    shell command changes it: git only knows the committed version, not the one the
    cell started from.
    """

    def __init__(self) -> None:
        self._entries: OrderedDict[str, tuple[tuple[int, int], bytes]] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()

    def get(self, path: str, sig: tuple[int, int] | None) -> bytes | None:
        if sig is None:
            return None
        with self._lock:
            entry = self._entries.get(path)
            if entry is None or entry[0] != sig:
                return None
            self._entries.move_to_end(path)
            return entry[1]

    def put(self, path: str, sig: tuple[int, int] | None, data: bytes) -> None:
        if sig is None or len(data) > SNAPSHOT_CONTENT_FILE_BYTES:
            return
        with self._lock:
            previous = self._entries.pop(path, None)
            if previous is not None:
                self._bytes -= len(previous[1])
            self._entries[path] = (sig, data)
            self._bytes += len(data)
            while self._entries and (self._bytes > CONTENT_CACHE_BYTES or len(self._entries) > CONTENT_CACHE_ENTRIES):
                _, (_, dropped) = self._entries.popitem(last=False)
                self._bytes -= len(dropped)


class _PathInfo:
    __slots__ = ("scope", "rel", "rules_scope", "display")

    def __init__(self, scope: str, rel: str | None, rules_scope: str | None, display: str) -> None:
        self.scope = scope
        self.rel = rel
        # "project" / "global" when the file is a rules file the harness reads.
        self.rules_scope = rules_scope
        self.display = display


class _FileRec:
    __slots__ = (
        "path",
        "baseline",
        "source",
        "old_path",
        "sig",
        "dirty",
        "emitted_key",
        "diff_chars",
        "last_change",
        "published_sig",
        "ignored",
    )

    def __init__(self, path: str, baseline: _Content, source: str, old_path: str | None = None) -> None:
        self.path = path
        self.baseline = baseline
        self.source = source
        self.old_path = old_path
        # Signature seen by the last watcher tick; "unset" forces one more tick before a live report.
        self.sig: tuple[int, int] | None | str = "unset"
        self.dirty = True
        self.emitted_key: tuple[Any, ...] | None = None
        self.diff_chars = 0
        self.last_change: dict[str, Any] | None = None
        self.published_sig: tuple[int, int] | None | str = "unset"
        self.ignored = False


class _RepoState:
    __slots__ = ("root", "oid", "entries", "stats")

    def __init__(self, root: str, oid: str | None, entries: dict[str, str], stats: dict[str, tuple[int, int] | None]):
        self.root = root
        self.oid = oid
        # abs path -> porcelain XY ("??" for untracked)
        self.entries = entries
        self.stats = stats


class _After:
    """The state a command comparison ended on: git states per work tree and the mtime scan."""

    __slots__ = ("repos", "scan", "roots")

    def __init__(self) -> None:
        self.repos: dict[str, _RepoState] = {}
        self.scan: tuple[str, dict[str, tuple[int, int]]] | None = None
        self.roots: set[str] = set()


class _Cell:
    def __init__(self, cell_id: str, budget_s: float) -> None:
        self.id = cell_id
        self.budget_s = budget_s
        self.spent = 0.0
        self.gave_up: str | None = None
        self.incomplete: str | None = None
        self.closing = False
        self.work_lock = threading.Lock()
        self.files: dict[str, _FileRec] = {}
        self.read_keys: set[str] = set()
        self.read_paths: set[str] = set()
        self.memory: dict[tuple[str, str, str], dict[str, Any]] = {}
        self.baseline_bytes = 0
        self.diff_chars = 0
        self.repos: dict[str, _RepoState] = {}
        self.scan: tuple[str, dict[str, tuple[int, int]]] | None = None
        self.roots_seen: set[str] = set()
        self.snapshots: list[_SnapshotJob] = []
        # bash() steps started by this cell that have not finished yet.
        self.commands: set[CommandStep] = set()
        self.shell_check_pending = False
        self.last_shell_check = 0.0
        # Tracker-thread time, see BACKGROUND_BUDGET_S.
        self.background_spent = 0.0

    def remaining(self) -> float:
        return self.budget_s - self.spent

    def charge(self, seconds: float) -> None:
        self.spent += seconds
        if self.spent > self.budget_s and self.gave_up is None:
            self.gave_up = f"time budget of {int(self.budget_s * 1000)} ms used up"

    def charge_background(self, seconds: float) -> None:
        self.background_spent += seconds

    def background_left(self) -> bool:
        return self.background_spent < BACKGROUND_BUDGET_S

    def note_incomplete(self, reason: str) -> None:
        if self.incomplete is None:
            self.incomplete = reason


class _OutOfTime(Exception):
    """A tracker step ran past its deadline; the caller records why its list is partial."""


class _SnapshotJob:
    """One before-state snapshot (git status or mtime scan of some roots) on a worker thread.

    Its results land in the cell only if nobody gave up waiting for it: a snapshot that finishes
    after the command it was meant to precede has started would describe the wrong moment.
    """

    def __init__(self, directories: list[str]) -> None:
        self.directories = directories
        self.done = threading.Event()
        self.abandoned = False
        self.committed = False


_SNAPSHOT_LATE = (
    "the git snapshot before a command did not finish within the tracking budget, "
    "so changes made by commands in this cell are not listed"
)
_IGNORE_UNKNOWN = (
    "git did not say in time which files it ignores, so files it ignores may be listed"
)
_COMPARE_LATE = (
    "comparing the files commands changed took longer than the tracking budget, "
    "so changes made by commands in this cell are not listed"
)
_GAP_LATE = (
    "comparing the files a background command changed after its cell ended took longer than "
    "the tracking budget, so those changes are not listed"
)


def _left(deadline: float) -> float:
    return deadline - time.perf_counter()


def _git_env() -> dict[str, str]:
    env = dict(os.environ)
    # A read-only probe must never take index.lock: a concurrent `git commit` would fail on it.
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["LC_ALL"] = "C"
    return env


def _run_git(root: str, args: list[str], timeout: float, stdin: bytes | None = None) -> bytes | None:
    """stdout of one git command, or None when it failed; `_OutOfTime` when it ran past `timeout`.

    Nothing reaches the kernel's own fds.
    """
    if timeout <= 0:
        raise _OutOfTime()
    try:
        proc = subprocess.run(
            ["git", "-C", root, *args],
            input=stdin,
            stdin=None if stdin is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            env=_git_env(),
        )
    except subprocess.TimeoutExpired:
        raise _OutOfTime() from None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout


def _parse_status_v2(raw: bytes, root: str) -> tuple[str | None, dict[str, str]] | None:
    """Branch oid and dirty entries from `git status --porcelain=v2 -z --branch`."""
    oid: str | None = None
    entries: dict[str, str] = {}
    fields = raw.split(b"\0")
    index = 0
    while index < len(fields):
        record = fields[index]
        index += 1
        if not record:
            continue
        if record.startswith(b"# branch.oid "):
            value = record[len(b"# branch.oid ") :].decode("ascii", "replace")
            oid = None if value.startswith("(") else value
            continue
        if record.startswith(b"#"):
            continue
        kind = record[:1]
        if kind == b"?":
            rel = record[2:]
            xy = "??"
        elif kind == b"1":
            parts = record.split(b" ", 8)
            if len(parts) < 9:
                continue
            xy, rel = parts[1].decode("ascii", "replace"), parts[8]
        elif kind == b"2":
            parts = record.split(b" ", 9)
            if len(parts) < 10:
                continue
            xy, rel = parts[1].decode("ascii", "replace"), parts[9]
            index += 1  # the original path follows as its own field
        elif kind == b"u":
            parts = record.split(b" ", 10)
            if len(parts) < 11:
                continue
            xy, rel = parts[1].decode("ascii", "replace"), parts[10]
        else:
            continue
        entries[os.path.join(root, os.fsdecode(rel))] = xy
        if len(entries) > MAX_GIT_ENTRIES:
            return None
    return oid, entries


def _decode_text(data: bytes) -> str | None:
    if b"\0" in data[:8192]:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _hunk_range(start: int, length: int) -> str:
    beginning = start + 1
    if length == 0:
        beginning -= 1
    return f"{beginning}" if length == 1 else f"{beginning},{length}"


def _diff_line(prefix: str, line: str) -> list[str]:
    if line.endswith("\n"):
        return [prefix + line]
    return [prefix + line + "\n", "\\ No newline at end of file\n"]


def _unified_diff(old: str, new: str, old_label: str, new_label: str) -> tuple[list[str] | None, int, int]:
    """(diff lines or None when too large, added, removed), trimming the common head and tail first.

    Trimming first keeps the matcher on the changed region only, which is what makes a
    whole-file rewrite that changed three lines as cheap as an in-place edit.
    """
    import difflib

    a = old.splitlines(keepends=True)
    b = new.splitlines(keepends=True)
    head = 0
    limit = min(len(a), len(b))
    while head < limit and a[head] == b[head]:
        head += 1
    tail = 0
    while tail < limit - head and a[len(a) - 1 - tail] == b[len(b) - 1 - tail]:
        tail += 1
    a_mid = a[head : len(a) - tail]
    b_mid = b[head : len(b) - tail]
    if len(a_mid) > MAX_DIFF_MIDDLE_LINES or len(b_mid) > MAX_DIFF_MIDDLE_LINES:
        # Order-free counts: exact for edits, a moved line counts as unchanged.
        old_counts = Counter(a_mid)
        new_counts = Counter(b_mid)
        return None, sum((new_counts - old_counts).values()), sum((old_counts - new_counts).values())
    context = 3
    lo = max(0, head - context)
    a_ctx = a[lo : len(a) - max(0, tail - context)]
    b_ctx = b[lo : len(b) - max(0, tail - context)]
    matcher = difflib.SequenceMatcher(None, a_ctx, b_ctx, autojunk=False)
    lines = [f"--- {old_label}\n", f"+++ {new_label}\n"]
    added = removed = 0
    for group in matcher.get_grouped_opcodes(context):
        first, last = group[0], group[-1]
        lines.append(
            f"@@ -{_hunk_range(first[1] + lo, last[2] - first[1])} +{_hunk_range(first[3] + lo, last[4] - first[3])} @@\n"
        )
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                for line in a_ctx[i1:i2]:
                    lines.extend(_diff_line(" ", line))
                continue
            if tag in ("replace", "delete"):
                removed += i2 - i1
                for line in a_ctx[i1:i2]:
                    lines.extend(_diff_line("-", line))
            if tag in ("replace", "insert"):
                added += j2 - j1
                for line in b_ctx[j1:j2]:
                    lines.extend(_diff_line("+", line))
    return lines, added, removed


def _cap_diff(lines: list[str]) -> tuple[str, bool]:
    kept: list[str] = []
    size = 0
    for index, line in enumerate(lines):
        if index >= MAX_DIFF_LINES or size + len(line) > MAX_DIFF_CHARS:
            return "".join(kept), True
        kept.append(line)
        size += len(line)
    return "".join(kept), False


_TEST_SUMMARY_PATTERNS = (
    re.compile(r"=+ (.*?\d+ (?:passed|failed|errors?|skipped|deselected|xfailed|xpassed).*?) in [\d.]+s"),
    re.compile(r"^\s*Tests\s+(.*?\d+ (?:passed|failed|skipped|todo).*?)(?:\s+\(\d+\))?\s*$"),
    re.compile(r"^Tests:\s+(.*\d+ total.*)$"),
    re.compile(r"test result: (\w+)\. (\d+ passed; \d+ failed)"),
)
_UNITTEST_RAN = re.compile(r"^Ran (\d+) tests? in [\d.]+s")
_UNITTEST_VERDICT = re.compile(r"^(OK|FAILED)(?: \((.*)\))?\s*$")


def _test_summary(lines: list[str]) -> str | None:
    for line in reversed(lines):
        for pattern in _TEST_SUMMARY_PATTERNS:
            match = pattern.search(line)
            if match:
                return _one_line(" ".join(group for group in match.groups() if group), MAX_DETAIL)
    ran: str | None = None
    verdict: str | None = None
    for line in lines:
        ran_match = _UNITTEST_RAN.search(line)
        if ran_match:
            ran = f"{ran_match.group(1)} tests"
            verdict = None
            continue
        if ran is not None:
            verdict_match = _UNITTEST_VERDICT.search(line)
            if verdict_match:
                verdict = verdict_match.group(1) + (f" ({verdict_match.group(2)})" if verdict_match.group(2) else "")
    if ran is not None:
        return f"{ran}, {verdict}" if verdict else ran
    return None


def _last_line(text: str) -> str | None:
    for line in reversed(re.split(r"[\r\n]+", _ANSI_ESCAPE.sub("", text))):
        stripped = line.strip()
        if stripped:
            return _one_line(stripped, MAX_DETAIL)
    return None


def _command_summary(exit_code: int, output: str) -> str | None:
    tail = _ANSI_ESCAPE.sub("", output[-8192:])
    lines = [line for line in re.split(r"[\r\n]+", tail) if line.strip()][-40:]
    summary = _test_summary(lines)
    if summary:
        return summary if exit_code == 0 else f"{summary} · exit {exit_code}"
    if exit_code != 0:
        last = _last_line(tail)
        return f"exit {exit_code}" + (f" · {last}" if last else "")
    return _last_line(tail)


class _Tracker:
    def __init__(self, sender: _Sender, cwd: str, budget_s: float) -> None:
        self.sender = sender
        self.cwd = os.path.realpath(cwd)
        self.budget_s = budget_s
        self.lock = threading.RLock()
        self.local = threading.local()
        self.cell: _Cell | None = None
        self.cache = _ContentCache()
        self.wake = threading.Event()
        self.watcher: threading.Thread | None = None
        self._dir_cache: dict[str, str] = {}
        self._info_cache: dict[str, _PathInfo | None] = {}
        self._git_roots: dict[str, str | None] = {}
        self._ignore_cache: dict[str, bool] = {}
        self._git_available: bool | None = None
        self.agent_dir = ""
        self.harness_files: frozenset[str] = frozenset()
        self.skip_files: frozenset[str] = frozenset()
        self.skip_roots: tuple[str, ...] = ()
        self.cwd_git_root: str | None = None
        self.pending_completions: list[dict[str, Any]] = []
        self.lost_completions = 0
        # Where the last cell's command comparison ended, kept while it left commands running: a
        # command that ends before the next cell starts is compared against it (see `_gap_check`).
        self.carried: _After | None = None
        # What those between-cell comparisons found, for the next cell: path -> baseline.
        self.pending_changes: dict[str, _Content] = {}
        self.pending_note: str | None = None
        self._gap_running = False
        self._gap_again = False
        # Resolved once, off every cell's path: a slow or hung git must not stall a write wrapper.
        self._cwd_git_resolved = threading.Event()
        self._refresh_paths()
        threading.Thread(target=self._resolve_cwd_git_root, daemon=True, name="rlm-change-git-root").start()

    def _resolve_cwd_git_root(self) -> None:
        self.local.busy = True
        try:
            self.cwd_git_root = self.git_root(self.cwd, GIT_TIMEOUT_S)
        except Exception:  # noqa: BLE001 - unknown stays "not a work tree"
            self.cwd_git_root = None
        finally:
            self._cwd_git_resolved.set()

    # ------------------------------------------------------------------ paths

    def _refresh_paths(self) -> None:
        agent_dir = (
            os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
            or os.environ.get("PI_CODING_AGENT_DIR")
            or os.path.join(os.path.expanduser("~"), ".prime", "agent")
        )
        self.agent_dir = os.path.realpath(os.path.expanduser(agent_dir))
        harness: set[str] = set()
        for name in ("RLM_HARNESS_STATE_DIR", "RLM_GLOBAL_HARNESS_STATE_DIR"):
            value = (os.environ.get(name) or "").strip()
            if value:
                harness.add(os.path.join(os.path.realpath(os.path.expanduser(value)), HARNESS_STATE_FILE_NAME))
        session_dir = (os.environ.get("RLM_SESSION_DIR") or "").strip()
        if session_dir:
            harness.add(os.path.join(os.path.realpath(session_dir), "harness", HARNESS_STATE_FILE_NAME))
        harness.add(os.path.join(self.agent_dir, "harness", HARNESS_STATE_FILE_NAME))
        journal = (os.environ.get("PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL") or "").strip()
        roots = {os.path.realpath(prefix) for prefix in (sys.prefix, sys.base_prefix, sys.exec_prefix) if prefix}
        if session_dir:
            # The session's own storage (subagent folders, artifacts) is not project work, wherever it sits.
            roots.add(os.path.realpath(session_dir))
        harness_files = frozenset(harness)
        skip_files = frozenset({os.path.realpath(journal)} if journal else ())
        # An environment inside the project is skipped by its directory name instead.
        skip_roots = tuple(sorted(root for root in roots if not _under(self.cwd, root)))
        if (harness_files, skip_files, skip_roots) != (self.harness_files, self.skip_files, self.skip_roots):
            self.harness_files = harness_files
            self.skip_files = skip_files
            self.skip_roots = skip_roots
            self._info_cache.clear()

    def resolve(self, raw: Any, follow: bool = False) -> str | None:
        """The absolute path with its directories resolved. `follow` (a write through the path, not
        a removal of it): a symlink resolves to its target when the target is a place tracking reports."""
        if isinstance(raw, int):
            return None
        try:
            text = os.fsdecode(os.fspath(raw))
        except (TypeError, ValueError):
            return None
        if not text or "\0" in text:
            return None
        absolute = os.path.abspath(text)
        directory, name = os.path.split(absolute)
        if not name:
            return None
        real_dir = self._dir_cache.get(directory)
        if real_dir is None:
            real_dir = os.path.realpath(directory)
            if len(self._dir_cache) > _PATH_CACHE_LIMIT:
                self._dir_cache.clear()
            self._dir_cache[directory] = real_dir
        path = os.path.join(real_dir, name)
        if follow:
            try:
                is_link = stat.S_ISLNK(os.lstat(path).st_mode)
            except (OSError, ValueError):
                is_link = False
            if is_link:
                target = os.path.realpath(path)
                if target != path and self.classify(target) is not None:
                    return target
        return path

    def _cwd_git_state(self) -> bool | None:
        """Whether the session cwd is in a git work tree; None while the one-time lookup still runs."""
        if not self._cwd_git_resolved.is_set():
            return None
        return self.cwd_git_root is not None

    def classify(self, path: str) -> _PathInfo | None:
        cached = self._info_cache.get(path, False)
        if cached is not False:
            return cached  # type: ignore[return-value]
        info, cacheable = self._classify(path)
        if cacheable:
            if len(self._info_cache) > _PATH_CACHE_LIMIT:
                self._info_cache.clear()
            self._info_cache[path] = info
        return info

    def _classify(self, path: str) -> tuple[_PathInfo | None, bool]:
        """The path's scope, and whether that answer may be cached."""
        info = self._classify_uncached(path)
        if info is not None and info.scope == "project" and info.rel is not None:
            if any(part in _BUILD_DIR_NAMES for part in info.rel.split(os.sep)[:-1]):
                in_git = self._cwd_git_state()
                if in_git is None:
                    # Unknown yet: report it (a work tree's ignore rules filter it later) and ask again next time.
                    return info, False
                if not in_git:
                    return None, True
        return info, True

    def _classify_uncached(self, path: str) -> _PathInfo | None:
        directory, name = os.path.split(path)
        if name in _SKIP_FILE_NAMES or name.endswith(_SKIP_SUFFIXES) or _SED_TEMP.match(name):
            return None
        if any(part in _SKIP_DIR_NAMES for part in directory.split(os.sep)):
            return None
        if path in self.skip_files:
            return None
        if path in self.harness_files:
            return _PathInfo("memory", self._rel(path), None, self._display(path))
        if _under(path, self.agent_dir) and not _under(self.cwd, self.agent_dir):
            if directory == self.agent_dir and name in RULES_FILE_NAMES:
                return _PathInfo("memory", None, "global", self._display(path))
            return None
        if any(_under(path, root) for root in self.skip_roots):
            return None
        if _under(path, self.cwd):
            rel = os.path.relpath(path, self.cwd)
            if name in RULES_FILE_NAMES:
                return _PathInfo("memory", rel, "project", rel)
            return _PathInfo("project", rel, None, rel)
        if name in RULES_FILE_NAMES and _under(self.cwd, directory):
            # The harness reads rules files from every ancestor of the session directory.
            return _PathInfo("memory", None, "project", self._display(path))
        return _PathInfo("scratch", None, None, self._display(path))

    def _diff_label(self, side: str, path: str) -> str:
        shown = self._display(path)
        return f"{side}/{shown}" if not os.path.isabs(shown) and not shown.startswith("~") else shown

    def _rel(self, path: str) -> str | None:
        return os.path.relpath(path, self.cwd) if _under(path, self.cwd) else None

    def _display(self, path: str) -> str:
        if _under(path, self.cwd):
            return os.path.relpath(path, self.cwd)
        home = os.path.expanduser("~")
        if home and home != "~" and _under(path, home):
            return "~" + path[len(home.rstrip(os.sep)) :]
        return path

    # -------------------------------------------------------------------- git

    def git_root(self, directory: str, timeout: float) -> str | None:
        """The work tree holding `directory`, or None; `_OutOfTime` (never cached) when git is too slow."""
        if directory in self._git_roots:
            return self._git_roots[directory]
        root: str | None = None
        if self._git_available is None:
            import shutil

            self._git_available = shutil.which("git") is not None
        if self._git_available:
            out = _run_git(directory, ["rev-parse", "--show-toplevel"], min(GIT_TIMEOUT_S, timeout))
            if out:
                text = os.fsdecode(out.strip())
                root = os.path.realpath(text) if text else None
        if len(self._git_roots) > 256:
            self._git_roots.clear()
        self._git_roots[directory] = root
        return root

    def repo_state(self, root: str, fill_cache: bool, deadline: float) -> _RepoState | None:
        out = _run_git(
            root,
            [
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=all",
                "--no-renames",
                "--ignore-submodules=all",
            ],
            min(GIT_TIMEOUT_S, _left(deadline)),
        )
        if out is None:
            return None
        parsed = _parse_status_v2(out, root)
        if parsed is None:
            return None
        oid, entries = parsed
        stats: dict[str, tuple[int, int] | None] = {}
        read_files = 0
        read_bytes = 0
        for index, path in enumerate(entries):
            if index % 64 == 63 and _left(deadline) <= 0:
                raise _OutOfTime()
            sig = _entry_sig(path)
            stats[path] = sig
            if not fill_cache or sig is None or not 0 <= sig[0] <= SNAPSHOT_CONTENT_FILE_BYTES:
                continue
            if self.cache.get(path, sig) is not None:
                continue
            if read_files >= SNAPSHOT_CONTENT_FILES or read_bytes + sig[0] > SNAPSHOT_CONTENT_BYTES:
                continue
            if self.classify(path) is None:
                continue
            data = _read_file(path, SNAPSHOT_CONTENT_FILE_BYTES)
            if data is not None:
                read_files += 1
                read_bytes += len(data)
                self.cache.put(path, sig, data)
        return _RepoState(root, oid, entries, stats)

    def filter_ignored(self, recs: list[_FileRec], deadline: float) -> bool:
        """Mark records for files the repository ignores; one `git check-ignore` per batch.

        False when git gave no answer (too slow, failed, or the work tree is not resolved yet):
        the unanswered records stay unmarked and nothing is cached, so the next call asks again.
        Shell-sourced records never need asking: `git status` already leaves ignored files out.
        """
        asked = [rec for rec in recs if rec.source != "shell"]
        if not asked:
            return True
        in_git = self._cwd_git_state()
        if in_git is None:
            return False
        root = self.cwd_git_root
        if not in_git or root is None:
            return True
        answered = True
        pending = list(
            dict.fromkeys(rec.path for rec in asked if _under(rec.path, root) and rec.path not in self._ignore_cache)
        )
        if pending:
            payload = b"\0".join(os.fsencode(path) for path in pending) + b"\0"
            try:
                proc: subprocess.CompletedProcess[bytes] | None = subprocess.run(
                    ["git", "-C", root, "check-ignore", "-z", "--stdin"],
                    input=payload,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    timeout=max(0.05, min(GIT_TIMEOUT_S, _left(deadline))),
                    env=_git_env(),
                )
            except (OSError, ValueError, subprocess.SubprocessError):
                proc = None
            # Exit 1 means "nothing ignored"; a timeout or any other exit is no answer at all.
            if proc is not None and proc.returncode in (0, 1):
                ignored = {os.fsdecode(item) for item in proc.stdout.split(b"\0") if item}
                if len(self._ignore_cache) > _PATH_CACHE_LIMIT:
                    self._ignore_cache.clear()
                for path in pending:
                    self._ignore_cache[path] = path in ignored
            else:
                answered = False
        for rec in asked:
            if self._ignore_cache.get(rec.path):
                rec.ignored = True
        return answered

    def blobs(self, root: str, specs: list[str], deadline: float) -> dict[str, bytes | None]:
        """Content of `<oid>:<path>` specs: bytes, `_MISSING` when the commit has no such file,
        None when it could not be fetched (oversized, git failed)."""
        found: dict[str, bytes | None] = {spec: None for spec in specs}
        if not specs:
            return found
        request = b"".join(os.fsencode(spec) + b"\n" for spec in specs)
        checked = _run_git(root, ["cat-file", "--batch-check"], min(GIT_TIMEOUT_S, _left(deadline)), request)
        if checked is None:
            return found
        wanted: list[str] = []
        total = 0
        for spec, line in zip(specs, checked.decode("utf-8", "replace").splitlines()):
            parts = line.split()
            if parts and parts[-1] == "missing":
                found[spec] = _MISSING
                continue
            if len(parts) == 3 and parts[1] == "blob":
                size = int(parts[2])
                if size <= MAX_BASELINE_FILE_BYTES and total + size <= SNAPSHOT_CONTENT_BYTES * 2:
                    wanted.append(spec)
                    total += size
        if not wanted:
            return found
        request = b"".join(os.fsencode(spec) + b"\n" for spec in wanted)
        out = _run_git(root, ["cat-file", "--batch"], min(GIT_TIMEOUT_S, _left(deadline)), request)
        if out is None:
            return found
        offset = 0
        for spec in wanted:
            newline = out.find(b"\n", offset)
            if newline < 0:
                break
            header = out[offset:newline].split()
            offset = newline + 1
            if len(header) != 3 or header[1] != b"blob":
                continue
            size = int(header[2])
            found[spec] = out[offset : offset + size]
            offset += size + 1
        return found

    def scan(self, root: str, deadline: float) -> dict[str, tuple[int, int]] | None:
        """(size, mtime_ns) per file under root, None past the file cap; `_OutOfTime` past the deadline.

        A symlink is an entry of its own with `_entry_sig`'s signature; it is never walked into.
        """
        found: dict[str, tuple[int, int]] = {}
        stack = [root]
        while stack:
            if _left(deadline) <= 0:
                raise _OutOfTime()
            current = stack.pop()
            try:
                with os.scandir(current) as entries:
                    for entry in entries:
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                if entry.name not in _SKIP_DIR_NAMES and entry.name not in _BUILD_DIR_NAMES:
                                    stack.append(entry.path)
                                continue
                            is_link = entry.is_symlink()
                            if not is_link and not entry.is_file(follow_symlinks=False):
                                continue
                            info = entry.stat(follow_symlinks=False)
                        except OSError:
                            continue
                        found[entry.path] = (_LINK_SIZE if is_link else info.st_size, info.st_mtime_ns)
                        if len(found) > MAX_SCAN_FILES:
                            return None
            except OSError:
                continue
        return found

    # ----------------------------------------------------------------- sending

    def send(self, cell_id: str, data: dict[str, Any]) -> None:
        try:
            self.sender(cell_id, data)
        except Exception:  # noqa: BLE001 - a record that cannot be sent is dropped, never raised
            pass

    def retract(self, cell: _Cell, path: str) -> None:
        self.send(cell.id, {FILE_CHANGE_MIME: {"path": path, "retracted": True}})

    # ------------------------------------------------------------------- cells

    def begin_cell(self, cell_id: str) -> None:
        self._refresh_paths()
        cell = _Cell(cell_id, self.budget_s)
        with self.lock:
            self.cell = cell
            completions, self.pending_completions = self.pending_completions, []
            lost, self.lost_completions = self.lost_completions, 0
            # From here on this cell's own snapshots cover commands still running.
            self.carried = None
            changes, self.pending_changes = self.pending_changes, {}
            note, self.pending_note = self.pending_note, None
        if lost:
            cell.note_incomplete(
                f"{lost} background commands ended while no cell was running and their results were lost"
            )
        if note:
            cell.note_incomplete(note)
        # Background commands that finished while no cell was running report here, first, and the
        # files they changed after their cell ended with them.
        for record in completions:
            self.send_activity(cell.id, record)
        if changes:
            self.apply_shell_changes(cell, list(changes.items()))
            with self.lock:
                self._wake_watcher()
        if self._live_handles() > 0:
            # Commands from earlier cells may still be writing; compare from this cell's start. The
            # snapshot runs on a worker and the cell starts at once; a process the cell starts later
            # waits for it, bounded by the budget (see request_snapshot).
            self.request_snapshot(cell, os.getcwd(), wait=False)

    def _live_handles(self) -> int:
        bash_module = sys.modules.get("rlm.bash")
        if bash_module is None:
            return 0
        try:
            return int(bash_module.live_handle_facts(None).get("handles", 0))
        except Exception:  # noqa: BLE001
            return 0

    def discard_cell(self, cell_id: str) -> None:
        with self.lock:
            if self.cell is not None and self.cell.id == cell_id:
                self.cell.closing = True
                self.cell = None

    def end_cell(self, cell_id: str) -> bool:
        """Report the cell's final effects; True when an interrupt landed while doing so."""
        cell = self.cell
        if cell is None or cell.id != cell_id:
            return False
        interrupted = False
        self.local.busy = True
        started = time.perf_counter()
        deadline = started + max(0.0, cell.remaining())
        try:
            # Closing first: a watcher tick in progress stops at its next check instead of holding
            # the work lock for a whole comparison.
            with self.lock:
                cell.closing = True
                still_running = list(cell.commands)
            # A command the cell leaves running keeps going as a background handle: say so in this
            # cell (its last word here), and report its end in whichever cell is running then.
            ended_at = _now_ms()
            for command in still_running:
                command.move_to_background(ended_at)
            with cell.work_lock:
                try:
                    for job in list(cell.snapshots):
                        self._await_snapshot(cell, job, deadline)
                    if cell.gave_up is None and (cell.repos or cell.scan is not None):
                        # Commands left running may still change files after this comparison.
                        keep = bool(still_running) or self._live_handles() > 0
                        self._final_shell_compare(cell, deadline, keep)
                    if cell.files and not self._cwd_git_resolved.is_set():
                        # Ignore rules and the build-output rule need it; normally it resolved long ago.
                        self._cwd_git_resolved.wait(max(0.0, _left(deadline)))
                    self.publish_all(cell, final=True, deadline=deadline)
                except KeyboardInterrupt:
                    interrupted = True
                    cell.note_incomplete("interrupted while collecting changes")
                except Exception:  # noqa: BLE001 - tracking must never fail the cell
                    cell.note_incomplete("internal error while collecting changes")
                # The specific cause first (a slow git, too many files), then the budget it cost.
                reason = "; ".join(part for part in (cell.incomplete, cell.gave_up) if part) or None
                if reason is not None:
                    self.send(cell.id, {TRACKING_STATUS_MIME: {"incomplete": reason}})
        except KeyboardInterrupt:
            interrupted = True
        finally:
            cell.charge(time.perf_counter() - started)
            with self.lock:
                if self.cell is cell:
                    self.cell = None
                ended_while_closing = bool(self.pending_completions)
            self.local.busy = False
        if ended_while_closing:
            # A command ended while this cell was finishing, maybe after its comparison.
            self._request_gap_check()
        return interrupted

    def active(self) -> _Cell | None:
        """The cell to attribute work to, or None when this thread must not track now."""
        cell = self.cell
        if cell is None or cell.closing or cell.gave_up is not None:
            return None
        if getattr(self.local, "busy", False) or _untracked.get():
            return None
        return cell

    def _final_shell_compare(self, cell: _Cell, deadline: float, keep: bool = False) -> None:
        """The end-of-cell comparison, computed on a worker so a slow git cannot hold the event
        loop past the budget; its result is applied here, on the cell's thread. `keep`: the state it
        ends on is kept for commands that end before the next cell starts."""
        outcome: dict[str, Any] = {}
        done = threading.Event()
        ended = _After() if keep else None

        def work() -> None:
            self.local.busy = True
            try:
                outcome["changes"] = self.shell_changes(cell, deadline, ended)
            except _OutOfTime:
                outcome["late"] = True
            except Exception:  # noqa: BLE001
                outcome["failed"] = True
            finally:
                done.set()

        threading.Thread(target=work, daemon=True, name="rlm-change-compare").start()
        if not done.wait(max(0.0, _left(deadline))):
            cell.note_incomplete(_COMPARE_LATE)
            return
        if outcome.get("late"):
            cell.note_incomplete(_COMPARE_LATE)
        elif outcome.get("failed"):
            cell.note_incomplete("internal error while comparing command changes")
        else:
            self.apply_shell_changes(cell, outcome["changes"])
            if ended is not None:
                ended.roots = set(cell.roots_seen)
                with self.lock:
                    self.carried = ended

    def guarded(self, cell: _Cell, work: Callable[[], Any]) -> Any:
        """Run tracker work on the calling thread with the budget charged and failures contained."""
        already_busy = getattr(self.local, "busy", False)
        self.local.busy = True
        started = time.perf_counter()
        try:
            return work()
        except Exception:  # noqa: BLE001 - tracking must never fail the operation it observes
            cell.note_incomplete("internal error while tracking")
            return None
        finally:
            cell.charge(time.perf_counter() - started)
            self.local.busy = already_busy

    # ------------------------------------------------------------ file writes

    def on_write(self, cell: _Cell, raw: Any, deleting: bool = False) -> None:
        # A removal acts on the link itself; any other write lands in the link's target.
        path = self.resolve(raw, follow=not deleting)
        if path is None:
            return
        with self.lock:
            if self.cell is not cell or cell.closing:
                return
            rec = cell.files.get(path)
            if rec is not None:
                rec.dirty = True
                rec.sig = "unset"
                self._wake_watcher()
                return
            if len(cell.files) >= MAX_FILES_PER_CELL:
                cell.note_incomplete(f"more than {MAX_FILES_PER_CELL} files changed; the rest are not listed")
                return
        if self.classify(path) is None:
            return
        baseline = self.capture(cell, path)
        if baseline is None or (deleting and not baseline.exists):
            return
        with self.lock:
            if self.cell is not cell or cell.closing or path in cell.files:
                return
            cell.files[path] = _FileRec(path, baseline, _write_source.get() or "python")
            self._wake_watcher()

    def capture(self, cell: _Cell, path: str) -> _Content | None:
        """The file's current state, taken before the write lands; None for other non-regular files."""
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            return _ABSENT
        except (OSError, ValueError):
            return None
        if stat.S_ISLNK(info.st_mode):
            return _link_content(path, (_LINK_SIZE, info.st_mtime_ns))
        if not stat.S_ISREG(info.st_mode):
            return None
        sig = (info.st_size, info.st_mtime_ns)
        cached = self.cache.get(path, sig)
        if cached is not None:
            return _Content("bytes", cached, sig)
        if info.st_size > MAX_BASELINE_FILE_BYTES:
            return _Content("large", None, sig)
        if cell.baseline_bytes + info.st_size > MAX_BASELINE_BYTES_PER_CELL:
            return _Content("unknown", None, sig, "budget")
        data = _read_file(path, MAX_BASELINE_FILE_BYTES)
        if data is None:
            return _Content("unknown", None, sig, "no_baseline")
        cell.baseline_bytes += len(data)
        return _Content("bytes", data, sig)

    def on_rmtree(self, cell: _Cell, raw: Any) -> None:
        root = self.resolve(raw)
        if root is None:
            return
        count = 0
        for directory, dirs, names in os.walk(root):
            dirs[:] = [name for name in dirs if name not in _SKIP_DIR_NAMES]
            for name in names:
                count += 1
                if count > MAX_FILES_PER_CELL:
                    cell.note_incomplete("a removed directory held too many files to list")
                    return
                self.on_write(cell, os.path.join(directory, name), deleting=True)

    # ---------------------------------------------------------------- renames

    def pre_rename(self, cell: _Cell, raw_src: Any, raw_dst: Any) -> tuple[Any, ...] | None:
        """What a rename will change, captured before it happens; applied by post_rename on success."""
        src = self.resolve(raw_src)
        dst = self.resolve(raw_dst)
        if src is None or dst is None or src == dst:
            return None
        try:
            src_is_dir = stat.S_ISDIR(os.lstat(src).st_mode)
        except OSError:
            return None
        if src_is_dir:
            return ("tree", src, dst, self._tree_plan(cell, src, dst))
        src_info = self.classify(src)
        dst_info = self.classify(dst)
        if src_info is None and dst_info is None:
            return None
        with self.lock:
            src_rec = cell.files.get(src)
            dst_rec = cell.files.get(dst)
        src_base = src_rec.baseline if src_rec is not None else (self.capture(cell, src) if src_info else None)
        dst_base = dst_rec.baseline if dst_rec is not None else (self.capture(cell, dst) if dst_info else None)
        return ("file", src, dst, src_info is not None, dst_info is not None, src_base, dst_base)

    def _tree_plan(self, cell: _Cell, src: str, dst: str) -> list[tuple[str, str, _Content]]:
        plan: list[tuple[str, str, _Content]] = []
        with self.lock:
            known = set(cell.files)
        for directory, dirs, names in os.walk(src):
            dirs[:] = [name for name in dirs if name not in _SKIP_DIR_NAMES]
            for name in names:
                path = os.path.join(directory, name)
                if path in known or self.classify(path) is None:
                    continue
                if len(plan) + len(known) >= MAX_FILES_PER_CELL:
                    cell.note_incomplete("a moved directory held too many files to list")
                    return plan
                base = self.capture(cell, path)
                if base is not None:
                    plan.append((path, os.path.join(dst, os.path.relpath(path, src)), base))
        return plan

    def post_rename(self, cell: _Cell, plan: tuple[Any, ...]) -> None:
        retracted: list[str] = []
        with self.lock:
            if self.cell is not cell or cell.closing:
                return
            if plan[0] == "tree":
                _, src, dst, entries = plan
                for path in [path for path in cell.files if _under(path, src)]:
                    rec = cell.files.pop(path)
                    if rec.emitted_key is not None:
                        retracted.append(path)
                    moved = _FileRec(os.path.join(dst, os.path.relpath(path, src)), rec.baseline, rec.source)
                    moved.old_path = (rec.old_path or path) if rec.baseline.exists else None
                    cell.files[moved.path] = moved
                source = _write_source.get() or "python"
                for path, target, base in entries:
                    if target not in cell.files:
                        cell.files[target] = _FileRec(target, base, source, path)
            else:
                _, src, dst, src_tracked, dst_tracked, src_base, dst_base = plan
                popped = cell.files.pop(src, None)
                if popped is not None and popped.emitted_key is not None:
                    retracted.append(src)
                source = popped.source if popped is not None else (_write_source.get() or "python")
                src_existed = src_base is not None and src_base.exists
                if not dst_tracked:
                    # Moved somewhere never reported (a cache, the kernel venv): only the removal shows.
                    if src_existed and src_tracked:
                        cell.files[src] = _FileRec(src, src_base, source)
                else:
                    previous = cell.files.get(dst)
                    old_path = (popped.old_path if popped is not None and popped.old_path else src) if src_existed and src_tracked else None
                    if old_path is not None and dst_base is not None and not dst_base.exists:
                        rec = _FileRec(dst, src_base, source, old_path)
                    else:
                        # Replacing an existing file, or moving a file made in this cell into place
                        # (the atomic-write pattern): the destination changed from what it was.
                        rec = _FileRec(dst, dst_base if dst_base is not None else _UNKNOWN, source, old_path)
                    if previous is not None:
                        rec.emitted_key = previous.emitted_key
                        rec.diff_chars = previous.diff_chars
                    cell.files[dst] = rec
            self._wake_watcher()
        for path in retracted:
            self.retract(cell, path)

    # ----------------------------------------------------------------- reads

    def on_read(self, cell: _Cell, raw: Any) -> None:
        if len(cell.read_keys) >= MAX_READ_ACTIVITIES * 4:
            return
        try:
            key = os.fsdecode(os.fspath(raw))
        except (TypeError, ValueError):
            return
        if type(raw) is str:
            # The wrapper's fast path looks the raw spelling up before paying for this call.
            cell.read_keys.add(raw)
        if not os.path.isabs(key):
            key = os.path.join(os.getcwd(), key)
        if key in cell.read_keys and key != raw:
            return
        cell.read_keys.add(key)
        path = self.resolve(key)
        if path is None or not _under(path, self.cwd) or path == self.cwd or path in cell.read_paths:
            return
        if len(cell.read_paths) >= MAX_READ_ACTIVITIES:
            return
        info = self.classify(path)
        if info is None or _stat_sig(path) is None:
            return
        with self.lock:
            if path in cell.read_paths:
                return
            cell.read_paths.add(path)
        now = _now_ms()
        self.send(
            cell.id,
            {
                ACTIVITY_MIME: {
                    "id": f"read-{next(_ids)}",
                    "kind": "read",
                    "label": _clip(info.display, MAX_LABEL),
                    "status": "ok",
                    "startedAt": now,
                    "endedAt": now,
                }
            },
        )

    # ------------------------------------------------------------- shell side

    def request_snapshot(self, cell: _Cell, process_cwd: str, wait: bool) -> None:
        """Take the before-state of every root a new process may touch, once per root per cell.

        The work always runs on a worker thread. `wait=True` (a process is about to start) blocks
        until the snapshots covering it are taken, at most for the cell's remaining budget; past
        that the snapshot is abandoned and the cell says its command changes are not listed, so a
        slow git in a large repository costs at most the budget and never an unbounded stall.
        """
        with self.lock:
            directories: list[str] = []
            for directory in (self.cwd, os.path.realpath(process_cwd)):
                if directory in cell.roots_seen or directory in directories:
                    continue
                if len(cell.roots_seen) + len(directories) >= MAX_ROOTS_PER_CELL:
                    break
                directories.append(directory)
            cell.roots_seen.update(directories)
            if directories:
                job = _SnapshotJob(directories)
                cell.snapshots.append(job)
                threading.Thread(
                    target=self._run_snapshot, args=(cell, job), daemon=True, name="rlm-change-snapshot"
                ).start()
            pending = [job for job in cell.snapshots if not job.done.is_set()]
        if wait:
            deadline = time.perf_counter() + max(0.0, cell.remaining())
            for job in pending:
                self._await_snapshot(cell, job, deadline)

    def _await_snapshot(self, cell: _Cell, job: _SnapshotJob, deadline: float) -> None:
        if job.done.wait(max(0.0, _left(deadline))):
            return
        with self.lock:
            if job.committed:
                return
            job.abandoned = True
        cell.note_incomplete(_SNAPSHOT_LATE)

    def _run_snapshot(self, cell: _Cell, job: _SnapshotJob) -> None:
        self.local.busy = True
        started = time.perf_counter()
        # A snapshot gets the cell's budget, like any other tracker step that stands in its way.
        deadline = started + cell.budget_s
        repos: dict[str, _RepoState] = {}
        scan: tuple[str, dict[str, tuple[int, int]]] | None = None
        notes: list[str] = []
        try:
            for directory in job.directories:
                root = self.git_root(directory, _left(deadline))
                if root is not None:
                    if root in repos or root in cell.repos:
                        continue
                    state = self.repo_state(root, True, deadline)
                    if state is None:
                        notes.append("git status failed; changes made by commands may be missing")
                        continue
                    repos[root] = state
                elif directory == self.cwd and cell.scan is None:
                    found = self.scan(directory, deadline)
                    if found is None:
                        notes.append("the working directory is too large to scan for command changes")
                        continue
                    self._cache_recent(found, deadline)
                    scan = (directory, found)
        except _OutOfTime:
            notes.append(_SNAPSHOT_LATE)
        except Exception:  # noqa: BLE001
            notes.append("internal error while taking the command snapshot")
        finally:
            with self.lock:
                if not job.abandoned:
                    job.committed = True
                    for root, state in repos.items():
                        cell.repos.setdefault(root, state)
                    if scan is not None and cell.scan is None:
                        cell.scan = scan
                    for note in notes:
                        cell.note_incomplete(note)
            cell.charge_background(time.perf_counter() - started)
            job.done.set()

    def _cache_recent(self, found: dict[str, tuple[int, int]], deadline: float) -> None:
        """Without git there is no committed copy to diff against, so keep the most recently
        touched small files - the ones a command is most likely to edit next."""
        read_files = 0
        read_bytes = 0
        for path, sig in sorted(found.items(), key=lambda item: item[1][1], reverse=True):
            if read_files >= SNAPSHOT_CONTENT_FILES or read_bytes >= SNAPSHOT_CONTENT_BYTES or _left(deadline) <= 0:
                return
            if sig[0] == _LINK_SIZE:
                continue  # a link's content is its target's: reading through it can block on a pipe
            if sig[0] > SNAPSHOT_CONTENT_FILE_BYTES or read_bytes + sig[0] > SNAPSHOT_CONTENT_BYTES:
                continue
            if self.cache.get(path, sig) is not None or self.classify(path) is None:
                continue
            data = _read_file(path, SNAPSHOT_CONTENT_FILE_BYTES)
            if data is not None and _stat_sig(path) == sig:
                read_files += 1
                read_bytes += len(data)
                self.cache.put(path, sig, data)

    def request_shell_check(self) -> None:
        with self.lock:
            cell = self.cell
            between_cells = cell is None or cell.closing
            if not between_cells:
                if not (cell.repos or cell.scan is not None):
                    return
                cell.shell_check_pending = True
                self._wake_watcher()
        if between_cells:
            self._request_gap_check()

    def _request_gap_check(self) -> None:
        with self.lock:
            if self.carried is None:
                return
            if self._gap_running:
                self._gap_again = True
                return
            self._gap_running = True
        threading.Thread(target=self._gap_loop, daemon=True, name="rlm-change-gap").start()

    def _gap_loop(self) -> None:
        self.local.busy = True
        while True:
            with self.lock:
                self._gap_again = False
                carried = self.carried
            if carried is not None:
                try:
                    self._gap_check(carried)
                except Exception:  # noqa: BLE001 - a missed background change is never raised
                    pass
            with self.lock:
                if not self._gap_again or self.carried is None:
                    self._gap_running = False
                    return

    def _gap_check(self, carried: _After) -> None:
        """A command ended while no cell was running: compare from where the last comparison ended,
        on this worker and within one cell budget, and hand what changed to the next cell (or to the
        one that started meanwhile), where the command's end is reported too."""
        probe = _Cell("", self.budget_s)
        probe.repos = dict(carried.repos)
        probe.scan = carried.scan
        ended = _After()
        ended.roots = carried.roots
        changes: list[tuple[str, _Content]] | None
        try:
            changes = self.shell_changes(probe, time.perf_counter() + self.budget_s, ended)
        except _OutOfTime:
            changes = None
            probe.note_incomplete(_GAP_LATE)
        with self.lock:
            if self.carried is carried:
                self.carried = ended if changes is not None else None
            target = self.cell if self.cell is not None and not self.cell.closing else None
        if target is not None:
            with target.work_lock:
                with self.lock:
                    open_cell = self.cell is target and not target.closing
                if open_cell:
                    if probe.incomplete:
                        target.note_incomplete(probe.incomplete)
                    if changes:
                        self.apply_shell_changes(target, changes)
                        with self.lock:
                            self._wake_watcher()
                    return
        with self.lock:
            if probe.incomplete and self.pending_note is None:
                self.pending_note = probe.incomplete
            for path, baseline in changes or []:
                if path in self.pending_changes:
                    continue
                if len(self.pending_changes) >= MAX_FILES_PER_CELL:
                    self.pending_note = self.pending_note or (
                        f"more than {MAX_FILES_PER_CELL} files changed; the rest are not listed"
                    )
                    break
                self.pending_changes[path] = baseline

    def shell_changes(
        self, cell: _Cell, deadline: float, after: _After | None = None
    ) -> list[tuple[str, _Content]]:
        """What changed since the before-snapshots, as (path, baseline) pairs; `_OutOfTime` past the deadline.

        Pure computation, safe on a worker thread: `apply_shell_changes` turns it into records.
        `after`, when given, receives the states the comparison ended on.
        """
        changes: list[tuple[str, _Content]] = []
        for before in list(cell.repos.values()):
            self._compare_repo(cell, before, deadline, changes, after)
        if cell.scan is not None:
            self._compare_scan(cell, cell.scan[0], cell.scan[1], deadline, changes, after)
        return changes

    def apply_shell_changes(self, cell: _Cell, changes: list[tuple[str, _Content]]) -> None:
        for path, baseline in changes:
            if path in self.harness_files:
                continue  # the harness's own saves report themselves as memory records
            with self.lock:
                rec = cell.files.get(path)
                if rec is not None:
                    rec.dirty = True
                    continue
                if len(cell.files) >= MAX_FILES_PER_CELL:
                    cell.note_incomplete(f"more than {MAX_FILES_PER_CELL} files changed; the rest are not listed")
                    return
                cell.files[path] = _FileRec(path, baseline, "shell")

    def _compare_repo(
        self,
        cell: _Cell,
        before: _RepoState,
        deadline: float,
        changes: list[tuple[str, _Content]],
        ended: _After | None = None,
    ) -> None:
        after = self.repo_state(before.root, False, deadline)
        if after is None:
            cell.note_incomplete("git status failed; changes made by commands may be missing")
            return
        if ended is not None:
            ended.repos[before.root] = after
        candidates = set(before.entries) | set(after.entries)
        if before.oid is not None and after.oid is not None and before.oid != after.oid:
            out = _run_git(
                before.root,
                ["diff", "--name-only", "-z", "--no-renames", before.oid, after.oid],
                min(GIT_TIMEOUT_S, _left(deadline)),
            )
            if out is None:
                cell.note_incomplete("git diff failed; files changed by a branch switch may be missing")
            else:
                for rel in out.split(b"\0"):
                    if rel:
                        candidates.add(os.path.join(before.root, os.fsdecode(rel)))
                if len(candidates) > MAX_GIT_ENTRIES:
                    cell.note_incomplete("too many files changed by commands to list")
                    return
        need_blob: list[str] = []
        pending: list[tuple[str, _Content | None]] = []
        for path in sorted(candidates):
            with self.lock:
                if path in cell.files:
                    continue
            if self.classify(path) is None:
                continue
            current = _entry_sig(path)
            if path in before.entries:
                prior = before.stats.get(path)
                if prior == current:
                    continue
                if prior is None:
                    pending.append((path, _ABSENT))
                    continue
                data = self.cache.get(path, prior)
                pending.append(
                    (path, _Content("bytes", data, prior) if data is not None else _Content("unknown", None, prior, "no_baseline"))
                )
                continue
            if after.entries.get(path) == "??":
                if current is not None:
                    # A new file already gone again (a tool's temp file) is no creation.
                    pending.append((path, _ABSENT))
                continue
            if before.oid is None:
                pending.append((path, _UNKNOWN))
                continue
            need_blob.append(path)
            pending.append((path, None))
        blobs: dict[str, bytes | None] = {}
        if need_blob:
            wanted = need_blob[:MAX_GIT_BLOBS]
            if len(need_blob) > MAX_GIT_BLOBS:
                cell.note_incomplete("too many files changed by commands to diff them all")
            specs = [f"{before.oid}:{os.path.relpath(path, before.root)}" for path in wanted]
            fetched = self.blobs(before.root, specs, deadline)
            blobs = {path: fetched.get(spec) for path, spec in zip(wanted, specs)}
        for path, baseline in pending:
            if baseline is None:
                data = blobs.get(path)
                if data is _MISSING:
                    baseline = _ABSENT
                else:
                    baseline = _Content("bytes", data) if data is not None else _UNKNOWN
            changes.append((path, baseline))

    def _compare_scan(
        self,
        cell: _Cell,
        root: str,
        before: dict[str, tuple[int, int]],
        deadline: float,
        changes: list[tuple[str, _Content]],
        ended: _After | None = None,
    ) -> None:
        after = self.scan(root, deadline)
        if after is None:
            cell.note_incomplete("the working directory is too large to scan for command changes")
            return
        if ended is not None:
            ended.scan = (root, after)
        for path in sorted(set(before) | set(after)):
            prior = before.get(path)
            if prior == after.get(path):
                continue
            with self.lock:
                if path in cell.files:
                    continue
            if self.classify(path) is None:
                continue
            if prior is None:
                if _entry_sig(path) is not None:
                    changes.append((path, _ABSENT))
                continue
            if prior[0] == _LINK_SIZE:
                changes.append((path, _Content("link", None, prior)))
                continue
            data = self.cache.get(path, prior)
            changes.append(
                (
                    path,
                    _Content("bytes", data, prior) if data is not None else _Content("unknown", None, prior, "no_baseline"),
                )
            )

    # --------------------------------------------------------------- records

    def build(self, cell: _Cell, rec: _FileRec, info: _PathInfo, sig: tuple[int, int] | None) -> dict[str, Any] | None:
        """The record for one file, or None when it ends up as it started."""
        base = rec.baseline
        cheap = cell.gave_up is not None
        final: _Content
        if sig is None:
            final = _ABSENT
        elif sig[0] == _LINK_SIZE:
            final = _link_content(rec.path, sig)
        elif cheap:
            final = _Content("unknown", None, sig, "budget")
        elif sig[0] > MAX_BASELINE_FILE_BYTES:
            final = _Content("large", None, sig)
        else:
            data = _read_file(rec.path, MAX_BASELINE_FILE_BYTES)
            final = _Content("bytes", data, sig) if data is not None else _Content("unknown", None, sig, "no_baseline")
            if data is not None:
                self.cache.put(rec.path, sig, data)
        if not base.exists and not final.exists:
            return None
        if not final.exists:
            kind = "deleted"
        elif not base.exists:
            kind = "created"
        elif rec.old_path:
            kind = "renamed"
        else:
            kind = "modified"
        link = base.state == "link" or final.state == "link"
        if kind == "modified":
            if base.state == final.state and base.state in ("bytes", "link") and base.data == final.data:
                return None
            if base.sig is not None and base.sig == final.sig and base.state != "bytes":
                return None
        change: dict[str, Any] = {"path": rec.path}
        if info.rel is not None:
            change["relPath"] = info.rel
        change["kind"] = kind
        if kind == "renamed" and rec.old_path:
            change["oldPath"] = rec.old_path
        change["scope"] = info.scope
        if link:
            # The link itself changed; its target's lines are not this file's lines.
            change.update({"added": 0, "removed": 0, "symlink": True, "source": rec.source, "at": _now_ms()})
            return change
        added = removed = 0
        diff_lines: list[str] | None = None
        omitted: str | None = None
        binary = False
        old_data = b"" if not base.exists else base.data
        new_data = b"" if not final.exists else final.data
        if cheap:
            omitted = "budget"
        elif old_data is not None and new_data is not None:
            old_text = _decode_text(old_data)
            new_text = _decode_text(new_data)
            if old_text is None or new_text is None:
                binary = True
            else:
                old_label = "/dev/null" if not base.exists else self._diff_label("a", rec.old_path or rec.path)
                new_label = "/dev/null" if not final.exists else self._diff_label("b", rec.path)
                diff_lines, added, removed = _unified_diff(old_text, new_text, old_label, new_label)
                if diff_lines is None:
                    omitted = "too_large"
        else:
            missing = base if old_data is None else final
            omitted = missing.why or ("too_large" if missing.state == "large" else "no_baseline")
            if kind == "created":
                if new_data is not None:
                    if _decode_text(new_data) is None:
                        binary = True
                    else:
                        added = _line_total(new_data)
                else:
                    added = _count_lines(rec.path) or 0
            elif kind == "deleted" and old_data is not None:
                if _decode_text(old_data) is None:
                    binary = True
                else:
                    removed = _line_total(old_data)
        change["added"] = added
        change["removed"] = removed
        if diff_lines is not None:
            text, truncated = _cap_diff(diff_lines)
            room = MAX_DIFF_CHARS_PER_CELL - (cell.diff_chars - rec.diff_chars)
            if _sensitive_path(rec.path) or _sensitive_path(rec.old_path) or _looks_secret(text):
                omitted = SENSITIVE
                cell.diff_chars -= rec.diff_chars
                rec.diff_chars = 0
            elif len(text) > room:
                omitted = "budget"
            else:
                cell.diff_chars += len(text) - rec.diff_chars
                rec.diff_chars = len(text)
                change["diff"] = text
                if truncated:
                    change["diffTruncated"] = True
        if binary:
            change["binary"] = True
        elif omitted is not None and "diff" not in change:
            change["diffOmitted"] = omitted
        change["source"] = rec.source
        change["at"] = _now_ms()
        return change

    def publish(self, cell: _Cell, rec: _FileRec) -> None:
        info = self.classify(rec.path)
        if info is None or rec.ignored:
            return
        sig = _entry_sig(rec.path)
        rec.dirty = False
        rec.published_sig = sig
        change = self.build(cell, rec, info, sig)
        if change is None:
            if rec.emitted_key is not None:
                self.retract(cell, rec.path)
                rec.emitted_key = None
            rec.last_change = None
            return
        key = (
            change["kind"],
            change.get("oldPath"),
            change["added"],
            change["removed"],
            change.get("diff"),
            change.get("binary"),
            change.get("diffOmitted"),
        )
        rec.last_change = change
        if key == rec.emitted_key:
            return
        self.send(cell.id, {FILE_CHANGE_MIME: change})
        rec.emitted_key = key

    def publish_all(self, cell: _Cell, final: bool, deadline: float) -> None:
        with self.lock:
            recs = list(cell.files.values())
        if not recs:
            return
        if cell.gave_up is None and not self.filter_ignored(recs, deadline):
            # Listing a file git ignores beats hiding a real change; the cell says why.
            cell.note_incomplete(_IGNORE_UNKNOWN)
        for rec in recs:
            if cell.gave_up is None and _left(deadline) <= 0:
                # Past the budget the remaining records are still sent, from a stat only (no diff).
                cell.gave_up = f"time budget of {int(cell.budget_s * 1000)} ms used up"
            if rec.dirty or rec.published_sig == "unset" or _entry_sig(rec.path) != rec.published_sig:
                self.publish(cell, rec)
        if final:
            for rec in recs:
                self._publish_rules_memory(cell, rec)

    def _publish_rules_memory(self, cell: _Cell, rec: _FileRec) -> None:
        change = rec.last_change
        info = self.classify(rec.path)
        if change is None or info is None or info.rules_scope is None or rec.ignored:
            return
        op = {"created": "created", "deleted": "deleted"}.get(change["kind"], "updated")
        memory: dict[str, Any] = {
            "op": op,
            "kind": "rules_file",
            "scope": info.rules_scope,
            "id": rec.path,
            "title": info.display,
        }
        before = rec.baseline.data if rec.baseline.state == "bytes" else None
        if before is not None and op != "created":
            text = _decode_text(before)
            if text is not None:
                memory["before"] = _clip(text, MAX_MEMORY_TEXT)
        if op != "deleted":
            after = self.cache.get(rec.path, _entry_sig(rec.path))
            text = _decode_text(after) if after is not None else None
            if text is not None:
                memory["after"] = _clip(text, MAX_MEMORY_TEXT)
        _withhold_memory_texts(memory, change.get("diffOmitted") == SENSITIVE)
        memory["at"] = _now_ms()
        self.send(cell.id, {MEMORY_CHANGE_MIME: memory})

    # --------------------------------------------------------------- watcher

    def _wake_watcher(self) -> None:
        if self.watcher is None:
            self.watcher = threading.Thread(target=self._watch_loop, daemon=True, name="rlm-change-watch")
            self.watcher.start()
        self.wake.set()

    def _watch_loop(self) -> None:
        self.local.busy = True
        while True:
            try:
                self.wake.wait()
                time.sleep(WATCH_INTERVAL_S)
                cell = self.cell
                if cell is None:
                    self.wake.clear()
                    continue
                if not cell.closing and cell.gave_up is None and cell.background_left():
                    started = time.perf_counter()
                    try:
                        self._tick(cell)
                    except Exception:  # noqa: BLE001 - a live report is best effort
                        pass
                    finally:
                        cell.charge_background(time.perf_counter() - started)
                with self.lock:
                    if (
                        self.cell is not cell
                        or cell.closing
                        or cell.gave_up is not None
                        or not cell.background_left()
                        or not (cell.shell_check_pending or any(rec.dirty for rec in cell.files.values()))
                    ):
                        self.wake.clear()
                # Held across the wait, it would keep a finished cell's baselines alive until the next write.
                cell = None
            except BaseException:  # noqa: BLE001 - interpreter teardown must not trace back
                return

    def _tick(self, cell: _Cell) -> None:
        now = time.perf_counter()
        changes: list[tuple[str, _Content]] | None = None
        if cell.shell_check_pending and now - cell.last_shell_check >= LIVE_SHELL_CHECK_INTERVAL_S:
            # Computed without the work lock: the cell's end must never wait for a live git status.
            cell.shell_check_pending = False
            cell.last_shell_check = now
            try:
                changes = self.shell_changes(cell, now + cell.budget_s)
            except _OutOfTime:
                changes = None  # live only; the final comparison runs again at the cell's end
        with cell.work_lock:
            if cell.closing:
                return
            if changes:
                self.apply_shell_changes(cell, changes)
            deadline = time.perf_counter() + WATCH_TICK_BUDGET_S
            with self.lock:
                recs = [rec for rec in cell.files.values() if rec.dirty]
            ready: list[_FileRec] = []
            for rec in recs:
                sig = _entry_sig(rec.path)
                if rec.sig != "unset" and sig == rec.sig:
                    ready.append(rec)
                else:
                    rec.sig = sig
            if not ready or not self.filter_ignored(ready, deadline):
                return  # unanswered ignore rules: they stay dirty and are asked again next tick
            for rec in ready:
                if _left(deadline) <= 0:
                    return  # the rest stay dirty for the next tick
                with self.lock:
                    if cell.closing or cell.files.get(rec.path) is not rec:
                        continue
                self.publish(cell, rec)

    # ------------------------------------------------------------ activities

    def send_activity(self, cell_id: str | None, activity: dict[str, Any]) -> None:
        if cell_id is None:
            return
        self.send(cell_id, {ACTIVITY_MIME: activity})

    def background_completion(self, record: dict[str, Any]) -> None:
        """A background command ended: report it in the running cell, or hold it for the next one."""
        with self.lock:
            cell = self.cell
            if cell is None or cell.closing:
                self.pending_completions.append(record)
                if len(self.pending_completions) > MAX_PENDING_COMPLETIONS:
                    del self.pending_completions[0]
                    self.lost_completions += 1
                return
            # Sent under the lock: the cell cannot finish between being chosen here and the record going out.
            self.send_activity(cell.id, record)

    def memory_change(self, record: dict[str, Any]) -> None:
        cell = self.cell
        if cell is None:
            return
        key = (record["kind"], record["scope"], record["id"])
        retract = False
        with self.lock:
            prior = cell.memory.get(key)
            if prior is not None:
                first_op = prior["op"]
                op = record["op"]
                if first_op == "created" and op == "deleted":
                    del cell.memory[key]
                    retract = True
                else:
                    if first_op == "created":
                        record["op"] = "created"
                        record.pop("before", None)
                    elif first_op == "deleted" and op == "created":
                        record["op"] = "updated"
                    if first_op != "created" and "before" in prior:
                        record["before"] = prior["before"]
                    elif first_op != "created":
                        record.pop("before", None)
                    first_title = prior.get("previousTitle", prior["title"])
                    if record["op"] != "created" and first_title != record["title"]:
                        record["previousTitle"] = first_title
                    else:
                        record.pop("previousTitle", None)
            if not retract:
                # Once withheld in a cell, an entry stays withheld: its earlier text held the secret.
                _withhold_memory_texts(record, prior is not None and prior.get("textOmitted") == SENSITIVE)
                cell.memory[key] = record
        if retract:
            self.send(cell.id, {MEMORY_CHANGE_MIME: {"kind": key[0], "scope": key[1], "id": key[2], "retracted": True}})
        else:
            self.send(cell.id, {MEMORY_CHANGE_MIME: record})


# ------------------------------------------------------------------ wrappers
#
# Each wrapper reads one module global and returns straight to the real function when no
# cell is being tracked; while one is, a read-only open costs a mode check and a set
# lookup, and only writes do real work (a stat and, for small files, one read of the old
# content). Errors inside the bookkeeping are contained in `guarded`; the real call's own
# result and exceptions pass through untouched.


def _is_write_mode(mode: Any) -> bool:
    return type(mode) is str and ("w" in mode or "a" in mode or "x" in mode or "+" in mode)


def _make_open(real: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(real)
    def open(file: Any, mode: Any = "r", *args: Any, **kwargs: Any) -> Any:  # noqa: A001 - mirrors builtins.open
        tracker = _tracker
        if tracker is not None and tracker.cell is not None and type(file) is not int:
            cell = tracker.active()
            if cell is not None:
                if _is_write_mode(mode):
                    tracker.guarded(cell, lambda: tracker.on_write(cell, file))
                elif len(cell.read_paths) < MAX_READ_ACTIVITIES and not (
                    type(file) is str and file in cell.read_keys
                ):
                    tracker.guarded(cell, lambda: tracker.on_read(cell, file))
        return real(file, mode, *args, **kwargs)

    return open


def _make_os_open(real: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(real)
    def open(path: Any, flags: int, *args: Any, **kwargs: Any) -> Any:  # noqa: A001 - mirrors os.open
        tracker = _tracker
        if tracker is not None and tracker.cell is not None and flags & _WRITE_FLAGS and kwargs.get("dir_fd") is None:
            cell = tracker.active()
            if cell is not None:
                tracker.guarded(cell, lambda: tracker.on_write(cell, path))
        return real(path, flags, *args, **kwargs)

    return open


def _make_remove(real: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(real)
    def remove(path: Any, *args: Any, **kwargs: Any) -> Any:
        tracker = _tracker
        if tracker is not None and tracker.cell is not None and not args and kwargs.get("dir_fd") is None:
            cell = tracker.active()
            if cell is not None:
                tracker.guarded(cell, lambda: tracker.on_write(cell, path, deleting=True))
        return real(path, *args, **kwargs)

    return remove


def _make_truncate(real: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(real)
    def truncate(path: Any, *args: Any, **kwargs: Any) -> Any:
        tracker = _tracker
        if tracker is not None and tracker.cell is not None and type(path) is not int:
            cell = tracker.active()
            if cell is not None:
                tracker.guarded(cell, lambda: tracker.on_write(cell, path))
        return real(path, *args, **kwargs)

    return truncate


def _make_rename(real: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(real)
    def rename(src: Any, dst: Any, *args: Any, **kwargs: Any) -> Any:
        tracker = _tracker
        plan = None
        cell = None
        if (
            tracker is not None
            and tracker.cell is not None
            and not args
            and kwargs.get("src_dir_fd") is None
            and kwargs.get("dst_dir_fd") is None
        ):
            cell = tracker.active()
            if cell is not None:
                plan = tracker.guarded(cell, lambda: tracker.pre_rename(cell, src, dst))
        result = real(src, dst, *args, **kwargs)
        if plan is not None and cell is not None and tracker is not None:
            tracker.guarded(cell, lambda: tracker.post_rename(cell, plan))
        return result

    return rename


def _make_rmtree(real: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(real)
    def rmtree(path: Any, *args: Any, **kwargs: Any) -> Any:
        tracker = _tracker
        if tracker is not None and tracker.cell is not None and kwargs.get("dir_fd") is None:
            cell = tracker.active()
            if cell is not None:
                tracker.guarded(cell, lambda: tracker.on_rmtree(cell, path))
        return real(path, *args, **kwargs)

    return rmtree


def _spawn_hook() -> None:
    tracker = _tracker
    if tracker is None or tracker.cell is None:
        return
    cell = tracker.active()
    if cell is not None:
        tracker.guarded(cell, lambda: tracker.request_snapshot(cell, os.getcwd(), wait=True))


def _make_spawn(real: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(real)
    def spawn(*args: Any, **kwargs: Any) -> Any:
        _spawn_hook()
        return real(*args, **kwargs)

    return spawn


def _install_wrappers() -> None:
    global _installed
    if _installed:
        return
    import builtins
    import shutil

    tracked_open = _make_open(io.open)
    # One object for both names, so `open is io.open` keeps holding.
    builtins.open = tracked_open
    io.open = tracked_open
    os.open = _make_os_open(os.open)
    os.remove = _make_remove(os.remove)
    os.unlink = _make_remove(os.unlink)
    os.truncate = _make_truncate(os.truncate)
    os.rename = _make_rename(os.rename)
    os.replace = _make_rename(os.replace)
    shutil.rmtree = _make_rmtree(shutil.rmtree)
    real_init = subprocess.Popen.__init__

    @functools.wraps(real_init)
    def popen_init(self: subprocess.Popen[Any], *args: Any, **kwargs: Any) -> None:
        _spawn_hook()
        real_init(self, *args, **kwargs)

    subprocess.Popen.__init__ = popen_init  # type: ignore[method-assign]
    for name in ("system", "posix_spawn", "posix_spawnp"):
        real = getattr(os, name, None)
        if real is not None:
            setattr(os, name, _make_spawn(real))
    _installed = True


def _disable_in_child() -> None:
    # A forked child must never write protocol frames on the parent's channel.
    global _tracker
    _tracker = None


# ------------------------------------------------------------------ public API


def enabled() -> bool:
    return _tracker is not None


def tracking_requested() -> bool:
    return (os.environ.get(ENABLE_ENV_VAR) or "1").strip().lower() not in ("0", "false", "off", "no")


def install(sender: _Sender, cwd: str | None = None) -> bool:
    """Start tracking for this process unless the host turned it off. Returns whether it is on.

    Nothing is wrapped when tracking is off, so a host that disables it pays nothing.
    """
    global _tracker
    if _tracker is not None:
        return True
    if not tracking_requested():
        return False
    budget_s = DEFAULT_CELL_BUDGET_S
    raw_budget = os.environ.get(BUDGET_ENV_VAR)
    if raw_budget:
        try:
            budget_s = max(0.001, int(raw_budget) / 1000)
        except ValueError:
            pass
    try:
        tracker = _Tracker(sender, cwd or os.getcwd(), budget_s)
        _install_wrappers()
        if hasattr(os, "register_at_fork"):
            os.register_at_fork(after_in_child=_disable_in_child)
    except Exception:  # noqa: BLE001 - tracking that cannot start stays off
        return False
    _tracker = tracker
    return True


def begin_cell(cell_id: str) -> None:
    tracker = _tracker
    if tracker is None:
        return
    try:
        tracker.begin_cell(cell_id)
    except Exception:  # noqa: BLE001
        pass


def end_cell(cell_id: str) -> bool:
    """Ship the cell's final records. True when an interrupt landed while doing so."""
    tracker = _tracker
    if tracker is None:
        return False
    try:
        return tracker.end_cell(cell_id)
    except Exception:  # noqa: BLE001
        return False


def discard_cell(cell_id: str) -> None:
    tracker = _tracker
    if tracker is None:
        return
    try:
        tracker.discard_cell(cell_id)
    except Exception:  # noqa: BLE001
        pass


class write_source:  # noqa: N801 - used as a context manager, reads like a function
    """Attribute writes inside the block to a named writer (e.g. ``"edit"``) instead of plain Python."""

    def __init__(self, source: str) -> None:
        self._source = source
        self._token: contextvars.Token[str | None] | None = None

    def __enter__(self) -> write_source:
        self._token = _write_source.set(self._source)
        return self

    def __exit__(self, *exc: object) -> None:
        if self._token is not None:
            _write_source.reset(self._token)
            self._token = None


class untracked:  # noqa: N801 - used as a context manager, reads like a function
    """Keep file writes inside the block out of the change list: they are reported another way."""

    def __init__(self) -> None:
        self._token: contextvars.Token[bool] | None = None

    def __enter__(self) -> untracked:
        self._token = _untracked.set(True)
        return self

    def __exit__(self, *exc: object) -> None:
        if self._token is not None:
            _untracked.reset(self._token)
            self._token = None


class Step:
    """One step reported to the host: running from creation until `finish()` or the end of a `with` block.

    A no-op when tracking is off or no cell is running, so callers never need to check.
    """

    def __init__(self, kind: str, label: str) -> None:
        self.kind = kind
        self.id = f"{kind}-{next(_ids)}"
        self.label = _one_line(label, MAX_LABEL) or kind
        self.started_at = _now_ms()
        self.done = False
        tracker = _tracker
        cell = tracker.cell if tracker is not None else None
        # Updates keep the cell that started the step: a background step never lands on a later cell.
        self._cell_id = cell.id if cell is not None else None
        self._send({"status": "running"})

    def _send(self, fields: dict[str, Any]) -> None:
        tracker = _tracker
        if tracker is None or self._cell_id is None:
            return
        tracker.send_activity(
            self._cell_id,
            {"id": self.id, "kind": self.kind, "label": self.label, "startedAt": self.started_at, **fields},
        )

    def update(self, detail: str) -> None:
        if not self.done:
            fields: dict[str, Any] = {"status": "running"}
            safe = _safe_detail(detail, MAX_DETAIL)
            if safe:
                fields["detail"] = safe
            self._send(fields)

    def finish(
        self,
        status: str = "ok",
        detail: str | None = None,
        label: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        if self.done:
            return
        self.done = True
        if label:
            self.label = _one_line(label, MAX_LABEL)
        fields: dict[str, Any] = {"status": "ok" if status == "ok" else "error", "endedAt": _now_ms()}
        if detail:
            safe = _safe_detail(detail, MAX_DETAIL)
            if safe:
                fields["detail"] = safe
        if extra:
            fields.update(extra)
        self._send(fields)

    def __enter__(self) -> Step:
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        if exc is None:
            self.finish("ok")
        else:
            self.finish("error", f"{type(exc).__name__}: {exc}")

    async def __aenter__(self) -> Step:
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.__exit__(exc_type, exc, tb)


def step(kind: str, label: str) -> Step:
    """Start a step of `kind` ("command", "read", "search", "fetch", "subagent")."""
    try:
        return Step(kind, label)
    except Exception:  # noqa: BLE001 - reporting must never fail the caller
        return _NULL_STEP


class _NullStep(Step):
    def __init__(self) -> None:
        self.kind = "command"
        self.id = ""
        self.label = ""
        self.started_at = 0
        self.done = True
        self._cell_id = None


_NULL_STEP = _NullStep()


def reported(
    kind: str,
    label: Callable[..., str],
    outcome: Callable[[Any], tuple[str, str | None]] | None = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Decorate an async skill function so each call shows as one step in the host's feed.

    `label(*args, **kwargs)` names the step (a URL, a query); `outcome(result)` returns
    `(status, detail)` for the finished step. Neither may affect the call: a label or outcome
    that raises only costs the step its text, and the function's result and exceptions pass
    through untouched.
    """

    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            try:
                text = str(label(*args, **kwargs))
            except Exception:  # noqa: BLE001
                text = kind
            current = step(kind, text)
            try:
                result = await fn(*args, **kwargs)
            except BaseException as exc:
                current.finish("error", f"{type(exc).__name__}: {exc}")
                raise
            status, detail = "ok", None
            if outcome is not None:
                try:
                    status, detail = outcome(result)
                except Exception:  # noqa: BLE001
                    status, detail = "ok", None
            current.finish(status, detail)
            return result

        return wrapper

    return decorate


# `[<branch> <sha>]`, `[<branch> (root-commit) <sha>]`, `[detached HEAD <sha>]`; branch names hold no spaces.
_COMMIT_LINE = re.compile(r"^\[(?:detached HEAD|[^\s\[\]]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] ", re.M)
_GIT_WORD = re.compile(r"\bgit\b")


def _commit_id(command: str, exit_code: int, output: str) -> str | None:
    """The commit a successful git command reported (`[main 1a2b3c4] subject`), the last one if several."""
    if exit_code != 0 or not _GIT_WORD.search(command):
        return None
    found = _COMMIT_LINE.findall(output)
    return found[-1] if found else None


class CommandStep:
    """The live step of one bash() command: its latest output line (at most ~2/s), then the outcome.

    A command still running when its cell ends becomes a background step: the cell's last record for
    it says so (`background: true`, `endedAt` = the cell's end), and its eventual outcome is reported,
    with the same id, in whichever cell is running then (or at the next cell's start).

    Every record of the step is sent under its lock, and `finish` leaves the cell's command set only
    after its final record went out. So the cell's end (which moves each command still in the set to
    the background under that lock) either waits for a final record already on its way or turns it
    into a background completion: nothing of the step reaches its cell after the cell's `done`.
    """

    def __init__(self, command: str) -> None:
        self._step = Step("command", command)
        self._command = command
        self._last_update = 0.0
        self._tail = b""
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()
        self._background = False
        self._finished = False
        tracker = _tracker
        self._cell = tracker.cell if tracker is not None else None
        if tracker is not None and self._cell is not None:
            with tracker.lock:
                self._cell.commands.add(self)

    def move_to_background(self, ended_at: int) -> None:
        with self._lock:
            if self._finished or self._background:
                return
            self._background = True
            timer, self._timer = self._timer, None
            self._step._send({"status": "running", "background": True, "endedAt": ended_at})
        if timer is not None:
            timer.cancel()
        # A dev server can run for hours: it must not keep its cell's snapshots and baselines alive.
        self._leave_cell()

    def _leave_cell(self) -> None:
        tracker = _tracker
        cell, self._cell = self._cell, None
        if tracker is not None and cell is not None:
            with tracker.lock:
                cell.commands.discard(self)

    def output(self, chunk: bytes) -> None:
        try:
            now = time.monotonic()
            with self._lock:
                self._tail = (self._tail + chunk)[-2048:]
                wait = COMMAND_UPDATE_INTERVAL_S - (now - self._last_update)
                if wait > 0:
                    if self._timer is None and not self._step.done:
                        # Trailing update: a command that goes quiet still shows its newest line.
                        self._timer = threading.Timer(wait, self._flush)
                        self._timer.daemon = True
                        self._timer.start()
                    return
                self._last_update = now
                self._show()
        except Exception:  # noqa: BLE001 - reporting must never disturb the command's pump
            pass

    def _flush(self) -> None:
        try:
            with self._lock:
                self._timer = None
                self._last_update = time.monotonic()
                self._show()
        except Exception:  # noqa: BLE001
            pass

    def _show(self) -> None:
        """Send the newest output line; the caller holds the lock."""
        if self._background or self._finished:
            return  # a running update must never follow the outcome, or land in a later cell
        line = _last_line(self._tail.decode("utf-8", "replace"))
        if line:
            self._step.update(line)

    def finish(self, exit_code: int, output: str) -> None:
        try:
            status = "ok" if exit_code == 0 else "error"
            detail = _command_summary(exit_code, output)
            commit = _commit_id(self._command, exit_code, output)
            tracker = _tracker
            with self._lock:
                timer, self._timer = self._timer, None
                self._finished = True
                background = self._background
                if not background:
                    self._step.finish(status, detail, extra={"commit": commit} if commit else None)
            if timer is not None:
                timer.cancel()
            self._leave_cell()
            if background:
                step = self._step
                step.done = True
                record: dict[str, Any] = {
                    "id": step.id,
                    "kind": step.kind,
                    "label": step.label,
                    "startedAt": step.started_at,
                    "status": status,
                    "endedAt": _now_ms(),
                    "background": True,
                }
                if detail:
                    safe = _safe_detail(detail, MAX_DETAIL)
                    if safe:
                        record["detail"] = safe
                if commit:
                    record["commit"] = commit
                if tracker is not None:
                    tracker.background_completion(record)
            if tracker is not None:
                tracker.request_shell_check()
        except Exception:  # noqa: BLE001
            pass


def command_started(command: str) -> CommandStep | None:
    tracker = _tracker
    if tracker is None or tracker.cell is None:
        return None
    try:
        return CommandStep(command)
    except Exception:  # noqa: BLE001
        return None


_MEMORY_KINDS = {"prompt": "prompt_note", "memory": "memory", "skill": "skill", "subagent": "subagent"}


def memory_change(
    op: str,
    harness_kind: str,
    harness_scope: str,
    entry_id: str,
    title: str,
    *,
    previous_title: str | None = None,
    before: str | None = None,
    after: str | None = None,
) -> None:
    """Report one harness entry write (create/update/delete). Several writes to one entry in a cell merge."""
    tracker = _tracker
    if tracker is None or tracker.cell is None:
        return
    try:
        record: dict[str, Any] = {
            "op": op,
            "kind": _MEMORY_KINDS.get(harness_kind, harness_kind),
            "scope": "global" if harness_scope == "global" else "session",
            "id": entry_id,
            "title": title,
        }
        if previous_title is not None and previous_title != title:
            record["previousTitle"] = previous_title
        if before is not None:
            record["before"] = _clip(before, MAX_MEMORY_TEXT)
        if after is not None:
            record["after"] = _clip(after, MAX_MEMORY_TEXT)
        record["at"] = _now_ms()
        tracker.memory_change(record)
    except Exception:  # noqa: BLE001
        pass
