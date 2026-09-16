# round-35 K3 复核：r33/r34 provider+TUI 落地批（修 A 弄坏 B 专项）

- 冻结：HEAD = dd88c1a8e（复核对象 f615e2c1c / a5cd634f7 / 84d3b31e9 / dd88c1a8e）
- 方法：读码 + 真实探针（/tmp/audit_r/round-35/probes/*.mts，本地假 SSE 驱动真实 SDK、VirtualTerminal 驱动真实 TUI）+ 仓库本批测试重跑（env 已剥离 RLM_*/PRIME_AGENT_*/PI_*）
- 仓库零写入。decisions.jsonl 已去重（无重复条目）。

## 结论总览

| 项 | 结论 | 依据 |
|---|---|---|
| ① E4-1×PV-3 usage 跨 item | 干净（正控过） | P1 探针 |
| ② E4-6×E4-7 done 时机 | **打穿 1 个**（F1，P3） | P2/P2b 探针 |
| ③ ERR-1 守卫×keep-alive | 干净（全栈正控×2 provider） | P3/P3c 探针 |
| ④ TUI 指针差分×rewind | 干净（正控×3） | P4 探针 |
| ⑤ TUI kitty 增量×删图 | 干净（正控×4，含内部态直查） | P5 探针 |

回归确认：本批 6 个 ai 测试文件（58 tests）+ tui-large-transcript（3 tests）全绿。

---

## F1（② 打穿）：output_item.done 的 slot 回退 `?? currentBlock` 会把已释放/未知 item 的 done 写到别的块上

- **命题**：PV-3 给 delta 类事件的分发（resolveItemAndBlock，openai-responses-shared.ts:380-405）在 item_id 存在但 slot 未注册时返回 null/null 并记 unrouted 诊断；但 output_item.done 分支（openai-responses-shared.ts:618-627）自己的查找失败后静默回退 `slot?.block ?? currentBlock`，把事件作用到**别的 item 的活着的块**上。
- **severity**: P3（需要网关发重复 done 或 done 带未注册坐标；真实 OpenAI 不会，但 PV-3 的全部前提就是"有些网关交错/缺坐标/重放"）
- **file:line**: packages/ai/src/providers/openai-responses-shared.ts:627（`const block: Block | null = slot?.block ?? currentBlock;`）、662（`block.thinkingSignature = JSON.stringify(item);` 无条件覆写）、711-717（releaseSlot 后 currentBlock 清理）
- **逐字证据**（P2/P2b 探针实测，rs_A done 后重复发 rs_A done，rs_B 仍在流式）：
  - 第二次 done(rs_A)：slot 已 releaseSlot → 回退 currentBlock = rs_B 的 thinking 块 → `responses_thinking_conflict` 诊断记的是 itemId rs_A，但**被覆写的是 rs_B 的块**（诊断里看不到受害块）；
  - `block.thinkingSignature = JSON.stringify(item)` 无条件执行 → P2b 变体（rs_B 的 done 始终不到达、流正常 completed）实测：`blockB.thinking = "BBB"` 但 `blockB.thinkingSignature = {"type":"reasoning","id":"rs_A","summary":[{"text":"AAA"}]}`——**回放时 B 的思考以 A 的 reasoning item 身份上线**（回放路径 openai-responses-shared.ts:168-170 直接 JSON.parse(thinkingSignature) 当 item 用），跨 item 归错账且静默；
  - 附带：同一 contentIndex 收到两次 thinking_end（P2 实测 thinking_end count for B index: 2）。
- **影响**：gateway 重放/重复 done 场景下思考块签名错绑 → 下一轮请求 replay 错位的 reasoning item；重复 thinking_end 事件对下游计数类消费者是噪声。
- **可复现**：`cd packages/ai && npx tsx /tmp/audit_r/round-35/probes/p2b.mts`（打穿）；p1p2.mts 的 P2 段（重复 thinking_end + 冲突诊断指向错误归因）。
- **修法建议**：done 分支与 resolveItemAndBlock 对齐——item_id/output_index 存在但 slot 未注册时记 unrouted 诊断并跳过，不回退 currentBlock；仅无坐标事件才回退。
- **confidence**: high（实测打穿，两次变体）。

---

## ① E4-1 字段级 usage 合并 × PV-3 分槽：干净（正控）

- usage 在 Responses 协议是 response 级（只挂在 response.completed/incomplete，openai-responses-shared.ts:718-751），不经过 item slot 分发，PV-3 的分槽不接触 usage 路径——不存在"跨 item 归错账"的通道。
- mergeResponsesUsage（:283-296）后帧逐字段覆盖前帧，是设计语义（partial late frame）；total_tokens 缺省回退 input+output。
- **正控**（P1 探针）：reasoning(rs_A) 与 message(msg_B) 交错 delta 按 item_id 正确分块（thinking="thinkA"、text="textB"、块序 [thinking, text]），completed 携带缺 total_tokens 的 usage {input:10, output:7} → usage.input=10, output=7, totalTokens=17（回退求和正确）。PASS。
- 附带观察（非本批回归）：completions 的 mergeChunkUsage 对"每 chunk 增量型 usage"（若有这种 provider）会只保留末帧而非求和——与合并前"取最后一帧"行为一致，非回归。
- confidence: high。

## ③ ERR-1 终止守卫 × keep-alive：干净（全栈正控，真实 SDK + 本地假 SSE）

- 守卫的触发条件是"异步迭代器结束（连接关闭/[DONE]）且未见终止事件"；keep-alive 帧不会结束迭代器，结构上不可能误伤真空闲长连接。
- **completions**（p3.mts，真实 openai SDK 打本地 SSE）：流内混入 `: keep-alive` / `: ping 12345` 注释帧 + 正常 finish_reason + usage chunk + [DONE] → done=1, error=0, usage{11,2}、text="Hello" 全对；**正控**：同流去掉 finish_reason → 恰 1 个 error，`ended before a finish_reason` / kind=malformed_response。PASS。
- **codex**（p3c.mts，真实 provider，fake JWT + transport:"sse"）：注释帧 + LF 与 CRLF 两种帧界各跑一遍 → done=1, err=0；**正控**：无终止事件 → `SSE stream closed before response.completed`。PASS。CRLF 归一化（openai-codex-responses.ts:637-644）在跨 chunk `\r`+`\n` 边界上正确（replace 在每次 append 后重跑整个 buffer）。
- anthropic（读码）：`event: ping` 帧把 sawDataFrame 置真但不结束流；守卫只在迭代结束后检查 sawMessageEnd（anthropic.ts:526-531）。纯 ping 后断连会抛 malformed——这是截断的正确判定，非误伤。
- confidence: high。

## ④ TUI 指针差分 × rewind/branch：干净（正控×3）

- 安全性依赖两条不变式，均核实：(a) JS 字符串不可变 ⇒ 指针相等 ⟹ 内容相等（前缀复用 tui.ts:1723-1731 保守方向不会漏检）；(b) 四个提交点（tui.ts:1794-1798/1826-1830/1950-1954/2116-2118）previousLines 与 previousRawLines 成对提交，index 对齐。早退路径（firstChanged===-1，:1903-1908）不提交但帧内容等价，安全。
- **正控**（p45c.mts）：P4a 100 行 transcript 只改第 3 行（视口之上，模拟 rewind/branch 的 leaf 移动）→ 触发视口内重绘（479B），viewport 完好；P4b 视口内单行改 → 精确重绘该行；P4c 空帧（0 字节）后再改 → 正常检出。全 PASS。
- **陷阱记录（预存，非本批回归）**：LineAggregator（tui.ts:266-276，222cd404e 引入）按组件 render() 返回的**数组引用**判变——原地改数组元素不重渲染（我的第一版探针即踩此坑）。rewind/branch 真实路径重建消息数组，符合契约。
- confidence: high。

## ⑤ TUI 增量 kitty 集 × 删图：干净（正控×4）

- updateKittyImageIds（tui.ts:1482-1502）以 firstRawDiff 为界做旧减新加；[0, firstRawDiff) 区间 newLines[i]===previousLines[i] 由构造保证。四个提交点全部配对调用，fullscreen 路径不触碰该状态（renderFullscreen 无 kitty 簿记，inlineState 快照引用不会被异地改写）。
- **正控**（p45c.mts / p5d.mts）：
  - P5a 删图行 → writes 含 `\x1b_Ga=d,d=I,i=5,q=2\x1b\\` 删除序列；
  - P5b 后续无关改动不再重删 id 5；
  - P5c 改动发生在图行之上的同时删图 → 删除序列仍发出（expand 路径正常）；P5c2 同 id 重新加回 → 正常重新放置；
  - P5d 内部态直查：删图后 previousKittyImageIds 与 kittyImageIdCounts 均清空（无残留）；P5e 同 id 两行放置删其一 → 计数 2→1，集合保留（引用计数正确）。
- 附带观察（预存，非本批回归）：deleteChangedKittyImages 按 id 全局删除，同一 id 两处放置时只重绘 changed region 内的放置，region 外的放置被删不重绘——84d3b31e9 之前即如此。
- confidence: high。

## 探针清单（/tmp/audit_r/round-35/probes/）

| 文件 | 覆盖 |
|---|---|
| p1p2.mts | ① 正控 + ② 打穿（重复 thinking_end、冲突诊断错归因） |
| p2b.mts | ② 打穿主证（B 块 signature 残留 rs_A 至回放） |
| p3.mts / p3c.mts | ③ completions / codex keep-alive 正控 + 缺终止事件正控 |
| p45c.mts | ④ P4a-c + ⑤ P5a-c |
| p5d.mts | ⑤ 内部态直查 + 共享 id 引用计数 |
| dbg.mts / dbg2.mts | 过程件（LineAggregator 数组引用契约的排查） |
