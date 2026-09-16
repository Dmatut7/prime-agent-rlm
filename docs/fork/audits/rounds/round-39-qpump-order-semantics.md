# r39 泛扫 —— 输入队列/泵的排序语义（整线报告）

- 线名：`qpump-order-semantics`（母席自营线 + 4 条子线：q2-abort / q3-pause-resume / q4-coalesce / q5-multisource）
- 仓：`/Users/a1/Desktop/ai/prime-agent` @ **e8f6527dc44a548d961cdf336bd514bcafa24fa7**（只读；全程零写入，`git status` 只显示他人 lane 的未跟踪文件）
- **HEAD 漂移披露**：本线作业期间其它车道把 HEAD 推进到 `74113284982141b5bb590700013bbc10546395a0`。逐文件核对（`git diff --stat e8f6527..7411328`）：**agent-session.ts / session-action-store.ts / cron-jobs.ts / agent.ts / agent-loop.ts 零改动**，故本线全部核心行号仍然有效；唯一被改动的是 `daemon-mode.ts`（+27/-4，改动点在该文件 242/478/1307/5804 行之前）⇒ 本报告与 Q1 报告里 `daemon-mode.ts` 的引用需重锚：`:1984→:2003`、`:2008→:2027`、`:4944→:4962`、`:6358→:6383`（Q2/Q3 报告自称已按各自收口树重锚/给哈希）。
- 报告分工：
  - 本文件 = 收口索引 + Q1 全量 + 各线的结论/severity 摘要
  - `/tmp/audit_r/round-39/r39-q1-priority.md`（Q1 全文，含源×lane 表与 9 条发现）
  - `/tmp/audit_r/round-39/r39-q2-abort.md`（Q2 全文，abort 边界条件表）
  - `/tmp/audit_r/round-39/r39-q3-pause-resume.md`（Q3 全文，pause/resume 保序；探针 `probe/*.test.ts`）
  - `/tmp/audit_r/round-39/r39-q4-coalesce.md`（Q4 全文，8 条发现 + 13 用例全绿）
  - `/tmp/audit_r/round-39/r39-q5-multisource.md`（Q5 全文，5 条发现 + 8 用例全绿）
- 心跳：本目录 `qpump-heartbeat.txt` 与各线 `*-heartbeat.txt`
- 与 `docs/fork/audits/decisions.jsonl`（322 条）去重结果：`grep -in "steering|selectFirst|lane|priority|arrival order|steeringStop"` **零命中** → 本线"跨 lane 优先级/到达序"主体结论在既有决策台账中**未记录**；唯一重叠是 **G4**（"被 coalesce 的 follow_up 心跳记成 ran"，已 fixed）→ Q4 线的 F6 已标注为 G4 的可见性补遗。Q4 的 F1/F5、Q3 的 admission-pause 误分类、Q2 的栅栏提升均为新条目。

---

## 收口答案（按派单五问）

### ① steering / follow_up / queued 命令 / 心跳 prompt 的相对优先级与到达序
**一句话**：**lane 优先级压过到达序**——`selectFirst()` 恒先取 `nextTurnBoundary`（= steer）再取 `whenRunIdle`（= followUp）；到达序只在**同 lane 内**是 FIFO。而同一条消息进哪条 lane 由来源决定（见 Q1 的"源×lane 对照表"），于是**默认配置下三条非用户来源（子代理回执、心跳、流式中提交的斜杠命令）全部压过用户先前按 Alt+Enter 排的 follow-up**。
- `session-action-store.ts:250`；`agent-session.ts:3101-3116` + `:3151`（steer 会在 turn 边界**截断 run**，followUp 不会）；`agent-session.ts:6320-6323`（作者自认该不变量）；`cron-jobs.ts:192`（心跳默认 steer）。
- 文档：`README.md:193-194`、`docs/usage.md:69-70`、`docs/settings.md:328-329` 只写"每条消息何时被投递"，**没有任何一处写"谁插谁的队"**（Q1 §6）。
- 实测探针：`/tmp/r39-q1/q1abc.ts`（跨 lane 反转 + 两条正控）、`q1f.ts`（斜杠命令 lane）、`q1g2.ts`（心跳默认 steer）、`q1i.ts`（mode=all 批合并）。

### ② abort 边界的队列语义
**完整条件表（中止入口 × action 生命周期 + 唤醒入口表 + unverified 清单）见 `r39-q2-abort.md`**（探针 `r39-q2-abort-probe/abort-fate.probe.test.ts` 5/5 绿，两个 SHA 下都跑过；`daemon-mode.ts` 行号钉在 e8f6527 冻结副本 `/tmp/audit_r/round-39/frozen/daemon-mode.ts`，报告附新旧行号对照）。Q2 的**命运映射**逐格如下（行=入口，列=action 状态）：
- `requestAbort`（= Esc = Ctrl-C = stall watchdog = daemon `abort` = `abort()` 第一步；同一个函数，`reason` 只进 `_lastTurnAbortReason` + abort cause ⇒ **watchdog 与用户 Esc 的队列命运无差异**）：queued 可见 turn / 心跳 / goal / autonomous ⇒ **悬置**；queued **不可见** turn（direct prompt、`sendCustomMessage{triggerTurn}`）⇒ **丢弃**；**durable RLM 终态通知 ⇒ 降级回 `_pendingNextTurnMessages`（非丢弃）**；queued/selected `session_command` ⇒ **悬置**（实测 T1）；selected/preparing/committing-未 durable ⇒ epoch 失配**回队 queued**；committing/running-已 durable 且可见 ⇒ **同步 settle = failed，消息留在 transcript 不可回收**（R1，实测 T2-PC 1→0）；running `session_command` ⇒ 既不取消也不 settle，自己跑完。
- `abortForUpdateRestart`（`:9575-9597`）：**完全不碰 store**（不 cancel / 不 settle / 不 demote），一切 queued 进 manifest（`snapshotActions` 只收 queued）；**committing-已 durable / running 既不同步 settle 也不进 manifest**（Q2-F2 实测：`unfinishedActionCount=1`、`state=running`、`manifest.actions=0`）。
- `dispose`：先 `_persistUndeliveredWorkBeforeDispose` 再 cancel clearable（queued/selected/preparing）；committing/running 停在原地。
- `clearQueue`：只清 `session_command ∪ queueVisible`，放过 invisible turn；`abort_and_clear_queue` 靠第二刀 `requestAbort` 补齐。

母席据源码逐字核对的**最小条件表**（行号按 e8f6527 树，与 Q2 报告一致）：

| abort 入口 | 泵/栅栏 | epoch | 对 queued/selected/preparing 的 action | 对已 dispatch（committing/running） |
|---|---|---|---|---|
| `requestAbort()`（Esc/kill/watchdog 共用，`agent-session.ts:9467-9500`） | `_sessionInputPumpSuspended=true`、`_sessionInputSuspendedForUpdateRestart=false`（`:9475-9476`） | `_sessionInputPumpEpoch++`（`:9474`） | **只取消不可见内部 turn**：`action.payload.kind==="turn" && !queueVisible && !durableRlmTerminalNotice` → cancelled（"Prompt aborted before delivery."，`:9482-9488`）；**可见排队输入（用户/心跳）保留 = 悬置** | `this._settleAbortedDispatchedTurnActions()`（`:9489`）结算被中止的已派发 turn |
| `abortForUpdateRestart()`（`:9575-9581`） | 挂起 + **栅栏 true**（`:9580-9581`），不取消任何排队输入（注释：must survive into the restart manifest） | `++`（`:9579`） | 全部保留（悬置到重启） | `this.agent.abort()`（`:9587`）+ 子树中止 |
| 唤醒入口 | `wakeSuspendedSessionInput()`（`:9303-9304`）**拒绝**抬栅栏；`resumeQueuedWorkFromConnection()`（`:9331-9334`）**拒绝**；`resumeQueuedWork()`（`:9311-9316`）**无检查**（= 下面 Q2-F1/Q1-8 的 bug 面） | `_resumeSessionInputAdmission()` 会 `++`（`:9282`） | 唤醒后按 lane 优先级（Q1-1）继续投递 | 被 `++` 作废的在飞 dispatch 走 `_isDeferredSessionInputError`/回滚（需 `dispatchSettled` 证明） |

**中止后的唤醒条件（Q2 §3 摘要，逐字行号见其报告）**：`_scheduleSessionInputPump()` 首行即栅栏（`AS:8070`），而 `_resumeSessionInputAdmission()`（`AS:9278-9293`）**无条件**同时清 `_sessionInputPumpSuspended` 与 `_sessionInputSuspendedForUpdateRestart` 并 `epoch++`。于是：
- 普通 abort（栅栏 down）：`prompt()`/slash（`resumeIfIdle!==false` 且空闲）**唤醒并放出整个 backlog**；`steer()/followUp()` **默认（`resumeIfIdle` 未传）不唤醒 ⇒ 悬置**（`AS:7871-7876`、`parked-queue.test.ts:31-36`）；连接层 `steer/followUp`（`resumeIfIdle:true`）唤醒；子代理回复默认**不唤醒**（C2 policy，仅 `always` 时 `wakeSuspendedSessionInput()`，`AS:6242-6261`）；失败类终态通知每静默窗一次**聚合唤醒，且唤醒是泵级、无法按消息过滤**（`AS:7013-7019` 逐字）⇒ 一次唤醒把整个 backlog 一起放出；心跳 tick 唤醒并排干（`DM:1970`）；TUI 空编辑器 Enter / daemon `resume_queue` 唤醒。
- update-restart（栅栏 up）：以上入口**除 Q2-F1 两条外**全部拒绝或仅排队；心跳 tick 返回 false；`promptHeartbeat` 响亮报 `SessionInputSuspendedError`（下一 tick 重试）。
**Q2 的其余发现（细化）**：F1 补两点——① `_resumeSessionInputAdmission` 顺带 `epoch++`（`AS:9282`）会**同时作废在飞准备**（`AS:8095/8137/8325/7143/7226`）；② 同类第二漏口 `AS:10127 if (preemptedAutoCompaction) this.resumeQueuedWork();` 无栅栏检查，而同文件 `AS:10250` 明写 `if (!this._updateRestartFenceUp)` ⇒ 同一不变量一处守一处不守（仅静态）。F2 [medium] `abortForUpdateRestart` 不做 R1 的同步 settle ⇒ 已投递的 queue-dispatched turn 停在 `running` 且该行不入 restart manifest（实测 T2 + 正控）；F3 [low] `session_command` 在 `running` 态对**所有** abort 入口既不取消也不 settle（静态，unverified）；F4 [info] `clearQueue()` 放过 invisible turn，`abort_and_clear_queue` 靠随后的 `requestAbort` 补第二刀。F3 细化：running `session_command` 对所有 abort 入口都在语义之外（`AS:9482` 与 `AS:9536` 两个谓词都是 turn-only），且 `running→queued` 是非法迁移（`SAS:100-108`）；`abortForUpdateRestart` 连 `abortCompaction` 都不调 ⇒ 在飞 `/compact` 会拖住 `waitForSessionInputCheckpoint`（`AS:9115-9117`）。
**去重（Q2 §7）**：`decisions.jsonl` 322 条中 `suspend|pump|fence|wake` 命中 **0**，`abort` 只命中 H-1/DO-4/MV-4/R25-1/K3R-11 且均不重合 ⇒ 建议新登记；另注意 decisions.jsonl 里的 **F1/R1 与测试文件 `f1-*`/`r1-*` 不是同一命名空间**（不要混指）。
**本线独立复现的一条 high（② 与 ④/⑤ 交叉）**：`mutateQueuedMessage`（活体客户端队列编辑/删除，`agent-session.ts:8837`/`:8884`）→ `resumeQueuedWork()` → `_resumeSessionInputAdmission()`（`:9278-9282`）**无条件抬掉 update-restart 栅栏**，teardown 期间把排队命令开成 turn；对照 `resumeQueuedWorkFromConnection()` 是拒绝的。探针 `/tmp/r39-q1/fence-probe.ts`（已实测，含正控；活体可达 `daemon-mode.ts:4962 case "mutate_queued_message"`）。

### ③ pause/resume 窗口的投递与保序
见 `r39-q3-pause-resume.md`。**保序方面未发现行为性缺陷（负结论，带正控）**：
- F6 [info] 同 lane 到达序在 pause/resume、epoch 失效 + `rollback`、`enqueueFront` 交互下**均保真**；`ActionStore.rollback`（session-action-store.ts:277-279）只改 lifecycle、**不移动数组元素** ⇒ 位置保留（Q3 单元 + 2 个集成探针全绿）。
- F4 [info] 跨 lane 的"steering 优先"倒序是既定契约，pause/resume **没有额外引入**倒序（与 Q1-1 同源）。
- F5 [low，静态] 唯一未实测的倒序嫌疑：deferred RLM 终局通知在 resume flush 时被**追加到"唤醒它的那条后到消息"之后**（`7999→9278-9293→6860/6880-6899→enqueue 7977`），与 `agent-session.ts:2998-2999` 的既定规则「child terminal notice must be read first」相反；需真实 RLM 子代理在挂起期终结才能复现。
- Q3 的正控方法：用公开 `mutateQueuedMessage(move)` **人为造出** C1 早于 F1 的倒序，探针确实报出倒序 ⇒ 上面"顺序相同"不是探针失明；另三种构造（无暂停 / `queuedWorkPause` 窗口 / `requestAbort` 挂起 + resume）顺序逐字相同。
**真正的问题不在顺序而在投递丢失**（Q3 的三条）：
- **F1 [high]** admission 暂停的拒收是**裸 Error**（`agent-session.ts:7950-7952`），而泵挂起抛的是类型化 `SessionInputSuspendedError`（`:7926-7931`）；发送端 `isRetryableAgentMessageSendError`（`agent-messages.ts:823-835`）只匹配后者文案 ⇒ `rememberFailure`（`:1076-1081`）把 message_id 记成 `uncertain`，同 id 重发被顶掉并谎称"host 无法判断是否到达"（实测第二条返回 "Refusing to resend message_id id-p..."），**事实是投递前就被拒、一字未达**。可达窗口不小：ACP `session/cancel` 持 pause 跨 stopSessionWork（`acp-mode.ts:1082-1083`）、MCP 重载（`agent-session.ts:2126`）。修复方向：改抛类型化错误，或给清单加 `/input admission is paused/i`。
- **F2 [medium]** 暂停期被拒的心跳 tick 在 `cron-jobs.ts:1279` 记成 `ran`（runCount/lastRunAt 推进、once 直接 completed）⇒ 心跳静默丢失 + 账本失真（与 Q4-F6/G4 同族）。
- **F3 [medium]** update-restart 的 queued-work pause **只停泵不停准入**：`daemon-mode.ts:6485` 的 manifest 快照之后到达的消息仍被收下并回执 queued，重启即丢。

### ④ 同 queueKey 的 coalesce
见 `r39-q4-coalesce.md`。**答案：skip = 永久丢弃**（无 ticket、无事件、无 log、payload 无落点），不是重投；只有显式带 key 的调用方（心跳 `heartbeat:<jid>`、显式传 key 的 RPC/API）进这个面，用户输入与 agent_message 都不带 key。
- F1 medium（丢弃且无票据，实测 T1/T10/T11）；F5 medium（owner 在 committing/running 时不命中 ⇒ 同 key 两条并存且都投递，按 key 取消在 running 时静默 no-op，实测 T5a/T5b）；F3 low（`prompt()` 带 key 被吞时全静默，且 `disposition:"queued"` 与 `accepted:false` 自相矛盾）。
- 与 G4 的关系：G4 已修"coalesce 被记成 ran"的记账，F6 补的是**可见性**（TUI 不显示 `lastSkippedAt`）。

### ⑤ 多源并发同刻到达的确定性
见 `r39-q5-multisource.md`。**答案：不是"事件循环偶然序"，是三条结构规则**——lane 优先级 > 同 lane 入队调用序 > 而"入队何时发生"取决于该入口在 `_admitSessionInput` 之前**有没有 await**；因此**同步准入源恒插队到异步（fence）准入源之前**（心跳总是晚于同 tick 的用户 steer）。
- 中间一条与 Q1 交叉实测：`/tmp/r39-q1/q1h2.ts`（先心跳后用户 steer ⇒ 队列序 `[USER_SECOND, HEARTBEAT]`，发出序被反转；对调调用序则一致 ⇒ 正控）。
- 唯一真正"依赖事件循环"的口子：Q5 F2（扩展注册 async `input` handler 时，用户 prompt 的入队时刻 = handler 完成时刻，medium）。

---

## 全线条目总表（severity 降序）

| # | 线 | 命题 | severity | confidence | 可复现 |
|---|---|---|---|---|---|
| Q1-8 | q1/母席 | 队列编辑（活体客户端 `mutate_queued_message`）抬掉 update-restart 栅栏，teardown 中把排队命令开成 turn | **high** | high（实测+正控） | `/tmp/r39-q1/fence-probe.ts` |
| Q4-F1 | q4 | coalesce = 永久丢弃 + 零票据（无 ticket/事件/log，payload 含 prefixMessages 无落点） | medium | high（实测） | `q4-coalesce.test.ts` T1/T10/T11 |
| Q4-F5 | q4 | owner 在 committing/running 时不命中 coalesce ⇒ 同 key 两条并存且都投递；按 key 取消在 running 时静默 no-op | medium | high（实测） | T5a/T5b |
| Q5-F2 | q5 | 扩展 async `input` handler 的完成时刻决定同 lane 入队序（真正的事件循环依赖口） | medium | high（实测） | `P5`/`P5c` |
| Q1-7 | q1 | 默认心跳走 steering lane ⇒ 后台心跳排到用户 follow-up 之前并截断当前 run | medium | high（实测） | `/tmp/r39-q1/q1g2.ts` |
| Q1-9 | q1+q5 | 同刻到达序 = 入队路径 await 深度，≠ 发出时刻（跨来源重排） | medium | high（实测） | `/tmp/r39-q1/q1h2.ts` |
| Q1-1 | q1 | 跨 lane 优先级压过到达序（steer 恒优先；可致 followUp 饥饿） | medium（语义/文档） | high（实测+2 正控） | `/tmp/r39-q1/q1abc.ts` |
| Q2-F2 | q2 | `abortForUpdateRestart` 不做同步 settle ⇒ 已派发的 queue-turn 停在 `running` 且不入 restart manifest | medium | high（实测+正控） | `abort-fate.probe.test.ts` T2 |
| Q2-F3 | q2 | `running` 的 `session_command` 对所有 abort 入口既不取消也不 settle | low | 静态（unverified） | q2 报告 |
| Q2-F4 | q2 | `clearQueue()` 放过 invisible turn；靠 `requestAbort` 第二刀才全清 | info | 静态+注释自证 | q2 报告 |
| Q2-F1b | q2 | `compact()`（`AS:10127`）同样无栅栏检查地 `resumeQueuedWork()`，与同文件 `AS:10250` 的检查自相矛盾 | (Q1-8 同族) | 静态（未实测） | — |
| Q3-F1 | q3 | admission 暂停的拒收是裸 Error，不在可重试清单 ⇒ 子代理回执记 uncertain、重发被拒、文案谎称"可能已到达 | **high** | high（双向实测） | `lane-priority.test.ts` |
| Q3-F2 | q3 | 暂停期被拒的心跳 tick 被记成 `ran`（账本失真 + 心跳静默丢失） | medium | 静态+逐字 | q3 报告 |
| Q3-F3 | q3 | update-restart 的 queued-work pause 只停泵不停准入 ⇒ manifest 快照之后的准入随关闭丢失 | medium | 静态+逐字 | q3 报告 |
| Q3-F4/F6/F5 | q3 | 负结论：pause/resume 与 rollback 下同 lane 保序（带正控）；跨 lane 倒序是契约；F5 为未实测倒序嫌疑 | info/low | high/info | q3 报告 |
| Q4-F3 | q4 | `prompt()/promptUntilAccepted()` 带 key 被 coalesce 时全静默；`disposition` 自相矛盾 | low | high（实测） | T9/T12 |
| Q4-F8 | q4 | 整快照恢复绕过 coalesce，逐条 `restore*Message` 不绕过 | low | high（实测） | T 系列 |
| Q1-4 | q1 | 会话命令 lane 随 `isStreaming` 变（流式中成为 steer ⇒ 截断 run） | low | high（实测） | `/tmp/r39-q1/q1f.ts` |
| Q1-5 | q1 | goal objective 更新 `enqueueFront` 越到同 lane 已排队项之前（lane 内 FIFO 的唯一例外写入口） | low | high（静态） | 静态 |
| Q1-6 | q1 | UI 改队只能在 lane 内交换；改成 steering 是**追加到目标 lane 末尾**并清 queueKey | low | high（静态） | 静态 |
| Q5-F4 | q5 | worker 传输在 `prompt`/命令前多一个 claim await（静态风险点，未实测） | low | medium（非 worker 面）/ low（worker 面） | 未实测 |
| Q1-2 | q1 | followUp 不打断进行中的 run（设计意图，但文档只写了半句） | info | high（实测） | `/tmp/r39-q1/q1d2.ts` |
| Q1-3 | q1 | `steeringMode="all"` 批内合并保序，批边界由 executionPolicy 相等性决定 | info | high（实测） | `/tmp/r39-q1/q1e.ts` |
| Q1-10 | q1 | 负结论：批合并循环"selectFirst 跨 lane 取错"隐患**不成立**（同步性保证），带正控 | info | high | `/tmp/r39-q1/q1i.ts` |
| Q5-F1/F3/F5 | q5 | 同刻分类规则、fence 型 FIFO、泵无陈旧快照 | info | high | `P1/P2/P3` |
| Q4-F2/F4/F6/F7 | q4 | 先到者赢（产品面不可达）、跨 lane 吞（有意）、skip 记账可见性、`coalesced` 死代码 | low/info | — | q4 报告 |

---

## 判据完成度（"顺序错 ⇒ 行为错"的可复现输入）

已给出**逐字可执行**的重现输入（每条都在 /tmp，仓库零写入）：

1. **跨 lane 反转**：同流式中先 `followUp("F1")` 后 `steer("S1")` ⇒ 投递 `[start,S1,F1]`（`q1abc.ts` A）。
2. **心跳插队用户**：先 `followUp("USER_ALT_ENTER follow-up")` 再 `promptHeartbeat(job,{streamingBehavior:"steer"})` ⇒ 队列 `{steering:["Heartbeat prompt: HEARTBEAT_TICK"], followUps:["USER_ALT_ENTER follow-up"]}`（`q1g2.ts`）。
3. **同刻跨来源重排**：同 tick 先心跳后用户 steer ⇒ 队列 `[USER_SECOND, HEARTBEAT…]`（`q1h2.ts`）。
4. **teardown 期间被开 turn**：`abortForUpdateRestart` → `mutateQueuedMessage(...,{type:"delete"})` ⇒ `suspended:false`、剩余排队 steer 被交付（`fence-probe.ts`）。
5. **心跳 coalesce 丢弃**：同 `heartbeat:<jid>` 第二次 tick 被吞，队列快照逐字节不变（q4 T1/T6/T10）。
6. **同 key 双投**：owner 已 committing/running 时同 key 再排 ⇒ `unfinishedActionCount==2` 且两条都投递（q4 T5a）。

## 负结论与正控对应表
| 负结论 | 正控 |
|---|---|
| Q1-1 "优先级压过到达序"（不是探针恒反转） | 同 lane FIFO 保持（B）；到达序==优先级序时结果一致（C） |
| Q1-10 "selectFirst 不会跨 lane 取错" | 两条 lane 同时非空时每次都整条 lane 先出且零丢失（`q1i.ts` 两个方向） |
| Q1-8 "只有带栅栏检查的入口才安全" | `resumeQueuedWorkFromConnection()` 返回 false 且状态不变（`fence-probe.ts`） |
| Q5 "同步源恒插队异步源"（不是噪声） | 对调调用序，队列结果相反/一致（P2c/P3） |
| Q4 "被吞不是探针乱报" | 异 key 必投递、owner completed 后同 key 必投递、非 coalesce 到达必发 `session_action_update`（T2/T4/T6/T10） |
| Q1-7 "心跳不带 streamingBehavior 不会静默入队" | 同场景 `followUp()` 正常入队（`q1g.ts` 报错 vs `q1g2.ts` 入队） |

## 未覆盖 / unverified（明确声明）
- Q1-5/Q1-6 仅静态逐字，未跑行为面。
- Q5-F4 worker 传输 claim await 的换序：未实测（需真 daemon/worker 双 socket，超出窗口）。
- Q2/Q3 报告的 unverified 格子以各自文件为准（见其 §"未覆盖"）。
- ACP 模式入口未单独实测（其 steer/followUp 经 `agent-connection` 同路径，按同形处理）。
- 未跑全仓测试（按纪律，仅跑线内探针与仓内既有相关测试为对照）。

---

## 工件清单（全部在 /tmp/audit_r/round-39/，仓内零写入）

| 工件 | 内容 | 运行方式 |
|---|---|---|
| `qpump-order-semantics.md` | 本收口报告 | — |
| `r39-q1-priority.md` | Q1 全文（10 条） | — |
| `r39-q2-abort.md` | Q2 全文（abort 条件表） | — |
| `r39-q3-pause-resume.md` | Q3 全文（6 条 + 正控） | vitest（仓自带 config） |
| `r39-q4-coalesce.md` | Q4 全文（8 条） | `node <repo>/node_modules/vitest/dist/cli.js --run --root /tmp/audit_r/round-39 --config <repo>/packages/coding-agent/vitest.config.ts --no-file-parallelism --reporter=verbose q4-coalesce.test.ts`（13/13 绿） |
| `r39-q5-multisource.md` | Q5 全文（5 条） | `cd <repo>/packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run --config /tmp/audit_r/round-39/vitest.q5.config.ts`（8/8 绿，EXIT=0） |
| `q1abc.ts` / `q1d2.ts` / `q1e.ts` / `q1f.ts` / `q1g.ts` / `q1g2.ts` / `q1h2.ts` / `q1i.ts` / `fence-probe.ts` | Q1（母席线）9 个 tsx 探针 | `cd /tmp/r39-q1 && env -u RLM_DEPTH -u RLM_SESSION_DIR -u PRIME_AGENT_SESSION_DIR -u PI_SESSION_DIR <repo>/node_modules/.bin/tsx <file>` |
| 各线 `*-heartbeat.txt` | 逐步心跳（时间+动作+结果） | — |

**方法学坑（供后续线复用）**：
1. 探针放 /tmp 时，`tsx` 会在无 `package.json` 的目录按 CJS 转译 ⇒ **top-level await 报错**，需在探针目录放 `{"type":"module"}`，并把 `node_modules` 软链到仓（bare import 才能解析）。
2. vitest 5 的 `--dir` **不生效**，会退化成跑全仓测试；只跑 /tmp 探针要用 `--root <探针目录> --config <仓 vitest.config.ts>`。
3. 跑任何测试前按纪律 unset 泄露 env（`RLM_DEPTH/RLM_SESSION_DIR/RLM_CHILD_ID/RLM_NAME/RLM_MODEL/PRIME_AGENT_SESSION_DIR/PI_SESSION_DIR`）。
