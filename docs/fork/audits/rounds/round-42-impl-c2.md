# r42 簇C PR-C2 实施报告（ledger 梯子 / ADC-2 候选 2A+2B）

**结论一句话**：方案书 ⑥ PR-C2 全条落地并通过验收护栏——写侧「投影检界 → 守卫下等价压实 → 类型化终极拒新」梯子、读者对齐（界 + v 闸）、sweep 侧独立压实类、settings 回滚杆、daemon 类型化透传全部实现；`npm run check` EXIT=0，新增测试 10/10 绿，相关既有套件 160/160 绿，纯净树 `tsgo --noEmit` EXIT=0。**commit `4e5f1cbf7`**（分支 `r42/c2-ledger-ladder`，基线 `a5456df68`，工作树 `/tmp/audit_r/round-42/wt-c2`）。主仓零写入。

---

## 1. 红测证据

证据文件：`/tmp/audit_r/round-42/c2-red.txt`（对未改动代码跑 `test/rlm-ledger-compaction.test.ts` 的完整输出，EXIT=1）。实际输出摘录：

```
 ❯ test/rlm-ledger-compaction.test.ts (5 tests | 4 failed) 892ms
   ❯ rlm ledger reader alignment (retention scan) (3)
     × reports scanned:false for a ledger file over the byte bound 686ms
     × reports scanned:false for a ledger file over the record bound 64ms
     × does not consume a v:2 record as a deletion 1ms
   ❯ rlm ledger append ladder (2)
     × compacts an over-bound ledger instead of failing the append closed 139ms
     ✓ keeps reading a ledger the retention scan refuses to scan 1ms

 FAIL ... > reports scanned:false for a ledger file over the byte bound
AssertionError: expected true to be false // Object.is equality
 ❯ test/rlm-ledger-compaction.test.ts:34:25   expect(scan.scanned).toBe(false);

 FAIL ... > reports scanned:false for a ledger file over the record bound
AssertionError: expected true to be false // Object.is equality
 ❯ test/rlm-ledger-compaction.test.ts:50:25

 FAIL ... > does not consume a v:2 record as a deletion
AssertionError: expected [] to deeply equal [ '11111111' ]
 ❯ test/rlm-ledger-compaction.test.ts:79:35   expect([...scan.liveChildIds]).toEqual(["11111111"]);
（今天 v:2 的 delete 被当作 v:1 消费 → liveChildIds 被清空、deletedChildIds 收到该 id）

 FAIL ... > compacts an over-bound ledger instead of failing the append closed
Error: event log /var/folders/.../rlm-ledger/cd8fe9c065ee5bc0.jsonl exceeds 33554432 bytes (47246861); refusing to read
 ❯ EventLog.repairTailAsync src/core/event-log.ts:274:10
 ❯ RlmSpawnLedger.appendRecord src/modes/daemon/rlm-ledger.ts:806:23

 Test Files  1 failed (1)
      Tests  4 failed | 1 passed (5)
EXIT=1
```

即：探针 P2（越界后 append 当场 fail-closed）与 P3（读者无界 + v:2 被吃）都以断言形式复现为红。

**第二批测试的红形态（如实记录）**：等价／死亡谓词／终极闸／sweep 类四组测试是在导出符号（`RlmLedgerOverBoundError`、构造函数 bounds 参数、`rlmLedgerCompactionModule`）落地之后写的，作为文件它们没有跑过「加载失败」以外的红；为满足「从未红过的测试不算交付」，改用**变异正控**证明其检出力，证据 `/tmp/audit_r/round-42/c2-mutation-control.txt`：

| 变异 | 结果 |
|---|---|
| `reduceRlmLedgerEdges` 的 rename 分支变空操作（终态名回退到 spawn 名） | `× compacts an over-bound ledger instead of failing the append closed`：`AssertionError: expected 'worker-0-xxx…' to be 'worker-0-28-xxx…'` → 1 failed / 9 passed |
| 死亡谓词失效（`if (true)`，所有 tombstone 一律退休） | `× is replay-equivalent for a random interleaving…`：`expected [ …(24) ] to deeply equal [ …(40) ]`；`× keeps a tombstone whose child directory still exists…`：`expected undefined to be 'sub-kept0001|/private/var/…'` → 2 failed / 8 passed |

两次变异后均已还原原文件（还原后 10/10 绿、`git status` 干净，见 §4）。附注一条方法论事实：等价断言比较的是**同一读者**压实前后的视图，所以「共享 reduce」里的变异对它不可见（前后一起变），它检的是压实**产出侧**（终态记录形状、死亡谓词、key 集合）；reduce 侧的回归由梯子测试的「终态名 = 最后一次 rename」断言把住（变异 1 实证）。

---

## 2. 改动清单（逐文件）

**新增**

1. `src/core/rlm-ledger-bounds.ts` — 中性小模块，`RLM_LEDGER_MAX_BYTES`(32 MiB) / `RLM_LEDGER_MAX_RECORDS`(100 000) 的唯一权威定义；写侧（`modes/daemon/rlm-ledger.ts`）与读侧（`core/retention/ledger-scan.ts`）都从这里 import，`core/retention` 不再需要反向 import `modes`。
2. `src/core/rlm-ledger-compaction.ts` — 压实引擎（双方共用，单一权威实现）：
   - 记录/边类型与 `parseRlmLedgerLine`（原样从 rlm-ledger.ts 迁入，含 v≠1 fail-loudly、未知 op 跳过语义）、`rlmLedgerEdgeKey`、`reduceRlmLedgerEdges`（唯一的重放归约：spawn 建边 / rename 改名 / delete 打墓碑 / 无 spawn 的 rename、delete 为 no-op）。
   - `rlmLedgerChildDirExists`：与 LIFE-1 `dropEdgesWithGoneChildDirsUnlocked` 同谓词（`statSync(dirname(canonicalSessionPath(child))).isDirectory()`）。
   - `projectRlmLedgerFile` / `rlmLedgerFileOverBound`：stat 取字节（超字节界即判越界，不分配）、分块数换行取记录数（不整文件驻留）。
   - `compactRlmLedgerFile`：守卫内 重放全文件（走**无界** `EventLog`，继承其 torn-final-line 容忍）→ 归约终态边 → 产出 `meta 首行 + 每活边一条终态 spawn + 每「子目录仍存在」的已删边一条终态 spawn+delete`（子目录已灭的已删边整条不落盘）→ temp(`wx`,0600) + fsync + **重 stat（size+mtime 与压实时快照一致才 rename，否则弃局删 temp）** + rename + 目录 fsync；**不留 `.bak`**（采纳方案书留席决策①）。终态集自身仍越界 → 不发布，返回 `overBound:true / aborted:"over-bound"`；被并发写移动 → `aborted:"moved"`。
   - `withLedgerCompactionGuard`：`lockSync(path,{realpath:false,lockfilePath:path+".guard",stale:30_000})`，20×10ms `Atomics.wait` 重试，形态抄 `orphan-process-journal.ts:withJournalGuard`；守卫只在压实期间持有，append 热路径不加锁。
   - `RlmLedgerOverBoundError`（class）：消息带活边数、两个边界、建议动作（减拓扑 / 提界 / `prime-agent retention sweep`）；带 `ledgerPath / liveEdges / bounds / projectedBytes / projectedRecords` 字段。
   - `listRlmLedgerFiles`（sweep 类扫描单元）。
3. `src/core/retention/rlm-ledger-compaction.ts` — sweep 侧 opportunistic 压实类 `rlm-ledger-compaction`（采纳留席决策②的类形状）：开关关 → `disabled:true, scanned:0`；dryRun → 只预测（`reference:dry-run` skip，不动权威文件）；越界文件 → 调引擎；报告 `scanned=ledger 文件数`、`reclaimed=被压实掉的记录数`、`bytes=缩减量`；终态集仍越界 → `failed:ledger-over-bound`；文件被并发写移动 → `in-use:pid`；引擎抛错 → `failed:ledger-compaction`（带消息 detail）。不花删除预算（它重写文件、不删条目），`capped:false`。
4. `test/rlm-ledger-compaction.test.ts` — 10 条测试（详见 §3）。
5. `packages/coding-agent/.changes/r42-c2-ledger-ladder.md` — 3 行用户可感 changelog fragment。

**修改**

6. `src/core/retention/ledger-scan.ts`（读者对齐，独立成立）：
   - 每文件读前 `statSync().size > RLM_LEDGER_MAX_BYTES` → 立即返回 `scanned:false`（不分配、不清空集合语义：调用方一律按 unknown 保守保对象）；逐行计数 `> RLM_LEDGER_MAX_RECORDS` → 同样 `scanned:false`。
   - `record.v !== 1` 的行**跳过**（保守 skip，不 throw）：不当作 delete 消费，也不当作 spawn；对齐 daemon `parseRlmLedgerLine` 的 v 闸语义。
7. `src/core/retention/types.ts`：`RetentionClassId` 加 `"rlm-ledger-compaction"`；`ResolvedRetentionSettings` 加 `ledgerCompactionEnabled: boolean`（含注释说明关掉＝回到 fail-closed 现状）。
8. `src/core/retention/sweep.ts`：`CLASS_MODULES` 注册 `rlmLedgerCompactionModule`，**放在最后**（它重写的正是上面各类读证据的文件，不能在 sweep 中途改证据；同时保持既有报告顺序断言不变）。
9. `src/core/settings-manager.ts`：`RetentionSettings.ledgerCompactionEnabled?: boolean` + 白名单键 + `resolveRetentionSettings` 默认 **true**（`!== false`），注释指向 ADC-2。
10. `src/modes/daemon/rlm-ledger.ts`：
    - 常量与记录/边类型、行解析、edgeKey、重放归约改为从 core 两个模块 import，并**原样 re-export 既有导出名**（`RLM_LEDGER_MAX_BYTES`/`RLM_LEDGER_MAX_RECORDS`/`RlmLedgerDeleteReason`/`RlmLedger*Record`/`RlmLedgerEdge`），另加 `RlmLedgerOverBoundError`；`replaySync` 的归约改调共享 `reduceRlmLedgerEdges`（消除两份归约）。
    - 构造函数新增第 5 个可选参 `bounds?: RlmLedgerBoundsOptions {maxBytes?, maxRecords?, compactionEnabled?}`（公共 API 增参，旧调用点不变）；`EventLog`、`replaySync` 的读界、seed 的界检查全部改用 `this.bounds`。
    - `RlmLedgerReplayCache` 增 `records`（重放走过的非空行数），作为记录界投影的输入。
    - `appendRecord` 写前梯子：`projectAppendBounds(payloadBytes)`（stat 投影字节；记录数取热缓存，缓存不匹配该文件状态则一次有界重放取准确值；重放因界拒读＝越界判定）→ 将越界则 `compactUnderGuard()` → 清 `replayCache` → **再投影一次** → 仍越界则抛 `RlmLedgerOverBoundError`（带活边数）→ 否则照常 `appendAsync`。`compactionEnabled:false` 时整条梯子跳过，回到今天的 fail-closed（EventLog 的 "refusing to read"）。
    - `appendSpawnUnlocked` 的**建议性**重复入场检查：重放因界拒读时跳过该检查并记日志（否则 spawn 在到达梯子之前就 fail-closed，梯子对 spawn 无效）；malformed 行仍然照旧抛出、拒绝 spawn。
11. `src/modes/daemon/daemon-mode.ts`：`recordRlmSubagentDeletion` 的 `appendDelete`（原注释「a failed append is a failed deletion」处）包 try/catch，`RlmLedgerOverBoundError` → 抛 `Could not delete RLM subagent <childId>: <类型化消息>`（用户面拿到活边数/边界/建议动作，不是裸栈）；两个 ledger 构造点传 `rlmLedgerBoundsOptions()`（读 `SettingsManager.create(cwd, agentDir).getRetentionSettings().ledgerCompactionEnabled`，读设置失败默认 on）。
12. `src/modes/daemon/daemon-supervisor.ts`：两个 ledger 构造点传 `rlmLedgerBoundsOptions()`（`this.settingsManager.getRetentionSettings()`，异常默认 on）。
13. `docs/settings.md`：`retention.ledgerCompactionEnabled` 一行（默认 `true`，含关掉后的后果）。
14. `test/rlm-ledger.test.ts`：既有 `fails closed on byte and record bounds` 更新——越界文件的 `appendRename` 从 `rejects("bytes")` 改为 `resolves`（这正是本 PR 的行为变化），并**保留 fail-closed 契约作为正控**：`{compactionEnabled:false}` 下同一 append 仍 `rejects.toThrow("bytes")`（含 torn-tail 修复路径那条）。读界断言（`edges()` 对超字节/超记录文件仍 `rejects`）原样保留。
15. `test/retention-tmp-and-logs.test.ts`：`baseSettings` 字面量补 `ledgerCompactionEnabled: true`（`ResolvedRetentionSettings` 新增必填字段）。

---

## 3. 等价与正控结果

`test/rlm-ledger-compaction.test.ts`（10 条，全绿；均走公共入口，无私有探测）：

| # | 测试 | 断言要点 |
|---|---|---|
| 1 | 读者对齐：超字节界文件 | `scanned:false`、两个 id 集合空（**红→绿**） |
| 2 | 读者对齐：超记录界文件（100 001 条） | `scanned:false`（**红→绿**） |
| 3 | 读者对齐：v:2 delete | 正控 `scanned:true` + v:1 spawn 的 id 在 `liveChildIds`；`deletedChildIds` 不含该 id（**红→绿**，今天被吃） |
| 4 | 梯子（红1）：47 MB / 90 000 条被覆盖记录的 ledger 上 `appendSpawn` | append 成功、文件缩小到 ≤32 MiB、`edges(true)` 3001 条、新边在、旧边名 = 最后一次 rename、ledger 文件仍在（**红→绿**，今天 `refusing to read`） |
| 5 | 正控：界内 ledger | `scanned:true`、deleted id 正确、live 集合空（证明 1/2 不是"什么都读不到"） |
| 6 | **等价（合入门槛）** | 40 子（子目录+转录都在）× 240 步随机交错 spawn/rename/delete/re-spawn（固定种子 mulberry32，可复现）；压实前后 `edges(true)` 与 `edges()` 按 key 的**六元组**（childId/parent/child/depth/name/deleted）全等、key 集合全等、`family()` 逐行指纹全等；文件确实缩小；ledger 目录**无残留旁文件**（无 `.bak`/`.compact-*`/`.guard`） |
| 7 | 死亡对账谓词 | 已删 + 子目录存在 → 压实后墓碑保留（`edges(true)` 指纹与压实前逐字相等）；已删 + 子目录已灭 → 记录被压实掉且 `edges()`/`liveEdges()` 与压实前全等。**消费点 1**（`tombstoneSavedSessionDelete` raw 视图）：对已删子再调一次＝幂等（文件行数不变、`ledgerEdge` undefined），对存活子调一次＝正常打墓碑（返回边 + raw 视图 `deleted:"user"`）。**消费点 2**（`deleteRlmSubagent` 断点重试所需形状）：压实后 `edges(true)` 仍带墓碑的 `child` 会话文件路径（重试据此扫 artifacts），且 artifacts 未被压实触碰（`existsSync(keptChild)===true`） |
| 8 | 终极闸 | `maxRecords:4`（终态集＝meta+3 spawn＝4 条）：append 被拒、`instanceof RlmLedgerOverBoundError`、`liveEdges===3`、`bounds.maxRecords===4`、消息含活边数与 `retention sweep` 建议；**读界与写界分离**：文件仍 4 条、默认界实例 `edges()` 3 条、紧界实例 `edges(true)` 3 条都仍可读；`tombstoneSavedSessionDelete`（daemon delete 走的同一写路径）把类型化错误原样透传（`rejects.toBeInstanceOf(RlmLedgerOverBoundError)`） |
| 9 | sweep 类 | 100 001 条越界文件 → `scanned:1`、`reclaimed:100000`、`bytes>0`、`capped:false`、`disabled:false`、压实后 `projectRlmLedgerFile().overBound===false`、终态只剩 meta 一行（重放等价） |
| 10 | sweep 类开关/dryRun | `ledgerCompactionEnabled:false` → `disabled:true, scanned:0`、文件字节不变；`dryRun:true` → `scanned:1, reclaimed:0`、skip 原因 `reference:dry-run`、文件字节不变 |

既有面（等价证明：未触碰路径行为不变）：`test/rlm-ledger.test.ts`、`rlm-ledger-root-teardown`、`rlm-ledger-passive-scan-concurrency`、`retention-sweep`、`retention-life-reclaim`、`retention-tmp-and-logs`、`retention-root-fix`、`event-log`、`settings-manager` 合计 **9 文件 160 测试全绿**（含 `retention-life-reclaim.test.ts:176` 既有的 `unverifiable:ledger-scan` 断言链——`ledgerScanned:false` 下 child-transcripts 类保守保对象；本 PR 让「超界」也走这条已存在的保守分支）。

---

## 4. check 与测试结果

- `npm run check`（`biome check --write --error-on-warnings . && tsgo --noEmit && check:installer && check:browser-smoke && check:ci-honesty`）：**EXIT=0**，全量输出 `/tmp/audit_r/round-42/c2-check2.txt`。`Checked 1415 files. No fixes applied. Found 34 infos.`，**0 error / 0 warning**。34 条 info 全部落在本 PR 未触碰的文件（`src/core/stall-diagnostics-render.ts` 的 `useLiteralKeys` ×29，`test/context-tree-spend-basis.test.ts` / `test/retention-life-reclaim.test.ts` / `test/session-manager/dat1-complete-record-newline-recovery.test.ts` 的 `useTemplate` ×5）＝基线既存库存；我改/新增的文件 biome 诊断为 0（中途两条 warning——未用变量 `overBound`、未用 import `rlmLedgerEdgeKey`——已修掉并复跑）。
- `npm run check:test-hygiene`：**OK (no new private-member probes)**，scanned 872 files，frozen 474 / suppressed 23（均为基线库存，本 PR 未新增）。
- 新测试文件：`10 passed (10)`；相关套件：`9 files / 160 tests passed`。跑法按规定：包根 + 清泄漏 env（`env -u PI_CODING_AGENT -u PRIME_AGENT_* -u RLM_*`）+ `node ../../node_modules/vitest/dist/cli.js --run`。
- 纯净树复验（仓规「每个提交在 pristine tree 上再验一遍」）：`git archive 4e5f1cbf7 | tar -x -C /tmp/audit_r/round-42/c2-pristine` + symlink node_modules + `npx tsgo --noEmit` → **PRISTINE_EXIT=0**。
- 提交后 `git status --short` 干净；`git diff --cached --name-only` 提交前核对为恰好 15 个自己的文件；未用 `git add -A/.`、未 `--no-verify`、未 amend、未 reset/checkout/stash；主仓 `/Users/a1/Desktop/ai/prime-agent` 全程只读、未 cd 进去跑 git；未装任何依赖。

**commit sha：`4e5f1cbf7`**（15 files changed, 1514 insertions(+), 169 deletions(-)）

---

## 5. 偏差（逐条，非 none）

1. **`appendSpawnUnlocked` 的建议性重复入场检查在「界拒读」时跳过并记日志**（方案书只点名 `appendRecord`）。理由：不跳过则 spawn 在到达梯子之前就 fail-closed，2A 对 `appendSpawn` 完全无效，而方案书 ② 的裁决明确「拒新直接杀死两条产品路径」之一正是无法生子代理。malformed 行仍照旧抛出（fail-closed 不变），且该检查本身注释即自认为「advisory, per-process，不是全局唯一性保证」，降级形态＝本进程不抓自己的重复入场。
2. **压实重写的记录重打 `at` 时间戳**（不保留原始时刻）。核实：无任何读者消费记录级 `at`（`parseRlmLedgerLine` 只校验其为 string，`RlmLedgerEdge` 不携带它），等价断言的六元组也不含它；换取的是终态记录形状单一。已在引擎注释说明。
3. **v:1 但 op 未知的记录在压实中被丢弃**（并记日志）。这是方案书「产出＝meta + 终态 spawn(+delete)」的直接后果：未知 op 对本读者重放不可见，无法在终态集里复现。v≠1 的记录不会被静默丢——解析器对其 fail-loudly，压实因此抛出、不发布（保守方向）。
4. **既有测试 `fails closed on byte and record bounds` 被改写**（appendRename 对越界文件从 rejects 变 resolves）。这是本 PR 的目标行为，不是掩盖回归；同一测试内**保留** fail-closed 契约作为正控（`compactionEnabled:false` 下仍 `rejects("bytes")`，含 torn-tail 修复路径），读界断言原样保留。
5. **`deleteRlmSubagent` 断点重试消费点做的是 ledger 契约级断言**（压实后 `edges(true)` 仍带墓碑 + `child` 路径、artifacts 未被动），没有端到端驱动 `AgentSession.deleteRlmSubagent` / `AgentDaemon.recordRlmSubagentDeletion`（时间盒）。`tombstoneSavedSessionDelete` 那个消费点是真驱动（两次调用：幂等 + 新打墓碑）。daemon 侧类型化透传 likewise 在 ledger 写路径级证明（`tombstoneSavedSessionDelete` rejects `RlmLedgerOverBoundError`），`daemon-mode.ts` 的 catch→rethrow 未跑端到端测试。
6. **可选加分项 doctor/status 报 ledger 体积/记录数/超界标志：未做**（时间盒砍掉，按方案书 ⑥ 该条为可选）。引擎已导出 `projectRlmLedgerFile`，后续接线是一行调用。
7. **sweep 侧越界判定的记录数用换行计数**（分块 64 KiB，不整文件驻留），相对读者「非空行」计数是保守过计（可能极早触发一次压实）；字节界先于记录界用 stat 判，超字节界不读文件。
8. **等价/死亡谓词/终极闸/sweep 类四组测试没有「文件级红」证据**（写在导出之后），改以两次变异正控证明检出力（§1 表，证据文件 `c2-mutation-control.txt`）。红证据充分的是读者对齐 3 条 + 梯子 1 条（`c2-red.txt`，EXIT=1 真实断言失败）。
9. **压实发布条件的精确化**：终态集自身在界内即发布（即使「再加一条待写记录」会越界——这正是终极闸要演示的读界/写界分离）；终态集自身越界则不发布（重写权威文件却换不回可读性，无收益）。方案书未细化到这一层，此处按 ⑤ 的终极闸断言（「append 拒 + `edges()` 仍可读」）反推取齐。
10. **守卫 `stale` 取 30 s**（方案书写 `stale:…` 未定值；对齐 `cron-jobs.ts` 的 30 000 而非 orphan-journal 的 5 000，因为一次 32 MiB 级重写可能超过 5 s）。`.guard` 后缀与 orphan-journal 的 `.guard` 同形但 lockfilePath 各自独立（R9：无共享代码路径）。
