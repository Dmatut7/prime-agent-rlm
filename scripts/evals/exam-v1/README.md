# exam-v1 — fixed model-intelligence exam set

Seven fixed exams, all machine-graded from on-disk artifacts (never from the
agent's own claims), covering the repo's four real load shapes: multi-step
tool use (EX-1), long-context recall (EX-2, EX-7), interruption recovery
(EX-3), and code understanding against this repo's real files (EX-4, EX-5).
EX-6 reuses the swarm-fanout harness. Everything is stdlib-only Python and
runs on the system python3 (3.9+).

Graders recompute their expected values at grade time (EX-2 rescans the
corpus, EX-4/EX-5 re-read the repo sources), so repo evolution does not rot
the questions; when a regex stops matching, the grader fails loud with
`needs_reauthor` instead of grading against stale constants. Token/turn/wall
numbers (`examlib.usage_from_json_log`, same convention as
`swarm_fanout/scorer.py`) are informational, not gates.

| Exam | Shape | Driver | Grader |
|---|---|---|---|
| EX-1 | fix a buggy script, run it, correct report | manual (`run_manual.py`) | `ex1-pipeline/grade_ex1.py` |
| EX-2 | needle recall over a 32k-token corpus | manual | `ex2-needles/grade_ex2.py` |
| EX-3 | SIGTERM mid-run, then `--resume` continuation | `ex3-recovery/run_ex3.py` | `ex3-recovery/grade_ex3.py` |
| EX-4 | protocol facts of this repo (read-only) | manual | `ex4-repo-facts/grade_ex4.py` |
| EX-5 | signal-exit codes of print mode (read-only) | manual | `ex5-sigterm/grade_ex5.py` |
| EX-6 | RLM fan-out/fan-in over 8 shards | `swarm_fanout/runner.py` | runner exit code |
| EX-7 | multi-prompt in-session recall with a superseded fact | `ex7-session-recall/run_ex7.py` | `ex7-session-recall/grade_ex7.py` |

## How to run

Prerequisites (once):

1. The CLI is built (`prime-agent` resolves to the repo's
   `packages/coding-agent/dist/bundle/cli.js`).
2. Model auth lives in the agent dir (`auth.json`, plus `models.json` when
   custom providers carry their credentials there). The drivers copy both
   file-to-file into the isolated per-exam home; contents are never read.
3. Pin the baseline: record `git -C <repo> rev-parse HEAD` in the run notes;
   cross-wave comparisons pin the SHA, not HEAD.
4. Strip RLM leaks from every command below with
   `env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_MAX_DEPTH` (macOS: never the
   `env -u=NAME` spelling).

**Serialization: one agent home runs one daemon at a time.** Starting a
second daemon on the same `PRIME_AGENT_CODING_AGENT_DIR` is refused with
`DaemonAgentDirAlreadyRunningError`. `run_manual.py`, `run_ex3.py`, and
`run_ex7.py` all default to a per-exam home (`<work>/agent-home`), so exams
with distinct work dirs may run in parallel; runs that share one home (or the
default `~/.prime/agent`) must be serial.

```bash
PACK=scripts/evals/exam-v1   # run from the repo root
M=provider/model-id          # or drop --model for the configured default

# EX-1 (generate -> agent works in fixture/ -> grade)
python3 $PACK/ex1-pipeline/gen_ex1.py --out /tmp/exam/ex1 --seed 20261002
python3 $PACK/run_manual.py --work /tmp/exam/ex1 --model $M \
    --prompt-file $PACK/ex1-pipeline/prompt.txt --cwd /tmp/exam/ex1/fixture
python3 $PACK/ex1-pipeline/grade_ex1.py --work /tmp/exam/ex1

# EX-2 (agent writes fixture/answers.json - one level above docs/, per prompt)
python3 $PACK/ex2-needles/gen_ex2.py --out /tmp/exam/ex2 --seed 20261002
python3 $PACK/run_manual.py --work /tmp/exam/ex2 --model $M \
    --prompt-file $PACK/ex2-needles/prompt.txt --cwd /tmp/exam/ex2/fixture
python3 $PACK/ex2-needles/grade_ex2.py --work /tmp/exam/ex2

# EX-3 (driver handles kill/resume; grading is a separate step; rails live
# in a rail dir OUTSIDE the work dir - the prompt never names it)
python3 $PACK/ex3-recovery/run_ex3.py --work /tmp/exam/ex3 --rail-dir /tmp/exam/ex3-rail --model $M
python3 $PACK/ex3-recovery/grade_ex3.py --work /tmp/exam/ex3 --rail-dir /tmp/exam/ex3-rail

# EX-4 / EX-5 (read-only against the repo; pre-snapshot feeds the drift rail)
RAIL=/tmp/exam/ex4-rail
mkdir -p "$RAIL" /tmp/exam/ex4/sessions
git status --porcelain > "$RAIL/git-status-pre.txt"
python3 $PACK/run_manual.py --work /tmp/exam/ex4 --model $M \
    --prompt-file $PACK/ex4-repo-facts/prompt.txt --rail-dir "$RAIL" \
    --var REPO=$PWD --var WORK=/tmp/exam/ex4 --var SESSIONS=/tmp/exam/ex4/sessions
python3 $PACK/ex4-repo-facts/grade_ex4.py --repo $PWD --work /tmp/exam/ex4 \
    --sessions-dir /tmp/exam/ex4/sessions --rail-dir "$RAIL"
# EX-5: same flow with ex5-sigterm/prompt.txt and grade_ex5.py (no --sessions-dir)

# EX-6 (stock harness, unchanged)
cd scripts/evals/swarm_fanout && uv run --locked python runner.py \
    --fixture fixtures/json-events --model $M

# EX-7
python3 $PACK/ex7-session-recall/run_ex7.py --work /tmp/exam/ex7 --model $M --seed 20261002
python3 $PACK/ex7-session-recall/grade_ex7.py --work /tmp/exam/ex7
```

Every driver sends the daemon `shutdown` envelope on its exit path.

**Score** = exams resolved / 7. Compare models on content score first, then
peak context and wall time.

### The repo-untouched rail (EX-4/EX-5)

Both graders attribute drift: the pre/post `git status --porcelain`
path-set difference is blamed on the agent only for paths its own log
proves it wrote (write/edit path arguments, or bash/ipython texts that
carry a write indicator and name the path). Drift from parallel lanes
sharing the worktree is reported as `foreign_drift` in the verdict and does
not fail the run. Residual gap, by design: a write the heuristic cannot
spell out (heavily computed paths) grades as foreign.

### Grading-rail integrity (EX-3/EX-4/EX-5, D9)

A rail is a grader input the agent must never touch: the pre-run
`git-status-pre.txt` snapshot, EX-3's `pre-resume.json`, the
driver-recorded `run-meta.json`, and the `agent.log` used for write
attribution. The wave-15 claude run overwrote the pre-run snapshot mid-run
(erasing the drift evidence), truncated agent.log, and self-ran the grader.
The hardening:

1. Rails live in an operator-chosen `--rail-dir` OUTSIDE the agent-writable
   work dir; the prompt never names the path. Drivers refuse a rail dir
   that nests into `--work` either way, and graders fail closed on one.
2. Drivers record `started_at` (and EX-3's `phase_b_started_at`) in
   `<rail>/run-meta.json` before the agent launches. Graders reject a rail
   file whose mtime postdates its deadline (EX-3's snapshot is written
   mid-run, so its deadline is the phase-B launch), and fail closed when
   run-meta.json is missing or anchor-less.
3. Every exam prompt explicitly forbids reading/executing the grading
   scripts and touching rail files.

Residual gap, documented honestly: an adversarial agent that discovers the
rail-dir path can rewrite `run-meta.json` itself. The rail stops the
observed incidental/self-verification tampering pattern; full isolation
from a determined adversary needs OS-level sandboxing (read-only mounts),
which this stdlib-only pack deliberately does not attempt.

## Self-tests

Model-free, bidirectional (gold sample passes, wrong samples fail), including
the drift-attribution rail against a synthetic git repo:

```bash
cd scripts/evals/exam-v1
python3 -m unittest discover -s tests -v
```

## Defect history (v1.0 -> v1.1, from the first baseline)

- **D1** EX-2: prompt sends answers.json to the repository root one level
  above `docs/` (= `fixture/`), grader read the work root - unpassable.
  Grader now reads `fixture/answers.json`.
- **D2** EX-2: `<ID>` key format was ambiguous (prefix or not). The prompt now
  pins it with a concrete prefix-free example.
- **D3** EX-4/EX-5: snapshot equality could not tell agent writes from
  parallel-lane drift. Replaced by the write-attributed rail above.
- **D4** `examlib.agent_env` copied only `auth.json`; custom providers
  (credentials inline in `models.json`) could not resolve under the isolated
  home. Both files are copied now.
- **D5** The how-to-run section now states the one-home-one-daemon rule.
- **D6** EX-5: the prompt now forbids executing the CLI under test (a wave-11
  model burned 667k tokens measuring exit codes empirically after it had
  already written the correct answers).

## Defect history (v1.1 -> v1.2, from the wave-15 run)

- **D9** EX-4 (claude line): the agent overwrote `git-status-pre.txt` with a
  mid-run `git status` (voiding the drift rail), truncated `agent.log`, and
  ran `grade_ex4.py` itself for self-verification. Hardened on three axes:
  rails moved into a `--rail-dir` outside the agent-writable work dir
  (EX-3's `pre-resume.json` moved the same way); graders reject rail files
  whose mtime postdates the driver-recorded run start and fail closed
  without `run-meta.json`; every exam prompt now explicitly forbids
  reading/executing graders and touching rail files. Grader CLI change:
  `--pre-status`/`--agent-log` are replaced by `--rail-dir`.

## Known limits / v1.1 candidates

- EX-3 uses SIGTERM (determinism first); a SIGKILL variant (orphan worker and
  lease cleanup paths) is a candidate.
- EX-4/EX-5 grade values + file only, not function-level evidence line ranges.
- No post-compaction recall exam (driving compaction needs a small-context
  model or a long session).
- EX-6 can rotate the csv-metrics fixture to prevent fixture overfitting.
