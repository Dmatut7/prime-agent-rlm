# round-28 impl — LAT-6 / K3R-11（0902 终审簇②⑤）

- 冻结基线：主仓 HEAD **9866645e3**（只读，主仓零写入）
- 交付分支：**`r28/lat6-k3r11-fixes`**（两提交：`3fea6b2b7` 修复+红绿测试；`3a65ceaf8` changelog fragment）
- 施工工作树：`/tmp/audit_r/round-28/wt_impl2`（隔离自干净 checkout；原因见 §6）
- 报告：本文件

## 1. LAT-6（P2）：run 级 streamPreview 跨 assistant 消息残留

**修法**（`agent-session.ts` `_rlmChildStreamingPreviewText`，:13780-13797）：`message_start` 事件先 `run.streamPreview = undefined` 再 `??=` 重建——预览累加器是**每条 assistant 消息**的，不是每 run 的；`message_update` 仍走增量折叠，性能面不变（每消息一次 O(1) 重置）。`message_end` 全文重算照旧。

红（改前，`node vitest --run test/rlm-child-stream-scaling.test.ts`，4 测 2 红）：
- `resets the streaming preview when a second assistant message starts in the same run` — RED：第二条消息窗口内 preview 是 `"Done.ere is…"`（旧答案拼新消息词中切片），前缀一致性断言失败（对 0902 簇②-A 打穿输入 A 的端到端复现）。
- `recovers the preview when a capped first message is followed by a longer second message` — RED：M1 900 字符过 cap、M2 首 delta ≥900 ⇒ 非 structural ⇒ `cappedResult` 已置 ⇒ 整条 M2 冻结在 M1 的 cap 预览（簇②-A 输入 B；采集窗在 M2 的 message_end 处关闭，排除恒正确的全文重算层）。
- 正控（既有两测照旧绿）：单消息流式照旧增量/精确；`emitChildUpdate` 字段去重不变，preview 会变 ⇒ roster 更新照发。

夹具：`twoMessageAnswer()`——M1 短文+toolCall（`echo` 工具），工具执行后 M2 流式真答案；同一 `runRlmChild` run 内两条 assistant 消息，正是 LAT-2 增量层在生产里见到的形状。

## 2. K3R-11（P1）：manual 抢占把 threshold 自动压缩推进 cancelled 分支，销毁排队续跑

**修法**（`agent-session.ts`）：
1. `compact()`（:9998-10021）：抢占时把被 abort 的 controller 记到新字段 `_autoCompactionPreemptedByManual`（:1664-1666）；`finally` 里若发生过抢占则 `resumeQueuedWork()`——`_compact` 的 `abort()` 会挂起 session input pump，而排队续跑正是靠 pump 投递的，不复活就保而不投。
2. `_runAutoCompaction` catch（:11610-11650）：`aborted && _autoCompactionPreemptedByManual === autoCompactionAbort` ⇒ 记为"被 manual 抢占"：**跳过** `_clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction`（自主续跑留在 agent 队列 + `_postCompactionContinuationMessages`，与成功路径 :11608-11626 相同的队列语义）与 `_clearQueuedGoalContinuationAfterCancelledThresholdCompaction`（goal 续跑不取消、`continuationsUsed` 不回滚）；`_endCompactionUnsuccessfully("cancelled")` 披露照发（auto 压缩确实被取消了，诚实）。finally 清残留 marker（:11678-11680）。
3. `_maybeResumeGoalContinuationAfterRlmWork`（:2928-2954）：新增"已有 goal_context turn 在排队则不再 re-arm 排第二条"闸（与 `_clearQueuedGoalContexts` 同款判据 `payload.customMessage?.customType === GOAL_CONTEXT_CUSTOM_TYPE`）——manual compact 的 finally 会给活跃 goal 置 re-arm 标志，没有这闸会把保留下来的 goal 续跑翻倍。

红（改前，`test/suite/r26-k3r-compact-merge.test.ts`，7 测中 2 红）：
- `…preserves the queued goal continuation` — RED：`goal_update` 事件序列出现 1→0 回滚（0902 复现配方的 goal 面）。
- `…preserves the queued autonomous continuation` — RED：`getAutonomousStatus().continuationsUsed` 被回滚成 0、续跑被销毁、压缩后循环死等（pending response 永不消费）。
- 正控 `control: a user abort still cancels…` — **改前改后都绿**：真用户 `abortCompaction()`（:10271-10274 不设 marker）照旧走取消+回滚+不再续跑；`requestAbort`/teardown 路径同样不设 marker。既有 3 条 r26 测试（并发 manual 排队/合并/抢占）照旧绿。
- 夹具按 0902 配方：threshold（contextWindow 200k + reserveTokens 185k + 120k 字符 prompt；20k 窗口会先撞 overflow 分支，已避开）+ `shouldContinueAfterCompaction`（goal 经 faux ipython 工具排队；autonomous 经 `autonomous:{enabled,maxContinuations:1}` 排队，cap=1 防止续跑轮的自续跑噪声）+ extension 首调挂起等 abort。

## 3. 附带：第二个 manual 的 customInstructions 被 "Already compacted" 吞

- `_compact` catch（:10105-10113）：带 customInstructions 的 skip 改抛 `CompactionSkippedError("<原消息> — the custom instructions were not applied")`——直调方（slash 命令层）能看到指令没被消费；无指令的 skip 语义不变（`r25-concurrent-compact`/`agent-session-compaction-recovery-hint` 的既有断言原样绿）。
- 排队 `/compact` 的静默吞点（`_executeQueuedSessionCommand` 共享 catch 对 CompactionSkippedError 的 `return`）：`case "compact"` 内改为带指令的 skip 落一条可见 `session_slash_command_result` 行（:8418-8435）。
- 测试钉住直调面（`a skipped compact with instructions names the loss…`：A 成功后 B 拒绝并点名丢指令；无指令仍裸 "Already compacted"）。**如实**：排队 session-command 面的可见行没有独立端到端测试（复现需"turn 边界 auto 压缩先落盘 + 已排队 /compact 后投递"的组合，本轮 40 分钟窗内未搭）；且实测发现经 `prompt("/compact B")` 走的排队命令会先落一条 session_command 条目、从而绕开 already-compacted 门、真跑一次带 B 指令的压缩——该路径指令本就被消费，吞点只剩边界组合。两项都留给下轮。

## 4. 验证

- 红先绿后：两条红测在未改源码的工作树上先跑出失败（失败点即缺陷断言），修复后全绿。
- 本分支全绿面：`rlm-child-stream-scaling`(4) + `r26-k3r-compact-merge`(7)；回归面全绿：`agent-session-compaction`(26)+`agent-session-compaction-continuation`(22)、`agent-session-goal`(24)+`r25-concurrent-compact`(24)、`agent-session-compaction-recovery-hint`+`interactive-mode-compaction`+`agent-session-serialized-refine`(79)、`acp-features`(24)。
- `npx tsgo --noEmit` 在只含本改动的工作树 EXIT 0；pre-commit hook（`npm run check` 全量）随两次提交通过；biome 对 3 个改动文件零告警。
- 测试执行全部 `env -u RLM_* -u PRIME_AGENT_* -u PI_*`，直接 `node ../../node_modules/vitest/dist/cli.js`，分批 ≤3 文件、单命令 ≤60s、单文件 --run。

## 5. 未做/边界

- 未 push（合并窗口由母席裁）；未动 daemon 协议面；`emitChildUpdate` 字段去重未改（preview 修好后它不再是乱码冻结的成因）。
- 簇② 的 abort/续轮残留面（`run.streamPreview` 跨 abort 复用同一 run）被 message_start 重置顺带覆盖：每条新 assistant 消息都重置，旧窗口不可能再泄漏进新消息。

## 6. 纪律与异常披露

- 主仓只读零写入；未用 `doctor --fix`/`daemon ps -k`/`--no-verify`/`git add -A`；staged 清单逐文件核对（3 文件 + fragment 两次点名提交，无 amend）。
- **工作树撞车**：我先开的 `/tmp/audit_r/round-28/wt_impl` 在 02:52 起被并行的簇①施工道写入（`session-manager.ts` 修改 + 2 个未跟踪红测试 lat4-lat5/r28-cluster1，tsgo 报其类型错）。为不吞别人半成品、也避免共享树红测试挡我的 pre-commit hook，我另开隔离工作树 `wt_impl2`（干净 checkout + 只放本改动）完成提交；`wt_impl` 原样保留未动，簇①道可继续使用。
- `/tmp` 在本轮中途被清过一次（wt_r28/wt_r28_base 消失），故工作树挪进 `/tmp/audit_r/round-28/` 下。
