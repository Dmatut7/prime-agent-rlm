#!/usr/bin/env python3
"""Grader for EX-2. Independently recomputes the needle truth from the corpus
(never trusts the manifest for grading; the manifest only records the seed),
then compares the agent's answers.json.

Answer-source rail (D10): the corpus this grader rescans as the truth lives
inside the agent-writable work dir, so an agent can edit it to match its own
answers (or plant/delete docs) and forge a pass. The driver sha256-pins
manifest.json + fixture/docs/*.md into --rail-dir/answer-source-sha256.json
BEFORE the agent launches (run_manual.py --corpus-glob); the grader
re-hashes the same canonical set and fails closed on any
changed/missing/extra file, on a missing pin or run-start anchor, and - via
the D9 mtime rule - on a pin rewritten after the run started (the agent
re-pinning the rail to its tampered corpus).

Usage:
    python3 grade_ex2.py --work /path/to/ex2-work --rail-dir /path/to/ex2-rail
        (--work holds fixture/docs/** as generated plus the agent's answers.json
         at fixture/answers.json - the prompt sends the agent to the repository
         root one level above docs/, which is fixture/ when the agent's cwd is
         fixture/; manifest.json is used only for the regex/seed record)

Exit 0 = pass, 1 = fail. Prints a JSON verdict on stdout.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import examlib  # noqa: E402

NEEDLE_RE = re.compile(r"^NEEDLE-([A-Z]+-\d) = (\d{5})$", re.MULTILINE)

ANSWER_SOURCE_PATTERNS = ("manifest.json", "fixture/docs/*.md")


def recompute(docs: Path) -> dict:
    needles = {}
    duplicates = []
    for path in sorted(docs.glob("*.md")):
        for match in NEEDLE_RE.finditer(path.read_text()):
            needle_id, value = match.group(1), int(match.group(2))
            if needle_id in needles:
                duplicates.append(needle_id)
            needles[needle_id] = value
    return {"needles": needles, "total": sum(needles.values()), "duplicates": duplicates}


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

    verdict = {"exam": "EX-2", "pass": False, "checks": {}}
    checks = verdict["checks"]

    # D10 rail verification first: the corpus IS the grading truth (rescanned
    # below), so it must be provably untouched by the agent (D9 mechanics:
    # outside-work rail dir, driver-recorded run-start anchor, mtime rule).
    run_meta = examlib.read_run_meta(rail)
    started_at = examlib.epoch_field(run_meta, "started_at")
    checks.update(examlib.verify_answer_source(rail, work, ANSWER_SOURCE_PATTERNS, started_at))
    checks["rail_run_meta_present"] = started_at is not None
    checks["rail_ok"] = bool(checks["rail_ok"] and checks["rail_run_meta_present"])

    truth = recompute(work / "fixture" / "docs")
    checks["corpus_needle_count"] = len(truth["needles"])
    checks["corpus_duplicate_ids"] = truth["duplicates"]

    answers_path = work / "fixture" / "answers.json"
    checks["answers_path"] = str(answers_path)
    checks["answers_present"] = answers_path.is_file()
    if answers_path.is_file():
        try:
            answers = json.loads(answers_path.read_text())
        except ValueError as exc:
            checks["answers_parseable"] = False
            verdict["parse_error"] = str(exc)
            answers = None
        if isinstance(answers, dict):
            checks["answers_parseable"] = True
            got = answers.get("needles", {})
            expected_needles = truth["needles"]
            per_needle = {key: got.get(key) == value for key, value in expected_needles.items()}
            extra = sorted(set(got) - set(expected_needles))
            checks["per_needle"] = per_needle
            checks["extra_ids"] = extra
            checks["total_ok"] = answers.get("total") == truth["total"]
            verdict["expected_total"] = truth["total"]
            checks["needles_ok"] = (
                all(per_needle.values())
                and not extra
                and checks["total_ok"]
                and len(truth["needles"]) > 0
            )
    verdict["pass"] = bool(checks["rail_ok"] and checks["answer_source_ok"] and checks.get("needles_ok"))
    print(json.dumps(verdict, indent=2))
    return 0 if verdict["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
