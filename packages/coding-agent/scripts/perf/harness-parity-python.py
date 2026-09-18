"""Python face of the cross-language harness parity instrument.

Driven by ``packages/coding-agent/scripts/perf/harness-parity.mjs``. It never
spawns Node: the orchestrator runs the two sides as separate processes and
compares their JSON.

The per-entry scores come from ``rlm.harness._search_score`` with an idf map
*derived from Python's own production face* rather than recomputed here: for a
single-term query ``search`` returns ``idf(term) * slots_factor`` and
``_search_score(entry, [term], None)`` returns the same ``slots_factor`` with
every weight at 1, so their quotient is the idf the ranking really used. That
keeps this driver from becoming a third implementation of the formula (the
independent reference scorer lives in the orchestrator) while still bypassing
the tokenizer, which the shared fixture's explicit term lists require.

The only deliberately wrong code paths are the ``--break=`` positive controls;
each is labelled where it is applied.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any, Sequence

TOLERANCE = 1e-12


def fail(message: str) -> "NoReturn":  # noqa: F821 - argparse drives the exit code
    sys.stderr.write(f"harness-parity-python: {message}\n")
    raise SystemExit(1)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--state", required=True)
    parser.add_argument("--terms", required=True)
    parser.add_argument("--workdir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--runtime-src", default=None)
    parser.add_argument("--break", dest="break_name", default=None)
    options = parser.parse_args(list(argv))
    return options


def load_runtime(src: str | None) -> Any:
    if src is None:
        # <repo>/packages/coding-agent/scripts/perf/ -> <repo>
        src = str(Path(__file__).resolve().parents[4] / "prime-agent-runtime" / "src")
    if not (Path(src) / "rlm" / "harness.py").is_file():
        fail(f"--runtime-src does not hold rlm/harness.py: {src}")
    sys.path.insert(0, src)
    # `from rlm import harness` would bind the kernel's lazy HarnessState proxy
    # (rlm/__init__.py rebinds the name), not the module this driver needs.
    return importlib.import_module("rlm.harness")


def close_enough(left: float, right: float) -> bool:
    return abs(left - right) <= TOLERANCE * max(1.0, abs(left), abs(right))


def derive_idf(
    harness: Any,
    state: Any,
    kind: str | None,
    terms: list[str],
    corpus: list[Any],
) -> tuple[dict[str, float], dict[str, Any]]:
    """Recover the idf map ``search`` used, from ``search`` itself."""
    by_key = {(entry.kind, entry.id): entry for entry in corpus}
    idf: dict[str, float] = {}
    diagnostics: dict[str, Any] = {}
    for term in terms:
        tokenized = harness._harness_query_terms(term)
        if tokenized != [term]:
            fail(f"term {term!r} does not survive its own tokenizer: {tokenized!r}")
        hits = state.search(term, kind=kind, limit=max(1, len(corpus)))
        ratios: list[float] = []
        for hit in hits:
            entry = by_key.get((hit.kind, hit.id))
            if entry is None:
                fail(f"search returned an entry outside the corpus: {hit.kind}/{hit.id}")
            slots_factor = harness._search_score(entry, [term], None)
            if slots_factor <= 0:
                fail(f"search returned a zero-slot hit for {term!r}: {hit.id}")
            ratios.append(hit.score / slots_factor)
        if not ratios:
            continue  # df == 0: the term is absent from the idf map on both sides
        spread = max(ratios) - min(ratios)
        if spread > TOLERANCE:
            fail(f"term {term!r} did not yield one idf across its hits (spread {spread!r})")
        idf[term] = ratios[0]
        diagnostics[term] = {"df": len(ratios), "idf": ratios[0], "spread": spread}
    return idf, diagnostics


def main(argv: Sequence[str]) -> int:
    options = parse_args(argv)
    harness = load_runtime(options.runtime_src)
    break_name: str | None = options.break_name

    state_fixture = json.loads(Path(options.state).read_text(encoding="utf-8"))
    terms_fixture = json.loads(Path(options.terms).read_text(encoding="utf-8"))

    workdir = Path(options.workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    state_path = workdir / "harness_state.json"
    shutil.copyfile(options.state, state_path)
    os.chmod(state_path, 0o600)
    state = harness.HarnessState(state_path)

    corpus_report: dict[str, Any] = {}
    for kind, records in state.entries.items():
        listed = state.list(kind)
        corpus_report[kind] = {
            "count": len(listed),
            "key_order": list(records.keys()),
            "list_order": [entry.id for entry in listed],
        }

    cases: dict[str, Any] = {}
    for case in terms_fixture["cases"]:
        kind = case.get("kind")
        python_query = case["python_query"]
        tokenizer_terms = harness._harness_query_terms(python_query)
        if case["mode"] == "tokenized":
            terms = list(tokenizer_terms)
        elif case["mode"] == "explicit_weighted":
            # harness.search has no weight face: it scores the same term set at 1.
            terms = list(case["terms"].keys())
        else:
            terms = list(case["terms"])
            if terms != tokenizer_terms:
                fail(
                    f"case {case['name']}: the query {python_query!r} tokenizes to "
                    f"{tokenizer_terms!r}, not the explicit terms {terms!r}"
                )
        corpus = state.list(kind)
        if not corpus:
            fail(f"case {case['name']}: empty corpus for kind={kind!r}")
        idf, idf_diagnostics = derive_idf(harness, state, kind, terms, corpus)

        break_note: str | None = None
        score_idf: dict[str, float] | None = idf
        if break_name == "idf":
            score_idf = None  # deliberately wrong: every term weighted 1
            break_note = "idf: scored without the document-frequency discount"

        scores: dict[str, float] = {}
        for entry in corpus:
            scores[entry.id] = harness._search_score(entry, terms, score_idf)

        full = state.search(python_query, kind=kind, limit=max(1, len(corpus)))
        order = [hit.id for hit in full]
        search_scores = {hit.id: hit.score for hit in full}
        if break_name == "zero-drop":
            # deliberately wrong: keep the zero-score rows Python drops
            dropped = [entry.id for entry in corpus if entry.id not in set(order)]
            order = order + sorted(dropped)
            for entry_id in dropped:
                search_scores[entry_id] = 0.0
            break_note = "zero-drop: zero-score entries kept in the result order"
        elif break_name == "tiebreak":
            # deliberately wrong: identity only, recency dropped
            order = sorted(order)
            break_note = "tiebreak: ties ordered by id instead of updated_at desc"

        top_k: dict[str, list[str]] = {}
        for limit in case["top_k"]:
            hits = state.search(python_query, kind=kind, limit=limit)
            ids = [hit.id for hit in hits]
            if break_name == "zero-drop":
                ids = order[:limit]
            elif break_name == "tiebreak":
                ids = sorted(ids)
            top_k[str(limit)] = ids

        if break_note is None:
            # Self-check: the derived idf must reproduce the production face exactly.
            for entry_id, score in search_scores.items():
                if not close_enough(score, scores[entry_id]):
                    fail(
                        f"case {case['name']}: derived-idf score for {entry_id} "
                        f"({scores[entry_id]!r}) != search score ({score!r})"
                    )

        cases[case["name"]] = {
            "kind_scope": "all kinds (merged corpus)" if kind is None else f"kind={kind}",
            "corpus_kind": kind,
            "corpus_count": len(corpus),
            "corpus_list_order": [entry.id for entry in corpus],
            "terms_used": {term: 1.0 for term in terms},
            "tokenizer_terms": tokenizer_terms,
            "idf": idf,
            "idf_diagnostics": idf_diagnostics,
            "scores": scores,
            "order": order,
            "zero_ids": [entry.id for entry in corpus if scores[entry.id] == 0],
            "top_k": top_k,
            "break_note": break_note,
        }

    report = {
        "side": "python",
        "implementation": "prime-agent-runtime/src/rlm/harness.py",
        "python_version": sys.version.split()[0],
        "break_applied": break_name,
        "fixture_state_key_order": {
            kind: list(records.keys()) for kind, records in (state_fixture.get("entries") or {}).items()
        },
        "corpus": corpus_report,
        "cases": cases,
    }
    Path(options.out).write_text(json.dumps(report, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
