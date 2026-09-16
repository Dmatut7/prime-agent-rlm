# r33 泛扫 — packages/ai provider 层（轴①流解析边界 / 轴③工具调用解析 / 轴⑤thinking 流）

- 冻结 SHA: `b2e505e058b24f60f8af835de0f070b3f15b7592`（只读；仓库零写入）
- 方法：本地伪造 SSE 响应直接驱动 provider 的 `stream()`（anthropic 用 `options.client` seam；codex / openai-completions 用 fake `global.fetch` / 本地 http server），逐字打印 stopReason / errorMessage / 事件序列 / 最终 content。脚本在 `/tmp/r33_e1/`。
- 与 `docs/fork/audits/decisions.jsonl`（269 实际行）去重：MR-1（openai-completions 无流失败诊断）、ID-4（openai-completions index 复用/缺 id）、RC-1（retry cap）、RC-4（空回复策略）、S-4（logger 脱敏）、CD-7（reasoningEffortMap）已记录，本文不重复报。
- 姊妹报告：`errclass.md`（轴②错误分类/重试，子席 r33-errclass，已落盘）、`usage-thinking.md`（轴④usage + 轴⑤thinking，子席 r33-usage，已落盘 14.9k）。
- 交叉：子席 E4-5（responses 缺前置容器事件时 delta 静默丢）与本报告 PV-4 是同一缺口；E4-5 另有更强证据（R3 变体下 reasoning 文本**永久丢失**，最终 thinking 为空串）⇒ 定级以 E4-5 的 P3 为准，PV-4 保留为不同角度。
- 交叉（轴②，`errclass.md`）：E-1「断流干净收尾被 7 个 provider 当成功 stop」把本报告 PV-2（codex SSE 子形态）与 PV-5（anthropic 守卫只覆盖 message_start 之后）收进同一机制；E-3 指出 codex 是唯一不写 `provider_stream_failure` 诊断、且绕过 `redactSecrets` 的 provider（本报告 PV-1/PV-2 的静默性因此更严重：连诊断通道都没有）。

---

## R33-PV-1 (P3) codex SSE 解析器不认 CRLF：整个流零事件、静默"空成功"

- file:line: `packages/ai/src/providers/openai-codex-responses.ts:560-597`（分帧只用 `buffer.indexOf("\n\n")`，L573 / L595）
- 命题：SSE 规范允许 `\r\n` 作行终止符。CRLF 分帧的响应体在 `parseSSE` 里永远匹配不到 `"\n\n"`（`\r\n\r\n` 内不存在相邻 `\n\n`），于是**一个事件都不产出**；下游 `processResponsesStream` 对"零事件"没有守卫，消息以 `stopReason:"stop"`、空 content、usage 0 正常收尾。
- 逐字证据（`npx tsx /tmp/r33_e1/codex-sse-probe.mts`）：
```
{"label":"PC-lf-normal","stopReason":"stop","text":"Hello","usage":8}
{"label":"crlf-normal","stopReason":"stop","text":"","usage":0}
{"label":"crlf-with-comment","stopReason":"stop","text":"","usage":0}
```
  （同一 body，只把 `\n` 换成 `\r\n`；无 errorMessage、无诊断、无日志）
- 影响：任何把 SSE 换行规范化成 CRLF 的上游/网关/代理（规范允许）⇒ 用户得到"空回复"，上层既看不到失败也看不到 usage。
- 可复现：`cd packages/ai && npx tsx /tmp/r33_e1/codex-sse-probe.mts`
- confidence: high（已执行验证）；真实上游是否发 CRLF 未验证（reachability unverified）。
- 正控：同 harness 的 `PC-lf-normal` 得 `Hello`/usage 8；两组只差行终止符。

## R33-PV-2 (P2) codex SSE 无尾部 flush、无终止事件守卫 ⇒ 失败/截断被静默报成正常完成

- file:line: `openai-codex-responses.ts:567-607`（`done` 直接 break，剩余 buffer 丢弃，无 tail flush）；对照 `anthropic.ts:424-445` 显式做了 tail flush；`openai-codex-responses.ts:1084` WebSocket 路径**有**守卫 `throw new Error("WebSocket stream closed before response.completed")`，SSE 路径没有对应守卫。
- 逐字证据（`/tmp/r33_e1/codex-terminal-probe.mts`，同一事件序列，只改最后一个事件后有没有尾部空行）：
```
{"label":"PC-completed-tail",   "stopReason":"stop",  "usageTotal":8}
{"label":"PC-completed-NOTAIL", "stopReason":"stop",  "usageTotal":0}
{"label":"incomplete-tail",     "stopReason":"length","usageTotal":8}
{"label":"incomplete-NOTAIL",   "stopReason":"stop",  "usageTotal":0}   <-- 截断被报成正常结束
{"label":"failed-tail",         "stopReason":"error", "errorMessage":"boom"}
{"label":"failed-NOTAIL",       "stopReason":"stop",  "usageTotal":0}   <-- provider 失败被报成成功
{"label":"no-terminal-event",   "stopReason":"stop",  "usageTotal":0}   <-- 全程无终止事件也不报错
```
- 影响：流在最后一个事件后直接关闭（尾部无空行）时 `response.completed/incomplete/failed` 被丢掉 ⇒ ①`max_output_tokens` 截断报成正常 stop（上层不重试不告警）；②`response.failed` 完全消失（错误变成成功）；③usage 归零（记账丢失）。
- 可复现：同上命令。
- confidence: high（行为已执行验证）；真实 codex 上游是否总带尾部空行未验证，但"丢尾部 + 无终止守卫"两个缺口独立存在，任一触发即静默成功。
- 正控：带尾部空行的三组分别得到 `stop`/`length`/`error("boom")`，证明该方法能区分终止事件是否被消费。

## R33-PV-3 (P3) responses 事件分发忽略 item_id/output_index：单槽状态机在交错时静默丢/串工具参数

- file:line: `packages/ai/src/providers/openai-responses-shared.ts:296-320`（`response.output_item.added` 只保留最后一个 `currentItem`/`currentBlock`）、`:406-420`（`response.function_call_arguments.delta` 只判 `currentItem?.type === "function_call"`，**完全不看事件自带的 item_id/output_index**）、`:439-486`（`output_item.done` 的 function_call 分支只判 `currentBlock?.type === "toolCall"`，不校验这 block 是否属于该 item）。
- 命题：Responses 协议用 `item_id`/`output_index` 显式标识每个 item；该共享分发器（openai-responses / azure-openai-responses / openai-codex-responses 三家共用）用"最后 added 的 item"单槽状态机代替，任何交错/乱序都导致 ①参数 delta 串到别的工具或被静默丢弃，②某个 tool call 从最终消息中消失且参数为 `{}`。全程无诊断（对比：openai-completions 的同类恢复都走 `recordToolCallDiagnostic`）。
- 逐字证据（`/tmp/r33_e1/codex-toolcall-probe.mts`）：
```
PC-sequential   -> calls=[{id:"call_fc_A|fc_A",name:"tool_a",arguments:{x:1}},
                          {id:"call_fc_B|fc_B",name:"tool_b",arguments:{y:2}}]
INTERLEAVED-2calls -> calls=[{id:"call_fc_A|fc_A",name:"tool_a",arguments:{},scratch:"{\"x\""},
                             {id:"call_fc_B|fc_B",name:"tool_b",arguments:{}}]   <-- 两个调用参数全空
REASONING-interleaved -> calls=[{id:"call_fc_A|fc_A",name:"tool_a",arguments:{x:1},scratch:"{\"x\":1}"},
                                {type:"thinking",thinking:"thinking"}]           <-- 第二个 args delta 被静默丢弃
```
  交错序列：`added(A) → args.delta(A,'{"x"') → added(B) → args.delta(B,'{"y"') → args.delta(A,'":1}') → args.delta(B,'":2}') → done(A) → done(B) → completed`。
- 影响：工具调用以空/错误参数执行，或调用整体丢失；损坏静默（stopReason 仍是 `toolUse`）。对 codex（本机主力模型面之一）与 responses API 都适用。
- 可复现：`cd packages/ai && npx tsx /tmp/r33_e1/codex-toolcall-probe.mts`
- confidence: high（行为已执行验证）；"真实上游会交错"未验证（reachability unverified，当前 OpenAI 通常按序发送 item）。
- 正控：`PC-sequential` 同 harness 同事件集，严格顺序时两个调用参数完整。

## R33-PV-4 (P4) responses 系：缺 `*_part.added` 时 text/reasoning delta 被静默丢弃，流式面空转

- file:line: `openai-responses-shared.ts:372-388`（`if (!currentItem.content || currentItem.content.length === 0) continue;`，`lastPart?.type !== "output_text"` 时丢弃）、`:320-338`（`reasoning_summary_text.delta` 需已有 `summary` part，否则整块丢弃而不落任何缓冲）。
- 逐字证据（`/tmp/r33_e1/codex-thinking-events.mts`，直接迭代 `AssistantMessageEventStream` 的事件序列）：
```
PC-reasoning-part+delta -> ["start","thinking_start","thinking_delta:think1","thinking_end","done"]
reasoning-delta-no-part -> ["start","thinking_start","thinking_end","done"]        <-- 无 thinking_delta，无诊断
PC-text-part+delta      -> ["start","text_start","text_delta:Hi","text_end","done"]
text-delta-no-part      -> ["start","text_start","text_end","done"]                <-- 无 text_delta，无诊断
```
  （最终 content 在我的探针里由 `output_item.done` 的 item 载荷兜住；若上游 item 载荷为空/缺失，则文本与思维内容整体为空——见 PV-1 同一类"静默零内容"。）
- 影响：上游（网关/代理/provider 变体）只发 delta 不发 part 事件时，流式 UI 全程空白、thinking 不显示，且无任何可归因诊断。
- 可复现：同上命令。
- confidence: high（已执行验证）；reachability unverified。
- 正控：带 part.added 的两组事件序列完整。

## R33-PV-5 (P4) anthropic 截断守卫只在见到 message_start 后生效 ⇒ 零事件流静默成功

- file:line: `anthropic.ts:483-514`：`sawMessageStart`/`sawMessageEnd` 只在 `ANTHROPIC_MESSAGE_EVENTS` 命中事件上置位，尾部判断是 `if (sawMessageStart && !sawMessageEnd) throw ...`；`:491` 对不在名单内、或 `event:` 字段缺失（`sse.event === null`）的 SSE 帧 `continue`。
- 逐字证据（`/tmp/r33_e1/anthropic-sse-probe.mts`，同一事件集，只把 `event: xxx` 行删掉）：
```
{"label":"PC-lf-eventlines","stopReason":"stop","text":"Hello 🙈","usage":17,"responseId":"msg_1"}
{"label":"DATA-ONLY-lf",   "stopReason":"stop","text":"","usage":0}
{"label":"data-only-split-7","stopReason":"stop","text":"","usage":0}
```
- 影响：代理剥掉 `event:` 行（或返回 200 空体）时用户看到空回复，无 error、无诊断；`sawMessageStart=false` 使截断守卫整条失效。与 openai-completions 侧"200 空体 → `stopReason:"stop"`、空 content"（`/tmp/r33_e1/oc-sse-probe.mts` 的 `empty-body-200` 用例）是同一类 provider 层缺口；上层 RC-4 的重试策略只是缓解，provider 层没有任何"零事件 200 流"的告警（去重说明：RC-4 讲的是上层重试策略，本条讲 provider 层把空流返回成成功态）。
- 可复现：`cd packages/ai && npx tsx /tmp/r33_e1/anthropic-sse-probe.mts`
- confidence: high（已执行验证）；reachability unverified。
- 正控：同 harness 带 `event:` 行的 `PC-lf-eventlines` 得完整文本 + usage 17。

---

## 负结论（均带正控）

1. **anthropic SSE 解码器对畸形输入是健壮的**（`anthropic.ts:392-449` `iterateSseMessages`）：实测 CRLF、纯 CR、`data:` 后无空格、1 字节/3 字节切片、行内插入非法 UTF-8 字节（0xff 0xfe）都不崩溃、不丢内容：
```
{"label":"PC-lf-eventlines","text":"Hello 🙈","usage":17}   {"label":"crlf-eventlines","text":"Hello 🙈","usage":17}
{"label":"cr-only-eventlines","text":"Hello 🙈","usage":17} {"label":"PC-split-1byte","text":"Hello 🙈","usage":17}
{"label":"no-space-datacolon","text":"Hello 🙈","usage":17} {"label":"invalid-utf8-bytes","text":"Hello 🙈","usage":17}
```
   非法 UTF-8 被替换成 U+FFFD 但消息保留（TextDecoder 默认非 fatal，`Buffer` 长度/usage 不受影响）——**未见崩溃、丢消息、静默卡住**。
   正控：同一 harness 能检出差异（`DATA-ONLY-lf` 空、codex CRLF 空）；1 字节切片用例同时证明跨 chunk 的多字节 UTF-8 不会损坏（`🙈` 完整存活）。
2. **openai-completions 工具调用解析（轴③）本次未见新缺口**（`openai-completions.ts:349-445`、`:560-600`），6 种畸形/边界形态全部正确：
```
PC-sequential-split        -> tool_a{"x":"1"} / tool_b{"y":"2"}                （参数跨 chunk 拼接正确）
index-reuse-new-call       -> 两个调用各自正确 + diagnostic "tool_call_index_reused"
index-reuse-same-id-more-args -> 合并为一个调用，参数 {"x":"1"}               （kimi 型同 id 复读）
no-index-two-ids           -> 两个调用正确（无 index 也能按 id 对齐）
surrogate-split-args       -> {"x":"🙈"}   （\\ud83d / \\ude48 分两个 delta 传输，代理对正确重组）
raw-lone-surrogate-args    -> {"x":"🙈"}   （裸高/低代理对分别落在两个 delta，拼接后仍是合法对）
```
   即：**跨 chunk 拼接不破坏 unicode 代理对**，转义与裸代理对两种形态都验证过。与 ID-4（index 复用/缺 id 静默合并）的现状一致——修复后的形态已被诊断覆盖。
   正控：`index-reuse-new-call` 触发并记录了诊断，证明该路径的观测确实生效（不是"没检出"而是"没发生"）。
3. **anthropic 消息截断检测存在且有正控**：`sawMessageStart && !sawMessageEnd` 会抛 `Anthropic stream ended before message_stop`（`anthropic.ts:512-517`）——本文未找到"半截 message 被当成功"的形态；缺口仅在 PV-5 的"零事件/无 message_start"一侧。
4. **anthropic 的 index→block 派发在正常顺序下无丢块**：text/thinking/input_json/signature 四类 delta 均能按 `index` 落到正确 block（PC 用例中 text 与 thinking 混合场景文本完整）；**未覆盖**的负结论边界：`blocks.findIndex(b => b.index === event.index)` 在 `index` 不存在时静默 return（`anthropic.ts:672-700` 区段），本次未构造出可由真实上游触发的形态，故仅记为"在本次扫描范围内未见触发路径"，不作为 finding。

## 未验证 / 边界说明

- 所有"可达性"（真实上游是否会发 CRLF / 丢尾部空行 / 交错 item / 剥 event 行）均为 **unverified**：本文只证明了**代码在收到该形态时的行为**，真机上游行为需要 live 抓包才能定论。触发路径均为协议允许或网关常见形态。
- 真实 provider（openai/anthropic/google/mistral/bedrock）的畸形输入行为未做 live 验证；google/mistral/bedrock 走各家 SDK 的 SSE 解析（非本仓代码），仅在轴②/④姊妹报告中以读码形式覆盖。
- 未覆盖：超长单行（无换行）导致的缓冲无上限增长（`anthropic.ts:411` 与 codex 的 `buffer +=` 都无上限）；本次未构造内存压力用例，故不列为 finding，仅登记为观察点。
