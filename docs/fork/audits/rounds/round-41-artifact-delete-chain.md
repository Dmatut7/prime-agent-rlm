# r41 子线：子代理产物删除链（tombstone × lazy reconcile × 30d retention 组合语义）

审范围 `b7f26e98b..HEAD`（HEAD=eb0825e634b0df63842bfc63c246151efc72ea37），仓只读。
关键提交：c87779e91（LIFE-1/2/3）、14a4e8811（L8D/L9F/K3L）、e3f9484f9（K3G）、030b1ada4（heartbeat fan-out）。
所有探针在 /tmp/audit_r/round-41/artifact-del-work/（probe.mts，用仓内 tsx 跑，零仓写入）。

## 结论一句话
三层在"单一删除事件"上是一致且保守的（display→ledger→artifact 顺序正确、rename-then-remove 防双删、fail-closed 方向正确），但**跨层的时间窗口与读取者语义不一致**：residue 类 7 天就把 child-transcripts 类承诺保 30 天的删除子代理转录连同 display 墓碑一起吃掉（探针实证），且 ledger 墓碑记录无任何回收/压实路径、超界后 daemon 读写双双 fail-closed 而 retention 扫描继续无界消费同一文件（探针实证）——「该删的记录永远不删」与「删除命令在大账本上失效」是真实可达态。

## 必答问题

### 1) 墓碑的写/读/删与时间基准
写：
- artifact 墓碑 `.session-tombstones.jsonl`：`recordSessionArtifactTombstone`（session-artifact-tombstones.ts:227-250），由 `deleteSessionArtifacts` 在 `rm` 之前写（session-file-actions.ts:50-51）。
- ledger 删除记录：`RlmSpawnLedger.appendDelete`（rlm-ledger.ts:380-391）；子删除路径 display 写→ledger 删→artifact 删（daemon-mode.ts:1226/1246/1256，顺序理由 :1221-1225）；根删除 `tombstoneSavedSessionDelete` 在删文件**之前**写 parent-teardown/user 记录（rlm-ledger.ts:948-995）。
- display 墓碑：`writeRlmSubagentDisplayEntry(status:"deleted")`（daemon-mode.ts:1227-1237 → rlm-subagent-display.ts:124-145）。
读：retention 的 `readSessionArtifactTombstones`（artifact-dirs.ts:163-164,178）、`scanRlmLedgerDirectory`（sweep.ts:101-105 → ledger-scan.ts:33-79）、display（rlm-subagent-display.ts:205-244）；session-manager 读墓碑压制复活（session-manager.ts:2532-2538）。
删：**只有** artifact 墓碑会被清（id 复用时 `clearSessionArtifactTombstone`，session-manager.ts:2518-2523 → session-artifact-tombstones.ts:257-275）；**ledger 删除记录永不删除**（append-only、无压实、无回收类，见 ADC-2）。
时间基准：三层全是墙钟——sweep `now=Date.now()`（sweep.ts:135-136；daemon-supervisor.ts:4667）；age=now−tree.newestMtimeMs（artifact-dirs.ts:265-267；child-transcripts.ts:105-108）；`tombstoneInForce` 严格比较 mtime < Date.parse(deletedAt)（session-artifact-tombstones.ts:176-189）；display stale 6h 墙钟（rlm-subagent-display.ts:47,60-64）。无单调钟（EventLog 的 performance.now 只用于 tail 静默窗口，event-log.ts:297-312，与保留无关）。
默认阈值：cooldown 10m、emptyArtifactDir 7d、deletedSessionResidue 7d、childTranscript **30d**（DEFAULT_RETENTION_CHILD_TRANSCRIPT_DAYS，settings-manager.ts:82-87，c87779e91）。
矛盾：**7d(residue) vs 30d(childTranscript)** 见 ADC-1；LIFE-1 惰性对账（edges() 读侧丢弃 child 目录已消失的边，rlm-ledger.ts:411-449）是即时的但只影响 live 视图——retention 的 ledger-scan 不做文件系统对账（ledger-scan.ts:44-77 只重放记录），同一死边在 sweep 眼里仍是 live 证据（更保守，不早删，但延迟回收）；L8D-1 版本闸与删除动作无交集（见 Q3）。

### 2) 并发
- 双删：`reclaimWithinBudget` 用 rename-then-remove，trash 名含 pid+Date.now+random（delete.ts:50-55,110-117），两进程删同一路径时输家得 `failed:ENOENT`——无双删。
- 互斥：**没有跨进程锁**。in-flight 守卫是模块级变量（runner.ts:15,47-49），注释只承诺"第二触发返回运行中的 sweep"（进程内）。daemon 定时器（daemon-supervisor.ts:4646-4684）与 CLI `prime-agent retention sweep`（public-command.ts:334）可同时扫同一 agentDir；每次并发各花一份 breaker 预算（sweep.ts:151-155，per-process），`maxDelete*PerSweep` 实际被翻倍；`writeRetentionReport` 读-改-写 history.jsonl（reports.ts:63-77）并发丢行，可影响 3 次 sweep 的 stalled 判定（sweep.ts:214-228）。
- CLI sweep 不传 residentSessionIds（public-command.ts:334 → sweep.ts:107 空集），daemon 在驻的会话对它不可见；但活动根会话受 sessionsDir 转录存在保护（sweep.ts:79-82 → artifact-dirs.ts:224-226），活动子代理受 ledger live 边保护（child-transcripts.ts:87-90），新建目录受 age 窗口保护——**未找到可复现的"活会话被当孤儿删"**（本次扫描范围内未见），真实风险是预算翻倍与 history 丢行。
- 判定→删除 TOCTOU：签名复检用候选自身 lstat（delete.ts:36-43,92-101）；对目录候选，**在既有文件上原地追加不改变父目录 mtime**→签名不变→删掉刚写的字节；新建/删除目录项才会改 dir mtime 被拦。被 7d/30d age 窗口缓解（见 ADC-4）。
- orphan "foreign" 判定：`record.ownerPid !== ownerPid`（orphan-process-journal.ts:687），只在 pid 消失或 start-id 不符时退休（:723-728），pid-only 且 pid 存活→保守当活；不杀进程、不碰 owner 自己的记录。误判边界：`getProcessStartId` 对存活 pid 返回 undefined（ps 不可用/权限）→ 被当死退休（:724-725 `current === undefined → false`）；以及 reap 追加（`appendRecord {create:true}` :699-709）与并发 `clearOrphanProcessJournal`（daemon-supervisor.ts:5535-5541）赛跑会把刚删的 journal 文件复活成单条陈旧记录。

### 3) 版本闸 fail-closed（L8D-1）
闸拒绝时是**跳过**（quarantine：按值函数/类从恢复态中丢弃，纯数据仍复活），没有任何"标记待删"状态：repl.py `_version_mismatch_reason` 对 None/不可解析版本返回 "python version unknown..."（14a4e8811 diff，prime-agent-runtime/src/rlm/repl.py @1340-1360），host 侧 `pythonVersion` 缺失即不转发版本→运行时闸 fail-closed（state-snapshot.ts:278-282,302-317）。闸不删文件、不产生待删堆积、闸放开也不会批量删（它唯一的"删"是内存值丢弃）。正控：test_l8d_impl.py（250 行，随提交加入）即该行为的测试载体——**本次未运行（时间），标 unverified**。

### 4) 删除后 UI/账本一致性
顺序：display("deleted") → ledger appendDelete → artifact rm（daemon-mode.ts:1226-1256）。写侧 rename 后删本进程缓存（rlm-subagent-display.ts:136-139）；跨进程读侧 stat+头尾 sha256 指纹复验（:214-222，LIFE-3），同尺寸 running→deleted 改写落在首 4096 字节内必被检出（单行 JSON ≤8KB 全覆盖，中段 >8KB 是自认盲区 :167-175）。"目录已删 UI 仍活跃"不可持续：family/liveEdges 每次列都对 child 转录 stat（rlm-ledger.ts:426-449,561-604），displayCache 命中也每次 stat 复验。真实弱点是 ADC-1：residue 回收父目录时把 `sub-xxxxxxxx/rlm-subagent.json`（display 墓碑）与子转录一起删掉，之后唯一幸存记录是 ledger delete 记录（探针实证目录整体消失），幸而 ledger 边 stat 掉→行消失，UI 不复活。

### 5) 打穿输入（已执行，探针即证据）
`/tmp/audit_r/round-41/artifact-del-work/probe.mts`（npx tsx 从 packages/coding-agent 跑，exit 0）：
- ADC-1：构造 artifactRoot：父会话 P 墓碑在役（8d 前删，树 9d 无写）、`<P>/sub-abcdefgh/<C>.jsonl`（C 有 spawn+delete ledger 记录）、harness 残留；`runRetentionSweep` 默认设置 → 输出 `class=artifact-residue-dirs scanned=1 reclaimed=1`，`child transcript still exists: false`、`parent artifact dir still exists: false`；对照组（同树、父不可回收）输出 `child-transcripts … skip … young:30d`。正控成立：同一棵树在 child-transcripts 类判 30d 年轻，residue 类 7d 全删。
- ADC-2：EventLog(maxBytes=200) 第 2 次 append 跨界**成功**（写路径不查写后大小），第 3 次与 replay 均抛 `exceeds 200 bytes (263); refusing to read`；`scanRlmLedgerDirectory` 对同一超界文件返回 `{"scanned":true,"deleted":["a","b"]}`；对 v:2 记录返回 `{"scanned":true,"deleted":["z"]}`（daemon 端 parseLedgerLine 对 v!==1 是 throw，rlm-ledger.ts:229-232,255-256）。

## 发现清单

**ADC-1（中）** 子代理转录的 30 天承诺被 residue 类的 7 天窗口击穿。
- 证据：artifact-dirs.ts:215-223（ledgerDeleted→可回收，注释明说"deleted RLM child keeps its transcript on purpose"却在父候选里不成立）、:390-393（descendantBlocker 只豁免 ledgerDeleted 的转录）；child-transcripts.ts:1-11 的前提"durable record is the display tombstone plus the ledger delete record"；settings-manager.ts:82-87（30d 默认）。display 墓碑 `sub-xxxxxxxx/rlm-subagent.json` 与转录同亡。
- 用户可感知：父会话删除后 artifact 清理失败（daemon-mode.ts:1259-1268 best-effort）或被中断时，7 天后子代理转录+display 记录整体消失，而非 30 天。

**ADC-2（中）** ledger 墓碑只增不删，超界后写读双 fail-closed，且 retention 读者无界、无版本闸。
- 证据：RetentionClassId 无 rlm-ledger 类（types.ts:11-23）；RLM_LEDGER_MAX_BYTES/MAX_RECORDS（rlm-ledger.ts:49-50）只用于拒绝读（:837-839）与拒绝追加（event-log.ts:273-275,367-368）；appendDelete 失败=删除失败（daemon-mode.ts:1243-1246）→ 大账本上用户无法删子代理；ledger-scan.ts:33-79 无 maxBytes、无 v 校验（P2/P3 探针输出）。删除记录堆积→fail-closed 不可达恢复路径（除人工找文件，:848-856 注释自认）。

**ADC-3（中）** 并发 sweep 无跨进程互斥；CLI 触发空 resident 集；预算与 history 报告被并发破坏。
- 证据：runner.ts:15,47-49；public-command.ts:334；sweep.ts:107,151-155；reports.ts:63-77；sweep.ts:214-228。负结论（未发现"活会话被并发删"）的正控：transcript 存在性与 ledger live 边两条保护在探针对照里均生效（young:30d / reference 跳过路径走通）。

**ADC-4（低）** 目录候选的签名复检对"既有文件原地追加"盲：append 不改父目录 mtime，statSignature 不变，删除越过新写字节。delete.ts:36-43,92-101 + aggregateTree（fs-walk.ts:110-150）以 mtime 为 age/identity 唯一来源；缓解=age 窗口本身。

**ADC-5（低）** cooldownMinutes 文档为全局下限（docs/settings.md:473 一带），但 artifact/child-transcript 类不应用它（grep：仅 tmp-dirs/logs/bash-temp/trash 用 Math.max(...cooldown)；artifact-dirs.ts:261-270、child-transcripts.ts:105-108 只用类窗口）。类窗口≫10 分钟，实际影响≈0，契约不符。

**ADC-6（低）** foreign reap 误判边界 + reap/clear 赛跑复活 journal。orphan-process-journal.ts:723-727（query 失败→当死）、:699-709（create:true 重建已清 journal）vs daemon-supervisor.ts:5535-5541。

**ADC-7（info）** 三层全墙钟、无单调钟；tombstoneInForce 严格小于（session-artifact-tombstones.ts:188）使同毫秒/时钟偏斜写判"superseded"（保守方向）；NTP 回拨会拉长窗口（同样保守）。未发现墙钟选择导致早删的方向。

## 未验证项
- test_l8d_impl.py 未运行（Q3 的行为依据是 diff+源码逐字引用）。
- 030b1ada4（heartbeat fan-out）、e3f9484f9（K3G child replies/memory streams）只在 diff-stat 层看过删除链相关面，未逐行读：本次扫描范围内未见与删除链的交互。
- repl.py/harness.py 只读了 L8D 区段；prime-agent-runtime 侧无删除动作结论限于该区段。
- "两个 attach 会话同时触发 sweep"未实机复现（attach 不触发 sweep；触发面=daemon timer+CLI）。
