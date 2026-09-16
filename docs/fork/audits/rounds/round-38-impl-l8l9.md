# r38 impl — L8D-1/L8D-2/L9F-1 + K3L-1/K3L-2 修复交付

- 工作树：`/tmp/audit_r/round-38/l8l9-work`（detached，基线=主仓冻结 HEAD `23119749df8a`，node_modules/.venv 均符号链接，主仓零写入）
- 交付提交：`14a4e8811`（16 files，+701/-25；pre-commit hook 过；`npm run check` EXIT=0 两次，覆盖全部 TS 改动）
- 测试纪律：先红后绿（红=改前真跑失败）；每批 ≤3 文件；vitest 用 `node ../../node_modules/vitest/dist/cli.js` 直跑；Python 用 runtime 自有 `.venv/bin/python -m unittest`（`uv run pytest` 会拾到 homebrew pytest 无 dill，故走项目环境）；跑测试 `env -u RLM_DEPTH -u RLM_SESSION_DIR -u PRIME_AGENT_SESSION_DIR -u PI_SESSION_DIR -u RLM_CHILD_NAME -u RLM_HARNESS_DIR`。

## L8D-1（P1）版本闸 fail-open → fail-closed ✅
- 改动：`prime-agent-runtime/src/rlm/repl.py` `_version_mismatch_reason`：`python_version is None` → 返回 `"python version unknown: the snapshot records no writing interpreter version"`；不可解析版本串 → `"python version unknown: ... unparseable"`。隔离只作用于 `_carries_foreign_code` 命中的名字（函数/类），普通数据照常恢复。
- 宿主侧：`state-snapshot.ts` `readSnapshotManifest` 的 "Tolerant by design" 注释改口为 "Reading stays tolerant … The tolerance is no longer the whole story downstream"（读仍宽容、下游闸 fail-closed），`SnapshotManifestFacts.pythonVersion` 文档同步。repl-manager 转发逻辑不变（无版本即不送字段 → 内核隔离）。
- 红测（改前真红）：`test_l8d_impl.py::test_l8d1_missing_version_quarantines_functions_and_classes`（改前 `restored=['K','data','helper']`，断言失败）；`test_l8d1_pid_only_unknown_version_record_is_not_treated_as_known`（改前报 mismatch 措辞）。正控：带当前版本全量恢复、可调用（`test_l8d1_matching_version_restores_functions`）。
- 既有测试语义迁移（合法场景受损面，见下）：`test_r35_impl.py::test_rt3_missing_version_field_keeps_current_behaviour` 改名 `…_quarantines_code_objects`（断言进 failed+NameError）；`test_rt5_impl.py::_restore` 与 `test_repl.py::test_snapshot_restore_roundtrip` 补发 manifest 里的 `python_version`（它们考的是 RT-5 降级复活/roundtrip 语义，不是版本闸语义）。
- **兼容取舍（明示）**：同解释器但 manifest 无字段/丢失/写坏的旧快照，函数与类现在进 `failed`（报"来源版本未知"）而不再静默复活——模型需显式重验/重定义；普通数据无损。理由：load 侧无法区分"同线字节码"与"跨线字节码"，猜错的代价是内核 SIGSEGV 连死（D1 实测 3.12 payload→EXIT=139）。现网 895 份 manifest 全带 pythonVersion，暴露面集中在 manifest 丢失/写坏与旧 runtime payload。

## L8D-2 venv 代际 hash 加入解释器版本 ✅
- 改动：`bootstrap.ts` `kernelVenvBuildIdentity` JSON 增加 `python: PYTHON_VERSION`（默认参数），`kernelVenvDirForIdentity(base, runtimeIdentity, pythonVersion = PYTHON_VERSION)` 透出可测参数；注释同步（bytecode 只在同 major.minor 线内互换，bump PYTHON_VERSION 必须换代际目录而非原地 rm+重建）。
- 红测（改前真红，esbuild 忽略多余参数故同路径）：`kernel-python-resolution.test.ts` 新 describe——`("3.11") !== ("3.12")` 两目录、同版本同目录、异 runtime 异目录（正控）。
- **部署代价**：身份 JSON 变更 ⇒ 所有机器的现役代际 hash 改变，下次 boot 各建一次新 venv（~30s 一次性），旧代际按 in-use 检查后回收；快照与 venv 代际本无绑定（D3），不受影响。

## L9F-1 外部 owner 死 pid 记录回收 ✅
- 改动：`orphan-process-journal.ts` 新增 `reapForeignOrphanProcessRecords(path, ownerPid, query=getProcessStartId)`：全量解析（不过滤 owner、跳过 owner 自有记录），对"最新 active 且 ownerPid≠owner"的记录判死——pid 不存在（query→undefined）或 startId 已换主（复用）→ 追加一条**同 ownerPid** 的 `active:false` 记录（对一切读者与 compaction 均按 (ownerPid,pid) 最新者语义被压制）；pid 仍活/身份一致/pid-only 且 pid 存在 → 不动。绝不 kill、绝不动 owner 记录（拒收语义不变：拒收防误写、回收防堆积）。
- 接线：`daemon-supervisor.ts` ① `recoverUncertainWorkerOperations`（R3，owner 杀循环后、clear 判定前——retry 保 journal 的臂上生效）② 新私有 `reapFailedWorkerOrphanJournal`（failed-worker reaper 补 reap：杀 owner 侧活 bash 子进程（F2 泄漏口）+ 回收外部死记录，再 `deleteWorkerDescriptor`），`archiveAndReapFailedWorker` 调用。
- 红测（改前真红：`reapForeignOrphanProcessRecords is not a function`）：新文件 `orphan-journal-foreign-reap.test.ts` 2 例——注入 query 覆盖 dead/reused/live/pid-only-活/owner-自有五形态（断言只回收 dead+reused，活与 owner 记录不动，compaction 后仍压制，幂等）；真实 pid 例（活 sleep 不动、kill 退出后回收）。正控=活记录不动。
- 既有回归：`daemon-supervisor-failed-reaper.test.ts -t "archives and removes"` 绿（改动过的 reaper 路径）；`orphan-process-journal(.compaction).test.ts`、`compaction-task-brief-fidelity.test.ts` 27/27 绿。
- **诚实边界**：① failed-worker reaper 的"杀活子进程"半边未加新 harness 红测（既有 reaper 测试重跑绿 + 编译面覆盖；红测按任务规格落在函数级外部死记录回收上）；② 健康 worker 存活期 journal 内的外部死记录堆积只在 recovery/teardown 时被回收，未挂周期清扫（F1 完整面留给后续）。

## K3L-1（P2，父席补派）容器分支缺 type 检查 ✅
- 改动：`repl.py` `_carries_foreign_code` 在容器分支前加 `_is_foreign_code_object(type(value))`（原 else 分支的重复检查上移删除；内建容器该检查 O(1) 恒否）。
- 红测（改前真红）：`test_l8d_impl.py::test_k3l1_namedtuple_instance_is_quarantined_on_mismatch`（改前 `pt` 进 restored，`pt.mag()` 真执行）。正控：同版本 namedtuple 恢复且 `mag()=5.0`；`test_k3g_impl.py` 既有嵌套隔离 4 例仍绿。

## K3L-2（P3，父席补派）sibling 方向入台账 + 跨 worker 丢 fromState ✅
- 改动：① `user-requests.ts` 134 行 child 黑名单 → 白名单：`fromRelationship` 非 `undefined`（用户/CLI 直达）且非 `"parent"`（orchestrator 简报）一律不收（sibling/child/未来值都挡）。② 跨 worker 投递补方向：`daemon-supervisor.ts deliverAgentMessage` 用 `agentFamilyRelationship(familyCatalogEntry(target), familyCatalogEntry(source))`（与 daemon-mode 同参序）算出关系，`worker_deliver_message` 协议新增可选 `fromRelationship` 字段（additive，旧 worker 忽略=原 undefined 行为）；`daemon-mode.ts` handler 透传，`sendAgentSessionMessage` 新增 `fromRelationship` 选项（本地 fromState 在场时仍以其为准）。
- 红测（改前真红）：`compaction-user-requests-child-direction.test.ts` 新 describe 4 例——sibling 注入文本不进台账/不算 user intent/与 parent 简报混收时只留简报；正控=无 relationship 的 CLI steer 照收（防白名单过宽）。
- **诚实边界**：跨 worker 转发链为编译+协议类型级验证，未起双 worker 端到端（supervisor harness 成本超时窗）；同进程路径（fromState 在场）不受影响，既有 `fire-and-forget-protocol`/`agent-message-queued-receipt`/`daemon-orphan-workers` 28/28 绿。

## 测试总账（改后全绿）
- Python：`test_l8d_impl`（7）+ `test_r35_impl`（11）+ `test_k3g_impl`（4）+ `test_rt5_impl`+`test_repl_snapshot_preserve`（13）+ `test_repl`（107）全 OK（runtime 自有 venv，19.7s 最长一批）。
- TS：kernel-python-resolution（10）、compaction-user-requests-child-direction（9）、orphan-journal-foreign-reap（2）、orphan-process-journal(+compaction)+compaction-task-brief-fidelity（27）、failed-reaper 单例、fire-and-forget+queued-receipt+daemon-orphan-workers（28）。
- `npm run check`（tsgo+biome+门）EXIT=0×2。

## 未做/移交
- K3 复核报告里 G1 残余 R1/R2（P4 计数窗口）与本批无关，未动。
- F1 健康活 worker 的周期性外部死记录清扫、F3/F4/F7 无主 journal/candidate 目录清扫类——超本批范围。
- 跨 worker fromRelationship 端到端（双 worker harness）建议下轮补一条。
