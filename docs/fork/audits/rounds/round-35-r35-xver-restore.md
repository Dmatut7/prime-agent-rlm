# r35-xver-restore（父席亲自跑的内核跨版本恢复面）

冻结点 `438d33383605ed22c6111cf05851486d948e9d5f`（只读，仓零写入）。所有证据为本机真跑：真
`python -m rlm.repl` 子进程 + 真 JSON-lines 协议（`PRIME_AGENT_KERNEL_PROTOCOL=4`），脚本在
`/tmp/r35_dill/`。dill 0.4.1（两侧同为 0.4.1）。

## 结论摘要
- **X1 P2** 内核快照跨 Python 版本恢复：`_restore_state` 逐名 `dill.loads` 全部成功、done 帧回
  `restored=[全部] failed=[]`，**调用恢复出的函数直接打死内核进程**（3.11→3.12 SIGTRAP rc=-5，
  3.12→3.11 SIGSEGV rc=-11）。同一 payload 每次重启都这样死（payload 只在 restore 请求失败时才被
  isolate），而 manifest 里的 `pythonVersion` 无任何消费者。
- **X2 P3（口径）** 跨版本可行性**没有任何闸/提示**：`pythonVersion` 只有写入侧与一个测试断言，
  宿主 `readSnapshotManifest` 不读它，`_restore_state` 不做版本比对。
- **X3 P3（复核性）** 恢复语义断裂（别名/类同一性/函数 `__globals__` 私有副本）与线⑤
  `r35-dill-fidelity.md` 的 F1/F2 同案同证，本报告只补独立复现，不作为新条目计数。

## 发现 X1（P2）：跨 Python 版本恢复「报成功」后第一条函数调用打死内核

**命题**：快照 payload 由某个 Python 版本的内核写出、被另一个版本的核恢复时，恢复帧宣称全部名字
恢复成功，但执行其中恢复出的函数会以致命信号终止内核（不是 Python 异常）。

**file:line**
- 写侧 `prime-agent-runtime/src/rlm/repl.py:1045`（`dill.settings["recurse"]=True`）、
  `:1087`（逐名 `dill.dump(value, ...)`）、manifest `:1220`（`"pythonVersion": sys.version.split()[0]`）
- 读侧 `prime-agent-runtime/src/rlm/repl.py:1320-1327`（逐名 `dill.loads`，只有抛异常才进 `failed`）
- 宿主 `packages/coding-agent/src/core/kernel/state-snapshot.ts:250-262`（`readSnapshotManifest` 只读
  savedNames/skipped/preserved/timestamp）、`repl-manager.ts:2985-2993`（`restored`/`failed` 直接进回执）

**逐字证据**（`/tmp/r35_dill/exp_matrix.py`，写者/读者都是真 `rlm.repl`，payload 在 tmpdir）
```
writer 3.11(3.11.13) -> reader 3.11: restore=ok failed=[] restored=4 | first-use: g()= [1, 2, 3] isinstance= False | rc=None
writer 3.11(3.11.13) -> reader 3.12: restore=ok failed=[] restored=4 | first-use: KERNEL DIED (EOFError) | rc=-5
writer 3.12(3.12.11) -> reader 3.11: restore=ok failed=[] restored=4 | first-use: KERNEL DIED (EOFError) | rc=-11
writer 3.12(3.12.11) -> reader 3.12: restore=ok failed=[] restored=4 | first-use: g()= [1, 2, 3] isinstance= False | rc=None
```
同版本两个方向都是正控（同一脚本、同一 payload 形状、同一写入/恢复路径，只有解释器版本不同）。
写者/读者分别是生产内核 venv `/Users/a1/.prime/agent/kernel-venv-44c3ee7b2bba/bin/python`（3.11.13）
与仓库 venv `prime-agent-runtime/.venv/bin/python`（3.12.11）。

**定位**（`/tmp/r35_dill/exp_iso.py`，3.11 写 → 3.12 读，逐个名字单独用）
```
use a (list)          : [1, 2, 3]  (restore failed=[])
call g()              : KERNEL DIED rc=-5
touch K (class)       : K  (restore failed=[])
touch k (instance)    : K  (restore failed=[])
isinstance(k,K)       : False  (restore failed=[])
```
即：列表/类/实例都能碰，**调用被 pickled 的代码对象**才死。对照：跨版本恢复一个只做
`return 41 + 1` 的函数并调用它是好的（`/tmp/r35_dill/exp_crash.py`：`g() = 42`，rc=None）——
说明不是"跨版本一律不可用"，而是与代码对象内容相关（3.11+ 自适应字节码），因此**任何
"我们试过跨版本没问题"的正控都不成立**，必须按名字逐个判定，而产品不做任何判定。

**死循环**（`/tmp/r35_dill/exp_loop.py`，同一 payload、三个新内核）：
```
attempt 1: call g()   : KERNEL DIED rc=-5
attempt 2: call g()   : KERNEL DIED rc=-5
attempt 3: call g()   : KERNEL DIED rc=-5
attempt 3b: a alone   : [1, 2, 3]  (restore failed=[])
```
payload 没有被 isolate（`repl-manager.ts:3027-3043` 只在 **restore 请求本身**失败/超时时改名），所以
每个新内核都重新恢复同一 payload、再在同一处死。

**影响**
1. 会话 resume 后内核反复以信号死亡：模型看到的是内核崩，而不是任何一条 `failed` 记录；
2. restore 通知逐字对模型说全好了 —— `state-snapshot.ts:196` `"Your Python kernel state was revived
   from your previous session. These names are available again: ..."`（`failed` 为空则无任何保留句）；
   `lastSnapshotNotSaved` 也空（manifest `skipped: []`）⇒ 模型无从察觉；
3. 与 S-3/A2 的"上报通道只覆盖 dump/load 抛异常的名字"同轴：这里 dump 与 load 都没抛。

**可复现**：`cd /Users/a1/Desktop/ai/prime-agent/prime-agent-runtime && env -u RLM_DEPTH -u RLM_SESSION_DIR uv run python /tmp/r35_dill/exp_matrix.py`
（约 0.3s；三个脚本都自带超时与 kill，不碰 daemon/其它会话）。

**confidence**：high（4 臂矩阵 + 逐名定位 + 3 连死；均为真内核进程与真信号退出码）。

## 发现 X2（P3）：`pythonVersion` 记了没人读，跨版本恢复无闸
- 逐字 grep：`grep -rn 'pythonVersion' packages/ prime-agent-runtime/ --include=*.ts --include=*.py | grep -v node_modules`
  → 只有 `prime-agent-runtime/src/rlm/repl.py:1220`（写）与 `test/test_repl.py:677`（断言存在），**零消费者**。
- 正控：同一次 grep 里 `writtenAtMs`（`state-snapshot.ts:283-287`）与 `notSaved`（`:299`）确实各有读者，
  证明该手段能分辨"有消费者/无消费者"。
- 影响：内核 venv 重建换 Python（uv 管理的解释器升级；或按 bootstrap 报错文案把
  `PRIME_AGENT_KERNEL_PYTHON` 指到别的解释器 —— `ipython.ts:50-52` 明示这条路径）后 resume，
  无人比对 manifest 版本、无提示、无隔离。
- **live 未做**：本机 6 个 `~/.prime/agent/kernel-venv-*` 全是 3.11.13，未观察到生产上真实发生过
  跨版本 resume（故 X1 的"当前可达性"= 需要一次解释器版本变化，判 medium；归因与复现本身 high）。

## 发现 X3（P3，复核性，不重复计数）
恢复后**别名/同一性/函数私有 globals** 全部静默断裂，本报告独立复现与线⑤一致（`/tmp/r35_dill/exp_alias.py`）
```
b is a            : False        d['x'] is a  : False        s1 is shared : False
k2 is k1 / isinstance: False False False
a.append(9) -> a= [1, 2, 3, 9] b= [1, 2, 3]
shared['n'] += 1 -> 1 0
g.__globals__['a'] = [1, 2, 3]  而 globals()['a'] = [100]
```
`restore` 帧 `failed=[]`、manifest `skipped=[]`，通知逐字说 "These names are available again"。
⇒ 与 X1 同一条根：**"恢复成功了"这个回执的判据只有 `dill.loads 未抛异常`**（repl.py:1323-1326），
既不含版本，也不含语义同一性。建议修复方向（供决策，不由本线实施）：把 `pythonVersion` 与
`dill.__version__` 一并纳入 restore 前的比对，不匹配时按 `failed` 同形上报（或拒绝恢复并 isolate），
并在 `restoreNoticeLines` 里给一句"跨版本恢复未验证"的措辞。

## 负结论与正控
- N1「`_restore_state` 对跨版本会报 failed」：**否**。正控：故意制造一条 load 失败（模块被删）时
  `failed` 有内容（线⑤ N3 同证：`ModuleNotFoundError: No module named 'mod_fail'`），说明本手段能检出
  `failed` 非空，跨版本时它确实是空的。
- N2「只有函数会死」：不成立，只证到"列表/类/实例可碰、函数调用致死"；未穷举生成器/装饰器/方法等
  跨版本行为（**未做**，不表述为"只有函数"）。
- N3「跨版本一律不可用」：否，`return 41+1` 的函数跨版本可用（正控见上），所以"要么全坏要么全好"
  的两种粗口径都不对。

## 未做/存疑
- 未做真会话 resume（不重启 daemon、不碰其它会话），只做真内核进程级复现；宿主侧只读码。
- 未做 3.11↔3.12 之外的大版本（3.10/3.13）矩阵，也未做 dill 大版本差异。
- 未定位致命信号的 CPython 精确机制（推测 3.11+ 自适应字节码/全局内联缓存跨解释器执行），
  只报告可复现的现象与退出码。

## 复核（父席独立复现线⑤ 的高危条目）——F3 恢复 open file 会静默截断真文件（P1/P2，数据丢失）
线⑤ `r35-dill-fidelity.md` F3 声称"恢复出的 open file 按原 mode 重开 ⇒ 截断磁盘文件"。父席独立复现
（`/tmp/r35_dill/exp_fh.py`，真内核 3.12.11 + dill 0.4.1，目标文件在 tmpdir）：
```
tell 10
snapshot: {"event": "done", "id": "s", "status": "ok", "saved": ["fh"], "skipped": [], "pruned": [], "bytes": 179}
disk before: 0123456789
restore: {"event": "done", "id": "r", "status": "ok", "restored": ["fh"], "failed": []}
after restore: mode/tell -> w 0 | disk: ''
disk after write: 'XYZ'
```
要点：截断发生在 **restore 那一刻**（`disk: ''` 出现在模型写入之前），回执 `restored=["fh"] failed=[]`
照旧宣称全好。模型只是 resume 会话、什么都没写，用户磁盘上的文件内容就没了。
⇒ 与 X1 同一条根（`dill.loads` 未抛异常 == 恢复成功），但后果是**用户数据**而非内核语义。
建议（供决策）：dump 侧把 file/socket/Popen/generator 一类"有外部副作用的对象"列入明确的
"不序列化且必须点名"集合（现在 file 反而被序列化），或 load 侧对 `io.IOBase` 只做只读重开/直接拒。
