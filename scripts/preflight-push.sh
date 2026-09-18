#!/usr/bin/env bash
# Pre-push gate: run the same layers CI runs before touching the remote.
#
# Three failure modes this exists to stop, all seen on 2026-09-15:
#   1. Pushing while a run is still in flight - the new push supersedes it and the
#      commit list fills up with `cancelled` runs that look like failures.
#   2. Pushing after only running the touched test files - CI runs whole shards, so
#      a stale assertion, a platform assumption or a shard-ownership change reddens
#      a revision that was "green locally".
#   3. Pushing a tree the gate did not verify - `npm run check` runs `biome check --write`,
#      so a run on a dirty tree certifies bytes that are not the ones the push sends.
#   4. Quoting "CI is green" from memory. Step 4 asks GitHub what the run for *this* revision
#      concluded and prints the run id, so a green claim has a name; when that revision already
#      has a finished non-green run the push is refused unless PREFLIGHT_RED_REVISION_REASON
#      says why the verdict is unrelated.
#
# Which repository steps 2 and 4 are about is decided once, before anything is asked: this checkout
# carries four remotes (origin, fork, upstream, archive-x) and bare `gh` resolved its default
# repository to `upstream`, so both questions were answered about a repository that never sees these
# branches - step 2 read "no run in flight" forever, and step 4 read "never pushed" for a revision
# that had a green run on origin. `latest-ci-run.sh --print-repo` owns that rule; this script asks
# for it and refuses when origin cannot be resolved.
#
# Step 3b mirrors the three specialty CI jobs the local shards do not cover (process smoke, kernel,
# runtime python): `test:ci` excludes the process-smoke file and every `kernel-heavy` file, and the
# Python runtime is its own job, so a preflight without this step certified trees three CI jobs had
# never seen.
#
# Every check here is fail-closed. A gate that cannot tell "verified" from "could not verify"
# prints a certificate it has not earned, so `gh` being missing, failing or answering something
# that is not a run count refuses the push, as does a worktree that differs from HEAD.
#
# Usage: bash scripts/preflight-push.sh [--skip-tests]
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="${PREFLIGHT_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
# The faces step fills these in; initialized here so the closing summary can read them even when
# `--skip-tests` means no face ran at all.
FACES_RED=""
FACES_NOT_RUN=""

echo "== 0/4 the repository these gh questions are about =="
# The rule lives in latest-ci-run.sh (`--print-repo`), which is also the script that asks step 4's
# question, so "which repository does this checkout push to" has one implementation.
if ! repo_output=$(bash "$(dirname "$0")/latest-ci-run.sh" --print-repo 2>&1); then
  echo "   refusing to push: cannot resolve the repository the CI questions are about"
  echo "$repo_output" | sed 's/^/     /'
  exit 1
fi
REPO="$repo_output"
echo "   gh questions are pinned to: $REPO"
# Reported, not enforced: with every question pinned above, a differing default repository only
# changes what a *bare* gh (a human, another script) would answer. Enforcing it here would refuse
# every push from this checkout, which keeps an `upstream` remote on purpose.
if default_repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) &&
  [ -n "$default_repo" ] && [ "$default_repo" != "$REPO" ]; then
  echo "   note: bare gh in this checkout resolves to $default_repo, not origin; every question below names $REPO"
fi

echo "== 1/4 the tree that is about to be pushed =="
if [ -n "${PREFLIGHT_BRANCH:-}" ]; then
  echo "   branch pinned by PREFLIGHT_BRANCH: $BRANCH"
elif [ "$BRANCH" = "HEAD" ]; then
  echo "   detached HEAD and no PREFLIGHT_BRANCH: refusing to push an unlabelled revision"
  exit 1
fi
if ! git diff --quiet HEAD -- || ! git diff --cached --quiet; then
  echo "   the worktree differs from HEAD: refusing to push (npm run check rewrites files too)"
  git status --short
  exit 1
fi
untracked=$(git ls-files --others --exclude-standard)
if [ -n "$untracked" ]; then
  # Not fatal: untracked files are not pushed. Printed so a stray working file is not mistaken
  # for part of what was verified. `sed -n` rather than `head`: a reader that exits early sends
  # SIGPIPE to the writer, and `set -o pipefail` would turn that into a failed check.
  echo "   untracked files present (not pushed, not verified):"
  echo "$untracked" | sed -n '1,20p' | sed 's/^/     /'
fi
echo "   worktree matches HEAD"

echo "== 2/4 waiting for any in-flight run on $BRANCH =="
for attempt in $(seq 1 60); do
  # Fail-closed: the status of `gh` is read, not discarded. An unavailable or failing `gh` used to
  # read as "nothing in flight" and still print the success line at the end.
  if ! gh_output=$(gh run list -R "$REPO" --branch "$BRANCH" --status in_progress --limit 1 --json databaseId --jq 'length' 2>&1); then
    echo "   gh run list failed: refusing to push"
    echo "$gh_output" | sed 's/^/     /'
    exit 1
  fi
  case "$gh_output" in
    ''|*[!0-9]*)
      echo "   gh answered something that is not a run count: refusing to push"
      echo "$gh_output" | sed 's/^/     /'
      exit 1
      ;;
  esac
  running="$gh_output"
  if ! gh_queued=$(gh run list -R "$REPO" --branch "$BRANCH" --status queued --limit 1 --json databaseId --jq 'length' 2>&1); then
    echo "   gh run list failed: refusing to push"
    echo "$gh_queued" | sed 's/^/     /'
    exit 1
  fi
  case "$gh_queued" in
    ''|*[!0-9]*)
      echo "   gh answered something that is not a run count: refusing to push"
      echo "$gh_queued" | sed 's/^/     /'
      exit 1
      ;;
  esac
  queued="$gh_queued"
  if [ "$running" = "0" ] && [ "$queued" = "0" ]; then echo "   no run in flight"; break; fi
  echo "   a run is still $([ "$running" != "0" ] && echo running || echo queued); waiting (${attempt})"
  sleep 20
  if [ "$attempt" = "60" ]; then echo "   still busy after 20min: refusing to push"; exit 1; fi
done

echo "== 3/4 repo checks (biome + tsgo + installer + browser smoke + lockstep) =="
# The lockstep check runs inside `npm run check` too (check:ci-honesty); naming it here means the
# gate's output says which version boundary it verified, and which manifests that boundary covers.
# `--check` writes nothing - a gate that rewrote manifests while certifying a tree would certify
# bytes it changed itself.
npm run check:lockstep
npm run check

if [ "${1:-}" != "--skip-tests" ]; then
  echo "== 3a/4 the specialty jobs the shards do not cover (process smoke, kernel, runtime python) =="
  # The same commands the CI matrix runs, and why each is here instead of in a shard: `test:ci`
  # excludes test/daemon-supervisor-process.test.ts and every `kernel-heavy` file, and the runtime
  # python job is a separate package (see the matrix rows in .github/workflows/ci.yml). A local
  # ladder that skipped them certified trees that three CI jobs had never seen - and the one time
  # it mattered, the file `test:ci` excludes was the file that reddened CI.
  # Measured in this checkout (load-dependent: process smoke read 38.0s on an idle machine and
  # 106.6s under load): process smoke 38-57s, kernel 60s, runtime python 67s.
  # `test:machine-wide` is deliberately NOT mirrored here: it drives `daemon ps`, which stops the
  # developer's live daemon (ci.yml:198-205 records why it runs alone).
  #
  # These run before the component suite on purpose: the suite is the slowest step and it is red for
  # pre-existing reasons in this tree (see the report), so behind it the faces were unreachable and
  # a local ladder reported a red suite while never saying whether the three specialty jobs would
  # have passed. Faces first also means the cheap 2.5 minutes fail before the 6-minute suite runs.
  #
  # A face that is red here refuses the push by default, and says what it could not verify instead
  # of leaving a hole: a red face names itself and its escape, a face whose interpreter or tool is
  # missing is printed as NOT RUN, and both lists are repeated next to "preflight OK" so a partial
  # ladder cannot read as a full one. PREFLIGHT_REQUIRE_ALL_FACES=1 makes "could not run" a refusal.
  run_face() {
    # $1 = face label, $2 = the variable an operator can write a reason into, $3.. = the command
    local face="$1" escape="$2"; shift 2
    if "$@"; then return 0; fi
    echo "   RED: the $face face failed locally"
    FACES_RED="$FACES_RED $face"
    if [ -n "${!escape:-}" ]; then
      echo "   overridden by $escape: ${!escape}"
    else
      echo "   refusing to push: the $face job is red, and CI runs it as its own job."
      echo "   Fix it, or write down why this is machine-local and re-run with"
      echo "   $escape='<written reason>' bash scripts/preflight-push.sh"
      exit 1
    fi
  }
  process_smoke_face() { npm run check:process-smoke; }
  kernel_face() { ( cd packages/coding-agent && npm run test:kernel:ci ); }
  runtime_python_face() { ( cd prime-agent-runtime && uv run python -m unittest discover -s test ); }

  run_face "process smoke" PREFLIGHT_PROCESS_SMOKE_REASON process_smoke_face

  # The kernel-heavy files decide whether to run or skip from a capability probe, so "an interpreter
  # exists" is not "an interpreter that can run these tests": measured in this checkout, `uv run`
  # leaves a prime-agent-runtime/.venv whose contents are not enough (docs/fork/sync-upstream-r3.md
  # says so), and pinning it left three files ALL SKIPPED - which the job's own coverage gate then
  # reddens. The interpreter is accepted only if it imports what CI's seed step requires; otherwise
  # the face is reported as not run, with the seed command, and never silently skipped.
  echo "   -- kernel-heavy (CI job: Test (coding-agent kernel))"
  kernel_probe() { "$1" -P -c 'import rlm.repl, dill, goal, agent_message' >/dev/null 2>&1; }
  kernel_python=""
  kernel_unusable=""
  if [ -n "${PRIME_AGENT_KERNEL_PYTHON:-}" ]; then
    if [ -x "$PRIME_AGENT_KERNEL_PYTHON" ] && kernel_probe "$PRIME_AGENT_KERNEL_PYTHON"; then
      kernel_python="$PRIME_AGENT_KERNEL_PYTHON"
    else
      # Explicitly provided, and unusable: refusing beats silently using another interpreter.
      echo "   RED: PRIME_AGENT_KERNEL_PYTHON=$PRIME_AGENT_KERNEL_PYTHON cannot import rlm.repl,"
      echo "   dill, goal, agent_message; refusing to fall back to another interpreter"
      kernel_unusable="1"
      FACES_RED="$FACES_RED kernel(unusable-PRIME_AGENT_KERNEL_PYTHON)"
    fi
  else
    for candidate in "$(pwd)/prime-agent-runtime/.venv/bin/python" "$HOME/.prime/agent/kernel-venv/bin/python"; do
      [ -x "$candidate" ] || continue
      if kernel_probe "$candidate"; then kernel_python="$candidate"; break; fi
      echo "   ($candidate exists but cannot import the kernel skills: rlm.repl, dill, goal,"
      echo "    agent_message - a bare prime-agent-runtime/.venv is not enough)"
    done
  fi
  if [ -n "$kernel_python" ]; then
    echo "   interpreter: $kernel_python"
    mkdir -p packages/coding-agent/coverage
    run_face "kernel-heavy" PREFLIGHT_KERNEL_REASON kernel_face
  elif [ -z "$kernel_unusable" ]; then
    echo "   SKIPPED: no interpreter that can import the kernel skills (looked for"
    echo "   PRIME_AGENT_KERNEL_PYTHON, prime-agent-runtime/.venv/bin/python and"
    echo "   ~/.prime/agent/kernel-venv/bin/python). Seed one with"
    echo "   'npx tsx packages/coding-agent/src/core/kernel/bootstrap-cli.ts', or set"
    echo "   PRIME_AGENT_KERNEL_PYTHON to one that imports rlm.repl, dill, goal and agent_message."
    FACES_NOT_RUN="$FACES_NOT_RUN kernel(no-usable-interpreter)"
  fi

  echo "   -- runtime python (CI job: Test (runtime python))"
  if command -v uv >/dev/null 2>&1; then
    run_face "runtime python" PREFLIGHT_RUNTIME_PYTHON_REASON runtime_python_face
  else
    echo "   the runtime python job needs uv (CI installs it): refusing to push an unverified runtime"
    exit 1
  fi

  echo "   -- machine-wide: NOT run here by design (it drives daemon ps and stops this machine's own"
  echo "      daemons; CI runs it alone on its own runner)"
  echo "   faces red locally:${FACES_RED:- none}   faces not run locally:${FACES_NOT_RUN:- none}"
  if [ -n "$FACES_NOT_RUN" ] && [ "${PREFLIGHT_REQUIRE_ALL_FACES:-}" = "1" ]; then
    echo "   refusing to push: PREFLIGHT_REQUIRE_ALL_FACES=1 and these faces could not run:$FACES_NOT_RUN"
    exit 1
  fi

  echo "== 3b/4 tests: the CI test command (same exclusions and sharding CI uses) =="
  ( cd packages/coding-agent && npm run test:ci )
fi



# Re-checked after the checks: `npm run check` writes files, and a gate that certified the tree
# before them would not have noticed.
if ! git diff --quiet HEAD --; then
  echo "the checks rewrote tracked files: refusing to push; commit them and re-run"
  git status --short
  exit 1
fi

echo "== 4/4 the run any 'CI is green' claim has to name =="
head_sha=$(git rev-parse HEAD)
if ! verdict_output=$(bash "$(dirname "$0")/latest-ci-run.sh" --branch "$BRANCH" --commit "$head_sha" --require-success 2>&1); then
  echo "$verdict_output" | sed 's/^/   /'
  if [ -n "${PREFLIGHT_RED_REVISION_REASON:-}" ]; then
    echo "   overridden by PREFLIGHT_RED_REVISION_REASON: $PREFLIGHT_RED_REVISION_REASON"
  else
    echo "   refusing to push: $head_sha already has a finished CI run that is not green."
    echo "   Pushing it again does not make it green. Fix the failure, or set"
    echo "   PREFLIGHT_RED_REVISION_REASON=<written reason> if this push is unrelated to that verdict."
    exit 1
  fi
else
  echo "$verdict_output" | sed 's/^/   /'
fi

echo "preflight OK - worktree == HEAD, no run in flight, checks green, revision verdict printed: safe to push"
if [ -n "$FACES_RED$FACES_NOT_RUN" ]; then
  echo "note: this was a PARTIAL ladder - faces red:${FACES_RED:- none}  faces not run:${FACES_NOT_RUN:- none}"
fi
