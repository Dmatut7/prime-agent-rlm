# The digest gate's "no hand-written value" negative leg (re-runnable)

**For**: the parent's request that the `DAEMON_SCHEMA_ID` mutation leg already established by the
terminal-review seat be landed as a re-runnable procedure with expected output.
**Base**: `8ed6d73bc813891679dec7bd11f2160ff218abda`. **Instrument**: `packages/coding-agent/test/daemon-protocol.test.ts`.

## 1. What the gate is

`DAEMON_SCHEMA_ID` is a **wire identity**: a client and a daemon compare it at handshake, and the
value must be *derived from the actual wire type shapes*, never typed by hand. The recipe lives in
the test: `readDaemonSchemaSliceSources()` (`test/daemon-protocol.test.ts:64-…`) slices the request,
saved-session and outbound hemispheres out of `daemon-protocol.ts` (plus the wrapper/contract files
added at rev35) and hashes them, and the pin

```
test/daemon-protocol.test.ts > daemon protocol helpers > keeps the advertised schema identity synchronized with wire type shapes
```

asserts that the constant equals the recomputed digest. A hand-written digit (or a shape edit that
the recipe does not cover) turns it red - the F1 lesson, and the reason the CHANGELOG says
"digest 由测试机器重算，禁手写".

## 2. Procedure (scratch worktree - the mutant never touches the delivery tree)

```bash
# once
git -C /tmp/fixD worktree add /tmp/fixD-scratch HEAD
ln -sfn /tmp/fixD/node_modules /tmp/fixD-scratch/node_modules
for p in agent ai coding-agent tui; do ln -sfn /tmp/fixD/packages/$p/node_modules /tmp/fixD-scratch/packages/$p/node_modules; done

# the leg (baseline -> mutate -> restore), full script: /tmp/fixD/logs/mut-digest-negative-leg.sh
bash /tmp/fixD/logs/mut-digest-negative-leg.sh
```

The mutation is a single-anchor textual replacement, applied by
`/tmp/fixD/logs/apply-mutation.py`, which **refuses to run** if the anchor is missing or not unique
(so a mutant run can never "pass" by having changed nothing):

```python
old = 'export const DAEMON_SCHEMA_ID = "protocol-7-schema-38-317b96808bc4";'
new = 'export const DAEMON_SCHEMA_ID = "protocol-7-schema-38-deadbeefcafe";'
# src/modes/daemon/daemon-protocol.ts:256
```

## 3. Expected output (verbatim, `logs/mut-digest-negative-leg.out`)

```
=== SCRATCH WORKTREE ===
8ed6d73bc813891679dec7bd11f2160ff218abda
=== LEG 0: clean tree state (must be empty) ===
=== LEG 1: baseline, untouched blob ===
 Test Files  1 passed (1)
      Tests  33 passed (33)
   Duration  8.10s (transform 92%, import 8%)
=== LEG 2: hand-write the digest (mutation) ===
mutated[hand-written-digest]: /tmp/fixD-scratch/packages/coding-agent/src/modes/daemon/daemon-protocol.ts
 M packages/coding-agent/src/modes/daemon/daemon-protocol.ts
⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  test/daemon-protocol.test.ts > daemon protocol helpers > keeps the advertised schema identity synchronized with wire type shapes
AssertionError: expected 'protocol-7-schema-38-deadbeefcafe' to be 'protocol-7-schema-38-317b96808bc4' // Object.is equality
Expected: "protocol-7-schema-38-317b96808bc4"
Received: "protocol-7-schema-38-deadbeefcafe"
 Test Files  1 failed (1)
      Tests  1 failed | 32 passed (33)
=== LEG 3: restore ===
restore status (empty = clean):
 Test Files  1 passed (1)
      Tests  33 passed (33)
   Duration  3.98s (transform 86%, import 13%, tests 1%)
DIGEST_MUTATION_DONE
```

Three legs, in one run: **33/33 green** on the untouched blob, **1 failed | 32 passed** with the
hand-written digest (and the assertion names both the expected and the received identity), **33/33
green** again after `git checkout --`, with `git status --porcelain` empty - the mutant is not left
in any working tree.

## 4. Why this leg is worth keeping in-repo

- It is the **negative control for the digest gate itself**: without it, "33/33 green" is
  indistinguishable from a gate whose recipe has drifted away from the constant it guards.
- It is **cheap** (~20s for all three legs) and needs no network, no venv, no daemon.
- It doubles as the regression test for the comment added by this lane: any edit to
  `daemon-protocol.ts` that lands inside a hashed slice moves this pin, so the same command tells you
  whether a "comment-only" change really was comment-only. (It was: this lane's `daemon-protocol.ts`
  comment sits inside the object literal, below the slice boundary, and the pin stayed 33/33 - see
  `REPORT.md`.)

## 5. Business impact

None on behaviour - the mutation runs only in a scratch worktree and is always restored. The value is
that the one property the protocol depends on (the wire identity is computed, not typed) has a
re-runnable red leg in the repo instead of only in a review seat's `/tmp` log.
