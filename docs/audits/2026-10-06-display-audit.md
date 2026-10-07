# 显示 Bug 审查报告 — 2026-10-06（第一轮）

方法：13 路并行只读审查（蜂群），覆盖 `packages/tui/src` 与 `packages/coding-agent/src/modes/interactive` 的显示链路。所有 High/Medium 条目均有代码证据，关键疑点用 tsx 探针实跑复现。原始完整报告：`session tool-results/AgentSwarm-….txt`（659 行）。

去重说明：`fullRender 无超宽钳制`（两路独立发现）、`编辑器底部指示行不截断`（两路）、`tab 坐标系不一致`（两路）、`tree-selector 高度问题`（两路）已合并。

---

## 一、用户截图实锤的 3 个 bug

### S1. 子代理状态三处打架（High）
**现象**：时间线框头「在等子代理 X 交回结果」+ 框尾「X 还在干活」，底部 chip 条却显示「空闲」，排队区显示结果已回传。四处状态互相矛盾。
**根因**（两条独立缺陷叠加）：
- `turn-timeline.ts:511-519`：attach/replay/resync 重建时间线时，子代理条目由 `noteSpawns` 创建且**硬编码 `status: "running"`**；权威快照（`snapshot.children`）只喂给 chip 条（`interactive-mode.ts:7660-7680`），从不调用 `turnFlow.subagentUpdate`。`subagentUpdate` 兜底只接受 running/queued（`live-turn-flow.ts:702-705`），终态更新在无条目时被丢弃。
- `turn-timeline.ts:677-708`：`upsertSubagent` 把条目翻成 done/failed 时**不关 lane**；lane 唯一关闭点是报告行渲染进聊天（`timeline-lane.ts:130-136` 的 `comeBack`）。报告排队期间（父代理忙时报告走队列，`rlm-runtime.ts:552-560`）lane 长期挂着「还在干活」。
**修法**（两个入口都做）：
1. `subagentUpdate` 把条目翻成非 running 时同步 `tracker.reported(lane)` 关闭 lane。
2. `seedSubagentSummary`/`replaceSubagentSummary` 及 replay 完成后，用 `snapshot.children` 对账全部时间线条目与 lane。
**自愈现状**：排队报告投递或子代理闲置 20 分钟被关闭（`rlm-child-retention.ts:227-238`）前长期矛盾。

### S2. agents-view 表格错位 / 右列被切（Medium，三机制叠加）
- **三分区不共用列宽**：`agents-view-mode.ts:3633-3643` 列宽在 per-section 循环内计算，中间各列跨分区漂移多达 8 列；同函数 3604 行注释「One column set for every section」与实现矛盾。**修法**：把 `widths` 计算提到循环外，全局共享列宽。
- **窄宽度降级不一致 + 硬切无省略号**：`agents-view-mode.ts:3276-3279` 表头 `gap<2` 时整体丢弃；`:3266` 行截断省略号参数为 `""`（硬切），details 块（~50-63 列）从不收缩，先把标题宽度压到 0 再从右端硬切——「更新」列最先消失，且切断处可以是半个数字。**修法**：截断带 `…`；details 块按优先级隐藏低优先列而不是整体硬切。
- **ambiguous-wide 终端全面错位（条件触发）**：表头/数据行密集使用 `· ↑ ↓ … ● ♥ ◇◈◆`（全是 EAW-Ambiguous），`visibleWidth` 算 1 列，开了「ambiguous 双宽」的终端（iTerm2/WezTerm/部分 zh locale）渲染成 2 列，全 TUI 无任何探测。**修法**：probe 阶段探测歧义宽字符宽度（参考 cell-size 探测），或在设置里提供开关统一按 2 列计。
- 附：`agents-view-mode.ts:3246` summary 预算 off-by-one（`- 2` 应为 `- 3`，` · ` 是 3 列）；`agents-view-state.ts:1471-1474` 「…」同形双义（在跑 vs 被截断）建议换字形；`agents-view-mode.ts:3703-3707` live 会话「更新」列实际显示创建年龄，与「时长」列冗余。

### S3. placeholder 中间出现光标块 — 当前 HEAD 不可复现
端到端复现（VirtualTerminal + fullscreen dock，焦点开/关、流式多帧、dock 高度变化）所有状态下光标都正确落在提示符后。**最可能解释：那是拖选反色高亮在布局移动瞬间落在 placeholder 上**（`fullscreen.ts:730-739` 的 `\x1b[7m`，松开即清），不是真光标。若稳定复现需补充触发条件。

---

## 二、High

### H1. fullRender 路径没有超宽行钳制，画面持续错乱且静默
**位置**：`packages/tui/src/tui.ts:2292-2296`（preserveViewport 重绘）、`tui.ts:2338-2341`（常规 full render）。
**根因**：diff 路径有 clamp（`tui.ts:2551-2560`，`ac1dc18ed` 引入），fullscreen paint 有（`fullscreen.ts:1117`），fullRender 两个循环从未有过防护——「约定改了但消费路径没跟上」。
**触发**：组件产出超宽行 + 当帧是 fullRender（首帧、resize、attach 流式会话的回退重绘 `tui.ts:2505-2510`、工具展开折叠）。
**现象**：超宽行物理换行 → 物理行与 `previousLines` 记账脱节 → 后续 diff 写到错误行、旧行残留，画面错乱直到下次 full redraw；且**不写 pi-crash.log**（`logClampedOverwideLines` 只在 diff 路径调用），静默复发。
**修法**：fullRender 两个写行循环复用 diff 路径的 clamp + 日志逻辑（抽公共函数）。

### H2. markdown 嵌套列表检测正则硬编码 `\x1b[36m`，fork 主题下全部嵌套列表错位
**位置**：`packages/tui/src/components/markdown.ts:2436, 2446`。
**根因**：靠「行首空格 + cyan 开码 + `-`/数字」识别嵌套列表行；fork 生产主题走 `theme.fg()` 只输出 `38;5;Nm`/`38;2;r;g;bm`，永远不产生 `36m`。测试用 `chalk.cyan`（test-themes.ts:24）+ 子串断言，恰好掩盖。
**现象**：`- parent\n  - child` 子行渲染 4 空格（应 2），每层 +2；无文字父项出双 bullet（`-   - child a`）。反向误命中：列表项内高亮代码块某行以 cyan `-` 开头会被误判。
**修法**：不要用颜色码做结构检测——渲染列表时在内部数据结构上标记嵌套层级，或 strip ANSI 后按行首空白 + bullet 字符判断。

### H3. 列表项内的 GFM 表格被静默丢弃（内容丢失）
**位置**：`markdown.ts:2466-2502`（`renderListItem`）。
**根因**：只处理 list/text/paragraph/code/blockMath，其余落 else → `renderInlineTokens` → default 要求 `token.text` 为 string；table token 无 `text` 字段，整个表格一行不输出。
**修法**：else 分支补 table/blockquote/heading 的渲染（调 `renderTable` 等并叠加列表缩进）。

---

## 三、Medium（14 条）

### M1. 超宽钳制丢行尾 SEGMENT_RESET，样式/超链接泄漏进下一行
`tui.ts:2557`、`fullscreen.ts:1117`、`tui.ts:2044` 三处 `sliceByColumn(line, 0, width, true)`。`sliceWithWidth`（`utils.ts:1402`）只收录 `currentCol < endCol` 的 ANSI 码，行尾 `\x1b[0m\x1b]8;;\x07` 落在截断点外被丢弃。现象：下一行被泄漏的 bg 涂色 / 整行变成可点链接。**修法**：钳制后统一补 `SEGMENT_RESET`（或在 `sliceWithWidth` 末尾追加行尾闭合码）。

### M2. 含字面 tab 的行，拖选高亮与复制文本偏 2 列/tab
`sliceWithWidth`（`utils.ts:1411-1424`）tab=0 列 vs `visibleWidth`（`utils.ts:240-242`）tab=3 列；上屏前 `applyLineResets` 把 tab 展开成 3 空格，但选择/复制作用在未归一的 transcript 行上（`fullscreen.ts:730-739, 988-990, 1060`）。触发源：`CollapsibleErrorComponent` 不展开 tab（`collapsible-error.ts:19-21`）、扩展自定义组件。对照：`urlAtColumn` 已做过同样补偿（`utils.ts:1470-1472` 有注释），选择路径没跟上。**修法**：选择路径改为操作归一化后的帧行，或选择前对行做同样的 tab 展开并建立列映射。

### M3. meta-sends-escape 终端按 Option+方向键 = 打断响应 + 清草稿
`stdin-buffer.ts:250-256` 无条件把 `\x1b\x1b[A` 拆成 `["\x1b", "\x1b[A"]`（有测试钉死），`keys.ts:824-833, 1303-1306` 的 meta 前缀分支成生产死代码，但 `keys.test.ts:635-638` 仍钉着 `ctrl+alt+up` 支持。后果：xterm `metaSendsEscape`、macOS Terminal.app 开启 Option as Meta 时，Option+方向键先发 Escape（绑定「打断响应/清空草稿」）再发方向键。**修法**：二选一——keys.ts 删死分支并改测试，或 StdinBuffer 对 `\x1b\x1b[1;*X` 形态输出合并序列。至少消除「测试声称支持」的假象。

### M4. 浮层不合成 kitty 占位图片行，对话框被图片条纹打穿
`tui.ts:1996` `compositeLineAt` 开头 `if (isImageLine(baseLine)) return baseLine;`。占位行是纯文本格子（terminal-image.ts:373-375 注释明说为可裁剪设计），却被和内联 APC 行一起跳过合成。且点击覆盖照常被扣（`tui.ts:1766-1768`）——用户看到图片、点击落在对话框上。**修法**：`isImageLine` 拆分两类，仅内联 APC 序列行跳过合成，占位行走正常合成。

### M5. OAuth 手动粘贴失败后登录浮层输入框重复渲染成两个
`login-dialog.ts:194, 223`：`showManualInput()`/`showPrompt()` 都无条件 `contentContainer.addChild(this.input)`，`Container.addChild` 只是 push。Anthropic/Codex OAuth 粘贴解析失败 → `onPrompt` 兜底 → 同一 Input 实例被加两次，渲染出两行相同输入框。**修法**：addChild 前 `contentContainer.clear()` 或检查已包含。

### M6. /fork 消息选择器选中行滚出可视区；/tree 标题被裁、resize 后错乱
- `user-message-selector.ts:16, 35-59`：`maxVisible=10` 写死，每条 3 行 + chrome ≈ 39 行，不做终端高度适配；全屏 dock 上限 `rows-3` 且保底部裁顶部（`fullscreen.ts:24-27, 191-193`）→ 24 行终端向上选中项消失。**修法**：`maxVisible` 按 `terminal.rows` 动态计算。
- `tree-selector.ts:1298`：`maxVisibleLines = max(5, terminalHeight/2)` 按整终端高度预算，无视 dock 其他成员（trayInfo+editor+lift+footer）；且高度在打开时快照固化（`interactive-mode.ts:12994`），resize 后错乱。同仓其他浮层都用 live getter。**修法**：改 `getRows: () => this.ui.terminal.rows` 并减去 dock 成员行数。

### M7. 对账门不认识 `origin: "ambient"`，显示口径与对账口径分裂
`scripts/check-display-reconciliation.mjs:266-285` 不读 `origin` 字段，`:415, :461` 把 ambient 记录算进「显示」headline 与合计；显示层 turn-strip/timeline-rows 明确把 ambient 拆出。后果：门打印的「显示」比屏幕大，且本会话少报可被 ambient 抬高掩盖。**修法**：对账脚本剔除 ambient（git 侧对应豁免）或显式声明口径；补 ambient 种红自检用例。

### M8. legacy 模式展开 ipython 输出无渲染预算，一次按键卡 UI 数秒
`ipython-cell.ts:807-838`：裁剪条件 `quietConversationBudget() && ...`，legacy 恒 false → 全量渲染（单流上限 65536 字符，合计可十几万字符 = 几千视觉行）。`expandedOutputWindow`（`tool-output-budget.ts:139`）只被 bash.ts:885 消费。**修法**：ipython 两条路径都接 `expandedOutputWindow`。

### M9. 探针 render 消耗 turn 头一次性 reveal marker，「滚到 turn 头」静默失效
`live-turn-flow.ts:275`、`conversation-components.ts:717`：`child.render(80)` 探空行会消耗 `TurnSummaryComponent` 的 `revealArmed`（`turn-activity.ts:988-994`）。仓里已有无副作用的 `renderForMeasurement`（`turn-activity.ts:758-772`），这两处没跟上。**修法**：改用 `renderForMeasurement`/`measureBlockRows`。

### M10. turn-strip ambient 行降级阶梯算错预算，完整短文案被「…」取代
`turn-strip.ts:343-347`：fitting 预算没算 `"◇ "` 前缀（2 列）和可展开 caret（5 列）。实测 width=36 时放得下完整「另有 1 个变动」却显示「◇ 工作区另有 1…  ▸」。**修法**：fitting 预算计入前缀与 caret。

### M11. 嵌套列表项内 blockquote/heading 退回显示原始 markdown 源码
`markdown.ts:2492-2497` 同一 else 路径：blockquote/heading token 的 `text` 是未解析原始源码，`**`、反引号原样显示，丢失 `│ ` 边框。**修法**：同 H3 一并处理。

### M12. LaTeX `\quad`/`\qquad` 被塌陷成单空格
`latex.ts:832` `.replace(/[^\S\n]{2,}/g, " ")` 把 SPACING_COMMANDS（:285-292）刻意产生的多空格也吞了，`SPACING_COMMANDS` 成死代码。**修法**：塌陷前用占位符保护间距命令的输出。

### M13. diff 渲染不做控制字符清洗，`\r` 可致花屏
`diff.ts:19` 只 `replaceTabs`；`diff-rows.ts:27` 的 `sanitizeDisplayText` 会剥 `\r`/C0。ipython-cell 展开 diff（`ipython-cell.ts:778/789`）走 `generateDiffString` 直送 `renderRichDiff`，来源字符串（kernel edit skill 记录）无归一化。`\r` 落在满宽背景 padding 行中间 → 光标回卷覆盖行首 gutter。**修法**：`renderRichDiff`/`renderDiff` 入口统一过 `sanitizeDisplayText`。

### M14. 运行时改 `editorPaddingX` 后 placeholder/header 行用旧 padding，输入框左边界跳动
`custom-editor.ts:69, 351-357`：构造时固化 `configuredPaddingX`，`setPaddingX`（`editor.ts:467-473`）只改基类字段。**修法**：`getEffectivePaddingX` 改读 `this.paddingX`。

---

## 四、Low（19 条，按子域分组）

**宽度/渲染底层**
1. `utils.ts:53,179-181`：孤立 surrogate 宽度计 0，实际输出 U+FFFD 占 1 列 → 贴右边缘行错位。修法：`graphemeWidth` 对孤立代理计 1。
2. `utils.ts:145-163`：`truncateToWidth` 截在 OSC8 链接内不关闭链接 → 省略号和行尾 padding 带链接可点。修法：截断点在开链接内时补 `\x1b]8;;\x07`。
3. `utils.ts:1030-1098`：`wrapTextWithAnsi` width=1 时宽字符既超宽又产生多余空行。修法：breakLongWord 首个 grapheme 放不下时不 push 空行。
4. `utils.ts:1436-1460`：`hyperlinkAtColumn` 不展开 tab，与 `urlAtColumn` 口径不一致 → 含 tab 行点链接中段无反应。修法：同样做 tab 展开补偿。
5. `terminal.ts:650-656`：`COLUMNS`/`LINES` 环境变量回退无 TTY 检查，陈旧导出值盖过真实尺寸（是 H1 的触发器）。修法：仅 TTY 时采信或加 `PI_TERMINAL_*` 逃逸门。
6. `tui.ts:573-576`：`setClearOnShrink` docstring 称默认开，实现默认关（`tui.ts:478`）——文档与实现相反。

**fullscreen / 选择**
7. `tui.ts:2148-2173`：「回到底部」提示整行覆盖 transcript 底行，抹掉该行选区高亮且复制到的是看不见的原文；选择仍映射被盖住行（`fullscreen.ts:787`）。修法：`transcriptLineForScreenRow` 排除提示行。
8. `fullscreen.ts:678-686`：frame 拖选期间帧更新把快照坐标高亮画到新内容上（dock 每秒变化时反白错位）。
9. `fullscreen.ts:609-618`：拖选锚点在窗口首行时自动上滚永不启动（与 test:1415 锁定的防误滚共用条件）——「从第一行向上框选」手势失效。
10. `tui.ts:1432-1457`：overlay 聚焦时滚轮被整体吞掉，带 `onWheel` 的 dock 区域（子代理条）滚动同时死掉。修法：overlay 分支补 `wheelTargetAt` 查询。
11. `fullscreen.ts:730-739 + :297`：拖选经过 kitty 占位图片时 `\x1b[0m`/stripAnsi 破坏格子内图片 id（编码在 24 位前景色），被选图像格子变空白残块（瞬时）。
12. `fullscreen.ts:730-739`：选区边界落在满宽行宽字符中间时造出 width+1 的行 → 走钳制掉行尾一格。修法：选区边界对齐 grapheme 或用 strict slice。

**组件**
13. `editor.ts:757-759`：底部滚动指示行不截断（顶部有 `truncateToWidth` 兜底）；窄终端下每帧超宽，inline 路径每次 clamp 都把整份 transcript 写 pi-crash.log（日志 churn）。修法：镜像顶部的 `truncateToWidth`。
14. `loader.ts:56-62,77-81`：`setIndicator` 不带 frames 时默认 braille 帧走 verbatim 分支，丢主题色（且 `workingIndicatorOptions` 持久化，持续受影响）。
15. `image.ts:105`：`maxWidth` 无下界，width≤2 时发 `c=0`/`width=-1` 畸形 kitty/iterm2 序列；`image.ts:33` 的 `maxHeightCells` 声明并写入文档但无人消费（API 漂移）。
16. `footer.ts:481-500`：sessionSpend 降级阶梯与注释矛盾，存在「子代理花费随宽度变窄重新出现」的非单调路径。
17. `timeline-rows.ts:968-970` vs `footer.ts:286-297`：「1000k」口径不一致（footer 有 ≥999,500 进位成 1M，compaction 行没有）。修法：统一走 `formatTokens`。
18. `step-label.ts:130-148`：`shortenCommand` 按 code unit 而非显示列计 44 列预算，CJK 命令跳过词边界截断。
19. `timeline-rows.ts:1242-1243`、`turn-timeline.ts:931`、`tool-output-budget.ts:157`、`tree-selector.ts:1112,870,1011`：多处按 UTF-16 code unit 硬切，可留半个代理对 → 行尾 U+FFFD 残字形。修法：统一用 grapheme 切分工具。

**输入/终端**
20. `stdin-buffer.ts:289-302` + `editor.ts:1342-1351`：`\x7f`（DEL）在 ≥32 字符的 bulk run 里被当文本插入（0 宽不可见），该次退格失效，垃圾字节随 prompt 提交。
21. `stdin-buffer.ts:224-241` + `keys.ts:935`：短 run `\n`=提交 vs bulk run `\n`=文本——非 kitty 终端无 bracketed paste 时，小段多行粘贴被逐行提交，大段反而正常。
22. `terminal-colors.ts:177`：COLORFGBG 启发式把 bg=8 误判 light、bg=7 误判 dark（参考实现用 `{0-6,8}` 判 dark）。
23. `tui.ts:1153-1154`：OSC52 兜底无长度上限（clipboard.ts:20 有 `MAX_OSC52_ENCODED_LENGTH=100_000`，库路径没有）。
24. `terminal-image.ts:449-454`：占位图片 transmit 去重只看 (id, 几何) 不看载荷 → 同 id 同尺寸换图永远显示第一帧（API 契约级休眠 bug）。
25. `image.ts:95-101`：Image 渲染缓存缺 capabilitiesVersion，运行期能力翻转后不更新。

**消息/内容安全**
26. `assistant-message.ts:614-617`：非折叠错误路径把未清洗的 `errorMessage` 原样送终端（含 ESC 即清屏）；`compaction-outcome-message.ts:30` legacy 路径、`injected-prompt-message.ts:213/226` 同类。修法：统一过 `normalizeErrorDetails`。
27. `memory-detail.ts:91`：已删除记忆的展示绕过 `sanitizeDisplayText`（同文件 `plainLines:55` 却有清洗）。
28. `markdown.ts:2231-2237`：blockquote 内代码块的 quote 色在 `\x1b[39m` 后丢失（只在 `\x1b[0m` 后重挂）。
29. `markdown.ts:1294`：tab→3 空格在 lex 前归一化，偏离 CommonMark（tab=4 列），`\t` 缩进代码块渲染成普通段落。
30. `theme.ts:688-704,1590`：粗斜体走 chalk（尊重 NO_COLOR/TERM=dumb），颜色走 theme.fg（无条件 ANSI）→ NO_COLOR 下颜色照出强调全失，TERM=dumb 下转义码泄漏。
31. `markdown.ts:1391-1399`：代码块超长行 wrap 续行丢失缩进，「逃出」代码块。
32. `inline-markdown.ts:43-49`：链接识别不支持 `[text](url "title")`，整链原文显示。
33. `extension-selector.ts:19,67`：固定行数少算 1（有标题时 chrome 是 6 行不是 5）；`settings-list.ts:120,130-142` 超宽 label 不截断把 value 挤没；`settings-list.ts:153` 等折行不计入行数预算。
34. `custom-editor.ts:230-233`：`setPlaceholder` 不触发重绘（`invalidate` 是空实现），靠周边 loader tick 掩盖；`custom-editor.ts:388` placeholder 无条件少 1 列（paddingX≥1 时不该留）。
35. `block-focus.ts:110-112`：`isVisibleRow` 用 npm strip-ansi 剥不掉本仓 APC marker → marker-only 行被判可见，块导航定位可能偏。
36. `interactive-mode.ts:749-766`：子代理 activity 文案滞留（JSON 无法区分「清空」与「未携带」）；`interactive-mode.ts:7789-7828` chip 条 counts 与 chips 双源瞬时打架。
37. `interactive-mode.ts:14298`：`handleContextCommand` 宽度钳 ≥24，窄于 26 列终端窄屏布局初衷失效。
38. `turn-footnote.ts:266-271`（死代码）：withheld 原因一律写「看起来是密钥」；0/0 时显示 `+0 −0` 违反 wave-21 口径。组件生产无引用，建议修或删；对账脚本头注释仍列它为显示消费方。
39. `block-focus.ts:262-277`：`componentRowOffset` 用 `render(width)` 探行数（同 M9 类隐患，当前无触发路径），且只下钻 `constructor === Container`。

**观察项（非 bug，记录在案）**
- `motion.ts` 大半是死代码：模块头注释宣称的淡入/闪烁/折叠动画都不存在，`setMotionFrameRequester` 实际只服务 slide 展开——注释与实现脱节。
- sticky header 机制（`pinAt`/`holdForPinnedHeader`）无生产者，死路径。
- `interactive-mode.ts:7362-7379, 4631-4638`：未挂载 Loader 空转 requestRender（有 stop 无泄漏）。
- settings-selector.ts:219、side-question.ts:151 界面英文，其余中文——语言不一致。

---

## 五、修复优先级建议

1. **先修数据正确性**：H1（fullRender 无 clamp，画面错乱源头）、H3/M11（表格/引用内容丢失）、M7（对账门口径分裂）。
2. **再修高频可见**：S1（状态不一致，attach 是主用法）、H2（所有嵌套列表错位）、S2（agents-view 列宽）。
3. **顺手一批 Low**：孤立 surrogate、grapheme 硬切、editor 底部指示行、`+0 −0` 口径——都是小改动。
4. **需要产品决策的**：M3（meta 前缀取舍）、S2 ambiguous-wide 探测、M14 placeholder 之外的 paddingX 语义。

## 六、验证方式

每条修复须带回归测试（test-hygiene 门：不探私有成员，驱动公开入口断言可观察输出）。High/Medium 条目修复后用 tmux 实测（AGENTS.md 有现成流程）；涉及宽度/列对齐的用仓内 `visibleWidth` 口径写数值断言，参考各 agent 报告里的复现脚本思路。


---

# 第二轮（2026-10-06，12 路蜂群）

覆盖：export-html、theme 系统、CLI/非交互输出、队列/通知区、auth/login UI、daemon/attach 一致性、agents-view 深挖、fullscreen 组合逻辑、图片链路、context/compaction UI、剩余组件清扫、第一轮结论复核。

**复核结论：第一轮 S1/S2/H1-H3/M1-M14 全部成立，零误报。** M5 触发条件精确化：真正触发是「粘贴无 code 参数的合法 URL（如 `?error=access_denied` 重定向）」→ onPrompt 兜底 → 二次 addChild。

## High（新增 2 条）

### R2-H1. 残缺自定义主题启动即崩（进程直接退出）
**位置**：`theme.ts:195-203`（validator 惰性加载，启动时必然未就绪）、`:827-844`（未就绪时只查 `colors` 是不是对象）、`:550-560`（缺 token 时 `fg()`/`bg()` 抛 `Unknown theme color`）、`:1042-1049`（fallback 只补 74 个 optional 色，55 个 required 核色缺失永久缺席）。
**机制**：`initTheme` 先 `void preloadThemeValidator()` 再**同步** `loadTheme` → 残缺主题通过最小校验 → 首帧渲染抛异常 → 交互模式无 `uncaughtException` 处理 → Node 打栈退出；异步复检只 `console.error` 且进程多半已死。`resource-loader.ts:727-742,799-806` 第二条入口同病；`loadTheme` 对已注册主题永不复检（`theme.ts:1069-1076`）。
**触发**：fork 新增 required token 后，按旧 schema 写的自定义主题 + settings 里还指着这个名字 → 每次启动都崩。
**修法**：最小校验补 55 个 required 键静态名单；异步复检失败时回退有效主题 + showError。

### R2-H2. 登录对话框无行数预算，80×24 下 Prime Inference 粘贴输入框被整体裁掉
**位置**：`login-dialog.ts`（全文无高度管理）；裁切点 `tui.ts:1702-1703`（overlay `slice(0, maxHeight)` 保顶丢底）；`centered-overlay.ts:45-49,99-105`（`maxHeight:"100%"`）。
**实测**：prime-inference 流程 80×24 渲染 **31 行裁 7 行**——「验证码」值、手动方式标题、粘贴提示、**输入框本身**、取消提示全部不可见；≤29 行高都有内容丢失。anthropic 流程裁 2 行；叠加 M5 后 33 行裁 9 行（新输入框在屏幕外，只剩旧框可盲打）。
**修法**：LoginDialog 注入 `getRows` 预算，超高时降级（省 13 行 logo、压缩 spacer、缩 URL）；更根本：CenteredOverlay 超高时保证 input 区域可见（滚动/底部对齐）而非无脑丢底部。

## Medium（新增 16 条）

**导出 HTML（agent-13）**
- R2-M1 `template.js:763-815`：bash 输出 ANSI 不剥离，导出后 `[31m` 乱码直接可见。修法：strip ANSI 或 ansiToHtml 转色。
- R2-M2 `template.js:834-840,937-964`：工具结果图片只在 read case 渲染，其余工具（含 MCP 截图工具）导出丢图。修法：default/renderedTools 分支都追加 `renderResultImages()`。
- R2-M3 `template.js:752-761`：`findToolResult` 线性搜全部 entries 不限当前 path → fork 分支场景下工具调用显示别的分支的结果。修法：只搜当前 path。

**Theme（agent-14）**
- R2-M4 `theme.ts:1193-1198,1213-1222,1144-1148`：主题加载失败一律回退 hardcoded `"dark"` → light 终端上暗底暗字不可读（对比度 ~1.4:1）。修法：三处 catch 回退 `getDefaultTheme()`。

**CLI/非交互（agent-15）**
- R2-M5 `main.ts:1546,1574-1577`：stdin 非 TTY 时 `--version`/`--help`/`model list`/`session export` 全部落 stderr（`takeOverStdout` 在 meta 分支之前执行）。`prime-agent --help`（stderr）与 `prime-agent help`（stdout）同一内容两条流。修法：四个出口改 `writeRawStdout` 或 takeover 推迟。
- R2-M6 `public-command.ts:220-245`：`prime-agent --help list` 被 typo 守卫误杀（"Unknown command: list"，exit 1）；`--offline status`、`-v status` 同类误伤。修法：守卫先放行 help/version 已置位的调用；suggestion 排除精确命中。
- R2-M7 `daemon-ps-format.ts:316-335`、`daemon-list-format.ts:106-125`：`status`/`list` 表格无宽度处理，实测行宽 245-312 列，任何终端都物理折行；同仓 `stdout-wrap.ts` 有整套宽度基建没接上。修法：接 `getStdoutWidth()` + 按优先级丢列。

**队列/通知（agent-16）**
- R2-M8 `agent-session.ts:1281-1282` → `interactive-mode.ts:525-544`：排队消息预览把子代理原始文本的 ESC/CR/BEL 原样上屏（实测 `\x1b[2J` 直接清屏）。修法：入 TruncatedText 前过 `sanitizeDisplayText`。
- R2-M9 `interactive-mode.ts:1997-2005,8390-8392`：legacy 面 footer chip 只取 quotaParkForms 最长形（46 列），w≤~90 时整个 chip 消失而兜底行只在 telemetry=off 时钉 → 默认配置下最长 24h 配额挂起无常驻指示。修法：chip 按宽度选形。

**daemon/attach（agent-18）**
- R2-M10 `interactive-mode.ts:3606-3618,4049-4090`：resync 后 footer 遥测 memo 不失效 → footer 永久滞留旧模型/旧上下文水位/旧「即将压缩」，空闲会话一直错。修法：`applyConnectionStateSnapshot` 里调 `invalidateFooterTelemetry()`（一处修覆盖三条路径）。
- R2-M11 `daemon-supervisor.ts:9455-9469`：slim 客户端内联 `session_replaced` catch-up 丢 children/parent/quotaPark（rev 46 补了 messagesOmitted 没补其余）→ 子代理面板/stall 标记清空、park 倒计时消失等下个心跳。修法：wire 形状补字段或改发 `session_resynced`，按 daemon 协议规则登记。

**agents-view 深挖（agent-19）**
- R2-M12 `agents-view-mode.ts:3222-3227`：stall/quiet/heartbeat 状态标签全部计算了但**渲染门永远不显示**（`761f33938` 落地起从未可见——git 证实的「生产方改了消费方没跟上」）。卡死会话看起来和健康会话一模一样。修法：放宽渲染门；测试必须驱动 `renderRow` 断言可见输出。
- R2-M13 `custom-editor.ts:257` + `agents-view-mode.ts:1101-1105`：回复草稿中按 ← 直接清空草稿解除回复（Right 有非空门、Left 没有，不对称）。修法：`onAgentsBack` 在草稿非空时 `return false`。
- R2-M14 `agents-view-mode.ts:1551-1564`：`clearDeleteConfirmation` 清 `pendingKillSubagent` 不清 `pendingDeleteAgent`（同函数内不对称）→ 取消删除确认后该行回复键永久静默失效。修法：同步清。

**fullscreen 二轮（agent-20）**
- R2-M15 `fullscreen.ts:772-775,787-796,283-288`：transcript 不满一屏时，拖选进入下方空白填充区 → 锚点映射为虚拟行号 → 下一帧 stale 检查 `clearSelection()`。会话开头/`/clear` 后框选扫进空白即丢选区（确定性复现）。修法：`transcriptScreenBounds` 的 end 与内容下界取 min。

**图片链路（agent-21）**
- R2-M16 `interactive-mode.ts:1776,2036-2047,9346-9367`：attach/resume 后 `nextImageMarkerId` 不与会话历史对账 → 新贴图抢占旧 id `[image #1]` → 召回旧消息发送时 `collectMarkedImages` 命中**新图字节 + 旧图路径注记**，静默挂错图发给模型。修法：backfill 入口 `Math.max(nextImageMarkerId, id+1)`。

**context/compaction UI（agent-22）**
- R2-M17 `context-tree-format.ts:241-247,291`：/context 对齐表格 root 行恒定超宽 +6 列、unknown 行 +4 列（预算常数 `- 28` 假设 context 列 ≤20，实际 26-29）。中文 label 19 字即触发，root 行 `(518k/1.0M)` 折到下一行、表格错位。测试只覆盖 compact 分支。修法：按实际 cell 宽度记账或加 truncateToWidth 兜底。
- R2-M18 `context-tree-format.ts:64-66,329`：/context 花费列仍用 `$`，与全 TUI 的 `¥`（`spend-format.ts:9` 声明统一收口）分裂——footer `¥4.20` vs /context `$4.20`。修法：改走 `formatSpendCost`。

**组件清扫（agent-23）**
- R2-M19 `block-focus.ts:89-106` + `theme.ts:556-560`：块导航选中背景在自带背景的块上不可见（ToolPanel 覆盖 0 格、用户气泡 1 格）——行内 `\x1b[48;…m` 覆盖选中色、`\x1b[49m` 重置为默认而非恢复选中色。两类最常见可聚焦块上聚焦主视觉信号完全缺失。修法：paint 前中和行内 bg 码，`\x1b[49m` 改写为重发 selectedBg。
- R2-M20 `edit-summary.ts:162-171` + `interactive-mode.ts:4862-4865`：legacy recap「改动 N 个文件」把 ambient 改动并入本会话计数（own +10−2 + ambient +500−400 → 显示 +510 −402）。quiet 侧 turn-strip/timeline-rows 都拆了，唯独 legacy recap 没跟上 origin 形状。修法：`formatTotalChangeSummary` 过滤 ambient。

## Low（新增约 30 条，择要）

- 导出：`ansi-to-html.ts:106-171` 不支持 SGR 7/9（strikethrough/inverse 静默丢）；OSC8/非 SGR CSI 原样泄漏成可见乱码；`template.js:558-561` 按 code unit 截断留残字形；`template.css:294` 引用不存在的 `--hover` 变量；CLI `--export` 不读用户设置主题（light 用户导出 dark）。
- theme：`theme.ts:1213-1222` setTheme 失败路径不触发变更通知 → 扩展 API 路径新旧主题混色；`theme.ts:1384-1398` 导出按 `name === "light"` 硬编码判定 → 自定义浅色主题导出白底白字；`theme.ts:658-677` surface 混合后不复核最小亮度差（中灰终端面板不可分）。观察项：6 个 thinking* required token 无生产消费方（死 schema）。
- CLI：`daemon-list-format.ts:111-113` 等三处用 code unit 做列宽 → CJK 会话名后所有列错位；`package-manager-cli.ts:1624-1644` `config` 命令非 TTY 下泄漏整段 TUI 转义序列 + exit 13；`prime-agent agents` 非 TTY 静默成功零输出还白建 daemon 会话；`daemon-mode.ts:5343` 会话名未清洗进表格（`\n` 拆行、ESC 直写终端）；`cron-jobs.ts:1803-1805` code unit 硬切 + label 未转义；chalk 只看 stdout，stderr 错误在管道时丢色；`daemon-command.ts:1336-1340,1616-1621` attach 监视器向管道写 readline 控制序列、消息原文不清洗。
- 队列：`interactive-mode.ts:516-520` 队列预览标签映射漏第 4 个「Background command finished」（英文混入 + 「稍后发送」语义误导）；`:8410` 钉住的 quota-park 行只用最长形 + 无省略号硬切。
- auth：`oauth-selector.ts:49,399-401`/`prime-team-selector.ts:19` reservedRows 未计 subtitle 折行；`menu-panel.ts:83` 极小终端（80×8）列表整区消失只剩标题。观察：prime-team-selector 全英文。
- daemon/attach：`rlm-child-run.ts:312-319` `compactRlmText` code unit 硬切 → agents-view 行标题/预览残字形（与第一轮 L19 同类不同位置）。
- agents-view：`agents-view-mode.ts:2908-2938` 锚点永久缺失时每次 rebuild 重新武装 2s Enter 封锁；`:3421-3423` PgUp/PgDn 步长大于实际可视行数（跳过 ~5 行未入屏内容）；`agents-view-state.ts:1508-1515` `subtitle` 纯死数据（model/cwd 算了从不渲染）；`session-view-search.ts:37-42` 非法 `re:` 正则静默过滤全部行无错误提示；`agents-view-state.ts:637-664` vs `:1072-1086` 同一行内「子代理」口径分裂（rollup 全树 vs 过滤后）；`:1231-1234` spawn 分组顺序与注释不符；观察：状态文案大量英文、ctrl+c 有文本时直接进退出确认与编辑器语义不一致。
- fullscreen：`fullscreen.ts:419-425,212-218` clickHold 行号在 prepend 竞态下 reveal 锚错行（窗口上跳）；`tui.ts:1718-1725` 超高 overlay 撑破帧高（当前生产不可达，库契约缺口）；观察：paint 的 clamp 不写 pi-crash.log，修 H1 时一并接入。
- 图片：`terminal-image.ts:484-494` 行高无上限（100×20000px 图 → 6000 行 transcript；生产全 fallbackOnly 故休眠，一旦有生产方直升 high）；`terminal-image.ts:193-206` `imageLineRowOffset` 的 `^` 锚点被 quiet 缩进/块聚焦 bg 前缀击穿 → 跨窗降级保护失效（休眠）。
- context：`footer.ts:286-297` vs `agent-activity.ts:128-134` vs `timeline-rows.ts:968-970` 三套 token 格式器读数不一致（`5k`/`5.0k`、`1M`/`1.0M`、`1000k` 三个口径）；`context-tree-format.ts:250-255,308-312,341-344,302` compact 布局固定行不钳宽、scan 行非 compact 不钳；`footer.ts:537-539` vs `:564-567` /speed 行两种门面缩进差 1 列。
- 组件：`collapsible-error.ts:146` 展开态点击区只盖首行（折叠态盖全部）；`bordered-loader.ts:35` 取消提示英文 "cancel"。

## 复核路（agent-24）的修复连带警告

1. S1 修法①会让 `tl-in-timeline.test.ts:659,678-679,716-717` 手动补的 `tracker.reported` 变成二次 close，这些用例需同步改。
2. S2①（全局共享列宽）会让 `agents-view-mode.test.ts:1128-1164` 钉死 per-section 语义的断言失效，需同步改。
3. H2 测试缺口是双层的：除了主题单一，断言用 `includes` 子串匹配，4 空格错位下照样命中——修复后断言必须锚定行首。
4. 完整「修复后应加测试」清单 14 条见原始报告（tool-results/AgentSwarm-AgentSwarm_13）。

## 两轮累计

- High ×5（H1、H2、H3、R2-H1、R2-H2）+ S1（High 级）
- Medium ×30
- Low/观察 ×70+
- 已复核零误报；触发面为「休眠/库契约级」的条目已逐条标注。


---

# 第三轮（2026-10-06，12 路蜂群）

覆盖：extensions UI、slash/autocomplete、model/settings/config 菜单深查、ipython/kernel/goals/cron、editor 深潜、turn-activity/running-card、渲染编排（live-turn-flow/feed-data）、复制文本链路、skills/MCP/工具 UI、duty-log/refinement、tmux 实机动态验证、packages/agent+packages/ai。

**tmux 实机验证路结论：抽查的 4 个条目（H2、R2-M5、R2-M6、R2-M7）全部实机复现确认，零误报。** H2 修正：错位是复利爆炸（child=4、grandchild=10、再深 22…，按 I(d)=I(d-1)+2d 增长），比「每层 +2」更严重；H2 的「反向误命中」分支在生产不可达（生产链路无 `\x1b[36m` 发射源），降级为理论风险。R2-M6 补新实例：`--version list` 同样被 typo 守卫误杀。

## High（新增 1 条）

### R3-H1. /settings 主题子菜单把加载失败的主题名写盘 → 下次启动必崩（R2-H1 的生产者）
**位置**：`interactive-mode.ts:12022-12029`（`onThemeChange`：`setTheme` 失败后 `applySetting(... setTheme(themeName))` 无条件执行）+ `settings-manager.ts:2671-2675`（即写盘）。
**机制**：运行期 validator 已预热所以菜单里选坏主题一定失败、UI 显示「已换回深色主题」；但坏名字已写进 settings.json，下次启动走 R2-H1 的最小校验窗口 → 首帧崩进程。用户以为没切成功，实际埋了雷。`onThemePreview` 划过坏主题也会把 UI 静默切成 dark 兜底色。
**修法**：`result.success` 才 `applySetting`；失败时 `done(currentValue)` 回写列表当前值。

## Medium（新增 20 条）

**Extensions UI（agent-25）**
- R3-M1 `interactive-mode.ts:6559-6653`：daemon 模式 `subscribeToAgent` 无 `extension_error` 分支 → 扩展报错在 TUI 完全不可见（print/acp/rpc/daemon-command 都有消费，唯独交互模式漏）。修法：补分支调 `showExtensionError`。
- R3-M2 `daemon-extension-binding.ts:173-175` + `daemon-mode.ts:6612-6615`：带 timeout 的扩展对话框超时后，客户端迟到的 cancel 撞上已删条目 → throw → 聊天里追加幽灵错误「Unknown extension UI request」。修法：未知 requestId 幂等成功；或超时广播 dismiss。
- R3-M3 `daemon-extension-binding.ts:168`：signal 中止/多客户端 attach 时无 dismiss 下行事件，输家客户端对话框永挂，再答吃错误。修法：协议加 capability-gated dismiss 广播。
- R3-M4 `interactive-mode.ts:5042-5187`：并发扩展对话框互踩 editorContainer——先到者 promise 悬挂，旧倒计时到期还会闪退新对话框。修法：打开前先走旧对话框 onCancel；hide 只在自己持有时清。
- R3-M5 `footer.ts:360-362`：fork 品牌化提交 `813b847b4` 删掉了 extension statuses 渲染 → `ctx.ui.setStatus()` 完全不可见，而 docs/extensions.md:166 与一批示例扩展都依赖它。修法：恢复渲染或删 API+改文档。
- R3-M6 `daemon-extension-binding.ts:220-222`：`ctx.ui.custom()` 在 daemon 模式静默返回 undefined（hasUI 却是 true）→ 示例工具按「用户取消」误报模型。修法：首次调用 notify「daemon 不可用」或细化能力面。

**slash/autocomplete（agent-26）**
- R3-M7 `tui.ts:1731-1744` + `editor.ts:855` + `select-list.ts:273-283`：autocomplete popup 裁剪保底部（描述）不保选中项；quiet 启动首屏 popup 被压成 0-2 行候选（实测 0/5 候选项，只剩一行描述），下方大片空屏不利用；1024 字符 skill 描述无行数预算。修法：描述限行；裁剪先丢描述/scrollinfo；上方不足时向下展开。连带改 `editor-autocomplete-overlay.test.ts:81-100`。

**菜单深查（agent-27）**
- R3-M8 `model-selector.ts:767-773`：模型 tab 的 help/详情行数门限不含 config menu 的 3 行 header → 12-17 行终端菜单整体超屏，裁掉列表本身（盲选）或滚动指示+详情行。修法：门限改「剩余行数」判定；连带改 `model-selector-actions.test.ts:188-201`。

**ipython/goals/cron（agent-28）**
- R3-M9 `heartbeat-manager.ts:326-330` vs `interactive-mode.ts:14481-14482` vs `:14330,14353`：同一定时任务 nextRunAt 三个 UI 面三种显示——管理面板是无标注 UTC（`toISOString().slice(0,16)`），聊天面本地时区，差 8 小时。修法：统一本地时区格式化或显式标 UTC。
- R3-M10 `ipython.ts:1201-1202` 生产 `details.kernelRestarted/kernelReset`，`ipython-cell.ts:158-176` `readDetails` 不读 → 内核 OOM 重启丢变量，UI 零感知（模型却被告知），直到 NameError 才察觉。修法：cell 顶部加「内核已重启」行或发 SystemNotice。
- R3-M11 goal objective / cron prompt·label / sessionName 未过 `sanitizeDisplayText` 直送终端（`injected-prompt-message.ts:255,334`、`interactive-mode.ts:7648-7658,14489-14495`、`agent-session.ts:10072-10074`、`heartbeat-manager.ts:148-176,270`），模型可写入 `\x1b[2J` 清屏序列。修法：各点拼接前清洗。

**editor 深潜（agent-29）**
- R3-M12 `editor.ts:923-1031,1105-1130,795-832`：补全下拉打开期间 ←/→/PgUp/鼠标点击不关闭下拉，Tab/Enter 接受时用**过期 prefix** 计算插入点 → 实测 `"@doc"+←+Tab` 产出 `"@do` + `@document.txt` + `c"` 三段拼坏的文本（document.txt 是文件名）。secret-scan: allow 文件名探针输出，非邮箱。修法：任何光标移动路径 `cancelAutocomplete()`，或 accept 时重算 prefix。
- R3-M13 `editor.ts:1649-1652,1679`：垂直移动越过折行的 paste marker 时 continuation-skip 递归混用坐标系 → 光标瞬移到错误行尾、`preferredVisualCol` 被污染。修法：递归传入中间目标 VL。
- R3-M14 `editor.ts:2293-2319`：jumpToChar（Ctrl+]）不过 `snapCursorOffset`，可把光标放进原子 paste/image marker 内部 → 退格腐蚀 marker → **提交时粘贴内容静默丢失**。修法：落点过 snap + clamp 到隐藏前缀之外。

**turn-activity/running-card（agent-30）**
- R3-M15 `turn-box.ts:781,789` × `block-focus.ts:92-105`：块导航聚焦 turn box 时两处「第一行」口径不一致 → 按键提示落在框顶空轨行，首条事件行的 `N 步 ▸` 凭空消失（几乎每个 turn box 必现）。修法：`isVisibleRow` 先过 `withoutGutter` 再判空。

**渲染编排（agent-31）**
- R3-M16 `live-turn-flow.ts:240-246` + `turn-timeline.ts:618-624`：跳过/失败的自动压缩留下永不结清的「正在整理」幻行（outcome 消息先于 compaction_end 到，`activeCompaction()` 从尾部找到已结清条目就返回）→ box 头卡住、幻行 spinner 永转、`transferTo` 带它重建永不自愈。修法：customMessage 分支改为结清 activeCompaction。
- R3-M17 `interactive-mode.ts:7072-7081` + `live-turn-flow.ts:302-308`：心跳提示词被 `turnFlow.userMessage` 当主人提问 → 子代理 lane 被 reset（「还在干活」消失、交回时无 `──╯` 汇合行）、心跳回合误标 startedByUser；live↔replay 不一致。修法：心跳判定提到 userMessage 之前。
- R3-M18 `live-turn-flow.ts:191-196` vs `conversation-components.ts:671-677`：另一视图按 Esc 中断后，live 把追问并入同一 box（「你插话」）、replay 开新 turn——多视图 attach 下分组分裂。修法：runCutMidTask 排除 owner-stop stub 情形。

**复制链路（agent-32）**
- R3-M19 `block-focus.ts:245-256`：块复制（Y 键）对每行全 trim + 丢空行 → 展开卡片里的代码缩进/段落结构全灭（compaction/skill/refinement 卡片全中）。修法：复制源文（这些卡片都持有源文），参照 assistant-message 做法。

**skills/MCP/工具（agent-33）**
- R3-M20 `bash.ts:1349-1351` + `interactive-mode.ts:3930-4015,9163-9165`：bash 流式期间的 1 秒 "Elapsed" interval 在组件被会话替换/重建丢弃后永久泄漏，每秒空转全帧重绘直到进程退出（同函数里 activeBashComponent/retry loader 都清了，独漏这个）。修法：组件 dispose 钩子或 tick 自检 detach。
- R3-M21 `bash.ts:794-797` + `code-preview.ts:74-82,258` + `step-label.ts:169-174`：纯 setup 型命令（`export KEY=secret`）preview 为空 → 回退显示原始命令，绕过 `redactNoise` 脱敏 → secret 原样上屏。修法：raw 回退也过 redactNoise。
- R3-M22 `tool-execution.ts:486,696-699`：`isMalformedToolName` 守卫只在折叠态生效，展开后畸形工具名（模型可控，可含 `\x1b[2J`）原样进 panelHeader。修法：展开路径也过 sanitize。

**duty-log/refinement（agent-34）**
- R3-M23 `refinement-outcome-message.ts:205`：被拒条目原因文本带裸 `\n` 进时间线行（`sanitizeDisplayText` 不剥 `\n`，同函数兄弟插值都单行化了独漏这个）→ 物理行与记账脱节、该行以下全部错位。修法：`.split("\n")[0]`。
- R3-M24 `duty-log.ts:542`：「最后在做」行的 agent_status 摘要只 `.trim()` 不塌陷内部换行（recap 模型可产多行）→ 裸 `\n` 进钉在输入框正上方的值班块。修法：`replace(/\s+/g, " ")`。

**packages/ai（agent-36）**
- R3-M25 `anthropic.ts:522-525`：SSE 解析失败把完整原始帧（双份、无界）塞进 errorMessage（实测 50KB 帧 → 100KB 消息），且不经截断。修法：正文只放 `truncateRawPayload` 截断段。
- R3-M26 `openai-codex-responses.ts:1526-1539,414` + `stream-failure.ts:260-269`：Codex 用量限制的 friendlyMessage（套餐+重置时间）在分类层被丢弃；`resets_at` 没变成 `retryAfterMs`（消费方 `provider-retry.ts:227` 等着用——两头接好中间没给）。修法：构造时写 `retryAfterMs`，detail 用 friendlyMessage。
- R3-M27 `oauth/anthropic.ts:81-96,183,216,370` + `github-copilot.ts:87` + `openai-codex.ts:134,179`：OAuth 错误把完整 stack + 无界响应体带进登录浮层错误行（可能回显 code/verifier，违反仓内自己写明的约定）。修法：去 stack、响应体 redact+截断。
- R3-M28 `openai-completions.ts:564-697`：完全不读 `delta.refusal` → 模型拒答被误诊为「空响应」，烧掉整串重试（最坏 ~5 分钟 6 次满上下文请求）后给出错误诊断。覆盖 deepseek/moonshot/zai/openrouter 等全部 openai-completions 接入方。修法：识别 refusal 通道，`stopReasonRaw="refusal"` 收尾。

## Low（新增约 35 条，择要）

- extensions：`extension-input.ts:36` placeholder 形参从不渲染（文档承诺了）；`extension-selector.ts:127-132` 选项含 `\n` 破坏行记账；`interactive-mode.ts:5327` overlay 关闭用弹栈顶而非自身 handle（嵌套乱序关错对象）；`:5344-5356` `overlayOptions` 函数只求值一次（与类型注释承诺不符）；`daemon-extension-binding.ts:223` `pasteToEditor` 映射成全量替换草稿；`extension-editor.ts:111-120` 外部编辑器失败全静默 + `split(" ")` 对含空格路径失效；notify 文本不清洗。
- slash：`/compact`、`/refine` 缺 `takesArgument` → popup 按 Enter 直接裸执行；`slash-command-result-message.ts:10` 未清洗上屏；编辑器内命令 token 上色口径与持久消息不一致；扩展命令参数以 `/` 开头时误用 slash 布局；`autocomplete.ts:599-658` 文件名控制字符进 popup；`skills.ts:436-441` 非法 name 只警告不拦截（可破坏 `<skill>` 块回读）；`slash-command-context.ts:15` 分隔符 `[ \t]` vs 解析端 `\s+`（NBSP 下补全失效）。
- 菜单：`settings-selector.ts:511` maxVisible=10 写死 + dock 零高度适配（80×24 临界态，任何 +1 行即裁顶部搜索框）；`interactive-mode.ts:12642-12647` 从 providers tab 打开时 models tab 永远拿不到会话画像，「推荐」行静默缺失（登录后挑模型主路径）。
- editor：`undo()` 不清 `snappedFromCursorCol`（下次垂直移动用过期坐标）；`pastes` 条目在 marker 被删后残留，手打 marker 字面量提交时被旧粘贴内容替换；垂直移动视觉列按 code unit 计（CJK 混排折行光标漂移）；补全打开时隐藏硬件光标 → IME 候选窗失锚。
- turn-*：`turn-box.ts:794`/`turn-strip.ts:248` BOX_FOCUS_MARKER 的 APC 裸字节在 inline 模式直写终端（`script` 录屏/部分 tmux 录进垃圾字节）；`timeline-gutter.ts:121` right 短形丢开头 ANSI（`▸` 以残留色显示）；`turn-activity.ts:988-994` 0 行 turn 消耗 reveal 不发射（Ctrl+P 看似死键 + viewport slot 永久 pending）；`:689` legacy `⚙ N 步` 用未去重 steps.length。
- 编排：wake 报告 comm 计数 live 计进上一回合/replay 丢弃；`turn-activity.ts:817-827` inlineRowBefore 只认 message 条目（steer/派发行夹在报告间时 join 错）；`agent-activity.ts:39-47` 心跳/async_bash 回合不清零 token 计数（loader 显示历史累计值）；`feed-data.ts:458,482,507` aggregateChanges 双通道 key 分裂（同一文件两条改动条目、计数虚增）；`turn-timeline.ts:421-432` dropEntry 把 tokenPeak 清零（破坏 "Never decreases"）。
- 复制：`turn-activity.ts:1004-1013` turn 块复制带 ~90 列右对齐填充空格；`fullscreen.ts:972-1008` 拖选复制 image-sequence 行得空行；`refinement-outcome-message.ts:106-108` 块复制把点击区刷成宽度 100 的陈旧值（复制后右半段点击失效）。
- 工具/MCP：`oauth-selector.ts:308-316` 空态文案硬编码「模型服务」（MCP tab 复用时说错领域）；`step-label.ts:525` 只传命令首行（`运行 # 注释`、`运行 set -e`）；`tool-execution.ts:480` key-steps 折叠行不截断；`bash-execution.ts:226-229` temp 文件写失败时截断完全无提示；`agent-session.ts:17544-17546` 扩展 user_bash 输出不清洗；`mcp-manager.ts:165` 手工声明同名 server 时 `/mcp login` 显示成功实际永不生效；`mcp-command.ts:179-181` `/mcp get` 没有比 list 多任何信息；`step-label.ts:619`/`running-card.ts:154,173` 汇总/卡片丢失命令解析（「等待 h 的结果」）。
- duty-log 等：`duty-log-block.ts:11,38` 注释 6 行实际 7 行；`context-tree.ts:70-76` compactLabel code-unit 硬切 + ASCII `...`；`side-question.ts:133` 错误文本未清洗（R1-#26 的第四个位置）。
- packages/ai：`mistral.ts:198-201` 错误体 code unit 硬切留残字形；`agent.ts:639` 合成 run-failure 不脱敏（与同消息 diagnostics 副本口径并存）；`proxy.ts:165,215,228` 代理错误原文直写；`openai-responses-shared.ts:847` "Error Code null: …"；openai-completions 从不写 stopReasonRaw（消费方拿不到原始原因）；`claude-code.ts:175-188`/`mistral.ts:656-669` 未知 stop reason 静默当成功。
- ipython：cell「N 张图片，见下方」是空头支票（生产全 fallbackOnly，下方只有元信息）；`ipython-cell.ts:492-493` aborted 分支不可达（死分支）；`showExpandHint` 死字段。

## 死代码/观察项（第三轮新增）

- `running-card.ts` 整个模块生产零消费方（`f2a0530b6` 拆除后测试还在钉它的视觉）；`turn-footnote.ts` 两个时长格式器唯一读者就是 running-card；`TurnActivityState.fileChanges` 唯一读者是死去的 TurnFootNote。
- turn box 内滚动状态整块是死的：`lastBodyLines`/`lastVisible`/`lastRowCount` 从无写入方 → inline 模式 box focus 下 PgUp/PgDn 空转被吞；`revealKey`/`revealDetail`/`holdView`/`followNewest`/`expandedAt` 只写不读。
- `addMessageToChat` 的 `options.round/populateHistory/inlineIn` 及整个 assistant 分支是生产死路。
- `settings-list.ts:72-77` `updateValue` 死 API；`config menu` 里 ←/→ 返回全面失效（`shouldTreatAsBack` 死路径）。
- `CountdownTimer` 秒级取整：timeout=500ms 显示 "(1s)" 且 1000ms 才到期。
- `feed-data.ts:403-407` mergeKind 冗余三元（两分支相同）。

## 三轮累计

- High ×6（H1、H2、H3、R2-H1、R2-H2、R3-H1）+ S1
- Medium ×50
- Low/观察 ×100+
- 复核三轮零误报；tmux 实机抽查 4 条全部复现。


---

# 第四轮（2026-10-06，12 路蜂群）

覆盖：interactive-mode.ts 全文件四段精读（14877 行）、daemon-mode.ts（10451 行）、daemon-supervisor.ts 显示段、agent-session.ts 显示段、tui 基础组件深查、全仓清洗户口普查、测试对账审查、settings-manager、三轮交叉影响分析。

**本轮主题性发现：「清洗缺位」不是十几个孤立 bug，而是一个系统性架构缺口**——仓内 4 套清洗器口径互不相同（`sanitizeDisplayText` 留 `\n`、`sanitizeBinaryOutput` 留 DEL/C1/`\r`、`normalizeErrorDetails` 留裸 BEL/NUL/DEL、只有 `top-bar.ts:32-35` 最彻底），`Markdown`/`Text` 两个最底层组件零防御，「洗没洗」完全取决于每个消费方的自觉。top-bar 的注释（`top-bar.ts:28-31`）证明仓里早知道这类数据有毒，但只有它一家防了。

## High（新增 2 条）

### R4-H1. 会话名 → 终端标题 OSC 注入（可劫持剪贴板），且持久化复发
**链路**（三环全部实证）：模型经 `rlm.run(name=...)` 命名子代理时 `normalizeRequestedRlmSubagentSessionName`（`rlm-runtime.ts:189-204`）**只 trim+限长 64，无字符集校验** → 写入会话文件 → `updateTerminalTitle`（`interactive-mode.ts:2426`）→ `ProcessTerminal.setTitle`（`terminal.ts:801-804`）**原样 `process.stdout.write`**。
**探针实测**：`worker\x07\x1b]52;c;cGFzdGU=\x07` 原样通过校验；拼出的字节流里第一个 BEL 提前终止 OSC 0，随后的 OSC 52 是对终端的**剪贴板写入**。标题在 attach/切换/重绑/rename 时反复重写，且名字持久化——**每次 resume/attach 复发**。
**次要消费点**（同一修复覆盖）：`/session` Name 行（`:13963`）、`/name` 回显（`:13892,13902`）、CLI attach 监视器（`daemon-command.ts:1545`）、CLI 表格（`daemon-mode.ts:5343`）。对照：`top-bar.ts` 对同一字段做了完整清洗——消费方没跟上。
**修法**：写入侧（`setSessionName`/`normalizeRequestedRlmSubagentSessionName`/`appendSessionInfo`）拒绝或剥离 C0/C1/`\x7f`；`ProcessTerminal.setTitle` 库级兜底剥 `\x1b`/`\x07`；读侧 `_scanSessionName` 清洗存量脏数据。

### R4-H2. 模型主回答通道（Markdown 组件）全程无控制字符清洗，OSC52/清屏序列直通终端
**位置**：`packages/tui/src/components/markdown.ts`（全文无清洗）；消费方 `assistant-message.ts:476`（正文）、thinking 展开、branch-summary、compaction-summary、skill-invocation、side-question、injected-prompt 展开全文、custom-message。
**探针实测**：`new Markdown("hello\x1b[2J…\x1b]52;c;SGVsbG8=\u0007").render(80)` 输出原样含清屏码与 OSC52；代码块/行内代码同样直通。从 agent-loop 到 `terminal.write` 全链路无一清洗点。
**现象**：清屏/花屏瞬时自愈，**OSC52 静默改写用户剪贴板**（kitty/wezterm 默认允许写）不自愈。提示注入（网页内容指示模型输出转义字节）即可远程投递。
**修法**：在 tui 库 `Markdown.setText`/`Text.render` 层剥非主题控制字符（输入文本先剥再上色，与组件自产主题码天然可分）——一处收口覆盖全部消费方，不要逐消费方补。

## Medium（新增 16 条）

**清洗普查新消费点**（agent-45，全部探针实证；修法同 R4-H2 的收口或点位清洗）：
- R4-M1 `turn-box.ts:259,269-280,479-487`：框头「在等子代理 X」/meta 直接插值裸文本（行体 stepWords 洗了，框头没洗——同一行数据两条路径）。
- R4-M2 `agent-message.ts:52-68,397-407,469-481`：子代理报告渲染面 4 处全裸（展开全文/预览/时间线/legacy 头）。
- R4-M3 `system-notice.ts:113-114`：TimelineNoticeRow 展开 detail 直通（同一 notice 走 turn-box 行时洗了，孪生路径分叉）。
- R4-M4 `agents-view-state.ts:1497-1506,1028,1096-1097`：行标题/状态/回答预览全裸。
- R4-M5 `tree-selector.ts:852-935`：/tree 选择器整组件无清洗（7 个文本源）。
- R4-M6 `bash.ts:791-801`：bash 调用头 `$ <命令>` 不剥控制字符（与 R3-M21 的脱敏绕过同点不同面）。
- R4-M7 `ipython-cell.ts:441,456-460,570-578`：cell 顶行 label/errorName/展开代码行全裸。
- R4-M8 `interactive-mode.ts:11693-11700,8750-8756`：**`showError`/`showStatus` 中央通道不清洗**——全文件约 146 处调用点汇入，provider/daemon 错误文本（可含 SSE 原始帧）直上屏。一个点修掉全覆盖，优先级最高。

**interactive-mode 精读（agents 37-40）**：
- R4-M9 `interactive-mode.ts:4486-4494` × `:4441-4445`：**quiet 模式（默认）下功能提示整条链死亡**——门条件要求 loader 挂在 statusContainer，而 quiet 从不挂。git 实证：`9e54ddf6e` 的门 × `854a06c6e` 的 quiet 不挂载，后者没跟上前者。默认用户永远看不到 feature hint，整条 deck/定时器是死代码。
- R4-M10 `interactive-mode.ts:8743-8760`：showStatus 槽位复用吞掉子代理生命周期公告行——append 分支回指槽位，后续 transient 状态把「派出子代理 X」原地改写（与 7707-7708/8740-8742 的注释承诺恰好相反，无自愈）。图片路由会话每次派生子代理必触发。
- R4-M11 `interactive-mode.ts:12045,12060,13565,11070`：设置/reload 触发的 rebuild 在流式进行中拆卸在途工具卡片（`liveChatCapBlocked()` 守卫只在 cap 路径有，这三条没有）→ legacy 面工具结果永不显示；stall 条被拆但输入路由没清，隐形条继续吃按键。
- R4-M12 `stall-diagnostics-render.ts:198-201,247-250,292-297`：stall 操作条把模型可控工具名原样上屏（每秒重绘的条输出清屏序列）。
- R4-M13 `interactive-mode.ts:9650-9667`：slim 回填页 replay 丢 hooks → 翻上去的历史与尾部长得不一样（lane 连线/改动条/扩展渲染/心跳提示词渲染全退化）。

**daemon/agent-session（agents 41-43）**：
- R4-M14 `daemon-session-summarizer.ts:143-146,282-295`：recap 链路不剥控制字符且**持久化**（`appendAgentStatus` 写盘）→ 重启/attach/agents-view 反复重放注入序列。
- R4-M15 `daemon-mode.ts:4308-4347`：`agent_observe` 状态阶梯把 supervisor 控制面连接算成 "user"——worker 模式下「有人在看」永真，idle 档死代码，误导模型决策。修法：用 `directAttachedClients` 口径（passivation 已有正确写法）。
- R4-M16 `agent-session.ts:16753`：fallback 公告把 errorMessage 前 200 字符（ESC 存活）写进**持久**公告，attach/resync/replay 反复上屏。
- R4-M17 `rlm-child-terminal.ts:179,244,254` → `turn-timeline.ts:968-974`：子代理失败原因未清洗进两个展开面（同函数 :951 的取消原因洗了，失败原因没有——同文件内的「没跟上」）；detail 无长度上限，配合 R3-M25 的 100KB errorMessage 展开一次产几千行。

**settings（agent-47）**：
- R4-M18 `settings-manager.ts:2209-2242`：settings.json 手改后的「已重载」通知零消费方——`drainWarnings` 在会话运行期间无人调用，改动静默套用/语法错误静默忽略；`warnings` 数组在长驻 worker 里无界增长。
- R4-M19 `settings-manager.ts:2667-2669,2751-2753,2647-2649,2657-2659`：非字符串 truthy 设置值（`theme: 42`）让 /settings 面板渲染抛 TypeError → 进程崩（同文件其他 getter 有 typeof 防线，这四个没跟上）。探针实测复现。
- R4-M20 项目层 settings.json 钉住的键：/settings 显示合并值、写入全局层——用户切换被静默吞掉（写成功、UI 变色、重开恢复原值，全程无提示）。

**agents-view 与测试对账（agents 42/46）**：
- R4-M21 `agents-view-mode.ts:3621,3623`：agents-view 金额用 `$`（被 `agents-view-columns.test.ts:93` 钉死），与 footer 的 `¥` 分裂——R2-M18 的第二块屏幕。修法：改走 `formatSpendCost` + 改测试。

## Low（新增约 25 条，择要）

- **X10 鼠标 UTF-8 坍缩**（`mouse.ts:56-61` + `stdin-buffer.ts:50-51`）：列 ≥160 的 legacy 鼠标报告两字节坍缩成一个字符 → 吃掉下一个输入序列首字符，残余 `[M…` **以可见文本插进编辑器草稿**。
- **Spacer/空 Box 每帧返回新数组**（`spacer.ts:19-25`、`box.ts:83-87`）击穿 LineAggregator 恒等记忆 → 每帧重建整条 transcript lines 数组（chatContainer 里约 40 个 Spacer），性能随会话长度线性劣化。
- **roster 线上丢弃 sessionActions**（`agent-roster.ts:51,85,131`）：agents-view 的「N queued」/active-action 标签结构性死路——R2-M12 修好渲染门后这两条仍不出，修门时必须同步决定线形状；连带：钝化行 stall 标记冻结。
- `seedAdoptingWorkerRosterRows` 对 0 消息 draft 硬编码 live → 命名草稿在 daemon 重启 adoption 窗口闪现后消失。
- onboarding splash ≤14 行终端裁掉「Press Enter」提示（Esc 落入无模型死胡同）；`/system` 把仓库可控 system prompt 原文送终端（恶意仓库 AGENTS.md 埋 `\x1b[2J`）；`/traces upload` 失败把无界响应原文上屏；`scoped-models-selector.ts:95` maxVisible=8 零高度适配。
- 裸 childId 跨父会话误归属三处（`daemon-session-list.ts:946-955`、`daemon-mode.ts:10063-10078,5854-5863`）——32-bit id 只在父内唯一，三处全局查。
- `interactive-mode.ts:9103-9114` `slimTranscriptOmitted` 重算假设全量 transcript（休眠契约缺口：daemon tail 超 400 即取回错误历史页，现有测试没钉这个不等式）。
- 主编辑器外部编辑器路径 `split(" ")`（`:11653`）；slim 回填页 hooks 缺失的细分项；CLI attach 监视器原样打印 auto_retry errorMessage（`daemon-command.ts:1557`）；`getSessionActionSnapshot().active.label` 控制字符进 agents-view 行状态。
- 设置面：`/fullscreen` 非 TTY 下「不可用」提示与写盘行为矛盾；连接层介导的五个面板开关不查写盘失败；`ui.subagentSpendCell` 布尔形态不容错（`"off"` 读作开）。
- compaction loader 的模型「重点」文案不清洗（`:4624`）；recap 钉住行（`:4869`）；splash「上次会话」标题（`recent-session.ts:57-64`）；edit 工具路径/错误文本全裸（`edit.ts:225-226,247`）；turn-strip 改动行路径（`turn-strip.ts:389`）；排队消息落屏为 user 气泡不洗（`user-message.ts:20-22`）；/fork 选择器（`user-message-selector.ts:45`）；`normalizeErrorDetails` 留裸 BEL/NUL/DEL（bash 输出 `\x07` 会响铃）。

## 测试对账（agent-46）：把 bug 钉成特性的测试位置

修复下列条目时**必须同步改测试**（否则套件把 bug 钉死）：
| 生产 bug | 钉死它的测试 |
|---|---|
| R2-M18/R4-M21（$ vs ¥） | `agents-view-columns.test.ts:93`、`context-tree.test.ts:434,437,442,543-548,642` |
| M12（`\quad` 塌陷） | `markdown-latex.test.ts:78-80`（断言在间距命令全删后仍通过） |
| L24（占位图去重不看载荷） | `terminal-image.test.ts:538-540`（两次调用用同一 payload） |
| R2-M9（quota-park 兜底门） | `interactive-mode-quota-park.test.ts:163-188`、`interactive-footer-status-layout.test.ts:115-140` |
| R2-M12（stall 标签门） | `agents-view-state.test.ts:217` 只测状态层；`agents-view-mode.test.ts:1062-1074` 靠塞 roster 字段开门 |
| R3-M22 类（等待 h 的结果） | `step-label.test.ts:229` |
| S1①（upsert 关 lane） | `tl-in-timeline.test.ts:659,678-679,716-717` |
| S2①（共享列宽） | `agents-view-mode.test.ts:1128-1164` |
| R3-M7（popup 保底部） | `editor-autocomplete-overlay.test.ts:81-100` |
| T2（模型 tab 门限） | `model-selector-actions.test.ts:188-201` |

**测试结构性盲区**（bug 出现套件也不会红）：`context-tree.test.ts:659-665` 宽度断言前过滤掉 totals/model 行；`login-dialog.test.ts:194-207` 从不在两次挂载间 render 且全在 ≥48 列下跑；`tui-overwide-clamp.test.ts` 只覆盖 diff 路径且顺带钉住「只有 diff 写 crash log」。

## 交叉影响分析（agent-48）：top 组合

1. **注入链（high，安全相关）**：清洗缺位（12+ 消费点）× H1（fullRender 无钳制，破坏固化）× M1（钳制丢行尾闭合码，样式泄漏）× H1 不写 crash log（全程静默）。**钳制不是防线**（探针：`sliceByColumn` 后 `\x1b[2J`/OSC8 原样保留）。根本解：TUI 写行边界设最终清洗门。
2. **启动必崩链（high）**：R3-H1（坏主题名写盘）× R2-H1（启动最小校验窗口）——探针证明崩溃发生在渲染期、`loadTheme` 的 catch **之外**，R2-M4 的 dark 回退够不到。三条必须捆绑交付，且 R3-H1 修好后已写盘的坏 settings.json 仍会引爆。
3. **attach/resync 状态腐烂链（high）**：`renderInitialMessages` 一个漏斗下五个未对账通道（S1、R2-M10、R2-M11、R2-M16、R3-M16）；R2-M16 让显示 bug 越过边界变成**发给模型的图片字节错**。建议建统一「resync 对账清单」而非各修。
4. **浮层盲操作（medium-high）**：R2-H2 × M5 × M6 × R3-M7 × R3-M8 共享「无高度预算 + 裁剪不识关键元素」模式；应在 overlay 层建「裁剪保焦点元素」契约。**注意**：保顶（`tui.ts:1702`）和保底（`tui.ts:1737-1744`）两处裁剪策略相反，哪个都不对。
5. **子代理可观测性全链失效（medium-high）**：R2-M12（stall 标签门自落地起永远关）× S1 × R3-M17（心跳主动 reset lane）——三个独立面全坏且互相混淆诊断。
6. **选择/复制链被 R3-M20 常驻激活（medium）**：泄漏的 1 秒 interval 让拖选类 bug（L8、R2-M15）从「瞬时」变成「进程余生每秒一次」。
7. **数字口径不可互验（medium）**：M7 × R2-M20 × 三套 token 格式器 × R2-M18/R4-M21 × L38——对账门自身口径分裂意味着没有任何两个面能互相验证数字。

**修法矛盾警告**：
- C1：R2-H2 的「底部对齐」不能横推为全局 overlay 策略（会把 R3-M7 的 bug 固化）；正解是裁剪保焦点元素。
- C2：R2-H1 与 R2-M4 的回退目标不同，不协同改会产生三种回退行为。
- C3：R3-M4 的修法（先关旧对话框）依赖 R3-M2（未知 requestId 幂等）先修，否则制造幽灵错误。
- C4：清洗函数口径不统一——`sanitizeDisplayText` **不剥 `\n`**（R3-M23/24 的病灶恰在此），仓内没有单一函数同时满足「剥控制字符+单行化+grapheme 安全+宽度有界」。**先定义清洗契约，再逐点接入。**

## 四轮累计

- High ×8（H1、H2、H3、R2-H1、R2-H2、R3-H1、R4-H1、R4-H2）+ S1
- Medium ×66
- Low/观察 ×125+
- 四轮复核 + tmux 实机抽查，零误报。


---

# 第五轮（2026-10-06，12 路蜂群）

覆盖：latex/stdin/keybindings、terminal.ts 全文、Python runtime 显示数据生产、export-html 深挖（实机 Chromium 双视口验证）、agents-view-mode 全文、turn-timeline/timeline-rows 剩余、footer/top-bar/recap/subagent-summary 逐行、四大组件精读、rpc/acp/headless、浮层第二轮、测试 fixture 审计、存量会话文件兼容性（读了用户真实 ~/.prime/agent 下 315 个会话文件做形状统计）。

## Medium（新增 22 条）

**输入/终端层**
- R5-M1 `stdin-buffer.ts:172-178,884`：kitty CSI-u 大码点（如 `\x1b[1114112u`）让 `String.fromCodePoint` 抛 RangeError → 进程崩（keys.ts 对同一调用有 try/catch，后加的这条路径没跟上）。修法：加 `<= 0x10FFFF` 上界。
- R5-M2 `stdin-buffer.ts:56-70`：legacy meta 的 alt+shift+{o,p,],_} 与 SS3/DCS/OSC/APC 引入符撞车，后续输入被整段吞（alt+shift+o 是 expandFull 默认绑定）。
- R5-M3 `stdin-buffer.ts:289-299` + `keys.ts:932-939`：**纠正 L21**——CRLF 大段粘贴照样逐行提交（`\r` 切断 bulk run 变 Enter）；粘贴里的 `\x0c`/`\t`/`\x1a`/`\x04` 会变成命令键（弹模型选择器/挂起/退出）。
- R5-M4 `latex.ts:776-780`：`\begin{array}{cc}` 的列格式参数泄漏成可见文字（渲染出 `cc a b`）；`aligned[t]`/`alignedat{2}` 同病。模型数学输出极常见。

**terminal.ts**
- R5-M5 `terminal.ts:779-795,130,139-147`：**崩溃后 tty 零恢复**——exit guard 只保鼠标，raw/alt/kitty/2027/bracketed-paste 全裸奔（崩溃路径 R2-H1/R4-M19/R5-M1 都在册）；且 kitty 泄漏跨进程复利（崩溃留一条 flags → 下进程再 push → 干净 stop 只 pop 一次 → 永久多留，后果是「Ctrl+C 停止产生 SIGINT」）。
- R5-M6 `terminal.ts:424-431`：全屏（默认）会话永不启用 grapheme 2027——probe 应答必然在 alt active 后到达（100% 命中非竞态），leaveAltScreen 无重试。2027-capable 终端上 ZWJ emoji 行持续错位，inline 模式反而是好的。

**Python runtime ↔ TS 对齐**
- R5-M7 `effects.py:2824-2833` `_safe_label` 改写名字（塌空白/密钥替换）但 TS 把它当精确会话名 → 子代理行卡 running + **同一子代理在 turn box 出现两行**（与 S1 同症状不同根因）。修法：ok 记录带不经显示化处理的 `name` 字段。
- R5-M8 `effects.py:392,2844`：activity id 是进程级计数器，kernel 重启后撞 id → 后台命令行张冠李戴（正在跑的 npm run dev 显示成已完成的 sleep 9 + 假报完成）。

**export-html（Chromium 实跑验证）**
- R5-M9 `template.js:1670-1675,16,1396-1399`：Escape 处理器三重损坏（清了搜索但树不重建、静默跳回初始分支夺走用户在读的分支、滚到底部是死代码）。
- R5-M10 `template.js:1630-1654,1344-1362`：T/O 展开开关状态在分支切换后丢失且标志位反相。
- R5-M11 `template.js:763-816`：折叠的工具输出初次渲染就挂全量 DOM + 双份 hljs 高亮 → 10 万行输出的导出文件打开即冻结。修法：惰性构建。
- R5-M12 `template.js:673-677`：移动端点树节点后全宽侧栏不收起，导航结果完全不可见。
- R5-M13 `template.css:829-852`：长 URL/长 token 不换行，整个内容列变横向滚动区。

**agents-view / turn-* / footer 区**
- R5-M14 agents-view 三个新清洗消费点（探针实证）：回复头行（`:2103-2113`，数据源是模型最近回答）、底部状态行（`:3359-3361`，可含 50KB SSE 帧）、spawn 程序代码行（`:3286-3290`，模型生成的 Python 源码）。
- R5-M15 `turn-box.ts:718,767`：box 正文 spawned 行/「还在干活」行渲染未清洗子代理名（持久 transcript 行，quiet 默认面，每帧重绘）。
- R5-M16 `timeline-rows.ts:500,534,606,864,921` + `turn-timeline.ts:748-772`：BoxRow.sub/window/steadyLine/steadyPrefix **全仓零消费方**——文档承诺的 live 输出行与三行思考窗从不渲染（`a7c8df7da` 删渲染时生产侧没跟上）；subagent entry 行的 meta/detail 同样不可达。
- R5-M17 `timeline-rows.ts:1460-1464` + `turn-box.ts:644-649`：steer 插话事件不可展开，长插话被硬切后全文不可达（展开能力死在路上）。
- R5-M18 `subagent-summary-line.ts:287,289,1021`：strip chip 名字/标签全程无清洗——OSC52/清屏序列钉在**主界面 dock 每秒重绘**（R4-H1 数据的新消费点，探针实证）。

**会话重建/兼容**
- R5-M19 `conversation-components.ts:938-975`：replay 给「有真实保留结果」的中断工具盖上编造的「已中断」——live 保留真实输出，replay 因不进 pendingTools 而把真实 toolResult 落进 orphan 丢弃；edit 的 diff 一并丢。
- R5-M20 `turn-timeline.ts:954`：`lastAssistantTextPreview` → `lastAssistantText` 改名无兼容读——用户真实存量文件有 **108 条**旧字段名条目，quiet replay 里子代理最后答案彻底不可见。
- R5-M21 replay 对缺字段条目零容错：一条坏行（如缺 content 的 custom_message）→ TypeError → **进程打栈退出，会话从此无法打开/attach，每次必崩**（agents-view 里看着活着一进去就崩）。且 daemon RPC `append_custom_message` 无形状校验 = 可持久化投毒面。修法：replay 单条消息容错边界 + 写入侧校验。

**RPC/ACP/headless**
- R5-M22 `rpc-mode.ts:130-176`、`acp-mode.ts:779-818`：RPC/ACP 静默丢弃全部连接级事件——quota park（最长 24h）后 ACP 客户端在途 prompt 无限挂起零提示；daemon 重连后状态永远过期。
- R5-M23 `acp-mode.ts:450-452`：ACP `turnFailure` 只认 `stopReason==="error"`，stall watchdog 杀死的回合被报成正常 `end_turn`（兄弟路径 headless/print 都查 aborted）。
- R5-M24 `acp-events.ts:224-235`：ACP compaction_end 丢失败字段，失败的压缩变成空 `{}` 成功假象。
- R5-M25 `headless-completion.ts:31-66`：尾部任何非白名单 custom 消息（如子代理失败通知）让 `prime-agent -p` 静默输出空、exit 0——CI 把空输出当成功。
- R5-M26 `acp-events.ts:97-99,111-112,173-185`：ACP 永远收不到 ipython 图片，两处注释声称相反（假话）；payload 被剥掉不可恢复。

**浮层第二轮**
- R5-M27 `config-selector.ts:403`：`prime-agent config` 过滤框里按空格 = 静默切换选中资源并写盘（settings-list.ts:182-187 早修过同 bug，它没跟上）。
- R5-M28 `interactive-mode.ts:4827`：`resetExtensionUI` 弹栈顶 overlay 可打掉登录对话框（OAuth 轮询后台悬空，浏览器完成后凭据落盘但对话框早已消失）——比 R3-L3 更危险的第二实例。
- R5-M29 `interactive-mode.ts:11991,13521`：/settings 里切换「内置技能」触发 reload → 整个设置面板无声拆掉，上下文丢失。

**fixture 审计**
- R5-M30 stall marker 的 `name: text` 手写微格式在真实名字含 `": "` 时解析错乱 → 一个卡住的子代理变两个红块；且孤儿块分支生产不可达，纯测试钉出来的死功能。修法：协议改结构化 `{name, text}[]`。
- R5-M31 chip 条名字含 `\n` 击穿单行契约（1 逻辑行含 2 物理行 → 行记账损坏）；所有「恰好一行」测试只喂干净名字。

## Low（新增约 30 条，择要）

- `\\[5pt]` 间距参数泄漏；顶层游离 `}` 静默截断公式；>8MB 粘贴拆成多个 `[paste #N]` 占位符；键位配置失败面全静默（冲突/畸形条目/损坏 json 无任何提示）。
- `showTerminalProgress` 运行期关闭后 OSC 9;4 进度在终端 tab 永远转；setTitle 注入面多两个扩展入口（随 R4-H1 库级兜底覆盖）。
- Python `_ANSI_ESCAPE` 正则漏 ST 结尾 OSC/DCS/C1 → 残留碎屑变可见垃圾文本；`effects.py:3071` tail 切片 decode 碎多字节字符（bash.py 有现成 helper 没用）。
- export：JS/CSS 类名分叉（`tree-custom` vs `.tree-custom-message` 死规则）；image-modal 死功能；无语言代码块全走 highlightAuto；搜索无防抖；点无对应内容的树节点静默无反馈；导出 header 用 `$`（$ vs ¥ 第三处）；**markdown 远程图片打开导出文件即自动加载（隐私泄漏，可被提示注入投放）**。
- agents-view：删除确认挂起时按 Esc 一键退出整个视图；pendingDeleteAgent 身份翻转窗口注入重复行（需按三下 ctrl+x）。
- turn-*：`firstParagraph` 的 more 判定对连续空白误报；`transferTo` 漏带 expandedAt/focusKey（压缩后全部展开行重放动画、焦点丢失）；派出行展开 detail 的 `previewIpythonCode` 未清洗；子代理名两处口径不一致致 dispatch 识别失配。
- footer/strip：`fitCount` 对非单调谓词二分（w=44 藏块+谎报「还有 2 个」）；`renderStatusBar` 降级阶梯非单调（变窄时 chip 消失后又重现、工具错误徽章先于 chip 被丢）；名字含 `": "` 的 stall 幻影 orphan 块。
- conversation-components：replay 的「重试 N 次后已中断」读 attach 当下实时计数；`QuietTurnSummary`/`QuietAssistantMessage` 每次 render 返回新 `[]`（同 Spacer 恒等记忆问题）。
- RPC/ACP：ACP 丢弃 resource.blob 与自身注释矛盾；未映射 auto_retry_start 等（退避期零提示）；RPC 白名单漏 4 个 extension UI 方法；RpcClient 收到对话框无法应答；`RpcObservedSessionEvent` 类型撒谎；ACP 不处理 closed 且传输失败 exit 0；bash_output 孤儿 tool_call_update；RpcClient.stop() 不 reject；observe 误报「Unknown active session」。
- 浮层：MenuSearchInput 的 placeholder 是死代码（焦点恒真 → 永不显示）；`showOAuthLoginSelect` 嵌套浮层失败泄漏+焦点劫持（休眠）；← 返回键覆盖面不一致（SettingsList 子菜单/OAuth/Team/Extension 选择器里 ← 是死键）。
- 存量会话：quiet 模式 compactionSummary 缺 tokensBefore → 显示「原来 NaNM tokens」。
- fixture：`row.activity`/`elapsedMs`/`formatSubagentElapsed` 生下来就死（测试却在断言其内容，制造虚假覆盖）；两处 `distinctTags` 并存，turn-box 版零测试。

## 观察项（第五轮新增）

- kitty 栈 8 种时序逐场景推演全部收平，无失衡 bug（明确不要再重查）。
- `resolveTurnHeaders` 的 shownModel 半区死逻辑；`TrayInfoLine` 的 hints 生产恒空；`daemon_hello.adopting` 死字段。
- `tl-fd-helpers.ts:50` 的时间抹除正则会把正文里任何 `12:34` 形内容抹成 HH:MM，live/replay 对比对这类内容失明。

## 五轮累计

- High ×8 + S1
- Medium ×88
- Low/观察 ×155+
- 验证方式覆盖：静态精读、tsx 探针复现、tmux 实机、Chromium 双视口实跑、真实会话文件（315 个）形状统计、git 考古。复核零误报。


---

# 第六轮（2026-10-06，12 路蜂群）

覆盖：turn-box 全文、packages/ai providers 第二轮、daemon-command 全文、core/kernel + core/mcp、extensions 剩余+示例契约、compaction 第二轮、剩余选择器/浮层、package-manager-cli 与 update 路径（tmux 实机）、文档与实现漂移、tui 基础组件二轮、启动/scripts 输出、综合复跑验证。

**复跑验证路（agent-72）：抽查前五轮 11 个条目（2 High + 9 Medium）在 HEAD `f533d98b2` 全部仍成立，零误报，引用行号零漂移。**

## High（新增 1 条）

### R6-H1. `/update` 重 launch 撞上空会话逐出竞态 → CLI 打栈崩溃甩回 shell
**位置**：`main.ts:1347-1354`（opportunistic attach 无兜底）× `interactive-mode.ts:13384-13468` × `daemon-supervisor.ts:2647-2678,3076`。
**实机复现**（tmux）：打开 TUI 不发消息直接 `/update --self` → 父进程 dispose → supervisor 逐出空会话 worker → 重 launch 子进程在 list 里仍看到旧 `activeSessionId`（逐出异步）→ attach 撞已逐出的 id → `Unknown active session` 无人兜底 → **Node 原始栈打在终端上**。第二轮（逐出已落定）正常——确认竞态。「先更新再用」恰是典型触发场景。
**修法**：by-file attach 的 `Unknown active session` 失败回落到 create 分支；或重 launch 前等逐出落定。

## Medium（新增 14 条）

- R6-M1 `stream-failure.ts:165-166`：**Bedrock 错误永不提取 HTTP 状态码**（不读 `$metadata.httpStatusCode`，同函数却读了 requestId）→ ValidationException/ResourceNotFound 等 4xx 永久错误误诊为 transient，进 15 分钟恢复等待；wave-38「模型下线回写选择」对 Bedrock 整体失效。
- R6-M2 `daemon-supervisor.ts:4607-4611`：`list` 显示的被动会话无法 rename/cron——supervisor 把选择器改写成内部全 UUID 转发，worker 不认识 → 报错还把用户输入换成看不懂的 UUID。
- R6-M3 daemon 前缀命令面（`daemon attach/open/ps/...`）整个是模块级死代码（`REMOVED_COMMAND_NAMES` 拒绝），但 usage.md/CHANGELOG/设计文档/FORK_NOTES/约 560 行测试仍当它是活的（误导性死亡）。**修正**：R2/R4 列的 daemon-command.ts 监视器内缺陷降为休眠。
- R6-M4 `injected-prompt-message.ts:191,232-238,285-289`：`ipython_state_restored` 的恢复失败事实对 owner 完全不可见，展开键是空操作——「Python 环境已恢复」但哪些变量没回来无从得知。
- R6-M5 `runner.ts:759-778`：扩展命令重名被静默改名 `name:N`（裸 `/todo` 不可达），诊断通道是死端口（`getCommandDiagnostics()` 恒空，`/extensions` 面板还在 poll 它）；git 证实 `a8a58ff26` 改行为时删了诊断生产方。
- R6-M6 `main.ts:2025` + `interactive-mode.ts:8836-8842,4218-4245`：**daemon 默认路径下扩展自定义渲染全灭**（`registerMessageRenderer`/工具 `renderCall/renderResult` 从不生效），docs/extensions.md 大篇幅教学 + 8 个示例扩展全部依赖，零提示。修法：文档注明或 daemon 协议加渲染器能力。
- R6-M7 `compaction-summary-message.ts:34,83`、`branch-summary-message.ts:41`：**展开压缩/分支摘要卡片 = 整面墙的机器 JSON 台账**（`<fact-appendix>`/`<user-requests>`/`<session-handoff>` 写给模型看的指令头+JSON-lines 原样进 Markdown；真实长会话展开后数百至上千行，叙事摘要被淹没）。修法：render 前过 `stripMachineBlocks` 或渲染人行版。
- R6-M8 `session-handoff.ts:154-164,199-216`：交接台账按 safe-label 名字入账、按真名删除 → 真名与塌空白 label 系统性不一致 → **幽灵「在途子代理」跨代永存**，每次压缩都复活并告诉模型一个早已结清的子代理还在跑（R5-M7 同根因的新消费面）。
- R6-M9 `interactive-mode.ts:13364-13468`：fork 上 `/update` 拒绝文案只在 alt screen 间隙闪过，全屏用户在会话内永远看不到「为什么拒绝」，且故意拒绝被显示成失败口吻 + 白白整机重 launch。
- R6-M10 `interactive-mode.ts:1252-1282,13383-13437`：`/update --help` 会**重启 daemon（打断全部在跑会话）并重 launch TUI**——exit 0 被一律当「更新成功」。
- R6-M11 `scripts/pack-prime-agent-release.mjs:328-337` × `utils/version-check.ts:124-137`：release manifest 的 sha256 钉在 `tarballs[]`，读取方只认顶层 → **artifact 通道永不激活**，且报错文案谎称「它没钉 sha256」。测试 mock 恰好钉住了错位。
- R6-M12 `input.ts:414-422`：**Input 的 bracketed paste 路径不剥控制字符**——ESC/OSC52/BEL/DEL 存入值并**每帧重绘原样发射**（settings 搜索框、OAuth 粘贴框、menu 搜索等 6 个消费点）。同包三条粘贴路径唯独它没跟上。测试连带：`input.test.ts:601-612` 需同步改。
- R6-M13 `prime-agent.sh:26-60`、`test.sh:41-75`：`--no-env` unset 清单停在旧 provider 名单，10 个 key 漏清（DEEPSEEK/KIMI/MOONSHOT/FIREWORKS 等）——banner 声称无 key 实际照常可用（实测实证）。修法：补清单 + drift 门钉到 `env-api-keys.ts`。
- R6-M14 `config-selector.ts:419-473`：`prime-agent config` 切换写盘失败全程静默（UI checkbox 翻转、磁盘未动、无任何提示）——`persistenceFailure` 契约（H-2）的这条消费路径没跟上。

## Low（新增约 30 条，择要）

- turn-box：步骤行/closing 行右侧比事件行多退 2 列（每个打开事件可见的错位）；spinner 行窄屏退化成单字「步」；思考只有一句时 spinner 行与 tip 行重复显示同一句；**Ctrl+O「全部展开」不开 fail 事件**（最需要看详情的行恰恰被漏）；turn 结束时键盘焦点行蒸发（Enter 变死键、下一方向键跳回首行）；pending 行对跨 turn 无名字子代理显示裸 session id。死代码：`computeBoxHeader` 整个 BoxHeader 形状生产零消费。
- providers：google `mapStopReason` 对未知 finish reason 抛错（google+vertex 全系会话把完整回答报错并空转重试）；claude-code 把 stderr 尾部（可含控制序列）拼进 errorMessage 且污染分类；bedrock 无视 `redactedContent`（gpt-5.6/6 加密推理静默消失）；vertex 缺 gemma4 分支。
- kernel/mcp：「Restart 4 of at most 3」（预算耗尽死亡的 notice 被窗口滑过后的复活消费）；`ipython_bootstrap_failed` 盒子把包裹标签原样渲染；MCP tab 徽标只认凭据存在与 isAuthed 口径分裂（enabled:false 仍显示已配置）；`flushGlobalSettings` 把更早的不相关写盘错误张冠李戴；`McpManager.listStatus()` 死 API 且是 K4 的现成修复材料。
- extensions：examples/README.md execute 参数顺序写错（照抄即崩）；5 个示例安装路径注释指向 legacy `~/.pi`（装了永不加载且无声）；`pi.events` handler 错误绕过错误边界全屏裸写 stderr；herdr 把未清洗无上限 errorMessage 发往外部 pane；`setWidget` 工厂形态 daemon/RPC 静默丢弃。
- compaction：`/tree` 分支摘要预览被英文 boilerplate 前言吃光（100 列下零内容）；折叠态 legacy 压缩卡片 focus 文案不截断（480 字符指令渲 16 行）。
- selectors：scoped-models 过滤态 reorder 后高亮跳到别的模型（后续操作作用在没碰过的模型上）；`(unsaved)` 在写盘落地前就清；config-selector 硬编码 "space"/"esc" 提示（重绑后撒谎）；theme-selector.ts 模块级死代码仍挂包根导出。
- package/update：`pi executable` 硬编码旧品牌；无法核实落盘版本时照打「Updated from vX to vY」；`/update Prime-Agent`（大写）两人口径不一整机重 launch；install-fork.sh 写 Node 20+ 但硬门槛是 22.8。
- Input 多行粘贴无分隔直接拼接（`line1line2line3` 静默改写内容）；`Input.render` width≤2 返回超宽行。
- scripts：对账门 `--session` 尾参缺值静默对**错误会话**打出「对平」（误导性绿）；对账门输出不清洗会话里的路径（验证显示真值的工具本身可被清屏）；buildId `--dirty` 精度与 status 显示语义不符。

## 文档与实现漂移（agent-69，新发现）

- D1 `docs/tui.md:87-107` 整节文档的是**不存在的 API**（`ctx.ui.custom(组件)`、`handle.requestRender()`、`pi.ui`、execute 参数顺序错）——照抄运行即 TypeError。
- D2 README/usage.md 声称「Escape 清空输入而不打断在跑的工作」——实现里 Esc 就是打断键；keybindings.md 写的才是真话。
- D3 README「Footer - Empty by default」是 U6 之前的老话；D4 tui README 两处声称超宽行「the TUI will error」从不报错（掩盖 H1 的可见性）；D5 文档承诺 `压缩在即` 实现是 `即将压缩`；D6 themes.md「There are no optional colors」为假（74 个 optional token 无从得知）；D7 terminal-setup.md 承诺的 legacy meta 形态正是 M3 的病根。
- R3-M5/R3-M6 的文档面比已知更宽（extensions.md/tui.md/README 示例一整圈）。

## 六轮累计

- High ×9（+ S1）
- Medium ×102
- Low/观察 ×185+
- 累计验证：静态精读 + tsx 探针 + tmux 实机 + Chromium 双视口 + 真实会话文件（315 个）+ git 考古 + 复跑抽查 11 条零漂移。全程零误报。


---

# 独立复核（2026-10-07，主 agent 亲手验证，不依赖蜂群结论）

方法：对 279 个唯一 `file:line` 引用做等距抽样；9 High + S1 逐条读代码核对；自写 8 个探针动态复现；4 条 CLI 实跑。全程不参考蜂群 agent 的探针输出。

## 复验结果（40+ 条抽样，零误报，行号零漂移）

**High 全量（9+1，逐条）**
- H1 静态核验：`tui.ts:2292-2296`/`2338-2341` 两处 fullRender 循环 `buffer += newLines[i]` 裸写，diff 路径 `2551-2557` 有钳制 + 日志。确认。
- H2 自写探针（fork 形态 `38;5` 色码主题）：child 缩进 **4 列**（应 2）、grandchild **10 列**（复利）；chalk.cyan 对照组 2 列（测试主题掩盖）。确认（含第三轮修正）。
- H3 自写探针：列表项内表格**零输出**（`["- item:"]`）。确认。
- S1 代码级五环全部命中：`turn-timeline.ts:517` 硬编码 running、`:692` 翻终态只设 endedAt 不关 lane、`live-turn-flow.ts:705` 无条目即丢弃、`interactive-mode.ts:7660-7680` 快照只喂 chip 条、`timeline-lane.ts:130-136` reported 是唯一关闭点。确认。
- R2-H1 静态：validator 惰性加载（`theme.ts:191-203`）、未就绪只查 colors 是对象（`:828-843`）、`fg()/bg()` 抛 `Unknown theme color`（`:550-559`）；`uncaughtException` 全仓只有 daemon 侧（daemon-mode:751、daemon-supervisor:613）注册——交互客户端进程无兜底。确认。
- R2-H2 静态：`tui.ts:1702-1703` overlay `slice(0, maxHeight)` 保顶丢底；`fgAnsi`（`theme.ts:457-470`）只产 `38;5`/`38;2`/`39m`。机制确认（31 行渲染数未独立复跑）。
- R3-H1 静态：`interactive-mode.ts:12024` 的 `applySetting(setTheme)` 在 `:12026` 的 `result.success` 检查**之前**无条件执行；`settings-manager.ts:2671-2675` setTheme 即 `save()` 写盘。确认。
- R4-H1 静态：`rlm-runtime.ts:189-204` 只 trim+限长无字符集校验；`terminal.ts:801-804` setTitle 原样 write；4 个调用点（3916/4086/4838/6930）。确认。
- R4-H2 自写探针：`ESC[2J`/`OSC52`/`BEL`/`NUL` 全部穿透 Markdown 渲染。确认。
- R6-H1 静态：`main.ts:1347-1354` opportunistic attach 无 try/catch 兜底。链路确认（竞态的动态部分未复跑，依赖第三轮的实机记录）。

**Medium/Low 抽验（自写探针，15 条全部确认）**
M1（钳制丢 reset + OSC8 不闭合）、M2（tab=0 vs tab=3 两套坐标：`visibleWidth("a\tbcdef")=9`，`sliceByColumn(0,4)="a\tbcd"`）、M5（login-dialog 194/223 两处无条件 addChild）、M12（`\quad`→`"a b"`）、M14（configuredPaddingX 构造固化 vs setPaddingX 改基类字段）、L2（截断在 OSC8 内不闭合）、L3（wrap("你好",1)→4 行宽 0,2,0,2）、R2-M17（宽度数学 `width-20+C`，C=26→+6）、R2-M18（`$` 硬编码在 `formatCost`）、R4-M8（showError 无清洗）、R4-L1（Spacer 击穿恒等记忆，对照组通过）、R5-M1（kitty CSI-u `RangeError: Invalid code point 1114112` 实崩）、R5-M3（bulk 含 `\r` 切出独立序列且 `matchesKey("\r","enter")=true`）、R5-M4（`{cc}`/`{2}` 泄漏为可见文字）、R6-M12（Input paste 存值+渲染双穿透，多行静默拼接 `line1line2line3`，render(1) 超宽）。

**CLI 实跑（4 条全部确认）**
- R2-M5：`--version </dev/null` stdout **0 字节**/stderr 8 字节；`--help </dev/null` stdout 0/stderr 4079；`help </dev/null` stdout 4079——同一内容两条流，实锤。
- R2-M6：`--help list` → `Error: Unknown command: list / Did you mean "prime-agent list"?`，真实 exit=1。实锤。
- R2-M7：本机实测 `status` 最长行 **240 列**（80 列终端 3 倍）。实锤。
- R6-M13：`MOONSHOT_API_KEY=sk-fake ./prime-agent.sh --no-env model list` 照常列出 8 行 moonshot 模型（对照组 0）；10 个漏清 key 逐一核对全部确实缺失于 prime-agent.sh。实锤。

## 复核发现的三处小出入（不影响结论）

1. **R2-M7 的数字漂移**：文档写「245-312 列」，独立实测 240（第三轮 agent 实测 top3 240/235/235 与我一致，第二轮的 245-312 是当时的 socket 数状态）。核心结论（无宽度处理）不变；修复者以「≥240、随 socket 数浮动」理解即可。
2. **累计计数口径**：文档「Medium ×102」，实际唯一编号 114 个（含正文交叉引用的重复提及）——差异来自计数口径，建议读作「约 100+」。
3. **R6-H1 的证据等级**：该条的动态竞态复现只有第三轮蜂群的一次 tmux 记录，本次独立复核只静态验证了无兜底链路——是全部 High 里唯一非双源验证的条目，修复前建议先按文档修法（attach 失败回落 create）加防御，无论竞态细节如何该兜底都是对的。

## 结论

抽样覆盖 High 全量 + Medium 的 15 条 + Low 4 条 + CLI 4 条（占最有修复价值的条目约三分之一），**未发现一条误报**；行号引用在 HEAD 上零漂移；三条声称「探针实证」的条目全部用独立探针复现成功。审计文档可直接作为修复依据。
