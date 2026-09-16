# round-29 / DAT-1..4 数据持久线修复（dat-fixes）

- 冻结基线：主仓 HEAD **12b364b77e1028a7356f18f54762258f77f62fe1**（只读）；工作树 `/tmp/audit_r/round-29/wt_dat`（分支 `r29/dat-fixes`，symlink node_modules），交付提交 **199684aa1**（14 文件，+680/-20，含 changelog fragment `dat1-4-durable-session-writes.md`）
- 依据：round-28 glm-scan-data.md F3/F4/F5/F6（DAT-1..4）。纪律执行：单命令 ≤60s、分批 ≤3 文件、先红后绿、`env -u RLM_* -u PRIME_AGENT_* -u PI_*`、node 直调 vitest、`npm run check` 全量 EXIT=0（biome --error-on-warnings + tsgo --noEmit + 门禁）、git add 逐文件核对 staged（无他人文件）、未触碰 daemon/doctor。

## DAT-1（F3）：非 header 完整记录只丢换行 → 补换行恢复

- **修**：`session-manager.ts` `completeTrailingRecordNewline` 从"仅 header 形状"推广为"任意整记录"（新 `isCompleteUnterminatedEntryLine`＝parsesAsJson 且 `unindexableEntryReason===undefined`）；实现改为只读末 64KiB 窗口定位末行（fd+offset 读，不再整文件读入）。`repairOwnedSessionFile` 与 `setSessionFile`（persist 路径）两条写属主路径都因此恢复换行；真撕（半条 JSON）仍走 ftruncate。
- **红（改前，src 已 stash 复跑）**：`test/session-manager/dat1-complete-record-newline-recovery.test.ts` 两条主断言红——repair 后 load 仍 3 条（记录被 ftruncate）、open 后盘上仍无换行；对照（真撕仍删）绿。
- **绿**：3/3 过；既有 `torn-tail-repair`（4）、`unterminated-header-identity`（7）、`large-final-line-tail-check` 全绿（header 恒等行为不变）。

## DAT-2（F4）：open+append 前先修复

- **修**（照 main.ts:1844 / daemon-mode:1827 先例）：`agent-session-runtime.ts` 4 点（switchSession:508、fork 源/目标、import 目的）+ `in-process-agent-connection.ts` renameSavedSession 全部在 open 前 `repairOwnedSessionFile`。**范围外同型点 1 个顺带修**：`daemon-mode.ts` rename_saved_session 的盲 append（4298，审计清单外，同文件两条先例之间）。
- **红（改前）**：`test/suite/dat2-repair-before-append.test.ts` 2 红——① switchSession+prompt 后撕尾 assistant 记录静默消失（loader 丢记录＋后续重写固化内存态）；② renameSavedSession 粘合：撕尾 assistant 行与 session_info 行双双不可读（=审计 R5c 的 3→2→1 形状）。mid-line 撕与对照绿（改前即绿，属护栏）。
- **绿**：4/4 过；`agent-session-runtime-replacement`（7）全绿（含 import 碰撞、失败回滚）。

## DAT-3（F5）：sessions 目录残留 tmp 启动清扫

- **修**：`migrations.ts` 新增 `sweepStaleSessionDirTemps()`，`runMigrations()` 调用（=auth 家族清扫同一挂点）；匹配 `^\.…\.tmp$`（原子写残留家族）＋ **60s mtime 龄门**（照 orphan-journal `cleanStaleCompactionTemps` 先例，不删活写者 young tmp）。
- **红（改前）**：`test/dat3-session-dir-temp-sweep.test.ts` 预置 stale tmp 断言被清——红（残留仍在）；**绿**：3/3（young tmp 保留、非 tmp 文件不动两个对照在位）。

## DAT-4（F6）：manifest 原子写＋fsync 补口

- **修**：daemon-mode `writeUpdateRestartManifest`（原 :6515 直写终路径）改走新叶子模块 `modes/daemon/update-restart-manifest.ts` → `writePrivateFileAtomic`（temp+fsync+rename,0600；supervisor 侧 8645 本就 tmp+rename）。`settings-manager.ts` withLock 与 `model-registry.ts` prime-auth 缓存：temp 写后 `fsyncSync` 再 rename（照 writePrivateFileAtomic/cron 先例）。**cron-jobs 的 fsync 在 HEAD 已存在**（审计冻结 88522b4ef 之后别的车道已落），本轮未重复改。
- **红（改前）**：`test/dat4-manifest-atomic-write.test.ts` 撕写（mock writeFileSync 半写后抛）断言终路径保持旧完整 manifest——模块缺失级红（改前无此导出）；行为契约（半写不落终路径、无 tmp 残留）在位。`test/dat4-settings-fsync-order.test.ts`（fsync 先于 rename 的调用序）改前红（无任何 fsync）。
- **绿**：2/2＋1/1 过；`worker-recovery-journal-fsync`、`keybindings-migration` 全绿。

## 验证矩阵

| 批次 | 文件 | 改前 | 改后 |
|---|---|---|---|
| 1 | dat1 + dat4-manifest + dat4-settings | 2红+2文件级红+对照修正 | 6/6 绿 |
| 2 | dat2 + dat3 | 2红+1红 | 7/7 绿 |
| 回归 | torn-tail-repair / unterminated-header-identity / large-final-line-tail-check | — | 17/17 绿 |
| 回归 | agent-session-runtime-replacement / keybindings-migration / worker-recovery-journal-fsync | — | 17/17 绿 |
| 全量 | `npm run check`（biome+tsgo+门禁） | — | EXIT=0 |

## 诚实披露

- DAT-4 manifest 的红是"模块缺失"级（直写代码在 daemon-mode 私有方法里不可单测）；撕写契约测试验证的是抽取后的生产写入路径，直写形状的 3→半份行为由 mock 形状在测试内等价复现，未在改前树上直接跑过私有方法（unverified-runtime 同审计口径）。
- DAT-2 的 switchSession 改前实红形状与审计 R5c 略不同：不是粘合而是"撕尾记录被 loader 丢＋后续整文件重写固化丢失"（粘合在 rename 路径实测复现）；两者同根（open 前未修复），同修。
- `runMigrations` 只覆盖 CLI 启动路径；daemon supervisor 自身进程未核对该挂点（worker 由 main 入口进入，应覆盖；未逐一验证）。
