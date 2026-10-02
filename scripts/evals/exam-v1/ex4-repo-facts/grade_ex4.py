#!/usr/bin/env python3
"""Dynamic grader for EX-4 (code understanding: protocol facts of this repo).

Every expected value is recomputed from the repo at grade time, so the exam
survives refactors and version bumps; a wave that changes the protocol
constants does not rot the question. If a regex stops matching, the grader
fails loud with needs_reauthor instead of silently passing.

Checks (all exact match, machine-graded):
  daemon_protocol_version, daemon_schema_revision
      <- packages/coding-agent/src/modes/daemon/daemon-protocol.ts
  kernel_protocol_version, kernel_min_protocol, kernel_default_protocol,
  kernel_heartbeat_interval_ms, kernel_heartbeat_env_var
      <- prime-agent-runtime/src/rlm/repl.py
  ledger_digest
      <- sha256(realpath(ledger_sessions_dir))[:16], mirroring
         packages/coding-agent/src/modes/daemon/rlm-ledger.ts:202-206
         (canonicalize-then-hash). The prompt pins the literal dir.

Safety rail: drift in the repo (git status --porcelain path-set difference
between the pre-run snapshot and grade time) must not be attributable to the
agent. Attribution comes from the agent's write-path set, extracted from its
--mode json log by examlib.repo_write_paths_from_log; drift the agent never
touched for writing is reported as foreign_drift (parallel lanes share the
worktree) and does not fail the run.

Rail integrity (D9): the pre-run snapshot, the driver-recorded
run-meta.json, and the agent log live in --rail-dir OUTSIDE the
agent-writable work dir, and the prompt never names that path. The grader
fails closed when the rail dir overlaps the work dir, when run-meta.json
lacks the run-start timestamp, or when the pre-run snapshot's mtime
postdates that timestamp (the wave-15 incident: the agent re-snapshotted
`git status` over git-status-pre.txt mid-run, erasing the drift evidence).

Usage:
    python3 grade_ex4.py --repo /path/to/prime-agent --work /path/to/ex4-work \
        --sessions-dir /tmp/prime-exam/ex4/sessions \
        --rail-dir /path/to/ex4-rail
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import examlib  # noqa: E402


def grep_int(path: Path, pattern: str, key: str, checks: dict):
    match = re.search(pattern, path.read_text(), re.MULTILINE)
    checks["found_" + key] = match is not None
    return int(match.group(1)) if match else None


def grep_str(path: Path, pattern: str, key: str, checks: dict):
    match = re.search(pattern, path.read_text(), re.MULTILINE)
    checks["found_" + key] = match is not None
    return match.group(1) if match else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--work", required=True)
    parser.add_argument("--sessions-dir", required=True, help="Literal path pinned in the prompt")
    parser.add_argument(
        "--rail-dir",
        required=True,
        help="Dir outside --work holding the grading rails (git-status-pre.txt, run-meta.json, agent.log)",
    )
    args = parser.parse_args()

    repo = Path(args.repo)
    work = Path(args.work)
    verdict = {"exam": "EX-4", "pass": False, "checks": {}, "needs_reauthor": []}

    daemon_protocol = repo / "packages/coding-agent/src/modes/daemon/daemon-protocol.ts"
    repl = repo / "prime-agent-runtime/src/rlm/repl.py"
    checks = verdict["checks"]

    expected = {
        "daemon_protocol_version": grep_int(daemon_protocol, r"DAEMON_PROTOCOL_VERSION = (\d+);", "dpv", checks),
        "daemon_schema_revision": grep_int(daemon_protocol, r"DAEMON_SCHEMA_REVISION = (\d+);", "dsr", checks),
        "kernel_protocol_version": grep_int(repl, r"^PROTOCOL_VERSION = (\d+)$", "kpv", checks),
        "kernel_min_protocol": grep_int(repl, r"^MIN_PROTOCOL_VERSION = (\d+)$", "kmin", checks),
        "kernel_default_protocol": grep_int(repl, r"^DEFAULT_PROTOCOL_VERSION = (\d+)$", "kdef", checks),
        "kernel_heartbeat_interval_ms": grep_int(repl, r"^DEFAULT_HEARTBEAT_INTERVAL_MS = (\d+)$", "khb", checks),
        "kernel_heartbeat_env_var": grep_str(repl, r'^HEARTBEAT_INTERVAL_ENV_VAR = "([^"]+)"$', "kenv", checks),
    }
    # The product canonicalizes (realpath) before hashing; macOS maps /tmp ->
    # /private/tmp, so this is computed live, never hardcoded.
    canonical = os.path.realpath(args.sessions_dir)
    expected["ledger_digest"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
    verdict["canonical_sessions_dir"] = canonical

    for key, value in expected.items():
        if value is None:
            verdict["needs_reauthor"].append(key)
    if verdict["needs_reauthor"]:
        print(json.dumps(verdict, indent=2))
        return 1

    answers_path = work / "answers.json"
    checks["answers_present"] = answers_path.is_file()
    if checks["answers_present"]:
        try:
            answers = json.loads(answers_path.read_text())
        except ValueError as exc:
            answers = {}
            checks["answers_parseable"] = False
            verdict["parse_error"] = str(exc)
        if answers:
            checks["answers_parseable"] = True
            per_key = {}
            for key, value in expected.items():
                got = answers.get(key)
                if isinstance(value, int) and isinstance(got, str) and got.isdigit():
                    got = int(got)
                per_key[key] = got == value
            checks["per_key"] = per_key
            checks["values_ok"] = all(per_key.values())
            verdict["expected"] = expected
            verdict["actual"] = answers

    # D9 rail verification: the drift rail is meaningless unless its inputs
    # are provably untouched by the agent (see the module docstring).
    rail = Path(args.rail_dir)
    run_meta = examlib.read_run_meta(rail)
    started_at = examlib.epoch_field(run_meta, "started_at")
    checks.update(
        examlib.verify_rail(
            rail,
            work,
            [("pre_status", "git-status-pre.txt", started_at), ("agent_log", "agent.log", None)],
        )
    )
    checks["rail_run_meta_present"] = started_at is not None
    checks["rail_ok"] = bool(checks["rail_ok"] and checks["rail_run_meta_present"])

    # Repo-untouched rail with write attribution: only drift the agent's own
    # log proves it wrote fails the run; other lanes' drift is reported.
    agent_log = rail / "agent.log"
    pre_path = rail / "git-status-pre.txt"
    pre = pre_path.read_text() if pre_path.is_file() else None
    post = subprocess.run(
        ["git", "-C", str(repo), "status", "--porcelain"], capture_output=True, text=True, timeout=30
    ).stdout
    if pre is None or not agent_log.is_file() or not checks["rail_ok"]:
        checks["repo_untouched"] = False
    else:
        drift = examlib.porcelain_paths(pre) ^ examlib.porcelain_paths(post)
        agent_writes = examlib.repo_write_paths_from_log(agent_log.read_text(), repo)
        blamed = sorted(path for path in drift if path in agent_writes)
        foreign = sorted(drift - set(blamed))
        checks["repo_untouched"] = not blamed
        checks["agent_repo_writes"] = blamed
        if foreign:
            checks["foreign_drift"] = foreign

    verdict["pass"] = bool(
        checks.get("answers_present")
        and checks.get("answers_parseable")
        and checks.get("values_ok")
        and checks["repo_untouched"]
    )
    print(json.dumps(verdict, indent=2))
    return 0 if verdict["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
