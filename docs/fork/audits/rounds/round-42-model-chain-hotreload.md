# r42 泛扫 · 子面③ 模型目录缓存新鲜度（models.json 热加载语义）

- 仓库 /Users/a1/Desktop/ai/prime-agent，HEAD `a609c6ac597bd1285c8254a27682c4f1cdd9ed65`，全程只读（未写仓、未 commit、未 shutdown/doctor --fix）。
- 探针脚本（仓外）：`/tmp/audit_r/round-42/hotreload_probe.ts`（exit 0）、`identity_probe.ts`（exit 0）、`executable_probe.ts`（exit 0）；均用 `npx tsx` 现场加载 `packages/coding-agent/src/core/model-registry.ts` 源码，跑在临时 `PI_*`（tmpdir）目录。
- 已有测试正控：`env -u RLM_* -u PRIME_AGENT_* -u PI_* node ../../node_modules/vitest/dist/cli.js --run test/model-registry-schema-drift.test.ts` → **exit 0，5 passed**。
- 去重：`docs/fork/audits/decisions.jsonl`（341 条）中与 models.json 相关的仅 **CD-1**（同进程两副面孔，已 fixed @408d3200e）与 **DAT-4**（tmp+rename 无 fsync）；**CD-5**（settings.json 直接编辑对运行中会话不生效，已 fixed @e16398d3b）是本次结论的“同族已修/未修”对照，不重复。round-42 目录下无 decisions.jsonl。

---

## 0. 一句话结论

`models.json` **没有任何文件监视、没有 mtime/size 指纹检查、没有周期性重载**。唯一的重读时机是显式 `ModelRegistry.refresh()`（及包装它的 `refreshAvailableModels()` / `refreshModelCatalog()`）。因此「改 models.json 后多久生效」的答案是：**不是时间，而是“下一次调用 refresh 系方法”**——在运行中的会话里，可触发它的用户动作只有打开模型选择器（且受 60 s 客户端缓存约束）、切换模型、设置模型；`/reload` 与 daemon `reload` **不**重读 models.json。而且即便目录被重读，**正在使用的那个模型对象是快照**，编辑既有模型的 `contextWindow/maxTokens/baseUrl/apiKey` 对当前会话不生效。

---

## 1. 调用点与频率（grep 全量）

### 1.1 只读快照、永不重读盘的入口
| 方法 | 位置 | 是否重读 models.json |
|---|---|---|
| 构造函数 `new ModelRegistry` → `loadModels()` | model-registry.ts:630-635, 699-729 | 是（进程/会话首次，仅一次） |
| `getAll()` | model-registry.ts:941-943 | **否**，返回 `this.models` |
| `getAvailable()` | model-registry.ts:949-960 | **否** |
| `getExecutableModels()` | model-registry.ts:1157-1159 | **否**（只做 private-prime 授权刷新） |

`getAll/getAvailable/getExecutableModels` 的全部 src 调用点：
- `src/core/model-resolver.ts:356`（`resolveCliModel`）
- `src/core/agent-session.ts:14436`（`_authenticatedRlmModels` ← `findRlmModels`）
- `src/modes/interactive/auth-flows.ts:253`
- `src/modes/interactive/components/model-selector.ts:293`（仅在 `availableModels === undefined` 时才先 refresh，见 model-selector.ts:281-287）
- `src/core/model-registry.ts:967`（refreshAvailableModels 内部）

### 1.2 会重读盘的入口（`refresh()` / `refreshAvailableModels()`）
- `refresh()` 定义：**model-registry.ts:652-681**
- `refreshAvailableModels()`：model-registry.ts:962-968
- `refreshModelCatalog()`：model-registry.ts:1131-1143
- `canUseModel()`：model-registry.ts:1153（会 refresh）
- `resolveModelScope` → model-resolver.ts:317（**调用方只有启动期**：main.ts:905）
- `findInitialModel` → model-resolver.ts:511（启动期；内部还有 memo `cachedAvailableModels ??=`）
- `restoreModelFromSession` → model-resolver.ts:588（启动/resume）
- `AgentSession.cycleModel`（scoped / available 两分支）→ agent-session.ts:9824, 9866（**每次切模型**）
- `interactive-mode.ts:1856`（onboarding 开始时）
- `model-selector.ts:282`（打开选择器且未传 `availableModels` 时）
- `auth-flows.ts:211, 324, 345`（登录/登出后）
- `onboarding.ts:40`
- `cli/list-models.ts:25`（`prime-agent model list`，每次进程启动）
- daemon：`get_available_models` → daemon-mode.ts:4991；`get_model_catalog` → daemon-mode.ts:5000；`set_model` → daemon-mode.ts:5108
- in-process connection：in-process-agent-connection.ts:176, 180, 471

**没有**任何 `setInterval`/定时任务在刷模型目录（model-registry.ts 内 `setInterval`/`watch` 命中 0 处；daemon-mode.ts 的 `setInterval` 只有 rosterHeartbeatTimer:650/763）。

---

## 发现 F1 — models.json 无监视/无指纹：改文件对同进程不可见，直到显式 refresh

- **命题**：`models.json` 是唯一“加载一次即快照”的配置文件；同进程内改写文件后，不调用 refresh 系方法就永远看不到新内容。
- **severity**：medium
- **file:line**：`packages/coding-agent/src/core/model-registry.ts:26`、`:652-681`、`:699-729`
- **逐字代码证据**：
  - 该文件全部 fs 导入：`import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "fs";`（第 26 行）——**没有 `watch` / `watchFile` / `statSync`**。
  - `refresh()` 的注释即语义来源：`/**\n * Reload models from disk (built-in + custom from models.json).\n */`
  - `loadModels()` 唯一读盘点：`const { models: customModels, overrides, modelOverrides, error, warnings } = this.modelsJsonPath ? this.loadCustomModels(this.modelsJsonPath) : emptyCustomModelsResult();`
- **正控（证明“无监视”不是检索假象）**：同一仓内确实存在外部变更检测 idiom，且我的枚举法能检出它们：
  - `settings-manager.ts:1342` `const watcher = watchFile(path, { interval: intervalMs }, listener);`（settings.json 轮询）
  - `auth-storage.ts:231-238` `statFingerprint(){ const stat = statSync(this.authPath); return `${stat.mtimeMs}:${stat.size}`; }`
  - 全仓 `watchFile(|watchWithErrorHandler(|fs.watch(` 枚举命中：settings-manager.ts(1342,1361,1376)、footer-data-provider.ts(220,252,269,283,293)、theme.ts(1007)、utils/fs-watch.ts(17)——**models.json 一处不落**。
- **实测（`/tmp/audit_r/round-42/hotreload_probe.ts`，exit 0）**：
  ```
  STEP1 after create, file has [alpha]        -> alpha | getError: undefined
  STEP2 after rewrite to [alpha,beta], no refresh -> alpha        <-- 改了盘，看不见
  STEP3 after registry.refresh()               -> alpha,beta
  STEP7 fresh registry (positive control)     -> gamma   <-- 文件确实在盘上、确实可读
  ```
- **影响**：手工改 models.json（加模型、改 baseUrl/apiKey/contextWindow）对已启动的会话默认无效；用户看到的是“改了没用”。
- **可复现步骤**：见上探针 STEP1→STEP3。
- **confidence**：high

---

## 发现 F2 — `/reload`（slash + daemon 命令）不重读 models.json

- **命题**：唯一的“重载配置”手势 `reload` 重建扩展/资源/settings/auth/api providers，却**独独不 refresh 模型注册表**；用户在改完 models.json 后 `/reload` 得不到新目录。
- **severity**：medium
- **file:line**：`packages/coding-agent/src/core/agent-session.ts:12639-12670`；`packages/coding-agent/src/modes/daemon/daemon-mode.ts:5221-5227`；`packages/coding-agent/src/core/slash-commands.ts:196-199`
- **逐字代码证据**（`AgentSession.reload()` 全文关键行）：
  ```
  async reload(): Promise<void> {
      ...
      await this.settingsManager.reload();
      // Re-read auth.json: a login saved by the client process (daemon mode) must be
      // visible here so MCP skill gating sees the new credentials.
      this._modelRegistry.authStorage.reload();
      resetApiProviders();
      this._mcpManager?.refresh();
      await this._resourceLoader.reload();
      this._buildRuntime({ ... });
  ```
  —— 只有 `authStorage.reload()`，**没有 `this._modelRegistry.refresh()`**。
  daemon 侧：`case "reload": { ... await withClientEnv(state.clientEnv, () => state.runtime.session.reload()); return success(command.id, "reload"); }`
  `/reload` 的帮助文本也只承诺：`"Reload keybindings, extensions, skills, prompts, and themes (settings.json edits are picked up live; values read at startup still need this)"`——**不含 models.json**。
- **影响**：与已修 CD-5（settings.json 手动编辑对运行中会话不生效）同族的缺口，只是换了个文件：settings 现在有 watchFile（settings-manager.ts:1309-1322 注释明写 "the manager loaded the file once and kept that snapshot forever"），models.json 连 `/reload` 都不覆盖。
- **可复现步骤**：运行中改 models.json 加一个自定义模型 → `/reload` → 打开 `/model` 前先执行一次 `prime-agent model list`（走 list-models.ts:25 refresh）能看到新模型，而仅 `/reload` 后旧模型列表不变（因为 reload 路径无 refresh）。
- **confidence**：high（代码直证；探针已证 refresh 是唯一重读路径）

---

## 发现 F3 — 交互式 TUI 的模型目录有 60 s 客户端缓存（`/model` 未带搜索词时可能展示过期列表）

- **命题**：打开 `/model` 菜单（无搜索词）走 `refreshModels(false)`，受 `MODEL_CATALOG_REFRESH_TTL_MS` 约束：距上次抓取不足 60 s 就**直接复用缓存目录**，不会向 daemon/registry 要新数据。
- **severity**：low
- **file:line**：`packages/coding-agent/src/modes/interactive/interactive-mode.ts:304`、`:8135-8149`、`:8500`、`:8410-8420`
- **逐字代码证据**：
  - `const MODEL_CATALOG_REFRESH_TTL_MS = 60_000;`（304）
  - `if (options.force || this.connectionModelsFetchedAt === 0) { return refreshCatalog(); } if (Date.now() - this.connectionModelsFetchedAt > MODEL_CATALOG_REFRESH_TTL_MS) { return refreshCatalog(); } return undefined;`（8142-8148，返回 undefined = 不刷新，菜单直接用 `getCachedModelCandidates()`，见 8374）
  - `refreshModels(initialModelSearch !== undefined);`（8500）——只有带搜索词的 `/model xxx` 才是 `force: true`
  - 对比：`/scoped-models` 命令的 `showModelsSelector()`（interactive-mode.ts:4836-4838 → 8504-8507）走 `getConnectionModelCatalog()` → `getConnectionAvailableModels()`，该路径**不查 TTL**，每次都向连接要一次目录（`getConnectionAvailableModels` 8100 行始终新建 promise）。
- **影响**："我改了 models.json，`/model` 里 60 秒看不到" 的真实来源在这里（即使 daemon 侧一读就是新的）。也解释了“多按一次 /model 就出来了”。
- **可复现步骤**：启动 TUI（会先 refresh 一次并置 `connectionModelsFetchedAt`）→ 立即改 models.json 加模型 → 60 s 内打开 `/model`（不带搜索词）看不到；等 >60 s 或改用 `/model <名字>` 即可见。
- **confidence**：high（读码；缓存命中不变量在 interactive-mode-status.test.ts 有对应断言面）

---

## 发现 F4 — 目录刷新也救不了“正在用的那个模型对象”：refresh 重建对象，会话持的是旧快照

- **命题**：`refresh()` 会用**新建的 Model 对象**替换 `this.models`；`AgentSession` 的当前模型是选中时赋给 `agent.state.model` 的对象引用。所以即使目录已经刷新（`/model` 打开、切模型前的 refresh 等），**编辑既有模型的 `contextWindow`/`maxTokens`/`baseUrl`/`apiKey`（provider 覆盖）对本会话的当前模型不生效**，必须重新选中该模型或重启会话。
- **severity**：medium
- **file:line**：`packages/coding-agent/src/core/model-registry.ts:718-728`（`this.models = combined;`，每次 load 重新构造）；`packages/coding-agent/src/core/agent-session.ts:5734-5736`（`get model() { return this.agent.state.model; }`）；消费点 `agent-session.ts:3655`、`:11582`、`:14977`（`this.model?.contextWindow`）、`compaction/compaction.ts:859`（`contextWindow: model.contextWindow`）
- **逐字代码证据**：
  ```
  get model(): Model<any> | undefined {
      return this.agent.state.model;
  }
  ```
  ```
  this.models = combined;     // loadModels 尾部：整表换新对象
  ```
- **实测（`/tmp/audit_r/round-42/identity_probe.ts`，exit 0）**：
  ```
  m0 contextWindow/baseUrl: 100000 https://a.invalid/v1
  no refresh: getAll stays 100000
  after refresh: new contextWindow/baseUrl: 999999 https://b.invalid/v1
  object identity preserved across refresh (m0===m1): false
  a holder of m0 still sees: 100000 https://a.invalid/v1
  ```
  —— “a holder of m0” 就是会话的 `agent.state.model`。
- **影响**：这正是实际工作流最痛的一环——撞到 context overflow 400 后去改 models.json 的 `contextWindow`（本仓 `src/core/model-input-limits.ts:36,44` 的注释记录了两批真实 400 与 models.json 声明值的对照），改了目录也**不会**改掉运行中会话用于 compaction 阈值与请求的那个数字。
- **可复现步骤**：同上探针；会话侧为 `get model()` 快照语义 + `contextWindow` 消费点 grep。
- **confidence**：high

---

## 发现 F5 — 同进程内两条读目录路径新鲜度不同：`rlm_find_models` 永远可能比 `/model` 旧

- **命题**：`rlm.find_models(...)`（Python 侧入口，host handler 在 `agent-session.ts:12488`）→ `_authenticatedRlmModels()` → `getExecutableModels()`，该方法**不 refresh**（只刷新 private-prime 授权），因此它读到的是本进程最后一次 load/refresh 的快照；而 `/model`/`set_model`/`cycle_model` 走的 `refreshAvailableModels()` 每次都重读盘。同一进程里两个面向用户的模型列表可以不一致。
- **severity**：low
- **file:line**：`packages/coding-agent/src/core/agent-session.ts:14435-14440`；`packages/coding-agent/src/core/model-registry.ts:1157-1159`
- **逐字代码证据**：
  ```
  private async _authenticatedRlmModels(): Promise<Model<Api>[]> {
      return (await this._modelRegistry.getExecutableModels()).filter((model) => {
  ```
  ```
  async getExecutableModels(): Promise<Model<Api>[]> {
      await this.refreshPrivatePrimeInferenceAuthorization();
      const availableModels = this.getAvailable();
  ```
- **实测（`/tmp/audit_r/round-42/executable_probe.ts`，exit 0）**：
  ```
  1 getExecutableModels at start        : alpha
  2 after file edit, getExecutableModels: alpha (stale)   <-- 改盘后仍旧
  3 after file edit, getAll()           : alpha (stale)
  4 refreshAvailableModels()            : alpha,beta
  5 getExecutableModels after refresh   : alpha,beta
  ```
- **可复现步骤**：同上探针；若在长命会话中先让 agent 调 `rlm.find_models(...)` 再 `/model`，可观察到前者缺新模型。
- **confidence**：high

---

## 发现 F6 — 加载失败/文件消失时无“上一份好目录”保留：整份自定义 provider 静默作废，且错误只在一次 load 之后才可见

- **命题**：`refresh()` 先 `this.loadError = undefined`，再 `loadModels()`；`loadCustomModels` 的失败路径一律返回 `emptyCustomModelsResult(...)`，于是**自定义 provider/模型整体消失、只回退到 built-in**，没有 last-good 保留。反方向同样：文件在两次 load 之间被写坏时，在下次 refresh 之前 `getError()` 仍是 `undefined`（旧目录继续照用）；文件被删除时连错误都没有，直接静默回退 built-in。错误只被 UI/diagnostics 读一次（`interactive-mode.ts:1610, 9268`、`list-models.ts:22`、`agent-session-services.ts:247-249`），运行中不主动上报。
- **severity**：medium（对用户是“模型凭空消失且无提示”）
- **file:line**：`packages/coding-agent/src/core/model-registry.ts:652-681`（refresh 重置 loadError）、`:699-713`（`if (error) { this.loadError = error; }`）、`:776-830`（三条 error → `emptyCustomModelsResult`）、`:941-943`（getAll 注释 `If models.json had errors, returns only built-in models.`）
- **逐字代码证据**：
  ```
  } catch (error) {
      if (error instanceof SyntaxError) {
          return emptyCustomModelsResult(`Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`);
  ```
  ```
  if (error) {
      this.loadError = error;
  }
  ```
- **实测（hotreload_probe.ts / identity_probe.ts，均 exit 0）**：
  ```
  STEP4 after breaking file, no refresh       -> alpha,beta | getError: undefined
  STEP5 after refresh() on broken file        -> (none) | getError starts: "Failed to parse models.json: Expected property"
  after deleting models.json + refresh: probe models present: 0 | getError: undefined
  ```
- **影响**：`models.json` 写坏一次（保存到一半、语法错）后，下一次任何 refresh（例如打开 `/model`）会让所有自定义 provider 从可用列表消失；若文件被删除/改名，连错误都不产生。用户侧表现为“模型不见了”，UI 还需自己再去 `getError()`/diagnostics 才能看到原因。
- **去重说明**：这**不是** CD-1（CD-1 是“同一个未变文件在首次 load 与 refresh 之间结论不一致”，已 fixed @408d3200e，本次 schema-drift 正控 5 passed 覆盖）；本条说的是**文件内容变化后**的语义：无 last-good 保留、无变更后的主动告警。
- **可复现步骤**：见探针 STEP4→STEP5 与删除文件那一步。
- **confidence**：high

---

## 2. daemon 模式：registry 归属（回答“workers 各自持有 registry 吗”）

- **每个进程、每个 session 一份 resp. ModelRegistry，没有跨 session 的目录单例**：
  - `packages/coding-agent/src/core/agent-session-services.ts:191`：`const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, join(agentDir, "models.json"));`
  - `packages/coding-agent/src/main.ts:856-896`（`prepareRuntimeServices`）：每次都新建 `AuthStorage.create(...)` + `createAgentSessionServices({...})`，即新 registry；daemon 的 session 重建/重水化（daemon-mode.ts:3215 `createAgentSessionRuntime(this.options.createRuntime, {...})`，`createRuntime` 即 main.ts 的工厂）走同一条路径。
  - `packages/coding-agent/src/core/sdk.ts:153`：`const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);`
- **daemon 命令侧**：`get_available_models` / `get_model_catalog` / `set_model` / `cycle_model` 全部经 `state.runtime.session.modelRegistry.refresh*()`，即**每条命令都重读盘**（daemon-mode.ts:4991、5000、5108、5125）。所以在 daemon 里“目录”本身是新鲜的，真正会滞后的只有：正在使用的 `agent.state.model` 快照（F4）、TUI 的 60 s 缓存（F3）、以及 `getExecutableModels` 面（F5）。
- daemon 模式下改 models.json **不需要重启 daemon 或重开会话**才能让目录生效，但**需要**一次带 refresh 的动作（`/model`、`model list`、set/cycle model）。

---

## 3. 负结论与正控清单

| 负结论 | 检索/实验手段 | 正控（证明手段能检出“存在”的情况） |
|---|---|---|
| models.json 无 fs.watch/watchFile | model-registry.ts:26 的 fs 导入逐字 + 全仓 `watchFile(|watchWithErrorHandler(|fs.watch(` 枚举 | 同枚举命中 settings.json（settings-manager.ts:1342,1361）、git reftable/tables（footer-data-provider.ts:252,269,283,293）、theme（theme.ts:1007） |
| models.json 无 mtime/size 指纹 | model-registry.ts 无 `statSync`；`mtime` 全仓命中集中在 session-info-disk-cache / rlm-ledger / agent-traces 等，无一条在 model-registry | 同仓 auth.json 有指纹：auth-storage.ts:231-238；settings 有 stamp：settings-manager.ts:1284-1285 |
| 无 refresh 就看不到文件变更 | hotreload_probe.ts STEP2（改盘后仍旧）| 同一探针 STEP3（refresh 后可见）+ STEP7（新建 registry 可见）——证明变更确实在盘上且可被该进程读到 |
| models.json 加载失败不保留旧目录 | hotreload_probe.ts STEP4/5、identity_probe.ts 删除文件一步 | schema-drift 测试正控：`--run test/model-registry-schema-drift.test.ts` exit 0，5 passed（证明这套语义被测试覆盖、不是偶发） |
| 无定时刷新 | model-registry.ts 内 `setInterval` 命中 0；daemon-mode.ts 的 setInterval 仅 rosterHeartbeatTimer | 同类定时器在 daemon 里确实存在且被命中（daemon-mode.ts:650,763） |

---

## 4. 建议（仅记录，未施工）

1. 给 models.json 加 settings 同款 `watchFile` 轮询（settings-manager.ts:1309-1345 是现成范式），或至少在 `AgentSession.reload()` 里补 `this._modelRegistry.refresh()`，并在 slash 描述里把 models.json 写清楚。
2. refresh 后把 `agent.state.model` 按 provider/id 重新绑定到新对象（或在 payload 前用 registry 重查 `find(provider,id)`），消除 F4 快照漂移。
3. 让 `getExecutableModels()` 也走一次 `refresh()`（或让 `rlm.find_models` 先 refresh），统一两条面的新鲜度。
4. 目录刷新后若 `getError()` 从 undefined 变为有值，向当前会话抛一条诊断（现在只有启动期/进 models 菜单时才读）。
5. TUI 的 `MODEL_CATALOG_REFRESH_TTL_MS`（60 s）至少在对 `/model` 的显式用户动作上置 force，避免“按一次看不到、再按一次才有”。
