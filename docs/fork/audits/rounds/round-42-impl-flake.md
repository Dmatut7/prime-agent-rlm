# r42 impl-flake：CI 独红面 A 级 7 文件改形（flake-a 席）

- 基线：主仓 HEAD `a609c6ac5`（冻结 SHA）；工作树 `/private/tmp/audit_r/round-42/wt-flake`，分支 `r42/flake-a`，commit **`b716cccc9`**（7 个测试文件，+198/−59，src 零改动）。
- 依据：`/tmp/audit_r/round-42/ci-flake-audit.md` A1–A7 清单与总纲（上限→计数/相对；正断言→事件驱动 waitFor；负断言→门闩或死线+余量推导；次数→比例）。
- 验证环境：`node node_modules/vitest/dist/cli.js --run` 直调，逐个 unset 全部泄漏的 `RLM_*`/`PRIME_AGENT_*`/`PI_*`；分批 ≤3 文件；单命令 ≤60s；未触碰 `doctor --fix`/`daemon ps -k`。

## 逐文件改法

| 审计号 | 文件 | 旧形态 | 新形态 |
|---|---|---|---|
| A1 | test/rlm-child-stream-scaling.test.ts | `parentListenerMs < 12` 绝对上限 + 正控 `preFixMs > 12`（双向红：满载红/快机反红） | 同轮双测相对界：复刻 pre-fix 每块全量重推导 ≥ 3× 活测 listener 工时（本机实测比 24.7×，正控注入 listener 路径后比塌向 ~1×）；正控改为「把重推导注入 listener 路径后 3× 界必失效」的内建变异正控，绝对 ms 全部移除 |
| A2 | test/cron-jobs-wallclock.test.ts | `perCallMs < 4`（全套件余量最小的绝对上限） | 相对界：`perCallMs < 同轮复刻分钟级步进的全程耗时 / 2`（pre-fix 形态自校准；负窗含 walk 计数正控 `minuteWalkMs > 0`） |
| A3 | test/suite/ma-p0-1-long-cell-survives.test.ts | 5 处裸 sleep(500–1000) 负窗 | 事件驱动：`vi.waitFor` 等看门狗自身的 `stall watchdog: exemption abort_deferred` 采样（abort 级真跑过且已缓期）+ 5×warnAfter 推导余量；warn-only 用例改门闩化负断言（abortAfter=0 无 abort 通道）+ 2×warn 派生 settle |
| A4 | test/daemon-supervisor-launch-startid-async.test.ts | `maxGapMs < 160`（12da2cdf2 降频未根治） | 计数界：`>80ms 长间隙次数 < CONCURRENT_LAUNCHES(5)`；间隙探针降级为诊断输出（console.info）；根命题 `syncStartIdCalls === 0` 不变 |
| A5 | test/r31-guard-contention.test.ts | `late(>500ms) 必空` + `ticks > 20` 双开口 | 三条推导界：实测竞争窗 ≥ 500ms（=retry 预算一半，负载只会拉长）；`late ≤ ticks/20`（5% 比例化）；单 tick 最大迟到 < 1000ms（=guard 全预算） |
| A6 | test/agent-session-recursion.test.ts | 全文件共享 `waitFor` 1000ms 截止 + 3 处正竞速窗 50–200ms | 截止 10s（对齐 vi.waitFor/waitForEvent）；正竞速窗 200→2000ms；门闩保证的逆向竞速保持 20ms 不动 |
| A7 | test/suite/regressions/4603-worker-recovery.test.ts | darwin 腿 `delay(500)` 正窗 + 两处 `delay(750)` 负窗 + 933 行 `delay(750)` | 正窗改 `vi.waitFor`（5s 轮询）等 fence 级身份复验的首次 `ps` 计数增加；三处负窗放宽 1.5s 并注明所压常数（SUPERVISOR_FENCE_POLL_MS=250 六拍 / 失败 worker reap 5min 节奏） |

## 先红后绿证据

- **变异红（新形态抓回归）**：
  - r31-guard：把 `await delay(10)` 退回 `Atomics.wait(10)`（pre-fix 形态）→ 红 `late.length 1 > floor(ticks/20)=0`（比例界单独抓住，contentionMs 界同时确认预算仍在）✓ 后已还原。
  - startid-async：把 launch 路径退回同步 `getProcessStartId` → 根命题红（syncStartIdCalls 5≠0）；**再临时禁用根命题单独验证计数界**：红 `longGaps 5 < 5 失败`（pre-fix 交错形态每 launch 一条长间隙）✓ 后已还原（src/测试双还原，`git status` 仅 7 测试文件改动后才提交）。
  - rlm-child：内建正控用例（注入式变异）绿 = 证明 3× 界在 pre-fix 世界必红；主测实测比 24.7×（界 3×，余量 8×）。
- **旧形态本机负载红演示（如实记录）**：10× CPU 过载（10 个 busy-loop burner）下旧形态本机未红（batch1 三文件全绿；负载不足以造成进程内事件循环停顿）。旧形态的真实红面证据取自审计在案的 CI 实录（12da2cdf2、5e63da951 两笔）。附带发现：过载下 agent-session-recursion 的 `loads the ephemeral RLM harness path...` 用例红过一次——**该用例在 HEAD（stash 后）无负载也红**，为环境依赖的预存失败（读了真实 `~/.prime/agent` harness 状态），非本次改动引入，与 A6 窗口族无关，建议另立 lane 处理。
- **绿（正路逐字节不变）**：7 文件全绿——cron(7)+r31(1)+rlm-child(5)、recursion(123/124，唯一红为上述预存)、startid(2)、ma-p0-1(9，且文件耗时 8s+→3.5s)、4603 darwin 腿（-t 过滤单测 18.5s 绿）。biome check 后复跑仍绿；`npx tsgo --noEmit` EXIT 0。
- **负载下绿（新形态负载成立）**：10× CPU 过载下 cron+r31+rlm-child（13/13）、ma-p0-1+startid（11/11）全绿。

## 限制与未跑面（如实）

- 4603 仅跑 darwin 腿目标用例（60s 单命令预算内无法全文件；其余 5 用例未动、不在 A 级窗口族）。
- A6 recursion 全文件 58s：分两命令跑完（123/124 绿 + 1 预存红）。
- 本机未能以 CPU 过载复现旧形态红（事件循环停顿需 GC/调度级别的进程内事件），变异红补足了「新形态抓得住回归」的证明；「旧形态在 CI 真红过」沿用审计实录。
- ma-p0-1 长期解（StallWatchdog 注入 StallFakeClock）需 src 侧时钟注入管道，超出本轮测试改形范围，未做；本轮为其死线+事件化近解。
