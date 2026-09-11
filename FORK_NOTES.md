# Fork 更新记录

本文件是这个独立维护版本的**更新日志，最新的在最上面**。每条记录写清楚：改了什么、为什么改、对用户 / AI 能力的影响。深入细节见每节末尾链接的 `docs/fork/` 文档。

- 唯一主仓：[`Dmatut7/prime-agent-rlm`](https://github.com/Dmatut7/prime-agent-rlm)（GitHub 上不是 fork；本地 remote 名 `origin`）
- 主分支：`merge/repl-kernel`（只推 `origin/merge/repl-kernel`）
- 上游：`PrimeIntellect-ai/prime-agent`（本地 remote 名 `upstream`，只拉不推）
- 旧地址（路牌，不再开发）：`Dmatut7/prime-agent`（GitHub fork 网络，remote 名 `fork`）、`Dmatut7/prime-agent-x`（已归档，remote 名 `archive-x`）
- 上游同步分支：`sync/upstream-r3`
- 旧审计文档（R1/R2）：`docs/fork/audit-findings.md`、`docs/fork/fix-plan-r1.md`、`docs/fork/fix-plan-r2.md`

---

## 2026-09-11 · 多代理稳定性大修（五段死亡链治理）

范围：`merge/repl-kernel` `10b6b4e55..e1eb54bd3`，**54 笔提交、152 文件 +27634/−826**。本节收口基准 `e1eb54bd3`（工作区零残留；批 2 复核发现的幂等键真洞已回修闭合 `e1eb54bd3`，B1c 的诊断 polish 已由收尾车道落地 `6777e77f7`）。运维面（可观测签名 / 回滚开关 / 部署日清单 / flaky 清单）见新建的 **`docs/fork/ma-multistability-ops.md`**；本轮新 settings 键已补进 `packages/coding-agent/docs/settings.md`。

### 一、为什么改：审查实证的一条五段串联死亡链

前置审查（材料在 `/tmp/ma_audit/`，缺陷总表 `FINAL.md`）：6 条只读车道（K3/0902/flash 异构分工）→ 3 个异构验证器逐条攻定级（K3↔0902 互攻 + deepseek 核量级）→ 3 个活体探针实证。主线发现：

> 等一个子代理（或跑一条长命令）超过 15 分钟 → 看门狗误杀 → 误杀连带把全家子代理的回话通道焊死 → 父侧看到的却是「正常完成」→ 僵尸记账就此留下。

| 段 | 机制 | 生产/活体实证 |
|---|---|---|
| ① 误杀 | stall 活性判据 =「当前 cell 最近写没写自己 stdout」；健康长活儿与死锁的可观测历史逐字节相同 | 43 次 abort 全部 silentMs≈900000、在飞工具 144/144 全是 ipython；37 个被砍 cell 只剩 19 字符「Request was aborted.」；活体探针 900.0 秒整被杀 |
| ② 焊死 | requestAbort 不级联子代理、反而挂起父代理输入泵：子代理 send(parent) 一律硬抛、终态通知 5 分钟后静默丢弃、无法自愈 | 内核死后连 agent_message 都发不出（活体复现） |
| ③ 粉饰 | 终态分类只认 `stopReason==="error"`：被误杀 ⇒ 父代理收到「completed without sending a reply」；stall_* 事件不在父代理订阅分支里，零用户可见信号 | 本轮审查自身两例逐字符合 |
| ④ 砖化 | 内核意外死亡（OOM/崩溃/被杀）后会话永久砖化：`restart()` 全仓零调用者、每次调用抛「Kernel has been shut down」、死因只进内存环形缓冲永不落盘 | 2 会话各 7 连败其后 0 成功；kill -9 活体复现 |
| ⑤ 僵尸 | 记账与真相发散 | 73%（94/128）会话租约指向死 pid；rlm-ledger 46%（770/1666）指向已消失子代理 |

放大器（孤儿环）：abort/dispose 只沿活跃子代理走 ⇒「已完成→被追发→又派孙」的中间层下面的活孙辈杀不到，而 `hasRunningRlmChildren` 仍报忙。

修法来源：双独立设计（0902 + K3）→ deepseek 中立合并（21 冲突）→ 四维异构评审（correctness/capability/complexity/engineering）→ 合修终裁 C1-C21（`FIXPLAN_FINAL.md`）→ 红队四报（59 条新风险）→ 批次重排补遗（批 0 前置保护先上）。全程总闸：**任何修复不得降低 AI 能力；降能点必须逐条登记**。

### 二、改了什么：逐批次（50 笔）

| 批次 | 提交 | 内容 | 用户能感觉到什么 |
|---|---|---|---|
| **批 0 · 前置保护**（11 笔，`46cc03254`…`c21d47a76`） | venv 治理三件：技能集就绪改**超集判定**+记录**并集写**（根除多技能集 ping-pong 重装，`dd62e6832`）；bootstrap 锁 300s 超时+可取消+settings 化（`46cc03254`）；**版本化目录** `kernel-venv-<hash12>`（每个 build identity 一个兄弟目录；有活引用的目录永不 rename/原地重建/删除，在用重建一律 `defer` 显式报错）+ `.in-use` 引用计数 + 保留 1 份无引用旧代 GC（`ca92e1b34`/`c21d47a76`）。内核协议 **env 协商**（`PRIME_AGENT_KERNEL_PROTOCOL`，宿主默认请求 4、clamp [3,4]，协商 <4 禁发一切 v4 帧；`30c726254`/`6209e1d80`）。快照 **preserve_names 合并写**：部分恢复失败不再永久封笔，坏名字按名保留旧 blob、快照单调变好（`5943aa551`/`f396cdd30`/`5172aea6e`/`33ade94b8`） | 子代理首格「Starting Python kernel...」分钟级卡顿消失；内核重建不再 rm -rf 别的会话正在用的 venv；resume 后「状态全丢且无提示」变成有名单、有日志 |
| **批 1 · 死亡链**（9 笔，`c2a388dd6`…`0ef41c246`） | 终态**四态化**（error/aborted/stall_killed/completed_without_reply），失败类通知无条件发（解开 `_parentReplyCount` 闸）、父代理订阅补 stall_* 分支（`ef788e0db`）；Esc **不级联**杀子代理（C1 裁乙：Esc=只停当前回合），但 abort 级联**补齐孙辈**（孤儿环，settled 子树也走 cascade）；挂起泵期间 send → **queued 事实回执**（不再硬抛）+ `subagentWake.policy` 默认 `failure_aggregated`（失败类终态聚合唤醒一次，`562262c07`）+ 不可达终态通知转录直落 + sidecar 下次启动 reflow（不再 5 分钟丢弃，`780a29fec`）；豁免预算**按谓词封顶**（vouched 与 paused 单一合计预算 max(10×warn, 30min)，先修 touch 不清零的累加器缺陷，`c2a388dd6`）；19 字符谜团 → **被砍工具输出保全**（1.25s 有界收割 + 8KB 尾段，`8a6b8f1f4`）+ ipython cell abort 结构化死因（`f60529a43`） | 子代理被杀不再报「完成未回话」；被砍的 cell 能看到死因和部分输出；Esc 语义确认（杀树走 agents-view 显式入口） |
| **批 1c · 心跳与 vouch**（13 笔，`211a16c6d`…`9a2828d33`） | 协议 4 **内核活性心跳**：线程带外帧（`KERNEL_HEARTBEAT_INTERVAL_MS` 默认 5s），带 loop_tick + 单调进展计数 + bash FIONREAD 事实族；strict JSON（NaN 拒帧不杀内核）、不进模型上下文（`be6570803`/`65dacb311`）；心跳陈旧时**降级 journal 兜底**（按 kernelPid 读盘，TTL 大于它所喂的预算，`29b18d204`/`58dc90bb8`）；看门狗 **vouch**：工具在飞 + 内核/宿主事实证明外部工作在跑 ⇒ abort 缓期（警告照发、文案改写为真实语义+剩余预算），两级预算（进展证据 50min / 仅存在性证据 20min）、宿主请求 vouch 龄上界 15min、**预算耗尽闩锁必杀**（`61a3ba890`）；`loop_stalled` 仅在 tick 差分证明时报告（`3046b0580`）、缺龄按 agedOut、`no_kernel_facts` 只对协议 ≥4 报（`d95021edd`）；**终审 A1 闭合**：vouch 闪烁（证据断档后重读）不再无限续命，断档前已积累的豁免时间结转、已见顶的 cap 保持已尽（`f307f943d`）；**B9**：被豁免的健康子代理不再对用户显示 stalled（agents view 显示 `long-running 12m`，stall 事实带 `excused` 旗标照流，`9a2828d33`） | 长 `await bash(...)`、长构建、等子代理不再 15 分钟被砍；真死锁仍必死（活句柄兜底档最坏 ~20min，合计预算封顶 50min，见登记降能） |
| **批 2 · 砖化与等待**（6 笔，`a5179de81`…`e1eb54bd3`，含复核回修 `e1eb54bd3`：errored 首发按 uncertain 记账、同键重发 fail-closed，重复投递窗机制性关闭） | 内核**死因归因**：code/signal/origin（`oom_suspect` 仅凭内存证据）、与宿主有意杀（shutdown/kill/dispose/协议修复）分账、双落盘（`a5179de81`）；**自动复活**：意外死亡由下一格复活（spawn+restore+re-bootstrap），结果头带 reset notice（回滚点、未复活名单、丢失的宿主回话、**副作用不回滚**），预算 3 次/1h 滑窗 fail-closed ⇒ `KernelUnavailableError` 带死亡链（`f18c2ba77`）；agent message 四个等待点**有界化**（`agentMessage.targetWaitSeconds` 120/60/60/60，retryable 错误带 phase/target/waitedMs，被等的操作永不取消，三连败转终态+写文件指引，`dfc3df92d`）；cell abort **只取消只读白名单**宿主请求（`rlm.find_models`/`list_subagents`、`agent_observe.*`、`model.info`、`agent_message.list_agents`），副作用类（`rlm.run`、`agent_message.send`）维持 teardown-only ⇒ Esc 不再风险杀掉刚 admit 的子代理（`ecfa71d37`）；**exactly-once 投递**：sender-minted message_id + 收端 1024 个 id 记忆，重发回执「第一次才算数」；同文本双发仍双达（有意不采内容幂等键，`4b3399eb6`）；迟到 host_reply 上报不再静默丢弃 | 内核 OOM 不再砖化整个会话；send 卡死有界、有事实回执；重试不再造出双胞胎消息 |
| **批 3 · daemon 生命周期**（4 笔，`0ec081a26`…`16c56168f`） | 启动**收养不堵 ready**（后台化、`daemon_hello` 报收养数、启动日志列每个未起会话+原因+恢复命令）、收养请求 300s 有界、失败退避重收养（30s/2min/10min）；**kill 全生命周期可达**（recovering/failed/stopped）、已消失目标回 `alreadyTerminal`、读命令不谎称成功；catch-up **有界重试**（250ms→8s cap + 1min jitter，40 次 ≈5min）+ 客户端快照 re-pull 失败降级可见；supervisor **崩溃护栏**（uncaughtException 记栈退出；unhandledRejection log-and-isolate + 1h 计数 + `degraded` 对外可见 + 可选阈值 exit）+ 簿记写失败不再拖垮 daemon；**failed-worker reaper**（24h + 双证死 + 无 schedule 无 client ⇒ 带真实 failure reason 归档后移除，degraded 时停摆）。SCHEMA_REVISION 27→**28** | 一个坏 worker 不再拖垮整个 daemon 启动；73% 死租约 / 46% 僵尸 ledger 有了清道夫；视图残缺 708 次/期的 catch-up 单点失败变有界重试 |
| **批 4 · 兜底与超时分层**（8 笔，`5f7354426`…`82c2340ec`） | daemon 超时**四档分层**（long 24h / adoption 300s / deliver 120s / read 30s，`5b37f330d`）+ 客户端重连预算（从收养档推导，后台重试）；长 send **移出 mutationDrain 闩**（独立可回滚，`7bf3e5f0d`）；**pending-delivery 队列**（100/会话、24h deadline、drain 显式回执、requeue 日志节流、abandoned 回执分 `undelivered|uncertain` 两种可数状态，`7406aa22d`/`dcfb7f6ea`/`82c2340ec`）；deferred 命令**瞬时重试提示**（retryAfterMs 预算内重试，`5f7354426`）；事件缺口恢复**熔断器**（3 连发或 10min 内 3 次 ⇒ 该连接余生降回 log-only；开关档案 `docs/fork/ma-p0-5c-recover-switch-archive.md`，默认仍 `"log"`，`cb749c7bc`）。SCHEMA_REVISION 28→**29** | 「双方都没错但用户看到死」的四组超时组合拳被拆档；消息不再在 drain 窗口静默蒸发 |

wire 纪律实况：批 1/1c 的加法全部走能力门（`rlm_child_stall_activity` 等 additive 字段，不占 revision 号）；取号发生在批 3（28）与批 4（29），HEAD=29，digest 自检绿。内核协议走 env 协商（C21 裁甲），`PRIME_AGENT_KERNEL_PROTOCOL=3` 是 v4 全部能力的单点回滚杠杆。

### 三、登记降能与行为变化（诚实清单）

- **hung bash 救援窗 15→20min**：活句柄但零进展（卡在 stdin 的交互客户端）按存在性档 20min 救，比旧的 900s 晚 5min；有裁（无人值守永久挂死 > 误杀）。
- **`time.sleep(1200)` 型同步阻塞格仍会被杀**（~20min 活性档封顶，与真死锁不可区分）——修复救的生产主形态是 `await bash(...)`/等子代理（心跳+vouch 豁免）；这是终审验收探针的既定口径，不是回归。
- **闩锁代价**：豁免 cap 吃满后，活动恢复不再救回本回合。
- **纯重定向命令只拿 20min 存在档**（无 stdout 进展可读）。
- **Esc = 只停当前回合、不动子代理**（C1 裁乙，产品语义已确认）；杀树走 agents-view 显式入口。
- **排队的子代理消息不再自动开新回合**（`subagentWake.policy` 默认 `failure_aggregated`）；要旧行为设 `"always"`。
- **内核复活 ≠ 无损**：命名空间回滚到最后快照点，其后定义全部丢失，但副作用（文件写、提交、已发消息、已派子代理）**不回滚**；reset notice 逐格明示。
- **bootstrap 锁 300s**：极慢机器全量装 >300s 会从「无界慢」变「显式失败+指引」（`kernelBootstrap.lockTimeoutMs` 可调）。
- **在用 venv 拒绝重建**：有活引用的 generation 永不原地重建，启动显式报 `venv rebuild deferred: N kernels in use`（平台无关降级案——新 identity 落新兄弟目录，根本没有 rename 换入可供 Windows 失败）。
- **有界等待新增一类 retryable 错误**（`agent message target wait timed out` 带 waitedMs），三连败转终态并指引写文件交付。

### 四、三起并行施工事故与纪律沉淀

多条施工车道（T0A/T0B/T1A/T1B/T3/T3b/B1c/B2/T4）同仓同工作区并行，husky pre-commit 的「重新暂存」机制（`for file in $(git diff --cached --name-only); do git add "$file"; done`，为回收 `biome --write` 的修复）使**索引级分离在本仓无效**，由此出了三起事故（同机制轻症另有一起：T0-2 的 6 行注释被 `f60529a43` 带走，commit message 已注明）：

1. **`30c726254`（T0A 车道）**：钩子把 T0B 在飞的 `repl-manager.ts` 半（~200 行）卷进提交，而其依赖文件未提交 ⇒ **HEAD 一度不可编译**（纯净树 8 条 tsgo error）。
2. **`ef788e0db`（T1A 车道）**：提交了引用 `SettingsManager.getSubagentWakePolicy` 的 `agent-session.ts`，而 `settings-manager.ts` 还在工作区 ⇒ 纯净树 6 条红。钩子查工作区所以放行——**半提交对钩子免疫，只有 `git archive` 纯净树能抓到**（由 T0B 的交付复验抓到）。
3. **`ecfa71d37`（T2-5 车道）**：串行约定下 `git add` 前只看了 `git status` 没逐 hunk 核对，把 B1c 按约定在飞的 `agent-session.ts` B9 半卷走。处置与前两起同款：**不 amend、不 revert、双向登记归属**。

沉淀为全员纪律（已写进根 `AGENTS.md`「Shared-Worktree Construction Discipline」节）：**共享文件全量提交铁律**（提交=文件粒度非 hunk 粒度；stage 前逐 hunk 核对；共享文件串行提交）；**每笔提交后 `git archive HEAD` 纯净树 tsgo=0 复验**；**测试环境净化**（`env -u` 掉 RLM_*/PRIME_AGENT_*/PI_* 泄漏变量，否则测试写真 `~/.prime/agent`、断言随机器漂移；Python 套件同样适用）；**半成品不落共享工作区的 `test/`**（一个车道的 WIP 会挡住所有车道的提交）；**等绿窗提交、禁 `--no-verify`**；**变异/纯净树验证钉 SHA 不钉 HEAD**。

### 五、终审结论（四条异构车道复核，全过）

交付面终审由四条独立异构车道承担，全部基于 `git archive` 纯净树 + 净化 env，复核范围 `10b6b4e55..a5179de81`（39 笔时点）：**不变量与量级核算**（final_invariants，逐条验算全部「有界」断言 + 自建时钟仿真）、**新引入问题猎手**（final_regression，逐 diff 通读全部 39 笔 + 亲跑定向套件）、**修复有效性**（final_effectiveness，HEAD 纯净树 342 例全绿 + base 树红验 27/34 红）、**集成冒烟与一致性**（final_smoke，全仓实测 + changelog/wire/文档一致性核对）。结论口径：

- **HEAD 上无一条今天引入的确定性回归**；全量红 = 2 条既有红复跑同签名 + 1 条环境依赖 + 2 条负载 flake（逐条 base 树对照）。
- 终审时点全仓实测：tsgo EXIT=0、biome 1089 files EXIT=0、coding-agent collected 5372 = 5287 passed + 5 failed（全部定性既有/环境/flake）+ 80 skipped、`npm run test:kernel` **30/30 绿**、runtime unittest **317 OK**。
- FINAL.md 五段死亡链逐条对照：①②③⑤ 真闭环、④ 死因归因半闭环（自动复活当时在飞）——**批 2 落地后 ④ 闭合**；D2 等待点/exactly-once 同批闭合。
- 终审发现的全部中/高级项已逐笔闭合（每笔先红后绿 + 变异 + 纯净树复验）：A1 豁免预算不闭合 ⇒ `f307f943d`；A2/B9 excused 子代理误标 stalled ⇒ `9a2828d33`；投递重复窗 ⇒ `82c2340ec` + `4b3399eb6`；reaper 归档 lastError 半盲 ⇒ `19f6f96f5`；requeue 日志放大 ⇒ `dcfb7f6ea`；心跳时序 flake ⇒ `b49556902`；catch-up 终态 close 的注释谎话 ⇒ `16c56168f`（诚实登记，行为变更留新立项）。
- 终审点名的三处文档滞后（settings.md 缺 `kernelBootstrap.lockTimeoutMs`、AGENTS.md 缺 `test-hygiene-allow` 通道、FORK_NOTES 缺本轮入口节）⇒ 本提交补齐。

### 六、遗留与待老板裁决

**待裁**（不裁不动工）：① C18 daemon 崩溃策略——已先落地推荐默认形（rejection log-and-isolate + 计数 + degraded 可见，阈值 exit 可开），追认 or 改；② C12 replay 真缓冲环——缓行单独立项（推荐）；③ C21 混版窗终态——维持协商式（推荐）vs 未来硬 bump；④ catch-up「放弃→踢下线」路径彻底移除——需客户端自治重连语义，能力变更单列（`16c56168f` 已在代码处登记）；⑤ F18 两个暂认值（venv.old 保留数 1、收养 create 超时 300s）。

**遗留工程项**：legacy `~/.prime/agent/kernel-venv`（523MB）不自动回收，清理命令与时机见运维手册；11 个 kernel 系测试文件仍硬编码 legacy 路径作 python fallback（收口基准实测；build 后统一改 `activeKernelVenvDir`，否则有「静默跑到旧 runtime」的假验收风险）；`ipython.ts` 的用户提示文案仍指 legacy 目录；P2 测试卫生真清债（recursion 11 条等）；既有红两条（`4600-supervisor-singleton` 上游测试与代码语义脱节、`agent-session-auto-refine-probe` 净化 env 必红）待单开小任务裁决；后台重连 timer 无 unref（低危登记）；schema digest 不覆盖 response 面（登记级）。

**在飞**：B1c 诊断 polish（`spentThisCycle`）在工作区未提交，归后续车道。

细节文档：运维手册 `docs/fork/ma-multistability-ops.md` · 缺口恢复开关档案 `docs/fork/ma-p0-5c-recover-switch-archive.md` · settings 新键 `packages/coding-agent/docs/settings.md` · 审查/施工/终审材料 `/tmp/ma_audit/`（不在仓内，关键结论已收进本节与运维手册）。

---

## 2026-09-07 · 主仓迁到独立仓 + 根代理对用户说话方式

这一轮两件事：把远程身份从「官方 fork + 两个实验仓」收成一个独立主仓；把昨晚未提交的根代理沟通契约入仓并记在这里。

### 一、远程仓库收口

- **做了什么**：唯一主仓定为 [`Dmatut7/prime-agent-rlm`](https://github.com/Dmatut7/prime-agent-rlm)。把本线 `merge/repl-kernel` **完整 git 历史**推上去，替换 rlm 原先那个 1 提交 squash import（`7c3e4c1ac`）。squash 会让之后 `git merge upstream/main` 变成无关历史，不能在那上面继续开发。
- **本地 remote**：`origin` → rlm；`upstream` → 官方；`fork` → 旧 `Dmatut7/prime-agent`（只读路牌）；原 `origin`（`prime-agent-x`）改名为 `archive-x`。
- **旧仓**：fork 最后快照的 README 已改口指向 rlm，之后不再往 fork 推新提交。`prime-agent-x` 在 GitHub 上 Archive（它停在官方 0.7.3，本来就不是这条 0.9.1 REPL 线）。
- **版本**：本线仍是 **0.9.1**。官方已发 **v0.9.3**，下一轮上游同步再跟。
- **为什么改**：三个仓的 README 都在抢「唯一主仓」，本地 `origin` 还指着已停更的 x。再拖只会推错地方。

### 二、根代理用户沟通契约（昨晚未提交工作，本轮入仓）

- **做了什么**：根代理（`rlmDepth === 0`）的用户可见指引从「默认简化技术英语 + 进度播报」换成「Working with the user」契约：用用户的语言、先复述目标再干非琐事、自己拍板不给 A/B 菜单、只在不可逆/花钱/出机/产品口味时提问、每条回复第一句就是结果。子代理不加这段。系统提示末尾再钉一句 reminder，避免长上下文把契约冲掉。
- **为什么改**：根代理是用户唯一在读的那层；子代理对用户不可见，不需要这套说话方式。
- **对用户 / AI 能力**：用户能感觉到根代理怎么回话（语言、结构、少问选择题）。工具调用、REPL、子代理调度不变。
- **验证**：`packages/coding-agent/test/system-prompt.test.ts` 27 passed。changelog 碎片 `packages/coding-agent/.changes/user-communication-contract.md`。提交 `eb03edbac`。
- **故意不纳入**：工作区里那份手改过的 `packages/ai/src/models.generated.ts` 已还原（禁止直接改 generated）；一组 visitor/kick 截图与本线无关，仍留在工作区未提交。

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
