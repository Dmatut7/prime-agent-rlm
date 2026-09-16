# r43 方案会 —— 簇 D：模型选择与故障切换（MC-1 / MC-2 / MC-3）

- 仓库：/Users/a1/Desktop/ai/prime-agent（只读，未开工作树、未写代码）
- 基线 HEAD：`49d0b072c23b43eddd7cf48fd5fada3e8f3b17a7`（r42 报告基线 a609c6ac5 之上的纯 docs 提交 `docs(audits): model chain findings`，src 未动，r42 代码面结论仍有效）
- 输入材料：r42 报告 `/tmp/audit_r/round-42/model-chain.md`（F1-F6）+ 子面 ②health（⑤F1/⑤F3/⑤F4）、③hotreload、④thinking；复现探针 `probe-fuzzy.ts` / `probe-contrast.ts` / `probe-stale.ts` / `probe-model-chain.ts`
- 本席复核动作：①通读 r42 全文；②逐行读齐下面 6 个文件的涉案区段（model-resolver.ts / model-registry.ts / auth-storage.ts / auth-guidance.ts / agent-session.ts / packages/ai 的 models.ts + openai-completions.ts）；③在当前 HEAD 复跑 `probe-fuzzy.ts` 与 `probe-stale.ts`（均 exit 0，行为与 r42 逐字一致：`sonnet → amazon-bedrock/us.anthropic.claude-sonnet-5`、`markProviderAuthStale 后 available=0 / hasAuth=false / refresh 不恢复`）；④核对本机 `~/.prime/agent/models.json` 的 bailian 五模型 thinkingLevelMap/compat（glm-5.3 `thinkingFormat:"zai"` + `supportsReasoningEffort:true` + `off:null`）。
- 判定主轴（按母席给定方向）：**MC-1 = 用户实际跑到哪个模型必须可见；MC-2 = 401 后用户知道该干什么 + 重登真的生效；MC-3 = 用户选的档位语义不能反转。**

---

## MC-1（P1）`--model <模糊词>` 跨 provider 乱选 + 首轮才报 No API key

### ① 根因复述

选择期把「全量目录」当「可选面」，且两条选择器输入集不同：

1. `resolveCliModel()`（`model-resolver.ts:356`）用 `modelRegistry.getAll()`（1245 个模型，**无鉴权过滤**；注释原文自认 "use *all* models here, not just models with pre-configured auth"，为保 `--api-key` 首配路径）。
2. 模糊分支 `tryMatchModel()`（`model-resolver.ts:118-147`）在同分候选里只按 `id.localeCompare` 降序取首个（`:142` `aliases.sort((a,b)=>b.id.localeCompare(a.id))`），**既不看 provider 也不看有无凭据**。实测（本席 HEAD 复跑）：只有 anthropic 凭据时 `sonnet → amazon-bedrock/us.anthropic.claude-sonnet-5`（pickedHasAuth=false）。
3. 对照面：`--models`/settings 路径的 `resolveModelScope()`（`model-resolver.ts:316-320`）用 `refreshAvailableModels()`（鉴权过滤后 13 个）——**同一个词在两条链解析到不同模型**（r42 F6 三视图不对称的实例）。
4. 启动期只把 error 变 exit（`main.ts:1606-1607`），模糊命中不产生 error；`buildSessionOptions`（`main.ts:595-618`）把结果直接放进 `options.model`。鉴权校验推迟到首轮 run 的 `_validateCanStartAgentRun()`（`agent-session.ts:2926-2937`）→ 抛 `No API key found for amazon-bedrock.`（`auth-guidance.ts:36-39`）。用户以为"没登录"，根因是"要的模型被换成了没凭据的 provider"；若用户恰好配了该误选 provider 的凭据，则按错误 provider 计费静默成功（最坏形态）。

### ② 候选修法

**候选 A（解析时鉴权过滤 + 失败给可用 provider 清单）**——把无 `--provider` 时的候选集换成鉴权过滤面
- 做法：`resolveCliModel` 无显式 provider 时优先在 `getAvailable()`（鉴权过滤）上解析；`getAll()` 只在三种例外下作为回退：(a) 用户给了显式 `--provider`；(b) `config.apiKey` 在场（`--api-key` 首配——注意 `main.ts:920-928` 的时序：`setRuntimeApiKey` 发生在解析**之后**、provider 取自解析结果，先有鸡后有蛋，所以必须传 `allowUnauthenticated` 旗标而不是事后补 key）；(c) 全机零凭据（此时失败文案给出"无任何已配置 provider，请 /login 或 --api-key"）。失败 error 文案列出：已配置凭据的 provider 列表 + 与 pattern 匹配但未鉴权的 provider（提示"要跑它们请先 /login 或 --provider 显式指定"）。
- 取舍：改动面中（resolveCliModel + main.ts 传旗标 + 文案）；风险低（行为只收窄"静默跨 provider"这一支）；兼容性：破坏 `--model <未鉴权词>` 不带 `--api-key` 的启动（这正是要杀的行为）；`--api-key` 首配路径靠旗标保住。测试面：现有 `test/model-resolver.test.ts` 的 mock registry 只实现 `getAll`（:138-271 十余处），需补 `getAvailable`，改动面外溢到测试文件。

**候选 B（保持模糊匹配，同分 tie-break 先取有凭据者 + 强诊断）**——排序键加 `hasConfiguredAuth`
- 做法：不动候选池（仍 `getAll()`），在 `tryMatchModel` 的排序比较器里加第一优先键 `hasAuth(a) - hasAuth(b)`（次键保持现 localeCompare 语义不变）；同时 `resolveCliModel` 在"最终选中模型的 provider 无凭据"时必产 warning 诊断（stderr 打印完整 `provider/id` + 指出这是无凭据命中 + 首轮会失败），可选把该 warning 升级为 error（等价候选 C 的轻量版）。
- 取舍：改动面最小（一个比较器 + 一条诊断）；风险低；兼容性最好（显式 provider 指向未鉴权 provider 仍按原样走，只多了提示）。**缺陷**：只修"有鉴权同分候选存在"的子集——当唯一模糊命中在未鉴权 provider 上（如 `--model gpt-5` 只有 azure 命中），仍会静默选中然后首轮才报错；排序键还引入"目录顺序变化改变选择"的新决定性维度。

**候选 C（CLI 拒绝未鉴权模糊命中，要求显式 `--provider`）**——最严：无 `--provider` 的 `--model` 必须落在鉴权面内，否则 exit 1
- 做法：`resolveCliModel` 对"模糊/部分命中且 provider 无凭据"返回 error（文案含可用 provider 列表与"用 `--provider <name> --model <pattern>` 显式指定"），`findInitialModel` 已有的 error→`process.exit(1)` 路径（`model-resolver.ts:519-527`）直接复用。
- 取舍：改动面小；风险中：把今天"能启动、首轮才炸"变成"启动即拒"，对脚本化调用是行为破坏（exit code 从 0+延迟失败 变 1+立即失败——更诚实但需写进 changelog）；`--api-key` 首配同样需要旗标例外；对多 provider 都配了凭据的用户，跨 provider 命中仍是静默的（C 不看"命中了哪个 provider"，只看"有没有凭据"）。

### ③ 推荐与理由

**推荐 A 为主干、吸收 C 的硬失败语义**（A 的例外 (c) 本来就等价于 C 的硬失败；A 比 C 多了"鉴权面内解析"，直接消灭跨 provider 乱选而不只是报错），B 的比较器改动**不采纳**（引入新的决定性维度、覆盖面又不满）。

理由（对照判定主轴"用户实际跑到哪模型必须可见"）：
1. A 把"可选面"从 1245 收敛到与 `/model`、`--models` 一致的鉴权面（≈13），三条链输入集对齐——顺带削掉 r42 F6 三视图不对称的一个实例，而不是再造第四种排序语义。
2. "可见"的最低要求是**选中的模型有凭据、能跑**；A 保证这一点在启动期就成立（或明确失败）。B 只保证"当存在有凭据的同分候选时"。
3. `--api-key` 首配例外靠显式旗标而非事后补 key，尊重 `main.ts:920-928` 的现有时序，不引入新的 chicken-egg。
4. 失败文案带"已配置 provider 清单 + 未鉴权命中清单"，把 r42 F1 的误导文案（"No API key found"）换成启动期一次说清。

配套可见性增强（小改动，建议一并做）：解析成功的模型在启动诊断里打印一行 `Model: <provider>/<id> (auth: <source>)`——footer 已显示但易被冲掉，stderr 一行成本极低。

### ④ 风险面清单

- **`--api-key` 首配路径回归**（最大风险）：时序上 key 注册在解析后，旗标传递漏一处即破坏首配。护栏：专测 `--model <unauth'd> --api-key k`（见⑤）。
- **测试 mock 面外溢**：model-resolver.test.ts 十余处 `as unknown as` mock 只有 `getAll`；新增 `getAvailable`/`hasConfiguredAuth` 后每个 mock 都要补，漏补会假绿（mock 缺方法=undefined 函数→运行时炸，还算显性；但要防"补了空数组"把用例变成恒 error 的假红）。
- **SDK/扩展路径**：`resolveCliModel` 的 src 调用点只有 main.ts:596（r42 已正控），但 SDK 有自己的内联解析（sdk.ts）——本修法不动它，需在报告里显式声明"SDK 路径不在本次范围"避免误以为已修。
- **行为变更公告**：`--model sonnet` 类启动从"静默跨 provider"变"解析到 anthropic 或启动期 exit 1"，属用户可见变更，需 changelog fragment（`packages/coding-agent/.changes/`）。
- **零凭据机器上的冷启动体验**：原来能进 TUI 再 /login，现在启动即 exit——文案必须给 /login 与 --api-key 两条出路，否则把新用户挡在门外（首配例外只覆盖带 --api-key 的场景）。
- **r42 F2/F3（buildFallbackModel 借参数）不在本修法内**：A 不动 `--provider X --model <不存在 id>` 与 saved-default 重建路径，须在交付报告里声明为未覆盖相邻面，防止验收时误判。

### ⑤ 验收护栏

红测设计（先红后绿，全部进 `packages/coding-agent/test/`，用 mock registry 同时实现 `getAll/getAvailable/hasConfiguredAuth`）：
1. **跨 provider 乱选（主红测）**：registry 含 anthropic（有凭据）+ amazon-bedrock 的 `us.anthropic.claude-sonnet-5`（无凭据），`resolveCliModel({cliModel:"sonnet"})` 必须 `model.provider === "anthropic"` 且 `hasAuth` 为真。当前实现下该用例失败（picked=amazon-bedrock）——已由本席 HEAD 复跑 probe-fuzzy 证实现状。
2. **无鉴权命中且无 --api-key → error**：`cliModel:"gpt-5"`（唯一命中 azure，无凭据）→ `result.error` 含已配置 provider 列表与 `--provider` 提示，`result.model === undefined`。
3. **--api-key 首配例外（防回归主控）**：同上场景但 `allowUnauthenticated:true`（或经 main 层传 config.apiKey）→ 解析成功且不被 error 拒绝。
4. **显式 --provider 未鉴权**：仍允许（保持现语义），但产 warning。
5. **精确 id 不受影响**：`claude-sonnet-4-5` 等精确命中用例（现文件已有类似）保持绿。
6. **变异正控**（r42 C2 教训：等价断言对共享实现变异是盲的）：故意删掉鉴权优先逻辑/翻转比较器 → 用例 1 必须失败；故意漏传 `--api-key` 旗标 → 用例 3 必须失败。两个正控各自单独跑一次记录 exit≠0。
等价证明：
- 对"现状已正确"的面：现有 `test/model-resolver.test.ts` 全量保持绿（精确 id、provider 前缀推断、`pattern:thinking` 后缀、OpenRouter 斜杠 id 等用例不动）。
- 行为变化面收敛可枚举：把 r42 `probe-fuzzy.ts` 语料（sonnet/opus/haiku/gpt-5/kimi/glm/gemini/deepseek/o3/qwen/claude/精确 id/带档位共 14 条）改造成表驱动断言，机器上只有 anthropic 凭据时，**允许且仅允许** pickedHasAuth:false 的那些条目变化（变 anthropic 命中或 error），其余逐字节不变——把"等价"定义成可数清单而不是模糊断言。
- 端到端：临时 agent dir + 单 provider runtime key 下跑 `prime-agent --model sonnet`，断言启动诊断/首轮行为与单测一致（仓外脚本，仿 probe-fuzzy 的 AuthStorage.create 模式，不写真 ~/.prime）。

---

## MC-2（P1）凭据 stale 后本进程不可恢复 + env 源无清除路径

### ① 根因复述

一次 401/403 之后，provider 被从可用面**整摘**，且标记只进不出：

1. 触发链：`_isConcreteProviderAuthFailure()`（`agent-session.ts:15102-15118`，401/403 + status-code 或 auth 关键词）→ 重试一轮耗尽/取消 → `_markProviderAuthStaleForRetryFailure()`（`:15139-15158`）→ `_markProviderAuthStale()` → `model-registry.ts:1383-1390` `markProviderAuthStale()` / `:1419-1446` `markProviderAuthSourceStale()`（**两层**：registry 自己的 `staleProviderRequestAuthSources` + `authStorage.markAuthSourceStale()`）→ `auth-storage.ts:681-696` 把 `{provider, source, identityFingerprint, valueFingerprint}` 记进 in-memory `staleAuthSources`（`:325`）。
2. 后果：`getAvailableAuthCandidate()`（`auth-storage.ts:618-633`）跳过三指纹全等（`:599-605` `isAuthSourceStale`，注意 value 指纹也参与）的候选 → `hasAuth()` false → `getAvailable()` 滤掉整个 provider → 新 run 被 `_validateCanStartAgentRun()`（`agent-session.ts:2926-2937`）以 **"No API key found"**（`auth-guidance.ts:36-39`）拒绝——文案误导：凭据还在，只是被本进程判了 stale。本席 HEAD 复跑 `probe-stale.ts`：mark 后 available=0、hasAuth=false、`getApiKeyAndHeaders` 仍 `{ok:true}`（ok≠有可用凭据）、`refresh()` 不恢复。
3. 不可恢复的三条路径缺口：
   - **无 TTL**：`staleAuthSources` 无时间戳，无过期逻辑；
   - **清除入口只有三处且只清 "stored" 源**：`set()/remove()/removeVerified()`（`auth-storage.ts:828/838/860`）→ `clearStaleAuthSource(provider,"stored")`（`:700-711`）；同进程 /login 写入新 stored 凭据可恢复，但 (a) runtime/environment/prime_cli 源的 stale 永不清（`getAuthSourceCandidates` 顺序 runtime→stored→environment，新 stored 会**遮蔽** stale 的 env 候选所以 hasAuth 恢复，但 stale 记录本身还在）；(b) **跨进程** /login（daemon worker 场景）同值写回：worker 的 `reloadIfAuthFileChanged()`（`:758-771`）检测到盘变后只 `reload()` data，**不清 stale** → stored 候选三指纹仍全等 → 依旧 stale（r42 ⑤F1 实测）；
   - **运行中会话无中途换模型**（这是**对的行为**，r42 F5 正控：`agent.state.model` 写点仅 4 处，故障链上只有 continue/compact），但恢复会话时凭据失效会静默落默认模型且不写 `model_change` 台账（r42 ⑤F4，`main.ts:952-960`/`sdk.ts:184-192` 内联实现）。

### ② 候选修法

**候选 A（stale 标记加 TTL + 外部重登失效 + 全源清除）**——把"永久"变"冷却"
- 做法：(a) `AuthSourceToken` 加 `markedAt`；`isAuthSourceStale`（以及 registry 侧 `isProviderRequestAuthStale*`）忽略超过 TTL 的 token（默认建议 10-15min，可放 settings 或常量；过期即自愈，真坏 key 下次 401 再标，成本一轮重试）；(b) `reloadIfAuthFileChanged()` 检测到**外部** auth.json 变化时，清掉受影响 provider 的 stale 记录（至少 "stored" 源；外部写入=用户在别的进程重登的信号）→ 跨进程同值 /login 生效；(c) `set()`（/login 落库）从"只清 stored 源"升级为"清该 provider 的**全部** stale 源"（显式重登动作语义上就是全源重置）。两层 stale（authStorage + model-registry）必须同步改。
- 取舍：改动面中（两个文件的 stale 判定/清除 + token 类型加字段）；风险中：TTL 让真失效 key 在 TTL 窗口后被重试一轮（可接受的失败成本，且重标是幂等的）；外部变更清 stored-stale 在"无关字段被外部改写"时会误复活 stale key（代价=一轮 401 再标，非数据风险）；兼容性：无 wire/schema 变化，`AuthSourceToken` 加可选字段向后兼容。TTL 语义要写清"冷却不是删除"——列表在 TTL 内仍摘除。

**候选 B（env 源显式清除通道）**——给 `PRIME_AGENT_*_API_KEY` 用户一条不用重启的恢复路
- 做法：新增 `PRIME_AGENT_CLEAR_STALE_AUTH=1`（或 `/auth retry <provider>` 命令/`prime-agent auth clear-stale` CLI 子命令）显式清 stale；或环境源凭据在值变化时自动失效（现机制其实已支持：value 指纹变化即不匹配——env 变值进程内立即可见，因为候选每次现算）。
- 取舍：改动面小；风险：**新的环境变量/命令=新的 API 面**，要进 docs+changelog+测试；且"用户怎么知道有这个开关"本身就是问题（401 后没人会去查文档）；真正缺的其实是 A 的自动路径。若做成 CLI 子命令则还需走 daemon 协议分类（进程边界：daemon worker 的 stale 在 worker 内存里，外部 CLI 清不掉 worker 内状态，除非发 daemon 命令让 worker 自清——改动面瞬间变大）。
- 备注：本机现实场景（母席 AGENTS.md 的 bailian `!cat key` command 源、runtime `--api-key` 源）里 env 源占比低；command 源（`getStoredAuthCandidate` 的 `!` 前缀，`resolveValueFingerprint` 惰性计算）同样没有清除路径，A 的 TTL+set-全清顺带覆盖。

**候选 C（失效即改文案 + 列表即时更新 + 会话不中途换模型）**——只做可见性与台账，不做恢复
- 做法：(a) `_validateCanStartAgentRun` 区分 stale：`getProviderAuthStatus().source === "stale"`（判别式已存在：`auth-storage.ts:647-657` 返回 `{configured:false, source:"stale", label:"expired"}`）时换文案："凭据仍在但本会话中被 401/403 拒绝并已停用；/login 重写凭据或重启进程后重试"（替换误导的 `formatNoApiKeyFoundMessage` 分支）；(b) 恢复会话落默认模型时向 session JSONL 补 `model_change` 台账（对齐 `setModel` 的 `appendModelChange`，`agent-session.ts:9774`），消灭 ⑤F4 的"台账与实跑不一致"；(c) 中途不换模型维持现状（r42 正控已证），加回归测试钉住。
- 取舍：改动面小-中；风险低；但它**不解决"重登真的生效"**——跨进程同值 /login 依旧不恢复，env 用户依旧只能重启。

### ③ 推荐与理由

**推荐 A + C 合体，B 降级为可选**（A 修"恢复路径真的通"，C 修"用户知道该干什么"；两者正交且都小）。判定主轴是"401 后用户知道该干什么（C）+ 重登真的生效（A）"——单做任何一个都只修半句。

- C(a) 是**必做**且最便宜：判别式 `source==="stale"` 已经存在，只是 `_validateCanStartAgentRun`（`agent-session.ts:2926-2937`）没看它；一行分支换来"报错说真话"。
- A(a) TTL 把"进程生命周期级死刑"降为"冷却窗口"，是唯一能自动救 env/runtime/command 源（无 /login 落库路径的用户）的机制。
- A(b) 外部变更清 stale 精准打掉 r42 ⑤F1 的实测缺口（跨进程同值 /login 不恢复）；A(c) 全源清除让同进程 /login 语义完整。
- C(b) 台账补写是 ⑤F4 的最小增量（两条内联恢复路径 + 一条死代码 `restoreModelFromSession`——注意 r42 F4 指出恢复逻辑有三份实现，改台账时三处都要对齐或显式声明只改活的两处）。
- B 的显式 env 清除通道不做进主干：它解决的是 A 已用 TTL 覆盖的场景，却引入新 API 面 + daemon 跨进程语义难题；如果 TTL 后仍有诉求再补。
- 顺带修（同一簇、零成本）：`getApiKeyAndHeaders` 在 stale 时返回 `{ok:true, apiKey:undefined}`（本席复跑证实）——`ok` 语义应改为"有可用凭据"或在文档/类型上显式声明 ok≠可用，堵住 r42 F5 的附带观察（未来任何 ok-only 消费者会静默通过）。

### ④ 风险面清单

- **两层 stale 状态不同步**：authStorage 与 model-registry 各有一份 stale（`markProviderAuthSourceStale` 同时写两层），TTL/清除只改一层会出现"列表恢复但请求仍拒"或反向的裂差。护栏：红测必须同时断言两层。
- **TTL 语义被误读为"凭证有效"**：TTL 过期≠凭据好，只是允许重试；文档与文案都要写"重试后 401 会再次停用"。
- **外部变更清 stale 的误复活**：无关外部写（另一进程改其他 provider、字段顺序重排）清掉本 provider 的 stale → 多一轮 401。可接受，但要在报告里记为已知取舍。
- **4491 既有测试面**：`test/suite/regressions/4491-provider-stale-after-401.test.ts` 断言"标记生效+文案带 /login 指引"，A/C 不得破坏标记行为本身；文案改动会碰到 `addLoginGuidanceToAuthError` 的追加文案断言（`:38 finalAssistant.errorMessage` toContain "Run /login"）——改文案时同步改断言，属预期红→绿。
- **时钟注入**：TTL 测试需要可控时钟；`AuthStorage` 现无 clock 依赖注入，加构造参数或导出测试钩子要遵守"不探私有成员"的测试卫生规则（用公共入口驱动，别 `vi.spyOn(target,"_foo")`）。
- **daemon 进程拓扑**：stale 在 worker 内存；/login 在哪个进程发生、`reloadIfAuthFileChanged` 是否及时触发，受 daemon 归属影响。方案不假设拓扑，靠"外部盘变→清"这一条与拓扑无关的规则兜底；跨 worker 生效延迟=下一次读凭据时（各 worker 的 reloadIfAuthFileChanged 惰性触发时机不同）——报告里要写清这个延迟面。
- **`ok:true` 语义收紧的连带**：若有隐藏消费者依赖"ok 但无 key"（r42 说当前只有 rlm 预检一处且被 `_authenticatedRlmModels` 挡住），收紧前先 grep 全部 `.ok` 消费点。

### ⑤ 验收护栏

红测设计（进 `packages/coding-agent/test/suite/regressions/`，新文件，沿用 4491 的 harness 模式；红=当前实现失败）：
1. **同进程 /login 全源恢复**：runtime 源标 stale → `authStorage.set(provider, 同值 api_key 凭据)` → `hasAuth()` 必须恢复 true（现状：stored 源恢复但 runtime stale 记录残留——断言"stale 记录被清"直接红）。
2. **跨进程同值 /login 恢复（r42 ⑤F1 复刻）**：标 stale → 用 `InMemoryAuthStorageBackend`/临时文件模拟另一进程写回**同值** stored 凭据 → 触发 `reloadIfAuthFileChanged` 路径（公共读 API 如 `getAuthStatus`）→ `hasAuth()` 恢复 true（现状红）。
3. **TTL 过期自愈**：标 stale → 推进时钟过 TTL → `hasAuth()` true 且 `getAvailable()` 数量恢复；未过期时保持摘除（同用例内两段断言，防"直接删了标记"的假绿实现）。
4. **文案真话**：标 stale 后 `prompt()` → 错误信息包含"rejected/401/403+停用"语义与两条出路（/login、重启），且**不再**是纯 "No API key found"（现状红）；同时 4491 原有断言（含 "Run /login to update credentials."）保持绿——文案改造的兼容下限。
5. **台账**：恢复会话时 saved model 无凭据 → 落默认模型后 session JSONL 出现 model_change 记录，最后一条与实跑模型一致（现状红，⑤F4）。
6. **不中途换模型（钉住正控）**：401→重试耗尽的整链后 `session.model` 的 provider/id 不变（现状绿，防回归——这是"好行为"的护栏，防止 A 的改动顺手加了换模型逻辑）。
7. **变异正控**：删掉 TTL 判断 → 用例 3 失败；删掉外部变更清 stale → 用例 2 失败；删掉 stale 分支文案 → 用例 4 失败。逐个单独验证 exit≠0。
等价证明：
- **标记语义不变**：4491 全套 9 用例保持绿（标记时机、事件、sourceTokens 形状都不动）——"改前改后对 401 的反应完全一致"，只有"反应之后的余生"变了。
- **分层一致**：同一红测内同时断言 authStorage 层（`getAuthStatus`）与 registry 层（`hasConfiguredAuth`/`getAvailable`）的恢复时刻相同（同一时钟点、同一触发），证明两层同步恢复，无裂差窗口。
- **非 stale 面零变化**：正常凭据（从未标 stale）的 hasAuth/getAvailable/请求路径行为不变——用现有 suites（model-registry-schema-drift 等）+ 新增"无 stale 干扰"对照用例证明。

---

## MC-3（P2）thinking 档位语义丢失/反转（zai 只发布尔 + clamp 先向上夹）

### ① 根因复述

两个独立缺陷叠加，共同效果="用户选的档位不是发出去的档位"：

1. **zai 分支档位丢失**（`openai-completions.ts:901-902`）：`if (compat.thinkingFormat === "zai" && model.reasoning) params.enable_thinking = !!options?.reasoningEffort;` —— 只发布尔，永不读档位；`thinkingLevelMap` 在该分支完全不被消费。同一形状的还有 `qwen`（:903-904）与 `qwen-chat-template`（:905-908）分支；deepseek 分支（:910-915）和 openrouter/通用分支（:916-935）是读 map 的正对照。`detectCompat`（:1501）对 zai 自动 `supportsReasoningEffort:false`，但 `getCompat`（:1540）允许 model.compat 显式覆盖——本机 models.json 的 glm-5.3 正是 `thinkingFormat:"zai" + supportsReasoningEffort:true + map{off:null, minimal:low,...max:max}`，`supportsReasoningEffort:true` 是**死配置**。
2. **clamp 先向上夹**（`models.ts:78-95` `clampThinkingLevel`）：请求档不在支持集时**先向上**找（`for i=requestedIndex..end`），找不到才向下。实测效应（r42 ④F4）：supported=[off,high] 的模型上 minimal/low/medium 全落 **high**（要省反给最贵）；glm-5.3（off:null）上请求 off → 夹到 minimal → `!!"minimal"===true` → `enable_thinking:true`（**关不掉**——母席 AGENTS.md 的"glm-5.3 thinking 不能关"经验即此）。
3. **钳制结果写回覆盖原意**（`agent-session.ts:9900-9923` `setThinkingLevel`）：effectiveLevel（钳制后）同时写 `agent.state.thinkingLevel`、`sessionManager.appendThinkingLevelChange`（:9911）与 `settingsManager.setDefaultThinkingLevel`（:9913）——用户原意不落任何持久层，切模型后按钳制值再钳（r42 ④F7：不可逆丢失）。另有一条链不一致：`rlm.run(thinking=<不支持>)` 硬抛错（`agent-session.ts:14536-14543`）而 `/effort`/`--thinking`/SDK 静默夹取（④F6）。
4. 调用点：`streamSimpleOpenAICompletions`（`openai-completions.ts:766-775`）每请求做 `clampThinkingLevel(model, requested)` → `reasoningEffort`（仅当钳制结果≠"off"）+ `reasoningEnabled`；agent-session 侧 `setThinkingLevel` 再钳一次并写回。**每请求都会重新钳**，所以"写回原意+用点钳制"在链路上是可行的（钳制不必发生在写回时）。

### ② 候选修法

**候选 A（zai 分支支持档位，按 model compat 显式开启）**
- 做法：zai 分支改造为——`reasoningEnabled===false` 时 `enable_thinking=false`；`reasoningEffort` 存在且 `compat.supportsReasoningEffort`（**只认 model.compat 显式 true**，detectCompat 对 zai 维持 false 不变，保证内置 zai 模型默认安全）时，把 `thinkingLevelMap[level] ?? level` 映射进 zai 的档位字段（具体字段名：glm 的 `thinking:{type,level}` 还是 `reasoning_effort` **取决于真实端点接受什么**，需先用 bailian glm-5.3 端点各发一次带档/带 off 的探针确认——本席无法在只读约束下替老板发真请求）；未开启时维持布尔现状。
- 取舍：改动面小（一个分支 + compat 语义）；风险**中-高**：wire 格式是外部事实，发错字段=400 或被静默忽略（后者更糟——又一层"以为发档位实际没发"）；必须按"每模型显式 opt-in"而不是按 format 全开。兼容性：不改 detectCompat 默认 → 内置模型零变化；本机 models.json 已写 `supportsReasoningEffort:true`，开启后 glm-5.3 立即生效（off 建议同批把 map 的 off:null 改成可关值——这是**用户侧数据**，方案里只建议不改）。qwen/qwen-chat-template 两分支同形状，可作为同一 PR 的顺带面或显式留待下一批。

**候选 B（clampThinkingLevel 改先向下夹 / 就近夹取）**
- 做法（按母席给定方向"先向下夹，低于最小档用最小档"）：`clampThinkingLevel` 改为——(1) 请求档在启用侧（非 off）时，先向下找最近的**启用侧**候选（不越过 off 边界，防止"要少思考变成完全不思考"）；(2) 启用侧没有 ≤请求档的候选时，取最小的启用档（"低于最小档用最小档"）；(3) 请求 off 而 off 不支持时，取最小启用档并**必须告警**；(4) 支持集为空/请求档非法时维持现状兜底。纯向下（不设 off 边界）会把 [off,high]+medium 夹到 off——静默关思考比夹到 high 更违反直觉（编码代理关思考常伤工具链质量），所以边界规则是本候选的关键设计点，不能省。
- 取舍：改动面小（一个纯函数 + 一组表驱动测试）；风险中：**改变所有带 thinkingLevelMap 模型的夹取结果**（正是目的，但要全量枚举变化面）；该函数在 `packages/ai`（已发布库）被多个 provider 每请求调用，语义变更需 changelog；agent-session 侧还有一个 `_clampThinkingLevel` 包装（`agent-session.ts:9998-10000`）直接转发，自动跟随。兼容性：请求档∈支持集时零变化（identity 路径不动）。

**候选 C（写回语义拆分：settings 存原意，state 存 effective）**
- 做法：`setThinkingLevel(level)` 把**用户请求的 level** 写 settings（`setDefaultThinkingLevel`）与一个新的意图槽（或在 state 上存 `requestedThinkingLevel`+`thinkingLevel` 两个字段），`agent.state.thinkingLevel`/`appendThinkingLevelChange` 继续存钳制后 effective（转录准确性不动）；`_getThinkingLevelForModelSwitch`（`agent-session.ts:9989-9996`）切模型时从**原意**重新钳制而不是沿用旧 effective。每次钳制发生时向用户出一条可见诊断（"模型 X 不支持档位 Y，已用 Z"——现在的静默是"可见性"主轴下的次级缺陷）。
- 取舍：改动面中（agent-session 状态字段 + settings 语义 + 事件语义）；风险中：`thinkingLevel` 字段被 SDK/daemon/TUI 多处消费，新增字段要查全消费者；settings 语义从"实际档"变"意图档"是**行为变更**（同值机器上无感，跨模型切换时行为变化=本次目的）；session JSONL 的事件形状不变（仍记 effective）。兼容性：不加 wire 字段则 daemon 协议不动——若意图槽要进 state 快照，需查 session 序列化形状是否算 schema 变更。

### ③ 推荐与理由

**推荐 B+C 为主干、A 为条件采纳**（分层理由）：

1. **B 是语义正确性的根修**且无外部事实依赖：现行为的"要省反给最贵/要关关不掉"是纯内错，不依赖任何 vendor 行为，修了就成立。off 边界规则（不静默跨越 on/off）比母席原文的纯向下更稳，但覆盖母席"先向下夹+低于最小用最小"的全部意图。
2. **C 是可见性与跨回合状态的根修**：不修 C，B 修完夹取方向，用户原意仍会在第一次钳制后丢失，切模型仍按错值再钳（④F7 的独立缺陷）。且钳制告警把"你实际跑在什么档"变成显式信息——直接服务主轴"用户选的档位可见"。
3. **A 的价值真实但有外部事实风险**：zai 端点接受什么档位字段是未知数（本机 bailian MaaS 兼容层对 glm 的接受面需实测），把它设为主干会让验收依赖一次真请求。降级为**条件采纳**：施工前先由老板侧发一次真探针（glm-5.3 分别带档位字段/off，看 400 还是生效），探针通过才做 A；不通过则 B+C 已把"语义丢失"收敛为"布尔开/关诚实可用"（off 走 reasoningEnabled=false 路径，glm-5.3 的关不掉问题在 B 的 (3)+告警下至少不再静默）。注意 A 独立解决不了"关不掉"——那靠 B(3) 与 map 数据修正。
4. 顺带对齐（可选小项）：`rlm.run` 抛错 vs `/effort` 静默夹的两链不一致（④F6）——建议保持 rlm 抛错（显式 API 契约；本席核对 `agent-session.ts:14536-14543`，其错误文案**已**列出支持档集合，无需再改文案），只把 `/effort` 侧补上同等的"被夹取"诊断即可，两条链的差异收敛为"显式 API 严格、交互面宽容+可见"。

### ④ 风险面清单

- **B 的全量行为变化面**：每个有 thinkingLevelMap 的模型、每个非精确档位请求的夹取结果都可能变（1244 注册模型中 700 无 map 走 `getSupportedThinkingLevels` 默认集，其中部分也受影响）。必须枚举可数变化清单（见⑤），否则 review 无法判断"改对了还是改崩了"。
- **`packages/ai` 是发布库**：`clampThinkingLevel` 语义变更影响所有外部消费者，需 minor 版本语义评估 + changelog fragment（`packages/ai/.changes/`）；不能只顾 coding-agent 侧。
- **每请求钳制的性能/日志面**：`streamSimpleOpenAICompletions` 每请求调 clamp——钳制告警不能放在这条热路径上打日志（每轮 spam），告警只放 agent-session 的 setThinkingLevel/模型切换点；纯函数保持纯。
- **A 的 wire 风险**：字段不被接受→400（显性，好）或被静默忽略（隐性，坏——等于白做还以为做了）；必须靠真探针+payload 断言双证。
- **C 的状态面**：state/settings/JSONL 三处持久形状、SDK 与 daemon 事件消费者、`cycleThinkingLevel`（`agent-session.ts:9966-9976` 按现 effective 循环）都要对齐新语义；cycle 的循环源建议保持 effective 列表（用户按 ctrl+p 的心智是"现模型能跑什么"）。
- **本机 models.json 是用户数据**：glm-5.3 的 `off:null` 决定"关不掉"是否纯代码面可修（B(3) 只能给最小档+告警，真要能关需要改 map 数据或 A 的显式 off 路径）——方案边界要在报告里写明"代码侧修语义，数据侧修能力"。
- **测试卫生**：不得用私有成员探针验证 state 内部字段（`vi.spyOn(target,"_foo")` 禁止），意图槽要通过公共入口（setThinkingLevel→getModelSwitch 结果→JSONL 事件）断言。

### ⑤ 验收护栏

红测设计：
1. **夹取方向矩阵（B 主红测，进 `packages/ai/test/` 新文件）**：表驱动 `supported × requested → expected`，至少覆盖：`[off,high]+{minimal,low,medium}→high`（改后：仍是 high，**但断言附带"被夹"信号**——B 的 off 边界规则下无更近启用档；此行是"不可变行"对照）；`[off,minimal,high]+medium→minimal`（现状 high，红）；`[off,null-map 如 glm] + off→最小启用档+告警`（现状 minimal 但语义反转成 enable，红的是"关不掉"面）；`xhigh+supported=[off,low,high]→high`（两向同值，防过修）；精确命中→identity（不变行）。矩阵数据源：内置 registry 代表模型 + 本机 models.json 五模型的实际 map（r42 ④测试缺口的正面补法——现在没有任何测试断言真实 map 的档位→wire 值）。
2. **zai payload（A 的红测，条件于探针通过）**：faux/mock 请求断言 opt-in 模型发档位字段（值=map 映射），未 opt-in 的 zai 模型仍只发布尔（负控）；off 走 `enable_thinking:false`。
3. **意图保持（C 主红测，进 coding-agent suite）**：模型 A（map 夹 medium→low）上 `/effort medium` → 切到支持 medium 的模型 B → 实际档位=medium（现状：永远 low，红）；JSONL 最后一条 thinking_level_change 记录 B 上的 effective=medium。
4. **钳制可见性**：夹取发生时用户可见一条含"requested X → using Y"的诊断（现状无任何输出，红）。
5. **变异正控**：把 clamp 改回向上优先 → 用例 1 的红行变绿（即失败）；删意图槽写回 → 用例 3 失败；删 zai opt-in 判断 → 用例 2 的负控行失败。逐个验证。
等价证明：
- **identity 路径零变化**：矩阵中所有"请求档∈支持集"的行断言输出=输入（clamp 函数对该输入集合是恒等——这也是用例 1 的"不可变行"设计目的）。
- **非 reasoning 模型零变化**：`getSupportedThinkingLevels` 对 `reasoning:false` 返回 `["off"]` 的现行为不动，用现有 `supports-xhigh.test.ts` 全绿证明。
- **wire 面等价（B）**：对请求档=支持档的会话，改前改后发出的请求 payload 逐字节相同（faux provider 抓 payload 对比——沿用 r42 ④ probe_payload 的取法改成 vitest）；变化只允许出现在"请求档∉支持集"的可枚举行上。
- **A 的双证**：真端点探针（老板侧一次）+ faux payload 断言（CI 可重复）各一份，缺一不验收。

---

## 附：实施顺序与共同护栏

建议顺序：**MC-2 的 C(a)（文案真话，最小）→ MC-1（A+C）→ MC-2 的 A（TTL/清除）与 C(b)（台账）→ MC-3 的 B → C → A（条件于探针）**。理由：MC-1/MC-2 文案与恢复是 P1 且互不依赖可并行；MC-3 的 B 是纯函数改动适合独立小 PR；A 挂在探针结果上不阻塞前面任何一项。

共同护栏（沿用本仓既有纪律）：
- 每个修法单独成 PR/commit，`git add` 只点名本席文件，`--only` 共仓纪律、禁 amend、pristine-tree `tsgo --noEmit` 复验；
- 测试跑在包根、unset `RLM_*/PRIME_AGENT_*/PI_*` 泄露变量（`env -u` 拼对，macOS 上 `-u=NAME` 静默失败）；
- 每条"等价"断言配一个变异正控（r42 C2 的方法论教训：等价断言对共享实现的变异是盲的）；
- changelog fragment：MC-1/MC-2 落 `packages/coding-agent/.changes/`，MC-3 的 B 另落 `packages/ai/.changes/`；
- 本机 models.json 的 map 数据修正（glm-5.3 的 off）属用户侧数据，不在代码 PR 内，单独由老板决定。
