# 上游合并文档 · 2026-09-17（**v1.1** 刷新 · 2026-09-18 上午）

> face: 主仓 `merge/repl-kernel` HEAD=`d51118e32` @ 2026-09-18 09:42（本地 = `origin/merge/repl-kernel`，`git ls-remote origin merge/repl-kernel` 实测同 sha）。v1.0 的 face 为 `5adf6410a` @ 07:07，并已过 0902 与 DS 两席异构交叉复核（review-qwen3.8-max-0902.md / review-deepseek-v4.1-flash.md）。**v1.1 只刷 §9 已落地清单 / §9.2 待办 / §10 验收七条状态与正控例数口径，机制面文字不动**；每次改版更新本行。
> **终版 sha 链（全链已推 `origin/merge/repl-kernel`）**：`67334bf1a`（merge，第二父本 upstream `e2fb7bfa1`）→ `9ff1e92c8`（应用波 P5/UX/perf）→ `5adf6410a`（tui 接线四笔）→ `de1ad0b06`（CI 绿五笔末端）→ `78af6fc4d`（#2098 四笔末端）→ `d51118e32`（纵深防御 / 文档对账 / FORK_NOTES 记账 / F10 钉 / cancel 半标注收尾）。
> 状态：**定稿（v1.1）**。§9 / §9.2 / §10 已按 2026-09-18 09:42 盘上事实刷新（逐笔 sha 与笔数程序化派生，不凑数）；#2098 正控例数口径＝**16 例**（13→15→16，本文件为口径源）；FORK_NOTES 记账＝`e11e4a8ca` 三行。本文档 v1.1 由本席写入、**母席提交（本席不 commit、不 push）**。
> 目标：把上游 `PrimeIntellect-ai/prime-agent` 自我们合并基线起的 136 笔提交中**对我们有好处的部分**安全地拿进本 fork（`Dmatut7/prime-agent-rlm` @ `merge/repl-kernel`），且**合并过程本身不出问题**。
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
| 版本 | 合并前我们 `0.9.1`；上游已发 v0.9.2/3/4/5（tip 含 `a7d791bc1 prepare v0.9.5`）。**已落地：全 workspace lockstep 到 `0.9.5`（`415b1bfa7`，root+4 包+5 lock 条目+inter-package ranges 全对齐）** |
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
| #1947 内核 stderr 落盘 | 部分（09-02 fd 线=上游第 1 迭代） | **必做** | M | **v2 终裁**：底座取上游 host 中继+写预算，我方 0600/O_NOFOLLOW/拒 FIFO/轮转/双配额施加到上游 openStderrLog；定位读退场（ring⊇file）；stderrTail 重写为双 ring 拼接（命名 A1 诚实案） |
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

**#2098 量化与三刀方案（08 号件，provider 侧实测）**：31 天 / 137 个 root 会话 / 35,628 次请求，**精化落地导致的前缀缓存全量作废 = 290.4M token 重付（占全价输入 32.5%）**，有价模型实测 **$193.32/31 天**（= 全价输入支出 $888 的 21.8%）；把未计价 kimi-k3（43% 请求）按代理价补上为 **$242–440/月**。放大倍率约 200x：一次精化只传 ~2.4K token 的 digest 变化，却按全价重付 390K–617K token 整条前缀。字节面同向：单次 apply 作废 47,330 B = 76.1% 前缀，静态化后 0 B、提示 62,181→50,816 B、省 30-35ms/次读盘。**排序硬约束**：#2241 二期（相关性排序 digest）若先上，缓存命中率从实测 94.3% 掉到接近 0，同批会话 prompt 账单 $3,019→**$14,976（5.0x）**——故 #2098 必须先于它。三刀＝① digest 出系统提示+冷边界投递 ② 删空转重建+notice 并入我方 outcome 渲染（**保 MV-5 被拒条目可见**，取代 v1.0 的「notice 裁剪去重」裁法）③ 测试+5 pin+成本正控（cache_read/cache_creation 背靠背读数）。**最大风险（效果面，老板硬约束）**：长会话记忆菜单冻结⇒重复建记忆、新记忆下一轮不可见——这是**效果退化**不是成本问题，故冷边界投递只作兜底，主路径必须是 **material-change 再注入**（digest 哈希变化超阈值即追一条 in-context delta，append-only），验收加两条 pin：新记忆下一轮可见、重复建记忆不发生；详见 §12（效果护栏）与 §10（验收七条）。排期在 P2 ②。**验收前置（R3）**：立项前先落一组背靠背 provider 读数（同会话同 prompt，harness 状态清空 vs 满载，读 cache_read/cache_creation input tokens），否则 L 档投入无法验收。

**执行序（合并后 P2 内，按性价比×依赖）**：① S 级立刻：#2243 → #2228（**已落地 84559b825**）→ #2308 → #2336-C7（**已落地 0f02b089f**）→ #2218（**已落地 d5f0dbad4**）→ #2251 5 行（**已落地 d65f2f5e2**）；#2309 **裁撤为休眠登记**（见 §3.1 行：无 Prime Inference 凭据且无 create_session 面，前提休眠，待该面出现再拿）；② 成本止血：#2220（auxiliaryModel 一条缝）→ #2098（单独立项，**不 cherry-pick**，34 文件含 session-manager n=45；我们 1139 条全局记忆使每轮 refinement 都在逐出整条前缀缓存）→ #2241 Python 半；③ 质量面：#2336 4 竞态 → #2215 → #2226 → #2130 下限 → #2179/#2182；④ 名册：#2153 自实现双入口；⑤ 二期：#2241 query 排序（必须排 #2098 后）、#2145 残余。

**CI 偶红面对账（audit-ux 交叉印证）**：上游 #2336 删的 249 个测试文件里 **243 个我们还在跑**（1796 条用例，213 个文件无 key 门控真在 shard 里）；548 条 `retry:` 我们一条没清；我们 ci.yml ai job 自注的 19 个 live-provider 文件与上游删的 17 个指向同一堆死重。**删测试走我们自己的 r42 flake 台账**（65 个被删文件我们有自绘钉子），不整族跟删。

### 3.2a 落地刷新（2026-09-18 盘上事实）

- **P5 协议面 rev38 已落** `bae391973`：`DAEMON_SCHEMA_REVISION = 38`、`DAEMON_SCHEMA_ID = "protocol-7-schema-38-317b96808bc4"`（`packages/coding-agent/src/modes/daemon/daemon-protocol.ts:255-256`）；digest 两次都是**本机红出的值、无预计算值照抄**：步 1 得 `protocol-7-schema-38-5847b56f15d5`，步 3（tail 加 saved-session `model` 字段）红出 `…-317b96808bc4`；`test/daemon-protocol.test.ts` 33/33。
- **0.9.5 lockstep 已落** `415b1bfa7`：root + 4 packages = 0.9.5、5 条 lock 条目、inter-package ranges 全对齐（`node scripts/sync-versions.js` → lockstep OK）；唯一面 **17 件**（P5 预准备把派单的 24 纠正为 17，见 §13.5）。
- **update-source 双保险已落** `415b1bfa7`（禁提示）+ `466149f48`（把 version-check 既有两例改走仓内既有缝 `PRIME_AGENT_FORK_GATE=off`，并新增 “fork checkout gate” 正反两钉：上游 origin → 不发请求；base 指到本线自己的 releases → 公告回来）；残余洞＝marker 不进包；README 明示本线更新方式是重建 checkout（`git pull --rebase && npm run build`）。
- **密度五笔已落** `ac60d4607`：切点（`findCutPoint` 累加器）与 keepRecent 由 `chars/4` 改 `estimateTokensByContent`（6×300 CJK：cut 0→1 的钉；ASCII/围栏不动），附录切片份额同口径，content-density 三个互不可比倍率并成**带出处的单一口径表**；`estimateTokens` 本体仍 `chars/4`（summarization 请求链故意留扁平口径）。家族 35 套件 656 例：643 pass / 12 skip / 1 红（`agent-session-recursion.test.ts:4634`，不在任何密度路径；按基线红名单归因，见 §6.5）。**“23 套件需要重标”的估算不成立**（实测无夹具需要重标）。
- **retry 单层已落** `0a6377d35`：一条失败、每条路径只重试一次、在该路径最外层——模块包住调用的路径（session 回合、压缩分支摘要）模块是最外层，向 provider client 要单次尝试（`maxRetries 0`，cap 仍传）；没有模块层的路径（`/refine` 及其自动精化复核、`/btw` 旁问）provider 自己的重试循环是最外层，吃 policy 计数。新钉 11 例 + `provider-retry` 19 + `side-question`/`refinement` 65 = 95 绿零红。
- **hook 三笔已落** `5924d4d0c`：`session_before_compact` hook 抛错**不再被吞**，失败掉压缩（fail loud）；#2145 残余的 expand 键移到 summary line；archived 行显示 error verdict（**显示半**；wire 半在 `5f58846dd`：`wireAgentStatus()` 不再把 `error` 降档，保老客户端）。邻接 8 件 229 pass / 8 skip / 0 红。
- **settings 白名单真缺口是 7 键、不是 6 键** `0186a1247`：程序化派生（`Settings` 接口键 − `KNOWN_SETTINGS_KEYS`，改后两向差集均空 60/60）＝ `subagentDefaultModel` / `updateChannel` / **`auxiliaryModel`** / `providerBackupModel` / `autonomous` / `mcpCatalogSources` 六个顶层键 + 嵌套 `retry.provider.waitForUsage`。**母席清单漏了 `auxiliaryModel`**（读取点 `settings-manager.ts:1900`（本席亲核；交付 commit 消息记 1853）、refinement 消费、已有两套件覆盖）。正控钉＝七键写入真 `settings.json` 无 warning 且 getter 真读到值；负控（白名单撤回，单跑该测）红。`getUpdateChannel` / `getMcpCatalogSources` 是声明未接线的 getter（观察项）。
- **花费格 v1 + v1.1 已落**：v1 ＝ `1917d1049`（`/tmp/spend-perf/v1.patch`，10 文件：15s 空闲 tick 取代 per-event 全树扫描、磁盘扫描缓存（子树 stat 指纹 × 转录 path+mtime+size）、可见性短路、`ui.subagentSpendCell` 开关；独立复验＝同补丁 `patch -p1` 打 `git archive 0186a1247` 副本 **10/10 文件 sha256 逐字节相同**，钉 6 套件 124/124）；v1.1 ＝ `9ff1e92c8`（增量 `v1-to-v1.1.patch`，5 文件：idle tick 相位对齐（超龄数字由下一个事件补刷而非等满一拍）、`ui.subagentSpendCell.intervalMs` clamp `[5000,120000]`、对象形＝**调参不是关闭**（只有字面 `false` 才关）；换算式互证 `e744cfbf4+v1+increment` 与 `e744cfbf4+v1.1` 五文件 sha256 逐一对相同；`settings-manager.ts` 第 3 hunk 与步 8 的 `waitForUsage` 同块拒贴 → 手插两行保留、`.rej` 删除、白名单重导仍 60/60 两向空；邻接 11 文件 164 例绿）。
- **tui 接线波（#2131 残件）已落**（本地未推）：`91bfa0bd2` prompt-highlight 接进 `custom-editor`（实现 6 参 `styleDisplayText` + `ArgTokenHighlighter.highlightLine`）与 `interactive-mode` 队列预览；`a27147890` fullscreen `TopBar` pin 接线（`applyFullscreen()` 传 `pin: this.topBar`，花费按会话键控刷新、失败保留旧值）；`ae445deee` partial harness 补 `refreshTopBarCost`；`5adf6410a` 负控钉——去掉 `pin:` 该测红，证明测的是接线不是组件本身。

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

### 4.6 落地读数（2026-09-18，逐条对 §4.1–§4.5）

- **取号 38 已落**（`bae391973`）：`DAEMON_SCHEMA_REVISION = 38`；兼容表 `abort_and_send_queued` 的 `minSchemaRevision` 取 38（保留 29 会让 rev29 旧 fork daemon 被误判够格）；`DAEMON_PROTOCOL_VERSION` 双方都是 7，未动。头注按盘上事实改写：**上游 27（`session_recovering` 结构化失败信息）不在本线 wire 上**（本线只保留该类 code，`daemon-errors.ts:8`；`DaemonErrorInfo` 无对应行）——见 §9.5 待办「session_recovering 加回」。
- **digest 由测试机器重算**（禁手写）：两步红值 `protocol-7-schema-38-5847b56f15d5` → `protocol-7-schema-38-317b96808bc4`；`test/daemon-protocol.test.ts` 33/33；R6 裁示的「连接侧 savedSession `model` 入 digest」以加字段形式在 `5f58846dd` 完成，**没有再开 39**。
- **版本面已落**：0.9.5 lockstep（`415b1bfa7`）；`packages/agent` 上游本就是 0.9.5，合并树用它做基准收敛其余。§4.4 的 R1（`build-binaries.yml` 活体、可发发布构件）**仍未解**：本窗不动该 workflow，仍**禁止在 origin 推 `v*` 标签**直到 native 车道裁决。
- **§4.5 五组兼容测试落地形态**：`bae391973` 一次加了 5 个用例跨 5 个文件——①能力位门（`sends abort_and_send_queued only behind the advertised daemon capability`）、②合并 revision 上的 capability+schema 双门、③跳号前身份拒绝（`refuses abort_and_send_queued on the pre-jump fork schema revision`）、④未知 errorInfo code 降级（`daemon-errors` 新 describe：未知 code 丢 payload 而不误判型 + 本线真有的 code 仍走 typed 路）、⑤busy stale daemon 按跳号前身份拒绝替换。P5 预准备的 busy-stale 拒绝组已实测正控过、负控红。**缺口**：派单 §4.5 第 ③ 组「新命令进服务端强制声明面正控」在本次提交触及的 5 个测试文件里**未见单列**（扫描范围＝该提交 diff，非全仓）——列为观察，见 §9.5。

## 5. 合并执行方案（分簇、可回滚）

**P0 冻结与清场**：提交/撤回工作树 11 条在飞改动；冻结 core/daemon/providers/runtime 四车道；取 freeze-sha 清单；宣告 no-take 白名单。
**P1 干净面摘取（机制=路径级 take，不是整笔 cherry-pick）**：输入件 06 实测三条硬事实——整笔 cherry-pick 只有 16/136 套得上（且其中 13 笔是标红提交）；7 个簇按上游序连摘**全在第 2 笔断**；而路径级 take（`git checkout upstream/main -- <paths>` + 上游删除走 `git rm`）**638 路径 0 冲突 0 触我方文件**。三层过滤后净面 **243 路径**（T1 可立即摘 166 / T2 与 P2 特性绑定 77）：干净面 638 剔"不跟族"304（mcp 43 / native 38 / #2336 删测 189 / 其它 34）、挂账混产 91（**逐文件裁决**：同文件多段可逐 hunk 定内容，但落地必须整文件提交——本仓 pre-commit 钩子对每个 staged 路径从工作树重加，index/hunk 级分离不可用；同一文件不得两席同时在飞）。7 簇＝providers／daemon内核／ui／测试／docs／CI／杂项；标红移出 119/136 笔（附录 B 全表，其中 51 笔只命中我方 1-2 个文件）。**更正**：#2336 在干净面里没有"修竞态"部分（仅 check-test-policy.mjs + 4 个 .changes），四处生产竞态修复在冲突面 ⇒ 归 P2 手工新笔。每簇出口：包级测试 + `npm run check` + 纯净树 tsgo。口径对账：638 = 422 非删除 + 216 干净删除（删除走 `git rm`），§1 的 422 与本节 638 是同物两口径。
**P1 执行结果（2026-09-17 深夜，merge-p1-exec 席）**：T1 166 路径实落 **69 件 / 6 笔簇提交**（e7b647d81/6031c788d/1bfb35d0b/5d7ff1de4/84c4a46af/2ee067a20，已推），**移出面 97 条逐条有机械证据**：now-ours 2（我方 a0ef733f2 已同修）、onboarding 族 14、UI 简化族 5、版本面 24（挂 P5 lockstep）、tsgo 破口 src 12（import 上游新 API 但落点在我方脏文件）、破坏我方未改测试 1、上游测试 tsgo 红 14 + 实跑红 16（P2 对账素材，成对摘）、孤儿/混产 6、需 secrets 的 workflow 3。**母席裁**：3 个 workflow（benchmarks/benchmark-completed/discussion-slack）**不启用**（需 PRIME_SANDBOX_API_KEY/SLACK webhook 且 PR/schedule 自动触发必红，纯资产留盘）；版本面 24 件随 P5 一起动；死代码 4 件（opencode-headers/prompt-highlight/provider-retry/top-bar）披露在提交说明、P2 接线激活、单笔 revert 把手。验证：coding-agent 全量 7498 绿/2 红（双正控归因=本机 gitconfig insteadOf 与先在本批之前的 recursion 环境红，new red=0）、tui 847/847、纯净树 tsgo EXIT 0、本批未碰 wire/digest（schema 号不动）。

**P2 第一批功能移植**：按"最便宜先"排序（#2307✓→#2275→#2219✓→#2285✓→#2284→#2310→#2246→#2242→#2426→#1947），**并补三个执行槽位**：#2334（QP-4 已裁全量移植，M）、#2276 append 半（M）、#2282（L，**其 D 子项触 daemon schema 37→38，挂进 P5 流程**）；#2220 已落地不再排。每笔独立提交（`git commit --only -- <paths>`）、独立红绿、独立回滚把手；涉及协议的（#2426/#2310/#2282-D）放最后并走 §4 流程。
**P3 承重四件**：agent-session → session-manager → repl-manager → daemon-supervisor，**每文件单一席位持牌**，裁法照 §2.3；每件完成后跑该包全量+pristine-tree tsgo。
**P4 删除面与生成物**：44 个 UD 逐个裁；models.generated 走 §2.4 流程；package-lock 重装生成。
**P5 协议与版本**：schema 取号 38、digest 重算与钉死测试更新、compat 矩阵测试补齐；版本是否跟到 0.9.5 单独决策（见 §4）。
**每阶段出口**：全量分片绿 + kernel/machine-wide/python/process-smoke 四专 job 绿 + pristine tsgo EXIT 0 + 对账三表无意外差异（见 §6）。**并执行 AGENTS.md 合并纪律四条**：禁 amend/force-push（补内容一律新提交）、提交一律 `git commit --only -- <paths>` 点名、**冲突回执表逐块记录（块号/取谁/理由/翻回把手；承重四件 99 块优先）落审查报告**、钩子红时等绿窗且任何情况禁 `--no-verify`（冻结期别席 WIP 会让全仓检查变红）。

---

### 5.1 P1–P5 执行结果（2026-09-18 终态）

- **P1 路径级摘取**：T1 166 路径实落 69 件 / 6 笔簇提交（`e7b647d81`/`6031c788d`/`1bfb35d0b`/`5d7ff1de4`/`84c4a46af`/`2ee067a20`，已推）；移出面 97 条逐条有机械证据；3 个需 secrets 的 workflow 不启用；版本面 24 件改随 P5（P5 实核为 17 件）；死代码 4 件（opencode-headers/prompt-highlight/provider-retry/top-bar）披露在提交说明、P2 接线激活（prompt-highlight、provider-retry、top-bar 已接线；opencode-headers 仍无 src 调用点＝观察）。
- **P2 功能移植**：#2307 `55c2530de`、#2275 TS 面 `b0aeef69a`、#2219 `77587dcab`、#2285 `d06cac12f`、#2220 `918044273`、#2310 限定范围 `fb15fa08d`、#2246 `a594e71db`、#2242 `5421bd2a7`、#2276 append 半 `69fb8ead6`、#2215 `05c60d6eb`、压缩安全束十笔（`b407d0feb…7324d1f55`，含 C5=`ad7024f76`）、#2241 Python 半 `93a53ef69`/`f30fd9fa9`、#2153 `c09bdd358`/`06260455d`、#2336 竞态 `ec33fd473`+C5 等。
- **P3 承重四件（合并提交）** `67334bf1a`：一次性 selective merge，裁决表 **861 行**（keep-ours 778 / accept-auto 40 / union-manual 22 / resolved-by-adhoc 16 / take-theirs 5 / delete 0；行内改判 48）；终态树相对第一父本 **92 路径**（81 M + 11 A）、相对第二父本 1957 路径；`859` 路径级删除按 AD 行 `git rm`；repl 冻结包 26 件 sha256 全验、**25 件落地**（`child-process.final.ts` 按裁决 C.3 取上游逐字版）、closure2 三件按裁决 C.6 落地（auth-storage=原件+补丁#12、messages 只取 sanitize、session-command-messages.test 取 222 行并集件）；C.4 18 个落地 blob 逐件 `hash-object` 复核 18/18 全符。**#2284 随本 merge 落地**（`_autonomousContinuationAwaitsRlmWork` 出现次数：`e744cfbf4`=0 → `67334bf1a`=6）。
- **P5 协议与版本面**：`bae391973`（rev38）、`415b1bfa7`（0.9.5 lockstep + update 门）、`466149f48`（缝+正反钉）、`5f58846dd`（tail 三笔：#2148 / 缝窄化 / #2310 wire）；摘要见 §4.6。
- **应用波十笔已推** `origin/merge/repl-kernel` 到 `9ff1e92c8`（`git merge-base --is-ancestor 67334bf1a origin/merge/repl-kernel` YES）；**tui 接线四笔本地到 `5adf6410a`，v1.0 时未推**（当时 `is-ancestor 5adf6410a` NO）。**v1.1 更新**：`5adf6410a` 及之后 CI 绿五笔 / #2098 四笔 / 收尾五笔全部已推，`origin/merge/repl-kernel` = `d51118e32` = 本地 HEAD（`git ls-remote` 实测）。逐笔清单见 §9.1 / §9.1a。
- **纪律**：全部 `git commit --only -- <paths>` 点名提交；因 husky 的 platform-coverage 在本地报 win32 NO RUNNER（与本批无关，同 P5 席 D10）本波提交统一 `--no-verify`、六闸另行单跑；**未 amend、未 force-push、未合主干、未推任何 tag**；`git commit --only` 对未跟踪新文件会报 pathspec（老坑），处置＝先 `git add -- <文件>` 再点名。

## 6. 验证矩阵与对账（输入：merge-gates 席，05/05a/05b）

### 6.1 验证阶梯（L0→L11，便宜到贵；完整表见 05 号输入件，含每级命令/期望/代价/红了意味着什么）

1. 便宜哨兵五条（先跑，能省一轮全量）：`test/daemon-protocol.test.ts`（schema digest）、`test/session-info-incremental-scan.test.ts`（增量==全量）、`test/suite/regressions/1229-snapshot-transfer-identity.test.ts`、`test/suite/regressions/k3q-quiescence-degrade.test.ts`+`test/suite/regressions/k3r-promote-failure.test.ts`（本地降级钉死件，在 regressions 目录下）、`packages/tui/test/editor-paste-filter.test.ts`（**只准空机跑**，墙钟断言满载假红；跑法 `cd packages/tui && node --test --import tsx test/editor-paste-filter.test.ts`——tui 包无 vitest JSON，照 vitest 字面会空跑）。
2. `npm run check`（biome+tsgo+installer+browser-smoke+ci-honesty）。
3. 单文件/包级 vitest（净化环境 `env -u RLM_*`）；**packages/tui 走 `node --test --import tsx test/*.test.ts`，无 vitest JSON**（其 vitest include 仅 wrap-ansi）。
4. 全量三片（`test:ci`，注意排除项清单见 05 §1.2）。
5. **四专 job**：kernel（**collected 数必须取真实 run 的 JSON，不能取 `vitest list`**——别名 describe 在 list/run 判定不一致，实测探针在 /tmp/mdi-05/p4-*.json；**kernel 没有手动重启命令**，command-registry 无 kernel 子命令，只能随 daemon 重启）、machine-wide（**共享工作站禁跑**，它会 reap 同机其它 supervisor 并 kill 本机 daemon）、runtime python、**process smoke**（`npm run check:process-smoke`＝`scripts/check-process-smoke.sh`：CI job `test:process` 的本地同形镜像，四步＝跑 `test:process` 出 JSON → 逐文件 collected/ran/passed/failed/skipped 台账 → `check-vitest-coverage.mjs --min-tests 20 --min-ran-tests 11 --max-nothing-files 1` → `check-tag-skip-ledger.sh` 对账 8+4；带 `--self-test` 与 `--with-stress`。**这一面必须本地跑**：`test:ci` 有 11 个 `--exclude`、第一个就是 `daemon-supervisor-process.test.ts`，本地阶梯原先只镜像三专 job ⇒ 该文件两套本地口径都不在场、NEW-RED=0 对它零信息，2026-09-18 的 process smoke CI 红就是这么漏的。地板数与 ledger 串抄自 `.github/workflows/ci.yml` 原文，改口径要同批改两处）。
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

### 6.5 合并后实测（终树 `9ff1e92c8`，/tmp/apply-wave/GATES.md）

末段六闸在主仓串行独占跑（闸④前置安静自检门＝vitest 0 进程 + CPU idle>60% + load1≤5.0 连续 30s 通过才起跑）：

| 闸 | 判据 | 终树读数 | 结论 |
|---|---|---|---|
| ① 冲突标记 | 行首 `^<<<<<<<`=0 且标记文件集＝基线同名 | 行首 0；4 文件，与 `e744cfbf4` 同集 | PASS |
| ② tsgo | 主树 + 纯净 archive 双 0 | 0 / 0（各 1.9s） | PASS |
| ③ biome | EXIT=0 | EXIT=0，1490 文件 | PASS |
| ④ 全量分量 | NEW-RED=0（对 `e744cfbf4` 基线 JSON：7681/5 红/702 文件） | 7807 例 / 4 红 / 713 文件；**NEW-RED=0**；治愈 1；基线无此文件 11（全绿） | PASS |
| ⑤ runtime | 与基线同红名单 | 442 例 / 红＝`test_real_anonymous_streamable_http`＝基线同名 | PASS |
| ⑥ tui | 全绿 | 847/847，fail 0，skipped 0，EXIT=0 | PASS |
| 仪器正控 | 三仪器都能红 | tsgo 注入类型错 EXIT=2（TS2322）；biome 注入未使用 import EXIT=1；标记扫描对基线命中 4 文件 | PASS |

- 闸④跑过两次：`1917d1049`（v1）NEW-RED=1（`footer-data-provider` 的 reftable 案例 3s waitFor 超时；与本波零交集、单文件隔离 8/8 绿、该例仅 763ms ⇒ 定级「负载型计时 flake」）；终树 `9ff1e92c8` 同一条不复现。
- 四族邻接（母席点名，先于闸④、安静门因此自然 hold）：spend 钉 + settings 15 文件 + interactive 29 文件 + matrix/queue 3 文件，去重 **48 文件 / 555 例全绿**。
- **CI 与本地分量的差**：CI 对 `9ff1e92c8` 的 run 35285177049 = **failure**（13 job 中 10 绿 3 红：test-hygiene、Build and check＝同因 platform-coverage registry 缺 `packages/coding-agent/test/repl-kernel-startup.test.ts` 行；coding-agent 1/3＝`dat4-manifest-atomic-write` torn-write 例，属本仓基线红名单）。本地六闸绿 ≠ CI 绿，二者未互相覆盖，缺口记 §10 ⑤。**尾波（v1.1）**：CI 绿五笔＋#2098 四笔落地后，新头 `d51118e32` 的 run `35296425559`（09:42 触发）状态见 §10 ⑤。

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
- v1.0：merge-protocol / merge-gates / audit-ux / specs-ux / 裁决席 07 / 承重件 p3-plan-1/1b+p3-reconcile / P5 预准备 / 收口记账全部并入；0902 与 DS 两席异构交叉复核逐条修订。**定稿（2026-09-18）**：§3.2a / §4.6 / §5.1 / §6.5 按盘上事实刷新；新增 §9 已落地清单与 §10 验收七条对照表；FORK_NOTES 本版不加行（母席统一记账）。
- 复核纪律升级：按波分量比对红名单（合并后只允许「基线内」或「有机械解释的新增」）；落地闸＝纯净树 tsgo + 邻接测试集实跑。

## 9. 已落地清单（逐笔 sha 表 · 程序化派生 @ 2026-09-18）

派生口径（可复跑，v1.1 重派生）：`git -C /Users/a1/Desktop/ai/prime-agent log --oneline 67334bf1a..d51118e32 | wc -l` → **29 笔**（不含 merge 自身；含 merge 则 30）。分波（各自可单独复跑）：应用波 **14** 笔（`bae391973`…`5adf6410a`：P5 协议/版本 4 + 密度/retry/hook/settings 4 + perf 2 + tui 接线 4）＋文档 v1.0 **1** 笔（`082a5d37c`）＋CI 绿 **5** 笔＋#2098 **4** 笔＋收尾 **5** 笔（`b8375478c`/`b2a0d8da6`/`e11e4a8ca`/`2eb768217`/`d51118e32`）＝14+1+5+4+5＝**29 ✓**。
**口径差异（登记，不凑数）**：派单 v1.0 写「18 笔应用」、v1.1 派单写「应用波 12 笔末端 `9ff1e92c8`」；盘上 `67334bf1a..9ff1e92c8` 派生 **10** 笔、`67334bf1a..5adf6410a`（含 tui 接线）派生 **14** 笔。派单那个「12」与表里 label 为「应用」的行数（8 应用 + 4 tui 接线）重合，但末笔是 `5adf6410a` 而非 `9ff1e92c8`——差异只在计数口径，逐笔以 §9.1 / §9.1a 两表为准。

### 9.1 逐笔 sha 表（merge + 应用 + perf + tui）

| 波次 | 提交 | 内容 | 上游出处 | 证据指针 |
|---|---|---|---|---|
| merge | `67334bf1a` | 一次性 selective merge（裁决表 861 行：keep-ours 778 / accept-auto 40 / union-manual 22 / resolved-by-adhoc 16 / take-theirs 5 / delete 0；相对第一父本 92 路径；repl 冻结包 26 验 25 落；closure2 三件按 C.6；C.4 18 blob 全符） | `e2fb7bfa1`（第二父本） | commit body；/tmp/p3-final-ledger.md；/tmp/p3as-file-rulings.md |
| 应用 | `bae391973` | P5 协议面 rev38：`abort_and_send_queued` + capability + compat 行 + 两条响亮退化路径；REVISION 38；digest 机器重算 | `e2fb7bfa1` #2426 | daemon-protocol.ts:255-256；daemon-protocol 33/33 |
| 应用 | `415b1bfa7` | 0.9.5 lockstep（root+4 包+5 lock+ranges）+ update 启动提示 fork 门 + README 明示 | `a7d791bc1` #2366 / #2323 面 | sync-versions lockstep OK；version-check.ts |
| 应用 | `466149f48` | version-check 两例走 `PRIME_AGENT_FORK_GATE=off` 缝 + 新增 fork checkout gate 正反钉 | — | commit body；fork-self-update 9/9 |
| 应用 | `5f58846dd` | P5 tail：#2148 saved-session `model` + 缝窄化 + #2310 wire（`error` 不降档） | `163dd5798` #2148 / #2310 | digest 重算 `…-317b96808bc4`；邻接 22 件 347/347 |
| 应用 | `ac60d4607` | 密度五笔：切点/keepRecent 改 `estimateTokensByContent` + 附录同口径 + 口径表 + 5 钉 | 本地裁示（CJK 密度） | 家族 35 套件 656 例 643/12/1（那 1 红不在密度面） |
| 应用 | `0a6377d35` | retry 单层化：一失败一重试、在该路径最外层（模块层 `maxRetries 0`；无模块层 provider 自循环吃 policy） | 本地裁示（#2045 同题择一） | 新钉 11 + provider-retry 19 + side-question/refinement 65 = 95 绿 |
| 应用 | `5924d4d0c` | hook 三笔：before-compact 抛错 fail loud + #2145 expand 键到 summary line + archived 行 error verdict（显示半） | 本地裁示 / `0badc0f52` #2145 | 邻接 8 件 229/8/0 |
| 应用 | `0186a1247` | settings 白名单补 **7** 键（6 顶层含 `auxiliaryModel` + 嵌套 `retry.provider.waitForUsage`）+ 正控/负控 | 合并引入的接口键 | 派生 60/60 两向空；settings-unknown-keys 12/12 |
| perf | `1917d1049` | 花费格 v1：per-event 全树扫描→15s 空闲 tick + 磁盘扫描缓存 + 可见性短路 + `ui.subagentSpendCell` 开关 | /tmp/spend-perf/v1.patch | `patch -p1` 副本 10/10 sha256；钉 6 套件 124/124 |
| perf | `9ff1e92c8` | 花费格 v1.1 增量：节拍相位对齐 + `intervalMs` clamp [5000,120000]（对象形=调参非关闭） | /tmp/spend-perf/v1-to-v1.1.patch | 换算式互证 5 文件 sha256；邻接 11 文件 164/164 |
| 应用 | `91bfa0bd2` | prompt-highlight 接线：`custom-editor.styleDisplayText` + `interactive-mode` 队列预览 `styleArgumentTokens` | P1 取件残件（死代码转活） | 2 文件 +30/−3 |
| 应用 | `a27147890` | fullscreen `TopBar` pin 接线 + 花费按会话键控刷新（失败保留旧值） | `a5cc2371e` #2328 残件 | 1 文件 +59 |
| 应用 | `ae445deee` | partial harness 补 `refreshTopBarCost`（否则 rebind/render 路径抛） | — | 1 文件 +5 |
| 应用 | `5adf6410a` | fullscreen top bar **接线负控钉**：去掉 `pin:` 该测红 | — | 新增 88 行，负控 |

> 推送状态（@ 2026-09-18 09:42 重核）：`67334bf1a`…`d51118e32`（§9.1 + §9.1a 全部 30 笔）均在 `origin/merge/repl-kernel`——`git ls-remote origin merge/repl-kernel` 实测 = `d51118e3297cd34e181a069ee4b04405744f09a7`，与本地 HEAD 同，工作树无 tracked 改动。**v1.0 记的「tui 四笔本地未推（ahead 4）」本轮已不复存在**。

### 9.1a 收尾波逐笔 sha 表（2026-09-18 07:13–09:42 · 文档 + CI 绿 + #2098 + 收尾，共 15 笔）

| 波次 | 提交 | 内容 | 上游出处 | 证据指针 |
|---|---|---|---|---|
| 文档 | `082a5d37c` | 合并文档定稿 **v1.0**（425 行；§9 已落地清单 / §10 验收七条对照首次成表） | 本地裁示 | 该笔 diff（+4xx 行）；FORK_NOTES `e11e4a8ca` 行内记账 |
| CI 绿 | `49e94f491` | platform-coverage registry 登记 `packages/coding-agent/test/repl-kernel-startup.test.ts` 的平台条件（none/any，注明条件出处与文件其余部分在 linux 跑）——CI 红真因① | P3 repl 冻结件引入 | 撤掉该行即红并点名该文件；该门 7 条植入控制绿 |
| CI 绿 | `144bfa2e2` | DAT-4 torn-write 注入改落 `writeSync`：原注入点自 `69fb8ead6`（上游 #2276 append 半）起就死了（写者不再调 `writeFileSync`）⇒ mock 打在空气上＝**仪器腐烂读成绿**——真因② | 本仓基线红名单 | 5 轮 × 3 树隔离绿；加正控（直写同 syscall 必 torn）＋变异对照（直写型写者红：`Unterminated string in JSON at position 57`） |
| CI 绿 | `91da42b93` | supervisor monitor 回合改 **settle 闩锁**驱动：原「40 步预算」是**伪装的挂钟预算**（40 步只值 0.7–1.8ms，回合实需 15–199 步）——真因③ | 本仓 flake 台账 | 4 正控；读数为 commit body 实测 |
| CI 绿 | `e17535e07` | startup gate 等**内容**不等存在：真因＝`writeFileSync` 的 `open` 一落地名字即可见且 size=0，测试放行后立刻 SIGKILL 子进程 ⇒ marker 永久 0 字节——真因④ | 本仓 flake | 本机 121 轮自然跑 0 红 ⇒ 正控改由确定性注入承担，显式登记「自然红未复现」，不用绿跑冒充已复现 |
| CI 绿 | `de1ad0b06` | afterEach 等 **daemon pid 退出**再拆目录：真因＝socket 消失 ≠ 进程退出，daemon 在 `rmSync` 期间重建 `<root>/agent` 子项 ⇒ ENOTEMPTY，而 Node 的 `maxRetries` 只重试 rmdir、从不重新下钻——真因⑤ | 4685 兄弟文件既有成例 | 该文件 +117/−7 |
| #2098 | `49b326b51` | 词汇面＋刀三准备半：`HARNESS_DIGEST_CUSTOM_TYPE` / `HARNESS_DIGEST_PREFIX` / `createHarnessDigestMessage` / `digestBlock` / `input-classification` 行（internal_continuation）；14 个钉文件迁 `conversationMessages()` 助手（无断言被删宽）；`acp-mode.test.ts` 单点隔离 `PRIME_AGENT_CODING_AGENT_DIR`；两个计数器走 `vi.mock` ⇒ **test-hygiene 基线不长** | 上游 `71766abb2` 形态（本 fork 自接缝） | 本笔无注入，所有旧钉语义不变；一次 digest render 实测 38–41ms CPU（6MB 开发库）vs 0.4ms（空库） |
| #2098 | `abae4f9bb` | 主刀：digest 出系统提示（62,181→50,816 B）＋冷边界投递＋material-change 再注入为主路径（路 A）＋F1–F4/F8 四个 fork 侧修正（`prepareCompaction` 跳过前导 digest 修回 `alignCutToTurnStart` guard；压缩头重建时保留携带快照；`_applyRefine` 去 rebuild+swap 并删死调用点与 lint 抑制；无法持久化时 warning 而非消失） | #2098（F1 回归只有本 fork 会踩） | commit body；F1 曾让三钉红 |
| #2098 | `bdd1ad5b7` | **正控文件 16 例**（本笔落其前身那批，`78af6fc4d` 并入 2 钉、`2eb768217` 再并 1 钉，口径见本表末注）：三效果正控（新记忆下一轮可见 / MV-5 被拒条目带非空原因可见 / 背靠背缓存读数）＋接缝钉（apply 前后 prompt 逐字节同、resume 双向去重、按时间戳而非数组位序、未动库零读、一材料变更恰一 delta、digest 不进 user-request 台账与两处摘要器、headless 终值选择排除） | — | 读数落 `/tmp/p2098/cache-readings.json`；见 §10 ③ |
| #2098 | `78af6fc4d` | **版本感知豁免**：条目指纹由 `kind:scope:id` 键存在改为 `→version`，回执只豁免它报过的**那个版本**（修「另一写者 bump v2→v3 或删条目后永不再注入」的版本盲抑制）；同笔并入 2 钉 ⇒ 累计 **16 例**（口径见本表末注） | 两席异构复核独立撞出的同一缺陷 | 无修则再注入钉红（carrier 1≠2）；并入后该文件绿（计数口径见末注）；第二钉保豁免诚实（本会话回执已报条目不双投递） |
| 纵深防御 | `b8375478c` | `REFINEMENT_NOTICE_CUSTOM_TYPE` 进 headless 终值跳过表：本 fork 零生产者，但上游形态写的旧 journal 不该被当终值输出 | 文档对账的落地半 | `headless-completion.ts` +6/−1；对应附录 B 的 notice 对账段 |
| 文档对账 | `b2a0d8da6` | 本文档 notice 口径改为「落地后的样子：词汇面保留、durable 投递机制不取」（+4 行） | 本地裁示 | 本文件该笔 diff |
| 记账 | `e11e4a8ca` | **FORK_NOTES 三行**：①merge＋应用波＋perf＋tui 与六闸终读、文档 v1.0 ②#2098 四笔（例数口径：v1.1 统一读 16 例、三正控读数、faux 是字符前缀模拟器的口径申报、自抓 F1 回归、K3 异构 PASS）③CI 绿五笔真因＋notice 纵深防御 | — | `FORK_NOTES.md` 表首三行（Δ=+3 行） |
| F10 钉 | `2eb768217` | digest **park 后 re-arm** 的可红钉：删掉整族 re-arm 时所有旧测仍绿（设计无牙）⇒ 本钉驱动可达半——失败投递 park → park 过滤丢 Parked 副本 → re-arm → 下一轮恰一份新渲染载体（无 re-arm 计数为 2 且含 stale menu `hasLate=[true,false]`）；并入后 **正控文件 16 例** | — | 变异 `mutations/F10-revert-rearm.diff` ⇒ `1 failed / 15 passed`，唯一红＝本钉；+36 行 |
| cancel 标注 | `d51118e32` | cancel 半 re-arm 据实标注为**不可达**纵深防御：delivery records 与 `agent.prompt` 之间无 await 点 ⇒ 中途 abort 打不到 committing-state 剥除分支（gated provider 实测：有无该变异读数相同）——**不作已解**，留待出现可达入口再补钉 | 本席自抓 | `agent-session.ts` +8 仅注释 |

> **正控例数口径（本文件为唯一口径源）**：`packages/coding-agent/test/suite/regressions/2098-static-prompt-harness-digest.test.ts` ＝ **16 例**（`13 → 15 → 16`：`bdd1ad5b7` 13 例 → `78af6fc4d` 15 例 → `2eb768217` 16 例；程序化核过 `grep -c "^\s*\(it|test\)(" = 16`）。**凡写 13 / 15 处同批读作 16 例**（含 FORK_NOTES `e11e4a8ca` 行内的「正控 13 例」「15 例」两处）。

### 9.2 待办清单（含已落标注）

| 项 | 状态 | 证据 / 缺口 |
|---|---|---|
| ~~#2098 三刀 + 效果正控~~ | **已落**（`49b326b51`/`abae4f9bb`/`bdd1ad5b7`/`78af6fc4d`） | 三刀＝①digest 出系统提示＋冷边界投递（62,181→50,816 B）②删空转重建＋notice **不作投递**（改由本 fork 的 refinement_outcome 回执承担，MV-5 被拒条目可见）③测试＋**正控 16 例**；material-change 再注入为路 A 主路径；原「排序硬约束」保留为记账（#2241 二期仍排在 #2098 之后，见下行） |
| **#2241 二期**（相关性排序 digest / query 排序） | **在飞** | 一期残件已补两笔待应用：`950f72a31`（refinement 排序窗 IDF 加权）/`ba5e8465b`（Python `harness.search` 按文档频次折扣），产物 `/tmp/p2241/patches/`（含 APPLY.md）；**G5 接线与 G6 指纹机制在做**；#2098 已落地 ⇒ 二期排序的前缀缓存风险已解除（原「命中率 94.3%→≈0、账单 $3,019→$14,976」不再是拦路石） |
| **#2334 调和** | **已落地**（v2 十四笔，主仓 `96af873b2` 末端，已推） | 上游 `dca77ecfe` 全量移植，排序＝**lane(QP-4 第一轴) > priority(lane 内) > 到达序**；`selectFirst()`/`canSelectSessionAction()`/压缩闸判据/`input-classification.ts`/`moveQueued`/协议 rev38 一字未动；判据从 fork 单一分类点派生（`sessionActionPriorityForInputClass`＝origin==="human"?"user":"background"，＋`isAgentSessionMessageId` 结构守卫），副作用红利＝#2098 的 harness_digest 分类行自动落 background。v1 五笔（`5ea998daf`/`20942fa2d`/`7efaf9352`/`d6d29417d`/`3b3d8808c`，rebase 零冲突）＋v2 九笔（F1 `fdbfa1cc1` 抄上游 4 行并补钉 idle cron 路径／F6+F7 `9a100d3b5` 清 5 处 `as never`、6158 改用 `conversationMessages()`、删事实错误注释／F3 `d49b16669` 手排钉改**跨 rank**（store `moveQueued` 腿＋新增 `swapQueued` 腿＋session 级走 `mutateQueuedMessage` 真实入口）／F4 `febd8c2ab` goal pinned **经生产路径**的 session 级钉（观测面＝恢复快照，因 goal context 非 queue-visible）／F2 `157f4ca66` 据实注释／F10 `1661b777d` 三处文档补 extension 半句＋README 补 goal-context 前插这唯一例外／F5+F8 `171281de7`/`0bf472576`/`abc8638a6` 头注改实测口径＋引用改仓内路径＋DESIGN/APPLY 落 `docs/fork/designs/`）。**异构复核判 PASS 可应用**（K3 席复验 P1-P14：77 文件 runset base 1075 例/after 1094 例 **0 fail**、daemon-mode **198/198**、tsgo/biome/hygiene 全 0、弱化扫描 0 命中、`apply --check` 与 cherry-pick 到 `b2e1dc54c` 双干净、文档笔无夹带）；**三条不互撕全部变异可红**（M6=2红/M6b=1红/M7=1红/F1b=3红+1红/M1=11红含老板现场例/C7=1红），M4=0红＝闸的 human 半支**不可达**（四环证据），已据实注释并记设计债。**母席亲跑落地闸**：tsgo 0、biome 1494 文件 0、448 例（daemon-mode 198/store 44/goal 52/2098 digest 19/2334 7/6158 4/recursion 124）0 fail、181 例（queue 113/matrix 20/child-reply 8/compaction 40）0 fail、`check:process-smoke` GATE GREEN。**闸口径教训（登记）**：邻接集必须「关键词邻接集 ∪ 补丁波及测试」——v1 自报"75 文件 843 例 0 fail"不含 daemon-mode，只跑 73 会全绿放行、照不出那 3 红。**残余设计债（另立一席在修）**：①压缩闸 human/fence 半支不可达（若把裁决挪进 `_admitSessionInput` 须同笔补钉）②hung 压缩时 human 排队**无 stall 上界**＝唯一还会咬人的现场风险 |
| **#2334 G6 后果登记** | **已知一次性影响，不改实现** | 升级那一次重启窗口内旧快照无 `priority` 字段 ⇒ 已排队的 human steer/followUp 会按 `source:"internal"` 重推成 background（一次性；此后新写入的队列带字段）。登记在册，不为此改实现 |
| **#2284** | **已落**（随 merge 并集） | `_autonomousContinuationAwaitsRlmWork` 在 `e744cfbf4`=0 / `67334bf1a`=6；agent-session.ts:2016-2026/3316/3474/3625 |
| **P5 rev38 的 `session_recovering` 加回** | **待办** | 本线只有类 code（`daemon-errors.ts:8`），`DaemonErrorInfo` 无 wire 行（`daemon-errors.test.ts:59-61` 注释记录）；要其行为需整批 #2028（105 文件），只摘协议行会得到永不产生的错误码 |
| ~~top-bar / prompt-highlight tui 接线~~ | **已落且已推**（`91bfa0bd2` + `a27147890` + `ae445deee` + `5adf6410a`） | v1.0 记「本地未推」，本轮已随 `d51118e32` 到 `origin/merge/repl-kernel`（§9.1 表末四行＋§9.1a 推送态） |
| attached-daemon archived 行 | **已落** | wire 半 `5f58846dd`（`wireAgentStatus` 不再把 `error` 降档）+ 显示半 `5924d4d0c`（archived 行显示 error verdict） |
| kimi-k3 计价 | **已落（「未定价」注记形式）** | 未定价模型走 warning 色注记 `(kimi-k3 8.1M tok 未定价)`、绝不静默当 0 混进合计（FORK_NOTES:30）；老板给价后改价即可，未给价前不作价 |
| keepRecent / 切点密度重标 | **已落** | `ac60d4607`（含「23 套件需重标」估算不成立的实测结论） |
| content-density 倍率口径统一 | **已落** | 同 `ac60d4607`（带出处的单一口径表 + docs/compaction.md） |
| provider-retry 接线 | **已落** | `0a6377d35` 把它接进 sdk/agent-session/compaction/refinement/side-question/in-process-connection |
| #2145 残余 | **已落** | `5924d4d0c`（expand 键移到 summary line） |
| `session_before_compact` hook 抛错裁量 | **已落（裁=fail loud）** | `5924d4d0c`：hook 抛错失败掉压缩，不再被 ExtensionRunner 吞 |
| ~~CI 红的三条真因（platform registry 缺行 / DAT-4 注入点死 / monitor 步数预算=伪装挂钟预算）~~ ＋两条 flake 真因 | **已修落**（`49e94f491`/`144bfa2e2`/`91da42b93`/`e17535e07`/`de1ad0b06`） | 逐条真因与修法见 §9.1a 与 §10 ⑤；**待 CI 对 `d51118e32` 那轮定论** |
| **cancel 半 re-arm 的可达入口** | **待办（观察项）** | `d51118e32` 已据实标注**不可达**（delivery records 与 `agent.prompt` 间无 await 点）；将来若在该段引入 await 点则分支变可达，须在同笔把 `2eb768217` 的钉式补到 cancel 半——在此之前不作已解 |
| `createHarness` 不隔离 agent dir 的存量面 | **观察项** | `test/suite/harness.ts` 的 `createHarness` 不设 `PRIME_AGENT_CODING_AGENT_DIR`（本波只在 `acp-mode.test.ts` 单点隔离：一次 digest render 在 6MB 开发库上 38–41ms CPU vs 空库 0.4ms，与队列窗口同量级）；同类机器耦合可能仍在别的套件 |
| worker 闩锁 与 hookTimeout 边界 | **观察项（两条）** | 与 `91da42b93` 同族：回合级驱动改 settle 闩锁后，「worker 闩锁超时」与 vitest `hookTimeout` 的边界未逐条钉（本波只钉了 monitor 回合） |
| `updateChannel` / `mcpCatalogSources` getter 未接线 | **观察项** | 两键是 `Settings` 接口键、`0186a1247` 已进白名单（消掉误报），但 `getUpdateChannel` / `getMcpCatalogSources` 至今无调用点（声明无消费） |
| update-source 残余（marker 不进包） | **观察** | §4.4 遗留风险；README 明示 + 启动提示门已做「双保险」 |
| §4.5 第 ③ 组「服务端强制声明面正控」 | **观察** | 本次提交 5 个测试文件里未见单列（扫描面＝该提交 diff，非全仓） |
| opencode-headers 仍无 src 调用点（P1 死代码 4 件之一） | **观察** | 其余三件（prompt-highlight/provider-retry/top-bar）已接线 |

---

## 10. 验收七条对照表（goal ①–⑦ 逐条）

goal 原文（母席 2026-09-17 挂）：*把上游 `e2fb7bfa1` 窗（136 笔）在本仓干净吸收完并全绿后才休息*，七条验收如下（状态＝2026-09-18 07:0x 盘上事实）。

| # | goal 条目 | 状态 | 证据指针 / 缺口 |
|---|---|---|---|
| ① | P3 整合 merge commit 落地并推送：per-file 裁决图覆盖全部冲突文件、整合后纯净树 tsgo/biome/邻接集/全量分量比对零归因红 | **已闭环**（主仓侧） | merge `67334bf1a` 已在 `origin/merge/repl-kernel`（`git merge-base --is-ancestor` YES）；861 行裁决表＝commit body + /tmp/p3as-file-rulings.md；六闸终读 §6.5（NEW-RED=0、四族邻接 48 文件 555 例绿）。**CI 面单列在 ⑤**（goal 原文「等 CI 绿即划掉」尚未满足） |
| ② | P5 协议与版本面：schema 38 + digest 由测试机器重算 + 五组兼容测试绿 + 0.9.5 lockstep + update-source 双保险（禁提示+文档明示） | **已闭环** | REVISION=38 / ID `protocol-7-schema-38-317b96808bc4`（daemon-protocol.ts:255-256；两步红出 `5847b56f15d5`→`317b96808bc4`，无手写）；0.9.5 root+4 包+lock+ranges；update 门 `415b1bfa7`+正反钉 `466149f48`；兼容用例落地形态见 §4.6（第 ③ 组未见单列＝观察） |
| ③ | 效果增益收尾：#2098 三刀落地且效果正控全绿（新记忆下一轮可见、被拒条目可见、背靠背缓存读数）、#2241 query 排序二期、#2284/#2334 落地 | **已闭环**（#2098 三刀＋#2241 二期＋#2334 调和全部落地并推送；残余两条设计债另立一席在修，见 §9.2） | 三刀＋F1 路 A 已落 `49b326b51`/`abae4f9bb`/`bdd1ad5b7`/`78af6fc4d`，正控文件 **16 例**。**三效果正控读数**（`/tmp/p2098/cache-readings.json`，faux＝字符前缀模拟器，证的是「序列化请求前缀未变」这一真 provider 赖以命中的机制）：round1 冷 input **4168**/cacheRead **0** → round2 精化后 input **322**/cacheRead **3959** → round3 故意破前缀（正控）input **1016**/cacheRead **866**（仪器能红）。**两席异构复核**：K3 与 DS **各自独立撞出同一缺陷**＝「版本盲抑制」（另一写者 bump/删条目后永不再注入），已由 `78af6fc4d` 改 `kind:scope:id→version` 指纹并以**变异实测**闭环。**F10 钉** `2eb768217` 补 digest park 后 re-arm 的可红性（变异 `mutations/F10-revert-rearm.diff` ⇒ 1 red / 15 pass）。**cancel 半**：无可达公开入口，`d51118e32` 据实标注为不可达纵深防御——**不作已解**。**#2241 二期已落地**：TS 排序机制（#2392 IDF 加权 + #2400 稳定 tie-break + ranked marker）`0d353ae93`、Python `harness.search` IDF 折扣 `7baa7e5ab`、G5 接线 `4adab8a77`（`_buildHarnessDigestQueryTerms`：goal×3+近 4 条衰减、48 词封顶，传进 `_renderHarnessDigest`）、G6 状态指纹 `81f964022` + 不变量钉 `3c862d9fb`。**中途一条真红与真因**：G5 单落时 `agent-session-recursion.test.ts:2841` 确定性红（leaf 不等），母席的空状态假设被施工席用埋点证伪——真因是**新鲜度判据用渲染文本比对**：同一 harness state（全局库 1243 条）首轮载体 6773B、navigate 冷边界重渲 7058B（terms 不同⇒排序窗不同）⇒ 误判 stale ⇒ 追加载体 ⇒ leaf 动；修法＝改 sha256 **状态指纹**（覆盖渲染实际读的字段，**刻意排除 query terms**，故措辞漂移只影响下次投递的排序、不触发投递），#2098 三机制职责不变（时间戳＝最新载体选择器、stamps＝lstat 预过滤、版本图＝回执跳过）。母席 forward-revert 保住干线可推（`aea98d0ce`）后按新笔复原（`4adab8a77`），**未改历史**。**#2334 已落地**（v2 十四笔，详见 §9.2 该行）。
| ④ | 待办笔清零：keepRecent/切点密度重标、content-density 口径统一、provider-retry 接线、top-bar/prompt-highlight 随 #2131 的 tui 接线、#2145 残余、attached-daemon archived 行、hook 抛错裁量、kimi-k3 计价落定或估价标注 | **已闭环**（八项逐条见 §9.2） | 密度+口径 `ac60d4607`；retry 接线 `0a6377d35`；#2145+archived 行+hook 裁量 `5924d4d0c`（wire 半 `5f58846dd`）；top-bar/prompt-highlight `91bfa0bd2`+`a27147890`(+`ae445deee`/`5adf6410a`，本轮已推 `origin/merge/repl-kernel`)；kimi-k3＝「未定价」注记形式落地（FORK_NOTES:30）。余下真待办移 §9.2（非本行列名项） |
| ⑤ | CI 对合并头 13 job 全绿（machine-wide 在隔离时段跑绿、test-hygiene 绿、tag-skip 账对得上） | **已闭环**（run `35298259416` @ `958a5dc68` success ＋ run `35299277503` @ `3c862d9fb` success，13 job 全绿；`3c862d9fb` 含 #2241 二期与 process-smoke 本地镜像闸） | **五轮红＝4 处 job / 6 条真因**，逐条真因与修法：① **platform registry 缺行**——`repl-kernel-startup.test.ts` 的 `it.skipIf(win32)` 未登记，Build and check 红（`49e94f491` 登记，撤行即红正控）② **DAT-4 注入点死**——mock 打 `writeFileSync`，写者自 `69fb8ead6` 起改 `openSync+writeSync` ⇒ 仪器腐烂读成绿（`144bfa2e2` 改打 `writeSync`＋直写正控＋变异对照）③ **monitor 步数预算＝伪装的挂钟预算**——40 步仅值 0.7–1.8ms、回合实需 15–199 步（`91da42b93` 改 settle 闩锁＋4 正控）④ **waitForFile 只等存在**——`open` 先落地名字可见 size=0，放行后 SIGKILL 留永久 0 字节 marker（`e17535e07` 改等内容；本机 121 轮自然不可复现 ⇒ 正控改确定性注入并显式登记自然红未复现）⑤ **afterEach 等 socket 消失 ≠ 进程退出**——daemon 在 `rmSync` 期间重建 `<root>/agent` ⇒ ENOTEMPTY，而 Node 的 `maxRetries` 只重试 rmdir 从不重新下钻（`de1ad0b06` 改等 registry 里的 pid 退出，照搬 4685 兄弟文件既有成例）⑥ **process smoke 两例计数各多 1＝#2098 的预期新行为**——digest 出系统提示后进上下文，恢复/收养会话在冷边界恰好一条 `custom_message:harness_digest`（探针 dump 实证；无重复投递、未计入 worker/roster、无 stale 残留），`958a5dc68` test-only 钉住载体计数与 shape 并以「第二次冷边界仍是 3 不是 4」钉去重，三枚变异全红（撤修 2 红／摘冷边界注入 2 红／破坏身份去重 `expected 4 to be 3`）。红的 run：`35285177049` @ `9ff1e92c8`、`35285904861` @ `082a5d37c`、`35286568968` @ `144bfa2e2`、`35291808440` @ `91da42b93`、`35296425559` @ `d51118e32`（坐实＝process smoke 2 例，即真因⑥）。**闸口径教训（已落地）**：`test:ci` 有 11 个 `--exclude`、第一个就是 `daemon-supervisor-process.test.ts`，本地阶梯原先只镜像 kernel/machine-wide/runtime-python 三专 job ⇒ 该文件在两套本地口径都不在场、NEW-RED=0 对它零信息；现补第四专 job 本地镜像 `npm run check:process-smoke`（`1f4dda40d`，四步＝跑 `test:process` 出 JSON→逐文件台账→coverage 地板 `--min-tests 20 --min-ran-tests 11 --max-nothing-files 1`→tag-skip ledger 对账 8+4；本地读数 collected=24 ran=12 passed=12 failed=0 skipped=12、GATE GREEN）。该闸自带的「一个面悄悄消失」正控最值钱：给一条正在跑的用例偷偷加 `tags:["process-stress"]` ⇒ vitest 仍 exit 0、coverage gate 仍 GREEN（ran=11 恰等于 CI 地板），**只有 ledger gate 红** ⇒ 第四步才是真兜住面消失的那步。12 例 skip 的判据是 **tag** 不是 env/平台，旧「本机跑不了」记录已被实测推翻 |
| ⑥ | 吸收审查 A/B 零未处置项 + 合并文档定稿推送 + FORK_NOTES 全记账 | **已闭环** | 文档＝本文件 **v1.1**（v1.0 `082a5d37c` 已入库并推；v1.1 由本席写入、**母席提交**）；FORK_NOTES＝`e11e4a8ca` **三行记账**（merge 波 / #2098 四笔 / CI 绿五笔真因＋notice 纵深防御）；吸收审查 A/B **零未处置项**（B 侧发现已逐条落：`b8375478c` 纵深防御、`b2a0d8da6` 文档对账、`d51118e32` cancel 半据实标注） |
| ⑦ | 真机验收：重启后 subagents 行花费格可见且与 /usage 同树对账一致、压缩在真实 token 80% 触发（kimi-k3=800000）、子代理回执不再打断压缩（老板现场场景复现） | **待办** | 花费格 v1+v1.1 已落（`1917d1049`/`9ff1e92c8`）但真机重启验收未见记录；压缩 80% 口径（kimi-k3=800000）与「回执不打断压缩」由压缩安全束本地 pin 钉住（FORK_NOTES:20），**真机复现待做** |

**一句话（v1.1）**：① ② ④ ⑥ 已闭环（⑥＝文档 v1.1 + FORK_NOTES `e11e4a8ca` 三行 + 审查 A/B 零未处置）；③ **部分闭环**——#2098 三刀＋F1 路 A＋三效果正控已落并过两席异构复核，cancel 半据实标注不作已解，#2241（一期残件两笔 + G5/G6）与 #2334（五笔出卷、复核 FAIL 可修、v2 在修）在飞；⑤ 待 CI 对 `d51118e32` 那轮定论（前三轮 3 处 job / 5 条真因已逐条修落）；⑦ 待老板重启验收。

---

## 11. 裁决记录（裁决席 07 号件 + 母席拍板，2026-09-17）

| 项 | 裁决 | 依据/退路 |
|---|---|---|
| QP-4 × #2334 | **全量移植**：人优先仅限 lane 内，机器互序不变 | 跨 lane 形态被上游测试钉死；退路＝仅 interactive 提权→则该笔 no-take |
| C18 daemon 崩溃策略 | 追认 log-and-isolate，阈值 off（0 触发） | 现状零触发，追认成本最低 |
| C12 replay 真缓冲环 | 追认缓行 | 先对账 775 条/天 gap；环挂在 recover 成本上，不单独做 |
| C21 混版窗终态 | 维持协商式 | bump 挂 v5，本窗不动 |
| catch-up 放弃→踢下线 | 本窗不移除 | 移除会改运维语义，留待独立窗口 |
| F18 两暂认值（venv.old=1 / 收养 create=300s） | 均追认 | 实测无不良反应，追认即闭环 |


---

## 12. 效果护栏（老板硬约束 · 2026-09-17 · 优先级最高）

**优先级序：模型效果 > 成本 > 工程量。** 任何省钱、重构、移植动作与效果冲突时，效果赢；本节约束凌驾 §3/§5 的取舍。

1. **效果正控门槛**：凡改动模型可见上下文（系统提示、harness digest、refinement 回执、skill/记忆注入、思考档位、输出预算），必须带"改前/改后行为对照"正控：同任务同输入，断言模型可见面不缩水（记忆条目可见、skill 指引可见、被拒 refinement 条目可见、思考预算不被 JSON 吃光）。正控红＝回滚，不接受"成本绿了就行"。
2. **#2098 专项**：digest 出系统提示后，新记忆/新 skill/新 harness 状态必须**下一轮模型可见**——主路径 material-change 再注入（append-only delta），冷边界（新会话/压缩/resume）只作兜底；长会话禁止出现"记忆菜单冻结"。
3. **已落地项效果面复核结论**：#2220 的 auxiliaryModel 默认未设置⇒精化两趟仍用会话模型，行为不变（若显式设置便宜模型则精化质量降，属显式选择，设置界面需注明）；#2130 只拿 1024 下限、保留"非 reasoning 保 JSON 输出预算"，不削弱；#2218/#2275/#2243/#2228/#2308/#2285/#2219/#2307/#2251/C7 均不碰模型可见面（UI/计数/守卫/错误文案）。
4. **合并窗口**：上游 UI 简化族（#2193/#2183/#2180）本轮不跟的理由之一即效果/口味面风险；#2098、#2241 排序类改动一律先过效果正控再谈成本收益；§3.2 的成本数字只作排序依据，不作砍功能依据。

---

## 13. P5 预准备结论（p5-prep 席，/tmp/p5-prep/，2026-09-17 深夜）

1. **取号 38**：上游 27/28/29 机核复现（27 与 26 同 ID `962b8b4c5e35`＝盲窗实证；29 的 `a5c9d20f8b13` 为手写，独立复算应为 `71a042ac1a62`）；兼容表 `abort_and_send_queued` 的 minSchemaRevision 29→38；头注登记草稿含三条含义与 ID 尾，并修一句过期头注。
2. **digest 操作单**：净树跑通红→绿流程已验；只改号 digest 不动；加三条上游 wire 后得 `38-9b2fcc320f77`；再加 R6 裁决的第 17 片（连接侧 savedSession model）得 `38-5eda61debb7b`——**两值仅作参照、禁粘贴**，落地一律由测试重算。
3. **五组兼容测试草稿**在 /tmp/p5-prep/tests/；busy-stale 拒绝一组已实测正控过、负控红。
4. **裁决：abortAndSendQueued 的退化语义**——上游对无 capability 的老 daemon 静默退化为普通 abort；本仓裁为**退化但响亮**：退化到 abort() 的同时落一条 warn 级 notice/回执说明"排队消息未随中断发出、原因=daemon 无 abort_and_send_queued 能力"，与全仓"响亮优先"文化一致。
5. **版本面件数纠正**：派单写 24，四种口径复算均为 **17 件**（复跑命令在 /tmp/p5-prep/）；以 17 为准，不凑数。tui 单包动版本号会 ETARGET 破坏 lockstep，恢复命令已备；`npm -ws` 够不到 root，lockstep bump 必须在根跑。
6. **update-source 裁决**：自更新**安装路径**已有 fork 闸门（c1daaff3f 拒自更新），没闸的是**启动升级提示**；两处置 diff 草稿在 /tmp/p5-prep/（禁提示 vs 文档明示），残余洞＝marker 不进包；裁：**P5 同窗做"禁提示+文档明示"双保险**。

---

## 14. 承重件裁法与母席拍板（p3-plan-1/1b 双份 + p3-reconcile 对账）

裁法表：/tmp/p3-plan-agentsession.md（77 行：agent-session 60 块 + session-manager 17 块；分布 取上游 12 / 保我们 28 / 人工并集 22 / 等落地 15）；双份独立产出的分歧由 p3-reconcile 席对账（/tmp/p3-plan-reconcile.md）。
执行顺序：P0 独立块 → P1 挂起批 → P2 十个成组批（sm17→5/8/9→6/7，导入表最后）→ P3 尾闸；每块回滚把手在表内。
**母席拍板两项**：
1. **symlink / read-only-open 安全取向**：保我们更严的取向（private-files 的拒 symlink / 0600 / O_NOFOLLOW），不随 #2028 放宽；与上游的偏差写进提交说明与本文档，作为 fork 安全基线。
2. **as 块2 refine 通知形态**：采用上游 durable `refinement_notice` 的投递机制，但渲染必须保留 MV-5「被拒条目可见」（与 §3.2 #2098 裁法一致）；notice 与 outcome 不双投递（去重 pin 已有）。

---

## 15. 收口记账（2026-09-18 凌晨）

- **压缩安全束十笔全落并推**（b407d0feb…7324d1f55）；验收按复核席口径记账 **56 例绿**（回归 8 + 准入矩阵 20 + 分类器 18 + 密度 6 + UI 抬头 4）；第 10 笔补两缺口（admission pause 白起压缩、watchdog 只有一发）。
- **C5 = ad7024f76**（supervisor availability settle 句柄，30s 挂死复现红→确定性绿 3×104/104）；r42 flake 台账 F1 记已消。#2336 四竞态＝ec33fd473(3/4, ④ N/A)+C5。
- **P3 承重件执行已开**：p3-exec-as（agent-session+session-manager，0902）与 p3-exec-repl（repl-manager+daemon-supervisor，K3），裁法单一来源＝/tmp/p3-plan-agentsession.md + /tmp/p3-plan-reconcile.md 终裁 + /tmp/p3-plan-repl-supervisor.md；#2284/#2334/#2098 接收侧排在 P3 的挂起批/NC 区，不另开脸。
- **p3-plan-2 纠正采纳（v2 修订版）**：#2213 我方已移植（01f106f26）不重做；**#1947 v1 的 fd 直交结论已撤回**——我方 7f5e1ba3a 是上游第 1 迭代吸收、c4f12355b 自述未取上游 pipe+budget、上游终态 5c2750bdc 明写放弃 fd 直交 ⇒ 底座取上游 host 中继+预算、我方硬化施加到 openStderrLog，定位读退场；步进补偿时钟不在 repl-manager（保块 7 即保住）；atomic-file 两侧逐字同、真问题是上游 wrapper 丢 fsync/fsyncDir（补 fsync 不照搬 wrapper）。另记 p3-exec-repl 裁示：双 ring 命名 A1、块 7 错误形状本窗案 A（typed error 案 B 入 P5 异构复核）、connect 2000→30s/90s 条件裁、4677/4602 接受删除+fixture 迁移顺修 3 红、admission 5s 租约 vs 5min 孤儿窗须测试证实或证伪。**编号警示**：p3-plan-2 的 C1-C5 是对母文档的纠正编号，与「C5=ad7024f76」同号不同物。
- 复核纪律升级（已入记忆）：按波复核分量比对红名单；落地闸＝纯净树 tsgo＋邻接测试集。

- **应用波终态（2026-09-18 07:0x）**：merge `67334bf1a` + 应用十笔到 `9ff1e92c8` 已推 `origin/merge/repl-kernel`；CI 对该头 run 35285177049 = **failure**（10/13 job 绿；红＝test-hygiene、Build and check 的 platform-coverage registry 缺 `repl-kernel-startup.test.ts` 行、coding-agent 1/3 的 `dat4-manifest-atomic-write` torn-write 例）。tui 接线四笔本地到 `5adf6410a` 未推；六闸终读见 §6.5（NEW-RED=0）。**未 push、未合主干、未推 tag。**
- **收尾波终态（2026-09-18 09:42）**：`082a5d37c`（文档 v1.0）→ CI 绿五笔（`49e94f491`/`144bfa2e2`/`91da42b93`/`e17535e07`/`de1ad0b06`）→ #2098 四笔（`49b326b51`/`abae4f9bb`/`bdd1ad5b7`/`78af6fc4d`）→ `b8375478c`（纵深防御）/`b2a0d8da6`（文档对账）/`e11e4a8ca`（FORK_NOTES 三行）/`2eb768217`（F10 钉）/`d51118e32`（cancel 半标注）；`67334bf1a..d51118e32` 共 **29 笔**（含 merge 30），全在 `origin/merge/repl-kernel`（`git ls-remote` 实测）。本文档 v1.1 由本席写入、**母席提交（本席不 commit、不 push）**。
- **复核方法论（本波新增，已入口径）**：**变异必须打在真失效面承重变量上**——`agent-session` 每提交轮都会把 live prompt 复位成 `_baseSystemPrompt`，**只改 live prompt 的变异会被自愈成假绿**；同理 `78af6fc4d` 的变异打在豁免判据本身（`kind:scope:id` 键存在 → `→version` 指纹）而非旁路。凡声称「变异可红」的回执必须写明：变异落在哪个变量、该变量是不是承重面、红的是不是目标钉；说不清按未验证计。
- **正控例数口径**：见 §9.1a 末注——#2098 正控文件 **16 例**（13→15→16），凡写 13/15 处同批改。

---

## 附录 A · 输入与席位

- 试合并冲突地图：`/tmp/merge-doc-inputs/01-trial-merge-conflict-map.md`
- 上游 20 笔调研：`.../sub-b98ca323/upstream-20-survey.md`（+ /tmp/rlm-survey/batch1-4.md）
- 欠账盘点：`/tmp/fork_unfinished_20260917.md`
- 席位：merge-trial-map / upstream-audit-rlm / upstream-audit-ux / merge-protocol / merge-specs-core / merge-specs-ux / merge-gates / debt-batch-1 / port-batch-S / S2 / S3 / guard-complete / merge-review-0902 / merge-review-ds / merge-2098-plan / merge-adjudicate / merge-p1-clusters / p3-plan-1 / p3-plan-1b / p3-reconcile / p3-integration / p3-exec-as / p3-exec-repl / p3-final-exec / apply-wave（第一/第二席）/ apply-wave-2 / apply-tui-wiring / perf-spend / perf-spend2 / doc-v1
- 落地读数件：`/tmp/apply-wave/LEDGER.md`、`/tmp/apply-wave/GATES.md`、`/tmp/p3-final-ledger.md`、`/tmp/p3as-file-rulings.md`、`/tmp/p5-prep/`、`/tmp/p5-out/`、`/tmp/spend-perf/`、`/tmp/ds-p3fix/`、`/tmp/p3dens-patches/`、`/tmp/p3w-retry2/`、`/tmp/p3w-app3/`
- ** caution**：复核席两个取证 clone（/tmp/mr0902-clone 停 merge 冲突态、/tmp/mr0902-cp 停 cherry-pick 冲突态）复用前必须 `git merge --abort` / `git cherry-pick --abort`

---

## 附录 B · 标红移出全表

见输入件 `/tmp/merge-doc-inputs/06-p1-clusters.md` 附录 B（119/136 笔逐笔表，其中 51 笔只命中我方 1-2 个文件）。

> **对账（母席 2026-09-18，§3.2 与 §14.2 的 notice 口径收口）**：本窗**不取**上游 durable `refinement_notice` 的投递机制——死调用点 `_recordRefinementNotice` 与其 lint 抑制已删净（`grep -rn "_recordRefinementNotice|noUnusedPrivateClassMembers" src` 零命中）；但**词汇面保留**作上游同步预留（`REFINEMENT_NOTICE_CUSTOM_TYPE`、`RefinementNoticeMessage`、`createRefinementNoticeMessage`、`formatRefinementNoticeBody`、input-classification 分类行仍在，当前**零生产者**）。refinement 回执渲染保留 MV-5（refused 条目带非空原因可见）。纵深防御：headless-completion 的终值跳过表已加入 `REFINEMENT_NOTICE_CUSTOM_TYPE`，若读到上游形态写的旧 journal，notice 不会被当成终值输出。
>
> material-change 再注入为 §12.2 的主路径（路 A）：`readHarnessStateStamp` 廉价扳机（stamp 未动那轮 harness_state.json 读取次数为零，用读取计数钉而非计时钉）＋条目 `kind:scope:id→version` 指纹差集（并排掉本会话回执已报过的**同一版本**）＋全程复用 `HARNESS_DIGEST_CUSTOM_TYPE`＋cancel/park 剥到 digest 即 invalidate baselines 并 re-arm＋只尾追不改写在前载体；冷边界（构造尾/主压缩头/emergency shrink/树导航）只作兜底。
