# r33 泛扫：轴④ usage 记账 + 轴⑤ thinking 流透出（packages/ai provider 层）

- 审计对象：`/Users/a1/Desktop/ai/prime-agent`，派单冻结 SHA `b2e505e058b24f60f8af835de0f070b3f15b7592`
- 取证时工作树 HEAD 已前进到 `07fc6abe16f2c2f80f1fd6778bdfff10d1fd90d5`（仅别的车道补 docs/fork/audits）；
  `git diff --stat b2e505e0..HEAD -- packages/ai/src` 为空 ⇒ 本报告所有 file:line 在冻结 SHA 上逐字成立。
- 方法：只用 **node+tsx 起本地服务伪造 provider 流**，驱动真实 provider `stream()`（含真实 SDK：openai / anthropic / @google/genai / @mistralai / @aws-sdk/client-bedrock-runtime），
  打印事件序列与 `output.usage` 逐字证据。Bedrock 走 `http2` + `application/vnd.amazon.eventstream` 二进制帧（zlib.crc32 手写帧）。
- 复现脚本（全部在 `/tmp/r33_e4/`，只读、无仓库写入）：`harness.ts`(本地 SSE/h2 假服务 + drain)、
  `anthropic_probe.ts`、`oc_probe.ts`、`google_probe.ts`、`resp_probe.ts`、`mistral_probe.ts`、`bedrock_probe.ts`；
  原始输出 `out_<provider>.txt`。
- 运行方式：`cd packages/ai && env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_AGENT_ID -u PRIME_AGENT_SESSION -u PI_SESSION_DIR npx tsx /tmp/r33_e4/<probe>.ts`
  （bedrock 另加 `AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1`）。

## 直接回答派单问题

| 问题 | 答案 | 证据 |
|---|---|---|
| 同一 provider 多 chunk usage 覆盖还是累加？ | **覆盖**（无任何累加/合并）：openai-completions 整体替换 usage 对象；google/vertex 整体替换；responses 整体替换；mistral/bedrock/anthropic 逐字段赋值 | B2/B3、G3、M2/M3、BR2、A3/A8（见 E4-1） |
| `message_delta` 会覆盖 `message_start` 的 input_tokens 吗？ | **null 不会，显式 0 会**：守卫是 `!= null`（anthropic.ts:762-773），零值照写 | A2 保 1000；A8 变 0 |
| responses API 只给 total 不给明细？ | 反向：responses **只给明细、`total_tokens` 缺失时 total 直接 0**（无分项兜底） | R4（input 1000/output 50/total 0）、E4-2 |
| reasoning token 算了两次吗？ | 未发现重报。openai-completions 假定 `completion_tokens` 已含 reasoning（1338），responses 亦然（未读 `output_tokens_details`）；google/vertex **显式相加** `candidatesTokenCount + thoughtsTokenCount`。仓库无 `Usage.reasoning` 字段（types.ts:238 区），所以"provider 分开报 reasoning"时是少记而非重复 | B1(50 含 30 reasoning 未翻倍)、R1、G1/G4 |
| 残缺 usage（部分字段 undefined）会不会把已累计值清零？ | **会**，除 anthropic 外全部 provider；mistral 更狠——SDK 入参 schema 对缺失字段 `.default(0)`，残缺直接变显式 0 | B3、G3、M2/M3、BR2 |
| total_tokens 与分项和不一致怎么办？ | 四类口径：(a) 自算 sum（anthropic 615/774、openai-completions 1345）；(b) 用 provider total、缺失时 sum 兜底（mistral 312、bedrock 462）；(c) 只信 provider total、缺失即 0（google 228、vertex 245、responses 502）；(d) 忽略 provider total 完全自算（openai-completions 不读 `total_tokens`，B8 实测 provider total=7 被丢弃） | E4-2、E4-3、B8 |
| thinking 是否 emit 到 UI？ | provider 层都 `stream.push({type:"thinking_delta"})`；但两条路径会**丢**：responses 的 summary/text delta 缺前置容器事件即 `continue` 静默丢弃；openai-completions 的 `reasoning_details` 明文只进 signature 不进 thinking | R2/R3、B7 |
| 非流式与流式一致吗？ | 无独立非流式实现（`stream.ts` 只有 `stream/complete`，complete 即 drain 流），所以"一致性"= 最终 message vs delta 序列：responses 的 thinking 在 `output_item.done` 被**整段替换**（delta AAABBB → 最终 SHORT），anthropic 一致 | R6、A5/A6 |
| thinking signature 保留吗？ | anthropic（signature_delta 累加）、bedrock（reasoningContent.signature 累加）、openai-responses（整 item JSON）、openai-completions（reasoning_details 编码）保留；**mistral 丢**：wire 的 `signature`/`closed` 不落盘、replay 也不发 | A5、BR4、R1、E4-9 |
| reasoning 与 text 交错会丢块吗？ | mistral/anthropic 保序；**openai-completions 压平**：thinking 块与 text 块各只有一个（单例），R1R2/T1T2 各并成一块，content 顺序被重排为 [thinking,text] | B5、M5、A6 |

---

## Findings

### E4-1（P2）usage 是覆盖语义：任何晚到的（甚至残缺的）usage 帧都会清掉先前累计值
- **命题**：provider 层没有"usage 累加/字段级合并"，只有赋值。晚到的 usage 帧若字段残缺，已累计的 input/cacheRead/cacheWrite 被清零；即使完整也是一次性替换（对"逐 chunk 增量报 usage"的网关 = 只记最后一帧）。
- **file:line**（冻结 SHA）：
  - `packages/ai/src/providers/openai-completions.ts:505` `output.usage = parseChunkUsage(chunk.usage, model, cacheWriteCost);`（同 514 走 `choice.usage` 兜底）→ 整体替换
  - `packages/ai/src/providers/google.ts:221` `output.usage = {...}`、`google-vertex.ts:238` 同形 → 整体替换
  - `packages/ai/src/providers/openai-responses-shared.ts:496` `output.usage = {...}` → 整体替换
  - `packages/ai/src/providers/mistral.ts:308-312` 四字段逐条 `= ... || 0`（含 `cacheRead/cacheWrite = 0`）
  - `packages/ai/src/providers/amazon-bedrock.ts:458-461` 同形逐字段赋值
- **逐字证据**（`/tmp/r33_e4/out_oc.txt`、`out_mistral.txt`、`out_bedrock.txt`、`out_google.txt`）：
  - B2 三帧增量 usage（prompt 1000 + completion 5/10/15）：`"usage":{"input":1000,"output":15,..."totalTokens":1015}` ⇒ 只取最后一帧（若为增量语义应 30）。
  - B3 第一帧 `{prompt_tokens:1000,...,cached_tokens:200}`，第二帧只有 `{completion_tokens:15}` ⇒
    `"usage":{"input":0,"output":15,"cacheRead":0,"cacheWrite":0,"totalTokens":15}`（1000/200 被清成 0）。
  - M2（mistral 真实 SDK 路径）：第一帧 `{prompt_tokens:1000,completion_tokens:5,total_tokens:1005}`，第二帧 `{completion_tokens:50}` ⇒ `"input":0,"output":50,"totalTokens":50`。
  - M3：第一帧完整 usage，第二帧 `usage:{}` ⇒ `{"input":0,"output":0,...,"totalTokens":0}` **全部清零**（因 SDK `UsageInfo$inboundSchema` 对 `prompt_tokens/completion_tokens/total_tokens` 均 `.default(0)`，node_modules/@mistralai/mistralai/esm/models/components/usageinfo.js:11-13）。
  - BR2（bedrock 真实 SDK 路径）：两个 `metadata` 事件，第二个只给 `outputTokens` ⇒ `"input":0,"output":50,"cacheRead":0,"totalTokens":50`。
  - G3（google）：第二帧 `usageMetadata:{candidatesTokenCount:7}` ⇒ `"input":0,"output":7,"totalTokens":0`。
- **影响**：凡"usage 分片上报 / 中途补发 / 代理规范化"的上游，`input` 与 `cacheRead` 整份丢失，账本（`packages/coding-agent/src/core/usage.ts:39`、`telemetry.ts:660/777`）少记、cost 少算；带 cacheRead 的场景少记比例=缓存命中占比。
- **可复现**：是（上述脚本逐字可跑）；**confidence**：机制 high（6 provider 实测），"真实生产触发面"med（需要非标准/代理形态的上游；标准 OpenAI/Anthropic/Gemini 末帧语义下不触发）。

### E4-2（P1/P2）`totalTokens` 无分项兜底：provider 不给 `total_tokens` 时 total=0，分项却非 0
- **命题**：google/vertex/openai-responses 三条 usage 路径写 `totalTokens: <provider total> || 0`，没有"缺失时用分项和"的兜底，破坏仓库自身不变式 `totalTokens == input+output+cacheRead+cacheWrite`（`packages/ai/test/total-tokens.test.ts:80` 的 `assertTotalTokensEqualsComponents`）。
- **file:line**：`google.ts:228`、`google-vertex.ts:245`、`openai-responses-shared.ts:502`（codex 复用 shared，同点）。
- **逐字证据**：
  - G2：`usageMetadata:{promptTokenCount:1000,candidatesTokenCount:20}` ⇒ `"input":1000,"output":20,...,"totalTokens":0`（`out_google.txt`）
  - R4：`usage:{input_tokens:1000,output_tokens:50}` ⇒ `"totalTokens":0`（`out_resp.txt`）
  - 正控：同一路径给 total 时按其值（R1/G1 `totalTokens:1050`），且 bedrock/mistral 缺 total 时会兜底（BR3 `totalTokens:1050`）⇒ 确属这三条路径缺兜底。
- **影响**：coding-agent 直接累加 `usage.totalTokens`（`core/usage.ts:39`、`telemetry.ts:660/777` 上报 `total_tokens`），这些 response 对总量贡献 0；compaction 侧另有 `usage.totalTokens || sum` 兜底（`core/compaction/compaction.ts:196`）⇒ 同一次会话**两个口径分叉**（账本少记、compaction 正确），与 K3X-3 同类的"两口径"风险。
- **可复现**：是；**confidence**：high（机制）；触发面取决于上游是否省略 total（Gemini SSE 与部分 Azure/proxy 形态常见，未逐字取到线上样本 ⇒ unverified）。

### E4-3（P3）bedrock 兜底公式漏 cacheRead/cacheWrite
- **命题**：`amazon-bedrock.ts:462` `totalTokens = event.usage.totalTokens || input + output` 漏了 cacheRead/cacheWrite；bedrock 的 `cacheReadInputTokens` 是**真实存在且与 inputTokens 并列**的字段（BR1: input 1000 + cacheRead 200），故缺 total 时 total 小于分项和。
- **逐字证据**：BR5 `usage:{inputTokens:1000,outputTokens:50,cacheReadInputTokens:200}`（无 totalTokens）⇒ `"input":1000,"output":50,"cacheRead":200,"totalTokens":1050`，而分项和=1250。
- 对照：anthropic/`openai-completions` 的兜底是四分项相加（`anthropic.ts:615/774`、`openai-completions.ts:1345`）。
- **影响**：同 E4-2（账本少记 cacheRead 部分）。**可复现**：是。**confidence**：high。

### E4-4（P3）anthropic 的 usage 守卫是"null 守卫"而非"零值守卫"
- **命题**：`anthropic.ts:762-773` 逐字段 `if (x != null)`，显式 `0` 会覆盖 message_start 的累计值；A3/A8 实测 `input 1000→0`、`cacheRead 9000→0`、`cacheWrite 500→0`，`totalTokens` 由 10525 变 25。
- **逐字证据**：A8 `message_delta usage {input_tokens:0,output_tokens:25,cache_read_input_tokens:0,cache_creation_input_tokens:0}` ⇒ `"input":0,"output":25,"cacheRead":0,"cacheWrite":0,"totalTokens":25`（`out_anthropic.txt`）。
- 触发面：上游把 usage 规范化为 `input_tokens ?? 0` 的代理/网关（代码注释 760-761 正说明作者已知"proxy 省略字段"的场景，但只挡住了 omit，没挡住 normalize 成 0）。**confidence**：机制 high；真实触发面 **unverified**（Anthropic 官方 message_delta 是累计值，正常场景不触发）。

### E4-5（P3）openai-responses：缺前置容器事件时 delta 被静默丢弃（thinking 尤其致命）
- **命题**：`response.output_text.delta` 需 `currentItem.content.length>0`（`openai-responses-shared.ts:374-376` `continue`）；`response.reasoning_summary_text.delta` 需 `summary` 末元素存在（同文件 328-331 `if (lastPart)`）。两者缺前置事件时**既不 emit 也不入 message**。
- **逐字证据**：
  - R2（无 `content_part.added`）：事件序列只有 `start/text_start/text_end/done`，**没有 text_delta**，最终 `content:[{"type":"text","text":"final",...}]` 只来自 `output_item.done`（`out_resp.txt`）。
  - R3（无 `reasoning_summary_part.added`）：`start/thinking_start/thinking_end/done`，最终 `content:[{"type":"thinking","thinking":"","thinkingSignature":"{...\"summary\":[]}"}]` ⇒ **reasoning 文本永久丢失**（不像 R2 还能靠 item.done 补回）。
- **影响**：UI 实时流空白/跳动；R3 形态下推理内容在任何地方都不存在（只留空 thinking 块）。**confidence**：机制 high；触发面 = 代理/Azure 变体 **unverified**。

### E4-6（P3）openai-responses：最终 thinking 被 `output_item.done` 整段替换（流式 ≠ 落盘）
- **命题**：`openai-responses-shared.ts:445` `currentBlock.thinking = summaryText || contentText || currentBlock.thinking;` 用 item 内容**替换**已流式累加的文本（仅当 item 里两者都为空才回退）。
- **逐字证据**：R6 流式 delta `AAA`+`BBB`（事件里逐字可见 `thinking_delta "AAA"`、`"BBB"`），`output_item.done` 的 summary 为 `SHORT` ⇒ 最终 `content:[{"type":"thinking","thinking":"SHORT",...}]`（`out_resp.txt`）。
- **影响**：转录/回放里的推理与用户当时所见不一致（等长替换通常无感，截断形态则丢内容）。**confidence**：high（机制）；是否算 bug 取决于是否认为 item 权威 —— 记为 P3 观察项。

### E4-7（P3）openai-completions 把 reasoning/text 交错压平成单例块并重排顺序
- **命题**：`textBlock`/`thinkingBlock` 是单例（`openai-completions.ts:245-264` `ensureTextBlock/ensureThinkingBlock`），交错流被并成两块，落盘顺序变成 [thinking, text]。
- **逐字证据**：B5 五帧 `R1/T1/R2/T2` ⇒ 最终 `content:[{"type":"thinking","thinking":"R1R2","thinkingSignature":"reasoning_content"},{"type":"text","text":"T1T2"}]`，而 delta 事件顺序是 `thinking_delta R1 → text_delta T1 → thinking_delta R2 → text_delta T2`（`out_oc.txt`）。对照 mistral 同类交错保留 4 个块（M5）与 anthropic 保序（A6）。
- **影响**：无内容丢失，但 (i) 转录无法表达生成时序，(ii) replay 时 reasoning_content/text 的拼接口径由压平结构决定（`openai-completions.ts:1168` `assistantMsg.content = reasoningText + "\n\n" + assistantText`），交错场景下模型看到的顺序与实际生成顺序不同。**confidence**：high（行为逐字）；"是否有害" unverified（可能是刻意的 replay 契约）。

### E4-8（P3）openai-completions：`reasoning_details` 的明文文本不透出（只在 signature 里）
- **命题**：只走 `reasoning_details` 的 provider（OpenRouter 部分路由）拿到的是 `thinking:""` + `redacted:true` 的空 thinking 块，明文被塞进 `thinkingSignature`（`openai-completions.ts:633-641` + `encodeReasoningDetails` 191-198）。
- **逐字证据**：B7 两帧 `reasoning_details:[{type:"reasoning.text",index:0,text:"PLAN "}]`/`"STEP"` ⇒ `content:[{"type":"thinking","thinking":"","redacted":true,"thinkingSignature":"{\"type\":\"openai-completions.reasoning_details.v1\",\"details\":[{\"type\":\"reasoning.text\",\"index\":0,\"text\":\"PLAN STEP\",...}]}"},{"type":"text","text":"out"}]`（`out_oc.txt`）。事件里只有 `thinking_start/thinking_end`，无 `thinking_delta`。
- **影响**：UI 与转录显示"空思考"，用户看不到实际推理；只有解码 signature 才能还原。**confidence**：机制 high；真实路由是否只给 details 而不给 `reasoning`/`reasoning_content` **unverified**。

### E4-9（P3）mistral：thinking signature / closed 丢弃且不回放
- **命题**：`mistral.ts:348-368` 只取 `item.thinking[].text`，wire 上的 `item.signature` 与 `item.closed` 未写入 `ThinkingContent.thinkingSignature`；回放侧 `mistral.ts:522-528` 只发 `{type:"thinking", thinking:[{type:"text",...}]}`，不发 signature。
- **逐字证据**：M4 帧 `{content:[{type:"thinking",thinking:[{type:"text",text:"PLAN"}],signature:"SIG-XYZ",closed:true}]}` ⇒ 最终 `content:[{"type":"thinking","thinking":"PLAN"}]`（无 `thinkingSignature` 键，`out_mistral.txt`）；SDK 契约逐字：`node_modules/@mistralai/mistralai/esm/models/components/thinkchunk.d.ts` 注释 `Signature to replay some reasoning blocks across turns.` 且 `ThinkChunk$Outbound` 含 `signature?/closed?`。
- **影响**：多轮 reasoning 回放缺 signature（服务端要求时降级/失效），且 `closed` 前缀语义丢失。**confidence**：字段存在性 high；服务端是否强依赖 **unverified**。

### E4-10（P3/P4）bedrock：缺 `contentBlockStop` 时内部 `index` 字段泄漏进持久化 content
- **命题**：块上的 scratch 字段 `index` 只在 `handleContentBlockStop`（`amazon-bedrock.ts:473-476`）里 `delete`；停止事件缺失或 index 不匹配时，`index` 留在 `output.content` 里成为对外字段，且该块不发 `text_end/thinking_end`。
- **逐字证据**：BR6（messageStart→delta→messageStop→metadata，无 contentBlockStop）⇒ 最终 `content:[{"type":"text","text":"Hi","index":0}]`（`out_bedrock.txt`）；BR4 的 index 错配变体同样泄漏 `{"type":"text","text":"answer","index":0}`。
- **影响**：会话转录持久化内部字段（其它 provider 的 catch 路径都显式清理，属不变式违背）；回放时若该结构被透传，宽松上游无感、严格校验上游可能报 400。**confidence**：机制 high；触发面（截断/错配流）**unverified**。

### E4-11（P4，口径不一致）"reasoning 计入 output" 在两个 provider 里用了两种相反策略
- **命题**：`openai-completions.ts:1338` 注释 `OpenAI completion_tokens already includes reasoning_tokens`，参数类型里**没有** `completion_tokens_details` ⇒ `reasoning_tokens` 永不读取（`Usage` 也没有 reasoning 字段，types.ts:238 区）；而 google/vertex 把 `thoughtsTokenCount` **显式加到 output**（`google.ts:224-225`、`google-vertex.ts:242`）。
- **逐字证据**：B1 usage `completion_tokens:50, completion_tokens_details:{reasoning_tokens:30}` ⇒ `"output":50`（未加）且无 reasoning 字段；R1 `output_tokens_details.reasoning_tokens:30` 同理；G1 `candidatesTokenCount:20 + thoughtsTokenCount:30` ⇒ `"output":50`（加了）。
- **影响**：对"分开上报 reasoning"的 OpenAI 兼容上游少记 output（成本少算）；两个 provider 对同一语义采取相反假设，缺乏统一口径。**confidence**：机制 high；"哪些上游分开报" unverified。

---

## 负结论与正控

- 负结论1：**anthropic 的 usage 覆盖问题不存在**（除 E4-4 的零值变体）。A2（start 带 9000/500，delta 只给 output）⇒ 保留 `cacheRead:9000,cacheWrite:500,totalTokens:10525`；A4（第二个 message_delta 带空 usage `{}`）⇒ 保留 1000/25。正控：同脚本 A3/A8 显式 0 ⇒ 立即归零 ⇒ 说明探针确实能区分"守卫起作用"与"守卫失效"两种输入。
- 负结论2：**未发现 reasoning token 被重复计入 output 的形态**（任何 provider）。正控：G4 把 `thoughtsTokenCount:4` 与 `candidatesTokenCount:5` 相加得 output 9，且 total 19 = 10+5+4 ⇒ 与 Gemini 语义一致；B1/R1 的 `*_tokens_details.reasoning_tokens` 未被二次相加。
- 负结论3：**未发现 provider 层 usage 累加丢失"最后一帧"以外的形态问题**；`total_tokens` 来源在四类口径之外没有其它写法（grep 全部 provider 的 usage 赋值点，见 E4-1/E4-2 行号清单）。
- 正控（证明探测有效）：B1 标准形态给出正确拆分 `input:800, cacheRead:200, output:50, total:1050`（prompt 1000 减 cached 200）；BR1 bedrock 经真实 AWS SDK/h2 二进制帧给出 `input:1000,cacheRead:200,total:1050` ⇒ 探针能真正驱动 provider 解析路径，非"探测器假阳性"。
- 正控（abort 早捕获设计成立）：A9 abort 中途 ⇒ error 事件 message 保留 `{"input":1000,"output":1,"cacheRead":9000,"cacheWrite":0,"totalTokens":10001}`，证实 anthropic.ts:609-616 注释所宣称的"被中止也能保留输入计数"。
- 未测面（明确标 unverified）：
  - `faux.ts`（测试替身）与 `azure-openai-responses.ts`/`openai-responses.ts` 的 Azure 分支未单独造流（Azure 复用 shared 的 usage 与 reasoning 解析路径，按共用代码行号覆盖）。
  - Bedrock 的 `cacheWriteInputTokens` 计价分支（`hasStandardAnthropicCachePricing`）未构造 1h/5m 缓存场景。
  - 各 provider 的**重试/预算**路径（retry-cap/request-budget）不在本轴范围。

## 同轮兄弟席重叠
`/tmp/audit_r/round-33/ai-provider-sse.md`（R33-PV-*）的 `R33-PV-4`＝本报告 **E4-5** 的前半（responses 缺 `*_part.added` 时 delta 静默丢弃）。
本席补充的差异证据：R3 变体下 reasoning 文本**永久丢失**（最终 thinking 为空串，非仅"流式面空转"），且 R2 变体最终文本仍由 `output_item.done` 补回。其余 E4-1/2/3/4/6/7/8/9/10/11 与该兄弟报告无交集。

## 去重声明
`docs/fork/audits/decisions.jsonl`（269 行，冻结后未变）里 usage/thinking 相关条目为：`ACCT-SCAN-ORDER`、`K3X-3`、`LAT-3`（均在 coding-agent 账本/会话层）、`CD-7`（`compat.reasoningEffortMap` 静默失效）、`SCAN-OFFSET`/`IT-4`（活会话行/token 统计）、`MR-1`/`ID-4`（openai-completions 流失败与 toolcall id）。
本报告的 E4-1..E4-11 **均在 packages/ai provider 层 token 解析与 thinking 事件面**，与上述条目的 file/机制无交集 ⇒ 非重复。
