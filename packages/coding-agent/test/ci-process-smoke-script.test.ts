import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `scripts/check-process-smoke.sh` is the local mirror of the CI job "Test (coding-agent process
 * smoke)", and it had a hole that only a clean checkout shows: the `mkdir -p "$(dirname "$REPORT")"`
 * sat *inside* the argument loop, where `$REPORT` was not assigned yet. `set -u` therefore killed
 * `--with-stress` on its own ("REPORT: unbound variable"), and a plain no-argument run never
 * executed the loop body at all, so it wrote its report into a `coverage/` directory nobody had
 * created (`coverage/` is gitignored) - the first step failed with "No such file or directory"
 * instead of running the suite.
 *
 * The fix moves the mkdir below the line that assigns REPORT. This test is what keeps it there: a
 * stub `npm` on PATH records, at the moment it is invoked, whether the report's directory already
 * exists, so the assertion is about the ordering rather than about a final state that any later
 * step could have produced. Both invocation shapes are covered because the two shapes failed
 * differently, and the last two tests run the same stub against freshly mutated copies of the
 * script (mkdir deleted / mkdir put back inside the loop) and require both to go red: without them,
 * a rewrite that quietly stops exercising this path would still leave a green pin.
 *
 * The stub also proves where the floors come from: a mutated copy of `scripts/lib/ci-process-smoke.mjs`
 * must move the mirror's gate, so the local mirror cannot gate at numbers the module no longer has.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scriptPath = join(repoRoot, "scripts", "check-process-smoke.sh");
const moduleRelative = join("scripts", "lib", "ci-process-smoke.mjs");

type Call = {
	script: string;
	cwd: string;
	report: string;
	reportDir: string;
	reportDirExisted: boolean | null;
	args: string[];
};

type Run = { status: number | null; output: string };

/**
 * A stand-in for `npm` that answers `npm run test:process` with a report shaped like the one CI
 * produces (12 passed + 8 skipped, and 4 skipped in the crash-handlers file) and records whether
 * the report directory existed when it was called. It deliberately does not create that directory:
 * a stub that repaired the path would hide exactly the bug this pin is about.
 */
const stubNpm = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const script = args[0] === "run" ? args[1] : args[0];
const outputArg = args.find((arg) => arg.startsWith("--outputFile.json="));
const report = outputArg ? outputArg.slice("--outputFile.json=".length) : "";
const reportDir = report ? path.dirname(report) : "";
const reportDirExisted = reportDir ? fs.existsSync(reportDir) : null;
fs.appendFileSync(
	process.env.SMOKE_STUB_LOG,
	JSON.stringify({ script, cwd: process.cwd(), report, reportDir, reportDirExisted, args }) + "\\n",
);
if (script !== "test:process") {
	process.stdout.write(" Test Files  2 passed (2)\\n      Tests  12 passed (12)\\n");
	process.exit(0);
}
if (!reportDirExisted) {
	process.stderr.write("ENOENT: no such file or directory, open '" + report + "'\\n");
	process.exit(1);
}
const root = process.env.SMOKE_STUB_ROOT;
const assertion = (name, status) => ({ title: name, fullName: name, status });
const many = (n, status, prefix) =>
	Array.from({ length: n }, (_, index) => assertion(prefix + " case " + index, status));
const file = (name, assertions) => ({
	name: path.join(root, "packages", "coding-agent", "test", name),
	status: assertions.some((entry) => entry.status === "passed") ? "passed" : "skipped",
	assertionResults: assertions,
});
const body = {
	numTotalTests: 24,
	numPassedTests: 12,
	numFailedTests: 0,
	numPendingTests: 12,
	success: true,
	testResults: [
		file("daemon-supervisor-process.test.ts", [
			...many(12, "passed", "process"),
			...many(8, "skipped", "process-stress"),
		]),
		file("daemon-supervisor-crash-handlers-process.test.ts", many(4, "skipped", "crash-handler")),
	],
};
fs.writeFileSync(report, JSON.stringify(body));
process.stdout.write(" Test Files  2 passed (2)\\n      Tests  12 passed | 12 skipped (24)\\n");
process.exit(0);
`;

let workspace = "";
let checkout = "";
let stubBin = "";
let callLog = "";

function writeStubNpm(): void {
	mkdirSync(stubBin, { recursive: true });
	writeFileSync(join(stubBin, "npm"), stubNpm, "utf8");
	chmodSync(join(stubBin, "npm"), 0o755);
}

function calls(): Call[] {
	if (!existsSync(callLog)) return [];
	return readFileSync(callLog, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Call);
}

/** Run the mirror against the throwaway checkout, with the stub npm ahead of the real one. */
function runScript(args: string[], overrides: { checkout?: string; script?: string } = {}): Run {
	const target = overrides.script ?? scriptPath;
	const result = spawnSync("bash", [target, ...args], {
		cwd: overrides.checkout ?? checkout,
		encoding: "utf8",
		timeout: 120_000,
		env: {
			...process.env,
			REPO_ROOT: overrides.checkout ?? checkout,
			PATH: `${stubBin}:${process.env.PATH ?? ""}`,
			SMOKE_STUB_LOG: callLog,
			SMOKE_STUB_ROOT: overrides.checkout ?? checkout,
		},
	});
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * A throwaway checkout that looks enough like this repository for the mirror: the two test files it
 * insists on, and a real copy of `scripts/` (a copy, not a symlink, so a test can mutate the module
 * the mirror reads without touching the checkout under test).
 */
function makeCheckout(): string {
	const root = join(workspace, "checkout");
	mkdirSync(join(root, "packages", "coding-agent", "test"), { recursive: true });
	for (const name of ["daemon-supervisor-process.test.ts", "daemon-supervisor-crash-handlers-process.test.ts"]) {
		writeFileSync(join(root, "packages", "coding-agent", "test", name), "", "utf8");
	}
	cpSync(join(repoRoot, "scripts"), join(root, "scripts"), { recursive: true });
	return root;
}

const mkdirLine = '[ "$SELF_TEST" = "1" ] || mkdir -p "$(dirname "$REPORT")"';
const legacyLine = '[ -n "$REPORT_OVERRIDE" ] || [ "$SELF_TEST" = "1" ] || mkdir -p "$(dirname "$REPORT")"';

/** The script as it was before the fix: the mkdir back inside the argument loop. */
function withLegacyMkdir(text: string): string {
	const loopEnd = "\tesac\ndone";
	expect(text).toContain(loopEnd);
	return text.replace(loopEnd, `\tesac\n\t${legacyLine}\ndone`);
}

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "process-smoke-pin-"));
	stubBin = join(workspace, "bin");
	callLog = join(workspace, "npm-calls.jsonl");
	writeStubNpm();
	checkout = makeCheckout();
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

describe("the local process-smoke mirror creates its report directory before it needs it", () => {
	it("creates the directory before npm runs, with no arguments at all", () => {
		const run = runScript([]);
		expect(run.output).not.toMatch(/unbound variable|No such file or directory/);
		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("check-process-smoke: GREEN");

		const recorded = calls();
		expect(recorded.map((call) => call.script)).toEqual(["test:process"]);
		// The reading that matters: the path existed when the runner was invoked, not afterwards.
		expect(recorded[0]?.reportDirExisted, `${recorded[0]?.reportDir} did not exist when npm ran`).toBe(true);
		expect(recorded[0]?.report.startsWith(join(checkout, "packages", "coding-agent", "coverage"))).toBe(true);
	});

	it("reaches both faces under --with-stress instead of dying while parsing arguments", () => {
		const run = runScript(["--with-stress"]);
		expect(run.output).not.toMatch(/unbound variable/);
		expect(run.output).not.toMatch(/No such file or directory/);
		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("check-process-smoke: GREEN");

		const recorded = calls();
		expect(recorded.map((call) => call.script)).toEqual(["test:process", "test:process-stress"]);
		// The stress face takes no report argument, so the ordering reading belongs to the first
		// call; what the second call proves is that the parsing loop did not kill the run before it.
		expect(recorded[0]?.reportDirExisted).toBe(true);
		expect(recorded[1]?.script).toBe("test:process-stress");
		expect(run.output).toContain("5/5 nightly face");
	});

	it("creates a directory that does not exist yet when --report points into a nested path", () => {
		const nested = join(checkout, "deep", "nested", "report.json");
		const run = runScript(["--report", nested]);
		expect(run.status, run.output).toBe(0);
		const [first] = calls();
		expect(first?.report).toBe(nested);
		expect(first?.reportDirExisted).toBe(true);
		expect(existsSync(dirname(nested))).toBe(true);
	});

	it("gates at the floors the module carries, and follows the module when it changes", () => {
		const run = runScript([]);
		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("min_tests=22 min_ran_tests=11 max_nothing_files=1");

		// The mirror reads $ROOT/scripts/lib/ci-process-smoke.mjs at run time: raise the floor in
		// the copy and the same green report (24 collected) must stop passing the gate.
		const modulePath = join(checkout, moduleRelative);
		const text = readFileSync(modulePath, "utf8");
		expect(text).toContain("min_tests: 22");
		writeFileSync(modulePath, text.replace("min_tests: 22", "min_tests: 999"), "utf8");
		const raised = runScript([]);
		expect(raised.status, raised.output).not.toBe(0);
		expect(raised.output).toContain("below the --min-tests floor of 999");
	});
});

describe("the report-directory pin can go red (mutated copies of the same script)", () => {
	it("is red when the mkdir is deleted: the runner sees a directory nobody created", () => {
		const text = readFileSync(scriptPath, "utf8");
		expect(text).toContain(mkdirLine);
		const broken = join(workspace, "no-mkdir.sh");
		writeFileSync(broken, text.replace(`${mkdirLine}\n`, ""), "utf8");

		const run = runScript([], { script: broken });
		expect(run.status).not.toBe(0);
		expect(run.output).toContain("No such file or directory");
		// With no directory there, bash cannot even open the log file beside the report, so the
		// runner is never reached: a broken checkout is loud before any test process starts.
		expect(calls()).toEqual([]);
	});

	it("is red when the mkdir happens after the runner instead of before it", () => {
		const text = readFileSync(scriptPath, "utf8");
		const anchor = 'step "2/4 readings from the report';
		expect(text).toContain(anchor);
		const broken = join(workspace, "late-mkdir.sh");
		writeFileSync(broken, text.replace(`${mkdirLine}\n`, "").replace(anchor, `${mkdirLine}\n${anchor}`), "utf8");

		const run = runScript([], { script: broken });
		expect(run.status).not.toBe(0);
		expect(run.output).toContain("No such file or directory");
		expect(calls()).toEqual([]);
	});

	it("the stub's own reading is not vacuous: it calls a missing directory missing", () => {
		// The green runs assert reportDirExisted === true, which only means something if the stub
		// can report false. Drive the stub directly at a report path whose directory is absent.
		const missing = join(workspace, "absent", "report.json");
		const result = spawnSync(join(stubBin, "npm"), ["run", "test:process", "--", `--outputFile.json=${missing}`], {
			encoding: "utf8",
			env: { ...process.env, SMOKE_STUB_LOG: callLog, SMOKE_STUB_ROOT: checkout },
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("ENOENT");
		expect(calls()[0]?.reportDirExisted).toBe(false);
	});

	it("is red when the mkdir is put back inside the argument loop (the original bug)", () => {
		const text = readFileSync(scriptPath, "utf8");
		expect(text).toContain(mkdirLine);
		const broken = join(workspace, "legacy-mkdir.sh");
		writeFileSync(broken, withLegacyMkdir(text.replace(`${mkdirLine}\n`, "")), "utf8");

		const run = runScript(["--with-stress"], { script: broken });
		expect(run.status).not.toBe(0);
		expect(run.output).toContain("unbound variable");
		expect(calls()).toEqual([]);

		// A no-argument run never entered the loop, which is why the same bug also produced
		// "No such file or directory" instead of an unbound-variable error. Both shapes are pinned.
		const noArgs = runScript([], { script: broken });
		expect(noArgs.status).not.toBe(0);
		expect(noArgs.output).toContain("No such file or directory");
	});
});
