# r35-heartbeat-goal

冻结: HEAD 438d33383605ed22c6111cf05851486d948e9d5f (2026-09-16 06:58:21 +0800)。只读；本线零 repo 写入。
证据脚本（/tmp 内，非 repo）: /tmp/r35_handle_probe2.py /tmp/r35_handle_probe3.py /tmp/r35_host_liveness_probe.mjs
本线口径: 报告只列本线跑过的原始命令与原始输出片段；未跑活体的条目标 "live 未做"。
去重: `grep -in "buffered|throttl|stale|cell_handles|bashHandles|KERNEL_LIVENESS|heartbeat|goal" docs/fork/audits/decisions.jsonl` → buffered/throttl/cell_handles/bashHandles/KERNEL_LIVENESS 全 0 命中；heartbeat 2 条（F4 DEFAULT_KERNEL_HEARTBEAT_INTERVAL_MS 死导出 / T-A cron 墙钟）、goal 1 条（K3R-11 续跑销毁），均非本线命题。旧条目 F4 的定性不变（复核旧条目 F4：本条与它同域不同命题，F4 是死导出，本条是保留节流与陈旧判定的常数互斥）。

## 结论摘要

- H-1 (P3) 宿主保留节流 `KERNEL_LIVENESS_MIN_SAMPLE_GAP_MS=1000ms` 与陈旧判定 `3 × interval_ms` 互斥：任何 `KERNEL_HEARTBEAT_INTERVAL_MS < 334` 时，健康内核被判 `stale`。对真内核活体实测 59 个采样中 22 个 stale（年龄峰值 1014ms vs 阈值 600ms）。
- H-2 (P3) 心跳事实 `bash.buffered_bytes` / `pipe_pending` 是"最多 8 个 handle 的无序子集和"，不是机队事实：10 个 handle 实际缓冲 715 字节而帧只报 546；杀 handle 使成员变化后报数**上升** 598→650→676（没有任何新输出），宿主据此判 `bashProgress`/`movementToken` 变化并**释放**失速豁免预算（fail-open）。
- H-3 (P3) `bash.cell_handles` 全链路（内核逐帧算、宿主校验并存进 `KernelLivenessSample.bashCellHandles`）在生产**无任何读者**；vouch 用的是机队级 `bash.handles`，于是上一 cell/上一轮遗留的 background handle 能替当前轮"证明有活"。内核刻意算的 per-cell 归因被宿主丢掉（文档还把它写成已交付事实）。
- H-4 (P4) 内核逐帧发的 `host_requests`（`len(_pending_host)`）在宿主样本里记录后无任何读者（`cpu_ms` 同为无读者，但它在 settings.md 里被显式登记为 reserved）。
- H-5 (P4) 心跳线程是 `_write_lock` 的第三个持有者且 `_send` 无写超时：协议管道满（宿主停止读）时心跳线程会停在 `os.write` 里并连带卡住流合并器与主循环的 `result/done`。live 未做（未构造 ≥64KiB 积压）。
- 正结论（协议/门一致性）: 内核 `PROTOCOL_VERSION=4`/`MIN=3`/`DEFAULT=3`、`HEARTBEAT_MIN_PROTOCOL=4` 与宿主 `REPL_PROTOCOL_VERSION=4`/`MIN=3`/`KERNEL_PROTOCOL_V4=4`/`KERNEL_HEARTBEAT_MIN_PROTOCOL=4`/`GATED_EVENT_KIND_MIN_PROTOCOL.heartbeat=4` 五处一致；心跳**不走** `kernel_capabilities()`（只有 `preserve_names`），两侧都是纯版本门，一致。
- 负结论 N1: "goal 在 Python 侧没接线" 为**假**——`goal` 的 Python 面是 bundled skill 包 `packages/coding-agent/skills/goal/src/goal/__init__.py`（`await host_request("goal.get"|"goal.create"|"goal.complete")`），宿主侧在 agent-session.ts:3861 有 `goal.*` 处理器；本会话内核里 `goal` 可直接 import（活体）。真负结论只有一条：**内核 runtime 包（prime-agent-runtime/src）里零 goal**（`grep -rn goal prime-agent-runtime/src | wc -l` = 0，同树同命令 heartbeat = 47 为正控）。
- 负结论 N2: 模型可见面上不存在心跳混线——三套 "heartbeat"（协议帧 `HEARTBEAT_EVENT`、用户级 `/heartbeat` cron、`rlm_heartbeat` Python 技能）中，`rlm-heartbeat/SKILL.md` 首段显式与 `/heartbeat` 划界，而协议 4 活性帧在任何 prompts 里 0 命中。

## 发现

### H-1 保留节流 1000ms 与 `3 × interval_ms` 陈旧阈值互斥 → 健康内核被持续判 stale

- 命题: 宿主 `recordHeartbeatFrame` 的保留下限 `KERNEL_LIVENESS_MIN_SAMPLE_GAP_MS = 1000` 与 `kernelVouchedAlive` 的 `ageMs > 3 × interval_ms` 陈旧判定在同一进程里必然互斥，只要内核上报的 `interval_ms < 334`：节流让"最新保留样本"最多 1s，而阈值只有 `3×200ms = 600ms`，于是**正在按 200ms 发帧的健康内核**被判 stale。
- severity: P3
- file:line: `packages/coding-agent/src/core/kernel/repl-manager.ts:131`（下限）、`repl-manager.ts:717-726`（节流 return）、`packages/coding-agent/src/core/turn-liveness.ts:113-116,293-296`（阈值与判定）、内核侧 `prime-agent-runtime/src/rlm/repl.py:140,1707-1709`（`MIN_HEARTBEAT_INTERVAL_MS = 100`，用户可设）
- 逐字证据（原始命令: `node /tmp/r35_host_liveness_probe.mjs`，脚本用 `dist/core/kernel/index.js` 的 `ReplKernelManager` 驱动真内核 `prime-agent-runtime/.venv/bin/python -m rlm.repl`，`KERNEL_HEARTBEAT_INTERVAL_MS=200`，cell = `await asyncio.sleep(6)`，每 100ms 取 `kernelLiveness` 并用 `dist/core/turn-liveness.js` 的 `kernelVouchedAlive` 判级）:
```
negotiatedProtocol 4
cell status ok
samples 59
stale observations 22 of 59
first 5 stale: [{"t":851,"ageMs":608,"intervalMs":200,"state":"stale","loopAlive":false,"loopStalled":false,"bashProgress":false,"throttled":2,"rejected":0},
 {"t":954,"ageMs":711,...},{"t":1055,"ageMs":812,...},{"t":1156,"ageMs":913,...},{"t":1257,"ageMs":1014,...}]
max ageMs 1014 staleness threshold ms 600
last sample {"t":6033,"ageMs":613,"intervalMs":200,"state":"stale","loopAlive":true,"loopStalled":false,"bashProgress":false,"throttled":22,"rejected":0}
```
  常量逐字: `repl-manager.ts:131` `const KERNEL_LIVENESS_MIN_SAMPLE_GAP_MS = 1_000;`；`turn-liveness.ts:114` `export const DEFAULT_STALE_AFTER_INTERVALS = 3;`；`turn-liveness.ts:296` `const state: KernelLivenessState = ageMs > staleAfterIntervals * intervalMs ? "stale" : "fresh";`
- 影响: 每个被节流掉的帧都不更新 `latest.receivedAt`，于是 `state` 在 fresh/stale 之间周期性翻转。stale 时 `turn-liveness.ts:506-518` 推 `kernelReasons.heartbeatStale` 并**不再走心跳 vouch**，健康长 bash 轮的豁免降级到 journal degraded 路径（只买短档 20 分钟而非 `max(10×warn, 30min)`）；同时失速诊断里出现"the kernel heartbeat is stale"的假机制条目。默认生产值（宿主从不设置该 env，5s→15s 阈值）不受影响。
- 可复现步骤: `cd /Users/a1/Desktop/ai/prime-agent && node /tmp/r35_host_liveness_probe.mjs`（脚本自带 50s 自杀超时）。可达性: 用户 `export KERNEL_HEARTBEAT_INTERVAL_MS=200` 会经 `repl-manager.ts:963-970` 的 `...process.env` 进内核（`repl-manager.ts:968` 同处设置 `PRIME_AGENT_KERNEL_PROTOCOL`），且该旋钮是文档化设置（`packages/coding-agent/docs/settings.md:229`、`prime-agent-runtime/src/rlm/repl.md:154`）。
- 测试盲区: 仓库自己的活体测试 `packages/coding-agent/test/repl-kernel-heartbeat-live.test.ts:18` `const HEARTBEAT_INTERVAL_MS = 200;` 正是这个区间，但它只断言 `latest/previous` 存在与 tick 关系，从不断言判定状态，所以它在这个缺陷存在的前提下仍然全绿。
- confidence: high（活体实测 + 两侧常量逐字）

### H-2 `bash.buffered_bytes`/`pipe_pending` 是 ≤8 handle 的无序子集和 → 能伪造 "movement" 并释放失速预算

- 命题: 内核每帧算的 `bash.buffered_bytes`/`pipe_pending` 只对 `_live_handles` 列表的前 8 个 handle 求和（`handles[:_LIVENESS_PROBE_CAP]`，成员顺序来自一个 set 的迭代序），而宿主把它当成机队事实用作"有东西动了"的证据：`bufferedDelta > 0` 即 `bashProgress = true`，`movementToken` 随之变化，`settleExemptSilenceOnMovement` 据此**释放已累积的静默预算**。handle 集合成员变化（handle 被回收/被杀）会改变被探测的 8 个是谁，于是"报数上升"可以在没有任何新输出的情况下发生。
- severity: P3
- file:line: 内核 `prime-agent-runtime/src/rlm/bash.py:61-63`（`_LIVENESS_PROBE_CAP = 8`）、`bash.py:1106-1130`（`live_handle_facts`，`handles = [h for h in _live_handles if not h._reaped]` 后 `handle._buffer.size()` / `handle._pipe_pending()` 只遍历 `handles[:_LIVENESS_PROBE_CAP]`）、`prime-agent-runtime/src/rlm/repl.py:1733-1744`（进帧）；宿主 `turn-liveness.ts:292`（movementToken 含 `bashBufferedBytes`/`bashPipePending`）、`turn-liveness.ts:299-304`（`bufferedDelta`/`bashProgress`）、`stall-watchdog.ts:678-696`（movement 释放预算）
- 逐字证据（原始命令: `cd prime-agent-runtime && env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_SUBAGENT_ID -u PRIME_AGENT_SESSION_DIR uv run python /tmp/r35_handle_probe2.py`，10 个 handle 各缓冲 13..130 字节）:
```
per-handle buffered bytes: [13, 26, 39, 52, 65, 78, 91, 104, 117, 130] sum: 715
frame fact: {"handles": 10, "cell_handles": 10, "buffered_bytes": 546, "pipe_pending": 0} => under-reported by 169
```
  以及（原始命令 `uv run python /tmp/r35_handle_probe3.py`，同一批 handle 逐个 kill，全程无新输出）:
```
per-handle buffered: [13, 26, 39, 52, 65, 78, 91, 104, 117, 130] total fleet: 715
reported buffered_bytes after killing handle 0..9 in turn (nothing new was produced): [598, 650, 676, 637, 585, 520, 442, 351, 247, 130, 0]
increases seen: [(598, 650), (650, 676)]
```
  机队真实缓冲量单调不增（715 只减），帧报数却出现两次**上升**——纯成员滑窗产物。
- 影响: (a) fail-open：真卡住的轮次只要 handle 集合有变动（后台 handle 被回收、`_cell_handles` 成员进出）就能刷新 `movementToken`，`settleExemptSilenceOnMovement` 把 `segment.since = now`，静默预算被反复清零，武器化的"卡死"可以无限续命；(b) fail-closed 方向：>8 handle 的机队里真正在产出的 handle 落在窗口外时，帧里 `buffered_bytes/pipe_pending` 恒为 0，宿主只能给"存在"短档而不是"移动"全档。
- 可复现步骤: 上面两条命令；无需宿主，直接读 `rlm.bash.live_handle_facts`。
- confidence: high（原始输出 + 逐字代码路径）；宿主侧 `settleExemptSilenceOnMovement` 被 Trigger 的那一端是代码路径证明（未做端到端卡死复现）。

### H-3 `bash.cell_handles` 端到端埋好但在生产无读者；vouch 用机队级 handle 数

- 命题: 内核心跳逐帧计算并发送 `bash.cell_handles`（归因到 in-flight 请求的 handle 数），宿主 `heartbeatFrameProblem` 逐字段校验它、`heartbeatSample` 存成 `KernelLivenessSample.bashCellHandles`，然后**没有任何生产代码读它**；失速 vouch 用的是机队级 `bashHandles`。结果：一个属于上一 cell/上一轮、只是还活着的 background handle，可以替当前轮满足 `liveBashHandles > 0` 的存在性 vouch。
- severity: P3
- file:line: 内核 `prime-agent-runtime/src/rlm/bash.py:1119`、`repl.py:1740`（`"bash": live_handle_facts(rid)`）；宿主 `packages/coding-agent/src/core/kernel/repl-manager.ts:323`（校验字段表）、`:379`（`bashCellHandles: bash.cell_handles`）、`packages/coding-agent/src/core/kernel/shared.ts:436`（声明）；消费端 `turn-liveness.ts:477-482`（只读 `latest.bashHandles`）
- 逐字证据:
```
$ grep -rn bashCellHandles --include=*.ts packages
src/core/kernel/repl-manager.ts:379:		bashCellHandles: bash.cell_handles,
src/core/kernel/shared.ts:436:	bashCellHandles: number;
（其余命中全是 test/ 夹具，例如 test/turn-liveness.test.ts:229 latest: sample({ tick: 40, bashHandles: 1, bashCellHandles: 1 })
$ grep -rn cell_handles --include=*.ts packages/coding-agent/src
src/core/kernel/repl-manager.ts:323:const HEARTBEAT_BASH_FIELDS = ["handles", "cell_handles", "buffered_bytes", "pipe_pending"] as const;
src/core/kernel/repl-manager.ts:379:		bashCellHandles: bash.cell_handles,
```
  正控（同一条 grep 手段能检出已知被消费的兄弟字段）:
```
$ grep -rn liveBashHandles --include=*.ts packages/coding-agent/src
src/core/turn-liveness.ts:477:			liveBashHandles = kernel?.latest?.bashHandles;
src/core/turn-liveness.ts:478:			if ((liveBashHandles ?? 0) > 0) {
src/core/turn-liveness.ts:479:				reasons.push(STALL_VOUCH_REASONS.liveBashHandles);
（+ stall-watchdog.ts:868,881,890 消费/渲染）
```
  内核侧把它写进文档当成已交付事实: `prime-agent-runtime/src/rlm/repl.md:54-56` "or an O(1) snapshot of the bash registries (`rlm.bash.live_handle_facts`: live handles, **handles attributed to this cell**, buffered bytes, ...)"。
- 影响: per-cell 归因在链路上被丢掉；测试夹具一律把 `bashCellHandles` 与 `bashHandles` 同设（`bashHandles: 1, bashCellHandles: 1`），暗示了一条没有任何代码实现的语义，改动/回归时这条断言是哑的。
- 可复现步骤: 上述两条 grep + `live_handle_facts("other-cell")` 返回 `cell_handles: 0`（内核侧归因确实存在，见 `test/test_repl_heartbeat.py:244`）。
- confidence: high（grep 全仓 + 正控）。注：机队级 vouch 的语义在 `repl-manager.ts:695-701` 与 `turn-liveness.ts:480` 注释里被写成"存在即活"，但那条注释与内核刻意的 per-cell 字段并存，二者没有一个被判定为该字段的用途；本条定性为"字段死 + 归因丢失"，不主张"vouch 一定错"。

### H-4 内核 `host_requests` 事实无宿主读者

- 命题: `_heartbeat_facts` 每帧发 `"host_requests": len(_pending_host)`（内核侧待答 host_request 数），宿主存进样本 `KernelLivenessSample.hostRequests` 后无任何读者；宿主用的是自己那份 `inFlightHostRequests.size`。
- severity: P4
- file:line: `prime-agent-runtime/src/rlm/repl.py:1741`；`packages/coding-agent/src/core/kernel/repl-manager.ts:377`、`shared.ts:432`；`turn-liveness.ts` 全文 0 命中
- 逐字证据:
```
$ grep -rn "hostRequests" packages/coding-agent/src
src/core/kernel/repl-manager.ts:377:		hostRequests: event.host_requests as number,
src/core/kernel/shared.ts:432:	hostRequests: number;
src/core/stall-diagnostics-render.ts:144:				...(typeof hostRequestCount === "number" ? [`hostRequests ${hostRequestCount}`] : []),   // 这是 facts.hostRequestCount（宿主自己数），不是样本字段
正控（同手段检出被消费的兄弟字段）: grep -rn hostRequestCount packages/coding-agent/src → kernel/repl-manager.ts:631-633、turn-liveness.ts:446-449（参与 vouch）
```
- 影响: 每帧多带一个无人读的整数；内核侧 `len(_pending_host)` 的读取与语义没有任何外部校验，属于"看起来是配置/事实其实不可读"的那类死字段（与旧条目 F4 同型）。
- 可复现步骤: 上面两条 grep。
- confidence: high

### H-5 心跳线程是 `_write_lock` 的第三个无超时持有者

- 命题: `_send` 在 `_write_lock` 下做完整 `os.write` 循环且**没有写超时**；心跳线程每 interval 走一次 `_send`，于是它成为该锁的第三个持有者（前两个是流合并线程与事件循环线程）。宿主停止读协议管道（管道满）时，心跳线程会停在 `os.write` 里并一直持有 `_write_lock`，连带卡住流合并器与主循环的 `result`/`done` 发送。
- severity: P4
- file:line: `prime-agent-runtime/src/rlm/repl.py:153-170`（`_send`，`while view: view = view[os.write(_protocol_fd, view):]`，仅 `except OSError: pass`）、`repl.py:1788-1801`（`_send_heartbeat`）、`repl.py:1822-1831`（`_heartbeat_loop`，`time.sleep(interval)` 后无条件 `_heartbeat_once()`）
- 影响: 方向是 fail-safe（丢帧只让心跳变老），但一旦管道停滞，宿主可用的证据只剩 degraded journal 路径，同时内核再也发不出 `done`（宿主只能超时杀）。另：`_heartbeat_loop` 对 `_heartbeat_once` 无 try（`_heartbeat_once` 内部兜住异常，故线程不会因异常死掉，但会被阻塞）。
- 可复现步骤: live 未做（未构造 ≥64KiB 协议积压 + 停止读端）。代码路径级别证据如上。
- confidence: medium（代码路径读出；未做活体全管道停滞复现）

## 负结论与正控

- N1 `goal` 的 Python 侧接线**存在**，只是不在内核 runtime 包里（命题：内核 runtime 包零 goal 代码）。
  命令与输出（同一棵树、同一命令手段，heartbeat 为已知存在的正控）:
```
$ cd /Users/a1/Desktop/ai/prime-agent && grep -rn "goal" prime-agent-runtime/src | wc -l
       0
$ grep -rn "heartbeat" prime-agent-runtime/src | wc -l
      47
```
  实际接线位置: `packages/coding-agent/skills/goal/src/goal/__init__.py`（`await host_request("goal.get")` / `("goal.create", {...})` / `("goal.complete")`，逐字 docstring "All goal state lives in the TypeScript host; these functions are thin typed wrappers over the generic host bridge (`rlm.host_request`)"）+ 宿主 `agent-session.ts:3861` "Handle a goal.* request from the Python kernel host bridge"。`rlm_heartbeat` 完全同构（`skills/rlm-heartbeat/src/rlm_heartbeat/__init__.py` → `rlm_heartbeat.list/create/update/delete`，宿主 `agent-session.ts:4013 handleRlmHeartbeatHostRequest`，case 4019/4027/4049/4088）。活体: 本会话（真内核）里 `import goal` / `import rlm_heartbeat` 均可用。
- N2 模型可见面上不存在心跳混线。三套机制: (1) 协议 4 活性帧 `HEARTBEAT_EVENT = "heartbeat"`（`repl.py:134`，纯 wire 帧，宿主 `repl-manager.ts:1771-1775` 在 id 归因之前就 dispatch，测试断言 `expect(result.stdout).not.toContain("heartbeat")`）；(2) 用户级 `/heartbeat` cron（`cron-jobs.ts:181 DEFAULT_HEARTBEAT_SCHEDULE`、`slash-commands.ts:182`）；(3) `rlm_heartbeat` Python 技能（会话内 cron）。`skills/rlm-heartbeat/SKILL.md` 首段逐字: "They are separate from the user's visible `/heartbeat`: this skill cannot read, replace, pause, resume, or clear that user-level heartbeat."；协议帧在 prompts 里 0 命中（`grep -rln heartbeat src/core/prompts` 无输出）。正控: 同一 grep 手段在 runtime 树里能检出 47 处以 "heartbeat" 命名的代码（见 N1）。
- N3 生产代码从不设置 `KERNEL_HEARTBEAT_INTERVAL_MS`（所以 H-1 只在用户显式 export 时可达）。`grep -rn KERNEL_HEARTBEAT_INTERVAL_MS` 全仓命中只有 runtime 自身、`docs/settings.md`、`repl.md` 与两个测试（`test/repl-kernel-heartbeat-live.test.ts:112`、`test/test_repl_heartbeat.py:263`）。正控: 同一类手段能检出兄弟协商变量的生产写入点 `repl-manager.ts:968 [KERNEL_PROTOCOL_ENV_VAR]: requestedKernelProtocol(this.options.env),`。
- N4 正常路径正向结论（免得本线只报缺陷）: 协议门两侧一致——内核 `repl.py:45-52 PROTOCOL_VERSION = 4 / MIN_PROTOCOL_VERSION = 3 / DEFAULT_PROTOCOL_VERSION = 3`，`repl.py:137 HEARTBEAT_MIN_PROTOCOL = 4`，`repl.py:1727/1761/1839` 三处门（含 `_start_heartbeat` 不 gate 就 return）；宿主 `repl-manager.ts:98-104 REPL_PROTOCOL_VERSION = 4 / REPL_PROTOCOL_VERSION_MIN = 3 / KERNEL_PROTOCOL_V4 = 4`，`repl-manager.ts:120 heartbeat: KERNEL_PROTOCOL_V4`，`turn-liveness.ts:90 KERNEL_HEARTBEAT_MIN_PROTOCOL = 4`；`kernel_capabilities()` 只声明 `preserve_names`（`repl.py:88-93`），心跳是纯版本门、两侧一致。内核测试全绿正控: `cd prime-agent-runtime && env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_SUBAGENT_ID -u PRIME_AGENT_SESSION_DIR uv run python -m unittest discover -s test -p "test_repl_heartbeat.py" -v` → `Ran 13 tests in 11.156s / OK`（A/B tick、finishing 归因、protocol-3 静默、bash handle 事实均已钉住）。

## 未做/存疑

- H-2 的宿主端后果（`settleExemptSilenceOnMovement` 被伪造 movement 释放预算 → 卡死轮不 abort）只做到代码路径级，未做端到端卡死复现（需要一个可控的真失速轮 + 伪造 handle 集合churn）。
- H-5 live 未做（未构造协议管道满 + 停止读端）。
- `dist/` 与 `src/` 的一致性: H-1 的活体探针跑的是 `packages/coding-agent/dist/core/...`（生产 CLI 用 dist），已核对 dist 含同一常量与同一 stale 判据（`grep -c KERNEL_LIVENESS_MIN_SAMPLE_GAP_MS dist/core/kernel/repl-manager.js` = 2，`dist/core/turn-liveness.js:105/135` = 源码同式）；但未做全量 src↔dist 等价性证明（dist 为 gitignore 的构建产物，mtime 06:40 早于 HEAD 提交时间 06:58）。
- H-1 里"stale 会不会真的导致健康轮被 abort"取决于 warn/abort 阈值与采样相位（stale 翻转是周期性的），未做 300s/900s 尺度活体。
- 未审: `rlm_heartbeat` 技能触发的投递链路（steer/follow_up、busy 时 defer）在 TS 侧的执行正确性——那是本线之外的 TS 侧机制；本线只钉了 Python 侧桥接与内核活性帧。
