#!/usr/bin/env python3
"""Generator for EX-2 (long-context recall over a file corpus).

Writes a deterministic corpus of markdown files with a fixed number of needle
lines embedded at seeded positions, plus look-alike distractors that must NOT
be counted. The expected answers are recomputed from the corpus by the grader
(independent recompute, same rule as the swarm-fanout fixture integrity
tests); this generator also writes a manifest so the exam record can pin what
was handed out.

Needle format (exact):   NEEDLE-<WORD>-<DIGIT> = <5-digit int>
Distractors (never match the needle regex):
  DRAFT-NEEDLE-<WORD>-<DIGIT> = <int>          (wrong prefix)
  NEEDLE-<WORD>-<DIGIT>=<int>                  (missing spaces)
  NEEDLE-<WORD> = <int>                        (missing digit segment)

Usage:
    python3 gen_ex2.py --out /path/to/ex2-work --seed 20261002
    # writes: /path/to/ex2-work/fixture/docs/doc-XX.md  (corpus, agent-visible)
    #         /path/to/ex2-work/manifest.json           (needle truth, grader-side)
"""
from __future__ import annotations

import argparse
import json
import random
import re
from pathlib import Path

NEEDLE_RE = re.compile(r"^NEEDLE-([A-Z]+-\d) = (\d{5})$", re.MULTILINE)

WORDS = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO", "FOXTROT", "GOLF", "HOTEL"]

SLOTS = 4  # filler blocks per file; each insert is assigned to exactly one slot

FILLER = (
    "The maintenance window for sector {s} closed at {t}:00 without incident. "
    "Crew {c} logged {n} routine checks; nothing required escalation. "
    "Supply crate {k} was shelved in bay {b}. "
    "Ambient readings stayed inside the green band for the {o}th consecutive day."
)


def filler_block(rng: random.Random, lines: int) -> str:
    out = []
    for _ in range(lines):
        out.append(
            FILLER.format(
                s=rng.randint(1, 24),
                t=rng.randint(0, 23),
                c=rng.choice(["red", "blue", "green", "yellow"]),
                n=rng.randint(3, 60),
                k=rng.randint(1000, 9999),
                b=rng.randint(1, 40),
                o=rng.randint(2, 400),
            )
        )
    return "\n".join(out) + "\n"


def distractor_line(rng: random.Random) -> str:
    kind = rng.choice(["prefix", "spaces", "segment"])
    word = rng.choice(WORDS)
    digit = rng.randint(0, 9)
    value = rng.randint(10000, 99999)
    if kind == "prefix":
        return "DRAFT-NEEDLE-{}-{} = {}\n".format(word, digit, value)
    if kind == "spaces":
        return "NEEDLE-{}-{}={}\n".format(word, digit, value)
    return "NEEDLE-{} = {}\n".format(word, value)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--seed", type=int, default=20261002)
    parser.add_argument("--files", type=int, default=25)
    parser.add_argument("--needles", type=int, default=5)
    parser.add_argument("--distractors", type=int, default=15)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    out = Path(args.out)
    docs = out / "fixture" / "docs"
    docs.mkdir(parents=True, exist_ok=True)

    file_names = ["doc-{:02d}.md".format(i) for i in range(args.files)]

    needle_ids = rng.sample(WORDS, args.needles)
    needles = {}
    for word in needle_ids:
        needle_id = "{}-{}".format(word, rng.randint(0, 9))
        needles[needle_id] = rng.randint(10000, 99999)

    # Each insert lands in exactly one (file, slot); never duplicated.
    inserts = {name: {slot: [] for slot in range(SLOTS)} for name in file_names}
    for needle_id, value in sorted(needles.items()):
        name = file_names[rng.randrange(args.files)]
        inserts[name][rng.randrange(SLOTS)].append("NEEDLE-{} = {}\n".format(needle_id, value))
    for _ in range(args.distractors):
        name = file_names[rng.randrange(args.files)]
        inserts[name][rng.randrange(SLOTS)].append(distractor_line(rng))

    for name in file_names:
        parts = []
        for slot in range(SLOTS):
            parts.append(filler_block(rng, 5))
            parts.extend(inserts[name][slot])
        (docs / name).write_text("".join(parts))

    manifest = {
        "exam": "EX-2",
        "seed": args.seed,
        "files": args.files,
        "needle_regex": NEEDLE_RE.pattern,
        "expected": {"needles": needles, "total": sum(needles.values())},
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    total_bytes = sum(p.stat().st_size for p in docs.glob("*.md"))
    print(json.dumps({"corpus_bytes": total_bytes, "approx_tokens": total_bytes // 4, "needles": needles}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
