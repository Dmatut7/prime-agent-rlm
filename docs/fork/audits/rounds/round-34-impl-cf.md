# r34 · CF-1/CF-2 修复交付（压缩保真线）

- 冻结 SHA：`438d33383605ed22c6111cf05851486d948e9d5f`（主仓 HEAD，只读）；工作树 `/tmp/r34impl`（branch `impl-r34-cf`，node_modules→主仓 symlink）
- 修复提交：`c3af1e8ba`（仅本车道 6 个文件，staged 逐一核对过；audit-r34/ 与 /tmp 工件不入仓）
- 依据报告：`/tmp/audit_r/round-34/compaction-fidelity.md`（红线：role-custom 收集缺口、head-elision 零拷贝、elided 披露不进压缩后上下文、系统提示词零 compaction 引导）
- 红证脚本（无 LLM、驱动真实代码路径）：`/tmp/r34impl/audit-r34/verify-elision.ts`，归档副本 `/tmp/r34out/verify-elision.ts`；复跑：`cd /tmp/r34impl && node node_modules/.bin/tsx audit-r34/verify-elision.ts`

## 先红后绿

红（冻结 SHA 上、改动前）：`test/compaction-task-brief-fidelity.test.ts` 9 例中 7 红——
- CF-1①：collectUserRequests 对 custom（agent_message 任务简报）零收集；heartbeat/回执同判。
- CF-1②：budgetSummarizationInput 头部 elide 吞掉首条任务简报（管线级红：summarizer prompt 实测 "[Note: 9 older message(s) were elided…" 且不含简报锚点，即 R34-①-RED-1 的原样复现）。
- CF-2①②：压缩后上下文无 elision 披露、无"摘要可能不完整"引导。
绿（`c3af1e8ba`）：9/9 过；verify-elision.ts 6/6 PASS。

## 改了什么

**CF-1①（收集器补 custom 形态）** `compaction/user-requests.ts`
- 新增 `customUserIntentText`：`agent_message`（isAgentSessionMessage 守卫，收 `details.message` 发送者原文）与 `heartbeat_prompt`（收 content，kind=user）照 role=user 语义逐字入账；slash-command/compaction/refinement 回执、rlm_child_failure/terminal notice、ipython_state、未知扩展形态一律不收（纯机器回执）。
- kind 增加 `"agent_message"`（wire/parse/details 三处映射归一到 `normalizeUserRequestKind`）；BLOCK_HEADER 说明三通道来源。
- 新增导出 `isUserIntentMessage`：收集语义与 elide 保护共用一个判定，消掉审计指出的"同一消息在 cut-point 与收集器两套身份"的不一致。

**CF-1②（head elide 不再吞任务简报）** `compaction/compaction.ts` budgetSummarizationInput
- 首条 user-intent 消息（user/bashExecution/agent_message/heartbeat，即首条用户请求或任务简报）钉进 elide 保护集（照 fact-appendix FACT_KIND_MINIMUM 的"关键集合先于预算排名"先例）：预算吃紧时先让最老的保留消息让位，仍保持"最新消息永远保留"；首条请求本身就超整个预算时不钉（退化为旧行为）。elided 计数照实扣减。
- 契约变化：`test/compaction-summary-budget.test.ts` 一例按新契约改写（旧断言"丢 old 保 mid"，新断言"钉住首条请求 old、让位 mid"），改写原因与语义写在用例注释。

**CF-2①（摘要自述头披露省略）** `compaction/compaction.ts`
- `SummarySlice` 增加 `elidedMessages`/`elidedChars`（summarizer 侧已算的两处：budgetSummarizationInput 的消息级 elide 与 clampConversationText 的字符级 drop），`completeSummarizationRequest` 透传，`compact()` 跨 slice（split-turn 两发合计）聚合。
- 有省略时在摘要头部（narrative 之前）渲染机器可读披露块：`<compaction-elision messages="N" chars="M">This summary has omissions: … may be missing entirely …</compaction-elision>`；故意不用 machine-block 标签（非确定性重建物），`stripCompactionElision` 在 `prepareCompaction` 读 previousSummary 时剥头，跨代不累积。

**CF-2②（压缩后首轮注入 compaction 事实）** `core/messages.ts` COMPACTION_SUMMARY_PREFIX
- 前缀加一句："Compaction is lossy: this summary may be incomplete … Treat the machine-generated blocks … and other persistent records as authoritative for exact constraints and values, and re-check anything load-bearing that only this summary's narrative states."——选"压缩后首轮注入"路径而非改常驻系统提示词：只有真的压缩过的会话才看到该句。

**CF-3（触发语义不等价）不修**：晚触发一发 vs 早触发+更新的保真差异是触发时机的产品取舍（保留窗口/代际结构由触发路径决定），登记待产品侧拍板，不在本轮代码面动。

## 验证

- 直接 node 调 vitest（unset 全部 RLM_*/PRIME_AGENT_*/PI_* 泄露变量），分批 ≤3 文件：
  - 新增 `compaction-task-brief-fidelity.test.ts`（9 例）＋改写 `compaction-summary-budget.test.ts`：绿。
  - compaction-* 全家 20 个文件分批：绿（compaction.test.ts 28 过 2 skip、fact-appendix 48、summarization-request-limit 12、turn-alignment 14、user-requests 20 等）。
  - messages 侧（session-command-messages / refinement-outcome-message / block-images）与 agent-session 侧（acp-rlm-subagents / child-usage-lookup / recursion / semantic-edges / r24-impl-tail / r31 / session-tree-wire-bounds）：绿。
  - 唯一红：`agent-session-recursion.test.ts > loads the ephemeral RLM harness path into the host system prompt`——主仓同 SHA 裸跑同样红（环境依赖，预存，与本改动无关）。
- `npx tsgo --noEmit`：0 error；biome（改动文件）clean；`npm run check` 的 biome --write 只动了本车道文件（git status 核对过，无外带）。
- 提交后 pristine-tree 复验：`git archive HEAD` 解包＋node_modules symlink＋`tsgo --noEmit`＝0 error（见下）。
- 行为面复跑：verify-elision.ts 在 30k 窗口压力下确认 brief 进 ledger、进 summarizer 输入（elided=7/13 仍钉住首条）、压缩后上下文含 `messages="N"` 披露与 lossy 引导。

## 风险与边界

- 钉保护不抗字符级 clamp（clampConversationText 丢最老字符）——仅在序列化膨胀挤爆预算的退化场景发生，此时按"最新优先"旧语义退化并有 droppedChars 披露；未加 per-message 开销会计（避免再动预算语义）。
- agent_message 收集收的是 details.message 原文；旧 entries 无 details 的 legacy 形态不收（isAgentSessionMessage 守卫）。
- 摘要头披露是"一次性事实"（本代 summarizer 输入侧的省略数），跨代剥离；summarizer 侧 elidedNote 原样保留。
- 不改触发语义、不改 machine-blocks 标签集（compaction-elision 不参与 anchored tail 解析，BLOCK_DELIMITER_SHAPE 不受影响）。

## 复验补充

- pristine-tree：`git archive c3af1e8ba | tar -x -C /tmp/r34pristine` + node_modules symlink + `npx tsgo --noEmit` → 0 error。
- 跨代剥离：gen-2 `prepareCompaction` 读到的 previousSummary 不含上一代 `compaction-elision` 披露（stripCompactionElision 生效，披露不跨代累积）。
- 红证脚本归档：/tmp/r34out/verify-elision.ts（运行副本在 /tmp/r34impl/audit-r34/，tsx 从工作树根跑）。
