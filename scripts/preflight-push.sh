#!/usr/bin/env bash
# Pre-push gate: run the same layers CI runs before touching the remote.
#
# Two failure modes this exists to stop, both seen on 2026-09-15:
#   1. Pushing while a run is still in flight - the new push supersedes it and the
#      commit list fills up with `cancelled` runs that look like failures.
#   2. Pushing after only running the touched test files - CI runs whole shards, so
#      a stale assertion, a platform assumption or a shard-ownership change reddens
#      a revision that was "green locally".
#
# Usage: bash scripts/preflight-push.sh [--skip-tests]
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH="${PREFLIGHT_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

echo "== 1/3 waiting for any in-flight run on $BRANCH =="
for attempt in $(seq 1 60); do
  running=$(gh run list --branch "$BRANCH" --status in_progress --limit 1 --json databaseId --jq 'length' 2>/dev/null || echo 0)
  queued=$(gh run list --branch "$BRANCH" --status queued --limit 1 --json databaseId --jq 'length' 2>/dev/null || echo 0)
  if [ "$running" = "0" ] && [ "$queued" = "0" ]; then echo "   no run in flight"; break; fi
  echo "   a run is still $([ "$running" != "0" ] && echo running || echo queued); waiting (${attempt})"
  sleep 20
  if [ "$attempt" = "60" ]; then echo "   still busy after 20min: refusing to push"; exit 1; fi
done

echo "== 2/3 repo checks (biome + tsgo + installer + browser smoke) =="
npm run check

if [ "${1:-}" != "--skip-tests" ]; then
  echo "== 3/3 the CI test command (same exclusions and sharding CI uses) =="
  ( cd packages/coding-agent && npm run test:ci )
fi

echo "preflight OK - safe to push"
