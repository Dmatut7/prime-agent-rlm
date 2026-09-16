# r39-Q3 — pause/resume 窗口的投递与顺序保真

线名：r39-q3-pause-resume　仓：/Users/a1/Desktop/ai/prime-agent　只读（本线零写入；仅 /tmp 探针）

**锚定**：审计起步时 HEAD = `e8f6527dc44a548d961cdf336bd514bcafa24fa7`；收口时 HEAD 已被其它车道推进到
`74113284982141b5bb590700013bbc10546395a0`（工作树对已跟踪文件无未提交改动）。本报告所有行号以收口时的树为准，
关键文件哈希（自 `/tmp/audit_r/round-39/snapshot-meta.json`）：

| 文件 | sha256(前16) |
| --- | --- |
| `packages/coding-agent/src/core/agent-session.ts` | `8afb43ebec90c316` |
| `packages/coding-agent/src/core/session-action-store.ts` | `f79ad6b8b063d51f` |
| `packages/coding-agent/src/core/agent-messages.ts` | `df12cd862ec29556` |
| `packages/coding-agent/src/modes/daemon/daemon-mode.ts` | `3ed7e2058112f639` |
| `packages/coding-agent/src/core/cron-jobs.ts` | `88063b33ca79047c` |

**探针（可执行，仓外）**：`/tmp/audit_r/round-39/probe/{order-pause,lane-priority,rollback-position}.test.ts`
（+`smoke.test.ts` 环境自证）。跑法（vitest 用仓自己的 config，`--root` 指向 /tmp 探针目录，alias 仍生效）：

```
cd /Users/a1/Desktop/ai/prime-agent/packages/coding-agent && \
env -u RLM_DEPTH -u RLM_SESSION_DIR -u PRIME_AGENT_SESSION_DIR -u PI_SESSION_DIR \
node ../../node_modules/vitest/dist/cli.js --run --root /tmp/audit_r/round-39/probe \
  --config /Users/a1/Desktop/ai/prime-agent/packages/coding-agent/vitest.config.ts
```

（`/tmp/audit_r/round-39/probe/node_modules -> 仓根 node_modules` 符号链接用于裸模块解析；探针不写仓、不碰 daemon。）

---

## 1. 暂停机制清册（谁暂停、怎么暂停、到达的消息会怎样）

**关键区分**：`暂停准入`（`_admitSessionInput` 抛错/拒收）vs `暂停泵`（消息被收下、排在队列里，但泵不动）。

| # | 机制 | file:line | 语义 | 谁设置 | 谁解除 | 期间到达的用户/子代理消息 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `_sessionInputAdmissionPauses` | 声明 1646；add 9161 / delete 9169（`acquireSessionInputPause()` 9159-9177） | **暂停准入（硬拒收）**：`_admitSessionInput` 直接 throw | `agent-session.ts:2126`（内核 MCP transport 关闭/重载）；`daemon-mode.ts:4755`（客户端 `acquire_session_input_pause` 租约，ACP 用）；`daemon-mode.ts:4869`（`replace_acp_mcp_servers`） | `release()` 9166-9175（delete + epoch++ + notify + flush + `_scheduleSessionInputPump()`） | **抛 `Error("Cannot admit a session action while session input admission is paused.")`（7951）**；`_prompt` 路径先在 7213 的 `_assertSessionActionAdmissionAvailable()` 抛同文案（7924） |
| 2 | `_queuedWorkPauses` | 声明 1645；add 9181 / delete 9189（`acquireQueuedWorkPause()` 9179-9195） | **暂停泵**（收下但不动） | `agent-session.ts:15679`（树导航/branch summary）；`daemon-mode.ts:6634`（update-restart 准备） | `release()` 9186-9194（delete + notify + flush + `_scheduleSessionInputPump()`） | **收下**：`_admitSessionInput` 不检查该集合 → enqueue 成功（7976-7977）；泵在 `_scheduleSessionInputPump` 8070 与 `_pumpSessionInputs` 8108-8115 处停住 |
| 3 | `_sessionInputPumpSuspended` | 声明 1642；置位 9475（`requestAbort`）、9580（`abortForUpdateRestart`） | **半暂停**：泵收下但不动；`_prompt`/`acceptAgentMessagePrompt`（无 `queueIfBusy`）**硬拒收** | `requestAbort()` 9467-9505（用户 Esc / stall watchdog）；`abortForUpdateRestart()` 9575-9597 | `_resumeSessionInputAdmission()` 9278-9293；入口 `wakeSuspendedSessionInput()` 9303、`resumeQueuedWork()` 9311、`resumeQueuedWorkFromConnection()` 9331；**另**：admission 的 `wake==="immediate"` turn（7996-8002）、`sendCustomMessage(triggerTurn)` 8646、`_prompt` 的 `resumeIfIdle` 7212 | `followUp()`/`_queuePreparedPrompt`/`acceptAgentMessagePrompt(queueIfBusy+streamingBehavior)` **收下并排队**（`_admitSessionInput` 不检查 suspended；`queueIfBusy` 分支 6197-6212 是 P0-3a 的修复）；裸 `prompt()` 经 7213 抛 `SessionInputSuspendedError`（7926-7931） |
| 4 | `_sessionInputSuspendedForUpdateRestart` | 声明 1643；9581 | 3 的加固：任何 wake 都不解除（9304、7999、6259-6261、9332） | `abortForUpdateRestart()`（daemon 关闭期调用，`daemon-mode.ts:6943`） | 只能重启恢复 | 同 3 |
| 5 | branch summary | `_branchSummaryOperation`（`_isBusyForSessionInput("pump")` 8309） | 阻塞泵选择 | `navigateTree` 15679-15693（与 2 同窗） | 操作结束 | 收下并排队 |
| 6 | compaction / retry / bash | 8301（`isCompacting/isRetrying/isBashRunning`） | 阻塞泵选择 | 各自流程 | 各自结束 | 收下并排队 |
| 7 | UI dialog / 看门狗 | `agent-session-ui-dialog-pause.test.ts`（stall watchdog 暂停，非投递暂停） | 与本线无关 | — | — | — |

**根因不对称（本报告 F1/F2/F3 共同的机理）**：`_admitSessionInput`（7934-8004）对"泵被挂起"**没有**任何检查，
所以挂起期消息一律进队列；而对"准入暂停"是 7950-7952 的硬 throw，且抛的是**裸 `Error`**，
不是泵挂起时那个带类型/重试语义的 `SessionInputSuspendedError`（7926-7931 → `prompt-admission.ts:8-32`）。

---

## 2. 顺序保真（核心问题 2）

### F4 [info] 跨 lane 的"到达序"本就不保真；pause/resume 没有额外引入倒序
- 命题：晚到的 steering 会被投递在早到的 follow_up 之前；该倒序来自 `selectFirst()` 的 lane 优先级，
  **与 pause/resume 无关**（resume 路径不重排）。
- file:line：`session-action-store.ts:227-234`（`nextTurnBoundary.find(queued) ?? whenRunIdle.find(queued)`），
  投递排序在 `agent-session.ts:8116`（`_actionStore.selectFirst()`）。
- 逐字证据（探针 stdout，三次构造同一到达序 F1 → C1(子代理 followUp) → S1(steering)）：
```
NO-PAUSE lane-priority order:      ["start","S1","F1","C1"]
PAUSED lane-priority order:        ["start","S1","F1","C1"]
SUSPENDED lane-priority order:     ["S1","F1"]      // followUp F1 先到，requestAbort 挂泵，steering 挂起期到达，resumeQueuedWork
NO-SUSPENSION control order:       ["S1","F1"]      // 同样到达序、无任何暂停
```
- 判据/影响：同一 lane 内到达序 100% 保真；跨 lane 是"steering 绝对优先"的既定契约（母席坐标系已确认），
  以上四条证明倒序在**无暂停**的对照上同样出现 ⇒ 不是暂停窗口的缺陷。若产品要"先到先服务"，需要改 lane 模型而不是改 resume 路径。
- 复现：`order-pause.test.ts` / `lane-priority.test.ts`（测试名见文件）　confidence: high（实测）
- **正控**：同一探针在人为乱序构造上会报警 —— `order-pause.test.ts > positive control: the same probe reports a DOCTORED order`
  （用公开 API `mutateQueuedMessage("followUp",0,preview,{type:"move",direction:1})` 把队列改成 C1 在 F1 前）：
```
queue preview before doctoring: ["F1","Agent message received: C1","F2"]
mutation status: applied after: ["Agent message received: C1","F1","F2"]
DOCTORED order: ["start","S1","C1","F1","F2"]   // 探针看得见顺序变化
```
  ⇒ 上面"顺序相同"的结论不是探针失明。

### F6 [info] 同 lane 顺序在 pause 窗口内保真；epoch 失效后的 rollback 不移动元素
- 命题 1：pause 期间到达的多条消息，resume 后按到达序投递（同一 lane）。
  证据（`order-pause.test.ts`，到达序 S1,F1,C1,F2；四项同源同序）：
```
BASELINE order: ["start","S1","F1","C1","F2"]
PAUSED order:   ["start","S1","F1","C1","F2"]     // 到达全部发生在 acquireQueuedWorkPause() 窗口内
```
- 命题 2：`rollback` 只改 lifecycle、不动数组位置 ⇒ 被 epoch 失效回滚的 action 保留队列位次，
  恢复后仍在 pause 期间新到的消息之前。file:line：`session-action-store.ts:241-243`（`rollback`）；元素只在
  `releaseTerminal` 里 splice（store 312-320）；`enqueueFront` 219-225 插在**第一个 queued** 之前。
- 逐字证据（`rollback-position.test.ts`）：
```
after rollback: ["A","B"]                          // selectFirst→A 选中→rollback(A) → A 仍在队首
after enqueueFront: ["FRONT","A","B"]              // 正控：enqueueFront 的插入看得见
front-insert with in-flight head: ["A:selected","FRONT:queued","B:queued"]   // enqueueFront 跳过在飞的头
queue after rollback: ["K1","F2","F3"]             // 集成：queuedWorkPause 窗口内 K1,F2 到达；K1 preparing 时第二个 pause 窗口内 F3 到达；
transcript order: ["K1","F2","F3"]                    hook 释放 → DeferredSessionInputError → 批量 rollback → 释放后按序投递
queue after epoch invalidation: ["E1","E2"]        // 集成：preparing 期 acquireSessionInputPause()（epoch++）→ 回滚 → 顺序不变
epoch-variant transcript order: ["E1","E2"]
```
- 复现：`rollback-position.test.ts` 5 tests 全绿　confidence: high（实测）
- 结论：**pause/resume 窗口、epoch 失效 + rollback、`enqueueFront` 的交互都不会打乱同一 lane 内的到达序**；
  顺序错 ⇒ 行为错的输入，本线没找到（唯一"跨 lane 倒序"见 F4，且非暂停引入）。

### F5 [low] 唯一实测外的倒序嫌疑：resume 时的 deferred RLM terminal notice 排在"唤醒它的那条消息"之后
- 命题：挂起期被降级为 deferred 的子代理终局通知（先到），在 resume 时被 enqueue 到**后到**的那条
  wake-immediate 消息之后（同 `when_run_idle` lane）。
- 机理（逐字）：
  `agent-session.ts:7996-8002`（admission 内先 enqueue，再 `_resumeSessionInputAdmission()`）→
  9278-9293（`_sessionInputPumpSuspended=false` 后调 `_flushDeferredRlmTerminalNotices()`）→
  6880-6899 的 flush 守卫此时已放行 → `_enqueueRlmTerminalNoticeAction`（6860-6878）→ `_admitSessionInput`
  → `_actionStore.enqueue`（7977，**追加到 lane 末尾**）。
- 对比：goal continuation 路径明确规避同一现象，`agent-session.ts:2998-2999` 注释逐字：
  `// No front: a settling child's terminal notice must be read first.`
- 影响：父会话先读到后到消息、后读到先到的子代理终局报告；`suppressAutonomousContinuation` + `queueVisible:false`
  使其不可见，用户无法在 UI 上察觉该倒序。
- 复现：仅静态推断（需要真实 RLM 子代理在挂起期终结；本线未构造）。
- confidence: medium　severity: low

---

## 3. 准入被拒后，调用方怎么处理（核心问题 3）

### F1 [high] 子代理回执：admission 暂停的拒收**不在可重试清单**里 ⇒ message_id 被记为 uncertain，重发被拒，并给出错误的"可能已送达"判词
- 命题：`acceptAgentMessagePrompt` 因 `_sessionInputAdmissionPauses` 抛出的文案
  （`agent-session.ts:7951`）在发送端被分类为**不可重试**（`agent-messages.ts:823-835` 无此模式），
  于是 `rememberFailure`（1076-1081）把 id 记成 `uncertain`；同 id 的第二次 send 被顶掉（1097-1105 →
  `formatUncertainAgentMessageResendError` 1036-1050），且文案断言"host 无法判断是否到达"——而事实是**从未交付**。
- 逐字证据（`lane-priority.test.ts`，真实 host handler + 抛该文案的 controller）：
```
retryable(admission pause)? false
paused first: "Cannot admit a session action while session input admission is paused."
paused second (same id): "Refusing to resend message_id id-p: the earlier attempt at 2026-09-16T02:25:47.118Z failed
  after the message had been handed to the delivery leg, so the host cannot tell whether it arrived - and it may have.
  This call delivered nothing and the message is not delivered again by retrying it; ... This error is terminal for id-p"
```
- **正控（同一探针、同一路径）**：泵挂起型拒收被正确判为可重试，重试真的走到了投递腿：
```
suspended first: "Cannot admit a session action while queued session input is suspended."
suspended second (same id): "Cannot admit a session action while queued session input is suspended."
(deliveries 计数 = 2, 未出现 "Refusing to resend")
```
  ⇒ 探针能区分两类拒收，结论不是"探针抓不到 retryable"。
- 可达性：`daemon-mode.ts:6381`（daemon 对子代理消息的唯一投递入口，`streamingBehavior:"steer", queueIfBusy:true`）
  → `agent-session.ts:6197-6212`。暂停窗口在 ACP 场景是**长时间**的：`acp-mode.ts:1082-1083`
  在 `session/cancel` 路径持有 admission pause 跨 `stopSessionWork()`（等待 abort/idle/取消全部 RLM 子代理/promptTask），
  关闭路径同样（1035）。MCP 重载窗口同理（`agent-session.ts:2126-2152`）。
- 文本保真（静态）：daemon 侧 `daemon-mode.ts:3887` `failure(..., error, serializeDaemonError(error))` 只附加结构化 code，
  `daemon-errors.ts:48` 用 `new Error(response.error)` 还原 ⇒ 上述文案逐字到达发送端 handler，类目匹配发生在原文上。
- 影响：暂停窗口内子代理的最终回执被"硬失败 + 不可重发"；发送方模型按 `formatAgentMessageRetryExhaustedError`
  的指引放弃（写文件/结束回合），父会话可能永远拿不到该结果。而对照路径（泵挂起）是"收下并排队"（P0-3a 已修）——
  同一类"host 在交付前拒收"的事实，两条路径给出相反的可重试性。
- 修复方向（未实施）：7950-7952 改为抛带类型的可重试错误（或在 `isRetryableAgentMessageSendError` 增加
  `/input admission is paused/i`），使 `rememberFailure` 不消费 id。
- 复现：`lane-priority.test.ts`（3 条 admission-refusal 用例）　confidence: high（实测 + 调用点静态确认）

### F2 [medium] 心跳/cron：暂停期被拒的 tick 记成 `ran`（runCount+1、lastRunAt 推进），一次性作业直接 `completed`
- 命题：`promptHeartbeat` / `promptUntilAccepted`（`daemon-mode.ts:2007-2031`）抛出的拒收错误被
  `cron-jobs.ts:1272-1281` 记为 `outcome: "ran"` 并且带 error，落库时 `runCount+1` + `lastRunAt=now`
  （`cron-jobs.ts:859-866`），`schedule.kind==="once"` 时 `status:"completed"` ⇒ 一次被拒的心跳 tick 被当作已运行并
  永久消耗（once 作业再也不跑）。
- 逐字证据：`cron-jobs.ts:1279` `outcome: runResult === "skipped" && error === undefined ? "skipped" : "ran",`
  ；`cron-jobs.ts:859-866`（`lastRunAt`/`runCount`/`status: job.schedule.kind === "once" ? "completed" : job.status`）。
- 对照：`_promptInjectedMessage` 只把"未 admitted/coalesced"报为 skip（`agent-session.ts:7178-7185`，
  G5 注释），而准入暂停是**抛异常**，走不到该返回。
- 影响：暂停窗口（MCP 重载/ACP stop/update-restart 准备）恰好覆盖 tick 时刻时，心跳静默丢失且账本显示"已运行"，
  后续 tick 被推迟一个周期；once 作业直接消失。
- 复现：仅静态推断（未执行 cron store 探针；判据是 1279 行的一个无条件三元 + 859-866 行落库）　confidence: medium

### F3 [medium] update-restart 窗口：manifest 快照之后仍能准入 ⇒ 回执说 queued，重启即丢
- 命题：`prepareUpdateRestart` 在持 `acquireQueuedWorkPause()`（`daemon-mode.ts:6634`）后取一次
  `getSessionActionRecoverySnapshot()`（6485），之后才写 manifest 并关闭会话（6942-6943 才 `abortForUpdateRestart()`）。
  由于该 pause 只停泵不停准入（第 1 节 #2，且 `order-pause.test.ts` 实测窗口内消息确实被收下），
  在"快照 → 关闭"之间到达的消息会被收下并拿到 `status:"queued"` 回执（`daemon-mode.ts:6251-6258`），
  随后会话被关、队列被丢弃，而 manifest 里没有它 ⇒ **回执说排队、实际丢失**。
- 证据组合：(a) 实测"queued-work pause 期间准入被接受"（`order-pause.test.ts` 的 PAUSED 用例，F1/C1/F2/S1 全部入队）；
  (b) 静态：`daemon-mode.ts:6485` 只快照一次，`daemon-mode.ts:6943` 的硬栅栏在关闭时才上；
  两处之间的窗口是"写 manifest + append 标记 + 排序关闭"，毫秒级但非零。
- 影响：窗口很窄 ⇒ severity medium；但语义上"收下并承诺 queued"却是丢失，且用户/发送方都无信号。
- 复现：仅静态推断 + 探针 (a)（需要真 daemon 的 update-restart 流程才能端到端复现，本线未做）　confidence: medium

### 其它来源（无丢失）
- **用户输入（TUI）**：`interactive-mode.ts:5181-5200` 捕获后把草稿放回编辑器/暂存（5190 `const rejectedDraft = submittedDraft ?? { text };`），
  启动期 prompt 亦保留未尝试部分（1664-1678）。⇒ 拒收不丢文本，只是要用户重按回车。
- **daemon 客户端 prompt**：`daemon-mode.ts:4417` 一带的 `queueIfBusy` 路径同样把错误回给客户端；泵挂起时由
  `agent-session.ts:6197-6212` 转成"排队"，与 F1 的差异只在通知而非丢失。

---

## 4. 结论摘要（给母席的三条最高 severity）

1. **F1 [high]** `agent-session.ts:7950-7952` 的 admission 暂停拒收是**裸 Error**、不在
   `agent-messages.ts:823-835` 可重试清单 → 子代理回执被记成 `uncertain`、同 id 重发被拒，且错误文案谎称"可能已到达"。
   对照的泵挂起拒收（7926-7931 的类型化错误）重试正常。探针 `lane-priority.test.ts` 双向实测。
2. **F2 [medium]** 暂停期被拒的心跳 tick 在 `cron-jobs.ts:1279` 记成 `ran`（runCount/lastRunAt 推进，once → completed）
   ⇒ 心跳静默丢失且账本失真。
3. **F3 [medium]** update-restart 的 queued-work pause 只停泵不停准入，manifest 快照（`daemon-mode.ts:6485`）之后
   到达的消息仍被收下并回执 queued，随即随会话关闭丢失。

顺序保真方面**未发现行为性缺陷**：同 lane 到达序在 pause/resume、epoch 失效+rollback、`enqueueFront` 交互下均保真
（F6，含正控）；跨 lane 的"steering 优先"倒序是既定契约且与暂停无关（F4）；唯一未实测的倒序嫌疑是 F5（low，静态）。

## 5. 未做/边界
- F2/F3/F5 未做端到端实测（F2 需 cron store 探针、F3 需真 daemon update-restart、F5 需真实 RLM 子代理在挂起期终结）。
- 未覆盖：`_sessionInputPumpEpoch` 在 `wakeSuspendedSessionInput` 之外的失效源（`clearQueue` 8721、`acquire*Pause` 9163/9183、
  requestAbort/abortForUpdateRestart）对**跨 lane** 顺序的影响（已证同 lane 无损，跨 lane 由 F4 的 lane 优先级主导）。
- 仓零写入；探针与心跳均在 /tmp。HEAD 在工作期间被其它车道推进（e8f6527 → 7411328），本报告行号已按收口树重锚并给出文件哈希。
