# 子代理真实终态 → agents 视图 Running/Idle 段位：状态管道刨查、断点定位与修复方案

- 仓库：`/Users/a1/Desktop/ai/prime-agent`（分支 `merge/repl-kernel`）
- 取证时 HEAD：`402d58516f38b68be37e039d68cc0751b173914d`（`git log -1 --format='%H %cd'` → `Sat Sep 19 13:20:42 2026 +0800`）
- 本文所有 `文件:行` 均相对该 HEAD；所有现场读数均带采集时刻（本机 CST = UTC+8）。
- 本文只写 `docs/`，未改任何 `src/`、`test/`。

---

## 0. 摘要

**一句话根因**：`agents` 视图的 Running/Idle 段位**从不读子代理的终态**。它只读 roster 的 `status`，而 roster 的 busy 判据把"这个会话的 kernel 还托管着活的后台 `bash()` 句柄"当成了"这个 agent 正在干活"。病例子代理交差时留下了一个后台 rig host 进程，该进程到取证时（**7h32m 后**）仍然活着，于是那一行永远停在 Running、图标永远闪。

**这不是疏漏，是被测试锁住的设计**：`test/suite/live-kernel-work-residency.test.ts` 里有一条名为 D35 的用例，注释原文写着 *"Intended consequence, pinned so nobody 'fixes' it back"*，并显式断言 `classifySessionRosterStatus(summary)` 为 `"running"`、`summary.activity` 为 `"idle"`。因此**任何修复都是一次有意识的策略反转，必须先拿到裁定**（见 §10）。

**需要裁定的三件事**（详见 §10）：
1. Running 段位的语义到底是"agent 正在干活"还是"会话还托管着活的工作"？（本文推荐前者）
2. 反转 D35 锁测是否获准（该锁是 r44 修复的一部分，反转时必须保住 r44 的两个载体）。
3. 一个已完成的子代理，行标签应该显示什么（`completed` / `replied` / 新增 `hosting background work`）——这是产品口味，不是工程判断。

**上游 26 笔（`e2fb7bfa1..upstream/main`）没有一笔修这条管道**：三个决策文件 `agent-roster.ts` / `rlm-subagent-display.ts` / `agents-view-state.ts` 的 `git log` 全为空（母席亲核，见 §9）。唯一碰到 roster 组合的是 `e311d6495`（perf: skip roster re-composition for unchanged sessions #2393），它是性能优化，不是修复，且合并时需要单独端到端复核。

---

## 1. 病例与取证

### 1.1 病例身份

| 项 | 值 | 出处 |
|---|---|---|
| 子代理名 | `linkrefund-post2-ds` | `rlm-subagent.json:sessionName` |
| childId | `sub-7c40ed68` | 同上 |
| 父会话 | `01a0b80c-3b02-726e-99ff-dc89f8401eed` | ledger spawn record |
| 子会话文件 | `.../sub-7c40ed68/01a0bb63-f78c-74fe-9215-33d981b1028a.jsonl` | 同上 |
| 子会话 sessionId | `01a0bb63-f78c-74fe-9215-33d981b1028a` | daemon 日志（§1.2c） |
| display 文件终态 | `status: "completed"`，`updatedAt: "2026-09-19T20:52:41.708Z"` | `rlm-subagent.json` |
| 取证时刻 | `Sun Sep 20 12:04:20 CST 2026`（= `2026-09-20T04:04:20Z`） | `date` |
| 终态到取证的间隔 | **7h11m** | 上两行相减 |

### 1.2 现场证据（活体采集，均可复跑）

**(a) 子代理的 kernel 和它留下的后台进程都还活着。** 派单前提里的"内核早死"**不成立**（校正见 §1.4）。

```
$ ps -o pid,ppid,pgid,etime,stat,command -p 47462 -p 49275
  PID  PPID  PGID  ELAPSED STAT COMMAND
47462 90262 90262 07:30:19 S    /Users/a1/.prime/agent/kernel-venv-79d2020dfc30/bin/python -P -m rlm.repl
49275 47462 49275 07:26:49 Ss   /bin/bash -c ... node /tmp/linkrefund_post2_20260920T043816/host.mjs ...
```

- `49275`（bash 包装）→ `49277`（node `host.mjs`，112 MB RSS）= 病例子代理自己起的 rig host，`etime 07:26`。
- `47462` = 该子代理的 Python kernel（`rlm.repl`），父进程 `90262` = `prime-agent` worker（`etime 23:05`）。
- 归属证明：`49275` 的命令行里带 `/tmp/linkrefund_post2_20260920T043816`，与 `rlm-subagent.json` 的 prompt 里写死的 `qa_fp=linkrefund_post2` 一致；该目录 `heartbeat.log` 最后一行 `[04:52:33] HARNESS: 全局状态文件核对`，与 display 文件 `updatedAt 20:52:41Z` 吻合。
- 该 rig 目录里 `keepalive_private` 的 mtime 是 `Sep 20 12:08`（取证时 4 分钟内），说明进程**此刻仍在活动**，不是僵尸。

**(b) 孤儿进程日志把这个句柄记成 `active`。**

```
$ grep -n '49275' /Users/a1/.prime/agent/daemon-workers/12f042ee5718/1b9156778783.orphans.jsonl
3785:{"version": 1, "pid": 49275, "ownerPid": 90262, "kernelPid": 47462,
      "processStartId": "ps:Sat Sep 19 20:41:46 2026", "active": true,
      "recordedAt": "2026-09-19T20:41:46.486350+00:00"}
```

`ownerPid 90262` = worker，`kernelPid 47462` = 病例子代理的 kernel。这条 `active: true` 记录没有对应的 `active: false` 退休行。

**(c) daemon 自己写下了"是这个 kernel 句柄把会话钉住"的归因行。**

```
$ grep 'kernel bash handles now hold' /Users/a1/.prime/agent/logs/agent.jsonl | tail -2
{"kernelPid":47462,"liveBashHandles":1,"oldestHandleAgeMs":616683,"journalProbedPids":1,
 "probeCapped":false,"sessionId":"01a0bb63-f78c-74fe-9215-33d981b1028a",
 "ts":"2026-09-19T20:52:03.170Z","level":"info","component":"coding-agent.kernel",
 "msg":"kernel bash handles now hold this session resident","pid":90262,"mode":"daemon"}
```

`sessionId` 正是病例子代理。该行由 `repl-manager.ts:860-861` 打出。**全日志无对应的 `kernel bash residency released` 行**（`repl-manager.ts:862-863`），即这个 pin 从未释放。

> 注：`DEFAULT_KERNEL_BASH_RESIDENCY_WARN_AGE_MS = 24h`（`turn-liveness.ts:396`），所以 7h 的 pin 还不会触发那条"驻留超过一天"的 warn——**日志侧对 24h 以内的 stale pin 是静默的**。

**(d) spawn ledger 里没有"完成"这个状态。**

```
$ grep -n 'sub-7c40ed68' /Users/a1/.prime/agent/rlm-ledger/2908f90643ebb724.jsonl
5108:{"v":1,"op":"spawn","at":"2026-09-19T20:38:06.036Z","childId":"sub-7c40ed68",
      "parent":"/Users/a1/.prime/agent/sessions/01a0b80c-....jsonl",
      "child":".../sub-7c40ed68/01a0bb63-....jsonl","depth":1,"name":"linkrefund-post2-ds"}
```

只有 `spawn`，没有 `delete`。ledger 的 record 词表本来就只有 `spawn|rename|delete`（`rlm-ledger-compaction.ts:45-74`），edge 上唯一的状态位是 `deleted?`（同文件 `:77-84`）——**"完成"在 ledger 层不可表达**。

### 1.3 机械复现（用本仓源码跑通，非推测）

复现脚本留尸：`/tmp/stalerun_20260920T041408Z/repro.ts`。跑法（在 `packages/coding-agent` 下，用仓库自己的 tsx）：

```
$ cd /Users/a1/Desktop/ai/prime-agent/packages/coding-agent && npx tsx /tmp/stalerun_20260920T041408Z/repro.ts
JOURNAL active total: 72
JOURNAL active for case kernel 47462 : [{"pid":49275,"kernelPid":47462,"processStartId":"ps:Sat Sep 19 20:41:46 2026","recordedAt":"2026-09-19T20:41:46.486350+00:00"}]
CASE_BASH_PID present: true
classifySessionRosterStatus(isSessionActive=true): running
classifySessionRosterStatus(isSessionActive=false): idle
AgentRoster entry.status: running
sessionSummaryFromRosterEntry rosterStatus: running
classifyAgentsViewSession(view section): running
classifyUnifiedSession(record.section): running
CONTROL no-kernel-work entry.status: idle section: idle
```

脚本做了三件事：
1. 用**项目自己的** `readActiveOrphanProcesses(JOURNAL, 90262)` 读真日志，确认 kernel `47462` 名下有 1 个活句柄 `49275`（正控：这个读法确实能检出活句柄，不是恒空）。
2. 按 `daemon-session-list.ts:276` 的折入方式构造病例 summary（`activity: "idle"`、`isSessionActive: false || true`），把它依次喂进 `classifySessionRosterStatus → AgentRoster.write → sessionSummaryFromRosterEntry → classifyAgentsViewSession → classifyUnifiedSession`，**每一跳都输出 `running`**。
3. **正控**：同一个 summary 去掉 kernel-work 折入（`isSessionActive: false`）→ 每一跳都输出 `idle`。

即：唯一变化的输入就是那个折入项，输出从 Idle 翻成 Running。因果闭合。

### 1.4 与派单前提的三处校正（都有证据）

| 派单说法 | 实测 | 证据 |
|---|---|---|
| "内核早死" | **kernel 仍驻留且活着**（PID 47462，etime 7h30m）。而且这是设计：`agent-session.ts:16186-16210` `registerRlmChildSession` 的注释原文是 *"Retain a finished child session for the parent lifetime so inspectors and daemon-hosted agent messaging can keep addressing it."* | §1.2(a) |
| "ledger 已 completed" | ledger **没有** completed 状态；`completed` 只在 display 文件 `rlm-subagent.json` 里。ledger 侧该 edge 仍是一条**活 edge**（只有 spawn，无 delete） | §1.2(d)、`rlm-ledger-compaction.ts:45-84` |
| "转录 7 小时前写完" | 成立：转录 mtime `Sep 20 04:52`，display `updatedAt 2026-09-19T20:52:41.708Z` | §1.1 |

---

## 2. 管道图（逐跳，文件:行）

```
[kernel 里一个活着的后台 bash() 句柄]                     ← 本案 PID 49275
        │  孤儿进程日志 active:true（ownerPid=worker, kernelPid=kernel）
        ▼
ReplManager.isKernelBashRunning                            core/kernel/repl-manager.ts:795-801
        │  journaledLiveBashHandles(kernelPid) > 0         core/kernel/repl-manager.ts:817-843（5s TTL 缓存 :156）
        ▼
AgentSession.isKernelWorkInFlight                          core/agent-session.ts:5720-5723
        │  = hasActiveExecution || isKernelBashRunning
        ▼
★★折入点★★ summaryForActiveSession 把它折进 isSessionActive  modes/daemon/daemon-session-list.ts:276
        │  isSessionActive: session.isSessionActive || session.isKernelWorkInFlight === true
        │  （同一函数 :261 的 activity 走 activeActivityForSession，是"显示轴"，
        │    对已完成的 subagent 明确返回 "idle"：daemon-session-list.ts:453-470）
        ▼
worker 组帧 flushRoster                                    modes/daemon/daemon-mode.ts:7581-7704
        │  buildSessionList([state]) → workerRosterEntryFromSummary
        │  增量路径复用非 dirty 行（:7592-7612）
        │  → roster_delta 帧 broadcastRosterFrame（:7715-7729）
        ▼
supervisor 收帧 consumeWorkerRosterDelta                   modes/daemon/daemon-supervisor.ts:6175-6204
        │  applyWorkerRosterDelta :6248-6275 → writeRosterEntry :6055-6071
        ▼
★★判定点★★ AgentRoster.write → classifyWorkerRosterEntry    modes/daemon/agent-roster.ts:170-176 → :78-80
        │  classifySessionRosterStatus                       modes/daemon/agent-roster.ts:29-38
        │    resident = !!summary.activeSessionId
        │    busy     = summary.activity === "working" || summary.isSessionActive === true   ← :36
        │  classifyAgentStatus                               modes/daemon/agent-roster.ts:16-20
        │    queuedChild → running；!resident → inactive；否则 busy ? running : idle
        │  ⇒ entry.status = "running"
        ▼
客户端 roster_subscribe / roster_update                     modes/agents-view/roster-store.ts:46-117
        │  sessionSummaryFromRosterEntry 把 entry.status 写成 summary.rosterStatus
        │                                                  modes/daemon/agent-roster.ts:115-124（:121）
        ▼
★★视图判定点★★ classifyAgentsViewSession                   modes/agents-view/agents-view-state.ts:106-108
        │  return summary.rosterStatus ?? classifySessionRosterStatus(summary)
        │  classifyUnifiedSession（:110-115）→ record.section = classifyUnifiedSession(record)
        │                                                  modes/agents-view/agents-view-state.ts:409
        ▼
buildAgentsViewRows 行落位                                  modes/agents-view/agents-view-state.ts:1022
        │  section: record?.section ?? classifyAgentsViewSession(summary)
        │  runningSubagentCount 计数 child.section === "running"   :1076
        │  subagent-summary 行继承 parent.section                   :1154
        ▼
渲染：段位标题 + 闪烁图标 + 动画计时器                        modes/agents-view/agents-view-mode.ts
        │  sectionTitle("running") → "Running"               agents-view-state.ts:130-141
        │  getRowIcon("running") → workingIconFrame(...)      agents-view-mode.ts:2991-3004
        │  formatRowIcon("running") → theme.bold(icon)        agents-view-mode.ts:3006-3015
        │  animationTimer：只要有一行 section==="running" 就 ++workingIconFrame 并请求重绘
        │                                                  agents-view-mode.ts:964-977（:968 判据）
        ▼
[老板看到的：Running 区里一行 linkrefund-post2-ds，图标在闪]
```

### ① 视图行的 section 由谁决定、数据源是 roster 的哪个字段

- 决定点：`agents-view-state.ts:1022`（`buildAgentsViewRows`）→ `record?.section ?? classifyAgentsViewSession(summary)`。
- `record.section` 由 `reconcileUnifiedSessions` 在 `agents-view-state.ts:409` 赋值：`record.section = classifyUnifiedSession(record)`；`classifyUnifiedSession`（`:110-115`）在无 daemon 源时返回 `"inactive"`，否则转 `classifyAgentsViewSession(record.daemon)`。
- `classifyAgentsViewSession`（`:106-108`）＝ `summary.rosterStatus ?? classifySessionRosterStatus(summary)`。
- **数据源字段就是 `SessionSummary.rosterStatus`**（`daemon-session-list.ts:86` 声明），它由 `sessionSummaryFromRosterEntry`（`agent-roster.ts:121`）从 `AgentRosterEntry.status` 写入。
- 闪烁图标：`agents-view-mode.ts:2991-3004` + 动画计时器 `:964-977`，判据是 `row.section === "running"`（`:968`）。**图标闪 = 段位 running 的直接产物，没有独立的"活跃"判据。**
- 同一行的文字标签走另一条路：`getSessionStatusLabel`（`agents-view-state.ts:1427-1494`）。病例行会落到 `:1484-1486` 的 `"replied"`（`runtimeKind === "subagent" && repliedSinceTask`）或 `:1493` 的 `"completed"/"needs input"`。
  ⇒ **可见症状：段位在 Running（转圈），标签却写着 replied/completed——段位与标签自相矛盾。** 这就是截图那一行的样子，也是最快的肉眼自查法。
  ⇒ 附带发现：`agents-view-state.ts:1457` 的注释引用 `isAgentsViewSessionBusy`，该符号**全仓已不存在**（`grep -rn isAgentsViewSessionBusy src test` 只命中这条注释本身）——stale 注释。

### ② roster 的 running 判定由谁喂

三个来源，**都不是 ledger，也不是 display 文件**：

1. **worker 上报（主路径）**：`daemon-mode.ts:7581` `flushRoster()` 用 `buildSessionList` 从**驻留的 `ActiveSessionState`** 组 summary，`workerRosterEntryFromSummary` 转成 entry，`roster_delta` 帧推给 supervisor；supervisor `AgentRoster.write`（`agent-roster.ts:170-196`）**在写入时统一分类一次**（`classifyWorkerRosterEntry`）。触发时机是事件驱动：`observeRosterEvent`（`daemon-mode.ts:7489-7505`）只对 `ROSTER_SESSION_EVENT_TRIGGERS`（`:8129-8146`：turn_start/turn_end/bash_start/bash_end/tool_execution_*/message_end/…）和 `session_status|session_closed|session_replaced` 打标 dirty。
2. **supervisor 内存态重播种**：`seedRosterLedger`（`daemon-supervisor.ts:6083-6103`）与 `applyWorkerRosterSnapshot`（`:6277-6330`）从 **ledger 的 `liveEdges()`** 造行（`rosterEntryForSpawnLedgerEdge` `:6152-6173`），这些行 `activity:"idle"`、`isSessionActive:false`、**无 `activeSessionId`** ⇒ 分类为 `inactive`，不是 running。`hydratedSeedEntry`（`:3916-3923`）只补 `cwd`，**不读 display 文件的 status**。
3. **queuedChild 短路**：`classifyAgentStatus`（`agent-roster.ts:17`）第一条 `if (input.queuedChild) return "running"`；queued 行由 `observeRosterChildUpdate`（`daemon-mode.ts:7507-7518`）维护。本案不是这条（子代理早已 bound）。

⇒ **本案的 running 来自路径 1**：worker 里那条驻留的 subagent `ActiveSessionState`，其 summary 的 `isSessionActive` 被 kernel-work 折成了 true。

### ③ `rlm-subagent.json` 的 `completed` 是谁写的、写完有没有广播到 roster

- 写入者：`daemon-mode.ts:2719-2747` `SubagentRuntimeHost.completeRlmSubagentRuntime` → `recordRlmSubagentState(parentState, { ..., status: "completed" })`（`:2733`）→ `writeRlmSubagentDisplayEntry`（`:1313-1323`，实现在 `rlm-subagent-display.ts:126-149`：临时文件 + fsync + rename 原子写）。
- 调用者：`agent-session.ts:16192-16210` `registerRlmChildSession`——即"子代理跑完、把 session 留给父会话继续寻址"的那一刻。
- **写完没有任何 roster 广播**。`completeRlmSubagentRuntime` 全体（`:2719-2747`）不碰 `this.rosterReporter`、不调 `scheduleRosterFlush()`、不发任何 daemon event。
- **对照证据（同一文件的删除路径是有广播的）**：`recordRlmSubagentDeletion`（`:1333-1434`，广播在 `:1425-1430`）明确做了
  ```ts
  this.rosterReporter.removedAgentIds.set(this.rosterAgentIdForRlmChild(childId, entry.parentSessionFile), basename(entry.sessionFile, ".jsonl"));
  this.scheduleRosterFlush();
  ```
  ⇒ 删除是一个 roster 事实，**完成不是**。
- `completed` 在整条视图链上**零消费者**：`readRlmSubagentDisplayEntry` 全仓只有 1 个调用点——`daemon-mode.ts:1490`（`passiveRlmSubagentEntryForEdge`，服务于被动 listing / hydration），roster 与 agents 视图都不经过它。

### ④ 为什么 7 小时不翻篇：断点在哪一层

按因果顺序，四层都断，**主断点在第 1 层**：

**断点 1（主）— busy 公式读错了轴：`agent-roster.ts:36`。**
```ts
busy: summary.activity === "working" || summary.isSessionActive === true,
```
`summary.isSessionActive` 是**驻留/关停安全轴**：`daemon-session-list.ts:262-275` 的注释自己写明这个折入是为 r44（LIVE-1）的驱逐策略服务的，"this field drives child passivation and whole-worker eviction"。`summary.activity` 才是**显示轴**：`daemon-session-list.ts:447` 的注释原文 *"the display activity axis deliberately excludes delegated work"*，且 `activeActivityForSession`（`:453-470`）对"已完成的 subagent"明确返回 `"idle"`（`:458-462` 注释：*"A finished subagent is resident but never gets a summarizer verdict, so don't hold it at 'working'"*）。
⇒ 段位判据把驻留轴当显示轴读，一个线字段承载了两种语义，于是"已交差但还托管着后台脚本"＝"正在干活"。

**断点 2 — 子代理"完成"不产生 roster 事实**（见 ③）。即使修好断点 1，完成事件本身也不会推动一次重算；本案能翻篇靠的是"句柄消失后下一轮驱逐清扫把会话 passivate"这条间接路（见 §8）。

**断点 3 — ledger 无法表达"完成"**（见 §1.2(d)）。所有 ledger 驱动的重播种（`rosterEntryForSpawnLedgerEdge`、`seedRosterLedger`、`applyWorkerRosterSnapshot`）都拿不到终态；`hydratedSeedEntry` 也不读 display 文件。daemon 重启后，一个已完成的子代理在 roster 里只能是 `inactive`（因为无 `activeSessionId`），**永远没有 "completed" 这个可见态**。

**断点 4 — 视图侧没有任何时间兜底。**
- `RLM_SUBAGENT_STALE_AFTER_MS = 6h` 与 `effectiveRlmSubagentDisplayStatus`（`rlm-subagent-display.ts:47/57-64`）确实是"卡住就降级"的兜底，但它 (i) 只作用于 display 条目、(ii) **只降级 `status === "running"` 的条目**（`:62`：`if (entry.status !== "running" || lastActivityMs === undefined) return entry.status;`）。本案 display 是 `"completed"`，这条兜底逻辑上永远不会触发；而且它唯一的消费点是被动 listing（`daemon-mode.ts:1503`），根本到不了视图。
- supervisor 的 `sweepRosterStaleness`（`daemon-supervisor.ts:6401-6417`）只盖 `lastHeardFromAt` 戳，**不改 status**；且触发条件是整台 worker 静默超过 `ROSTER_STALE_AFTER_MS = 3 × 15s = 45s`（`:238`、`daemon-worker-protocol.ts:42`）。本案 worker 活着并且每 15s 发 `roster_heartbeat`（`daemon-mode.ts:797-803`，supervisor 侧 `daemon-supervisor.ts:8130` 只做 liveness），所以这个 sweep 永远不触发。

**断点 5（放大器）— roster 无周期性重算。** `flushRoster` 的增量路径（`daemon-mode.ts:7592-7612`）对非 dirty 会话**逐字复用上一轮的 entry 和 JSON**。而 kernel-work 这个事实的变化（句柄自己死了）**不产生任何 session event**，因此不会把该行标 dirty。⇒ 即使句柄消失，行也要等到下一次该会话的 roster 事件（或 passivate/close）才会重算。这解释了"为什么不是慢慢自愈，而是钉死"。

---

## 3. 治理约束：D35 锁测与 r44 的两个载体（**修复前必读**）

`test/suite/live-kernel-work-residency.test.ts` 里有一条用例，标题为 `"locks the summary carrier and the UI consequence it deliberately has (D35)"`，其中：

```ts
expect(summary.isSessionActive).toBe(true);
expect(isSessionSummaryBusy(summary)).toBe(true);
expect(summary.isBashRunning).toBe(false);
// Intended consequence, pinned so nobody "fixes" it back: a session whose turn ended but
// whose kernel hosts a handle reads as running to the roster and the agents view, while the
// display activity axis - deliberately turn-level - still says idle.
expect(classifySessionRosterStatus(summary)).toBe("running");
expect(summary.activity).toBe("idle");
```

也就是说：**"卡 Running" 是被显式钉住的预期行为**，注释还专门写了"pinned so nobody 'fixes' it back"。

同一文件另一条用例还锁了红线：`session.isSessionActive` **不得**折入 kernel-work，否则 `waitForIdle`／RLM quiescence／goal continuation 会被一个后台脚本永久 park（原文：*"Folding the residency term into it would make `wait_for_idle` never return"*）。这条红线本方案**完全保留**——要改的是 roster 段位判据读哪个轴，不是 `AgentSession.isSessionActive`。

r44（LIVE-1）的 kernel-work 事实有**两个独立载体**，删任一个都会在自己的层上重开 r44 form A：

| 载体 | 位置 | 谁消费 | 本方案是否触碰 |
|---|---|---|---|
| 载体 1：worker 本地 passivation 快照的 `hasLiveKernelWork` 项 | `daemon-mode.ts:3057`（并从 `state.runtime.session.isKernelWorkInFlight` 直读） | `canPassivateSession`（`session-action-store.ts:484`）、归因日志 `logKernelPinnedResidency`（`daemon-mode.ts:3207-3245`） | **不碰** |
| 载体 2：summary 的 `isSessionActive` 折入 | `daemon-session-list.ts:276` | supervisor 的整 worker 驱逐 `workerEvictionSnapshot`（`daemon-supervisor.ts:1862-1904`，`:1897` 用 `isSessionSummaryBusy(summary)`）、空会话回收 `isEvictableEmptySessionSummary`（`daemon-session-list.ts:147-154`）、孤儿退出闸 `hasOngoingSessionWork`（`daemon-mode.ts:968-976`） | **不碰**（折入保留） |

`daemon-supervisor.ts:1890-1896` 还有一条**协议裁定（T1）**原文：*"nothing crosses the wire here. No new field, no capability gate, no DAEMON_SCHEMA_REVISION (37) bump, no DAEMON_PROTOCOL_VERSION (7) bump."* ⇒ 任何"往 summary 上加新字段"的方案都要重新走这条裁定（AGENTS.md「Daemon Protocol Changes」要求 capability gate + revision bump + 新旧双向测试）。这是本文把方案 A′（纯客户端、零线改）列为可选最小面的原因。

---

## 4. 修复方案

### 方案 A（推荐）：把"显示轴"和"驻留轴"在 roster 判据里显式分开

**改动面**：`agent-roster.ts` 一个函数 + `agents-view-mode.ts` 一个安全闸 + 两处测试。

1. `modes/daemon/agent-roster.ts`：给段位判据换成显示轴。
   - 现状 `:29-38`：`busy: summary.activity === "working" || summary.isSessionActive === true`。
   - 改为：段位 busy 只读显示轴（`activity === "working"`），并新增一个具名谓词把语义写死，例如
     ```ts
     /** Display axis: what the agents view means by "working". Deliberately excludes kernel-hosted
      *  background work and delegated child work - both are residency facts, not agent activity.
      *  The residency axis stays isSessionSummaryBusy(). */
     export function isSessionSummaryDisplayBusy(
         summary: Pick<SessionSummary, "activity">,
     ): boolean {
         return summary.activity === "working";
     }
     ```
   - `classifySessionRosterStatus` 的 busy 输入改用它；`isSessionSummaryBusy`（`:23-27`）**一字不改**，继续做驻留轴。
   - **必须核实的一致性前提（本文已核）**：对 worker 组的 summary，`activity === "working"` ⟸ 原始 `session.isSessionActive`（`daemon-session-list.ts:455-457`），而 `summary.isSessionActive = 原始 || kernelWork`（`:276`）。所以去掉 `|| isSessionActive` 项，**唯一被去掉的就是 kernel-work 折入**，turn 级活跃仍然 100% 落在 `activity === "working"` 上，不会漏判真正在跑的行。
2. `modes/agents-view/agents-view-mode.ts:3083` `hasLiveWork`：**必须同步改**，见 §4.5。
3. 测试：反转 D35 的 `classifySessionRosterStatus` 期望值（`"running"` → `"idle"`），**保留**同一条用例里 `summary.isSessionActive === true` / `isSessionSummaryBusy(...) === true` / `summary.activity === "idle"` 三个断言（它们是载体 2 的锁）；并修 `test/agent-roster.test.ts`（见 §5 针 2）。

**优点**：一处改、所有面（agents 视图段位、footer 的 `countRosterSubagentStatuses`、`agent-observe` 的 persisted 行）语义一致，符合 `agent-roster.ts:4` 的自我要求 *"One status formula shared by every agent surface"*。零线改、零协议改、零 capability gate。
**代价**：反转一条被钉住的设计意图，必须走裁定（§10）；`rosterStatus` 的语义从"驻留+忙"收窄为"显示忙"，所有读 `rosterStatus` 的面都跟着变（清单见 §4.6）。

### 方案 A′（最小面、纯客户端）：只改视图的段位判据

只动 `agents-view-state.ts:106-108`：
```ts
export function classifyAgentsViewSession(summary: SessionSummary): AgentsViewSection {
	const status = summary.rosterStatus ?? classifySessionRosterStatus(summary);
	if (status !== "running") return status;
	// "Running" is a claim about the agent, not about the session's residency. A queued child is
	// admitted and about to work; a turn in flight is working. A session that merely hosts
	// kernel-owned background work (isSessionActive folded from isKernelWorkInFlight, r44) is
	// idle on the display axis.
	if (summary.statusLabel === "queued" || summary.activity === "working") return "running";
	return "idle";
}
```
（`statusLabel === "queued"` 那一项是必需的：`queuedChildRosterEntry`（`daemon-mode.ts:7530-7556`）造的 queued 行 `activity` 是 `"idle"`，只靠 `classifyAgentStatus` 的 `queuedChild` 短路成为 running；不加这一项会把"已准入、session 还没落地"的子代理错误降级。）

**优点**：改动面最小，`rosterStatus` 语义不变，其它面零影响，也不需要动 D35 的 `classifySessionRosterStatus` 断言（只需在该测试里补一条"视图段位"断言）。
**代价**：违反 `agent-roster.ts:4` 的"单一公式"原则——视图成为唯一改判的面，footer 计数（`subagent-summary-line.ts:224`）和 `agent-observe` 仍会说 running，**同一份事实在两个 UI 上不一致**。仍需改 `hasLiveWork`（§4.5）。

### 方案 B（补强，可与 A/A′ 叠加）：让"完成"成为一个 roster 事实

修断点 2/3，使 `rlm-subagent.json` 的 `completed` 不再是死信息：
1. `daemon-mode.ts:2719-2747` `completeRlmSubagentRuntime` 在写完 display 文件后，比照删除路径（`:1425-1430`）补一次 dirty 标记 + flush：把该子代理自己的 `activeSessionId` 加进 `rosterReporter.dirtyActiveSessionIds`（或直接 `scheduleRosterFlush()` 全量），保证终态落盘后**立刻**重算一次该行。
2. 让已完成的子代理在标签上可读：`getSessionStatusLabel`（`agents-view-state.ts:1427-1494`）对 subagent 目前只能落到 `"replied"`（`:1484`）或 `"needs input"`（`:1493`）——`"needs input"` 对一个已交差的子代理是误导。子代理拿不到 summarizer verdict（`daemon-session-list.ts:458-459` 注释明说），所以需要一条不依赖 verdict 的终态标签。
   - **零线改的做法**：worker 侧在 `summaryForActiveSession` 里对 `metadata.kind === "subagent"` 且已 `registerRlmChildSession` 的行补 `taskState: "completed"`（`taskState` 已在线上，`daemon-session-list.ts:85`），标签就会走 `:1493` 的 `"completed"`。
   - 需要新增"hosting background work"这类新文案时，属于产品口味，交裁定（§10 第 3 条）。
3. （可选，成本较高）给 ledger 增加完成态：`RlmLedgerRecord` 加 `op: "complete"`、`RlmLedgerEdge` 加 `completed?: boolean`。这会动 `reduceRlmLedgerEdges`（`rlm-ledger-compaction.ts:222+`）与压缩等价性，且要处理"旧 daemon 读新 ledger"的兼容。**本文不建议在本轮做**：断点 1 修好后，daemon 重启场景里已完成子代理显示为 `inactive` 是可接受的（它确实不驻留了）。

### 方案 C（否决）：在视图侧加时间兜底

把 `RLM_SUBAGENT_STALE_AFTER_MS` 的思路搬到视图：段位是 running 但 `lastActivityAt` 超过 N 小时就降级。
**否决理由**：这是打地鼠——它不回答"Running 是什么意思"，只给错误答案加一个延时；阈值内（本案 6h）照样错，阈值外又把"真的跑了 8 小时的长活"错误降级；而且它需要视图能拿到 `lastActivityAt` 并自己解释，等于第三套判据。按 AGENTS.md「研究纪律·禁打地鼠」应排除。

### 4.5 无论选 A 还是 A′，都必须一起改的安全面：`hasLiveWork`

`agents-view-mode.ts:3082-3085`：
```ts
// Destructive actions gate on live work anywhere in the subtree, never on the display section.
function hasLiveWork(row: AgentsViewRow): boolean {
	return row.section === "running" || row.runningSubagentCount > 0 || row.summary.hasRunningRlmChildren === true;
}
```
注释声称"never on the display section"，**但代码第一项就是 `row.section === "running"`**——注释与实现已经不一致。一旦段位被降级，这个闸会跟着失效：一个仍托管着活后台脚本的会话，`delete` 会从 "stop" 变成 "delete"（消费点：`:2052`、`:2118`、`:2796` 的 legend 文案与删除/停止分支）。**这正是 r44 要防的"停掉一个还在跑后台脚本的会话"。**

必须补上驻留轴：
```ts
function hasLiveWork(row: AgentsViewRow): boolean {
	return (
		row.section === "running" ||
		row.summary.isSessionActive === true ||
		row.summary.isBashRunning === true ||
		row.runningSubagentCount > 0 ||
		row.summary.hasRunningRlmChildren === true
	);
}
```
`summary.isSessionActive` 在客户端是可见的（它就在 `SessionSummary` 上，`daemon-session-list.ts:37`，且折入保持不变），所以这一步**零线改**。

### 4.6 改 `classifySessionRosterStatus`（方案 A）的完整爆炸半径

逐个核过，共 7 个消费点：

| 消费点 | 影响 | 处置 |
|---|---|---|
| `agents-view-state.ts:107` `classifyAgentsViewSession` | **目标改动**：段位由驻留轴改为显示轴 | 需要 |
| `agents-view-state.ts:112-114` `classifyUnifiedSession` → `:409` `record.section` | 同上（unified 记录路径） | 需要 |
| `agents-view-mode.ts:3083` `hasLiveWork` | **安全闸弱化** | §4.5 必须同步改 |
| `subagent-summary-line.ts:224` `countRosterSubagentStatuses` | footer 的 running/idle 子代理计数随之一致变化 | 期望内，需补断言 |
| `agent-observe.ts:126` `isSessionActive: entry.status === "running"` | 仅作用于 **persisted（离线）** 家族成员；离线行走 `summaryForInactiveSession`（`activity:"idle"`、无 `activeSessionId`）⇒ 分类是 `inactive`，不受影响 | 已核，无影响 |
| `daemon-supervisor.ts:6538` `status: ledgerRow?.status ?? classifySessionRosterStatus(summary)` | 供 `assertAgentSessionNameAvailable`（`agent-messages.ts:305-325`）用；该函数经 `classifyAgentSessionNameParent`（`:396-407`）只读 `id/name/depth/parent*`，**不读 `status`** | 已核，无影响（多余字段） |
| `daemon-mode.ts:5996` `createAgentMessageAgentSummary` | 传入的 `activity` 与 `isSessionActive` 同源（`session.isSessionActive ? "working" : "idle"`），两轴一致 ⇒ 输出不变 | 已核，无影响 |
| `daemon-supervisor.ts:3902` 离线/ledger 行 | 这些行无 `activeSessionId` ⇒ `resident=false` ⇒ 恒 `inactive`，与 busy 项无关 | 已核，无影响 |

驻留/驱逐侧（`canEvictWorker`、`isEvictableEmptySessionSummary`、`hasOngoingSessionWork`、`canPassivateSession`）走的是 `isSessionSummaryBusy` / `summary.isSessionActive` / `hasLiveKernelWork`，**都不经过 `classifySessionRosterStatus`**，所以方案 A 不动它们。

---

## 5. 针设计（先红后绿）

命名沿用本仓 `test/suite/regressions/` 的既有非数字前缀先例（`f1-`、`fixq2-`、`ma-p0-2-`、`b2-` 等，`ls test/suite/regressions | grep -v '^[0-9]'` 有 20+ 条）。若开了 issue，改成 `<issue-number>-stale-running-completed-subagent.test.ts`。

**总原则（AGENTS.md 测试卫生）**：不探私有成员（无 `as unknown as {_foo}`、无 `vi.spyOn(target, "_foo")`）；数据驱动循环前必须有 `expect(data.length).toBeGreaterThan(0)`；`hasLiveWork` 这类未导出函数**只能通过公开入口断言可观察输出**（渲染出来的 legend 文案），不能导出它来单测。

### 针 1（单元·视图轴）— `test/agents-view-state.test.ts` 追加

```ts
test("a finished subagent that only hosts kernel background work is Idle, not Running", () => {
	// Case linkrefund-post2-ds (2026-09-20): turn finished 7h ago, rlm-subagent.json says
	// "completed", but the kernel still hosts a live bash() handle (the rig host the child left
	// running). summaryForActiveSession folds that residency fact into isSessionActive
	// (daemon-session-list.ts:276) while the display axis stays "idle" (:453-470).
	const finished = makeSummary({
		runtimeKind: "subagent",
		rlmChildId: "sub-7c40ed68",
		activity: "idle",
		isSessionActive: true, // <- the fold, not a turn in flight
		isStreaming: false,
		repliedSinceTask: true,
	});
	// The two axes disagree by construction; that is the input, not the assertion.
	expect(finished.activity).toBe("idle");
	expect(finished.isSessionActive).toBe(true);
	// The proposition: the section follows the display axis.
	expect(classifyAgentsViewSession(finished)).toBe("idle");
	// Positive control 1: the same row mid-turn is still Running.
	expect(classifyAgentsViewSession(makeSummary({ activity: "working", isSessionActive: true }))).toBe("running");
	// Positive control 2: a queued child (activity "idle", statusLabel "queued") is still Running.
	expect(classifyAgentsViewSession(makeSummary({ statusLabel: "queued" }))).toBe("running");
	// Positive control 3: the residency axis is untouched, so r44 still holds.
	expect(isSessionSummaryBusy(finished)).toBe(true);
});
```
- **今天为什么红**：`classifyAgentsViewSession` 走 `classifySessionRosterStatus`，busy 命中 `isSessionActive === true` ⇒ 实际 `"running"` ≠ 期望 `"idle"`。
- 需要新导入 `isSessionSummaryBusy`（`../src/modes/daemon/agent-roster.js`）。
- 追加一个 unified 路径的孪生断言：`reconcileUnifiedSessions([finished], [])` 后 `records[0].section === "idle"`，再 `buildAgentsViewRows(records)` 后该行 `section === "idle"`；正控用 mid-turn summary 断言 `"running"`。（覆盖 `:409` 与 `:1022` 两个落位点，防止只修了 `:107` 而 record 路径仍旧。）

### 针 2（单元·公式轴，**仅方案 A 需要**）— `test/agent-roster.test.ts` 修改 + 追加

现有 `summaryFor(resident, busy, heartbeat)`（`:7-24`）把 `activity` 硬编码成 `"idle"` 而用 `isSessionActive: busy` 表达忙——它本身就是"用驻留轴当显示轴"的写法，方案 A 下会红（`:44-53` 的循环期望 `busy=true ⇒ "running"`）。处置：
- 把 helper 改成两轴一致（`activity: busy ? "working" : "idle"`），保留原循环的全部期望值不变——这证明"turn 级活跃"这一语义在方案 A 下**零回归**。
- 追加一条显式分离两轴的用例：
```ts
it("reads the display axis for the section and the residency axis for eviction", () => {
	const hostingOnly: SessionSummary = { ...summaryFor(true, false, false), isSessionActive: true };
	expect(classifySessionRosterStatus(hostingOnly)).toBe("idle");   // section: display axis
	expect(isSessionSummaryBusy(hostingOnly)).toBe(true);            // residency: unchanged
	expect(classifySessionRosterStatus(summaryFor(true, true, false))).toBe("running"); // positive control
});
```

### 针 3（锁测反转，**仅方案 A 需要**）— `test/suite/live-kernel-work-residency.test.ts` D35 用例

- 改：`expect(classifySessionRosterStatus(summary)).toBe("idle")`，并把该用例标题与注释里的 "Intended consequence, pinned so nobody 'fixes' it back" 改写成新的裁定记录（写明：段位读显示轴、驻留读 `isSessionActive`，两轴分离的裁定日期与依据）。
- **保留不动**（这三条是 r44 载体 2 的锁）：`expect(summary.isSessionActive).toBe(true)`、`expect(isSessionSummaryBusy(summary)).toBe(true)`、`expect(summary.activity).toBe("idle")`、`expect(summary.isBashRunning).toBe(false)`。
- **保留不动**：`"blocks whole-worker eviction through the same summary"` 用例（`canEvictWorker(...) === false` + 正控 `=== true`）与 `"the split is a red line"` 用例（`session.isSessionActive === false` + `waitForIdle()` 立即 resolve）。
- 若选方案 A′，本文件**不改**，只在针 1 里加视图断言。

### 针 4（端到端回归）— `test/suite/regressions/stale-running-completed-subagent.test.ts`

用 `test/suite/harness.ts` + faux provider（AGENTS.md 硬性要求，不得用真 provider/真 key）。步骤：
1. 起一个 daemon harness，父会话通过 RLM 派一个子代理；用 faux provider 让子代理跑完一个 turn（有 reply、`registerRlmChildSession` 被调用、display 文件落成 `completed`）。
2. 让该子代理的 kernel 报告"有活句柄"：走 harness 已有的 `kernelResidencyFacts` 注入点（`live-kernel-work-residency.test.ts` 的 `createHarness({ kernelResidencyFacts: () => ({ hasActiveExecution: false, isKernelBashRunning: true }) })` 就是这个入口），**不要**去真起一个后台进程。
3. 断言（红→绿的主体）：
   - roster 里该子代理行的 `status === "idle"`；
   - `buildAgentsViewRows(reconcileUnifiedSessions(summaries, []))` 出来的该行 `section === "idle"`；
   - 父行的 `runningSubagentCount === 0`（覆盖 `agents-view-state.ts:1076` 的计数）；
   - `subagent-summary` 行不落在 Running 区（覆盖 `:1154` 的 `section: parent.section`）。
4. **正控（同文件内，防恒绿）**：
   - 同样的 harness，但子代理**turn 还在飞**（faux provider 挂住不结束）⇒ 该行 `status === "running"`、父行 `runningSubagentCount === 1`；
   - `display 文件` 断言 `status === "completed"`（证明终态确实写成了，即本针不是靠"没完成"变绿的）；
   - `canEvictWorker(workerSnapshot, ...)` 仍为 `false`（证明 r44 没被这次修复顺带打掉）。
5. **数据驱动守卫**：若用循环遍历多个 summary，循环前先 `expect(rows.length).toBeGreaterThan(0)`。

### 针 5（安全闸，公开入口断言）— `hasLiveWork` 不许随段位一起失效

`hasLiveWork` 未导出，按测试卫生规则**通过 legend 文案断言**：构造一行 `section === "idle"` 但 `summary.isSessionActive === true` 的记录，渲染 agents 视图 footer/legend，断言删除键的文案是 `stop` 而不是 `delete`（消费点 `agents-view-mode.ts:2944`：`` `${keyText("app.agents.delete")} ${selectedRow.section === "running" ? "stop" : "delete"}` ``，以及 `:2796` 的 `hasLiveWork(row) ? "stop" : "delete"`）。
- **注意**：`:2944` 那一处**直接读 `section === "running"`**，不走 `hasLiveWork`。所以方案 A/A′ 落地时，`:2944` 也要一并改成走 `hasLiveWork(selectedRow)`，否则 legend 会说 "delete" 而实际动作仍是停止一个托管着活脚本的会话。这条必须在针 5 里断言到（红：文案是 `delete`；绿：文案是 `stop`）。

### 针 6（变异测试，证明针有牙）

绿了之后逐条变异、每条都必须至少一根针变红，然后 `git checkout -- <file>` 从**提交态**复原（不要用自留快照）：

| 变异 | 预期变红 |
|---|---|
| 把 `agent-roster.ts:36` 改回 `... \|\| summary.isSessionActive === true`（方案 A）／把 `classifyAgentsViewSession` 的显示轴分支删掉（方案 A′） | 针 1、针 2、针 4 |
| 把 `hasLiveWork` 新增的 `summary.isSessionActive === true` 项删掉 | 针 5 |
| 把 `agents-view-mode.ts:2944` 改回 `selectedRow.section === "running"` | 针 5 |
| 把 `daemon-session-list.ts:276` 的 `\|\| session.isKernelWorkInFlight === true` 删掉 | `live-kernel-work-residency.test.ts` 的 D35 与整 worker 驱逐用例（证明本文没顺手拆掉 r44 的锁） |
| 把 `daemon-session-list.ts:460-462` 的 subagent 提前 return `"idle"` 删掉 | 针 1 的正控／针 4（显示轴本身有牙） |

---

## 6. 验证清单

**A. 静态与单元（改完就跑）**
1. `npm run check`（仓库根，取全量输出、不 tail；`check` 不含测试）。零 error/warning/info。
2. `npm run check:test-hygiene`（新增针不得引入私有成员探测；若必须破例，`// test-hygiene-allow: <具体可核原因>`）。
3. 从**包根**逐个跑改动过的测试文件：
   `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/agents-view-state.test.ts`
   同样跑 `test/agent-roster.test.ts`、`test/suite/live-kernel-work-residency.test.ts`、`test/suite/regressions/stale-running-completed-subagent.test.ts`、`test/daemon-agent-roster.test.ts`、`test/agents-view-roster.test.ts`、`test/agents-view-time-labels.test.ts`、`test/daemon-session-list.test.ts`。
4. **先红后绿留证**：改 src 之前先只加针，跑一次，把红输出存 `/tmp/<stamp>/red_*.txt`；改完再跑，存 `green_*.txt`。没有红证据的针不算针。
5. 全量 vitest 对账（vitest 5 无 `--collect-only`）：`vitest list --json` 的 collected 必须 == passed+failed+skipped；`EXIT=9` 或整数秒腰斩先疑看门狗；SKIP 非 0 要写明对照面为什么不在场。
6. **测试环境消毒**（AGENTS.md 共享 worktree 纪律）：跑测试时把泄漏的 harness 变量清掉，例如
   `env -u RLM_DEPTH -u RLM_SESSION_DIR -u PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL npx tsx ../../node_modules/vitest/dist/cli.js --run <file>`；程序化驱动里用 `("-u", name)` 参数对（`env -u=NAME` 在 macOS/BSD 上会静默失效）。否则测试会写真 `~/.prime/agent`。
7. **净树复核**：提交后 `git archive HEAD | tar -x -C <tmpdir>`，symlink `node_modules`，在副本里跑 `npx tsgo --noEmit`，EXIT 必须 0（半提交能过 hook 但会打断 HEAD）。

**B. 端到端（真 daemon，人工验一次）**
8. 起一个会话，派一个子代理，让它在 kernel 里 `bash()` 起一个长命后台脚本（例如 `sleep 600`），然后让子代理正常交差（reply + 完成）。
9. 打开 agents 视图，核四件事：
   - 该子代理行落在 **Idle** 区，图标**不闪**（`getRowIcon` 走 `NEEDS_INPUT_ROW_ICON`，动画计时器因 `hasRunning === false` 不自增）；
   - 父行的 `#sub` / "N subagents running" 计数**不含**这个已完成的子代理（`agents-view-state.ts:1076`、`:1130-1169`）；
   - 选中该行时，删除键 legend 仍显示 **stop**（§4.5 的闸没失效）；
   - 行标签不再是对已完成子代理说 `needs input`（方案 B 落地后应为 `completed`）。
10. **r44 不退步**：同一个后台脚本还活着时，等过 idle-eviction 清扫周期（`daemon-supervisor.ts:376-378`：60s–5min），确认该子代理**没有**被 passivate、worker **没有**被驱逐；日志里应仍出现 `Kept idle child resident for live kernel bash work ...`（`daemon-mode.ts:3241-3243`）与 `kernel bash handles now hold this session resident`（`repl-manager.ts:861`）。
11. **daemon 重启后**：重启 daemon（`prime-agent shutdown` → 重开），确认该子代理行以 `inactive` 出现（ledger 重播种路径，`daemon-supervisor.ts:6083-6103` + `:3888-3907`），**不是** running；并确认 `uptime_s` 归零、抽一场真聊天验证视图正常。
12. **混合版本降级**（若最终选了需要动线的方案 B 扩展）：按 AGENTS.md「Daemon Protocol Changes」补 new-client/old-daemon 与 old-client/new-daemon 两个方向的测试，并 bump `DAEMON_SCHEMA_REVISION`；方案 A/A′ 本身**不需要**（零线改）。

**C. 交付卫生**
13. changelog fragment：`packages/coding-agent/.changes/<slug>.md`，一行 `- Fixed ...`，描述用户可见变化（"子代理交差后不再永久留在 Running 区"），不写实现细节。
14. `git commit --only -- <paths>` 只提自己改的文件；提交前 `git status` 核；禁 `git add -A`、禁 `--no-verify`、禁 amend 已合入的提交。
15. 若这批要 push：按本仓 Fork 覆盖规则先更新 `FORK_NOTES.md`（这批改了什么、用户能感觉到什么）。
16. 回滚把手：本次改动应是**单个提交**，回滚＝`git revert <sha>`；无 env 开关、无数据迁移、无协议 bump，因此不需要额外 rollback 脚本。这一点要写进台账。

---

## 7. 与既有纪律的关系（自检）

- **不是打地鼠**：修的是"Running 这个段位读哪条轴"的原理，不是给某个坏例加禁词/加死句。删掉这次改动，缺陷会以完全相同的方式复发（针 6 的第一行变异就是证明）。
- **负结论正控**：本文的两个"零消费者/零改动"型结论都带正控——`readRlmSubagentDisplayEntry` 只有 1 个调用点是全仓 `grep` 结果（同一 grep 能检出 `daemon-mode.ts:1490`，证明方法有效）；上游三文件"零提交"是 `git log <range> -- <file>` 空输出，而同一命令对 `daemon-session-list.ts` 能检出 `e311d6495`（正控）。
- **归因怀疑序**：先证伪了自己的环境（不是缓存、不是快照、不是中间层）——直接用 `ps` 看到活进程、用项目自己的 reader 读到活记录、用项目自己的分类函数跑出 `running`，最后才归因到代码逻辑。
- **留尸带时刻**：所有 /tmp 读数目录名带 UTC 时刻戳，不清理（见 §10 索引）。

---

## 8. 不改码的即时运维处置（针对当前这个活病例）

> 前提：这是**运维动作，会杀掉子代理留下的 rig 进程**，需先确认那个 rig 不再需要（本案 `/tmp/linkrefund_post2_20260920T043816` 的交付件 report.md/rounds.jsonl/sha256.txt 都已落盘，heartbeat 最后一行是 `[04:52:33] HARNESS`，7 小时无新动作）。

1. 杀后台句柄：`kill 49275`（bash 包装；它的 node 子进程 49277 在同一 pgid `49275`，必要时 `kill -- -49275`）。
2. 之后 kernel 侧的 `journaledLiveBashHandles` 会在缓存 TTL（`repl-manager.ts:156`：5s）或日志变化后重探并把计数归零（`readKernelBashResidency` 会 pid-probe 退休无退出记录的句柄，见 `repl-manager.ts:813-815` 注释 D33）。
3. **但视图不会立刻翻篇**（断点 5）：该行要等下一次 roster 事件才重算。最可靠的收尾是让 idle-eviction 清扫把它 passivate——`hasLiveKernelWork` 变 false 后 `canPassivateSession` 才会放行（`session-action-store.ts:484`），清扫周期 60s–5min（`daemon-supervisor.ts:376-378`、`:1847-1859`）。passivate 会发 `session_closed`，`observeRosterEvent`（`daemon-mode.ts:7497-7504`）随即 flush，行落到 **Inactive**。
4. 或者直接在 agents 视图里对该行执行 stop/delete（走 `delete_rlm_subagent`，`agents-view-mode.ts:2056-2094`）：这条路径**有** roster 广播（`daemon-mode.ts:1425-1430`），会立刻把行摘掉。
5. 自证：处置后核 `ps -p 49275` 不存在、`grep 'kernel bash residency released' ~/.prime/agent/logs/agent.jsonl` 出现该 sessionId、agents 视图该行不在 Running 区。**不许只说"已处置"。**

同类隐患巡检（本机取证时顺手发现，同一台 worker 上还有一个同形状的老句柄）：
```
$ ps -eo pid,ppid,etime,command | grep -E 'ncg1_host|host\.mjs' | grep -v grep
39790 32553 07:48:42 /bin/bash -c ... ncg1_host.mjs --fp abuse_post --work /tmp/abuse_post_20260920_041812 ...
```
kernel `32553` 对应 sessionId `01a0bb4a-a7d5-755e-8092-b528b766e7eb`（daemon 日志 `20:57:03.397Z` 那条 `liveBashHandles:1, oldestHandleAgeMs:2229720`）。**同一个 bug 的第二个活病例**，可用来验证修复（改完之后这一行也应离开 Running）。

---

## 9. 上游 26 笔核对（`e2fb7bfa1..upstream/main`）

**母席亲核的部分**（命令与输出，2026-09-20 12:2x CST）：
```
$ git rev-list --count e2fb7bfa1372552d81c33e9b3261d6a9cf82d30f..upstream/main
26
$ git log --oneline e2fb7bfa1..upstream/main -- packages/coding-agent/src/modes/daemon/agent-roster.ts          → 空
$ git log --oneline e2fb7bfa1..upstream/main -- packages/coding-agent/src/modes/daemon/rlm-subagent-display.ts  → 空
$ git log --oneline e2fb7bfa1..upstream/main -- packages/coding-agent/src/modes/agents-view/agents-view-state.ts→ 空
$ git log --oneline e2fb7bfa1..upstream/main -- <agents-view-mode.ts daemon-session-list.ts daemon-mode.ts daemon-supervisor.ts rlm-ledger.ts>
e311d6495 perf(coding-agent): skip roster re-composition for unchanged sessions (#2393)
126fe7010 [RSI, bug] Hold spawn name reservations until admission is durable (#2396)
3dfb0276b [RSI, bug] fix(daemon): answer heartbeats_list from live state without queueing behind serialized work (#2378)
54da82e97 [RSI, bug] fix(daemon): let session opens wait through an update restart instead of failing (#2391)
$ git show --stat --format='%h %s' e311d6495
 .../coding-agent/.changes/roster-compose-skip.md   |   1 +
 .../coding-agent/src/modes/daemon/daemon-mode.ts   |  37 ++-
 .../src/modes/daemon/daemon-session-list.ts        | 325 +++++++++++++++++++--
 .../coding-agent/test/daemon-agent-roster.test.ts  |  65 +++++
 .../coding-agent/test/daemon-session-list.test.ts  | 212 ++++++++++++++
 .../test/daemon-supervisor-monitor.test.ts         |   1 +
```

**转述自子席 `upstream26-ds`（`bailian/deepseek-v4.1-flash`, thinking=high）的部分**（逐笔表 + 全量 patch 符号扫描，母席未逐字复核 25 笔 NO 的每一笔，只复核了上面这些 YES/关键结论）：
- 逐笔结论：**YES = 1 / NO = 25**。唯一 YES 是 `e311d6495`。
- `e311d6495` 碰的是**性能**不是语义：`daemon-session-list.ts` 加 WeakMap 组合记忆（`summaryComposeMemos` / `messageActivityMemos`），`summaryForActiveSession` 在指纹不变时返回**同一个对象**；`daemon-mode.ts flushRoster` 加 `lastComposedSource`，当 memoized summary 是同一对象时直接复用上轮 entry 与 JSON。
- **(a) 上游 26 笔均未修此管道**：`RLM_SUBAGENT_STALE_AFTER_MS`、`effectiveRlmSubagentDisplayStatus`、`writeRlmSubagentDisplayEntry`、`recordRlmSubagentState`、`reconcileUnifiedSessions`、`buildAgentsViewRows`、`runningSubagentCount`、`removedAgentIds`、`dirtyActiveSessionIds`、`scheduleRosterFlush` 在 26 笔全量 patch（515,565 B）的**增删行里出现 0 次**；patch 里所有 `stale` 命中都属别的机制。
- **(b) 三个决策文件零提交**（与母席亲核一致）。
- 子席提的风险提示（**转述，未独立复核**）：`e311d6495` 是唯一可能**制造**卡 Running 的笔（按对象身份复用 summary/entry，只在指纹覆盖 activity/lifecycle 全部输入时才安全）；子席自查了本仓 `activeActivityForSession`(:453)/`activeLifecycleForSession`(:487)/`hasLiveSessionWork`(:449) 的输入项都在指纹里，判断"看下来是安全的"，但建议合并后补一次端到端复核（`daemon-agent-roster` 套件 + 真聊天带一个跑完的子代理，断言它离开 Running）。
  - 母席补充（亲核）：`hasLiveSessionWork` 确在 `daemon-session-list.ts:448-451`，注释原文 *"Live work that dies with the worker; the display activity axis deliberately excludes delegated work"*——这条注释本身就是本文方案 A 的语义依据。
- 子席另点名 4 笔"碰了管道文件但没碰管道行为"：`3dfb0276b`（heartbeats_list 走被动快照；ledger 只把 `siblings()` 拆成 enqueue+`siblingsUnlocked`，`liveEdges/appendSpawn/appendDelete/appendRename/reduceRlmLedgerEdges` 未动）、`54da82e97`（update-restart 文案常量化）、`126fe7010`（spawn 名字预留持到 admission 落定，改的是"谁能被准入"不是已准入子代理的段位）、`7572880fe`（daemon ps 列进程）。
- 子席留尸：`/tmp/upstream26_20260920T040712Z/`（`report.md` 逐笔表、`full_26commits_U0.patch` 515,565 B、`namelist.txt`、`diff_e311d6495_src.txt`、`diff_3dfb0276b_ledger.txt`、`diff_3dfb0276b_supervisor.txt`、`diff_54da82e97_agentsviewmode.txt`）。

**结论**：等上游修是等不到的——**官方也没修这条管道**，而且官方唯一碰 roster 组合的那笔是性能优化，合并时反而需要本文 §6-B 的端到端复核来兜底。

---

## 10. 待裁定问题（不属于工程判断，需母席/老板拍）

1. **Running 段位的语义**：是"这个 agent 正在干活"（本文推荐，对应显示轴 `activity`），还是"这个会话还托管着活的工作"（现状，对应驻留轴 `isSessionActive`）？
   - 默认值（若不裁定即按此执行）：**显示轴**。理由：段位标题是 "Running"、图标是转圈动画，用户读到的是"它在干活"；而"还托管着后台脚本"这个事实已经有更合适的表达位置（行标签 + 删除键的 stop/delete 措辞）。
2. **是否获准反转 D35 锁测**（`test/suite/live-kernel-work-residency.test.ts`）？该锁的注释写着 "pinned so nobody 'fixes' it back"。
   - 默认值：**获准反转段位断言，保留全部 r44 驻留断言**（§5 针 3 列了哪四条必须一字不改）。反转理由与新裁定记录写进该用例注释。
   - 若不准反转 ⇒ 只能选方案 A′（视图侧改判），代价是 footer 计数与 `agent-observe` 和视图不一致（同一份事实两个 UI 说法）。这个不一致要不要接受，也需要裁定。
3. **已完成子代理的行标签文案**：`completed` / `replied` / 新增 `hosting background work`（或中文文案）？现状对已交差的子代理可能显示 `needs input`，这是误导。
   - 默认值：`completed`（零线改，走已有 `taskState` 通道，§4 方案 B 第 2 条）。新增文案属产品口味，不默认执行。
4. **要不要顺带做方案 B 的第 1 条**（完成时补一次 roster flush）？它是纯增益、零风险、零线改，但会多动一个文件（`daemon-mode.ts`）。
   - 默认值：**做**。不做的话，断点 5（无周期重算）仍然会让"句柄自然死亡"这类场景延迟到下一次事件才翻篇。
5. **合并 `e311d6495` 的时机**：它是唯一碰 roster 组合的上游提交，且按对象身份复用 entry。要不要在本文修复落地**之前**先合它（会改变 `flushRoster` 的复用条件，可能与本文改动交互）？
   - 默认值：**先落本文修复、再合 `e311d6495`**，合并时单独跑 §6-B 第 9 条的端到端复核。

---

## 11. 证据留尸索引（不自动清理，按「留尸禁自清」纪律由母席统一处置）

| 路径 | 内容 |
|---|---|
| `/tmp/stalerun_20260920T041408Z/repro.ts` | §1.3 的机械复现脚本（tsx 直跑本仓 src） |
| `/tmp/upstream26_20260920T040712Z/report.md` | 上游 26 笔逐笔表 + 命令清单（子席 `upstream26-ds` 产出） |
| `/tmp/upstream26_20260920T040712Z/full_26commits_U0.patch` | 26 笔全量 patch（515,565 B），符号扫描的输入 |
| `/tmp/upstream26_20260920T040712Z/diff_e311d6495_src.txt` 等 | 单笔 diff 留尸（见 §9） |
| `~/.prime/agent/session-artifacts/01a0b80c-.../sub-7c40ed68/rlm-subagent.json` | 病例 display 文件（`status: completed`） |
| `~/.prime/agent/rlm-ledger/2908f90643ebb724.jsonl:5108` | 病例的 ledger spawn record（无 delete） |
| `~/.prime/agent/daemon-workers/12f042ee5718/1b9156778783.orphans.jsonl:3785` | 病例的 active 句柄记录（pid 49275 / kernelPid 47462） |
| `~/.prime/agent/logs/agent.jsonl`（`20:52:03.170Z` / `20:57:03.397Z` 两条） | kernel 驻留归因行（病例 + 第二个活病例） |
| `/tmp/linkrefund_post2_20260920T043816/` | 病例 rig 工作目录（heartbeat.log 末行 `[04:52:33]`） |

---

## 附：本文取证用到的关键符号速查

| 符号 | 位置 | 作用 |
|---|---|---|
| `classifyAgentStatus` | `modes/daemon/agent-roster.ts:16-20` | 唯一的状态公式：queuedChild→running；!resident→inactive；busy?running:idle |
| `classifySessionRosterStatus` | `modes/daemon/agent-roster.ts:29-38` | 把 summary 映射成公式输入；**busy 在 :36** |
| `isSessionSummaryBusy` | `modes/daemon/agent-roster.ts:23-27` | 驻留轴（含 `hasRunningRlmChildren`），驱逐侧用 |
| `sessionSummaryFromRosterEntry` | `modes/daemon/agent-roster.ts:115-124` | `entry.status` → `summary.rosterStatus`（:121） |
| `passivatedWorkerRosterEntry` | `modes/daemon/agent-roster.ts:82-111` | 剥掉 `activeSessionId`、activity 置 idle ⇒ 分类 inactive |
| `summaryForActiveSession` | `modes/daemon/daemon-session-list.ts:237-334` | **折入点在 :276**；activity 在 :261 |
| `activeActivityForSession` | `modes/daemon/daemon-session-list.ts:453-470` | 显示轴；:460-462 对已完成 subagent 返回 idle |
| `hasLiveSessionWork` | `modes/daemon/daemon-session-list.ts:448-451` | 显示轴刻意排除 delegated work 的明文 |
| `isKernelWorkInFlight` | `core/agent-session.ts:5720-5723` | `hasActiveExecution \|\| isKernelBashRunning` |
| `isKernelBashRunning` | `core/kernel/repl-manager.ts:795-801` | 读孤儿进程日志（:817-843，5s TTL） |
| `flushRoster` | `modes/daemon/daemon-mode.ts:7581-7704` | worker 组帧；:7592-7612 增量复用非 dirty 行 |
| `observeRosterEvent` / `ROSTER_SESSION_EVENT_TRIGGERS` | `modes/daemon/daemon-mode.ts:7489-7505` / `:8129-8146` | 什么事件才会让行变 dirty |
| `completeRlmSubagentRuntime` | `modes/daemon/daemon-mode.ts:2719-2747` | 写 `completed`；**无 roster 广播** |
| `recordRlmSubagentDeletion` | `modes/daemon/daemon-mode.ts:1333-1434`（广播在 :1425-1430） | 对照：删除**有** roster 广播 |
| `writeRlmSubagentDisplayEntry` / `readRlmSubagentDisplayEntry` | `modes/daemon/rlm-subagent-display.ts:126-149` / `:205-238` | 原子写；唯一读点在 `daemon-mode.ts:1490` |
| `effectiveRlmSubagentDisplayStatus` / `RLM_SUBAGENT_STALE_AFTER_MS` | `modes/daemon/rlm-subagent-display.ts:47` / `:57-64` | 6h stale 兜底，只降 `running` 条目、只服务被动 listing |
| `AgentRoster.write` | `modes/daemon/agent-roster.ts:170-196` | 写入时分类一次 |
| `applyWorkerRosterDelta` / `applyWorkerRosterSnapshot` | `modes/daemon/daemon-supervisor.ts:6248-6275` / `:6277-6330` | 收帧落 roster；快照路径会从 ledger 重播种 |
| `rosterEntryForSpawnLedgerEdge` / `hydratedSeedEntry` | `modes/daemon/daemon-supervisor.ts:6152-6173` / `:3916-3923` | ledger 重播种行（activity idle、无 activeSessionId）；只补 cwd |
| `sweepRosterStaleness` | `modes/daemon/daemon-supervisor.ts:6401-6417` | 只盖 `lastHeardFromAt`，不改 status |
| `workerEvictionSnapshot` | `modes/daemon/daemon-supervisor.ts:1862-1904` | r44 载体 2 的消费点（:1897）；:1890-1896 是"不加线字段"的协议裁定 |
| `classifyAgentsViewSession` / `classifyUnifiedSession` | `modes/agents-view/agents-view-state.ts:106-108` / `:110-115` | 视图段位判定点 |
| `reconcileUnifiedSessions` | `modes/agents-view/agents-view-state.ts:363-433`（`record.section` 在 :409） | 记录级段位落位 |
| `buildAgentsViewRows` | `modes/agents-view/agents-view-state.ts:993-1122`（section :1022，计数 :1076） | 行落位与 running 子代理计数 |
| `getSessionStatusLabel` | `modes/agents-view/agents-view-state.ts:1427-1494` | 行文字标签（与段位可以矛盾） |
| `getRowIcon` / `formatRowIcon` / animationTimer | `modes/agents-view/agents-view-mode.ts:2991-3004` / `:3006-3015` / `:964-977`（调用点 `:2773-2774`） | 闪烁图标的产生处 |
| `hasLiveWork` | `modes/agents-view/agents-view-mode.ts:3082-3085`（消费 :2052/:2118/:2796） | 破坏性动作的安全闸（注释与实现已不一致） |
| `AgentsViewRosterStore` | `modes/agents-view/roster-store.ts:22-146` | 客户端 roster 订阅与 dirty 派发 |
| `RlmLedgerEdge` / record 词表 | `core/rlm-ledger-compaction.ts:45-84` | ledger **无完成态** |
| `registerRlmChildSession` | `core/agent-session.ts:16192-16210` | 完成后保留子会话（"kernel 不死"的出处） |
| D35 锁测 | `test/suite/live-kernel-work-residency.test.ts` | "卡 Running" 被钉为预期行为 |
