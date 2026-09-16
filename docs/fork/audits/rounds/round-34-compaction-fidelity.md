# r34 · 压缩摘要质量与上下文保真（模型智能面）

- 冻结 SHA：`07a1cd215bd1b10acc2360a0be37ba01f38bd359`（主仓 HEAD，只读）；工作树 `/tmp/r34wt`（symlink node_modules）
- 语料：真实 RLM 子代理会话 `session-artifacts/01a08c40-…/01a09145-4dce-…jsonl`（"摘上游三件优点"任务：279 entries / 1.0MB / 208 条消息全部在**单一 turn** 内，任务简报以 `custom_message(agent_message)` 进入）
- 驱动：走**真实代码路径** `prepareCompaction() → compact()`，summarizer 用真模型 `bailian/qwen3.8-max-0902`（`completeSimple`，与生产同 wire 形态）。共 4 次真实压缩调用（gen1 一发压缩、T1 早触发、T2 二代更新、QA 探针臂）＋ 2 次离线预算复核。工件：`/tmp/r34out/`（gen1/t1/t2/retention-matrix/prep 等 json + summarizer-input.txt）
- 成本：4 次压缩共 ¥0.46，单次 25–60s

## ① 摘要器保真（真实压缩 × 真模型）

信息保留矩阵（gen1，压缩前后模型可见上下文逐项核对，11 组探针×4 载体）：

| 关键信息 | narrative | fact-appendix | 保留区(20k tok) | 结论 |
|---|---|---|---|---|
| 三件上游 SHA (0894de1de/bcdcd6e65/9c8230df6) | ✅3/3 | ✅ | ✅ | 双通道冗余 |
| 评估报告路径 /tmp/ma_audit/upstream_41_review.md | ❌ | ✅ | ❌ | **仅机器块救命** |
| DAEMON_SCHEMA_REVISION=29（撞号红线） | ✅(narrative 唯一副本) | ❌（被剪） | ✅ | 单点、无结构保护 |
| 上游 27/28 撞号 | ✅ | ✅ | ✅ | OK |
| commit 纪律（署名/cherry-pick 注明） | 部分（"preserve upstream author"改写） | ❌ | ✅ | 改写非原文 |
| --no-verify 禁令 / 环境净化 SAN | ✅ | ❌ | ✅ | OK |
| 预存红 daemon-supervisor-monitor + 334874cb8 | ✅ | ✅ | ✅ | OK |

丢什么、怎么丢、可不可预测：

1. **机器块剪枝按"重复度"排序，不按重要性**：`factScore = n(提及消息数)+recency`。本次 604 条事实仅保 241、elided=363（number:88、path:176）。`DAEMON_SCHEMA_REVISION=29` 在语料中以赋值形态出现≥3 次、8 条消息提及该常量，仍被剪掉；保下来的 45 条 number 里是 `9ms/line=1667/15.55s/30s/EXIT=0`（时长/行号/退出码，来自 tool 输出与 toolCall 参数）。**丢失可预测的偏置是"高频噪声挤掉低频关键约束"**，elided 只报数量不报条目。
2. **split-turn 模板保真档次更低**：单 turn 会话（RLM 子代理全形态）走 `TURN_PREFIX_SUMMARIZATION_PROMPT`（Original Request/Early Progress/Context for Suffix 三节），**没有** Goal/Constraints & Preferences/Key Decisions/Critical Context 节——结构化检查点模板只服务多 turn 历史。约束信息只能靠改写式"Rules:"一行或机器块。
3. **role-custom 缺口（红）**：`userTexts()` 只收 `role==="user"` 和 `bashExecution`，**`custom`（agent_message＝RLM 任务简报的到达形态）不进 `<user-requests>` 逐字块**。本语料 gen1 的 `<user-requests>` 块**整体为空**。而 cut-point 逻辑又把 custom_message 当 user turn 起点（`isTurnStartEntry`）——同一条消息在两套判定里身份不一致。
4. **窗口压力下任务简报零拷贝（红，离线复核）**：`budgetSummarizationInput` 从尾保新。同一会话在 contextWindow=200k/131k/128k（inflation=1.6）下，被 summarize 的 208 条里头部分别 elide 15/60/62 条，`agent_message`（任务简报）**不在 summarizer 可见集合内**（`originalRequestVisibleToSummarizer=false`）；叠加上一条 role-custom 缺口 → turn-prefix 模板问"## Original Request"但模型根本看不见请求，机器块也不收 → **压缩后上下文对任务目标零副本**。1M 窗口（本语料 gen1）无 elision，纯摘要器压缩损失。

## ② 压缩触发语义（threshold/overflow/manual）

- 同 entry 状态下 `prepareCompaction` **完全确定性**（同输入跑两次 JSON 相等）。差异全部来自触发时刻的 entry 集与上下文窗口。
- 同一会话三种触发场景实测**不等价**：
  - **T1 早触发**（195/279 entries）：split-turn，turn-prefix 模板，140 条进摘要，1 代。
  - **gen1 晚触发**（279/279）：split-turn，208 条全量进摘要，1 代，cut 从 9d4a8d4a 移到 fef2c5cc。
  - **T1→T2 两连发**：T2 走 history+UPDATE 模板（68 条新 slice，34.8k tok，2 代，previousSummary 注入）→ 产出**唯一带完整 Constraints & Preferences/Key Decisions 节**的摘要（T2 的约束节比 gen1 的"Rules:"一行丰富一个量级：test-hygiene、fork 适配纪律、commit 约定、schema 29、SAN、fence 不变式六条）。
  - 即：**晚触发一发压缩的保真 < 早触发+二次更新**——摘要形态由触发时机路径决定，不是会话内容的函数。
- 路径差异（代码级）：threshold＝turn 后检查 `shouldCompact(contextTokens…)`+冷却窗；overflow＝`isContextOverflow` 错误消息**从 agent 态剥离但留在会话文件**（摘要仍含错误 turn）、仅一次尝试、成功后重发原请求；manual＝customInstructions 进 `<user-instructions>` 高优先级、抢占在飞 auto、abort 流。换模型后旧模型的 overflow 错误不触发（sameModel 检查）。

## ③ fact-appendix 与摘要的重复/矛盾形态

- **重复（良性）**：narrative 用短 SHA、块里存全 SHA（0894de1de vs 40 位全串，同值截断形态）；路径双份（agent-session.ts 两边都有）。`MACHINE_BLOCKS_NOTE`＋二代重入时 `stripMachineBlocks` 双闸防止叙事改写机器值。
- **矛盾（本次未出现）**：真模型 narrative 未出现 SHA 加位数/改写阈值（该形态有 F1/MVS-3 前科防护）。但**narrative-only 的关键值（schema 29）无任何结构护栏**——它被剪出 fact-appendix 后，唯一副本就是模型改写文本。
- `<user-requests>` 因 role-custom 缺口为空 → 该通道的"重复=原文+改写双份"形态在本会话形态下**不可能出现**（保护机制空转）。

## ④ 压缩后首轮的行为面

- 模型**知道发生过压缩**：`COMPACTION_SUMMARY_PREFIX`（"The conversation history before this point was compacted…"）＋两块自述头（"Authoritative: quote exactly, never restate" / "treat every unresolved instruction… as a live obligation"）。
- 但**没有任何"已知会失忆"引导**：系统提示词对 compaction 零提及（grep 0 处）；`elided` 披露只进 summarizer 请求（`elidedNote`），**不进压缩后上下文**——模型无法知道摘要本身是部分切片的产物；`KERNEL_PERSIST_SUMMARY_NOTE`（Python 变量仍在）同样只给 summarizer，压缩后模型不知 kernel 存活。
- QA 探针（压缩后上下文 vs 全量上下文同题对答，8 题×2 臂＋补测，真模型，产物 `/tmp/r34out/qa.json` + `qa2.json`）：
  - **goal_sha**（三件 SHA+映射）：AFTER ✅ 全对（narrative+机器块双通道）。
  - **report_path**（评估报告路径）：首轮 AFTER 空（模型选了"去查"而非答——emit toolCall、harness 无工具可执行）；加"无工具存在"约束后 AFTER ✅ 逐字正确。BEFORE ✅。
  - **constraint_revision**（schema 29/27/28 撞号）：AFTER ✅ 正确（29、上游 27/28、digest 复算语义都在）——但注意该值已**被剪出 fact-appendix**，答案全靠 narrative 单副本存活。
  - **awareness**（你怎么知道被压缩）：AFTER 答出 4 条依据（`<summary>` 外壳、`elided="363"` 自述、出现未亲手建立的既定状态、叙事是状态描述而非过程），并正确列出可能丢失面；**盲点**：它默认"摘要覆盖了压缩前的全部历史"——对 summarizer 输入侧 elision（≤200k 窗口场景）零感知，与代码事实一致（elided 披露只进 summarizer 请求）。
  - progress/open_issues/commit_discipline：两臂均被 toolUse 形态污染（模型模仿上下文里的 ipython 调用形态 emit 工具调用，文本空），不可判分——harness 局限，如实标注；非压缩差异（BEFORE 同样空）。

## 判据（给"压缩后模型会答错"的具体输入）

- R34-①-RED-1（已红证，离线可复跑）：单 turn RLM 会话 + contextWindow ≤200k 模型 → 压缩后问"本会话任务目标/三件 SHA 是什么"——任务简报已从 summarizer 输入 elide 且不进 user-requests，模型无源可答。复跑：`node node_modules/.bin/tsx audit-r34/verify-elision.ts`（工作树内，无 LLM）。
- R34-①-RED-2：压缩后问"DAEMON_SCHEMA_REVISION 现在是几、上游是几"（1M 窗口路径）——fact-appendix 已剪掉该值，答案取决于 narrative 改写副本是否存活；矩阵显示该值单点存活，任意一代 narrative 漂移即答错。
- 复现包：`/tmp/r34wt/audit-r34/drive.ts`（prep/compact/gen2/qa 四相）＋ `/tmp/r34out/`（全部产物）。

## 与 decisions.jsonl 去重（287 条 @07a1cd215）

压缩相关既有：R25-1（并发 manual 无互斥）、K3R-7/K3R-11（manual 抢占/指令合并）、MVS-2（compact.run 指令生效）、MVS-3（ipython_state 不在 4-tag 保护名单）、F1（机器块体含分隔符截断）、FR-5（kernel 快照 fail-open）、E4-2（totalTokens 兜底）——全部是**机制/并发/失败面**。本轮四条线（摘要保真矩阵、触发等价性、机器块剪枝偏置、压缩后失忆引导缺失）与 role-custom 缺口、head-elision 零拷贝均**无重叠**，为新增。
