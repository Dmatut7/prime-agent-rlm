# W2 · 单实例 daemon socket 统一 — 设计节

分支 `feat/single-daemon-socket`（基线 origin/merge/repl-kernel @ c9fddc040）。
worktree：`/Users/laicai/prime-agent-w2sock`。日期：2026-09-25（夜班）。

## 1. 问题陈述（真源见 w2-socket-evidence.md）

三个症状，一个根因族：

- S1 roster 碎片：`~/.prime/agent/live-threads.json` 曾出现 2 条 vs 实际 4 会话。
- S2 多 supervisor 世代各占 socket：每个世代一个 socket 路径，各持互不相交的 worker 描述符目录。
- S3 launchd 常驻 daemon 抢不到 socket 空转重试：`launchctl print` 显示 `state = not running, runs = 1, last exit code = 0`（PID 为 '-'）。

**根因链（代码级）**：

1. `defaultDaemonSocketDir()` = `join(tmpdir(), "prime-agent-<uid>")`（daemon-socket.ts:282-284）。`tmpdir()` 读 `$TMPDIR`，macOS 上 launchd 会话 / 手动 shell / 工具注入可各不相同 ⇒ **socket 路径不稳定**。另外 macOS dirhelper 会清理 $TMPDIR（supervisor-registry 迁出 $TMPDIR 的注释原文佐证："whose files macOS dirhelper deletes after 3 days"）。
2. `defaultWorkerDescriptorDir(agentDir, socketPath)` = `agentDir/daemon-workers/<sha256(socketPath)[0:12]>`（daemon-supervisor.ts:1176-1181）。socket 路径漂移 ⇒ **描述符目录跟着漂移** ⇒ 新世代收养 0 个旧 worker ⇒ roster/live-threads 只剩新会话（正是 S1 的 2 vs 4 形状）。
3. supervisor 启动撞上活 daemon 时直接 throw（`DaemonSocketAlreadyRunningError` / `DaemonAgentDirAlreadyRunningError` / "Daemon socket already in use"）→ 进程 exit 1 → KeepAlive 每 ThrottleInterval 重启 ⇒ 空转（S3）。本机环外脚本 `pa-daemon-start.sh` 的 watch 模式正是这个洞的创可贴。

## 2. GitHub 同类调研（2026-09-25，走 gh api / raw.githubusercontent，带代理）

| 项目 | 做法 | 取/舍 |
|---|---|---|
| moby/moby `pkg/pidfile/pidfile.go` | `Write(path, pid)` 先 `Read`：记录的 pid 活着 ⇒ 拒绝启动（"process with PID %d is still running"）；死 pid 视为可覆盖 | **取概念**：pid 活性 = 不抢。我们的 ownership registry（pid+processStartId，register 落在 ~/.prime/supervisor-owners）是更强版本，已有。 |
| docker/go-connections `sockets/unix_socket.go` | `syscall.Unlink(path)` 后直接 `net.Listen` —— **盲接管**：不看 socket 是否有活进程 | **舍**：无租约下 unlink 会拆掉活 daemon 的 socket。我们的 prepareDaemonSocketPath 已是「connect 探测 + 1s 宽限 + inode 身份核对 + 租约内 unlink」，更安全，保留。 |
| ollama/ollama `app/server/server.go` + `server_unix.go` | pidFile 放在稳定 HOME 路径（~/Library/Application Support/Ollama/ollama.pid）；`cleanup()` 读 pid 活则 SIGINT、5s 不退就 kill 后接管 | **取路径稳定**；**舍 kill 前任**：我们会话里可能有活跃任务，不能学 ollama 杀前任 —— 我们降级为看护。 |
| ollama `cmd/cmd.go checkServerHeartbeat` | CLI 先 heartbeat，"connection refused" 才 startApp —— 活着就当 client | **取**：客户端优先复用。我们已有 ensureDaemonRunning / probeDaemonVersion，行为同形。 |
| Unitech/pm2 `lib/Client.js` | 固定 socket 在 `$PM2_HOME`（**不是** $TMPDIR）；`pingDaemon` 活 ⇒ `launchRPC` 当 client，死 ⇒ startDaemon | **取全部**：PM2 是本任务的最接近同构（Node 常驻 daemon + unix socket + 固定 home 路径 + ping→降级）。 |
| systemd socket activation / launchd Sockets | 守护 socket 由 init 系统持有，daemon 收 fd，无争抢 | **记为后手**：需要改用户 plist，超出本仓职责（禁碰配置），设计上写明。 |

调研过程注：moby v2 仓路径重构后 `cmd/dockerd` 已不在 master 树上，pidfile/sockets 证据取自 `pkg/pidfile/pidfile.go` 与 vendored `go-connections`（GitHub raw 直读，各 ~40 行）。

## 3. adopt vs 自研判定表

| 需求 | 现仓已有？ | 判定 | 依据 |
|---|---|---|---|
| 原子接管 stale socket | ✅ `prepareDaemonSocketPath`：租约内 connect 探测→宽限→inode 核对→unlink | **adopt** | 比 docker 的盲 unlink 安全；identity 检查防拆换替 daemon 的 socket（已有测试） |
| 单实例判定（pid 活性） | ✅ ownership registry（pid+processStartId+phase，~/.prime/supervisor-owners） | **adopt** | 比 moby pidfile 强（startId 防pid复用）；已有 DaemonAgentDirAlreadyRunningError |
| 稳定 socket 路径 | ❌ 默认在 $TMPDIR | **自研（小）** | 仿 PM2/ollama：`~/.prime/daemon/`；registry 先例（~/.prime/supervisor-owners 注释明言移出 $TMPDIR 是有意的） |
| 描述符目录随 socket 稳定 | ❌ hash(socketPath) | **自研（迁移）** | 新路径首次启动时把旧 hash 目录原子改名到新 hash 目录（agentDir 归属唯一性保证无并发争抢） |
| 旧 supervisor 活 ⇒ 新进程降级 client | ❌ 直接 throw→exit 1→launchd 空转 | **自研** | 无现成：supervisor 级降级-看护循环。环外脚本 watch 模式证明了需求，但该逻辑应在仓内 |
| roster 快照单写者 | 部分（live-threads 写者来自 fork 分支 9ff31b4ed） | **自研（gate）** | 写前校验 ownsSocketPath && 租约未失守；降级进程从未 bind ⇒ 从不写 |
| 客户端跨 $TMPDIR 发现 | ✅ `resolveDaemonSocketForAgentDir`（registry 兜底） | **adopt** | daemon-agent-endpoint.ts 已实现 |

## 4. 设计

### D1 稳定 socket 路径

`defaultDaemonSocketDir()`：Unix 上改为 `join(homedir(), ".prime", "daemon")`（win32 走命名管道，不变）。
- 0700、属主校验、mkdir 逻辑沿用 `ensureDefaultDaemonSocketDir`（改为按 socketPath 的实际 dirname 工作，因此也覆盖显式 --daemon-socket 指到默认目录的形态）。
- `legacyDaemonSocketDir()` 导出旧 $TMPDIR 路径，仅三处只读使用：①legacy supervisor-registry 目录钉死；②描述符迁移源；③测试。
- 客户端迁移：老 daemon 活在旧路径上时，`resolveDaemonSocketForAgentDir` 经 registry 兜底仍找到它（已有行为，测试钉住）。
- worker socket 同目录随迁：描述符里存绝对路径，收养不受影响；新 worker 落新目录。

### D2 接管协议（occupancy 判定 + 降级）

新增纯逻辑模块 `daemon-single-instance.ts`：
- `judgeDaemonSocketOccupancy(socketPath, deps?)` → `{kind:"absent"|"listening"|"unresponsive"}`：
  - 连接成功 ⇒ listening（**booting 的 daemon 也算活**，沿用现有 isDaemonSocketListening 语义，防误拆）；
  - 文件存在、连接失败 ⇒ unresponsive（连续 3×250ms 探测，复用 supervisor-availability 的轮次语义）；
  - 文件不存在 ⇒ absent。
- `classifySupervisorStartupFailure(error)` → `"downgrade" | "fatal"`：`DaemonSocketInUseError`（新 typed error，prepare 路径改抛它，消息不变）、`DaemonSupervisorAlreadyRunningError`、`DaemonAgentDirAlreadyRunningError` ⇒ downgrade；其余 fatal。
- `runDaemonStandby(options)` 看护循环：deps 可注入（probe/sleep/owner 读取）—— 连到活 daemon（DaemonClient 握手，日志一行降级声明），然后轮询：owner 记录的 pid 死 **且** socket 不再 listening ⇒ 以 exit(1) 退出（launchd KeepAlive 两种形态都会重启我；退出码语义沿用环外脚本的先例）。SIGTERM/SIGINT ⇒ exit(0)。
- 接线：`runDaemonSupervisorMode` 先 `judgeDaemonSocketOccupancy`（快速路径：listening ⇒ 直接降级，不进 15s 锁等待——正是 pa-daemon-start.sh 注释里 ELOCKED 空转的成因）；否则照常 start()，启动失败按 classify 处置：downgrade ⇒ standby，fatal ⇒ 原样抛出。

### D3 描述符目录迁移

supervisor start() 在 mkdir(descriptorDir) 前：若 socketPath 为新默认路径、新 hash 目录不存在/为空、legacy hash 目录存在 ⇒ `renameSync(legacy, new)`（原子）。非默认 socket 不迁移。并发安全：发生在 ownership acquire 之后，同 agentDir 第二个启动者已被拒。

### D4 roster 快照单写者

`syncLiveThreadsSnapshot`（来自 9ff31b4ed）加 gate：`ownsSocketPath && !socketLeaseCompromise && startupComplete` 才写。降级进程从未 bind、未安装写钩子 ⇒ 天然不写。租约失守（handleSocketLeaseCompromised）后停写。

### 显式拒绝的替代方案（留档）

- 杀前任接管（ollama cleanup 式）：拒绝——活跃会话可能在跑任务。
- socket fd 由 launchd 持有（socket activation）：超出仓职责，列为后手。
- descriptorDir 改按 agentDir 键控：破坏面更大（reg-1 隔离测试族），本轮只做迁移，不改键控。

## 5. 测试计划（brief 四项全覆盖）

- 接管：stale socket 文件 + 无 listener ⇒ prepare→bind 成功且旧 inode 被换（现有 daemon-socket.test 一族 + 新增）。
- 降级：judgeDaemonSocketOccupancy(listening) ⇒ runDaemonSupervisorMode 降级不 bind 不写快照（可注入 deps 单测）。
- 并发绑定：N 个并发 acquire ⇒ 恰一个 bind；其余得到 downgrade/占用（进程级 fixture 太重，用 socket+租约级并发测试）。
- 无响应判定：文件在、connect 拒绝 ⇒ unresponsive；accept 但不发 hello ⇒ 仍算 listening（防误拆 booting daemon，钉住语义）。

## 6. 交付物

commits（每小步一 commit，--no-verify，只 add 自己的文件）：
1. cherry-pick 9ff31b4ed（live-threads 写者，原作者署名保留）
2. 稳定 socket 路径 + legacy 钉死 + 测试
3. 描述符目录迁移 + 测试
4. occupancy/降级/standby + typed error + 测试
5. 快照单写者 gate + 测试
6. 证据文件 w2-socket-evidence.md
