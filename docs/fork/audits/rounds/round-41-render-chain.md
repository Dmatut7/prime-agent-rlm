# r41 终审 · 流式渲染链（帧扫描 bound + 节流 + 增量 lex 三层叠加）

范围：`b7f26e98b..HEAD`（HEAD=eb0825e63），关键提交 `84d3b31e9`(帧扫描 bound/lineResetCache)、`33eb05dff`(增量 lex)、`f04078fa8`(paste filter)。
只读审计：仓库零写入；所有探针/临时物在 `/tmp/audit_r/round-41/render-chain-work/`（仓外 tsx 脚本，用仓自己的 node 跑）。
行号一律对 HEAD=eb0825e63。

## 结论（一句话）

**三层叠加后单帧最坏复杂度不是 O(可见行)：增量 lex 只把「词法」压到 O(tail)，而 `Markdown.render()` 每帧仍按块构造 `width|type|nextType|token.raw` 缓存键（复制+哈希全文每个顶层块的 raw，实测占单帧 40%~50%）＋全文正则归一化＋全量行数组复制，`TUI.doRender()` 另有两次全量数组快照，所以实测单帧成本随文档线性增长（200k/800k/1.6M → 1.24/6.04/12.82 ms；仓内测试的绝对阈值 20ms 因此恒真）。** 正确性层面：词法增量复用没有找到反例（8,160 组边界样本 + 400 组随机流式 1 字符差分，正控可检出破坏），但 **`blockCache` 的键漏掉了渲染期全局能力（`getCapabilities().hyperlinks`），能力翻转后同一 Markdown 实例会持续输出陈旧块，且该陈旧块因返回同一数组/字符串而被 `doRender` 的指针快路径（tui.ts:1725）静默跳过、differ 永远看不到**（已实测复现）。

---

## F1 · P1 · Q2：单帧成本仍随全文线性增长，「每帧 O(可见行)」不成立

- `packages/tui/src/components/markdown.ts:401`（提交 33eb05dff）逐块构造缓存键：
  `const key = useCache ? \`${width}|${token.type}|${nextTokenType ?? ""}|${token.raw}\` : "";`
  即使命中缓存也必须先构造这个键：**每帧把每个顶层块的 raw 拷进一个新字符串并重新哈希**（`nextCache.get(key)`/`this.blockCache.get(key)`），即 O(全文字节)。
- `markdown.ts:380` 每帧全文两次正则替换：`text.replace(/\t/g,"   ").replace(/\r\n|\r/g,"\n")`。
- `markdown.ts:421` 每帧全量拼接：`const markedResult = [...emptyLines, ...contentLines, ...emptyLines];`
- `packages/tui/src/selection-metadata.ts:70`（`extractTableCellSelectionRegions`）每帧 `lines.some((line) => line.includes(TABLE_MARKER_PREFIX))` 扫全部行。
- `packages/tui/src/tui.ts:1700` `let newLines = [...this.render(width)]` 与 `:1712` `const rawLines = newLines.slice();`：每帧两次 O(transcript 行数) 数组复制。

实测（`/tmp/audit_r/round-41/render-chain-work/scale.ts`、`keycost.ts`、`normcost.ts`，同一 800k/1.6M 分区文档、每帧只追加 250 字符）：

```
docLen=200200  lines=7501  incrementalTailFrameMs=1.239
docLen=800250  lines=30412 incrementalTailFrameMs=6.040
docLen=1600500 lines=60967 incrementalTailFrameMs=12.815        # 文档 x8 -> 单帧 x10，线性
# 每帧 blockCache 键构造+查找（markdown.ts:401 逐字复现）
docLen=200200  blocks=3276  keyBuildAndLookupMs=0.642
docLen=800250  blocks=13095 keyBuildAndLookupMs=2.413
docLen=1600500 blocks=26190 keyBuildAndLookupMs=4.834          # 占单帧 46%~52%
# 对照：全文归一化 replace 只 0.341ms(800k)，selection 扫描 0.450ms(29101 行)
normalizeOnlyMs=0.341 incrementalFrameMs=4.317 freshComponentFrameMs=33.920   # 增量比全量快 7.9x，形状不变
```
整帧路径实测（`measure.ts`：`TUI`+`VirtualTerminal`，viewport 贴底）：
```
N=20050  mode=tail     medianFrameMs=22.227 | mode=top medianFrameMs=183.273 | mode=steady=22.475
N=100000 mode=tail     medianFrameMs=21.906 | mode=top medianFrameMs=928.493 | mode=steady=22.065
```
- 尾部 tick 与 steady 与 N 无关（22ms 为 harness 写 xterm 的固定底噪），说明 84d3b31e9 的快路径对「尾部变化」有效；
- **「首变更在视口上方」路径随 N 线性劣化（183ms→928ms，N x5 → 时间 x5.1）**，该路径落 `fullRender(true)`（tui.ts:1976-1981）全量重绘；
- 结论：单帧最坏复杂度仍是 O(transcript/全文)。打穿输入=长会话里改了 transcript 顶部（例如 compaction 重写/工具结果回填到早期行）每帧 183ms~928ms 的主线程占用。

**新增测试为什么不拦它**：`test/markdown-incremental-lex.test.ts` 的成本用例只断言「相对比值 `sectionedMs*3 < singleMs`」＋「绝对 `< 20ms`」。6.04ms 满足 20ms，线性增长也满足比值，因此该测试名（"bounded by the lex cache, not the document"）比它实际钉住的性质强得多。

## F2 · P1 · Q1/Q4：blockCache 键漏掉渲染期全局能力 → 陈旧块被指针快路径静默吞掉（有复现）

- 键（markdown.ts:401）只含 `width|type|nextType|raw`；而同一块的渲染还依赖 `markdown.ts:745` 的 `getCapabilities().hyperlinks`（决定 OSC 8 超链接 vs `text (url)` 退化形）。
- `invalidate()`（markdown.ts:320-330）清 `blockCache` 是为 theme 变化准备的；**能力变化没有对应清理路径**（`setCapabilities`/`resetCapabilitiesCache` 是 `packages/tui/src/terminal-image.ts:111,116` 导出的公开 API，`packages/tui/src/index.ts:116-117` 再导出，注释写明 "Useful in tests to exercise both code paths"；全仓 grep 无 production 调用者 —— 即在本次扫描范围内未见仓库自身的调用点）。
- 复现（`capflip.ts`，真实模块、公开 API）：
```
caps at start: {"images":null,"trueColor":false,"hyperlinks":false}
incremental md (blockCache kept): osc8 = false | fresh component: osc8 = true
--- incremental line --- " see \u001b[34m\u001b[4mx\u001b[24m\u001b[39m\u001b[2m (http://example.com/page)\u001b[22m here"
--- fresh line ---       " see \u001b]8;;http://example.com/page\u001b\\\u001b[34m\u001b[4mx...\u001b]8;;\u001b\\ here"
```
  即：`setCapabilities({...caps, hyperlinks:true})` 之后，**同一个 Markdown 实例**在流式追加（链接块 raw 未变、末块变化）下永远输出「无 OSC 8」的旧渲染；`new Markdown(同一文本)` 立刻输出 OSC 8（正控：证明探针能检出 OSC 8，能力翻转确实生效）。
- 与第二层叠加（新雷）：陈旧块的 lines 是同一个数组/同一批字符串，`tui.ts:1725 while (firstRawDiff < rawCommon && newLines[i] === this.previousRawLines[i])` 会把它当「未变前缀」直接复用上一帧已提交的归一化行（`tui.ts:1728-1730`），differ（`tui.ts:1880` 起）也从 `firstRawDiff` 之后才开始比 —— **屏幕上的陈旧渲染不会被任何后续帧自我纠正**，直到该块 raw 恰好变化或有人 `invalidate()`。
- 严重度判定：P1（渲染正确性、静默、不可自愈），前提是运行期发生能力翻转；本仓未见调用点，因此实际触发需要外部宿主/未来代码调用该公开 API。同类隐患：任何「渲染期状态不在键里」的变化都同病（theme 靠 `invalidate()` 约定覆盖，能力没有约定）。

## F3 · P3 · Q1：文档注释声称的边界条件比实现强（`paragraph/text` 从未被检查）

- `markdown.ts:344` 的 `lex()` 契约注释写：「the token before the cut is not paragraph/text (computeLexCut), so no tail construct can merge into a reused token」。
- 实现 `markdown.ts:189-206`（`isStableLexBoundary`）只排除了 `list` 与 `html`：`markdown.ts:202 return type !== "list" && type !== "html";`。真正拦住 paragraph/text 的是 `cut<2 || text[cut-2]!=="\n" || text[cut-1]!=="\n"` 与「tail 首字符非空白」两条字符级检查（:196-200）。
- 是否活的 bug：**在本次扫描范围内未见**（差分 8,160 + 400 组无反例，见 F6）。但注释与代码不符会让后来者误以为有类型级保险。
- 正控（证明 `list`/`html` 排除是承重的、也证明差分探针能抓到坏实现）：把 `isStableLexBoundary` 改成 `return true;`（接受一切 token 起点）后，同一差分探针立刻报错（`poscontrol2.ts`）：
```
docs: 99
NAIVE (all boundaries accepted) mismatches: 1
REAL mismatches: 0
NAIVE first divergence at k=10 doc="- a\n\n    - nested\n- top\n"
GOT :  " \x1b[36m- \x1b[39ma  ...  \x1b[32m-\x1b[39m"      (绿色 space 样式，列表延续丢失)
WANT:  " \x1b[36m- \x1b[39ma  ...  \x1b[36m- \x1b[39m"
```

## F4 · P3 · Q3：四处 cache 的「清理策略」并不一致，但各自与其键空间自洽（无本层 bug）

| cache | 提交 | 清理策略 | 键空间是否自洽 |
|---|---|---|---|
| `TUI.lineResetCache` | 84d3b31e9 | 20k 上限逐出最旧，**永不清空**（tui.ts:1436-1471） | 自洽：键=输出行本身（含依宽度重排的内容），且 `utils.ts:305 normalizeTerminalOutput` 是纯函数（只依赖入参 str，无全局态）→ 不需要清空 |
| `Markdown.blockCache` | 33eb05dff | 每帧整体替换 `this.blockCache = nextCache`（markdown.ts:411）＋ `invalidate()` 全清（:327） | **不自洽**：键是输入（块 raw），漏了 `getCapabilities()`（见 F2） |
| `Markdown.lexCache` | 33eb05dff | `setText()` 不碰（:310-318）、`invalidate()` 也不碰（:320-330） | 与注释一致（token 不依赖主题），但唯一失效闸是 `normalizedText.startsWith(cache.prefix)`（:346）＋ tail links 探测（:348）；也就是说**它把「失效正确性」全部押在 34 字符级启发式边界上** |
| `Editor.wrapCache` | 早于本批 | 签名变（宽度/pasteId 集合）时**全清** `editor.ts:411-415`，容量满时逐出 `:434-437` | 自洽 |
- 提交 84d3b31e9 的 commit message 说新策略「mirroring the editor wrapCache pattern」，但 editor 的形态其实是「键空间变则全清、溢出才逐出」，而 `lineResetCache` 是「永不全清」。效果上两者都对，表述不准确 —— 记录以免后来者据此把 `lineResetCache` 也改成签名全清（那正是 84d3b31e9 修掉的 thrash）。

## F5 · P2 · Q4：新测试钉住了「渲染等价 + 写出字节数」，没钉住「每帧计算量」，且都不覆盖生产选项 `transform`

- `test/markdown-incremental-lex.test.ts:79-108` 是**真命题**：每帧与「新建组件全量重渲染」逐字比对（`assert.strictEqual(got, want)`），不是恒真断言；宽度切换例（:110-125）覆盖了 `render(width)` 换宽。
- 缺口 1（成本面）：成本用例只测相对比值＋ `< 20ms` 绝对阈值（见 F1 数据），因此**通过但线上仍坏**的具体场景 = 长会话下文档线性变长：200k→0.34…1.24ms、800k→6.04ms、1.6M→12.82ms，全部 <20ms、比值也满足，但单帧占用已回到毫秒级且继续线性涨；再叠加 F1 顶部变更路径（N=100k 时 928ms/帧）时就是可感知卡顿。
- 缺口 2（配置面）：成本/等价测试用的都是 `new Markdown(text,1,0,theme)`，**没有 `options.transform`**；而生产的助手消息块一定带 transform（`packages/coding-agent/src/modes/interactive/components/assistant-message.ts:307-311`，mermaid transform 依赖 `availableWidth` 与 `isStreaming`）。transform 在 `markdown.ts:362` 每次 cache miss 都对**全文**执行，所以「streaming append frame cost is bounded by the lex cache」在生产配置下不成立 —— 这一配置差异没有任何新测试覆盖。
- 缺口 3（结构面）：`test/tui-large-transcript.test.ts` 三个用例只断言写出字节数（`bytes < 300`）与视口内容正确，不断言任何**帧时间/扫描范围**；且所有假组件的 `render()` 在内容不变时返回**同一个数组**（`StaticLinesComponent.lines`，:21-27），即指针快路径的成立前提由测试自己保证。**通过但线上仍坏的具体场景**：任何「每帧返回内容相同但数组新对象」的组件（例如在 render 里 `return [...lines]`）会让 `firstRawDiff` 退化为 0 → 每帧重跑全文归一化 + 全量 differ 扫描，而这三个用例照样全绿（它们测的是字节数与视口，不是扫描范围）。

## F0 · 基线：两个新测试文件本身是绿的（本席用仓自己的 runner 复跑）

```
cd packages/tui && node --test --import tsx test/markdown-incremental-lex.test.ts test/tui-large-transcript.test.ts
# tests 7 / pass 7 / fail 0 / skipped 0   (duration_ms 1992)
```
所以下面的发现都不是「测试红」而是「测试钉的命题弱于提交声明」。

## F6 · 反向结论（Q1 的增量 lex 复用本身）：在本次扫描范围内未找到反例

- 检法：`lexfuzz.ts`（400 篇随机文档，含 html 块/`<pre>` 未闭合、列表与缩进延续、表格、围栏/未闭合围栏、`$$`行间公式与未闭合 `\[`、引用定义与后置定义、lazy 延续、tab/CRLF、setext/thematic break…；多数文档按 **1 字符** 步进流式，逐帧与新建组件全量 lex 的渲染逐字比对）：`docs checked(stream): 400 mismatches: 0`。
- 定向边界穷举 `boundaryfuzz.ts`：31 前缀 × 33 后缀 × 3 分隔符 × 2 宽度，每例逐字符流式：`cases: 8160 bad: 0`。
- 正控（证明上述探针确实能检出坏实现）：`poscontrol2.ts` 把边界判据替换为「接受一切 token 起点」后**立刻**报出反例（见 F3），`NAIVE mismatches: 1 / REAL mismatches: 0`。
- 被问到的三个具体担心，逐条回答：
  1. **代码围栏状态是否跨块携带**：不会。cut 只落在「前一个 token 结束处」且其前必须紧邻 `\n\n`；围栏所在块要么整体留在复用前缀里，要么整体落在 tail 里被从头重 lex（tail 从 cut 处切出、用与全量 lex 同一个 parser 选择 `pickMarkdownParser(normalizedText)`，markdown.ts:347）。` ```\nunterminated fence` 与 `\n\n` 后再起围栏两类样本都在 8,160 例内且无反例。
  2. **列表/表格延续**：正是 `list`/`html` 排除与「tail 首字符非空白」在挡；去掉该排除即坏（F3 正控）。表格由 `markdown.ts:202` 之外的字符级 `\n\n` 检查覆盖（表格不能跨空行延续），样本内无反例。
  3. **失效漏判会怎样**：`startsWith(prefix)`（:346）是内容比较，前缀改了就必然全量重 lex —— 历史消息被 compact/重写、resize 触发 reflow、主题变化都只可能通过 (a) 前缀变化 → 全量，或 (b) 前缀不变 → 复用仍然正确。**但**：主题变化被 `invalidate()` 覆盖（清 blockCache），能力变化没有（F2）——这是本链上唯一被证实的「一处优化破坏另一处正确性前提」。
- 节流与 lex 偏移是否脱钩（Q2 后半）：不会。`lexCache` 只在 `render()` 里由**当帧的 normalizedText** 重建（:344-357），`setText()` 从不写它；被节流丢掉的帧只是把「上一帧已 lex 到的 offset」停在上次**真正渲染过**的文本上，下一帧按当前文本重新算 tail，因此既不重复 lex 同一段也不漏 lex。唯一理论风险是「渲染了 A 帧却把 B 帧的 offset 记成基准」，代码里不存在该次序（`lastRenderAt` 只在 doRender 完成后盖章，tui.ts:714/929，与 lex 状态无关）→ 本次扫描未见脱钩证据。

---

## 未验证项

1. F2 的能力翻转在真实会话里是否会自然发生：仓库内无 `setCapabilities`/`resetCapabilitiesCache` 调用点（grep 证据），因此「生产触发」未验证；已验证的是机制（同一实例陈旧 / 新实例正确）。
2. compaction 重写历史消息的端到端路径：只验证了机制（前缀变化 → 全量重 lex），没有跑真实 compaction 会话；助手块在 `assistant-message.ts:256-283` 的 reconcile 里走 `setText`，结构性变化走 `rebuild()` 新建实例（lex cache 从头开始），未在活会话中观测。
3. 800k 文档单帧 6.04ms 的完整分解：已量化归一化 0.341ms、selection 扫描 0.450ms、blockCache 键 2.413ms，剩余约 2.8ms 未逐项归因（推测为 `renderBlock` 的 wrap/pad＋两个全量数组复制），未做隔离测量。
4. `f04078fa8` paste filter：逐字读过，改写与旧的 `split("").filter(c).join("")` 语义等价（保留 `\n` 与 `code>=32`，含 DEL=127 同样保留），未发现与本链的交互缺陷；未做 8MB 粘贴的性能复现（与本链无关）。
