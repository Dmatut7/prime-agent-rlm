# R1 处置表 · PR#37 feat/single-daemon-socket（r1-socket-disposition.md）

处置人：夜修 agent（W2 唯一写手）。基线：origin/merge/repl-kernel = c9fddc0404。
审查报告：`r1-socket-review.md`（R1，结论不通过/有条件）。本文件逐条记录 N1–N12 + 父会话追加两条（PR#32 follow-up）的处置，每完成一条即更新。

## 门禁读数（滚动更新）

| 检查 | 基线 | 当前 |
|---|---|---|
| `npx tsgo --noEmit` | 0 错 | **0 错**（收尾复跑，HEAD=收尾 commit） |
| `npx biome check`（12 个本分支触碰 .ts） | — | **clean（0 error / 0 warning）**（收尾复跑） |
| daemon 测试 | 49/49（派工书基线） | **78/78 全绿**：daemon-single-instance 19 + daemon-socket 12 + ownership 12 + real-process standby 3 + live-threads 8 + descriptor-migration 5 + agent-dir-identity/stop-convergence/mode-supervisor-probe 19 |

## 处置表

### N11【高·CI 阻塞】biome 5 errors — ✅ 已修 @ 2653263a3
- logs.ts：import 排序（`defaultDaemonSocketDir` 移到 `normalizeSocketPath` 之前，biome organizeImports safe fix 同款）。
- daemon-single-instance.ts：两处 formatter 差异（长条件折行、长 log 折行）。
- test/daemon-single-instance.test.ts：删未用 import（`DaemonSocketPathLease`、`defaultDaemonSocketPath`）、未用参数 `socket`→省略、import 重排 + formatter。
- test/daemon-supervisor-ownership.test.ts：import 排序。
- test/daemon-socket.test.ts：`process.env["…"]` → `process.env.…`（useLiteralKeys，info 级，一并修净）。
- `liveThreadsSnapshotSkippedWrites`（noUnusedPrivateClassMembers warning）：不删，改为接进 degraded 日志行（"N write(s) skipped so far"），注释承诺的 "visible in telemetry" 现在为真。
- 复核：13 个 PR 触碰 .ts 文件 `npx biome check` 全 clean；tsgo 0 错。没有用 `--write` 一把梭后不复核（仅对 test 文件跑过一次 --write，随后全量 check 复核通过）。

### N1【高】ELOCKED（活租约持有者未 bind）→ 未捕获异常 → standby ✅ 已修 @ 03c5cdb0c
- `isDaemonSingleInstanceConflict(error, socketPath?)` 新增可选第二参：识别 `code === "ELOCKED" && normalizeSocketPath(file) === normalizeSocketPath(socketPath)`（不 wrap typed error，保持审查人复现的消息形状；`file` 比对防把无关锁的 ELOCKED 误读为本 socket 冲突；无 socketPath 时 ELOCKED 仍判冲突——本代码路径的 ELOCKED 只来自本租约）。
- `runDaemonSupervisorMode` catch 传入 socketPath；注释与 `* 2.` 文档同步。
- 单测：ELOCKED 同路径 ⇒ true；无上下文 ⇒ true；异路径 ⇒ false；无 ELOCKED code ⇒ false。
- 未走「occupancy 预检快路径」（保留 start() 的 600×25ms 租约等待）：合法 booting 持有者可能在等待期内释放/绑定，stale lock 会被 proper-lockfile 按 stale=5000 抢走——15s 是既有语义，N1 只修「分类错导致 crash」这一层。

### N2【高】listening ⇒ 降级前无身份验证 ✅ 已修 @ a2ff789ee
- `probeDaemonSocketOccupantIdentity(socketPath, opts)`（daemon-single-instance.ts，经 `./daemon-client.js`，无循环依赖；不走 cli/daemon-launch 避免反向依赖）：连接 DaemonClient 并有界等 `daemon_hello`（默认 2s）。四态：`daemon`（可识别 hello）/`booting`（已 accept 未问候——真 daemon accept 先于 startup 完成）/`absent`（connect 未落地）/`unrecognized`（连上说的是废话）。
- `runDaemonSupervisorMode` listening 分支加有界身份梯子 `waitForRecognizedDaemonOccupant`（3 rung × 2s hello + 1s 间隔）：任一 rung 识别为 daemon ⇒ standby；`unrecognized` 或全梯子仍未问候 ⇒ **响亮失败**（`occupied by a listener that is not a recognizable Prime Agent daemon; refusing to stand by…`，exit 1），保住 pre-W2 的响亮失败语义，不掩盖。
- 依据：hello 门在 supervisor ready 而非 worker adoption（实测 accept→hello 很快，boot 预算 3×2s 足够宽）。
- 单测 6 个（openClient 可注入 seam：daemon/absent/booting/not-connected/garbage/…）。

### N4【中】真实进程级 fast-path 测试 ✅ 已补 @ 961e798e1
- 新文件 `test/daemon-supervisor-mode-standby.test.ts`（复用 daemon-agent-dir-identity 的 spawn 挂具：tsx CLI、env 钉死 registry/agent dir、afterEach 杀+reap）：
  1. **fast path**：真 daemon A listening（真 hello）⇒ 第二个 supervisor 日志 "standing by"、进程存活、socket 仍由 A 应答；
  2. **N1 ELOCKED**：子进程用 acquireDaemonSocketPathLease 同参数（stale:5000,update:1000,retries 600×25ms）只持锁不 listen ⇒ 新 daemon 15s 后 standby 而非 crash（实测 16.9s）；
  3. **N2 foreign listener**：假 server 只 accept 不说 hello ⇒ 非零退出+拒绝消息，且从未 "standing by"。
- 实测：3 passed (27.6s)。开发中真抓到一个 bug：默认 openClient 只构造 DaemonClient 未 connect()，fast-path 用例把 hello 永远等成 unrecognized——修为 `await client.connect(timeoutMs)` 后才恢复三绿。

### N5【中】gate 缺 startupComplete 条件（与设计文档 D4 不符）✅ 已修 @ 0d25f49b1
- `liveThreadsSnapshotWriteGate` 新增 `startupComplete: boolean` 输入与新 reason `"startup-incomplete"`；supervisor 调用点传现成字段 `this.startupComplete`（:1530 声明、:1750 置 true，即 ready fence 同源）。
- 语义：booting supervisor 在 ownership/listen 之后、adoption 扫描完成之前就 ownsSocketPath，此时写快照=把「2 线程 vs 4 真会话」的碎片写盘——正是 gate 要防的形状。
- 测试：3 个既有 gate 用例补 `startupComplete: true`；新增 mid-startup 拒绝用例（8 passed）。

### 父会话追加·PR#32 port×2（与 gate 同函数体）✅ 已移植 @ 08edd3289
- **990ca1504（shutdown 强制刷新 writtenAt）**：`syncLiveThreadsSnapshot(reason, force = false)`；`writeLiveThreadsSnapshotIfChanged(..., force ? undefined : this.liveThreadsSignature, ...)`；shutdown 调用点（:10516）传 `true`。原注释逐字保留。机制测试落 module 层（live-threads-snapshot.test.ts：previousSignature undefined ⇒ 同集合也重写并刷新 writtenAt）——force 参数本身在 supervisor 私有方法内、由真实 shutdown 路径触达。
- **70840e224（rootId 对称兜底）**：`merged`/`rosterSummary` 提前计算，`rootId = worker.descriptor.rootSessionId ?? merged?.sessionId` 与 name/cwd 同源于 merged record，原注释逐字保留。该逻辑纯 supervisor 内部（roster+worker-map 接线），无直接单测挂具，已在处置表留痕。
- 为什么手移植而非 cherry-pick：同一函数体已含 W2 gate，两写手分别改必然冲突且易静默丢一个修复（父会话指定本会话为 w2sock 唯一写手）。

### N6【低】migrateLegacyWorkerDescriptorDirOnDisk 不认 caller 自定 descriptorDir ✅ 已修 @ 86f62f2ae
- 函数加可选 `descriptorDir` 参数：传入值 ≠ 计算默认值 ⇒ 返回新 reason `"custom-descriptor-dir"` 跳过迁移（否则会把 legacy 树改名进 caller 从不读的目录）。supervisor 侧传 `this.descriptorDir`（constructor :1647 的 `options.descriptorDir ?? defaultWorkerDescriptorDir(...)`）。
- 测试：custom-dir 拒绝 + 传回默认值不误伤。

### N7【低】renameSync 抛错被伪装成 no-legacy-dir、完全静默 ✅ 已修 @ 86f62f2ae
- rename catch 返回新 reason `"rename-failed"` + 可选 `renameErrorCode`（errno code，EACCES/EXDEV/ENOSPC 可辨）；supervisor 侧对 rename-failure 打 `logDegraded("legacy-descriptor-dir-rename-failed", …)`（含 errno 与「adoption 退回当前代」后果）。
- 测试：注入抛 `{code: "EXDEV"}` 的 rename ⇒ reason/renameErrorCode 断言 + legacy 目录仍在。

### N3【中】部署/迁移口径含 reboot 需求未落文档 ✅ 已写 @（本 commit）
- `w2-design.md` 新增「5b. 部署/迁移口径」：① `prime-agent shutdown --force`（裸 shutdown 不够）② 本机需 reboot 一次（已加载 launchd job 持旧 plist/pa-daemon-start.sh 硬编码旧 SOCKDIR）③ 首启自动 legacy 描述符迁移、失败降级不阻塞 ④ 验证清单。PR body 已编辑成功（`gh pr edit 37 --body-file pr-body.md`，含 disposition/部署口径摘要，落盘于同目录 pr-body.md）。

### N9【低】分支底 32a9a5adc 与 PR#32 重复提交 — ✅ 信息项（不处置）
- cherry-pick 语义下重复是预期形状（w2 派工书第 1 步明示「cherry-pick 9ff31b4ed，原作者署名保留」）；集成时 git 自会按 patch-id 去重或由父会话 rebase 收口。不改动。

### N12【低】门禁读数要求 — ✅ 见文件头「门禁读数」表（最终读数在收尾 commit 更新）

### N8【中】w2-socket-evidence.md 未入库 — ✅ 随本 commit 入库（.pipeline/night-20260925/ 全套：证据、设计、审查报告、本处置表）

## 自评（收尾）

- **可合并判定：通过（自评）**。必修项 N1/N2/N4/N5/N6/N7/N11 全部代码级修复 + 测试；N3/N8/N9/N12 文档/入库/信息项处置完毕；父会话追加的 PR#32 两条 port（08edd3289）逐字保留原注释并落测试。
- 修复过程中真抓到并修掉一个自引 bug（N4 用例暴露：默认 openClient 未 connect()）——审查要求的真实进程用例确实有防御价值。
- 未做且已留痕：`pa-daemon-start.sh` watch 模式下线（范围外）。PR body 已编辑成功（gh 凭据实测有效）。
- commit 顺序（12 个）：…b8dcd604d → 2653263a3(N11) → 03c5cdb0c(N1) → a2ff789ee(N2) → 961e798e1(N4) → 08edd3289(PR#32×2) → 0d25f49b1(N5) → 86f62f2ae(N6+N7) → 本收尾 commit（N3/N8/N12 文档+处置表）。
