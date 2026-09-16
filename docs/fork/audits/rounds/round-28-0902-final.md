# round-28 / 0902 终审 — r26/r27 三大批跨修复交互洞

- 冻结基线：主仓 HEAD **d6977ad29**（只读，未写入主仓任何文件）
- 审计工作树：`/tmp/wt_r28`（detached @ d6977ad29，node_modules symlink）
- 归因工作树：`/tmp/wt_r28_base`（detached @ **23e9a8e8e**＝LAT-3 落地前一提交，用于红/绿归因）
- 三批全部在 d6977ad29 的祖先链上（逐条 `git merge-base --is-ancestor` 已核）：
  LAT-1/LAT-2 `c14df4942` · LAT-3 `b35288b82` · K3R 五条 `7aa03c9e7` · SEC-1/2 `b2dd7bf8b` · SEC-3/4 `a2590d038`
- 判决：**不放行"三批互不打架"这一结论**。①②⑤ 三簇各找到一个可复现洞，其中 ①（两条）与 ②（一条）已用可执行红证钉死并完成"改前绿/改后红"归因；⑤ 为代码路径级证明（未执行复现，如实标注）。③④ 已派子席并行，结论见文末第 6 节。

---

## 1. 簇① LAT-1 会话名缓存 × LAT-3 合并写

### 1.1 直接回答"缓存失效点还对吗"：**LAT-1 本身的失效点是完好的**（正控级结论）

LAT-1 的失效点只有两处：`_pushIndexedEntry`（`session-manager.ts:2415`，见 `session_info` 置脏）与 `_rescanEntryStats`（`:2432`）。逐条核 LAT-3 新增的全部写路径：

| LAT-3 新写路径 | 是否触碰 `fileEntries` / 失效点 | 判定 |
|---|---|---|
| `appendChildUsageAttribution`（:2535）首条 | `_pushIndexedEntry` + `_persist` | 与改前同路径，安全 |
| 同函数后续 merge（:2579-2592） | 仍走 `_pushIndexedEntry`（:2557），只跳过 `_persist` | 内存索引与置脏不受影响，安全 |
| `_flushPendingAttributionWrite`（:2603） | **只调 `_persist`，不动 `fileEntries`** | 不产生新 session_info，无需置脏，安全 |
| `flushChildUsageAttributions`（:2631） | 同上 | 安全 |
| `appendAgentStatus` 去重（:2729-2737） | 命中即 return，不 append | 与 name 缓存无关，安全 |
| `_rewriteFile` 清 pending（:2197） | 不改 `fileEntries` 内容 | 安全 |
| `_buildIndex`/`newSession`/`setSessionFile`/`createBranchedSession` | 均经 `_rescanEntryStats` 置脏；`_buildIndex:2160` 亦重置 `lastAgentStatusWrite` | 安全 |

**顺带排掉一个我自己怀疑过的洞（正控）**：LAT-3 让"磁盘行序列 ≠ fileEntries"，我怀疑 `readSessionInfo` 的增量续扫（byte-offset resume）会在 `_rewriteFile()` 之后错位。实测代码已封死：`:1631-1639` 的 resumable 条件要求 `cached.ino === stats.ino`，而 `_rewriteFile` 走 `writePrivateFileAtomicLines`（temp + rename，换 inode）⇒ 必然退回全量扫描。**这一条不是洞。**

### 1.2 洞 ①-A（真，已红证，LAT-3 引入）：`agent_status` no-op 去重的键不含"分支可达性"，一次 rewind 就让同一 verdict 永久落不到活动分支

- 位置：`packages/coding-agent/src/core/session-manager.ts:2724-2752`（`appendAgentStatus` 去重）× `:3315-3325`（`branch()`/`resetLeaf()` → `_setLeaf`，`:3363`）
- 机理：去重键 `lastAgentStatusWrite` 只在 `_buildIndex`（:2160）/`newSession`（:2145）/成功 append（:2750）时更新，**`_setLeaf` 不重置它**。而读侧 `getLatestAgentStatus()`（:2785-2796）刻意"只走活动分支 leaf→root"。两者对"最新"的定义在 rewind 之后就不一致了：写侧比的是"文件里最后写过的那条"（可能已被 rewind 甩到废弃分支），读侧要的是"活动分支上能走到的那条"。
- 打穿输入（已执行）：
  1. `appendMessage(user)` → `appendMessage(assistant)`；
  2. `appendAgentStatus({summary:"Added login endpoint", taskState:"completed", basedOnMessageCount:2})`；
  3. `branch(m1)`（用户 rewind 到第一条）⇒ `getLatestAgentStatus()` 正确变 `undefined`；
  4. 摘要器对（变短的）活动分支重新发布**同一 verdict** ⇒ `appendAgentStatus` 去重命中 ⇒ **一行都不写**，`getLatestAgentStatus()` 恒 `undefined`。
- 生产触发面：`daemon-session-summarizer.ts:418-424` 在 `!isWorking && !settledWithoutModel` 时**无条件**调 `appendAgentStatus(status)`（`changed` 门只影响 `onStatusChanged` 通知，:406-409/425-427，不影响落盘调用）。所以 rewind 后每一次 idle settle 都会撞上这个去重。`seed()`（:293-301）在进程重启后从 `getLatestAgentStatus()` 恢复内存态 ⇒ **daemon 重启后 roster/attach 的 recap 与 needs_input 判定直接丢**，直到 verdict 文本真的变化才自愈。
- 红/绿归因：`test/session-manager/r28-cluster1-interaction.test.ts` C1-A
  - @ d6977ad29：**红** `expected undefined to be 'Added login endpoint'`
  - @ 23e9a8e8e（LAT-3 前）：**绿**
  - 正控 C1-A-control（rewind 后发布**不同** verdict）：两树皆绿 ⇒ `branch()` 本身健康，洞只在"同 verdict 去重"。
- 修法建议（最小）：`_setLeaf()`（或 `branch()`/`resetLeaf()`/`branchWithSummary()`）里把 `this.lastAgentStatusWrite = undefined;`——与 `_buildIndex:2160` 同语义。或把去重键改成"活动分支上可达的最后一条 agent_status"（直接复用 `getLatestAgentStatus()` 的结果比较，成本 O(branch depth)，idle settle 频率下可接受）。

### 1.3 洞 ①-B（真，已红证，LAT-3 引入，**比 ①-A 严重**）：leaf 移动后延迟归因冲刷把磁盘链拼回废弃分支 ⇒ 重启后用户消息从模型上下文里消失

- 位置：`session-manager.ts:2564-2592`（`pending.firstParentId` 在 `merges===0` 时一次性捕获）× `:2603-2624`（冲刷行 `parentId = pending.firstParentId`）× `:3315/3372`（`branch()` / `branchWithSummary()` 移动 leaf）
- 机理：merge 条目的**内存** `parentId` 取的是 append 当时的 `this.leafId`（`:2550`），而**磁盘**合并行的 `parentId` 取的是窗口首条 merge 捕获的 `firstParentId`。窗口内不发生 leaf 移动时两者只是"跳过被合并 id"的良性拼接（LAT-3 报告已如实披露）。**一旦窗口内 leaf 移动（rewind，或压缩走 `branchWithSummary`），`firstParentId` 指向的是废弃分支上的条目**，而内存里后续 merge 挂在移动后的新 leaf 上 ⇒ 内存链与磁盘链**分叉到不同的对话位置**。
- 打穿输入（已执行）：
  1. `target = appendMessage(assistant("parent turn"))`；
  2. `appendChildUsageAttribution(target,…)` ×2（第 1 条即写，第 2 条进 pending 并捕获 `firstParentId`）；
  3. `u2 = appendMessage(user("after rewind"))`；`branch(u2)`（leaf 移到 u2，`leaf_position` marker 落盘）；
  4. 子代理还在流式 ⇒ 第 3 次 `appendChildUsageAttribution(target,…)`（内存里挂在 u2 之下）；
  5. `flushChildUsageAttributions()` ⇒ 磁盘合并行 `id=merge3.id, parentId=firstParentId(=attr1.id)`，落在 marker **之后**；
  6. 重开文件：`_buildIndex`（:2162-2180）逐行推进 leafId，最后一行（合并归因行）胜出 ⇒ `leafId = merge3.id`，其 `parentId` 通向 **attr1 → assistant("parent turn") → header**，**u2 不在链上**。
- 实测结果：live 活动分支 = `["parent turn", "after rewind"]`；reload 后活动分支 = `["parent turn"]`。
  **⇒ 用户 rewind 之后发的那条消息，在一次 daemon/进程重启后从模型上下文里彻底消失，而 UI 与转录看起来毫无差别**——这正是 `branch()` 的注释（:3306-3313）自己声明要防的失败模式（"an unrecorded rewind is silently undone when the process stops before the next append"），LAT-3 用另一条路把它重新打开了。
- 触发面评估：需要"child 流式 usage 未冲刷窗口（≤32 条子消息 / ≤120s）内发生 leaf 移动"。两条现实路径：① 用户 rewind（TUI 树导航）时子代理在跑；② **自动/手动压缩**——`_performCompaction` 走 `branchWithSummary`/`getBranch` 系（`:3372-3397` 及压缩落 entry 路径），压缩是常态事件，而 120s 窗口内子代理持续流式也是常态。所以这不是罕见竞态。
- 红/绿归因：同文件 C1-B
  - @ d6977ad29：**红** `expected [ 'parent turn' ] to deeply equal [ 'parent turn', 'after rewind' ]`
  - @ 23e9a8e8e（LAT-3 前，逐条即写）：**绿**（3/3 全绿）
- 修法建议（最小）：`_setLeaf()` / `branch()` / `branchWithSummary()` 里先 `flushChildUsageAttributions()` 再移动 leaf（把窗口在 leaf 移动点切断，`firstParentId` 永远不会跨 leaf 移动）；成本是一次额外磁盘行，语义与"每条即写"等价。次选：merge 时若检测到 `pending.firstParentId` 已不在当前 leaf 的 branch 上，就地冲刷并重开窗口。

---

## 2. 簇② LAT-2 chunk 增量 × 子代理中止/重启：**preview 状态确实残留，且残留出可见乱码**

### 2.1 洞 ②-A（真，已红证，LAT-2 引入）：`RlmChildStreamPreview` 是 run 级、不是 message 级；跨 assistant 消息不重置 ⇒ `answerPreview` 变成"上一条答案 + 新答案的中间切片"

- 位置：`agent-session.ts:1490-1549`（类）· `:13705-13712`（`run.streamPreview ??= new RlmChildStreamPreview()`，**全仓唯一构造点，无任何 per-message 重置**；`streamPreview` 字段声明 `:1220`，赋值点仅此一处）· 消费点 `:14394-14400`（`message_start`/`message_update` 都走它）
- 机理：增量折算用 `foldedTextBlockLengths` 按**块长度**判定"是否是同一条消息在长"。它把"新消息的第一个 text 块比旧消息已折算长度更长"误判成"旧消息继续长"，于是 `deltas.push(block.text.slice(consumed))`，把新消息**从旧长度处切片**接在旧 `buf` 后面。只有 `block.text.length < consumed`（块变短）或 text 块数变少才触发 `structural` 全量重置（:1506-1521）。
- 打穿输入 A（**普通流式即可触发，不需要特殊 provider**）：
  - 同一 run 内，assistant 消息 M1 是短答 `"Done."`（`consumed = 5`）；
  - M2 的第一个流式事件文本长度 ≥ 5（12 字符的普通首 delta 就够）；
  - 实测输出（`/tmp/audit_r/round-28/cluster2_short_m1.mjs`，`node` 直跑）：
    ```
    M1 preview: "Done." correct? true
      M2@12: correct? false | got: "Done.ere is"
      M2@25: correct? false | got: "Done.ere is the real seco"
      M2@40: correct? false | got: "Done.ere is the real second answer that"
      M2@68: correct? false | got: "Done.ere is the real second answer that keeps"
    POSITIVE CONTROL first delta 2 < 5: correct? true "No"
    ```
  - 即 `answerPreview` 显示 `"Done.ere is the real second answer…"`——上一条答案 glued 到新答案的**词中间切片**，整条消息期间不自愈。
- 打穿输入 B（cap 冻结，同一 run 内永不自愈）：M1 累积到 900 字符（已过 160 cap ⇒ `cappedResult` 置位、`buf=""`）；M2 首个事件 ≥ 900 字符 ⇒ 非 structural ⇒ `:1523 if (this.cappedResult === undefined)` 直接跳过折算 ⇒ **preview 冻结在 M1 的 cap 上**，M2 长到 1500/2000/3000 都不变（`cluster2_preview_freeze.mjs` 实测四个点全 `frozen at M1? true`；正控：首块 40 < 900 触发 structural ⇒ 正确）。
- 中止/重启面的残留（回答提问原句）：
  - `run.streamPreview` 是 **run 级**（一个 `spawn_task` 一个 run），abort 后同一 run 经 `agent_message` 续跑、或子代理下一轮 assistant 消息，都复用同一个对象 ⇒ 残留跨 abort、跨轮次。
  - abort 后 `run.answerPreview` 保持冻结值；LAT-2 第 3 项（`emitChildUpdate` 的 volatile 字段集全等即 return，`:1264` 的 `fields.answerPreview === last.answerPreview`）意味着**字段不变就不再发 `rlm_child_update`**，所以 roster 卡片/`rlm.collect()` 的 `answer_preview` 会长期停在这条乱码上。
  - 唯一自愈点：`message_end`（`:14391-14392`）仍全文重算 ⇒ 该条消息**结束后**的 preview 是精确的。所以这是"整条消息流式期间可见的错误 preview"，不是永久脏数据；但对"母席巡心跳工件/roster 判活"这个用途，正好是它被读的那段时间。
- 红/绿归因：LAT-2 前（`c14df4942` 之前）该分支是每 chunk `compactRlmText(readAssistantText(message))` 全文重算当前消息 ⇒ 恒正确。r26 自己的正控"短答案中途 preview 前缀一致"只覆盖**单条消息**，没有覆盖"同一 run 的第二条消息"，所以漏网。
- 修法建议（最小且不回退性能）：在 `message_start` 事件上重置 preview（`run.streamPreview = undefined` 或给类加 `reset()`），只有 `message_update` 走增量；`message_start` 每消息一次，成本 O(1)。若担心 provider 不发 `message_start`，退一步在 `update()` 里加一个"消息身份"判据（把 `message` 引用/`timestamp`/首块起始内容前缀作为 key，变了就 structural 重置）。
- **验证方式说明（如实）**：②-A 是用**逐字移植的类源码**（`RlmChildStreamPreview` + `compactRlmText` + `readAssistantText` 三者 verbatim JS port，脚本头部注明取自 d6977ad29 的 1490-1549/1462-1468/1551-1556 行）在算法层证明的，未在 faux-provider 端到端 harness 里跑通整条 `rlm_child_update` wire。落地修复时应把这两个 case 补进 `test/rlm-child-stream-scaling.test.ts` 的既有 harness（它已能驱动 hosted child + 断言 `answerPreview === compactRlmText(全文)`），只需让 faux provider 在同一 run 里发两条 assistant 消息。

---

## 3. 簇⑤ K3R-7 manual 抢占 auto × compact 互斥合并

### 3.1 "抢占后第二个 manual 的指令还排队吗"——**排，但排进去基本必死，指令仍然不生效（只是从静默变成有声）**

- 排队机制本身是健全的（我逐步走了微任务序，三个 manual A/B/C 指令两两不同时不会丢）：
  `compact()`（`:9941-9983`）在 `:9974` 先同步拿到 `_compact()` 的 promise、`:9975` 同步置 `_manualCompactionInFlight`，而 `_compact` 的第一个 `await` 在 `:9998 await this.abort()`；A 的 `finally`（:9978-9982）在 A_resume 微任务里同步清字段，B 的 `.then(()=>this.compact(B))` 排在其后 ⇒ B 重入时字段已清、C 重入时看到的是 `{opB, B}` 于是排到 opB 后面。**结论：队列不丢、不死锁、不无限排队。**（这是对 r26 报告"微任务顺序论证"的独立复核，通过。）
- 但排队之后：`:10122-10128` `prepareCompaction` 返回空且分支最后一条已是 `compaction` ⇒ `throw new CompactionSkippedError("Already compacted")`。**A 成功压缩过 ⇒ B 必然撞这个 skip**，B 的 `customInstructions` 从头到尾没有被任何一次摘要调用消费。r26 报告自己写的"B 以 'Already compacted' 可见拒绝收场"就是这个。
  ⇒ K3R-7 F7 把"静默丢弃"改成了"可见丢弃"，**没有实现"第二套指令被honored"**。如果产品意图是"两组指令都要生效"，正确修法是合并指令（把 B 的 instructions 追加进 A 尚未发出的摘要调用，或让 B 的重入跳过 `prepareCompaction` 的 already-compacted 门、在已压缩上下文上带自己的指令再摘要一次）。当前状态应记为 **partially fixed**，不是 fixed。

### 3.2 洞 ⑤-A（真，代码路径级证明；未执行复现，如实标注）：manual 抢占把 threshold 自动压缩推进 "cancelled" 分支，销毁排队中的自主续跑与 goal 续跑，且不 `resumeAfterFailure()`

- 位置：`:9973`（K3R-7 F6 新增：manual 入场 `this._autoCompactionAbortController?.abort()`）× `_runAutoCompaction` 的 catch 分支 `:11566-11583`
- 机理链：
  1. threshold 自动压缩入场时，`:11470-11481` 已经把 `_pendingRequestedCompaction`、`_pendingThresholdCompactionAutonomousMessages.splice(0)`（**从队列里取走**）、`_queuedGoalThresholdContinuation` 全部搬进局部变量，并清 `_continueAfterThresholdCompaction`；
  2. manual compact 在 `:9973` abort ⇒ 摘要调用抛 abort ⇒ 落到 `:11566` catch；
  3. `:11567` `_clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(true, queuedAutonomous…)` → `:3813-3823` → `_clearQueuedAutonomousContinuations({restoreAutonomousState:true, messages})` → `:3784-3788` **`agent.removeQueuedMessages(...)` + `_cancelSessionActions(..., new Error("Queued autonomous continuation was cleared before delivery."))`**＝销毁，不是回队；
  4. `:11574-11582` aborted 分支再 `_clearQueuedGoalContinuationAfterCancelledThresholdCompaction(...)` → `:3753-3767` **取消 goal 续跑 action 并回滚 `continuationsUsed`**，然后 `_endCompactionUnsuccessfully(reason,"cancelled",…)` 并 **`return false`，全程不调 `resumeAfterFailure()`**（`:11485-11492` 定义的续跑恢复只在 `:11519/11594/11611` 三条路径被调）；
  5. 随后 manual A 自己压缩完成。A 的 `_compact` 走的是 manual 路径，**不知道**被它抢占的 threshold 压缩欠着一批自主续跑与一个 goal 续跑。
- 后果：用户（或 skill）在自动压缩在飞时敲 `/compact <指令>`，会**顺手把 agent 排队中的自主续跑消息和持久 goal 的下一轮续跑一起删掉**，且循环不再被恢复 ⇒ 表现为"压缩完了 agent 就停住不干活了"，goal 侧还会因为 `continuationsUsed` 回滚而看不出消耗过。
- 归因：F6 之前 manual **不** abort auto，而是 `_compact:9991-9993` 等 `_compactionOperation` 跑完 ⇒ auto 走成功路径 `:11547-11564`，`_schedulePostCompactionContinue` + 队列保留。**所以这条是 K3R-7 F6 直接引入的回归。**
- 复现配方（给施工车道；harness 现成）：`test/r26-k3r-compact-merge.test.ts` 已有"overflow 触发在飞 auto + extension 第一次挂起等 abort"的夹具，把它改成 `reason="threshold"` + `shouldContinueAfterCompaction=true` + 预置一条 `_pendingThresholdCompactionAutonomousMessages` 与一个 goal 续跑，断言：manual 抢占后 (a) 该自主消息仍在 `agent` 队列或已被投递、(b) `_queuedGoalThresholdContinuation` 未被取消、(c) 压缩后循环被 schedule 续跑。改前应红。
- 修法建议：aborted 分支里区分"用户主动 abortCompaction"与"被 manual 抢占"。被抢占时应把 `queuedAutonomousContinuationsForThisCompaction` / `queuedGoalContinuationForThisCompaction` **移交**给即将跑的 manual 压缩（挂到 `_postCompactionContinuation*` 上），或至少调 `resumeAfterFailure()` 而不是静默 `return false`。

### 3.3 顺带核过、判为**不是洞**的两条（正控）

- `abortCompaction()`（`:10267-10270`）不取消已排队的手动 compact ⇒ 用户 abort 后 B 仍会跑。核对：`abort()`（`:9393`）自己就调 `abortCompaction()`，而 `_compact:9998` 又调 `abort()`；B 的重入本来就是一次新的用户级 compact 请求，让它跑完与 `/compact` 语义一致。**记为设计选择，非缺陷**（若产品认为 abort 应连带取消队列，另开条目）。
- 三 manual 并发（A/B/C 指令互异）的排队顺序与去重：见 3.1，微任务序逐手推演无丢无锁；同指令重入命中 `:9959` 的相等分支直接 coalesce，不会重复跑。

---

## 4. 簇③ SEC-4 env 剥离 × 经 bash 拉起的产品路径

**已派子席 `r28-c3-sec4bash`（0902）独立执行**，产物 `/tmp/audit_r/round-28/cluster3-sec4-bash-paths.md`。本席在收口时点尚未收到其回执，**不在本报告里代答**（不拿子席未交付的结论当自己的结论）。

本席已独立核到的两条边界事实，供合并时对照：
1. `d6977ad29` 这一提交**只改了测试**（`test/suite/regressions/4606-update-restart-coordinator.test.ts`，+19/-1），即 4606 的断点是**用"给命令加 inline env 前缀"绕过**的，**没有改 allowlist 本身**。⇒ 生产侧的自更新协调器如果也是"经 bash 拉起 + 依赖 `PRIME_AGENT_INTERNAL_*`"，同一个断点在生产路径上仍然存在，只是没有测试覆盖它。这是簇③最该先查的方向。
2. `sanitizedChildEnv()` / `getShellEnv()`（`utils/shell.ts:146-204`）与 `mergeExecEnv`（`core/exec.ts:114-130`）是 host 侧唯一两个过滤基；任何绕过它们、直接用 `process.env` 起子进程的产品路径不受 SEC-4 影响（也就不是断点），任何**经过**它们的产品路径都在嫌疑名单里。

## 5. 簇④ SEC-2 三域 AND × settings 热重载

**已派子席 `r28-c4-sec2reload`（0902）独立执行**，产物 `/tmp/audit_r/round-28/cluster4-sec2-hotreload.md`；收口时点其测试文件 `sec2-hotreload-audit.test.ts`（17,802 B）已落 `/tmp/audit_r/round-28/`，回执未到，同样不代答。

## 6. 交付物与复现清单

| 产物 | 路径 |
|---|---|
| 本报告 | `/tmp/audit_r/round-28/0902-final.md` |
| 簇① 红绿测试（5 用例：C1-A/C1-B/C1-C/C1-D 红 · C1-A-control 绿） | `/tmp/r28_0902_own/r28-cluster1-interaction.test.ts`（已 copy 进 wt_head / wt_base 两树，见第 13 节） |
| 簇② 算法级红证脚本 ×2 | `/tmp/audit_r/round-28/cluster2_short_m1.mjs`、`cluster2_preview_freeze.mjs`（`node` 直跑，无依赖） |
| 簇③④ | 子席产物（见第 4/5 节） |

复现命令（全部 ≤60s，泄露 env 已 unset）：

```
cd /tmp/wt_r28/packages/coding-agent && env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_CHILD_ID -u RLM_MAX_DEPTH \
  -u PRIME_AGENT_DIR -u PRIME_AGENT_SESSION_DIR -u PI_API_KEY \
  -u PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR -u RLM_PARENT_NODE_ID -u RLM_CHILD_IDS \
  -u RLM_PARENT_SESSION_DIR -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN \
  node ../../node_modules/vitest/dist/cli.js --run test/session-manager/r28-cluster1-interaction.test.ts
# d6977ad29 → 2 failed / 1 passed ；同命令在 /tmp/wt_r28_base（23e9a8e8e）→ 3 passed
node /tmp/audit_r/round-28/cluster2_short_m1.mjs
node /tmp/audit_r/round-28/cluster2_preview_freeze.mjs
```

## 7. 优先级建议（交母席/老板裁）

| 洞 | 严重度 | 理由 |
|---|---|---|
| **①-D 两个并发子代理 ⇒ 盘上 dangling parentId、重载后模型上下文归零** | **P0（最高，见第 12 节）** | 只需两个 child 并发流式 + 一次 graceful flush；重启/attach/resume 即失忆而转录表面完好；并行派活是本仓标准形态；红@HEAD/绿@base，另席真实序列重放独立复现 |
| **①-C 压缩条目被合并归因行绕过 ⇒ 已压缩历史复活** | **P0/P1** | 一次普通压缩落在 ≤120s 归因窗口内即触发；重启后压缩静默失效、长会话直接撞 overflow；LAT-3 引入，红@HEAD/绿@base（见第 9 节） |
| ①-B 归因合并行跨 leaf 移动拼错链 | **P1** | 重启后**用户消息从模型上下文消失**、UI 无差别；触发面含"压缩 + 子代理流式"这一常态组合；LAT-3 引入 |
| ⑤-A manual 抢占销毁自主/goal 续跑 | **P1** | 用户一次 `/compact` 就能删掉排队工作与 goal 续跑且循环不恢复；K3R-7 F6 引入 |
| ②-A preview 跨消息残留乱码 | P2 | 影响面是 roster/`rlm.collect()` 的可见判活信号（母席巡工件正是读它），整条消息期间错；LAT-2 引入 |
| ①-A agent_status 去重不分支感知 | P2 | rewind 后 recap/needs_input 丢失，重启后放大；LAT-3 引入 |
| ⑤-1 第二套 compact 指令仍不被 honored | P3 | K3R-7 F7 应从 fixed 改记 **partially fixed** |
| **③-P1 自更新打错 daemon + origin 会话收不到 update_complete** | **P1** | 4606 的生产版一处没修；`package-manager-cli.ts:420-422` 静默回落默认 socket（本席亲核载荷）；见 §14 |
| **③-P3 SEC-1 × SEC-4 互相抵消** | **P1** | SEC-1 把门改走 `backgroundNetworkOptOut()`，SEC-4 把 DNT/PI_OFFLINE 剥掉 ⇒ 嵌套 CLI 里隐私 opt-out 恒失效（本席亲核 + 升级定性）；见 §14.4 |
| ③-P2 agentDir/sessionDir 钉子丢失 | P2 | 嵌套 CLI 打错目录、报 no sessions、可能再起第二个 daemon；见 §14 |
| ③-P4~P9 allowlist 缺项 / 两表不一致 / 透传口子零文档 | P2-P3 | 唯一逃生口 `PRIME_AGENT_ENV_PASSTHROUGH` 全仓 .md 命中数＝1（本席亲核）；SEC-4 应改记 partially fixed |

## 8. 纪律自证

主仓零写入（只在 `/tmp/wt_r28`、`/tmp/wt_r28_base` 两个 detached 工作树内加临时测试文件，且均已列明路径）；未 `git add`/`commit`/`push`；未用 `doctor --fix`、`daemon ps -k`、`--no-verify`；测试分批 1 文件、单命令 ≤60s；跑测试全量 unset 泄露 env、直接 `node` 调 vitest；与 `docs/fork/audits/decisions.jsonl` 去重（本文所有条目均为"已 fixed 条目的跨修复交互回归"，不与既有 LAT-1/2/3、K3R-7、SEC-2/4 任一条目重复；建议在 decisions.jsonl 新开 LAT-4/LAT-5/K3R-11 三条而非改判旧条）。


---

## 9. 追加（收口后补测，**本审计最重的一条**）：洞 ①-C ＝ ①-B 的常态触发实例，压缩条目在重载后被绕过 ⇒ 已压缩掉的历史整卷回到模型上下文

补测动机：核对 ①-B 的触发面时，我先误判"压缩走 `branchWithSummary`"。逐字复核后修正为：**压缩走 `appendCompaction`（`session-manager.ts:2484-2516`），常态分支 `targetLeaf === this.leafId` ⇒ `_appendEntry(entry)` ⇒ `leafId` 前进到 compaction 条目**（`:2511` + `:2400-2404`）。也就是说压缩**本身就是一次 leaf 前移**，落进 LAT-3 归因合并窗口就会踩 ①-B 的同一条机理——而且**不需要用户 rewind**。

- 机理：窗口内 `pending.firstParentId` 捕获于压缩**之前**的条目；压缩条目落盘并把 leaf 推到它自己；窗口内后续 merge 在内存里挂在压缩条目之下（`:2550 parentId = this.leafId`），但冲刷行的 `parentId` 仍是 `firstParentId`（`:2609`）⇒ 磁盘上这行的父指针**跳过压缩条目**。重载时 `_buildIndex`（`:2162-2180`）按文件顺序推进 leafId，最后一行（合并归因行）胜出 ⇒ `leafId = 合并行.id`，其 parent 链是 `attr1 → assistant(target) → …→ header`，**compaction 不在链上**。
- 打穿输入（已执行，`test/session-manager/r28-cluster1-interaction.test.ts` C1-C）：
  1. `target = appendMessage(assistant("parent turn"))`；
  2. `appendChildUsageAttribution(target,…)` ×2（第 2 条进 pending，`firstParentId` 捕获于压缩前）；
  3. `appendCompaction("summary of everything above", target, 5000)`（一次普通压缩）；
  4. 子代理继续流式 ⇒ 第 3 次 `appendChildUsageAttribution(target,…)`；
  5. `flushChildUsageAttributions()`（生产中由 `agent-session.ts:14549` 在 child run 的 finally 里调）；
  6. 重开文件 ⇒ `reloaded.getBranch(reloaded.getLeafId())` 的 type 序列。
- 实测结果：
  - @ d6977ad29：**红** `AssertionError: expected [ 'message', …(2) ] to include 'compaction'`（重载后活动分支 = `message, message, child_usage_attributed`，**无 compaction**）
  - @ 23e9a8e8e（LAT-3 前）：**绿**（4/4 全绿）
- 后果：`buildSessionContext()` 以活动分支为输入，分支上没有 compaction 条目 ⇒ **压缩摘要不生效、被压缩掉的整段历史全部重新进入模型上下文**。表现为重启/attach 之后 token 用量与上下文长度突然回到压缩前，长会话直接撞 context overflow；转录文件里那行 compaction 还在，所以从文件表面看不出任何异常（静默）。
- 触发面：**一次普通压缩（threshold / overflow / 手动 `/compact`）落在子代理归因合并窗口内**。窗口是 ≤32 条子消息或 ≤120s（`CHILD_USAGE_ATTRIBUTION_COALESCE_MAX_MERGES` / `..._MAX_AGE_MS`），而"长会话里子代理持续流式 + 触发自动压缩"正是 LAT-3 报告自己用来立论的那个 103MB/101,481 行会话的日常形态。⇒ **不是罕见竞态，是常态路径。**
- 严重度：**P0/P1（本次审计最高）**。①-B 的 rewind 版是"丢一条用户消息"，①-C 的压缩版是"整卷已压缩历史复活 + 压缩功能静默失效"。
- 修法：与 ①-B 同一条最小修法即可同时封死两者——**在 leaf 会移动/前进的写入口之前先冲刷归因窗口**：`_setLeaf()`、`branchWithSummary()`、`appendCompaction()`（`_appendEntry` 之前）各加一次 `this.flushChildUsageAttributions()`。更稳的做法是从根上取消"磁盘 parentId 与内存 parentId 可以不同"这个自由度：让 `pending.firstParentId` 在每次 `leafId` 变化时失效（等价于就地冲刷重开窗口）。
- 回归护栏建议：C1-C 这条断言（"重载后活动分支的 type 序列 === live 的 type 序列，且含 compaction"）应作为 LAT-3 的常驻回归，任何后续写侧合并优化都要过它。


---

## 10. 簇④ SEC-2 三域 AND × settings 热重载（子席 `r28-c4-sec2reload` 交付，本席复核采纳）

产物：`/tmp/audit_r/round-28/cluster4-sec2-hotreload.md`（21,043 B）+ 红证/正控测试 `sec2-hotreload-audit.test.ts`（11/11 绿，1.3s；仓内零残留）。

**对提问"改设置文件运行时还会被项目翻吗"的直接回答：不能——声明式路径打不穿。**
- getter 读的是原始 `this.projectSettings` 而非 merged `this.settings`，"项目域只能关不能开"成立。
- 正控 A1：运行中 watcher（20ms）加载新建的项目 `{"agentTraces":{"enabled":true}}`，`getProjectSettings()` 确实读到 `true` 而闸门仍 `false`；末尾正控：同形状写进**全局**域即翻 `true`（证明夹具真驱动该路径）。
- A2：13 种敌意形状（boolean/string/number/array/null/大写键/驼峰顶层键/深嵌套/telemetry 别名/`__proto__`/`constructor.prototype`/空对象）逐个热 reload 后仍 `false`，并断言无跨域渗血。
- 三域缓存无一域是构造期快照；`reload()` 每次重读 global+project，runtime 域不重读也不清零（C1 正控）。
- runtime 域谁能改：**只有 `applyOverrides`（:1160），src 内零调用者**（仅 test/utilities.ts、3 个测试、examples/sdk）⇒ 生产恒默认 true，"三域"实为 global AND project。其余入口逐条排除（slash 仅用户手打 `/traces` 且写全局域；daemon 无 traces 命令；MCP 不持有 settingsManager；extension 拿不到该对象；env 只能关不能开；CLI 无 dotenv；`inMemory()` 生产不可达且它把参数塞进全局域 ⇒ 60+ 既有 agent-traces 测试都不经过项目腿）。
- 常驻 writer **不是**"装配只读一次"，优于 telemetry：每条自动上传腿查 3 次（`agent-traces.ts:1257` schedule、`1074` 读正文前、`1163` 发请求前），且 `isAutomaticUploadEnabled` 先 `await settingsManager.reload()`（`961-964`）⇒ 热关立刻生效。B1 正控把 watcher interval 设 600s 永不触发、内存 getter 仍陈旧 true，上传仍返回 disabled；D1 正控 debounce(1s) 途中改 false → 0 次出网。对照 `telemetry.ts:591-594` 只在装配时查一次（U4 那条病 agentTraces 没有）。

**但找到 3 条真洞 + 1 条设计层残余（子席红证，本席采纳）：**

| 编号 | 严重度 | 内容 | 红证 |
|---|---|---|---|
| **R1** | **中高** | **撤回同意这条路 fail-open**：`reload()` 对每域是"读到才替换、读不到就保留上一次成功解析的对象"（`:1030-1037/:1044-1051`）。用户手改全局 settings 撤回同意但 JSON 写坏（尾逗号等）⇒ `getAgentTracesEnabled()` 仍 `true`，下一次自动上传**照发**；解析失败进 `errors` 而该腿无人 drain/展示；更糟：`reloadExternalEdit`（`:1141-1157`）的 `reload()` 不抛，于是照样 `recordWarning("settings.json changed on disk … reloaded into this session")` ⇒ **对用户谎报"你的修改已生效"，实际生效的是旧同意**。同机制在 project 腿恰好安全（A4：veto 文件写坏 → 保留旧 veto → 闸门仍关），但 veto 文件被**删除**即重开。修法：同意类闸门在对应域解析失败时 fail-closed。 | A3（getter 仍 true）+ **B3 用注入 transport 抓到第 2 次 PUT `status="uploaded"`（真实出网）**，并断言 warning 与 getter 仍 true 并存 |
| **R2** | 中 | **项目 veto 只在精确 cwd 生效，无祖先回溯**（`settings-manager.ts:746`）。全局 true + 仓库根 veto：`create(repoRoot)`→false，`create(repoRoot/packages/app)`→**true**。真实可达：daemon 每会话用 `cwd: sessionManager.getCwd()` 建 runtime（`daemon-mode.ts:1695-1703, 1870-1871, 2666-2667`），子目录起会话/resume 记录子目录 cwd ⇒ 仓库级 veto 被静默跳过。对照：skills 是会走祖先的（`package-manager.ts:2362-2364`）⇒ 本仓有先例。修法：project 腿沿祖先收集所有 `.prime/agent/settings.json`，任一 `enabled:false` 即 veto。 | A5 |
| **R3** | 低中 | `reload()` 重算 `this.settings` 时没再叠 `runtimeOverrides`（`:1053` vs `:1161-1162`）⇒ 一次外部手改就把 CLI/SDK 的运行时覆盖从 merged 视图静默回滚。**不影响本闸门**（闸门不读 merged），但影响**所有读 merged 的 getter**。 | C1（用 theme 证明 light→dark） |
| **R6** | 残余（设计层，需裁） | 三域 AND 只挡**声明式**项目输入：(a) 项目域 extension 默认启用自动发现（`package-manager.ts:2380-2386` + `isEnabledByOverrides:746-752` 起于 `enabled=true`）⇒ 仓库代码可自己写全局 settings 或直接 `requireEnabled:false` 上传；(b) `src/core/tools/` 对 agentDir 无写保护 ⇒ 提示词注入可让模型把 `{"agentTraces":{"enabled":true}}` 写进**全局**文件，watcher/reload ~1s 内照单全收；(c) `/traces upload*` 的 `requireEnabled:false` 同时绕过 DO_NOT_TRACK；(d) daemon create 的 `config.agentDir` 决定全局腿读哪个目录（socket 0o600，同用户内）。 | — |
| R5 | 低 | `stopWatchingExternalSettings` src 零调用者 ⇒ 每会话两个 `watchFile` listener 常驻，长命 daemon 里 N 个 SettingsManager 被 watcher 引用不释放（泄漏/延迟账，可挂到 LAT 线）。 | — |

回归基线（同环境同跑法，排除假绿/假红）：`settings-agent-traces-gate` 4/4、`settings-deep-merge-and-watch` 4/4、`agent-traces` 54/54 全绿。

**与本次三批的交互定性**：SEC-2 的修复本身在热重载面上是**站得住的**（提问担心的"运行时被项目翻"证伪）；R1/R2 是 SEC-2 修复**没有覆盖到的相邻面**（撤回同意的 fail-open、veto 的作用域），不是 SEC-2 与其他批次的交互回归。R5 与本审计的 LAT 线（延迟/泄漏）同源，建议合并记账。

## 11. 簇③ 状态（**已被第 14 节取代**，保留原状以存证收口时点）

子席 `r28-c3-sec4bash` 在本报告定稿时点仍 `running`（`rlm.collect` 快照），产物 `cluster3-sec4-bash-paths.md` 尚未落盘。**不代答**；回执到达后另发追加消息并补写本节。本席已独立给出的两条线索见第 4 节（尤其：`d6977ad29` 只改测试、allowlist 未动 ⇒ 生产侧自更新协调器的同类断点可能仍在）。


---

## 12. 追加二（**P0**）：洞 ①-D ＝ 两个并发子代理即可触发，重载后模型上下文归零

补测动机：`/tmp/audit_r/round-28/` 是共享产物目录，另一条车道（GLM 数据持久化席，心跳工件 `glm-scan-data.heartbeat`、复现脚本 `repro_lat3.ts`＋`red_proof/`）在同一时点独立报告：真实 18,053 行 attr 序列的 LAT-3 重放 ⇒ **1223-1359 个 dangling parentId（含 message 条目）**，"R1 graceful-flush interleaved targets ⇒ dangling chain + ctx messages 2→0 (P0)"。本席不采信他席自报，自行独立构造复现，结论一致。

- 位置：`session-manager.ts:2564-2592`（`pending.firstParentId` 捕获）× `:2603-2624`（冲刷行 `parentId = pending.firstParentId`、`id = pending.lastId`）
- 机理（**不需要 rewind、不需要压缩、不需要崩溃，只要两个子代理并发流式**）：两个 target 的 merge 交错 ⇒ `leafId` 在 A、B 的内存归因条目之间来回跳。A 的窗口在 `merges===0` 时捕获的 `firstParentId = entry.parentId = this.leafId`，而那一刻 leafId 往往指向**B 的一条被合并掉、从未落盘的内存条目 id**。A 的冲刷行于是带一个盘上不存在的 parentId ⇒ dangling。`_buildIndex`（`:2162-2180`）逐行把 leafId 推到最后一条，`buildSessionContext` 从该 leaf 沿 parentId 上溯 ⇒ **在 dangling 处断链**。
- 打穿输入（已执行，用例 C1-D）：`targetA = appendMessage(assistant("turn A"))`、`targetB = appendMessage(assistant("turn B"))`；40 轮交替 `appendChildUsageAttribution(targetA,…,"spawn_task")` / `(targetB,…,"agent_message")`；`flushChildUsageAttributions()`（生产中就是 `agent-session.ts:14549` 的 child-run finally）；重开文件。
- 实测结果（把断言合并成一行以拿到全部数值）：
  ```
  AssertionError: expected 'live=2 reloaded=0 dangling=2' to be 'live=2 reloaded=2 dangling=0'
  ```
  ⇒ 磁盘上 2 条 `child_usage_attributed` 的 parentId 悬空；**live 会话模型上下文 2 条消息，重载后 0 条**。文件里两条 assistant 消息都还在，只是链断了、走不到。
- 归因：@ d6977ad29 **红**；@ 23e9a8e8e（LAT-3 前）**绿**（5/5 全绿）。
- 后果定级 **P0**：`SessionManager.open()` 是所有 restart / `--resume` / `attach` / daemon 会话恢复 / `buildSessionContext()` 的入口。重载后上下文归零意味着**一次进程重启就把整个会话的模型上下文清空**，而转录文件表面完好（消息行都在，只是 parent 链断）⇒ 用户看到的是"agent 失忆但转录看起来正常"。触发条件是"两个子代理并发流式"——**这正是本仓并行派活车道的标准工作形态**，也是 LAT-3 报告用来立论的那个 103MB 会话（288 个 distinct targetId、56,622 条归因）的形态。GLM 席在真实序列上重放出 1223-1359 个 dangling，说明现网历史转录里已经存在这种破损。
- 与 ①-B/①-C 的关系：三者同根——**LAT-3 让"磁盘 parentId"与"内存 parentId"可以不同，而 `firstParentId` 的捕获点没有任何"该 id 必须已落盘"的约束**。①-D 是"另一个 target 的未落盘 id"，①-C 是"压缩条目插队后指向压缩前"，①-B 是"leaf 移动后指向废弃分支"。
- 修法（一条封死三者）：`_flushPendingAttributionWrite` 的冲刷行 parentId 必须取**盘上确实存在的 id**。最小改法：把 `pending.firstParentId` 的捕获从"merge 时的 leafId"改成"该 target 上一条**已落盘**的条目 id"（首条即写时用首条的 id，其后每次冲刷用刚写出的那条合并行 id——即 re-seed 时 `pending.firstParentId = pending.lastId` 而不是 `null`，并且 merge 时不再重捕）。这样 parentId 永远指向同一 target 的已落盘链条，与 leafId/其他 target/压缩/rewind 全部解耦。
- 回归护栏建议（三条断言应常驻）：① 盘上不存在 dangling parentId（全类型）；② `buildSessionContext(reloaded)` 的消息数与 live 相等；③ 重载后活动分支 type 序列 === live 序列且含 compaction。


---

## 13. 复现路径更新 + 一起共享目录破坏事件（必读）

**复现路径已迁移**（原 `/tmp/wt_r28`、`/tmp/wt_r28_base` 两个 git worktree 在本席收口期间被外部清除，`git worktree list | grep r28` 现为空）。现用 `git archive` 提取的独立目录，**不再注册 git worktree**，因此不受 `git worktree prune` 影响：

- HEAD 树（d6977ad29）：`/tmp/r28_0902_own/wt_head`
- 归因树（23e9a8e8e，LAT-3 落地前一提交）：`/tmp/r28_0902_own/wt_base`
- 测试文件（两树同内容，可移植）：`/tmp/r28_0902_own/r28-cluster1-interaction.test.ts`
  （已分别 copy 进两树的 `packages/coding-agent/test/session-manager/`）

重建后**重新跑过一遍完整归因**，结论与初跑一致：

| 树 | 结果 |
|---|---|
| `/tmp/r28_0902_own/wt_head`（d6977ad29） | **4 failed / 1 passed**（C1-A、C1-B、C1-C、C1-D 红；C1-A-control 绿） |
| `/tmp/r28_0902_own/wt_base`（23e9a8e8e） | **5 passed** |

⇒ 四条洞全部为 **LAT-3（`b35288b82`）引入**，无一条是预存项。（C1-B 里那句归因行数断言已放宽为 `toBeGreaterThanOrEqual(2)`，使同一文件在两树都可跑；放宽前它在 base 上会以 `expected 3 to be 2` 假红，已排除。）

复现命令（`{d}` 换成上面两个目录之一；≤60s；泄露 env 全 unset；直接 node 调 vitest）：

```
cd {d}/packages/coding-agent && env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_CHILD_ID -u RLM_MAX_DEPTH \
  -u PRIME_AGENT_DIR -u PRIME_AGENT_SESSION_DIR -u PI_API_KEY \
  -u PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR -u RLM_PARENT_NODE_ID -u RLM_CHILD_IDS \
  -u RLM_PARENT_SESSION_DIR -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN \
  node ../../node_modules/vitest/dist/cli.js --run test/session-manager/r28-cluster1-interaction.test.ts
node /tmp/audit_r/round-28/cluster2_short_m1.mjs
node /tmp/audit_r/round-28/cluster2_preview_freeze.mjs
```

### 破坏事件（纪律事故，报母席）

02:37 前后，`/tmp/audit_r/round-28/` 被**外部整体清空并重建**（目录内所有文件 mtime 齐刷刷变成 02:37，包括本来 02:28-02:31 就存在的他席文件），被删掉的有：

- 本席 `0902-final.md`（24 KB，含 §1-§11）、`cluster2_short_m1.mjs`、`cluster2_preview_freeze.mjs`
- 子席 `r28-c4-sec2reload` 的 `cluster4-sec2-hotreload.md`（21 KB）与 `sec2-hotreload-audit.test.ts`（17.8 KB，11/11 绿）
- 他席 `0902-partial-handoff.md`

同一时间窗内 `/tmp/wt_r28`、`/tmp/wt_r28_base` 两个 git worktree 被删除且注册被 prune（`git worktree list | grep r28` 为空）。

本席处置：所有产物内容都还在 kernel 变量里，已**逐字重建**并另存到私有目录 `/tmp/r28_0902_own/`（不再依赖共享目录），再 copy 回 `/tmp/audit_r/round-28/`；红绿证据在新目录上**重新实跑**确认（见上表）。**子席 c4 的两份产物无法由本席重建**（其测试文件与 21 KB 报告正文只在它自己的会话里），本席 §10 的摘要是唯一存留副本——如需完整原文，请让母席要求 c4 席重写一遍。

建议记一条纪律：`/tmp/audit_r/round-NN/` 是多席共享产物目录，任何车道不得 `rm -rf` 整个目录或删他席文件；清理只允许删自己命名的文件。`git worktree` 同理——`git worktree prune` 会连带他席在用的注册一起清掉，跨席清理前必须先 `git worktree list` 点名核对。


---

## 14. 簇③ SEC-4 env 剥离 × 经 bash 拉起的产品路径（子席 `r28-c3-sec4bash` 交付，**本席逐条抽核采纳**）

产物：`/tmp/audit_r/round-28/cluster3-sec4-bash-paths.md`（257 行 / 35,913 B）；私有权威副本 `/tmp/r28_c3_own/`（报告 + 4 个探针脚本 + 7 个 log，含 `/tmp` 被清后用 `git archive d6977ad29` 只读重建导出**复跑一遍、结果逐字一致**的 `REPRO_after_tmp_sweep.log`）。基线 d6977ad29，行号已核与 HEAD 40f781578 同内容。

### 14.1 剥离面（子席枚举，本席复核 allowlist 原文一致）

`utils/shell.ts:146-167` 的 `SHELL_CHILD_SAFE_ENV_KEYS` **只有 19 个键**（HOME/PATH/SHELL/USER/LOGNAME/LANG/LC_ALL/LC_CTYPE/TZ/TMPDIR/TEMP/TMP/SystemRoot/WINDIR/COMSPEC/PATHEXT/OS/SYSTEMDRIVE/USERPROFILE），kernel 侧 `bash.py` 同表。被过滤的 spawn 点共 9 个：host `tools/bash.ts:105`、`bash.ts:163→472`、`exec.ts:153`；kernel `bash.py:201,209,851,876,898`。**通道很窄，但产品自己的 CLI 正好走这条通道。**

### 14.2 生产断点 P1–P9（子席结论；本席已亲自核 P1/P3/P4/P8 的载荷代码，见 14.3）

| 编号 | 断点 | 载荷 |
|---|---|---|
| **P1** | **自更新打错 daemon + origin 会话收不到 `update_complete`——4606 的生产版，一处没修** | `package-manager-cli.ts:420-422` `resolveUpdateDaemonSocketPath` 读 `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET`，**静默 `?? defaultDaemonSocketPath()` 回落**；`:1845` 与 `daemon-update-restart.ts:548` 读 `..._WORKER_ACTIVE_SESSION_ID` |
| **P2** | agentDir/sessionDir 钉子丢失 → 嵌套 CLI 全线打错目录，报 ENOENT/"no sessions"，或**再起第二个 daemon** | `config.ts:801/:983` → `daemon-agent-endpoint.ts:33-52`（`main.ts:1417`、`daemon-command.ts:148`、`daemon-launch.ts:703`）、`daemon-ps.ts:995`、`daemon-stop-scope.ts:116`、`doctor-checks.ts:48-56` |
| **P3** | **文档化的隐私 opt-out 在嵌套 CLI 里静默失效**（仓内注释自称"忽略它们就是 bug"） | `utils/privacy-opt-out.ts:47-56` + `telemetry.ts:192/195/198` + `agent-traces.ts:951,1254`（DO_NOT_TRACK / PI_OFFLINE / PRIME_AGENT_TELEMETRY 全被剥） |
| P4 | 代理变量丢失 → 会话内 `update` 的 npm 直接失败 | HTTPS_PROXY 等不在 19 键表内 |
| P5 | `DAEMON_CLIENT_ENV_KEYS`（HERDR_*）**只在 `exec.ts` 生效、bash 工具不生效**——双通道语义不一致 | `daemon-protocol.ts:436-441` / `daemon-client-env.ts:30` vs `loader.ts:268` |
| P6 | kernel 解释器 / venv / 下载源钉子丢失 | `PRIME_AGENT_KERNEL_PYTHON` / `_VENV` / `_DOWNLOAD_BASE_URL` |
| P7 | **`RLM_DEPTH` 断代**——递归纵深天花板不再约束 bash 起的谱系（纵深防御退化） | RLM_* 全剥 |
| P8 | **两张表不一致**：host 侧无 `TERM`，kernel 侧钉 `TERM=dumb` | `shell.ts` vs `bash.py` |
| P9（次要） | `PRIME_AGENT_BUILD_ID` / `_LAUNCHER_PATH` 丢失 → 运行时身份漂移 | `daemon-runtime-identity.ts:14-23` |

### 14.3 本席独立抽核（不采信自报）

- **allowlist 原文**：亲自读 `utils/shell.ts:140-205` ⇒ 19 键确认，**表内无 HTTPS_PROXY、无 TERM、无 DO_NOT_TRACK/PI_OFFLINE、无 PRIME_AGENT_INTERNAL_*、无 RLM_***；`sanitizedChildEnv()` 的唯一逃生口就是 `PRIME_AGENT_ENV_PASSTHROUGH`。P4/P8 结构成立。
- **P1 载荷**：亲自读 `package-manager-cli.ts:420-422` ⇒ `explicitSocketPath ?? process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] ?? defaultDaemonSocketPath()`，**静默回落确认**；`:1845` ⇒ `originActiveSessionId: process.env[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV]`，确认。两个 env 名都属 `PRIME_AGENT_INTERNAL_*` ⇒ 必被剥 ⇒ 断点成立。
- **P3 载荷**：亲自读 `utils/privacy-opt-out.ts:47-56` ⇒ `backgroundNetworkOptOut(env = process.env)` 逐个读 `DO_NOT_TRACK_ENV` / `PI_OFFLINE_ENV`，确认。
- **透传口子无文档**：亲自 `grep -rn PRIME_AGENT_ENV_PASSTHROUGH --include='*.md'` 全仓 ⇒ **命中数 1**，只有 `packages/coding-agent/.changes/r27-sec-env-auth.md`；README / docs/settings.md / docs/security.md **全无** ⇒ 唯一逃生口对用户不可见，确认。

### 14.4 本席补充定性：**P3 是一条真正的 SEC-1 × SEC-4 跨修复互相抵消**（子席未这样框定，本席裁定升级）

r27 的 **SEC-1**（`b2dd7bf8b`）把 `startup-notices.ts` 的 `checkForPackageUpdates` 从"只认 `PI_OFFLINE` 且真值判断"改成**统一走 `backgroundNetworkOptOut()`**，让 DNT=1 与 PI_OFFLINE∈{1,true,yes} 都能挡住启动期扩展更新检查。
r27 的 **SEC-4**（`a2590d038`）把 `DO_NOT_TRACK` / `PI_OFFLINE` 从 bash/exec 子进程 env 里**剥掉**。
⇒ 在"会话 shell 拉起产品自身 CLI"这条路径上（模型 bash 工具 / 用户 `!` / RPC `execute_bash`，也正是 P1 自更新走的那条），**SEC-1 修好的那道门被 SEC-4 拆掉了门框**：嵌套 CLI 里 `backgroundNetworkOptOut()` 恒返回 `undefined`，启动期扩展更新检查照跑、telemetry/agent-traces 的 opt-out 同样失效。两条同批安全修复在交叠面上互相抵消，属本次终审最该记的一条"跨批次交互"。修法：把 `DO_NOT_TRACK` / `PI_OFFLINE` / `PRIME_AGENT_TELEMETRY` 这三个**非机密的opt-out 名**加进两张 allowlist（它们只表达"别出网"，泄漏无价值），即 SEC-4 的机密边界不受影响而 SEC-1 的门恢复。

### 14.5 红证 / 正控 / 负结论（子席执行，本席核其日志在盘）

- **红证**（跑两遍，第二遍在 `/tmp` 被清后用 `git archive d6977ad29` 只读重建的导出上复跑，逐字一致）：同一父 env、同一命令，**直连子进程 vs 走生产 `createLocalBashOperations`→`getShellEnv()`** ⇒ `broken_count=11`（含 4606 那个变量），而 `SERPER_API_KEY` / `SSH_AUTH_SOCK` 仍 OK-stripped（证明剥离本身有效）；加 `PRIME_AGENT_ENV_PASSTHROUGH`(12 名) ⇒ **`broken_count=0`**。出厂 CLI `prime-agent doctor --json` 端到端 ⇒ **DIVERGENT**：(a) 读沙箱 agentdir + 认 kernel python 钉子；(b) 读 `$HOME/.prime/agent` + 钉子消失。日志：`probe_direct_vs_bashtool.log` / `probe_passthrough.log` / `e2e_doctor.log` / `REPRO_after_tmp_sweep.log`。
- **正控三层**：① `drive_poscontrol.mts` 用生产 bash 通道跑 4606 fixture ⇒ pre-fix 形状 exit 1 且报 `Missing PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID`，fixed 形状 exit 0（证明该方法确实能检出断点）；② `4606-update-restart-coordinator.test.ts` 5/5 绿(11.2s)；③ `exec-env-filter.test.ts` 3/3 绿。
- **负结论（无断点，附扫过的调用链）**：doctor 只读检查 0 spawn；**无 worktree 工具**（`git.ts:251` 全量 env）；`install.sh`/`prime-agent.sh`/`scripts/*` 跑在用户 shell 不经剥离面；MCP stdio 无断点（`mcp.py:28` `_SAFE_ENV` 只 7 键、无 passthrough，但凭据走配置 `{"env":NAME}` 显式引用，`:604-620`）；kernel/worker/supervisor 的全部 spawn 未过滤（`repl-manager.ts:959-970` 的"刻意不动"已核实、不受 `shell.ts` 影响；in-kernel skills 的 `PRIME_AGENT_CODING_AGENT_DIR` 读点安全）。

### 14.6 两条要老板/母席裁的（子席提出，本席同意）

1. **SEC-4 不是"对模型的机密边界"**：ipython kernel 进程本身是全量 env（子席实测同一 kernel 内 `os.environ` 见 17 个 `PRIME_AGENT*`/`RLM_*` 名，含 WORKER_TOKEN；其 `bash()` 子进程见 0 个）⇒ 模型可以在 kernel 里读出来再显式拼进命令行。这与 r27 SEC-4 报告自己的定位一致（"在最后一跳切断四跳链"、"worker/kernel 进程自身 env 不动"），但**对外文档若把它写成机密边界就是过度承诺**。建议 `docs/security.md` 明确表述为"防被动泄漏 / 防被执行的第三方代码顺手读走"，而非"防模型"。
2. **`PRIME_AGENT_ENV_PASSTHROUGH` 是唯一逃生口却零文档**（本席 grep 确认全仓 .md 命中数 1，只在 changelog fragment）⇒ P1–P9 全部只能靠用户自己猜出这个变量名来自救。建议进 README + `docs/settings.md` + `docs/security.md`。

修复建议 A–F 见子席报告 §8（A：两张表补 12 个**非机密**运行名；B：HERDR_* 单一真源；D：update 不静默回落 socket）。

### 14.7 与本次三批的交互定性

簇③ 的 9 条里，**P3 是真跨批次交互（SEC-1 × SEC-4 互相抵消，本席升级，见 14.4）**；P1/P2/P5/P6/P7/P9 是 SEC-4 单批的**未覆盖面**（4606 只修了测试、生产同形状读法一处没修）；P4/P8 是 allowlist 键表本身的缺项与两表不一致。⇒ 建议 decisions.jsonl：SEC-4 从 `fixed` 改记 **partially fixed**，新开 SEC-7（P1 自更新生产断点，P1 级）、SEC-8（P3 SEC-1×SEC-4 抵消，P1 级）、SEC-9（P2 agentDir 钉子丢失，P2 级），P4–P9 合并为 SEC-10（allowlist 键表补全 + 两表对齐 + 透传口子文档化，P2/P3）。
