# r39-Q4 — 同 queueKey 的 coalesce 语义 + skip 是丢弃还是重投

- 线名：`r39-q4-coalesce`
- 仓：`/Users/a1/Desktop/ai/prime-agent` @ `e8f6527dc44a548d961cdf336bd514bcafa24fa7`（只读；`git status --porcelain` 只显示会话开始前就存在的 3 个无关 untracked 文件，仓内零写入）
- 探针（全在 /tmp，未入仓）：`/tmp/audit_r/round-39/q4-coalesce.test.ts`（13 个用例，**13 passed**）
  - 运行：
    ```
    cd /tmp/audit_r/round-39 && env -u RLM_DEPTH -u RLM_SESSION_DIR -u PRIME_AGENT_SESSION_DIR -u PI_SESSION_DIR \
      node /Users/a1/Desktop/ai/prime-agent/node_modules/vitest/dist/cli.js --run --root /tmp/audit_r/round-39 \
      --config /Users/a1/Desktop/ai/prime-agent/packages/coding-agent/vitest.config.ts --no-file-parallelism \
      --reporter=verbose q4-coalesce.test.ts
    ```
    （`/tmp/audit_r/round-39/node_modules -> 仓 node_modules` 软链；用仓自己的 `vitest.config.ts`，因此 alias/harness 与仓内一致；输出留档 `/tmp/audit_r/round-39/vitest-out-3.txt`）
  - 说明：`--dir` 在 vitest 5 下不生效，会退化成跑全仓测试（我已 kill 掉那次误跑），改用 `--root + --config` 才只跑本探针。
- 逐字证据一律从仓源码切片粘贴，行号即 `file:line`。

## 0. TL;DR（直接回答派单四问）

1. **被 coalesce 掉的那条是「丢弃」，不是并入、也不会稍后重投。** 命中时 `_admitSessionInput` 在 `enqueue` 之前就 `return { accepted: false, disposition: "queued" }`，该 action 从未进 store，因此**没有 ticket**（`ticketFor` 从未被调用、`settleAccepted` 从未执行、无 `_emitQueueUpdate()`、无 log）。消息体只活在那个被丢弃的对象里。实测 T1/T10/T6。
   - 对 **agent_message（子代理回复/心跳回执）**：同样丢弃，但**会显式报错**——若 `agentMessageId` 与 owner 不同，`_rejectAgentMessage` 同时 reject `delivery` 与 `completion` 两个 leg，错误文本 `"Prompt was not queued because an equivalent follow-up is already pending."`。调用方从 promise rejection / `waitForAgentMessagePromptDelivery` 得知（T11）。**但 agent_message 实际不受影响**：`queueAgentMessagePrompt` 根本不传 queueKey（T7 + 静态），所以 agent 消息永远不会被 coalesce 吞。
   - 对 **普通用户输入**：同样不受影响——所有用户输入路径（TUI / `prime-agent send` / daemon `prompt`/`follow_up`/`steer` RPC / `session.followUp` 的 CLI 用法）都不带 queueKey。进入 coalesce 面的只有**显式带 key 的调用方**：cron/heartbeat（`heartbeat:<jid>`）与显式传 `queueKey` 的 RPC/API 客户端。
   - **调用方感知渠道**：`followUp()` 返回 boolean；`restoreFollowUpMessage()` 返回 boolean；`promptHeartbeat()` 返回 `{admitted, coalesced}`；daemon RPC 回 `{queued:false}`；`prompt()/promptUntilAccepted()` **只能靠 `preflightResult(false,false)`**，否则完全静默（T9/T12，见 F3）。
2. **queueKey 的构造点**（`rg` 全仓，非测试、非 dist）：`session.promptHeartbeat` 默认 `heartbeat:${job.id}`（agent-session.ts:6286）；daemon 心跳派发显式再传一次同值 `heartbeat:${current.id}`（daemon-mode.ts:2009）；其余全部是**透传**：`PromptOptions.followUpQueueKey -> _promptInjectedMessage:7161 / _prompt:7320 -> action.queueKey`，`steer/followUp/restore*Message` 的 `options.queueKey -> _queuePreparedPrompt -> _createPreparedTurnAction:7879`，daemon RPC `steer`/`follow_up` 的 `command.queueKey -> 同上`（daemon-mode.ts:4490/4498/4513/4522）。**共用同一 key 的来源**只有「同一 heartbeat job 的两次 tick」（同 job id ⇒ 同 key）。心跳的 skip 判定见 §2 F6（两处：`shouldDeferHeartbeatCronJob` 与 G5 的 coalesce-skip）。
3. **coalesce 的可见性**：队列快照/`queuedCount`/`queuePreview`/`_emitQueueUpdate()` **完全不反映**这件事（不是「快照漏了」——它本来就没入队，快照前后逐字节相同，T6 用 `getSessionActionSnapshot()` 字符串比对证明）。`removeQueuedFollowUp(key)`（agent-session.ts:9444）**不是**这条消息的把手：它只清 `clearableActions()`（queued/selected/preparing），对 coalesce 掉的消息（从不存在）与 committing/running 的 owner 都无效（T5b）。
4. **反面对照（正控）已做**，见 §3：同一探针下换一个 queueKey 必被投递（T2）、owner completed 后同 key 必被投递（T4）、agent 消息两条都投递（T7）、非 coalesce 到达必发 `session_action_update` 事件（T6）、清除 owner 后新同 key 消息必被投递（T10）。**因此「被吞」不是我的探针在乱报。**
5. **边界：owner 在 committing/running 时不命中 coalesce，同一 key 会真的排两条并两条都投递**（T5a 实测 `unfinishedActionCount == 2`，最终 `getUserTexts() == ["OWNER","LATE-SAME-KEY"]`；仓内既有测试 agent-session-queue.test.ts:1769 把这条当**有意**行为：「a same-key follow-up must queue for the next turn instead of coalescing into the committed one」）。所以不变式是「**每个 key 至多一条 *pending* action**」，不是「每个 key 至多一条 action」。

## 1. 坐标系逐字证据（机制本身）

`packages/coding-agent/src/core/agent-session.ts:7906-7917`（判据：只看 queueKey + 三个非终态，**不看 lane、不看 payload 内容、不看来源**）：
```
7906  	private _coalescedFollowUpOwner(action: QueuedSessionAction): QueuedSessionAction | undefined {
7907  		if (action.delivery !== "when_run_idle" || action.payload.kind !== "turn" || !action.queueKey) return undefined;
7908  		return this._actionStore
7909  			.unfinishedActions()
7910  			.find(
7911  				(candidate) =>
7912  					candidate.queueKey === action.queueKey &&
7913  					(candidate.lifecycle.state === "queued" ||
7914  						candidate.lifecycle.state === "selected" ||
7915  						candidate.lifecycle.state === "preparing"),
7916  			);
7917  	}
```
`packages/coding-agent/src/core/agent-session.ts:7963-7972`（命中分支：丢 + 选择性 reject，**无 enqueue / 无 ticket / 无 emit**）：
```
7963  		const coalescedOwner = options.restore ? undefined : this._coalescedFollowUpOwner(action);
7964  		if (coalescedOwner) {
7965  			if (action.agentMessageId !== coalescedOwner.agentMessageId) {
7966  				this._rejectAgentMessage(
7967  					action.agentMessageId,
7968  					new Error("Prompt was not queued because an equivalent follow-up is already pending."),
7969  				);
7970  			}
7971  			return { accepted: false, disposition: "queued" };
7972  		}
```
对照其下方正常路径（说明命中分支跳过了什么）`agent-session.ts:7976-7988`：
```
7976  		if (options.front) this._actionStore.enqueueFront(action);
7977  		else this._actionStore.enqueue(action);
7978  		let disposition: "starts_when_admitted" | "queued" = "queued";
7979  		if (canStartImmediately && this._actionStore.selectFirst() === action) disposition = "starts_when_admitted";
7980  		const controller = this._actionStore.ticketFor(action);
7981  		controller.settleAccepted({
7982  			status: "accepted",
7983  			actionId: action.id,
7984  			disposition,
7985  		});
7986  		this._sessionInputArrivalEpoch++;
7987  		this._emitQueueUpdate();
7988  		if (
```
`agent-session.ts:4381-4386`（reject 同时打两个 leg）：
```
4381  	private _rejectAgentMessage(agentMessageId: string | undefined, error: Error): void {
4382  		if (agentMessageId === undefined) return;
4383  		this._settleAgentMessage(agentMessageId, "delivery", error);
4384  		this._settleAgentMessage(agentMessageId, "completion", error);
4385  	}
4386  
```
`packages/coding-agent/src/core/session-action-store.ts:281-283`（`unfinishedActions` 跨两条 lane 且含 committing/running）与 `:84-90`（clearable 集合）：
```
281  	unfinishedActions(policy?: DeliveryPolicy): readonly TAction[] {
282  		return this.actions(policy).filter((action) => !TERMINAL_STATES.has(action.lifecycle.state));
283  	}
```
```
84  const TERMINAL_STATES = new Set<ActionLifecycle["state"]>(["completed", "failed", "cancelled"]);
85  const ACTIVE_STATES = new Set<ActionLifecycle["state"]>(["selected", "preparing", "committing", "running"]);
86  const CLEARABLE_STATES = new Set<ActionLifecycle["state"]>(["queued", "selected", "preparing"]);
87  
88  function isClearable(action: SessionAction): boolean {
89  	return CLEARABLE_STATES.has(action.lifecycle.state);
90  }
```
**注意 `SubmissionOutcome` 里有一个从未被产出的变体**（session-action-store.ts:129-135）：
```
129  export type AdmissionDisposition = "starts_when_admitted" | "queued";
130  export type SubmissionOutcome =
131  	| { status: "accepted"; actionId: string; disposition: AdmissionDisposition }
132  	| { status: "coalesced"; existingActionId: string }
133  	| { status: "handled_without_turn" }
134  	| { status: "extension_command"; completion: Promise<void> };
135  export type DeliveryOutcome = { status: "delivered" } | { status: "not_applicable" };
```
`rg 'status: "coalesced"'` 全仓只命中该类型定义与 `test/session-action-store.test.ts:206` 的单测；产物代码里没有任何 `settleAccepted({status:"coalesced"...)}`——coalesce 走的是「不 settle 任何 ticket」而不是这个变体。**info 级、但会误导读代码的人**（我一开始就按它去猜语义，结果它是死的）。

## 2. 发现清单

### F1 — coalesce 是「永久丢弃 + 零票据」，且被丢弃的 payload 无任何落点（含 prefixMessages）
- 命题：命中 coalesce 时该 action 永不入 store，返回 `{accepted:false, disposition:"queued"}`（`ticket` 为 undefined），消息文本、图片、`prefixMessages` 一并消失；没有任何重投/合并/持久化。
- severity：**medium**（设计上是「同 key 去重」，但对 API/RPC 调用方是静默数据丢失面；今天所有带 key 的仓内调用方都是「重复语义」的消息，所以还没变成用户可见的文本丢失）
- file:line：`agent-session.ts:7963-7972`、`:7976-7988`（对照）；`agent-session.ts:9444-9455`（`removeQueuedFollowUp` 无法回收一个不存在的 handle）
- 逐字证据：见上 `coalesce_branch` / `admit_tail`；`_queuePreparedPrompt`（:8006-8027）只把 `_admitSessionInput(...).accepted` 返回，`prefixMessages` 在这条路径上**没有**像 `_prompt(7348)` / `_promptInjectedMessage(7179)` 那样 `_unshiftPendingNextTurnMessages` 回滚：
  ```
  8006  	private async _queuePreparedPrompt(
8007  		schedule: SessionInputSchedule,
8008  		text: string,
8009  		images?: ImageContent[],
8010  		options: {
8011  			agentMessageId?: string;
8012  			queueKey?: string;
8013  			content?: (TextContent | ImageContent)[];
8014  			message?: QueuedAgentMessage;
8015  			prefixMessages?: CustomMessage[];
8016  			previewLabel?: string;
8017  			suppressAutonomousContinuation?: boolean;
8018  			resumeIfIdle?: boolean;
8019  			source?: InputSource | "internal";
8020  		} = {},
8021  	): Promise<boolean> {
8022  		const action = this._createPreparedTurnAction(schedule, text, images, options);
8023  		if (action.suppressAutonomousContinuation) {
8024  			this._markAutonomousContinuationSuppressed(primaryDeliveryRecord(action).message);
8025  		}
8026  		return this._admitSessionInput(action).accepted;
8027  	}
  ```
  （对照：`_promptInjectedMessage` 与 `_prompt` 在 `!result.accepted` 时确实回滚 prefix —— agent-session.ts:7178-7185、7347-7350）
- 影响：带 key 的 `restoreFollowUpMessage(text, ..., {prefixMessages})` 若被 coalesce，调用方拿到 `false`，其显式携带的 prefix 上下文一起丢；`prompt()` 路径上 prefix 会被正确回滚，所以这个缺口只在 `_queuePreparedPrompt` 类路径上。
- 可复现：`/tmp/audit_r/round-39/q4-coalesce.test.ts` → `T1`、`T10`、`T11`（实测）；prefixMessages 缺口为**静态推断**（confidence medium，仓内无调用方在 coalesce 场景同时带 prefixMessages）。
- confidence：high（丢弃与无票据部分，实测）/ medium（prefix 缺口，静态）

### F2 — 同一 key 不同内容时「先到者赢」：新指令被丢，旧指令被投递
- 命题：`_coalescedFollowUpOwner` 只比较 `queueKey`，不比 `payload.text/preview`，因此同一 job 在两次 tick 之间改了内容时，**新内容被丢弃、旧内容照旧投递**。
- severity：**low**（`rg` 证明今天的产品面到不了：`cronStore.updateRlmHeartbeat` 的唯一调用者 `updateRlmHeartbeatForState` 在 instruction/interval/deliveryMode 变化时**必定**先 `removeQueuedHeartbeatFollowUp` 清掉 pending 的那条，见下）
- file:line：`agent-session.ts:7906-7917`（只比 key）；`daemon-mode.ts:2143-2160`（先清后不冲突）
- 逐字证据（实测 T3：`ORIGINAL-INSTRUCTION` 投递、`UPDATED-INSTRUCTION` 全仓无痕）：
  ```
  T3 heartbeat: a same-job tick coalesces, and an UPDATED instruction is the one that is lost (33ms)  PASS
  expect(second).toEqual({ admitted: false, coalesced: true })
  ```
  产品面封堵照（`daemon-mode.ts:2143-2160`）：
  ```
  2143  		const job = this.cronStore.updateRlmHeartbeat(state.activeSessionId, input.id, {
2144  			label: input.label,
2145  			prompt: input.instruction,
2146  			scheduleText: input.interval ? normalizeHeartbeatSchedule(input.interval) : undefined,
2147  			status: input.status,
2148  			deliveryMode: input.deliveryMode,
2149  		});
2150  		if (job) {
2151  			if (
2152  				input.instruction !== undefined ||
2153  				input.interval !== undefined ||
2154  				input.status === "pause" ||
2155  				input.deliveryMode !== undefined
2156  			) {
2157  				this.removeQueuedHeartbeatFollowUp(state, job);
2158  			}
2159  			this.cronScheduler.wake();
2160  		}
  ```
- 影响：今天是「潜在陷阱」而非活 bug；但任何未来在 coalesce 面上「改内容但不先 remove」的写入者都会静默投递**过期指令**。
- 可复现：T3（实测探针能检出该形状）；「产品面不可达」为静态 + 正控（`rg updateRlmHeartbeat` 只 1 个 src 调用点）。
- confidence：high（机制实测）/ high（产品面不可达，rg 全仓 + 唯一调用点）

### F3 — `prompt()/promptUntilAccepted()` 带 key 被 coalesce 时**完全静默**（只有 preflightResult 这一条带内通道）；且返回的 `disposition` 骗人
- 命题：a) `_prompt` 在 `!result.accepted` 时 `reportPreflight(false,false); return;`，若调用方没传 `preflightResult`，**没有任何** throw/返回值/事件/log；b) 返回的 `disposition"queued"` 与 `accepted:false` 矛盾——只看 `disposition` 的调用方会以为已排队。
- severity：**low**（仓内今天唯一会同时带 key 走 `prompt()` 的是心跳路径，而它读 `AgentHeartbeatPromptResult`；但这是公开 API 的静默丢失面）
- file:line：`agent-session.ts:7971`（`return { accepted: false, disposition: "queued" }`）、`agent-session.ts:7347-7351`（`if (!result.accepted || !result.ticket) ... return;`）
- 逐字证据：T9/T12 实测 —— `await expect(harness.session.prompt("COALESCED-PROMPT", {streamingBehavior:"followUp", followUpQueueKey:"K"})).resolves.toBeUndefined()` 不抛；带 `preflightResult` 时 `preflights == [[false,false]]`；且 `session_action_update` 事件数在 coalesce 前后不变。
- 影响：公开 API 上「消息没排队且丢了」与「消息排上了」在返回值上不可区分（除 preflight 回调）。
- 可复现：T9、T12（实测）。
- confidence：high

### F4 — coalesce 跨 lane：一条 **steering** action 的 key 会吞掉 **follow-up** 的同 key（反之不成立）
- 命题：`unfinishedActions()` 跨 `nextTurnBoundary`/`whenRunIdle` 两数组，谓词不看 `candidate.delivery`，所以「带 key 的 steer 在 queued/selected/preparing」会吞掉「同 key 的 followUp」。
- severity：**low**（有意的强去重？仓内既有测试 `agent-session-queue.test.ts:1751`「coalesces a same-key follow-up while a steering owner is preparing」把它当期望行为；仅 note 语义面）
- file:line：`agent-session.ts:7908-7916` + `session-action-store.ts:322-325`（`actions()` = `[...nextTurnBoundary, ...whenRunIdle]`）
- 逐字证据：T8 实测 `followUp("FOLLOW-UP-SAME-KEY", {queueKey:"K"}) === false`，`getFollowUpMessages() == []`，最终只投递 `["STEER-OWNER"]`；反向不成立（`action.delivery !== "when_run_idle"` 早退 ⇒ steer 永不被 coalesce，仓内 `agent-session-queue.test.ts:3304-3307` 正控）。
- 影响：若某个 job 的 deliveryMode 从 steer 改成 follow_up（daemon `updateRlmHeartbeatForState` 会先清，所以今天到不了），旧 steer tick 会吞掉新 follow-up tick。
- 可复现：T8（实测）。
- confidence：high

### F5 — 边界：owner 在 committing/running 时**不**命中 ⇒ 同 key 真的排两条且两条都投递；`removeQueuedFollowUp(key)` 只清得动其中一条
- 命题：coalesce 集合 `{queued, selected, preparing}` 排除 committing/running，因此同一 key 可同时有 1 条 running + 1 条 queued；`removeQueuedFollowUp` 只清 clearable 的那条，running 的照跑（返回 `true` 会让人以为「这个 key 已清干净」）。
- severity：**medium**（这是 `queueKey` 被 daemon 当「取消把手」用的地方：`removeQueuedHeartbeatFollowUp` 删心跳后按 key 清队列；running 时它清不动，语义上「已删的心跳仍会跑完」——这是合理但未被任何返回值/日志区分的两种情况）
- file:line：`agent-session.ts:7913-7915`（集合）、`agent-session.ts:9444-9455`、`session-action-store.ts:86`（CLEARABLE 集合）、`daemon-mode.ts:2271-2276`（唯一产品调用方，返回值被忽略）
- 逐字证据：
  ```
  9444  	removeQueuedFollowUp(queueKey: string): boolean {
9445  		const matching = this._actionStore
9446  			.clearableActions()
9447  			.filter((action) => action.payload.kind === "turn" && action.queueKey === queueKey);
9448  		if (matching.length === 0) return false;
9449  		const error = new Error("Queued agent message was cleared before delivery.");
9450  		for (const action of matching) this._rejectAgentMessage(action.agentMessageId, error);
9451  		const ids = new Set(matching.map((action) => action.id));
9452  		this._cancelSessionActions((action) => ids.has(action.id), error);
9453  		this._emitQueueUpdate();
9454  		return true;
9455  	}
  ```
  ```
  2271  	private removeQueuedHeartbeatFollowUp(state: ActiveSessionState, job: AgentCronJob): void {
2272  		if (!isHeartbeatCronJob(job)) {
2273  			return;
2274  		}
2275  		state.runtime.session.removeQueuedFollowUp(`heartbeat:${job.id}`);
2276  	}
2277  
  ```
  实测 T5a/T5b：
  ```
  T5a owner committing/running: a same-key follow-up IS admitted (two same-key actions coexist) PASS
    expect(duplicate).toBe(true); expect(getFollowUpMessages()).toEqual(["LATE-SAME-KEY"]);
    expect(harness.session.unfinishedActionCount).toBe(2);  // 最终两条都投递
  T5b removeQueuedFollowUp closes only the clearable same-key action; the running owner survives PASS
    expect(harness.session.removeQueuedFollowUp("K")).toBe(true);
    expect(harness.session.getFollowUpMessages()).toEqual([]);
    expect(harness.session.unfinishedActionCount).toBe(1);  // running owner 仍在
  ```
- 影响：a) 「每个 key 一条」的直觉在 committing/running 窗口失效（设计使然，仓内测试 1769 明确要求如此）；b) 「按 key 取消」在 running 时是 no-op 且 `removeQueuedHeartbeatFollowUp` 吞掉返回值，删除心跳后它仍会完成当前 tick（可接受，但无任何回执）。
- 可复现：T5a、T5b（实测）。
- confidence：high

### F6 — 心跳 skip 的逐字代码在两处，且记账可见性不对称
- 命题：心跳 follow_up 撞 busy 时的「skip」有两条独立通路：(a) `shouldDeferHeartbeatCronJob` 在派发前直接 defer/skip；(b) G5：admission 被 coalesce 时 `promptHeartbeat` 返回 `admitted:false`，daemon 记 `"skipped"`。
- severity：**info**（记账正确，仅可见性有缺口）
- file:line：`cron-jobs.ts:1618-1639`、`daemon-mode.ts:1963-1973`（defer 分支，且会 `wakeSuspendedSessionInput()`）、`daemon-mode.ts:2006-2019`（G5 skip）、`cron-jobs.ts:844-858`（skipped 记账：**不动 runCount**，写 `lastSkippedAt`）、`cron-jobs.ts:1515`（`cron list` 文本显示 `skipped=`）
- 逐字证据（G5，即「心跳 follow_up 撞 busy 即 skip」的判据代码）：
  ```
  2006  			if (isHeartbeatCronJob(current)) {
2007  				const promptResult = await session.promptHeartbeat(current, {
2008  					streamingBehavior: resolveHeartbeatStreamingBehavior(current.deliveryMode),
2009  					followUpQueueKey: `heartbeat:${current.id}`,
2010  					source: "rpc",
2011  					admissionCommitted,
2012  				});
2013  				// G5 (r37 hbgoal-ts): a coalesced or rejected follow-up delivered no new
2014  				// action; a skipped dispatch keeps runCount and lastRunAt honest instead
2015  				// of recording a run that never happened.
2016  				if (promptResult && !promptResult.admitted) {
2017  					return "skipped";
2018  				}
2019  				return;
2020  			}
  ```
  （defer 判据，属前置的另一条 skip 通路）：
  ```
  1618  export function shouldDeferHeartbeatCronJob(job: AgentCronJob, activity: HeartbeatCronSessionActivity): boolean {
1619  	if (!isHeartbeatCronJob(job)) {
1620  		return false;
1621  	}
1622  	// States where delivering a heartbeat is unsafe or would stack redundant work,
1623  	// regardless of delivery mode.
1624  	const busyBesidesStreaming =
1625  		activity.isCompacting === true ||
1626  		activity.isRetrying === true ||
1627  		activity.isBashRunning ||
1628  		activity.hasPendingSessionWork ||
1629  		(!activity.isStreaming && activity.unfinishedActionCount > 0);
1630  	if (busyBesidesStreaming) {
1631  		return true;
1632  	}
1633  	// "steer" heartbeats interrupt the current turn, so a plain streaming turn must
1634  	// not defer them; "follow_up" heartbeats wait, so streaming still defers.
1635  	if (resolveHeartbeatStreamingBehavior(job.deliveryMode) === "steer") {
1636  		return false;
1637  	}
1638  	return activity.isStreaming;
1639  }
  ```
  （记账，证明 skip 不涨 runCount）：
  ```
  844  			state.jobs = state.jobs.map((job) => {
845  				if (job.id !== dispatch.jobId || job.status !== "active") {
846  					return job;
847  				}
848  				if (result.outcome === "skipped" && result.error === undefined) {
849  					const nextRunAt = nextRunAtForSchedule(job.schedule, now);
850  					updated = {
851  						...job,
852  						status: job.schedule.kind === "once" ? "completed" : job.status,
853  						nextRunAt: nextRunAt?.toISOString(),
854  						lastSkippedAt: now.toISOString(),
855  						updatedAt: updatedAtForMutation(now, job),
856  					};
857  					return updated;
858  				}
  ```
- 可见性缺口：TUI 心跳列表只显示 `runCount runs` 与 `lastError`（`modes/interactive/components/heartbeat-manager.ts:287`），**不显示 `lastSkippedAt`** ⇒ 在 TUI 里「每个 tick 都被 coalesce 吞掉」与「job 从没跑过」看起来一样；`prime-agent cron list` 文本里才有 `skipped=`。
- 可复现：T3（session 层实测 `{admitted:false, coalesced:true}`，即 G5 的唯一输入）；daemon 层记账为静态引用。
- confidence：high（session 层实测 + 源码逐字）/ medium（「TUI 不显示」为静态，未跑 TUI）

### F7 — `SubmissionOutcome` 的 `coalesced` 变体是死代码
- 命题：类型里定义了 `{status:"coalesced"; existingActionId}`，但产物代码从不 settle 它（coalesce 分支不 settle 任何 ticket）。读代码者会以为 coalesce 会通过 `ticket.accepted` 通知调用方——实际不会。
- severity：**info**
- file:line：`session-action-store.ts:129-135`（定义）、`agent-session.ts:7963-7972`（无 settle）
- 逐字证据：见 §1 的 `outcome` 切片 + `rg 'status: "coalesced"'` 全仓仅命中定义与 `test/session-action-store.test.ts:206`。
- 可复现：静态（`rg`）；探针 T6 从行为侧佐证「无 ticket / 无事件」。
- confidence：high

### F8 — 恢复面：整快照恢复绕过 coalesce，但逐条 `restore*Message` 不绕过
- 命题：`restoreSessionActions`（整快照）传 `{restore:true}` ⇒ `_coalescedFollowUpOwner` 整体跳过，多条同 key 的恢复记录都会被还原并保序；而 `restoreFollowUpMessage/restoreSteeringMessage`（RPC 逐条）**照常 coalesce**，同 key 第二条返回 `false`（同 id 时连 reject 都没有）。
- severity：**low**（逐条恢复的 RPC 今天只有 daemon 转发，回执里带 `{queued:false}`；但协议面客户端若忽略返回值，这条消息就永久消失，因为它已经不在源会话里）
- file:line：`agent-session.ts:7963`（`options.restore ? undefined : ...`）、`:7610-7623`（快照恢复循环）、`:7645-7657`（`_restorePromptInput` 返回 boolean，不 throw）、`daemon-mode.ts:4507-4531`（RPC `follow_up` 回 `{queued}`）
- 逐字证据：T11 实测 —— 同 `agentMessageId` 的 `restoreFollowUpMessage` 返回 `false` 且**不** reject、不发队列事件；换一个 `agentMessageId` 才 reject（`equivalent follow-up is already pending`）。
- 影响：`restore_follow_up`/`restore_steer` 是外部客户端协议命令（仓内无调用方，`rg restore_follow_up` 仅剩 daemon-protocol/daemon-mode 的定义与 handler），契约上是「调用方必须读 `queued`」。
- 可复现：T11（实测 + 正控）。
- confidence：high

## 3. 正控清单（每条负结论对应的「已知会被检出」对照）

| 负结论 | 正控 | 结果 |
|---|---|---|
| 「同 key 的消息被吞」不是探针误报 | T2 换 queueKey=K2 → `followUp` 返回 true，两条都进 transcript | PASS |
| 「被吞是永久的、不重投」 | T10 清掉 owner 后 coalesced 消息不重现；随后**新**同 key 消息被投递 | PASS |
| 「coalesce 不发队列事件」 | T6 同探针在**不同 key** 到达时事件数增加 | PASS |
| 「agent 消息不会被吞」 | T7 两条 agent 消息都在队列与 transcript 里 | PASS |
| 「终态 owner 不再吞」 | T4 owner completed 后同 key 返回 true 并投递 | PASS |
| 「reject 不是无条件/无差别」 | T11 同 id 不 reject、异 id reject（两方向都实测） | PASS |
| 「cross-lane 吞只发生在 followUp 一侧」 | 既有测试 `agent-session-queue.test.ts:3304-3307`：两条同 key steer 都在 `getSteeringMessages()` | 引用（未复跑仓内文件） |

注：我没有修改仓内任何文件；上表「引用」一行是仓内既有测试，未被我复跑（写死禁改仓，也没有必要）。其余均为我在 /tmp 探针里的实测。

## 4. 明确未覆盖 / 仅静态推断

- `prefixMessages` 在 coalesce 时丢失（F1 后半）：**仅静态推断**（无仓内调用方在该场景带 prefixMessages），confidence medium。
- TUI 心跳面板不显示 `lastSkippedAt`（F6）：**静态**，未启动 TUI。
- daemon 层 G5 → `cronStore.recordDispatchResult({outcome:"skipped"})`：**静态**（我核对了 cron-jobs.ts:844-858 与 daemon-mode.ts:2016-2018 的调用链，未起真 daemon 跑一次心跳 tick）。
- 未测：`_sessionInputPumpSuspended` 悬挂态下「keyed action 被 stranded 且同 key 到达被吞」的组合（属 Q3 泵/挂起面，本线只记录 `_admitSessionInput` 不检查 `_sessionInputPumpSuspended` 这一事实：挂起时仍可 enqueue，但 coalesce 分支在 wake 块之前 early-return，因此**不**提供任何 wake）。
- `_coalescedFollowUpOwner` 每次 admission 线性扫 `unfinishedActions()`（`:7908-7916`）：info，未做大 N 性能测量。

## 5. severity 排序（最高 3 条）

1. **F1（medium）** 丢弃且无票据：`agent-session.ts:7963-7972` + `:9444-9455`（实测 T1/T10/T11）
2. **F5（medium）** committing/running 不命中 ⇒ 同 key 两条并存且两条都投递；`removeQueuedFollowUp` 只清一条（实测 T5a/T5b）
3. **F3（low）** `prompt()/promptUntilAccepted()` 带 key 被吞时静默、且 `disposition:"queued"` 与 `accepted:false` 自相矛盾（实测 T9/T12）

（F2/F4/F6/F7/F8 均 low/info：或产品面不可达，或记账/契约层瑕疵。）
