# r30 · PROT-1/2 落地（impl-prot）

- 冻结：主仓 HEAD `ebfa8e094`（＝审计基线 `b7f26e98b` + 一笔 docs；开工时实测 HEAD，主仓只读零写入）
- 工作树：`/tmp/r30_prot`（分支 `r30/prot-fixes`，symlink node_modules），交付提交 `4df7e9b46`（5 文件 +280/−2）
- 红绿纪律：先红后绿四处（下详）；单命令 ≤60s（最长 `npm run check` 10.5s、daemon-mode 批 49.9s）；测试分批 ≤3 文件；vitest 直接 node 调且 unset 全部 19 个泄露 env；无 doctor/daemon ps 变体；仓库主仓零写入
- 报告顺序：先本报告后回话

## PROT-1（P3）· 55bae7c50 盲区守卫测试 + 头注诚实账

**守卫测试**（`test/daemon-protocol.test.ts` 新增 `replays the rev30 unbounded-to-bounded session-tree wire change as an identity change`）：
- 取证 55bae7c50 当时的 6 文件 diff 与其父 commit 的逐字形状：快照 wrapper `sessionTree` 从 `{tree; leafId}` 变为带 `bound?: SessionTreeDepthStats`（daemon-protocol.ts 的 DaemonSessionSnapshot、agent-connection/types.ts 的 AgentConnectionSnapshot 两处逐字验证）、`get_session_tree` 响应加 `treeBound`、session-manager 加 SessionTreeDepthStats/SessionFlatTreeStats 全家。
- 测试把该 diff 形状**反演到当前文本**（4 条变异：snapshotWrapper 块回退父 commit 逐字形状 / connectionSnapshotWrapper 同 / treeAssembly 删 `treeBound: bounded.stats,` / treeWire 删 `depthLimit: number;`），每条断言 16 切片 digest 必动（否则 F1 盲区重开）。
- **内置红证对照（rev30 配方）**：测试内重算 55bae7c50 当时仅有的三切片配方（command+savedSession+outbound，经 `git show 55bae7c50:...test/daemon-protocol.test.ts` 验证），断言同一批变异在该配方下 digest 纹丝不动＝盲区在测试里复现（对 snapshotWrapper 变异是同文件内三范围之外的真·历史漏检，非平凡构造）。
- **守卫有效性红证（跑过一次）**：临时从 digest join 删掉 `treeWire`（模拟切片被撤）→ 守卫测试红：`AssertionError: 55bae7c50: SessionTreeDepthStats.depthLimit leaves the wire: bound edit must change the schema identity: expected 'b516377fe675' not to be 'b516377fe675'` → 恢复后绿。
- **头注诚实账**：daemon-protocol.ts 头注新增 "Honest account of the digest gate's one documented miss (F1)" 段：55bae7c50 与其父 DAEMON_SCHEMA_ID 逐字相同（`protocol-7-schema-30-66299858b8b4`）、混对握手放行、~50 分钟后 a5edee5ee 才升 31、rev32/rev35 收口、守卫测试钉住。

## PROT-2（P4）

**① rev36 quiescence 降级路径测试**（新文件 `test/suite/regressions/k3q-quiescence-degrade.test.ts`，照 k3r-promote-failure 的 FakeTransport+DaemonAgentConnection+runPrintModeWithConnection 模式）：
- 场景：旧 daemon 声明 `rlm_quiescence_barrier`（rev18 起就有）但 `wait_for_headless_completion` 响应无 `rlmQuiescence` 字段（rev35/36 前形状）。
- 断言降级＝改前语义：客户端照发 `waitForRlmQuiescence: true` 请求、exit 0、无 "still running" stderr、正常拆台（`complete_owned_session` 照发）。
- 红证（缺测试的计数法＋变异法）：开工前 `grep -rln rlmQuiescence packages/coding-agent/test`＝3 文件且全部字段在场或内部 mock（k3r-promote-failure:105 字段在场、agent-session-recursion 内部 abort 集、daemon-protocol digest 文本），字段缺席降级用例＝0；另跑 fail-closed 变异（print-mode 把缺字段当 give-up：`!autonomousStatus.rlmQuiescence ||`）→ 测试红 `expected 1 to be +0` → 恢复后绿。

**② DaemonResponse 信封入切片 + bump 36→37**（照 rev35 先例）：
- 新第 16 切片 `responseEnvelope`：daemon-protocol.ts `[export type DaemonResponse =, export type DaemonSessionClosedReason =)`，覆盖信封（success/failure/error/errorInfo/retryAfterMs）+ 同族 `DaemonErrorInfo`；切片锚点断言（retryAfterMs/errorInfo 各 toContain）加进 "synchronized" 测试，identity 变异测试加第 7 条（responseEnvelope 字段集）。
- 先红：加切片后 `-t synchronized` 红 `expected 'protocol-7-schema-36-ba0805ab003a' to be 'protocol-7-schema-36-f14397289a30'` → bump `DAEMON_SCHEMA_REVISION = 37`、`DAEMON_SCHEMA_ID = "protocol-7-schema-37-f14397289a30"`（重算，禁手写）→ 绿。全仓 grep 无残留 rev36 硬编码（测试全用符号常量）。
- 头注照 35 合并先例登记 rev37（"extends the digest again, not the wire: the response envelope ... rev29 added response.retryAfterMs through exactly that gap"）。

**③ FORK_NOTES.md rev35 双 claim 撞号登记**：一览表新增本轮一行，内含撞号事实（`7409359a6`/digest `5100d7bec2ea` 与 `7a931c383`/digest `0632e2e54e98` 同晚各写 35、`34589648d` 跳 36 收冲突、"35 永久退役、取号前先读头注"）；daemon-protocol.ts 头注同步登记（含 "digests are distinct so the handshake still told them apart" 的诚实边界）。

## 验证台账（全绿）
| 批 | 文件 | 结果 |
|---|---|---|
| 1 | test/daemon-protocol.test.ts（改前基线 30/30） | 改后 31/31 |
| 2 | k3q-quiescence-degrade + print-rlm-quiescence-timeout + print-rlm-quiescence | 5/5 |
| 3 | k3r-promote-failure + agent-connection-daemon + daemon-client | 136/136 |
| 4 | daemon-mode + daemon-launch + daemon-agent-connection-reconnect-budget | 232/232（49.9s） |
| 5 | `npm run check`（biome+lint+tsgo 全套） | EXIT=0（10.5s） |
| 6 | 提交后纯净树复验：`git archive HEAD` + tsgo --noEmit | EXIT=0 |

biome 全部通过（新测试文件清了一条 unused import 警告后零告警）；pre-commit hook（`npm run check`）随提交通过。

## 提交
- `4df7e9b46` `fix(coding-agent): close the r30 protocol-chain PROT gaps (digest guard, envelope slice, quiescence degrade test)`：daemon-protocol.ts（rev37+头注三段登记）、daemon-protocol.test.ts（16 切片+守卫+变异）、k3q-quiescence-degrade.test.ts（新）、.changes/r30-prot-digest-envelope.md（照 rev35 的 r25-digest-coverage.md 先例）、FORK_NOTES.md（本轮行）。
- git add 逐文件、staged 清单核对＝恰 5 文件；无 amend/force/reset。

## 诚实边界
- 守卫测试的 treeWire/treeAssembly/connectionSnapshotWrapper 变异在 rev30 配方下不变属"配方根本没哈希这些文件"（历史事实本身）；非平凡红证靠 snapshotWrapper 变异（同文件、三范围之外）承担，注释已写明。
- rev37 是 digest-only（wire 形状零变更、无兼容表新条目）：DAEMON_OUTBOUND/COMMAND_COMPATIBILITY 无需动（r30 协议线已证两表空转是设计成立）。
- 降级测试只钉 text 模式 print 路径；json 模式的降级（无 run_outcome 事件）未单独钉（同族语义，留作后续可选）。
- 主仓 HEAD 开工后是否有新提交未再轮询（冻结点 ebfa8e094 之后主仓若移动，本交付仍基于 ebfa8e094 干净叠加）。
