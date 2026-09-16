# r42 泛扫 —— 模型注册表/选择/故障切换链（model-chain）

- 仓库：/Users/a1/Desktop/ai/prime-agent（只读），HEAD `a609c6ac597bd1285c8254a27682c4f1cdd9ed65`（merge/repl-kernel）
- 本线自测部分：①model-resolver 默认/兜底路径 ②auth 失败时的模型不可用面（凭据失效→列表变化→会话中途换模型？）
- 子面（并行子代理，原始报告另存本目录）：③models.json 热加载 → `model-chain-hotreload.md` ④thinking 档位映射一致性 → `model-chain-thinking.md` ⑤provider 健康度反馈 → `model-chain-health.md`
- 复现脚本：`/tmp/audit_r/round-42/probe-model-chain.ts`、`probe-fuzzy.ts`、`probe-contrast.ts`、`probe-stale.ts`（均用 `npx tsx`，在 packages/coding-agent 下跑；已 unset RLM_*/PRIME_AGENT_*/PI_* 泄露变量）
- 去重：`/tmp/audit_r/round-42/decisions.jsonl` 不存在；台账实际在仓内 `docs/fork/audits/decisions.jsonl`（346 条），本线三条子面 + 本席均已按关键词逐条比对，详见文末「去重与相邻条目」。

---

## 总判定（先给结论）

**运行中的会话没有任何"自动换模型/降级"的路径**：鉴权失败、重试耗尽、429/超时、上下文溢出都不会把会话切到别的模型或别的 provider（正控见 F5 与 ⑤F3），且**模型选择对 provider 健康度零反馈**（⑤F3）。真正的问题在**选择/恢复阶段**：显式或半显式的模型选择会在用户不知情时换 provider 或换定义（F1/F2/F3），会话恢复时凭据失效会静默换到默认模型且不写 model_change 台账（⑤F4）；此外**一次 401/403 会把 provider 整体从可用面摘掉、且该标记在本进程内不可恢复，后续 run 被以误导性文案拒绝**（F5+⑤F1）。

---

## F1（high）`--model <模糊词>` 会跨到没有凭据的 provider，且不报错、只在首轮对话才暴露

**命题**：不带 `--provider` 的 `--model <pattern>` 走 `modelRegistry.getAll()`（未鉴权过滤的全量目录，1245 个模型），模糊匹配在同分候选里只按 `model.id` 字典序取最大者，忽略 provider，也忽略"哪个 provider 有凭据"。结果：用户输入 `sonnet`（只有 Anthropic key 的机器）会被解析成 `amazon-bedrock/us.anthropic.claude-sonnet-5`。

**severity**：high（用户以为在跑 anthropic/sonnet，实际是另一 provider 的同系列模型；无任何诊断输出）

**file:line**（HEAD a609c6ac5）
- `packages/coding-agent/src/core/model-resolver.ts:124-147` `tryMatchModel()`：模糊分支
  ```ts
  const matches = availableModels.filter((m) => m.id.toLowerCase().includes(...) || m.name?.toLowerCase().includes(...));
  ...
  const aliases = matches.filter((m) => isAlias(m.id));      // 142
  aliases.sort((a, b) => b.id.localeCompare(a.id));          // 142
  return aliases[0];
  ```
- `packages/coding-agent/src/core/model-resolver.ts:356` `resolveCliModel()`：`const availableModels = modelRegistry.getAll();`（注释明说"use *all* models here, not just models with pre-configured auth"）
- 调用点 `packages/coding-agent/src/main.ts:595-618`（`buildSessionOptions`，`config.model` → `options.model`，无鉴权校验）；错误诊断才会 `process.exit(1)`（`main.ts:1606-1607`），而模糊命中不产生 error。

**逐字证据**（`probe-fuzzy.ts`，临时 agent dir 内只写 `anthropic` 运行时 key；getAvailable 只有 anthropic 13 个模型）
```
auth-configured providers (getAvailable): anthropic
total models in registry: 1245
{"q":"sonnet","picked":"amazon-bedrock/us.anthropic.claude-sonnet-5","pickedHasAuth":false}
{"q":"opus","picked":"amazon-bedrock/us.anthropic.claude-opus-5","pickedHasAuth":false}
{"q":"haiku","picked":"amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0","pickedHasAuth":false}
{"q":"gpt-5","picked":"azure-openai-responses/gpt-5","pickedHasAuth":false}
{"q":"kimi","picked":"vercel-ai-gateway/moonshotai/kimi-k3-fast","pickedHasAuth":false}
{"q":"glm","picked":"vercel-ai-gateway/zai/glm-5v-turbo","pickedHasAuth":false}
{"q":"gemini","picked":"openrouter/google/gemini-3.7-flash","pickedHasAuth":false}
{"q":"deepseek","picked":"amazon-bedrock/us.deepseek.r1-v1:0","pickedHasAuth":false}
{"q":"sonnet:high","picked":"amazon-bedrock/us.anthropic.claude-sonnet-5","pickedHasAuth":false,"thinkingLevel":"high"}
{"q":"claude-sonnet-4-5","picked":"anthropic/claude-sonnet-4-5","pickedHasAuth":true}   <-- 精确 id 才落回有凭据的 provider
```
对照（`probe-contrast.ts`）：同一台机器上**另一条**选择路径 `resolveModelScopeFromModels`（`--models`/settings.enabledModels，输入是 `refreshAvailableModels()` 的鉴权过滤列表）解析同一个词就落到有凭据的 provider：
```
available models: 13 providers: anthropic
{"q":"sonnet","scopePath":["anthropic/claude-sonnet-5"],"cliPath":"amazon-bedrock/us.anthropic.claude-sonnet-5"}
{"q":"opus","scopePath":["anthropic/claude-opus-5"],"cliPath":"amazon-bedrock/us.anthropic.claude-opus-5"}
```

**影响**：会话模型被静默换成另一个 provider 的同系列模型；footer/状态栏显示 `amazon-bedrock/us.anthropic.claude-sonnet-5` 与用户输入的 `sonnet` 差异不显眼。第一轮 run 才抛 `agent-session.ts:2926-2937` 的 `_validateCanStartAgentRun()` → `No API key found for amazon-bedrock.`（`auth-guidance.ts:36-39`）；用户会以为是"没登录"，而根因是他要的模型被换成了没凭据的 provider。若用户配了该误判 provider 的凭据（本批多数用户配多个 provider），则直接按错误 provider 计费/走不同 baseUrl 静默成功——这才是最坏的形态。

**可复现**：
1. `mkdir -p /tmp/t && echo '{"anthropic":{"type":"api_key","key":"sk-ant-..."}}' > /tmp/t/auth.json`（或只设 `ANTHROPIC_API_KEY`）
2. 跑 `npx tsx /tmp/audit_r/round-42/probe-fuzzy.ts`（脚本内 `AuthStorage.create(tmpdir/auth.json)` + `setRuntimeApiKey("anthropic", ...)`，与 `PI_AGENT_DIR` 无关，纯函数级）
3. 观察 `{"q":"sonnet","picked":"amazon-bedrock/...","pickedHasAuth":false}`；对照 `probe-contrast.ts` 的 `scopePath`
4. 端到端等价输入：`prime-agent --model sonnet`（`cli/args.ts:208` 不要求 `--provider`）

**测试覆盖**：`packages/coding-agent/test/model-resolver.test.ts:135-195` 只用 2-4 个 mock 模型、单个 provider 命中，**没有任何"多 provider 同名模糊命中"的用例**（正控：该文件确有 `--model <pattern>:<thinking>`、provider 前缀推断、驼峰等用例，说明我的检索能看到该文件的全部用例）。

**confidence**：high（函数级实测 + 调用链逐行核对）

**修法方向**（不改，仅建议）：模糊 tie-break 时优先 `hasConfiguredAuth(provider)`，或在 `resolveCliModel` 的模糊分支用 `getAvailable()`（有凭据面）再回退 `getAll()`（保留 `--api-key` 首配路径）；并在命中 provider ≠ 任何有凭据 provider 时产出 warning 诊断。

---

## F2（medium）`--provider X --model <目录里不存在的 id>`：伪造一个"自定义 model id"，定义整段继承 X 的默认模型，只有一行 warning

**命题**：`buildFallbackModel()` 用 `{...providerDefaultModel, id: pattern, name: pattern}` 造一个模型，于是 contextWindow / maxTokens / cost / reasoning / thinkingLevelMap / api / baseUrl / compat 全部来自**另一个模型**。用户以为在跑 `X/<自己写的 id>`，参数却来自 X 的默认模型。

**file:line**：`model-resolver.ts:157-172`（`buildFallbackModel`）、`model-resolver.ts:454-461`（`resolveCliModel` 里 `Model "..." not found for provider "...". Using custom model id.` 仅作 warning）

**逐字证据**（`probe-model-chain.ts` PROBE 2，anthropic）
```
=== PROBE 2: --provider anthropic --model <typo> (resolveCliModel)
{ "model": "anthropic/claude-opus-4-99", "baseUrl": "https://api.anthropic.com",
  "api": "anthropic-messages", "contextWindow": 1000000,
  "thinkingLevelMap": { "xhigh": "xhigh", "max": "max" },
  "warning": "Model \"claude-opus-4-99\" not found for provider \"anthropic\". Using custom model id." }
```
（对照真实 `anthropic/claude-opus-4-7`：同样 contextWindow 1000000 / thinkingLevelMap {xhigh,max} / cost {5,25,0.5,6.25} —— 即这些数字是"借"来的，不是该 id 的真实参数）

**影响**：id 打错一个字时不会拒绝启动，而是带着别的模型的上下文窗口/成本/思考档位语义去发请求；只有 `Warning:`（stderr，`main.ts:602`，exit code 0）——在 TUI 里容易被滚动冲掉。若该 provider 默认模型是"无 reasoning"的小模型，用户选的自定义推理模型会静默退化成非推理（thinking 档位丢失）。

**可复现**：`npx tsx /tmp/audit_r/round-42/probe-model-chain.ts`（PROBE 2 段）；端到端 `prime-agent --provider anthropic --model claude-opus-4-99`。

**confidence**：high（实测 + 代码逐字）

---

## F3（medium）settings 里保存的默认模型 id 不在本次目录快照时，**连 warning 都没有**地静默重建

**命题**：`findInitialModel()` 的 saved-default 分支在 `availableModels` 找不到 id 时调用同一个 `buildFallbackModel()`，并把 `fallbackMessage` 置为 `undefined`。用户改过 `settings.json` 的 defaultModel、或目录版本回退/换机后，会静默跑在一个"借了别的模型定义"的 id 上。

**file:line**：`model-resolver.ts:546-566`（注释逐字："Rebuild from the provider template when the saved id is missing from this build's snapshot (e.g. prime-inference catalog churn), so it survives updates."，其中 `return { model, thinkingLevel, fallbackMessage: undefined }`）

**逐字证据**（`probe-model-chain.ts` PROBE 1；defaultProvider=anthropic, defaultModelId=claude-opus-4-6-does-not-exist）
```
{ "model": "anthropic/claude-opus-4-6-does-not-exist", "name": "claude-opus-4-6-does-not-exist",
  "baseUrl": "https://api.anthropic.com", "api": "anthropic-messages",
  "contextWindow": 1000000, "maxTokens": 128000, "reasoning": true,
  "thinkingLevelMap": { "xhigh": "xhigh", "max": "max" },
  "cost": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 } }
```
（输出里没有 `fallbackMessage` 键 = undefined；同一脚本的 PROBE 3 证明 `--model` 裸词失败时会给出 error 字符串，说明该字段确实会被填充，不是打印问题——这是本条的**正控**）

**影响**：静默降级 / 静默"换定义"。与 F2 同根因，但这条没有任何提示；用户唯一可见的现象是请求失败（404 model_not_found）或参数不符（上下文窗口按 1M 计算 → 到真实模型上限才报 overflow）。

**可复现**：`npx tsx /tmp/audit_r/round-42/probe-model-chain.ts`（PROBE 1）；或把 `~/.prime/agent/settings.json` 的 `defaultModel` 改成一个不存在的 id 后启动。

**confidence**：high

---

## F4（low，结构性/负结论+正控）恢复会话失败是**可见**的，但恢复逻辑有三份重复实现，且导出给外部用的那份已无人调用

**命题**：模型恢复面本身不静默——`main.ts:950-976` 与 `sdk.ts:182-208` 各内联一份「发现 saved model 不可用 → `Could not restore model X` → 用默认模型 → `Using Y`」，`model-resolver.ts:581-638` 的 `restoreModelFromSession()`（带 `shouldPrintMessages` 的完整版）在 src 里**没有任何调用者**。

**正控**：`grep -rn "restoreModelFromSession" packages/coding-agent/src` → 0 命中；`grep -rn ... test` → 仅 `test/suite/regressions/4645-internal-glm.test.ts:6,144`。证明检索能看到该符号，src 侧确实无人调用。

**影响**：三份实现的差异（`restoreModelFromSession` 会额外打印 `Restored model:`/`Falling back to:` 并区分 `model no longer exists` / `no auth configured` / `model is not available`，内联版只有一句 `Could not restore model X`）意味着"为什么落到默认模型"这个诊断只存在于死代码路径里；未来修 F3 需要同时改三处，风险高。

**补（合并 ⑤F4 后）**：这条"可见"的限定是**提示可见、台账不可见**——恢复路径不会向 session JSONL 追加 `model_change`（只有 `setModel` 会，`agent-session.ts:9774`），所以转录最后一条 model-change 与真正在跑的模型不一致；且该 fallback 只有部分入口展示（`isNoModelsAvailable` 那条还被要求按活会话复检，`auth-guidance.ts:20-28`）。

**severity**：low；**confidence**：high（纯检索，有正控）

---

## F5（②，high）401/403 之后凭据被永久（进程生命周期）标记 stale：provider 整体从可用面消失，后续 run 以误导性 "No API key found" 被拒，且没有任何 TTL/自动恢复

**命题链**（全部逐行核对）：
1. 触发：`agent-session.ts:15102-15118` `_isConcreteProviderAuthFailure()` 把 `401|403 + "status code"`（或 401/403 + auth 关键词）判为"具体鉴权失败"；`agent-session.ts:5214-5227` 在 `agent_end` 时对这类失败**再重试一轮**（`retryConcreteAuthFailure`）并 `_captureRetryAuthFailureSource()`。
2. 落标记：重试耗尽/关闭/被取消时 `_markProviderAuthStaleForRetryFailure()` → `agent-session.ts:15139-15158` `_markProviderAuthStale()` → `model-registry.ts:1383-1390` `markProviderAuthStale()` → `auth-storage.ts:681-696` `markAuthSourceStale()` 把 `{provider, source, identityFingerprint, valueFingerprint}` 记进 **in-memory** `staleAuthSources` Map（`auth-storage.ts:325`）。
3. 后果 A（列表）：`getAvailableAuthCandidate()`（`auth-storage.ts:618-633`）**跳过** fingerprint 相同的 stale 候选 → `hasAuth()` false → `ModelRegistry.getAvailable()`（`model-registry.ts:952-963`）把这个 provider 的所有模型滤掉 → `/model` 选择器、`model list`、`_authenticatedRlmModels()` 里都没了。
4. 后果 B（正在跑的会话）：模型**不会被换**（见下正控），但每次新 run 开头 `_validateCanStartAgentRun()`（`agent-session.ts:2926-2937`，调用点 3060 / 6089）会因 `hasConfiguredAuth` false 直接抛 `No API key found for <provider>.`（`auth-guidance.ts:36-39`）。
5. 无自愈：`staleAuthSources` 没有时间戳/TTL（`grep -n "staleAuthSources"` 全部 8 处，均无过期逻辑）；唯一的清除点是 `clearStaleAuthSource()`（`auth-storage.ts:700-711`），只在 `set()/remove()/removeVerified()`（828/838/860）里按 `source` 清除，或当凭据值变化导致 fingerprint 不再匹配时自动失效。`refresh()`（`model-registry.ts` reload 路径）**不清** stale。

**逐字证据**（`probe-stale.ts`，临时 agent dir，运行时 anthropic key）
```
before: providers with auth model count = 13 hasConfiguredAuth(anthropic) = true
before status: {"configured":false,"source":"runtime","label":"--api-key"}
markProviderAuthStale -> true
after : available model count = 0
after : hasConfiguredAuth(anthropic) = false
after status: {"configured":false,"source":"stale","label":"expired"}
after getApiKeyAndHeaders: {"ok":true}                 <-- apiKey 被静默丢弃（undefined），仍报 ok
refresh() then available = 0
POST refresh hasConfiguredAuth(anthropic) = false      <-- 刷新也不恢复
```
即：一次 401/403 之后，**同一个进程内**该 provider 从 `/model` 里消失、任何新 run 都被拒，而底层凭据其实还在（`getApiKeyAndHeaders` 仍能拿到/曾能拿到 key），报错文案却是"没有 API key"。

**正控（"不会中途换模型"这个负结论的证明）**：`grep -rn "agent.state.model = " packages/coding-agent/src` 只有 4 处写入：
- `agent-session.ts:9773` `setModel()`（用户/扩展/daemon `set_model` 命令）
- `agent-session.ts:9840` `_cycleScopedModel()`、`9879` `_cycleAvailableModel()`（用户按 ctrl+p 循环）
- `agent-session.ts:12103` `_refreshCurrentModelFromRegistry()`（**同 provider+id** 的刷新副本，只在扩展 register/unregister provider 时调用，见 12207/12211）
此外重试路径 `_handleRetryableError()`（`agent-session.ts:15274+`）只做 `this.agent.continue()`，**重发同一个 model**；溢出恢复 `_checkCompaction`（11599-11626）只做 compact-and-retry，并给出"switching to a larger-context model"的建议文案而非自动切换。→ 结论：故障链上没有自动换模型；用户可见的"模型被换掉"只发生在 F1/F2/F3 的选择期。

**severity**：high（凭据其实有效时也会把 provider 打死，且文案误导用户去 /login；对使用 env var / 运行时 key 的会话，除了重启进程或者重新登录写入新值，没有恢复路径）

**可复现**：
1. `npx tsx /tmp/audit_r/round-42/probe-stale.ts` → 观察 after 的三行
2. 端到端：把 `ANTHROPIC_API_KEY` 或 auth.json 里的 key 改成一个无效值 → 发一轮 → 得到 401 → 等自动重试耗尽（`settings.json` 的 retry 配置） → 把 key 改回**同样的值** → 再发一轮：得到 `No API key found for anthropic`，`/model` 里 anthropic 也消失；重启进程后恢复
3. 反向正控（证明不是"永久坏"）：调用 `authStorage.set(provider, 新值)`（等价 `/login` 重新写入）后 `hasConfiguredAuth` 恢复 true

**confidence**：high（函数级实测 + 全链路逐行）

**附带观察（medium-confidence，归入本条）**：`ModelRegistry.getApiKeyAndHeaders()` 在候选被标 stale 后返回 `{ok:true, apiKey:undefined}`（探针输出 `{"ok":true}`），说明 **`ok` 不等于"有可用凭据"**。当前 `ok`-only 的消费者只有 `agent-session.ts:14468-14470` 的 rlm 子代理鉴权预检（`if (!auth.ok) throw new Error(...failed authentication preflight)`），它靠 `_authenticatedRlmModels()`（`agent-session.ts:14435-14440` 过滤 `getProviderAuthStatus().source !== "stale"`）挡住了本次 stale 场景，所以暂未形成活跃 bug；但任何新增的 `ok`-only 检查都会静默通过。`_getRequiredRequestAuth()`（2198-2216）和压缩路径（11802-11819）都显式检查了 `apiKey` 缺失，是本条的对照面。

---

## F6（②/①，medium）"模型目录"有三个视图，用户可见面/子代理面/CLI 面互不一致

**命题**：`getAll()`（全量 1245，不过滤凭据）→ 被 `resolveCliModel`（`model-resolver.ts:356`）使用；`getAvailable()`（凭据 + prime-inference 私有模型授权，`model-registry.ts:952-963`）→ 被 `/model`、`model list` 使用；`getExecutableModels()`（`model-registry.ts:1153-1200`，再做 openai-codex 服务端目录交集 + 5 分钟缓存 + `PRIVATE_PRIME_AUTHORIZATION_CACHE_TTL_MS=5min`）→ 被 `rlm.find_models()` / 子代理模型选择使用（`agent-session.ts:14435-14442`）。

**逐字证据**（`probe-fuzzy.ts` 首两行）
```
auth-configured providers (getAvailable): anthropic
total models in registry: 1245        <-- getAll() 1245 vs getAvailable() 13
```
代码内已自认这种不对称（`model-registry.ts:448-455` 注释逐字："Skipping step 2 fails silently and asymmetrically: `rlm` subagent delegation and `find_models()` resolve through `getExecutableModels()` and lose the model, while `/model` reads the unfiltered `getAvailable()` and keeps offering it."）+ `model-registry.ts:1131-1147` 的 Codex 双改要求。

**影响**：用户能在 `--model` 里选中并"启动成功"的模型，可能既不在 `/model` 列表里、也不在 `rlm.find_models()` 里（F1 就是这条的一个实例）；"模型列表变化"（凭据失效、私有模型授权过期、codex 目录抖动）在不同面上不同步，任何"列表里有/没有"的判断都必须先说明看的是哪个视图。

**可复现**：`npx tsx /tmp/audit_r/round-42/probe-fuzzy.ts` 前两行；或对同一台机器分别跑 `prime-agent model list`（getAvailable）与脚本里的 `registry.getAll().length`。

**severity**：medium（不一致本身；单点故障形态由 F1 承担）；**confidence**：high（数量级实测 + 代码注释自认）

---

## ③调 模型目录缓存新鲜度（子面报告 `/tmp/audit_r/round-42/model-chain-hotreload.md`，20.8KB，心跳 model-chain-hotreload.hb）

**结论**：`models.json` **没有任何文件监视、没有 mtime/size 指纹、没有周期重载**；唯一重读时机是显式 `ModelRegistry.refresh()` 及其包装（`refreshAvailableModels()`/`refreshModelCatalog()`/`canUseModel()`）。触发它的用户动作只有：打开 `/model`（受 60s 客户端缓存约束）、切/设模型、登录登出、`model list`、daemon 的 `get_available_models|get_model_catalog|set_model|cycle_model`。**`/reload` 不重读 models.json**（`agent-session.ts:12639-12652` 只有 `this._modelRegistry.authStorage.reload()`，无 `modelRegistry.refresh()`；已由本席复核逐字确认）。

子面 F1-F6（均带 nil-probe exit 0 与正控）：
- **F1 medium** 无监视/无指纹：改文件后同进程不可见，直到 refresh。正控：同仓 idiom 枚举能命中 `settings-manager.ts:1342 watchFile`、`auth-storage.ts:231-238 statFingerprint`，models.json 一处不落。实测 STEP2（改盘不可见）→ STEP3（refresh 后可见）→ STEP7（新实例可见，证明文件确实在盘上）。
- **F2 medium** `/reload` 不覆盖 models.json —— 与已修 CD-5（settings.json 手动编辑不生效，已 @e16398d3b 修）同族的**未修缺口**，只是换了文件。
- **F3 low** TUI 模型目录有 60s 客户端缓存（`interactive-mode.ts:304 MODEL_CATALOG_REFRESH_TTL_MS`，8142-8148），`/model`（无搜索词）走缓存；带搜索词的 `/model xxx` 是 force。
- **F4 medium** 即使目录刷新，`AgentSession` 手里的模型对象是**旧快照**：`refresh()` 重建整表对象（`this.models = combined`），而 `get model()` 读 `this.agent.state.model`。实测 `m0===m1: false` 且"holder of m0 仍看到旧 contextWindow/baseUrl"。→ 撞到 overflow 400 后去改 models.json 的 `contextWindow`，**对运行中的会话无效**。
- **F5 low** 同进程两条读目录路径新鲜度不同：`rlm_find_models` → `getExecutableModels()` **不 refresh**（`agent-session.ts:14435-14440`），而 `/model`/`set_model` 走 `refreshAvailableModels()` 每次都重读 → 同进程两个列表可不一致。实测 5 步输出在报告内。
- **F6 medium** 加载失败/文件消失时**无 last-good 保留**：`loadCustomModels` 失败路径一律 `emptyCustomModelsResult()` → 自定义 provider 整体静默消失、只回退 built-in；文件被删除时连 `getError()` 都是 undefined；写坏文件在下次 refresh 之前 `getError()` 也仍是 undefined。`

与本线 F1/F6 的交叉：③F5（rlm 面 vs /model 面不一致）与我的 F6（三视图不对称）是同一现象的两个证据面；③F4（运行中会话持旧模型对象）给出了我的 F5 里"`_refreshCurrentModelFromRegistry()` 只在扩展 register/unregister 时调用"的补充：**除了那一处，运行中的模型定义本身不会被目录刷新更新**。

## ④调 thinking 档位映射表一致性（子面报告 `/tmp/audit_r/round-42/model-chain-thinking.md`，20.6KB；工件 payload.json/clamp.json + 4 个探针）

本席已独立复核其最关键两处引用（`packages/ai/src/models.ts:67-95`、`packages/ai/src/providers/openai-completions.ts:900-935`），逐字一致。测试：packages/ai 35 passed EXIT=0、packages/coding-agent 46 passed EXIT=0。

**本机（`~/.prime/agent/models.json`，provider bailian）实测 payload 表**：glm-5.3 的 7 个档位（含 off）全部发 `{"enable_thinking":true}`；deepseek-v4.1-flash 的 off→`thinking:{type:"disabled"}` 正常；kimi-k3 的 medium→`"high"`；qwen3.8-max-0902 的 high/xhigh/max 全部→`"xhigh"`。

- **④F1 high** `openai-completions.ts:900-903` 的 zai 分支只发布尔、**永不读档位**：glm-5.3 上选任何档位（含请求 off，被 clamp 到 minimal 后 `!!"minimal"===true`）都得到 `enable_thinking:true`；同模型 compat 里 `supportsReasoningEffort:true` 是**死配置**。→ 父席 AGENTS.md 的「glm-5.3 thinking 只能 low/high/max，不能关」经验其实是"档位根本不发"。
- **④F2/F3 high** 默认档 `DEFAULT_THINKING_LEVEL="medium"`（`defaults.ts:3`）跨模型漂移：kimi-k3 实发 `"high"`，qwen3.8 家族实发 `"medium"`；qwen3.8-max-0902 上 high/xhigh/max 同 payload → 「升到 max」零收益。
- **④F4/F5 high** `models.ts:78-95 clampThinkingLevel` **先向上夹取**：deepseek/deepseek-v4-flash 上 minimal/low/medium 全部落 `"high"`（要省反给最贵）；opencode-go/kimi-k3 supported=["max"]，7 档（含 off）全落 `reasoning_effort:"max"`；openrouter/deepseek-r1 的 off→`reasoning:{enabled:true}`。→ **"用户以为关了思考、实际最强思考"**，且夹取结果被 `setThinkingLevel` 写回 session + settings（`agent-session.ts:9910-9913`）、切模型后**不可逆丢失**（④F7 medium）。
- **④F6 medium** 同一意图两条链行为相反：`rlm.run(thinking=<不支持>)` **硬抛错**（`agent-session.ts:14536-14543`），而 `/effort`/`--thinking`/SDK 起始**静默夹取**（`agent-session.ts:9901-9903`、`sdk.ts:226`）。
- **④F8/F10 medium/low** 缺 map 的模型被 `getSupportedThinkingLevels` 判为"支持 off,minimal,low,medium,high"（`models.ts:74 return true`），并把 pi 的档位名**逐字**透传给 provider（`?? options.reasoningEffort`）；`thinkingLevelMap` 的值 schema 只校验是 string|null（`model-registry.ts:87`），typo 原样上线。1244 个注册模型里 700 个无 map。
- **④测试缺口（关键）**：现有测试只断言 `getSupportedThinkingLevels` 集合与临时构造模型的 payload，**没有任何测试断言注册表/本机 models.json 实际 map 的"档位→wire 值"** → 这一族漂移全部无守卫。

**与本线 F1/F2/F3 的连接**：我这条线的 F1/F2/F3 说明"用户选到的模型可能不是他以为的那个"，④说明"用户选到的档位也可能不是他选的那个"——同一句话的两个半句；且 ④F6 的"rlm 抛错 / UI 静默"与 ④F7 的"夹取写回 settings" 是**跨回合状态被静默改写**的独立形态。

---


## ⑤调 provider 健康度→模型选择 + 凭据失效面（子面报告 `/tmp/audit_r/round-42/model-chain-health.md`，20.0KB）

**⑤F3（medium，负结论+正控）= 我这条线最重要的一问的答案**：仓内**不存在**任何按 provider/model 的错误率、超时率、连续失败数、健康分来改变模型选择的路径。检索手段与正控（逐词 grep `failureRate|errorRate|healthScore|providerHealth|modelHealth|unhealthy|successRate|consecutive_failures|failureCount|circuit|breaker|cooldown|degraded`）= 前 11 个词 0 命中，后三个词的命中**全在 retention sweep / compaction / autoRefine / stall / daemon event-gap 域**，无一条落在 model-registry/model-resolver/agent-session 的选择路径上；正控为同手段确实命中了 `daemon-agent-connection.ts:2877-2892` 的 `tripEventGapRecoveryBreaker` 与 `daemon-supervisor.ts:981/3159/4233` 的 `consecutiveFailures`。→ **判定：模型选择对 provider 健康度完全无反馈。**

**⑤F1（high）= 我的 F5 的纵深版，且我们的实测互相印证**：
- 我这边（函数级）：`markProviderAuthStale` 后 `getAvailable()`=0、`hasConfiguredAuth`=false、`getApiKeyAndHeaders`→`{ok:true}`（key 被静默丢弃）、`refresh()` 不恢复。
- 子面那边（存储层跨进程）：`getApiKey` 直接返 `undefined`；**另一进程 `/login` 写回同值凭据后 worker 仍 `hasAuth=false`**（`isAuthSourceStale` 要求 source+identity+**value** 三指纹全等，`auth-storage.ts:599-605`），只有**值轮换**或同进程 `set()` 才恢复；**`environment` 源（`ANTHROPIC_API_KEY`）没有任何清除路径**（清除入口只在 `set/remove/removeVerified` 且只对 runtime/stored 源），`reload()` 无效 ⇒ 该 provider 在该 worker 生命周期内永久不可用，而错误文案让人去 `/login`。
- 两席合起来给出的用户可复现输入（端到端最小集）：设 `ANTHROPIC_API_KEY=<有效 key>` → 让一次请求得到 403/401（配额/团队/区域/临时风控，非凭据问题）→ 自动重试耗尽后 provider 被标 stale → 之后**每一个**新 prompt 都以 `No API key found for anthropic` 被拒、`/model` 里 anthropic 全部消失，且 `ANTHROPIC_API_KEY` 不变就无法恢复（只能重启进程或改用 `--api-key`）。
- 既有测试边界：`test/suite/regressions/4491-provider-stale-after-401.test.ts`（9 passed）**只断言标记生效、不断言恢复路径**——所以这不是被测试钉住的设计，而是未覆盖面。

**⑤F2（medium）跨层 request budget 上限被硬编码 12 覆盖**：`agent-loop.ts:907-909` 先以「无上限」建桶（`request-budget.ts:120-127` 已存在则忽略本次上限），session 的 `_crossLayerRequestBudget()`（`agent-session.ts:15018-15025`，JSDoc 声称"上限=逐层乘积"）永远被丢弃。实测 `retry.maxRetries=5 + provider.maxRetries=5`（乘积应 36）链上 `maxRequests=12`。→ 用户把重试调高反而更早被切断（默认配置恰好 (4)×(3)=12，所以默认无感）。这条**修正了我 F5 里"跨层预算耗尽"这一分支的语义理解**（我也引用了 `_crossLayerRequestBudget`，但没发现上限被忽略）。

**⑤F4（low/medium）恢复会话时凭据失效 ⇒ 静默换模型且**不写 model-change 台账**：`main.ts:952-960` 与 `sdk.ts:184-192`（两份内联实现）在 `hasConfiguredAuth` 不通过时丢弃会话记录的模型，随后落到全局默认模型（`model-resolver.ts:549-575`），而**不会**向 session JSONL 追加 `model_change`（只有 `setModel` 会 append，`agent-session.ts:9774`）⇒ 转录最后一条 model-change 与真正在跑的模型不一致。→ 这是我 F4（"恢复失败是可见的"）的**重要限定**：提示可见，但**台账不可见**；且我 F2/F3 展示的"无声重建"路径（`buildFallbackModel`）在恢复链上同样存在。

---

## 去重与相邻条目（对照 `docs/fork/audits/decisions.jsonl`，346 条，2026-09-16 16:09 版本）

本席最初在 /tmp 下未找到 decisions.jsonl（子面②③也报告未找到）；实际台账在仓内 `docs/fork/audits/decisions.jsonl`。已按 id/标题/证据全文检索下列关键词并逐条比对：`model-resolver|resolveCliModel|fuzzy|模糊|defaultModel|provider|模型列表|model list|getAvailable|getExecutableModels|codex|fallback|降级|stale|auth`（19 条命中，全部读过标题与证据摘要）。结论：

- **F1/F2/F3/F6 无重复**：台账中无任何条目标题/证据涉及模型选择的模糊匹配、`buildFallbackModel`、`findPreferredDefaultModel` 或三视图不对称。（正控：同一关键词检索能命中大量模型/鉴权相邻条目，见下。）
- **F5 与 ERR-3 相邻但不重复**：ERR-3 记录的是「auth 失败在 session 层被当可重试」（= 我 F5 的第 1 步），**本条的增量是其后半段**：重试耗尽后写下的 stale 标记无 TTL、不可自动恢复、把 provider 整体从可用面摘掉、并让后续 run 用误导文案被拒。
- **F5 与 SEC-6 相邻**：SEC-6 是「auth.json 盘上变更无失效通知 ⇒ 常驻 worker 内存 use-after-revoke」（**该失效时不失效**）；我这条是反向（**没失效时被标记失效**）。两者合起来是同一个 `staleAuthSources` 机制的两个方向。
- **F5 与 DO-5 相邻**：DO-5「CLI attach 视图静默丢 auth_stale」——本席补充：交互式 TUI 收到 auth_stale 后的处理是 `applyAuthStaleEvent`（interactive-mode.ts:2801-2814）→ 本地 registry 也标 stale + `footer.invalidate()` + `updateEditorBorderColor()`，而 `updateEditorBorderColor()`（7494-7499）只重读 editor 主题、**与鉴权状态无关**，所以那次 repaint 实际上是 no-op ⇒ **两个视图都没有用户可见的 stale 提示**。
- **F6 与 CD-1**（models.json 同进程两副面孔，已 fixed @408d3200e）无关：CD-1 是同一未变文件的首次/refresh 不一致，已修并有 `test/model-registry-schema-drift.test.ts`（5 passed）守卫。
- **⑤F2 与 RC-1..RC-4/K5（重试与 429 分类）不重复**：RC-3 记的是「当时根本没有跨层预算」这一已修问题，⑤F2 记的是修好之后**上限算法本身算错**（先到者定上限、乘积被丢弃）。
- **DAT-4** 提到「settings/model-registry/cron tmp+rename 无 fsync」——本次未覆盖该面（子面③报告里 model-registry 的私有授权缓存写入**有** fsync，见 `model-registry.ts` `writePrivatePrimeAuthorizationCache`；若非同一处，建议另立条目）。

## 复现清单（全部仓外、只读、不带写权限）

在 `/Users/a1/Desktop/ai/prime-agent/packages/coding-agent` 下（或 packages/ai，按子面报告）：
```
env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_MAX_DEPTH -u PRIME_AGENT_SESSION_ID -u PI_AGENT_DIR \
  npx tsx /tmp/audit_r/round-42/probe-fuzzy.ts        # F1
  npx tsx /tmp/audit_r/round-42/probe-contrast.ts     # F1 对照面
  npx tsx /tmp/audit_r/round-42/probe-model-chain.ts  # F2(2)/F3(1)/F3正控(3)/F1正控(4)
  npx tsx /tmp/audit_r/round-42/probe-stale.ts        # F5
子面③：hotreload_probe.ts / identity_probe.ts / executable_probe.ts（均 exit 0）
子面④：dump_maps.ts / probe_payload.ts / probe_clamp.ts / probe_google.ts（payload.json、clamp.json）
子面⑤：见 /tmp/audit_r/round-42/model-chain-health.md 内的脚本清单
```
测试正控（unset 泄露 env，包目录内跑）：`test/model-resolver.test.ts`、`test/model-registry-schema-drift.test.ts`、子面④的 3+3 个文件 —— 全部 exit 0。

## 本线整体判定

- 本周期「用户实际跑到哪个模型」这条链上，**没有运行时自动切换/自动降级**（F5 正控），但**选择期有 3 处静默改写**（F1 跨 provider、F2 跨定义带 warning、F3 跨定义无提示），且**鉴权失败会把 provider 整体摘掉并让用户看到错误的失败原因**（F5）。
- 档位（④）与目录新鲜度（③）各自独立地把"用户以为的配置"和"实际发出的请求"拉开。
- 全部条目 critical 0 条；high：**F1（本线，跨 provider 静默换模型）**、**F5（本线）+⑤F1（同一机制，凭据 stale 不可恢复）**、④F1/F2/F3/F4/F5（档位语义丢失/反转）；medium：F2/F3/F6（本线）、③F1/F2/F4/F6、④F6/F7/F8、⑤F2（预算上限被硬编码 12 覆盖）/⑤F3（无健康度反馈，负结论带正控）；low：F4（本线）、③F3/F5、④F9/F10/F11、⑤F4（恢复换模型不写台账）。
