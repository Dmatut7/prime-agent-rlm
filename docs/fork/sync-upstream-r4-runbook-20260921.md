# R4 施工手册（runbook）· 2026-09-21

> 配套《sync-upstream-r4-and-ui-plan-20260921.md》v2 的操作层：席位拿到本手册＋自己的任务卡即可零思考开工。数据源：43 笔逐笔干跑/文件态实测（母席亲算，与三席审查报告交叉一致）。

## 一、拾取总清单（43 笔，严格按本表自上而下＝上游序）

处置列：主干＝主干席串行拾取；岛＝岛席并行；SKIP＝不拾（原因内置）。真MD＝该笔修改/删除的文件在 fork 已不存在（处置见 §三-3）。

| # | sha | 处置 | 主题 | 真MD | 定向测试 | 特殊处置 |
|---|---|---|---|---|---|---|
| 1 | `c13e03113` | 岛 | [Eval] Add pre-release behavioral evaluation CI (#2306) | — | — | ci.yml 等 3 处冲突（非零冲突，v1 误标 A 批） |
| 2 | `756a8ce83` | 岛 | [RSI, performance] decode private frames in linear time  | 3 件 | session-worker-private-framing.test.ts |  |
| 3 | `1df880d81` | 岛 | fix(coding-agent): preserve the recorded skill map in no | — | kernel-bootstrap.test.ts |  |
| 4 | `7572880fe` | 岛 | [RSI, bug] Classify Windows worker pipes correctly in da | — | daemon-ps.test.ts |  |
| 5 | `b6fb29850` | 主干 | add fullscreen touch interactions and clickable links (# | 3 件 | conversation-click-regions.test.ts | 按上游序早位落；31 文件大件，冲突面失控→整笔弃＋下游干跑重算（勿挪到末位，会喂冲突给后续 TUI 笔） |
| 6 | `7f39eb825` | **SKIP**：跳过：fork 已自研 0d353ae93 | [RSI, other] Rank digest and harness search by IDF-weigh | — | refinement.test.ts |  |
| 7 | `fc9f2ae24` | 岛 | [RSI, performance] perf(kernel): skip pip seeding when c | — | kernel-bootstrap.test.ts | 必取（夹在 1df880d81/d96a990b4 间共改 bootstrap.ts，漏取抬高邻笔冲突） |
| 8 | `8218d6bcc` | 主干 | [RSI, performance] perf(kernel): defer the event-loop im | — | test_bash.py |  |
| 9 | `6d2c57d72` | **SKIP**：跳过：fork 已自研 81f964022 | [RSI, performance] Stabilize continual-harness prompt ma | — | agent-session-recursion.test.ts |  |
| 10 | `5fb3d9acb` | 主干 | [RSI, bug] compaction: keep tool identity in serialized  | — | compaction.test.ts |  |
| 11 | `b6d955a9b` | 主干 | [RSI, security] fix(kernel): keep the kernel stderr log  | — | repl-kernel-startup.test.ts |  |
| 12 | `1437e4bcc` | 主干 | docs(coding-agent): correct wrong setting defaults and d | — | — |  |
| 13 | `66df06fc1` | 主干 | [RSI, bug] Fix stale async-bash completion notice race a | — | test_repl.py |  |
| 14 | `f2a9ad661` | 主干 | feat(coding-agent): start chats at the middle conversati | 2 件 | 2193-chat-detail-cycle.test.ts |  |
| 15 | `1ae25148b` | 主干 | [RSI, security] pre-push guard against mirror-like pushe | — | — | 根 package.json check 链已分叉：手工并，并后必跑全量 check |
| 16 | `54da82e97` | 主干 | [RSI, bug] fix(daemon): let session opens wait through a | — | agents-view-mode.test.ts | 协议义务三件：向后兼容分类＋兼容映射＋双向测试（无需升 DAEMON_PROTOCOL_VERSION） |
| 17 | `3dfb0276b` | 主干 | [RSI, bug] fix(daemon): answer heartbeats_list from live | — | heartbeats-list-response-latency.test.ts |  |
| 18 | `b6b94c78a` | 主干 | [RSI, bug] fix(coding-agent): absorb kernel child stderr | — | repl-kernel-pipe-errors.test.ts |  |
| 19 | `d96a990b4` | 岛 | [RSI, performance] Land the kernel skill-sync marker so  | — | kernel-sync-child.ts |  |
| 20 | `126fe7010` | 主干 | [RSI, bug] Hold spawn name reservations until admission  | — | agent-session-recursion.test.ts |  |
| 21 | `ff40ea24e` | **SKIP**：跳过：#2400 测试笔（fork 已有实现） | test(refinement): drop stale recency tie-break expectati | — | refinement.test.ts |  |
| 22 | `b09e37d84` | **SKIP**：缓取：ACP+共享夹具 | fix(coding-agent): expose ACP model and effort pickers ( | — | acp-mode.test.ts |  |
| 23 | `976ea1084` | **SKIP**：缓取：沙箱脚本 | fix(scripts): stop pinning vm=False on sandbox creation  | 3 件 | — |  |
| 24 | `63d88319b` | **SKIP**：缓取：PI GLM+同文件撞 cc4a17379 | fix(ai): stop sending enable_thinking to Prime Inference | 1 件 | openai-completions-tool-choice.test.ts |  |
| 25 | `d2cdb4504` | 岛 | [RSI, performance] perf(daemon): mtime-guard the cron jo | — | cron-jobs-state-snapshot.test.ts |  |
| 26 | `e311d6495` | 主干 | perf(coding-agent): skip roster re-composition for uncha | — | daemon-agent-roster.test.ts |  |
| 27 | `b08f08efa` | 主干 | feat(coding-agent): hold goal/autonomous continuations w | 2 件 | autonomous-continuation-subagent-gate.test.ts |  |
| 28 | `eee9d814b` | 主干 | feat(coding-agent): add /speed command showing output to | 1 件 | interactive-mode-command-usage.test.ts |  |
| 29 | `e683fcb53` | 岛 | [RSI, bug] fix(ai): recover stale Codex chains after met | — | openai-codex-stream.test.ts |  |
| 30 | `41e4e0e18` | 主干 | fix(harness): validate refinement writes and skip malfor | — | refinement.test.ts |  |
| 31 | `3b1aa5ff3` | 主干 | feat(images): route image turns to a configured image mo | — | image-model-override.test.ts |  |
| 32 | `2e9ab77b8` | 主干 | fix(coding-agent): reconnect attached windows when the d | — | agent-connection-daemon.test.ts |  |
| 33 | `b3e04b58b` | 主干 | [RSI, bug] fix(coding-agent): re-park pending next-turn  | — | agent-session-queue.test.ts |  |
| 34 | `0597614e0` | 主干 | [RSI, performance] count tool-result message entries fro | — | file-operations.test.ts |  |
| 35 | `2883a7843` | 主干 | [RSI, feature] Park quota-blocked sessions until the pro | — | provider-retry.test.ts |  |
| 36 | `c37f5eb39` | 主干 | [RSI, performance] Append catalog metadata without full  | — | daemon-supervisor-monitor.test.ts |  |
| 37 | `e1f4ae5bd` | 主干 | [RSI, performance] start the daemon catalog on demand (# | — | daemon-catalog-startup.test.ts |  |
| 38 | `a8ae6269a` | 主干 | [RSI, performance] context: keep only the newest harness | — | build-context.test.ts | 符号对账：消费 harnessStateFingerprint（fork 自研 81f964022 已有等价，名不同则按 fork 名适配） |
| 39 | `0498deb43` | 主干 | [RSI, performance] Cache the branch array on the per-tur | — | leaf-branch-cache.test.ts |  |
| 40 | `27f32ddb7` | 主干 | [RSI, bug] compaction: anchor summaries to kept-tail sta | — | compaction.test.ts | 依赖 5fb3d9acb 先落（上游序天然满足，勿倒序） |
| 41 | `690e23d8c` | 主干 | feat(coding-agent): per-request provider timing diagnost | — | request-timing.test.ts |  |
| 42 | `1272a3d6e` | 主干 | [RSI, feature] feat(coding-agent): tell the model when P | — | ipython-bootstrap.test.ts |  |
| 43 | `c91e6e991` | 主干 | [RSI, bug] fix(kernel): bound REPL protocol frame sizes  | — | repl-kernel-protocol-corruption.test.ts |  |

**账目**：43 = 拾 37（主干 29＋岛 8）＋ SKIP 6。主干 29 笔中的 `eee9d814b`(/speed) 由第一小时车道先行完成，主干席遇之记「已应用」跳过。

## 二、席位任务卡

### 席 A：第一小时车道席（r4-lane-first）
1. `git worktree add ../pa-r4-first -b r4/first-hour && ln -s $PWD/node_modules ../pa-r4-first/node_modules`（在主仓根执行）。
2. **先拾 `eee9d814b`**：干跑（§三-1）→ cherry-pick -x → 解冲突（含真MD：`test/interactive-mode-command-usage.test.ts` fork 已删→按上游版重建）→ 跑它的定向测试。
3. **U4 降噪**（§四-U4 任务卡）→ **U1 水位条**（§四-U1）→ **U2 错误警示**（§四-U2；时序约束：必须在主干席启动前完成 agent-session.ts 改动，否则整件移交主干席末班）。
4. 新增探针测试 `packages/ai/test/openai-completions-bailian-glm-toolstream.test.ts`（mock transport＋models.json glm 条目的 compat，断言 payload `tool_stream===false`）。
5. 全量 `npm run check`＋新测试全绿 → 合入 main（一次一条）→ 执行**重启窗一操作单**（§五）。
停手条件：测试红两轮／磁盘<10G／GLM 坏调用风暴（换型并上报）。

### 席 B：主干席（r4-trunk，夜间连跑）
按 §一 清单自上而下拾「主干」行（SKIP 行越过；`eee9d814b` 记已应用跳过）。每笔六步（§三-1 流程），**台账每笔一行**（§六格式）。`b6fb29850` 遵循其特殊处置（可整笔弃）。卡两笔解不动→停、记死因、上报母席。

### 席 C：岛席 A（r4-island-a）
bootstrap 岛 3 笔（`1df880d81`→`d96a990b4`→`fc9f2ae24`，按此序）＋ `c13e03113`。独立 worktree＋分支 `r4/island-a`，完成后通知母席按序合流。

### 席 D：岛席 B（r4-island-b）
`756a8ce83`（真MD 3 件＝benchmarks 三文件，重建适配）＋ `7572880fe` ＋ `d2cdb4504` ＋ `e683fcb53`。同 C。

### 席 E：对账看护席（r4-audit）
每笔主干/岛提交后：跑该笔定向测试抽查、核台账行完整性、每 15 分钟磁盘哨兵（`df -h / | awk 'NR==2{print $4}'` 与 `du -sh /tmp ~/.prime/agent/session-artifacts`），<15G 报母席、<10G 令全线停工先清。

## 三、每笔六步流程与规则（所有拾取席共用）

1. **干跑**：`git merge-tree $(git merge-base HEAD <sha>) HEAD <sha>` → 数冲突文件。0 冲突→直接 cherry-pick。
2. **真MD面**：`git show --name-status --pretty=format: <sha> | awk -F'\t' '$1 ~ /^[MD]/ {print $2}' | while read f; do [ -e "$f" ] || echo "GONE: $f"; done`。
3. **真MD 处置规则**：fork 有意删除的（如 2193 回归测试、`interactive-mode-command-usage.test.ts`）→ 按上游版重建并适配 fork 现状；上游新增件（A 状态）→ 直接落。禁盲覆盖。
4. **落笔**：`git cherry-pick -x <sha>`；冲突手工解（逐 hunk 判断取上游/取 fork），解后 `git add <具体文件>`＋`git cherry-pick --continue`。禁 `git add -A`、禁 `--no-verify`。
5. **定向测试**：跑该笔带来的测试文件（清单「定向测试」列）＋相关簇；消毒环境：`env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_CHILD_ID -u PRIME_AGENT_* npx tsx ../../node_modules/vitest/dist/cli.js --run <test>`（在包根跑）。
6. **提交与台账**：独立 commit（单笔可 revert）→ 台账写一行（§六）。上游自带 `.changes/*.md` fragment 随笔落盘；4 笔缺 fragment 的补写。

**撞名 3 处**（双新增同名）：`cron-jobs-state-snapshot.test.ts`、`heartbeats-list-response-latency.test.ts`、`.husky/pre-push`——合并两侧内容或改名，禁直接覆盖，记台账。
**合流规则**：一次合一条，每合一条在主仓跑全量 `npm run check`（全输出）＋净树 tsgo（`git archive HEAD | tar -x -C /tmp/pt && ln -s node_modules...` 同既定法）。

## 四、UI 任务卡（席 A）

- **U1 水位条**：`components/footer.ts` 常驻一行 `模型名 · ctx 312k/1M(38%) ▍压缩线80%`＋GLM 风暴区(39万)刻度；`components/top-bar.ts` 挂模型名；`core/settings-manager.ts` 新设置 `footer.telemetry: off|compact|full`（默认 compact，/usage 保持一次性报告语义）。测试：新建 `test/interactive-footer-telemetry.test.ts`。
- **U2 错误警示**：`core/agent-session.ts` 维护连续工具错误计数（错误 toolResult +1、成功归零），footer 显示 `⚠ 工具错误×N`（≥3 才显）。测试：新建文件。
- **U4 降噪**：`components/conversation-components.ts` 轮内机械聚合一行（`⚙ 本轮 N 步 · 总耗时 —— 动词摘要`，Ctrl+O 展开）；`components/assistant-message.ts` thinking 一行化；`components/bash-execution.ts`/`ipython-cell.ts`/`tool-execution.ts` 语义摘要（原始命令进展开）；`components/keybinding-hints.ts`＋`modes/interactive/feature-hints.ts`＋`components/feature-hint.ts` 提示去重＋中文。验收：改前后 `tmux capture-pane -p` 文本比对，机械行数降、正文占比升。
- 席内序铁则：`eee9d814b` → U4 → U1 → U2 → 探针测试 → check → 合流 → 重启窗一。

## 五、重启窗操作单

**窗一（席 A 合流后）**：①确认全量 check 绿＋build（`npm run build`）；②`git tag pre-r4-window1`；③`prime-agent shutdown`；④重开 `prime-agent`；⑤自证：uptime 归零、健康检查、抽一场真 GLM 带工具会话、跑 GLM 探针测试、`/speed` 与水位条可见、当日按取证配方扫 GLM 坏调用＝0；⑥顺带回收 3-5G 历史垃圾（/tmp 旧车道＋死会话 artifacts，留尸清单外）；⑦失败回滚：`git reset --hard pre-r4-window1`（仅文档/代码，不动他人提交）或单笔 revert。
**窗二（收总账）**：同上①-⑤＋R3 门复测式抽测＋台账全量核对＋FORK_NOTES.md 更新（push 前）。

## 六、拾取台账

路径：`docs/fork/audits/r4-pick-ledger-20260921.md`。每笔一行：
`| # | sha | 落点commit | 冲突文件数 | 真MD处置 | 撞名/弃hunk | 定向测试结果 | 备注 |`
开行先写表头。SKIP 行也要记（原因）。

## 七、停手与升级

连续两笔冲突解不动／定向测试红两轮／磁盘<10G／GLM 坏调用风暴→停、写死因（时间+动作+结果）、上报母席换法或换型。任何时刻禁 `--no-verify`、禁 `add -A`、禁把 WIP 留在共享仓。
