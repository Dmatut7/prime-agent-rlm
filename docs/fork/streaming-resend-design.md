# 流式全量重发设计稿（2026-10-03，wave-20 W20-E，HEAD=342cd3ca2）

来源：swarm-loop-plan-20261001.md 文档-3 [P1]（:115、:204），原始登记 docs/fork/audits/2026-09-14-fixes.md PERF-STREAM（:139-144）。本文只做设计与量化，不改代码。

## 一、先纠正前提：线上全量重发大头已修，剩的是三条精确的腿

9-14 登记的「默认交互式 TUI 走直连 worker 通道、紧凑增量被旁路」已在 9-15 修掉（`1b7cc8468` "stop resending the whole stream on every delta"，连同 `c72b9940f`/`72942804b`/`f3f5f07db`/`7df44f073`）。commit 实测：100k 字符回答 2.64GB→3.6MB、worker CPU 6.2s→23ms；100k 工具参数 125.7MB→0.44MB。本文实测（§二）与之一致。**再按「TUI 主链路全量重发」立项会修错地方**——这与 9-14 复算修正（同文件 :157-160，撤回 buildSessionContext 误立项）是同一教训。

HEAD 上的真实状态：

**已增量化的链路（验证过代码路径）**

- worker→supervisor：private-framed + role=supervisor ⇒ 恒走紧凑 delta（`compact-session-stream.ts:32-44` `planCompactAssistantDelta`），工具参数走 fragments（supervisor 在 `worker_subscribe` 声明 `streaming_delta_fragments`，`daemon-supervisor.ts:4987-5004`）。
- worker→TUI 直连：TUI attach 声明 `streaming_deltas`+`streaming_delta_fragments`（`daemon-agent-connection.ts:562-581`），worker 写侧按 (client, session) 能力逐客户端选编码（`daemon-mode.ts:9475-9493`），直连帧支持 `assistant-delta` 编码（`daemon-worker-client.ts:349-391`）。
- supervisor 转发：有能力的客户端吃 worker 原始紧凑字节（零重序列化，`daemon-supervisor.ts:9116-9122`）；reconstruct 每 delta 只做浅拷贝（`compact-session-stream.ts:312-321`），全量 `message_update` 的序列化只在存在 legacy 客户端时发生一次、全体共享（`daemon-supervisor.ts:9032-9034` + `sessionNeedsRebuiltStreamPayload` :9161-9174）。
- 事件体形：`slimSessionEventForWire` 早已剥掉嵌套 `partial`（`daemon-extension-binding.ts:31-47`，2026-06 #117 落地），legacy 行只带一份全量消息。

**仍然全量/二次方的三条腿（本文实测，§二）**

- R1 · legacy 客户端腿：attach 不带 `streaming_deltas` 的客户端 ⇒ supervisor 每 delta 重建+序列化全量 `message_update` 写给它。三方 jsonl 客户端是此腿的实例。（2026-10 更新：本文成文时用作一方实例的 `prime-agent daemon attach` 监控 REPL 已随 daemon 前缀命令面一并删除——该前缀上游早已由 REMOVED_COMMAND_NAMES 拒绝，CLI 侧只是清掉死代码；协议腿本身保留。）
- R2 · 半新客户端腿：有 `streaming_deltas` 无 `streaming_delta_fragments` ⇒ `toolcall_delta` 带全量已解析参数快照（`compact-session-stream.ts:85-94`）。HEAD 上一方消费者全部声明了 fragments，此腿仅为协议地板存在，但放大系数与 legacy 同阶（实测 6274×）。
- R3 · 渲染腿（TUI 进程内，与 wire 无关）：流中的**最后一个 markdown 块**永不进缓存、每帧全量重 lex+渲染（`markdown.ts:421-424` 注释明示原因：未闭合 fence/生长中 list 会被追加文本重解释）。单块答案（一整段、一个未闭合 ```fence、一张大表格）⇒ 每帧 O(已累积) ⇒ 整答 O(n²)。多块答案靠前缀 lex 缓存 + per-block slots（`markdown.ts:364-378`、:421-452）接近线性。
- R4 · 帧成本随会话总长线性涨：每帧 `render(width)` 走全组件树 + raw 前缀指针扫描 O(总行数)（`tui.ts:2120`、:2143-2150 已把 normalize/diff 收敛到变化区）。9-14 实测空帧 0.004ms→5.45ms（0→36000 行）。已落盘的轮次永远不释放出活树。

## 二、实测（HEAD=342cd3ca2，驱动真实模块，脚本 /tmp/w20e/，未入仓）

方法：wire 腿直接调 `createCompactAssistantDelta`/`serializeJsonLine` 逐 delta 计量；渲染腿驱动真 `Markdown` 组件（identity theme，width=100，每 50 字符一帧 ≈ 60fps 合帧后的真实帧率）。delta 粒度取 8/20/50 字符——真实 token delta 均值 3-8 字符，8 列即现实最坏档。

**文本回答，全流 wire 字节（放大系数 = 总字节/最终回答字节）**

| 回答 | delta | legacy 腿（R1） | compact 腿 |
|---|---|---|---|
| 20k | 8 | 25.12MB（1317×，53ms 序列化） | 0.36MB（18.6×） |
| 20k | 20 | 10.07MB（528×） | 0.15MB（8.1×） |
| 100k | 8 | 602.45MB（6317×，1134ms） | 1.78MB（18.6×，4.4ms） |
| 100k | 20 | 241.07MB（2528×，459ms） | 0.77MB（8.1×） |
| 100k | 50 | 96.51MB（1012×，190ms） | 0.36MB（3.8×） |

**工具调用参数（100k JSON 串参数）**

| delta | legacy | snapshot 模式（R2） | fragments 模式 |
|---|---|---|---|
| 8 | 603.08MB（6324×） | 598.34MB（6274×） | 1.82MB（19.1×） |
| 20 | 241.32MB（2530×） | 239.42MB（2511×） | 0.79MB（8.3×） |

与历史数字的关系：9-14 的 1.14GB（11371×）介于本文 8 字符档（602MB，`partial` 已单份化）与更细粒度/双份形态之间，方向与同阶性一致；`1b7cc8468` 的 2.64GB 同理（其语料 delta 更细）。放大本质是 O(n²/2d)，d=delta 均长。compact 腿的 18.6× 是固定封套（每 delta ~140B 的 type/id/event 包装）在小 delta 上的占比，绝对量无害（100k 回答 1.78MB）。

**渲染腿（`Markdown.setText`+`render` 逐帧累计 CPU）**

| 形态 | 5k | 10k | 20k | 40k | 80k |
|---|---|---|---|---|---|
| 单段（无空行） | 67ms | 218ms | 879ms | 3513ms | **13979ms** |
| 多块（每 ~400 字符一空行） | 7ms | 13ms | 35ms | 99ms | 309ms |
| 单个 ```fence | 55ms | 206ms | 854ms | 3313ms | **13924ms** |

单段/fence：文本 ×16 ⇒ 时间 ×208，教科书 O(n²)；80k 时后段单帧 ~35ms，已突破 16ms 帧预算（`tui.ts:461`）。多块：×16 ⇒ ×44，残余增长主要是每帧对前缀的 O(n) `startsWith` 校验（`markdown.ts:366`）——常数小 45 倍，但严格说也是 O(n²)。

## 三、同行佐证（2026-10 定稿，均带失败模式处理）

- **Codex PR openai/codex#50207**（2026-10-02 合入，"Release stable Markdown tables into scrollback during streaming"）：流式期把已稳定的顶层 markdown 块（表格）提前释放进 scrollback，跨增量/全量渲染追踪已完成块边界；**关键失败模式：迟到的 reference-link 定义会改判已释放内容 ⇒ 回答完成时触发一次 scrollback reflow**。与本仓 lexCache 的约束逐字同构（`markdown.ts:224-230`：含 links 定义即禁用前缀复用）。
- **Gemini PR google-gemini/gemini-cli#29568**（2026-10-01 合入，修复 #28357）：append-only delta patching（`$patch`/`$rewindTo` 记录替代全量 messages 数组）+ 有界历史窗口（内存 `MAX_HISTORY_MESSAGES=50`，老消息按需重建）+ WeakRef/digest 比较替代逐轮 JSON.stringify。判词：**持久化与内存都按 append-only + 窗口化收敛到 O(n)**。

两家共识：增量协议解决 wire，块/帧释放解决渲染，窗口化解决长尾内存与回放。三者互补，不是互斥选项。

## 四、可选方案与各自失败模式

### 方案 A · 增量协议补齐（消灭 R1/R2）

做法：一方客户端全量声明 `streaming_deltas`+`streaming_delta_fragments`。具体只有一处：`daemon-command.ts` 的监控 REPL——它不渲染正文，声明能力后丢弃 delta 即可（或更彻底：新增 `streaming_suppress` 能力，连 delta 都不发）。

失败模式：
- 能力错位：旧客户端连新 daemon（或反向）⇒ 已由 capability 门与重建兜底覆盖（`daemon-protocol.ts:1988` 兼容映射）；新增能力值须按仓规 bump `DAEMON_SCHEMA_REVISION` + 更新双向兼容测试。
- reconstructor 失步 ⇒ 已有 `scheduleCompactCatchup`（`daemon-supervisor.ts:9176`）自愈。
- 三方 jsonl 客户端无法强制升级 ⇒ 永远存在；只能文档化 + 接受（其成本由 supervisor 单侧承担一次序列化，且只在有 legacy 在场时发生）。
- `streaming_suppress` 这类新能力扩张 wire 形状测试矩阵；收益（省 delta 封套字节）对小 delta 场景约 18×，但绝对量小，**建议不做**，监控端声明现有能力并丢 delta 已够。

### 方案 B · 帧/块释放（消灭 R3，缓解 R4）

做法（Codex 范式本地化）：把「密封」粒度从块推进到**行**——fence 内每过一行硬换行即密封该行（fence 无 inline 构造，密封安全）；段落内密封到最后一个已完成 inline token 边界之前的已换行行；含 reference-link 定义的文档退化为现状（全文可重判），回答完成时做一次性 reflow 终判。

失败模式：
- 迟到 reference-link 定义改判已密封行（Codex 同病）⇒ 继承 lexCache 现有判据：文档含 links 即不密封；完成帧 reflow 一次。
- 宽度变化要求重排已密封内容 ⇒ 密封 ≠ 销毁，源文本保留，resize 走现有 invalidate 全量重渲染（`markdown.ts:340-348` 已是这条路径）。
- 未闭合 inline 构造（`**` 早开晚闭）横跨密封线 ⇒ 密封判据必须含「无未闭合 inline 构造」，否则已密封行样式被后续文本改判——这是本方案唯一真正的正确性风险，测试要压在跨行粗体/链接/数学上。
- OSC133 区标与选择区按渲染产物计算（`assistant-message.ts:335-348`），密封行不得冻结过期区域元数据。

### 方案 C · 窗口化（消灭 R4）

做法（Gemini 范式本地化）：活组件树只保留尾部窗口（N 条消息或 M 行），更老内容从会话文件按需回填——attach 侧已有同构机制可复用（`slim_attach_transcript` 尾窗 + `messagesOmitted` + get_messages 分页，`daemon-agent-connection.ts:574-579` 注释链）。

失败模式：
- 上滚进入已逐出区域需要懒回填 UX，fullscreen viewport 与 inline scrollback 两条渲染路径都要接；
- 在飞工具组件与 turn box 跨窗口边界（一个未闭合 turn 的头在窗外）；
- 选择/复制跨窗口内容；
- 终端 scrollback 与组件树分叉（用户上滚看到的是终端的，回填的是我们的）。
- 成本高、侵入大，且 R4 的现实痛度（5.45ms/帧 @36k 行）尚低于 R3（35ms/帧 @80k 单块）。

## 五、推荐与迁移顺序

按「收益/风险」排序，每步独立可验证、可回滚：

1. **R1 快杀（方案 A 最小版）**：`daemon-command.ts` 监控 REPL 的 attach 声明 `streaming_deltas`+`streaming_delta_fragments`，message_update/assistant_stream_delta 处理器维持现状（丢正文）。无 wire 变更、无 schema bump——只是让一方客户端声明早已存在的能力。先红后绿：测试断言该客户端 attach 后 supervisor 不再走 `sessionNeedsRebuiltStreamPayload=true` 分支（可观测：delta 字节上界与回答长度无关）。
2. **R3 行级密封（方案 B）**：Markdown 组件加行级密封缓存，判据=「硬换行已过 且 无未闭合 inline 构造 且 文档无 links 定义」。失败回退=env 关断回现状（密封层是纯缓存，关掉即旧行为）。测试压：跨行粗体/链接/fence/表格/迟到 links 定义的逐字恒等（对照全量渲染）。
3. **R4 窗口化（方案 C）暂缓**：等 1、2 落地后重测帧成本基线再拍板；若做，复用 slim_attach_transcript 的窗口感知协议，不动 daemon wire 类型（纯客户端树管理）。
4. **R2 不动**：fragments 已是默认路径，snapshot 模式作为协议地板保留给跨版本兼容，无一方消费者触发；登记为已知放大器即可。

显式不做：`streaming_suppress` 新能力（收益小、测试矩阵变大）；对 legacy 腿做限流/降频（破坏协议语义）；改 daemon wire 类型（本次纪律红线）。

## 六、A/B 数字目标（基线 = §二本文实测）

| 指标 | A（现状 HEAD） | B（目标） | 量法 |
|---|---|---|---|
| 监控 REPL 旁观 100k 回答的 wire 字节 | 96.5–602MB（粒度相关） | ≤ 2MB（≈ payload 2×） | /tmp/w20e/wire-bytes.mts 复跑 + 集成测试断言 |
| supervisor 每 100k 回答的重建序列化 CPU（仅 legacy 在场时发生） | 190–1134ms | 0（无 legacy 时恒为 0；有 legacy 时仍是每 delta 一次、全体共享） | 同上 serialize 列 |
| 80k 单段/fence 回答全流渲染 CPU | 13.9s | ≤ 1.5s（多块档 0.31s 的 5 倍余量） | /tmp/w20e/render-markdown.mts 复跑 |
| 流式期单帧 p95（100k 单块回答，width=100） | ~35ms（80k 后段） | ≤ 16ms（帧预算） | 同上改逐帧直方图 |
| 密封正确性 | — | 与全量渲染逐字恒等（含 links/fence/跨行 inline 语料） | 渲染快照对拍 |
| 帧成本 @36k 行（R4，若做） | 5.45ms（9-14 实测） | ≤ 1ms | 9-14 同款帧计时复测 |

回滚线：任一步 B 档未达且回归超 2 周，退到上一个已验证阶段；密封层留 env 关断。

## 附：复现

```bash
# 仓根，只读源码 + /tmp 脚本，不碰 ~/.prime
node_modules/.bin/tsx /tmp/w20e/wire-bytes.mts
node_modules/.bin/tsx /tmp/w20e/render-markdown.mts
```

脚本驱动仓内真实模块（`compact-session-stream.ts`、`jsonl.ts`、`markdown.ts`），合成负载为等长 ASCII 填充；真实 token delta 更细碎，legacy 腿实测只会更高（9-14 线上 1.14GB vs 本文 8 字符档 602MB）。
