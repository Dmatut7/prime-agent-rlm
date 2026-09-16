# r33 修复——TUI-2 / TUI-1（GLM TUI 线施工回执）

- 日期：2026-09-16 · 基准报告：`/tmp/audit_r/round-33/tui-render-internal.md`（冻结 07fc6abe1）
- 冻结 SHA（本线）：主仓 HEAD `a5bd895278`（`git rev-parse HEAD` 实测，零写入主仓）
- 工作树：`/tmp/audit_r/round-33/wt-tui-impl`（detached @ a5bd895278 + 提交 `84d3b31e9`），`node_modules` 主仓 symlink（root + 3 包）
- 红绿脚本：`/tmp/audit_r/round-33/redgreen/`（harness.ts、red-tui2.ts、red-tui1-scan.ts、red-tui1-throttle.ts、byte-equal.ts、diag3/4.ts；`TUI_SRC` 指向被测 src，tsx 直跑）
- 改动面：`packages/tui/src/tui.ts`（+126/-18）+ 新测试 `packages/tui/test/tui-large-transcript.test.ts`（3 用例）+ changelog 片段 `packages/tui/.changes/tui-render-fast-path.md`

## 改动内容（逐条对任务）

**TUI-2（lineResetCache 20k 全清 → 逐条淘汰）**：tui.ts applyLineResets 的 `cache.clear()` 换成与 editor.ts wrapCache 同款的逐条淘汰（`cache.keys().next()` 删最旧再 set）；applyLineResets 增加可选 `start` 参数（fullscreen 帧路径默认 0 不变）。

**TUI-1①（lastRenderAt 打点挪后）**：requestRender(force) 的 nextTick 回调与 scheduleRender 的 setTimeout 回调两处，`lastRenderAt = performance.now()` 挪到 `doRender()` 完成之后（带注释说明慢帧连发的机理）。

**TUI-1②（六个全转录扫描收窄）**：
1. **diff 比较**（原 1791-1802 全行扫描）：改为从 `firstRawDiff` 起扫。newLines 先做 `[...render]` 拷贝（原有）→ extractCursorPosition（本来就只扫底部 height 行，不动）→ **新增 raw 快照**（marker 剥离后的原始行数组）→ 从 0 起指针比较找首个 raw 差异 `firstRawDiff` → `[0, firstRawDiff)` 直接复用 `previousLines[i]` 已归一化字符串（零 Map 查找、零正则、保指针身份）→ `applyLineResets(newLines, firstRawDiff)` 只归一化 `[firstRawDiff, 末尾)`。**正确性论据**：组件不变时交回同一 raw 行对象（tui.ts:1414 注释自认），指针相等 ⇒ 内容相等 ⇒ 归一化结果与已提交的 previousLines[i] 完全一致；视口上方变更仍被 raw 指针走查发现（不能盲扫尾部的原因——上方变更会走 fullRender(preserveViewport) 写路径，漏检会换错路径）。
2. **applyLineResets**：同上，从 firstRawDiff 起。
3. **collectKittyImageIds**（原 4 个提交点全量重扫）：删掉该方法，换 `updateKittyImageIds(newLines, firstRawDiff)` 增量维护（旧区 [start, oldLen) 减、新区 [start, newLen) 加，kittyImageIdCounts 计数表处理同 id 多行）；previousKittyImageIds 语义不变（＝ids(previousLines)），fullscreen enter/exit 的 inlineState 存取补齐 previousRawLines + kittyImageIdCounts。
4. **expandLastChangedForKittyImages**（原 [firstChanged, 末尾) 全扫）：previousKittyImageIds 为空（本帧无任何图片行）时直接返回——语义精确等价（Set 恒为 ids(previousLines)）；有图时照旧全扫。
5. **markdown 全文 re-lex（markdown.ts:255）+ blockCache 键 O(raw) 重拼**：**未动**。这是收窄后残余的每帧主成本（800k 语料 28.1ms/帧的大头），报告已判需增量 lexer，超出本任务两大头范围。
6. **`[...this.render(width)]` 全量拷贝**：保留（render 可能交回 memoized 数组且后续就地改写）；新增的 `rawLines = newLines.slice()` 也是 O(N) 指针拷贝（200k 行实测 <0.1ms）。**剩余线性项**：raw 指针走查 O(N) 次指针比较（有声变更检测的代价）+ LineAggregator 的逐子组件数组指针核对（O(组件数)，便宜）。

## 红测（改前必红，脚本可复跑）

| 红测 | 改前（红） | 改后（绿） |
|---|---|---|
| red-tui2.ts：200 161 行唯一内容 + 空闲 loader tick，断言每帧 refill ≤ 淘汰且无 clear() | 每帧 sets=47 273、deletes=0、clears=2-3、36.18ms/帧 → RED | sets=0、deletes=0、clears=0、**2.47ms/帧（14.6×）** → GREEN |
| red-tui1-scan.ts：100k/800k 语料流式，断言每帧扫描行数有界（≤height+128）且曲线平坦 | 4 412 / 39 479 行/帧（比值 8.9，线性）→ RED | **67 / 64 行/帧（比值 1.0，平坦）** → GREEN；wall time 800k 29.55→28.13ms（残余＝markdown re-lex，见上） |
| red-tui1-throttle.ts：busy-wait 25ms 慢帧 + 连续 requestRender，断言帧间距 ≥34ms | 帧间距 26.6ms（=帧时长，节流失效连发）→ RED | 帧间距 40.5-41.2ms（=帧时长+16ms 节流恢复）→ GREEN |

## 正控

- **逐字节等价**：byte-equal.ts 九场景电池（流式 200k 追加、>20k 唯一行空闲 tick、内容等价新对象、视口上方中途变更、收缩、宽/高变更、force 重建、kitty 图移动/删除/同 id 双行、混合追加+删除），同一确定性语料（种子 PRNG，无 Math.random）驱动旧实现（wt-tui-old @ a5bd895278）与新实现（wt-tui-impl），写流 sha256 双侧 `df04e7b5bb6f021beb2e4338f8658e9c9fe3e5040ec6b8e7411512b91b7b290b`（3 187 465 字节），`cmp` exit 0，**diff 为空**。
- **50k 行场景行为不变**：red-tui2.ts 尾段（50 041 行、12 517 唯一键）改后 0.49ms/帧（改前 5.82ms），渲染输出同在电池内逐字节等价。
- 电池坑位修正记录：初版 S4/S9 原地改 `lines[i]` 不触发重渲（LineAggregator 按子组件数组身份 memoize，新旧实现一致地看不见），已改为重赋值数组使场景真正打到 firstChanged<viewportTop / 混合变更路径（修正后 2J 全清标记出现 8 次，路径确证）。

## 仓内测试与检查

- 新增 `packages/tui/test/tui-large-transcript.test.ts`（3 用例：>20k 唯一行 spinner tick 写量 <300B 且视口完好；大转录视口上方变更原位重绘视口；kitty id 42→43 跨大转录变更的删除/重绘顺序）——node:test 公共 API 风格（VirtualTerminal + waitForRender），无私有成员探针；旧实现同跑 3/3 通过（行为级断言，实现无关）。
- 既有套件：tui-render + fullscreen + markdown 140/140；editor + input + overlay-options 268/268（env -u 泄露变量，`node --test --import tsx` 直跑，≤3 文件/批）。
- `tsgo -p tsconfig.build.json --noEmit` EXIT=0（工作树与 `git archive HEAD` 原始树双跑）；biome check src/tui.ts 干净。
- 提交 `84d3b31e9`：三文件分开 `git add` 并核对 staged 清单（仅本线 3 文件）；主仓零写入；无 amend/force。

## 未做与残留（如实）

1. markdown 全文 re-lex / blockCache 键重拼（修法＝增量 lexer，报告原判大工程）：800k 语料流式帧仍 ~28ms，属渲染侧（render() 内），本线收窄的是 diff/reset 侧。
2. raw 指针走查与两次全量数组拷贝仍是 O(N)/帧（指针级，200k 行 <0.2ms），为保输出逐字节等价的有声设计代价。
3. FR-3（粘贴每字符过滤）、FR-5（首帧全量写出）不在本任务范围，未动。
4. 未跑 `npm run build`（45 分钟预算内以 tsgo+测试+原始树验证收口；本 fork 日常用 `prime-agent.sh`/build 刷新，留给合并席）。

复跑指引：`cd /tmp/audit_r/round-33/wt-tui-impl/packages/tui && TUI_SRC=<被测src> npx tsx /tmp/audit_r/round-33/redgreen/red-tui2.ts`（红测换 TUI_SRC=wt-tui-old/packages/tui/src 即得红侧数据）。
