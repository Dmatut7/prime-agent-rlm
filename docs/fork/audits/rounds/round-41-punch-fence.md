# r41 打穿实证：cron tick 撞 update-restart 栅栏是否烧掉一次 run

- 冻结面：prime-agent HEAD `eb0825e634b0df63842bfc63c246151efc72ea37`（`git archive HEAD` 纯净树，含 r40 修复 `1b40c5b3e fix(coding-agent): defer cron ticks refused by a retryable admission window`，`merge-base --is-ancestor` = 真）。
- 纯净树：`/tmp/audit_r/round-41/punch-fence/wt`，node_modules 全部软链真仓（root / packages/{coding-agent,ai,agent}），未 `npm install`。真仓零写入（`git status --porcelain` 仍只有 3 个别的车道留下的未跟踪件；`find packages/coding-agent/test -name 'zz-punch*'` = none）。
- 测试文件：`wt/packages/coding-agent/test/zz-punch-fence-burn.test.ts`（照抄 r40 模板 makeStore/makeScheduler，宽松断言 + 全字段打印，另加 D 组测 typed `retryable` 字段）。

## 命令与 exit code

```
cd /tmp/audit_r/round-41/punch-fence/wt/packages/coding-agent && \
env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_CHILD_ID -u RLM_PARENT_ID -u PRIME_AGENT_SESSION_DIR \
npx tsx ../../node_modules/vitest/dist/cli.js --run test/zz-punch-fence-burn.test.ts
```
EXIT=0。`Test Files 1 passed (1) / Tests 4 passed (4) / Duration 509ms`。完整日志 `/tmp/audit_r/round-41/punch-fence/run2.log`。

## 实测字段（逐字，store.list() 取，tick = 2026-01-01T12:35:01.000Z）

分类前置事实（同一次运行打印）：
```
A.classify        {"isRetryableSessionInputRefusal":false,"retryableField":false,"suspendedForUpdateRestart":true,"name":"SessionInputSuspendedError"}
A.classifyPauser  {"isRetryableSessionInputRefusal":true,"retryableField":true}
D.classify        {"isRetryableSessionInputRefusal":false,"retryableField":true}
```

### A) once job + `SessionInputSuspendedError({queuedActionCount:0, suspendedForUpdateRestart:true})`
```
A.before {"id":"ac3ebbea-...","status":"active","runCount":0,"nextRunAt":"2026-01-01T12:35:00.000Z"}
A.ran    {"ran":1,"onErrorCalls":1}
A.after  {"id":"ac3ebbea-...","status":"completed","runCount":1,
          "lastRunAt":"2026-01-01T12:35:01.000Z",
          "lastError":"Cannot admit a session action while queued session input is suspended. The suspension is an update-restart fence: queued work must survive into the restart manifest, so retrying cannot wake it. 0 action(s) already queued; retryable=false."}
```
无 `lastSkippedAt`、无 `nextRunAt`。`runDue` 返回 1（计入"真跑"），`onError` 被调用一次。

### B) once job + `SessionInputAdmissionPausedError({pausedCount:1})`（正控）
```
B.before {"id":"4a607f5f-...","status":"active","runCount":0,"nextRunAt":"2026-01-01T12:35:00.000Z"}
B.ran    {"ran":0,"onErrorCalls":0}
B.after  {"id":"4a607f5f-...","status":"active","runCount":0,
          "lastSkippedAt":"2026-01-01T12:35:01.000Z",
          "nextRunAt":"2026-01-01T12:35:06.000Z"}
```
status 仍 active、runCount 0、无 lastRunAt/lastError、nextRunAt = tick + `CRON_DEFERRED_RETRY_MS`(5s)。r40 路径按预期 defer。

### C) recurring heartbeat（"every 30s"）+ A 的栅栏错误
```
C.before {"id":"c8d40d45-...","status":"active","runCount":0,"nextRunAt":"2026-01-01T12:34:30.000Z"}
C.ran    {"ran":1,"onErrorCalls":1}
C.after  {"id":"c8d40d45-...","status":"active","runCount":1,
          "lastRunAt":"2026-01-01T12:35:01.000Z",
          "lastError":"Cannot admit a session action while queued session input is suspended. The suspension is an update-restart fence: ... retryable=false.",
          "nextRunAt":"2026-01-01T12:35:31.000Z"}
```
runCount +1、lastRunAt 与 lastError 均写入 —— 一次从未执行的 tick 被记成已跑。

### D) once job + `SessionInputSuspendedError({queuedActionCount:0, suspendedForUpdateRestart:false})`（普通 abort 停车，`retryable=true`）
```
D.ran    {"ran":1,"onErrorCalls":1}
D.after  {"id":"5ff04916-...","status":"completed","runCount":1,
          "lastRunAt":"2026-01-01T12:35:01.000Z",
          "lastError":"... 0 action(s) already queued; retryable=true."}
```
**typed 字段说"可以重试"，仍被烧掉** —— 这是 instanceof 清单无视 typed 字段的直接证据。

## 判定：H 成立

A/C/D 三组实测值与假设逐条对上：撞 `SessionInputSuspendedError`（含 `suspendedForUpdateRestart:true` 栅栏）时不 defer，走 `recordDispatchResult` 默认分支（cron-jobs.ts:897-905）→ `runCount+1`、`lastRunAt` 写、`lastError` 写、once → `status:"completed"`；B 组撞 `SessionInputAdmissionPausedError`（retryable=true）时正确 defer（cron-jobs.ts:879-896 分支）。

机理（代码级）：
1. `prompt-admission.ts:89-93` 的 `isRetryableSessionInputRefusal` 是 `instanceof SessionInputAdmissionPausedError || instanceof SessionInputCoalescingError` 白名单，三个 typed refusal 都带 `retryable: boolean` 字段（12 / 47 / 62 行）却不被读取；`SessionInputSuspendedError` 整体缺席。
2. `cron-jobs.ts:1312` 与 `daemon-mode.ts:2013`、`2061` 三处共用这一判定 → 栅栏错误一路 `throw` → `outcome: error===undefined ? (runResult ?? "ran") : "ran"`（cron-jobs.ts:1325）→ 记成真跑。
3. 生产可达性：`agent-session.ts:7948-7972` 的顺序是**栅栏先于 pause lease**（7958 行），而 `abortForUpdateRestart()`（9680-9694）在架栅栏的同时也拿了 admission pause lease。所以同一个重启窗口里：走排队路径的调用者拿到 `SessionInputAdmissionPausedError`（被正确 defer），走直连（非排队）路径的调用者先撞上 `SessionInputSuspendedError{fence}`（不被 defer）。cron 恰好走直连：空闲会话时 `daemon-mode.ts:2052 promptUntilAccepted` / 心跳 steer 路径 → `_prompt` 的 7227 行 `_assertSessionActionAdmissionAvailable()` → 栅栏错误。窗口窄（teardown 期间 + `queuedActionCount` 可为 0 因而 `shouldDeferHeartbeatCronJob` 不先 skip），但后果是 once 任务静默消失且重启后不会重跑（status 已 completed，不在 `claimDue` 的 active 集合里）。

## 若成立：最小修复面

关键区分：`retryable` 语义是"同一进程内稍后重试能否成功"，而调度器需要的是"这次 tick 有没有交付任何东西"。三个 typed refusal（Paused / Coalescing / Suspended）的共同点都是**在入队与投递之前拒绝**，所以 run 记账（runCount/lastRunAt/lastError/completed）对三者都应该是"没跑"。因此：

1. `prompt-admission.ts:89` —— 把判定从 instanceof 清单改成读 typed 契约：新增
   `isSessionInputNonDeliveryRefusal(error)`，对三个类返回 true（或统一读 `error.retryable === true || error.suspendedForUpdateRestart === true` 之外的 "refusedBeforeDelivery" 判别位；最省事是给三个类各加一个 `readonly refusedWithoutDelivery = true` 并读该位）。
   同时保留现有 `isRetryableSessionInputRefusal` 的 `retryable` 语义，但把 `SessionInputSuspendedError` 纳入并返回 `error.retryable`（这一改动单独就修掉 D 组：`retryable=true` 的 abort 停车不再被烧）。
2. `cron-jobs.ts:1312` —— 调用点换成 1 的非投递谓词，defer 的**再触发节奏**按 `retryable` 分档：`retryable=true` → 现 `CRON_DEFERRED_RETRY_MS`(5s)；栅栏（`suspendedForUpdateRestart=true`）→ 用 restart-aware 的节奏（如 `CRON_STORE_FAILURE_RETRY_MS` 30s 档或等 restart），避免同进程内 5s 空转；任务本身留在盘上（scheduled-jobs.json），restart 后 `AgentCronScheduler.start() → recoverInterruptedDispatches`（cron-jobs.ts:1239）自然接住。
3. `daemon-mode.ts:2013`、`2061` —— 同一谓词，保持 hook 层与调度器层一致（只改 2 也能覆盖所有 hook，改 1+2 是最小面）。
4. 记账面顺带一条相邻缺口（本次未测，列出以防误判范围）：`recordDispatchResult` 的 "skipped" 分支（cron-jobs.ts:868-877）同样把 once 任务置 `completed` 但不写 runCount —— 与 `retryable` 无关，属 G5 设计意图（"skipped 表示已消费"），不在本修复面内动它。

## 未覆盖 / unverified

- 未跑真 daemon + 真 `abortForUpdateRestart` 端到端（本轮只做调度器 + store 层证据；可达性靠上述代码路径推读，标 unverified）。
- 心跳"栅栏 + 队列非空"时 `shouldDeferHeartbeatCronJob` 先返回 skip，走的是 skipped 分支，不在本假设路径上。
