/**
 * TypeScript face of the cross-language harness parity instrument.
 *
 * Driven by `scripts/perf/harness-parity.mjs` through tsx (it imports the TS
 * source directly, so it must resolve the workspace tsconfig paths). It is not
 * part of the vitest face and it never spawns Python: the orchestrator runs the
 * two sides as separate processes and compares their JSON.
 *
 * Everything here reads the shared fixtures under
 * `test/fixtures/harness-parity/` and reports what `refinement.ts` actually
 * does; the only deliberately wrong code paths are the `--break=` positive
 * controls, each labelled where it is applied.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
} from "../../src/core/refinement/refinement.js";

interface ParityCase {
	name: string;
	mode: "explicit" | "explicit_weighted" | "tokenized";
	kind: string | null;
	top_k: number[];
	terms: string[] | Record<string, number>;
	python_query: string;
	expect: string;
	note?: string;
}

interface TermsFixture {
	cases: ParityCase[];
}

interface CaseReport {
	kind_scope: string;
	corpus_kind: string;
	corpus_count: number;
	corpus_key_order: string[];
	terms_used: Record<string, number>;
	tokenizer_terms: string[];
	idf: Record<string, number>;
	scores: Record<string, number>;
	rank: string[];
	top_k: Record<string, string[]>;
	digest_window: Record<string, string[] | null>;
	digest_face: string;
	break_note: string | null;
}

function fail(message: string): never {
	process.stderr.write(`harness-parity-ts: ${message}\n`);
	process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string> {
	const options: Record<string, string> = {};
	for (const arg of argv) {
		const match = /^--([a-z-]+)=(.*)$/.exec(arg);
		if (!match) fail(`unknown argument ${arg}`);
		options[match[1]] = match[2];
	}
	for (const required of ["state", "terms", "workdir", "out"]) {
		if (!options[required]) fail(`--${required}=<path> is required`);
	}
	return options;
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** `[<scope>:<id>]` at the start of a rendered digest row. */
const DIGEST_ROW = /^- \[(?:local|global):([^\]]+)\] /gm;

function digestWindowIds(state: HarnessState, terms: HarnessQueryTerms, limit: number, memoryIds: Set<string>): string[] {
	const rendered = formatHarnessStateForPrompt(state, { maxEntriesPerKind: limit, queryTerms: terms });
	const ids: string[] = [];
	for (const match of rendered.matchAll(DIGEST_ROW)) {
		// The digest renders every kind; only the ranked corpus under test is
		// compared, so rows of other kinds are dropped here.
		if (memoryIds.has(match[1])) ids.push(match[1]);
	}
	return ids;
}

/**
 * Positive control: recompute scores with a deliberately wrong multi-slot
 * factor. Never used unless `--break=slot-factor` is passed; it exists so the
 * orchestrator can prove its comparator is not vacuous.
 */
function brokenSlotFactorScores(entries: HarnessEntry[], terms: HarnessQueryTerms, idf: Map<string, number>): Record<string, number> {
	const scores: Record<string, number> = {};
	for (const entry of entries) {
		const title = typeof entry.title === "string" ? entry.title.toLowerCase() : "";
		const content = typeof entry.content === "string" ? entry.content.toLowerCase() : "";
		const path = typeof entry.path === "string" ? entry.path.toLowerCase() : "";
		const id = typeof entry.id === "string" ? entry.id.toLowerCase() : "";
		const identifier = `${path} ${id}`;
		let total = 0;
		for (const [term, weight] of terms) {
			const slots =
				Number(title.includes(term)) + Number(content.includes(term)) + Number(identifier.includes(term));
			// Wrong on purpose: the real formula is 1 + (slots - 1) * 0.5.
			if (slots > 0) total += weight * (idf.get(term) ?? 1) * (1 + (slots - 1) * 0.25);
		}
		scores[entry.id] = total;
	}
	return scores;
}

function termsFor(parityCase: ParityCase): HarnessQueryTerms {
	if (parityCase.mode === "tokenized") {
		// The production digest face: mine the query with the TS tokenizer.
		return new Map(harnessQueryTerms(parityCase.python_query).map((term) => [term, 1]));
	}
	if (parityCase.mode === "explicit_weighted") {
		const weights = parityCase.terms as Record<string, number>;
		return new Map(Object.entries(weights));
	}
	const list = parityCase.terms as string[];
	return new Map(list.map((term) => [term, 1]));
}

function main(): void {
	const options = parseArgs(process.argv.slice(2));
	const breakName = options["break"] ?? null;
	const stateFixture = readJson(options.state) as { entries: Record<string, Record<string, HarnessEntry>> };
	const termsFixture = readJson(options.terms) as TermsFixture;

	// Load through the real loader so both languages read the same bytes off a
	// real private state file.
	const harnessDir = join(options.workdir, "harness");
	mkdirSync(harnessDir, { recursive: true });
	const statePath = join(harnessDir, "harness_state.json");
	copyFileSync(options.state, statePath);
	const state = loadHarnessState(harnessDir, "global");

	const corpus: Record<string, { count: number; key_order: string[] }> = {};
	for (const [kind, records] of Object.entries(state.entries)) {
		corpus[kind] = { count: Object.keys(records).length, key_order: Object.keys(records) };
	}

	const cases: Record<string, CaseReport> = {};
	for (const parityCase of termsFixture.cases) {
		// The TS digest always ranks one kind at a time; a `kind: null` case is
		// the Python merged-corpus face, so the TS side reports the per-kind
		// ranking it does have and the orchestrator records the divergence.
		const kind = parityCase.kind ?? "memory";
		const entries = Object.values(state.entries[kind] ?? {});
		if (entries.length === 0) fail(`case ${parityCase.name}: kind ${kind} is empty`);
		const terms = termsFor(parityCase);
		const idf = harnessQueryTermIdf(entries, terms);
		const ranked = rankHarnessEntriesForQuery(entries, terms);
		const scores: Record<string, number> = {};
		for (const entry of entries) scores[entry.id] = scoreHarnessEntryForQuery(entry, terms, idf);
		let breakNote: string | null = null;
		if (breakName === "slot-factor") {
			const broken = brokenSlotFactorScores(entries, terms, idf);
			for (const id of Object.keys(broken)) scores[id] = broken[id];
			breakNote = "slot-factor: multi-slot bonus recomputed as 1 + (slots - 1) * 0.25";
		} else if (breakName === "idf") {
			for (const entry of entries) scores[entry.id] = scoreHarnessEntryForQuery(entry, terms);
			breakNote = "idf: scored without the document-frequency discount";
		}
		const idfRecord: Record<string, number> = {};
		for (const [term, value] of idf) idfRecord[term] = value;
		const topK: Record<string, string[]> = {};
		const windows: Record<string, string[] | null> = {};
		const kindIds = new Set(entries.map((entry) => entry.id));
		// OBS-1 (fix-perf-digest-2 item46) changes how a kind whose every score is
		// zero renders: it falls back to the recency order and drops the ranked
		// marker. That face belongs to its own needles, so this instrument reports
		// the rendered window only for a kind that actually scored, and stays
		// silent (null) where the render face is about to move.
		const anyEntryScored = entries.some((entry) => scores[entry.id] > 0);
		for (const limit of parityCase.top_k) {
			topK[String(limit)] = ranked.slice(0, limit).map((entry) => entry.id);
			windows[String(limit)] = anyEntryScored ? digestWindowIds(state, terms, limit, kindIds) : null;
		}
		cases[parityCase.name] = {
			kind_scope: parityCase.kind === null ? "per-kind (the TS digest has no merged-corpus face)" : `kind=${kind}`,
			corpus_kind: kind,
			corpus_count: entries.length,
			corpus_key_order: entries.map((entry) => entry.id),
			terms_used: Object.fromEntries(terms),
			tokenizer_terms: harnessQueryTerms(parityCase.python_query),
			idf: idfRecord,
			scores,
			rank: ranked.map((entry) => entry.id),
			top_k: topK,
			digest_window: windows,
			digest_face: anyEntryScored
				? "formatHarnessStateForPrompt ranked window, memory rows only"
				: "skipped: every score is zero and OBS-1 owns the all-zero render face",
			break_note: breakNote,
		};
	}

	// The raw fixture order is reported too: it documents that the TS corpus is
	// the state file's key order while Python sorts by (kind, path, title, id).
	const report = {
		side: "ts",
		implementation: "packages/coding-agent/src/core/refinement/refinement.ts",
		break_applied: breakName,
		fixture_state_key_order: Object.fromEntries(
			Object.entries(stateFixture.entries ?? {}).map(([kind, records]) => [kind, Object.keys(records)]),
		),
		corpus,
		cases,
	};
	writeFileSync(options.out, `${JSON.stringify(report, null, 1)}\n`, "utf8");
}

main();
