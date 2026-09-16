# SEC-7..10 settings 闸四洞修复（round-29 / 线名 sec7-10-settings-gates）

- 冻结 SHA：`12b364b77`（主仓 HEAD，主仓只读零写入）
- 工作树：`/tmp/audit_r/round-29/wt_sec7-10`（detached @ 冻结 SHA，node_modules symlink → 主仓）
- 交付提交：`867de634d` `fix(coding-agent): close four settings-gate holes (SEC-7..10)`（7 文件，+598/−10）
- 测试：4 个新文件 15 用例，先红后绿；回归基线全绿；`npm run check` 全套子闸全过
- 报告依据：/tmp/audit_r/round-28/0902-final.md §10 R1/R2/R3/R5

## SEC-7 撤回同意 fail-open（§10 R1）

**红（改前）**：`test/settings-consent-fail-closed.test.ts` 5 用例全红。核心红证：全局文件先有 `{"agentTraces":{"enabled":true}}`，用户改文件撤回但留尾逗号 `{"agentTraces":{"enabled":false},}` → `reload()` 后 `getAgentTracesEnabled()` 仍 `true`（expected false, received true）；telemetry 同形（`getTelemetryEnabled()` 仍 true）。watcher 路径红证：坏 JSON 外部编辑后 warning 照报 "it was reloaded into this session" 且闸仍 true。

**修**（`settings-manager.ts`）：
1. `getAgentTracesEnabled()` / `getTelemetryEnabled()`：对应域 `globalSettingsLoadError`/`projectSettingsLoadError` 非空 ⇒ 该域按"未授予"处理（agentTraces 域按 false、telemetry 域按 false），解析失败=关。runtime 域在内存恒可解析，不参与 fail-closed。
2. `reloadExternalEdit()`：编辑的域 reload 后带 load error ⇒ 不再报"reloaded into this session"，改报 `external-edit-parse-error:<scope>:<stamp>` 身份的 warning（"failed to parse … change was not applied … consent gates treat the unparseable scope as withdrawn"+parse error 消息），消除谎报已生效。

**绿**：15 用例含正控——文件修好后 consent 恢复 true（fail-closed 不是永久关）。注意：非同意类设置在坏 JSON 时仍保留上次成功值（现状语义，只有 consent 闸 fail-closed），warning 文案如实说明。

## SEC-8 项目 veto 无祖先回溯（§10 R2）

**红（改前）**：`test/settings-project-ancestor-veto.test.ts` 7 用例中 6 红。核心红证：repo 根有 `.git` + `.prime/agent/settings.json` `{"agentTraces":{"enabled":false}}`、全局 consent true，`SettingsManager.create(repoRoot/packages/app/src, agentDir)` → `getAgentTracesEnabled()` 仍 `true`（expected false）；祖先 theme 键 `getTheme()` undefined（expected 'dark'）。

**修**（`settings-manager.ts`）：
1. `SettingsStorage` 新增可选 `projectAncestorSettingsFilePaths(): string[]`（root-most 先序）。`FileSettingsStorage` 构造时算好：从 cwd 的父目录向上走，到 git repo root（含）为止——照 `package-manager.ts` `collectAncestorAgentsSkillDirs`/`findGitRepoRoot` 先例（本地复制小助手，避免 settings↔package-manager 循环 import）；无 git 仓时照先例走到文件系统根；cwd 恰为 repo root 时收集空集（repo 上方的文件不 project 进来，有负控测试）；全局路径被排除（用户级文件不当第二次 project veto）。
2. `loadFromStorage("project")`：主文件（cwd）之外叠读祖先文件，root-most 先 merge、cwd 最后（closest wins）；祖先缺文件（ENOENT）跳过，存在但读不了/解析失败 ⇒ 整个 project 域 load 失败 ⇒ 走 SEC-7 fail-closed。
3. `applyProjectConsentVeto`：合并后对 `agentTraces.enabled` / `telemetry.enabled` 施加"任一显式 false 即 veto"——子目录文件不能重新打开祖先撤掉的同意（project 域只能关不能开的既定语义）。
4. 写入与热重载 watch 仍只针对 cwd 主文件（`withLock`/`settingsFilePath` 未动）：祖先文件不写、不 watch（已知限制，见下）。

**绿**：7 用例全绿，含三条护栏：无祖先 veto 时 consent 照常、repo 根上方文件不 project 进来、坏祖先文件 fail-closed。

## SEC-9 reload 丢 runtimeOverrides（§10 R3）

**红（改前）**：`test/settings-reload-runtime-overrides.test.ts`：global 文件 theme light → `applyOverrides({theme:"dark"})` → getTheme dark → 手改文件（`retry.enabled:false` 佐证文件内容真被重读）→ `reload()` → getTheme 回 `light`（expected 'dark' to be 'light' 反向，即 override 被静默回滚）。

**修**：`reload()` 的 merged 重算改为 `deepMergeSettings(deepMergeSettings(global, project), runtimeOverrides)`——与 `applyOverrides` 的叠法一致。正控用例：无 override 时 reload 正常反映文件（不受影响）。

## SEC-10 stopWatchingExternalSettings 零调用者（§10 R5）

**红（改前）**：两条红证：
1. 行为红（临时 variant，已删）：session dispose 后 2.5s（跨过 1s 轮询周期）内改全局 settings.json → `drainWarnings("global")` 收到 "reloaded into this session" 且 theme 翻成 light——watcher 活过了 session 生命周期（`expected [{scope:'global',…}] to deeply equal []`）。
2. 最终测试红：`isWatchingExternalSettings is not a function`（API 缺失即缺陷本体）。

**修**：
1. `SettingsManager.isWatchingExternalSettings(): boolean` 新公开访问器（`externalWatchers.length > 0`）。
2. `AgentSessionServices` 新增必填 `ownsSettingsManager: boolean`：`createAgentSessionServices` 在**自己创建** manager（调用方没传 `options.settingsManager`）时为 true。src 内所有真实路径（daemon runtime 工厂 `prepareRuntimeServices`、interactive、print、RPC、RLM 子代理 runtime）都不传 manager ⇒ 全部按"session 拥有"处理。
3. `createAgentSessionFromServices`：`ownsSettingsManager` 为 true 时 `session.registerDisposeCallback(() => settingsManager.stopWatchingExternalSettings())`。`AgentSession.dispose()` 同步跑 dispose callbacks，`AgentSessionRuntime.dispose()`（daemon 会话移除的统一出口）→ `session.disposeAsync()` → `dispose()` 全覆盖；SDK/测试传入自有 manager 的调用方不被自动停表（所有权归调用方，接口注释写明）。

**绿**：`test/settings-session-watch-lifecycle.test.ts`：dispose 后 `isWatchingExternalSettings()` false、改文件 2.5s 无 warning、theme 不翻。交互模式的 /new //switch 路径核实过：每次 runtime 替换都新建 services/manager，旧 session dispose 停旧 watcher、新 session 起新 watcher，无跨代泄漏。

## 验证台账

先红后绿（改前红跑均在冻结 SHA 干树上执行）：
- 新测试 4 文件 15 用例：改前 11 失败 + SEC-10 行为红/TypeError 红；改后全绿。
- 回归基线（同环境同跑法，`env -u RLM_* -u PRIME_AGENT_* -u PI_*` + 直接 `node ../../node_modules/vitest/dist/cli.js`，分批 ≤3 文件，唯一例外为 pristine 终验一次跑 4 文件）：
  - `settings-manager.test.ts` 52/52、`settings-agent-traces-gate.test.ts` 4/4、`settings-deep-merge-and-watch.test.ts` 4/4
  - `agent-traces.test.ts` 54/54、`telemetry.test.ts` 15/15、`agent-session-services.test.ts` 等 services/runtime 批 24/24、11/11、7/7
  - `settings-manager-bug` / `settings-hardware-cursor-precedence` / `settings-persistence-failure` / `settings-unknown-keys` / `settings-selector` 批 17/17、30/30
  - 回归件 `3616-settings-inmemory-reload` / `2753-reload-stale-resource-settings` / `4620-fast-mode-settings` 12/12
- `npm run check` 全套：repo 级 `biome check --error-on-warnings .`（我的文件零 diagnostic；仓存 30 infos 与冻结 SHA 主仓一致）、root `tsgo --noEmit` EXIT 0、`check:installer`、`check:browser-smoke`、`check:test-hygiene`（frozen 474，无新探针）、`check:ci-honesty` 全过。
- 提交纪律：7 文件逐个 `git add`，staged 名单逐一核对（见上）；commit `867de634d` 经 `git archive HEAD` 解包 + symlink node_modules 后 pristine 树 `tsgo --noEmit` EXIT 0 且 15 用例复跑全绿。

## 已知限制 / 残余

1. 祖先 project 文件不进 watcher 热重载面（只 watch cwd 主文件）：祖先文件改了要等下一次 `reload()`（自动上传腿每次都 `await reload()`，故 traces 闸面实际即时）。
2. "任一 false 即 veto" 只作用于 `agentTraces.enabled` / `telemetry.enabled` 两个同意键；其余键按 closest-wins 合并（与报告 §10 修法一致）。
3. §10 R6（设计层残余：项目域 extension 默认自动发现、`/traces upload*` requireEnabled:false 绕 DO_NOT_TRACK、src/core/tools 对 agentDir 无写保护）不在本线范围，原样留给裁定点。
4. 无 git 仓的 cwd 祖先回溯走到文件系统根（照 skills 先例）；只读不存在文件，无副作用。

## 工件

- 工作树（含提交）：/tmp/audit_r/round-29/wt_sec7-10
- pristine 验证树：/tmp/audit_r/round-29/pristine_sec7-10
- commit message：/tmp/audit_r/round-29/commit_msg.txt
- 本报告：/tmp/audit_r/round-29/sec7-10-settings-gates.md
