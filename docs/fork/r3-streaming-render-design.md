# R3 流式渲染放大 · wave-51 设计稿

日期 2026-10-04 · 只读设计，未改仓库 · 读者：实施 lane

## 0. 编号溯源与前提校正

R1–R4 出自 `docs/fork/streaming-resend-design.md`(wave-20 W20-E,HEAD=342cd3ca2),backlog #9 即 `docs/fork/evolution-ledger.md:71` 的文档-3。当前状态：

- **R1**(legacy 客户端腿）已修：`daemon-command.ts:1318-1323` `MONITOR_ATTACH_CAPABILITIES` 声明了 `streaming_deltas`+`streaming_delta_fragments`。**1.14GB 是 wave-10 实测的 wire 侧放大，属 R1 旧账，已结案。** 任务书把它与渲染腿合并叙述；本稿处理的是 **R3 渲染腿，计量单位是 CPU 秒/帧毫秒，不是字节**。
- **R2**（半新客户端腿）：协议地板，不动。
- **R3**（渲染腿，TUI 进程内）：本稿。
- **R4**（帧成本随会话总长）：继续暂缓，不在本稿。

wave-20 后已落地的 R3 工事（`packages/tui/src/components/markdown.ts`):LexCache 块级前缀复用（`buildLexCache:297`)、SplitLex 段内 inline 分裂（`trySplitLex:693`)、ListSplitLex(`trySplitListLex:850`)、BlockSlot 非末块缓存（`render:1048-1081`)、FinalBlockSeal 段落/无高亮 fence 行密封+wrap 密封（`:1160-1348`)、FinalListSeal 项密封（`:1559`)。wave-25 实测列表 97k 字符 3.77→0.31ms/帧；wave-50 修 wrap seal 陈旧行校验（+46/−11，正确性修复，不改复杂度形状）。env 关断已在位：`PI_MARKDOWN_SPLIT_LEX=0`、`PI_MARKDOWN_LINE_SEAL=0`。

## 1. 现状定量（wave-50 后残留构成）

**1.14GB 的构成**:wire 侧 O(n²/2d) 全量重发（9-14 实测，d=delta 均长），已随 R1 修复消失。渲染腿的 O(n²) 由三处相乘：每帧全量 lex(marked)、每帧全量 renderToken+wrap+pad、生产路径每帧全量 highlightCode。wave-20 实测（identity 主题、无高亮）：单段/单 fence 80k → 13.9s 全流 CPU、尾部单帧 ~35ms（破 16ms 帧预算）；多块 80k → 309ms。

**wave-50 后的残留，按常量大小排序**（静态核算，P0 复测确认）:

1. **生产高亮 fence（大常量，唯一确定破帧预算的形态）**：生产主题恒设 `highlightCode`(`packages/coding-agent/src/modes/interactive/theme/theme.ts:1593`)→ `markdown.ts:1166` 的 `!this.theme.highlightCode` 门让 fence 密封在生产**永不 engage**;SplitLex 只覆盖段落，fence 亦无 lex 分裂。生长中 fence 每帧：全量 lex + cli-highlight/hljs 全文高亮 + 全量 wrap。wave-20 的 13.9s@80k 是无高亮测的，生产再加 hljs 常量（惰性加载 ~350ms,`theme.ts:1175`)。**注意既有语义：高亮器加载完成无广播重绘，加载前渲染的 fence 保持素渲**——P2 设计必须沿用此语义。
2. **生长中表格（大常量）**:`renderFinalBlockSealed:1160` 不覆盖 table → 每帧 `renderTable:2127` 全量：所有 cell 的 renderInlineTokens + visibleWidth + 列宽重算 + wrap。
3. **小常量残留（已密封路径上每帧 O(n) 的 JS 校验扫描）**:`backtickParity:714` 全段 char 循环（还带 `slice(paraFrom)` 整段拷贝）、`paragraphSealIntact:1355` 从头 token walk、`lastSealableParagraphOffset:1389` 全 token walk+indexOf、`spliceInlineTokens:473` 的 O(prefix) 数组展开；另有 3 处原生 `startsWith` memcmp(split.prefix/seal.source/lex prefix)。估算 100k/50B 帧 ≈ 2000 帧累计 0.2–0.5s，尾部单帧 ~1–3ms——不破帧预算，但严格 O(n²)。
4. **blockquote 末块**全量重渲：罕见形态，不立项。

**「wave-50 修完数字是否变化」**:wrap seal 修复是正确性项；seal 体系整体（wave-25 起）应已把单段/无高亮 fence 压到亚秒级，但**无 post-wave-50 实测** → P0 必须先复测。计量工具：`/tmp/w20e/render-markdown.mts` 仍在（identity 主题，只测到密封路径，**测不到生产高亮分支**)；仓内 `packages/tui/test/markdown-streaming-bench.ts`（混合语料，自带 first/last-100 增长比信号）。

## 2. 方案对比：语法 vs 位置 vs 混合

**语法判据**（现状路线）：密封点须过 inline 稳定分析（`findSafeInlineCut:407`、backtick 偶对、setext/table-delim 回望守卫、links 全禁）。改动面：已落地 ~600 行 + 4 个测试文件。风险：判据面广，每个 marked 癖好都要探针（wave-50 就是被一个判据缺口咬的）；但所有失败落回全量渲染——**不错，只慢**。收益：唯一能处理「单块 100k」的路线。

**位置判据**(deepseek「冻结到倒数第二块」)：改动面最小、正确性面最小，但对 backlog #9 的核心形态（单个巨型段落/fence/表格）**完全无效**——冻结线永远排在单块之前。且我们的 BlockSlot 已冻结全部非末块，比「倒数第二块」更强。纯位置路线对我们是降级。

**混合（推荐）**：语法判据守已建路径不动；位置判据只补两个大常量洞：
- **高亮 fence**：流式期密封行按 `codeBlock` 素渲、尾部窗口高亮；fence 闭合帧一次性全量高亮 reflow。
- **表格**:header+首数据行完成后冻结列宽，已完成行按冻结宽密封；表格变非末块时走既有 `renderBlock` 全量重渲一次（既有机制天然愈合，此后 BlockSlot 缓存）。

愈合点三方互证：deepseek finalize 全量 parse、Codex #50207 scrollback reflow、我们 `assistant-message.ts:384` 的 `streaming:` 签名重建（streaming→final 切换必全量重渲，**已存在**，是兜底愈合点）。预期收益量级：P1 残留 0.2–0.5s→~50ms@100k;P2 fence 13.9s+hljs 常量→亚秒@80k;P3 表格 O(n²)→~O(n)。

## 3. 分期（每期独立可 ship、可回退）

**P0 复测（不改 src)**：扩展 `/tmp/w20e/render-markdown.mts`：加带 `highlightCode` 的 hljs 权重 stub 主题（直接 import cli-highlight 或正则权重 stub)、生长表格形态、逐帧直方图；仓内 bench 加高亮档+表格档。产出 post-wave-50 基线表，落 FORK_NOTES。门禁：无（只读）。回退点：无。

**P1 残留扫描增量化**:`backtickParity` 改增量（密封前缀 parity 缓存，每帧只扫 `[tailFrom,end)`，顺带消掉 slice 拷贝）;`paragraphSealIntact` 从记录的边界 token 索引起步；`lastSealableParagraphOffset` 从上帧扫描位增量推进；`spliceInlineTokens` 只合并接缝不整列展开。原生 startsWith 保留（memcmp 近免费，不换内容哈希——Codex 哈希解的是 Rust 侧全 segment 比对，我们的前缀校验已是 startsWith 单点）。**零输出变化**：全部既有对拍 fixture 必须原样绿。门禁：`npm run check` EXIT 0 + tui 全套。回退：既有 env 关断 + 单文件 revert。

**P2 高亮 fence 密封**：解除 `:1166` 的高亮排除，新增 fence 密封形态——密封行 `codeBlock` 素渲，尾部 ≤1 屏行数走 `highlightCode`；闭合检测（token.raw 出现闭合 fence，或块变非末）触发一次性 `renderBlock` 全量高亮。高亮器加载中途就绪**不**重绘已闭合 fence（沿用 `theme.ts` 现状语义，不引入加载广播）。用户可见漂移：流式期密封区暂素、闭合时刻整 fence 上色一次（与 CC 2.1.289 layout-once-at-final-width 同族）——必须写进 FORK_NOTES。新 env 关断 `PI_MARKDOWN_FENCE_STREAM_HL=0`。

**P3 表格列宽冻结**：末块表格在 header+首数据行完成后冻结 columnWidths，已完成行密封；每帧只渲生长行；表格完成后全量重渲一次（真值列宽）再由 BlockSlot 缓存。用户可见漂移：晚到宽 cell 不再撑宽已出行，闭合时刻可能整表跳宽一次——进 FORK_NOTES。新 env 关断。

每期之间重跑 P0 基线对比；任一期目标未达，停在上一已验证期（沿用 wave-20 设计稿回滚线：回归超 2 周退一期）。

## 4. 测试策略

- **主干复用既有夹具**:`packages/tui/test/markdown-pathological-corpus.test.ts` 的 `assertStreamedIdentity` 就是 deepseek 手法的本地版（1/3/7/16 UTF-16 切块 × 每前缀对新组件全量渲染逐字相等）,wave-50 已验证能抓真 bug。新增语料：中英混排+inline math(Codex #30007 宽度失配族）、跨 MIN_SPLIT_LEX 4096 阈值的单段、跨行 `**`/link/数学迟到闭合。
- **P2 专用**：带 highlightCode 的 stub 主题夹具；断言口径放宽为——闭合帧及之后逐字恒等 + 流式期 stripAnsi 逐字恒等 + 行数单调；高亮器中途就绪用 stub 版本切换模拟。**预言机放宽处必须注释写明理由**（流式期素渲是设计行为，不是 bug)。
- **P3 专用**：晚到宽行表格；只在闭合帧/final 断言逐字恒等，流式期断言无崩溃/行数单调（冻结宽 vs 全量宽本就不同）。
- **故障注入（仓规「刹车必带恢复」)**：每个 env 关断各一条测试，断言关断与开启输出逐字恒等。
- **性能**:bench 扩展档数字进提交说明+FORK_NOTES;last-100/first-100 增长比作肉眼 O(n) 信号；不立 CI 性能门（无既有设施）。

## 5. 不做（边界）

不重写 markdown 渲染器、不换 parser(marked 留）；不动 wire/协议（R1/R2 已结案）;R4 窗口化不做；不动 OSC133/选择区语义（selection regions 按最终渲染行计算的路径不变）；不引入高亮器加载完成广播；reference-link 文档保持「全禁缓存 + finalize 愈合」不优化；三方 jsonl 客户端的 R1 残留只文档化。

## 6. 数字目标

| 指标 | A(wave-20 基线） | A′(P0 复测，待填） | B（目标） |
|---|---|---|---|
| 80k 单段全流渲染 CPU | 13.9s | 预期亚秒 | ≤1.5s |
| 80k 高亮 fence 全流 CPU（生产主题） | 未测（>13.9s) | P0 填 | ≤1.5s |
| 40k 生长表格全流 CPU | 未测 | P0 填 | ≤1s |
| 流式期单帧 p95(100k 单块） | ~35ms | P0 填 | ≤16ms |
| 密封正确性 | — | — | 除 P2/P3 标注的流式期漂移外逐字恒等 |

---

**给父代理的备注意**:① 我无执行权限，所有性能数字是静态核算，P0 复测是设计的第一期而非可选；② 无遗留探索问题——编号含义、代码现状、同行备料、测试设施均已核实（唯一未验证项：post-wave-50 实测值，已设为 P0 门禁）;③ 实施时先读 `streaming-resend-design.md` §五确认 R1 已修结论仍成立，避免重复立项。
---

## 进度注记（主席补，2026-10-04）

- P0 复测完成（/tmp/wave51/r3-p0.md，工具 /tmp/wave51/render-markdown-p0.mts）：单段 80k 0.40s、无高亮 fence 80k 0.26s、100k 单帧 p95 ~1ms（两项已达标）；**高亮 fence 80k = 19.6–22.3s、尾部 p95 25–40ms（唯一破帧预算形态，P2 立项证据）**；生长表格 40k 2.85s、80k 11.4s（O(n²) 确认，P3 立项证据）。
- P1 落地（/tmp/wave51/r3-p1.md）：四处扫描增量化（backtickParity 前缀缓存 / paragraphSealIntact 边界起步 / lastSealableParagraphOffset 续扫 / spliceInlineTokens 接缝合并），单段 80k 0.44→0.23s（−48%）、100k 0.75→0.44s（−41%），零输出变化（markdown 197/197 + tui 1288/1288）。
- 下一波：P2（高亮 fence 密封，含用户可见漂移声明）→ P3（表格列宽冻结）。
