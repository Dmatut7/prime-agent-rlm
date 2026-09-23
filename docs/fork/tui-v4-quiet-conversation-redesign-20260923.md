# TUI v4「安静的对话」改造施工书(2026-09-23)

> 唯一设计标准(原型):`/Users/a1/Desktop/prime-agent终端UI-定稿v4_20260923.html`(浏览器打开逐屏对照)
> 设计定稿记忆:global:prime_agent终端UI_v4定稿(十决策全在内,施工时直接引用)
> 本文档 = 任务拆解 + 时限 + 验收 + 审查方案。施工席按任务号领活,每任务 ≤30 分钟。

## 一、做成什么样子(总目标)

**对话流里只剩两样:用户的问题 + AI 的结论全文。一切过程信息(旁白/思考/工具/通讯)收进每轮一行尾注,点开或按键才见细节。**

改造前(现状病,实测截图):
- assistant 中间旁白全文摊开刷屏(「连上了…引号翻车了…」一路刷)
- 过程信息散在「思考 N 段」「⚙ N 步」各自行,无总览
- ctrl+p 语义错位(展开 agent message,用户以为是看通讯)

改造后(对照原型 HTML):
1. 对话流 = 用户消息块(灰底左框)+ AI 结论全文,中间旁白零摊开
2. 每轮尾注一行(自然语言+键位嵌提示):
   `干了 1 分 05 秒 · 14 步 [O] · 想 7 段 [T] · → 通讯 2 条 [P]`
3. 尾注点开 = 三块独立(💭思考/⚙过程/✉通讯),各自展开收起,**不互斥**
4. 过程块 >8 步自动折叠(前3+折叠行+后3,✗ 失败永保留)
5. 单步输出限高 ~11 行内滚
6. Esc 从最后开的开始收(块→尾注→turn)
7. 空态轮(纯文本)只有「想了想」
8. 进行中一行实时:`正在干活 · N 秒 · M 步 · 当前步骤名…`(就地重绘不闪屏)
9. 窄终端(≤100 列)压缩:`干了 1分05秒 · 10步 · 7想 · 2讯`
10. 底部状态栏保留(模型/用量/分支),底栏键位提示更新为 `Ctrl+T 思考 · Ctrl+O 过程 · Ctrl+P 通讯`

**向后兼容(硬约束)**:加设置项 `ui.processMode: "quiet"(默认新行为) | "legacy"(老样子全摊开)`,legacy 一键切回,保护 U6 lane 体系用户。默认 quiet。

## 二、改动代码坐标(诊断已核实,勿重查)

| 文件 | 位置 | 改什么 |
|---|---|---|
| `packages/coding-agent/src/core/settings-manager.ts` | settings 结构 + getter | 加 `ui.processMode` 开关(quiet/legacy) |
| `packages/coding-agent/src/modes/interactive/components/conversation-components.ts` | 会话重建循环 | 紧凑模式下 assistant 中间文本不再产 AgentMessageComponent 全文行,改为计入 turn 统计 |
| `packages/coding-agent/src/modes/interactive/components/turn-activity.ts` | TurnStep 旁 | 尾注总行组件:统计步数/思考段数/通讯数,渲染一行+键位提示 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | ~4778 行 onAction 区、~8714 toggleAgentMessageExpansion、~7064 全局键处理 | ctrl+o/t/p 语义重定义(三块独立 toggle);Esc 顺序收 |
| `packages/coding-agent/src/modes/interactive/components/agent-message.ts` | 组件 | 保留(收到的通讯块,已有点击展开);在通讯块渲染中复用 |
| `packages/coding-agent/src/modes/interactive/components/ipython-cell.ts` | ~655 renderSentAgentMessages | 发出的通讯消息行进入通讯块(方向色:→暖 ←冷,席名全称) |
| `packages/coding-agent/src/core/keybindings.ts` | app.messages.expand 等 | 描述文案更新;键位本身不变(ctrl+o/t/p 已是三键) |

## 三、任务拆分(每任务 ≤30 分钟,含自测)

### 批 1 · 治刷屏(核心,先交付)

- **T1(30min)兼容开关**:`ui.processMode` 进 settings schema + getProcessMode() getter + 单测(默认 quiet,legacy 回读)。
- **T2a(30min)旁白收块-渲染**:conversation-components 会话重建,quiet 模式下 assistant 中间文本不产全文行,归入 turn 统计;legacy 走原路径。单测:两种模式重建行数。
- **T2b(30min)尾注总行组件**:TurnFootNote 组件(静态统计:步数/思考段/通讯数/耗时;键位 [O][T][P] 嵌提示;按显示列宽截断,中文=2 列;窄屏压缩写法)。单测:长标题截断、窄屏形态。
- **T2c(30min)接线**:interactive-mode 把尾注组件挂进 turn 渲染链(替换现状的零散信息行),legacy 时不挂。跑 `test/skills.test.ts` 既有套件保绿。
- **T3(30min)tmux 对照实测**:改前截图 → 改后截图(旁白零摊开、尾注在位、切 legacy 回老样子),三对照落 /tmp 留尸。
- **T4(30min)收口**:lint+相关单测全绿 → 只 add 本任务文件提交(工作树有别车道脏物,禁 git add -A,只逐路径 add)。

### 批 2 · 交互完整

- **T5(30min)三键独立**:ctrl+o/t/p 在 quiet 模式下各自 toggle 思考块/过程块/通讯块(可叠加,不互斥);legacy 保持旧行为。改 onAction 区 + 全局键处理。
- **T6(30min)块详情**:三块各自展开渲染(思考段列表/工具步骤列表/通讯列表),复用现有组件;过程块 >8 步折叠(前3+折叠+后3,✗ 永保留,点折叠行展开)。
- **T7(30min)单步输出限高**:+详情块内单步 Enter 展开限高 ~11 行内滚(渲染预算复用 expandFull 机制)。
- **T8(30min)Esc 顺序收**:记录展开序(块→尾注→turn 逐层),Esc 从最后开的开始收。
- **T9(30min)tmux 批 2 实测 + 收口提交**:三键叠加开、折叠、限高、Esc 逐收,截屏对照;测试全绿提交。

### 批 3 · 打磨

- **T10(30min)进行中实时行**:turn 运行中尾注 = `正在干活 · N 秒 · M 步 · 当前步骤名…`(就地重绘那一行,不闪屏;复用 stall 动作条的重绘机制)。
- **T11(30min)窄屏压缩**:尾注在 ≤100 列时切压缩写法(1m05s·10步·7想·2讯),按显示列宽算,不做字符数截断。
- **T12(30min)鼠标路径**:尾注三段可点直达对应块(ClickRegion),块头/单步可点(复用 agent-message.ts 现有点击模式)。
- **T13(30min)文档收口**:CHANGELOG fragment + FORK_NOTES 一节 + 底栏键位提示文案更新,全绿提交。

## 四、验收标准(按批,机械可查)

**批 1**:
- [ ] tmux 实测:一条「先说再做」消息,旧版旁白 ≥3 行摊开 → 新版 0 行摊开
- [ ] 尾注行出现且统计正确(步数=工具调用数、思考段数、通讯条数)
- [ ] `ui.processMode: "legacy"` 切回后屏幕回到老样子(逐屏一致)
- [ ] 既有测试套件全绿(skills.test.ts / ipython-bootstrap.test.ts / settings-manager.test.ts)

**批 2**:
- [ ] ctrl+o 与 ctrl+t 同时开(叠加),互不关对方
- [ ] 14 步 turn 显示为 3+折叠+3,点折叠行展开全部
- [ ] 单步 Enter 展开后高度 ≤ ~11 行,内部滚动
- [ ] Esc 第一次收回最后开的块,第二次收尾注,第三次收 turn

**批 3**:
- [ ] 进行中尾注每秒就地刷新(相邻帧 diff 仅那一行)
- [ ] 80 列终端下尾注为压缩写法且不折行
- [ ] 鼠标点尾注「通讯」段直达通讯块
- [ ] 重绘无闪屏(截屏连续两帧,非刷新区逐行一致)

**性能红线**:尾注行刷新 O(该行) 不 O(整屏);10 轮 turn 的会话重建耗时不高于现状 ±15%(tmux 下 time 对照)。

## 五、审查方案(施工后,快模型,不上 0902/K3)

- **审查席配置**:2 席并行,`bailian/deepseek-v4.1-flash`(thinking high)+ `bailian/glm-5.3-prime`(thinking high)。**禁用 0902/K3(慢,本轮不上场)。**
- **审查维度(每席必查四项,对照原型 HTML 逐屏)**:
  1. **原型一致性**:做出来的每屏形态与 `定稿v4.html` 是否搭(尾注文案/三块独立/折叠形态/空态/进行中行/底部)
  2. **交互完整**:键盘路径全通(O/T/P 叠加、↑↓、Enter、Esc 顺序收、N);鼠标段可点
  3. **验收标准**:第四节清单逐项机械核(不采信施工席自报)
  4. **性能与显示**:重绘范围、截断正确性(中文=2 列)、窄屏形态、无闪屏
- **审查产出**:发现清单(文件+行号+与原型差异截图),交母席合流;必修项走 fix-forward 小补丁,不整笔回滚。

## 六、纪律(施工席必读)

- 工作树有别车道在飞脏物(packages/agent/CHANGELOG.md 残改、audit_lane6/ 等):**只 add 自己的文件,逐路径点名,禁 git add -A**
- 每任务完成立即落盘提交;卡住 30 分钟写死因到 /tmp/tui_v4_stall.md 并回报
- 提交信息:`feat(coding-agent): tui-v4 quiet conversation (batch N/task Txx)`
- 测试跑法:`cd packages/coding-agent && env -u RLM_DEPTH -u RLM_SESSION_DIR npx tsx ../../node_modules/vitest/dist/cli.js --run test/<file>`
- tmux 实测法:参考 global 记忆 ctrlp 诊断图的 tmux 流程(new-session → send-keys → capture-pane 前后对照)

---

# 修订版 v2(2026-09-23 · 合流两审查席 39+16 条发现、主链席锚点核实、9+8 条母席拍板)

> 本节为权威修订,**与上文冲突处以本节为准**。基线 HEAD 30b9c0f9d(T2b 已入库)。

## R1. 批 1 施工方案修正(P0)

**T2a(旁白收块)修法改为「组件闸门」,不再改 renderSessionContext 循环:**
- 闸门位置:`components/assistant-message.ts:269`(AssistantMessageComponent 文本渲染点)
- 判据:`getProcessMode()==="quiet" && 该 assistant 消息 hasToolCalls` → 中间消息(旁白),渲染为归入 turn 统计的紧凑形态(批 1:一行摘要甚至 0 行);不带 toolCall 的 assistant 消息 = turn 最终输出,**永远全文**
- 优点:一处改动同时覆盖 live 流(startAssistantStreamingMessage:6533)、replay(renderSessionContext:7506→addMessageToChat:7447)、test 构建(buildConversationComponents)三条路径
- conversation-components.ts 的 buildConversationComponents 仅为 test-only,不作为 T2a 主战场

**T2c(尾注挂接)降级为「turn 头一行化」:**
- 原型尾注在结论后,但 TurnSummaryComponent 是 turn 分隔符,"摘要在前"假定遍布 83 处引用 + 测试钉死(turn-activity-summary.test.ts),移尾 = 结构性重构,批 1 不做
- 批 1 落地形态:**现状 turn 头两行(「思考 N 段」+「⚙ N 步…」)合并为一行尾注**(TurnFootNote 组件,位置在 turn 头);移尾作为批 3 之后的独立评估任务
- 同步更新:turn-activity-summary.test.ts(两行断言改一行)

**T1(settings 开关)范围补全:**
- settings-manager.ts:UiSettings(:826)+ Settings.ui(:788)+ **KNOWN_SETTINGS_KEYS.ui 行(:1055 加 "processMode")**+ getter(模式参考 getFooterTelemetry:2280)+ **设置面板行(:9016)**
- 验收含 settings-unknown-keys.test.ts 绿

## R2. 裁决记录(与上文的差异以本节为准)

1. **窄屏阈值:<100 触发压缩**(100 列整 = 完整形态,与原型 100ch 一致);验收加 99/100/101 三档边界。组件席 turn-footnote.ts 的 `<=100` 判断改为 `<100`(含测试断言)
2. **键位字符串禁硬编码**:turn-footnote.ts 的 [O][T][P] 写死字符串违反仓规,改为从 keybindings 取 keyText(同 app.* 键的显示名)
3. **Esc 三级,且仅「编辑器空 && 无在跑工作」时收 UI 层**(Esc 现有语义=input.clear/双击 tree/打断在跑轮,不得冲突);legacy 走旧行为
4. **单步展开不做「内滚」**(pi-tui 无原语):用现成语义=有界窗口+「还有 N 行」(tool-output-budget.ts);上限钉死 ≤12 行;alt+shift+o 解除预算沿用
5. **键位提示唯一归属 = 聊天尾 ExpandKeysHintLine**(expand-keys-hint.ts 进 §二 坐标表):文案「消息」→「通讯」,同步改 interactive-footer-status-layout.test.ts:262/269;尾注内嵌 [O][T][P] 保留(两者不冲突:一个就地嵌,一个全局行);§一.10 补回「档位」
6. **N 键不进真实键位**(原型演示专用);真实窄屏=自动按终端宽度。↑↓/Enter 选择模式是聊天视图新功能,批 2/3 评估成本后再立任务,批 1 不做
7. **turn 边界口径**:批 1 尾注统计按重建语义(user 消息切轮);通讯数 = 轮内 received agent_message 行 + sent(ipython tool details :379 的 SentAgentMessageDisplay)计数,步数按 toolCallId 去重;批 2 建 TurnActivityState 正式计数器
8. **验收可测性修正**:「重建耗时±15%」废弃(不可测);「旁白 0 行」用预置回放会话判定;「重绘 O(该行)」用 render-cache 身份断言;「legacy 逐屏一致」改为与改前基线截图对比(/tmp/tui_v4_before_03_replay.png 已留)
9. **审查分工修正**:形态/截图比对归 DS-flash(截图落盘+attach);glm-5.3-prime 只审代码/机械项(无视觉,硬约束)
10. **文件所有权**:批 1 剩余全部改动归主链席(interactive-mode.ts、assistant-message.ts、turn-activity.ts、settings-manager.ts、expand-keys-hint.ts、相关测试);组件席只拥 turn-footnote.ts(含本节 R2.1/R2.2 两处修正);批 2 文件所有权表开工前另发

## R3. 批 1 任务序列(v2,主链席执行)

- T1(30min)settings 开关(R1 范围,含面板行)→ 测试绿
- T2a'(30min)AssistantMessageComponent quiet 闸门(中间消息收块;最终输出不动)→ 既有测试 + 新增单测(中间/最终两种消息的渲染行数)
- T2c'(45min)turn 头两行 → 一行 TurnFootNote(统计:步数按 toolCallId 去重/思考段/通讯数/耗时=轮首末 timestamp 差);更新 turn-activity-summary.test.ts
- T3(30min)tmux 对照:复用 tui-v4-before 会话 + 测试会话 01a0cd66(--resume),改后 replay 面旁白 0 摊开 + 尾注一行在 turn 头 + legacy 切回基线一致
- T4(30min)npm run check 全绿 + 纯净树 tsgo + 逐路径 add 提交(含 hook 整文件 re-add 注意:只 re-add 自己 staged 的)

## R4. 验收清单 v2(批 1)

- [ ] tmux:改后 replay 面(prepare 的 before_03 同场景)旁白 0 行摊开
- [ ] turn 头一行尾注,统计与预置回放会话机械对账(步数=去重 toolCallId 数/思考段/通讯数)
- [ ] ui.processMode:"legacy" → 与 before_03 基线逐屏一致
- [ ] settings-unknown-keys / turn-activity-summary / turn-footnote / interactive-footer-status-layout 全绿,零新增红(vitest list --json 收集数对账)
- [ ] 99/100/101 列三档边界(组件席单测)
- [ ] npm run check + 纯净树 tsgo EXIT=0

---

# 修订节 R5 · 批1闭环拍板(2026-09-23 视觉审查收卷后)

批 1 六笔提交(至 c9e1e30da)闭环:R4 六项亲验 PASS、代码审查 2 P1 已修、视觉审查无 P0/P1。
P2 三条拍板:
- P2① 活轮旁白先流式摊开、toolCall 落地才收回 → **批 3 T10 收口**(进行中一行实时),批 1 已知限制(与 R2 验收口径一致)。
- P2② 通讯计数 live/replay 两路口径 → **批 2 建 TurnActivityState 正式计数器时统一**,验收补真通讯场景实拍(live 派子代理发收消息,replay 对账同数)。
- P2③ 全零轮(纯文本无思考无工具)尾注整行消失与「想了想」并存 → **拍板:全零轮也显示「想了想」**(视觉统一;模型总在推理,无显式思考块也算"想了想")。批 2 首刀。
P3 四条(注释矛盾/caret 未接/缩进 1 格/accent 色差)→ 批 2/3 打磨顺手收,不单开任务。
