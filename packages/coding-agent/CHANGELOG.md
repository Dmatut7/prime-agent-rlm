# Changelog

## [0.11.9] - 2026-09-24

- Changed the stall warning to one plain-language line on the action bar (what it is waiting on, for how long, what still runs in the background) instead of printing the forensic snapshot as an error; the snapshot stays on the diagnostics key.
- Added prompt guidance that a program meant to keep running is started without awaiting its handle.

## [0.11.8] - 2026-09-24

- Changed the bailian web search to turn the search model's reasoning off by default (`thinking=True` opts back in): the same news query took 18-21s instead of 91s.

## [0.11.7] - 2026-09-24

- Changed the bailian web search default timeout from 90s to 240s; broad queries such as today's news regularly took longer and timed out.
- Fixed a web search handed to asyncio.to_thread showing as 查看输出 instead of 联网搜索 in the process line.

## [0.11.6] - 2026-09-24

- Fixed the bailian web search losing its answer when the model awaited it: the returned text is now also awaitable.

## [0.11.5] - 2026-09-24

- Fixed a settings file that appeared right as a session started watching being missed until the next restart.

## [0.11.4] - 2026-09-24

- Fixed automatic continue pushing past a step the model had stopped to get approval for ("once you approve", "你确认后"), and changed its notice to say an approval-gated step is never taken on a continue.
- Fixed the system prompt claiming ipython is the only tool when MCP or extension tools are also listed.
- Added a prompt note that a call silent for about 5 minutes is stopped, and how to run long quiet work as a polled handle or with `timeout <secs>`.
- Fixed compaction dropping modified-file entries to fit the file-list character budget; only read-only entries are trimmed now, and the summarizer is told to keep open tasks, errors and user constraints when anchoring to the newest kept state.
- Fixed the bailian-web-search skill docs, which called a module name the kernel does not bind and awaited a synchronous function.
- Fixed a restored Python skill being reported unavailable when the shared kernel venv installs it from another checkout with the same source.
- Fixed the kernel bootstrap overwriting restored user variables named `json`, `os`, `re`, `shlex`, `sys` or `Path`.
- Fixed `yaml.safe_dump` failing on bash output and harness overview strings.
- Added the `~/.local/bin/uv` form of the kernel package install command for shells whose PATH lacks uv.
- Changed the stall-recovery receipt so a parent deletes the original child before pasting the re-dispatch line, instead of running two workers on the same files.
- Fixed the per-call tool deadline cancelling legitimate long work the kernel could not vouch for (synchronous cells, downloads, compute, sleep polling, or any call with the watchdog off); the silent-step rule now decides, and `timeout_ms=` in cell code counts as the call's own timeout.
- Fixed cells silently awaiting a host request (for example `rlm.collect` on a child) being stopped as stuck after 5 minutes.
- Changed the daemon's automatic stall recovery for main sessions and subagents to be off unless `stallWatchdog.abortAfterSeconds` is positive or its `enabled` is set, and made it re-check the watchdog's exemption live; the child stall notice now states the real kill deadline.
- Changed image-routed runs to hand the rest of the run back to the session model once the image model has described the images, instead of doing the whole task on the image model.
- Changed the unavailable-Python-skill notice to explain how to reload a skill after installing its dependency, and dropped its claim about shell command forms.

## [0.11.3] - 2026-09-24

- Added a `bailian-web-search` kernel skill: web search through Bailian with `enable_search`, defaulting to the `max` search strategy and always using the public compatible endpoint, with the API key resolved from `DASHSCOPE_API_KEY` or `~/.prime/agent/models.json`.
- Fixed the daemon resending the whole conversation every few seconds after large tool results; it now only falls back to a full resync when a client has stopped reading.
- Added the duty log (值班记录): opening a session after being away (default 2 hours, `ui.dutyLogAfterMinutes`) shows what the agent did, what went wrong and was handled, and what needs your decision; `/dutylog` or `/值班` shows it on demand.
- Changed the model-facing prompt and recovery notices to explain the reason behind each rule (verify before saying done, find the cause before fixing, plain words instead of internal shorthand), and removed duplicated delegation guidance.
- Fixed the unavailable-skill notice suggesting a bare `uv pip install`, which exits in the unseeded kernel venv; it now names the kernel interpreter.
- Added an automatic model fallback chain (`providerFallbackModels`, default bailian glm-5.3-prime → kimi-k3 → qwen3.8-max-0902 when configured): quota exhaustion, spent quick retries on an unavailable provider, or three invalid tool calls in a row move the task to the next model with the same context, the primary is probed again after 30 minutes, and when every model fails the turn waits in long rounds (`retry.provider.fallbackLongWait`) instead of ending.
- Changed retry status lines to Chinese and show a one-line notice when a turn moves to another model.
- Changed the provider fallback chain to be off unless `providerFallbackModels` is set, and to skip models without image input when the context holds images the serving model reads.
- Fixed Python skills (agent_message, agent_observe, goal and others) being reported unavailable after a session worker restarted and restored a saved kernel state that held them as plain modules.
- Fixed the RLM prompt teaching Python API that does not exist (BashResult vs handle fields, synchronous harness calls, subagent row fields, skill call forms), with a test that checks every taught name against the runtime.
- Changed the kernel to pre-import `json`, `os`, `re`, `shlex`, `sys` and `Path`, which the prompt tells the model to use.
- Changed the kernel runtime to accept the spellings models reach for most (`r.duration_ms`, `r.output()`, `h.exit_code`, awaiting harness calls, `.get()`/`.name` on subagent records).
- Changed expanded quiet-mode steps to show at most six output lines, one row each, indented under the turn's process line.
- Added a quiet conversation mode (`ui.processMode`, default `quiet`): each agent turn collapses its process noise into a single footnote line at the turn head - `干了 1 分 05 秒 · 14 步 [O] · 想 7 段 [T] · → 通讯 2 条 [P]` - with mid-turn narration folded behind it and text-only turns reading `想了想`; `ui.processMode: "legacy"` restores the old fully expanded view.
- Changed Ctrl+O/T/P to expand the process, thinking, and comms blocks independently (all three can stay open together), with long step lists auto-folded to key steps, failed steps always visible, bounded per-step output height, and Esc closing the last-opened block first.
- Added narrow-terminal and mouse handling to the footnote: under 100 columns it switches to the compressed form `干了 1分05秒 · 14步 · 7想 · 2讯` (dropping key hints before truncating), and clicking a stats segment jumps straight to its detail block.
- Changed the per-turn process line to say what the turn did in plain words (`▸ 思考 · 3 步 · 14.8s   运行 npm check · 读取 footer.ts`) and to list changed files with +/− counts while collapsed.
- Changed the expanded ipython step header to a plain-words label with output line count and duration instead of `↑ N ↓ M lines`.
- Changed the status area: key hints now sit above the prompt and show only the keys usable right now; the footer line shows model, directory, branch, and right-aligned context figures, with the watermark bar only near the compaction threshold.
- Changed the startup header to a compact wordmark with model and directory rows, and translated start hints, loader labels, and the tmux notice to Chinese.
- Removed the chat-tail `Ctrl+T 思考 · Ctrl+O 过程 · Ctrl+P 通讯` hint line and the `[O]/[T]/[P]` bracket hints.
- Changed the quiet running face to match the design: the live activity (`◈ 运行中 12s`) moved into the status line, the prompt reads 随时补充或纠正 while a turn runs, and the process line shows measured Thinking time.
- Added a two-row Thinking preview at the top of an opened process block, a 继续 row on the startup header for the last session in this directory, and a per-child subagent panel.
- Changed the interface text to Chinese across status messages, the shortcut panel, session list, session tree, model picker, heartbeats, queue rows, agent-message rows and the exit hint (Thinking stays English).
- Fixed the turn caret not flipping on Ctrl+T/Ctrl+P, the full-output toggle not repainting, a single Ctrl+C during a run arming exit, the shortcut panel not closing, and interrupted steps showing raw KeyboardInterrupt tracebacks.
- Fixed tests writing fake sessions into the real agent directory.
- Fixed Python skills being reported unavailable (and so avoided by the model) after a kernel re-bootstrap or restored state.
- Changed the settings menu, login dialog, model and provider pickers, slash-command descriptions and list scroll indicators to Chinese.
- Changed user messages to render verbatim instead of as Markdown.
- Changed setting values, provider subtitles and remaining login-dialog text to Chinese, and unrecognised Python steps to short labels such as 设置 x / 查看 x.
- Added block navigation: Alt+↑/Alt+↓ (when no messages are queued) walk the conversation blocks with a highlight; Enter or Space opens the block's steps or Thinking, y copies it, Esc returns to the prompt; fullscreen scrolls the focused block into view.
- Changed agent-message rows inside a quiet turn to line up with the turn's steps, and queue previews to read 定时任务 / 目标 / 收到消息.
- Fixed three long-failing test suites (git config leak, harness gaps) and translated the new-session messages.
- Added silent-step detection: a tool call that produces no output for `tools.timeout.silentStuckSeconds` (default 300) is stopped even when its process is still alive, while a call whose output keeps flowing is never stopped; the model is told which step was stuck and warned when the same step gets stuck twice.
- Added automatic continue: when a turn stops right after tool work with a reply that only announces the next step, the session continues on its own (at most twice per request, never for final answers, questions or waiting on subagents; `selfRecovery.autoContinue`).
- Added an opt-in, one-time reminder for a subagent that finishes its task without replying to its parent (`selfRecovery.childReplyNudge`, off by default).
- Changed the busy-kernel wait/restart prompt to restart the kernel automatically when nobody answers within 60 seconds, and stopped telling the model to kill the kernel itself.
- Added self-recovery and duty-log entries to the session transcript for every automatic stop, continue and reminder.
- Changed the silent-step rule to count CPU burned by the step's process tree (`tools.timeout.silentStuckCpuMs`, default 1000) as activity, and to honour a longer timeout the model gave the call, so quiet test runs, installs and compiles are never stopped.
- Fixed a false "completed without a reply" notice that woke the parent after it deleted or released a subagent whose reply had been queued.
- Fixed automatic continue treating a closing offer ("接下来我可以……", "If you want, I can also…") as an unfinished next step.

## [0.11.0] - 2026-09-22

- Added an empty-response recovery continuation: when the retry ladder is exhausted, the session queues one custom message per failure episode so the model gets a turn to recover the task instead of a silent stop, and a terminal `empty_response_exhausted` event reports the real attempt counts.
- Calibrated the subagent terminal-error notice for empty-response failures to report the real in-place attempt counts (fast tier, slow tier, recovery continuations) instead of "no retries attempted".
- Added the per-tool-call deadline wiring with the stall watchdog as the single exemption arbiter (progress defers a full window, liveness half a window, no evidence cancels the call while the turn continues).
- Added the settings handles `retry.emptyTurn.escalated*` (single slow-tier waits are clamped below the stall warn threshold), `retry.emptyTurn.recovery.*`, and `tools.timeout.{enabled,afterMs,perTool}`; all are hot-read per turn, so `tools.timeout.enabled: false` or `afterMs: 0`, `escalatedAttempts: 0`, and `recovery.enabled: false` each roll one half back without a restart.
- Added automatic stall recovery for wedged sessions: a daemon sweep interrupts a turn that has gone silent past the watchdog threshold (once per turn, after a grace window for subagents and a 120s human window for attached main sessions, acting immediately when nobody is attached), queues a system instruction telling the model to change approach, and escalates to the parent after 15 minutes instead of ever re-dispatching automatically. Rollback: subagents.stallRecovery.enabled / stallWatchdog.rootRecovery.enabled.
- Added the stall action bar to the interactive TUI: a stall warning now offers interrupt (the host's real interrupt key) and diagnostics actions, degrades to the old plain error text when no action is available, and never renders actions for terminal stall stages.
- Fixed the stall-recovery stop-line keys (`subagents.stallRecovery.maxPerSession`, `stallWatchdog.rootRecovery.maxPerSession`) to honor an explicit 0 as notify-only instead of silently restoring the default of 3, aligning their 0 semantics with `graceSeconds` and `humanWindowSeconds`.
- Hardened the stall-recovery receipt's pasteable re-dispatch line: token slots (name, model, thinking) are stripped of quote, backslash, separator, and comment characters, a prompt ending in a quote or backslash is padded, and the truncation marker rides as a trailing Python comment, so the line always pastes as exactly one valid `await rlm(...)` call.
- Split the stall-recovery escalation receipt's facts so `escalateAfterMs` is only the policy window and the measured silence since the action travels as `silentSinceActionMs`, letting the receipt quote what actually happened instead of one number for both semantics.
- Added the depth-0 stall-recovery escalation message (`stall_recovery_escalation`): the notice a still-silent main session gets in its own transcript, carrying the real action taken and a pasteable `prime-agent attach` line.
- Fixed the daemon stall-recovery sweep judging deaths from a stale warn-time snapshot: sessions streaming or mid-bash/retry/compaction are never auto-killed, the watchdog's live exemption verdict (not the marker) decides excuses, action-time silence is measured, and a slow admission can no longer stack multiple interventions.

## [0.11.1] - 2026-09-22

- Status area redesign (U6): the footer renders one watermark line `glm-5.3-prime · max    ──────●───────│──    518k/1M · 49%` (● = context level, │ = auto-compaction notch; reaching the notch brightens it and appends 压缩在即), the tray top line is pure navigation (`← agents/resume · 深度 0`) with the context figures as an off-mode fallback, and the subagents line is borderless with zero-count classes skipped (`运行 1 · 收口 2 · 子代理 ¥… ｜ 全部 ¥…`). The model pin left the top bar, footer.telemetry collapses to off|on (legacy compact/full read as on), and the storm-zone marker is gone per the boss's deletion order.
- Conversation noise cut (U6): each turn's mechanical surface is one line pinned at the turn head — `⚙ 10 步 · 1.0s · python×10 · 思考 10 段` — with the turn's thinking blocks counted into it (a thinking-only turn reads `思考 5 段 · 96.3s`); the collapsed view renders zero per-block thinking rows, and the full traces only appear in the Ctrl+O expanded view. Mid-turn loader remounts no longer reset the turn group (the reset moved to the agent_start edge, fixing the K3-2 remount finding).
- Two-key interaction model (U6, boss's Cursor-style order): every turn renders an always-visible one-line thinking block header (`思考 12.3s` / `思考 5 段 · 96.3s`) above the process line; Ctrl+T expands the thinking traces, Ctrl+O expands tool calls, outputs and edit diffs, Ctrl+P stays on agent message rows. All per-line `(Ctrl+O 展开)` suffixes are gone, replaced by one dim tail line `Ctrl+T 思考 · Ctrl+O 过程 · Ctrl+P 消息`; feature hints start with a `›` chevron instead of the `提示：` prefix.
- Follow-up test pins for the U6 suffix removal: the bash execution tally, the refinement outcome one-liner, and the ENG-4583 regression now assert the hint-free rows instead of the deleted per-line expand hints.
- Two-key scope (K3): plain Ctrl+T/O/P expand the latest turn only - the turn at the chat's tail - while Alt+T/Alt+O/Alt+P expand every turn (the full-replay case). The thinking header, the process surface, and agent message rows each keep their per-turn lane, so a long session never explodes from one keypress. expandFull moved from Alt+O to Alt+Shift+O to make room for the global lane.
- Rework batch (review-driven): money left the fullscreen top bar (the spend cell on the subagents line is its only home, one currency symbol, /usage carries the detail); the context figures read one memoized per-frame pair shared by the watermark and the off-mode fallback; the compaction notch and 压缩在即 follow the real threshold setting (0.5-0.95, off when the reserve disables it); the subagents line fits 80 columns; Ctrl+T/O/P act on the latest turn with Alt+T/O/P as the global lane; depth renders only when non-zero; the thinking header carries the segment count while the ⚙ line owns the duration.
- Error visibility fix (user-reported regression): a failed tool's collapsed ✗ row stays visible with its readable error instead of folding into the ⚙ line, and the aggregate line itself reports the failure count (`⚙ 4 步 · 1.0s · ✗1 · python×4`), so a broken step is visible both in detail and in summary.
- **Migration for Bailian GLM users**: add `"compat": { "toolStream": false }` to every Bailian GLM-5.3-family model entry in `~/.prime/agent/models.json`. Without it the gateway streams tool-call arguments in fragments, which corrupt tool names on long sessions (garbled "Tool ... not found" calls). See docs/models.md, "compat.toolStream".
- Fixed `model.info` (used by the attach-image skill's vision preflight) to report the model serving the current run instead of the session model, so attaching images mid-turn works on turns routed to `settings.imageModel` while text-only session models still reject; the routed override can persist between runs, so a read in that gap may still name the previous routed turn's image model until the next dispatch re-evaluates routing.
- Fixed compaction serialization dropping user messages that only carried images: they now serialize as a `[image xN]` placeholder with the honest image count instead of vanishing from the summarizer input.
- Added a level-one image-delivery suspicion notice: when an image-carrying turn completes on an OpenAI-completions API whose usage reported no image token count, the session records a user-visible receipt saying the model may not have received the images (suspicion only; some vision providers never report the count; no settings change).
- Added a one-line installer for this fork line (`install-fork.sh`): clone, `npm ci`, build, and `npm link` in one command, so users no longer fall into the upstream one-liner that ships none of this line's fixes.
- Fixed the image-delivery suspicion notice to also count image blocks that tool results deliver mid-run (the attach_image path), so a turn whose committed batch was image-free still records the notice when its in-turn image attach goes uncounted.
- Fixed the agents view to collapse the settled/duration columns entirely when no row in a section carries them (older daemons, bare summaries), instead of spending their width on blank cells that squeezed the trailing age and model columns at narrow widths.
- Fixed roster session duration to quantize to whole seconds, so a busy session no longer flips the roster compose fingerprint on every unscoped flush and the incremental roster stops degrading to full deltas on slow machines.
- Removed the keep-only-the-newest harness digest behavior (revert 9cf71140f of the 6d2c1e857 pick of upstream #2394): it conflicted with this fork's own digest window mechanism (material-change re-delivery and resume-time tail stacking) and turned 10 pins in the 2098 digest suite red. Built context again stacks consecutive harness digest frames on long-lived sessions, costing roughly 1.5-2.5k tokens.

## [0.11.0] - 2026-09-22

- Fixed session worker CPU and memory blowup while subagents stream, caused by unbounded concurrent session-list refreshes rescanning every child transcript on each `rlm_child_update`.
- Changed session list metadata to rescan only the bytes appended since the last read, instead of re-reading the whole session file every time a live session grows.
- Changed the RLM spawn ledger to reuse its last replay while the file on disk is unchanged, instead of re-reading and re-parsing it for every query.
- Changed the daemon to skip an agent peer sync when a worker's peer list is already up to date.
- Changed summary refreshes driven by subagent streaming to observe a minimum interval, so a burst of child updates no longer pushes every session's in-progress message across the worker socket at token rate.
- Changed streaming tool calls to rebuild their panel only when the arguments actually change.
- Fixed session workers being torn down and left recovering — which blanked the context/token indicator — when two snapshot transfers were taken at the same event cursor ([#1229](https://github.com/PrimeIntellect-ai/prime-agent/issues/1229)).
- Fixed the daemon saturating a CPU core while subagents stream, by keeping each session's in-flight assistant message out of the summary refreshes that a token burst triggers.
- Changed image output to report when the current terminal cannot render inline images.
- Fixed queued messages staying parked after Escape or Ctrl+C interrupted a turn: pressing Enter on an empty editor now sends the parked queue, and the queued-messages footer shows `enter to send` while the session is idle ([#1476](https://github.com/PrimeIntellect-ai/prime-agent/discussions/1476)).
- Changed the ACP lifecycle default so stdin EOF completes the owned session instead of detaching a resident worker; added `--acp-resident` to retain the old resident behavior for editor reconnect.
- Fixed print and json mode completing the owned session as soon as the root turn went idle, which aborted RLM subagents that were still running before the root could consume their results.
- Documented that print and json mode now wait for in-flight subagents to settle before exiting, so a subagent that never settles holds the run until the long-running request timeout (24 hours in daemon mode) unless interrupted.
- Fixed agent messages queued into a session whose input pump was suspended by an abort: the queue now resumes the pump so the message is consumed instead of silently stalling the session.
- Capped the TUI live chat component tree: long sessions now rebuild the transcript through the session-open render window once it grows past the cap, bounding memory use; entering fullscreen restores the full transcript for scrollback.
- Hardened session transcripts, session-artifact directories, rotating logs, auth storage, harness state, HTML exports, and editor temp files to private 0600/0700 modes with symlink-safe exclusive creates ([#1249](https://github.com/PrimeIntellect-ai/prime-agent/pull/1249)).
- Rejected unsafe session ids, symlinked transcripts, and non-private artifact directories in session storage paths ([#1249](https://github.com/PrimeIntellect-ai/prime-agent/pull/1249)).
- Added security and sandboxing guidance for unattended runs and clarified that `--no-session` is not fully stateless ([#1120](https://github.com/PrimeIntellect-ai/prime-agent/issues/1120)).
- Trimmed the live chat component tree in default fullscreen rendering; only an unfollowed fullscreen review skips the cap.
- Fixed aborted sessions keeping dispatched queued turns active forever, which left wait_for_idle and RLM quiescence hanging.
- Treated wait_for_headless_completion as a read-only daemon command so long RLM quiescence waits no longer block update-restart drains or idle eviction sweeps.
- Cleared in-flight terminal paste when replacing a session so leftover paste terminators cannot land in the new editor.
- Added the streaming_deltas capability: the supervisor forwards compact per-token assistant stream deltas to capable clients instead of rebuilding the full message_update payload, and daemon connections accumulate the deltas locally.
- Fixed a wedged update restart: a prepared daemon whose handoff stalled now re-issues its checkpoint to a retried prepare instead of failing with "already preparing", and a fully rejected fallback restore keeps the manifest for the next attempt.
- Reattached in-flight streaming and bash components after a transcript rebuild so fullscreen restore cannot leave live output on a detached ghost component.
- Added a session stall watchdog (`stallWatchdog` settings) that warns and logs diagnostics after a running turn goes silent (default 5 min) and auto-aborts the turn if silence persists (default 15 min), so stuck sessions become usable instead of appearing busy forever.
- Added `retry.provider.streamStallTimeoutMs` (default 300000, 0 disables) to abort dead provider streams mid-turn; the failure is retryable so auto-retry recovers it.
- Added `stall_warning` and `stall_abort` session events surfaced in the TUI, print mode, and ACP, carrying a diagnostics snapshot (last event, in-flight tool calls, pump state, queued actions).
- Fixed branch summarization to stop collecting at the newest compaction boundary so old compaction summaries are not re-summarized into branch summaries or goals.
- Broadened compaction file-operation tracking to write-style tools with path-like arguments (write, patch, str_replace variants) and documented that bash/ipython file changes are not statically attributed.
- Fixed context token estimation to count image blocks in user messages so trailing pasted images are not under-counted before threshold compaction checks.
- Fixed threshold-compaction storms: skip threshold triggering when the reserve consumes the whole window, cap keepRecentTokens to the post-reserve threshold, and cut at the closest valid point before an oversized trailing tool result instead of keeping everything.
- Added `tools.bashTimeoutSeconds` (default 600): bash tool calls now get a default timeout when the model passes none, so a hung command is killed (process group included) instead of wedging the turn forever.
- Changed the bash timeout error to tell the model the command was killed and how to extend or disable the timeout (`timeout` in seconds; `timeout: 0` = no limit).
- Fixed compaction summarization to budget its own input to the model's usable window, eliding oldest messages first, and added a cooldown so skipped or failed threshold compactions do not retry every turn until the branch grows.
- Fixed a race where navigating the session tree while a compaction summary was being generated attached the summary to the wrong branch; the compaction entry now pins the branch it summarized.
- Added a per-handler timeout for extension events and factory load so a hung extension cannot freeze the session or abort.
- Added a "(no activity Xm)" marker in the agents view for sessions that still look busy (thinking, running tools/bash, subagents) but have had no message activity for 5+ minutes, so wedged sessions are visibly distinct from healthy ones.
- Added a secret-shape warning and confirmation step to `/share`, and write the gist export to a private temp file.
- Changed refinement persistence to write the rollback audit before harness state and refuse to overwrite a concurrent kernel write.
- Fixed the kernel reusing a dead MCP session forever after the server crashed, exited, or a call timed out; failed transports are now retired and the next call reconnects.
- Capped kernel MCP tool results at 64KiB, truncating and marking oversized payloads instead of letting them bloat the kernel namespace.
- Fixed `/mcp remove` leaking the removed server's kernel transport (stdio child) until kernel exit; removed and force-disabled servers are now reclaimed once the agent is idle.
- Fixed stall watchdog `touch()` resetting from the `aborting` state back to `armed`, which cancelled the settle timer and could restart the warn→abort cycle, contradicting the "no infinite abort loops" guarantee.
- Added a per-user Windows daemon pipe name and applied an owner-only DACL after listen; the DACL is best-effort, is not verified on Windows hardware, and is not a substitute for client authentication.
- Fixed CompactAssistantStreamReconstructor.observe() storing the message_start partial by reference instead of cloning it, causing reconstruct() to mutate the original event message in place.
- Anchored the WRITING_TOOL_PATTERN regex so the `patch` and `str_replace` alternatives match exact tool names only, preventing extension tools like `dispatch` or `my_str_replace_v2` from being misclassified as writing tools.
- Added actionable guidance to the stall watchdog warning message, directing users to interrupt the turn manually if a tool appears stuck and to check the daemon log for diagnostics.
- Made stall watchdog thresholds (warnAfterMs, abortAfterMs, enabled) accept getter functions so settings changes take effect without re-constructing the watchdog; the session now passes live getters instead of construction-time snapshot values.
- Changed the edit tool to write files atomically via a temp file plus rename and to re-check the abort signal before committing, so an abort during the write leaves the original file intact.
- Changed execCommand to kill the entire process group on abort and timeout and to bound stdout/stderr accumulation with annotated tail truncation.
- Fixed session fork and tree navigation so they cut at complete tool-call/result boundaries instead of leaving unpaired tool calls in the new branch context.
- Added a parent notification when a subagent turn ends in a terminal model/provider failure: the child session sends an agent_message with an error summary and an explicit terminal-state marker instead of parking silently in needs_input.
- Changed delivered terminal-error notices to count as a parent reply, which suppresses the misleading "completed without sending a reply" notice for the same run.
- Moved remaining hardcoded selector key checks into configurable app and TUI keybindings.
- Fixed kernel teardown leaving in-flight host requests (including admitted rlm.run children) running by threading an AbortSignal through host handlers and aborting it on shutdown, kill, dispose, and kernel exit ([#1253](https://github.com/PrimeIntellect-ai/prime-agent/issues/1253)).
- Added server-side daemon capability enforcement and control-plane authorization for shutdown, restart, and prepare_update_restart, keeping a legacy path for undeclared connections.
- Fixed private session file writes on Windows by degrading missing `O_NOFOLLOW` to 0 instead of throwing, while keeping lstat/fstat symlink checks.
- Isolated a kernel snapshot that failed to restore so a rebuilt namespace can persist again instead of leaving `restoreFailed` latched forever.
- Kept the prompt draft on the undo stack when clearing the input bar with Ctrl+C or Esc.
- Rebased stall-watchdog activity when auto-abort fires during a paused phase, matching the warn snooze so resume does not immediately re-warn and abort.
- Fixed daemon session creation after macOS timezone changes ([#879](https://github.com/PrimeIntellect-ai/prime-agent/issues/879))
- Fixed the stable installer failing under npm 12 when resolving verified release dependencies. ([Discussion #1988](https://github.com/PrimeIntellect-ai/prime-agent/discussions/1988))
- Added native callable tools for MCP servers supplied by ACP clients. ([#2002](https://github.com/PrimeIntellect-ai/prime-agent/pull/2002))
- Reworked agent-trace upload scheduling as a disk-cursor outbox: upload intent and per-session uploaded-content cursors persist as one small entry file per session under `agent-traces-outbox/` in the agent dir, a startup catch-up uploads anything a previous process never finished (pruning cursors of deleted session files), scheduled and catch-up uploads never re-send unchanged sessions (the explicit `/traces upload` command still force-uploads), and rate-limited uploads reschedule (honoring an advertised Retry-After) instead of sleeping. Session disposal and process exit no longer wait on trace uploads at all, and upload timers never keep the process alive; the exit drain barrier is gone (the startup catch-up replaces it).
- Fixed finished agents lingering in the agents view Running section as "classifying" when their status summary text did not change.
- Extracted the RLM spawn ledger's crash-safety mechanics (single O_APPEND writes with optional fsync, bounded fail-closed replay, torn-final-line tolerance, repair-on-append) into a shared append-only event-log substrate; ledger behavior and public API are unchanged.
- Fixed sessions with armed heartbeats showing as Running forever in the agents view; between firings they now list as Idle with the heartbeat badge and a `heartbeat · next <time>` label.
- Added a dimmed heartbeat badge for sessions whose only heartbeats are paused.
- Added an armed-heartbeat warning to the agents-view delete confirmation for sessions and subagents.
- Changed sessions with armed heartbeats to passivate like any idle session; the daemon now wakes them when the next heartbeat is due, including after a daemon restart.
- Fixed heartbeats of passivated sessions disappearing from the heartbeat list and agents-view badges.
- Added an ACP semantic-edges-v1 producer: each agent session appends an append-only `semantic-edges.jsonl` ledger beside its session artifacts, every provider turn and compaction summary call carries one opaque request ID on `X-ACP-Model-Request-ID` and `Idempotency-Key` (minted before the call, committed or failed when its stream resolves, and stable across retry attempts of the same call body), spawned subagents record their parent session and spawning request while successful children record their return, and `deriveSemanticEdges` folds a session tree's ledgers into commit-gated `continuation`/`subagent_call`/`subagent_return`/`compaction` edges matching the verifiers semantic-edges-v1 schema. Derivation only — nothing publishes or reads the ledger yet.
- Registered the per-session semantic-edge ledger with the agent-traces outbox as its own kind-tagged entry: durable upload intent at persist, an append-only byte cursor that never re-counts unchanged ledgers, startup catch-up counting, and pruning when a ledger is deleted with its session. No delivery endpoint exists yet, so pending ledgers are counted but never sent.
- Fixed the agents view undercounting running subagents: the "N subagents running" indicator now counts busy descendants at any depth, stays visible on collapsed groups, and idle sessions with busy subagents sort above plain idle sessions.
- Changed the agents view Running section to mean the session's own work: sessions whose only activity is delegated to subagents now list as Idle with the running-subagents badge.
- Daemon- and runtime-hosted subagents record their spawn lineage again (the production runtime factory dropped it), and a compaction summary slice that resolves after a sibling already failed the compaction settles as failed instead of staying in-flight forever.
- Added token and cost details to agents view rows: input/output tokens plus the session's own cost and its recursive total including all subagents; the message-count detail is gone.
- Fixed stopping or deleting an agent whose tree holds finished intermediate subagents: the walk no longer re-visits subtrees exponentially (which could freeze the worker on deep trees), and one cancel press reliably reaches every running descendant.
- Surfaced an RLM child whose final turn ended in an error (e.g. exhausted empty-response retries) to the parent as a child failure message instead of a bare completed-without-reply notice.
- Fixed an empty final model turn being silently abandoned instead of retried, and the chat keeping a thinking-only bubble for a discarded attempt that a resume would not show.
- Fixed a daemon crash that terminated all sessions when an extension handler rejected after an interrupt.
- Fixed the stall watchdog continuing to warn and abort turns after it was disabled mid-turn.
- Fixed the stall watchdog aborting a turn that was only waiting on an extension dialog.
- Fixed a wedged pause silencing stall protection indefinitely; escalation now resumes once the pause outlives its budget.
- Fixed a compaction cooldown silently ending turns without compacting, disclosing, or continuing, while still burning a continuation.
- Fixed a session deadlock when notifying a parent of a terminal error failed.
- Fixed stale subagent terminal reports pinning a session resident when nothing polled it, and being discarded by a mere read of its activity.
- Fixed /share scanning the wrong content for secrets, so secrets in tool definitions or export metadata are now caught before upload.
- Fixed empty-turn retries being amplified into up to 12 full-context requests.
- Improved kernel startup failure diagnostics so a kernel that dies before ready reports its own stderr instead of an empty tail.
- Reduced per-turn synchronous harness-state reads that ran on the session event queue.
- Reworked the per-session kernel stderr log to the host-relayed, budget-capped form (upstream #1947 final): the host relays pre-ready kernel stderr into `kernel-stderr.log` under a per-spawn write budget (file + `.old` stay near 5 MiB, one `[stderr log budget exhausted]` marker on overflow) while keeping the fork's 0600/`O_NOFOLLOW`/FIFO-refusal hardening, and the in-memory tail splits into separate kernel-byte and host-diagnostic rings so neither can crowd the other out of a failure report.
- Fixed an abort-listener leak in the shared sleep helper that accumulated listeners on long-lived signals.
- Fixed the worker recovery journal fsync-ing on every record and never compacting on a busy worker, which blocked the worker event loop and grew the journal without bound.
- Changed worker recovery appends to reach the disk through the page cache instead of a per-record fsync, so a machine-wide power loss can drop checkpoints written since the last compaction; a crashed worker or supervisor still recovers every record, and compaction still fsyncs before its atomic rename.
- Changed streaming tool-call argument change detection in the TUI to O(1) object identity instead of re-serializing the full arguments on every delta.
- Added `preserveThinking`, `enableSearch`, `searchStrategy`, and `forcedSearch` to the model compat schema.
- Changed the root agent's user-facing guidance to reply in the user's language, restate the goal before non-trivial work, decide instead of offering A/B options, ask only for irreversible or product-taste decisions, and lead every reply with the outcome; removed the simplified-technical-English default.
- Added the `kernelBootstrap.lockTimeoutMs` setting (default 300000 ms, `0` waits forever) with a session-free `readKernelBootstrapSettings` reader, so the bound on waiting for the shared kernel-venv bootstrap lock can be tuned per machine without a restart.
- Bounded and made cancellable the wait for the kernel venv bootstrap lock, which previously looped forever: it now fails with `KernelBootstrapLockTimeoutError` naming the holding pid, the lock directory, and both ways out, and a kernel start's abort signal reaches the lock wait and the `uv` installs it guards (cancelling a shared bootstrap only once every session waiting on it has aborted).
- Changed the kernel protocol handshake from an exact version match to a negotiated range (3-4): the host asks the kernel for protocol 4 through `PRIME_AGENT_KERNEL_PROTOCOL` (never overriding an explicit operator or per-kernel value), records the agreement as `kernelCapabilities` — where the `preserve_names` bit additionally requires the kernel to announce the capability in its ready frame — and keeps serving an older runtime that announces 3 instead of refusing to boot.
- Taught the kernel runtime to negotiate its protocol version from `PRIME_AGENT_KERNEL_PROTOCOL` (clamped to 3-4, defaulting to 3) and to report the agreed value plus any capability tokens in its ready frame, so a stale venv or an older host degrades instead of failing to start.
- Fixed the stall watchdog spending one exemption budget across unrelated phases: a long compaction no longer shortens the budget available to the next long-running command, and touches now re-check the exemption instead of keeping a stale one alive.
- Added an injectable kernel/host "vouch" exemption to the stall watchdog that defers only the auto-abort (the warning still fires, with copy saying the abort is deferred and how much budget is left) and caps the combined exemption at max(10x warn threshold, 30min), with a shorter budget when only liveness (not progress) evidence exists.
- Added stall watchdog copy builders, exemption/kernel diagnostics helpers, and the `stallWatchdog` settings shape (`toolLivenessExemption`, plus `treatKernelCpuProgressAsActivity` which is reserved and has no effect yet).
- Added a structured `abortCause` (silence, reasons, kernel pid) and a "the kernel may still be running this cell" hint to aborted ipython results, so the model reads a killed cell as partial evidence instead of re-running the same long command blind.
- Changed kernel bootstrap to build each runtime identity into its own versioned venv directory (`kernel-venv-<hash>`), so rebuilding after a runtime change no longer deletes the venv that other running kernels are using.
- Added garbage collection for kernel venv generations: a generation with no live kernel reference is reclaimed (one unreferenced copy is retained), and a generation that still has references is never renamed, rebuilt, or deleted.
- Added an explicit `venv rebuild deferred: N kernels in use` error for the rare rebuild of an in-use generation, replacing a silent `rm -rf` of a venv other sessions were running from.
- Added a one-time bootstrap note pointing at the pre-generation `~/.prime/agent/kernel-venv` directory, which is left untouched and can be removed to reclaim disk space.
- Changed a kernel whose in-use reference cannot be written to leave an `unverified-<pid>` tombstone in its venv generation instead of leaving no trace, so a rebuild defers rather than deleting a directory a running kernel is using, and added the `kernel venv in-use reference unavailable` warning that reports it.
- Fixed a partial kernel state restore permanently silencing snapshot writes: names that failed to revive are now remembered and carried over verbatim by later snapshots, so new work is persisted again instead of the session never writing to disk.
- Added session-log lines for skipped, failed, and preserving kernel state snapshots (`kernel state snapshot skipped`, `kernel state snapshot failed`, `kernel state snapshot preserved unrestored names`, `kernel state restore failed; snapshot isolated`), which previously only reached an in-memory ring buffer.
- Changed snapshot writes to stay paused after a partial restore when the kernel runtime does not announce the `preserve_names` capability, so an older runtime can never silently drop the unrestorable values.
- Changed the kernel venv readiness check to a superset test and its manifest write to a union of every skill installed so far, so sessions with different Python skill sets share one venv instead of rewriting the manifest back and forth and reinstalling on every boot; the manifest schema moves to 10, which costs each existing venv one rebuild.
- Raised the `vi.waitFor` budget in two ipython-provisioner tests (prewarm retry, gated-dispose snapshot skip) from the 1s default to 5s, so they no longer fail spuriously when the suite runs in parallel with other kernel-booting tests.
- Added the kernel runtime's snapshot `preserve_names` merge write: a snapshot request can name values that failed to revive, and their blobs are carried over verbatim from the payload on disk, so a session that restored only part of its state persists new work again instead of never writing to disk.
- Added the `preserve_names` capability token to the kernel `ready` frame (announced only from negotiated protocol 4), which is what the host gates the request field on.
- Changed a preserved name to keep its rebuilt live value when the namespace can serialize it again, so carrying a saved blob over never discards work the model did after a partial restore.
- Added `preserved` to the snapshot manifest and to the snapshot `done` frame, reporting the names actually carried over after any size-cap drop.
- Changed subagent terminal reporting so a child killed by the stall watchdog reaches its parent as a failure carrying the silence duration, the in-flight tools and the kernel reasons, instead of the misleading "completed without sending a reply".
- Added a `stalled` subagent activity plus stall facts (silentMs, thresholdMs, in-flight tools, unsettled) on child snapshots and daemon session rows, gated by the new `rlm_child_stall_activity` capability.
- Added the `stall_unsettled` session event so "the auto-abort fired but the run never settled" is reported and counted apart from an ordinary stall warning.
- Fixed the abort cascade to walk the whole subagent subtree, so a grandchild spawned by an already-settled child is cancelled together with the parent instead of running on where no kill path can reach it; subagents living in another worker process remain out of reach and are covered by the supervisor kill path.
- Changed agent messaging into a suspended session from a hard error into a queued delivery with a factual receipt (queued reason, queue position, repeat count and retry guidance), while the update-restart fence still refuses to wake.
- Changed queued subagent messages so they no longer start a new turn by themselves: failure notices wake the parent once per suspension as a single aggregated turn (`subagentWake.policy`: `never` | `failure_aggregated` | `always`, default `failure_aggregated`).
- Fixed session activity accounting so queued-but-unconsumed messages no longer pin an aborted session, and with it the whole worker, resident.
- Changed undeliverable subagent terminal notices to be written into the parent transcript and into a per-session sidecar that the next start reflows, instead of being dropped silently after five minutes, and added the `rlm_terminal_notice_abandoned` event.
- Fixed subagent reply accounting to count only delivered messages, so a queued reply can no longer suppress the parent's terminal notice and leave both sides silent.
- Added a retry ceiling to agent-message sends: after three consecutive retryable failures to the same target the error becomes terminal and states what to do instead of retrying.
- Fixed kernel state restore failures leaving no forensic trace: partial restores now log the unrestored names and snapshot policy, and the restore notice explains whether values were preserved on disk.
- Registered the stall watchdog exemption settings (`toolLivenessExemption`, default on, and `treatKernelCpuProgressAsActivity`, reserved with no effect yet) so the kernel-liveness vouch can be turned off per host without a code change.
- Taught the kernel runtime to send a protocol-4 liveness heartbeat: one out-of-band frame per interval (`KERNEL_HEARTBEAT_INTERVAL_MS`, default 5s) while a cell is in flight, carrying the event-loop tick, monotonic progress counters, and live `bash()` handle facts, so the host can tell a wedged kernel from one waiting on work it does not own. A session that negotiated protocol 3 sends none, and a value that cannot be serialized strictly drops that frame instead of tearing the protocol stream.
- Taught the host to read kernel heartbeat frames as liveness facts (`kernelLiveness`, plus `hostRequestCount`, `hostRequestOldestAgeMs`, `hasActiveExecution`, `kernelPid`, `isKernelBashRunning`): the two newest samples are retained for progress diffs, a malformed frame is rejected and counted with one log line per streak instead of killing the kernel, and a frame kind a kernel negotiated below still counts as protocol corruption.
- Changed the stall watchdog to defer its automatic abort while kernel and host facts vouch that externally owned work is in flight (a live `bash()` handle, an in-flight host request, a live kernel loop awaiting the cell), so a long `await bash(...)` or a streamed build is no longer killed at 15 minutes of silence. The warning still fires on schedule and now says the abort is deferred and how much exemption budget is left instead of promising a deadline that will not be kept; a kernel whose loop is provably frozen with nothing running externally is still aborted at the ordinary threshold. Set `stallWatchdog.toolLivenessExemption` to `false` to restore the old behaviour.
- Added the `exemption` and `kernel` segments to stall diagnostics (budget tier and remaining budget, negotiated protocol, heartbeat age, live bash handles, host request count, kernel pid, and reasons such as `loop_stalled` / `heartbeat_stale`), and a structured abort cause on aborted ipython cells so the model reads why the turn was killed.
- Registered two bounded downgrades that come with the exemption: a command that holds a live handle while producing nothing (an interactive client wedged on stdin) is rescued after the shorter liveness budget (20 minutes) rather than 15, and a wedged host request handler stops vouching once its request is older than 15 minutes. When the kernel heartbeat is stale or absent the host falls back to the journaled bash children of that kernel, read at most once per stall stage and trusted only for its own bounded lifetime.
- Closed the stall exemption budget against a fact source that blinks: exempt time accrued before a lapse the watchdog noticed on its own is carried into the resumed exemption, and a spent budget stays spent for the rest of the turn, so evidence that expires between two stall stages and is then re-read can no longer renew the cap forever. The degraded journal read's lifetime is anchored to the first read of a turn (a later read can only weaken it) and deliberately outlasts the budget it feeds, so the budget - not the evidence - is what ends the deferral.
- Changed the subagent roster to stop labelling a child "stalled" while the stall watchdog is excusing its silence (a host-owned phase, or kernel and host facts vouching that externally owned work is in flight): the row keeps its real activity, the agents view reads `long-running 12m` instead of `stalled 12m`, the red warning marker is withheld, and the stall facts still travel - with an `excused` flag and the exemption reasons - so the duration stays visible to an operator. An abort that did not settle is never excused.
- Changed daemon startup to adopt registered session workers in the background after the socket opens: one unadoptable worker now parks failed on its own instead of failing the whole start, `daemon_hello` reports how many workers are still being adopted, and the startup log lists every session that stayed down with its reason and the command that brings it back.
- Added a 300s bound to the worker requests a startup adoption or recovery makes, so a wedged worker can no longer hold startup or recovery for the 24h request budget.
- Added backoff re-adoption (30s, 2min, 10min) for a failed worker whose sessions still have a heartbeat or cron registration, so an unattended schedule does not silently stop after a restart.
- Added bounded retry to daemon client catch-up: a transient snapshot failure requeues the session and retries on a 250ms-8s backoff for up to 40 attempts (~5 min) before the client is told to re-pull the session, instead of leaving a silently incomplete view behind after one failure.
- Changed a failed client snapshot re-pull to degrade visibly and retry before it reports a terminal close, so one failed recovery no longer drops an unattended session offline.
- Added a log-only event-sequence gap detector to the daemon client (`daemon.eventGapRecovery`, default `"log"`), which records a hole inside one event generation without changing behaviour.
- Added supervisor process crash handlers: an uncaught exception is logged with its stack and exits, while an unhandled rejection is logged at a bounded rate, counted over an hour and published as `degraded` in `daemon_hello`, with an optional exit threshold (`daemon.supervisorRejectionExitThreshold`, default off).
- Changed supervisor recovery bookkeeping writes to be non-fatal: a descriptor write that fails is logged, marks the supervisor degraded, and lets the recovery continue instead of taking the daemon down.
- Added `kill` reachability across the worker lifecycle: killing a session whose worker is recovering, failed or stopped writes the stop tombstone, cancels in-flight recovery and reaps the process instead of failing with "Session worker is recovering".
- Changed `kill`, `abort` and `cancel_rlm_child` to answer `alreadyTerminal` for a target that existed and is gone, while a selector that never existed and every read command still fail.
- Added a failed-worker reaper: a failed registration whose process is provably gone, with no schedule and no attached client, is archived to the daemon log and removed after 24h (`daemon.failedWorkerReapHours`, `daemon.failedWorkerReapEnabled`), and it stands down while the supervisor is degraded.
- Changed the supervisor to warn about a worker descriptor it cannot parse instead of skipping it silently, and to log expected transient command failures (a recovering or stopping worker) at info without a stack.
- Added a transient-retry hint to daemon failure responses: a command the supervisor rejects because its worker is recovering or stopping now carries `retryAfterMs` (the supervisor's own recheck interval for that state), and a daemon client that sees the hint waits and re-issues the command inside its original budget, capped at 40 attempts inside 5 minutes. A daemon that does not send the field, or a client that does not read it, behaves exactly as before.
- Changed daemon request timeouts to raise a typed `DaemonRequestTimeoutError` carrying the command type, the budget, whether re-issuing is safe, and why the budget ran out, so a caller can act on a timeout instead of parsing a sentence. The user-visible message is unchanged.
- Changed the daemon connection to state its attach budget explicitly (the 30s snapshot budget, overridable via `attachTimeoutMs`) instead of inheriting the transport default.
- Bumped the daemon wire schema revision to 29 for the additive `retryAfterMs` failure field.
- Split the daemon's single 24h worker request budget into named tiers (24h for a user-explicit long command or a pure wait, 300s for adoption, 120s for one agent-message delivery attempt, 30s for an in-memory read) and made the supervisor pick a tier per command type, logging `worker request timed out` with the command and tier so a misassignment is visible.
- Changed a worker to declare its supervisor dead only after three consecutive 250ms connect probes fail, and to recheck on a 5s/10s/20s backoff capped at 60s, so one slow accept no longer makes every worker on the host race to launch a replacement.
- Raised the daemon connection's fast reconnect budget from 60s to a value derived from the recovery ladder it waits for (the 300s adoption budget plus a 30s margin), so a session that is still being adopted is not reported as a dead connection.
- Added a low-speed background retry (every 30s) after that budget is spent: the connection re-attaches and resyncs on its own when the daemon returns, reports `retrying in the background (attempt N)` while it tries, stops when the connection is disposed, and stops for good on a terminal answer such as `Unknown active session`.
- Changed update-restart preparation to stop waiting on an in-flight agent-message delivery: a long send no longer holds the mutation drain latch, so one wedged delivery cannot fail an 80s drain for every other session. Real mutations still gate the drain, and the exempt command's journal entry stays pending so a replayed command id answers "uncertain" instead of claiming it never happened.
- Changed an agent-message delivery the supervisor owns to be tracked in a bounded pending-delivery queue (100 per target session) instead of being an anonymous mutation: a target that is not reachable yet requeues the message and retries on the delivery tier until the 24h delivery budget runs out, so a recovering worker no longer fails the sender outright. Delivery semantics are unchanged — the first attempt still keeps the long budget, and a "queued" receipt still only ever comes from the target worker's own session queue.
- Added an explicit terminal receipt for a pending delivery the daemon abandons: a restart or shutdown drains the queue, answers every sender still waiting with "was not delivered" and why, and logs `deliver message dropped` for the ones nobody is waiting for. Nothing leaves the queue silently.
- Added an actionable rejection when a target session's pending deliveries are full (`deliver queue overflow`, retry hint included) instead of accepting a message the supervisor cannot schedule.
- Throttled the `deliver message requeued` log to one line per target session per 60s (the same window the client catch-up retry uses), carrying the number of swallowed lines on the next one, so a full queue retrying every 5s writes 20 lines a minute instead of 20 a second. The requeue counter stays exact.
- Changed a failed worker's persisted descriptor to carry the real failure reason (first line, capped at 200 characters) instead of a fixed placeholder, so the reaper's archive line — usually written after a restart, and the only on-disk evidence of an OOM-class accident — names a cause. A stack tail, where an environment dump would sit, is still dropped.
- Changed the receipt for a delivery the daemon abandons to say what is actually provable: a message whose request never reached a worker reports "was not delivered" and invites a re-send, while one that was already on the worker's socket reports "may already have been delivered" and warns against re-sending blindly. The matching log line carries `state undelivered|uncertain`.
- Disclosed the remaining duplicate-delivery window: a sender's own ~30s budget can expire while the supervisor keeps trying for the full delivery budget, so a model that re-sends on that timeout can duplicate a message that later lands. Closing it needs a sender-supplied delivery key (batch 2 / P1-2); this change registers it as an acceptance dependency on that batch rather than papering over it.
- Added a circuit breaker to the daemon client's event-gap recovery (F9): after three consecutive gap-triggered re-pulls that did not close the hole, or three inside ten minutes, the connection falls back to log-only for the rest of its life and writes `event gap recovery circuit OPEN` with the reason, so a real gap cannot drive an endless re-pull storm. The shipped default stays log-only (`daemon.eventGapRecovery = "log"`); `docs/fork/ma-p0-5c-recover-switch-archive.md` is the gate for ever flipping it.
- Added read-only gap-detector diagnostics (`eventGapDiagnostics`) reporting the configured mode, the effective mode, detections, suppressions and the breaker state.
- Added structured kernel death attribution: an unexpected kernel exit is classified (`oom_suspect` only with memory evidence, otherwise `unknown`), reported to the session log, and tagged apart from the host's own kills (shutdown, kill, dispose, and the protocol-repair family), so a self-repair never reads as a crash.
- Changed an unexpected kernel death to revive the session instead of bricking it: the next cell runs on a replacement kernel with the last snapshot restored, and its result head carries a reset notice naming the rollback point, the names that did not come back, the host requests whose replies were lost, and the side effects that were *not* rolled back.
- Added a kernel restart budget (`kernelRestart.maxUnexpectedRestarts`, default 3 per rolling `kernelRestart.windowMinutes`) that fails a crash-looping session closed with `KernelUnavailableError` carrying the death chain, and re-arms itself when the window expires.
- Added `kernelRestart.revivalVouchMaxAgeSeconds` (default 600) bounding how long one kernel revival may defer the stall watchdog's abort.
- Fixed a state restore that exceeds its budget to retry with a longer window instead of renaming a good snapshot aside as corrupt; a timed-out restore keeps snapshot writes paused and says so in the reset notice.
- Changed in-flight kernel host requests to survive an unexpected kernel death, so work the host already admitted (an `rlm()` child, a message delivery) is not cancelled by a crash; a real teardown still cancels them.
- Changed unattributed kernel output to stay with the cell the model sees instead of being drained by host-internal cells (snapshot, restore, bootstrap).
- Added bounds to the four waits an agent message can park on (passivation 120s, bind/hydrate/publication 60s, one `agentMessage.targetWaitSeconds` setting driving all four), each returning a retryable error that names the phase, the target and `waitedMs` instead of hanging for as long as the caller's request lives; the waited-on operation is never cancelled.
- Added a mechanical ceiling to subagent hydration re-entries (32 attempts and a 60s total deadline, deliberately unrelated to `RLM_MAX_DEPTH`), so a hydration loop ends in a retryable error instead of recursing.
- Added a read-only whitelist for kernel host requests (`rlm.find_models`, `rlm.list_subagents`, `agent_observe.*`, `model.info`, `agent_message.list_agents`): only these are cancelled when the cell that triggered them is aborted, and only they get a 60s bound. Side-effecting requests - `rlm.run`, `agent_message.send`, harness and goal mutations - keep the teardown-only signal, so Esc on a spawning cell no longer risks killing a child the model was told would outlive the turn.
- Changed a host reply that arrives after its kernel is gone to be reported instead of dropped: the runtime ships it as unattributed stderr (visible on the next cell), and the host logs `late kernel host reply` with the request type and whether a child of that name is already registered.
- Added sender-minted message ids to `agent_message.send` with receiver-side exactly-once delivery (1024 remembered ids): a repeated call after a receipt is suppressed with a receipt saying the first send is the one that counted, a repeated call whose first attempt *failed after the message was handed to the delivery leg* is refused outright until the sender checks with the recipient, and two deliberate sends of the same text still both arrive.
- Changed the "agent name is unavailable" error to say which case it is: a reservation from this session's own in-flight admission points at `rlm.list_subagents()` and the handle that is about to exist, while a name another agent holds points at listing or renaming.
- Added settings documentation for the multi-agent stability round's remaining keys: `kernelBootstrap.lockTimeoutMs`, `subagentWake.policy`, and the daemon supervisor keys (`daemon.eventGapRecovery`, `daemon.supervisorRejectionExitThreshold`, `daemon.failedWorkerReapHours`, `daemon.failedWorkerReapEnabled`).
- Added `docs/fork/ma-multistability-ops.md`, an operations manual for the multi-agent stability round: observable log signatures with expected baselines, per-feature rollback levers, the deployment-day checklist (disk precheck, build/venv generation changeover, legacy venv cleanup, `test:kernel`), and the known flaky/pre-existing-red lists.
- Recorded the round in `FORK_NOTES.md` (batch-by-batch summary, registered capability downgrades, the three parallel-construction incidents, final-review outcome, open items) and added the shared-worktree construction discipline plus the `test-hygiene-allow` exemption format to `AGENTS.md`.
- Added `spentThisCycle` to the stall watchdog's exemption diagnostics and a read-only `exemptionBudgetSpent` accessor, so a kill after a spent exemption budget stays attributable in session logs and post-mortems even once the exemption segment itself is gone.
- Fixed the spent-budget latch to be set by any sample that observes the cap reached, including an activity touch: previously only a timer fire latched it, so a touch landing during a blink of the vouch source could drop the exhausted segment unread and let the next event rebase the escalation of a turn that had already used up its exemption.
- Clarified the exemption budget docs and comments: observed activity releases an *unspent* budget only, and a cap seen spent in an arm cycle is never un-spent by a later event.
- Fixed orphan-process pid-reuse detection on non-UTC hosts: the `ps` lstart stamp is rendered with `TZ=UTC` but was parsed as local time, so hosts west of UTC judged every journaled pid "reused" and never reaped orphans; the stamp is now parsed as UTC.
- Fixed private files created under restrictive umasks ending up mode 000 (bricking `auth.json` and session stores): `ensurePrivateFile`, `writePrivateFileAtomic`, `writePrivateFileAtomicLines`, and private-directory creation now enforce the exact 0600/0700 bits after creation.
- Made the auto-refine probe cost test environment-independent: it no longer depends on construction-time cache priming (RLM_DEPTH) and isolates PRIME_AGENT_CODING_AGENT_DIR from the machine's real harness store.
- Fixed `/refine` dropping an entire refinement when the model's JSON held a raw control character such as a literal newline inside a string; those replies are now escaped, applied, and announced with a warning carrying the candidate's sha256.
- Added `~/.prime/agent/harness/refinement-failures.jsonl`, which preserves the raw model output (timestamp, source, reason, error, sha256, and the reply bounded to 8KiB) whenever a refinement or auto-refine review reply cannot be parsed or was cut off by an exhausted output budget.
- Fixed daemon session workers crashing when a hosted extension touched `ctx.ui.theme` (the theme was never initialized in the worker process); workers now initialize the settings theme headlessly at startup, without a theme file watcher.
- Fixed active goals stalling after manual compaction.
- Reconciled durable worker error records: a failed worker's first-line failure reason now survives restarts for forensics, while key-shaped secrets are still never persisted.
- Fixed HTML exports (and other user-chosen output paths) failing under symlinked parent directories such as macOS /tmp: privateParent:false no longer runs the strict no-symlink walk on ancestors, while the exported file itself keeps O_NOFOLLOW, 0600, and atomic-rename protections.
- Fixed the Windows harness-proxy test erroring on POSIX: the sentinel Path is now created before os.name is patched, since instantiating a WindowsPath on POSIX raises.
- Removed `tools.bashTimeoutSeconds`: the setting was documented but never wired to any caller on the RLM line (the classic bash tool is SDK-only), so editing it did nothing. SDK consumers can pass `defaultTimeoutSeconds` to `createBashToolDefinition` directly.
- Fixed automatic compaction and recovery for LiteLLM maximum-context rejections.
- Fixed prompt templates altering literal dollar sequences and expanding placeholders inside user arguments.
- Added subcommand autocomplete to /traces, suggesting status, on, off, preview, upload, upload-current, upload-all, and login after the command.
- Fixed assistant Markdown file links to open relative to the session's working directory, including Windows drive paths ([#2108](https://github.com/PrimeIntellect-ai/prime-agent/issues/2108)).
- Changed agents-view row usage to aligned `↑in ↓out · $agent · #sub · $total · age` columns with an explicit total-subagent count; empty sessions show only their age.
- Added a bold usage legend and session count to every agents-view section header, sharing one column layout with the rows.
- Changed empty sessions to sort last within their agents-view section, except the session the view was entered from.
- Fixed Amazon Bedrock requests failing to load the provider in packaged CLI installations.
- Fixed Bedrock provider failures losing structured error severity and worker context in the shared CLI log.
- Fixed RPC mode dropping the request id from unknown-command errors, which left clients waiting for their response timeout instead of failing immediately.
- Added ACP forwarding of extension failures to the client as a `session_info_update` carrying `extensionError` metadata, so extension errors are diagnosable outside RPC and interactive mode.
- Fixed HTML export attribute-injection (session content could break out of attributes) and `$`-pattern corruption of embedded assets (missing `$` on cost display, broken hljs grammars).
- Fixed split-turn compaction dropping the previous summary, and zero-reduction compaction clearing the cooldown loop.
- Fixed orphan-process reaping on non-UTC hosts (kernel-side ps start-id now pins TZ=UTC/LC_ALL=C, matching the host side).
- Fixed first-dispatch timeout tiers being eaten by pre-dispatch bounces, and per-bounce reaction accumulation on the delivery abort promise.
- emitContext no longer deep-clones the whole message history when no handler is registered; streamStallTimeoutMs now propagates to child and side-question agents.
- Fixed kitty key-release double-fire (PageUp scrolling twice), RPC unknown-command errors missing the request id, and ACP sessions silently swallowing extension errors.
- MCP OAuth callbacks now validate state before settling; MCP calls and session opens have bounded timeouts instead of hanging for minutes.
- Fixed Bedrock 1h cache-write mispricing; cron store no longer re-reads everything per mutation and prunes terminal jobs; agents view reconcile is coalesced instead of O(N^2); autonomous gate snapshots are captured lazily; legacy session migration now converges; stdin paste and inline transcript normalization no longer quadratic.
- Added structured warnings when a cron store lock wait is exhausted and when a scheduled tick fails, so a dropped tick or a contended store file is diagnosable from the agent log.
- Added `rlm.collect`, a typed non-steering fan-in for subagent results: it waits for direct children with a bounded timeout and returns one envelope per child (status, settled, answer preview, error, duration, tool count) without growing the parent's message queue. Ported from upstream PR #2223.
- Added `terminal_kind` and `stall_abort` to the collect envelope, so a child the stall watchdog killed is distinguishable from one that finished without replying - both report `status: "done"`.
- Made a collect wait cancellable with its cell and capped inside the kernel's read-only host-request bound, so it returns current snapshots instead of a timeout error and cancels no child.
- Documented `rlm.collect` in the subagent prompt guidance and the RLM runtime, RLM, long-running-agent, and usage docs.
- Fixed a session worker wedging at 100% CPU: waiting for a session to go idle while queued input was blocked by a running bash command, compaction, or retry spun in microtasks without ever yielding to IO, freezing every session in the worker and starving daemon IPC.
- Fixed a kernel pipe write error (write EPIPE) crashing the whole session worker: pipe errors on the kernel stdin and stdout are now recorded as kernel diagnostics while the pending write rejects cleanly.
- Fixed the Python kernel and its bootstrap probes importing `rlm`, `dill`, or stdlib modules from the project directory; the kernel now launches with `python -P`, so a checkout can no longer shadow runtime imports (project modules are not on the kernel's `sys.path`).
- Changed `prime-agent update` on a build from this fork to refuse the official package install (which would discard the fork's changes) and print the fork's own update steps instead; `--allow-official` still takes the official path, and extension updates are unaffected.
- Added `PRIME_AGENT_FORK_GATE=off` to switch the fork self-update gate off, so suites running inside this checkout can exercise the official update path.
- Fixed headless Python cancellation leaving an unresponsive kernel running: after the interrupt grace period the kernel is now killed (tagged as an intentional exit, so it is not reported as a crash), and the next cell provisions a replacement and says that live state was lost.
- Fixed the cancellation diagnostic ignoring the configured output limit, so an aborted cell's stderr can no longer exceed `maxOutputChars` without the truncation notice.
- Changed the interactive wait/kill choice to stay interactive: with a UI the kernel is still preserved for the user to decide, and a headless run now kills instead of only failing the cell.
- Fixed OSC 133 zone markers accumulating on memoized render arrays every frame (unbounded string growth and full-viewport repaints in inline mode).
- Made border/text leaf components render-cache compliant so the transcript stops rebuilding every frame in fullscreen mode.
- Throttled per-chunk JSON re-parse of streaming tool-call arguments in the providers that re-parsed per chunk (anthropic, openai-completions, bedrock, openai-responses; mistral is unchanged), and encoded OpenRouter reasoning details once at stream end instead of per chunk.
- Kernel: skip unchanged namespace re-serialization between turns and coalesce stream frames, while the terminal snapshot at shutdown always writes through; roster publishing is now incremental instead of a full rebuild per session event.
- Reduced journal syscall storms: process-start identity is captured asynchronously (no synchronous ps per spawn on macOS), per-record chmods dropped, and command journals compact on size thresholds instead of after every ack.
- TUI: bang-command output appends tails instead of re-deriving everything per chunk; bash streaming preview styles only the visible tail window.
- Cold interactive start now prefires the daemon create RPC concurrently with client-side prepare.
- Fixed a models.json that supplies only a provider `apiKey` being rejected and silently discarding the entire custom-models file.
- Changed `!command` credential resolution (keychain, password manager) for models.json API keys and headers to run asynchronously so it no longer blocks the daemon event loop on every request.
- Fixed stale tool-call arguments persisting into history when a provider stream errors mid-tool-call (final parse now runs on error paths in all provider families).
- Kernel snapshot blob cache is now aggregate-bounded; orphan start-id enrichment is flushed on shutdown; a diagnostics-error startup exit no longer stalls on the prefired daemon create.
- Fixed v1 session migration never recording ids (duplicate ids could persist a parentId cycle and hang loads); damaged-header salvage now migrates pre-v2 bodies instead of persisting id-less entries under a current-version header.
- Fixed an unreadable lease owner.json being mistaken for an absent one and reclaimed, which could take over a lease its owner still holds; acquire now fails closed while the record stays unreadable.
- Changed lease owner records to be written atomically (temp file, fsync, rename, directory fsync) so a crash can no longer publish a torn record; torn or undecodable records stay reclaimable as before.
- A restore interrupted by host teardown no longer isolates a healthy snapshot as corrupt.
- Pending deliveries from a disconnected sender are aborted so they stop poisoning per-target capacity; adoption retry budget resets after a successful adoption.
- Turn-liveness now honors cell progress (not just bash progress) for the longer vouch tier; compaction controllers use identity-guarded clears; quiescence waiters clean up on settle.
- models.json providers with only an apiKey are no longer silently discarded; per-request credential shell-outs run off the event loop.
- Fixed a false "RLM child ... completed without sending a reply" alarm for a child whose reply was queued behind a busy parent and then delivered: the receiving session now credits that reply to its sender when it actually lands, exactly once, while a reply that is never delivered still reports as before.
- Fixed the intermittent 1-5 second stall when opening the agents view or entering a session: session list metadata now survives a daemon or worker restart, so a freshly spawned process no longer re-reads every subagent transcript from disk.
- Changed the saved-session catalog, passive-descendant and spawn-ledger scans to read independent transcripts concurrently instead of one at a time.
- Fixed Enter doing nothing in the agents view when a saved-catalog refresh had stalled: an unresolved restored selection stops blocking the key two seconds after the catalog last made progress, instead of for as long as the refresh lives.
- Removed the cached session-list summary of a session when that session is deleted, along with the summaries of the descendants its artifact directory takes with it.
- Changed the agents view animation tick to refresh age labels in place instead of rebuilding the whole row set four times a second.
- Fixed the stall watchdog aborting healthy long-running tools once the exemption budget ran out: the budget now charges only silence the kernel's reported movement does not explain, so a job that keeps producing survives while a wedged one is still killed inside its budget.
- Added `settledByMovementMs` to the stall exemption diagnostics, recording how much exempt silence a job's own movement paid for.
- Fixed killing a child session on a failed worker whose process is still alive: it stopped the whole session tree and answered `alreadyTerminal`, and now reports the worker's real state with the root kill that would stop the tree instead. An already-terminal answer for a child kill now requires the tree's process to be provably gone.
- Changed idle and last-detach eviction to count an agent-message delivery in flight as work, so a tree is skipped for that round instead of being stopped mid-delivery.
- Added an explicit receipt for a delivery a worker stop overtakes: every pending delivery aimed at a stopping tree is answered "not delivered", or "may already have been delivered" once a dispatch was written, instead of failing with a bare transport error.
- Fixed a pending delivery whose target worker was stopped, evicted or reaped retrying until its 24h budget ran out; it now ends with an explicit "not delivered" receipt.
- Fixed a client catch-up the supervisor gave up on staying queued, so a later event no longer reopens a full retry budget and re-notifies the client about a failure that does not heal by waiting.
- Fixed the kernel restart budget being forgotten whenever a failed startup replaced the kernel manager: the ledger now lives with the provisioner that replaces managers, so a kernel that dies before it is ready counts like any other death and the session fails closed with the death chain (`KernelUnavailableError`) on the fourth one instead of respawning a doomed kernel on every cell.
- Fixed a healthy kernel being reported as protocol corruption and killed when its `ready` frame and its first heartbeat arrived in the same stdout chunk, which is what a host whose event loop stalls across one heartbeat interval reads.
- Added the kernel's post-run finishing phase to the stall watchdog's liveness facts: a heartbeat sent while the runtime is computing a huge `repr` or draining output now names its cell and marks the phase, so the frozen event-loop tick that phase causes by design is excused as existence-level liveness instead of being read as a deadlocked cell.
- Changed Python skill readiness in the kernel venv to a path-independent content fingerprint (`pyproject.toml` plus `src/**`, excluding `__pycache__`), so checkouts of the same commit share one editable install instead of reinstalling the whole skill set under the machine-wide bootstrap lock on every alternating boot; a recorded install whose checkout was deleted or edited underneath the record still costs exactly one reinstall.
- Fixed the kernel venv skill sync swapping an editable install under a running kernel: a generation with live in-use references (or an unreadable reference state) keeps the installed copy, reports why, and retries on a later boot, matching the invariant that already covered full rebuilds.
- Fixed a throwing host callback on the kernel's output stream (a UI stream update or a late agent-message handler) crashing the whole daemon worker: the failure is now contained, counted and logged, and the cell keeps the output it had already produced.
- Fixed a restart-budget or read-only-timeout setting that throws taking the worker down with it; the kernel now falls back to its defaults and logs the failure.
- Fixed one kernel bootstrap deleting the Python generation directory another boot was about to start its kernel from: a boot now claims the generation until the spawned kernel's own in-use reference takes over.
- Fixed a host-request reply that only became ready after a kernel revival being written into the replacement kernel's stdin; it is now reported as an undeliverable late reply instead.
- Fixed the /share secret preflight scanning the base64-encoded export instead of the session it carries, so a session holding credentials now warns before it is uploaded.
- Added a PEM private key shape to the /share secret preflight.
- Fixed /share hanging forever when the `gh gist create` spawn fails, and bounded an upload that stops reporting anything.
- Changed the bash and tool-output full-output temp files to owner-only 0600 instead of world-readable 0644.
- Fixed a killed or truncated bash command dropping the trailing bytes of an unfinished multi-byte character from its output.
- Fixed one session's corrupt scheduled-jobs file silencing every cron job and heartbeat in the process; the file is now quarantined, reported once, and healed by the next write.
- Fixed the cron scheduler staying disarmed after a store read failure; it re-arms on a bounded retry instead.
- Bounded skill, prompt, theme and package discovery walks against directory symlink cycles and unbounded depth, and reported skipped directories instead of silently truncating discovery.
- Changed failed `!command` credential resolutions to expire after 30 seconds instead of being cached for the life of the process.
- Fixed Escape and Ctrl+C leaking unhandled promise rejections when the daemon rejects one of the best-effort abort commands.
- Fixed a retry countdown, retry loader or compaction loader surviving session replacement and teardown.
- Unref'd the retry countdown interval so a countdown from a gone session cannot hold the process open.
- Fixed `/import` overwriting a registered session file when the imported file shared its basename: a different transcript now lands on a free sibling name with its own session id, and re-importing byte-identical content reuses the file that is already registered.
- Fixed a failed `/new`, `/fork`, `/import` or session switch leaving the runtime pointing at the already-disposed previous session, so every later prompt died with "session is disposing or disposed"; the previous session is now rebuilt and the host re-points at it.
- Fixed a `!command` result recorded while the agent was streaming being dropped from the transcript when the session ended before the next turn.
- Fixed `/usage`, `/context` and `compact.status` reporting context usage as unknown after a compaction when the newest assistant response carried no readable token counts, while auto-compaction still had a usage source to read.
- Fixed a session-input admission failure while a threshold compaction queued its autonomous continuation ending the turn with an unrelated "Cannot admit a session action" error and leaving the never-admitted continuation on the books.
- Added compaction to the orphan-process journal (4096 records / 4MB, matching the two sibling recovery journals) and capped how much of it the degraded stall check parses, so a long-lived session worker no longer grows that file without bound.
- Changed agent-message delivery to report "was not delivered" only when no byte reached the worker's socket: a transport that was already gone is retried instead of being receipted as "may already have been delivered, do not re-send".
- Fixed a worker registration that kept claiming a ready transport after its socket was closed, which made deliveries in that window fail without writing anything.
- Added expiry and an active-entry bound to the daemon's command-recovery journal, so commands whose acknowledgement never arrived stop accumulating (and stop forcing a full journal rewrite per command) for the life of the daemon.
- Made the supervisor's durable state writes fsync before renaming, so a machine crash can no longer leave a torn worker descriptor or startup fence behind.
- Added quarantine for an unreadable worker descriptor or startup fence: it is renamed aside and reported instead of being re-parsed on every start, and a corrupt fence no longer keeps that socket's daemon from ever starting again.
- Removed the supervisor's private copy of the process-identity query in favour of the bounded one, so a wedged `ps` can no longer stall the failed-worker reaper for the rest of the process's life.
- Gave the background wait on a worker that survives SIGKILL a 10-minute terminal with a log line, instead of polling it every 250ms forever.
- Bounded the daemon's jsonl command readers (64MB per line) and filtered unknown client capabilities, so one connection can no longer grow the supervisor's heap without limit.
- Stopped a prompt admission refused by the capability gate from leaking, and released a disconnected client's leftover admissions, so a closed connection no longer stays pinned in memory.
- Reclaimed the snapshot-cache directories and dead supervisor-owner registrations previous runs left behind at startup.
- Kept a session worker probing for its supervisor until the supervisor has actually authenticated, so a supervisor that dies during adoption is still replaced.
- Bounded and made visible the session-status summarizer's retries: a failing summary model now backs off per session, gives up after six attempts until the next turn, logs it, and no longer persists a fabricated "needs input" verdict.
- Refused an empty or broadcast `send_message` target on the supervisor side, matching the worker side, instead of silently retargeting the only saved session.
- Made one malformed roster frame cost a log line and a repair pull instead of tearing down the supervisor-to-worker connection.
- Reported the RLM spawn ledger's path and sessions directory when a ledger line is malformed, so the file that needs attention can be found.
- Fixed auto-compaction failing with a provider "input length" 400 on large contexts: the summarization request now pays for its system prompt, prompt wrapper, the provider's measured input limit and a safety margin instead of spending the whole context window on the conversation.
- Changed compaction to convert its input budget with the provider's own token count, so transcripts the chars/4 estimator reads low (CJK- and code-heavy sessions) no longer overflow the summarization request.
- Added a bounded shrink-and-retry when a provider rejects the summarization request for input length, so a session above its compaction threshold recovers instead of failing the same way every turn; when the rejection states the provider's cap, the retry budgets against that exact number.
- Added recovery options to the compaction failure notice after three consecutive failures: `/compact <instructions>`, `/tree` or `/fork`, `/model`, `/new`, and the `compaction.reserveTokens` setting.
- Added a machine-generated fact appendix to compaction summaries: commit SHAs, file paths, threshold numbers, error signatures and issue references are extracted from the transcript by regex and appended verbatim, so they survive compaction exactly instead of being restated by the model (measured loss before this: 96-97% of hard facts, and one SHA per session rewritten with a digit added).
- Added a `<user-requests>` block that carries the user's own messages and `!commands` verbatim into the compacted context, oldest first, so one-off instructions and reported problems are no longer the largest casualty of a summary.
- Changed compaction to strip those machine blocks out of the previous summary before sending it back to the model, and to carry them forward structurally, so they neither decay across generations nor cost summarization budget.
- Changed tool-result truncation in summarization input to keep the first 2000 and the last 500 characters instead of the first 2000 only, so the failure list a test runner prints last reaches the summarizer.
- Changed the compaction cut point to move back to the start of its turn when that fits the keep budget, so the retained context begins with the request it is answering instead of a lossy summary of it.
- Added `--with-bundled-skills` to the kernel venv seeding CLI (`bootstrap-cli.ts`), so a venv seeded for CI also carries the bundled Python skills a pinned `PRIME_AGENT_KERNEL_PYTHON` cannot sync later.
- Added `npm run test:kernel:ci`, which writes a vitest JSON report for the kernel-heavy suite and fails when a file skipped instead of running or the collected total drops below a floor.
- Changed `npm run test:ci` to exclude `test/suite/regressions/4603-worker-recovery.test.ts`, and added `npm run test:machine-wide` to run it alone: that suite drives `status`, `doctor --fix` and `shutdown --force`, which discover every prime-agent daemon on the host (not just their own socket), so running it inside a sharded suite stopped other test files' supervisors - and on a workstation it stops the developer's live daemon.
- Fixed false "completed without sending a reply" notices for subagents that answered a busy parent: the verdict is still recorded when the run settles, but the notice is re-validated when it is published, so a reply the parent has already read suppresses it.
- Fixed a duplicate failure report when a subagent's own terminal-error notice reached a busy parent after the parent classified the same run, including the aggregated wake an Esc leaves behind.
- Fixed a silently lost reply credit when a session restart re-flowed a queued subagent reply, and reflowed replies now land ahead of the notices they disprove.
- Added `no_reply_notice_superseded` to `rlm.collect` results, so a no-reply verdict whose notice was withheld can be reconciled instead of guessed at.
- Changed the no-reply notice to label the quoted assistant text as text the child never sent.
- Fixed compaction machine blocks ending early when the user text or an error signature they carry quoted a block delimiter, which silently dropped the rest of the block from the next generation and left block JSON in the text sent back to the summarizer. Record lines now JSON-escape `<`, and a damaged block reports itself instead of parsing back short.
- Fixed bash output whose last line exceeded the byte budget and ended with a newline being replaced by an empty string: the model saw "(no output)" and the `!` command panel showed only a temp-file path while the full log sat on disk.
- Fixed long sessions spending minutes of CPU republishing their roster: the per-session usage summary is now folded incrementally instead of re-walking the whole transcript on every event.
- Fixed long child runs spending minutes of CPU: the parent entry a child's usage is attributed to is resolved once per run instead of re-scanning the whole transcript for every assistant message the child emits.
- Changed refinement results to reach the model as a system receipt in the conversation, so the model can see which harness entries a refinement wrote and why a refused edit was rejected, while refinements that recorded nothing stay out of context.
- Fixed compaction machine blocks being forgeable: a file path (or any text that reached the document) could write a whole `<user-requests>`/`<fact-appendix>` block ahead of the real one and replace the ledger, a narrative that merely named a tag could swallow the real block's attributes and the rest of the narrative, and a forged `generation="99"` could raise the generation counter for good. Blocks are now anchored at the end of the document with a strict tag shape, the file lists render through the same block renderer with a render-time delimiter guard, and the generation counter reads the entry details instead of the text. A hook-authored summary is no longer read back as a ledger source.
- Fixed streaming sending the whole accumulated content on every delta: a 20k-character answer put ~109MB on the wire and a 100k-character answer ~2.6GB. Clients now accumulate compact deltas on the direct path too, and tool-call arguments travel as fragments (new `streaming_delta_fragments` capability, schema revision 30; both directions degrade to the previous wire when it is absent).
- Fixed the event log tail repair deleting a concurrent writer's complete record, which silently dropped RLM child spawn, rename, and delete entries.
- Fixed the kernel snapshot lagging behind an errored cell: a cell that changed the namespace and then raised (or was interrupted) now refreshes the saved state instead of leaving the snapshot at the last successful cell.
- Fixed the kernel revival notices claiming the snapshot was "written up to about 1.5s before the death" regardless of its real age; the reset notice now reports the measured write age, or says it cannot tell.
- Fixed names the snapshot could not serialize (a generator, an open socket, an oversized value) disappearing without a word: both the reset notice and the resume notice now name them with the reason, and the write-side drop is logged.
- Fixed a scheduled-job pause, resume, or stop being dropped, and reported as applied, when the local clock lags the stored copy.
- Fixed settings and credential writes hanging the process when the system clock steps backwards during a file-lock retry.
- Fixed a session-tree rewind being undone by a restart: the rewind position is now recorded in the transcript, so `--resume` returns to the point you rewound to instead of the branch tip you left.
- Fixed two ways a stale build could be used silently: a source checkout now prefers the live `prime-agent-runtime` sources over the bundled copy (so editing the Python runtime rebuilds the kernel venv, while a bundled install keeps preferring its bundle, and a source build that cannot be produced falls back to the bundle with a notice), and the daemon reuse decision now compares the build identity - a newer CLI replaces a daemon running a different build, and a mismatch it cannot act on is reported instead of being ignored.
- Fixed kernel bootstrap reporting "ready" for a venv it never verified: readiness is re-checked after the build and a gap names what is missing, the venv directory and the next step.
- Fixed kernel cell output that landed exactly on the per-cell output cap being dropped silently instead of being reported as truncated
- Fixed `/logout` leaving a redeemble copy of the credential behind: the startup migration no longer renames the legacy `oauth.json` into a world-readable `oauth.json.migrated`, every historical credential-store copy is deleted (or kept at 0600 when it is the only copy left), and logout now reports failure instead of success when a copy cannot be removed or still holds the value.
- Fixed /share letting real credentials into a shared document: the precheck now recognizes current key shapes, name-driven assignments, anchored high-entropy strings and the values this process has actually loaded, and reports a masked hit that has to be confirmed before sharing.
- Fixed the daemon shutdown admission lease so a holder whose lease lapses while the event loop is blocked (a `ps`/`lsof` fork, a machine sleep) renews or re-acquires it instead of failing the shutdown with `admission was lost`, and a waiter whose holder's lease lapses now waits or is refused loudly instead of stealing the ticket.
- Fixed the daemon catalog's session-transcript appends to take the session lease and repair a torn trailing line before appending, so an archived status or worker-recovery note is no longer glued onto an unparsable tail and silently lost.
- Added tool-name conflict diagnostics: when an extension or SDK tool shadows a built-in tool, or two sources register the same tool name, the session now names both sources, says which one is reachable, and suggests a free name instead of silently letting one tool win.
- Fixed compaction reading no user-request or fact ledger at all when anything follows the machine blocks, recovering the block from its last matching tags and warning instead of losing it silently.
- Fixed a client that attaches mid tool call in fragments mode seeing empty tool arguments, by seeding the argument accumulator with what the stream had already parsed.
- Fixed the synchronous lock backoff on hosts that refuse `Atomics.wait`, which returned almost immediately instead of waiting its delay.
- Added session logging for a provider that reuses tool-call ids: the per-call rewrite (original id, tool name, replacement) is written to the session log, so a repaired id is never silent in the transcript.
- Fixed session list message counts and token totals drifting for sessions that keep appending, by counting bytes buffered across read chunks when recording the scan resume offset and refusing scan state that cannot account for the bytes it read.
- Added `retention.*` settings and a disk-retention sweep (`prime-agent retention status|sweep [--dry-run]`, plus a periodic daemon sweep) that reclaims resources no live session references: deleted sessions' artifact leftovers, unreferenced kernel venv and kernel snapshot generations, log files whose socket is gone, empty `prime-agent-rlm-*` temp directories, `pi-bash` temp files, and stale session leases. Each sweep is bounded by a 512 MiB / 20000 entry circuit breaker, `retention.enabled=false` reports without deleting, every skip is reported with a fixed reason, and reclaiming kernel snapshot generations or retired venv generations is off by default because those bytes ride live references.

- Fixed `prime-agent retention sweep --dry-run` unlinking stale kernel-venv in-use reference files while it read them: the verdict is unchanged, but the unlink is now gated on a real sweep, so a dry run leaves the filesystem exactly as it found it.

- Fixed a deleted session's artifact directory being recreated by read paths (`getSessionArtifactDir()` no longer creates by default; writers call `ensureSessionArtifactDir()`), which also kept that session's cron-job registration alive for the life of the daemon. Deletions now record a tombstone that the cron store and the sweep read instead of guessing from the directory's absence.
- Fixed the event-log tail repair blanking a record a live writer was still appending: a torn tail is blanked only after it stops changing, and the append is refused when it keeps growing.
- Fixed a legacy cron-job migration and interrupted-dispatch recovery being dropped when the local clock lags the copies on disk.
- Fixed scheduled-job run bookkeeping stamping a copy older than the one it replaced when the local clock stepped back.
- Fixed `/share` missing loaded credentials whose shape looks implausible (all-digit keys, lower-case slugs, passphrases, values containing slashes) by removing the shape filter from the exact-value comparison.
- Fixed the kernel venv reference sweep deleting the reference of a running kernel when its record was truncated by a short write, and made reference writes report a short write instead of silently storing a partial record.
- Changed the agents view catalog to rebuild only the rows the daemon reported as changed, coalescing roster pushes into one 50 ms window instead of recomputing every row per push.
- Changed a session row's search corpus to be built on first use and reused while the row is unchanged, instead of re-joining up to 64 KiB of saved transcript text on every catalog pass.
- Fixed the daemon serializing the same session transcript twice on attach: the worker's encoded chunk transfer is now the only encoding, so a client that cannot consume chunks is served by decoding the cached transfer instead of a second supervisor-side serialization, and a legacy attach after a chunked one no longer reloads the whole snapshot from the worker.
- Fixed the kernel snapshot sweep reading a truncated or unparseable reference as a stale one: it is now kept like a live reference, so the generation a running kernel reads from is no longer reclaimed.
- Added a credential gate to trace uploads: credentials in the uploaded session body and in the git-remote header are replaced, and the userinfo of a remote URL is stripped, before the request leaves.
- Changed trace upload bookkeeping to use the agent directory the upload started in, so a session belonging to a temporary directory no longer writes its cursor or log into the real one, and an injected transport is logged as not uploaded instead of `uploaded session`.
- Changed `DO_NOT_TRACK` and `PI_OFFLINE` to stop automatic trace sharing and the startup release check, not only pseudonymous analytics.
- Fixed the stall warning telling a warn-only session (`stallWatchdog.abortAfterSeconds` 0) that its turn "will be aborted automatically after 0s", and saying nothing about how to recover; that copy now states no automatic abort is configured.
- Fixed settings changes reporting success when the write never reached disk: a failed write, or every write skipped because `settings.json` cannot be parsed, is now shown with its reason and the fact that the change applies to this session only, in the settings panel, the scoped-models selector, `/model <name>` and `/traces on|off`.
- Fixed a bash command whose full-output temp file could not be created (unwritable or full tmpdir) crashing the host with an unhandled stream error and pointing the user and the model at a file that never existed; the truncation is now reported without a path, and the file is closed before its path is handed out.
- Fixed `models.json` being adopted unvalidated on a process's first load and discarded by the next refresh: every load now runs the same schema check, so an invalid file is rejected (and reported) up front instead of its `baseUrl`/`apiKey` being used and the provider vanishing later.
- Changed the startup credential migration to merge legacy `oauth.json` and `settings.json` apiKeys into an existing `auth.json` and to delete a legacy store only once every provider it holds is readable back from `auth.json`; a store it cannot take over is kept (mode 0600) with a warning instead of being destroyed.
- Clarified that a `cost` in `models.json` must list all four subkeys when present, matching the schema that rejects partial costs.
- Fixed a rate-limited provider stall from being retried as a dead-connection error, which resent the whole conversation into the limiter.
- Added `retry.emptyTurn.maxAttempts`/`baseDelayMs`/`maxDelayMs`/`maxTotalDelayMs` to configure the empty-reply retries, which now also honor `retry.enabled`.
- Fixed the system prompt claiming that every skill is also a same-named shell command; it now says skills are Python modules for the REPL and that a session without the ipython tool cannot call them at all.
- Fixed the system prompt telling the model to install packages with a bare `uv pip install` and that the kernel venv has no pip; it now names the kernel interpreter, which is the form that actually runs.
- Fixed a session file whose only line is a valid header that lost its terminating newline being rewritten in place as a brand-new session: it now keeps its id, parent session and RLM depth, and the write side puts the missing newline back.
- Fixed one unparseable-shape line (a `null`, or a message entry with no message) aborting the load of an entire transcript and making the session vanish from every listing without a diagnostic; such lines are now skipped, counted and named by `getTranscriptLineSkips()`.
- Fixed tool output that ends with a newline being counted as one line longer than it is, so a run of exactly 2000 lines is no longer reported as truncated.
- Changed `prime-agent shutdown` to stop only this shell's own background services by default; stopping every daemon on the machine now requires `--all`, and `--socket <path>` / `--socket-dir <dir>` name a narrower target.
- Added a named pre-stop report to `shutdown`: every affected socket, its pid and its live session count are listed before the confirmation, and `--force` prints the same report instead of skipping it.
- Added `shutdown --dry-run` and `shutdown --orphans`, so a scoped plan can be read out and services that still carry live work can be excluded.
- Fixed `prime-agent status` calling a live service `stale`: liveness (live sessions, verified worker processes, sampled cpu) is now reported separately from the build check, which yields `outdated` for a running service on another build.
- Fixed sockets of another session's worker processes being discovered as daemons, which is what made a busy worker show up as a `stale` service.
- Added `--dry-run`, `--orphans` and the same scope selectors to `prime-agent doctor --fix`, and made it clean only this shell's services unless `--all` is given; services with live worker processes are no longer killed or stopped by a cleanup.
- Fixed two unbounded daemon-side caches: the per-child RLM display cache and the session-artifact tombstone cache now cap entries and estimated bytes, drop the least recently used under pressure, and expire entries for paths that were deleted out from under the process.
- Added an invalidation surface for `!command` credentials: `AuthStorage.reload()` and credential writes now re-run the command instead of serving the value cached at process start, so a rotated websearch `serper` key no longer stays stale in a long-lived daemon.
- Changed settings loading to report unknown or removed `settings.json` keys with their scope and full path, and to surface those warnings at startup, instead of ignoring the key silently.
- Changed `PI_HARDWARE_CURSOR` to override `showHardwareCursor` from `settings.json` as documented, and to warn when the two disagree.
- Added a warning naming the full path when a `models.json` still uses the removed `compat.reasoningEffortMap`, which is ignored rather than migrated.
- Fixed permanent provider failures (refusal, invalid request, auth) being resent once; they now surface with a single request.
- Bounded retries across layers with a shared request budget: the chain stops at the configured ceiling and reports the request count in retry events.
- Fixed daemon identity so `list`/`attach`/`stop` reach the daemon that owns this agent directory from any `$TMPDIR`, instead of failing with ENOENT when `$TMPDIR` differs.
- Fixed a second daemon starting on an agent directory already owned by a live daemon (different `$TMPDIR` meant a different socket path): it is now refused with the running daemon's pid and socket instead of both processes writing the same sessions, harness state and leases.
- Fixed a session whose header line is longer than 64 KiB being silently dropped from the session listing and from `-c`: the header probe returned a truncated prefix instead of the line, so an intact session read as "no session" (an unreadable head now reports a diagnostic instead of disappearing).
- Changed session spend to one basis: `/context`, the per-turn session stats and the session rows now all report the whole transcript (assistants plus compaction/branch-summary usage, minus subagent usage attributed to children), so a compaction or a rollback no longer makes already-paid work look unspent. The `/context` context column stays scoped to the active branch and the output says so.
- Hardened the shared Prime CLI config write: a symlinked config path is refused instead of replaced, and the file is written 0600 inside a 0700 directory with `O_NOFOLLOW`, `fsync` and an atomic rename.
- Made the Prime Inference logout say what it took: when the credential came from the shared Prime CLI config, the logout message now names that file and warns that other tools reading it lost their api_key too.
- Wrote the agent-trace outbox through the private-store helpers (0700 directory, 0600 entries) and repaired the mode of entries left loose by earlier versions on the startup catch-up pass.
- Fixed the temporary extension cache used by `-e <npm-or-git source>` to live in a private, owner-checked `pi-extensions-<uid>` directory instead of a computable shared `/tmp/pi-extensions` tree, so another local account can no longer pre-seed an extension that the agent then imports and runs.
- Changed temporary extension sources to be reused only when prime-agent installed them (owner, private directory chain, install record); a cache directory it did not create is reinstalled, or refused with a visible diagnostic when offline, and `git` is never run inside one.
- Changed a failed refresh of a cached `-e` git checkout to report a warning instead of being swallowed silently.
- Fixed `/import` of a transcript whose session id is already declared by another transcript in the session directory: the copy now gets an id of its own instead of leaving two files on one id, so `--resume <id>` stays unambiguous and the original session keeps its own artifact directory.
- Fixed deleting a transcript whose file name differs from its session id (an import or a rename): the artifact directory, its kernel snapshot, schedule state and sub-agent data are now located by the id in the transcript header instead of the file name, and the deletion tombstone is filed under that id.
- Fixed the incremental own-usage totals to rebuild when a session's entry array gets shorter or an already-consumed entry is replaced, instead of continuing to report the spend of entries that were rolled back.
- Fixed the bounded path caches leaking their byte ceiling on a repeated key write, which emptied the cache and left it refusing every later write.
- Fixed the trace privacy gate leaving part of a URL password behind when the password contains an `@`.
- Added percent-encoded and base64 forms to the trace gate's exact-value comparison, so a configured credential is removed in the encoding it was written in.
- Changed the trace privacy gate to leave a URL whose userinfo carries no credential (`ssh://git@github.com/...`) exactly as written.
- Changed `scripts/preflight-push.sh` to refuse a push when it cannot read in-flight runs or when the worktree differs from HEAD, instead of printing a successful preflight.
- Fixed a scheduled trace upload that was still writing its outbox cursor when the session directory went away, which lost the cursor and made the next start send the same bytes again.
- Changed the `PRIME_AGENT_FORK_GATE=off` fork self-update bypass from silent to logged: every fork detection while the variable is set now writes a warning naming the checkout whose gate was skipped.
- Fixed `prime-agent shutdown` and `prime-agent doctor --fix` leaving the daemon that serves this agent directory running: the default stop scope is the agent-dir identity, so a daemon listening outside `$TMPDIR/prime-agent-<uid>` is now stopped by name through the supervisor registry instead of forcing a whole-machine `--all`.
- Fixed a daemon socket named `worker-*.sock` that sits directly in the machine's temp dir (every Linux box, CI included) being read as a worker socket, which hid it from `status`, from the stop plan and from the force sweeps.
- Fixed `shutdown --force` and `doctor --fix` reporting a scoped "nothing to stop" answer on a machine with no background services at all; the empty-machine line `No background services found.` is back, and the scope report is printed only when something is genuinely left running outside the scope.
- Fixed failed credential refreshes being silent: the auth store's recorded errors are bounded, report dropped entries, and are surfaced by the auth-failure message a session shows.
- Fixed session transcripts left at a pre-hardening 0644 mode staying world-readable when a listing or resume read them; read paths now tighten them to 0600 and say so once.
- Fixed `prime-agent shutdown` leaving a live daemon running while reporting a clean stop: every process on a socket path is now its own named target, a daemon whose socket file was unlinked underneath it is still stopped through its supervisor owner record, and the final report checks process liveness instead of only the socket file.
- Changed the stop report so `stopped`, `failed`, `skipped` and `leftRunning` name the pid they are about, and a socket file is only removed when no live process is serving that path any more.
- Changed `/context` to scan persisted sub-agent sessions with a budget (children, bytes, nesting depth) and report what it left out instead of reading the whole session directory every time.
- Changed `prime-agent update` to refuse any self-update source whose bytes are not pinned: an artifact URL is only accepted from the configured release download base with a `#sha256=` digest, is downloaded and digest-checked before the package manager runs, and every other URL, `file:` spec, or unverified local tarball is refused with the reason.
- Changed `/context` to keep the most recently active sub-agents when its on-disk scan budget runs out; it used to keep the oldest and silently drop every recent one.
- Added a "N+ more agents not shown" line to `/context`, plus a matching daemon log line, so a roster the scan budget truncated says what it left out.
- Changed the session tree depth bound to keep the newest layers and the live leaf instead of the oldest ones, matching the flat tree bound, and to report which side it cut.
- Fixed `prime-agent shutdown` reporting a service it never signalled as stopped when that service vanished on its own during the convergence window; such a target now keeps the verdict this run really decided, or says it vanished untouched.
- Fixed the session worker re-serializing the whole transcript once per attached client; snapshot transfers of one session now share a single encoding.
- Fixed the session tree view so a rewound or forked session keeps the live branch's ancestor chain (not just a detached leaf) while still bounding tree depth, and stopped double-counting the detached leaf in the tree's returned/omitted stats.
- Added read-only health checks to `doctor`: stored auth credentials, kernel venv readiness, and session transcript headers each get a verdict and a next step, while `doctor --fix` is unchanged.
- Fixed stall watchdog warnings and aborts to name the files the diagnostics are actually written to (and to say when the session has no daemon), instead of sending readers to a daemon log that never carries them.
- Added a bounded stall-only evidence log (`logs/stall-evidence.jsonl`) so a stall post-mortem survives rotation of the shared `agent.jsonl`.
- Changed the interactive, `daemon attach` and ACP renderers of stall events to show the actionable diagnostics fields (in-flight tool ids and ages, busy flags, last event, pump state, exemption and kernel segments) instead of only the one-line message.
- Added the build id and the code path of every background service to the `status` and `ps` tables, and made a stop confirmation name the build ids, versions, protocol, schema or code path that differ instead of saying "not this build" without a criterion.
- Fixed the session-list usage scan to fold child-usage attributions that appear before the assistant line they annotate, so imported or reordered transcripts report the same own spend as /usage.
- Fixed session forks to re-link the leaf-position marker when its target git_state entry is dropped, keeping the fork's resume position on the recorded rollback point.
- Added a truncation notice to the branch tree selector ("Tree truncated to N of M entries") that shows what the session-tree wire bound left out, wired end to end from the daemon response.
- Bounded wide (many-branch) session trees by total node count in addition to depth, so a snapshot or tree view of a branching session reports truncation instead of shipping every node.
- Renamed the `--json --dry-run` shutdown output field `leftRunning` to `keptInScope` so the plan output cannot be confused with the full stop report's `leftRunning` bucket.
- Extended the daemon schema digest to cover the session-tree response payload shapes, so response-shape edits can no longer ride an unchanged schema identity.
- Fixed long-session slowdowns: the roster usage memo check and the idempotency body hash no longer scale with transcript or context size.
- Fixed the Python kernel venv interpreter path on Windows so the kernel can boot there (`Scripts\python.exe` instead of a POSIX `bin/python` literal).
- Hardened the Windows process-tree kill to the absolute System32 `taskkill.exe` with an error listener, matching the orphan reaper.
- Documented the remaining Windows-only gaps (shutdown signals, daemon discovery, private-file permissions, persistent harness storage) as known limits.
- Fixed `doctor --fix` and `shutdown --force` to give the same verdict on an unreachable service with live workers, and to stop those workers instead of refusing.
- Added a 15s startup grace so a freshly started background service is not swept as an abandoned one.
- Reported an unsampled cpu reading as "not sampled" instead of implying a measured zero.
- Made the stop selection a required argument of the reap/shutdown planners, so whole-machine is never a silent fallback.
- Decoupled trusted self-update artifact origins from the manifest download base, so PRIME_AGENT_DOWNLOAD_BASE_URL relocates manifests without widening artifact trust (PRIME_AGENT_TRUSTED_UPDATE_ORIGINS opts in to extra origins).
- Refused unpinned registry-lane self-updates and the silent bare-name fallback when the release manifest cannot be fetched (PRIME_AGENT_ALLOW_REGISTRY_UPDATE opts in).
- `prime-agent attach` now reports auth_stale events instead of staying silent until the next 401.
- Fixed the /share secret preflight missing a configured credential whose value a terminal wrapped across lines: the exact comparison now also runs with line wraps removed, mapped back to the uploaded bytes.
- Brought the tui CI job (node --test) into the coverage gate: it now writes a junit report checked by scripts/check-node-test-coverage.mjs with its own floors.
- Changed `prime-agent update` to report a release manifest that could not be fetched with retry and manifest-source guidance, instead of attributing the failure to a registry spec served by the manifest.
- Changed shutdown reporting to credit a signalled daemon that died before unlinking its socket file as stopped, with the leftover file named as residue instead of the target being reported left running.
- Changed the untrusted update artifact refusal to name PRIME_AGENT_TRUSTED_UPDATE_ORIGINS as the way to trust a mirror origin.
- Fixed harness-overview id copying: a verbatim `[global:foo]` (brackets and clipped variants included) now routes like the bare `global:foo` prefix instead of failing as "entry not found" or minting a bracketed id on create, and the overflow hint now points at `rlm.harness.overview(max_entries_per_kind=...)` whose output the REPL can read.
- Fixed a crash when an attach client renders stall events from an older daemon: a missing diagnostics payload now degrades to an explicit unknown line instead of throwing, and the stall event shapes joined the daemon schema digest so mixed-version pairs fail the handshake instead of passing it.
- Fixed live usage totals drifting below the real spend in sessions with subagent usage attribution: the incremental fold now follows the in-place aggregate rewrite of the target assistant message.
- Fixed `doctor` reporting a sessions directory it could not read as an empty directory; it now fails with the errno and a next step.
- Changed daemon stop accounting to record a signal only after it was really delivered, so a swallowed EPERM/ESRCH no longer credits a stop the run never performed.
- Fixed the session tree views to keep the entry the session resumes on inside their size caps, so a rewound branch no longer disappears from the tree while the selection still points at it.
- Changed the tree's node cap to a hard limit that is reported in the bound stats (`maxNodes`) instead of silently returning more nodes than the cap declared.
- Typed the stall event's diagnostics payload as optional on the daemon wire, matching the renderer's existing handling of a missing payload.
- Fixed shutdown reports crediting stops this run never performed: a kill signal the kernel refused to deliver (already-dead or not-permitted pid) no longer enters the causal ledger, so an externally dead daemon with leftover socket residue is reported as left running, and a refused socket face of a signalled pid keeps its refusal verdict instead of being laundered into stopped.
- Fixed `reap --force` planning a kill of an unreachable supervisor that still owns live workers: it now skips and points at `shutdown --force`, which stops the workers first.
- Added a 5-minute quiescence timeout, honest compaction-snapshot and refine-failure notices, a TTL for agent-message send failures, bounded tree depth for forked deep branches, diagnostic pointers in degraded stall renders, and cross-store refusal plus newline flattening for Python harness memory writes.
- Extended the daemon schema identity to also cover the session-tree snapshot wrapper, the get_session_tree response assembly, and the connection-side tree and stall event contracts, so edits to those wire shapes can no longer ride an unchanged schema id and pass a mixed-version handshake.
- Made the self-update plan unable to claim it should run while carrying a refusal, so a refused release can never install regardless of which field a caller reads first.
- Fixed concurrent manual `/compact` calls racing each other into two compactions: a second call now coalesces onto the in-flight compaction, and `abort_compaction` reliably cancels the running one.
- Fixed a failed owned-session promotion during a headless give-up falling back to the worker-stopping path: the promote is retried, a persistent failure detaches without stopping the worker, and stderr reports that the session could not be left running instead of promising a re-attach that would not work.
- Added a structured `run_outcome` terminal event to `--mode json` when the RLM quiescence wait gives up, so CI can tell a give-up apart from a gate failure without scraping stderr.
- Fixed duplicate `refine_failed` events and failure receipts when a refinement throws a non-Error value: the failure is normalized once at the catch point and every downstream reporter shares the idempotency key.
- Changed concurrent manual compactions with different custom instructions to queue the second behind the first instead of silently dropping its instructions, and a manual `/compact` now preempts an in-flight auto compaction instead of compacting twice.
- Removed a dead `artifactDir` field from the self-update refusal plan variant whose cleanup comment described a path that never ran.
- Fixed long sessions slowing down over time: the agents roster no longer rescans the whole transcript on every session-name read, and streaming subagent answers no longer re-compact and re-serialize the full text and task brief on every token.
- Reduced long-session transcript bloat: streamed child usage attributions now coalesce into one ledger line per window instead of one line per child message, and byte-identical consecutive agent status verdicts are no longer re-persisted.
- Fixed the startup extension-update check to respect `DO_NOT_TRACK` (and an explicit `PI_OFFLINE=0`) instead of only truthy `PI_OFFLINE`, so background update probes honor the machine-wide privacy opt-out.
- Fixed repository-local `.prime/agent/settings.json` being able to enable `agentTraces` transcript uploads; the project scope can now only withhold consent, matching the telemetry gate.
- Fixed a stolen auth.json lock discarding a successfully rotated OAuth token pair: fresh credentials are now persisted before the compromise error surfaces, so a mid-refresh lock theft no longer strands a revoked refresh token until a manual re-login.
- Changed bash/exec child processes to run on a sanitized environment allowlist (worker auth tokens, RLM bookkeeping, provider keys like SERPER_API_KEY, and SSH_AUTH_SOCK no longer ride into model-run commands); opt specific names back in via the comma-separated PRIME_AGENT_ENV_PASSTHROUGH.
- Added identity-data detection to the `/share` preflight and a notice to `/export` and `--export`: an HTML export embeds the whole session (working-directory paths, usernames, email addresses) as base64, so a credential-only scan never mentioned it; sharing now asks for confirmation listing what identifies you, and exporting says it next to the output path.
- Fixed a resident session serving credentials from memory after another process revoked or rotated them in `auth.json`: every credential read now stats the store and reloads when the on-disk bytes changed, without a watcher or daemon broadcast.
- Fixed roster child previews gluing the previous answer onto a mid-word slice of a new assistant message in the same run (or freezing at the old capped preview): the streaming preview accumulator now resets at each message_start.
- Fixed a manual `/compact` preempting an in-flight auto compaction destroying the queued autonomous continuations and cancelling and rolling back the goal continuation, which left the agent idle after the compaction; user-level aborts keep the cancel semantics.
- Changed a skipped manual compaction that carried custom instructions to reject with an error naming the dropped instructions, and a queued `/compact` skip now shows a result row instead of being silently swallowed.
- Fixed session reloads splicing the attribution ledger into abandoned branches: deferred child-usage windows now flush before every leaf move, persisted entry and new attribution, and the flush row parent is resolved to the nearest on-disk ancestor, so rewinds, compactions and interleaved child runs can no longer drop or resurrect messages in the model context.
- Fixed agent status recaps disappearing after a rewind: the no-op dedupe key now resets when the session leaf moves, so re-publishing the same verdict on the active branch lands again.
- Fixed nested Prime Agent CLI runs and self-updates launched through the bash tool silently losing the non-secret routing names (agent/session directories, supervisor socket, origin session id) and privacy opt-outs (`DO_NOT_TRACK`, `PI_OFFLINE`, `PRIME_AGENT_TELEMETRY`) to the shell child env allowlist, while worker tokens and provider keys stay stripped.
- Documented `PRIME_AGENT_ENV_PASSTHROUGH` in the README and settings docs and repositioned the shell child env filter in the security docs as passive-leak hygiene rather than a model-facing confidentiality boundary.
- Fixed a settings.json that stopped parsing keeping agent-traces and telemetry consent at their last successful value: an unparseable scope now fails the consent gates closed, and a broken external edit is reported as not applied instead of claimed reloaded.
- Fixed project-level settings (including agent-traces and telemetry vetoes) being ignored when a session starts in a subdirectory of the repository root; project settings are now collected from the repository root down, with any explicit opt-out vetoing.
- Fixed a manual settings.json edit silently dropping CLI/SDK runtime overrides from the merged settings view after a reload.
- Fixed session disposal leaking the settings.json file watchers, so a long-lived daemon no longer accumulates two watchers per session.
- Fixed complete transcript records that lost only their trailing newline being dropped and truncated away; the write owner now restores the terminator for any whole record, not just the session header.
- Fixed resume, fork, import, and rename appends gluing onto a crash-torn transcript tail, which silently made both the torn record and the appended lines unreadable.
- Added a startup sweep for stale atomic-write temp files left in the sessions directory by a killed process.
- Made the update-restart manifest write atomic and added fsync to the settings and model registry cache writes so a power loss cannot resurrect stale content.
- Extended the daemon schema identity to also cover the response envelope (DaemonResponse and its error payload), so an envelope field edit can no longer ride an unchanged schema id and pass a mixed-version handshake; the historical rev30 blind window (the bounded session-tree wire change) is now pinned by a replay guard test and registered in the protocol header.
- Fixed one unparseable ancestor settings file discarding the session's own project settings: only the broken file is skipped now (with a warning, its consent still withheld), and the rest of the project scope keeps its effect.
- Fixed repository-level settings vetoes written while a session is running not taking effect until an unrelated reload or restart: ancestor settings files are now watched too.
- Fixed any settings save silently dropping CLI/SDK runtime overrides from the merged settings view until the next reload.
- Fixed complete transcript records longer than 64 KiB being truncated away by the torn-tail repair when they lost only their terminating newline; oversized unverifiable tails are left untouched instead.
- Fixed saved-session rename repairing and appending without the session write lease: both rename paths now refuse while another writer holds the lease.
- Removed a synchronous `ps` fork from each daemon worker launch and batched the per-reference process identity lookups of kernel venv in-use reads into one helper invocation, so concurrent session launches and mixed-generation kernel boots no longer block the supervisor or add ~55ms per live reference.
- Changed the session-lease guard contention retry from a blocking `Atomics.wait` loop to an async timer backoff, and made the exhausted-retry error name the holder (pid, owner id) with a wait-or-force suggestion; lease acquisition, release cleanup, and candidate preparation (mkdir + owner-record fsyncs) moved off the guard's critical section.
- Added a stale `worker-*.sock` sweep at supervisor startup and worker-death finalization: sockets of provably dead pids are removed, live pids are kept, and orphaned sockets past a 60s age gate are reclaimed.
- Added `EventLog.appendAsync`: the torn-tail observation window now awaits instead of sleeping the event loop, and an append refused against a live writer retries once after a backoff so the record is not silently lost.
- Removed the session's ephemeral `prime-agent-rlm-*` temp directory when the session is disposed.
- Refused appends onto an unverifiable oversized trailing transcript record (`appendOwnedSessionLineAsync` and the in-session persist path now fail loudly instead of gluing lines together).
- Fixed `package`/`config` CLI commands hiding settings warnings (a broken ancestor settings.json was completely silent there while the interactive path printed it).
- Fixed an ancestor settings.json that breaks again after being fixed never warning again in the same session (the warning identity carried no file stamp).
- Fixed a manual `/compact` silently dropping the instructions a pending model-requested compaction had named instead of honoring them like the automatic path.
- Fixed stale kernel variable rosters from earlier compactions being folded back into later summary narratives (the `<ipython_state>` notices are now stripped like machine blocks).
- Fixed the REPL prompt teaching that `os.environ` changes reach `bash()` children; the prompt and the bash tool description now state the child-env whitelist, the `VAR=value cmd` prefix form and the `PRIME_AGENT_ENV_PASSTHROUGH` opt-in.
- Fixed compaction losing agent-delivered task briefs: `agent_message` and heartbeat-prompt text is now preserved verbatim in the user-requests machine block and pinned against summarizer-input head elision, so a compacted single-turn subagent session keeps a copy of what it was asked to do.
- Added an elision disclosure to compaction summaries: the summary header now reports how many messages and characters were elided from the summarizer's input (machine-readable) and tells the continuation the summary may be incomplete, deferring to persistent records for exact constraints.
- Fixed the Python kernel snapshot so open file handles are never persisted or reopened (a write-mode handle used to truncate the real file at restore time), non-string namespace keys no longer abort every snapshot, and functions pickled under a different Python version are refused with a per-name reason instead of crashing the kernel when called.
- Added a model-visible receipt when an ordinary kernel state snapshot write fails, so the model learns its names were not saved to disk instead of silently losing them on restart.
- Hardened the harness state formatting against refinement events or entries with null fields written by older runtimes, so system-prompt construction no longer throws.
- Discarded prepared update-restart manifests older than the 30-minute restore window instead of reviving sessions from an update that died long ago.
- Reported the version actually installed after a self-update instead of trusting the update manifest's target version.
- Pointed the old-Node guidance at this repository's build-from-source path instead of the upstream releases page.
- Errored explicitly when a session file was written by a newer Prime Agent version, instead of silently skipping its migration.
- Fixed Python skill wrapping so cross-skill imports, module-namespace rebinding, reloads, failed-skill errors, and kernel-reserved import names all behave like the kernel-global name, and made duplicate python import names resolve to one owner everywhere.
- Changed kernel state restore notices to report functions revived with a frozen copy of their defining namespace as "reduced semantics" instead of claiming they are available again.
- Hardened the first-run Python kernel bootstrap: uv subprocess stderr now reaches the failure message (disk/permission causes are no longer misreported as network needs), uv steps carry a timeout, unwritable venv directories fail with actionable guidance, and a background prewarm failure is reported to the session instead of vanishing.
- Fixed the installer transport and concurrency: downloads are https-only with a curl timeout, concurrent installs into one npm prefix serialize behind a lock, and overwriting an existing install (including an `npm link` dev checkout) now asks first or requires `--force`.
- Fixed compaction harvesting child-agent replies as the user's own words: a subagent reply no longer enters the verbatim user-request ledger or survives compaction as a live user obligation.
- Fixed kernel state snapshots discarding in-memory streams (BytesIO/StringIO/unrolled spooled files) as if they were open file handles, so working buffers now survive a kernel restart with content and cursor position.
- Deepened the cross-version restore quarantine: functions and class instances nested inside dicts, lists, or object attributes are now quarantined together with bare names instead of reviving foreign bytecode.
- Capped automatic goal continuations (goal stops as `budget_limited` with a visible reason instead of opening unbounded turns) and restricted goal pursuit to top-level sessions; subagents can no longer create self-continuing goals.
- Added a per-session limit of 8 model-created rlm_heartbeats and raised their minimum interval to 60 seconds.
- Fixed goal accounting so a failed threshold-compaction admission rolls back its continuation count, and coalesced or rejected heartbeat follow-ups now record as skipped instead of counted as runs.
- Fixed deleting a saved root session leaving its child sub-agent ledger edges live forever: the teardown now records `parent-teardown` tombstones first (best-effort, so an unreadable ledger never fails the delete), and the live edge view drops edges whose child session directory is gone.
- Changed the default child-transcript retention window from off to 30 days, reclaiming deleted sub-agents' transcripts while live ones stay protected by their ledger edge; a failed ledger scan now keeps transcripts as unverifiable instead of treating "unknown" as "no live edge".
- Changed the retention sweep's residue class to reclaim old directories that have no live reference at all once the ledger was positively scanned, closing the no-tombstone dead zone; an unscanned ledger still keeps them.
- Fixed the agents view caching a stale sub-agent status when another process rewrote `rlm-subagent.json` with the same size and mtime: the cache now revalidates a head+tail content fingerprint.
- Fixed the kernel state-restore version gate to fail closed: a snapshot without a usable source Python version now quarantines by-value functions and classes (reported as "source version unknown") instead of reviving them, while plain data still revives; container-subclass instances (namedtuple/list subclasses) are quarantined under a version mismatch too.
- Keyed the kernel venv generation directory on the requested interpreter line, so an interpreter bump builds a fresh generation instead of rebuilding the directory a live kernel runs from.
- Retired still-active orphan-process journal records written by foreign owners once their pid is provably dead, both during worker recovery and in the failed-worker reaper (which now also kills the dead worker's still-active journaled children before deleting its descriptor).
- Restricted the compaction user-request ledger to agent messages that speak for the user or orchestrator (no relationship, or the parent's brief); sibling notes and any other model-sourced direction are no longer harvested verbatim, and cross-worker message delivery now carries the sender relationship so the gate applies there too.
- Fixed the kernel heartbeat staleness threshold so a healthy kernel reporting intervals under 334ms is no longer judged stale between retained samples.
- Changed kernel heartbeat bash facts to full-fleet sums so buffered-byte movement reports real output instead of set-membership churn.
- Fixed the snapshot write failure receipt to describe its actual per-episode re-arm semantics instead of claiming it repeats while writes keep failing.
- Added read-side staleness demotion for subagent rows whose display file still says running after their transcript has been silent over 6 hours.
- Fixed queue-mutation and mid-compaction resumes lifting the update-restart teardown fence, so parked input stays parked until the restart instead of opening a turn mid-shutdown.
- Made admission refusals retryable for agent-message senders: a reply landing in an admission-pause window or in the update-restart teardown no longer burns its message id as uncertain, and late replies behind the teardown fence are refused with "retry later" instead of being accepted and lost.
- Made coalesce hits visible (a settled ticket plus a log line naming the surviving queue key) and refused same-key follow-ups that arrive while their owner is committing, instead of double-queueing and double-delivering them.
- Fixed scheduled jobs and heartbeats whose tick lands in a retryable admission-pause or committing window: the dispatch is recorded as deferred (no run counted, no error stamped) and a one-shot job stays scheduled to run after the window instead of being marked completed without ever running.
- Fixed stall-watchdog, turn-liveness and cron scheduling to measure ages, budgets and arm delays on a step-compensated clock, so a backward wall-clock step can no longer freeze exemption budgets, defer aborts, throttle every heartbeat frame or delay scheduled jobs.
- Added an unref to the cron scheduler arm timer and a random suffix to legacy cron migration backup names.
- Fixed a deleted sub-agent's transcript being reclaimed after 7 days instead of its promised 30 when its parent session's residue directory was swept: a mixed directory is now kept until the last protected byte inside it has passed its own window.
- Fixed cron and heartbeat ticks that hit an update-restart admission fence being recorded as burned runs: the refusal now defers the tick on a bounded retry cadence (fast attempts, doubling backoff, escalation visibility) instead of completing a once job that never ran.
- Split the admission-refusal contract into `deliveredNothing` and `retryNowSucceeds`, and made the cross-process string fallback decode both, so a fenced target's retry-exhausted guidance says "resend after the restart" instead of inviting another in-process retry.
- Fixed an RLM spawn ledger that outgrew its bounds (32 MiB / 100k records) taking spawning, deletion and the session catalog down with it: the writer now compacts the ledger to its replay-equivalent terminal records before refusing an append, the retention sweep compacts over-bound ledgers it finds, and a ledger that still does not fit fails with an actionable message instead of a stack trace.
- Added `retention.ledgerCompactionEnabled` (default `true`); turning it off restores the previous fail-closed behavior for an over-bound ledger.
- Fixed the retention sweep reading an over-bound RLM ledger as authoritative and treating a record of an unknown ledger version as proof of a deletion; both now make the ledger evidence unknown, so affected artifacts are kept.
- Fixed two retention sweeps running at once on one agent dir (a daemon tick and `prime-agent retention sweep`, or two daemons), which spent the per-sweep delete cap twice and could drop a line from `retention/history.jsonl`; a contended trigger now reports the last sweep instead, and `retention.sweepLockEnabled: false` restores the old concurrent behaviour.
- Fixed manual compaction over the daemon wire reporting a client-side 30s timeout while the compaction kept succeeding server-side; compact requests now wait up to 10 minutes and a timeout error says the daemon is likely still compacting.
- Fixed the Bailian kimi-k3 effective input limit to the measured 1,000,000 tokens the provider accepts (catalog declared 1,048,576), so compaction budgeting no longer plans for tokens the provider rejects.
- Fixed the turn-liveness verdict reading its clock before the kernel facts, which could misreport a heartbeat stamped at read time as stale and mask the real stall reasons in watchdog warnings and aborts.
- Changed CLI `--model` resolution to pick from providers with configured credentials first, and to fail with the configured provider list (plus /login or --provider guidance) when a fuzzy match only hits unauthenticated providers.
- Added a 15-minute cooldown to stale auth marks (401/403-disabled credentials now self-heal, and a same-value /login from another process or in-process recovers them), with a truthful "credentials rejected and disabled" message replacing the misleading "No API key found" error.
- Recorded a model_change ledger entry when a resumed session falls back from its saved model to a different one.
- Kept the user's requested thinking level as the saved intent (instead of the clamped value), re-clamped it on model switches, and made every clamp emit a visible "requested X, using Y" diagnostic.
- Fixed idle eviction killing sessions whose Python kernel still ran background `bash()` scripts: a live kernel handle or executing cell now keeps a session resident past child passivation and whole-worker eviction.
- Changed the stall watchdog to give a quietly running awaited `bash()` command the full exemption budget instead of a 20-minute one, so long silent jobs are no longer aborted mid-run while still alive.
- Folded the stall watchdog's activity-sampled exemption transitions into one merged stall-evidence line per minute, ending the exemption started/cleared pair emitted on every tool-call boundary that buried real stall records.
- Added the session id to every stall-watchdog exemption log line so daemon-shared stall evidence can be attributed to the session it vouched for.
- Fixed compaction summaries being written to a side branch when the session appended an entry (for example a subagent usage attribution) while the summary was being generated, which left the live context uncompacted until it exceeded the model's context window ([#19](https://github.com/Dmatut7/prime-agent-rlm/issues/19))
- Added a parent-facing notice when a running subagent stays silent past the stall-watchdog warn threshold, so the parent agent can check on a long-running child instead of the watchdog killing its turn.
- Changed the refinement, auto-refine review, branch summary, and daemon status output budgets to reserve room for thinking on models that cannot disable it, so those replies stop being truncated into an unparseable body; the daemon status budget is capped at 2048 tokens and the branch summary at 4096, and a model whose own ceiling eats the reserve now logs one warning instead of failing silently later.
- Changed the stall watchdog default to warn-only (`stallWatchdog.abortAfterSeconds` now defaults to `0`), so a silent turn is reported instead of aborted; set a positive value to opt back into the automatic abort.
- Fixed the 90-minute idle eviction killing background scripts: a session whose Python kernel still owns a live `bash()` handle (or is executing a cell) is no longer idle for child passivation or whole-worker eviction, so the kernel is not closed out from under a running script.
- Changed the kernel's live-`bash()` fact to be read from the orphan-process journal with a pid check, with the heartbeat frame kept as a freshness-bounded fallback, so the fact stays true while an idle kernel hosts a script and stops being true when that script exits.
- Added a daemon log line naming each session held resident by live kernel work, and one warn per kernel per hour once such a handle passes 24 hours.
- Added the sub-agent spend total (money and tokens) to the subagents tray line, flagging unpriced models instead of silently summing them as free.
- Removed the dead `./hooks` subpath export from the `@earendil-works/pi-coding-agent` package manifest and its two tsconfig path aliases: the `src/core/hooks` module they pointed at was deleted when hooks merged into the extensions system, so the export failed to resolve for external importers (upstream's manifest never had it; deleting it is API-breaking only for imports that already failed).
- Added a manifest guard test that walks every `package.json` exports target and fails naming the subpath when neither the built file nor its source counterpart resolves.
- Hardened the semantic-edge ledger to the private-store standard: the ledger directory is created 0700, the file lands 0600, torn-tail repair truncates through an O_NOFOLLOW file descriptor, and a symlink planted at the ledger path disables the ledger instead of being written through.
- Fixed `rlm.delete_subagent` rejecting the `RLMSpawnHandle` returned by `rlm.spawn`; it now accepts a spawn handle, a subagent row, or a child id/session name string, matching `rlm.collect`. Ported from upstream PR #2307.
- Fixed agent-spawned shells hanging on interactive prompts: git commit/rebase without -m, credential asks, and pagers now fail fast or no-op because GIT_EDITOR, EDITOR, VISUAL, PAGER, and related variables default to non-interactive values in both shell env choke points (the host `getShellEnv` channel and the kernel `bash()` channel). Ported from upstream PR #2219.
- Non-interactive CLI boots no longer hang on stdin: the boot-time piped-stdin read gives up after a short idle window (PI_STDIN_TIMEOUT_MS, default 250ms) instead of waiting forever on a pipe a daemon worker, agent harness, or CI runner holds open without ever writing or closing it, `--resume` of a session from another project fails fast without a TTY instead of blocking on a fork confirmation, `daemon attach` without a TTY reports an error instead of waiting for terminal input, and the deprecation-warning keypress wait is skipped without a TTY. Ported from upstream PR #2285.
- `daemon open --json` now prints the created session summary instead of attaching, giving non-interactive open callers a machine-readable path.
- Added an `auxiliaryModel` setting (`"provider/id"`) that routes refinement LLM passes (auto-refine review and refinement planning) to a different model. These passes use their own prompt prefixes, so running them on the session model evicts the provider's prompt-cache entry for the session and forces a full context re-read on the next session request; the setting isolates those passes while falling back to the session model when unset or unusable. Ported from upstream PR #2220.
- Changed the subagents bar to count running, idle, and inactive agents across the whole subagent subtree instead of only direct children, and to show a stalled grandchild's marker.
- Fixed auth storage reload to reject non-object JSON (array/string/null) with a drained error and keep the last good store, instead of silently reading malformed bytes as an empty credential store.
- Fixed model cycling being unreachable from the interactive UI: Alt+M / Shift+Alt+M now cycle scoped models, and the docs, the `/scoped-models` description and the `--models` startup banner no longer claim the unavailable Ctrl+P binding.
- Rejected typo'd slash commands with a suggested correction instead of sending them to the model as prompts; genuine messages that merely start with a slash still pass through.
- Subagent model references now resolve an unambiguous short form (a bare model id) to its full selector, and a rejected reference names the expected `provider/model-id` form plus close matches instead of only saying the model is unavailable.
- Added a dirty-tree guard to the bash tool: destructive git discard commands (`git checkout -- .`, `git checkout .`, `git clean -f...`, `git reset --hard`, `git restore .`) are refused while uncommitted changes exist, listing the dirty paths and the explicit bypasses (`allowDestructiveGit: true` or `PI_BASH_ALLOW_DESTRUCTIVE_GIT=1`). The guard probes the repository the command targets (following `cd` chains and `git -C`), refuses relocations it cannot replay safely, and fails open when dirtiness cannot be determined.
- Extended the bash tool's dirty-tree guard to shared-worktree sweeps: `git add -A`, `git add .` and `git stash` are refused with the dirty paths while uncommitted changes exist, with the same `allowDestructiveGit: true` / `PI_BASH_ALLOW_DESTRUCTIVE_GIT=1` bypasses.
- Kept scoped adds (`git add -A docs/`) and non-sweeping stash subcommands (`git stash list`, `pop`, `apply`) unguarded.
- Tightened the bash tool guard's bypass ownership: daemon/SDK faces now honor only the `PI_BASH_ALLOW_DESTRUCTIVE_GIT` env var (the `allowDestructiveGit` argument is ignored and hidden from the schema, and refusals name only the env var), while interactive faces keep the argument via `BashToolOptions.allowDestructiveGitArgument`.
- Fixed compaction summaries never recording kernel-performed file edits: ipython tool results now contribute their structured edit diffs to the tracked file operations, so `<modified-files>` reflects the default toolset's edits. Ported from upstream PR #2226.
- Capped the read/modified file lists rendered in summary blocks at 200 entries, so one bulk-editing kernel result cannot grow a summary block without bound. Ported from upstream PR #2226.
- Fixed goal token accounting regressing across summary branch rebuilds: the same goal's usage counter can no longer move backwards when a summary navigation reloads a stale persisted state, and a stale active snapshot can no longer revive a goal whose budget gate already fired. Ported from upstream PR #2215.
- Changed `agent_observe.list_agents()` into the one family directory: it now lists every member `agent_message` can reach, active or not, and each row carries its `relationship`.
- Changed `agent_message.list_agents()` to read that same directory, so the two discovery entry points report the same family members in the same order.
- Fixed three of the production races upstream #2336 fixed and this fork still had: the hidden-supervisor sweep renews its shutdown admission before the blocking listener scan, the shutdown-admission probe reports without deleting a record whose process identity it cannot verify, and the automatic trace upload returns a settle handle (`whenIdle`) with upload-delay notifications so a caller can await the startup catch-up and any in-flight upload instead of racing it. Ported from upstream PR #2336.
- Changed the auto-compaction trigger to fire at `compaction.triggerRatio` (default 0.8, validated to 0.5-0.95) of the provider's real input limit instead of `contextWindow - reserveTokens`, so a session no longer reaches the provider's 400 before compaction wakes up.
- Priced the context estimate that drives the trigger and `/usage` by content density (CJK and fenced code cost what they cost a tokenizer) instead of a flat chars/4, which under-counted Chinese-heavy sessions by ~1.6x.
- Added `compaction.priorityOverAgentMessages` (default true): an incoming agent message queues behind a pending or in-flight compaction instead of opening a turn on an over-threshold context, and reports `compaction_pending` to the sender.
- Added a compaction failure valve: from the second consecutive failure each retry halves `keepRecentTokens` (floor 4096), and the fourth drops the oldest non-summary context with a loud notice in the transcript instead of leaving the session stuck above the threshold.
- Added `classifyIncomingInput`, the single structural classifier behind the admission matrix (eight input classes, message text never consulted).
- Showed a "compacting context · N queued" header above the queued-message previews while context compaction is in flight, so it is clear the queued messages are waiting for compaction.
- Fixed orphaned session workers retrying supervisor resurrection forever when no replacement can come up: they now exit gracefully after a bounded supervisor-lost window, closing active sessions first.
- Fixed errored sessions persisting fabricated completed verdicts: a session whose last turn ended in a model error (e.g. provider 400s before any work ran) no longer lets the status classifier invent a recap and a COMPLETED verdict from the task text. Such sessions now settle to an `error` task state whose summary carries the transcript's real error message, persisted with the same journal discipline as model verdicts, and a verdict fabricated by earlier builds and seeded back after a daemon restart is repaired by the first sweep. The agents view labels these sessions "error"; the saved-session wire carried the pre-`error` enum at first (old clients reject the whole session item on the new value), so off-daemon rows crossed with the recap but without the error verdict, and the daemon protocol revision that removes that downshift is the point where they read as failed too.
- Hardened and sped up session persistence: every private-file write (append, atomic rewrite, fork) now loops on short write counts instead of trusting a single write syscall, so an ENOSPC-style partial write can no longer leave a torn line that the atomic rename promotes into the transcript; the per-append assistant-message scan is now a cached flag, so appending no longer rescans the whole entry list on the suppressed pre-assistant path.
- Added a persistent supervisor connection for daemon workers: cross-worker requests (agent messages, roster reads, renames) now multiplex over one `SupervisorLink` instead of opening a fresh supervisor connection per call. Requests are never retried in-flight because daemon commands are not idempotent.
- Added a settle handle (`supervisorAvailabilityCheckSettled`) to the daemon's supervisor availability monitor: it resolves when an armed availability check has run to completion - including the recheck it schedules - or when the check is disarmed, so the supervisor monitor tests await the round instead of a probe promise the fake clock cannot reach (which used to hang for the full 30s test timeout). Ported from upstream PR #2336.
- Added the session's recorded model to inactive rows in the agents view: an off-daemon saved row has no live summary to read a model from, so it showed none at all and the selected row's header fell back to the model this view would start a new session with. The daemon saved-session wire (`DaemonSavedSessionInfo.model`) and the agents-view display both carry it, per upstream #2148.
- The saved-session wire carries an `error` task state now, so an off-daemon (archived) row whose last turn failed reads as failed instead of showing the terminal error recap with no verdict on it. This is the wire half of upstream #2310: this fork's own client validator has accepted the value since the merge commit 67334bf1a (upstream's has since 8f52777f2, which is not an ancestor of our pre-merge 0.9.1 build - that one rejected it) and only `serializeSavedSessionInfo`'s downshift held it back. A client older than the revision that opens it still rejects the whole session item over the new value, which is why the daemon reuse gate's identity check is what makes dropping the downshift safe; the residual exposure is the persisted `agent_status` row an older build reads from disk, documented at `src/modes/daemon/saved-session-info.ts`.
- Added an `app.agents.expand` keybinding (default `alt+right`) that collapses or expands the selected agent's subagent list, merged the Enter and Right hints into one line, and stopped revealed summary rows from persisting a ghost expansion key.
- Changed an archived agents-view row to show its `error` verdict instead of the lifecycle label, so a stopped session whose last turn failed still reads as failed.
- Fixed a throwing `session_before_compact` extension hook being treated as "no opinion": the compaction now fails and names the hook's error in the transcript instead of summarizing behind the hook's back.
- Harness digest windows can now be ranked by relevance to weighted query terms (upstream #2241 phase 2): matched terms are discounted by document frequency within the kind (tf-idf style, #2392), so rare distinctive terms outrank entries dense in ubiquitous words; score ties break on stable identifier order instead of recency (#2400), and the default no-query injection order is unchanged.
- The harness digest window is now ranked by relevance to the active goal and the last few messages (upstream #2241 wiring, IDF-weighted per #2392): the current task's wording, not arrival order, picks which entries the model sees; ranking only steers delivered digests and never triggers one, and delivery freshness moves to a state fingerprint so wording drift cannot stack digests.
- Harness digest delivery now compares a sha256 fingerprint of the harness state (upstream #2400) instead of the rendered text: relevance wording drift no longer stacks near-duplicate digests at cold boundaries, the compaction head and the emergency-shrink head carry the fingerprint so resume can trust them, and carriers written before fingerprints existed fall back to one text comparison before being superseded.
- Changed the prompt queue so messages you send are delivered before queued agent-to-agent messages, background notices, and scheduled prompts in the same queue, while keeping your own messages in the order you sent them; the steering queue still drains before the follow-up queue, so a follow-up you send does not overtake a steering-lane subagent reply, and a compaction in flight still outranks a queued subagent reply.
- Documented in the same pass: a user message an extension submits on your behalf is ruled human by the same structural test, so it shares that priority, and a message you reorder by hand keeps its place - a later arrival picks an insertion point instead of re-sorting the queue.
- Fixed no-skill kernel bootstrap calls (postinstall, runtime-bootstrap) wiping the recorded Python skill map from the .bootstrap-version marker, which forced the next real session to re-sync every skill: a no-skill call now leaves the recorded skill set untouched and only skill-syncing callers rewrite the marker.
- Added the `/speed [on|off]` session command: toggles a compact footer readout of model output tok/sec (latest response plus session average), computed from existing stream events with no provider protocol changes.
- Added a `frame_decode` transport benchmark to the performance harness: a standalone node harness decodes a 32 MiB private frame with a snapshot-chunk routing header in 8 KiB chunks against the prepared source build, recorded through a new transport worker phase with report tables and schema wiring; the benchmarks suite regains `worker.py`, its README, and its test suite.
- Sped up first-run installs by skipping pip/setuptools/wheel seeding when creating the kernel Python venv; every kernel package is installed with `uv pip`, so the seeded tools were never used.
- Classified Windows worker named pipes as worker sockets in `prime-agent ps`, so worker pipes are no longer listed as daemons.
- Fixed short-lived sessions re-paying the whole Python kernel skill sync or wiping and rebuilding the venv after being killed mid-sync: the bootstrap version marker is now written atomically and persisted incrementally (base first, then after every installed skill), so the next session resumes only the remaining skills instead of starting over.
- Reduced TUI noise: one `⚙ 本轮 N 步 · 用时 —— 动词摘要` line collapses each turn's tool activity (Ctrl+O expands), thinking blocks render as a single recap line by default, completed `!` bash blocks show a one-line output tally instead of a 20-line preview, and feature/keybinding hints are deduplicated and localized to Chinese.
- Added a persistent footer context watermark (`模型名 · ctx 312k/1M(31%) ▍压缩线80%`, plus a GLM storm-zone marker on glm models) with density controlled by the new `footer.telemetry` setting (`off`/`compact`/`full`, default `compact`), and pinned the current model on the fullscreen top bar.
- Added a consecutive tool-error warning: the footer shows `⚠ 工具错误×N` once three or more tool results in a row failed (any success clears it), fed by the session stats and live tool events.
- Made the collapsed summary/header rows clickable in fullscreen chats: tools and IPython cells, agent messages, refinement and compaction/branch summaries, skill and injected-prompt cards, bash and shell blocks (including inside side-question popups), collapsible errors, startup resource sections, and custom messages toggle only the clicked item; Ctrl+O still resets all conversation detail globally.
- Reduced Python kernel startup time by deferring the event-loop import stack (asyncio plus the shell tool's heavy stdlib imports) until after the ready event, with no protocol or behavior changes.
- Fixed the kernel stderr log (`kernel-stderr.log` in the session artifact directory) being created world-readable: the log is now owner-only (0600), and its directory is created owner-only (0700) when the kernel manager creates it, matching the kernel state snapshot and the other private session artifacts, because kernel stderr can carry exception payloads.
- Corrected the documented defaults in `docs/settings.md` and `docs/themes.md`: unset thinking starts at `medium` (not `xhigh`), the default theme is `prime`/`light` (not `dark`), `transport` defaults to `auto` (not `sse`, and `websocket-cached` is a valid value), and the removed `collapseChangelog` setting is no longer documented.
- Chats now start at the middle conversation-detail level (edit diffs expanded, thinking visible, tool output still summarized) instead of the most-collapsed overview; Ctrl+O keeps cycling overview -> details -> all unchanged.
- Added a pre-push guard hook that refuses mirror-like pushes and remote branch deletions to real GitHub remotes, with an opt-out via PRIME_AGENT_ALLOW_MIRROR_PUSH=1.
- Fixed opening an agent from Agents View during a daemon auto-update failing with "Daemon is preparing an update restart": the open now waits through the update restart (bounded) and reconnects once the daemon returns, with a notice that it waited instead of a hard failure.
- Harness store writes now validate entry shape before persisting: `rlm.harness` create/update/upsert calls reject non-string or empty `title`/`content`, empty or non-string ids, malformed paths, non-dict `reference`/`arguments`/`metadata`, and skill entries without a valid Python reference, with a clear error naming the entry and the violated entry field; refinement events reject non-string triggers and invalid `changes`/ids. `/refine` and rollback edits reject the same shapes through `validateEdit`.
- The harness digest and refine overview now skip malformed persisted entries and refinement events (non-object events plus events with non-string ids, triggers, change elements, or outcomes, labeled by bounded type instead of value) with a `harness: skipped malformed entry <id> (...)` diagnostic line instead of crashing session creation, so a single corrupt store entry can no longer brick every session and child spawn.
- Added an `imageModel` setting that routes image-attaching turns to an image-capable model when the session or subagent model is text-only.
- Image turns on a text-only session model now fail with an actionable error naming `imageModel` instead of silently dropping the images when the setting is unset or unusable.
- Attached TUI windows now recover automatically when the daemon restarts: a shutdown close polls the same socket path for the reconnect window (60s by default) and then re-attaches the session and refreshes the transcript instead of dying; if the daemon stays gone, the saved-transcript message remains.
- Daemon update restarts now announce the update close reason on every attached window, so all windows (not just the one running /update) restore their sessions.
- A one-line banner reports restart recoveries, and warns to restart the window when the restarted daemon is newer than this window's binary.
- Fixed withdrawn background command completion notices silently dropping parked next-turn messages: cancelling a queued turn now re-parks its undelivered prefix records, so deferred context (kernel state restore notices, goal context, deferred RLM child terminal notices) is delivered on the next turn instead of being lost.
- Changed the session catalog scan to count tool-result (and extension-role) message entries from their serialized header instead of parsing their payloads, cutting the CPU a cold scan spends on transcripts whose tool output dwarfs everything else.
- Parked quota-blocked sessions now resume from a wake that survives aborts, restarts, and daemon-delivered wakes instead of clearing the park or stalling the resume, and a park no longer fails an active goal: the goal resumes with the task at the wake.
- Catalog metadata updates (renaming a saved session, archiving a stopped worker, marking a recovered session interrupted) no longer parse the whole transcript: each appends a single line after validating the session header, so routine actions on multi-MB sessions avoid the full-load stall and memory spike. A missing or header-invalid session file now fails the update with a clear error instead of being recreated or silently rewritten as a fresh session. The interruption notice stays advisory during worker recovery: a notice that cannot be written is logged, and recovery still reaps orphaned processes and resolves its journal.
- Changed the daemon to start its session catalog process on demand: the catalog is no longer spawned at supervisor boot, so an idle daemon keeps one fewer compiled runtime resident. The catalog spawns on the first session-file operation (agents view, `list --all`, session rename/delete/archive) and stays resident once started.
- Changed session context assembly to carry only the newest harness digest: older digest custom messages are skipped when the context is built, a fresh cold-boundary digest replaces the copies it supersedes instead of stacking, and a compaction head's digest snapshot yields to any digest appended after the compaction. Persisted transcripts are unchanged; the newest digest remains authoritative.
- Cached the active branch path in the session manager, so per-turn compaction checks and context-usage updates no longer rebuild the whole leaf-to-root path after every assistant message.
- `SessionManager.getBranch()` now returns the live shared branch array (public API): repeated reads return the same array object and straight-line appends extend it in place. Callers must treat it as read-only and take `.slice()` for a snapshot; `session_before_compact` already passes a snapshot.
- Fixed compaction summaries drifting behind the retained conversation: the summarizer now receives the newest kept-tail assistant text as a `<recent-state-anchor>` and the in-context `[compaction-summary]` prefix states that the retained messages below are authoritative.
- Fixed compaction file lists compounding through repeated summaries: `<read-files>`/`<modified-files>` blocks are stripped from the previous summary before the update prompt (entry details plus the fresh append remain the single source), and the combined file lists are capped at 6000 characters, dropping read-only entries first.
- New request timing diagnostics: `PI_REQUEST_TIMING=1` (or settings `requestTiming: true`) logs each provider request's phase timeline - prompt-built, request-sent (with body bytes), first-byte, first-token, stream-done - to `~/.prime/agent/logs/agent.jsonl` under `coding-agent.request-timing`, so a long `Waiting` state can be attributed to client-side build, upload, provider prefill, or a prompt-cache miss (summary usage shows cacheRead/cacheWrite). Zero overhead when disabled.
- Added a session-start `[python-skills-unavailable]` notice when a pre-imported Python skill fails to import into the kernel. The report names each failed skill import and its import error so the model learns before its first call instead of from the unavailable-skill placeholder, in both the TUI and headless sessions.
- Fixed kernel REPL protocol output that could buffer unbounded memory in the host: Python-level stdout/stderr writes now ship as 64 Ki-char frames, oversized result reprs are capped at 1 Mi chars with a marker, oversized display payloads fail the cell, and the host repairs a kernel that streams an oversized protocol line.
- Fixed the unknown-key warning that fired for the new imageModel setting: it is now registered in KNOWN_SETTINGS_KEYS and no longer reported as "never takes effect" (R4 DS review W-8).
- Fixed a silent gap where a retained subagent that stalled during follow-up work never told its parent session: the daemon now delivers the same stall notice the live-run path produces into the parent's transcript.
- Added settled, duration, and answer-preview columns to the agents view: each agent row now shows whether its current task settled (`✓`/`…`), how long the session ran (`dur`), and a muted one-line preview of its last reply, fed by new optional roster fields (older daemons degrade to local derivation and hide the preview).
- Added an agent abort lever to the daemon protocol: agent_message.abort can stop a stuck family agent's active turn (and flush its queued work) through a capability-gated agent-origin form of the abort commands, with nuclear-family reach enforced at the routing layer.
- Wired the agent_message.abort host request into the session's kernel host bridge, so the agent-message skill's abort lever reaches the daemon controller.
- Added an abort() call surface to the agent-message skill (and documented it in SKILL.md): one call stops a stuck family agent's active run, flushes its queued steering on request, and reports the daemon capability degrade when the connected daemon predates the lever.
- Fixed the input classification for the python-skills-unavailable notice (from #2381): the exported custom type now maps to internal_continuation, so the input-classification meta-test stays green.
- Added a typed `session_recovering` daemon error (upstream-compatible `DaemonSessionRecoveringError` with wire round-trip) for sessions whose worker is registered but not yet hydrated, alongside the fork's adoption-window "Session worker is recovering" contract; both classify as transient with a 5s retry hint.
- Bounded snapshot terminal-frame writes two ways: the fork's drain timeout plus the per-transfer abort signal (upstream #2260), so a suspended client or a superseded transfer can no longer leak the snapshot reservation.
- Supervisor catch-up failures now drop the session's deferred payloads and keep the fork's bounded retry budget (C10/F4/F8), while a failed session no longer blocks the rest of the catch-up batch.
- Platform-aware worker connect budgets: startup adoption and recovery probes keep the fork's fast-fail lanes (2s/1.5s on POSIX) while Windows gets the #2036 headroom (90s/10s).
- Snapshot transfer integrity violations (restarted/mismatched duplicate transfers) keep the fork's close-the-worker containment instead of upstream's resync-only handling.
- Authority-state writes (worker descriptors, supervisor config, shutdown admissions, update-restart manifest) now all go through the atomic-file util with fsync + directory fsync preserved.
- Changed the agents view to declare first-party daemon capabilities when connecting, so supervisor-only capabilities (agent roster, direct peer transport) are requested explicitly instead of being advertised by every worker.
- Changed daemon roster attach degradation (daemon not advertising the agent roster, or the subscribe request failing) to be recorded in the agent log instead of being swallowed silently; session behaviour is unchanged.
- Kept the local "(no activity Xm)" quiet-duration label on each agents-view row while adopting the upstream heartbeat-aware status label.
- Kept the local incremental session-file scan and restored upstream's per-entry usage accumulators into its resume state, so token and cost totals no longer drop for sessions that are scanned incrementally after going idle.
- Removed the agents-view promotion of ancestor rows to running when a descendant only has an armed heartbeat, matching upstream: an armed heartbeat between firings is residency rather than work, so ancestor rows stay idle and no longer inherit the descendant's quiet-duration label.
- Changed the daemon wire schema revision to 27 (the union of the fork and upstream 24-26 lineages); a daemon built before this change is now detected as stale and is restarted on the next client connection.
- Fixed ephemeral (non-persisted) RLM sessions writing a `semantic-edges.jsonl` ledger into their session dir and registering that ledger for trace upload.

## [0.9.1] - 2026-09-01

- Fixed a v0.9.0 regression: the agents view's Inactive section was empty on a fresh view until a search was typed. The saved-session catalog now loads (progressively) when the view opens; it was previously deferred to search because the roster's boot seed carried the saved corpus, which the seed scoping removed.

## [0.9.0] - 2026-09-01

- Fixed background (unattributed) kernel output missing from the expanded IPython cell view: it is now surfaced in the tool details and rendered under a "background output (unattributed)" label after stdout/stderr/result.
- Fixed a protocol interrupt during a REPL state restore leaving a mixed old/new namespace: names are now staged first and applied atomically with SIGINT parked across the apply, and an interrupt landing anywhere between a committed snapshot or restore and its request finishing is recovered instead of misreporting the completed operation as failed.
- Fixed the REPL snapshot writer leaving a new payload beside a truncated manifest on mid-write failures: payload and manifest now commit via unique same-directory temp files and atomic renames with guaranteed cleanup, and an interrupt during cleanup can no longer misreport a completed destructive snapshot as failed.
- Fixed the REPL runtime `list_names` request crashing the serve loop when the namespace held a non-string key; non-string keys are now skipped and every runtime request fails individually through the shared backstop instead of killing the loop.
- Addressed REPL host-swap review findings: reworded stale IPython-specific busy/restart messages for the default kernel and stopped `restart()` from resurrecting a concurrently killed REPL kernel.
- Fixed graceful REPL kernel `shutdown()` losing teardown ownership to its own child's exit handler, which made `restart()` misread the shutdown as superseded and never start the kernel again.
- Fixed REPL kernel `start()` waiting out the full 30s ready timeout when the kernel process fails to spawn; the spawn error now rejects startup immediately.
- Fixed a cell that rebound or ignored SIGINT (or a restored prior handler) permanently breaking protocol interrupts: the REPL runtime now re-asserts its SIGINT handler between cells.
- Fixed the Python REPL runtime surviving its owning process's death while a non-yielding cell runs: an owner-watchdog thread now hard-exits the runtime (killing live bash children first) when the owner process dies.
- Fixed an interrupt parked during a snapshot's prune window misreporting the completed destructive snapshot as failed; it is now consumed once the manifest is committed, and an interrupt landing just after a completed snapshot/restore request is consumed too instead of failing its done.
- Fixed a REPL runtime interrupt gap where an interrupt landing during a cell's trailing-expression repr or output drain was dropped; the request now stays interruptible until its done event is emitted, so a slow user __repr__ can be cancelled.
- Fixed two REPL runtime request-lifecycle bugs: a cell closing sys.stdout/sys.stderr no longer kills the serve loop (done still arrives and later cells run), and an untargeted interrupt parked for a request that fails to compile is consumed with that request instead of spuriously cancelling the next cell.
- Fixed the REPL runtime leaking a finished cell's id onto late background-thread output: the current cell is now cleared right after the post-cell drain, so `done` stays the last event with that id and between-cell output carries a null id.
- Fixed bash() cells failing under strict-POSIX shells (dash) when the status pipe landed on a multi-digit fd.
- Fixed rlm.run outside a live kernel hanging forever instead of failing fast, which stalled CI shard 3 until timeout.
- Fixed two bash() spawn races: status-channel fds no longer leak when pipe creation fails mid-setup, and a status-socket gate keeps the command from starting until its pid is journaled (a kernel kill in that window now stops the child instead of orphaning it past the reaper).
- Fixed a compile-phase crash (e.g. RecursionError from a pathologically deep attribute chain) killing the REPL runtime instead of failing the one cell: any per-request failure now becomes error+done and the serve loop keeps running; rebinding sys.stdout/sys.stderr to flush-less objects no longer kills it either.
- Fixed the REPL runtime hanging before done when a cell closes fd 1/2 and a later open() reclaims the number: drain sync tokens now go through a private dup of the capture pipe, with a pump-liveness backstop so a dead pump can no longer wedge the serve loop.
- Fixed the Windows orphan reaper killing only the journaled bash() shell pid; it now uses taskkill /T so descendants die with the tree, matching the in-kernel bash() kill paths, and resolves taskkill via an absolute System32 path (with NoDefaultCurrentDirectoryInExePath) so a planted CWD taskkill.exe cannot hijack cleanup.
- Fixed a snapshot request with identical `path` and `manifest_path` silently clobbering the just-written state payload; the runtime now rejects it as a failed request.
- Fixed a snapshot request with a negative `max_bytes`/`max_variable_bytes` and `prune_oversized` writing an empty payload and then deleting every user variable; size caps must now be non-negative integers.
- Fixed an interrupt landing mid-snapshot leaving prune deletions half-applied: once the snapshot manifest is committed, SIGINT is deferred until every oversized name is removed, so the namespace always matches the on-disk snapshot.
- Hardened bash(): cancelling `await bash(cmd)` now kills the command's process group (background handles are unaffected), Windows helper binaries resolve via absolute System32 paths, kill() retries taskkill for already-reaped Windows trees, and orphan-journal enrollment fails closed when configured.
- Fixed cross-cell output misattribution in the REPL runtime: stream events are attributed at write time via context, and raw fd or user-thread output is emitted with a null id instead of being credited to whichever cell is running.
- REPL kernel: output from user threads, other cells' leftovers, and raw fd writes is no longer merged into the running cell's stdout; it is surfaced separately as unattributed background output.
- Hardened bash() further: the host now injects an absolute default shell into the kernel (no PATH lookup; /bin/bash else /bin/sh on POSIX), macOS start-id lookup uses /bin/ps, and Windows worker-teardown orphan kills go through hardened taskkill /T.
- Hardened Windows bash execution: the kernel shell is resolved only from trusted absolute paths (never PATH), and bash children are contained by kill-on-close job objects so a crashed kernel cannot leak process trees (taskkill remains only as a fallback when job creation fails).
- Hardened Windows bash() containment: children are now created directly inside the kill-on-close job (PROC_THREAD_ATTRIBUTE_JOB_LIST at CreateProcessW time), so no window exists in which a kernel kill can leak a suspended, never-run process; handle inheritance is restricted to exactly the child's stdio handles (PROC_THREAD_ATTRIBUTE_HANDLE_LIST), so concurrent spawns cannot leak each other's handles; the journal start-id query still runs only while the job-contained child is suspended, and bash() still raises instead of falling back to jobless taskkill when containment fails.
- Fixed a Windows bash() PID-reuse hazard: the child process handle is now retained through job cleanup and every taskkill-by-pid fallback (watch reap, kill(), cancel escalation, shutdown cleanup) and closed exactly once only after the handle is marked reaped, so a recycled pid can never be killed by the fallback.
- Added an async-by-default `bash()` callable to the kernel runtime: it returns a live handle immediately (pid/tail/poll/kill/await), bounds in-memory output, and enrolls children in the orphan-process journal so kernel teardown reaps them.
- Fixed bash() orphan-journal writes marking a child inactive even when the kill signal was not delivered; the record now stays active on delivery failure so the host reaper still owns the process (on Windows a shell that already exited counts as delivered, so clean exits still retire their record).
- Changed the kernel to run on a minimal CPython REPL runtime speaking JSON lines over stdio.
- Changed the kernel to a minimal Python REPL: `%%bash` cells, `%cd`, `%env`, and `!` escapes were replaced by `bash('cmd')` and `os.chdir(...)`/`os.environ[...]` (magic-style cells fail with a plain Python `SyntaxError`); startup is faster and memory use is lower.
- Removed the Jupyter/ipykernel kernel client; existing kernel venvs are rebuilt once (slimmer, no ipykernel) on next start.
- Fixed supervised session renames failing after the supervisor approved an available name.
- Made session path detection consistent across direct and daemon commands.
- Removed internal test-only configuration cache reset hooks.
- Fixed new-chat hints to use the session message count.
- Kept available model lists in sync with the current catalog and configured providers.
- Removed unused host-request capability helpers and the `kernelManagerRef` option from `IpythonToolOptions`.
- Fixed `bash()` to capture all foreground command output before finalizing results by using an ordered per-command completion marker; output written after the marker (e.g. by `EXIT` traps or background jobs) is not in the awaited result but stays visible via `handle.output()`/`tail()`.
- Agent messages now use core session admission to choose immediate or queued delivery.
- Made cross-worker agent lists current without broadcasting duplicate peer rosters.
- Namespaced kernel host handler results so handler fields cannot overwrite host reply protocol metadata.
- Fixed graceful Python kernel disposal so timed-out final snapshots are cancelled before teardown.
- Fixed invalid kernel protocol frames hanging requests by rejecting the affected request and replacing the kernel from its latest state snapshot.
- Fixed kernel teardown so session cleanup and signal handling share one bounded graceful shutdown path.
- Fixed remote agent messages being delivered twice when the daemon request timed out or the response was lost: the message is now sent exactly once per call, and post-send failures surface as errors instead of triggering a resend.
- Simplified model resolution and feature hint shuffling internals.
- Fixed saved-session resume when its resident worker is still recovering after a daemon restart.
- Fixed queued-message editing so duplicate prompts always target the selected queue entry.
- Fixed reattached sessions omitting queued child agents or showing the wrong child activity.
- Fixed passive RLM child metadata recovery from legacy registries without a session directory.
- Stopped treating `NODE_ENV=test` as an implicit telemetry opt-out.
- Removed delayed cancellation callbacks from empty interactive selectors.
- Kept heartbeat lists current when session or subagent scope changes.
- Removed the delay before continuing sessions after compaction.
- Wait for RLM session activity changes without zero-delay polling.
- Fixed concurrent `execute_bash_and_wait` commands sharing one bash abort controller: each `executeBash` invocation now gets its own controller, so a finishing command no longer clears a still-running command's abort state and `abortBash` cancels every in-flight command.
- Removed the test-only daemon active-session lookup override.
- Made daemon shutdown wait for Bash completion without polling.
- Fixed a race where a concurrent open of a session already being opened by another client bypassed the session ownership check instead of failing with session-already-active.
- Accept contributions from sirouk as a vouched external contributor.
- Render Mermaid code blocks in assistant messages as inline Unicode diagrams, with a "Mermaid diagrams" setting (off/final/streaming, default streaming).
- Tell the model explicitly to run shell commands through `bash()` instead of `subprocess`/`os.system`.
- Fixed `prime-agent list` pinning an abandoned empty session at "working" forever; an empty session with nothing in flight now reports "idle".
- Evict an empty, unnamed session's worker as soon as its last client disconnects, instead of parking it for the idle sweep; the on-disk draft session is preserved.
- Fixed daemon session create when the worker process cannot be spawned (e.g. EMFILE from fd exhaustion): the create now fails with the real spawn error plus a resident-worker/ulimit hint, and the CLI prints a one-line error instead of crashing with a TypeError stack dump.
- Fixed the agents view hiding running subagents whose worker is starting or recovering; the worker state now shows as the row's status label.
- Made spawned subagent sessions visible from creation, before their first message lands.
- Renamed the subagent summary bar label from "agents" to "subagents" and unified the status formula behind both surfaces.
- Made the daemon supervisor own an event-driven agent roster: workers push roster deltas on session events and `list` is served from the supervisor's ledger with zero worker round-trips. Rows are as fresh as the owning worker's last delta; a silent worker's rows are annotated (recovering, last-heard-from) rather than dropped, and the surfaces that display those annotations ship in the follow-up PR.
- Tracked admitted subagent runs in the supervisor roster from the moment they are queued (they appear in `list` once their session exists), and kept passivated or evicted agents listed as inactive rows instead of disappearing (client-owned workers stay private: their rows are dropped when the worker goes away).
- Tracked worker liveness in the supervisor roster: a dead worker's rows are flagged "recovering" the moment its socket closes, and rows of silent workers carry a last-heard-from time. These fields are supervisor-internal here; the roster surfaces that display them ship in the follow-up PR.
- Replaced the agents view's 1-second polling with a subscription to the daemon's agent roster: the supervisor pushes coalesced roster updates, scope transitions reuse one shared connection and store without refetching, and rows render the ledger's statuses and lifecycle labels (queued, recovering, failed, last-heard-from staleness). Removed the poll path: the agents view now requires the daemon's agent_roster capability and fails fast against a daemon lacking it (unreachable in practice, since launch replaces daemons on any schema mismatch); the chat subagents bar degrades to snapshot-driven counts.
- Loaded the saved-session catalog only when a search query needs deep message text, once per view, instead of on every navigation.
- Fixed a reconnect deadlock where a daemon socket close during recovery or post-update restore parked the reconnect loop's own attach, snapshot, and list requests behind a hello that the stuck loop could never produce ([#1905](https://github.com/PrimeIntellect-ai/prime-agent/issues/1905)).
- Collapsed ipython cells that call the bash skill with a literal command now preview as `bash · <command>` instead of the python wrapper.
- Added a direct session transport: the TUI now talks to its session's worker over a supervisor-issued single-use ticket, falls back to supervisor routing on any direct-path failure, and keeps the session streaming while a lost supervisor socket reconnects in the background.
- Workers bind their identity to a fresh per-process instance id, enforced only when the authenticating supervisor presents one, so a downgraded supervisor can still adopt live workers.
- Fixed daemon startup and recovery to preserve slow live processes and fail closed after socket lock loss.
- Recovery never signals a live worker process it cannot verify as its own: a persistently failing live worker parks as failed with its process left running (reclaimed automatically by the next fresh create once its identity is verified or it exits). The one deliberate exception is replacing an authenticated pre-roster worker during adoption. A live worker that stays silent through ten probe rounds (~2.5 minutes) also parks as failed instead of probing forever.
- Reduced kernel memory spikes during namespace snapshots: the payload now pickles straight into the staged file instead of building serialized copies in memory (peak snapshot overhead ~3.9x payload -> ~1x; ENG-5819).
- Fixed empty draft sessions lingering as zombie rows after the last viewer quit: a direct-transport client's detach or socket drop now triggers the same last-detach eviction as supervisor-routed clients.
- Stopped re-emitting `rlm_child_update` events whose child snapshot did not change; identical per-token progress updates no longer reach attached clients.
- Fixed `/update` keeping the old TUI process alive until the relaunched TUI quit by replacing the process in place on POSIX platforms running Node 26.1 and newer; Windows and IBM i keep the previous child relaunch.
- Fixed sent agent messages under Python cells not showing the expand/collapse keybinding hint that received agent messages show.
- Scoped the roster's restart seed to registered workers' families: the saved-session corpus stays owned by the disk catalog, so a supervisor restart no longer publishes thousands of inactive rows (and one header read per row) to every roster subscriber. `prime list --all` output is unchanged: subagent rows of families without a registered worker are now served on demand from the spawn ledger.
- Session disposal no longer blocks on the final trace upload (uploads finish detached; daemon exit, update restarts, and worker archive-and-shutdown drain them through a single barrier), and deleting an RLM subagent no longer writes a kernel snapshot that the deletion sweep removes right away.

## [0.8.1] - 2026-08-26

- Fixed syntax highlighting in the expanded python tool-call view: triple-quoted strings spanning multiple lines now keep their string color instead of only the first line.
- Changed the default RLM maximum recursion depth for new sessions from 1 to 2.
- Changed ACP prompt requests to resolve only after all causally admitted subagent and parent work has settled.
- Changed the Cloudflare AI Gateway default model to claude-sonnet-4.5 after the catalog dropped the gateway's workers-ai mirror ids.
- Fixed ACP assistant chunks to identify message boundaries across autonomous turns.

## [0.8.0] - 2026-08-21

- Fixed an OAuth login that finishes after its server was retargeted arming the old-endpoint token against the new URL: credentials are endpoint-bound at issuance, and the host and kernel only use a token bound to the configured endpoint. **Breaking**: generic MCP OAuth credentials stored before this release lack the binding and require one `/mcp login <server>`.
- Fixed `mcp add` keeping a stored `mcp:<name>` credential when the entry was new: any add now drops the name's credential, so tokens for authored non-catalog skills (e.g. slack) cannot replay to a user-configured URL.
- Fixed kernel MCP shutdown budgets exceeding the host's kill deadline; graceful close now finishes inside it, and a kernel that exits without a `shutdown_reply` no longer stalls shutdown for the full deadline.
- Fixed a shutdown race that could leave an MCP server process running after its generation was dropped from the registry.
- Fixed the kernel MCP regression test and the Python runtime tests not running in CI.
- Fixed first IPython calls after an upgrade failing with a raw "Operation was not possible or timed out": kernel startup now tolerates cold venv boots (30s budget; crashes still fail fast via the exit handler), and zmq socket-teardown rejections surface as actionable retriable kernel errors.
- Fixed headless completion reporting a clean finish when a post-compaction continuation failed to start: ACP and print-mode idle waiters now see the failure, while interactive idle behavior is unchanged.
- Added a pre-imported generic MCP API and shell/TUI commands to manage persistent Streamable HTTP and stdio servers in user settings.
- **Breaking**: removed the documented catalog-name override — an `mcpServers` entry named after a built-in integration (e.g. `linear`) no longer repoints the built-in at a custom `url`/`bearerTokenEnvVar`; it now disables the built-in skill and is not served by the generic runtime. Rename the entry (e.g. `linear-proxy`) to keep using a custom endpoint via the generic API. This closes a credential-replay surface where name-keyed tokens could be sent to an override URL.
- Fixed agents overlooking enabled generic MCP connections by advertising their names and pre-imported `mcp` API usage in the system prompt.
- Fixed `/mcp` management feedback disappearing during resource reload and limited server details in TUI output to names and transports.
- Fixed credentials configured as env var names resolving to the literal variable name when the variable is set but empty; an empty env var now reports a missing credential ([#1468](https://github.com/PrimeIntellect-ai/prime-agent/discussions/1468)).
- Fixed ACP rejecting an immediate follow-up prompt when injected work restarted the session; follow-ups now queue behind in-flight work, and cancellation drops queued follow-ups before they start.
- Added correlated ACP terminal-quiescence metadata, resident session settlement, and fail-closed daemon input fencing; prevented recovery state from persisting runtime credentials or model configuration.
- Fixed explicit RLM child deletion leaving hidden unsettled work after runtime teardown, including reporting cleanup failures and notifying the parent when deletion completes.
- Added changelog fragments (`packages/<pkg>/.changes/*.md`) with a CI check and release-time aggregation, eliminating `[Unreleased]` merge conflicts.
- Fixed the queued-message browse controls (Option+Up) rendering in the same style as typed prompt text inside the input box; the header is now dimmed like other hints so it cannot be mistaken for part of the prompt.
- Fixed IPython kernels and forkserver processes outliving their owner after a hard crash: kernels now arm ipykernel's parent-death poller via JPY_PARENT_PID, the forkserver watches its parent pid, and both pids are registered in the orphan process journal for supervisor recovery.
- Fixed a pid-reuse race for forked IPython kernels: signaling and liveness now go through the forkserver (the kernels' parent) instead of raw pid operations from Node, and the orphan journal's inactive record is only written on a confirmed kill outcome.
- Added session-scoped ACP MCP servers through the kernel MCP program API ([#1378](https://github.com/PrimeIntellect-ai/prime-agent/pull/1378) by [@hallerite](https://github.com/hallerite)).
- Changed the subagents summary under the prompt into a bordered `agents` tile with color-coded running/idle/inactive counts and a right-aligned open hint.
- Enabled `/fast` with OpenAI API-key authentication for GPT-5.4/GPT-5.5/GPT-5.6 and updated the unavailable message ([#1595](https://github.com/PrimeIntellect-ai/prime-agent/discussions/1595)).
- Fixed `/goal` re-prompting a parent that had correctly delegated to subagents and ended its turn: the continuation now waits until descendant work settles, then resumes automatically.
- Changed post-compaction continuation error classification to typed `AgentContinueError` codes instead of matching error message text.
- Fixed the working-status elapsed timer (e.g. "Waiting · 5s") restarting at 0s after leaving and re-entering a session or re-attaching to it; the timer is now anchored to the in-flight turn's user message and keeps counting.
- Added a `session_before_refine` extension hook: extensions can replace `/refine` and auto-refine planning with their own proposal (for example using a cheaper model — see `examples/extensions/custom-refinement.ts`) or skip a refinement round; rollbacks bypass the hook and extension edits go through the normal apply-time validation. Also documents `refine_complete`.
- Added a durable `[refinement]` transcript message after each refinement showing the applied harness edits (expandable to exact before/after diffs via the shared tool-output toggle), and a live loader while a user-issued /refine runs.
- Fixed the Agents View heartbeat refresh failing entirely ("Cannot list heartbeats while session worker is failed") when any resident worker was terminally failed: failed workers are now excluded from the global catalog while recovering and disconnected workers still fail closed.
- Refreshed MCP providers immediately after server changes so OAuth connections can be started without restarting Prime Agent.

## [0.7.4] - 2026-08-19

- Fixed model searches ranking stronger matches ahead of weaker signed-in matches while preferring signed-in providers for equivalent results ([#539](https://github.com/PrimeIntellect-ai/prime-agent/pull/539) by [@eliebak](https://github.com/eliebak)).
- Fixed large IPython variables repeatedly slowing later turns by excluding them from persistent snapshots and removing them when context is compacted.
- Fixed daemon socket paths being used verbatim in identity derivations: on supported platforms, `--daemon-socket` spellings differing only by duplicate or trailing slashes now normalize to one canonical path, so worker-descriptor namespaces, daemon log files, and persisted descriptors agree.
- Added a `thinking` option to `rlm.run` for spawning subagents with an explicit reasoning level; invalid levels for the resolved child model fail spawn.
- Changed opening the agents view (full or scoped) with a draft prompt to auto-stash the draft instead of refusing; the draft is restored into the editor when the session is reopened.
- Fixed Shift+Enter no longer inserting a newline in terminals that send a literal `\n` (for example a Ghostty `shift+enter=text:\n` mapping): the byte decoded as `ctrl+j` and triggered the new edit-diff toggle instead of the editor newline.
- Removed a system prompt paragraph referring to an async `bash()` kernel helper and managed jobs that do not exist in the runtime.
- Changed RLM guidance to orchestrate independent workers in parallel, use available async shell helpers safely, end the turn instead of sleeping, polling, or blocking on long awaits, provide proactive outcome-focused progress updates from root agents, and use simplified technical English for user-facing prose.
- Fixed new top-level daemon sessions inheriting an RLM child depth from the supervisor process.
- Fixed active goals stalling after a mid-goal automatic compaction when the previous continuation prompt was already running: only undelivered continuations deduplicate, so a fresh continuation is queued instead of being suppressed.

## [0.7.3] - 2026-08-17

- Fixed assistant rendering when provider payloads contain null or sparse content blocks.
- Added authenticated host-request contracts with per-call request IDs, generation fencing, cancellation signals, and currentness checks.
- Fixed root daemon shutdown retaining cleanup ownership while kill events are in flight.
- Changed RLM family discovery to use a daemon-owned append-only spawn ledger with per-child display metadata instead of reconstructing topology from session files.
- Fixed long-running macOS supervisors losing ownership when system cleanup removed authority records from `$TMPDIR`.
- Fixed deleted RLM children leaking kernel snapshots while retaining their readable transcript tombstones.
- Changed Agents View subagent rows to show stable `name · model/effort · summary` metadata.
- Changed the default Cerebras model to the available `gpt-oss-120b` route and aligned cross-provider handoff fixtures with the generated catalog.
- Fixed the agent going silent after an automatic context compaction interrupted unfinished work: the tool loop now resumes when a threshold compaction fails or is skipped, and active goals keep continuing after a successful mid-goal threshold compaction.
- Changed the agents view splash hint from "type to start" to "type to search sessions".
- Added `app.edits.expand` (`ctrl+j`) to toggle edit diffs; diffs are now shown only by this toggle, and `ctrl+o` no longer affects them.
- Changed edit rendering so the `╰─ <path> +N -M` summary line is always visible and `ctrl+j` toggles the diff inline beneath it, indented to the summary text.
- Fixed fullscreen wheel scrolling in Ghostty while retaining application link clicks; set `terminal.fullscreenMouse` to `false` to use native Cmd-click instead.
- Changed the agents view to sort idle and inactive sessions by last message time, newest first, while keeping running agents in stable creation order.
- Fixed `openai-codex` models being invisible to `rlm` subagents and `find_models` because model discovery reported Prime Agent's own version as the Codex client version ([#1375](https://github.com/PrimeIntellect-ai/prime-agent/pull/1375) by [@bilelrais](https://github.com/bilelrais)).
- Added a working hint that recommends sharing traces with Prime Intellect to help train open-source LLMs.
- Restored bare `prime-agent --resume` opening the agents view and the `/resume [id|path]` slash command; bare commands open the agents view and an argument resumes that session in place.
- Fixed URLs not opening on click in fullscreen mode on terminals such as Ghostty; clicking a link in the transcript, dock, or overlays now opens it in the browser.
- Fixed ctrl+p ("Toggle agent message expansion") only toggling received agent messages; it now expands and collapses sent agent messages together with received ones.

## [0.7.2] - 2026-08-11

- Fixed Down Arrow focusing the Agents View entry before moving a nonempty prompt cursor to the end ([ENG-5147](https://linear.app/primeintellect/issue/ENG-5147/keep-down-arrow-in-the-prompt-until-the-cursor-reaches-the-end)).
- Added `app.messages.expand` (`ctrl+p`) to collapse or expand agent-to-agent messages separately from `ctrl+o` tool output.
- Added a `ctrl+t` expand hint to collapsed thinking blocks, matching the tool output hint.
- Changed expand/collapse hints to a consistent bracketed `(Ctrl+O to expand)` style across tool, message, summary, and error rows.
- Added a configurable copy action to login dialogs so raw sign-in URLs can be copied without selecting wrapped text ([#643](https://github.com/PrimeIntellect-ai/prime-agent/issues/643)).
- Added privacy-safe pseudonymous product analytics for onboarding, command use, execution modes, run outcomes, TTFT, latency, usage, tools, retries, and compactions, with disclosure and opt-out controls ([ENG-4682](https://linear.app/primeintellect/issue/ENG-4682/add-privacy-safe-posthog-analytics-to-prime-agent)).
- Changed sent agent messages in the IPython cell UI to show only the message text with a `╰─` gutter when expanded, matching received messages, and hid the raw `agent_message.send` receipt dictionary.
- Fixed Homebrew installs attempting to self-update their versioned Cellar keg instead of directing users to `brew upgrade prime-agent` ([#844](https://github.com/PrimeIntellect-ai/prime-agent/issues/844))
- Fixed the agents view collapsing expanded subagent lists when returning from an opened agent ([ENG-5105](https://linear.app/primeintellect/issue/ENG-5105/keep-the-agents-view-state-persistent)).
- Kept the subagent summary row visible and selectable while its list is expanded in the agents view, so pressing enter on it collapses the list again ([ENG-5105](https://linear.app/primeintellect/issue/ENG-5105/keep-the-agents-view-state-persistent)).
- Added in-place editing of queued steering and follow-up messages: Alt+Up/Alt+Down browse the queue from the draft, Enter applies the edit as steering, Alt+Enter as a follow-up, and submitting an empty editor deletes the item; interrupts now preserve the queue ([#838](https://github.com/PrimeIntellect-ai/prime-agent/pull/838)).
- Fixed workers with no live connection reporting as `ready`; stopping workers now report a `stopping` state, are hidden from live sessions, and no longer receive daemon-wide commands ([#850](https://github.com/PrimeIntellect-ai/prime-agent/pull/850)).
- Fixed timed-out worker stops stranding dead-but-registered workers ("Session worker is not connected"); stops now finalize in the background once the process exits, and zombie processes are no longer counted as alive ([#851](https://github.com/PrimeIntellect-ai/prime-agent/pull/851)).
- Fixed sessions becoming permanently unopenable after a stale worker registration was left behind; open/resume now self-heals by finishing the old cleanup and starting a fresh worker ([#852](https://github.com/PrimeIntellect-ai/prime-agent/pull/852)).

## [0.7.1] - 2026-08-07

- Fixed the bundled `websearch` skill description and missing-key guidance omitting the `/login` → **MCP Connections** step required to configure Serper.
- Fixed `retry_worker` cancelling its own recovery when a stopped session worker left a saved stop marker behind, leaving the session stuck at "Session worker is not connected".

## [0.7.0] - 2026-08-05

### Breaking Changes

- Changed agent messages to always use steering delivery and removed delivery-mode options from the Python, CLI, RPC, and connection APIs. Code passing `mode` to `agent_message.send`, or a delivery mode over the CLI/RPC, must drop it.

### Changed

- Changed self-updates to report the previous and new Prime Agent versions.

### Fixed

- Fixed the subagent summary showing retained children as idle while they run follow-up work.

## [0.6.1] - 2026-08-05

- Added reverse tab navigation to the `/login` configuration menu and moved the model scope shortcut to `Alt+S`.
- Fixed daemon startup crashes hiding their exit status and daemon log until the startup timeout.
- Documented the global `idleEvictionMinutes` daemon setting, including its default, valid values, and eviction/passivation behavior ([#621](https://github.com/PrimeIntellect-ai/prime-agent/issues/621)).
- Fixed top-level `--help` omitting `acp` from the supported `--mode` values ([#620](https://github.com/PrimeIntellect-ai/prime-agent/issues/620)).
- Fixed `stop` and `rename` becoming prompts when `--daemon-socket` precedes the command ([#622](https://github.com/PrimeIntellect-ai/prime-agent/issues/622)).
- Fixed subagent terminal notices arriving as anonymous follow-up prompts instead of attributed agent messages, so a parent can now tell which child reported completion, failure, or cancellation, and a busy parent is steered at the next turn boundary rather than waiting to go idle ([#617](https://github.com/PrimeIntellect-ai/prime-agent/issues/617)).
- Fixed ACP mode reporting a failed turn as a clean `end_turn`. A provider error, expired auth, or unusable model left `session/prompt` resolving with no updates at all, which reads to a client as a successful but empty turn; the turn now fails with the underlying error instead.
- Fixed ACP cwd mismatch metadata treating symlink aliases such as macOS `/var` and `/private/var` as different directories ([#623](https://github.com/PrimeIntellect-ai/prime-agent/issues/623)).

## [0.6.0] - 2026-08-04

### Breaking Changes

- Changed `rlm(...)` to return at task admission instead of waiting for the child to finish. It now yields a spawn handle (`rlm_child_id`, `name`, `session_dir`, `model`); `RLMResult` and its final answer, usage, and model-fallback warning are gone. A child reports back with `agent_message.send(..., receiver_role="parent")`, which arrives as an ordinary prompt and starts a parent turn. Code that read `result.answer`, or treated `asyncio.gather(...)` over `rlm(...)` as fan-in, must be updated.
- Changed `agent_message.send` to role-addressed delivery: pass `receiver_role` (`"parent"`, `"sibling"`, `"child"`) plus `receiver_name` for siblings and children. The old positional `send(target, message)` form no longer works, and the separate `roster()` call is now `agent_message.list_agents()`.
- Narrowed agent reach to the nuclear family: an agent may message or observe only its parent, siblings, and direct children. Top-level sessions are siblings of one another, so agent-to-agent between them still works; grandchildren and cousins must be reached by relaying through the intermediate child. Users are unaffected and still see every session.
- Requesting an unavailable subagent model now fails the spawn instead of silently falling back to the parent's model with a warning.
- Bumped the daemon schema revision to 13 for the parent-edge, depth, naming, and passivation wire changes; older clients and daemons are rejected cleanly at connect.

### Added

- Added `--mode acp`: Prime Agent now runs as an [Agent Client Protocol](https://agentclientprotocol.com) agent over NDJSON on stdio, driving an `AgentConnection` in-process. IPython surfaces as an ACP `execute` tool call carrying its cell source, and capabilities ACP has no native concept for (subagents, autonomous gate state, rich IPython output, compaction, goals, heartbeats, continual-harness refinement) travel in a namespaced `ai.primeintellect.prime-agent` `_meta` envelope that vanilla ACP clients ignore. Documented in `docs/acp.md`.
- Added `/rlm-max-depth` to view or set the recursion cap for the current chat, with `--global` to change the default for new sessions.
- Added recursive navigation to the agents view: drill into any session's children and back out again, with each chat showing its own depth.
- Added a family roster via `agent_message.list_agents()`, listing parent, siblings, and children with name, id, depth, and status, including family members currently on disk.
- Added sibling-unique agent names, enforced at spawn and rename against loaded and unloaded sessions alike. The same name may be reused at different depths.
- Added an `idleEvictionMinutes` setting (default 90, `off` to disable) controlling idle eviction and passivation.

### Changed

- Changed finished subagents to stay on disk until something touches them, so memory scales with the active frontier rather than every subagent ever spawned. Lists show them without loading them, and attach, message, or transcript read wakes them on demand.
- Changed sessions to persist their parent edge and derived RLM depth, so tree position no longer has to be inferred from whatever happens to be in memory.
- Changed the supervisor to stop worker processes whose whole session tree has been idle past the threshold, and to passivate individually idle children inside still-busy workers.
- Replaced the child-agent inspector with a single subagent summary line under the prompt that opens the agents view scoped to that session's children.

### Fixed

- Fixed `stop` and `rename` rejecting custom daemon socket options.
- Fixed SIGINT in print mode leaving the session active until liveness reclaim.
- Fixed daemon startup failing permanently when an interrupted supervisor owner directory contained only stray files.
- Fixed agents-view fallback notices and scoped live sessions surviving transient refresh failures across chat returns.
- Fixed stopping completed subagents deleting their retained sessions.
- Fixed silent or cancelled RLM children leaving parents without a terminal status notice.
- Added missing argument hints to `/name`, `/model`, `/export`, and `/import` in autocomplete.

## [0.5.1] - 2026-08-04

### Fixed

- Fixed `/refine` failing with an opaque JSON parse error when the refiner exceeded a fixed 4096-token output cap; output budgets now derive from the selected model, and a truncated reply reports the exhausted budget directly.

## [0.5.0] - 2026-08-03

### Breaking Changes

- Reworked session input scheduling into a single session action lifecycle and store (daemon protocol 7, schema revision 8); older clients and daemons are rejected cleanly at connect.

### Changed

- Changed large daemon session loads to stream JSONL history and avoid retaining a second full-file copy in memory.
- Changed the agents view to render explicit session names in bold and the "(no messages)" placeholder in italics.
- Changed subagent guidance to retain reusable children and delete completed direct children once they are no longer needed.
- Changed top-level CLI help and documentation to expose autonomous mode, quality gates, and their limits.
- Changed daemon and RPC session state to report literal queued actions separately from active scheduler work.

### Fixed

- Fixed the blank line between the recap and the working hint so they render directly above each other.
- Fixed compaction retaining runtime resources after an explicitly deleted subagent had a transient cleanup failure.
- Fixed long-running thinking timers to display hours and days instead of unbounded minutes.
- Fixed overlapping daemon snapshot catch-ups closing healthy workers and preventing new sessions from starting.
- Fixed active scheduler work being reported as queued in session state.
- Fixed headless runs completing before queued follow-up work had finished.
- Fixed `/compact` consuming itself as its own successor action.
- Fixed daemon parse rejections dropping the command id, which left older clients waiting for a timeout instead of seeing the protocol error.
- Fixed `--goal` sessions never showing the objective to the model, which made seeded goals invisible to first turns and continuations.

## [0.4.0] - 2026-08-01

### Breaking Changes

- Replaced the recursive daemon `get_session_tree` response with flat nodes linked by `parentId` (protocol 6); clients must support the new response shape.
- Removed `/resume` and bare `--resume`; browse sessions with left-arrow from a daemon chat, or use `--resume <session-id|path>` for a direct resume.

### Added

- Added `ctrl+n` to start a session from Agents View, and `alt+enter` to queue a reply as a follow-up while Enter steers a streaming session.
- Added session-owned `/compact`, `/refine`, `/goal`, and `/autonomous` commands with autocomplete to the Agents View reply composer, plus target-scoped `/name` and `/kill` commands.
- Added optional stable session names and initial prompts to `/new`.

### Changed

- Changed collapsed edit and IPython calls to show compact per-file line-change summaries while retaining full expanded diffs.
- Changed bare `/effort` to open a selector of the current model's supported reasoning levels, and removed token estimates from reasoning-effort displays.
- Improved session search ranking to prefer exact session-name and first-message matches before prefix, substring, and transcript fuzzy matches.

### Fixed

- Fixed deeply nested `/tree` sessions overflowing the daemon serializer by transferring and rebuilding the session tree iteratively.
- Fixed `prime-agent agents` opening a new chat for a process-local session.
- Fixed daemon startup after an interrupted supervisor leaves an empty ownership directory.
- Fixed `/effort xhigh` and `/effort max` being rejected before a model is active.
- Fixed IPython tracebacks emitting ANSI color codes.
- Fixed selected rows and selectors becoming nearly invisible on terminals whose background matches the selected theme color.
- Fixed startup waiting on private Prime Inference model authorization by caching authorization locally and refreshing stale entries in the background.

## [0.3.3] - 2026-07-23

- Removed the bundled orchestration heartbeat skill from the model system prompt.
- Fixed feature hints crowding queued messages and side questions by placing them below the recap and hiding them while messages are queued ([ENG-4741](https://linear.app/primeintellect/issue/ENG-4741/recap-queuefollow-upmessage-hint-looks-cluttered)).
- Fixed `/btw` truncating long answers by rendering side questions in the scrollable transcript.
- Changed recognized slash commands to retain accent coloring after submission in live, replayed, and queued TUI surfaces while preserving Markdown arguments.
- Unified prompt, steering, follow-up, and session-command scheduling under session-owned admission with durable queue state and coordinated update/restart checkpoints.
- Unified Agents View and session resume into one searchable Running/Idle/Inactive session view with live heartbeat badges.
- Changed selection cursors from `→` to `›` across model selectors, scoped-models, and the theme default for consistency with tree and user-message selectors.
- Changed the queued follow-up hint connector from `↳` to `╰─` to match the tool-execution continuation connector.
- Changed `/context` tree connectors from `├ `/`└ ` to `├─ `/`└─ ` to match the tree selector and session picker.
- Changed the IPython cell queued marker from `▸` to `◇` to match the subagent and context-tree status icons.
- Changed slash-command autocomplete to separate argument hints and resource provenance, show only the selected command description, and summarize hidden results directionally.
- Fixed cancelled extension commands remaining alive when spawned processes ignored SIGTERM ([#458](https://github.com/PrimeIntellect-ai/prime-agent/pull/458) by [@snimu](https://github.com/snimu)).
- Fixed OAuth browser launch URLs being interpreted by the system shell.
- Added agent-callable `refine` skill so the model can schedule continual harness refinement from IPython via `await refine.run()` without blocking the current turn ([#504](https://github.com/PrimeIntellect-ai/prime-agent/pull/504) by [@sethkarten](https://github.com/sethkarten)).
- Changed long live session opens to render a bounded recent transcript tail while preserving full prompt history ([#343](https://github.com/PrimeIntellect-ai/prime-agent/pull/343) by [@sethkarten](https://github.com/sethkarten)).
- Changed `/refine` to run planning in the background so the conversation is not blocked during the LLM pass ([#497](https://github.com/PrimeIntellect-ai/prime-agent/pull/497) by [@sethkarten](https://github.com/sethkarten)).
- Added serialized headless refinement and `--goal` / `--goal-token-budget` for seeding durable session goals ([#514](https://github.com/PrimeIntellect-ai/prime-agent/pull/514) by [@sethkarten](https://github.com/sethkarten)).
- Added multi-turn `/btw` side conversations with transient in-pane bash commands ([#512](https://github.com/PrimeIntellect-ai/prime-agent/pull/512) by [@ilijalichkovski](https://github.com/ilijalichkovski)).


## [0.3.2] - 2026-07-20

- Fixed invalid `--resume` session IDs being submitted as prompts, with nearest-session guidance instead ([ENG-4722](https://linear.app/primeintellect/issue/ENG-4722/prime-agent-resume-accepts-incorrect-session-ids)).
- Changed `/model` to show all public models with authenticated providers first and open provider authentication when an unavailable model is selected ([ENG-4575](https://linear.app/primeintellect/issue/ENG-4575/show-all-models-in-model-and-prompt-auth-on-selection)).
- Changed the shared configuration menu to cycle tabs with Tab, use Shift+Tab for model scope, show an Escape close hint, preserve arrow-key search editing, and remove the model selector's provider shortcut.
- Fixed searchable selectors retaining their previous scroll position after the query changed.
- Changed interactive, print, JSON, RPC, piped-stdin, and no-session clients to use the same daemon-owned runtime while preserving their existing commands, output protocols, and lifecycle behavior ([ENG-4685](https://linear.app/primeintellect/issue/ENG-4685)).
- Added RPC controls for schedules, heartbeats, agent messaging, and live session observation ([ENG-4685](https://linear.app/primeintellect/issue/ENG-4685)).
- Fixed daemon-backed headless startup, rollback routing, RPC wire compatibility, and duplicate client runtime preparation ([ENG-4685](https://linear.app/primeintellect/issue/ENG-4685)).
- Fixed heartbeat-owning subagents appearing completed, showing completion checkmarks below the prompt, being omitted from active subagent counts, or remaining visible after deletion.
- Fixed the heartbeat tray and manager showing heartbeats from unrelated sessions.
- Fixed daemon backpressure triggering redundant catch-up snapshots for events already queued by the socket.
- Added dedicated stable and beta installers, with stable advancing on version bumps and beta advancing on every commit to `main`.
- Fixed incompatible daemon builds crashing startup or respawning after shutdown, with capability negotiation, verified provenance, and convergent force shutdown ([ENG-4687](https://linear.app/primeintellect/issue/ENG-4687/make-daemon-version-mismatches-self-healing)).
- Changed tool-result and announcement images to show compact metadata instead of terminal graphics ([#437](https://github.com/PrimeIntellect-ai/prime-agent/pull/437) by [@snimu](https://github.com/snimu)).
- Changed top-level CLI help to show concise common options and commands without loading runtime resources ([ENG-4688](https://linear.app/primeintellect/issue/ENG-4688/help-command-is-obscenely-verbose)).
- Fixed completed subagents cancelling their RLM heartbeats before the first run ([ENG-4652](https://linear.app/primeintellect/issue/ENG-4652/subagent-heartbeats-dont-work)).
- Changed the fullscreen follow shortcut from `Alt+Down` to `Ctrl+Shift+Down` for more reliable terminal input ([ENG-4684](https://linear.app/primeintellect/issue/ENG-4684/altdown-doesnt-work)).
- Added user-requested model selection for subagents with bounded account-authorized discovery and explicit parent-model fallback warnings ([ENG-4649](https://linear.app/primeintellect/issue/ENG-4649/allow-subagents-to-use-a-different-model-than-the-parent-agent)).
- Added subtle feature hints to longer-running agent turns ([ENG-4521](https://linear.app/primeintellect/issue/ENG-4521/add-subtle-hints-for-new-prime-agent-features)).
- Fixed active heartbeats not resuming after Prime Agent updates ([ENG-4657](https://linear.app/primeintellect/issue/ENG-4657/heartbeats-dont-survive-updatesdaemon-reboots)).
- Fixed the Agents View reordering sessions whenever prompts or heartbeats updated their activity timestamps ([ENG-4650](https://linear.app/primeintellect/issue/ENG-4650/agents-view-shifts-session-list-constantly)).
- Added parent-scoped subagent lifecycle APIs: create children with readable default or orchestrator-chosen names, recover running or completed children through `rlm.list_subagents()`, continue them through agent messaging, and close/remove them with `rlm.delete_subagent()`.
- Changed shell commands to use discoverable agent, schedule, package, model, session, update, doctor, and full-shutdown verbs without exposing the background daemon hierarchy ([ENG-4538](https://linear.app/primeintellect/issue/ENG-4538/standardize-bash-command-conventions-and-improve-command-discovery)).
- Fixed unsupported Node versions crashing before startup by requiring Node 22.8.0 or newer and showing upgrade guidance before loading the CLI ([ENG-4260](https://linear.app/primeintellect/issue/ENG-4260/incorrect-node-version-breaks-first-launch)).
- Added `@` file-path autocomplete to new-agent and reply prompts in the Agents View.
- Fixed slow daemon clients becoming stuck when newer session snapshots arrived during catch-up.
- Fixed queued messages getting stranded when an agent turn ended ([ENG-4653](https://linear.app/primeintellect/issue/ENG-4653/queued-messages-can-get-stuck-with-heartbeats)).
- Changed `/traces upload-all` to pace requests within the platform rate limit, honor bounded `Retry-After` responses, and support interruption.
- Fixed resuming a daemon-resident session to attach the requesting client to its existing worker without disturbing other clients ([ENG-4656](https://linear.app/primeintellect/issue/ENG-4656/resuming-prime-agent-sessions-should-attach)).
- Fixed daemon-owned updates terminating their updater before the daemon restart and session restore completed ([ENG-4606](https://linear.app/primeintellect/issue/ENG-4606/benign-error-on-prime-agent-update)).
- Fixed first-launch Prime login and kept onboarding visible between team and model selection ([ENG-4658](https://linear.app/primeintellect/issue/ENG-4658/fix-onboarding-login-enter-key-and-model-selector-flicker)).
- Fixed active heartbeat sessions appearing under Needs Input or Completed instead of a dedicated Heartbeats section ([ENG-4654](https://linear.app/primeintellect/issue/ENG-4654/categorize-heartbeat-sessions-as-working)).
- Fixed stashed prompts being lost when leaving and reopening a session from the Agents View ([ENG-4659](https://linear.app/primeintellect/issue/ENG-4659/stashed-prompts-should-persist)).
- Added a combined heartbeat indicator and manager for pausing, resuming, or stopping user and agent heartbeats ([ENG-4536](https://linear.app/primeintellect/issue/ENG-4536/add-heartbeat-observability-and-management-ui)).

## [0.3.1] - 2026-07-15

- Added `/fast` for OpenAI Fast mode on supported ChatGPT models ([ENG-4620](https://linear.app/primeintellect/issue/ENG-4620/add-support-for-gpt-fast-mode-maybe-fast)).
- Changed wrapped diff rows to use a blank hanging gutter.
- Fixed team-gated Prime Inference routes being missing from model selectors by merging the authenticated team catalog during model refresh ([ENG-4645](https://linear.app/primeintellect/issue/ENG-4645/internalglm-52-fast-isnt-working)).
- Added confirmation when fullscreen text selection copies to the clipboard ([ENG-4644](https://linear.app/primeintellect/issue/ENG-4644/copy-issues)).
- Added an agent-run edit total above the recap.
- Changed edit tool calls to always show full diffs while keeping IPython source collapsed until Ctrl+O expands it.
- Changed tool expansion hints to appear only on the latest tool row instead of every tool call ([ENG-4583](https://linear.app/primeintellect/issue/ENG-4583/too-many-ctrlo-alerts)).
- Changed IPython kernels to set `NO_COLOR=1`, preventing ANSI color escapes from inflating `%%bash` output.
- Fixed update restarts starting concurrent daemon supervisors or unlinking a replacement supervisor's socket ([ENG-4600](https://linear.app/primeintellect/issue/ENG-4600/prevent-concurrent-daemon-supervisors-after-update-restart)).
- Fixed worker recovery races and made daemon shutdown-all converge across hidden supervisors ([ENG-4603](https://linear.app/primeintellect/issue/ENG-4603/serialize-worker-recovery-and-make-shutdown-all-converge)).
- Changed provider, model, and MCP setup to use one tabbed configuration menu ([ENG-4539](https://linear.app/primeintellect/issue/ENG-4539/unify-providers-models-and-mcp-connections-menu)).
- Changed the shared configuration menu to show prominent, responsive tabs with configurable navigation shortcuts ([ENG-4534](https://linear.app/primeintellect/issue/ENG-4534/make-login-tabs-more-obvious)).
- Fixed IPython edit diffs replacing syntax highlighting with a single foreground color ([ENG-4616](https://linear.app/primeintellect/issue/ENG-4616/syntax-highlighting-is-overridden-in-diff-view)).
- Fixed Prime Inference login leaving new sessions without a persisted model selection ([ENG-4573](https://linear.app/primeintellect/issue/ENG-4573/prompt-for-model-selection-after-prime-inference-login)).
- Fixed empty prompt placeholders hiding the input caret.
- Fixed automatic model selection preferring other configured providers over Prime Inference's GLM 5.2 default.
- Fixed missing ripgrep blocking subagents and added actionable installation guidance for the optional search helper ([ENG-4572](https://linear.app/primeintellect/issue/ENG-4572/ripgrep-not-installed)).
- Removed the shared worker snapshot spill cache to prevent concurrent workers from deleting each other's snapshot chunks ([ENG-4601](https://linear.app/primeintellect/issue/ENG-4601/remove-shared-worker-snapshot-spill-cache-directories)).
- Fixed narrow slash-command descriptions ending abruptly or clearing the prompt background, and added a content-sized popup above the input with the same distinct surface as `/btw` ([ENG-4542](https://linear.app/primeintellect/issue/ENG-4542/command-descriptions-are-cut-off-on-narrow-screens)).
- Fixed snapshot transfers terminating resident workers, stranding partial readers, or rejecting identical retries ([ENG-4602](https://linear.app/primeintellect/issue/ENG-4602/make-snapshot-transfers-idempotent-and-non-fatal)).
- Fixed the resume picker opening on an older session instead of the newest session ([ENG-4630](https://linear.app/primeintellect/issue/ENG-4630/show-latest-sessions-first-in-resume-list)).
- Fixed tool-only responses rendering directly against the preceding user prompt.

## [0.3.0] - 2026-07-13

- Changed daemon and headless execution to isolate each root session tree in a recoverable worker process, with protocol-v2 chunked snapshots, compact streaming, attachment-local backpressure, session leases, and unchanged print, JSON, and RPC interfaces.
- Added autonomous mode with host-side continuations, configurable limits, and quality gates for evaluator-controlled runs ([#278](https://github.com/PrimeIntellect-ai/prime-agent/pull/278) by [@sethkarten](https://github.com/sethkarten)).
- Added `/traces preview` and `/traces upload-all` for inspecting the current payload and backfilling saved parent and subagent traces.
- Changed `/traces upload` and `/traces upload-all` to be explicit one-shot uploads that do not enable automatic sharing.
- Changed trace uploads to retry transient network and HTTP failures with bounded exponential backoff and jitter.
- Fixed Prime Inference credential and team-header precedence to prefer `PRIME_API_KEY`, then the Prime CLI config, then `auth.json`.
- Fixed aborted autonomous gates leaving detached process trees and supervisor recovery retaining intentionally stopped workers after stale scheduler locks.
- Fixed supervisor replacement surfacing fatal socket errors or recovering roots that were intentionally stopped ([ENG-4526](https://linear.app/primeintellect/issue/ENG-4526/reconnect-daemon-clients-transparently-after-supervisor-replacement)).
- Fixed daemon catch-up snapshots being disposed mid-transfer or triggering resets that cleared drafts, local queues, dialogs, active UI state, or in-flight reasoning traces.
- Fixed compact daemon streams occasionally duplicating the first token of an assistant response.
- Fixed subagent prompts and usage counters flickering or disappearing during daemon resyncs and large parallel runs, and added compact fixed-width recap rows.
- Fixed stale heartbeat jobs reopening sessions after they were archived, deleted, explicitly shut down, concurrently terminated, or lost resident worker ownership ([ENG-4519](https://linear.app/primeintellect/issue/ENG-4519/heartbeats-rebirth-sessions-that-were-previously-killed)).
- Fixed heartbeat starvation by moving durable schedules into per-session artifacts and running them concurrently in their owning resident workers, independent of supervisor replacement ([ENG-4527](https://linear.app/primeintellect/issue/ENG-4527/dispatch-heartbeats-concurrently-across-isolated-session-workers)).

## [0.2.9] - 2026-07-13

- Changed tool call groups to use one blank row above and below without blank rows between consecutive calls.
- Changed the session tree to show only user messages by default.
- Changed agent-to-agent messages to render as directional rows, with received messages expandable in chat and sent messages shown below their Python cell ([ENG-4531](https://linear.app/primeintellect/issue/ENG-4531/collapse-and-simplify-agent2agent-messages-in-chat-tui)).
- Fixed IPython state restore notices rendering as full user messages when prompts were queued or restored ([ENG-4530](https://linear.app/primeintellect/issue/ENG-4530/collapse-ipython-state-restore-messages-in-chat-tui)).
- Changed bare `/mcp` to open the Services menu while preserving explicit `list`, `login`, and `logout` subcommands ([ENG-4535](https://linear.app/primeintellect/issue/ENG-4535/open-services-mcp-menu-from-mcp)).
- Added `/btw` and `/side` for one-turn inline side questions that use the current context without changing the main session ([ENG-4509](https://linear.app/primeintellect/issue/ENG-4509/add-btw-and-side-side-question-flows)).
- Changed scheduled heartbeat prompts to steer (interrupt the current turn) by default, with a `steer`/`follow_up` delivery mode selectable via `/heartbeat --steer|--follow-up` and the `rlm_heartbeat` skill's `delivery_mode` argument.
- Changed the new-chat splash to show only version, model, and cwd metadata and rotate among five example prompts.
- Fixed self-updates losing restored daemon sessions to a socket cleanup race and leaving open session or agents-view windows disconnected.
- Changed daemon connection errors to report the failed operation, session identity, recovery steps, socket, and diagnostic log instead of raw protocol reasons.
- Changed the Agents View and new-chat splashes to keep one blank row above the butterfly.
- Fixed Agents View retrying after an intentional daemon shutdown instead of stopping with restart guidance.
- Fixed stale heartbeat jobs reopening archived, deleted, or concurrently terminated sessions ([ENG-4519](https://linear.app/primeintellect/issue/ENG-4519/heartbeats-rebirth-sessions-that-were-previously-killed)).
- Fixed onboarding blocking normal TUI use by reopening login or model selection after startup ([ENG-4537](https://linear.app/primeintellect/issue/ENG-4537/stop-onboarding-from-gating-normal-tui-use)).
- Fixed IPython Bash cells with leading blank lines being labeled and previewed as Python ([ENG-4529](https://linear.app/primeintellect/issue/ENG-4529/leading-newline-before-percentpercentbash-names-tool-call-as-python)).
- Fixed recap layout shifts by keeping the previous recap visible until its replacement arrives ([ENG-4533](https://linear.app/primeintellect/issue/ENG-4533/reserve-space-for-recap-to-prevent-layout-shift)).
- Changed the new-chat tray to hide shortcut guidance while typing and keep the `agents` link visible.

## [0.2.8] - 2026-07-09

- Added built-in Herdr integration that reports agent lifecycle state to Herdr panes automatically, without requiring `herdr integration install pi`.
- Changed Escape to interrupt active work with a visible abort notice, double Escape to open the session tree from an empty prompt or clear an idle draft, and `?` to show shortcuts ([ENG-4489](https://linear.app/primeintellect/issue/ENG-4489/rewire-prime-agent-shortcuts-to-match-claude-code-flow)).
- Changed new-chat guidance to show concise shell, command, file, and shortcut hints, with Agents View first and `? for shortcuts` after the model and effort ([ENG-4489](https://linear.app/primeintellect/issue/ENG-4489/rewire-prime-agent-shortcuts-to-match-claude-code-flow)).
- Changed `?` shortcut help to appear as a temporary compact panel below the transcript, while `/hotkeys` shows the full reference without Ctrl+Z ([ENG-4489](https://linear.app/primeintellect/issue/ENG-4489/rewire-prime-agent-shortcuts-to-match-claude-code-flow)).
- Fixed Escape repeats around autocomplete, queued draft restoration, whitespace-only drafts, and active background work ([ENG-4489](https://linear.app/primeintellect/issue/ENG-4489/rewire-prime-agent-shortcuts-to-match-claude-code-flow)).
- Fixed the agents-view splash shifting when opening an agent session ([ENG-4517](https://linear.app/primeintellect/issue/ENG-4517)).
- Changed `/model` to sort featured flagship models above a provider's long tail (with a numeric-aware alphabetical tiebreak), so the full Prime Inference catalog doesn't flood the picker.
- Fixed selector prompts and choices filling their background through the terminal's right edge.
- Changed automatic harness refinement to be enabled by default while keeping `autoRefine.enabled: false` as the opt-out.
- Fixed non-numeric `autoRefine.turnInterval` and `autoRefine.cooldownMs` settings falling back to defaults instead of silently enabling a noisy auto-refine loop.
- Fixed all session-resume entry points to share a searchable full-screen picker, stream results while loading, and support renaming ([ENG-4513](https://linear.app/primeintellect/issue/ENG-4513/resume-in-agents-view-is-broken)).

## [0.2.7] - 2026-07-08

- Changed subagent and refinement guidance to favor non-blocking subagent tasks by default, use disk-backed tracking for long-running fan-out, inspect or message live subagents when agent observation/messaging skills are available, and capture reusable delegation roles, procedures, facts, preferences, and prompt addendums with `/refine`.
- Changed `attach_image` to resize and compress large inline image attachments before storing them for rendering and replay ([#340](https://github.com/PrimeIntellect-ai/prime-agent/pull/340) by [@sethkarten](https://github.com/sethkarten)).
- Fixed heartbeat and goal continuation prompts rendering like ordinary user messages ([ENG-4482](https://linear.app/primeintellect/issue/ENG-4482/heartbeat-message-should-have-a-different-ui-from-user-message)).
- Fixed `/heartbeat` guidance to show `stop` and the `every <duration> <instruction>` interval syntax ([ENG-4484](https://linear.app/primeintellect/issue/ENG-4484/improve-heartbeat-command-syntax-guidance-in-ui)).
- Fixed Ctrl+C canceling the active turn, bash command, and IPython kernel execution deterministically, with a compact recovery prompt and model-visible reset notice when an interrupted IPython cell keeps running ([ENG-4490](https://linear.app/primeintellect/issue/ENG-4490)).
- Fixed login dialogs in fullscreen so sign-in URLs can be selected natively ([ENG-4480](https://linear.app/primeintellect/issue/ENG-4480/new-fullscreen-tui-makes-it-impossible-to-copy-login-url)).
- Fixed `/model` opening and selection staying blocked on live model refreshes ([ENG-4505](https://linear.app/primeintellect/issue/ENG-4505/model-ui-is-extremely-slow)).
- Fixed provider auth failures leaving stale credentials shown as connected in `/login` ([ENG-4491](https://linear.app/primeintellect/issue/ENG-4491/mark-provider-stale-after-repeated-401s)).
- Fixed typing into the prompt after highlighting an inline subagent ([ENG-4494](https://linear.app/primeintellect/issue/ENG-4494/allow-typing-after-highlighting-a-subagent)).
- Fixed session-targeted heartbeat jobs staying scheduled after sessions are killed or saved sessions are deleted ([#332](https://github.com/PrimeIntellect-ai/prime-agent/pull/332)).
- Fixed self-updates interrupting and automatically resuming daemon sessions instead of waiting for long-running work to finish.
- Fixed provider errors being surfaced instead of retried within the retry budget ([ENG-4503](https://linear.app/primeintellect/issue/ENG-4503/restarting-old-session-returns-empty-model-response)).
- Fixed Agents View returning from fullscreen sessions without flashing primary scrollback ([ENG-4508](https://linear.app/primeintellect/issue/ENG-4508/fullscreen-mode-agents-view-scroll)).

## [0.2.6] - 2026-07-06

- Fixed the installer splash flickering during animation and resize by stabilizing full-screen redraws and removing misleading synthetic percentages ([ENG-4481](https://linear.app/primeintellect/issue/ENG-4481/installer-screen-is-unstable-and-flickery)).
- Fixed Prime Inference auth syncing with Prime CLI login and team selection.
- Fixed provider auth failures showing provider-specific `/login` commands instead of the `/login` selector.
- Removed the legacy pi-mono `bash` and `edit` built-in tools; use IPython `%%bash` cells and the Python `edit` skill instead.

## [0.2.5] - 2026-07-06

- Added daemon-backed user orchestration with agent-to-agent messaging and read-only observation of active sessions ([#207](https://github.com/PrimeIntellect-ai/prime-agent/pull/207) by [@sethkarten](https://github.com/sethkarten)).
- Added an orchestration heartbeat skill for compact multi-session progress, blocker, and action summaries ([#207](https://github.com/PrimeIntellect-ai/prime-agent/pull/207) by [@sethkarten](https://github.com/sethkarten)).
- Added an opt-in auto-refine review hook that can ask whether `/refine` should run after turn intervals or compaction checkpoints ([#201](https://github.com/PrimeIntellect-ai/prime-agent/pull/201) by [@sethkarten](https://github.com/sethkarten)).
- Added opt-in fullscreen mode with a scrollable transcript, pinned prompt bar, mouse selection, and `/fullscreen` controls ([#316](https://github.com/PrimeIntellect-ai/prime-agent/pull/316)).
- Added prompt stashing so a draft can be temporarily saved, a separate prompt or command can run, and the draft is restored afterward ([#321](https://github.com/PrimeIntellect-ai/prime-agent/pull/321)).
- Added resume support to the agents view so stored sessions can be attached and managed without leaving the view ([#318](https://github.com/PrimeIntellect-ai/prime-agent/pull/318)).
- Added subagent delegation guidance to encourage parallel and background `rlm` calls when recursion is available ([#306](https://github.com/PrimeIntellect-ai/prime-agent/pull/306) by [@alexzhang13](https://github.com/alexzhang13)).
- Changed fullscreen TUI rendering to be enabled by default ([#325](https://github.com/PrimeIntellect-ai/prime-agent/pull/325)).
- Changed `--resume` to accept an optional session path or ID ([#319](https://github.com/PrimeIntellect-ai/prime-agent/pull/319)).
- Changed the installer onboarding splash to show ordered setup phases with a percentage instead of cycling detail text ([#327](https://github.com/PrimeIntellect-ai/prime-agent/pull/327), [ENG-4376](https://linear.app/primeintellect/issue/ENG-4376/onboarding-instructions-should-be-accurate-to-whats-happening)).
- Changed provider stream failures to show classified diagnostics and request IDs, with structured agent logs for debugging ([#313](https://github.com/PrimeIntellect-ai/prime-agent/pull/313)).
- Fixed daemon-hosted extensions sharing the wrong Herdr pane environment across concurrent sessions ([#303](https://github.com/PrimeIntellect-ai/prime-agent/pull/303)).
- Fixed parallel subagent guidance failing on first use by pre-importing `asyncio` in the IPython kernel bootstrap ([#315](https://github.com/PrimeIntellect-ai/prime-agent/pull/315)).

## [0.2.4] - 2026-07-01

- Changed the agents view to list only sessions the daemon is actively holding, and stopped the daemon from auto-restoring on-disk sessions on startup, so a restarted daemon no longer surfaces a wall of weeks-old sessions; sessions come back via `/resume` or `--resume` ([#295](https://github.com/PrimeIntellect-ai/prime-agent/issues/295)).
- Changed the kernel install progress line to name the current step and show a percentage instead of a static message ([#293](https://github.com/PrimeIntellect-ai/prime-agent/issues/293)).
- Changed the CLI to honor a `--` end-of-options separator, so arguments after it are passed through instead of parsed as flags ([#296](https://github.com/PrimeIntellect-ai/prime-agent/issues/296)).
- Changed provider stream failures to retry transient errors (content filter trips and prose 5xx responses) instead of failing the turn ([#297](https://github.com/PrimeIntellect-ai/prime-agent/issues/297)).
- Fixed IPython and bash tool calls failing for the rest of a run after a session was rebuilt, by rebinding built-in tools to the live runtime at call time ([#299](https://github.com/PrimeIntellect-ai/prime-agent/issues/299)).
- Fixed the kernel venv not rebuilding when the bundled runtime source changed, by tracking a content hash of the runtime (including its `pyproject.toml`) in the staleness check ([#291](https://github.com/PrimeIntellect-ai/prime-agent/issues/291)).
- Fixed a large subagent fan-out spawning every IPython kernel at once and starving the machine, by bounding concurrent kernel boots (default `min(16, 2*cores)`, override with `PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS`) ([#294](https://github.com/PrimeIntellect-ai/prime-agent/issues/294)).
- Added a Python forkserver (on by default on Linux, opt out with `PRIME_AGENT_KERNEL_FORKSERVER=0`) that forks subagent kernels from one pre-imported template process instead of a full cold boot each time, with automatic fallback to direct spawn on any failure ([#298](https://github.com/PrimeIntellect-ai/prime-agent/issues/298), [#300](https://github.com/PrimeIntellect-ai/prime-agent/issues/300)).
- Fixed empty tool results on OpenAI-style providers being sent as a literal "(see attached image)" placeholder, which made models hallucinate a nonexistent image ([#290](https://github.com/PrimeIntellect-ai/prime-agent/issues/290)).

## [0.2.3] - 2026-06-30

- Added built-in Linear and Notion integrations that the agent drives from Python in the kernel (no new agent tools); each is a bundled skill that talks to the service's official MCP server and auto-discovers its tools. They ship disabled and turn on after you sign in via the Services tab in `/login` or `/mcp login`, with credentials stored in the existing `auth.json` ([#280](https://github.com/PrimeIntellect-ai/prime-agent/issues/280)).
- Added an `attach-image` skill that loads an on-disk image (PNG, JPEG, GIF, WebP) into the model's context as a viewable attachment so a vision-capable model can directly see screenshots, diagrams, charts, or scanned pages ([#274](https://github.com/PrimeIntellect-ai/prime-agent/issues/274)).
- Changed subagents to be first-class sessions: opening a subagent now attaches to its own session and renders through the same rich chat UI as the main conversation instead of a laggy parent-rebuilt transcript, finished subagents stay viewable in the list and sort below running ones, and the detail view shows the subagent's own recap and animated working status ([#282](https://github.com/PrimeIntellect-ai/prime-agent/issues/282)).
- Changed session lifecycle handling so the agents view now lists every live session (not only daemon-resident ones), fixing reports of sessions going missing; abandoned new chats that were never sent a message are discarded instead of lingering ([#269](https://github.com/PrimeIntellect-ai/prime-agent/issues/269)).
- Changed the IPython kernel to stay alive across compaction: variables, imports, and helpers the agent defined are no longer wiped, and the model is instead told which names remain defined ([#267](https://github.com/PrimeIntellect-ai/prime-agent/issues/267)).
- Changed local slash commands like `/context`, `/system-prompt`, `/logs`, `/changelog`, and `/hotkeys` to echo the typed command into the chat so their output is anchored to a visible command instead of floating ([#270](https://github.com/PrimeIntellect-ai/prime-agent/issues/270)).
- Changed session recaps to use a non-reasoning model (Qwen3-30B instruct), which reliably closes the recap tag instead of occasionally surfacing a dangling "..." ([#284](https://github.com/PrimeIntellect-ai/prime-agent/issues/284)).
- Changed the heartbeat scheduler to defer `/heartbeat` and internal heartbeat cron jobs while the target session is already working, rescheduling the next interval instead of piling a prompt onto a busy agent ([#265](https://github.com/PrimeIntellect-ai/prime-agent/issues/265)).
- Changed `Ctrl+O` on IPython and bash cells to keep the same summary line in place and just attach the full code and output beneath it (aligned under the code gutter), instead of restructuring the block on expand ([#288](https://github.com/PrimeIntellect-ai/prime-agent/issues/288)).
- Removed the "call at most one built-in tool per turn" instruction from the system prompt, allowing the agent to invoke multiple built-in tools in a single turn ([#210](https://github.com/PrimeIntellect-ai/prime-agent/issues/210)).
- Fixed historical session replay re-emitting inline terminal image escape payloads; history now shows lightweight image fallback labels while live tool results still render images inline ([#281](https://github.com/PrimeIntellect-ai/prime-agent/issues/281)).
- Fixed pressing back from a subagent opened directly from the agents view dropping you into the parent's chat; it now returns to the agents view, with a "back to agents" hint ([#271](https://github.com/PrimeIntellect-ai/prime-agent/issues/271)).
- Fixed the agents view resetting the highlight to the first row when returning to it; selection now sticks to the session you had open across reorders and reattaches ([#268](https://github.com/PrimeIntellect-ai/prime-agent/issues/268)).
- Fixed freshly created chats being titled by their session ID until their file flushed; they are now titled by their first prompt immediately ([#264](https://github.com/PrimeIntellect-ai/prime-agent/issues/264)).
- Fixed opening a session from the agents view failing when its original working directory no longer exists; it now opens in a fallback directory with a notice instead of breaking ([#287](https://github.com/PrimeIntellect-ai/prime-agent/issues/287)).

## [0.2.2] - 2026-06-25

- Added a bundled `websearch` skill (Google search via the Serper API) that loads by default. Add a Serper key via `/login` ("Serper (web search)"); it is stored with your other credentials and supplied to the skill automatically. The skill can be disabled with `bundledSkills.websearch: false` and overridden by a same-named skill in any user, project, package, or `--skill` location ([#86](https://github.com/PrimeIntellect-ai/prime-agent/issues/86)).
- Added image input support for vision-capable Prime Inference models (Claude, GPT-5.x, Grok, Kimi K2.7 Code, Qwen3-VL), which previously dropped attached images as unsupported ([#261](https://github.com/PrimeIntellect-ai/prime-agent/issues/261)).
- Added a live subagent tree above the working loader showing each in-flight subagent with a prompt excerpt, tool-use and token counts, and its recap once generated; finished subagents drop out of the tree ([#254](https://github.com/PrimeIntellect-ai/prime-agent/issues/254)).
- Changed the prompt bar to show the active model and thinking level on the left and always show context token count and percentage used on the right, instead of only surfacing context usage past the halfway point ([#252](https://github.com/PrimeIntellect-ai/prime-agent/issues/252)).
- Changed the `/model` picker to rank results by most-recently-used, so models you actually pick float to the top and break ties among equally-good fuzzy matches ([#251](https://github.com/PrimeIntellect-ai/prime-agent/issues/251)).
- Changed the collapsed bash and IPython tool previews to pick the most informative line via a shared heuristic, skipping low-signal setup lines and redacting long blobs and secret-looking values ([#248](https://github.com/PrimeIntellect-ai/prime-agent/issues/248)).
- Changed subagents to render as an inline, scrollable list below the prompt with arrow-key navigation and prompts that elide shared prefixes, replacing the full-screen subagent viewer; running subagents and in-progress markers now animate so the agent never looks crashed ([#247](https://github.com/PrimeIntellect-ai/prime-agent/issues/247)).
- Fixed context overflow appearing at ~50% remaining for Prime Inference Claude models by correcting their context window to 200k and counting prompt tokens only (excluding output) for the context indicator and compaction trigger ([#246](https://github.com/PrimeIntellect-ai/prime-agent/issues/246)).

## [0.2.1] - 2026-06-23

### Fixed

- Fixed daemon session recaps disappearing while a new turn regenerated them ([#239](https://github.com/PrimeIntellect-ai/prime-agent/issues/239)).
- Fixed bundled built-in skills missing from the packaged release layouts ([#240](https://github.com/PrimeIntellect-ai/prime-agent/issues/240)).

## [0.2.0] - 2026-06-23

### Added

- Added `/effort` (alias `/thinking`) to set the reasoning level, with argument autocomplete that lists the levels the current model supports.
- Added a `/system-prompt` command that shows the exact prompt last sent to the model, labelling it honestly when no turn has run yet.
- Added a `/rename` alias for `/name` and a `Ctrl+R` shortcut in the Agents View to rename the selected session inline.
- Added support for feeding pasted images into model context: pasted images become atomic editor markers, are validated and resized, held in a bounded registry, and dropped when the active model lacks vision.
- Added edit diffs to the collapsed IPython view, rendering file edits as a wrapped, full-width relative-path diff prefixed with the cell status marker.

### Changed

- Replaced the `Shift+Tab` thinking-level cycle with the `/effort` command, exposing a `max` thinking level on Claude models that support it.
- Changed the `/goal` and `/effort` commands to stay highlighted in the editor while their argument is being typed.
- Changed queued follow-up messages to render below the execution indicator.
- Changed the RLM system prompt to align its shared sections exactly with rlm-harness, including the environment block and pre-installed package hints.
- Changed trace uploads to be observable and resilient: failures surface the underlying cause, outcomes are logged to `agent-traces.log`, `/traces` shows the resolved endpoint, and transient failures retry once.

### Fixed

- Fixed Prime Agent formatting breaking when resizing to a small screen, where tool-output colors bled into the padding at narrow widths.
- Fixed onboarding showing no models after entering a provider key by refreshing the scoped model list after login.
- Fixed silent daemon replacement reading as random crashes by logging shutdown/replacement decisions, and offering to stop a stale-version daemon at startup instead of erroring out.

### Performance

- Improved session load, context building, and listing to scale linearly: file loads decode per line over a raw buffer, and branch/context building uses push+reverse instead of per-entry unshift.
- Improved daemon responsiveness under large session loads by parsing session files off the event loop, so loading one big session no longer freezes the other sessions the daemon hosts.

## [0.1.9] - 2026-06-22

### Added

- Added the Prime brand splash to the new-chat view.

### Changed

- Changed daemon attach to send slimmer snapshots and to avoid saved-session disk scans in the Agents View, speeding up switching between sessions.

### Fixed

- Fixed daemon out-of-memory crashes when listing saved sessions by streaming the listing, preserving large session row metadata, and ignoring oversized tool rows when computing session activity.

## [0.1.8] - 2026-06-21

### Added

- Added `daemon shutdown --all` to stop every Prime Agent daemon on the machine, hardened against recycled PIDs and able to force-kill wedged daemons.
- Added git context to session traces: each trace records the repository URL, branch ref, and HEAD commit, captured at end of turn and carried over when a session is forked.

### Changed

- Changed `prime-agent` to open a new chat by default at launch instead of the previous session, with the daemon session created lazily on the first message and empty chats discarded on quit.
- Changed sending a message from the Agents View to open the chat for that session.
- Changed model resolution to persist the selected model across updates and default Prime Inference to Claude Opus 4.8 when no model has been chosen.

### Fixed

- Fixed `prime-agent` attaching to a stale daemon left running by a previous version after self-update: `update` now stops the old daemon and starts the new version (confirming first when busy sessions would lose work), and a stale daemon that cannot be replaced fails loudly instead of a silent broken attach. Both shutdown paths now poll the socket until it stops listening, so a transient hiccup cannot spawn a duplicate daemon.

## [0.1.7] - 2026-06-18

### Added

- Added session and RLM heartbeats: a persistent, user-controlled heartbeat re-prompts a long-running session on a schedule via daemon-backed cron jobs, exposed through the `heartbeat` slash command and a bundled `rlm-heartbeat` Python skill, plus a `cron` CLI command to list jobs.

### Changed

- Changed collapsed IPython tool calls in the TUI to render as a single-line summary instead of a multi-line block.

## [0.1.6] - 2026-06-17

### Added

- Added a `daemon ps` CLI command that lists every Prime Agent daemon running on the machine, with confirmation before shutdown and guards against killing a shared or still-reachable daemon.
- Added opt-in trace uploads: `/traces` enables background upload of persisted session JSONL files to the Prime Inference trace endpoint.
- Added agent summaries and live status to Agents View, generated daemon-side per session and refreshed on sweep.
- Added crash-stack capture for the daemon: output routes to a rotating per-socket log file under `<agentDir>/logs/`, client-side crashes write to `client-errors.log`, and a `/logs` command shows the log directory.

### Changed

- Changed startup notices (app-update, extension-update, and tmux warnings) to surface on the Agents View instead of being appended to every chat session.

### Fixed

- Fixed IPython kernel state being lost across session resume: kernel variables are now snapshotted under session-artifacts, restored on resume, deleted with the session, and dropped on compaction.
- Fixed the viewport jumping when toggling tool-output expansion in the TUI; the viewport now stays anchored across expand/collapse.
- Fixed non-persisted (e.g. `/tmp`) sessions creating an RLM working directory they did not need.

## [0.1.5] - 2026-06-16

### Added

- Added rich syntax-aware diff rendering for IPython file edits in the TUI: the `edit` Python skill emits structured edit results that the interactive view renders as a colored, full-width unified diff inside the cell.
- Added a subagent spawn-program panel to Agents View: expand a subagent group and press `Ctrl+O` to toggle a panel showing the IPython cell that called `rlm.run` to spawn them.
- Added slash-command alias resolution so command aliases resolve to their canonical command consistently across interactive mode and Agents View, including in autocomplete.

### Changed

- Moved goals out of the harness tool surface into a bundled `goal` Python skill (`goal.get` / `goal.create` / `goal.complete`) backed by session state; the only built-in tool is now `ipython`, and the `rlm.run` comm channel is generalized into a typed host bridge.
- Changed the RLM system prompt to prefer Python for reading and searching files, porting the IPython guidance from rlm-harness.
- Spaced out the Agents View shortcut hints for readability.

### Fixed

- Fixed slow opening of long agent sessions: the JSONL socket reader is now O(n) instead of O(n^2) on large records, the session tree is fetched lazily instead of embedded in the attach snapshot, `SessionManager.open()` no longer parses the session file twice, and context building avoids copying every entry on the hot path.
- Fixed `open()` to stay consistent with the full loader when a session file begins with a blank line.
- Fixed goal-completion usage accounting that could overcount tokens.

## [0.1.4] - 2026-06-15

### Added

- Added a `/refine` command and a session-backed `rlm.harness` continual-learning state (prompt notes, memory, reusable skills, and subagent specs) that persists globally across sessions, with explicit CRUD methods, a refinement log, and global rollback. The compact harness overview is injected into the system prompt, and `/refine` re-reads state before applying so concurrent writes are not clobbered.
- Added an `edit` built-in Python RLM skill for targeted single-occurrence string replacement in existing files, callable from the kernel or as a shell command.

### Changed

- Changed the IPython control prompt to require `%%bash` as the first line of a shell cell to match the rlm-harness.

## [0.1.3] - 2026-06-12

### Added

- Added a `/context` command showing a tree overview of the main agent and all sub-agents with per-agent tokens, cost, and context-window usage, plus session totals and a token/cost breakdown.
- Added `/clear` as an alias for `/new`.

### Changed

- Changed `/usage` to be an alias for the new `/context` command.

### Fixed

- Fixed the stale "no models available" warning appearing for sessions that already have a working model.
- Fixed the `!` and `!!` bash shortcuts in interactive mode by running bash through the agent connection, restoring streaming output, history, and Ctrl+C abort for both in-process and daemon-attached clients.

## [0.1.2] - 2026-06-12

### Fixed

- Fixed the model selector showing no models after logging in with Prime Inference during onboarding by reloading auth storage from disk when the model registry refreshes ([#151](https://github.com/PrimeIntellect-ai/prime-agent/issues/151)).

## [0.1.1] - 2026-06-11

### Fixed

- Fixed first launch to run onboarding before opening the Agents View ([#147](https://github.com/PrimeIntellect-ai/prime-agent/issues/147)).
- Fixed multiline status errors in Agents View to render as a single flattened line so they cannot overlap the input ([#146](https://github.com/PrimeIntellect-ai/prime-agent/issues/146)).
- Fixed slash commands in the main Agents View ([#149](https://github.com/PrimeIntellect-ai/prime-agent/issues/149)).

## [0.1.0] - 2026-06-11

### Breaking Changes

- Changed `InteractiveMode` construction to require an `AgentConnection` and explicit UI services or local session host.

### Added

- Added a two-step `Ctrl+X` stop/delete interaction for selected agents in Agents View.
- Added a daemon-backed Agents View as the default local interactive entrypoint.
- Added versioned daemon protocol metadata, sequenced session events, attach snapshots, replay status, and artifact references for future Swarm gateway wrapping.
- Added an `AgentConnection` client boundary with in-process and daemon adapters for interactive-mode decoupling.
- Added daemon mode and CLI controls for starting on demand, creating, listing, attaching, detaching, killing, renaming, and prompting live sessions.
- Added rich TUI attach for already-active daemon sessions via `--session <selector>` and live `daemon <selector>` shorthand.
- Added a built-in `skill-creator` skill that teaches the agent to create new skills: markdown layout, frontmatter rules, placement and precedence, and the Python-backed skill contract (package layout, `run()` convention, optional CLI, kernel venv behavior) with a test-verified working template.
- Added built-in skills shipped with prime-agent, starting with `prime-intellect`: ecosystem knowledge and prime CLI workflows for verifiers environments, evaluations, Hosted Training, sandboxes, inference, and compute. Built-in skills have the lowest precedence (user, project, and package skills with the same name win) and can be disabled with the `enableBuiltinSkills` setting or `--no-skills`.
- Added a session-backed `rlm.harness` state helper for reset-free prompt notes, memory, skills, subagent specs, and refinement events.
- Added `/refine` to update editable harness state with Create/Update/Delete edits and rollback support based on refinement history.

### Changed

- Changed Agents View `Ctrl+C` handling to mirror the interactive chat view: the first press shows a bottom hint and the second exits Prime Agent.
- Changed keybinding hints to render arrow keys as `↑`, `↓`, `←`, and `→`.
- Changed Agents View to keep transient status and reply text out of the agent list area.
- Changed Agents View `Ctrl+X` so the first press only stops sessions that are actively running.
- Changed daemon-owned chat sessions opened from Agents View to show a `← agents` tray hint when the input is empty.
- Changed active session creation to use per-session runtime config so active sessions can use different cwd, model, auth, and tool settings.
- Changed interactive `Ctrl+C` to interrupt the current operation first and exit only on a second press while the exit hint is visible; `Escape` now clears the input bar without interrupting the agent.
- Changed the IPython system prompt section to use the upstream rlm-harness IPYTHON_CONTROL_PROMPT: IPython is framed as a persistent control environment, not the target project's runtime. Shell commands should use `%%bash` cells instead of `!cmd` escapes. The agent should not install dependencies into the IPython kernel but use the project's own environment instead.
- Removed the `.venv` interpreter hint from the system prompt (no longer needed with the control-environment framing).

### Fixed

- Fixed confusing transcript formatting around thinking blocks and tool calls: ipython cells and default-shell tools (bash and extension tools) now share one panel style with a subtle neutral background instead of a status-colored box or a left rail, and tool status headers name the tool (`python · done · 7ms`, `bash · running`) so they no longer read as floating labels for the preceding thinking block. Themes gain a required `toolPanelBg` color for the panel background.
- Fixed `prime-agent` to detect a daemon left running by a previous version after self-update: the daemon now reports its app version on connect, and idle stale daemons are restarted automatically (daemons with active sessions are left running with a warning).
- Fixed Agents View listing daemon-owned subagents as top-level selectable agents instead of nested child rows.
- Fixed Agents View opening saved or stale sessions by creating a daemon runtime from the saved session file before attaching.
- Fixed Agents View delete confirmation so the red stopped confirmation expires after two seconds without removing the stopped session row.
- Fixed Agents View selected-row highlighting so it spans the full terminal width after prompt wrapping changes the layout.
- Fixed Agents View prompt bar to show a placeholder for creating a new session.
- Fixed Agents View opening sessions with the dashboard cwd's model registry, which could incorrectly show the model selector for daemon-owned sessions from another cwd.
- Stopped showing changelog entries automatically on install, first launch, and update startup.
- Fixed multi-line IPython, assistant, and child-agent errors to collapse internal tracebacks by default while preserving full details on expand.
- Fixed child-agent navigation to show contextual keybinding hints and a visible focused tray marker.
- Fixed the release installer to ask before bootstrapping the IPython kernel runtime during install, avoiding default first-run `uv` prompts inside the TUI.
- Fixed browser sign-in links to show plain URLs when terminal hyperlinks are unsupported.
- Fixed the release installer splash to keep its logo geometry stable across terminal resizes.

### Removed

- Removed the interactive `!` / `!!` bash shortcuts; use IPython for shell commands.

## [0.0.10] - 2026-06-08

### Added

- Added an inline input prompt indicator to the interactive editor.
- Added contextual keybinding hints and a visible focused tray marker for child-agent navigation.
- Added OS-specific shortcut labels in keybinding hints, rendering `Cmd`/`Option` on macOS and capitalized key names elsewhere.

### Changed

- Changed the IPython system prompt to the upstream rlm-harness `IPYTHON_CONTROL_PROMPT`: IPython is framed as a persistent control environment rather than the target project's runtime, shell commands use `%%bash` cells instead of `!cmd`, and project imports, tests, and dependency checks run through the project's own environment. Removed the `.venv` interpreter hint.
- Changed interactive `Ctrl+C` to interrupt the current operation first and exit only on a second press while the exit hint is visible; `Escape` now clears the input bar without interrupting the agent.
- Changed the Prime theme to tone down the flashy neon purple and lime green in favor of a calmer dusty lavender and sage green.

### Fixed

- Fixed missing ripgrep to surface a clean inline warning at startup and fail sub-agent runs with a clear message, while routing kernel diagnostics into captured stderr.
- Fixed IPython kernel startup to avoid blocking the session, cancelling child RLM runs on session abort and reporting bootstrap progress through a start-options handler.
- Fixed the subagent tool-expansion keybinding so it toggles expanded tool output inside the child-agent detail view.
- Fixed browser sign-in links to show plain URLs when the terminal does not support hyperlinks.
- Fixed the auth selector to preserve the selected provider's login type.
- Stopped showing changelog entries automatically on install, first launch, and update startup.

## [0.0.9] - 2026-06-04

## [0.0.8] - 2026-06-04

### Added

- Added an `onboardingCompleted` setting and a dedicated Prime Inference onboarding splash that prompts users authenticated only via the Prime CLI to choose a model before their first turn.

### Changed

- Changed the system prompt to frame the agent as a general-purpose agent that uses code to solve tasks rather than a pure coding agent, with guidance that shell state does not persist across `!cmd`/`%%bash` cells while Python kernel state does.

### Fixed

- Fixed the onboarding flow so model selection, manual API-key entry, cancellation, and the "model already ready" path all resolve correctly and mark onboarding complete instead of re-prompting on every launch.
- Fixed the release installer to ask before bootstrapping the IPython kernel runtime during install (defaulting to bootstrap when no terminal is detected) and to avoid stalling on an interactive `uv` prompt.

## [0.0.7] - 2026-06-01

### Added

- Added Prime team selection during Prime Inference login so team inference costs use the selected Prime CLI context.
- Added Python-backed skills that install into the persistent IPython kernel and are exposed alongside markdown skills.

### Changed

- Changed the Prime Agent install script to use a bounded animated Prime Lab splash with centered progress and confirmation prompts.
- Changed startup onboarding to guide unauthenticated users through login and model selection before the first agent turn.
- Changed installer npm and Node.js setup progress to keep command output hidden behind the splash and rotate detail text.

### Fixed

- Fixed update notifications and package docs to point at `prime-agent update` and use compact one-line alerts.
- Fixed Prime CLI credentials from `prime login` to make Prime Inference models available on startup.
- Fixed first-run search helper downloads to run quietly instead of printing over onboarding.
- Fixed stale no-model and tmux/update startup notices from appearing during successful onboarding.

### Removed

- Removed the unused small Prime logo export.

## [0.0.6] - 2026-05-27

### Changed

- Changed installer startup so npm and Node.js setup output stays hidden behind the bounded Prime splash with rotating detail text.
- Changed `postinstall` to optionally bootstrap the `fd` and `rg` search helpers (gated by an env flag) alongside the kernel, and made search-helper downloads default to silent.

### Fixed

- Fixed Prime Inference auth so credentials from `prime login` are read from the Prime CLI config and surfaced as a `prime_cli` auth source, making Prime Inference models available on startup without a separate login.
- Fixed initial model selection to skip a saved default model that no longer has configured auth.
- Fixed first-run search-helper downloads to run quietly instead of printing over onboarding.

## [0.0.5] - 2026-05-26

### Added

- Added a centered-overlay menu system for onboarding and a redesigned Prime onboarding splash and Prime Inference login dialog with browser sign-in plus a manual API-key fallback.
- Added theme support for adapting interactive surfaces to the detected terminal foreground/background colors.

### Changed

- Changed startup onboarding to guide unauthenticated users through login and model selection before the first agent turn.
- Changed the model selector and OAuth/provider selectors to render as centered surface menus rather than inline CLI lists.
- Changed update and package-update notifications to compact one-line alerts pointing at `prime-agent update`.

## [0.0.4] - 2026-05-21

### Added

- Added system prompt note listing pre-installed Python packages (requests, httpx, pyyaml, tomli, python-dotenv, pandas, numpy, scipy, beautifulsoup4, lxml, pydantic).
- Added `DEFAULT_RLM_EXTRA_UV_ARGS` constant and kernel bootstrap installation of those packages; updated prompt to reference the constant instead of a hardcoded list.

### Fixed

- Fixed the RLM kernel package prompt to show importable module names and reject `PRIME_AGENT_KERNEL_PYTHON` overrides missing default kernel packages.

## [0.0.2] - 2026-05-20

### Added

- Added a persistent `ipython` tool backed by a Jupyter kernel so Python variables and imports survive across tool calls.
- Added the RLM harness system prompt and `prime-agent-runtime` bridge so IPython code can call `rlm.run` to spawn recursive child agent sessions.
- Added automatic IPython runtime bootstrap with uv-managed Python, `ipykernel`, and `prime-agent-runtime`.
- Added subagent UI surfaces for recursive runs, including compact tray status, full-width detail views, and structured child transcripts rendered like the main chat.
- Added `/goal` for long-running objectives that continue after normal follow-ups drain until the model marks the goal complete.
- Added a pi-style installer script and R2-backed private npm tarball release pipeline for Prime Agent.
- Added Prime Inference as a selectable built-in OpenAI-compatible provider with `PRIME_API_KEY` authentication and `openai/gpt-5.5` as the default model.
- Added a first-class `/login` Prime Inference browser auth flow that imports usable Prime CLI credentials or obtains a new key through the Prime challenge flow.
- Added `/usage` to show token, cost, and context usage on demand.

### Changed

- Changed the default active built-in tool set to `ipython`.
- Changed compaction to restart the active IPython kernel so summarized sessions release in-memory Python state.
- Changed recursive background work to use normal Python async tasks with `rlm.run` instead of a separate RLM background API.
- Changed completed IPython cell rendering to use width/version-aware caching, reducing TUI redraw lag in long sessions.
- Changed collapsed IPython cells to show compact input and output previews with a single expansion hint.
- Changed auto-compaction checks to use the current context estimate and stop between long tool-loop turns before resuming after compaction.
- Changed the goal status UI to use a compact lower-tray indicator instead of repeating the full objective in chat.
- Changed IPython prompt guidance to prefer `!cmd` and `%%bash` for shell commands.
- Changed kernel bootstrap to prompt before installing `uv` and skip postinstall bootstrap unless explicitly enabled.
- Changed the app update check and self-update flow to read the Prime Agent release manifest and install manifest tarballs directly.

### Fixed

- Fixed tarball self-updates to install the tarball without first uninstalling the same logical package.
- Fixed IPython kernel startup to let `ipykernel` bind OS-assigned ports instead of randomly selecting fixed ports.
- Fixed RLM child usage aggregation so parent session totals include recursive child runs after session reloads.
- Fixed the RLM child-agent detail viewer to render messages, thinking, and tool output with the main chat presentation, open at the latest transcript output, and use terminal scrollback for native scrolling.
- Fixed `rlm.run` comm handlers to log failures and drain in-flight child runs during kernel disposal.
- Fixed raw tab rendering in TUI-backed transcript views so painted backgrounds survive indentation.
- Fixed auto-compaction threshold checks during trailing context and tool-result growth.

### Removed

- Removed install/update telemetry pings to `pi.dev` and the related setting and environment override.
- Removed the RLM background API; recursive agents now use `rlm()`/`rlm.run()` with normal Python async tasks for background work.
- Removed the legacy `read`, `write`, `grep`, `find`, and `ls` built-in tools.
- Removed the local TPS extension that posted token/cache stats after each agent response.

## [0.0.1] - 2026-05-18

### Added

- Initial Prime Agent release, forked from pi-mono: a persistent `ipython` tool backed by a Jupyter kernel as the default tool set, recursive RLM subagents via `rlm.run`, `/goal` for long-running objectives, an auto-bootstrapped uv-managed kernel runtime, Prime-branded TUI, and an R2-backed tarball release pipeline with a pi-style installer.
