#!/usr/bin/env node
/**
 * Anti-false-green gate for the kernel-heavy suite (`npm run test:kernel`).
 *
 * Why this exists
 * ---------------
 * Most kernel-heavy files resolve a Python interpreter at module load time and fall back to
 * `describe.skip` when none resolves, and vitest exits 0 for a fully skipped file. A CI job that
 * never provides an interpreter therefore reports green while the kernel runtime face has zero
 * coverage. This gate reads the vitest JSON report and fails on the two shapes that hide it:
 *
 *   - a file whose tests never ran (`skipped`/`pending`/`todo` for every test in it), and
 *   - a total below `--min-tests`, i.e. a suite that silently stopped collecting.
 *
 * Both predicates are needed: an all-skipped run of the gated files still reports a healthy total,
 * and a collapsed collection can report zero all-skipped files.
 *
 * Usage
 * -----
 *   node scripts/check-kernel-coverage.mjs <report.json> [--min-tests 30]
 *   node scripts/check-kernel-coverage.mjs --self-test
 *
 * Exit codes: 0 = gate green, 1 = gate red, 2 = usage/unreadable report.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Test statuses that mean "this test never ran". */
const NOT_RUN_STATUSES = new Set(["skipped", "pending", "todo"]);
const DEFAULT_MIN_TESTS = 30;

function parseArgs(argv) {
	const options = { reports: [], minTests: DEFAULT_MIN_TESTS, selfTest: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--self-test") {
			options.selfTest = true;
			continue;
		}
		if (arg === "--min-tests") {
			const value = Number.parseInt(argv[++index] ?? "", 10);
			if (!Number.isInteger(value) || value <= 0) throw new UsageError(`--min-tests needs a positive integer, got "${argv[index] ?? ""}"`);
			options.minTests = value;
			continue;
		}
		if (typeof arg === "string" && arg.startsWith("--min-tests=")) {
			const value = Number.parseInt(arg.slice("--min-tests=".length), 10);
			if (!Number.isInteger(value) || value <= 0) throw new UsageError(`--min-tests needs a positive integer, got "${arg}"`);
			options.minTests = value;
			continue;
		}
		if (typeof arg === "string" && arg.startsWith("-")) throw new UsageError(`unknown option "${arg}"`);
		options.reports.push(arg);
	}
	return options;
}

class UsageError extends Error {}

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
	return { label, totalTests, files };
}

function relativeName(name) {
	const marker = "/packages/";
	const at = name.lastIndexOf(marker);
	return at === -1 ? name : name.slice(at + 1);
}

/** The failures this report carries; empty means the gate is green for it. */
function decide(inspection, minTests) {
	const failures = [];
	if (inspection.files.length === 0) {
		failures.push(`${inspection.label}: the report lists no test files at all (nothing was collected)`);
	}
	if (inspection.totalTests < minTests) {
		failures.push(
			`${inspection.label}: numTotalTests=${inspection.totalTests} is below the --min-tests floor of ${minTests}`,
		);
	}
	const allNotRun = inspection.files.filter((file) => file.allNotRun);
	if (allNotRun.length > 0) {
		failures.push(
			`${inspection.label}: ${allNotRun.length} file(s) ran nothing (describe.skip shape): ${allNotRun
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
	const lines = [`### ${inspection.label}: numTotalTests=${inspection.totalTests} files=${inspection.files.length}`];
	for (const file of [...inspection.files].sort((a, b) => a.name.localeCompare(b.name))) {
		const flag = file.allNotRun ? "  <== ALL SKIPPED (false-green shape)" : file.collectedNothing ? "  <== COLLECTED NOTHING" : "";
		lines.push(
			`    ${file.name}: n=${file.total} passed=${file.counts.passed} failed=${file.counts.failed} skipped=${file.counts.notRun}${flag}`,
		);
	}
	return lines.join("\n");
}

function checkFile(path, minTests) {
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
	return { failures: decide(inspection, minTests), text: formatInspection(inspection) };
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

/** The shape a healthy pinned run reports: 13 files, 36 tests, three individual skips. */
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

function runSelfTest() {
	const dir = mkdtempSync(join(tmpdir(), "kernel-coverage-selftest-"));
	const controls = [];
	try {
		const write = (name, report) => {
			const path = join(dir, name);
			writeFileSync(path, JSON.stringify(report), "utf8");
			return path;
		};
		controls.push({
			name: "healthy run passes",
			expectPass: true,
			run: () => decide(inspectReport(healthyReport(), "healthy"), DEFAULT_MIN_TESTS),
		});
		controls.push({
			name: "all-skipped files fail even with a healthy total",
			expectPass: false,
			run: () => decide(inspectReport(falseGreenReport(), "false-green"), DEFAULT_MIN_TESTS),
		});
		controls.push({
			name: "a collapsed collection fails on the --min-tests floor",
			expectPass: false,
			run: () =>
				decide(
					inspectReport(plantedReport([["/ci/packages/coding-agent/test/acp-cold-cli.test.ts", ["passed"]]]), "collapsed"),
					DEFAULT_MIN_TESTS,
				),
		});
		controls.push({
			name: "an empty report fails",
			expectPass: false,
			run: () => decide(inspectReport({ numTotalTests: 0, testResults: [] }, "empty"), DEFAULT_MIN_TESTS),
		});
		controls.push({
			name: "a file that collected zero tests fails",
			expectPass: false,
			run: () => decide(inspectReport(plantedReport([["/ci/packages/coding-agent/test/empty.test.ts", []]]), "no-tests"), 0),
		});
		controls.push({
			name: "individual skips inside a running file pass",
			expectPass: true,
			run: () =>
				decide(
					inspectReport(
						plantedReport([
							["/ci/packages/coding-agent/test/a.test.ts", ["passed", "skipped"]],
							["/ci/packages/coding-agent/test/b.test.ts", ["passed", "passed"]],
						]),
						"partial-skips",
					),
					4,
				),
		});
		controls.push({
			name: "--min-tests is honoured from the command line",
			expectPass: false,
			run: () => decide(inspectReport(healthyReport(), "healthy"), 40),
		});

		const healthyPath = write("healthy.json", healthyReport());
		const falseGreenPath = write("false-green.json", falseGreenReport());
		controls.push({
			name: "reading a report from disk behaves like the in-memory one",
			expectPass: false,
			run: () => checkFile(falseGreenPath, DEFAULT_MIN_TESTS).failures,
		});
		controls.push({
			name: "a missing report file fails",
			expectPass: false,
			run: () => checkFile(join(dir, "absent.json"), DEFAULT_MIN_TESTS).failures,
		});
		controls.push({
			name: "a malformed report file fails",
			expectPass: false,
			run: () => {
				const path = join(dir, "malformed.json");
				writeFileSync(path, "{ not json", "utf8");
				return checkFile(path, DEFAULT_MIN_TESTS).failures;
			},
		});
		controls.push({
			name: "the on-disk healthy report passes",
			expectPass: true,
			run: () => checkFile(healthyPath, DEFAULT_MIN_TESTS).failures,
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
		console.error("usage: check-kernel-coverage.mjs <vitest-json-report> [...] [--min-tests N] | --self-test");
		return 2;
	}
	const failures = [];
	for (const report of options.reports) {
		const result = checkFile(report, options.minTests);
		console.log(result.text);
		failures.push(...result.failures);
	}
	if (failures.length > 0) {
		console.error(`kernel coverage gate: RED (${failures.length} problem(s), --min-tests ${options.minTests})`);
		for (const failure of failures) console.error(`  - ${failure}`);
		console.error(
			"An all-skipped file ran nothing: either no Python interpreter resolved (seed one with bootstrap-cli.ts and export PRIME_AGENT_KERNEL_PYTHON), or the file has no kernel-heavy-tagged test left to collect.",
		);
		return 1;
	}
	console.log(`kernel coverage gate: GREEN (--min-tests ${options.minTests})`);
	return 0;
}

process.exit(main(process.argv.slice(2)));
