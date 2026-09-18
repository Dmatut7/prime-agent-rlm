import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	formatHarnessStateForPrompt,
	type HarnessEntry,
	type HarnessQueryTerms,
	type HarnessState,
	harnessQueryTermIdf,
	harnessQueryTerms,
	loadHarnessState,
	rankHarnessEntriesForQuery,
	scoreHarnessEntryForQuery,
} from "../src/core/refinement/refinement.js";

/**
 * Cross-language needle: the TS harness digest window and the Python kernel's
 * `harness.search` are two faces of one documented scoring formula, and the
 * places where they deliberately differ are documented too. Both faces pin the
 * same machine-generated golden (`fixtures/harness-parity/expected.json`), which
 * `scripts/perf/harness-parity.mjs` writes after running the two implementations
 * plus an independent reference scorer against each other. This file never
 * spawns Python (the vitest face stays sealed); the Python half of the pair is
 * `prime-agent-runtime/test/test_harness_search_parity.py`.
 *
 * The parity regime the golden was minted under, restated so a fixture edit that
 * breaks it fails here rather than silently weakening the pin: one kind as the
 * ranked corpus, one explicit term list (both faces bypass their own tokenizer),
 * every TS term weight 1, every scored field a string, and distinct positive
 * scores above the top-k cut.
 *
 * Divergences pinned below are deliberate and carry their evidence in
 * `docs/fork/evidence/harness-search-parity.md`. Zero-score rows are pinned at
 * the score level only: what the digest does with a kind where nothing scored
 * belongs to OBS-1 (fix-perf-digest-2 item46), so this file asserts neither
 * their position in a TS ranking nor the presence of the ranked marker.
 */

const FIXTURE_DIR = join(__dirname, "fixtures", "harness-parity");
/** The instrument's comparison tolerance: the two libm `log`s differ in the last ULP. */
const TOLERANCE = 1e-12;

interface FaceReport {
	kind_scope: string;
	corpus_kind: string | null;
	corpus_count: number;
	terms_used: Record<string, number>;
	tokenizer_terms: string[];
	idf: Record<string, number>;
	scores: Record<string, number>;
	top_k: Record<string, string[]>;
}

interface TsFaceReport extends FaceReport {
	corpus_key_order: string[];
	rank: string[];
	digest_window: Record<string, string[] | null>;
	digest_face: string;
}

interface PythonFaceReport extends FaceReport {
	corpus_list_order: string[];
	order: string[];
	zero_ids: string[];
}

interface GoldenCase {
	expect: string;
	mode: string;
	note: string;
	python_query: string;
	top_k_limits: number[];
	reference: {
		ts: { idf: Record<string, number>; scores: Record<string, number> };
		python: { scores: Record<string, number> };
	};
	ts: TsFaceReport;
	python: PythonFaceReport;
}

interface Golden {
	base_sha: string;
	generated_at: string;
	tolerance: number;
	implementations: { ts: { path: string; sha256: string }; python: { path: string; sha256: string } };
	regime: {
		corpus_count: number;
		positive_count: number;
		zero_count: number;
		zero_ids: string[];
		top10_distinct: boolean;
		tie_groups: { score: number; count: number }[];
		tie_below_cut: boolean;
		python_drops_zeros: boolean;
	};
	cases: Record<string, GoldenCase>;
}

interface TermsCase {
	name: string;
	mode: "explicit" | "explicit_weighted" | "tokenized";
	kind: string | null;
	top_k: number[];
	terms: string[] | Record<string, number>;
	python_query: string;
	expect: string;
	note?: string;
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

const expected = readJson(join(FIXTURE_DIR, "expected.json")) as Golden;
const termsFixture = readJson(join(FIXTURE_DIR, "terms.json")) as { cases: TermsCase[] };
const parityInput = termsFixture.cases.find((entry) => entry.name === "parity");
if (!parityInput) throw new Error("terms.json lost the parity case");

function testCase(name: string): TermsCase {
	const found = termsFixture.cases.find((entry) => entry.name === name);
	if (!found) throw new Error(`terms.json lost the ${name} case`);
	return found;
}

function goldenCase(name: string): GoldenCase {
	const found = expected.cases[name];
	if (!found) throw new Error(`expected.json lost the ${name} case; re-mint it with harness-parity.mjs --write`);
	return found;
}

const tempRoots: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-harness-parity-"));
	tempRoots.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Load the shared fixture through the real loader, exactly as the instrument does. */
function loadFixtureState(): HarnessState {
	const harnessDir = join(makeTempDir(), "harness");
	mkdirSync(harnessDir, { recursive: true });
	copyFileSync(join(FIXTURE_DIR, "state.json"), join(harnessDir, "harness_state.json"));
	return loadHarnessState(harnessDir, "global");
}

function memoryEntries(state: HarnessState): HarnessEntry[] {
	return Object.values(state.entries.memory);
}

function weightOne(terms: string[]): HarnessQueryTerms {
	return new Map(terms.map((term) => [term, 1]));
}

function assertClose(actual: number, expectValue: number, label: string): void {
	const bound = TOLERANCE * Math.max(1, Math.abs(actual), Math.abs(expectValue));
	expect(Math.abs(actual - expectValue), `${label}: ${actual} vs ${expectValue}`).toBeLessThanOrEqual(bound);
}

/** `- [<scope>:<id>]` at the start of a rendered digest row. */
const DIGEST_ROW = /^- \[(?:local|global):([^\]]+)\] /gm;

function digestMemoryWindow(
	state: HarnessState,
	terms: HarnessQueryTerms,
	limit: number,
	memoryIds: Set<string>,
): string[] {
	const rendered = formatHarnessStateForPrompt(state, { maxEntriesPerKind: limit, queryTerms: terms });
	const ids: string[] = [];
	for (const match of rendered.matchAll(DIGEST_ROW)) {
		if (memoryIds.has(match[1])) ids.push(match[1]);
	}
	return ids;
}

describe("harness digest window <-> harness.search parity (golden expected.json)", () => {
	const state = loadFixtureState();
	const entries = memoryEntries(state);
	const parityTerms = weightOne(parityInput.terms as string[]);
	const parityIdf = harnessQueryTermIdf(entries, parityTerms);
	const parityGolden = goldenCase("parity");
	const memoryIds = new Set(entries.map((entry) => entry.id));

	it("keeps the fixture inside the regime the golden was minted under", () => {
		// Guard: an emptied or reordered fixture must not let the loops below pass
		// without asserting anything.
		expect(entries.length).toBeGreaterThanOrEqual(24);
		expect(entries.length).toBe(expected.regime.corpus_count);
		const scored = entries.map((entry) => scoreHarnessEntryForQuery(entry, parityTerms, parityIdf));
		const positive = scored.filter((score) => score > 0);
		expect(positive.length).toBeGreaterThanOrEqual(10);
		const top10 = [...positive].sort((a, b) => b - a).slice(0, 10);
		expect(new Set(top10).size, "the top-10 scores must stay pairwise distinct").toBe(top10.length);
		expect(scored.filter((score) => score === 0).length).toBeGreaterThanOrEqual(3);
		expect(expected.regime.top10_distinct).toBe(true);
		expect(expected.regime.tie_groups.length).toBe(1);
		expect(expected.regime.tie_groups[0].count).toBeGreaterThanOrEqual(3);
		expect(expected.regime.tie_below_cut).toBe(true);
	});

	it("scores every entry exactly as the golden records for both languages", () => {
		const idfGolden = parityGolden.ts.idf;
		expect([...parityIdf.keys()].sort()).toEqual(Object.keys(idfGolden).sort());
		for (const [term, value] of parityIdf) assertClose(value, idfGolden[term], `idf(${term})`);
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			const score = scoreHarnessEntryForQuery(entry, parityTerms, parityIdf);
			assertClose(score, parityGolden.ts.scores[entry.id], `ts score ${entry.id}`);
			// The same golden cell is what the Python needle asserts against, so
			// agreeing with it here is the cross-language half of the pin.
			assertClose(parityGolden.python.scores[entry.id], score, `python score ${entry.id}`);
			assertClose(parityGolden.reference.ts.scores[entry.id], score, `reference ts score ${entry.id}`);
		}
	});

	it.each([6, 10])("ranks the top-%i window into the same ids the Python face returns", (limit) => {
		const key = String(limit);
		const ranked = rankHarnessEntriesForQuery(entries, parityTerms)
			.slice(0, limit)
			.map((entry) => entry.id);
		expect(ranked).toEqual(parityGolden.ts.top_k[key]);
		// The claim under test: one golden, two languages, one order.
		expect(parityGolden.python.top_k[key]).toEqual(parityGolden.ts.top_k[key]);
		expect(ranked.length).toBe(limit);
	});

	it.each([6, 10])("injects the same top-%i window into the rendered digest", (limit) => {
		const window = digestMemoryWindow(state, parityTerms, limit, memoryIds);
		expect(window).toEqual(parityGolden.ts.top_k[String(limit)]);
		expect(parityGolden.ts.digest_window[String(limit)]).toEqual(parityGolden.ts.top_k[String(limit)]);
	});

	it("pins zero-score rows at the score level only, leaving their render face to OBS-1", () => {
		const zeros = expected.regime.zero_ids;
		expect(zeros.length).toBeGreaterThanOrEqual(3);
		for (const id of zeros) {
			const entry = state.entries.memory[id];
			expect(entry, `${id} must stay in the fixture`).toBeDefined();
			expect(scoreHarnessEntryForQuery(entry, parityTerms, parityIdf)).toBe(0);
			expect(parityGolden.python.scores[id]).toBe(0);
		}
		// Python drops them from search entirely; that is a documented divergence,
		// not a bug to fix here. What TS does with a kind where nothing scored is
		// OBS-1's face (fix-perf-digest-2 item46), so no ordering or marker
		// assertion belongs in this file.
		expect(parityGolden.python.zero_ids.sort()).toEqual([...zeros].sort());
		expect(parityGolden.python.order.some((id) => zeros.includes(id))).toBe(false);
	});

	it("holds the identifier tie-break the Python face deliberately does not share", () => {
		const input = testCase("tie_window");
		const tieGolden = goldenCase("tie_window");
		const terms = weightOne(input.terms as string[]);
		const idf = harnessQueryTermIdf(entries, terms);
		const ranked = rankHarnessEntriesForQuery(entries, terms)
			.slice(0, input.top_k[0])
			.map((entry) => entry.id);
		expect(ranked).toEqual(tieGolden.ts.top_k[String(input.top_k[0])]);
		// Equal scores on both faces; only the tie-break differs.
		for (const id of ranked) {
			assertClose(tieGolden.python.scores[id], tieGolden.ts.scores[id], `tie score ${id}`);
			assertClose(
				scoreHarnessEntryForQuery(state.entries.memory[id], terms, idf),
				tieGolden.ts.scores[id],
				`live tie score ${id}`,
			);
		}
		const tieGroup = expected.regime.tie_groups[0];
		const tied = Object.entries(parityGolden.ts.scores)
			.filter(([, score]) => Math.abs(score - tieGroup.score) <= TOLERANCE)
			.map(([id]) => id)
			.sort();
		expect(tied.length).toBe(tieGroup.count);
		// TS: [path, title, id].join("\0") ascending. Python: updated_at descending.
		expect(tieGolden.ts.top_k[String(input.top_k[0])].filter((id) => tied.includes(id))).toEqual(tied);
		expect(tieGolden.python.top_k[String(input.top_k[0])].filter((id) => tied.includes(id))).not.toEqual(tied);
		expect(tieGolden.python.top_k[String(input.top_k[0])]).not.toEqual(tieGolden.ts.top_k[String(input.top_k[0])]);
	});

	it("counts path and id as one identifier slot when the id is embedded in the path", () => {
		const entry = state.entries.memory.mem_embedded_id;
		expect(entry.path).toContain(entry.id);
		const idf = parityIdf.get("embedded");
		expect(idf).toBeGreaterThan(0);
		// Two literal occurrences, one slot: the score is idf * 1, not idf * 1.5.
		assertClose(scoreHarnessEntryForQuery(entry, parityTerms, parityIdf), idf ?? Number.NaN, "embedded single slot");
		assertClose(parityGolden.python.scores.mem_embedded_id, idf ?? Number.NaN, "python embedded single slot");
	});

	it("keeps the four-character tokenizer floor the search face deliberately does not share", () => {
		const input = testCase("tokenizer_floor");
		const floorGolden = goldenCase("tokenizer_floor");
		expect(harnessQueryTerms(input.python_query)).toEqual(floorGolden.ts.tokenizer_terms);
		expect(floorGolden.python.tokenizer_terms).toEqual(input.terms);
		const cut = floorGolden.python.tokenizer_terms.filter((term) => !floorGolden.ts.tokenizer_terms.includes(term));
		expect(cut.length).toBeGreaterThan(0);
		// The cut is observable: a row that only a sub-four-character term matches
		// is invisible to the digest and findable through search.
		const tsTerms = weightOne(floorGolden.ts.tokenizer_terms);
		const tsIdf = harnessQueryTermIdf(entries, tsTerms);
		const rlmOnly = "mem_kernel_bridge";
		expect(scoreHarnessEntryForQuery(state.entries.memory[rlmOnly], tsTerms, tsIdf)).toBe(0);
		expect(floorGolden.python.scores[rlmOnly]).toBeGreaterThan(0);
		expect(floorGolden.python.top_k["6"]).toContain(rlmOnly);
		expect(floorGolden.ts.top_k["6"]).not.toContain(rlmOnly);
	});

	it("ranks one kind at a time, which the merged-corpus search face does not", () => {
		const corpusGolden = goldenCase("df_corpus");
		// The TS face has no merged corpus: its idf is the per-kind one, and the
		// Python face's merged idf is a different number for every term.
		for (const [term, value] of parityIdf) assertClose(value, corpusGolden.ts.idf[term], `per-kind idf ${term}`);
		expect(Object.keys(corpusGolden.python.idf).length).toBeGreaterThan(0);
		const differing = Object.keys(corpusGolden.ts.idf).filter(
			(term) => Math.abs(corpusGolden.ts.idf[term] - corpusGolden.python.idf[term]) > TOLERANCE,
		);
		expect(differing.length).toBe(Object.keys(corpusGolden.ts.idf).length);
		expect(corpusGolden.python.corpus_count).toBeGreaterThan(corpusGolden.ts.corpus_count);
		expect(corpusGolden.python.top_k["6"]).not.toEqual(corpusGolden.ts.top_k["6"]);
	});

	it("keeps the digest's term weights, which the search face has no room for", () => {
		const input = testCase("weights");
		const weightsGolden = goldenCase("weights");
		const weighted = new Map(Object.entries(input.terms as Record<string, number>));
		const ranked = rankHarnessEntriesForQuery(entries, weighted)
			.slice(0, input.top_k[0])
			.map((entry) => entry.id);
		expect(ranked).toEqual(weightsGolden.ts.top_k[String(input.top_k[0])]);
		expect(weightsGolden.ts.terms_used).toEqual(Object.fromEntries(weighted));
		// Same term set, same corpus, weight 1 everywhere on the Python face.
		expect(Object.keys(weightsGolden.python.terms_used).sort()).toEqual([...weighted.keys()].sort());
		expect(weightsGolden.python.top_k[String(input.top_k[0])]).not.toEqual(
			weightsGolden.ts.top_k[String(input.top_k[0])],
		);
		const differing = Object.keys(weightsGolden.ts.scores).filter(
			(id) => Math.abs(weightsGolden.ts.scores[id] - weightsGolden.python.scores[id]) > TOLERANCE,
		);
		expect(differing.length).toBeGreaterThan(0);
	});

	it("loses a non-string path from the identifier slot, which the Python loader repairs", () => {
		const fieldGolden = goldenCase("nonstring_path");
		const terms = weightOne(testCase("nonstring_path").terms as string[]);
		const idf = harnessQueryTermIdf(entries, terms);
		// No TS row matches "general": the malformed row's path is a number at
		// runtime, so searchableField drops it, while harness.py's loader coerces
		// the same field to "general" and the row becomes findable.
		expect(idf.size).toBe(0);
		expect(fieldGolden.ts.idf).toEqual({});
		expect(fieldGolden.python.idf.general).toBeGreaterThan(0);
		const malformed = state.entries.memory.mem_numeric_path;
		expect(typeof malformed.path).not.toBe("string");
		expect(scoreHarnessEntryForQuery(malformed, terms, idf)).toBe(0);
		expect(fieldGolden.ts.scores.mem_numeric_path).toBe(0);
		expect(fieldGolden.python.scores.mem_numeric_path).toBeGreaterThan(0);
		expect(fieldGolden.python.top_k["6"]).toEqual(["mem_numeric_path"]);
		// Score level only: with every TS score at zero this kind's render face is
		// OBS-1's, so nothing here asserts an order or the ranked marker.
		expect(fieldGolden.ts.digest_window[String(fieldGolden.top_k_limits[0])]).toBeNull();
	});
});
