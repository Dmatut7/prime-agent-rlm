# Settings

Prime Agent uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.prime/agent/settings.json` | Global (all projects) |
| `.prime/agent/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | `"medium"` | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

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
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `treeFilterMode` | string | `"user-only"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show terminal cursor |

### Update Checks

Stable builds fetch the release manifest at `https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/latest.json`. Beta builds fetch `beta.json` and continue following beta updates. Override the base URL with `PRIME_AGENT_DOWNLOAD_BASE_URL`.

Set `PI_SKIP_VERSION_CHECK=1` to disable the Prime Agent version update check. Use `--offline` or `PI_OFFLINE=1` to disable startup network operations, including update checks and package update checks.

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

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

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
| `retry.provider.maxRetries` | number | SDK default | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |
| `retry.provider.streamStallTimeoutMs` | number | `300000` | Abort a provider stream after this many milliseconds without any response events (5 min). The turn settles as a retryable error, so auto-retry picks it up. Set to `0` to disable |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
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
| `stallWatchdog.abortAfterSeconds` | number | `900` | Automatically abort the current turn after this many silent seconds (15 min). Set to `0` for warn-only mode |
| `stallWatchdog.toolLivenessExemption` | boolean | `true` | Defer the automatic abort while kernel/host facts vouch that externally owned work is in flight. The warning still fires; only the abort escalation is deferred, and only within a bounded budget |
| `stallWatchdog.treatKernelCpuProgressAsActivity` | boolean | `false` | Reserved, no effect yet: treating kernel CPU progress as session activity is a pending product decision. Registered so the key round-trips without a schema change later |

When the warn stage fires, Prime Agent writes a diagnostics snapshot (last
event type/time, in-flight tool calls, input-pump state, unfinished queued
actions, and — when a kernel is attached — the exemption budget and the kernel
liveness segment) to the structured agent log and shows a warning. If silence
reaches `abortAfterSeconds`, the turn is aborted automatically so the session
becomes usable again instead of appearing busy forever; the abort behaves like
pressing Escape. Phases that legitimately own the turn boundary (compaction,
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
    "abortAfterSeconds": 900,
    "toolLivenessExemption": true
  }
}
```

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
| `transport` | string | `"sse"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, or `"auto"` |

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

Normally the package manager's global modules location is queried using `root -g`. As a special case, if the first element of `npmCommand` is `"bun"`, the modules location will instead be queried with `pm bin -g`.

### Daemon

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `idleEvictionMinutes` | number or `"off"` | `90` | Idle threshold in minutes for whole-tree worker eviction and individual idle-child passivation; `"off"` disables both. |
| `daemon.eventGapRecovery` | string | `"log"` | What an attached client does when it detects a hole inside one daemon event generation: `"log"` records the gap only; `"recover"` also re-pulls the session snapshot, behind a circuit breaker (three consecutive gap re-pulls that did not close the hole, or three inside ten minutes, degrade that connection to log-only for the rest of its life). Flipping the default to `"recover"` is gated on the observation archive in `docs/fork/ma-p0-5c-recover-switch-archive.md`; the value is read once per client process |
| `daemon.supervisorRejectionExitThreshold` | number | off | Exit(1) the daemon supervisor once this many unhandled rejections land inside one hour. Unset or `0` keeps the shipped log-and-isolate behaviour: rejections are logged at a bounded rate, counted over an hour, and published as `degraded` in `daemon_hello` |
| `daemon.failedWorkerReapHours` | number | `24` | Hours a failed worker registration whose process is provably gone (no schedule, no attached client) is kept before the reaper archives it to the daemon log with its real failure reason and removes it. `0` or negative keeps failed workers forever |
| `daemon.failedWorkerReapEnabled` | boolean | `true` | Set `false` to disable the failed-worker reaper entirely. The reaper also stands down on its own while the supervisor is degraded |

`idleEvictionMinutes` is a global daemon policy and is read only from `~/.prime/agent/settings.json`. Set it to a positive number to configure the idle threshold. The `daemon.*` supervisor-policy keys default to the shipped behaviour, so an absent `daemon` section changes nothing.

```json
{
  "daemon": {
    "eventGapRecovery": "log",
    "failedWorkerReapHours": 24
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
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

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
    "keepRecentTokens": 20000
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
