# Downstream report: defects we fixed on our line that we can still reproduce on `main`

From: the `Dmatut7/prime-agent-rlm` maintainers (independent downstream line, `merge/repl-kernel`)
To: PrimeIntellect-ai/prime-agent maintainers
Verified against: `upstream/main` at `fb2db8ee1` ("Count running/idle subagents across the whole subtree in the bar (#2218)", 2026-09-11), version 0.9.4
Date: 2026-09-11

---

## 1. Who we are and what this document is

We maintain an independent downstream line of prime-agent. We started from 0.9.1 with the REPL-kernel
work, merged your `main` three times since (18 commits, then 15, then 40 — the last merge is
`d74a75fea`, 2026-09-04), and on top of that we have 325 commits of our own. You are 41 commits ahead
of our merge base and on 0.9.4, so we are behind you and catching up is our next task, not yours.

Our line is published as [Dmatut7/prime-agent-rlm](https://github.com/Dmatut7/prime-agent-rlm)
(branch `merge/repl-kernel`). It is not in the GitHub fork network, and we do not publish to npm under
your package names. `FORK_NOTES.md` in that repository is our running changelog: for each round it
records what we changed, why, and what a user would notice.

Most of our work is unglamorous reliability work: multi-agent lifecycle, daemon worker recovery,
kernel/venv bootstrap, TUI memory and input handling, provider edge cases. Along the way we collected
a large set of defects, fixed them locally, and — because several of them were found by reading your
code rather than ours — we are writing down which ones we can still see on `main` today.

**Every item in section 2 was re-verified by reading the code on `main` at `fb2db8ee1`, not carried
over from our own notes.** Where a line number is given it is a line in your tree at that commit.
Where we could not convince ourselves, the item is in section 5 ("not settled") or in Appendix A
("checked, does not apply to you"). We have deliberately left out anything we only believe from a
grep.

**How we would like to hand this over.** `CONTRIBUTING.md:27-29` says pull requests from unvouched
contributors are closed automatically and that a Discussion is the way in, so we have not opened PRs.
Our earlier report [#2238](https://github.com/PrimeIntellect-ai/prime-agent/issues/2238) was closed automatically by the
vouch bot, with no technical reply; the three defects it described are still on
`main` (section 2.13 restates them in one line each so they are not lost). Tell us which channel you
want and we will use it: a Discussion per cluster, one issue with everything, patches attached as
diffs, or PRs if you decide to vouch us. For most items we already have a commit, a regression test
that fails without it, and a changelog fragment, so a patch is cheap for us to produce.

Nothing here is urgent from our side — we run our own line and our users are not blocked. It is
offered because re-finding these costs you time and we already paid it.

---

## 2. Defects we can still reproduce on `main`

Format for each entry:

- **Symptom** — what a user or an operator sees.
- **On `main`** — the code path, with file:line at `fb2db8ee1`.
- **Our fix** — what we did downstream, with the commit in our repository.
- **Offer** — what we can hand over.

### 2.1 Kernel runtime bootstrap (four entries, one shared root cause)

#### (a) Two sessions with different Python skill sets reinstall each other's venv forever

**Symptom.** The first cell of a subagent (or of any session whose skill set differs from the last one
that bootstrapped) stalls for minutes in "Starting Python kernel...". On a machine that alternates
between two skill sets it never converges: we measured a `.bootstrap-version` file that recorded only
1 of 8 skill sets, rewritten on every start.

**On `main`.** There is one shared venv (`packages/coding-agent/src/core/kernel/bootstrap.ts:370-373`,
`~/.prime/agent/kernel-venv`). Readiness requires the recorded skill list to be *exactly* the requested
list — `pythonSkillsMatch()` returns false on a length difference
(`bootstrap.ts:637-649`, used by `bootstrapVersionCurrent()` at `:651-661`) — and after installing,
`syncPythonSkills()` writes the record back with **only the caller's own list**
(`bootstrap.ts:854` → `writeBootstrapVersion()` at `:672-685`). The in-flight dedupe key also includes
the skill set (`bootstrap.ts:360-366`), so two sessions with different sets do not share one install.
The result is a ping-pong: A installs and records {A}, B sees a mismatch, installs and records {B}, A
sees a mismatch again.

**Our fix.** Readiness is a superset test (a recorded set that contains the requested set is ready),
and the record is written as the union of what is installed (`dd62e6832`).

**Offer.** Patch + tests. Small and self-contained; we think this one is worth taking first because it
is pure loss with no design question attached.

#### (b) The bootstrap lock wait has no timeout and cannot be cancelled

**Symptom.** A kernel start hangs with no message and no way out except killing the process, whenever
another bootstrap holds the lock and is slow (a cold `uv pip install` on a loaded machine) or wedged.

**On `main`.** `acquireBootstrapLock()` is `for (;;) { tryAcquireDirLock(...); if (attempt === "held")
await sleep(BOOTSTRAP_LOCK_RETRY_MS); }` (`bootstrap.ts:493-508`). The only escape is the staleness
rule, which applies when the lock directory has *no* pid (`bootstrap.ts:484-491`): a holder that is
alive but stuck is waited on forever. The `sleep()` is not signal-linked, so an abort does not release
it either.

**Our fix.** A 300s bounded, cancellable wait with an operator knob (`kernelBootstrap.lockTimeoutMs`),
turning "unbounded slow" into an explicit failure with guidance (`46cc03254`).

**Offer.** Patch + tests. The default value is a judgement call — we would want your number, not ours.

#### (c) A rebuild deletes the venv that running kernels are executing from

**Symptom.** After an upgrade (or any change of runtime identity), sessions that were already running
start failing on the next import or `bash()` spawn, with errors that point at missing files inside the
venv.

**On `main`.** Because there is a single shared directory (`bootstrap.ts:370-373`), the rebuild path is
`if (hadVenv) { reportProgress(..., "rebuilding kernel venv"); await rm(venv, { recursive: true, force:
true }); }` followed by a fresh bootstrap (`bootstrap.ts:935-942`). Nothing consults the kernels that
have that directory open — the lock only serialises bootstraps against each other, not against running
kernels.

**Our fix.** Versioned sibling directories (`kernel-venv-<hash12>` per build identity), an `.in-use`
reference count, a rule that a referenced generation is never renamed, rebuilt in place or deleted
(the request is refused as `venv rebuild deferred: N kernels in use`), and GC that keeps one
unreferenced previous generation (`ca92e1b34`, `c21d47a76`). The versioned layout also removes the
Windows rename-while-open failure mode by never renaming anything into use.

**Offer.** Patch + tests, but this is the largest of the four and it changes the on-disk layout, so it
probably wants your design review rather than our patch. We also have to deal with the 523MB legacy
directory our users already have; you would inherit that migration.

#### (d) Values that failed to revive are silently dropped from the next snapshot

**Symptom.** A session resumes, one variable cannot be restored (unpicklable, oversized), it is
reported once in `failed`, and from that moment the on-disk copy of that value is gone: the next
snapshot writes the live namespace, which no longer contains it. A long session can lose state it was
told had merely "failed to revive".

**On `main`.** `performRestore()` returns `{ restored, failed }` and clears `pendingRestore`
(`packages/coding-agent/src/core/kernel/repl-manager.ts:1534-1560`). The only thing that blocks a later
write is `pendingRestore` (`repl-manager.ts:1608-1612`, "a kernel that never restored the saved
namespace must not overwrite it"), so a *partially* successful restore unlocks writes and the
unrestorable names are simply absent from the next payload.

**Our fix.** A snapshot request may name values that failed to revive; the runtime copies their blobs
verbatim from the previous payload instead of from the live namespace (a merge write), so the on-disk
state only ever improves, and the next restore still reports those names in `failed` rather than
pretending they came back (`5943aa551` runtime side, `5172aea6e` host side, `33ade94b8` logging). It is
gated on a negotiated kernel capability so an older runtime is never asked for it
(`30c726254`).

**Offer.** Patch + tests for both halves. Needs the capability negotiation, so it is a two-part change.

### 2.2 Kernel death is not attributable after the fact

**Symptom.** A kernel is OOM-killed or dies for another external reason. Later, nobody can say why:
the exit code and signal are nowhere on disk, so the operator is left guessing between "the model wrote
something huge", "the machine was out of memory" and "someone killed it".

**On `main`.** Kernel stderr bytes *are* persisted to a per-session log with a rotation budget
(`repl-manager.ts:246-262`, `:400-409`) — that part is good. But the host-side fact about the death,
`appendKernelDiagnostic("unexpected exit code=${code} signal=${signal}")` in the `child.on("exit")`
handler (`repl-manager.ts:455-461`), goes to `appendKernelStderrText()`, which only appends to the
in-memory ring `this.kernelStderr` (`repl-manager.ts:233-239`). The manager is discarded after an
unexpected death, so the ring goes with it and the code/signal never reaches the log file.

**Our fix.** Structured death-cause attribution (code, signal, origin, with `oom_suspect` claimed only
on memory evidence), deliberately kept separate from an intentional host kill
(shutdown/kill/dispose/protocol repair), written to both the session log and the kernel log
(`a5179de81`). On top of that, an unexpected death is revived by the next cell with an explicit reset
notice to the model (what rolled back, what did not, which host replies were lost) and a fail-closed
budget of 3 revivals per hour (`f18c2ba77`).

**Offer.** The attribution half is a small patch and stands alone. The revival half is bigger and
overlaps with what `#2028` already does on your side (see Appendix A.1) — we would want to rebase it
onto your memo-drop rather than send it as-is.

### 2.3 `ReplKernelManager.restart()` has no production caller

**Symptom.** None directly; it is a trap for the next reader. The one in-place recovery entry point in
the kernel manager is only reachable from tests.

**On `main`.** `restart()` is defined at `repl-manager.ts:1440-1462`. The only callers in the tree are
`test/repl-kernel-abort.test.ts:470`, `test/repl-kernel-protocol-corruption.test.ts:513` and
`test/repl-kernel-shutdown.test.ts:261,275`. Recovery in production happens by dropping the defunct
memo and spawning a fresh manager (`packages/coding-agent/src/core/tools/ipython.ts:388-396`).

**Our fix.** We use it: our revival path restarts in place so the session keeps its manager, its
snapshot configuration and its host-request wiring (`f18c2ba77`).

**Offer.** Either wire it or delete it; we have no opinion on which, but the current state reads as if
in-place restart were available.

### 2.4 Four waits on the agent-message and subagent-hydration paths have no bound

**Symptom.** `agent_message.send(...)` from a kernel cell does not return. The cell stays in flight for
as long as the turn lives, the model gets no error and no fact it can act on, and the only escape is
aborting the turn.

**On `main`.** Four separate unbounded awaits:

- `AgentSession._awaitPendingRlmChildPublication()` awaits `run.publication.promise` with no timeout
  and no signal (`packages/coding-agent/src/core/agent-session.ts:10113-10123`), reached from
  `agent_message.list_agents`/`send` handling at `agent-messages.ts:583-584`.
- `AgentDaemon.waitForPassivation()` is `if (passivation) await passivation.catch(() => {})`
  (`packages/coding-agent/src/modes/daemon/daemon-mode.ts:3059-3062`).
- `rehydrateCompletedRlmSubagent()` re-enters itself recursively after `await reservation` and after
  `await pending`, with no attempt ceiling and no deadline (`daemon-mode.ts:3138-3149`).
- `waitForBoundSession()` awaits `bindingCompletions` unbounded (`daemon-mode.ts:3174-3178`).

**Our fix.** One settings knob drives four tiers (`agentMessage.targetWaitSeconds`, 120s long / 60s for
the other three; `0` restores today's behaviour). The bound cancels nothing — passivation, binding and
hydration mutate shared state and a half-finished one is worse than a slow one — so the operation runs
to completion and the *caller* gets a retryable error naming the phase, the target, the target's state
and `waitedMs`. Hydration re-entry additionally gets a mechanical ceiling (32 attempts or 60s total)
that is deliberately not derived from `RLM_MAX_DEPTH` (`dfc3df92d`).

**Offer.** Patch + tests. The `waitedMs` field is what we retune the tiers against, so we would suggest
keeping it whatever values you pick.

### 2.5 One long agent-message delivery can fail `prepare_update_restart` for everyone

**Symptom.** Self-update fails with a drain timeout while a session is merely busy delivering a message
to a target that needed a long hydration. The operator sees "broken update", not "busy session".

**On `main`.** `send_message` is a mutating command (it is not in `READ_ONLY_DAEMON_COMMANDS`,
`packages/coding-agent/src/modes/daemon/daemon-protocol.ts:1285-1323`), so it takes the drain latch:
`if (mutation) this.mutationDrain.begin()` … `finally { if (mutation) this.mutationDrain.end(); }`
(`daemon-supervisor.ts:1871`, `:1894`). Inside that latch the handler awaits the worker with
`WORKER_REQUEST_TIMEOUT_MS`, which is 24 hours (`daemon-supervisor.ts:2568-2582`, constant at `:196`).
`prepareUpdateRestart()` waits for the drain with an 80s budget
(`UPDATE_RESTART_MUTATION_DRAIN_TIMEOUT_MS`, `daemon-supervisor.ts:198`, used at `:6106-6110`). So one
delivery that parks for more than 80 seconds fails the update. Meanwhile the *client* side gives up
much earlier (`DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 30_000`, `daemon-client.ts:130`), so the sender has
already seen a timeout while the latch is still held. `UPDATE_RESTART_DRAIN_COMMANDS`
(`daemon-protocol.ts:1325-1332`) does not help here: it gates rejection during the drain phase and the
idle-eviction fence (`daemon-supervisor.ts:1826-1835`), not the latch.

**Our fix.** Two commits, deliberately separable: the long delivery is exempted from the latch and
named as such in the log, while its journal entry stays pending so a replayed command id still answers
`command_result_uncertain` instead of claiming the command never happened (`7bf3e5f0d`); and a
pending-delivery queue (100 per session, 24h deadline, explicit drain receipts, throttled requeue
logging, and abandoned receipts split into `undelivered` vs `uncertain` so they can be counted
separately) replaces "the message evaporated inside the drain window" (`7406aa22d`, `dcfb7f6ea`,
`82c2340ec`). We also split the daemon's timeouts into four tiers (long 24h / adoption 300s / deliver
120s / read 30s) and derived the client reconnect budget from the adoption tier (`5b37f330d`).

**Offer.** The exemption alone is a small patch and is the part that fixes the reported symptom; the
queue and the tiering are larger and we would want your read on the wire additions (they need a
schema-revision conversation, which is exactly the kind of thing we should not decide unilaterally).

### 2.6 Abort cancels this session's own child runs, but "is the family busy?" judges the whole subtree

**Symptom.** The user aborts (or the parent session is disposed) and a grandchild keeps running. The
UI still reports the family as busy, because the busyness check walks a different set than the cancel
does. Killing again does not help: the run is already `done`, so the cancel skips it.

**On `main`.** `_cancelActiveRlmChildRuns()` iterates only `this._activeRlmChildRuns`
(`packages/coding-agent/src/core/agent-session.ts:10079-10083`) and `_cancelRlmChildRun()` returns
early unless the run is `running` or `queued` (`:10085-10099`). It is called from the abort paths at
`:7286` ("Parent session aborted") and `:7310` (update restart) and from dispose at `:4370`.
`hasRunningRlmChildren()`, by contrast, walks `_rlmSubtreeSessions()` (`:10681-10690`). So a child that
settled, was followed up, and then spawned a child of its own is invisible to the cancel and visible
to the judgement. (We know you are actively working in this area — `#2218` at the head of `main` makes
the bar count the whole subtree, and `#2027` turned the subtree walk iterative; our complaint is only
that the *cancel* path still uses the narrow set.)

**Our fix.** `_abortRlmSubtree()` walks the same subtree generator the judgement uses, cancels every
running/queued run in it, and also stops the in-flight turn of each retained descendant session; the
abort handle is dropped after firing so a late publication cannot abort the same child twice
(`ef788e0db`). Cost is O(nodes), not O(depth²), because `requestAbort` intentionally has no cascade
semantics of its own. Cross-worker descendants are out of reach of an in-process walk and are left to
the supervisor's kill path.

**Offer.** Patch + tests.

### 2.7 Event-sequence holes are absorbed silently by the client

**Symptom.** A client's view of a session is permanently missing an event (a `message_end`, say), and
nothing anywhere says so. The message just never appears until something else forces a resync.

**On `main`.** The client deduplicates by "is this sequence older than what I have" and advances with
`Math.max`: `packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.ts:2226-2230`
(stale test) and `:2237-2259` (advance, `sequence: Math.max(this.lastEventCursor.sequence, sequence)`).
A jump from N to N+2 is indistinguishable from a duplicate of N+1 arriving late: the max absorbs it and
no counter, log line or event records the hole.

**Our fix.** A gap detector on the client cursor that records the hole with both sequence numbers, and
— behind `daemon.eventGapRecovery`, default `"log"` — an optional recovery path bounded by a circuit
breaker (3 consecutive failures or 3 in 10 minutes permanently degrades that connection back to
log-only) so a broken recovery cannot become a resync storm (`cb749c7bc`). We left the default at
`log` on purpose: the honest first step is to make the hole visible, and we would not suggest turning
recovery on without a real replay buffer behind it.

**Offer.** The detector is a small patch with no wire change and is useful to you even if you never
want the recovery side. We can send just that.

### 2.8 `kill` cannot reach a worker that is failed or recovering and whose process is gone

**Symptom.** A worker dies (OOM, crash). Its row stays in the roster as failed. `kill` on it returns an
error instead of removing it, so the row is permanent for the life of the daemon, and every restart
tries to adopt the same dead descriptor again.

**On `main`.** The kill path forwards to the worker: `forwardToWorker()` first tries the recovery
ladder, then calls `requireAvailableWorkerClient(worker, command.type === "kill")`
(`daemon-supervisor.ts:5006-5020`, kill routed at `:2616-2646`). `requireAvailableWorkerClient()`
throws `Session worker is <state>` unless `worker.descriptor.lifecycle === "ready"`; the `allowStopping`
argument that kill passes only relaxes the *stopping* check (`:4735-4744`). The ladder cannot save it
either: `canRetryFailedWorker()` requires `processIdentity(pid, processStartId) === "current"`
(`:3601-3609`), which is false for a process that is gone. So a dead failed worker has no command that
removes it.

**Our fix.** `kill` is reachable in every lifecycle state (recovering/failed/stopped), a target whose
process is already gone answers `alreadyTerminal` instead of an error, and read commands stopped
claiming success for a worker they could not reach (`0ec081a26`). The same commit moved startup
adoption off the ready path and bounded the adoption request (see 2.13).

**Offer.** Patch + tests.

### 2.9 print/json mode completes the session while subagents are still running

**Symptom.** `prime-agent -p "..."` on a task that spawns subagents returns as soon as the root turn
finishes; the subagents are cancelled mid-work by the worker teardown. ACP mode does not do this.

**On `main`.** `print-mode.ts:121` calls `connection.waitForHeadlessCompletion()` with no options, and
`waitForHeadlessCompletion()` only waits for descendant quiescence when asked:
`if (options.waitForRlmQuiescence) await session.waitForRlmQuiescence(); else await
session.waitForHeadlessIdle();` (`packages/coding-agent/src/modes/headless-completion.ts:83-96`). ACP
passes the flag (`packages/coding-agent/src/modes/acp/acp-mode.ts:638`) — and then does not pass it on
the other call site (`acp-mode.ts:895`), which may or may not be intentional.

**Our fix.** print/json wait for RLM quiescence through the same capability gate ACP uses
(`82683e4ee`).

**Offer.** Patch + tests. If "print does not wait for descendants" is the intended semantics, then the
asymmetry with ACP is worth a line in `docs/usage.md` either way.

### 2.10 On Windows the daemon pipe has no ACL, so any local user can drive it

**Symptom.** On Windows, any local user can connect to the daemon, attach to sessions, read
transcripts, kill workers and shut the daemon down.

**On `main`.** `docs/architecture.md:49` states the intended model: workers and kernels "run with the
same operating-system permissions as the client". On POSIX that model holds, because the socket is
chmod-restricted (`restrictDaemonSocketPath()` → `chmodSync(socketPath, DAEMON_SOCKET_MODE)`,
`packages/coding-agent/src/modes/daemon/daemon-socket.ts:179-184`, directory mode at `:285-302`). On
Windows the same function returns immediately (`daemon-socket.ts:180-182`) and the pipe name is a fixed
global (`daemon-socket.ts:70-75`, `\\.\pipe\prime-agent-daemon`). There is no peer credential or token
handshake anywhere: every connection is constructed with `authenticated: true`
(`daemon-supervisor.ts:1432-1444`), and the control-plane commands act on that —
`case "restart"` / `case "shutdown"` fire immediately with no caller check
(`daemon-supervisor.ts:2221-2226`). So on Windows the "same permissions as the client" premise does not
hold: the boundary is the machine, not the uid.

We are not asking for a security model you have deliberately not built. The narrow point is the
platform asymmetry: POSIX enforces the documented premise, Windows does not enforce anything.

**Our fix.** A named-pipe ACL restricting the pipe to the current user's SID (`2637973c1`). We must be
explicit about its limits: **we have never run it on real Windows**, and we know of two reasons to
distrust it — the ACL is applied in the `listen()` callback to the instance that exists at that moment,
while libuv creates subsequent instances with `NULL` `SECURITY_ATTRIBUTES` and Windows does not
document inheritance there; and a per-instance ACL is a weak place to hang an authentication decision.
Separately, and orthogonally, we made the server side enforce the capabilities a client declared
instead of trusting the client to gate itself (`96d3db580` and follow-ups). That is a robustness fix
(an old or third-party client cannot use a command the server has not agreed to serve), not a security
one.

**Offer.** The capability-enforcement patch is portable and we would happily send it. The Windows ACL
we would only send as a starting point for someone with a Windows machine, clearly labelled
unverified — if you take it, please do not take our word for it working.

### 2.11 Session transcripts are written with the default umask (#1249 is still open)

**Symptom.** On a multi-user machine, `~/.prime/agent/sessions/**.jsonl` — which contains prompts, tool
output and bash transcripts — is readable by every local user.

**On `main`.** `SessionManager` appends with no mode argument:
`appendFileSync(this.sessionFile, ...)` at `packages/coding-agent/src/core/session-manager.ts:1709`,
and the fork/copy path at `:2381` and `:2398`. Under a default umask these land at 0644. There is no
`private-files` helper in your tree and no `0o600` on these paths.

**Our fix.** We took your own unmerged PR
[#1249](https://github.com/PrimeIntellect-ai/prime-agent/pull/1249) ("fix(security): contain private
session artifacts", open since 2026-08-13) into our tree (`e4bb3f3cf`), together with
[#1251](https://github.com/PrimeIntellect-ai/prime-agent/pull/1251) for `--no-session` descendants, and
rebased both onto our incremental-scan changes. Both have been running on our machines since August.
One gap remains in *our* tree that we have not closed: `core/semantic-edges.ts` still writes its ledger
with bare `node:fs` (`:357`, `:363`, `:367`).

**Offer.** No patch needed from us — the work exists as #1249/#1251. What we can offer is the
rebase/verification data: 4 months of downstream runtime on those two patches, including the
tightening of pre-existing 0755 directories without erroring, and the cron-migration downgrade to a
log line. If it is useful we will write that up as a review comment on the PRs.

### 2.12 Two provider-layer defects (packages/ai)

#### (a) google / google-vertex overwrite `stopReason` with `toolUse` unconditionally

**Symptom.** A malformed or blocked completion that happens to contain tool-call blocks is reported as
a normal tool-use turn, so the half-parsed call is executed instead of surfacing an error; and a
completion truncated at `MAX_TOKENS` is reported as `toolUse` instead of `length`, so length-driven
retry/refinement never fires. `stopReasonRaw` is never recorded for these, which makes the failure
hard to diagnose from a transcript.

**On `main`.** `packages/ai/src/providers/google.ts:209-217`:

```ts
if (candidate?.finishReason) {
    output.stopReason = mapStopReason(candidate.finishReason);
    if (output.content.some((b) => b.type === "toolCall")) {
        output.stopReason = "toolUse";
    }
    if (output.stopReason === "error") {
        output.stopReasonRaw = candidate.finishReason;
    }
}
```

Identical code at `packages/ai/src/providers/google-vertex.ts:225-233`. The overwrite loses the mapped
reason; because `stopReason` is now `"toolUse"`, the `=== "error"` branch below it can never run, so
`stopReasonRaw` is not set either, and the `streamFailureFromStopReason()` throw at `google.ts:262-263`
is not reached. Your `openai-responses-shared` path has the guard these two are missing.

**Our fix.** Only rewrite to `toolUse` when the mapped reason is `stop`, matching
`openai-responses-shared` (`bd2e16014`).

**Offer.** Two-line patch + tests.

#### (b) A replayed thinking block keeps its signature after the text was sanitized

**Symptom.** One malformed stream (unpaired surrogates in thinking text) permanently breaks the
session: every later turn fails with a non-retryable 400 `invalid_request` from Anthropic/Bedrock, and
the error message does not mention signatures, so nothing points at the cause.

**On `main`.** `packages/ai/src/providers/anthropic.ts:1159-1165` sends
`thinking: sanitizeSurrogates(block.thinking)` together with `signature: block.thinkingSignature` —
the signature of the *unsanitized* text. The fallback above it only covers a missing/empty signature
(`:1151-1158`). Same shape at `packages/ai/src/providers/amazon-bedrock.ts:697-708`
(`reasoningText: { text: sanitizeSurrogates(c.thinking), signature: c.thinkingSignature }`). Both
providers bind the signature to the text, so a changed text with an old signature is a validation
failure.

**Our fix.** If sanitization changed the text, degrade that block to plain text on the wire (reusing
the existing missing-signature fallback) while leaving the stored signature untouched, so a later
request that does not sanitize still has it (`cb00b467c`).

**Offer.** Patch + tests (`packages/ai/test/unicode-surrogate.test.ts` gained the cases). Reachability
is narrow — it needs an intermediate layer that emits malformed but well-formed-terminating streams —
but the failure is total and the diagnosis is expensive, which is why we fixed it early.

### 2.13 The three defects from #2238, restated in one line each

[#2238](https://github.com/PrimeIntellect-ai/prime-agent/issues/2238) was closed by the vouch bot, so
we are not repeating the analysis here — just the pointers, all re-verified at `fb2db8ee1`:

1. **Catch-up failure is logged and dropped, while the write-failure branch next to it requeues.**
   `daemon-supervisor.ts:6095-6098` (log and continue) versus `:6089-6094` (requeue the remaining
   sessions). One failed catch-up leaves a client's view of that session permanently incomplete. Our
   fix: bounded retry with backoff and jitter, plus a visible degradation when the client-side re-pull
   also fails (`0ec081a26`, `16c56168f`).
2. **The supervisor process has no `uncaughtException` / `unhandledRejection` handler.** The only
   `installCrashHandlers()` in the package is a private method of `AgentDaemon`, the worker-side class
   (`daemon-mode.ts:641-660`); nothing equivalent protects the supervisor process or the interactive
   TUI, and Node's default for `unhandledRejection` is to throw. One rejected promise in a bookkeeping path
   takes the whole daemon down. Our fix: supervisor-level guardrails (uncaught → log and exit;
   rejection → log-and-isolate, counted per hour, surfaced as a `degraded` state, optional
   threshold-exit) and bookkeeping writes that can no longer take the process with them (`0ec081a26`).
3. **Startup awaits every worker adoption and throws on the first failure.**
   `daemon-supervisor.ts:830-844` awaits `Promise.all(workersToAdopt.map(adoptOrRecoverWorker))` and
   rethrows, which lands in the startup catch at `:858` — `markReady()` at `:857` is never reached, so
   one wedged descriptor blocks or kills the whole daemon start. Our fix: adoption moved off the ready
   path and backgrounded, `daemon_hello` reports how many workers were adopted, the startup log lists
   every session that did not come up with the reason and the recovery command, the adoption request is
   bounded at 300s, and failures are re-attempted with backoff (`0ec081a26`).

### 2.14 `execCommand` signals only the direct child and accumulates output without a bound

**Symptom.** An aborted or timed-out `pi.exec` leaves grandchildren running (holding ports, locks,
inherited stdio), and a command that prints a lot grows the host heap by the whole output.

**On `main`.** `packages/coding-agent/src/core/exec.ts:60-67` spawns with `shell: false` and no
`detached`, so there is no process group to signal; `killProcess()` at `:75-86` signals `proc` only
(SIGTERM, then SIGKILL on `proc` after 5s); and `:102-108` is `stdout += data.toString()` /
`stderr += data.toString()` with no cap. The abort listener bookkeeping and the
`waitForChildProcess` tail are correct — this is only about group kill and output bounding.

**Our fix.** `detached: true` on POSIX plus `killProcessTree(proc.pid)`, with the pid tracked so a
detached descendant is reaped on host exit; output goes through a bounded ring accumulator (the same
scheme as `bash-executor`) with tail truncation and an explicit truncation annotation in the result
(`8dde3fdfa`).

**Offer.** Patch + tests.

### 2.15 The edit tool writes in place, and can report "aborted" after the file changed

**Symptom.** Two separate problems: a crash or a full disk mid-write leaves a truncated source file;
and an edit that is aborted during the write reports an aborted outcome even though the file on disk
was modified, so the model believes the change did not happen.

**On `main`.** `packages/coding-agent/src/core/tools/edit.ts:86` is
`writeFile: (path, content) => fsWriteFile(path, content, "utf-8")` — no temp file, no rename. The
abort checks around the write are careful (`:419-421` before, `:426-428` after) but the write itself is
not interruptible, so the post-write check at `:426` reports `aborted` for a file that has already been
rewritten.

**Our fix.** `writeFileAtomic()` (temp + rename, abort checked before the rename) wired through the
same `ops.writeFile` seam, so the injected-ops tests keep working (`577f1032b`).

**Offer.** Patch + tests.

### 2.16 TUI: three ways the terminal can be lost or wedged

#### (a) `wordWrapLine` recurses without a base case when one grapheme is wider than the line

**On `main`.** `packages/tui/src/components/editor.ts:168-184`: when `gWidth > maxWidth` the function
calls `wordWrapLine(grapheme, maxWidth)` at `:174`. In that recursive call the early return at `:124-127`
cannot fire (`visibleWidth(grapheme) === gWidth > maxWidth`), and `Intl.Segmenter` yields exactly one
segment for a single grapheme cluster, so `:168` is true again with identical arguments: unbounded
recursion, `RangeError: Maximum call stack size exceeded` thrown inside layout. Reachable with a
width-2 grapheme (CJK, emoji) in a 1-column content area — a narrow tmux vertical split plus one
Chinese character is enough. We reproduced it in a built `dist` before fixing it.

**Our fix.** A guard on `subSegments.length < 2` so a single over-wide grapheme is emitted as its own
chunk instead of recursing; the concatenation still round-trips per code point, so no input is lost
(`be0123bdc`).

#### (b) An unterminated bracketed paste swallows the keyboard

**On `main`.** `packages/tui/src/stdin-buffer.ts:272-292`: while `pasteMode` is set (from `:306`, on
seeing `ESC[200~`), every incoming byte is appended to `pasteBuffer` and the function returns. The only
exit is `BRACKETED_PASTE_END`. There is no timeout, no byte cap and no key that forces an exit, so a
terminal or tmux that emits `200~` without `201~` — or anything that writes a `200~` envelope into
stdin — leaves the TUI swallowing ctrl+c until the process is killed. A complete, well-formed paste is
unaffected.

**Our fix.** A 30s paste timeout that flushes what arrived and leaves paste mode, a byte cap, and Esc
as a forced exit (`ca2ec0bda`, plus the input-chain fixes in `9afc14f35`). We still do not know which
terminal/tmux combinations emit an unterminated `200~` in the wild; a pty recording matrix would settle
it, and we have not built one.

#### (c) `sleep()` leaks one abort listener per call

**On `main`.** `packages/coding-agent/src/utils/sleep.ts:13-16` registers
`signal?.addEventListener("abort", ...)` with no `{ once: true }` and never removes it when the timer
fires. Every `sleep(ms, signal)` against a long-lived signal (a session or turn controller) retains a
listener and its closure: `MaxListenersExceededWarning` first, then unbounded growth over a long
session.

**Our fix.** `{ once: true }` plus explicit `removeEventListener`/`clearTimeout` on settle
(`56da5b1ae`). Behaviour is byte-identical; we locked both halves of the fix with mutation tests.

**Offer for all three.** Patches + tests; (a) and (c) are tiny, (b) needs a policy decision on the
timeout value.

### 2.17 Four unbounded structures in the interactive TUI (long-session memory)

**Symptom.** A TUI session left running for a day or two grows to gigabytes of RSS. We measured 2.4GB
after 38 hours on our line before these fixes, with a 3.5GB peak, while the daemon for the same period
sat at 204MB.

**On `main`.**

- The live chat component tree has no cap: components are appended per message
  (`packages/coding-agent/src/modes/interactive/interactive-mode.ts:3104` and the section builders at
  `:2312-2486`), and `chatContainer` is only ever cleared wholesale on a rebuild/session switch
  (`:2911`, `:4680`, `:6575`) — nothing trims it during a live session. The 400-message limit
  (`INITIAL_TRANSCRIPT_RENDER_MESSAGE_LIMIT`, `interactive-mode.ts:591`) applies to the initial
  transcript render, not to live appends.
- `packages/tui/src/components/image.ts:40` holds `private base64Data: string` for the component's
  whole lifetime, including components that only ever render the ANSI fallback. A session with many
  screenshots keeps every payload resident (the editor's 64MB paste cap does not apply to chat images).
- `packages/tui/src/undo-stack.ts` has no limit (no cap constant, no shift), and it survives across
  sessions; `packages/tui/src/kill-ring.ts` is an unbounded array (`:22-37`).

**Our fix.** A live chat component cap with a rebuild floor (`LIVE_CHAT_COMPONENT_LIMIT = 800`,
`enforceChatComponentCap()`, `670c7cb77`/`a526eb6f0`); base64 released once a component is
fallback-only (`05279c433`); `UNDO_STACK_LIMIT = 500` and `KILL_RING_LIMIT = 60` as real ring
structures (`fb8a90893`). The streaming side of the same problem (every token broadcasting the whole
message and the TUI re-parsing/re-lexing it) we addressed with a `streaming_deltas` wire addition —
that one is a protocol change and we would not propose it as a patch, only as prior art if the memory
profile ever becomes a priority for you.

**Offer.** Patches + tests for the four caps. The cap values are guesses tuned on our own machines; we
would rather you picked numbers you can defend.

### 2.18 Hardcoded key checks bypass the configurable keybinding tables

**On `main`.** `AGENTS.md` says keybindings must never be hardcoded with `matchesKey(keyData, "ctrl+x")`
and must live in `DEFAULT_EDITOR_KEYBINDINGS` / `DEFAULT_APP_KEYBINDINGS`. These sites still do:
`packages/coding-agent/src/modes/interactive/components/config-selector.ts:400` (`"ctrl+c"`),
`scoped-models-selector.ts:314` and `:324` (`Key.ctrl("c")`, `Key.escape`),
`packages/tui/src/components/editor.ts:930` (`"shift+space"`) and `:1303` (`"enter"`),
`packages/tui/src/tui.ts:887` (`"shift+ctrl+d"`), plus `editor.ts:813`/`:817` where a configurable
binding is OR-ed with a hardcoded one.

**Our fix.** 12 sites migrated into the tables (`142022669`).

**Offer.** Patch. Purely mechanical, no behaviour change beyond making the bindings configurable, so
it is the kind of thing we would only send if you want it — we are aware it touches files many PRs
touch, which makes it annoying to merge.

### 2.19 The worker recovery journal fsyncs every record and its compaction gate never opens

**Symptom.** Steady disk churn and a journal that grows for the life of the daemon. We measured
35.2MB and still growing for one worker on a laptop, with the worker event loop spending ~4.7% in
fsync.

**On `main`.** `packages/coding-agent/src/modes/daemon/worker-recovery-journal.ts:95-104` — every
`record()` does `openSync(path, "a")`, `writeSync`, **`fsyncSync`**, `closeSync`, then `chmodSync`.
Compaction runs only when every entry is non-busy (`:82-84`), which on a daemon with any continuously
busy session never happens, so the file only grows; and `compact()` itself writes and renames without
an fsync (`:106-113`), so the one place durability matters is the one place it is missing.

**Our fix.** Append without fsync (the record lands in the page cache, which outlives the process; the
parser already tolerates a torn final line), bounded by both a record count (matching the command
journal's `COMPACT_AFTER_RECORDS` precedent) and a byte count, `compact()` fsyncs before its rename,
and a failed compaction is logged instead of silently retried forever (`753295902`). We disclosed the
power-loss window in the changelog rather than hiding it: up to ~4096 records / ~5.4 minutes.

**Offer.** Patch + tests. The trade (durability window for throughput) is a policy call — our reading
is that this journal is already designed for a crash window, since its loader skips unparsable lines,
so per-record fsync buys nothing that the format already assumes.

---

## 3. Downstream-only machinery that might be useful to you

These are not bug reports. They are things we built because our usage (long-running multi-agent
sessions, several construction lanes in one worktree, a Python REPL kernel that runs for hours) made
the absence painful. Each entry says whether it depends on something only we have, because that decides
whether it is portable at all.

| What it is | Depends on downstream-only machinery? | Notes |
|---|---|---|
| **Kernel liveness heartbeat** — an out-of-band frame from the runtime's reader thread every 5s while a cell is in flight, carrying a loop tick, a monotonic progress counter and `bash()` facts from FIONREAD. Strict JSON (a NaN frame is refused, it does not kill the kernel), never enters the model context. (`be6570803`, `65dacb311`) | Partially: the frame is additive under a negotiated protocol version, but it is only useful if something consumes it. | This is the piece that makes "is the agent actually working?" answerable from facts instead of from "did stdout move recently". Even without our watchdog, a host that knows a kernel is alive and progressing can make better decisions about aborts, UI state and idle eviction. |
| **Stall watchdog + evidence-based vouch** — a silent turn is not aborted while there is proof of external work (a tool in flight plus kernel/host facts); the exemption has two budget tiers (50min on progress evidence, 20min on existence-only evidence), a 15min age bound on host-request evidence, carry-over of already-earned exemption across a blink in the evidence, and a hard latch that kills once the budget is spent. (`61a3ba890`, `f307f943d`, `3046b0580`, `d95021edd`) | **Yes** — we have a stall watchdog; you do not (Appendix A.2). | Offered as a design, not a patch. The transferable part is the budget/latch discipline: an exemption whose evidence can blink must not be renewable forever, and "the evidence TTL must be at least as long as the budget it feeds" is a rule we only learned after a reviewer simulated 10 hours and found zero aborts. |
| **Kernel protocol negotiation by environment** — `PRIME_AGENT_KERNEL_PROTOCOL`, host requests 4, clamped to [3,4], and a host that negotiated 3 never sends a v4 frame. One variable is the rollback lever for every v4 capability. (`30c726254`, `6209e1d80`) | No — but it only pays off once the runtime and the host can be at different versions, which is a property of how we deploy. | You already have a schema revision + digest discipline on the daemon side; this is the same idea for the kernel pipe, where today an exact match is required. |
| **Versioned kernel venvs with reference counting** — one sibling directory per build identity, `.in-use` refcount, never rename/rebuild/delete a referenced generation, keep one unreferenced previous generation. (`ca92e1b34`, `c21d47a76`) | No. | This is the structural fix behind 2.1(c) and it is platform-independent by construction: nothing is ever renamed into use, so the Windows rename-while-open failure has nothing to fail on. |
| **Snapshot `preserve_names` merge write** — see 2.1(d). (`5943aa551`, `5172aea6e`) | Needs a runtime capability token, so it is a two-part change. | |
| **Kernel death attribution + auto-revive with a reset notice** — structured cause (code/signal/origin, `oom_suspect` only on memory evidence), separated from an intentional host kill, written to disk; the next cell revives the kernel and the model is told what rolled back, what did not, which host replies were lost, and that side effects are *not* rolled back; 3 revivals/hour then a fail-closed `KernelUnavailableError` carrying the death chain. (`a5179de81`, `f18c2ba77`) | No, but it overlaps `#2028`. | The honest part is the reset notice: reviving is not lossless, and a model that is not told will confidently use variables that no longer exist. |
| **Event-sequence gap detection + circuit breaker** — see 2.7. (`cb749c7bc`) | No. | |
| **Pending-delivery queue with countable receipts** — 100/session, 24h deadline, explicit drain receipts, and abandoned deliveries split into `undelivered` (provably never handed over) vs `uncertain` (handed over, outcome unknown). (`7406aa22d`, `82c2340ec`) | No. | The split is the part we would defend hardest: "we do not know whether it arrived" and "it is safe to retry" are different facts, and a queue that reports both as one forces the caller to guess. |
| **Exactly-once agent messages** — sender-minted message id, receiver remembers 1024 ids, a resend answers with the first receipt. Two identical texts sent deliberately still both arrive: we consciously did not adopt a content-derived idempotence key. (`4b3399eb6`) | Partially — it assumes our send path. | Your command journal already gives you idempotence at the *command* level (`daemon-supervisor.ts:1848-1866`), which may make this unnecessary; see section 5. |
| **Daemon timeout tiers** — long 24h / adoption 300s / deliver 120s / read 30s, with the client reconnect budget derived from the adoption tier instead of hardcoded. (`5b37f330d`) | No. | We found four distinct combinations where neither side was misbehaving and the user still saw a dead session, all because one 30s client timeout was compared against one 24h server timeout. |
| **Supervisor crash guardrails** — see 2.13(2). (`0ec081a26`) | No. | |
| **Failed-worker reaper** — 24h + two independent proofs of death + no schedule + no client ⇒ archive with the real failure reason, then remove; suspended while the daemon reports itself degraded. (`0ec081a26`) | No. | See section 5: we could not fully verify what your current sweeps do here. |
| **Bounded waits with retryable timeout facts** — see 2.4. (`dfc3df92d`) | No. | |
| **Aborted tool output preservation** — a 1.25s bounded harvest plus the last 8KB of a killed cell's output, and a structured abort cause on the ipython path. (`8a6b8f1f4`, `f60529a43`) | No. | Before this, an aborted cell's entire output was the 19-character string "Request was aborted." — 37 killed cells in our logs, all 19 characters, none of them diagnosable. |
| **`test-hygiene` CI gate** — a scanner for private-member probes in tests (`as unknown as { _foo }`, same-file shadow types, `vi.spyOn(target, "_foo")`), with a frozen baseline that only shrinks and a mandatory-reason suppression comment that the gate counts and prints. | No — it is repo tooling. | Your `AGENTS.md` already states the rule; this is the part that makes it enforceable. Ours caught 23 pre-existing probes on the day we turned it on. |

---

## 4. Things we found on `main` and have *not* fixed in our tree either

Listed because they are cheap for you to confirm and we would rather hand over the observation than
sit on it. We are not claiming a fix for any of these.

- **`package.json` exports a module that does not exist.** `packages/coding-agent/package.json:20-22`
  exports `"./hooks"` → `./dist/core/hooks/index.js`, and `tsconfig.examples.json:7` maps
  `@earendil-works/pi-coding-agent/hooks` to `./src/core/hooks/index.ts`, but there is no
  `src/core/hooks/` in the tree. Any consumer importing that subpath fails to resolve. Either the
  export is stale or the module was dropped in a refactor. (Same in our tree — we carried it along and
  only noticed while writing this.)
- **Codex service-tier pricing can over-count.** `resolveCodexServiceTier()` returns the *requested*
  tier when the response says `default`
  (`packages/ai/src/providers/openai-codex-responses.ts:348-356`), and
  `getServiceTierCostMultiplier()` then prices it at 2× / 2.5× / 0.5× (`:319-346`). Per OpenAI's
  published behaviour, a request that exceeds the priority ramp is served at Standard and the response
  says so; trusting the request over the response charges the user for a tier they did not get. The
  non-Codex path prefers the response, which looks like the correct precedent.
- **Duplicate item ids on a cross-provider handoff.** `openai-responses-shared.ts:169-186` assigns
  `msg_${msgIndex}` to any text block without a parsed signature, so two such blocks inside one
  assistant message share an id. Whether OpenAI merges or rejects those we have not established — we
  only verified the id collision itself.
- **`usage.input` can go negative.** `(promptTokenCount || 0) - (cachedContentTokenCount || 0)` at
  `google.ts:219-223` (and the vertex twin) has no floor, while `openai-completions.ts:1116-1118`
  clamps with `Math.max(0, ...)`. A proxy that reports more cached than prompt tokens produces a
  negative input cost that silently offsets the bill.

---

## 5. Not settled — we could not convince ourselves either way

We are listing these rather than dropping them, because a downstream "we are not sure" is still a
cheaper starting point than re-deriving the question.

1. **Whether a cell abort leaves host requests dangling.** Our downstream fix made an abort cancel only
   host request types the host declared read-only (`rlm.find_models`, `list_subagents`, `agent_observe.*`,
   `model.info`, `agent_message.list_agents`) and leave side-effecting ones (`rlm.run`,
   `agent_message.send`) teardown-only, so Esc on a spawning cell cannot kill a child that was just
   admitted (`ecfa71d37`). On `main` we found partial handling — a bounded
   `lateSentAgentMessageHandlers` map with eviction (`repl-manager.ts:1133-1145`) and a late-reply
   dispatch path (`:1119-1131`) — but we did not establish what happens to a *generic* in-flight host
   request when its cell is aborted, so we cannot say whether the same hole is there.
2. **Whether a dead worker's descriptor is ever retired.** `scheduleOwnedWorkerCleanup()`
   (`daemon-supervisor.ts:1603-1626`) covers workers whose *owner client* disappeared. We could not
   find a sweep that retires a descriptor whose process is gone but which had no owner client, and
   2.8 shows `kill` cannot do it on demand — but the recovery ladder has enough moving parts
   (`deferWorkerRecovery`, `MAX_DEFERRED_RECOVERY_ROUNDS`, `processIdentity`) that we are not willing
   to call it a defect without a longer read. Our downstream evidence was forensic: 73% of session
   leases (94/128) pointing at dead pids and 46% of ledger rows (770/1666) pointing at subagents that
   no longer existed, on machines running our *old* code, so it does not transfer to yours.
3. **Whether the TUI rebuilds tool panels per streamed delta more than it needs to.**
   `ToolExecutionComponent.updateArgs()` unconditionally calls `updateDisplay()`
   (`packages/coding-agent/src/modes/interactive/components/tool-execution.ts:219-222`), and
   `updateDisplay()` does reuse some components (`:344-366`), so we could not tell without measuring
   whether the per-delta cost matters on your render path. Ours now detects argument changes by object
   identity, which is O(1) and never misses a real change (`cbf7a5169`); we measured 14.3ms per 40KB
   tool call over 397 deltas on the pre-fix code.

---

## 6. Sync plan and how to reach us

**Where we are.** Merge base `d74a75fea` (2026-09-04). You are 41 commits ahead of it, including
`#2028` ("Harden session persistence, worker recovery, and daemon refreshes") and `#2218` (subtree
counts in the bar), both of which touch ground we also changed. We are on 0.9.1; you are on 0.9.4.

**What we plan to do next.** A fourth sync round, merging (never overwriting) `upstream/main` into
`merge/repl-kernel`, with the usual discipline: every conflict recorded as "took whose, why, and how
to flip it back", all 264 downstream-only files and 54 downstream-only test files preserved, and the
schema revision recomputed rather than hand-written. Two specific collisions we already expect:

- `#2028`'s defunct-memo drop in `tools/ipython.ts:388-396` overlaps our revive path; we will rebase
  ours onto yours rather than keep both.
- The kernel stderr redesign in the `#1947` follow-ups overlaps four of our functions
  (`wireChild` / `openStderrLogFd` / `waitForReady` / `cleanupResources`). We took the 09-02 version of
  that PR; the later pipe-based redesign will conflict, and we plan to take yours.

One thing we would ask for, if it is cheap: our line and yours have each claimed daemon schema
revisions 23, 24, 25 and 26 for *different* wire shapes, so we retired all four and moved to 27, then
28 and 29 for our own additions. The collision table is a comment in our `daemon-protocol.ts`. If you
ever cut a release from a tree that has merged ours, the digest will not match either side; there is
nothing to fix, but knowing that saves someone a confusing afternoon.

**Contact.** Open a Discussion and mention `@Dmatut7`, or comment on any issue we have opened. If it is
easier, we are also happy to be told "send patches to this address" or "these three we want, the rest
we do not" — a short triage reply is worth more to us than silence, and we will not take a "no" as an
affront. If you would rather we did not publish this kind of comparison at all, say so and we will keep
future findings in private reports.

---

## Appendix A — Checked, and does not apply to your tree

We verified these on `main` and found either a different design or a fix already in place. Recorded so
nobody (including us) re-reports them.

1. **A kernel that dies unexpectedly does not brick the session on `main`.** Our downstream line had a
   permanently bricked session after an OOM-kill: `state` stuck at `shutdown`, every later call
   throwing "Kernel has been shut down", and `restart()` unreachable. On `main`, `#2028`
   (`844e85545`, 2026-09-07 — not in our tree yet) drops the memo when the manager is defunct, so the
   next `ensure()` spawns a fresh kernel and restores from the snapshot
   (`packages/coding-agent/src/core/tools/ipython.ts:388-396`, `isDefunct` at
   `repl-manager.ts:1647-1649`). What remains is only the attribution gap in 2.2.
2. **There is no stall watchdog on `main`, so our whole "misfire kill" cluster does not apply.** We had
   43 production aborts, all at silentMs≈900000, with 144/144 in-flight tools being ipython, and a live
   probe killed at exactly 900.0s — because the liveness criterion was "did the current cell write to
   its own stdout recently", which cannot distinguish a healthy long `await bash(...)` from a deadlock.
   Your tree has no `stall-watchdog.ts` and no equivalent criterion, so there is nothing to fix; the
   heartbeat in section 3 is what we built to make such a criterion safe, and we would not suggest
   adopting the watchdog without it.
3. **Terminal-state misclassification of a killed child does not apply.** The "completed without
   sending a reply" wording and the four-state classifier (error / aborted / stall_killed /
   completed_without_reply) are ours. On `main` the notice kinds are `cancelled` and
   `completed_without_reply` (`packages/coding-agent/src/core/messages.ts:161-173`, `:218-235`), the
   failure and cancelled notices are *not* gated on `_parentReplyCount`
   (`agent-session.ts:11297-11316`) and only the success-without-reply notice is
   (`:11248-11262`), which is the right way round.
4. **Deferred terminal notices are not dropped after 5 minutes on `main`.** That deadline
   (`RLM_TERMINAL_NOTICE_ABANDON_AFTER_MS`) is our own invention, added to keep an undeliverable notice
   from pinning a session as active forever. Your side defers without a deadline
   (`agent-session.ts:4995-5025`), demotes durable notice actions back into the pending queue across a
   suspension (`:5008-5025`) and persists the queue across replacement
   (`getPendingNextTurnMessageSnapshots` / `restorePendingNextTurnMessages`, `:7207-7234`) — a different
   and reasonable answer to the same problem. We flag only the trade-off we hit: with no deadline, a
   notice whose parent pump stays suspended keeps that session non-evictable, which is what our
   abandonment driver was for.
5. **Snapshot ids on `main` are content-derived, so the "was superseded" churn we saw is ours.** Your
   id is a sha256 of `activeSessionId:sessionId:lastEventSequence:messages.length`
   (`daemon-supervisor.ts:5300-5314`), which is exactly the property our catch-up path lacked (we
   minted `catchup-${reason}-${randomUUID()}`). Our idempotency misses were self-inflicted; we fixed
   them by retrying catch-up and detecting gaps instead of changing the id, so as not to undo `#1229`.
6. **`response.incomplete` is handled on `main`.** `openai-responses-shared.ts:510-530` reads
   `incomplete_details` and maps the status; the codex path accepts `response.incomplete` alongside
   `response.completed` (`openai-codex-responses.ts:461`, `:937`). Our finding predates this.
7. **The per-provider retry gaps we fixed have been superseded by a better design on your side.** We
   had patched Codex's retry gate (it retried 401/400 because the catch only tested for "usage limit"),
   its ignoring of `Retry-After`, its ignoring of `options.maxRetries`, and the absence of any retry on
   mistral/google/vertex, plus a `maxRetryDelayMs` setting that was passed everywhere and consumed
   nowhere. `main` now has a single session-level policy in
   `packages/coding-agent/src/core/provider-retry.ts` (permanent kinds, Retry-After-aware capped
   delays, `maxRetryDelayMs` consumed), which covers all providers from above. We will re-check our
   per-provider patches against it at the next sync and expect to delete most of them.
8. **The semantic-edges ledger is not written with bare `node:fs` on `main`.** `core/semantic-edges.ts`
   in your tree has no `appendFileSync`/`mkdirSync` at all (the ledger moved to another substrate,
   `#1987`/`#1984`). Ours still does — that one is our bug, not yours.

---

## Appendix B — Numbers, and where to look

**Divergence.**

| | |
|---|---|
| Our repository | `Dmatut7/prime-agent-rlm`, branch `merge/repl-kernel` |
| Our version | 0.9.1 (`packages/coding-agent/package.json:3`) |
| Your head at verification time | `fb2db8ee1` (2026-09-11), version 0.9.4 |
| Merge base | `d74a75fea` "feat: token and cost details on agents view rows (#2003)" (2026-09-04) |
| Commits we are ahead | 325 |
| Commits we are behind | 41 |
| Upstream merges so far | 3 (18 commits, 15 commits, 40 commits) |
| Unmerged upstream PRs we took | 9 in round 1 (#1882, #367, #1700, #1249, #1251, #1253, #1519, #413, #887), 3 cherry-picked in round 3 (#2027, #1947, #1896) |

**Our most recent round** (2026-09-11, multi-agent stability, `10b6b4e55..e1eb54bd3`): 54 commits,
152 files, +27,634/−826. The findings behind it were read by more than one reviewer, and the
load-bearing ones were reproduced on a running daemon rather than argued from code alone. Each fix
carries a regression test that was seen to fail first. The rule for the round was that no fix may
reduce what the agent can do, and every place where we accepted a reduction is written down — including the ones that hurt: a hung interactive
`bash` client is now rescued at 20 minutes instead of 15, a synchronous `time.sleep(1200)` cell is
still killed because it is genuinely indistinguishable from a deadlock, and a kernel revival is not
lossless.

**Documents in our repository.**

- `FORK_NOTES.md` — the running changelog, newest first; each round says what changed, why, and what a
  user notices.
- `docs/fork/audit-findings.md` — the R1/R2 defect ledger (F1-F77), including the findings we
  *withdrew* after cross-examination, with the reason.
- `docs/fork/review-findings-r3.md`, `docs/fork/fix-plan-r3.md` — the 2026-09-05 six-lane review
  (28 clusters) and its fix plan.
- `docs/fork/ma-multistability-ops.md` — operational side of the 2026-09-11 round: observable
  signatures, rollback switches, deployment-day checklist, known-flaky list.
- `docs/fork/local-axes.md` — the local behaviours we deliberately keep and why.
- `docs/fork/sync-upstream-r3.md` (+ appendix) — the last sync round, including the schema-revision
  collision table.
- `AGENTS.md`, section "Shared-Worktree Construction Discipline" — what we learned the hard way about
  several agents committing in one worktree. Three incidents, all with the same root cause: our
  pre-commit hook re-adds every staged path from the working tree, so index-level separation does not
  work and a commit is file-granular whether you intended it or not. If you ever run agents in
  parallel on this repository, that section is written for you.

**Issues and PRs referenced above.**
[#2238](https://github.com/PrimeIntellect-ai/prime-agent/issues/2238) (ours, closed by the vouch bot) ·
[#1249](https://github.com/PrimeIntellect-ai/prime-agent/pull/1249) ·
[#1251](https://github.com/PrimeIntellect-ai/prime-agent/pull/1251) ·
`#2028` (`844e85545`) · `#2218` (`fb2db8ee1`) · `#2027` · `#1947` · `#1896` · `#1229`

**A note on our evidence standard.** Every "on `main`" line above was read in your tree at `fb2db8ee1`
on 2026-09-11, and for the negative claims (Appendix A) we tried to find the code path that would make
us wrong before writing it down. We have been wrong before in exactly this way — an early version of
our own audit claimed a production failure rate that turned out to be measured across a version
boundary, and one "the deeper it is, the more it fails" claim survived only as "it happens". Where we
could not settle a question, it is in section 5 instead of section 2.
