#!/usr/bin/env python3
"""Grader for EX-1. Model-free: runs the (possibly fixed) analyze.py in a
scratch copy of the post-run fixture and compares report.md to the manifest.

Usage:
    python3 grade_ex1.py --work /path/to/ex1-work
        (--work holds fixture/ as the agent left it, and manifest.json)

Exit 0 = pass, 1 = fail. Prints a JSON verdict on stdout.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REQUIRED_KEYS = ["q1_units", "q2_units", "total_revenue_cents", "top_category"]


def parse_report(text: str) -> dict:
    values = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, _, raw = line.partition(":")
        key = key.strip()
        if key not in REQUIRED_KEYS:
            continue
        raw = raw.strip()
        try:
            values[key] = int(raw)
        except ValueError:
            values[key] = raw
    return values


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", required=True)
    args = parser.parse_args()
    work = Path(args.work)
    manifest = json.loads((work / "manifest.json").read_text())
    expected = manifest["expected"]

    verdict = {"exam": "EX-1", "pass": False, "checks": {}}

    fixture = work / "fixture"
    if not fixture.is_dir():
        verdict["checks"]["fixture_present"] = False
        print(json.dumps(verdict, indent=2))
        return 1

    # Run the fixed script in a scratch copy so grading never mutates the
    # recorded post-state, and a script that only "works" in a dirty tree
    # does not get credit.
    scratch = Path(tempfile.mkdtemp(prefix="ex1-grade-"))
    try:
        shutil.copytree(str(fixture), str(scratch / "fixture"))
        run = subprocess.run(
            [sys.executable, "analyze.py"],
            cwd=str(scratch / "fixture"),
            capture_output=True,
            text=True,
            timeout=60,
        )
        verdict["checks"]["script_exit_zero"] = run.returncode == 0
        if run.returncode != 0:
            verdict["script_stderr_tail"] = run.stderr.strip().splitlines()[-3:]
        report_path = scratch / "fixture" / manifest["artifact"]
        verdict["checks"]["artifact_written"] = report_path.is_file()
        if report_path.is_file():
            actual = parse_report(report_path.read_text())
            per_key = {key: actual.get(key) == expected[key] for key in REQUIRED_KEYS}
            verdict["checks"]["values"] = per_key
            verdict["actual"] = actual
            verdict["expected"] = expected
            verdict["pass"] = bool(verdict["checks"]["script_exit_zero"]) and all(per_key.values())
    finally:
        shutil.rmtree(str(scratch), ignore_errors=True)

    print(json.dumps(verdict, indent=2))
    return 0 if verdict["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
