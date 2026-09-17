"""Persistent harness-state helpers for Prime Agent's RLM kernel.

The state model is intentionally small: it records prompt notes, memory,
skills, subagent specs, and refinement events in the session-local harness
store by default; pass ``global_=True`` for the cross-session global store.
Execution still belongs to Prime Agent's TypeScript host and the existing
``rlm.run`` recursion bridge.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import stat
import unicodedata
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, NamedTuple, Sequence

HarnessKind = Literal["prompt", "memory", "skill", "subagent"]
HarnessScope = Literal["local", "global"]

_DEFAULT_FILE_NAME = "harness_state.json"
_DEFAULT_HARNESS_DIR_NAME = "harness"
WINDOWS_PERSISTENCE_UNSUPPORTED_ERROR = "Persistent harness storage is unsupported on Windows"
_KINDS: tuple[HarnessKind, ...] = ("prompt", "memory", "skill", "subagent")
_state_cache: dict[tuple[Path, HarnessScope], "HarnessState"] = {}


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


def _search_score(entry: "HarnessEntry", terms: Sequence[str]) -> float:
    """Weighted term overlap over the title, content, and identifier slots."""
    title = _search_field(entry.title)
    content = _search_field(entry.content)
    # The id is usually embedded in the path, so matching both is one
    # identifier signal rather than two.
    identifier = _search_field(f"{entry.path} {entry.id}")
    total = 0.0
    for term in terms:
        slots = (term in title) + (term in content) + (term in identifier)
        if slots:
            total += 1 + (slots - 1) * 0.5
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


@dataclass
class HarnessEntry:
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


@dataclass
class RefinementEvent:
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


_ENTRY_FIELDS = {field.name for field in fields(HarnessEntry)}
_REFINEMENT_FIELDS = {field.name for field in fields(RefinementEvent)}


def _validate_python_skill_reference(reference: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(reference, dict):
        raise ValueError("skill entries require a Python reference")
    normalized = dict(reference)
    if normalized.get("type") != "python":
        raise ValueError("skill reference.type must be 'python'")
    if not any(isinstance(normalized.get(key), str) and normalized[key] for key in ("import", "python_import")):
        raise ValueError("skill reference requires a Python import")
    if not any(isinstance(normalized.get(key), str) and normalized[key] for key in ("callable", "call_pattern")):
        raise ValueError("skill reference requires a callable or call_pattern")
    return normalized


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
        self.load()

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
        value recorded at our last load/save.
        """
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
        data = {
            "schema": 1,
            "entries": {
                kind: {entry_id: asdict(entry) for entry_id, entry in records.items()}
                for kind, records in self.entries.items()
            },
            "refinements": [asdict(event) for event in self.refinements],
        }
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
        self._sync_from_disk()
        self._ensure_local_writable()
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

        entry_id = id or _slug(title, kind)
        existing = self.entries[kind].get(entry_id)
        if existing:
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
        self.save()
        return entry

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
        self._sync_from_disk()
        self._ensure_local_writable()
        if kind not in self.entries:
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
        if id not in self.entries[kind]:
            return False
        del self.entries[kind][id]
        self.save()
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
        self._sync_from_disk()
        self._ensure_local_writable()
        if kind not in self.entries:
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
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
        self._sync_from_disk()
        self._ensure_local_writable()
        if kind not in self.entries:
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
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
            reference=_validate_python_skill_reference(reference),
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
        validated_reference = _validate_python_skill_reference(reference) if reference is not None else None
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
        if not isinstance(trigger, str):
            raise ValueError("trigger must be a string")
        if not isinstance(changes, (list, str)):
            raise ValueError("changes must be a list of strings or a single string")
        if isinstance(changes, list) and not all(isinstance(change, str) for change in changes):
            raise ValueError("changes must be a list of strings or a single string")
        if not isinstance(evidence, str):
            raise ValueError("evidence must be a string")
        if not isinstance(outcome, str):
            raise ValueError("outcome must be a string")
        if id is not None and not isinstance(id, str):
            raise ValueError("id must be a string or None")
        self._sync_from_disk()
        self._ensure_local_writable()
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
        self.save()
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
            "await rlm.list_subagents() to recover direct child handles and await agent_message.send(..., "
            "receiver_role='child', receiver_name=handle.name) for follow-ups.",
        ]
        for kind in _KINDS:
            records = self.list(kind)[:max_entries_per_kind]
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
                lines.append(f"  - +{overflow} more")
        if self.refinements:
            lines.append(f"refinements: {len(self.refinements)}")
            for event in self.refinements[-5:]:
                lines.append(f"  - [{event.id}] {event.trigger}: {', '.join(event.changes)}")
        else:
            lines.append("refinements: 0")
        return "\n".join(lines)

    def search(
        self,
        query: str,
        kind: HarnessKind | None = None,
        limit: int = 10,
        *,
        global_: bool = False,
        **kwargs: Any,
    ) -> list[HarnessSearchHit]:
        """Return ``(kind, id, score, snippet)`` hits ranked by term overlap.

        Terms are scored against an entry's title, content, and path/id
        identifier slots; matching more distinct slots counts more. Zero-score
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
            return []

        scored: list[tuple[HarnessEntry, float]] = []
        for entry in self.list(kind):
            score = _search_score(entry, terms)
            if score > 0:
                scored.append((entry, score))
        # Two stable passes: sort by the fallback key first, then by the primary
        # keys descending, which yields score desc -> updated_at desc ->
        # (kind, id) asc without making the identifier tiebreak reverse too.
        scored.sort(key=lambda hit: (hit[0].kind, hit[0].id))
        scored.sort(key=lambda hit: (hit[1], _search_recency(hit[0])), reverse=True)
        return [
            HarnessSearchHit(
                entry.kind,
                entry.id,
                score,
                _search_snippet(f"{entry.title} {entry.content}", terms),
            )
            for entry, score in scored[:limit]
        ]

    def snapshot(self, *, global_: bool = False, **kwargs: Any) -> dict[str, Any]:
        if target := self._global_target(global_, kwargs):
            return target.snapshot()
        self._sync_from_disk()
        return {
            "file_path": str(self.file_path),
            "scope": self.scope,
            "entries": {
                kind: {entry_id: asdict(entry) for entry_id, entry in records.items()}
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
    "HarnessEntry",
    "HarnessKind",
    "HarnessScope",
    "HarnessSearchHit",
    "HarnessState",
    "RefinementEvent",
    "get_harness_state",
]
