# Follow-up to #2239: a second round of defects we can still reproduce on `main`

From: the `Dmatut7/prime-agent-rlm` maintainers (independent downstream line, branch `merge/repl-kernel`)
To: PrimeIntellect-ai/prime-agent maintainers
Verified against: `upstream/main` at `fb2db8ee1` ("Count running/idle subagents across the whole subtree in
the bar (#2218)", 2026-09-11), version 0.9.4
Date: 2026-09-13

This is a follow-up, not a restatement. The 27 items in [#2239](https://github.com/PrimeIntellect-ai/prime-agent/discussions/2239)
and the four cluster discussions (#2261-#2264) are not repeated here; where a new item is adjacent to one of
those, we say so and give the number. Everything below was found during a fresh audit round of our own tree
(2026-09-12/13) and then **re-read on `main` at `fb2db8ee1`** before being written down: every file:line in
section 2 is a line in your tree at that commit, not in ours. Items we could not convince ourselves apply to
you are in Appendix A, and items we could not settle are in section 4.

We still have not opened PRs (`CONTRIBUTING.md:27-29`), and the offer is the same as last time: for most of
these we have a commit, a regression test that fails without it, and a changelog fragment, so a patch is cheap
for us to produce if you want one. Where the fix embeds a policy judgement (a timeout value, a retry budget, a
durability trade) we would rather have your number than ours.

Format per entry: **Symptom** / **On `main`** / **Our fix** (commit in our repository) / **Offer**.

---

## 1. Summary

| Cluster | Items |
|---|---|
| Compaction and the provider input limit | 3 |
| `/share` | 2 |
| World-readable spill files in the shared tmpdir | 1 |
| One corrupt file disables a shared service | 2 |
| Journals and registries that only grow | 4 |
| Durable authority state is not durable | 1 |
| Supervisor single thread and unbounded waits | 4 |
| Silent negative results | 3 |
| Kernel host callbacks | 1 |
| Ledger replay and reconciliation cost | 1 |
| Session replacement, import and deferred bash | 4 |
| One shared kernel venv across checkouts | 1 |
| Resource discovery walks and `!command` caching | 2 |
| TUI cleanup | 2 |
| Test harness (4603) | 1 |
| **Total in section 2** | **32** |

Plus 4 things we found on `main` and have **not** fixed in our tree either (section 3), and 4 we could not
settle (section 4).

---

## 2. Defects we can still reproduce on `main`

### 2.1 Compaction: the summarization request has no input budget, and nothing recovers when it is rejected

#### (a) The summarization request is the whole context, in an estimator caliber, with no retry

**Symptom.** A session that reaches the compaction threshold cannot be compacted, ever. Auto-compaction fails
on every threshold check with the same provider 400, and `/compact` — the user's only self-rescue — fails the
same way, because it is the same code path. We have the production transcript: 14 consecutive
`compaction_outcome` records over 6.5 hours, byte-identical
(`Auto-compaction failed: Summarization failed: 400 <400> InternalError.Algo.InvalidParameter: Range of input
length should be [1, 983616]`), then a manual `/compact` failing with the same string. Across the sessions on
this machine the same error appears 52 times in four sessions.

**On `main`.** Compaction triggers at `contextTokens > contextWindow - settings.reserveTokens`
(`packages/coding-agent/src/core/compaction/compaction.ts:220-223`), where `contextTokens` comes from
`estimateTokens`, a chars/4 heuristic (`:229`, and the comment at `:226-227` calls it "conservative
(overestimates tokens)" — for CJK-heavy or escape-heavy transcripts it underestimates; we measured a real
ratio of 1.60 against provider-reported usage on the session above, 981,863 real tokens for 614,241
estimated). `prepareCompaction` then puts **every** message from the previous compaction boundary up to the
cut point into `messagesToSummarize` (`:636-640`) with no size cap, and `generateSummary` serializes all of it
into one request (`:524-546`): `<conversation>` + the previous summary + the instruction template, against
`SUMMARIZATION_SYSTEM_PROMPT`. Nothing in that path accounts for

- the difference between the chars/4 estimator and the provider's tokenizer,
- a provider whose real input cap is lower than the declared `contextWindow` (the case above: declared
  1,000,000, accepted 983,616 — and `1,000,000 - 16,384 = 983,616`, so the compaction *trigger* and the
  provider's *rejection line* are the same number),
- the size of the wrapper itself (a previous summary is user-scale: ours was 22,604 characters),
- or the framing of the summarization call's own system prompt.

The only token arithmetic in the function is `maxTokens = floor(0.8 * reserveTokens)` for the *output*
(`:536`). When the provider rejects, `generateSummary` throws (`:571-573`), and the failure path records
`Auto-compaction failed: <message>` (`packages/coding-agent/src/core/agent-session.ts:9184-9193`) with no
consecutive-failure state, no backoff and no recovery guidance; the next threshold check rebuilds the same
oversized request. There is no retry on an input-length rejection anywhere on this path
(`completeWithProviderRetry` at `:561-569` handles transient kinds, and a 400 for an oversized body is
permanent by construction).

**Our fix.** A budget computed in the request's own terms before the call: `inputLimit = min(catalog
contextWindow, a measured per-model input cap, the cap the provider announced in an earlier rejection)`, minus
the measured wrapper text, minus the summarization system prompt, minus `reserveTokens`, minus a 2% margin,
then converted back into estimator caliber with an inflation factor anchored on the last real `usage` in the
slice; a character-level clamp that always keeps the newest message and says in the text what it dropped; and
a bounded shrink-and-retry (2 retries, inflation ×1.25 each) that only fires on recognisable input-length
rejections and re-issues a fresh wire call each time so one Idempotency-Key never covers two bodies. Plus a
consecutive-failure counter shared by auto and manual compaction that appends actionable recovery options from
the third failure (`791ce355f`, `5f26fb9e6`, `35d7723f5`).

**Offer.** Patch + tests (11 cases; 6 of them fail without the fix, including a fake provider that counts the
request in its own caliber and returns your production error string). The measured-cap table is the only part
that needs your judgement: we only put models in it that we have evidence for, and everything else is covered
by the retry learning the cap from the rejection text.

#### (b) `/tree` branch summaries budget in the same estimated caliber

**Symptom.** Same 400, different command: branch navigation summaries have their own path to the same wall.

**On `main`.** `packages/coding-agent/src/core/compaction/branch-summarization.ts:268-271`:
`const contextWindow = model.contextWindow || 128000; const tokenBudget = contextWindow - reserveTokens;` and
that budget is spent in `estimateTokens` units, with no deduction for the `<conversation>` wrapper or the
instruction template (`:288`) and no input-length retry (`:297-310`).

**Our fix.** Same budget function as (a), applied in two passes (select with inflation 1, anchor the inflation
on the selected messages, select again) plus the same character clamp (`791ce355f`).

**Offer.** Patch + tests (3 cases).

#### (c) `packages/ai`: a provider whose input-cap rejection is not in `OVERFLOW_PATTERNS` gets no overflow recovery at all

**Symptom.** Main turns — not just compaction — fail with a 400 and the session does not enter overflow
recovery, so nothing trims and the next turn fails identically. We have four-turn streaks of this on disk with
`usage` all zero.

**On `main`.** `packages/ai/src/utils/overflow.ts:32-54` lists 21 patterns, three of them generic fallbacks
(`/context[_ ]length[_ ]exceeded/i`, `/too many tokens/i`, `/token limit exceeded/i`). DashScope / Bailian
compatible-mode says `Range of input length should be [1, 983616]`, which matches none of them, so
`isContextOverflow` (`:120-147`) returns false and the overflow branch in
`agent-session.ts:8952` never fires. The file's own doc comment (`:105-114`) anticipates this for custom
providers; we are reporting it because this one is a first-party-compatible endpoint that a
`settings.json`-configured OpenAI-compatible model reaches, and because the fix is one line.

**Our fix.** Added `/range of input length/i` with the provider named in the comment, plus a negative control:
`Range of max_tokens should be [1, 32768]` must **not** count as overflow, because trimming the context cannot
fix an output cap (`791ce355f`).

**Offer.** One-line patch + the negative-control test.

### 2.2 `/share`

#### (a) The gist spawn has no `'error'` listener, and `'close'` never follows a failed spawn

**Symptom.** `/share` either takes the whole interactive process down or wedges with the "Creating gist..."
loader on screen and no way out except Esc.

**On `main`.** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:9173-9184`: the promise
resolves only from `proc.on("close", ...)`, and `spawnHidden("gh", ["gist", "create", "--public=false",
tmpFile])` (`:9174`) has no `'error'` listener. We measured Node's behaviour (v22): a spawn failure emits
`'error'` and **does not** emit `'close'`, and an `'error'` event with no listener throws out of the
EventEmitter. The interactive process installs no `uncaughtException` handler — only daemon mode does
(`packages/coding-agent/src/modes/daemon/daemon-mode.ts:641-651`) — so in the TUI this is a crash; in an
embedder that does install a handler, the `await` at `:9173` never settles. The pre-check at `:9125`
(`spawnSyncHidden("gh", ["auth", "status"])`) narrows the window but does not close it: `gh` leaving `PATH`,
`EMFILE` and `EACCES` all land after it.

**Our fix.** `proc.on("error", …)` rejecting the promise, plus an upload bound that kills the child and
rejects, so all three shapes (error, silence, slow) settle; the loader's own abort stays the fast path for the
user (`542b03e5e`).

**Offer.** Patch + tests. Small.

#### (b) The export is written to a fixed, predictable, world-readable path in the shared tmpdir

**Symptom.** On a multi-user machine, the full session export is readable by every local user while it exists;
a local attacker can also make the export overwrite a file of their choosing.

**On `main`.** `interactive-mode.ts:9136`: `const tmpFile = path.join(os.tmpdir(), "session.html");` — a
constant name, no `mkdtemp`, no `O_EXCL`. `exportToHtml` writes it with
`writeFileSync(outputPath, html, "utf8")` (`packages/coding-agent/src/core/export-html/index.ts:265`), i.e.
0666 & ~umask → 0644, and `writeFileSync` follows symlinks, so a pre-planted `/tmp/session.html -> ~/.ssh/authorized_keys`
turns an export into a truncating overwrite. The content is the whole session — messages, tool results, system
prompt and tool definitions — base64-embedded at `export-html/index.ts:155`, which is not protection. Cleanup
is `fs.unlinkSync` inside `restoreEditor` (`:9151-9161`) only: a failure between the export and the loader
mount, or a process death, leaves the file behind.

This is adjacent to item 2.11 of #2239 (session transcripts and #1249) but it is a different exposure: not a
permission gap on a private directory, but a constant filename in a world-writable one.

**Our fix.** `createShareTempHtmlFile()` — a `mkdtemp` 0700 directory holding a 0600 file, removed on every
exit path including the cancel and the loader-construction failure (`0092dd04a`, `542b03e5e`).

**Offer.** Patch + tests.

### 2.3 Full bash output spills to the shared tmpdir at 0644

**Symptom.** Everything a bash command printed — including the part `truncateTail` cut out of the model's
context, which is where a leaked credential usually is — sits in `/tmp/pi-bash-<hex>.log` /
`/tmp/pi-output-<hex>.log`, readable by every local user, for as long as the run lives.

**On `main`.** `packages/coding-agent/src/core/tools/output-accumulator.ts:19-22` builds
`join(tmpdir(), "<prefix>-<16 hex>.log")` and `:51-52` opens it with `createWriteStream(this.path)` — no
`mode`, so 0666 & ~umask → 0644 (we measured 644 under umask 022). `packages/coding-agent/src/core/bash-executor.ts:47`
uses the same spill (`new OutputSpill("pi-bash")`). Every other persistent artifact in the tree is written
0600/0700 on purpose — `cron-jobs.ts:1554` (`{ mode: 0o600, fsync: true, fsyncDir: true }`),
`snapshot-transcript-cache.ts:268,275` (`{ mode: 0o600 }`) — so these two are the outliers, and unlike
2.11/#1249 they are in the world-shared directory rather than under `~/.prime`.

**Our fix.** `{ mode: 0o600 }` on the stream (no behaviour change otherwise) (`542b03e5e`).

**Offer.** One-line patch.

### 2.4 One corrupt file disables a service for every session

#### (a) A single wrecked `scheduled-jobs.json` disarms cron and heartbeats process-wide

**Symptom.** Every scheduled job and every heartbeat in the daemon silently stops firing. One warn line is the
only trace. Restarting does not help.

**On `main`.** `packages/coding-agent/src/core/cron-jobs.ts:1533-1542`: `readJobsState` guards only
`existsSync` and then `JSON.parse(readFileSync(...))` with no try. `readStates` maps it over **every**
registered session artifact file (`:786-791`), so one corrupt file throws for all of them. The chain that
kills the scheduler: timer → `runDue()` → `claimDue` throws → the `finally` at `:981-986` calls
`scheduleNext()` → `nextActiveRunAt()` (`:773-780`) → `readJobs()` → the same file throws again → the
exception escapes the `finally` **before** `setTimeout` at `:1057` is reached, so the timer is never re-armed;
`runDue`'s rejection surfaces from `void this.runDue()` (`:1059`) as an unhandled rejection, and in a daemon
worker `unhandledRejection` is `process.exit(1)` (`daemon-mode.ts:646-651`). `wake()` fails the same way, and
on restart `start()` → `recoverInterruptedDispatches` (`:940`) throws on the same file.

**Our fix.** Quarantine instead of throw: an unreadable store file is treated as an empty state, the bytes are
left exactly as they are (a read path does not get to destroy data), one warn per incident names the path but
not the parse error (a JSON error quotes the input, and a jobs file holds prompts), and the next atomic write
to that session is the self-heal (`542b03e5e`).

**Offer.** Patch + tests.

#### (b) The RLM spawn ledger fails closed with no exit, and the error does not say which file

**Symptom.** `rlm()` spawn, subagent deletion and `delete_saved_session` fail permanently for one sessions
directory, while the session *list* keeps working — so the failure looks like a spawn bug rather than a
corrupt file. The message is `Malformed RLM ledger line N: …` with no path.

**On `main`.** The fail-closed policy is deliberate and documented (`packages/coding-agent/src/core/event-log.ts:24-25`:
"Interior malformed lines fail closed"), and `parseLedgerLine` implements it
(`packages/coding-agent/src/modes/daemon/rlm-ledger.ts:226-286`). What is missing is any way out:

- no quarantine and no repair-on-read;
- `seed()` returns immediately when the file exists (`:613`), so re-seeding cannot heal it;
- `appendSpawnUnlocked` replays the ledger *before* appending (`:469`), and `appendRenameByChildPath` too
  (`:345`), so you cannot even append your way back to a readable file;
- interior poison is reachable: `repairTailSync` gives up when its double read is unstable
  (`event-log.ts:161-164`), and the ledger has several writers (the supervisor and each worker hold their own
  `EventLog` on the same path), which is exactly the case that turns a tolerable torn tail into a permanent
  interior line;
- readers are asymmetric: `handleList` and `withPassiveRlmDescendantInfos` (`rlm-ledger.ts:764-778`) catch and
  degrade, so the catalog looks healthy while spawn/delete are dead;
- the message carries the line number but not the path, and the path is
  `<agentDir>/rlm-ledger/<sha256(sessionsDir)[:16]>.jsonl` (`:204-208`) — not something an operator can
  derive by eye, so the one available remedy (delete the file, let it re-seed flat) cannot be started.

**Our fix.** Partial, and we are explicit about it: the error now names the ledger path and the sessions
directory (`59a924082`). We have **not** built the quarantine/repair exit — that is a policy call about what a
topology authority is allowed to forget, and we would rather you made it.

**Offer.** The diagnosability half as a patch; a design note on the quarantine half if useful.

### 2.5 Journals and registries that only grow

#### (a) The orphan-process journal has no compaction, and every record costs a synchronous `ps`

**Symptom.** A long-lived session worker's `.orphans.jsonl` grows for the life of the process, and every
reap/read re-parses all of it synchronously. Separately, every child spawn blocks the event loop on a `ps`
fork.

**On `main`.** `packages/coding-agent/src/core/orphan-process-journal.ts:26-51`: `recordOrphanProcessState`
appends one record with `openSync`/`writeSync`/**`fsyncSync`**/`closeSync`, and computes the identity with
`getProcessStartId(pid)` at `:31` — which on macOS/BSD is `execFileSyncHidden("ps", …)`
(`packages/coding-agent/src/core/session-lease.ts:122`, `:147-180`), i.e. a **synchronous subprocess fork on
the spawn hot path** (`utils/shell.ts:209`, `kernel/repl-manager.ts:328`). There is no prune, compact or
truncate anywhere in the file; the only removal is `clearOrphanProcessJournal` = `rmSync` (`:117-119`), called
at worker start/exit (`cli/owned-session-worker.ts:301-307`, `:468`) and in the reap fallback
(`daemon-supervisor.ts:4103`). `readActiveOrphanProcesses` (`:53-96`) is a whole-file `readFileSync` plus a
`JSON.parse` per line, called from the reap path (`daemon-supervisor.ts:4093`), worker startup
(`owned-session-worker.ts:301`) and `daemon-ps` (`:946`). Our production measurement: 890KB / 5,629 records in
10.5 hours, roughly half of them provably dead.

This is the third journal with the shape reported in #2239 item 2.19 — and the two siblings do have bounds
(`command-recovery-journal.ts:43`, `worker-recovery-journal.ts`), which is why we read this one as an
oversight rather than a design.

**Our fix.** Size/record-bounded compaction (4096 records / 4MB, matching the siblings) under the existing
cross-process lock, plus a pid-only record at spawn with the start id captured asynchronously
(`59a924082`, `781d91985`).

**Offer.** Patch + tests.

#### (b) Command-journal entries are only ever removed by an ack that often cannot arrive

**Symptom.** The command journal accumulates entries forever, and past a threshold every mutating command pays
a full synchronous journal rewrite.

**On `main`.** `packages/coding-agent/src/modes/daemon/command-recovery-journal.ts`: `acknowledge()`
(`:112-127`) is the only deletion path — no TTL, no per-connection cleanup, no bound on the active set. Acks
are lost in three ordinary shapes: a client-side request timeout (the late response finds no pending request,
so no ack is sent, `daemon-client.ts:538-541` is only reached from the response path), `close()` destroying
the socket immediately after the ack is written, and reconnection — the idempotency key includes
`protocolClientId = "daemon-client:" + randomUUID()` (`daemon-client.ts:152`), which is fresh per
`DaemonClient`, so a new connection can never ack the previous one's entries. The hot-path cliff:
`recordResult` compacts at `recordCount >= COMPACT_AFTER_RECORDS (4096)` (`:43`, `:107-108`), and `compact()`
sets `recordCount = records.length` = 2 × active entries (`:206`), so from 2048 stuck-active entries onward
**every** mutating command does a synchronous full rewrite + fsync + rename + directory fsync (`:187-207`) on
the supervisor's single thread. Our production journal: 432 `received`, 386 `acknowledged`, 46 permanently
active.

**Our fix.** Expiry plus an active-entry bound, so an unacked command stops occupying the journal (and stops
forcing a rewrite per command) for the life of the daemon (`59a924082`).

**Offer.** Patch + tests. The expiry window is a policy number — we would take yours.

#### (c) Dead supervisor-owner registrations are reclaimed only on conflict, and the whole table is re-read synchronously at startup

**Symptom.** `~/.prime/supervisor-owners/` accumulates one directory per unclean exit forever, and daemon
startup cost grows with the machine's history.

**On `main`.** `packages/coding-agent/src/modes/daemon/daemon-supervisor-ownership.ts:473-488`: the reclaim
loop only looks at directories where `ownerConflicts(scope, record)` (`:739` — same socket path or same
descriptor dir), so a supervisor that ran on a *different* socket path (test fixtures, `--daemon-socket`, an
update handover) never conflicts with anything and is never reclaimed; `release()` runs only on a clean
shutdown. Cost: `acquireDaemonSupervisorOwnership` does `listOwnerDirectories(registryDir)` (`readdirSync`,
`:757-761`) and then reads + `JSON.parse`s **every** record (`:473-474`) before filtering, and
`persistDaemonStartupFenceFromOwner` scans the same table a second time (`:606-607`) — both synchronous, both
on the start path (`daemon-supervisor.ts:781` region). `readOwnerRecordForScope` (`:778-785`) returns the full
record without ever consulting its `isRelevant` argument, so the cheap scope filter only applies to
half-written directories. We measured 45 owner directories on this machine, 36 with dead pids, spanning two
weeks — most of them from test fixtures, which is also a note on our own discipline (`AGENTS.md` tells us to
sanitize `~/.prime/agent`, and this registry lives outside it).

**Our fix.** Startup reclaims dead owner registrations (and the snapshot-cache directories from (d)) instead of
waiting for a conflict (`59a924082`).

**Offer.** Patch + tests.

#### (d) The snapshot-cache startup cleanup can never delete anything

**Symptom.** A supervisor that is SIGKILLed, OOMs or loses power leaves its transcript-spill directory behind
permanently; every restart adds another.

**On `main`.** `packages/coding-agent/src/modes/daemon/daemon-supervisor.ts:722` `generation = randomUUID()`,
`:767` `snapshotCacheRoot = join(this.descriptorDir, "snapshot-cache", this.generation)`, and the startup line
`:796` `rmSync(this.snapshotCacheRoot, { recursive: true, force: true })` — the path ends in this process's own
fresh UUID, so the removal is a no-op by construction (`force: true` makes it silent), and no code sweeps the
sibling generations: all nine references to `snapshotCacheRoot` are the definition, the startup rm+mkdir,
three pass-downs as `cacheRoot`, and the two shutdown removals (`:6894`, `:6977`). The directories are not
necessarily empty: once a transcript's chunks exceed `SNAPSHOT_MEMORY_CACHE_BYTES = 4MB` the spill writes
every chunk to disk (`snapshot-transcript-cache.ts:256-283`). We found 3 of 4 descriptor keys on this machine
carrying a previous generation's directory. Related, same file: the chunk spill and read are synchronous
`writeFileSync`/`readFileSync` (`:268`, `:275`, `:128`) on the snapshot streaming path.

**Our fix.** Startup reclaims the sibling generations under the cache parent (`59a924082`).

**Offer.** Patch + tests.

### 2.6 "Durable authority state" is written without an fsync, and a torn fence stops that socket's daemon permanently

**Symptom.** After a machine-level crash (power loss, kernel panic) the daemon for one socket path fails every
startup with `Invalid daemon startup fence: <path>`, and cannot repair itself: the only clearing path needs a
parseable fence. A torn worker descriptor is quieter — the worker is simply invisible forever, re-logged on
every boot.

**On `main`.** `daemon-supervisor-ownership.ts:946-948`:
`writeJsonAtomically` → `writeFileAtomicSync(path, …, { mode: 0o600 })` with neither `fsync` nor `fsyncDir`,
although the helper supports both (`packages/coding-agent/src/utils/atomic-file.ts:41-48`, implemented at
`:65` and `:76-80`) and the tree uses them where durability matters (`cron-jobs.ts:1554`,
`command-recovery-journal.ts:201-205`). The comment at `:306-307` calls this registry "durable authority
state". A rename without an fsync gives namespace atomicity, not data durability, so a 0-byte or half-line
`owner.json` / startup fence / shutdown admission is possible. Consequences:

- `readStartupFence` rethrows everything but ENOENT (`:875-902`), `waitForDaemonStartupFence` does not catch
  (`:667`), and the supervisor awaits it during `start()` (`daemon-supervisor.ts:781`) → that socket's daemon
  never starts. The only clearing branch (`:674-690`) requires a *parseable* fence whose identity is dead,
  and the only rewriting caller runs after a successful start — so fixing it requires starting, and starting
  requires it fixed. The message does carry the path, so a human can recover.
- `persistSupervisorConfig` (`daemon-supervisor.ts:1399-1405`) and `persistWorker` (`:1414-1417`) are the same
  shape, and `loadWorkerDescriptors` logs `Ignoring invalid worker descriptor <path>` (`:1346-1348`) without
  renaming or quarantining: the file is re-read and re-logged on every boot, and the worker it names is
  permanently absent from the registry.

**Our fix.** fsync the temp and the directory before/after the rename for this family, plus quarantine: an
unreadable descriptor or fence is renamed aside and reported instead of being re-parsed on every start, and a
corrupt fence no longer keeps that socket's daemon from starting (`59a924082`).

**Offer.** Patch + tests. The fsync cost lands on rare writes, so we think it is free; the quarantine naming is
a judgement call we would happily take from you.

### 2.7 Supervisor single thread, and waits with no bound

#### (a) A worker that survives SIGKILL buys the supervisor a permanent 2Hz synchronous `ps`

**On `main`.** `daemon-supervisor.ts:6531-6593`: `finalizeTimedOutWorkerStop` loops `while
(!this.shuttingDown)` with `unrefDelay(STOP_FINALIZATION_RECHECK_MS)` = 250ms (`:208`, `:6592`) and calls the
**synchronous** `getProcessStartId(pid)` at `:6567` and `:6586`, throttled to every
`LIVENESS_IDENTITY_RECHECK_MS` = 500ms (`:216`). There is no attempt cap, no wall-clock cap and no degraded
counter. The worse case: when the identity is unobservable — `ps` wedged or sandboxed, or no
`processStartId` was ever captured — `stoppedVerdict` stays true and `stoppedCanSignal` stays false
(`:6560-6569`), so the SIGKILL escalation at `:6582` never fires and the loop is pure spin (with a blocking
fork every 500ms) until the process disappears by itself. Reachable from three normal places, all of which
call `scheduleWorkerStopFinalization` (`:6482`), and a process in uninterruptible sleep satisfies the entry
condition by definition.

**Our fix.** A 10-minute terminal for the background wait, with a log line and a degraded mark, instead of
polling forever (`59a924082`).

**Offer.** Patch + tests; the bound value is yours to pick.

#### (b) The supervisor's client command reader has no line bound

**On `main`.** `daemon-supervisor.ts:1473` attaches the client reader with no options:
`attachJsonlLineReader(socket, (line) => void this.handleLine(client, line))`. `attachJsonlLineReader` only
enforces a limit when the caller supplies one (`packages/coding-agent/src/modes/rpc/jsonl.ts:51-66`: without
`maxLineLength` every chunk is pushed onto `pending`, with no cap and no `socket.pause()`), and the same file
shows the intended usage 2,300 lines later — the worker-stderr reader passes `maxLineLength: 64 * 1024` plus an
`onLineOverflow` logger (`daemon-supervisor.ts:3135-3138`). The two other unbounded readers are
`daemon-mode.ts:3544` (the worker's jsonl client reader) and `daemon-client.ts:215`. Bytes are buffered before
any `JSON.parse`, so nothing has to be accepted for the heap to grow, and the tree's own threat model treats
the socket peer as untrusted — which matters because the agent runs untrusted code as the same user, so an
injected `bash` can open the socket itself. Related, same shape: the supervisor's `normalizeCapabilities`
(`:676-685`) puts whatever the client sent into a `Set` without filtering against the supported list, while
the worker side does filter (`daemon-mode.ts:7789-7795`), so an attach can also park arbitrary strings in
supervisor memory per session.

**Our fix.** A 64MB per-line bound with an overflow log on the daemon's jsonl command readers, and unknown
client capabilities filtered (`59a924082`).

**Offer.** Patch + tests.

#### (c) `writeSnapshotBuffer` on the supervisor has no timeout, and the failure path awaits it

**On `main`.** `daemon-supervisor.ts:5470-5495` settles only on `drain`, `close` or `error`. The worker-side
twin takes a `drainTimeoutMs` and passes `WORKER_SNAPSHOT_TERMINAL_DRAIN_TIMEOUT_MS = 1_000` for terminal
frames (`daemon-mode.ts:267`, `:5609-5648`), so the asymmetry looks unintentional. AF_UNIX has no keepalive: a
client that is SIGSTOPed (Ctrl-Z and forgotten, a debugger, a low-memory freeze) neither drains nor closes.
The consequence is not just a stalled transfer — `streamSnapshot`'s catch awaits
`writeSnapshotRecord(client, { type: "session_snapshot_failed", … })` (`:5412-5417`) **before** the `finally`
that releases the transcript and the snapshot reservation (`:5426-5429`), so a wedged client pins the
transcript cache's readers (including its >4MB on-disk chunks) and leaves `client.snapshotStreaming` true,
which is the gate for that client's catch-up queue (`:5458`). Its view freezes with nothing in the log. A
`SIGCONT` does recover it; a client that never resumes does not.

**Our fix.** A drain timeout on the supervisor side too, so the terminal frame is bounded and the `finally`
always runs (`59a924082`).

**Offer.** Patch + tests.

#### (d) One malformed roster frame tears down the supervisor↔worker connection instead of costing a log line

**On `main`.** `daemon-supervisor.ts:4368-4388`: when `delta.snapshot !== true && worker.rosterApplyChain ===
undefined` the delta is applied **directly** (`:4379-4381`) with no try/catch, while the chained branch catches,
logs and schedules a repair pull (`:4390-4409`). `applyWorkerRosterDelta` (`:4432-4440`) does no per-entry
validation beyond `Array.isArray(delta.entries)` (`:4375`). A synchronous throw therefore travels:
`DaemonWorkerClient`'s listener loop has no try/catch (`daemon-worker-client.ts:274-276`) → the private-framed
channel's catch destroys the stream → the worker goes through recovery and every session on that tree is
briefly unreachable. The same frame on the chained path costs one log line and a repair pull. We are honest
about the trigger: within one version the producer always sets `summary`, so this needs a shape-drifted
producer — a mixed-version window. The asymmetry itself is static, and the tree's other frame dispatchers do
guard (`daemon-client.ts:522`, "A consumer failure must not interrupt protocol parsing for other clients").

**Our fix.** One malformed roster frame now costs a log line and a repair pull (`59a924082`).

**Offer.** Patch + tests.

### 2.8 Negative results that are silently drawn from a failed scan

#### (a) `listSupervisorAgentPeers` turns every failure into "there are no other agents"

**On `main`.** `daemon-mode.ts:5715-5734`: `catch { return []; }` around a 1s connect, a hello wait and a 5s
`list_agent_peers` request — and a `workerToken` mismatch is one of the failures, which is a *state* condition
rather than a blip. No log, no counter, no degraded mark. The three consumers are `agent_message.list_agents`
(`:5740`), the family catalog behind `agent_observe`'s roster, and the session-name uniqueness gate consulted
before a rename or a spawn (`:5785`). So a transient failure produces "this sibling does not exist" and "this
name is free", and the visible symptom arrives later as an unexplained `AmbiguousActiveSessionError`. A failed
scan is not an empty scan; this is the same discipline your own negative-result paths follow elsewhere.

**Our fix.** The catch still returns `[]` (degrading is right) but now logs a throttled line that names the
socket and states the consequence — reachability, name uniqueness and the family roster cover this process
only (`59a924082`).

**Offer.** Patch.

#### (b) The catalog's session selector matches on `startsWith` with no empty-selector gate

**On `main`.** `daemon-catalog-process.ts:83-90`:
`sessions.filter((session) => session.id.startsWith(selector) || session.name === selector)`, ambiguous only
when `matches.length > 1`. `"".startsWith` is true for every id, so a `send_message` with an empty target is
silently retargeted to the only session in that cwd, and reports "Ambiguous session selector" when there are
two — the behaviour flips on unrelated state. The worker side of the same command validates
(`daemon-mode.ts:6142` → `agent-messages.ts:335-344`, which rejects empty and `*`/`all`/`broadcast`), and
`session-id.ts:12-16` explicitly treats an empty suffix as no match, so the supervisor side is the outlier.

**Our fix.** Refuse an empty or broadcast target on the supervisor side too, reusing the existing worker-side
assertion (`59a924082`).

**Offer.** Patch + tests.

#### (c) The session summarizer's failures are invisible, its retry never ends, and its fallback asserts a business fact

**On `main`.** `daemon-session-summarizer.ts:198-200`: `catch { return undefined; }` — a summary-model failure
produces no log and no counter, and is indistinguishable from "no summary model configured". `owesSummary`
(`:323`) keeps the session in the retry set forever; the per-content gate (`:330-338`) limits it to 3 attempts
per content key and then to one attempt per `IDLE_GENERATION_RETRY_BACKOFF_MS` = 30 minutes (`:14-15`) — so the
rate is bounded, but there is no terminal give-up and nothing observable. The sweep fires every eligible
session in one tick with no concurrency cap and no jitter (`:240-245`). And the fallback writes
`{ summary: previous?.summary ?? "", taskState: "needs_input" }` (`:366-370`), which is persisted into the
transcript for an idle session: "the summary service failed" becomes "this session is waiting for the user",
and survives restarts.

**Our fix.** Bounded concurrency on the sweep, per-session exponential backoff (60s → 30min) with a give-up
after six attempts until the next turn, a log line, and no fabricated `needs_input` verdict (`59a924082`).

**Offer.** Patch + tests.

### 2.9 A kernel host callback can take a whole worker down

**Symptom.** A throw inside a UI/tool callback during kernel output kills every session on that daemon worker.

**On `main`.** `packages/coding-agent/src/core/kernel/repl-manager.ts:377-392`: the stdout frame loop guards
`JSON.parse` (`:377-382`), the record check (`:383-386`) and the protocol-shape check (`:387-391`), then calls
`this.handleEvent(event)` at `:392` outside any try/catch. `handleEvent` (`:745`) invokes host-supplied
callbacks, including `execution.opts.onStream?.(text, type)` on every stdout/stderr frame (`:820`). A throw
there becomes an exception inside a `'data'` handler; in a daemon worker that is fatal for the whole process,
because `daemon-mode.ts:641-645` installs `process.on("uncaughtException", … process.exit(1))`. Kernel code
should not depend on a callback's no-throw guarantee — the three checks immediately above it show the intended
posture for a bad frame.

**Our fix.** Contain the callback: log, drop the frame, keep the kernel — symmetric with the `JSON.parse`
catch (`645c23ca3`).

**Offer.** Patch + tests.

### 2.10 The RLM ledger is replayed from scratch for every question, and reconciled serially

**Symptom.** Agents-view and session-entry latency grows with the number of subagents this sessions directory
has ever had, and the cost is paid several times per request on the daemon's event loop.

**On `main`.** `rlm-ledger.ts:723-758`: `replaySync()` re-reads and re-parses the whole ledger (a synchronous
`readAllSync` plus a `JSON.parse` per record, `event-log.ts:71-107`) on every call, and the callers are
`edges()` (`:378`), `family()` (`:397`), `liveEdges()` (`:492`), the duplicate check inside
`appendSpawnUnlocked` (`:469`) and `appendRenameByChildPath` (`:345`) — one daemon `list` asks several of
them. `liveEdgesUnlocked` (`:491-…`) then walks the edges serially, `await`ing two existence probes per edge,
and calls `canonicalSessionPath` (`session-lease.ts:73-83`, a blocking `realpathSync` with a second
`realpathSync` in its fallback) up to three times for the same path. We measured ~450 live edges at ~90ms of
pure event-loop round trips per reconciliation, and a 1MB / 3,199-line ledger at ~65ms per replay; a libuv
threadpool of 4 puts a ~15ms floor under the 536 stats.

**Our fix.** Memoized canonicalization plus bounded-concurrency probes (children before parents, so a dead
child still spares its parent's stat) (`c027feeb6`), and a size+mtime-guarded replay cache invalidated on our
own appends (`bf6989289`).

**Offer.** Patch + tests. The replay cache is the part worth a second look: the ledger has other writers, so
the guard is the file's own size and mtime, and a same-mtime append by another writer is the theoretical miss.

### 2.11 Session replacement, import and deferred bash

#### (a) Importing a file whose basename matches a registered session overwrites it

**On `main`.** `agent-session-runtime.ts:636-666`: `destinationPath = join(sessionDir,
basename(resolvedPath))` (`:647`), then `copyFileSync(resolvedPath, destinationPath)` (`:658`) with no
existence check. `copyFileSync` replaces, so the previous transcript is gone, and `SessionManager.open`
(`:661`) then trusts the id in the filename. Reachable without malice: copy a registered session file
somewhere, edit it, import it back.

**Our fix.** `core/session-import-destination.ts` — resolve a non-colliding destination (and say so) instead of
overwriting (`2bd545d3a`).

#### (b) Session replacement tears down before it builds

**On `main`.** `agent-session-runtime.ts:266-272` (`teardownForReplacement` → `teardownCurrent` →
`session.disposeAsync()`) runs before `buildAndApplyReplacement(… () => this.createRuntime(…))` at every call
site (`:431`, `:474`, `:545`, `:574`, `:607`, `:667`). If the build throws — an extension that throws during
load, the ACP tool-name validation — the old session is already disposed and `this._session` still points at
it, so every later prompt fails with "session is disposing or disposed" until `/new`. The transcript on disk is
intact, so the user can recover by resuming, but nothing tells them that. The ordering is unchanged since our merge base
(`d74a75fea`), so it is not a recent regression.

**Our fix.** Roll back to a working runtime when the replacement build fails (`2bd545d3a`).

#### (c) A `!command` run during a stream never reaches the transcript if no further turn happens

**On `main`.** `agent-session.ts:11935-11950`: while streaming, the `bashExecution` message is pushed into
`_pendingBashMessages` (`:1309`); the only flush sites are inside `_prepareForCommit` (`:4725`, `:4728`).
`disposeAsync` (`:4132`) does not flush. So a user who runs `!foo` mid-stream and then exits — or whose worker
is passivated by idle eviction — loses that entry: they saw the output, `--resume` does not.

**Our fix.** Flush deferred bash results on the dispose/abort path too (`2bd545d3a`).

#### (d) `getContextUsage` and the compaction trigger use two different calibers

**On `main`.** `agent-session.ts:12398-12419`: after a compaction, the scan breaks at the first assistant whose
`stopReason` is neither aborted nor error and requires `calculateContextTokens(...) > 0`; if that one reports
zero usage the method returns `{ tokens: null }` even when an older post-compaction assistant has a usable
number. Meanwhile `estimateContextTokens` (`compaction.ts:187-215`, via `getAssistantUsage` at `:144-152`,
which skips aborted/error and takes the last usage that exists) — used by the compaction trigger and by this
same method's fall-through at `:12421` — does have a source. `/usage`, `/context` and `compact.status`
therefore report "unknown" while the machinery that decides whether to compact has a number.

**Our fix.** Both calibers share one `isAssistantUsageSource` predicate, and the post-compaction scan keeps
looking past aborted, errored and zero-usage assistants (`2bd545d3a`).

### 2.12 Two checkouts of your own repo fight over one kernel venv, in place, under a machine-wide lock

**Symptom.** A machine with two worktrees of the same repo (your `AGENTS.md` parallel-agent workflow produces
exactly this) reinstalls the Python skills on every alternating boot, and the shared venv's editable installs
end up pointing at whichever tree installed last. When that tree is deleted, kernels started from the venv
fail the skill import and the model is told "Python skill agent_message is unavailable in this kernel".

**On `main`.** There is one venv, `~/.prime/agent/kernel-venv`
(`packages/coding-agent/src/core/kernel/bootstrap.ts:373`, `:380`). Readiness requires the recorded skill list
to match the requested one **including each skill's absolute `packagePath`** (`pythonSkillsMatch`,
`:637-649`), the record is rewritten with only the caller's own list (`:854` → `writeBootstrapVersion`
`:672-685`), and skills are installed with `--editable <absolute path>` (`:357`, `:779-830`). Two trees with
identical content therefore never agree, and each boot flips the same directory in place — while kernels from
the other tree are running, and while holding the machine-wide bootstrap lock, so other sessions' boots queue
behind it. We have the on-disk result: a venv whose `_editable_impl_agent_message.pth` and
`agent_message-0.1.0.dist-info/direct_url.json` point at a worktree that no longer exists.

This is a third shape next to #2239 items 2.1(a) (different skill *sets* ping-pong) and 2.1(c) (a rebuild
deletes the venv under running kernels): here there is no rebuild and no delete — the *content* is rewritten
under running kernels by a sibling checkout.

**Our fix.** Per-build-identity venv generations (`kernel-venv-<hash12>`) with an `.in-use` reference count, so
a referenced generation is never renamed, rebuilt in place or deleted (`ca92e1b34`, `c21d47a76`), plus a
skill-path-aware readiness rule so two trees with the same skill names but different paths stop flipping each
other (`e673e8242`, `dd62e6832`). As noted in #2239 item 2.1(c), this changes the on-disk layout and probably
wants your design review rather than our patch.

### 2.13 Resource discovery follows directory symlinks with no cycle or depth bound, and swallows what it cannot read

**On `main`.** Four walkers resolve a symlinked entry with `statSync` and recurse into it with no visited set,
no depth limit and no realpath:

- `package-manager.ts:287-335` `collectFiles` (recursion at `:326`),
- `package-manager.ts:340-405` `collectSkillEntries` (recursion at `:405`),
- `package-manager.ts:567-615` `collectAutoExtensionEntries` (recursion at `:604`),
- `skills.ts:280-364` `loadSkillsFromDirInternal` (recursion at `:360`).

A symlink to a large tree (`skills/home -> ~`) makes every session start and every resource reload walk it; a
self- or ancestor-referential link stops only because the kernel returns ELOOP after 32/40 hops, which is an
accident of the platform rather than a property of the walker. And because each loop body is wrapped in a bare
`catch {}` (`package-manager.ts:331-333`, `:610-612`), one unreadable or looping entry silently discards the
rest of that directory's discovery with no diagnostic — the resource list is just shorter. Symlinked resource
directories are a legitimate layout, so the fix is bounds and visibility, not refusal.
(`extensions/loader.ts:517-547` is fine: documented and bounded to one level.)

**Our fix.** `utils/discovery-walk.ts` — a realpath cycle set, `MAX_DISCOVERY_DEPTH = 32`, and a diagnostic
naming the skipped subtree and the reason (`cycle` / `depth`) instead of a silent swallow (`542b03e5e`).

**Offer.** Patch + tests.

### 2.14 A failed `!command` credential resolver is cached as a failure for the life of the process

**On `main`.** `resolve-config-value.ts:9` (`commandResultCache`), `:84-91`: `executeCommand` stores the result
unconditionally, including `undefined`, with no TTL and no invalidation anywhere in the file. So if
`!cat /tmp/token` or `!aws …` fails once — the file is not there yet, the network blips, the spawn times out
at 10s — that key resolves to `undefined` forever and the only remedy is a restart. The inconsistency is
visible in the same file: `resolveConfigValueOrThrow` (`:104-114`) deliberately goes uncached every time and
reports "Failed to resolve … from shell command" as a retryable condition.

**Our fix.** Successes still cache for the process lifetime; only a failure gets an expiry, after which the
command is run again (`542b03e5e`).

**Offer.** Patch + tests.

### 2.15 TUI cleanup: unhandled rejections on the interrupt path, and status overlays that outlive their session

#### (a) `interruptOrClearInput` fires four aborts without a catch

**On `main`.** `interactive-mode.ts:6802-6816`: `void this.agentConnection.abortRetry()`,
`abortCompaction()`, `abortBranchSummary()` and `abortBash()` are un-caught, while `abort()` four lines below
(`:6820-6822`) and the other two `abortBash()` sites (`:4646`, `:5488`) do catch. These go through
`requestOk()` on the daemon connection, so a daemon error while the user is pressing Esc/Ctrl+C becomes an
unhandled rejection — a warning or a crash depending on the Node setting, and in a daemon worker
`unhandledRejection` is `process.exit(1)` (`daemon-mode.ts:646-651`).

**Our fix.** `.catch(() => undefined)` on each, matching the existing pattern (`542b03e5e`).

#### (b) The retry countdown, retry loader and compaction loader are not disposed on stop or on session replacement

**On `main`.** `stop()` (`interactive-mode.ts:10141-10169`) cleans up the working loader, refine loader,
feature hint, pulse, goal tray, heartbeat manager, footer and roster bar — but not `retryCountdown`,
`retryLoader` or `autoCompactionLoader`; those are only cleaned when an `agent_start` (`:5445-5452`) or
`compaction_end` (`:5745-5749`) event happens to arrive. `resetCurrentSessionRenderState` (`:2909-2958`)
explicitly handles the discarded bash component's interval ("The discarded component's loader interval keeps
firing otherwise") and the refine loader, but not these three. So switching sessions during a retry countdown
carries the stale countdown into the next session's view, and the teardown path leaves the intervals running —
which matters because `packages/tui/src/components/loader.ts:69` does not `unref()` its `setInterval` (other
timers in the tree do), so a leaked Loader can hold the process open after the UI is gone.

**Our fix.** One `disposeTransientStatusOverlays()` called from both `stop()` and the session-reset path, and
`loader.ts` unrefs its interval (`542b03e5e`).

### 2.16 The 4603 regression test hard-links the running interpreter and can stop itself

**Symptom.** The suite can freeze its own runner. We reproduced it: the vitest worker went to state `T` for 74
seconds and the cleanup then failed with `Timed out waiting for fixture process 22442/ps:… to stop`.

**On `main`.** `packages/coding-agent/test/suite/regressions/4603-worker-recovery.test.ts`:

- `:129` `linkSync(process.execPath, executablePath)` — the fixture's "prime-agent" executable is a second
  directory entry for the **inode of the interpreter running the suite**. Nothing else in the tree links an
  executable; every other fixture spawns `process.execPath` directly.
- `registerFixtureProcess` (`:231-249`) has no `pid === process.pid` guard, and
  `registerFixtureOwnedProcesses` (`:251-278`) registers whatever pid it finds in the fixture registry's
  `*.owner/owner.json` (`:262-268`) and worker descriptors (`:270-277`). The ownership-handover cases acquire
  ownership **in-process** against a fixture registry dir (`:872-879`, `:965-972`) — `:992-993` asserts the
  record's pid is the runner's — and they release later in the test body, not in a `finally`. Any throw in
  between leaves a record naming the runner, and the global `afterEach` (`:110`) →
  `stopFixtureOwnedProcesses()` (`:468-495`) → `terminateFixtureProcessTree` → `signalFixtureProcess(root,
  "SIGSTOP")` (`:365`) then stops the runner itself. `terminateFixtureProcessTree` has no self guard either, so
  a direct call is unsafe too.

**Our fix.** A 0700 `#!/bin/sh exec "<node>" "$@"` wrapper instead of the hard link (the `exec` keeps pid/fd
inheritance, so the supervisor IPC on fd 3 is unaffected), self-pid guards at both the registration and the
termination layer, and try/finally around the in-process ownership acquisitions; plus two guard cases that
assert the fixture executable is a different inode from `process.execPath` and that a self-referential record
is refused (`04486de72`).

**Offer.** Patch. Test-only, no product surface. We verified both layers independently by removing them
(mutants: removing the termination guard froze the runner for 74s; removing the registration guard turned the
assertion red and made the terminator refuse every round).

---

## 3. Found on `main`, and not fixed in our tree either

Offered as observations, with no patch behind them — same spirit as section 4 of #2239.

1. **The retry continuation timer is not cancellable.** `agent-session.ts:11677-11697`: after the retry sleep
   the controller is cleared (`:11675`) and the continuation is `setTimeout(() => { this.agent.continue()… },
   0)` with no stored handle and no guard in the callback. `abortRetry()` (`:11700-11718`) can therefore only
   reset counters: an Esc — or a `disposeAsync` — landing in that one-macrotask window is followed by a
   self-revived run, and on a disposed session that is a turn nobody is watching (the stream closure still
   works, so it spends tokens). Our tree has the identical shape; we graded it P3 because the window is one
   macrotask and we could not produce it outside a deliberately instrumented build. A `disposed || attempt ===
   0` check inside the callback closes it.
2. **Agents-view ellipsis flags are computed from `start` while the slice uses `sliceStart`.**
   `agents-view-mode.ts:2522-2526`: `sliceStart` shifts the window down when the selection sits at or below the
   viewport bottom, but `showLeadingEllipsis`/`showTrailingEllipsis` still describe `start`. Cosmetic, and only
   reachable at the boundary (with a 2-row viewport, `start === 0` and `sliceStart === 1` drops a row with no
   leading indicator). Identical in our tree.
3. **A torn `writeFileAtomicSync` temp is never collected.** `utils/atomic-file.ts:53` names the temp
   `<path>.<pid>.<uuid>.tmp` and the `finally` at `:74` removes it — but a crash between the write and the
   rename leaves it, and nothing in the tree sweeps `*.tmp` siblings. Small (one file per crash), listed
   because the same shape bit us in our own cache.
4. **Every attach re-reads and re-parses the whole transcript.** `session-manager.ts:729-741`
   `loadEntriesFromFileAsync` has a streaming threshold (good — it does not block the loop) but no reuse, so a
   hydrate of a large session pays the full parse each time. We measured 81MB / 85k entries at ~248ms; after
   removing everything else from our cold path this is the dominant remaining constant in "Enter → chat". We
   have not changed it, because the honest fix is to transfer less on attach (a `slim_attach`-style capability
   gate) rather than to cache a mutable transcript.

---

## 4. Not settled

Listed because a downstream "we are not sure" is still cheaper than re-deriving the question.

1. **Whether an interior ledger line actually occurs in the wild.** Section 2.4(b)'s exit-less fail-closed is
   static, and `event-log.ts:161-164` gives up repairing exactly when a rival writer is active — but we have
   never observed a torn interior line on disk, so we cannot say how often the poison state is reached.
2. **Whether a same-version producer can emit a roster entry without `summary`.** Section 2.7(d)'s asymmetry is
   static; the trigger we can name is a mixed-version window, which we did not reproduce.
3. **Whether `writeLine` can fail to settle when stdin is destroyed mid-write.**
   `kernel/repl-manager.ts:732-743` resolves from the `stream.write` callback. Node normally calls that
   callback with `ERR_STREAM_DESTROYED`, which would settle it; we did not find a shape where it does not, and
   we are not willing to claim one. If it exists, the in-flight host-request map keeps a zombie entry.
4. **Why the daemon takes ~4.9s to come up after `kill -9`.** We characterized it in our logs as the
   ownership-guard lock recovery loop and did not chase it further, so we cannot say whether the same pause
   exists on `main` or whether it is our extra registry work.

---

## Appendix A — Checked, and does not apply to your tree

Recorded so nobody (including us) re-reports these. Each was re-read on `main` at `fb2db8ee1`.

1. **The stall-watchdog exemption budget.** Our audit's top item (an exemption budget that accrues wall-clock
   "vouched" time rather than silent time, so a healthy 50-minute build is killed and cannot be un-killed) is
   entirely downstream: there is no `stall-watchdog.ts` and no `turn-liveness.ts` on `main`. Same conclusion as
   #2239 Appendix A.2.
2. **The durable session-summary cache cluster** (a bad transcript timestamp turning one read failure into an
   empty session list; a write-failure circuit breaker that cannot tell a transient `EMFILE` from a permanent
   `EROFS`; a prune that deletes entries it merely failed to read; a fingerprint of `(dev, ino, size, mtimeMs)`
   that a coarse-mtime filesystem can fool). `core/session-info-disk-cache.ts` does not exist on `main` — it is
   our performance work, and the defects were introduced by it.
3. **The pending-delivery queue cluster**: a capacity rejection classified as "delivery uncertain" (which
   spends the message id and contradicts its own "retry after 5s" text), a requeue loop that keeps bouncing a
   worker object which was deleted from the registry, and an eviction fence that no longer waits for an
   in-flight delivery. `modes/daemon/pending-delivery-queue.ts` is ours, and on `main` `send_message` still
   holds the mutation-drain latch (`daemon-supervisor.ts:1871` has no exemption list), so your eviction fence
   does wait — the defect we found was created by our own exemption.
4. **`kill` on a failed worker's child session stopping the whole tree and returning `alreadyTerminal: true`.**
   `killUnreachableWorker` / `isWorkerTerminallyUnavailable` are ours; #2239 item 2.8 already states what
   `main` does here.
5. **Catch-up requeue-before-give-up.** Main's `drainClientCatchups` clears the pending set up front
   (`daemon-supervisor.ts:6020-6025`) and has no retry budget to exhaust; the budget, the generation guard and
   the give-up notification are ours.
6. **The kernel revival budget being lost when the manager instance is replaced**, and
   **`kernelRestart.windowMinutes: 0` normalizing to `Infinity`** (which makes the budget never re-arm and puts
   the literal string `Infinity` into a user-visible message). Main has no restart budget, no
   `restart-ledger.ts`, no `KernelUnavailableError` and no `kernelRestart` setting — nothing to lose and
   nothing to misconfigure.
7. **`ready` and the first `heartbeat` arriving in one stdout chunk, killing a healthy kernel as "protocol
   corruption"**, and **the finishing-phase heartbeat carrying `id: null` so the watchdog does not vouch for
   it.** Main's kernel protocol has no heartbeat frames at all (neither `repl-manager.ts` nor
   `prime-agent-runtime/src/rlm/repl.py` mentions one), and `invalidProtocolFrameReason(event)` (`:125`) takes
   no negotiated-protocol argument, so the race we found cannot arise.
8. **`.in-use` reference pruning, the prune-outside-the-lock TOCTOU, and a late `host_reply` written into a
   revived kernel.** `kernel/venv-in-use.ts`, the generation prune and the revival path are all ours. (The
   *synchronous `ps`* half of that finding is shared and is reported at 2.5(a).)
9. **Two render-cache invalidation gaps** — a subagent summary line cached without the keybinding state, and a
   bash-output throttle timer with no `destroy()`. Main has neither cache: no `cacheKey` in
   `subagent-summary-line.ts`, no `updateTimer` in `bash-execution.ts`.
10. **The `/share` secret preflight scanning the wrong bytes.** Our first version of the preflight scanned the
    exported HTML — which carries the session base64-encoded (`export-html/index.ts:155`), so no plaintext
    pattern can ever match and the warning dialog is unreachable. `core/share-session.ts` does not exist on
    `main`: there is no preflight at all. We report the bug as ours and note the gap as yours; the preflight
    (patterns, decoded-payload scanning, an upload bound) is available if you want it, and we fixed our own
    version in `542b03e5e`.
11. **Changelog and commit-hygiene items** from our audit round — one change described by two fragments (which
    `scripts/lib/changelog-fragments.mjs` then folds twice, since `buildReleaseSection` concatenates without
    dedup), TUI fixes recorded only under `packages/coding-agent/.changes/` although they touched
    `packages/tui`, and a provider-history behaviour fix shipped under a `docs(fork)` label. The first two are
    our own bookkeeping; the third is our commit, not yours. The missing dedup in `buildReleaseSection` is
    shared code, but it only bites a repository that writes duplicate fragments, so we are not asking for it.
12. **Daemon items that are ours by construction**: the supervisor's private `getProcessStartIdAsync` copy
    missing the 5s query timeout that the canonical helper has (main has no async helper at all — see 2.5(a));
    the delivery "uncertain" receipt counted from a `dispatches` counter incremented before the bytes reach the
    socket (main has no such counter); the worker's supervisor-availability monitor stopping when a probe
    succeeds before authentication (`supervisor-availability.ts` is ours); the `daemon-timeouts.ts` tier
    comment that disagrees with the CLI leg; the `orphan-process-journal.ts` comment that misstates
    `proper-lockfile`'s contract (main's version does not use a lockfile).
13. **The `DaemonRoutedClient` class comment** claiming a direct-path loss "degrades silently" while
    `bindDirect`'s close handler broadcasts a close event. We now believe the *behaviour* is right (the
    supervisor's event fan-out is gated on `attachedActiveSessionIds`, so the upper layer must re-attach) and
    only the comment is wrong; we fixed our comment and are not asking you to change code.

---

## Appendix B — How we verified, and the numbers

**Method.** Our audit round covered, file by file: `modes/daemon/` (35 files, 26,802 lines, 34 read in full),
`core/agent-session.ts` (14,693 lines, in full) plus its three satellites, `core/kernel/` and
`core/tools/ipython.ts` (in full), `packages/ai/src` (14,083 lines excluding the generated model table),
`modes/interactive/` + `packages/tui/` (40,782 lines), the rest of `core/` (~30,000 lines, one sixth read in
full), plus four dedicated sweeps (invariants and bounds, tests and consistency, TUI, daemon). Each finding
carries a mechanism, a reachability argument, a counter-example condition and a non-regressive fix; the ones
that could be reproduced live were reproduced with probes outside the repository.

**For this document specifically**, every item in section 2 was re-checked by reading the file at
`upstream/main` (`fb2db8ee1`) rather than by trusting our own line numbers: the line numbers above are yours.
Where a mechanism depends on runtime behaviour we could not read out of the source, we measured it — Node's
`'error'`-without-`'close'` spawn semantics (2.2(a)), the 0644 mode under umask 022 (2.3), and the
`real ≈ 1.65 × estimated + 63k` token fit on 599 usage points from the failing session (2.1(a)).

**Divergence.** Merge base `d74a75fea` (2026-09-04); you are 41 commits ahead of it at 0.9.4, we are 402
commits ahead of you on our line and still on 0.9.1. Catching up is our task, not yours, and it does not
change any of the above: all 32 items were read on your head, not on the merge base.

**Commits referenced above** (all in `Dmatut7/prime-agent-rlm`, branch `merge/repl-kernel`, none pushed to any
of your branches): `0092dd04a`, `2bd545d3a`, `542b03e5e`, `59a924082`, `791ce355f`, `5f26fb9e6`, `35d7723f5`,
`781d91985`, `c027feeb6`, `bf6989289`, `645c23ca3`, `e673e8242`, `dd62e6832`, `ca92e1b34`, `c21d47a76`,
`04486de72`.

**Contact.** As before: reply in #2239 or open a Discussion and mention `@Dmatut7`. A short triage — "these we
want, these we do not, send patches here" — is worth more to us than silence, and we will not take a "no" as an
affront. If you would rather this kind of downstream comparison stayed private, say so and future rounds go to
an address instead of a public thread.
