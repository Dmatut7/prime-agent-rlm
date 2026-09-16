# round-32 修复线 k3r2-fixes：K3R2-2/3（r31 K3 快审尾巴）+ MVS-1/2/3（r32 模型面扫描）

冻结：主仓 HEAD `7e9ae6e33`（spawn 时；其后 `4723a37a5` 为 docs-only 不涉本线）。工作树 `/tmp/audit_r/round-32/wt-k3r2`，分支 `r32/k3r2-mvs-fixes`，交付提交 `9e5fcf9c6`（16 文件，+486/-12）。主仓零写入。测试命令：`env -u RLM_* -u PRIME_AGENT_* -u PI_* node <repo>/node_modules/vitest/vitest.mjs run <files>`（包根，批 ≤3 文件）。全量 `npm run check` EXIT 0（biome+tsgo+installer+browser-smoke+ci-honesty，工作树）；pristine-tree（`git archive HEAD`+symlink node_modules）`tsgo --noEmit` EXIT 0。

## K3R2-2（P3）信封/老切片反向盲区——反冻结闸 + 内容钉（r31 F1）

**红证（打穿复演，改前）**：把 `type DaemonCommandName = DaemonCommand["type"];` 移到 `export type DaemonCommand =` 之前 → command 切片 `slice(28437, 28389)` = ""；identity 测红（digest 不匹配 f14397289a30 vs 6f6918394546）；**按头部仪式重算常量后 31/31 全绿**——整个请求 union 永久脱管，零测试可发现。这正是报告 F1 的冻结序列。

**修复**（全部在 `test/daemon-protocol.test.ts`，生产源零改动——这是测试守卫缺口）：
1. `daemonSchemaDigest` 前置守卫：任一切片为空串或纯注释（剥 `/*..*/`+`//` 后 trim 空）即抛 `daemon schema slice "<key>" is empty or comment-only...`——重算仪式在 digest 计算处被拦，冻结不可达。新测试 "refuses to freeze an empty or comment-only slice into the schema identity"（4 个不可用切片态 × toThrow）**改前红**（expected [Function] to throw）。
2. 三条老切片补 toContain 内容钉（照其余 13 条先例）：command（start 标记 + `type: "prompt";`/`get_session_tree`/`declare_client_capabilities` 尾臂）、savedSession（start + `messageCount`/`usage?: SessionUsageSummary` 尾字段）、outbound（start + `| DaemonResponse`/`daemon_hello`/`session_snapshot_begin`/`| CompactAssistantDelta;` 尾臂）。复演冻结态（常量已重算）时这些钉单独红：`expected '' to contain 'export type DaemonCommand ='`。
3. responseEnvelope 起终点钉：`export type DaemonResponse =`（起）、`export type DaemonErrorInfo =` + `code: "command_result_uncertain"`（终点前最后内容——end marker 前移必丢）。
验证：改后 32/32 绿；破坏态三处独立红（pins 红 + mutation/replay 测经守卫抛错红）。

## K3R2-3（P4）CLI 告警静默 + 告警 identity 无 stamp（r31 F4a/F4b）

1. **F4a**：`package-manager-cli.ts reportSettingsErrors` 补 `drainWarnings()`，输出格式与 errors 同形（`Warning (<context>, <scope> settings): <message>`，黄色）。红测 `test/k3r2-package-cli-settings-warnings.test.ts`：真实 SettingsManager + 破损祖先 settings.json + chdir 仓库子目录驱动 `handlePackageCommand(["list"])`，断言 console.error 带 `Warning (package command, project settings): settings.json at <path>`——**改前红**（warnings 全静默）。注意 macOS chdir 把 /var 解析成 /private/var，断言用 realpathSync。
2. **F4b**：`settings-manager.ts recordAncestorParseError` identity 从 `ancestor-parse-error:${path}` 改为 `ancestor-parse-error:${path}:${stamp ?? "unreadable"}`（stamp 走既有 `settingsStampForPath`，同 external-edit 先例）。红测 `test/k3r2-ancestor-warning-identity.test.ts`：破损→警告#1→修好→reload 拿回 theme→再破损（不同内容）→reload→断言第二次警告出现——**改前红**（expected false to be true，path-only identity 永久压制）。
3. **③（watcher 跨会话去重）**：**记 note 不做**。r31 F3 实测成本可忽略（50 会话×(2+D)≈300 stat/s，StatWatcher 不占 FD）；去重需模块级共享 watcher 状态+逐会话 dispose 语义重设计，改动面大收益小。残留：每会话各建各的轮询 watcher。

## MVS-1（P2）REPL 提示 os.environ→bash() 谎言 + 出口零模型可见

- `prompts/rlm.ts`：教学句改为真话——`os.chdir` 仍持久生效；`bash()` 子进程只拿 child-safe whitelist（PATH/HOME/TZ/locale/路由键），新设 `os.environ['MY_VAR']` 只达 kernel 内 Python 子进程、**静默剥除于 bash() 子进程**；单命令变量用 shell 前缀 `bash('MY_VAR=value npm test')`；跨调用传变量先 `os.environ['PRIME_AGENT_ENV_PASSTHROUGH'] = 'MY_VAR,OTHER_VAR'`（一行示例）。
- `core/tools/bash.ts` 经典 bash 工具 description 同步（经典工具走同一 `getShellEnv()` 白名单）：whitelist 语义 + `VAR=value cmd` 前缀 + 用户侧 `PRIME_AGENT_ENV_PASSTHROUGH=NAME1,NAME2`。
- `prime-agent-runtime/src/rlm/bash.py` docstring 补同构一句（`help(bash())` 可见）。
- 红测（prompt-command-reality.test.ts 新 describe，**改前红**两处）：①提示词不再含 `both persist in the REPL and apply to later \`bash()\` calls` 且含 whitelist/PRIME_AGENT_ENV_PASSTHROUGH/MY_VAR=value；②经典工具 description 含 whitelist + PRIME_AGENT_ENV_PASSTHROUGH。改后 10/10 绿。
- **不修错误文案侧**（失败命令输出属命令本身）；**未做** bash() 运行时"剥离发生且命令读被剥变量"提示（kernel 跑 installed build，改 bash.py 行为需重建+kernel-heavy 测试才能验，超出本轮；docstring/提示词/工具描述三处已对齐，r32 model-visible 报告的活体红证在 docstring 语义下已有出口可循）。

## MVS-2（P4）手动 /compact 丢 pending 指令

`agent-session.ts _compact`：方法开头读取 `_pendingRequestedCompaction`，`joinCompactionInstructions(manual, pending)`（manual 在前，空串不入列）得 `effectiveCustomInstructions`，四处使用点（compaction_start/_performCompaction/compaction_end×2）全部换用；pending 状态仍只在**成功**时清除（失败保持排队语义不变）。与 auto 路径注释 "Any compaction consumes a pending model request and honors its instructions" 对齐。红测 `test/suite/k3r2-manual-compact-pending-instructions.test.ts`（suite harness+faux provider，2 用例：无手动指令时并入 pending 指令；双指令时手动在前）**改前两用例均红**。改后 2/2 绿。

## MVS-3（P4）`<ipython_state>` 不属 machine-block

`compaction/machine-blocks.ts`：`MACHINE_BLOCK_TAGS` 4→6（+`ipython_state`、`ipython_state_restored`，strip-only 成员——renderer 不产它们，识别是为了 strip/delimiter 形状覆盖）；`BLOCK_DELIMITER_SHAPE` 同步（长名在前防前缀吞）。旧名册经 previousSummary 通道被 `stripMachineBlocks` 摘除，二次压缩不再把陈旧名册折进叙事。红测 `test/k3r2-ipython-state-machine-block.test.ts` 3 用例（strip 保叙事 byte-identical / restored 同型 / prepareCompaction 的 previousSummary 不含陈旧名册）**改前全红**；改后 11/11 绿（含 compaction-machine-blocks 既有 8 条）。两处 `MACHINE_BLOCK_TAGS.length` 钉（compaction-machine-blocks、suite/regressions/machine-block-tail-anchor）按契约变更改 4→6 并注原因。**残留**：keepRecent 窗口内两代 `<ipython_state>` custom message 仍并存（消息通道，非 summary 通道；新鲜通知在尾部、live kernel 是权威，P4 可接受——要彻底需压缩输入侧丢弃旧代，属另一改动面）。

## 验证记录（全部 `env -u` 泄露变量，直接 node 调 vitest，包根，批 ≤3）

- 新/改测试：daemon-protocol 32、prompt-command-reality 10、k3r2-package-cli 1、k3r2-ancestor-warning 1、k3r2-ipython-state 3、suite/k3r2-compact 2 —— 全绿。
- 回归批（全绿）：compaction 家族（compaction/fact-appendix/user-requests 96、fidelity+body-delimiter+tail-anchor 34、suite compact 家族 29+8+43、interactive-mode-compaction+compact-session-stream+trigger-compact-extension 21）、settings 家族（ancestor-scope-resilience+deep-merge-and-watch+unknown-keys 20、project-ancestor-veto+reload-runtime-overrides+manager 61）、package CLI（package-command-paths+public-command+package-manager 150）、settings-agent-traces-gate（batch 内 46 含 daemon-protocol+prompt-command-reality）。
- `npm run check` EXIT 0（工作树全量）；pristine `git archive HEAD` + symlink node_modules `tsgo --noEmit` EXIT 0。pre-commit hook 在 worktree 无 `.husky/_`（husky 装在主仓），已按 shared-worktree 纪律用 pristine 树复验替代。
- 提交 `9e5fcf9c6`：分文件 `git add`×16，staged 名单核对无多无漏；changelog fragment `packages/coding-agent/.changes/r32-k3r2-mvs-fixes.md`（5 bullet）；prime-agent-runtime 无 .changes 体系（非 npm 包）。
- 红证留存：本文件各节"改前红"均为实跑输出（vitest --reporter=verbose 摘录），冻结态演示常量 6f6918394546 已随 git checkout 还原。

## 残留与移交

1. K3R2-3③：watcher 跨会话去重不做（见上）。
2. MVS-1：bash() 运行时剥离提示未做（见上）；kernel 生效需重建 installed build。
3. MVS-3：keepRecent 两代并存残留（见上）。
