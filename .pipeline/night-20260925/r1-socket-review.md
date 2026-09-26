# R1 对抗审查 · PR#37 `feat/single-daemon-socket`（单实例 daemon socket 统一）

**状态：已收口**（首版 16:24 落盘，16:3x 增补 N11/N12 并修正一处未核实的推断；剩余未核项 = 文末第 4 节）

> 本报告按**最新 head `b8dcd604d`** 审。审查期间该分支被推进过一次（15:19:44 新增 commit，见下），凡引用行号的结论都指 `b8dcd604d` 的树。

- 审查人：R1 只读审查（异族 flash）；实现方 = glm（3 commit）+ 父会话收线
- 审查对象：worktree `/Users/laicai/prime-agent-w2sock`，分支 `feat/single-daemon-socket`
- **被审 head = `b8dcd604d`**（基线 `origin/merge/repl-kernel` @ `c9fddc040d`，8 commit，diff 15 文件 +1453/-52）
  - 注意：任务书说「7 commit」；审查期间该分支于 15:19:44 又多了一个 commit（`b8dcd604d` "roster snapshot single-writer gate + hermetic socket-dir override"），PR#37 的 `headRefOid` 已等于 `b8dcd604d`。**本报告按 8 commit 的最新 head 审**。
  - 分支只在 `fork`（Lansyue）上，未推 `origin`。
- 真源：分支 diff、`daemon-socket.ts` / `daemon-single-instance.ts` / `daemon-supervisor-ownership.ts` / `daemon-supervisor.ts`、测试 4+2 文件、`.pipeline/night-20260925/w2-design.md`、`w2-socket-evidence.md`（未入库，见 N8）

## 0. 我实跑的验证（可复核）

| 项 | 命令 | 结果 |
|---|---|---|
| 单元/集成 6 文件 | `npx vitest --run test/daemon-single-instance.test.ts test/daemon-socket.test.ts test/daemon-descriptor-dir-migration.test.ts test/daemon-supervisor-ownership.test.ts test/live-threads-snapshot.test.ts test/daemon-stop-convergence.test.ts` | **47 passed (6 files)**，36.6s |
| 真进程身份/降级 | `npx vitest --run test/daemon-agent-dir-identity.test.ts` | **2 passed**，17.2s（第二条日志里出现 "standing by"，进程不退、不 bind） |
| 监督者单例回归 | `npx vitest --run --no-file-parallelism test/suite/regressions/4600-supervisor-singleton.test.ts test/suite/regressions/4606-update-restart-coordinator.test.ts` | **20 passed**，69.4s |
| 类型 | `npx tsgo --noEmit` | **exit 0**（无新增错） |
| 禁碰项 | `git diff --name-only <base>..HEAD` | 15 文件，**无 `package-lock.json` / `package.json`** | 
| 格式/lint 门禁 | `npx biome check packages/coding-agent/src packages/coding-agent/test packages/coding-agent/vitest.config.ts` | **Found 5 errors / 3 warnings / 7 infos**（其中 5 errors 全落在本 PR 新增或改动的行上；基线同文件 clean）→ 见 N11 |
| CI 状态 | `gh pr checks 37` | **"no checks reported on the 'feat/single-daemon-socket' branch"**（CI 的 `pull_request` 触发只对 base `main`，本 PR base 是 `merge/repl-kernel`）→ 见 N12 |
| 实测（新发现） | 见 N1 / N2 的复现 | 复现成功 |

## 1. 结论（当前判断）

**当前判断：不通过。** 两条硬阻塞 + 两条高危设计缺口：

1. **N11（硬阻塞，机械但必须先修）**：`biome check` 在本 PR 引入的行上有 5 个 error ⇒ 本仓门禁 `npm run check` / CI `build-check` 过不去（基线同文件 clean，归因已核实）。
2. **N1（高危，打掉本 PR 头号卖点）**：活占用者已持 socket 路径租约但尚未 bind 时，新 supervisor 仍 `ELOCKED` → 未捕获异常 → exit 1；launchd `KeepAlive=true` + `ThrottleInterval=10` 下就是同一个 10 秒空转，与 S3 同形。已复现。
3. **N2**：任何 accept 的监听者都被当作「自家 daemon」而不做 hello 校验 ⇒ 真 supervisor 被永久按在 standby，且不再有任何响亮报错。
4. **N3**：在 PM 本机现状（老 daemon 占着同一 agent dir、稳定路径至今没有 `daemon.sock`）下，这个 PR 单独合入**不会**把 socket 迁到稳定路径，除非手动 restart 一次老 daemon；PR 里没有这条操作口径。

**不是「框架错」**：设计节 D1-D4 的方向、`prepareDaemonSocketPath` 的原子接管、单写者 gate、描述符幂等迁移都站得住，问题集中在「降级判据的分类表」与「占用者身份校验」两处，以及收线卫生（lint/CI/证据文件）。

- **N1 直接打掉本 PR 的头号卖点**（「治 launchd 空转」）：活占用者已拿到 socket 路径租约但尚未 bind 时，新 supervisor 仍然 `Lock file is already being held` → 未捕获异常 → exit 1；launchd `KeepAlive=true` + `ThrottleInterval=10` 下就是同一个 10 秒空转，与 S3 同形。
- **N2** 把「有人 listen」一律当作「自家 daemon 活着」而不做 hello 校验：外来/异常监听者会把真 supervisor 永久按在 standby，且不再有任何响亮报错。
- **N3** 在**真实机器上**（PM 本机现状）这个 PR 部署后不会把 socket 迁到稳定路径：老 daemon 占着 agent dir ⇒ 新进程永久 standby；PR 里没有一条「一次性迁移」的操作口径。
- N4 是本 PR 主路径的测试缺口（`listening ⇒ standby` 的接线零覆盖）。

- **N11** 分支当前**过不了本仓的门禁命令**：`npm run check` 的第一段就是 `biome check --write --error-on-warnings .`（= CI 的 `build-check` job），我实跑 `biome check` 在 PR 改动的行上拿到 **5 个 error**（基线同文件 clean）。

其余（focus ②③④⑤⑥）核完为**通过/低危**，逐条列在下面。

---

## N1【高】接管协议漏了「活租约持有者但未 bind」——standby 降级抓不到它，仍 exit 1 空转

**是什么。** `runDaemonSupervisorMode`（daemon-supervisor.ts:1431-1450）只做两件事：先 `judgeDaemonSocketOccupancy`，`listening` 才降级；否则照常 `supervisor.start()`，catch 里只把三类 typed error（`DaemonSocketInUseError` / `DaemonSupervisorAlreadyRunningError` / `DaemonAgentDirAlreadyRunningError`）当冲突降级，**其余一律 rethrow**。

`DaemonSupervisor.start()` 的第一步是 `acquireDaemonSocketPathLease`（proper-lockfile 落在 `<socketPath>.lock`）。而 `judgeDaemonSocketOccupancy` 判 `absent` 依据是**socket 文件不存在**（单实例模块第 78-80 行 `existsSync`）。占位者拿了租约、还没 `listen` 时：socket 文件不存在 ⇒ occupancy=absent ⇒ 进 start() ⇒ 抢锁失败 15s 后抛 `ELOCKED`（`Error('Lock file is already being held')`）⇒ `isDaemonSingleInstanceConflict` 返回 false ⇒ rethrow ⇒ main.ts 不接 ⇒ `triggerUncaughtException`。

**为什么这是缺陷（不是「本来就该抛」）。** 抛错本身可以辩护（租约持有者可能卡死），但在 launchd `KeepAlive=true` 下它就是**每 10 秒重启进同一个碰撞**，正是设计节 §1-S3 与本 PR 标题要治的形状；而且现在多了一条未捕获异常的堆栈，比原来更吵。也就是说：本 PR 把「bind 之后」的碰撞治好了，**「bind 之前」的同一碰撞原样留着**。

**实测证据（我本机复现，两次）。**

1) 造一个「活着的、拿了同一 socket 路径租约、但从不 listen」的持有者（`proper-lockfile` 参数与仓内 `acquireDaemonSocketPathLease` 完全一致：`realpath:false, stale:5000, update:1000, retries 600×25ms`）：

```
$ node /tmp/w2-race/holder.js /tmp/w2-race/daemon.sock      # → HELD，socket 文件不存在，daemon.sock.lock/ 存在
$ ls /tmp/w2-race/                                       # daemon.sock 不存在（!）／daemon.sock.lock 存在
$ cd /Users/laicai/prime-agent-w2sock && PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR=/tmp/w2-race/registry \
  PRIME_AGENT_CODING_AGENT_DIR=/tmp/w2-race/agent PI_CODING_AGENT_DIR=/tmp/w2-race/agent PI_OFFLINE=1 \
  node node_modules/tsx/dist/cli.mjs packages/coding-agent/src/cli.ts --mode daemon --daemon-socket /tmp/w2-race/daemon.sock --offline
Daemon supervisor startup failed: Error: Lock file is already being held
    at .../proper-lockfile/lib/lockfile.js:68:47
...
node:internal/modules/run_main:107
    triggerUncaughtException
Error: Lock file is already being held { code: 'ELOCKED', file: '/tmp/w2-race/daemon.sock' }
EXIT=1
```

即：**没有任何降级日志、没有 standby、未捕获异常、退出码 1**。

2) 真实冷启动里这段窗口客观存在：我在同一 frame 里以 50ms 轮询记录「租约目录出现」与「socket 开始 accept」两个时刻，实测 `lock@t=3.38s`、`accepting@t=3.93s` ⇒ **pre-bind 窗口 0.546s**（空载机器、`--daemon-socket` 显式路径）。也就是说：单次启动很容易被人抢先（正常启动本身就要 >15s 才 bind 时才会真正 ELOCKED）；真正的 everyday 触发面是「持有者做了 `waitForDaemonStartupFence`(≤10s) + `acquireDaemonSupervisorOwnership`(registry guard ≤5s) 之后仍未 bind」或持有者卡住 —— 这正是 S3 记录的现场（launchd 与手动 daemon 打架）。

**优缺点。**

- 优点（现状）：把「未识别错误一律抛出」保留下来，避免了「什么都降级」的掩盖式修复；fast-path 的 3×250ms 探测确实比原来的 15s 等锁便宜，且给 `listening` 场景省掉 15s 空等 —— 这部分设计是对的。
- 缺点：分类表漏了「socket 路径租约被活进程持有」这一**同样是单实例冲突**的事实，于是最容易发生的那个变体（并发启动/launchd 与手动启动互撞）落到 rethrow。

**建议（最小改法，任选其一）。**

1. 在 `isDaemonSingleInstanceConflict` 之外再加一个分类：捕获 `ELOCKED`（`(error as {code?:string}).code === 'ELOCKED'` 且 `file` 指向同一个 socketPath）⇒ 等同冲突 ⇒ 降级 standby。这样「活租约持有者」走看护循环，持有者一死 socket 一静默就 exit 1 交给 KeepAlive 重启，行为与 `listening` 分支对称。
2. 或者把 `judgeDaemonSocketOccupancy` 的 `absent` 判据扩为「socket 文件不存在 **且** 租约目录不存在」，`absent` 时才进 start()；否则先等租约（沿用 15s 预算）拿到后再 bind，拿不到就降级。
3. 兜底（可与 1 并存）：`runDaemonSupervisorMode` 里把 rethrow 改成「先记一条响亮日志、清理资源后 `process.exit(1)`」，别让 launchd 收到未捕获异常（现在这条堆栈会同时进 stderr 与 `StandardErrorPath`，噪音更大）。

**回归测试建议。** 在 `daemon-single-instance.test.ts` 里加一条真进程用例：子进程只拿租约不 listen（就像我的 holder.js），另一个进程 `--mode daemon --daemon-socket <同一路径>` ⇒ 断言「日志含 standing by、进程不退、没有 listening」。这条用例今天会红，正好钉住 N1。

---

## N2【中高】占用判定不做身份校验：任何 accept 的监听者都会把真 supervisor 永久按在 standby，且不再响亮失败

**是什么。** fast path 只问「能不能连上」：`judgeDaemonSocketOccupancy` 的 `listening` 语义被显式钉成「connect 成功即可，**哪怕对方从不发 hello**」（`daemon-single-instance.test.ts` 的用例名就是 "reports listening when a connection succeeds, even without a hello"），然后 `runDaemonSupervisorMode` **不做任何 hello/协议探测**就 `runDaemonStandby`。

**为什么是缺陷。** 改前：`prepareUnixDaemonSocketPath` 对「占着路径但连不上/不是 socket」有明确拒绝（`Daemon socket already in use` / `exists and is not a socket`），启动失败是响亮的。改后：一个**外来进程**（或一个假死/半死的自家 worker 误绑、或错误 agent dir 的 daemon）只要在 `daemon.sock` 这个路径上 accept，真 supervisor 就进 standby 循环 —— 而 standby 的退出条件是「owner pid 死 且 socket 不再 listening」；`readRecordedDaemonSocketOwners()` 对无记录的外来监听者返回空 ⇒ 它**永远不退出**，机器上就再也没有 daemon 了，且没有任何一行「启动失败」。这比原来的响亮崩溃更难发现（用户只会看到 `list` 卡住/超时）。

**优缺点。**

- 优点：「booting 的 daemon 也算活」这条保守取向本身是对的（防误拆），注释与用例都写明了理由。
- 缺点：把「保守不拆」推进成了「保守到不干活也不报错」。standby 是**看护**语义，前提是「对方是自家 daemon」；这个前提没有被验证。

**建议。** 判 `listening` 之后再花一次有界探测确认身份：复用现成的 `probeDaemonVersion(socketPath)`（`cli/daemon-launch.ts` 已在用）或 `DaemonClient.connect + waitForHello`，有界 1-2s：

- 是 prime-agent daemon（`current`/`stale`）⇒ 按现状降级 standby；
- 有界探测无法确认（连上但不说人话）⇒ **抛出**（保持改前的响亮失败），日志写清「占用者不是可识别的 prime-agent daemon」，避免永久 standby；
- 顺带能区分「错误 agent dir 的自家 daemon」（此时应该报 `DaemonAgentDirAlreadyRunningError` 那条既有清晰错误）。

---

## N3【中高】真机迁移缺口：老 daemon 守着 agent dir ⇒ 新稳定路径进程永久 standby，PR 里没有一次性迁移口径

**是什么。** 这个 PR 不杀前任（设计节明确写「舍 kill 前任」，我们接受这个取舍）。但把两端拼起来就有个真空：老 daemon 活在**旧 $TMPDIR socket**上、且**仍然拥有同一个 agent dir**；新进程在**稳定路径**起，`acquireDaemonSupervisorOwnership` 会因 agent dir 冲突抛 `DaemonAgentDirAlreadyRunningError` ⇒ 降级 standby（本 PR 新行为）⇒ **永远不会 bind 稳定路径**。

**实测证据（PM 本机此刻的现状，只读）：**

```
$ cat ~/.prime/supervisor-owners/56df25ab-....owner/owner.json
{socketPath: '/var/folders/cq/.../T/prime-agent-501/daemon.sock',   # 旧 $TMPDIR 路径
 agentDir:   '/Users/laicai/.prime/agent',                          # 与新路径进程同一 agent dir
 descriptorDir: '/Users/laicai/.prime/agent/daemon-workers/9a333ce0f2e5', phase: 'owner', pid: 47849}
$ lsof -t /var/folders/cq/.../T/prime-agent-501/daemon.sock  → 47849
$ ls ~/.prime/daemon/                → 只有 update-restart-coordinators/，没有 daemon.sock
$ launchctl print gui/501/com.laicai.prime-agent-daemon | grep -E "state|runs|last exit"
  state = not running ; runs = 1 ; last exit code = 0          # S3 症状此刻仍在
```

也就是说：这台机器上稳定路径**至今没有被任何 daemon 用过**（`~/.prime/daemon/` 里没有 `daemon.sock`），而 PR 合入后 launchd 拉起的进程会老老实实连进 standby —— 看起来「没崩、也没空转」，但 socket 其实没迁过去。这不违背设计（设计就是要看护而非抢占），**但它意味着本 PR 单独合入后不会改善 S1/S2/S3 的任何一条现状，除非有人手动 restart 老 daemon**。

**建议。** 在 PR body 或设计节补一节「部署口径」（一次性）：

```
prime-agent shutdown --force   # 让老 daemon 干净退出（它会释放 agent dir 与旧 socket）
prime-agent  # 或让 launchd 拉起：此后绑定 ~/.prime/daemon/daemon.sock
```

并明确「本 PR 只保证此后不再分裂世代，不自动迁移当前在世的那一个」。若希望自动，只能在「稳定路径无人、旧路径有人、且旧 daemon 空闲」时做一次受控交接（借鉴代码里已有的 `shutdownStaleDaemonIfNotBusy` 判据：busy 拒绝、idle 才换），但那是另一批工作，不应塞进这一批。

---

## N4【中】本 PR 主路径（`listening ⇒ runDaemonSupervisorMode 降级`）零测试覆盖

**是什么。** `grep -rn runDaemonSupervisorMode packages/coding-agent/test` = **无命中**。唯一真进程 standby 用例（`daemon-agent-dir-identity.test.ts` 第二条）走的是**另一条分支**：两个 daemon 用**不同 socket 目录**（tmpA/tmpB），第二个 daemon 自己的 socket 路径上什么都没有 ⇒ `judgeDaemonSocketOccupancy` 返回 `absent` ⇒ 进 start() ⇒ 被 agent-dir 冲突抓住 ⇒ 才降级。也就是说用例覆盖的是「catch 分支 + agent-dir 冲突」，落在 fast path（`occupancy.kind === 'listening'`）上的**一行也没有**。

**为什么这是问题。** fast path 是本 PR 的核心新增（设计 D2 第 3 条「占位时直接降级，不进 15s 锁等待」）；它也是 N1/N2 的所在处。现在两个缺陷都躲在这段无覆盖代码后面。

**建议。** 加一条真进程用例：父进程先起一个「只 listen 不 hello 的假 daemon」占住 socket 路径（或起一个真 daemon），再以 `--mode daemon --daemon-socket <同一路径>` 起第二个 ⇒ 断言「日志含 standing by、进程不退、且没有第二条 listening 记录」。这条同时钉住 N1（配 N1 的 holder 变体）与 N2（配身份校验后的行为）。

---

## N5【中】实现与设计书面口径不一致：roster 单写者 gate 少了 `startupComplete`

**设计节 D4 原文**：「gate：`ownsSocketPath && !socketLeaseCompromise && startupComplete` 才写」。
**实现**（`liveThreadsSnapshotWriteGate`，live-threads-snapshot.ts:124-136 + supervisor:2602-2613）：只有 `leaseCompromised` 与 `ownsSocketPath` 两个条件，**`startupComplete` 没有进 gate**。

**为什么值得记一笔。** 三条件里的第三条是设计对「启动中途的半成品 roster」的防线；实现里被静默丢掉，且没有任何注释说明为什么不需要。我核过时序：`ownsSocketPath=true` 在 `listen()` 之后置位，而 `loadWorkerDescriptors()` 更早 ⇒ 首次可写时 workers map 已经齐了，所以**我判断今天不会产生半成品 roster**（这也是我没把它列为高危的原因）。但「文档说 3 条、代码 2 条」正是后面审查/接盘者最容易误判的地方，且 gate 是纯函数、加一条断言几乎零成本。

**建议。** 二选一：①把 `startupComplete` 加进 gate（与设计一致，default 语气上仍然成立：standby 根本不构造 supervisor）；②改设计节 D4 为两条件，并写清「为什么 `startupComplete` 不需要」。另外补一条 gate 单测（现有 3 条只覆盖两个条件）。

**一条可执行的核验路径（我没时间跑完，留给下一手）。** 真进程下「startup 中途写快照」的唯一可能有界入口是：daemon 刚 listen、客户端立刻发 `cron_cancel` / `heartbeat_manage`，命中 `daemon-supervisor.ts:3890` / `:3960` 的早退分支（`handleCommand` 在 3306，`startupComplete = true` 在 1703）⇒ 走到 `broadcastHeartbeatsChanged` ⇒ `syncLiveThreadsSnapshot`。此时 `loadWorkerDescriptors()`（1642）已跑完 ⇒ 我预期不会写出残缺 roster；但**这正是「文档第 3 条条件」要挡的位置**，值得一条用例把它钉死（send 命令 → 断言快照内容 == 描述符全集）。

---

## N6【低】描述符迁移用的是「agentDir+默认socket哈希」，不看 `this.descriptorDir`

`migrateLegacyWorkerDescriptorDirOnDisk` 自己算 `defaultWorkerDescriptorDir(agentDir, defaultDaemonSocketPath())`，而 supervisor 实际读写的是构造函数里的 `this.descriptorDir = options.descriptorDir ?? defaultWorkerDescriptorDir(agentDir, socketPath)`（daemon-supervisor.ts:1600）。当调用方显式传了 `descriptorDir`（嵌入方/测试）且 socketPath 恰为默认路径时，迁移会去 rename 一个**跟本 supervisor 无关**的目录。生产路径（main.ts）不传 `descriptorDir`，所以是嵌入方风险，不是线上风险。

**建议。** 把迁移函数改成接受「目标描述符目录」而非自己重算（或由调用方传入），并在 `migrateLegacyWorkerDescriptorDir()` 里加一句 `if (this.descriptorDir !== <算出来的>) return;` 的守卫。

## N7【低】迁移失败的原因码与「旧目录不存在」混用

`renameSync` 抛错（EACCES/EXDEV/ENOSPC…）时返回 `reason: "no-legacy-dir"`（daemon-supervisor.ts:1252-1256），与真正「旧目录不存在」同一个词；调用方只在 `reason === "renamed"` 时打日志，所以**改名失败是完全静默的**。

**建议。** 区分 `rename-failed`（带 errno）与 `no-legacy-dir`，并在失败时打一行 warn（提权/非同盘是真实会遇到的）。

## N8【低】PR body 引用的证据文件没进分支

`w2-socket-evidence.md` 在 `git status` 里是 `??`（untracked）；`git rev-list --all` 全历史里没有任何 commit 含该文件。而它同时被 PR body（「证据索引 w2-socket-evidence.md [E1]-[E6]」）与派工书当作真源。

**建议。** 要么提交它（放在 `.pipeline/night-20260925/` 与设计节同级），要么把它从 PR body 的「证据」段改为「父会话本地收线记录（未入库）」，别让评审者去找一个不在 PR 里的文件。

## N9【低/信息】与 PR#32 的 live-threads commit 重复；`.pipeline/` 是本仓首次入库

- 本分支第一个 commit `32a9a5adc` 与 `9ff31b4ed`（属 `feat/restore-live-threads` = **PR#32**）的 `git patch-id` **完全相同**（`a9ceeca96ded5371282838311931c1eef1c831bc`），文件 blob 也相同（`live-threads-snapshot.ts` = `e336b0ea8`）。内容一致 ⇒ merge 不会冲突，但两个 PR 的说明里都要把「同一改动」讲清，避免合并时重复计数/重复评审。
- `.pipeline/` 在基线树里不存在，`git ls-tree -r feat/decision-ledger-consumption` 也查不到 —— 本 PR 是第一个把过程文档（`w2-design.md`，95 行）随代码入库的。若这是有意（夜间批次留痕），没问题；若不想让 `.pipeline/` 进主干，得在合并前决定。

## N10【信息】commit 卫生：通过（禁碰项干净）

`git diff --name-only <base>..HEAD` = 15 文件，无 `package-lock.json`、无 `package.json`、无 lock 类文件。`git status` 除 N8 的未追踪证据文件外干净。8 个 commit 的作者混用 `laicai` 与 `xiaoman`（子代理身份）——与「一代理一分支」口径无冲突，但如果本仓要求署名统一，收线时值得知道。

---

## N11【高·可直接阻塞】`biome check` 在本次改动的行上有 5 个 error（基线同文件 clean）⇒ `npm run check` / CI 的 `build-check` 过不去

**是什么。** 本仓的合并门禁是 `npm run check`，其第一步就是 `biome check --write --error-on-warnings .`；CI 在 `build-check` job 里跑同一条命令，且 `test` job `needs: build-check`。我实跑：

```
$ cd /Users/laicai/prime-agent-w2sock && npx biome check packages/coding-agent/src packages/coding-agent/test packages/coding-agent/vitest.config.ts
Checked 1234 files in 2s. No fixes applied.
Found 5 errors.  Found 3 warnings.  Found 7 infos.
  packages/coding-agent/src/core/retention/logs.ts                 1 error   assist/source/organizeImports
  packages/coding-agent/test/daemon-supervisor-ownership.test.ts   1 error   assist/source/organizeImports
  packages/coding-agent/test/daemon-single-instance.test.ts        1 error   organizeImports(+ noUnusedImports / noUnusedFunctionParameters / format)
  packages/coding-agent/src/modes/daemon/daemon-single-instance.ts          format
  packages/coding-agent/test/daemon-socket.test.ts                          7 infos, lint/complexity/useLiteralKeys
```

**归因已核实（不是既有债务）**：把基线 `c9fddc040d` 的同名文件取出来、放在仓内同相对路径下再跑 biome ⇒ `logs.ts`、`daemon-supervisor.ts`、`daemon-socket.test.ts`、`daemon-supervisor-ownership.test.ts` **全部 clean**；`daemon-single-instance.{ts,test.ts}` 是本 PR 新增文件 ⇒ **这 5 个 error 全部由本 PR 引入**。

**为什么严重。** 都是 `--write` 能修好的机械项，但 `organizeImports` 那三个是 error 级别 ⇒ `npm run check` 非零退出、`build-check` 红、`test` job 被 needs 挡下。也就是说按本仓自己的门禁，这个 PR 现在**过不去**。（另：`daemon-supervisor.ts:1570` 的 `private liveThreadsSnapshotSkippedWrites` 在**整棵树**里只有 `:1570` 声明与 `:2617` 自增两处命中（`git grep … b8dcd604d`），**没有任何读取者** —— 它是死写入，biome 报 `noUnusedPrivateClassMembers` 是对的。注释里写的「visible in telemetry」目前不成立。）

**建议。** 合并前跑一次 `npx biome check --write` 并作为独立 commit 落盘（三者都是机械修复）；再对 `liveThreadsSnapshotSkippedWrites` 二选一：要么删掉（当前无人读），要么补一个读取者/导出（否则那句注释是空头承诺）。收线后建议补跑 `npx biome check packages/coding-agent/src packages/coding-agent/test` —— `--no-verify` 提交绕掉的正是这一环。

## N12【中】本 PR 的 CI 根本没跑过

`gh pr checks 37` 返回 **"no checks reported on the 'feat/single-daemon-socket' branch"**。原因在 `.github/workflows/ci.yml` 的触发器：`pull_request: branches: [main]`，而本 PR 的 base 是 `merge/repl-kernel` ⇒ PR 事件从不触发 CI；`push` 触发只认 `main`/`merge/repl-kernel`，而该分支只存在 fork（`Lansyue`）上、从未推到 `origin`。所以 PR body 里「测试 39/39 / tsgo 0 新增错」是**本机自测**、不是 CI 背书，且 `npm run check`（含 biome）从未在这个分支上跑过 —— 这正是 N11 能带着 5 个 error 走到 PR 面前的原因。

**建议。** ①在 PR body 如实写「CI 未触发（base 非 main），证据为本机实跑」；②或者把分支推到 `origin` 的 `merge/repl-kernel` 让 `push` 触发跑一遍（注意这会触发全量 CI，`test:ci` 三分片）；③至少在合入前本地补跑 `npm run check`。凡声称「39/39 绿」的地方都应同时标注没跑 biome。

## 2. 派工书六条 focus 逐条回应（全部已核）

| # | 焦点 | 结论 |
|---|---|---|
| ① | 有无「误接管活 supervisor」路径 | **有更糟的一条**：不是误接管，而是**误判 absent**（活租约未 bind ⇒ N1），以及**不校验身份的保守降级**（N2）。真正「拆掉活 daemon socket」的路径我**没有**找到：`prepareDaemonSocketPath` 仍是「connect 探测 → 1s 宽限 → inode 身份核对 → 租约内 unlink」，且在 `if (await canConnectToUnixSocket(socketPath)) throw new DaemonSocketInUseError(socketPath)` 之后才 unlink —— 与设计节 claim 一致（我用 SIGKILL 掉的真子进程那两条用例也覆盖了）。 |
| ② | standby 会不会双写 roster | **不会**（通过）。standby 进程从不构造 `DaemonSupervisor`（`runDaemonSupervisorMode` 直接 `return new Promise(() => {})`），所以 `syncLiveThreadsSnapshot` 根本不可达；再加 `liveThreadsSnapshotWriteGate`（`!ownsSocketPath` / `leaseCompromised` 两条）挡住「socket 归属已失」的进程；`handleSocketLeaseCompromised` 也把 `shuttingDown=true` 并 `fenceSupervisorSocket()`。设计里「降级进程从未 bind ⇒ 从不写」这句成立。唯一瑕疵见 N5（少第三条 gate 条件）。 |
| ③ | 旧描述符接管幂等性 | **幂等**（通过）。两条路都封住：①迁移后旧目录已不存在 ⇒ 下次 `no-legacy-dir`（真 fs 用例断言了）；②新目录非空 ⇒ `target-not-empty`（用例断言不 rename）。迁移在 ownership acquire 之后、`mkdir(descriptorDir)` 之前，且 `renameSync` 原子 ⇒ 同 agentDir 的第二个启动者已被拒，无并发争抢。瑕疵见 N6/N7。 |
| ④ | launchd plist 未动是否真 | **真**（通过）。`com.laicai.prime-agent-daemon.plist` mtime = 2026-09-25 08:23（早于 W2 全部 commit），内容仍指向 `/Users/laicai/prime-agent-rlm/prime-agent.sh`，`KeepAlive=true` + `ThrottleInterval=10`；`com.laicai.prime-agent-threads.plist` mtime 2026-09-23。**但有一个运行态事实值得知道**：`launchctl print` 显示已加载的 program 是 `/Users/laicai/.local/bin/pa-daemon-start.sh`（与磁盘 plist 不一致 ⇒ 该 job 是从更早的 plist 加载的、没 reload）。那个包装脚本把 `SOCKDIR` **硬编码**成旧 $TMPDIR 路径，watch 分支靠 `lsof` 看旧 socket ⇒ 本 PR 之后它既看不到新 daemon、也管不到新 socket（它的 `rm -f` 只作用于已废弃的旧路径）。结论：plist 未动属实，但**环外包装脚本已经与新行为脱节**，要么更新它、要么本 PR 合入时把它从 launchd 卸下（迁移口径见 N3）。 |
| ⑤ | 测试是否覆盖 unresponsive→takeover 与 listening→standby | **一半**。unresponsive→takeover：覆盖到位（`daemon-single-instance.test.ts` 里「3 次失败探测 ⇒ unresponsive」「真 SIGKILL 掉子进程留下 socket 文件 ⇒ prepare 后文件被 unlink」两条）。listening→standby：`runDaemonStandby` 的**单元**层覆盖充分（三种等待/退出形状），但**接线**层（`runDaemonSupervisorMode` 的 fast path）零覆盖 —— 见 N4。 |
| ⑥ | commit 卫生（禁碰 package-lock） | **通过**（N10）：15 文件无 lock/package.json，工作区干净（除 N8 的未入库证据文件）。 |
| ⑦ | （我另加）门禁与 CI 是否真绿 | **不通过**：`biome check` 5 errors（N11）；`gh pr checks 37` = no checks reported（N12）。PR body 声称的「39/39 绿」是**本机自测**且不含 `npm run check`。 |

## 3. 处置建议（按可执行顺序，给父会话）

1. **先修 N11**：`npx biome check --write packages/coding-agent/src packages/coding-agent/test`，独立 commit；顺带决定 `liveThreadsSnapshotSkippedWrites` 删或接读取者。
2. **再修 N1**：把 `ELOCKED`（同一 socketPath 的租约被活进程持有）纳入 `isDaemonSingleInstanceConflict`（或让 occupancy 把「租约存在」也算有人）⇒ 走 standby 看护；配套加「holder-only、不 listen」的真进程用例（今天会红）。
3. **修 N2**：`listening` 之后再花 1-2s 做一次有界的 hello/版本探测；识别不出 prime-agent daemon ⇒ 抛错（保留改前的响亮失败），不要永久 standby。
4. **补 N4**：`listening ⇒ runDaemonSupervisorMode 降级` 的真进程用例（fast path 现在是零覆盖，N1/N2 都躲在这里）。
5. **写清 N3 的部署口径**：一句 `prime-agent shutdown --force` 然后让 launchd 拉起；并在 PR body 标注「不自动迁移在世的老 daemon」。
6. **对齐 N5**：gate 补 `startupComplete` 或改设计节 D4；顺手补 gate 单测。
7. **PR body 卫生**：补 N8（证据文件未入库）、N12（CI 未触发/本机自测口径）、N9（与 PR#32 的重复 commit）。
8. 修完再推 fork 并 `gh pr checks` 看一次（或本地 `npm run check` 全跑），别再用「39/39」单独背书。

## 4. 剩余未核项（我自己没核完，列出来给父会话按需补派）

1. **N1 的时间宽度量化**：我只测了「空载机器上 pre-bind 窗口 0.546s」与「持有者存在时必然 ELOCKED」。没有量化「多大负载下正常启动会 >15s 不 bind」（即 everyday 触发概率）。这需要带 worker 收养负载的冷启动计时（本机有 39 个描述符的 `daemon-workers/9a333ce0f2e5`，可以拿它做重载 cold start）。
2. **`adopted worker 的 socket 路径`在被收养后仍指向旧 $TMPDIR 目录**，而 `workerSocketPath()` 新 worker 落在稳定目录。`collectActiveSocketKeys` 同时列了 `tmpDir`、`tmpDir/prime-agent-<uid>` 与稳定目录 ⇒ 日志保留没问题；但 `daemon-ps`/`prime-agent stop` 对 worker socket 的枚举是否只扫 `defaultDaemonSocketDir()`，我**没来得及**核（`daemon-stop-convergence.test.ts` 把断言改成了「worker 在 defaultDaemonSocketDir 的同级」，但没覆盖「已收养的老 worker 的 socket 在旧目录」）—— 这可能是一个真实的「stop 看不到已收养老 worker」缺口，建议补核。
3. **Windows 分支**：`defaultDaemonSocketDir()` 现在先看 env override，再看 win32 分支，返回 `homedir()/.prime/daemon`；但 `defaultDaemonSocketPath()` 在 win32 上走命名管道、根本不用这个目录，`legacyDefaultDaemonSocketPath()` 在 win32 也返回管道路径 ⇒ `migrateLegacy…` 在 win32 直接 return undefined。逻辑自洽，但我**没有**在 win32 上跑过任何用例（本机无法）。
4. **CI 覆盖**：新增测试是否会被 CI 的三分片跑到、是否有 tag 过滤问题（`vitest.config.ts` 只加了 env），我没跑 `npm run test:ci` 全量（时间太长）。
5. **`runDaemonStandby` 的 `readOwners` 默认实现**只回 `{socketPath,pid}`（无 `processStartId`），pid 复用场景下靠「socket 是否仍 listening」兜底；我没有构造 pid 复用用例验证「socket 一直 listen + 记录 pid 被复用」时的行为（预期：一直等待，因为 socket 仍 accept ⇒ 不会误退，只会继续看护）。

---

*R1 只读审查（未改任何源文件，仅新建本报告），按夜间静默令直接落盘结束，不发消息。*
