# r31 — 多会话并发资源竞争扫描（daemon 常驻 + 多会话 + 并行子代理）

冻结：d68b42ab2c1c63431568ac42616ff23c0f7a3399（2026-09-16，r30 K3P-5 之后）
机器实证：本机 live daemon（pid 1729/3273）、9 个 live worker、27 条 kernel in-use 引用。
方法：源码通读（session-lease/venv-in-use/event-log/roster/daemon-socket/bootstrap 全文）+ 跨进程微基准（tsx 起真实 repo 源码，scratch agentDir 在 /tmp，不触真实 ~/.prime）。
去重：对 docs/fork/audits/decisions.jsonl 257 条做过关键词扫描；相关旧条 #4/#28/#105/#140/#159/#185/#219/#220/#256 已在对应发现里点名区分。

## 量化表（全部本机实测，2026-09-16）

### T1 会话租约 acquire（跨进程，一次 acquire，不同 session 路径）
| N 并发进程 | wall(s) | 单进程 acquireMs min/mean/max |
|---|---|---|
| 1 | 0.78 | 82.9 / 82.9 / 82.9 |
| 4 | 0.96 | 88.5 / 191.3 / 236.1 |
| 16 | 3.18 | 100.6 / 494.7 / 819.6 |
| 32 | 5.88 | 162.1 / 797.9 / 1386.3 |
注：含每进程一次 `ps -p` fork（实测 55.17ms/次）+ 2×fsync + mkdir/rename；N 大时受 CPU 争用混淆（32 个 tsx 进程），但 max 1.39s 已逼近 guard 1s 超时线。

### T2 同一 session 路径 8 进程并发（winner 持有 4s）
1 ok（acquire 90ms）/ 7 fail `Session is already active in another process`，失败延迟 216–1108ms。释放后 lease 目录清零（release 正常回收）。

### T3 guard 被第三方持有 2.5s 时 acquire
`ok:false, error:"Could not coordinate session lease: <dir>.lock", ms:1278.6` —— 100×10ms Atomics.wait 重试后硬失败，报错不含持有者信息，无排队无重试。

### T4 event-log appendSync（rlm ledger/语义边 substrate）
| 场景 | 结果 |
|---|---|
| 干净文件 durable append | 5.8ms（含 fsync） |
| 干净文件非 durable | 0.05ms |
| 死写者残留 torn tail | 31ms（25ms 静默观察 + 修复）后成功 |
| 活的慢写者仍在长尾 | **123.5ms 后拒绝**：`the unterminated final line is still being appended; refusing to append` |

### T5 fsync 风暴（N 进程各自文件 × 30 次 durable append）
| N | perOpMs min/mean/max |
|---|---|
| 1 | 3.24 / 3.24 / 3.24 |
| 8 | 13.98 / 14.61 / 15.31 |
| 32 | 4.15 / 43.59 / 54.90 |
结论：跨进程 fsync 无合并，32 并发 durable 写者人均慢 13.5×。

### T6 微基准
`getProcessStartId`（execFileSync `ps -p`）= **55.17ms/次**；realpathSync 热缓存 10.4µs；AgentRoster.write（含 2×canonicalPath）12.8µs/次。

---

## ① 会话租约/锁

### R31-1 [HIGH] guard 争用 >1s 即硬失败：无排队、无持有者归因、期间整线程被 Atomics.wait 阻塞
- 命题：`withLeaseGuard` 的 ELOCKED 重试只有 100×10ms；争用超 1s 直接抛通用错误，调用方（worker 开 openSession、rehydrate、appendOwnedSessionLine）拿不到"谁持有、要不要等"的任何信息。
- file:line：`packages/coding-agent/src/core/session-lease.ts:344-369`（`for (let attempt = 0; attempt < 100; …) Atomics.wait(…, 10)`；`attempt === 99` 抛 `Could not coordinate session lease`）。
- 逐字证据：`if (attempt === 99) { throw new Error(\`Could not coordinate session lease: ${directory}\`); } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`
- 影响：同 session 路径的跨进程 attach/compact/branch 在 guard 慢持有（下条 R31-2 的 ~80-90ms 持有，或 fsync 风暴下更长）时，第二个进程最多阻塞主线程 1s 后硬失败；daemon worker 的 event loop 在重试期间逐 10ms 被同步卡住（Atomics.wait 是阻塞等待）。
- 可复现：T3（guard_holder 持 2.5s → 1.28s 后失败）。
- confidence：高（实测红证）。
- 去重：#256（DAT-2 无租约 repair+append）不同轴；旧条没有 guard 超时/归因问题。

### R31-2 [MED] guard 临界区含 `ps` fork + 2×fsync：单次持有 ~80-90ms，放大同路径争用
- 命题：`getCurrentProcessStartId()`（macOS 走 execFileSync `ps -p`，55ms）在 guard 内执行；owner 记录写入 2×fsync 也在 guard 内 → guard 持有时间被这两项主导。
- file:line：`session-lease.ts:464-471`（owner 构造在 `withLeaseGuard(directory, () => { for…})` 循环内调 `getCurrentProcessStartId()`）+ `session-lease.ts:407-439`（`writeOwnerRecordAtomic` fsyncSync 文件+目录）。
- 逐字证据：`processStartId: getCurrentProcessStartId(),`（在 guard action 的 attempt 循环体内）；`fsyncSync(descriptor); … fsyncSync(directoryDescriptor);`
- 影响：同路径并发 open 的串行段 = 55ms(ps)+2×fsync(≈6ms)+mkdir/rename；T2 的 216–1108ms 失败延迟即此串行段被 8 进程分摊后的形态。fsync 风暴（T5：32 并发时 43.6ms/次）会把 guard 持有推过 1s → 触发 R31-1。
- 可复现：T2/T3/T6 组合推算；ps 成本实测 55.17ms。
- confidence：高。

### R31-3 [INFO/负结论] 租约无"续期"概念；attach/compact/branch 跨会话零争用；同进程同路径有无界等待但错误路径全覆盖
- 命题：租约是 acquire-once / hold-for-lifetime / release-on-exit，无 TTL 无 refresh；"续期路径不存在"本身即答案。lease key = sha256(canonical session path)，不同会话不同 `.lock` 目录，guard 文件也各自独立 → N 会话并发 attach/compact/branch 在租约层互不争用。
- file:line：`session-lease.ts:96-99`（`leaseDirectory` 哈希键）；`SessionLease.release`（仅 rmSync）；daemon 进程内串行化 `daemon-mode.ts:1784-1804`（`reservingSessionOpens`）+ `1788 await reservation`（无超时等待）。
- 正控：T1（32 个不同路径全部成功，无跨路径阻塞，延迟增长来自机器负载）；T2（同路径 fail-fast 立即报 `SessionAlreadyActiveError`）。"没有静默排队"的正控 = T2/T3 都是显式报错。
- 影响：无饿死路径；唯一无界等待是进程内 `await reservation`（1788），其释放点覆盖 try/catch/finally（1840-1844、1934-1948 已核对），实际不构成挂死。
- confidence：高（负结论带双正控）。
- 去重：#159/#163/#188 是 stop/记账轴，不是租约轴。

### R31-4 [LOW] 本机 session-leases 现存 48 个 stale lock 目录，sweep 有 6h 门槛
- 实测：`ls ~/.prime/agent/session-leases | wc -l` = 48；sweep（`retention/leases.ts` + `classifyLeaseDirectory`）靠 staleLeaseHours 门槛+pid 判活，活 pid 判定同样走 55ms ps fork（`isLeaseOwnerAlive`→`getProcessStartId`）→ 多活 lease 时 sweep 单条 55ms（N=48 全 stale，本次为死 pid 快速跳过）。
- confidence：中（未实测 sweep 端到端耗时，判活成本由 T6 支撑）。

## ② socket 目录 / TMPDIR

### R31-5 [HIGH] worker-*.sock 永不清扫：SIGKILL 死掉的 worker 留下 socket 文件，无界累积
- 命题：worker socket 清理只挂在 `process.on("exit")`（worker 进程自身）；被 SIGKILL 的 worker（停机兜底 4790/8836/8840/8989 四处 `SIGKILL`）无法执行；supervisor/retention 均无 `worker-*.sock` 清扫路径。
- file:line：清理注册 `daemon-mode.ts:7736-7738`（`const exitHandler = () => this.cleanupSocketPath(); process.on("exit", exitHandler);`）；SIGKILL 点 `daemon-supervisor.ts:4790, 8836, 8840, 8989`（`signalProcessGroupOrProcess(worker.descriptor.pid, "SIGKILL")` 等）；socket 命名 `daemon-supervisor.ts:1073-1079`（`worker-${key}-${workerId.slice(0,12)}.sock`）。
- 逐字证据（supervisor.ts:4790-4791）：`signalProcessGroupOrProcess(worker.descriptor.pid, "SIGKILL"); // SIGKILL is uninterceptable; this wait only covers kernel teardown of the old process and socket.`
- 实测形态：`$TMPDIR/prime-agent-501/` 共 71 项 = 1 daemon.sock + 1 lock 目录 + 68 个 worker-*.sock，其中 live worker 9 个 → **59 个死 socket**（`find -mtime +1` = 44 个超一天，最早 Sep 6）。当前速率 ~7 个/天；50+ 会话/天形态下按 watchdog 击杀率线性放大。
- 影响：inode 只增不减（每 sock 0B/1 inode）；共享目录 readdir 线性变慢；`ensureDefaultDaemonSocketDir`（daemon-socket.ts:292-312）每次 worker spawn 做 exists/lstat/chmod O(1)，不受影响——压力是纯累积型。FD 侧无压力：live socket fd 属 worker 进程自己（lsof 实测 daemon 持 12 个 unix fd）。
- 可复现：`ls $TMPDIR/prime-agent-$(id -u) | grep -c worker` vs `ls ~/.prime/agent/daemon-workers/*/ | grep -c json`（68 vs 9）。
- confidence：高（实测 + 源码双证）。
- 去重：#140 是"socket 还在 $TMPDIR 会被 3 天清"的身份轴；本条是"没有任何清扫路径的累积轴"，互补不重叠。

### R31-6 [MED] TMPDIR 内 prime-agent-* 1798 项：test 泄漏 1035 + rlm 临时会话目录 314 无清扫
- 实测 breakdown：`prime-agent-test-supervisor-registry` 1035、`prime-agent-rlm-*` 314（`agent-session.ts:12534-12537 mkdtempSync(join(tmpdir(), "prime-agent-rlm-"))`，全 0B，未找到任何删除路径）、`prime-agent-telemetry-*` 308、bootstrap 14、其余零星。父目录链接计数 65535（显示上限）。
- 影响：同 R31-5 的 inode 压力面；1035 条 test 泄漏说明测试态也没有回收契约（与"sanitize test env"纪律互为因果）。
- confidence：中高（目录实测；rlm 目录删除路径"未见"是扫描范围内结论，正控：同目录下 telemetry/bootstrap 同样无清扫调用点，grep `prime-agent-rlm` 删除无命中）。

### R31-7 [INFO] daemon.sock.*.log 形态（有 retention，非新发现）
- 实测：`~/.prime/agent/logs` 1812 文件，其中 `daemon.sock.*` 1407，最早 Sep 4（<14d 窗口内），当前活跃 805KB。retention logs 模块覆盖（`retention/logs.ts` logFileDays=14）。旧条已覆盖该轴（r28 记忆：曾 1606 文件无条件保留，已修）。

## ③ kernel venv

### R31-8 [MED] 同 venv 并发无锁无排队：per-pid 引用文件 + boot claim；需要重建时对后到会话直接抛错
- 命题：两会话要同一 venv = 各自写 `<venv>/.in-use/<pid>` 引用文件（文件名即 pid，天然无冲突无排队）；重建决策 `decideKernelVenvRebuild` 在 liveReferences>0 或 state unknown 时 `defer` → 抛 `KernelVenvRebuildDeferredError`（提示 "Retry once those kernels exit"）。
- file:line：`kernel/venv-in-use.ts:131-175`（recordKernelVenvInUseSync：先撤自己的 boot-claim 再写引用）；`venv-in-use.ts:479-503`（decideKernelVenvRebuild defer 分支）；`bootstrap.ts:1592-1602`。
- 逐字证据：`return { mode: "defer", … reason: \`${liveReferences} live kernel reference(s)\` };` 与错误文案 `"Retry once those kernels exit, or set PRIME_AGENT_KERNEL_PYTHON …"`。
- 影响：混合代际窗口（本机现在就是：5 个 generation、27 条 live 引用分布在 4 个）里，identity 变更后需要重建的会话被硬拒，用户可见为 boot 失败；不存在排队或自动等待。
- 可复现：`for d in ~/.prime/agent/kernel-venv-*; do ls $d/.in-use | wc -l; done` → 0/7/3/13/4。
- confidence：高。
- 去重：#105（代际回收方向 bug，已修）、#34/#35（构建产物/就绪复检）不同轴。

### R31-9 [MED] venv 状态读取对每条活引用 fork 一次 `ps`（55ms/条）：boot 的 GC trigger 1 每次都要交这笔税
- 命题：`readKernelVenvInUseState` → `judgeReferenceEntry` → `referenceIsLive` → `getProcessStartId(record.pid)`（execFileSync `ps`，实测 55.17ms）；`pruneKernelVenvGenerations` 在**每次 boot**（bootstrap.ts:1560，GC trigger 1，warm 路径之前）对所有非 active generation 读 in-use 状态。
- file:line：`kernel/reference-records.ts`（`referenceIsLive`：`const current = getProcessStartId(record.pid);`）；`venv-in-use.ts:316-323`（judge 调用点）；`bootstrap.ts:1556-1560`。
- 影响：本机当前形态（27 条 live 引用，4 个非 active 代际共 27−active 条）→ 每次 kernel boot 在 worker 事件循环上同步付 (live refs of non-active gens)×55ms，worst ≈ 1.5s/次。50 并发会话共享同一 identity 时（单 generation）此税≈0——税只出现在混合代际期，恰是升级后最需要快速拉起 worker 的窗口。
- 可复现：T6 的 55.17ms/次 × 实测引用数推算；live 引用分布见 R31-8。
- confidence：高（微基准 + 代码路径核对；未逐 boot 实测端到端，扣一档）。

### R31-10 [LOW] venv 磁盘上限形态：每 identity 一代 + 保留 1 个无引用代，全部被引用的代永久保留
- 实测：5 代 × ~230MB = 1.15GB（agent 目录总 4.5GB）。规则：`RETIRED_VENV_RETENTION = 1`（venv-in-use.ts:30），引用中的代不删 → 上限 = 并存 identity 数 × ~230MB，无全局字节预算。
- confidence：高。

## ④ IO 竞争 / fsync

### R31-11 [HIGH] 跨进程 fsync 无合并：32 并发 durable 写者人均 13.5× 延迟（43.6ms/次）
- 命题：会话 transcript 本身不 fsync（见 R31-12 负结论），但每 worker 的 orphan-process-journal（每 spawn 一个 detached child 一条 fsync 记录，orphan-process-journal.ts:108 `appendRecord(path, record, { fsync: true …})`）、kernel 引用文件（reference-records.ts writeCompleteFile fsync）、lease owner 记录（2×fsync）、cron/settings 原子写都在 worker/spawn 路径上 fsync；这些 fsync 跨进程互不合并，实测随并发数线性劣化。
- file:line：`orphan-process-journal.ts:108/188`；`reference-records.ts`（writeCompleteFile `fsync`）；`session-lease.ts:407-439`。
- 实测：T5 表（1→8→32 进程：3.24 → 14.61 → 43.59ms per op，max 54.9ms）。
- 影响：50 会话 × 各自 bash/子代理 spawn 时，每个 spawn 的 journal fsync 争用全部其他 worker 的 fsync → 单 spawn 持久化从 3ms 变 40ms+ 量级；这是 spawn 延迟的隐藏串行化点（不在任何单进程 profile 里可见）。
- 可复现：T5 脚本（bench/fsync_child.ts）。
- confidence：高（实测；CPU 争用混淆已在注里声明，但 8→32 的增长远超 CPU 核数比例，主导项是 IO 串行化）。中高。
- 去重：#245（manifest 无原子写，已修 DAT-4）不同轴。

### R31-12 [负结论+正控] 会话 transcript append 不 fsync、无持久化队列：每条 open+fstat+write+close 同步完成
- 命题：`appendPrivateFile`（private-files.ts:380-405）每次 append 都 openSync(O_APPEND|O_NOFOLLOW)+fstatSync+writeFileSync+closeSync，**无 fsyncSync**、无 fd 复用、无批量/合并队列；session-manager `_persist`（2535）直接调它。所谓 "async write 队列" 在 transcript 路径不存在；存在队列的只有 settings-manager（writeQueue，进程内 promise 链）与 agent-traces 上传限速闸（agent-traces.ts:562-575）。
- 正控：repo 全量 grep `fsync`（非 test）命中清单 = cron-jobs/orphan-journal/settings/event-log(durable 可选)/session-lease/agent-traces 注释——该方法能检出 fsync（cron/orphan 等确实命中），private-files append 不在命中中；对照实测 durable 3.24ms vs 非 durable 0.05ms（64×），若 transcript 每 message fsync，50 会话流式下每条消息都要吃 T5 的争用延迟——现状没有，这是设计选择（崩溃丢尾部行，由 DAT-1/DAT-2 修复兜底）。
- 影响：崩溃窗口内最近若干条 message 丢失（既有已知取舍）；并发面收益：transcript append 相互完全独立（各自文件各自 fd），N 会话无共享锁。
- confidence：高（负结论带检出正控 + 成本对照）。

### R31-13 [MED] event-log（rlm spawn ledger / 语义边）并发争用：torn tail 每次多付 25-31ms；活写者长尾直接丢这条 append
- 命题：`appendSync` 前必跑 `repairTailSync`：死写者 torn tail → 25ms 静默观察后 blank（实测 31ms 总延迟）；观察期内仍在生长的尾巴 → 123.5ms 后抛 `still being appended; refusing to append`——这条 append 丢失（除非调用方重试，本轮未验证调用方重试行为，标注 unverified）。
- file:line：`event-log.ts:66-84`（TAIL_QUIESCENCE_MS=25、TAIL_OBSERVATION_WINDOWS=4）、`appendSync`（`if (existsSync(this.path)) { this.repairTailSync(); }`）、拒绝文案 `refusing to append`。
- 影响：多写者共用一个 ledger 文件时（设计上就是多写者），任一写者崩溃留下 torn tail 后，所有后续 append 每条 +25ms 同步阻塞；慢速外部写者场景会丢记录。25ms×每条在 supervisor/worker 单线程上是纯串行损耗。
- 可复现：T4。
- confidence：高（两端实测）；调用方重试行为 unverified。
- 去重：#28（ftruncate 吃记录，已改 blank-in-place）——本条是修复后的残余延迟/拒绝面，非同一命题。

## ⑤ daemon 单线程热点（LAT-1/LAT-2 修后残余）

### R31-14 [HIGH] supervisor 每次 worker spawn 在事件循环上同步 fork `ps`：55ms×N 的队头阻塞
- 命题：`getProcessStartId(childPid)`（execFileSync `ps`）在 supervisor 的 spawn 流程同步执行；supervisor 单线程，N 个并发 create/恢复 → 全部客户端命令（roster、attach、list、status）排队 N×55ms。
- file:line：`daemon-supervisor.ts:3989`（`childProcessStartId = getProcessStartId(childPid);`，在 `await spawnSettled` 之后的主流程）；ps 查询构造 `session-lease.ts:177-186`（execFileSync）。
- 逐字证据：`childPid = child.pid; childProcessStartId = getProcessStartId(childPid);`
- 影响：50 会话同时冷启动/恢复 → ~2.75s 的 supervisor 全局队头阻塞（期间所有会话的每个 daemon 命令都慢）；这是 LAT-1/LAT-2（roster flush 串行化）之外未被处理的同型残余。
- 可复现：T6（55.17ms/次）× N 推算；代码路径 3989 无异步替代（异步版 `getProcessStartIdAsync` 存在但此点未用）。
- confidence：高（微基准实锤 + 调用点核对）。
- 去重：#185/#219/#220 全是 worker 侧 roster flush 成本，本条是 supervisor 侧 spawn 路径，新轴。

### R31-15 [MED] supervisor 每条日志 = 同步 open/stat/append/close + O_EXCL 锁文件 create/rm；争用最坏 ~185ms Atomics.wait
- 命题：`this.log()` → `appendRotatingLog`（config.ts:932-957）每行做 exists/stat/open/write/close 加 `<log>.rotate.lock` 的 O_EXCL create+write+rm（acquireLogLock 40 次 × 1..5ms Atomics.wait 上限 ≈ 185ms 同步阻塞）；worker 的每行 stderr 都走这条路（daemon-supervisor.ts:3949 `attachJsonlLineReader(child.stderr, (line) => this.log(…))`）。
- 影响：多 worker 高频 stderr（崩溃刷栈、npm warn 等）时 supervisor 循环被同步 IO 串行化；锁争用窗口虽 bounded 且 best-effort（拿不到锁就放弃 rotation 不丢行），但 Atomics.wait 依然卡主线程。
- file:line：`config.ts:866-915`（LOG_LOCK_ATTEMPTS=40, LOG_LOCK_MAX_DELAY_MS=5, Atomics.wait）、`daemon-supervisor.ts:3948-3953`。
- confidence：中高（代码+常量推算，未实测 supervisor 端延迟）。

### R31-16 [LOW/负结论+正控] roster 残余：AgentRoster.write 的 2×realpathSync 实测仅 12.8µs/次，不是热点；真正的残余是"全在单线程上"
- 命题：LAT-1/LAT-2 修后（delta 只重算脏行、setImmediate 合并 flush），supervisor 侧 `applyWorkerRosterDelta`（5781-5808）每 entry 一次 `writeRosterEntry`→`AgentRoster.write`（dropIndexes+write 各一次 canonicalSessionPath=realpathSync）。实测热缓存 12.8µs/write：50 worker × 5 entry × 100ms 一次 delta ≈ 2500 write/s × 12.8µs = 3.2% 单核——不构成瓶颈。正控：微基准 T6 证明测量方法有效（realpathSync 单独 10.4µs 与 write 差值吻合）。
- 真正残余：`applyWorkerRosterSnapshot`（5810-5878）每次全量 `rlmSpawnLedger().liveEdges()`（整文件 replay+parse）+ 每条 edge 一次 canonicalSessionPath；以及 R31-14 的 ps fork —— 都在同一事件循环上。
- confidence：高（微基准）。
- 去重：#4/#185/#219/#220 是 flush 的 O(n) 重建轴（已修/已知），本条给出"修后还剩什么"的量化边界。

---

## 汇总：并发数 × 延迟/失败（打穿给输入）

| 输入形态 | 量化结果 | 对应发现 |
|---|---|---|
| 32 进程并发 acquire 不同 session lease | mean 798ms / max 1386ms（逼近 guard 1s 线） | R31-1/2 |
| 8 进程并发同一 session | 1 成功 + 7 `SessionAlreadyActiveError`（216–1108ms） | R31-3 |
| guard 被持 2.5s | 1.28s 后硬失败，无归因无重试 | R31-1 |
| 32 并发 durable append（各自文件） | 43.6ms/次（13.5×单进程） | R31-11 |
| event-log 活写者长尾 | 123.5ms 后 append 被拒（记录丢失） | R31-13 |
| 50 worker 并发 spawn（supervisor） | ~2.75s 队头阻塞（55ms×50 ps fork） | R31-14 |
| 混合代际期每次 kernel boot | (非 active 代 live 引用)×55ms，本机现形态 worst ≈1.5s | R31-9 |
| SIGKILL worker | socket 文件永久遗留（实测 59 个） | R31-5 |

方法与产物：/tmp/audit_r/round-31/bench/*.ts（lease_child / guard_holder / elog_appender / elog_writer / fsync_child / nd_child / micro），全部走 repo 真实源码（npx tsx，cwd=repo，不写 repo）。环境已 unset RLM_*/PRIME_AGENT_*/PI_*。
未验证项：R31-13 调用方对 `refusing to append` 的重试行为；R31-4 sweep 端到端耗时。
