#!/usr/bin/env bash
# Merge gate: the three details that bit us on 2026-09-15.
#
#   1. A stale branch (not based on current HEAD) can quietly re-introduce an older
#      version of a file that main has since changed.
#   2. The shared working tree can hold another lane's uncommitted work; a plain
#      `git add -A` then commits it.
#   3. A hand-resolved conflict can swallow the other side's change.
#
# Usage: bash scripts/merge-preflight.sh <branch> [--commit]
set -euo pipefail
cd "$(dirname "$0")/.."
BR="${1:?usage: merge-preflight.sh <branch> [--commit]}"
HEAD_SHA=$(git rev-parse HEAD)

echo "== 1/4 branch base is an ancestor of HEAD (stale-branch check) =="
BASE=$(git merge-base HEAD "$BR")
if [ "$BASE" != "$HEAD_SHA" ]; then
  echo "   WARNING: $BR forked at $BASE, HEAD is $HEAD_SHA."
  echo "   Re-check that no file it touches was changed on main since that fork:"
  for f in $(git diff --name-only "$BASE" "$BR"); do
    if [ -n "$(git diff --name-only "$BASE" "$HEAD_SHA" -- "$f")" ]; then
      echo "     BOTH SIDES: $f"
    fi
  done
fi

echo "== 2/4 no foreign uncommitted work in this tree =="
DIRTY=$(git status --porcelain | grep -v '^??' | awk '{print $2}' || true)
if [ -n "$DIRTY" ]; then
  echo "   refusing: staged/modified files present (commit or stash your own first):"
  echo "$DIRTY" | sed 's/^/     /'
  exit 1
fi

echo "== 3/4 merge (no commit yet) =="
BR_TIP=$(git rev-parse "$BR")
if ! git merge --no-commit --no-ff "$BR"; then
  echo "   CONFLICTS: resolve by hand in the tree, then: git commit -m ... (this gate
   cannot re-verify once a merge is in progress; re-run it before any future merge)."
  git diff --name-only --diff-filter=U | sed 's/^/     /'
  exit 1
fi

echo "== 4/4 nothing from main was swallowed =="
echo "   anchor: HEAD=$HEAD_SHA base=$BASE branch=$BR_TIP"
LOST=0
for f in $(git diff --name-only "$BASE" "$HEAD_SHA"); do
  b=$(git rev-parse "$BASE:$f" 2>/dev/null || true)
  m=$(git rev-parse "MERGE_HEAD:$f" 2>/dev/null || true)
  now=$(git hash-object "$f" 2>/dev/null || true)
  if [ -n "$b" ] && [ "$now" = "$b" ] && [ -n "$(git diff --name-only "$BASE" "$HEAD_SHA" -- "$f")" ]; then
    echo "     SWALLOWED: $f (working tree matches the merge base, not HEAD)"
    LOST=1
  fi
done
if [ "$LOST" = "1" ]; then echo "   refusing: main-side changes were lost in this merge"; exit 1; fi

if [ "${2:-}" = "--commit" ]; then
  git commit -q -m "merge: $BR"
  echo "merged and committed"
else
  echo "checks passed; the merge is staged but uncommitted (pass --commit to commit)"
fi
