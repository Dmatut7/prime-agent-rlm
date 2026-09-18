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
#   3. The CI coverage gate at the CI floors (min_tests / min_ran_tests / max_nothing_files,
#      read from `scripts/lib/ci-process-smoke.mjs` - the single source `.github/workflows/ci.yml`
#      is pinned to; `crash-handlers-process` is the one file allowed to run nothing, because all
#      four of its tests carry the `process-stress` tag).
#   4. The CI tag-skip ledger, from the same module: every `process-stress` skip this job does not
#      run, declared per file with a count and a reason.
#      The judgement is the tag, not the environment: `vitest.config.ts` sets
#      `tagsFilter: ["!process-stress", "!kernel-heavy"]` unconditionally, so those
#      tests are skipped on every platform and under every env; the nightly
#      `nightly-process-stress.yml` is where they do run.
#
# Usage
# -----
#   bash scripts/check-process-smoke.sh                 # the CI face (green at the pinned reading:
#                                                       # collected 24 | ran 12 | skipped 12, per
#                                                       # scripts/ci-floor-readings.json)
#   bash scripts/check-process-smoke.sh --with-stress   # + the nightly face (`test:process-stress`)
#   bash scripts/check-process-smoke.sh --self-test     # prove all three instruments can still go red
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
elif git -C "$SCRIPT_DIR" rev-parse --show-toplevel >/dev/null 2>&1; then
	ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
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

# The floors and the declared skips come from scripts/lib/ci-process-smoke.mjs - the single source
# that `.github/workflows/ci.yml`'s matrix row "coding-agent process smoke" is pinned to by
# packages/coding-agent/test/ci-floor-policy.test.ts. They used to be hand-copied into this file,
# and the only thing holding the two copies together was a sentence in a doc telling the next
# editor to change both. No fallback here on purpose: a missing or unreadable module aborts the
# gate instead of letting it run at some invented default.
CONFIG_MODULE="$ROOT/scripts/lib/ci-process-smoke.mjs"
[ -f "$CONFIG_MODULE" ] || {
	echo "check-process-smoke: missing $CONFIG_MODULE (the floors and the tag-skip ledger live there)" >&2
	exit 2
}
SMOKE_CONFIG="$(node "$CONFIG_MODULE" --shell)" || {
	echo "check-process-smoke: cannot read $CONFIG_MODULE (node exit $?)" >&2
	exit 2
}
MIN_TESTS=""; MIN_RAN_TESTS=""; MAX_NOTHING_FILES=""; LEDGER=""
while IFS= read -r config_line; do
	[ -n "$config_line" ] || continue
	# Split on the first `=` only: the ledger value is `path=count:reason;;path=count:reason`.
	case "${config_line%%=*}" in
		MIN_TESTS) MIN_TESTS="${config_line#*=}" ;;
		MIN_RAN_TESTS) MIN_RAN_TESTS="${config_line#*=}" ;;
		MAX_NOTHING_FILES) MAX_NOTHING_FILES="${config_line#*=}" ;;
		LEDGER) LEDGER="${config_line#*=}" ;;
		*) echo "check-process-smoke: $CONFIG_MODULE printed an unknown key ${config_line%%=*}" >&2; exit 2 ;;
	esac
done <<< "$SMOKE_CONFIG"
for config_key in MIN_TESTS MIN_RAN_TESTS MAX_NOTHING_FILES LEDGER; do
	[ -n "${!config_key}" ] || {
		echo "check-process-smoke: $CONFIG_MODULE returned no $config_key" >&2
		exit 2
	}
done
echo "floors from ${CONFIG_MODULE#"$ROOT"/}: min_tests=$MIN_TESTS min_ran_tests=$MIN_RAN_TESTS max_nothing_files=$MAX_NOTHING_FILES"

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
	node "$CONFIG_MODULE" --self-test || rc=1
	if [ "$rc" != "0" ]; then
		echo "check-process-smoke: self-test RED (an instrument can no longer detect its drift)" >&2
		exit 1
	fi
	echo "check-process-smoke: self-test GREEN (coverage gate, tag-skip ledger and the floor module all plant their own red)"
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

step "4/4 CI tag-skip ledger (every declared skip counted and named)"
if [ -f "$REPORT" ]; then
	bash "$ROOT/scripts/check-tag-skip-ledger.sh" "$REPORT" --ledger "$LEDGER"
	rc=$?
	[ "$rc" = "0" ] || fail "check-tag-skip-ledger.sh exit $rc"
else
	fail "ledger gate skipped: no report"
fi

if [ "$WITH_STRESS" = "1" ]; then
	step "5/5 nightly face: npm run test:process-stress (the tag-filtered tests)"
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
