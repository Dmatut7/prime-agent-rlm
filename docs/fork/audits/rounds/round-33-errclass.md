# r33 泛扫轴② — packages/ai provider 层错误分类与重试语义核对

冻结 SHA: b2e505e058b24f60f8af835de0f070b3f15b7592
只读审计：仓库工作树零写入。临时脚本在 /tmp/r33_e2/（helper.mts + probe_*.mts），未留在仓库。
方法：node+tsx 起本地 http server，直接驱动各 provider 的 stream*()，读终止事件的 stopReason/errorMessage/diagnostics/请求次数。
命令模板：
cd /Users/a1/Desktop/ai/prime-agent/packages/ai && env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_AGENT_ID -u PRIME_AGENT_SESSION -u PI_SESSION_DIR npx tsx /tmp/r33_e2/<probe>.mts
去重：已与 docs/fork/audits/decisions.jsonl 比对。本报告不含 RC-1/MR-1/RC-4/S-4/RC-3/RC-5 的重复条目；只记录新形态，并对 RC-1 做"是否已修"的复核。

## 0. 复核（去重项，不新增条目）
- RC-1 已修：maxRetryDelayMs 上限现在在 openai-completions / anthropic / openai-responses / azure-openai-responses 都经 createRetryCapFetch 生效（src/providers/retry-cap.ts:101；调用点 anthropic.ts:572、openai-completions.ts:472、openai-responses.ts:102、azure-openai-responses.ts:235），codex 为自研实现（openai-codex-responses.ts:117-129）。types.ts 已改口为"OpenAI/Anthropic SDK-backed providers enforce it via a fetch wrapper，Mistral/Google/Vertex 忽略"。与 decisions.jsonl 的 RC-1（"cap 只在 codex 实现"）不再一致 ⇒ 该条已闭合。
- RC-5 未覆盖 codex（见 E-3）：session 的"永久错误不再重试"闸 _isStructuredPermanentProviderFailure 只读 provider_stream_failure 诊断的 kind（agent-session.ts:14836-14839），而 codex 从不写该诊断。

## FINDING E-1 — 断流（HTTP 正常结束、无终止事件）被当作成功 stop
命题：流在 SSE 中途"正常收尾"（chunked 终止符，非 socket reset）但没有终止事件（finish_reason / response.completed / messageStop）时，除 anthropic 外所有 provider 都把 stopReason 留在初值 "stop" 并推 done，即截断的回复被当成完整成功的回复：不报错、不加重试、不写诊断，usage 也缺失。
severity: P2
file:line
- src/providers/openai-completions.ts:662（循环后直接 stream.push({type:"done"})；stopReason 初值 "stop" 见 :181）
- src/providers/openai-responses.ts:137（+ azure-openai-responses.ts:130 同一 processResponsesStream 路径）
- src/providers/google.ts:267 / src/providers/google-vertex.ts:284
- src/providers/mistral.ts:89
- src/providers/amazon-bedrock.ts:270
- 对照（唯一有守卫者）：src/providers/anthropic.ts:513 "Anthropic stream ended before message_stop"
- src/providers/openai-codex-responses.ts:337（同样无守卫；**该 codex 子形态与 decisions.jsonl PV-2 重复，不单独计条目**）

逐字证据（probe_proper_end.mts；SSE 写完即 res.end()，无终止事件）：
```
"completions_proper_end":  {"type":"done","stopReason":"stop","content":"[{\"type\":\"text\",\"text\":\"partial\"}]"}
"responses_proper_end":    {"type":"done","stopReason":"stop","content":"[{\"type\":\"text\",\"text\":\"\"}]"}
"google_proper_end":       {"type":"done","stopReason":"stop","content":"[{\"type\":\"text\",\"text\":\"partial\"}]"}
"mistral_proper_end":      {"type":"done","stopReason":"stop","content":"[{\"type\":\"text\",\"text\":\"partial\"}]"}
"codex_proper_end":        {"type":"done","stopReason":"stop","content":"[]"}
"anthropic_proper_end_after_start": {"type":"error","stopReason":"error",
    "errorMessage":"Anthropic stream ended before message_stop",
    "diagnostics":["provider_stream_failure:{\"kind\":\"malformed_response\"}"]}
```
bedrock（probe_bedrock.mts，手工拼 AWS eventstream：messageStart 后 res.end()，无 messageStop）：
```
"bedrock_eof_no_messageStop": {"type":"done","stopReason":"stop","content":"[]"}
"bedrock_full_stream":  {"type":"done","stopReason":"stop","content":"[{\"type\":\"text\",\"text\":\"hi\",\"index\":0}]"}   # 正控：同 harness 能跑通完整流
```
正控：(a) anthropic 在同一 harness/同一服务器形态下检出该形态并报 malformed_response（证明"正常收尾"可被检出，不是服务器把流搞坏）；(b) probe_eof.mts 用 res.socket.destroy() 时所有 provider 都被 undici 判成 terminated TypeError → error（证明只有"干净收尾"这一支被漏判，不是观测面整体失灵）。
影响
- openai-completions/google/mistral/bedrock：截断正文被原样接受为完整回答并落转录，用户看到半截答案且无信号，session 层不会重试（stopReason=stop）。
- openai-responses/azure：更糟——response.completed 没到 ⇒ content 为空且 usage 全 0，却报 stop；空回复被 RC-4 的 empty-turn 策略接管并原样重发，真因（上游截断）被 stop 掩盖。
- 与 anthropic 语义不一致：同一上游故障 anthropic 得到 malformed_response，其余 provider 静默成功。
可复现：npx tsx /tmp/r33_e2/probe_proper_end.mts（helper.mts 提供 model/context）。
confidence：high（6 provider live 复现 + 1 live 正控 + 代码路径一致）

## FINDING E-2 — openai-responses/azure 忽略 response.incomplete 事件（codex 处理了，语义分叉）
命题：Responses 流在 status:"incomplete" 时发的是 response.incomplete（不是 response.completed）。processResponsesStream 只匹配 response.completed，于是 incomplete 事件被整条忽略，stopReason 留在 "stop"，回复被当成正常完成；codex 的 mapCodexEvents 显式把 response.incomplete 归一成 response.completed，所以只有 openai-responses/azure 有这个缺口。
severity: P2
file:line
- src/providers/openai-responses-shared.ts:489（else if (event.type === "response.completed") 是唯一完成分支；:520 error、:525 response.failed 有分支，response.incomplete 无分支）
- 对照：src/providers/openai-codex-responses.ts:542（response.done / response.completed / response.incomplete 三合一）
- src/providers/openai-responses.ts:137 / azure-openai-responses.ts:130 走同一 shared 函数
逐字证据（probe_misc.mts / probe_misc2.mts）：
```
"responses_incomplete_length": {"type":"done","stopReason":"stop","content":"[]"}      # response.incomplete(max_output_tokens) 被忽略
"responses_completed_incomplete": {"type":"done","stopReason":"length","content":"[]"} # 正控：同样 status=incomplete 但走 response.completed 时映射正确为 length
"responses_failed_500": {"type":"error","stopReason":"error","errorMessage":"server_error: boom",
    "diagnostics":["provider_stream_failure:{\"kind\":\"server_error\",\"providerErrorType\":\"server_error\"}"]}  # 正控：response.failed 有分类
```
影响：命中 max_output_tokens / content_filter 的 incomplete 回复被记为正常 stop；usage 丢失（不落台账），截断原因（incomplete_details.reason）永久丢失且不可诊断、不重试；codex 同类事件却正确映射 ⇒ 同 API 家族跨 provider 语义不一致。
可复现：npx tsx /tmp/r33_e2/probe_misc2.mts。
confidence：high（live + 代码分支缺失 + codex 对照）

## FINDING E-3 — openai-codex-responses 是唯一不写 provider_stream_failure 诊断的 provider（同时绕过脱敏）
命题：全仓 8 个 provider 的终止 catch 都调用 recordStreamFailure，只有 codex 不调用；codex 的 errorMessage 直接取 error.message，不经 formatStreamFailureMessage/redactSecrets。后果两条：
(1) agent-session 的永久失败闸 _isStructuredPermanentProviderFailure 读不到 kind ⇒ codex 的 400/401（invalid_request/auth）在 session 层被判为可重试；
(2) 上游错误体原文（可含密钥）不脱敏地进 errorMessage 并落转录/日志。
severity: P2
file:line
- src/providers/openai-codex-responses.ts:345（output.errorMessage = error instanceof Error ? error.message : String(error)；无 recordStreamFailure / 无 formatStreamFailureMessage）
- 该文件 recordStreamFailure 出现 0 次（rg -n recordStreamFailure src/providers → 其余 8 个 provider 各 1 处）
- 消费侧闸：packages/coding-agent/src/core/agent-session.ts:14836-14839（kind ∈ {auth, invalid_request, refusal} 判永久）、:14739-14773（_isRetryableError）
逐字证据（probe_codex_redact.mts，401 body 回显密钥）：
```
"codex_401": {"type":"error","stopReason":"error",
  "errorMessage":"Incorrect API key provided: sk-live-SUPERSECRET123. You can find your API key at ...",
  "content":"[]"}                      # 无 diagnostics 字段，密钥逐字保留
"codex_400": {"type":"error","stopReason":"error","errorMessage":"bad tool schema","content":"[]"}  # 无 diagnostics
```
正控（probe_redact.mts，同一 body 走其它 provider）：
```
redact_direct: "Incorrect API key provided: [REDACTED]. You can find your API key at ..."
"completions_401": {"type":"error","errorMessage":"401 Incorrect API key provided: [REDACTED]. ...",
  "diagnostics":["provider_stream_failure:{\"kind\":\"auth\",\"providerErrorType\":\"invalid_api_key\",\"status\":401}"]}
"responses_401": {"type":"error","errorMessage":"Provider authentication failed (invalid_api_key, 401): Incorrect API key provided: [REDACTED]. ...",
  "diagnostics":["provider_stream_failure:{\"kind\":\"auth\",\"providerErrorType\":\"invalid_api_key\",\"status\":401}"]}
```
→ 同一明文密钥，codex 路径未脱敏、无 kind；另两家脱敏且分类为 auth。S-4（stream-failure 脱敏）只覆盖了走 stream-failure.ts helper 的 8 个 provider。
影响：codex（ChatGPT/Codex 后端）的 400/401 每次失败都白烧一次整份上下文重发（RC-5 类，但不在 RC-5 的覆盖面内）；auth 失败也不会让 session 走 _markProviderAuthStaleForRetryFailure 的凭据刷新路径；上游回显的凭据落进会话 jsonl 与日志。
可复现：npx tsx /tmp/r33_e2/probe_codex_redact.mts 与 probe_redact.mts。
confidence：high（live 双向对照 + 代码零调用点）

## FINDING E-4 — bedrock 结构化 kind 认不出 AWS 异常名：ValidationException/InternalServerException 落 unknown
命题：Bedrock 把自己的 AWS SDK 异常名当 providerErrorType 交给 classifyStreamFailure，但 classifyStreamFailure 只认小写子串（invalid_request / api_error / server_error / unavailable / throttl ...），"ValidationException""InternalServerException""ModelStreamErrorException" 全不命中 ⇒ kind=unknown，且这些异常的 httpStatusCode 没被提取（status undefined）。kind=unknown 不触发永久闸 ⇒ 永久性 400 会被 session 重试。
severity: P3
file:line
- src/utils/stream-failure.ts:67-89（classifyStreamFailure 全部判据；invalid_request 只认 type.includes("invalid_request")||status 400/404，server_error 只认 api_error/server_error/unavailable||status>=500）
- src/providers/amazon-bedrock.ts:283-286（recordStreamFailure(model, output, error) 之前 errorMessage 走 formatBedrockError，但结构化 info 直接取 extractStreamFailureInfo）
- extractStreamFailureParts 不读 $metadata.httpStatusCode（src/utils/stream-failure.ts:118-170 只读 err.status/err.statusCode）
逐字证据（probe_bedrock.mts，本地 http 1.1 + AWS_BEDROCK_FORCE_HTTP1=1 + x-amzn-errortype）：
```
bedrock_400_validation: errorMessage "Validation error: bad input"
  diagnostics provider_stream_failure:{"kind":"unknown","providerErrorType":"ValidationException"}      # 应为 invalid_request
bedrock_500_internal:   errorMessage "Internal server error: kaboom"
  diagnostics provider_stream_failure:{"kind":"unknown","providerErrorType":"InternalServerException"}  # 应为 server_error
bedrock_stream_throttle: in-stream throttlingException 事件 → errorMessage "Throttling error: slow down"
  diagnostics provider_stream_failure:{"kind":"rate_limit","providerErrorType":"ThrottlingException"}    # 正控：分类器对该 harness 有效
```
正控：ThrottlingException 命中 rate_limit，证明这条链路确实能把 AWS 异常喂进分类器，只是映射表缺名。
影响：Bedrock 的永久校验失败/内部流错误在 session 层被当可重试（无结构化永久标记），每次退避后重发整份上下文；diagnostic 里的 kind 对排障无用（全是 unknown）。
可复现：npx tsx /tmp/r33_e2/probe_bedrock.mts（脚本内含最小 AWS eventstream 编码器）。
confidence：high（live 复现三类异常 + 正控）

## FINDING E-5 — "什么算可重试"在 provider 间完全不同（408/409 分叉；Google/Vertex/Mistral 零重试）
命题：同一"可重试"概念由 4 套互不相干的实现决定，且没有任何 API 级统一：
- OpenAI/Anthropic SDK 路径（completions/responses/azure/anthropic）：SDK 默认 2 次重试，集合 {408,409,429,≥500}。实测 500→3 请求、429→3、408→3、409→3、400→1。
- codex 自研循环：只认 429/500/502/503/504（openai-codex-responses.ts:91-98），实测 500→4 请求（MAX_RETRIES=3）、429→4、408→1、409→1、418→1。
- retry-cap.ts:28 自述 SDK_RETRYABLE_STATUSES = {408,409,418,429}，但实测 418 不被真实 SDK 重试（completions_418→1 请求）⇒ 该常量对 418 过度声明。
- google / google-vertex / mistral：完全不重试（mistral buildRequestOptions 硬写 retries:{strategy:"none"}，mistral.ts:214/219；google.ts:53、google-vertex.ts:68、mistral.ts:218 注释自认忽略 maxRetries/maxRetryDelayMs）。实测 500→1、429→1、400→1。
severity: P3
file:line：src/providers/openai-codex-responses.ts:91-98（isRetryableError，无 408/409）、:49（MAX_RETRIES=3）；src/providers/retry-cap.ts:28；src/providers/mistral.ts:214,219；src/providers/google.ts:53；src/providers/google-vertex.ts:68
逐字证据（probe_retry3.mts / probe_429.mts / probe_codex429.mts / probe_misc2.mts）：
```
completions 500 requests=3 | 400=1 | 429=3 | 408=3 | 409=3 | 418=1
anthropic   500 requests=3 | 400=1 | 429=3
responses   500 requests=3 | 400=1
google      500 requests=1 | 400=1 | 429=1 | 408=1
mistral     500 requests=1 | 400=1 | 429=1 | 408=1
codex       500 requests=4 | 400=1 | 429=4 | 408=1 | 409=1 | 418=1
```
影响：跨 provider 的"失败重发整份上下文"成本与语义不可预测；408/409（上游"请求超时/冲突，请重试"）在 codex 上不重试而在 SDK 路径上重试两次；Google/Vertex/Mistral 连 429 都不重试 ⇒ 短时限流直接失败给用户（SDK 路径会自己等 Retry-After）。types.ts 已把后者的"忽略"写进文档，但没有任何运行期提示（无诊断/无日志）。
可复现：npx tsx /tmp/r33_e2/probe_retry3.mts <provider>；npx tsx /tmp/r33_e2/probe_codex429.mts 408。
confidence：high（全部 live 计数）

## FINDING E-6 — openai-completions 丢弃 delta.refusal：拒绝原文整条丢失且不分类
命题：(a) openai-completions 的 delta 解析只处理 content/reasoning/tool_calls/reasoning_details，没有 delta.refusal 分支 ⇒ OpenAI 风格的拒绝文本（模型给出拒答时 delta.refusal 承载正文、finish_reason=stop）被整条丢弃，得到"空成功回复"；
(b) finish_reason:"refusal" 会落进 mapStopReason 的 default 分支生成 errorMessage "Provider finish_reason: refusal"，但 recordStreamFailure 用该 message 做分类输入，"provider finish_reason: refusal" 不等于 "refusal" ⇒ kind=unknown（而非 refusal），永久闸不触发。
severity: P3
file:line：src/providers/openai-completions.ts:659（throw new Error(output.errorMessage || ...)；:662 推 done）；mapStopReason default 分支（同文件，返回 "Provider finish_reason: ${reason}"）；src/utils/stream-failure.ts:69（`if (type === "refusal")` 为全等比较）；delta 处理段 :511-600（无 delta.refusal）
逐字证据（probe_misc.mts）：
```
"completions_refusal_delta": {"type":"done","stopReason":"stop","content":"[]"}    # 拒绝原文 "I cannot help with that." 消失
"completions_done_no_finish": {"type":"done","stopReason":"stop","content":"[{\"type\":\"text\",\"text\":\"hi\"}]"}  # 正控：普通 content 正常保留
"completions_finish_refusal": {"type":"error","stopReason":"error","errorMessage":"Provider finish_reason: refusal",
  "diagnostics":["provider_stream_failure:{\"kind\":\"unknown\",\"providerErrorType\":\"Provider finish_reason: refusal\"}"]}   # 应为 refusal
```
影响：本地/兼容端点（bailian 等所有 openai-completions 模型）的拒答对用户和模型都不可见——转录里是一条空 assistant 消息，随后被 empty-turn 策略静默重发三次；拒答本应是非重试类。refusal 归类为 unknown 还使该形态无法被 session 的永久闸拦住。
可复现：npx tsx /tmp/r33_e2/probe_misc.mts。
confidence：high（live 复现 + 正控）；"delta.refusal 在 OpenAI 真实响应里存在"按 SDK 类型文档，未对真实 OpenAI 端点验证（unverified，但兼容端点普遍使用）。

## FINDING E-7 — 流内 error 对象在 Google/Mistral 上的分类缺口
命题：Google/Vertex 的流循环只读 chunk.candidates/finishReason；一个 200 SSE 里携带的 {"error":{...}} 载荷被完全忽略 ⇒ done stop（静默成功）。Mistral 收到同类载荷时被 SDK 的 Zod 校验抛成 ZodError，分类为 unknown/ZodError（错误文本是一长串 zod path 报告，无 provider 语义）。
severity: P4
file:line：src/providers/google.ts:94-230（循环体只处理 candidates/usageMetadata）；src/providers/mistral.ts:82-90（catch 走 formatMistralError）
逐字证据（probe_instream.mts）：
```
"google_error_chunk": {"type":"done","stopReason":"stop","content":"[]"}
   （同一 harness 上 {"finishReason":"SAFETY"} 正控 → error / kind:safety）
"mistral_error_obj": {"type":"error","stopReason":"error","errorMessage":"[ {\"expected\":\"string\",\"code\":\"invalid_type\",\"path\":[\"data\",\"id\"]}, ... ]",
  "diagnostics":["provider_stream_failure:{\"kind\":\"unknown\",\"providerErrorType\":\"ZodError\"}"]}
```
影响：Google 侧同类载荷完全静默（可能被当成正常完成）；Mistral 侧至少报错但 kind/providerErrorType 对排障无价值，且 errorMessage 是 zod 内部报告（含路径噪声）。
可达性未证：真实 Gemini/Mistral 端点通常以 HTTP 状态码报错，200 SSE 内 error 载荷的出现频率未知 ⇒ 本条按"分类缺口 + 正控"记录，不计入高危。
可复现：npx tsx /tmp/r33_e2/probe_instream.mts。
confidence：medium（live 行为确证；生产可达性 unverified）

## E-8（去重，不新增条目）— bedrock scratch 字段 index 泄漏进持久化 content
**该命题已存在于 decisions.jsonl `E4-8`（"bedrock 缺 contentBlockStop 时 index 泄漏进持久化 content"，status confirmed_pending_fix）。本席独立复现一次，作旁证，不新增条目。**
命题：bedrock 的 text/thinking block 会被塞入内部 index 字段；清理只发生在 handleContentBlockStop 与 catch 路径。
命题：bedrock 的 text/thinking block 会被塞入内部 index 字段（handleContentBlockDelta/handleContentBlockStart）；清理只发生在 handleContentBlockStop 与 catch 路径。流若无 contentBlockStop（截断，或 E-1 的"正常收尾"形态）就成功结束，则该 scratch 字段被持久化进 assistant 消息内容。
severity: P4
file:line：src/providers/amazon-bedrock.ts:403（newBlock = { type:"text", text:"", index: contentBlockIndex }）；:426 thinking 同理；清理点仅 :283-286（catch）与 handleContentBlockStop（:476 `delete (block as Block).index`（另 :277 为失败路径））；成功分支 :270 之前无清理循环
逐字证据（probe_bedrock.mts，messageStart+contentBlockDelta+messageStop，无 contentBlockStop）：
```
"bedrock_full_stream": {"type":"done","stopReason":"stop","content":"[{\"type\":\"text\",\"text\":\"hi\",\"index\":0}]"}
```
影响：非 TextContent 字段进入转录/会话 jsonl 与跨 provider 回放体；与其它 provider 的"scratch 只存在于流内"约定不一致（openai-responses/anthropic 都在失败路径显式删 index/partialJson）。真实 Bedrock 完整流会发 contentBlockStop 所以常态不触发，属截断路径的连带污染。
可复现：同上。
confidence：medium-high（live 观测；真实完整流不触发的判断为代码阅读）

## FINDING E-9 — requestBudget 缺省时 SDK 层重试在诊断里不可见（attempt/used 恒为 1）
命题：retry-cap 的 reportAttempt 只在 requestBudget 存在时才有真实 attempt/used；未传 budget 的消费者（直接调用 streamSimple 的 SDK/扩展/测试、以及 provider 单测）看到每次尝试都是 attempt:1/used:1，"重试了几次"不可辨。
severity: P4
file:line：src/providers/retry-cap.ts:124,126-152（recorded = budget?.record()；reportAttempt({attempt: recorded?.attempt ?? 1, used: recorded?.used ?? 1 ...})）
逐字证据（probe_429.mts，未传 requestBudget）：
```
requests:3, attempts: [{"attempt":1,"used":1,"status":429},{"attempt":1,"used":1,"status":429},{"attempt":1,"used":1,"status":429}]
```
生产主链不受影响：agent-loop.ts:907-920 在 config.sessionId 存在时自动 getProviderRequestBudget 并注入（agent-session._crossLayerRequestBudget 同 key）。
影响：范围仅限非主链消费者与离线诊断；属可观测性缺口，非正确性问题。
confidence：high（live 计数 + 代码）

## 附：逐 provider 分类/重试语义总表（本报告实测）
| provider | 429 | 5xx | 408/409 | 400 | 超时/断流(socket) | 断流(正常收尾) | 流内 error 事件 | 结构化诊断 |
|---|---|---|---|---|---|---|---|---|
| anthropic | SDK 3 次 | SDK 3 次 | SDK 3 次 | 1 次 | error(terminated) | error(malformed_response) | error，kind 齐全(overloaded/refusal/...) | 有 |
| openai-completions | SDK 3 次 | SDK 3 次 | SDK 3 次(418 除外) | 1 次 | error | **done stop** | error(server_error) | 有（refusal→unknown） |
| openai-responses | SDK 3 次 | SDK 3 次 | SDK 3 次 | 1 次 | error | **done stop** | error, response.failed 有 | 有（incomplete 事件被忽略） |
| azure-responses | 同 responses | 同 | 同 | 同 | error | **done stop** | 同 | 有（incomplete 缺） |
| openai-codex-responses | 4 次 | 4 次 | **1 次** | 1 次 | error | **done stop** | error(CodexApiError) | **无**（且不脱敏） |
| google | **1 次** | **1 次** | 1 次 | 1 次 | error | **done stop** | **吞成 done stop** | 有（ApiError/auth 等） |
| google-vertex | 同 google | 同 | 同 | 同 | error | **done stop**(代码同形) | 未测 | 有 |
| mistral | **1 次** | **1 次** | 1 次 | 1 次 | error | **done stop** | ZodError→unknown | 有（SDKError） |
| amazon-bedrock | AWS SDK 默认 | AWS SDK 默认 | AWS SDK 默认 | 1 次 | error | **done stop** | error(throttling→rate_limit) | 有（Validation/Internal→unknown） |
（google-vertex 的断流行为按 google 同源代码判为同形，未 live 驱动 ⇒ unverified）

## 去重对照（与 docs/fork/audits/decisions.jsonl，含本批新增的 PV-*/E4-* 条目）
| 本报告条目 | 结论 |
|---|---|
| E-1（openai-completions / responses / azure / google / vertex / mistral / bedrock 的"干净收尾=成功"） | **新**。其中 codex 子形态与 PV-2 重复（已标注）；anthropic "守卫只在 message_start 之后"与 PV-5 重复（本报告只在正控里提及，未计条目） |
| E-2（responses/azure 忽略 response.incomplete） | **新**（PV-3/PV-4 讲 item_id 单槽状态机与 *_part.added 缺失，不涉 incomplete 事件） |
| E-3（codex 无 provider_stream_failure 诊断 + 不脱敏） | **新**（S-4 是通用 stream-failure 脱敏；codex 路径不经过该 helper） |
| E-4（bedrock kind 认不出 AWS 异常名） | **新** |
| E-5（408/409 分叉；google/vertex/mistral 零重试；retry-cap 对 418 过度声明） | **新**（RC-1 只到 cap 生效性） |
| E-6（openai-completions 丢 delta.refusal + refusal 分类为 unknown） | **新** |
| E-7（google/mistral 流内 error 对象分类缺口） | **新**（可达性 unverified） |
| E-8（bedrock index 泄漏） | **重复 = E4-8**，仅留旁证 |
| E-9（无 requestBudget 时 attempt/used 恒 1） | **新**（可观测性） |

## 方法学与边界
- 所有 "done/error + stopReason + requests" 均为本地 server 实测；本地服务器返回的是合法 SSE/eventstream 帧，请求计数由 server 侧计数（非客户端自报）。
- 未驱动：google-vertex（需 GCP 凭据路径）、codex 的 websocket transport（只测 transport:"sse"）、真实 OpenAI/Anthropic/Gemini 端点。
- 负结论（"无 EOF 守卫"）正控齐备：同一 harness 上 anthropic 检出同形态；bedrock/socket-reset 形态在所有 provider 上都被检出为 error。

## 冻结 SHA 说明
任务给的冻结 SHA b2e505e0 是当前 HEAD a5bd8952 的祖先；b2e505e0..HEAD 只有 docs(audits) 提交，packages/ **零源码差异**（git diff --stat 仅 docs/fork/audits/*）。报告全部 file:line 与实测对 b2e505e0 的 provider 代码成立。仓库工作树未被本席写入（git status 仅有他人既存的 3 个未跟踪文件）。
