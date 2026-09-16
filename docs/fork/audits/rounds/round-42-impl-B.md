# r42 簇B 实施报告 · 渲染链收口（F2 → F1 → R9/R11 → 计数断言改造）

- 实施席：cluster-B 实施线（单车道独占 markdown.ts / terminal-image.ts）。
- 工作树：`/tmp/audit_r/round-42/wt-b`（`git worktree add` 自冻结 SHA **a5456df68**，node_modules 根级+包级 symlink）。主仓零写入。
- 方案书：`/tmp/audit_r/round-41/render-chain-plan.md`（含 K3 追记节），逐节执行，无修法偏离。
- 测试运行：tui 用 `node --test --import tsx`；coding-agent 用 `node ../../node_modules/vitest/dist/cli.js --run`（直接 node 调 vitest）；全部 unset 泄露 env（RLM_* / PRIME_AGENT_* / PI_*）。未用 `doctor --fix` / `daemon ps -k`。

## 提交清单（5 个，分开 git add + staged 核对）

| sha | 内容 | 文件 |
|---|---|---|
| 27eb081c3 | F2：capabilitiesVersion 双消费点（整体快路径 + 块缓存键） | terminal-image.ts、markdown.ts、新 test/markdown-capability-flip.test.ts、.changes |
| ef7818d99 | F1：blockCache Map→token 身份槽位数组（指针相等+width+nextType+capsVersion） | markdown.ts、markdown-incremental-lex.test.ts、.changes |
| a1ce5fa5d | R9：12ms 界逐字回滚 + 改动前循环正控 | rlm-child-stream-scaling.test.ts |
| d436f904e | R11：24h 字面量回滚（两处收敛为 WORKER_REQUEST_TIMEOUT_TIERS.long） | daemon-supervisor-eviction.test.ts |
| e17acd30f | 确定性计数断言改造 + transform 同构用例组 + 改名 | markdown-incremental-lex.test.ts |

## F2（红→绿）

- 红测（改动前 HEAD a5456df68 实测红，`fail 2`）：`test/markdown-capability-flip.test.ts`
  1. capflip 终审形态：流式中 `setCapabilities({...caps, hyperlinks:true})` 后同实例追加一帧必须输出 OSC 8；改动前 GOT 无 OSC 8（正控：新建实例输出 OSC 8 ✓）。
  2. 整体快路径变体：翻转后**不** setText、同文本同宽再 render，必须输出新形态（钉 cachedLines 那条路）；改动前红。
- 实施：terminal-image.ts 加模块级单调 `capabilitiesVersion`（`setCapabilities`/`resetCapabilitiesCache` 各自自增）+ 导出 `getCapabilitiesVersion()`；markdown.ts 两处消费：(1) 整体缓存条件加 `cachedCapsVersion === v`；(2) 块缓存键加 `v|` 前缀（后被 F1 槽位字段取代）。`invalidate()` 未动（方案书如此）。

## F1（红→绿）

- 红测（F2 提交后、F1 前实测红）：K3 最小打穿 `***\n\n\npara before lazy\n    lazy continuation arriving later\n- ` 追加 `l` —— 改动前 GOT 丢缩进+多一空行（与 K3 报告逐字一致）；已并入等价差分组为**显式命名回归用例**（含再追加一帧验证不自愈）。宽度身份哨兵：同 token 对象跨 80/40/80 宽度必须逐字等于新建全量渲染。
- 实施：`blockCache: Map<string,string[]>` → `blockSlots: BlockSlot[]`（index 对齐；命中条件 `slot.token === token && slot.width === width && slot.nextType === nextTokenType && slot.capsVersion === capsVersion`）；`invalidate()` 清空槽位；`cacheable=false`（引用定义）分支保留。K3 追记节的"构造性覆盖"成立：lazy 段落永远在 tail、每帧新 token 对象必 miss。
- 性能实测（800k 分区文档流式追加帧中位，本机）：改动前 6.04ms（其中键构造 2.41ms）→ 改动后 3.05ms；200k 0.45ms、1.6M 6.89ms —— 键构造 O(全文) 已除，剩余线性为方案书登记的已知残余（全文归一化、行数组复制、selection 扫描、末块重渲染），本轮不动。
- 计数断言的负例（判别力正控）：临时禁用槽位命中 → 追加一帧花 164 次 theme 调用（界=8）即红；恢复后 8/8 绿。

## R9（逐字回滚 + 正控）

- `expect(parentListenerMs).toBeLessThan(Math.max(fullRederiveMs*chunkCount*0.5, 12))` → 逐字恢复 `expect(parentListenerMs).toBeLessThan(12);`（连注释一并回滚）。
- 新增正控 `it`（同文件）：测试内复刻改动前每 chunk 全文重推导循环（compactRlmText 全文 + 5k brief 正则 + 全量 JSON.stringify ×400 chunk），断言必然 >12ms——本机实测 22.6–25.5ms（≈2x 余量）。正控红＝尺失效，非实现变快。

## R11（逐字回滚 + 常量收敛）

- `expect.any(Number),` → 恢复精确值；按方案书"顺手收敛"两处（:423 create 路径、:464 same-worker 路径）统一为 `WORKER_REQUEST_TIMEOUT_TIERS.long`（tier 数值本身由 daemon-timeouts.test.ts 钉住），防止改 tier 表时两处漂移。
- 实测：33/33 绿 × 连续 3 轮（+单独 targeted 8/8）——"loaded runner 抖动"理由被证伪，与终审一致。

## 计数断言改造 + transform 覆盖 + 改名（e17acd30f）

- ms 成本测试（sectioned/single 比值 + `<20ms`）按方案书 §⑤「计数替代 ms 阈值」移除；ms 数据改为测试注释+本报告的参考数据。
- 新增两条确定性计数断言：
  1. **renderBlock 上界**（计数 theme 探针，走公共构造 seam）：流式追加一帧 theme 调用 ≤ 2×单块成本（末块+新块）；负例见上（164 vs 8）。
  2. **transform 现状成本命题**：带 stateful/宽度依赖替身（replaceAll 全文扫描，与生产 mermaid transform 同成本特征）——每流式帧恰好调用 1 次、入参为全文（78 列）、未变更重渲染走整体缓存 0 次；并断言带 transform 时逐帧输出与新建全量渲染逐字相等（覆盖宽度切换 80/40/60）。
- 改名：删除名不符实的 "streaming append frame cost is bounded by the lex cache, not the document"；新名只声明各自钉住的命题（"per-frame render work"、"transform once per frame, over the full text (current cost)"）。

## 收口门禁（全绿）

- `cd packages/tui && npm test`：**847/847**（工作树与 pristine archive 树各跑一遍）。
- coding-agent 两测试文件：`node ../../node_modules/vitest/dist/cli.js --run` → **38/38**；pristine 树合计 14 轮中 13 轮全绿，1 轮 1 例未捕获失败（与 tui 全量套件并发跑出的 loaded-runner 瞬态；事后两文件单独复跑 13 轮 + targeted 8/8 全绿）。
- `npm run check`（root，biome --error-on-warnings + tsgo + installer/browser-smoke/ci-honesty）：**EXIT=0**，check 后工作树无 diff。
- 纯净树：`git archive HEAD` + node_modules symlink + `tsgo --noEmit`：**EXIT=0**。
- `check-test-private-probes.mjs --base a5456df68 --strict-diff`：**OK**（无新私有探针；计数探针走公共 theme seam，非 `_foo` 探测）。

## 已登记不动项（沿方案书）

1. 全文归一化 replace / selection 扫描 / 全量行数组复制：量级低一档的线性残余，本轮不动。
2. `tui.ts:1976-1981` 首变更在视口上方的 fullRender 928ms 路径：独立病灶，另开任务。
3. mermaid transform 本身的增量文（每帧 O(全文)）：本轮只钉现状（计数断言），增量化需独立一轮边界穷举。
4. R9 若 CI 实测 12ms 抖：按方案书未决项 3，先诚实观察一轮 CI 再按证据调（正控已就位）。

## 偏离说明（均属方案书给定的自由度，非改道）

- 计数探针用「计数 theme 包装」而非给块键路径加新注入点：方案书原文"给块键路径加可注入的探针**（或** 断言 renderBlock 调用次数 ≤ …**）**"二选一，取后者且不加 src API 面。
- R11 最终形态为 `WORKER_REQUEST_TIMEOUT_TIERS.long` 引用而非裸字面量：方案书"顺手把两处字面量收敛为对 WORKER_REQUEST_TIMEOUT_TIERS.long（或等值常量）的引用"明示。
- R9 的 12ms 界与正控本机 2x 余量成立，无需启用备选"界内自测+4x 余量"形态。
