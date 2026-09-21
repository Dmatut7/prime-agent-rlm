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
# Which repository the answer is about
# -----------------------------------
# Every question here is about *this checkout's* revision, and this checkout carries four remotes.
# Bare `gh` resolves its default repository from the checkout's remotes - here it resolved to
# `upstream` (PrimeIntellect-ai/prime-agent) while every push goes to `origin` (the fork that
# actually runs CI), so "what did CI conclude for this revision?" was answered about a repository
# that has never seen the revision and returned an empty run list, which then read as "never
# pushed". Every `gh` call below therefore names the repository with `-R`, the repository is
# resolved once from `origin` by {@link --print-repo}, and an origin that cannot be resolved is a
# refusal instead of a fall back to whatever `gh` would have picked.
#
# An empty answer is not evidence on its own either: before an empty run list is read as "this
# revision has no run", the script asks the same repository whether it can answer *any* run at
# all. A repository that answers zero runs to both questions is reported RED, because that is the
# shape of asking the wrong repository (or of a repository whose runs this token cannot see) - and
# it is exactly the shape the `-R` fix above removes for this checkout.
#
# Usage
# -----
#   bash scripts/latest-ci-run.sh [--branch B] [--commit SHA] [--limit N] [--require-success]
#   bash scripts/latest-ci-run.sh --print-repo
#   bash scripts/latest-ci-run.sh --self-test
#
#   --commit SHA       the revision the verdict must be about (default: HEAD). With
#                      --require-success the script refuses when that revision has a completed run
#                      that is not success; a revision with no run is reported as "never pushed",
#                      which is not a green verdict either.
#   --limit N          how many recent branch runs to print (default 5).
#   --print-repo       print the repository every gh question is pinned to (resolved from origin,
#                      or `PREFLIGHT_GH_REPO`) and exit; a checkout whose origin cannot be resolved
#                      exits 1 so a caller can refuse before asking anything.
#
# Environment: GH_BIN substitutes the `gh` binary (the self-test does); PREFLIGHT_GH_REPO pins the
# repository by hand; PREFLIGHT_REQUIRE_RUN_FOR_REVISION=1 refuses a revision that has no run of
# its own (the strict reading, off by default because a pre-push gate runs before the push that
# creates the run).
#
# Exit codes: 0 = answered (and, with --require-success, green, or unpushed with an answerable
# repository named), 1 = red or fail-closed, 2 = usage.
set -euo pipefail

GH_BIN="${GH_BIN:-gh}"
BRANCH=""
COMMIT=""
LIMIT=5
REQUIRE_SUCCESS=0
SELF_TEST=0
PRINT_REPO=0
die() { echo "latest-ci-run: $*" >&2; exit 2; }
# A refused question rather than a usage error: exit 1, like the other fail-closed paths, so a
# caller (`preflight-push.sh`) treats "I cannot tell which repository this is about" as a refusal.
fail_closed() { echo "latest-ci-run: RED - $*" >&2; exit 1; }

# The single implementation of "which repository does this checkout push to". `--print-repo` hands
# the answer to `preflight-push.sh` instead of that script re-deriving it, so the rule lives once.
# Accepts the remote shapes git hands out (https, git@, ssh with a port) and nothing else: a remote
# that is not `<owner>/<repo>` is a refusal, not something to guess about.
resolve_repo() {
	local url repo
	url=$(git remote get-url origin 2>/dev/null) || return 1
	[ -n "$url" ] || return 1
	repo=$(printf '%s' "$url" | sed -E 's#^[A-Za-z][A-Za-z0-9+.-]*://##; s#^[^/@]*@##; s#^[^/:]+[:/]([0-9]+/)?##; s#\.git$##')
	case "$repo" in
		'' | /* | *//* | */ | ./* ) return 1 ;;
	esac
	# `<owner>/<repo>` or `<host>/<owner>/<repo>`: gh takes both, a local path does not qualify.
	printf '%s' "$repo" | grep -Eq '^([A-Za-z0-9._-]+/)+[A-Za-z0-9._-]+$' || return 1
	printf '%s' "$repo"
}

usage() {
	cat >&2 <<'USAGE'
usage: bash scripts/latest-ci-run.sh [--branch B] [--commit SHA] [--limit N] [--require-success]
       bash scripts/latest-ci-run.sh --print-repo
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
		--print-repo) PRINT_REPO=1; shift ;;
		-h|--help) usage; exit 0 ;;
		*) die "unknown option $1" ;;
	esac
done

ask() {
	local branch="$1" commit="$2" limit="$3"
	local json="databaseId,headSha,status,conclusion,workflowName,createdAt,url,headBranch"
	if [ -n "$commit" ]; then
		"$GH_BIN" run list -R "$REPO" --commit "$commit" --limit "$limit" --json "$json"
	else
		"$GH_BIN" run list -R "$REPO" --branch "$branch" --limit "$limit" --json "$json"
	fi
}

# "Can this repository answer about runs at all?" Asked only after an empty answer, with the same
# -R and no branch/commit filter, so an empty result from *this* question means the repository
# itself is the problem - the shape of asking a repository this checkout does not push to.
ask_probe() {
	"$GH_BIN" run list -R "$REPO" --limit 1 --json "databaseId,status,conclusion,workflowName,createdAt,url,headBranch"
}

report() {
	local branch="$1" commit="$2" limit="$3"
	local raw probe probe_json="null"
	# Fail-closed: a `gh` that is missing, unauthenticated or rate-limited must not read as
	# "nothing to report" - that is the shape of an unearned green claim.
	if ! raw=$(ask "$branch" "$commit" "$limit" 2>&1); then
		echo "latest-ci-run: RED - cannot query GitHub (${GH_BIN} failed); refusing to report a verdict" >&2
		printf '%s\n' "$raw" | sed 's/^/     /' >&2
		return 1
	fi
	# An empty run list is not evidence by itself (see the header): before it can be read as "this
	# revision has no run", the same repository is asked whether it can answer about runs at all.
	if [ "[]" = "$(printf '%s' "$raw" | tr -d '[:space:]')" ]; then
		if ! probe=$(ask_probe 2>&1); then
			echo "latest-ci-run: RED - the run list came back empty and the repository liveness query (${GH_BIN}) failed; refusing to read an empty answer as \"never pushed\"" >&2
			printf '%s\n' "$probe" | sed 's/^/     /' >&2
			return 1
		fi
		probe_json="${probe:-null}"
	fi
	printf '{"runs":%s,"probe":%s,"repo":"%s"}' "$raw" "$probe_json" "$REPO" | node -e '
const fs = require("node:fs");
const [branch, commit, requireSuccess] = process.argv.slice(1);
const raw = fs.readFileSync(0, "utf8");
let payload;
try {
	payload = JSON.parse(raw);
} catch (error) {
	console.error(`latest-ci-run: RED - gh answered something that is not JSON (${error.message}); refusing to report a verdict`);
	process.exit(1);
}
const runs = payload.runs;
const probe = payload.probe;
const repo = payload.repo;
if (!Array.isArray(runs)) {
	console.error("latest-ci-run: RED - gh answered JSON that is not a run list; refusing to report a verdict");
	process.exit(1);
}
const line = (run) =>
	`  #${run.databaseId} ${run.status}/${run.conclusion ?? "-"} ${String(run.headSha ?? "").slice(0, 9)} ` +
	`${run.workflowName ?? "?"} ${run.createdAt ?? "?"} ${run.url ?? ""}`;
// The repository is part of every line, and so is the question that was asked: an answer about the
// wrong repository used to be indistinguishable from an answer about this one (both printed
// "0 returned"), and with `--branch B --commit SHA` the question is the revision, so a line that
// named the branch while counting revision runs read like a branch with no runs.
const asked = commit ? `revision ${commit.slice(0, 9)}` : `branch ${branch}`;
console.log(`latest CI runs for ${asked} in ${repo}: ${runs.length} returned`);
for (const run of runs) console.log(line(run));

// Empty answer: say which repository answered, and refuse when that repository cannot answer at all.
if (runs.length === 0) {
	if (!Array.isArray(probe)) {
		console.error("latest-ci-run: RED - the repository liveness query answered something that is not a run list; refusing to report a verdict");
		process.exit(1);
	}
	if (probe.length === 0) {
		console.error(
			`latest-ci-run: RED - repository ${repo} reports no CI runs at all, so an empty answer from it cannot be read as "never pushed"; ` +
				"the repository these questions are pinned to looks wrong (check origin, or set PREFLIGHT_GH_REPO)",
		);
		process.exit(1);
	}
	const newest = probe[0];
	console.log(
		`  repository ${repo} does answer: newest run #${newest.databaseId} on ${newest.headBranch ?? "?"} ` +
			`${newest.status}/${newest.conclusion ?? "-"} - the empty answer above is about this revision, not about an unreachable repository`,
	);
}

if (commit) {
	const forRevision = runs.filter((run) => run.headSha === commit);
	if (forRevision.length === 0) {
		console.log(`revision ${commit.slice(0, 9)}: no CI run in ${repo} - it has never been pushed (or the run is older than the query limit)`);
		// Strict reading, off by default: a pre-push gate runs *before* the push that creates the
		// run, so "no run yet" is the ordinary state of the revision being pushed. Callers that
		// demand a run of the revision itself (a release gate) turn this on.
		if (process.env.PREFLIGHT_REQUIRE_RUN_FOR_REVISION === "1") {
			console.error(
				`latest-ci-run: RED - revision ${commit.slice(0, 9)} has no run in ${repo} at all and PREFLIGHT_REQUIRE_RUN_FOR_REVISION=1: ` +
					"no run exists to back a green claim for this revision",
			);
			process.exit(1);
		}
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

	# The repository under test, planted rather than resolved: the self-test must not depend on the
	# checkout it runs in (and must not read an inherited PREFLIGHT_GH_REPO, which would change what
	# every control below asserts).
	unset PREFLIGHT_GH_REPO
	# Same independence for git itself: hooks run with GIT_DIR (absolute in a linked worktree) and
	# GIT_INDEX_FILE exported, and both override `git -C <nested-repo>` discovery, so the resolver
	# controls' nested repositories would resolve against this checkout's repo instead (git init
	# no-ops, `remote add origin` reports "already exists" and exits 3).
	unset GIT_DIR GIT_INDEX_FILE
	REPO="selftest/fixture-repo"
	export GH_ARGS_LOG="$dir/gh-args.log"
	: >"$GH_ARGS_LOG"

	make_gh() {
		local path="$1" body="$2"
		printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" >> "${GH_ARGS_LOG:-/dev/null}"\n%s\n' "$body" >"$path"
		chmod +x "$path"
	}
	# One run of the asked-about revision, concluded success: nothing else is queried.
	make_gh "$dir/gh-success" 'printf "%s" "[{\"databaseId\":41,\"headSha\":\"'"$sha"'\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\",\"createdAt\":\"2026-09-15T12:00:00Z\",\"url\":\"https://example.invalid/runs/41\",\"headBranch\":\"main\"}]"'
	make_gh "$dir/gh-cancelled" 'printf "%s" "[{\"databaseId\":42,\"headSha\":\"'"$sha"'\",\"status\":\"completed\",\"conclusion\":\"cancelled\",\"workflowName\":\"CI\",\"createdAt\":\"2026-09-15T12:30:00Z\",\"url\":\"https://example.invalid/runs/42\",\"headBranch\":\"main\"}]"'
	# "This revision has no run, but the repository does answer": the empty answer is read as
	# never-pushed, and only after the liveness query came back with a run of its own.
	make_gh "$dir/gh-unpushed" 'case " $* " in *" --commit "*) printf "%s" "[]";; *) printf "%s" "[{\"databaseId\":39,\"headSha\":\"2222222222222222222222222222222222222222\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\",\"createdAt\":\"2026-09-15T10:00:00Z\",\"url\":\"https://example.invalid/runs/39\",\"headBranch\":\"main\"}]";; esac'
	# The shape the -R fix exists for: this repository answers nothing, for anything. Bare `gh` did
	# exactly that once its default repository resolved to upstream.
	make_gh "$dir/gh-empty-repo" 'printf "%s" "[]"'
	make_gh "$dir/gh-broken" 'echo "gh: not logged in to any GitHub hosts" >&2; exit 4'
	make_gh "$dir/gh-garbage" 'printf "%s" "not json at all"'
	# Empty run list, and the liveness query itself cannot be answered.
	make_gh "$dir/gh-probe-broken" 'case " $* " in *" --commit "*) printf "%s" "[]";; *) echo "gh: HTTP 502 from the API" >&2; exit 4;; esac'

	local mismatches=0 controls=0
	expect() {
		local name="$1" want="$2" needle="$3" ghbin="$4"; shift 4
		local out rc
		controls=$((controls + 1))
		# A control that needs an environment variable plants it for this call only; `env` cannot
		# run a shell function, so the variable is exported around the call instead.
		if [ -n "${EXPECT_ENV:-}" ]; then export "${EXPECT_ENV%%=*}=${EXPECT_ENV#*=}"; fi
		out=$(GH_BIN="$ghbin" "$@" 2>&1) && rc=0 || rc=$?
		if [ -n "${EXPECT_ENV:-}" ]; then unset "${EXPECT_ENV%%=*}"; fi
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
	expect "the answer names the repository it is about" 0 "in selftest/fixture-repo" "$dir/gh-success" \
		report main "$sha" 5
	expect "the answer says which question it asked (revision, not branch)" 0 "for revision 111111111 in selftest/fixture-repo" "$dir/gh-success" \
		report main "$sha" 5
	expect "a branch-only question says so" 0 "for branch main in selftest/fixture-repo" "$dir/gh-success" \
		report main "" 5
	expect "a cancelled latest run refuses to be quoted as green" 1 "concluded cancelled" "$dir/gh-cancelled" \
		report_required main "$sha" 5
	expect "an unpushed revision says so instead of claiming green" 0 "it has never been pushed" "$dir/gh-unpushed" \
		report_required main "$sha" 5
	expect "an unpushed revision still shows that the repository answers" 0 "does answer: newest run #39" "$dir/gh-unpushed" \
		report_required main "$sha" 5
	expect "a repository that answers no runs at all is RED, not \"never pushed\"" 1 "reports no CI runs at all" "$dir/gh-empty-repo" \
		report_required main "$sha" 5
	expect "an empty run list with an unanswerable liveness query is fail-closed" 1 "liveness query" "$dir/gh-probe-broken" \
		report_required main "$sha" 5
	expect "an unavailable gh is fail-closed" 1 "cannot query GitHub" "$dir/gh-broken" \
		report_required main "$sha" 5
	expect "non-JSON from gh is fail-closed" 1 "not JSON" "$dir/gh-garbage" \
		report_required main "$sha" 5
	EXPECT_ENV="PREFLIGHT_REQUIRE_RUN_FOR_REVISION=1" \
		expect "the strict reading refuses a revision with no run of its own" 1 "has no run in selftest/fixture-repo" "$dir/gh-unpushed" \
		report_required main "$sha" 5
	unset EXPECT_ENV

	# The heart of the fix, pinned as an argument log rather than as a sentence: every question must
	# carry `-R <repo>`. A query that loses the flag leaves the repository to `gh`, which is how the
	# verdict was once asked about upstream.
	: >"$GH_ARGS_LOG"
	GH_BIN="$dir/gh-success" report main "$sha" 5 >/dev/null 2>&1 || true
	controls=$((controls + 1))
	if grep -qx -- "-R" "$GH_ARGS_LOG" && grep -qx -- "selftest/fixture-repo" "$GH_ARGS_LOG"; then
		printf 'ok   every gh question carries -R <repo> (queries recorded: %s)\n' "$(grep -c -- "-R" "$GH_ARGS_LOG")"
	else
		mismatches=$((mismatches + 1))
		printf 'FAIL every gh question must carry -R <repo>; recorded arguments:\n'
		sed 's/^/       /' "$GH_ARGS_LOG"
	fi

	# The resolver itself: one implementation, and it refuses rather than guessing.
	resolver_case() {
		local name="$1" want_rc="$2" url="$3" want_out="$4"
		local repo out rc
		controls=$((controls + 1))
		repo="$dir/resolver-$controls"
		mkdir -p "$repo"
		git init -q "$repo" >/dev/null 2>&1
		[ -n "$url" ] && git -C "$repo" remote add origin "$url"
		out=$(cd "$repo" && resolve_repo 2>&1) && rc=0 || rc=$?
		if [ "$rc" = "$want_rc" ] && { [ -z "$want_out" ] || [ "$out" = "$want_out" ]; }; then
			printf 'ok   %s (exit %s)\n' "$name" "$rc"
		else
			mismatches=$((mismatches + 1))
			printf 'FAIL %s (want exit %s / "%s", got exit %s / "%s")\n' "$name" "$want_rc" "$want_out" "$rc" "$out"
		fi
	}
	resolver_case "an https origin resolves to owner/repo" 0 "https://github.com/fixture/example.git" "fixture/example"
	resolver_case "a git@ origin resolves to owner/repo" 0 "git@github.com:fixture/example.git" "fixture/example"
	resolver_case "an ssh origin with a port resolves to owner/repo" 0 "ssh://git@github.com:22/fixture/example.git" "fixture/example"
	resolver_case "a local-path origin is refused, not guessed" 1 "$dir/somewhere" ""
	resolver_case "a checkout without origin is refused" 1 "" ""

	echo "self-test: $controls controls, $mismatches mismatch(es)"
	if [ "$mismatches" != "0" ]; then exit 1; fi
}

report_required() { REQUIRE_SUCCESS=1; report "$@"; }

if [ "$PRINT_REPO" = "1" ]; then
	if [ -n "${PREFLIGHT_GH_REPO:-}" ]; then
		printf '%s\n' "$PREFLIGHT_GH_REPO"
		exit 0
	fi
	if REPO=$(resolve_repo); then
		printf '%s\n' "$REPO"
		exit 0
	fi
	echo "latest-ci-run: cannot resolve the repository: origin is missing or is not an <owner>/<repo> remote; set PREFLIGHT_GH_REPO=<owner/repo>" >&2
	exit 1
fi

if [ "$SELF_TEST" = "1" ]; then
	self_test
	exit $?
fi

# The repository every question is pinned to: `origin`, unless the operator names one.
REPO="${PREFLIGHT_GH_REPO:-}"
if [ -z "$REPO" ]; then
	if ! REPO=$(resolve_repo); then
		fail_closed "cannot resolve the repository from origin; refusing to let gh pick one of this checkout's four remotes"
	fi
fi

if [ -z "$BRANCH" ] && [ -z "$COMMIT" ]; then
	BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
	[ -n "$BRANCH" ] && [ "$BRANCH" != "HEAD" ] || die "detached HEAD and no --branch/--commit: say which revision this verdict is about"
fi
if [ -z "$COMMIT" ]; then
	COMMIT=$(git rev-parse HEAD)
fi

report "$BRANCH" "$COMMIT" "$LIMIT"
