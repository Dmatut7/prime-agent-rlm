# r33 实修：E4-1/2/4 + ERR-1/2/3（DS 三线合流根因族头两族）

- 冻结 SHA（主仓 HEAD at start）：`ab9e3e1022f8606f90e5e9082db30a93e574f42c`
- 工作树：`/tmp/r33_impl`（branch `wt-e4err`，node_modules symlink 主仓），提交 `a5cd634f7`（16 files, +1386/−62）
- 派单依据：`/tmp/audit_r/round-33/usage-thinking.md`（E4-1/E4-2/E4-4）、`errclass.md`（E-1/E-2/E-3）、探针 `/tmp/r33_e4/`、`probes-r33-ai/`
- 纪律：先红后绿（21 个新测试改前全红，红证逐条与审计报告逐字形态一致）；测试分批 ≤3 文件、直接 node 调 vitest、unset 泄露变量；单命令 ≤60s（仅 openai-codex-stream+thinking-as-text 批次 158s 为既有 stream-wait 用例自身耗时）；无 doctor --fix / daemon ps -k；git add 逐文件核对 staged。

## 修复清单（file:line 为提交 a5cd634f7 后的工作树）

### E4-2（P1）totalTokens 分项兜底
- `google.ts` / `google-vertex.ts`：usage 走新共享 helper `googleUsageCounts`（google-shared.ts），`totalTokens: totalTokenCount || prompt+candidates+thoughts`（照 compaction `calculateContextTokens` 先例）。
- `openai-responses-shared.ts`：`totalTokens: total_tokens || input_tokens+output_tokens`。
- 红证（改前 total=0 → 绿 1020/1050）：provider-usage-merge（google/vertex 各 1 例）、responses-incomplete-terminal（1 例）。

### E4-1（P2）usage 字段级合并（新帧字段 undefined 不清旧值）
- `openai-completions.ts`：新增 `mergeChunkUsage`（含 `prompt_tokens_details` 嵌套合并），chunk.usage 与 choice.usage 兜底两条路径都先合并再 `parseChunkUsage`。
- `google.ts`/`google-vertex.ts`：`mergeUsageMetadata`（google-shared.ts 共享）。
- `openai-responses-shared.ts`：`mergeResponsesUsage`（completed/incomplete 两类终帧共用；incomplete 无 usage 时整帧保留）。
- `mistral.ts`：SDK 入参 schema `.default(0)`（node_modules/@mistralai/.../usageinfo.js 实证）使残缺帧到 provider 层已是显式 0，故用「正值才算上报」的合并规则（`||` 保留旧值），M2/M3 形态都覆盖。
- `amazon-bedrock.ts`：`handleMetadata` 逐字段 `?? previous`，total 兜底保留。
- 红证（改前 input 被清 0）：每 provider 1 例（completions 800/200 保留、google 800/200/1200、mistral 1000 保留+空 usage 帧不清零、bedrock 10/9000/500 保留）。

### E4-4 anthropic 零值守卫
- `anthropic.ts`：`!= null && > 0` 才覆盖（message_start 的 input/cache 计数为权威；proxy 把 omit 规范化成 0 不再清零）。A8 形态红证：改前 0/0/0/25/total 25 → 绿 1000/25/9000/500/total 10525；A2 形态（null 省略）与真实累计值两例正控保持绿。

### ERR-1（P2）断流干净收尾守卫（照 anthropic.ts 先例）
- 6 个文件补 `StreamFailureError(kind=malformed_response)`：`openai-completions.ts`（无 finish_reason）、`openai-responses-shared.ts`（无 terminal response event，openai-responses+azure 共路径）、`google.ts`、`google-vertex.ts`、`mistral.ts`（无 finishReason）、`amazon-bedrock.ts`（无 messageStop，带 requestId）＝7 个 provider。
- codex 不在本轮改动面：f615e2c1c（审计冻结 SHA 之后、本冻结之前）已在 `mapCodexEvents` 加同型守卫并有 `codex-sse-tail-terminal-guard.test.ts` 钉住。
- 守卫位置都在 abort 检查之后（aborted 流不误报 malformed）；红证 5 例（completions/google×2/mistral/bedrock 干净断流 stop→error + malformed_response 诊断），responses 1 例（无终止事件 → reject）。

### ERR-2（P2）responses 处理 response.incomplete
- `openai-responses-shared.ts`：completed/incomplete 合分支；incomplete 的 stopReason 按 `incomplete_details.reason` 映射（max_output_tokens→length，content_filter→error + stopReasonRaw），usage 合并保留（E4-1 同点），新增 `responses_incomplete` 诊断记录 reason/status；codex 的三合一归一路径不受影响。
- 红证：改前 stopReason "stop"/usage 0 → 绿 "length"+total 1050+reason 在案；content_filter → "error"+raw reason；「completed 帧后 incomplete 无 usage」保留 1000/50/1050。

### ERR-3（P2）codex 补 provider_stream_failure + 脱敏
- `openai-codex-responses.ts`：`CodexApiError` 增加 `status`/`error`（结构化 body）字段；非 2xx 路径抛 `CodexApiError{status, code, error}`（parseErrorResponse 扩展返回 code/body）；终态 catch 改 `formatStreamFailureMessage`（走 redactSecrets）+ `recordStreamFailure`（其余 8 provider 先例）。
- 分类链：`extractStreamFailureParts` 读 err.error/err.status → 401→auth、429+usage_limit_reached→rate_limit；errorMessage 形如 `Provider authentication failed (401): Incorrect API key provided: [REDACTED]. ...`，与 completions/responses 正控同形。
- 红证：改前 401 errorMessage 逐字含 `sk-live-SUPERSECRET123`、无 diagnostics → 绿 [REDACTED]/无明文（message 与 diagnostics 序列化都验）、kind=auth、status=401；429 → kind=rate_limit + status 429。
- 顺带修 mapCodexEvents 的 response.failed / error 事件：附结构化 body 使分类后消息保留 provider 短文本（"Provider server error (server_error): boom"），否则 codex-sse-tail-terminal-guard 的 "boom" 断言会掉。

## 新增/修改测试
- 新增 4 文件 33 测：`provider-usage-merge.test.ts`（13）、`responses-incomplete-terminal.test.ts`（7）、`provider-stream-termination-guard.test.ts`（10）、`codex-stream-failure-diagnostic.test.ts`（3）。改前红 21/33（其余 12 为正控/守恒断言，其中 2 例改前绿是 ERR-2 未触发面，修复后仍绿且语义生效）。
- 更新 2 个既有测试（行为有意变更，均在提交内披露）：
  - `tool-call-args-final-parse-on-error.test.ts`：stall 形态现在会抛 StreamFailureError（断言改为 expect throw + 参数仍新鲜）。
  - `openai-responses-partial-json-cleanup.test.ts`：fixture 补 response.completed 终帧（原 fixture 即「无终帧正常返回」的 ERR-1 形态）。

## 回归与验证
- 回归批次（≤3 文件/批，全绿）：google-stopreason-guard(12)、google-vertex-thinking-budget(2)、google-vertex-api-key-resolution(8)、openai-completions-toolcall-pairing、tool-choice、final-parse-on-error(5)、stream-failure-diagnostic、responses-stream-item-dispatch、codex-sse-tail-terminal-guard(7)、codex-retry-behavior(5)、codex-stream-failure-diagnostic(3)、openai-codex-stream+thinking-as-text+stream-failure-diagnostic(24)、preserve-thinking/response-model/prompt-cache/empty-tools(27)、cache-control-format/bedrock-thinking-payload/bedrock-long-cache-write-pricing/bedrock-endpoint-resolution(26)、anthropic-sse-data-frame-guard/sse-parsing/stream-failure/partial-json-cleanup(36+1)、responseid/foreign-toolcall-id/empty-tool-result(3+11 skipped)。
- `cache-retention.test.ts` 3 例 30s 超时＝**预存环境问题**：同一文件在未改动的主仓 pristine 工作树同样 3 败（fake-key 打 api.openai.com 的网络超时），与本提交无关。
- biome check（--error-on-warnings）干净；`tsgo --noEmit` 干净；test-hygiene gate OK（no new private-member probes）。
- 提交后 pristine 树验证（git archive a5cd634f7 + node_modules symlink）：tsgo EXIT 0 + 4 个新测试文件 33/33 绿。

## 交付物
- 提交：`/tmp/r33_impl` branch `wt-e4err` @ `a5cd634f7`（主仓零写入、零 push）
- 本报告：`/tmp/audit_r/round-33/impl-e4err.md`
- changelog fragment：`packages/ai/.changes/r33-e4err-usage-termination.md`
