#!/usr/bin/env node
/**
 * Cross-language parity instrument: the TS harness digest window
 * (`packages/coding-agent/src/core/refinement/refinement.ts`) against the
 * Python kernel search face (`prime-agent-runtime/src/rlm/harness.py`).
 *
 * This is the only place both languages are driven together. The vitest needle
 * (`test/harness-search-parity.test.ts`) and the unittest needle
 * (`prime-agent-runtime/test/test_harness_search_parity.py`) each stay sealed in
 * their own runtime and pin the same machine-generated golden
 * (`test/fixtures/harness-parity/expected.json`), which this script writes.
 *
 * Scoring口径 (the restricted regime where the two faces are字面同构):
 *   - one kind as the ranked corpus on both sides (`kind=memory`); Python's
 *     `search(kind=None)` merges every kind into one document-frequency corpus
 *     and the TS digest never does, which is recorded as a divergence case;
 *   - one explicit term list, both sides bypassing their own tokenizer, so the
 *     differing minimum term lengths cannot leak into the comparison;
 *   - every TS term weight 1 (`harness.search` has no weight face at all);
 *   - every scored field a string (a non-string `path` is its own divergence
 *     case: the Python loader coerces it to "general", the TS loader does not);
 *   - distinct positive scores above the top-k cut, so the window is decided by
 *     score alone and the two documented tie-breaks cannot interfere.
 * Under that regime both sides must return the same ids in the same order.
 * Anything the regime does not cover is pinned as a named divergence instead of
 * being smoothed over: see `docs/fork/evidence/harness-search-parity.md`.
 *
 * Three independent computations have to agree before a golden is written:
 * the TS face, the Python face, and the reference scorer inside this file (a
 * plain re-implementation of the documented formula, so neither side is its own
 * oracle). Scores are compared with a 1e-12 tolerance because the two libm
 * `log` implementations differ in the last ULP; id orders are compared exactly.
 *
 * Usage:
 *   node packages/coding-agent/scripts/perf/harness-parity.mjs            # verify
 *   node packages/coding-agent/scripts/perf/harness-parity.mjs --write    # re-mint the golden
 *   node packages/coding-agent/scripts/perf/harness-parity.mjs --break=idf  # positive control
 *   node packages/coding-agent/scripts/perf/harness-parity.mjs --help
 *
 * Options:
 *   --verify              the default mode, spelled out: compare both faces and
 *                         the reference scorer, then compare against expected.json
 *   --write               rewrite expected.json from the live run (only after
 *                         every side-vs-side and reference check passed)
 *   --report=<path>       where to write parity-report.json
 *                         (default: <tmpdir>/harness-parity-report.json)
 *   --break=<side:name>   deliberately corrupt ONE face and require the
 *                         comparator to catch it (positive control):
 *                         ts:idf | ts:slot-factor | py:idf | py:zero-drop |
 *                         py:tiebreak
 *   --case=<name>         run one fixture case instead of all of them
 *   --python=<path>       Python >= 3.11 interpreter for the kernel face
 *                         (default: $PRIME_AGENT_PYTHON or python3; there is no
 *                         silent fallback - a too-old interpreter aborts)
 *   --runtime-src=<path>  prime-agent-runtime/src (default: derived from the repo root)
 *   --timeout=<ms>        overall watchdog (default: 180000); each child gets half
 *   --keep-workdir        do not delete the temporary state directories
 *   --json                print the finding list as JSON instead of text
 *
 * Exit codes: 0 = every check passed; 1 = a check failed (or --break was NOT
 * caught, which means the comparator is vacuous); 2 = the watchdog fired or a
 * driver could not run.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const FIXTURE_DIR = join(PACKAGE_ROOT, "test", "fixtures", "harness-parity");
const STATE_PATH = join(FIXTURE_DIR, "state.json");
const TERMS_PATH = join(FIXTURE_DIR, "terms.json");
const EXPECTED_PATH = join(FIXTURE_DIR, "expected.json");
const TS_IMPL = join(PACKAGE_ROOT, "src", "core", "refinement", "refinement.ts");
const PY_IMPL = join(REPO_ROOT, "prime-agent-runtime", "src", "rlm", "harness.py");
const TS_DRIVER = join(HERE, "harness-parity-ts.ts");
const PY_DRIVER = join(HERE, "harness-parity-python.py");
const TOLERANCE = 1e-12;
/**
 * Positive controls, side-qualified: breaking one face only is what proves the
 * cross-language comparator works. A break applied to both faces at once moves
 * them together and would only be caught by the golden comparison.
 */
const BREAK_NAMES = new Set(["ts:idf", "ts:slot-factor", "py:idf", "py:zero-drop", "py:tiebreak"]);
/** Provenance that legitimately moves without any ranking fact changing. */
const VOLATILE_KEYS = new Set(["generated_at", "base_sha", "child_timings", "report_path"]);

const HELP = readFileSync(fileURLToPath(import.meta.url), "utf8")
	.split("*/")[0]
	.replace(/^#!.*\n/, "")
	.replace(/^\/\*\*/, "harness-parity - TS digest window vs Python harness.search")
	.replace(/^ \* ?/gm, "")
	.trim();

function parseArgs(argv) {
	const options = {
		verify: false,
		write: false,
		breakName: null,
		caseName: null,
		python: process.env.PRIME_AGENT_PYTHON ?? "python3",
		runtimeSrc: null,
		report: join(tmpdir(), "harness-parity-report.json"),
		timeoutMs: 180_000,
		keepWorkdir: false,
		json: false,
		help: false,
	};
	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--verify") options.verify = true; // explicit spelling of the default mode
		else if (arg === "--write") options.write = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--keep-workdir") options.keepWorkdir = true;
		else if (arg.startsWith("--break=")) options.breakName = arg.slice("--break=".length);
		else if (arg.startsWith("--case=")) options.caseName = arg.slice("--case=".length);
		else if (arg.startsWith("--python=")) options.python = arg.slice("--python=".length);
		else if (arg.startsWith("--runtime-src=")) options.runtimeSrc = arg.slice("--runtime-src=".length);
		else if (arg.startsWith("--report=")) options.report = resolve(arg.slice("--report=".length));
		else if (arg.startsWith("--timeout=")) options.timeoutMs = Number(arg.slice("--timeout=".length));
		else throw new Error(`unknown argument: ${arg} (try --help)`);
	}
	if (options.breakName !== null && !BREAK_NAMES.has(options.breakName)) {
		throw new Error(
			`--break must be side-qualified and one of ${[...BREAK_NAMES].join(", ")}, got ${options.breakName}; ` +
				"a break applied to both faces at once moves them together and proves nothing about the comparator",
		);
	}
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) throw new Error("--timeout must be >= 1000 ms");
	return options;
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitHead() {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

function close(left, right) {
	return Math.abs(left - right) <= TOLERANCE * Math.max(1, Math.abs(left), Math.abs(right));
}

// ---------------------------------------------------------------------------
// reference scorer: the third, independent computation
// ---------------------------------------------------------------------------

function referenceFields(entries, convention) {
	const lower = (value) => (typeof value === "string" ? value.toLowerCase() : "");
	const fields = [];
	for (const entry of entries) {
		if (convention === "py" && (typeof entry.title !== "string" || typeof entry.content !== "string")) {
			// harness.py load() drops a row whose title or content is not a string.
			continue;
		}
		const path =
			convention === "py" && typeof entry.path !== "string"
				? "general" // harness.py load() coerces a non-string path
				: entry.path;
		fields.push({
			entry,
			title: lower(entry.title),
			content: lower(entry.content),
			// refinement.ts lowercases each slot before joining, harness.py joins
			// then lowercases: identical for strings, different for a coerced path.
			identifier: convention === "ts" ? `${lower(path)} ${lower(entry.id)}` : lower(`${path} ${entry.id}`),
			rankIdentifier: [path, entry.title, entry.id].join("\0"),
			coercedPath: path,
		});
	}
	return fields;
}

function referenceFace(entries, terms, weights, convention) {
	const fields = referenceFields(entries, convention);
	const documentFrequency = new Map();
	for (const field of fields) {
		for (const term of terms) {
			if (field.title.includes(term) || field.content.includes(term) || field.identifier.includes(term)) {
				documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
			}
		}
	}
	const idf = new Map();
	for (const [term, df] of documentFrequency) idf.set(term, Math.log(1 + fields.length / df));
	const scores = new Map();
	for (const field of fields) {
		let score = 0;
		for (const term of terms) {
			const slots =
				Number(field.title.includes(term)) +
				Number(field.content.includes(term)) +
				Number(field.identifier.includes(term));
			if (slots > 0) score += (weights.get(term) ?? 1) * (idf.get(term) ?? 1) * (1 + (slots - 1) * 0.5);
		}
		scores.set(field.entry.id, score);
	}
	let ordered;
	if (convention === "ts") {
		// score desc, then the stable identifier tie-break (never recency).
		ordered = [...fields].sort((x, y) => {
			const delta = scores.get(y.entry.id) - scores.get(x.entry.id);
			if (delta !== 0) return delta > 0 ? 1 : -1;
			return x.rankIdentifier.localeCompare(y.rankIdentifier);
		});
	} else {
		// list() order, then the two stable passes search() performs.
		ordered = [...fields].sort((x, y) =>
			[x.entry.kind, String(x.coercedPath), String(x.entry.title), String(x.entry.id)] <
			[y.entry.kind, String(y.coercedPath), String(y.entry.title), String(y.entry.id)]
				? -1
				: 1,
		);
		ordered = ordered.filter((field) => scores.get(field.entry.id) > 0);
		ordered = [...ordered].sort((x, y) =>
			String(x.entry.kind) + "\0" + String(x.entry.id) < String(y.entry.kind) + "\0" + String(y.entry.id) ? -1 : 1,
		);
		ordered = [...ordered].sort((x, y) => {
			const byScore = scores.get(y.entry.id) - scores.get(x.entry.id);
			if (byScore !== 0) return byScore > 0 ? 1 : -1;
			const left = typeof x.entry.updated_at === "string" ? x.entry.updated_at : "";
			const right = typeof y.entry.updated_at === "string" ? y.entry.updated_at : "";
			if (left === right) return 0;
			return left < right ? 1 : -1;
		});
	}
	return {
		corpus_count: fields.length,
		idf: Object.fromEntries(idf),
		scores: Object.fromEntries(scores),
		order: ordered.map((field) => field.entry.id),
	};
}

// ---------------------------------------------------------------------------
// drivers
// ---------------------------------------------------------------------------

function tsxBinary() {
	const local = join(REPO_ROOT, "node_modules", ".bin", "tsx");
	return existsSync(local) ? local : "npx";
}

function runChild(command, args, label, timeoutMs) {
	const started = Date.now();
	const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
	const ms = Date.now() - started;
	if (result.error) throw new Error(`${label} failed to run: ${result.error.message}`);
	if (result.status !== 0) {
		throw new Error(`${label} exited ${result.status}\n${(result.stdout ?? "") + (result.stderr ?? "")}`);
	}
	return { ms, stderr: result.stderr ?? "" };
}

function pythonVersion(python) {
	const result = spawnSync(python, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], {
		encoding: "utf8",
		timeout: 30_000,
	});
	if (result.status !== 0) {
		throw new Error(
			`the Python face needs an interpreter that can import prime-agent-runtime; ${python} did not run: ${
				result.error?.message ?? result.stderr
			}`,
		);
	}
	const [major, minor] = result.stdout.trim().split(".").map(Number);
	if (major < 3 || (major === 3 && minor < 11)) {
		throw new Error(
			`prime-agent-runtime requires Python >= 3.11 (pyproject.toml); ${python} is ${major}.${minor}. ` +
				"Pass --python=<interpreter>; this instrument never falls back silently.",
		);
	}
	return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// comparison
// ---------------------------------------------------------------------------

function record(findings, level, caseName, check, detail) {
	findings.push({ level, case: caseName, check, detail });
}

function equalNumbers(left, right) {
	const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
	const differing = [];
	for (const key of keys) {
		const a = left?.[key];
		const b = right?.[key];
		if (typeof a !== "number" || typeof b !== "number" ? a !== b : !close(a, b)) differing.push({ key, ts: a, python: b });
	}
	return differing;
}

function equalLists(left, right) {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(`${HELP}\n`);
		return 0;
	}
	const watchdog = setTimeout(() => {
		process.stderr.write(`harness-parity: watchdog fired after ${options.timeoutMs} ms\n`);
		process.exit(2);
	}, options.timeoutMs);
	const workdirs = [];
	try {
		return run(options, workdirs);
	} finally {
		clearTimeout(watchdog);
		if (!options.keepWorkdir) for (const dir of workdirs) rmSync(dir, { recursive: true, force: true });
	}
}

function run(options, workdirs) {
	for (const path of [STATE_PATH, TERMS_PATH, TS_IMPL, PY_IMPL, TS_DRIVER, PY_DRIVER]) {
		if (!existsSync(path)) throw new Error(`missing required file: ${path}`);
	}
	const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
	const termsFixture = JSON.parse(readFileSync(TERMS_PATH, "utf8"));
	const pythonVersionString = pythonVersion(options.python);
	const runtimeSrc = options.runtimeSrc ?? join(REPO_ROOT, "prime-agent-runtime", "src");

	const tsWorkdir = mkdtempSync(join(tmpdir(), "harness-parity-ts-"));
	const pyWorkdir = mkdtempSync(join(tmpdir(), "harness-parity-py-"));
	workdirs.push(tsWorkdir, pyWorkdir);
	const tsOut = join(tsWorkdir, "ts-report.json");
	const pyOut = join(pyWorkdir, "py-report.json");
	const childTimeout = Math.max(20_000, Math.floor(options.timeoutMs / 2));

	const tsx = tsxBinary();
	const tsArgs = tsx === "npx" ? ["tsx", TS_DRIVER] : [TS_DRIVER];
	const breakSide = options.breakName === null ? null : options.breakName.slice(0, options.breakName.indexOf(":"));
	const breakKind = options.breakName === null ? null : options.breakName.slice(options.breakName.indexOf(":") + 1);
	const childTimings = {};
	const tsRun = runChild(
		tsx,
		[
			...tsArgs,
			`--state=${STATE_PATH}`,
			`--terms=${TERMS_PATH}`,
			`--workdir=${tsWorkdir}`,
			`--out=${tsOut}`,
			...(breakSide === "ts" ? [`--break=${breakKind}`] : []),
		],
		"the TS driver (tsx)",
		childTimeout,
	);
	childTimings.ts = tsRun.ms;
	const pyRun = runChild(
		options.python,
		[
			PY_DRIVER,
			`--state=${STATE_PATH}`,
			`--terms=${TERMS_PATH}`,
			`--workdir=${pyWorkdir}`,
			`--out=${pyOut}`,
			`--runtime-src=${runtimeSrc}`,
			...(breakSide === "py" ? [`--break=${breakKind}`] : []),
		],
		"the Python driver",
		childTimeout,
	);
	childTimings.python = pyRun.ms;

	const tsReport = JSON.parse(readFileSync(tsOut, "utf8"));
	const pyReport = JSON.parse(readFileSync(pyOut, "utf8"));

	const findings = [];
	if (options.breakName) {
		const armed = breakSide === "ts" ? tsReport.break_applied : pyReport.break_applied;
		const untouched = breakSide === "ts" ? pyReport.break_applied : tsReport.break_applied;
		if (armed !== breakKind) {
			throw new Error(
				`--break=${options.breakName} was not applied by the ${breakSide} driver (it reported ${armed}); ` +
					"a positive control that cannot be armed proves nothing",
			);
		}
		if (untouched !== null) throw new Error(`--break=${options.breakName} leaked into the other face (${untouched})`);
	}

	const caseNames = termsFixture.cases.map((entry) => entry.name);
	const selected = options.caseName ? termsFixture.cases.filter((entry) => entry.name === options.caseName) : termsFixture.cases;
	if (selected.length === 0) throw new Error(`--case=${options.caseName} is not in ${TERMS_PATH}`);

	const cases = {};
	for (const parityCase of selected) {
		const name = parityCase.name;
		const tsCase = tsReport.cases[name];
		const pyCase = pyReport.cases[name];
		if (!tsCase || !pyCase) throw new Error(`case ${name}: a driver did not report it`);
		// The TS face is the only one with a weight column; every other mode runs
		// the parity regime's weight-1 rule.
		const tsTerms = parityCase.mode === "tokenized" ? tsCase.tokenizer_terms : Object.keys(tsCase.terms_used);
		const weights =
			parityCase.mode === "explicit_weighted"
				? new Map(Object.entries(parityCase.terms))
				: new Map(tsTerms.map((term) => [term, 1]));
		const pyTerms = parityCase.mode === "tokenized" ? pyCase.tokenizer_terms : Object.keys(pyCase.terms_used);
		const kind = parityCase.kind ?? "memory";
		const tsCorpus = (state.entries[kind] ?? {});
		const pyCorpusEntries =
			parityCase.kind === null
				? Object.values(state.entries).flatMap((records) => Object.values(records))
				: Object.values(tsCorpus);
		const referenceTs = referenceFace(Object.values(tsCorpus), tsTerms, weights, "ts");
		const referencePy = referenceFace(
			pyCorpusEntries,
			pyTerms,
			new Map(pyTerms.map((term) => [term, 1])),
			"py",
		);

		// --- the reference oracle: neither face may be its own authority -------
		const tsBroken = tsReport.break_applied !== null;
		const pyBroken = pyReport.break_applied !== null;
		const refChecks = [
			["ts corpus size", tsCase.corpus_count, referenceTs.corpus_count],
			["python corpus size", pyCase.corpus_count, referencePy.corpus_count],
		];
		for (const [label, actual, expected] of refChecks) {
			if (actual !== expected) record(findings, "fail", name, `reference ${label}`, `${actual} != ${expected}`);
			else record(findings, "pass", name, `reference ${label}`, `${actual} entries`);
		}
		// The reference scorer is the third computation: a plain re-implementation
		// of the documented formula, so neither face is its own oracle. Under a
		// --break positive control one face is deliberately wrong, so the reference
		// comparison is only asserted on a clean run.
		const tsScoreDrift = equalNumbers(tsCase.scores, referenceTs.scores);
		const pyScoreDrift = equalNumbers(pyCase.scores, referencePy.scores);
		if (!tsBroken) {
			if (tsScoreDrift.length > 0) record(findings, "fail", name, "reference ts scores", JSON.stringify(tsScoreDrift.slice(0, 4)));
			else record(findings, "pass", name, "reference ts scores", `${Object.keys(referenceTs.scores).length} entries within ${TOLERANCE}`);
			const tsIdfDrift = equalNumbers(tsCase.idf, referenceTs.idf);
			if (tsIdfDrift.length > 0) record(findings, "fail", name, "reference ts idf", JSON.stringify(tsIdfDrift.slice(0, 4)));
			else record(findings, "pass", name, "reference ts idf", `${Object.keys(referenceTs.idf).length} terms`);
			if (!equalLists(tsCase.rank, referenceTs.order)) {
				record(findings, "fail", name, "reference ts order", `${tsCase.rank.join(",")} != ${referenceTs.order.join(",")}`);
			} else record(findings, "pass", name, "reference ts order", `${referenceTs.order.length} ids`);
		}
		if (!pyBroken) {
			if (pyScoreDrift.length > 0) record(findings, "fail", name, "reference python scores", JSON.stringify(pyScoreDrift.slice(0, 4)));
			else record(findings, "pass", name, "reference python scores", `${Object.keys(referencePy.scores).length} entries within ${TOLERANCE}`);
			const pyIdfDrift = equalNumbers(pyCase.idf, referencePy.idf);
			if (pyIdfDrift.length > 0) record(findings, "fail", name, "reference python idf", JSON.stringify(pyIdfDrift.slice(0, 4)));
			else record(findings, "pass", name, "reference python idf", `${Object.keys(referencePy.idf).length} terms`);
			if (!equalLists(pyCase.order, referencePy.order)) {
				record(findings, "fail", name, "reference python order", `${pyCase.order.join(",")} != ${referencePy.order.join(",")}`);
			} else record(findings, "pass", name, "reference python order", `${referencePy.order.length} ids`);
		}
		// Explicit-mode cases must round-trip through Python's own tokenizer, or the
		// "same term list" premise of the parity regime is false.
		if (parityCase.mode !== "tokenized") {
			if (equalLists(pyCase.tokenizer_terms, pyTerms)) {
				record(findings, "pass", name, "python tokenizer round-trip", pyTerms.join(","));
			} else {
				record(findings, "fail", name, "python tokenizer round-trip", `${pyCase.tokenizer_terms.join(",")} != ${pyTerms.join(",")}`);
			}
		}

		// --- face invariants: true on every case, broken break or not ----------
		const zeroRowsKept = pyCase.order.filter((id) => !(pyCase.scores[id] > 0));
		if (zeroRowsKept.length > 0) {
			record(findings, "fail", name, "python drops zero-score rows", `search returned ${zeroRowsKept.join(",")} at score 0`);
		} else {
			record(findings, "pass", name, "python drops zero-score rows", `${pyCase.order.length} hits, all scored above 0`);
		}
		if (tsCase.rank.length !== tsCase.corpus_count) {
			record(findings, "fail", name, "ts ranks the whole kind corpus", `${tsCase.rank.length} of ${tsCase.corpus_count}`);
		} else {
			record(findings, "pass", name, "ts ranks the whole kind corpus", `${tsCase.rank.length} rows, zero-score rows included`);
		}

		// --- side vs side, per the case's documented expectation ---------------
		const idfDrift = equalNumbers(tsCase.idf, pyCase.idf);
		const scoreDrift = equalNumbers(tsCase.scores, pyCase.scores);
		const topKCompare = Object.fromEntries(
			parityCase.top_k.map((limit) => [String(limit), equalLists(tsCase.top_k[String(limit)], pyCase.top_k[String(limit)])]),
		);
		const expect = parityCase.expect;
		if (expect === "same_order") {
			if (idfDrift.length > 0) record(findings, "fail", name, "idf parity", JSON.stringify(idfDrift.slice(0, 4)));
			else record(findings, "pass", name, "idf parity", `${Object.keys(tsCase.idf).length} terms, max drift within ${TOLERANCE}`);
			if (scoreDrift.length > 0) record(findings, "fail", name, "score parity", JSON.stringify(scoreDrift.slice(0, 4)));
			else record(findings, "pass", name, "score parity", `${Object.keys(tsCase.scores).length} entries within ${TOLERANCE}`);
			for (const [limit, same] of Object.entries(topKCompare)) {
				if (same) record(findings, "pass", name, `top-${limit} order parity`, tsCase.top_k[limit].join(" > "));
				else
					record(
						findings,
						"fail",
						name,
						`top-${limit} order parity`,
						`ts ${tsCase.top_k[limit].join(",")} != python ${pyCase.top_k[limit].join(",")}`,
					);
			}
			for (const [limit, ids] of Object.entries(tsCase.digest_window ?? {})) {
				if (ids === null) {
					record(findings, "note", name, `digest window == top-${limit}`, tsCase.digest_face);
				} else if (!equalLists(ids, tsCase.top_k[limit])) {
					record(findings, "fail", name, `digest window == top-${limit}`, `${ids.join(",")} != ${tsCase.top_k[limit].join(",")}`);
				} else {
					record(findings, "pass", name, `digest window == top-${limit}`, ids.join(" > "));
				}
			}
		} else {
			// A documented divergence: the scores that must still agree do, and the
			// face that must differ does.
			if (expect === "divergent_tiebreak") {
				if (idfDrift.length > 0) record(findings, "fail", name, "idf parity under a tie", JSON.stringify(idfDrift.slice(0, 4)));
				if (scoreDrift.length > 0) record(findings, "fail", name, "score parity under a tie", JSON.stringify(scoreDrift.slice(0, 4)));
				else record(findings, "pass", name, "score parity under a tie", "identical scores, different tie-breaks");
			}
			for (const [limit, same] of Object.entries(topKCompare)) {
				if (!same)
					record(
						findings,
						"pass",
						name,
						`top-${limit} divergence held`,
						`ts ${tsCase.top_k[limit].join(",")} | python ${pyCase.top_k[limit].join(",")}`,
					);
				else record(findings, "fail", name, `top-${limit} divergence held`, `both faces returned ${tsCase.top_k[limit].join(",")}`);
			}
			if (expect === "divergent_tokenizer") {
				const dropped = pyCase.tokenizer_terms.filter((term) => !tsCase.tokenizer_terms.includes(term));
				const added = tsCase.tokenizer_terms.filter((term) => !pyCase.tokenizer_terms.includes(term));
				if (dropped.length === 0) record(findings, "fail", name, "tokenizer floor divergence held", "no term was cut");
				else
					record(
						findings,
						"pass",
						name,
						"tokenizer floor divergence held",
						`python keeps ${pyCase.tokenizer_terms.join(",")}; ts keeps ${tsCase.tokenizer_terms.join(",")}; cut: ${dropped.join(",")}; ts-only: ${added.join(",") || "none"}`,
					);
			}
			if (expect === "divergent_field_normalization") {
				const differing = scoreDrift.map((item) => item.key);
				if (differing.length === 0) record(findings, "fail", name, "field normalization divergence held", "no score differed");
				else
					record(
						findings,
						"pass",
						name,
						"field normalization divergence held",
						`differing ids: ${differing.join(",")} (python coerces a non-string path to "general", ts drops it from the identifier slot)`,
					);
			}
			if (expect === "divergent_df_corpus") {
				if (idfDrift.length === 0) record(findings, "fail", name, "merged-corpus divergence held", "both idf maps agreed");
				else
					record(
						findings,
						"pass",
						name,
						"merged-corpus divergence held",
						`python corpus ${pyCase.corpus_count} entries vs ts per-kind ${tsCase.corpus_count}; ${idfDrift.length} idf values differ`,
					);
			}
			if (expect === "divergent_term_weights") {
				if (scoreDrift.length === 0) record(findings, "fail", name, "term weight divergence held", "both faces scored alike");
				else
					record(
						findings,
						"pass",
						name,
						"term weight divergence held",
						`ts weights ${JSON.stringify(tsCase.terms_used)} vs python weight 1; ${scoreDrift.length} scores differ`,
					);
			}
		}

		cases[name] = {
			expect,
			mode: parityCase.mode,
			note: parityCase.note ?? "",
			python_query: parityCase.python_query,
			top_k_limits: parityCase.top_k,
			reference: { ts: referenceTs, python: referencePy },
			ts: tsCase,
			python: pyCase,
		};
	}

	// --- regime guards: the fixture must still be the regime the pins assume ---
	const parityCase = selected.find((entry) => entry.name === "parity");
	const regime = {};
	if (parityCase && options.breakName === null) {
		const tsCase = tsReport.cases.parity;
		const pyCase = pyReport.cases.parity;
		const scores = Object.values(tsCase.scores);
		const positive = Object.entries(tsCase.scores).filter(([, score]) => score > 0);
		const sorted = positive.map(([, score]) => score).sort((a, b) => b - a);
		const top = sorted.slice(0, 10);
		const tieCounts = new Map();
		for (const [, score] of positive) tieCounts.set(score, (tieCounts.get(score) ?? 0) + 1);
		const tieGroups = [...tieCounts.entries()].filter(([, count]) => count > 1);
		const zeros = Object.entries(tsCase.scores).filter(([, score]) => score === 0).map(([id]) => id);
		regime.corpus_count = tsCase.corpus_count;
		regime.positive_count = positive.length;
		regime.zero_count = zeros.length;
		regime.zero_ids = zeros;
		regime.top10_distinct = new Set(top).size === top.length;
		regime.tie_groups = tieGroups.map(([score, count]) => ({ score, count }));
		regime.tie_below_cut = tieGroups.every(([score]) => top.length < 10 || score < top[top.length - 1]);
		regime.python_drops_zeros = zeros.every((id) => !pyCase.order.includes(id));
		regime.ts_zero_scores_match_python = zeros.every((id) => close(pyCase.scores[id] ?? Number.NaN, 0));
		const guards = [
			["corpus >= 24 memory entries", tsCase.corpus_count >= 24, `${tsCase.corpus_count}`],
			[">= 10 positive entries", positive.length >= 10, `${positive.length}`],
			["top-10 scores pairwise distinct", regime.top10_distinct, `cut ${top[top.length - 1]}`],
			["exactly one positive tie group, size >= 3", tieGroups.length === 1 && tieGroups[0][1] >= 3, JSON.stringify(regime.tie_groups)],
			["the tie group sits below the top-10 cut", regime.tie_below_cut, JSON.stringify(regime.tie_groups)],
			[">= 3 zero-score entries", zeros.length >= 3, zeros.join(",")],
			["python drops every zero-score entry", regime.python_drops_zeros, `${zeros.length} ids absent from search`],
			["both faces score the zero entries 0", regime.ts_zero_scores_match_python, "score-level parity only"],
			["every scored field is a string except the one malformed row", scores.length === tsCase.corpus_count, `${scores.length} scores`],
		];
		for (const [label, ok, detail] of guards) {
			record(findings, ok ? "pass" : "fail", "regime", label, detail);
		}
	}

	// --- golden ---------------------------------------------------------------
	const provenance = {
		generated_at: new Date().toISOString(),
		generated_by: "node packages/coding-agent/scripts/perf/harness-parity.mjs --write",
		base_sha: gitHead(),
		python_version: pythonVersionString,
		tolerance: TOLERANCE,
		implementations: {
			ts: { path: "packages/coding-agent/src/core/refinement/refinement.ts", sha256: sha256(TS_IMPL) },
			python: { path: "prime-agent-runtime/src/rlm/harness.py", sha256: sha256(PY_IMPL) },
		},
		fixtures: { state_sha256: sha256(STATE_PATH), terms_sha256: sha256(TERMS_PATH) },
		child_timings: childTimings,
	};

	let golden = null;
	if (existsSync(EXPECTED_PATH)) golden = JSON.parse(readFileSync(EXPECTED_PATH, "utf8"));
	const drift = [];
	if (golden !== null && !options.write) {
		if (golden.implementations?.ts?.sha256 !== provenance.implementations.ts.sha256) {
			record(findings, "note", "golden", "refinement.ts moved since the golden was minted", "numbers still compared; re-mint with --write only if they legitimately changed");
		}
		if (golden.implementations?.python?.sha256 !== provenance.implementations.python.sha256) {
			record(findings, "note", "golden", "harness.py moved since the golden was minted", "numbers still compared; re-mint with --write only if they legitimately changed");
		}
		compareGolden(golden.cases ?? {}, cases, drift);
		if (drift.length > 0) {
			for (const item of drift.slice(0, 12)) record(findings, "fail", "golden", item.path, item.detail);
			if (drift.length > 12) record(findings, "fail", "golden", "drift count", `${drift.length} differing values`);
		} else {
			record(findings, "pass", "golden", "live run reproduces expected.json", `${caseNames.length} cases`);
		}
	}

	const failures = findings.filter((item) => item.level === "fail");
	const report = {
		...provenance,
		regime,
		break_applied: options.breakName,
		cases,
		findings,
		failure_count: failures.length,
	};
	writeFileSync(options.report, `${JSON.stringify(report, null, 1)}\n`, "utf8");
	report.report_path = options.report;

	if (options.write) {
		if (failures.length > 0) {
			process.stderr.write(`harness-parity: refusing to write the golden with ${failures.length} failing check(s)\n`);
			for (const failure of failures.slice(0, 10)) process.stderr.write(`  FAIL ${failure.case}/${failure.check}: ${failure.detail}\n`);
			return 1;
		}
		const goldenPayload = { ...provenance, regime, cases };
		delete goldenPayload.child_timings;
		writeFileSync(EXPECTED_PATH, `${JSON.stringify(goldenPayload, null, 1)}\n`, "utf8");
		process.stdout.write(`harness-parity: wrote ${EXPECTED_PATH}\n`);
	}

	if (options.breakName !== null) {
		// Positive control: the break must be caught. A clean run here means the
		// comparator is vacuous, which is worse than a red suite.
		if (failures.length === 0) {
			process.stderr.write(`harness-parity: --break=${options.breakName} was NOT caught; the comparator is vacuous\n`);
			return 1;
		}
		process.stdout.write(
			`harness-parity: positive control held - --break=${options.breakName} produced ${failures.length} failure(s)\n`,
		);
		for (const failure of failures.slice(0, 8)) process.stdout.write(`  FAIL ${failure.case}/${failure.check}: ${failure.detail}\n`);
		return 1;
	}

	if (options.json) process.stdout.write(`${JSON.stringify({ findings, failure_count: failures.length, report_path: options.report }, null, 1)}\n`);
	else {
		for (const item of findings) process.stdout.write(`${item.level.toUpperCase()} ${item.case}/${item.check}: ${item.detail}\n`);
		process.stdout.write(`harness-parity: ${findings.length} checks, ${failures.length} failure(s); report ${options.report}\n`);
	}
	return failures.length === 0 ? 0 : 1;
}

function compareGolden(goldenCases, liveCases, drift, prefix = "cases") {
	for (const [name, live] of Object.entries(liveCases)) {
		const golden = goldenCases[name];
		if (golden === undefined) {
			drift.push({ path: `${prefix}.${name}`, detail: "case missing from expected.json (re-mint with --write)" });
			continue;
		}
		walk(golden, live, `${prefix}.${name}`, drift);
	}
}

function walk(golden, live, path, drift) {
	if (golden === null || live === null || typeof golden !== typeof live) {
		if (!(golden === null && live === null)) drift.push({ path, detail: `${JSON.stringify(golden)} != ${JSON.stringify(live)}` });
		return;
	}
	if (typeof golden === "number") {
		if (typeof live !== "number" || !close(golden, live)) drift.push({ path, detail: `${golden} != ${live}` });
		return;
	}
	if (typeof golden !== "object") {
		if (golden !== live) drift.push({ path, detail: `${JSON.stringify(golden)} != ${JSON.stringify(live)}` });
		return;
	}
	if (Array.isArray(golden)) {
		if (!Array.isArray(live) || golden.length !== live.length) {
			drift.push({ path, detail: `${JSON.stringify(golden)} != ${JSON.stringify(live)}` });
			return;
		}
		golden.forEach((item, index) => walk(item, live[index], `${path}[${index}]`, drift));
		return;
	}
	for (const [key, value] of Object.entries(golden)) {
		if (VOLATILE_KEYS.has(key)) continue;
		walk(value, live?.[key], `${path}.${key}`, drift);
	}
}

try {
	process.exitCode = main();
} catch (error) {
	process.stderr.write(`harness-parity: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(2);
}
