# r42 簇C 实施报告：删除链窗口统一（delete-chain-unify，方案书 round-41）

实施线：r42-implC-delete（本席＝编排+验证；三施工子席并行，各持独立工作树/分支，基线全部 a5456df68）
方案书：/tmp/audit_r/round-41/delete-chain-unify-plan.md（唯一修法依据，逐节执行）
主仓 /Users/a1/Desktop/ai/prime-agent：零写入（只 git worktree add 元数据 + branch refs）
收口时间：超预算（母席 45 分钟；C2 施工席实际 ~50 分钟，C3 超时后收口模式）——见"时间账"。

## 交付总览

| PR | 分支（基线 a5456df68） | commit | 红测证据 | 独立复验（本席亲手） |
|---|---|---|---|---|
| PR-C1 窗口单一权威 | r42/c1-window-authority | 2755faa8c | /tmp/audit_r/round-42/c1-red.txt（未改码 2 failed） | 45/45 测试绿；npm run check EXIT=0；diff 逐节核对 |
| PR-C2 ledger 梯子 | r42/c2-ledger-ladder | 4e5f1cbf7 | /tmp/audit_r/round-42/c2-red.txt（未改码 4 failed）+ 变异正控 c2-mutation-control.txt | 126/126 测试绿（6 文件）；npm run check EXIT=0；压实关键路径逐行核对 |
| PR-C3 sweep 跨进程锁 | r42/c3-sweep-lock | f4ddf3bee | c3-red.txt（行为红探针+纯净基线 6/6 红+变异正控） | 72/72 测试绿；npm run check EXIT=0；runner 守卫逻辑逐行核对 |

## PR-C1：窗口判定的单一权威（ADC-1 候选A，偏差≈none）

- `fs-walk.ts`：TreeAggregate 新增 `transcripts: {id, path}[]`（收集挂在既有 lstat 处，零新增 syscall）。
- `child-transcripts.ts`：年龄公式提为导出 `judgeChildTranscriptAge`（公式逐字不变：`now - max(转录 mtime, aggregateTree(subDir,{maxDepth:2}).newestMtimeMs)` vs `childTranscriptDays*86400000`；unverifiable=保守保住），**一个函数两个调用点**＝方案书"单一权威"的代码事实。
- `artifact-dirs.ts` descendantBlocker：已删子转录不再一刀切豁免，改调同一判定；未过窗 → `SKIP.young("child-transcript:30d")` 保住父目录；过窗 → 现行为豁免；活边/ledger 未扫描 → 现行为不动。
- `docs/settings.md`：权威表（按字节身份不按目录）+ max-window 规则。
- 红测：未改码 2 failed（residue 7d 整目录吞掉 30d 窗内转录+父目录）→ 改后 6/6 绿；正控 +31d 整目录回收；等价1 纯 residue 7d 照旧（既有 4 套件 39 例全绿）；等价2 end-state 7d/7d ≡ 31d/30d 逐字段相等；保守面 ledger 缺失 → reference:descendant-transcript:*。
- 唯一留白（保守方向，报告列明）：blocker 遇子目录树不可读取 `unverifiable:child-transcript-tree` 保目录。

## PR-C2：ledger 超限降级梯（ADC-2 候选 2A+2B，含两处留席决策的采纳）

- **读者对齐**（独立成立）：`ledger-scan.ts` 超界（size>32MiB 或 records>100k）→ `scanned:false`（sweep 全按 unknown 保对象）；`record.v !== 1` 行跳过（v:2 不再被吃成 delete）。界值挪到中性模块 `core/rlm-ledger-bounds.ts`（写读两侧同源，core/retention 不反向 import modes）。
- **写侧梯子**：`RlmSpawnLedger.appendRecord` 写前投影 size/records；将越界 → proper-lockfile 守卫下等价压实 → 重投影 → 仍越界才抛类型化 `RlmLedgerOverBoundError`（带活边数/边界/建议动作）。`compactionEnabled:false`（settings `retention.ledgerCompactionEnabled`，默认开）回到 fail-closed 现状＝方案书回滚杆。
- **压实**（`core/rlm-ledger-compaction.ts`）：重放全文件 → edgeKey 归约终态边 → meta 首行（保留原 meta）+ 每活边一条终态 spawn + 每已删边（子目录仍存在，谓词与 LIFE-1 一致）spawn+delete；子目录已灭的已删边不落盘。temp + fsync + **重 stat（size+mtime 与快照一致才 rename，不一致弃局）** + rename + 目录 fsync；**不留 .bak**（留席决策①采纳）。守卫只压实时持有（20×10ms，同 orphan-journal 形态），append 热路径零新增锁。
- **2B 类形状**（留席决策②采纳）：`retention/rlm-ledger-compaction.ts` 注册为第 12 个类，兜底扫旧二进制留下的超界文件；报告行 scanned/reclaimed/bytes；类序最后（重写别的类读证据的文件，注释说明）。
- **daemon 透传**：delete 路径捕获 RlmLedgerOverBoundError → 类型化消息（不裸栈）。
- 红测 4 failed（scanned:false×2、v:2 被吃、append 越界拒读）→ 绿 10/10 + 既有 9 套件 160/160；**变异正控**两次（reduce 改空转→1 红；死亡谓词失效→2 红）证明等价断言的检出力；重放等价断言=压实前后 edges() 六元组逐 key 全等 + raw 视图 + family() 同比。
- 偏差（施工席申报 10 条，本席核对关键的 5 条）：① appendSpawnUnlocked 建议性重复入场检查在"界拒读"时跳过+记日志（否则 spawn 到不了梯子；该检查本就自认 advisory）② 既有 bound 测试断言 rejects→resolves 并以 compactionEnabled:false 保留 fail-closed 正控（方案语义即此）③ deleteRlmSubagent 消费点测到 ledger 契约层（未端到端驱动 daemon，时间盒）④ doctor/status 体积面未做（可选项）⑤ 压实重打 at 时间戳、v:1 未知 op 记录随终态集定义丢弃（均无读者消费）。⑥ 压实引擎放 core/ 而非 rlm-ledger.ts（避免 core→modes 反向依赖，方案文件位置偏差、意图不变）。
- 结构上值得注意：`rlm-ledger.ts` 的记录形状/解析/reduce 抽到 core 模块共享（parseLedgerLine→parseRlmLedgerLine 导出），daemon 侧两处 RlmSpawnLedger 构造点接线 compaction 开关。

## PR-C3：sweep 跨进程锁（ADC-3 候选 3A，commit f4ddf3bee，10 files +619/-29）

- `runner.ts`：`runRetentionSweepOnce` 返回 `RetentionSweepOutcome`（lockHeld / lockUnavailable / report / lastReport / holder）。持 `<retentionDir>/sweep.guard`（lockSync realpath:false，stale 30min＝breaker 封顶之上一个量级，onCompromised 显式化只置 lost 不 throw）；**writeRetentionReport 在守卫内**（history ≥HISTORY_LIMIT 的读-改-写被串行化，丢行结构性消失）。ELOCKED → 不扫：CLI 打印 last report + in-flight 行（读 sweep-in-progress.json 报 pid/startedAt）exit 0；非 ELOCKED 失败 → 无锁降级 + warn（"锁护账目不护删除"写进注释）。持锁期 best-effort 写/删 `sweep-in-progress.json`（owner 侧写＝lease 先例裁剪版）。进程内 inFlight 保留。`retention.sweepLockEnabled`（默认开）＝settings 级回滚杆。
- `daemon-supervisor.ts`：`lastRetentionSweepAtMs` 改为 sweep 完成后才置位（锁跳过不置位，下个 check tick 重试）；`public-command.ts`：in-flight 文案。
- 中途被抢（guard lost mid-sweep）：选择照写报告 + warn（删除已发生，隐瞒更糟）——申报偏差，合理。
- 红测三层：① 行为红探针（未改 src：guard 被持时仍 reclaimed=1、history 加行、无 lockHeld 字段）；② 同一测试在 a5456df68 纯净导出树 6/6 红；③ 变异正控（摘掉守卫 5/6 红、回滚杆测仍绿）。绿：retention-lock 6 + 等价组合 120/120 + 本席复跑 72/72；npm run check EXIT=0（本席独立复跑）。
- 事故记录：wt-c3 工作树在读码期间被外部删除（当时零改动、分支仍在基线）；施工席同路径同分支同基线重建后开工，零损失——round-42 目录是多车道共享的 /tmp，疑似邻道清理脚本误伤，主仓不受影响。

## 时间账（修订）

12:32 起工 → 12:43 C1 提交 → 13:05 C2 提交（超 22 分钟时间盒，~50 分钟，全绿交付）→ 13:11 C3 收口指令 → 13:50 C3 提交。C2/C3 是本簇最大/最险改动面，0902/qwen-flash 席先重读源码再动手；总超时根因＝最险单点（ledger 压实）占用全部时间盒余量，按"质量优先于时间盒、如实记录"处理。


## 通用门槛

- 三 PR 各自：红测先行（证据文件在案）、vitest 直调 node + 清泄漏 env、`npm run check` EXIT=0（**三 PR 均由本席独立复跑**：C1 45/45、C2 126/126、C3 72/72，check 全 EXIT=0）、check:test-hygiene OK、changelog fragment 一枚、提交只含本席文件（staged 清单核对）、纯净树 tsgo EXIT=0（施工席 git archive 自证）。
- 未跑：npm run build / dev / test（禁令）；doctor --fix / daemon ps -k 未用。
- 测试跑法：`cd packages/coding-agent && env -u RLM_*… node ../../node_modules/vitest/dist/cli.js --run <file>`（清 19 个泄漏变量）。
