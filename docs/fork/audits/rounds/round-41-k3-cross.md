# round-41 K3 交叉深审：c060eb1a1..HEAD（增量 lexer 33eb05dff + K3Q-3 1b40c5b3e）

审查席：K3。仓库只读（零写入）；探针与 pristine 复验均在 /tmp/audit_r/round-41/ 下，pristine 树用 `git archive <sha> | tar -x` + node_modules 软链构建。
审计范围含 TC 修复核查：c060eb1a1..HEAD 实际落地仅此两个代码提交（其余为 docs/merge），无独立 TC 修复提交并入。

---

## ① 增量 lexer（33eb05dff）— 判为正确，附 1 个既存渲染层新发现

### 1. cut 判据对"EOF 切 list 再回并"形态 —— 实证安全

打穿输入（token 层差分，byte-by-byte 流式，比对 `Markdown.lex()` 的 token 流 vs 全新组件全量 lex 的 token 流，含 type+raw+links 签名）：

- 400 篇随机文档 × 逐字节帧 = **60285 帧，0 分歧**；其中 **29296 帧确认走了增量复用**（monkeypatch `Marked.prototype.lexer` 记录输入长度，尾部长度 < 全文长度即复用 —— 正控：测试不是平凡通过）。
- 片段池专为已知不稳形态构造：loose list（`- a\n\n- b\n\n- c`，marked 会跨空行并成一个 list —— 即 r40 诊断的"EOF 切三段后回并"族）、list 带空行缩进续行、blockquote 跨空行重并（`> a\n\n> b`）、html 块、未闭合 fence、setext、表格、math 块扩展、链接引用后置定义、CRLF/孤 CR。
- 机制：`isStableLexBoundary` 要求 cut 前两字符为 `\n\n`、tail 首字符非空白、**最近非 space 保留 token 不是 list/html** —— list/html 的"回并"只能向 cut 之后（tail 每帧全新 lex，增长天然正确处理），向 cut 之前的回溯被该排除项封死。

哨兵探针（guard 有效性正控）：对 loose-list 文档与 html 文档逐字节流式，复用确实发生（45、38 帧），但 **cut 从未落进 list 区域内部/之后（badTail=0）、html 区域内部/之后（bad2=0）**。

### 2. CR 归一与 offset —— 正确

- marked 18.0.7 `Lexer.lex` 内部本就 `replace(\r\n|\r → \n)`（node_modules/marked/lib/marked.esm.js 实证）；不在组件侧先归一，token raw 就无法平铺输入串，computeLexCut 的 tiling 校验（`pos !== text.length → cut=0`）会整体回退全量。组件前置归一后 raw 精确平铺，渲染结果与旧路径等价（旧路径 marked 内部做同一替换）。
- 帧尾孤 `\r` 跨帧（`...a\r` → `...a\r\n`）：归一后文本逐字节相同，startsWith 与前缀复用语义正确；fuzz 池含 CRLF/孤 CR 片段逐字节切分，0 分歧。
- 附带核掉一个理论坑：marked `blockTokens` 会把 raw.length===1 的 space token 并入前一 token.raw；cut 判据要求 cut 前是 `\n\n`（space 至少长 2、独立成 token），该合并不可能跨越 cut —— token 层 fuzz 0 分歧实证。

### 3. fresh-full oracle 覆盖评估（随仓 test/markdown-incremental-lex.test.ts）

覆盖：流式逐帧等价（12 篇 × 随机步长）、头/中/截断编辑回退、宽度切换、链接引用回退、CRLF、tab、math、未闭合 fence；成本测试有"无边界单段文档"线性对照（好设计）。

漏的/弱的：
a. **对比渲染行而非 token 流**：token 层分歧若渲染恰好相同会被掩盖（本次用 token 层差分补强，0 分歧）。
b. **oracle 不能隔离 lex 层**：渲染层自身有流式状态依赖（见 F1），种子不巧时该测试会被既存渲染 bug 打红（误报），当前固定种子未踩中。
c. 随机步长 1..40 非逐字节；片段池无 loose list / blockquote 重并形态（本审已补测）。
d. 性能断言（3× 比率 + 20ms 绝对界）机器相关，但余量极大，可接受。

### 4. 新发现 F1（既存 bug，非 33eb05dff 引入； pristine c060eb1a1 复现）

**blockCache 键不含 `text`，marked EOF list 截断语义差异导致持久渲染错误。**

- marked 对 `para\n    lazy\n- ` 与 `para\n    lazy\n- l` 给出的 paragraph token **raw 完全相同**（`"para before lazy\n    lazy continuation arriving later\n"`），但 **text 不同**（被裸 `-`/`- ` 截断时 lazy 行缩进被剥掉；被 `- l` 截断时保留）。
- blockCache 键 = `width|type|nextType|raw` → 帧 N（`- ` 结尾）缓存的"剥缩进"渲染在帧 N+1（`- l`）被同键命中；且此后该 paragraph 的 raw 与 nextType 永不变化 → **错误渲染持续到流结束，不自愈**。
- 最小打穿输入：流式渲染 `"***\n\n\npara before lazy\n    lazy continuation arriving later\n- "` 后追加 `"l"`，对比全新渲染：got ` lazy continuation…`（缩进丢失 + 多一空行），want `    lazy continuation…`。
- pristine（c060eb1a1，无增量 lex）同样复现 → 属渲染层既存缺陷，与本次落地无因果；33eb05dff 既未引入也未加重（token 流证明逐帧一致）。建议单开修复 lane（候选修法：键加 `token.text` 哈希，或末两块不进 cache）。
- 次要观察：lexCache.prefix 为整段前缀字符串拷贝，流式期间每个 Markdown 组件多一份 ≤文档大小 的内存（800k transcript 即 +≤800KB/组件）；流结束后 lexCache 仍持有 —— 可接受，记录在案。

---

## ② K3Q-3 deferred 记账（1b40c5b3e）— 判为正确，3 条有界残余

### 1. lastSkippedAt 与 resume 语义 —— 无干扰（实证）

`lastSkippedAt` 全仓 5 处出现：3 处写入（claimDue 并发去重、skipped 分支、deferred 分支）+ `formatAgentCronJob` 展示 + 类型定义。**无任何调度/判定逻辑读它** → 窗口释放后 resume 语义不被 skipped 干扰。✓

### 2. recurring 下一槽计算 —— 不被 skipped 干扰（实证）

deferred 分支用 `nextRunAtForSchedule(schedule, now)`，与 ran/skipped 分支同一公式：interval 从 defer 时刻 +interval、cron 表达式取 now 之后下一槽；跳过的槽不补跑、不堆积、不错相。长暂停探针（心跳 every 30s，窗覆盖 12:34:30–12:36:00）：12:34:30/12:35:00/12:35:30 三次 defer，相位 30s 保持、runCount 恒 0；释放后 12:36:00 恰好跑一次，nextRunAt 12:36:30。✓

### 3. once 的 5s 重试在长暂停窗 —— 无热自旋、不饿死（实证）

- 每次 defer 置 nextRunAt=now+5s → `scheduleNext` 的 setTimeout ≥5s，**无零延迟自旋**（修复注释声称的动机成立）。
- 拒绝发生在入队/投递之前（`_admitSessionInput` 顶部先查 pause lease、committing-owner 检查在 `enqueue` 之前 —— 源码实证），dispatch lane（按 activeSessionId 串行）立即释放，runDue 内各 dispatch `Promise.all` 并发 → **不饿死其他任务**。
- 长暂停探针：once 任务 12:35:00→05→10→15→30 连续 defer 保持 active/runCount=0，窗释放后恰好运行一次变 completed。✓
- queueDispatch 在 cron-jobs.ts 层也 catch retryable refusal → hook 未吸收时同样 deferred，双保险。✓

残余（均有界，不阻塞）：
a. 每次 defer 都走 `recordDispatchResult` → 持久化 JSON 写盘；暂停窗内每个卡住的 once 任务 ~12 次/分钟写盘。有界 churn，记录在案。
b. **无最大 defer 次数**：永不释放的窗口会让 once 任务无限 5s 重试（修复前是直接烧成 completed；新行为严格更好，但无护栏）。
c. `SessionInputSuspendedError`（retryable=true 的普通 abort 悬挂）不在 `isRetryableSessionInputRefusal` 内。核查结论：排队调用者走 `_admitSessionInput` **不会**收到它（动作入队停放，不抛错）；它只从 `_assertSessionActionAdmissionAvailable` 抛给直接调用者；heartbeat 路径由 `shouldDeferHeartbeatCronJob`+`wakeSuspendedSessionInput` 先行处理。**待核残余**：update-restart 围栏形态（retryable=false）若能到达 runCronJob 的 followUp/promptUntilAccepted 路径，会被当 "ran"+error 烧掉——注释称围栏场景队列由 restart manifest 持有且进程即将退出，影响有限；建议后续 lane 实证可达性后定级。

---

## ③ 红测复验（pristine 实测）

| 测试 | pristine | HEAD | 结论 |
|---|---|---|---|
| lexer 成本测试 | **红**：`sectioned median 31.61ms should be well under the no-boundary control 47.93ms`（比率 0.66≈1，阈值 <1/3）；c060eb1a1 archive + 拷入新测试 | 绿（4/4） | 真红 ✓ |
| lexer 等价性三测 | 绿（平凡：pristine 恒全量 lex，自身对自身） | 绿 | 回归闸性质，非红测 |
| K3Q-3 vitest（3 测） | 仓外行为探针红：once 被拒后 `status=completed, runCount=1, lastError=有值`（烧 run bug 复现）；随仓测试文件在 pristine 是 import 级红（`CRON_DEFERRED_RETRY_MS` 不存在，较弱） | 绿（3/3）+ HEAD 行为探针：`active, runCount=0, lastSkippedAt 戳记, nextRunAt=+5s` | 真红 ✓（行为级由仓外探针补证） |

正控齐备：lexer 复用确发生（29296/60285 帧 + guard 哨兵）；cron 窗释放后 once/heartbeat 恰好各跑一次（随仓测试正控 + 本审长暂停探针）。

---

## 结论

- **33eb05dff（增量 lexer）**：cut 判据对"EOF 切 list 再回并"形态实证安全（60285 帧 token 级零分歧 + guard 哨兵）；CR 归一正确；oracle 的弱点是渲染行级对比 + 未隔离渲染层，已用 token 层差分补强。**随带挖出既存渲染层 bug F1（blockCache 键缺 text，持久渲染错误，pristine 复现）**，建议单开 lane。
- **1b40c5b3e（K3Q-3）**：记账语义全部实证正确（不烧 run、resume 无干扰、5s 有界无自旋不饿死）；3 条有界残余（defer 写盘 churn、无重试上限、update-restart 围栏形态的可达性待核）。
- 两条红测均真红（lexer 性能界在 pristine 实测红；K3Q-3 烧 run bug 在 pristine 行为级复现）。

探针与 pristine 树：/tmp/audit_r/round-41/{k3-lex-probe,pristine-lex,pristine-cron}（仓外，仓库零写入）。
