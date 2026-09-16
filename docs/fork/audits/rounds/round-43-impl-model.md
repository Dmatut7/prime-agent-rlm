# r43 实施报告 —— 簇 D 模型链（MC-1 / MC-2 / MC-3）

- 工作树：`/tmp/audit_r/round-43/wt-model`（detached @ `5958253d5`，基线＝冻结 SHA `b908e9acf`，node_modules symlink 主仓）
- 严格按 `/tmp/audit_r/round-43/model-chain-plan.md` 实施（A/C 合体主干，MC-3 只做 B+C；方案 A（zai 档位字段）按方案书「条件采纳」未做——无老板侧真端点探针）。
- 纪律执行：先红后绿（红测先跑确认失败再动 src）；vitest 直接 `node node_modules/vitest/dist/cli.js --run`；测试批 ≤3 文件；跑测试 unset 泄露变量（PRIME_AGENT_INTERNAL_DAEMON_*、RLM_*）；未跑 doctor/daemon ps；git add 逐文件点名、staged 逐文件核对；pristine-tree `git archive HEAD` + tsgo 复验 EXIT=0。
- 超时说明：收口晚于 45min（读方案+取证占前段；MC-3 因 map 语义纠偏与 daemon 联合类型回退多花两轮）。

## MC-1 `--model` 跨 provider 乱选 + 首轮才报 No API key

改法（方案 A + C 硬失败语义）：
- `resolveCliModel`（model-resolver.ts）新增 `allowUnauthenticated?: boolean`；无显式 `--provider` 且无旗标时在 `getAvailable()`（鉴权面）解析；`getAll()` 只留三例外：显式 `--provider`、`--api-key` 首配旗标（main.ts `buildSessionOptions` 传 `Boolean(config.apiKey)`，尊重 setRuntimeApiKey 后置时序）、全机零凭据（getAvailable 空而 getAll 非空 → 启动期 error 给 /login 与 --api-key 两条出路）。
- 失败文案（鉴权面内未命中时）：列出已配置 provider 清单 + 未鉴权命中 provider + `--provider <p>` 显式指定提示。
- 未做（显式声明）：SDK 内联解析路径（sdk.ts 自有逻辑）不动、`buildFallbackModel` 借参数面（F2/F3）不动、启动诊断 `Model: <p>/<id> (auth)` 一行（方案书"建议一并做"的可选项，本轮超时未加，见「遗留」）。

红→绿：
- 新增 6 个 mock 用例 + probe-fuzzy 语料 13 条等价断言（真实 ModelRegistry + inMemory authStorage，仅 anthropic 凭据；skipIf 保护非 anthropic-only 环境）。改前 5 failed / 27 passed → 改后 32/32 绿。
- 逐字红测（方案书⑤.1）：`sonnet` 改前 `amazon-bedrock/us.anthropic.claude-sonnet-5`（pickedHasAuth:false，与 r42 probe-fuzzy 基线逐字一致，本席在冻结 SHA 复跑留档）→ 改后 anthropic 命中。
- 等价契约：语料中唯一 pickedHasAuth:true 行（`claude-sonnet-4-5 → anthropic/claude-sonnet-4-5`）逐字节不变；11 条 pickedHasAuth:false 行只允许变 anthropic 命中或 error（测试断言 model⇒hasConfiguredAuth）。
- mock 面外溢：现有 8 处 mock registry 补 `getAvailable`（返回与 getAll 同集，防"空数组假红"）。

## MC-2 凭据 stale 不可恢复 + 误导文案 + 台账

改法（方案 A+C 合体）：
- `AuthSourceToken` 加 `markedAt?: number`；导出 `STALE_AUTH_COOLDOWN_MS = 15min`（方案书 10-15min 区间取上沿）与 `isStaleAuthTokenExpired`。
- TTL：authStorage 层 `getActiveStaleAuthSources`（isAuthSourceStale 走活性子集）+ registry 层 `getActiveStaleProviderRequestAuthSources`（is/isForStatus 两处）同步过滤；标记幂等重打时刷新 markedAt（冷却重启动）。**冷却非删除**：记录留在 map，TTL 内仍摘除。
- `reloadIfAuthFileChanged`：stat 身份移动即清 stored 源 stale（同字节新 stat 分支也清——同值跨进程 /login 正是 ⑤F1 的盲区；误复活代价=一轮 401 再标，已按方案书记为已知取舍）。
- `set()`：`clearStaleAuthSource(provider,"stored")` → `clearAllStaleAuthSources(provider)`（全源清除）；/login 流（auth-flows.ts:758）同步调新增公共 `modelRegistry.clearProviderAuthStale(providerId)`（registry 层重置）。
- `_validateCanStartAgentRun`：hasConfiguredAuth 失败时先看 `getProviderAuthStatus(provider).source === "stale"`（判别式两层覆盖：authStorage stale 或 registry models_json stale 都返回 stale）→ 新 `formatStaleAuthMessage`（凭据仍在、本会话被 401/403 拒绝并停用、/login 或重启、冷却自动恢复）；否则才落旧 "No API key found"。
- 台账（⑤F4）：sdk.ts `createAgentSession` 的 `hasExistingSession` 分支补 model_change（saved model 与实际 model 不一致时 appendModelChange）——main.ts 与 sdk 两条活路径共此一点；`restoreModelFromSession`（r42 F4 死代码）未动，显式声明。

红→绿：新增 `test/suite/regressions/r43-auth-stale-recovery.test.ts` 6 用例，改前 6 failed 全部红在点上（runtime stale 残留 / 跨进程同值不恢复 / TTL 不存在 / 文案="No API key found for faux.\n\nUse /lo…" 逐字留档 / clearProviderAuthStale 不存在 / 台账最后一条=ghost-provider）→ 改后 6/6 绿。
- 4491 全套 9 用例保持绿（标记时机/事件/文案断言未破坏）。
- harness 加 `modelRegistry` 暴露（additive；providerApiKey 选项试加后因 registerProvider 校验必填 apiKey 回退删除）。

## MC-3 thinking 档位语义

改法（方案 B+C）：
- B（packages/ai/models.ts `clampThinkingLevel`）：请求档不在支持集 → 启用侧（非 off）**先向下**找最近启用档；低于最小档用最小启用档；请求 off 而 off 不支持 → 最小启用档（不静默跨 on/off 边界、不跳 max）；非法档维持旧兜底。
- C（agent-session.ts）：`_requestedThinkingLevel` 意图槽 + `setThinkingLevel` 写 settings 用**请求值**（不再写钳制值；写回移出 isChanging 门但保留 supportsThinking||level!=="off" 守卫）+ `_getThinkingLevelForModelSwitch` 从意图重钳（无意图时 settings 默认 → 现值）。
- 告警（越界必告警）：钳制发生时 `sessionLog.warn` + `sessionManager.appendCustomMessageEntry("thinking_level_clamped", …, display:true)`（转录可见、零 daemon wire 变更）。**告警只在 agent-session 的 set/switch 点，不进每请求热路径**（纯函数保持纯）。

红→绿：`packages/ai/test/clamp-thinking-level.test.ts` 6 用例（identity 等价行 / 向下夹红行 / off 边界不可变行 / kimi off→minimal 钉行 / 无 map 默认集等价 / 非法档兜底）→ 6/6 绿；`test/suite/regressions/r43-thinking-intent.test.ts`（medium 在 A 夹 low+告警+settings 存 medium → 切 B 恢复 medium、JSONL 末条=medium）→ 绿。
- **关键纠偏（与派单口径的差异，已按实码修）**：`getSupportedThinkingLevels` 对 off..high 缺键=默认支持（只有显式 null 才摘除；xhigh/max 需显式键），所以「deepseek minimal→low / medium→high」不是真实 map 的行为面——deepseek-v4.1-flash 真实 map 全档 identity。真实钳制面=显式 null 档、off:null 模型、xhigh/max 缺键。红行改用 null 形状构造（`{off,minimal:null,low,medium:null,high}`+medium→low；`{low,high,max}`+xhigh→high 不再跳 max）；kimi-k3 真实 map（off:null）off→minimal 与现状同值，作"不跳 max"钉行，红面在告警层。

## 验证矩阵（全部 vitest 直调 node，env -u 泄露变量）

| 批次 | 文件 | 结果 |
|---|---|---|
| MC-1 | model-resolver.test.ts | 32/32（改前 27+5红） |
| MC-2 | r43-auth-stale-recovery.test.ts | 6/6（改前 6红） |
| MC-2 等价 | 4491-provider-stale-after-401 | 9/9 |
| MC-3 | clamp-thinking-level / r43-thinking-intent | 6/6、1/1 |
| 回归 | interactive-mode-effort-command + sdk-skills | 17+3 |
| 回归 | agent-session-model-extension + 4649-subagent-model-selection + agent-session-runtime-replacement | 21+?+7 |
| 回归 | supports-xhigh.test.ts | 17/17 |
| 类型 | tsgo --noEmit（coding-agent 项目，含 ai 引用） | EXIT=0 / 0 errors |
| 类型 | pristine-tree（git archive HEAD + symlink node_modules）tsgo | EXIT=0 |
| 格式 | biome check --write 15 文件 | 通过（8 文件被修格式） |

变异正控（逐个单独跑、exit≠0、跑后复原；r42 C2 方法论）：
- M1 删 MC-1 鉴权面（useFullCatalog=true）→ model-resolver 5 failed，VITEST_EXIT=1 ✓
- M2 删 authStorage 层 TTL（活性过滤回退全量）→ TTL 用例 1 failed，EXIT=1 ✓
- M2b 删 registry 层 TTL → 初版**未被抓**（用例两层互染：runtime 恢复遮蔽 registry 判定）→ 重构用例为双 provider 隔离后 EXIT=1 ✓（此为本轮唯一返工，已修）
- M3 clamp 改回向上优先 → 2 failed，EXIT=1 ✓

## 交付物

- 提交：`5958253d5`（17 files，+826/-44），changelog fragments：`packages/coding-agent/.changes/r43-model-chain-auth-clamp.md`、`packages/ai/.changes/r43-clamp-thinking-level.md`。
- 基线证据：`/tmp/audit_r/round-43/probe-fuzzy-baseline.ts` 输出（冻结 SHA 上 13 条语料逐字留档，见会话记录）。
- 测试新增：model-resolver.test.ts（+2 describe/8 用例）、suite/regressions/r43-auth-stale-recovery.test.ts、suite/regressions/r43-thinking-intent.test.ts、packages/ai/test/clamp-thinking-level.test.ts；harness.ts additive 暴露 modelRegistry。

## 遗留与边界（显式声明）

1. MC-3 方案 A（zai/qwen 分支发布尔丢档位）未做——按方案书条件采纳，等老板侧 glm-5.3 真端点探针；glm「关不掉」在 B+C 下收敛为「最小启用档+显式告警」，真关需改用户侧 models.json 的 off:null 或 A 路径。
2. 启动诊断 `Model: <provider>/<id> (auth: <source>)` 一行（方案书配套可见性小项）超时未加。
3. `restoreModelFromSession`（r42 F4 死代码第三处）未改台账；SDK 内联解析、buildFallbackModel 借参数面（F2/F3）不在本轮。
4. clamp 告警走转录 custom_message（display:true）而非新 daemon 事件——曾试加 `thinking_level_clamped` 事件，撞 `AgentConnectionSessionEvent` 联合类型（daemon wire 纪律：需 schema revision+双向兼容测试），按纪律回退为零 wire 变更面；TUI 渲染 display custom message 沿用 compaction_outcome 通道，未逐点 UI 验证。
5. TTL 15min 为常量（方案书允许 settings 或常量，取常量）；跨 worker 生效延迟=各 worker 下次读凭据时（reloadIfAuthFileChanged 惰性触发），与 daemon 拓扑无关。
6. `npm run check` 未整跑（单命令 60s 纪律）；以 tsgo EXIT=0 + biome 15 文件 + 定向 vitest 批次替代，未尽面=repo 级 lint/其余包。
