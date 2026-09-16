# r38 impl-life：LIFE-1/2/3 修复（DS 生命周期线落地）

- 基线：主仓冻结 `a3d66ee6842`（审计报告 lifecycle.md 的 d06630a 为其父链，差异仅 docs）；工作树 `/tmp/r38-life-work`（symlink node_modules），仓零写入主仓。
- 交付提交：**`c87779e91`**（14 files，+606/-40）；pre-commit 全量 `npm run check` 通过；pristine-tree（git archive + tsgo）EXIT=0。
- 测试入口（泄露变量已 unset，直接 node 调 vitest）：
  `env -u RLM_DEPTH -u RLM_SESSION_DIR ... node ../../node_modules/vitest/dist/cli.js --run test/<file>`（packages/coding-agent 下）。

## LIFE-1（L1：活边指向已删目录，225 条永久活边）

1. **①根删除写墓碑**：`tombstoneSavedSessionDelete()`（rlm-ledger.ts）对 positively-top-level 目标不再直接早退——先用 raw 视图（`edges(true)` 过滤非 deleted）找 `parent == deletedPath` 的直接子边，逐条 `appendDelete(reason:"parent-teardown")`（该 reason 类型一直在、此前零写入者），时序照 daemon-mode.ts:1242 删子代理先例：墓碑在 `deleteSessionFile` 的递归 rm **之前**。整段 **best-effort try/catch**：根自身删除不因 ledger 不可读而失败（原契约"top-level 删除不碰 ledger"的弹性保留，仅契约名从"不碰"改为"尽力写"——daemon-agent-roster 一条测试标题随之更名，正文断言不变且仍绿）。
2. **②读侧惰性对账**：`edges()` 默认视图新增 `dropEdgesWithGoneChildDirsUnlocked()`——按 canonical child path 取 `dirname` 去重后并发 stat（复用 LEDGER_STAT_CONCURRENCY 批式），目录已删即从活边视图剔除；注释写明"判据=目录已删（root teardown 留下的形态）、durable 记录不变、edges(true) 仍可见、清理重试仍可补墓碑"。`includeDeleted=true`（写路径/清理重试）**不做**对账。
- 红测（改前必红实证）：`rlm-ledger-root-teardown.test.ts`
  - "tombstones the deleted root's child edges so the live edge count falls back"：真删根（tombstoneSavedSessionDelete + deleteSessionFile）后 `edges()` 长度 1→**0**（改前=1，红），且 ledger 落盘含 `"parent-teardown"`；正控=目录在时活边长度 1。
  - "drops edges whose child session directory is gone, read-side, without rewriting the ledger"：外部 rm 子目录（无墓碑的历史债形态）后 `edges()` 只剩 survivor（改前返回两条，红）；正控=目录在的 survivor 边照常；`edges(true)` 仍 2 条（只读判定不动持久记录）。

## LIFE-2（L3：默认关的回收器 + 53 个 no-tombstone 死区）

1. **①默认 0→30**：settings-manager 新增 `DEFAULT_RETENTION_CHILD_TRANSCRIPT_DAYS = 30`（量级照 deletedSessionResidue 先例档），resolve 处、接口注释、child-transcripts.ts 头注、docs/settings.md 同步改写：deleted 子转录按 30 天回收，活子代理由 ledger 活边保护（round-09 ruling 1 的顾虑从"默认关"改为"判据强制"）。
2. **②死区判据**：`RetentionLiveReferences` 新增 `ledgerScanned`（sweep.ts 从 `scanRlmLedgerDirectory().scanned` 透传）；`artifact-dirs.ts` 的 `protectionReason` 在 `requireDeletionEvidence` 分支末尾：tombstone/ledgerDelete 均无时，若 `ledgerScanned === true`（"无活边"是知识而非探测失败；resident/lease/活边/transcript/快照引用均在更上方已查）→ 判可回收，交给类年龄窗（deletedSessionResidueDays，默认 7d）守门；ledger 未扫到则维持 SKIP.noTombstone（"证不了活 ≠ 已死"）。
3. **附带加固（防默认开后的新风险）**：child-transcripts 类在 `ledgerScanned !== true` 时对每条 transcript 记 `unverifiable:ledger-scan` 并保留——否则默认 30 天 + ledger 读失败会把"未知"当"无活边"，把活子代理转录按龄删掉（types.ts 安全律的直接应用）。
- 红测（改前必红实证）：`retention-life-reclaim.test.ts`（5 条）
  - "reclaims a deleted child's transcript after the default window instead of staying disabled"：预置 deleted（spawn+delete）子转录 aged 31d，默认 settings sweep 断言回收 + 类 disabled=false（改前：disabled=true 永不回收，红）。
  - "keeps every transcript when the ledger scan failed"：无 ledger 文件时全部保留并报 `unverifiable:ledger-scan`（改前报 young:30d，红）。
  - "reclaims an old unreferenced directory without a tombstone once the ledger is scanned"：无墓碑、无转录、无边的旧目录被 residue 类回收（改前 SKIP.no-tombstone，红）；**正控（r34 裁决①边界）**：同布局下带活 spawn 边的目录不动，skip=`reference:ledger-live`。
  - 正控×2（改前改后均绿）：活边子转录保留（`reference:ledger-live`）；ledger 未扫时死区保持 `no-tombstone`。

## LIFE-3（L4：display 缓存 (size,mtimeMs) 重校验的跨进程陈旧读）

- `rlm-subagent-display.ts`：缓存条目新增 `fingerprint`；命中条件从"stat 相等"升级为"stat 相等 **且** 首/尾各 4096 字节的内容指纹（sha256）相等"。命中路径只做两次 bounded 读+hash（无全文件读、无 parse）；失配（或探测失败）落穿到全量读并以内容指纹入库。注释写明：display 文件为单行 JSON（实测 mean 6.5KB/max 21.9KB），首尾窗覆盖同尺寸重写的常见全部变更；>8KB 文件的中段是已知盲区（任务选定的最小改动边界）。`"running"`↔`"deleted"` 同为 7 字符的天然同尺寸翻转即红测场景。
- 红测：`rlm-subagent-display.test.ts` 新增 "re-reads a cross-process rewrite whose stat cannot be distinguished (r38 LIFE-3)"：进程外写者（裸 writeFileSync + utimes 钉回同一整秒 mtime）改 status running→deleted，断言读到 deleted（改前返回陈旧 running，红）；size/mtime 相等有显式断言。
- **配套测试改造（必须披露）**：`rlm-subagent-display-cache-bounds.test.ts` 的 "still serves a repeat read of the same dir from cache (hit-rate control)" 原以"同 stat 重写仍返回旧值"**作为缓存命中的探针**——该断言恰是 LIFE-3 要修的陈旧行为。探针改为"二次读返回同一对象引用"（`resolves.toBe(first)`，命中=原对象，重读=新分配），并新增"同 stat 跨进程重写现在被内容指纹识破、读到新值"断言；"可区分重写仍被拾取"正控保留。测试意图（证明命中存在）保留，探针手段更换。

## 测试与检查账

| 批次 | 文件 | 结果 |
|---|---|---|
| 红（改前） | rlm-ledger-root-teardown(新) + retention-life-reclaim(新) | 5 failed / 2 passed（红=目标断言，绿=正控） |
| 红（改前） | rlm-subagent-display + rlm-subagent-display-cache-bounds | 2 failed / 9 passed（同上口径） |
| 绿（改后） | 同上四文件 | 18 passed / 18 |
| 回归 A | rlm-ledger + rlm-ledger-passive-scan-concurrency + daemon-agent-roster | 59 passed（含 1 条测试标题按新契约更名，见 LIFE-1①） |
| 回归 B | retention-sweep + retention-tmp-and-logs + kernel-snapshot-reference-states | 54 passed |
| 回归 C | session-artifacts-delete + session-artifacts-delete-header-id + daemon-supervisor-lazy-subagents | 25 passed |
| 回归 D | acp-rlm-subagents + subagent-summary-line + session-artifact-tombstone-cache-bounds | 20 passed |
| 静态 | biome（触及文件，--error-on-warnings）EXIT 0；全仓 `npm run check`（pre-commit 同款）EXIT 0；pristine-tree tsgo EXIT 0 | — |

红→绿证据日志：`/tmp/r38-life-work/_red2.log`、`_red3.log`、`_green1.log`、`_green2.log`、`_regA.log`…`_regD.log`（工作树保留）。

## 边界与残余（未声称已修）

- LIFE-1①只墓碑**直接**子边；孙代边靠②读侧剔除（其目录同样随树消失），ledger 持久层孙代无 parent-teardown 记录——真机 225 条全部是直接子边形态，残余为理论形态。
- `in-process-agent-connection.ts:625 deleteSavedSession` 直调 `deleteSessionFile`、不经 `tombstoneSavedSessionDelete`（ACP/embedded 路径）——本轮未动，与主删除路径仍不一致（记为残余，非本任务范围）。
- retention 的 `ledgerLiveChildIds` 仍来自 raw 文件重放（`scanRlmLedgerDirectory`），不做 stat 对账——**故意保留**：r34 裁决①的"活引用目录不动"边界不受 LIFE-1②影响。
- LIFE-3 指纹对 >8KB 单行文件的中段同 stat 重写不设防（任务口径"首尾行哈希"的已知盲区）；显示文件实测 max 21.9KB。
- 真机 1.22GB 存量（916 个 deleted 目录）需实际 sweep 运行才消化；本修复让默认判据可达，未做一次性迁移。
- daemon-agent-roster 一条测试标题从 "without touching the spawn ledger" 更名为 "even when the spawn ledger is unreadable"（契约按父任务指令变更，正文断言未动）。
