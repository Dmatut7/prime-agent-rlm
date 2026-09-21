# 2026-09-21 官方拉取（R4 择取）＋ UI 改进 计划 v2

> v2 说明：三席审查（facts/exec/disc，报告 /tmp/r4_plan_review_*）共抓 红12/黄24，母席逐条亲核属实后全文重写。v1 的「车道文件面不相交并行」架构被证伪废弃；v2 改为「主干单席串行＋独立岛并行」。审查三报告与本文冲突处以本文为准（修复已入）。

## 0. 背景与总目标

- 上游 `PrimeIntellect-ai/prime-agent` 43 笔未取（09-17 一批、09-19 两笔、09-21 17 笔）。fork 相对 merge-base `e2fb7bfa` 已改 2058 文件。
- **吸收账（v2 修正）**：43 = **取 37** ＋ 缓取 3（`976ea1084` 沙箱脚本、`b09e37d84` ACP（且动共享 test/suite/harness.ts）、`63d88319b` Prime Inference GLM（与 `cc4a17379` 同改一测试文件））＋ **fork 已自研等价件跳过 3**（`6d2c57d72`＝fork `81f964022` 的 #2400 指纹去重、`7f39eb825`＝fork `0d353ae93` 的 #2392 IDF 排序、`ff40ea24e` 是 #2400 的测试笔）。跳过的三笔在拾取台账记「fork 已有」，其中 a8ae 系消费的 `harnessStateFingerprint` 符号 fork 侧已由自研提供。
- 同时欠一次 daemon 重启：GLM 坏调用修复（`cc4a17379`，已 build，dist mtime 21:40 实证）。
- 总目标不变：一次战役吸收 37 笔＋UI 四件＋GLM 修复激活，**两次重启窗**收口。

## 1. 价值表（三席复核通过，30+ 笔主题无误）

同 v1：上下文瘦身（`a8ae6269a` harness digest 只留最新）、压缩质量（`27f32ddb7`/`5fb3d9acb`）、限流停泊复活（`2883a7843`）、图路由（`3b1aa5ff3`）、重连（`2e9ab77b8`/`54da82e97`）、/speed（`eee9d814b`）、kernel 稳定（`c91e6e991` 等）、性能批（`0498deb43` 等）。

## 2. 冲突事实（v2：merge-tree 实测口径，废除 v1 的 src-only 交集法）

- v1 的 A/B/C 分级算法只算 src 级文件，**系统性低估**：逐笔 merge-tree 干跑实测 **41/43 有 1-12 处冲突，仅 2 笔干净**（`e1f4ae5bd`、`b09e37d84`）。本节分级只作风险参考，**施工口径一律以逐笔干跑为准**（命令：`git merge-tree $(git merge-base HEAD <sha>) HEAD <sha>`）。
- **连通分量实测**（40 笔候选按共享文件并查集）：**[32, 3, 1, 1, 1, 1, 1] 共 7 个分量**。32 笔主干分量互相焊死（`b08f08efa` 一笔同时动 agent-session＋repl-manager＋ipython）——**任何「文件面不相交」的车道切分在数学上不成立**。
- 独立岛（可与主干并行）：bootstrap 岛 {`1df880d81`、`d96a990b4`、`fc9f2ae24`}（v1 漏派 `fc9f2ae24`，且它夹在两邻笔之间共改 bootstrap.ts，**必须取**否则抬高邻笔冲突率）；孤点 {`c13e03113`（3 处冲突含 ci.yml，非零冲突）、`756a8ce83`、`7572880fe`、`d2cdb4504`、`e683fcb53`}。
- 特殊冲突形态（v1 全漏）：**7 笔撞 fork 已删文件（modify/delete）**——处理规则：该 hunk 若属 fork 有意删除（选择性合并决策）则弃 hunk 并记台账，否则重建适配；**3 处双新增撞名**（cron-jobs-state-snapshot.test.ts、heartbeats-list-response-latency.test.ts、.husky/pre-push）——合并内容或改名，禁直接覆盖。
- `1ae25148b` 动根 `package.json` 的 check 链（fork/upstream 已分叉）——手工并，并后必跑 `npm run check`。

## 3. 执行架构 v2：主干单席串行 ＋ 独立岛并行 ＋ 第一小时车道

### 全局铁则
1. **拾取序＝上游序**：一律按 `git log --reverse HEAD..upstream/main` 的顺序逐笔拾取（v1 清单顺序≈上游逆序，会产生 48 个「新先旧后」同文件对）。硬依赖实测：`6d2c57d72`（跳过，fork 已有）→ `a8ae6269a`（消费 fingerprint——fork 自研已提供符号，拾取时对账）；`5fb3d9acb` → `27f32ddb7`。
2. **主干单写者**：32 笔主干分量全程**一席**按上游序串行拾取，热文件（agent-session/session-manager/settings-manager/interactive-mode/repl-manager）天然独占——v1 的「9 笔仅 lane-core」承诺作废，改为「32 笔全在主干席」。
3. **岛席并行**：8 笔岛件给并行席（独立 worktree＋分支，node_modules 符号链零拷贝），完成后按其上游序位置合入主干（一次一条、每条并后全量 check）。
4. 每笔拾取流程：干跑 merge-tree 看冲突 → 手工落（含 modify/delete 与撞名规则）→ 定向测试 → 提交（独立 commit，单笔可 revert）→ 台账记一行（含「跳过 hunk/撞名处理/fragment 补否」）。

### 第一小时车道（先行窗，老板痛点优先）
分支上做、合入 main 后**第一次重启**：GLM 修复激活＋U4 降噪＋U1 水位条＋U2 错误警示＋`eee9d814b`(/speed)。
- 席内序（修正依赖倒置）：**`eee9d814b` 先拾**（它复活 fork 已删的 test/interactive-mode-command-usage.test.ts）→ U4 → U1 → U2。主干席后续遇到该笔＝已应用，跳过记台账。
- UI 测试一律**新建测试文件**（如 test/interactive-footer-telemetry.test.ts），不锚定上游文件名，消解 modify/delete 依赖。

### 战役主体
- 主干席：31 笔剩余主干件按上游序串行（`eee9d814b` 已先行）。
- 岛席：8 笔并行，错峰跑测试（同时最多 2-3 席跑全套检查）。
- 收口：全量 check＋净树 tsgo＋build → **第二次重启**收总账。

### 时间线（v2 诚实版）
- 今天第一窗（≈1 小时车道＋重启）：GLM 断根＋仪表盘＋降噪上线。
- 主干 31 笔串行 ×10-20 分钟/笔 ≈ 5-10 小时（含每笔测试门）＝**夜间主干席连跑**；岛席并行消化 8 笔。
- **明早收总账窗**（第二次重启＋全自证）。v1 的「3-5 小时 burst」承诺作废——32 笔焊死一坨是数学事实，并行救不了它；分支救的是「验证不排队」（岛＋第一窗），主干串行段只能靠时间换正确。

## 4. UI 四件（v2 修正）

- **U1 底栏水位条**：事实修正——/usage 是一次性 /context 报告非开关（v1 说错）；`components/footer.ts` 默认全空遥测属实。方案不变（模型名＋ctx 水位＋压缩线 80% 刻度＋GLM 风暴区标记），动刀 footer.ts＋top-bar.ts＋settings-manager.ts（新设置 footer.telemetry，默认 compact）。测试新建文件。
- **U2 工具错误警示**：动刀 `core/agent-session.ts`（**主干热文件——排进第一小时车道但必须在 `eee9d814b` 拾取后、且主干席启动前完成**，避免与主干双写；若时间不够，U2 降级到收总账窗前由主干席末班做）。
- **U3 agents-view 扩展**：现状修正——已有 running/idle/stall 标签与心跳，缺的是 settled/duration/answer 预览列；依赖 `2e9ab77b8` 先落（主干序内天然满足）。动刀 agents-view-mode.ts＋daemon roster 透出。
- **U4 降噪**：文件清单修正——v1 的 components/feature-hints.ts **不存在**；实际为 `modes/interactive/feature-hints.ts`＋`components/feature-hint.ts`，提示重复真源头是 `components/keybinding-hints.ts`（v1 漏）。其余四刀方案不变。验收＝改前后 tmux capture-pane 文本比对（行数降、正文占比升）。

## 5. 分工与纪律（v2 补齐 disc 席 8 黄）

- 席位：第一小时车道席（TUI 系）、主干席（31 笔串行）、岛席×2、对账看护席。全部 `bailian/glm-5.3-prime`＋thinking=max（老板令）。
- **glm-5.3-prime 家族护栏**（施工席必带）：上下文压 ≲35 万 token（compaction 早触发）、见连续 `Tool … not found` 立即换型（DS/0902）不等自愈、禁内联 sleep 轮询、每步落盘心跳、卡两轮换法。
- 仓规补齐：测试跑带 `env -u RLM_* -u PRIME_AGENT_*`（子席环境泄漏会写真 ~/.prime）；禁 `--no-verify`（等绿窗）；WIP 不进共享仓（worktree 内做到绿再合）；新测试文件单跑 `npm run check:test-hygiene`（它不在 check 链内）。
- fragment 归属：39/43 笔自带 fragment，随笔取；4 笔缺件由拾取席补；lockstep 战役期不发版、fragment 只积不折。
- daemon 协议义务：43 笔扫描仅 `54da82e97` 动线形状（errorInfo 增 update_restarting，向后兼容）——该笔拾取时按仓规补「分类＋兼容映射＋双向测试」三件，无 DAEMON_PROTOCOL_VERSION 升版需求（实测无笔改版号）。

## 6. 验收与回滚

- 每笔：干跑→落→定向测试→独立 commit→台账。每合流：全量 `npm run check`（全输出）＋净树 tsgo。
- **GLM 激活验证（v2 可操作版）**：①payload 捕获探针——用 packages/ai 测试同款 `streamSimple＋onPayload` 模式对 models.json 的 glm-5.3 模型带 tools 跑一单，断言 `params.tool_stream === false`；②重启后抽一场真 GLM 会话（带工具）＋当日按取证配方扫坏调用＝0；③连扫 7 天归零＝根治结案，复发＝当天上熔断（解析层非白名单名连发即断，埋点 recordToolCallDiagnostic 现成）。
- 回滚把手：单笔 revert；tag `pre-r4-sync`；U1 设置 off；models.json 删 toolStream 键；工作树用毕即清（/tmp 读数留尸按纪律不删）。
- 磁盘与内存防线（老板 2026-09-21 令）：哨兵每 15 分钟查水位（<15G 报、<10G 停工先清）；node_modules 符号链零拷贝；测试垃圾按窗清；子席产物收尾统一清；错峰跑测试。第一窗顺带回收 3-5G 历史垃圾（session-artifacts 6.6G 中的死会话＋/tmp 旧车道，留尸清单外）。

## 7. 风险登记（v2）

1. 主干 31 笔串行是唯一关键路径，无并行解——接受，用夜间连跑消化。
2. `a8ae6269a` 依赖对账（fork 自研 fingerprint 符号名可能不同）——拾取时若符号不匹配，按 fork 现名适配并记台账。
3. 7 笔 modify/delete＋3 处撞名——按 §2 规则逐笔处置，禁盲并。
4. `b6fb29850`（31 文件）放主干序末位，独立 commit，可整笔弃。
5. v1 的教训（写进方法论）：冲突分级必须 merge-tree 干跑，文件集交集法会漏非 src 面；车道设计前必须先算连通分量。
