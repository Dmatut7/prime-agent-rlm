#!/usr/bin/env python3
"""Grader for EX-2. Independently recomputes the needle truth from the corpus
(never trusts the manifest for grading; the manifest only records the seed),
then compares the agent's answers.json.

Usage:
    python3 grade_ex2.py --work /path/to/ex2-work
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
from pathlib import Path

NEEDLE_RE = re.compile(r"^NEEDLE-([A-Z]+-\d) = (\d{5})$", re.MULTILINE)


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
    args = parser.parse_args()
    work = Path(args.work)

    verdict = {"exam": "EX-2", "pass": False, "checks": {}}
    truth = recompute(work / "fixture" / "docs")
    verdict["checks"]["corpus_needle_count"] = len(truth["needles"])
    verdict["checks"]["corpus_duplicate_ids"] = truth["duplicates"]

    answers_path = work / "fixture" / "answers.json"
    verdict["checks"]["answers_path"] = str(answers_path)
    verdict["checks"]["answers_present"] = answers_path.is_file()
    if answers_path.is_file():
        try:
            answers = json.loads(answers_path.read_text())
        except ValueError as exc:
            verdict["checks"]["answers_parseable"] = False
            verdict["parse_error"] = str(exc)
            answers = None
        if isinstance(answers, dict):
            verdict["checks"]["answers_parseable"] = True
            got = answers.get("needles", {})
            expected_needles = truth["needles"]
            per_needle = {key: got.get(key) == value for key, value in expected_needles.items()}
            extra = sorted(set(got) - set(expected_needles))
            verdict["checks"]["per_needle"] = per_needle
            verdict["checks"]["extra_ids"] = extra
            verdict["checks"]["total_ok"] = answers.get("total") == truth["total"]
            verdict["expected_total"] = truth["total"]
            verdict["pass"] = (
                all(per_needle.values())
                and not extra
                and verdict["checks"]["total_ok"]
                and len(truth["needles"]) > 0
            )
    print(json.dumps(verdict, indent=2))
    return 0 if verdict["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
