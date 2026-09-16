# round-31 impl-rcB — guard/清扫族修复（RC-2/RC-3/RC-5/RC-6 + K3P-45 并入）

- 冻结 SHA：`516f46e636e3fc3fa3286d3ab663ef0c5f2911ad`（主仓 HEAD，只读）
- 工作树：`/tmp/audit_r/round-31/wt_rcB`（detached，symlink node_modules）
- 交付提交：`01d1347d8`（单提交，24 文件，+1095/−191；pre-commit hook 全绿）
- 红证 → 绿证全部真实跑过（vitest 直调 node，env -u 泄露变量，批次 ≤3 文件）
- pristine 复验：`git archive HEAD` 解包 + symlink node_modules + `npx tsgo --noEmit` → EXIT=0

## RC-2 session-lease guard（R31-1 + R31-2）

**改动**（`src/core/session-lease.ts`）：
1. `withLeaseGuard`（100×10ms `Atomics.wait`，344-369 原文）删除，改 `withLeaseGuardAsync`：同预算（100 次 × 10ms）但退避是 `await delay(10)`（timers/promises），事件循环不再被逐 10ms 卡。
2. attempt 用尽 → `SessionLeaseGuardContentionError`（code `session_lease_guard_contended`）：**持有者归因**来自 owner 记录（`readLeaseOwner`）——pid、activeSessionId 标记、acquiredAt；owner 缺失/不可读/corrupt 分别给出对应描述。错误文案含建议（等持有者完成，或持有者消失后删 `${dir}` 与 `${dir}.guard` 强制）。
3. 临界区瘦身（R31-2）：
   - ✅ 挪出：own-pid start-id 预热（macOS 首次 `ps` fork ~55ms）→ guard 之前；candidate mkdir + `writeOwnerRecordAtomic`（**2×fsync 全部**）→ guard 之前（candidate 路径唯一、无竞争，只有 publish rename 与 reclaim 决策需要跨进程串行）。guard 内只剩：renameSync、EEXIST 时的 owner 读取与处置、reclaimStaleLease。
   - ❌ 挪不动（如实记）：existing-owner 的 `isLeaseOwnerAlive`（含 `getProcessStartId(owner.pid)` 的 ps fork）留在 guard 内——挪出会产生 check-then-reclaim TOCTOU：两个进程可能同时判死并双 reclaim，把活租约误回收。仅 EEXIST 路径触发（真正争用时），且 `isProcessAlive`(kill 0) 先行、ps 只在 owner pid 活着时 fork。
4. `acquireSessionLease` → `acquireSessionLeaseAsync`（全 6 个 src 调用点 await 化：agent-session-runtime×2、main、daemon-mode×2、session-manager 经 appendOwnedSessionLineAsync）。`SessionLease.release()` 保持同步签名：进程内簿记同步删除，目录删除改 fire-and-forget 异步（同 backoff 预算，best-effort 语义不变）。

**红测** `test/r31-guard-contention.test.ts`（改前行为红：guard 被 2.5s 持有，①期间 10ms 心跳定时器被饿死 ②错误无 pid）：
- 红跑（改前 sync API）：`AssertionError: expected 'Could not coordinate session lease: …' to contain '73631'`（attribution 缺失；事件循环断言同红）。
- 绿跑（改后 async API）：18/18 pass（含 session-lease 套件 16 个全绿）。

## RC-3 worker-*.sock 清扫（R31-5）

**改动**（`src/modes/daemon/daemon-supervisor.ts`）：
- 新导出 `sweepStaleWorkerSockets({supervisorSocketPath, descriptorDir, socketDir?, isProcessAlive?, now?})`：只扫本 supervisor key 的 `worker-<key>-*.sock`。规则：descriptor 命名且 pid 死 → 删；pid 活 → 保留（unlink 活 socket 会打断 worker）；无 descriptor → 60s 龄门（**DAT-3 先例**：orphan-process-journal `STALE_TEMP_MAX_AGE_MS`），龄内保留（spawn-in-flight 窗口）、过龄删。`isProcessAlive` EPERM/复用 pid 一律读作活（fail-safe 不删）。
- 挂点：①supervisor `start()` 在 `loadWorkerDescriptors()` 后全量 sweep；②`deleteWorkerDescriptor`（worker 死亡收尾的公共出口：stopWorker、timed-out finalizer、reaper 等 8 个调用点）→ `removeDeadWorkerSocket`：pid 判死才 `rmSync(socketPath)`。恢复中的 worker 无影响（relaunch 复用 socket 路径且 `prepareDaemonSocketPath` 会 unlink 陈旧文件再 bind）。
**红测** `test/r31-worker-socket-sweep.test.ts`：死 pid（真实 spawn-exit 的 pid）socket 被清、活 pid（process.pid）保留；孤儿 socket <60s 保留、≥60s 清。改前红 = 该清扫面不存在（函数未导出，测试 import 失败）；行为侧红证据为审计实测（59 个死 socket 累积）。
**如实记**：supervisor 全进程 e2e（spawnSupervisor + SIGKILL worker）未在本轮 60s 命令预算内跑，integration 覆盖靠挂点代码审读 + 单元级 sweep 断言。

## RC-5 event-log append（R31-13）

**改动**（`src/core/event-log.ts` + `src/modes/daemon/rlm-ledger.ts`）：
- 新 `appendAsync`：观察窗（25ms×4）异步化——`repairObservedTailAsync` 用 `await delay` 探测（sync 路径原样保留给 `appendSync`），尾态判定/blank 逻辑抽成共享 `blankObservedTail`。
- 被拒（still being appended）→ `TAIL_CONTENTION_BACKOFF_MS=500ms` 退避后**重试一次**；再拒则显式抛（调用方可见，不静默丢）。`flush()` 语义不变（appendAsync 在 enqueue 链上）。
- rlm-ledger `appendRecord` → async 走 `appendAsync`（spawn/rename/delete 入队闭包 async 化）。
**红测** `test/r31-event-log-append-retry.test.ts`：跨进程活写者（spawn 的 node 子进程，10ms/byte 写 ~400ms）持长尾时 append。改前红：`appendSync` 抛 `still being appended; refusing to append`（记录丢失）。改后绿：退避重试后落盘。第一版同进程写者红测失效（sleepSync 阻塞饿死本进程写者，看不见 growth）——换成真子进程才复现审计 T4 形态，此坑已写进测试注释。
**未做**（任务豁免）：appendSync sync 路径的观察窗仍同步（保留给同步调用方；生产唯一调用方 rlm-ledger 已迁 async）。

## RC-6 ephemeral rlm 会话目录（R31-8）

**改动**（`src/core/agent-session.ts`）：`_createEphemeralRlmSessionDir` 置 `_rlmSessionDirEphemeral` 标记；`dispose()` finally（子会话先 dispose、其收尾 flush 之后）`_removeEphemeralRlmSessionDir` rmSync 整树，失败仅 warn。非 ephemeral 来源（config.rlmSessionDir、session artifact dir）不删。
**红测** `test/r31-ephemeral-rlm-dir-dispose.test.ts`（公 API：`runRlmChild` → `session_dir`）：改前红 `expected true to be false`（dispose 后目录仍在）；改后绿。
**fsync 合并（跨进程）不做**——按指示记 note：R31-11 工程量大（需要 per-file 合并队列/跨进程协调），收益存疑（transcript 本身不 fsync，storm 主要来自 journal/orphan 等小文件）。

## K3P-45（父席并入：unverifiable 尾 + appendOwnedSessionLine 复活 DAT-2 类粘合）

**改动**（`src/core/session-manager.ts`）：
- `repairOwnedSessionFile` 返回三态 `SessionFileRepairOutcome`：`"repaired"`（补了换行或截了 torn 尾 → 可安全 append）/ `"clean"`（无需修）/ `"unverifiable"`（K3P-4：>16MiB 无换行完整记录原样保留 → **不可 append**）。`completeTrailingRecordNewline` 内部三态不变（completed/torn/unverifiable），外层包装成 append-safety 判定。
- `appendOwnedSessionLine` → `appendOwnedSessionLineAsync`（RC-2 顺带 async 化）：unverifiable 时**拒绝 append**，抛显式错误（含原因），不粘合不撒谎。三个调用方（daemon-catalog rename/archive/mark_interrupted、in-process rename、daemon-mode rename）全部 await 化。
- in-session 写路径同覆盖：`_persist` append 分支先查 `endsWithNewlineSync`，非换行结尾先 re-repair，仍非换行 → 抛 `SessionTailUnverifiableError` 拒绝；**刻意不落 flushed=false**（避免下一轮 `_rewriteFile` 从内存重写把 K3P-4 特意保留的 17MiB 记录静默丢掉）。
**红测** `test/r31-unverifiable-tail-refuses-append.test.ts`：17MiB 完整记录 + rename append。改前红：`expected undefined to be an instance of Error`（append 无报错即粘合）。改后绿：被拒 + 文件逐字节未动（Buffer.equals）+ 无 session_info 回执。
**红证脚本复跑**：原 `/tmp/k3p45-punch.ts`（改前，PUNCH-THROUGH：2 行粘合、load 后 message 0、回执撒谎）；改后复跑 `/tmp/audit_r/round-31/punch-post.mts` → `FIXED: append refused, record preserved, no lying receipt`（file byte-identical: true）。

## 测试账

红（改前，真行为红）→ 绿（改后）：
| 文件 | 改前 | 改后 |
|---|---|---|
| r31-guard-contention | 红（无 pid 归因 + 心跳饿死） | ✓ |
| r31-event-log-append-retry | 红（still being appended，记录丢） | ✓ |
| r31-ephemeral-rlm-dir-dispose | 红（目录残留） | ✓ |
| r31-unverifiable-tail-refuses-append | 红（append 无报错即粘合） | ✓ |
| r31-worker-socket-sweep | 红（清扫面不存在） | ✓ |
回归全绿：session-lease(16)、proper-lockfile-compromise(12 含其余)、daemon-runtime-lease、k3p5-rename-under-lease(2)、r2-catalog-append-tail-repair(3)、3885-subagent-runtime-host、rlm-ledger、event-log。daemon-supervisor-process 的 process-stress 用例（180s）超单命令预算未跑，其中 acquireSessionLease 调用点已 await 化、类型级验证覆盖。

## 已知取舍 / 如实记录

1. RC-2：existing-owner liveness ps 留 guard 内（TOCTOU 安全性优先，见上）；guard contention 预算仍 1s（不改容错语义，只改阻塞方式与归因）。
2. `release()` 异步化后存在极窄窗口：跨进程 close→reopen 可能短暂看到 SessionAlreadyActiveError（自愈：reclaimable-own/死 pid 回收 + 恢复重试）；原同步 release 的调用方均为 best-effort，不等待返回。
3. RC-5 backoff 固定 500ms（大于常见活写者长尾 ~123-400ms），未做自适应；二拒即抛错由调用方处置。
4. K3P-45 in-session 拒绝路径会让该会话持续显式报错（不自动重写自愈）——这是"不粘合不撒谎"的直接代价，人工修复（补换行）后恢复。
5. changelog fragment：`packages/coding-agent/.changes/r31-guard-and-cleanup-family.md`。
