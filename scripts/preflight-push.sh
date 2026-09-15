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
#
# Every check here is fail-closed. A gate that cannot tell "verified" from "could not verify"
# prints a certificate it has not earned, so `gh` being missing, failing or answering something
# that is not a run count refuses the push, as does a worktree that differs from HEAD.
#
# Usage: bash scripts/preflight-push.sh [--skip-tests]
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="${PREFLIGHT_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

echo "== 1/3 the tree that is about to be pushed =="
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

echo "== 2/3 waiting for any in-flight run on $BRANCH =="
for attempt in $(seq 1 60); do
  # Fail-closed: the status of `gh` is read, not discarded. An unavailable or failing `gh` used to
  # read as "nothing in flight" and still print the success line at the end.
  if ! gh_output=$(gh run list --branch "$BRANCH" --status in_progress --limit 1 --json databaseId --jq 'length' 2>&1); then
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
  if ! gh_queued=$(gh run list --branch "$BRANCH" --status queued --limit 1 --json databaseId --jq 'length' 2>&1); then
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

echo "== 3/3 repo checks (biome + tsgo + installer + browser smoke) =="
npm run check

if [ "${1:-}" != "--skip-tests" ]; then
  echo "== tests: the CI test command (same exclusions and sharding CI uses) =="
  ( cd packages/coding-agent && npm run test:ci )
fi

# Re-checked after the checks: `npm run check` writes files, and a gate that certified the tree
# before them would not have noticed.
if ! git diff --quiet HEAD --; then
  echo "the checks rewrote tracked files: refusing to push; commit them and re-run"
  git status --short
  exit 1
fi

echo "preflight OK - worktree == HEAD, no run in flight, checks green: safe to push"
