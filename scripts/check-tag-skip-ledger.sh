#!/usr/bin/env bash
# CI-2 gate: the tests a job does not run must be declared, counted and named.
#
# Why this exists
# ---------------
# `packages/coding-agent/vitest.config.ts` filters every run with
# `tagsFilter: ["!process-stress", "!kernel-heavy"]`, and vitest exits 0 when a filter
# turns a collected test into `skipped`. The process smoke job therefore reports half of
# what it collects as skipped (`12 passed | 12 skipped` in the run recorded in
# scripts/ci-floor-readings.json) while its `min_ran_tests` floor deliberately leaves a
# test of slack: the process-stress tests are invisible to that floor, and any *further*
# filter, `describe.skipIf` or silently dropped file leaves the job green as long as the
# floor is still met. This gate is what closes that hole - it reads the same report and
# compares it with the declared ledger entry by entry, in both directions.
#
# This gate reads the job's own vitest JSON report and compares the skip ledger it
# actually produced with the ledger the job declares in `.github/workflows/ci.yml`:
#
#   - a skipped test in a file the job did not declare  -> red, with the test names,
#   - a declared count that no longer matches what ran   -> red (both directions: a
#     declared skip that disappeared means the whitelist rotted),
#   - a declaration without a reason                     -> red.
#
# So the twelve skips become a written, counted, named list, and one more skip is a red
# job that names the file. The declared ledger is what makes the exclusions reviewable;
# the nightly `nightly-process-stress.yml` workflow is where the declared tests do run.
#
# Usage
# -----
#   bash scripts/check-tag-skip-ledger.sh <report.json> --ledger "path=count:reason[;;path=count:reason]"
#   bash scripts/check-tag-skip-ledger.sh <report.json> --declared "path=count:reason" [--declared ...]
#   bash scripts/check-tag-skip-ledger.sh --self-test
#
# Paths are relative to the repository root (`packages/<pkg>/test/<file>.test.ts`), which is
# how the coverage gate names files too. Exit codes: 0 = ledger matches, 1 = red, 2 = usage.
set -euo pipefail

REPORT=""
LEDGER_SPEC=""
SELF_TEST=0
DECLARED=()

die() { echo "check-tag-skip-ledger: $*" >&2; exit 2; }

usage() {
	cat >&2 <<'USAGE'
usage: bash scripts/check-tag-skip-ledger.sh <report.json> --ledger "<path>=<count>:<reason>[;;...]"
       bash scripts/check-tag-skip-ledger.sh --self-test
USAGE
}

while [ $# -gt 0 ]; do
	case "$1" in
		--self-test) SELF_TEST=1; shift ;;
		--ledger) [ $# -ge 2 ] || die "--ledger needs an argument"; LEDGER_SPEC="$2"; shift 2 ;;
		--ledger=*) LEDGER_SPEC="${1#--ledger=}"; shift ;;
		--declared) [ $# -ge 2 ] || die "--declared needs an argument"; DECLARED+=("$2"); shift 2 ;;
		--declared=*) DECLARED+=("${1#--declared=}"); shift ;;
		-h|--help) usage; exit 0 ;;
		-*) die "unknown option $1" ;;
		*) [ -z "$REPORT" ] || die "only one report at a time (got a second: $1)"; REPORT="$1"; shift ;;
	esac
done

# `path=count:reason` entries, one per line, into a temp file. The spec separator is `;;`
# so a whole ledger fits in one YAML matrix value; whitespace and newlines are trimmed.
split_ledger() {
	# `;;` separates entries (a reason may contain single `;` and `:`), and the loop is spelled
	# with parameter expansion rather than `tr` so a semicolon inside a reason cannot split it.
	local rest="$1"
	while [ -n "$rest" ]; do
		case "$rest" in
			*';;'*) printf '%s\n' "${rest%%;;*}"; rest="${rest#*;;}" ;;
			*) printf '%s\n' "$rest"; rest="" ;;
		esac
	done
}

# The verdict. Node reads the JSON (no jq dependency) and applies every rule; bash owns the
# argument surface and the exit code.
verdict() {
	local report="$1"; shift
	node - "$report" "$@" <<'NODE'
const fs = require("node:fs");

const [reportPath, ...ledgerLines] = process.argv.slice(2);
const failures = [];
const notes = [];

let report;
try {
	report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
} catch (error) {
	failures.push(`cannot read the vitest JSON report at ${reportPath}: ${error.message}`);
	console.error("tag-skip ledger: RED");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

const relativeName = (name) => {
	const at = name.lastIndexOf("/packages/");
	return at === -1 ? name : name.slice(at + 1);
};

const files = (Array.isArray(report.testResults) ? report.testResults : []).map((entry) => {
	const assertions = Array.isArray(entry.assertionResults) ? entry.assertionResults : [];
	const skipped = [];
	let passed = 0;
	let failed = 0;
	for (const assertion of assertions) {
		if (assertion?.status === "passed") passed += 1;
		else if (assertion?.status === "failed") failed += 1;
		else skipped.push(typeof assertion?.title === "string" ? assertion.title : "?");
	}
	return { name: relativeName(typeof entry?.name === "string" ? entry.name : "?"), passed, failed, skipped };
});

const declared = new Map();
for (const line of ledgerLines) {
	const match = /^([^=]+)=(\d+)(?::(.*))?$/.exec(line.trim());
	if (!match) {
		failures.push(`the declared ledger entry "${line}" is not in the <path>=<count>:<reason> shape`);
		continue;
	}
	const [, path, count, reason] = match;
	if (!reason || reason.trim() === "") {
		failures.push(`the declared ledger entry for ${path} has no reason: raise the count only with a written reason`);
	}
	if (declared.has(path)) failures.push(`${path} is declared twice in the ledger`);
	declared.set(path, { count: Number.parseInt(count, 10), reason: (reason ?? "").trim() });
}

const skippedFiles = files.filter((file) => file.skipped.length > 0);
const observed = new Map(skippedFiles.map((file) => [file.name, file.skipped.length]));

for (const file of skippedFiles) {
	if (!declared.has(file.name)) {
		failures.push(
			`${file.name} skipped ${file.skipped.length} test(s) that the job did not declare: ` +
				file.skipped.slice(0, 5).map((title) => `"${title}"`).join(", ") +
				(file.skipped.length > 5 ? `, +${file.skipped.length - 5} more` : ""),
		);
	}
}
for (const [path, entry] of declared) {
	if (!observed.has(path)) {
		failures.push(
			`the ledger declares ${entry.count} skip(s) in ${path}, but that file ran everything (or is no longer in the report): ` +
				"the declaration rotted, drop it or find out why the tests stopped being filtered",
		);
		continue;
	}
	if (observed.get(path) !== entry.count) {
		failures.push(`the ledger declares ${entry.count} skip(s) in ${path}, this run produced ${observed.get(path)}`);
	}
}

const collected = files.reduce((sum, file) => sum + file.passed + file.failed + file.skipped.length, 0);
const ran = files.reduce((sum, file) => sum + file.passed + file.failed, 0);
const skipped = files.reduce((sum, file) => sum + file.skipped.length, 0);
const declaredTotal = [...declared.values()].reduce((sum, entry) => sum + entry.count, 0);

notes.push(
	`tag-skip ledger: ${reportPath}\n` +
		`  collected=${collected} ran=${ran} skipped=${skipped} (declared ${declaredTotal} across ${declared.size} file(s))`,
);
for (const file of skippedFiles.sort((a, b) => a.name.localeCompare(b.name))) {
	const entry = declared.get(file.name);
	const declaredForFile = entry ? `declared=${entry.count}` : "UNDECLARED";
	notes.push(`  ${file.name}: ran=${file.passed + file.failed} skipped=${file.skipped.length} ${declaredForFile}`);
	if (entry) notes.push(`      reason: ${entry.reason}`);
	for (const title of file.skipped) notes.push(`      - ${title}`);
}

if (failures.length > 0) {
	console.error(notes.join("\n"));
	console.error("tag-skip ledger: RED");
	for (const failure of failures) console.error(`  - ${failure}`);
	console.error(
		"A test the job does not run is either a filter that no longer selects it (fix the filter) or a deliberate " +
			"exclusion. If it is deliberate, declare it in .github/workflows/ci.yml as " +
			'--ledger "<path>=<count>:<reason>", where the reason names the workflow that does run it ' +
			"(nightly-process-stress.yml for the process-stress tests).",
	);
	process.exit(1);
}
console.log(notes.join("\n"));
console.log("tag-skip ledger: GREEN (every skip is declared, counted and named)");
NODE
}

run_check() {
	local report="$1"; shift
	local ledger_lines="$1"
	local entries=()
	while IFS= read -r line; do
		[ -n "$line" ] && entries+=("$line")
	done < <(split_ledger "$ledger_lines")
	verdict "$report" "${entries[@]+"${entries[@]}"}"
}

# ---------------------------------------------------------------------------
# self-test: a matching ledger is green, every drift shape is red
# ---------------------------------------------------------------------------
self_test() {
	local dir report good bad
	dir=$(mktemp -d "${TMPDIR:-/tmp}/tag-skip-ledger-selftest.XXXXXX") || die "cannot mktemp"
	report="$dir/report.json"
	good="$dir/report-declared-runs.json"
	bad="$dir/report-extra-file.json"
	# Expanded now, not at trap time: `dir` is a local of this function, and `set -u` would
	# make the EXIT trap trip over it being out of scope.
	trap "rm -rf '$dir'" EXIT

	node -e '
const fs = require("node:fs");
const file = (name, statuses) => ({
  name: `/ci/packages/coding-agent/${name}`,
  status: statuses.every((s) => s !== "passed") ? "skipped" : "passed",
  assertionResults: statuses.map((status, index) => ({ title: `${name} test ${index}`, fullName: `${name} test ${index}`, status })),
});
const passed = (n) => Array.from({ length: n }, () => "passed");
const skipped = (n) => Array.from({ length: n }, () => "skipped");
const write = (path, files) => fs.writeFileSync(path, JSON.stringify({
  numTotalTests: files.reduce((sum, f) => sum + f.assertionResults.length, 0),
  testResults: files,
}), "utf8");
write(process.argv[1], [
  file("test/daemon-supervisor-process.test.ts", [...passed(11), ...skipped(8)]),
  file("test/daemon-supervisor-crash-handlers-process.test.ts", skipped(4)),
]);
write(process.argv[2], [
  file("test/daemon-supervisor-process.test.ts", passed(19)),
  file("test/daemon-supervisor-crash-handlers-process.test.ts", passed(4)),
]);
write(process.argv[3], [
  file("test/daemon-supervisor-process.test.ts", [...passed(11), ...skipped(8)]),
  file("test/daemon-supervisor-crash-handlers-process.test.ts", skipped(4)),
  file("test/daemon-supervisor-monitor.test.ts", [...passed(3), "skipped"]),
]);
' "$report" "$good" "$bad"

	local ledger="packages/coding-agent/test/daemon-supervisor-process.test.ts=8:process-stress tag-filtered here; nightly-process-stress.yml runs it"
	ledger="$ledger;;packages/coding-agent/test/daemon-supervisor-crash-handlers-process.test.ts=4:process-stress tag-filtered here; nightly-process-stress.yml runs it"

	local mismatches=0
	expect() {
		local name="$1" want="$2" needle="$3"; shift 3
		local out rc
		out=$("$@" 2>&1) && rc=0 || rc=$?
		local ok=1
		[ "$rc" = "$want" ] || ok=0
		if [ -n "$needle" ] && ! printf '%s' "$out" | grep -qF "$needle"; then ok=0; fi
		if [ "$ok" = "1" ]; then
			printf 'ok   %s (exit %s)\n' "$name" "$rc"
		else
			mismatches=$((mismatches + 1))
			printf 'FAIL %s (want exit %s, got %s; wanted text "%s")\n' "$name" "$want" "$rc" "$needle"
			printf '%s\n' "$out" | sed 's/^/       /'
		fi
	}

	expect "the declared ledger matches the job and is green" 0 "tag-skip ledger: GREEN" run_check "$report" "$ledger"
	expect "an undeclared skipping file is red and names it" 1 "packages/coding-agent/test/daemon-supervisor-monitor.test.ts skipped 1 test(s) that the job did not declare" run_check "$bad" "$ledger"
	expect "a declaration that no longer skips is red (rotted whitelist)" 1 "but that file ran everything" run_check "$good" "$ledger"
	expect "a declared count that drifted is red" 1 "this run produced 8" run_check "$report" "packages/coding-agent/test/daemon-supervisor-process.test.ts=7:process-stress;;packages/coding-agent/test/daemon-supervisor-crash-handlers-process.test.ts=4:process-stress"
	expect "a declaration without a reason is red" 1 "has no reason" run_check "$report" "packages/coding-agent/test/daemon-supervisor-process.test.ts=8;;packages/coding-agent/test/daemon-supervisor-crash-handlers-process.test.ts=4:process-stress"
	expect "a missing report is red" 1 "cannot read the vitest JSON report" run_check "$dir/absent.json" "$ledger"
	expect "skips with no ledger at all are red" 1 "did not declare" run_check "$report" ""
	expect "one ledger line per file works in both entry points" 0 "tag-skip ledger: GREEN" verdict "$report" \
		"packages/coding-agent/test/daemon-supervisor-process.test.ts=8:reason" \
		"packages/coding-agent/test/daemon-supervisor-crash-handlers-process.test.ts=4:reason"

	echo "self-test: 8 controls, $mismatches mismatch(es)"
	if [ "$mismatches" != "0" ]; then exit 1; fi
}

if [ "$SELF_TEST" = "1" ]; then
	self_test
	exit $?
fi

[ -n "$REPORT" ] || { usage; exit 2; }
LEDGER_SPEC="${LEDGER_SPEC:-}"
if [ -n "$LEDGER_SPEC" ] && [ "${#DECLARED[@]}" -gt 0 ]; then
	die "pass either --ledger or --declared, not both"
fi
spec="$LEDGER_SPEC"
if [ -z "$spec" ] && [ "${#DECLARED[@]}" -gt 0 ]; then
	spec=""
	for entry in "${DECLARED[@]}"; do spec="${spec}${entry};;"; done
fi

run_check "$REPORT" "$spec"
