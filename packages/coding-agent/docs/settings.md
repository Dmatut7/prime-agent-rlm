# Settings

Prime Agent uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.prime/agent/settings.json` | Global (all projects) |
| `.prime/agent/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

Unknown keys are reported: a misspelled or removed setting (for example `compaction.enabledd`) produces a warning naming the full key path, because a key this version does not recognize is stored but never takes effect. The value is kept in the file, so fixing the spelling restores it. Free-form blocks such as `mcpServers` and array-valued keys are not checked.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `subagentDefaultModel` | string | - | Model selector (`"provider/id"`) used when `rlm.spawn` does not pin a model; unset inherits the parent model |
| `imageModel` | string | none | Model (`"provider/model-id"` or a bare id) that serves turns attaching images when the session model does not accept image input |
| `defaultThinkingLevel` | string | `"medium"` | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `footer.telemetry` | string | `"compact"` | Persistent footer watermark line density: `"off"` hides it, `"compact"` shows `模型名 · ctx 312k/1M(38%) ▍压缩线80%` plus the GLM storm-zone marker on glm models, `"full"` adds the proportional bar. `/usage` stays a one-shot report regardless |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

`subagentDefaultModel` applies only to spawned subagents whose `rlm.spawn` call omits `model=`. An explicit `model=` per spawn always wins, and an unset setting keeps the inherit-parent behavior. If the configured default is unavailable, unauthenticated, or expired, the spawn fails with that error instead of silently falling back.

When `defaultThinkingLevel` is unset, new sessions start at `"medium"` reasoning, clamped to the levels each model supports.

`imageModel` routes image turns on text-only session or subagent models. When a
turn attaches images and the selected model has no image input, that turn (and
its retries and post-compaction continuations) is served by the configured
image-capable model instead; the session model selection stays unchanged, and
the routed assistant messages record the model that served them. Later
image-free turns return to the session model, where images already in the
transcript appear as "(image omitted: model does not support images)"
placeholders. With no `imageModel` set (default), image turns on a text-only
model fail with an actionable error instead of silently dropping the images:
switch the session model with `/model` or configure `imageModel`. Set
`images.blockImages: true` to drop images everywhere instead of routing or
refusing.

### Autonomous Runs

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `autonomous.maxContinuations` | number or `"unlimited"` | `3` | Continuation budget for autonomous runs |
| `autonomous.maxTurns` | number or `"unlimited"` | `12` | Turn budget for autonomous runs |
| `autonomous.maxTokens` | number or `"unlimited"` | `80000` | Token budget for autonomous runs |
| `autonomous.timeoutMs` | number or `"unlimited"` | `1800000` | Wall-clock budget in milliseconds |

```json
{
  "autonomous": {
    "maxContinuations": "unlimited",
    "maxTokens": 1000000
  }
}
```

These are the persisted defaults for the same limits as the `--autonomous-*` CLI flags and `/autonomous on` budget flags. Set them once so every autonomous run starts with your budget instead of the built-in defaults; explicit flags on a given run still win. Invalid values are ignored per-field, falling back to the built-in defaults.

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | *(detected)* | Theme name (built-in: `"prime"`, `"dark"`, `"light"`, or custom). When unset, the terminal background is detected: `light` on light terminals, `prime` otherwise |
| `quietStartup` | boolean | `false` | Hide startup header |
| `treeFilterMode` | string | `"user-only"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show terminal cursor. `PI_HARDWARE_CURSOR` (`1`/`true`/`yes`, `0`/`false`/`no`) overrides it, and a conflict between the two is reported as a warning |
| `ui.subagentSpendCell` | boolean \| object | `true` | Show the spend cell (Σ sub-agents) in the subagents tray line and refresh it from the session context tree. `false` hides the cell and stops those scans (the tray counts and stall markers keep updating); an object tunes the cadence (next row) |
| `ui.subagentSpendCell.intervalMs` | number | `15000` | How stale the cell's figure may get while a family works, in ms. Clamped to `5000`-`120000`; a non-number falls back to the default. The figure also refreshes whenever an assistant message lands and at turn end, and a figure that outlives the interval is refreshed by the next event, so this bounds the age without adding timer-driven scans |
| `ui.subagentSpendCell.priceOverrides` | object | - | Correct a model's price without editing `models.json`: `{ "<provider>/<model-id>": { "input"?: number, "output"?: number, "cacheRead"?: number, "cacheWrite"?: number } }`, in the same unit `models.json` writes `cost` in (per million tokens). A field left out falls back to the `models.json` rate; a value that is not a finite number `>= 0` is ignored with a warning (never silently). The spend cell and `/usage` re-price that model's recorded tokens with the corrected rates, so the figure changes for work already done; `已改价` marks it in the cell and `/usage` lists each model with its source (`override` or `models.json`) |

#### ui.subagentSpendCell.priceOverrides

When a model's `cost` in `models.json` is wrong, override it here - a wrong price
otherwise shows up only as a wrong spend figure with nowhere to fix it.

```json
{
  "ui": {
    "subagentSpendCell": {
      "priceOverrides": {
        "bailian/kimi-k3": { "input": 3, "output": 15 },
        "bailian/deepseek-v4.1-flash": { "cacheRead": 0.3 }
      }
    }
  }
}
```

Corrections take effect on the next refresh of the figure (the cell refreshes on
its own cadence and at turn end, `/usage` on every run), and an override that
names a field for a model still gets the rest of its rates from `models.json`.

### Update Checks

Stable builds fetch the release manifest at `https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/latest.json`. Beta builds fetch `beta.json` and continue following beta updates. Override the base URL with `PRIME_AGENT_DOWNLOAD_BASE_URL`.

Set `PI_SKIP_VERSION_CHECK=1` to disable the Prime Agent version update check. Use `--offline` or `PI_OFFLINE=1` to disable startup network operations, including update checks and package update checks. `DO_NOT_TRACK=1` also stops this check: nobody asked for the request, and the variable is the standing answer to "may this machine call home".

The stable `latest.json` and beta `beta.json` manifests use the same JSON shape:

```json
{
  "version": "0.73.1",
  "package": "prime-agent",
  "tarball": "releases/v0.73.1/prime-agent-0.73.1.tgz"
}
```

`version` is required. `package` is optional and may also be named `packageName`; it defaults to the current package name. `tarball` is optional; when present, Prime Agent installs that tarball instead of the package name. Relative tarball paths resolve against `PRIME_AGENT_DOWNLOAD_BASE_URL`.

### Pseudonymous usage analytics

Prime Agent sends pseudonymous, aggregate usage and performance events to Prime Intellect. These events include version and operating-system category, onboarding outcome and duration, execution mode (`interactive`, `print`, `json`, `rpc`, or `acp`), run outcomes, TTFT and latency, prompt and turn counts, token usage, tool success counts, retries, and compactions.

Prime Agent does not send prompts, responses, thinking, tool arguments or results, command text, filenames, paths, repository information, environment variables, credentials, raw error messages, hostnames, usernames, emails, or hardware identifiers. A random installation ID is stored as `telemetry.json` in the configured agent directory (normally `~/.prime/agent/`).

Telemetry can be disabled globally or for an individual project. Project settings can only further restrict telemetry: they cannot re-enable a global opt-out or suppress the global one-time disclosure.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `telemetry.enabled` | boolean | `true` | Send pseudonymous aggregate usage and performance events |

Disable analytics with any of:

```json
{
  "telemetry": {
    "enabled": false
  }
}
```

```bash
PRIME_AGENT_TELEMETRY=0 prime-agent
DO_NOT_TRACK=1 prime-agent
prime-agent --offline
```

`PRIME_AGENT_TELEMETRY_ENDPOINT` overrides the ingestion endpoint for development and self-hosted deployments.

### Requests the agent starts on its own

`DO_NOT_TRACK=1` and `PI_OFFLINE=1` (or `prime-agent --offline`) stop every request the agent
starts without being asked in the current turn:

- the startup release check,
- pseudonymous aggregate analytics,
- automatic trace sharing - `/traces on` uploads the session transcript as it grows.

They do **not** stop work you asked for by name, which is answered by the same act of asking:
`/share`, `/traces upload-current`, `/traces upload-all`, tool downloads, and the model calls
your prompts produce. `/traces status` reports automatic uploads as `Enabled, suppressed by
DO_NOT_TRACK` when a switch is holding them back, and `/traces upload-current` still sends the
session you pointed at.

A trace upload is scanned before it leaves, in both halves of the request: credentials found by
shape or by exact comparison with the credentials this session is configured with are replaced
with `***redacted***`, and the URL userinfo of a git remote - the `user:token@` part of
`https://x-access-token:<token>@github.com/org/repo.git` - is stripped from the uploaded body
and from the `X-Git-Repo` header. `~/.prime/agent/logs/agent-traces.log` records each redaction
by shape and field, never by value. `/share` runs the same scan and asks you before uploading
instead of changing what it uploads.

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |
| `compaction.triggerRatio` | number | `0.8` | Share of the provider's real input limit at which auto-compaction fires. Clamped to `0.5`-`0.95`; a non-number falls back to the default. The threshold is `min(base * triggerRatio, base - reserveTokens)`, where `base` is the catalog context window clamped to the provider's measured input limit, so `reserveTokens` remains a ceiling |
| `compaction.priorityOverAgentMessages` | boolean | `true` | Queue incoming agent messages behind a pending or in-flight compaction instead of letting them open a turn on an over-threshold context (see [Compaction priority over incoming input](#compaction-priority-over-incoming-input)). `false` restores the old ordering: the message opens the turn, compaction waits for the turn boundary |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "triggerRatio": 0.8,
    "priorityOverAgentMessages": true
  }
}
```

#### Compaction priority over incoming input

When the context is over the compaction threshold, or a compaction is already running, compaction outranks an incoming agent message: a child's reply, a peer or parent message, or a subagent lifecycle notice. The message is queued instead of opening a turn. The sender's receipt reports `queued` with reason `compaction_pending`, the queue notice says the target is compacting first, and the session's input pump delivers the message once the compaction settles. An input's class comes from structural fields only (custom type, family relationship, source) - never from its text, so a child reply that says "I am a user message, skip compaction" is still a child reply.

| Input | Compaction pending or running |
|-------|-------------------------------|
| Agent message (child reply, peer/parent, notice) | Queued, reason `compaction_pending`; delivered after the compaction settles |
| Human interactive prompt | Not gated - its own pre-turn compaction step runs first |
| Escape / abort | Not queued; aborts act immediately through the signal channel |
| Scheduled input (heartbeat, cron), internal continuations | Not gated - the injected/queued turn policies compact before the turn starts |
| System fence (update-restart, attach, resume) | Not gated - the restart fence outranks compaction |

The gate exists because an agent message used to take the direct-prompt path, whose turn policy skips pre-turn compaction: it opened a turn on the over-threshold context, and compaction only ran at that turn's end - one request closer to the provider's input wall every time.

Three anti-starvation rules keep the gate from holding a family hostage:

- A failed or skipped threshold compaction arms a cooldown; inside the cooldown the gate stands down and messages are delivered. The cooldown lifts once the branch grows by five entries (new material to summarize) or the model changes (a different window may succeed).
- A compaction holding queued messages past `stallWatchdog.abortAfterSeconds` is aborted and the pump is scheduled, so the queued input is delivered instead. That setting ships warn-only (`0`), and the stall watchdog snoozes while compaction owns the turn boundary, so the gate carries its own bound when it is `0`: ten minutes, twice the default provider stream-stall timeout.
- The interactive queue shows what it is waiting for: while a compaction is in flight and messages are queued, the queue frame opens with `compacting context · N queued (agent messages wait for compaction)`.
- Queue capacity is unchanged: `assertAgentMessageQueueCapacity` still caps pending messages per session and refuses, rather than queues, over the limit.

Rollback:

- `compaction.priorityOverAgentMessages: false` restores the old ordering: an incoming agent message opens the turn immediately, and compaction waits for the turn boundary.
- `compaction.triggerRatio: 0.95` approaches the old threshold but is not equal to it. The old trigger was `contextWindow - reserveTokens`; the new one is `min(base * 0.95, base - reserveTokens)` with `base` clamped to the provider's measured input limit, so it still fires earlier whenever the reserve is under 5% of the base or the catalog window over-declares what the provider accepts.

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds (covers the request up to response headers) |
| `retry.provider.maxRetries` | number | `retry.maxRetries` | Provider-failure retries: the retry count the agent's retry loop (and the provider-retry module the one-shot consumers use) applies. Set to `0` to stop retrying provider failures; a path with no module layer (refinement, side questions) lets the provider client retry that many times instead |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |
| `retry.provider.streamStallTimeoutMs` | number | `300000` | Abort a provider stream after this many milliseconds without any response events (5 min). A stall on a silent connection settles as a retryable error, so auto-retry picks it up; a stall while the provider has asked us to wait settles as a rate-limit failure and is not auto-retried. Set to `0` to disable |
| `retry.emptyTurn.maxAttempts` | number | `3` | Total provider attempts for one turn while replies come back empty (no text, no tool calls). `1` disables in-place empty-turn retries |
| `retry.emptyTurn.baseDelayMs` | number | `500` | First wait between empty-turn attempts; doubles per attempt |
| `retry.emptyTurn.maxDelayMs` | number | `4000` | Cap for a single empty-turn wait |
| `retry.emptyTurn.maxTotalDelayMs` | number | attempts x waits | Cap for the summed empty-turn waits of one turn; when it runs out the turn fails and names the budget |

Retries happen exactly once per path, at that path's outermost layer. A module-wrapped path (the agent's own turns, compaction) counts them here and the provider client makes a single attempt; a path with no module layer (a `/refine` request, a `/btw` side question) has no such layer, so the provider client retries it `retry.provider.maxRetries` times instead. `retry.provider.maxRetryDelayMs` is handed to the provider client either way, because that is where a server-requested wait is refused before the SDK sleeps through it - refusing a wait spends no extra request.

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g., "quota will reset after 5h" delivered as `Retry-After: 18000`), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap. The cap is enforced in every provider that retries client-side: OpenAI Completions/Responses, Azure OpenAI, Anthropic Messages (via the SDK's `x-should-retry: false` escape hatch, so the provider's own error and rate-limit classification survive) and Codex SSE. Mistral, Google and Vertex AI do not retry 429 at all, so they ignore it.

`retry.enabled: false` also collapses `retry.emptyTurn.maxAttempts` to a single attempt: switching automatic resends off means the empty-reply path does not keep resending either.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.provider.waitForUsage.enabled` | boolean | `true` | Bounded wait-for-recovery loop for quota exhaustion and provider unavailability |
| `retry.provider.waitForUsage.baseDelayMs` | number | `1000` | First ping delay (doubles per ping) |
| `retry.provider.waitForUsage.maxDelayMs` | number | `300000` | Per-ping ceiling (5m) |
| `retry.provider.waitForUsage.maxAttempts` | number | `30` | Abort bound: maximum recovery pings |
| `retry.provider.waitForUsage.maxWaitMs` | number | `900000` | Abort bound: maximum total wait (15m) |
| `retry.provider.waitForUsage.pauseUntilReset` | boolean | `true` | Park quota-blocked sessions until the provider-reported reset instead of dying mid-task |
| `retry.provider.waitForUsage.maxPauseMs` | number | `86400000` | Abort bound: maximum single park (24h; clamped to 7d) |
| `retry.provider.waitForUsage.maxParks` | number | `8` | Abort bound: maximum parks per quota episode |
| `providerBackupModel` | string | none | Backup model ("provider/model-id" or bare id) used while the primary is quota-blocked or unavailable |

The wait loop runs under the `retry.enabled` master switch: with retries
disabled, no waits run either.

When a request fails with quota/subscription exhaustion (429s, usage limits), the
session waits for usage to come back: it pings the provider with exponential
backoff and jitter (1s doubling to a 5m ceiling) and resumes automatically when
the provider recovers. If the provider reports a reset time (Retry-After header
or "Try again in ~90 min" style text), the resume is scheduled exactly then
instead of pinging. Quick retries still run first for transient errors (5xx,
overload, network, and 404 routing blips); the wait loop takes over when they
are exhausted. Every wait shows attempts and the next check countdown in the
status line, and both abort bounds (`maxAttempts`, `maxWaitMs`) are hard stops:
waits never hang. When a reported reset time exceeds `maxWaitMs`, the wait gives
up immediately with an informative error instead of pinging pointlessly — raise
`maxWaitMs` to wait out long subscription windows.

When `pauseUntilReset` is on (the default) and such a reset is reported — e.g.
the ChatGPT-plan "Try again in ~7272 min" 429 — the session does not die
mid-task: it parks. The turn ends cleanly with a "parked until ..." status, the
park/resume transitions are recorded in the session log, and one durable
one-shot scheduled job (visible via `/cron`) wakes the session at the reset
time — or sooner when `maxPauseMs` caps the park. While parked the session
itself makes no model calls. The wake delivers an
in-context marker telling the model the pause happened and to continue the
interrupted task; that turn's single model call probes the quota. If the quota
is back, the task resumes with its context. If not, the session re-parks with
the newly reported reset, bounded by `maxPauseMs` per park and `maxParks` per
quota episode; when the budget is spent, it aborts exactly like the bounded
wait it replaced. Parks apply at the session level (subagents included), only
for quota failures with a provider-reported reset, and only when no backup
model took over; a `maxPauseMs` above 7 days is clamped. Set
`pauseUntilReset: false` to keep the pre-park behavior of failing immediately.

`providerBackupModel` routes failed turns to a user-defined backup model
instead of waiting while the primary is quota-blocked or unavailable. It is
disabled by default: with no setting, behavior is unchanged and requests never
silently switch models. When set, the retry status line shows an explicit
"retrying on backup model X" indicator, the switch is recorded in the session
log, and the session returns to the primary model automatically (the next turn
probes the primary again). If the backup reference cannot be resolved to an
available, authenticated model, the bounded wait runs instead.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 3,
      "maxRetryDelayMs": 60000,
      "waitForUsage": {
        "enabled": true,
        "baseDelayMs": 1000,
        "maxDelayMs": 300000,
        "maxAttempts": 30,
        "maxWaitMs": 900000,
        "pauseUntilReset": true,
        "maxPauseMs": 86400000,
        "maxParks": 8
      }
    },
    "emptyTurn": {
      "maxAttempts": 3,
      "baseDelayMs": 500,
      "maxDelayMs": 4000
    }
  }
}
```

### Stall Watchdog

Last-resort protection against sessions that go silent mid-turn (dead provider
stream, wedged tool, loop that never settles). While a turn is running, the
watchdog counts time since the last observed session activity:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `stallWatchdog.enabled` | boolean | `true` | Enable the session stall watchdog |
| `stallWatchdog.warnAfterSeconds` | number | `300` | Warn (and log diagnostics) after this many silent seconds (5 min) |
| `stallWatchdog.abortAfterSeconds` | number | `0` | Automatically abort the current turn after this many silent seconds. The default `0` is warn-only: the silence is reported and nothing is interrupted. Set a positive value (it must exceed `warnAfterSeconds`) to opt into the automatic abort |
| `stallWatchdog.toolLivenessExemption` | boolean | `true` | Defer the automatic abort while kernel/host facts vouch that externally owned work is in flight. The warning still fires; only the abort escalation is deferred, and only within a bounded budget |
| `stallWatchdog.treatKernelCpuProgressAsActivity` | boolean | `false` | Reserved, no effect yet: treating kernel CPU progress as session activity is a pending product decision. Registered so the key round-trips without a schema change later |

When the warn stage fires, Prime Agent writes a diagnostics snapshot (last
event type/time, in-flight tool calls, input-pump state, unfinished queued
actions, and — when a kernel is attached — the exemption budget and the kernel
liveness segment) to the structured agent log and shows a warning. If silence
reaches a positive `abortAfterSeconds`, the turn is aborted automatically so the
session becomes usable again instead of appearing busy forever; the abort behaves
like pressing Escape.

With the default `abortAfterSeconds: 0` nothing is aborted, and the warning says
exactly that instead of naming a deadline. That is the intended default: silence is
the normal state of legitimate long work — a quiet build, a cell awaiting a long
job, a subprocess that only reports at the end — and no allowlist of "observable
work" is complete enough to tell it apart from a wedge, so an automatic abort
kills real work. The warning is the signal instead, and it is routed to whoever can
judge: for a subagent it is delivered into the parent agent's transcript with the
silent duration, the in-flight tools and any evidence of work in flight, so the
parent can let it run or cancel it with `rlm.delete_subagent`. A session that is
genuinely wedged is recovered by interrupting the turn (Escape in the TUI), which
is what the automatic abort used to do on a timer's guess.
Phases that legitimately own the turn boundary (compaction,
branch summaries, serialized refinement) pause escalation instead of counting
against it.

Silence that somebody else owns is not stall evidence either. While a tool call
is in flight, a kernel that speaks protocol 4 reports a liveness heartbeat (one
frame per `KERNEL_HEARTBEAT_INTERVAL_MS`, default 5s) carrying its event-loop
tick and monotonic progress counters, and the host adds its own facts
(in-flight host requests, journaled `bash()` children). When those vouch that
real work is happening, the abort is deferred and the warning says so, with the
remaining budget. The deferral is bounded: evidence that something *moved*
(streamed bytes, pipe backlog, buffered output, a host request being executed)
buys the full exemption budget (`max(10 x warnAfterSeconds, 30min)`), while
evidence that something merely *exists* (a live handle producing nothing, a live
loop awaiting a cell) buys a shorter 20-minute budget that stays near the
pre-exemption rescue window. A host request stops vouching once it is 15
minutes old. A kernel whose loop is provably frozen with nothing running
externally gets no exemption at all and is aborted at `abortAfterSeconds` as
before, and a genuinely wedged turn is always killed once the budget is spent.

Interactions: provider-stream silence is usually caught earlier by
`retry.provider.streamStallTimeoutMs` (retryable error + auto-retry), and the
exemption never applies to it — the vouch requires a tool call in flight, so a
healthy kernel cannot excuse a stuck model stream. Commands that are
legitimately long and silent should set `timeout` explicitly in the bash tool
(or raise/disable the watchdog thresholds for such workloads).

```json
{
  "stallWatchdog": {
    "enabled": true,
    "warnAfterSeconds": 300,
    "abortAfterSeconds": 0,
    "toolLivenessExemption": true
  }
}
```

Unattended fleets that would rather reclaim a wedged turn automatically than
investigate it can opt back in with a long deadline, for example
`"abortAfterSeconds": 3600`. The kill then also produces the parent-facing failure
notice, which is the only signal a parent gets when the abort is what ended the run.

To disable entirely: `{ "stallWatchdog": { "enabled": false } }`.

A kernel revival vouches the same way: while a replacement kernel is being
spawned, restored and bootstrapped after an unexpected death, the host is
demonstrably busy on the turn's behalf, so the abort is deferred. That vouch is
bounded by `kernelRestart.revivalVouchMaxAgeSeconds` (below), and a session
whose restart budget is spent grants no exemption at all.

### Kernel Revival

A Python kernel that dies on its own (a crash, an OOM kill) is revived by the
next cell instead of leaving the session unusable: a replacement is spawned, the
last snapshot is restored into it, and the runtime bootstrap is re-run. The
first cell after a revival carries a reset notice in its result head saying
which snapshot point the namespace rolled back to, that everything defined after
that point is gone, and that side effects (file writes, commits, messages
already sent, subagents already spawned) were *not* rolled back.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `kernelRestart.maxUnexpectedRestarts` | number | `3` | Revivals allowed inside the sliding window. Past it the session fails closed: every cell reports `KernelUnavailableError` carrying the death chain, until the window expires on its own or `/reload` rebuilds the session. `0` removes the budget (unbounded lazy revival) |
| `kernelRestart.windowMinutes` | number | `60` | Length of the sliding budget window. `0` makes it unbounded |
| `kernelRestart.revivalVouchMaxAgeSeconds` | number | `600` | How long one revival may vouch for a silent turn (10 min covers a cold bootstrap lock plus a large snapshot read). `0` removes the bound |

All three are read when they are needed, so editing `settings.json` applies to
the next kernel death without a restart.

Teardowns the host ordered never revive and never touch the budget: `shutdown`,
`kill`, dispose, and the protocol-repair family are attributed as intentional.
An unexplained death is logged as `kernel exited unexpectedly` with
`code`/`signal`/`origin`, where `origin` is `oom_suspect` only when the kernel's
own stderr carries memory evidence and `unknown` otherwise.

```json
{
  "kernelRestart": {
    "maxUnexpectedRestarts": 3,
    "windowMinutes": 60,
    "revivalVouchMaxAgeSeconds": 600
  }
}
```

### Kernel Bootstrap

The kernel Python venv is shared by every session on the machine and guarded by
a machine-wide bootstrap lock. Each build identity gets its own versioned
generation directory (`~/.prime/agent/kernel-venv-<hash12>`); a generation with
live kernels is never renamed, rebuilt in place, or deleted under them, and an
old one is reclaimed only after its references drop to zero.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `kernelBootstrap.lockTimeoutMs` | number | `300000` | How long a kernel boot waits for the shared bootstrap lock while another session is creating or rebuilding the venv (5 min). On timeout the boot fails with a typed error naming the lock holder's pid and the `PRIME_AGENT_KERNEL_PYTHON` bypass. `0` waits forever (the previous unbounded behaviour) |

```json
{
  "kernelBootstrap": {
    "lockTimeoutMs": 300000
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"auto"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"`. For Codex providers any value except `"sse"` (including the default `"auto"`) attempts the WebSocket transport; `"auto"` additionally reuses cached server-side context. Set `"sse"` explicitly to force SSE-only |

Who overtakes whom: `steeringMode` and `followUpMode` only control how each queue batches its own deliveries - the steering queue itself always drains before the follow-up queue, even when a follow-up was queued earlier, and within a queue input you send goes ahead of queued subagent replies and other machine traffic, with arrival order preserved among messages of the same kind. A user message an extension submits on your behalf is ruled human by the same structural test the compaction gate uses, so it shares that priority and the two rulings never disagree; the test reads the message's source and shape, not who typed it. Subagent replies and heartbeat prompts default to steering, so they overtake earlier follow-ups. A compaction in flight still outranks a queued subagent reply; your own input is never held by that gate. When admission is paused (MCP reload, ACP stop, update-restart teardown), new input is refused with a retryable error rather than accepted and lost, and during restart teardown the parked queue survives into the restart.

### Agent Messaging

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `agentMessage.targetWaitSeconds` | number | `120` | Longest bound on waiting for a message target that is mid-transition: a session being passivated, an active session still binding, a passive subagent chain hydrating, or an in-flight `rlm()` child publishing its session. The three shorter waits are half of it (60 s at the default). `0` removes every bound, which is the previous behaviour: each wait then lasts as long as the caller's own request |

A bound never cancels the operation it waits for - a passivation, bind or
hydration always runs to completion, because interrupting one halfway leaves a
torn session that is worse than a slow one. The caller gets a factual, retryable
error naming the phase, the target and how long it waited (logged as
`agent message target wait timed out` with `waitedMs`), and a retry joins the
in-flight operation instead of starting a second one. Three retryable failures in
a row for one target become a terminal error telling the model to write its
result to a file and end the turn.

Switch dossier (ship, observe one round, then retune): owner - the
agent-messaging reviewer of this batch; review - two weeks after this ships;
criterion - the p95 of `waitedMs` on the `agent message target wait timed out`
signature (far below a tier means the tier is too long; timeouts on waits that
later succeeded mean it is too short); rollback - raise
`agentMessage.targetWaitSeconds`, or set it to `0` for unbounded waits.

```json
{
  "agentMessage": {
    "targetWaitSeconds": 120
  }
}
```

### Subagent Wake

Whether an agent message queued into a session whose input pump is suspended
(the user pressed Esc, or the stall watchdog killed the turn) may wake it.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `subagentWake.policy` | string | `"failure_aggregated"` | `"never"`: nothing wakes the pump; queued work waits for user input, an attach or an explicit resume, and undeliverable terminal notices are persisted and reflowed at the next start. `"failure_aggregated"`: only failure-class subagent terminal notices wake the pump, as one aggregated turn per quiet window, so Esc keeps meaning "stop". `"always"`: every queued agent message wakes the pump (the old behaviour) |

```json
{
  "subagentWake": {
    "policy": "failure_aggregated"
  }
}
```

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show image type and dimensions in terminal |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Tools

The classic bash tool is not part of the RLM model surface (the model only gets `ipython`),
so there is no settings-level bash timeout. SDK consumers can pass `defaultTimeoutSeconds`
to `createBashToolDefinition` per call site; the model can always override per call with
`timeout`, and `timeout: 0` disables the timeout for that call.

When a command hits the timeout, its process group is killed and the model
receives an error explaining that the command was killed and how to re-run it
with a larger `timeout` (or `timeout: 0` for no limit).

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

#### Shell child environment

Bash-tool, `exec`, and extension children run with an allowlisted environment: secrets such as worker tokens and provider keys are stripped, while a usable shell environment plus the agent's non-secret routing and privacy opt-out names (`DO_NOT_TRACK`, `PI_OFFLINE`, `PRIME_AGENT_TELEMETRY`, agent/session directories, the supervisor socket path and origin session id) are forwarded. To forward additional variables that a command genuinely needs, set `PRIME_AGENT_ENV_PASSTHROUGH` to a comma-separated list of names on the process that starts Prime Agent (children read it from the agent process, so it must be set before the daemon starts):

```bash
PRIME_AGENT_ENV_PASSTHROUGH=HTTPS_PROXY,HTTP_PROXY,NO_PROXY prime-agent
```

Normally the package manager's global modules location is queried using `root -g`. As a special case, if the first element of `npmCommand` is `"bun"`, the modules location will instead be queried with `pm bin -g`.

### Daemon

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `idleEvictionMinutes` | number or `"off"` | `90` | Idle threshold in minutes for whole-tree worker eviction and individual idle-child passivation; `"off"` disables both. A session whose kernel is executing a cell or still owns a live `bash()` handle is not idle, however old its last message is. |
| `daemon.eventGapRecovery` | string | `"log"` | What an attached client does when it detects a hole inside one daemon event generation: `"log"` records the gap only; `"recover"` also re-pulls the session snapshot, behind a circuit breaker (three consecutive gap re-pulls that did not close the hole, or three inside ten minutes, degrade that connection to log-only for the rest of its life). Flipping the default to `"recover"` is gated on the observation archive in `docs/fork/ma-p0-5c-recover-switch-archive.md`; the value is read once per client process |
| `daemon.supervisorRejectionExitThreshold` | number | off | Exit(1) the daemon supervisor once this many unhandled rejections land inside one hour. Unset or `0` keeps the shipped log-and-isolate behaviour: rejections are logged at a bounded rate, counted over an hour, and published as `degraded` in `daemon_hello` |
| `daemon.failedWorkerReapHours` | number | `24` | Hours a failed worker registration whose process is provably gone (no schedule, no attached client) is kept before the reaper archives it to the daemon log with its real failure reason and removes it. `0` or negative keeps failed workers forever |
| `daemon.failedWorkerReapEnabled` | boolean | `true` | Set `false` to disable the failed-worker reaper entirely. The reaper also stands down on its own while the supervisor is degraded |

`idleEvictionMinutes` is a global daemon policy and is read only from `~/.prime/agent/settings.json`. Set it to a positive number to configure the idle threshold. The `daemon.*` supervisor-policy keys default to the shipped behaviour, so an absent `daemon` section changes nothing.

The threshold does not apply to a session whose Python kernel still owns a live `bash()` handle (or is executing a cell). Such a session is not idle, however old its last message is: evicting it would close the kernel, and the kernel's shutdown SIGTERMs every background process group the session was hosting. The pin lasts as long as the handle's process lives - a live long-running script is the workload this rule protects, and it is logged rather than timed out (`Kept idle child resident for live kernel bash work ...` in the daemon log, and one warn per kernel per hour once a handle passes 24 hours). To reclaim such a session, use one of the deliberate exits instead of waiting: delete the subagent (`rlm.delete_subagent` from its parent), shut the session down explicitly, or kill the script's own process - which retires its journal record and makes the session reclaimable at the next sweep. Deliberate teardown paths are not blocked by this rule: an update restart, the daemon's final shutdown, a session replaced or killed on purpose, and a kernel repair kill all still close the session and its kernel.

**What this rule does not protect.** The fact covers a cell the kernel is executing and `bash()` handles it owns - nothing else. Work detached *inside* the kernel (an `asyncio` task or a bare thread left running after its cell returned, a `subprocess` started without `bash()`) is invisible to both, so its session stays evictable and the work is killed silently at the next sweep. Long-running work must either hold a `bash()` handle, keep a cell in flight, or pin the session on purpose by registering an agent heartbeat or a cron job.

```json
{
  "daemon": {
    "eventGapRecovery": "log",
    "failedWorkerReapHours": 24
  }
}
```

### Retention

The retention sweep reclaims resources that no live session references. It runs on a cadence in the
daemon, and on demand through `prime-agent retention sweep [--dry-run]`; `prime-agent retention status`
prints the last sweep. Every default is the shipped behaviour, an absent `retention` section changes
nothing, and a day/hour knob of `0` or negative switches that class off.

The two switches that matter most:

- `retention.enabled: false` is the master rollback lever: the sweep walks every judgement and writes
  its report without deleting anything.
- `retention.dryRun: true` (or `PRIME_AGENT_RETENTION_DRYRUN=1`) does the same for one run; a dry run
  and a real run scan the same set with the same reasons, so what a dry run reports is what a real
  sweep reclaims.
- `retention.sweepLockEnabled: false` is the rollback lever for the sweep guard. The guard is an
  account-integrity lock, not a delete-safety lock: it keeps one per-sweep circuit breaker and one
  serialized rewrite of `history.jsonl`. A guard that cannot be created (a read-only agent dir)
  degrades to an unlocked sweep with a log line rather than stopping cleanup, and a contended sweep
  leaves `<agentDir>/retention/sweep-in-progress.json` naming the holder pid and start time.

Each sweep stops after a circuit breaker (`retention.maxDeleteBytesPerSweep`, default 512 MiB, and
`retention.maxDeleteEntriesPerSweep`, default 20000); a non-positive value for either keeps the
shipped default rather than removing the breaker. The report lands in `<agentDir>/retention/last-sweep.json`
with one compact line per sweep appended to `<agentDir>/retention/history.jsonl`.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retention.enabled` | boolean | `true` | Master switch; `false` reports without deleting |
| `retention.dryRun` | boolean | `false` | Report what a sweep would reclaim, delete nothing |
| `retention.sweepIntervalMinutes` | number | `60` | Daemon sweep cadence; `0` or negative disables the periodic sweep (the manual command stays) |
| `retention.maxDeleteBytesPerSweep` | number | `536870912` | Bytes one sweep may reclaim before it stops; non-positive keeps the default |
| `retention.maxDeleteEntriesPerSweep` | number | `20000` | Entries one sweep may reclaim before it stops; non-positive keeps the default |
| `retention.cooldownMinutes` | number | `10` | Any candidate touched more recently is kept; non-positive keeps the default |
| `retention.sweepLockEnabled` | boolean | `true` | One sweep per agent dir at a time, across processes: a second trigger reports the last sweep instead of walking the tree twice and re-writing the sweep history. `false` goes back to concurrent sweeps |
| `retention.emptyArtifactDirDays` | number | `7` | Artifact directories with no file anywhere in the subtree, once the session that owned them is provably gone; `0` disables |
| `retention.deletedSessionResidueDays` | number | `7` | Artifact directories that still hold leftovers (a semantic-edges stub, a local harness copy, a stale kernel snapshot) of a session whose deletion is on record; `0` disables. A directory whose id was reused by a new session is never reclaimed |
| `retention.childTranscriptDays` | number | `30` | Sub-agent transcripts (`sub-xxxxxxxx/<uuid>.jsonl`) older than this. A live child is kept by its ledger edge; a deleted child's transcript is residue whose durable record is the display tombstone plus the ledger delete record. `0` = off |
| `retention.logFileDays` | number | `14` | Log files whose socket no longer exists; the newest file of a rotated group and every log of a live socket are kept; `0` disables |
| `retention.tmpRlmDirHours` | number | `24` | Empty `prime-agent-rlm-*` temp directories; `0` disables. The daemon's own `prime-agent-<uid>` socket directory is never a candidate |
| `retention.tmpOtherDirDays` | number | `0` | Any other `prime-agent-*` temp directory (telemetry, test prefixes); off by default |
| `retention.bashTempFileHours` | number | `24` | `pi-bash-*.log` tool-output temp files; `0` disables |
| `retention.bashTempFileMaxBytes` | number | `268435456` | Write-side cap for one `pi-bash-*.log` file; non-positive keeps the default |
| `retention.staleLeaseHours` | number | `24` | Session-lease directories whose owner is provably gone (pid plus process start identity); `0` disables |
| `retention.kernelSnapshotGenerations` | number | `1` | Retired kernel snapshot generations kept after the referenced ones |
| `retention.kernelSnapshotReclaimEnabled` | boolean | `false` | Reclaim unreferenced kernel snapshot generations. Off: the snapshot bytes ride live references, and the writer still uses the single-file layout |
| `retention.venvRetention` | number | `1` | Retired kernel venv generations kept (the boot path's `RETIRED_VENV_RETENTION`) |
| `retention.venvReclaim` | boolean | `false` | Let the sweep reclaim retired kernel venv generations. Off: the sweep reports what the boot path would prune, and only `bootstrap.ts` prunes for real, because it can name the generation it is about to spawn from while a sweep cannot |
| `retention.ledgerCompactionEnabled` | boolean | `true` | Compact an RLM spawn ledger that outgrew its bounds (32 MiB / 100k records) down to its replay-equivalent terminal records, both before a refused append and opportunistically in the sweep. Off: an over-bound ledger fails closed - spawning, deletion and the session catalog refuse to read it until an operator intervenes |

#### Which window applies to which bytes

A directory is not one kind of content. An artifact directory left by a deleted session holds its own
residue (`harness/`, `kernel-state/`, `semantic-edges.jsonl`) *and* the deleted sub-agents' transcripts
under `sub-xxxxxxxx/`, and those bytes do not have the same lifetime. Each identity therefore has one
window and exactly one implementation that judges it - the window follows the bytes' identity, not the
directory they sit in:

| Bytes (by identity) | Window | The one judge |
|---------------------|--------|---------------|
| `sub-*/<uuid>.jsonl` transcript of a non-live child, deleted children included | `retention.childTranscriptDays` (`30`) | the `child-transcripts` class: age is the newer of the transcript's own mtime and the newest write anywhere in the `sub-*` directory that holds it (a sibling writer mid-flush keeps the file) |
| `sub-*/rlm-subagent.json` display tombstone | none of its own - it lives and dies with its transcript | none: it goes when its directory goes |
| the rest of a deleted session's directory (`harness/`, `kernel-state/`, `semantic-edges.jsonl`, trash) | `retention.deletedSessionResidueDays` (`7`) | the `artifact-residue-dirs` class |
| a directory with no file anywhere in its subtree | `retention.emptyArtifactDirDays` (`7`) | the `artifact-empty-dirs` class |
| ledger records | no age; only records that replay identically without them may be compacted | the rlm-ledger compaction path |

Rule for mixed directories (max-window): **a directory may only be removed as a whole once every
protected byte inside it has passed its own window**, so a mixed directory lives until the maximum of
the windows of the bytes it holds. With the shipped defaults a deleted session's directory that still
contains a child transcript is kept between days 7 and 30 with the reason
`young:child-transcript:30d`, and is reclaimed in a single pass after day 30 - the same end state the
7-day residue window produced, one window later. A directory without protected bytes inside keeps its
7-day life.

The reclaim judgements share one law, borrowed from the kernel venv generation manager: a path whose
liveness cannot be **disproved** is kept. A probe that fails, a directory whose transcript is missing
from one root but present in another (a sub-agent's transcript lives under
`<parentArtifactDir>/sub-xxxxxxxx/`, not in `sessions/`), a lease record that cannot be parsed, and a
kernel snapshot whose reference state is unreadable are all reported as `unverifiable:` or
`in-use:`/`reference:` reasons in the report, never treated as reclaimable. The global harness memory
library (`<agentDir>/harness/`) is not in any sweep class: only the per-session copy inside an artifact
directory leaves, and only as part of removing that whole directory.

```json
{
  "retention": {
    "sweepIntervalMinutes": 60,
    "logFileDays": 14,
    "tmpRlmDirHours": 24
  }
}
```

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".prime/agent/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `PRIME_AGENT_SESSION_DIR`, the legacy `PRIME_AGENT_CODING_AGENT_SESSION_DIR`, then `sessionDir` in `settings.json`.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Alt+M cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.prime/agent/settings.json` resolve relative to `~/.prime/agent`. Paths in `.prime/agent/settings.json` resolve relative to `.prime/agent`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `extensionHandlerTimeoutMs` | number | `30000` | Per-handler and factory load timeout in milliseconds. Timed-out event handlers are skipped so the session stays live; timed-out `tool_call` handlers block the tool (fail-safe). `0` disables the wall-clock timeout. |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |
| `enableBuiltinSkills` | boolean | `true` | Load built-in skills shipped with prime-agent |
| `bundledSkills.websearch` | boolean | `true` | Load the built-in `websearch` skill |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

Disable the built-in `websearch` skill while keeping normal skill discovery enabled:

```json
{
  "bundledSkills": {
    "websearch": false
  }
}
```

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "xhigh",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "triggerRatio": 0.8,
    "priorityOverAgentMessages": true
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## Project Overrides

Project settings (`.prime/agent/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.prime/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .prime/agent/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
