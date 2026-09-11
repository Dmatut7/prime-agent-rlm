# P0-5c event-gap recovery: switch archive (T4-4 / F17 / G8)

Status: **mechanism shipped, switch NOT taken.** The default stays
`daemon.eventGapRecovery = "log"`. This file is the merge gate for flipping it:
a PR that changes the default, or that sets `"recover"` in a shipped settings
file, must update this file in the same commit or it does not merge.

## Owner

- Owner: the batch-4 construction lane (multi-agent stability fix, `merge/repl-kernel`).
- Escalation: the repo owner ("boss") — the switch is a behaviour change to every
  attached client, not a config detail.

## What ships in this batch

| Piece | Where | Default |
|---|---|---|
| Gap detector (T3-2, batch 3) | `daemon-agent-connection.ts` `observeEventCursor` / `reportEventGap` | log-only |
| Mode switch | settings `daemon.eventGapRecovery`: `"log"` \| `"recover"` | `"log"` |
| Circuit breaker (T4-4, this batch) | `daemon-agent-connection.ts` `beginEventGapRecovery` / `tripEventGapRecoveryBreaker` | armed whenever the mode is `"recover"` |
| Breaker bounds | 3 consecutive gap re-pulls (streak resets after 5 min without one), or 3 re-pulls inside a 10 min window | fixed constants |
| Breaker effect | this connection falls back to log-only for the rest of its life and writes `event gap recovery circuit OPEN` with the reason | — |
| Diagnostics | `DaemonAgentConnection.eventGapDiagnostics` (mode, configuredMode, detected, suppressed, breakerOpen, breakerReason, recoveryStreak, recoveryInWindow) | read-only |

The breaker is per connection, and a connection is one (client, session) pair, so
the bound is the per-(client,session) resync rate bound F9 asks for. A breaker
that opened is not a reason to disable recovery globally: replacing the
connection (re-attach, daemon restart) re-arms it.

## Switch criteria (all three must hold)

1. **Observation window.** The log-only detector has been running in production
   for at least 7 days. Evidence: the first and last timestamp of the deployed
   build that contains T3-2 (`git log` of the batch-3 commit vs. the deployment
   record), not "it feels like a week".
2. **Zero false positives, reconciled line by line.** Every
   `event gap detected for <session>: expected sequence <e>, got <g> (generation
   <gen>)` line in the window is matched to a real hole. The reconciliation table
   is the gate artifact; its format is fixed (below). One unexplained line blocks
   the switch.
3. **Emitter coverage re-checked.** The five sequence-emitting sites proven in the
   T3-2 PR attachment are still the only ones (a new emitter that does not set a
   cursor fabricates gaps). Re-run that proof against the switch commit, not
   against the T3-2 commit.

### Reconciliation table format (gate 2)

One row per `event gap detected` line, in chronological order:

| # | timestamp | session | expected | got | generation | missing events proven (ids/seq) | proof source | verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-09-12T08:31:02Z | active-abc | 41 | 47 | 9f2c… | 41,42,43,44,45,46 | supervisor event log + worker journal | true gap |

- `missing events proven` lists the sequence numbers the client never saw; the
  list must be exactly `[expected, got)`.
- `proof source` names where those events were found after the fact (supervisor
  log, worker recovery journal, session file), so a reviewer can re-derive it.
- `verdict` is `true gap` or `false positive`. Any `false positive` row must
  carry the emitter that skipped the cursor and blocks the switch until fixed.
- A window with zero lines is a pass, and must say so explicitly with the
  `grep -c` command and its output, because "no evidence collected" and "no gaps"
  look identical otherwise.

## Switch procedure

1. Update this file: fill in the switch date, attach the reconciliation table,
   and record the deployed build's schema id / commit.
2. Change the default in `settings-manager.ts` (`eventGapRecovery` default) or
   ship the setting in the deployment's settings file.
3. Keep the breaker exactly as shipped. If the switch PR also relaxes a bound,
   that is a separate decision and needs its own evidence.

## Rollback

- Switch: set `daemon.eventGapRecovery` back to `"log"`. Effective on the next
  client start; no daemon restart, no data migration.
- Breaker: it is inert in `"log"` mode, so rolling the mode back rolls the whole
  feature back.

## Observable signatures (appendix B of the fix plan)

| Signature | Baseline | Out-of-bounds action |
|---|---|---|
| `event gap detected` | ≈0 during the log-only window | non-zero: reconcile every line (this file, gate 2) |
| `re-pulling the session (streak N)` | 0 while the mode is `"log"` | non-zero while `"log"`: the mode was changed without this archive |
| `event gap recovery circuit OPEN` | 0 | non-zero: a real hole is not being closed by a re-pull; investigate before widening any bound |
| `session_resynced` triggered by a gap | low | a storm means the breaker bounds are wrong, not that the breaker should be removed |

## Review points

- Review date: 7 days after the batch-3 build is deployed (gate 1), then at the
  switch, then 7 days after the switch.
- Re-review triggers: any `circuit OPEN` line; any `false positive` verdict;
  a new sequence-emitting site; a change to the snapshot re-pull path.
