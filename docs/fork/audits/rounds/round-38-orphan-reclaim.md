# r38 审计线⑤ — 崩溃残留子代理进程 / 孤儿 journal 的回收路径（只审计不修）

- 仓库：`/Users/a1/Desktop/ai/prime-agent`（全程只读：未写仓、未 build/dev/test、未 kill 任何进程、未删任何文件）
- 真机：`~/.prime/agent`（只读枚举，未删）
- 心跳：`/tmp/audit_r/round-38/hb-orphan.md`；本文件：`/tmp/audit_r/round-38/orphan-reclaim.md`
- 日期：2026-09-16；探针脚本（我自己写在 /tmp，不在仓内）：`/tmp/audit_r/round-38/probe-orphan.ts`、`xowner-write.mts`、`xowner-read.mts`

---

## 0. 回收器清单（谁在什么时机回收什么，逐字代码位置）

| # | 回收器 | 时机 | 过滤条件（关键） | 位置 |
|---|---|---|---|---|
| R1 | owned-session-worker 前端 | 其 worker 子进程死/退出时 | `readActiveOrphanProcesses(path, workerPid)`（按 ownerPid） | `cli/owned-session-worker.ts:289-307` |
| R2 | 内核退出时 host 侧 | `reapKernelOrphanProcesses(kernelPid)` | `orphan.kernelPid !== kernelPid …continue` | `core/kernel/repl-manager.ts:2531` + `core/orphan-process-journal.ts:645-670`（过滤在 657） |
| R3 | daemon supervisor 的 worker 恢复 | 仅在 `recoverUncertainWorkerOperations()` 内 | `readActiveOrphanProcesses(path, worker.descriptor.pid)` | `modes/daemon/daemon-supervisor.ts:5445-5510`（读在 5496） |
| R3 入口 | 同上 | 只有 4 处调用 R3 | — | `daemon-supervisor.ts:3966`（reclaimStaleWorkerRegistration）、`4955`（pre-roster 重启）、`5350`、`5361`（recoverWorker） |
| R4 | supervisor 删 descriptor | 任意 `deleteWorkerDescriptor()` | **只 `rmSync` 文件，不 reap** | `daemon-supervisor.ts:2202-2211`；调用点 `1628 / 3970 / 4827 / 8146 / 9023`（只有 3970 之前先跑了 R3） |
| R5 | 磁盘保留 sweep（retention） | 每 60min（真机 `history.jsonl` 证明在跑） | **没有任何 class 覆盖 `*.orphans.jsonl`** | `core/retention/*`：`grep -rn "orphans\|daemon-workers" core/retention` 只命中一句注释 → 见 §4 N3 |

另外两个"看着像回收但不是"的东西：
- `daemon-supervisor.ts:2129-2168 reclaimStaleSnapshotCacheGenerations()` 只回收**快照缓存代际目录**，不管 orphan journal。
- `daemon-supervisor.ts:1097-1180 sweepStaleWorkerSockets()`（R31-5）只扫 `worker-*.sock`，**不扫同目录的 `*.orphans.jsonl`**（这是"缺一个姊妹清扫器"的直接对照）。

---

## 1. 真机取证：残留物枚举与计数（全部只读）

### 1.1 孤儿 journal 与 descriptor（`~/.prime/agent/daemon-workers/`）

```
$ ls ~/.prime/agent/daemon-workers/*
daemon-workers/12f042ee5718/58f06141c995.json              (descriptor, pid 86687, lifecycle ready)
daemon-workers/12f042ee5718/58f06141c995.orphans.jsonl     282743 B -> 现在 300KB+，仍在长
daemon-workers/12f042ee5718/58f06141c995.recovery.jsonl   1182403 B
daemon-workers/12f042ee5718/afc409710709.json              (descriptor, pid 85717, lifecycle ready)
daemon-workers/12f042ee5718/afc409710709.orphans.jsonl     293762 B -> 1996 行（审计中）
daemon-workers/12f042ee5718/afc409710709.recovery.jsonl    865870 B
daemon-workers/12f042ee5718/command-journal.jsonl          330255 B
daemon-workers/12f042ee5718/snapshot-cache/f7d40c33-.../  1 个代际目录
daemon-workers/3c5cc3a049ae|ef70525c6fc1|f069c5d86664/     只有 supervisor-config / command-journal.jsonl，无 descriptor、无 orphans
```
计数：descriptor 2 个、orphans journal 2 个（均为"有主"状态）、orphan journal 里 **1795 行 / 1895+ 行**。

进程存在性（`ps -axo pid,ppid,etime,%cpu,rss,command`）：两个 descriptor 的 pid **都活着**（86687、85717，etime 10:46、10:45），其 journal 里"最新 active"记录中的活 pid 也**确实是它们的子进程**（例：`86782 86687 … kernel-venv-f224a5179de7/bin/python -P -m rlm.repl`、`32554 86782 … /bin/bash -c exec 9>&0 …`）。
→ **这一半是健康的正控**：journal 的 active 记录与真实存活的子进程一致，说明 enumeration 方法能认出"活着的残留"（不是只会报 0）。

### 1.2 逐 journal 的 owner 分布（关键疑点）

对两个 journal 各取"每个 `(ownerPid,pid)` 的最新一条记录"，过滤 `active=true`：

| journal（descriptor 的 pid） | 最新 active 对 | ownerPid == descriptor pid | ownerPid != descriptor pid | 其中 pid 仍存活 |
|---|---|---|---|---|
| `58f06141c995.orphans.jsonl`（owner 86687） | 48 | 48 | **0** | 21（活 worker 的子进程） |
| `afc409710709.orphans.jsonl`（owner 85717） | 135 | 75 | **60（20 个外部 writer）** | 19（活 worker 的子进程） |

外部 writer 直方图（`ownerPid: active 对数`）：
`71461:11, 65544:10, 65744:10, 71092:5, 71598:5, 70149:2, 70188:2, 70342:2, 77655:2, 9241:1, 23674:1, 36283:1, 53173:1, 60780:1, 73191:1, 86556:1, 3650:1, 46287:1, 69917:1, 69963:1`

样例逐字记录（同文件）：
```
{"version": 1, "pid": 21884, "ownerPid": 9241,   "processStartId": "ps:Tue Sep 15 15:02:01 2026", "active": true, "recordedAt": "2026-09-15T15:02:01.091Z"}
{"version": 1, "pid": 65547, "ownerPid": 65544,  "processStartId": "ps:Tue Sep 15 15:12:32 2026", "active": true, "recordedAt": "2026-09-15T15:12:32.823Z"}
```
这 60 对里 **0 个带 `kernelPid`**，格式是 host 侧 shell.ts 的紧凑 JSON（对比：内核 Python 写的是 `{"version": 1, …+00:00}` 且必带 `kernelPid`，见 `prime-agent-runtime/src/rlm/bash.py:1000-1009`）。也就是说：**这些记录是 Node host 进程写的**，writer 的 `process.pid` 被当作 ownerPid（`utils/shell.ts:273 recordOrphanProcessState(pid, true)` → `orphan-process-journal.ts:91 ownerPid: process.pid`）。

### 1.3 继承通道（为什么会有外部 writer）= 活证据

活的 RL 内核进程 1529（worker 85717 的子进程）的环境：

```
$ ps -p 1529 -wwE | tr ' ' '\n' | grep -i 'ORPHAN|SESSION_LEASE'
PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL=/Users/a1/.prime/agent/daemon-workers/12f042ee5718/afc409710709.orphans.jsonl
PRIME_AGENT_INTERNAL_SESSION_LEASES=1
PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID=32f1710235ac
```
即：**该 env 会沿着"worker → 内核/host 子进程 → 会话里起的 bash → bash 里再起的 prime-agent"一路继承**，而清理它的地方只有 4 处 spawn：`cli/daemon-launch.ts:482`、`modes/daemon/daemon-mode.ts:962`、`cli/daemon-update-restart.ts:535`、`modes/daemon/daemon-supervisor.ts:9557`（都是"部署 daemon/worker"的 spawn），**会话里以客户端/宿主身份起来的进程不会被清理**（`grep -rn ORPHAN_PROCESS_JOURNAL_ENV src` 的全部命中即为证据）。

### 1.4 session-leases（42 目录 / 15.5 KB）

- 42 个 `<sha256>.lock/owner.json`（审计开头一度为 43，随会话进出浮动），**0 个缺 owner.json、0 个非 `.lock` 命名、0 个缺 `processStartId`**。
- `~/.prime/agent/retention/last-sweep.json`（真机，01:06:40）：`stale-leases scanned 39 / reclaimed 0 / skipped 39`，skip 原因 `in-use:pid 21` + `young 18`；11 次 sweep 累计 reclaim 0（`retention/history.jsonl`）。

### 1.5 其它形态（本机当前为 0，附正控）

| 形态 | 本机计数 | 说明 |
|---|---|---|
| `sessions/**/*.tmp` | 0 | 与已知背景（decisions.jsonl:244）重复，不展开 |
| `~/.prime/agent` 下任意 `*.tmp` | 0 | 正控见 §4 N2 |
| 无 descriptor 的 `*.orphans.jsonl` | 0 | 正控见 §4 N1 |
| `daemon-workers/**/*.corrupt-*` | 0 | — |
| `$TMPDIR/prime-agent-owned-*.json(.orphans.jsonl)` | 0 | 见 F7 |
| `logs/daemon.sock.*.log` | 1332 个 / 1.15 MB | 归 logs class（真机 11 次 sweep 只 reclaim 2 个） |

---

## 2. 发现

### F1 — 非 owner 进程写进 worker journal 的记录，任何回收器都看不见（跨 owner 污染）

- **命题**：`readActiveOrphanProcesses(path, ownerPid)`（R1/R3 都要传 ownerPid）与 `reapKernelOrphanProcesses`（按 kernelPid）都是**所有者过滤**读；于是"会话里起来的宿主进程"把自己的 bash 子进程写进了外层 worker 的 journal（ownerPid=自己的 pid），这些记录**没有 owner 匹配、也没有 kernelPid**，因此 supervisor、内核、owned-worker 前端三类回收器全部跳过；而 `deleteWorkerDescriptor()` 会**整文件删除** journal，把它一并抹掉。等于**存在一个"记了但永不被回收"的类别**。
- **severity**：medium（结构性、可复现；形成"永久不被回收"需要该 writer 先死、其 bash 子进程还活着——本机 60 对记录目前恰好都已死，所以危害尚未落地）
- **file:line**：
  - `core/orphan-process-journal.ts:549-590`（读），过滤在 `:571  if (isJournalRecord(record) && record.ownerPid === ownerPid) {`
  - `core/orphan-process-journal.ts:657  if (orphan.kernelPid !== kernelPid || orphan.pid === kernelPid) {`
  - `modes/daemon/daemon-supervisor.ts:5496  const orphans = readActiveOrphanProcesses(orphanProcessJournalPath, worker.descriptor.pid);`
  - `cli/owned-session-worker.ts:300   for (const orphan of readActiveOrphanProcesses(orphanProcessJournalPath, workerPid)) {`
  - `core/turn-liveness.ts:345`（连降级读也只数 `record.kernelPid === kernelPid`）
  - `modes/daemon/daemon-supervisor.ts:2202-2211`（删文件不 reap）
  - 写入侧：`utils/shell.ts:273`、`core/orphan-process-journal.ts:91`
- **逐字证据（用真代码跑真 journal）**：
  ```
  $ cd /Users/a1/Desktop/ai/prime-agent && ./node_modules/.bin/tsx /tmp/audit_r/round-38/probe-orphan.ts
  REAL owner=85717 active count: 76
  REAL foreign-writer pids visible to the owner-filtered reader: 0
  ```
  （我手工解析同一文件得到 60 对非 owner 的 active；真函数返回 0 个 → 过滤生效）
  端到端受控复现（真实模块、全部在 /tmp，无 kill、进程自杀式退出）：
  ```
  $ PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL=/tmp/audit_r/round-38/xowner.orphans.jsonl \
      ./node_modules/.bin/tsx /tmp/audit_r/round-38/xowner-write.mts
  {"writer":42228,"child":42230,"path":"/tmp/audit_r/round-38/xowner.orphans.jsonl"}
  $ cat /tmp/audit_r/round-38/xowner.orphans.jsonl
  {"version":1,"pid":42230,"ownerPid":42228,"active":true,"recordedAt":"2026-09-16T01:37:36.461Z"}
  $ ./node_modules/.bin/tsx /tmp/audit_r/round-38/xowner-read.mts
  child 42230 alive: true writer 42228 alive: false
  read as writer-owner 42228: [{"pid":42230,"recordedAt":"2026-09-16T01:37:36.461Z"}]
  read as journal-owner 999: []          <-- 回收器拿到的是这一支
  ```
  （子进程是 `sh -c "sleep 20"`，20s 内自行退出，未造成残留）
- **影响**：writer 死（SIGKILL/OOM/终端关闭）而它的 bash 子进程还活着时，这些子进程**没有任何回收路径**：writer 自己已死、外层 worker 的 supervisor 按 owner 过滤看不到、内核按 kernelPid 过滤看不到、retention 没有 journal class；随后 `deleteWorkerDescriptor`/`clearOrphanProcessJournal`（如 `daemon-supervisor.ts:5506`、`cli/owned-session-worker.ts:306,467`）把文件整个删掉，连"证据"都没了。此外这些记录也污染 journal 的 compaction 语义（`rewriteCompactedJournal` 只保留 active，但 readActive 只认 owner）。
- **可复现输入**：见上面的两条命令（或直接 `tsx -e` 调 `readActiveOrphanProcesses("<journal>", <descriptor pid>)` 与手工 parse 对比）。
- **confidence**：high（代码过滤逐字 + 真函数输出 + 60 对真记录 + 活进程 env 证明继承通道）。

### F2 — failed-worker reaper 删 journal 前不 reap（与 reclaimStaleWorkerRegistration 的单一清理路径不对称）

- **命题**：descriptor 落 `failed` 且进程确认死亡后，reaper 走 `archiveAndReapFailedWorker` → `deleteWorkerDescriptor`：**归档日志 + 删 descriptor + 删 recovery journal + 删 orphan journal**，全程**不调用** `recoverUncertainWorkerOperations`。对照之下，同类删除点 `reclaimStaleWorkerRegistration` 是**先 reap 再删**（3966 → 3970）。可达路径中最明确的一条：`recoverWorker()` 在 `ownerClientId && !launchEnv && !isProcessAlive(pid)` 时直接 `lifecycle = "failed"` 并 `return`（5278-5285），**跳过** 5350/5361 的 reap。
- **severity**：medium-high（默认开启：`settings-manager.ts:73 DEFAULT_FAILED_WORKER_REAP_HOURS = 24`、`:271 failedWorkerReapEnabled 默认 true`；一旦命中，被 SIGKILL 的 worker 的存活 bash 子进程永久泄漏）
- **file:line**：
  - `daemon-supervisor.ts:4719-4760 reapFailedWorkersOnce()`（守卫里没有 orphan reap）
  - `daemon-supervisor.ts:4809-4831 archiveAndReapFailedWorker()` → `:4827 this.deleteWorkerDescriptor(worker);`
  - `daemon-supervisor.ts:2202-2211 deleteWorkerDescriptor()`（`rmSync(worker.descriptor.orphanProcessJournalPath, { force: true })`）
  - 对照：`daemon-supervisor.ts:3965-3971`（`await this.recoverUncertainWorkerOperations(worker); … this.deleteWorkerDescriptor(worker);`）
  - 可达：`daemon-supervisor.ts:5278-5285`
- **逐字证据**：
  ```ts
  // 4825-4827
  		this.workers.delete(descriptor.workerId);
  		this.flipWorkerRosterEntriesInactive(worker);
  		this.deleteWorkerDescriptor(worker);
  // 2202-2208
  	private deleteWorkerDescriptor(worker: { descriptorPath: string; descriptor: DaemonWorkerDescriptor }): void {
  		try {
  			rmSync(worker.descriptorPath, { force: true });
  			rmSync(worker.descriptor.recoveryJournalPath, { force: true });
  			if (worker.descriptor.orphanProcessJournalPath) {
  				rmSync(worker.descriptor.orphanProcessJournalPath, { force: true });
  			}
  // 5278-5285
  		if (worker.descriptor.ownerClientId && !worker.launchEnv && !isProcessAlive(worker.descriptor.pid)) {
  			worker.descriptor.lifecycle = "failed";
  			…
  			this.tryPersistWorker(worker, "recovery waiting for owner");
  			return;
  ```
- **影响**：命中后（a）存活的 bash 子进程永久泄漏；（b）journal 被删 → 事后无据可查。另外 `quarantineWorkerDescriptor()`（`:2191-2200`）把 `*.json` 改名成 `*.json.corrupt-<uuid>` 时**不会连带处置** `*.orphans.jsonl`，被隔离的 descriptor 其 journal 也就此变成"无主文件"（并入 F3）。
- **可复现输入**：单测/沙箱——建一个 `daemon-workers/<gen>/<id>.json`（lifecycle failed、pid 指向一个已死 pid、`lastFailureAt` 早于 24h、`ownerClientId` 有值、orphan journal 里留一条 active 记录），起 supervisor，等 reaper 跑完 → 观察 journal 被删且 pid 未被 kill。（我未在真机执行：需写仓/真机副作用，超出只读范围）
- **confidence**：high（代码路径逐字）；"真机当前是否有活体"未知（本机 0 例）。

### F3 — `*.orphans.jsonl` 没有任何"按年龄/无主"的清扫器（sockets 有，journals 没有）

- **命题**：R31-5 给 worker socket 补了 `sweepStaleWorkerSockets`（descriptor 指向 + pid 死 + 年龄门），但同目录、同成因的 `*.orphans.jsonl` 没有对应清扫：一旦 descriptor 先被删/被隔离而 journal 留下（`deleteWorkerDescriptor` 两步 `rmSync` 之间被 SIGKILL；`quarantineWorkerDescriptor` 改名；手工/异常删 descriptor），该文件**再无任何读者**，永久驻留（本机两个 journal 单文件已 ~300 KB / 1.1 MB）。
- **severity**：medium（磁盘与"证据残留"；不导致活进程泄漏，因为无主 journal 本来也没人会去读）
- **file:line**：`daemon-supervisor.ts:1097-1180 sweepStaleWorkerSockets`（只匹配 `worker-*.sock`）；`:2202-2211`；`:2191-2200`；retention 无 class（`grep -rn "orphans" core/retention` 仅命中 `artifact-dirs.ts:13` 注释）
- **逐字证据（真机 + 正控）**：
  ```
  real daemon-workers unowned journals/corrupt: []
  CONTROL dir: ['/tmp/audit_r/round-38/dw-control/aaa.orphans.jsonl']
  ```
  （同一个扫描函数：真机 0 命中；把我自建的 `aaa.orphans.jsonl` 放进对照目录立刻命中 → 方法能检出该形态）
- **影响**：磁盘单调增长 + 事故后取证链断裂。
- **confidence**：high（缺清扫器是负结论，带正控）。

### F4 — lease 的候选/退场临时目录名不匹配 sweep 正则，SIGKILL 后永久驻留

- **命题**：`stale-leases` class 只认 `/^[0-9a-f]{64}\.lock$/` 的目录；而租约的临时目录名是 `<hash>.lock.candidate-<pid>-<uuid>` 与 `<hash>.lock.stale-<pid>-<uuid>`（`session-lease.ts:613`、`:541`），**都不匹配**，因此绝不在 `scanned`/`skipped`/`reclaimed` 里出现；`acquire` 的 `finally` 与 `reclaimStaleLease` 的 `rmSync` 是唯一清理点，SIGKILL 落在中间即永久残留（一次 candidate 目录内含 `owner.json`）。
- **severity**：medium
- **file:line**：`core/retention/leases.ts:20,28`；`core/session-lease.ts:613`（candidate）、`:541`（stale）、`:232-243`（`withLeaseGuardAsync` 后的 reclaim）
- **逐字证据**：
  ```
  leases.ts:20  const LEASE_DIRECTORY_NAME = /^[0-9a-f]{64}\.lock$/;
  leases.ts:28  const candidates = entries.filter((entry) => entry.isDirectory() && LEASE_DIRECTORY_NAME.test(entry.name));
  session-lease.ts:613  const candidateDirectory = `${directory}.candidate-${process.pid}-${token}`;
  session-lease.ts:541  const stalePath = `${directory}.stale-${process.pid}-${randomUUID()}`;
  ```
  真机：`session-leases/` 43→42 个条目**全部**以 `.lock` 结尾、0 个 candidate/stale（即当前 0 例，属负结论）；正则判定为纯字符串匹配，可直接复算（`re.match(r'^[0-9a-f]{64}\.lock$', '<hash>.lock.candidate-1-2')` 为 None）。
- **影响**：`candidate-*` 残留会一直占用 `session-leases/`，且 `withLeaseGuardAsync` 的 guard 是 `${directory}.guard`，互不干扰 → 不会误伤，但永久占盘、且被后来的取证者当作"租约"误读（它们不在 sweep 报告里，等于隐身）。
- **confidence**：high（命名 + 正则逐字；本机 0 例，故只主张"类别存在"）。

### F5 — 活进程持有的租约（含泄漏的）在 sweep 眼里永远是 `in-use:pid`，只能等该进程死

- **命题**：`classifyLeaseDirectory` 的 `isReclaimableOwnLease` 要求 `owner.pid === process.pid && owner.activeSessionId === env[SESSION_LEASE_OWNER_ID_ENV] && !activeLeaseDirectories.has(dir)`；retention 是在 **daemon supervisor 进程**里跑的，它既不是 owner、其 `activeLeaseDirectories` 也永远不含 worker 的租约 → 对一个**活着但已不再持有该会话**的 worker 留下的租约，verdict 恒为 `live`（`owner alive`），sweep 恒 skip。而 `SessionLease.release()` 是 fire-and-forget 的 best-effort（释放失败仅留日志），worker 又是长命进程（本机两个 worker etime 10:45–10:46）。
- **severity**：low-medium（有界泄漏：worker 死亡后 verdict 才变 `reclaimable`；不是"永不"，而"在 worker 生命周期内不可回收"）
- **file:line**：`core/session-lease.ts:190-196,386-407`；`core/retention/leases.ts:44-52`；`core/session-lease.ts:73-88`（release 尽力而为）
- **逐字证据（真机 sweep 报告）**：
  ```
  stale-leases scanned 39 reclaimed 0 disabled False skipped 39
  Counter({'in-use': 21, 'young': 18})
  {'path': '/Users/a1/.prime/agent/session-leases/00d814bd…53.lock', 'reason': 'in-use:pid', 'detail': 'owner alive'}
  ```
  11 次 sweep 累计 `stale-leases` reclaim = 0；现存 42 个租约中 24 个 owner pid 仍活着（owner 全部带 `processStartId`，不是 pid-only 情形）。
- **影响**：worker 侧的租约泄漏在一个会话里不可见、不可回收；对"会话被永久标记为 already-active"的影响取决于 owner 是否同一 pid（同一 worker 可自回收，见 `isReclaimableOwnLease`）。
- **confidence**：medium-high（代码 + 真机 sweep 数值）。**诚实标注**：从外部无法证明这 21 条里哪些是"真泄漏"，故只报机制，不报具体泄漏实例。

### F6 — pid-only 租约 owner 会永久锁死会话（macOS 上取决于一次 `ps` 是否成功）

- **命题**：`isLeaseOwnerAlive` 对无 `processStartId` 的记录**只看 `kill(pid,0)`**：`if (!owner.processStartId) return true;`。macOS/BSD 的 `getProcProcessStartId` 永远返回 undefined，start id 来自 `ps`；若 acquire 时那次 `ps` 失败，记录落盘就不带 `processStartId`（`JSON.stringify` 丢 undefined）→ 该 pid 之后被**复用**给任何活进程，租约就永久 `live`：sweep 永不回收（`in-use:pid`），acquire 侧也 `throw new SessionAlreadyActiveError`（fail-closed），会话无法再打开。
- **severity**：low（需要 acquire 时 ps 失败 + 后续 pid 复用）
- **file:line**：`core/session-lease.ts:410-419`（`isLeaseOwnerAlive`）、`:389-407`（classify 的 `live`）、`:127-131`（可写但可缺的字段）、`:222-232`（acquire 侧拒绝）
- **逐字证据**：
  ```
  session-lease.ts:414  if (!owner.processStartId) {
  session-lease.ts:415      return true;      // 只看 kill(0)
  ```
  真机：42 个 owner **全部**带 `processStartId`（0 例命中）→ 本机不构成实例，只报类别。
- **confidence**：medium（纯代码推理，正控为"字段缺失即走该分支"）。

### F7 — 无 sweep 家族的几类原子写/桥接残留（TMPDIR 侧）

- **命题**：`owned-session-worker` 的记录是 `${tmpdir()}/prime-agent-owned-<pid>-<uuid>.json` + 同名 `.orphans.jsonl`（`cli/owned-session-worker.ts:205-206`），清理只在 `finally` 与 worker 死亡回调里（`:289-307`、`:460-468`）；`recoveryDescriptorPath` 由前端**不覆盖**（会把 `ORPHAN_PROCESS_JOURNAL_ENV` 覆盖给子进程，但自身 `process.env` 仍是被继承的外层值，见 1.3）。前端被 SIGKILL → 两个文件留在 TMPDIR，而 retention 的 tmp 家族只认**目录**且前缀 `prime-agent-`（`core/retention/tmp-dirs.ts:36-56`，且 `tmp-other-dirs` 真机 `disabled: true`）、`crash-leftovers` 只清 `.retention-trash-*`（`core/retention/trash.ts:17-56`）→ 无 class 覆盖该文件形态。同族还有 `daemon-supervisor.ts:4185` 的 `${descriptorPath}.${process.pid}.tmp`（loadWorkerDescriptors 只收 `.json` 结尾，非 `.json` 名字的临时件不会被任何加载器/清扫器处理）。
- **severity**：low
- **逐字证据（真机 + 正控）**：
  ```
  $ ls $TMPDIR | grep -c 'prime-agent-owned'   -> 0
  ```
  正控：我自建的 `.tmp`/`aaa.orphans.jsonl` 在对照目录被同一扫描函数命中（§F3 输出）。
- **confidence**：medium（命名与清扫器逐字；本机 0 例）。

---

## 3. "永不被回收"的类别汇总（本报告新增，去重后）

| 类别 | 谁会回收 | 判定 |
|---|---|---|
| 非 owner 写进 worker journal 的活跃记录（F1） | 无（三类回收器都按 owner/kernelPid 过滤；文件最终被整删） | **结构性永不回收**（真机 60 对记录实例） |
| failed worker 被 reaper 收尸时 journal 里的活子进程（F2） | 无（该路径不 reap；可选旁路 5350/5361 只覆盖另一条路径） | **结构性永不回收**（需命中 owner-client+死进程组合） |
| 无 descriptor 的 `*.orphans.jsonl`（F3） | 无 | **永不回收**（无读者、无扫器；本机 0 例 + 正控） |
| `<hash>.lock.candidate-*` / `*.stale-*`（F4） | 无（正则不匹配） | **永不回收**（SIGKILL 窗口内产生；本机 0 例） |
| `$TMPDIR/prime-agent-owned-*.json(.orphans.jsonl)`、`*.json.<pid>.tmp`（F7） | 无 | **永不回收**（本机 0 例） |
| worker 存活期内泄漏的租约（F5） | worker 死亡后由 stale-leases 回收 | 有界不可回收（真机 21 条 in-use 跳过） |
| pid-only 租约 owner（F6） | 无（pid 复用即永久 live） | 条件性永不回收（本机 0 例） |

已记录、不重复：decisions.jsonl:165（converge 把外部死亡记成 stopped）、:244（SIGKILL 于会话原子写中途 ⇒ `sessions/*.tmp` 泄漏，journal 家族有启动清扫而 sessions 没有）。

---

## 4. 负结论与正控（方法可信度）

- **N1** "本机不存在无 descriptor 的 orphan journal" → 正控：`CONTROL dir: ['/tmp/audit_r/round-38/dw-control/aaa.orphans.jsonl']`（同一函数在对照目录命中）。
- **N2** "本机 `~/.prime/agent` 下无 `*.tmp` 残留" → 正控：同一 `os.walk` 过滤在对照目录（我自建 `.tmp`）命中；扫描覆盖 `~/.prime/agent` 全树（含 `sessions/`、`session-leases/`、`daemon-workers/`）。
- **N3** "retention 没有覆盖 orphan journal 的 class" → `grep -rn "orphans\|daemon-workers" packages/coding-agent/src/core/retention` 唯一命中是 `artifact-dirs.ts:13` 的一句注释；11 个 class 名与 `last-sweep.json` 的 `classes[*].class` 一一对应（`kernel-snapshot-generations / artifact-residue-dirs / artifact-empty-dirs / child-transcripts / logs / tmp-rlm-dirs / tmp-other-dirs / bash-temp-files / stale-leases / kernel-venv-generations / crash-leftovers`），无 journal/tmp-file 类别 → 属"扫描范围内未见"，且已枚举全部 class 名单。
- **N4** "本机 lease 全带 processStartId/owner.json" → 42/42，枚举即全量（`ls | wc -l` = 42 = 读到的 owner 数）。
- **观测方法能认出活残留的正控**：§1.1 中 journal 里 21/19 个活 pid 与其 `ps` 行（`86782 86687 … rlm.repl`、`32554 86782 … /bin/bash -c exec 9>&0 …`）完全一致；`probe-orphan.ts` 的 `CTL reader-as-owner-111 / -222` 显示同一 pid 在 owner 匹配时被正确读出。

---

## 5. 复现命令（全部只读，≤60s）

```bash
# 1) 枚举残留
ls -la ~/.prime/agent/daemon-workers/*/ ; ls ~/.prime/agent/session-leases | wc -l
# 2) 进程存在性（不 kill）
ps -axo pid,ppid,etime,%cpu,rss,command | grep -E 'rlm.repl|prime-agent' | head
# 3) 真代码读真 journal（证明 owner 过滤）
cd /Users/a1/Desktop/ai/prime-agent && ./node_modules/.bin/tsx /tmp/audit_r/round-38/probe-orphan.ts
# 4) 端到端受控（writer 自杀、子进程 20s 自退，无 kill 无删库外文件）
PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL=/tmp/audit_r/round-38/xowner.orphans.jsonl \
  ./node_modules/.bin/tsx /tmp/audit_r/round-38/xowner-write.mts
./node_modules/.bin/tsx /tmp/audit_r/round-38/xowner-read.mts
# 5) 保留 sweep 覆盖面
python3 -c "import json;d=json.load(open('/Users/a1/.prime/agent/retention/last-sweep.json'));print([(c['class'],c['scanned'],c['reclaimed'],c['disabled']) for c in d['classes']])"
```

## 6. 未验证/需要写权限才能验证的项

- F2 的"真机命中一次"需要构造 failed descriptor + 起 supervisor（写仓外/真机副作用），本轮未执行 → 只主张代码路径。
- F1/F5/F6/F7 的"危害已落地"实例：本机当前 0 例（记录/进程/文件都已消失或从未产生），只主张机制 + 类别存在；F1 有 60 对真记录作为"类别存在"的硬证据。
