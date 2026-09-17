# 上游合并文档 · 2026-09-17（v1.0）

> face: 主仓 HEAD=b0aeef69a @ 21:24；本版经 0902 与 DS 两席异构交叉复核并逐条修订（复核报告 review-qwen3.8-max-0902.md / review-deepseek-v4.1-flash.md）。每次改版更新本行。

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

**冻结纪律**：合并窗口开前必须 (a) **freeze-sha 时刻 `git status --porcelain` 必须为空**，时刻+sha 记进合并日志（在飞改动是移动靶：20:13 快照 11 条、21:05 实测 5 条、21:15 实测 6 条）；曾脏的 `openai-responses-shared.ts`、`coding-agent/package.json` 本身是冲突文件；(b) 冻结 core/daemon/providers/runtime 四条施工车道；(c) 取 freeze-sha 清单，窗口内只合清单内提交。

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
| 上游改动文件 | 944（新增 260 / 修改 424 / 删除 260）；净非删除面 684 |
| 我们改动文件 | 1350（新增 942 / 修改 408 / 删除 0） |
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
| coding-agent/core | 33 | 157 |
| coding-agent/tests | 84 | 157 |
| coding-agent/daemon+cli | 12 | 58 |
| ai(providers/models) | 24 | 53 |
| coding-agent/modes(ui) | 13 | 54 |
| coding-agent/rlm+kernel | 8 | 53 |
| 其余（root/runtime/tui/ci/docs） | 41 | 79 |

> 块数读数 @ `d268b1df3`（行首 `^<<<<<<<` 计法，含第 1 行冲突标记）；复核席独立复现一致。**窗口开启前必须在新 HEAD 上重立总账**（@77587dcab 已漂移到 217 文件/620 块）。

### 2.2 最惹冲突的上游提交

`cf07c5a3f`（#2336 删死测试修竞态，碰 100 个冲突文件）＞ `844e85545`（#2028 持久化硬化，54）＞ `b9cf467ed`（#2068，28）＞ `2ce443175`（#2036 win/py，27）＞ `370c56235`（#2193 verbosity+clean ui，23）＞ `8a1e95800`（#2045 重试统一，21）＞ `b6ac5d014`（#2330 mcp catalog，20）。
**判读**：#2336 碰的大部分是测试文件——它的价值正是修 flake，与我们 CI 偶红面直接相关，应**优先吸收其测试修复**（见 §3 UX 行 #2336）；#2028/#2068/#2045 是 daemon/provider 大改，归入承重件处理。

### 2.3 承重四件与同题双解

| 文件 | 块 | 裁法要点 |
|---|---|---|
| `core/agent-session.ts` | 50 | 分三类：上游新增排队/快照/优先级语义取上游；我们 RLM/harness/refinement/subagent 面保我们；交集人工重写。**单一席位持牌**，完事 `test/suite/agent-session-*` 全绿 |
| `core/kernel/repl-manager.ts` | 17 | 上游 #2213 与我们 pipe 错误吸收是**同题双解**：取上游实现为底座，移植我们的步进补偿时钟+存活性 vouch；并集符号以我方真实名为准：`spawnHidden` 上游独有取上游；`reapKernelOrphanProcesses` 两侧都有择一；我方有界等待不叫 bounded-wait（两侧 0 命中），持牌席先 grep 确认 |
| `core/session-manager.ts` | 17 | 上游引入 `utils/atomic-file`，与我们自建写入路径职责重叠：**统一到上游 atomic-file**，把我们 torn-tail 语义移植进去；**块 6（1930-2154）才是同段两重写**（双方各自定义同名 SessionScanState，先择一形状再迁语义，禁拼贴）；**块 5（1280-1392）是上游单边新增**（HEAD 侧空），取上游后再核与我们的 reachedBytes/torn-tail 是否重复 |
| `modes/daemon/daemon-supervisor.ts` | 15 | 取上游原子写工具；**保我们分级超时预算**（RLM 长任务核心资产）；锁/扫描串行化保我们 |

其余同题双解（必须择一，不能并存）：agents-view 节流器（我们 50ms vs 上游 75ms）、provider 重试框架（上游 #2045 vs 我们 retry-delay cap）、更新通道（#2323 vs 我们 update-restart）、mcp catalog（上游 revert 过）、rlm.collect（上游已吸收我们实现）。

### 2.4 生成物与删除面铁则

- `packages/ai/src/models.generated.ts`（14 块）**绝不手工合并**：先合 `scripts/generate-models.ts`（1 块人工并集）→ 重跑生成 → 逐条回放我们的私有模型/价格 override → `git diff` 除预期条目外无差异。
- 44 个 UD（上游删、我们改）逐个裁：默认接受删除，除非我们的修改承载了仍在用的行为（清单见输入文件 §4）。
- `package-lock.json` 不手改：`package.json` 人工并集后重装生成。
- 91 个 auto-merge 文件做了机械体检 0 命中，抽查 `edit.ts`/`google.ts`/`model-resolver.ts` 语义完好。**可复跑口径**：merge 态 clone 里对 91 文件逐个 `git diff HEAD -- <f>` 应只含上游侧 hunk（无双方交叠标记），再抽 3 个读合后关键段；合并后仍要全量跑测（见 §6）。

---

## 3. 特性台账与取舍

### 3.1 核心面 20 笔（上游候选 × 我们有无 × 工时）

完整移植规格见输入件 `/tmp/merge-doc-inputs/03-port-specs-core.md`，其覆盖 8 笔：#2275/#2334/#2220/#2307/#2129/#1947/#2282/#2276（含 /tmp clone 试 cherry-pick 实证）。**第一批里 #2219/#2285/#2284/#2310/#2246/#2242/#2426 七笔尚无逐笔规格，施工前必须补规格化**（复核席 R4）。下表为判读汇总：

| # | 上游 | 我们 | 结论 | 工时 | 关键风险/备注 |
|---|---|---|---|---|---|
| #2307 collect/delete 吃 spawn handle | 部分（delete 逐字 pre-state） | **已落地 `55c2530de`** | S | 纯加法；唯一破坏面是旧错误文案的一个测试断言，随测试改 |
| #2275 bash 脏树保护 | 无 | 移植 | M（TS，**已落地 b0aeef69a**）+Python 面在施（guard-complete 席） | TS 面 cherry-pick 实测 **1 个文件冲突 / 3 处冲突块**（+813 行新测试干净落地）；**内核 Python 的 `bash()` 上游也没护**，真正保护我们模型面的 Python 守卫单独立项在施 |
| #2219 shell 非交互默认值 | 无（白名单已挡继承半） | **已落地 `77587dcab`** | S | 两处汇聚点小改；别覆盖既有 NO_COLOR/TERM 面 |
| #2285 非交互 stdin 守卫 | 部分 | **已落地 `d06cac12f`** | S-M | 新文件逐字摘；250ms 空闲窗是行为改变，三处 TTY 门同批更新 docs |
| #2284 autonomous 续跑挂起 | 部分（goal 半自有） | 移植 | M | autonomous.ts 近照抄；agent-session 用我们 `_sessionInputArrivalEpoch` 重接 |
| #2310 errored 不落 completed | 无 | 移植（限定范围） | M | 只摘 terminalTurnError+idle 分支+owesErrorVerdict；wire 的 `"error"` 枚举延后（老客户端严格校验会判 invalid） |
| #2246 孤儿 worker 回收 | 无 | 移植 | M | 重接到我们 deps 注入面；闸门必须用 `isSessionActive || hasRunningRlmChildren()`，否则误杀长跑脚本 worker |
| #2242 持久 SupervisorLink | 无 | 移植 | M | 新文件直取+3 处重接；保留我们诊断/超时/pending-delivery 记账 |
| #2426 中断后发排队消息 | 部分（缺 Esc 强制批） | 移植 | L | 手工重接 ~50 行进 agent-session；协议号用我们 38；与我们 mutate_queued_message 语义需过一道审查 |
| #1947 内核 stderr 落盘 | 部分（09-02 fd 线） | **必做** | M | 任务 B 已触发；用上游 pipe+预算机制但保留我们 0600/no-follow/rotate/定位读 |
| #2220 精化不踢 prompt cache | 部分（auxiliaryModel 无） | **已落地 `918044273`** | S | 上游 catalog 11 行不移植（我们 provider 层已覆盖） |
| #2282 子代理进度笔记 | 部分（快照半我们更超前） | 移植（拆 4 子项） | L | D 子项触 daemon schema 37→38；activityStaleMs 与我们 stall 判据要对齐不并存 |
| #2276 append/fork 热路径 | 部分（fork 半我们更强） | 只摘 append 半 | M | 短写补齐漏点含 `packages/coding-agent/src/utils/private-files.ts:208` 等 4 处（勿与 packages/ai/src/utils/private-file.ts 混）；fork 半绝不照搬（会倒退原子性） |
| #2152 显式 rlm.spawn | 无 | 只摘思路 | — | 先加 spawn+name 必填+旧形态自愈报错，暂不删 callable 垫片 |
| #2313 catalog readiness | 无（前提机制缺） | 只摘思路 | — | 先做"等私有授权+重查一次"半条并统一三条恢复链 |
| #2330 MCP 目录+OAuth | 无 | 只摘思路 | — | 上游自己回滚过一次 |
| #2223 / #2027 / #2151 / #2127 / #2129 | 有（超集或逐字） | 跳过（只对账） | 0 | 重摘会撞掉我们扩展；#2129 本地 eeb282ad5 已逐字摘入 |

### 3.2 UX / 分发 / 成本面（双审计：规格席 04 + 审计席 audit-ux；分歧处母席裁决）

完整规格：`/tmp/merge-doc-inputs/04-port-specs-ux.md`（证据件 /tmp/ux-research/）；逐条等价性审计：audit-ux 回执（35 sha 全验、无一为我们祖先）。

**裁定汇总（04）**：拿 5（#2243 / #2228 / #2308 / #2218 / #2179）；改着拿 8（#2241 先拿 Python `harness.search`、#2098、#2130、#2336 分刀 C7→C5→C1→C3、#2182、#2183、#2193 两刀、#2153、#2145 残余 3 小件、#2251 只摘 5 行）；不拿 4 组（#2323 含 4 个 DU、#2140 族 5 个、#2309、#2330 整笔只摘 8 思路）。

**audit-ux 增补的take项（04 未覆盖）**：#2226（kernel 侧文件编辑进压缩摘要——我们 `<modified-files>` 恒空，1 个非重度文件+改注释与测试口径）；#2215（goal 记账跨摘要单调——我们 2597 行无条件覆盖盘上态，更易踩）；#2336 的 **4 处生产竞态修复**单开一笔（stopHiddenSupervisors 循环头缺 assertAdmission、renewUnderGuard 读不到≠被抢、installAgentTraceUpload 无 settle 句柄、npm-native-bridge 无 child 守卫——**我们一处都没有**，且前两处正是我们 r42/r43 flake 台账的形状）；#2153 做"一个目录、两个入口、旧入口转调"（**不照抄删除**：AGENTS.md 与既有席面都在用 agent_message.list_agents）。

**母席裁决（两席分歧处）**：
- **#2309**：04 判不拿（前提休眠：无 Prime Inference 凭据、runtime 无 `create_session`，enable_thinking 失败类已被 d9359a94c 四态在更通用层修掉，残余代价≈0）、audit-ux 判拿（12 行 n=3，buildFallbackModel 仍继承 zai thinkingFormat）。**母席终裁：休眠登记、本窗不拿**——码在场但前提休眠，拿了是死面；待我们引入 `create_session` 或 Prime Inference 凭据时随该面一起拿（记入 §3.1 休眠台账）。
- **#2193/#2183/#2180 族**：04 判改着跟两刀、audit-ux 判跳过（与我们自加键位 app.subagents.focus/app.heartbeats.open 同键位面冲突）。**裁：本轮只拿 #2179（通知简化）与 #2182（pickers 内联）；#2193/#2183/#2180 跳过，合并后单开键位面评审再议。**
- **#2130**：04 判改着拿 M、audit-ux 判只摘 1024 下限。**裁：只摘 1024 下限+响亮失败守卫**（整体保留我们 issue-19 轮的"非 reasoning 保 JSON 输出预算"决定，避免把修好的洞重新打开）。
- **#2217**：两席一致跳过（我们 5a0130c60 已更好），仅记账"上游把 marker 计入预算"一点。
- **#2145**：两席一致我们主体已有，只搬残余 3 小件。

**#2098 量化与三刀方案（08 号件，provider 侧实测）**：31 天 / 137 个 root 会话 / 35,628 次请求，**精化落地导致的前缀缓存全量作废 = 290.4M token 重付（占全价输入 32.5%）**，有价模型实测 **$193.32/31 天**（= 全价输入支出 $888 的 21.8%）；把未计价 kimi-k3（43% 请求）按代理价补上为 **$242–440/月**。放大倍率约 200x：一次精化只传 ~2.4K token 的 digest 变化，却按全价重付 390K–617K token 整条前缀。字节面同向：单次 apply 作废 47,330 B = 76.1% 前缀，静态化后 0 B、提示 62,181→50,816 B、省 30-35ms/次读盘。**排序硬约束**：#2241 二期（相关性排序 digest）若先上，缓存命中率从实测 94.3% 掉到接近 0，同批会话 prompt 账单 $3,019→**$14,976（5.0x）**——故 #2098 必须先于它。三刀＝① digest 出系统提示+冷边界投递 ② 删空转重建+notice 并入我方 outcome 渲染（**保 MV-5 被拒条目可见**，取代 v1.0 的「notice 裁剪去重」裁法）③ 测试+5 pin+成本正控（cache_read/cache_creation 背靠背读数）。**最大风险（效果面，老板硬约束）**：长会话记忆菜单冻结⇒重复建记忆、新记忆下一轮不可见——这是**效果退化**不是成本问题，故冷边界投递只作兜底，主路径必须是 **material-change 再注入**（digest 哈希变化超阈值即追一条 in-context delta，append-only），验收加两条 pin：新记忆下一轮可见、重复建记忆不发生；详见 §10。排期在 P2 ②。**验收前置（R3）**：立项前先落一组背靠背 provider 读数（同会话同 prompt，harness 状态清空 vs 满载，读 cache_read/cache_creation input tokens），否则 L 档投入无法验收。

**执行序（合并后 P2 内，按性价比×依赖）**：① S 级立刻：#2243 → #2228（**已落地 84559b825**）→ #2308 → #2336-C7（**已落地 0f02b089f**）→ #2218（**已落地 d5f0dbad4**）→ #2251 5 行（**已落地 d65f2f5e2**）；#2309 **裁撤为休眠登记**（见 §3.1 行：无 Prime Inference 凭据且无 create_session 面，前提休眠，待该面出现再拿）；② 成本止血：#2220（auxiliaryModel 一条缝）→ #2098（单独立项，**不 cherry-pick**，34 文件含 session-manager n=45；我们 1139 条全局记忆使每轮 refinement 都在逐出整条前缀缓存）→ #2241 Python 半；③ 质量面：#2336 4 竞态 → #2215 → #2226 → #2130 下限 → #2179/#2182；④ 名册：#2153 自实现双入口；⑤ 二期：#2241 query 排序（必须排 #2098 后）、#2145 残余。

**CI 偶红面对账（audit-ux 交叉印证）**：上游 #2336 删的 249 个测试文件里 **243 个我们还在跑**（1796 条用例，213 个文件无 key 门控真在 shard 里）；548 条 `retry:` 我们一条没清；我们 ci.yml ai job 自注的 19 个 live-provider 文件与上游删的 17 个指向同一堆死重。**删测试走我们自己的 r42 flake 台账**（65 个被删文件我们有自绘钉子），不整族跟删。

### 3.3 我们已超前、禁止重摘的五笔

#2223、#2027、#2151、#2127、#2129（证据见 20 笔调研第 6/7/10/17/18 条）。同步时只做对账：确认上游后续提交没有引入第二套遍历器/第二套信封。

---

## 4. 协议 / 版本 / 发布面（输入：merge-protocol 席，02 号文件）

### 4.1 上游三笔协议改动（全兼容）

| 提交 | wire 变化 | 分类 | 注意 |
|---|---|---|---|
| `844e85545` #2028 | `DaemonErrorInfo` 加 `session_recovering` 变体 | 向后兼容（加性） | 上游踩 digest 盲窗（26→27 同 ID，wire 变身份不变）；要其行为需整批 #2028（105 文件），只摘协议行会得到永不产生的错误码 |
| `163dd5798` #2148 | saved-session 行加可选 `model` | 向后兼容 | digest 正确移动 |
| `e2fb7bfa1` #2426 | 新命令 `abort_and_send_queued` + capability | capability-gated 兼容新增 | 教科书式写法（先查 capability、再兜 unknown-command fallback）；**其 schema ID 是手写的**（上游已删 digest 测试） |

### 4.2 取号：跳 38

27/28/29 现在与 23–26 一样"同号不同 wire"（双方各自占用过），30–37 是 fork 独占段，35 已退役 ⇒ **合并后 `DAEMON_SCHEMA_REVISION = 38`**；头注按既有格式登记上游 27/28/29 的含义与 schema ID 尾（`962b8b4c5e35`/`92bc5368a082`/`a5c9d20f8b13`，并注明 29 的 ID 未经机验）。`abort_and_send_queued` 兼容表项 `minSchemaRevision` 29→**38**（保留 29 会让 rev29 旧 fork daemon 被误判够格）。`DAEMON_PROTOCOL_VERSION` 双方都是 7，本窗不动。

### 4.3 digest：我们 16 切片正好兜住上游三笔

逐片对账：command（e2fb7bfa1）、savedSession（163dd5798）、responseEnvelope 第 16 片（844e85545 的 `DaemonErrorInfo` 落在本片区间）——三笔 1:1 落进我们三片；**上游自己 rev26→27 的盲窗在我们的食谱下必然动 digest**（第 16 片立功）。重算流程：改号 38 → 跑 `test/daemon-protocol.test.ts` 身份断言（:267）拿红出的新 digest → 写回 `DAEMON_SCHEMA_ID`，**禁手写**。合并该测试文件**绝不可接上游 cf07c5a3f 的删法**（它删了 digest 自校验）；冲突一律取我们侧（超集），只补 gates 表新行。
5. **P5 出口机器正控**：断言合并后的 `test/daemon-protocol.test.ts` 仍含身份同步 it 块与切片防空守卫（:324）/rev30 回放守卫（:423）——该文件本身是 84 测试簇冲突文件之一，误接上游删法会让重算机制静默消失（复核席 R2）。已知小缺口**本窗裁决：补**——连接侧 `AgentConnectionSavedSessionInfo.model` 入 digest（新增切片进 rev38），避免 rev38 之后再开 39（复核席 R6 独立复核偏移属实）。

### 4.4 版本与发布面

**跟到 0.9.5**（五包 lockstep bump 0.9.1→0.9.5）：FORK_NOTES:211 早已定调"下一轮同步再跟"；对齐后 version-check 不再每次启动提醒升级到不含 fork 特性的官方构建；窗尾超出 0.9.5 的提交在 FORK_NOTES 如实写一句，不发明 0.9.6。
**必须跟**：仅四笔 release 提交的版本号+CHANGELOG 折叠（随合并自然进入）。
**风险登记（R1）**：`.github/workflows/build-binaries.yml` 在我们树里是**活体**（on: push main / tags v* / dispatch，含 publish job），origin 上从未跑过（gh run list 空）。裁：本窗不动它，但**禁止在 origin 推 `v*` 标签**直到 native 车道裁决完成，否则会用一条缺上游三笔修复的车道发发布构件。
**不该跟**：`dd760d310` install.sh 编译安装默认化（官方二进制不含 fork 特性，冲突取我们侧 `b69ece1a5`/`ce86f2092`）；整条 native-binaries 车道（#2166/#2165/#2344/#2265/#2361/#2248/#2319 + 上游独有测试，我们不发 native 构件）；`4bf122bb6` /nightly 通道。**别给版本号加 `-beta` 后缀**（会把 version-check 切到 beta.json 通道，version-check.ts:101-104）。#2370 manifest 前向兼容**不适用**（我们不解析 `binaries`），记"已评估、不适用"。
**遗留风险登记**：`DEFAULT_PRIME_AGENT_DOWNLOAD_BASE_URL` 仍指上游 bucket，npm 全局安装的用户 `update` 会装回官方版；**裁决提前到 P5 同窗**（bump 后日常升级提醒消失＝唯一提醒也消失）：禁用自更新提示或文档明示。

### 4.5 兼容矩阵与待补测试（5 组）

我们把 schema identity 做成硬门（`judgeDaemonReuse` 任一不符即 replace；忙碌 stale daemon 拒绝替换），所以混合版本对大多走替换/拒绝，真正跑 degradation 的只有同身份对。待补：① gates 表新行+默认广告断言（不补就红）；② 移植上游 e2fb7bfa1 两条 abortAndSendQueued 用例（无 capability 退化 / unknown-command fallback）；③ 新命令进服务端强制声明面正控；④ 未知 errorInfo code 旧客户端降级正控；⑤ busy stale daemon 拒绝路径针对本次身份跳的回归。

## 5. 合并执行方案（分簇、可回滚）

**P0 冻结与清场**：提交/撤回工作树 11 条在飞改动；冻结 core/daemon/providers/runtime 四车道；取 freeze-sha 清单；宣告 no-take 白名单。
**P1 干净面摘取（机制=路径级 take，不是整笔 cherry-pick）**：输入件 06 实测三条硬事实——整笔 cherry-pick 只有 16/136 套得上（且其中 13 笔是标红提交）；7 个簇按上游序连摘**全在第 2 笔断**；而路径级 take（`git checkout upstream/main -- <paths>` + 上游删除走 `git rm`）**638 路径 0 冲突 0 触我方文件**。三层过滤后净面 **243 路径**（T1 可立即摘 166 / T2 与 P2 特性绑定 77）：干净面 638 剔"不跟族"304（mcp 43 / native 38 / #2336 删测 189 / 其它 34）、挂账混产 91（**逐文件裁决**：同文件多段可逐 hunk 定内容，但落地必须整文件提交——本仓 pre-commit 钩子对每个 staged 路径从工作树重加，index/hunk 级分离不可用；同一文件不得两席同时在飞）。7 簇＝providers／daemon内核／ui／测试／docs／CI／杂项；标红移出 119/136 笔（附录 B 全表，其中 51 笔只命中我方 1-2 个文件）。**更正**：#2336 在干净面里没有"修竞态"部分（仅 check-test-policy.mjs + 4 个 .changes），四处生产竞态修复在冲突面 ⇒ 归 P2 手工新笔。每簇出口：包级测试 + `npm run check` + 纯净树 tsgo。口径对账：638 = 422 非删除 + 216 干净删除（删除走 `git rm`），§1 的 422 与本节 638 是同物两口径。
**P2 第一批功能移植**：按"最便宜先"排序（#2307✓→#2275→#2219✓→#2285✓→#2284→#2310→#2246→#2242→#2426→#1947），**并补三个执行槽位**：#2334（QP-4 已裁全量移植，M）、#2276 append 半（M）、#2282（L，**其 D 子项触 daemon schema 37→38，挂进 P5 流程**）；#2220 已落地不再排。每笔独立提交（`git commit --only -- <paths>`）、独立红绿、独立回滚把手；涉及协议的（#2426/#2310/#2282-D）放最后并走 §4 流程。
**P3 承重四件**：agent-session → session-manager → repl-manager → daemon-supervisor，**每文件单一席位持牌**，裁法照 §2.3；每件完成后跑该包全量+pristine-tree tsgo。
**P4 删除面与生成物**：44 个 UD 逐个裁；models.generated 走 §2.4 流程；package-lock 重装生成。
**P5 协议与版本**：schema 取号 38、digest 重算与钉死测试更新、compat 矩阵测试补齐；版本是否跟到 0.9.5 单独决策（见 §4）。
**每阶段出口**：全量分片绿 + kernel/machine-wide/python 三专 job 绿 + pristine tsgo EXIT 0 + 对账三表无意外差异（见 §6）。**并执行 AGENTS.md 合并纪律四条**：禁 amend/force-push（补内容一律新提交）、提交一律 `git commit --only -- <paths>` 点名、**冲突回执表逐块记录（块号/取谁/理由/翻回把手；承重四件 99 块优先）落审查报告**、钩子红时等绿窗且任何情况禁 `--no-verify`（冻结期别席 WIP 会让全仓检查变红）。

---

## 6. 验证矩阵与对账（输入：merge-gates 席，05/05a/05b）

### 6.1 验证阶梯（L0→L11，便宜到贵；完整表见 05 号输入件，含每级命令/期望/代价/红了意味着什么）

1. 便宜哨兵五条（先跑，能省一轮全量）：`test/daemon-protocol.test.ts`（schema digest）、`test/session-info-incremental-scan.test.ts`（增量==全量）、`test/suite/regressions/1229-snapshot-transfer-identity.test.ts`、`test/suite/regressions/k3q-quiescence-degrade.test.ts`+`test/suite/regressions/k3r-promote-failure.test.ts`（本地降级钉死件，在 regressions 目录下）、`packages/tui/test/editor-paste-filter.test.ts`（**只准空机跑**，墙钟断言满载假红；跑法 `cd packages/tui && node --test --import tsx test/editor-paste-filter.test.ts`——tui 包无 vitest JSON，照 vitest 字面会空跑）。
2. `npm run check`（biome+tsgo+installer+browser-smoke+ci-honesty）。
3. 单文件/包级 vitest（净化环境 `env -u RLM_*`）；**packages/tui 走 `node --test --import tsx test/*.test.ts`，无 vitest JSON**（其 vitest include 仅 wrap-ansi）。
4. 全量三片（`test:ci`，注意排除项清单见 05 §1.2）。
5. 三专 job：kernel（**collected 数必须取真实 run 的 JSON，不能取 `vitest list`**——别名 describe 在 list/run 判定不一致，实测探针在 /tmp/mdi-05/p4-*.json；**kernel 没有手动重启命令**，command-registry 无 kernel 子命令，只能随 daemon 重启）、machine-wide（**共享工作站禁跑**，它会 reap 同机其它 supervisor 并 kill 本机 daemon）、runtime python。
6. 纯净树 tsgo（`git archive HEAD | tar -x` + symlink node_modules + `tsgo --noEmit`，EXIT 必须 0）——冻结窗口没有钩子保底时，**这是唯一能证明"这批提交自洽"的机器门**（半提交对 pre-commit 钩子免疫）。
7. 真机手测 10 条（入口清单见 `/tmp/merge-doc-inputs/05c-manual-test-entrypoints.md`）。**前置：手测前必须 build 或 `./prime-agent.sh` 并重启 daemon**——`prime-agent` 跑的是 bundle 不是工作树（05c 实测两个 buildId 不同）。
8. CI 期望：全 job 绿；`scripts/latest-ci-run.sh --require-success` 问 GitHub 拿结论（不许凭记忆说绿）。

### 6.2 基线表（合并前必立，否则误记红）

同一份 HEAD 在**满载共享机**上实测已有已知红：**ai 9 条**（5 条 stream + 1 条 overflow-Ollama + 3 条 cache-retention 假代理 30s 超时，均单跑可复现）与 **tui 1 条**（editor-paste 墙钟：满载 114.7ms vs 单跑 18.9ms）。合并窗口开始前先**同机同刻**跑一次全量立基线表（四数+红名单；复核席只复现了 cache-retention 3 条与 editor-paste 1 条，其余 6 条依赖凭据/网络语义，**不得照抄 05 的 9+1**）。**负载定义（R4）**："满载"＝20 个 `nice -n 19` 纯 CPU 进程（1 分钟负载 10.7→14.0，10 核机）；tui 墙钟断言在阈值附近抖动（实测 96.35ms 绿 / 103.39ms 红）⇒ 该条单列为**环境红**，不作合并后红名单的免罪口。合并后红名单只允许"基线内"或"有解释的新增"。

### 6.3 对账三表

1. **功能对账**：能力清单生成器（05a）已跑通——3045 条（cli-command 31 / cli-flag 45 / slash 37 / settings 键 / 文档标题 / protocol-info 等），合并前后各跑一次 diff 出 LOST/NEW/MOVED；**LOST 里出现 RED 类别即退出码 1**。判读：MOVED 永不改判词；噪声源过滤清单见 05a §5；盲区声明见 05a §6（清单不是全量能力面）。
2. **测试四数对账**：collected/passed/failed/skipped 四数对比。**vitest 5 没有 `--collect-only`**（实测 CACError）：collected 取 `vitest list --json`（实测 4.4s / 6910 tests / 672 files），但 **kernel job 的 collected 只认真实 run 的 JSON**（别名 describe 在 list 漏、run 命中）；闸语义注意：test-hygiene/platform 闸不管 failed，标签过滤让 skipped 变大而非 collected 变小；**SKIP 非 0 必须说明对照面为什么不在场**；分片非纯随机抽样，新增测试文件会改变每片地板命中，只看总绿不够。
3. **性能对账**：我们**没有 CI 性能门**（workflows 里 bench/perf/profile 0 命中）；基线 = 6 个 before/after 指标 + 3 个当年没修好的残留数字（FORK_NOTES 2026-09-12 性能轮；**残留三项单独记，别与 6 指标混**）⇒ 合并后同法背靠背复测。对账脚本副本在 `/tmp/merge-doc-inputs/05-tools/`。上游的 `scripts/benchmarks/` 是"PR vs main 信息性对比"且要 Prime sandbox key，**不构成我们的回归门**，只当差异化对比方法参考。

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

## 附录 B · 标红移出全表

见输入件 `/tmp/merge-doc-inputs/06-p1-clusters.md` 附录 B（119/136 笔逐笔表，其中 51 笔只命中我方 1-2 个文件）。

## 附录 A · 输入与席位

- 试合并冲突地图：`/tmp/merge-doc-inputs/01-trial-merge-conflict-map.md`
- 上游 20 笔调研：`.../sub-b98ca323/upstream-20-survey.md`（+ /tmp/rlm-survey/batch1-4.md）
- 欠账盘点：`/tmp/fork_unfinished_20260917.md`
- 席位：merge-trial-map / upstream-audit-rlm / upstream-audit-ux / merge-protocol / merge-specs-core / merge-specs-ux / merge-gates / debt-batch-1 / port-batch-S / S2 / S3 / guard-complete / merge-review-0902 / merge-review-ds / merge-2098-plan / merge-adjudicate / merge-p1-clusters
- ** caution**：复核席两个取证 clone（/tmp/mr0902-clone 停 merge 冲突态、/tmp/mr0902-cp 停 cherry-pick 冲突态）复用前必须 `git merge --abort` / `git cherry-pick --abort`

---

## 附录 A · 输入与席位

- 试合并冲突地图：`/tmp/merge-doc-inputs/01-trial-merge-conflict-map.md`
- 上游 20 笔调研：`.../sub-b98ca323/upstream-20-survey.md`（+ /tmp/rlm-survey/batch1-4.md）
- 欠账盘点：`/tmp/fork_unfinished_20260917.md`
- 席位：merge-trial-map / upstream-audit-rlm / upstream-audit-ux / merge-protocol / merge-specs-core / merge-specs-ux / merge-gates / debt-batch-1 / port-batch-S / S2 / S3 / guard-complete / merge-review-0902 / merge-review-ds / merge-2098-plan / merge-adjudicate / merge-p1-clusters
- ** caution**：复核席两个取证 clone（/tmp/mr0902-clone 停 merge 冲突态、/tmp/mr0902-cp 停 cherry-pick 冲突态）复用前必须 `git merge --abort` / `git cherry-pick --abort`

---

## 附录 A · 输入与席位

- 试合并冲突地图：`/tmp/merge-doc-inputs/01-trial-merge-conflict-map.md`
- 上游 20 笔调研：`.../sub-b98ca323/upstream-20-survey.md`（+ /tmp/rlm-survey/batch1-4.md）
- 欠账盘点：`/tmp/fork_unfinished_20260917.md`
- 席位：merge-trial-map / upstream-audit-rlm / upstream-audit-ux / merge-protocol / merge-specs-core / merge-specs-ux / merge-gates / debt-batch-1 / port-batch-S / S2 / S3 / guard-complete / merge-review-0902 / merge-review-ds / merge-2098-plan / merge-adjudicate / merge-p1-clusters
- ** caution**：复核席两个取证 clone（/tmp/mr0902-clone 停 merge 冲突态、/tmp/mr0902-cp 停 cherry-pick 冲突态）复用前必须 `git merge --abort` / `git cherry-pick --abort`

---

## 9. 裁决记录（裁决席 07 号件 + 母席拍板，2026-09-17）

| 项 | 裁决 | 依据/退路 |
|---|---|---|
| QP-4 × #2334 | **全量移植**：人优先仅限 lane 内，机器互序不变 | 跨 lane 形态被上游测试钉死；退路＝仅 interactive 提权→则该笔 no-take |
| C18 daemon 崩溃策略 | 追认 log-and-isolate，阈值 off（0 触发） | 现状零触发，追认成本最低 |
| C12 replay 真缓冲环 | 追认缓行 | 先对账 775 条/天 gap；环挂在 recover 成本上，不单独做 |
| C21 混版窗终态 | 维持协商式 | bump 挂 v5，本窗不动 |
| catch-up 放弃→踢下线 | 本窗不移除 | 移除会改运维语义，留待独立窗口 |
| F18 两暂认值（venv.old=1 / 收养 create=300s） | 均追认 | 实测无不良反应，追认即闭环 |


---

## 10. 效果护栏（老板硬约束 · 2026-09-17 · 优先级最高）

**优先级序：模型效果 > 成本 > 工程量。** 任何省钱、重构、移植动作与效果冲突时，效果赢；本节约束凌驾 §3/§5 的取舍。

1. **效果正控门槛**：凡改动模型可见上下文（系统提示、harness digest、refinement 回执、skill/记忆注入、思考档位、输出预算），必须带"改前/改后行为对照"正控：同任务同输入，断言模型可见面不缩水（记忆条目可见、skill 指引可见、被拒 refinement 条目可见、思考预算不被 JSON 吃光）。正控红＝回滚，不接受"成本绿了就行"。
2. **#2098 专项**：digest 出系统提示后，新记忆/新 skill/新 harness 状态必须**下一轮模型可见**——主路径 material-change 再注入（append-only delta），冷边界（新会话/压缩/resume）只作兜底；长会话禁止出现"记忆菜单冻结"。
3. **已落地项效果面复核结论**：#2220 的 auxiliaryModel 默认未设置⇒精化两趟仍用会话模型，行为不变（若显式设置便宜模型则精化质量降，属显式选择，设置界面需注明）；#2130 只拿 1024 下限、保留"非 reasoning 保 JSON 输出预算"，不削弱；#2218/#2275/#2243/#2228/#2308/#2285/#2219/#2307/#2251/C7 均不碰模型可见面（UI/计数/守卫/错误文案）。
4. **合并窗口**：上游 UI 简化族（#2193/#2183/#2180）本轮不跟的理由之一即效果/口味面风险；#2098、#2241 排序类改动一律先过效果正控再谈成本收益；§3.2 的成本数字只作排序依据，不作砍功能依据。
