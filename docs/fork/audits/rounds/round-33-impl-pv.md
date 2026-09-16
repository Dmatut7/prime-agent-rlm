# r33 修复交付 — PV-1..5（DS provider 线，packages/ai）

- 冻结 SHA（主仓 HEAD）: `07fc6abe16f2c2f80f1fd6778bdfff10d1fd90d5`（主仓只读、零写入）
- 工作树: `/tmp/audit_r/round-33/wt-pv`（detach + root `node_modules` symlink）
- 交付提交: `f615e2c1c`（7 files, +936/−105，pre-commit hook 通过；含 changelog fragment `packages/ai/.changes/r33-pv-sse-boundaries.md`）
- 依据: `/tmp/audit_r/round-33/ai-provider-sse.md`（PV-1..5 原始红证）；探针在 `/tmp/audit_r/round-33/probes-r33-ai/`
- 纪律: 单命令 ≤60s；测试分批 ≤3 文件；先红后绿（红证在 pristine 源上二次确认）；报告先写；未用 `doctor --fix`/`daemon ps -k`；vitest 直调 node + unset 泄露变量；git add 逐文件、staged 核对过。

## 修复内容（按优先级）

### PV-2 (P2) codex SSE 尾帧 flush + 终止事件守卫 — `openai-codex-responses.ts`
- `parseSSE`（:588）读尽后 `decoder.decode()` 终flush + `consumeCompleteFrames` + 尾帧 flush（:622-629）：最后一个事件帧后无空行不再被丢弃（`parseSseFrame` 抽出为 :568 的同步生成器）。
- `mapCodexEvents`（:521）记 `sawTerminalEvent`；源流耗尽而无 `response.done/completed/incomplete` 时抛 `CodexProtocolError("SSE stream closed before response.completed")`（:559）——与同文件 WS 路径 :1084 先例同文案同语义。
- 红测（`test/codex-sse-tail-terminal-guard.test.ts`，改前全红：全部报 `stop`）：
  - incomplete-NOTAIL → `stopReason:"length"` + usage 8（改前 stop/0）
  - failed-NOTAIL → `stopReason:"error"` + errorMessage 含 "boom"（改前 stop）
  - no-terminal-event → `stopReason:"error"` + errorMessage 含 "response.completed"（改前 stop）
  - PC-completed-tail → stop/Hello/8（红绿两侧均绿，正控）
  - 截断中途的半帧 JSON 现在抛 Invalid Codex SSE JSON（不再静默丢）——即"截断不得报 stop"。

### PV-1 (P3) codex SSE 分帧认 CRLF — `openai-codex-responses.ts`
- `appendDecoded`（:598-603）对整个 buffer 重复做 `
 → 
` 归一（跨 chunk 的尾部 `` 与下一 chunk 头部 `
` 会被下一轮归一接上），照 anthropic `iterateSseMessages` 的 CRLF 先例。
- 红测：CRLF 体 → text "Hello" + usage 8（改前零事件、text ""）；7 字节分 chunk 的 CRLF 体同样通过（跨 chunk 归一被覆盖）。LF 正控两侧均绿。

### PV-3 (P3) responses 事件按 item_id/output_index 分槽 — `openai-responses-shared.ts`（三家共用）
- 新增 per-item 槽位表（:307 `slotsByItemId`/`slotsByOutputIndex`）与 `resolveItemAndBlock`（:350）：item_id 优先、其次 output_index、无两者则退回旧"最后 added"单槽路径（现状保留）。
- 所有 item 作用域事件（summary_part/text/refusal/args delta、args.done、content_part.added、output_item.done）改按解析出的 槽位走；stream 事件 contentIndex 用 `indexOfBlock`（交错时不再错指最后一块）；`output_item.done` 后释放槽位。
- 红/绿测（`test/responses-stream-item-dispatch.test.ts`，改前红）：
  - 交错 A/B tool call（added A→delta A→added B→delta B→delta A→delta B→done A→done B）→ 两调用参数各自完整 `{x:1}`/`{y:2}`，partialJson 清干净，两个 toolcall_end（改前 A/B 全空/串包）。
  - reasoning 交错：fc_A 的第二个 args delta 不丢（toolcall_delta 序列 `['{"x:', '1}']`），thinking "thinking" 完整，参数 `{x:1}`（改前第二个 delta 被静默丢弃）。
  - 顺序 PC：与现状一致且零诊断（正控）。
- 退化路径 + 诊断（:370 `responses_delta_unrouted`）：item_id 无匹配槽、或无坐标且旧单槽类型不匹配时，落 message diagnostic + `log.warn`（recordToolCallDiagnostic 先例），不再静默 continue。红测：无 item_id 的 args delta 在 reasoning 占位时断言 diagnostic 在场（改前无任何诊断）。
- 注：原始探针的交错 delta 切片 `'{"x"' + '":1}'` 拼接后是非法 JSON（`{"x"":1}`），我改用合法切片并回 pristine 源重跑确认红性不变（旧代码下 A 块收不到第二个 delta、B 块被污染，仍非 {x:1}/{y:2}）。

### PV-4 (P4) 缺 part.added 的 delta 宽容恢复 — `openai-responses-shared.ts`
- `output_text.delta`（:499 起）/`refusal.delta`：content 无 part 时自起段 `{type:"output_text"|"refusal", ...}` 并记 `responses_content_part_recovered` 诊断，delta 不再静默丢；`output_item.done` 的空 payload 不再覆盖已恢复文本（:605-607，与 reasoning 分支既有 `||` 保底语义对齐）。
- `reasoning_summary_text.delta`（:441 起）：summary 无 part 时自起 `{type:"summary_text"}` + `responses_summary_part_recovered` 诊断。
- 红测（改前红：事件序列里无 text_delta/thinking_delta、文本空）：
  - text-delta-no-part → text_delta ["Hi"] 且最终 text "Hi"（done 载荷为空）
  - reasoning-delta-no-part → thinking_delta ["think1"] 且 thinking "think1"

### PV-5 (P4) anthropic 守卫改"见过任何 data 帧即激活" — `anthropic.ts`
- `iterateAnthropicEvents`（:474）：`sawDataFrame`（:490）在任何带 data 的帧上置位；尾部守卫改为 `sawDataFrame && !sawMessageEnd` 抛 `StreamFailureError("Anthropic stream ended before message_stop")`（:526-530）——不再等 message_start。
- event 行缺失的帧：`onFrameWithoutEvent?.(sse)`（:503）回调计数 + continue（仍不可投递但可归因）；`streamAnthropic` 在流正常收尾后落 `anthropic_sse_frame_without_event` 诊断（:803-808，details.frames 计数）。
- 红测（`test/anthropic-sse-data-frame-guard.test.ts`，改前红：data-only 体静默成功）：
  - data-only 体 → `stopReason:"error"` + errorMessage 含 "message_stop"（改前 stop/空文本/usage 0）
  - 混合体（message_stop 在场、单帧被剥 event 行）→ 正常收尾但诊断在场（改前零诊断）
  - PC 完整流 → stop/Hello/usage 17（两侧均绿）
- 边界保留：完全无 data 帧的 200 空体不激活守卫（按任务口径"见过任何 data 帧即激活"，空体缺口属另一 finding）。

## 验证记录（全部 node 直调 vitest，unset RLM_*/PRIME_AGENT_*/PI_*）

| 批次 | 文件 | 结果 |
|---|---|---|
| 红（pristine 源，最终测试数据） | codex-sse-tail-terminal-guard / anthropic-sse-data-frame-guard / responses-stream-item-dispatch | 12 red + 4 PC green（dispatch 文件 5 red 重确认） |
| 绿（修复后） | 同上 3 文件 | 16/16 pass |
| 回归 1 | openai-codex-stream / codex-retry-behavior / anthropic-sse-parsing | 28/28 pass |
| 回归 2 | openai-responses-partial-json-cleanup / tool-call-args-final-parse-on-error | 6/6 pass |
| 回归 3 | openai-responses-reasoning-replay-e2e / openai-responses-copilot-provider / interleaved-thinking | 23 pass + 7 env-skip（API key 门控，与改动无关） |
| 回归 4 | responseid / streaming-json-throttle / azure-openai-base-url / openai-codex-cache-affinity-e2e | 20 pass + 12 env-skip（同上） |
| 回归 5 | empty | 14 pass + 96 env-skip（同上） |
| 静态 | `tsgo --noEmit`（packages/ai，工作树与 git archive HEAD 干净树两遍）+ `biome check packages/ai` | 0 error / 0 warning |

- `stream.test.ts` 的 Ollama E2E 5 失败为**预存环境失败**（本机无 11434 监听；pristine 源上同样失败，已当场对照），与本次改动无关；该文件其余用例绿。
- env-skip 全部是 `skipIf(!OPENAI_API_KEY/!ANTHROPIC_API_KEY/!codexToken)` 门控的 live 网络用例（仓库规则禁真实 provider token），非本次引入。

## 行为面变化一览（用户可感）

1. codex 截断/失败/无终止事件的流：从"静默空成功"变为正确 stopReason（length/error）+ errorMessage + usage 保真。
2. CRLF 网关/代理下的 codex 流：从空回复变为正常解析。
3. responses 系（openai/azure/codex 三家）：交错/乱序事件下工具参数与 reasoning 不再丢/串；异常路由落 diagnostics。
4. 缺 part.added 的网关变体：流式 UI 不再全程空白。
5. anthropic 被剥 event 行的代理：空流变显式 error；混合剥离可归因（诊断计数）。

## 未做 / 边界

- codex SSE 对 lone-CR（``）分帧仍不识别（任务口径只要求 CRLF 等价；anthropic 解码器支持，codex 历来不支持）。
- 无缓冲上限（超长单行）观察点维持原状（原报告未列为 finding）。
- openai-completions 200 空体缺口不在 PV 清单，未动。
- 主仓未写、未 push；提交只在 `/tmp/audit_r/round-33/wt-pv`（detached @ f615e2c1c），合并/点名提交由母席决定。
