#!/usr/bin/env bash
# CI-5: the script you can ask "what did the latest run conclude?" instead of remembering.
#
# Why this exists
# ---------------
# "CI is green" was quoted from memory: nothing tied a green claim to a run id, and a push that
# supersedes an in-flight run leaves `cancelled` runs on the same branch, so "the latest run" on a
# branch is not evidence about the revision you are pushing. This script answers the only checkable
# question - which run, which revision, which conclusion - and fails closed when `gh` cannot answer,
# so an unanswerable query can never read as green.
#
# Usage
# -----
#   bash scripts/latest-ci-run.sh [--branch B] [--commit SHA] [--limit N] [--require-success]
#   bash scripts/latest-ci-run.sh --self-test
#
#   --commit SHA       the revision the verdict must be about (default: HEAD). With
#                      --require-success the script refuses when that revision has a completed run
#                      that is not success; a revision with no run is reported as "never pushed",
#                      which is not a green verdict either.
#   --limit N          how many recent branch runs to print (default 5).
#
# Sets GH_BIN to substitute the `gh` binary (the self-test does). Exit codes: 0 = answered (and,
# with --require-success, green or unpushed), 1 = red or fail-closed, 2 = usage.
set -euo pipefail

GH_BIN="${GH_BIN:-gh}"
BRANCH=""
COMMIT=""
LIMIT=5
REQUIRE_SUCCESS=0
SELF_TEST=0
die() { echo "latest-ci-run: $*" >&2; exit 2; }

usage() {
	cat >&2 <<'USAGE'
usage: bash scripts/latest-ci-run.sh [--branch B] [--commit SHA] [--limit N] [--require-success]
       bash scripts/latest-ci-run.sh --self-test
USAGE
}

while [ $# -gt 0 ]; do
	case "$1" in
		--self-test) SELF_TEST=1; shift ;;
		--branch) [ $# -ge 2 ] || die "--branch needs an argument"; BRANCH="$2"; shift 2 ;;
		--branch=*) BRANCH="${1#--branch=}"; shift ;;
		--commit) [ $# -ge 2 ] || die "--commit needs an argument"; COMMIT="$2"; shift 2 ;;
		--commit=*) COMMIT="${1#--commit=}"; shift ;;
		--limit) [ $# -ge 2 ] || die "--limit needs an argument"; LIMIT="$2"; shift 2 ;;
		--limit=*) LIMIT="${1#--limit=}"; shift ;;
		--require-success) REQUIRE_SUCCESS=1; shift ;;
		-h|--help) usage; exit 0 ;;
		*) die "unknown option $1" ;;
	esac
done

ask() {
	local branch="$1" commit="$2" limit="$3"
	local json="databaseId,headSha,status,conclusion,workflowName,createdAt,url"
	if [ -n "$commit" ]; then
		"$GH_BIN" run list --commit "$commit" --limit "$limit" --json "$json"
	else
		"$GH_BIN" run list --branch "$branch" --limit "$limit" --json "$json"
	fi
}

report() {
	local branch="$1" commit="$2" limit="$3"
	local raw
	# Fail-closed: a `gh` that is missing, unauthenticated or rate-limited must not read as
	# "nothing to report" - that is the shape of an unearned green claim.
	if ! raw=$(ask "$branch" "$commit" "$limit" 2>&1); then
		echo "latest-ci-run: RED - cannot query GitHub (${GH_BIN} failed); refusing to report a verdict" >&2
		printf '%s\n' "$raw" | sed 's/^/     /' >&2
		return 1
	fi
	printf '%s' "$raw" | node -e '
const fs = require("node:fs");
const [branch, commit, requireSuccess] = process.argv.slice(1);
const raw = fs.readFileSync(0, "utf8");
let runs;
try {
	runs = JSON.parse(raw);
} catch (error) {
	console.error(`latest-ci-run: RED - gh answered something that is not JSON (${error.message}); refusing to report a verdict`);
	process.exit(1);
}
if (!Array.isArray(runs)) {
	console.error("latest-ci-run: RED - gh answered JSON that is not a run list; refusing to report a verdict");
	process.exit(1);
}
const line = (run) =>
	`  #${run.databaseId} ${run.status}/${run.conclusion ?? "-"} ${String(run.headSha ?? "").slice(0, 9)} ` +
	`${run.workflowName ?? "?"} ${run.createdAt ?? "?"} ${run.url ?? ""}`;
console.log(`latest CI runs on branch ${branch || "(commit query)"}: ${runs.length} returned`);
for (const run of runs) console.log(line(run));

if (commit) {
	const forRevision = runs.filter((run) => run.headSha === commit);
	if (forRevision.length === 0) {
		console.log(`revision ${commit.slice(0, 9)}: no CI run - it has never been pushed (or the run is older than the query limit)`);
		process.exit(0);
	}
	const latest = forRevision[0];
	const verdict = latest.status === "completed" ? (latest.conclusion ?? "unknown") : `still ${latest.status}`;
	console.log(`revision ${commit.slice(0, 9)}: latest run #${latest.databaseId} -> ${verdict} (${latest.url ?? ""})`);
	if (requireSuccess === "1" && latest.status === "completed" && latest.conclusion !== "success") {
		console.error(
			`latest-ci-run: RED - revision ${commit.slice(0, 9)} already has run #${latest.databaseId}, concluded ${latest.conclusion}: ` +
				"do not quote this revision as green, and do not push it again expecting a different answer",
		);
		process.exit(1);
	}
}
' "$branch" "$commit" "$REQUIRE_SUCCESS"
}

# ---------------------------------------------------------------------------
# self-test: a canned `gh` proves the verdict plumbing (green, red, fail-closed)
# ---------------------------------------------------------------------------
self_test() {
	local dir
	dir=$(mktemp -d "${TMPDIR:-/tmp}/latest-ci-run-selftest.XXXXXX") || die "cannot mktemp"
	trap "rm -rf '$dir'" EXIT
	local sha="1111111111111111111111111111111111111111"

	make_gh() {
		local path="$1" body="$2"
		printf '#!/usr/bin/env bash\n%s\n' "$body" >"$path"
		chmod +x "$path"
	}
	make_gh "$dir/gh-success" 'printf "%s" "[{\"databaseId\":41,\"headSha\":\"'"$sha"'\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\",\"createdAt\":\"2026-09-15T12:00:00Z\",\"url\":\"https://example.invalid/runs/41\"}]"'
	make_gh "$dir/gh-cancelled" 'printf "%s" "[{\"databaseId\":42,\"headSha\":\"'"$sha"'\",\"status\":\"completed\",\"conclusion\":\"cancelled\",\"workflowName\":\"CI\",\"createdAt\":\"2026-09-15T12:30:00Z\",\"url\":\"https://example.invalid/runs/42\"},{\"databaseId\":40,\"headSha\":\"'"$sha"'\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\",\"createdAt\":\"2026-09-15T11:00:00Z\",\"url\":\"https://example.invalid/runs/40\"}]"'
	make_gh "$dir/gh-unpushed" 'printf "%s" "[]"'
	make_gh "$dir/gh-broken" 'echo "gh: not logged in to any GitHub hosts" >&2; exit 4'
	make_gh "$dir/gh-garbage" 'printf "%s" "not json at all"'

	local mismatches=0
	expect() {
		local name="$1" want="$2" needle="$3" ghbin="$4"; shift 4
		local out rc
		out=$(GH_BIN="$ghbin" "$@" 2>&1) && rc=0 || rc=$?
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

	expect "a green revision names the run id" 0 "#41 completed/success" "$dir/gh-success" \
		report main "$sha" 5
	expect "a cancelled latest run refuses to be quoted as green" 1 "concluded cancelled" "$dir/gh-cancelled" \
		report_required main "$sha" 5
	expect "an unpushed revision says so instead of claiming green" 0 "it has never been pushed" "$dir/gh-unpushed" \
		report_required main "$sha" 5
	expect "an unavailable gh is fail-closed" 1 "cannot query GitHub" "$dir/gh-broken" \
		report_required main "$sha" 5
	expect "non-JSON from gh is fail-closed" 1 "not JSON" "$dir/gh-garbage" \
		report_required main "$sha" 5

	echo "self-test: 5 controls, $mismatches mismatch(es)"
	if [ "$mismatches" != "0" ]; then exit 1; fi
}

report_required() { REQUIRE_SUCCESS=1; report "$@"; }

if [ "$SELF_TEST" = "1" ]; then
	self_test
	exit $?
fi

if [ -z "$BRANCH" ] && [ -z "$COMMIT" ]; then
	BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
	[ -n "$BRANCH" ] && [ "$BRANCH" != "HEAD" ] || die "detached HEAD and no --branch/--commit: say which revision this verdict is about"
fi
if [ -z "$COMMIT" ]; then
	COMMIT=$(git rev-parse HEAD)
fi

report "$BRANCH" "$COMMIT" "$LIMIT"
