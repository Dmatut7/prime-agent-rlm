# r41 终审（0902 席）· 今夜全推送范围端到端 diff 复核

- 范围：`b7f26e98b02a2cb3b4089e66b185f0ca8d0d2f70`..`eb0825e634b0df63842bfc63c246151efc72ea37`（HEAD, merge/repl-kernel = origin/HEAD）
- 实际规模：**92 个提交**（母席简报写"约 30+"，实际含 r29→r41 全部批次；`git log --oneline b7f26e98b..HEAD | wc -l` = 92），177 文件，+13074/−735（`git diff --stat`）
- 时间跨度：2026-09-16 03:41 → 11:54（+0800）
- 方法：只读（`git status` 与开局一致，仓内零写入；临时物在 /tmp/audit_r/round-41/final-work*）。我主审①跨簇不变量并复核子线关键结论；②③④派 4 条子线并行（render-chain / artifact-del / testdebt / resid-runs）+ 1 条打穿实证线（punch-fence）。
- 子线交付：artifact-del 已交（本报告已独立复核其头号结论）；render-chain / testdebt / resid-runs / punch-fence 收口时仍在跑，结果在 §5 占位，收到后追加。

---

## 1. 结论（一句话）

**本批不能按"全绿"口径收口。** 今夜各簇单点修法大多方向正确，但**跨簇共享不变量出现三处相互矛盾的新雷**：
(a) "可重试"在 r39 是 typed 字段、在 r40 是 instanceof 清单 ⇒ K3Q-3 声称闭合的"最硬边（once 任务撞窗口被当跑过）"在**栅栏支路与普通 abort 悬挂支路仍然开着**；
(b) r40 新增的 5s defer 自旋**无次数上限、骑在未 unref 的墙钟定时器上** ⇒ 把"烧一次 run"换成了"永不完成的自旋 + 事件循环被挂住 + 每 5s 重写 store"；
(c) 同一个提交 `14a4e8811` 里，python 版本闸改成 fail-closed（L8D-1），而信任闸把 `fromRelationship === undefined` 当"用户原话"放行（K3L-2）⇒ "unknown ⇒ fail closed" 这条本批自己的原则在信任面上被反着用，且 wire 加字段无 capability gate / 无 revision bump，混版期静默 fail-open。
另：用户可感知的删除链上，**7 天 residue 类击穿 30 天 child-transcript 承诺**（子线探针实证 + 我独立复核代码为真）；时钟簇 TC-1/2/3 在本批**只有文档、无修复**（HEAD 复核 clamp 全在场）。
子线收口后追加两条同级结论（详见 §7）：
(d) **渲染链的"每帧 O(可见行)"不成立**——增量 lex 只压词法，`markdown.ts:401` 的 blockCache 键构造每帧仍复制+哈希全文每个顶层块的 raw，实测占单帧 46~52%（0.64/2.41/4.83ms @200k/800k/1.6M）；且该键**漏了渲染期全局能力 `getCapabilities().hyperlinks`**（`markdown.ts:745`），能力翻转后链接块永久输出退化形、并被 `tui.ts:1725` 指针快路径当未变前缀复用 ⇒ 不会自我纠正（P1，有复现 + 正控；生产触发路径未验证，因 `setCapabilities` 全仓无 production 调用者）。
(e) **测试债比披露的多一倍且有两处必须回滚**——21 处断言改写（非"约 10 处"），其中 `rlm-child-stream-scaling.test.ts:258` 的新界标定在"改动前成本"上（实测改动前实现就落在新界以下，会绿着放过）、`daemon-supervisor-eviction.test.ts:423` 把逐字 24h 换成 `expect.any(Number)` 而其放宽理由被同文件 `:464` 与实跑 33 passed/2.31s 证伪。
(f) **XA-1 已可执行打穿**：纯净树实测 once 任务撞 update-restart 栅栏 → `status:"completed", runCount:1, lastError:…retryable=false`（从未执行）；正控 Paused 错误 → `status:"active", runCount:0, nextRunAt=tick+5s`；附加 case 证明 typed `retryable:true` 的 Suspended 同样被无视。

---

## 2. ①跨簇不变量：栅栏谁清 / epoch 谁跳 / 单调钟谁用 / 版本闸怎么失败

### XA-1（P2·新雷·跨 r39↔r40）"retryable" 有两套定义，K3Q-3 的闭合是部分的

事实链（全部 HEAD 逐字）：

1. r39（`da31a6f31`）把"可重试"做成**类型字段**：
   - `prompt-admission.ts:19` `const retryable = options.retryable ?? !options.suspendedForUpdateRestart;`
   - `prompt-admission.ts:9-10` `/** False for the update-restart fence: retrying cannot succeed until restart. */ readonly retryable: boolean;`
   - 即 `SessionInputSuspendedError` 有**两种**：栅栏态 retryable=false，普通 abort 悬挂态（`agent-session.ts:7967-7972`，`suspendedForUpdateRestart: false`）**retryable=true**。
2. r40（`1b40c5b3e`）把"可重试"重做成**类清单**：
   - `prompt-admission.ts:89-93` `isRetryableSessionInputRefusal()` 只 `instanceof SessionInputAdmissionPausedError || instanceof SessionInputCoalescingError`——**不含 `SessionInputSuspendedError`**，也不读它的 `retryable` 字段。
   - 消费点：`daemon-mode.ts:2012-2017`（followUp 支路）、`daemon-mode.ts:2057-2068`（heartbeat/promptUntilAccepted 支路）、`cron-jobs.ts:1309-1325`（hook 抛出时的兜底判定）。
3. 未被 classify 的错误落进 `cron-jobs.ts:897-905` 默认分支：`status: once → "completed"`、`lastRunAt` 写入、`runCount+1`、`lastError` 写入。**这正是 K3Q-3 判词里"最硬边=once 任务撞窗口直接 completed 永不执行"**（decisions.jsonl K3Q-3 条），只是触发错误换了一类。

两条可达支路（读码路径，未跑通实证的部分标注见 §5）：

- **栅栏支路**：`abortForUpdateRestart()`（`agent-session.ts:9680-9694`）同时置 `_sessionInputSuspendedForUpdateRestart=true` 并 `acquireSessionInputPause()`；`_assertSessionActionAdmissionAvailable()` 的检查顺序是**栅栏优先**（`agent-session.ts:7952-7963` 注释 "Fence first"），所以 tick 拿到的是 `SessionInputSuspendedError{retryable:false}` → 非清单内 → 抛出 → 默认分支 → once job `completed`（从未执行）。重启后 store 里它已是 completed，**用户的单次任务静默消失**；而正确的记账是 deferred（`CRON_DEFERRED_RETRY_MS` 5s 后重试，重启后无栅栏即可跑）。
  语义辨析：`retryable=false` 的原意是"**在本进程内**唤醒不了泵"（`prompt-admission.ts:24`），不等于"这次跑过了"。r40 把"能不能重试"与"跑没跑"两个正交问题压进同一个布尔，是矛盾根源。
- **普通悬挂支路**：`_promptInjectedMessage()`（`agent-session.ts:7133-7147`）只在 `!isStreaming && resumeIfIdle && !栅栏` 时 `_resumeSessionInputAdmission()`；随后 `_acquireDirectTurnAdmissionFence()`→`_assertSessionActionAdmissionAvailable()`（`agent-session.ts:9283/9289/9311`）。若 `requestAbort()` 已置 `_sessionInputPumpSuspended=true`（`agent-session.ts:9574-9577`）而流尚未收敛（`isStreaming` 仍 true），heartbeat tick 拿到 `SessionInputSuspendedError{retryable:true}` → 仍不在清单内 → 记 `ran`+`lastError`。
  （对照：`daemon-mode.ts:1987-1997` 的 `shouldDeferHeartbeatCronJob` + `wakeSuspendedSessionInput()` 只覆盖"有排队工作"的悬挂，不覆盖这条空队列 + 流未收敛窗口。）

测试面正控：`packages/coding-agent/test/r40-k3q3-cron-pause-deferred.test.ts:1-20` 的 doc-comment 明写只针对 QP-2/QP-3 两类；其 `makeScheduler(store, refusal)` 用**mock 抛错**注入 `SessionInputAdmissionPausedError` / `SessionInputCoalescingError`，`SessionInputSuspendedError` 在该文件零出现（grep 正控：`grep -rn "SessionInputSuspendedError" packages/coding-agent/test/r40-k3q3-cron-pause-deferred.test.ts` → 无命中；同 grep 对 `SessionInputAdmissionPausedError` 有命中，证明检法有效）。⇒ **该支路属"修了但没测"且实际未修全**。

最小修复面：`isRetryableSessionInputRefusal` 改读 typed 字段（`error instanceof SessionInputSuspendedError ? error.retryable : ...`），并把栅栏期的记账从 `ran+error/completed` 改为 `deferred`（跨重启可成功）；或引入第四种 outcome `"fenced"` 让 store 保持 scheduled 且写 `lastSkippedAt`。

### XA-2（P2·新雷·r40↔r41 时钟/timer 簇）deferred 自旋无上限，骑在未 unref 的墙钟臂上

- `CRON_DEFERRED_RETRY_MS = 5_000`（`cron-jobs.ts:195`）**全仓只有一处消费**：`cron-jobs.ts:885-894`（once → `now+5s`，recurring → 下一槽）。无 defer 次数计数、无上限、无升级路径（`grep -rn "CRON_DEFERRED_RETRY_MS\|deferCount\|deferredCount" packages/coding-agent/src` 正控：仅 195/887 两行）。
- 每次 defer 都走 `recordDispatchResult`→`mutateStates`（`cron-jobs.ts:852-908`）＝**每 5s 一次带 proper-lockfile 的 store 重写**（`updatedAtForMutation` 保证单调戳，但写放大与锁竞争是真的；同 store 承载多会话时更明显）。
- 定时器卫生：`cron-jobs.ts:1346-1384` `scheduleNext()` 用 `Math.max(0, next.getTime() - now.getTime())`（墙钟差，无跳变侦测）+ `setTimeout(...)` **无 `.unref()`**——这正是账本 TC-3「AgentCronScheduler 臂 timer 无 unref（13 处约定漏网）」与 TC-2「cron 调度臂墙钟差回拨全体延迟 Δ」，状态 `fixing`、`commit: null`，HEAD 复核仍在场。
- 组合后果（r40 放大 r41 暴露面）：pause 租约泄漏或长窗口（ACP stop 窗口、MCP reload 卡住）时，once job 变成**每 5s 一次的永久自旋**：用户看到任务永远"scheduled + skipped=…"、无 lastError、无告警；同时这条未 unref 的 5s 链把事件循环挂住，进程无法自然退出；墙钟回拨 Δ 时 5s 变 5s+Δ 且无侦测。r40 之前同类窗口的代价是"烧一次 run"（错但有限），r40 之后是"无限自旋"（诚实但无界）——**一处修法与另一处修法方向相反**。
- 建议：defer 计数 + 上限（例如 N 次或 T 分钟后升级为 `lastError`/"deferred-too-long" 可见态）；`scheduleNext` 的 timer 补 `unref()`（与仓内其余 13 处一致）；defer 的重试臂改单调钟或加跳变侦测。

### XA-3（P2·新雷·同一提交内自相矛盾）"unknown ⇒ fail closed" 在版本闸成立、在信任闸反向

- 同一提交 `14a4e8811`：
  - L8D-1：state-restore 版本闸**改成 fail-closed**——`python_version` 缺失（旧式 sidecar manifest）⇒ 隔离 by-value 函数/类（提交信息逐字："state-restore version gate fails closed; unknown source version quarantines by-value functions/classes"）。
  - K3L-2：跨压缩用户台账的方向闸改成白名单，但**白名单把 `undefined` 当可信**：`compaction/user-requests.ts:127-140` `if (message.details.fromRelationship !== undefined && message.details.fromRelationship !== "parent") return undefined;`，注释逐字："only an absent relationship (the user/CLI steering directly) and \"parent\" … speak for the user"。
- 而"absent"是**可被构造/可被丢失**的：跨 worker 投递用条件展开 `...(fromRelationship ? { fromRelationship } : {})`（`daemon-supervisor.ts:6725-6733`），`fromRelationship` 来自 `agentFamilyRelationship()`，该函数在"同一 id"与"既非 parent/child 也非 sibling"时**返回 undefined**（`agent-messages.ts:446-455`）；worker wire 的新字段是 additive/optional，`daemon-worker-protocol.ts:137-146` 注释自认"an older worker ignores it, which is the undefined relationship it already produced for this path"，且**无 capability gate、无 revision bump**（`DAEMON_PROTOCOL_VERSION = 7`、`DAEMON_SCHEMA_REVISION = 37` 均未随此 wire 变更变动；`grep -rn "WORKER_PROTOCOL\|workerProtocolVersion" packages/coding-agent/src` 零命中＝worker 侧根本没有版本协商常量）。
- 后果：**混版期（老 worker × 新 supervisor，或 catalog/roster 竞态导致 relationship 算不出）时，sibling/child 的模型文本仍按"用户原话"进跨压缩台账并被块头升格为 live obligation**——K3L-2 声称关闭的注入面在这些条件下开着，且没有任何一侧能侦测（fail-open 且静默）。resident worker 跨 update-restart 存活使混版窗口是真实存在的（`worker_prepare_update`/`worker_commit_update` 就在同一 wire 里）。
- 对照（正控）：可达性判定处**是** fail-closed 的——`assertAgentFamilyReach()`（`agent-messages.ts:457-464`）在 relationship 为 undefined 时 throw；说明"缺失即拒"在本仓是可实现的，只是没有用在信任判定上。
- 建议：机器来源消息**必须**带显式 relationship（`"user" | "parent" | "child" | "sibling" | "unknown"`），台账白名单只认 `user`/`parent`，`unknown` 与缺失一律排除；wire 字段按 AGENTS.md 规则分类并加 capability/revision。

### XA-4（P3·不变量未成文）epoch 谁跳：两个 pause 族对 release 不对称，同一计数器被当三种契约用

全部 8 处 `_sessionInputPumpEpoch++`（grep 正控命中，逐处读过上下文）：
`agent-session.ts:8804`（clearQueue，**仅当**有 preparing 动作）、`9246`（acquireSessionInputPause 取）、`9253`（**同族 release 也 ++**）、`9266`（acquireQueuedWorkPause 取）、`9365`（_resumeSessionInputAdmission）、`9575`（requestAbort）、`9684`（abortForUpdateRestart）；**`acquireQueuedWorkPause` 的 release（9268-9277）不 ++**，与 `acquireSessionInputPause` 的 release（9249-9258）不对称。
消费侧三种契约并存：泵代际失效（`8167-8318` 的 `epoch !== this._sessionInputPumpEpoch` 逐段 bail）、注入失效（`7143/7151` 无条件校验 `admissionEpoch`）、直接 prompt 失效（`7229/7240` **仅在 `!resumeSuspendedInput` 时**校验）。
评估：release 时两族都调 `_scheduleSessionInputPump()`，且 acquire 时的 ++ 已使旧泵在下一个检查点 bail，**未构成双泵**（此为"在本次扫描范围内未见"级结论，正控＝同 grep 对已知会 ++ 的 requestAbort/abortForUpdateRestart 命中）；但"一个计数器三种契约 + 两族 release 不对称"是下一轮改动的雷床（任何人给 queued-work release 加/减一次 ++ 都会同时影响三条消费路径）。建议拆成 `pumpEpoch` 与 `queuedWorkEpoch`，或把契约写成单一成文规则并加断言测试。

### XA-5（P2·已披露未修，HEAD 复核确认）时钟簇本批只落文档

账本 TC-1/TC-2/TC-3（date 2026-09-16）均为 `status: "fixing"`、`commit: null`。HEAD 复核（grep 正控：同一命令能命中 `packages/coding-agent/src/utils/sleep.ts` 的 `performance.now()` 单调钟先例，证明检法可区分两类时钟）：
- `stall-watchdog.ts:418, 448, 455, 557, 690, 726, 763, 801` 与 `turn-liveness.ts:302, 474` 的 `Math.max(0, now - anchor)` clamp **全部在场**（TC-1：回拨 ⇒ 豁免预算白拿、abort 升级无限推迟）。
- `cron-jobs.ts:1368` 墙钟差 + `1373` 无 unref **在场**（TC-2/TC-3）。
- `turn-liveness.ts:302` `Math.max(0, now - latest.receivedAt)` **在场**（TC-2：回拨期心跳帧恒节流丢弃）。
⇒ 本批"r41 时钟"实质交付＝`15143be42` 文档 + `1b40c5b3e` cron 记账；**推送说明若把时钟簇算作已处理，属过度声称**。且 XA-2 说明 r40 的新代码**新接入**了这条未修的墙钟/未 unref 臂。

### XA-6（P3·规则不符）三个"版本闸"三种失败语义，worker wire 变更未按仓规分类

- python payload 闸：隔离（fail-closed，L8D-1/L8D-2，`kernel/bootstrap.ts` venv 代际 hash 含解释器行）。
- 会话文件 `version > CURRENT`：拒绝迁移 + 提示（INS-4/r36，测试 `test/suite/regressions/r36-newer-session-version.test.ts`）。
- daemon 协议：negotiate-down（`daemon-client.ts:211/411/681` 的 `Math.min(hello.protocol.version, DAEMON_PROTOCOL_VERSION)`；`daemon-protocol.ts:1608` 只接受 `<= DAEMON_PROTOCOL_VERSION`）——r30 的 digest guard（`4df7e9b46`）在此层。
层次不同不必强求同一语义，但 **r38 给 worker wire 加字段既没 bump revision 也没 capability gate**（XA-3），与仓内 AGENTS.md「Classify every daemon command, event, and response-shape change … Add optional features behind a negotiated server capability」的成文规则不符。

---

## 3. ②重灾区面（用户可感知）

### 3.1 子代理产物删除链（墓碑 + 惰性对账 + 30 天回收）——子线 artifact-del 交付 + 我独立复核

**ADC-1（P2·真·用户可感知，我已独立复核）：7 天 residue 类击穿 30 天 child-transcript 承诺。**
- 子线证据：探针 `/tmp/audit_r/round-41/artifact-del-work/probe.mts`（exit 0，仓零写入）：residue `reclaimed=1`、child transcript `still exists: false`；对照组 child-transcripts 判 `young:30d`。报告 `/tmp/audit_r/round-41/artifact-delete-chain.md`。
- 我的独立复核（不依赖其探针）：
  - `retention/child-transcripts.ts:1-11` 逐字："Child transcripts: `sub-xxxxxxxx/<uuid>.jsonl` **under an artifact root**"，默认窗口 30 天（r38 LIFE-2），且要求"三道判定全过"（ledger 无活边、无 resident/lease、目录内每个文件都超窗）。
  - `retention/artifact-dirs.ts:215-223`：候选若 `ledgerDeleted` ⇒ **`return undefined`（不 skip）**，注释逐字："what remains in its artifact directory … is residue by round-09 ruling 3"。
  - 两者作用在**同一棵树**（artifact root 下的 `sub-*`），窗口分别 7d（residue）/30d（childTranscriptDays，`settings-manager.ts:2583-2584`，r38 `c87779e91` 改默认）⇒ **短窗先删，长窗承诺作废**。触发面：父会话删除后 artifact rm best-effort 失败（`daemon-mode.ts:1259-1268`），或任何 ledger 记了 delete 而字节还在的情形。
  - 连带：display 墓碑 `sub-xxxxxxxx/rlm-subagent.json` 随 residue 一起走，而 ledger delete 记录**永不回收**（ADC-2）⇒ 30 天承诺的"durable record = 墓碑 + ledger 记录"只剩后半。
- 这是典型跨簇矛盾：round-09 的 residue 裁定 vs r38 LIFE-2 的 30 天裁定，`c87779e91` 打开了 childTranscriptDays 默认值却没对齐 residue 窗口。
- 修复面（择一）：residue 类跳过 `sub-*` 子树（交给 child-transcripts 独占裁决）；或把 residue 窗口对 `sub-*` 抬到 `max(residueDays, childTranscriptDays)`；或让 child-transcripts 成为 `sub-*` 的唯一 owner 并在 sweep 顺序里前置。

**ADC-2（P2）：ledger 无回收类 + 超界后写读双 fail-closed ⇒ "该删的删不掉"。**`retention/types.ts:11-23` 的 RetentionClassId 清单里没有 ledger 类（正控：清单里确有 `stale-leases`/`crash-leftovers` 等 12 类，证明不是漏读）；`event-log.ts:273-275, 367-368` 与 `rlm-ledger.ts:49-50, 837-839` 在超 32MB/100k 记录后 append 与 replay 都 throw；`daemon-mode.ts:1243-1246` 的删除命令依赖 `appendDelete` ⇒ 删除命令失败。账本 LIFE-4 已登记"约 2 年后触发"，但 r40/r41 无动作，且 ADC-1 会让 ledger 成为唯一 durable record（依赖度上升）。

**ADC-3（P3）：sweep 无跨进程锁。**in-flight 守卫是模块级变量（`runner.ts:15, 47-49`）；CLI `prime-agent retention sweep`（`public-command.ts:334`）与 daemon timer 并发时各花一份 breaker 预算（`sweep.ts:151-155`）、`history.jsonl` 读改写丢行（`reports.ts:63-77`）可掩盖 stalled 判定、CLI 不传 resident 集（`sweep.ts:107` 空集）。子线未复现"活会话被删"（双保护：`sweep.ts:79-82` 转录存在性 + `child-transcripts.ts:87-90` ledger 活边；其正控走通）。

其余（低/info，详见子线报告）：ADC-4 目录签名复检对原地追加盲（`delete.ts:36-43, 92-101`）；ADC-5 `cooldownMinutes` 未作用于 artifact/child-transcript 类；ADC-6 foreign reap 在 `getProcessStartId` 失败时把活 pid 当死退休（`orphan-process-journal.ts:723-727`）+ reap/clear 赛跑可复活 journal；ADC-7 三层全用墙钟、无单调钟（偏斜方向保守）。
子线未验证项（照录）：`test_l8d_impl.py` 未实跑（只引 diff+源码）；`030b1ada4`/`e3f9484f9` 仅 diff-stat 级过目。

### 3.2 流式渲染链（帧扫描 + 节流 + 增量 lexer）

子线 render-chain 收口时仍在跑（已启动对抗语料 fuzz 找增量 lex 反例）。先给两条我自查的结构性事实，供母席在其交付前就有判断：
- 账本 TUI-4 条自报残留（逐字）："残留 blockCache 键 O(raw) 拼串（5.76ms 大头，另一残留面）"⇒ 三层叠加后**端到端帧成本仍含一项与块原文长度线性的常数项**，"800k 帧 31.07→5.76ms = 5.4×"不等于 O(可见行)；大代码块/大表格单块仍会把该项吃满。
- TUI-1/TUI-2/TUI-3（`84d3b31e9`/`f04078fa8`）分别修"每帧 6 次全扫"、"lineResetCache clear() 全清"、"粘贴逐字符过滤 + 首帧 8MB 全量写出"；三处都动了"缓存何时可复用"的前提，而 `33eb05dff` 的增量 lex 又新增一层"tail 未变则可复用"的前提——**四层缓存前提叠加**是本批渲染链最大的未证面（子线正在打这块）。

---

## 4. ③测试债 / ④修了但没测

- ③ 子线 testdebt 在跑（逐条判弱）。我自查已确认两条：
  1. `r40-k3q3-cron-pause-deferred.test.ts` 用 **mock refusal** 注入错误，不经真实 session/admission 路径 ⇒ 它证明的是 store 记账分支，不是"真实窗口下不烧 run"；且第三类 refusal（Suspended）零覆盖（XA-1 正控）。
  2. 本批改写既有测试的文件（`git diff --stat` 口径，非新增）：`session-lease.test.ts` ±76、`suite/agent-session-queue.test.ts` ±22、`suite/regressions/f1-agent-message-wakes-suspended-pump.test.ts` ±33、`fixq3-heartbeat-wakes-stranded-queue.test.ts` ±22、`rlm-subagent-display-cache-bounds.test.ts` ±17、`compaction-summary-budget.test.ts` ±9、`node-version-check.test.ts` ±12、`proper-lockfile-compromise.test.ts` ±10、`rlm-child-stream-scaling.test.ts` ±16、`daemon-mode.test.ts` ±37、`3885-subagent-runtime-host.test.ts` ±8、`4519-heartbeat-rebirth.test.ts` ±4、`machine-block-tail-anchor.test.ts` ±3、`r2-catalog-append-tail-repair.test.ts` ±10、`prime-agent-runtime/test/test_repl.py` ±7，另有 5 个纯放宽阈值提交（`40d2683d5`/`8873bc681`/`12da2cdf2`/`6a992d8c0`/`b2e505e05`）——**合计远超母席披露的"约 10 处"**，逐条判弱见子线报告（待补）。
- ④ 账本口径的残留清单（我抽查的输入面）：`INS-3` = **`confirmed_pending_fix`、commit null**（runSelfUpdate 原地 spawn 无备份无回滚；协调器用刚被重写的 argv[1] 启动；启动失败仅 warning、exitCode 不变 ⇒ 半新 CLI + daemon 静默跑旧 bundle）；`TC-1/2/3` = fixing（XA-5 已复核仍在）；`QP-4` = note（lane 优先级压过到达序，仅补文档 `f826bd7f3`）；`TUI-4` 残留 blockCache 键；`LIFE-4` 无活性对账 + ledger 无压实闸。子线 resid-runs 在跑 3 条实跑抽查（TS 侧 + install/shell 侧 + Python runtime 侧各≥1），punch-fence 在跑 XA-1 的可执行打穿（纯净树 `git archive HEAD` + 三 case：栅栏错误 / Paused 正控 / recurring）。

---

## 5. 待补（见 §7；仅剩 resid-runs 一条子线在跑）

> 收口更新：render-chain / testdebt / punch-fence 三线已交，结果合并进 §7。

### 原待补清单

- render-chain：增量 lex 失效漏判的可复现输入序列、每帧最坏复杂度、四层缓存前提是否互斥、新测试是否钉住命题。
- testdebt：逐条判定表（OK/合理放宽/命题削弱/命题掏空）+ 必须回滚清单。
- resid-runs：3 条实跑（命令 + exit code + 输出逐字 + 判定）。
- punch-fence：XA-1 的 A/B/C 三组实测字段（once+栅栏 / once+Paused 正控 / recurring+栅栏）。

## 6. 建议的推送级处置（按性价比排序）

1. **回补 XA-1**（改 `isRetryableSessionInputRefusal` 读 typed `retryable`，栅栏期记 deferred/fenced）——一处改动关掉"用户单次任务静默消失"，并让 K3Q-3 的判词真的成立。
2. **回补 ADC-1**（residue 跳过 `sub-*` 或窗口对齐）——文档/settings 承诺 30 天而实际 7 天，是可被用户直接发现的说谎面。
3. **XA-2 加 defer 上限 + `unref()`**——把"无界自旋 + 挂住事件循环"降回有界。
4. **XA-3 的 wire 字段按仓规分类**（capability/revision），信任白名单不再把"缺失"当"用户"。
5. 推送说明里把时钟簇明确标为"仅登记、未修"（XA-5），避免下一轮把 TC-1/2/3 当已闭合。
## 7. 子线收口结果（终审合并 · 已实证）

### 7.1 XA-1 已被可执行打穿证实（punch-fence 子线，纯净树 `git archive HEAD`=eb0825e63，EXIT=0，4 tests passed，真仓零写入）
报告 `/tmp/audit_r/round-41/punch-fence.md`，日志 `/tmp/audit_r/round-41/punch-fence/run2.log`。实测字段：
- **A** once + `SessionInputSuspendedError{suspendedForUpdateRestart:true}` → `ran=1 onErrorCalls=1`，终态 `{status:"completed", runCount:1, lastRunAt:12:35:01.000Z, lastError:"…update-restart fence… retryable=false.", 无 lastSkippedAt, 无 nextRunAt}` ⇒ **单次任务被标记完成而从未执行，重启后不会重跑**。
- **B** once + `SessionInputAdmissionPausedError`（正控，r40 已修路径）→ `ran=0`，终态 `{status:"active", runCount:0, 无 lastRunAt/lastError, lastSkippedAt 写入, nextRunAt=tick+CRON_DEFERRED_RETRY_MS}` ⇒ defer 正常，证明 A 的差别只来自错误类型。
- **C** recurring + A 的栅栏错误 → `runCount:1 + lastError 写入`（recurring 不丢任务，但记账说谎：记了一次没跑的 run）。
- **D** once + `SessionInputSuspendedError{suspendedForUpdateRestart:false}`（**typed `retryable` 字段 = true**）→ 仍 `ran=1 / completed / lastError:"… retryable=true."` ⇒ **直接实证判定函数无视 typed 契约**（`classify isRetryable=false 但 retryableField=true`，同次运行打印）。
- 可达性（子线代码路径推读，标 unverified 的部分：真 daemon + `abortForUpdateRestart` 端到端）：`agent-session.ts:7948-7972` 栅栏检查先于 pause lease，`abortForUpdateRestart` 同时拿 lease ⇒ 排队路径得 Paused（defer 对），直连路径（cron 空闲会话 `promptUntilAccepted` / 心跳 steer）得栅栏错误（不 defer）。
- 子线给的最小修复面（与我 §2 XA-1 一致）：`prompt-admission.ts:89` 谓词改读 typed 契约 → `cron-jobs.ts:1312`、`daemon-mode.ts:2013/2061` 三个调用点同步；栅栏档用 restart-aware 节奏而非 5s 空转，任务留盘由 `recoverInterruptedDispatches` 接住。
- 相邻缺口（勿混入本条）：`cron-jobs.ts:868-877` 的 `skipped` 分支同样把 once 置 completed 但不写 runCount，属 G5 设计意图。

### 7.2 渲染链（render-chain 子线）：三层叠加后单帧最坏复杂度**不是** O(可见行)
报告 `/tmp/audit_r/round-41/render-chain.md`（仓零写入）。
- **F2（P1·新雷·有复现）** `markdown.ts:401` 的 blockCache 键只含 `width|type|nextType|raw`，而同一块的渲染还依赖 `markdown.ts:745 getCapabilities().hyperlinks` ⇒ 能力翻转后**链接块永远输出退化形**（实测 capflip.ts：同实例 `setCapabilities({hyperlinks:true})` 后流式追加 osc8=false，同文本新实例立刻 osc8=true 作正控）。更糟：陈旧块返回**同一数组/字符串**，`tui.ts:1725` 的指针快路径把它当未变前缀复用、differ 从 firstRawDiff 之后才比 ⇒ **陈旧渲染不会被后续帧自我纠正**；`invalidate()`（`markdown.ts:320-330`）只为 theme 准备，能力变化无清理路径（`setCapabilities`/`resetCapabilitiesCache` 是公开 API，全仓无 production 调用者 ⇒ 生产触发未验证）。
- **F1（P1·数字）** 每帧仍 O(全文)：逐字复现 `markdown.ts:401` 的键构造 = 0.64/2.41/4.83ms @200k/800k/1.6M，占实测单帧（1.24/6.04/12.82ms）的 **46~52%**；整帧 N=20k→100k，「首变更在视口上方」183ms→928ms（线性，落 `tui.ts:1976 fullRender(true)`）。仓内成本测试只断言比值 + `<20ms` 绝对阈值 ⇒ 6.04ms 恒过。⇒ **账本 TUI-4 的"5.4× 加速"成立，但"每帧 O(可见行)"不成立**（与我 §3.2 的结构性预判一致，且量化了）。
- **F5（P2·测试弱点）** 新测试钉"渲染等价 + 写出字节数"，未钉每帧计算量，且**全部不带生产选项 transform**：生产助手块必带 mermaid transform（`assistant-message.ts:307-311`），它在 `markdown.ts:362` 每次 cache miss 对全文执行 ⇒ 提交声明的"bounded by the lex cache"在生产配置下不成立、零覆盖。另 `tui-large-transcript` 的假组件 render() 内容不变时返回同一数组，**把指针快路径的前提当成了测试保证**。
- 正确性面（正控齐全，未见反例）：8,160 组定向边界 + 400 组随机 1 字符流式差分无 mismatch；NAIVE 实现 mismatches=1 / REAL=0 作正控；围栏状态不跨块携带、列表/表格延续由 `:202` 的 list/html 排除 + tail 首字符非空白挡住。节流**不会**让 lex offset 与渲染 offset 脱钩（lexCache 只在 render() 内按当帧文本重建）——我 §3.2 提的"四层缓存前提叠加"风险，在 lex↔节流这一对上**未见**（子线表述："本次扫描未见脱钩证据"）。
- **F3（P3）** `markdown.ts:344` 注释声称"token before the cut is not paragraph/text"，实现（`:202`）只排除 list/html，真正拦住 paragraph/text 的是字符级 `\n\n` 检查 ⇒ 注释强于实现（未发现活 bug，有正控）。
- **Q3 更正一条提交说明**：四处 cache 策略各自与键空间自洽（lineResetCache 逐出最旧永不清空是安全的，因 `utils.ts:305 normalizeTerminalOutput` 是纯函数）；`84d3b31e9` 提交语"mirroring the editor wrapCache pattern"表述不准，**勿据此把 lineResetCache 改回全清**。
- F0：两个新测试文件用仓自己的 runner 复跑 7 pass / 0 fail ⇒ 上述均非"测试红"，而是"测试钉的命题弱于提交声明"。

### 7.3 测试债（testdebt 子线）：21 处改写，2 处必须回滚
报告 `/tmp/audit_r/round-41/test-debt.md`。范围统计：触及测试文件 85 = 新增 47 + 修改 38（21 个有删行）；被删 `expect(` 行 20 行/12 文件 + 1 处非 expect 实参改写 = **21 处/13 文件**（母席披露的"约 10 处"低估一倍）；恒真断言 0；无条件 skip 0（仅 1 处 `it.skipIf`，条件可判定，实跑正控 16/16 通过）。判定分布：必须修/回滚 2、合理放宽 3、命题被替换但跟随同提交规格变更且有新支撑 6、OK 10。
- **★1 `test/rlm-child-stream-scaling.test.ts:258`（须回滚）** `expect(parentListenerMs).toBeLessThan(12)` → `toBeLessThan(Math.max(fullRederiveMs * chunkCount * 0.5, 12))`。子线用本仓真实函数复刻改动前每 chunk 工作（12 轮）：改动前总成本 22.87–23.51ms，新界同轮 15.09–17.77ms，判别余量只剩 1.30–1.49×（旧界 1.9×）；且第 0 轮实测 `fullMs=0.1367 → bound=27.33ms` 而改动前实现 26.18ms ⇒ **改动前的实现就落在新界以下，测试会绿着放过它**；界标定的是改动前成本（注释宣称 pre-fix=chunkCount×full，实测只占 0.72），**无正控**。
- **★2 `test/daemon-supervisor-eviction.test.ts:423`（须回滚，放宽理由被证伪）** `24*60*60*1000` → `expect.any(Number)`（注释称"deadline 夹取使超时值对负载敏感"）。同文件 `:464` 对同一 `worker_deliver_message` 路径**仍逐字钉 24h**，且实跑该文件 `Tests 33 passed (33) Duration 2.31s` ⇒ 数字在本 harness 下确定，理由不成立；create 路径的 tier/夹取数值因此全仓无人钉。
- **★3 `test/settings-ancestor-scope-resilience.test.ts:135-149`（低危·按仓规处理）** 新增 CI 诊断探两个 private 成员（`as unknown as { ancestorStamps?: …; externalWatchers?: … }`）违反仓规"no same-file shadow types cast to with `as unknown as`"；断言未被掩盖（`expect(applied).toBe(true)` 仍执行），但闸门盲区：`check-test-private-probes.mjs --base b7f26e98b --strict-diff` 报 `failing:0`（该规则要 `_` 前缀/具名 shadow type）⇒ 重命名 private 成员后诊断会静默降级。
- 次严重（补正控即可）：`r31-guard-contention.test.ts:89` 阈值 50→500ms（保留 2× 余量仍能抓改动前 ~1s 饥饿，但无负例证明尺还在）；`rlm-subagent-display-cache-bounds.test.ts:104` hit-rate 控制改为对象同一性 `toBe(first)` ⇒ 对"每次都重读文件"的性能回归照样通过；**QP-3 支线**（`agent-session-queue:1769-1800` 三行断言改写）缺"拒绝后重发恰好送达一次"的端到端断言（QP-2 有 `r39-qp:194 deliveries()===2`、cron 层有 `r40-k3q3:152` 正控，QP-3 无）。
- 判 OK 的 10 处（已核，防止误伤）：9 处 sync→async 机械跟随（sync `acquireSessionLease` 在范围内被删，src 只剩 Async，断言语义逐字保留）；`compaction-summary-budget:25-36` 两行反向是同提交 `c3af1e8ba` 的规格变更（src 882 行 + 新 314 行测试），仍可证伪；node-version-check 移到新用例后**更强**（含 `not.toContain`）；`tool-call-args-final-parse-on-error` 多一条 `StreamFailureError` 类型断言；`test_repl.py` 加 `python_version` 跟随 L8D-1 fail-closed（旧行为由 `test_l8d_impl:119` / `test_r35_impl:261` 覆盖）；daemon-mode 桩形状 + 新用例是增覆盖；daemon-agent-roster 仅改过时测试名。

### 7.4 交叉印证（同一根因在三个面各出现一次）
XA-1（判定函数无视 typed 契约）、F5（测试钉的命题弱于提交声明）、★1（阈值界标定在改动前成本上）是**同一类缺陷**：*修复与其尺子由同一份假设生成，没有独立正控*。建议本批收口时对"声称已闭合"的每条，强制要求一个"改动前实现必然红"的负例（★1 与 XA-1 都恰好缺这个，而 punch-fence 的 B/D 两 case 证明补上它只需十几行）。


### 7.5 resid-runs（④实跑抽查）已收口
报告 `/tmp/audit_r/round-41/resid-runs.md`（冻结 SHA `eb0825e63`，主仓零写入）。三条抽查：
1. **TS · r39 QP 栅栏族 `da31a6f31`：声称成立。** `test/r39-qp.test.ts` 实跑 10/10 绿，`QP_EXIT=0`。
2. **TS · r40 cron 延迟记账 `1b40c5b3e`：测试绿但命题不成立的一类被独立复现。** `test/r40-k3q3-cron-pause-deferred.test.ts` 3/3 绿（`CRON_EXIT=0`），但子线用**真 Store + 真 Scheduler**探针实测：`SessionInputSuspendedError` 挂起变体（typed `retryable=true`）→ `prompt-admission.ts:89-93` 不认 → `cron-jobs.ts:1312` 放行 → `:1325` outcome `"ran"` → `:899-902` once 直接 `status:"completed"` + `runCount+1` + `lastError`。逐字：`B-CONTROL pause: {"ran":0,"status":"active","runCount":0,…,"nextRunAt":"…12:35:06.000Z"}` vs `B-MEASURE suspended: {"ran":1,"status":"completed","runCount":1,"lastRunAt":"…","lastError":"…retryable=true."}` ⇒ **与 punch-fence 的 A/D 两 case 完全一致（两条独立子线、两套探针，同一结论）**。该类零测试覆盖（负结论正控：同法 grep `abortForUpdateRestart`/`SessionInputSuspendedError` 各命中 5/2 个真实测试文件）。子线并指出：这属 `impl-k3q3.md` 自陈的"已知边界"，但账本 K3Q-3 写 `status=fixed` 未标范围 ⇒ **账面过度声称**（建议账本补 scope 注记或降为 partially_fixed）。
3. **shell · r36 `install.sh --force` 位置无关 `ce86f2092`：声称成立，但仓内零测试。** 正控：同法 grep 命中 `ipython-bootstrap`/`kernel-runtime-pinning`/`check-installer.mjs`，而 `prime_agent_force_install` 零命中。端到端沙箱（假 HOME + 假 npm prefix + 本地 http :18377 + 非 tty）4/4 PASS，`FORCE_EXIT=0`：A `install.sh 0.0.4 --force` → exit 0、终态 0.0.4、命中 `install.sh:1650` 的 "(--force)" 分支；B 领先位置正控 exit 0；C 无 flag → exit 1、旧版 0.0.1 未动（`install.sh:1662`）；D `--force` 不绕安装锁 → exit 1。
子线未跑项（照录 unverified）：TC-1/2/3 只做代码面核对（`Math.max(0,…)` 钳位 13 处仍在：`turn-liveness.ts:302/311/312/313/474`、`stall-watchdog.ts:418/448/455/557/690/726/763/801`；`sleep.ts` 单调钟先例在）；QP 残留#1 prepare→commit 端到端未跑（进程内探针证准入开着：`prompt_outcome:"PENDING"`、`isQueuedWorkSuspended:false`）；INSB-1 篡改包攻陷链未重跑。

---

## 8. XA-7（P1·新雷·跨 r39↔r40↔子代理回执账）"可重试"有**三**套互斥口径，两个正交命题被压成一个布尔

resid-runs 的探针 A 揭出第三套口径，我已独立在 HEAD 复核（逐字）：

| 口径 | 位置 | 栅栏态 Suspended(retryable=false) | 挂起态 Suspended(retryable=true) | Paused / Coalescing |
|---|---|---|---|---|
| ① typed 字段 | `prompt-admission.ts:19` `retryable = options.retryable ?? !suspendedForUpdateRestart` | false | **true** | true |
| ② 字符串清单 | `agent-messages.ts:823-836` `isRetryableAgentMessageSendError(message)`，含 `:827 /queued session input is suspended/i` | **true** | **true** | true（`:833`、`:836`） |
| ③ instanceof 清单 | `prompt-admission.ts:89-93` `isRetryableSessionInputRefusal` | false | **false** | true |

- ② 之所以把两种 Suspended 一律判 true：栅栏变体的消息**保留了同一句**（`prompt-admission.ts:21` "Cannot admit a session action while queued session input is suspended."，栅栏只在其后追加说明），子线实测 `{"retryable_field":false,"string_list":true}`；③ 对挂起变体实测 `{"retryable_field":true,"isRetryableSessionInputRefusal":false}`。
- **生产读点与后果（②）**：`agent-messages.ts:1084-1089 rememberFailure` — 判为 retryable 就 `return`，**不记 uncertain**，即 messageId 保持未花掉、发送方被引导"稍后重发"。于是在 update-restart 栅栏期（typed 契约明写"retrying cannot succeed until restart"），子代理 `agent_message.send` 的硬拒被当成"可重试"：子代理按 M6b 的重试上限（同文件 `:837-840` 注释"three in a row for one target turn terminal"）对着一个**本进程内永远不会准入**的会话烧重试与回合，回执账本同时把它当未投递。
- **同一事件、两本账方向相反**：一次挂起/栅栏拒绝，让子代理回执账说"未花掉、去重发"（②），让 cron 账说"跑过了、once 已完成"（③）。这正是母席问的"一处修法与另一处修法矛盾"。
- **根因（成文级）**：三套口径都把两个正交命题压成一个布尔——(a)「这次尝试有没有投递/入队任何东西」与 (b)「现在重试能不能成功」。②的文档注释（`agent-messages.ts:815-821`）自己写着 "every pattern here is a refusal the host raises *before* handing the message to the target … so 'worth retrying' and 'provably delivered nothing' are the same statement"——**这个等价在栅栏态不成立**（provably delivered nothing = true，worth retrying in-process = false）。
- **最小修复面（一处抽象，三处消费）**：把判定收敛到 typed 契约上的两个显式字段，例如 `deliveredNothing: true` 与 `retryNowSucceeds: boolean`（栅栏态 = true/false），然后：`rememberFailure` 用 `deliveredNothing` 决定 id 是否花掉、用 `retryNowSucceeds` 决定给发送方的引导语（栅栏态应引导"等重启后重发"而不是"稍后重试"）；`cron-jobs.ts:1312`/`daemon-mode.ts:2013/2061` 用 `deliveredNothing` 决定不记 run、用 `retryNowSucceeds` 决定 deferred 节奏（栅栏档 restart-aware，不要 5s 空转，见 XA-2）；字符串清单降级为兜底并加注释说明它只回答 (a)。禁止再新增第四套口径。
- 严重度定 P1 的理由：影响面同时覆盖**子代理回执可靠性**（老板用形态＝心跳/子代理驱动自治）与**用户定时任务**（S2：once 撞 Esc 挂起窗永久不执行），且两本账互斥意味着任何一侧的修复都会被另一侧掩盖。
