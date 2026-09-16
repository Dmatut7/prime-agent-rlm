# r43 K3C-1 施工报告：compact 30s 假失败 + kimi-k3 输入上限

日期：2026-09-16 · 席：r43 K3C 施工席（本席）
工作树：/tmp/audit_r/round-43/wt-k3c（detached @ 冻结 SHA ac1ec28e9 → 分支 r43/k3c-compact-input-limit，主仓零触碰）
诊断报告输入：/tmp/audit_r/round-43/k3-compact-fail.md（K3 r43 诊断席，带老板截图证据）

## 结论（TL;DR）

K3C-1 双根因都已修，先红后绿，全部测试绿：
- **① 时序面（选择：最小修）**：`daemon-agent-connection.ts` 的 `compact()` 显式传 10 分钟请求预算（新常量 `DAEMON_COMPACT_REQUEST_TIMEOUT_MS`，与 refine 同档），超时错误追加「daemon 大概率仍在压缩，结果会随 compaction_end 事件落地，勿立刻重试」。未做「受理即 ack + 事件交付」重构（取舍见下）。
- **② 窗口面**：`model-input-limits.ts` 的 `MEASURED_PROVIDER_INPUT_LIMITS` 新增 bailian/kimi-k3：maxInputTokens=1000000，evidence 逐字引用截图报错 "Range of input length should be [1, 1000000]" + K3 线直探 986755 token 仍 200 的正控。有效输入上限从 1048576 钳到 1000000，`catalogOverDeclaration` 现在能报出 {declared:1048576, measured:1000000}。

## ① 的取舍：为什么选最小修而不是「受理即 ack + compaction_end 交付」

**方案 A（重构）按本仓 daemon 协议规则的成本**：compact 的 daemon 有线响应 data 从 `CompactionResult` 变成受理 ack，属于响应形状变更。AGENTS.md「Daemon Protocol Changes」要求：每次命令/响应形状变更分级（兼容/能力门控/不兼容）、加协商能力、两方向兼容测试（新客户端×旧 daemon、旧客户端×新 daemon）、动 DAEMON_SCHEMA_REVISION。rpc/ACP/TUI 扩展上下文三个消费者都要跟着改拿结果的方式。这不是 45 分钟量级能安全落地的改动，且改错面是协议层。
**方案 B（最小修，已实施）的成本**：保留「等一个长请求」形态——超过 10 分钟的压缩仍会超时（实测最慢 GLM 590k ≈100s、K3@max 590k ≈45-73s，10 分钟有 6 倍余量）；客户端断连时 worker 关断仍会把进行中压缩打成 cancelled 的歧义态没有被本修消除（诊断报告的附带发现，建议另开任务做方案 A）。
**决策依据**：任务书「二选一按最小改动」+ 既有先例——`refine()`（同类长耗时 session 命令）已经用 `DAEMON_REFINE_REQUEST_TIMEOUT_MS = 10min` 这个模式，compact 对齐即可，一处改动零协议面。

## 实际改动（5 个文件，全在 packages/coding-agent）

1. `src/modes/agent-connection/daemon-agent-connection.ts`
   - 新增 `export const DAEMON_COMPACT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000`（注释写明观测数据来源）。
   - `compact()`：`requestData` 显式传该预算；catch `DaemonRequestTimeoutError` 后 rethrow 追加句 `The daemon is likely still compacting this session; the result will land with the next compaction_end event, so check the session state instead of retrying immediately.`（cause 链保留原错误）。
   - 覆盖面：rpc-mode:284、TUI 扩展上下文 interactive-mode.ts:3229、ACP 走 connection 的路径全部吃到；in-process 连接不经 daemon 有线，无 30s 闸，不受影响。
2. `src/core/model-input-limits.ts`
   - `MEASURED_PROVIDER_INPUT_LIMITS` 追加 bailian/kimi-k3 记录（maxInputTokens 1000000，measuredAt 2026-09-16，evidence 含截图逐字报错 + 986755 直探 200 正控 + models.json 声明 1048576 的事实）。
   - 机制零改动：`effectiveInputLimitTokens`/`catalogOverDeclaration` 现有逻辑自动生效（声明>实测 → 钳制+上报）。
3. `test/agent-connection-daemon.test.ts`（红→绿）
   - FakeDaemonClient 新增 `compact` case：复刻真客户端语义（绝对预算定时器 reject `DaemonRequestTimeoutError` + 延迟回 CompactionResult），字段 `compactResponseDelayMs`/`compactionResult`。
   - 红测 1「waits out a compaction whose summarizer runs past the 30s default」：45s 假桩慢 summarizer，推进 31s 断言**不再假失败**（改前逐字红：`Timed out after 30000ms waiting for the Prime Agent daemon response to "compact"`，与生产失败逐字一致），推进到 45s 后拿到完整 CompactionResult；并断言请求预算=600000（改前=30000）。
   - 红测 2「tells the user the daemon is still compacting」：永不应答假桩，推进 601s 断言错误含 `Timed out after 600000ms` + 含「likely still compacting」指引（改前红：30000ms + 无指引句）。
4. `test/compaction-summarization-budget.test.ts`（红→绿）
   - 红测 3「pins the measured Bailian kimi-k3 input limit」：`measuredInputLimit`/`effectiveInputLimitTokens(1048576)===1000000`（改前红：undefined/1048576）。
   - 红测 4「reports the kimi-k3 catalog over-declaration」：`catalogOverDeclaration(1048576)` 报 {declared:1048576, measured:1000000}（改前红：undefined），正控=声明恰为 1000000 时返回 undefined。
5. `.changes/r43-k3c-compact-timeout-k3-input-limit.md`：两条 changelog fragment（用户可见：compact 假失败修复 + kimi-k3 有效输入上限修正）。

## 验证记录

- 红阶段（改 src 前）：4 个新测试全红，失败原因逐字即诊断报告的生产失败形态（30s timeout 假失败 / kimi-k3 上限未实测）。
- 绿阶段：两文件全量 `node ../../node_modules/vitest/dist/cli.js --run`（unset RLM_*/PRIME_AGENT_*/PI_* 泄露变量）：
  - `test/agent-connection-daemon.test.ts`：102 passed
  - `test/compaction-summarization-budget.test.ts`：50 passed
- `npx biome check --error-on-warnings`（4 个改动文件）：EXIT 0。
- `npx tsgo --noEmit`（packages/coding-agent）：EXIT=0。
- 提交走 husky pre-commit（repo 级 `npm run check`）：**通过**，提交 `ed0cb2ba0`（5 files, +157/-5），提交后 `git status` 干净。
- 裸树复核（AGENTS.md 规则）：`git archive HEAD` 解包 + symlink node_modules 后 `npx tsgo --noEmit` EXIT=0，同两测试文件 152 passed（TEST_EXIT=0）。
- 未跑 `npm run build`（本任务无 bundle 交付要求）；未动 daemon 协议版本/schema（客户端侧超时+文案改动，无有线索状变更）。

## 提交

- 分支 r43/k3c-compact-input-limit（冻结基线 ac1ec28e9），逐文件 `git add` + staged 清单核对（5 文件，无他人文件卷入）。
- 提交 `ed0cb2ba0`，提交信息含根因与取舍说明；工作树保留于 /tmp/audit_r/round-43/wt-k3c 供巡检。

## 遗留与建议（不在本任务范围）

1. 「受理即 ack + compaction_end 交付」方案 A 仍值得做（消除断连歧义态 + >10min 兜底），按协议变更流程单独立项。
2. 诊断报告附带发现：`armPendingRequestTimeout` 触发后晚到的成功响应被静默丢弃，建议 debug 日志记 late-response。
3. models.json 的 kimi-k3 `contextWindow: 1048576` 声明本身建议改成 1000000（catalogOverDeclaration 已能报出该缺口，本轮只做了运行时钳制）。
