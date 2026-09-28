"""Exact single-occurrence string replacement for existing files."""

from __future__ import annotations

import contextlib
from pathlib import Path
from typing import Any

try:
    # Marks this skill's writes in the host's change list; display-only.
    from rlm.effects import write_source as _write_source
except Exception:  # an older kernel runtime without change tracking

    def _write_source(_source: str) -> Any:
        return contextlib.nullcontext()


try:
    # The runtime's own secret scan: the diff below is saved with the session like a file-change record.
    from rlm.effects import (
        is_sensitive_path as _is_sensitive_path,
        looks_secret as _looks_secret,
    )
except Exception:  # an older kernel runtime without the scan: the diff goes out as it always did

    def _is_sensitive_path(_path: str) -> bool:
        return False

    def _looks_secret(_text: str) -> bool:
        return False


async def run(path: str, old_str: str, new_str: str) -> str:
    """Replace a unique string in a file.

    ``old_str`` must appear exactly once in the file at ``path``; that match is
    replaced with ``new_str`` and the file is written back in place. Prefer this
    over rewriting a whole file for targeted edits.

    Args:
        path: File to edit, relative to the working directory, absolute, or
            `~`-prefixed (the leading `~`/`~user` is expanded to the home dir).
        old_str: Exact text to find. Must occur exactly once in the file.
        new_str: Replacement text.

    Returns:
        A short confirmation message.

    Raises:
        FileNotFoundError: If ``path`` does not exist.
        ValueError: If ``old_str`` is absent or matches more than once.
    """
    filepath = Path(path).expanduser()
    if not filepath.exists():
        raise FileNotFoundError(f"{path} not found")
    content = filepath.read_text(encoding="utf-8")
    count = content.count(old_str)
    if count == 0:
        raise ValueError(f"string not found in {path}")
    if count > 1:
        raise ValueError(
            f"found {count} occurrences in {path}, need exactly 1 — "
            "widen the snippet to make it unique"
        )
    match_index = content.index(old_str)
    start_line = content.count("\n", 0, match_index) + 1
    with _write_source("edit"):
        filepath.write_text(content.replace(old_str, new_str, 1), encoding="utf-8")
    resolved_path = str(filepath.resolve())
    _emit_diff(resolved_path, old_str, new_str, start_line)
    return f"Edited {resolved_path}"


# Keep in sync with DIFF_DISPLAY_MIME in src/core/kernel/index.ts.
_DIFF_DISPLAY_MIME = "application/vnd.prime-agent.diff+json"


def _withheld(path: str, old_str: str, new_str: str) -> bool:
    """Whether the edit's texts must stay out of the diff payload: a credential file, or a secret in either text."""
    try:
        return _is_sensitive_path(path) or _looks_secret(old_str) or _looks_secret(new_str)
    except Exception:
        return True


def _emit_diff(path: str, old_str: str, new_str: str, start_line: int) -> None:
    """Stream a diff to the host as a display event; best-effort outside the kernel.

    The host saves the payload with the session, so a withheld edit sends only its path.
    """
    try:
        from rlm import emit

        diff: dict[str, Any]
        if _withheld(path, old_str, new_str):
            diff = {"path": path, "omitted": "sensitive"}
        else:
            diff = {
                "path": path,
                "old_str": old_str,
                "new_str": new_str,
                "start_line": start_line,
            }
        emit({_DIFF_DISPLAY_MIME: diff, "text/plain": f"Edited {path}"})
    except Exception:
        pass
