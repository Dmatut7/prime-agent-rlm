# r39 impl-qp：QP-1/2/3/4 落地（DS r39 队列线清偿）

- 冻结 SHA＝主仓 HEAD `4575d3bccbbcfd26ce538b2ed0c7ed54daed1aab`；独立工作树 `/tmp/audit_r/round-39/impl-qp-wt`（detached，symlink 根 node_modules），主仓零写入、零 push（`git worktree add/remove` 只登记 `.git/worktrees`，与本仓既有各 impl 线同打法）。
- 提交：`da31a6f31`（代码+测试+changelog fragment，9 文件）＋ `f826bd7f3`（QP-4 文档，3 文件）。git add 逐文件核对 staged（见下）；`npm run check` 未全跑（按派单纪律跑 tsgo+biome+定向测试）。
- 纪律：单命令 ≤60s（tsgo/测试全部 <15s）；测试分批 ≤3 文件；先红后绿；vitest node 直调＋unset 泄露 env（`RLM_DEPTH/RLM_SESSION_DIR/RLM_SUBAGENT/RLM_CHILD_ID/RLM_NAME/RLM_MODEL/PRIME_AGENT_KERNEL_PYTHON/PRIME_AGENT_SESSION_DIR/PI_SESSION_DIR`）；未碰 `doctor --fix`/`daemon ps -k`。

## ① QP-1（P1）栅栏存活

- 改动（`agent-session.ts`）：
  - 新增私有 `_resumeQueuedWorkUnlessFenced()`（照 `resumeQueuedWorkFromConnection`/`wakeSuspendedSessionInput` 的拒绝先例；**拒绝路径零副作用：不碰泵旗标、不 epoch++**，父线②的 epoch 语义满足）。
  - 三处同型漏口全部改走该 helper：`mutateQueuedMessage` 删除路径（原 :8837）、编辑路径（原 :8884）、`compact()` preempted-auto finally（原 :10127，父线③的“10127 无检查而 10250 有”）；:10250 原有内联守卫保持。
  - 附带修掉同型第四漏口（探针实证后才修，非派单原文但同属“teardown 期间拒绝抬栅栏”）：`_prompt` 的 `resumeIfIdle` 空闲恢复（原 :7212 无栅栏守卫）→ 裸 `prompt()` 在栅栏期会抬栅栏并放出 backlog（探针 `/tmp/r39-qp/probe-prompt-fence.ts`：改前 `resolved`+交付 `["A","LATE-PROMPT"]`+`suspended:false`）。现照 `sendCustomMessage` :8646 先例加 `!this._sessionInputSuspendedForUpdateRestart` 守卫；改后（`/tmp/r39-qp/probe-prompt-fence-after.ts`）抛栅栏型 `SessionInputSuspendedError`（retryable=false）、栅栏保持、零交付——与母线审计 Q2 表 row104 的记载一致。
- 红测（改前必红，逐字留档 `/tmp/audit_r/round-39/impl-qp-red.txt`）：
  - `mutateQueuedMessage during teardown keeps the fence up...`：红时 `isQueuedWorkSuspended=false` 且排队 steer "A" 被交付。
  - `a manual compact finishing during teardown keeps the fence up (preempted-auto finally)`：红时 finally 的 `resumeQueuedWork()` 抬掉栅栏（10127 形态，复用 r26 K3R-7 的“手工压缩抢占在飞自动压缩”驱动）。
  - 正控：普通 `requestAbort` 后同样的 mutate→resume 照常放行并交付（改前改后均绿）。
- `resumeQueuedWork()` 本体**未加**栅栏检查：`agent-session-action-races.test.ts:115`（"restart" 分支）把“abortForUpdateRestart 后直接 resumeQueuedWork 交付”钉成恢复流契约（注释：post-restart restore/in-process unwedge 直接调它），方法级一刀切会破坏该契约——故按派单原文落在三个调用点。

## ② QP-2 准入暂停可重试 + teardown 拒收

- 改动：
  - `prompt-admission.ts` 新增 `SessionInputAdmissionPausedError`（`retryable=true`，message 保留历史子串 `Cannot admit a session action while session input admission is paused.` + "Nothing was delivered...retry the same message once the pause is released"）；`_admitSessionInput` 与 `_assertSessionActionAdmissionAvailable` 两处裸 Error 改抛该类型。
  - `_assertSessionActionAdmissionAvailable` 检查顺序改为：栅栏型挂起（fence）→ 暂停租约 → 普通挂起（同时满足 f1 回归“栅栏期直投报 SessionInputSuspendedError(retryable=false)”与 agent-session-recursion “pause+普通挂起报 pause 文案”两个既有钉子）。
  - `agent-messages.ts` `isRetryableAgentMessageSendError` 增 `/session input admission is paused/i`（该清单的文档契约“添加即声明从未交付”成立：拒收发生在入队/交付之前）。
  - `abortForUpdateRestart()` 补准入暂停：`this._updateRestartAdmissionPause = this.acquireSessionInputPause()`；栅栏清除时释放（`requestAbort` 降级栅栏处、`_resumeSessionInputAdmission` 完全解挂处），manifest 恢复路径豁免（`_admitSessionInput` 新选项 `admissionPauseExempt`，`_restorePromptInput` 透传；`restoreSessionActions`/`_restoreSessionCommand` 原有 `restore:true` 同样豁免暂停但仍绕过/保留各自去重语义——`_restorePromptInput` 路径**保留 coalesce 去重**，因 agent-session-queue "keeps a coalesced duplicate with its $phase agent-message owner" 钉死该行为）。
- 效果：栅栏期子代理回执（daemon 唯一投递口 `acceptAgentMessagePrompt(steer, queueIfBusy)` → P0-3a 排队支路 → `_admitSessionInput`）从“收下+回执 queued+关闭即丢”改为“拒收+可重试+稍后重试指引”；id gate 的 `rememberFailure` 不再把它记 uncertain，同 id 重发放行（实测 deliveries=2、无 "Refusing to resend"）。
- 红测：`classifies the admission-pause refusal as retryable`（红时 false）、`an admission-pause refusal leaves the message id unspent...`（红时第二次 send 被 "Refusing to resend" 顶掉、deliveries=1）、`a bare prompt during an admission pause throws a typed retryable error`（红时 name="Error"、无 retryable 字段）、`abortForUpdateRestart refuses late child replies...`（红时 resolve 且消息入队）。
- 父线① requestAbort 命运映射：本轮未改 requestAbort 的 action 命运（不可见 turn 丢弃/durable 通知降级/已 durable 同步 settle 全部原样），只在栅栏降级处加了暂停释放，无交互漂移。

## ③ QP-3 coalesce 票据 + committing 窗口收紧

- 改动（`_admitSessionInput`）：
  - coalesce 命中：独立 `ActionTicketController` settle 为 `{status:"coalesced", existingActionId}`＋`delivered:{status:"not_applicable"}`＋completed，票据随返回值带出（`SubmissionOutcome` 的 coalesced 变体不再是死代码）；同时 `sessionLog.info("session input coalesced into running <key>", {sessionId, queueKey, existingActionId, agentMessageId})` 落结构化日志（生产走 `~/.prime/agent/logs/agent.jsonl`）。不重投、返回值/disposition 语义不变；**快照逐字节不变正控保留**（改前改后 `getSessionActionSnapshot()` JSON 全等，测试内钉死）。
  - committing 窗口收紧：新增 `_committingFollowUpOwner`（同 key 且 owner `committing`），命中抛 `SessionInputCoalescingError`（`retryable=true`，文案含 key 与 "retry after the current turn ends"）并进 `isRetryableAgentMessageSendError` 的 `/equivalent follow-up.*is already committing/i`。`restore` 路径豁免；**running 窗口保持原语义**（派单原文只点名 committing）。
- 红测：`a coalesce hit leaves a ticket trace...`（红时日志无痕；快照正控绿）、`a same-key follow-up while the owner is committing is refused as retryable...`（红时 `followUp` resolve true、`unfinishedActionCount=2`、两条都交付）；正控：异 key followUp 在 owner committing 时照常排队交付（改前改后均绿）。

## ④ QP-4 只补文档（零语义）

- `README.md`（Message Queue 节）、`docs/usage.md`、`docs/settings.md`（Message Delivery 节）各一段"谁插谁的队"：steering 队列恒先于 followUp 队列放空（跨 lane 优先级压过到达序）、同 lane FIFO、子代理回执/心跳默认 steering 会插队、准入暂停期拒收可重试而非静默丢、重启 teardown 停机队列交给重启后会话。
- 代码注释集中化：`session-action-store.ts` `selectFirst()` 顶加 lane 优先级单一事实源注释（含各拒收语义指向 `_admitSessionInput`）。
- changelog fragment：`packages/coding-agent/.changes/r39-qp-queue-fences.md`（3 bullets）。

## 既有测试改写（语义按派单变更，全部披露）

| 文件 | 用例 | 旧语义 → 新语义 |
|---|---|---|
| `agent-session-queue.test.ts` | "queues a same-key follow-up once the prior owner has handed off" | 改名 "refuses a same-key follow-up while the prior owner is committing (QP-3, r39)"：排队双投 → 拒收可重试、单投 |
| `regressions/f1-agent-message-wakes-suspended-pump.test.ts` | "does not break the update-restart fence when an agent message is queued" | 改名 "refuses a late agent message behind the update-restart fence with a retryable error (QP-2, r39)"：入队存活 → 拒收可重试；栅栏不破/零运行的核心不变量保持 |
| `regressions/fixq3-heartbeat-wakes-stranded-queue.test.ts` | "never wakes the pump for a heartbeat during the update-restart fence" | 尾段改写：steer 栅栏期从“入队、resume 放出”→“拒收可重试、零入队、零放出”（心跳 loud-rejected 断言原样通过） |

## 验证总账

| 面 | 红（改前，逐字在 impl-qp-red.txt） | 绿（改后） |
|---|---|---|
| r39-qp.test.ts | 8 failed / 2 passed（两条正控绿） | 10/10 |
| agent-session-queue.test.ts | S4/同 key 用例先红后绿 | 113/113 |
| parked-queue / action-races | —（正控面） | 全绿（connection 拒抬栅栏用例 450ms 绿） |
| f1 / fixq3 / 4257 | 2 用例按新语义改写 | 40/40 |
| goal / r26-compact / queued-receipt | — | 72/72 |
| bounded-wait / interactive-queue-edit / recursion | recursion 1 条预存红（见下） | 其余全绿 |
| cron-jobs / ma-p0-6 | — | 75/75 |
| tsgo --noEmit（工作树＝HEAD，零 diff） | — | EXIT=0 |
| `git archive HEAD` 干净树＋symlink node_modules＋tsgo | — | EXIT=0 |
| biome check --write 8 文件 | — | exit 0（格式化 4 文件后重跑测试仍绿） |

- **预存红（非本轮）**：`agent-session-recursion.test.ts` "loads the ephemeral RLM harness path into the host system prompt" 在冻结 SHA 干净树（`/tmp/audit_r/round-39/qp-pristine`，已删）同样红（缺 "Ephemeral note"）——与 r34 台账记载一致，与本轮零关联。
- 工件：红/绿输出 `/tmp/audit_r/round-39/impl-qp-{red,green}.txt`；栅栏 prompt 探针（改前/改后）`/tmp/r39-qp/probe-prompt-fence{,-after}.ts`（tsx 可复跑）。

## 残留（如实声明，未在本轮最小改动内）

1. **daemon prepare→commit 窗口**（Q3 F3 主体）：`prepareUpdateRestartCheckpoint` 持的 `acquireQueuedWorkPause` 只停泵不停准入，manifest 快照读取（`createUpdateRestartSession`）到 `closeSession → abortForUpdateRestart` 之间到达的消息仍会被收下且不在 manifest 内。本轮按派单原文只把准入暂停加在 `abortForUpdateRestart`（覆盖 teardown 段）；补全需在 daemon-mode 该窗口同时持 `acquireSessionInputPause`（含取消路径释放），建议下一轮单独做。
2. **cron F2**（Q3 线）：暂停期被拒的心跳 tick 仍记 `ran`（once 作业被永久消耗）——派单未含，未动。
3. **running 窗口同 key**：派单只点名 committing；owner running 时同 key 仍排队下一轮（`agent-session-queue` 旧测试语义的一部分已在改写中保留）。
4. `SessionInputSuspendedError` 栅栏变体的文案含 "queued session input is suspended" 子串，字符串清单仍把它判可重试（与 `retryable=false` 字段矛盾）——预存问题，未动。
