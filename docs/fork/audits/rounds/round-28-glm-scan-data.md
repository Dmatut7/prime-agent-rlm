# round-28 / GLM 数据持久正确性扫描（glm-scan-data）

- 冻结基线：主仓 HEAD **88522b4ef**（只读，主仓零写入；复现全部在 /tmp 临时目录）
- 复现工件：`/tmp/audit_r/round-28/repro_lat3.ts`（R1–R7，tsx 直跑 src）、`/tmp/audit_r/round-28/repro_async.mts`（异步流式 loader 侧证）、`/tmp/audit_r/round-28/lat4_realfile_projection.py`（真实会话投影）
- 运行注记：/tmp/audit_r/round-28 在收口前被外部清空过一次（同目录其它车道工件一并消失）；本目录所有脚本已从内核态重建并**重跑验证**，数字以重跑为准（首轮数字量级一致：dangling 1,223/1,357/1,359）。
- 纪律执行：单命令 ≤60s；复现全部 `env -u RLM_* -u PRIME_AGENT_* -u PI_*`；未触碰 daemon（无 shutdown/doctor/ps -k 任何变体）；与 docs/fork/audits/decisions.jsonl（237 条）全量关键词去重（§0）
- 环境注：当前运行中的 daemon 是 **LAT-3 落地前的 bundle**（活体母会话 18,223 条 child_usage_attributed 中单 target 连续 273 行、无任何合并行——合并语义下不可能出现），故 LAT-3 相关洞在 daemon 重启进新版后开始真实暴露。

## 0. 去重结论

- **F1 = LAT-4（decisions.jsonl 已有，status=fixing，P1）的触发面扩展，不另开新条**：round-28 0902 终审簇①只钉了"窗口内 leaf 移动"两个变体（rewind ①-B / 压缩 ①-C），并断言"窗口内不发生 leaf 移动时两者只是『跳过被合并 id』的良性拼接"。本文红证推翻该断言：**并行子代理窗口交织**与**窗口间插入即落盘条目**两个无 leaf 移动的常态触发同样断链，且**优雅 flush 救不回**；0902 提的最小修法（leaf 移动点冲刷）对 F1 无效（§1.5）。建议 LAT-4 修复面按本文扩，严重度考虑升 P0。
- F2 是对 LAT-3 自报数字（≤32 delta）的核证，非新条。
- F3/F4/F5/F6 与 237 条全量比对无重合（最近邻且机理不同：C-1＝ftruncate 并发竞态已修 b95da897b；R1＝leaf 位置只活内存已修 0d9fba468；FORK-MARKER/ACCT-SCAN-ORDER/K3X-3 已修；BF-1/BF-3＝形状闸/行数口径；LAT-3/LAT-4＝膨胀与链拼接本体）。建议新开 DAT-1..DAT-4。

## 1. F1（P0，并入 LAT-4）：LAT-3 合并写在**无 leaf 移动、优雅 flush** 下也打断 parentId 链 ⇒ 重载后对话上下文静默截断

**命题**：合并行 `parentId=firstParentId`（窗口首条未落盘 merge 的 parentId）只在"纯单 target 连续流、窗口内无任何其他条目"时是良性拼接。只要 (a) 两个 target 的归并窗口交织（并行子代理），或 (b) 任一**立即落盘**条目（message/custom/git_state/session_state）落在窗口内两条 deferred merge 之间，磁盘上就会出现 `parentId` 指向**从未落盘的 merge id** 的行；重载后 `byId.get(parentId)` 失败，`buildSessionContext` 回溯 walk 在第一个断链处停止 ⇒ 从 leaf 往前的整段历史静默退出模型上下文。

**severity**：P0（触发面＝本仓并行子代理常态；后果＝重启/attach 后上下文静默截断，文件表面无异常）。

**file:line**（HEAD 88522b4ef）：
- `packages/coding-agent/src/core/session-manager.ts:2579` — `if (pending.merges === 0) pending.firstParentId = entry.parentId;`（首条 deferred merge 一次性捕获，此后窗口内插入任何条目都不再更新）
- `:2608-2609` — 冲刷行 `id: pending.lastId, parentId: pending.firstParentId`
- `:800-807` — `buildSessionContext` 回溯：`current = current.parentId ? byId.get(current.parentId) : undefined`（断链即停，无回退）
- 写入点 `packages/coding-agent/src/core/agent-session.ts:14382`（每条子 assistant 消息一行；并行子代理 ⇒ 交织）

**逐字证据**（被本文红证推翻的两处"良性"断言）：
- 0902 终审（原 /tmp/audit_r/round-28/0902-final.md §1.3，该文件已被外部清理清除，引文取自本轮读取）：
  > 窗口内不发生 leaf 移动时两者只是"跳过被合并 id"的良性拼接（LAT-3 报告已如实披露）
- LAT-3 实施报告 /tmp/audit_r/round-27/impl-lat3.md：
  > 冲刷行 childUsage=窗口 delta 之和、aggregateUsage=最新、**链拼接**（id=窗口末条 merge 的 id，parentId=窗口首条未落盘 merge 的 parentId）⇒ 重载后链与折叠完全成立

**红证（可复现）**：
- R1（两 target 交织 40×2 次 merge，然后 `flushChildUsageAttributions()` 优雅收口——与 agent-session.ts:14549 的 finally 等价）：
  - live 链完好（dangling=0）；重载后 **dangling=2**（两条合并行 parentId 指向另一 target 窗口中部 id）；**上下文消息数 live 2 → 重载 0**。
  - 异步流式 loader（daemon 大文件路径 `loadEntriesFromFileAsync(streamThresholdBytes:0)`）同样 dangling=2、ctx messages=0（repro_async.mts）。
- R2（单 target：首条即写 → 第 2 条 deferred → **插入一条 user message（立即落盘）** → 第 3 条 deferred → 模拟 SIGKILL 不 flush）：重载后该 message 行 parentId dangling（指向从未落盘的 merge id）；上下文消息 live 2 → 重载 1（target assistant 消息正文**在盘上**但链不可达）。
- **正控（R3）**：同样形状但每次 attribution 后立即 flush（退化为逐条落盘）⇒ dangling=0、上下文 live==重载——检出方法有效且回归由合并引入。

**真实负载投影（lat4_realfile_projection.py，重放 LAT-3 合并算法到活体母会话 01a09ee1-…14ce4.jsonl）**：输入 22,392 行 / 18,223 条 attribution / 118 targets / 相邻行 target 切换 8,562 次 / message 2,501 + custom 1,228 + custom_message 252 + git_state 171 行与 attribution 交织：
| 场景 | 落盘行数 | dangling parentId | 其中 message 行 |
|---|---|---|---|
| A：SIGKILL，窗口未满即死 | 4,287 | **1,251** | **1,048** |
| B：SIGKILL，含 32 条自动冲刷 | 4,795 | **1,384** | 1,013 |
| C：优雅收口（等价 child-run finally 全 flush） | 4,909 | **1,386** | 983 |

即：**即使全程优雅收口，这份真实会话在 LAT-3 下重载也有 1,386 个断链引用、983 条 message 行退出链可达集**。

**影响**：重启/attach 后模型上下文从 leaf 回溯到第一个断链即止——表现为"重启后上下文突然变短、模型失忆"，token 用量骤降但零报错；`getBranch`/`getLatestCompactionEntry` 同链判定，压缩条目可同时被绕过（①-C 的同后果、不同入口）。对话正文**行**都在盘上（R2 `replyOnDisk/targetOnDisk=true`），LAT-3 死因清单"对话正文不受影响"只在原始行层面成立，在上下文重建层面**不成立**。

**修法方向（并入 LAT-4，宽于 0902 的"leaf 移动点冲刷"）**：
1. 任何**立即落盘**条目 append 前先 `flushChildUsageAttributions()`（链边界事件冲刷，掐死"磁盘 parentId ≠ 内存 parentId"自由度）；
2. 同一时刻只允许一个 target 的窗口开着（第二个 target 首条 merge 到来时先冲掉现存窗口）；
3. 回归护栏：R1 断言（交织+优雅 flush 后"重载 entries 的 parentId 全可解析 && buildSessionContext 消息数==live"）进 lat3 常驻测试——现有 `lat3-transcript-bloat-coalesce.test.ts` 用例 2 有交织但**没做链完整性断言**（链断言只在用例 1 纯单 target），正是漏检原因。

**可复现**：`cd /Users/a1/Desktop/ai/prime-agent && env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_CHILD_ID -u RLM_MAX_DEPTH -u PRIME_AGENT_SESSION_DIR -u PI_API_KEY -u PRIME_AGENT_DIR node_modules/.bin/tsx /tmp/audit_r/round-28/repro_lat3.ts`（R1 两行 FAIL 即红）；`node_modules/.bin/tsx /tmp/audit_r/round-28/repro_async.mts`；`python3 /tmp/audit_r/round-28/lat4_realfile_projection.py`。

**confidence**：高（同步+异步双 loader 复现、正控在位、真实负载量化、机理与 LAT-4 同根但触发面更宽且已证伪"无 leaf 移动即良性"）。

## 2. F2（核证 LAT-3 自报数字）：崩溃丢失上界＝每 target ≤31 条 deferred delta

- 常量 `session-manager.ts:82-83`：`CHILD_USAGE_ATTRIBUTION_COALESCE_MAX_MERGES = 32` / `MAX_AGE_MS = 120_000`；冲刷判定在 `merges += 1` 之后（:2585-2591）⇒ 静止时刻 `pending.merges ≤ 31`。LAT-3 死因清单"≤32 条 usage delta"保守方向正确（实界 31）。
- 红证（R4）：500 次 merge → 盘上 16 行（1 首条 + 15 满窗），deferred 丢失 19（尾窗未满），`target.message.usage` 聚合漂移 19 input token。单 target 纯流**只少记用量**（静默、有界），对话正文行不受影响。
- 两个放大器：(1) 全仓 `flushChildUsageAttributions` **只有一个调用点**（agent-session.ts:14549，child-run finally；grep 证据）——SessionManager 的 dispose/退出钩子不冲，不走该 finally 的退出路径同样丢；(2) 叠加 F1 后真实损失远大于台账少记（断链截断）。
- **confidence**：高。

## 3. F3 / DAT-1（P2）：只丢换行符的完整记录被当脏行丢弃/截掉

**命题**：append 是单次 `writeFileSync(fd, line+"\n")`（private-files.ts:378-403，单次 write 在 :402）。写被撕在**最后一个字节**（ENOSPC 只差 1 字节 / kill 落在 write 尾）时，盘上是一条**内容完整、只缺终止符**的 JSON 记录。现有恢复只认 header：`parseUnterminatedHeader`（session-manager.ts:941-955）要求 `type === "session"`；非 header 的这种尾巴被两条 loader 直接跳过（`:1016 if (end === -1) break`；异步 `:1152 if (!fileLine.terminated) break`，仅 line-1 header 例外 :1156-1159），写属主修复 `repairOwnedSessionFile → repairTruncatedTrailingLine`（file-lines.ts:247-297）则 **ftruncate 整条删掉**。

**severity**：P2（触发窄：撕在末字节；后果：丢一条完整 message/状态记录，静默）。

**红证（R5b）**：append 一条完整 `session_state` 行（无 `\n`）→ `loadEntriesFromFile` 3→3（记录被丢）；`repairOwnedSessionFile` 后仍 3（被截掉）。**正控**：同形状 `type==="session"` 的首行 header 被 `completeTrailingRecordNewline` 补回换行（既有测试 unterminated-header-identity.test.ts）——"补换行"恢复路径存在且有效，只是没推广到非 header 记录。

**修法**：`completeTrailingRecordNewline` 的整记录判定从 header 推广为"parsesAsJson 且 unindexableEntryReason===undefined 的任意 entry"（仅写属主路径补）。

**confidence**：高。

## 4. F4 / DAT-2（P2）：不修复就 open+append 的调用点把"撕尾行 + 新行"一起变不可读

**命题**：`setSessionFile` 只对 header 形状尾巴补换行（:2041-2042），非 header 撕尾留在原处；随后 `_persist → appendPrivateFile` 把新行粘在无换行尾巴后 ⇒ 粘合行从此每次 load 都 JSON.parse 失败被静默跳过——**尾巴记录与新记录双双从所有读方消失**；后续任一 `_rewriteFile` 用已缺失的内存态整写文件，损失固化。

**file:line**（open 后即写、**未**先 `repairOwnedSessionFile` 的点）：
- `packages/coding-agent/src/core/agent-session-runtime.ts:508`（resume）、`:657/:662`（fork 源/目标）、`:766`（import）
- `packages/coding-agent/src/modes/agent-connection/in-process-agent-connection.ts:614`（`SessionManager.open(sessionPath).appendSessionInfo(trimmedName)`）
- 对照（先修复再 open，正确）：`main.ts:1844`、`daemon-mode.ts:1827/:3128`、`daemon-catalog-process.ts:172`

**红证（R5c）**：手工去掉末行 `\n` → `SessionManager.open` → `appendMessage("second")` ⇒ load 条数 3→2→1（"first" 与 "second" 都消失，粘合行原文见输出 rawTail）。**正控**：同形状先 `repairOwnedSessionFile` 再 append ⇒ 只损失尾巴本身，无二次扩散。

**修法**：`setSessionFile` 写属主路径对非 header 撕尾也处理（截掉或补全二选一，但要做）；或统一给上述四个 open 点补 `repairOwnedSessionFile`。

**confidence**：高。

## 5. F5 / DAT-3（P3）：SIGKILL 在原子写中途 ⇒ sessions 目录临时文件永久泄漏（无清扫）

**命题**：`writePrivateFileAtomic(Lines)` 临时名 `.{basename}.{pid}.{uuid}.tmp`（private-files.ts:313/343）落**目标同目录**；`finally` 的 `rmSync` 只在进程活着时执行。SIGKILL 在 rewrite 中途 ⇒ 临时文件（内容＝整份转录）永久留在 sessions 目录。

**证据**：
- 正控 A（仓内同类已知且有清扫）：legacy-auth-files.ts:20-22 逐字——"the atomic writer's crash leftovers, whose temp names are `.<name>.<pid>.<uuid>.tmp`"；orphan journal 自带 tmp 清扫（orphan-process-journal.ts:464）。
- 正控 B（检出法有效）：`ls ~/.prime/agent/sessions/*.tmp` → 0 个（当前 daemon 未进 LAT-3、近期无 crash，与"一旦发生即永久"不矛盾）。
- 负结论（带正控）：sessions/settings/telemetry/cron 目录**没有**等价清扫——`grep -rn '\.tmp' packages/coding-agent/src` 命中仅 auth/journal/edit 工具/retention（retention 的 tmpdir 是 OS tmpdir，非 sessions 目录）。

**severity**：P3（泄漏；0600 权限但体积可到百 MB 级）。

**confidence**：高（机理确定；活体 0 个只说明尚未发生）。

## 6. F6 / DAT-4（P3）："承诺 durable"路径的非原子直写与 fsync 缺口清单

- **update-restart manifest（最实）**：`daemon-mode.ts:6515` `writeFileSync(path, \`${JSON.stringify(manifest)}\n\`)` **直写终路径**（无 tmp/rename/fsync）；读方 `daemon-supervisor.ts:8459-8472` catch → `undefined`。而 prompt-admission.ts:24 逐字承诺："queued work must survive into the restart manifest"。撕写 ⇒ 承诺静默落空（重启后队列工作全丢、零报错）。修法：换 `writePrivateFileAtomic`。（无运行时 kill 注入复现——按纪律不做，标 unverified-runtime，代码路径级证据。）
- settings-manager.ts:811-812 / model-registry.ts:1116-1117 / cron-jobs.ts:2000-2008：tmp+rename 但**无 fsync**——SIGKILL 安全（rename 原子、页缓存），掉电 rename 可能未提交（旧文件保留＝陈旧但安全方向）。
- `writePrivateFileAtomic(Lines)`：有文件 fsync（:325/:367）、**无父目录 fsync**——SIGKILL 无关；掉电 rename 窗口（旧文件方向，安全）。auth.json 走此路径 ✓。
- `appendPrivateFile`：无 fsync（设计内）——SIGKILL 安全，掉电丢尾部若干行（有界）。
- snapshot-transcript-cache.ts:367/374 直写终路径，但读方 decode 失败自降级 "reload"（:227-229 catch → undefined）——自愈型缓存，**不算洞**（列出以完整覆盖"直写终路径"负结论；正控＝降级路径存在）。
- **负结论（带正控）**：除上述清单外，全仓 52 个 `writeFileSync/writeFile` 调用点中无其他"durable 状态直写终路径"（pid/lock/版本标记/遥测首写 wx/缓存均非持久账本；正控＝本清单逐点核过上下文）。

**confidence**：高（逐点读码；manifest 项 unverified-runtime）。

## 7. ③ 回放等价差异清单（设计内丢失 vs 静默错账）

**设计内（有注释/测试背书）**：
1. 首个 assistant 消息前的条目内存态（R7 红证：user prompt 落盘前文件甚至不存在；`_persist` no-assistant 闸 :2364-2374，session_state/session_info/leaf_position 例外即写）——crash 丢"从未被回答的草稿"。
2. 每 target ≤31 条 usage delta 窗口滞后（F2）。
3. `agent_status` 去重基线从文件重建（_buildIndex:2165-2168）——丢末条 status 只导致下条重写一行，无害。
4. 增量扫描游标（readSessionInfo resume point）重启归零 → 全量重扫，纯性能。
5. `_persist` 失败自愈：append 抛错 → `flushed=false` → 下次 persist 整文件重写补洞（:2385-2395）。

**静默错账（本文新钉）**：F1 断链截断（最重）；F3/F4 完整记录被丢/粘合双丢；F6 manifest 承诺落空；另有一项口径差：`applyChildUsageAttributions`（:748-762）重载后把 `target.message.usage` 覆写为**最后落盘**的 aggregate——与崩溃前内存值相差 ≤31 delta（有界、静默；重启后 /context 与 stats 显示偏小花费）。

## 8. ④ 压缩/回滚 × LAT-3 合并行

1. **`_appendEntryWithRollback`（:2831-2856）精度够但反规范化**：回滚＝pop 内存末条 + `flushNow → _rewriteFile`，而 `_rewriteFile`（:2193-2204）清 pending 并**把每条内存 entry 各自物化成一行**——正确（自愈），代价是触发即把全部 deferred merge 展开回一行一条（该路径只挂 custom/customMessage append，频率低；供 LAT-4 修复方知道"回滚=展开"副作用）。
2. **"回滚到合并行内部"盘上不可能**：窗口中部 merge id 只存在于内存，重载后不存在——`branch()` 对它抛 `Entry not found`（:3316-3318，显式失败，好）；唯一静默路径是 `leaf_position.targetId` 指向 deferred merge id 时 `_buildIndex` unknown-target 回退（:2173-2177，"最后一行胜出"）——位置静默漂移。与 ①-C（压缩落窗口内）同根，修法同 F1。
3. 0902 ①-C（压缩条目重载被绕过、已压缩历史整卷复活）本文不重复验证；指出 F1 给它提供了**第二个无需 rewind 的入口**：断链使 compaction 条目退出活动分支，效果等价。

## 9. 结论

- **必须随 LAT-4 一起修**：F1——无 leaf 移动的两个常态触发（并行子代理交织 / 窗口内插入即落盘条目）+ 优雅 flush 不救 + 真实负载投影（优雅收口仍 1,386 断链 / 983 message 行退出链）；0902 的"leaf 移动点冲刷"最小修法对 F1 无效，需链边界冲刷或单窗口约束。建议 LAT-4 升 P0 或并列。
- 独立新条建议：DAT-1（F3）、DAT-2（F4）、DAT-3（F5）、DAT-4（F6 manifest）。
- 核证闭合：LAT-3 自报"≤32 delta"实界 31 ✓；"对话正文不受影响"在行层面成立、在上下文重建层面**不成立**（F1）。
- 工件均在 /tmp/audit_r/round-28/（repro_lat3.ts / repro_async.mts / lat4_realfile_projection.py / 心跳），单命令可复跑；/tmp/audit_r/round-28 曾被外部清空一次，已重建并重验。
