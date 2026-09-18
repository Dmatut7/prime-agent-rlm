# Recomputing a ci.yml floor (the recipe, not a script)

The floors in `.github/workflows/ci.yml` are a policy: **a floor is `ceil(0.9 x what the job really
produced in CI)`**. `packages/coding-agent/test/ci-floor-policy.test.ts` recomputes that from the
recorded reading in `scripts/ci-floor-readings.json` and fails when a row disagrees, so the sentence
and the numbers cannot drift apart again.

This file is the recipe for re-deriving a floor after test churn. It is deliberately a procedure
rather than a second source: **`ci.yml` is the only carrier of the floors**, and
`scripts/lib/ci-matrix-row.mjs` is the only reader a gate uses
(`scripts/check-process-smoke.sh` reads the process smoke row through it at run time and refuses
(exit 2) when the row is missing, duplicated, or missing one of its four values). A tool that *held*
the derived numbers would be a second carrier again - that is what the `ci-process-smoke.mjs` module
used to be, and it is gone.

## Recipe

```sh
# 1. pick a green CI run on the branch the floors are meant to gate
gh run list -R Dmatut7/prime-agent-rlm --branch merge/repl-kernel --limit 5 \
  --json databaseId,headSha,conclusion

# 2. read that run's own coverage lines (the gates print them; they are the reading, not a guess)
gh run view <run id> -R Dmatut7/prime-agent-rlm --log | grep -E 'numTotalTests=|tests=[0-9]+ ran='

# 3. per row, ask for the floors the policy wants (this prints, it does not write)
node scripts/check-vitest-coverage.mjs --recompute-floors <report.json> --row "<matrix row name>"

# 4. paste the reading into scripts/ci-floor-readings.json (`rows`, and `source` for the run id)
#    and the floors into the matching ci.yml matrix row - for the process smoke row, into that row:
#    ci.yml is where the local mirror reads it.

# 5. prove the pin agrees
npx vitest --run packages/coding-agent/test/ci-floor-policy.test.ts
bash scripts/check-process-smoke.sh --self-test
```

## Why the process smoke row is special

Its floors used to live in `scripts/lib/ci-process-smoke.mjs`, pinned to `ci.yml` by a test: two
carriers of one number, kept equal by a third file, and the local mirror read the module. The
workflow is now the only carrier and the reader the only parser, so "the floor CI runs" and "the
floor the local mirror gates at" are the same bytes by construction. A row that loses `min_tests`,
`min_ran_tests`, `max_nothing_files` or the `tag_skip_ledger` string is a refusal with the missing
key named, never a gate at an invented default.

## What is still recorded, and why

`scripts/ci-floor-readings.json` survives because it is the *reading* the policy sentence is
justified by (run id, head sha, per-row collected/ran, and the job's own log line verbatim). It is
not a source any gate reads: it is what a human recomputing a floor starts from, and what the policy
test recomputes the sentence from. Its `how_to_refresh` steps are the same recipe as above.

## The two readers, and which one is authoritative

- `scripts/lib/ci-matrix-row.mjs` - authoritative, fail-closed (missing file, missing row, two rows
  with one name, a row with no scalar keys, all exit 2). Used by the local mirror and by the pin.
- `scripts/check-vitest-coverage.mjs`'s `scanCiRow` - advisory, tolerant by design: the recompute
  tool has to survive a row name that is not there so it can print "no such row" instead of dying.
  It never feeds a gate.

Both read the same file, so they cannot disagree about the *source*; only about how strictly they
insist on it.
