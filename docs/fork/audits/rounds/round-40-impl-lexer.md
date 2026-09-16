# r40 impl-lexer — TUI-1 残留：markdown 增量 lexer（施工回执）

- 日期：2026-09-16 · 基准：r33 `tui-render-internal.md`/`impl-tui.md`（800k 语料流式帧 ~28ms，大头=markdown.ts:255 全文 re-lex；blockCache 只省 re-render 不省 re-lex）
- 冻结 SHA：主仓 HEAD `c060eb1a15744693896e39bbb9d507659e5c1f3b`（只读，零写入；`git status` 仅 3 个与本线无关的 untracked 截图/out.txt）
- 工作树：`/tmp/audit_r/round-40/wt-lexer`（detached @ c060eb1a1 + 提交 **`33eb05dff`**，仅 3 文件：src/components/markdown.ts + 新测试 + changelog 片段）
- 去重：`docs/fork/audits/decisions.jsonl` 326 条中 markdown/lexer/re-lex/blockCache 相关 **0 条**，无冲突
- 复跑：`cd /Users/a1/Desktop/ai/prime-agent/packages/tui && npx tsx /tmp/audit_r/round-40/battery-final.mjs`（双侧对比自动跑）

## ① 诊断：markdown.ts:255 的 re-lex 触发面（改前实测）

**改前任何 setText 引起的 text 变化都触发全文 re-lex**——`render()` 只有 `cachedText === text && cachedWidth === width` 整体记忆命中才跳过 lexer；纯追加、头部变更、中部变更、收缩一视同仁（`pickMarkdownParser(normalizedText).lexer(normalizedText)` 每次 O(N)）。纯追加是流式主形态也是最大受害者。基线（marked 18.0.7，r33 SECTION 语料，流式帧 median）：16.5k=0.59ms、66k=2.07ms、265k=9.55ms、**795k=31.07ms**（与 r33 ~28ms 吻合，线性）。

深挖出**第三类触发面（朴素增量会翻车的根因）**：marked 的 token 边界在"生长中的文档尾部"不稳定——
1. **部分行 EOF 再切分**：`"...- Nested item two
- Thi"`（行未完）全量 lex 会切成 `[list, space("
"), list]` 三 token；补全成 `- Third list item
` 后合成**一个** list token。朴素"从上一帧最后 token 起点续 lex"会在中部留下永久性分裂 token（实测 battery S1 首版即因此 2 处 DIFF）。
2. **列表跨空行吸收**：`"- list b

    in"` 里 4 空格缩进内容属于前一个 list 的 item 续行，全量 lex 会被 list token 吞掉；孤立 lex 尾巴会把它当独立 code token。
3. 懒续行/单换行合并：marked 把 code/def/text/懒续行折进前一个 paragraph/text token 的 raw（仅在单换行邻接时）。
4. 链接引用定义（`[foo]: /bar`）是**前向耦合**：后到的定义能改变更早块的渲染（reflink 解析），且 lexer 在 `tokens.links` 全局累计。

## ② 实现：稳定边界增量 lex（`33eb05dff`）

`Markdown` 增加 `lexCache`（text/tokens/cut/prefix）。`render()` 把 `normalizedText` 先做 `	→空格` + `
|→
`（lexer 内部本会替换 CR，不先换会错位 offset 基准），再走新私有 `lex()`：

- **命中**：`cache.cut>0 && normalizedText.startsWith(cache.prefix)`（prefix 为已切片字符串，每帧一次 memcmp，800k 实测 ~0.05ms）→ 用新文本的 parser **只 lex 尾巴** `normalizedText.slice(cut)`，`kept.concat(tail)` 拼回，tail links 非空则当场退全量。
- **cut 的充分条件（isStableLexBoundary，三条全过）**：(a) 前缀以真空行结束 `text[cut-2:cut]=="

"`——挡住懒续行与一切单换行合并回卷；(b) 尾巴首字符非空白——挡住"空行+缩进=前列表续行/缩进 code"的边界漂移；(c) 前缀里最近的非 space 块**不是 list/html**——这两类会在生长中跨空行吸收后续内容。cut 取满足条件的最晚 token 起点；条件不满足整体回退 cut=0（全量）。
- **token 平铺校验**：块 token raw 逐段恰好铺满文本（sum(raw)==len）才启用 offset 复用（marked 每个 loop 迭代恰消费 raw.length，合并只改前 token raw，实测成立；不成立即 cut=0）。
- **链接引用守卫**：上一帧或本帧 tail 出现任何 def → 永远全量（与既有 blockCache 的 links 保守姿势一致；S3 正控验证）。
- 头部/中部变更：prefix `startsWith` 不中 → 全量（尾部区域内的编辑则走增量，等价性同参数成立，严格优于规格）。宽度/transform 变化自然失效。

**为何"只 lex 新增文本"不可行而改为"最后稳定边界起的尾巴"**：最后一 token 是开放块（未闭合 fence、生长中 list/段落），追加会重新解释它——这正是既有 blockCache 注释"final block is never cached"的同一事实在 lexer 层的投影；从最后稳定边界重 lex 尾巴是既正确又最小的单位。前缀块（稳定边界之前全部）**零重算**。

## ③ 护栏与红绿

**九场景 sha256 双侧等价**（r33 byte-equal 法移植到 Markdown 组件层；旧=主仓 HEAD 实现，新=wt-lexer，写流=每帧 render 输出拼接，`/tmp/audit_r/round-40/battery-final.mjs`）：

| 场景 | old sha256(前16) | new | 结果 |
|---|---|---|---|
| S1 流式追加 200k | 1e506fb9ff7eafd3 | 同 | OK |
| S2 math 流式（$$/\[/\(/parser 切换） | 71ab42f4803bbe17 | 同 | OK |
| S3 链接引用定义流式（先用法后定义） | c296b8c3e1e5e7f | 同 | OK |
| S4 头部变更后续流 | 55bce53dcc637e58 | 同 | OK |
| S5 中部变更 | 8c6b3b5080676325 | 同 | OK |
| S6 尾部收缩（退格模拟） | e7d5429968579ec1 | 同 | OK |
| S7 宽度变化 60↔100↔45 | 4a6173d6676a5674 | 同 | OK |
| S8 混合追加+删+改（种子随机） | 1bf60f2a040507b3 | 同 | OK |
| S9 对抗形态 3 字节流（setext 迟到/未闭 fence/懒续行/CRLF/tab/表） | 13890515fa343670 | 同 | OK |

**仓内测试** `packages/tui/test/markdown-incremental-lex.test.ts`（node:test 公共 API，无私有探针；4 用例 ~2s）：
1. 种子随机 12 文档 × 随机步长流式：**逐帧**断言 流式组件输出 == 全新组件全量输出（fresh=全量 re-lex oracle，行为级差分）；
2. 头/中/收缩变更退全量后仍 == oracle（**正控**：退全量照旧正确）；
3. 宽度变化失效后 == oracle；
4. **性能断言（改前必红）**：800k SECTION 语料流式帧 median × 3 < 800k 单一大段落（无稳定边界=线性对照组）median，且绝对值 <20ms。**红侧实证**（pristine HEAD @ c060eb1a，`/tmp/audit_r/round-40/pristine`）：`sectioned median 31.75ms vs 对照 47.09ms`，断言失败=红 ✓；**绿侧**（wt-lexer）：5.76ms vs ~47ms 通过 ✓。两侧同进程同机跑，比值断言自归一。

**性能结果**（流式帧 median，r33 语料）：

| 语料 | 改前 | 改后 | 提升 |
|---|---|---|---|
| 16.5k | 0.59ms | 0.13ms | 4.5× |
| 66k | 2.07ms | 0.42ms | 4.9× |
| 265k | 9.55ms | 1.85ms | 5.2× |
| **795k** | **31.07ms** | **5.76ms** | **5.4×** |

**既有套件**：markdown/markdown-latex/tui-render 125/125，tui-large-transcript/hyperlink-at-column/truncated-text 23/23（`node --test --import tsx` 直跑，env -u RLM_*/PRIME_AGENT_*/PI_*）；`tsgo -p tsconfig.build.json --noEmit` EXIT=0（工作树 + `git archive 33eb05dff` 原始树双跑）；biome 两文件干净（修掉 1 处 `${}` 模板占位警告）。提交 `33eb05dff` 仅含本线 3 文件，无 amend/force，主仓零写入。

## 残留与未做（如实）

1. **blockCache 键 O(raw) 重拼仍是每帧线性项**（`${width}|type|next|raw}` 全块拼串）+ startsWith O(prefix) memcmp：改后 800k 帧 5.76ms 的主要构成。r33 已点名该项独立于 lexer；本轮未动（动它=改 blockCache 键结构，影响面另算）。lex 本身已 O(尾巴)。
2. 含链接引用定义的文档永不增量（正确性优先；AI 流式输出极少用 reference 式链接）；list/html 后随块的边界会多回退一个块（尾巴有界增大，实测无感）。
3. 单一巨型段落（无空行）无稳定边界 → 每帧全量（与改前持平，无回归；800k 单段对照即此形态）。
4. 未跑 `npm run build`（同 r33：预算内以 tsgo+测试+原始树验证收口，bundle 刷新留给合并席）。
5. 途中首版朴素 cut（仅排除 paragraph/text 前驱）在 S1/S9 出 2 处 DIFF，定位为 marked 尾部 token 边界不稳定（部分行再切分+列表跨空行吸收），三条件稳定边界修复后九场景全等——过程证据在 `/tmp/audit_r/round-40/dbg/`（token 级 diff 探针）。
