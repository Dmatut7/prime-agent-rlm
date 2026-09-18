#!/usr/bin/env node
/**
 * Anti-false-green gate for one vitest job's JSON report.
 *
 * Why this exists
 * ---------------
 * A file whose tests never run is not a failure to vitest: a `describe.skip` shape (no interpreter,
 * no service, a filter that no longer selects anything) reports as `skipped` and the run exits 0.
 * A job can therefore lose a whole face of coverage while the report and the job stay green. This
 * gate fails on the shapes that hide it:
 *
 *   - tests that ran fewer than `--min-ran-tests` (a job whose tests are collected and then
 *     skipped still reports a healthy total),
 *   - files that ran nothing (`skipped`/`pending`/`todo` for every test in them), beyond a
 *     per-job budget of deliberate skips (`--max-nothing-files`),
 *   - files that collected zero tests at all, and
 *   - a total below `--min-tests`, i.e. a suite that silently stopped collecting.
 *
 * Every vitest job in `.github/workflows/ci.yml` runs this against its own JSON report with its
 * own parameters. The budget is what separates "this job knows these files skip here" (the ai
 * package's live provider files are opt-in, for example) from "a file started skipping without
 * anyone noticing": the count is pinned to the value the job's environment actually produces, so
 * one more skipping file is a red report that names the file.
 *
 * Where the floors come from
 * --------------------------
 * The floors in `.github/workflows/ci.yml` are a policy, and the policy is "90% of what the job
 * really produces in CI": high enough that a face disappearing reddens the job, low enough that
 * ordinary test churn does not. Written down without a reading behind it, that sentence rotted -
 * the floors in the matrix sat at 64%-87% of what the jobs actually produced, so the policy and
 * the numbers disagreed in the direction that hides losses. `--recompute-floors` is the mechanical
 * half of the fix: point it at a real report and it prints the floors the policy asks for, the
 * ratio the floors currently in `ci.yml` really are, and a paste-ready row for
 * `scripts/ci-floor-readings.json` (the file that records which run the floors were derived from,
 * and that `packages/coding-agent/test/ci-floor-policy.test.ts` pins `ci.yml` against).
 *
 * Usage
 * -----
 *   node scripts/check-vitest-coverage.mjs <report.json> [...] \
 *     [--min-tests N] [--min-ran-tests N] [--max-nothing-files M]
 *   node scripts/check-vitest-coverage.mjs --recompute-floors <report.json> [...] \
 *     [--floor-ratio 0.9] [--row "<matrix row name>"] [--ci-yml <path>]
 *   node scripts/check-vitest-coverage.mjs --self-test
 *
 * `--min-tests` defaults to 30, and `--min-ran-tests` / `--max-nothing-files` to 0 (off).
 * `--floor-ratio` defaults to 0.9 and only applies to `--recompute-floors`.
 * Exit codes: 0 = gate green (or floors printed), 1 = gate red, 2 = usage/unreadable report.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Test statuses that mean "this test never ran". */
const NOT_RUN_STATUSES = new Set(["skipped", "pending", "todo"]);
const DEFAULT_MIN_TESTS = 30;
/** The floor policy: a floor is this share of what the job really produced, rounded up. */
const DEFAULT_FLOOR_RATIO = 0.9;

class UsageError extends Error {}

function parseIntegerOption(raw, flag, { minimum }) {
	const text = (raw ?? "").trim();
	const value = Number.parseInt(text, 10);
	if (!Number.isInteger(value) || value < minimum || String(value) !== text) {
		throw new UsageError(`${flag} needs an integer >= ${minimum}, got "${raw ?? ""}"`);
	}
	return value;
}

function parseRatioOption(raw, flag) {
	const text = (raw ?? "").trim();
	const value = Number.parseFloat(text);
	if (!Number.isFinite(value) || value <= 0 || value > 1 || String(value) !== text) {
		throw new UsageError(`${flag} needs a number in (0, 1], got "${raw ?? ""}"`);
	}
	return value;
}

function parseArgs(argv) {
	const options = {
		reports: [],
		minTests: DEFAULT_MIN_TESTS,
		minRanTests: 0,
		maxNothingFiles: 0,
		selfTest: false,
		recomputeFloors: false,
		floorRatio: DEFAULT_FLOOR_RATIO,
		row: "",
		ciYml: "",
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--self-test") {
			options.selfTest = true;
			continue;
		}
		if (arg === "--recompute-floors") {
			options.recomputeFloors = true;
			continue;
		}
		if (arg === "--floor-ratio") {
			options.floorRatio = parseRatioOption(argv[++index], "--floor-ratio");
			continue;
		}
		if (arg.startsWith("--floor-ratio=")) {
			options.floorRatio = parseRatioOption(arg.slice("--floor-ratio=".length), "--floor-ratio");
			continue;
		}
		if (arg === "--row") {
			options.row = argv[++index] ?? "";
			if (options.row === "") throw new UsageError("--row needs the matrix row name");
			continue;
		}
		if (arg.startsWith("--row=")) {
			options.row = arg.slice("--row=".length);
			continue;
		}
		if (arg === "--ci-yml") {
			options.ciYml = argv[++index] ?? "";
			if (options.ciYml === "") throw new UsageError("--ci-yml needs a path");
			continue;
		}
		if (arg.startsWith("--ci-yml=")) {
			options.ciYml = arg.slice("--ci-yml=".length);
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
			options.minRanTests = parseIntegerOption(arg.slice("--min-ran-tests=".length), "--min-ran-tests", { minimum: 1 });
			continue;
		}
		if (arg === "--max-nothing-files") {
			options.maxNothingFiles = parseIntegerOption(argv[++index], "--max-nothing-files", { minimum: 0 });
			continue;
		}
		if (arg.startsWith("--max-nothing-files=")) {
			options.maxNothingFiles = parseIntegerOption(arg.slice("--max-nothing-files=".length), "--max-nothing-files", { minimum: 0 });
			continue;
		}
		if (typeof arg === "string" && arg.startsWith("-")) throw new UsageError(`unknown option "${arg}"`);
		options.reports.push(arg);
	}
	return options;
}

/** One vitest JSON report, reduced to what the gate judges. */
function inspectReport(report, label) {
	const testResults = Array.isArray(report?.testResults) ? report.testResults : [];
	const files = testResults.map((entry) => {
		const assertions = Array.isArray(entry?.assertionResults) ? entry.assertionResults : [];
		const counts = { passed: 0, failed: 0, notRun: 0 };
		for (const assertion of assertions) {
			const status = assertion?.status;
			if (NOT_RUN_STATUSES.has(status)) counts.notRun += 1;
			else if (status === "passed") counts.passed += 1;
			else counts.failed += 1;
		}
		const total = assertions.length;
		return {
			name: relativeName(typeof entry?.name === "string" ? entry.name : "?"),
			total,
			counts,
			allNotRun: total > 0 && counts.notRun === total,
			collectedNothing: total === 0,
		};
	});
	const totalTests =
		typeof report?.numTotalTests === "number" ? report.numTotalTests : files.reduce((sum, file) => sum + file.total, 0);
	const ran = files.reduce((sum, file) => sum + file.counts.passed + file.counts.failed, 0);
	return {
		label,
		totalTests,
		ran,
		nothingFiles: files.filter((file) => file.allNotRun).length,
		files,
	};
}

function relativeName(name) {
	const marker = "/packages/";
	const at = name.lastIndexOf(marker);
	return at === -1 ? name : name.slice(at + 1);
}

/** The failures this report carries; empty means the gate is green for it. */
/** What one job's report is judged against: the two floors and the deliberate-skip budget. */
function limitsFrom(options) {
	return {
		minTests: options.minTests ?? DEFAULT_MIN_TESTS,
		minRanTests: options.minRanTests ?? 0,
		maxNothingFiles: options.maxNothingFiles ?? 0,
	};
}

function decide(inspection, limits) {
	const failures = [];
	if (inspection.files.length === 0) {
		failures.push(`${inspection.label}: the report lists no test files at all (nothing was collected)`);
	}
	if (inspection.totalTests < limits.minTests) {
		failures.push(
			`${inspection.label}: numTotalTests=${inspection.totalTests} is below the --min-tests floor of ${limits.minTests}`,
		);
	}
	if (inspection.ran < limits.minRanTests) {
		failures.push(
			`${inspection.label}: only ${inspection.ran} test(s) ran (the rest were skipped or never collected), ` +
				`below the --min-ran-tests floor of ${limits.minRanTests}`,
		);
	}
	const allNotRun = inspection.files.filter((file) => file.allNotRun);
	if (allNotRun.length > limits.maxNothingFiles) {
		failures.push(
			`${inspection.label}: ${allNotRun.length} file(s) ran nothing (describe.skip shape), over the ` +
				`--max-nothing-files budget of ${limits.maxNothingFiles}: ${allNotRun
					.map((file) => `${file.name} (${file.total} skipped)`)
					.join(", ")}`,
		);
	}
	const empty = inspection.files.filter((file) => file.collectedNothing);
	if (empty.length > 0) {
		failures.push(
			`${inspection.label}: ${empty.length} file(s) collected zero tests: ${empty.map((file) => file.name).join(", ")}`,
		);
	}
	return failures;
}

function formatInspection(inspection) {
	const lines = [
		`### ${inspection.label}: numTotalTests=${inspection.totalTests} ran=${inspection.ran} ` +
			`files=${inspection.files.length} nothing-files=${inspection.nothingFiles}`,
	];
	for (const file of [...inspection.files].sort((a, b) => a.name.localeCompare(b.name))) {
		const flag = file.allNotRun ? "  <== ALL SKIPPED (false-green shape)" : file.collectedNothing ? "  <== COLLECTED NOTHING" : "";
		lines.push(
			`    ${file.name}: n=${file.total} passed=${file.counts.passed} failed=${file.counts.failed} skipped=${file.counts.notRun}${flag}`,
		);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// --recompute-floors: turn a real report into the floors the policy asks for
// ---------------------------------------------------------------------------

/**
 * `ceil(value * ratio)` without binary-float surprises: `Math.ceil(10 * 0.9)` is 10, not 9,
 * because 10 * 0.9 is 9.000000000000002. Scaling the ratio to an integer per-mille keeps the
 * multiplication exact, and IEEE division is exact whenever the true quotient is an integer.
 */
export function ceilRatio(value, ratio) {
	const perMille = Math.round(ratio * 1000);
	if (!Number.isInteger(value) || value < 0) throw new UsageError(`ceilRatio needs a non-negative integer, got ${value}`);
	return Math.ceil((value * perMille) / 1000);
}

/** The floors `--floor-ratio` asks for, given what a report really produced. */
export function suggestFloors(inspection, ratio) {
	return {
		minTests: ceilRatio(inspection.totalTests, ratio),
		minRanTests: ceilRatio(inspection.ran, ratio),
		observedNothingFiles: inspection.nothingFiles,
	};
}

/**
 * Read one matrix row's floors straight out of `ci.yml` text. No YAML dependency here on
 * purpose: `scripts/` runs from a bare checkout, and this reader is advisory (the pin in
 * packages/coding-agent/test/ci-floor-policy.test.ts parses the workflow properly). A row is the
 * `- name: <row>` item plus every more-indented line after it, so a comment inside the row is
 * skipped and the next row ends the scan.
 */
export function scanCiRow(ciYmlText, rowName) {
	const lines = ciYmlText.split("\n");
	const itemPattern = /^(\s*)-\s+name:\s*(.+?)\s*$/;
	for (let index = 0; index < lines.length; index += 1) {
		const item = itemPattern.exec(lines[index]);
		if (!item || item[2] !== rowName) continue;
		const indent = item[1].length;
		const row = { name: rowName, line: index + 1 };
		for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
			const line = lines[cursor];
			if (line.trim() === "") continue;
			if (line.length - line.trimStart().length <= indent) break;
			const field = /^\s*([a-z_]+):\s*(.*)$/.exec(line);
			if (!field) continue;
			const [, key, raw] = field;
			if (raw.startsWith("#") || raw === "") continue;
			row[key] = /^-?\d+$/.test(raw) ? Number.parseInt(raw, 10) : raw.replace(/^['"]|['"]$/g, "");
		}
		return row;
	}
	return undefined;
}

function defaultCiYmlPath() {
	return join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "ci.yml");
}

function runRecompute(options) {
	if (options.reports.length === 0) {
		console.error("--recompute-floors needs at least one vitest JSON report to read");
		return 2;
	}
	const ratio = options.floorRatio;
	const ciYmlPath = options.ciYml === "" ? defaultCiYmlPath() : options.ciYml;
	let ciYmlText = "";
	if (options.row !== "") {
		try {
			ciYmlText = readFileSync(ciYmlPath, "utf8");
		} catch (error) {
			console.error(`cannot read the workflow at ${ciYmlPath}: ${error.message}`);
			return 2;
		}
	}
	let unreadable = 0;
	for (const report of options.reports) {
		const result = checkFile(report, { minTests: 1, minRanTests: 0, maxNothingFiles: Number.MAX_SAFE_INTEGER });
		if (!result.inspection) {
			unreadable += 1;
			console.error(result.failures.map((failure) => `  - ${failure}`).join("\n"));
			continue;
		}
		const inspection = result.inspection;
		const suggested = suggestFloors(inspection, ratio);
		const percent = (floor, actual) => (actual === 0 ? "n/a" : `${((100 * floor) / actual).toFixed(1)}%`);
		console.log(`### ${report}: collected=${inspection.totalTests} ran=${inspection.ran} files=${inspection.files.length} nothing-files=${inspection.nothingFiles}`);
		console.log(
			`    suggested floors at --floor-ratio ${ratio}: --min-tests ${suggested.minTests} ` +
				`--min-ran-tests ${suggested.minRanTests} (nothing-files observed: ${suggested.observedNothingFiles})`,
		);
		if (suggested.observedNothingFiles > 0) {
			const names = inspection.files
				.filter((file) => file.allNotRun)
				.map((file) => file.name)
				.join(", ");
			console.log(
				`    WARNING: ${suggested.observedNothingFiles} file(s) ran nothing in this report (${names}). ` +
					"The suggested --min-ran-tests is only as honest as this run: confirm those files are the job's " +
					"declared --max-nothing-files budget (or fix why they skip) before pasting the floor.",
			);
		}
		if (inspection.ran === 0) {
			console.log(
				"    WARNING: nothing ran in this report, so the suggested --min-ran-tests is 0. A floor of 0 gates " +
					"nothing; this is a broken run, not a new baseline.",
			);
		}
		if (options.row !== "") {
			const row = scanCiRow(ciYmlText, options.row);
			if (!row) {
				console.error(`no matrix row named "${options.row}" in ${ciYmlPath}`);
				return 2;
			}
			const currentTests = typeof row.min_tests === "number" ? row.min_tests : undefined;
			const currentRan = typeof row.min_ran_tests === "number" ? row.min_ran_tests : undefined;
			if (currentTests === undefined || currentRan === undefined) {
				console.error(`the matrix row "${options.row}" (${ciYmlPath}:${row.line}) carries no numeric min_tests/min_ran_tests`);
				return 2;
			}
			const stale = currentTests < suggested.minTests || currentRan < suggested.minRanTests;
			console.log(
				`    ${ciYmlPath}:${row.line} row "${options.row}": current --min-tests ${currentTests} ` +
					`(${percent(currentTests, inspection.totalTests)} of collected), --min-ran-tests ${currentRan} ` +
					`(${percent(currentRan, inspection.ran)} of ran) => ${stale ? "STALE: below the suggested floors" : "at or above the suggested floors"}`,
			);
			console.log(
				`    paste-ready reading for scripts/ci-floor-readings.json: ` +
					JSON.stringify({
						name: options.row,
						report: report.replaceAll("\\", "/"),
						collected: inspection.totalTests,
						ran: inspection.ran,
						files: inspection.files.length,
						nothing_files: inspection.nothingFiles,
					}),
			);
		}
	}
	if (unreadable > 0) {
		console.error(`recompute: ${unreadable} report(s) could not be read`);
		return 1;
	}
	console.log(
		`recompute: ${options.reports.length} report(s) at --floor-ratio ${ratio} ` +
			"(ceil(ratio * reading)); after changing a floor, record the run it came from in " +
			"scripts/ci-floor-readings.json - packages/coding-agent/test/ci-floor-policy.test.ts pins ci.yml to it.",
	);
	return 0;
}

function checkFile(path, limits) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return { failures: [`cannot read the vitest JSON report at ${path}: ${error.message}`], text: `### ${path}: unreadable` };
	}
	let report;
	try {
		report = JSON.parse(raw);
	} catch (error) {
		return { failures: [`${path} is not valid JSON: ${error.message}`], text: `### ${path}: not JSON` };
	}
	const inspection = inspectReport(report, path);
	return { failures: decide(inspection, limits), inspection, text: formatInspection(inspection) };
}

// ---------------------------------------------------------------------------
// self-test: planted reports must turn the gate red, a healthy one must not
// ---------------------------------------------------------------------------

function assertion(status, title) {
	return { ancestorTitles: [], fullName: title, status, title, duration: 1, failureMessages: [] };
}

function plantedReport(files) {
	const testResults = files.map(([name, statuses]) => ({
		name,
		status: statuses.every((status) => NOT_RUN_STATUSES.has(status)) ? "skipped" : "passed",
		message: "",
		assertionResults: statuses.map((status, index) => assertion(status, `${name} test ${index}`)),
	}));
	return {
		numTotalTests: testResults.reduce((sum, entry) => sum + entry.assertionResults.length, 0),
		numPassedTests: testResults.reduce(
			(sum, entry) => sum + entry.assertionResults.filter((a) => a.status === "passed").length,
			0,
		),
		numFailedTests: 0,
		numPendingTests: 0,
		numTodoTests: 0,
		testResults,
	};
}

/** The shape a healthy pinned kernel run reports: 13 files, 36 tests, three individual skips. */
function healthyReport() {
	const files = [];
	for (let index = 0; index < 11; index += 1) {
		files.push([`/ci/packages/coding-agent/test/repl-kernel-${index}.test.ts`, ["passed", "passed", "passed"]]);
	}
	files.push(["/ci/packages/coding-agent/test/repl-kernel-pipe-errors.test.ts", ["passed", "passed", "passed", "skipped"]]);
	files.push(["/ci/packages/coding-agent/test/acp-cold-cli.test.ts", ["passed"]]);
	return plantedReport(files);
}

/** The CI false green: every gated file describe.skips, the total still looks healthy. */
function falseGreenReport() {
	const files = [];
	for (let index = 0; index < 11; index += 1) {
		files.push([`/ci/packages/coding-agent/test/repl-kernel-${index}.test.ts`, ["skipped", "skipped", "skipped"]]);
	}
	files.push(["/ci/packages/coding-agent/test/acp-kernel-features.test.ts", ["passed", "passed", "passed", "passed"]]);
	files.push(["/ci/packages/coding-agent/test/kernel-goal-skill.test.ts", ["passed", "passed", "passed"]]);
	return plantedReport(files);
}

/** A job that carries deliberate skips: two files never run, everything else does. */
function deliberateSkipsReport() {
	return plantedReport([
		["/ci/packages/ai/test/stream.test.ts", ["skipped", "skipped"]],
		["/ci/packages/ai/test/context-overflow.test.ts", ["skipped", "skipped"]],
		["/ci/packages/ai/test/anthropic-thinking-disable.test.ts", ["passed", "passed", "passed"]],
	]);
}

function runSelfTest() {
	const dir = mkdtempSync(join(tmpdir(), "vitest-coverage-selftest-"));
	const controls = [];
	try {
		const write = (name, report, raw) => {
			const path = join(dir, name);
			writeFileSync(path, raw !== undefined ? raw : JSON.stringify(report), "utf8");
			return path;
		};
		const planted = (report, label, options = {}) => decide(inspectReport(report, label), limitsFrom(options));
		const skips = (count) => Array.from({ length: count }, () => "skipped");
		const passing = (count) => Array.from({ length: count }, () => "passed");

		controls.push({
			name: "healthy run passes",
			expectPass: true,
			run: () => planted(healthyReport(), "healthy"),
		});
		controls.push({
			name: "all-skipped files fail even with a healthy total",
			expectPass: false,
			run: () => planted(falseGreenReport(), "false-green"),
		});
		controls.push({
			name: "a collapsed collection fails on the --min-tests floor",
			expectPass: false,
			run: () => planted(plantedReport([["/ci/packages/coding-agent/test/acp-cold-cli.test.ts", ["passed"]]]), "collapsed"),
		});
		controls.push({
			name: "an empty report fails",
			expectPass: false,
			run: () => planted({ numTotalTests: 0, testResults: [] }, "empty"),
		});
		controls.push({
			name: "a file that collected zero tests fails",
			expectPass: false,
			run: () => planted(plantedReport([["/ci/packages/coding-agent/test/empty.test.ts", []]]), "no-tests", { minTests: 1 }),
		});
		controls.push({
			name: "individual skips inside a running file pass",
			expectPass: true,
			run: () =>
				planted(
					plantedReport([
						["/ci/packages/coding-agent/test/a.test.ts", ["passed", "skipped"]],
						["/ci/packages/coding-agent/test/b.test.ts", ["passed", "passed"]],
					]),
					"partial-skips",
					{ minTests: 4, minRanTests: 3 },
				),
		});
		controls.push({
			name: "--min-tests is honoured from the command line",
			expectPass: false,
			run: () => planted(healthyReport(), "healthy", { minTests: 40 }),
		});
		controls.push({
			name: "a single all-skipped file fails the default budget of zero",
			expectPass: false,
			run: () => planted(plantedReport([["/ci/packages/ai/test/stream.test.ts", ["skipped"]]]), "one-skip", { minTests: 1 }),
		});
		controls.push({
			name: "deliberate skips pass inside their --max-nothing-files budget",
			expectPass: true,
			run: () => planted(deliberateSkipsReport(), "budgeted", { minTests: 7, minRanTests: 3, maxNothingFiles: 2 }),
		});
		controls.push({
			name: "one file over the --max-nothing-files budget fails",
			expectPass: false,
			run: () => planted(deliberateSkipsReport(), "budgeted", { minTests: 7, maxNothingFiles: 1 }),
		});
		controls.push({
			name: "--min-ran-tests fails a job that collected tests it never ran",
			expectPass: false,
			run: () =>
				planted(
					plantedReport([
						["/ci/packages/ai/test/stream.test.ts", skips(40)],
						["/ci/packages/ai/test/anthropic-thinking-disable.test.ts", ["passed", "passed"]],
					]),
					"collected-but-skipped",
					{ minTests: 30, minRanTests: 10, maxNothingFiles: 1 },
				),
		});
		controls.push({
			name: "--min-ran-tests passes a job that really ran them",
			expectPass: true,
			run: () =>
				planted(
					plantedReport([
						["/ci/packages/ai/test/stream.test.ts", skips(40)],
						["/ci/packages/ai/test/anthropic-thinking-disable.test.ts", passing(12)],
					]),
					"collected-and-ran",
					{ minTests: 30, minRanTests: 12, maxNothingFiles: 1 },
				),
		});
		controls.push({
			name: "the floors and the budget parse in both spellings",
			expectPass: true,
			run: () => {
				const spaced = parseArgs(["--min-tests", "5", "--min-ran-tests", "4", "--max-nothing-files", "3", "r.json"]);
				const inline = parseArgs(["--min-tests=5", "--min-ran-tests=4", "--max-nothing-files=3", "r.json"]);
				const shape = (options) => `${options.minTests}/${options.minRanTests}/${options.maxNothingFiles}/${options.reports.length}`;
				return shape(spaced) === "5/4/3/1" && shape(inline) === "5/4/3/1"
					? []
					: [`parsed "${shape(spaced)}" and "${shape(inline)}", expected 5/4/3/1`];
			},
		});
		controls.push({
			name: "a non-numeric floor is a usage error, not a silent default",
			expectPass: true,
			run: () => {
				const outcomes = ["--min-tests", "--min-ran-tests", "--max-nothing-files"].map((flag) => {
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

		// --recompute-floors: the arithmetic, the workflow reader and the end-to-end exit codes.
		const recomputeControls = (report, label, ratio) => suggestFloors(inspectReport(report, label), ratio);
		const plantedCiYml = [
			"    strategy:",
			"      matrix:",
			"        include:",
			"          - name: agent-core",
			"            package: packages/agent",
			"            min_tests: 79",
			"            min_ran_tests: 79",
			"            max_nothing_files: 0",
			"          - name: coding-agent process smoke",
			"            package: packages/coding-agent",
			"            # a comment inside the row must not end it",
			"            min_tests: 20",
			"            min_ran_tests: 11",
			"            max_nothing_files: 1",
			"            tag_skip_ledger: 'a.test.ts=8:reason;;b.test.ts=4:reason'",
			"          - name: ai",
			"            min_tests: 1062",
			"            min_ran_tests: 412",
			"            max_nothing_files: 19",
			"    steps:",
			"      - name: Test",
		].join("\n");
		const ciYmlPath = write("planted-ci.yml", undefined, plantedCiYml);
		const smokePath = write(
			"planted-process-smoke.json",
			plantedReport([
				["/ci/packages/coding-agent/test/daemon-supervisor-process.test.ts", [...passing(12), ...skips(8)]],
				["/ci/packages/coding-agent/test/daemon-supervisor-crash-handlers-process.test.ts", skips(4)],
			]),
		);
		/** Run main() with stdout/stderr captured, so the self-test stays readable. */
		const captured = (argv) => {
			const lines = [];
			const log = console.log;
			const error = console.error;
			console.log = (...args) => lines.push(args.join(" "));
			console.error = (...args) => lines.push(args.join(" "));
			let code;
			try {
				code = main(argv);
			} finally {
				console.log = log;
				console.error = error;
			}
			return { code, text: lines.join("\n") };
		};

		controls.push({
			name: "the floor arithmetic is ceil(ratio * reading), exact products included",
			expectPass: true,
			run: () => {
				const cases = [
					[10, 0.9, 9],
					[24, 0.9, 22],
					[20, 0.9, 18],
					[6, 0.9, 6],
					[1365, 0.9, 1229],
					[643, 0.9, 579],
					[0, 0.9, 0],
					[11, 0.5, 6],
				];
				const wrong = cases
					.filter(([value, ratio, want]) => ceilRatio(value, ratio) !== want)
					.map(([value, ratio, want]) => `ceilRatio(${value}, ${ratio}) = ${ceilRatio(value, ratio)}, expected ${want}`);
				return wrong;
			},
		});
		controls.push({
			name: "--recompute-floors suggests 90% of what the report really produced",
			expectPass: true,
			run: () => {
				const suggested = recomputeControls(
					plantedReport([["/ci/packages/agent/test/a.test.ts", passing(108)]]),
					"agent-core",
					0.9,
				);
				return suggested.minTests === 98 && suggested.minRanTests === 98 && suggested.observedNothingFiles === 0
					? []
					: [`suggested ${JSON.stringify(suggested)}, expected 98/98/0`];
			},
		});
		controls.push({
			name: "--floor-ratio is honoured, not hardcoded at 0.9",
			expectPass: true,
			run: () => {
				const report = plantedReport([["/ci/packages/agent/test/a.test.ts", [...passing(80), ...skips(20)]]]);
				const at90 = recomputeControls(report, "r", 0.9);
				const at50 = recomputeControls(report, "r", 0.5);
				return at90.minTests === 90 && at90.minRanTests === 72 && at50.minTests === 50 && at50.minRanTests === 40
					? []
					: [`0.9 gave ${at90.minTests}/${at90.minRanTests}, 0.5 gave ${at50.minTests}/${at50.minRanTests}`];
			},
		});
		controls.push({
			name: "a report that ran nothing suggests a ran floor of 0 (a collapse is not laundered into a baseline)",
			expectPass: true,
			run: () => {
				const suggested = recomputeControls(plantedReport([["/ci/packages/ai/test/a.test.ts", skips(40)]]), "collapsed", 0.9);
				return suggested.minRanTests === 0 && suggested.minTests === 36 && suggested.observedNothingFiles === 1
					? []
					: [`suggested ${JSON.stringify(suggested)}, expected 36/0/1`];
			},
		});
		controls.push({
			name: "the ci.yml row scanner reads one row's floors and stops at the next row",
			expectPass: true,
			run: () => {
				const smoke = scanCiRow(plantedCiYml, "coding-agent process smoke");
				const core = scanCiRow(plantedCiYml, "agent-core");
				const wrong = [];
				if (smoke?.min_tests !== 20 || smoke?.min_ran_tests !== 11 || smoke?.max_nothing_files !== 1) {
					wrong.push(`process smoke read as ${JSON.stringify(smoke)}`);
				}
				if (smoke?.tag_skip_ledger !== "a.test.ts=8:reason;;b.test.ts=4:reason") {
					wrong.push(`tag_skip_ledger read as ${JSON.stringify(smoke?.tag_skip_ledger)}`);
				}
				if (core?.min_tests !== 79 || core?.min_ran_tests !== 79) wrong.push(`agent-core read as ${JSON.stringify(core)}`);
				return wrong;
			},
		});
		controls.push({
			name: "a row name the workflow does not have is undefined, never a silent default",
			expectPass: true,
			run: () => (scanCiRow(plantedCiYml, "no such row") === undefined ? [] : ["scanCiRow invented a row"]),
		});
		controls.push({
			name: "--recompute-floors end to end: prints the floors and calls a stale row stale",
			expectPass: true,
			run: () => {
				const { code, text } = captured([
					"--recompute-floors",
					smokePath,
					"--row",
					"coding-agent process smoke",
					"--ci-yml",
					ciYmlPath,
				]);
				const wrong = [];
				if (code !== 0) wrong.push(`exit ${code}, expected 0`);
				if (!text.includes("collected=24 ran=12")) wrong.push(`no reading line in: ${text.slice(0, 200)}`);
				if (!text.includes("--min-tests 22 --min-ran-tests 11")) wrong.push("no suggested floors");
				if (!text.includes("STALE")) wrong.push("a floor at 83% of the reading was not called stale");
				if (!text.includes("WARNING")) wrong.push("a nothing-file was not warned about");
				if (!text.includes('"collected":24')) wrong.push("no paste-ready reading");
				return wrong;
			},
		});
		controls.push({
			name: "--recompute-floors refuses a row name the workflow does not have (exit 2)",
			expectPass: true,
			run: () => {
				const { code, text } = captured(["--recompute-floors", smokePath, "--row", "no such row", "--ci-yml", ciYmlPath]);
				return code === 2 && text.includes("no matrix row named") ? [] : [`exit ${code}: ${text.slice(0, 160)}`];
			},
		});
		controls.push({
			name: "--recompute-floors with no report is a usage error (exit 2)",
			expectPass: true,
			run: () => {
				const { code } = captured(["--recompute-floors"]);
				return code === 2 ? [] : [`exit ${code}, expected 2`];
			},
		});
		controls.push({
			name: "--recompute-floors on an unreadable report is red, not a suggestion (exit 1)",
			expectPass: true,
			run: () => {
				const { code, text } = captured(["--recompute-floors", join(dir, "absent.json")]);
				return code === 1 && text.includes("cannot read") ? [] : [`exit ${code}: ${text.slice(0, 160)}`];
			},
		});
		controls.push({
			name: "--floor-ratio outside (0, 1] is a usage error, not a silent default",
			expectPass: true,
			run: () => {
				const wrong = ["0", "1.5", "abc", "-0.2"]
					.map((raw) => {
						try {
							parseArgs(["--recompute-floors", `--floor-ratio=${raw}`, "r.json"]);
							return `--floor-ratio accepted "${raw}"`;
						} catch (error) {
							return error instanceof UsageError ? "" : `--floor-ratio threw ${error}`;
						}
					})
					.filter(Boolean);
				return wrong;
			},
		});

		const healthyPath = write("healthy.json", healthyReport());
		const falseGreenPath = write("false-green.json", falseGreenReport());
		controls.push({
			name: "reading a report from disk behaves like the in-memory one",
			expectPass: false,
			run: () => checkFile(falseGreenPath, limitsFrom({})).failures,
		});
		controls.push({
			name: "a missing report file fails",
			expectPass: false,
			run: () => checkFile(join(dir, "absent.json"), limitsFrom({})).failures,
		});
		controls.push({
			name: "a malformed report file fails",
			expectPass: false,
			run: () => {
				const path = join(dir, "malformed.json");
				writeFileSync(path, "{ not json", "utf8");
				return checkFile(path, limitsFrom({})).failures;
			},
		});
		controls.push({
			name: "the on-disk healthy report passes",
			expectPass: true,
			run: () => checkFile(healthyPath, limitsFrom({})).failures,
		});
		controls.push({
			name: "the on-disk report carries the budget through checkFile",
			expectPass: true,
			run: () =>
				checkFile(
					write("budgeted.json", deliberateSkipsReport()),
					limitsFrom({ minTests: 7, maxNothingFiles: 2 }),
				).failures,
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
			console.log(`${passed ? "ok  " : "FAIL"} ${control.name} (expected ${control.expectPass ? "green" : "red"}, got ${detail})`);
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
	if (options.recomputeFloors) return runRecompute(options);
	if (options.reports.length === 0) {
		console.error(
			"usage: check-vitest-coverage.mjs <vitest-json-report> [...] " +
				"[--min-tests N] [--min-ran-tests N] [--max-nothing-files M]\n" +
				"       check-vitest-coverage.mjs --recompute-floors <vitest-json-report> [...] " +
				'[--floor-ratio R] [--row "<matrix row name>"] [--ci-yml <path>]\n' +
				"       check-vitest-coverage.mjs --self-test",
		);
		return 2;
	}
	const limits = limitsFrom(options);
	const failures = [];
	let collected = 0;
	let ran = 0;
	let nothingFiles = 0;
	for (const report of options.reports) {
		const result = checkFile(report, limits);
		console.log(result.text);
		if (result.inspection) {
			collected += result.inspection.totalTests;
			ran += result.inspection.ran;
			nothingFiles += result.inspection.nothingFiles;
		}
		failures.push(...result.failures);
	}
	const parameters = `--min-tests ${limits.minTests}, --min-ran-tests ${limits.minRanTests}, --max-nothing-files ${limits.maxNothingFiles}`;
	const summary = `${options.reports.length} report(s), collected ${collected} tests, ran ${ran}, nothing-files ${nothingFiles}`;
	if (failures.length > 0) {
		console.error(`vitest coverage gate: RED (${failures.length} problem(s), ${parameters})`);
		for (const failure of failures) console.error(`  - ${failure}`);
		console.error(
			"A file that ran nothing skipped every test it collected: the environment its tests need is missing, or a " +
				"filter no longer selects them. Fix the resolution so those tests run; if the skip is deliberate, record it " +
				"by raising --max-nothing-files (or lowering the floors) for that job in .github/workflows/ci.yml with a " +
				"reason. Kernel files need a Python interpreter: seed one with " +
				"`npx tsx packages/coding-agent/src/core/kernel/bootstrap-cli.ts` (or set PRIME_AGENT_KERNEL_PYTHON) " +
				"instead of letting them skip.",
		);
		return 1;
	}
	console.log(`vitest coverage gate: GREEN (${parameters}; ${summary})`);
	return 0;
}

process.exit(main(process.argv.slice(2)));
