#!/usr/bin/env node
/**
 * Anti-false-green gate for one `node --test` job's junit XML report.
 *
 * Why this exists
 * ---------------
 * `scripts/check-vitest-coverage.mjs` gates every vitest job in CI, but the tui job runs
 * `node --test`, which writes no vitest JSON report: a matrix row with `report: ""` runs its
 * command as-is and nothing checks what it actually ran (audit QW-R1: "tui job 无 vitest 报告、
 * 不在覆盖闸内"). `node --test` does write junit XML when asked (`--test-reporter=junit
 * --test-reporter-destination=<file>`), so this gate reads that report and fails on the shapes
 * that hide a lost face of coverage:
 *
 *   - tests that ran fewer than `--min-ran-tests`,
 *   - suites that ran nothing (every test in them `skipped`/`todo`), beyond a budget of
 *     deliberate skips (`--max-nothing-suites`),
 *   - a test file that failed to load (junit reports it as one failing top-level testcase:
 *     its tests did not run, so it counts as a file that ran nothing, named in the failure),
 *   - a total below `--min-tests`, and
 *   - a disagreement between this parser's counts and the runner's own `<!-- tests N -->`
 *     summary comments, which is what protects the gate from its own regex drifting away
 *     from the junit shape node emits.
 *
 * `node --test` names its top-level suites after `describe()` blocks, not files, so the
 * nothing-suite budget is coarser than the vitest gate's nothing-file count: a suite that
 * runs nothing is named, but which file it lives in is not. The floors are what carry the
 * per-job pin.
 *
 * Usage
 * -----
 *   node scripts/check-node-test-coverage.mjs <report.xml> [...] \
 *     [--min-tests N] [--min-ran-tests N] [--max-nothing-suites M]
 *   node scripts/check-node-test-coverage.mjs --self-test
 *
 * `--min-tests` defaults to 30, and `--min-ran-tests` / `--max-nothing-suites` to 0 (off).
 * Exit codes: 0 = gate green, 1 = gate red, 2 = usage/unreadable report.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Default floor for `--min-tests`, mirroring the vitest gate's default. */
const DEFAULT_MIN_TESTS = 30;

class UsageError extends Error {}

function parseIntegerOption(raw, flag, { minimum }) {
	const text = (raw ?? "").trim();
	const value = Number.parseInt(text, 10);
	if (!Number.isInteger(value) || value < minimum || String(value) !== text) {
		throw new UsageError(`${flag} needs an integer >= ${minimum}, got "${raw ?? ""}"`);
	}
	return value;
}

function parseArgs(argv) {
	const options = { reports: [], minTests: DEFAULT_MIN_TESTS, minRanTests: 0, maxNothingSuites: 0, selfTest: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--self-test") {
			options.selfTest = true;
			continue;
		}
		if (arg === "--min-tests") {
			options.minTests = parseIntegerOption(argv[++index], "--min-tests", { minimum: 1 });
			continue;
		}
		if (arg.startsWith("--min-tests=")) {
			options.minTests = parseIntegerOption(arg.slice("--min-tests=".length), "--min-tests", { minimum: 1 });
			continue;
		}
		if (arg === "--min-ran-tests") {
			options.minRanTests = parseIntegerOption(argv[++index], "--min-ran-tests", { minimum: 1 });
			continue;
		}
		if (arg.startsWith("--min-ran-tests=")) {
			options.minRanTests = parseIntegerOption(arg.slice("--min-ran-tests=".length), "--min-ran-tests", {
				minimum: 1,
			});
			continue;
		}
		if (arg === "--max-nothing-suites") {
			options.maxNothingSuites = parseIntegerOption(argv[++index], "--max-nothing-suites", { minimum: 0 });
			continue;
		}
		if (arg.startsWith("--max-nothing-suites=")) {
			options.maxNothingSuites = parseIntegerOption(arg.slice("--max-nothing-suites=".length), "--max-nothing-suites", {
				minimum: 0,
			});
			continue;
		}
		if (typeof arg === "string" && arg.startsWith("-")) throw new UsageError(`unknown option "${arg}"`);
		options.reports.push(arg);
	}
	return options;
}

/** `<element attr="..." attr2="...">` -> { attr: "..." } with XML entities resolved. */
function parseAttributes(raw) {
	const attributes = {};
	for (const match of raw.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
		attributes[match[1]] = match[2]
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&");
	}
	return attributes;
}

function xmlEscape(value) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * One junit XML report, reduced to what the gate judges. `describe` blocks are `<testsuite>`
 * elements and nest; every `<testcase>` belongs to the innermost suite still open when it
 * appears, so a test that follows a nested describe is counted with its own suite. Testcases
 * with no open suite are file-level results: node emits a failing one per test file that failed
 * to load, named after the file, and a plain one per top-level `test()`.
 */
function inspectReport(report, label) {
	const text = typeof report === "string" ? report : "";
	const suites = [];
	const topLevelCases = [];
	const open = [];
	const tags = /<testsuite\b([^>]*?)(\/?)>|<\/testsuite>|<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
	for (const match of text.matchAll(tags)) {
		if (match[0] === "</testsuite>") {
			open.pop();
			continue;
		}
		if (match[0].startsWith("<testsuite")) {
			const suite = {
				name: parseAttributes(match[1]).name ?? "?",
				parent: open.length > 0 ? open[open.length - 1] : null,
				cases: [],
				children: [],
			};
			suite.parent?.children.push(suite);
			suites.push(suite);
			if (match[2] !== "/") open.push(suite);
			continue;
		}
		const caseBody = match[4] ?? "";
		const entry = {
			name: parseAttributes(match[3]).name ?? "?",
			skipped: caseBody.includes("<skipped"),
			failed: caseBody.includes("<failure") || caseBody.includes("<error"),
		};
		(open.length > 0 ? open[open.length - 1].cases : topLevelCases).push(entry);
	}

	// A suite ran nothing when every test in it, nested suites included, was skipped. Only the
	// outermost such suite is reported, so one skipped block is one nothing-suite however deep it nests.
	const ranInSubtree = (suite) =>
		suite.cases.filter((entry) => !entry.skipped).length +
		suite.children.reduce((sum, child) => sum + ranInSubtree(child), 0);
	const totalInSubtree = (suite) =>
		suite.cases.length + suite.children.reduce((sum, child) => sum + totalInSubtree(child), 0);
	for (const suite of suites) {
		suite.total = suite.cases.length;
		suite.counts = {
			passed: suite.cases.filter((entry) => !entry.skipped && !entry.failed).length,
			failed: suite.cases.filter((entry) => entry.failed).length,
			notRun: suite.cases.filter((entry) => entry.skipped).length,
		};
		suite.subtreeTotal = totalInSubtree(suite);
		suite.nothingRan = suite.subtreeTotal > 0 && ranInSubtree(suite) === 0;
	}
	for (const suite of suites) {
		suite.allNotRun = suite.nothingRan && !suite.parent?.nothingRan;
	}

	const fileFailures = topLevelCases.filter((entry) => entry.failed).map((entry) => entry.name);
	const summary = {};
	for (const match of text.matchAll(/<!--\s*([a-z_]+)\s+(\d+)\s*-->/g)) {
		summary[match[1]] = Number.parseInt(match[2], 10);
	}
	const leaves = [...suites.flatMap((suite) => suite.cases), ...topLevelCases];
	// A `describe` skipped by its options is one skipped testcase that the runner's summary counts
	// neither in `tests` nor in `skipped`/`todo`; an `it.skip`/`it.todo` is counted in both. Only
	// skipped cases beyond what the summary itemises are discounted, and only when it itemises any.
	const skippedCases = leaves.filter((entry) => entry.skipped).length;
	const itemised = (summary.skipped ?? 0) + (summary.todo ?? 0);
	const uncounted = Number.isInteger(summary.skipped) ? Math.max(0, skippedCases - itemised) : 0;
	return {
		label,
		testcaseElements: leaves.length,
		totalTests: leaves.length - uncounted,
		ran: leaves.filter((entry) => !entry.skipped).length,
		nothingSuites: suites.filter((suite) => suite.allNotRun).length,
		suites,
		fileFailures,
		summary,
	};
}

function limitsFrom(options) {
	return {
		minTests: options.minTests ?? DEFAULT_MIN_TESTS,
		minRanTests: options.minRanTests ?? 0,
		maxNothingSuites: options.maxNothingSuites ?? 0,
	};
}

function decide(inspection, limits) {
	const failures = [];
	if (inspection.totalTests === 0) {
		failures.push(`${inspection.label}: the report lists no test suites at all (nothing was collected)`);
	}
	if (inspection.totalTests < limits.minTests) {
		failures.push(
			`${inspection.label}: total tests=${inspection.totalTests} is below the --min-tests floor of ${limits.minTests}`,
		);
	}
	if (inspection.ran < limits.minRanTests) {
		failures.push(
			`${inspection.label}: only ${inspection.ran} test(s) ran (the rest were skipped or never collected), ` +
				`below the --min-ran-tests floor of ${limits.minRanTests}`,
		);
	}
	const allNotRun = inspection.suites.filter((suite) => suite.allNotRun);
	if (allNotRun.length > limits.maxNothingSuites) {
		failures.push(
			`${inspection.label}: ${allNotRun.length} suite(s) ran nothing (describe.skip shape), over the ` +
				`--max-nothing-suites budget of ${limits.maxNothingSuites}: ${allNotRun
					.map((suite) => `${suite.name} (${suite.subtreeTotal} skipped)`)
					.join(", ")}`,
		);
	}
	for (const file of inspection.fileFailures) {
		failures.push(`${inspection.label}: test file "${file}" failed before running its tests`);
	}
	// The parser must agree with the runner's own summary: a regex that stopped matching the
	// junit shape would otherwise count its way to a green gate.
	if (Number.isInteger(inspection.summary.tests) && inspection.summary.tests !== inspection.totalTests) {
		const discounted =
			inspection.testcaseElements === inspection.totalTests
				? ""
				: ` (${inspection.testcaseElements} testcase elements, less ${inspection.testcaseElements - inspection.totalTests} skipped describe(s) the runner does not count)`;
		failures.push(
			`${inspection.label}: this parser counted ${inspection.totalTests} test(s)${discounted} but the report's own ` +
				`summary says ${inspection.summary.tests} - the junit shape and this parser disagree`,
		);
	}
	return failures;
}

function formatInspection(inspection) {
	const lines = [
		`### ${inspection.label}: tests=${inspection.totalTests} ran=${inspection.ran} ` +
			`suites=${inspection.suites.length} nothing-suites=${inspection.nothingSuites}`,
	];
	for (const suite of [...inspection.suites].sort((a, b) => a.name.localeCompare(b.name))) {
		const flag = suite.allNotRun ? "  <== ALL SKIPPED (false-green shape)" : "";
		lines.push(
			`    ${suite.name}: n=${suite.total} passed=${suite.counts.passed} failed=${suite.counts.failed} skipped=${suite.counts.notRun}${flag}`,
		);
	}
	return lines.join("\n");
}

function checkFile(path, limits) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return { failures: [`cannot read the junit report at ${path}: ${error.message}`], text: `### ${path}: unreadable` };
	}
	const inspection = inspectReport(raw, path);
	return { failures: decide(inspection, limits), inspection, text: formatInspection(inspection) };
}

// ---------------------------------------------------------------------------
// self-test: planted reports must turn the gate red, a healthy one must not
// ---------------------------------------------------------------------------

function testcaseXml(name, outcome) {
	if (outcome === "pass") return `\t\t<testcase name="${xmlEscape(name)}" time="0.0001" classname="test"/>`;
	const child = outcome === "skip" ? "skipped" : outcome === "todo" ? "skipped" : "failure";
	return `\t\t<testcase name="${xmlEscape(name)}" time="0.0001" classname="test">\n\t\t\t<${child} type="x" message="y"/>\n\t\t</testcase>`;
}

function suiteXml(name, outcomes) {
	const body = outcomes.map((outcome, index) => testcaseXml(`${name} test ${index}`, outcome)).join("\n");
	return `\t<testsuite name="${xmlEscape(name)}" time="0.001" disabled="0" errors="0" tests="${outcomes.length}" failures="0" skipped="0">\n${body}\n\t</testsuite>`;
}

function reportXml(suites, { summary = true, fileFailures = [] } = {}) {
	const parts = ['<?xml version="1.0" encoding="utf-8"?>', "<testsuites>"];
	parts.push(...suites);
	parts.push(
		...fileFailures.map((name) =>
			testcaseXml(name, "fail").replace(/^\t\t/, "\t"),
		),
	);
	if (summary) {
		const total = suites.reduce((sum, block) => {
			const declared = block.match(/tests="(\d+)"/);
			return sum + (declared === null ? 0 : Number(declared[1]));
		}, 0);
		parts.push(`\t<!-- tests ${total} -->`);
	}
	parts.push("</testsuites>");
	return parts.join("\n");
}

/** The shape a healthy tui run reports: suites that run, a few individual skips. */
function healthyReport() {
	return reportXml([
		suiteXml("editor", ["pass", "pass", "pass", "pass"]),
		suiteXml("stdin-buffer", ["pass", "pass", "skip"]),
		suiteXml("keys", ["pass", "pass", "pass"]),
	]);
}

/** The CI false green: every suite describe.skips, the total still looks healthy. */
function falseGreenReport() {
	return reportXml([
		suiteXml("editor", ["skip", "skip", "skip"]),
		suiteXml("stdin-buffer", ["skip", "skip"]),
		suiteXml("keys", ["skip", "skip", "skip"]),
	]);
}

/** A job that carries one deliberate all-skipped suite, everything else runs. */
function deliberateSkipsReport() {
	return reportXml([suiteXml("editor", ["skip", "skip"]), suiteXml("keys", ["pass", "pass", "pass"])]);
}

/** A run where one test file failed to load: one failing top-level testcase. */
function fileFailureReport() {
	return reportXml([suiteXml("keys", ["pass", "pass", "pass"])], { fileFailures: ["editor.test.ts"] });
}

/** A report whose summary comment disagrees with what the parser counts. */
function driftingSummaryReport() {
	const raw = healthyReport().replace("<!-- tests 10 -->", "<!-- tests 41 -->");
	return raw;
}

/** Hand-written junit body: `<testsuites>`, the given lines, then the runner's own summary comments. */
function rawReport(lines, summary) {
	const comments = Object.entries(summary).map(([key, value]) => `\t<!-- ${key} ${value} -->`);
	return ['<?xml version="1.0" encoding="utf-8"?>', "<testsuites>", ...lines, ...comments, "</testsuites>"].join("\n");
}

const passLine = (name, depth = 2) => `${"\t".repeat(depth)}<testcase name="${name}" time="0.0001" classname="test"/>`;
const skipLine = (name, depth = 2, type = "skipped") =>
	`${"\t".repeat(depth)}<testcase name="${name}" time="0.0001" classname="test">\n${"\t".repeat(depth + 1)}<skipped type="${type}" message="true"/>\n${"\t".repeat(depth)}</testcase>`;
const openSuite = (name, depth = 1) => `${"\t".repeat(depth)}<testsuite name="${name}" time="0.001" tests="0" failures="0" skipped="0">`;
const closeSuite = (depth = 1) => `${"\t".repeat(depth)}</testsuite>`;

/** Two testcases with a nested describe between them: the one after the nested suite is a sibling. */
function nestedSuiteReport() {
	return rawReport(
		[openSuite("outer"), passLine("case A"), openSuite("inner", 2), passLine("case B", 3), closeSuite(2), passLine("case C"), closeSuite()],
		{ tests: 3 },
	);
}

/** A `describe(..., { skip })` is one skipped testcase that the runner leaves out of `tests`. */
function skippedDescribeReport() {
	return rawReport(
		[openSuite("outer"), passLine("case A"), passLine("case B"), skipLine("skipped describe"), closeSuite()],
		{ tests: 2, skipped: 0, todo: 0 },
	);
}

/** An `it.skip` is counted by the runner in both `tests` and `skipped`. */
function countedSkipReport() {
	return rawReport(
		[openSuite("outer"), passLine("case A"), passLine("case B"), skipLine("case C"), closeSuite()],
		{ tests: 3, skipped: 1, todo: 0 },
	);
}

/** A passing suite that nests a suite whose every test is skipped. */
function nestedNothingSuiteReport() {
	return rawReport(
		[openSuite("outer"), passLine("case A"), openSuite("inner", 2), skipLine("case B", 3), skipLine("case C", 3), closeSuite(2), closeSuite()],
		{ tests: 3, skipped: 2, todo: 0 },
	);
}

/** Copied from a real `node --test` junit run (node 22) over a file with every one of those shapes. */
function nodeEmittedReport() {
	return rawReport(
		[
			openSuite("outer"),
			passLine("a"),
			openSuite("inner", 2),
			passLine("b", 3),
			closeSuite(2),
			passLine("c"),
			skipLine("skipped one"),
			skipLine("todo one", 2, "todo"),
			skipLine("skipped describe"),
			closeSuite(),
			passLine("top-level pass", 1),
			skipLine("top todo", 1, "todo"),
		],
		{ tests: 7, pass: 4, fail: 0, cancelled: 0, skipped: 1, todo: 2 },
	);
}

function runSelfTest() {
	const dir = mkdtempSync(join(tmpdir(), "node-test-coverage-selftest-"));
	const controls = [];
	try {
		const planted = (report, label, options = {}) => decide(inspectReport(report, label), limitsFrom(options));
		const suiteCount = (report) => {
			const inspection = inspectReport(report, "count");
			return inspection.totalTests;
		};

		controls.push({
			name: "healthy run passes",
			expectPass: true,
			run: () => planted(healthyReport(), "healthy", { minTests: 8, minRanTests: 9 }),
		});
		controls.push({
			name: "all-skipped suites fail even with a healthy total",
			expectPass: false,
			run: () => planted(falseGreenReport(), "false-green", { minTests: 8 }),
		});
		controls.push({
			name: "a collapsed collection fails on the --min-tests floor",
			expectPass: false,
			run: () => planted(reportXml([suiteXml("keys", ["pass"])]), "collapsed", { minTests: 8 }),
		});
		controls.push({
			name: "an empty report fails",
			expectPass: false,
			run: () => planted('<?xml version="1.0"?><testsuites></testsuites>', "empty"),
		});
		controls.push({
			name: "individual skips inside a running suite pass",
			expectPass: true,
			run: () => planted(healthyReport(), "partial-skips", { minTests: 10, minRanTests: 9 }),
		});
		controls.push({
			name: "--min-ran-tests fails a job that collected tests it never ran",
			expectPass: false,
			run: () => planted(falseGreenReport(), "collected-but-skipped", { minTests: 8, minRanTests: 8 }),
		});
		controls.push({
			name: "deliberate skips pass inside their --max-nothing-suites budget",
			expectPass: true,
			run: () => planted(deliberateSkipsReport(), "budgeted", { minTests: 5, minRanTests: 3, maxNothingSuites: 1 }),
		});
		controls.push({
			name: "one suite over the --max-nothing-suites budget fails",
			expectPass: false,
			run: () => planted(deliberateSkipsReport(), "budgeted", { minTests: 5, maxNothingSuites: 0 }),
		});
		controls.push({
			name: "a test file that failed to load fails and is named",
			expectPass: false,
			run: () => planted(fileFailureReport(), "file-failure", { minTests: 4 }),
		});
		controls.push({
			name: "a summary comment the parser disagrees with fails",
			expectPass: false,
			run: () => planted(driftingSummaryReport(), "drift", { minTests: 8 }),
		});
		controls.push({
			name: "the floors and the budget parse in both spellings",
			expectPass: true,
			run: () => {
				const spaced = parseArgs(["--min-tests", "5", "--min-ran-tests", "4", "--max-nothing-suites", "3", "r.xml"]);
				const inline = parseArgs(["--min-tests=5", "--min-ran-tests=4", "--max-nothing-suites=3", "r.xml"]);
				const shape = (options) =>
					`${options.minTests}/${options.minRanTests}/${options.maxNothingSuites}/${options.reports.length}`;
				return shape(spaced) === "5/4/3/1" && shape(inline) === "5/4/3/1"
					? []
					: [`parsed "${shape(spaced)}" and "${shape(inline)}", expected 5/4/3/1`];
			},
		});
		controls.push({
			name: "a non-numeric floor is a usage error, not a silent default",
			expectPass: true,
			run: () => {
				const outcomes = ["--min-tests", "--min-ran-tests", "--max-nothing-suites"].map((flag) => {
					try {
						parseArgs([`${flag}=abc`]);
						return `${flag} accepted "abc"`;
					} catch (error) {
						return error instanceof UsageError ? "" : `${flag} threw ${error}`;
					}
				});
				const wrong = outcomes.filter(Boolean);
				return wrong.length === 0 ? [] : wrong;
			},
		});
		controls.push({
			name: "a report with no summary comment is judged from its elements",
			expectPass: true,
			run: () => planted(reportXml([suiteXml("keys", ["pass", "pass"])], { summary: false }), "no-summary", { minTests: 2 }),
		});

		controls.push({
			name: "nested suites: a testcase after a nested suite is counted",
			expectPass: true,
			run: () => planted(nestedSuiteReport(), "nested", { minTests: 3, minRanTests: 3 }),
		});
		controls.push({
			name: "a skipped describe the runner does not count",
			expectPass: true,
			run: () => planted(skippedDescribeReport(), "skipped-describe", { minTests: 2, minRanTests: 2 }),
		});
		controls.push({
			name: "an it.skip the runner does count is not discounted",
			expectPass: true,
			run: () => planted(countedSkipReport(), "counted-skip", { minTests: 3, minRanTests: 2 }),
		});
		controls.push({
			name: "an it.skip the summary counted that the parser lost still fails",
			expectPass: false,
			run: () => planted(countedSkipReport().replace("tests 3", "tests 4"), "lost-case", { minTests: 3 }),
		});
		controls.push({
			name: "nested all-skipped inner suite is still a nothing-suite",
			expectPass: false,
			run: () => planted(nestedNothingSuiteReport(), "nested-nothing", { minTests: 3, maxNothingSuites: 0 }),
		});
		controls.push({
			name: "the shape node --test itself emits: nesting, skipped describe, todo, top-level tests",
			expectPass: true,
			run: () => planted(nodeEmittedReport(), "node-shape", { minTests: 7, minRanTests: 4, maxNothingSuites: 0 }),
		});

		const write = (name, report) => {
			const path = join(dir, name);
			writeFileSync(path, report, "utf8");
			return path;
		};
		controls.push({
			name: "reading a report from disk behaves like the in-memory one",
			expectPass: false,
			run: () => checkFile(write("false-green.xml", falseGreenReport()), limitsFrom({ minTests: 8 })).failures,
		});
		controls.push({
			name: "a missing report file fails",
			expectPass: false,
			run: () => checkFile(join(dir, "absent.xml"), limitsFrom({})).failures,
		});
		controls.push({
			name: "a malformed report file fails",
			expectPass: false,
			run: () => {
				const path = join(dir, "malformed.xml");
				writeFileSync(path, "{ not xml", "utf8");
				return checkFile(path, limitsFrom({})).failures;
			},
		});
		controls.push({
			name: "the on-disk healthy report passes",
			expectPass: true,
			run: () => checkFile(write("healthy.xml", healthyReport()), limitsFrom({ minTests: 8, minRanTests: 9 })).failures,
		});

		let mismatches = 0;
		for (const control of controls) {
			let failures;
			let threw;
			try {
				failures = control.run();
			} catch (error) {
				threw = error;
			}
			const passed = threw === undefined && (control.expectPass ? failures.length === 0 : failures.length > 0);
			if (!passed) mismatches += 1;
			const detail = threw ? `threw ${threw.message}` : `${failures.length} failure(s)`;
			console.log(
				`${passed ? "ok  " : "FAIL"} ${control.name} (expected ${control.expectPass ? "green" : "red"}, got ${detail})`,
			);
			if (!passed && failures?.length) for (const failure of failures) console.log(`       ${failure}`);
		}
		console.log(`self-test: ${controls.length} controls, ${mismatches} mismatch(es)`);
		return mismatches === 0 ? 0 : 1;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function main(argv) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(error instanceof UsageError ? error.message : String(error));
		return 2;
	}
	if (options.selfTest) return runSelfTest();
	if (options.reports.length === 0) {
		console.error(
			"usage: check-node-test-coverage.mjs <node-test-junit-report.xml> [...] " +
				"[--min-tests N] [--min-ran-tests N] [--max-nothing-suites M] | --self-test",
		);
		return 2;
	}
	const limits = limitsFrom(options);
	const failures = [];
	let collected = 0;
	let ran = 0;
	let nothingSuites = 0;
	for (const report of options.reports) {
		const result = checkFile(report, limits);
		console.log(result.text);
		if (result.inspection) {
			collected += result.inspection.totalTests;
			ran += result.inspection.ran;
			nothingSuites += result.inspection.nothingSuites;
		}
		failures.push(...result.failures);
	}
	const parameters = `--min-tests ${limits.minTests}, --min-ran-tests ${limits.minRanTests}, --max-nothing-suites ${limits.maxNothingSuites}`;
	const summary = `${options.reports.length} report(s), counted ${collected} tests, ran ${ran}, nothing-suites ${nothingSuites}`;
	if (failures.length > 0) {
		console.error(`node --test coverage gate: RED (${failures.length} problem(s), ${parameters})`);
		for (const failure of failures) console.error(`  - ${failure}`);
		console.error(
			"A suite that ran nothing skipped every test it collected, or a file failed before its tests " +
				"ran. Fix the resolution so those tests run; if the skip is deliberate, record it by raising " +
				"--max-nothing-suites for that job in .github/workflows/ci.yml with a reason.",
		);
		return 1;
	}
	console.log(`node --test coverage gate: GREEN (${parameters}; ${summary})`);
	return 0;
}

process.exit(main(process.argv.slice(2)));
