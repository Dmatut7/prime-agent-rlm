# r37 · G1-G4 修复落地（impl-g）

- 主仓：/Users/a1/Desktop/ai/prime-agent @ 9502fd0fd（只读）；工作树 /tmp/audit_r/round-37/impl-g-work（detached @ 9502fd0fd，node_modules symlink 主仓）
- 依据：/tmp/audit_r/round-37/hbgoal-ts/hbgoal-ts.md（G1/G2/G3/G4+G5）
- 纪律：先红后绿（8 个红测改前全红，逐一实证）；测试 env -u 泄露变量、node 直调 vitest、分批 ≤3 文件；单命令 ≤60s；零 doctor --fix / daemon ps -k

## 修复内容（全部先红后绿）

**G1 goal 续跑上限**（src/core/goals.ts + agent-session.ts）
- 新常量 `MAX_GOAL_CONTINUATIONS = 3`（与 autonomous 默认 maxContinuations 同值）。
- 新私有 `_goalContinuationBudgetExhausted()`：达上限时把 goal 置 `budget_limited`，`lastReason="goal continuation budget exhausted (3/3 continuations); the goal stopped to avoid unbounded turns"`（持久化 thread_goal_state + goal_update 事件＝留痕），首次观察到即生效。
- 三处增量点全部加闸：`_getGoalContinuationMessages`（自然停）、`_maybeResumeGoalContinuationAfterRlmWork`（RLM 工作收束后恢复，并清 `_goalContinuationAwaitsRlmWork` 防悬挂重试）、`_queueGoalContinuationForThresholdCompaction`（阈值压缩续跑）。
- 语义：闸只拦自动续跑；用户 prompt 驱动的 turn 不受限；`/goal resume` 不重置预算（暂停/恢复不赠送续跑额度，需 clear+重建）。
- 红测：`agent-session-goal.test.ts` "stops goal continuation at the continuation budget..."——改前 7 turns 全烧光（goal 恒 active），改后 1+3=4 turns、剩 3 条 faux 响应未耗、status budget_limited、lastReason 含停因。

**G2 includeGoals 继承收紧**（agent-session.ts）
- `_createRlmSubagentRuntimeOptions`：`includeGoals: this._includeGoals` → `includeGoals: false`（子代理 rlmDepth≥1 一律不继承；与 CLI initialGoal 仅 depth-0 播种的闸对称；inline 与 daemon 两条创建路径都经此点）。效果：goal skill 不入子会话可见技能、goal.get/create/complete host handler 不注册（kernel 侧变 Python 异常）。
- passivate 悬挂 goal 恢复路径（可修，非仅 note）：构造期若 `rlmDepth>0 && !_includeGoals && 持久化 goal active` → `_finishGoalWithError("Goals are disabled for this subagent session (goal persisted before it was disabled).")`——旧版本留下的子 goal 在重水化时显式转 error 而非无限悬挂。
- 红测×2：①`agent-session-recursion.test.ts` "denies goal.create inside a spawned subagent..."——改前子会话 goal.create 成功（红：不抛），改后抛 "goals are disabled in this session"；②`agent-session-goal.test.ts` "terminates a persisted active goal when goals are disabled..."——改前 status active（悬挂），改后 error+lastError 含 disabled。

**G3 rlm_heartbeat 条数上限 + 60s 最小间隔**（cron-jobs.ts）
- 新导出常量 `MAX_RLM_HEARTBEATS_PER_SESSION = 8`、`MIN_RLM_HEARTBEAT_INTERVAL_MS = 60_000`。
- `createRlmHeartbeat`：同 activeSessionId 的 active/paused rlm_heartbeat ≥8 时抛 `Too many RLM heartbeats ... at most 8 ... delete one first (rlm_heartbeat.delete)`（带提示）；interval 型 schedule <60s 抛 `RLM heartbeat interval must be at least 60 seconds (got "...")`。`updateRlmHeartbeat` 的 scheduleText 分支同样加 60s 闸（防绕过）。
- 范围刻意只限 rlm_heartbeat（模型自建面）：用户级 /heartbeat 维持原 10s 下限与单条 LWW（hbgoal-ts N2 的边界保持不变）；存量 30s 任务不受影响（只在创建/改期时校验）。
- 红测×2（cron-jobs.test.ts）：第 9 条抛错（改前不抛）+ delete 后槽位释放 + 每会话独立；create/update 30s、45s 抛错（改前成功）+ 60s 正控 + 用户级 30s 正控。

**G4+G5 续跑计数与心跳记账诚实性**（agent-session.ts + daemon-mode.ts）
- G4：`_queueGoalContinuationForThresholdCompaction` catch 里回滚 `continuationsUsed`（快照 goalBeforeQueue → `_setGoalState(goalBeforeQueue)`），对齐同文件 `_maybeResumeGoalContinuationAfterRlmWork` 的既有回滚先例。红测（agent-session-compaction-continuation.test.ts，全公共 API：`acquireSessionInputPause` 在 streaming 中持住 + 大文本跨阈值）：改前 continuationsUsed=2 无对应 queued action，改后=0。
- G5：`_promptInjectedMessage` 返回 `{admitted, coalesced}`（新导出类型 `AgentHeartbeatPromptResult`）；`promptHeartbeat` 透传；daemon `runCronJob` 心跳分支对 `!admitted` 返回 `"skipped"` → `queueDispatch` 走既有 skipped 记账（runCount 不 +1、lastRunAt 不动、`lastSkippedAt` 留痕）。旧 mock（返回 undefined）按 admitted 处理，行为向后兼容。
- 红测×2：①agent-session-concurrent.test.ts 真会话双跳同 queueKey——改前返回 void（断言 admitted/coalesced 全 undefined），改后 {true,false}→{false,true}；②daemon-mode.test.ts fixture mock 返回 {admitted:false}——改前 runCronJob 返回 undefined 记 ran，改后 "skipped"。

## 回归面（env -u 泄露变量；分批 ≤3 文件）
- 全绿：agent-session-goal(47)、cron-jobs(68)、daemon-mode(189)、compaction-continuation(11)、agent-session-concurrent(21)、goal-continuation-quiescence(7)、kernel-goal-skill、kernel-rlm-heartbeat-skill、agent-session-queue-mutation、heartbeat-catalog/manager、daemon-supervisor-heartbeats、interactive-heartbeat×2、regressions 4482/4519/4536、agent-session-compaction(42)、compaction-storm。
- 已知预存红（对照面）：agent-session-recursion.test.ts "loads the ephemeral RLM harness path into the host system prompt" ——在冻结 SHA 9502fd0fd 的 pristine 对照工作树（/tmp/audit_r/round-37/impl-g-ctrl）同样失败（r34 已记录的本地环境依赖红），与本次改动无关；本文件其余 123 测全绿。
- 适配性测试改动（非行为断言）：cron-jobs.test.ts 5 处、daemon-mode.test.ts 9 处 rlm_heartbeat 种子 "every 30s"→"every 60s"（新下限）；goal-continuation-quiescence harness 补 `_goalContinuationBudgetExhausted: () => false` stub（方法提取式单测的 stub 面）；daemon fixture/4519 mock 的 promptHeartbeat 返回值改为新形状；suite/harness.ts 加可选 `includeGoals` 透传。
- `npx tsgo --noEmit` EXIT=0；`biome check` 13 文件全过（自动格式化 5 文件后 8 个红测复跑仍全绿）；`check:test-hygiene` OK（无新增私有探针，未用任何 allow 标记）。

## 提交
- commit `030b1ada4`（工作树 /tmp/audit_r/round-37/impl-g-work，detached @ 9502fd0fd）：14 files changed, +357/-24，含 changelog fragment `packages/coding-agent/.changes/r37-goal-heartbeat-budgets.md`；git add 逐文件、staged 核对（无他人文件）。
- pristine-tree 复核：`git archive 030b1ada4` 解包 + symlink node_modules + `npx tsgo --noEmit` EXIT=0。
- 主仓零写入（除 git worktree 注册表）；对照用 ctrl 工作树已移除。

## 未尽事项
- daemon-supervisor-process.test.ts（跨进程 lastSkippedAt 面）未跑——多进程套件超时预算外；其语义未被本次触碰（skipped 记账机制沿用原路径）。
- G1 的 budget_limited 停止不额外排一个 wrap-up turn（避免再烧一个 turn，与"显式停"目标一致）；如需模型侧告别语可后续加 budget_limit steer。
