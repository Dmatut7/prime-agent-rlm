# round-31 K3 快速复核：r30 两批（PROT 4df7e9b46 rev37 + K3P 482f19ad8）——"修 A 弄坏 B"专审

冻结：HEAD 工作区（两 commit 均已合入），测试实测 @ 当前工作区。
正控：两批全部 6 个测试文件实跑通过（daemon-protocol 31 + k3q-degrade 1 + k3p5 2 + k3p4 3 + ancestor-resilience 5 + save-overrides 3 = 45 tests, exit 0；env 已 sanitize，直接 node 调 vitest）。
去重：docs/fork/audits/decisions.jsonl 263 条全查，下述发现无重复（DAT-2 是同类既往修复，F3 是其新实例；CM-2/X-6/PROT-1 修的是 digest 覆盖类，F1 是守卫自身的反向盲区，未登记）。

---

## F1（任务①）rev37 信封切片：守卫无"非空/顺序"结构断言，3 条老切片零内容守护——digest 必动但重算仪式可把空切片永久冻结

- **命题**：切片不会"静默缩成空串而 digest 不动"——任何 marker 失效/重排都使 digest 变动、identity 测试变红（见逐字证据与实测算术）。真正的盲区在下一步：digest 红 → 按头部注释记载的例行仪式重算 `DAEMON_SCHEMA_ID` → 空切片被冻结进新常量 → 此后该族 wire 编辑全部隐身且**没有任何测试能发现**，因为 `command`/`savedSession`/`outbound` 三条切片既无 `toContain` 内容断言、也无 mutation 守护条目（其余 13 条均有）。
- **severity**: P3（需要一次"盲目重算"人为动作，但重算是该文件记载过 7 次的例行操作；一旦进入冻结态即不可自愈）
- **file:line**: packages/coding-agent/test/daemon-protocol.test.ts:68-167（`readDaemonSchemaSliceSources`），:227-238（digest join），:243-276（identity 断言——只守护 13/16 条）
- **逐字证据**:
  - 切片构造：`command: daemonProtocolSource.slice(daemonProtocolSource.indexOf("export type DaemonCommand ="), daemonProtocolSource.indexOf("type DaemonCommandName"))`（end marker 不带 `export`，注释命中即截断）。
  - identity 测试注释自证设计意图："The slice markers must be found: a silent -1 would hash an empty string and let a family fall back out of the digest unnoticed."——但该断言组只覆盖 stallEvent/stallDiagnostics/stallKernel/stallExemption/snapshotWrapper/treeAssembly/connectionTreeContract/connectionSnapshotWrapper/connectionStallContract/headlessResult/quiescenceOutcome/responseEnvelope，**无 command/savedSession/outbound**（grep `sources.command`/`sources.savedSession`/`sources.outbound` 全文仅出现在 digest join 三行）。
  - mutation 守护两组共 11 条，key ∈ {snapshotWrapper, treeAssembly, connectionTreeContract, connectionSnapshotWrapper, connectionStallContract, treeWire, responseEnvelope}——同样无三条老切片。
- **实测算术**（node -e）：`slice(-1, 40826)` = 长 0（start marker 丢失→空串）；`slice(40826, 28389)` = 长 0（end 重排到 start 之前→空串）；`slice(28389, -1)` = 长 35297（end marker 丢失→过度捕获，噪音方向安全）。当前 16 条切片实测全部非空、marker 唯一（唯一例外 `export type AgentConnectionEvent` 2 次，第二处是 `AgentConnectionEventListener` 前缀命中，位置在 start 之后，现今无害——但若真声明被删/改名，marker 静默滑到 Listener 声明，切片错位仍非空，连 digest 红都不产生…… correction: 错位会改内容→digest 动→红→可重算冻结）。
- **影响**：三条最核心切片（命令 union、savedSession、outbound 事件 union）的守护强度低于其余 13 条；一次 marker 破坏 + 例行重算 = 该类 wire 编辑永久脱管，且 F1 场景（55bae7c50 类盲区）恰好在 command/outbound 上重演无障碍。
- **打穿输入**：把 `export type DaemonSessionClosedReason =` 声明块整体移到 `export type DaemonResponse =` 之前 → responseEnvelope 切片为 "" → identity 红 → 按仪式重算常量 → 全绿；此后加 `DaemonResponse` 字段（如再来一个 probeAfterMs）→ 全部 45 测试仍绿、digest 不动、混合 daemon/client 握手通过形状失配。（机制已实测：空切片算术 + 无断言 grep；未实跑完整改码流程，confidence 见下）
- **可复现**：算术 `node -e` 见上；切片长度表（Python 复算当前工作区）：全部 >0，responseEnvelope 区间 [55153,56135)，DaemonErrorInfo 声明 @55814 确实在区间内（commit 声明"slice spans both declarations"属实，正控通过）。
- **confidence**: high（机制）/ medium（人为重算那步是流程假设）
- **修法建议**：identity 测试加结构断言——每条切片 `expect(s.length).toBeGreaterThan(0)` 且记录 start<end；三条老切片补 toContain。

## F2（任务③，主发现）K3P-4 "unverifiable 不动文件"分支 × K3P-5 盲 append = DAT-2 类新实例：>16MiB 完整记录后的第一次 rename/session_info 追加被粘合，两条记录对所有读方永久消失，零警告

- **命题**：`repairOwnedSessionFile` 对 >16MiB 无终止符尾行返回 "unverifiable" 并原样保留（K3P-4 有意设计，注释自承"a later append that glues onto the unterminated tail loses a line"）；但 `appendOwnedSessionLine`（K3P-5）拿到 lease 后**不看修复结果直接 append**——新行粘上巨行，loader 丢弃整条粘合行，rename 的 session_info 标记静默蒸发。
- **severity**: P2（触发条件罕见——单行 >16MiB 且恰好丢了终止换行——但后果是数据丢失 + 操作回执撒谎：rename 报告成功而磁盘上没有；且每条后续 appendOwnedSessionLine 都会再牺牲一行，文件永不自愈该巨行）
- **file:line**: packages/coding-agent/src/core/session-manager.ts:1292-1301（unverifiable 早退）、:1319-1336（`appendOwnedSessionLine` 修复后无条件 append）、:1058-1073（`readTrailingLine` 16MiB 上限）
- **逐字证据**: `if (outcome === "unverifiable") { … return; }` 后 `appendOwnedSessionLine` 内 `repairOwnedSessionFile(sessionPath); append(SessionManager.open(sessionPath));`——repair 是 void 返回，结果不可观测。
- **打穿输入（已实跑，红证）**：/tmp/k3p45-punch.ts——构造 session 文件 = header + 17,825,930 字节完整合法 message 记录（无尾换行）→ 调 `appendOwnedSessionLine(file, agentDir, m => m.appendSessionInfo("renamed-session"))`（lease 获取成功）→ 实测输出：`lines on disk: 2`（header + 粘合行），`loaded messages: 0 | loaded session_info: 0` → **PUNCH-THROUGH 确认**：17MiB 完整记录与 rename 标记双双从 loadEntriesFromFile 消失，磁盘上粘合行永脏（下次 repair 仍 unverifiable）。
- **影响**：DAT-2（199684aa1 修过的"撕尾行+新行粘合"类）在修复后的代码里以新路径复活；三处 lease 化 append 点（daemon worker rename、in-process rename、catalog marker）全部暴露。
- **可复现**：`cd packages/coding-agent && node_modules/.bin/tsx /tmp/k3p45-punch.ts`（tsx 在仓库根 node_modules/.bin）。
- **confidence**: high（实测红证）
- **修法建议**：`repairOwnedSessionFile` 返回三态（或 `appendOwnedSessionLine` 内联判定），unverifiable 时拒绝 append 并抛出/告警，与"无 lease 拒绝"同纪律。

## F3（任务④）K3P-2 祖先 watcher：句柄与轮询成本实测可忽略，但无跨会话去重；SEC-10 dispose 覆盖祖先组（正控通过）

- **命题**：`watchFile` 是 StatWatcher 轮询（不占 FD，unref 不卡进程退出）；每次调用新建一个 watcher、同一进程内 50 会话对同一 global 文件各建各的（无去重，global/project 为既有行为，K3P-2 把放大系数加了祖先深度 D）。D = cwd 到 git 根的目录层数（`collectProjectAncestorSettingsPaths`，无 git 根时一路走到文件系统根，settings-manager.ts:813-838）。按 interval 1s（DEFAULT_SETTINGS_WATCH_INTERVAL_MS=1000，:33）、50 会话 × (2+D=4) ≈ 300 stat/s——CPU 可忽略，无句柄耗尽风险。
- **severity**: P4
- **file:line**: settings-manager.ts:1301-1349（watchExternalSettings 祖先环）
- **正控（通过）**：SEC-10 dispose 路径 `stopWatchingExternalSettings`（:1352-1357）遍历同一个 `externalWatchers` 数组、`unwatchFile(path, listener)` 用同一 listener 引用——祖先 watcher 在 K3P-2 中被 push 进同一数组，dispose 停的是**全部**（global+project+ancestors），无泄漏。listener 的 stamp 比对走独立的 `ancestorStamps` map、不污染 `loadedStamps` 的 project 槽位（读码确认 `reloadExternalEdit("project", stamp)` 的 stamp 只进告警 identity）。settings-ancestor-scope-resilience 5 测试实跑通过（含 mid-session veto 落地场景）。
- **confidence**: high（读码 + 测试通过）；watchFile 不去重为 Node 语义常识，未 perf 实测。

## F4（任务②）K3P-1：合成 veto 与真 veto 在 telemetry 读取路径语义等价（正控通过）；两处小残留

- **正控（通过）**：consent 门 `getTelemetryEnabled`/`getAgentTracesEnabled`（settings-manager.ts:1813-1844）读的是 `this.projectSettings`——正是 `loadFromStorage` 返回的、被 `applyProjectConsentVeto`（:569-586，veto=任何来源显式 `enabled:false` 即改写 merged）烘烤过的 merged 对象。合成 veto `{telemetry:{enabled:false}, agentTraces:{enabled:false}}` 与真 veto 走同一代码点、同一读取路径，等价成立。持久化路径 field-scoped（`persistScopedSettings` :1516-1550 只写 modifiedFields/嵌套 modifiedNestedFields），合成 veto 不会借无关 save 写盘——只有用户显式改 project 级 telemetry.enabled 才会落盘（彼时即用户本意）。无泄漏。
- **F4a（P4）**：warnings 未被上游当 errors 消费——main.ts:155-170 `collectSettingsDiagnostics` 把 errors 和 warnings 都映射成 `type:"warning"` 诊断（纯展示），语义未变。但 `package-manager-cli.ts:114-123` 只 `drainErrors()` 从不 `drainWarnings()`（全仓 grep 确认 drainWarnings 生产调用点仅 main.ts:163）——`prime-agent package` 语境下祖先文件损坏从"打印警告"变成**完全静默**。
- **F4b（P4）**：`recordAncestorParseError` 的告警 identity 是 `ancestor-parse-error:${path}` 不含 stamp（:1420-1433）——修复后再次损坏不再告警；且 watcher 驱动的 reload 中祖先解析失败不置 `projectSettingsLoadError`（只有 primary 失败才置），`reloadExternalEdit`（:1365-1399）落入"reloaded into this session"成功告警分支——第二次损坏被报告为成功 reload。
- **附带确认**：broken 祖先的非 consent 设置（如 mcpServers.*.disabledTools）随该文件整体跳过而失效（fail-open 方向），但相对修复前"整个 project scope 连 primary 一起丢弃"严格更好，且有告警；consent 两键已 fail-closed。可接受权衡，备注。
- **confidence**: F4 正控 high（读码+测试）；F4a/F4b high（grep+读码，未实跑 package CLI）。

## 结论

两批修复本身方向均正确、测试全绿；新伤一处实质（F2，P2，已红证：K3P-4 的善意保留分支与 K3P-5 的盲 append 组合出 DAT-2 类数据丢失），流程性守卫缺口一处（F1，P3），小面包三处（F3/F4a/F4b，P4）。
