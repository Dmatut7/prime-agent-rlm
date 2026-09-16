# r38 子代理产物的磁盘生命周期（正确性轴：产物 ↔ 所有权）

- repo `/Users/a1/Desktop/ai/prime-agent`，冻结点（审计期间 HEAD 未变，仓零写入）`d06630a005dd1195a681e2b0529550a91cf966f4`
- 真机数据 `~/.prime/agent`（只读）；对账脚本 `/tmp/audit_r/round-38/reconcile.py`（纯读，可重跑）
- 复现脚本：`/tmp/audit_r/round-38/{reconcile.py, ledger_probe.mts, ledger_probe2.mts, wrace/reader.mts}`
- 去重基线 `docs/fork/audits/decisions.jsonl`（313 行）：第 8（删目录被读路径静默重建）、9（三类只增不减账/无回收器）、76（保留策略设计）、143（/import 同 id 共写 artifact 目录）、148（artifact 墓碑缓存无驱逐）、244（SIGKILL 中途 .tmp 泄漏）、290/294/310（dill）已占位；本报告只记**残余面**。

## 0. 真机对账总表（`reconcile.py` 逐字输出）

```
ledger records           3990  {'meta': 1, 'spawn': 2526, 'delete': 1463}
unique edges             2526      raw live 1065   tombstones 1461
raw-edge reasons         {'user': 1456, 'revoked': 5}
reconciled live          840
live edge -> dir gone    225   (distinct parents 10)
tombstoned edge -> dir on disk 916
tombstoned edge -> transcript on disk 916
display files            1756  {'deleted': 916, 'completed': 803, 'running': 37}
display dirs w/o live edge 916
display dirs unknown to ledger 0
display<->edge join ok   1756   mismatched 0
deleted-status dirs      916  bytes 1224711473  files 3001
```

形态定义：ledger 边键 `(childId, realpath(child))`（与 `rlm-ledger.ts:296 edgeKey` 同构）；`raw live` = 无 delete 记录的边；`reconciled live` = 加了 `liveEdgesUnlocked()` 的 stat 对账（child+parent 都是文件）。

---

## L1 活边指向已删目录：225 条边永不回收，ledger 的"活"与磁盘的"活"长期分叉

- **命题**：ledger 是 append-only 且**没有任何对账/回收路径**，`liveEdges()` 的 stat 对账只影响单次读数、不落盘；因此"边活着但 child 目录/transcript 已消失"是**永久**状态，raw `edges()` 永远把它们当活边。
- **severity**：medium
- **file:line**：`packages/coding-agent/src/modes/daemon/rlm-ledger.ts:514-566`（`liveEdges`/`liveEdgesUnlocked` 只过滤返回值，不回写）、`:380-390`（append-only，只有 append 无回收）、`:456-473`（seed 只在 ledger 文件缺失时发生）
- **逐字证据**（真机）：`live edge -> dir gone 225 (distinct parents 10)`；这 225 条边**没有** delete 记录（`raw live 1065` vs `reconciled live 840`，差 225）。10 个父会话的 transcript 全部仍在 `~/.prime/agent/sessions/*.jsonl`（`os.path.isfile(parent)` 224/225 真），但它们的 artifact root `session-artifacts/<parentId>/` 整体不存在，且 770 个"边存在、目录已消失"的形态里 545 个带 tombstone、225 个**不带**。
- **影响**：
  1. `tombstoneSavedSessionDelete()`（`rlm-ledger.ts:905`）用的是 raw `edges()`（`rlm-ledger.ts:918`），会把 225 条死边当成活边参与删除判定；
  2. retention 的 ledger 扫描 `scanRlmLedgerDirectory()`（`core/retention/ledger-scan.ts:40-79`）同样只看记录、不看 stat，225 个死 child id 永久留在 `liveChildIds` 里——现在无害（目录已不在），但任何"同一路径/同一 id 复活"的场景会静默继承这份"活"；
  3. 对账口径失真：任何按 ledger 报"活子代理数"的读数会多报 225（1065 vs 840，+26.8%）。
- **可复现**：`python3 /tmp/audit_r/round-38/reconcile.py`（脚本第 42-44 行打印这三行）；交叉核对用仓内真代码：`node_modules/.bin/tsx /tmp/audit_r/round-38/ledger_probe.mts` → `{"rawLive":1065,"rawTombstones":2526,"reconciledLive":840}`（与 Python 重放一致，差额 = 读盘时刻之后我派出的 2 个子代理）。
- **confidence**：high（两条独立路径 + 仓内代码自身读数一致）。
- **残余面（相对 decisions #8）**：第 8 条修的是"读路径静默重建已删目录"，本条是**反向**——目录没了但所有权记录不撤，属未覆盖面。

## L2 删除联动：三条删除路径对"子代理产物"的处理互不一致，transcript 与 sub-* 目录的回收责任无主

- **命题**：删除子代理时，`transcript`、`sub-*/rlm-subagent.json`、`sub-*/semantic-edges.jsonl`、子会话自身 artifact dir（`<parentRoot>/session-artifacts/<childUuid>`）四类产物的清除策略不同，且**没有任何一条路径同时清干净**；"删父会话"只靠 `rm -rf <parentRoot>` 连带，而没有 tombstone 的子边（L1 的 225）就此变成死边。
- **severity**：medium
- **file:line**：
  - 路径 A（删除保存会话/子会话 transcript）：`core/session-file-actions.ts:120-147` → `removeSessionFile`（trash→unlink transcript）+ `deleteSessionArtifacts`（`:31-52`，`rm(artifactDir,{recursive:true,force:true})`）；`artifactDir = <parentRoot>/session-artifacts/<id>`，**不含** `sub-*/` 目录本身；
  - 路径 B（agents 视图删除子代理）：`modes/daemon/daemon-mode.ts:1215-1250`（写 display `status:"deleted"` → `appendDelete` → `deleteRlmSubagentArtifacts(childSessionFile)`），注释逐字："Deletion boundary: transcript + display tombstone are the durable record and **stay**; the nested artifact dir is a runtime cache and goes."
  - 路径 C（删除根会话）：`deleteSessionFile` 的 `rm -rf <parentRoot>` 连带删除所有 `sub-*` 子目录，但**不会**为这些子边写 delete 记录（ledger 里 0 条 `parent-teardown`：`raw-edge reasons {'user': 1456, 'revoked': 5}`）→ 正是 L1 的 225 条。
- **逐字证据**（真机 + 代码）：916 个目录 `display.status == "deleted"` **仍在盘上**，各含 transcript + `rlm-subagent.json` + `semantic-edges.jsonl`，合计 **1,224,711,473 B / 3001 文件**；`tombstoned edge -> transcript on disk 916` 与 `deleted-status dirs 916` 完全同集（916/916）。另：`~/.prime/agent/session-artifacts/*/sub-*/session-artifacts/.session-tombstones.jsonl` 共 8 个（本轮 my-own-tree 的孙代删除），其中 `sub-5e2d30b9` 的记录逐字为
  `{"version":1,"sessionId":"01a0a77a-3756-707a-b123-970cf2698377","deletedAt":"2026-09-15T23:58:06.002Z","reason":"session-deleted"}`，同一 id **重复两条**（.002Z 与 .028Z，相距 26 ms）→ 删除路径在真机上被并发/重试执行了两次。
- **影响**：①"删了子代理"后磁盘上仍留 1.22 GB（916 目录），且只有被主动打开的 `childTranscriptDays` 类能回收（见 L3）；②删除父会话不会给子边留墓碑，导致 L1 的永久死边；③同一次删除写两条 tombstone（幂等性靠 `deletedAt` 取新，功能上无害，但说明删除入口无去重闸）。
- **可复现**：`python3 /tmp/audit_r/round-38/reconcile.py`；tombstone 逐字：`grep -c . ~/.prime/agent/session-artifacts/01a09ee1-d584-7027-a016-d4df41b14ce4/sub-5e2d30b9/session-artifacts/.session-tombstones.jsonl`（=4 行 / 2 个 id）。
- **confidence**：high。

## L3 916 个"已删除"子目录的字节只能靠一个默认关闭的回收类；另有 53 个目录**在构造上永不可回收**

- **命题**：`child-transcripts` 类是唯一能回收 `sub-*/<uuid>.jsonl` 的回收器，默认 `childTranscriptDays = 0` → `disabled: true`；同时 `artifact-residue-dirs` 要求"正向删除证据"，导致 53 个目录既非活边、又无墓碑、也无 transcript，**永远不会进入可回收集合**。
- **severity**：medium（1.22 GB 结构性不可回收 + 53 个永久残留）／low（53 个仅 51 KB）
- **file:line**：`core/retention/child-transcripts.ts:3`（注释逐字 "OFF BY DEFAULT (round-09 ruling 1: sub-agent dill/transcripts are not reclaimed by age)"）、`:54-65`（`days <= 0` → `disabled: true`）；`core/retention/artifact-dirs.ts:223-238`（`requireDeletionEvidence`：无 tombstone 且非 `ledgerDeleted` → `SKIP.noTombstone`）
- **逐字证据**（真机 `~/.prime/agent/retention/last-sweep.json`，`at 2026-09-16T01:06:40.470Z`，`dryRun false`，`enabled true`）：
  ```
  child-transcripts   scanned=0  reclaimed=0  disabled=True
  artifact-residue-dirs scanned=1432 reclaimed=0 skipped=950
      {'reference:ledger-live': 552, 'in-use:resident': 283, 'reference:transcript:/Users/a1/.prime/agent/sessions': 54, 'no-tombstone': 53, 'young:7d': 8}
  artifact-empty-dirs scanned=1432 reclaimed=0 skipped=482 {'young:7d': 479, 'reference:ledger-live': 3}
  stalled: ['artifact-residue-dirs','artifact-empty-dirs','stale-leases']
  ```
  按 reason 聚合磁盘字节（对 skipped.path 实测）：`no-tombstone 53 dirs / 51,555 B`；`reference:ledger-live 552 dirs / 1,796,349 B`；`reference:transcript:<sessionsDir> 54 dirs / 2,158,897,345 B`（活根会话的 artifact root，应当保护）。
- **影响**：`stalled` 把这两类标成"跑了但从不回收"（设计如此），但 `no-tombstone` 那 53 个不是"等着变老"，而是**判据里没有任何一条路径能给它们补上证据**（无 transcript、无 edge、无 tombstone → 除非人工），这是回收器的死区（dead zone）。
- **可复现**：`python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.prime/agent/retention/last-sweep.json')));print([c['class']+':'+str(len(c['skipped'])) for c in d['classes']])"`；`/tmp/audit_r/round-38/reconcile.py` 末行 `deleted-status dirs 916 bytes 1224711473 files 3001`。
- **confidence**：high（报告是程序自己的输出）。

## L4 同一 `rlm-subagent.json` 的跨进程陈旧读：缓存只用 `(size, mtimeMs)` 重校验，写者只清自己进程的缓存

- **命题**：`readRlmSubagentDisplayEntry()` 的命中条件是 `cached.size === stats.size && cached.mtimeMs === stats.mtimeMs`；`writeRlmSubagentDisplayEntry()` 只调用本进程的 `displayCache.delete(path)`。跨进程写者若产生**同样的 (size, mtimeMs)**，读进程会持续返回旧条目；而 `BoundedCache.get()` 每次命中都刷新 `touchedAt`（`utils/bounded-cache.ts:60-67`），所以热路径上的陈旧条目**不会被 15 min idle TTL 驱逐**——不自愈。
- **severity**：medium
- **file:line**：`modes/daemon/rlm-subagent-display.ts:95-118`（写路径 temp+rename+**本进程** `displayCache.delete`）、`:138-166`（读路径以 `(size, mtimeMs)` 重校验）
- **逐字证据**（真机复现，三组对照，`wrace/reader.mts` 一个长命进程内先后读两次）：

  | 第二次写入 | 盘上最终 `status` | READ1 | READ2 |
  |---|---|---|---|
  | 同尺寸 + 强制同 `mtimeMs` | `deleted` | running | **running（陈旧）** |
  | 同尺寸 + 新 `mtimeMs`（正控） | `deleted` | running | deleted |
  | 不同尺寸 + 强制同 `mtimeMs`（正控） | `deleted` | running | deleted |

  同尺寸是自然发生的：`"running"` 与 `"deleted"` 都是 7 字符（`updatedAt` 定长），即 spawn→delete 转换天然同尺寸；代码自己的注释也承认"Two rewrites within one mtime tick can produce an identical stat"——但那只解释了**写者自己**清缓存，没有解释别的进程。
- **影响**：agents 视图对一个已删除子代理可以长期显示 `running`；且因为命中即刷新 idle 时钟，只有在进程重启或缓存压力驱逐时才恢复。
- **可复现**：`cd /Users/a1/Desktop/ai/prime-agent && env -u RLM_DEPTH -u RLM_SESSION_DIR node_modules/.bin/tsx /tmp/audit_r/round-38/wrace/reader.mts <dir> <go-file>`，写者用 `os.replace` + `os.utime(path, ns=(同值))`（脚本见 `/tmp/audit_r/round-38/wrace/`）。
- **confidence**：high（确定性复现）。生产可达性：需要两次重写落在同一 mtime tick，或一个保留 mtime 的写者（恢复/拷贝 `cp -p`、Time Machine 类）——**中**，故 severity medium 而非 high。

## L5 display 状态无活性对账：37 个 `running` 里 33 个的 transcript 已静默 >6 h（最长 359 h）

- **命题**：`rlm-subagent.json` 只在 spawn/完成/删除三个瞬间被写；spawn 写 `running`（`daemon-mode.ts:1133`），完成写 `completed`（`core/agent-session.ts:13106` → `daemon-mode.ts:1094 recordRlmSubagentState`）。凡是**没走到完成写**的子会话（worker 死亡、daemon 重启、被 kill、passivate），文件永久停在 `running`；没有任何读路径用 stat/成员表去纠正它（对比 ledger 的 `liveEdges()` 会对账 stat）。
- **severity**：low-medium（显示层撒谎，无数据损坏）
- **file:line**：`modes/daemon/daemon-mode.ts:1133-1144`、`core/agent-session.ts:13100-13110`、`modes/daemon/daemon-mode.ts:1301`（读点）
- **逐字证据**（真机）：`display files 1756 {'deleted': 916, 'completed': 803, 'running': 37}`；37 个 `running` 中 **33 个** 其 `sessionFile` 的 mtime 距今 >6 h（最长 `sub-e8333cea` 359.6 h ≈ 15 天，`updatedAt 2026-08-31T23:51:11Z`）。
- **正控**：判定方法本身能检出不一致——我按 `display.childId/sessionFile` 与 ledger 边做全量 join：`display<->edge join ok 1756 mismatched 0`，即 join 口径可信；同一次 join 在 status×edge 交叉表上正确地把 916 个 `deleted` 全部对上 tombstone 边（916/916），说明它能发现"status 与边不一致"的形态，只是当前数据里没有 resurrect 形态。
- **可复现**：`python3 /tmp/audit_r/round-38/reconcile.py`（`display files` 行）+ L5 统计脚本内联在报告边注（`os.walk` + `rlm-subagent.json` + `os.path.getmtime(sessionFile)`）。
- **confidence**：high（数字），medium（"撒谎"定性：一个久置的 `running` 也可能是 legitimately passivated 的活会话，但 359 h 且无 resident 记录时基本可排除）。

## L6 ledger 无压缩：100k 记录 / 32 MiB 是 fail-closed 硬闸，按当前速率约 2 年后 spawn/delete/list 全部读失败

- **命题**：ledger 只追加、从不压缩（`RlmSpawnLedger` 没有 rotate/compact；`EventLog` 对 `maxBytes`/`maxRecords` 的超限是**抛错拒绝读**，不是截断），所以 1461 条墓碑也永久占位；撞闸后是 fail-closed（好），但没有 operator 路径。
- **severity**：low
- **file:line**：`modes/daemon/rlm-ledger.ts:49-50`（`RLM_LEDGER_MAX_BYTES/MAX_RECORDS`）、`:794-795`（`replaySync` 超限抛错）、`:712-714`（seed 超限直接跳过）、`core/event-log.ts:83,179`（`refusing to read`）
- **逐字证据**：真机 `3990` 条 / `1,251,487 B`，首条 `2026-08-18T18:06:40.448Z`，末次写入 `2026-09-16 09:28` → 29 天 ≈ **137 条/天**；`100000/137 ≈ 730 天`，字节维度 `32 MiB / 1.25 MiB ≈ 26×` ≈ 同样量级。fail-closed 行为用仓内代码验证通过（正控，见下）。
- **可复现 / 正控**：`node_modules/.bin/tsx /tmp/audit_r/round-38/ledger_probe2.mts` → 畸形行被拒（`Malformed RLM ledger line 1: Unexpected end of JSON input`）、`v:2` 记录被拒（`missing v/at`）、合法追加记录被接受（`-> accepted, 1 edges`）。因此"真机 3990 行全部可解析、无 v≠1、无重复边键"是**可信的负结论**（我的 Python 重放 3990/3990 解析成功、unique edges 2526 = 2526 条 spawn）。
- **confidence**：high（数字 + 正控）；风险时标 medium（假设速率不变）。

---

## L7 ledger 并发追加的完整性：真机数据里无丢失/无重复/无畸形（负结论，带正控）

- **命题**：`RlmSpawnLedger` 的跨进程安全依赖"单次 O_APPEND 小写原子"（`rlm-ledger.ts:20-30` 注释）与 `EventLog.appendAsync` 的 on-contended 重试；本轮从**真机数据**验证是否留下痕迹。
- **severity**：n/a（负结论）
- **判据与数字**：真机 3990 行逐行 `json.loads` 成功 **3990/3990**、无 `v != 1`、无未知 op 被静默丢弃；`spawn` 记录 **2526** 条 vs 唯一边键 `(childId, realpath(child))` **2526** 个 → **零重复 admission、零键丢失**；`EdgeKey` 冲突会让 `replaySync` 的 last-writer-wins 掩盖重复，此处不成立。
- **正控**：同一套判据在注入畸形输入时必须报错——`node_modules/.bin/tsx /tmp/audit_r/round-38/ledger_probe2.mts`：
  `malformed-mid-file -> refused: Error: Malformed RLM ledger line 1: Unexpected end of JSON input`
  `v2-record-mid-file  -> refused: Error: Malformed RLM ledger line 1: missing v/at`
  `valid-extra-record   -> accepted, 1 edges`
  即"能检出畸形/能接受合法追加"，故上面的负结论是"在本次扫描范围内未见"，不是探测方法失效。
- **残余风险（未取证）**：`repairObservedTail`/`blankObservedTail`（`event-log.ts:405-431`）会把观测到的残尾**原地抹平**——它保护的是一次崩溃留下的半条记录；我没有构造"两个写者与一个修复者同 tick"的进程间时序（需要长命 daemon 双写者，超出本轮时间盒），故仅记为未覆盖面。
- **confidence**：medium-high（负结论本身）；**复现**：`python3 -c "import json;L=[json.loads(l) for l in open('/Users/a1/.prime/agent/rlm-ledger/2908f90643ebb724.jsonl') if l.strip()];print(len(L))"` → 3990。

---

## L8（③ 快照代际归属，子代理 dill-owner 交付，母席已独立复核结构面）

完整报告：`/tmp/audit_r/round-38/dill-ownership.md`（心跳 `di-heartbeat.md`）。要点：

- **RT-3 的实质**：写者一直写 manifest `pythonVersion`（`prime-agent-runtime/src/rlm/repl.py:1261`），RT-3 加的是**读侧转发**——`core/kernel/repl-manager.ts:2979` 读 manifest、`:2985` 只在 `!== undefined` 时发 `python_version`，`repl.py:1481/1516` 命中即把 by-value 函数/类放进 `failed`。闸挂在**可选侧车文件**上，payload 字节本身无代际戳。
- **D1（high）fail-open**：`repl.py:1341-1342` `if python_version is None: return None`（闸关）+ `state-snapshot.ts:303` "Tolerant by design: a missing, torn, or foreign manifest yields `null`" ⇒ manifest 缺失/损坏/无字段时，跨 major.minor 的外来 code object 照常复活。**母席独立复核**：上述两处逐字确认（fail-open 结构面成立）。子代理真内核实证：3.12 payload + 旧式 manifest 走真产品路径 `restore -> {"restored":["f"]}` 后第一格即 SIGSEGV 打死内核（kernelPid 38726）；同 payload 带 `python_version=3.12.11` 则隔离且 EXIT=0（正控），裸 fail-open 臂 `Segmentation fault: 11 (EXIT=139)`。（崩溃臂为子代理实跑，母席未重跑。）
- **D2（medium）** 版本闸只扫一层（`repl.py:1375` docstring 自述）：`outer=[[f]]`、`d={"inner":[f]}` 即使 `python_version` 正确也 `restored`，调用同样死 —— K3G-3 之外的残余深度。
- **D3（medium）** venv 代际 identity（`core/kernel/bootstrap.ts:625-631`）不含解释器版本，`PYTHON_VERSION`（`:29`）不进 hash ⇒ 同代目录会被原地换成别的 major.minor 解释器，"代际"不能当解释器边界；本机 7 个 venv 代际里 4 个装的 runtime 没有 `_version_mismatch_reason`。
- **D4（low）** 快照代际引用缺生产写者（`kernelSnapshotGenerationName/ReferencePath` 只有测试消费者）⇒ `artifact-dirs.ts` 的 `liveSnapshotReferences` 恒 0；回收开关默认 off，当前无实害。

**与本报告 L1/L3 的交叉**：D4 说明"活引用保护"在快照一侧是空集，L3 里 54 个 `reference:transcript:<sessionsDir>`/552 个 `reference:ledger-live` 才是真正在起作用的保护面——两侧的"保护原因"集合不重叠，快照侧的保护是**名义上的**。

---

## L9（⑤ 崩溃残留/孤儿回收，子代理 orphan-reclaim 交付，母席已独立复核关键数字与逐字代码）

完整报告：`/tmp/audit_r/round-38/orphan-reclaim.md`（心跳 `hb-orphan.md`；探针 `probe-orphan.ts`、`xowner-write.mts`、`xowner-read.mts`）。

**回收器清单**：R1 owned-worker 前端（`core/owned-session-worker.ts:289-307`）、R2 内核退出（`core/kernel/repl-manager.ts:2531`，按 kernelPid）、R3 supervisor 恢复（`modes/daemon/daemon-supervisor.ts:5445-5510`，仅 3966/4955/5350/5361 四处调用）、R4 `deleteWorkerDescriptor`（`:2202-2211`，**只删不 reap**）、R5 retention（**无任何 class 覆盖 `*.orphans.jsonl`**）。sockets 有 R31-5 清扫器，journals 没有姊妹清扫器。

- **F1 medium-high｜非 owner 进程写进 worker journal 的记录无人可回收**（母席复核：**结构面逐字确认**）
  `orphan-process-journal.ts:570-572` 逐字 `if (isJournalRecord(record) && record.ownerPid === ownerPid)`；`:657` 逐字 `if (orphan.kernelPid !== kernelPid || orphan.pid === kernelPid) continue;` —— 三个回收器全部按 owner/kernelPid 过滤，外部 writer（host 侧 shell 写的、无 kernelPid）不在任何集合里。
  **母席独立真机核对**（`~/.prime/agent/daemon-workers/12f042ee5718/afc409710709.orphans.jsonl`，2155 行/1117 唯一 pid）：`active` 136 条 = owner 匹配 76 + **外部 owner 60（20 个不同 ownerPid）**，与子代理数字一致；外部 owner 的 60 个 pid 此刻**已全部死亡**（`os.kill(pid,0)` 全 False），即"危害实例当前为 0，机制与类别存在"的表述准确。对照 journal `58f06141c995.orphans.jsonl`：33 active，外部 owner 0（正控：口径能区分两种 journal）。
  危害：writer 死后其 bash 子进程无回收路径；`deleteWorkerDescriptor` 会把 journal 整删（既是"唯一清场手段"，也是把未 reap 记录一起丢弃）。
- **F2 medium-high**：failed-worker reaper（`daemon-supervisor.ts:4809-4831` → `:2202-2211`）删 descriptor+journal 全程不 reap；对照 `reclaimStaleWorkerRegistration(:3965-3971)` 是先 reap 再删；可达路径 `recoverWorker 5278-5285`（ownerClientId && 死进程）直接 park failed 并 return，跳过 5350/5361 的 reap。默认开启（24h）。
- **F3 medium**：无 descriptor 的 `*.orphans.jsonl` 无读者无清扫（`quarantineWorkerDescriptor` 改名、两步 rmSync 之间被 SIGKILL 都会造成）——本机 0 例 + 正控。
- **F4 medium**：`stale-leases` 只认 `/^[0-9a-f]{64}\.lock$/`，而租赁临时目录名是 `<hash>.lock.candidate-*` / `*.stale-*`（`core/session-lease.ts:613` / `:541`）→ SIGKILL 后永久驻留且**不出现在 sweep 报告里**。母席核对本机：`~/.prime/agent/session-leases` 42 项**全部**是 `*.lock`，candidate/stale 残留 0 例（与该类"本机未命中"一致，属机制性发现）。
- **F5 low-medium**：活 worker 泄漏的租约在 sweep 眼里恒为 `in-use:pid`（`isReclaimableOwnLease` 跨进程不可能成立）→ 只有 worker 死亡后才可能回收。
- **F6 low**：pid-only 租约 owner 遇 pid 复用即永久 live（`isLeaseOwnerAlive` 只看 `kill(0)`），acquire 侧 fail-closed ⇒ 会话永久打不开。
- **F7 low**：`$TMPDIR/prime-agent-owned-*.json(.orphans.jsonl)` 与 descriptor 的 `*.json.<pid>.tmp` 无任何 sweep 家族覆盖。

**与本报告 L1/L3 的交叉**：L3 的 `stale-leases` 在 11 次 sweep 里 `reclaim=0`（21 `in-use:pid` + 18 `young:24h`）——F5 解释了"为什么恒为 in-use"，F4 解释了"为什么有些残留根本不进报告"。

---

## 未决 / 待补
- L4 的生产可达性只有"同一 mtime tick"这一条间接证据，未在真机抓到一次实际陈旧读（需要长命 daemon + 并发写，本轮时间盒内不做）。
- ③（dill 快照代际归属）与 ⑤（崩溃残留/孤儿回收）由 sibling 子代理产出：`/tmp/audit_r/round-38/dill-ownership.md`、`/tmp/audit_r/round-38/orphan-reclaim.md`（见本目录）。
- 本报告所有数字为只读快照；期间我派出 2 个子代理使 ledger 记录数 +2（2524→2526），对账脚本可重跑复现。
