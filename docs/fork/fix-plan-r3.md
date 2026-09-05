# 修复计划（R3 · 2026-09-05）

> 2026-09-05 全面复审的修复计划。发现记录见 **`review-findings-r3.md`**；汇总入口见根目录 **`FORK_NOTES.md`**。

## 总闸（硬约束，凌驾性能 / 简洁 / 行数）
**任何优化都不能降低 AI 的能力。** 每个任务带强制首字段「capability impact」：提升 / 中性（须证输出逐字不变）/ 禁止降低。
- 性能优化必须「中性」+ 证明（最终产物——AI 看到的 tool-call arguments、流式文本、上下文、崩溃恢复语义——与优化前逐字相同）；无法证明中性 → 标「宁可不做」移出主批。
- 压缩类验收写死「有效上下文不降」；死代码删验收加「capability-neutral 双证」（零引用两侧核过 + 不删 AI 行为依赖面）。
- 实战已抓出并否决 2 个违例修法（T6a `keepRecentTokens` 20000→8000 降低保留原文；候选②把"逐字原文"口径偷换成"原文+有损摘要"）。

## 信任阶梯
- **L1 自主合并**：纯死代码删 / 纯重构搬移 / 修法已收敛且无用户可见行为变化的小修。
- **L2 gate 老板**：协议 wire / 计费 / 用户可见行为变化 / 性能语义弱化 / 架构 / 发布面删除。
- 第一批 7 条：T12 / T0 = L1（中性、零生产代码、变异测试锁住）；T5 / T3a / T9 / T7 / T1c = L2（用户可见行为变化）。

## 施工纪律
- **异构规则**：施工方 ≠ 复核方模型（0902 × K3），禁同模型自审。
- 每任务独立分支；每条带回归测试（先红后绿）+ 变异测试（锁住每个修法分量，半变异也得红）+ changelog fragment + `npm run check` 全绿。
- **R3 前置**：R3-交集任务须先 R3 merge-back（到 schema27 基线）再修，否则冲突；零交集任务立即并行。

## 状态（截至 2026-09-05）
- ✅ **第一批 7 条**（T12 / T0 / T5 / T3a / T9 / T7 / T1c）：已合并 + 推送 `merge/repl-kernel` @ `4871d9223`。
- ⏸️ **剩余 21 簇**：gated on **F4**（R3 merge-back 被别车道未提交的 `openai-completions.ts` 阻塞）。

---

## 批次总览

**第一批·可立即开工(零 R3 交集·双审 D1/P4 修正后)**:T1c(UI argsSignature)、T3a(editor 递归守卫·提升)、T5(google stopReason·提升·L2)、T7(journal)、T12(sleep 泄漏)、T0 前置(CI 门+测试可信度三修)、T9(anthropic 签名·提升·L2·带注:anthropic.ts 在 R3 diff 但改 :80 距签名 ~1000 行可立即)。
**第一批·等 R3 merge-back(R3 交集)**:T1a/T1b(provider/daemon 节流)、T2a/T2b/T2c(fork 错误恢复·T2b 绑 T6b)、T4(放大器)、T6a/T6b/T6c(压缩三机制)、T8(OSC133·撞 assistant-message.ts)、T10(K5 retry)、T11(BrandSplash·撞 interactive-mode+agents-view-mode)、**T13(新·H7 side-question/子代理 streamStallTimeoutMs·提升·撞 agent-loop/agent-session/side-question 需核 R3 交集)**。
**第二批 9 项**:F9(含F27计费)/F10/F11(schema27上)/F14/F15(T3契约工单)/F16/F24/F25/F26(junk T0纯删·但13孤儿脚本+skipConversationRestore挂老板见§5)。
**第三批架构**:F17(子序)/F18/F19(含B1 recap_update静默丢事件·实测interactive-mode.ts对recap_update零命中=活bug·明写第三批F19内拆小卡有主、不写"可前移"无主)/F20/F21(F17后)/F23b/F27余项。
**F28 挂决策3**。

### T0 前置件(第一批开工前装·双审 P5/C2/0902-T0)
- **T0a CI 门「新测试禁 as unknown as {_ / vi.spyOn(x,"_")」**:形态=**diff-scoped/基线冻结**·**扫描范围写死 `packages/*/test/**` 且禁 `rg --follow`**(防走进 node_modules、尤其主仓预存的 node_modules/node_modules→exec-stuck 绝对符号链接会捞别车道假阳性;每新 worktree 建完 unlink 该链接)(存量违规实测 ~311:as unknown as {_ 172处/34文件 + vi.spyOn(x,"_" 139处/12文件⇒全仓扫恒假红、且 pre-commit 跑全量 check+禁--no-verify⇒全仓门会阻塞所有车道含 R3 merge-back)。落 ci.yml 只对新增/改动行扫+正控(造一个违规确认门会红)+基线文件冻结存量。capability:中性。L1。
- **T0b 测试可信度三修(每卡"回归门绿"的地基·双审 C2)**:#28 model-registry.test.ts:100/113/308 循环前补 length 断言(空集合不再静默全绿)/#31 tokens.test.ts 4×无条件 it.skip 补理由或改 skipIf/A3 empty.test.ts:33-41"错误也算通过"helper 改成真断言被测命题。capability:中性(测试加固)。L1。**这三条不修则后续所有任务的"回归门绿"建在空测试上**。

### 未入簇发现处置清单【双审 P1/C1 补·~29 项已证实发现 v1 漏交代】
| 发现 | 来源 | 处置 |
|---|---|---|
| H7 side-question/子代理 streamStallTimeoutMs 漏接(流停滞永久挂起零诊断) | quality-0902 H7+K3加料 | **新增 T13·第一批·提升·削能力 bug** |
| B3 refine 窗口丢 assistant 消息(不落盘不渲染) | correctness-0902 B3+K3证实 | 新增 T14·第一批·提升(barrier 移进 fence) |
| K2 bash timeout 溢出(>24.85天→钳1ms杀进程报错超时·实机复现) | correctness-K3 K2+0902复现 | 新增 T15·第二批·提升(加上界钳制) |
| K4 result() 不在 raceStall 内(永不settle连stall都救不了) | correctness-K3 K4+0902 D3上调 | 并入 T4 放大器/或独立·第二批 |
| E2 capability 拒绝分支 admissionId 永久占用 | correctness-0902 E2 | 第二批·提升(补 deletePromptAdmission) |
| E7 autocomplete 补全链 0 try/catch(provider抛一次后永久rejected) | correctness-0902 E7 | 第二批·提升 |
| E9 EventEmitter error 够不着终端恢复路径 | correctness-0902 E9 | 并入 T4(TUI 进程兜底) |
| zai→glm-5.1 catalog 漂移(兜底 glm-4.7 旧模型+test钉陈旧值) | provider 双向 M5/M7 | 第二批·提升(指向 glm-5.3+加 catalog 断言) |
| M1 forwardStream async IIFE 无 catch(第三方provider unhandled rejection永久挂起) | provider-K3 M1+0902补 | 第二批·提升(补.catch转error) |
| 其余 ~20 项(各 lane 中低信号) | 各 lane | 第三批/缓做·详见各 lane 报告 |

---

## 依赖关系

1. F21(AgentConnection)后于 F17(god-object);F17 先解 sdk:88→runtime:774→services:18 值级互环;F17 内部 P0/P1→P2+Scheduler→P3/P4(测试重写)。
2. F4 内部:先放大器(supervisor 入口+TUI 进程兜底+persistWorker try)后 6 活口。
3. F1 内部:T1a(provider 节流)/T1b(daemon seed)/T1c(UI)三侧验收互相引用(daemon 中途 attach 是硬约束=provider 必保留 finalize 完整 parse);**【G9】F1 不止 7 处 provider、漏 proxy.ts:307 + compact-session-stream.ts:170(后者已有 delta.toolCallArguments 快照通道⇒T1a/T1b 非完全独立、需协调)**。
4. **【P2 K3 独有·关键】T2b(补 DashScope overflow 模式)会激活 T6b(K1 无界循环):修复前 bailian 路径该循环休眠(overflow.ts OVERFLOW_PATTERNS 实测20条regex零匹配dashscope|qwen|bailian⇒根本不进 overflow 分支)、T2b 修好后 bailian 超限才真进 overflow 分支⇒唤醒 K1 复位循环烧钱。T2b 与 T6b 必须绑定同批合并、禁 T2b 单独上线**。
5. **【D4】F16↔F9/F27 计费同在 cache-pricing/applyServiceTierPricing 函数;F10/F25/F9/T1a 同文件 openai-responses-shared.ts⇒同文件任务串行或同分支避免互撞**。
6. **【D5】T4(放大器)↔T7(journal)同 worker 写路径、T4 等 R3 而 T7 立即⇒T7 改动需避免与 T4 的 persistWorker/worker 兜底冲突(协调或 T7 先做 worker journal 侧、T4 后做 worker crash 侧)**。
7. **【D3 补】F20"新测试禁 as unknown as {_ / vi.spyOn(x,_)"CI 门前移第一批 T0 前置(防继续养 god-object 测试锁)**。
