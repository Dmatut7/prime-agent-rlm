# refine 超簇两刀拆分设计（wave-44 REFINE-DESIGN）

> 基线：HEAD=6c2304d77，agent-session.ts 19519 行（十刀后）。refine 超簇 = 调度 + 执行 + 入口，
> 三块共 ~1430 行体（含注释）/~32 方法 + 22 字段 + 7 类型/常量/错误类。
> 已在外：`core/refinement/`（纯函数层）、`core/harness-digest.ts`（digest 投递层，Host seam 模板）。

## 1. 依赖图摘要

### 执行块（第一刀候选）
`refine()`（public，外部调用：rpc-mode.ts、in-process-agent-connection.ts、daemon-mode.ts）、
`_planRefine`、`_applyRefine`、`_waitForRefineIdle`（barrier/泵/drain 都调，必须留壳）、
`_resolveRefinementModel`、`_reviewAutoRefine`、`_loadRefinementHistory`、
`_recordRefinementOutcome`、`_appendDurableRefineMessage`、`_emitRefineFailed`、
`_recordRefinementFailureReceipt`；错误类 `RefineSkippedError`/`RefinePersistScopeError` 与类型
`AutoRefineReviewRequest`/`AutoRefineReviewer` 从壳 re-export（测试 import 路径不破）。

### 调度块（第二刀候选）
serialized checkpoint 族（`_runSerializedRefineCheckpoint` 等 6 个）、`_maybeAutoRefine`、
`_scheduleAutoRefine*` 族、`_drainPendingRefinementForDisposal`、`handleRefineHostRequest`、
`_autoRefineAllowedForSession`、`_discardPendingAutoRefine`、`_invalidatePendingAutoRefineForBranchChange`、
`_consumePendingRequestedRefine`、`_runApprovedRefine` 等 21 方法 + `SerializedBackgroundPlanResult` +
`autoRefineInstructions` + `AUTO_REFINE_WRITABLE_PROBE_TTL_MS`。

### 字段（22 个，全部留壳）
`_pendingRequestedRefine`、`_refinementReportedEntryVersions`（public readonly，与 harness-digest
共享）、`_assistantTurnsSinceAutoRefine`、`_lastAutoRefineReviewAt`、`_autoRefineInProgress`、
`_autoRefineOperations`、`_scheduledAutoRefineTimers`、`_compactAutoRefinePending`、
`_turnIntervalAutoRefinePending`、`_pendingAutoRefineReview`、`_autoRefineBranchVersion`、
`_autoRefineReviewAbort`、`_autoRefineWritableProbe`、`_refineAbortController`、`_autoRefineReviewer`、
`_serializedRefine`、`_refineInFlight`、`_refinePlanInFlight`、`_serializedPlanInProgress` 族、
`_serializedPlanClaim`、`_serializedExplicitRefineOptions`、`_refineFailureReceipts`。

## 2. 两刀边界

- **第十一刀 `core/refine-execution.ts`（执行核）**：执行块 12 方法 + 4 类型/错误类；
  `RefineExecutionHost` 列执行面成员（含 `_serializedPlanInFlight`/`_serializedExplicitRefineOptions`
  ——`refine()` 会读写这两个调度字段，Host 注释点名跨簇权属）。体约 542 行，壳净减约 500。
- **第十二刀 `core/refine-scheduler.ts`（调度+入口）**：调度块 21 方法；模块单向 import
  execution（execution 是叶，无回边）。体约 890 行，壳净减约 850（→~18170）。

## 3. 守恒验证（照 quota-park/digest 先例）

每刀同一套：①逐字节比对（git show HEAD 抽体→归一化→逐一 diff，N/N 全等，脚本在 /tmp 不入仓）；
②`npm run check` 全量 EXIT 0；③钉测试全绿（refinement*.test.ts、refine-skill、
serialized-refine-config-integration、refine-extension、prompt、queue、kernel-host-request-whitelist、
daemon-protocol、2098、agent-session-concurrent）；④冻探针不破（字段留壳同名，hygiene 门计数不涨）；
⑤纯净树验证。

## 4. 风险

- R1 共享可变状态 `_refinementReportedEntryVersions`（execution 写、harness-digest 读）——两个 Host
  各自显式声明并注释权属；最大风险点。
- R2 回边：execution 的 `refine()` 读写调度字段；`_discardPendingAutoRefine` 调 compaction 簇的
  `_cancelPostCompactionContinue`——状态走 Host、函数单向 scheduler→execution，无模块循环。
- R3 daemon digest 不覆盖这些文件（wire 形状来自 core/refinement/index.js，纯搬不动 wire，
  不 bump schema）。
- R4 私有放松面 ~16 字段 + 11 方法，照先例；放松清单随刀进提交说明。
- R5 刹车语义逐字随行（writable-probe TTL 60s、branch-version 失效、cooldown 盖章、dispose drain
  顺序），守恒比对覆盖，禁「顺手优化」。
- R6 共享工位纪律：两刀各一提交；共享文件仅 agent-session.ts（+re-export）；提交前逐 hunk 核对、
  等绿窗、禁 --no-verify。
- R7 跨刀悬摆：第一刀后 serialized 簇留壳调 execution 壳，合法中间态。
- R8 平台分支：`isPersistentHarnessStorageSupported()` 早退逐字搬，Windows fail-closed 语义不变。
