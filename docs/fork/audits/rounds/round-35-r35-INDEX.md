# r35 泛扫 —— prime-agent-runtime Python 内核侧 · 汇总索引

冻结 `438d33383605ed22c6111cf05851486d948e9d5f`。6 条线（父席 1 + 子席 5），全部只读仓库、产出在
`/tmp/audit_r/round-35/`。基线：`env -u RLM_* ... uv run python -m unittest discover -s test`
= Ran 367 tests / FAILED (errors=1, skipped=1)，唯一 error 是 `test_mcp` 需外部 MCP 服务（环境性）。

## 分级总表（父席判读后的排位）

| 级别 | 条目 | 一行命题 | 文件 |
|---|---|---|---|
| **P1** | ⑤F3 | 恢复一个 open file 会在 restore 那一刻**截断真文件**（模型什么都没写），回执仍 `failed=[]` | r35-dill-fidelity.md |
| **P2** | ①RL-1 | 命名空间出现**一个非 str 顶层键**（`globals()[1]=1`）⇒ 此后**每次** snapshot 全失败、整个命名空间停止落盘，且模型零通知 | r35-repl-lifecycle.md |
| **P2** | ④R1 | `record_refinement` 零类型校验 → 写出 `trigger:null` 的共享 harness 文件 → TS 系统提示词构建 `TypeError`（`global_=True` 时受害面=所有会话） | r35-refine-python.md |
| **P2** | ⑤F1/F2 | 恢复后函数 `__globals__` 是私有副本、别名/类同一性/isinstance 全断，`failed=[]` | r35-dill-fidelity.md |
| **P2** | ⑤F5 | 上述"恢复成功但语义错"的名字进不了任何上报通道（host `unrestoredNames` 只由 `failed` 构造） | r35-dill-fidelity.md |
| **P2** | X1 | 跨 Python 版本恢复报 `restored=[全部] failed=[]`，随后**调用恢复出的函数直接打死内核**（SIGTRAP/SIGSEGV），且每次重启都重演 | r35-xver-restore.md |
| **P3** | ③H-1 | 宿主保留节流 1s vs 陈旧阈值 3×interval ⇒ `KERNEL_HEARTBEAT_INTERVAL_MS<334` 时健康内核被判 stale（活体 22/59 采样） | r35-heartbeat-goal.md |
| **P3** | ③H-2 | `bash.buffered_bytes` 是 ≤8 handle 的无序子集和 ⇒ 可伪造 movement、释放失速预算 | r35-heartbeat-goal.md |
| **P3** | ③H-3 | `bash.cell_handles` 全链路算好、传好、生产**零读者** ⇒ 跨 cell handle 能替当前轮 vouch | r35-heartbeat-goal.md |
| **P3** | ②F1/F2/F3/F4/F5/F6 | 技能模块包装：幻影未包装引用、浅副本双 dict、reload 后 `__signature__` 说谎＋`reload(A.B)` 报"not in sys.modules"、失败技能三路径三种错误、无保留名闸 | r35-skill-loading.md |
| **P3** | ①RL-2 | 复核旧条目 **A3 仍红**，且 A3 记的 commit `55bae7c50` 是 session-tree（**旧条目记账错**） | r35-repl-lifecycle.md |
| **P3** | X2 | `pythonVersion` 只写不读，跨版本恢复零闸零提示 | r35-xver-restore.md |
| **P3** | ⑤F6 | numpy 视图恢复后 `base is None`（退化独立副本，穿视图写不再影响基数组） | r35-dill-fidelity.md |
| **P4** | ①RL-3 | 非 final 重放回 `ok` 但与实时命名空间不符（终局 flush 两条路径已带 `final`，残留只剩崩溃/提前 return） | r35-repl-lifecycle.md |
| **P4** | ④R2/R3/R4/R5/R6/R7/R8 | 读回静默丢弃后落盘、id 长度派生重号、save 无乐观锁（TS 端是硬拒）、refinement 行未扁平化（X-8 覆盖面缺口）、`_HarnessProxy` 降级 fail-open、Python 事件出现在提示词但不可 rollback、`plan_refinement` 同名异物 | r35-refine-python.md |
| **P4** | ③H-4/H-5 | `host_requests` 无读者；心跳线程是 `_write_lock` 第三个无超时持有者（live 未做） | r35-heartbeat-goal.md |

## 父席独立复核（不是转述）
1. **①RL-1 复核为真**（`/tmp/r35_dill/exp_nskey.py`，我自己的驱动）：
   `globals()[1]='x'` → `{"status":"error","reason":"AttributeError: 'int' object has no attribute 'startswith"}`，
   `files on disk: []`；`del globals()[1]` 后同请求 `{"status":"ok","saved":["normal"],...,"bytes":32}`。
2. **⑤F3 复核为真且升级为 P1**（`/tmp/r35_dill/exp_fh.py`）：restore 帧 `restored=["fh"] failed=[]` 之后
   磁盘 `0123456789` → `''`（发生在模型写入之前）。用户数据被动丢失，触及产品底线。
3. **①RL-2 的记账错复核为真**：`git show --stat 55bae7c50` = session-manager.ts / agent-connection/snapshot.ts
   （session tree 深度界），与 repl.py/提示词无关。建议把该 decisions.jsonl 条目的 fix 引用改正。
4. **跨版本 X1 的 4 臂矩阵 + 逐名定位 + 3 连死**（`exp_matrix.py` / `exp_iso.py` / `exp_loop.py`）：
   3.11→3.12 rc=-5、3.12→3.11 rc=-11、同版本两向均 rc=None 正常；`call g()` 死而 `print(a)`/`K`/`k` 不死；
   `return 41+1` 的跨版本函数可用 ⇒ "跨版本一律坏/一律好"两种粗口径都错，产品却两种都不判。

## 去重（decisions.jsonl 290 条）
- 新条目均无同案：`alias/别名/identity/isinstance/__globals__/闭包/recurse/byref/非str键/pythonVersion/
  跨版本/skill 模块包装/refinement 类型校验/heartbeat 节流/buffered_bytes/cell_handles` 全 0 命中。
- 相关联但不重复：**A1/A2/A3/FR-5/S-3**（快照诚实性与上报通道，全是"跳过/失败有上报"轴；本轮的
  RL-1 与 ⑤F5 是"整批失败无上报 / 语义错根本进不了 failed"轴）；**F4/T-A**（心跳导出与时钟，不同命题）；
  **X-8**（③R5 是它的覆盖面缺口，行扁平化）；**V-1/V-2/ADV-4**（venv 代际，与 X1 的"版本"不同轴）；
  **ID-1/P-1**（工具名冲突/技能=shell 命令，与 ② 的模块包装不同轴）。
- **需要改账的旧条目：A3**（标 fixed 但 commit 与内容无关，活体仍红）。

## 本轮的共同根因（供决策，不作为独立条目）
1. `dill.loads 未抛异常 == 恢复成功`（repl.py:1323-1326）。已证四种"恢复成功但错"：跨版本致死、
   别名/同一性断裂、函数私有 globals、open file 截断真文件。四条都进不了 `failed`，因此
   preserve_names/`unrestoredNames`/`notSaved` 三条保护链一条都不生效，而通知逐字说
   "These names are available again"（state-snapshot.ts:196）。
2. "逐变量 best-effort"契约在写侧有一处漏守卫（RL-1），在**上报侧**则有系统性缺口：普通 debounced
   快照失败只进 kernelStderr，不进模型可见面（对照压缩路径 state-snapshot.ts:141-152 会明说）。
3. Python 侧与 TS 侧对同一份状态文件的**判决不一致**：harness 文件（Python 崩 TS / Python 自己静默丢）、
   save 并发（TS 硬拒 / Python 软 mtime）、`plan_refinement`（同名异物）。

## 未做/存疑（各线已逐条标注）
live 会话级 resume 全程未做（不重启 daemon、不碰其它会话）；跨版本只做 3.11↔3.12；H-5/H-2 宿主端
端到端未做；②的"同一进程重跑 bootstrap"不可达判定只有读码；③的 rlm_heartbeat 投递链路属 TS 侧未审。
