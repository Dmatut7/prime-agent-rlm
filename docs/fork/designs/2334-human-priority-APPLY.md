# APPLY.md — #2334 调和实现（human 优先 × fork queue pins）· v2 交卷

> 本件与 `2334-human-priority-reconciliation.md`（设计）一起落仓：`docs/fork/designs/`。
> v1 的 APPLY.md 是仓外交付件，被 `2334-*.test.ts` 的头注引用却不可解析 ⇒ v2 落仓并把引用改成仓内路径。

## 0. base 与漂移链（先读这段）

| 项 | 值 |
|---|---|
| **交卷 base** | **`d51118e32`**（母席 G1 裁）；漂移链：原任务书 `91da42b93` → 母席 09:1x 改 `de1ad0b06`（v1 五笔的 base）→ 母席 G1 裁落最新 HEAD **`d51118e32`**（v2 已 rebase） |
| 施工克隆 | `/tmp/p2334`，detached HEAD（**主仓工作树一个字节都没动**，只 `git fetch` 读对象）。交卷 HEAD＝落这两份文档的那一笔（`docs(fork): land the #2334 reconciliation design and apply notes`），其父＝`0bf472576`；变异正控跑在其祖父 `171281de7`（与本笔只差文档），故 §5 的读数与交卷树行为等价 |
| rebase | `git rebase --onto d51118e32 de1ad0b06 47d775592` ⇒ **零冲突**（v1 五笔全部干净重放） |
| v1 五笔（rebase 后新 sha） | `5ea998daf`(src) / `20942fa2d`(store 钉) / `7efaf9352`(2334+6158 钉) / `d6d29417d`(docs+changes) / `3b3d8808c`(queue 四例适配)（rebase 前＝`df7d1e197`/`32e2c9cb7`/`318ca5301`/`b444f9ad7`/`47d775592`） |
| 上游实现 | `dca77ecfe`「prioritize human messages ahead of queued agent traffic (#2334)」；是 base 的祖先，内容在 P3 selective merge `67334bf1a` 被 take-ours 丢掉（＝「本窗被 revert」） |
| 母席裁示 | `docs/fork/merge-upstream-20260917.md` §11 QP-4 行：**全量移植，人优先仅限 lane 内，机器互序不变**；§9.2 行 318 / §10③ 行 344＝调和设计待办（**状态翻面归母席/doc 车道，本席不动那个脏文件**） |
| 坐标口径 | 一律**以符号名为准**；出现的行号读自本件 §5 标注的那棵树，只作定位辅助 |

## 1. 补丁与应用序

产物目录 `/tmp/p2334-out/`：`DESIGN.md`（＝仓内 `docs/fork/designs/2334-human-priority-reconciliation.md`）、
`APPLY.md`（＝仓内 `docs/fork/designs/2334-human-priority-APPLY.md`）、`patches/`。

**v1 五笔（rebase 到 d51118e32 之后）**

| 序 | sha | 面 | 内容 |
|---|---|---|---|
| 1 | `5ea998daf` | src | store 加优先级轴（`SessionActionPriority`/`PRIORITY_RANK`/`SessionActionPlacement`、`SessionAction.priority` 必填、`enqueue(action, placement)` 吃掉 `enqueueFront`、`insertionIndex()`、QP-4 注释补裁决序）；agent-session 派生与接线（`sessionActionPriorityForInputClass`/`sessionActionPriorityFor`、goal 前插 `pinned`、`_prompt` 两处、`steer`/`followUp` 默认 human、恢复两路、`restoreSessionActions`、`_admitSessionInput` placement、`_queuePreparedPrompt` 透传、快照带 priority）；daemon cron 两处 `background`；cli 快照 priority 枚举校验 |
| 2 | `20942fa2d` | test | store fixture 加 `priority`、`enqueueFront`→`enqueue(a,"front")`，＋6 例 store 钉 |
| 3 | `7efaf9352` | test | 新增 `2334-human-priority-lane-scoped.test.ts`(7 例) ＋ `6158-human-message-priority.test.ts`(上游 4 例移植) |
| 4 | `d6d29417d` | docs | README / docs/settings.md / docs/usage.md 三段「Who overtakes whom」＋ `.changes/eng-6158-human-message-priority.md` |
| 5 | `3b3d8808c` | test | `agent-session-queue.test.ts` 四例适配（§3 冲突回执 #7/#8） |

**v2 新笔（forward，禁 amend/reset；全部 `git commit --only --`）**

| 序 | sha | 面 | F 编号 | 内容 |
|---|---|---|---|---|
| 6 | `fdbfa1cc1` | test | **F1** | `daemon-mode.test.ts`：抄上游 `dca77ecfe` 那 4 行（`{ resumeIfIdle: true, priority: "background" }`）修好 3 红；**并补钉 idle 路径**（上游 hunk 没覆盖：`promptUntilAccepted` 的既有断言是 `objectContaining`，撤掉字段也不红） |
| 7 | `9a100d3b5` | test | **F6+F7** | 清 5 处 `as never`（夹具返回 `AgentSessionMessage`）＋ 6158 改用 `conversationMessages()`、删掉「本 fork 无此 helper」那句事实错误注释、投递序改按 agent-message id 认 |
| 8 | `d49b16669` | test | **F3** | 手排钉改**跨 rank**：store 级 `moveQueued` 腿改跨 rank ＋ 新增 `swapQueued` 跨 rank 例（Ctrl+Alt 真正驱动的原语）；session 级同名词改跨 rank（回执手排到 human 前 + 快照复放） |
| 9 | `febd8c2ab` | test | **F4** | `agent-session-goal.test.ts` 新增 session 级钉：**经生产路径**（`/goal` → `_runOrQueueGoalContext` 的 queued 分支）触发 `pinned`，再送 human followUp，断言 goal context 握住队首 |
| 10 | `157f4ca66` | src(注释) | **F2** | 压缩闸 human/system_fence 站开那行加**据实注释**（不可达＋纵深防御＋可观测半支由谁钉＋将来出现可达入口须同批补钉），照 `d51118e32` 的先例；**行为零变化** |
| 11 | `1661b777d` | docs | **F10** | 三处「Who overtakes whom」补 extension 半句（同判据⇒不撕裂；但 extension 不是「你」）＋ README 补「唯一越到手排前面的是 goal context 前插」＋ `.changes` 追一条 |
| 12 | `171281de7` | test(注释) | **F5** | `2334-*.test.ts` 头注那句 "every ordering assertion names the line whose removal turns it red" **改成实测口径**（逐组点名 M1/M2/M3/M5/M6/C6/C7/M7，并明写「闸的 human 站开本文件不声称有钉」） |
| 13 | `0bf472576` | test(注释) | **F5** | 头注引用的 APPLY.md 改成仓内路径 `docs/fork/designs/2334-human-priority-APPLY.md` |
| 14 | （本笔） | docs | **F5+F8** | DESIGN + APPLY 落仓 `docs/fork/designs/`；DESIGN header base 改 `d51118e32`＋漂移链、§5 行号按新树重读、§8 正控表换成 v2 实测 |

应用命令（在主仓 `merge/repl-kernel` 上，施工车道冻结窗口内）：

```bash
git am --3way /tmp/p2334-out/patches/v2/00*.patch      # v1 五笔 + v2 九笔，保留提交信息
# 或一次性（不带提交）：
git apply /tmp/p2334-out/patches/ALL-2334-v2-combined.diff
```

**回滚把手**：倒序 `git revert --no-edit` 十四笔。只回滚行为面＝revert `5ea998daf`，但必须同时 revert
`20942fa2d`/`7efaf9352`/`3b3d8808c`/`fdbfa1cc1`/`d49b16669`/`febd8c2ab`，否则红的是钉不是行为。

## 2. 语义摘要（一句版）

队列排序＝ **lane（QP-4，第一轴） > priority（#2334，第二轴，只在 lane 内） > 到达序**；
priority 的判据不抄上游启发式，改为从 fork 单一分类点派生：
`sessionActionPriorityForInputClass(cls) = inputClassOrigin(cls)==="human" ? "user" : "background"`，
外加一条结构守卫 `isAgentSessionMessageId(agentMessageId) → background`；`pinned` 只出现在 goal context 前插点。
**没动**：`selectFirst()`、`canSelectSessionAction()`、`_incomingAgentMessageCompactionGate()`（v2 只加注释）、
`input-classification.ts`、`moveQueued`/`swapQueued`、daemon 协议 rev38、任何 prompt/模型可见面。

## 3. 冲突回执（每块取了谁 / 为什么 / 翻回把手）

v1 的 8 条（#1 判据取 fork 分类器、#2 lane 压 priority、#3 steer/followUp 默认 human、#4 parked queue 用 envelope 推断、
#5 `agentmsg_` 守卫用既有 helper、#6 压缩闸一字未动、#7 既有测试 3 例适配、#8 clearQueue/S1 承认行为变更）**全部原样有效**，
翻回把手见 v1 文本（本件 §1 的五笔 sha 已换成 rebase 后的）。v2 新增 6 条：

| # | 冲突点 | 取了谁 | 为什么 | 翻回把手 |
|---|---|---|---|---|
| 9 | **F1 是否只抄上游那一个 hunk** | **上游 4 行 ＋ 本席补钉第二处** | 上游只改了 `followUp`（queued cron）那条断言。实测另一处 `promptUntilAccepted`（idle cron）撤掉 `priority:"background"` **0 红**——既有断言是 `expect.objectContaining`，字段在不在都过。母席口径是「daemon **两处** background 撤掉就该红」，所以给 idle 路径补了一条 `toMatchObject({ priority: "background" })`，并把 fixture 的 mock 签名标上真类型 `SessionActionPriority`（让写错字面量变成编译错） | 删掉那条 `toMatchObject`；正控 F1b 会回到 0 红（已实测：补钉前 0 红 / 补钉后 1 红） |
| 10 | **F3 是"只加钉"还是"改实现＋改文档措辞"** | **只加钉**（实现与文档一字未改） | 施工单 §2 要求先实测「rank 是否压过手排」。实测：`insertionIndex` 从**尾部**反向扫，遇到第一个「不再 queued 或 rank ≥ 来者」的项就 break ⇒ 来者只会跳过尾部那段严格低 rank 的连续区，永远不会走到手排那对中间。跨 rank 钉在交付树上**全绿**（复核席独立探针 6/6 绿同结论）⇒ README.md 那句「reordering by hand is never undone」不是过度承诺，无需改措辞 | 若将来把插入改成整 lane 重排，M6/M6b 两条变异会立刻红（已实测 2 红 / 1 红） |
| 11 | **F3 的手排钉用哪个原语** | **两个都用**（`moveQueued` 腿＋新增 `swapQueued` 腿） | 施工单给的形状是 `moveQueued(bg, lane, 0)`，但复核席的 M6 变异打在 `swapQueued` 上——而 `mutateQueuedMessage(..., {type:"move"})` 走的正是 `swapQueued`（`agent-session.ts` 内 `this._actionStore.swapQueued(item, neighbor)`）。只写 `moveQueued` 腿 ⇒ M6 仍然 0 红。所以 store 级两腿都写，session 级走公开入口（Ctrl+Alt 的真实路径） | 删掉 `never lets a rank re-sort undo a hand swap across ranks` 一例；M6 会从 2 红降到 1 红（只剩 session 级） |
| 12 | **F4 的钉放哪个文件 / 读哪个面** | 放 `test/suite/agent-session-goal.test.ts`，读**恢复快照** | ①该文件已有 goal 全套夹具（faux ipython、`createGoalHarness`、`COMPLETE_GOAL_CELL`），在 `2334-*` 里重建＝复制 30 行夹具；②goal context **不是 queue-visible**（`visibleSessionActionProjection` 只放行 `session_command`/`queueVisible`/`acceptedAgentMessage`），所以 `getFollowUpMessages()` 根本看不见这条 lane——第一版就是这么红的（`expected [] to have a length of 1`）。快照面（`getSessionActionRecoverySnapshot().actions`）带 priority 与 lane 序，是公开面且正是 restart 复放的东西 | 若要让 goal context 变成 queue-visible，改 `visibleSessionActionProjection`（会动 TUI 队列显示面，独立一席）；本钉改读 `getFollowUpMessages()` 即红 |
| 13 | **F4 怎么让 `_runOrQueueGoalContext` 走 queued 分支** | 两段式 wait 工具（一次调用一道闸） | 实测：session command **不会**在 turn 中间被派发（泵先 `await agent.waitForIdle()`），所以「阻塞 turn 里发 `/goal`」只会把命令排进队，goal 永远是 idle 分支（第一版实测 `goalState.status` 停在 `idle`）。改成：turn A 阻塞 → 排 `/goal` 命令 + 排一条 human **steer** → 放 turn A ⇒ 泵在边界执行 `/goal`（goal context 前插进 `when_run_idle`），接着 QP-4 让 steering 的 human 先跑成 turn B 并**再次阻塞** ⇒ 此时 session 忙、goal context 在队，再送 human followUp 才是 M7 能看见的形状。既有 `createWaitingTool()` 只有一道共享闸（放一次就全放），故本例自带 per-call 闸 | 删掉这一例；M7 回到 0 红（v1 实测 54 例全绿） |
| 14 | **F2 补钉还是据实注释** | **据实注释**（母席裁 (b) 不可达） | 复核席 4 例可达性探针逐环钉住：唯一 human 类 customType 的真 envelope 过不了 `isAgentSessionMessage()` ⇒ 被入口丢成 undefined；闸自己的兜底 envelope 对 interactive/rpc/extension/internal/undefined 五种 source 全落 `origin==="agent"`（分类器规则①先于一切 human 标记）；能过 `isAgentSessionMessage()` 的 envelope 即使配 human source + `agentmsg_` id 仍判 agent；`incomingInputFactsFromMessage()` 没有 `isSystemFence` 入口 ⇒ fence 半支同样不可达。本席在 v2 树上复跑 M4＝**27 例 0 红**，与裁定一致 ⇒ 不写假钉，改写据实注释（照 `d51118e32` 给 cancel 侧 digest re-arm 的写法），并**保留 v1 的 C6/C7 模拟钉**守可观测半支（v2 复跑 C7＝1 红） | 删注释即回到「无说明的不可达半支」；若将来把这条裁决挪到 `_admitSessionInput`（所有输入的必经点），注释里已写明须同批补钉 |

## 4. 闸（红绿；v2 口径＝**73 文件邻接集 ∪ 补丁波及的所有 test 文件**）

清单：`/tmp/_2334_v2_runset.txt`（**77 文件**）＝ `/tmp/_2334_adj73.txt`(73) ∪ `test/daemon-mode.test.ts`（被 src 改动打到，v1 的 75 口径漏了它 ⇒ 漏掉那 3 红）
∪ `2334-human-priority-lane-scoped.test.ts` ∪ `6158-human-message-priority.test.ts` ∪ `test/suite/agent-session-goal.test.ts`（F4 新钉所在，**不在**关键词邻接集内）。

| 闸 | 干净基线 `d51118e32` | v2 交卷树 |
|---|---|---|
| 邻接集 73 ∪ daemon-mode ＝ **74 文件** | **218 suites / 1024 例 = 1014 pass + 10 pending + 0 fail，EXIT=0**（`/tmp/v2-baseline-d51118e32.json`，逐文件 `/tmp/v2-baseline-perfile.json`；worktree `/tmp/p2334-base2`） | — |
| ＋ `agent-session-goal.test.ts` ＝ **75 文件** | 上 + **51/51**（`/tmp/v2-baseline-goal.json`）⇒ 合计 **1075 例 0 fail** | — |
| **77 文件全量** | — | **227 suites / 1094 例 = 1084 pass + 10 pending + 0 fail，EXIT=0，`success=true`，new-red=0**（`/tmp/v2-final-gate.json`，逐文件 `/tmp/v2-final-gate-perfile.json`） |
| **`test/daemon-mode.test.ts` 单独读数**（母席点名） | 198 例 0 fail | **198 例 = 198 pass + 0 fail**（rebase 后未修 F1 时是 **195 pass + 3 fail**，`/tmp/v2-after-rebase.json`；F1 一笔修好） |
| 逐文件对账 | 74+1 文件 | **无文件丢失、无 0 断言文件、无一文件例数减少**；增量＝`session-action-store.test.ts` 37→44（v1 +6，v2 F3 +1）、`agent-session-goal.test.ts` 51→52（F4 +1）、新增 `2334-*`=7 / `6158-*`=4。口径闭合：1024+7+52+7+4=**1094** |
| `npx tsgo --noEmit` | 0 | **0**（EXIT=0，空输出）。**闸自带正控**：往本轮改过的 6158 文件里塞一行 `const _tsgoProbe: number = "not a number";` ⇒ `TS2322`、EXIT=2；删掉 ⇒ EXIT=0 ⇒ 这个 0 不是"没扫到 test 目录"的假绿 |
| `npx biome check --error-on-warnings .` | 0 | **0**（1494 files；中途 organizeImports 报过 1 处，已在本席内修掉再跑） |
| `npm run check:test-hygiene`（root） | — | **OK（no new private-member probes）**：936 文件、497 处存量私有探测（474 baseline + 23 allow）、**新增 0** ⇒ 新钉全走公开面（`mutateQueuedMessage`/`getSessionActionRecoverySnapshot`/`getSteeringMessages`/快照/`prompt`/`steer`） |
| 变异正控 12 条 | — | 见 §5；每条变异后 `git checkout --` 复位并核 `git status --porcelain` 为空 |

复跑命令：
```bash
cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run $(cat /tmp/_2334_v2_runset.txt | tr '\n' ' ') \
  --reporter=json --outputFile.json=/tmp/x.json
```
（**不要**用 `vitest list --json <文件>`：它会把 JSON 写进那个测试文件本身。）

## 5. 正控实跑记录（撤改即红；G7：变异实测，不接受眼看）

跑法：worktree `/tmp/p2334-mut`（HEAD=`171281de7`，与交卷 HEAD 只差第 13 笔那行注释）内做**单点语义撤改**（精确串替换，
命中数必须 ==1，否则记 `MUTATION-NOT-APPLIED`）→ 跑钉文件（JSON reporter）→ `git checkout -- <file>` 复位 → 核树干净。
脚本 `/tmp/p2334-out/v2-controls.py`；逐次原始报告 `/tmp/p2334-out/v2/<id>.json`；**每条变异的 diff** `/tmp/p2334-out/v2/<id>.diff`；
汇总 `/tmp/p2334-out/v2/summary.json`；日志 `/tmp/p2334-out/v2-controls-all.log`。

| 正控 | 单点撤改 | 跑的钉文件（例数） | 结果 | 红了哪些 |
|---|---|---|---|---|
| **GREEN** | 无（原样） | store+2334+6158+queue+daemon-mode（366） | **366/366 全绿** | — |
| **F1a** | daemon `followUp`（排队中的 generic cron）撤 `priority:"background"` | daemon-mode（198） | **3 红** | `queues generic cron jobs while the target is accepting an agent message` / `…behind accepted agent message prompts` / `…behind pending messages`（＝复核席报的那 3 红，现在由钉守） |
| **F1b** | daemon `promptUntilAccepted`（idle generic cron）撤 `priority:"background"` | daemon-mode（198） | **1 红**（补钉前实测 **0 红**） | `prompts idle generic cron jobs without a heartbeat coalescing key` |
| **M6** | `swapQueued` 末尾加整 lane 按 `PRIORITY_RANK` 重排 | store+2334+queue-mutation+queue（173） | **2 红**（v1＝0 红） | store `never lets a rank re-sort undo a hand swap across ranks`；2334 `never re-sorts a queue the user reordered by hand` |
| **M6b** | `moveQueued` 末尾加整 lane 按 `PRIORITY_RANK` 重排（本席新造，给 moveQueued 腿配正控） | 同上（173） | **1 红** | store `never re-sorts a queue the user reordered by hand` |
| **M7** | goal 前插点撤 `priority:"pinned"`（保留 `front:true` 机制） | 2334+goal+store+6158（107） | **1 红**（v1＝0 红） | goal `keeps a queued goal context ahead of a human follow-up that arrives after it` |
| **M1** | `insertionIndex` 的 priority 分支改 `return list.length`（回到纯尾插） | store+2334+6158+queue（168） | **11 红** | store 5 例（human 越 background／不插到已出队前／pinned／两条手排）、queue clearQueue、2334 快照+恢复／手排／**老板现场例**、6158 第 1、2 例 |
| **M3** | `sessionActionPriorityForInputClass` 恒返回 `"user"`（撤 origin 派生） | 同上（168） | **3 红** | derivation 三例（全表映射／各形态／抗伪造） |
| **M2** | 撤 `isAgentSessionMessageId` 守卫 | 2334+queue+6158（124） | **2 红** | derivation id 守卫例、queue clearQueue |
| **M5** | 撤 `_admitSessionInput` 的 `restore‖preserveOrder → "tail"` | 6158+2334+queue（124） | **1 红** | 6158 `restores a persisted queue in its stored order` |
| **C7** | 模拟「human 也被压缩闸挡住」的错误实现（排队时上报 `compaction_pending`） | 2334+matrix（27） | **1 红** | **老板现场例**（`humanPreflight.reason` 必须 undefined）⇒ 闸的可观测半支有真钉 |
| **M4** | 撤压缩闸的 human/system_fence 站开半支 | 2334+matrix（27） | **0 红**（＝复核席裁定 (b) 不可达，v2 树上复跑一致） | 无。这**不是**漏钉：该半支在当前调用图不可达（§3 #14 四环证据），已改成据实注释；可观测半支由 C7（1 红）与 v1 的 C6 守 |

区分「固化保证」与「样本未触发」：F1a/F1b/M6/M6b/M7/M1/M2/M3/M5/C7 都是**实跑检出**；M4 是**实跑未检出且已给出不可达证据链＋据实注释**（不是"没跑"）。
v1 的 C1-C7 读数（8/3/2/1/0/1/1 红）仍成立，只是文件集口径不同（v1 用 4 个 pin 文件 167 例）；v2 表里的例数与文件集一并给出，便于逐条复核。

## 6. 偏离与未做（逐条）

1. **未碰 `docs/fork/merge-upstream-20260917.md`**：§9.2 行 318 / §10③ 行 344 / §11 QP-4 行需要翻状态（待办→已落地，并指向
   `docs/fork/designs/2334-human-priority-reconciliation.md`）。该文件在主仓工作树是**别车道在跑的脏文件**（母席明令不动），
   v2 也没动 ⇒ 交母席在合并窗口内落（复核席 F11，母席已挂账给 doc-v11 席）。
2. **F2 记为设计债，不记为已钉**（母席裁 (b)）：压缩闸 human/system_fence 站开半支**无可达公开入口**，变异不可红；已加据实注释
   ＋保留 C6/C7 模拟钉守可观测半支。与下一条并册。
3. **未修「hung 压缩 + human 排队没有 stall 上界」**（base 既有洞，与 #2334 无关）：`_armCompactionGateWatchdog()` 只在 agent
   回执命中闸时武装；human 排在 hung 压缩后面时没有兜底（stall 看门狗在压缩期间 snooze）。一行修法：`_admitSessionInput` 里
   `action.priority === "user" && this.isCompacting` 也武装同一看门狗。**不做**的理由：会碰 `compaction-input-priority-matrix`
   的 watchdog 例与 `interactive-mode-queue-compaction-line` 既有 pin，属独立高风险改动 ⇒ 母席另立车道（可选加固方向＝把闸判据
   挪到 `_admitSessionInput` 这个所有输入的必经点，届时 F2 的不可达半支同时变成可达且必须补钉）。
4. **F9 未做**（复核席观察项，母席 v2 清单未列）：`_promptInjectedMessage`（`agent-session.ts`，符号名为准）不接受也不透传
   `priority`。已核其调用点全是机器注入（cron/heartbeat 等），envelope 推断＝background，**当前语义正确**；风险是将来若有人类
   输入走这条路径，`priority` 会被静默丢弃（options 里没这个键 ⇒ 无编译错）。修法二选一（加 `priority?: SessionActionPriority`
   透传 / 在函数注释写死「本路径只承载机器注入消息」的不变量），都不属 v2 判据 ⇒ 挂账不夹带。
5. **G6 后果登记（不改实现，母席挂账）**：`steer()/followUp()` 走单一推断路径（合成 `source:"interactive"`），动作**记录的**
   source 仍是 `"internal"` ⇒ 升级那**一次**重启窗口内，旧快照里没有 `priority` 字段的已排队 human steer/followUp 会按
   `source:"internal"` 重推成 `background`（一次性影响，之后新快照都带字段）。已写进 docs 与本件；建议母席挂 FORK_NOTES。
6. **parked queue 恢复用 envelope 推断**（v1 §3 #4，母席已采纳）：不动 daemon 协议 rev38。残余风险＝将来 parked 队列里若出现
   「无 envelope 的机器 prompt」，会被当 human 提权（方向是"不误降正常输入"）。母席挂 FORK_NOTES。
7. **clearQueue / S1 两处承认行为变更**（v1 §3 #8，母席已采纳）：翻回把手＝改 `input-classification.ts` 的 extension 归属规则
   （会牵动它自己的钉），S1 期望随之翻回。
8. **未 push、未碰主仓工作树、未动 prompt/模型可见面**：`priority` 不进 prompt、不进摘要、不进压缩切点计算，只活在队列结构与
   恢复快照里。主仓只被 `git fetch` 读过对象。
9. **v2 全部 forward 新笔，零 amend / 零 reset**；每笔 `git commit --only -- <paths>` 点名。

## 7. F1-F10 逐条落点（对母席清单）

| F | 判定 | 落点（符号名为准） | 交付 | 正控 |
|---|---|---|---|---|
| **F1** | 阻塞·3 红 | `test/daemon-mode.test.ts` 的 `queues generic cron jobs …` it.each 断言（原 8631 行）＋ `prompts idle generic cron jobs …` 的 else 分支 | 第 6 笔 `fdbfa1cc1`：抄上游 4 行；另补 idle 路径 `toMatchObject({priority:"background"})` 与 fixture mock 的真类型 | F1a **3 红** / F1b **1 红**（补钉前 0 红）；daemon-mode **198/198 绿** |
| **F2** | 母席裁 (b) 不可达 | `src/core/agent-session.ts` `_incomingAgentMessageCompactionGate()` 内 `inputClassOrigin(inputClass)==="human" ‖ inputClass==="system_fence"` 那行上方 | 第 10 笔 `157f4ca66`：16 行据实注释（不可达证据、纵深防御、可观测半支由谁钉、将来出现可达入口须同批补钉）；行为零变化；保留 v1 C6/C7 钉 | M4 **0 红**（＝不可达，与裁定一致）；C7 **1 红**（可观测半支有真钉） |
| **F3** | 阻塞·钉不敏感 | `test/session-action-store.test.ts` `never re-sorts a queue the user reordered by hand`（改跨 rank）＋**新增** `never lets a rank re-sort undo a hand swap across ranks`；`2334-*.test.ts` session 级同名词（改跨 rank，走 `mutateQueuedMessage`→`swapQueued` 真实入口） | 第 8 笔 `d49b16669`（**只加钉**：实测 rank 不压手排 ⇒ 实现与 README 措辞都没动，见 §3 #10） | M6 **2 红** / M6b **1 红**（v1 均 0 红） |
| **F4** | 阻塞·无钉 | `test/suite/agent-session-goal.test.ts` 新增 `keeps a queued goal context ahead of a human follow-up that arrives after it`（经生产路径 `/goal`→`_runOrQueueGoalContext` queued 分支；观测面＝恢复快照，因 goal context 非 queue-visible） | 第 9 笔 `febd8c2ab`（§3 #12/#13 记了两处取舍与两段式闸的必要性） | M7 **1 红**（v1＝54 例 0 红） |
| **F5** | 撤回→v2 仍要做 | `docs/fork/designs/2334-human-priority-{reconciliation,APPLY}.md` 落仓；`2334-*.test.ts` 头注 | 第 12/13/14 笔：头注改成实测口径（逐组点名变异＋明写哪半支无钉）＋引用改仓内路径；本件即 v2 APPLY | — |
| **F6** | 次要·5 处 `as never` | `2334-*.test.ts`（`childReply` 返回类型、两处 `queueAgentMessagePrompt`、一处 `acceptAgentMessagePrompt`）、`6158-*.test.ts`（`agentMessage` 返回类型、`customMessage`、`restoreSteeringMessage`） | 第 7 笔 `9a100d3b5`：夹具标 `AgentSessionMessage`，5 处 `as never` 全清，连带清掉 4 处已成冗余的 `as string`（`content` 本就是 `string`） | `grep -c "as never\|as any\|as unknown as" 两个钉文件` = 0；tsgo 0（带 TS2322 正控） |
| **F7** | 次要·事实错误注释 | `6158-*.test.ts` 头注与 `conversationTexts()` | 第 7 笔：改用 `conversationMessages(harness.session)`（`test/suite/harness.ts` 有导出），删掉错误注释，头注只留「整串比对」这条真适配；投递序改按 agent-message id 认（比 `includes(body)` 更严，一条消息含两个 body 也不会认错） | 6158 4 例全绿；M1/M2/M5 仍能红（说明改法没削断言） |
| **F8** | 次要·DESIGN 漂移 | `docs/fork/designs/2334-human-priority-reconciliation.md` header ＋ §5 位点表 | 第 14 笔：header 改 `d51118e32` 并留完整漂移链；§5 行号按新树重读并标注读数所在 sha，一律「符号名为准」 | 逐位点重读（`grep -n` 派生，非手抄） |
| **F9** | 观察·未做 | `_promptInjectedMessage` | **未做**，§6 #4 挂账 | — |
| **F10** | 次要·文档口径 | `README.md` / `docs/settings.md` / `docs/usage.md` 三段「Who overtakes whom」＋ `.changes/eng-6158-human-message-priority.md` | 第 11 笔 `1661b777d`：补 extension 半句（同判据⇒不撕裂；读的是 source 与消息形状，不是「谁打的字」）；README 另补「唯一越到手排前面的是 goal context 前插（不重排）」 | 无测试断言这三段措辞（已 grep 确认）；biome 0 |

## 8. 复核席接口（v2）

- 树：`/tmp/p2334`（交卷 HEAD 见 §1 表）；变异 worktree `/tmp/p2334-mut`；干净基线 worktree `/tmp/p2334-base2`（`d51118e32`）。
  三者 `node_modules` 均符号链到主仓 root，未 `npm i`。
- 取对象（只读）：`cd /tmp/p2334 && git bundle create /tmp/p2334-out/sib-v2.bundle d51118e32..HEAD`。
- 补丁：`/tmp/p2334-out/patches/v2/00*.patch`（`git format-patch d51118e32..HEAD`）与 `ALL-2334-v2-combined.diff`；
  sha256 见 `patches/v2/SHA256SUMS`。
- 建议复跑：①77 文件全量（`/tmp/_2334_v2_runset.txt`）对 `/tmp/v2-baseline-d51118e32.json` + `/tmp/v2-baseline-goal.json`
  逐文件对账；②`tsgo --noEmit`（记得自带正控）；③`biome check --error-on-warnings .`；④`npm run check:test-hygiene`（root）；
  ⑤变异 12 条 `python3 /tmp/p2334-out/v2-controls.py <你的 worktree>`（每条自己复位并核树干净）；
  ⑥`git apply --check ALL-2334-v2-combined.diff` @ `d51118e32`。
- v2 验收线（母席采纳的判据）：F1 daemon-mode 198/198 且两处 background 撤掉都红；F3 跨 rank 且 M6 红；F4 经生产路径且 M7 红；
  F6 零 cast；F7 用 `conversationMessages`；F8 header/行号；F10 三处半句；F2 据实注释（不声称已钉）。
