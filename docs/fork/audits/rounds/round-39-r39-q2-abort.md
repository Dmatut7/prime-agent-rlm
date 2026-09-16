# r39-Q2 — abort 边界的队列语义：中止后排队命令的命运条件表

- 仓：/Users/a1/Desktop/ai/prime-agent，HEAD `e8f6527dc44a548d961cdf336bd514bcafa24fa7`，**只读**（本线零仓内写入）
- 线名：r39-q2-abort；心跳：`/tmp/audit_r/round-39/r39-q2-abort-heartbeat.txt`
- 探针：`/tmp/audit_r/round-39/r39-q2-abort-probe/abort-fate.probe.test.ts`（5/5 绿，3.8s）
  - 跑法：`cd /tmp/audit_r/round-39/r39-q2-abort-probe && env -u RLM_DEPTH -u RLM_SESSION_DIR -u PRIME_AGENT_SESSION_DIR -u PI_SESSION_DIR node /Users/a1/Desktop/ai/prime-agent/node_modules/vitest/dist/cli.js --run abort-fate.probe.test.ts`
  - 目录内 `node_modules`/`pa` 是指向仓的符号链接；本地 `vitest.config.ts` 复刻仓内 alias（`@earendil-works/pi-ai` → `packages/ai/src/index.ts` 等）。
- 所有 file:line 均为冻结 SHA `e8f6527d` 上的行号。
> **SHA 钉定说明（审计中途 HEAD 移动）**：本线开跑时 HEAD = `e8f6527d`，写报告时仓已被别的车道推进到 `74113284`（`git log e8f6527..74113284`：4 个提交，含 `fix(coding-agent): close the r39 liveness tails`）。核对结果：`git diff --name-only e8f6527 74113284` **不含** `agent-session.ts` / `session-action-store.ts` / `slash-commands.ts` / `interactive-mode.ts` / `in-process-agent-connection.ts`（逐字未变，故本报告所有 AS/SAS/IM 行号对两个 SHA 都成立）；只有 `daemon-mode.ts` 变了（+31 行），所以**本报告所有 DM 行号钉在 `e8f6527`**，冻结副本已存 `/tmp/audit_r/round-39/frozen/daemon-mode.ts`。当前 HEAD 上的等价行号：`case "abort"` 4602→4621、`case "mutate_queued_message"` 4943→4962、`case "abort_and_clear_queue"` 4959→4978、`case "resume_queue"` 4553→4572、`case "restore_actions"` 4540→4559、`getSessionActionRecoverySnapshot()` 6462→6485、`acquireQueuedWorkPause()` 6611→6634、`waitForSessionInputCheckpoint` 6613→6636、`abortForUpdateRestart()` 6920→6943、`wakeSuspendedSessionInput()` 1970→1989。探针是在 HEAD 移动**之前**跑的，但因 AS/SAS 未变，结论对两个 SHA 同样成立。

-`agent-session.ts` 简称 AS，`session-action-store.ts` 简称 SAS，`daemon-mode.ts` 简称 DM。

---

## 0. 结论速览

| # | 命题 | severity | 状态 |
|---|---|---|---|
| Q2-F1 | `mutateQueuedMessage` 走 `resumeQueuedWork()`（无栅栏检查）→ 抬掉 update-restart 栅栏并把排队消息开成 turn | high | **母席已独立实测复现**（/tmp/r39-q1/fence-probe.ts）；本线补：`compact()` 的 10127 同样无栅栏检查 + `epoch++` 副作用 |
| Q2-F2 | `abortForUpdateRestart` 不做 R1 的同步 settle：已投递的 queue-dispatched turn 停在 `running`，且该行不入 restart manifest | medium | **本线实测**（T2 + T2-PC 正控） |
| Q2-F3 | `session_command` 在 `running` 态对**所有** abort 入口既不取消也不 settle（两个 helper 都是 turn-only） | low | 静态推断（unverified） |
| Q2-F4 | `clearQueue()` 不取消 invisible turn（RLM terminal notice）；`abort_and_clear_queue` 靠随后的 `requestAbort` 补第二刀 | info | 静态 + 代码注释自证 |
| Q2-F5 | 已修且有测试锁住的格子（防重复报） | info | 见 §5 |

---

## 1. abort 入口枚举（含每个入口对泵/栅栏/epoch 的写）

| 入口 | file:line | `_sessionInputPumpSuspended` | `_sessionInputSuspendedForUpdateRestart` | `_sessionInputPumpEpoch++` | 对 store 的动作 |
|---|---|---|---|---|---|
| `requestAbort({reason?})` | AS:9467-9505 | `= true`（9475） | `= false`（9476，**清栅栏**） | 是（9474） | `_demoteRlmTerminalNoticeActions()`（9481）→ `_cancelSessionActions(turn && !queueVisible && !durableNotice)`（9482-9488）→ `_settleAbortedDispatchedTurnActions()`（9489）→ `_cancelPostCompactionContinue/abortRetry/abortCompaction/abortBranchSummary/abortBash`（9490-9494）→ `agent.abort(cause)`（9502） |
| `abort()`（async） | AS:9557-9573 | 同 `requestAbort` | 同上 | 同上 | 额外 `_abortRlmSubtree("Parent session aborted")`（9561）+ 等 `agent.waitForIdle()` / `_agentEventQueue` / compaction / branchSummary |
| `abortForUpdateRestart()` | AS:9575-9597 | `= true`（9580） | `= true`（9581，**立栅栏**） | 是（9579） | **完全不碰 store**：不 cancel、不 settle、不 demote；只 `_cancelPostCompactionContinue()` + `abortRetry()` + `_abortRlmSubtree` + `agent.abort()`（无 cause） |
| stall watchdog | AS:4991 `this.requestAbort({ reason: "stall_watchdog" })` | 同 requestAbort | 同 | 同 | 与用户 Esc **逐字同一条代码路径**；`reason` 只影响 `_lastTurnAbortReason`（9468）与 `agent.abort(formatIpythonAbortCause(...))`（9502-9504）。队列命运无差异（静态，high confidence） |
| Esc / Ctrl-C（TUI） | interactive-mode.ts:7014 `void this.agentConnection.abort()`（仅 `if (this.isAgentStreaming())`；旁路 abortRetry/abortCompaction/abortBranchSummary/abortBash 在 7000-7012） | → in-process-agent-connection.ts:441 `this.session.requestAbort()`；daemon 侧 → DM:4604 `case "abort"` | | | 注释自证：`// The queue is preserved server-side; draining resumes on the next submit or queued-message edit.`（interactive-mode.ts:7011-7012）——**这句注释正是 Q2-F1 的用户可见入口** |
| `abort_and_clear_queue` | DM:4959-4964；in-process-agent-connection.ts:245-248 | 先 `clearQueue()` 再 `requestAbort()` | | | 见 §2 的 clearQueue 行 |
| `clearQueue()` | AS:8716-8742 | 不写 | 不写 | 仅当有 `preparing` 的 turn 时 `++`（8720-8722） | 取消 clearable 中 `session_command ∪ queueVisible`（8717-8719）；**invisible turn 不在内** |
| RLM 子级 kill / 父级取消 | `cancelRlmChildRun` AS:14187；`_cancelRlmChildRun` AS:12915-12935；`_abortRlmSubtree` AS:12864-12913（12892 对 streaming 的后代调 `requestAbort({reason:"user"})`） | 只影响被中止的那个 session 自己 | | | 12926 / 14192：`if (this._sessionInputPumpSuspended) this._abandonRlmRunForQuiescence(run)`（泵挂起时不再等终态通知） |
| `compact()` 内部 abort | AS:10155 `if (!options.skipAbort) await this.abort();` | 同 requestAbort（**清栅栏**） | | | 10127 `if (preemptedAutoCompaction) this.resumeQueuedWork();`（**无栅栏检查**，见 Q2-F1b） |
| `dispose()` | AS:5640-5700 | 不写（`_disposed=true` 让 `_scheduleSessionInputPump` 8071 与 `_isBusyForSessionInput("pump")` 8305 直接短路） | | | `_persistUndeliveredWorkBeforeDispose()`（5681 → 6750）后 `_cancelSessionActions(() => true, deliveryError)`（5693）——`candidates` 默认 `clearableActions()`，**committing/running 不取消** |
| `abortCompaction/abortRetry/abortBash/abortBranchSummary` | AS:9491-9494 等 | 不写 | 不写 | 不写 | 间接：`_clearQueuedAutonomousContinuations`（3826-3846）取消排队中的自主续跑 action；`_clearQueuedGoalContinuationAfterCancelledThresholdCompaction`（3810-3824）回滚 goal 续跑并回退 `continuationsUsed` |

> 没有名为 `abortForDispose` 的符号（`grep -rn "abortForDispose" packages/*/src` 空）。dispose 走 AS:5640 的 `dispose()`。

---

## 2. 主条件表：中止后排队命令的命运

结果取值：**执行** / **丢弃(cancel)** / **悬置(parked，等唤醒)** / **已投递不可回收(durable)** / **同步 settle(failed)**。

行 = abort 入口，列 = action 生命周期 × 可见性。

### 2.1 `requestAbort()`（= Esc = Ctrl-C = stall watchdog = daemon `abort` = `abort()` 的第一步）

| action 状态 / 类型 | 结果 | file:line 逐字证据 |
|---|---|---|
| `queued` turn，`queueVisible: true`（用户 steer/followUp、agent-message 回复、可见心跳、goal/autonomous 续跑） | **悬置** | AS:9482-9488 谓词含 `!action.payload.queueVisible`；`_createPreparedTurnAction` 默认 `queueVisible: options.queueVisible ?? true`（AS:7863）。实测：`agent-session-parked-queue.test.ts:33-35` `expect(harness.session.queuedActionCount).toBe(1); expect(harness.session.isQueuedWorkSuspended).toBe(true);` |
| `queued` turn，`queueVisible: false`（direct prompt、`sendCustomMessage{triggerTurn}` AS:8655） | **丢弃** | AS:9487 `new Error("Prompt aborted before delivery.")`；`_cancelSessionActions` AS:2615 `this._actionStore.remove(...)` → SAS:230 `transitionSessionAction(action, { state: "cancelled" })` → AS:2656 `releaseTerminal` |
| `queued` RLM 子级终态通知（durable notice，`queueVisible:false` 但在 `_durableRlmTerminalNoticeActionIds`） | **降级回 next-turn 队列**（不是丢弃） | AS:9481 `_demoteRlmTerminalNoticeActions()`；7106-7122：`this._pushPendingNextTurnMessages(cloneCustomMessage(message))` 后 cancel，错误串 `"RLM child terminal notice deferred across session input suspension."` |
| `queued` / `selected` `session_command`（`/compact` `/refine` `/goal` `/autonomous`，SAS 无关；名单 slash-commands.ts:13） | **悬置** | AS:9482-9488 谓词首条 `action.payload.kind === "turn"` ⇒ 命令永不匹配。**本线实测 T1**：abort 后 `unfinishedActionCount` 保持 1，静置 250ms 仍 1，`wakeSuspendedSessionInput()` → true 后 250ms 变 0 |
| `selected`（turn 或 command） | **回队 queued ⇒ 悬置** | 泵 AS:8095-8101 `if (epoch !== this._sessionInputPumpEpoch) { if (preselected) { this._actionStore.rollback(preselected); ... } return; }`；命令腿 AS:8251-8255 `if (this._isSessionInputHandoffDeferred(epoch) ...) { this._actionStore.rollback(action); ... return; }` |
| `preparing`，primary 未投递 | **回队 queued ⇒ 悬置** | AS:8177-8187：`_isDeferredSessionInputError` 为真（epoch 变，AS:8325）⇒ `this._actionStore.rollback(action)` |
| `preparing`，primary 已 durable | **不可达（静态）** | `durable` 只在 AS:8169 由 transcript 反推；`agent.prompt()` 在 AS:8443 转 `committing` 之后才发生，故 `preparing` 期 primary 不可能在 transcript 里。标 unverified-by-construction |
| `committing`，primary 未 durable | **回队 queued ⇒ 悬置**（需 rollbackProof） | AS:8179-8183 `this._actionStore.rollback(action, { dispatchSettled: true, transcript })`；SAS:114-124 校验 proof 且拒绝回滚 durable primary |
| `committing` / `running`，primary 已 durable，`queueVisible` 或 durable notice | **同步 settle = failed（消息留在 transcript，不可回收）** | AS:9528-9555；9538 `(primaryDeliveryRecord(action).durable \|\| transcript.includes(...))`；9542-9543 `primaryDeliveryRecord(action).durable = true; transitionSessionAction(action, { state: "failed", error })`，`error = new Error("Prompt aborted after delivery.")`（9530）。**实测 T2-PC**：`requestAbort()` 后 `unfinishedActionCount` 1→0（同步断言，无 tick） |
| `committing` / `running`，primary 已 durable，`queueVisible:false` 的 **direct prompt** | **不 settle**（故意） | AS:9518-9522 逐字：`a direct (non-queued) prompt is awaited by its caller and driven through the ordinary abort flow, and settling it with an error would reject a prompt() that previously resolved normally on abort` |
| `running` **session_command** | **既不取消也不 settle；命令自己跑完**（unverified） | AS:9482（turn-only）+ AS:9536（`action.payload.kind === "turn"`）⇒ 两个 helper 都放过命令；命令在 AS:8263-8285 的 try/catch/finally 里自行走到 `completed`/`failed` 并 `releaseTerminal`。`/compact`、`/refine` 会被 9491-9492 的 `abortCompaction()`/`_refineAbortController?.abort()` 打断从而收尾 |
| in-flight turn 的 delivery record（primary 已 durable） | **已投递不可回收** | AS:9513-9514 逐字：`The delivered messages stay in the transcript; only the action lifecycle ends.` |
| 未投递的 `next_turn` / `prefix` 记录 | **退回 `_pendingNextTurnMessages`** | AS:2637-2659：`restorable` 过滤 `record.role === "next_turn" \|\| (acceptedAgentMessage && role === "prefix")` 且 `!record.durable`，`_unshiftPendingNextTurnMessages(...restorableMessages)` |

### 2.2 `abort_and_clear_queue`（= clearQueue 然后 requestAbort）

| action | 结果 | 证据 |
|---|---|---|
| `queued/selected/preparing` 的 `session_command` 与 `queueVisible` turn | **丢弃** | AS:8717-8719 + 8738 `_cancelSessionActions(...)`，错误 `"Queued agent message was cleared before delivery."`（8730） |
| `queued` 的 invisible turn（含 durable RLM notice） | clearQueue **放过**，随后 requestAbort 处理（notice → 降级；其它 → 丢弃） | AS:8719 的过滤条件不含 invisible turn；第二刀见 §2.1 |
| `preparing` turn | clearQueue 先 `epoch++` 让在飞的准备失效 | AS:8720-8722 |

### 2.3 `abortForUpdateRestart()`（DM:6920，close reason `"update"`）

| action | 结果 | 证据 |
|---|---|---|
| 一切 `queued`（turn 可见/不可见、session_command、durable notice） | **悬置在栅栏后，写入 restart manifest** | AS:9576-9577 逐字：`queued inputs must survive into the restart manifest instead of starting a turn during teardown`；DM:6462 `actions: session.getSessionActionRecoverySnapshot()` |
| `selected` / `preparing` / `committing`(未 durable) | **回队 queued ⇒ 进 manifest** | 快照前 DM:6611 `acquireQueuedWorkPause()` + DM:6613 `waitForSessionInputCheckpoint(signal)`；AS:9113-9123 的 `blocksCheckpoint()` 恰好覆盖 `selected`/`preparing`/`committing && !durable`，等泵把它们回队 |
| `committing`(已 durable) / `running` turn | **不同步 settle；且不进 manifest ⇒ 只能靠 transcript 恢复** | AS:9575-9597 无 `_settleAbortedDispatchedTurnActions()`；SAS:263-265 `snapshotActions() { return this.queuedActions(); }` + AS:9009 只用 `snapshotActions()`。**实测 T2**：`abortForUpdateRestart()` 后同步断言 `unfinishedActionCount === 1`、state `running`、`getSessionActionRecoverySnapshot().actions.length === 0` |
| `running` session_command | 同上，且 `blocksCheckpoint()` 会**等它跑完**才允许快照 | AS:9115-9117 `if (action.payload.kind === "session_command") return action.lifecycle.state === "selected" \|\| action.lifecycle.state === "running";`（`running` → queued 是非法迁移，SAS:100-108，故只能等或靠 signal 取消） |

### 2.4 `dispose()`

| action | 结果 | 证据 |
|---|---|---|
| `queued/selected/preparing`（任意类型） | **先持久化再丢弃** | AS:5679-5681 逐字 `B1 后半: dropping the queue here used to be silent ... Persist first, then clear.`；5693 `_cancelSessionActions(() => true, deliveryError)` |
| `committing/running` | **停在原地，永不终态**（进程随即退出） | `_cancelSessionActions` 的 `candidates` 默认 `clearableActions()`（AS:2604 / SAS:246-248 `CLEARABLE_STATES = queued,selected,preparing`） |

---

## 3. 唤醒条件表：abort 之后谁能把悬置的队列放出来

`_scheduleSessionInputPump()` 首行即栅栏：AS:8070 `if (this._sessionInputPumpSuspended || this._queuedWorkPauses.size > 0) return;`
`_resumeSessionInputAdmission()`（AS:9278-9293）**无条件**清 `_sessionInputPumpSuspended` **和** `_sessionInputSuspendedForUpdateRestart`，并 `epoch++`、清 failure-wake 计时器、`_reflowUndeliveredRlmNotices()`、`_flushDeferredRlmTerminalNotices()`。

| 中止后到达的输入 | 普通 abort（栅栏 down） | update-restart（栅栏 up） | file:line |
|---|---|---|---|
| TUI 提交 / `prompt()` / slash command（`resumeIfIdle !== false` 且 `!isStreaming`） | **唤醒**（连带放出整个 backlog） | `_assertSessionActionAdmissionAvailable()` 抛 `SessionInputSuspendedError` | AS:7210-7213、7919-7931 |
| `steer()` / `followUp()` 默认（`resumeIfIdle` undefined ⇒ `wake: "on_lower_boundary"` / `"external_resume"`） | **不唤醒，悬置** | 同 | AS:7871-7876、7988-8002；`agent-session-parked-queue.test.ts:31-36` |
| 连接层 `steer/followUp`（`resumeIfIdle: true` ⇒ `wake:"immediate"`） | **唤醒** | `_admitSessionInput` 的 resume 被栅栏挡住，仅排队 | in-process-agent-connection.ts:437/443；AS:7996-8000 `if (!this._sessionInputSuspendedForUpdateRestart) this._resumeSessionInputAdmission();` |
| 子代理回复 `queueAgentMessagePrompt` | **默认不唤醒**（C2：`failure_aggregated`）；仅 `getSubagentWakePolicy() === "always"` 时 `wakeSuspendedSessionInput()` | 同（wake 自身有栅栏） | AS:6242-6261、6267/6276 |
| 失败类终态通知（`RLM_CHILD_FAILURE_CUSTOM_TYPE`） | 每个静默窗**一次**聚合唤醒；唤醒是**泵级、无法按消息过滤**（F11），会把整个 backlog 一起放出 | `_maybeBufferFailureWake` 直接 return；`_deliverAggregatedFailureWake` 也 return | AS:6961-6968、7021-7055；7013-7019 逐字 `The wake itself is pump-level ... it cannot be filtered per message` |
| 心跳 tick（cron 侧） | `wakeSuspendedSessionInput()` ⇒ **唤醒并排干** | **返回 false，栅栏不动** | DM:1970；AS:9303-9308；`fixq3-heartbeat-wakes-stranded-queue.test.ts:42-73 / 75-108` |
| 心跳注入 `promptHeartbeat`（`resumeIfIdle: true`） | AS:7132 resume ⇒ 唤醒 | 不 resume ⇒ `_acquireDirectTurnAdmissionFence` 抛 `SessionInputSuspendedError`（**响亮失败，下一 tick 重试**） | AS:7130-7134；fixq3 测试 75-108 |
| `sendCustomMessage({triggerTurn:true})` | 唤醒 | 不唤醒（栅栏检查在 8646） | AS:8645-8647 |
| TUI 空编辑器 Enter / daemon `resume_queue` | `resumeQueuedWorkFromConnection()` ⇒ 唤醒 | **返回 false** | AS:9331-9334；DM:4553-4561；parked-queue 测试 45-86 |
| **daemon `mutate_queued_message`（编辑/删除排队消息）** | 唤醒 | **⚠ 唤醒（抬栅栏）——Q2-F1** | AS:8837 / 8884 → `resumeQueuedWork()`（AS:9311-9316，无栅栏检查）；DM:4943-4951 |
| `compact()` 抢占了在飞 auto compaction | 唤醒 | **⚠ 唤醒（抬栅栏）——Q2-F1b** | AS:10127 `if (preemptedAutoCompaction) this.resumeQueuedWork();`（同文件 AS:10250 的 `if (!this._updateRestartFenceUp) this.resumeQueuedWork();` 有检查，形成自相矛盾） |
| `restoreSessionActions()`（重启后恢复） | 用 `{ restore: true }` 入队，**不 wake 不 schedule** | 同 | AS:7610-7622、7988（`!options.restore` 短路）；恢复后由谁 resume 未在本线追到 ⇒ **unverified** |

---

## 4. 发现（逐条）

### Q2-F1 · `mutateQueuedMessage` 抬掉 update-restart 栅栏（**already-known：母席 r39-Q1 已独立实测复现**）

- 命题：连接层可达的 `mutate_queued_message`（编辑或删除一条排队消息）会调 `resumeQueuedWork()`，后者无条件 `_resumeSessionInputAdmission()`，把 `_sessionInputSuspendedForUpdateRestart` 一起清掉并 `epoch++`，于是排队消息在 teardown 期间被开成 turn——违反 AS:9323-9330 自己写下的不变量。
- severity：**high**
- file:line：AS:8837（delete 分支）、AS:8884（replace / 换 lane 分支）→ AS:9311-9316 → AS:9278-9282；对照 AS:9331-9334 的 `resumeQueuedWorkFromConnection()` 有 `if (this._updateRestartFenceUp) return false;`。活体入口 DM:4943-4951 `case "mutate_queued_message"`（调用在 DM:4945）。
- 逐字证据：
  ```ts
  // AS:9310-9316
  /** Resume the scheduler after requestAbort/abortForUpdateRestart suspended it; owned pause leases are unaffected. */
  resumeQueuedWork(): boolean {
      this._resumeSessionInputAdmission();
      this._maybeResumeGoalContinuationAfterRlmWork();
      this._scheduleSessionInputPump();
      return this._hasSelectableSessionInput();
  }
  // AS:9278-9282
  private _resumeSessionInputAdmission(): void {
      if (!this._sessionInputPumpSuspended) return;
      this._sessionInputPumpSuspended = false;
      this._sessionInputSuspendedForUpdateRestart = false;
      this._sessionInputPumpEpoch++;
  ```
  ```ts
  // AS:9323-9330（不变量自述）
  /**
   * Resume requested by a live connection (TUI Enter on an empty editor, the
   * daemon resume_queue command). Never lifts the update-restart fence: queued
   * work must survive into the restart manifest instead of starting a new turn
   * during teardown (mirrors the triggerTurn and agent-message wake guards).
   * Recovery flows (post-restart restore, in-process unwedge) call
   * resumeQueuedWork() directly.
   */
  ```
  TUI 侧注释也把这条路指给用户：interactive-mode.ts:7011-7012 `// The queue is preserved server-side; draining resumes on the next submit or queued-message edit.`
- 母席实测（不重复复现，直接引用）：`abortForUpdateRestart` 后 `{suspended:true,count:2}`；正控 `resumeQueuedWorkFromConnection()` → `false` 且状态不变；随后 `mutateQueuedMessage("steering",1,"B",{type:"delete"})` → `status:"applied"`、`suspended:false`、`count:0`，剩余 steer "A" 被开成 turn（`userTexts ["start","A"]`）。探针：`/tmp/r39-q1/fence-probe.ts`。
- 本线补充（静态，high confidence）：
  1. **`epoch++` 副作用**：`_resumeSessionInputAdmission` 顺带 `_sessionInputPumpEpoch++`（AS:9282），所以这次抬栅栏不只放队列，还会作废任何在飞的准备/直接提交栅栏（AS:8095、8137、8325、7143、7226 的 epoch 比对），把当时正在 `preparing` 的 action 打回 `queued`。
  2. **第二个同类漏口**：AS:10127 `if (preemptedAutoCompaction) this.resumeQueuedWork();`（`compact()` 的 finally）同样没有栅栏检查，而同文件 AS:10250 明写 `if (!this._updateRestartFenceUp) this.resumeQueuedWork();` 且注释是 `Fork adaptation: a compaction must not lift the update-restart fence.`——同一个不变量在同一文件里一处守一处不守。可达性：`/compact` 作为排队 session_command 在 teardown 期被执行（AS:8486-8490，`skipAbort: true`），若此时恰有在飞 auto compaction 被抢占即触发。（此条**仅静态推断**，未实测。）
- 影响：栅栏的语义是"排队工作必须活到 restart manifest，而不是在 teardown 里开 turn"。抬掉后：(a) 排队消息在进程即将退出时开成 turn，产出可能不落盘；(b) 该 action 从 `queued` 变 `selected/preparing/running`，而 manifest 只收 `queued`（SAS:263-265），于是**这条消息在重启后彻底消失**（不是延迟，是丢）；(c) `epoch++` 顺带作废同时在飞的其它准备。
- 可复现：母席 `/tmp/r39-q1/fence-probe.ts`（已复现）；仓内最近的正控是 `test/suite/agent-session-parked-queue.test.ts:45` `"the connection resume path never lifts the update-restart fence (scan3-queue A8×Q1)"`——它只覆盖 `resumeQueuedWorkFromConnection`，**没有覆盖 `mutateQueuedMessage`**。
- confidence：**high**（母席实测 + 本线读码一致）
- 去重：`decisions.jsonl` 无此条（322 条里只有 5 条提到 abort：H-1 / DO-4 / MV-4 / R25-1 / K3R-11，均与本条无关）。**非 already-known（就 decisions.jsonl 而言）**，但已在 r39 本轮由 Q1 线独立发现。

### Q2-F2 · `abortForUpdateRestart` 不做 R1 的同步 settle，且该行不入 manifest

- 命题：R1 的修复（`_settleAbortedDispatchedTurnActions`）只挂在 `requestAbort` 上（AS:9489）。`abortForUpdateRestart`（AS:9575-9597）对已投递的 queue-dispatched turn 既不 cancel 也不 settle，该 action 同步停在 `running`；同时 restart manifest 只收 `queued`（`snapshotActions()`），所以这一行既没被收尾、也没被带走。
- severity：**medium**
- file:line：AS:9575-9597（无 settle 调用）对照 AS:9489 + 9528-9555；SAS:263-265 `snapshotActions(): readonly TAction[] { return this.queuedActions(); }`；AS:9006-9009。
- 逐字证据（实测输出，本线探针 T2 / T2-PC）：
  ```
  ✓ T2-PC requestAbort settles the delivered queue-dispatched turn (R1)  ->  unfinishedActionCount 1 → 0（同步断言，无 tick）
  ✓ T2 abortForUpdateRestart leaves the delivered queue-dispatched turn unfinished
      expect(harness.session.unfinishedActionCount).toBe(1);            // 通过
      expect(runningQueuedTurn()?.lifecycle.state).toBe("running");     // 通过
      expect(harness.session.getSessionActionRecoverySnapshot().actions.length).toBe(0);  // 通过
      stdout: T2 async outcome { unfinished: 0, state: 'released' }
  ```
  R1 自己的说明逐字（AS:9508-9516）：`The pump's deferred-error path only rolls back undelivered work, so a delivered action stuck in committing/running would never reach a terminal state: unfinishedActionCount stays nonzero forever, which keeps isSessionActive true and makes wait_for_idle and RLM quiescence hang.`
- 影响：分两种情形。
  - 情形 A（本线实测到的）：下层 faux/真实 run 因 `agent.abort()` 收尾 ⇒ 泵异步把它 settle 成 `completed`（stdout `unfinished: 0, state: 'released'`）。**只损失"同步性"**：在 `abortForUpdateRestart()` 返回到泵收尾之间，`unfinishedActionCount > 0`、`isSessionActive` 为真。谁在这段时间读它就会误判（例如 DM:6439 `isDiscardableDraft`、DM:7434 `busyOverride ?? (hasLiveSessionWork(state) || ...)`）。
  - 情形 B（**未实测，静态推断**）：若 abort 没能收尾下层 run——仓里明确存在这个状态，AS:4994-5007 的 `abort_unsettled` 分支就是为它写的（`the abort fired but the run never produced agent_end`）——则 R1 描述的"永挂"在 update-restart 路径上原样复现：`running` 永不终态，且因 `snapshotActions()` 只取 `queued`，manifest 里没有它。
- 可复现：`/tmp/audit_r/round-39/r39-q2-abort-probe/abort-fate.probe.test.ts` → `T2 abortForUpdateRestart leaves the delivered queue-dispatched turn unfinished`（情形 A 已实测）；情形 B 需要一个"abort 后 run 不收尾"的 faux provider，本线未构造 ⇒ 标 **unverified**。
- confidence：情形 A **high**（实测）；情形 B **low-medium**（静态）
- 去重：`decisions.jsonl` 无对应条目（R1 这个 id 在 decisions.jsonl 里是"回退位置只活在内存"，与 `r1-aborted-dispatched-turn-settles.test.ts` 的 R1 不是同一个命名空间）。

### Q2-F3 · `running` 态的 `session_command` 对所有 abort 入口都既不取消也不 settle

- 命题：`requestAbort` 的两个善后 helper 都是 turn-only，命令腿完全在 abort 语义之外。
- severity：**low**
- file:line：AS:9482-9488（谓词首条 `action.payload.kind === "turn"`）、AS:9536（`action.payload.kind === "turn" && (queueVisible === true || durableNotice)`）、AS:8241-8290（命令腿自跑，`isCancelled()` 只查 `cancelled`）、AS:9115-9117（`blocksCheckpoint` 会等 `running` 命令）。
- 逐字证据：AS:9536
  ```ts
  (action.payload.kind === "turn" &&
      (action.payload.queueVisible === true || this._durableRlmTerminalNoticeActionIds.has(action.id)) &&
      (action.lifecycle.state === "committing" || action.lifecycle.state === "running") &&
  ```
  以及 `LEGAL_TRANSITIONS`（SAS:100-108）：`running: new Set(["completed","failed","cancelled"])`，`running → queued` 非法 ⇒ 命令一旦 `running` 就不可能回队，只能等它自己走完。
- 影响：`/compact`、`/refine` 会被 `abortCompaction()`（AS:9492）与 `_refineAbortController?.abort()`（AS:9498）间接打断从而收尾；`abortForUpdateRestart` **连这两个都不调**（只 `abortRetry`），所以在栅栏路径上一个在飞的 `/compact` 会继续打 LLM，同时 `waitForSessionInputCheckpoint` 会一直等它（AS:9115-9117），把 update-restart 准备阶段拖到 transaction signal 取消为止。
- 可复现：**仅静态推断**（未构造在飞 `/compact` + `abortForUpdateRestart` 的用例；需要能 gate compaction 的 faux provider）。
- confidence：medium（读码路径清楚，未实测）

### Q2-F4 · `clearQueue()` 放过 invisible turn；两刀组合才是"全清"

- 命题：`clearQueue()` 只清 `session_command ∪ queueVisible`，RLM 终态通知这类 invisible turn 不在内；`abort_and_clear_queue` 因为随后还调 `requestAbort()` 才把它们处理掉（notice 降级、其余丢弃）。单独调 daemon `clear_queue`（DM:4954）时，invisible turn 会**留在队列里**并随下一次唤醒被执行。
- severity：**info**（看起来是刻意设计：durable notice 是"欠投递的工作"，AS:8940 注释 `Deferred RLM terminal notices are undelivered work: requestAbort demotes`）
- file:line：AS:8717-8719、DM:4954-4963、AS:8938-8941。
- confidence：high（静态，过滤条件逐字可读）

### Q2-F5 · 已修且有测试锁住的格子（**不要当新 bug 报**）

| 格子 | 锁它的测试 |
|---|---|
| 可见排队 turn 在普通 abort 后保留、`resumeQueuedWork()` 排干 | `test/suite/agent-session-parked-queue.test.ts:15` |
| 连接层 resume 不抬栅栏 | 同上 `:45`（`scan3-queue A8×Q1`） |
| R1：普通 abort 同步 settle 已投递的 queue-dispatched turn，`unfinishedActionCount → 0` | `test/suite/regressions/r1-aborted-dispatched-turn-settles.test.ts:27` |
| F1：泵挂起时 agent message **排队而不是硬失败**（P0-3a），wake policy `always` 才唤醒，栅栏不被 agent message 抬 | `f1-agent-message-wakes-suspended-pump.test.ts:56 / 97 / 125 / 152`；AS:6197-6211 |
| FIX-Q3：心跳 tick 唤醒被搁浅的队列；栅栏下心跳**不**唤醒且响亮失败 | `fixq3-heartbeat-wakes-stranded-queue.test.ts:42 / 75` |
| FIX-Q4 / ma-p0-3：延迟终态通知不被放弃、Esc 后一次聚合唤醒、唤醒放出整个 backlog（F11）、evict/rehydrate 后队列存活 | `fixq4-deferred-terminal-notice-abandonment.test.ts`、`ma-p0-3-esc-wake.test.ts:138/176/206/240/263/310`、`ma-p0-3-terminal-notice-persistence.test.ts` |
| FIX-Q8：终态通知 dispatch 期间 abort 也能收尾 | `fixq8-terminal-notice-dispatch-settles.test.ts:78-80` |
| 终态通知在 dispatch 中 settle | AS:9518-9526 注释 + 上述测试 |

---

## 5. 未覆盖 / unverified 格子清单（本线明确没验的）

1. **`abort_unsettled` × 队列**（Q2-F2 情形 B）：abort 打了但下层 run 不收尾时，`running` 的 queue-dispatched turn 是否真的永挂 + manifest 丢行。需要一个"忽略 abort signal"的 faux provider。
2. **`running` session_command × `abortForUpdateRestart`**（Q2-F3）：在飞 `/compact` 是否把 update-restart 准备阶段拖到 signal 取消。
3. **AS:10127 的 `resumeQueuedWork()` 抬栅栏**（Q2-F1b）：只有静态证据，未实测。
4. **`restoreSessionActions()` 之后谁 resume**：AS:7610-7622 用 `{restore:true}` 入队且不 schedule；DM:4540-4544 `restore_actions`（调用在 DM:4542）也不 resume。恢复后是否总有一次 `resumeQueuedWork()`（r6-update-restart-restore-after-restart 覆盖到什么程度）本线未追。
5. **`preparing` + primary durable**：判为不可达（构造性论证，见 §2.1），未做反证探针。
6. **`dispose()` 时 `committing/running` 的 action**：`_persistUndeliveredWorkBeforeDispose()`（AS:6750）是否把它们写进 sidecar，本线未读该函数体。
7. **`_queuedWorkPauses`（tree 导航 AS:15679、update-restart 准备 DM:6611）与栅栏的交互**：pause 释放时 `release()` 会 `_scheduleSessionInputPump()`（AS:9192），若栅栏已被 Q2-F1 抬掉，pause 释放即开 turn——本线未实测这个组合。
8. **stall watchdog 入口**：断言"与用户 Esc 队列命运逐字相同"是静态结论（同一函数、`reason` 只进 `_lastTurnAbortReason` 与 abort cause），未跑真看门狗。

---

## 6. 正控声明（铁则）

- **"悬置"探针的正控**：T1（abort ⇒ 命令 250ms 不动，wake ⇒ 排干）配 T1-PC（**不 suspend 泵**，同一条 `/goal status` 直接执行到 `unfinishedActionCount === 0`）与 T1-PC2（同样 park，但静置 250ms 断言仍为 1 后才 `resumeQueuedWork()` ⇒ 0）。⇒ "不执行"确由挂起造成，且探针在"该执行"的构造上确实报警。
- **"丢弃"探针的正控**：本线关于"丢弃"的结论（invisible turn 被 cancel）来自逐字谓词 AS:9482-9488，其**非 abort 路径不丢**的正控是同一条谓词在 `queueVisible: true` 上不匹配 —— 由 `agent-session-parked-queue.test.ts:15` 与 T1（session_command 完全不匹配谓词因而不丢）双向夹住。
- **"不同步 settle"的正控**：T2 与 T2-PC 在同一文件、同一 `gatedRun()` 构造下唯一差别是 `abortForUpdateRestart()` vs `requestAbort()`，前者同步 `1`、后者同步 `0`。
- 探针用了 `as unknown as { _actionStore ... }` 私有探测（沿用仓内 `r1-aborted-dispatched-turn-settles.test.ts:60-66` 的同一写法）。**该文件只存在于 /tmp，不入仓**，故不触 `check:test-hygiene`。

## 7. 与 `docs/fork/audits/decisions.jsonl` 去重

- `grep -i abort` 命中 5 条：`H-1`（abortAfterSeconds=0 语义）、`DO-4`（watchdog abort cause 只对 ipython 可见）、`MV-4`（aborted assistant 被 transform-messages 丢弃）、`R25-1`（并发 manual compact 无互斥）、`K3R-11`（manual abort 在飞 auto ⇒ 销毁排队续跑）。**均不与本线条件表的任何一格重合。**
- `grep -iE "suspend|pump|stranded|parked|fence|wake"` 命中 **0** 条 ⇒ abort×队列命运这一族（F1 / FIX-Q2/Q3/Q4/Q8 / R1 / P0-3a / C2 / B3 / F11 / A8×Q1）**在 decisions.jsonl 里没有登记**，只活在代码注释与测试文件名里。建议母席把 Q2-F1 登记为新决策项（本线不写仓）。
- 注意 id 撞名：decisions.jsonl 的 `F1`/`R1` 是别的缺陷（机器块分隔符 / 回退位置持久化），与测试文件 `f1-agent-message-wakes-suspended-pump` / `r1-aborted-dispatched-turn-settles` **不是同一命名空间**，跨表引用时别混。
