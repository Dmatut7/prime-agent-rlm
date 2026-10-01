#!/usr/bin/env python3
"""Grader for EX-3. Model-free; consumes only files under --work.

Gates (all required):
  - phase_a_interrupted: phase A observed its artifacts AND exited 143
    (SIGTERM mapping, print-mode.ts:98) - proves the run was live at kill.
  - phase_b_ran: phase B exit code 0.
  - phase_b_correct: phase-b.txt holds the exact pre-kill token and the
    heartbeat count recomputed from heartbeat.log at kill time
    (pre-resume.json), i.e. the resumed session recalled phase A state.
  - phase_a_untouched: phase-a.txt sha256 unchanged by the resume.

Usage: python3 grade_ex3.py --work /path/to/ex3-work
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", required=True)
    args = parser.parse_args()
    work = Path(args.work)

    verdict = {"exam": "EX-3", "pass": False, "checks": {}}
    checks = verdict["checks"]

    meta = json.loads((work / "run.json").read_text())
    pre = json.loads((work / "pre-resume.json").read_text())
    fixture = work / "fixture"

    checks["phase_a_interrupted"] = bool(meta.get("phase_a_observed_artifacts")) and meta.get(
        "phase_a_exit_code"
    ) == 143
    checks["phase_b_ran"] = meta.get("phase_b_exit_code") == 0

    phase_a = fixture / "phase-a.txt"
    checks["phase_a_untouched"] = (
        pre.get("phase_a_sha256") is not None
        and phase_a.is_file()
        and hashlib.sha256(phase_a.read_bytes()).hexdigest() == pre["phase_a_sha256"]
    )

    phase_b = fixture / "phase-b.txt"
    checks["phase_b_present"] = phase_b.is_file()
    if phase_b.is_file():
        text = phase_b.read_text()
        token_match = re.search(r"^token:\s*(\S+)\s*$", text, re.MULTILINE)
        ticks_match = re.search(r"^heartbeat_ticks:\s*(\d+)\s*$", text, re.MULTILINE)
        checks["phase_b_token_ok"] = bool(token_match) and token_match.group(1) == pre["token"]
        checks["phase_b_ticks_ok"] = bool(ticks_match) and int(ticks_match.group(1)) == int(
            pre["heartbeat_lines_at_kill"]
        )
        checks["phase_b_correct"] = checks["phase_b_token_ok"] and checks["phase_b_ticks_ok"]
        verdict["expected"] = {"token": pre["token"], "heartbeat_ticks": pre["heartbeat_lines_at_kill"]}
    else:
        checks["phase_b_correct"] = False

    verdict["pass"] = all(
        checks.get(key) for key in ("phase_a_interrupted", "phase_b_ran", "phase_a_untouched", "phase_b_correct")
    )
    print(json.dumps(verdict, indent=2))
    return 0 if verdict["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
