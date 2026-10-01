#!/usr/bin/env python3
"""Generator for EX-1 (multi-step tool task, single agent).

Creates a fixture directory holding a small stdlib-only Python project with
three seeded bugs, plus a manifest (kept OUTSIDE the fixture dir) with the
independently computed expected answers. The agent under test receives only
the fixture dir; the grader consumes the manifest.

Deterministic: --seed fixes every byte of the fixture and the manifest.

Usage:
    python3 gen_ex1.py --out /path/to/ex1-work --seed 20261002
    # writes: /path/to/ex1-work/fixture/{analyze.py,data/...}
    #         /path/to/ex1-work/manifest.json
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import random
from pathlib import Path

CATEGORIES = ["alpha", "beta", "gamma", "delta"]

# The buggy script template. Bugs (all fixable without changing the CLI):
#   A) int(row["units"]) crashes on empty units cells (ValueError).
#   B) revenue uses row["price"] raw, which carries a "$" prefix (ValueError).
#   C) the report writes q1 revenue twice (total_revenue_cents uses q1 twice),
#      a wrong-number bug that does not crash.
ANALYZE_PY = '''#!/usr/bin/env python3
"""Summarize the quarterly sales CSVs in data/ into report.md."""
import csv
import sys
from pathlib import Path

def load(path):
    with open(path, newline="") as handle:
        return list(csv.DictReader(handle))

def units_of(row):
    return int(row["units"])

def revenue_cents(row):
    return int(row["units"]) * int(round(float(row["price"]) * 100))

def main():
    root = Path(__file__).resolve().parent
    q1 = load(root / "data" / "sales_q1.csv")
    q2 = load(root / "data" / "sales_q2.csv")
    q1_units = sum(units_of(row) for row in q1)
    q2_units = sum(units_of(row) for row in q2)
    q1_rev = sum(revenue_cents(row) for row in q1)
    q2_rev = sum(revenue_cents(row) for row in q2)
    totals = {}
    for row in q1 + q2:
        totals[row["category"]] = totals.get(row["category"], 0) + units_of(row)
    top_category = max(totals, key=totals.get)
    report = (
        "q1_units: {}\\n"
        "q2_units: {}\\n"
        "total_revenue_cents: {}\\n"
        "top_category: {}\\n"
    ).format(q1_units, q2_units, q1_rev + q1_rev, top_category)
    (root / "report.md").write_text(report)
    print(report, end="")
    return 0

if __name__ == "__main__":
    sys.exit(main())
'''


def make_rows(rng: random.Random, count: int) -> list:
    rows = []
    for _ in range(count):
        # ~15% of rows carry an empty units cell (bug A trigger).
        units = "" if rng.random() < 0.15 else str(rng.randint(1, 40))
        price = "{}.{:02d}".format(rng.randint(1, 60), rng.randint(0, 99))
        rows.append(
            {
                "category": rng.choice(CATEGORIES),
                "units": units,
                "price": "$" + price,  # bug B trigger: currency prefix
            }
        )
    return rows


def rows_to_csv(rows: list) -> str:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=["category", "units", "price"])
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue()


def expected_from_rows(q1: list, q2: list) -> dict:
    """Independent oracle: empty units count as 0, prices lose the '$'."""

    def units(row):
        return int(row["units"]) if row["units"] else 0

    def cents(row):
        return units(row) * int(round(float(row["price"].lstrip("$")) * 100))

    totals = {}
    for row in q1 + q2:
        totals[row["category"]] = totals.get(row["category"], 0) + units(row)
    return {
        "q1_units": sum(units(r) for r in q1),
        "q2_units": sum(units(r) for r in q2),
        "total_revenue_cents": sum(cents(r) for r in q1) + sum(cents(r) for r in q2),
        "top_category": max(totals, key=totals.get),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="Work dir (fixture/ and manifest.json land here)")
    parser.add_argument("--seed", type=int, default=20261002)
    parser.add_argument("--rows", type=int, default=120, help="Rows per quarterly CSV")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    q1 = make_rows(rng, args.rows)
    q2 = make_rows(rng, args.rows)

    out = Path(args.out)
    fixture = out / "fixture"
    (fixture / "data").mkdir(parents=True, exist_ok=True)
    (fixture / "analyze.py").write_text(ANALYZE_PY)
    (fixture / "data" / "sales_q1.csv").write_text(rows_to_csv(q1))
    (fixture / "data" / "sales_q2.csv").write_text(rows_to_csv(q2))

    manifest = {
        "exam": "EX-1",
        "seed": args.seed,
        "rows_per_file": args.rows,
        "artifact": "report.md",
        "expected": expected_from_rows(q1, q2),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest["expected"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
