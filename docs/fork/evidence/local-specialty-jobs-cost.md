# Local cost of the four CI specialty jobs (workstation reading)

What this file is: the wall-clock cost, measured on this workstation, of the four CI jobs that run
on their own rather than inside the sharded matrix (`ci.yml:163-226`). Each reading carries its
command, its exit code, the machine and time it was taken, and one of three labels:

- **实测** - I ran it here, this session, and the log is quoted.
- **推算** - not runnable here; the number is arithmetic from in-repo constants and is labelled as
  arithmetic, never as a measurement.
- **不可实测** - cannot be run on this machine at all, with the reason.

Base for every reading: `8ed6d73bc813891679dec7bd11f2160ff218abda` in `/tmp/fixD`
(`git worktree`-clean except the lanes' own artifacts).

## 0. How the numbers were taken

```bash
# whole script: /tmp/fixD/logs/measure-specialty-jobs.sh; raw output: measure-specialty-jobs.out
bash /tmp/fixD/logs/measure-specialty-jobs.sh
```

Sequential, one job at a time (`{ time <job> ; } > logs/job-<name>.log 2>&1`), with `time` giving the
shell wall clock and vitest printing its own `Duration`. Both are quoted because they differ by the
node/npm startup: vitest's `Duration` starts after the runner is up, `real` includes `npm run`.

**Machine / time**: `Darwin 1deMac-mini.lan 27.0.0 arm64`, Apple M4, **10** logical cores, node
`v22.22.0`, 2026-09-18 **12:00:39Z-12:06:00Z** (20:00-20:06 local, UTC+8).

**Load discipline (this matters - see §5)**: the box was not idle. Snapshots taken during the run:

```
2026-09-18T12:02:25Z  load averages: 15.19 32.25 35.55
2026-09-18T12:04:08Z  load averages: 20.19 30.18 34.44
2026-09-18T12:05:56Z  load averages: 37.17 32.33 34.69
```

On a 10-core machine that is 1.5x-3.7x oversubscription, and **a sibling lane
(`/private/tmp/fixL1/.../vitest`) was running the same `test:kernel` job concurrently** for part of
the window (`ps` snapshot at 12:02:25Z showed both trees). Every number below is therefore an
upper bound under load, not a floor. §5 gives the spread against a quieter sample.

## 1. `coding-agent process smoke` - **实测**

`ci.yml:163-196` (`package: packages/coding-agent`, `command: npm run test:process --`, gate
`--min-tests 20 --min-ran-tests 11 --max-nothing-files 1`, plus a `tag_skip_ledger` pinning the 12
`process-stress` skips).

```bash
cd packages/coding-agent && time npm run test:process -- --reporter=default
```

| # | when / where | vitest `Duration` | shell `real` | exit | collected / ran / skipped |
|---|---|---|---|---|---|
| A | 19:07:54 local, `/tmp/reviewB-wt-1` (terminal-review seat; `logs/ci-process-smoke.json.human.log:27`) | **38.00s** | not in that artifact | 0 | 24 / 12 / 12 |
| B | 20:00:40 local, `/tmp/fixD` (`logs/job-process-smoke.log`) | **56.79s** | **0m57.530s** | 0 | 24 / 12 / 12 |
| C | 20:04:09 local, `/tmp/fixD` (`logs/process-smoke-sample2.log`) | **106.55s** | **1m47.255s** | 0 | 24 / 12 / 12 |

Counts are identical in all three; the wall clock moves 2.8x. Sample C's own log records its load:
start `20.19 30.18 34.44`, end `37.17 32.33 34.69`.

> The brief that asked for this measurement cites "38.4s" for sample A. The artifact I can reach
> (`ci-process-smoke.json.human.log`) carries **38.00s** (vitest `Duration`) and no shell `real`
> line; I report what the artifact says and do not restate 38.4s as measured.

**Label: 实测.** Per-test durations move with the same factor (e.g. "exits an orphaned session
worker when no replacement supervisor can come up": 7829ms in A, 8525ms in B, 14215ms in C).

## 2. `coding-agent kernel` - **实测**

`ci.yml:214-221` (`command: npm run test:kernel:ci`, `report: ""` - the command runs the coverage
gate itself with `--min-tests 30 --min-ran-tests 29 --max-nothing-files 0`; `seed_kernel_python:
true` seeds the venv in a separate step, `ci.yml:283-301`, so seeding is not charged to the job).

```bash
cd packages/coding-agent && time npm run test:kernel
# CI form (adds the JSON report + the gate):
#   npm run test:kernel:ci
```

Prerequisite, once per tree (the repo's own script):

```bash
PRIME_AGENT_KERNEL_VENV=/tmp/fixD-kernel-venv \
  npx tsx packages/coding-agent/src/core/kernel/bootstrap-cli.ts --with-bundled-skills
# -> "kernel python: /tmp/fixD-kernel-venv-04641086d635/bin/python"
PRIME_AGENT_KERNEL_PYTHON=/tmp/fixD-kernel-venv-04641086d635/bin/python
```

| # | when / where | vitest `Duration` | shell `real` | exit | files | collected / ran / skipped |
|---|---|---|---|---|---|---|
| A | 19:31:17 local, `/tmp/reviewB-wt-1` (`logs/job-kernel.log`) | **52.36s** | **0m52.866s** | 0 | 15 | 52 / 43 / 9 |
| B | 20:01:37 local, `/tmp/fixD` (`logs/job-kernel.log`) | **68.32s** | **1m8.832s** | 0 | 15 | 52 / 43 / 9 |

Sample A's run printed its own gate: `vitest coverage gate: GREEN (--min-tests 30,
--min-ran-tests 29, --max-nothing-files 0; collected 52 tests, ran 43, nothing-files 0)`.
Sample B used the plain `test:kernel` form, so it printed no gate line - the counts are the same
15 files / 43 passed / 9 skipped / 52 collected. Sample B overlapped the `/tmp/fixL1` lane running
the identical job, which is the most likely reason it is 1.3x slower.

**Label: 实测** (with the concurrency caveat).

## 3. `runtime python` - **实测**

`ci.yml:222-226` (`working-directory: prime-agent-runtime`, `command: uv run python -m unittest
discover -s test`, `report: ""` - no vitest gate).

```bash
cd prime-agent-runtime && time uv run python -m unittest discover -s test
```

| # | when / where | unittest time | shell `real` | exit | result |
|---|---|---|---|---|---|
| A | 19:30 local, `/tmp/reviewB-wt-1` (`logs/job-runtime-python.log`) | `Ran 443 tests in 54.927s` | **0m58.304s** | 1 | `FAILED (errors=1, skipped=1)` |
| B | ~20:03 local, `/tmp/fixD` (`logs/job-runtime-python.log`) | `Ran 443 tests in 63.749s` | **1m7.223s** | 1 | `FAILED (errors=1, skipped=1)` |

Same 443 tests, same single error, both trees:

```
ERROR: test_real_anonymous_streamable_http (test_mcp.McpRegistryTest.test_real_anonymous_streamable_http)
...
mcp.shared.exceptions.MCPError: Server returned an error response
```

That error is `test_mcp.py` opening a **real remote MCP server** (`rlm/mcp.py` → `session.initialize()`);
it is a network-dependent test, not a code regression, and it is why this job's exit code is 1 in
both samples. Per the fork's own record (`FORK_NOTES.md`, 2026-09-17 rows) the runtime suite's
baseline has carried this one error throughout.

Sample B's first `uv run` in that tree created `.venv` from scratch inside the timed command:
`Creating virtual environment at: .venv` / `Installed 33 packages in 25ms`. That is uv resolving
from cache; it is inside the 1m7.223s, so sample B is an upper bound that includes environment sync.

**Label: 实测.**

## 4. `coding-agent machine-wide` - **不可实测**

`ci.yml:198-213` (`command: npm run test:machine-wide --`, gate `--min-tests 5 --min-ran-tests 5
--max-nothing-files 0`).

```bash
# packages/coding-agent/package.json
test:machine-wide = tsx src/core/kernel/bootstrap-cli.ts && vitest --run --no-file-parallelism test/suite/regressions/4603-worker-recovery.test.ts
```

**Why it cannot be run here** - `ci.yml:198-205` says it itself, in the comment above the matrix row:

> `4603-worker-recovery` drives the machine-wide discovery commands (`status`, `doctor --fix`,
> `shutdown --force`): `daemon ps` finds every prime-agent daemon on the host through `ss -lxp`/
> `lsof` rather than only its own socket (see the header of `src/cli/daemon-ps.ts`). Run inside a
> shard, that reaps the other files' session-less supervisors - in run 34753200385 it stopped
> 4606's predecessor mid-test and reddened both files - **and on a workstation it stops the
> developer's live daemon**. So it runs alone, in its own job on its own runner, and `test:ci`
> excludes it.

This workstation is running live agent sessions (the one writing this file among them). Killing
their daemons to time a CI job is not a trade this measurement is worth; the terminal-review seat
before me refused for the same reason. **Label: 不可实测.**

What *can* be established statically, without running anything:

```bash
cd packages/coding-agent
PRIME_AGENT_KERNEL_PYTHON=<seeded> npx vitest list test/suite/regressions/4603-worker-recovery.test.ts | wc -l
# -> 6   (listing only collects; it does not execute a test)
# raw list: /tmp/fixD/logs/machine-wide-collected.txt
```

**6 collected**, against the CI floor `min_tests: 5` (a floor, not an equality).

**推算 (arithmetic, not a measurement)**: the test file's own constant
`fixtureProcessQuietMs = 5500` (`4603-worker-recovery.test.ts:109`, "Covers the worker's five second
supervisor-availability retry") is a per-test silent window that no configuration can shorten, so the
job cannot finish in less than roughly `6 x 5.5s = 33s` of quiet windows, plus process spawn/teardown
and the `bootstrap-cli` venv-seed step in the same command. The terminal-review seat's estimate was
`5 x 5.5s + ~7s ≈ 35s` (5 tests against the CI floor); with the 6 tests that actually collect the
same arithmetic gives `6 x 5.5s + ~7s ≈ 40s`. **Both are lower bounds of a kind, not readings**: the
tests also spawn real supervisors, workers and CLI processes, which is what makes samples A-C above
move 2.8x with load. Treat `~35-40s` as "this is a job measured in tens of seconds", nothing sharper.

## 5. What the spread means (read this before quoting any number)

| job | quiet-ish sample | loaded sample(s) | factor |
|---|---|---|---|
| process smoke | 38.00s (A) | 56.79s (B), 106.55s (C) | up to 2.8x |
| kernel | 52.36s (A) | 68.32s (B, concurrent sibling job) | 1.3x |
| runtime python | 54.93s unittest / 58.30s real (A) | 63.75s unittest / 67.22s real (B) | 1.16x |

Three consequences for anyone quoting "the local cost of these jobs":

1. **A single local number is not portable.** These jobs spawn processes and talk to the OS;
   on a workstation carrying several agent lanes the wall clock is dominated by the host, not by
   the job. Quote the load with the number or quote the range.
2. **The three jobs together are ~2.5-4 minutes of wall clock** on this box (A: 38 + 52 + 58 = 148s;
   B: 57.5 + 68.8 + 67.2 = 193.5s; C alone nearly doubles the first job again) - plus the kernel
   venv seed step, which CI runs outside the timed job (`ci.yml:283-301`) and I did not time
   separately.
3. **Only the counts are stable.** 24/12/12, 52/43/9 (15 files) and 443/1-error/1-skip reproduced
   exactly in both trees. Use the counts to detect a job that stopped running a face of the suite;
   use nothing here to detect a performance regression.

## 6. Business impact

None of this touches the product: it is CI/developer-experience accounting. The practical value is
that the next person who wants to say "the local specialty jobs cost X" gets the command, the log,
the load, and the difference between a measurement and an estimate - instead of a number with no
provenance, which is the failure mode this evidence directory exists to prevent.
