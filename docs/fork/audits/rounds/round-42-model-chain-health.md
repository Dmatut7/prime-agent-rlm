# r42 泛扫 · 模型链子面 ⑤ provider 健康度→模型选择 + ② 凭据失效面

- 仓：`/Users/a1/Desktop/ai/prime-agent`（**只读**，未做任何写/commit/shutdown/doctor --fix）
- HEAD：`a609c6ac597bd1285c8254a27682c4f1cdd9ed65`（2026-09-16 16:09:41 +0800）
- 时间：2026-09-16T16:26:24；方法：读码 + 在项目自身环境（`npx tsx`，unset RLM_*/PRIME_AGENT_*/PI_*）跑探针与既有测试
- 去重：`/tmp/audit_r/round-42/decisions.jsonl` 不存在；对 `docs/fork/audits/decisions.jsonl`（341 条）按 budget/stale/retry/health/failover/429/模型 关键词比对，最接近的是 RC-1/RC-2/RC-3/RC-4/K5（重试与 429 分类）与 DO-5（attach 丢 auth_stale 事件）。本报告 4 条均**不是**其重复：RC-3 记的是「当时根本没有跨层预算」这一已修问题，本报告 F2 记的是修好之后**预算上限本身算错**；F1 记的是 stale 标记的**可恢复性**（跨进程 /login 与 env 源），decisions 无对应条目。

## 结论速览
| # | 命题 | severity | confidence |
|---|---|---|---|
| F1 | 凭据 stale 标记在运行中的会话进程内不可恢复：错误提示让用户 `/login`，但另一进程写入**同值**凭据不会清标记；env 源凭据无任何清标记路径 ⇒ provider 在该进程内永久不可用（`getApiKey` 返 undefined） | high | high |
| F2 | 跨层 request budget 的上限**不是**配置的逐层乘积，而是硬编码 12：agent loop 先以「无上限」建桶，session 后算出的乘积被丢弃（注释声称是乘积） | medium | high |
| F3 | 无任何错误率/超时率/健康度统计反馈到模型选择；无跨 provider 故障切换：重试一律重发同一 model（负结论，带正控） | medium | high |
| F4 | 会话恢复时凭据失效会让会话**静默换到另一个模型**，且不写 model-change 台账（运行模型与 transcript 不一致） | low | medium |

## F1 — 凭据 stale 标记不可恢复（跨进程 /login 同值无效；env 源无清除路径）

- **severity**: high
- **confidence**: high（在项目自身环境实跑复现，逐行输出在下方）
- **file:line**（主）：
  - `packages/coding-agent/src/core/auth-storage.ts:652`（markAuthStale 记录 stale 源）
  - `packages/coding-agent/src/core/auth-storage.ts:599`（stale 判定要求 valueFingerprint 全等）
  - `packages/coding-agent/src/core/auth-storage.ts:782`（`reload()` 不清 stale 标记）
  - `packages/coding-agent/src/core/auth-storage.ts:365,373,828,838,860`（仅 runtime / stored 两种源有清除路径）
  - `packages/coding-agent/src/core/auth-storage.ts:1184-1205`（stale 候选被跳过 ⇒ 直接 `return {}`，无 last-resort 回退）
  - `packages/coding-agent/src/core/auth-guidance.ts:35-37`（"No API key found for X"）
  - `packages/coding-agent/src/core/agent-session.ts:15161-15178`（失败时给错误文本追加 "Run /login" 指引）
- **逐字代码证据**：

`auth-storage.ts:652-655`
```ts
652: 	markAuthStale(provider: string): boolean {
653: 		const token = this.getCurrentAuthSourceToken(provider);
654: 		return token ? this.markAuthSourceStale(token) : false;
655: 	}
```
`auth-storage.ts:599-605`（stale 只按 source+identity+value 指纹匹配；值不变则永远命中）
```ts
599: 	private isAuthSourceStale(provider: string, candidate: AuthSourceCandidate): boolean {
600: 		const matchingStale = this.getMatchingStaleAuthSources(provider, candidate);
601: 		if (matchingStale.length === 0) {
602: 			return false;
603: 		}
604: 		const valueFingerprint = candidate.valueFingerprint ?? candidate.resolveValueFingerprint?.();
605: 		return Boolean(valueFingerprint && matchingStale.some((token) => token.valueFingerprint === valueFingerprint));
```
`auth-storage.ts:726-740` + `782-785`（reload 只重读磁盘，staleAuthSources 不受影响）
```ts
782: 	reload(): void {
783: 		clearResolvedCommandCache();
784: 		this.loadCredentialsFromDisk();
785: 	}
```
`auth-storage.ts:1184-1205`（唯一候选 stale 时不给 key）
```ts
1183: 		// Stored auth wins over environment variables for non-Prime-Inference providers.
1184: 		if (
1185: 			providerId !== PRIME_INFERENCE_PROVIDER_ID &&
1186: 			envKey &&
1187: 			envCandidate &&
1188: 			!this.isAuthSourceStale(providerId, envCandidate)
1189: 		) {
1190: 			return {
1191: 				apiKey: envKey,
1192: 				sourceToken: this.getAuthSourceTokenForCandidate(providerId, envCandidate),
1193: 			};
1194: 		}
1195: 		if (options?.includeFallback !== false) {
1196: 			const fallbackCandidate = this.getFallbackAuthCandidate(providerId);
1197: 			if (fallbackCandidate && !this.isAuthSourceStale(providerId, fallbackCandidate)) {
1198: 				return {
1199: 					apiKey: this.fallbackResolver?.(providerId) ?? undefined,
1200: 					sourceToken: this.getAuthSourceTokenForCandidate(providerId, fallbackCandidate),
1201: 				};
1202: 			}
1203: 		}
1204: 
1205: 		return {};
```
- **影响**：会话 worker 在 401/403 后把当时用的凭据源标 stale。此后：(1) `getApiKey` 返回 `undefined` ⇒ 该 provider 的**下一个请求直接失败**（sdk.ts:288 判 `!auth.ok`；另一些路径由 `_getRequiredRequestAuth` 抛 `No API key found for <provider>`，agent-session.ts:2204-2206）；(2) `hasAuth` 为 false ⇒ `getAvailable()/refreshAvailableModels()`/`--list-models`/`getExecutableModels()`/`_authenticatedRlmModels()`（agent-session.ts:14435-14440）都把该 provider 全部模型摘掉；`getAuthStatus` 变成 `{configured:false,source:"stale",label:"expired"}`。而错误文本告诉用户 "Run /login to update credentials."，但：(a) `/login` 发生在 TUI/客户端进程，只清**那个进程**的标记（`set()`→`clearStaleAuthSource(provider,"stored")`），worker 进程的标记要等凭据**值**变化（指纹不匹配）才会失效，因此用户重新粘贴**同一个 key**（401 是配额/团队/区域/临时 403 等非凭据原因时正是这种操作）对运行中的 worker 无效；(b) 由环境变量提供的凭据（source `environment`）根本没有任何清除路径（只有 runtime/stored 有），`process.env` 在进程内不能变 ⇒ 该 worker 生命周期内该 provider 永久不可用，唯一出路是重启 worker 或改用 `--api-key` 运行。
- **可复现步骤**（探针：`/tmp/audit_r/round-42/probe-stale.mts`、`probe-envstale.mts`；运行方式见文末）
  - stored 源：`AuthStorage.create(tmp/auth.json)`（key=sk-ant-live-key）→ `markAuthStale("anthropic")` → 另一进程写回**同值** → 仍 `hasAuth=false`/`getApiKey=undefined`；写回**轮换值** → 恢复正常；同进程 `set()` → 恢复正常。
  - env 源：`ANTHROPIC_API_KEY=sk-ant-from-env` → `markAuthStale` → `reload()` 无效；只有 `setRuntimeApiKey`（CLI `--api-key` 语义）能恢复。
- **实测输出（逐字）**：
```
boot: hasAuth=true status={"configured":true,"source":"stored"} getApiKey=sk-ant-live-key
after markAuthStale(403): hasAuth=false status={"configured":false,"source":"stale","label":"expired"} getApiKey=undefined
after external /login SAME value: hasAuth=false status={"configured":false,"source":"stale","label":"expired"} getApiKey=undefined
after external /login ROTATED value: hasAuth=true status={"configured":true,"source":"stored"} getApiKey=sk-ant-rotated
same-process set(): hasAuth=true status={"configured":true,"source":"stored"}
boot (env-sourced): hasAuth=true status={"configured":false,"source":"environment","label":"ANTHROPIC_API_KEY"} getApiKey=sk-ant-from-env
markAuthStale returned true
after markAuthStale: hasAuth=false status={"configured":false,"source":"stale","label":"expired"} getApiKey=undefined
after reload(): hasAuth=false status={"configured":false,"source":"stale","label":"expired"} getApiKey=undefined
after setRuntimeApiKey (same value): hasAuth=true status={"configured":false,"source":"runtime","label":"--api-key"} getApiKey=sk-ant-from-env
```
- **既有测试的覆盖边界（说明这不是被测试钉住的设计）**：`test/suite/regressions/4491-provider-stale-after-401.test.ts`（9 passed）只断言「401 后 hasAuth=false / status=expired / 错误文本含 Run /login」，**没有任何测试断言恢复路径**；`test/auth-storage-disk-invalidation.test.ts`（4 passed）覆盖跨进程轮换/吊销/同字节 touch，但**不含 stale 标记 × 跨进程重登**这一组合。
- **修复方向**（不改，仅建议）：`reload()`/`loadCredentialsFromDisk()` 时应把 stale 源与磁盘现状对账（同一 source+identity 且值未变时，若磁盘写入方刚做过显式 set，可清）；source `environment`/`fallback`/`prime-cli` 也需要一个显式清除入口；stale 只应在「同一凭据被同一 provider 连续拒绝」时生效并带 TTL。

## F2 — 跨层 request budget 的上限被硬编码 12 取代（配置的逐层乘积被丢弃）

- **severity**: medium
- **confidence**: high（真实 `createAgentSession` 路径实测 + 单元控制）
- **file:line**：
  - `packages/agent/src/agent-loop.ts:907-909`（agent loop 先建桶，**不传上限**）
  - `packages/ai/src/providers/request-budget.ts:120-127`（已存在的桶直接返回，忽略本次请求的上限）
  - `packages/ai/src/providers/request-budget.ts:26-31`（默认 12）
  - `packages/coding-agent/src/core/agent-session.ts:15011-15025`（session 认为自己算的是乘积）
- **逐字代码证据**：
```ts
904: 	// One request budget for every layer that can issue a provider request for this
905: 	// chain: the SDK's own retries (via the provider fetch wrapper) and the in-place
906: 	// resends below all count into the same pool, so the layers cannot multiply.
907: 	const requestBudget =
908: 		config.requestBudget ??
909: 		(config.sessionId ? getProviderRequestBudget(config.sessionId) : new ProviderRequestBudget());
```
```ts
120: export function getProviderRequestBudget(chainId: string, maxRequests?: number): ProviderRequestBudget {
121: 	const existing = budgetsByChain.get(chainId);
122: 	if (existing) {
123: 		return existing;
124: 	}
125: 	const budget = new ProviderRequestBudget(maxRequests ?? DEFAULT_MAX_TOTAL_PROVIDER_REQUESTS);
126: 	budgetsByChain.set(chainId, budget);
127: 	return budget;
```
```ts
26:  */
27: export const DEFAULT_MAX_TOTAL_PROVIDER_REQUESTS = 12;
28: 
29: /** Why the client did not retry after this attempt, when it did not. */
30: export type ProviderRetrySuppression =
31: 	/** The shared request budget had no requests left for another attempt. */
```
```ts
15011: 	/**
15012: 	 * Cross-layer request budget for the current request chain: the counter the SDK-level
15013: 	 * retries (through the provider fetch wrapper), the agent loop's in-place resends and
15014: 	 * this session's turn retries all spend from. The ceiling is the product of the
15015: 	 * configured per-layer budgets, which is exactly the envelope the layers used to reach
15016: 	 * by multiplying their independent counters - now shared, so no layer can exceed it.
15017: 	 */
15018: 	private _crossLayerRequestBudget(): ProviderRequestBudget {
15019: 		const retrySettings = this.settingsManager.getRetrySettings();
15020: 		const providerSettings = this.settingsManager.getProviderRetrySettings();
15021: 		const sessionAttempts = (retrySettings.enabled ? retrySettings.maxRetries : 0) + 1;
15022: 		// The SDKs default to 2 retries (3 attempts) when nothing is configured.
15023: 		const providerAttempts = (providerSettings.maxRetries ?? 2) + 1;
15024: 		return getProviderRequestBudget(this.sessionId, sessionAttempts * providerAttempts);
15025: 	}
```
- **语义**：注释与 `_crossLayerRequestBudget` 的 JSDoc 都声称「上限 = 配置的逐层预算之积」。但桶是按 `sessionId` 存在模块级 `Map` 里的单例，**先到者定上限**；而顺序是确定的：每个请求开头 agent loop 调 `getProviderRequestBudget(sessionId)`（无上限 ⇒ DEFAULT 12）先建桶，session 只在 `_handleRetryableError`（agent_end 之后）才调 `getProviderRequestBudget(sessionId, product)`，此时桶已存在 → 乘积被丢弃。`packages/coding-agent` 中**没有任何地方**把 `requestBudget` 塞进 agent loop 的 config（`grep -rn 'requestBudget' packages/coding-agent/src` 只有 session 侧 6 处 + 事件字段，无 config 传参），所以生产路径上「乘积」永远不生效。
- **影响**：用户把 `retry.maxRetries` 与 `retry.provider.maxRetries` 调高（例如都设 5，语义上限 36）后，链在 **12** 次请求处被切断：SDK 层收到 `x-should-retry:false`（retry-cap.ts:151-160 的 `budgetBlocked`），session 层收到 `requestBudget.exhausted` 并抛出 "…(not retried: the shared provider request budget is exhausted - 12 provider request(s) in this chain (ceiling 12))"（agent-session.ts:15294-15312）。即「配置了更多重试但实际更少」，且报错文本给出的 ceiling 与用户配置无关。默认配置下乘积恰好=12（(3+1)×(2+1)）所以默认无感，**只有非默认配置暴露**。
- **可复现步骤**：
  1. 单元控制（`/tmp/audit_r/round-42/probe-budget.mts`）：`getProviderRequestBudget("control-chain",3).maxRequests===3`，随后 `getProviderRequestBudget("control-chain",9).maxRequests===3`（先到者赢）。
  2. 产品路径（`/tmp/audit_r/round-42/probe-budget3.mts`）：`createAgentSession({settings: retry.maxRetries=5, retry.provider.maxRetries=5})` + faux provider 连续 500，在回合进行中轮询 `peekProviderRequestBudget(session.sessionId)`。
- **实测输出（逐字）**：
```
control: fresh chain with requested ceiling 3 -> maxRequests=3
control: same chain re-requested with ceiling 9 -> maxRequests=3 (existing bucket wins)
fresh-chain-with-no-ceiling default = 12
sessionId=01a0a94f-f83f-72e8-8bec-6c6504c5e297
retry.maxRetries=5 retry.provider.maxRetries=5 -> configured product ceiling = 36
observed live budgets during the chain (configured product ceiling = 36):
  maxRequests=12 used=0 exhausted=false
after the turn: peek=forgotten
```
（`used=0` 是因为 faux provider 不走 SDK fetch wrapper；上限字段本身已证明被 12 覆盖。回合结束后 `_resolveRetry()` → `forgetProviderRequestBudget` 正常回收，无桶泄漏——`live chains at end: 1` 是控制桶。）
- **附注（同源小问题，未单列）**：桶的上限在建桶时固定，`_crossLayerRequestBudget()` 每次重算乘积也没有意义；会话中途改 retry 设置不会改上限。

## F3 — 健康度指标不反馈模型选择；重试一律重发同一 model（负结论 + 正控）

- **severity**: medium（能力缺口／产品决策，非崩溃）
- **confidence**: high
- **命题 A**：仓内**不存在**任何「按 provider/model 的错误率、超时率、连续失败数、健康分」改变模型选择/默认模型的代码路径。
- **命题 B**：`_handleRetryableError` **不换模型、不换 provider、不降级**：它删除失败的 assistant 消息后调用 `this.agent.continue()`，同一 model 重发同一份上下文。

### 负结论的检索手段与正控（证明手段确实能检出存在的情况）
检索命令（`packages/agent/src` + `packages/ai/src` + `packages/coding-agent/src`，`--include='*.ts'`）逐词：
```
grep -rn --include='*.ts' -E "<term>" packages/agent/src packages/ai/src packages/coding-agent/src
```
命中数：`failureRate`=0、`errorRate`=0、`healthScore`=0、`providerHealth`=0、`modelHealth`=0、`unhealthy`=0、`successRate`=0、`penal`=0、`downtime`=0、`consecutive_failures`=0、`failureCount`=0、`blacklist`=1（compaction 的 child-only 注释）、`circuit`=13、`breaker`=26、`cooldown`=47、`degraded`=123 — 后三者的全部命中都在 **retention sweep / compaction / autoRefine / stall / daemon event-gap** 域，**没有一条在 model-registry / model-resolver / agent-session 的模型选择路径上**。
正控（同一手段命中了确实存在的「连续失败→降级」逻辑，证明该手段不会漏检这一类构造）：
- `packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.ts:2877-2892`（`tripEventGapRecoveryBreaker`：连续 3 次或 10 分钟内 3 次 gap 重拉 → breaker OPEN，连接降级为 log-only）
- `packages/coding-agent/src/modes/daemon/daemon-supervisor.ts:3159,4233` + 981（worker descriptor 的 `consecutiveFailures` 计数与重置）
- 重试计数类符号确实存在并可被同一手段命中：`agent-session.ts:1720 _retryAttempt`、`agent-session.ts:15018 _crossLayerRequestBudget`、`agent-session.ts:5179 auto_retry_start`、`packages/ai/src/providers/request-budget.ts`（`requestBudget`）
即：**在这个仓里写「provider 健康度」这类逻辑的话，上述 grep 会命中；它没有命中 ⇒ 该逻辑不存在。**

### 命题 B 的逐字证据
`packages/coding-agent/src/core/agent-session.ts:15274-15389`（`_handleRetryableError` 全函数）关键尾部：
```ts
15358: 		const messages = this.agent.state.messages;
15359: 		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
15360: 			this.agent.state.messages = messages.slice(0, -1);
15361: 		}
15362: 
15363: 		this._retryAbortController = new AbortController();
15364: 		try {
15365: 			await sleep(delayMs, this._retryAbortController.signal);
15366: 		} catch {
15367: 			const attempt = this._retryAttempt;
15368: 			this._markProviderAuthStaleForRetryFailure(message, options);
15369: 			this._retryAttempt = 0;
15370: 			this._terminalFailureAttemptCount = attempt;
15371: 			this._retryAbortController = undefined;
15372: 			this._emit({
15373: 				type: "auto_retry_end",
15374: 				success: false,
15375: 				attempt,
15376: 				finalError: "Retry cancelled",
15377: 			});
15378: 			this._resolveRetry();
15379: 			this._retryAuthFailureSources = [];
15380: 			return false;
15381: 		}
15382: 		this._retryAbortController = undefined;
15383: 
15384: 		setTimeout(() => {
15385: 			this.agent.continue().catch(() => {});
15386: 		}, 0);
15387: 
15388: 		return true;
15389: 	}
```
全函数内**没有任何** `setModel` / `state.model` / provider 切换 / 备用 provider 选择；它只做：预算与次数判定 → 指数退避 → 退掉失败的 assistant 消息 → `agent.continue()`（同一 model 重发）。
`_isRetryableError`（agent-session.ts:14974-15008）也不按 status 分类分支：只排除 context overflow、空回合重试耗尽、server-directed stall、faux 队列耗尽、agent 生命周期失败、结构化永久失败（kind∈{auth,invalid_request,refusal}）。**429 / 5xx / 超时都落在「可重试」一类，一律同 model 重发**；429 的 `Retry-After` 超上限时才由 `retry-cap.ts` 拒绝重试（`retry_delay_cap`）。
`setModel` 调用点全枚举（用 `grep -rn 'setModel' packages/*/src --include='*.ts'`，正控：该 grep 确实枚举出了全部 4 个用户/扩展侧入口）：
- `packages/coding-agent/src/core/agent-session.ts:9762`（`AgentSession.setModel`，唯一真正改模型的实现）
- `packages/coding-agent/src/modes/agent-connection/in-process-agent-connection.ts:470`（`/model` 命令）
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:8016`（用户在 picker 里选模型）
- `packages/coding-agent/src/modes/daemon/daemon-mode.ts:5115`（daemon 侧 `/model` 命令）
- `packages/coding-agent/src/core/agent-session.ts:12173`（扩展 API `setModel`，内部再调 9762）
- 另有 `packages/coding-agent/src/core/agent-session.ts:9840/9879`（`Ctrl+P` 手动循环模型）、`12103`（热重载时用 registry 里同 provider/id 的新对象替换，不改身份）
⇒ **没有任何一处是失败/健康度驱动的自动切换**。

- **跨层 request budget 语义**（问题清单第 2 条）：桶按 `sessionId` 单例共享给三层（SDK fetch wrapper 的每次尝试记一次、agent loop 的空回合原地重发、session 的回合级重试）；`reset()` 只在一次成功响应后调用，`forgetProviderRequestBudget` 只在链结束（`_resolveRetry`，agent-session.ts:5266-5269，每次 agent_end 都走）调用 ⇒ 无桶泄漏（实测回合后 `peek` 返回 forgotten）。上限的取值问题见 F2。
- **可复现步骤**：上面的 grep 逐词跑一遍；`sed -n '15274,15389p' packages/coding-agent/src/core/agent-session.ts`；`grep -rn 'setModel' packages/*/src --include='*.ts'`。

## F4 — 恢复会话时凭据失效 ⇒ 静默换模型且不写 model-change 台账

- **severity**: low（会话恢复路径，非运行中自动切换）
- **confidence**: medium（代码路径确定；实际影响取决于用户是否看得到 fallback 提示）
- **file:line**：
  - `packages/coding-agent/src/main.ts:952-960`、`packages/coding-agent/src/core/sdk.ts:184-192`（CLI 与 SDK 两条恢复路径：`hasConfiguredAuth` 不通过就丢弃会话记录的模型）
  - `packages/coding-agent/src/core/model-resolver.ts:581-638`（`restoreModelFromSession`：同逻辑，**全仓无生产调用者**，仅测试 4645-internal-glm 引用）
  - `packages/coding-agent/src/core/model-resolver.ts:549-575`（随后按**全局 settings 的 defaultProvider/defaultModelId** 解析，找不到就 `findPreferredDefaultModel() ?? availableModels[0]`）
- **逐字代码证据**：
```ts
952: 	if (!model && hasExistingSession && existingSession.model) {
953: 		const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
954: 		if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
955: 			model = restoredModel;
956: 		}
957: 		if (!model) {
958: 			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
959: 		}
960: 	}
```
```ts
184: 	if (!model && hasExistingSession && existingSession.model) {
185: 		const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
186: 		if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
187: 			model = restoredModel;
188: 		}
189: 		if (!model) {
190: 			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
191: 		}
192: 	}
```
- **影响**：worker/进程重启或 `--resume` 时，若会话记录的 provider 此刻 auth 为 stale（F1 的场景），会话会落到**全局默认模型**（或可用列表里的第一个），而**不会**向 session JSONL 追加 `model_change`（只有新会话在 sdk.ts:343 append 初始模型）。于是 transcript 的最后一条 model-change 与真正在跑的模型不一致；`modelFallbackMessage` 只在部分入口展示（`isNoModelsAvailableMessage` 那条还会被要求按活会话复检，见 auth-guidance.ts:20-28）。
- **可复现步骤**：读 `main.ts:940-980` / `sdk.ts:175-210`；对照 `agent-session.ts:9774`（setModel 会 appendModelChange）确认恢复路径没有对应 append。
- **注**：运行中的会话**不会**被自动换模型（见 F3 的 setModel 枚举）。

## 已跑测试与探针（exit code）

| 命令（cwd=`packages/coding-agent`，env 已 unset RLM_*/PRIME_AGENT_*/PI_*） | 结果 |
|---|---|
| `npx tsx ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/4491-provider-stale-after-401.test.ts` | **exit 0**，9 passed |
| `npx tsx ../../node_modules/vitest/dist/cli.js --run test/auth-storage.test.ts test/auth-storage-disk-invalidation.test.ts test/model-registry.test.ts test/agent-session-runtime-model-fallback.test.ts` | **exit 0**，4 files / 139 passed |
| `npx tsx /tmp/audit_r/round-42/probe-stale.mts`（AuthStorage stale 可恢复性） | exit 0，输出见 F1 |
| `npx tsx /tmp/audit_r/round-42/probe-envstale.mts`（env 源 stale） | exit 0，输出见 F1 |
| `npx tsx /tmp/audit_r/round-42/probe-budget.mts`（预算先到者赢） | exit 0，输出见 F2 |
| `npx tsx /tmp/audit_r/round-42/probe-budget3.mts`（真实 createAgentSession 链上的上限） | exit 0，输出见 F2 |

即：**既有测试全绿**，F1/F2 是既有测试未覆盖的面（不是「测试变红」）。

## 复现命令汇总
```bash
cd /Users/a1/Desktop/ai/prime-agent/packages/coding-agent
env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_HARNESS_STATE_DIR -u RLM_GLOBAL_HARNESS_STATE_DIR \
    -u RLM_MAX_DEPTH -u PRIME_AGENT_CODING_AGENT_DIR -u PI_CODING_AGENT \
    -u PRIME_AGENT_INTERNAL_DAEMON_WORKER -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN \
    npx tsx /tmp/audit_r/round-42/probe-stale.mts
env -u RLM_DEPTH ... npx tsx /tmp/audit_r/round-42/probe-budget3.mts
```

## 未覆盖 / 边界（诚实说明）
- 未在**真机 daemon+TUI 双进程**下做端到端复现（需登录真 provider 并制造 403，且本任务禁止写仓/重启 daemon）。F1 的跨进程结论由「TUI 进程 login 走自己的 `authStorage.set()`、daemon 会话 worker 是另一进程另一 AuthStorage 实例」的代码事实 + 存储层实测合成；`grep -rni 'login' packages/coding-agent/src/modes/daemon/` 在 daemon 协议与 daemon 模式里**没有任何登录命令**（唯一命中是 `logInfo` 的大小写假命中），即登录确实不在会话 worker 进程执行——登录侧代码 `auth-flows.ts` / `interactive-mode.ts` 用的是**客户端自己的** `modelRegistry.authStorage`。这条 grep 是正控：若存在 worker 侧登录命令，它会命中。
- F2 的影响量化（多少次额外重试被吃掉）未在真 provider 上做付费实测，只验证了上限字段。
- 没有对 `models.json` 自定义 provider 的健康度面做展开（本子面清单未要求）。
