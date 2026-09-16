# r41 簇C 方案书：删除链窗口统一（ADC-1 / ADC-2 / ADC-3 修法）

线名：delete-chain-unify（方案席，只出方案不写码、不开工作树）
输入：`/tmp/audit_r/round-41/artifact-delete-chain.md`（0902 终审，探针已打穿 ADC-1/2/3）+ 本人对仓 eb0825e63 只读复核（artifact-dirs / child-transcripts / sweep / runner / delete / reports / ledger-scan / fs-walk / rlm-ledger / event-log / session-lease / cron-jobs / orphan-process-journal / daemon-mode / daemon-supervisor / public-command / settings-manager 全文读过）。
产出：本文件。仓零写入。

---

## ① 根因复述（一句话）

删除链的时间权威**没有单一归属**：每个 retention 类各自拿一个目录级窗口去判同一棵混合内容的树（residue 的 7d 整目录回收越权吞掉 child-transcripts 承诺 30d 的转录与 display 墓碑），账本层则把「权威」做成 append-only 无回收（超界后读写双 fail-closed、删除/生成双双失效），而所有触发面（daemon 定时器 + CLI）只有进程内 in-flight 守卫、没有跨进程互斥，预算与 history 账目在并发下失真——三个缺陷同根：**判定权、降解权、互斥权分散在三处，各自保守但合起来互相打架**。

---

## ② 候选修法

### Q1 窗口判定的单一权威（ADC-1）

**权威表（修完后应成立且写进 docs/settings.md）：「哪类产物听哪个龄」按字节身份，不按所在目录**

| 产物身份（树内） | 权威窗口 | 唯一判定实现 |
|---|---|---|
| `sub-*/<uuid>.jsonl` 非活子转录（含已删子） | `childTranscriptDays`（默认 30d） | child-transcripts 类（含 sibling-writer 守卫 `max(文件 mtime, 所在 sub-dir 树 newest)`） |
| `sub-*/rlm-subagent.json` display 墓碑 | 随其转录同生共死（无独立窗口；目录回收时随之消失） | 无（随目录） |
| 已删会话目录内其余字节（`harness/`、`kernel-state/`、`semantic-edges.jsonl`、trash） | `deletedSessionResidueDays`（默认 7d） | artifact-residue-dirs 类 |
| 全空目录 | `emptyArtifactDirDays`（默认 7d） | artifact-empty-dirs 类 |
| ledger 记录 | 无龄；只有「重放等价下不可观测」的记录可被压实（见 Q2） | rlm-ledger 压实路径 |

**目录内混合类的拆法（核心裁决）：不物理拆，判定期拆。** 目录级回收的前置条件升级为：**树内每个受保护字节都过了它自己身份对应的窗口（max-window 规则）**。混合目录在 7d~30d 之间被 `young:child-transcript-*` 原因保住，30d 后一次回收到位。

**候选 A（推荐）— window-aware descendantBlocker + 共享判定函数**
- 改动：`artifact-dirs.ts:388-393`（descendantBlocker 的转录循环）不再对 `ledgerDeletedChildIds` 一刀切豁免：对已删子的转录改调 child-transcripts 类的**同一个**年龄判定；未过窗 → 用 `SKIP.young("child-transcript:30d")` 保住父目录（`young:${string}` 已在词表内，**不改 types.ts 词表**）。过窗或活边 → 现行为。同时把 child-transcripts 类的年龄公式（`max(转录 mtime, sub-dir 树 newest)`）提为共享 helper（child-transcripts.ts 导出，两处调用）——「单一权威」落到代码就是**一个函数两个调用点**。`fs-walk.ts` 的 `TreeAggregate` 增记转录路径（`transcripts: {id, path}[]`，walk 已 lstat 每个文件，零新增 syscall），blocker 对每个已删子转录再 `aggregateTree(subDir, {maxDepth:2})`（与类判定同参数）。
- 取舍：改动面小（2 文件 + 测试）；风险集中在「blocker 年龄公式必须与类判定逐字一致」——用共享 helper 消除；兼容性：ledger 未扫描时 `ledgerDeletedChildIds` 为空 → 所有树内转录照旧无条件保目录（现状，保守方向不变）；empty 类不受影响（空目录无转录，循环空转）。
- 行为变化（有意）：混合目录寿命 7d → 30d；纯 residue 目录（无树内转录）行为不变；30d 后 end-state 与今天 7d 后完全一致（residue 类先跑，整目录一次带走，child-transcripts 类随后扫到空）。

**候选 B — 物理拆分（residue 只回收非保护条目，sub-\* 留给 child-transcripts 先清）**
- 改动：delete 请求粒度从 dir 降到 entry（residue 只删 harness/kernel-state/edges 等文件），父目录等 child-transcripts 清完转录后由 empty 类收尾。
- 取舍：改动面大（回收契约重写、签名复检/budget 按条目、empty 类窗口从「变空时刻」重起 7d → 混合目录总寿命 ≈ 7d+30d+7d≈44d，比 A 多 14d 且多一次类间接协作）；风险：半清目录成为新常态、empty 类依赖 `sub-*` 前缀排除逻辑（`isSessionDirectoryName` 拒 sub-，空 sub-dir 永远只有随父目录死亡——B 恰好把这个路径拉长）；无额外正确性收益。**不推荐**。

**候选 C — 设置面统一（band-aid）**
- 改动：默认 `deletedSessionResidueDays` 30d（或文档声明 residue ≤ childTranscript 属非法配置 + settings 校验告警）。
- 取舍：零代码；但只治默认值——用户改 residue=7 时打穿复现；且把纯 residue 字节多留 23 天。作为 A 的**文档护栏**（settings 校验告警）保留，不作为独立修法。

### Q2 ledger 超限的降级路径（ADC-2）

先裁决母席的显式问题「删旧的还是拒新的」：**删旧的（等价压实）为主，拒新的只做压实后仍超界的终极闸。**
理由：拒新直接杀死两条产品路径——`appendDelete` 失败=删除失败（daemon-mode.ts:1243-1246 注释自认「a failed append is a failed deletion」），`appendSpawn` 失败=无法生子代理；而「删旧」在满足**重放等价**（见⑤）下无可观测差异。reads 的 fail-closed（replaySync size>32MiB throw）也不能作为常态降级：它把 family()/siblings() 打成抛错、目录列表退化成平面（withPassiveRlmDescendantInfos 只能吞掉）、spawn 的重复入场检查也炸。

**候选 2A（推荐）— append 侧检界 + 守卫下等价压实 + 类型化终极拒新**
- 触发：`appendRecord`（rlm-ledger.ts）在写入前 stat 投影大小/记录数；将越界时先**压实再重试一次**，仍越界才拒，且拒要类型化（如 `RlmLedgerOverBoundError`，消息带「活边数、边界、建议动作」），daemon 捕获后向用户面透出而不是裸栈。
- 压实（等价约简，**不是「留最后一条」**——rename 只改既有边，若按 key 留最后一条会丢 spawn 导致边整体消失）：重放全文件 → 按 `edgeKey(childId+canonical child)` 归约出**终态边**（spawn 字段 + 最新 name + deleted 标志），产出「meta 首行 + 每活边一条终态 spawn + 每已删边一条终态 spawn+delete」的新文件；**已删边的 delete 记录仅在其子转录/子目录仍存在时保留**（LIFE-1 的 stat 对账谓词复用——这是 deleteRlmSubagent 断点重试路径与 tombstoneSavedSessionDelete raw 视图唯一消费的记录形态；目录全灭的 delete 记录 = 读侧惰性对账已消化的事实，落盘化）。写法：temp + fsync + **重 stat 无变化才 rename**（防混合版本旧二进制无守卫并发 append 丢记录，窗口收窄到 stat→rename 微秒级）+ 目录 fsync。
- 守卫：`proper-lockfile` `lockSync(ledgerPath, {realpath:false, lockfilePath: ledgerPath+".guard", stale:…, onCompromised})`——**仓内现成先例**：orphan-process-journal.ts:215-237 的 `withJournalGuard`（20×10ms 重试）+ 它的 COMPACT_AFTER_RECORDS/COMPACT_AFTER_BYTES 注释就是「keep newest per key、重放不可见」的同构声明；session-lease.ts 的 guard 形态同源。守卫只在压实期间持有，不挂到每次 append（append 仍靠 O_APPEND 原子性，热路径零新增锁）。
- 读者对齐（必做，独立成立）：`ledger-scan.ts` 补两条界——size/records 超 `RLM_LEDGER_MAX_*` → `scanned:false`（sweep 侧全部按 unknown 保守保对象）；`record.v !== 1` 的行跳过（对齐 daemon 端 parseLedgerLine 的 v 闸）。这把探针 P2/P3 的两个实证（无界读 + v:2 被吃）同时关掉。
- 取舍：改动面中（rlm-ledger/event-log 各一小块 + ledger-scan + 测试）；风险集中在压实重写这一个操作（权威数据文件）——用⑤的重放等价断言 + no-clobber + 重 stat-abort 兜底；兼容性：文件格式不变（v:1 同 ops），旧读者读新文件无感，replayCache 靠 size/mtime 失效自动跨进程生效；混合版本并发（旧二进制无守卫 append）窗口极窄且重 stat-abort 可弃局。

**候选 2B — sweep 侧 opportunistic 压实（新 RetentionClassId `rlm-ledger-compaction`）**
- sweep 的 collectLiveReferences 已经 stat 整个 ledger 目录（sweep.ts:101），顺手发现超界 → 压实；报告行天然进 last-sweep.json（scanned=文件数、reclaimed=删掉的记录数、bytes=缩减量），stalled 检测免费覆盖「压实一直失败」。
- 取舍：修不了「append 当场失败」——跨过 32MiB 后到下个 sweep（默认 1h）之间 spawn/delete 全断。单独用是半修；**作为 2A 的 belt-and-braces**（sweep 兜底扫掉历史遗留超界文件，例如旧二进制造成的）价值高。ADC-2 证据里「RetentionClassId 无 rlm-ledger 类」顺势补上。

**候选 2C — 纯 operator 杠杆（CLI `prime-agent retention ledger-compact`）+ 读者对齐**
- 只给人手恢复路径 + 修读者分歧，不做自动降级。
- 取舍：改动最小；但机器无人值守时超界态持续（spawn/delete 断供直到人来）。作为 2A 的操作面补充（doctor/status 里报 ledger 体积/记录数/超界标志）保留。

### Q3 跨进程锁的最小形态（ADC-3，照 session-lease 先例评估）

先例解剖（session-lease.ts:444-560）：proper-lockfile `lockSync` + `lockfilePath: ${dir}.guard`、`stale: 5000`、`onCompromised`→显式失败、100×10ms **异步**退避、仍不下就抛带持有者描述的 `SessionLeaseGuardContentionError`、旁挂 owner.json 提供持有者画像、候选目录准备在守卫外（R31-2）。同构先例还有 cron-jobs.ts:1928-1953（stale: 30_000、ELOCKED 重试 25 次、妥协即炸）与 orphan-journal（Atomics.wait 10ms×20）。

**候选 3A（推荐）— 先例的最小子集：单 guard + best-effort owner 侧写 + ELOCKED 短退避**
- 位置：`runRetentionSweepOnce`（runner.ts——CLI/daemon/测试的**唯一**汇合点，注释自认「The one entry point every trigger shares」）。锁目标 `roots.retentionDir`，`lockfilePath: <retentionDir>/sweep.guard`，`stale` 取 **15–30 分钟**（breaker 封顶 512MiB/2 万条，实测 sweep 秒~分钟级；stale 被 steal 的最坏后果=回到今天的并发态，只是账目抖动不是误删）。
- ELOCKED 语义分叉：CLI → 返回 `lastReport` + 一行「另一 sweep 进行中（pid/startedAt，读 sweep-in-progress.json）」；daemon tick → 跳过本次且**不推进** `lastRetentionSweepAtMs`（现在是在跑前就置位，daemon-supervisor.ts:4677-4680；改为 sweep 完成后再置位，锁跳过就下个 check tick 重试）。持锁期间顺手写 `<retentionDir>/sweep-in-progress.json`（pid、startedAt、agentDir，best-effort）——这就是 lease 先例「owner record + guard」的裁剪版。
- 守卫范围把 `writeRetentionReport` 一起罩住（它本就在 runner 里 sweep 之后调用）→ history.jsonl 的读-改-写（reports.ts:63-77 的 ≥HISTORY_LIMIT 全量重写分支）被串行化，丢行结构性消失；per-sweep breaker 预算随之全局唯一。
- 非锁目标路径：`scanArtifactTree` 不动；锁失败（非 ELOCKED，如只读 HOME——bootstrap 锁 r36 INSB-3/F2 的真实机型先例）→ **降级为无锁运行 + 记日志**（锁护的是账目完整性不是删除安全；删除安全一直由类判定+签名复检+rename-then-remove 提供，这句话要写进 runner 注释）。
- 取舍：改动面小（runner + public-command 一行文案 + daemon-supervisor 置位时机 + 测试）；风险=proper-lockfile 的 stale/onCompromised 边界（妥协→当 held 处理跳过，不炸 CLI）；兼容性：测试直调 `runRetentionSweep` 不经 runner → 零影响；vitest 并行分片用 mkdtemp 各自 agentDir → 无跨测试争锁。

**候选 3B — 完整 lease 形态（owner.json + pid+start-id 存活性判定 + reclaimable-own 回收）**
- 把 sweep 锁做成一个真 lease：持锁进程死掉后由下一触发方按 pid/start-id 判死回收。
- 取舍：correctness 上没必要——proper-lockfile 的 `stale` 选项已按 mtime 判死自动 break；lease 的存活性判定为的是「长时间持锁 + 高价值独占资源」（会话互斥），sweep 临界区短且低价值。改动面×3，收益≈0。**不推荐**。

**候选 3C — 不加锁，改账目形态（history 只追加 + 预算落盘原子分配）**
- history 永远 O_APPEND（去掉 ≥200 行全量重写分支，超界另滚动）；breaker 改为跨进程的原子预算文件（每删一条 CAS 扣减）。
- 取舍：history 追加化顺手可做，但预算 CAS 化是新的持久化热路径、每条删除一次文件写，且**双扫描浪费依旧**（两个进程仍各走一遍树）。只解决三症状之一。**不推荐**（追加化可作为 3A 的顺手加固，非必需）。

---

## ③ 推荐与理由

**ADC-1 → 候选 A（+C 的文档/校验护栏）。** 它是唯一把「单一权威」落成代码事实的方案：一个身份一张窗口表、一个年龄函数两个调用点；不引入物理拆分的新中间态；负结论有正控（ledger 未扫描路径本就无条件保目录，A 不触碰它）；end-state 与现状逐字节一致只是延后 23 天——这正是 30d 承诺的本意。B 的 44 天寿命与半清目录态、C 的「巧合治法」都不满足「窗口判定的单一权威」的题设。
**ADC-2 → 2A + 2B（belt-and-braces）+ 2C 的 doctor 面。** 降级梯子完整且每级有理由：等价压实（删旧，用户路径零中断）→ 压实后仍超界（>10 万活边的病态机）才拒新且类型化透出 → sweep 侧兜底扫历史遗留超界文件 → doctor/status 给 operator 视野。读者对齐（ledger-scan 加界 + v 闸）独立必做：它是「三层读者三种行为」的收敛，跟压实与否无关。
**ADC-3 → 候选 3A。** session-lease 先例里真正可复用的是「guard + owner 侧写 + 类型化冲突 + onCompromised 显式化」，而不是它的存活回收生命周期；sweep 锁的正确定位是**账目完整性锁**而非删除安全锁——这一定位同时决定了 stale 可以放宽（15-30m）、锁不可用可以降级运行（无锁可用性优先）、ELOCKED 可以直接让位（CLI 返回 last report / daemon 下个 tick 再来）。全部触发面在 runner 一处收口，改动最小且测试可绕。

组合后三修共享一个主题：**每个判定只有一个权威实现，每个降级只有一条显式梯子，每个触发面只有一把锁。** 三者互不耦合，可分三个 PR 独立验收独立回滚（见⑥）。

---

## ④ 风险面清单（会动到谁）

| # | 谁被动到 | 动因 | 具体风险 | 缓解 |
|---|---|---|---|---|
| R1 | 所有跑默认 retention 的用户 | ADC-1A | 混合目录磁盘占用 7d→30d（+23d 的 transcript+display 字节滞留）；有用户以「7 天清干净」预期调过 residue | docs/settings.md 权威表 + changelog 明说；纯 residue 目录行为不变（测试钉死） |
| R2 | `sub-*` 转录仍在 30d 窗内的删除父会话 | ADC-1A | 父目录保到 30d 后**一次**整树回收（与今天 7d 一次整树回收同形，仅时点不同） | end-state 等价测试（见⑤） |
| R3 | ledger 大户（多子代理、频繁 rename/delete 的机器） | ADC-2 | 压实重写权威拓扑文件：一次坏重写=拓扑永久损伤（spawn 边丢、delete 墓碑丢） | 重放等价断言为**合入门槛**；temp+fsync+重 stat-abort+rename；守卫内执行；可留一代 `.compact-<pid>.bak` 由 trash 类兜底回收（决策点，见⑥） |
| R4 | 混合版本进程（用户 CLI 旧、daemon 新或反之） | ADC-2 | 旧二进制无守卫 append 撞上压实 rename → 丢一条并发记录（旧 inode 追加） | 重 stat-abort 把窗口收窄到 stat→rename；丢一条 spawn/delete 的后果=现状 fail-closed 的严格子集；发布说明提示重启全家进程 |
| R5 | `prime-agent retention sweep` CLI 用户 | ADC-3A | 语义变化：另一 sweep 在跑时**不再并发执行**而是返回 last report | 输出明说「in flight, showing last report」；exit 0；`--force` 不提供（有意：账目锁不设旁门） |
| R6 | daemon 定时 sweep | ADC-3A | 锁跳过后置位时机改动（完成才置位）→ 极端下 check tick 更频繁地试探锁 | 每次试探=一次 lockSync 失败，成本微秒级；`retentionSweepCheckIntervalMs` 已有节流 |
| R7 | vitest 套件（并行分片） | ADC-3A/2A | runner 加锁路径进测试；ledger 压实测试跑真 fs | fixture 用 mkdtemp（现状如此）；守卫/压实测试单独文件；`npm run check` 全绿门槛不变 |
| R8 | 只读 agentDir 机型 | ADC-3A | retentionDir 不可写 → 锁失败 | 明确降级策略：非 ELOCKED 失败=无锁运行+日志（可用性优先，写入本就 best-effort） |
| R9 | orphan/cron 等其它 lockSync 用户 | ADC-2/3 | 无共享代码路径（各自 lockfilePath），仅风格对齐 | 无实际耦合；新增 guard 文件名后缀区分（`.guard` vs sweep 的 `sweep.guard`） |
| R10 | `RLM_LEDGER_MAX_*` 语义消费者 | ADC-2 | 界从「读写都炸」变「写侧梯子」——依赖旧抛错行为的调用方（无：appendDelete 调用方一律 best-effort 或透传错误） | grep 复核 rlm-ledger 全部调用点（daemon-mode、session-file-actions、tombstoneSavedSessionDelete）确认无 catch-specific-message 依赖 |
| R11 | docs/settings.md `deletedSessionResidueDays`/`childTranscriptDays` 读者 | ADC-1 | 契约文字需补 max-window 规则（现在只写各自窗口） | 文档随 PR 同步；ADC-5（cooldown 契约不符）顺手在文档补一句类窗口与全局 cooldown 的关系 |

---

## ⑤ 验收护栏（红测设计 + 等价证明）

### ADC-1 红测（把审计探针升格为回归测试，`packages/coding-agent/test/retention-sweep.test.ts` 风格追加）
- **红（今天必红）**：复刻 probe.mts 场景——父 P 墓碑在役（删于 8d 前、树 9d 无写）、`<P>/sub-abcdefgh/<C>.jsonl`（9d，ledger 有 C 的 spawn+delete 记录）、`<P>/harness/` residue。断言：sweep 后 `existsSync(子转录)=true`、`existsSync(父目录)=true`、父目录 skip 原因含 `young:child-transcript:30d`（词表 `young:${string}` 不改 types.ts）。**现状跑这组断言必失败（residue reclaimed=1、转录消失）——先跑留红证据再改**。
- **正控（证明测试真能检出）**：同一棵树把 now 推到 +31d → 断言整目录回收、转录消失（否则测试只是把打穿换成了永不删除）。
- **等价证明 1（无混合内容行为不变）**：父树**不含** `sub-*` 转录的纯 residue 目录，7d 照旧回收——即现有 retention-sweep.test.ts / retention-life-reclaim.test.ts 全量绿（合入门槛 `npx tsx … --run`，从包根跑）。
- **等价证明 2（end-state 等价）**：同一 fixture 在 now=+7d（现状）与 now=+31d（新）各跑一次 sweep，断言两组 `classes[].reclaimed/bytes/paths` **逐字段相等**（只有时点差、无形态差）；对照面（父不可回收）继续报 `child-transcripts … young:30d`（探针对照组已有，保留为断言）。
- **保守面不回退**：ledger 目录缺失/坏（ledgerScanned=false）→ 树内任何转录无条件保目录（现状行为，A 未触碰）——加一条直接断言。

### ADC-2 红测（新文件 `packages/coding-agent/test/rlm-ledger-compaction.test.ts`）
- **红 1（跨界 append 当场降级）**：EventLog(maxBytes=小值) 语义测：构造含大量被覆盖记录（同 key spawn+rename+delete 交错）的 ledger，append 至投影越界 → 断言 append 成功、文件缩小、`replaySync` 不抛。现状：第 2 次跨界 append 后第 3 次+读全炸（探针 P2 已实证）。
- **等价证明（合入门槛，重放等价）**：对生成的随机交错记录集（spawn/rename/delete 以任意序），断言 `edges(pre) ≡ edges(post-compaction)`：逐 key 比对 childId/parent/child/depth/name/deleted 六元组全等；`edges(true)`（raw 视图）与 `family()` 同比。这是「删旧的无可观测差异」的机械化证明，**不是口头**。
- **死亡对账谓词测试**：delete 记录的子转录存在 → 压实后保留（deleteRlmSubagent 断点重试、tombstoneSavedSessionDelete raw 视图不受影响：两个消费点各一条行为测试）；子目录已灭 → 记录被压实掉且 `edges()`/liveEdges() 结果与压实前一致（读侧惰性对账早已吃掉这条边）。
- **读者对齐红测**：ledger-scan 超界文件 → `scanned:false`（红：今天 true）；`v:2` 行不被消费为 delete（红：今天被吃，探针 P3）。`scanned:false` 下 child-transcripts 类报 `unverifiable:ledger-scan`（保守保持）——断言链闭合。
- **终极闸测试**：>100k 活边（构造最小记录数即可，maxRecords 用小注入值）→ append 拒、错误类型化、`edges()` 仍可读（读界与写界分离）、daemon delete 路径把类型化错误透传（不裸栈）。

### ADC-3 红测（`packages/coding-agent/test/retention-lock.test.ts`）
- **红（并发预算翻倍）**：fixture 里放超过 `maxDeleteEntriesPerSweep` 的可回收条目；进程 A 手工 `lockSync` 持 guard，进程 B（子进程跑 CLI `retention sweep`，或直调 runRetentionSweepOnce）→ 断言 B 返回 last report/跳过且**未写 last-sweep.json 新条目、history 未加行**。释放后 B 再跑 → 正常回收且回收量 ≤ cap。现状红：B 并发全量扫（guard 不存在）。
- **账目完整性**：history 预置 ≥HISTORY_LIMIT 行（触发 RMW 分支），锁住并发写 → 断言无行丢失、长度单调不减（今天的丢行路径被结构性消除）。
- **降级路径测试**：retentionDir 只读（chmod 0555）→ sweep 照跑（无锁+日志），删除不因此失败——锁不可用不得变成清理停摆。
- **stale 测试**：手工把 guard 目录 mtime 拨老（> stale 阈值）→ 下次获取成功（自动 break）；onCompromised → 当 held 跳过不炸。
- **等价证明（触发面语义不变）**：单进程下 CLI/daemon 各自触发一次 sweep 的报告与今天同构（同 class 顺序、同 skip 词表、同 stalled 判定输入）——现有 retention-sweep.test.ts 全绿即为此证明。

### 通用门槛（三 PR 共用）
- `npm run check`（biome+tsgo）全绿；`npm run check:test-hygiene`（不探私有成员，公共入口驱动）。
- 每包 changelog fragment（`packages/coding-agent/.changes/<slug>.md`，一行用户可感句式：如「Fixed a deleted sub-agent's transcript being removed after 7 days instead of the promised 30 when its parent's residue was swept」）。
- 测试跑法按仓规：包根 `npx tsx ../../node_modules/vitest/dist/cli.js --run <file>`，并 `env -u RLM_* -u PRIME_AGENT_* -u PI_*` 清泄漏变量。
- 回滚杆各持一个：ADC-1 = `retention.deletedSessionResidueDays=0`（类关停）；ADC-2 = 压实开关（settings 布尔，默认开，关=回到 fail-closed 现状）；ADC-3 = `retention.sweepLockEnabled`（默认开，关=回到并发现状）。三个都是 settings 级，无需回代码。

---

## ⑥ 附：实施切分（三个独立 PR，可并行施工、独立回滚）

1. **PR-C1（窗口权威）**：`fs-walk.ts`（TreeAggregate.transcripts 路径记录）+ `child-transcripts.ts`（导出共享年龄判定 helper）+ `artifact-dirs.ts`（descendantBlocker window-aware）+ docs/settings.md 权威表 + 红测。最小心智：~80 行含测试注释。
2. **PR-C2（ledger 梯子）**：`ledger-scan.ts`（界+v 闸）独立小步可先行；`rlm-ledger.ts`（投影检界 + compactUnderGuard + RlmLedgerOverBoundError）+ `daemon-mode.ts` 透传 + 可选 sweep 类 `rlm-ledger-compaction` + doctor 面。压实是全簇最险单点，红测（重放等价）作为合入前置。
3. **PR-C3（sweep 锁）**：`runner.ts`（guard + owner 侧写 + 降级）+ `public-command.ts`（in-flight 文案）+ `daemon-supervisor.ts`（置位时机）+ 红测。

依赖关系：三者无代码耦合（C2 的压实守卫与 C3 的 sweep 守卫是两把不同的锁、不同 lockfilePath），可三席并行；合并窗口按仓规 `git commit --only -- <paths>` 点名提交、禁 amend。

**留给施工席的两个决策点**（方案不锁死）：① 压实是否留一代 `.compact-<pid>.bak`（保险 vs 多一个要被 trash 类认领的文件形态——倾向不留，重放等价断言+原子 rename 已足）；② sweep 侧 opportunistic 压实走独立类（报告可见、stalled 覆盖）还是 runner 前置步（类形状更贴本仓设计 §4 的「报告即断言」哲学——倾向类形状）。
