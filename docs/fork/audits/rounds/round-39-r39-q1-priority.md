# r39 Q1 —— steering / follow_up / queued 命令 / 心跳 prompt 的相对优先级与到达序

线名：r39-q1-priority（母席自营线）
仓：/Users/a1/Desktop/ai/prime-agent @ e8f6527dc44a548d961cdf336bd514bcafa24fa7（只读；零写入）
探针（全部实测、无网络、各约 1s）：q1abc.ts（A/B/C 跨 lane 优先级与同 lane FIFO）、q1d2.ts（D 多轮 run + 全事件轨迹）、q1e.ts / q1i.ts（steeringMode=all 批合并）、q1f.ts（会话命令 lane）、q1g.ts/q1g2.ts（心跳默认 lane + 缺 streamingBehavior 报错正控）、q1h2.ts（同刻多源到达序）、fence-probe.ts（Q1-8 栅栏）
运行：`cd /tmp/r39-q1 && env -u RLM_DEPTH -u RLM_SESSION_DIR -u PRIME_AGENT_SESSION_DIR -u PI_SESSION_DIR <repo>/node_modules/.bin/tsx q1d2.ts`（node_modules 软链到仓；harness = test/suite/harness.ts + scheduling.ts + faux provider）

## 0. 坐标系（先确定语义）

两层队列，互不喂食：
- **会话层**（本题主体）：`ActionStore`（core/session-action-store.ts），两条独立 lane：`delivery:"next_turn_boundary"`（= steer）与 `"when_run_idle"`（= followUp），内部两个数组 `nextTurnBoundary` / `whenRunIdle`。`agent-session.ts:1634` 逐字写着 **"Session-owned actions. Items are never fed into Agent.steer/followUp."**
- **Agent 层**（packages/agent）：`steeringQueue`/`followUpQueue`（agent.ts:197-198），循环里先 poll steering（agent-loop.ts:682-690），再 poll followUp（:699-707）。生产路径上 `agent.steer()` **无调用者**（`grep -rn "\.steer(" packages/*/src` 只命中 `session.steer`；`agent.followUp` 仅 agent-session.ts:10773 用于压缩后续跑回队）。

**关键机制（本轮新认定，决定一切排序结论）**：会话层不是"注入到正在跑的 run 里"，而是**在 turn 边界把 run 截断**，再由泵按 lane 优先级开新 run。
- `agent-session.ts:3101-3116`：
  ```
  private get _steeringStopPending(): boolean {
      return this._actionStore.queuedActions("next_turn_boundary").length > 0 ||
          this._actionStore.activeActions("next_turn_boundary").some((action) =>
              action.payload.kind === "turn" && (action.lifecycle.state === "selected" || action.lifecycle.state === "preparing"));
  }
  private _shouldStopBeforeTurn(): boolean { return this._steeringStopPending; }
  ```
- `agent-session.ts:3151`：`_shouldStopAfterTurn` 末尾 `return this._steeringStopPending;`
- 泵 `_pumpSessionInputs`（:8084 起）先 `await this.agent.waitForIdle()`，再 `selectFirst()`；`session-action-store.ts:250`：
  ```
  selectFirst(): TAction | undefined {
      const action = this.nextTurnBoundary.find((item) => item.lifecycle.state === "queued") ??
          this.whenRunIdle.find((item) => item.lifecycle.state === "queued");
  ```
⇒ **steering 恒优先于 followUp，与到达序无关**；到达序只在**同 lane 内**是 FIFO。lane 语义是：steering = 截断当前 run 的 turn 序列（下一个人工边界开新 run），followUp = 不打断，等整个 run 自然结束。

## 0b. 源×lane 对照表（"谁插队"的完整答案；每行 file:line）
| 来源 | lane | 逐字依据 |
|---|---|---|
| 用户 TUI **Enter**（steering） | next_turn_boundary | `in-process-agent-connection.ts:433 await this.session.steer(message, images, { resumeIfIdle: true })`（RPC 同形：`rpc-mode.ts:229`） |
| 用户 TUI **Alt+Enter**（follow-up） | when_run_idle | `in-process-agent-connection.ts:437 this.session.followUp(...)`（RPC：`rpc-mode.ts:232`） |
| daemon `session.input` 显式 `streamingBehavior` | 按该字段 | `daemon-mode.ts:4497 session.steer(...)` / `:4521 session.followUp(...)` |
| daemon `session.input` **未指定** streamingBehavior 且会话忙 | **不入队，硬报错** | `agent-session.ts:7296-7301`（实测报错文本见 Q1-7） |
| **子代理回执 agent_message** | **steering（硬编码）** | `daemon-mode.ts:6355-6360 acceptAgentMessagePrompt(message.content, { expandPromptTemplates:false, streamingBehavior:"steer", queueIfBusy:true, ... })` |
| **心跳（默认 deliveryMode）** | **steering** | `cron-jobs.ts:192 DEFAULT_HEARTBEAT_DELIVERY_MODE = "steer"` + `:1432` + `daemon-mode.ts:2008 streamingBehavior: resolveHeartbeatStreamingBehavior(current.deliveryMode)` |
| 心跳 `deliveryMode: "follow_up"` | when_run_idle | 同上（`:1432` 的三元） |
| cron 非心跳 job（忙时） | when_run_idle | `daemon-mode.ts:1984 await session.followUp(runnableJob.prompt, undefined, { resumeIfIdle: true })` |
| goal objective 更新 | when_run_idle + **enqueueFront** | `agent-session.ts:3017-3021` |
| goal/cron continuation、RLM 终止通知 | when_run_idle | `agent-session.ts:2999`、`:7114` |
| 会话命令 `/compact` `/refine` 等 | 流式中→steering；否则→followUp | `agent-session.ts:7267 const schedule = options?.streamingBehavior ?? (this.isStreaming ? "steer" : "followUp")`（实测见 Q1-4） |
⇒ **默认配置下，三条"非用户"来源（子代理回执、心跳、流式中提交的斜杠命令）全都压过用户的 Alt+Enter follow-up**；只有用户 Enter（steer）能压过它们（同 lane FIFO）。

## 1. Q1-1 跨 lane 优先级压过到达序（实测）
**命题**：先排 followUp，后排 steer ⇒ 投递序是 steer 先、followUp 后（到达序被 lane 优先级反转）。
severity: **medium**（语义/文档面；非数据丢失）　confidence: **high（实测）**
file:line：session-action-store.ts:250（selectFirst lane 序）；agent-session.ts:3101-3116、3151（run 截断）；agent-session.ts:6320-6323（作者自认的不变量注释："a child reply is a steer (`next_turn_boundary`) and a notice is a follow-up (`when_run_idle`), and `selectFirst` always prefers the steer"）
逐字证据（q1abc.ts 输出，A 行）：
```
"label": "A followUp(F1) then steer(S1)",
"arrival": [["followUp","F1"],["steer","S1"]],
"preview": {"steering":["S1"],"followUps":["F1"],"queuedCount":2},
"delivered": ["start","S1","F1"], "pass": true
```
**正控（两条，缺一不可）**：
- 同 lane FIFO 未被破坏 ⇒ 探针不是"恒反转"：B `steer(S1)`→`steer(S2)` 投递 `["start","S1","S2"]`（pass:true）。
- 到达序==优先级序时结果一致 ⇒ 探针确实在测"实际投递序"而非常量：C `steer(S1)`→`followUp(F1)` 投递 `["start","S1","F1"]`（pass:true）。
**影响**：用户按 Alt+Enter 排的 follow-up 可被任意后续 Enter（steering）/子代理回执 / 心跳之外的一切 steer **无限期插队**（steer 每来一条就把 run 截断一次，followUp 永远排在后面）——饥饿，无上限、无老化、无告警。反向：followUp 连"长 tool 循环 run"都不打断，故也可能被一个长 run 拖很久。
**可复现**：`/tmp/r39-q1/q1abc.ts` 场景 A（约 1s，无网络）。

## 2. Q1-2 followUp 不打断进行中的 run（同一实测文件 D 提供反向正控）
**命题**：followUp 在 run 中途到达不会在 turn 边界截断 run；steer 会。
severity: info（这是设计意图，README 里有半句话）　confidence: **high（实测，事件轨迹逐帧）**
file:line：agent-session.ts:3151（`_shouldStopAfterTurn` 只看 `_steeringStopPending`，即只看 `next_turn_boundary`）
逐字证据（q1d2.ts 事件轨迹，40-42ms）：S1(steer) 到达后
```
40ms ev agent_end                                   <- run 在 turn 边界被截断
40ms ev session_action_update ... "active":{"kind":"turn","phase":"preparing","label":"S1"}
41ms agent.prompt role=[{"role":"user","content":[{"type":"text","text":"S1"}]...] activeRun=false
```
而 F1（followUp，同刻排队）在整个 S1 run（含 `waitB` turn + `final answer` turn 两次 turn_start）期间**始终留在队列**，直到该 run `agent_end` 之后才被 pump 开 run：
```
"finalUserTexts": ["start","S1","F1"]
```
**影响**：语义符合 README/usage.md:70（"delivered only after the agent finishes all work"），但**没有文档说"steer 会截断 run 而 followUp 不会"**，也没有文档说截断发生在 turn 边界（agent-session.ts:7463-7465 的 jsdoc 与 README:193 用"after the current assistant turn finishes executing its tool calls, before the next LLM call"描述，容易被读成"注入同一 run 的下一个 LLM 调用"；实测是**结束该 run、另起一次 agent.prompt**，见上面 `agent_end` 先于 `agent.prompt`）。
**可复现**：`/tmp/r39-q1/q1d2.ts`（输出即上述轨迹）。

## 3. Q1-3 steeringMode="all" 的批内合并保序
**命题**：`steeringMode="all"` 时同刻到达的多条 steer 合并进**同一个 turn**（一条 prompt 里多条 user 消息），顺序仍为到达序。
severity: info　confidence: **high（实测）**
file:line：agent-session.ts:8123-8136（`mode==="all"` 时连续 select 直到 executionPolicy 不同）；判据 `turnExecutionPoliciesEqual` 不同即断开。
逐字证据（q1e.ts）：`"mode":"all"`, `userTexts: ["start","S1","S2"]`, `roles: ["user","assistant","toolResult","user","user","assistant"]`（两条 user 相邻 = 同一 turn）。
**影响**：`"all"` 只保证**批内**到达序；批的切分点由 `executionPolicy` 相等性决定（queueKey 不参与），因此"合并批次"边界对使用者不可预测，但不会重排。

## 4. Q1-4 会话命令（queued commands）走哪条 lane：取决于提交时的 isStreaming
**命题**：`/compact`、`/refine` 等会话命令的 lane 不是固定的，而是提交时若在流式 → steering lane，否则 → followUp lane。
severity: low（可预测性/文档）　confidence: high（静态逐字）
file:line：agent-session.ts:7266-7277
```
const schedule = options?.streamingBehavior ?? (this.isStreaming ? "steer" : "followUp");
const action = this._createSessionCommandAction(normalized.text, normalized.command, ..., schedule, ...)
```
`_deliveryPolicy`（:7730）`schedule === "steer" ? "next_turn_boundary" : "when_run_idle"`。
**影响**：同一个 `/compact` 命令在流式时提交会**截断当前 run**（因为它进了 next_turn_boundary，被 `_steeringStopPending` 计入，而该判据对 payload.kind 无过滤——只看 lane），并在 turn 边界先于任何已排队的 followUp 执行；空闲时提交则排在所有已排队 followUp 之后。同一命令两种命运，无文档。
逐字证据（/tmp/r39-q1/q1f.ts，**行为面已实测**）：
```
{"whileStreaming":{"steering":["/compact"],"followUps":[],"queuedCount":1},"isStreaming":true}
```
即流式中提交的 `/compact` 出现在**steering lane**（= `delivery:"next_turn_boundary"`），而 `_steeringStopPending` 正是 `queuedActions("next_turn_boundary").length > 0` ⇒ run 在该 turn 边界被截断。
**可复现**：`/tmp/r39-q1/q1f.ts`（约 1s，无网络）。

## 5. Q1-5 goal objective 更新用 enqueueFront → followUp lane 内可越序（唯一越序写入口）
**命题**：`_runOrQueueGoalContext` 以 `front: true` 入队，插到 followUp lane 第一个 queued 之前，压过先到的 followUp（含心跳、goal continuation）。
severity: low　confidence: high（静态逐字 + 同文件对照注释）
file:line：agent-session.ts:3017-3021（`this._admitSessionInput(action, { front: true, wake: false })`）→ :7976（`if (options.front) this._actionStore.enqueueFront(action)`）→ session-action-store.ts:219-225（插到第一个 `queued` 之前）
对照（同一函数的兄弟路径刻意**不用** front）agent-session.ts:2998-2999：`// No front: a settling child's terminal notice must be read first.`
**影响**：lane 内"到达序=FIFO"的可见保证有一个例外，且这个例外会体现在 UI 队列列表（`getSessionActionSnapshot` 的 followUps 直接来自 store 数组序）——用户用 Alt+Up/Down 手工排好的顺序会被一次 goal 更新顶掉，且无提示。
**可复现**：静态；行为面 unverified。

## 5b. Q1-6 UI 改队路径的排序语义（谁插队：手工编辑也算）
**命题**：队列编辑只能**同 lane 内交换**；把一条 followUp 改成 steering（浏览时 Enter）会**追加到 steering lane 末尾**，从而越到该 lane 已有的 followUp 之前，并**清掉 queueKey**（脱离 coalesce）。
severity: low　confidence: high（静态逐字）
file:line：agent-session.ts:8840-8845（`move`：只与 lane 投影里的相邻项 `swapQueued`，跨 lane 直接被 `swapQueued` 的 same-delivery 检查挡下）；agent-session.ts:8878-8883（跨 lane `replace`：`item.queueKey = undefined; item.wake = ...; this._actionStore.moveQueued(item, targetPolicy, this._actionStore.queuedActions(targetPolicy).length)` = 追加到目标 lane 末尾）；session-action-store.ts:287-301（`swapQueued` 要求 `left.delivery === right.delivery`）
**影响**：① 用户无法用 Alt+Up 把 followUp 提到 steering 之前（lane 墙，`docs/usage.md:75` 的"within its queue"其实与实现一致，但读起来像全局重排的说明）；② 改成 steering 是**追加到末尾**而不是"就地成为下一条 steer"，与"编辑后立刻生效"的直觉不完全一致（偷越的是 followUp 而非同 lane 的 steer）；③ 清 queueKey 之后，同 key 的下一条心跳不再被 coalesce，队列里会出现两条同语义心跳（与 G4 / Q4 线交叉）。
**可复现**：静态（三处逐字已贴）；行为面由 Q4 线覆盖。

## 5c. Q1-7 默认心跳走 steering lane ⇒ 后台心跳排到用户 follow-up 之前并截断当前 run（实测）
**命题**：`cron-jobs.ts:192 DEFAULT_HEARTBEAT_DELIVERY_MODE = "steer"`，daemon 把 `resolveHeartbeatStreamingBehavior(deliveryMode)` 作为 `streamingBehavior` 传给 `promptHeartbeat`（daemon-mode.ts:2006-2014），`steer` ⇒ `delivery:"next_turn_boundary"`。于是**默认配置**下，一条后台心跳会（a）进入 steering lane、（b）被 `_steeringStopPending` 计入而**截断正在跑的 run**、（c）排到**更早排队的用户 Alt+Enter follow-up 之前**。
severity: **medium**（用户意图被后台任务插队；heartbeat 是 agent 自有、非用户输入）　confidence: **high（实测 + 静态逐字）**
file:line：cron-jobs.ts:192、cron-jobs.ts:1429-1433（`return (deliveryMode ?? DEFAULT_HEARTBEAT_DELIVERY_MODE) === "follow_up" ? "followUp" : "steer";`）、cron-jobs.ts:1632-1638（显式不为 steer 心跳让路："`steer` heartbeats interrupt the current turn, so a plain streaming turn must not defer them"）、daemon-mode.ts:2006-2014、agent-session.ts:6282-6289（`promptHeartbeat` → `_promptInjectedMessage`，`schedule = options?.streamingBehavior ?? "followUp"`）
逐字证据（/tmp/r39-q1/q1g2.ts，**实测**）：
```
{"res":{"admitted":true,"coalesced":false},
 "snapshot":{"steering":["Heartbeat prompt: HEARTBEAT_TICK"],"followUps":["USER_ALT_ENTER follow-up"],"queuedCount":2}}
```
脚本时序：先 `session.followUp("USER_ALT_ENTER follow-up")`（用户 Alt+Enter），再 `promptHeartbeat(job, {streamingBehavior:"steer"})`（daemon 对默认 deliveryMode 的真实调用形态）⇒ 心跳进 steering、用户消息留 followUp ⇒ **心跳先投递**。
**附带发现（同一条）**：`_coalescedFollowUpOwner`（agent-session.ts:7906-7917）对 `delivery !== "when_run_idle"` 直接 return undefined ⇒ **steer 心跳永不被 coalesce**（同一 job 的高频 tick 会逐条排队、逐条截断 run），而 follow_up 心跳会被 coalesce 丢弃（G4，已修/已记）。
另一条负结论（带正控）：`promptHeartbeat(job)` **不传** streamingBehavior 而会话在流式中 → 硬报错 `"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."`（q1g.ts 实测），即心跳入队参数缺失时不会静默入队。正控：同一次运行里 `session.followUp(...)` 在流式中被正常收下（snapshot.followUps 有值）⇒ 该探针确实能区分"报错"与"入队"。
**边界（避免过度声明）**：`rg "promptHeartbeat" packages/*/src` 全仓只有 1 个调用点（`daemon-mode.ts:2026`，已显式传 streamingBehavior）⇒ 上述硬报错今天**不可达**，它是 API 形状上的潜在坑（`promptHeartbeat` 默认参数组合在流式中必然失败），不是活体 bug。
**影响**：用户在长 run 中按 Alt+Enter 排队的提示词，会被一条周期心跳顶到后面（且心跳还会把 run 截断重开），用户看不到任何解释；`docs/` 里没有任何地方说明心跳的默认 lane 是 steering。
**可复现**：`/tmp/r39-q1/q1g2.ts`（约 1s，无网络）；`/tmp/r39-q1/q1g.ts`（报错正控）。

## 5d. Q1-8 （与 Q2 线交叉，本轮母席独立复现）update-restart 栅栏被"队列编辑"这条活体客户端路径抬掉：teardown 期间排队命令被开成 turn
**命题**：`abortForUpdateRestart()` 把队列挡在 update-restart 栅栏后（`_sessionInputPumpSuspended && _sessionInputSuspendedForUpdateRestart`）。连接面入口 `resumeQueuedWorkFromConnection()` 会拒绝抬栅栏，但**队列编辑/删除路径** `mutateQueuedMessage()` → `resumeQueuedWork()` → `_resumeSessionInputAdmission()` 会**无条件**清掉这两个标志并 `_sessionInputPumpEpoch++`，随后 `_scheduleSessionInputPump()` 把排队命令在 teardown 中开成 turn。
severity: **high**（击穿一处被注释和测试明确声明的不变量；teardown 期间起 turn）
confidence: **high（母席独立实测 + 逐字代码）**
file:line：
- `agent-session.ts:8822-8886`（`mutateQueuedMessage`）内 `:8837 this.resumeQueuedWork();`（delete）与 `:8884 this.resumeQueuedWork();`（replace/apply）
- `agent-session.ts:9311-9316`（`resumeQueuedWork()` **无**栅栏检查）vs `:9331-9334`（`resumeQueuedWorkFromConnection()` 先 `if (this._updateRestartFenceUp) return false;`）vs `:9303-9304`（`wakeSuspendedSessionInput()` 同样先查 `_sessionInputSuspendedForUpdateRestart`）
- `agent-session.ts:9278-9282`：`_resumeSessionInputAdmission()` = `_sessionInputPumpSuspended = false; _sessionInputSuspendedForUpdateRestart = false; _sessionInputPumpEpoch++;`
- 活体可达性：`daemon-mode.ts:4944-4951 case "mutate_queued_message"` → `session.mutateQueuedMessage(...)`；TUI 队列浏览的移动/编辑/删除即走此命令（`interactive-mode.ts:7320`、`:7404`）
逐字证据（/tmp/r39-q1/fence-probe.ts，母席独立复现，非 Q2 线产物）：
```
"before":  {"suspended": true,  "count": 2, "snapshot":{"steering":["A","B"]}}
"conn":    false                                   <- 正控：连接面入口拒绝抬栅栏
"afterConn":{"suspended": true, "count": 2}         <- 栅栏仍在
"after":   {"status":"applied", "suspended": false, "count": 0, "userTexts":["start","A"]}
```
即：一条客户端发来的"删除第 2 条排队消息"命令，把栅栏抬掉并把剩下的排队 steer **A** 开成了 turn（`userTexts` 里出现 A），而 `docs`/注释（`:9298-9301`、`:9323-9327`）与既有测试 `agent-session-parked-queue.test.ts` "the connection resume path never lifts the update-restart fence (scan3-queue A8×Q1)" 都声明这不该发生。
**正控说明**：同一次运行里 `resumeQueuedWorkFromConnection()` 返回 false 且状态不变 ⇒ 该探针能区分"抬栅栏"与"被拒绝"，不是探针自身在改状态。反面对照：非 teardown 下同一命令只删队列、不开意外 turn。
**附带影响**：`_sessionInputPumpEpoch++` 会作废在飞的 pump/dispatch（`_isDeferredSessionInputError`、`committing` 回滚需 `dispatchSettled` 证明），因此这不只是"多起一个 turn"，还可能让一个已 dispatch 的 turn 的交付记录进入回滚判定。
**可复现**：`/tmp/r39-q1/fence-probe.ts`（约 1s，无网络）。

## 5e. Q1-9 （与 Q5 线交叉）同刻到达的"到达序"由**入队路径的 await 深度**决定，不由调用/发出时刻决定（实测）
**命题**：同一 tick 内先发起心跳、后发起用户 steer，最终 lane 内顺序是 **用户 steer 在前**（发出序被反转）；把两次调用的先后对调，顺序又变成用户 steer 在前（这次与发出序一致）。即：跨来源的"到达序"不是发出时刻，而是每条入口在 `_admitSessionInput` 之前**各自 await 了几层**。
severity: **medium**（可确定性复现的跨来源重排；模型看到的指令顺序与宿主发出顺序相反；无文档）　confidence: **high（实测 + 静态逐字）**
file:line（await 深度差异）：
- 用户 steer：`agent-session.ts:7470-7493` → `_queuePreparedPrompt`（`:7959-7986`）体内**同步**创建 action 并 `this._admitSessionInput(action)` ⇒ 调用即入队（同一 microtask）。
- 心跳：`agent-session.ts:6282-6289` → `_promptInjectedMessage`（`:7125-7137`）在入队前先 `const admissionFence = await this._acquireDirectTurnAdmissionFence(options?.signal)` ⇒ **至少让出一次 microtask** 才入队。
逐字证据（/tmp/r39-q1/q1h2.ts，**实测**）：
```
{"callOrder":["heartbeat","user_steer"],"admissionOrder_sync":["USER_SECOND"],
 "admissionOrder_settled":["USER_SECOND","Heartbeat prompt: HEARTBEAT_TICK"]}
{"callOrder":["user_steer","heartbeat"],"admissionOrder_settled":["USER_FIRST","Heartbeat prompt: HEARTBEAT_TICK"]}
```
**正控**：第二行是同一探针在"用户先、心跳后"下的结果——两次结果不同 ⇒ 探针确实在测真实相对顺序，不是恒返回同一顺序。另 `admissionOrder_sync` 只含用户项 ⇒ 证明心跳确实晚于用户那条入队（不是同一 microtask）。
**影响**：宿主按"先心跳后用户"发起的两个提示，模型会**先看到用户的**；如果两者都带指令（心跳模板含指令、用户消息含反向指令），有效顺序被反转。且这是**可确定性复现的**（同一代码路径每次同样），所以不能用"并发本来就是随机的"解释；但它也没有任何契约/文档保护——任一路径增删一个 `await` 就静默翻转。
**可复现**：`/tmp/r39-q1/q1h2.ts`（约 1s，无网络）。

## 5f. Q1-10 负结论（带正控）：批合并循环里"selectFirst 跨 lane 取走另一条"的隐患**不成立**
**待证伪的假设**：`_pumpSessionInputs` 的批合并循环（agent-session.ts:8123-8136）用 `queuedActions(first.delivery)[0]` 取"下一条"，却用 `selectFirst()` 去**选中**它；而 `selectFirst()` 是 lane 优先的（session-action-store.ts:250 先取 nextTurnBoundary）。若另一条 lane 在两者之间被填充，就会"选中 A、push B"，把 B 留在 `selected` 态不再被泵取（悬置）。
**结论（本次扫描范围内）**：**不成立**。理由是**同步性**：`:8122 const first = preselected ?? this._actionStore.selectFirst();` 到 `:8136` 之间没有任何 `await`（`first.payload.kind` 判断、`mode` 取值、`turnExecutionPoliciesEqual` 全是同步），因此另一条 lane 不可能在两者之间被填充；`selectFirst()` 的返回值恒等于 `queuedActions(first.delivery)[0]`。
severity: info（负结论）　confidence: high（静态 + 实测正控）
**正控（证明探针能检出跨 lane 取错）**：`/tmp/r39-q1/q1i.ts`，`steeringMode=followUpMode="all"`：
```
issued  F1,F2,S1  → queuePreview {steering:["S1"], followUps:["F1","F2"]} → delivered ["start","S1","F1","F2"]
issued  S1,S2,F1  → queuePreview {steering:["S1","S2"], followUps:["F1"]} → delivered ["start","S1","S2","F1"]
```
两条 lane 同时非空时，泵**每次都整条 lane 先出**（S1 无论何时到达都在 F1 之前），且 none 被漏掉/悬置（delivered 长度 = 4 = start+3，无重复无丢失）⇒ 探针确实观测到了"谁被 select"，若存在 select/push 错配就会在这里暴露。
**可复现**：`/tmp/r39-q1/q1i.ts`。
**覆盖面声明（不做的部分标 unverified）**：本负结论只覆盖"泵在同一 microtask 内连续 select"的路径；`_actionStore.rollback`/epoch 失效后重排是否保位属 Q3 线，粗粒度多源并发属 Q5 线。

## 6. 文档覆盖判定（问题①的"语义有文档吗"）
- 有：lane 的**投递时机**——`docs/usage.md:69-70`、`README.md:193-194`（"Enter queues a steering message, delivered after the current assistant turn finishes executing its tool calls" / "Alt+Enter queues a follow-up, delivered only after the agent finishes all work"）；模式开关 `docs/settings.md:328-329`（`steeringMode`/`followUpMode` = all|one-at-a-time）。
- 无（grep 全 docs 无命中）：跨 lane 优先级（steer 恒压过更早排队的 followUp）、steer 会在 turn 边界**截断 run**、会话命令 lane 随 `isStreaming` 变、`enqueueFront` 例外。
- 只在代码注释里有（面向维护者，非用户）：agent-session.ts:6320-6323 的不变量声明、:1634 的"never fed into Agent.steer/followUp"。
⇒ **结论：用户可见文档只描述了"每条消息何时被投递"，没有描述"谁插谁的队"**。任何依赖"我排在前所以先执行"的直觉在跨 lane 场景下都会错。

## 7. 本线未覆盖 / unverified
- 未跑：Q1-5 的行为面（仅静态逐字）；`steeringMode` 与 `followUpMode` 同时为 "all" 时两 lane 的批次交互。
- 未覆盖入口（明确标注）：ACP 模式、RPC 模式、daemon `session.input` 的到达序（由 r39-q5-multisource 线负责）。
- 依赖实验循环偶然序的部分不在本线结论内。
