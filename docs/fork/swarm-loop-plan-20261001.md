# Swarm 循环整治计划（2026-10-01）

来源：11 路并行子代理（7 路代码审查 + 4 路联网调研）。本文档是「审查→调研→计划→修复→再审」循环的计划层产物与波次台账。

## 循环编排设计（采纳调研结论）

- 骨架：orchestrator-workers fan-out/fan-in（Anthropic 推荐主结构），阶段间用确定性 gate 而非 LLM 路由。
- 修复环节按**文件所有权**分片，一批一片互不写同一文件；`agent-session.ts` 等热点文件单批独占。
- 修复子代理不 commit；全部绿了之后由主席分批提交（遵守共享 worktree 纪律）。
- 再审 = 下一轮审查集群对照本计划逐项核验；同一问题连续 3 轮不收敛则升级给用户。

## 波次 1 修复批次（6 批，并行）

| 批 | 范围（独占文件） | 修的问题 |
|---|---|---|
| A 中断 | self-recovery.ts / agent-session.ts / settings-manager.ts / autonomous.ts | 中断-1,2,4,5；智能-2 的 loop 侧 |
| B 命令 | cli/args.ts / cli/daemon-command.ts / command-registry.ts / interactive-mode.ts / daemon-mode.ts / docs/usage.md | 命令-1,2,3,4,8；体验-2,3,8 |
| C 显示 | components/footer.ts / tui.ts / inline-markdown.ts / {user,assistant,slash-command}-message.ts | 显示-1,2,3,5 |
| D 体验 | main.ts / session-lease.ts | 体验-1,4,5,6 |
| E 记忆 | prime-agent-runtime (repl.py, harness.py) / session-manager.ts | 记忆-1,6,8；文档-4 的注入排序 |
| F 模型智能 | packages/ai (transform-messages.ts, anthropic.ts, openai-responses-shared.ts, openai-completions.ts) / provider-fallback.ts | 智能-1,2,6,7,8 |

## 波次 2+ 待办（登记）

- 中断-3（stall watchdog 默认 abort）、中断-6（worker 失联丢 turn 自动恢复）、中断-7（autonomous 默认预算）、中断-9（overflow 二次恢复）、中断-10（quota park TUI 倒计时）
- 显示-4（/context 窄终端）、显示-调研（终端宽度画像 + mode 2027 探测——需设计）
- 体验-7（-v 语义）、体验-9（键位文档）
- 记忆-2（compaction prune 内核变量的用户可见性，agent-session.ts）、记忆-3（`<read-files>` 死机制：接上报或下线）、记忆-4（/tree 分支摘要带 fact/user-request 账本）、记忆-5（emergency shrink 断 ledger 链）、记忆-7（后台线程脏追踪）
- 智能-3 已并入批 A（length 续写）；智能-4（跨模型 thinking 平铺只留最近一回合）
- 文档-1（泵孤儿丢输入）、文档-2（/context 缓存漏 charge）、文档-3（流式全量重发，需设计）、文档-5（会话/磁盘回收器）、文档-7（机器块伪造加固）、文档-8（daemon unhandledRejection 放大器）、文档-9（重试语义簇）、文档-14（bounded-cache 幽灵字节）、文档-16（子代理配额）等其余文档条目按 P2 排期
- 安全簇：文档-12（供应链校验）、文档-13（traces 上传零脱敏、auth.json 0644）—— 需用户拍板后做

---

## 发现清单（按域，含证据指针）

### 域 1：自动化中断（为什么模型干一会就停）

- 中断-1 [P1] provider 重试预算 3 次用尽即整轮终止，无收尾续跑 — agent-session.ts:19958、settings-manager.ts:3001
- 中断-2 [P1] Retry-After >60s 直接放弃（`exceeds-cap` 终止）— agent-session.ts:19992、settings-manager.ts:3110
- 中断-3 [P1] stall watchdog 默认 warn-only 永不杀挂死 turn — settings-manager.ts:91、agent-session.ts:1496
- 中断-4 [P1] self-recovery nudge 每 prompt 上限 2 次 + 问句/offer 豁免过宽 — self-recovery.ts:35,92-146
- 中断-5 [P1] `stopReason:"length"`（输出截断）无任何续跑路径 — agent-loop.ts:1036、self-recovery.ts:128
- 中断-6 [P1] worker 失联 5 分钟自杀，在跑 turn 直接死不恢复 — daemon-mode.ts:370-375,997-1021
- 中断-7 [P1] autonomous 默认 maxTurns=12/maxTokens=80k/30min，与「干到完成」预期不符 — autonomous.ts:56-63
- 中断-8 [P2] 空响应重试链耗尽后仅 1 次恢复轮 — agent-loop.ts:802-817、agent-session.ts:7427
- 中断-9 [P2] overflow compaction 恢复只试一次 — agent-session.ts:15218-15228
- 中断-10 [P2] quota park 期间 TUI 完全静默无倒计时 — agent-session.ts:21017-21065

调研对策（RESEARCH-持续执行）：turn 结束边界加结构化判官闸门（Claude Code Stop-hook / OpenHands run_goal 模式）；`length`/`pause_turn` 自动续跑；失败分类后「nudge 并续跑」第三态；续跑必须有显式上限与降级链。

### 域 2：命令

- 命令-1 [P1] `send --steer/--follow-up` help 声明了却报错；协议 `deliveryMode` 字段写了一半 — command-registry.ts:47-54、daemon-command.ts:990、daemon-protocol.ts:877、daemon-mode.ts:5004
- 命令-2 [P1] `--mode` 非法值完全静默，管道场景误入 TUI — args.ts:177-181
- 命令-3 [P1] 十余个无参斜杠命令带参时整句发给模型（`/share` `/copy` `/session` `/fork` `/tree` 等）— interactive-mode.ts:5872-5964
- 命令-4 [P2] 已知选项的 `--flag=value` 形式静默失效 — args.ts:370-383
- 命令-5 [P2] 前置 `--daemon-socket` 只对 stop/rename 归一化 — public-command.ts:165-176
- 命令-6 [P2] usage.md 多处与实现不符（/export jsonl、/traces upload、shell 命令清单、footer 默认值）
- 命令-7 [P2] daemon-command 内部子命令不可达但报错文案引用隐藏语法
- 命令-8 [P2] `/export "未闭合引号` 静默改用默认路径 — interactive-mode.ts:12685-12712

### 域 3：显示

- 显示-1 [P1] footer 工具错误徽章用 `.length` 量宽（CJK 少算 4 列）→ 超宽行在 inline 模式崩进程 — footer.ts:494,501、tui.ts:2417
- 显示-2 [P1] inline-markdown `splitInline` O(n²) 且无长度护栏（tl2 FIX-D 硬门槛漏落地）— inline-markdown.ts:59、tl2 任务书 :75
- 显示-3 [P2] 单行消息 OSC133 区标倒序（B,C,A），三处 — user-message.ts:301、assistant-message.ts:339、slash-command-message.ts:54
- 显示-4 [P2] /context 树窄终端（<62 列）错乱 + 模型名 `.length` 对齐 — interactive-mode.ts:13358、context-tree-format.ts:181
- 显示-5 [P2] inline 渲染遇超宽行直接 `exit(1)`（与 fullscreen clamp 不对称，是显示-1 的放大器）— tui.ts:2398-2424、daemon-mode.ts:816
- U6 窄档约定整体被遵守，破洞仅上述两处 `.length`

调研对策（RESEARCH-TUI）：按终端画像的宽度修正层（wcwidth corrections 范式）、mode 2027 DECRQM 探测、2026 不支持时降频、用 @xterm/headless 锁回归。

### 域 4：体验

- 体验-1 [P1] 交互路径租约冲突（SessionAlreadyActiveError）未捕获 → 未处理异常堆栈 — main.ts:1699-1705、cli-main.ts:41
- 体验-2 [P1] 会话内无 `/help`，敲了原样发给模型烧 token — slash-commands.ts:87-217
- 体验-3 [P1] 指引文案指向不存在的 `--no-daemon` flag — interactive-mode.ts:7692,9505
- 体验-4 [P1] `--continue` 无历史会话时静默开新会话零提示 — session-manager.ts:4673
- 体验-5 [P2] SessionAlreadyActiveError 消息无补救指引（attach/list/stop）— session-lease.ts:42
- 体验-6 [P2] 跨项目 resume 不提示「去原目录继续」第三选项 — main.ts:547-553
- 体验-7 [P2] `-v` 占为 version、verbose 无短选项（与 CLI 惯例相反）— args.ts:173,364
- 体验-8 [P2] 会话找不到时不分模式建议「按左箭头」— main.ts:1467
- 体验-9 [P2] Esc 双职责/ctrl+y 冲突/ctrl+s 流控的文档缺失 — keybindings.md

### 域 5：记忆/召回

- 记忆-1 [P1] 转录坏行静默跳过且 `transcriptLineSkips` 无消费者；链截断/firstKept 未命中无告警 → 坏行之前历史全丢 — session-manager.ts:921-979,1044
- 记忆-2 [P1] 每次 compaction 物理删除活内核 >16MB 变量，仅模型可见用户不可见 — agent-session.ts:13113、repl.py:1350
- 记忆-3 [P1] `<read-files>` 机器块是死机制（无实时 read 记录源，文档承诺恒为空）— compaction.ts:106、utils.ts:77-97、compaction.md:261
- 记忆-4 [P1] /tree 分支摘要无 fact-appendix/user-requests，走逐字存活率 4% 的纯叙述通道 — branch-summarization.ts:431、compaction.md:255,369
- 记忆-5 [P2] emergency shrink entry 无 details → ledger 链结构性断代 — agent-session.ts:15418、compaction.ts:1796
- 记忆-6 [P2] `_` 前缀内核变量静默不持久化、不进 skipped 报告 — repl.py:1144
- 记忆-7 [P2] 后台线程原地修改对快照脏追踪不可见 — repl.py:981-984
- 记忆-8 [P2] harness 记忆召回 = 摘要窗口（每类 20 条×120 字符）+ 纯词面搜索，窗口外等于不存在 — harness.py:1241-1365、agent-session.ts:14441
- 文档-4 [P1]（与记忆-8 同域）记忆注入排序第一维是 path ⇒ 默认 path 下 45.8% 新记忆永不进注入面 — 2026-09-14-fixes.md:439-448

调研对策（RESEARCH-记忆召回）：不引入 mem0/embedding 栈；harness memory 升级「索引+主题文件」两层并加「代码可推导者不写」负向约束；加 grep 式跨会话检索工具（just-in-time）；compaction 前加确定性 tool-result clearing + 触发时写结构化笔记。

### 域 6：模型智能

- 智能-1 [P1] abort harvest 白做：中止回合的工具部分结果在 transformMessages 被剥掉丢弃 — agent-loop.ts:222-296、transform-messages.ts:241-269
- 智能-2 [P1] Anthropic `pause_turn` 映射为 stop 且无 resubmit — anthropic.ts:1533
- 智能-3 [P1] length 截断无续写（同中断-5，合并修）— simple-options.ts:6
- 智能-4 [P2] 跨模型切换全历史 thinking 平铺成正文，fallback 链放大 — transform-messages.ts:146-153
- 智能-5 [P2] prompt 禁 `.get()` 但运行时 `_RecordAccess` 显式支持（prompt 撒谎）— rlm.ts:228,241、runtime __init__.py:15
- 智能-6 [P2] `isBadToolCall` 把合法零参数调用计入 bad-call 风暴误触发换模型 — provider-fallback.ts:315-322
- 智能-7 [P2] OpenAI Responses 回放损坏 thinkingSignature 无 try/catch 炸请求构建 — openai-responses-shared.ts:167
- 智能-8 [P2] `requiresThinkingAsText` 用数组拼 content，踩同文件刚记录的 NIM 递归坑 — openai-completions.ts:1243

### 域 7：既有文档登记的未修问题（docs/fork 抽取，Top 部分）

- 文档-1 [P1] 泵 blocked 早退产生 selected 孤儿动作 ⇒ 静默丢一轮用户输入 — audit-20260919-findings.md:55
- 文档-2 [P1] /context 缓存命中漏 addScanCharge — audit-20260919-findings.md:72
- 文档-3 [P1] 流式增量全量重发（10 万字符回答放大到 1.14GB）— 2026-09-14-fixes.md:139（待设计）
- 文档-5 [P1] 会话与磁盘只增不减无回收器（session-artifacts 实测 6GB）— 2026-09-14-fixes.md:84-106
- 文档-6 [P1] win32 四条登记不修（X2/X3/X5/X6）— win32-known-limits.md
- 文档-7 [P1] 机器块账本可被伪造且跨代持久 — 2026-09-14-fixes.md:130
- 文档-8 [P1] daemon 任何 unhandledRejection ⇒ exit(1) 杀所有会话 — audit-findings.md:479
- 文档-9 [P2] 重试语义簇 5 条（openai-completions 不 recordStreamFailure 等）— 2026-09-14-fixes.md:114,719,728、upstream-feedback-20260913.md:725、audit-findings.md:268
- 文档-10 [P2] 计费准确性 2 条（Codex service-tier、google usage 负值）— upstream-feedback-20260911.md:651,662
- 文档-11 [P2] attach 全量转录重读 248ms — upstream-feedback-20260913.md:742
- 文档-12 [P2] 供应链无校验簇（update/install/fd/rg/PyPI 抢注）— 2026-09-14-fixes.md:482、round-36
- 文档-13 [P2] 凭证外发面（traces PUT 零脱敏、auth.json 0644）— 2026-09-14-fixes.md:376,427
- 文档-14 [P2] bounded-cache 覆盖同 key 不扣旧字节 → 涨满后永久拒收 — 2026-09-14-fixes.md:804
- 文档-15 [P2] 深/大会话边界（101k 深 RangeError、544 子会话 /context 2.2s+1.08GB）— 2026-09-14-fixes.md:170
- 文档-16 [P2] 子代理调度无并发配额/背压 — 2026-09-14-fixes.md:455
- 文档-17~25 [P2/P3] 时钟类、时间线 UI 缓修簇、F71 ledger 裸写、M2 preflight fail-open、M3(k) stderr 无预算、0913 §3/§4、omitStreamingMessages 接缝、stale-running 残留、小件 — 各源文档

### 调研-编排（RESEARCH-多代理编排）要点

orchestrator-workers + 确定性 gate；子代理任务书必须含目标/输出格式/工具边界；fan-in 产物落盘防传话失真；评审闭环挂结构化退出判据 + 跨轮反思记忆；fan-out 只用于天然独立环节，修复环节单代理+确定性验证。

## 循环记录

- 2026-10-01 波次 0：11 路审查/调研完成 → 本计划。
- 2026-10-01 波次 1：6 批修复全部完成，未 commit（改动在工作区）。各批 changelog fragment 已加。结果摘要：
  - 批A：重试耗尽→每 run 一次恢复轮（`_queueProviderFailureRecoveryTurn`）；exceeds-cap+transient→有界等待；`selfRecovery.maxAutoContinues` 可配置（默认 4）；问句/offer 豁免在有工具工作时不生效；`length` 截断自动续写。settings.md 已记录。
  - 批B：`send --steer/--follow-up` 贯通（新 capability `send_message_delivery_mode`，schema rev 40→41，digest 不变）；`--mode` 非法值报错；18 个无参斜杠命令带参拦截；25 个选项支持 `--flag=value`；/export 引号未闭合报错；新增 `/help`；`--no-daemon` 错误文案改正；usage.md 同步。
  - 批C：footer 徽章改 visibleWidth + 极窄宽度截断；inline-markdown 4KB 护栏；三处 OSC133 单行区标序修复；tui inline 超宽行从 throw(杀 daemon) 降级为 clamp+crash log。
  - 批D：交互路径 SessionAlreadyActiveError 捕获；--continue 无历史时 stderr 提示；租约冲突消息补 attach/list/stop 指引；跨项目 resume 提示第三选项；会话找不到提示按模式分文案。
  - 批E：session-manager 三处静默记忆丢失加 warn-once 日志（skips/断链/firstKept 未命中）；repl.py `_` 前缀变量进 skipped 报告；harness digest 注入排序改 updated_at 倒序 + 截断时附 id+title 目录。
  - 批F：abort harvest 工具结果折进 abort trace 不再丢弃；anthropic pause_turn→length（接上批A续跑）；isBadToolCall 仅对有必填参数的工具计空调用；thinkingSignature 损坏降级为文本；requiresThinkingAsText 改纯字符串拼接。

### 波次 1 跨批依赖（波次 2 首批处理）

1. `messages.ts` 的 `createAutoContinueMessage` 文案硬编码 "of at most 2"，与新默认预算 4 不符（批A报告遗留①）。
2. `agent-session.ts:20900` isBadToolCall 调用点需传入工具定义（批F已改签名，未接线前保持旧保守行为）。
3. `send --from <agent> --follow-up` 跨 worker 丢 deliveryMode（daemon-supervisor.ts:7231、daemon-worker-protocol.ts:135）。
4. `agent-messages.ts` :30 注释与 :211/:880 回执类型仍写死 "steer"。
5. session-manager 三处 warn 需波次 2 在 agent-session.ts/daemon 侧透出到 TUI（批E遗留①）；`SessionManager.getBranch()` 同款静默断链未修（批E遗留②）。
6. `prime-agent-runtime/src/rlm/repl.md:398-401` 文档与 E6 新行为不同步。

- 2026-10-01 波次 2：5 批修复完成并已提交推送（`3e531906b..0b8f6d932`，纯净树 tsgo EXIT 0）。daemon 已 `shutdown --force` 重启跑新 bundle（schema rev 42），`--no-session -p` 冒烟通过。结果摘要：
  - W2-A：auto-continue 文案预算参数化；isBadToolCall 接线工具 schema；无人值守 stall 恢复默认开（attached 25 分钟人窗/无客户端即介入/每会话上限 3 次）；overflow 二次恢复（force emergency shrink）；内核 prune 用户可见通知；autonomous 默认预算 20/50/400k/2h。
  - W2-B：跨 worker deliveryMode 透传；worker 死亡后 bind 时自动恢复会话（一次死亡一次恢复）；quota_park_status 事件（capability 门禁，60s 心跳，rev 42）。
  - W2-C：agent-messages 回执类型放宽；getBranch 断链 warn；`<read-files>` 接通 kernel read activities 通道（不再是死机制）；/tree 分支摘要补 fact-appendix/user-requests 账本。
  - W2-D：/context 窄终端紧凑布局 + CJK 模型名对齐；`-v`=verbose/`-V`=version；keybindings.md 三条说明；repl.md 同步；文档-14 bounded-cache 确认已在 HEAD 修复（销账）。
  - W2-E：跨模型 thinking 平铺只留最近回合，更早回合占位符。
- 2026-10-01 波次 3：3 批（判官闸门+接线+再审）完成。结果摘要：
  - W3-A：**假完成判官闸门**——root run 收尾时最后一条回复是完成声明但无证据（无验证命令跑绿记录、无证据措辞）→ 拦截并注入「给出证据/补齐再收尾」nudge（计入 maxAutoContinues 预算）；连拦 2 次放行 + duty log 留「待你核对」；`selfRecovery.finishGate` 默认开；闲聊不启用（需本轮有工具工作或任务式 prompt）。13 个既有测试的收尾台词适配。
  - W3-B：TUI 消费 quota_park_status（footer 倒计时 chip + park 开始 warning 行）；ipython_state_pruned 重放渲染；follow_up 回执 delete hack 清除；autonomous 新默认文案同步（command-registry/README/usage/public-command pin）；-v/-V 联动残留 5 处补齐；ipython.ts 注释修正。
  - W3-C 再审：波次 1/2 全部 30+ 项 verified。销账：文档-2（缓存命中 charge 已修）、文档-14。确认未修：记忆-5、记忆-7、文档-1/3/5/7/8/9/16、安全簇。

### 波次 3 再审新发现（波次 4 处理）

- N1、N3：已被 W3-B 同波修掉（销账）。
- N2 [P2] harness digest 溢出目录无上限（harness.py:1294-1299，每条掉窗记忆占一行注入）→ 封顶 +「+N more ids omitted」。
- N4 [P2] CLI send 不查 `send_message_delivery_mode` capability，对 rev-40 旧 daemon 静默降级（daemon-command.ts:931）→ 握手后检查，缺失报错。
- N5 [P3] quota park re-arm 条目丢 provider 字段（agent-session.ts:21472,21566）→ 补齐。
- N6 [suspect] length 续写收窄：要求 ranToolsSinceLastPrompt 且 _rlmDepth>0 直接 return → 纯文本截断与子代理截断无续跑。决策：评估是否放宽。
- 半落地尾巴①：记忆-1 的三处 warn 仍只进日志，无 TUI/daemon 消费者（session-manager.ts:908-913）→ 透出到会话加载通知。
- 半落地尾巴②：finish_gate nudge 在 TUI 走通用「自动继续」标签，放行提示无 inline 行（injected-prompt-message.ts / conversation-components.ts）→ 专属标签。
- HEAD 基线 6 个 suite 测试预存红（4491-provider-stale-after-401、4620-fast-mode-settings、4649×2、f70、r43-auth-stale-recovery）→ 查归属并修复。
- 智能-4 边角：lastReplayableAssistantIndex 不排除 aborted 回合 → 最新回合 aborted 时无回合保留完整思考（minor，方向安全，登记）。

- 2026-10-01 波次 4：5 批修复完成 + CI 红治理。结果摘要：
  - W4-A：length 续写放宽到纯文本回合与子代理（子代理带「先 send 给 parent」指令，resumed 子代理保守不续）；quota park re-arm 补 provider；emergency shrink 过继 details 不断账本链；context-loss 三处 warn 透出为用户可见 transcript 通知（session_context_loss，含 convertToLlm 排除）；基线红 4491/f70 修复（波次1恢复轮改坏的测试期望），4620/4649/r43 确认为本机 claude 探测环境红（CI 不复现，隔离修法待做）。
  - W4-B：harness digest 溢出目录封顶 50 行；finish_gate 专属 TUI 标签 + finish_gate_released 放行提示渲染（发射侧待 W5 接线）。
  - W4-C：CLI send 显式 --steer/--follow-up 前查 capability，旧 daemon 报错拒绝而非静默降级。
  - W4-D：daemon 崩溃 fail-fast + 快速恢复链闭合（crash handlers 写现场/flush journal/漂移修复 fsync；验证 daemon 死亡→journal→恢复 prompt 全链完整）。文档-8 销账。
  - W4-E：泵 blocked 早退孤儿吞输入修复（回滚 preselected + clear site 重调度），变异实证两半各有独立覆盖。文档-1 销账。
- 2026-10-01 CI 治理：远程 CI 自 0.11.18 release 起连红 4 个 run。诊断：19 条失败 = 波次2 stub 缺新 Map 字段 13 条（daemon-stall 两文件）+ 波次1 恢复轮改期望 4 条（4491/f70 波次4已修 + provider-retry-single-layer×2）+ 波次1 有意行为变更的过期断言 2 条（startup 文案、/tree 带参拦截）。全部测试侧适配，src 不动；已修（wave4-ci-test-repairs）。build-check-test 只是聚合闸门。tl-in-timeline 预存红已被波次1顺带修好。

### 波次 4 跨批依赖（波次 5 首批处理）

1. finish_gate_released 的发射侧：agent-session.ts 放行分支补发 display 消息 + messages.ts convertToLlm 排除名单加 "finish_gate_released"（W4-B 渲染侧已就绪，pin 测试锚定字面量）。
2. ipython_state_pruned 不在 convertToLlm 排除清单——注释声称不进模型上下文但实际会进（W4-A 发现③），加入排除名单。
3. session_context_loss 通知的 TUI 重放渲染（conversation-components.ts 加镜像分支，仿 IPYTHON_STATE_PRUNED）。
4. 4620/4649×2/r43 环境红隔离：harness 层屏蔽 claude-code 探测（packages/ai env-api-keys 或测试设施）。
5. daemon.md:143 恢复契约描述过时（W4-D 遗留）。

- 2026-10-01 波次 5：5 批完成。结果摘要：
  - W5-A：finish_gate_released 发射侧接线（display 通知进 transcript，不进模型上下文）；messages.ts convertToLlm 排除名单补 finish_gate_released + ipython_state_pruned（修注释与行为不符）。波次4依赖#1#2 销账。
  - W5-B：session_context_loss 重放渲染补洞 + 整类兜底（buildConversationComponents 加 display:true 通用分支，关掉 11 个类型的洞）。波次4依赖#3 销账。
  - W5-C：claude-code 探测加 PI_DISABLE_CLAUDE_CODE_DETECTION opt-out + 测试设施隔离（4620/4649/r43 环境红销账）；文档-9 MR-1 核验已在 HEAD 修复（1153b271b），销账。
  - W5-D：文档-7 机器块防伪造核验已在 HEAD 落地（21c19bf24+84a6e65a5），删死代码 stripFileListBlocks，补 2 条伪造场景回归。销账。
  - W5-E：回收器补三块——pi-bash 日志数量封顶（默认 100）、session-artifacts 总量上限（默认 8GiB，保留 resident/活引用/待执行 cron）、tombstone 抑制加 warn 记录。文档-5 大部销账（记账粒度取舍仍留用户拍板）。
  - CI 尾巴：input-classification pin 补上 SESSION_CONTEXT_LOSS/FINISH_GATE_RELEASED/IPYTHON_STATE_PRUNED 三个新常量的归类（波次4遗漏，主席直修）。

### 波次 5 遗留（波次 6 候选）

- 文档-9 剩余 4 条重试语义（:719 429 等表照到点、:728 SDK 层重试零事件、upstream-725 重试定时器不可取消、audit-268 子代理回合级错误无重试）。
- 文档-3 流式全量重发（需设计）；文档-16 子代理配额；文档-10 计费 2 条；文档-11 attach 全量重读；安全簇 文档-12/13（需用户拍板）。
- W5-C 遗留：PI_DISABLE_CLAUDE_CODE_DETECTION 未写进 args.ts env 文档与 packages/ai/README。
- 记忆-7（后台线程脏追踪）、显示-调研（终端宽度画像+mode 2027，需设计）。
- 智能-4 边角（aborted 回合不占「最近」名额）、智能-5（prompt 禁 .get() 与运行时矛盾）。

- 2026-10-01 波次 6（再审驱动）：5 批完成。再审集群（3 路）带回 7 条新发现 + 核销 5 条已失效登记。结果摘要：
  - W6-A：finish gate 逃逸链两环修复——strikes 不再被任意 toolResult 清零（主对抗路径「跑检查→红→照样宣称完成」现在 2 次追问后落放行记录）；预算耗尽路径补 finish_gate_released 记录+通知（cause: budget_exhausted）；重试定时器 dispose 半侧封口（dispose 时 abort retry controller + _disposed 守卫）；quotaResumeAt 写侧（真实额度重置时间独立于探针时间）。
  - W6-B：R3-1 幽灵 stall bar 跨会话吞 Esc 误中断新会话（会话切换时清理 stallActionBar+诊断监听）；R3-2 quota_park_status 进 sessionEventQueue 保序；R3-4 re-park 打提示行 + chip 带「第 N 次」；R3-6 chat cap floor 棘轮改滞后余量；R3-7 legacy+telemetry=off 时 park 钉住 statusContainer 行。
  - W6-C：attach/快照带 park 状态（capability-gated 可选字段，schema rev 42→43，digest 重算）+ attach 后立即 force announce（60s 盲区闭合）；readQuotaParkStatus 优先 quotaResumeAt；daemon.md 恢复契约重写。
  - W6-D：sweep 类序调整（total-cap backstop 排到 child-transcripts 后）；bash-temp 年龄遍按 mtime 最旧先收；total-cap 跳过零字节候选。
  - W6-E：rlm.ts prompt 的 .get() 禁令改为「属性优先、.get() 亦可」（与运行时 _RecordAccess 对齐，加双向漂移 pin）；记忆-7 后台线程脏追踪：_replayable_snapshot 存活用户线程 veto + 内核线程登记表；PI_DISABLE_CLAUDE_CODE_DETECTION 进 README/providers 文档。
- 2026-10-01 CI 转绿：run 36861026576 success。失败演化：0.11.18 预存红（tl-in-timeline）→ 波次1/2 引入的测试适配滞后（19 条峰值）→ 波次4修 17 条 + input-classification pin → 波次5 全绿。

### 波次 6 跨批依赖（波次 7 处理）

1. client 侧接 snapshot 的 quotaPark 字段：daemon-agent-connection.ts capabilities 加 quota_park_status、AgentConnectionSnapshot 镜像、interactive 侧 attach 后播种倒计时（事件层盲区已先闭合，此条是快照正典通道）。
2. repl.md:415-437 同步（存活线程 veto 后旧表述过时）；effects.py 的 rlm-change-* 线程登记（需 lazy import 防环）。
3. args.ts env 文档补 PI_DISABLE_CLAUDE_CODE_DETECTION。
4. R3-5 重放双实现收敛（buildConversationComponents 生产零调用，需设计：生产重放改用 builder 或抽共享函数）——留波次 7 设计+实施。
5. 再审1-#7（worker-recovery marker 双重排队窄窗口，P3 备查）。

- 2026-10-01 波次 7：4 批完成。结果摘要：
  - W7-A：worker-recovery marker 消费判定放宽到续跑白名单（auto_continue/empty_response_recovery/provider_failure_recovery），双重排队窗口关闭；repl.md 同步存活线程 veto；effects.py 线程登记（修掉 watcher 线程让快照回放整进程失效的真 bug）；args.ts 补 env 文档头。
  - W7-B：client 侧接 quotaPark 快照（attach 播种倒计时，resync 快照权威）；**R3-5 重放双实现收敛**——生产 renderSessionContext 的消息循环抽成 replayConversation 单一 engine，builder 变包装器，净删 ~440 行漂移循环；coding-agent 全套件 10627 通过 0 失败。
  - W7-C：Codex service-tier 改按响应值计价（删 resolveCodexServiceTier，响应 default 即标准价）；google usage 负值地板核验已在 HEAD（销账）。
  - W7-D：slim_attach_transcript capability（schema rev 44）——attach 只传最近 100 条 + messagesOmitted，get_messages 分页回填，supervisor 缓存保全量 + 防撒谎守卫。client 侧接线留波次 8。
- CI：run 36861026576（波次5）、36866050779（波次6）连续 success。

### 波次 7 跨批依赖（波次 8 处理）

1. slim_attach_transcript 的 client 侧接线：daemon-agent-connection.ts 声明 capability、AgentConnectionSnapshot 镜像 messagesOmitted、interactive 侧渲染「更早 N 条」标记 + 滚动回填走 get_messages before/limit。
2. usage.md 的 Environment Variables 表补 PI_DISABLE_CLAUDE_CODE_DETECTION 行。
3. in-process-agent-connection 的 quotaPark（minor）。
4. resolveServiceTier 钩子已无调用方（openai-responses-shared.ts:70-73），可选清理。
5. 深层双排队残余（W7-A 遗留③，需 daemon-mode→agent-session 新 API，P3）。

- 2026-10-01 波次 8：2 批完成（接线收尾）。结果摘要：
  - W8-A：slim_attach_transcript client 接线——attach/reattach 声明 capability、messagesOmitted 镜像、聊天顶部「更早 N 条未加载」标记行（可点击/滚轮回填上一页，abut 守卫+epoch 防竞态，不重建 live chat）；getMessages 全量守卫保证 rpc/acp/print 不受 slim 影响。
  - W8-B：usage.md 补 PI_DISABLE_CLAUDE_CODE_DETECTION；resolveServiceTier 死钩子删除；in-process 快照补 quotaPark（无 capability 握手，直填）。
  - 主席直修：daemon-protocol rev-44 头注释与实现不符（resync/replacement 实际也窗口化）、types.ts quotaPark 注释补 in-process 前提。

### 波次 8 遗留（登记）

- slim 回填页 inline 模式无触发器（click region 只 fullscreen+mouse 派发；加键位需动 core/keybindings.ts，斜杠命令需动 slash-commands.ts）。
- W5-C 遗留③：dev 机设真实 provider key 时 getAvailable 断言仍漂移（只隔离了磁盘探测源）。
- 显示-调研（终端宽度画像 + mode 2027 探测）仍是设计项，未立项。
