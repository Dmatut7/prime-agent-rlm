# Fork 更新记录

本文件是这个 fork 的**更新日志，最新的在最上面**。每条记录写清楚：改了什么、为什么改、对用户 / AI 能力的影响。深入细节见每节末尾链接的 `docs/fork/` 文档。

- 主分支：`merge/repl-kernel`（推送到 `fork/merge/repl-kernel`，github.com/Dmatut7/prime-agent）
- 上游同步分支：`sync/upstream-r3`
- 旧审计文档（R1/R2）：`docs/fork/audit-findings.md`、`docs/fork/fix-plan-r1.md`、`docs/fork/fix-plan-r2.md`

---

## 2026-09-05 · R3 上游同步 + 全面复审 + 第一批修复

这一轮做了三件事：① 把官方又新增的 40 个提交同步进来（R3）；② 对整个 fork 做一次全面复审（6 个维度 × 两个不同模型交叉对质）；③ 把复审出的最高优先 7 个缺陷修掉、并入主分支、推送。下面按"你能不能感觉到"排。

### 一、R3 上游同步（官方 40 个新提交，2026-07-23 ~ 07-29）
- **做了什么**：把官方 main 自上次同步后新增的 40 个提交合并进 fork（merge commit `3367d85c4`，涉及 197 个文件，43 处冲突逐块手工解）。
- **最大件**：daemon 协议 schema revision 26→27（digest `589a2219bc8b`）；CHANGELOG 恢复"只写 fragment、不直接改 CHANGELOG.md"的流程；cherry-pick 了 3 个官方 PR（#2027 / #1947 / #1896）。
- **本地东西一个没丢**：264 个本地独有文件、54 个本地独有测试全部保住、零覆盖（硬约束：全程用 merge，绝不 `git checkout upstream/main -- .` 整树覆盖）。
- **状态**：✅ **已合并回主分支 `merge/repl-kernel`（本次 merge-back，schema27 基线就位）**；F4（别车道未提交工作）已解决。完整同步详情（40 提交逐条 / schema 23→27 撞号史 / #1896 fork 适配 / S9 待办）见下节「2026-09-04 · R3 上游同步（详情）」。

### 二、全面复审（6 维度 × qwen3.8-max-0902 + kimi-k3 双向交叉）
- **做了什么**：6 个 lane（正确性 / 性能 / 业务逻辑 / 代码质量 / 优雅性 / 垃圾代码审计），每个 lane 由两个**不同**模型独立审、再逐条对质收敛——避免单模型盲区。
- **产出**：全新记录 `REVIEW_FINDINGS.md`（28 个修复簇，编号 F1-F28）+ `FIX_PLAN.md`（修复计划，经多模型双审通过）。这两份取代旧的 `docs/fork/audit-findings.md`。
- **沉淀的复核纪律（62 条）里最关键三条**：
  - **总闸原则**：任何优化都不能降低 AI 的能力。这条抓出并修正了 2 个"看似优化、实则降能力"的修法。
  - **验收恒真检测**：每个断言 / CI 门必须有"植入已知违规 → 必须红"的正控，否则门是假的（恒真）。
  - **grep ≠ 可达性**：grep 到危险模式只证明模式存在，必须读包住它的代码确认它真能触发。

### 三、第一批修复（7 条，已并入主分支 + 推送，HEAD `4871d9223`）
全部满足"对 AI 能力提升或中性"（总闸零违例）；每条带回归测试（先红后绿证明）+ 变异测试（锁住每个修法分量，半变异也得红）。

| 编号 | 用户能感觉到的问题 | 根因 → 修法 | 对 AI 能力 |
|---|---|---|---|
| **T12** | 长时间跑后终端报 MaxListenersExceededWarning、最后废掉 | 每次 sleep 调用泄漏一个 abort 监听器 → `{once:true}` + settle 时 clearTimeout | 中性（行为逐字不变；变异测试锁两段修法） |
| **T0** | （看不见——是防回归的门） | 测试债无门拦截、私有探测泛滥 → 加 `test-hygiene` CI job（私有探测扫描器）+ 测试可信度三修 | 中性（零生产代码改动） |
| **T5** | google/vertex 返回畸形工具调用时，工具竟被执行了 | stopReason 把畸形调用洗白成 end_turn → 路由到 malformed-tool-call 错误路径 | **提升**（畸形工具不再被误执行） |
| **T3a** | 编辑器输入某些宽字符（不可断 grapheme）→ 栈溢出 → 整个终端崩溃（E6） | 递归无守卫 → 加 `subSegments.length < 2` 守卫 | **提升**（拼接还原逐 code point，不丢输入） |
| **T9** | anthropic/bedrock 带 thinking 的会话，每个后续回合必挂 400 | thinking 签名跨回合重放污染 → 剥掉非末回合签名 + 降级为 text | **提升**（每回合必挂 → 可降级续聊） |
| **T7** | 高频 mutating command 时 daemon journal 每条 fsync 拖慢 | per-record fsync → 去 append fsync、compact 时 fsync 保留、journal 限界 | 中性（掉电窗口 ≤4096 条 / ≈5.4 分钟，已在 changelog 诚实披露） |
| **T1c** | 大工具参数时 UI 每帧 O(n²) 重算 argsSignature、卡顿 | 每渲染重算 → O(1) 缓存 | 中性（rebuild 触发集合 ⊇ 修前，不漏渲染） |

- **合并怎么做的**：先建一条干净集成分支、验证 7 条改动文件级零重叠（任意顺序合并无冲突）→ `npm run check` 全绿 → 受影响包测试全绿（tui 200/0、ai 36 passed、coding-agent 137/0）→ ff-only 并入主分支 → 推送。**全程别车道的未提交工作完整保留**（porcelain 始终 13 行）。

### 四、还没做（下一批 · R3 已合回 → schema27 基线就位、F4 已解决、可立即并行开工）
复审出的 28 簇里，第一批做了 7 个最高优先、且与 R3 零交集的。**R3 merge-back 已完成（本提交）、schema27 基线就位、F4（别车道未提交工作）已代提交解决**，剩下 21 簇现在都能在 schema27 基线上开工（不再冲突）：
- **第一批 R3-交集 10 条**：T1a/T1b（流式节流）、T2（fork 错误恢复四件套）、T4（崩溃放大器）、T6（压缩三机制）、T8（OSC133）、T10（retry 假死）、T11（BrandSplash）、T13（side-question 流停滞）、T14（refine 窗口）。
- **第二批 F9-F16**：bedrock token 口径、response.incomplete、schema digest 门、出站表、contract 工单、gpt-5.5 定价、handoff msg id、usage.input Math.max、垃圾代码纯删。
- **第三批架构 F17-F25**：god-object 拆分、循环依赖解除、测试与生产分歧。

细节文档：全面复审 `docs/fork/review-findings-r3.md`、修复计划 `docs/fork/fix-plan-r3.md`、R3 同步任务书 `docs/fork/sync-upstream-r3.md` + 附录 `docs/fork/sync-upstream-r3-appendix.md`（已随 R3 合入主分支）。

---


## 2026-09-04 · R3 上游同步（详情）

分支：`sync/upstream-r3`，基线 `merge/repl-kernel` @ `0c504e475`。任务书本轮起随代码入仓：`docs/fork/sync-upstream-r3.md` + `docs/fork/sync-upstream-r3-appendix.md`（`daemon-protocol.ts` 的 schema 注释直接引用其中的 S5.1 表）。

### 同步了什么

一次 `git merge upstream/main`（`d74a75fea`，**40 个上游提交**，197 文件 / +18437 −1704）：本地 **172** 个自研提交对上官方 0.9.x 线。冲突 **43 块 / 18 文件**全部手工解，每块记「取了谁、为什么、翻回把手」（12 份车道回执存档）。

| 提交 | 内容 |
| --- | --- |
| `3367d85c4` | merge commit（2 parent：`0c504e475` + `d74a75fea`） |
| `2f72fe3d1` | S5：`DAEMON_SCHEMA_REVISION` 26 → **27**，digest 重算为 `589a2219bc8b` |
| `ea68ff750` → `9ee1ea51c` | S6：先重建 4 个包的 CHANGELOG Unreleased（101 行），后按 AGENTS.md「不手改 CHANGELOG」**revert**，改走碎片单一真相流程 |
| `e59a452ce` | 碎片格式修正：#1249 碎片补 issue 引用、#1229 bullet 收口 |
| `bc012cfb2` | rlm-ledger `replayCache` 失效与克隆隔离的白盒钉（A-2 变体 A） |
| `ebb26a3ac` | S7 摘 **#2027**：RLM 子树取消改一次迭代 visited 遍历（治本地 `hasRunningRlmChildren` 等三个 walker 的 2^k 重走） |
| `7f5e1ba3a` | S7 摘 **#1947**：kernel stderr 落每会话日志文件 + fork 适配 3 处（`0o600` + no-follow，堵住 lane B 风险 R6 重开 F3 的口子） |
| `f22e65312` | 修 merge 引入的红：`fixq5-q7` 假 supervisor 缺 roster 桩（F73） |
| `13f623676` | 修 merge 引入的红：`agents-view-roster` 假 connection 缺 `streamReconstructor`（F74） |
| `bdd5bcd82` | 修 merge 引入的红：非持久化会话不再落 `semantic-edges.jsonl`（F72） |
| `bd35d1287` | 修测试污染：`agents-view-roster` attach 测试隔离 agent 日志目录（F77） |
| `b20f16427` | S7 摘 **#1896**：空终回合重试（最多 3 次，空的那次弹出、不进 provider 上下文与 transcript，第 3 次连续空当回合错误上报）+ **2 处 fork 适配** |
| `7a6e74c57` | 碎片归并：空回合重试的 2 个碎片合成每包 1 个 |

**#1896 已摘（`b20f16427`，6 文件自动合并零冲突，+235 −13）**，预判的两处 fork 适配都落地了：

1. `packages/agent/src/agent-loop.ts`：本地 stream-stall 返回路径（`finishStalledMessage`）在重试 wrapper 接管 `message_end` 发射之后仍保留自己那次 emit ⇒ 一个 stall 回合**双发 `message_end`**（`appendMessage` 无去重 ⇒ 同一条助手消息落盘两次，扩展 handler 与 telemetry usage 双触发）。删掉内层 emit，与 PR 处理 `finishAbortedMessage` 的方式对齐。
2. `packages/coding-agent/src/modes/interactive/interactive-mode.ts`：每次重试都发一个新的 `message_start`、被丢弃那次没有 `message_end`，而 `startAssistantStreamingMessage` 无条件覆盖 `this.streamingComponent` ⇒ 前一次的组件留在聊天树里未 settle。改成**先 settle（或移除）前一个组件**，对齐 `agent_end` 边的做法（这正是 lane B 风险 R5 预言的幽灵气泡）。

另记一笔（p11 实测）：`agent-session.ts` 那个 hunk 在本 fork 的生产路径里是**惰性**的——本地 F70（`f98d84ada`）的终错通知已经先回了父代理并 bump `_parentReplyCount`，而那正是该 hunk 的守卫条件。仍整取，因为上游的 recursion pin 用不带 agent-message controller 的夹具走它。

### schema 23/24/25/26 四层撞号 → 升 27 的由来

分叉点 `5b6c0e94e` 是 rev 23。此后**本地与上游各自把 23/24/25/26 用了一遍**，同号不同 wire：

| rev | fork 侧 | 上游侧 |
| --- | --- | --- |
| 23 | `omitStreamingMessages` on list | `list_agent_peers`（`ceb418049`, #1861） |
| 24 | 重编号，含 rev-23 两特征（`bf542ce7e`） | roster 订阅与推送（`1d2e91d3b`, #1900） |
| 25 | `streaming_deltas` + `assistant_stream_delta`（`c72b9940f`） | 直连 worker peer transport（`173d845a5`, #1926） |
| 26 | 服务端 capability 强制 + `control_plane` + `declare_client_capabilities`（`96d3db580`） | 会话行 usage 合计（`d74a75fea`, #2003） |

merge 后 wire 是两侧并集，**哪个 26 的 digest 都不匹配**；本地握手是 `schemaId + appVersion` 精确匹配、无协商降级 → 不升号则本地客户端把官方 daemon 判 stale、反之亦然。处置：`DAEMON_SCHEMA_REVISION = 27`，digest 用仓内算法重算（sha256 三段切片取前 12 hex = `589a2219bc8b`，**禁手写**），6 个切片锚点复验「各命中 1 次且严格递增」，公式对三个基线（本地 `31fb64b6f4ee` / 上游 `962b8b4c5e35` / 分叉点 `649fe649d15e`）逐一复现。**23-27 五个号永久退役**（27 已被本轮 R3 的并集 wire 消费，`DAEMON_SCHEMA_REVISION = 27`、下一个可用号是 **28**；下一轮取号前必须先读 `daemon-protocol.ts` 的头注，否则会出现第五次撞号），撞号表与两侧 digest 已写进 `daemon-protocol.ts:79-108` 的注释（行号会漂，按 "Revisions 23, 24, 25 and 26 were each claimed twice" 这句 grep 定位）。

### 丢了哪些本地实现（有意取舍，均带依据）

| 本地轴 | 处置 | 依据 |
| --- | --- | --- |
| 刷新节流轴：`scheduleWorkerSummaryRefresh` / `CoalescedSummaryRefresh` / `SUMMARY_REFRESH_MIN_INTERVAL_MS` / `lastSummaryRefreshAt` | **删净**（全仓 0 命中，无孤儿） | 上游 #1897 + #1900 改 roster 事件驱动 + delta 推送，「按 token 拉全量摘要」的路径本身消失 |
| `handleList` 每次向所有 worker 各拉一遍 list | **删**（取官方 roster 遍历，`handleList` 零 worker 往返） | 留 ours = 把 #1897/#1900 的收益原地废掉；本地轴「客户端 list 必拿新鲜数据」改由 roster 推送 + `scheduleRosterRepairPull` 兜（见 `docs/fork/local-axes.md` 第 3 条） |
| `propagateHeartbeatStateToAncestors`（祖先行 running 提升） | **删**（随官方 #1967 `d72beaf9e` 有意删除，不恢复调用点） | `git log -S` 双侧 + base 三方定位确认是上游有意删；官方改「心跳会话是普通会话」 |
| `syncAgentPeers`「名单没变不重发」 | 早在 `bf542ce7e`（R1 上游合并）就没了 | 本轮才把 README 表格里这条过期项删掉 |
| `omitStreamingMessages` 的 supervisor↔worker 半边 | **保留但休眠**（尾参恒 `false`，唯一读者是一个本地测试） | 根代理裁定 (A) 保持现状；风险与清理触发条件记 `docs/fork/local-axes.md` 第 1 条 |

### 已知红清单（任务书 S8.4 的 5 项）与消红

| 红项 | 从哪一步开始红 | 消红于 |
| --- | --- | --- |
| H1 的 PLANE 总量表破口（核查脚本第 3 项 = 1） | S1.2 第 6 步 | 同步消红（v2 已把 S2.3 并进第 6 步） |
| `test/daemon-protocol.test.ts` 的 schema digest 自检 | S1.2 第 6 步（块 1 临时取 ours 的 26） | **S5 `2f72fe3d1`**（该文件 28 passed / 0 failed） |
| `test/daemon-supervisor-streaming-list.test.ts` | merge 那一刻（静默存活成必炸文件） | **S4**（p9 重写，把上游「`handleList` 不再转发」钉成 `expect(requests).toEqual([])`） |
| `npm run check` 因 `grok-mermaid@0.2.3` 未装而编译不过 | merge commit 落地那一刻 | `npm install` 之后（门1 实测 EXIT=0，Checked 1022 files，`--write` 零改写） |
| `tsgo --noEmit` 因 `mermaid.ts` 解析失败而红（与上一条同源） | 同上 | 同上 |

父代理裁定新增的第 6 项**不属本轮**：`test/extensions-timeout.test.ts:102` 在 merge 之前就红（`0c504e475` 上逐字同失败，独立 scratch worktree 对照实测）→ 记 **F75**，S9 待办认领。

本轮 54 个本地独有测试文件的收口总账：collected **320** = passed **319** + failed **1**（= F75）+ skipped **0**（205 + kernel 5 + agent 3 + ai 5 + tui 107，自洽）。

### 本轮新缺陷

7 条续 F 编号记入 `docs/fork/audit-findings.md`：**F71-F77**（接 F70c）。4 条已修（F72 `bdd5bcd82` / F73 `f22e65312` / F74 `13f623676` / F77 `bd35d1287`），3 条待办（F71 / F75 / F76）。同文件另记：30 个新 PR 的裁定台账与 3 条新判据、3 条路径纠错、4 条门方法论。

### S9 待办清单

1. **F71**：`src/core/semantic-edges.ts` 的写入改走 `src/utils/private-files.ts`（0700 / 0600 / no-follow）。`bdd5bcd82` 只挡住了非持久化会话，**持久化会话的 ledger 仍是裸 `node:fs` 写的**（`:357` `mkdirSync` 无 mode、`:363`/`:367` `appendFileSync`）。
2. **F75**：**R3 全面审查已实测 ⇒ 不修测试、据此关闭或重审**。`test/extensions-timeout.test.ts:102`（`errors` 实得 2 vs 期望 1）是**既有 extension-loading 家族红**，红因在 `loadExtensionModule` 实现、**不在 `loader.ts`/`timeout.ts`**：把 `timeout.ts` 换回 B1 修复之前的原文（`git show HEAD:`，sha256 `9c0814a6309f2870`）重跑**逐字同样红** ⇒ 与 B1 无因果；代码层佐证 `loader.ts:427-456` 串行加载、超时只包 `factory(api)`、**转译在超时之外** ⇒ 40ms 不可能让同步的 `ok.ts` 失败。**别改测试断言**（会把正确行为钉成错误行为）；要动就转 `loadExtensionModule`。
3. **F76**：`WINDOWS_NAMED_PIPE_ACL_UNVERIFIED` 死导出接进 `test/windows-named-pipe.test.ts`（**建议接不建议删**：它承载「这条安全面未真机验证」这个事实，删了等于丢一条已知未覆盖面记录）。**R3 全面审查补的三条事实**：① win32 侧 ACL 是**唯一**鉴权闸门（`daemon-mode.ts:3277` 对主 daemon 一律 `authenticated: true`、全仓无 peer credential/token 握手；POSIX 还有 `daemon-socket.ts:186` 的 `chmod 0600` 兜底，win32 无对应）② ACL 是在 `listen()` 回调里用 `SetNamedSecurityInfo` 打在「当时那个实例」上（`daemon-mode.ts:667`/`daemon-supervisor.ts:827`），libuv 建后续实例传 `NULL` `SECURITY_ATTRIBUTES`，**Windows 无文档保证继承** ③ **R3 只把 `.changes/windows-named-pipe-acl.md` 的完成态断言降级为 best-effort（去 "Restricted"），不做 token 握手**；握手（capability + 协议版本 + 双向兼容测试 + 真机验证）**记下一轮**，仍是收口前提。
4. `omitStreamingMessages` 休眠接缝二选一：给尾参找回生产调用者，或连唯一读者测试一起删。**（R3 全面审查补两点）行号更正：客户端活点是 `src/modes/agents-view/agents-view-mode.ts:217-230`，不是 `daemon-mode.ts:1898`（那是 cron）—— `docs/fork/local-axes.md` 里本来就是对的，错的是派单文本。启用前陷阱：`daemon-mode.ts:4184-4185` 会**无条件继承上轮的 `streamingMessage`** ⇒ omit 期间结束的 turn 会把大对象永久钉在 roster 上；启用时改成 `summary.isStreaming ? previous.get(...)?.streamingMessage : undefined`。**
5. 门 2 口径扩三层（54 个本地独有文件 / 15 个官方新增测试文件 / 共有文件里的本地独有用例）——本轮 F72、F74 两条红都在文件级口径之外，只有全量跑才保险。
6. R2 遗留里 **F5/F6 实际已在 R2 末期落地**（`96d3db580` + `7efe4b467` + `6e86b3929` + 测试 `6b8d2585b`；服务端强制点在 `daemon-supervisor.ts:1825`、`daemon-mode.ts:3655`，控制面分流在 `daemon-mode.ts:3558`），`audit-findings.md` 的 `[ ]` 本轮已按代码证据勾掉。仍开着的是：F15/F17 窄时序窗、F27e 次要内存项、Windows 管道 ACL 实机验证、k3 终审 7 条低危。
7. 30 个新 PR 里 lane B 判「观察」的 7 个（#1928 / #1996 / #305 / #1177 / #1252 / #2028 / #1581）与 deps 线判 TAKE 的 5 条（#2018 / #2017 / #1576 / #1577 / #1579 改拿 18.0.10）**本轮一条都没动**（实测 `actions/checkout` 仍 v7.0.0、`actions/github-script` 仍 v7.0.1、`uv.lock` 零变化），下一轮按 `docs/fork/audit-findings.md` 的台账接着裁。
8. **【R3 全面审查新增】#1947 staleness 与下一轮任务 B**：本 fork 摘的是 #1947 的 **09-02 版（`ca7f26ca5`）**；上游 **09-04 已把同一处重设计**（head `56982582b`，**仍 OPEN**、当天还推了 5 个 commit）为 pipe + host 转发 + 5MiB 写预算 + `StringDecoder` + exit-drain + 等 close。**那些是上游第 4-9 个 commit，本 fork 未摘 ≠ 删除**。一旦上游合并，本 fork 的 `wireChild`/`openStderrLogFd`/`waitForReady`/`cleanupResources` **四处必冲突**。**任务 B 触发条件**：#1947 合进 upstream main，或下一轮同步启动（以先到者为准）⇒ 按 head 重取，届时 pipe-path 的 `StringDecoder`/drain/last-words 与 `M3(k)`（无 per-spawn 预算 + `.old` 长存）一并解决、`M1(pr)` 的 tail 挤压自动消失。**A 批（本轮）只做设计无关的纯 fork-side 加固，不半迁移、不给 fd-direct 加 drain。**

---

## 2026-08-29 晚 · R2 迭代

在 R1 基线上追加了第二轮工作。

### upstream 二次合并（15 提交）

upstream/main 新增 15 个 squash commit，已并入（`71eeb5629`）。含 #1756（worker 恢复后再复用）、#1842（队列状态单一来源）、#1845（RLM 子快照单一投影）、#1859（quiescence 事件唤醒替代轮询）、#1882（官方版 bash 并发 abort）、#1864（in-flight open 所有权）等。冲突逐 hunk 解，并入后跑常驻回归套件。

### W0-W9 工单结果

- **W0**（upstream 二次合并）：完成。15 提交并入，冲突 5 个文件逐 hunk 解。
- **W1**（F70 子代理错误通知父代理）：完成。耗尽/永久错误 → agent_message 通知父代理（`f98d84ada`）；不做从零退避。
- **W2**（F10 edit 原子写 + F11 exec 进程组/输出截断）：完成（`577f1032b` + `8dde3fdfa`）。
- **W3**（#1253 移植：宿主拆除取消在途 kernel host 请求）：完成（`4afca168e`）。
- **W4**（F42 分支切点对齐工具对）：完成（`43798f22d`）。
- **W5**（B8 键绑定迁移）：完成（`142022669`，12 处迁入配置表）。
- **W6**（k3 低危十条）：完成。5 修 5 留档（`204fe7811`）。
- **W7**（F5/F6 安全收口：supervisor capability 校验 + shutdown 鉴权）：**在跑**。
- **W8**（F4 Windows 管道 ACL）：完成（`2637973c1`），标注「Windows 未实机验证」。
- **W9**（F15/F17 窄时序窗）：留档未开工（k3 实证可达性极低）。

### 文档搬迁

fork 工作文档统一搬入 `docs/fork/`：审计总账 `audit-findings.md`、R1 任务书 `fix-plan-r1.md`（原 `FIX_PLAN_20260829.md`）、R2 任务书 `fix-plan-r2.md`。`FORK_NOTES.md` 保持为简洁入口（`acd9b3ed1`）。

### R2 遗留（截至 R2，部分已被 2026-09-05 全面复审重新评估）

- F5/F6 安全收口（W7，在跑）
- F15/F17 窄时序窗（W9，留档）
- F27e 次要内存项（subagentSnapshots/sideQuestionTurns 未加帽）
- Windows 管道 ACL 实机验证
- k3 终审 7 条低危

详见 `docs/fork/audit-findings.md` 未勾条目与 `docs/fork/fix-plan-r2.md` 状态列。

---

## 2026-08-29 · R1 大合入

### 这次更新是什么

一次大合入：官方最新内核 + 官方未合并 PR 精选 + 一整天源码审计出的缺陷自修。三管齐下，测试 4580+ 绿。

### 内容从哪来

1. **官方 main 合并（18 个提交）**：最大件是内核换血——Jupyter/ipykernel 换成官方自研的极简 CPython REPL（`rlm.repl`，启动 1.2s→30ms，内存更瘦）。注意：官方把 `%%bash`/`%cd` 这类魔法语法废了，改用 `bash('cmd')`/`os.chdir()`。
2. **官方未合并 PR 拿了 9 个**（官方合得太慢，不等了）：#1882（bash 并发 abort 修复）、#367（Anthropic 工具参数丢失）、#1700（消息重复投递）、#1249（文件权限 0600）、#1251、#1253、#1519、#413、#887。另外 60+ 个 PR 评估后放弃（名单与理由在 docs/fork/audit-findings.md）。
3. **自修 40+ 个缺陷**：9 个代理独立审计 + 多模型交叉对质 + 三轮逻辑复扫出来的，每一个都有代码级证据。

### 解决了什么问题（按你能不能感觉到排）

- **内存不再膨胀**：以前跑两三天 TUI 进程 2.4~3.5GB，现在聊天记录有上限、图片用完即释放。
- **「卡死」有救**：bash 命令默认 10 分钟超时；任何卡住 5 分钟报警+留现场日志、15 分钟自动救活会话；4 个具体卡死根因已修。
- **子代理可靠了**：父催子消息不再丢；print 模式不再误杀还在干活的子代理；子代理死了会被发现。
- **粘贴不再假死**：半截粘贴 30 秒自恢复，Esc 可取消。
- **安全收紧**：会话记录 0600（同机其他用户读不到）；/share 上传前扫描 API key 并警告。
- **MCP 断了能自愈**：MCP server 崩溃后自动重连。
- **compaction 不再风暴**：小窗口配置下不再每回合狂压。
- **老用户升级不炸**：cron 迁移失败降级为日志；存量 0755 目录自动收紧不报错。

### 验证口径

- 每次并入：`npm run check` 全绿 + 交叠区域测试并集
- 终检：全量套件 4580 绿；失败仅剩网络依赖（telemetry/git-update/version-check）与重负载偶发，均有分类结论
- 修复全部带回归测试（先红后绿验证）
