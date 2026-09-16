# r39-Q5 多源并发同刻到达的确定性（r39-q5-multisource）

- 仓：/Users/a1/Desktop/ai/prime-agent，HEAD `e8f6527dc44a548d961cdf336bd514bcafa24fa7`，**只读**，仓库零写入（`git status` 仅他人 lane 的未跟踪文件）。
- 实测工件：`/tmp/audit_r/round-39/multisource.q5.test.ts` + `/tmp/audit_r/round-39/vitest.q5.config.ts`（用仓库自带 `test/suite/harness.ts` + faux provider，绝对路径 import，测试文件在 /tmp）。
- 运行命令（本线全部通过，EXIT=0）：
  ```bash
  cd /Users/a1/Desktop/ai/prime-agent/packages/coding-agent && \
  env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_CHILD_ID -u RLM_NAME -u RLM_MODEL \
      -u PRIME_AGENT_SESSION_DIR -u PI_SESSION_DIR \
  node ../../node_modules/vitest/dist/cli.js --run --reporter=verbose \
      --config /tmp/audit_r/round-39/vitest.q5.config.ts
  ```
  日志：`/tmp/audit_r/round-39/q5-run5.log`（8/8 通过）。对照基线：仓内 `test/suite/agent-session-queue.test.ts` 的 `S1: delivers mid-run steering, follow-up, command, and custom inputs in order` 在同 SHA 下 ✓（`/tmp/audit_r/round-39/q5-s1.log`）。

## 结论（一句话）

同刻多源到达时，"谁是第一条"**不由到达时刻决定，也不由事件循环偶然序决定**，而由三层结构性规则决定：
1. **lane 优先级**（`selectFirst()`：`nextTurnBoundary` 数组恒先于 `whenRunIdle`）；
2. **入队调用序**（同一 lane 内 = `_actionStore.enqueue()` 的调用先后，数组 push，FIFO）；
3. 而"入队调用何时发生"取决于该入口在 `_admitSessionInput` 之前**有没有 await**：无 await 的同步入口（`steer()`/`followUp()`/notice 入队/restore）在同一 tick 内立即入队；有 await 的入口（commit fence、async `_normalizeSubmission`）要等 microtask 续体。**因此同步源的输入必然在同一 tick 内插队到异步准入源前面**——这不是偶然，是确定的结构；唯一真正依赖事件循环的是"扩展 async input handler 的完成时刻"（F2）。

## 0. 机理与逐字证据

`ActionStore` 是两条数组，入队即 push（`session-action-store.ts:213-216`、`:327-329`）：

```ts
	enqueue(action: TAction): void {
		this.assertNewAction(action);
		this.list(action.delivery).push(action);
		...
	selectFirst(): TAction | undefined {
		const action =
			this.nextTurnBoundary.find((item) => item.lifecycle.state === "queued") ??
			this.whenRunIdle.find((item) => item.lifecycle.state === "queued");
```

准入本身**全同步**：`_admitSessionInput`（`agent-session.ts:7934`）从入参到 `this._actionStore.enqueue(action)`（`:7977`）**无任何 await**；`_queuePreparedPrompt`（`:8006`）虽标 `async`，函数体内在 `_admitSessionInput` 之前没有 await，所以 `await this._queuePreparedPrompt(...)` 的入队发生在调用者的**同步前缀**里。

异步侧的 await 点：
- `_promptInjectedMessage`（心跳/cron 注入）在准入前 `await this._acquireDirectTurnAdmissionFence(...)`（`:7136`），随后到 `_admitSessionInput`（`:7174`）之间全同步 → fence FIFO 决定其相对次序。
- `_prompt`（直接 prompt/agent-message `promptAndWait`）非流控态同样先 `await this._acquireDirectTurnAdmissionFence`（`:7218`），且 `run()` 内 `_normalizeSubmission` 可能再 await（`:7240`）。
- `_acquireSessionActionCommitFence`（`:9239`）是显式 FIFO 链：`previous = this._sessionActionCommitTail; this._sessionActionCommitTail = new Promise(...); await waitForPromiseOrAbort(previous, ...)`（`:9244-9253`）——tail 的**换链发生在同步前缀**，所以同刻多个 fence 型入口保持调用序。
- `_normalizeSubmission` 返回 Promise 的唯一条件（`:6033` 起）：`policy.inputSource !== undefined && this._extensionRunner.hasHandlers("input")` → 有扩展注册了 `input` handler 时，用户 prompt 的入队时刻 = handler 完成时刻。

泵侧：`_pumpSessionInputs` 的取头发生在 `await this.agent.waitForIdle()` / `await this._agentEventQueue` / `await this._waitForRefineIdle()` 之后（`:8088/8103/8104`），但 `selectFirst()` 调用本身（`:8116`）同步取当下数组头 → 选择点之前的所有入队都被看见，不存在"陈旧快照"问题。

## 1. 入队入口枚举（source / lane / 准入是否同步）

| # | 入口 | file:line | delivery lane | wake | 入队是否同步前缀 |
|---|------|-----------|---------------|------|------------------|
| E1 | `steer()` API（用户 steering） | `core/agent-session.ts:7470-7494`（`_queuePreparedPrompt("steer")` @7489） | next_turn_boundary | immediate（默认 wake） | **是**（normalize 同步、无 fence） |
| E2 | `followUp()` API | `:7503-7527`（@7522） | when_run_idle | 默认 | **是** |
| E3 | `sendCustomMessage(deliverAs steer/followUp)`（流控态） | `:8615-8644`（@8635/8640） | 两 lane | 默认 | **是** |
| E4 | `sendCustomMessage(triggerTurn)`（空闲态） | `:8645-8663`（`await _acquireDirectTurnAdmissionFence` @8647，admit @8657） | when_run_idle（queueVisible:false） | 默认 | **否**（fence） |
| E5 | 用户交互提交：interactive-mode → `agentConnection.prompt` | `modes/interactive/interactive-mode.ts:1656, 5182, 10424` → `_prompt` `:7209`（fence @7218 / normalize await @7240 / admit @7343） | followUp/steer | 默认 | **否**（fence；流控态无 fence 但可能 async normalize） |
| E6 | daemon `steer` / `follow_up` 命令 | `modes/daemon/daemon-mode.ts:4497 / 4521` | 同 E1/E2 | 同 | **是**（非 worker 面 handleLine→handleCommand→session.steer 全同步前缀；每帧 `void handleLine(line)` @3477，`attachJsonlLineReader` 同步逐行回调 `jsonl.ts:43`） |
| E7 | daemon `prompt` / `prompt_and_wait` 命令 | `:4450-4454`（`promptUntilAccepted`/`acceptAgentMessagePrompt`，`void prompt(...)`） | followUp/steer | 默认 | **否**（fence / agent-message 见 E8） |
| E8 | 子代理回执（agent_message 落到收件方） | `core/agent-session.ts:6187-6234` → 流控挂起分支 `queueAgentMessagePrompt` `:6236-6280`（@6263/@6272，同步）；否则 `_prompt`（`:6221`，skipInputHandlers→normalize 同步；空闲态仍过 fence） | steer 或 followUp | 受 `subagentWakePolicy` 控制（默认不 wake，见注释 @6241-6260） | 流控态**是**；空闲态**否**（fence） |
| E9 | RLM child terminal 通知（synthesized） | `:14496` `deliverTerminalMessageToParent` → `_deferRlmTerminalNotice`（`await _acquireRlmTerminalNoticeRetentionFence`，push 到 pendingNextTurn）→ `_flushDeferredRlmTerminalNotices` → `_enqueueRlmTerminalNoticeAction` `:6860-6878`（admit @6872，wake:false） | when_run_idle（queueVisible:false） | **不 wake** | 中间有 fence await；flush 后入队同步 |
| E10 | 失败聚合 wake | `:7021-7104`（admit @7074，wake:false） | when_run_idle | 不 wake（自己 `wakeSuspendedSessionInput`） | **是** |
| E11 | 心跳/cron（heartbeat 类） | `modes/daemon/daemon-mode.ts:2007` → `promptHeartbeat` `:6282` → `_promptInjectedMessage`；默认 `deliveryMode=steer`（`cron-jobs.ts:192`）→ lane steer | immediate | **否**（fence） |
| E12 | 非心跳 cron | `daemon-mode.ts:1984` `session.followUp(...)`（忙时）/ `:2021` `promptUntilAccepted`（空闲） | when_run_idle | 默认 | 忙时**是**；空闲**否** |
| E13 | goal 续作 / 预算提示 | `:2999`（followUp）、`:3021`（front:true, wake:false）、`:3126`/`:5184`（steer，budget_limit） | 两 lane | 默认/不 wake | **是**（全同步前缀） |
| E14 | 阈值压缩后续作（autonomous continuation） | `:3726`（await `nextAutonomousContinuation` 之后 admit，arrivalEpoch 失效保护） | when_run_idle | 默认 | 否（前有大模型生成 await） |
| E15 | restore（重启清单回填 / ACP replay 字段） | `:7614`（restore:true）、`:7636`、`restoreSteeringMessage` `:7659+`、`_restorePromptInput` @7646 | 原 lane | restore 不 wake | **是** |
| E16 | rpc-mode `steer`/`follow_up`/`prompt` | `modes/rpc/rpc-mode.ts:229/232/224` | 同 E1/E2/E5 | 同 | 同 E1/E2/E5 |
| E17 | ACP `session/prompt` | `modes/acp/acp-mode.ts:905`（`promptAndWait`，followUp + queueIfBusy；前面 `await entry.inputPauseRelease`/`pendingTerminal` @865/868） | when_run_idle | 默认 | **否**（多重 await；但协议层同时只允许一条在跑 @879） |

## 2. 判定：同刻到达谁在前

### F1 — 同一 tick 内，同步准入源插队到异步（fence）准入源之前；跨类次序不由"先到"决定
- **severity: low**（确定性强、窗口 = 亚毫秒/microtask；但确实违背"先到先得"直觉，且在 transcript 上可观测）
- **file:line**：`agent-session.ts:7934`（同步 admit；enqueue 在 `:7977`）、`:7489/:7522`（同步入队 API）、`:7136`+`:7174`（心跳先 await fence 再 admit）、`:9244-9253`（fence FIFO 换链）
- **逐字证据（实测，非静态推断）**：P2 用例——`promptHeartbeat` 先调用、`followUp` 后调用，队列顺序相反：
  ```
  ✓ ... > P2 heartbeat invoked BEFORE followUp in the same tick enqueues AFTER it
  ✓ ... > P2c structural control: swapping the invocation order leaves the queue order identical
  ✓ ... > P2d end-to-end: the same-tick reorder is observable in the transcript, not just the queue view
  ```
  P2 断言原文：`expect(s.getFollowUpMessages()).toEqual(["anchor", "user-p2", "heartbeat-prompt-p2"])`；P2d 转录序（真实跑出的消息序列）：
  ```
  ['start','anchor','user-p2d'(user), 'heartbeat-prompt-p2d'(custom)]   // user-p2d 先交付
  ```
  P2c：交换两行的调用顺序，队列结果**完全相同** → 证明这是"同步源恒胜"的结构规则，不是调度噪声（正控之一）。
- **影响**：同 tick 内用户输入与心跳/定时任务/空闲态 agent-message 撞车时，用户输入总在前；对"心跳指令引用刚敲的用户消息"这类语义耦合，顺序可与逻辑到达序相反。lane 差异（steer 恒优先）本身是设计（母席坐标系已确认）。
- **可复现**：`/tmp/audit_r/round-39/multisource.q5.test.ts` → `P2`、`P2c`、`P2d`（命令见上）。
- **confidence: high**（实测）。

### F2 — 唯一真正"依赖事件循环偶然序"的口子：扩展 async `input` handler 的完成时刻决定同 lane 入队序
- **severity: medium**（需要第三方扩展注册 async input handler；一旦发生，同 lane 两条用户 prompt 的相对顺序由 handler 延迟决定，可任意拉大，不再是 microtask 级窗口）
- **file:line**：`agent-session.ts:6033-6061`（`_normalizeSubmission` 仅当 `inputSource !== undefined && hasHandlers("input")` 返回 Promise）、`:7240`（`await normalizationResult` 位于 admit `:7343` 之前；流控态 `:7216` 不取 fence，两条 prompt 各自独立 await）
- **逐字证据（实测）**：
  ```
  ✓ ... > P5 async extension input handler: later prompt with fast handler overtakes earlier slow one
  ✓ ... > P5c control: with equal-latency handlers, same-tick prompts keep call order
  ```
  P5：先 `prompt("p5-slow")` 后 `prompt("p5-fast")`，handler 对 slow 挂 deferred；`setTimeout(10ms)` 后队列已是 `["anchor","p5-fast"]`（后到者先入队），释放后队列 `["anchor","p5-fast","p5-slow"]`。P5c 正控：handler 等延迟时队列 = 调用序 → 探针确实能读出换序，不是恒真。
- **影响**：有 async input 中间件（转换/审计类扩展）时，用户消息之间、以及用户消息与任何同步入队源之间的顺序由 handler 延迟决定；daemon/interactive/rpc 面同样受影响（`E5/E6/E16` 的 prompt 路径）。steer/followUp API（E1/E2）与 notices（E9/E10）不走 normalize，不受影响。
- **可复现**：同上 `P5`、`P5c`。
- **confidence: high**（实测）。

### F3 — 同 class（fence 型）多源之间是确定 FIFO；换调用序必换结果（负结论"顺序确定"带正控）
- **severity: info**
- **file:line**：`:9239-9253`（`previous`/新 tail 换链在同步前缀；`await waitForPromiseOrAbort(previous)` 续体按链序）
- **逐字证据**：
  ```
  ✓ ... > P3 two heartbeats (same fenced class) admit in call order; reversing calls reverses the queue
  ```
  先 A 后 B → `["anchor","hb-a-prompt","hb-b-prompt"]`；换新 harness 先 B 后 A → `["anchor","hb-b-prompt","hb-a-prompt"]`。同一探针在两个方向都报警/放行 → 证明该序由 fence 调用序决定，非偶然。
- **影响**：无（正面结论）。
- **confidence: high**（实测）。

### F4 — daemon 侧 `session.input` 面：非 worker 传输对 `steer`/`follow_up` 是"帧序 = 入队序"；worker 传输在 `prompt`/命令前多一个 claim await，属静态风险点
- **severity: low（worker 面，仅静态推断）**
- **file:line**：`daemon-mode.ts:3477`（`void this.handleLine(client, line)`，逐行并发但同步前缀）、`jsonl.ts:28-43`（同一 data 事件内同步逐行回调）、`:3855`（`await this.handleCommand(...)` 是 handleLine 到达 admit 前的第一个 await，而 `handleCommand` 的 `case "steer"` `:4486-4504` / `case "follow_up"` `:4507-4531` 在该同步前缀内完成入队）；worker 面：`:3754` `await waitForPromptAdmission(claimCheck, ...)` 位于解析之后、`handleCommand` 之前。
- **逐字证据**：
  ```ts
  // daemon-mode.ts:3754（仅 this.options.worker 且非 peer 的连接）
  const ownerFingerprint = await waitForPromptAdmission(claimCheck, parsedAdmission?.controller?.signal);
  ```
- **影响**：非 worker 面同刻两帧保持线序；worker 面上两条同刻命令的入队序 = 各自 claimCheck promise 的完成序（通常同一 tick 内 microtask 注册序 = 到达序，但两次 `assertSupervisorClaimCurrent` 是各自独立的 promise，理论可因 I/O 完成抖动换序）。
- **可复现**：**未做实测**（要起真 daemon/worker 双 socket，超出本线 40 分钟窗口）→ 标注 **仅静态推断**，confidence: low。
- **confidence: medium**（非 worker 同步前缀部分：代码路径可直接读出，且与 P0/P2 的 session 层实测一致）；worker 部分 low。

### F5 — 泵不引入额外偶然序：`selectFirst()` 在三个 await 之后同步取头，无陈旧快照
- **severity: info**
- **file:line**：`agent-session.ts:8088/8103/8104/8116`、`session-action-store.ts:227-233`
- **证据**：`const first = preselected ?? this._actionStore.selectFirst();`（`:8116`）为同步调用；await 期间新入队的动作在同一选择点可见。lane 优先 + 数组 FIFO 即全部分支。已有仓内测试 `S1` 覆盖"steering 先于 followUp、命令是硬边界、all 模式批量"并 ✓。
- **confidence: high**（静态 + S1/P1 实测：P1 证明"后到的 steering 仍占泵头"）。

## 3. 覆盖面与 unverified 清单（负结论声明）

"同刻顺序**是**确定的（结构性，而非事件循环偶然）"这一负结论仅覆盖下列入口的实测/静态组合；**未覆盖**：
1. worker 传输 daemon 面的 claim await 换序（F4，静态推断，未起真 worker）。
2. `agent_message.send` 端到端跨进程投递（父→daemon→子）只覆盖到 session 层 `queueAgentMessagePrompt`（E8）同步性，未覆盖传输层多路复用抖动。
3. ACP `session/prompt` 的实际换序可能（E17）：协议自身串行闸（`acp-mode.ts:879`）使同刻两条 ACP prompt 不可能同时准入，未做协议级实测。
4. update-restart fence / `requestAbort` 挂起态、`_queuedWorkPauses`、checkpoint waiters 与多源同时竞争的交叉（属 park/queue 系列测试域，本线未重跑）。
5. 压缩/阈值续作（E14，admit 前有一次模型生成 await——顺序取决于生成完成时刻，同 F2 性质，未单独构造用例）。
6. print-mode/headless、`runUserBash` 完成注入（`_flushPendingBashMessages` 属下一轮 next-turn 前缀池，非 ActionStore lane）。
7. `_pendingNextTurnMessages`（前缀池）与 lane 的混合序：E9 通知先入前缀池、被 `_takePendingNextTurnMessages()` 附着到下一次可见入队（`agent-session.ts:7157/7303`）→ 附着目标取决于"下一个可见动作"是谁，本身又受 F1/F2 影响；未构造用例。

## 4. 正控方法学（本线探针的有效性证明）

- P0：同 lane 两次 `followUp()` 调用 → 队列 = 调用序（探针能读出调用序）。
- P1：后到的 steering 仍在泵头 → 探针能读出 lane 优先级（不是恒等于调用序）。
- P2c：交换 P2 的调用序，结果不变 → 证明 P2 的换序归因于"同步 vs fence"结构，而非 harness 偶发。
- P3 双向：fence 类调用序翻转 ⇒ 队列翻转（对 fence 类敏感）。
- P5c：等延迟 handler 下保持调用序 → P5 的换序归因于 handler 延迟本身。

## 5. 建议（不改仓，仅记录）

1. 若希望"同刻到达按到达序"，需要给入队一个逻辑时间戳/单调序号（在事件处理入口取，而不是 `enqueue` 时取），并在 lane 内按序号排；当前结构是"同步前缀优先 + fence FIFO"。
2. 注册 async `input` handler 的扩展会把同 lane 用户消息次序交给 handler 延迟（F2）；文档面可提示"input handler 不应引入可变量级延迟"，或在 handler 完成前保持一个 admission fence（`_prompt` 流控态目前不取 fence）。
3. worker 面（F4 静态风险）若在意，可把 `waitForPromptAdmission` 挪到 `handleCommand` 的同步前缀之后，或在 claim 续体里恢复原帧序。

## 6. 心跳/工件

- 心跳：`/tmp/audit_r/round-39/r39-q5-multisource-heartbeat.txt`
- 测试：`/tmp/audit_r/round-39/multisource.q5.test.ts`；配置：`/tmp/audit_r/round-39/vitest.q5.config.ts`
- 运行日志：`q5-run1.log`（首跑 6/7，暴露 P5 microtask 计数不足）、`q5-run5.log`（8/8 EXIT=0）、`q5-s1.log`（仓内 S1 基线 ✓）
