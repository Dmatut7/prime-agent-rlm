# r33 扫描——TUI 渲染内部路径（tui-render-internal）

- 日期：2026-09-16 · 冻结 HEAD：`07fc6abe1`（`git rev-parse --short HEAD` 实测；工作区另有他席未提交文件，本线零写入）
- 范围：packages/tui/src + packages/coding-agent/src/modes/interactive（只读，零仓库写入）
- 方法：源码通读 + 5 个基准脚本（`/tmp/audit_r/round-33/bench-frame.ts`、`bench2.ts`、`bench3.ts`、`bench4.ts`、`bench5.ts`，tsx 直跑 src，MiniTerminal 假终端记录写流量）+ 仓自带 `packages/tui/test/markdown-streaming-bench.ts`。测的是 JS 侧成本（不含终端模拟器消化时间）；单机数据。
- 与 docs/fork/audits/decisions.jsonl（269 条）对账：本线 8 条结论全部为新增面；最近邻 ADV-3（粘贴内 kitty 字节走键盘通路，已修 70a4f18b4）与 F-3（粘贴每字符过滤的 CPU/内存形态）不同轴；PERF-UI（attach 首帧 650ms/RSS+500MB，r17 已修 daemon 侧二次序列化）不覆盖 F-4（TUI 侧首帧全量写出）；PERF-TREE/LAT-1/LAT-2 均为 daemon/agent 侧，非 TUI 帧路径。

## ① 帧渲染：每帧做什么、成本曲线

**命题 FR-1（P2）**：流式期间每帧成本是 O(全转录大小)，不是 O(变更)。一帧固定执行 6 个全转录扫描步骤 + 1 个 O(变更) 写出。

逐字证据（packages/tui/src/tui.ts，每帧路径 doRender）：
- tui.ts:1639 `let newLines = [...this.render(width)];`（外层数组全拷贝）
- tui.ts:1791-1802 diff 循环 `const maxLines = Math.max(newLines.length, this.previousLines.length); for (let i = 0; i < maxLines; i++) { ... if (oldLine !== newLine)`（全行字符串比较）
- tui.ts:1422-1436 `applyLineResets`：`for (let i = 0; i < lines.length; i++) { ... const cached = cache.get(line);`（全行 Map 哈希查找，miss 走 `normalizeTerminalOutput(line) + reset` 正则+串接）
- tui.ts:1440-1447 `collectKittyImageIds(newLines)` 于 tui.ts:2028 在每帧 diff 路径末尾调用（全行 `line.indexOf("\x1b_G")` 扫描）
- tui.ts:1460-1464 `expandLastChangedForKittyImages`：`for (let i = firstChanged; i < this.previousLines.length; i++)`（从变更点到转录末尾全扫）
- 流式 markdown：markdown.ts:255 `const tokens = pickMarkdownParser(normalizedText).lexer(normalizedText);` —— setText 后每次 render **全文重新 lex**；blockCache（markdown.ts:265-281）只省块级 re-render/re-wrap，键 `\`${width}|${token.type}|${nextTokenType}|${token.raw}\``（markdown.ts:271）本身含全文 raw，每帧对每块重拼键串 O(raw)。流式时该 re-lex 是帧成本主项（100k 字符时约 1.87/2.67ms）。

实测成本曲线（bench-frame.ts / bench4.ts，width=100 height=40，流式追加 512 字符/更新，唯一内容语料）：

| 转录字符 | 渲染行数 | 帧均值(mid) | 帧尾段(last20) |
|---|---|---|---|
| 100k | 2 501 | 2.34ms | 3.59ms |
| 200k | 5 003 | 3.76ms | 8.64ms |
| 400k | 10 007 | 7.44ms | 15.15ms |
| 800k | 20 015 | 16.99ms | 34.41ms |

（重复内容语料 bench-frame.ts：10k=0.47 / 50k=1.40 / 100k=2.67 p99 4.79 / 200k=4.85 p99 9.59ms —— 真实唯一内容更贵。）

写出侧是真 diff：每帧写字节 p50=394B（64 字符 chunk），只写变更行——**写路径没问题，问题在读路径**。

节流器：tui.ts:369 `MIN_RENDER_INTERVAL_MS = 16`（62fps 上限），但 tui.ts:899-909 `this.lastRenderAt = performance.now(); this.doRender();`——lastRenderAt 在渲染**前**打点，帧耗时 >16ms 时 `delay = max(0, 16-elapsed)` 恒为 0，**慢帧无任何上限连发**。与 FR-1 叠加：转录 >~0.4M 字符后渲染自持满核（800k 时 17-34ms/帧 × 1000/帧耗 ≈ 100% 单核），期间 stdin 键击排队，最长等一个帧长。

影响：老板体感面 = 长回答（100k 字符）流式期间约 17% 核（2.7ms×62fps）尚可，但长会话（多消息累计 0.4M+ 字符）继续流式即满核+输入迟滞。可打穿输入：让模型输出一个 500k 字符回答（或 attach 大会话后继续对话）。
可复现：`cd packages/tui && npx tsx /tmp/audit_r/round-33/bench4.ts`（E2 段）。
confidence：高（双语料两次实测 + 代码路径逐行对账）。

## ④ 内存 + ② 的孪生：lineResetCache 20k 全清抖动

**命题 FR-2（P2）**：渲染行数超 ~20k（唯一行内容超 LINE_RESET_CACHE_LIMIT=20 000）后，lineResetCache 进入每帧「填满 20k→clear() 全清→重填」抖动：每帧最多 2 万次字符串重分配 + 正则 + 因缓存击穿导致的全文内容比较（丢掉身份快路径，tui.ts:1411-1415 注释自认身份比较是 diff 的设计快路径）。

逐字证据：tui.ts:1416 `private static readonly LINE_RESET_CACHE_LIMIT = 20_000;` · tui.ts:1431-1433 `if (cache.size >= TUI.LINE_RESET_CACHE_LIMIT) { cache.clear(); }`（全清，非 LRU/淘汰最旧；对照 editor.ts:402-405 的 wrapCache 是真 LRU 淘汰）。

实测（bench4.ts H 段，8M 字符唯一内容 = 200 161 行）：**空闲态 loader 转动（loader.ts:25 默认 80ms/帧）每帧 35.88ms**，即不动鼠标不流式、纯 spinner 动画烧 ~45% 单核；resetCache 逐帧在 1 547→19 843 间锯齿振荡（每帧命中上限被全清）。对照正控（bench4.ts F2 段，50 041 行、12 527 个唯一键 < 20k，未进抖动区）：同场景每帧仅 5.99ms（p99 9.02ms）——**成本差 6 倍来自缓存全清本身**，不是行数线性项。

影响：长会话（唯一行内容 >20k ≈ 累计 0.8-1M 字符）空闲时 CPU 45% 且持续；这正是「开着 prime-agent 不动也烫」的形态之一。可打穿输入：attach/累计到 >20k 渲染行 + 任何 loader（bash 执行、agent 工作中）。
可复现：`npx tsx /tmp/audit_r/round-33/bench4.ts`（H 段输出 resetCache 振荡序列）。
confidence：高（振荡序列逐帧记录在案）。

## ② 粘贴与输入

**命题 FR-3（P3）**：大粘贴的 stdin 分块/静默窗（stdin-buffer.ts）设计良好，但 editor.handlePaste 的每字符过滤在大粘贴上是单点主线程冻结 + 堆尖峰。

逐字证据：
- 分块/静默窗（好，ADV-3 修复后无残余冲突）：stdin-buffer.ts:310-322 `PASTE_TIMEOUT_MS = 30_000 / PASTE_MAX_BYTES = 8*1024*1024 / PASTE_SETTLE_MS = 20`；stdin-buffer.ts:518-528 settle/超限 flushPastePart 保持 paste mode 不把余量漏进键路径；Ctrl+C 逃生口 stdin-buffer.ts:432-441。terminal.ts:268-271 re-wrap 整段一次投递。
- 每字符过滤（贵）：editor.ts:1314-1317 `const filteredText = cleanText.split("").filter((char) => char === "\n" || char.charCodeAt(0) >= 32).join("");`

实测（bench2.ts D 段，`"a".repeat(n)`）：
| 粘贴大小 | split+filter+join | split 数组堆峰值 |
|---|---|---|
| 1MB | 17.2ms | +9.0MB（+1 048 576 元素） |
| 8MB（=PASTE_MAX_BYTES 单段上限） | 157.0ms | +71.9MB（+8 388 608 元素），heapUsed +217.4MB（GC 前） |

8MB 粘贴 = 一次 157ms 主线程冻结 + ~72-217MB 瞬时分配。另外 handlePaste 全链路最多 4 份全文活拷贝（pastedText→decodedText(CSI-u 命中时)→cleanText(含 tab 时)→filteredText，editor.ts:1305-1317），8MB 时 ~32MB 常驻到提交。`pastes` Map（editor.ts:1337）提交时清（editor.ts:1395），无泄漏。
可打穿输入：`head -c 6m /dev/urandom | base64 | pbcopy` 后粘贴进输入框。
可复现：`npx tsx /tmp/audit_r/round-33/bench2.ts`（D 段）。
confidence：高。severity P3（8MB 粘贴罕见；1MB 无感）。

输入（击键）路径顺带核查：insertCharacter 每键 `this.onChange(this.getText())`（editor.ts:1264-1266）全文 join + interactive-mode.ts:4345-4353 每键 snapshotPromptStash（getPromptStashImages 正则全文扫）——O(草稿长) 每键，10 万字符草稿下 ~0.2-0.5ms/键，可感但非主痛点；wrapCache 是逐行 LRU（editor.ts:399-406），打字只重排当前行，无问题。

## ③ 滚动历史

**命题 FR-4（负结论，P4）**：历史查看无全量重载路径，成本可忽略——但正控在案。

- inline 模式（默认）：滚动 = 终端原生 scrollback，应用侧零工作。正控：mouse tracking 仅 fullscreen 开启（tui.ts:600-611 syncFullscreenMouseTracking 只在 fullscreen 分支被 renderFullscreen/doRender 调用，tui.ts:1561-1609；inline 无滚轮回调注册）。
- fullscreen 模式：composeFrame 只切窗口（fullscreen.ts:123 `const window = transcript.slice(this.scrollTop, this.scrollTop + windowHeight);`），paint 是行级 diff（fullscreen.ts:656-662 `if (this.prevFrame[row] === line) continue;`）。实测（bench5.ts，48 000 行转录，2000 次 3 行滚动）：**0.055ms/事件，~4.5KB/事件**。
- 无按需加载：转录全量驻留内存（组件+行数组），但有界（见 FR-6）。
confidence：高（正控=实测滚动管线本体）。

## ⑤ 首帧/attach 与 resize/中断

**命题 FR-5（P3）**：首帧（attach/resume/会话树导航）一次性把**整个**转录同步写进终端（fullRender(false) renderStart=0），单帧毫秒数与写量随转录字节线性。

逐字证据：tui.ts:1718 `const renderStart = clear && this.previousLines.length > 0 ? Math.max(0, newLines.length - height) : 0;` + tui.ts:1757-1760 首帧走 `fullRender(false)`（clear=false ⇒ renderStart=0 ⇒ 全量）。
实测（bench2.ts A 段）：2M 字符转录→118ms/8.5MB 单次 write；4M→180ms/17MB；8M→409ms/34MB。
组件树上限是 800 个（interactive-mode.ts:598 `LIVE_CHAT_COMPONENT_LIMIT = 800`，interactive-mode.ts:5952-5954 settle 点触发 enforceChatComponentCap 重建，a526eb6f0 已落），消息窗 400（interactive-mode.ts:594）——**限的是条数不是字节**：400 条含大工具输出的消息仍可打出几十 MB 单帧。PERF-UI（r17）修掉的是 attach 的 daemon 侧二次序列化与 RSS 不回收；TUI 侧单帧全量写出仍在。
影响：attach 大会话时主线程 ~0.4s 停顿 + 34MB 一次性灌 pty（终端模拟器消化更久）。可打穿输入：`prime-agent --resume` 一个长会话。
confidence：高。

**命题 FR-6（正结论，P4）**：渲染内存有界，无只增不减的渲染缓存。
- 组件树：800 组件上限（上述），超限重建（clearChat）后 previousLines 换新数组、旧串可回收；
- lineResetCache 20k 上限（有 FR-2 的抖动代价但内存有界）；
- markdown blockCache 按当前文档块重建（markdown.ts:196-197 注释自认 bounded）；
- editor wrapCache LRU（editor.ts:402-405）、pastes Map 提交即清（editor.ts:1395）、undoStack 定长（undo-stack.ts）。
实测（bench2.ts B 段）：流式 200k 字符后 heap +2.0MB / rss +27.5MB / resetCache 333 项 / blockCache 9 项。
confidence：高（有内存数字 + 各上限逐一定位）。

**命题 FR-7（P4，resize 一致性）**：width/height 变化都只重绘可视窗口且帧内容一致——一致；已知固有残留 = scrollback 上方旧宽度折行不重排（inline 模式设计自认）。
证据与实测：tui.ts:1763-1768 widthChanged→fullRender(true)（renderStart=newLines.length-height，只写最后 height 行 + `\x1b[2J\x1b[H` 清屏保 scrollback，tui.ts:1723）；heightChanged 同（tui.ts:1770-1777）。实测（bench2.ts C 段，200k 字符流式中途）：width 100→120 = 9.0ms/写 5 694B（9ms 里大头是 markdown 全块按新宽度 re-wrap，blockCache 键含 width 一次性全失效——一次性行为）；height 40→30 = 0.6ms/写 4 283B。整帧包在 `\x1b[?2026h...l` 同步输出里（tui.ts:1655/1729），无撕裂。残留：tui.ts:1651-1652 注释逐字「Do not clear terminal scrollback: users rely on it to read long prior messages.」——resize 后往上滚看到的仍是旧宽度折行；Termux 特例（tui.ts:1773 `heightChanged && !isTermuxSession()` 跳过 fullRender）走 diff 路径用新 height 混旧 bookkeeping，单帧光标可能错位（代码证据，未实测，Termux-only）。
confidence：resize 主结论高（实测）；Termux 子项低-中（仅代码）。

中断一致性：Ctrl+C/Escape 中断在 agent_end 把 streamingComponent 以最终消息落定（interactive-mode.ts:5792-5800 `updateContent(this.streamingMessage, false)`），AssistantMessageComponent 签名含 `stop:${message.stopReason}`（assistant-message.ts:250）⇒ aborted 触发一次 rebuild + 一次 clearOnShrink/首块重排，走既有全帧 diff——无撕裂路径（同步输出包裹）；`requestRender(force)` 重置 previousWidth=-1 触发全清重绘（tui.ts:680-702）。未发现中断专属渲染错乱路径（负结论，正控=5792-5800 + 签名机制读码定位；无 Termux/野生终端实测）。

**命题 FR-8（负结论+正控，P4）**：markdown 单块行数不受 spread 栈限制——2.8MB 无空行单段落 @width 40 渲出 80 000 行，`contentLines.push(...blockLines)`（markdown.ts:279）未抛 RangeError（228ms 完成）。正控即该实测本身。
confidence：高（本机 V8 22.22 实测；老 V8/其它引擎不保证，故仅记 P4）。

## 结论与建议（供裁决，本线只读未改代码）

1. FR-2 是最划算的修复点：lineResetCache 全清→按行淘汰（LRU 同 wrapCache）或直接调大上限 + 分段清理，长会话空闲 CPU 从 45% 回到 ~7%。
2. FR-1 修法方向（大工程，非本线职责）：diff 循环与 applyLineResets/collectKittyImageIds 都可只扫「底部 height 行 + 追加段」（变更只发生在尾部时）；markdown 全文 re-lex 需要增量 lexer 才能根治。
3. FR-3 一行换法：`for` 循环 + codePoint 检查替代 split("").filter().join("")，或先 `indexOf` 探测控制字符再整段放行（常见粘贴零控制字符时可 O(1) 放行）。
4. FR-5 可选：首帧分批（chunked write）或 attach 时先可视窗后增量回放。
心跳与基准脚本：/tmp/audit_r/round-33/（tui-render-internal-heartbeat.md、bench-frame.ts、bench2-5.ts）。
