# round-28 impl — LAT-4/LAT-5（LAT-3 归因合并 × leaf 移动/交织 全族修复）

- 冻结基线：主仓 HEAD **9866645e3**（只读，未写入主仓任何文件）
- 施工工作树：`/tmp/audit_r/round-28/wt_impl`（detached @ 9866645e3 → 分支 `r28/lat45-fixes`，node_modules symlink）
- 输入：0902 终审 §1/§9/§12（洞 ①-A/①-B/①-C/①-D）+ 母席两轮范围升级（C1-C 常态化、C1-D P0、GLM 席真序列 1,386 dangling/983 message 不可达）
- 测试：`env -u` 泄露变量 + 直接 `node node_modules/vitest/dist/cli.js`；分批 ≤3 文件；先红后绿

## 1. 判决与修法

四条洞同根：LAT-3 让"磁盘 parentId"可以与"内存 parentId"不同，而冲刷行 parent 没有任何"该 id 必须已落盘"的约束。修法一条封死（session-manager.ts）：

1. **冲刷行 parent = 从 `pending.lastId` 沿内存 parent 链上溯到最近的"非 deferred merge"祖先**（`_nearestPersistedAncestor`；不在 `deferredAttributionIds` 里的 id 必是已落盘条目或既有冲刷行）。跳过的只有同类型 child_usage merge ⇒ 重载链保序、保内容、不 dangling。终底 fallback = `anchorId`（该 target 最新已落盘行，0902 的 re-seed 规则）。
   - 精确实现 0902 的两条指令：re-seed 时 `anchorId = pending.lastId`（刚写出的行 id，必在盘上）；merge 时不再从 leafId 重捕。
   - 比字面"沿 target 自身链"更强的点（证据见 §3 归因）：①-B/①-C 里 mid-window 的 message/compaction 必须出现在重载链上，字面 own-chain anchor 会绕过它们（我的 C1-B 追踪：walk e3→e2→e1 丢 u2）。最近已落盘祖先同时满足"必在盘上"与"保内容"。
2. **窗口切断（冲刷先于一切落盘）**：`_appendEntry`/`_appendEntryKeepingLeaf` 顶部、`_setLeaf`（移 leaf 前）、`branchWithSummary`（移 leaf 前）、首条归因 `_persist` 前，各加 `flushChildUsageAttributions()`。⇒ 任何即落盘条目的 parentId（=当时 leaf，可能是 merge id）在落盘那一刻起就可解析；压缩（appendCompaction 两条路径）与 rewind 的 marker 不会被后续冲刷行覆盖。
3. **`deferredAttributionIds` 簿记**：merge 时加入、冲刷时删 `pending.lastId`、`_rewriteFile`/`newSession`/`setSessionFile` 时清空（rewrite 物化全部内存条目）。
4. **LAT-5**：`_setLeaf` 移 leaf 时 `lastAgentStatusWrite = undefined`（与 `_buildIndex` 同语义），同分支连续同 verdict 仍去重（未动 appendAgentStatus 的去重逻辑）。

交织 target 不共享 pending 窗口：pending 本就按 targetId 分键 + 冲刷行 parent 走最近已落盘祖先，跨 target 引用只出现在"被跳过的 merge id"里，永不落盘 ⇒ 无需逐 merge 冲刷，LAT-3 合并收益完整保留（20k merge 连续窗口 ≤700 行照旧，见 §4 正控）。

## 2. 红绿证据（全部在 wt_impl 实跑）

红（改前，@ 9866645e3，2 文件 11 用例：**7 红 / 4 绿**）：

| 用例 | 红证 |
|---|---|
| C1-A（LAT-5） | rewind 后重发同 verdict 被去重吞掉，`getLatestAgentStatus()` 恒 undefined |
| C1-B | live `["parent turn","after rewind"]` vs reload `["parent turn"]` |
| C1-C | 重载活动分支 type 序列不含 `compaction`（压缩被合并行绕过） |
| C1-D | 盘上 dangling=2、重载上下文 2→0 |
| LAT-4 rewind+message | rewind 后新消息重启后消失 |
| LAT-4 resurrect | 被 rewind 甩掉的 turn 在冲刷后复活（rewind 被 marker 后的冲刷行静默撤销） |
| LAT-4 interleave+content | 交织双 target + mid-window message：dangling>0、内容丢失 |

绿（正控，改前即绿，改后仍绿）：C1-A-control（不同 verdict 照落）、LAT-4 control（连续窗口合并行数 ≤1+ceil(39/32)、childUsage 和守恒、全链可解析）、LAT-5 control（同 verdict 连发 4 次仅 1 行）。

改后：**12/12 绿**（0902 五用例 5/5 + 本席护栏 7/7，含新增"真实形状投影"：4 target×200 轮交织 + agent_status/user message 穿插 + 32-merge 窗口滚动 ⇒ dangling=0、重载文本序列==live、childUsage 盘上和==live 和）。

回归面（既有套件全绿）：lat3-transcript-bloat-coalesce(3) + agent-status + leaf-position-resume(14)；tree-traversal + build-context + session-state(57)；own-usage-attribution-fold + context-tree + entry-stats(21)。`tsgo --noEmit` EXIT=0；biome 三文件 clean。

## 3. 关键归因细节（给复审）

- **为什么 own-chain 字面修法不够**：C1-B 在 u2（message）落盘于窗口中间时，u2.parentId=当时 leaf=e2（仅内存）。若冲刷行 parent 取 target 自身链（e1/上一行），重载 walk `row→e2→e1→target` 会绕过 u2 —— ①-B 仍红。最近已落盘祖先规则把 row.parent 钉在 u2/compaction 本身上，walk `e3→u2→e2(row)→e1→target` 与 live 完全一致。
- **为什么 (B) 冲刷必须在 _appendEntry 顶部**：不冲刷则 u2 落盘时 parent 指向从未落盘的 e2 ⇒ 恒 dangling。冲刷后 e2 由 row 物化，u2.parent 可解析。
- **为什么 _setLeaf 冲刷必须在移 leaf 之前**：否则 settle 冲刷行落在 marker 之后成为末行，重载 leaf=合并行 ⇒ rewind 被静默撤销（LAT-4 resurrect 用例钉死）。
- **首条归因也要先冲**：并行子代理 B 的首条归因 parent 可能=A 的 deferred merge；不冲则 E1 自身 dangling（GLM 席真序列里 message 条目 dangling 的同族成因）。
- **开销**：每窗口切断点一行（≤目标数行）；`_nearestPersistedAncestor` 摊还 O(1)/merge（walk 只经过本窗口 merge + 自上一锚点以来的交织 merge，锚点即停）。20k 连续 merge 正控行数不变。

## 4. 交付物

| 产物 | 路径 |
|---|---|
| 修复（唯一源码改动） | `packages/coding-agent/src/core/session-manager.ts`（+~60 行：anchorId/deferredAttributionIds/nearestPersistedAncestor/5 处窗口切断/LAT-5 重置） |
| 0902 五用例红绿套件（常驻） | `packages/coding-agent/test/session-manager/r28-cluster1-interaction.test.ts` |
| 本席护栏（rewind 两变体 + 交织含内容 + 首条归因 + 连续窗口正控 + LAT-5 正控 + 真实形状投影） | `packages/coding-agent/test/session-manager/lat4-lat5-leaf-move-window.test.ts` |
| changelog fragment | `packages/coding-agent/.changes/r28-lat45-attribution-window.md` |
| 提交 | 分支 `r28/lat45-fixes` @ **a8b66837e**（基于 9866645e3，仅上述 4 文件，+538/-6）；主仓零写入、未 push |

复跑（≤60s/条，泄露 env 已 unset，直接 node 调 vitest）：

```
cd /tmp/audit_r/round-28/wt_impl/packages/coding-agent && env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_CHILD_ID   -u RLM_MAX_DEPTH -u PRIME_AGENT_DIR -u PRIME_AGENT_SESSION_DIR -u PI_API_KEY   -u PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR -u RLM_PARENT_NODE_ID -u RLM_CHILD_IDS   -u RLM_PARENT_SESSION_DIR -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN   node ../../node_modules/vitest/dist/cli.js --run test/session-manager/r28-cluster1-interaction.test.ts   test/session-manager/lat4-lat5-leaf-move-window.test.ts
```

改前红：把同命令跑在 9866645e3 干净树（stash 两个测试外的改动，或用 /tmp/r28_0902_own/wt_head 的同路径文件）。

## 5. 遗留/边界（如实）

- branch() 到"归因 merge 条目"本身（TUI 不提供的位置）：marker.targetId 可能仍指向未物化的 mid-window merge id —— 预存边缘，本次不扩大也不修。
- 崩溃丢 deferred 剩余 delta（≤31/目标）：LAT-3 既有取舍，未变。
- 共享目录破坏事件（0902 §13 报告的 /tmp 清空）：本席工作树迁至 `/tmp/audit_r/round-28/wt_impl`（母席 02:38 重建），所有实跑在新树上重做。


## 6. 收口验证

- pre-commit `npm run check`（biome --error-on-warnings 全仓 + tsgo + installer/browser-smoke/ci-honesty）EXIT=0 —— 含同工作树他席在飞改动（agent-session.ts / rlm-child-stream-scaling / r26-k3r-compact-merge，均非本席文件，未 staged）。
- 修剪树复验：`git archive a8b66837e` 提取 + symlink node_modules → `tsgo --noEmit` EXIT=0；两测试文件 12/12 绿。
- 分支：`r28/lat45-fixes`（/tmp/audit_r/round-28/wt_impl）；staged 逐文件核对＝恰 4 文件。
