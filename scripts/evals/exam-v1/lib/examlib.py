#!/usr/bin/env python3
"""Shared helpers for the MI-EXAM v1 scenario drivers (EX-3, EX-7).

Self-contained cousin of scripts/evals/swarm_fanout/runner.py: the daemon
shutdown envelope mirrors runner.py:182-218 (protocol version 7, `shutdown`
command), the session-file pick mirrors runner.py:104-118, and the env
isolation mirrors runner.py:221-258 (auth.json and models.json are copied
file-to-file, never read into memory here).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import time
from pathlib import Path

DAEMON_PROTOCOL_VERSION = 7  # packages/coding-agent/src/modes/daemon/daemon-protocol.ts:64


def shutdown_daemon(socket_path, retry_window_s: float = 0.0) -> None:
    """Deliver the daemon `shutdown` command; tolerate a late-binding daemon."""
    envelope = json.dumps(
        {
            "type": "command",
            "id": "exam-shutdown",
            "protocol": {"name": "prime-agent.daemon", "version": DAEMON_PROTOCOL_VERSION},
            "command": {"type": "shutdown"},
        }
    )
    deadline = time.monotonic() + retry_window_s
    while True:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(10)
                client.connect(str(socket_path))
                client.sendall(envelope.encode() + b"\n")
                while client.recv(4096):
                    pass
            return
        except OSError:
            if time.monotonic() >= deadline:
                return
            time.sleep(0.25)


def latest_session_file(sessions_dir):
    files = sorted(Path(sessions_dir).glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    return files[-1] if files else None


def agent_env(agent_home, sessions_dir: str) -> dict:
    """Isolated environment for the agent subprocess (see runner.py:221-258).

    Strips RLM_* depth leaks and PRIME_AGENT_INTERNAL_* so the exam session is
    an independent root session; points the agent at a private home so nothing
    touches the production agent dir; copies auth.json and models.json
    file-to-file so model auth (including custom providers) works without
    sharing state.
    """
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("PRIME_AGENT_INTERNAL_")
    }
    for key in (
        "PRIME_AGENT_BASH_SHELL",
        "PRIME_AGENT_BASH_COMMAND_PREFIX",
        "RLM_DEPTH",
        "RLM_MAX_DEPTH",
        "RLM_SESSION_DIR",
    ):
        env.pop(key, None)
    source_agent_dir = Path(env.get("PRIME_AGENT_CODING_AGENT_DIR") or Path.home() / ".prime" / "agent")
    home = Path(agent_home)
    for name in ("auth.json", "models.json"):
        # File-to-file copies, never read into memory here: auth.json holds the
        # model auth, models.json inlines custom-provider credentials (without
        # it an isolated home cannot resolve `--model custom/...`).
        source = source_agent_dir / name
        if source.is_file():
            home.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(source), str(home / name))
    env["PRIME_AGENT_CODING_AGENT_DIR"] = str(home)
    env["PI_CODING_AGENT_DIR"] = str(home)
    env["PRIME_AGENT_SESSION_DIR"] = sessions_dir
    env["PI_SESSION_DIR"] = sessions_dir
    env["PRIME_AGENT_CODING_AGENT_SESSION_DIR"] = sessions_dir
    env["PI_CODING_AGENT_SESSION_DIR"] = sessions_dir
    return env


def usage_from_json_log(log_text: str) -> dict:
    """Sum assistant tokens/turns from a --mode json log (scorer.py:377-402)."""
    tokens = 0
    turns = 0
    for line in log_text.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("type") != "message_end":
            continue
        message = entry.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        usage = message.get("usage") or {}
        total = usage.get("totalTokens", 0)
        if isinstance(total, int) and total > 0:
            tokens += total
            turns += 1
    return {"tokens": tokens, "turns": turns}


def porcelain_paths(status_text: str) -> set:
    """Path set of `git status --porcelain` output (rename lines yield both sides).

    Shared-worktree rails compare path sets, not raw text: a path dirty before
    and after the run is not drift, whichever lane owns it.
    """
    paths = set()
    for line in status_text.splitlines():
        if not line.strip():
            continue
        body = line[3:] if len(line) > 3 else ""
        for side in body.split(" -> "):
            side = side.strip()
            if side.startswith('"') and side.endswith('"') and len(side) >= 2:
                side = side[1:-1].replace('\\"', '"').replace("\\\\", "\\")
            if side:
                paths.add(side)
    return paths


# A tool-call text counts as mutating only with a write indicator; without one,
# repo paths in it are reads (the read-only exams grep/read the repo constantly).
_WRITE_INDICATOR_RE = re.compile(
    r"write_text|write_bytes|writelines|\.write\(|open\([^)\n]*['\"][wax+]"
    r"|shutil\.(?:copy|copy2|copyfile|move)\b|os\.(?:rename|remove|unlink|mkdir|makedirs|replace)\b|\.touch\("
    r"|(?<![->|])>>?(?![=>|&])"
    r"|\btee\b|\bsed\s+-i\b|\b(?:cp|mv|rm|mkdir|touch|chmod|chown|ln)\b|\bgit\s+apply\b"
)
# Indicator scoping is per command segment, not per line: shell one-liners mix
# reads and writes (`grep x /repo/f 2>/dev/null; echo done > /tmp/f`), and only
# the writing segment may attribute paths. /dev/null redirections are dropped
# first - they suppress output, they do not write files.
_DEV_NULL_RE = re.compile(r"\d*>{1,2}\s*/dev/null")
_SEGMENT_SPLIT_RE = re.compile(r"&&|\|\||[;|]")
_ABS_PATH_RE = re.compile(r"(?<![\w:.@])/[\w.@+/-]*[\w.@+-]")
_REL_PATH_RE = re.compile(r"(?<![\w@:/.+-])(?:\.{1,2}/)?(?:[\w@+-]+/)+[\w.@+-]+")
_DIRECT_PATH_TOOLS = {"write", "edit", "apply_patch"}


def _tool_calls(log_text: str):
    """Yield (tool_name, args) from a --mode json log.

    Covers the two shapes the CLI emits: top-level `tool_execution_start`
    (toolName/args) and `assistantMessageEvent.toolcall_end` (toolCall.name/
    arguments), as seen in message_update/message_end records.
    """
    for line in log_text.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        if entry.get("type") == "tool_execution_start" and isinstance(entry.get("args"), dict):
            yield entry.get("toolName"), entry["args"]
        event = entry.get("assistantMessageEvent")
        if isinstance(event, dict) and event.get("type") == "toolcall_end":
            call = event.get("toolCall")
            if isinstance(call, dict) and isinstance(call.get("arguments"), dict):
                yield call.get("name"), call["arguments"]


def _session_cwd(log_text: str):
    for line in log_text.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and entry.get("type") == "session" and isinstance(entry.get("cwd"), str):
            return entry["cwd"]
    return None


def repo_write_paths_from_log(log_text: str, repo) -> set:
    """Repo-relative paths the agent plausibly WROTE, from its --mode json log.

    Used to attribute git drift in a shared worktree: a drifted path is blamed
    on the agent only when the agent named that exact path in a write/edit
    tool call, or in a bash/ipython command segment that also carries a write
    indicator (segment-scoped, so a repo path grepped or read elsewhere in a
    cell that writes something else is not blamed). Heuristic by design
    (shell/Python writes cannot be parsed exactly, and paths built in
    variables are invisible to it); drift it cannot attribute is reported as
    foreign, not blamed.
    """
    repo_real = os.path.realpath(str(repo))
    cwd = _session_cwd(log_text)

    def relativize(token: str):
        candidate = Path(token)
        if not candidate.is_absolute():
            if cwd is None:
                return None
            candidate = Path(cwd) / candidate
        real = os.path.realpath(str(candidate))
        rel = os.path.relpath(real, repo_real)
        if rel == ".." or rel.startswith(".." + os.sep) or os.path.isabs(rel):
            return None
        return Path(rel).as_posix()

    writes = set()
    for name, args in _tool_calls(log_text):
        tokens = []
        if name in _DIRECT_PATH_TOOLS and isinstance(args.get("path"), str):
            tokens.append(args["path"])
        for key in ("command", "code", "script"):
            text = args.get(key)
            if not isinstance(text, str):
                continue
            for line in text.splitlines():
                for segment in _SEGMENT_SPLIT_RE.split(_DEV_NULL_RE.sub("", line)):
                    if _WRITE_INDICATOR_RE.search(segment):
                        tokens.extend(_ABS_PATH_RE.findall(segment))
                        tokens.extend(_REL_PATH_RE.findall(segment))
        for token in tokens:
            rel = relativize(token)
            if rel is not None:
                writes.add(rel)
    return writes
