#!/usr/bin/env python3
"""Grader for EX-3. Model-free; consumes --work plus the --rail-dir rails.

Gates (all required):
  - phase_a_interrupted: phase A observed its artifacts AND exited 143
    (SIGTERM mapping, print-mode.ts:98) - proves the run was live at kill.
  - phase_b_ran: phase B exit code 0.
  - phase_b_correct: phase-b.txt holds the exact pre-kill token and the
    heartbeat count recomputed from heartbeat.log at kill time
    (pre-resume.json), i.e. the resumed session recalled phase A state.
  - phase_a_untouched: phase-a.txt sha256 unchanged by the resume.
  - rail_ok (D9): the rail dir sits outside the agent-writable work dir,
    run-meta.json carries the driver-recorded run start, and
    pre-resume.json predates the phase-B launch - a snapshot rewritten
    while the phase-B agent was live is tampering and voids the run.

Usage: python3 grade_ex3.py --work /path/to/ex3-work --rail-dir /path/to/ex3-rail
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import examlib  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", required=True)
    parser.add_argument("--rail-dir", required=True, help="Dir outside --work holding run-meta.json + pre-resume.json")
    args = parser.parse_args()
    work = Path(args.work)
    rail = Path(args.rail_dir)

    verdict = {"exam": "EX-3", "pass": False, "checks": {}}
    checks = verdict["checks"]

    # D9 rail verification first: the pre-resume snapshot is the grading
    # truth, so it must be provably untouched by the phase-B agent.
    run_meta = examlib.read_run_meta(rail)
    started_at = examlib.epoch_field(run_meta, "started_at")
    # The snapshot is legitimately written mid-run, so its deadline is the
    # phase-B launch (after which an agent is live again), not the run start.
    # When phase B never launched there is no live-agent window and the
    # mtime rule does not apply (presence only).
    phase_b_started_at = examlib.epoch_field(run_meta, "phase_b_started_at")
    checks.update(examlib.verify_rail(rail, work, [("pre_resume", "pre-resume.json", phase_b_started_at)]))
    checks["rail_run_meta_present"] = started_at is not None
    checks["rail_ok"] = bool(checks["rail_ok"] and checks["rail_run_meta_present"])

    meta = json.loads((work / "run.json").read_text())
    pre = {}
    pre_path = rail / "pre-resume.json"
    if pre_path.is_file():
        try:
            loaded = json.loads(pre_path.read_text())
        except ValueError:
            loaded = None
        if isinstance(loaded, dict):
            pre = loaded
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
        ticks_expected = pre.get("heartbeat_lines_at_kill")
        checks["phase_b_token_ok"] = bool(token_match) and token_match.group(1) == pre.get("token")
        checks["phase_b_ticks_ok"] = (
            bool(ticks_match) and ticks_expected is not None and int(ticks_match.group(1)) == int(ticks_expected)
        )
        checks["phase_b_correct"] = checks["phase_b_token_ok"] and checks["phase_b_ticks_ok"]
        verdict["expected"] = {"token": pre.get("token"), "heartbeat_ticks": ticks_expected}
    else:
        checks["phase_b_correct"] = False

    verdict["pass"] = bool(
        all(checks.get(key) for key in ("phase_a_interrupted", "phase_b_ran", "phase_a_untouched", "phase_b_correct"))
        and checks["rail_ok"]
    )
    print(json.dumps(verdict, indent=2))
    return 0 if verdict["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
