# round-44 / long-ops-child-kill：子代理跑长期运营脚本会不会被宿主误杀

仓库：/Users/a1/Desktop/ai/prime-agent @ 22f393738（只读）。行号均对应该 HEAD。
正控：`env -u RLM_DEPTH -u RLM_SESSION_DIR ... node ../../node_modules/vitest/dist/cli.js --run test/session-action-store.test.ts test/stall-watchdog-exemption.test.ts` → 61/61 pass（逐出纯函数 + watchdog 豁免预算行为符合设计，短时正常子代理不会被误杀）。

## 总结判词

「会被杀」属实，且有两条互独立的真实杀伤链，覆盖两种常见运营脚本形态：

- **形态 A（后台句柄 + 会话转静）→ 90 分钟 idle passivation 杀（候选面⑤，主根因候选）**：
  子代理 `h = bash('monitor.sh')` 起后台脚本后轮询/结束 turn，会话层面不再有消息。
  90 分钟无活动后 daemon 把该子会话 passivate → closeSession → kernel 关闭 →
  **kernel 内所有 bash() 进程组被杀**。会话之后可被消息/collect 重新水合，
  但进程已死——从老板视角就是「宿主把运营脚本误杀了」。
- **形态 B（单 cell 内 await 一个安静的长任务）→ stall watchdog 20 分钟 liveness 预算杀（候选面④）**：
  子代理一个 cell 里 `await bash('silent-job')` 或跑一个不打字的 Python 监控循环，
  无输出即无 movement，liveness 档豁免预算 20min 耗尽后 abort turn；
  abort 超时不停还会 kill 整个 kernel 并连带收割全部 bash 进程组。

①②③三条面核实为基本干净（细节见下），⑤④是真坑。

---

## ① stall watchdog：父等子时代理的活动证据（残余面：子的流式输出算不算父的活动）

**结论：不算。子的流式输出从不 touch 父的 watchdog；但父的常规等法（结束 turn / collect 轮询）本来就是安全的，唯一会死的是「父在单个 cell 里跑安静的长循环」。**

机制（agent-session.ts）：
- watchdog 只在父会话 turn 在飞时布防：`agent_start` arm / `agent_end` disarm（:4837-4877）。
  父派完活结束 turn 等子回复 → watchdog 根本不在跑 → **不会被判 stall**。这是正常形态，安全。
- 子会话事件经 `child.subscribe` 到达父侧后以 `rlm_child_update` 经 `this._emit()` 发到**会话事件总线**
  （:14691-14694）；而 watchdog 只由 `this.agent.subscribe(this._handleAgentEvent)`（:2049 → :4554-4555）喂。
  `_emit` 不经过 `_handleAgentEvent`。**子的流式输出、子的 agent_start/agent_end 都不构成父 watchdog 的 touch。**
- 父在 cell 里 `await rlm.collect(...)`：这是 in-flight host request → vouch active（turn-liveness.ts
  sample()，`hostRequestCount>0 && !agedOut`），progress 档。host request 超龄封顶 15min
  （DEFAULT_HOST_REQUEST_MAX_AGE_MS，turn-liveness.ts:73），但 collect 单次等待被 clamp 到
  `bindMs`（默认 60s，见③），远够不着 15min。安全。
- **残余杀伤形状**：父在**一个 cell** 里跑长监控循环且**不打字**（无 print、无 bash 输出、collect 返回不改变
  movementToken——`streamBytes|bashBufferedBytes|bashPipePending|cellsDone`，turn-liveness.ts:204；
  stall-watchdog.ts settleExemptSilenceOnMovement 注释明言「an in-flight host request reports no token」）。
  豁免理由在 `kernel_loop_awaiting_cell`（liveness 档，预算 20min）与 `host_request_in_flight` 间切换，
  但 segment 不因理由切换而重启，**合计沉默预算约 20min 后父 turn 被 abort**。
  对照：循环里每轮 print 一行心跳 → streamBytes 变 → movementToken 变 → 预算被 settle → 任意时长存活。
- 另一个前提：vouch 要求有 tool 在飞（`_stallInFlightTools.size===0` 则不豁免，:4735）；
  模型流沉默归 streamStallTimeoutMs 管，与本面无关。

## ② goal 预算（G1 的 3 次续跑上限）会不会连带杀子代理

**不会。** MAX_GOAL_CONTINUATIONS=3（goals.ts:10）；耗尽只把父自己的 goal 置 `budget_limited`、
停止自动续跑（agent-session.ts:4255-4268 `_goalContinuationBudgetExhausted`），全程无任何对子会话的调用。
且 :4277-4282 已有正确行为：父有未落地子活（`_hasUnsettledRlmQuiescenceWork`）时压住续跑提示。
间接影响仅一条：父不再续跑 → 全 worker 静默累积 → 加速⑤的整树逐出条件成熟。子代理本身不被 goal 碰。

## ③ rlm collect 超时 / 静默窗口与 watchdog 的冲突

**无冲突，设计自洽。**
- collect 等待在宿主侧 clamp 到 `getAgentMessageWaitSettings().bindMs`（agent-session.ts:12490-12510），
  默认 = 120s/2 = **60s**（settings-manager.ts:127,2493-2497）；超时返回当前快照、不 reject、不取消任何子代理。
- kernel 侧 readOnlyHostRequestTimeoutMs 读的是同一个 live 值（:12372），host/clamp 同源，不会出现
  「kernel 先于 host 超时」的错配。
- 60s ≪ host request 15min 超龄线，collect 永不触发 hostRequestAgedOut。

## ④ 子代理自身 stall watchdog（turn 在飞时）

子会话与父同一套 watchdog（warn 300s / abort 900s，settings-manager.ts:39,45）。turn 在飞 + cell 在执行时分三档：

| cell 内工作形态 | vouch | 结局 |
|---|---|---|
| 有持续输出的 bash（流式字节/管道积压/缓冲计数在变） | progress 档 + movementToken 每次变化 settle 预算 | **任意时长存活（正控形态）** |
| 安静无输出的 bash / 不打字的 Python 循环 | liveness 档，预算 **20min**（STALL_VOUCH_LIVENESS_BUDGET_MS，stall-watchdog.ts:286） | cell 开始后约 **20min abort turn** |
| 突发输出后转安静（pipePending 水位 >0 但计数冻结） | progress 档但 token 不变 → 不 settle | 约 **50min**（max(10×warn,30min)，:283-284,529）后 abort |

abort 后的连坐：cell 被取消只杀该 cell 归属的 bash 句柄（bash.py `_cell_handles`，别 cell 的句柄不动）；
但 ipython 在无 UI 时 `killOnAbortTimeout: true`（tools/ipython.ts:816），被中断的 cell 不停就 kill 整个 kernel
→ `reapKernelOrphanProcesses(kernelPid)`（kernel/repl-manager.ts:2536）**收割该 kernel 日志里全部 bash 进程组**，
包括早先 turn 起的后台监控。
额外盲区：脚本 stdout 是 pipe 时块缓冲，「健谈」脚本也会呈现长时间零字节 → 被当成安静任务进 20min 档。

## ⑤ 资源回收：idle passivation / eviction（主根因候选）

- 默认 `idleEvictionMinutes = 90`（settings-manager.ts:26,1793）；sweep 周期 = 90/3 = **30min**
  （daemon-supervisor.ts:1067-1074 `idleEvictionSweepIntervalMs`）。
- **子会话 passivation**（worker 内逐个子会话判，daemon-mode.ts:2979-3008 → `canPassivateSession`，
  session-action-store.ts:424-435）：`hasParent && !hasNonPassiveDescendants && !isHydrating &&
  !isSessionActive && attachedClients===0 && !hasRegisteredCronJob && now-lastActivityAt ≥ 90min`。
  - `isSessionActive`（agent-session.ts:9013）= isStreaming/isCompacting/isRetrying/**isBashRunning**/refine/…；
    `isBashRunning` 只数 `_bashAbortControllers`（:15665）——**那是宿主侧 bash 工具/!cmd 的控制器集合，
    kernel 里 bash() 起的后台句柄不在其中**。kernel 的 live bash 事实只喂 stall watchdog 的 vouch
    （:4702-4722），不进 isSessionActive、不进逐出快照。
  - `lastActivityAt` = 最近一条消息时间 ?? session 文件 mtime（daemon-session-list.ts:264-266）——
    后台脚本跑多久都不刷新它。
  - 杀伤链：`passivateSession`（daemon-mode.ts:2904）→ `closeSession(state,"shutdown",...)` →
    `runtime.dispose()` → kernel `performShutdown`：协议关闭先「kills live bash() process groups」
    （repl-manager.ts:2613 注释 + bash.py atexit `_kill_live_handles`）；硬杀路径则 reapKernelOrphanProcesses(:2536)。
    **两种死法都收割后台脚本。**
- **整 worker 逐出**（supervisor 侧，`canEvictWorker`，session-action-store.ts:438-457）：worker 里**全部**会话
  （父+所有子）闲 ≥90min → stopWorker 一窝端。有 attached client、ownerClient、wake-blind 调度（注册的
  heartbeat/cron）则豁免。
- 合法的常驻手段确实存在但被场景绕过：注册 rlm heartbeat / cron job 的会话被 pin（`hasRegisteredCronJob`、
  `isWakeBlindScheduledWorker`）；「定时任务」若走 cron 注册则安全，**手搓 `while True` / 后台 bash 不被认**。
- 测试覆盖缺口：daemon-supervisor-eviction.test.ts 有 cron/heartbeat/running-child 的 pin 用例，
  **没有任何「kernel 有活 bash 句柄时不得 passivate」的用例**（grep bash|kernel 零命中）。

## 可复现输入

形态 A（最贴老板场景，子代理几小时运营脚本被杀）：
1. 父会话 `await rlm('起监控：h = bash("./monitor.sh") 后台跑，每小时看一眼 h.tail() 有异常就汇报', name='mon')`。
2. 子代理照做后结束 turn（回了句「已启动」）。此后 monitor.sh 在 kernel 里正常跑，但子会话无新消息。
3. 父也结束 turn（或附着的 TUI 仍连着——只挡整树逐出，**不挡子会话 passivation**）。
4. 90min 后的某次 sweep（30min 周期）：子会话满足 canPassivateSession 全部条件 → passivate →
   kernel 关闭 → monitor.sh 进程组被 SIGTERM。日志特征：`Passivated idle child sessionId=... idleMinutes=9x`。
5. 父下次 collect/发消息时子会话正常水合、transcript 完好——但脚本已死，且无人报错。

形态 B：子代理单 cell `await bash('./scraper.sh')`，scraper 前 25 分钟无输出（或 stdout 进 pipe 块缓冲）
→ 约 20min 处 stall abort；若 cell 中断不停 → killOnAbortTimeout 杀 kernel → 全部句柄收割。
日志特征：子会话 stall_abort 事件 + collect 快照的 `stall_abort` 字段 + exemption `exhausted`(tier=liveness)。

## 正控

- 61/61 测试通过（session-action-store 逐出纯函数、stall-watchdog-exemption 预算语义），证明现行判据本身按设计工作。
- 短时正常子代理：turn 结束 → watchdog disarm；闲置 <90min → 不满足 passivation；collect 正常返回。
  不被任何一条链误杀。
- 长活但「正确姿势」的子代理也不被杀：turn 在飞且有输出（④正控形态）、或注册了 heartbeat/cron（⑤豁免）。

## 修复方向（供决策，不在本线施工）

1. ⑤：`sessionPassivationSnapshot`/`isSessionActive` 纳入 kernel liveness 事实（`liveBashHandles>0` 或
   `hasActiveExecution` 即视为 active）——数据已经在 repl-manager 里，只差接进快照。
2. ④：文档/agent 提示层面把「长任务必须有输出心跳（print/tee）」写成硬约束；或把 await-bash 的
   liveness 档对「句柄存活且未超龄」放宽（需防真死锁豁免过久，风险自负）。
3. 短期缓解：长活子代理注册 rlm heartbeat（pin 会话），或把 `idleEvictionMinutes` 调大/`off`。
