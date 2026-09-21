#!/usr/bin/env bash
# check-process-smoke.sh - the local mirror of CI job "Test (coding-agent process smoke)".
#
# Why this file exists
# --------------------
# The local full component (the three `npm run test:ci -- --shard=i/3` runs) does NOT cover
# `test/daemon-supervisor-process.test.ts`: `packages/coding-agent/package.json`'s `test:ci`
# excludes it (one of 11 `--exclude` flags) because CI runs it in its own job. The local
# ladder mirrored the kernel / machine-wide / runtime-python specialty jobs and missed this
# one, so the file was in neither local face - CI run 35296425559 reddened two of its tests
# (the #2098 in-context harness digest adds exactly one carrier to a resumed session) with
# zero local signal. This script is that missing face, spelled as the same command CI runs.
#
# What it does (four readings, all of them mechanical)
# ---------------------------------------------------
#   1. `npm run test:process -- --reporter=default --reporter=json --outputFile.json=...`
#      exactly as `.github/workflows/ci.yml` runs it, and fails on a non-zero exit.
#   2. Prints the per-file collected/ran/passed/failed/skipped ledger from that report.
#   3. The CI coverage gate at the CI floors (min_tests / min_ran_tests / max_nothing_files) exactly
#      as `.github/workflows/ci.yml`'s row for this job carries them - read out of that row at run
#      time by `scripts/lib/ci-matrix-row.mjs`; `crash-handlers-process` is the one file allowed to
#      run nothing, because all four of its tests carry the `process-stress` tag.
#   4. The CI tag-skip ledger, out of the same row: 8 skips in
#      daemon-supervisor-process.test.ts + 4 in daemon-supervisor-crash-handlers-process.test.ts.
#      The judgement is the tag, not the environment: `vitest.config.ts` sets
#      `tagsFilter: ["!process-stress", "!kernel-heavy"]` unconditionally, so those twelve
#      tests are skipped on every platform and under every env; the nightly
#      `nightly-process-stress.yml` is where they do run.
#
# Usage
# -----
#   bash scripts/check-process-smoke.sh                 # the CI face (green = collected 24 | ran 12 | skipped 12)
#   bash scripts/check-process-smoke.sh --with-stress   # + the nightly face (`test:process-stress`)
#   bash scripts/check-process-smoke.sh --self-test     # prove both instruments can still go red
#   bash scripts/check-process-smoke.sh --report /tmp/p.json   # keep the report elsewhere
#
# Repository root is resolved from this script's own location, so the file works both from a
# checkout's `scripts/` and from a throwaway copy outside the tree (REPO_ROOT=<path> overrides).
# Exit codes: 0 = every reading green, 1 = red (the failing step is named), 2 = usage.
set -uo pipefail

WITH_STRESS=0
SELF_TEST=0
REPORT_OVERRIDE=""

usage() {
	cat >&2 <<'USAGE'
usage: bash scripts/check-process-smoke.sh [--with-stress] [--self-test] [--report <path>]
USAGE
}

while [ $# -gt 0 ]; do
	case "$1" in
		--with-stress) WITH_STRESS=1; shift ;;
		--self-test) SELF_TEST=1; shift ;;
		--report) [ $# -ge 2 ] || { usage; exit 2; }; REPORT_OVERRIDE="$2"; shift 2 ;;
		--report=*) REPORT_OVERRIDE="${1#--report=}"; shift ;;
		-h|--help) usage; exit 0 ;;
		*) echo "check-process-smoke: unknown argument $1" >&2; usage; exit 2 ;;
	esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "${REPO_ROOT:-}" ]; then
	ROOT="$REPO_ROOT"
elif git_root="$(unset GIT_DIR GIT_INDEX_FILE; git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" && [ -n "$git_root" ]; then
	# Discovery strips the hook-exported GIT_DIR/GIT_INDEX_FILE: in a linked worktree they make
	# rev-parse --show-toplevel answer the cwd (this scripts/ dir) instead of the checkout root.
	ROOT="$git_root"
else
	# A copy that sits outside any checkout (this file is also handed around as /tmp/...): walk
	# up for the package it drives. REPO_ROOT= is the explicit override above.
	ROOT=""
	candidate="$SCRIPT_DIR"
	for _ in 1 2 3 4; do
		if [ -f "$candidate/packages/coding-agent/package.json" ]; then ROOT="$candidate"; break; fi
		candidate="$(cd "$candidate/.." && pwd)"
	done
	[ -n "$ROOT" ] || { echo "check-process-smoke: cannot locate the checkout; set REPO_ROOT=<path>" >&2; exit 2; }
fi
PKG="$ROOT/packages/coding-agent"
AGENT_TEST="$PKG/test/daemon-supervisor-process.test.ts"
HANDLERS_TEST="$PKG/test/daemon-supervisor-crash-handlers-process.test.ts"
[ -f "$AGENT_TEST" ] && [ -f "$HANDLERS_TEST" ] || {
	echo "check-process-smoke: not a prime-agent checkout (missing $AGENT_TEST)" >&2
	exit 2
}
REPORT="${REPORT_OVERRIDE:-$PKG/coverage/ci-process-smoke.json}"
# The report's directory does not exist in a fresh checkout (`coverage/` is gitignored), and vitest
# writes neither the report nor its log without it. This line used to sit inside the argument loop
# above, where `$REPORT` was still unbound: `set -u` aborted the assignment, so `--with-stress` on
# its own ran every step against a path nobody had created.
[ "$SELF_TEST" = "1" ] || mkdir -p "$(dirname "$REPORT")"

# The floors and the declared skips are read out of `.github/workflows/ci.yml` itself - the matrix
# row CI runs is the source, not a copy of it. They used to be hand-copied into this file, then
# moved into a module (`scripts/lib/ci-process-smoke.mjs`) whose values a test kept equal to the
# workflow: two carriers of one number, held together by a third file. The workflow is now the only
# carrier and `scripts/lib/ci-matrix-row.mjs` the only reader the gate uses, so "the floor CI runs"
# and "the floor this mirror gates at" are the same bytes by construction.
#
# No fallback on purpose: a workflow that cannot be read, a row that is not there under that name,
# two rows with that name, or a row missing one of the four values all abort (exit 2) instead of
# letting the mirror gate at some invented default.
ROW_NAME="coding-agent process smoke"
CI_WORKFLOW="${CI_WORKFLOW_FILE:-$ROOT/.github/workflows/ci.yml}"
[ -f "$CI_WORKFLOW" ] || {
	echo "check-process-smoke: no $CI_WORKFLOW to read the floors out of" >&2
	exit 2
}
SMOKE_CONFIG="$(node "$ROOT/scripts/lib/ci-matrix-row.mjs" --row "$ROW_NAME" --file "$CI_WORKFLOW")" || {
	echo "check-process-smoke: cannot read the \"$ROW_NAME\" row from $CI_WORKFLOW (node exit $?)" >&2
	exit 2
}
MIN_TESTS=""; MIN_RAN_TESTS=""; MAX_NOTHING_FILES=""; LEDGER=""
while IFS=$'\t' read -r config_key config_value; do
	[ -n "$config_key" ] || continue
	# The reader prints one `<key>\t<value>` line, values verbatim: the ledger is
	# `path=count:reason;;path=count:reason` and must not be split on anything but the tab.
	case "$config_key" in
		min_tests) MIN_TESTS="$config_value" ;;
		min_ran_tests) MIN_RAN_TESTS="$config_value" ;;
		max_nothing_files) MAX_NOTHING_FILES="$config_value" ;;
		tag_skip_ledger) LEDGER="$config_value" ;;
		# Other scalars in the row (`package`, `command`, `report`, `install_uv`) are not this
		# gate's business; a *missing* one of the four below is, and is caught next.
		*) ;;
	esac
done <<< "$SMOKE_CONFIG"
# Explicit labels rather than ${var,,}: /bin/bash on macOS is 3.2, and this file has to run there.
require_row_value() {
	[ -n "$2" ] || {
		echo "check-process-smoke: the $ROW_NAME row in $CI_WORKFLOW has no $1; refusing to gate without it" >&2
		exit 2
	}
}
require_row_number() {
	case "$2" in
		''|*[!0-9]*) echo "check-process-smoke: $1 came out of $CI_WORKFLOW as \"$2\", which is not a number" >&2; exit 2 ;;
	esac
}
require_row_value min_tests "$MIN_TESTS"
require_row_value min_ran_tests "$MIN_RAN_TESTS"
require_row_value max_nothing_files "$MAX_NOTHING_FILES"
require_row_value tag_skip_ledger "$LEDGER"
require_row_number min_tests "$MIN_TESTS"
require_row_number min_ran_tests "$MIN_RAN_TESTS"
require_row_number max_nothing_files "$MAX_NOTHING_FILES"
echo "floors from ${CI_WORKFLOW#"$ROOT"/} ($ROW_NAME): min_tests=$MIN_TESTS min_ran_tests=$MIN_RAN_TESTS max_nothing_files=$MAX_NOTHING_FILES"

FAILED_STEP=""
step() { printf '\n== %s ==\n' "$1"; }
fail() { FAILED_STEP="$1"; printf 'FAIL: %s\n' "$1"; }

if [ "$SELF_TEST" = "1" ]; then
	step "self-test: the instruments this gate depends on must still be able to go red"
	rc=0
	node "$ROOT/scripts/check-vitest-coverage.mjs" --self-test || rc=1
	bash "$ROOT/scripts/check-tag-skip-ledger.sh" --self-test || rc=1
	# The floors and the ledger this gate runs at are read from a module, so the module's own
	# shape is an instrument too: a `;;` inside a reason, or a shell surface missing a key, would
	# otherwise show up as a silently mis-parsed gate.
	# The floors this file gates against are read out of ci.yml at run time, so the reader itself
	# has to be able to go red: it plants a missing row, two rows with one name, a row whose keys
	# are all block values and a changed value, and requires the right answer for each.
	node "$ROOT/scripts/lib/ci-matrix-row.mjs" --self-test || rc=1
	if [ "$rc" != "0" ]; then
		echo "check-process-smoke: self-test RED (an instrument can no longer detect its drift)" >&2
		exit 1
	fi
	echo "check-process-smoke: self-test GREEN (coverage gate, tag-skip ledger and the ci.yml matrix reader each plant their own red)"
	exit 0
fi

step "1/4 run the CI job's command: npm run test:process (packages/coding-agent)"
( cd "$PKG" && npm run test:process -- --reporter=default --reporter=json --outputFile.json="$REPORT" ) \
	> "$REPORT.human.log" 2>&1
rc=$?
grep -E "Test Files|Tests  " "$REPORT.human.log" | tail -3
if [ "$rc" != "0" ]; then
	tail -40 "$REPORT.human.log"
	fail "the process smoke suite itself is red (vitest exit $rc); full output: $REPORT.human.log"
else
	echo "vitest: exit 0"
fi

step "2/4 readings from the report (collected / ran / passed / failed / skipped)"
if [ -f "$REPORT" ]; then
	node -e '
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const rel = (name) => {
  const at = name.lastIndexOf("/packages/");
  return at === -1 ? name : name.slice(at + 1);
};
let collected = 0, ran = 0, passed = 0, failed = 0, skipped = 0;
for (const file of report.testResults || []) {
  const assertions = file.assertionResults || [];
  const p = assertions.filter((a) => a.status === "passed").length;
  const f = assertions.filter((a) => a.status === "failed").length;
  const s = assertions.length - p - f;
  console.log(
    "  " + rel(file.name) + ": collected=" + assertions.length + " ran=" + (p + f) +
    " passed=" + p + " failed=" + f + " skipped=" + s +
    (p + f === 0 ? "  (nothing-file: this file ran nothing)" : ""),
  );
  collected += assertions.length; ran += p + f; passed += p; failed += f; skipped += s;
}
console.log("  TOTAL: collected=" + collected + " ran=" + ran + " passed=" + passed +
  " failed=" + failed + " skipped=" + skipped +
  "  (CI floors: min_tests=" + process.argv[2] + " min_ran_tests=" + process.argv[3] +
  " max_nothing_files=" + process.argv[4] + ")");
' "$REPORT" "$MIN_TESTS" "$MIN_RAN_TESTS" "$MAX_NOTHING_FILES"
else
	fail "no report at $REPORT (vitest writes it only when it could run)"
fi

step "3/4 CI coverage gate at the CI floors"
if [ -f "$REPORT" ]; then
	node "$ROOT/scripts/check-vitest-coverage.mjs" "$REPORT" \
		--min-tests "$MIN_TESTS" --min-ran-tests "$MIN_RAN_TESTS" --max-nothing-files "$MAX_NOTHING_FILES"
	rc=$?
	[ "$rc" = "0" ] || fail "check-vitest-coverage.mjs exit $rc"
else
	fail "coverage gate skipped: no report"
fi

step "4/4 CI tag-skip ledger (12 declared skips, 8 + 4, counted and named)"
if [ -f "$REPORT" ]; then
	bash "$ROOT/scripts/check-tag-skip-ledger.sh" "$REPORT" --ledger "$LEDGER"
	rc=$?
	[ "$rc" = "0" ] || fail "check-tag-skip-ledger.sh exit $rc"
else
	fail "ledger gate skipped: no report"
fi

if [ "$WITH_STRESS" = "1" ]; then
	step "5/5 nightly face: npm run test:process-stress (the 12 tag-filtered tests)"
	( cd "$PKG" && npm run test:process-stress ) > "$REPORT.stress.log" 2>&1
	rc=$?
	grep -E "Test Files|Tests  " "$REPORT.stress.log" | tail -3
	if [ "$rc" != "0" ]; then
		if grep -q "ERR_MODULE_NOT_FOUND" "$REPORT.stress.log"; then
			echo "hint: the real-process cases import workspace builds; run npm run build in ai/agent/tui first" >&2
		fi
		tail -40 "$REPORT.stress.log"
		fail "the process-stress (nightly) face is red (vitest exit $rc); full output: $REPORT.stress.log"
	else
		echo "vitest: exit 0"
	fi
fi

printf '\n'
if [ -n "$FAILED_STEP" ]; then
	printf 'check-process-smoke: RED - %s\n' "$FAILED_STEP" >&2
	exit 1
fi
printf 'check-process-smoke: GREEN (process smoke face matches CI; every skip declared, counted and named)\n'
