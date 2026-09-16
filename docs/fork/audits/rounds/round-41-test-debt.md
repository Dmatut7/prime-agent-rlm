# r41 终审 · 测试债线：今夜被改写断言的既有测试逐条评估

- 范围：`b7f26e98b..HEAD`（92 提交，HEAD=`eb0825e63`），仓库 `/Users/a1/Desktop/ai/prime-agent` 只读，零写入。
- 边界：只看测试文件的**断言改写**；纯新增行不计。报告内所有"能/不能抓到"结论都给出机械证据或明确标注"本次扫描范围内未见"。
- 我的检法正控（证明"漏了"不是我没看见）：
  1. 用 `git diff --numstat` × `git ls-tree b7f26e98b` 分出新/旧：85 个测试文件被触及 = **新增 47 + 修改 38**（其中 21 个有删行）。纯新增文件无删行，结构上不可能弱化既有断言。
  2. 用"**被删掉的 `expect(` 行**"作为完整改写清单（删行是弱化的必要条件）：范围内共 **20 行**，分布 12 个文件；外加 1 处非 `expect` 行的断言实参改写（`daemon-supervisor-eviction` 的超时字面量）→ 改写点合计 **21 处 / 13 个文件**。逐条都在下表。
  3. 私有成员探针用仓库自带闸门做正控：`node scripts/check-test-private-probes.mjs` 报 `found 497 private-member probes (private-cast=105, private-cast-alias=243, private-spyon=149)`，`--base b7f26e98b --strict-diff` EXIT=0、`failing:0 strictDiffHits:0`。即：闸门确实能检出同形状探针（正控存在），而下面 R22 的新探针**未被检出**（工具盲区，非我漏看）。

## 统计

| 指标 | 值 |
|---|---|
| 范围内测试文件 | 触及 85（新增 47 / 修改 38，修改中 21 有删行） |
| 被删 `expect(` 行（改写断言清单） | 20 行 / 12 文件 |
| 改写点合计（含 1 处非 expect 实参） | 21 处 / 13 文件 |
| 判定：命题被削弱（须修/回滚） | **2**（R9、R11） |
| 判定：合理放宽（保留 ≥2x 余量，主判据独立） | 3（R22 超时、R23、R24） |
| 判定：命题被替换但跟随同提交规格变更且有新增覆盖/正控 | 6（R7、R10、R12、R13、R14、R19） |
| 判定：OK（机械跟随 API/更强/仅更名） | 10（R1–R6、R8、R15–R18、R20、R21） |
| 恒真/构造性真断言 | **0 条**；区分力下降（"构造性强可满足"）1 条（R10 的 `toBe(first)`） |
| 无条件 `it.skip` / `describe.skip` | 0（范围内新增行仅 1 处 `it.skipIf`，条件可判定且本机为真；见"特别检查"4） |
| 数据驱动循环缺 `expect(len).toBeGreaterThan(0)` | 本次扫描范围内未见（范围内 10 处新增 `toBeGreaterThan/OrEqual` 均在循环体外先断集） |

---

## A. 逐条表（旧/新逐字，提交 sha，判定）

### R1–R6 机械跟随 API 改名（9 处删行，判 OK）

`acquireSessionLease`（同步）在范围内被删除，src 只剩 `acquireSessionLeaseAsync`（`grep 'export async function acquireSessionLeaseAsync' src/core/session-lease.ts:594`，`grep -rn acquireSessionLease src` 除 Async 与注释外无命中；src 变更提交 `01d1347d8` / `456092663` / `1da9c1289`）。断言语义逐字保留，仅把 `expect(()=>f()).toThrow(X)` 换成等价的 `await expect(f()).rejects.toThrow(X)`。

| # | 文件 | 旧逐字 | 新逐字 |
|---|---|---|---|
| R1 | `test/session-lease.test.ts:96,137,239,261,311,334,357,455`(+15 个 `it(` 加 `async`)、`:426` | `expect(() => acquireSessionLease(sessionPath, agentDir, enabledEnvironment("owned-b"))).toThrow(SessionAlreadyActiveError);` … `expect(acquireSessionLease(join(agentDir,"session.jsonl"), agentDir, {})).toBeUndefined();` | `await expect(acquireSessionLeaseAsync(...,"owned-b"))).rejects.toThrow(SessionAlreadyActiveError);` … `await expect(acquireSessionLeaseAsync(...)).resolves.toBeUndefined();` |
| R2 | `test/suite/regressions/3885-subagent-runtime-host.test.ts:174,178` | `expect(() => acquireSessionLease(childSessions[0]!.path, tempDir)).toThrow(SessionAlreadyActiveError);` | `await expect(acquireSessionLeaseAsync(childSessions[0]!.path, tempDir)).rejects.toThrow(SessionAlreadyActiveError);` |
| R3 | `test/proper-lockfile-compromise.test.ts:161` | `expect(() => acquireSessionLease(...)).toThrow(/Session lease guard was compromised/);` | `await expect(acquireSessionLeaseAsync(...)).rejects.toThrow(/Session lease guard was compromised/);` |
| R4 | `test/daemon-runtime-lease.test.ts:48` | `const reopened = acquireSessionLease(sessionPath, root);` | `const reopened = await acquireSessionLeaseAsync(sessionPath, root);` |
| R5 | `test/daemon-supervisor-process.test.ts:1357` | `const externalLease = acquireSessionLease(sessionFiles[0], agentDir, {...});` | `const externalLease = await acquireSessionLeaseAsync(...);` |
| R6 | `test/suite/regressions/r2-catalog-append-tail-repair.test.ts:124,168` | `const lease = acquireSessionLease(sessionFile, agentDir, {...});` | `const lease = await acquireSessionLeaseAsync(...);` |

判定 **OK**：命题（第二个 owner 被拒 + 错误类型/字段、guard 被破坏不建 lease、release 后可重取）逐字未变，只是同步→异步。
一处"未充分利用"的备注（非本轮引入）：`session-lease.test.ts:100-108` 与 `:267-279` 仍是 `try { await f() } catch (e) { … }` 形态——若 Promise 不 reject，catch 块内的断言被跳过（该模式在 base 就存在；`:137` 处 `expect(caught).toBeInstanceOf(...)` 是 fail-safe 的，不受影响）。

### R7 `test/compaction-summary-budget.test.ts:25-36` — 命题被替换（跟随同提交规格变更）→ 判 合理

- 旧：`it("keeps the newest messages within budget and counts elided")` + `expect(extractText(kept)).toContain("mid"); expect(extractText(kept)).not.toContain("old");`
- 新：`it("pins the first user request, keeps the newest messages, and counts elided")` + `expect(extractText(kept)).toContain("old"); expect(extractText(kept)).toContain("recent"); expect(extractText(kept)).not.toContain("mid");`
- 放宽倍数：不适用（是**语义反向**，不是阈值）。
- 证据：同一提交 `c3af1e8ba` 改了 src（`compaction.ts:723` 新增 `pinnedIndex`/`firstUserIntentIndex` 头钉逻辑），并新增 314 行 `test/compaction-task-brief-fidelity.test.ts`。新断言仍可证伪（`elided===1`、`kept.length===2`、`toContain("recent")`）。
- 反例检查：`toContain("old")` 在"钉头"实现下并非恒真——`compaction.ts:741` 有 `if (pinnedTokens > tokenBudget) return messages.slice(start)`（首条超预算不钉），别处的预算=10 用例仍钉住"最新必留"。
- 判定 **合理**：断言跟随了**同提交的规格变更**，且原命题（最新必留）由本文件另一用例 + 新文件继续覆盖。

### R9 ★ `test/rlm-child-stream-scaling.test.ts:248` — **命题被削弱（建议回滚/补正控）**

- 旧逐字：`expect(parentListenerMs).toBeLessThan(12);`
- 新逐字：`expect(parentListenerMs).toBeLessThan(Math.max(fullRederiveMs * chunkCount * 0.5, 12));`
- 放宽：相对界，`chunkCount=400`；本机实测 `fullRederiveMs∈[0.0755,0.1367]ms` → 新界 ∈ **[15.3, 27.3]ms**（旧界 12ms）。即数值上放宽 **1.3x–2.3x**，且界随机器负载一起上浮。
- 改后仍绿但缺陷存在的**具体场景**（机械证据）：我在 `/tmp/audit_r/round-41/testdebt-work/perf-probe2.ts` 用本仓真实函数 `compactRlmText`/`rlmChildLabel` 复刻 c14df4942 的**改动前**每 chunk 工作（前缀全文 replace + 5k brief 正则 + 全量 snapshot `JSON.stringify`），同一 chunk 流跑 12 轮：
  - 改动前总成本 **22.87–23.51ms**；新界同一轮 **15.09–17.77ms** → 判别余量仅 **1.30x–1.49x**（旧 12ms 界的余量是 1.9x）。
  - 且新界是**单次取样** `fullRederiveMs` 的函数，该单次取样本机就摆动了 1.8x（0.0755→0.1367ms）。`perf-probe.ts` 第 0 轮实测：`fullMs=0.1367 → boundMs=27.33`，而同轮改动前成本 `preFixSimMs=26.18` → **改动前的实现正好落在新界以下（26.18 < 27.33），测试会绿着放过它**。
  - 根因：界 `0.5×chunkCount×fullRederive` 与"改动前总成本"同阶（测试注释宣称 "pre-fix total was chunkCount x this"，实测改动前总成本 ≈ 该宣称值的 0.72x），所以它标定的是**改动前**而非修复后的成本。
- 正控：无（放宽后没有注入"必然超限"的负例证明尺还在）。
- 判定 **命题被削弱**：它原本要抓的 bug（每 chunk 全文重推导）存在时**可能仍绿**，必须回滚或改成"界内自测的改动前循环 + 4x 余量"并加一条必然超限的正控。

### R10 `test/rlm-subagent-display-cache-bounds.test.ts:88-118` — 命题被替换（跟随规格变更），hit-rate 控制区分力下降 ★低危

- 旧逐字（两处）：`await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toMatchObject({ sessionName: "workerA" });`（第二处是同尺寸同 mtime 覆写后仍报 workerA）
- 新逐字：`const first = await readRlmSubagentDisplayEntry(sessionDir); expect(first).toMatchObject({sessionName:"workerA"}); … await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toBe(first);` 与 `…resolves.toMatchObject({ sessionName: "workerB" });`
- 放宽：不适用（规格反转；提交 `c87779e9` 给缓存加 head+tail 指纹，`rlm-subagent-display.ts:187-205`）。
- 判定 **合理（跟随规格变更）**，但注意：新 hit-rate 控制改用**对象同一性**（`toBe(first)`）。当前实现每次仍会 open+read 指纹（`displayFingerprint`）后返回缓存对象，所以 `toBe(first)` 对"每次调用都重读文件"的性能回归**照样通过**——旧探针（同尺寸同 mtime 覆写仍报旧值）恰恰证明了"没有重读内容"，这一区分力丢了。`rlmSubagentDisplayCacheStats()`（`rlm-subagent-display.ts:148`）只有 `{entries, bytes}`，没有 hits/misses 计数可供替代断言。具体漏抓场景：把 `displayFingerprint` 的 head+tail 4096B 读改成**全文件读**（大目录列表每次全读），本文件 5 个用例全绿。

### R11 ★ `test/daemon-supervisor-eviction.test.ts:423` — **命题被削弱，理由被同文件正控直接证伪（建议回滚）**

- 旧逐字：`24 * 60 * 60 * 1000,`（`worker.client.requestWorker(payload, timeoutMs, hooks)` 的第 2 实参）
- 新逐字：`expect.any(Number),`，注释称 "The tier budget is clamped by the remaining delivery deadline, so the exact timeout number is timing-sensitive on a loaded runner"。
- 放宽：从"精确值"放宽到"任意数字"，倍数无上限。
- **证伪证据（我实跑）**：同文件 `:464` 仍是逐字 `24 * 60 * 60 * 1000,`（同一 `worker_deliver_message` 派发路径、同一 `Math.max(1, Math.min(tierMs, remainingMs))`，`daemon-supervisor.ts:6816-6817`），并且 `npx vitest --run test/daemon-supervisor-eviction.test.ts` → `Tests 33 passed (33)`，`Duration 2.31s`。即：在本仓当前 harness 下该数字是**确定**的，不存在"loaded runner 抖动"。
- 改后仍绿但缺陷存在的具体场景：让 create 路径的派发丢掉 deadline 夹取（`min` 去掉）或选错 tier（`WORKER_REQUEST_TIMEOUT_TIERS[deliver]` 取代 `long`），`expect.any(Number)` 一律接受；同文件只有 same-worker 场景（另一条分支）能抓。范围扫描未见别处钉这个夹取的数值（`grep '24 \* 60 \* 60 \* 1000' test/**` 仅 `:464`）。
- 判定 **命题被削弱**：恢复字面值即可（:`464` 证明它不抖），或至少写 `expect(t).toBeGreaterThanOrEqual(24*60*60*1000)` 之类可证伪的上下界。

### R12–R14 QP-2/QP-3 拒绝语义改写（跟随规格变更，补偿存在）

| # | 文件:行 | 旧逐字 | 新逐字 | 判定 |
|---|---|---|---|---|
| R12 | `test/suite/agent-session-queue.test.ts:1769-1800` | `it("queues a same-key follow-up once the prior owner has handed off")`；`expect(await harness.session.followUp("second heartbeat", undefined, { queueKey: "heartbeat" })).toBe(true);` `expect(harness.session.getFollowUpMessages()).toEqual(["second heartbeat"]);` `expect(getUserTexts(harness)).toEqual(["first heartbeat","second heartbeat"]);` | `it("refuses a same-key follow-up while the prior owner is committing (QP-3, r39)")`；`expect(error?.name).toBe("SessionInputCoalescingError"); expect(error?.retryable).toBe(true); expect(harness.session.getFollowUpMessages()).toEqual([]); expect(harness.session.unfinishedActionCount).toBe(1);` `expect(getUserTexts(harness)).toEqual(["first heartbeat"]);` | 合理（同规格变更；同一场景在新文件 `test/r39-qp.test.ts:284` 复述，并带 `:320` "different-key 仍排队" 正控） |
| R13 | `test/suite/regressions/f1-agent-message-wakes-suspended-pump.test.ts:128-158` | `it("does not break the update-restart fence when an agent message is queued")`；`expect(harness.session.getFollowUpMessages()).toEqual(["queued before restart", message.content]);` | `it("refuses a late agent message behind the update-restart fence with a retryable error (QP-2, r39)")`；`expect(error?.name).toBe("SessionInputAdmissionPausedError"); expect(error?.retryable).toBe(true); expect(isRetryableAgentMessageSendError(error?.message ?? "")).toBe(true); expect(harness.session.getFollowUpMessages()).toEqual(["queued before restart"]);` | 合理（补偿：`test/r39-qp.test.ts:194` "refusal 让 message id 未花，重发送达 delivery leg" 断言 `deliveries()===2`） |
| R14 | `test/suite/regressions/fixq3-heartbeat-wakes-stranded-queue.test.ts:100-110` | `await harness.session.steer(...)`；`expect(harness.getPendingResponseCount()).toBe(1);` | `expect(error?.name).toBe("SessionInputAdmissionPausedError"); expect(error?.retryable).toBe(true); expect(harness.session.getSteeringMessages()).toEqual([]);` `expect(harness.getPendingResponseCount()).toBe(2);` | 合理（补偿：`test/r40-k3q3-cron-pause-deferred.test.ts:152` "窗口释放后延迟任务仍然跑" 正控断言 `runCount===1`） |

- 共同点：旧命题是"重复/迟到输入会被排队并最终送达"，新命题是"在提交窗口/拆机窗口内被**显式拒绝且可重试**"。拒绝是真的（typed error + `retryable` + 队列为空 + 未消费响应数不变），且分母侧有正控；**唯一变窄**的是 QP-3 这一支没有"拒绝后由发送方重发并**恰好送达一次**"的端到端断言（QP-2 有 `r39-qp:194`，cron 层有 `r40-k3q3:152`）。具体漏抓场景：发送方收到 `SessionInputCoalescingError` 后**完全不重试**（消息永久丢失），本文件与 r39-qp 都不会红。
- 附带备注：R13:154 的 `isRetryableAgentMessageSendError(error.message)` 属"同仓两常量互证"（`agent-messages.ts:823` 的正则 ↔ 错误文案），是刻意耦合、可按设计接受，但若文案改了它只报"分类器没跟上"，不构成独立证据。

### R15–R18 计数/命名/桩形状（判 OK）

| # | 文件:行 | 旧 → 新 | 判定与证据 |
|---|---|---|---|
| R15 | `test/suite/regressions/machine-block-tail-anchor.test.ts:454`、`test/compaction-machine-blocks.test.ts:52` | `expect(MACHINE_BLOCK_TAGS.length).toBe(4);` → `toBe(6);` | OK：成员由 `machine-blocks.ts:48-56` 新增 `ipython_state`/`ipython_state_restored`（"strip-only"），新文件 `test/k3r2-ipython-state-machine-block.test.ts:32-60` 实测两条新 tag 被 strip 且 `stripped` 不含 `ipython_state`。弱项：同文件 `:451` 的负向正则仍只枚举 4 个旧 tag，未扩到新成员（覆盖由新文件补上） |
| R16 | `test/daemon-mode.test.ts:9236` 起 | 桩 `promptHeartbeat = vi.fn(async (...) => {})` → `vi.fn(async (...): Promise<AgentHeartbeatPromptResult> => ({ admitted: true, coalesced: false }))`，并新增用例 `:8271 "records a coalesced or rejected heartbeat prompt as skipped instead of ran"` | OK：src 分支 `daemon-mode.ts:2044 if (promptResult && !promptResult.admitted) return "skipped"`——旧桩返回 `undefined` 与 `admitted:true` 在**同一支**（都判"ran"），既有断言语义未变；新用例把 `admitted:false` 那一支补上，是**增覆盖**而非掩盖 |
| R17 | `test/daemon-agent-roster.test.ts:1763` | 仅 `it` 名 `"deletes a top-level saved session without touching the spawn ledger"` → `"deletes a top-level saved session even when the spawn ledger is unreadable"` | OK：`git show b7f26e98b..HEAD` 显示正文未动，而正文早已是 `ledgerEdges = async () => { throw new Error("ledger unreadable") }`——是把**过时测试名**改成与断言一致 |
| R18 | `test/daemon-supervisor-eviction.test.ts` 之外三个 `daemon-*`/`suite/harness.ts`/`goal-continuation-quiescence.test.ts` | 仅 +N 行（无删行） | OK（纯新增，不构成弱化） |

### R19–R21 协议/文案跟随（判 OK，其中两处更强）

| # | 文件:行 | 旧 → 新 | 判定 |
|---|---|---|---|
| R19 | `packages/ai/test/openai-responses-partial-json-cleanup.test.ts:80` | 直接 `await processResponsesStream(createFunctionCallEvents(json), …)` → 用 `eventsWithTerminal()` 补一个 `response.completed` 终止事件后调用 | OK：跟随"缺终止事件=截断"的新协议；断言（`output.content` 长度/args）逐字未变 |
| R20 | `packages/ai/test/tool-call-args-final-parse-on-error.test.ts:317-330` | 直接 `await processResponsesStream(events, …)` → `try/catch` 捕获后 `expect(thrown).toBeInstanceOf(StreamFailureError);` | OK（**更强**）：多了一条错误类型断言，原"最新参数仍存活"断言保留 |
| R21 | `prime-agent-runtime/test/test_repl.py:687` | `fresh.send({"type":"restore","id":"r1","path":path})` → 追加 `"python_version": manifest["pythonVersion"]` | OK：跟随 L8D-1 fail-closed（版本缺失即隔离 code object）；旧行为在 `test_l8d_impl.py:119`、`test_r35_impl.py:261` 有专门正/负用例。范围内同类同步还有 `test_rt5_impl.py:120` |

---

## B. 同夜的"纯阈值放宽"提交（新文件，同样给判定）

| 提交 | 文件:行 | 旧 → 新 | 判定 |
|---|---|---|---|
| `40d2683d5` | `test/settings-ancestor-scope-resilience.test.ts:133` | `waitFor(…, 5000)` + 用例超时 `10000` → `waitFor(…, 20000)` + `25000` | **合理放宽**：被断命题 `expect(applied).toBe(true)` 逐字未变，放宽的只是等待窗口（副作用：真挂起时用例耗时从 5s 变 20s） |
| `8873bc681` | 同文件 `:135-149` | 新增"失败时 `console.error` 打印 watchers/stamps"诊断 | **不掩盖失败**（诊断块在 `expect(applied).toBe(true)` **之前**、无 early-return，断言仍执行）；但它以 `manager as unknown as { ancestorStamps?: …; externalWatchers?: … }` 探两个 `private` 成员——**违反仓规**（AGENTS.md："no same-file shadow types cast to with `as unknown as`"，理由"renaming a private member must not be able to break a test silently"）。闸门盲区：`check-test-private-probes.mjs` 的 `private-cast` 规则匹配 `_` 前缀成员、`private-cast-alias` 只匹配**同文件具名** shadow type，本处是匿名内联 shadow type + 无 `_` 前缀 → `--base b7f26e98b --strict-diff` 报 `failing:0`。重命名 `ancestorStamps` 后该诊断静默打印 `stamps: undefined` 而测试不红。★升级建议：改走公共 seam，或至少加 `// test-hygiene-allow: …` 让债务可见 |
| `12da2cdf2` | `test/r31-guard-contention.test.ts:89` | `ticks.filter(t => t.fired - t.scheduled > 50)` → `> 500` | **合理放宽（保留 2x 余量）**：改动前 `Atomics.wait` 100×10ms 会饿死整段 ~1s 守卫预算 → 迟到 ~1000ms 仍 > 500ms，能抓；但**无正控**（没有注入"必然饥饿"的负例证明尺还在），且 500ms = 10ms 采样周期的 50 倍，400ms 级别的部分退化会漏 |
| `12da2cdf2` | `test/daemon-supervisor-launch-startid-async.test.ts:150` | `expect(maxGapMs).toBeLessThan(SYNC_PS_BLOCK_MS * 0.6)`（=48ms） → `* 2`（=160ms） | **合理放宽**：同用例 `:146 expect(launchProbe.syncStartIdCalls).toBe(0)` 是**独立**的主判据（回归一旦重新走同步 `ps` 就直接红，与时间无关）；且改动前 `5×80ms=400ms > 160ms` 仍能触发时间断言 |
| `6a992d8c0` | `test/rlm-child-stream-scaling.test.ts:258` | 见 **R9** | **命题被削弱（须修）** |

---

## C. 特别检查

1. **阈值放宽是否配了正控**：R9（无正控，且被证明可放过缺陷）、R11（无正控，且理由被同文件精确值断言证伪）、`r31-guard-contention`（无正控，余量 2x）、`daemon-supervisor-launch-startid-async`（无需，主判据独立）、`settings-ancestor`（命题未变，不需）。→ 范围内 **3 处放宽缺正控**，其中 2 处必须修。
2. **`skipIf` 条件**：范围内新增行只有 1 处 `it.skipIf(!chmodCanBlockReads)`（`test/session-lease.test.ts:399`），`chmodCanBlockReads = typeof process.getuid === "function" && process.getuid() !== 0`（`:55`）——运行时可判定、非永真、非永假：本机 `id -u = 501` → 条件为真、用例实际执行（正控实跑：`npx vitest --run test/session-lease.test.ts` → `Tests 16 passed (16)`，含 `:399` 那一条，`Duration 2.25s`；若条件永假，则 16 条里会少 1 条 skipped 且 `tests` 仍报 16/16 但带 skip 计数——本次输出无 skipped）。0 处无条件 skip。
3. **新增 CI 诊断是否掩盖真实失败**：唯一新增诊断（`8873bc681`，R22/B 表）在断言之前、不 swallow、不改控制流 → **不掩盖**；问题只在它本身的私有成员探针（见 B 表）。
4. **"无问题"结论的覆盖声明**：`it.skip`/`describe.skip`/`.only`、数据驱动循环守卫三项我是对**范围内新增行全集**（8806 行，`git diff -U0 | grep '^+'`）做的正则统计：`it.skip(`=0、`describe.skip(`=0、`.only(`=0、`it.skipIf(`=1、`expect(len).toBeGreaterThan/OrEqual`=10（均在循环外先断集）。这是本次扫描范围内的结论，不覆盖逐用例人工阅读全部 47 个新文件。

## D. 结论（一句话）

**本批测试债不可原样接受：21 处改写里 19 处是机械跟随/规格变更（含 2 处更强、6 处有新增支撑），但 R9（`rlm-child-stream-scaling.test.ts:258` 的相对阈值）与 R11（`daemon-supervisor-eviction.test.ts:423` 的 `expect.any(Number)`）必须回滚/收紧——它们把"能抓 bug 的尺"换成了"改动前的实现也可能通过的尺"，且理由分别被我实测数据与同文件仍为精确值且全绿的对照用例证伪；另有 3 条建议补正控（r31-guard-contention、display-cache hit-rate、QP-3 重试送达），1 条须按仓规处理私有成员探针（settings-ancestor-scope-resilience.test.ts:135-149）。**

### 复现命令（全部只读）

```
git diff --numstat b7f26e98b..HEAD -- 'packages/*/test/**' 'prime-agent-runtime/test/**'
git diff b7f26e98b..HEAD -U8 -- <file>          # 逐文件旧/新逐字
git diff b7f26e98b..HEAD -U0 | grep '^-.*expect('   # 改写断言的完整清单（20 行）
cd /tmp/audit_r/round-41/testdebt-work && /Users/a1/Desktop/ai/prime-agent/node_modules/.bin/tsx perf-probe2.ts
cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/daemon-supervisor-eviction.test.ts
node scripts/check-test-private-probes.mjs --base b7f26e98b --strict-diff --json
```
