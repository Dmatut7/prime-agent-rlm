# round-34 / e4-tail — E4-6/7/8 provider thinking 流尾巴修复

冻结基线：主仓 HEAD `07a1cd215`（merge/repl-kernel）。工作树 `/tmp/r34_wt_tail`（detached，symlink node_modules）。
交付 commit：`dd88c1a8e`（10 files，+824/−42；含 changelog fragment `packages/ai/.changes/r34-thinking-stream-tail.md`）。
红→绿：先写 4 个测试文件（8 条红断言全红于冻结基线），再修，全绿；每项均带正控。

## E4-6 responses thinking 被 output_item.done 整段替换 — 修
- 改点 `openai-responses-shared.ts`（done 分支）：done 不再做无差别替换。
  规则：已积 delta 为空 → 取 done 文本（保 R1/无 delta 形态）；done 是已积文本的**扩展**（startsWith）→ 取 done 并把尾部作为 thinking_delta 补发（流/落盘一致）；其余冲突（R6：AAABBB vs SHORT）→ **保已积流式文本** + 落 `responses_thinking_conflict` 诊断（itemId/两长度）。
  `thinkingSignature = JSON.stringify(item)` 不变。
- **依据（协议文档）**：OpenAI Responses streaming API reference（developers.openai.com/.../streaming-events，本轮抓取）只定义 done item 为 replay 权威——原文 "Use the reasoning item from the corresponding `response.output_item.done` event when passing it as input to a subsequent request"（针对 encrypted_content），**并未**定义 done 的 summary 文本可覆盖已流式 delta；良构流两者恒等。仓内既有同型守卫（message 分支注释 "An empty done payload must not wipe text recovered from deltas"）已确立"delta 是用户所见、done 不得改写"的契约，本修复把该契约从空载荷推广到冲突载荷。replay 权威数据（encrypted_content）经 thinkingSignature 完整保留，协议要求的回传能力不受影响。
- 兼容细节：`summary_part.done` 会给已积文本追加 `\n\n` 分隔符而 done join 不带尾分隔，比较前先剥尾部分隔符，避免良构 R1 流误报冲突。
- 红测：`test/openai-responses-thinking-done-conflict.test.ts` — R6 断言落盘/thinking_end = AAABBB（改前 SHORT，红）+ 诊断存在；扩展形态断言补发 delta "BBB"（改前缺，红）；正控：良构无诊断、无 delta 时 done 填充、签名回传。

## E4-7 openai-completions 交错压平 — 修
- 改点 `openai-completions.ts`：删除 `textBlock`/`thinkingBlock` 单例；`ensureTextBlock/ensureThinkingBlock` 改为"尾块同型才合并，否则按到达顺序新开块"（与 mistral/anthropic 保序契约一致）。`reasoningDetailsBlock` 显式排除在 thinking 尾合并外（其 signature 承载 reasoning_details 编码，不与 reasoning_content 文本混块）。
- 红测：`test/openai-completions-interleaved-thinking.test.ts` — B5 R1/T1/R2/T2 断言 4 块保序（改前 2 块重排 [R1R2,T1T2]，红）；正控：连续同型仍合并为 2 块。
- 已知边界（未修，无红测要求）：reasoning_details 块与 text 交错时 details 仍聚合在先创建的单块内（signature 按 index 编码所需），块序在该混合形态下非严格到达序。

## E4-8① reasoning_details 明文不透出 — 修
- 改点：details 明文 text/summary 片段随到随写入 `reasoningDetailsBlock.thinking` 并发 `thinking_delta`；`redacted` 只在出现 `reasoning.encrypted` detail 时置 true。
- **依据（仓内语义）**：`types.ts:213` `redacted` 定义为 "thinking content was redacted by safety filters; the opaque encrypted payload is stored in thinkingSignature"。reasoning.text 是明文 → 应透出；真加密（reasoning.encrypted）才 redacted。回放侧不变：signature 可解码的块仍走 reasoning_details 回放（`buildParams` :1138-1143），明文进入 thinking 后跨模型按普通 thinking 处理（与 reasoning_content 块同口径）。
- 红测：B7 断言 thinking="PLAN STEP" + thinking_delta ["PLAN ","STEP"] + redacted 非真（改前 thinking=""、redacted=true、无 delta，红）；正控：纯 encrypted detail 仍 redacted:true、thinking:""。

## E4-8② mistral thinking signature 丢弃不回放 — 修
- 改点 `mistral.ts`：入流侧把 wire `item.signature` 存入块 `thinkingSignature`（覆盖式，末次为准）；回放侧 `{type:"thinking",...}` 附 `signature: block.thinkingSignature`；`closed===true` 丢弃时落 `mistral_thinking_closed_dropped` 诊断。
- **依据**：SDK 契约逐字（node_modules/@mistralai/mistralai/esm/models/components/thinkchunk.d.ts）`signature` 注释 "Signature to replay some reasoning blocks across turns" 且 `ThinkChunk$Outbound` 含 `signature?`。closed 注释 "Currently only used for prefixing"——本仓不支持 prefixing，不回放 closed，改为诊断（不静默）。
- 红测：`test/mistral-thinking-signature.test.ts`（vi.mock @mistralai/mistralai 驱动 streamMistral + onPayload 抓回放载荷）— M4 断言落盘 thinkingSignature="SIG-XYZ"（改前 undefined，红）、回放载荷 thinking chunk 带 signature（改前缺，红）、closed 诊断存在；正控：无 signature/closed 流零诊断。

## E4-8③a bedrock 缺 contentBlockStop 时 index 泄漏 — 修
- 改点 `amazon-bedrock.ts`：`handleContentBlockStop` 拆出 `closeContentBlock`（删 index + 发 end + toolCall 收尾）；流循环结束后新增 `closeUnstoppedBlocks` 扫尾——任何仍带 `index` 的块（stop 缺失或错配，BR6/BR4）按同路径关闭并落 `bedrock_content_block_stop_missing` 诊断。catch 路径原有 index 删除保持不变。
- 红测：`test/bedrock-missing-content-block-stop.test.ts`（vi.mock @aws-sdk/client-bedrock-runtime）— BR6/BR4 断言落盘无 `index` 键且发 text_end（改前泄漏 index:0 且无 end，红）；正控：良构流 1 个 text_end、零诊断。

## E4-8③b reasoning 计入口径（openai vs google）— 核查后不改码（结论：各自已与自家 API 文档对齐）
- **依据（两家文档，本轮抓取）**：
  - OpenAI（Create completion API reference）：`completion_tokens_details` 是 "Breakdown of tokens used in a completion"——reasoning_tokens 是 completion_tokens 的**分项**，不得再加。仓内 `openai-completions.ts` 注释与实现（output=completion_tokens，不读 reasoning_tokens）正确。
  - Google（Gemini thinking 文档 ai.google.dev/gemini-api/docs/generate-content/thinking）："response pricing is the sum of output tokens and thinking tokens"，thoughtsTokenCount 与 candidatesTokenCount 并列分开计。仓内 `google-shared.ts` 显式相加正确。
- 两家 API 的口径差异是**协议事实**而非仓内不一致；强行统一反而会错一边。已在 `google-shared.ts` 加注两家文档依据的注释钉死该差异，防止未来"统一"误改。无代码行为变化，故无红测。

## 验证
- 红测改前红：E4-6×2、E4-7×1、E4-8①×1、E4-8②×2、E4-8③a×2（共 8 条，正控 6 条改前即绿）。
- 修后全绿：4 个新测试文件（12+3 tests）。
- 回归：responses dispatch/replay-e2e/incomplete-terminal、oc preserve-thinking/reasoning-replay/thinking-as-text/openrouter-reasoning、mistral-reasoning-mode、bedrock pricing/payload、provider-usage-merge、google-thinking-signature/stopreason-guard、interleaved-thinking — 全绿。
- `npx tsgo --noEmit` EXIT=0（工作树）；`npx biome check --error-on-warnings` 9 触碰文件通过；pristine-tree 验证：`git archive HEAD` 解包 + symlink node_modules 后 `tsgo --noEmit` **EXIT=0**。
- 已知环境失败（非本线引入）：`test/stream.test.ts` 的 5 条 Ollama E2E（"ollama server not responding"，本机无 ollama，且 193 skipped 均为需真实 key 的 E2E）。

## 纪律
单命令 ≤60s；测试分批 ≤3 文件；unset 全部 RLM_*/PRIME_AGENT_*/PI_* 泄露变量后直接 `node ../../node_modules/vitest/dist/cli.js --run`；git add 逐文件并核对 staged（10 文件，无他人 hunks）；无 `doctor --fix`/`daemon ps -k`。
