# Changelog fragments

One `<slug>.md` per PR containing the bullet line(s) (e.g. `- Fixed ...`) that describe the change
for this package. `scripts/release.mjs` folds these into the release section of CHANGELOG.md and
deletes them. See CONTRIBUTING.md.

## On this fork line

Fragments here are collected, not consumed. `scripts/release.mjs` is the only thing that folds them
into a release section, and on this checkout it refuses to run at all: it sits behind the fork gate
(no `npm publish`, no `v*` tag - see `scripts/lib/fork-gate.mjs`), and this line's `CHANGELOG.md` is
written by hand from the fork ledger in `docs/fork/merge-upstream-20260917.md`. The pull-request
check that requires a fragment is therefore scoped to the upstream repository
(`.github/workflows/changelog-fragment.yml`), and the fragments already in this tree are kept as the
written backlog of what each change was. Adding one here is still worth doing - it is the text a
future release section would be assembled from - it is simply not enforced on this line.
