# 上游 #2334「human 优先」× 本 fork queue pins 调和设计（v2 交卷）

> face: 施工 clone `/tmp/p2334`（detached HEAD），base=`d51118e32`（主仓 `merge/repl-kernel`，只 `git fetch` 读对象，**主仓工作树未动**）。
> 配套交付件：`2334-human-priority-APPLY.md`（同目录；应用序/冲突回执 14 条/闸红绿/正控 12 条实测/偏离与未做/F1-F10 逐条落点）。
> 本件在施工期的交付名是 `DESIGN.md`（`/tmp/p2334-out/DESIGN.md`），落仓改为本名；两文件同批提交，仓内引用可解析。
> 上游实现＝`dca77ecfe`；母席裁示＝`docs/fork/merge-upstream-20260917.md` §11 QP-4 行（状态翻面归母席/doc 车道，本席未碰那个脏文件）。

base = **`d51118e32`**（母席 G1 裁）。漂移链：原任务书 base=`91da42b93`（已作废——中间夹着 #2098 三笔
`49b326b51`/`abae4f9bb`/`bdd1ad5b7` 与两笔 CI 修 `e17535e07`/`de1ad0b06`）→ 母席 09:1x 改 `de1ad0b06`（v1 五笔的 base）
→ 母席 G1 裁落最新 HEAD **`d51118e32`**（v2 已 `git rebase --onto d51118e32 de1ad0b06 47d775592`，**零冲突**）。
施工 clone：`/tmp/p2334`（detached HEAD；主仓工作树未动，只 `git fetch` 读对象）；变异 worktree `/tmp/p2334-mut`；
干净基线 worktree `/tmp/p2334-base2`（`d51118e32`）。
**行号一律只作定位辅助，符号名为准**（src 在别的车道脚下持续移动）；§5 的行号读自 v2 交卷树，读数所在 sha 见该节标题。
交付分两波：**v1 五笔**（rebase 后 `5ea998daf`/`20942fa2d`/`7efaf9352`/`d6d29417d`/`3b3d8808c`）＋
**v2 九笔**（复核 F1-F10 的修复，sha 与逐条落点见 `2334-human-priority-APPLY.md` §1/§7）。
上游实现 = `dca77ecfe`「prioritize human messages ahead of queued agent traffic (#2334)」
（是 base 的祖先，但内容在 P3 selective merge `67334bf1a` 里被 take-ours 丢掉 ⇒「本窗被 revert」；
base 树上 `session-action-store.ts` 全文只有 1 处 `priority` 字样且在注释里。）
母席裁示（`docs/fork/merge-upstream-20260917.md` §11 QP-4 行）：**全量移植——人优先仅限 lane 内，机器互序不变**；
退路＝仅 interactive 提权 ⇒ 该笔 no-take。§9.2 行 318 / §10③ 行 344 记「调和设计待办」。

---

## 1. 结论（TL;DR）

两套语义**不互斥**，可以共存，因为它们的排序轴不同：

| 轴 | 归属 | 语义 | 谁压谁 |
|---|---|---|---|
| **lane**（`next_turn_boundary` / `when_run_idle`） | fork QP-4（r39） | steering 永远先排空；lane 内 FIFO | **lane 压过 priority**（第一轴） |
| **priority**（`pinned` / `user` / `background`） | 上游 #2334 | 同 lane 内 human 排在机器流量前面；同优先级 FIFO | 第二轴，**只在 lane 内生效** |
| **准入闸**（compaction / admission pause / coalesce） | fork `c9762ece6` + QP-2/QP-3 | 决定「能不能进队 / 现在能不能被选中」 | **闸压过两个排序轴**（进队前/出队时判，与顺序无关） |

⇒ 上游 #2334 的 `selectFirst()` 一字不改（它本来就是 lane 优先），只在 `enqueue()` 的**插入位置**上加 lane 内的
priority 排序。这正好是母席「人优先仅限 lane 内、机器互序不变」的字面实现，也正好让上游自己的第 3 个回归例
（human followUp 不越 steering 里的 agent message）与我方 QP-4 文档 pin 同向为真。

**唯一实质分歧**是「谁是 human」的判据：上游用 `isHumanInputSource(source) + agentmsg_ 前缀 + role==="user"` 三条启发式；
本 fork 已有一个更强的单一分类点 `classifyIncomingInput()`（`src/core/input-classification.ts`，fb0d6496a，
只读结构字段、永不读 text、兜底 human、`inputClassOrigin()` 编译期穷尽）。
**调和方案：优先级不再自带判据，而是从 fork 分类器的 origin 派生**（§4）。好处：
① 抗伪造性质（text 改不了类）自动继承到优先级上；② 上游第二笔修（`promptAndWait` 自铸 `prompt-wait:` id 不得降级）
在 fork 里已经是既有事实（`agent-messages.ts:18/535` 已有 `AGENT_MESSAGE_ID_PREFIX`/`isAgentSessionMessageId`，
`IncomingInputFacts.hasAgentMessageId` 的注释已写明该 id 只作佐证）；③ 兜底 human ⇒ 认不出的输入拿 `user`，
正常输入不会被误降（这是「不削弱」论证的核心，§6）。

---

## 2. 取证 A：上游 #2334 完整语义（逐点）

来源：`/tmp/_2334_upstream.diff`（10 文件 / 715 行，`git show dca77ecfe`）。

1. `SessionActionPriority = "pinned" | "user" | "background"`；`PRIORITY_RANK = {pinned:2, user:1, background:0}`；
   `SessionActionPlacement = "priority" | "tail" | "front"`。
2. `SessionAction.priority` 是**必填**字段（编译器把所有构造点全找出来，不留静默默认）。
3. `ActionStore.enqueue(action, placement = "priority")` 取代 `enqueue()` + `enqueueFront()`；
   `insertionIndex(list, action, placement)`：`tail`→末尾；`front`→第一个 `queued` 之前（＝原 enqueueFront 语义，
   不插到已出队动作前）；`priority`→**从尾向前扫，遇到「非 queued 或 rank ≥ 自己」就停**
   ⇒ 同优先级 FIFO、跨优先级 human 前插、且**绝不插到已经 selected/preparing/committing/running 的动作前面**。
4. `selectFirst()` **不改**：仍是 `nextTurnBoundary.find(queued) ?? whenRunIdle.find(queued)`。
5. 判据 `sessionActionPriorityFor(humanSource, message, agentMessageId)`：
   `!humanSource || isAgentSessionMessageId(agentMessageId)` → `background`；
   否则 `message === undefined || message.role === "user"` → `user`；其余 → `background`。
   `isHumanInputSource(s) = s === "interactive" || s === "rpc"`。
6. 接线：`_createPreparedTurnAction` / `_createSessionCommandAction` 在**动作创建处**推断（单一 choke point），
   `PromptOptions.priority` 可显式覆盖；`steer()`/`followUp()` 默认按 human 推断（上游写死 `humanSource=true`），
   机器调用方显式 `priority:"background"`；goal context 前插点写死 `priority:"pinned"`。
7. `_admitSessionInput(action, {restore, front, preserveOrder})` → placement：
   `front ? "front" : (restore || preserveOrder) ? "tail" : "priority"`；`_queuePreparedPrompt` 把 `preserveOrder` 透传下去。
   ⇒ **重启/恢复逐字重放存盘顺序，不因优先级重排**。
8. 恢复面：`SessionActionRecoveryAction.priority?`（**可选**，旧快照无字段也能读）；
   `getSessionActionRecoverySnapshot()` 带上 `priority`；`restoreSessionActions()` 缺失时按
   `sessionActionPriorityFor(isHumanInputSource(recovered.source), primaryMessage, recovered.agentMessageId)` 回填；
   `package-manager-cli.ts` 的 `isSessionActionRecoveryAction()` 加枚举校验（非法值 ⇒ 拒收快照）。
9. daemon：cron/heartbeat 两处显式 `priority:"background"`（`session.followUp(runnableJob.prompt,…)` 与
   `session.promptUntilAccepted(current.prompt,{source:"rpc",…})`），并改 `daemon-mode.test.ts` 的 `toHaveBeenCalledWith`。
10. 第二笔修：`agent-messages.ts` 加 `AGENT_MESSAGE_ID_PREFIX`/`isAgentSessionMessageId()`，
    防 `promptAndWait` 自铸 id 把 human 的 rpc prompt 降成 background。**本 fork 已有同名字同语义实现**。
11. 上游改动既有测试 3 处（`agent-session-queue.test.ts`）：两处给 followUp 显式 `priority:"background"` 保旧序，
    一处 `clearQueue()` 期望顺序翻成 human 在前（＝行为变更的显式承认）。
12. 上游新增 `test/suite/regressions/6158-human-message-priority.test.ts`（4 例）＋ store 级 4 例 ＋ `.changes` fragment。
13. 上游**没有**碰压缩/闸：#2334 只动「同 lane 内的排队顺序」，不动「谁能被选中」。

---

## 3. 取证 B：本 fork 的 queue / priority / classification pin 面

| pin | 载体 | 内容（＝不可回退面） |
|---|---|---|
| QP-4 lane 优先（单一真相注释） | `src/core/session-action-store.ts:227-239`（`selectFirst()` 上方） | steering 永远先排空；lane 内 FIFO；subagent 回执与 heartbeat 默认 steering ⇒ 故意越过更早的 followUp；准入拒绝在 `_admitSessionInput` 里先抛且可重试 |
| QP-4 文档 pin | `f826bd7f3`：README.md / docs/settings.md / docs/usage.md 各一段「Who overtakes whom」 | 同上语义的用户面表述（改行为必须同批改文档，否则文档漂移＝违规） |
| QP-1/2/3 | `test/r39-qp.test.ts`、`_admitSessionInput` 内 `SessionInputAdmissionPausedError`(QP-2) / `SessionInputCoalescingError`(QP-3) | 准入暂停租约、同 key committing 窗口拒绝且可重试 |
| front 插入不改回滚原位 | `test/session-action-store.test.ts:118-131`（`enqueueFront`） | goal context 前插后 `rollback()` 仍回到原位 |
| 结构策略优先 + 各策略内 FIFO | `test/session-action-store.test.ts:77`（describe "ActionStore selection"） | `selectFirst()` 顺序 |
| 用户显式重排 | `ActionStore.moveQueued/swapQueued`（Ctrl+Alt+Up/Down）、`test/agent-session-queue-mutation.test.ts`、`test/interactive-queue-edit.test.ts`、`test/queue-selection.test.ts` | 用户手动排序是显式意图，直接 splice，优先级不得把它改回去 |
| parked queue 存活重启 | `test/suite/agent-session-parked-queue.test.ts`、`test/interactive-resume-parked-queue.test.ts`、`_restorePromptInput`(8680) | 重放存盘顺序（`source:"internal"` + `preserveOrder:true` + `admissionPauseExempt:true`） |
| 输入分类单一真相 | `src/core/input-classification.ts`（349 行）：`INPUT_CLASSES`(8 类) / `inputClassOrigin()` 编译期穷尽 / `classifyIncomingInput()` 首匹配 / `incomingInputFactsFromMessage()` 只读 envelope | 只认结构字段、**永不读 text**；`hasAgentMessageId` 仅佐证；`streamingBehavior` 故意不当分类标记；兜底 `human_interactive` |
| 分类 pin | `test/input-classification.test.ts`（456 行，含 customType 覆盖 pin） | 未登记的 customType 落到 human 默认，不许静默 |
| 压缩优先准入闸 | `agent-session.ts:6986-7017`（`acceptAgentMessagePrompt` 内）＋ `_incomingAgentMessageCompactionGate()`(7123 起) | 压缩 outrank 进来的**agent 回执**：`compaction_pending` → 先起压缩再排队；`compaction_in_flight` → 武装看门狗再排队；**human / system_fence 直接 `return undefined`＝永不被闸**；streaming 期不闸；冷却期站开 |
| 压缩×输入矩阵 pin | `test/suite/compaction-input-priority-matrix.test.ts`（13 例） | human_interactive×pending 不排队且 pre-turn 压缩仍先于回合；scheduled/internal_continuation×pending 排队；两条**伪造**例（text 伪装）；Esc 立刻 abort 压缩；cooldown；两条 system_fence；flag off；watchdog 超时 abort 后投递 |
| 压缩期回执不打断压缩 | `test/suite/regressions/compaction-during-child-reply.test.ts`（5067ed78a + 48b5277b1） | 回执在压缩期间排队、压缩跑完、回执随后投递 |
| 压缩线可视化 | `test/interactive-mode-queue-compaction-line.test.ts`（2880924c5） | 队列 UI 的压缩线 |
| 阈值压缩准入 | `test/suite/agent-session-threshold-compaction-admission.test.ts` | 同上邻接 |
| `canSelectSessionAction(activity)` | `session-action-store.ts` | compaction/streaming/retry/bash/refinementApply/branchMutation/schedulerPause/disposing 任一为真 ⇒ 谁都不选（**出队闸，与顺序无关**） |

**fork 与上游的结构差异（决定接线方式）**：
- fork 的 `steer()`/`followUp()` 走 `_queuePreparedPrompt()`，**不传 source** ⇒ `_createPreparedTurnAction` 默认 `source:"internal"`；
  上游同名方法走 `_prompt()`，带 human source。⇒ 若照抄上游的 `isHumanInputSource(source)` 推断，
  **daemon/RPC/ACP/print 客户端的 live human steer/followUp 会被误判成 background**（feature 在主路径上失效）。
  所以 `steer()`/`followUp()` 的默认必须是显式 human（与上游写死 `humanSource=true` 同形），机器调用方显式降级。
- fork 的 parked-queue 重放把 `source` 硬写成 `"internal"`（原始 source 丢失），且恢复命令不带 priority
  （加字段＝改 daemon 协议面 rev38，代价高）。⇒ 恢复路径**不给 source 投票权**，改由 message envelope 判：
  无 envelope ＝ parked 的 human prompt ⇒ `user`；有 envelope ⇒ 交分类器（agent_message/heartbeat/digest ⇒ `background`）。
- fork 的 `preserveOrder` 已经存在但**未被使用**（因为 enqueue 就是尾插）；加了 priority 插入后它变成载荷字段，
  必须在 `_admitSessionInput` 里真正生效（placement `"tail"`），否则恢复重放会被重排。

---

## 4. 调和后的判据（实现口径）

```ts
// src/core/agent-session.ts（模块级，紧挨 primaryDeliveryRecord）
/**
 * Queue priority is derived from the fork's single classification point instead of
 * carrying its own heuristic: `classifyIncomingInput` reads structure only (never
 * text), so a message cannot forge its way to the front of the queue, and its
 * human default means an unrecognized input keeps human priority instead of being
 * silently demoted. Agent-to-agent ids demote unconditionally: they are structural,
 * and `promptAndWait` mints `prompt-wait:<uuid>` ids that are not agent traffic.
 */
function sessionActionPriorityFor(facts: {
  source?: InputSource | "internal";
  message?: QueuedAgentMessage;
  agentMessageId?: string;
}): SessionActionPriority {
  if (isAgentSessionMessageId(facts.agentMessageId)) return "background";
  const cls = classifyIncomingInput(
    incomingInputFactsFromMessage(facts.message ?? { role: "user" }, {
      ...(facts.source === undefined ? {} : { source: facts.source }),
      ...(facts.agentMessageId === undefined ? {} : { agentMessageId: facts.agentMessageId }),
    }),
  );
  return inputClassOrigin(cls) === "human" ? "user" : "background";
}
```

映射表（＝钉要覆盖的面）：

| 输入 | 事实 | 分类 | origin | priority |
|---|---|---|---|---|
| 交互/rpc human prompt | source=interactive/rpc，无 envelope | `human_interactive` | human | **user** |
| `promptAndWait` 的 human rpc prompt | 自铸 `prompt-wait:` id（非 `agentmsg_`） | `human_interactive` | human | **user**（＝上游第二笔修，fork 免费得到） |
| parked 队列里恢复的 human prompt | 无 envelope，source 不给投票权 | `human_interactive` | human | **user** |
| human 的 session slash command | `SESSION_SLASH_COMMAND_CUSTOM_TYPE` | human 类 | human | **user** |
| 从 stash/queue 放行的 human 输入 | `isQueuedHumanInput` | `human_queued` | human | **user** |
| 子代理回执 | `customType=agent_message`（+`details.fromRelationship`） | agent 类 | agent | **background** |
| heartbeat / cron prompt | heartbeat/cron customType 或显式 `priority:"background"` | `scheduled` | machine | **background** |
| harness digest / rlm terminal notice / 内部续跑 / bash 补全 | 对应 customType 或 source=internal | machine 类 / `internal_continuation` | machine | **background** |
| 重启围栏 | `isSystemFence` | `system_fence` | machine | **background**（但**永不被压缩闸**，见 §7） |
| goal context 前插 | 写死 | — | — | **pinned** |

裁决顺序（**冲突时从上往下**，高者胜）：

1. **出队闸** `canSelectSessionAction()`：压缩/流式/重试/bash/refine/branch/pause/disposing 在飞 ⇒ 谁都不选（priority 不参与）。
2. **准入闸** `_admitSessionInput()`：QP-2 暂停租约、QP-3 committing 窗口、update-restart 围栏 ⇒ 先抛可重试错误，**根本没进队**（priority 不参与）。
3. **压缩优先闸** `_incomingAgentMessageCompactionGate()`：只对 agent/machine 类生效（human/system_fence `return undefined`）⇒ 决定「回执要不要排在压缩后面」。
4. **lane**（QP-4）：`selectFirst()` 先排空 steering，再 followUp。
5. **priority**（#2334）：同 lane 内 `pinned > user > background`，同级 FIFO。
6. **用户显式重排**：`moveQueued`/`swapQueued` 直接改位置，之后的 priority 插入**不会**把它改回去
   （插入只影响新入队者；已排好的相对序不动）。
7. **恢复重放**：placement `"tail"` ⇒ 存盘顺序逐字重放，priority 只作为字段随快照走，不参与重排。

---

## 5. 代码位点（实现清单）

> 行号读自 **v2 交卷树**（`/tmp/p2334`，`git rev-parse HEAD` 见 `2334-human-priority-APPLY.md` §1；本节数字派生自 `grep -n`，非手抄）。
> base 已从 `de1ad0b06` 移到 `d51118e32`，v1 表里的行号整体偏 -37~-45，**一律以符号名为准**。

| 文件 | 位点（符号名为准，行号仅定位） | 改动 |
|---|---|---|
| `src/core/session-action-store.ts` | 16-19（`SessionActionPriority`/`SessionActionPlacement`/`PRIORITY_RANK`）、82（`SessionAction.priority`）、225（`enqueue`）、245（`selectFirst` 上方 QP-4 注释）、355（`insertionIndex`） | 加优先级轴；`priority` 必填；`enqueue(action, placement="priority")` 吃掉 `enqueueFront`；`insertionIndex()`；QP-4 注释补「lane 压过 priority」与完整裁决序 |
| `src/core/agent-session.ts` | 873（`PromptOptions.priority?`） | 显式覆盖派生值的入口 |
| 同上 | 1032（`SessionActionRecoveryAction.priority?`） | 可选＝旧快照可读 |
| 同上 | 1108 / 1112（`sessionActionPriorityForInputClass` / `sessionActionPriorityFor`） | 判据从分类器 origin 派生 ＋ `agentmsg_` id 结构守卫（导出，见 APPLY §3 #1 / G5） |
| 同上 | 3827-3838（`_runOrQueueGoalContext`，3836 是 `priority:"pinned"`） | goal context 前插＝全仓**唯一** `pinned` 生产点（v2 起有 session 级钉，M7 可红） |
| 同上 | 7277（`_incomingAgentMessageCompactionGate` 的 human/system_fence 站开行） | **一字未改**，v2 只在其上方加 16 行据实注释（不可达＋纵深防御＋将来可达须同批补钉） |
| 同上 | 8308（`_promptInjectedMessage`） | 未改（观察项 F9，见 §9.6） |
| 同上 | 8661 / 8702（`steer()` / `followUp()`） | 加 `priority?`，默认走合成 `source:"interactive"` 的单一推断路径（G6） |
| 同上 | 8735（`restoreSessionActions`） | `recovered.priority ?? 推断`（快照里存的是真 source，这里 source 有投票权） |
| 同上 | 8844 / 8866（`_restoreSessionCommand` / `_restorePromptInput`） | 前者 → `"user"`；后者 → envelope 判（无 envelope = parked 的 human ⇒ `user`） |
| 同上 | 9054 / 9123（`_createPreparedTurnAction` / `_createSessionCommandAction`） | `priority: options.priority ?? sessionActionPriorityFor({source, message, agentMessageId})` |
| 同上 | 9202（`_admitSessionInput`）、9289（placement 三态） | `front ? "front" : (restore‖preserveOrder) ? "tail" : "priority"` |
| 同上 | 9321（`_queuePreparedPrompt`） | 加 `priority?` 并透传 |
| 同上 | 10396（`getSessionActionRecoverySnapshot`） | 快照带 `priority` |
| `src/modes/daemon/daemon-mode.ts` | 2152（`followUp`，排队中的 generic cron）/ 2192（`promptUntilAccepted`，idle generic cron） | 两处显式 `priority:"background"`；**两处都在 v2 有钉**（F1a 3 红 / F1b 1 红） |
| `src/package-manager-cli.ts` | 801（`isSessionActionRecoveryAction()`） | 加 `priority` 枚举校验（用现成 `isStringEnum`；允许缺、拒非法） |

**实测不需要改**：`src/modes/agent-connection/in-process-agent-connection.ts`（`promptAndWait`/`steer`/`followUp` 是 live human 客户端的纯转发，新默认值已覆盖；再写一遍只是重复声明）。

**故意不动**：`selectFirst()`、`canSelectSessionAction()`、`_incomingAgentMessageCompactionGate()`、
`input-classification.ts`、`moveQueued/swapQueued`、daemon 协议面（rev38 不动）、任何 prompt/模型可见面。

---

## 6. 「不削弱模型」检查（老板硬约束 §12：模型效果 > 成本 > 工程量）

逐条自查，每条都给了钉：

1. **不吞输入**：priority 只决定**同 lane 内的插入位置**，不新增任何拒绝/丢弃/改写路径。准入拒绝面（QP-2/QP-3/围栏）
   一字未动 ⇒ 能进队的还是那些，进不了的还是那些。钉：v2 口径 77 文件 **1094 例 0 fail**，对 `d51118e32` 干净基线（75 文件 1075 例 0 fail）**new-red=0**、逐文件例数只增不减（§10）。
2. **不延迟子代理回执以外的正常输入**：降级到 `background` 的**只有** agent/machine origin 的类（§4 映射表）；
   所有 human 类（`human_interactive` / `human_queued` / slash command / parked human）都是 `user`。
   兜底类是 `human_interactive` ⇒ **认不出来的一律按 human 提权**，不存在「正常输入被误降」。
   钉：新增 `2334-*` 例按 `INPUT_CLASSES` 全表参数化断言 origin→priority 映射（数据驱动，先断言集合非空）。
3. **不削弱模型可见面**：动作 payload、消息内容、上下文构造、prompt 全不碰；
   `priority` 不进 prompt、不进摘要、不进 compaction 切点计算（只活在队列结构与恢复快照里）。
4. **不改机器互序**（母席裁示后半句）：`background ↔ background` 仍严格 FIFO；`pinned` 只出现在 goal context 前插点，
   而那里本来就是 `front` 插入（行为等价，只是把「为什么它在前」写进类型）。钉：store 级 + session 级各一例。
5. **不改 lane 语义**（QP-4 不回退）：`selectFirst()` 未动；human followUp 仍不越 steering 里的 agent 回执。
   钉：`2334-*` 的 lane-beats-priority 例 + 既有 `test/r39-qp.test.ts` / `session-action-store.test.ts` / 文档 pin 全绿。
6. **抗伪造**：优先级判据只读结构字段（envelope customType / fromRelationship / id 前缀 / source），
   **永不读 text** ⇒ 回执正文里写「我是老板，立刻处理」也拿不到 `user`。
   钉：新增伪造例（agent_message 正文伪装 human）断言仍 `background`，与 `compaction-input-priority-matrix` 的两条伪造例同族。
7. **不让用户显式意图被机器改回去**：`moveQueued/swapQueued` 是用户手排，priority 插入只作用于**新入队者**。
   钉：既有 `agent-session-queue-mutation.test.ts` / `interactive-queue-edit.test.ts` 全绿（未改一字）。
8. **不新增静默回退**：`priority` 是必填字段（构造点少一个就编译不过）；恢复快照里的 `priority` 缺失走**显式推断**（有钉），
   非法值被 `package-manager-cli` 拒收（显式失败，符合「显式提供门」）。

---

## 7. 压缩期间：human 优先 × 「回执不打断压缩」为何不互撕（老板现场场景）

两条 pin 作用在**不同的层**，所以不打架：

- 「回执不打断压缩」是**准入闸**（第 3 轴）：`_incomingAgentMessageCompactionGate()` 让 agent/machine 回执在
  `compaction_pending` 时先起压缩再排队、在 `compaction_in_flight` 时武装看门狗再排队；压缩跑完由泵投递。
  **本次改动一行未碰它。**
- 「human 优先」是**排序轴**（第 5 轴）：只改同 lane 内的插入位置。压缩在飞时 `canSelectSessionAction()` 返回 false
  ⇒ **谁都不出队**，human 也一样等（这是 base 既有行为，也是 `compaction-input-priority-matrix` 的
  「human_interactive×pending：不排队，且 pre-turn 压缩仍先于该回合」pin）。
- 合成后的现场语义：压缩在飞 → ① 子代理回执被闸住、排队、**压缩不被 abort**（跑完）；
  ② 老板这时打字 → human prompt **不被压缩闸**：真因是闸**只有一个调用点**（`acceptAgentMessagePrompt`，即 agent 通道），
  human 走 `prompt()` 根本到不了那行；闸内那条 `inputClassOrigin==="human"` 站开半支是**纵深防御**，当前调用图不可达
  （v2 已在该行上方加据实注释，见 §9.4）。按现状走 `_prompt`：能立刻开回合就开（idle 时），正在压缩就入队等；
  ③ 入队后 human 排在同 lane 已排队回执**前面**；④ 压缩 settles → 泵按 lane+priority 出队 ⇒ **human 先跑，回执随后**。
  ⇒ 「human 优先」在这里表现为**压缩结束后谁先被投递**，而不是「打断压缩」。两条同时成立。
- 唯一能让它们互撕的实现是「human 优先＝human 插队/抢占压缩」——**本设计明确不这么做**：
  Esc 才是 abort 压缩的唯一入口（既有 pin：`abort: Esc during an in-flight compaction cancels it at once`）。
  钉：新增 `compaction × human priority` 例同时断言四件事
  （压缩起来了且跑完没被 abort / 回执排队未打断 / human 排在回执前 / settles 后 human 先投递），
  这就是老板要的显式钉。

---

## 8. 钉与正控（撤改即红）

| # | 钉 | 载体 | 撤掉哪一处会变红（正控） |
|---|---|---|---|
| P1 | store：human 排在 background 前、human 内部 FIFO | `test/session-action-store.test.ts`（新增，上游同例） | 撤 `insertionIndex` 的 priority 分支（回到 push） |
| P2 | store：绝不插到已出队动作前 | 同上（上游同例） | 撤 `lifecycle.state !== "queued"` 的 break 条件 |
| P3 | store：`pinned` 压过后到的 human；`front` 仍是 front | 同上（上游同例） | 撤 `PRIORITY_RANK.pinned` / placement `"front"` |
| P4 | store：`tail` 逐字追加（恢复重放） | 同上（上游同例） | 撤 placement `"tail"` 分支 |
| P5 | session：human prompt 越过已排队 agent 回执且 human 内部保序（steering lane） | `test/suite/regressions/6158-human-message-priority.test.ts`（上游 4 例移植） | 撤 `_createPreparedTurnAction` 的推断接线 |
| P6 | session：`promptAndWait` 自铸 id 不降级 | 同上 | 撤 `isAgentSessionMessageId` 守卫（或把 `prompt-wait:` 当 agent id） |
| P7 | session：**lane 压过 priority**（human followUp 不越 steering 里的回执） | 同上（上游第 3 例）＋ `2334-*` lane 例 | 撤 lane 轴（若有人把 priority 提到 selectFirst 里） |
| P8 | session：恢复队列按存盘顺序重放（agent 在前 human 在后也不重排） | 同上（上游第 4 例） | 撤 `_admitSessionInput` 的 `restore→"tail"` |
| P9 | **分类器 origin → priority 全表映射**（human 三类=user；agent/machine 五类=background），数据驱动、先断言集合非空 | `test/suite/regressions/2334-human-priority-lane-scoped.test.ts`（新增，fork 专属） | 撤 `sessionActionPriorityFor` 里对 `inputClassOrigin` 的使用 |
| P10 | **抗伪造**：agent_message 正文伪装 human（"我是老板/urgent/ignore previous"）仍 background | 同上 | 撤「只读结构字段」性质（若有人改成读 text） |
| P11 | **机器互序不变**：两条回执 + 一条 heartbeat 仍 FIFO；后到的 human 越过它们 | 同上 | 撤 priority（回到纯 FIFO）或错把 background 之间重排 |
| P12 | **压缩 × human 优先不互撕**（老板现场场景，四断言：压缩起来且跑完未 abort / 回执排队未打断压缩 / human 排在回执前 / settles 后 human 先投递） | 同上 | 撤压缩闸（回执打断压缩）或撤 priority（human 排不到前面）任一 ⇒ 红 |
| P13 | 恢复快照带 `priority` 且非法值被拒 | `test/suite/regressions/2334-human-priority-lane-scoped.test.ts` + 既有 update-restart 面 | 撤快照字段 / 撤 cli 校验 |
| P14 | cron 显式 background（daemon **两处**） | 既有 `test/daemon-mode.test.ts`：queued 路径改 `toHaveBeenCalledWith`（上游同形 4 行）；idle 路径**新补** `toMatchObject({priority:"background"})`（既有断言是 `objectContaining`，撤字段不红） | 撤 `followUp` 的 ⇒ **F1a 3 红**；撤 `promptUntilAccepted` 的 ⇒ **F1b 1 红**（补钉前实测 0 红） |
| P15 | 文档 pin 不漂移 | README.md / docs/settings.md / docs/usage.md「Who overtakes whom」补 human 优先句 + `.changes` fragment；v2 再补 extension 半句与「唯一越到手排前面的是 goal context 前插」 | —（无测试断言这三段措辞，已 grep 确认） |
| **P16** | **手排跨 rank 不被回溯重排**（v2 新增，F3） | `test/session-action-store.test.ts`：`never re-sorts a queue the user reordered by hand`（改跨 rank，`moveQueued` 腿）＋新增 `never lets a rank re-sort undo a hand swap across ranks`（`swapQueued` 腿，含 QP-4 跨 lane 半句）；`2334-*.test.ts` session 级同名词（走 `mutateQueuedMessage`→`swapQueued` 真实入口 + 快照复放） | `swapQueued` 末尾加整 lane 按 `PRIORITY_RANK` 重排 ⇒ **M6 2 红**；同样打在 `moveQueued` 上 ⇒ **M6b 1 红**。**v1 的三条手排同为 `user` + V8 稳定排序 ⇒ 对 M6 免疫（0 红）**，这就是 F3 的缺口 |
| **P17** | **goal context 的 `pinned` 在生产路径上握住队首**（v2 新增，F4） | `test/suite/agent-session-goal.test.ts` `keeps a queued goal context ahead of a human follow-up that arrives after it`：两段式 wait 闸让 `/goal` 在边界执行、human steer 占住下一 turn ⇒ 走到 `_runOrQueueGoalContext` 的 **queued 分支**；观测面＝`getSessionActionRecoverySnapshot()`（goal context 非 queue-visible，`getFollowUpMessages()` 看不见它） | 撤 `priority:"pinned"`（保留 `front:true`）⇒ **M7 1 红**。v1 只有 store 级手造 pinned（不经生产路径）⇒ M7 在 54 例上 0 红 |

### 正控实跑结果（v2；G7：变异实测，不接受眼看）

脚本 `/tmp/p2334-out/v2-controls.py`（单点精确串替换，命中数必须 ==1）；逐次原始报告 `/tmp/p2334-out/v2/<id>.json`；
**每条变异的 diff** `/tmp/p2334-out/v2/<id>.diff`；汇总 `summary.json`；日志 `v2-controls-all.log`。
跑在 `/tmp/p2334-mut`（HEAD=`171281de7`），每条变异后 `git checkout --` 复位并核 `git status --porcelain` 为空。

| 正控 | 单点撤改 | 钉文件（例数） | 结果 |
|---|---|---|---|
| GREEN | 无 | store+2334+6158+queue+daemon-mode（366） | **366/366 全绿** |
| **F1a** | daemon `followUp` 撤 `priority:"background"` | daemon-mode（198） | **3 红**（P14） |
| **F1b** | daemon `promptUntilAccepted` 撤 `priority:"background"` | daemon-mode（198） | **1 红**（补钉前 **0 红**） |
| **M6** | `swapQueued` 末尾加整 lane rank 重排 | store+2334+queue-mutation+queue（173） | **2 红**（P16；v1＝0 红） |
| **M6b** | `moveQueued` 末尾加整 lane rank 重排 | 同上（173） | **1 红**（P16） |
| **M7** | goal 前插撤 `priority:"pinned"` | 2334+goal+store+6158（107） | **1 红**（P17；v1＝0 红） |
| **M1** | `insertionIndex` priority 分支 → `return list.length` | store+2334+6158+queue（168） | **11 红**（P1/P2/P3/P16、clearQueue、P13、**P12 老板现场例**、P5、P6） |
| **M3** | `sessionActionPriorityForInputClass` 恒 `"user"` | 同上（168） | **3 红**（P9 全表／各形态／P10 抗伪造） |
| **M2** | 撤 `isAgentSessionMessageId` 守卫 | 2334+queue+6158（124） | **2 红**（P6、clearQueue） |
| **M5** | 撤 `restore‖preserveOrder → "tail"` | 6158+2334+queue（124） | **1 红**（P8） |
| **C7** | 模拟「human 也被压缩闸挡住」 | 2334+matrix（27） | **1 红**（P12 ⇒ 闸的可观测半支有真钉） |
| **M4** | 撤压缩闸 human/system_fence 站开半支 | 2334+matrix（27） | **0 红**＝该半支**在当前调用图不可达**（复核席 4 例探针四环证据 + 本席 v2 复跑一致）⇒ 母席裁 (b)：不写假钉，改**据实注释**，见 §9.4 |

区分「固化保证」与「样本未触发」：F1a/F1b/M6/M6b/M7/M1/M2/M3/M5/C7 都是**实跑检出**；M4 是**实跑未检出且已给出不可达证据链**。
**v1 的历史读数**（C1 8 红 / C2 3 红 / C3 2 红 / C4 1 红 / C5 0 红 / C6 1 红 / C7 1 红，跑在 4 个 pin 文件 167 例上，
脚本 `/tmp/2334-controls{,2,3}.py`）仍成立，但文件集口径与上表不同，逐条对照见 `2334-human-priority-APPLY.md` §5。
**已撤回的声称**：v1 的 `2334-*.test.ts` 头注与本文 §8 曾写「every ordering assertion names the line whose removal turns
it red」——变异实测对 P16（M6）、P17（M7）与闸的 human 站开半支（M4）**三处证伪**。v2 已把头注改成逐组点名变异编号的
实测口径，并明写「闸的 human 站开半支本文件不声称有钉」。

---

## 9. 观察项（不在本席修，报母席）

1. **hung 压缩 + human 排队没有 stall 上界**（base 既有洞，与 #2334 无关）：
   `_armCompactionGateWatchdog()` 只在 **agent 回执**命中压缩闸时武装；human prompt 排在 hung 压缩后面时
   没有任何东西给它兜底（stall 看门狗在压缩期间是 snooze 的）。一行修法建议：
   `_admitSessionInput` 里若 `action.priority === "user" && this.isCompacting` 也武装同一个看门狗。
   本席**不做**，因为会碰 `compaction-input-priority-matrix` 的 watchdog 例与
   `interactive-mode-queue-compaction-line` 的既有 pin，属独立高风险改动，应单独一席一钉。
2. `docs/fork/merge-upstream-20260917.md` §9.2 行 318 / §10③ 行 344 / §11 QP-4 行需要翻状态（待办→已落地），
   但该文件在主仓工作树里是**别车道在跑的脏文件**，本席不碰（克隆里也没改），交母席在合并窗口内改。
4. **压缩闸的「human 站开」半支当前不可达（C5 实测 0 红的真因）**：`_incomingAgentMessageCompactionGate`（`agent-session.ts:7231`）全仓只有一个调用点（`7124`，在 `acceptAgentMessagePrompt` 内）；该方法开头把不合 `isAgentSessionMessage()` 的 envelope 丢成 `undefined`（`agent-messages.ts:796`：必须 `role==="custom" && customType==="agent_message" && details.id/message` 是字符串），闸在无 envelope 时又默认成 agent 通道（`7245`「This entry point IS the agent channel」）⇒ 走到 `7253` 时 class 恒为 agent 类。`system_fence` 半支同理（`isSystemFence` 是 context flag，该调用点从不设）。仪器本身有正控：同一 pin 里 agent 回执那半**确实观测到闸开火**（`reason === "compaction_pending"`）。建议（超本席范围）：要么在该行注明「defensive：当前调用图不可达」，要么当死代码删；两者都动 fork 既有 pin 面（`compaction-during-child-reply.test.ts` 头注写明「It stands down for human input」），应独立一席一钉。
   **v2 处置（母席裁 (b)）**：复核席用 4 例可达性探针逐环实测确认不可达（唯一 human 类 customType 的真 envelope 过不了 `isAgentSessionMessage()`；闸自己的兜底对 interactive/rpc/extension/internal/undefined 五种 source 全落 `origin==="agent"`；能过 `isAgentSessionMessage()` 的 envelope 配 human source + `agentmsg_` id 仍判 agent；`incomingInputFactsFromMessage()` 无 `isSystemFence` 入口），本席在 v2 树上复跑 M4＝27 例 0 红一致 ⇒ **不写假钉**，改为在该行上方加 16 行据实注释（照 `d51118e32` 给 cancel 侧 digest re-arm 的写法），**不删该半支**（删它要独立一席一钉），并保留 v1 的 C6/C7 模拟钉守可观测半支（v2 复跑 C7＝1 红）。本条与下面第 1 条并册记为**设计债**，母席另立车道；加固方向＝把这条裁决挪到 `_admitSessionInput`（所有输入的必经点），届时本半支同时变可达且必须同批补钉。
5. 恢复命令（daemon `steer`/`follow_up` with `expandPromptTemplates:false`）不带 priority 字段，
   本席用 envelope 推断绕过；若将来 parked 队列里出现「无 envelope 的机器 prompt」，会被当成 human 提权
   （方向是「不误降正常输入」，可接受，但记一笔）。真要闭合需动 daemon 协议面（rev38→rev39），代价另评。
6. **`_promptInjectedMessage` 不接受也不透传 `priority`（复核席 F9，v2 未做，挂账）**：其调用点全是机器注入
   （cron/heartbeat 等），envelope 推断＝`background`，**当前语义正确**；风险是将来若有人类输入走这条路径，`priority`
   会被**静默丢弃**（options 里没这个键 ⇒ 无编译错）。修法二选一：给它加 `priority?: SessionActionPriority` 并透传，
   或在函数注释写死「本路径只承载机器注入消息，人类输入不得走这里」的不变量。不属 v2 判据 ⇒ 不夹带。
7. **G6 的一次性后果（母席挂账）**：`steer()/followUp()` 走单一推断路径（合成 `source:"interactive"`），但动作**记录的**
   source 仍是 `"internal"` ⇒ 升级那**一次**重启窗口内，旧快照无 `priority` 字段的已排队 human steer/followUp 会按
   `internal` 重推成 `background`。不改实现（单一推断路径比两处各写死一个常量更不易漂），登记为已知一次性影响。

---

## 10. 闸（v2 口径）

- **口径写死**：「关键词邻接集 **73 文件** ∪ 补丁波及的**所有** test 文件」。v1 的 75 文件口径漏了 `test/daemon-mode.test.ts`
  （被 src 改动打到却不在任何关键词邻接集内）⇒ 漏掉那 3 红；v2 再纳入 `test/suite/agent-session-goal.test.ts`（F4 新钉所在，
  同样不在邻接集内）⇒ **77 文件**，清单 `/tmp/_2334_v2_runset.txt`。
- 干净基线（`d51118e32`，worktree `/tmp/p2334-base2`）：74 文件 **1024 例 = 1014 pass + 10 pending + 0 fail**
  （`/tmp/v2-baseline-d51118e32.json`）＋ `agent-session-goal.test.ts` **51/51**（`/tmp/v2-baseline-goal.json`）⇒ 合计 1075 例 0 fail。
  （v1 在旧 base `de1ad0b06` 上的 826 例读数只作历史：`/tmp/2334-baseline-de1ad0b06.json`。）
- v2 交卷树：77 文件 **227 suites / 1094 例 = 1084 pass + 10 pending + 0 fail，EXIT=0，new-red=0**
  （`/tmp/v2-final-gate.json`，逐文件 `v2-final-gate-perfile.json`）。逐文件对账：无文件丢失、无 0 断言文件、无一文件例数减少；
  增量 store 37→44、goal 51→52、新增 2334=7 / 6158=4；口径闭合 1024+7+52+7+4=1094。
- **daemon-mode 单独读数（母席点名）**：交卷树 **198/198，0 fail**；rebase 后未修 F1 时是 195 pass + 3 fail（`/tmp/v2-after-rebase.json`）。
- `npx tsgo --noEmit`：0，且**自带正控**（往改过的钉文件塞一行错类型 ⇒ TS2322 / EXIT=2，删掉 ⇒ EXIT=0）⇒ 这个 0 不是"没扫到 test"的假绿。
- `npx biome check --error-on-warnings .`：0（1494 files）。
- `npm run check:test-hygiene`（root）：OK，936 文件、497 处存量私有探测（474 baseline + 23 allow）、**新增 0** ⇒ 新钉全走公开面。
- 变异正控 12 条见 §8；不 push、不碰主仓工作树、不动 daemon 协议 rev、不动 prompt/模型可见面。
