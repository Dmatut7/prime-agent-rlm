#!/usr/bin/env python3
"""Shared helpers for the MI-EXAM v1 scenario drivers (EX-3, EX-7) and graders.

Self-contained cousin of scripts/evals/swarm_fanout/runner.py: the daemon
shutdown envelope mirrors runner.py:182-218 (protocol version 7, `shutdown`
command), the session-file pick mirrors runner.py:104-118, and the env
isolation mirrors runner.py:221-258 (auth.json and models.json are copied
file-to-file, never read into memory here).

The grading-rail helpers (resolve_rail_dir/record_run_meta/read_run_meta/
verify_rail) implement the D9 hardening: rails live outside the
agent-writable work dir and graders reject rail files rewritten after the
run started. The answer-source helpers (hash_answer_source/
write_answer_source_hashes/read_answer_source_hashes/verify_answer_source)
implement the D10 hardening for EX-1/EX-2: the driver pins a sha256 per
answer-source file into the rail dir before launch, and graders re-hash
their canonical set at grade time.
"""
from __future__ import annotations

import hashlib
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
    # The supervisor registry (owner records, shutdown tombstones, startup
    # fences) defaults to the machine-global ~/.prime/supervisor-owners;
    # without this an exam daemon writes its tombstones into the real registry.
    env["PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR"] = str(home / "supervisor-owners")
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


# --- Grading rails (D9) ------------------------------------------------------
#
# A rail is a grader input the exam agent must never touch: the pre-run
# `git status` snapshot (EX-4/EX-5), the pre-resume snapshot (EX-3), the
# driver-recorded run metadata, and the agent log. Rails live in an
# operator-chosen --rail-dir OUTSIDE the agent-writable work dir, and the
# prompt never names that path. Drivers record the run start (and EX-3's
# phase-B start) into run-meta.json before launching the agent; graders
# reject a rail file whose mtime postdates its deadline - a snapshot
# rewritten after launch is tampering (the wave-15 incident) - and fail
# closed when the run-meta anchor is missing.

RUN_META_NAME = "run-meta.json"


def _paths_overlap(a: Path, b: Path) -> bool:
    """True when either resolved path is the other or contains the other."""
    if a == b:
        return True
    for inner, outer in ((a, b), (b, a)):
        try:
            inner.relative_to(outer)
            return True
        except ValueError:
            continue
    return False


def resolve_rail_dir(rail_dir, work) -> Path:
    """Driver side: the rail dir must sit outside the agent-writable work dir.

    Everything under --work is writable by the exam agent; a rail dir nested
    in it (or wrapping it) is forgeable, so refuse instead of recording
    trustworthy-looking rails.
    """
    rail = Path(rail_dir).resolve()
    if _paths_overlap(rail, Path(work).resolve()):
        raise ValueError(
            "rail dir %s must live outside --work (%s): everything under --work is agent-writable"
            % (rail, Path(work).resolve())
        )
    return rail


def record_run_meta(rail_dir, **fields) -> Path:
    """Driver side: write/merge run-meta.json. Call BEFORE the agent launches."""
    path = Path(rail_dir) / RUN_META_NAME
    meta = {}
    if path.is_file():
        try:
            loaded = json.loads(path.read_text())
        except ValueError:
            loaded = None
        if isinstance(loaded, dict):
            meta = loaded
    meta.update(fields)
    path.write_text(json.dumps(meta, indent=2) + "\n")
    return path


def read_run_meta(rail_dir) -> dict:
    """Grader side: parsed run-meta.json, or {} when absent or unparseable."""
    try:
        meta = json.loads((Path(rail_dir) / RUN_META_NAME).read_text())
    except (OSError, ValueError):
        return {}
    return meta if isinstance(meta, dict) else {}


def epoch_field(meta: dict, key: str):
    """A numeric epoch-seconds field, or None (bools are not epochs)."""
    value = meta.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def verify_rail(rail_dir, work, files) -> dict:
    """Grader-side rail integrity checks; fail closed on any violation.

    files: (label, filename, deadline) triples. Each file must exist in the
    rail dir, and the rail dir must sit outside the agent-writable work dir.
    A deadline of None means the file's mtime legitimately advances during
    the run (agent.log); otherwise the mtime must not postdate the deadline
    (the driver-recorded run start, or EX-3's phase-B start).
    """
    checks = {}
    rail = Path(rail_dir).resolve()
    outside = not _paths_overlap(rail, Path(work).resolve())
    checks["rail_dir_outside_work"] = outside
    ok = outside
    for label, filename, deadline in files:
        path = rail / filename
        present = path.is_file()
        checks["rail_%s_present" % label] = present
        ok = ok and present
        if deadline is not None:
            predates = present and path.stat().st_mtime <= deadline
            checks["rail_%s_predates_run" % label] = bool(predates)
            ok = ok and predates
    checks["rail_ok"] = bool(ok)
    return checks


# --- Answer-source pinning (D10) ---------------------------------------------
#
# EX-1/EX-2 grade against artifacts that sit inside the agent-writable work
# dir: EX-1 trusts manifest.json (the expected values) and a run of
# analyze.py over fixture/data/*.csv; EX-2 rescans fixture/docs/*.md as the
# needle truth at grade time. A tampering agent can therefore forge a pass
# (rewrite the manifest to its broken output; edit the corpus to match its
# answers). The driver pins a sha256 per answer-source file into
# answer-source-sha256.json BEFORE the agent launches (same D9 ordering:
# the pin lands before the started_at anchor); the grader re-hashes its
# canonical set and fails on any changed/missing/extra file, and the D9
# mtime rule catches an agent that re-pins the rail to its tampered corpus.

ANSWER_SOURCE_HASHES_NAME = "answer-source-sha256.json"


def sha256_file(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def hash_answer_source(work, patterns) -> dict:
    """Map of work-relative POSIX path -> sha256 for every file a pattern hits.

    Patterns are Path.glob patterns relative to --work; absolute patterns and
    patterns with `..` segments are refused (the rail must never point outside
    the work dir). A symlinked match whose target escapes --work is recorded
    with an `escape:<resolved>` marker instead of a hash, so the grader flags
    it as changed rather than crashing or reading outside the exam.
    """
    root = Path(work).resolve()
    hashes = {}
    for pattern in patterns:
        parsed = Path(pattern)
        if parsed.is_absolute() or ".." in parsed.parts:
            raise ValueError("answer-source pattern %r must stay inside --work" % pattern)
        for path in sorted(root.glob(pattern)):
            if not path.is_file():
                continue
            resolved = path.resolve()
            try:
                rel = resolved.relative_to(root).as_posix()
            except ValueError:
                rel = path.relative_to(root).as_posix()
                hashes[rel] = "escape:" + str(resolved)
                continue
            hashes[rel] = sha256_file(resolved)
    return hashes


def write_answer_source_hashes(rail_dir, hashes: dict) -> Path:
    """Driver side: pin the answer-source hashes into the rail dir. Call BEFORE
    record_run_meta so the pin's mtime predates the run-start anchor."""
    path = Path(rail_dir) / ANSWER_SOURCE_HASHES_NAME
    path.write_text(json.dumps(hashes, indent=2, sort_keys=True) + "\n")
    return path


def read_answer_source_hashes(rail_dir) -> dict:
    """Grader side: the recorded {path: sha256} map, or {} when absent or
    unparseable (fail closed: the caller treats {} as not recorded)."""
    try:
        recorded = json.loads((Path(rail_dir) / ANSWER_SOURCE_HASHES_NAME).read_text())
    except (OSError, ValueError):
        return {}
    if not isinstance(recorded, dict):
        return {}
    return {key: value for key, value in recorded.items() if isinstance(key, str) and isinstance(value, str)}


def verify_answer_source(rail_dir, work, patterns, deadline) -> dict:
    """Grader-side answer-source integrity; fail closed on any violation.

    Combines the D9 rail check on the pin file (present in a rail dir outside
    --work, mtime not after the run-start deadline) with a content comparison:
    the grader re-hashes its canonical patterns and requires the exact
    recorded set - a changed, missing (deleted), or extra (planted) file all
    void the run. An empty recording fails closed (a driver invoked without
    --corpus-glob must not pass vacuously).
    """
    checks = verify_rail(rail_dir, work, [("answer_source", ANSWER_SOURCE_HASHES_NAME, deadline)])
    recorded = read_answer_source_hashes(rail_dir)
    checks["answer_source_hashes_recorded"] = bool(recorded)
    current = hash_answer_source(work, patterns)
    checks["answer_source_missing"] = sorted(set(recorded) - set(current))
    checks["answer_source_extra"] = sorted(set(current) - set(recorded))
    checks["answer_source_changed"] = sorted(
        path for path in set(recorded) & set(current) if recorded[path] != current[path]
    )
    checks["answer_source_ok"] = bool(
        checks["rail_ok"]
        and checks["answer_source_hashes_recorded"]
        and not checks["answer_source_missing"]
        and not checks["answer_source_extra"]
        and not checks["answer_source_changed"]
    )
    return checks


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
