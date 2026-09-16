# round-44 / LIVE-1 抖动诊断：stall watchdog exemption started→cleared 每 ~10s 循环

**日期**：2026-09-16 · **证据**：`~/.prime/agent/logs/stall-evidence.jsonl`（218 行实测）· **代码**：prime-agent @ 33b1c0fd3（含 LIVE-1 = 2a4737a04）· 全程只读

## 结论（先答母席的二选一）

**都不是。** 这不是 LIVE-1 披露的「脚本死于空闲期会多驻留」（死被当活）的反面——生产数据里**没有「活脚本被当死」**：degraded journal 读到的 9 个 handle 是活的，vouch 判的也一直是「活」。这是 **LIVE-1 新豁免路径自身在抖**，且抖动源正是判定条件里的一个中间状态：**vouch 合取项 `_stallInFlightTools.size > 0`（「此刻有工具在执行」）在每次工具调用的 start/end 边界上翻转两次，而 watchdog 对每一次翻转都落一对 `exemption started` / `exemption cleared`**。一个 ~10s 轮询的短 cell 循环，就打出每 10s 一对。

- 功能安全：无害。每次 `cleared` 都发生在 touch（observedActivity=true）上，未花费的预算被**释放**而非 bank（stall-watchdog.ts:572-583），所以 `budgetUsedMs 0→7~239ms→0` 反复清零正是释放路径的指纹；`budgetSpentThisCycle` 永不置位；真正的静默期（无工具事件）段会持续累计，20min liveness 预算到期照杀不误。
- 实际危害：**取证日志洪峰**（10s 轮询 ≈ 1.7 万行/天，淹没什么真 stall 证据）＋ **事件无 sessionId**，daemon 多会话共写一个文件时无法归属（本次对账只能靠 `degraded_read` 行的 sessionId 反推）。

## 生产证据对账

| 事实 | 数据 |
|---|---|
| 抖动主体 | pid 86687（daemon）：89 对 started/cleared；pid 85717：另 20 对（系统性，非单会话） |
| 归属 | `degraded_read` 行：session `01a0a4bc-f73d-…`，kernelPid 86782，**liveBashHandles=9**（10:07/10:09/10:11/10:23/10:45 各一次＝每 turn 一次的节流日志，≈5 个 turn 产出 89 对 → 对发生在 turn 内，非 turn 边界） |
| 节奏 | 间隔 8.1–10.7s；段存活 7–239ms；`budgetUsedMs` 每次从 0 起 |
| vouch 理由 | `live_bash_handles + degraded_journal`（= 心跳不可用、走 journal 兜底）；偶发一次 `live_bash_handles + kernel_loop_awaiting_cell`（budgetMs 3000000，progress 层）＝某次 cell 恰好赶上心跳帧、走了 fresh 路径——**同因两面的直接物证** |
| 该会话工具分布 | 会话 jsonl 里 884 次 `ipython` 调用（30ms 级短 cell 轮询循环） |
| 对照 | 85717 有一条 `degraded_expired`（liveBashHandles=0）＝兜底证据到期正常失效，兜底机制本身工作正常 |

## 机制逐跳（file:line）

1. **空闲 kernel 停发心跳（LIVE-1 披露的残留本体，by design）**：`prime-agent-runtime/src/rlm/repl.py:1997-2001`——`_heartbeat_frame()` 在 `rid is None and not inflight` 时 `return None`，注释原文「an idle kernel has nothing to vouch for and a frame every 5s … would be wire and log noise」。
2. **短 cell 几乎永远赶不上心跳帧**：心跳线程每 5s（`repl.py:139` DEFAULT_HEARTBEAT_INTERVAL_MS=5000）醒来一次且只在请求在飞时发帧；30ms cell × 10s 周期 ≈ 0.3% 占空比 → host 侧最新保留样本（repl-manager.ts:726-738 保留，min gap 1s）持续老化。
3. **attestation 判 stale**：`turn-liveness.ts:324-325`——`staleAfterMs = max(3×interval, 1000+interval) = 15s`，样本年龄超过即 stale。
4. **degraded journal 兜底接管（LIVE-1 的 B4 路径，工作正常）**：`turn-liveness.ts` `sample()` 的 else 分支（~505-525 行）——`degraded.liveBashHandles > 0` → reasons 加 `live_bash_handles` + `degraded_journal`；journal 由 `tool_execution_start` 处的 `_refreshStallDegradedFacts()`（agent-session.ts:4853-4863，60s 最小间隔、40min 寿命）刷新。
5. **抖动源＝合取闸**：`agent-session.ts:4796`——`_sampleStallVouch()` 第一项 `if (this._stallInFlightTools.size === 0) return undefined`。设计意图正确（无工具在飞时静默归 model stream，由 streamStallTimeoutMs 负责），但它把「9 个活 handle」这份**恒定事实**切成了随工具边界翻转的信号。
6. **每个 agent event 都 touch**：`agent-session.ts:4903-4911`（tool_execution_start/end 维护集合）→ `4937` `watchdog.touch()` → `stall-watchdog.ts:561 evaluateExemption(now, true)` → vouch 翻转即发射 `started`（stall-watchdog.ts:619）/ `cleared`（:585）。
7. **归属缺口**：`agent-session.ts:_createStallWatchdog`（4694-4717）没传 `onExemptionEvent`，走 `stall-watchdog.ts:747 emitExemptionEvent` 的默认 `stallLog.info`——**无 sessionId 字段**。

## 与 LIVE-1 披露形态的关系：同根、不同面

- LIVE-1 披露的是**冻龄残留**（`isKernelWorkInFlight` / `isKernelBashRunning` 读最新保留心跳，空闲即停发 → 死脚本多驻留）——那是 **eviction/驻留侧**，方向＝死被当活。
- 本次抖动是**同一根因（空闲停发心跳）在 watchdog 侧的下游表现**：心跳 stale → degraded journal 兜底 → 兜底事实恒定成立 → 被工具闸切成微段 → 每段落两行日志。方向上没有误判（活就是活），所以**不是「披露形态的反面」**。
- 注意反向推导不成立：即使修了冻龄残留（空闲也发帧），抖动**依旧存在**——fresh 路径下 vouch 同样被 `_stallInFlightTools` 闸切割（日志里那次 `kernel_loop_awaiting_cell` 的 started/cleared 对就是证明）。**闸在工具集，不在心跳。**

## 修法方向（按推荐排序）

**A. 日志降噪（小、不动预算语义，推荐）**：touch 时采样的 started/resumed/reason_switch/cleared 按构造就是「每工具边界一对」，没有取证价值；真正有取证价值的是 timer-fire 时采样的转换（blink、exhausted）与各 stage 的完整 exemption snapshot（warn/abort/abort_deferred 已携带）。改法：`emitExemptionEvent` 的调用点按 `observedActivity` 分流——`observedActivity=true` 的转换降级为合并计数（如每分钟一行 `exemption micro-segments: N, reasons=…`）或直接不发射；`observedActivity=false`（fire 时采样）与 `exhausted`/`abort_deferred` 保持逐条。

**B. 归属修复（小）**：`_createStallWatchdog` 传 `onExemptionEvent`，在事件里补 `sessionId`（daemon 下 N 会话共写 stall-evidence.jsonl，当前完全无法归属）。

**C. 可选、治根因残留（不治本抖动）**：kernel 侧 `_heartbeat_frame` 在 bash handle 注册表非空时即使无 cell 也发帧 → attestation 保持新鲜、`isKernelBashRunning` 不再冻龄（同时消掉 LIVE-1 披露的 eviction 侧残留）；但如前述，started/cleared 对仍在，不能替代 A。

**D. 不建议**：把段创建懒惰化（只在 timer fire 时建段）——会把预算起算点后移到 warn fire，给每次豁免白加一个 warnAfterMs 的额度，削弱 cap 不变量（A1 族），为降噪动语义不值。
