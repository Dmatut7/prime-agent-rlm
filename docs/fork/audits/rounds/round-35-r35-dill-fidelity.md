# r35-dill-fidelity

线⑤：dill 序列化的恢复保真（哪些对象类型恢复失败会静默变 None / 静默丢语义）。
冻结 SHA `438d33383605ed22c6111cf05851486d948e9d5f`（只读，本线零仓库写入）。
dill **0.4.1**；运行时 venv `/Users/a1/Desktop/ai/prime-agent/prime-agent-runtime/.venv/bin/python`（Python 3.12.11）；numpy 项用 kernel python（numpy 2.4.6 + 同版 dill 0.4.1）。
所有探针脚本在 `/tmp/audit_r/round-35/`（`probe_ns*.py` = 以 `exec` 打进 `types.ModuleType("__main__").__dict__` 的“cell 源码”；`p_dump*.py` = 进程 A dump；`p_sem*.py` / `p_restore.py` / `p_deep*.py` = **新进程** load，完全复刻 `repl.py:1882-1905` 的 `__main__` 垫片）。

## 结论摘要

| # | severity | 一句话 |
|---|---|---|
| F1 | P2 | cell 里定义的函数/类**按值**带走一份 `__globals__` 副本，恢复后**不是**活命名空间：改 `ns['x']`/`ns['lst']` 后函数仍读到冻结值，且每个函数各持一份独立副本（同一 `lst` 出现 3 个不同 id）；`failed` 为空、manifest 报 saved。 |
| F2 | P2 | 名字之间的同一性/别名拓扑在恢复后**全部断裂**：`alias_a is alias_b` False；`type(p1) is ns['Pt']` False；`isinstance(p1, Pt)` False；`isinstance(p1, type(p2))` False；`bm.__self__ is ns['p1']` False；dataclass 实例与其类名不同源。静默、无告警。 |
| F3 | P2 | 恢复一个 open file 对象是把文件**按原 mode 重开**：mode='w' 的句柄在恢复瞬间**截断文件**（内容 `'0123456789'` → `'XYZ'`，offset 10→0）。被动重启即造成磁盘数据丢失。 |
| F4 | P3 | 恢复出的 `subprocess.Popen` **伪造退出码 0** 并让 `kill()` 变成静默空操作：`poll()` 走 ECHILD 分支返回 0；`send_signal()` 先 `poll()` 再提前 return（"Skip signalling a process that we know has already died"），`os.kill` 一次都没被调用，目标进程仍活着。 |
| F5 | P2 | 上列“恢复成功但语义错”的**全部**名字都进不了任何上报通道：manifest `savedNames` 有它们、restore `restored` 有它们、`failed` 为空 ⇒ host `unrestoredNames` 为空 ⇒ `restoreNoticeLines` 对模型说“These names are available again: …”；preserve/merge 机制永远不会保护它们（它只由 `failed` 驱动）。 |
| F6 | P3 | numpy：`view` 恢复后 `base is None`（变成独立副本），`a is alias` False；数值对，**视图/基址别名语义静默丢失**（穿过视图写不再影响基数组）。 |
| N1 | — | 负结论：**未发现** `_deeply_immutable` 的 false positive（2000 例 fuzz + 对抗候选），blob 复用实测生效且复用字节 == 新鲜 dump 字节。 |
| N2 | — | 负结论：`_CappedWriter` 半截 blob **不可能**进 payload；聚合 cap 二分后的落盘文件是完整可载 pickle（filesize == manifest.bytes == `savedNames` 对齐）。 |
| N3 | — | 负结论：generator / async generator / socket / `asyncio.Future` 在 dump 侧被 skip 并带类型化 reason；**合成模块**与**磁盘上被删掉的模块**在 load 侧进 `failed` 且 reason 可执行（`ModuleNotFoundError: No module named '…'`），且不拖累其它名字。 |
| N4 | — | 负结论：`restore` 侧没设 `dill.settings["recurse"]` **不影响 load**（recurse True/False 两进程 checks 全等，仅内存地址不同）；但我无法构造“任一 settings 改变 load 结果”的正控，见“未做/存疑”。 |
| N5 | — | 负结论：锁/队列/事件状态保住了（`threading.Lock` locked True、`Event` set True、`asyncio.Queue` 2/2 项、`asyncio.Lock` locked True）；闭包、lambda、装饰器包装、`functools.partial`、property、deque、array、循环引用值全对；模块对象按引用（`mod is sys.modules['json']` True）。 |

去重：`docs/fork/audits/decisions.jsonl`（290 条）grep `alias|别名|identity|isinstance|静默|fidelity|保真|round-trip|recurse|_main_|globals|closure|byref|_deeply_immutable|CappedWriter|preserve_names|unrestored|快照|restore` **没有任何条目覆盖 dill 往返保真**。相邻但有区别：A2（skipped 两侧不点名，已 fixed —— 本线的“静默错”恰好相反：点了名（restored）却是错的）、FR-5（写失败 fail-open）、S-3（明文钥进快照）、A3（下划线名不进快照）。**不改变任何旧条目定性。**

## 发现

### F1（P2）函数恢复后的 `__globals__` 是副本，不是活命名空间 —— 静默读到冻结值

**命题**：`_snapshot_state` 逐名 `dill.dump`（`repl.py:1087`，`dill.settings["recurse"]=True` 于 `repl.py:1045`）配合 `byref=False`（dill 默认，实测 `LOAD_SETTINGS … "byref": "False"`），使 cell 中定义的函数按值携带 `__globals__`；`_restore_state`（`repl.py:1324` `dill.loads(blob)`）载回的是一个**冻结快照副本**，与恢复后继续演进的命名空间永久脱钩。

**severity**：P2（模型在 resume 后调用自己定义的 helper 会拿到基于旧值的结论，且没有任何通道提示）。

**file:line**：`prime-agent-runtime/src/rlm/repl.py:1045`（`dill.settings["recurse"] = True`）、`:1087`（`dill.dump(value, _CappedWriter(buffer, limit))`）、`:1324`（`staged[name] = dill.loads(blob)`）、`:1882-1885`（`__main__` 垫片，注释自称 “makes dill pickle user functions/classes by value”）。

**逐字证据**（命令：`cd /Users/a1/Desktop/ai/prime-agent/prime-agent-runtime && .venv/bin/python /tmp/audit_r/round-35/p_dump2.py`，然后**新进程** `.venv/bin/python /tmp/audit_r/round-35/p_sem2.py`；cell 源码见 `probe_ns2.py`：`x=1; def f(): return ("x",x); x=2; lst=[1,2,3]; def g(): return ("lst_len",len(lst),"lst_id_in_globals",id(lst))`）：

```
DUMP 侧: PRE g() -> ('lst_len', 3, 'lst_id_in_globals', 4350480832)
DUMP 侧: PRE g.__globals__ is ns: True
DUMP 侧: SNAPSHOT_RESULT {"saved": ["alock2","aq2","ev2","f","fh2","g","gid","lock_th2","lst","mtime_ref","proc2","subprocess","threading","x"], "skipped": [], "pruned": [], "bytes": 2274}
LOAD 侧(新进程): RESTORE_RESULT {"restored": [ ...同上 14 个名字... ], "failed": []}
LOAD 侧: SEM g_globals_is_ns = False
LOAD 侧: SEM g_globals_lst_is_ns_lst = False
LOAD 侧: SEM g_globals_lst_id_vs_ns_lst_id = (4389757056, 4373993664)
LOAD 侧: SEM gid_vs_lst = (4375177152, 4373993664)
LOAD 侧: ns['lst'].append(4) 之后
LOAD 侧: SEM g_call_after_ns_lst_append4 = ('lst_len', 3, 'lst_id_in_globals', 4389757056)
LOAD 侧: ns['x'] = 99 之后
LOAD 侧: SEM f_call_after_ns_x_99 = ('x', 2)
```

读法：同一个 `lst` 在恢复进程里有 **3 个不同 id** —— `ns['lst']`=4373993664、`g` 的 globals 副本里=4389757056、`gid` 的 globals 副本里=4375177152（即**每个函数各有一份自己的 globals 副本**）。`ns['lst'].append(4)` 后 `g()` 仍是 3；`ns['x']=99` 后 `f()` 仍是 `('x',2)`。

**影响**：resume/压缩后，模型定义过的函数会静默对其**冻结副本**求值（`g()` 读到的 id 与 `ns['lst']` 不是同一对象），`failed` 为空、manifest 里这 14 个名字全在 `savedNames`、`restored` 全列 —— 无任何提示。用户可见面：<ipython_state_restored> 只列名字，模型据此认为这些变量“可用且一致”。

**复现**：`cd prime-agent-runtime && .venv/bin/python /tmp/audit_r/round-35/p_dump2.py && .venv/bin/python /tmp/audit_r/round-35/p_sem2.py`（`probe_ns2.py` 已含限定好的 cell 源码；两次运行都是独立进程）。

**confidence**：high。

### F2（P2）名字间的同一性/别名拓扑恢复后全部断裂（静默）

**命题**：payload 是 `name -> 独立 blob`（`_snapshot_state:1087/1112`），每个名字一次 `dill.dump` ⇒ 每个 blob 一份私有 memo；`_restore_state`（`:1320-1326`）逐 blob `dill.loads` ⇒ 同源对象被复制成互不相干的 N 份。类对象、实例、绑定方法、别名列表全部断链。

**severity**：P2。

**file:line**：`repl.py:1087`、`repl.py:1112`（`payload[name] = blob`）、`repl.py:1320-1326`。

**逐字证据**（进程 A `p_dump.py` 的 namespace 含 `alias_a = [1,2]; alias_b = alias_a`、`class Pt`、`p1=Pt(1); p2=Pt(2); bm=p1.greet`、`@dataclass class DC; dc1=DC(3)`；新进程 `p_restore.py`）：

```
LOAD: RESTORE_RESULT {"restored": ["DC","Meta","Pt","WithMeta","agen","alias_a","alias_b", ... "p1","p2","part","props", ... ], "failed": []}
LOAD: CHECKS "alias_a": {"check": [["is_alias_b", false], ["v", [1, 2]]]}
LOAD: CHECKS "alias_b": {"check": ["is_alias_a", false]}
LOAD: CHECKS "p1": {"check": [["v", 1], ["isinstance_p1_typeof_p2", false], ["type_is_Pt", false]]}
LOAD: CHECKS "p2": {"check": ["isinstance_p2_typeof_p1", false]}
LOAD: CHECKS "dc1": {"check": [["class_is_same_as_DC", false], ["a", 3]]}
LOAD: CHECKS "bm": {"check": [["is_bound", false], ["call", "hi-1"]]}     # bm.__self__ is ns['p1'] -> False
```

**影响**：恢复后 `isinstance(p1, Pt)` 为 False（实例不是自己那个类的实例）、`type(p1) is not Pt`、`p1` 与 `p2` 甚至**属于两个不同的类对象**；`bm.__self__` 不是 `ns['p1']`（改 `p1.v` 不影响 `bm`）。模型若用 `isinstance` 做分派/校验会静默走错分支；改一个名字不影响“同一个”对象。无 failed、无 notice。

**复现**：同 F1 的两条命令（`p_dump.py` / `p_restore.py`）。

**confidence**：high。

### F3（P2）恢复 open file 句柄 = 按原 mode 重开文件 ⇒ 截断磁盘内容

**命题**：`dill` 对 `_io.TextIOWrapper` 按 `(name, mode)` 重开。namespace 里一个 `open(path,"w")` 的句柄被写进 payload 后，恢复动作本身把该文件**截断**（不报错、无 failed）。

**severity**：P2（被动重启导致真实磁盘数据丢失，且是在模型未做任何写操作的情况下）。

**file:line**：`repl.py:1087`（fh 被当普通值 dump；名字 `fh2` 不在 `_ALWAYS_SKIP`，`open` 才在）、`repl.py:1324`。

**逐字证据**（`probe_ns2.py`：`fh2 = open("/tmp/audit_r/round-35/_probe_open2.txt","w"); fh2.write("BEFORE")`；dump 侧打印 `OPEN_FILE_OFFSET 6`；新进程 `p_sem2.py`）：

```
LOAD: SEM fh2_closed = False
LOAD: SEM fh2_tell = 0
LOAD: SEM fh2_write_after_restore = (5, None, 'AFTER')      # 第三个元素 = 恢复后回读文件内容
LOAD: SEM RESTORE_RESULT {"restored": [ ..., "fh2", ... ], "failed": []}
```

改 mode='w' 再看一次（`probe_ns6.py`：`fh6 = open(.../"_probe_open6.txt","w"); fh6.write("0123456789")`，dump 侧 `DUMPER_FILE_MODE w tell 10`）：

```
LOAD: SEM6 fh6.mode = w
LOAD: SEM6 fh6.tell = 0
LOAD: SEM6 fh6.write = 3        # 写 "XYZ"
LOAD: SEM6 file_content_after_restore_entry = 'XYZ'
LOAD: SEM6 pre_dump_file_content = '0123456789'
```

即恢复那一刻文件内容 `'0123456789'` 已被 `'XYZ'` 取代（重开截断），不是追加。

**影响**：任何把写句柄留在命名空间里的会话（日志、CSV 增量写、`open(...,'w')` 后分段写）在 resume/压缩后的第一次恢复会丢掉此前写入的内容；模型看不到任何失败信号。**注意这是恢复侧的副作用**，不是“值坏了”。

**复现**：`cd prime-agent-runtime && .venv/bin/python /tmp/audit_r/round-35/p_dump6.py && .venv/bin/python /tmp/audit_r/round-35/p_sem6.py`（`p_sem6.py` 会打印 `file_content_after_restore_entry`）。

**confidence**：high（现象逐字可复现；dill 重开时的确切路径未逐行读源码）。

### F4（P3）恢复出的 `Popen` 伪造退出码 0、`kill()` 是静默空操作

**命题**：`Popen` 被按值恢复（`_child_created=True`、原 pid），但恢复进程**不是它的父进程**。`Popen.poll()` 的 `waitpid` 对非子进程抛 `ECHILD`，`subprocess._internal_poll` 在 `elif e.errno == _ECHILD:` 分支把 `returncode` 置 0（“This child is dead, we can't get the status”）；`send_signal()` 又**先 poll 再判死**，于是 `kill()/terminate()` 直接 return，`os.kill` 从未被调用。目标进程**仍在运行**。

**severity**：P3（静默假事实 + 静默空操作；在活句柄上做“收尾/清理”的模型会被骗）。

**file:line**：`repl.py:1087` / `:1324`（普通值路径，名字 `proc4` 不在 `_ALWAYS_SKIP`）。CPython 侧证据来自运行时 venv 的 `subprocess.Popen._internal_poll` / `.send_signal`（本线用 `inspect.getsource` 取原文，见下）。

**逐字证据**（`probe_ns5.py`：`proc5 = subprocess.Popen(["sleep","300"], start_new_session=True)`；dump 后父进程退出，pid 9660 实测仍存活；新进程 `p_sem5.py`）：

```
LOAD: RESTORE {"restored": ["proc5", "proc5_pid"], "failed": []}
LOAD: returncode_before None pid 9660 child_created True
LOAD: kill() -> None os.kill calls: []
LOAD: returncode_after 0
KERNEL: ps -p 9660 -o pid,stat,command => 9660 Ss sleep 300        # 目标进程没死
KERNEL: (此前 os.kill(9660, SIGKILL) 手工调用可正常杀死 => 权限/信号链路正常)
```

`send_signal` 原文（`inspect.getsource`，Python 3.12.11）：

```
            self.poll()
            if self.returncode is not None:
                # Skip signalling a process that we know has already died.
                return
            try:
                os.kill(self.pid, sig)
```

**影响**：`p.poll()`/`p.returncode` 在恢复后给出 “已退出，状态 0”，而进程其实在跑；`p.kill()` 变成静默 no-op（模型以为清理完了）。另注：同一个 `pid` 若已被 OS 复用，模型直接 `os.kill(p.pid, …)` 会打到无关进程（本线只证到“恢复对象持有裸 pid 且 `_child_created=True`”，pid 复用危害未实操，标 low）。

**复现**：`cd prime-agent-runtime && .venv/bin/python /tmp/audit_r/round-35/p_dump5.py`（记下 SLEEP_PID）→ `.venv/bin/python /tmp/audit_r/round-35/p_sem5.py` → `ps -p <SLEEP_PID>`。

**confidence**：high（伪造 0 / no-op kill）；pid 复用可被利用 = low。

### F5（P2）上述“静默错恢复”没有任何上报通道

**命题**：`_restore_state` 的唯一失败通道是 `failed`（`:1326`），它只捕获 `dill.loads` 抛的异常；F1–F4 全部是“load 成功但语义错”⇒ `failed=[]`；host 的 `unrestoredNames` 完全由 `failed` 构造（`packages/coding-agent/src/core/kernel/repl-manager.ts:2992-2993`），写入策略 `preserve_names` 由它派生（`state-snapshot.ts:112-115`、`repl-manager.ts:2766/2841`）⇒ 这些名字永远不会被 preserve/merge 保护，也不会进任何警告文本；`restoreNoticeLines`（`state-snapshot.ts:191-200`）反而告诉模型 “These names are available again: …”。

**severity**：P2（不是新机制漏洞，而是“保真”承诺与实现不符的定性问题；决定 F1–F4 是否会被模型察觉）。

**file:line**：`repl.py:1319-1327`；`packages/coding-agent/src/core/kernel/repl-manager.ts:2992-2993`；`packages/coding-agent/src/core/kernel/state-snapshot.ts:112-115`；`state-snapshot.ts:191-200`。

**逐字证据**：

```
$ grep -n 'unrestoredNames.clear\|for (const failure of failed)' packages/coding-agent/src/core/kernel/repl-manager.ts
2992:			this.unrestoredNames.clear();
2993:			for (const failure of failed) this.unrestoredNames.add(failure.name);
state-snapshot.ts:112:	if (input.unrestoredNames.length > 0 && !input.preserveNamesSupported) {
state-snapshot.ts:115:	return { write: true, preserveNames: [...input.unrestoredNames] };
state-snapshot.ts:196:			`Your Python kernel state was revived from your previous session. These names are available again: ${result.restored.join(", ")}.`,
```

配合 F1/F2 的 `RESTORE_RESULT {"restored": [... "f","g","alias_a","alias_b","Pt","p1","p2","bm","fh2", ... ], "failed": []}` —— 模型收到的正是 “available again”。

**影响**：模型被明确告知这些名字“回来了”，于是继续用 `f()`/`g()`/`isinstance(p1,Pt)`/`p.kill()`；错误结论无法归因。

**复现**：读码 + 上面各条 dump/load 命令；`grep` 两行即可。

**confidence**：high。

### F6（P3）numpy 视图/别名语义静默丢失

**命题**：`ndarray` 的视图（`view.base`）在按值 dump/load 后 `base is None`（退化成独立副本），ndarray 别名（同一数组的两个名字）也断裂。数值本身正确。

**severity**：P3。

**file:line**：`repl.py:1087`/`1122`（逐名独立 blob，无共享 memo）。

**逐字证据**（`p_np_dump.py` / `p_np_restore.py`，kernel python，numpy 2.4.6 + dill 0.4.1）：

```
WROTE {'a': 280, 'view': 216, 'alias': 280, 't': 20}
NP {"a": ["OK","ndarray", ...], "a_equal_orig": "True",
    "view": ["OK","ndarray","array([[ 6,  7],\n       [10, 11]])"],
    "view.base is None": true,
    "a is alias (restored)": false,
    "view.base is restored a": false,
    "writing through restored view changed restored a": false}
```

**影响**：模型恢复后对 `view` 赋值以为在改 `a`（分块预处理、原地归一化等），实际改不到；`a is alias` 失效使“同一份大数组被两个名字引用”的去重/一致性假设破裂。dill 把视图降级成副本属于 dill 语义，但本仓无任何检测/提示。

**复现**：`<kernel-python> /tmp/audit_r/round-35/p_np_dump.py && <kernel-python> /tmp/audit_r/round-35/p_np_restore.py`（运行时 venv 无 numpy，故用 kernel python；dill 同为 0.4.1）。

**confidence**：high。

## 负结论与正控

### N1 `_deeply_immutable` 无 false positive（带上界）：`repl.py:953-974`

**命题（负）**：在本次扫描范围内未发现能让 `_deeply_immutable` 返回 True 而序列化会变的输入；blob 复用（`repl.py:1072-1083`）因此不会写出陈旧 blob。

**逐字证据**（`p_deep.py`，`DI = repl._deeply_immutable`）：

```
PRED {"tuple_atomic": true, "frozenset_atomic": true, "range": true, "tuple_with_list": false, "list": false, "dict": false, "str_subclass": false, "int_subclass": false, "class_obj": false, "tuple_with_class": false, "frozenset_with_str_subclass": false, "tuple_with_range_subclass_like": true, "empty_tuple": true, "nested": true, "generator": false}
FUZZ ok=2000 bad=0
```

**正控**（证明该判据确实能返回 False，即“检出方法有牙”）：`list`/`dict`/`str` 子类/`int` 子类/类对象/含 list 的 tuple/生成器 → 全 `false`；`_IMMUTABLE_ATOMIC_TYPES` 用 `type(value) in` 而非 `isinstance`（`repl.py:961`）与注释一致。

**缓存复用正控 + 陈旧检查**（`p_deep2.py`，传入真实 `repl._snapshot_blob_cache` 并给 `dill.dump` 计数）：

```
CACHE dumps_snap1=4 dumps_snap2=2 cache_keys=['big', 's'] big_blob_identical=True m_changed=True
```

读法：第 2 次快照只 dump 了 payload + 被原地改动的 `m`（4→2），`big`/`s` 命中缓存；`big` 的缓存 blob **逐字节等于**一次新鲜 dump（`big_blob_identical=True`），且 `m` 的 blob 确实更新。即复用路径没有把陈旧字节发出去。

**confidence**：high（针对测试面）；判据的任意性未做形式化证明。

### N2 `_CappedWriter` 不会留下半截 blob，聚合 cap 落盘仍是完整 pickle

**命题（负）**：per-variable 超限时 `buffer.getvalue()` 从未被使用（`repl.py:1089-1095` 直接 `continue`）；聚合超限走 `redump_to_temp`（`repl.py:1171-1173` 先 `seek(0)+truncate()`），最终落盘是完整 pickle。

**逐字证据**（`p_deep.py` 的 `Spy(_CappedWriter)`；`p_deep2.py` 的聚合 cap）：

```
CAP_RESULT {"saved": ["small"], "skipped": [{"name": "huge", "reason": "exceeds per-variable snapshot size cap"}], "pruned": [], "bytes": 48}
CAP_PAYLOAD_KEYS ['small'] huge_in_payload False partial_write_events [('raise_after_partial_bytes', 7, 65536)]
```

**正控**：`partial_write_events` 证明“确实是在写了 7 字节之后抛的 `_SnapshotSizeLimitExceeded`”（即 buffer 里**有**半截字节），而 payload 里没有 `huge`；再把半截字节单独喂给 `_restore_state`：

```
HALF_BLOB_AS_PAYLOAD {"error": "load failed: pickle data was truncated"}
```

即“若半截被当作成功，检出方法（`dill.load`）确实会报错”—— 说明这条负结论不是空过。

聚合 cap（`max_bytes=500`，6 个 200 字节名字）：

```
AGG {"saved": ["v0", "v1"], "skipped": [{"name":"v2","reason":"exceeds aggregate snapshot size cap"}, ... v3,v4,v5 同] , "bytes": 462} filesize 462 manifest_bytes 462 loadable True ['v0','v1']
AGG_manifest_saved_matches_disk True
```

**confidence**：high。

### N3 dump 侧 skip / load 侧 failed 的可见性（含“名字每次都被点名”）

**命题（负）**：真正无法序列化/无法复活的对象**不会**静默变 None —— dump 侧进 `skipped`，load 侧进 `failed`，reason 带类型名与被截断的 200 字符消息（`repl.py:1097`/`1326`）。

**逐字证据**（`p_dump.py`）：

```
SNAPSHOT_RESULT { ... "skipped": [
   {"name": "gen", "reason": "TypeError: cannot pickle 'generator' object"},
   {"name": "async_gen", "reason": "TypeError: cannot pickle 'async_generator' object"},
   {"name": "sk", "reason": "TypeError: cannot pickle 'socket' object"},
   {"name": "afut", "reason": "TypeError: cannot pickle '_asyncio.Future' object"}], ...}
```

**逐字证据**（`p_sem6.py`，把模块文件删掉后再恢复）：

```
SNAP6b {"restored": ["fh6","mode_ref","okname","sys","types"], "failed": [
   {"name": "modx", "reason": "ModuleNotFoundError: No module named 'modx_synth'"},
   {"name": "kobj", "reason": "ModuleNotFoundError: No module named 'mod_fail'"}]}
SEM6 okname_restored_despite_kobj_failure = [1, 2, 3]
```

**正控**：`mod_fail.py` 在 dump 前存在、dump 后被删除；`modx_synth` 是 `types.ModuleType` 合成并注册进 `sys.modules` 的模块。两者都确实**能**被 dump 保存（`SNAP6b "saved"` 列表含它们），随后在**新进程** load 时失败 ⇒ 证明“失败检出”在有失败时确实上报，且一条失败不拖累同批其它名字（`okname` 正常恢复）。

**confidence**：high。

### N4 restore 侧未设 `dill.settings["recurse"]` 不影响 load

**命题（负）**：`repl.py:1045` 只在 snapshot 侧设 `recurse=True`；restore 侧（`:1290-1342`）不设。同一 payload 在新进程里以 `recurse=True/False` 两种设置加载，**结果全等**（差异只有 `repr` 里的内存地址）。

**逐字证据**（`SET_RECURSE=1 .venv/bin/python p_restore.py` vs 默认）：

```
LOAD_SETTINGS {"protocol":"4","byref":"False","fmode":"0","recurse":"True","ignore":"False"}
LOAD_SETTINGS {"protocol":"4","byref":"False","fmode":"0","recurse":"False","ignore":"False"}
IDENTICAL CHECKS: False        # 逐项 diff 后: 差异仅 agen/alock/aq/deco/ev/lock_th/make_closure 的 repr 地址
RESTORE same: True
```

**正控的部分成立**：`recurse` 确实改变 **dump** 字节（`def f(): return 1` 的 `__main__` 函数：`len 195` vs `len 189`），所以“settings 在 dump 侧有实际作用”是可证的；但**我未能构造出任何一种 dill.settings 取值改变 load 结果的样例**（`byref=True/False` 对 `__main__` 函数产出完全相同的 195 字节且在新进程 load 成功：`DUMP {'recurse': True, 'byref': True} len 195 head b'\x80\x04\x95\xb8...'` / `LOADED_BYREF_BLOB_OK <function f at 0x100f8efc0>`）。因此该负结论只能表述为“在 dill 0.4.1 + 本次探针面内，未观察到 load 受 settings 影响”，而非“load 与 settings 无关”的普遍命题。见“未做/存疑”。

**confidence**：medium。

### N5 值语义幸存的类型（正控面）

**逐字证据**（`p_restore.py` / `p_sem2.py`，均在新进程）：

```
CHECKS "cyc": {"check": [["self_ref", true], ["len", 1]]}
CHECKS "dcyc": true
CHECKS "cl": {"check": [["call", 5], ["cell", 5]]}
CHECKS "lam": 12
CHECKS "dec": ["wrapped", 7]
CHECKS "part": {"check": [["type", "partial"], ["call_v", 9]]}
CHECKS "props": "property"
CHECKS "deq": {"check": [["type","deque"],["v",[1,2]]]}
CHECKS "arr": {"check": [["type","array"],["v",[1,2,3]]]}
CHECKS "mod": {"check": [["is_sysmodules", true], ["dumps", "{\"k\": 1}"]]}
CHECKS "WithMeta": {"check": ["meta_is_Meta", false]}     # 例外：metaclass 也断链（同 F2）
SEM alock2_locked = True / ev2_is_set = True / lock_th2_locked = True / aq2_qsize = 2 / aq2_get_nowait = 'a'
```

读法：闭包、lambda、装饰器包装、partial、property、deque、array、循环引用、模块按引用、锁/事件/队列的**状态**都对；但 `WithMeta` 的元类同一性断裂（同 F2 拓扑问题，`metaclass` 实例也各持一份拷贝）。`alock2` 的 locked 是我直接置 `_locked` 构造的浅探针，标注为不完整。

**confidence**：high（除 alock2 标注）。

## 未做/存疑

1. **N4 的正控不完整**：需要构造一个“同一对象、不同 dill.settings ⇒ 不同 load 结果”的最小样例才能把结论升级为“load 与 settings 无关”。本次试了 `recurse`（dump 字节变、load 不变）与 `byref`（`__main__` 函数字节完全相同），未得到 load 差异。若无法构造，建议把 `repl.py` 的 restore 侧注释从“recurse 只影响 dump”这类隐含假设改成显式说明，或直接在两处都设 settings 以免将来 dill 版本改变行为。
2. **pid 复用危害未实操**（F4 的 low 部分）：需要制造“原 pid 被无关进程复用”再让恢复对象 `send_signal` 命中；本次因 `send_signal` 先 poll 判死而**不可达**，只剩模型直接 `os.kill(restored.pid, …)` 一条路径，未做。
3. **`_merge_preserved_blobs` 的“先丢最老”注释未证伪**：实测 payload 插入顺序是 `reversed(requested)`、cap 截断后**最后请求的名字存活**（`p_merge2.py`：`requested=["v0","v1","v2","v3"]` → `R2 ... "saved": ["live","v3"], "preserved": ["v3"]`）。注释成立的前提是 host 传“最老在前”；host 的 `unrestoredNames` 是 JS Set（插入序来自 `failed` 的 payload 顺序），本次**未验证** host 顺序，因此不判为缺陷，只记为存疑。附带观察：被 cap 丢掉的 **preserved** 名报的 reason 是 “exceeds aggregate snapshot size cap”（与“活值超限”同一措辞，见 `p_merge2.py` 输出），对读日志的人可能误导（该名字其实是被保留项而非活值）。
4. **活跃体未做（live 未做）**：本线全部结论来自 .venv/kernel python 的 dump→新进程 load 探针，**没有**驱动真实 `prime-agent` 会话（不重启 daemon、不碰其它会话）。因此“真实 resume 路径上 F1–F4 是否会实际发生”只做了机制层证明（进程 A dump → 进程 B load，与 `repl.py` 的 `__main__` 垫片与 `_snapshot_state`/`_restore_state` 完全一致）；host 侧只读码（`repl-manager.ts` / `state-snapshot.ts`）。
5. 未覆盖：`pruned`/`prune_oversized=True` 路径与 F1/F2 的交互（prune 会 `ns.pop`，与函数 globals 副本无关，推断无差异，未跑）；`_replayable_snapshot` 的 `final` 语义；跨 dill 版本（4.x→5.x 类升级）的 payload 兼容性。
6. 仓库零写入已核对：`git status --porcelain` 只显示本会话之前就存在的 `?? 00a_visitor_first_paint.png / ?? out.txt / ?? visitor_rail_no_group.png`；本线产物只在 `/tmp/audit_r/round-35/`。
