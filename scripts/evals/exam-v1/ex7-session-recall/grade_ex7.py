#!/usr/bin/env python3
"""Grader for EX-7. Model-free; compares fixture/facts.json to run.json truth.

Gates: facts.json parses; exactly the three queried keys are present; each
holds its CURRENT value (the superseded FACT-2 value must be the update);
the superseded original must NOT appear as FACT-2's value.

Usage: python3 grade_ex7.py --work /path/to/ex7-work
"""
from __future__ import annotations

import json
from pathlib import Path


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", required=True)
    args = parser.parse_args()
    work = Path(args.work)

    verdict = {"exam": "EX-7", "pass": False, "checks": {}}
    checks = verdict["checks"]

    meta = json.loads((work / "run.json").read_text())
    expected = meta["expected"]
    superseded_value = meta["superseded_value"]

    checks["exit_zero"] = meta.get("exit_code") == 0

    facts_path = work / "fixture" / "facts.json"
    checks["facts_present"] = facts_path.is_file()
    if facts_path.is_file():
        try:
            facts = json.loads(facts_path.read_text())
        except ValueError as exc:
            facts = None
            checks["facts_parseable"] = False
            verdict["parse_error"] = str(exc)
        if isinstance(facts, dict):
            checks["facts_parseable"] = True
            checks["exact_key_set"] = sorted(facts.keys()) == sorted(expected.keys())
            per_key = {key: facts.get(key) == value for key, value in expected.items()}
            checks["per_key"] = per_key
            checks["superseded_not_used"] = facts.get("FACT-2") != superseded_value
            checks["values_ok"] = all(per_key.values()) and checks["exact_key_set"]
            verdict["expected"] = expected
            verdict["actual"] = facts
    verdict["pass"] = bool(
        checks.get("exit_zero")
        and checks.get("facts_present")
        and checks.get("facts_parseable")
        and checks.get("values_ok")
    )
    print(json.dumps(verdict, indent=2))
    return 0 if verdict["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
