# r38 子任务③ — dill/kernel 快照的"代际归属"（只审计不修）

lane: di-*（报告 /tmp/audit_r/round-38/dill-ownership.md，心跳 /tmp/audit_r/round-38/di-heartbeat.md）
仓库：/Users/a1/Desktop/ai/prime-agent（HEAD 只读，未写仓、未 build、未 shutdown）
取证方式：真内核行为（真 ReplKernelManager + 真 rlm.repl `_restore_state` + 真跨解释器 payload），沙箱全在 /tmp。

## 0. RT-3 到底改了什么（先定位，再判残余）
- 写：`prime-agent-runtime/src/rlm/repl.py:1261` `"pythonVersion": sys.version.split()[0]`（写者一直有）。
- 读+闸：`repl.py:1335 _version_mismatch_reason` / `1359 _is_foreign_code_object` / `1375 _carries_foreign_code` /
  `1481 version_mismatch = _version_mismatch_reason(python_version)` / `1516` 命中即进 `failed`（不复活）。
- 主机转发：`packages/coding-agent/src/core/kernel/repl-manager.ts:2979`
  `const payloadPythonVersion = readSnapshotManifest(cfg.manifestPath)?.pythonVersion;`
  `:2985` `...(payloadPythonVersion !== undefined ? { python_version: payloadPythonVersion } : {})`
- 结论：**闸是"payload 的可选外挂侧车字段"**，payload 字节本身不带任何代际/解释器戳。所以"旧代 venv 写的快照在新内核上是否被隔离/拒绝"的答案是：**仅当 sidecar manifest 存在、可解析、且带 pythonVersion 时才拒绝；否则与修复前完全一致**（D1 实测）。

## 1. 关键实证（命令可复现，均为真跑）
环境：loader=3.11.13（真内核解释器 `~/.prime/agent/kernel-venv-51a5d2acd0db/bin/python`，dill 0.4.1）；
writer=3.12.11（`/tmp/di-e2/venv12`）与 3.13.9（`/tmp/di-e2/venv13`），仅 dill。

### E-A 端到端（真 ReplKernelManager + PYTHONPATH=runtime src + /tmp 假 artifact）
脚本 `/tmp/di-e1/e2e.ts`、`/tmp/di-e1/e2e2.ts`，payload 由 3.12/3.13 写，内核是 3.11：
```
[A-version-on-manifest] readSnapshotManifest -> {"savedNames":["f"],...,"pythonVersion":"3.13.9"}
[A-version-on-manifest] restore -> {"restored":[],"failed":[{"name":"f","reason":"python version mismatch: payload 3.13.9, interpreter 3.11.13: functions and classes are not revived"}]}
[B-legacy-manifest-no-pythonVersion] readSnapshotManifest -> {"savedNames":["f"],...,"writtenAtMs":...}   <-- 无 pythonVersion
[B-legacy-manifest-no-pythonVersion] restore -> {"restored":["f"],"failed":[]}
[C-manifest-absent] readSnapshotManifest -> null
[C-manifest-absent] restore -> {"restored":["f"],"failed":[]}
[D-nested-with-version]  restore -> {"restored":["outer"],"failed":[]}   <-- 版本闸在场也放过（见 D2）
```
3.12 payload + 旧式（无 pythonVersion）manifest，真产品路径直接打死内核（e2e2.ts）：
```
restore -> {"restored":["f"],"failed":[]}
{"code":null,"signal":"SIGSEGV","origin":"unknown","kernelPid":38726,... "msg":"kernel exited unexpectedly"}
Error: Python kernel exited unexpectedly (code=null, signal=SIGSEGV, ...); the next cell starts a replacement kernel and restores the last snapshot
```
同一 payload、闸在场的正控（`/tmp/di-e2/loader12_gate.py`）：
```
gate-on restore (python_version=3.12.11): {'restored': [], 'failed': [{'name': 'f', 'reason': 'python version mismatch: payload 3.12.11, interpreter 3.11.13: functions and classes are not revived'}]}
f in ns: False  EXIT=0
```
fail-open 臂（`/tmp/di-e2/loader12.py`，python_version=None，同 payload）：
```
fail-open restore (python_version=None): {'restored': ['f'], 'failed': []}
Segmentation fault: 11   (EXIT=139)   <-- 与 RT-3 记录的现象逐字一致
```

## 发现

### D1（high）版本闸挂在可选侧车文件上：manifest 缺失/不可解析/无字段 ⇒ 闸关，跨解释器外来字节码照常复活并打死内核
- file:line：`repl-manager.ts:2979`、`:2985`；`state-snapshot.ts:303-309`（"Tolerant by design: a missing, torn, or foreign manifest yields `null`"）；
  `repl.py:1335-1349`（`python_version is None → return None`，即不隔离）；`repl.py:1481/1516`。
- 逐字证据：E-A 的 B/C 臂 + 3.12 payload 的 SIGSEGV/EXIT=139；正控 = 同 payload 带 python_version ⇒ 隔离且 EXIT=0。
- 影响：那一刻起内核死、cell 抛 "kernel exited unexpectedly"，模型只看到一次异常，而它刚被告知 "restored: f"（假成功）；
  自动重启内核后会再把同一个 payload 恢复一遍 ⇒ 可复现的连死（RT-3 记录的"3 连死"）。
- 可复现输入：
  `cd /tmp/di-e2 && /tmp/di-e2/venv12/bin/python writer12.py && ~/.prime/agent/kernel-venv-51a5d2acd0db/bin/python loader12.py; echo EXIT=$?`
  端到端：`cd packages/coding-agent && env -u RLM_DEPTH -u RLM_SESSION_DIR -u PRIME_AGENT_SESSION_DIR -u PI_SESSION_DIR DI_PYTHON=<3.11 venv python> npx tsx /tmp/di-e1/e2e2.ts`
- 触发前提（写清）：manifest 是被"容忍读取"的（删掉、写坏、或由不写该字段的旧运行时的 payload 配上），且写/读解释器跨 major.minor
  （真机可用 `PRIME_AGENT_KERNEL_PYTHON` 指向别的 Python，或见 D3 的同代换解释器重建）。
- 本机现状：`~/.prime/agent/**/kernel-state.json` 实测 895 份全带 pythonVersion，所以现网暴露面主要在"manifest 丢失/写坏"与"payload 比 manifest 新"：
  `repl.py:1287 os.replace(tmp, path)` **先提交 payload**，`:1295-1298` 再提交 manifest，manifest 失败直接 `return {"error": "manifest write failed: ..."}`
  ⇒ 磁盘上留的是"新 payload + 旧 manifest（或根本没有 manifest）"，这一对正是 D1 的 fail-open 组合。
- confidence: high（端到端真跑，含正控与反控）。
- 残余面性质：RT-3(decisions 293) 记的是"版本闸缺失"，本条是"闸已加但不覆盖 payload 无侧车/侧车过期的形态"，未被记录。

### D2（medium）版本隔离只到"一层"：深度 ≥2 的容器内函数/类实例仍复活（K3G-3 修复的残余）
- file:line：`repl.py:1375-1397 _carries_foreign_code`（docstring 自述 "The scan is one level deep - members are inspected, never descended into"）。
- 逐字证据（真 `_restore_state`，3.13 写、3.11 读，manifest/参数带 3.13.9）：
  `{"payload": "nested_list_list", "python_version_arg": "3.13.9", "result": {"restored": ["outer"], "failed": []}}`
  `{"payload": "nested_dict_list", "python_version_arg": "3.13.9", "result": {"restored": ["d"], "failed": []}}`
  正控（同解释器、同参数）：`bare` → failed（隔离命中），`instance_of_class` → failed（隔离命中）。
  端到端同一现象：`[D-nested-with-version] restore -> {"restored":["outer"],...}`，随后调用该函数同样崩。
- 影响：外层只包一层容器（如 `rows=[[fn]]`、`cfg={"h": [fn]}`、对象属性里放 list）就绕过隔离；复活后调用与 D1 同一条死法。
- 可复现输入：`cd /tmp/di-e2 && /tmp/di-e2/venv13/bin/python writer13.py && ~/.prime/agent/kernel-venv-51a5d2acd0db/bin/python loader.py nested_list_list 3.13.9 --call`
- confidence: high（真跑+正控）。dedupe：K3G-3(decisions 312) 记的是"只查顶层：dict 内函数、被隔离类实例"，本条是其上一层之外的残余深度。

### D3（medium）"venv 代际"不含解释器版本，不能当解释器代际用
- file:line：`bootstrap.ts:625-631 kernelVenvBuildIdentity`（key = schema/runtime/snapshot/extraUvArgs，**无 python**）、`:29 const PYTHON_VERSION = "3.11"`、
  `:1444 uvRun(["venv", venv, "--python", PYTHON_VERSION, "--seed"])`、`:1752 await rm(venv, {recursive:true, force:true})` → `:1755 bootstrapVenv(...)`；
  世代目录名 = `kernelVenvDirForIdentity` = hash(上面四项)。
- 逐字证据：改 `PYTHON_VERSION`（3.11→3.12）不改变 build identity ⇒ 同一个 `<base>-<12hex>` 目录会被 `rm` 掉再以新解释器重建
  （`decideKernelVenvRebuild` → mode "replace"，参考 `venv-in-use.ts:388-420`）。
- 影响：快照在会话 artifact 目录里（`state-snapshot.ts:snapshotPathIn`），与 venv 代际毫无绑定；解释器线一变，旧 payload 落进新解释器，
  唯一防线就是 D1 那个可选字段。也就是说"代际隔离"在产品里从来没有落在代际上。
- 本机旁证：7 个 kernel-venv 代际共存，其中 4 个（6c7aede708bd / a5018fef522c / b407370ede46 / f224a5179de7）里已安装的 `rlm/repl.py`
  完全没有 `_version_mismatch_reason`（gate=0），另 3 个有（gate=2）；即"代际"与"有没有闸"是两回事。
- confidence: high（读码 + 本机文件对账）。severity 定 medium：需 PYTHON_VERSION 变更或换解释器才触发，但触发后无第二道防线。

### D4（low）快照代际的引用/命名没有生产写者，引用式保护实际永远不生效
- file:line：`retention/kernel-snapshot.ts:58 kernelSnapshotGenerationName`、`:68 kernelSnapshotReferencePath`（`grep` 全仓仅测试消费者：
  `test/kernel-snapshot-reference-states.test.ts`）；`retention/artifact-dirs.ts:166 readKernelSnapshotGenerationState(...)` → `:185 liveSnapshotReferences`。
- 逐字证据：`grep -rn "kernelSnapshotReferencePath\|kernelSnapshotGenerationName" packages/ | grep -v /dist/` 只出 retention/kernel-snapshot.ts 与一个测试文件；
  快照写者仍是 `state-snapshot.ts:snapshotPathIn` 的**原地** `<artifactDir>/kernel-state.dill`。
- 影响：`liveSnapshotReferences` 恒为 0、`snapshotStateUnknown` 恒 false；万一将来写者改用 `kernel-state/<stamp>-<rand>.dill` 而没同时写 `.in-use/<pid>.json`，
  活内核正在读的那一代不会被识别为 referenced，回收面直接退化为"按 mtime 保留最新 1 个"。另 `kernelSnapshotReclaimEnabled` 默认 false（`settings-manager.ts:2592`），故当前无实害。
- confidence: high（grep 穷举 + 读码）。dedupe：ADV-4(decisions 106) 记的是 **venv** 代际回收方向，方向与本条相反/不同面。

## 负结论与正控
- "本机 895 份 manifest 全带 pythonVersion"：`find ~/.prime/agent -name kernel-state.json` + JSON 键统计，输出 `Counter({'pythonVersion': 895})`；
  这是计数型断言，正控为"同一脚本能检出缺失"——注入一份删掉该字段的 manifest 时计数变为 `NO-pythonVersion`（E-A 的 B 臂即该形态，`readSnapshotManifest` 回读确实无 pythonVersion）。
- "无生产写者"的正控见 D4 的 grep 输出（同一条命令能列出测试消费者，说明检索方向有效）。
- 未覆盖（明确标注）：反方向（旧代内核运行时恢复新解释器 payload）没有做真机复现；跨 major.minor 只做了 3.11↔3.12 与 3.11↔3.13 两对；
  快照 generation 回收类的删除路径因 `kernelSnapshotReclaimEnabled=false` 未做真删实验（不写仓也不引入破坏）。

## 心跳
见 /tmp/audit_r/round-38/di-heartbeat.md。
