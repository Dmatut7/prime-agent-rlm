# round-44 / JIT-1 施工报告：vouch 抖动的日志分流 + 归属修复

**日期**：2026-09-16 · **分支**：`r44/jit-vouch-flutter`（工作树 /tmp/audit_r/round-44/wt-jit）· **冻结 SHA**：主仓 HEAD `53dab35284`（只读）· **施工提交**：`bc080171f`（7 文件，+466/-21，pre-commit hook 全绿）
**输入诊断**：/tmp/audit_r/round-44/impl-live-diag.md（K3，判定＝vouch 被“工具在飞集合”合取闸切割）

## 结论

按 K3 推荐序完成 A（日志分流）+ B（归属修复）；C（kernel 空闲期 bash 句柄发帧）**评估后不做**（依据见下）。预算语义零改动：banking、spent latch、cap 不变量全部原样，正控测试证明 20min liveness 预算照杀。

## A. 日志分流（stall-watchdog.ts）

- `emitExemptionEvent` 增加采样来源参数：**touch 采样**的 `started/resumed/reason_switch/cleared` 折入 `micro_segments` 合并计数（新事件 kind，每 60s 一行 `STALL_EXEMPTION_MICRO_SEGMENT_INTERVAL_MS`，携带 `count/windowMs/byKind/reasons`）；**timer-fire 采样**的转换、`exhausted`、`abort_deferred` 保持逐条。
- 冲刷时机三处：折叠满 60s；任何逐条事件发射前（时间线可读，summary 先落地）；`resetExemption()`（arm/disarm/give-up 的尾巴，绝不跨 arm cycle 泄漏）。
- 折叠只动**日志面**：transition 对 segment/budget 的作用路径一字未改。
- 生产换算：10s 轮询 ≈1.7 万行/天 → ≈1440 行/天（每分钟一行）。
- 默认 sink 与 session sink 共用新导出 `formatStallExemptionEventLog`，字段集不会漂移。
- 兼容性：`StallExemptionDiagnostics`（DAEMON_SCHEMA_ID 哈希切片）未动，`StallExemptionEvent`（union 之后、不在切片内）加可选字段与新 kind；daemon-protocol 32 测全绿确认 schema ID 不变。

## B. 归属修复（agent-session.ts）

- `_createStallWatchdog` 传入 `onExemptionEvent` → `_logStallExemptionEvent`：`sessionLog.info(formatStallExemptionEventLog(event) + sessionId)`。消息前缀保持 `stall watchdog:`，因此同时落 agent.jsonl 与 stall-evidence.jsonl（tee 判据是消息前缀），且每行带 `sessionId`——daemon 多会话共写一个文件时每行可归属（诊断里对账只能靠 degraded_read 行反推的问题消除）。

## C. 评估后不做（依据）

1. **C 不治 JIT-1 本体**：抖动源是 `_stallInFlightTools.size` 合取闸在工具边界翻转，与心跳新鲜度无关——K3 日志里那次 fresh 路径的 `kernel_loop_awaiting_cell` vouch 同样打出 started/cleared 对，是直接物证。
2. **C 是跨语言 wire 变更**：`repl.py:1989-2005` 的帧契约要求 `id=rid`；“无 cell 但 bash 句柄非空”要发 `id=None` 帧，需同时改 Python 帧形状、TS host 解析、两侧测试面（kernel-heartbeat-liveness 等），超出本轮窗口。
3. **C 治的残留（eviction 侧 isKernelBashRunning 冻龄）已 fail-safe**：驻留侧只多驻不少驻；kill 侧 LIVE-1 已在 2a4737a04 host 侧闭合。

## 测试（先红后绿，直接 node 调 vitest，unset 泄露变量，分批 ≤3 文件）

**红测（改前实测红，洪峰形态）**：
- `test/stall-watchdog-vouch-flutter.test.ts`（新）：12 cell×10s 抖动 → 改前 24 条逐条 started/cleared（红），改后 0 条逐条 + ≤3 条 micro_segments 合计 count=24；fire 采样 started 保持逐条且排在其 summary 之后；正控＝静默期 20min liveness 预算照杀（abort stage exemption.exhausted=true + 唯一一条 exhausted 事件，改前改后都绿，钉死预算语义不变）。
- `test/suite/jit-1-exemption-flutter-attribution.test.ts`（新）：faux 会话 3 个快 cell + degraded journal vouch（复刻生产形态 live_bash_handles+degraded_journal）→ 改前 6 条逐条行、无 sessionId（红）；改后恰好 1 条 micro_segments（count=6）且每条 exemption 行 `sessionId === sessionManager.getSessionId()`。

**适配的两个既有测试**（断言的是 touch 采样事件，按新语义改走 fire 采样/合并面）：
- `stall-watchdog-exemption.test.ts` debounce 用例：reason_switch 提交点改由 timer fire 采样（命题不变：满窗才提交、预算不重置）。
- `turn-liveness-degraded-closure.test.ts` 自续 vouch 用例：`toContain("resumed")` → `toContain("micro_segments")`（touch 采样的重生已折入合并面；carry 本身仍由 fire 采样的 cleared 与 abort 时序断言钉死）。

**回归全绿**：stall-watchdog / -exemption / -tool-liveness / -quiet-bash / -copy、turn-liveness、turn-liveness-degraded-closure、stall-evidence、daemon-protocol（schema ID 不变）、kernel-heartbeat-liveness、stall-diagnostics-render、daemon-agent-connection-stall-events、suite/ma-p0-1-long-cell-survives（8/8，含 waitForDeferredAbort 依赖的 abort_deferred 逐条路径）、suite/jit-1。

**门禁**：biome（touched files，exit 0）＋ 仓级 `tsgo --noEmit` exit 0 ＋ 提交后 pristine-tree（`git archive HEAD`＋symlink node_modules＋tsgo）exit 0。changelog fragment：`packages/coding-agent/.changes/r44-jit-vouch-flutter-logging.md`。

## 交付物

- 提交 `bc080171f`（r44/jit-vouch-flutter @ 冻结 53dab3528 之上）；工作树 /tmp/audit_r/round-44/wt-jit。
- 主仓未动（只读）；未跑 doctor --fix / daemon ps -k；未 amend 任何已合提交。
