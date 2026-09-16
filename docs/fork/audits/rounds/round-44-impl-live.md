# round-44 / impl-live：LIVE-1 两条杀伤链修复（kernel 活工作 ≠ idle）

- 主仓：`/Users/a1/Desktop/ai/prime-agent`（只读，冻结 SHA `1b37cd61a`）
- 施工工作树：`/tmp/audit_r/round-44/wt-live`，分支 `r44/live-kernel-work-residency`，交付提交 **`2a4737a04`**（10 文件，+494/−14，含 changelog fragment `.changes/r44-live-kernel-work-residency.md`）
- 红证工作树：`/tmp/audit_r/round-44/wt-base`（冻结 SHA + 仅测试文件，无生产改动）——所有红测在此跑出
- 审计依据：`/tmp/audit_r/round-44/long-ops-child-kill.md`（K3 r44 专项审，形态 A=⑤ 90min 逐出、形态 B=④ 20min 预算）

## ① 主链（90min 形态）：kernel 活句柄/活执行接进逐出面

**改动**
1. `src/core/agent-session.ts`
   - 新公开 getter `isKernelWorkInFlight`：读 `this._ipythonKernelProvisioner?.manager` 的 `hasActiveExecution || isKernelBashRunning`（repl-manager 现成事实，纯 O(1)），并新增可注入 `kernelResidencyFacts` 选项（照 `stallKernelLivenessFacts` 先例，供无 kernel 测试）。
   - **故意不改 `isSessionActive` 本体**：`waitForRlmQuiescence`（agent-session.ts:14253）与 `_hasUnsettledRlmQuiescenceWork`（:14200，goal 续跑压制）都读它；后台句柄若进它，会把 headless quiescence 挂满 5min give-up、并压制父 goal 续跑。kernel 工作是"驻留证据"不是"turn 工作"，拆开放。
2. `src/modes/daemon/daemon-session-list.ts` `summaryForActiveSession`：`isSessionActive: session.isSessionActive || session.isKernelWorkInFlight === true`。这一处同时喂：
   - **子会话 passivation**（daemon-mode.ts:2887 `sessionPassivationSnapshot` OR `summary.isSessionActive`）→ `canPassivateSession`；
   - **整 worker 逐出**（worker roster flush 走 `buildSessionList`→`summaryForActiveSession`；supervisor `workerEvictionSnapshot`→`isSessionSummaryBusy`）→ `canEvictWorker`。
   - 纯函数 `canPassivateSession`/`isIdleEvictionThresholdMet` 无需改：快照的 `isSessionActive` 已带 kernel 项。

**红/绿证据**（`test/suite/live-kernel-work-residency.test.ts`，新）
- 红（wt-base，4/4 fail）：`isKernelWorkInFlight` 不存在（undefined→false）→ summary.isSessionActive false → 95min idle 快照 `canPassivateSession` **true（被逐出）**、`canEvictWorker` **true（一窝端）**。
- 绿（wt-live + pristine-verify，4/4 pass）：live 句柄/executing cell → 逐出判 false。
- 正控：无 kernel 事实/quiet kernel → `canPassivateSession` true、`canEvictWorker` true（纯空闲照常逐出）；`isSessionActive` 对 live 句柄仍 false（拆分被钉死）。

**已知取舍（披露）**
- `isKernelBashRunning` 读最新保留心跳帧；kernel 空闲（无 cell 在飞）时心跳**停发**（repl.py `_heartbeat_frame` gate），该 attestation 冻结。形态 A（起后台脚本的 cell 在飞时帧已报 handles>0）→ 冻结为 true → 不逐出 ✓。反例：脚本在空闲期死亡后 attestation 仍 true → 会话钉住直到下一 cell 刷新（泄漏方向=多驻留，不是杀伤方向）。要完全新鲜需 journal 覆写或 Python 侧空闲续跳帧，超出本线范围，见"后续建议"。
- daemon-mode.ts:3458/5771 两处直读 `session.isSessionActive` 的 display/status 路径未加 kernel 项（纯显示；逐出面已全覆盖）。

## ② 次链（20min 形态）：安静 await-bash 的 vouch 升档

**改动** `src/core/turn-liveness.ts` `sample()`：fresh 心跳下 `liveBashHandles>0` 分支新增合取升档——
`loopAlive && cellAwaiting && bashCellHandles>0`（**本 cell 自己的**活句柄 + 循环活 + cell 在等）→ `progress = true`（全预算档）。bash 位移原路径不变；合取任一项缺失（无 cell 在等/后台舰队/冻 loop）保持 20min 存在档；journal 降级路径不动。行内注释写明 LIVE-1 依据与 stdin-wedge 风险由合并上限兜底。

**红/绿证据**
- `test/turn-liveness.test.ts`（改）：安静 awaited 句柄 `progress` false→true（wt-base 红）；两个新负例（`bashCellHandles:0` 后台舰队、无 cellId）钉死不合取不升档（wt-base 即绿，防止升档过宽）。原 "separates a live handle with movement from a live handle with none" 的 hung 例是**有意翻转**（其注释本就是 M3 的 20min 设计抉择，即本 bug）。
- `test/stall-watchdog-quiet-bash.test.ts`（新）：真 turn-liveness + 真 StallWatchdog 共用一只假钟（复刻 `_sampleStallVouch` 映射）——
  - 红（wt-base）：tier "liveness"（20min 档）；
  - 绿：25min 处不 abort；**推到合并上限（30min floor/10×warn）仍死**（真楔子不会永生）；正控=冻 loop + 活句柄保持短档 20min 死 + `loop_stalled` 原因。
- `test/suite/ma-p0-1-long-cell-survives.test.ts`（改）：会话级接线——安静 awaited 句柄 facts → 首个 `stall_warning` 的 exemption `tier: "progress"`（wt-base 红= "liveness"），abort 持续 deferred；同文件 9 个既有用例（wedged 照杀、model stream 不豁免、journal 回退、kill switch）全绿。
- `test/stall-watchdog-tool-liveness.test.ts`（改）：原 M3 用例拆二——安静 awaited 句柄改全预算+上限内死；"无 cell 拥有的活句柄"保 20min 短档（正控延续）。

## 验证矩阵

| 面 | 基线(wt-base, 无生产改动) | 实现(wt-live) | pristine(git archive HEAD) |
|---|---|---|---|
| ① residency 4 测 | 4 fail（红） | 4 pass | pass |
| ② quiet-bash 组合测 | 1 fail（红） | pass | pass |
| ② turn-liveness 翻转例 | 1 fail（红） | pass | — |
| ② ma-p0-1 新例 | 1 fail（红） | pass | pass |
| 既有面回归 | — | session-action-store/daemon-session-list/stall-watchdog 77/77；exemption 28/28；tool-liveness/degraded-closure/clock-rollback 35/35；eviction+agents-view 110/110；daemon-mode 189/189；roster/stall-evidence/child-stall-excused 等共 107/107 | tsgo EXIT=0 + 3 文件 16/16 |
| 全仓 `npm run check` | — | **EXIT=0**（biome+tsgo+installer+browser-smoke+ci-honesty） | — |

测试纪律：全部 `env -u RLM_* -u PRIME_AGENT_* -u PI_*` 泄露变量后 `node ../../node_modules/vitest/dist/cli.js --run` 直调；分批 ≤3 文件（最后一批 8 文件为收口复跑，单命令 6s）；单命令均 <60s（daemon-mode.test.ts 43s 最长）。git add 逐文件、staged 核对无越界（见提交 2a4737a04，仅本线 10 文件）。

## 后续建议（未施工）
1. Python 侧 `_heartbeat_frame`：kernel 空闲但 bash 舰队非空时续发帧（含一次 trailing handles=0 收尾帧），让 `isKernelBashRunning` 空闲期也新鲜，消掉①的冻结 attestation 泄漏；需跑 prime-agent-runtime 自家 pytest。
2. passivation 快照可再加 journal 覆写项（`readJournaledBashHandles(kernelPid)`，异步、30min 一次、有界读）覆盖 protocol-3 回滚档与"句柄死于空闲期"的解钉。
3. 文档/agent 提示层把"长任务必须有输出心跳"写成硬约束（审计修复方向 2 的另一半）。
