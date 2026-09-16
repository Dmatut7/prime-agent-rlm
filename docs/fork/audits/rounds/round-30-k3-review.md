# round-30 K3 复核：r29 两批修复（SEC-7..10 @867de634d / DAT-1..4 @199684aa1）——"修 A 弄坏 B"专查

审查基线：HEAD=ebfa8e094（含两提交）；仓库只读，零写入。与 decisions.jsonl（249 条）去重：SEC-7..10/DAT-1..4 原始条目均为 status=fixed，本报告全部是**对修复本身的复核结论**，无重复。
正控总览：两批新增测试 9 文件 26 例全绿（dat1 测试实际在 `test/session-manager/` 而非提交统计里省略号掩盖的 `test/suite/`，已单独跑过）；另自写 6 个探针脚本（/tmp/audit_r/round-30/*.ts）逐一验证。

---

## F1【新｜P2】SEC-8×SEC-7 交互：祖先文件坏掉 ⇒ 子目录会话整个 project scope 被拖死（连自己完好的文件也丢）

- **命题**：SEC-8 让 project scope 读取 cwd→git root 沿途所有 `.prime/agent/settings.json`；其中任何一个解析失败/不可读，`loadFromStorage` 整体抛错，`tryLoadFromStorage` 返回 `{settings:{}, error}`——**会话自己目录下那份完好的 project settings 一并丢弃**，且 SEC-7 fail-closed 把 consent 闸全部关掉。
- **file:line**：packages/coding-agent/src/core/settings-manager.ts:1056-1075（祖先循环，`JSON.parse(raw)` 抛出即整 scope 失败）；:1039 `tryLoadFromStorage` 返回 `settings: {}`。
- **逐字证据**（settings-manager.ts:1056-1061 注释自证设计意图，但丢弃 primary 是副作用）：
  ```
  const ancestorPaths = storage.projectAncestorSettingsFilePaths?.() ?? [];
  ...
  ancestors.push(SettingsManager.migrateSettings(JSON.parse(raw)));   // 抛错 → primary 已解析但被一起丢
  ```
- **打穿输入**（sec8-probe.ts，实测）：repo root 放 `{ broken json`，子目录 a/b/c 放完好的 `{"model":"own-model","telemetry":{"enabled":true}}`：
  ```
  case1 broken-ancestor: projectSettings = {} telemetry = false
  ```
  即 `getProjectSettings()` 为空（own-model 丢失）、telemetry 闸关闭。SEC-8 之前祖先文件根本不被读，子目录会话不受根目录坏文件影响——**这是修复引入的新爆炸半径**。
- **影响**：monorepo 根上一份写坏的 settings.json（手改事故、合并冲突残留）会使该 repo 内所有子目录新会话丢失全部 project 级配置（模型默认、工具开关）并静默关闭 telemetry/traces。
- **可复现**：`npx tsx /tmp/audit_r/round-30/sec8-probe.ts` case1。
- **confidence**：高（实测复现）。
- **修法方向**：祖先文件解析失败应降级为"该祖先不参与合并 + recordError + consent fail-closed"，而不是连坐会话自己的 primary 文件。

## F2【新｜P3】SEC-8 修复不完整：祖先 veto 不是 live 的——运行中添加的仓库级 veto 被静默跳过（原命题的一半还在）

- **命题**：watcher 只 watch 两个路径（global + 会话 cwd 的 project 文件），祖先文件不在其列；运行中的会话在根目录新增/修改 veto 文件不会触发任何 reload，veto 要到下次无关 reload 或重启才生效。原始 SEC-8 条目标题是"veto 被静默跳过"——该静默窗口仍然存在于"会话运行中"这个时间维度。
- **file:line**：settings-manager.ts:1259-1286 `watchExternalSettings`（仅 `settingsFilePath("global"/"project")`）；:1279 `watchFile(path, ...)`。
- **打穿输入**（sec8-watch-probe.ts，实测）：
  ```
  before edit, agentTraces: true
  after ancestor veto edit + 1.2s watch window, agentTraces: true   ← veto 未生效
  warnings about the edit: 0                                        ← 且无任何提示
  after global edit: telemetry = false (watcher fired), agentTraces now: false  ← 正控：被 watched 的文件一改就 reload，顺带拾起祖先 veto
  ```
- **影响**：用户以为"在仓库根写 veto 即可制止正在运行的会话上传 traces"，实际不生效。
- **confidence**：高（实测复现，含正控）。
- **修法方向**：watcher 扩到 `projectAncestorSettingsFilePaths()` 列表，或在警告中明示祖先 veto 仅启动时生效。

## F3【新｜P3】SEC-9 修了一半：save()/saveProjectSettings() 同样把 runtimeOverrides 从 merged 视图丢掉

- **命题**：SEC-9 只补了 `reload()` 的 merged 重算（:1210 三层 deepMerge 含 runtimeOverrides），但 `save()` 与 `saveProjectSettings()` 开头仍是两层合并——任何一次 settings 保存（如 `/model` 落盘、setDefaultProvider）都把 CLI/SDK 运行时覆盖从 merged 视图静默回滚，直到下次 applyOverrides/reload。
- **file:line**：settings-manager.ts:1465 `private save()` 内 `this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);`；:1488 `saveProjectSettings` 同句。对照 :1208-1212（reload 已修）。
- **打穿输入**（sec9-probe.ts，实测）：
  ```
  after applyOverrides: override-model
  after unrelated save(): undefined        ← setDefaultProvider 触发 save()，覆盖被丢
  after reload(): override-model           ← 正控：reload 路径（SEC-9 修过的）表现正确
  ```
- **影响**：与 SEC-9 原始条目同型（CLI flag/SDK override 在视图里消失），触发面从"外部手改"换成"任意一次保存"，更常见。
- **confidence**：高（实测复现，含正控）。
- **修法方向**：抽一个 `recomputeMerged()`（三层合并）供 reload/save/saveProjectSettings 共用。

## F4【新｜P3】DAT-1 "任意整记录"名不副实：>64KiB 单行记录丢尾换行仍被 ftruncate 删掉

- **命题**：`completeTrailingRecordNewline` 只读文件尾部 `min(size, 64KiB)` 窗口；JSONL 记录行内无裸 0x0a，故尾行 >65535 字节时窗口内找不到前导换行，`JSON.parse` 截断前缀必失败 → 返回 false → 落入 `repairTruncatedTrailingLine` 把这条**完好**记录整条截掉。提交信息"any whole trailing record"与 DAT-1 条目"完整记录 survives repair"对 >64KiB 记录不成立。
- **file:line**：session-manager.ts:88 `SESSION_HEADER_SCAN_MAX_BYTES = 64 * 1024`；:976-1004 `completeTrailingRecordNewline`（窗口读 + lastIndexOf）；utils/file-lines.ts:247 `repairTruncatedTrailingLine`（向后分块无上限扫描 → 必然找到上一换行 → ftruncate）。
- **打穿输入**（dat1-probe.ts，实测）：header + 一条 204,913 字节的完好 user message 记录、无尾换行：
  ```
  entry line bytes: 204913
  file bytes after repair: 144        ← 只剩 header；整条 200KB 记录被截掉
  entry survived: false
  ```
  正控（dat1-probe2.ts）：10,353 字节记录 → `entry survived: true`（补回换行）。边界 = 尾行 ≤65535 可救。
- **影响**：session 里大单行记录并不罕见——大工具结果、base64 图片消息轻松超过 64KiB；崩溃恰好只撕掉这类记录的换行符时，修复流程反而把整条记录销毁（修复前 loader 只是跳过它，数据还在盘上）。
- **confidence**：高（实测复现，含正控与边界）。
- **修法方向**：窗口未命中时向后扩窗（repairTruncatedTrailingLine 已有无上限后扫先例），或对超长尾行只读其开头判断 `{"type":` 前缀+尾部 `}` 配平。

## F5【新｜P4】DAT-2 两个 rename 修复点在无跨进程租约的情况下 repair+append，与同仓 catalog 先例的租约纪律相悖

- **命题**：daemon worker 的 `rename_saved_session` else 分支与 in-process `renameSavedSession` 对"非本会话"的任意已存文件直接 `repairOwnedSessionFile` + 追加，不持该文件的 session lease；而同仓 daemon-catalog-process.ts 明确写着"Repair only under the lease: ... truncating a live writer's in-flight append corrupts it"并强制持约。修复新增的 repair 比修复前的裸 append 危险一级：ftruncate 会截掉另一个活进程正在写的大记录中段（多 syscall write）。
- **file:line**：daemon-mode.ts:4301-4302；in-process-agent-connection.ts:616-617；对照先例 daemon-catalog-process.ts:161-173（acquireSessionLease 失败即拒绝）。
- **逐字证据**（catalog 先例，daemon-catalog-process.ts:170-172）：
  ```
  // Repair only under the lease: the torn tail belongs to whoever was
  // writing, and truncating a live writer's in-flight append corrupts it.
  ```
- **打穿输入**（分析+窗口构造）：进程 A 对 X.jsonl 进行 >PIPE_BUF 的大 append（writeFileSync 内部多 write）；进程 B 此时 rename_saved_session X → B 的 repair 看到 A 的半成品尾行，若半成品恰好解析为合法 entry（或被截断），A 的后续 write 落在 B 截断/补换行之后 → 记录损坏。窗口极小但真实存在；DAT-2 之前 B 只是裸 append（至多粘行），现在会 ftruncate。
- **confidence**：中（竞窗未实测打穿，机制与仓内自身文档互证）。
- **修法方向**：两处 rename 路径照 catalog 先例取租约（取不到则跳过 repair 仅 append，或拒绝）。

## F6【信息｜P4】DAT-4 fsync 语义与 writePrivateFileAtomic 家族一致——整个家族都缺 rename 后的目录 fsync

- **命题**：新叶子 `writeUpdateRestartManifestFile` 走 `writePrivateFileAtomic`（temp+fsync 文件+rename，0600），settings/model-registry 的新内联写法同款。**家族内一致**；但全家（private-files.ts:304 `writePrivateFileAtomic`、:335 Lines 变体、两处新内联）都不在 rename 后 fsync 父目录——掉电可丢 rename dentry 本身（文件内容完好但目录项回滚）。DAT-4 承诺的"temp+fsync+rename"已兑现，目录 fsync 是家族级残余缺口，非本次回归。
- **附带验证（正面）**：被删掉的 `mkdirSync(dirname(path), {recursive:true})` 由 `ensureParentDirectory→ensurePrivateDirectory` 覆盖且加固（0700、拒绝 symlink 终组件）；代价是 symlink 化的 `daemon-update-restarts` 目录现在抛错而非跟随——属有意加固。manifest 唯一写方是 daemon-mode.ts:6517（supervisor/package-manager-cli 只读/只删），DAT-4 覆盖完整（负结论正控：`grep getDaemonUpdateRestartManifestPath` 全部 7 处调用点逐一读过）。

---

## 复核后判定为非问题的项（各带验证）

- **SEC-7 修好后有无残留 closed 态**：无。`reload()` 成功即 `this.globalSettingsLoadError = null`（:1183-1190），闸门每次现读 error 而非锁存。实测（sec7-probe.ts）：`t0 true → t1 broken false → t2 fixed true`，无残留。
- **SEC-7 reloadExternalEdit 警告刷屏**：不成立。失败 load 也走 `captureSettingsStamps()`（:1220），静止的坏文件不会每个轮询滴答重触发；警告 identity 带 stamp（`external-edit-parse-error:scope:stamp`），同一 stamp 去重。每次**新**编辑产生一条警告——与修复前成功路径 `external-edit:scope:stamp` 同节奏，非新增向量。`recordError` 无去重但 errors 有消费者 drain（drainErrors），属既有设计。
- **SEC-8 性能**：实测（sec8-perf.ts，depth-12）：create ≈0.155ms/次、reload ≈0.056ms/次；每个 project load 每层目录多一次 open(2)（缺失即 ENOENT）。可忽略。无 git 目录时走文件系统根，层数同理。
- **SEC-8 显式 false veto 误触发**：不成立。veto 键精确限于 `agentTraces.enabled`/`telemetry.enabled === false`（:559-562）；实测（sec8-probe.ts case2）：祖先文件写 `lsp.enabled:false` + `markdown.enabled:false` 不触发 veto（telemetry 仍 true）。legacy 布尔 `telemetry:false` 经 migrateSettings 归一为 `{enabled:false}` 而触发 veto——语义上本就是显式 opt-out，属预期。
- **SEC-10 dispose/reload 竞窗**：良性。watchFile listener 同步执行，`unwatchFile` 后至多补发一次已排队的回调，post-dispose 的 reload 只读写已孤岛化的 manager；`ownsSettingsManager` 守门正确（传进来的 manager 不被停）。`isWatchingExternalSettings`（:1287）实现无误用面，但**生产零调用者**（仅测试用）——新增公共 API 目前只为测试服务，记一笔。
- **DAT-1 写放大**：可忽略。补换行仅在打开点（resume/fork/import/rename）且尾行为完整记录时发生，一次 appendPrivateFile（open+write+close，无 fsync），不随会话活跃度增长。
- **DAT-3 清扫**：60s 账龄 + mtime 判定；被 SIGSTOP >60s 的活写者 temp 可能被扫，但写者恢复后 rename 会以 ENOENT **响亮失败**而非静默损坏；模式 `.*.tmp` 虽宽于 `writePrivateFileAtomic` 命名族，sessions 目录为私有目录，误伤面小。
- **DAT-2 覆盖面对账**：`SessionManager.open(` 全部 13 个调用点逐一核对——写侧打开点（resume/fork×2/import/rename×2/catalog/main）均已 repair 或持约；export-html、agents-view 为只读打开，不需要。

## 汇总

| # | 严重度 | 一句话 |
|---|--------|--------|
| F1 | P2 | 祖先坏文件连坐会话自己完好的 project scope + consent 全关（SEC-8×SEC-7 新爆炸半径，实测） |
| F2 | P3 | 祖先 veto 不被 watch，运行中添加的仓库级 veto 静默不生效（实测） |
| F3 | P3 | SEC-9 只修了 reload()，save()/saveProjectSettings() 同样丢 runtimeOverrides（实测） |
| F4 | P3 | DAT-1 对 >64KiB 单行记录仍整条 ftruncate（实测，含边界与正控） |
| F5 | P4 | 两处 rename repair+append 无租约，与仓内 catalog 租约先例相悖（机制互证） |
| F6 | P4 | 目录 fsync 家族级缺失（一致，非回归）；mkdir 删除已被 ensurePrivateDirectory 覆盖 |
