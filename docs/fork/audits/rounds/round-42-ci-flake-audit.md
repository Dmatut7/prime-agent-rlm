# CI 独红面审计：全套件时序敏感断言枚举与分级（r42 / K3 席）

- 范围：`packages/{coding-agent,ai,tui,agent}/test/**`（828 个 .test.ts）+ `prime-agent-runtime/test/*.py`（18 个）。只读审计，未改任何文件。
- 基线：HEAD 工作树（含 12da2cdf2、5e63da951 等已在位修复）。与 decisions.jsonl（345 条）去重：无既有"测试时序断言"专项条目；MERGE-1/TC-2 是产品码时序，不重叠。
- 背景实证：老板两笔 CI 红对应 commit 12da2cdf2（`daemon-supervisor-launch-startid-async` 上限 48→160ms、`r31-guard-contention` 迟 tick 上限 50→500ms）；"ma-p0-1 三条"对应 5e63da951 修的 stale-heartbeat 读序 + 该文件真实 50/100ms 看门狗阈值族。本报告按同一形态学找同类。
- CI 形态（ci.yml 实读）：PR 跑 3 个 vitest shard（`test:ci`，默认 tagsFilter 排除 `process-stress`/`kernel-heavy`）+ kernel 专 job + machine-wide 专 job + py 套件 job；`process-stress` 只在 nightly-process-stress.yml。**shard 内几十个文件并行 = 事件循环/GC/磁盘抖动源**，这正是"共享 runner 偶红"的物理机制。vitest 全局 testTimeout=30s，无 retry 配置。

## 分级标尺

- **A（高危，会在共享 runner 偶红）**：对真实墙钟/事件循环/CPU 耗时设**绝对上限且余量 <4×**，或对真实事件设**小窗正断言**（"X 必须在 N ms 内发生"），或全体用例共享一个小截止助手。
- **B（中危）**：绝对上限但余量 5–25×；或涉及真实子进程/fswatch/localhost 网络的窗口断言。
- **C（低危）**：余量 ≥40× 或纯顺位断言（timer 截止序天然稳定）。
- **D（已稳，正控）**：假钟/门闩/计数/相对阈值/事件驱动——作对照样本。

---

## ① A 级清单（与三笔实测红同形态，建议优先改）

### A1. `test/rlm-child-stream-scaling.test.ts` — 绝对 12ms CPU 上限（双向都会红）
- 形态：`expect(parentListenerMs).toBeLessThan(12)`（listener 累计真实 CPU ms，性能探针注入 subscribe 回调测量）；正控 `expect(preFixMs).toBeGreaterThan(12)`。
- 何时红：shard 满载时 400 chunk 的监听器总工时 >12ms（抖动方向红）；极快机器上正控 <12ms（反向红，作者已知并注释"红=换尺"）。commit a1ce5fa5d 有意从相对阈值回滚成绝对 12ms（相对阈值失去鉴别力）——这是**知情接受的 flake 债**，应在台账登记。
- 修法（不改语义）：把 CPU 上限换成**计数断言**（每 chunk 的 compactor 调用次数 ≤1，参 markdown-incremental-lex 的 countingTheme 正控）；保留 bound control 但改为 `expect(preFixMs).toBeGreaterThan(parentListenerMs * 2)` 相对形态（当时被否是因为 22.87 vs 15.3 鉴别力不足——可改用"正控必须 ≥3× 受测值"而非固定 12ms）。

### A2. `test/cron-jobs-wallclock.test.ts:135` — `perCallMs < 4` 微基准上限
- 形态：cron 表达式求值单次 <4ms（旧实现 ~13ms/次，注释自述）。真实 performance.now，机器相关常数。
- 何时红：共享 runner CPU 抢占/GC 暂停落在测量窗内；任何 >2× 的减速即红。这是全套件**余量最小**的绝对上限。
- 修法：换"调用 O(1) 性"的可数代理（如探针统计内部 walk 步数上界），或相对阈值 `perCallMs < baselineNoCachePerCall / 2`（同窗自校准）；若坚持绝对值，放宽到 ≥20ms 并留注释说明鉴别力来源。

### A3. `test/suite/ma-p0-1-long-cell-survives.test.ts`（8 条用例全族）— 真实 50/100ms 看门狗阈值 + 固定睡眠窗负断言
- 形态：`warnAfterSeconds: 0.05 / abortAfterSeconds: 0.1`（真实钟）+ `await sleep(1000|800|500); expect(stall_abort).toEqual([])`（5 处固定窗负断言）+ waitForEvent(10s) 正断言。5e63da951 刚修过其中 stale-heartbeat 读序一处（"clock-step compensation can age the frame enough to reach the stale path one tick early on a loaded runner"——作者自认负载敏感）。
- 何时红：(a) shard 抖动使 watchdog 采样节拍错位，负断言窗口（500–1000ms）内混入一条 stall_abort；(b) `expect(readsAtFlip).toBe(0)` 这类"在某时点前未发生"断言对**采样早一拍**敏感（已修一处，同构断言还在）；(c) harness 冷启动+10s waitForEvent 在极端负载下撞 vitest 30s 上限（8 条用例串行各等 ~1s 睡眠，整文件基线 ~8s+）。
- 修法：负断言改**事件驱动等价物**——"等待到 abort 死线 + 余量"（用 harness 暴露的预算常数推导出死线事件），而不是裸 sleep 窗；"reads 发生在 flag flip 之后"已是对的方向（钉事件序而非钉时刻），把剩余 sleep 窗同构改造。长期解：给 StallWatchdog 注 StallFakeClock（stall-watchdog-tool-liveness 已证明可行），本文件只留 1 条真实钟冒烟。

### A4. `test/daemon-supervisor-launch-startid-async.test.ts` — 事件循环间隙上限（已红一次，放宽后仍同形态）
- 形态：`setInterval(2ms)` 心跳探针 + `expect(maxGapMs).toBeLessThan(160)`（SYNC_PS_BLOCK_MS×2）；另有 `spawnDeadline = now+5000` 的 `while(spawns<5) await delay(5)` 轮询窗与 `await delay(400)` 观测窗。
- 何时红：shard 兄弟进程或本进程 GC 造成 >160ms 的单次事件循环停顿（400ms 观测窗内一次即红）。12da2cdf2 从 48→160 只是降频不是根治：pre-fix 故障签名是 5×80=400ms 连续阻塞，**间隙分布的 P99 与 160ms 之间没有原理性隔离**。
- 修法：换**事件序/计数断言**——`syncStartIdCalls===0`（已在）就是根命题；间隙探针降级为诊断输出（进日志不进断言），或改成"**长间隙次数上界**"：`gaps>80ms 的次数 ≤ CONCURRENT_LAUNCHES-1`（pre-fix 会产生 5 次 ≥80ms 连续阻塞，现修复版应为 0 次 >80ms 的**连续**段——按段计不按单次计，抖动只抬高单段长度不制造多段）。

### A5. `test/r31-guard-contention.test.ts` — tick 迟到上限 + 次数下界（已红一次，放宽后仍双开口）
- 形态：`late = ticks.filter(fired-scheduled > 500)` 须为空；`expect(ticks.length).toBeGreaterThan(20)`。
- 何时红：(a) 单 tick 迟 >500ms（2ms 粒度探针在满载 shard 的 P99.9 可达）；(b) **次数下界反向红**：若 guard 竞争路径在快机器上 <220ms 就放弃/失败，ticks<21 → 红。下界断言对"太快"和"太慢"都敏感，是双开口。
- 修法：迟到上限改**比例形态**：`late_ticks ≤ ticks.length × 5%` 且 `max_lateness < guard预算(~1s)`（pre-fix 签名是 ~100 次 tick 全灭）；次数下界改成"观测窗 ≥ guard 重试预算的 1/2"或干脆删掉下界、把"确实发生了竞争等待"钉在 caught error 的持有者归属上（已钉 pid+marker，下界冗余）。

### A6. `test/agent-session-recursion.test.ts` — 全文件 109 处 waitFor 共享 1000ms 截止助手
- 形态：本地 `waitFor(condition)` 助手 `deadline = Date.now()+1000`，轮询 10ms；另有多处 `Promise.race([quiescence, sleep(20|200)])` 顺/逆位竞速（1606/1663/1668/1676/1818/1824 行族）。
- 何时红：(a) 1s 截止对需要多轮事件循环+文件 I/O 的条件在满载 shard 上过紧（全套件最密集的共享小窗）；(b) `sleep(200).then(false)` 正竞速（parentBoundaryStarted 须 200ms 内起跑）——真实异步链 >200ms 即红。逆向竞速（期望 timer 赢）由门闩保证，稳。
- 修法：助手截止改 10s（与套件其他 waitForEvent 对齐，反正超时只影响失败路径耗时）；正竞速窗 200ms→2s（竞速语义不变，只是上界放宽）。

### A7. `test/suite/regressions/4603-worker-recovery.test.ts`（darwin 腿）— fswatch+去抖 500ms 正窗
- 形态：1063–1076 行 `await delay(750); expect(psCount 不变)`（负窗）→ 改 owner.json → `await delay(500); expect(psCount 增加)`（正窗）→ `await delay(750); expect(不变)`。依赖 macOS FSEvents→去抖→ps 链在 500ms 内走完。另有 933 行 `delay(750)` 后断言描述符已落 `failed`。
- 何时红：CI macOS runner 上 FSEvents 投递延迟 >500ms（满载时常见）；或去抖窗口与 750ms 负窗重叠。
- 修法：正窗改轮询 waitFor（`vi.waitFor(() => expect(count).toBeGreaterThan(...), {timeout: 5000})`）；负窗保留但放宽到 ≥1.5s 并在注释里写明它压的是哪个去抖常数。

---

## ② B 级清单（绝对阈值但余量 5–25×；负载翻数量级才红）

| 文件 | 断言 | 余量分析 | 修法 |
|---|---|---|---|
| `test/repl-kernel-shutdown-escalation.test.ts` | shutdown 全程 `<4000`（pre-fix ≥5s 协议死线）；第二条 `<12000`（pre-fix ~7s+） | **余量仅 1s**（5s vs 4s 上限）；真 kernel+SIGINT/SIGKILL 链，kernel-heavy 专 job 内仍共享机器 | 上限改 4.9s→贴近死线的 95% 无意义；改事件断言"shutdown 返回时 kernel 已死"（已有 pidExists poll）+ 耗时只记日志 |
| `packages/ai/test/codex-retry-behavior.test.ts` | 4 处 `elapsedMs < 500`（mock fetch，无网络） | 纯进程内，~0ms 基线 vs 500ms | 可留；更稳形态：断言"无真实定时器等待"（fake timers 下跑通） |
| `packages/ai/test/provider-retry-delay-cap.test.ts` | `<2000` ×2（真 localhost server）+ `>=900`/`>=1800` 下界 | 下界安全（定时器只晚不早）；上限余量 ~10× | 留；上限可抬 5s |
| `test/extensions-timeout.test.ts` | `<500`×2 / `<1000`×2（内部超时 30–40ms） | 余量 12–25× | 留 |
| `test/extensions-runner.test.ts` | `<1000`×3 | 余量 ~10×（内部超时 100ms 级） | 留 |
| `test/kernel-bootstrap-lock.test.ts` | `waitedMs ∈ [200,5000]`、`<3000`、`<2500`（真实 lockfile+子进程 spawn） | floor 200 与 lockTimeoutMs 200 **零余量同值**——若实现把首次重试放 0ms 就红；上限余量足 | floor 改 `>=150`（允许一次快速首检），语义不变 |
| `test/bash-timeout.test.ts` | `elapsedMs < 3000` ×2 + `>=500` floor（真 `sleep 5` 子进程） | 真进程 spawn+kill；上限余量 ~10× | 留；floor 500 安全方向 |
| `packages/agent/test/empty-turn-retry.test.ts` | `gap >= baseDelay-50`、`gaps[1]>=gaps[0]`、`Date.now()-startedAt < 400` | gap 下界安全方向；`<400` 单次内存 run 余量 ~10× | 留 |
| `test/suite/agent-session-autonomous.test.ts` | gate 超时杀进程树 `<3000`（gate timeoutMs 250）+ `waitForProcessExit(pid, 2000)` | 真 node 子进程+树杀；macOS 上 process kill 传播偶发 >2s | waitForProcessExit 截止 2000→5000 |
| `test/daemon-supervisor-startup-adoption.test.ts` | `start() < 3000`（pre-fix 卡在 8s adoption 超时）；真 supervisor+挂死 worker 进程 | 余量 2.7×，真进程链 | 上限抬到 6s（仍在 pre-fix 8s 之下，鉴别力不变） |
| `test/agent-session-concurrent.test.ts` | 多处 `prompt(); await sleep(10); expect(isStreaming)`（10–40ms 正栅栏） |  faux provider 同步链，10ms 窗 | 正栅栏改 `vi.waitFor(() => expect(isStreaming).toBe(true))` |
| `test/suite/agent-session-serialized-refine.test.ts` | 35 处 sleep(10–50) 正/负栅栏（planStarted/planFinished/applyRefine 未调） | 负向由门闩保证（稳）；正向 sleep(10) 后 `planCalls===1` 类脆弱 | 正向改 waitFor；负向保留 |
| `test/rpc-jsonl.test.ts` | 8MB JSONL 解析 `<1000` | 纯 CPU 基线 ~50–100ms，10× | 留 |
| `packages/ai/test/secret-redaction.test.ts` | ReDoS 病理输入 `<2000` | pre-fix 是指数量级，2s 余量巨大 | 留（好样本） |
| `prime-agent-runtime/test/test_bash.py:1304` | `assertLess(elapsed, 1.0)`（fsync 被 mock 堵 5s，写库须非阻塞返回） | 余量大；py job 独立 | 留 |
| `test/retention-root-fix.test.ts:170` | `mtimeMs > Date.now()-1000` 鲜度窗 | 写后断言间隔 >1s 才红（慢盘+满载） | 窗放宽到 10s（语义=刚创建） |

## ③ C 级（枚举在案，无需动）

- `test/daemon-launch.test.ts:559` `<10_000`（fail-fast 鉴别，pre-fix 行为是 30s+ 挂死）、`:451` Atomics.wait(300) 自堵（确定性）。
- `test/main-interactive-routing.test.ts:563` `<2_000`（abort vs 50ms 内部超时，40×）。
- `test/agents-view-selection-anchor-grace.test.ts:139` `<1000`（同步路径时间戳新鲜度）。
- `test/suite/rlm-collect.test.ts` `waited<10_000` / `NON_BLOCKING_BUDGET_MS`（已中止的 collect 须立即返回，余量>50×）。
- `test/sync-sleep.test.ts` 全部 floor+ceiling（`>=25 && <1000` 等）：Atomics.wait 只晚不早 + 上限 30×。
- `test/extensions-timeout.test.ts` 的 `setTimeout(abort,15)` 与 `packages/agent/test/agent-loop-abort-result.test.ts` 的 harvest 窗（5 vs 40ms 截止序竞速）：**timer 截止序天然稳定**（同相位按到期序执行，微任务在回调间排空），不构成 flake。
- `test/suite/acp-mode.test.ts`、`test/agent-session-concurrent.test.ts` 的门闩负断言（`releaseInjected` 控制前永不 settle）：锁存驱动，稳。
- `packages/tui/test/stdin-buffer.test.ts` wait(5) vs timeout 10：同属截止序安全（wait 截止早 5ms，同相位先跑），但**余量只有一档时钟**，若日后把 timeout 调小到 ≤6ms 会立刻变 A 级——登记观察。
- `test/command-recovery-journal.test.ts` / `test/daemon-mode.test.ts` 的 `Date.now()+TTL` 传参：纯函数输入，确定性。

## ④ D 级：正控样本（已稳写法，作修法模板）

1. **假钟**：`test/stall-watchdog-tool-liveness.test.ts` + `test/turn-liveness.test.ts` 用 `StallFakeClock`（`clock.advance(N)` 精确推进，`silentMs` 断言精确值）——ma-p0-1 族的改造目标模板。套件内 22 个文件用 `vi.useFakeTimers`（agent-session-compaction、agent-connection-daemon、agent-session-queue、daemon-mode、footer-data-provider、exec、daemon-supervisor-eviction 等）。
2. **计数替代毫秒**：`packages/tui/test/markdown-incremental-lex.test.ts`（e17acd30f：countingTheme 断言每帧重渲染块数上界 8，负控 164）——rlm-child-stream-scaling / cron-jobs-wallclock 的模板。
3. **事件驱动等待**：`test/suite/harness.ts` 的 `waitForEvent`（10s 轮询事件流）与 `vi.waitFor` 族——替代一切"sleep 后断言已发生"。
4. **门闩负断言**：acp-mode / agent-session-concurrent 的 `deferred` 释放锁——证明"未发生"不靠时间窗靠控制变量。
5. **相对/自校准阈值**：`packages/agent/test/empty-turn-retry.test.ts:118` `gaps[1] >= gaps[0]`（指数退火用顺位而非绝对值）；`test/suite/agent-session-autonomous.test.ts` 的 `waitForProcessExit` 轮询形态。
6. **历史修复档案**（证明这些形态确实红过、修法确实有效）：108a960f7/6eb900c19（agent-traces、agent-message-bounded-wait 改确定性）、40d2683d5（settings-ancestor-scope-resilience 窗放宽）、bbcc003ec（ipython-provisioner waitFor→5s）、f1aff6fb5（daemon-stop-accounting/settings-watch 确定性化）、b49556902（py test_repl_heartbeat 窗放宽）、2a461b0de（agent-traces flush-then-cleanup）。

## 汇总

- 全套件 222 个文件含时序原语；真正构成"CI 独红面"的是 **A 级 7 个文件**（其中 3 个已红过、4 个同形态未爆）。
- 红的三根物理机制：①绝对 ms 上限 vs shard 负载抖动（A1/A2/A4）；②小窗正断言/共享小截止（A3 正断言腿/A6/A7）；③固定睡眠窗负断言对采样节拍错位敏感（A3 负断言腿/A5）。
- 统一修法原则（不改语义）：**上限→计数或相对阈值；正断言→事件驱动 waitFor；负断言→门闩或"死线+余量"推导；次数断言→比例+下界冗余性审查**。
- 快速收益排序：A6（一行改助手）> A7（正窗 waitFor 化）> A4/A5（次数化）> A3（5 处 sleep 窗事件化）> A1/A2（需设计计数代理）。

## 附录：全量枚举（222 个含时序原语的测试文件 → 分级）

| 分级 | 文件 | 主要形态 |
|---|---|---|
| B | `agent/test/agent-loop-abort-result.test.ts` | sleep×5(min=5.0) |
| C | `agent/test/agent-loop.test.ts` | sleep×7(min=0.0) |
| C | `agent/test/agent.test.ts` | sleep×8(min=5.0) |
| C | `agent/test/e2e.test.ts` | sleep×1(min=30.0) |
| B | `agent/test/empty-turn-retry.test.ts` | 上限[400] |
| C | `agent/test/stream-stall.test.ts` | 下界[30, 100],sleep×1(min=80.0) |
| B | `ai/test/codex-retry-behavior.test.ts` | 上限[500],假钟 |
| C | `ai/test/context-overflow.test.ts` | sleep×3(min=500.0) |
| C | `ai/test/mcp-oauth.test.ts` | sleep×1(min=100.0) |
| B | `ai/test/provider-retry-delay-cap.test.ts` | 上限[2000],下界[900, 1800] |
| B | `ai/test/secret-redaction.test.ts` | 上限[2000],perf.now |
| C | `ai/test/stream.test.ts` | sleep×3(min=500.0) |
| C | `coding-agent/test/acp-cold-cli.test.ts` | sleep×2(min=5000.0) |
| C | `coding-agent/test/acp-rlm-subagents.test.ts` | sleep×1(min=50.0) |
| B | `coding-agent/test/agent-session-concurrent.test.ts` | sleep×11(min=0.0) |
| C | `coding-agent/test/agent-session-queue-mutation.test.ts` | sleep×3(min=10.0) |
| A | `coding-agent/test/agent-session-recursion.test.ts` | sleep×15(min=0.0) |
| C | `coding-agent/test/agent-session-semantic-edges.test.ts` | sleep×3(min=10.0) |
| C | `coding-agent/test/agent-session-services.test.ts` | sleep×1(min=20.0) |
| C | `coding-agent/test/agent-session-tree-navigation.test.ts` | sleep×1(min=100.0) |
| B | `coding-agent/test/agents-view-selection-anchor-grace.test.ts` | 上限[1000] |
| C | `coding-agent/test/agents-view-state.test.ts` | sleep×2(min=60.0) |
| C | `coding-agent/test/bash-close-hang-windows.test.ts` | sleep×1(min=60000.0) |
| C | `coding-agent/test/bash-executor-output-hygiene.test.ts` | sleep×1(min=5.0) |
| C | `coding-agent/test/bash-executor-temp-file-failure.test.ts` | sleep×1(min=1.0) |
| B | `coding-agent/test/bash-timeout.test.ts` | 上限[3000],下界[500] |
| C | `coding-agent/test/child-process.test.ts` | sleep×2(min=25.0) |
| C | `coding-agent/test/clipboard.test.ts` | sleep×2(min=1.0) |
| C | `coding-agent/test/compaction-fact-appendix.test.ts` | 上限[5000],perf.now |
| A | `coding-agent/test/cron-jobs-wallclock.test.ts` | 上限[4] |
| B | `coding-agent/test/cron-jobs.test.ts` | 上限[700],perf.now,假钟 |
| C | `coding-agent/test/daemon-agent-connection-event-gap-breaker.test.ts` | sleep×1(min=25.0),假钟 |
| C | `coding-agent/test/daemon-agent-connection-event-gap.test.ts` | sleep×1(min=25.0) |
| C | `coding-agent/test/daemon-agent-connection-stall-events.test.ts` | sleep×1(min=20.0) |
| C | `coding-agent/test/daemon-agent-dir-identity.test.ts` | sleep×3(min=25.0) |
| C | `coding-agent/test/daemon-client-env.test.ts` | sleep×3(min=20.0) |
| B | `coding-agent/test/daemon-launch.test.ts` | 上限[10000],sleep×1(min=300.0),假钟 |
| C | `coding-agent/test/daemon-mode.test.ts` | sleep×1(min=300.0),假钟 |
| C | `coding-agent/test/daemon-pending-delivery-sender-disconnect.test.ts` | sleep×1(min=50.0) |
| C | `coding-agent/test/daemon-socket.test.ts` | sleep×1(min=250.0) |
| C | `coding-agent/test/daemon-stop-converge-credit.test.ts` | sleep×1(min=25.0) |
| C | `coding-agent/test/daemon-stop-convergence.test.ts` | sleep×3(min=10.0) |
| C | `coding-agent/test/daemon-stop-signal-delivery.test.ts` | sleep×3(min=25.0) |
| C | `coding-agent/test/daemon-supervisor-adoption-retry-reset.test.ts` | sleep×1(min=50.0) |
| C | `coding-agent/test/daemon-supervisor-crash-handlers-process.test.ts` | sleep×4(min=100.0) |
| C | `coding-agent/test/daemon-supervisor-crash-handlers.test.ts` | sleep×2(min=10.0) |
| C | `coding-agent/test/daemon-supervisor-eviction.test.ts` | sleep×1(min=25.0),假钟 |
| A | `coding-agent/test/daemon-supervisor-launch-startid-async.test.ts` | sleep×2(min=5.0),perf.now |
| C | `coding-agent/test/daemon-supervisor-monitor.test.ts` | sleep×1(min=10.0),假钟 |
| C | `coding-agent/test/daemon-supervisor-process.test.ts` | sleep×12(min=10.0) |
| B | `coding-agent/test/daemon-supervisor-startup-adoption.test.ts` | 上限[3000] |
| C | `coding-agent/test/daemon-worker-client-compact-delta.test.ts` | sleep×1(min=5.0) |
| C | `coding-agent/test/daemon-worker-shared-snapshot-encoding.test.ts` | sleep×1(min=5.0) |
| C | `coding-agent/test/edit-tool-no-full-redraw.test.ts` | sleep×1(min=0.0) |
| C | `coding-agent/test/event-log.test.ts` | sleep×1(min=1.0) |
| C | `coding-agent/test/exec.test.ts` | sleep×2(min=10.0),假钟 |
| B | `coding-agent/test/extensions-runner.test.ts` | 上限[1000],sleep×1(min=20.0) |
| B | `coding-agent/test/extensions-timeout.test.ts` | 上限[500, 1000],sleep×3(min=15.0) |
| C | `coding-agent/test/file-mutation-queue.test.ts` | sleep×6(min=30.0) |
| C | `coding-agent/test/footer-data-provider.test.ts` | sleep×2(min=10.0),假钟 |
| C | `coding-agent/test/herdr-agent-state.test.ts` | sleep×5(min=50.0) |
| C | `coding-agent/test/interactive-mode-interrupt-teardown.test.ts` | sleep×1(min=50.0),假钟 |
| C | `coding-agent/test/interactive-mode-prompt-stash.test.ts` | sleep×1(min=0.0) |
| C | `coding-agent/test/interactive-mode-status.test.ts` | sleep×2(min=0.0),假钟 |
| C | `coding-agent/test/interactive-mode-suspend.test.ts` | sleep×2(min=0.0) |
| C | `coding-agent/test/ipython-bootstrap.test.ts` | sleep×1(min=0.0) |
| C | `coding-agent/test/ipython-provisioner.test.ts` | sleep×2(min=50.0) |
| C | `coding-agent/test/kernel-bootstrap-in-use.test.ts` | sleep×1(min=60000.0) |
| B | `coding-agent/test/kernel-bootstrap-lock.test.ts` | 上限[2500, 3000, 5000],下界[200],sleep×5(min=30.0) |
| C | `coding-agent/test/kernel-heartbeat-liveness.test.ts` | sleep×2(min=30.0) |
| B | `coding-agent/test/main-interactive-routing.test.ts` | 上限[2000] |
| C | `coding-agent/test/map-concurrent.test.ts` | sleep×4(min=1.0) |
| C | `coding-agent/test/model-selector-actions.test.ts` | sleep×1(min=0.0) |
| C | `coding-agent/test/own-usage-memo-scaling.test.ts` | perf.now |
| C | `coding-agent/test/owned-session-worker-process.test.ts` | sleep×4(min=10.0) |
| C | `coding-agent/test/package-manager.test.ts` | sleep×2(min=20.0) |
| C | `coding-agent/test/package-self-update-daemon.test.ts` | sleep×1(min=100.0) |
| C | `coding-agent/test/r24-impl-tail.test.ts` | sleep×2(min=500.0),假钟 |
| C | `coding-agent/test/r31-event-log-append-retry.test.ts` | sleep×2(min=10.0) |
| A | `coding-agent/test/r31-guard-contention.test.ts` | sleep×1(min=10.0) |
| C | `coding-agent/test/r39-qp.test.ts` | sleep×1(min=250.0) |
| C | `coding-agent/test/repl-kernel-abort.test.ts` | sleep×1(min=0.0),假钟 |
| C | `coding-agent/test/repl-kernel-bash-interrupt.test.ts` | sleep×4(min=30.0) |
| C | `coding-agent/test/repl-kernel-execute.test.ts` | sleep×1(min=50.0) |
| C | `coding-agent/test/repl-kernel-heartbeat-live.test.ts` | sleep×1(min=1.0) |
| C | `coding-agent/test/repl-kernel-host-request-abort.test.ts` | sleep×1(min=10.0) |
| C | `coding-agent/test/repl-kernel-host-request-cancel.test.ts` | sleep×1(min=400.0) |
| C | `coding-agent/test/repl-kernel-mcp-shutdown.test.ts` | sleep×1(min=25.0) |
| C | `coding-agent/test/repl-kernel-parent-watchdog.test.ts` | sleep×1(min=10.0) |
| C | `coding-agent/test/repl-kernel-protocol-corruption.test.ts` | sleep×3(min=100.0) |
| C | `coding-agent/test/repl-kernel-restart-budget.test.ts` | sleep×1(min=260.0) |
| C | `coding-agent/test/repl-kernel-restore-teardown.test.ts` | sleep×1(min=10.0) |
| C | `coding-agent/test/repl-kernel-revival.test.ts` | sleep×1(min=60.0) |
| B | `coding-agent/test/repl-kernel-shutdown-escalation.test.ts` | 上限[4000, 12000],sleep×2(min=500.0) |
| C | `coding-agent/test/repl-kernel-shutdown.test.ts` | sleep×4(min=0.0),假钟 |
| C | `coding-agent/test/repl-kernel-snapshot-honesty.test.ts` | sleep×1(min=2000.0) |
| C | `coding-agent/test/repl-kernel-state-roundtrip.test.ts` | sleep×2(min=500.0) |
| C | `coding-agent/test/repl-kernel-unexpected-exit.test.ts` | sleep×2(min=20.0) |
| A | `coding-agent/test/rlm-child-stream-scaling.test.ts` | 上限[12],下界[12],perf.now |
| B | `coding-agent/test/rpc-jsonl.test.ts` | 上限[1000],perf.now |
| C | `coding-agent/test/rpc-prompt-response-semantics.test.ts` | sleep×1(min=150.0) |
| C | `coding-agent/test/rpc.test.ts` | sleep×4(min=200.0) |
| C | `coding-agent/test/semaphore.test.ts` | sleep×1(min=1.0) |
| C | `coding-agent/test/session-info-modified-timestamp.test.ts` | sleep×1(min=10.0) |
| C | `coding-agent/test/session-manager/file-operations.test.ts` | sleep×2(min=10.0) |
| C | `coding-agent/test/settings-ancestor-scope-resilience.test.ts` | sleep×1(min=50.0) |
| C | `coding-agent/test/settings-consent-fail-closed.test.ts` | sleep×1(min=25.0) |
| C | `coding-agent/test/settings-deep-merge-and-watch.test.ts` | sleep×3(min=25.0) |
| C | `coding-agent/test/settings-session-watch-lifecycle.test.ts` | sleep×2(min=50.0) |
| C | `coding-agent/test/sleep-listener-leak.test.ts` | sleep×1(min=1.0),假钟 |
| C | `coding-agent/test/stall-watchdog-exemption.test.ts` | 下界[0] |
| C | `coding-agent/test/suite/acp-features.test.ts` | sleep×2(min=20.0) |
| B | `coding-agent/test/suite/acp-mode.test.ts` | sleep×9(min=1.0) |
| B | `coding-agent/test/suite/agent-session-autonomous.test.ts` | 上限[3000],sleep×5(min=25.0) |
| C | `coding-agent/test/suite/agent-session-bash-persistence.test.ts` | sleep×3(min=0.0) |
| C | `coding-agent/test/suite/agent-session-compaction-continuation.test.ts` | sleep×2(min=300.0),假钟 |
| C | `coding-agent/test/suite/agent-session-compaction.test.ts` | sleep×3(min=0.0),假钟 |
| C | `coding-agent/test/suite/agent-session-goal.test.ts` | sleep×1(min=0.0),假钟 |
| C | `coding-agent/test/suite/agent-session-model-extension.test.ts` | sleep×1(min=0.0) |
| C | `coding-agent/test/suite/agent-session-parked-queue.test.ts` | sleep×4(min=200.0) |
| C | `coding-agent/test/suite/agent-session-queue.test.ts` | sleep×16(min=0.0),假钟 |
| C | `coding-agent/test/suite/agent-session-refine-skill.test.ts` | sleep×1(min=0.0) |
| C | `coding-agent/test/suite/agent-session-retry-events.test.ts` | sleep×1(min=40.0) |
| B | `coding-agent/test/suite/agent-session-serialized-refine.test.ts` | sleep×35(min=0.0) |
| C | `coding-agent/test/suite/daemon-serialized-refine-process.test.ts` | sleep×1(min=20.0) |
| A | `coding-agent/test/suite/ma-p0-1-long-cell-survives.test.ts` | sleep×5(min=500.0) |
| C | `coding-agent/test/suite/ma-p0-3-esc-wake.test.ts` | sleep×3(min=120.0) |
| C | `coding-agent/test/suite/ma-p0-3-terminal-notice-persistence.test.ts` | sleep×1(min=30.0) |
| C | `coding-agent/test/suite/ma-p0-6-settled-descendant-cascade.test.ts` | sleep×4(min=20.0) |
| C | `coding-agent/test/suite/r25-concurrent-compact.test.ts` | sleep×1(min=0.0) |
| C | `coding-agent/test/suite/regressions/2023-queued-slash-command-followup.test.ts` | sleep×1(min=0.0) |
| C | `coding-agent/test/suite/regressions/3217-scoped-model-order.test.ts` | sleep×1(min=0.0) |
| C | `coding-agent/test/suite/regressions/3885-subagent-runtime-host.test.ts` | sleep×1(min=10.0) |
| C | `coding-agent/test/suite/regressions/4257-update-restart-resume.test.ts` | sleep×5(min=0.0) |
| C | `coding-agent/test/suite/regressions/4519-heartbeat-rebirth.test.ts` | sleep×1(min=0.0) |
| C | `coding-agent/test/suite/regressions/4600-supervisor-singleton.test.ts` | sleep×7(min=25.0) |
| A | `coding-agent/test/suite/regressions/4603-worker-recovery.test.ts` | sleep×16(min=25.0) |
| C | `coding-agent/test/suite/regressions/4606-update-restart-coordinator.test.ts` | sleep×5(min=25.0),假钟 |
| C | `coding-agent/test/suite/regressions/4657-update-heartbeat-recovery.test.ts` | sleep×1(min=10.0) |
| C | `coding-agent/test/suite/regressions/4685-daemon-client-modes.test.ts` | sleep×2(min=20.0) |
| B | `coding-agent/test/suite/regressions/extension-handler-timeout.test.ts` | 上限[1000, 10000] |
| C | `coding-agent/test/suite/regressions/f1-agent-message-wakes-suspended-pump.test.ts` | sleep×1(min=20.0) |
| C | `coding-agent/test/suite/regressions/fixq3-heartbeat-wakes-stranded-queue.test.ts` | sleep×1(min=20.0) |
| C | `coding-agent/test/suite/regressions/fixq8-terminal-notice-dispatch-settles.test.ts` | sleep×2(min=10.0) |
| C | `coding-agent/test/suite/regressions/ma-p0-2-stall-killed-terminal-failure.test.ts` | sleep×1(min=50.0) |
| C | `coding-agent/test/suite/regressions/ma-queued-reply-delivery-credit.test.ts` | sleep×3(min=10.0) |
| C | `coding-agent/test/suite/regressions/ma-stale-no-reply-notice-publication.test.ts` | sleep×5(min=10.0) |
| C | `coding-agent/test/suite/regressions/print-rlm-quiescence.test.ts` | sleep×1(min=100.0) |
| C | `coding-agent/test/suite/regressions/r08-shutdown-admission-reacquire.test.ts` | sleep×1(min=300.0) |
| C | `coding-agent/test/suite/regressions/r1-aborted-dispatched-turn-settles.test.ts` | sleep×3(min=10.0) |
| C | `coding-agent/test/suite/regressions/r10-snapshot-encode-once.test.ts` | sleep×1(min=25.0) |
| C | `coding-agent/test/suite/regressions/reg-1-supervisor-registry-isolation.test.ts` | sleep×1(min=200.0) |
| C | `coding-agent/test/suite/regressions/session-persist-failure-visible.test.ts` | sleep×1(min=0.0) |
| C | `coding-agent/test/suite/regressions/w7-capability-control-plane.test.ts` | sleep×3(min=50.0) |
| B | `coding-agent/test/suite/rlm-collect.test.ts` | 下界[0] |
| C | `coding-agent/test/suite/serialized-refine-config-integration.test.ts` | sleep×3(min=10.0) |
| B | `coding-agent/test/sync-sleep.test.ts` | 上限[1000, 2000],下界[25, 40, 150],perf.now |
| C | `coding-agent/test/tool-execution-component.test.ts` | sleep×2(min=5.0) |
| C | `coding-agent/test/tools.test.ts` | sleep×2(min=10.0) |
| C | `coding-agent/test/worker-recovery-journal.test.ts` | sleep×2(min=5.0) |
| C | `tui/test/editor-paste-filter.test.ts` | perf.now |
| C | `tui/test/editor.test.ts` | sleep×7(min=10.0),perf.now |
| C | `tui/test/fullscreen.test.ts` | sleep×3(min=20.0) |
| C | `tui/test/loader-timer-hygiene.test.ts` | sleep×2(min=250.0) |
| C | `tui/test/overlay-non-capturing.test.ts` | sleep×1(min=50.0) |
| B | `tui/test/stdin-buffer.test.ts` | sleep×18(min=5.0),perf.now |
| C | `tui/test/wrap-ansi.test.ts` | perf.now |
| B | `py-runtime/test/test_bash.py` | sleeps=[0.05, 0.1, 0.2, 0.3, 0.7, 1.0],clock×2 |
| C | `py-runtime/test/test_mcp.py` | sleeps=[0.0, 0.01, 0.03, 0.05, 10.0],clock×2 |
| C | `py-runtime/test/test_mcp_base.py` | sleeps=[30.0],clock×16 |
| C | `py-runtime/test/test_repl.py` | sleeps=[0.0, 0.01, 0.05, 0.2, 0.3, 0.4],clock×12 |
| C | `py-runtime/test/test_repl_heartbeat.py` | sleeps=[0.05, 0.6, 0.8, 0.9, 1.5, 2.0],clock×4 |
| C | `py-runtime/test/test_repl_perf.py` | sleeps=[1.0, 1.5, 2.0],clock×3 |
