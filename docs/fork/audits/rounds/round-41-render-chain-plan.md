# r41 方案会 · 簇B：渲染链收口（F1 键构造 O(全文) / F2 键漏 hyperlinks / 测试债 R9·R11·transform 缺口）

- 依据：0902 终审 `/tmp/audit_r/round-41/render-chain.md`（F1/F2/F5）与 `/tmp/audit_r/round-41/test-debt.md`（R9/R11）；行号对 HEAD=eb0825e63。
- 本席只出方案：不开工作树、不写代码；所有"改动点"均为对源码的指路，非已做修改。

## ① 根因复述（一句话）

`Markdown.render()` 的块级缓存把「输入维度」当「全部维度」用：键 `${width}|${type}|${nextType}|${token.raw}` 每帧对每个顶层块重新拼串+哈希（O(全文字节)，实测占单帧 46–52%），且键里漏了 `getCapabilities().hyperlinks`（连同 `cachedLines` 整体缓存的快路径也漏），所以同一份文本在能力翻转后命中陈旧缓存、再被 `tui.ts:1725` 指针快路径当「未变前缀」永久跳过；而两个新测试用相对比值+`<20ms` 恒真阈值、且不带生产 mermaid transform，钉不住以上任何一条。

## ② 候选修法

### F1 键构造增量化

**候选 A：token 身份槽位缓存（换掉字符串键）—— 推荐**
- 做法：`lex()` 的复用路径 `cache.tokens.concat(tailTokens)` 保持前缀 token 的**对象同一性**，因此 `blockCache: Map<string, string[]>` 可换成按索引对齐的槽位数组 `blockSlots: Array<{token, width, nextType, capsVersion, lines}>`；命中条件 `slot.token === token（指针相等）&& slot.width === width && slot.nextType === nextTokenType && slot.capsVersion === 当前版本`。命中/未命中都是 O(1)，彻底删掉每帧的拼串与哈希。
- 改动面：`markdown.ts` 一个类内部（render 循环 + invalidate + 型别），约 40 行；无公开 API 变化。
- 风险：(a) 依赖「marked 不复用/不原地改 token 对象」——前缀 token 来自 `lexCache` 自身持有的数组，全量重 lex 后是全新对象，指针误判只会**漏命中**（退化回重渲染）不会**错命中**；错命中的唯一路径是「同一 token 对象、同一 width/nextType/caps 却应渲染不同结果」，即 F2 类全局态——由 capsVersion 维度封堵。(b) 中间块被编辑后 lexCache 前缀断裂 → 全量重 lex → 槽位整体对不上 → 全部 miss 一帧，行为等价于今天 cache 全清，可接受。(c) 引用定义存在时 `cacheable=false` 的现有分支保留。
- 兼容性：纯内部实现；渲染输出逐字不变（块 lines 由同一 `renderBlock` 产出）。

**候选 B：键字符串惰性化 + WeakMap 备忘**
- 做法：保留 Map<string,…>，但用 `WeakMap<Token, {width,nextType,capsVersion,key}>` 把每个前缀 token 的键字符串只构造一次；V8 对字符串缓存哈希，重复用同一字符串对象做 Map 查找是 O(1)。
- 取舍：改动比 A 略小（不动缓存数据结构），但把性能押在「V8 字符串哈希缓存」这一引擎实现细节上，Bun/未来 V8 行为变化都会静默退化；且每帧仍有 `nextCache.set(key,…)` 的 Map 操作开销。作为 A 的回退方案保留。

**F1 附带项（本方案不强行捆绑，单列决策）**
- 全文归一化 replace（0.341ms@800k）与 selection 扫描（0.45ms@29101 行）：量级比键构造低一个数量级，建议本轮不动，在报告里登记为「已知线性残余」。
- 「首变更在视口上方 → fullRender」的 928ms 路径（tui.ts:1976-1981）是**独立病灶**（transcript 级，不是 Markdown 级），建议另开任务，不与本次块缓存改动混在一个 PR。

### F2 能力维度进键的正确位置

关键约束：`render()` 的**整体结果快路径**（`markdown.ts:361` 附近，`cachedText===this.text && cachedWidth===width`）在到达块缓存**之前**就会返回陈旧行——只把能力加进块键修不好这条路径。所以正确位置是**两处同时**：

**候选 A：能力版本号（推荐）**
- 做法：`terminal-image.ts` 加模块级单调计数器 `capabilitiesVersion`，`setCapabilities()` 与 `resetCapabilitiesCache()` 各自自增，导出 `getCapabilitiesVersion()`；`Markdown.render()` 每帧读一次：(1) 记入整体缓存有效性条件（`this.cachedCapsVersion === v`）；(2) 进块级命中条件（候选 A 的槽位字段 / 候选 B 的键前缀 `v|`）。`invalidate()` 不需要改。
- 取舍：一处真源（terminal-image），任何**未来新增**的能力维度（images 协议、trueColor 参与渲染等）自动被同一版本号覆盖，杜绝「每加一个全局态就要记得加一根键维度」的系统性漏项；代价是任何能力变化全量失效块缓存一帧（能力翻转极罕见，无感）。改动面：两个文件，约 15 行 + 导出。
- 兼容性：`setCapabilities`/`resetCapabilitiesCache` 现有调用者（目前仅测试）行为不变，只是多 bump 一个计数器；纯新增导出，无破坏。

**候选 B：invalidate 钩子**
- 做法：`setCapabilities`/`resetCapabilitiesCache` 里回调通知所有活 Markdown 实例 `invalidate()`（需要注册表）或让 TUI 层在探测完能力后显式重建组件。
- 取舍：引入了反向依赖/全局注册表，且 `resetCapabilitiesCache()` 后**重新探测**得到相同值时不该清、不同值才该清——钩子方案表达不了这个差别，只能保守全清；还修不了「外部直接改环境再触发重探测」以外的路径。否决，仅记录。

### 测试债：R9 / R11 回滚边界 + transform 缺口

**R9（`rlm-child-stream-scaling.test.ts:258`）**
- 回滚边界（什么叫"诚实"）：断言语句恢复为**逐字旧命题** `expect(parentListenerMs).toBeLessThan(12)`。理由：终审实测改动前实现总成本 22.87–23.51ms > 12ms（界能抓 bug），现界 15.3–27.3ms 会绿着放过它（界标定的是改动前成本）——所以"诚实线"就是旧字面量本身，不存在"部分回滚"（任何 `max(fullRederiveMs·k, 12)` 形态的界都把尺锚在被测量机器上， CI 慢机上界随 `fullRederiveMs` 上浮，改动前成本同比例上浮，判别力不变地差）。
- 防回摆（避免下一个人以"CI 抖"为由再放宽）：同文件补**正控用例**——用测试内复刻的「每 chunk 全文重推导」旧实现（终审 `perf-probe2.ts` 已有现成代码可搬进测试）断言其**必然超过** 12ms 界；正控红了说明界失效，而不是实现变快。若 CI 实测 12ms 确实抖，唯一可接受的替代是「界内自测的改动前循环 + ≥4x 余量」，且必须配同一枚正控。
- R11（`daemon-supervisor-eviction.test.ts:423`）回滚边界：逐字恢复 `24 * 60 * 60 * 1000,`；同文件 `:464` 同路径同夹取仍是字面量且 33/33 绿，证明该数字在本 harness 下是确定的——所以放宽理由（"loaded runner 抖动"）被同文件证伪，回滚必须到字面量，`expect.any(Number)` 或 `toBeGreaterThanOrEqual` 之类"上下界"都不算回滚（它们不钉"create 路径选了 long tier 并被 deadline 夹取"这一命题）。顺手把两处字面量收敛为对 `WORKER_REQUEST_TIMEOUT_TIERS.long`（或等值常量）的引用，防止未来改 tier 表时两处漂移。

**transform 缺口（F5 缺口2）**
- 修法：给 `test/markdown-incremental-lex.test.ts` 增加**同构用例组**——`transform` 用一个与生产 mermaid transform 同成本特征且带状态的替身（依赖 `availableWidth`、记录调用次数），断言两条：(a) 带 transform 时逐帧输出仍与「新建组件全量渲染」逐字相等（等价性不被 transform 破坏）；(b) 显式记录「transform 每帧对全文执行」这一**现状成本命题**（`transformCalls` 每次 render 恰好 +1、入参为全文），把"流式帧成本有界"的测试名改为只声明 lex 层有界，防止名称继续夸大。
- transform 本身的全文化（每帧 O(全文)）是否本轮一并修：建议**本轮只钉现状、不改实现**。mermaid transform 依赖 `isStreaming`（流式中会改未闭合围栏的渲染），其输出对前缀**不具备** lex 那种可证安全的切点性质；做 transform 增量化需要单独一轮边界穷举（同 r40 lexer 打法），捆绑进本会拖期且抬高 F1/F2 的回归风险。登记为后续任务。

## ③ 推荐与理由

- F1 取**候选 A（token 身份槽位缓存）**：把 O(全文) 的拼串+哈希降为 O(块数) 指针比较，且不依赖引擎内部行为；错误模式全是「退化回重渲染」（安全方向），没有「渲染错」路径。
- F2 取**候选 A（能力版本号）**：一处真源、同时堵住整体缓存快路径与块缓存两条路，并对未来新增能力维度免疫。
- 测试债：R9、R11 **逐字回滚**到旧断言 + 各补正控；transform 本轮只补覆盖与改名，实现增量化另开任务。
- 落地顺序：F2 先行（正确性、改动最小、红测现成）→ F1（性能，依赖 F2 的 capsVersion 字段进槽位）→ 测试债回滚（独立文件，可与前两者并行但**分开提交**）。共仓纪律：三个改动分别 `git commit --only -- <paths>`，F1+F2 同文件（markdown.ts）必须串行、由同一席提交。

## ④ 风险面清单（会动到谁）

| 改动 | 触及文件 | 受影响方 |
|---|---|---|
| F2 版本号 | `packages/tui/src/terminal-image.ts`（+计数器/导出）、`packages/tui/src/components/markdown.ts` | 所有 Markdown 组件实例（TUI 助手消息、thinking、扩展）；`setCapabilities` 的测试调用者语义不变；能力翻转后首帧全量重渲染（预期内） |
| F1 槽位缓存 | `packages/tui/src/components/markdown.ts`（render 循环、invalidate、型别） | 同上；`Editor.wrapCache`、`TUI.lineResetCache` 不动；与 `lexCache` 的交互面是唯一高危点（依赖 token 对象同一性，须由等价红测兜底） |
| R9 回滚 | `packages/coding-agent/test/rlm-child-stream-scaling.test.ts` | CI 时长不变；旧界在慢机上翻红的理论风险由正控用例对冲 |
| R11 回滚 | `packages/coding-agent/test/daemon-supervisor-eviction.test.ts` | 同文件 `:464` 已是同字面量，回滚后两处一致 |
| transform 覆盖 | `packages/tui/test/markdown-incremental-lex.test.ts` | 纯测试新增；测试改名影响 CI 报告里的用例名 |
| 不动但登记 | `tui.ts:1976-1981` fullRender 路径、全文归一化、selection 扫描、mermaid transform 增量化 | 后续独立任务 |

## ⑤ 验收护栏

**红测设计（先红后绿）**
1. F2 回归红测（直接移植终审 `capflip.ts`）：流式追加中 `setCapabilities({...caps, hyperlinks:true})`，同一 Markdown 实例下一帧**必须**输出 OSC 8；当前 HEAD 红。正控：新建实例输出 OSC 8（证明探针能检出）。再放一条整体快路径变体：能力翻转后 `setText` 同一字符串、`render(同宽)`，必须输出新形态——钉住 `cachedLines` 那条路。
2. F1 等价红测：(a) 终审 `lexfuzz`/`boundaryfuzz` 形态保留（8,160 边界 + 400 流式差分，逐字等于新建组件全量渲染）在槽位缓存下必须照旧全绿——这是「增量化不改变输出」的等价证明；(b) **身份欺骗红测**：monkey-patch/构造使同一 token 对象出现在不同 width 下，断言槽位不误命中（width 变了必须重渲染）；(c) 成本断言改为**计数**而非计时：给块键路径加可注入的探针（或断言「流式追加一帧时 `renderBlock` 调用次数 ≤ 末块数量+1」），彻底摆脱"阈值随机器漂"的 R9 类失败模式。`renderBlock` 调用计数是确定性命题，比任何 ms 阈值都硬。
3. R9/R11：回滚后旧断言逐字在位 + 新增正控用例（改动前模拟实现必然越界）；正控单独成 `it`，红=尺坏了而非实现坏了。
4. transform：新增用例组断言「带 transform 时逐帧逐字等于全量重渲染」+「transform 每帧恰好调用一次、入参全文」。

**等价怎么证**
- 渲染等价：全部等价断言一律「流式增量渲染结果 === 同一文本新建 Markdown 实例全量渲染结果」**逐字** `strictEqual`（沿用现有 `:79-108` 形态），覆盖宽度切换与能力翻转两个扰动维度。
- 性能等价：不证"快了多少"（机器相关），证"每帧工作量上界"——`renderBlock` 调用次数、transform 调用入参长度这两条确定性计数断言替代 ms 阈值；ms 数据只进 PR 描述作参考。
- 收口门禁：`cd packages/tui && node --test --import tsx test/markdown-incremental-lex.test.ts`（+ 新能力翻转用例文件）与 `packages/coding-agent` 两个回滚测试文件全绿；`npm run check` 全绿；纯净树 `git archive HEAD` + `tsgo --noEmit` EXIT=0（共仓纪律）。

## 未决项（交方案会裁决）

1. F1 附带项（归一化/selection/fullRender 顶部路径）是否本轮捆绑——本席建议不捆绑。
2. transform 增量化的立项优先级——依赖 mermaid transform 前缀稳定性的边界穷举，工作量接近一轮 r40 lexer 审计。
3. R9 若 CI 实测 12ms 抖动：接受"界内自测+4x 余量+正控"替代，还是先钉 12ms 观察一轮 CI——本席建议后者（先诚实，再按证据调）。

## 追记（方案会后 K3 补登 TUI-F3/P2：raw 相同 text 不同的 lazy 续行 token）

结论：**候选 A（token 身份槽位缓存）天然覆盖此坑，且是构造性覆盖**。机制：lazy 续行与段落起点之间无空行，而 `computeLexCut` 的稳定切点要求切点前紧邻 `\n\n`（markdown.ts:153-205），所以带 lazy 续行的 paragraph 永远落在 tail、每帧由新 lexer 重新产出**新 token 对象**——槽位命中第一条件是 `slot.token === token` 指针相等，新对象必 miss、必用新 `text` 重渲染；帧 N+1 拿不到帧 N 的槽位。字符串键方案（现状与候选 B）才是此坑的宿主：它们以 raw 内容为键，raw 不变即错命中。原地突变路径也不存在：marked 的 token 改写只发生在单次 lex 调用内部，返回的 TokensList 对象即冻结；后续帧的 tail 用全新 lexer、触及不到前缀对象，前缀对象又由「字节相同前缀+空行切点」双重冻结。验收侧补一条：把 K3 的最小打穿（'***\n\n\npara before lazy\n    lazy continuation arriving later\n- ' 追加 'l'）作为独立回归用例并入等价差分组（流式逐帧 vs 新建实例全量，逐字相等）——现有 8,160 边界样本已含 lazy 类，但这是「显式命名的承重用例」，单独成 `it` 防未来重构静默丢失。
