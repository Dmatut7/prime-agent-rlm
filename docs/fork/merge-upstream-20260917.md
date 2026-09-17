# 上游合并文档 · 2026-09-17（DRAFT v0.3）

> 目标：把上游 `PrimeIntellect-ai/prime-agent` 自我们合并基线起的 136 笔提交中**对我们有好处的部分**安全地拿进本 fork（`Dmatut7/prime-agent-rlm` @ `merge/repl-kernel`），且**合并过程本身不出问题**。
> 状态：DRAFT。输入席回执陆续并入；§4/§6 与 UX 行待对应席位回执后填实。复核轮次见 §8。
> 输入：`/tmp/merge-doc-inputs/01-trial-merge-conflict-map.md`（试合并冲突地图，669 行）、上游 20 笔核心候选调研（母席存档：sub-b98ca323/upstream-20-survey.md）、欠账盘点 `/tmp/fork_unfinished_20260917.md`。

---

## 0. 摘要与决策（一页）

**合并策略：不做一次整体 merge，走分簇选择性合并。** 依据是试合并实测：215 个冲突文件 / 611 个冲突块（167 文本冲突 + 4 双方新增 + 44 个"上游删除而我们改过"的无标记裁决面），一把梭等于把 600 处人工裁决压进一个不可复核的提交。分簇后每簇独立红绿、独立回滚。

**拿什么（第一批，低风险小簇）**：#2307（collect/delete 吃 spawn handle，~20 行）、#2275（bash 工具层脏树保护，本仓并行道事故止血）、#2219（agent 起的 shell 非交互安全默认值，两处小改）、#2285（非交互 stdin 守卫，新文件逐字摘）、#2284（autonomous 续跑在子代理运行期挂起，autonomous.ts 近照抄）、#2310 限定范围（errored 会话不落 completed verdict，只摘两处核心）、#2246（孤儿 worker 有界回收，手工重接到我们的 deps 注入面）、#2242（持久 SupervisorLink，新文件直取+3 处重接）、#2426（中断后发送排队消息，手工重接+走我们协议号）、#1947（内核 stderr 落盘+有界尾，**已到期必做**，按"上游 pipe 机制 + 保留我们 0600/no-follow/rotate/诊断"重接）。

**改着拿（摘思路不照抄）**：#2152（显式 rlm.spawn：先加 spawn+name 必填+旧形态自愈报错，**暂不删 callable 垫片**）、#2313（catalog readiness：先做"等私有授权+重查一次"半条并统一三条恢复链）、#2276（只摘 append 守卫缓存半，fork 半我们更强不要碰）、#2330（MCP 服务目录+OAuth：只摘思路，上游自己回滚过一次）。

**不拿（我们已有或更超前）**：#2223 rlm.collect（我们超集：多 terminal_kind/stall_abort/activity_kind）、#2027 子树取消遍历（我们更超前）、#2151 waitForIdle park（我们多一道 disposal 护栏）、#2127 孤儿 toolResult（逐字同）、#2129 litellm 超限识别（我们超集）。**这五笔以后同步只对账、不重摘**，重摘会撞掉我们的扩展。

**no-take 白名单**：`prime-agent-runtime/**`（内核是我们核心资产，只挑上游 #2036 里的具体修复）、`packages/coding-agent/skills/**`、我们自研的 RLM 信封扩展位。

**冻结纪律**：合并窗口开前必须 (a) 主工作树 11 条在飞改动全部提交或撤回（其中 `openai-responses-shared.ts`、`coding-agent/package.json` 本身就是冲突文件）；(b) 冻结 core/daemon/providers/runtime 四条施工车道；(c) 取 freeze-sha 清单，窗口内只合清单内提交。

**工时粗估**：试合并席给 220–340 人时（全量）；分簇+只拿第一批可压到约 1/3，即 70–110 人时，其中承重四件（agent-session/repl-manager/session-manager/daemon-supervisor）占一半以上。

---

## 1. 基线与漂移现状

| 项 | 值 |
|---|---|
| 合并基线 | `d74a75fea`（2026-09-04/05 那次 `git merge upstream/main`，merge 提交 `3367d85c4`） |
| 上游 tip | `e2fb7bfa1`（send queued messages after interrupt #2426） |
| 上游新增提交 | 136 |
| 我们自基线起提交 | 963 |
| 版本 | 我们 `0.9.1`；上游已发 v0.9.2/3/4/5（tip 含 `a7d791bc1 prepare v0.9.5`） |
| 上游改动文件 | 684（新增 254 / 修改 168 / 删除 260） |
| 我们改动文件 | 1350（新增 936 / 修改 370 / 删除 0） |
| 双方都改 | 262（其中 auto-merge 成功 91、冲突 167+4） |
| 干净可拿（仅上游改） | 422 |
| 我们独有（仅我们改） | 1044 |
| 上游删除面 | 260，其中 44 个我们改过（UD，必须人工裁） |

一致性自检（试合并席）：422+262=684 ✓；1044+262+44=1350 ✓；216+44=260 ✓；167+4+91=262 ✓。

---

## 2. 试合并冲突地图（/tmp 独立 clone 实测，主仓只读）

复现口径见输入文件 §0（clone → fetch → `git merge --no-commit` → 记录 → abort）。

### 2.1 冲突按簇

| 簇 | 冲突文件 | 冲突块 |
|---|---|---|
| coding-agent/core | 33 | 153 |
| coding-agent/tests | 84 | 148 |
| coding-agent/daemon+cli | 12 | 57 |
| ai(providers/models) | 24 | 53 |
| coding-agent/modes(ui) | 13 | 53 |
| coding-agent/rlm+kernel | 8 | 51 |
| 其余（root/runtime/tui/ci/docs） | 41 | 96 |

### 2.2 最惹冲突的上游提交

`cf07c5a3f`（#2336 删死测试修竞态，碰 100 个冲突文件）＞ `844e85545`（#2028 持久化硬化，54）＞ `b9cf467ed`（#2068，28）＞ `2ce443175`（#2036 win/py，27）＞ `370c56235`（#2193 verbosity+clean ui，23）＞ `8a1e95800`（#2045 重试统一，21）＞ `b6ac5d014`（#2330 mcp catalog，20）。
**判读**：#2336 碰的大部分是测试文件——它的价值正是修 flake，与我们 CI 偶红面直接相关，应**优先吸收其测试修复**（见 §3 UX 行 #2336）；#2028/#2068/#2045 是 daemon/provider 大改，归入承重件处理。

### 2.3 承重四件与同题双解

| 文件 | 块 | 裁法要点 |
|---|---|---|
| `core/agent-session.ts` | 50 | 分三类：上游新增排队/快照/优先级语义取上游；我们 RLM/harness/refinement/subagent 面保我们；交集人工重写。**单一席位持牌**，完事 `test/suite/agent-session-*` 全绿 |
| `core/kernel/repl-manager.ts` | 17 | 上游 #2213 与我们 pipe 错误吸收是**同题双解**：取上游实现为底座，移植我们的步进补偿时钟+存活性 vouch；`spawnHidden`/`reapKernelOrphanProcesses` 与我们 bounded-wait 取并集 |
| `core/session-manager.ts` | 17 | 上游引入 `utils/atomic-file`，与我们自建写入路径职责重叠：**统一到上游 atomic-file**，把我们 torn-tail 语义移植进去；块 5/6 属同段两重写，取并集不拼贴 |
| `modes/daemon/daemon-supervisor.ts` | 15 | 取上游原子写工具；**保我们分级超时预算**（RLM 长任务核心资产）；锁/扫描串行化保我们 |

其余同题双解（必须择一，不能并存）：agents-view 节流器（我们 50ms vs 上游 75ms）、provider 重试框架（上游 #2045 vs 我们 retry-delay cap）、更新通道（#2323 vs 我们 update-restart）、mcp catalog（上游 revert 过）、rlm.collect（上游已吸收我们实现）。

### 2.4 生成物与删除面铁则

- `packages/ai/src/models.generated.ts`（14 块）**绝不手工合并**：先合 `scripts/generate-models.ts`（1 块人工并集）→ 重跑生成 → 逐条回放我们的私有模型/价格 override → `git diff` 除预期条目外无差异。
- 44 个 UD（上游删、我们改）逐个裁：默认接受删除，除非我们的修改承载了仍在用的行为（清单见输入文件 §4）。
- `package-lock.json` 不手改：`package.json` 人工并集后重装生成。
- 91 个 auto-merge 文件做了机械体检 0 命中，抽查 `edit.ts`/`google.ts`/`model-resolver.ts` 语义完好——但合并后仍要全量跑测（见 §6）。

---

## 3. 特性台账与取舍

### 3.1 核心面 20 笔（上游候选 × 我们有无）

| # | 上游 | 我们 | 结论 |
|---|---|---|---|
| #2426 中断后发排队消息 | 部分（缺 Esc 强制批） | 移植（手工重接，协议号用我们的 38） |
| #2282 子代理进度笔记+内核可见快照 | 部分（快照半我们更超前） | 移植（拆两步：先 note+名册 extras） |
| #2307 collect/delete 吃 spawn handle | 部分（delete 是逐字 pre-state） | 移植（最便宜，~20 行+2 用例） |
| #2152 显式 rlm.spawn | 无 | 只摘思路（加 spawn+自愈报错，暂不删垫片） |
| #2284 autonomous 续跑挂起 | 部分（goal 半自有） | 移植（autonomous.ts 近照抄） |
| #2223 rlm.collect | 有（超集） | 跳过（只对账） |
| #2027 子树取消遍历 | 有（更超前） | 跳过（只对账） |
| #2246 孤儿 worker 回收 | 无 | 移植（重接到我们的 deps 注入面） |
| #2242 持久 SupervisorLink | 无 | 移植（新文件直取+3 处） |
| #2151 waitForIdle park | 有（多一道护栏） | 跳过（只对账） |
| #2275 bash 脏树保护 | 无 | 移植（性价比最高） |
| #2334 人优先队列 | 部分（within-lane 无） | 移植（**先翻 QP-4 决策**再动） |
| #2219 shell 非交互默认值 | 无（白名单已挡继承半） | 移植（两处小改） |
| #2285 非交互 stdin 守卫 | 部分 | 移植（新文件逐字摘） |
| #2310 errored 不落 completed | 无 | 移植（限定范围，wire 延后） |
| #2313 catalog readiness | 无（前提机制缺） | 只摘思路 |
| #2127 孤儿 toolResult | 有（逐字） | 跳过 |
| #2129 litellm 超限识别 | 有（超集） | 跳过 |
| #2276 append/fork 热路径 | 部分（fork 半我们更强） | 只摘 append 半 |
| #1947 内核 stderr 落盘 | 部分（停在 09-02 老版） | **必做**（任务 B 触发条件已满足） |

### 3.2 UX/分发/成本面

（待 upstream-audit-ux 与 merge-specs-ux 回执填实。已知候选：#2330/#2323/#2241/#2243/#2228/#2193 族/#2145/#2218/#2153/#2166 族/#2336/#2098/#2130/#2308/#2309/#2251。）
其中两条母席已自核：#2336 的测试修复与我们 CI 偶红面直接相关，倾向**优先吸收**；#2193/#2180/#2182/#2183/#2179 UI 简化族与我们品牌 TUI 决定（footer 故意留空、subagents 行花费格）有正面冲突，倾向**不跟或改着跟**。

### 3.3 我们已超前、禁止重摘的五笔

#2223、#2027、#2151、#2127、#2129（证据见 20 笔调研第 6/7/10/17/18 条）。同步时只做对账：确认上游后续提交没有引入第二套遍历器/第二套信封。

---

## 4. 协议 / 版本 / 发布面

（待 merge-protocol 回执填实。已知约束：我们 `DAEMON_SCHEMA_REVISION=37`，头注写明 23-27 与 35 已撞号退役、取号前先读头注；上游在候选 20 笔里是 26/28/29 ⇒ **一律按我们号段重编（下一个 38），禁照抄上游 digest**。#2310 新增 `taskState:"error"` 枚举会让老客户端严格校验判整条 session invalid ⇒ 先分类/降级或 wire 延后。#2426 新命令需 capability gate。）

---

## 5. 合并执行方案（分簇、可回滚）

**P0 冻结与清场**：提交/撤回工作树 11 条在飞改动；冻结 core/daemon/providers/runtime 四车道；取 freeze-sha 清单；宣告 no-take 白名单。
**P1 干净面摘取**：422 个"仅上游改"文件按簇 cherry-pick（先测试修复簇 #2336/#2227/#2342，再 providers 小修簇，再 daemon 小修簇）；每簇跑包级测试+`npm run check`。
**P2 第一批功能移植**：§3.1 的 10 笔移植项，按"最便宜先"排序（#2307→#2275→#2219→#2285→#2284→#2310→#2246→#2242→#2426→#1947）；每笔独立提交、独立红绿、独立回滚把手；涉及协议的两笔（#2426/#2310）放最后并走 §4 流程。
**P3 承重四件**：agent-session → session-manager → repl-manager → daemon-supervisor，**每文件单一席位持牌**，裁法照 §2.3；每件完成后跑该包全量+pristine-tree tsgo。
**P4 删除面与生成物**：44 个 UD 逐个裁；models.generated 走 §2.4 流程；package-lock 重装生成。
**P5 协议与版本**：schema 取号 38、digest 重算与钉死测试更新、compat 矩阵测试补齐；版本是否跟到 0.9.5 单独决策（见 §4）。
**每阶段出口**：全量分片绿 + kernel/machine-wide/python 三专 job 绿 + pristine tsgo EXIT 0 + 对账三表无意外差异（见 §6）。

---

## 6. 验证矩阵与对账（输入：merge-gates 席，05/05a/05b）

### 6.1 验证阶梯（便宜到贵，合并窗口按此顺序按）

1. 便宜哨兵五条（先跑，能省一轮全量）：`test/daemon-protocol.test.ts`（schema digest）、`test/session-info-incremental-scan.test.ts`（增量==全量）、`test/suite/regressions/1229-snapshot-transfer-identity.test.ts`、`k3q-quiescence-degrade.test.ts`+`k3r-promote-failure.test.ts`（本地降级钉死件）、`packages/tui/test/editor-paste-filter.test.ts`（**只准空机跑**，墙钟断言满载假红）。
2. `npm run check`（biome+tsgo+installer+browser-smoke+ci-honesty）。
3. 单文件/包级 vitest（净化环境 `env -u RLM_*`）。
4. 全量三片（`test:ci`，注意排除项清单见 05 §1.2）。
5. 三专 job：kernel（**collected 数必须取真实 run 的 JSON，不能取 `vitest list`**——别名 describe 在 list/run 判定不一致，实测探针在 /tmp/mdi-05/p4-*.json）、machine-wide（**共享工作站禁跑**，它会 reap 同机其它 supervisor 并 kill 本机 daemon）、runtime python。
6. 纯净树 tsgo（`git archive HEAD | tar -x` + symlink node_modules + `tsgo --noEmit`，EXIT 必须 0）——冻结窗口没有钩子保底时，**这是唯一能证明"这批提交自洽"的机器门**（半提交对 pre-commit 钩子免疫）。
7. 真机手测 10 条（多代理、子代理花费格、daemon 重启恢复、压缩、/usage 对账等；入口清单待 05c 补，暂以 §6.4 对账表代替）。
8. CI 期望：全 job 绿；`scripts/latest-ci-run.sh --require-success` 问 GitHub 拿结论（不许凭记忆说绿）。

### 6.2 基线表（合并前必立，否则误记红）

同一份 HEAD 在**满载共享机**上实测已有已知红：tui 1 条墙钟红、ai 9 条环境红（05 §0）。合并窗口开始前先在同一机器跑一次全量立基线表（四数+红名单），合并后红名单只允许"基线内"或"有解释的新增"。

### 6.3 对账三表

1. **功能对账**：能力清单生成器（05a）已跑通——3045 条（cli-command 31 / cli-flag 45 / slash 37 / settings 键 / 文档标题 / protocol-info 等），合并前后各跑一次 diff 出 LOST/NEW/MOVED；**LOST 里出现 RED 类别即退出码 1**。判读：MOVED 永不改判词；噪声源过滤清单见 05a §5；盲区声明见 05a §6（清单不是全量能力面）。
2. **测试四数对账**：collected/passed/failed/skipped 四数对比（`--collect-only` 纪律），**SKIP 非 0 必须说明对照面为什么不在场**；kernel job 的 collected 取真实 run JSON（见 6.1.5）；分片非纯随机抽样，新增测试文件会改变每片地板命中，所以只看总绿不够。
3. **性能对账**：我们**没有 CI 性能门**（workflows 里 bench/perf/profile 0 命中）；基线只有 FORK_NOTES 2026-09-12 性能轮的手测数字 ⇒ 合并后同法背靠背复测（热档 Enter→聊天、账本重放、kill -9 锁恢复三项）。上游的 `scripts/benchmarks/` 是"PR vs main 信息性对比"且要 Prime sandbox key，**不构成我们的回归门**，只当差异化对比方法参考。

### 6.4 合并期专用闸（已存在，别重造）

- `npm run merge:preflight -- <branch>`：基点新鲜度 → 工作树有无别席未提交改动（有就拒跑）→ `merge --no-commit` → 扫"被吞掉的 main 侧改动"（SWALLOWED 拒跑）。**在施工 worktree 里跑，不能对着共享树跑。**
- `npm run preflight:push`：树必须等于 HEAD → 等 in-flight CI 结束（gh 不可用拒推）→ 本地闸 → 问 GitHub 该 revision 结论；已有非绿 completed run 拒推（除非 `PREFLIGHT_RED_REVISION_REASON`）。
- test-hygiene 闸判读：红在 baseline（32 文件/474 条冻结存量）之外 = **必须改测试，不是改闸**；上游新测试带私有探针会红，属预期提醒。
- digest 预期红处置：上游碰了被 hash 的 16 切片之一 ⇒ `daemon-protocol.test.ts:321` 必红；处置只有一条——取新 revision 号、由测试重算 digest、写回常量，**不许手写**；撞号账在 `daemon-protocol.ts:102-108`。

## 7. 风险登记册（初始）

| 风险 | 触发 | 探测 | 回滚把手 |
|---|---|---|---|
| 同题双解并存（两套节流/两套重试/两套原子写） | P2/P3 取并集时贪心 | 单测断言唯一实现 + grep 计数 | 该簇 revert |
| schema 取号撞车 | P5 照抄上游号 | digest 钉死测试 + 头注核对 | 号回退+重算 |
| 生成物手工合并污染 | P4 手改 models.generated | `git diff` 预期外差异 | 重跑生成器 |
| 工作树在飞改动被扫进合并提交 | P0 未清场 | 提交前 `git status` + `--only` 纪律 | 向前修新笔 |
| runtime 被误改 | 任何阶段碰 no-take 面 | 车道冻结+白名单 | 该笔 revert |
| 老客户端遇新枚举 invalid | #2310 wire 先行 | compat 矩阵测试 | wire 延后开关 |

---

## 8. 复核记录

- v0.1：母席总成（输入：试合并地图 + 20 笔调研）。
- v0.2：并入 debt/欠账盘点交叉引用（#1947 任务 B 到期、QP-4 待裁）。
- 待办：merge-protocol / merge-gates / audit-ux / specs-ux 回执并入 → 派 0902 与 K3 两席异构交叉复核（各抽 5 条结论回代码验真）→ v1.0 给老板。

## 附录 A · 输入与席位

- 试合并冲突地图：`/tmp/merge-doc-inputs/01-trial-merge-conflict-map.md`
- 上游 20 笔调研：`.../sub-b98ca323/upstream-20-survey.md`（+ /tmp/rlm-survey/batch1-4.md）
- 欠账盘点：`/tmp/fork_unfinished_20260917.md`
- 席位：merge-trial-map / upstream-audit-rlm / upstream-audit-ux / merge-protocol / merge-specs-core / merge-specs-ux / merge-gates / debt-batch-1
