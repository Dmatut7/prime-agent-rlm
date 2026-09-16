# r43 K3: ma-p0-1-long-cell-survives "ordinary threshold" CI 独红 — 看门狗竞窗诊断

冻结 SHA：ac1ec28e9（主仓 HEAD）。工作树：/tmp/audit_r/round-43/wt-k3stall（诊断结束后已还原干净，未提交任何改动）。
CI 红签名：`expect(warning.diagnostics.kernel?.reasons).toEqual(["loop_stalled"])` 实得 `["heartbeat_stale"]`（"still aborts a wedged kernel at the ordinary threshold"，ma-p0-1-long-cell-survives.test.ts:242）。

## 结论（TL;DR）

**根因不是混钟、不是 stepNow、也不是分类器顺序，而是"判决时刻先于事实时刻"的采样倒挂**：聚合器 `sample()` 先取判决钟 `at = now()`，再调用事实源 `kernel()`；而测试夹具把 `receivedAt: Date.now()` 盖在 `kernel()` 回调**内部**。于是 `rawAgeMs = at - receivedAt ≤ 0` 是系统性的，只要两次 `Date.now()` 之间跨过 1ms 边界（或事件循环被抢占 ≥1ms），`rawAgeMs < 0` 就触发 fail-closed 判 stale，分类器走 stale 分支报 `heartbeat_stale`，`loop_stalled`（只在 fresh 分支上报）被挤掉。本机空闲时每次采样跨越概率约 0.009%（实测 27/300000），CPU 打满升到 0.022% 且最大负龄 3ms；CI 共享 vCPU + vitest 并行 worker 把它推到百分点级 → 间歇独红。

**修法推荐：把 `at = now()` 挪到 `kernel()` 之后（一行，时钟归一/采样顺序修正）**——已在本工作树做丢弃式验证：同一行挪动后，极端确定性抖动（每次 Date.now +1ms）下 9/9 全绿，邻近 liveness 三套件 56/56 全绿。已还原。

## ① 红证（本地稳定复现 CI 红）

基线：未改代码，目标文件本地 9/9 绿（5537ms）。

确定性复现（投掷式副本 zz-r43-jitter-repro.test.ts = 原文件 + 头部补丁 `Date.now = () => real + ++offset`，单调、每调用 +1ms，模拟"两次读必跨边界"）：

```
FAIL  ... > still aborts a wedged kernel at the ordinary threshold
AssertionError: expected [ 'heartbeat_stale' ] to deeply equal [ 'loop_stalled' ]
 ❯ zz-r43-jitter-repro.test.ts:242:47
```

与 CI 红签名逐字一致。

随机抖动版（每调用 p=0.5 累加 +1ms，单调不减）连跑 6 次：**5 红 1 绿**——间歇性复现，正是 flake 形态。

无补丁自然复现：10 核 `yes` 打满 CPU 连跑 8 次 0 红——本机调度尾延迟太低，与"本机 10+ 连绿"吻合；跨越概率实测见下。

机制单元证（mech-proof.mts，直接调 createTurnLiveness，夹具照抄 wedgedKernelFacts）：

```
judge lags fixture by 0ms -> state=fresh  kernelReasons=["loop_stalled"]
judge lags fixture by 1ms -> state=stale  kernelReasons=["heartbeat_stale"]
judge lags fixture by 2ms -> state=stale  kernelReasons=["heartbeat_stale"]
rawAgeMs=-1 verdict: state=stale loopStalled=true ageMs=0
```

最后一行值得注意：**stale 时 `verdict.loopStalled` 仍为 true**——证据一直在，是被分类器的分支结构掩盖，不是算错。

## ② 机制定位（三个候选逐一裁决）

### 裁决 1：不是混钟

- 判决钟：`createTurnLiveness` 的 `now = options.now ?? Date.now`（turn-liveness.ts:383）；会话 `_createTurnLiveness`（agent-session.ts:4689-4697）**不传 now** → 恒为 `Date.now()` 墙钟。
- 事实钟：生产路径 `recordHeartbeatFrame`（repl-manager.ts:725）在帧到达时 `const now = Date.now()` 盖 `receivedAt`——同一墙钟，且**先到达、后判决**，方向正确，生产中 `rawAgeMs ≥ 0` 恒成立（除非真 NTP 回拨）。
- 测试路径：夹具 `sample()` 在 `kernel()` 回调内盖 `Date.now()`（测试文件 :34），而聚合器 `sample()` 先取 `at`（turn-liveness.ts:463）再调 `options.kernel()`（:464）——同一墙钟，但**顺序倒挂**：判决时刻在前、事实时刻在后，`rawAgeMs ≤ 0` 是系统性的，不是随机噪声。

### 裁决 2：与 stepNow 无关

`stepNow`（stall-watchdog.ts:390-394，StepCompensatedClock @ clock-step.ts）只驱动看门狗自己的 budget/deadline/silentMs 算术。`vouch()` 谓词不收时间参数（evaluateExemption 里 `this.options.vouch?.()`），聚合器 `sample()` 无参——**stepNow 的值永远进不了 `kernelVouchedAlive`**。stepNow 在 CI 上的形态与本 flake 无关。母席线索②③指向的"混钟"精确化后就是裁决 1 的倒挂：不是两个钟，是同一个钟按错误顺序读了两次。

### 裁决 3：不是分类器"顺序"问题，是分类器"互斥分支掩盖"问题（次要共谋）

turn-liveness.ts:511-547：

```
if (verdict.state === "fresh") {
    ...
    if (verdict.loopStalled && verdict.cellAwaiting && !verdict.cellFinishing)
        kernelReasons.push(loopStalled);      // :539 —— 只在 fresh 分支
} else {
    if (verdict.state === "stale")
        kernelReasons.push(heartbeatStale);   // :543 —— stale 分支只报这个
    ...
}
```

两个 reason 不存在"同时可报、谁排前面"的顺序问题——它们处在互斥分支里。1ms 的跨越把 state 从 fresh 翻成 stale，`loopStalled` 的证据（仍然是 true）就根本不会被读到。这个结构在生产语义下是**可辩护的**（stale 心跳的冻结 tick 是旧闻，不该当现状报），所以不该为迁就测试去改它——它是共谋放大器，不是 bug 本体。

### 完整因果链

1. 夹具在 `kernel()` 内盖 `receivedAt = Date.now()`，聚合器先取 `at` → `rawAgeMs = -(两次读之间的耗时)`；
2. `kernelVouchedAlive`（:325）`rawAgeMs < 0 → stale`——对生产 NTP 回拨是刻意的 fail-closed，对夹具的未来时间戳过敏；
3. 分类器互斥分支：stale ⇒ 只报 `heartbeat_stale`，`loop_stalled` 被掩盖；
4. 断言钉死精确 reason 列表 → 1ms 抖动 = 测试红。

同一机制也解释了 5e63da951 修掉的 "stall stage" flake：`_refreshStallDegradedFacts` 在 `tool_execution_start` 也会触发一次采样，倒挂+跨边界会让 state 提前变 stale → 翻转前就读了 journal。5e63da951 把断言钉到翻转时刻绕过了它，但夹具倒挂本体留着，这次咬在 "ordinary threshold" 上。

## ③ 修法建议（三选一：选"时钟归一"，附验证）

**推荐：把 `sample()` 里 `const at = now()` 挪到 `const kernel = options.kernel()` 之后（turn-liveness.ts:463-464 两行对调）。**

理由：
- 倒挂是聚合器接缝处的结构性地雷，不是这一个夹具的笔误——任何"在调用时盖当前时刻"的事实源（最自然的写法）都会被一个来自自己过去的钟判决。生产的真源靠"帧到达时盖章"才碰巧免疫。
- 判决时刻取在事实读取之后，语义严格更正确："verdict as-of 事实读完之后"。所有用 `at` 的比较（revival 龄、degraded 龄、hostRequest 龄）锚点都在事实之前或之中，无一受损。
- `rawAgeMs < 0 → stale` 的 fail-closed 规则原样保留，且仍可达：生产中帧到达与采样之间真发生墙钟回拨时它照旧触发。规则的设立目的不受损。
- 一行改动，无协议/形状变化。

**丢弃式验证（已还原，未提交）**：本工作树对调这两行后——
- 极端确定性抖动（每调用 +1ms，红证同款）下 ma-p0-1 全文件 **9/9 绿**；
- 邻近套件 turn-liveness.test.ts + turn-liveness-degraded-closure.test.ts + stall-watchdog-tool-liveness.test.ts **56/56 绿**；
- 无抖动基线 9/9 绿。

**可选加固（测试夹具归一，建议与上行一起做但不是必需）**：ma-p0-1 的夹具把 `receivedAt` 锚到测试开始时捕获一次的 `T0`（或 `T0 - ε`），而不是每次调用盖 `Date.now()`。这更贴生产语义（receivedAt 是帧到达时刻，永远在过去），也与同仓 turn-liveness.test.ts 的既有纪律一致（该文件全部用固定 T0 + 注入假钟，所以它对本次 flake 免疫）。注意：聚合器修好后夹具不改也不再红，此条只是让夹具"说真话"。

**不建议：改分类器让 stale 也报 loop_stalled。** stale 心跳里的冻结 tick 是"最后一次见到时"的旧证据，当现状上报会污染生产 stall 诊断（用户会被指向一个并不确定的死锁形状）；且这是为迁就测试改动用户可见语义。掩盖结构在生产语义下可辩护，留着。

## 附：量化数据

- 本机空闲，300k 次"夹具形状"采样：rawAgeMs<0 共 27 次（0.009%），最大负龄 1ms → 本机连绿的原因。
- 10 核打满：67/300k（0.022%），最大负龄 3ms → 负载单调放大。
- CI（共享 vCPU、vitest 多 worker 并行、虚拟化时钟粒度更粗）推到百分点级，且被断言的 warning 事件每次只采一次样——单次采样即定生死。

## 工件

- /tmp/audit_r/round-43/mech-proof.mts — 单元机制证
- /tmp/audit_r/round-43/straddle-probe.cjs — 跨越概率探针
- 工作树 /tmp/audit_r/round-43/wt-k3stall — 已还原干净（git status 空），投掷式复现文件已删除
