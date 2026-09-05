# 本地轴清单（R3 起，2026-09-04）

这份文件记的是**本地独有实现的存活状态**：哪条轴还活、哪条休眠、谁是它的唯一读者或唯一正控、什么动作会静默弄死它。

用途：
- **下一轮上游同步前必读**。上游重构不会为本地轴报错，静默失效是常态（R3 的 4 条 merge 引入红里，3 条是「上游新测试面 × 本地 src 接缝」或「本地独有测试不参与三方合并」）。
- **审计与清理时查「谁在守这条轴」**。判据是「哪个测试会因这一行被改而变红」，**不是**「哪个测试提到这个变量名」。
- `README.md` 的「这个 fork 改了什么」表格是这份清单的用户可见摘要；两边不一致时**以代码为准**，并回来改这份文件。

行号是 R3 收口时（HEAD `bd35d1287`）的实测值，会漂；每条都同时给符号名，漂了按符号 grep。

---

## 一、休眠接缝（活着但不激活，清理时会连带死掉）

### 1. `omitStreamingMessages` 的 supervisor↔worker 半边 = 全休眠接缝

**四段链的实况**（R3 合并后逐段核过）：

| 段 | 落点 | 状态 |
| --- | --- | --- |
| 客户端发命令 | `src/modes/agents-view/agents-view-mode.ts:217-230`（`createAgentsViewListCommand(client)`，按 `list_without_streaming_messages` capability 决定发不发 `omitStreamingMessages: true`） | **活，但只剩 1 个调用点**（`:1898`，删除代理前的一次权威 liveness 检查）。原来的 4 个调用点里，agents view 的主列表路径已被上游 #1900 换成 `rosterStore.summaries()`（`:902`/`:2142`/`:2152`），**轮询本身消失了** |
| 协议面 | `src/modes/daemon/daemon-protocol.ts:162`（capability 联合）/ `:225`（已知集合）/ `:516`（`list` 支的可选字段）/ `:867`（闸号 24）/ `:1129`（兼容性判定） | 活（R3 的 rev 27 并集 wire 里保住） |
| supervisor 剥离 | `src/modes/daemon/daemon-supervisor.ts:2725`（读命令字段）+ `:2734`（`summaryWithoutStreamingMessage(row)`） | **活**（`handleList` 走 roster 遍历后仍剥离；roster 行按类型已不含该字段，这里是「万一将来又带上」的保险） |
| supervisor → worker 那一跳 | `daemon-supervisor.ts:4157`（`refreshWorkerSummaries` 第 5 个尾参 `omitStreamingMessages = false`）→ `:4165`（`const omit = omitStreamingMessages && worker.client.supports(...)`）→ `:4169`（条件命令）→ `:4174`（递归透传）；worker 侧剥离在 `src/modes/daemon/daemon-mode.ts:3899` | **休眠**：src 侧 12 处调用（`:1140/1167/1179/1238/1257/3336/3528/3940/4174/4469/4800/4921`）**没有一处传第 5 实参**，`:4174` 只是内部 retry 的原样透传 ⇒ 尾参恒 `false` ⇒ `:4165` 的 `omit` 恒 `false` ⇒ `:4169` 永远发裸 `{ type: "list" }`，`:4177-4186` 的「已持有行不许看到字段消失」保活逻辑恒走 `!omit` 分支 |

**为什么会休眠**：ours 侧原来传 `true` 的两个调用者，一个在 `handleList`（R3 取官方 roster 遍历后删掉），一个在 `scheduleWorkerSummaryRefresh`（节流轴，随官方 #1897/#1900 事件驱动模型整体删除）。定义活着、调用点没了。

**唯一读者**：`packages/coding-agent/test/daemon-supervisor-streaming-list.test.ts`（**本地独有**，`git cat-file -e upstream/main:<path>` = 不存在）。R3 的 S4 已按上游语义重写它：describe 1 用位置参形 `refreshWorkerSummaries(worker, false, false, false, true)` 撑住这条尾参，describe 2 把「`handleList` 不再转发」钉成 `expect(requests).toEqual([])`。

**清理触发条件（下一轮必读）**：任何「删无用参数 / 简化签名」的清理会**连这条本地轴一起删掉**，而且 esbuild、biome、`tsgo --noEmit` **三者都不会红**（形参有默认值、有读者、类型合法）。要删就一起删三处：尾参 `:4157` + `omit` 判定 `:4165`/`:4169` + 唯一读者测试；要留就别动签名。根代理 R3 裁定 = **(A) 保持现状**（休眠接缝 + 保活逻辑留着），理由：客户端半边仍端到端活着，且高频往返已随「每-worker list 往返」消失、官方 roster 改 delta 推送后这一跳频率本就低 ⇒ 实际影响小。

**同族但不同轴**：`daemon-agent-connection.ts:2037` 的 `request({ type: "list" }, 30000, { recoverable: false })` 是裸 list（不带 omit），走的是重连路径，不是本地轴。

## 二、按标识符名 grep 会假阴性的轴（审计方法学）

### 2. `compactionLeafId`：src 里的名字，测试里从不出现

- src 侧两点：`src/core/agent-session.ts:7988`（`const compactionLeafId = this.sessionManager.getLeafId();`）与 `:8093`（`appendCompaction(..., { leafId: compactionLeafId ?? undefined, usage })`）；接收端 `src/core/session-manager.ts:1731`（`appendCompaction(..., options?: { leafId?: string; usage?: Usage })`）。
- `grep -rln compactionLeafId test/` = **0 命中**，但这**不代表无覆盖**：测试用的是语义等价的局部名（`leafBeforeCompact` / `compactionUsage`）。
- **端到端正控实际在两条腿**：
  - **leafId 腿** = `packages/coding-agent/test/suite/agent-session-compaction-navigate.test.ts`（本地 scan2 C3，1 passed）：用 `session_before_compact` 扩展钩子在**摘要生成中**调 `navigateTree(forkTargetId)`，断言 `compactionEntry!.parentId === leafBeforeCompact` 且 `sessionManager.getLeafId() === expectedLeafAfterNavigate`。红因推演：若 `:8093` 丢掉 `leafId`，`session-manager.ts:1739` 的 `options?.leafId ?? this.leafId` 会让 parentId 变成导航后的 leaf，且 `:1757` 会把会话拖到压缩条目上 ⇒ **两条断言同时红**。
  - **usage 腿** = `packages/coding-agent/test/suite/agent-session-compaction.test.ts:168-177`（38 passed）：`compactionUsage.input/output > 0` + 3 条 own-usage 折叠等式。红因推演：若 `:8093` 丢掉 `usage`，`session-manager.ts:1751` 的 `usage: options?.usage` 变 undefined ⇒ `compactionUsage.input` 直接 TypeError。
- **四路覆盖矩阵**：① `:8093` 改回裸 `usage`（第 7 位置参）→ **tsgo** weak-type 检测拦住（`{leafId?; usage?}` 与 `Usage` 零公共属性）；② 两侧一起回退到位置参签名 → p2 的 3 条 options 哨兵（`test/compaction-branch-boundary.test.ts`）；③ 只丢 `leafId` → navigate 腿；④ 只丢 `usage` → compaction 腿。
- **方法学（本条的存在理由）**：审「某行改动有没有测试守」的正确问法是**「哪个测试会因这一行被改而变红」**，不是「哪个测试提到这个变量名」。要按**行为链**搜（谁调 `session.compact()`、谁断言 `entry.parentId`/`entry.usage`、谁在压缩中导航），或按 **src 的公开 API 名 + 被断言的字段名**搜。R3 派单曾据「按名 0 命中」判定这条链无覆盖并要求补测试，实测为假阴性 ⇒ 裁定「无缺口，不新增文件」。

## 三、已消失的本地保证（上游架构级吸收，别再按旧语义写测试或文档）

### 3. S-1：`handleList` 不再向 worker 拉取 —— 「客户端 list 必拿新鲜数据」这条保证没了

- **旧语义（本地轴）**：`handleList` 每次 `list` 都 `await Promise.all([...this.workers.values()].map(w => this.refreshWorkerSummaries(w, {...})))`，先拉后读 ⇒ 客户端要一份 list 就拿一份**当刻重扫出来的**新鲜数据。
- **现语义（上游 #1897 `8d5722ee9` + #1900 `1d2e91d3b`）**：`daemon-supervisor.ts:2718-2751` 的 `handleList` **完全不碰 worker socket**，改成遍历 `this.roster().values()`，用 `this.workers.get(entry.workerId)` 取 worker、`sessionSummaryFromRosterEntry(entry)` 生成行 ⇒ 客户端拿到的是**最后一帧 delta / 最后一次 pull 留下的 roster 快照**，新鲜度靠 `roster_update` 推送 + `scheduleRosterRepairPull` 兜。
- **处置**：认上游语义（不在 `handleList` 里补回 pull —— 那是 src 改动，且会与上游 roster 推送模型打架）。R3 的 S4 已把新行为钉成测试：`test/daemon-supervisor-streaming-list.test.ts` describe 2 断言 `expect(requests).toEqual([])`。
- **连带影响**：① `omitStreamingMessages` 的 worker 半边休眠（本文件 §一.1）；② `worker.summaries` 从 18 处被削到 5 处（`daemon-supervisor.ts:1198/2284/4177/4192/4582`，全部块外）；③ 任何用 `Object.create(DaemonSupervisor.prototype)` 造假 supervisor 的本地测试**必须 seed roster**，只 seed `worker.summaries` 会静默 0 匹配（R3 的 F73 就是这个，见 `docs/fork/audit-findings.md`）。
- **术语校正**（写文档/派单时别弄反）：`roster_delta` 是 **worker → supervisor** 的私有帧（`daemon-worker-protocol.ts:23`）；**supervisor → client** 的事件叫 `roster_update`（`daemon-protocol.ts:1303`，capability 同样 gate 在 `agent_roster`）。

## 四、免费兜底（不是唯一防线，但删了会失去一道保险）

### 4. `rlm-ledger.ts:730` 的 `this.replayCache = undefined`

- 机制：`RlmLedgerReplayCache { size, mtimeMs, edges }`（`:297`）、`private replayCache?`（`:315`）、命中判据 `cached && cached.size === size && cached.mtimeMs === stats.mtimeMs`（`:766`）、命中也走 `cloneLedgerEdges`（`:292` 定义 / `:767` 调用）、整文件读发生在 `this.eventLog.replaySync(parse)`（`:770`，`EventLog` 来自官方新 substrate `src/core/event-log.ts:73`）；生命周期另两点 = `:757`（文件不存在也清）与 `:801`（末尾回填）。
- **它是「免费兜底」**：`appendRecord` 首行清缓存的理由（src 注释原文）是「stat 分不清落在文件系统 mtime 粒度内的 append，而我们自己的写入是唯一能免费排除的情况」。但 append 必然让 `size` 变大，而 `:766` 是 `size` **与** `mtimeMs` 双条件 ⇒ **单靠 size 守卫就已能抓住本进程的 append**，`:730` 在现有实现下**没有能被黑盒观测到的独立作用**。
- **唯一观测者是白盒腿**：`packages/coding-agent/test/rlm-ledger.test.ts:150-185`（落点 `bc012cfb2`，+78/−0）里 `Reflect.get(ledger, "replayCache")` 的两条断言 —— `:166` `toBeDefined()`（暖机后缓存在场，同时证明字段名不是拼错的恒 undefined）、`:179` `toBeUndefined()`（append 之后、下次读之前已被清，**这条才是真钉 `:730` 的**）。行为腿（append 后 `edges()` 立刻看到新记录）**钉不住 `:730`**：删掉那行它照样绿。
- **两条方向性风险**：① 若将来有人把命中判据从 `(size, mtimeMs)` 弱化成只看 `mtimeMs`（比如为省一次 stat），`:730` 会**立刻从冗余变成唯一防线**，那时白盒腿是唯一的红；② 若有人「清理无用赋值」删掉 `:730`，现在**只有这条白盒腿会红**。
- **证据口径（重要，别引用错）**：「删 `:730` 后行为腿仍绿」这一半是**推理 + src 可读事实**，**没做实测负控**。R3 收口时提议过这条负控，执行车道明确拒绝在共享工作树里制造 30 秒 unstaged 的 `src/` 脏态（会让别车道的 pre-commit `biome check --write .` 与 `git status` 快照看到不属于任何车道的改动、可能被判破口），已实测的替代证据是 MUT-①（把 spy 安装点挪到暖机之前 → 红）与 MUT-②（把白盒断言挪到 append 之前 → 红，吐出真对象 `{ size: 561, …(2) }`）。要补这条实测，两个安全做法：(a) 由持门代理在树静默时用独立 scratch worktree（`git worktree add /tmp/... HEAD` + symlink `node_modules`）跑；(b) 指定 30 秒静默窗口并通知所有车道，事后贴 md5 + `git status --porcelain | wc -l` 双核。

---

## 五、本地轴总表（README 表格的工程版；R3 收口时逐条 grep 核过）

「来源」列是引入该轴的 fork 提交；「落点」是 R3 收口时（HEAD `bd35d1287`）的实测行号。

| # | 本地轴 | 来源 | 落点（符号 + 行号） | R3 后状态 |
| --- | --- | --- | --- | --- |
| 1 | 扫描前先跳过活着的（resident）子代理 | `6f6b35464` | `daemon-mode.ts:1310-1318`（`if (!includeResident && this.findSessionBySessionFile(...)) continue;` **在** `readSessionInfo` 之前，含原注释） | **活**，零冲突存活 |
| 2 | 每子代理 display 文件按 stat 缓存 | `6f6b35464` | `rlm-subagent-display.ts:99`（命中判据 `size` + `mtimeMs`）/ `:116`（`displayCache.set`） | **活**，零冲突存活 |
| 3 | CJK 宽度缓存按总字符数封顶（400 万字） | `34fe8f5d4` | `packages/tui/src/utils.ts:45`（`WIDTH_CACHE_MAX_CHARS = 4_000_000`）+ `:221/:258-264`（读写与按字符数淘汰） | **活**，零冲突存活 |
| 4 | 没变的渲染工作不重做（不重拼整份 transcript） | `3c3716595` | `packages/tui/src/tui.ts:268-275`（`this.aggregated` 复用）/ `:1541`（`composeFrame` 只切可见窗口 ⇒ 可安全复用） | **活**，零冲突存活 |
| 5 | 打字只重排当前行（wrap 结果跨帧复用 + 签名失效） | `3c3716595` | `packages/tui/src/components/editor.ts:355-364`（`syncWrapCache` 的 `wrapCacheSignature`）+ 其后的 `wrapCache` 逐行复用 | **活**，零冲突存活 |
| 6 | 活会话只重扫新增字节（增量 session 扫描） | `619144b6e` | `session-manager.ts:1085-1125`（`sessionInfoCache` 的 `resumable` 判据：同 inode + 变大 + 上次 offset 仍在文件内；否则全量重扫）+ `scanSessionInfo(filePath, stats, resume?)` | **活**；哨兵 `test/session-info-incremental-scan.test.ts`（p2 在 R3 新加，先红后绿）。官方 `scanSessionInfo` 无 resume 参数 ⇒ 官方测试面**结构上不可能覆盖**这条轴 |
| 7 | 工具参数没变就不拆/不重建面板 | `bf6989289` | `src/modes/interactive/components/tool-execution.ts:74`（`argsSignature()`）/ `:93`/`:128`/`:242-247`（比对与更新） | **活**，零冲突存活 |
| 8 | 快照每次传输单独编号（不用事件游标当身份，#1229） | `8981a31c3` | `daemon-mode.ts:1400`（`nextSnapshotId(state)`）+ 3 个调用点 `:4013`/`:6757`/`:7186`；`active-session-state.ts` 持有计数器 | **活**；回归 `test/suite/regressions/1229-snapshot-transfer-identity.test.ts` |
| 9 | RLM spawn ledger 的 replay 缓存（ledger 没变不重放） | `bf6989289` | `src/modes/daemon/rlm-ledger.ts:315`（字段）+ `:730`/`:757`/`:765-767`/`:801`（四个操作点）+ `:292`（`cloneLedgerEdges`） | **活，但已手工移植到官方 event-log substrate 外侧**：整文件读改走 `this.eventLog.replaySync(parse)`（`:770`），缓存与克隆留在本地层。见 §四.4 |
| 10 | session lease：官方 fail-closed 骨架 + 本地「自己泄漏的 lease 可回收」 | 本地 `a807f3055` + `3a450907d`；R3 手工融合 | `src/core/session-lease.ts:219`（`isReclaimableOwnLease`）+ 两个调用点 `:332`/`:341`；`:37`（`activeLeaseDirectories`）+ `:47`/`:55`；`:227`（`withLeaseGuard`）+ `:302`；`:156`（`lstart` 的 TZ/locale pin 注释） | **活**（融合：pin 与 fail-closed 取官方，`isReclaimableOwnLease` 留本地）。R3 收口计数 `isReclaimableOwnLease`/`activeLeaseDirectories`/`withLeaseGuard` = 3/5/3，与解块前一致。**碰 Windows 线（#1982/#1994）前必须先把这三条的测试拎出来当守门**（lane B 风险 R2：取 theirs 会让它们静默变死代码，且测试文件也在 PR 改动面内 ⇒ 不红灯） |
| 11 | list 命令的 `omitStreamingMessages`（协商能力后不带在途助手消息） | `8981a31c3` | 见 §一.1 的四段表 | **部分吸收**：协议面 + supervisor 剥离 + 客户端命令活（客户端只剩 1 个调用点）；supervisor↔worker 半边休眠 |
| 12 | 服务端 capability 强制 + 控制面/会话面分流（F5/F6） | `96d3db580` + `7efe4b467` + `6e86b3929` | `daemon-supervisor.ts:1825` 与 `daemon-mode.ts:3655`（`missingDeclaredCommandCapability`）；`daemon-mode.ts:3558`（`isSessionPlaneDaemonCommand` 闸）；协议面 `DAEMON_SUPERVISOR_ONLY_SERVER_CAPABILITIES` / `DAEMON_FIRST_PARTY_SESSION_CAPABILITIES` / `declare_client_capabilities` | **活**，R3 点名保住（收口计数 `declare_client_capabilities` src 13 / test 10）；永久门 `test/suite/regressions/w7-capability-control-plane.test.ts` |
| 13 | 流式正文轴 `streaming_deltas`（supervisor 转发紧凑 per-token delta） | `c72b9940f` | `daemon-supervisor.ts:5890`（声明）/ `:5914`（赋值）/ `:5960-5962`（按客户端能力选载荷）/ `:6000`（catch-up 判定）；`streamReconstructor` 的 `hasPartial`/`seed`/`clear` 在 `:4204-4208` 与 `:5199-5205`，`reconstruct`/`observe` 在 `:5906`/`:5927` | **活**（schema 25 fork 侧特征，进 rev 27 并集）。R3 的 F74 就是它与上游新测试的对撞 |
| 14 | busy 行上的「(no activity Xm)」安静时长标签（H8） | `761f33938` | `agents-view-state.ts:1026`（`getQuietDurationLabel` 定义）+ `:724`（调用点） | **活，但祖先侧那半随官方 #1967 `d72beaf9e` 消失**（`propagateHeartbeatStateToAncestors` 已删净，全仓 0 命中，不恢复调用点） |

### 5.1 R3 有意删掉的本地实现（别再找它们，也别在文档里承诺）

| 轴 | 删于 | 为什么 |
| --- | --- | --- |
| 刷新节流轴：`scheduleWorkerSummaryRefresh` / `CoalescedSummaryRefresh` / `SUMMARY_REFRESH_MIN_INTERVAL_MS` / `lastSummaryRefreshAt` | R3 merge（S3 裁定「节流轴丢、取官方」） | 上游 #1897/#1900 改 roster 事件驱动 + delta 推送，「按 token 拉全量摘要」的路径本身消失。收口实测四个符号全仓 **0 命中**（声明与用点一起删净，无孤儿） |
| `handleList` 每 worker 一次 list 往返 | R3 merge（取官方 roster 遍历） | 见 §三.3 |
| `propagateHeartbeatStateToAncestors`（祖先行 running 提升） | 官方 #1967 `d72beaf9e` | `git log -S` 双侧 + base 三方定位确认是上游有意删；官方改「心跳会话是普通会话」。收口实测 src/test 双侧 0 命中 |
| `syncAgentPeers`「名单没变不重发」 | `bf542ce7e`（R1 上游合并） | 早于 R3 就没了；README 表格里的这条过期项 R3 才删掉（全仓 grep 0 命中） |
| `truncateTornTailSync` / `readAllSync`（ledger 尾行处理） | R3 merge（S7.6） | 官方 `event-log.ts` 统一了「未终止尾行 = 未提交 append」口径。`rlm-ledger.ts` 里两个符号 0 命中；`event-log.ts` 里的同名 `readAllSync`（`:39` 定义 + `:84/:170/:171` 使用）是官方私有函数，**不是**本地那条，别混 |

### 5.2 下一轮同步的守门清单（从本清单直接推出）

1. 碰 `daemon-supervisor.ts` 的 `refreshWorkerSummaries` 签名 → 先看 §一.1，别把休眠尾参当无用参数删。
2. 碰 `session-lease.ts` 或 Windows 线 → 先把 `isReclaimableOwnLease`/`activeLeaseDirectories`/`withLeaseGuard` 的测试单独拎出来当守门（不红灯型风险）。
3. 碰 `session-manager.ts` 的 `readSessionInfo`/`scanSessionInfo` → 官方测试面结构上抓不到增量扫描，必须跑 `test/session-info-incremental-scan.test.ts`。
4. 碰 `agent-session.ts` 的 compaction 段 → 按 §二.2 的四路矩阵核，别按 `compactionLeafId` 这个名字 grep。
5. 任何用 `Object.create(DaemonSupervisor.prototype)` / `Object.create(DaemonAgentConnection.prototype)` 的假件 → 核它走的路径是否已改读 roster、是否经过 `reseedStreamReconstructor`；缺桩的表现是**误导性错误信息**（指向 selector 而不指向缺失成员）。
6. 任何会走真 `appendRotatingLog`/`getAgentLogPath` 的测试 → 必须隔离 `ENV_AGENT_DIR`（F77）。
7. 碰 `daemon-mode.ts` 的 roster/streaming 段 → **行号更正（R3 全面审查）**：客户端活点在 `src/modes/agents-view/agents-view-mode.ts:217-230`，**不是** `daemon-mode.ts:1898`（那是 cron）；本文档 §一.1 的表本来就是对的，错的是派单文本。**启用前陷阱**：`daemon-mode.ts:4184-4185` 无条件继承上轮的 `streamingMessage`，启用 `omitStreamingMessages` 前必须改成 `summary.isStreaming ? previous.get(...) : undefined`，否则 omit 期间结束的 turn 会把大对象永久钉在 roster 上。
