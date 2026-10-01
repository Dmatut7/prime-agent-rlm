#!/usr/bin/env python3
"""Grader for EX-5 (code understanding: signal-exit behavior of print mode).

The three exit codes are recomputed from the signal table in
packages/coding-agent/src/modes/print-mode.ts (the `exitCode` ternary inside
the signal handler). If the table stops matching the regex, the grader fails
loud with needs_reauthor rather than grading against stale constants.

Safety rail: same write-attributed drift rule as grade_ex4.py - only repo
drift the agent's own --mode json log proves it wrote fails the run; foreign
parallel-lane drift is reported as foreign_drift.

Usage:
    python3 grade_ex5.py --repo /path/to/prime-agent --work /path/to/ex5-work \
        --pre-status /path/to/ex5-work/git-status-pre.txt \
        --agent-log /path/to/ex5-work/agent.log
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import examlib  # noqa: E402

TERNARY_RE = re.compile(
    r'exitCode\s*=\s*signal === "SIGINT" \? (\d+) : signal === "SIGHUP" \? (\d+) : (\d+)'
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--work", required=True)
    parser.add_argument("--pre-status", required=True)
    parser.add_argument("--agent-log", required=True, help="The agent's --mode json log (write attribution)")
    args = parser.parse_args()

    repo = Path(args.repo)
    work = Path(args.work)
    verdict = {"exam": "EX-5", "pass": False, "checks": {}, "needs_reauthor": []}
    checks = verdict["checks"]

    print_mode = repo / "packages/coding-agent/src/modes/print-mode.ts"
    text = print_mode.read_text()
    match = TERNARY_RE.search(text)
    checks["found_signal_table"] = match is not None
    if not match:
        verdict["needs_reauthor"].append("signal_table")
        print(json.dumps(verdict, indent=2))
        return 1
    expected = {
        "sigint_exit": int(match.group(1)),
        "sighup_exit": int(match.group(2)),
        "sigterm_exit": int(match.group(3)),
    }
    checks["found_dispose_fn"] = "disposeConnection" in text

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
                if isinstance(got, str) and got.isdigit():
                    got = int(got)
                per_key[key] = got == value
            file_answer = str(answers.get("file", ""))
            per_key["file"] = file_answer.replace("\\", "/").endswith(
                "packages/coding-agent/src/modes/print-mode.ts"
            ) or file_answer.replace("\\", "/").endswith("src/modes/print-mode.ts")
            checks["per_key"] = per_key
            checks["values_ok"] = all(per_key.values())
            verdict["expected"] = expected
            verdict["actual"] = answers

    agent_log = Path(args.agent_log)
    checks["agent_log_present"] = agent_log.is_file()
    pre = Path(args.pre_status).read_text() if Path(args.pre_status).is_file() else None
    post = subprocess.run(
        ["git", "-C", str(repo), "status", "--porcelain"], capture_output=True, text=True, timeout=30
    ).stdout
    if pre is None or not agent_log.is_file():
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
