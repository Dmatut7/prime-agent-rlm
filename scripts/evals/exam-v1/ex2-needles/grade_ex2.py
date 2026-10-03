#!/usr/bin/env python3
"""Grader for EX-2. Independently recomputes the needle truth from the corpus
(never trusts the manifest for the graded values; the manifest is the
generation record), then compares the agent's answers.json.

Answer-key secrecy (D12): the manifest holds the expected needle map, so it
never enters the agent-writable work dir - gen_ex2.py writes it straight into
--rail-dir (same contract as EX-1), this grader reads it from there, and the
D9 mtime rule applies to it (a manifest rewritten after the run started is an
agent re-pointing the generation record). A manifest.json at the work root -
the pre-v1.5-parity layout or a planted copy - means the answer key was
agent-readable and voids the run, however honest the answers look. The rail
manifest is cross-checked against the corpus rescan: a generation record that
disagrees with the (pinned) corpus is corrupt and fails the run loud.

Answer-source rail (D10): the corpus this grader rescans as the truth lives
inside the agent-writable work dir, so an agent can edit it to match its own
answers (or plant/delete docs) and forge a pass. The driver sha256-pins
fixture/docs/*.md into --rail-dir/answer-source-sha256.json BEFORE the agent
launches (run_manual.py --corpus-glob); the grader re-hashes the same
canonical set and fails closed on any changed/missing/extra file, on a
missing pin or run-start anchor, and - via the D9 mtime rule - on a pin
rewritten after the run started (the agent re-pinning the rail to its
tampered corpus).

Usage:
    python3 grade_ex2.py --work /path/to/ex2-work --rail-dir /path/to/ex2-rail
        (--work holds fixture/docs/** as generated plus the agent's answers.json
         at fixture/answers.json - the prompt sends the agent to the repository
         root one level above docs/, which is fixture/ when the agent's cwd is
         fixture/;
         --rail-dir holds gen_ex2.py's manifest.json plus the driver-recorded
         run-meta.json and answer-source-sha256.json)

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

MANIFEST_NAME = "manifest.json"

ANSWER_SOURCE_PATTERNS = ("fixture/docs/*.md",)


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
        help="Dir outside --work holding gen_ex2.py's manifest.json plus the "
        "driver-recorded run-meta.json + answer-source-sha256.json",
    )
    args = parser.parse_args()
    work = Path(args.work)
    rail = Path(args.rail_dir)

    verdict = {"exam": "EX-2", "pass": False, "checks": {}}
    checks = verdict["checks"]

    # D10/D12 rail verification first: the corpus IS the grading truth
    # (rescanned below) and the rail-side manifest is the generation record, so
    # both must be provably untouched by the agent (D9 mechanics: outside-work
    # rail dir, driver-recorded run-start anchor, mtime rule).
    run_meta = examlib.read_run_meta(rail)
    started_at = examlib.epoch_field(run_meta, "started_at")
    source_checks = examlib.verify_answer_source(rail, work, ANSWER_SOURCE_PATTERNS, started_at)
    manifest_checks = examlib.verify_rail(rail, work, [("manifest", MANIFEST_NAME, started_at)])
    source_rail_ok = source_checks.pop("rail_ok")
    manifest_rail_ok = manifest_checks.pop("rail_ok")
    checks.update(source_checks)
    checks.update(manifest_checks)
    checks["rail_run_meta_present"] = started_at is not None
    checks["rail_ok"] = bool(source_rail_ok and manifest_rail_ok and checks["rail_run_meta_present"])

    # D12: the answer key must never have been agent-readable. A work-root
    # manifest.json (the pre-parity layout, or a planted/forged copy) voids the
    # run no matter what the answers say.
    checks["work_manifest_absent"] = not (work / MANIFEST_NAME).exists()

    manifest_expected = None
    try:
        manifest = json.loads((rail / MANIFEST_NAME).read_text())
        candidate = manifest["expected"]
        needles = candidate.get("needles") if isinstance(candidate, dict) else None
        if (
            not isinstance(needles, dict)
            or not all(isinstance(key, str) and isinstance(value, int) for key, value in needles.items())
            or not isinstance(candidate.get("total"), int)
        ):
            raise ValueError("manifest expected lacks the needle map/total")
        manifest_expected = {"needles": needles, "total": candidate["total"]}
        checks["manifest_parseable"] = True
    except (OSError, ValueError) as exc:
        checks["manifest_parseable"] = False
        verdict["manifest_error"] = str(exc)

    truth = recompute(work / "fixture" / "docs")
    checks["corpus_needle_count"] = len(truth["needles"])
    checks["corpus_duplicate_ids"] = truth["duplicates"]

    # The generation record must agree with the (pinned) corpus rescan; a
    # disagreement means a corrupt record, not a grading difference - fail loud.
    checks["manifest_matches_corpus"] = bool(
        manifest_expected is not None
        and manifest_expected["needles"] == truth["needles"]
        and manifest_expected["total"] == truth["total"]
    )

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
    verdict["pass"] = bool(
        checks["rail_ok"]
        and checks["answer_source_ok"]
        and checks["work_manifest_absent"]
        and checks["manifest_parseable"]
        and checks["manifest_matches_corpus"]
        and checks.get("needles_ok")
    )
    print(json.dumps(verdict, indent=2))
    return 0 if verdict["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
