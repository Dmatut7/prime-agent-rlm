# r40 施工：K3Q-3 — retryable 准入拒绝下的 cron/heartbeat tick 记账（deferred）

- 冻结 SHA：`addf606f42bf143d5b38b8987723e6905ead70ef`（主仓 HEAD，主仓只读零写入）
- 工作树：`/tmp/audit_r/round-40/wt-k3q3`（detached，node_modules symlink → 主仓）
- 提交：`1b40c5b3ef417671fd046483e5d2e8b022793a70`（`git commit --only -- <5 个点名文件>`，staged 逐一核对）
- 输入：K3 复核报告 `/tmp/audit_r/round-40/k3-review-r38r39.md` F-3 节 + probe3（`/tmp/audit_r/round-40/probe3_qp2_cron.mts`）

## 病灶（改前实证）

runCronJob 的 catch 只把 `unrunnableAtAdmission` 映成 `"skipped"`，`SessionInputAdmissionPausedError`（QP-2 暂停窗）与 `SessionInputCoalescingError`（QP-3 committing 窗）重抛 → `queueDispatch` 记 `outcome:"ran"` + error。三个入口全中：heartbeat 的 `promptHeartbeat`、非 heartbeat 忙会话的 `followUp`（此路径原本连 try/catch 都没有）、空闲会话的 `promptUntilAccepted`（都经 `_admitSessionInput`/`_assertSessionActionAdmissionAvailable` 抛出，且都在排队/投递之前）。

改前状态探针（`/tmp/audit_r/round-40/k3q3-preflux-state.mts`，真 Store+Scheduler，runJob 抛真 `SessionInputAdmissionPausedError`）：

```json
{"id":"hb","status":"active","runCount":1,"lastRunAt":"…12:35:01","lastError":"Cannot admit a session action while…","lastSkippedAt":null,"nextRunAt":"…12:35:31"}
{"id":"once","status":"completed","runCount":1,"lastRunAt":"…12:35:01","lastError":"Cannot admit…","lastSkippedAt":null,"nextRunAt":null}
runDue reported: 2
```

once 任务被记成 completed、runCount=1、nextRunAt=null —— 没跑过一次就永久退休。

## 修法（三层，全部落在既有语义框架内）

1. **`src/core/prompt-admission.ts`**：新增 `isRetryableSessionInputRefusal(error)` 类型守卫（两类的 `instanceof` 合取；两类都恒 `retryable:true`，且都发生在「未排队未投递」阶段）。
2. **`src/core/cron-jobs.ts`**（记账契约）：
   - `AgentCronJobRunResult` 增加 `"deferred"`：prompt 被可重试准入拒绝拒掉，run 没发生、稍后重试。
   - `recordDispatchResult` deferred 分支：**不记 ran、runCount 不+1、lastError 不写**，`lastSkippedAt` 留痕；once 任务**保持 active** 并把 `nextRunAt` 重挂到 `now + CRON_DEFERRED_RETRY_MS`（新常量 5s）；recurring 照 `nextRunAtForSchedule` 走下一槽（与既有 skipped 分支同语义）。`updatedAt` 走 `updatedAtForMutation`（LWW 对齐 K3R-2）。
   - `queueDispatch`：hook 抛出的两类 typed 错误也映成 `"deferred"`（不调 `onError`，非故障）；其余错误照旧 ran+error+onError。
   - `runDue` 计数排除 deferred（与 skipped 同待遇，不虚报 ran）。
3. **`src/modes/daemon/daemon-mode.ts` `runCronJob`**：返回类型放宽为 `AgentCronJobRunResult | undefined`；既有 catch 增加两类 typed 错误 → `return "deferred"`；`followUp` 排队路径补上同款 try/catch（原路径裸奔）。

**语义选择说明**：不能简单 `return "skipped"`——store 的 skipped 分支会把 once 记成 completed（4d19005d4 起的既有语义：coalesced/unrunnable 的 skip 视为已消费），而 once 撞暂停=还没跑过。故给「可重试拒绝」独立 deferred 语义；既有 skipped 语义一字未动。once 用 `now+5s` 有界重试节奏而非保持原 nextRunAt：nextRunAt 留在过去会让 `scheduleNext` 以 0ms 延迟热自旋（每圈两次 store 写），5s 节奏把窗口期重试成本压到每 5s 一次，窗口释放后最多 5s 内补跑；成功一次后调度照常前进。

## 红→绿

- 红测：`packages/coding-agent/test/r40-k3q3-cron-pause-deferred.test.ts`（3 用例，真 Store+Scheduler+真错误类型，`now` hook 受控定死时间戳）。
- **改前必红（实测 3/3 failed）**：`expect(ran).toBe(0)` 收到 2/1（ran 记账）；状态探针同时钉死 runCount=1、once completed、lastError 写入、lastSkippedAt=null —— 与任务书预测逐字一致。红跑用不含新常量的变体（`nextRunAt` 值断言属于新行为，改前无从红起），绿跑用完整版。
- **改后全绿（3/3）**：暂停窗 tick → hb/once 均 runCount=0、lastRunAt/lastError=undefined、lastSkippedAt 落戳、once `status:"active"` 且 nextRunAt=+5s、hb nextRunAt=下一槽；coalescing 拒绝同待遇；正控=窗口释放后同任务真跑（once completed runCount=1 lastRunAt=补跑时刻 lastError=undefined，hb runCount=1、lastSkippedAt 留痕不被抹）。

## 回归面（分批 ≤3 文件，unset 全部 RLM_*/PRIME_AGENT_*/PI_* 泄露变量，node 直调 vitest）

| 批 | 文件 | 结果 |
|---|---|---|
| 1 | cron-jobs / cron-jobs-corrupt-store / r39-qp | 84/84 ✓ |
| 2 | 4536-heartbeat-observability / 4519-heartbeat-rebirth / 4527-worker-heartbeat-scheduling | 7/7 ✓ |
| 3 | 4657-update-heartbeat-recovery / 4257-update-restart-resume / turn-liveness | 71/71 ✓ |
| 新 | r40-k3q3-cron-pause-deferred | 3/3 ✓ |

## probe3 复跑（改后，源指到工作树）

`/tmp/audit_r/round-40/k3q3-probe3-postfix.mts`（probe3 逐字改 import 路径）：

```json
{"tick1_paused":{"ranCountReported":0,"hb":{"runCount":0,"lastSkippedAt":"…"},"once":{"status":"active","runCount":0}}}
{"tick2_coalesced":{"runCount":0,"lastSkippedAt":"…","lastError":null}}
{"tick3_ran":{"runCount":1}}
```

tick1 ranCount 2→0、once completed→active、runCount 1→0；tick3 正控照常 ran=1。K3 复核的三条观察全部翻转。

## 验证链

- 工作树 `npx tsgo --noEmit` EXIT 0。
- pristine 复验：`git archive HEAD` 解包 + symlink node_modules → `tsgo --noEmit` EXIT 0，新测试 3/3 绿（防半提交）。
- `npm run check`（biome --write 全仓 + tsgo + installer/browser-smoke/ci-honesty 自检）EXIT 0，事后 `git status --porcelain` 空（biome 零改写）。
- changelog fragment：`packages/coding-agent/.changes/r40-k3q3-cron-pause-deferred.md`。

## 已知边界（不在本轮范围，如实记录）

- `SessionInputSuspendedError`（可重试变体）从 runCronJob 逃出仍记 ran——heartbeat 路径有 `shouldDeferHeartbeatCronJob`+`wakeSuspendedSessionInput` 兜着，K3Q-3 范围仅限两个 typed 拒绝；如需扩，同一 deferred 通道现成。
- 进程在 deferred dispatch 中途崩溃：`recoverInterruptedDispatches` 仍把 once 记 completed（"Interrupted…"）——防双跑的既有崩溃语义，未动。
- deferred 分支不写 lastError，也不清旧 lastError（ran 成功才清）——复核报告的 cosmetic 残留项维持现状。
- 心跳 steer 撞短窗会错过一拍（下一槽才补）——与既有 skipped 语义一致，K3 复核本身判 interval 为 P3 自愈。

## 过程注记

- 工作树里 `.husky/_` 未物化（husky 产物不入库，hooksPath 指向不存在目录），pre-commit 未触发即完成提交；未用任何 --no-verify。已按 hook 同款命令显式补跑 `npm run check`（EXIT 0）补齐质量闸。
- 第一次 `git commit` 因参数序失败（`-F` 落在 `--` 之后被当 pathspec，git 拒绝仓外路径），零副作用后按「-F 在前、--only 点名在后」重做成功。
- 主仓全程只读；探针与日志均在 /tmp/audit_r/round-40/。
