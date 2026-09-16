# r35-repl-lifecycle

线①：prime-agent-runtime Python 内核（`src/rlm/repl.py` 1918 行全文读完）REPL 生命周期：
快照重放/指纹/blob 缓存、中断与 rid 生命周期、长会话计数器与恢复通知。
冻结 HEAD：`438d33383605ed22c6111cf05851486d948e9d5f`（只读，本线零写入仓库）。
实验脚本：`/tmp/audit_r/round-35/r35_repl_driver.py`（复刻 `test/test_repl.py:ReplProcess` 的起法，spawn 前剥掉
`RLM_*`/`PRIME_AGENT_*`/`PI_*` 泄露 env）。原始输出见下文各条。

## 结论摘要

- **R35-RL-1（P2，活体复现，新）** 命名空间里只要出现**一个非字符串顶层键**（`globals()[1]=1`），
  此后**每一次** snapshot 请求都以 `AttributeError: 'xxx' object has no attribute 'startswith'` 失败，
  **整个命名空间停止落盘**；而 `list_names`/重放指纹都对该情形做了守卫 ⇒ 与"逐变量尽力而为、
  单个坏值只跳过并上报"的契约相悖。`repl.py:1058-1059`（应比照 `:994`、`:1487`）。
- **R35-RL-2（P3，复核旧条目 A3，仍红）** 下划线开头的顶层名在 HEAD 仍然**全链路零痕迹**：
  不进 `saved`、不进 `manifest.skipped`（⇒ 复活通知的 `notSaved` 也点不到名）、不进 `list_names`，
  而系统提示仍承诺"named variables … remain available"。`decisions.jsonl` 把 A3 标成 fixed
  并挂 `55bae7c50`，但该提交是 session-tree 深度界（与会话树有关），与 A3 无关 ⇒ 旧条目记账错了。
- **R35-RL-3（P4，活体复现，已知设计限制的边界）** 非 final 的重放会返回"ok"但**与实时命名空间不符**：
  后台线程 in-place 改值 + 期间无 cell 执行 ⇒ 重放命中，磁盘仍是旧内容（实测磁盘 `[1]`、实时 `[1,2]`）。
  两个 teardown 路径都带了 `final:true`（实测 final 写盘、非 final 不写盘），残留面只剩"最后一次写不是
  终局 flush"（kill/崩溃）与"宿主或模型信任中途那次重放结果"。
- 负结论（带正控）：`final` 在 TS 侧两个 teardown 路径都设了；`list_names`/重放指纹确有非 str 键守卫；
  中断矩阵 CI 全绿（367 run / 1 error 在本线之外的 `test_mcp.py`）。

## 发现

### R35-RL-1 非字符串顶层键 ⇒ 全部快照请求失败、命名空间整体停止持久化（P2）

- 命题：`_snapshot_state` 的键过滤循环缺 `isinstance(name, str)` 守卫，非 str 键上调用
  `name.startswith("_")` 抛 AttributeError，异常穿透 `_handle_state.run()` → `_run_guarded`，
  整个 snapshot 请求变成 error（而不是逐变量跳过），并且不写 payload/manifest。
- severity：P2（持久化整体失效 + 与"逐变量 best-effort"契约冲突；可达性依赖 cell 自己写非 str 键）
- file:line：`prime-agent-runtime/src/rlm/repl.py:1058-1059`
  ```python
  for name in list(ns.keys()):
      if name.startswith("_") or name in _ALWAYS_SKIP:
  ```
  对照有守卫的两处：`:994`（重放指纹）`if not isinstance(name, str) or name.startswith("_") or name in _ALWAYS_SKIP:`；
  `:1485-1487`（list_names）`# Non-string keys (globals()[1] = 1) are not user-listable names.`
- 逐字证据（原始命令 = `/tmp/audit_r/round-35/r35_repl_driver.py` spawn `python -m rlm.repl`，NDJSON 收发；输出原样）：
  ```
  {'event': 'ready', 'protocol': 3, 'python': '3.11.13'}
  exec events: [('done', None, None)]                       # cell: globals()[1] = "x" / normal = 1
  {"event": "done", "id": "s1", "status": "error", "reason": "AttributeError: 'int' object has no attribute 'startswith'"}
  files on disk: []                                          # payload/manifest 都没写
  ```
  同进程、同一快照目标、命名空间还有正常名字时仍然失败（证明不是"没有可存的名字"）：
  ```
  POS CONTROL snapshot with normal ns: [{"event": "done", "id": "s2", "status": "error",
      "reason": "AttributeError: 'int' object has no attribute 'startswith'"}]
  files: []
  list_names with int key: {"event": "done", "id": "l1", "status": "ok", "names": ["a","b","c","normal"]}
  ```
  删掉非 str 键后同一个请求立刻成功（正控：证明检出手段能区分两态，也证明失败完全由该键引起）：
  ```
  after del: [{"event": "done", "id": "s3", "status": "ok", "saved": ["a","b","c","normal"], "skipped": [], "pruned": [], "bytes": 97}]
  manifest: {"version": 1, "savedNames": ["a","b","c","normal"], "skipped": [], "pruned": [], "preserved": [], "bytes": 97, "pythonVersion": "3.11.13", "timestamp": "2026-09-15T23:05:40.172564+00:00"}
  ```
  键类型无关（tuple 同形）：
  ```
  snapshot with tuple key: {"event": "done", "id": "s4", "status": "error",
      "reason": "AttributeError: 'tuple' object has no attribute 'startswith'"}
  ```
- 影响：会话内一旦出现该键，`captureSnapshot`（debounce 自动快照、`pruneOversizedVariables`、
  dispose 终局 flush 三条路都走 `_snapshot_state`）全部返回 null：
  - 宿主侧 `repl-manager.ts:2847-2856` → `appendKernelDiagnostic("state snapshot failed: ...")`
    → `appendKernelStderrText` → 只进 `this.kernelStderr`（`:454/:810/:887`），
    **只在 stall/错误诊断里被渲染**；普通 debounced 写失败**没有**面向模型的通知
    （对照：压缩路径 `compactionKernelStateLines` state-snapshot.ts:141-152 会明说"快照没写成"）。
  - 下次 `--resume` 复活的是**上一个成功写**的 payload，错过的名字只能靠 `RestoreResult.notSaved`
    （读 manifest.skipped）点名——而失败的这次**根本没写 manifest**，所以连"没保存"都不会被点名第二次。
- 可复现步骤：起内核 → `globals()[1] = "x"`（或 `globals()[(1,2)] = 3`）→ 任意 `{"type":"snapshot",...}`
  → done.status == "error" 且目标目录无文件 → `del globals()[1]` → 同请求成功。
- confidence：high（活体复现 + 正控）。
- 备注（去重）：`decisions.jsonl` 中 `replay/重放/指纹/non-str/命名空间` 关键词均无命中；
  最接近的 A3/A2 都是"名字被跳过但**有上报**"，本条是"整个快照失败、无上报"。

### R35-RL-2 复核旧条目 A3：下划线顶层名仍全链路零痕迹（P3）

- 命题：`_snapshot_state`(`:1059`)、`_replayable_snapshot`(`:994`)、`_list_names`(`:1487`) 三处都跳过
  `_` 开头的名字，且**不写进 skipped**，于是既不在 `saved`、也不在 `manifest.skipped`
  （⇒ 复活通知 `notSaved` 也点不到）、也不在 `list_names`；而系统提示
  `packages/coding-agent/src/core/prompts/rlm.ts:62` 仍写 "Python state in the kernel persists across cells:
  named variables, helper functions, classes, imports, notes, … remain available"。
- severity：P3（诚实性/可解释性；不直接破坏数据，因为本来就不写给模型看）
- file:line：`prime-agent-runtime/src/rlm/repl.py:1059`、`:994`、`:1487`；
  `packages/coding-agent/src/core/prompts/rlm.ts:62`
- 逐字证据（活体）：
  ```
  exec: [('done', 'ok')]                                    # cell: _memo = 5 / keep = 1
  list_names: {"event": "done", "id": "l1", "status": "ok", "names": ["keep"]}
  snapshot done: {"event": "done", "id": "s1", "status": "ok", "saved": ["keep"], "skipped": [], "pruned": [], "bytes": 30}
  MANIFEST: {"version": 1, "savedNames": ["keep"], "skipped": [], "pruned": [], "preserved": [], ...}
  ns dump: ['_memo', 'keep']                                 # 名字确实活在命名空间里
  ```
  正控：`keep`（无下划线）在三处都在场；`_memo` 三处全无 —— 检出手段能同时看到"在/不在"。
- 影响：模型定义了 `_foo` 之后，参数被静默丢弃；重启后既不报 failed，也不报 notSaved/未保存，
  与提示词承诺直接冲突（旧条目 A3 的原始措辞即此）。
- 可复现步骤：起内核 → `_memo = 5; keep = 1` → snapshot + list_names + 读 manifest。
- confidence：high（活体）。
- 复核旧条目 A3：`docs/fork/audits/decisions.jsonl` A3 = `{"status":"fixed","commit":"55bae7c50","verified_by":"二次对账: r18/tree-kernel-vis 合入（258970bb6）| R4-A 子线读 repl.py"}`。
  实测 `git show 55bae7c50 --stat` 只有
  `packages/coding-agent/src/core/session-manager.ts` + `modes/agent-connection/snapshot.ts`
  （"bound the session tree on the wire"），**不含任何 repl.py/提示词改动**；HEAD 上三处跳过仍在、
  提示词承诺仍在 ⇒ A3 的定性应为"未修/记账有误"，不是 fixed。

### R35-RL-3 重放指纹的残留面：重放返回 ok 但与实时命名空间不符（P4，已知设计限制的边界）

- 命题：`_replayable_snapshot` 只比对 (key, `_cell_counter`, `_restore_counter`, 名字集合与**对象同一性**,
  磁盘大小)，对"后台线程 in-place 改值且期间无 cell 执行"不可见 ⇒ 命中重放时，返回的 done 帧
  （`saved`/`bytes`/`ok`）描述的是**上一次**的内容，实时命名空间已经不同。
  代码注释自认该限制（`repl.py:936-939`），并把终局 flush 交给 `final` 绕过（`:1393-1400`）。
- severity：P4（残留面只剩"最后一次写不是终局 flush"和"有消费者信任中途结果"；两条都未在本线证到实际损害）
- file:line：`prime-agent-runtime/src/rlm/repl.py:977-1012`、`:936-945`、`:1400`
- 逐字证据（活体）：cell 起一个 0.3s 后 in-place `L.append(2)` 的线程；S1 正常写；等 0.8s（无 cell）；
  S2 同 key 非 final；S3 `final:true`；每一步读磁盘 payload（另一个进程 `dill.load`）：
  ```
  S1 {"event": "done", "id": "s1", "status": "ok", "saved": ["L","threading","time"], "skipped": [], "pruned": [], "bytes": 180}
  S2(non-final) {"event": "done", "id": "s2", "status": "ok", "saved": ["L","threading","time"], "skipped": [], "pruned": [], "bytes": 180}
  payload mtime changed by S2 (False => replayed): False
  ON DISK AFTER S2: [1]
  S3(final) {"event": "done", "id": "s3", "status": "ok", "saved": ["L","threading","time"], "skipped": [], "pruned": [], "bytes": 183}
  payload mtime changed by S3: True
  ON DISK AFTER S3: [1, 2]
  LIVE L: [1, 2]
  ```
  ⇒ S2 回了 ok/bytes=180，而同一时刻磁盘是 `[1]`、命名空间是 `[1,2]`：重放结果与实时状态不一致。
- 影响：中途的快照结果不能当"磁盘=现在"的凭据；具体到宿主，`captureSnapshot` 只把它当 `SnapshotResult`
  转给调用方（`snapshotState()`/`pruneOversizedVariables()`），两个 teardown 路径都带 `final`（见负结论 N1），
  所以**未观察到实际数据丢失**；只有"最后一次写不是终局 flush"（SIGKILL/崩溃，或
  `runSnapshotFlushForDispose` 因 `!queueSettled` 提前 return，`repl-manager.ts:3157`）才会留给磁盘一个
  可能陈旧的 payload。标 P4、live 只到运行时层。
- 可复现步骤：见上（脚本 `/tmp/audit_r/round-35/r35_repl_driver.py` + 上面 8 行时序）。
- confidence：medium（运行时层 high；"宿主侧有实际损害"未证 → 整体 medium）。

## 负结论与正控

- **N1 负结论：`final:true` 在 TS 侧两个 teardown 路径都设了，重放不会回答终局写。**
  出处：`repl-manager.ts:2838`（`...(options.final ? { final: true } : {})`）、
  `:3160`（dispose flush `captureSnapshot({..., final: true})`）、
  `:2591`（`performShutdown` → `opts.snapshot` 时 `await this.flushSnapshotForDispose()`）；
  非 final 的只剩 debounce 自动快照 `:3111` 与 `snapshotState()/pruneOversizedVariables()`（`:2752/:2757`）。
  正控（证明重放确实存在、且 final 确实绕过）：上条 R35-RL-3 的实测——非 final 的 S2 **文件 mtime 未变**
  （重放命中），`final:true` 的 S3 **mtime 变了且字节 180→183**（真写）。
  既有测试也在钉这条：`packages/coding-agent/test/kernel-snapshot-final-flush.test.ts:109`
  （`expect("final" in request, ...).toBe(false)` 用于非终局请求）。
- **N2 负结论：非 str 键的守卫在 `list_names` 与重放指纹里都存在，只有写路径缺。**
  正控：仓库自带 `test/test_repl.py:880 test_list_names_skips_non_string_keys`
  （`globals()[1] = 1` 后 `list_names` 仍 ok 且含 `beta`）在本轮全量跑里通过；
  活体同进程 `list_names` 在 int 键在场时返回 ok（见 R35-RL-1 证据），而 snapshot 失败 ⇒ 检出手段能分辨两处。
- **N3 负结论：中断的 cell→handle 记账会自清理，未见跨 cell 误杀。**
  `bash.py:229` 注册、`:441-446` 每个 handle 结束时自 untrack 且空组删键、`:1042-1055` 只杀目标 cell 的组、
  `repl.py:641` `_forget_cell(rid)` 在请求结束时丢组。正控：既有测试
  `test_interrupt_kills_background_bash_handles_of_interrupted_cell` /
  `test_background_bash_handle_from_earlier_cell_survives_later_interrupt` /
  `test_interrupt_kills_handle_spawned_by_detached_task_of_interrupted_cell` 全绿（本轮全量跑）。
  另：宿主 requestId 用 `uuid()`（`repl-manager.ts:1960/2626`）⇒ 不存在 rid 复用导致的 `_cell_handles`/
  `_sigint_target` 陈旧匹配（`repl.py:631-634` 的防复用只是二次保险）。
- **N4 CI 口径全量跑**：
  ```
  Ran 367 tests in 46.780s
  FAILED (errors=1, skipped=1)
  ```
  唯一 error = `ERROR: test_real_anonymous_streamable_http (test_mcp.McpRegistryTest.test_real_anonymous_streamable_http)`,
  报错体 `mcp.shared.exceptions.MCPError: Server returned an error response`（`test/test_mcp.py:615`）——
  用例名即"真·匿名 streamable http"，属**需要外部 MCP 服务/网络**的环境性失败，与本线（repl 生命周期）无关；
  run 2 复现同一例（`Ran 367 tests in 47.061s` / `FAILED (errors=1, skipped=1)` / `EXIT=1`，全量输出
  `/tmp/audit_r/round-35/suite.txt`）。本线未发现 REPL 生命周期用例的红。（`mcp.shared.exceptions.MCPError: Server returned an error response`），
  属 MCP 文件、与本线无关（未深究）；本线未发现 REPL 生命周期用例的红。
  命令：`cd prime-agent-runtime && env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_SUBAGENT_ID -u PRIME_AGENT_SESSION_DIR uv run python -m unittest discover -s test`

## 未做/存疑

- **宿主侧通知路径 live 未做**：R35-RL-1 里"普通（非压缩）快照失败没有面向模型的通知"是**读码结论**
  （`repl-manager.ts:2847-2856` → `appendKernelDiagnostic` → `kernelStderr`，消费点只有 `:887` 的诊断串），
  没有真起 interactive/daemon 会话端到端看模型是否被通知。
- `_handle_state` 的 error/committed 恢复分支（`repl.py:1463-1480`）与 owner watchdog（`:1676-1694`）
  只做了通读 + 依赖既有测试（`test_sigint_*` 24 例、`test_owner_watchdog_*` 3 例），未自建注入样例。
- blob 缓存（`_snapshot_blob_cache`）的逐项租金核对只到读码+推理：`cached[0] is value` 有强引用钉住对象，
  `id()` 复用不可能；`len(blob) > limit` 的跳过判定与 fresh dump 的 `_CappedWriter` 语义等价；
  未构造出"缓存给出陈旧 blob"的反例（负结论，正控=上面 S 系列显示 blob 字节随 final 写从 180→183 变化）。
- Windows 分支（`_wait_owner_windows`、无 `pthread_kill` 的回退 `repl.py:591-599`）本机未跑。
- 中断"误吃上一请求"未构造出反例：rid=uuid 不复用 + `_finish_locked` 清 `_sigint_target`（`:631-634`）
  + 既有 `test_stale_target_from_finished_interrupt_ignores_later_sigint_on_reused_id` 绿 ⇒
  只能表述为"本次扫描范围内未见误吃样例"。
