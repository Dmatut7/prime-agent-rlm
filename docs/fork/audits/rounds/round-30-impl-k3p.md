# round-30 K3 复核打穿五条 — 施工交付（K3P-1..K3P-5）

- 基线（冻结）：主仓 HEAD `ebfa8e09445c7a2f09760411b58f4d0cd1dd7c08`（只读，零写入）
- 施工工作树：`/tmp/audit_r/round-30/wt-k3p`（detached @ ebfa8e094，node_modules symlink 指主仓）
- 交付提交：**`482f19ad8`**（本工作树内，10 文件 +722/−63；含 changelog fragment）
- 报告：本文件；红→绿证据、验证批次、偏差决策均在内

## 逐条

### K3P-1（P2）祖先坏 JSON 连坐 — `settings-manager.ts`
- 修法（选了复核报告方向 = 指令选项 2）：`loadFromStorage` 逐祖先独立 `JSON.parse`；坏祖先只弃该层 + `recordWarning`（identity `ancestor-parse-error:<path>`，含路径与 parse error），好的祖先 + primary 继续合并。坏祖先的 consent 不可验证 ⇒ 以合成 veto（telemetry/agentTraces enabled:false）只对该层 fail-closed，不再把整个 project scope 打成 `{}`。
- 关键实现：`loadFromStorage`/`tryLoadFromStorage` 返回值新增 `ancestorParseErrors`；`fromStorage`/`reload` 消费并记警告。primary 自身 parse 失败仍整 scope 失败（SEC-7 原语义保留）；祖先 READ 失败（非 ENOENT）仍整 scope fail-closed（原语义保留）。
- 偏差说明：复核建议 recordError，但 `errors` 是 save-failure 契约通道（`persistenceFailure` 消费），外来祖先文件不是本会话的保存责任，故走 warnings（用户可见、按 identity 去重）。
- 红→绿：`test/settings-ancestor-scope-resilience.test.ts` 3 例改前红（own-model 丢、theme 丢、无警告）；改后绿（5/5）。

### K3P-2（P3）祖先 veto 不 live — `settings-manager.ts`
- 修法（低成本腿式重载，选 watcher 补路径）：`watchExternalSettings` 把 `projectAncestorSettingsFilePaths()` 全部加入 `watchFile` 轮询（去重 global/project 两路径）；新增 `ancestorStamps: Map<path, stamp|undefined>`，`captureSettingsStamps` 每次 load 后刷新；祖先 listener 比对 stamp 变化走既有 `reloadExternalEdit("project", stamp)` 腿。文件中途出现（此前 ENOENT）也会触发（polling watcher 对缺失文件有效）。
- 红→绿：同文件 1 例改前红（根目录运行中写 veto，5s 窗口后 agentTraces 仍 true 且 0 警告）；改后绿（≤200ms 生效 + external-edit 警告）。正控（watched global 文件改动触发 reload）改前改后都绿。

### K3P-3（P3）save 丢 runtimeOverrides — `settings-manager.ts`
- 修法：抽 `recomputeMergedSettings()`（global+project 再叠 runtimeOverrides，即 reload 修后语义），`constructor`/`reload()`/`save()`/`saveProjectSettings()` 四处共用；`settings` 字段改带 `{}` 初始化（tsgo definite-assignment）。
- 红→绿：`test/settings-save-keeps-runtime-overrides.test.ts` 2 例改前红（`setDefaultProvider` 触发 save() 后 getDefaultModel=undefined；`setProjectSkillPaths` 触发 saveProjectSettings() 同病）；改后绿。正控：盘上文件仍只含持久化字段、override 不落盘。

### K3P-4（P3）>64KiB 单行整条 ftruncate — `session-manager.ts`
- 修法（窗口扩到行尾真界 + 保守兜底）：`completeTrailingRecordNewline` 返回三态 `"completed" | "torn" | "unverifiable"`。尾部 64KiB 窗口内无换行 ⇒ 用向后分块扫描（与 `repairTruncatedTrailingLine` 同法）找到尾行真实起点，把整行读回验证；行长 > `SESSION_TRAILING_RECORD_VERIFY_MAX_BYTES`（新常量 16 MiB）或读取失败 ⇒ `"unverifiable"`：**不动文件**（repairOwnedSessionFile 直接返回，宁可不修不销毁；代价是后续 append 可能粘行，可恢复，远轻于毁记录）。窗口内正常路径与旧行为逐字节一致。
- 红→绿：`test/session-manager/k3p4-oversize-trailing-record.test.ts` 1 例改前红（200,8xx 字节完好记录被删到只剩 header）；改后绿（记录在、可读、换行补回）。正控：10KiB 照旧救回；真撕碎的 200KiB 半行照旧被清（repairTruncatedTrailingLine 路径未弱化）。

### K3P-4 附带核查
- `parseUnterminatedHeader`/`parseEntriesFromBuffer` 未动；`loadEntriesFromFile` 逻辑未动。

### K3P-5（P4）两处 rename 无租约 repair+append — `session-manager.ts` + 两个调用点
- 修法（照 `daemon-catalog-process.ts:161-173` 先例并收编为先例本体）：新导出 `appendOwnedSessionLine(sessionPath, agentDir, append, env=process.env)`：`acquireSessionLease` 强制 `SESSION_LEASES_ENABLED_ENV:"1"`，无租约即 throw `Refusing to append to a session without a write lease: <path>`；持约内 repair+append，finally release。三处共用：
  - `daemon-mode.ts` `rename_saved_session` else 分支 → `appendOwnedSessionLine(command.sessionPath, this.agentDir, …)`；
  - `in-process-agent-connection.ts` `renameSavedSession` → `appendOwnedSessionLine(sessionPath, this.runtimeHost.services.agentDir, …)`；
  - `daemon-catalog-process.ts` `appendOwnedSessionEntry` → 委托同一实现（错误文案逐字保留）。
- acquire 冲突路径：`SessionAlreadyActiveError` 原样上抛 = rename 拒绝。
- 红→绿：`test/suite/k3p5-rename-under-lease.test.ts` 1 例改前红（测试自身持活租约模拟 live writer，rename 照样 resolve 且落盘）；改后绿（rejects /lease|active/ + 文件逐字节未动）。正控：无竞争租约时 rename 照旧 repair+append 成功（dat2 原 4 例也全绿）。
- 覆盖声明：daemon-mode else 分支无现成轻量 harness 可直测（既有 rename_saved_session 测试全是 mock client），该分支与被测路径共用同一实现 + tsgo/biome 全绿；未单独集成测试，报告如实记录。

## 验证
- 红先行：4 个新测试文件 13 例，改前 8 例红 / 5 例正控绿（批次 ≤3 文件，`node ../../node_modules/vitest/dist/cli.js --run` 直调，`env -u` 剥离 RLM_*/PRIME_AGENT_*/PI_* 泄露变量）。
- 改后全绿：4 新文件 13 例；回归面 `test/session-manager/` 全 29 文件、`test/` 全部 15 个 settings* 文件、`agent-connection-in-process`、`agent-connection-snapshot`、`dat2-repair-before-append`、`r2-catalog-append-tail-repair`、`daemon-catalog-process` 全绿。
- `npx tsgo --noEmit` @工作树 EXIT 0；biome check 9 个改动文件 0 error 0 warning（biome --write 收敛过签名换行与空行）。
- 洁净树复验：`git archive 482f19ad8 | tar -x` → symlink node_modules → `tsgo --noEmit` EXIT 0 + 4 个新测试文件 13 例全绿（防 hook 半提交假绿）。
- 纪律：单命令 ≤60s 全程遵守；未跑 `doctor --fix`/`daemon ps -k`/`npm run build`/`npm test`；git add 逐文件、staged 清单核对过 = 恰好 10 个我改的文件；未 push（无 FORK_NOTES 义务触发）。

## 未做 / 残留
- F6（目录 fsync 家族级缺口）不在本单范围，未动。
- K3P-1 的坏祖先"层"语义为合成 veto（telemetry+agentTraces 同时 withhold）；若上游想要"只警告不关闸"（指令选项 1），删掉 `consentSources.push({telemetry:{enabled:false},agentTraces:{enabled:false}})` 一行即可，测试断言同步改两处。
- K3P-4 的 16 MiB 验证上限是工程判断（正常单行记录远小于此）；超限行为=不动文件，注释已写明取舍。
