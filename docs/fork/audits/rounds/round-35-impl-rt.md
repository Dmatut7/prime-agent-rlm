# r35 impl-rt —— RT-1..4 + K3R-12 修复交付

冻结 SHA `6f2514519e413283184ce4fc9d6f08d7398305cd`（主仓只读）。工作树 `/tmp/r35_wt`（branch `r35-impl-rt`，
node_modules symlink 主仓），提交 `7bb81de2d7ac2db977b31da783cb6265195737d0`（14 files, +814/-23）。
主仓零写入（`git status` 与任务前一致）；未 push（无 push 指令，FORK_NOTES 未动）。

## 方法

先红后绿：红测在未改源码的工作树上全部确认红（Python 8 红 / TS 5 红 + 1 套件编译红），改后全绿。
`npm run check`（biome+tsgo+installer+browser-smoke+ci-honesty）exit 0（33 infos 均为存量）；
pristine tree（`git archive HEAD` + symlink node_modules）`npx tsgo --noEmit` EXIT=0。
跑测试统一 `env -u RLM_DEPTH -u RLM_SESSION_DIR -u PRIME_AGENT_KERNEL_PROTOCOL -u PRIME_AGENT_KERNEL_PYTHON`。
（注意：`PRIME_AGENT_KERNEL_PROTOCOL=4` 泄露会让 test_repl 的两个 protocol-3 断言假红，本轮已剥离。）

## RT-1（P1）open file 不再序列化、恢复不再重开真文件

- **改**：dump 侧 `repl.py:1077-1083`——`isinstance(value, io.IOBase)` 先于 dill.dump，跳过并记
  `skipped: {"name": …, "reason": "open file handles are not persisted"}`（进 manifest.skipped ⇒ host
  `lastSnapshotNotSaved`/`notSaved` 通知链）。load 侧 `repl.py:1370-1407`——restore 期间临时替换
  `dill._dill._create_filehandle`：真实路径（非 `<stdin>/<stdout>/<stderr>/<tmpfile>/<fdopen>`）直接抛
  `_FileReviveBlocked`，名字进 `failed`（reason 点名文件与 mode），**磁盘从未被重开**。
- **关键实现事实**（已实证）：dill 把 file 句柄 pickle 成 `dill._dill._create_filehandle` 的 reduce 引用，
  load 时按**写入侧烘焙的 fmode**（默认 HANDLE_FMODE）走 `open(name, mode)`——`"w"` 在 `dill.loads` 内部
  就截断文件；改加载侧 settings 无效（fmode 已烘焙进 blob）。所以必须在 unpickle 分发点拦截。
  替换窗口全程同步（无 await），事件循环不会插入并发 cell 的 dill 调用。
- **红→绿**：红 `AssertionError: '' != '0123456789'`（restore 那一刻文件被截空）；
  绿（test_r35_impl 两条 + 活体 `exp_fh.py`）：`skipped=[{fh: open file handles are not persisted}]`、
  restore 后 `disk: '0123456789'`、`fh` NameError、`plain` 正常恢复（正控）。
  旧 payload（手构含 file blob）load 侧同样不碰盘（`_FileReviveBlocked` 进 failed）。
- **残面**：Popen/socket 类副作用对象未纳入本轮（socket dump 侧自然 TypeError 已 skip；Popen=线⑤F4 另案）。

## RT-2 非 str 键 + 宿主模型可见失败回执

- **Python**：`repl.py:1058-1063` 补 `isinstance(name, str)` 守卫，非 str 键 `skipped`
  （`repr(name)` 点名 + "non-string namespace key is not a persistable name"），快照继续。
  红：`status: error`（AttributeError 'int' object has no attribute 'startswith'）且 files on disk 空；
  绿：`status: ok, saved: [normal], skipped: [{name: "1", reason: non-string …}]`，盘上双文件，
  后续 restore ok（活体 `exp_nskey.py` 复跑同证）。
- **宿主链**（新文件行号）：`shared.ts:431`(options Pick) → `repl-manager.ts:592/2858-2866`
  （失败分支一次性触发 `onSnapshotFailure`，成功写 `repl-manager.ts:2882` 重置去重）→ `ipython.ts` 透传 →
  `agent-session.ts:9873/12162` `_onKernelSnapshotWriteFailure` → `state-snapshot.ts:195`
  `snapshotFailureNoticeLines`（照 `compactionKernelStateLines` 141-152 先例措辞："could not be written, so
  these names were not saved to disk"），经 `sendCustomMessage(deliverAs: "nextTurn")` 进模型可见面
  （`<ipython_state>` custom message；每失败回合一条，成功后重置）。
- **红→绿（TS）**：红 = `snapshotFailureNoticeLines is not a function` + 编译红；绿 = 7/7（含真内核
  "unsafe snapshot directory" 失败注入触发回调一次、成功写不触发的正控）。

## RT-3 pythonVersion 消费者（选了逐名隔离，理由见下）

- **协议**：restore 请求新增可选 `python_version`（`repl.py:1530-1532` 校验非 str 报 error；缺省=旧行为，
  additive ungated，同 `final` 先例）。宿主 `repl-manager.ts:2976-2986` 从 manifest 读
  （`state-snapshot.ts:259/297-302` 新增 `pythonVersion`）并随 restore 请求发送。
- **闸**：`repl.py:1306-1319` 按 **major.minor** 比对（CPython 字节码/内联缓存以 major.minor 为兼容线；
  观测致死恰为 3.11↔3.12，同线未观测死亡；全版本串比对会把每次 micro 升级误杀）。
  不匹配时 `repl.py:1410-1414`：`_is_foreign_code_object`（FunctionType/type 且**不能**经
  `sys.modules[module].__name__` 解析回自身 = 按值代码对象）逐名进 `failed`（reason 含两侧版本），
  按引用对象（`Path`/`json.dumps`）与普通数据照常恢复。
- **选逐名隔离而非整体拒绝的依据**：①数据是会话状态的大头（list/df/str 跨版本可安全恢复），
  整体拒绝把可救数据一起埋掉；②`failed` 通道现成 ⇒ `unrestoredNames`→`preserve_names` 落盘保留原 blob，
  回到匹配解释器后仍可复活，而整体拒绝走 host `isolateFailedSnapshot` 会把 payload 改名隔离，反而是
  破坏性路径；③改动面最小（一处判断复用既有 per-name loop）。**残面**（报告备案）：实例
  （`k = K()`）按值携带类代码，方法调用仍可能致死——本轮按任务口径只拒函数/类名，
  实例隔离需要值内扫描，留下一轮；容器内嵌函数同理。
- **红→绿**：红（单测）`'helper' unexpectedly found in ['K','data','helper']` + 无 python_version 校验；
  绿（单测 4 条）+ 活体矩阵 `exp_matrix.py`（restore 请求带 python_version，模拟修复后宿主行为）：
  3.11→3.12 / 3.12→3.11 `failed=[K, g: python version mismatch…] restored=2`（a/k），`g()` NameError，
  **rc=None（改前 rc=-5/-11 SIGTRAP/SIGSEGV）**；同版本两臂函数照常恢复（正控）。

## RT-4 record_refinement 类型校验 + TS 双保险

- **Python**：`harness.py:884-897`——trigger/changes(list[str]|str)/evidence/outcome/id 非法类型一律
  `ValueError`，**先于 `_sync_from_disk`/`save()`**（不落盘）。红：无异常且落盘
  `{"trigger": null}`（TS 侧因此炸提示词构建）；红（changes=None 时旧码是 TypeError 而非 ValueError、
  且文件已可能写）；绿：5 条断言含"合法调用仍写盘"正控。
- **TS**：`refinement.ts:787-806`（entry：title/content/path/version/arguments/reference null 防御）+
  `:831-844`（refinement 事件：trigger/changes/outcome/id null→跳字段不炸）+ `:312`
  （`compareEntriesForInjection` id null 防御）。红：`TypeError: Cannot read properties of null
  (reading 'length')`（refinement.ts:822 旧行号）；绿：3 条 + 既有 refinement 套件全绿。

## K3R-12 openai-responses done 分支乱序/重复路由

- **改**：`openai-responses-shared.ts:618-641`——done 分支解析序对齐 `resolveItemAndBlock`
  （item.id 优先、次 output_index、**仅无坐标**才回退 currentBlock）；坐标在而 slot 未注册 ⇒
  `recordDeltaDiagnostic("responses_done_unrouted", …)` + `continue` 跳过。
- **红→绿**：红（新测试 `responses-stream-item-dispatch.test.ts` K3R-12 条）：B 块
  `thinkingSignature` = A 的 item JSON（`expected '{"type":"reasoning","id":"rs_A",…}' not to contain 'rs_A'`）；
  绿：B 块 signature 不含 rs_A、contentIndex 1 无多余 thinking_end、诊断
  `responses_done_unrouted` 存在。既有 responses 套件（dispatch/thinking-conflict/incomplete/
  empty-tool-result/foreign-toolcall-id/partial-json-cleanup）全绿。

## 测试与证据账

| 面 | 红（改前） | 绿（改后） |
|---|---|---|
| `prime-agent-runtime/test/test_r35_impl.py`（新，11 条） | 7 fail + 1 error（逐条见 /tmp/r35_red_python.txt） | 11/11 |
| `test_repl.py`（107）+ `test_repl_snapshot_preserve.py`（10）+ `test_harness.py`（51） | — | 全绿（需剥 PRIME_AGENT_KERNEL_PROTOCOL） |
| `packages/coding-agent/test/r35-impl-rt.test.ts`（新，7 条） | 5 fail + 套件编译红 | 7/7 |
| repl-kernel-state-roundtrip/partial-restore + r24-impl-tail + r25-p4-small + refinement×3 | — | 全绿（roundtrip 含真内核 + 修复后 restore 全链） |
| `packages/ai` responses 系列 + dispatch K3R-12 | K3R-12 红 | 全绿 |
| `npm run check` | — | exit 0 |
| pristine `tsgo --noEmit` | — | EXIT=0 |

## 复现脚本（可复跑）

`/tmp/r35_dill/exp_fh.py`、`exp_nskey.py`、`exp_matrix.py` 已改指工作树
（`R35_SRC`/`R35_PY` 环境变量可覆盖；exp_matrix 的 restore 请求带 `python_version`，与修复后宿主一致；
PY311 换成现存 `kernel-venv-6c7aede708bd`）。修复后输出存
`/tmp/audit_r/round-35/impl-rt-live-fixed.txt`。红态证据在 round-35 各线报告 + `/tmp/r35_red_python.txt`。

## 未做/存疑

1. RT-3 残面：实例/容器内嵌的按值代码对象未隔离（需值内扫描或 conservative 全拒，下一轮决策）。
2. RT-1 未覆盖 Popen（线⑤F4 伪造退出码/静默 kill）。
3. RT-2 会话级端到端（真 session 里 `<ipython_state>` nextTurn 消息渲染）未驱动真会话；
   单测覆盖到 manager 回调 + 措辞函数，agent-session 接线为编译检查。
4. 未 push（无指令）；FORK_NOTES.md 未更新，push 前需补。
