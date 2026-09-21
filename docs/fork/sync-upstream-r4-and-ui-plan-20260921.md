# 2026-09-21 官方拉取（R4 择取）＋ UI 改进 计划

> 母席：glm-5.3-prime 主席。本计划为老板 2026-09-21 委托的施工前计划文档（「写清楚怎么搞、准备怎么搞、为什么、在哪里动刀子」），待老板点头后按分工派席执行。

## 0. 背景与总目标

- 上游 `PrimeIntellect-ai/prime-agent` 新增 **43 笔未取提交**（09-17 一批、09-19 两笔、**09-21 今天 18 笔**，官方在推一个稳定性/性能大动作 RSI 系列）。
- 本 fork 相对 merge-base `e2fb7bfa` 已改 **2058 个文件（其中 src 级 1881 个）**——所以「吸收」不是 merge，是**逐笔手术式择取**（cherry-pick＋手工对账），与既有 R1-R3 择取流程同构。
- 同时欠一次 **daemon 重启**：GLM 坏调用修复（commit `cc4a17379`，tool_stream 显式覆盖）已 build 未激活。
- **总目标：一次择取战役把「官方 43 笔吸收＋UI 三件自研＋GLM 修复激活」全部落地，最终只用一次重启窗。**

## 1. 为什么值得吸收（价值面，逐类）

| 价值类 | 上游提交 | 对我们的意义 |
|---|---|---|
| 上下文瘦身 | `a8ae6269a` harness digest 只留最新一份 | 咱们每会话重复堆 harness 状态块；大会话（40 万 token 级）实打实省钱，且离 GLM 风暴区（≳39 万）更远 |
| 压缩质量 | `27f32ddb7`（摘要锚定 kept-tail）、`5fb3d9acb`（工具身份入摘要输入） | 大会话压缩后不丢关键工具上下文 |
| 限流韧性 | `2883a7843` 配额被限的会话自动停泊、到点复活 | 百炼限流时会话不再死等人救 |
| 图眼补洞 | `3b1aa5ff3` 图片轮次自动路由到配置的视觉模型 | 正好补 GLM 家族无视觉：配一个视觉模型当图眼 |
| 重启体验 | `2e9ab77b8` daemon 重启后已开窗口自动重连、`54da82e97` 会话打开可等过更新重启 | 咱们重启窗仪式的直接减负 |
| 吞吐可视 | `eee9d814b` /speed 底栏 tok/s | 老板盯吞吐，直接给数 |
| 稳定性 | `c91e6e991` REPL 协议帧上限、`b6b94c78a`/`b6d955a9b`/`66df06fc1` kernel 管道与日志、`41e4e0e18` refinement 写校验、`126fe7010` spawn 名预留、`3dfb0276b` heartbeats_list 即答 | 全是咱们重度踩过的面（多席、长会话、心跳） |
| 性能 | `0498deb43` branch 数组缓存、`0597614e0` 工具结果计数走头、`c37f5eb39`/`e1f4ae5bd` 目录惰性、`756a8ce83` 帧解码线性化、`8218d6bcc`/`fc9f2ae24` kernel 启动 | 与本 fork 自有延迟修复同路，择取时逐笔判「仍缺补、已有则跳」 |
| 其他 | `1272a3d6e` 技能导入失败告知模型、`690e23d8c` 请求级耗时诊断、`f2a9ad661` 聊天默认中等详情、`b6fb29850` 全屏触摸/可点链接、`1ae25148b` pre-push 防镜像推、`c13e03113` 行为评估 CI | 各自小价值，随批次走 |

**建议不取/缓取**：`b09e37d84`（ACP 选择器——咱们不用 ACP 模式）、`63d88319b`（Prime Inference GLM 的 enable_thinking——咱们 GLM 走百炼不走 PI；且它动 `packages/ai/test/openai-completions-tool-choice.test.ts`，与本 fork 当日 `cc4a17379` 同文件，取则需手工对账）、`976ea1084`（沙箱脚本，价值低）。其余 40 笔全取。

## 2. 在哪里动刀子（43 笔逐笔冲突盘点）

择取风险＝该提交动刀文件与本 fork 已改 1881 个 src 文件的交集。已程序化算完（方法：`git merge-base` fork 改动面 × `git show --name-only` 逐笔交集）：

- **A 批（零冲突，直接取）1 笔**：`c13e03113` 评估 CI。
- **B 批（轻冲突 1-2 文件，cherry-pick＋手工对账）14 笔**：`0597614e0`、`b3e04b58b`、`e683fcb53`、`d2cdb4504`、`976ea1084`、`ff40ea24e`、`d96a990b4`、`b6b94c78a`、`66df06fc1`、`1ae25148b`、`1437e4bcc`、`b6d955a9b`、`7572880fe`、`1df880d81`。
- **C 批（深冲突，逐文件手术）28 笔**，按子系统分车道（见 §3 分工）。

**热点文件（多笔共抢，必须单写者串行）**：

| 热点文件 | 抢它的提交数 | 串行要求 |
|---|---|---|
| `core/agent-session.ts` | 9 笔 | 全战役只允许一个「会话核心席」按序持有 |
| `interactive-mode.ts` | 6 笔（含 UI 自研） | TUI 席独占，UI 自研与 `f2a9ad661`/`eee9d814b`/`b6fb29850` 串行 |
| `session-manager.ts` | 5 笔 | 与 agent-session 席合并为同一车道 |
| `daemon-supervisor.ts` | 5 笔 | daemon 车道独占 |
| `settings-manager.ts` | 3 笔 | 并入会话核心席 |
| `kernel/repl-manager.ts`、`runtime/src/rlm/*.py` | 各 3-4 笔 | kernel 车道独占 |

## 3. 怎么搞：三波战役＋一次重启窗

### Wave 1（先行，低风险高价值）：B 批 14 笔 ＋ A 批 1 笔 ＋ UI 自研 U1/U2
- 席位：`lane-b`（B/A 批择取）、`lane-tui`（U1/U2/U4 自研＋/speed 取上游，四件同车道串行：U4→U1→U2→/speed）、`lane-audit`（对账与测试看护）。
- 动刀位置见 §2/§4。收口：`npm run check`＋定向测试＋净树 tsgo＋build。

### Wave 2（核心子系统，深冲突主体）
- `lane-kernel`：REPL/runtime 车道（`c91e6e991`、`8218d6bcc`、`66df06fc1`、`d96a990b4`、`b6b94c78a`、`b6d955a9b`、`1272a3d6e`、`41e4e0e18`、`7f39eb825`、`756a8ce83`）。
- `lane-core`（**串行热点席**）：agent-session/session-manager/settings 系（`a8ae6269a`、`0498deb43`、`0597614e0`、`27f32ddb7`、`5fb3d9acb`、`6d2c57d72`、`2883a7843`、`b08f08efa`、`b3e04b58b`、`126fe7010`、`690e23d8c`）。
- 两车道文件面不相交，可并行；`agent-session.ts` 全程只在 lane-core。

### Wave 3（daemon 与 TUI 大件）
- `lane-daemon`：`2e9ab77b8`、`54da82e97`、`3dfb0276b`、`e311d6495`、`e1f4ae5bd`、`c37f5eb39`、`126fe7010`(daemon 面)。
- `lane-tui2`：`b6fb29850`（31 文件，全战役最大单笔风险，放最后）、`f2a9ad661`、`3b1aa5ff3`（图路由）、U3 agents-view 扩展。

### 重启窗（唯一一次）
- 前置：全部波次收口＋异构终审绿＋回滚把手就位（每笔择取独立 commit 可单笔 revert；重启前打 tag `pre-r4-sync`；models.json 单点可回滚）。
- 执行：`prime-agent shutdown` → 重开 → 自证：uptime 归零、健康检查、抽一场真聊天、**GLM 修复激活验证**（日志确认请求带 `tool_stream:false` 且无 Tool not found 风暴）、`/speed` 与底栏水位可见。

## 4. UI 自研三件（怎么搞、为什么、动刀位置）

### U1 底栏常驻水位条（最优先）
- **为什么**：底栏现状默认全空（token/成本/模型名/上下文% 全藏，`/usage` 才临时开——`components/footer.ts:41-42` 原注释）。老板天天把会话推到 40 万 token，GLM 风暴区就在 ≳39 万，压缩触发线在窗口×0.8——这些数字界面上一概看不见。
- **怎么搞**：底栏常驻一行：`模型名 · ctx 312k/1M(38%) ▍压缩线80% · ⚠工具错误×N(连续≥3才显)`。上下文口径＝usage（input+cacheRead）/contextWindow；GLM 风暴区（39 万）以刻度标记。
- **动刀**：`modes/interactive/components/footer.ts`（主）、`core/slash-commands.ts`（/usage 语义保留为「全量遥测」）、`core/settings-manager.ts`（新设置 `footer.telemetry: "off"|"compact"|"full"`，默认 compact）、`components/top-bar.ts`（模型名并入）。测试：`test/interactive-mode-command-usage.test.ts` 扩展。

### U2 工具错误可见性
- **为什么**：GLM 风暴那次老板盯了 11 分钟不知道发生了什么；「在干活」vs「在空转」需要一眼分辨。
- **怎么搞**：会话层维护连续工具错误计数（toolResult 为错误类文本即 +1，成功归零），≥3 时底栏警示并与 U1 同行显示；数据源与 U1 共用 footer 状态。
- **动刀**：`core/agent-session.ts`（错误流水分桶——**热点文件，排 lane-core 串行**）＋ `components/footer.ts`。与上游 `/speed`（`eee9d814b`）合并在同一底栏改造里做。

### U4 会话可读性改造：默认视图降噪（老板 2026-09-21 亲贴病灶，优先级与 U1 并列）
- **为什么**：老板亲贴现网渲染——一屏 7 行里 5 行是机件（「Thinking... (Ctrl+T to expand)」逐块插行、`✓ bash · git diff --name-only $MB HEAD | head -60 · ↑ 3 ↓ 62 lines · 378ms` 原始命令/行数/耗糊脸、英文机件词混中文、按键提示逐块重复）。对话主线被机械噪音淹没。
- **怎么搞（四刀）**：
  1. **轮内机械聚合**：同一轮的 thinking＋tool 序列默认聚成一行「⚙ 本轮 N 步 · 总耗时 —— 动词优先摘要（git×2 · python×3 · 最后动作）」，Ctrl+O 展开今天的逐行明细；复用/对齐上游 detail-level 机制（#2447/#2193 细节档），默认档调低。
  2. **工具行语义化**：默认显示语义摘要（「写文件 docs/fork/…」「git 提交 812876c7b」），原始命令与 ↑↓ 行数进展开态；时长右对齐置灰。
  3. **thinking 一行化**：默认「▍思考 N 段（Ctrl+T 展开）」一行摘要，不逐块占行。
  4. **机件词中文化＋提示去重**：思考/命令/行/毫秒全部中文；Ctrl+T/O 提示只进底栏图例一次，不逐块重复。
- **动刀**：`components/conversation-components.ts`（聚合渲染主战场）、`components/assistant-message.ts`（thinking 行）、`components/bash-execution.ts`、`components/ipython-cell.ts`、`components/tool-execution.ts`、`components/feature-hints.ts`（提示去重）。测试：新增假 provider 快照测试（渲染一轮含 3 思考段＋5 工具步的消息，断言聚合行与展开态），挂 `test/interactive-mode-command-usage.test.ts` 同目录。
- **工作量**：中等（单席一天内），归 lane-tui；与 U1/U2 不同文件、同车道串行。
- **验证法**：改前后各截同一会话渲染（tmux capture-pane 文本比对），行数下降＋主线文字占比上升为硬指标。

### U3 agents-view 扩展：子席活状态面板
- **为什么**：老板打法＝母席带一堆子席；现有 agents-view 是会话浏览器（open/kill/name），没有「跑着/交卷/卡死/耗时/最后一拍」的活状态。有了它老板不用问「还没查完吗」。
- **怎么搞**：先取上游 `2e9ab77b8`（含 agents-view 改造），再在其上扩面板列：status、settled、terminal_kind、duration、answer 预览一行。
- **动刀**：`modes/agents-view/agents-view-mode.ts`（主）＋ daemon 侧 roster 字段透出（并 lane-daemon，避免双写）。

## 5. 分工与模型（老板 2026-09-21 令）

- **施工席全部 `bailian/glm-5.3-prime` ＋ thinking=max**（老板指定；该模编码/审查强、当日 73/73 干净实证）。
- **单写者纪律**：§2 热点文件每时刻只一席持有；`agent-session.ts` 全战役仅 lane-core；`footer.ts` 仅 lane-tui；跨车道文件冲突由母席裁分工并登记。
- **异构终审不破**（既有纪律＋老板确认的边界）：每波收口由 0902/K3 复核 diff，高风险面（kernel 协议、daemon）终判 0902×K3 交叉；glm-5.3-prime 施工＋日常审查，不做高风险终判。
- 席位规模：Wave1 三席、Wave2 两席、Wave3 两席（并行文件面不相交才并）。
- 心跳与反停顿：每席后台 handle＋每步落盘＋卡两轮换法（既有纪律写死在派活提示里）。

## 6. 验收与回滚

- 每波：`npm run check` EXIT 0（全输出）、定向测试全绿、`git archive HEAD` 净树 tsgo 绿、build 绿、changelog fragment 齐全。
- 终验收（重启窗后）：uptime 归零、健康检查、真聊天冒烟、GLM `tool_stream:false` 落请求日志、无坏调用风暴、/speed 与水位条可见。
- 回滚把手：每笔择取独立 commit（单笔 revert）；tag `pre-r4-sync` 整体回退点；U1/U2 设置项 `footer.telemetry=off` 即关；GLM 修复回滚＝models.json 删 `toolStream` 键。
- FORK_NOTES.md 在最终 push 前按仓规更新。

## 7. 风险登记

1. **最大单笔风险**：`b6fb29850`（31 文件 TUI 触摸/链接）——放 Wave3 末，独立 commit，可整笔弃。
2. **同文件当日冲突**：`63d88319b` 与本日 `cc4a17379` 同测试文件——已列缓取。
3. **性能重复投资**：roster/目录类 perf 笔（`e311d6495` 等）与 fork 自有修复同路——择取时逐笔判「补缺 or 跳过」，判据＝先量后取（对比 fork 现基线）。
4. **热点文件串行**是本战役关键路径，席多了也不会快——瓶颈在 agent-session.ts 的 9 笔序贯择取，接受它。
