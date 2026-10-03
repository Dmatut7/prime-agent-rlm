"""Persistent harness-state helpers for Prime Agent's RLM kernel.

The state model is intentionally small: it records prompt notes, memory,
skills, subagent specs, and refinement events in the session-local harness
store by default; pass ``global_=True`` for the cross-session global store.
Execution still belongs to Prime Agent's TypeScript host and the existing
``rlm.run`` recursion bridge.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
import re
import stat
import threading
import unicodedata
from dataclasses import asdict, dataclass, field, fields, replace
from datetime import datetime, timezone
from pathlib import Path
from collections.abc import Generator
from typing import Any, Literal, Mapping, NamedTuple, Sequence

from . import effects
from ._yaml_compat import register_plain_list, register_plain_str

try:
    import fcntl
except ImportError:  # Windows: states are in-memory there and never lock
    fcntl = None  # type: ignore[assignment]

HarnessKind = Literal["prompt", "memory", "skill", "subagent"]
HarnessScope = Literal["local", "global"]

_DEFAULT_FILE_NAME = "harness_state.json"
_DEFAULT_HARNESS_DIR_NAME = "harness"
WINDOWS_PERSISTENCE_UNSUPPORTED_ERROR = "Persistent harness storage is unsupported on Windows"
_KINDS: tuple[HarnessKind, ...] = ("prompt", "memory", "skill", "subagent")
# The overflow catalog in overview() names hidden entries one line each; cap it
# so a huge store cannot turn the digest into the dump the window was avoiding.
_OVERFLOW_CATALOG_MAX = 50
# Advisory near-duplicate gate on memory writes. The threshold was calibrated
# against the production global store (1576 memories, 2026-10-03): the score
# band (0.311, 0.405) is empty there, every pair at 0.55+ is a true
# same-rule rewrite pair, and 0.40-0.55 adds three more true pairs against one
# borderline. Evidence: docs/fork/evidence/harness-near-duplicate-write-gate.md.
_NEAR_DUPLICATE_SIMILARITY_MIN = 0.40
_NEAR_DUPLICATE_MAX_MATCHES = 3
# Stage-2 (memory-recall-design.md) write-side index byte cap: the digest's
# compact id+title index layer is byte-capped, and a create/update that would
# grow the index past the cap is refused with consolidation guidance, while
# deletes and content-only updates always pass - the Claude Code MEMORY.md
# hard-cap error loop. Sized so the two-layer digest stays within the design
# red line (digest face <= 2x the pre-stage-2 face, 13,817 bytes on the
# 2026-10-03 production store). The TS /refine path enforces the same default
# (DEFAULT_HARNESS_INDEX_MAX_BYTES in refinement.ts). `0` disables the gate.
DEFAULT_HARNESS_INDEX_MAX_BYTES = 12 * 1024
_INDEX_MAX_BYTES_ENV = "PRIME_AGENT_HARNESS_INDEX_MAX_BYTES"
# Index titles are capped here; the id stays whole because it is the address.
_INDEX_TITLE_MAX_CHARS = 120

# Consolidation (memory-recall-design.md stage 3): a callable merge pass that
# shrinks the compact id+title index toward its byte cap. plan_consolidation()
# proposes merge/delete/rename operations (dry-run, read-only);
# apply_consolidation() executes an explicit plan. Parity: consolidation.ts.
# The merge threshold sits above the write-gate advisory (0.40): the 2026-10-03
# production histogram has an empty (0.40, 0.61) band and every pair at 0.55+
# is a true same-rule rewrite pair, so a suggested *action* list (not an
# advisory) takes the high-precision side of the gap.
# Evidence: docs/fork/evidence/harness-near-duplicate-write-gate.md.
CONSOLIDATION_MERGE_MIN_SCORE = 0.55
# Contained bodies shorter than this are not worth a delete suggestion.
CONSOLIDATION_STALE_MIN_CONTENT_CHARS = 40
CONSOLIDATION_PLAN_VERSION = 1
# Controlled first-segment vocabulary for entry paths: the production store
# collapsed into 602 free-form paths (538 singletons, duplicate clusters like
# arch/architecture). Writes outside the vocabulary get an advisory receipt -
# guidance, never a block. `policy` is the prompt-note default path and
# `general` the catch-all default, so both must stay. Kept identical to
# DEFAULT_HARNESS_PATH_VOCABULARY in refinement.ts.
DEFAULT_HARNESS_PATH_VOCABULARY: tuple[str, ...] = (
    "general",
    "policy",
    "discipline",
    "arch",
    "analysis",
    "project",
    "tooling",
    "environment",
    "governance",
    "testing",
    "research",
    "communication",
    "process",
    "delegation",
    "operations",
    "review",
    "preference",
)
_PATH_VOCABULARY_ENV = "PRIME_AGENT_HARNESS_PATH_VOCABULARY"
_state_cache: dict[tuple[Path, HarnessScope], "HarnessState"] = {}


_ENFORCE_INDEX_CAP_ENV = "PRIME_AGENT_HARNESS_ENFORCE_INDEX_CAP"


def _enforce_index_cap() -> bool:
    """Whether the index cap refuses net-growth writes. Default off: until the
    consolidation pass exists (memory design stage 3), the cap shapes the digest's
    display layer only; enforcing it on an over-cap store would freeze all growth."""
    raw = (os.environ.get(_ENFORCE_INDEX_CAP_ENV) or "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def _index_max_bytes() -> int:
    """The active write-side index cap; an unreadable env override falls back to the default."""
    if not _enforce_index_cap():
        return 0
    raw = (os.environ.get(_INDEX_MAX_BYTES_ENV) or "").strip()
    if not raw:
        return DEFAULT_HARNESS_INDEX_MAX_BYTES
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_HARNESS_INDEX_MAX_BYTES
    return max(0, value)


def _path_vocabulary() -> tuple[str, ...]:
    """The active first-segment path vocabulary; an empty env override falls back to the default."""
    raw = (os.environ.get(_PATH_VOCABULARY_ENV) or "").strip()
    if not raw:
        return DEFAULT_HARNESS_PATH_VOCABULARY
    entries = tuple(dict.fromkeys(part.strip() for part in raw.split(",") if part.strip()))
    return entries or DEFAULT_HARNESS_PATH_VOCABULARY


def _index_line(entry_id: str, scope: str, title: Any, path: Any) -> str:
    """The digest index line for one entry: `  - [scope:id] title (path)`.

    Byte-identical shape to `harnessIndexLine` in refinement.ts so the write
    caps on both faces measure the same line. Fields are flattened (X-8) and
    the title is code-point capped like the TS face.
    """
    flat_title = _flatten_inline(title) if isinstance(title, str) else ""
    if len(flat_title) > _INDEX_TITLE_MAX_CHARS:
        flat_title = f"{flat_title[: _INDEX_TITLE_MAX_CHARS - 3]}..."
    flat_id = _flatten_inline(entry_id) if isinstance(entry_id, str) else str(entry_id)
    flat_path = _flatten_inline(path) if isinstance(path, str) else "unknown"
    return f"  - [{scope}:{flat_id}] {flat_title} ({flat_path})"


def _index_line_bytes(entry: HarnessEntry) -> int:
    return len((_index_line(entry.id, entry.scope, entry.title, entry.path) + "\n").encode("utf-8"))


def _path_vocabulary_warning(path: Any) -> str | None:
    """Advisory receipt text for a path whose first segment is off-vocabulary."""
    first = path.strip().lower().split("/")[0] if isinstance(path, str) else ""
    if not first:
        return None
    vocabulary = _path_vocabulary()
    if first in {segment.strip().lower() for segment in vocabulary}:
        return None
    return (
        f"path 词表建议：'{_flatten_inline(first)}' 不在受控词表内（{'、'.join(vocabulary)}）；"
        "建议复用其一作为首段（可带子路径，如 discipline/code-review），确属新域可忽略。本次写入已完成。"
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _flatten_inline(text: str) -> str:
    # X-8: title/id/path/content are model-controlled. One entry must render as
    # one overview line, or a value carrying newlines forges extra lines - up to
    # a full fake `[global:...]` entry row in a trusted-state surface. TS-side
    # parity: refinement.ts compacts content the same way.
    return " ".join(text.split())


def _slug(raw: str, fallback: str) -> str:
    normalized = "".join(ch.lower() if ch.isalnum() else "_" for ch in raw.strip())
    normalized = "_".join(part for part in normalized.split("_") if part)
    return (normalized or fallback)[:80]


_CJK_TERM_CHARS = re.compile(
    r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af"
    r"\U00020000-\U0002a6df\U0002a700-\U0002b73f\U0002b740-\U0002b81f"
    r"\U0002b820-\U0002ceaf\U0002ceb0-\U0002ebef\U0002ebf0-\U0002ee5f"
    r"\U0002f800-\U0002fa1f\U00030000-\U0003134f\U00031350-\U000323af"
    r"\U000323b0-\U0003347f]"
)


def _harness_query_runs(text: str) -> list[str]:
    """Split lowercase text into word runs.

    Letters, digits, and combining marks of any script share a run;
    punctuation and symbols end it. Runs break only at CJK boundaries:
    accented Latin stays whole (naïve) while spacing-free CJK is cut
    apart from adjacent words it would otherwise swallow (修复login).
    """
    runs: list[str] = []
    run: list[str] = []
    run_is_cjk = False
    for ch in text:
        if unicodedata.category(ch).startswith("M") or ch.isalnum():
            ch_is_cjk = bool(_CJK_TERM_CHARS.match(ch))
            if run and ch_is_cjk != run_is_cjk:
                runs.append("".join(run))
                run = []
            run_is_cjk = ch_is_cjk
            run.append(ch)
        elif run:
            runs.append("".join(run))
            run = []
    if run:
        runs.append("".join(run))
    return runs


def _harness_query_terms(query: str) -> list[str]:
    """Tokenize a search query into lowercase substring terms.

    Letters and digits of every script form terms; punctuation and symbols
    only separate them, so ``worktree?`` never ranks entries by question
    marks. CJK runs carry no spaces between words, so each run becomes
    overlapping bigrams: ``修复登录`` yields ``修复``/``复登``/``登录`` and
    still matches an entry containing ``登录故障``. Each term counts once.
    Minimum lengths stay below the digest builder's four-character cut
    because ``search`` tokenizes explicit queries, not mined conversation:
    three ASCII characters keep real terms (rlm, api, cli), two characters
    keep short words of other scripts, and single characters are terms
    only for CJK, where one character is a word.
    """
    terms: list[str] = []
    seen: set[str] = set()
    for run in _harness_query_runs(query.lower()):
        if _CJK_TERM_CHARS.search(run):
            # Bigrams keep whitespace-free CJK findable without single
            # characters matching too loosely.
            candidates = [run[i : i + 2] for i in range(len(run) - 1)] or [run]
        elif run.isascii():
            candidates = [run] if len(run) >= 3 else []
        else:
            # Other scripts space out words: lone characters match too
            # broadly, so two characters is the floor.
            candidates = [run] if len(run) >= 2 else []
        for term in candidates:
            if term not in seen:
                seen.add(term)
                terms.append(term)
    return terms


_SEARCH_SNIPPET_WIDTH = 160


def _search_field(value: Any) -> str:
    # Persisted state is model-influenced JSON: a malformed non-string field
    # degrades to "no match" instead of breaking the query.
    return value.lower() if isinstance(value, str) else ""


def _search_recency(entry: "HarnessEntry") -> str:
    return entry.updated_at if isinstance(entry.updated_at, str) else ""


def _search_score(
    entry: "HarnessEntry",
    terms: Sequence[str],
    idf: Mapping[str, float] | None = None,
) -> float:
    """Weighted term overlap over the title, content, and identifier slots.

    Each matched term is discounted by its document frequency in the ranked
    corpus (``idf``); a missing map weights every term at 1.
    """
    title = _search_field(entry.title)
    content = _search_field(entry.content)
    # The id is usually embedded in the path, so matching both is one
    # identifier signal rather than two.
    identifier = _search_field(f"{entry.path} {entry.id}")
    total = 0.0
    for term in terms:
        slots = (term in title) + (term in content) + (term in identifier)
        if slots:
            total += (idf.get(term, 1.0) if idf is not None else 1.0) * (1 + (slots - 1) * 0.5)
    return total


def _search_snippet(text: str, terms: Sequence[str], width: int = _SEARCH_SNIPPET_WIDTH) -> str:
    """Return a one-line snippet centred on the first matching term.

    X-8: title and content are model-controlled, so the snippet is collapsed
    by the same whitespace rule the overview uses; a value carrying newlines
    must not forge extra lines in a search result.
    """
    flat = _flatten_inline(text)
    if not flat:
        return ""
    if len(flat) <= width:
        return flat
    lowered = flat.lower()
    position = -1
    for term in terms:
        found = lowered.find(term)
        if found >= 0 and (position < 0 or found < position):
            position = found
    if position < 0:
        position = 0
    start = max(0, min(position - width // 2, len(flat) - width))
    end = min(len(flat), start + width)
    prefix = "..." if start > 0 else ""
    suffix = "..." if end < len(flat) else ""
    return f"{prefix}{flat[start:end]}{suffix}"


def _agent_dir() -> Path:
    raw = (
        os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
        or os.environ.get("PI_CODING_AGENT_DIR")
        or str(Path.home() / ".prime" / "agent")
    )
    return Path(raw).expanduser().resolve()


def _resolve_global_flag(global_: bool = False, extra: dict[str, Any] | None = None) -> bool:
    extra = dict(extra or {})
    if "global" in extra:
        value = extra.pop("global")
        if not isinstance(value, bool):
            raise TypeError(f"global must be a bool, got {type(value).__name__}")
        global_ = value
    if extra:
        unexpected = next(iter(extra))
        raise TypeError(f"unexpected keyword argument {unexpected!r}")
    return bool(global_)


_SCOPE_PREFIX_PATTERN = re.compile(r"^\[?(global|local):")


def _strip_scope_prefix(
    id: str | None, global_: bool
) -> tuple[str | None, bool, str | None]:
    # overview() displays entries as [local:id]/[global:id]; accept those ids
    # verbatim, including clipped variants missing one bracket (MV-1). A
    # global: prefix routes to the global store unless the caller already
    # forced a scope via global_. The third value is the scope the id claimed
    # by its prefix, if any, so write paths can refuse a cross-store edit.
    if isinstance(id, str):
        match = _SCOPE_PREFIX_PATTERN.match(id)
        if match:
            rest = id[match.end():]
            if rest.endswith("]"):
                rest = rest[:-1]
            if rest:
                claimed = match.group(1)
                return rest, global_ or claimed == "global", claimed
    return id, global_, None


def _env_dir(name: str) -> str | None:
    # Set-but-empty env values must behave as unset; a bare "" would skip the
    # session-dir fallback and land local writes in the global agent-dir default.
    value = (os.environ.get(name) or "").strip()
    return value or None


def _state_file(state_dir: str | Path | None = None, *, global_: bool = False) -> Path:
    root: str | Path | None = state_dir
    if root is None:
        root = _env_dir("RLM_GLOBAL_HARNESS_STATE_DIR") if global_ else _env_dir("RLM_HARNESS_STATE_DIR")
    if root is None and not global_ and (session_dir := _env_dir("RLM_SESSION_DIR")):
        root = Path(session_dir) / _DEFAULT_HARNESS_DIR_NAME
    if root is None and not global_:
        raise RuntimeError(
            "Local harness state requires RLM_HARNESS_STATE_DIR or RLM_SESSION_DIR. "
            "Use get_harness_state(global_=True) for global state."
        )
    if root:
        return Path(os.path.abspath(Path(root).expanduser())) / _DEFAULT_FILE_NAME
    return _agent_dir() / _DEFAULT_HARNESS_DIR_NAME / _DEFAULT_FILE_NAME


def _require_no_follow() -> int:
    flag = getattr(os, "O_NOFOLLOW", None)
    if flag is None:
        raise OSError("Private file storage requires O_NOFOLLOW support")
    return flag


def _chmod_open_file(fd: int, path: Path, mode: int) -> None:
    if hasattr(os, "fchmod"):
        os.fchmod(fd, mode)
    else:
        path.chmod(mode)


def _ensure_private_directory(path: Path) -> None:
    target = Path(os.path.abspath(path))
    components = target.parts[1:]
    current = Path(target.anchor)
    for index, component in enumerate(components):
        current /= component
        try:
            info = current.lstat()
        except FileNotFoundError:
            current.mkdir(mode=0o700)
            info = current.lstat()
        if stat.S_ISLNK(info.st_mode):
            # Intermediate symlinks (e.g. a relocated ~/.prime) are legitimate
            # layouts and are followed after resolution; only the final target
            # keeps the O_NOFOLLOW refusal.
            if index == len(components) - 1:
                raise OSError(f"Refusing to use non-directory private path: {current}")
            current = current.resolve()
            continue
        if not stat.S_ISDIR(info.st_mode):
            raise OSError(f"Refusing to use non-directory private path: {current}")
    info = path.lstat()
    if os.name == "nt":
        path.chmod(0o700)
        return
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _require_no_follow()
    fd = os.open(path, flags)
    try:
        if not stat.S_ISDIR(os.fstat(fd).st_mode):
            raise OSError(f"Refusing to use non-directory private path: {path}")
        _chmod_open_file(fd, path, 0o700)
    finally:
        os.close(fd)

def _assert_no_symlinked_ancestors(path: Path) -> None:
    target = Path(os.path.abspath(path))
    current = Path(target.anchor)
    for component in target.parts[1:-1]:
        current /= component
        try:
            info = current.lstat()
        except FileNotFoundError:
            return
        if stat.S_ISLNK(info.st_mode):
            # Ancestor symlinks (e.g. a relocated ~/.prime) are followed after
            # resolution; only a symlinked state file itself is refused later.
            current = current.resolve()
            continue
        if not stat.S_ISDIR(info.st_mode):
            raise OSError(f"Refusing to use non-directory private path: {current}")


def _open_private_for_read(path: Path):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise OSError(f"Refusing to use non-regular private file: {path}")
    flags = os.O_RDONLY | _require_no_follow()
    fd = os.open(path, flags)
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise OSError(f"Refusing to use non-regular private file: {path}")
        _chmod_open_file(fd, path, 0o600)
        return os.fdopen(fd, "r", encoding="utf-8")
    except BaseException:
        os.close(fd)
        raise


def _write_private_json_atomic(path: Path, data: dict[str, Any]) -> None:
    _ensure_private_directory(path.parent)
    if os.path.lexists(path):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise OSError(f"Refusing to replace non-regular private file: {path}")
    import secrets

    temp_path = path.parent / f".{path.name}.{os.getpid()}.{secrets.token_hex(12)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | _require_no_follow()
    fd: int | None = None
    try:
        fd = os.open(temp_path, flags, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = None
            json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        if fd is not None:
            os.close(fd)
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


async def _resolved(value: Any) -> Any:
    return value


class _AwaitableResult:
    """Harness calls are synchronous; awaiting one anyway returns the same value."""

    def __await__(self) -> Generator[Any, None, Any]:
        return _resolved(self).__await__()


class AwaitableText(str):
    """A synchronous harness string result that also tolerates ``await``."""

    def __await__(self) -> Generator[Any, None, "AwaitableText"]:
        return _resolved(self).__await__()


register_plain_str(AwaitableText)


@dataclass
class HarnessEntry(_AwaitableResult):
    """A reusable prompt, memory, skill, or subagent record."""

    id: str
    kind: HarnessKind
    title: str
    content: str
    path: str = "general"
    scope: HarnessScope = "local"
    reference: dict[str, Any] = field(default_factory=dict)
    arguments: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    source: str = "agent"
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)
    version: int = 1
    # Write-time feedback set only on the receipt returned by a memory write
    # that landed near an existing entry; never on the stored entry, never
    # persisted, and excluded from equality so a warned receipt still compares
    # equal to the stored entry it describes.
    near_duplicate_warning: str | None = field(default=None, compare=False)
    # Receipt-only advisory set when a write chose a path whose first segment is
    # outside the controlled vocabulary; same never-persisted, never-compared
    # receipt plumbing as near_duplicate_warning.
    path_vocabulary_warning: str | None = field(default=None, compare=False)


@dataclass
class RefinementEvent(_AwaitableResult):
    """A recorded online harness-refinement pass."""

    id: str
    trigger: str
    changes: list[str]
    evidence: str = ""
    outcome: str = ""
    created_at: str = field(default_factory=_now)


class HarnessSearchHit(NamedTuple):
    """A ranked ``HarnessState.search`` hit: ``(kind, id, score, snippet)``.

    A NamedTuple so callers can unpack ``for kind, id, score, snippet in
    state.search(...)`` and still read ``hit.snippet`` by name.
    """

    kind: HarnessKind
    id: str
    score: float
    snippet: str


class AwaitableSearchHits(list[HarnessSearchHit], _AwaitableResult):
    """A synchronous ``HarnessState.search`` result list that also tolerates ``await``."""


register_plain_list(AwaitableSearchHits)


@dataclass
class ConsolidationOperation(_AwaitableResult):
    """One suggested consolidation action (memory-recall-design.md stage 3).

    merge: keep ``id`` (the near-duplicate cluster's canonical entry), rewrite
    its title/content (the content is the canonical body plus the absorbed
    entries' unique sentences as a bullet appendix) and delete ``absorb_ids``.
    delete: remove ``id``; ``reason`` says why (``contained:<id>`` when a
    surviving entry's normalized content fully contains it, ``stale:<n>d``
    when its last write is older than the requested age).
    rename: retitle ``id`` to ``title`` (title slimming; content untouched).
    """

    action: str  # "merge" | "delete" | "rename"
    kind: str
    id: str
    absorb_ids: tuple[str, ...] = ()
    title: str | None = None
    content: str | None = None
    path: str | None = None
    reason: str = ""
    score: float | None = None
    previous_title_chars: int | None = None


@dataclass
class ConsolidationPlan(_AwaitableResult):
    """Dry-run output of ``HarnessState.plan_consolidation``: the suggested
    operations plus the index byte math. Nothing is written; executing the plan
    requires an explicit ``apply_consolidation(plan)`` call. ``store_digest``
    pins the plan to the store it was computed from."""

    store_digest: str
    options: dict[str, Any]
    index_bytes_before: int
    index_bytes_after: int
    fits_cap: bool
    operations: list[ConsolidationOperation]
    stats: dict[str, int]
    version: int = CONSOLIDATION_PLAN_VERSION

    def __repr__(self) -> str:
        # Plans carry full entry contents; the REPL prints repr(result), so
        # summarize instead of dumping every operation's merged body.
        return (
            f"<ConsolidationPlan {len(self.operations)} operations "
            f"({self.stats.get('merges', 0)} merges, {self.stats.get('stale_deletes', 0)} stale deletes, "
            f"{self.stats.get('renames', 0)} renames); index {self.index_bytes_before} -> "
            f"{self.index_bytes_after} bytes, fits_cap={self.fits_cap}>"
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "store_digest": self.store_digest,
            "options": dict(self.options),
            "index_bytes_before": self.index_bytes_before,
            "index_bytes_after": self.index_bytes_after,
            "fits_cap": self.fits_cap,
            "operations": [asdict(operation) for operation in self.operations],
            "stats": dict(self.stats),
        }


@dataclass
class ConsolidationAppliedEdit(_AwaitableResult):
    """Receipt for one edit a consolidation apply attempted."""

    action: str  # "update" | "delete"
    kind: str
    id: str
    applied: bool
    error: str | None = None


@dataclass
class ConsolidationResult(_AwaitableResult):
    """Receipt returned by ``HarnessState.apply_consolidation``."""

    consolidation_id: str
    edits: list[ConsolidationAppliedEdit]
    index_bytes_before: int
    index_bytes_after: int
    fits_cap: bool
    state_path: str | None

    def __repr__(self) -> str:
        applied = sum(1 for edit in self.edits if edit.applied)
        return (
            f"<ConsolidationResult {self.consolidation_id}: {applied}/{len(self.edits)} edits applied; "
            f"index {self.index_bytes_before} -> {self.index_bytes_after} bytes, fits_cap={self.fits_cap}>"
        )


def _harness_store_digest(entries: Mapping[str, Mapping[str, HarnessEntry]]) -> str:
    """Plan-apply freshness token: sha256 over (kind, id, version, updated_at).

    Any create/update/delete moves it, so apply_consolidation can refuse a plan
    minted against an older store. Kinds iterate in the fixed ``_KINDS`` order
    and ids in sorted (code-point, i.e. UTF-8 lexicographic) order;
    ``harnessStoreDigest`` in consolidation.ts computes the identical string.
    """
    lines: list[str] = []
    for kind in _KINDS:
        records = entries.get(kind, {})
        for entry_id in sorted(records):
            entry = records[entry_id]
            updated = entry.updated_at if isinstance(entry.updated_at, str) else ""
            version = entry.version if isinstance(entry.version, int) else 0
            lines.append(f"{kind}\x00{entry_id}\x00{version}\x00{updated}")
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def _similarity_pairs(entries: Sequence[HarnessEntry], min_score: float) -> list[tuple[str, str, float]]:
    """All entry pairs at ``min_score`` or better, by idf-weighted cosine over title+content.

    Batch twin of ``HarnessState._near_duplicate_memory_matches``: same
    tokenizer, same idf, same cosine. Term iteration is in sorted (code-point)
    order so the summation order - and therefore the exact float scores - is
    reproducible across the Python and TS faces; entries are enumerated in
    sorted id order and the output sorts by (-score, id_a, id_b).
    """
    ordered = sorted(entries, key=lambda entry: entry.id)
    if len(ordered) < 2:
        return []
    profiles = {entry.id: frozenset(_harness_query_terms(f"{entry.title} {entry.content}")) for entry in ordered}
    document_count = len(ordered)
    document_frequency: dict[str, int] = {}
    for profile in profiles.values():
        for term in profile:
            document_frequency[term] = document_frequency.get(term, 0) + 1
    idf = {term: math.log(1 + document_count / count) for term, count in document_frequency.items()}
    norms: dict[str, float] = {}
    for entry in ordered:
        norms[entry.id] = math.sqrt(sum(idf[term] ** 2 for term in sorted(profiles[entry.id])))
    inverted: dict[str, list[str]] = {}
    for entry in ordered:
        for term in profiles[entry.id]:
            inverted.setdefault(term, []).append(entry.id)  # id-sorted: entries walk in id order
    dots: dict[tuple[str, str], float] = {}
    for term in sorted(inverted):
        ids = inverted[term]
        if len(ids) < 2:
            continue
        weight = idf[term] ** 2
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                key = (ids[i], ids[j])
                dots[key] = dots.get(key, 0.0) + weight
    pairs: list[tuple[str, str, float]] = []
    for (id_a, id_b), dot in dots.items():
        denominator = norms[id_a] * norms[id_b]
        if denominator == 0:
            continue
        score = dot / denominator
        if score >= min_score:
            pairs.append((id_a, id_b, score))
    pairs.sort(key=lambda pair: (-pair[2], pair[0], pair[1]))
    return pairs


def _consolidation_recency(entry: HarnessEntry) -> str:
    """Most recent write timestamp; a missing one sorts last."""
    updated = entry.updated_at
    if isinstance(updated, str) and updated:
        return updated
    created = entry.created_at
    return created if isinstance(created, str) else ""


def _canonical_order(member_ids: list[str], by_id: Mapping[str, HarnessEntry]) -> list[str]:
    """Cluster members, canonical first: most recently updated, then longest
    content (code points), then smallest id. Two stable passes keep the tie
    order exact; consolidation.ts uses the identical key."""
    ordered = sorted(member_ids)
    ordered.sort(
        key=lambda entry_id: (_consolidation_recency(by_id[entry_id]), len(by_id[entry_id].content)),
        reverse=True,
    )
    return ordered


_MERGE_PIECE_SPLIT = re.compile(r"[。！？；!?\n]")


def _merge_pieces(text: str) -> list[str]:
    return [piece for piece in (part.strip() for part in _MERGE_PIECE_SPLIT.split(text)) if piece]


def _merged_content(canonical: HarnessEntry, absorbed: Sequence[HarnessEntry]) -> str:
    """Canonical body plus each absorbed entry's unique sentences as a bullet
    appendix, in recency order. Exact duplicate sentences are dropped, so a
    pure rewrite merge keeps the canonical body verbatim. Deterministic;
    consolidation.ts builds the identical string."""
    seen = set(_merge_pieces(canonical.content))
    extras: list[str] = []
    for entry in absorbed:
        for piece in _merge_pieces(entry.content):
            if piece not in seen:
                seen.add(piece)
                extras.append(piece)
    if not extras:
        return canonical.content
    return canonical.content + "\n\n合并补充：\n" + "\n".join(f"- {piece}" for piece in extras)


def _containment_text(text: str) -> str:
    # Whitespace-collapsed lowercase for the containment check. Uses lower()
    # (not casefold()) to match the TS face's toLowerCase().
    return " ".join(text.split()).lower()


def _slim_title(flat_title: str, max_chars: int) -> str:
    """Code-point-capped title in the digest index line's own convention:
    ``max_chars - 3`` code points plus an ellipsis, so the stored title renders
    byte-identically to the truncated face it replaces and never grows the
    line (120 CJK code points would outweigh 117 + "...")."""
    if len(flat_title) <= max_chars:
        return flat_title
    if max_chars <= 3:
        return flat_title[:max_chars].rstrip()
    return f"{flat_title[: max_chars - 3].rstrip()}..."


def _parse_iso_timestamp(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _consolidation_summary(stats: Mapping[str, int], before: int, after: int, fits_cap: bool, cap: int) -> str:
    verdict = "fits" if fits_cap else "still over"
    return (
        f"Consolidation pass: {stats.get('merges', 0)} merges, {stats.get('stale_deletes', 0)} stale deletes, "
        f"{stats.get('renames', 0)} renames; index {before} -> {after} bytes ({verdict} the {cap}-byte cap)."
    )


def _generate_consolidation_id() -> str:
    return "consolidate_" + re.sub(r"[^0-9]", "", datetime.now(timezone.utc).isoformat())[:17]


_ENTRY_FIELDS = {field.name for field in fields(HarnessEntry)}
_REFINEMENT_FIELDS = {field.name for field in fields(RefinementEvent)}


def _persisted_entry_record(entry: HarnessEntry) -> dict[str, Any]:
    record = asdict(entry)
    # Write-time feedback is recomputed per write; persisting it would
    # fossilize stale advice into the state file the TS host also reads.
    record.pop("near_duplicate_warning", None)
    record.pop("path_vocabulary_warning", None)
    return record


def _validate_python_skill_reference(reference: dict[str, Any] | None, entry_name: str = "") -> dict[str, Any]:
    # Rejections name the entry so the caller can repair the right skill; the
    # suffix keeps the historical message text greppable.
    prefix = f"skill entry {entry_name!r} rejected: " if entry_name else ""

    def reject(message: str) -> None:
        raise ValueError(f"{prefix}{message}")

    if not isinstance(reference, dict):
        reject("skill entries require a Python reference")
    normalized = dict(reference)
    if normalized.get("type") != "python":
        reject("skill reference.type must be 'python'")
    if not any(isinstance(normalized.get(key), str) and normalized[key] for key in ("import", "python_import")):
        reject("skill reference requires a Python import")
    if not any(isinstance(normalized.get(key), str) and normalized[key] for key in ("callable", "call_pattern")):
        reject("skill reference requires a callable or call_pattern")
    return normalized


def _type_name(value: Any) -> str:
    if isinstance(value, list):
        return "a list"
    if value == "":
        return "an empty string"
    return type(value).__name__


def _describe_entry(id: Any, title: Any) -> str:
    """Best available entry name for rejection messages."""
    if isinstance(id, str) and id:
        return id
    if isinstance(title, str) and title:
        return title
    return "<unnamed>"


def _require_text(kind: str, entry_name: str, field: str, value: Any) -> None:
    if not isinstance(value, str) or not value:
        raise ValueError(
            f"{kind} entry {entry_name!r} rejected: {field} must be a non-empty string, got {_type_name(value)}"
        )


def _require_optional_text(kind: str, entry_name: str, field: str, value: Any) -> None:
    if value is not None:
        _require_text(kind, entry_name, field, value)


def _require_optional_record(kind: str, entry_name: str, field: str, value: Any) -> None:
    if value is not None and not isinstance(value, dict):
        raise ValueError(
            f"{kind} entry {entry_name!r} rejected: {field} must be a dict when provided, got {_type_name(value)}"
        )


def _json_rejection(value: Any) -> str | None:
    """None when ``json.dumps`` can serialize ``value``; else a description of the first bad leaf.

    Entries persist through ``json.dump``, so a dict that merely *is* a dict is not enough:
    ``metadata={"when": datetime.now()}`` passes the shape check and then wedges every later
    save of the whole store. Containers are walked with a seen-set so a circular reference
    (which ``json.dumps`` reports on the container, not a leaf) still terminates.
    """
    seen: set[int] = set()
    stack: list[tuple[str, Any]] = [("", value)]
    while stack:
        path, item = stack.pop()
        try:
            json.dumps(item)
            continue
        except (TypeError, ValueError):
            pass
        if isinstance(item, (dict, list, tuple)):
            if id(item) in seen:
                return f"{path or '(root)'} (circular reference)"
            seen.add(id(item))
            if isinstance(item, dict):
                stack.extend((f"{path}[{key!r}]", sub) for key, sub in item.items())
            else:
                stack.extend((f"{path}[{index}]", sub) for index, sub in enumerate(item))
            continue
        return f"{path or '(root)'} holds {_type_name(item)}"
    return None


def _require_json_serializable(kind: str, entry_name: str, field: str, value: Any) -> None:
    if value is None:
        return
    rejection = _json_rejection(value)
    if rejection is not None:
        raise ValueError(
            f"{kind} entry {entry_name!r} rejected: {field} must be JSON-serializable; {field}{rejection}"
        )


def _validate_entry_shape(
    kind: str,
    entry_id: Any,
    title: Any,
    content: Any,
    *,
    path: Any,
    reference: Any,
    arguments: Any,
    metadata: Any,
    source: Any,
    existing: "HarnessEntry | None",
) -> None:
    """Reject an invalid harness entry before anything is persisted.

    Every create/update/upsert write funnels through here, so a malformed
    entry (content as a list, title as a number) fails with an actionable
    error naming the entry and the field instead of being saved and later
    crashing the host digest that renders every session's system prompt.
    """
    entry_name = _describe_entry(entry_id, title)
    _require_text(kind, entry_name, "id", entry_id)
    _require_text(kind, entry_name, "title", title)
    _require_text(kind, entry_name, "content", content)
    _require_optional_text(kind, entry_name, "path", path)
    _require_optional_record(kind, entry_name, "reference", reference)
    _require_optional_record(kind, entry_name, "arguments", arguments)
    _require_optional_record(kind, entry_name, "metadata", metadata)
    _require_json_serializable(kind, entry_name, "reference", reference)
    _require_json_serializable(kind, entry_name, "arguments", arguments)
    _require_json_serializable(kind, entry_name, "metadata", metadata)
    _require_text(kind, entry_name, "source", source)
    if kind == "skill":
        if reference is None:
            # A new skill without a Python reference is invalid; an update that
            # omits it preserves the existing reference instead.
            if existing is None:
                raise ValueError(f"skill entry {entry_name!r} rejected: skill entries require a Python reference")
        else:
            _validate_python_skill_reference(reference, entry_name)


def _validate_refinement_event(trigger: Any, changes: Any, *, evidence: Any, outcome: Any) -> None:
    """Reject a refinement event whose persisted shape would break the digest."""
    if not isinstance(trigger, str) or not trigger:
        raise ValueError(f"refinement event rejected: trigger must be a non-empty string, got {_type_name(trigger)}")
    if isinstance(changes, str):
        if not changes:
            raise ValueError("refinement event rejected: changes must be a non-empty string or a list of strings")
    elif isinstance(changes, list):
        if not all(isinstance(change, str) and change for change in changes):
            raise ValueError("refinement event rejected: changes must be a list of non-empty strings")
    else:
        raise ValueError(
            f"refinement event rejected: changes must be a string or a list of strings, got {_type_name(changes)}"
        )
    if not isinstance(evidence, str):
        raise ValueError(f"refinement event rejected: evidence must be a string when provided, got {_type_name(evidence)}")
    if not isinstance(outcome, str):
        raise ValueError(f"refinement event rejected: outcome must be a string when provided, got {_type_name(outcome)}")


class HarnessState:
    """CRUD store for reset-free harness refinement state."""

    def __repr__(self) -> str:
        # The prompt points models at get_harness_state() when they want the
        # full list; the REPL prints repr(value), so it has to summarize the
        # state instead of an opaque address (MV-3).
        counts = ", ".join(f"{kind}={len(records)}" for kind, records in self.entries.items())
        refinements = len(self.refinements)
        return f"<HarnessState {self.scope} {self.file_path} {counts}, refinements={refinements}>"

    def __init__(
        self,
        file_path: str | Path | None = None,
        *,
        in_memory: bool = False,
        scope: HarnessScope = "local",
        local_write_error: str | None = None,
    ):
        # Windows cannot provide the required no-follow and private-ACL guarantees
        # through this portable implementation. Keep reads as an empty proxy and
        # reject every mutation without resolving or touching a path.
        if os.name == "nt":
            in_memory = True
            local_write_error = WINDOWS_PERSISTENCE_UNSUPPORTED_ERROR
        # in_memory mode never resolves or touches a path. It is the safe fallback when
        # path resolution itself fails, so constructing it cannot re-raise that error.
        if in_memory:
            self.file_path: Path | None = None
            self._lexical_file_path: Path | None = None
        else:
            lexical_path = Path(file_path).expanduser() if file_path else _state_file(global_=(scope == "global"))
            self._lexical_file_path = Path(os.path.abspath(lexical_path))
            self.file_path = lexical_path.parent.resolve() / lexical_path.name
        self.scope: HarnessScope = scope
        # When set, local mutations raise instead of vanishing into a volatile
        # store; reads and global_=True delegation keep working.
        self._local_write_error = local_write_error
        self.entries: dict[HarnessKind, dict[str, HarnessEntry]] = {kind: {} for kind in _KINDS}
        self.refinements: list[RefinementEvent] = []
        self._global_target_state_dir: Path | None = None
        # mtime of the file as of the last load/save, used to detect out-of-process
        # writes (e.g. the host `/refine` command) and avoid clobbering them.
        self._loaded_mtime: tuple[str, int | None] = ("missing", None)
        # Write-path serialization: the threading lock serializes threads inside this
        # kernel; the sidecar flock serializes kernels sharing one store (the global
        # store in an RLM swarm). Both wrap sync+mutate+save as one critical section.
        self._write_lock = threading.RLock()
        self._lock_depth = 0
        self._lock_fd: int | None = None
        self.load()

    def _flock_acquire(self) -> None:
        """Take the store's cross-process write lock (a ``.lock`` sidecar of the state file)."""
        if fcntl is None or self.file_path is None:
            return
        lock_path = Path(f"{self._lexical_file_path or self.file_path}.lock")
        # The lock sidecar is save machinery like the atomic state write itself:
        # untracked, so it never shows up as a file change next to the memory record.
        with effects.untracked():
            _ensure_private_directory(lock_path.parent)
            fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | _require_no_follow(), 0o600)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise OSError(f"Refusing to use non-regular private file: {lock_path}")
            os.set_inheritable(fd, False)
            fcntl.flock(fd, fcntl.LOCK_EX)
        except BaseException:
            os.close(fd)
            raise
        self._lock_fd = fd

    def _flock_release(self) -> None:
        fd, self._lock_fd = self._lock_fd, None
        if fd is None:
            return
        assert fcntl is not None
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)

    @contextlib.contextmanager
    def _write_guard(self) -> Generator[None, None, None]:
        """Hold the write lock across sync+mutate+save.

        The mtime guard in ``_sync_from_disk`` alone is a TOCTOU for any writer that is
        not this process's single thread: two kernels sharing the global store could each
        sync, mutate, and save, the second save silently overwriting the first's entries
        while both report success, and one thread's in-flight upsert could vanish under a
        concurrent thread's reload. Re-entrant, so ``create``/``update`` may call
        ``_upsert`` (which saves) inside their own guarded existence check.
        """
        self._write_lock.acquire()
        depth = self._lock_depth
        self._lock_depth = depth + 1
        if depth == 0:
            try:
                self._flock_acquire()
            except BaseException:
                self._lock_depth = depth
                self._write_lock.release()
                raise
        try:
            yield
        finally:
            self._lock_depth = depth
            if depth == 0:
                self._flock_release()
            self._write_lock.release()

    def _ensure_local_writable(self) -> None:
        if self._local_write_error is not None:
            raise RuntimeError(self._local_write_error)

    def _disk_mtime(self) -> tuple[str, int | None]:
        if self.file_path is None or not os.path.lexists(self.file_path):
            return ("missing", None)
        info = self.file_path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            return ("unsafe", None)
        return ("regular", info.st_mtime_ns)

    def _sync_from_disk(self) -> None:
        """Reload if another process rewrote the state file since we last touched it.

        The kernel keeps a long-lived ``HarnessState`` in memory while the host
        ``/refine`` command rewrites the same file from a separate process. Without
        this guard the next in-kernel ``save()`` would overwrite host edits with a
        stale snapshot. We re-read whenever the on-disk mtime no longer matches the
        value recorded at our last load/save. Reloading happens under the write lock
        so a read path cannot swap ``self.entries`` under a write in flight on
        another thread.
        """
        with self._write_lock:
            if self._disk_mtime() != self._loaded_mtime:
                self.load()

    def load(self) -> "HarnessState":
        if self._lexical_file_path is not None:
            try:
                _assert_no_symlinked_ancestors(self._lexical_file_path)
            except OSError as error:
                self._local_write_error = str(error)
                self._loaded_mtime = ("unsafe", None)
                return self
        if self.file_path is None or not os.path.lexists(self.file_path):
            self._loaded_mtime = ("missing", None)
            return self
        info = self.file_path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            # Keep prompt construction/read APIs available, but permanently block
            # mutation of this unsafe persistent sink.
            self._local_write_error = f"Refusing to use non-regular private file: {self.file_path}"
            self._loaded_mtime = ("unsafe", None)
            return self
        mtime = self._disk_mtime()
        try:
            with _open_private_for_read(self.file_path) as f:
                data = json.load(f)
        except (OSError, ValueError):
            # A corrupt or unreadable state file must not crash the kernel or block
            # refinement. Treat it as empty; the next save() rewrites it cleanly.
            data = {}
        # json.load returns non-dict types for valid JSON like `null`, `[]`, or a bare
        # string; coerce those to an empty object before attribute access.
        if not isinstance(data, dict):
            data = {}

        entries: dict[HarnessKind, dict[str, HarnessEntry]] = {kind: {} for kind in _KINDS}
        raw_entries = data.get("entries", {})
        if isinstance(raw_entries, dict):
            for kind in _KINDS:
                raw_kind_entries = raw_entries.get(kind, {})
                if not isinstance(raw_kind_entries, dict):
                    continue
                for entry_id, raw_entry in raw_kind_entries.items():
                    if isinstance(raw_entry, dict):
                        entry_data = {key: value for key, value in raw_entry.items() if key in _ENTRY_FIELDS}
                        entry_data["id"] = str(entry_id)
                        entry_data["kind"] = kind
                        if not isinstance(entry_data.get("title"), str) or not isinstance(
                            entry_data.get("content"), str
                        ):
                            continue
                        if not isinstance(entry_data.get("path"), str):
                            entry_data["path"] = "general"
                        if entry_data.get("scope") not in ("local", "global"):
                            entry_data["scope"] = self.scope
                        if not isinstance(entry_data.get("source"), str):
                            entry_data["source"] = "agent"
                        version = entry_data.get("version", 1)
                        if isinstance(version, str):
                            try:
                                version = int(version)
                            except ValueError:
                                version = 1
                        if not isinstance(version, int):
                            version = 1
                        entry_data["version"] = version
                        if not isinstance(entry_data.get("reference"), dict):
                            entry_data["reference"] = {}
                        if not isinstance(entry_data.get("arguments"), dict):
                            entry_data["arguments"] = {}
                        if not isinstance(entry_data.get("metadata"), dict):
                            entry_data["metadata"] = {}
                        entries[kind][str(entry_id)] = HarnessEntry(**entry_data)
        self.entries = entries

        self.refinements = []
        raw_refinements = data.get("refinements", [])
        if isinstance(raw_refinements, list):
            for raw_event in raw_refinements:
                if isinstance(raw_event, dict):
                    event_data = {key: value for key, value in raw_event.items() if key in _REFINEMENT_FIELDS}
                    if not isinstance(event_data.get("id"), str) or not isinstance(
                        event_data.get("trigger"), str
                    ):
                        continue
                    changes = event_data.get("changes")
                    if isinstance(changes, str):
                        event_data["changes"] = [changes]
                    elif isinstance(changes, list):
                        event_data["changes"] = [str(change) for change in changes]
                    elif not isinstance(changes, list):
                        continue
                    self.refinements.append(RefinementEvent(**event_data))
        self._loaded_mtime = mtime
        return self

    def _global_target(self, global_: bool, extra: dict[str, Any] | None = None) -> "HarnessState | None":
        if not _resolve_global_flag(global_, extra):
            return None
        target = get_harness_state(state_dir=self._global_target_state_dir, global_=True)
        if self.file_path is not None and target.file_path == self.file_path and target.scope == self.scope:
            return None
        return target

    def _refuse_cross_store_prefix(
        self, kind: HarnessKind, id: str | None, global_: bool, extra: dict[str, Any] | None
    ) -> None:
        # M5/MV-1b parity with the TS side: a write whose id names the other
        # store must be refused with the way out instead of silently writing
        # through (reads keep routing). A prefix may only steer a write into a
        # store the caller addressed explicitly. X-9 extended this from
        # update/delete to create/upsert: a local-session create with a
        # [global:] id used to strip the prefix and write the global store.
        if not isinstance(id, str):
            return
        match = _SCOPE_PREFIX_PATTERN.match(id)
        if not match:
            return
        claimed = match.group(1)
        explicit_global = _resolve_global_flag(global_, extra)
        if claimed == "global" and (self.scope == "global" or explicit_global):
            return
        if claimed == "local" and self.scope == "local" and not explicit_global:
            return
        bare_id = id[match.end():].removesuffix("]")
        if claimed == "global":
            raise ValueError(
                f"{kind} entry {bare_id!r} is prefixed [global:] in the harness overview, "
                "but this call writes the local store: pass global_=True to update it."
            )
        raise ValueError(
            f"{kind} entry {bare_id!r} is prefixed [local:] in the harness overview, "
            "but this call writes the global store: use the local harness state "
            "(get_harness_state(), global_=False) to update it."
        )

    def save(self) -> "HarnessState":
        self._ensure_local_writable()
        if self.file_path is None:
            # Deliberately in-memory state has no persistence target.
            return self
        with self._write_guard():
            data = {
                "schema": 1,
                "entries": {
                    kind: {entry_id: _persisted_entry_record(entry) for entry_id, entry in records.items()}
                    for kind, records in self.entries.items()
                },
                "refinements": [asdict(event) for event in self.refinements],
            }
            # The entry-level memory record (see effects.memory_change) describes this write; a JSON
            # diff of the whole state file next to it would say the same thing less clearly.
            with effects.untracked():
                _write_private_json_atomic(self._lexical_file_path or self.file_path, data)
            self._loaded_mtime = self._disk_mtime()
        return self

    def upsert(
        self,
        kind: HarnessKind,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "general",
        reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        source: str = "agent",
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        self._refuse_cross_store_prefix(kind, id, global_, kwargs)
        id, global_, _claimed_scope = _strip_scope_prefix(id, global_)
        if target := self._global_target(global_, kwargs):
            return target.upsert(
                kind,
                title,
                content,
                id=id,
                path=path,
                reference=reference,
                arguments=arguments,
                metadata=metadata,
                source=source,
            )
        self._ensure_local_writable()
        with self._write_guard():
            self._sync_from_disk()
            return self._upsert(
                kind,
                title,
                content,
                id=id,
                path=path,
                reference=reference,
                arguments=arguments,
                metadata=metadata,
                source=source,
            )

    def _upsert(
        self,
        kind: HarnessKind,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str | None = None,
        reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        source: str = "agent",
    ) -> HarnessEntry:
        # Caller is responsible for syncing from disk first. create()/update() sync
        # once and then call this directly so their existence check and the write are
        # not separated by a second reload (which could turn create-or-fail into a
        # silent update).
        if kind not in self.entries:
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")

        # Guard before the id slug and the dict lookup: a non-string title or a
        # non-string id (falsy ids included, which the slug fallback would
        # silently collapse) must fail with a clear rejection, not an
        # AttributeError inside slug normalization or a TypeError from the lookup.
        _require_text(kind, _describe_entry(id, title), "title", title)
        if id is not None:
            _require_text(kind, _describe_entry(id, title), "id", id)
        entry_id = id or _slug(title, kind)
        existing = self.entries[kind].get(entry_id)
        _validate_entry_shape(
            kind,
            entry_id,
            title,
            content,
            path=path,
            reference=reference,
            arguments=arguments,
            metadata=metadata,
            source=source,
            existing=existing,
        )
        previous_title = existing.title if existing else None
        previous_content = existing.content if existing else None
        # Stage-2 write-side index cap: refuse net growth past the byte cap with
        # consolidation guidance. Deletes never route through here, and a
        # content-only update keeps the index line unchanged, so an over-cap
        # store can always be consolidated back under the cap.
        cap = _index_max_bytes()
        if cap > 0:
            projected_path = path if path is not None else (existing.path if existing else "general")
            projected_scope = existing.scope if existing else self.scope
            current_index_bytes = self.index_bytes()
            projected_index_bytes = (
                current_index_bytes
                - (_index_line_bytes(existing) if existing else 0)
                + len((_index_line(entry_id, projected_scope, title, projected_path) + "\n").encode("utf-8"))
            )
            if projected_index_bytes > cap and projected_index_bytes > current_index_bytes:
                raise ValueError(
                    f"harness index byte cap exceeded: the id+title index would grow to {projected_index_bytes} bytes "
                    f"(cap {cap}); consolidate first (merge near-duplicate entries, delete stale ones, "
                    "or shorten titles), then retry the write"
                )
        if existing:
            # Snapshot the pre-mutation field values so a failed save can roll the
            # entry back: the replaced dicts are fresh copies, so the originals stay
            # intact under these references.
            rollback = (
                existing.title,
                existing.content,
                existing.path,
                existing.reference,
                existing.arguments,
                existing.metadata,
                existing.source,
                existing.updated_at,
                existing.version,
            )
            existing.title = title
            existing.content = content
            # Preserve path/reference/arguments/metadata when the caller omits them
            # (None) so updating only an entry's title or content does not reset its
            # grouping path or wipe a skill's reference/argument contract. An explicit
            # value (including {}) still overwrites.
            if path is not None:
                existing.path = path
            if reference is not None:
                existing.reference = dict(reference)
            if arguments is not None:
                existing.arguments = dict(arguments)
            if metadata is not None:
                existing.metadata = dict(metadata)
            existing.source = source
            existing.updated_at = _now()
            existing.version += 1
            entry = existing
        else:
            entry = HarnessEntry(
                id=entry_id,
                kind=kind,
                title=title,
                content=content,
                path=path if path is not None else "general",
                scope=self.scope,
                reference=dict(reference or {}),
                arguments=dict(arguments or {}),
                metadata=dict(metadata or {}),
                source=source,
            )
            self.entries[kind][entry_id] = entry
        try:
            self.save()
        except BaseException:
            # A failed save must not leave memory ahead of disk: the unwritten entry
            # would otherwise stay in the cache, wedge every later save of the store
            # if it was the cause, and show up in overview()/search() as a phantom.
            if existing:
                (
                    existing.title,
                    existing.content,
                    existing.path,
                    existing.reference,
                    existing.arguments,
                    existing.metadata,
                    existing.source,
                    existing.updated_at,
                    existing.version,
                ) = rollback
            else:
                self.entries[kind].pop(entry_id, None)
            raise
        # Display-only: tells the host UI what changed; the model's view of the harness is unchanged.
        effects.memory_change(
            "updated" if existing else "created",
            kind,
            self.scope,
            entry_id,
            title,
            previous_title=previous_title,
            before=previous_content,
            after=content,
        )
        # Receipt-only advisories, computed after the write landed; advisory
        # feedback must never fail a persisted write.
        near_warning: str | None = None
        if kind == "memory":
            try:
                near_warning = self._near_duplicate_memory_warning(entry, is_create=existing is None)
            except Exception:  # noqa: BLE001
                # A reported failure after a successful save invites a retry that
                # creates the very duplicate this warning exists to prevent.
                near_warning = None
        path_warning: str | None = None
        # The path advisory belongs to a path choice: every create makes one
        # (explicitly or via the default); an update that omits `path` keeps the
        # existing one and stays silent.
        if path is not None or existing is None:
            try:
                path_warning = _path_vocabulary_warning(entry.path)
            except Exception:  # noqa: BLE001
                path_warning = None
        if near_warning is None and path_warning is None:
            return entry
        # The warnings ride on a receipt copy; the stored entry stays clean so
        # later reads and saves never see stale write-time advice.
        return replace(entry, near_duplicate_warning=near_warning, path_vocabulary_warning=path_warning)

    def get(self, kind: HarnessKind, id: str, *, global_: bool = False, **kwargs: Any) -> HarnessEntry | None:
        id, global_, _claimed_scope = _strip_scope_prefix(id, global_)
        if target := self._global_target(global_, kwargs):
            return target.get(kind, id)
        self._sync_from_disk()
        if kind not in self.entries:
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
        return self.entries[kind].get(id)

    def delete(self, kind: HarnessKind, id: str, *, global_: bool = False, **kwargs: Any) -> bool:
        self._refuse_cross_store_prefix(kind, id, global_, kwargs)
        id, global_, _claimed_scope = _strip_scope_prefix(id, global_)
        if target := self._global_target(global_, kwargs):
            return target.delete(kind, id)
        self._ensure_local_writable()
        with self._write_guard():
            self._sync_from_disk()
            if kind not in self.entries:
                raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
            if id not in self.entries[kind]:
                return False
            removed = self.entries[kind].pop(id)
            try:
                self.save()
            except BaseException:
                # Keep memory consistent with the file the delete never reached.
                self.entries[kind][id] = removed
                raise
        effects.memory_change("deleted", kind, self.scope, id, removed.title, before=removed.content)
        return True

    def list(self, kind: HarnessKind | None = None, *, global_: bool = False, **kwargs: Any) -> list[HarnessEntry]:
        if target := self._global_target(global_, kwargs):
            return target.list(kind)
        self._sync_from_disk()
        kinds = [kind] if kind else list(_KINDS)
        records: list[HarnessEntry] = []
        for current_kind in kinds:
            if current_kind not in self.entries:
                raise ValueError(f"unknown harness kind {current_kind!r}; expected one of {_KINDS}")
            records.extend(self.entries[current_kind].values())
        return sorted(records, key=lambda entry: (entry.kind, entry.path, entry.title, entry.id))

    def index_bytes(self) -> int:
        """Total UTF-8 bytes of the full compact id+title index over all kinds.

        This is the quantity the write-side cap (and the TS digest's index
        layer) budgets: every entry contributes its one index line, including
        kinds small enough that the digest renderer skips their index layer -
        the cap guards store size, not one render's layout.
        """
        total = 0
        for records in self.entries.values():
            for entry in records.values():
                total += _index_line_bytes(entry)
        return total

    def plan_consolidation(
        self,
        *,
        kinds: Sequence[str] = ("memory",),
        merge_min_score: float = CONSOLIDATION_MERGE_MIN_SCORE,
        stale_days: float | None = None,
        stale_min_content_chars: int = CONSOLIDATION_STALE_MIN_CONTENT_CHARS,
        slim_title_chars: int | None = _INDEX_TITLE_MAX_CHARS,
        index_max_bytes: int = DEFAULT_HARNESS_INDEX_MAX_BYTES,
        now: datetime | str | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> ConsolidationPlan:
        """Propose merge/delete/rename operations that shrink the id+title index.

        Dry-run, read-only: nothing is written, and executing the result needs
        an explicit ``apply_consolidation(plan)`` call. Three passes run per
        kind, each skipping entries an earlier pass already removed:

        1. merge: near-duplicate clusters (the write gate's tokenizer/idf/cosine
           in batch form) at ``merge_min_score`` or better fold into their most
           recently updated member; the absorbed entries' unique sentences move
           into the canonical body as a bullet appendix.
        2. delete: stale entries - either fully contained in a surviving entry's
           normalized content (bodies shorter than ``stale_min_content_chars``
           are not worth the suggestion), or older than ``stale_days`` (off by
           default; ``now`` injects the clock for deterministic runs).
        3. rename: titles longer than ``slim_title_chars`` code points slim to
           the cap (the digest's index layer already truncates its rendering
           there, so the default costs the face nothing). ``None`` or ``<= 0``
           disables the pass.

        Parity: ``planHarnessConsolidation`` in consolidation.ts builds the
        identical plan for the identical store.
        """
        if target := self._global_target(global_, kwargs):
            return target.plan_consolidation(
                kinds=kinds,
                merge_min_score=merge_min_score,
                stale_days=stale_days,
                stale_min_content_chars=stale_min_content_chars,
                slim_title_chars=slim_title_chars,
                index_max_bytes=index_max_bytes,
                now=now,
            )
        for kind in kinds:
            if kind not in _KINDS:
                raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
        if not 0 <= merge_min_score <= 1:
            raise ValueError(f"merge_min_score must be in [0, 1], got {merge_min_score}")
        self._sync_from_disk()
        if now is None:
            resolved_now = datetime.now(timezone.utc)
        elif isinstance(now, str):
            parsed_now = _parse_iso_timestamp(now)
            if parsed_now is None:
                raise ValueError(f"now must be an ISO-8601 timestamp, got {now!r}")
            resolved_now = parsed_now
        elif isinstance(now, datetime):
            resolved_now = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
        else:
            raise TypeError(f"now must be a datetime or ISO-8601 string, got {type(now).__name__}")

        operations: list[ConsolidationOperation] = []
        merge_ops: list[ConsolidationOperation] = []
        stale_ops: list[ConsolidationOperation] = []
        rename_ops: list[ConsolidationOperation] = []
        # Ids removed by an earlier pass (merge absorption or a stale delete)
        # must not be targeted again by a later one.
        removed: dict[str, set[str]] = {kind: set() for kind in _KINDS}

        # Pass 1: near-duplicate merges.
        for kind in kinds:
            records = self.entries[kind]
            if len(records) < 2:
                continue
            pairs = _similarity_pairs(list(records.values()), merge_min_score)
            if not pairs:
                continue
            parent: dict[str, str] = {}

            def find(entry_id: str) -> str:
                root = entry_id
                while parent[root] != root:
                    root = parent[root]
                while parent[entry_id] != root:
                    parent[entry_id], entry_id = root, parent[entry_id]
                return root

            for id_a, id_b, _score in pairs:
                parent.setdefault(id_a, id_a)
                parent.setdefault(id_b, id_b)
                root_a, root_b = find(id_a), find(id_b)
                if root_a != root_b:
                    parent[root_a] = root_b
            clusters: dict[str, list[str]] = {}
            for entry_id in parent:
                clusters.setdefault(find(entry_id), []).append(entry_id)
            cluster_scores: dict[str, float] = {}
            for id_a, _id_b, score in pairs:
                root = find(id_a)
                cluster_scores[root] = max(cluster_scores.get(root, 0.0), score)
            for member_ids in clusters.values():
                if len(member_ids) < 2:
                    continue
                ordered = _canonical_order(member_ids, records)
                canonical = records[ordered[0]]
                absorbed = [records[entry_id] for entry_id in ordered[1:]]
                # absorb_ids is sorted for a stable op list; the content union
                # walks the absorbed entries in recency order instead.
                merge_ops.append(
                    ConsolidationOperation(
                        action="merge",
                        kind=kind,
                        id=canonical.id,
                        absorb_ids=tuple(sorted(entry.id for entry in absorbed)),
                        title=canonical.title,
                        content=_merged_content(canonical, absorbed),
                        path=canonical.path if isinstance(canonical.path, str) else None,
                        reason="near-duplicate cluster",
                        score=cluster_scores[find(ordered[0])],
                    )
                )
                removed[kind].update(entry.id for entry in absorbed)

        # Pass 2: stale deletes - containment first, then age.
        for kind in kinds:
            survivors = [
                entry for entry_id, entry in sorted(self.entries[kind].items()) if entry_id not in removed[kind]
            ]
            if not survivors:
                continue
            marked: dict[str, str] = {}
            if stale_min_content_chars > 0 and len(survivors) >= 2:
                texts = {entry.id: _containment_text(entry.content) for entry in survivors}
                profiles = {
                    entry.id: frozenset(_harness_query_terms(f"{entry.title} {entry.content}")) for entry in survivors
                }
                document_frequency: dict[str, int] = {}
                for profile in profiles.values():
                    for term in profile:
                        document_frequency[term] = document_frequency.get(term, 0) + 1
                inverted: dict[str, list[str]] = {}
                for entry in survivors:
                    for term in profiles[entry.id]:
                        inverted.setdefault(term, []).append(entry.id)  # id-sorted survivor order
                for entry in survivors:
                    text = texts[entry.id]
                    if len(text) < stale_min_content_chars:
                        continue
                    profile = profiles[entry.id]
                    # Probe with the entry's rarest SHARED term: a contained
                    # entry shares every content term with its container, while
                    # a title-only term with df 1 would skip the check entirely.
                    shared = [term for term in profile if document_frequency[term] >= 2]
                    if not shared:
                        continue
                    rarest = min(shared, key=lambda term: (document_frequency[term], term))
                    for other_id in inverted[rarest]:
                        if other_id == entry.id or other_id in marked:
                            continue
                        other_text = texts[other_id]
                        if len(other_text) > len(text) and text in other_text:
                            marked[entry.id] = f"contained:{other_id}"
                            break
            if stale_days is not None:
                for entry in survivors:
                    if entry.id in marked:
                        continue
                    recency = _consolidation_recency(entry)
                    moment = _parse_iso_timestamp(recency) if recency else None
                    if moment is None:
                        continue
                    age_days = (resolved_now - moment).total_seconds() / 86400
                    if age_days > stale_days:
                        marked[entry.id] = f"stale:{math.floor(age_days)}d"
            for entry_id, reason in sorted(marked.items()):
                stale_ops.append(ConsolidationOperation(action="delete", kind=kind, id=entry_id, reason=reason))
                removed[kind].add(entry_id)

        # Pass 3: title slimming renames.
        if slim_title_chars is not None and slim_title_chars > 0:
            for kind in kinds:
                for entry_id, entry in sorted(self.entries[kind].items()):
                    if entry_id in removed[kind]:
                        continue
                    flat = _flatten_inline(entry.title)
                    if len(flat) <= slim_title_chars:
                        continue
                    slimmed = _slim_title(flat, slim_title_chars)
                    if not slimmed or slimmed == entry.title:
                        continue
                    rename_ops.append(
                        ConsolidationOperation(
                            action="rename",
                            kind=kind,
                            id=entry_id,
                            title=slimmed,
                            reason=f"title over {slim_title_chars} chars",
                            previous_title_chars=len(flat),
                        )
                    )

        kind_order = {kind: index for index, kind in enumerate(_KINDS)}
        for group in (merge_ops, stale_ops, rename_ops):
            group.sort(key=lambda op: (kind_order[op.kind], op.id))
        operations = merge_ops + stale_ops + rename_ops

        before = self.index_bytes()
        after = before
        for operation in operations:
            if operation.action == "merge":
                for absorb_id in operation.absorb_ids:
                    after -= _index_line_bytes(self.entries[operation.kind][absorb_id])
            elif operation.action == "delete":
                after -= _index_line_bytes(self.entries[operation.kind][operation.id])
            else:
                entry = self.entries[operation.kind][operation.id]
                renamed = _index_line(entry.id, entry.scope, operation.title, entry.path)
                after += len((renamed + "\n").encode("utf-8")) - _index_line_bytes(entry)
        fits_cap = after <= index_max_bytes
        stats = {
            "merges": len(merge_ops),
            "absorbed_entries": sum(len(operation.absorb_ids) for operation in merge_ops),
            "stale_deletes": len(stale_ops),
            "renames": len(rename_ops),
        }
        return ConsolidationPlan(
            store_digest=_harness_store_digest(self.entries),
            options={
                "kinds": list(kinds),
                "merge_min_score": merge_min_score,
                "stale_days": stale_days,
                "stale_min_content_chars": stale_min_content_chars,
                "slim_title_chars": slim_title_chars,
                "index_max_bytes": index_max_bytes,
            },
            index_bytes_before=before,
            index_bytes_after=after,
            fits_cap=fits_cap,
            operations=operations,
            stats=stats,
        )

    def _apply_consolidation_operation(self, operation: ConsolidationOperation) -> list[ConsolidationAppliedEdit]:
        """Execute one planned operation against the in-memory store.

        Mirrors applyRefinementProposal's per-edit semantics (consolidation.ts):
        updates bump version, stamp source="refine" and refreshed updated_at;
        a missing entry fails its edit without failing the batch. Entries are
        swapped via dataclasses.replace instead of mutated in place, so the
        caller's pre-apply snapshot of the records dicts stays a valid rollback.
        """
        if operation.kind not in _KINDS:
            return [
                ConsolidationAppliedEdit(
                    operation.action, operation.kind, operation.id, False, f"unknown harness kind {operation.kind!r}"
                )
            ]
        records = self.entries[operation.kind]  # type: ignore[index]
        if operation.action == "merge":
            target = records.get(operation.id)
            if target is None:
                return [ConsolidationAppliedEdit("update", operation.kind, operation.id, False, "entry not found")]
            if not operation.title or not operation.content:
                return [
                    ConsolidationAppliedEdit("update", operation.kind, operation.id, False, "merge requires title and content")
                ]
            records[operation.id] = replace(
                target,
                title=operation.title,
                content=operation.content,
                path=operation.path if operation.path is not None else target.path,
                source="refine",
                updated_at=_now(),
                version=target.version + 1,
            )
            edits = [ConsolidationAppliedEdit("update", operation.kind, operation.id, True)]
            for absorb_id in operation.absorb_ids:
                if absorb_id == operation.id:
                    edits.append(
                        ConsolidationAppliedEdit("delete", operation.kind, absorb_id, False, "cannot absorb the merge target")
                    )
                    continue
                removed = records.pop(absorb_id, None)
                edits.append(
                    ConsolidationAppliedEdit(
                        "delete", operation.kind, absorb_id, removed is not None, None if removed else "entry not found"
                    )
                )
            return edits
        if operation.action == "delete":
            removed = records.pop(operation.id, None)
            return [
                ConsolidationAppliedEdit(
                    "delete", operation.kind, operation.id, removed is not None, None if removed else "entry not found"
                )
            ]
        if operation.action == "rename":
            target = records.get(operation.id)
            if target is None:
                return [ConsolidationAppliedEdit("update", operation.kind, operation.id, False, "entry not found")]
            if not operation.title:
                return [ConsolidationAppliedEdit("update", operation.kind, operation.id, False, "rename requires title")]
            records[operation.id] = replace(
                target, title=operation.title, source="refine", updated_at=_now(), version=target.version + 1
            )
            return [ConsolidationAppliedEdit("update", operation.kind, operation.id, True)]
        return [
            ConsolidationAppliedEdit(operation.action, operation.kind, operation.id, False, f"unsupported action {operation.action!r}")
        ]

    def apply_consolidation(
        self,
        plan: ConsolidationPlan,
        *,
        allow_stale_plan: bool = False,
        global_: bool = False,
        **kwargs: Any,
    ) -> ConsolidationResult:
        """Execute a plan from ``plan_consolidation``. Explicit by construction:
        the planner never writes, and this refuses a plan whose store digest no
        longer matches (``allow_stale_plan=True`` overrides). Mutations land in
        one locked pass with a single save; a failed save rolls the in-memory
        store back. The applied edits are recorded as a refinement event, so the
        pass shows up in the same audit trail as /refine. The index cap never
        gates this path: consolidation operations only shrink or rewrite index
        lines, which is exactly how an over-cap store gets back under the cap.
        """
        if target := self._global_target(global_, kwargs):
            return target.apply_consolidation(plan, allow_stale_plan=allow_stale_plan)
        if not isinstance(plan, ConsolidationPlan):
            raise TypeError(f"plan must be a ConsolidationPlan, got {type(plan).__name__}")
        self._ensure_local_writable()
        with self._write_guard():
            self._sync_from_disk()
            if not allow_stale_plan and _harness_store_digest(self.entries) != plan.store_digest:
                raise ValueError(
                    "consolidation plan is stale: the store changed since the plan was built; "
                    "re-run plan_consolidation() (or pass allow_stale_plan=True to apply anyway)"
                )
            consolidation_id = _generate_consolidation_id()
            edits: list[ConsolidationAppliedEdit] = []
            effect_records: list[tuple[str, str, str, str, str | None, str | None]] = []
            entries_snapshot = {kind: dict(records) for kind, records in self.entries.items()}
            refinements_mark = len(self.refinements)
            try:
                for operation in plan.operations:
                    # Snapshot every entry the operation touches before mutating:
                    # a merge's absorbed deletes need their own pre-delete
                    # content for the effect record, not the target's.
                    touched_ids = [operation.id, *operation.absorb_ids]
                    before_entries = {
                        entry_id: self.entries[operation.kind].get(entry_id)
                        for entry_id in touched_ids
                        if operation.kind in _KINDS
                    }
                    operation_edits = self._apply_consolidation_operation(operation)
                    edits.extend(operation_edits)
                    for edit in operation_edits:
                        if not edit.applied:
                            continue
                        before_entry = before_entries.get(edit.id)
                        after_entry = self.entries[edit.kind].get(edit.id)
                        if edit.action == "delete":
                            if before_entry is not None:
                                effect_records.append(
                                    ("deleted", edit.kind, edit.id, before_entry.title, before_entry.content, None)
                                )
                        elif after_entry is not None:
                            effect_records.append(
                                (
                                    "updated",
                                    edit.kind,
                                    edit.id,
                                    after_entry.title,
                                    before_entry.content if before_entry is not None else None,
                                    after_entry.content,
                                )
                            )
                applied = [edit for edit in edits if edit.applied]
                if applied:
                    cap = int(plan.options.get("index_max_bytes") or 0)
                    self.refinements.append(
                        RefinementEvent(
                            id=consolidation_id,
                            trigger=_consolidation_summary(
                                plan.stats, plan.index_bytes_before, plan.index_bytes_after, plan.fits_cap, cap
                            ),
                            changes=[f"{edit.action} {edit.kind}:{edit.id}" for edit in applied],
                            evidence="consolidation plan apply",
                            outcome=f"index {plan.index_bytes_before} -> {plan.index_bytes_after} bytes",
                        )
                    )
                    self.save()
            except BaseException:
                self.entries = entries_snapshot
                del self.refinements[refinements_mark:]
                raise
        after_bytes = self.index_bytes()
        cap = int(plan.options.get("index_max_bytes") or 0)
        for action, kind, entry_id, title, before, after in effect_records:
            effects.memory_change(action, kind, self.scope, entry_id, title, before=before, after=after)
        return ConsolidationResult(
            consolidation_id=consolidation_id,
            edits=edits,
            index_bytes_before=plan.index_bytes_before,
            index_bytes_after=after_bytes,
            fits_cap=cap > 0 and after_bytes <= cap,
            state_path=str(self.file_path) if self.file_path is not None else None,
        )

    def create(
        self,
        kind: HarnessKind,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "general",
        reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        source: str = "agent",
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        self._refuse_cross_store_prefix(kind, id, global_, kwargs)
        id, global_, _claimed_scope = _strip_scope_prefix(id, global_)
        if target := self._global_target(global_, kwargs):
            return target.create(
                kind,
                title,
                content,
                id=id,
                path=path,
                reference=reference,
                arguments=arguments,
                metadata=metadata,
                source=source,
            )
        self._ensure_local_writable()
        with self._write_guard():
            self._sync_from_disk()
            if kind not in self.entries:
                raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
            _require_text(kind, _describe_entry(id, title), "title", title)
            if id is not None:
                _require_text(kind, _describe_entry(id, title), "id", id)
            entry_id = id or _slug(title, kind)
            if entry_id in self.entries[kind]:
                raise ValueError(f"{kind} entry {entry_id!r} already exists")
            return self._upsert(
                kind,
                title,
                content,
                id=entry_id,
                path=path,
                reference=reference,
                arguments=arguments,
                metadata=metadata,
                source=source,
            )

    def update(
        self,
        kind: HarnessKind,
        id: str,
        title: str,
        content: str,
        *,
        path: str | None = None,
        reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        source: str = "agent",
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        self._refuse_cross_store_prefix(kind, id, global_, kwargs)
        id, global_, _claimed_scope = _strip_scope_prefix(id, global_)
        if target := self._global_target(global_, kwargs):
            return target.update(
                kind,
                id,
                title,
                content,
                path=path,
                reference=reference,
                arguments=arguments,
                metadata=metadata,
                source=source,
            )
        self._ensure_local_writable()
        with self._write_guard():
            self._sync_from_disk()
            if kind not in self.entries:
                raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
            _require_text(kind, _describe_entry(id, title), "id", id)
            if id not in self.entries[kind]:
                raise ValueError(f"{kind} entry {id!r} does not exist")
            return self._upsert(
                kind,
                title,
                content,
                id=id,
                path=path,
                reference=reference,
                arguments=arguments,
                metadata=metadata,
                source=source,
            )

    def create_memory(
        self,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "general",
        metadata: dict[str, Any] | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.create("memory", title, content, id=id, path=path, metadata=metadata, global_=global_, **kwargs)

    def update_memory(
        self,
        id: str,
        title: str,
        content: str,
        *,
        path: str | None = None,
        metadata: dict[str, Any] | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.update("memory", id, title, content, path=path, metadata=metadata, global_=global_, **kwargs)

    def delete_memory(self, id: str, *, global_: bool = False, **kwargs: Any) -> bool:
        return self.delete("memory", id, global_=global_, **kwargs)

    def create_prompt_note(
        self,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "policy",
        metadata: dict[str, Any] | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.create("prompt", title, content, id=id, path=path, metadata=metadata, global_=global_, **kwargs)

    def update_prompt_note(
        self,
        id: str,
        title: str,
        content: str,
        *,
        path: str | None = None,
        metadata: dict[str, Any] | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.update("prompt", id, title, content, path=path, metadata=metadata, global_=global_, **kwargs)

    def delete_prompt_note(self, id: str, *, global_: bool = False, **kwargs: Any) -> bool:
        return self.delete("prompt", id, global_=global_, **kwargs)

    def create_skill(
        self,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "general",
        reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.create(
            "skill",
            title,
            content,
            id=id,
            path=path,
            reference=_validate_python_skill_reference(reference, _describe_entry(id, title)),
            arguments=arguments,
            metadata=metadata,
            global_=global_,
            **kwargs,
        )

    def update_skill(
        self,
        id: str,
        title: str,
        content: str,
        *,
        path: str | None = None,
        reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        # Only validate a reference when one is supplied; omitting it preserves the
        # existing reference (see _upsert) rather than forcing every title/content-only
        # update to re-send the full Python reference.
        validated_reference = (
            _validate_python_skill_reference(reference, _describe_entry(id, title)) if reference is not None else None
        )
        return self.update(
            "skill",
            id,
            title,
            content,
            path=path,
            reference=validated_reference,
            arguments=arguments,
            metadata=metadata,
            global_=global_,
            **kwargs,
        )

    def delete_skill(self, id: str, *, global_: bool = False, **kwargs: Any) -> bool:
        return self.delete("skill", id, global_=global_, **kwargs)

    def create_subagent(
        self,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "general",
        metadata: dict[str, Any] | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.create("subagent", title, content, id=id, path=path, metadata=metadata, global_=global_, **kwargs)

    def update_subagent(
        self,
        id: str,
        title: str,
        content: str,
        *,
        path: str | None = None,
        metadata: dict[str, Any] | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.update("subagent", id, title, content, path=path, metadata=metadata, global_=global_, **kwargs)

    def delete_subagent(self, id: str, *, global_: bool = False, **kwargs: Any) -> bool:
        return self.delete("subagent", id, global_=global_, **kwargs)

    def record_refinement(
        self,
        trigger: str,
        changes: list[str] | str,
        *,
        evidence: str = "",
        outcome: str = "",
        id: str | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> RefinementEvent:
        if target := self._global_target(global_, kwargs):
            return target.record_refinement(trigger, changes, evidence=evidence, outcome=outcome, id=id)
        _validate_refinement_event(trigger, changes, evidence=evidence, outcome=outcome)
        if id is not None and (not isinstance(id, str) or not id):
            raise ValueError(
                f"refinement event rejected: id must be a non-empty string when provided, got {_type_name(id)}"
            )
        self._ensure_local_writable()
        with self._write_guard():
            self._sync_from_disk()
            event_id = id or f"refine_{len(self.refinements) + 1:04d}"
            normalized_changes = [changes] if isinstance(changes, str) else list(changes)
            event = RefinementEvent(
                id=event_id,
                trigger=trigger,
                changes=normalized_changes,
                evidence=evidence,
                outcome=outcome,
            )
            self.refinements.append(event)
            try:
                self.save()
            except BaseException:
                self.refinements.remove(event)
                raise
        return event

    def plan_refinement(
        self,
        observation: str,
        *,
        failing_component: str = "",
        next_step: str = "",
    ) -> list[str]:
        target = f" for {failing_component}" if failing_component else ""
        plan = [
            f"Diagnose the repeated failure or opportunity{target}: {observation}",
            "Update the smallest useful prompt note, memory item, skill, or subagent spec.",
            "Run the next action with the changed harness state, then record the outcome.",
        ]
        if next_step:
            plan.append(f"Immediate validation step: {next_step}")
        return plan

    def overview(self, *, max_entries_per_kind: int = 20, global_: bool = False, **kwargs: Any) -> str:
        if target := self._global_target(global_, kwargs):
            return target.overview(max_entries_per_kind=max_entries_per_kind)
        self._sync_from_disk()
        lines = [
            f"Harness state ({self.scope}): {self.file_path}",
            "Call contract: installed Python skills use await <skill_import>(...); a skill name is a "
            "kernel module name, not a shell command, so there is no <skill_import> ... form to run from "
            "shell. Harness skill entries are Python REPL skills and must include a Python reference plus arguments. "
            "Spawn a subagent spec by composing a concise task prompt and calling "
            "handle = await rlm('sub-task'); admission returns immediately with rlm_child_id, name, session_dir, "
            "and model, never the child's answer. Results arrive only through explicit agent_message replies or "
            "files; children reply with await agent_message.send(message, receiver_role='parent'). Use "
            "await rlm.list_subagents() for active direct children (include_terminal=True names finished ones, "
            "rlm.collect reads their results) and await agent_message.send(..., receiver_role='child', "
            "receiver_name=handle.name) for follow-ups.",
        ]
        for kind in _KINDS:
            # The injection window is recency-first, not list()'s path-grouped
            # order: a path-alphabetical first dimension parks every entry written
            # under the default path behind any custom path, so newer memories
            # structurally never reach the digest (audit M4: 45.8% of a real store
            # sat below the window). Tie-break on id so one state renders one order.
            kind_records = sorted(self.entries[kind].values(), key=lambda entry: entry.id)
            kind_records.sort(key=_search_recency, reverse=True)
            records = kind_records[:max_entries_per_kind]
            lines.append(f"{kind}: {len(self.entries[kind])}")
            for entry in records:
                summary = _flatten_inline(entry.content)
                if len(summary) > 120:
                    summary = f"{summary[:117]}..."
                argument_summary = ""
                if entry.kind == "skill" and entry.arguments:
                    argument_text = json.dumps(entry.arguments, ensure_ascii=False, sort_keys=True)
                    if len(argument_text) > 120:
                        argument_text = f"{argument_text[:117]}..."
                    argument_summary = f" args={argument_text}"
                reference_summary = ""
                if entry.kind == "skill" and entry.reference:
                    reference_text = json.dumps(entry.reference, ensure_ascii=False, sort_keys=True)
                    if len(reference_text) > 120:
                        reference_text = f"{reference_text[:117]}..."
                    reference_summary = f" ref={reference_text}"
                lines.append(
                    f"  - [{entry.scope}:{_flatten_inline(entry.id)}] "
                    f"{_flatten_inline(entry.title)} ({_flatten_inline(entry.path)}, v{entry.version})"
                    f"{reference_summary}{argument_summary}: {summary}"
                )
            overflow = len(self.entries[kind]) - len(records)
            if overflow > 0:
                # A bare count hides which entries fell out of the window; name the
                # hidden ones with id + title only (no content, so the catalog stays
                # cheap), so the model can pull one explicitly with get() instead of
                # reading a truncated digest as the whole store. The catalog itself
                # is capped: every hidden entry costs one injected line, so a large
                # store would otherwise blow the digest up past the window it saved.
                lines.append(f"  - +{overflow} more (id + title only; fetch with get):")
                catalog_entries = kind_records[max_entries_per_kind:]
                for entry in catalog_entries[:_OVERFLOW_CATALOG_MAX]:
                    catalog_title = _flatten_inline(entry.title)
                    if len(catalog_title) > 120:
                        catalog_title = f"{catalog_title[:117]}..."
                    lines.append(f"    - [{entry.scope}:{_flatten_inline(entry.id)}] {catalog_title}")
                omitted = len(catalog_entries) - _OVERFLOW_CATALOG_MAX
                if omitted > 0:
                    lines.append(f"    - +{omitted} more ids omitted")
        if self.refinements:
            lines.append(f"refinements: {len(self.refinements)}")
            for event in self.refinements[-5:]:
                lines.append(f"  - [{event.id}] {event.trigger}: {', '.join(event.changes)}")
        else:
            lines.append("refinements: 0")
        return AwaitableText("\n".join(lines))

    def _near_duplicate_memory_matches(self, candidate: HarnessEntry) -> list[tuple[str, float]]:
        """Rank the store's other memories by idf-weighted cosine against ``candidate``.

        Reuses ``search``'s tokenizer (``_harness_query_terms``) and idf shape
        (``log(1 + N / df)``) over title+content, with the whole memory kind as
        the document-frequency corpus; the candidate itself is excluded from
        the match list. Only matches at ``_NEAR_DUPLICATE_SIMILARITY_MIN`` or
        better survive, best first, capped at ``_NEAR_DUPLICATE_MAX_MATCHES``.
        """
        terms = frozenset(_harness_query_terms(f"{candidate.title} {candidate.content}"))
        corpus = list(self.entries["memory"].values())
        if not terms or len(corpus) < 2:
            return []
        profiles = {
            entry.id: frozenset(_harness_query_terms(f"{entry.title} {entry.content}")) for entry in corpus
        }
        document_count = len(corpus)
        document_frequency: dict[str, int] = {}
        for profile in profiles.values():
            for term in profile:
                document_frequency[term] = document_frequency.get(term, 0) + 1
        idf = {term: math.log(1 + document_count / count) for term, count in document_frequency.items()}
        candidate_norm = math.sqrt(sum(idf[term] ** 2 for term in terms))
        if candidate_norm == 0:
            return []
        matches: list[tuple[str, float]] = []
        for entry in corpus:
            if entry.id == candidate.id:
                continue
            profile = profiles[entry.id]
            shared = terms & profile
            if not shared:
                continue
            dot = sum(idf[term] ** 2 for term in shared)
            norm = math.sqrt(sum(idf[term] ** 2 for term in profile))
            if norm == 0:
                continue
            score = dot / (candidate_norm * norm)
            if score >= _NEAR_DUPLICATE_SIMILARITY_MIN:
                matches.append((entry.id, score))
        matches.sort(key=lambda match: (-match[1], match[0]))
        return matches[:_NEAR_DUPLICATE_MAX_MATCHES]

    def _near_duplicate_memory_warning(self, entry: HarnessEntry, *, is_create: bool) -> str | None:
        matches = self._near_duplicate_memory_matches(entry)
        if not matches:
            return None
        labels = []
        for match_id, score in matches:
            flat = _flatten_inline(match_id)
            if len(flat) > 120:
                flat = f"{flat[:117]}..."
            labels.append(f"'{flat}'（相似度 {score:.2f}）")
        listed = "、".join(labels)
        if is_create:
            return (
                f"近重复警告：已有相似条目 {listed}，建议 update_memory 更新相似条目而不是新建；"
                "本次写入已完成，确属独立条目可忽略。"
            )
        return (
            f"近重复警告：已有相似条目 {listed}，"
            "与本次更新后的内容高度重合，建议合并为一条；本次更新已完成。"
        )

    def search(
        self,
        query: str,
        kind: HarnessKind | None = None,
        limit: int = 10,
        *,
        global_: bool = False,
        **kwargs: Any,
    ) -> AwaitableSearchHits:
        """Return ``(kind, id, score, snippet)`` hits ranked by term overlap.

        The result is a plain list for iteration and unpacking that also
        tolerates ``await`` (awaiting it returns the same list). Terms are
        scored against an entry's title, content, and path/id
        identifier slots; matching more distinct slots counts more. Each
        matched term is discounted by its document frequency across the
        ranked corpus (tf-idf style, ``log(1 + N / df)``), so a rare,
        distinctive term outranks terms present in most entries. Zero-score
        entries are dropped. Ties fall back to the most recently updated entry
        and then to ``(kind, id)``, so one query always returns one order.
        """
        if target := self._global_target(global_, kwargs):
            return target.search(query, kind=kind, limit=limit)
        self._sync_from_disk()
        if not isinstance(query, str):
            raise TypeError(f"query must be str, got {type(query).__name__}")
        if not isinstance(limit, int) or isinstance(limit, bool):
            raise TypeError(f"limit must be an int, got {type(limit).__name__}")
        if limit < 1:
            raise ValueError("limit must be >= 1")
        if kind is not None and kind not in self.entries:
            # An unknown kind is an argument error, reported even when the query
            # would match nothing; the list mirrors list()'s refusal.
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
        terms = _harness_query_terms(query)
        if not terms:
            return AwaitableSearchHits()

        entries = self.list(kind)

        # Document frequency per term over the ranked corpus: a term in
        # every entry weighs log(2), a term in one entry of N weighs
        # log(1 + N), so rare distinctive terms outrank ubiquitous ones.
        matches: dict[str, int] = {term: 0 for term in terms}
        for entry in entries:
            title = _search_field(entry.title)
            content = _search_field(entry.content)
            identifier = _search_field(f"{entry.path} {entry.id}")
            for term in terms:
                if term in title or term in content or term in identifier:
                    matches[term] += 1
        term_idf = {
            term: math.log(1 + len(entries) / count)
            for term, count in matches.items()
            if count > 0
        }

        scored: list[tuple[HarnessEntry, float]] = []
        for entry in entries:
            score = _search_score(entry, terms, term_idf)
            if score > 0:
                scored.append((entry, score))
        # Two stable passes: sort by the fallback key first, then by the primary
        # keys descending, which yields score desc -> updated_at desc ->
        # (kind, id) asc without making the identifier tiebreak reverse too.
        scored.sort(key=lambda hit: (hit[0].kind, hit[0].id))
        scored.sort(key=lambda hit: (hit[1], _search_recency(hit[0])), reverse=True)
        return AwaitableSearchHits(
            HarnessSearchHit(
                entry.kind,
                entry.id,
                score,
                _search_snippet(f"{entry.title} {entry.content}", terms),
            )
            for entry, score in scored[:limit]
        )

    def snapshot(self, *, global_: bool = False, **kwargs: Any) -> dict[str, Any]:
        if target := self._global_target(global_, kwargs):
            return target.snapshot()
        self._sync_from_disk()
        return {
            "file_path": str(self.file_path),
            "scope": self.scope,
            "entries": {
                kind: {entry_id: _persisted_entry_record(entry) for entry_id, entry in records.items()}
                for kind, records in self.entries.items()
            },
            "refinements": [asdict(event) for event in self.refinements],
        }


def get_harness_state(
    state_dir: str | Path | None = None, *, global_: bool = False, **kwargs: Any
) -> HarnessState:
    """Return the cached local harness state, or global when requested."""
    global_ = _resolve_global_flag(global_, kwargs)
    scope: HarnessScope = "global" if global_ else "local"
    if os.name == "nt":
        # Do not resolve state_dir or access the filesystem on unsupported Windows.
        return HarnessState(in_memory=True, scope=scope, local_write_error=WINDOWS_PERSISTENCE_UNSUPPORTED_ERROR)
    file_path = _state_file(state_dir, global_=global_)
    cache_key = (file_path, scope)
    state = _state_cache.get(cache_key)
    if state is None:
        state = HarnessState(file_path, scope=scope)
        # Recorded at construction only: an instance created from env defaults must
        # keep targeting RLM_GLOBAL_HARNESS_STATE_DIR even when a later explicit
        # state_dir call aliases the same local file. An explicit dir that merely
        # aliases the env resolution must not sandbox later global_=True writes
        # either, so pin only when the explicit dir actually diverges.
        if state_dir is not None:
            try:
                env_file: Path | None = _state_file(global_=global_)
            except RuntimeError:
                env_file = None
            if file_path != env_file:
                state._global_target_state_dir = Path(state_dir).expanduser().resolve()
        _state_cache[cache_key] = state
    return state


__all__ = [
    "CONSOLIDATION_MERGE_MIN_SCORE",
    "CONSOLIDATION_PLAN_VERSION",
    "CONSOLIDATION_STALE_MIN_CONTENT_CHARS",
    "ConsolidationAppliedEdit",
    "ConsolidationOperation",
    "ConsolidationPlan",
    "ConsolidationResult",
    "HarnessEntry",
    "HarnessKind",
    "HarnessScope",
    "HarnessSearchHit",
    "HarnessState",
    "RefinementEvent",
    "get_harness_state",
]
