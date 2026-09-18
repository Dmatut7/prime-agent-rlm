"""Cross-language needle: ``harness.search`` against the TS harness digest window.

Both faces pin the same machine-generated golden
(``packages/coding-agent/test/fixtures/harness-parity/expected.json``), written by
``packages/coding-agent/scripts/perf/harness-parity.mjs`` after it ran the TS
implementation, this one, and an independent reference scorer against each
other. This file never spawns Node (the unittest face stays sealed); the TS half
of the pair is ``packages/coding-agent/test/harness-search-parity.test.ts``.

The parity regime the golden was minted under: one kind as the ranked corpus, one
explicit term list (both faces bypass their own tokenizer), every TS term weight
1, every scored field a string, and distinct positive scores above the top-k cut.
Under it the two faces must return the same ids in the same order. Where they
deliberately differ, the divergence is pinned here so it cannot drift silently;
the evidence and the reasoning live in
``docs/fork/evidence/harness-search-parity.md``.

``_search_score`` and ``_harness_query_terms`` are module private, and this file
uses them on purpose: a zero-score row is not observable
through ``search`` at all (it is dropped), and the shared fixture's explicit term
list has to reach the scorer without passing through a tokenizer whose minimum
term length is one of the documented divergences. Every ranking and hit-shape
assertion below still goes through the public ``search`` face.

Zero-score rows are pinned at the score level only. What the TS digest does with
a kind where nothing scored is OBS-1's face (fix-perf-digest-2 item46), so this
file asserts neither their position in a TS ranking nor the ranked marker.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import tempfile
import unittest
from pathlib import Path
from typing import Any

from rlm.harness import HarnessState, _harness_query_terms, _search_score

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "packages" / "coding-agent" / "test" / "fixtures" / "harness-parity"
# The instrument's comparison tolerance: the two libm ``log``s differ in the last ULP.
TOLERANCE = 1e-12


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


EXPECTED = _read_json(FIXTURE_DIR / "expected.json")
TERMS = _read_json(FIXTURE_DIR / "terms.json")
CASES = {case["name"]: case for case in TERMS["cases"]}


def _case(name: str) -> dict[str, Any]:
    if name not in CASES:
        raise AssertionError(f"terms.json lost the {name} case")
    return CASES[name]


def _golden(name: str) -> dict[str, Any]:
    if name not in EXPECTED["cases"]:
        raise AssertionError(f"expected.json lost the {name} case; re-mint it with harness-parity.mjs --write")
    return EXPECTED["cases"][name]


def _terms_for(name: str) -> list[str]:
    case = _case(name)
    if case["mode"] == "explicit_weighted":
        # harness.search has no weight face: it scores the same term set at 1.
        return list(case["terms"].keys())
    if case["mode"] == "tokenized":
        return _harness_query_terms(case["python_query"])
    return list(case["terms"])


class HarnessSearchParityTest(unittest.TestCase):
    """Pin the Python face to the golden the TS face is pinned to."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._temp = tempfile.TemporaryDirectory(prefix="harness-parity-")
        state_path = Path(cls._temp.name) / "harness_state.json"
        shutil.copyfile(FIXTURE_DIR / "state.json", state_path)
        os.chmod(state_path, stat.S_IRUSR | stat.S_IWUSR)
        cls.state = HarnessState(state_path)
        cls.state_path = state_path

    @classmethod
    def tearDownClass(cls) -> None:
        cls._temp.cleanup()

    # -- helpers ---------------------------------------------------------
    def corpus(self, kind: str | None) -> list[Any]:
        return self.state.list(kind)

    def derive_idf(self, kind: str | None, terms: list[str]) -> dict[str, float]:
        """Recover the idf map ``search`` really used, from ``search`` itself.

        For a single-term query a hit's score is ``idf(term) * slots_factor`` and
        ``_search_score(entry, [term], None)`` is the same ``slots_factor`` with
        every weight at 1, so the quotient is the production idf. Deriving it
        keeps this needle from re-implementing the formula it is pinning.
        """
        entries = self.corpus(kind)
        by_key = {(entry.kind, entry.id): entry for entry in entries}
        idf: dict[str, float] = {}
        for term in terms:
            self.assertEqual(_harness_query_terms(term), [term], f"{term!r} must survive its own tokenizer")
            ratios: list[float] = []
            for hit in self.state.search(term, kind=kind, limit=max(1, len(entries))):
                entry = by_key[(hit.kind, hit.id)]
                slots_factor = _search_score(entry, [term], None)
                self.assertGreater(slots_factor, 0.0)
                ratios.append(hit.score / slots_factor)
            if ratios:
                self.assertLess(max(ratios) - min(ratios), TOLERANCE, f"{term!r} must yield one idf")
                idf[term] = ratios[0]
        return idf

    def assert_close(self, actual: float, expected: float, label: str) -> None:
        bound = TOLERANCE * max(1.0, abs(actual), abs(expected))
        self.assertLessEqual(abs(actual - expected), bound, f"{label}: {actual!r} vs {expected!r}")

    # -- the parity regime ------------------------------------------------
    def test_fixture_stays_inside_the_regime_the_golden_was_minted_under(self) -> None:
        entries = self.corpus("memory")
        self.assertGreaterEqual(len(entries), 24)
        self.assertEqual(len(entries), EXPECTED["regime"]["corpus_count"])
        terms = _terms_for("parity")
        idf = self.derive_idf("memory", terms)
        scores = {entry.id: _search_score(entry, terms, idf) for entry in entries}
        positive = [score for score in scores.values() if score > 0]
        self.assertGreaterEqual(len(positive), 10)
        top10 = sorted(positive, reverse=True)[:10]
        self.assertEqual(len(set(top10)), len(top10), "the top-10 scores must stay pairwise distinct")
        self.assertGreaterEqual(sum(1 for score in scores.values() if score == 0), 3)
        self.assertTrue(EXPECTED["regime"]["top10_distinct"])
        self.assertEqual(len(EXPECTED["regime"]["tie_groups"]), 1)
        self.assertGreaterEqual(EXPECTED["regime"]["tie_groups"][0]["count"], 3)
        self.assertTrue(EXPECTED["regime"]["tie_below_cut"])

    def test_explicit_terms_round_trip_through_the_production_tokenizer(self) -> None:
        for name in ("parity", "tie_window", "nonstring_path"):
            case = _case(name)
            with self.subTest(case=name):
                self.assertEqual(_harness_query_terms(case["python_query"]), case["terms"])

    # -- scores -----------------------------------------------------------
    def test_every_entry_scores_what_the_golden_records_for_both_languages(self) -> None:
        golden = _golden("parity")
        terms = _terms_for("parity")
        entries = self.corpus("memory")
        idf = self.derive_idf("memory", terms)
        self.assertEqual(sorted(idf), sorted(golden["python"]["idf"]))
        for term, value in idf.items():
            self.assert_close(value, golden["python"]["idf"][term], f"idf({term})")
            # The same idf the TS face computes: one corpus, one formula.
            self.assert_close(value, golden["ts"]["idf"][term], f"ts idf({term})")
        self.assertGreater(len(entries), 0)
        for entry in entries:
            score = _search_score(entry, terms, idf)
            self.assert_close(score, golden["python"]["scores"][entry.id], f"python score {entry.id}")
            self.assert_close(score, golden["ts"]["scores"][entry.id], f"ts score {entry.id}")
            self.assert_close(score, golden["reference"]["python"]["scores"][entry.id], f"reference {entry.id}")
        # The production face agrees with the derived-idf scoring, hit for hit.
        hits = self.state.search(_case("parity")["python_query"], kind="memory", limit=len(entries))
        self.assertEqual(len(hits), EXPECTED["regime"]["positive_count"])
        for hit in hits:
            self.assert_close(hit.score, golden["python"]["scores"][hit.id], f"search score {hit.id}")
            self.assertEqual(hit.kind, "memory")
            self.assertIsInstance(hit.snippet, str)

    def test_top_k_window_matches_the_ts_digest_window(self) -> None:
        golden = _golden("parity")
        query = _case("parity")["python_query"]
        for limit in _case("parity")["top_k"]:
            with self.subTest(limit=limit):
                ids = [hit.id for hit in self.state.search(query, kind="memory", limit=limit)]
                self.assertEqual(ids, golden["python"]["top_k"][str(limit)])
                # The claim under test: one golden, two languages, one order.
                self.assertEqual(ids, golden["ts"]["top_k"][str(limit)])
                self.assertEqual(len(ids), limit)
                self.assertEqual(ids, golden["ts"]["digest_window"][str(limit)])

    # -- documented divergences -------------------------------------------
    def test_zero_score_rows_are_dropped_here_and_score_zero_on_both_faces(self) -> None:
        golden = _golden("parity")
        terms = _terms_for("parity")
        idf = self.derive_idf("memory", terms)
        zeros = EXPECTED["regime"]["zero_ids"]
        self.assertGreaterEqual(len(zeros), 3)
        entries = {entry.id: entry for entry in self.corpus("memory")}
        for entry_id in zeros:
            with self.subTest(entry=entry_id):
                self.assertEqual(_search_score(entries[entry_id], terms, idf), 0.0)
                self.assertEqual(golden["python"]["scores"][entry_id], 0.0)
                self.assertEqual(golden["ts"]["scores"][entry_id], 0.0)
        # Divergence: this face drops them, so a limit larger than the positive
        # count still returns only positive rows. The TS face keeps them; where it
        # puts them (and whether the ranked marker prints) is OBS-1's face, so
        # nothing here asserts a TS ordering.
        everything = self.state.search(_case("parity")["python_query"], kind="memory", limit=len(entries))
        self.assertEqual([hit.id for hit in everything], golden["python"]["order"])
        self.assertTrue(all(hit.score > 0 for hit in everything))
        self.assertEqual(sorted(golden["python"]["zero_ids"]), sorted(zeros))
        for entry_id in zeros:
            self.assertNotIn(entry_id, golden["python"]["order"])

    def test_ties_fall_back_to_recency_which_the_ts_face_deliberately_does_not(self) -> None:
        golden = _golden("tie_window")
        limit = _case("tie_window")["top_k"][0]
        ids = [hit.id for hit in self.state.search(_case("tie_window")["python_query"], kind="memory", limit=limit)]
        self.assertEqual(ids, golden["python"]["top_k"][str(limit)])
        self.assertNotEqual(ids, golden["ts"]["top_k"][str(limit)])
        tie_score = EXPECTED["regime"]["tie_groups"][0]["score"]
        tied = sorted(
            entry_id for entry_id, score in golden["python"]["scores"].items() if abs(score - tie_score) <= TOLERANCE
        )
        self.assertEqual(len(tied), EXPECTED["regime"]["tie_groups"][0]["count"])
        # Equal scores on both faces; only the tie-break differs.
        for entry_id in tied:
            self.assert_close(golden["ts"]["scores"][entry_id], tie_score, f"ts tie score {entry_id}")
        entries = {entry.id: entry for entry in self.corpus("memory")}
        recency_order = sorted(tied, key=lambda entry_id: entries[entry_id].updated_at, reverse=True)
        self.assertEqual([entry_id for entry_id in ids if entry_id in tied], recency_order)
        # The TS face orders the same trio by [path, title, id]; pin that the two
        # orders really disagree, or this divergence has silently closed.
        self.assertEqual(
            [entry_id for entry_id in golden["ts"]["top_k"][str(limit)] if entry_id in tied],
            tied,
        )
        self.assertNotEqual(recency_order, tied)

    def test_the_search_tokenizer_keeps_short_terms_the_digest_tokenizer_cuts(self) -> None:
        golden = _golden("tokenizer_floor")
        case = _case("tokenizer_floor")
        terms = _harness_query_terms(case["python_query"])
        self.assertEqual(terms, golden["python"]["tokenizer_terms"])
        self.assertEqual(terms, case["terms"])
        cut = [term for term in terms if term not in golden["ts"]["tokenizer_terms"]]
        kept = [term for term in terms if term in golden["ts"]["tokenizer_terms"]]
        self.assertEqual(sorted(cut), sorted(["rlm", "api", "\u043c\u0438\u0440"]))
        # Every cut term is a sub-four-character run of a spaced script; every kept
        # term is either four characters or a CJK bigram, which both tokenizers take.
        for term in cut:
            self.assertLess(len(term), 4, term)
        for term in kept:
            self.assertTrue(len(term) >= 4 or not term.isascii(), term)
        # The cut is observable: a row only a three-character term matches is
        # findable here and invisible to the digest window.
        rlm_only = "mem_kernel_bridge"
        hits = self.state.search(case["python_query"], kind="memory", limit=6)
        self.assertEqual([hit.id for hit in hits], golden["python"]["top_k"]["6"])
        self.assertIn(rlm_only, [hit.id for hit in hits])
        self.assertNotIn(rlm_only, golden["ts"]["top_k"]["6"])
        self.assertGreater(golden["python"]["scores"][rlm_only], 0.0)

    def test_kind_none_merges_the_corpus_which_the_digest_never_does(self) -> None:
        golden = _golden("df_corpus")
        query = _case("df_corpus")["python_query"]
        merged = [hit.id for hit in self.state.search(query, limit=6)]
        self.assertEqual(merged, golden["python"]["top_k"]["6"])
        self.assertNotEqual(merged, golden["ts"]["top_k"]["6"])
        per_kind = [hit.id for hit in self.state.search(query, kind="memory", limit=6)]
        self.assertEqual(per_kind, _golden("parity")["python"]["top_k"]["6"])
        self.assertNotEqual(merged, per_kind)
        # Merging changes the document-frequency corpus, so every idf moves.
        merged_idf = self.derive_idf(None, _terms_for("df_corpus"))
        for term, value in merged_idf.items():
            self.assert_close(value, golden["python"]["idf"][term], f"merged idf {term}")
            self.assertNotAlmostEqual(value, golden["ts"]["idf"][term], places=9)
        self.assertEqual(golden["python"]["corpus_count"], len(self.corpus(None)))
        self.assertGreater(golden["python"]["corpus_count"], golden["ts"]["corpus_count"])

    def test_a_non_string_path_is_repaired_here_and_lost_by_the_ts_identifier_slot(self) -> None:
        golden = _golden("nonstring_path")
        case = _case("nonstring_path")
        terms = _terms_for("nonstring_path")
        self.assertEqual(terms, ["general"])
        idf = self.derive_idf("memory", terms)
        self.assert_close(idf["general"], golden["python"]["idf"]["general"], "python idf(general)")
        # The malformed row's path persisted as a number; this loader coerces it to
        # "general", so the row is findable by that word. The TS loader leaves it
        # non-string and its identifier slot loses it (golden ts score 0).
        entry = self.state.get("memory", "mem_numeric_path")
        self.assertIsNotNone(entry)
        self.assertEqual(entry.path, "general")
        self.assertGreater(_search_score(entry, terms, idf), 0.0)
        self.assertEqual(golden["ts"]["idf"], {})
        self.assertEqual(golden["ts"]["scores"]["mem_numeric_path"], 0.0)
        hits = self.state.search(case["python_query"], kind="memory", limit=6)
        self.assertEqual([hit.id for hit in hits], golden["python"]["top_k"]["6"])
        self.assertEqual([hit.id for hit in hits], ["mem_numeric_path"])

    def test_the_digest_term_weights_have_no_counterpart_here(self) -> None:
        golden = _golden("weights")
        case = _case("weights")
        limit = case["top_k"][0]
        ids = [hit.id for hit in self.state.search(case["python_query"], kind="memory", limit=limit)]
        self.assertEqual(ids, golden["python"]["top_k"][str(limit)])
        self.assertNotEqual(ids, golden["ts"]["top_k"][str(limit)])
        # Same term set, weight 1 everywhere: the weighted TS face scores rows
        # differently, which is the divergence, not a defect of either side.
        self.assertEqual(sorted(golden["python"]["terms_used"]), sorted(case["terms"].keys()))
        self.assertEqual(golden["ts"]["terms_used"], case["terms"])
        terms = _terms_for("weights")
        idf = self.derive_idf("memory", terms)
        entries = {entry.id: entry for entry in self.corpus("memory")}
        differing = 0
        for entry_id, ts_score in golden["ts"]["scores"].items():
            score = _search_score(entries[entry_id], terms, idf)
            self.assert_close(score, golden["python"]["scores"][entry_id], f"python score {entry_id}")
            if abs(score - ts_score) > TOLERANCE * max(1.0, abs(score), abs(ts_score)):
                differing += 1
        self.assertGreater(differing, 0)

    def test_path_and_id_share_one_identifier_slot_when_the_id_is_embedded(self) -> None:
        golden = _golden("parity")
        terms = _terms_for("parity")
        idf = self.derive_idf("memory", terms)
        entry = self.state.get("memory", "mem_embedded_id")
        self.assertIsNotNone(entry)
        self.assertIn(entry.id, entry.path)
        # Two literal occurrences, one slot: idf * 1, not idf * 1.5.
        self.assert_close(_search_score(entry, terms, idf), idf["embedded"], "embedded single slot")
        self.assert_close(golden["ts"]["scores"]["mem_embedded_id"], idf["embedded"], "ts embedded single slot")
        self.assert_close(_search_score(entry, ["embedded"], None), 1.0, "slot factor")


if __name__ == "__main__":
    unittest.main()
