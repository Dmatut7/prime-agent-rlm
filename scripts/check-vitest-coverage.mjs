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
 * Usage
 * -----
 *   node scripts/check-vitest-coverage.mjs <report.json> [...] \
 *     [--min-tests N] [--min-ran-tests N] [--max-nothing-files M]
 *   node scripts/check-vitest-coverage.mjs --self-test
 *
 * `--min-tests` defaults to 30, and `--min-ran-tests` / `--max-nothing-files` to 0 (off).
 * Exit codes: 0 = gate green, 1 = gate red, 2 = usage/unreadable report.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Test statuses that mean "this test never ran". */
const NOT_RUN_STATUSES = new Set(["skipped", "pending", "todo"]);
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
	const options = { reports: [], minTests: DEFAULT_MIN_TESTS, minRanTests: 0, maxNothingFiles: 0, selfTest: false };
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
		const write = (name, report) => {
			const path = join(dir, name);
			writeFileSync(path, JSON.stringify(report), "utf8");
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
	if (options.reports.length === 0) {
		console.error(
			"usage: check-vitest-coverage.mjs <vitest-json-report> [...] " +
				"[--min-tests N] [--min-ran-tests N] [--max-nothing-files M] | --self-test",
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
