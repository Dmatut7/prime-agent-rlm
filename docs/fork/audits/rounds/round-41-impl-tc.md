# r41 · TC-1/2/3 施工报告（impl-tc）

- 基线：主仓 HEAD 15143be42e92450ecfdf2b7f59aeac20dfa13996（冻结，只读）；施工工作树 `/tmp/audit_r/round-41/wt-tc`（symlink node_modules）。
- 输入：`/tmp/audit_r/round-41/time-clock/time-clock.md`（GLM r41 时钟线，探针 probe-clock{,2}.ts 可复跑）。
- 红绿纪律：新测 `test/clock-rollback.test.ts` 先于源码改动落地，改前 7 红 4 绿（red1.log：watchdog 预算冻结/abort 不升级、heartbeat 回拨判 fresh、revival 回拨 vouch 保持、degraded 回拨不过期、cron 回拨整体迟到、24.8 天臂挂住进程、备份名碰撞→后者经 fake Date 钉死后转红）；改后 15/15 绿（green3.log）。既有面正控：stall-watchdog / turn-liveness / cron-jobs / exemption / tool-liveness / degraded-closure / corrupt-store / heartbeat 调度回归共 181+ 测全绿（batch1-5.log）。

## 方案选型（依据）

统一新增 `src/core/clock-step.ts`：`StepCompensatedClock`——保留墙钟数值（记录/展示时间戳仍是墙钟），但读数**永不回退、且永不落后于单调钟自上次读数的推进**；检测到的回拨折进永久 offset。立场与仓内先例一致：sleep.ts:46「Atomics.wait 走 runtime 自身单调钟，等待期间的墙钟变化不能延长它」。两个注入面（watchdog `timers`、cron `hooks.now`）原本就是测试可控的时钟缝，新增 `timers.monotonicNow?`（缺省 `performance.now()`；注入时钟未提供时以墙读数兼任单调读数，floor 恒等、不产生漂移——既有测试逐字节不变的关键）。turn-liveness/repl-manager 侧按任务给的备选走「检测回拨→未知年龄→如实报告+fail-closed」：这些是纯读侧比较，anchor 语义不动，改动最小。

## TC-1（P2）：年龄 clamp 回拨冻结

| 位点 | 修法 | 红测 |
|---|---|---|
| stall-watchdog.ts:448/801（及 557/690/726/418/405/786/812/855 等全部内部读数） | 全部 `this.timers.now()` → `stepNow()`（StepCompensatedClock + monotonicNow 缝）：预算 `usedMs`、abort delay、`silentMs` 全部随真实时间推进 | 回拨 30min 后预算继续消耗（`usedMs>0`）且 40×60s 内 abort 升级；正控：前进方向 stages 逐字节 `[warn, abort, abort_unsettled]` |
| turn-liveness.ts:302 | `now < receivedAt` ⇒ 未知年龄 ⇒ state fail-closed 为 `stale`（ageMs 仍钳 0，不破坏消费方） | P1：回拨 30min 判 stale（改前 fresh） |
| turn-liveness.ts:474 | `at < revival.since` ⇒ 未知年龄不能证明在界内 ⇒ 按 aged-out 处理（复用 `kernel_revival_aged_out` 理由串，处置相同，报告如实注明语义=unknown-age） | P2：回拨后 vouched=false |
| turn-liveness.ts:534（连带 407） | 负龄 ⇒ deadline 不可证明 ⇒ expired 并清事实（下次 re-read 以当前钟重锚）；407 负 gap ⇒ 不再跳过重读 | P3：回拨后 vouched=false、degraded=false |
| repl-manager.ts:648 | `Date.now() < startedAt` ⇒ 返回 `undefined`，走既有「无可测年龄=aged-out」（B7 注释已定义该路径） | 单测未直驱 ReplManager（构造重）；语义由 turn-liveness undefined→agedOut 侧覆盖，报告如实标注 |

注：`revival.since`（reprovisionWindowSince）为 host 侧记录、`receivedAt` 为 host 侧接收时戳，均为同进程墙钟，回拨检测成立。

## TC-2

① 心跳节流（repl-manager.ts:722）：判定抽成 `turn-liveness.ts` 的 `shouldRetainHeartbeatSample(now, latest.receivedAt)`——`now < receivedAt`（回拨，非快内核）时**保留**帧，证据通道重锚；前进方向 <1s 仍节流（正控测试在案）。
② cron 调度臂（cron-jobs.ts `scheduleNext`）：臂改用 `schedulerNowMs()`（StepCompensated）；timer 回调内做跳变侦测——`effective = max(schedulerNow, armedAt+armDelay)`（「承诺醒时」为真实推进下界，照 MAX_TIMEOUT_MS 早醒重臂先例），以 effective 跑 `runDue`，`claimDue` 的 claimedAt 亦走 step 钟。红测：臂 5min、回拨 30min、真实 5min 后任务照跑（改前需 35min 墙钟）；正控：无回拨 5min 整触发不变。
③ idle 驱逐混钟：`session-action-store.ts` 新增纯函数 `clampForeignClockNow(now, {wall,mono}, monoNow)`——外来（supervisor）墙读数被本侧单调投影钳位（前跳不再放大 idle），回拨方向本就保守不变；接线在 daemon-mode `passivateIdleChildren` 入口（worker 收 supervisor `now` 的唯一混合钟路径；本地路径同钟不需要）。红测（纯函数级）：锚后真实 5min + supervisor 前跳 10min ⇒ 钳位后 25min idle 不再误判可驱逐（未钳位对照组复现 P5 缺陷为证）。

## TC-3

- `AgentCronScheduler` 臂 timer `setTimeout(...)` 后 `this.timer.unref()`（对齐 daemon-supervisor 13 处长臂 unref 约定）。红测：子进程（tsx 直跑 `test/fixtures/cron-scheduler-unref-child.ts`）臂 100 天任务后脚本结束，改前进程被 24.8 天臂挂住（实测 HUNG），改后带 "armed" 正常退出。
- 备份名（cron-jobs.ts:1181）：`migrated-${Date.now()}` → `migrated-${Date.now()}-${randomUUID()}`（仓内唯一名先例=randomUUID）。红测：`vi.setSystemTime` 钉死同一毫秒连跑两次迁移 ⇒ 两个备份文件（改前 renameSync 覆盖只剩一个）。

## 顺带（如实记录）

- `turn-liveness.test.ts` 一处既有用例（"the frame is newer" 覆盖 `receivedAt: T0+5_000`）与新语义冲突：未来时戳=回拨签名 fail-closed；改为 `T0-1_000`（仍比 previous 新、不越过读钟），命题（时戳本身不改变 movementToken）不变，已加注释。
- 已知残余（未修，非本任务范围）：degraded 事实在**持续**回拨下经 250ms 重读会以「龄≈0」继续 vouch（有界：墙钟追平即过期）——墙钟 deadline 语义本身如此，报告如实；`runDue` 外部显式传 `now` 的调用方不受跳变侦测覆盖。
- 未动面：daemon-supervisor scheduled-wake（同形态但无注入缝，改前需先开缝，超出 45 分钟窗口，留给下轮）。

## 验证与交付

- 测试：`node ../../node_modules/vitest/dist/cli.js --run`（直接 node 调 vitest，unset RLM_* / PRIME_AGENT_* / PI_*）；新文件 15 测 + 既有面（stall-watchdog / stall-watchdog-exemption / stall-watchdog-tool-liveness / turn-liveness / turn-liveness-degraded-closure / cron-jobs / cron-jobs-corrupt-store / 4527 / 4657）全绿。
- `npm run check` EXIT=0（biome --error-on-warnings + tsgo + installer + browser-smoke + ci-honesty 全链，check2.log；过程中的 2 个 warning 均为本测试文件未用 import，已清）。
- 提交：`5b19b6c79`（wt-tc 工作树，detached HEAD 自冻结 SHA 15143be42e92）：11 文件按文件逐个 `git add`，staged 清单核对后经 pre-commit hook（repo-wide `npm run check`）提交；pristine-tree 复验：`git archive HEAD` 解包 + symlink node_modules → tsgo EXIT=0 + 新测/正控 97 测全绿（pristine-tsgo.log / pristine-tests.log）。
