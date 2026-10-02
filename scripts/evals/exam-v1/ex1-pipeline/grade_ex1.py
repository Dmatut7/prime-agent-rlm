#!/usr/bin/env python3
"""Grader for EX-1. Model-free: runs the (possibly fixed) analyze.py in a
scratch copy of the post-run fixture and compares report.md to the manifest.

Answer-source rail (D10): the manifest (the expected values this grader
trusts) and fixture/data/*.csv (the input the report is computed from) sit
inside the agent-writable work dir, so the driver sha256-pins them into
--rail-dir/answer-source-sha256.json BEFORE the agent launches
(run_manual.py --corpus-glob). The grader re-hashes the same canonical set
and fails closed on any changed/missing/extra file, on a missing pin or
run-start anchor, and - via the D9 mtime rule - on a pin rewritten after
the run started (the agent re-pinning the rail to its tampered corpus).
analyze.py itself is deliberately not pinned: fixing it is the exam.

Usage:
    python3 grade_ex1.py --work /path/to/ex1-work --rail-dir /path/to/ex1-rail
        (--work holds fixture/ as the agent left it, and manifest.json;
         --rail-dir holds the driver-recorded run-meta.json and
         answer-source-sha256.json)

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

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import examlib  # noqa: E402

REQUIRED_KEYS = ["q1_units", "q2_units", "total_revenue_cents", "top_category"]

ANSWER_SOURCE_PATTERNS = ("manifest.json", "fixture/data/*.csv")


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
    parser.add_argument(
        "--rail-dir",
        required=True,
        help="Dir outside --work holding run-meta.json + answer-source-sha256.json",
    )
    args = parser.parse_args()
    work = Path(args.work)
    rail = Path(args.rail_dir)

    verdict = {"exam": "EX-1", "pass": False, "checks": {}}
    checks = verdict["checks"]

    # D10 rail verification first: the manifest and the CSVs are the grading
    # truth, so they must be provably untouched by the agent (D9 mechanics:
    # outside-work rail dir, driver-recorded run-start anchor, mtime rule).
    run_meta = examlib.read_run_meta(rail)
    started_at = examlib.epoch_field(run_meta, "started_at")
    checks.update(examlib.verify_answer_source(rail, work, ANSWER_SOURCE_PATTERNS, started_at))
    checks["rail_run_meta_present"] = started_at is not None
    checks["rail_ok"] = bool(checks["rail_ok"] and checks["rail_run_meta_present"])

    expected = None
    artifact = "report.md"
    try:
        manifest = json.loads((work / "manifest.json").read_text())
        candidate = manifest["expected"]
        if not isinstance(candidate, dict) or any(key not in candidate for key in REQUIRED_KEYS):
            raise ValueError("manifest expected lacks required keys")
        expected = candidate
        artifact = manifest.get("artifact", artifact)
        checks["manifest_parseable"] = True
    except (OSError, ValueError) as exc:
        checks["manifest_parseable"] = False
        verdict["manifest_error"] = str(exc)

    fixture = work / "fixture"
    checks["fixture_present"] = fixture.is_dir()

    # Run the fixed script in a scratch copy so grading never mutates the
    # recorded post-state, and a script that only "works" in a dirty tree
    # does not get credit.
    if expected is not None and checks["fixture_present"]:
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
            checks["script_exit_zero"] = run.returncode == 0
            if run.returncode != 0:
                verdict["script_stderr_tail"] = run.stderr.strip().splitlines()[-3:]
            report_path = scratch / "fixture" / artifact
            checks["artifact_written"] = report_path.is_file()
            if report_path.is_file():
                actual = parse_report(report_path.read_text())
                per_key = {key: actual.get(key) == expected[key] for key in REQUIRED_KEYS}
                checks["values"] = per_key
                verdict["actual"] = actual
                verdict["expected"] = expected
                checks["values_ok"] = all(per_key.values())
        finally:
            shutil.rmtree(str(scratch), ignore_errors=True)

    verdict["pass"] = bool(
        checks["rail_ok"]
        and checks["answer_source_ok"]
        and checks.get("manifest_parseable")
        and checks.get("script_exit_zero")
        and checks.get("values_ok")
    )
    print(json.dumps(verdict, indent=2))
    return 0 if verdict["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
