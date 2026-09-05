# Prime Agent 源码审计问题清单（2026-08-29）

> 来源：九代理独立审计 + 交叉对质 + 亲验裁决。审计基线：本地 fork HEAD `1cf21237e`（分支 fix/subagent-storm-and-cjk-lag）。
> 各代理完整报告：/tmp/prime-audit-{arch,runtime,mechanics,security,grok-tui,grok-providers,grok-tests,grok-wire,grok-entry}.md
> 状态栏： [ ] 未处理  [~] 进行中  [x] 已修

## P0 — 确认的高危缺陷

- [x] **F1 父催子队列可永久卡死**（会话队列） — 已修，落点：9afa2cd78 + 648bf8891
  `requestAbort` 挂起输入泵后，`queueAgentMessagePrompt` 入队不带 `resumeIfIdle`，`wake` 恒为 `on_lower_boundary`，无人唤醒泵。裸 RLM 子代理（无心跳/cron）队列非空即静默卡死，发送方只收到 `queued` 无感知。带心跳/cron 的会话下个 tick 自愈。
  证据：`agent-session.ts:6878-6904, 4575-4595, 5463-5468, 5573-5577`；`daemon-mode.ts:5968-5990`
  修法方向：agent-message 入队路径补 `resumeIfIdle`（对齐 TUI steer/follow_up/heartbeat 的做法），或在 `_admitSessionInput` 对 `on_lower_boundary` 增加「泵悬置中则唤醒」分支。
  验证：子代理 streaming → cancel_rlm_child → 再催促 → 当前永不运行；修复后应入队即醒。

- [x] **F2 print/json 模式杀在途子代理**（子代理生命周期 / 入口一致性） — 已修，落点：82683e4ee
  `print-mode.ts:121` 调 `waitForHeadlessCompletion()` 不传 `waitForRlmQuiescence`，root 回合一结束即 `complete_owned_session` → supervisor 停 worker → 级联 abort 全部在途 RLM 子代理。ACP 已显式传 true（`acp-mode.ts:638`，d98d0762c 加的能力门 `rlm_quiescence_barrier`），print/json 没接上。
  修法方向：print/json 同样等待 RLM quiescence（复用 ACP 的能力门），或文档明写「print 不留后」语义。
  证据：`print-mode.ts:121`；`headless-completion.ts:89-92`；`daemon-agent-connection.ts:1453`；`daemon-mode.ts:7094-7096, 6497-6500`

- [x] **F3 session 记录与日志文件权限过宽**（密钥与日志） — 已修，落点：e4bb3f3cf（#1249）
  session jsonl（含 prompt/工具输出/bash 记录）`appendFileSync` 无 mode，默认 umask 下落成 0644；`~/.prime/agent` 与日志目录可建为 0755。多用户机器上跨 uid 泄漏会话内容。
  证据：`session-manager.ts:1444`（无 mode）、`config.ts:586-598`、`logging.ts:18-21`、`main.ts:1048`
  修法方向：session/log 文件显式 0600，目录 0700（对齐 descriptor/lease 已有的做法）。

- [x] **F4 Windows 命名管道无 ACL**（权限边界，双代理互证） — 已修，落点：2637973c1（Windows 未实机验证）
  Windows 上管道名是全局 `\\.\pipe\prime-agent-daemon`，chmod/uid 检查全是 no-op → 任何本地用户可连 daemon、attach 会话、发 shutdown。
  证据：`daemon-socket.ts:39-41, 137-141`
  修法方向：Windows 分支用命名管道 ACL（SID 限制）或退化为 localhost TCP + token。

## P1 — 确认的中危缺陷

- [x] **F5 capability 门只在客户端侧**（协议兼容，双代理互证） — 已修（W7），落点：`96d3db580` + `7efe4b467` + `6e86b3929`，测试 `6b8d2585b`（R3 复核勾掉，证据见本文件末「R2 遗留状态纠正」节）
  supervisor/worker 不校验入站命令的 capability，客户端侧门控被绕过即可越用新命令。
  证据（原行号，R3 后已漂）：`daemon-supervisor.ts:1409-1422` vs `daemon-client.ts:304-327`；现行落点：`daemon-supervisor.ts:1825` 与 `daemon-mode.ts:3655` 的 `missingDeclaredCommandCapability(...)`
- [x] **F6 shutdown/restart/prepare_update_restart 无鉴权**（失败路径） — 已修（W7），落点同 F5 三条 + `6b8d2585b`（含 `test/suite/regressions/w7-capability-control-plane.test.ts` 246 行）
  任何能连 socket、能写合法 protocol-7 envelope 的进程即可关停 daemon；无控制面/会话面分流。默认 0700 socket 把威胁限制在同 uid，但同 uid 任意进程（如恶意扩展）可 DoS 全部会话。
  证据（原行号）：`daemon-supervisor.ts:1819-1827, 1085`；`daemon-protocol.ts:1084-1105`；现行控制面/会话面分流落点：`daemon-mode.ts:3558` 的 `isSessionPlaneDaemonCommand(parsed.type)` 闸
- [x] **F7 流式事件载荷 O(n²)**（资源） — 已修，落点：c72b9940f（streaming_deltas, schema 25）
  `message_update` 每个 token 把整条 message 推上公开 JSONL（compact delta 只在 worker→supervisor 一跳生效）；长消息总成本平方级。`omitStreamingMessages` 能力可缓解但需客户端主动协商。
  证据：`daemon-extension-binding.ts:33-68`；`agent-loop.ts:533-541`；`daemon-supervisor.ts:4660-4664`
- [x] **F8 Codex provider 重试缺陷三连**（模型请求） — 已修，落点：b003173a6 + a6988e947
  (a) catch 门 B 只看 message 不含 "usage limit"，401/400 也重试 4 次；(b) 429 不读 Retry-After，固定 1s*2^n；(c) 忽略 options.maxRetries。
  证据：`openai-codex-responses.ts:90-94, 217-264`
- [x] **F9 Mistral/Google/Vertex 无重试 + maxRetryDelayMs 死选项**（模型请求，双代理互证） — 已修，落点：a6988e947
  `maxRetryDelayMs` 有设置有文档、全链路传递、零消费者；`timeoutMs/maxRetries` 只接了 anthropic/openai/azure。
  证据：`mistral.ts:214-217`；`google.ts:337-340`；`ai/types.ts:126-133`；`simple-options.ts:18`
- [x] **F10 edit 工具 abort 拦不住写盘 + 非原子写**（工具执行） — 已修，落点：577f1032b（W2）
  abort 时结果报 aborted 但文件可能已被改；`fsWriteFile` 非原子，写一半崩溃即损坏。
  证据：`edit.ts:375-377, 424, 86`
  修法方向：tempfile+rename 原子写；abort 先查 signal 再落盘。
- [x] **F11 exec.ts 只杀直接子进程 + stdout 无界累积**（工具执行 / 资源） — 已修，落点：8dde3fdfa（W2）
  abort/超时未 detached 也不杀进程组，孙进程存活；stdout/stderr 字符串拼接无上限。
  证据：`exec.ts:57-64, 76-86, 104, 108`
- [x] **F12 TUI 未终止 bracketed paste 吞键盘**（状态机 / TUI） — 已修，落点：ca2ec0bda + 9afc14f35
  只见 `200~` 不见 `201~` 时 pasteMode 无超时、无字节上限、无任何键盘退出路径，ctrl+c 也被吞，只能杀进程。触发前提：未终止 paste 或伪造 `200~` 信封（完整粘贴不受影响）。
  证据：`stdin-buffer.ts:266-300, 367-384`
  修法方向：pasteMode 加超时（如 30s 无 201~ 自动 flush 退出）+ 字节上限 + Esc 强制退出。
  待验证：哪些终端/tmux 会只发 200~（需终端矩阵或 pty 录制）。
- [x] **F13 14 处键绑定硬编码绕过配置表**（违反仓库 AGENTS.md） — 已修，落点：142022669（B8/W5）
  证据：`tui.ts:935`；`editor.ts:850,854,967,885,1330`；`settings-list.ts:173`；`input.ts:86`；`config-selector.ts:400,404`；`scoped-models-selector.ts:314,324`；`extension-selector.ts:143,146,149`；`extension-input.ts:75`；另有 `select-list.ts:119` 不用已登记的 pageUp/pageDown。
- [x] **F14 ACP stdin EOF 只 detach 不 complete，worker 残留**（关闭与清理 / 入口一致性） — 已修，落点：9f03ec6f5
  ACP 是 headless 中唯一默认 resident 的模式；EOF 后 worker 残留至 90 分钟空闲驱逐。高频短会话场景（评测 harness）会在窗口内堆积。`daemon.md` 的 client-owned 名单漏了 ACP。
  证据：`main.ts:197, 1545`；`daemon-agent-connection.ts:1456-1462`；`daemon-supervisor.ts:931`
- [ ] **F15 attach 竞态丢事件**（并发与竞态）（W9 留档）
  supervisor 在「worker 返回快照」到「登记客户端转发」之间的事件不转发给新客户端；客户端只按 max 去重、无序号缺口检测，窗口内丢 message_end 则缺消息直到被动 resync。
  证据：`daemon-supervisor.ts:3954, 4675-4695`；`daemon-agent-connection.ts:2085-2119`
- [x] **F16 update-restart 恢复期的孤儿路径**（子代理生命周期 / 失败路径） — 已修，落点：5b6c0e94e（#1864）+ 1597ef8c3
  恢复阶段父 create 失败仅 warning 继续；子的 `parentActiveSessionId` 重映射失败即被丢弃成孤儿（级联关闭/被动化只认该字段）。
  证据：`package-manager-cli.ts:964-983, 999-1002`；`daemon-mode.ts:7119-7129`
- [ ] **F17 idle 驱逐可杀「心跳注册在途」的 worker**（进程所有权，对质后收窄）（W9 留档）
  已注册心跳的 worker 永不驱逐（硬性条件），但 fence 设置→stopWorker 之间到达的注册被 fence 阻塞且发生在 mutationDrain 之前 → 驱逐先落地。需同时满足 90min idle + 0 attached clients，后果限于会话归档、无数据丢失。
  证据：`daemon-supervisor.ts:904-928, 1489-1496`；`session-action-store.ts:380-388`

## P2 — 文档漂移与死参数（亲验）

- [x] **F18** `daemon.md:76` 写 "Public Daemon Protocol v4"，代码已是 v7（`daemon-protocol.ts:54`）；`daemon.md:93` "Protocol v1 retained" 说法过时 — 已修，落点：f12fcbdea
- [x] **F19** `settings.md:20,298` 声称 `defaultThinkingLevel` 默认 `"xhigh"`，代码是 `"medium"`（`defaults.ts:3`） — 已修，落点：f12fcbdea
- [x] **F20** `development.md` 要求 Node 22.8+，`install.sh` 放行 20.6+（两边应取齐） — 已修，落点：f12fcbdea
- [x] **F21** `usage.md` mode 表缺 `acp`；`--mode text` 被解析但 `resolveAppMode` 不使用（死参数，帮助文本还写 `default:text`）——`args.ts:104-107`、`main.ts:174-190` — 已修，落点：f12fcbdea

## P2 — 测试盲区（对质收窄后）

- [x] **F22** LLM HTTP 429 重试零测试（faux 写死 200；`isRetryableError`/`MAX_RETRIES` 测试目录 0 命中）——与 F8/F9 闭环：有缺陷且无测试 — 已修，落点：codex-retry-behavior.test.ts
- [x] **F23** bash 工具 abort 不验证 OS 子进程真死（BashOperations 边界被 mock）；`killProcessTree` 符号零测试引用（行为仅经 autonomous gate 间接覆盖） — 已修，落点：exec.test.ts + repl-kernel-bash-interrupt.test.ts
- [x] **F24** 子代理消息风暴零测试——8981a31c3 的修复无回归保护；且 turn_start/turn_end/session_replaced/session_closed 仍走 urgent 全量行（`daemon-supervisor.ts:4696-4705, 3299-3339`） — 已修，落点：1229-snapshot-transfer-identity.test.ts + daemon-supervisor-streaming-list.test.ts
- [x] **F25** worker streaming 中途崩溃无测；双客户端 attach 同 session 仅 mock；RLM 子死父不知零测试；Windows silent return 假绿 3 处（`4603-worker-recovery.test.ts:754,857,1029`） — 已修，落点：4602-snapshot-transfer-idempotency.test.ts + 4606-update-restart-coordinator.test.ts

## 已被对质推翻/降级（不要再追）

- ~~孤儿 toolCall → Anthropic 每请求 400、会话永久污染~~：**推翻**。所有 provider 请求路径都过 `transformMessages`（`anthropic.ts:1064`、`amazon-bedrock.ts:645` 等），error/aborted 消息整条丢弃、孤儿自动补合成 `"No result provided"`（`transform-messages.ts:152-210`），有 `tool-call-without-result.test.ts` 钉死。孤儿确实落盘，但请求层永远打补丁。
- ~~clientId 自声明劫持 client_owned / 同 uid attach 驻留会话~~：降级 low。同 uid 本就能读 descriptor 内的 worker token，伪造不提供新能力；是合作客户端间的礼貌 ACL。
- ~~launchEnv 全量 process.env 不过滤~~：有意设计（daemon 非安全沙箱，`architecture.md:37-38` 自述）；`adoptClientEnv` 先到先得，第二客户端无法改驻留 worker 环境。
- ~~公开 JSONL 无单行上限~~：安全 low（同 uid 本可杀进程）/ 健壮性 med（合法超大消息也会撑爆）。可补 `maxLineLength`（worker stderr 已有 64KiB 先例）。
- ~~「abort 后 usage 全 0 → 上下文记账偏低」~~：窗口记账有尾部估算兜底不偏低；真实残留是**成本归因**永久漏计 aborted 回合（OpenAI 系）+ 首回合即 abort 的无锚点死角（暂时性）。
- ~~「1MB 大粘贴假死」~~：完整粘贴自带 201~ 不受影响；问题仅是 F12 的未终止场景。

## 已核对无误（审计确认的好消息）

8981a31c3 两处修复真实成立（omitStreamingMessages 能力门 + snapshotTransferSeq）；状态机不会永久假 working（summarizer 失败兜底 needs_input）；worker_auth 不上 argv；descriptor/lease 0600/0700；假重复防护完备（message_end 唯一追加点）；命令日志从不重放 pending；update-restart 三阶段围栏 + stale 客户端检测；abort 无 token 双重计数；kernel 回收链完整（旧 IPython 内核，见下）。

## 附：内核换血说明（upstream 已合并）

upstream main 已用 #1684–#1687 把 Jupyter/ipykernel/ZMQ 内核换成自研极简 CPython REPL（`python -m rlm.repl`，JSON-lines over stdio，启动 ~30ms vs 原 ~1.2s）。本地 fork 落后 18 个提交仍在旧内核。合入计划见本节底部 TODO。
- [x] **F26** 合并 upstream 新内核（rlm.repl）到本地 fork，解决与本地 8 个 perf/storm 提交的冲突，跑通内核测试 — 已修，落点：bf542ce7e（内核合并）


---

# 2026-08-29 第二轮追加：内存专项 + 官方 PR 评估 + 内核合并

## F27 [P0] TUI 长会话内存膨胀（实测：38 小时 RSS 2.4GB，峰值 3.5GB；daemon 同期仅 204MB）

- [x] **F27a 流式全量事件 + 全帧重渲染 → V8 堆棘轮**（最大头）：supervisor 每 token 向 TUI 广播整条 message JSON（daemon-supervisor.ts:4576-4592），TUI 每 token 全量 JSON.parse + 全文 markdown re-lex（markdown.ts:225-244）。堆对象可回收但 RSS 高水位不归还。 — 已修，落点：c72b9940f（streaming deltas）
- [x] **F27b 同一 transcript 驻留 ~3 份全量拷贝**：latestSnapshot.messages + sessionContext.messages + chatContainer 组件树（400 条截断只在初始渲染，直播追加无上限——interactive-mode.ts:6303-6425）。每条消息驻留 ≈4.5-5.5× 原文（组件+Markdown blockCache+LineAggregator 扁平行）。 — 已修，落点：670c7cb77 + a526eb6f0（chat cap）
- [x] **F27c 图片 base64 常驻**：Image 组件持整段 base64Data（image.ts:40-45），聊天图不受编辑器 64MB 粘贴帽限制；1000 张截图 ≈ 0.3-2GB。 — 已修，落点：05279c433（drop base64）
- [x] **F27d 编辑器无界结构**：UndoStack 无上限且跨会话存活（undo-stack.ts:8、editor.ts:2059）、KillRing 永不释放（kill-ring.ts:9）、pastedImages 仅会话重置时修剪。 — 已修，落点：fb8a90893（undo/kill ring cap）
- [ ] **F27e 次要**：subagentSnapshots 会话内单调增（仅 cancelled 才删）；sideQuestionTurns 按轮累积；completedSnapshots 最坏 128 份全量快照。（待父代理确认：次要项：completedSnapshots 有 128 上限；subagentSnapshots/sideQuestionTurns 未变）
- 修法优先级：①流式改增量 patch ②transcript 组件树窗口化 ③blockCache LRU 限量 ④undo/kill/pastes 加帽 ⑤图片转磁盘引用。
- **官方 72 个开放 PR 无一治理此问题**（worker 侧同类曾修过：#1063/#1288/#957/#1717）。

## F28 [P2] exec.ts 瞬时峰值（收窄后）：仅扩展 pi.exec 路径，100MB 输出≈100-300MB 瞬时 RSS，无跨调用残留；自修（抄 bash-executor 环形+临时文件方案）。

## 官方 PR 评估终裁（10 代理分片，72 个 open PR 全扫）

### 已随内核合并白拿（upstream main 已合并）
#1841（rename 校验真 bug）、#1846、#1849、#1852、#1853

### 待集成 TAKE 清单（按风险从低到高）
1. [ ] **#1882** bash 并发共享 AbortController 修复（带 3 个回归测试；零冲突）
2. [ ] **#367** Anthropic Record schema 递归改写（只动 packages/ai；零冲突）
3. [ ] **#1700** 远程 agent 消息重复投递修复（小改+测试）
4. [ ] **#413** Ghostty 图片默认关（与 #427 互斥，拿 413）
5. [ ] **#1249** session/log 文件 0600/0700（治 F3；需 rebase 我们 619144b6e 的增量扫描改动）
6. [ ] **#1253** 宿主拆除取消 RLM 子代理（需把语义移植到新内核 rlm.repl）
7. [ ] **#1251** --no-session 子代不落盘（叠在 #1249 之后）
8. [ ] **#1519** Enter 恢复 parked queue（F1 同族，拿测试脚手架；F1 本体仍自修）
9. [ ] **#887** 滚轮 3 行→1 行（rebase 一行常量）

### 条件观察（暂不拿）
#485（治 F16，1047 行 DIRTY，先 rebase 演练）、#1756（撞 8981a31c3）、#565、#1845、#1859、#1580（anthropic sdk bump）、#1523、#1631、#1854、#1857、#569、#1115+1106（429 测试网，stacked）

### SKIP（已裁）
#795（DRAFT+熔断器方向不对，不治 F8 实际病）、#1236（把 ACP resident 当设计，与 F14 反向）、#506/#480/#522（架构重写太险）、#1885（+2308 新子系统）、#1170/#1168/#1166（DRAFT 栈）、#531、#1864、#1123、#644、#1239、#1338、#1337、#374、#1349、#1633、#1860、#1851、#1855、#1848、#1106、#1578、#427、#1145、#1146、#1842、#1107

### 官方无人治、必须自修
F1（队列卡死唤醒）、F4（Windows 管道 ACL）、F14（ACP EOF complete）、F8（Codex 重试三宗罪）、F12（paste 吞键盘）、F13（键绑定硬编码）、F27（TUI 内存全家桶）

## 内核合并记录（merge/repl-kernel @ bf542ce7e）
- upstream/main 18 提交已并入，含内核四连 #1684-#1687 + 修复 #1835/#1836/#1838/#1839
- 冲突 2 个文件已解：schema 撞号升 24（新 ID protocol-7-schema-24-3e65c87439aa，内容哈希对齐测试）；删本地 roster 推送法吃 upstream 拉模型；保留风暴节流调度器
- #1886 fixture 修复（protocol 2→3）已手动应用（R3 lane B 复核实测 `ALREADY_IN_main` ×2，见末节台账）
- npm run check 全绿；daemon-protocol/streaming-list/agents-view/repl-kernel 测试 117/117 绿
- 注意：新内核废除 %%bash/%cd/%env/! 魔法单元（改 bash()/os.chdir/os.environ）；旧 kernel venv 下次启动自动重建（无 ipykernel，更瘦）


---

# 2026-08-29 第三轮追加：逻辑缺陷扫描（测试绿之外的第二道闸）

> 打法：测试全绿后，4 路窄镜头逻辑扫描（3×grok 快扫 + 1×qwen 深挖），专找「测试没挡住的行为错误」。第一轮即中 4 个 high——全是小细节引发、不容易察觉的类。

## 扫描新发现（返工中）

- [x] **F29 B1b 内存帽默认配置下永不触发**（high）：`enforceChatComponentCap` 的守卫 `if (this.ui.isFullscreen()) return` 把「全屏渲染模式」（默认开，tui.ts:783-785 + settings-manager.ts:1142）误当「全屏回看覆盖层」→ 默认用户永远 trim 不到。修法：守卫换成精确的回看状态。 — 已修，落点：3b92861ec + 4bd308a8a（fullscreen-aware chat cap）
- [x] **F30 B6 paste watchdog 是墙钟不是空闲超时**（high）：armPasteWatchdog 只在进 pasteMode arm 一次（stdin-buffer.ts:317），慢终端/SSH 上 >30s 合法粘贴被腰斩，后半截 `201~` 泄漏成普通按键。修法：每 chunk 续期。 — 已修，落点：dbd3297c0（paste idle timeout）
- [x] **F31 B6 Esc 语义反了 + flush 路径病理**（high）：Esc 取消变成把半截粘贴插进草稿，且连锁可清掉用户原草稿；超时/超限 flush 走逐字符 process()——8MB 即百万次 insertCharacter + undo 帽打爆 + 误触 autocomplete。修法：Esc=丢弃；flush 走原子 paste 通道。 — 已修，落点：88f557d38（Esc discard + atomic paste）
- [x] **F32 session 写失败静默吞掉**（high，老 bug 被 A5 放大）：`_agentEventQueue` 尾部 catch 空 + appendMessage 无 try → 一次写失败该条永不补写、UI 无提示。A5 的 ensureNoSymlinkPath 只许首段 symlink，`~/.prime` 整体 symlink 布局（常见）下每次追加都抛错并被吞 → 会话全部静默不持久化。修法：失败响亮可见 + 中间组件 realpath 解析后校验。 — 已修，落点：28f1f0e53（session write failure visibility）

## 审查排除项（确认无误，不再追）

O_EXCL 挡合法改写（temp+rename 模式，append 对已存在文件不加 EXCL）；B1a×B1b 重建后图片显示（fallback 只用 mime+尺寸）；滚轮 3→1 行高一致性；B1b 重建不清编辑器草稿。

## 环境坑备忘（本机测试时必读）

1. **主仓过期 `packages/coding-agent/dist/` 会影子覆盖新运行时**（bootstrap 优先看 dist）——症状 `No module named rlm.repl`；删 dist 即解。跑过 build 就要记得再删。
2. 子代理 shell 会继承 `RLM_DEPTH/RLM_SESSION_DIR/RLM_MAX_DEPTH` → refine 相关测试假红；测试命令前缀 `env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_MAX_DEPTH -u FORCE_COLOR`。
3. worktree 的 node_modules 用符号链接共享即可跑测试（已验证）；husky 钩子在 worktree 可能不挂，提交前手动 npm run check。

## 合并瀑布记录（merge/repl-kernel）
已并入：exec-ai(A2+B4+B5)、exec-tui(A4+A9+B1a+B1d+B6)、exec-headless(B9/F2)、exec-daemon(A3+B7+docs)、exec-memory(A8+B1b)、exec-queue①(A1+F1)、exec-security(A5+A6)。每步并后重验（含交叠区并集测试 259/259）。在途：exec-queue B2（流式增量协议）、两个返工。

## L4 深挖新发现（runtime-reviewer，FIX-R1~R4 工单已派发 exec-runtime 分支）

- [x] **F33 派发后 abort 永不结算**（med，确认）：排队回合被泵派发后遭 abort，running 动作永不结算 → unfinishedActionCount 永久 ≥1 → wait_for_idle/quiescence 永挂、会话假忙、驱逐被挡（agent-session.ts:6930-6936, 5793-5815）。F1/B9 的测试都只盖「排队未派发」，没人测「派发后 abort」。 — 已修，落点：cd0b2a600 + c59b414e1（R1 settlement）
- [x] **F34 B9 的 wait_for_headless_completion 是 mutation 类**（med，确认）：print 长等待占住 mutationDrain → 挡 daemon 自更新（80s drain 超时）；反向更新时 print 被 abort 丢最终输出。修法：挪只读/长等待类。 — 已修，落点：9286d44ef（headless completion read-only）
- [x] **F35 A8 resumeQueuedWork 吞错**（low，确认）：daemon-agent-connection.ts:690-697 只回 response.success，worker 侧失败静默。 — 已修，落点：900b0cc69（restore A8 wiring）
- [x] **F36 B9 行为变化未文档化**（low）：print 对永不收摊子代理最长挂 24h（原行为是立即杀子）。 — 已修，落点：111549589（docs: print quiescence）
- [ ] **F37 fence 期本地投递清 updateRestart 挂起标志**（low，待验证）：窗口极窄，下轮实测。（结案留档：k3 实证 _queuedWorkPauses 硬闸下不可达）

## scan2 第二轮新发现（预判链路法）

- [x] **F38 update-restart 回退楔死**（high，scan2-protocol，FIX-R5 已派 exec-runtime）：prepare 成功+shutdown 失败 → fallback restore 被 prepared 态拒绝 → checkpoint 清、phase 卡 prepared、prepare 永久 already preparing。 — 已修，落点：e5eea4a6b（R5 update-restart fallback）
- [x] **F39 半截尾行不修盘导致追加粘连丢数据**（high，scan2-persist，FIX-S3 已派）。 — 已修，落点：72f02cc76（S3 torn-tail repair）
- [x] **F40 交互模式无双开保护**（high→评估中，FIX-S5）：split-brain + rewrite 丢并发追加。 — 已修，落点：438956a80（S5 interactive session leases）
- [x] **F41 journal tmp 无 O_NOFOLLOW/无清理、orphan journal 权限**（med，FIX-S4 已派）。 — 已修，落点：70be3f3a8（S4 journal temp hardening）
- [x] **F42 分支切在工具对中间产生孤儿 toolCall 上下文**（med，scan2-persist）：请求层有 transformMessages 兜底不 400，但分支内容语义不完整。 — 已修，落点：43798f22d（W4 fork cut at tool pairs）
- [x] **F43 F1 唤醒误清 updateRestart 悬置标志**（high，L1+runtime 双撞，FIX-Q1 已派 exec-queue）。 — 已修，落点：d9364b034（Q1 agent-message wake in fence）
- [x] **F44 abort 后 deferred terminal notice 被驱逐丢弃**（med，FIX-Q2 已派）。 — 已修，落点：80290a3db（Q2 deferred notices resident）
- 协议口径备忘：版本握手是 schemaId+appVersion 精确匹配（无协商降级，旧客户端会把新 daemon 当 stale）；list_agent_peers 只有 schema 地板无 capability（与仓规「新命令走协商」不一致，B2 正按 capability 做）。

## scan2-kernel / scan2-compaction 新发现（修复工单已派）

- [x] **F45 快照半恢复覆盖好快照**（high，exec-kernel K1）：restore 单名失败仍半恢复且不置 pendingRestore → 下次成功 execute 把残命名空间覆盖磁盘好快照；resume restore 无超时。 — 已修，落点：da20d5b5c（K1 snapshot guard）
- [x] **F46 interrupt 不杀后台 bash 句柄**（med，K2）：h=bash() 后台句柄只在 shutdown 收；SIGINT 线程信号打不到 start_new_session 的子进程。 — 已修，落点：e2ed4344d（K2 interrupt kills bash handles）
- [x] **F47 shutdown FIFO 被 busy cell 堵死 + 不升级 SIGKILL**（med，K3）。 — 已修，落点：b3956e809（K3 shutdown TERM→KILL）
- [x] **F48 shouldCompact 阈值不 clamp**（high，mechanics C1）：小窗口/大 reserve → 每回合压缩风暴。 — 已修，落点：317bde3a9（C1 threshold clamp）
- [x] **F49 尾部大 toolResult 无切割点 → 永远「太短」压不成但每回合开火**（high，C2）。 — 已修，落点：6aea300c1 + dbbf7a975（C2 summary budget+boundary）
- [x] **F50 压缩中途切分支 → 摘要挂错叶污染新枝**（high，C3）。 — 已修，落点：a4af20f35（C3 pin compaction entries）
- [x] **F51 摘要请求无输入预算 + 失败无冷却**（high，C4）。 — 已修，落点：dbbf7a975（C4 summary budget+cooldown）
- [x] **F52 fileOps 只认 edit.path / 分支摘要不停在 compaction 边界**（med，C5/C6）。 — 已修，落点：abd6b56e1 + a4af20f35（C5/C6 fileOps）
- [x] **F53 pasteMode 会话切换不复位落进新会话**（med，exec-tui FIX-T7）+ F54 Esc 10ms 合并误伤（T8）+ F55 paste 期 Ctrl+C 被吞（T9）+ F56 拆分 CSI Esc 漏识（T10）。 — 已修，落点：d4c706724（T7）+ e81bfb306（T8）+ 054ced32e（T9）+ 964b19afc（T10）
- 内核扫描排除项：#1839 帧隔离真实成立（fd1 私有 dup + TaggedWriter 锁内整行）；并发 execute 串行化有保证。

## scan3 复扫轮（修代码本身）发现 + 合并事故记录

- [x] **F57 A8 被合并事故吃掉**（high，已修复派单 exec-memory）：exec-tui 返工分支 add/add 冲突整文件取 theirs，冲掉 A8 在 interactive-mode.ts 的接线；测试留存所以复扫抓到。**教训（已钉入流程）：每次并入后必跑常驻回归套件（所有已并分支的回归测试并集），不只跑当次分支的测试。** — 已修，落点：3df18c07a（restore A8 wiring）
- [x] **F58 torn-tail 修复时序**（high，FIX-S6 派 exec-security）：repair 在取租前+attach 路径修活文件+repair 在 symlink 校验前。 — 已修，落点：15dd45ebe（S6 torn-tail under write ownership）
- [x] **F59 Q2 deferred notice 钉死驱逐**（med，FIX-Q4 派 exec-queue）：abort 后 notice 永不 flush → isSessionActive 恒真 → 内存泄漏向。 — 已修，落点：2201e7357（Q4 abandon stale deferred notices）
- [x] **F60 MCP 死会话无重连**（high，exec-mcp M1）+ M1b 超时不断连/M2 结果无上限/M3 remove 泄漏 stdio。 — 已修，落点：9ddcefdf9 + 7aea0a937 + 52d80ba12（M1-M3）
- [x] **F61 扩展 hang 冻死 session 含 abort**（high，exec-ext E1）；**F62 /share 无脱敏无确认**（high，E2）；F63 refinement 三步非原子+mtime（med，E3）。 — 已修，落点：320b720f0（E1）+ 0092dd04a（E2）+ 6e3f081fe（E3）
- [x] **F64 heartbeat 已入队+abort → 泵悬置无人唤醒**（med-high，FIX-Q3 派 exec-queue）：用户「卡死」家族的又一变种。 — 已修，落点：648bf8891（Q3 heartbeat wakes queues）
- [x] **F65 trim 后 streaming 中开全屏 → 直播组件成幽灵**（med-high，FIX-T11 派 exec-tui）+ T12 Kitty Esc 吞同块剩余。 — 已修，落点：f5512dbeb（T11 reattach streaming after fullscreen）
- [ ] lease startId 边界/TZ 敏感（S8）、orphan journal 并发胶合与误杀（S9）、persist_failed 节流与覆盖面（S7）——均已派 exec-security。
- 复扫排除：base64 丢弃重建无碍、undo 帽对大粘贴友好、paste 状态机大部组合正确、F1×R1 主路径无重复结算。

## scan3-protocol 发现（FIX-Q5~Q7 派 exec-queue；FIX-R6~R8 派 exec-runtime）

- [x] **F66 R5 只盖同进程重试**（high）：supervisor 进程在 prepare 后被杀 → phase 不恢复+intentionalStop 不落盘+内存 checkpoint 丢失 → 换路径照样楔死。修法：phase/checkpoint 持久化进 manifest。 — 已修，落点：f384214e3（R6 supervisor death prepared recovery）
- [x] **F67 wait_for_headless_completion 名义只读实际可经 autonomous gate prompt**（med）：只读分类与突变异存。 — 已修，落点：9286d44ef（R7 headless completion read-only）
- [x] **F68 delta 链三窗**（med×3）：replaced+snapshotFollows 窗口丢 delta；TUI 无 seed 只 drop 不自请 catchup；attachClient 无条件 seed 共享 reconstructor 会 rewind 且污染历史消息对象。 — 已修，落点：72942804b（Q5-Q7 streaming seeds intact）
- [x] **F69 R5 边界**：memory+disk 皆空仍抛 already preparing；空工人 prepare 把 sessions:[] 盖盘。 — 已修，落点：e5eea4a6b（R8 edges: recover wedged update restart）

## 当前修复工时盘面（10 工人在跑）
exec-memory(A8 恢复) / exec-queue(Q3,Q4,Q5-7) / exec-security(S6-S9) / exec-tui(T11-12) / exec-runtime(R6-8) / mechanics(C1-7) / exec-kernel(K1-3) / exec-stuck(S-T4,S-T1) / exec-mcp(M1-3) / exec-ext(E1-3)

## 实战活现（dogfooding 实证）
- [x] **F70 回合级 provider 错误后子代理通知父代理**（high，exec-ext 活体案例）：grok-cli key 解析瞬时失败 → 回合 stopReason=error → 会话停 needs_input。修法（实际采用）：耗尽/永久错误 → agent_message 通知父代理（含错误摘要）；不做从零退避。落点：f98d84ada（agent-session.ts:3961,11476; agent-messages.ts:18,347）。

## k3 终审（慢模型深审，bf542ce7e..HEAD 全 diff）结果

总判：能发，先补三刀。亲验全部成立：
- [x] **F70a R1 结算洞**：queueVisible:false 的 RLM 终报 turn 派发中 abort 永不结算（FIX-Q8 派 exec-queue） — 已修，落点：eb916ed78（FIX-Q8 settle aborted terminal-notice turns）
- [x] **F70b harness symlink 口径矛盾**（FIX-S10 派 exec-security）：~/.prime 为 symlink 时全局 memory/skill 无声消失 — 已修，落点：feda1c4b7 + 62968fbbb（S10 harness symlink parity）
- [x] **F70c 老用户升级 daemon 起不来**（FIX-S11）：cron 迁移无 catch + 存量 0755 目录被严格读拒 — 已修，落点：3d935f674 + 62968fbbb（S11 cron migration + legacy dir）
- 另 7 条低危记录在案（watchdog 文案/_prompt fence 纵深/reconstructor 引用播种/checkpoint 幽灵文件/E3 回滚纠葛/patch 前缀误伤）
- k3 确认无问题区域：B2 增量分流、R6 复活、torn-tail、K1-K3、M1-M3、bash 超时、F1/Q3/A8、流 stall、C1-C4、退避、journal、print 门控

## 流程事故自记录
- 父代理自身两次被用户抓到：①对后台套件无看门狗干等 1h47m；②干等 k3 投递而不主动拉转录。已存全局 memory「我自己的等待纪律」。


---

# 收尾（2026-08-29 晚）

## 最终并入清单（merge/repl-kernel，共 27 趟）
内核合并(upstream 18提交含rlm.repl) + 9 官方PR(#1882/#367/#1700/#413/#1249摘/#1251/#1253语义移植部分/#1519/#887) + 审计修复群(F1-F69) + 复扫修复群(F29-F69) + k3 终审三刀(F70a/b/c) + 合并回归修复 6 起。

## 关键数字
- 全量测试：4505+ 绿（环境依赖与 flake 除外，全部有分类结论）
- npm run check：每并入必过（含 pre-commit 钩子）
- 文档：daemon.md/settings.md/usage.md/development.md 已与代码对齐

## 未做（下轮）
- B2 已完成（streaming_deltas 协议，schema 25）；TUI 大窗口化的进一步优化空间仍在
- B8 键绑定迁移 13 处（机械活）
- C 阶段：F4 Windows 管道 ACL（需 Windows 实机）、C2 supervisor capability 校验、C3 shutdown 鉴权
- F70 回合级 provider 错误的子代理自动重试/升级（exec-ext 活体案例）
- k3 终审的 7 条低危

## 流程教训（已固化）
1. 并行合并必跑常驻回归套件（A8 被吃掉事故）
2. 二分定罪要到 commit 粒度（waitForIdle 的 E1 纠偏）
3. 子代理 shell 环境污染清单：RLM_*/PRIME_AGENT_INTERNAL_*/FORCE_COLOR
4. 后台等待必须有看门狗（我自己的纪律 memory）
5. grok 预判链路法 + 父代理亲验；k3 慢而深做终审

## 三模型背景终审（R2 收尾轮）
- review-glm（daemon 层）：两大区复核无误（B2/R5-R6/Q1/Q3/S10/S11/cron/#1700/#1864/#1858/#1845/#1847）。候选 2 条：①commit 路径内存 checkpoint 残留=已留档的 k3 第⑥条（独立再发现，维持留档）；②W8 Windows 管道 listen→onListening 的 ACL 窗口（TOCTOU，窄，Node API 限制，补入 W8 未验证备注）。

- review-grok（TUI/内核/MCP 层）：6 候选——4 条立项修复中（C1 T8 双 ESC 误吞 CSI、C2 K1 restoreFailed 闩死→改隔离+恢复写、C3 codex catch 退避不走 cap、C4 setText 清 undo 范围收窄）；2 条留档：E1 超时后 handler 迟到的副作用留在 runtime（JS 无法取消挂起 Promise，需扩展失败态门控，工作量中等）、W3 仅 rlm.run 认 AbortSignal（其余 host 请求靠 5s drain，可接受）。windows rename 覆盖行为列「待 Windows 实机验证」。

---

# 2026-09-04 R3 上游同步追加：新 PR 台账 + F71-F77 + 路径纠错 + 门方法论

> 基线：`merge/repl-kernel` @ `0c504e475`（本地 **172** 个自研提交）→ 施工树 `sync/upstream-r3`（merge upstream `d74a75fea`，**40** 个上游提交，197 文件 / +18437 −1704；冲突 **43 块 / 18 文件**全手工解）。
> 证据全文：任务书 `docs/fork/sync-upstream-r3.md` + `-appendix.md`（**本轮起任务书入仓**，`daemon-protocol.ts` 的 schema 注释直接引用其 S5.1 表）；lane B 的 30 PR 全文 `/tmp/sync_b_newprs.md`（含只读 cherry-pick 模拟器）；12 份车道回执 `/tmp/r3_receipt_p{1..12}.md`；收口门 `/tmp/r3_closure_commands.md`。`/tmp` 会清，所以本节把结论自足地抄进仓里。
> 本地轴（哪条还活、哪条休眠、谁是唯一读者）单独记在 `docs/fork/local-axes.md`。

## 一、30 个「新出现」open PR 的裁定台账（lane B，只读评估）

### 1.1 统计与本轮动作

| 裁定 | 数 | PR | 本轮动作 |
| --- | --- | --- | --- |
| **TAKE / 碰** | **9** | #2027、#1947、#1896、#1389、#2018、#2017、#1579（改拿 18.0.10）、#1577、#1576 | **三条全部已摘**：#2027 `ebb26a3ac`、#1947 `7f5e1ba3a`（+3 处 fork 适配）、#1896 `b20f16427`（+2 处 fork 适配，碎片归并 `7a6e74c57`）；其余 6 条未动 |
| **可碰但只能拆分摘取** | **2** | #524（只摘 `src/core/session-import/*` 11 个新文件 + 自己接线）、#1994（只摘 `kernel/bootstrap.ts` 与 `utils/shell.ts`） | 未动 |
| **观察** | **7** | #1928、#1996、#305、#1177、#1252、#2028、#1581 | 未动 |
| **SKIP** | **6** | #525、#638、#1175、#1176、#1886（本地已有）、#1582 | — |
| **不碰** | **6** | #2025、#1970、#1982、#1980、#1157、#1169 | — |

deps 线一条都没动的实证：`actions/checkout` 仍 pin `v7.0.0`（#1576 要 7.0.1）、`actions/github-script` 仍 pin `v7.0.1`（#1577 要 9.0.0）、`uv.lock` 零变化（#2018/#2017）、`marked` 未动（#1579）。

### 1.2 30 行台账

| PR | 标题 | 作者 | 裁定 → 本轮动作 | 理由（一句话，全文见 lane B） |
| --- | --- | --- | --- | --- |
| #2027 | cancel RLM subtrees through one iterative visited walk | snimu | TAKE（最高优先）→ **已摘 `ebb26a3ac`** | 本地 HEAD 已暴露同一指数病：`agent-session.ts` 三个 walker（`hasRunningRlmChildren`/`getRlmChildSession`/`deleteInactiveRlmSubagent`）在两个 map 上无 visited 集合递归，k 个已完成中间节点 = 2^k 次遍历；且 `hasRunningRlmChildren()` 在每次 roster/会话列表 flush 上跑 → fork 历史第一痛点（worker 228% CPU / 2GB）的第二个根因。 |
| #1947 | persist kernel stderr to disk and bound the in-memory tail | snimu | TAKE → **已摘 `7f5e1ba3a`**（+3 处 fork 适配） | 零冲突（4 CLEAN + 1 新文件）；本地 `repl-manager.ts` 的 `kernelStderr` 字符串终身无界增长仍在。适配 = `openSync(path,"a",0o600)` + no-follow（否则重开 F3 的口子，lane B 风险 R6）；现行落点 `repl-manager.ts:21/:269/:271`。 |
| #1896 | retry empty final turns instead of silently abandoning | snimu | TAKE（需补 fork 适配）→ **已摘 `b20f16427`** | agent-loop 部分白拿；`agent-session.ts` 那段与本地 F70（`f98d84ada`）治同一病、生产里是死代码但仍要整取。两处必修适配：① 本地 stall 路径会**双发 `message_end`**；② 每轮重试在 TUI 留最多 2 个未 settle 的孤儿组件（`interactive-mode.ts` 每个 `message_start` 都 new + addChild）。另：空的 faux 固定响应会被重试 3 次 → 回归面要跑。**本轮已摘（`b20f16427`，6 文件自动合并零冲突，+235 −13）**：两处适配都落地（`packages/agent/src/agent-loop.ts` 删掉 `finishStalledMessage` 的内层 `message_end` emit，否则 stall 回合双发 ⇒ 同一条助手消息落盘两次 + 扩展 handler 与 telemetry usage 双触发；`src/modes/interactive/interactive-mode.ts` 改成先 settle/移除前一个 `streamingComponent`，堵住 R5 的幽灵气泡）；`agent-session.ts` 那个 hunk 在本地生产路径**惰性**（F70 `f98d84ada` 已先回父代理并 bump `_parentReplyCount`，正是该 hunk 的守卫条件），仍整取因为上游 recursion pin 用不带 agent-message controller 的夹具走它。碎片归并 `7a6e74c57`。 |
| #1389 | keep the original session running and listed when forking | snimu | 碰（巨型组里唯一推荐）→ 未动 | 10 CLEAN + 2 新文件、零冲突；与本地 F42 正交互补、与 F5/F6 capability 机制吻合。落地 4 步里第 ② 步必须在 `resolveForkTarget` 补回本地 F42 的 3 行，否则 F42 在 `fork()` 路径静默失效。 |
| #524 | import coding harness sessions during onboarding | kevinjosethomas | 可碰但只摘新目录 → 未动 | 11 个 `src/core/session-import/*` 新文件零撞面；但接线面 `interactive-mode.ts` 16 hunk（本地 16 提交），且 `mkdirSync` 无 0700、不走 `private-files.ts`、`opencode.ts` 用 `node:sqlite` 打开外来 DB。 |
| #1994 | harden native Windows runtime | sethkarten | 整体不碰，可单摘 2 文件 → 未动 | `session-lease.ts` 的 fail-closed 改写正面吃本地 `a807f3055`+`3a450907d`；`stdin-buffer.ts` 新增 paste 旁路不进本地 pasteMode/watchdog；只有 `kernel/bootstrap.ts` 与 `utils/shell.ts` 可白拿。base 是未合的 #1982。 |
| #1928 | refresh models from a hosted catalog | sethkarten | 观察 → 未动 | 零文本冲突但**正面撞别 lane 未提交改动**（同一 base blob `4ebf6c3b8d`）：它整块删掉 `model-registry.ts` 的 `OpenAICompletionsCompatSchema` 搬去 `packages/ai/src/model-compat-schema.ts`，而别 lane 正往那块加 4 个字段。严重度实测下调（新 schema 非严格变体 `additionalProperties:true`，`models.json` 不会变 invalid），代价是 4 个字段退化成「允许但无类型校验」。且 fork 纪律是精确模型选择器，不接受 built-in 列表随远端漂。 |
| #1996 | let root agents create sibling sessions | sethkarten | 观察 → 未动 | 它造出的 `lifecycle:"resident"` depth-0 会话**不进 `_activeRlmChildRuns`/`_rlmChildSessions`** → 躲开 #2027 迭代器、本地 F2、`waitForRlmQuiescence`、abort 级联；PR diff 里 grep `quota`/`budget` = 0 命中，也不受 `RLM_MAX_DEPTH` 约束；`RUNTIME_READY_CHECK` 新增 `assert callable(rlm.create_session)` 是硬闸。 |
| #305 | add plan mode (kernel-enforced no-edit toggle) | kevinjosethomas | 观察（当设计参考自研）→ 未动 | 价值最高的一个（现在「全程只读」只靠提示词），但 7 月的 PR 早于内核换血：9 文件 STALE（补丁在 main 上全打不上）+ 6 文件部分 hunk 被拒，TS 侧要重做，不能 cherry-pick。自研要先想清楚两个坑：macOS `sandbox-exec` 已被 Apple 弃用 → fallback 白名单是主路径；`_FALLBACK_GIT_SUBCOMMANDS` 要逐条核是否覆盖 `cat-file`/`merge-tree`/`rev-parse`/`ls-tree`。 |
| #1177 | preserve typed system-prompt provenance | sethkarten | 观察 → 未动 | 标题骗人：commit 列表里的 sleep/简明英语提示词改动**已被作者自己删掉**（diff grep 0 命中，且那两条已在本地 `prompts/rlm.ts:17/:24`）；剩下的是纯 provenance 类型化，本地没报过这个 bug。 |
| #1252 | handle clipboard helper failures | sethkarten | 观察（白拿级）→ 未动 | 本机 macOS 走 `pbcopy`，收益几乎为零；真正收益在 Linux/Wayland。可作为本地 F11/F46「子进程生命周期归属」族的参考实现。 |
| #2028 | move the semantic-edge ledger onto the event-log substrate | snimu | 观察（跟同步链一起拿）→ 未动 | 5 文件全 LOCAL_ABSENT（依赖 #1885/#1987）；它的「未终止尾行 = 未提交 append」裁定与本地 F39/F58 同方向，可互证口径。 |
| #1581 | bump esbuild 0.28.1 → 0.28.2 | dependabot | 观察 → 未动 | 满足 7 天（11.55 d）；5 个修复里本 fork 对 4 个零暴露，第 5 个（top-level await）在禁跑构建前提下无法证伪；且与 #1970 互斥（Bun 换掉 esbuild 执行路径）。 |
| #525 | harden dependency supply chain | kevinjosethomas | SKIP → — | fork 不发 release、不跑官方 CI；而它把 `check:dependencies` 串进 `npm run check`（fork 每条车道的强制门），本地 lock 已漂（228 hunk 拒 34）→ 大概率当场红；且与 #1970 互斥（#1970 删 `package-lock.json`，#525 修它的 integrity）。 |
| #638 | add trace sharing feature hint | kevinjosethomas | SKIP → — | Bugbot 自己的摘要就写了它与既有 `trace-sharing` hint 指向同一命令 → 纯重复；且与本地 F62（`0092dd04a` /share 上传前脱敏 + 确认）取向相反。 |
| #1175 | [v0.8 MCP 1/4] generic MCP transport foundation | sethkarten | SKIP（已被 main 超越）→ — | 本地 HEAD 已有 `rlm/mcp.py:507 list_tools`/`:511 call_tool`、`mcp_base.py:254/:277`、`mcp-manager.ts:236` 的 generic kernel API；且它是 4 个一叠的第 1 个，单拿留半截。 |
| #1176 | [v0.8 Release 1/3] bind artifacts to immutable source commits | sethkarten | SKIP → — | 作者自述 “Draft only: no reviewer requests and not ready for review yet”；fork 不打 release、不跑 `build-binaries.yml`。 |
| #1886 | kernel test fixtures speak protocol 3 | snimu | SKIP（本地已有）→ — | 实测 `ALREADY_IN_main` ×2：本地两处夹具已是 `protocol: 3`（`ipython-provisioner.test.ts:76`、`repl-kernel-protocol-corruption.test.ts:35,38`），`repl-manager.ts:53` 是 3；本文件也记过「已手动应用」。 |
| #1582 | bump @types/node 22.20.1 → 26.2.0 | dependabot | SKIP → — | 满足 7 天（12.64 d），但 `engines.node` 仍是 `>=22.8.0`/`>=20.0.0` → 类型面与运行时地板缺口拉到 2 个真实 major；`undici-types` 跨大版本会打在本地改动最密的 fetch 面上；目标版本已落后（合规最新 26.4.0）。 |
| #2018 | bump mcp 2.0.0 → 2.1.1 (runtime) | dependabot | TAKE → 未动 | 零冲突（`uv.lock` blob 与 PR base 逐字节相同）；满足 7 天（8.71 d）；2.0.0→2.1.1 零源码模块删除、本地 5 处 mcp import 全在、`pyproject.toml:7` 约束 `mcp>=2,<3`；Bun 线不影响 `uv.lock`。 |
| #2017 | bump tyro 1.0.15 → 1.0.16 (runtime) | dependabot | TAKE → 未动 | 零冲突；满足 7 天（11.33 d）；唯一行为变更只作用于「root 级 subcommand 是**类**」，本地 `tyro.cli(func,...)` 传的是函数。 |
| #1579 | bump marked 18.0.7 → 18.0.9 | dependabot | TAKE（**改拿 18.0.10**）→ 未动 | 满足 7 天（16.19 d）；修复正打在 fork 唯一 marked 消费者手写的 em/strong/blockquote 嵌套逻辑上（`packages/tui/src/components/markdown.ts`，本地 F27a 改过）；18.0.10 已 17.0 d 合规且多 3 个修复（含 `keep the em/strong mask the same length as the source`）。这条要留给能跑测试的车道。 |
| #1577 | bump actions/github-script 7.0.1 → 9.0.0 | dependabot | TAKE → 未动 | 满足 7 天（132.43 d）；v9 三条 breaking change 本地一条都不碰，SHA pin `3a2844b7…` 经 tag deref 核验一致；主要收益是把与官方的 workflow diff 面压到最小。 |
| #1576 | bump actions/checkout 7.0.0 → 7.0.1 | dependabot | TAKE → 未动 | 8 个里最干净：3/3 文件 blob 逐字节相同、6 处 checkout 全覆盖、SHA pin `3d3c42e5…` 核验一致；含 `--unset` 转义这类 git config 注入加固。 |
| #2025 | add sandbox-backed session foundations | sethkarten | 不碰 → — | 作者自述 “Draft. Do not merge yet.”；把 `RlmSubagentRuntime` union 化 → 本地三处直接访问 `.session` 类型层不成立；撞本地刚落地的 F5/F6 capability 闸。`gh pr diff` 返回 HTTP 406（+170636 行），只有 100 条文件清单。 |
| #1970 | build: make Bun the primary runtime | sethkarten | 不碰 → — | 对 main 已 CONFLICTING/DIRTY；21 文件冲突（含 5 个 `vitest.config.ts` 被删）；删 `package-lock.json` 与 `.npmrc`（7 天规则迁到 `bunfig.toml: minimumReleaseAge = 604800`，语义保留）；**`bunfig.toml` 的 `pathIgnorePatterns` 永久排除 3 个测试文件**（风险 R1）。 |
| #1982 | feat: add native Windows support | sethkarten | 不碰 → — | 22 文件冲突；官方 per-user 管道名与本地 F4（`2637973c1`）的 SID 名 + DACL + `daemonIpcListenOptions` 互不兼容；取 theirs 会让本地 F4 与 lease 双修变死代码，**且这四条的测试文件也在 PR 改动面内 → 不红灯**（风险 R2）。base 是未合的 #1970。 |
| #1980 | build: prepare provisional Prime Intellect Bun packages | sethkarten | 不碰（排最后）→ — | 全仓 `@earendil-works/pi-*` → `@prime-intellect/prime-agent-*` 重命名；本地 554 个文件引用 `@earendil-works`，与本地自改文件交集 81 个，且撞主仓当前 4 个在途未提交文件。diff 超限（HTTP 406）。 |
| #1157 | feat(swarm): provider-neutral role policy | sethkarten | 不碰 → — | base 是 `perf/c01-identity-fencing`，依赖的 4 个 sha 对本地全部 `--is-ancestor` = NO；撞 `agent-session.ts`（17 hunk，本地 29 提交）与 `daemon-mode.ts`（+304）。 |
| #1169 | N01: incremental structured-output streaming parser | sethkarten | 不碰 → — | base 是未合的 #1115（`9d9cf28d`，`--is-ancestor` = NO）；`compact-session-stream.ts` 与本地 `c72b9940f` 同一起点 blob `d8e5cb2b8` 双向分叉；丢帧语义与本地 FIX-Q6「自请 resync」反向。 |


> **【R3 全面审查更正（X2(k)）：上表 #1947 那行的「已摘」是忠实摘取于 *所取版本*，不是忠实于 *活的 PR*】**
> 本 fork 摘的是 **#1947 的 2026-09-02 版（`ca7f26ca5`）**。上游在 **09-04 把同一处重设计**了（head `56982582b`，**仍 OPEN**、当天还被推了 5 个 commit）：改成 **pipe + host 转发 + 5MiB 写预算 + `StringDecoder` + exit-drain + 等 close**。这些是上游第 4-9 个 commit 的内容，**本 fork 未摘 —— 不是删除**。
> ⇒ **后果**：一旦上游把 #1947 合进 main，本 fork 的 `wireChild` / `openStderrLogFd` / `waitForReady` / `cleanupResources` **四处必冲突**；而按「已摘」跳过的同步车道会让这 6 条差异永久沉淀。
> ⇒ **下一轮任务 B**：#1947 合并进 upstream main、或下一轮同步启动（以先到者为准）时，按 head `56982582b` **重取**；届时 pipe-path 的 `StringDecoder`/drain/last-words 与 `M3(k)`（无 per-spawn 写预算 + `.old` 长存）一并解决，`M1(pr)` 的 tail 挤压自动消失。
> ⇒ **方法论（已进 S9）**：行级对账证明的是「忠实于本地 pr-* 快照」，**不是**「忠实于活的 PR」。缺的一步是：行级对账之后必须 `gh pr view <n> --json headRefOid,state,mergedAt,updatedAt,commits`，把 `headRefOid` 与 fork 末次 cherry-pick 的 SHA 比、`commits[].committedDate` 与 fork uptake 的 `%cI`（换 UTC）比。另：`git log --all --grep="#NNNN"` 会捞到 **fork 自己仓**的同号 PR（`b6b7fafdd #2027` 就是 fork 仓的）⇒ 审计里引 `#NNNN` 必须写明是哪个仓。
> 「冲突」口径全部来自 lane B 的**场景 B 实测**（`base = upstream/main:<path>`、`theirs = base + PR diff`、`ours = HEAD:<path>`、`git merge-file --diff3`），即「先同步 40 提交，再看 PR 与本地 172 提交撞不撞」——本 fork 真实的集成顺序。状态词：`CLEAN` / `LOCAL_ABSENT_add` / `CONFLICT_n` / `STALE_unappliable_on_main` / `ALREADY_IN_main` / `NOOP`。

### 1.3 翻案 4 条 + 校准结论

| 上轮裁定 | PR | 现在的事实 | 翻案后 |
| --- | --- | --- | --- |
| SKIP（理由「+2308 新子系统」） | **#1885** ACP semantic-edges-v1 provenance producer | 官方已合 `1768ace56`，在本轮同步的 40 提交里；而且官方在它上面**又盖了三层**：`1c07eaad5`(#1984)、`6950bc88a`(#2021)、`118c1d90d`(#1987)，#2028 是第四层 | 不用裁了，跟 40 提交白拿。当初 SKIP 的真实代价不是「少一个子系统」，是**链上每一环都要单独 rebase** |
| SKIP | **#1842** single-source the interactive queue state | 官方已合，且**本地已吸收**（`bab124212`） | 无需动作。但要记一笔：上轮判 SKIP 的同时，本地 F1/F43（`d9364b034`）在治同一族问题 = 自修了一个官方已给答案的东西 |
| SKIP | **#1864** enforce session ownership when joining an in-flight open | 官方已合，而且**它就是本 fork 的分叉点** `5b6c0e94e`；本地 F16 记的就是「已修，落点 `5b6c0e94e`（#1864）+ `1597ef8c3`」 | 不算翻案，算已吸收。说明上轮 SKIP 名单里混进了「本地其实已经依赖它」的条目 → 判定流程漏了一步「先查它是不是已在本地历史里」 |
| 条件观察 | **#1631** replace TUI process after update | 官方已合 `083c68dc0`，在 40 提交里 | 跟着同步白拿，**但要复核交互面**：它动 update 后替换 TUI 进程，与本地 update-restart 家族（F38 `e5eea4a6b`、F66 `f384214e3`）同区 |
| SKIP | **#1633** | #1928 的 body 第一行明写 `Supersedes #1633` | #1633 作废，改评 #1928（判观察） |

另：上轮「条件观察」的 #1756 / #1845 / #1859 也已被官方合并且本地已吸收（`ee8fd6996` / `c0334a176` / `dab03c00c`）。

**校准结论（一句话）：上轮的偏差主要是「漏扫」，不是「判错」。**
- 漏扫 **17 个**（这 30 个里有 17 个在上轮审计日 2026-08-29 之前就存在，上轮那份「72 个 open PR 全扫」没覆盖到）：#305(07-01)、#524/#525(07-23)、#638(08-05)、#1157/#1169/#1175/#1176/#1177(全部 08-10 同一天)、#1252(08-11)、#1389(08-14)、5 个 dependabot(全部 08-20 同一批)、#1886(08-28)。
- 漏扫的形状很有规律：**按作者 + 按栈 + 按 label 就能一次捞干净**（`sethkarten` 的 5 个 v0.8 成栈 PR、`kevinjosethomas` 的 4 个老 PR、dependabot 的 `dependencies`/`javascript`/`github_actions`/`python:uv` label），而不是按 PR 号增量扫。
- 真正判错的只有 **#1885** 一条。
- **反向校准**：上轮 TAKE 的 9 个（#1882 / #367 / #1700 / #413 / #1249 / #1253 / #1251 / #1519 / #887）本轮**无一反证** → TAKE 判据可靠，偏的只是 SKIP/观察那半边（偏向「按规模与新颖度筛」，漏了「按链条与 base 筛」）。

### 1.4 三条新判据（下一轮评估前先跑，都是一两行只读命令）

1. **「+N 行新子系统」不是 SKIP 的充分理由。** 先问：**它是不是官方演进链的基座？** 可查信号：作者是不是 staff（`sethkarten`/`snimu`/`kevinjosethomas` 三人包了本轮 30 个里的 23 个）、body 里有没有 Linear 号（#2027 `RES-1265`、#1947 `RES-1246`、#1996 `RES-1256`、#1896 `ENG-5795`、#1928 `ENG-5435`）、有没有后续 PR 明写 `Supersedes`/`Depends on`/`Part of` 指向它。**有链的，SKIP 的代价会复利。**
2. **「base 不是 main」应该是第一道筛子，比行数更早用。** `gh pr view <n> --json baseRefName` → base 不是 `main` 的先跑 `git merge-base --is-ancestor <base-sha> <本地分支>`，NO 就直接判「不碰（需先吞整条未合栈）」，**不用再读 diff**。本轮 9 个巨型 PR 里 5 个靠这一步就出局（#1982/#1980 base = #1970，#1994 base = #1982，#1169 base = #1115 head `9d9cf28d`，#1157 base = `perf/c01-identity-fencing`；四个 perf sha 对本地全部 `--is-ancestor` = NO）。行数反而最不重要：#2025 那 +170636 行绝大部分是新文件，撞面比 #1994 的 +2073 还小。
3. **把「官方会自己合」当默认假设，并加一道「是否已在本地历史」的前置检查。** 官方在 09-01~09-03 三天内新开 8 个 PR，全部出自两位 staff → fork「官方合得太慢，不等了」的窗口比上轮更窄。评估每个 PR 前先跑两行：`git log --oneline <本地分支> --grep "(#<n>)"` 与 `git log --oneline upstream/main --grep "(#<n>)"`。本轮 #1886 靠这个直接出局（`ALREADY_IN_main` + 本地夹具已是 `protocol: 3`），上轮 #1864/#1842 就是漏了这步。
4. **（方法论，不是判据）冲突判定用可复跑的三方合并模拟，不要靠人读 diff 猜。** lane B 的模拟器 30 个 PR 全跑一遍只要几十秒，且能区分「文本冲突」/「PR 落后打不上」/「已在 main」/「本地没这个文件」四种完全不同的情况；脚本逻辑抄在 `/tmp/sync_b_newprs.md` 附录 A。

### 1.5 三条「不会红灯」的风险（已进 S8 收口清单，下一轮碰这些 PR 前必读）

| # | 风险 | 触发条件 | 为什么不红灯 |
| --- | --- | --- | --- |
| **R1** | 跟 Bun 线会**永久排除 3 个测试文件** | 拿 #1970/#1982/#1980/#1994 任一条 | #1970 的 `bunfig.toml` `[test] pathIgnorePatterns` 排除 `daemon-supervisor-process.test.ts`/`compiled-artifact-smoke.test.ts`/`daemon-supervisor-monitor.test.ts`；其中第三个属本地 F24/F25 回归面同区。**全量跑照样绿，只是断言永不执行** → 收工标准必须报 ignore/SKIP 数（本仓已有这条纪律） |
| **R2** | Windows 线会**静默吃掉本地 4 条已修好的 bug** | 解 #1982/#1994 冲突时取 theirs | 本地 F4 `2637973c1`（管道 SID 名 + DACL + `daemonIpcListenOptions`）与 lease 双修 `a807f3055`+`3a450907d`，**这四条的测试文件也在 PR 改动面内**，会跟着被官方版本覆盖 → 跟 Windows 线之前必须先把这几条测试单独拎出来当守门 |
| **R5** | #1896 的重试会在本地 TUI 留幽灵气泡（**本轮已堵**：`b20f16427` 的 `interactive-mode.ts` 适配改成先 settle/移除前一个组件） | 拿 #1896 且不补适配 | 两次 `message_start` 之间没有 `message_end`；本地 `interactive-mode.ts` 每个 `message_start` 都 `new AssistantMessageComponent` + `addChild` → 留一个 thinking-only、永不 settle 的气泡，直到 `enforceChatComponentCap` 重建才被清掉。**看起来像「模型在想但没输出」，不报错** |

其余风险（会红灯或已有对策）：R3（#1996 的平级会话躲开全部回收机制，只有 90 min idle 驱逐能收）、R4（#1928 搬走别 lane 正在改的 compat schema，严重度已实测下调）、R6（#1947 会重开 F3 的口子 → **本轮已在 `7f5e1ba3a` 补 `0o600` + no-follow 堵住**）、R7（schema 26 撞号 → **本轮已升 27 消解**）、R8（#525 会给每条车道加一道大概率红的门）、R9（#2027 拖着不拿，深链越多越容易冻 → **本轮已摘**）、R10（#305 自研的两个坑）。

### 1.6 一条 fork 可以自研、不必等官方的 deps 修复

上游 main 有一个既存的 **`@types/node` split-brain**：lock 里装着 4 份 `@types/node`（root 22.20.1 + 三个子包 24.13.3）与 4 份 `undici-types`（6.21.0 + 三个 7.18.2），因为 root 声明 `^22.10.5` 与子包 `^24.3.0` 不兼容、npm 无法 hoist。而 `tsconfig.base.json:21` 是 `"types": ["node"]` → **`npm run check` 按 root 的 Node 22 类型检查全部四个包的源码，`npm run build` 按各包的 Node 24 类型检查**。对齐到 CI 实际跑的 22.x 即可，与 Bun 线无关、不需要跑 tsgo 也能判方向。**本轮未动。**

## 二、本轮新缺陷 F71-F77（接 F70c 续号）

状态栏沿用本文件口径：`[ ]` 未处理 / `[~]` 进行中 / `[x]` 已修。

- [ ] **F71 semantic-edges ledger 绕过本地私有文件硬化**（密钥与日志 / 权限边界，P1 级）
  官方新模块 `src/core/semantic-edges.ts` 只 import 裸 `node:fs`（`:2`），写入是 `mkdirSync(dirname(this._ledgerPath), { recursive: true })`（**`:357`，无 mode**）+ `appendFileSync`（`:363`/`:367`）；而本地 `src/utils/private-files.ts` 的口径是 `PRIVATE_DIRECTORY_MODE = 0o700`（`:24`）/ `PRIVATE_FILE_MODE = 0o600`（`:25`）+ `ensureNoSymlinkPath` + 原子写。⇒ 新盘上产物**目录非 0700、文件非 0600、无 no-follow**，与本地 #1249/#1105（F3 `e4bb3f3cf`）的私有存储投资方向相反。
  ledger 路径 = `semanticEdgeLedgerPath({rlmSessionDir, sessionArtifactDir})`（`:98-103`）= `join(rlmSessionDir ?? sessionArtifactDir, "semantic-edges.jsonl")`（`:32`）。
  内容敏感度：semantic edge 事件带 sessionId / parentSessionId / spawnedByRequestId 与请求级 provenance，不是密钥，但落在与 session jsonl 同一棵目录树里、按 F3 的口径应当同权。
  修法方向：把 `_append()` 的建目录与追加改走 `private-files.ts`（`ensurePrivateDirectory` + 带 mode 的 append + no-follow）。**不动官方模块的语义**，只换 IO 原语；改完要复跑官方 `test/semantic-edges.test.ts`（52）与 `test/agent-session-semantic-edges.test.ts`（23）。
  备注：F72 的修复（`bdd5bcd82`）只挡住了非持久化会话，**持久化会话的 ledger 仍走这条非硬化路径** → 本条独立成立，是 S9 待办第 1 项。

- [x] **F72 临时 RLM 后代在盘上留 `semantic-edges.jsonl`，打破本地非持久化不变量**（隐私 / 会话生命周期，P1 级） — 已修，落点：`bdd5bcd82`
  本地不变量：root 非持久化 ⇒ 后代全在内存、`session_dir` 不落 `.jsonl`（本地独有回归 `test/agent-session-recursion.test.ts` “keeps RLM descendants in memory when the root session is non-persisted”，断言 `:394` `readdirSync(childHandle.session_dir).some(name => name.endsWith(".jsonl")) === false`）。
  机制：`semantic-edges.ts` **零持久化判定**（`grep "allowsPersistence|inMemory|isPersisted|persist"` = 0 命中），`_append()`（`:351-370`）只判 `_disabled` 与 `_ledgerPath`；而临时 RLM 子会话正好有 `rlmSessionDir` ⇒ 必写。调用侧 `agent-session-services.ts` 无条件传路径。实测现场：
  ```
  DIAG child session_dir entries      = ["semantic-edges.jsonl","sub-4040233a"]
  DIAG grandchild session_dir entries = ["semantic-edges.jsonl"]
  ```
  同段另两条断言（`allowsPersistence() === false`、`sessionFile === undefined`）**仍绿** → 会话本体没落盘，只是多了这个 ledger。
  归因（四个提交点逐个实跑，独立 scratch worktree，跑完已删）：`0c504e475` **1 passed** → `3367d85c4`(merge) **1 failed** → `e59a452ce` 1 failed → `f22e65312` 1 failed ⇒ **merge 本身引入**，与 S7/p9/p11 后续提交无关。
  修法（采 lane 建议的 (a)，不改官方模块）：两处 wiring 都加 `SessionManager.allowsPersistence()` 守卫 —— recorder 本体 `agent-session.ts:1364`、trace-outbox 注册 `agent-session-services.ts:231`（后者否则会把一个永不存在的文件标成 pending sync）。`SemanticEdgeRecorder.ledgerPath` 本就 optional、append 路径已判它 ⇒ 传 `undefined` 即干净停用。
  验证：持久化会话面不变（`agent-session-semantic-edges` 23 / `semantic-edges` 52 / agent-traces 54 全绿），本地独有那条回归由红转绿。
  另一条路（未采）：收窄本地断言、接受新行为 = **用户可见变更**，需补碎片 bullet 并进行为变更清单。

- [x] **F73 `fixq5-q7` 假 supervisor 缺 roster 桩**（merge 后果 / 测试面，P2 级） — 已修，落点：`f22e65312`（+21 / −0，纯新增）
  红因：`Error: Unknown active session: active-seed-integrity`，抛自 `daemon-supervisor.ts` 的 `findWorker`，链 `attachClient` → 测试 `:323`/`:362`。`local_base`（`0c504e475`）上该文件 `✓ 4 tests` 全绿 ⇒ **本轮 merge 引入**。
  机制：上游把 `matchWorkers` 的遍历源从 `for (const worker of this.workers.values())` 换成 `for (const entry of this.roster().values())`（`entry.workerId` → `this.workers.get(...)`，summary 由 `sessionSummaryFromRosterEntry(entry)` 生成）。该本地测试用 `Object.assign(Object.create(DaemonSupervisor.prototype), { workers, clients, streamReconstructor, syncWorkerExtensionUi })` 造假 supervisor，**只 seed `worker.summaries`（新代码完全不读）**、无 roster ⇒ 惰性建出**空 roster** ⇒ 0 匹配 ⇒ 兜底 `refreshWorkerSummaries` 撞上假 worker 的 `client: {}`（无 `request`）⇒ 抛错被 `.catch(() => undefined)` 吞 ⇒ 仍 0 ⇒ `Unknown active session`。
  这就是铁律 9 预言的事故类型：**本地独有测试不参与三方合并，git 一句话不说**。
  修法：加 `rosterStub(workerId, row)` helper（现 `:91`）返回 `{ values: () => AgentRosterEntry[] }`，在两处 `Object.assign` 里 shadow 私有 `roster()`（现 `:338`/`:378`），与该测试既有造假风格一致；roster 行类型 `RosterSessionSummary = Omit<SessionSummary, "streamingMessage" | "sessionActions" | "diagnostics">`（`agent-roster.ts:40`）⇒ 夹具走 roster 形状**什么都不丢**。
  验证：`✓ 4 tests`；收口重跑 54 个本地独有文件从 `3 failed|197 passed` 变 `1 failed|199 passed`。
  **同类风险的收口扫描建议**（p9 提，已采纳为待办）：`grep -rn "Object.create(DaemonSupervisor.prototype)" test/` 逐个核它走的路径是否经过 `matchWorkers`/`handleList`/其他已改读 roster 的方法；凡经过的，只 seed `worker.summaries` 就会**静默 0 匹配**（不是崩，是走到兜底再抛「Unknown active session」这类**指向 selector 而不指向缺失 roster** 的误导性错），排查成本高于普通回归。本轮实测：该模式 11 个文件里**只有 fixq5-q7 一处成真**，其余 10 个要么不走已改读 roster 的方法、要么本来就 seed 了 roster（`daemon-peer-transport.test.ts:465` 用真 `AgentRoster`，是正面例子）。

- [x] **F74 `agents-view-roster` 假 connection 缺 `streamReconstructor`**（merge 后果 / 跨轴对撞，P2 级） — 已修，落点：`13f623676`（+1 / −0）
  红因：`keeps a recovered session attach alive when the roster subscribe fails` 失败，栈 `reseedStreamReconstructor`（`daemon-agent-connection.ts:2323`）← `attach`（`:451`）← 测试 `:184`（现 `:200`）。
  定性：**上游独有测试文件 × 本地独有 src 接缝**。上游新测试用 `Object.create(DaemonAgentConnection.prototype)`（现 `:188`）调真 `attach()`，但 `reseedStreamReconstructor` 溯源到本地 `c72b9940f` + `72942804b`（streaming_deltas / seed 完整性），上游假件里没有 `streamReconstructor` 成员 ⇒ 读 `undefined.hasPartial` 抛。
  修法：假件补 1 行 `streamReconstructor: { seed: vi.fn(), clear: vi.fn(), hasPartial: vi.fn(() => false) }`（现 `:196`）。**不走 src 侧加容错**（那是 fail-open，会吞真故障）。
  验证：该文件 `✓ 8 tests`；15 个官方新增测试文件整体 `15 files / 153 tests` 全绿。connection-seam 类全仓**只有这一处**，已闭合。

- [x] **F75 `test/extensions-timeout.test.ts:128`（原 `:102`，被本批 B1 的钉子挤下去 26 行；recheck-k3 重跑实测失败在 `:128:25`） 既有红**（测试面 / 本地独有，P2 级；**不属本轮**）
  `expect(result.errors).toHaveLength(1)` 实得 2（`AssertionError: expected [ { …(2) }, { …(2) } ] to have a length of 1 but got 2`）。
  **merge 之前就红**：在独立 scratch worktree `/tmp/r3-base` @ `0c504e475` 上逐字同样失败（同文件同行同断言同消息），跑完 `git worktree remove --force`（残留 0、本树 status 0 行、主仓哨兵 ` M`=4）。⇒ 进已知红清单第 6 项（父代理 2026-09-04 裁定新增），**不是本轮的账，但需有人认领**。
  性质：本地独有的 extension factory 超时测试（`320b720f0` “time out hung extension handlers so sessions stay live” 家族），其期望与 `src/core/extensions/timeout.ts` 现语义已不符 —— `loadExtensions([hangPath, okPath], tempDir, undefined, 40)` 现在**两条都进 errors**（超时 40ms 太紧，正常那条也超时），而测试仍期望「只有 hang 那条进 errors、ok 那条正常加载」（`:103-105` 还断言 `result.errors[0].error` 含 `"timed out"`、`result.extensions[0].path === okPath`）。
  **R3 全面审查已实测（L11 / 父代理裁定：不修、据此关闭或重审 F75）**：这条红是**既有 extension-loading 家族红**，红因在 `loadExtensionModule` 的实现，**不在 `loader.ts` / `timeout.ts` 两个模块** —— 证据：把 `src/core/extensions/timeout.ts` 换回 B1 修复**之前**的原文（`git show HEAD:` 取，sha256 `9c0814a6309f2870`）重跑，`test:102` **逐字同样红**（`errors` 实得 2 vs 期望 1）⇒ 与 B1 无因果。代码层佐证：`loader.ts:427-456` 是串行加载、超时只包住 `factory(api)`、**转译在超时之外**，所以 40ms 预算不可能让一个同步的 `ok.ts` 失败。⇒ **别改测试断言**（把正确行为钉成错误行为）；要动就转 `loadExtensionModule` 的实现。

- [ ] **F76 `WINDOWS_NAMED_PIPE_ACL_UNVERIFIED` 是死导出**（文档漂移 / 未覆盖面记录，P3 级；**既有，非本轮造成**）
  `src/modes/daemon/windows-named-pipe.ts:6`：
  ```ts
  export const WINDOWS_NAMED_PIPE_ACL_UNVERIFIED = "Windows named-pipe ACL application is not hardware-verified in CI";
  ```
  全仓 `--include=*.ts --include=*.md` 命中 **1**（只有它自己的声明行）；其**值字符串**也没被任何地方以字面量引用；`test/windows-named-pipe.test.ts` 里也**没有**这条 caveat。
  不是本轮造成的：`git diff --stat 0c504e475 HEAD -- <该文件>` **无输出**（本轮 merge 未改该文件），且 `0c504e475` 版里 `grep -c` 同样是 1。
  性质：一段「CI 里没有真硬件验证 Windows 命名管道 ACL」的免责声明常量，从措辞看原本大概是要被测试或文档引用的。无行为影响（纯字符串），但属**无人认领的 dead export**，且它与本文件 F4（`2637973c1`，标注「Windows 未实机验证」）是同一条未覆盖面。
  修法方向：**建议接不建议删** —— 把它接进 `test/windows-named-pipe.test.ts` 作为一条显式 caveat（例如非 win32 平台的 `it.skipIf` 说明或注释引用它），因为删了等于丢掉一条已知的未覆盖面记录。若决定删，须同时把这条未覆盖面写进 `FORK_NOTES.md` 的待办与本文件的 F4 备注。
  **R3 全面审查（review-modules）补的三条事实（H3 处置：R3 只降级文档口径，不做 token 握手）**：
  ① **win32 侧没有第二道闸**：`daemon-mode.ts:3277` 的 `handleConnection` 对主 daemon 一律 `authenticated: true`，全仓没有 peer credential / token 握手；POSIX 侧还有 `daemon-socket.ts:186` 的 `chmod 0600` 兜底，**win32 无对应兜底** ⇒ ACL 是唯一鉴权闸门。
  ② **ACL 的作用范围与继承都未验证**：ACL 是在 `listen()` 回调里用 `SetNamedSecurityInfo` 打在「当时那个实例」上（`daemon-mode.ts:667` / `daemon-supervisor.ts:827`），而 libuv 建后续 pipe 实例时传的是 `NULL` `SECURITY_ATTRIBUTES`，**Windows 没有文档保证 ACL 会被后续实例继承**。
  ③ **下一轮任务口径**：win32 共享密钥握手 + capability + `DAEMON_PROTOCOL_VERSION`/`DAEMON_SCHEMA_REVISION` + 双向兼容测试 + 真机验证，**仍是收口前提**；R3 不做（协议门改动不该塞进收口批），只把 `.changes/windows-named-pipe-acl.md` 的完成态断言降级为 best-effort。

- [x] **F77 `agents-view-roster` attach 测试往开发者真实 `~/.prime/agent/logs/agent.jsonl` 写日志**（测试卫生 / 哨兵污染，P2 级） — 已修，落点：`bd35d1287`
  现场（p12 在真验证 P0-A 时撞出来，真实 agent 日志里凭空多出 2 行，时间正落在施工窗口内）：
  ```
  3105:[2026-09-04T08:58:55.200Z] roster-attach: attach degraded: Error: roster_subscribe failed: subscribe timed out
  3106:[2026-09-04T08:59:56.570Z] roster-attach: attach degraded: Error: roster_subscribe failed: subscribe timed out
  ```
  溯源：`subscribe timed out` 这个字符串**全仓只在 `test/agents-view-roster.test.ts:178` 出现**（fake client 的返回值）；该测试用 `Object.create(DaemonAgentConnection.prototype)` 调真 `connection.attach()` ⇒ 走真 `attachRosterStore("attach")` ⇒ `appendRotatingLog(getAgentLogPath(), ...)`，而 `getAgentLogPath()` 用 `getAgentDir()`；测试**没有**隔离 `PRIME_AGENT_CODING_AGENT_DIR`（同文件只给 `defaultSessionConfig` 传了 `agentDir`，管不到日志路径）。
  后果：谁拿 `roster-attach: attach degraded:` 当 P0-A（铁律 6 响亮化）的哨兵去 grep 真实日志，都会被 vitest 跑出**假阳性**（p12 当场差点把它当成「修法没生效」）。这类污染还会让「本地跑测试」与「真实现场取证」两条证据链互相串味。
  修法：该测试文件 `beforeEach` 里 `process.env[ENV_AGENT_DIR] = mkdtempSync(...)`、`afterEach` 还原（现 `:6` import `ENV_AGENT_DIR`、`:25-40` 隔离与还原，含 `inheritedAgentDir === undefined ? delete : 还原` 两支）。
  通用规则（进 S8）：**任何会走真 `appendRotatingLog`/`getAgentLogPath` 的测试都必须隔离 agent dir**；判据不是「测试有没有写文件断言」，而是「被测路径上有没有日志副作用」。

### 2.1 R2 遗留状态纠正（本轮按代码证据勾掉 F5/F6）

本文件 P1 节的 **F5**（capability 门只在客户端侧）与 **F6**（shutdown/restart/prepare_update_restart 无鉴权）此前标 `[ ]（W7 在跑）`，`FORK_NOTES.md` 也把它列在「还没做（下轮）」。实测这两条**已在 R2 末期落地**：

- `96d3db580` fix: add `declare_client_capabilities` and `control_plane` to the daemon protocol（`daemon-protocol.ts` +86）
- `7efe4b467` fix: enforce declared daemon capabilities on supervisor **and worker**（`daemon-client.ts` +40 / `daemon-mode.ts` +27 / `daemon-supervisor.ts` +29）
- `6e86b3929` fix: declare session vs control capabilities on first-party clients
- `6b8d2585b` test: cover server-side capability gating and control-plane auth（+366，含 `test/suite/regressions/w7-capability-control-plane.test.ts` 246 行）

R3 合并后的现行落点（行号已漂，按符号给）：服务端强制 = `daemon-supervisor.ts:1825` 与 `daemon-mode.ts:3655` 的 `missingDeclaredCommandCapability(...)`；控制面/会话面分流 = `daemon-mode.ts:3558` 的 `isSessionPlaneDaemonCommand(parsed.type)` 闸（直连 peer transport 上非会话面命令一律拒）。这两条在 R3 的 43 块手工解里都被点名保住（p3/p5 回执 + `/tmp/r3_closure_commands.md` §14.2：`declare_client_capabilities` src 13 / test 10 命中）。
⇒ 本节已把 F5/F6 改成 `[x]` 并补落点。若认为 W7 还有未收口的残留范围（例如控制面需要独立 token 而不只是 capability 分流），请回滚这一处并说明残留判据。

### 2.2 已知未覆盖面（R3 收口时的实况，任务书 S8.4 要求写进 S9）

1. `interactive-mode.ts` 未深审（本轮只核了与 #1896 相关的 `message_start`/`addChild`/`enforceChatComponentCap` 一条链）。
2. 三个核查脚本是新写的，自身未经验证（本轮靠正控/负控兜：`/tmp/r3_posctrl.txt` 证明冲突标记门能数到三类标记）。
3. `test/extensions-timeout.test.ts:128`（原 `:102`，被本批 B1 的钉子挤下去 26 行；recheck-k3 重跑实测失败在 `:128:25`） = F75，既有红未修。
4. Windows 命名管道 ACL 未真机验证 = F4 备注 + F76。
5. F15/F17 窄时序窗（W9 留档，k3 实证可达性极低）、F27e 次要内存项、k3 终审 7 条低危仍未动。
6. 门 2 的「54 个本地独有测试文件」是**文件级**口径，本轮已证它抓不到两类红（见 §四.4）。收口那次跑了全量（320 collected 自洽），但**下一轮若只跑文件级口径就会漏**。

7. **【R3 全面审查新增 · 已知缺口记账（下一轮输入）】**
   - **M3(k)**：kernel stderr 日志**无 per-spawn 写预算**（单 spawn 内磁盘无界，rotation 只在下次 open 触发）+ `.old` 长存。**同条还含 `:399` 的 `finally { if (stderrLogFd !== undefined) closeSync(stderrLogFd); }` 未 guard**（close 失败会让 kernel 起不来并掩盖 spawn 的原始错误；官方对这段有专门测试）。**A 批明确不半迁移**（不加预算：fd-direct 下只能 `fstat`、语义与上游完全不同 = 第三种没人审的设计）⇒ 归**下一轮任务 B**（按 #1947 head `56982582b` 重取时一并解决）。
   - **B1 放大器**：`daemon-mode.ts:637-642` 把**任何** `unhandledRejection` 变成 `process.exit(1)`（杀 daemon + 所有会话）。B1 只修了 `timeout.ts` 这一个源头，**放大器策略本身 R3 不改**（`:630-632` 注释表明它是有意的 fail-fast：先抓栈再让进程下去）。**daemon 该 `exit(1)` 还是 log-and-isolate 是可靠性设计决策**，留老板 / 下一轮。
   - **H2 调用方排序：已加自动 red-first 钉子（原「无法单测需重构」的定性错了，此处更正）**。原记账说 `handleShareCommand` 是私有方法、被 `spawnSync("gh", ["auth","status"])` 与 TUI 挡住 ⇒ 无法单测「预检必须在导出之后」，并把重构出可注入边界列为前提。**实际不需要重构**：prototype 提取（`(InteractiveMode.prototype as …).handleShareCommand.call(fakeThis)`，本仓先例 `interactive-mode-status.test.ts` 对 `createExtensionUIContext` 就是这么做的）+ `vi.mock("child_process")`（**specifier 必须与源码 `interactive-mode.ts:45` 的 `import { spawn, spawnSync } from "child_process"` 逐字一致**）即可驱动真方法。落地 = **`test/interactive-mode-share-scan-ordering.test.ts`**：导出字节里放一个**只存在于导出**的密钥、`getMessages`/`getSystemPrompt` 两个 proxy 源都返回干净内容 ⇒ **扫导出才会弹确认框**，断言 `confirmMessages` 长度 1 + 取消后临时目录计数复原。**red-first 实证**：把扫描对象换回 proxy 形状（`JSON.stringify({ messages, systemPrompt })`）⇒ **1 failed，失败是 `expected [] to have a length of 1 but got +0`、wall 1.5s = 断言红而非 30s 超时红**（超时红会把"排序错了"伪装成"环境问题"；避开它要 mock 的 `spawn` 主动 `emit("close", 0)`，因为修前路径无密钥会一路走到 gist create）。**⇒ 教训：「无法单测」的定性常是想象力失败，判它之前要先试 prototype 提取 + mock 到能让被测分支跑起来的最小集**；同轮 `handleShareCommand` 的清理边（`test/interactive-mode-share-cleanup.test.ts`）也是同法定性从"太重"翻成"可测"。**另一条配套纪律：当测试的正确性依赖某个 mock、而真实命令在本机也会成功时（本机 `gh` 已装且已登录，`gh auth status` rc=0），"测试绿"无法区分"mock 生效"与"mock 静默空转"⇒ 要用 `vi.isMockFunction(...)` + 调用计数探针坐实**（本次探针实测 `isMockFunction=true`、`calls=1`）。
   - **M5(s) digest 口径扩展 = 下一轮**：`DAEMON_SCHEMA_ID` 的摘要输入不覆盖 capability 集合与 `DAEMON_COMMAND_COMPATIBILITY`/`DAEMON_COMMAND_PLANE`，而 R3 的改动语义一半正在那里。**R3 不做**：重算 ID 会让所有在跑 daemon 立刻判 stale（`daemon-launch.ts:74-80` 的 `isCurrentDaemonHello` 比 `DAEMON_SCHEMA_ID`；`:344-347` 忙会话直接 `refusing to replace stale daemon`），属 schema-script 方法论改动。**下一轮做时的三条纪律**：M5+M6 必须同一提交；实跑验证必须在**隔离 agent dir** 下（否则 `:346` 会被自己的会话触发）；ID 用 `/tmp/r3_schema_digest.mjs` 重算、**绝不手写**。R3 本轮只改了 `daemon-protocol.ts` 的**注释**（27 已消费 → 下一个是 28；24 不是"first unambiguous revision"），**未动 `DAEMON_PROTOCOL_VERSION`/`DAEMON_SCHEMA_REVISION`/`DAEMON_SCHEMA_ID`**（提交后核过 diff 非注释行 = 0）。
   - **`:6714` 终报可经 `sendCustomMessage` 绕过时间戳（DEFER · 父代理裁定）**：`sendCustomMessage` 的 `deliverAs === "nextTurn"` 分支 push 一个泛型 `CustomMessage<T>` 到 `_pendingNextTurnMessages`，**不调 `_markRlmTerminalNoticeDeferred()`** ⇒ 若 RLM 终报经此路进来会「deferred 却无 `_rlmTerminalNoticeDeferredSince`」⇒ 无 abandonment 定时器、且 `_isDeferredRlmTerminalNoticeStale()` 在 `since === undefined` 时恒 false ⇒ **会话被永久钉住**。**可触发性已按真实对象核**：判据 `_isRlmTerminalNotice`（`:5012-5017`）只认 `RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE` / `RLM_CHILD_FAILURE_CUSTOM_TYPE`；`sendCustomMessage` 生产调用点共 4 个 —— `:7950-7958`（第一方，发 `IPYTHON_STATE_RESTORED_CUSTOM_TYPE`，**不过判据**）、`:9657-9658` 与 `:12858`（扩展 API 透传）、`daemon-mode.ts:4372`（**不传 options** ⇒ 不进该分支）；grep 生产代码「终报 customType 经 `sendCustomMessage` + `nextTurn`」= **0 命中** ⇒ **第一方不可触发**；第三方需硬编码内部常量 = **off-contract**（正规入口是 `_deferRlmTerminalNotice` / `restorePendingNextTurnMessages`，两处都调 `_markRlmTerminalNoticeDeferred()`）。**M3(s) 之前后行为逐字相同**（旧代码在 `deferredSince === undefined` 时 `maybeAbandon…` 同样早退、同样永不 abandon）⇒ **既有洞、非本轮引入**。**最小修法（下一轮，trivial）**：`:6714` 之后加 `if (this._isRlmTerminalNotice(appMessage)) this._markRlmTerminalNoticeDeferred();`（成本 = 一次 customType 字符串比较，非终报路径零额外开销）；**钉子可自动红**：`sendCustomMessage({ customType: RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE, … }, { deliverAs: "nextTurn" })` 后断言 `deferredRlmTerminalNoticeSince` 是 number（修前 undefined）。
   - **semantic-edges 双守卫的精确边界**：`bdd5bcd82` 的两处守卫（recorder 侧与 services 侧）**都必要、都 fail-closed**，堵的是**不同目录的不同写点**；其中 **`materializeSessionFile` 之后 services 侧守卫是唯一防线**（recorder 侧那条路径此时已过）。清理时**任一处都不能删**。
   - **N2 · private-files 的 perf 数字此前只活在 commit body 与 `/tmp` 脚本里（本条即入仓落点）**：`d463645f7` / `d81df5890` body 报的四组数字在仓内**原先零落点**（`grep -rn "15.2ms\|67.8us" FORK_NOTES.md docs/fork/` = 0 命中），而唯一的 bench 脚本是 `/tmp/r3_m4_bench.mts`（会被清）⇒ 下一轮无法复核"这批 memo/批处理到底值多少"。**数字与复现方式记账如下**：
     - `appendPrivateFile`：**67.8us → 23.0us** /op（`d463645f7`：256 条 FIFO memo 省掉祖先遍历与目录 mode 重申，约 35 个同步 syscall；命中仍 lstat 目录本身）
     - `appendRotatingLog`：**125.2us → 23.7us** /op（同一提交；原先父目录被走两遍——`ensurePrivateFile` 走一次、`appendPrivateFile` 再走一次；并在日志文件已存在时跳过 `ensurePrivateFile`）
     - `writePrivateFileAtomicLines` 5000 条：**15.2ms → 4.9ms**（同一提交；批成 64KiB 写，调用方传的是 per-entry generator，原先 5000 条 = 5000 个 syscall；**原子性未变**：temp 仍 fsync + rename，批中途失败仍删 temp 不 rename）
     - `appendPrivateFile` 追加：**23.0us → 22.6us** /op（`d81df5890`：memo 快路里补回目录 mode 复检，代价在噪声内；**win32 上 memo 永不命中**，因其目录不报 0700，每次都走全路径 = memo 化之前的行为、未变）
     - **复现方式**：**import 真实模块**（不是复刻实现）、**深路径**（让祖先遍历有东西可省）、**每项 2000 ops**（5000 条那项按条目数）。
     - **为什么不加"批处理必须发生"的行为钉子**：`private-files-atomic-lines.test.ts` 与 `private-files-directory-memo.test.ts` 钉的是**正确性**（原子性、命中不丢三条性质：mode 被放宽会重新收紧、目录被删会重建、换成 symlink 仍被拒），**关掉批处理这些钉子仍绿** ⇒ 批处理是**性能取舍而非正确性性质**，用行为钉子钉它等于钉实现细节（64KiB 这个数一改就红，而它本可调）。**perf 的证据形态就是这组数字 + 复现方式，不是钉子。**

## 三、路径纠错 3 条（任务书/派单给的是裸文件名，实际路径与直觉不同）

铁律 7 点名的「7 个本地独有新模块」里有两个路径不在 `src/core/`；派单里还有一处把 `rlm-ledger.ts` 写成 `src/core/`。全部实测 `git cat-file -e upstream/main:<path>` = 不存在 ⇒ 确为本地独有。

| 模块 | 派单/直觉路径 | **真实路径** | 导出符号数 |
| --- | --- | --- | --- |
| private-files | `src/core/private-files.ts` | **`packages/coding-agent/src/utils/private-files.ts`** | 10 |
| windows-named-pipe | `src/core/windows-named-pipe.ts` | **`packages/coding-agent/src/modes/daemon/windows-named-pipe.ts`** | 11 |
| rlm-ledger | `src/core/rlm-ledger.ts`（**不存在**） | **`packages/coding-agent/src/modes/daemon/rlm-ledger.ts`** | — |
| stall-watchdog | — | `packages/coding-agent/src/core/stall-watchdog.ts` | 6 |
| share-session | — | `packages/coding-agent/src/core/share-session.ts` | 6 |
| session-tool-pair | — | `packages/coding-agent/src/core/session-tool-pair.ts` | 1 |
| stall-diagnostics | — | `packages/coding-agent/src/core/stall-diagnostics.ts` | 1 |
| extensions/timeout | — | `packages/coding-agent/src/core/extensions/timeout.ts` | 4 |

教训：**派单给裸文件名时，施工代理第一步应当是 `git ls-files "**/<name>.ts"` 定位，而不是按直觉拼路径**；拼错路径的失败模式是「grep 0 命中 → 误判该资产不存在/已丢」，本轮 `rlm-ledger.ts` 就差点被误判成「派单点名的文件不存在」。

## 四、门方法论 4 条（本轮实测出来的，全部带出处）

1. **「零调用者/孤儿符号」扫描必须做两遍，否则误报率 93%。**
   biome 的 `correctness/noUnusedImports` 对未使用 import **不报**、零调用者函数也不报，`esbuild --format=esm` 只是语法门 ⇒ 孤儿判断只能靠逐符号 grep 计数。本轮扫 7 个本地独有模块的 **39 个导出符号**：第一遍数「声明文件之外」的 src/test 引用 → 疑似 **6 个零调用者 + 8 个仅测试引用**；第二遍对疑似者数「**声明文件内部**」的引用 → **13/14 是假阳性**（都在声明文件内部被用，导出是为了可测或类型面），例：`StallWatchdogStage`(:30,:191)、`SHARE_SECRET_PATTERNS`(:27)、`isWindowsSid`(:18,:27)、`applyWindowsNamedPipeSddl`(:139)、`parseWhoamiUserSid`(:46)。真孤儿只有 1 个 = **F76**。
   ⇒ 规则：**「零调用者」判定必须做文件内引用的第二遍**；只报第一遍结果的审计会把「导出给测试用的 helper」与「内部用的类型」大面积误判成死代码，进而误删。
2. **负控脚本里 `$?` 会被命令替换覆盖 —— 退码必须先存变量。**
   p6 第一版负控写成 `esbuild ... ; echo "$(basename $f) EXIT=$?"`：`$(basename $f)` 在展开 `$?` **之前**执行，把退码覆盖成 basename 的 0 ⇒ **5 个负控全部假报 EXIT=0**，看起来像「esbuild 对括号也零牙」，正好会得出与事实相反的结论。改成 `rc=$?` 先存再打印后，4 个结构负控立刻变 EXIT=1。
   ⇒ 规则：任何「靠退码判定门有没有牙」的脚本，退码必须**紧接命令**存进变量；同一行里不许有命令替换、管道或第二个命令。同族纪律：`bash()` 是 `/bin/sh`，不支持 `<(...)` 进程替换；空 stdout 被 `||` 兜底会读成假结论（本仓全局 memory 已记）。
3. **biome 不能用于 `/tmp` 副本负控 —— 那是假负控。**
   `biome.json` 的 `files.includes` 只收 `packages/*/src/**/*.ts`、`packages/*/test/**/*.ts`、`packages/coding-agent/examples/**/*.ts`；`/tmp` 路径被直接忽略，输出 `Checked 0 files` + `No files were processed in the specified paths`，**EXIT=1 但那是「没检查」不是「检查出错」**，会被误读成负控成功（p3、p8 各自独立撞到）。
   ⇒ 有效做法两条：① 变异体放**仓内真实路径**（事后删除、别提交）；② 在 `/tmp` 复刻一棵最小配置树（`cp biome.json /tmp/xxx/` + `mkdir -p /tmp/xxx/packages/coding-agent/src/...` 放副本，`cd` 进去用仓里的 `node_modules/.bin/biome check <相对路径>`），相对路径命中 `files.includes` ⇒ 配置生效、负控有牙、仓内零写入。
   ⇒ 配套：交活前每个文件都跑一次**不带 `--write`** 的 `biome check` 且 0 fix，等价于预先证明「带 `--write` 的 pre-commit 钩子对我这些文件是无操作」——否则交付形状会在 commit 那一刻被静默改写且没人复核。
4. **文件级门抓不到「共有文件里的本地独有用例」→ 收口必须跑全量。**
   S8 门 2 的口径是「54 个本地独有测试文件」（`comm -23` 文件级差集）。本轮两条红都在这个口径之外：
   - **F72** = 本地独有测试**用例**活在双方**共有**文件里（`git show d74a75fea:test/agent-session-recursion.test.ts` 无此 `it`，`0c504e475` 里在 `:377`）→ 文件级 `comm -23` 看不见；
   - **F74** = **官方独有**新文件（15 个之一）→ 也不在 54 里。
   ⇒ 门 2 应扩成三层：① 54 个本地独有文件 ② 15 个官方新增测试文件 ③ 共有文件里的本地独有用例（case 级 `comm -23`，或干脆全量跑一次）。①+② 已覆盖本轮全部已知红，**③ 只有全量跑才保险**。
   ⇒ 另一条规则：**谁动了 src，就把引用它的共有测试文件一并跑**（F72 就是这么被抓到的：S7 动了 `agent-session.ts`，收口顺手跑了 4 个 `agent-session-*` 共有测试）。
   ⇒ 对账口径沿用本仓纪律：先 `--collect-only` 核 `collected == passed + failed + skipped`（本轮 320 = 319 + 1 + 0，分项 205 + kernel 5 + agent 3 + ai 5 + tui 107 自洽），SKIP 非 0 必须说明对照面为什么不在场；`EXIT=9` 或整数秒腰斩先疑看门狗。

### 4.1 单文件门的能力边界（本轮 12 份回执反复复现，一并记档）

| 门 | 有牙的层 | **盲区** |
| --- | --- | --- |
| 冲突标记 ERE `grep -c -E "^<<<<<<<\|^=======\|^>>>>>>>"` | 残留标记 | 必须配正控（解前该文件 >0；人造孤立 `=======` 文件 =1）。**BSD grep 的 BRE 里 `$` 落在 `\|` 分支中间会被当字面量** ⇒ 数标记一律用 ERE |
| `esbuild --format=esm <file>` | **结构层**（括号/语法） | 删「融合出的新形参」「新局部名」「omit 声明」→ EXIT=0（NC5/NC6/NC7 实测） |
| `biome check <file>`（仓内路径） | **风格 + unused**（`noUnusedImports`/`noUnusedVariables`） | 同样抓不到符号语义；且对仓外路径是假负控（见 §四.3） |
| `tsgo --noEmit`（全仓） | **类型层**（含 `expect(x.success).toBe(true)` 不是类型守卫这类） | 「三参外壳」类融合：形参与调用点都在非冲突区、只有中间透传在块内 ⇒ esbuild/biome/**tsgo 三者全绿**，但被透传的能力静默失效 |
| 文件级测试口径 | 本地独有文件 | 共有文件里的本地独有用例、官方新增文件（见 §四.4） |

⇒ **符号正确性只能靠配对表**（本轮 p3/p8 各自独立发明、结论一致）：① import 三向（ours/theirs/merged）逐符号声明↔使用配对，查 0 未定义名与 0 重复声明（TS2300/TS2440/TS2451 类）；② **调用点实参直方图 ↔ 被调函数形参个数**（判据不是「形参有没有被用」，而是「块外调用点传了几个实参 ↔ 块内有没有透传到位」；p3 用它把「`omitStreamingMessages` 尾参恒 false」从担心变成硬结论：src 侧 11 个外部调用点实参全 ≤3）；③ 接口成员与 import 名的重复检查；④ 方法体三方 diff（`merged − theirs` 应全是 ours 半边、`merged − ours` 应全是官方半边）。

---


---

## 五、R3 修复批 · 六车道双审后的记账更正与教训（2026-09-05 收口）

本节是修复批（`067436d5e..HEAD`）落地后，按六车道双审（recheck-adv / recheck-k3-pf / -sess / -trap / -gap / 广度）结论做的**记账更正**。**行号一律带当前 blob 前 16 位或不写行号只写 grep 定位句**——本轮反复实证裸行号会漂（见 §五.6）。

### 5.1 F1 定性升级：`latent-with-open-precondition` → **「第一方可达真 bug（窄合取）」**

原记账把「queued 终报可无时间戳 ⇒ 永久钉住 `isSessionActive`」写成潜在缺陷、且修复提交 `f8cc06eba` 的 body 称达到它「需要一个扩展通过 `sendCustomMessage` 送终报自定义类型，这本身已属 off-contract」。

**recheck-k3-sess 建复现测试在旧 blob `beba3e0871f6a8b0` 上把危险态完整复现，并在 HEAD 上反转全绿 ⇒ 定性升级为第一方可达**。它原判「第一方不可达」的错误前提是**假设 flush 被挡 ⇔ pump 被挡**；逐字核出**不对称**：

- flush 守卫（`agent-session.ts` `_flushDeferredRlmTerminalNotices`）**第一行就含** `this._sessionInputAdmissionPauses.size > 0 ||`
- pump 的三道门**都不含** admission pause：`_scheduleSessionInputPump` 只看 `_sessionInputPumpSuspended || _queuedWorkPauses.size > 0`；`_hasSelectableSessionInput` 只看 actionStore 的 queued/selected；`_isBusyForSessionInput("pump")` = `externalBusy || _disposed || _disposing || _sessionInputPump…`

⇒ **admission pause 期间被 defer 的终报躺在 pending（flush 被挡），而此前已 admit 的回合仍可被 pump prepare**，preparation-timing 策略在 take 点把终报拿进回合局部。**第一方正常发生，无需任何 enqueue 失败。**

**正确记法（四环合取，每环都第一方，合取窄但真实）**：preparation-timing 回合（directPrompt / injected）+ admission pause 期间 defer + prepare 跨 5 分钟阈值窗口（refine barrier / commit fence 竞争 / 慢扩展钩）+ 失败后回灌。

**`f8cc06eba` 措辞更正（不改提交、按纪律只在此更正）**：body 里那句「off-contract extension」**只对 `sendCustomMessage` 入口类成立，对 checkout 类（take 路）不成立** ⇒ **checkout 类第一方可达**。修复本身已把两类都结构性关闭，仅措辞把可达性说窄了。

**修复形状三层（都已落地并各自复验）**：① 逐点标记 `f8cc06eba` ② 收口成 choke-point mutator `ded8882db` ③ **结构加固 `b118c5812`：两薄壳 + 一内核 `_enqueuePendingNextTurnMessages(messages, atFront)`，守卫只有一份 ⇒「半守卫」状态不可表达**（make illegal states unrepresentable）。**加固与钉子互补不替代**：加固让守卫不可半摘，但 unshift 路的端到端覆盖仍需不变量钉子（三级钉子 `860eb9150` + unshift 单元钉 `c5469a1f6` + scope-limit 注释 `4a7e4c1c9` + 扫描方向轴 `70a11266d`）。

### 5.2 已知红清单第 7 项：18 条 auto-refine 红 = **ENVIRONMENT（runner env 泄漏）、非 pre-R3 fork 既有红**【2026-09-05 干净环境实验更正】

**原记账（撤回）**：三级 swap（HEAD / 本轮基线 `067436d5e` / fork 基线 `0c504e475` 三层 `18 failed | 93 passed (111)` 逐字同红）判「pre-R3 就红 = fork 既有红」。**此结论错**：三级 swap 控制了**代码轴**（同 scratch 只切 commit），**没控 env 轴**——三层都在同一个 agent worker shell 里跑、`RLM_DEPTH=1` 泄漏进三层 ⇒「三层逐字同红」证的是「污染 env 下这些红稳定」不是「pre-existing 代码红」。**swap 对 env/host/负载轴天然盲（BASE 与 HEAD 共享同一 runner shell + 同一 host config + 同一机器负载）**。

**干净环境决定性实验**（`env -u` 全套 16 变量 `RLM_*`/`PRIME_AGENT_INTERNAL_*`/`PRIME_AGENT_*` + `env -i HOME/PATH/TMPDIR` 对照、`--maxWorkers=1`、工件 `~/.prime/r3_e_json/10_cleanenv/`）：auto-refine 族 7 文件（`agent-session-serialized-refine`28 + `agent-session-recursion`11 + `agent-session-queue`18 + `refine-skill`1 + `refine-extension`1 + `daemon-serialized-refine`1 + `config-integration`1 = **61 红**）**341 passed / 0 failed 全绿**（env -u 与 env -i 双确认一致）⇒ **这 61 红（含本条 18）= ENVIRONMENT（runner env 泄漏）、不是代码红**。

**泄漏机制（一阶通道）**：agent worker shell 导出 `RLM_DEPTH=1`（根代理=0、子 worker=1），vitest 与 `harness.ts` 都不清它 ⇒ `agent-session.ts` `_rlmDepth = config.rlmDepth ?? (header ?? parseDepth(process.env.RLM_DEPTH, 0))` 读到 1 ⇒ `_autoRefineAllowedForSession()` 深度门 `_rlmDepth !== 0 return false` 恒 false ⇒ auto-refine 整体关闭 ⇒ auto-refine 族测试（期望 `vi.fn()` 被调用但 got 0 times）全红。**CI（Actions runner）不导出 RLM_DEPTH ⇒ 这 61 条在 CI 全绿 ⇒ 它们不是「红」是本机跑法产物（F75 同类错误第四变体：环境不正确 ⇒ 把环境产物当代码性质）**。完整五环境轴 taxonomy（五轴 canonical）+ 三段式标签 + fork-improvement setupFiles 候选见 §5.7。

**F75（第 6 项）三级链本轮补强**：原记账已有 `0c504e475` 一层的证据；本轮补三层——① 撤本回合注释改仍红 ② `timeout.ts` 换本轮基线 `067436d5e` 版仍红（且 `f8bea4cc0` 新钉子如预期变红）**⇒ 不是 `f8bea4cc0` 的行为改动引起** ③ `git diff 067436d5e..HEAD -- <该测试>` **只有 `f8bea4cc0` 新增的那条钉子，红条目 `records a hanging file factory…` 在 diff 里 0 命中 ⇒ 红条目文本本轮未变**。

### 5.3 指针与行号更正（N6 / B5）

- **refine 的 hard preflight 承重 assert 在 `:8739`，不是派单写的 `:8737-8738`**——`:8737` 是 `}`。**grep 定位句**：`assertHarnessStateWritable(loadHarnessState(preflightDir`。
- **`_applyExtensionBindings` 当前 blob**：**定义 `:9629`**、**调用 `:9566` 与 `:9939`**、**包装点 `_withDialogTracking` 在 `:9554`**。旧 blob `84b85ed641587d7f` 的 `:9605/:9542/:9915/:9530` 全部已漂。
- **M2 的 `:3710` 是 `agent-session.ts:3710`（`isPaused` 里的 `this._pendingUiDialogs > 0,`），不是 `interactive-mode.ts:3710`**（后者是 `if (spacerWhenEmpty) {`，且该文件**无 watchdog**）。
- **A9 的注释原文在 `packages/agent/src/agent-loop.ts`，不在 `packages/coding-agent`**——按 finding 找原文必须先 `git show --stat <commit>` 拿真实文件路径（`c8f32d571` 碰的是 `packages/agent`），再全仓 `grep -rn` 不限包。
- **`createExtensionUIContext` 同名跨文件不同物**：`interactive-mode.ts` 的是**私有方法**，`daemon-extension-binding.ts` 的是**模块级函数**（daemon host 用）。**FORK_NOTES 里「23-26 四个号永久退役」已更正为「23-27 五个号、下一个可用号是 28」**（`8901d21c1`），指针改为 grep 定位句。

### 5.4 缺口与盲区记账（有意不修 / 记盲区）

- **B 扫描钉的两条已知盲区**（写进钉子注释，免得下个人以为它全覆盖）：① **薄壳必须转调内核**不由 B 钉——B 的切片 `ANCHOR_START`（内核 doc）→ `ANCHOR_END`（mark helper doc）**含两个薄壳**，薄壳绕过内核直写那行仍在块内、`inside.length >= 1` 仍成立；该性质由 **A 两路（`it.each` push/unshift）+ C 端到端时序链**钉（**实证**：unshift 薄壳绕过内核 → 2 failed = A-unshift + C，**B 不在红集**）。② **裸下标赋值 `_pendingNextTurnMessages[i] = notice`** 方法扫描与重赋值规则**都抓不到**（注释已自报 "not worth chasing"；**实测全文件 0 命中**，是"确实不存在"不是"漏追"）。
- **B 的 allowlist 是 `startsWith` 前缀匹配 ⇒ 将来合法的收缩写法（如 `= this._pendingNextTurnMessages.slice(1)`）会红 = fail-closed 有意为之**，改动必须显式，别当假红。同理，让被豁免的 goal-context push 也走 mutator 会**有意**红（MutN）。
- **A10 的三节链无单钉全覆盖**：端到端「快捷键开的对话框会暂停 watchdog」由**三节**钉——A10 的身份钉（快捷键 context **就是** runner 那份，`toBe` 不是形状）+ `8e02194a9` 的接线钉（绑定对话框开着时 armed watchdog 真 snooze）+ **静态事实**（`hasUI()` 与 `getUIContext()` 键于同一字段 ⇒ `hasUI()` 真必为包装版）。**没有单条钉子覆盖全链，断一节不会让任何单条钉子红。**
- **A10 是最小修法；整体去重是下一轮重构候选**：`interactive-mode.ts` 的 `createContext()` 与 `runner.ts` 的 `createContext()` **只在 `ui`/`hasUI` 两字段重复**；**动作字段（`newSession`/`compact` 带 TUI 副作用）与 runner 版不同构** ⇒ 整体去重会改快捷键的动作语义。**A10 只改这两字段是对的，去重另立。**
- **A8-N1（安全方向注记，不改代码）**：`compaction.ts` 的 `usage.totalTokens || input+output+cacheRead+cacheWrite` 回退——provider 不报 `totalTokens` 时，A8 携带上去的 `output` 会抬高上下文估算。**方向安全**：只可能让 compaction 略早触发，不会漏触发。
- **M3(k) 的 `:399` closeSync 未 guard**：**本条已在 §2.2 的 M3(k) 记账里（"`:399` 的 `finally { if (stderrLogFd !== undefined) closeSync(stderrLogFd); }` 未 guard"）⇒ B3 是重复项，不再单列。**
- **`:6714` 终报可经 `sendCustomMessage` 绕过时间戳**：**并入 option B 后不再单独 DEFER**（choke-point mutator 已结构性关闭该路径）。
- **F7 · memo 命中路径在祖先被换成非目录时报裸 `ENOTDIR`（已加钉子文档化 fail-closed，消息退化有意不 wrap）**：`ensurePrivateDirectory` 的 memo 快路（`validatedDirectories.has(resolved) && stillUsablePrivateDirectory(resolved)`）**跳过祖先遍历**，而 `stillUsablePrivateDirectory` 的 catch **只吞 `ENOENT`（返 false 交给完整校验重建）、其余 re-throw** ⇒ 祖先被换成非目录时它那一次 `lstatSync` 抛的 **`ENOTDIR` 直接冒泡**，取代了 memo 化之前 `ensureNoSymlinkPath` 走祖先时给的自有消息 `Refusing to use non-directory private path: <segment>`。**两者都 fail-closed**，差别是**错误身份**与**消息不再指名真正有问题的那一段**。**已加钉子**：`test/private-files-memo-ancestor.test.ts` —— 先真校验一次填充 memo，再把中间祖先换成普通文件，断言第二次调用 **`toThrow(/non-directory|ENOTDIR/)`（接受任一消息）**；钉的是"**祖先被换成非目录时 memo 命中路径仍然 FAILS-CLOSED**"这条性质，填的是既有覆盖缺口（`private-files-race.test.ts` 只覆盖**符号链接**祖先，非目录祖先无钉子）。**变异体实证**：把 `stillUsablePrivateDirectory` 的 catch 改成对非 `ENOENT` 也返 `true`（= fail-open）⇒ **1 failed，恰这条钉子**（4 个 private-files 测试文件 14 passed 的基线上）。**有意不 wrap 成自有消息，两条理由**：(a) **memo 命中路径不遍历祖先 ⇒ 无法指名具体是哪一段，只能给 generic 消息**，对一个 low 级的罕见 race 而言比裸 `ENOTDIR` 的边际改善很小；(b) **收口阶段的 behavior change 对 low 级不值 re-verification 风险**。**⇒ 归账：钉子 + 台账，不滑过收口，也不做 (iii) 的 wrap。**
- **原 4 条已知缺口不变**：M3(k) per-spawn 写预算、B1 放大器（`daemon-mode.ts` 把任何 `unhandledRejection` 变 `process.exit(1)`）、H2 排序（**本轮已加钉子 ⇒ 见 §5.5**）、M5(s) digest 口径。

### 5.5 H2 缺口状态：「未做 → 已做」

`audit-findings.md` 原 §2.2 那条「H2 调用方排序无自动 red-first 钉子 …… 无法单测 …… 若要可测需重构出可注入边界」**已在 `86b8293f1` 就地更正**：prototype 提取 + `vi.mock("child_process")` 即可驱动真方法，**不需要重构**。落地 = `test/interactive-mode-share-scan-ordering.test.ts`，red-first 实证 = 换回 proxy 形状后 **`expected [] to have a length of 1 but got +0`、wall 1.5s（断言红而非 30s 超时红）**。**「按封顶规矩这条不算 red 验证过」一句作废。**

### 5.6 本轮教训（全部实测出来，与 S9 既有各条同族）

1. **报 SHA 前必须 `git cat-file -t <sha>` 验存在**；SHA 必须在 commit **成功返回后从 git 输出复制**，不能预先写。**`git commit --only -- <paths>` 对未 tracked 的新文件会 EXIT=1**（`did not match any file(s) known to git`）⇒ **新文件先 `git add`**；**commit 的 EXIT 必须核**。本轮我曾报出 3 个不存在的 SHA，其中 1 个是在 commit 实际失败时写的 ⇒ 下游按假锚对账 `fatal`。
2. **「既有红」的定性必须做到 fork 基线**（HEAD → 本轮基线 → fork 基线三层逐字相同才叫既有）；只 swap 到本轮基线会把 merge 引入的红误记成既有进而漏修。
3. **scratch worktree 借 `node_modules` 用符号链接时，删除顺序必须「先 `os.unlink` 链接、再 `git worktree remove --force`」**；反了会顺着链接动到真依赖树。清完要核：残留 False + 真 `node_modules` isdir + `worktree list` 无该项 + 主仓哨兵完好 + 施工树 porcelain 空。
4. **给扫描类钉子扩 pattern 时，regex 的每一支都要有自己的红**。「把想到的语法都塞进同一个 regex」经常塞进**死支**——本轮 `concat` 支就是死的（真实写法 `x.concat(field)` 的 `.concat(` 调在**另一个操作数**上，任何以字段名开头的 method-call pattern 都匹配不到）。抓不到就问「这一族的真实共性是什么轴」（这里是**赋值方向**而非**方法名**），**换轴而不是硬凑 pattern**。
5. **新加的条件分支 / 防御守卫必须自带一个「去掉它就红」的变异体**，否则它要么没必要、要么没被看守。本轮 A8 的 overflow 条件化第一版就是零红（41 passed），补了钉子才红。
6. **静态核过的前提也要实跑一次才算数**。审查方在真实代码上逐字核过的前提仍可能漏**运行期环境事实**——F12 的「`_localHarnessStateDir()` 会 mkdir」实际是**目录只在首次写入时才创建**，钉子第一步就 ENOENT。**钉子的红要读失败详情，分清「被测性质红」与「环境形状红」**（ENOENT 属后者 = 假信号形状）。
7. **反向半条（断言「不发生 X」）在「删掉产生 X 的机制」这类变异体下天然 GREEN ⇒ 对该类零鉴别力**；它的价值只在「机制过度触发」类变异体上。**报变异体归因必须逐 test 名核，不能靠「这条钉子依赖那个机制」直觉推**（本轮我把 MutF 的 6 条红归因错了 1 条：反向半条其实是 GREEN，第 6 条红是 `pins while fresh`）。**归因与判据分开**：计数一直对，错的是「哪几条」的解释。
8. **改注释类 finding 要 grep 全仓同一句话，`src` 与 `test` 常各存一份**——A9 改了 `agent-loop.ts` 却漏了 `agent-loop.test.ts` 的同源残留，做 A8 时才撞见。
9. **scope-expanding 改动必须回头重核所有描述该代码 scope 的注释**——A8 把 carry 从 exhausted 分支 hoist 到全终局后，A9 刚按 F2 改对的那段注释立刻陈旧、且与新加的内层注释**互相矛盾**（外层说「到不了 compaction 路」、内层说「inflate output 会藏 overflow」），是复审方逐句对撞才发现。
10. **重定位不是走过场**：按 finding 找代码原文要 grep 全仓同名符号确认**哪个定义**（同名跨文件不同物）；笔记引号里的句子要 grep 原文核**存在**（本轮一句"covers both hosts at once"全仓 0 命中 = 我记的是转述）。**重定位能撞出笔记没记的更严重形状**——A10 的真缺口不是「包装没覆盖某 host」，而是「快捷键路绕开了 runner 那份已包装 context，且 `hasUI: true` 是硬编码的第二个谎」。
11. **「无法单测」的定性常是想象力失败**。判它之前先试 prototype 提取 + mock 到能让被测分支跑起来的**最小集**。本轮两处翻案：H2 调用方排序（原判「需重构」）、share 清理边（原判「太重」）。
12. **钉子依赖 mock、而真实实现在本机也能跑通时，绿不携带信息**——必须用 `vi.isMockFunction(...)` + 调用计数坐实 mock 真拦截了。本轮自查：nit-2 钉子 mock `"node:child_process"` 而源码 import `"child_process"`，本机 `gh` 已装且已登录（`gh auth status` rc=0）⇒ 若 mock 空转钉子照样绿；探针实测 `isMockFunction=true`、`calls=1` 才排除。**mock 的 specifier 要与源码 import 逐字对齐，别依赖归一化。**
13. **变异体锚点在文件里命中多次时，不能随便挑一个**——本轮 `this._autoRefineWritableProbe = undefined;` 命中 2 次，改用后续行组成**唯一锚**（命中 1）再打，避免「打错地方却以为验过了」。
14. **「0 SKIP」比「N passed」有信息量**；对账门必须报 SKIP 数，非 0 要说明对照面为什么不在场。**先 `--collect-only` 核 `collected == passed + failed + skipped` 再跑全量**；`EXIT=9` 或整数秒腰斩先疑看门狗。

### 5.7 E 批干净环境决定性实验：五环境轴 taxonomy + 三段式标签 + 红账最终口径（0 本轮引入 + 3 条 pre-existing 真代码红 + 80 环境）（2026-09-05）

**背景（dogfooding 陷阱）**：E 批全量测试对账在 agent worker shell 里跑，产品运行时导出内部变量（`RLM_DEPTH=1`、`PRIME_AGENT_INTERNAL_*` 全套、`PRIME_AGENT_*`）正好被产品自己的测试读取（`agent-session.ts` 读 `process.env.RLM_DEPTH`）⇒ **产品运行环境污染产品测试**。这种污染对 swap/多点对照**天然免疫**（所有层共享同一 shell），必须单独当一个轴控制。根代理 `RLM_DEPTH=0`、子 worker（build-stage-a/b、recheck-adv/recheck-final）`RLM_DEPTH=1` ⇒ 子 worker 跑的测试被污染方式与根不同。归账任何红前先 `env|sort` × `grep -rn "process\.env\.[A-Z_]*" packages/*/src` 求交集、交集里每个变量都是能改被测行为的通道。

**五环境轴 taxonomy（五轴 canonical，parent 裁定 2026-09-05：②固定为调用口径轴、本机服务/凭据为第五轴；本节初版草稿曾把「本机服务/凭据」编为「第二轴」，现按裁定更正撤回）**：

1. **①产物轴**（node_modules/dist 共享产物，F75/extension-loading）：scratch worktree 借 dist 时三级 swap「三层同红」证的是产物在三层稳定存在、不是该红为代码缺陷。
2. **②调用口径轴**（CI 矩阵 scripts/tagsFilter/shard/exclude）：E-1 调用口径层覆盖缺口（`repl-kernel-parent-watchdog` 2 条，详见下文三覆盖缺口）+ STAGE1/STAGE2/STAGE3 口径可加性（test:ci / test:process / test:kernel 互斥对方族）+ `test:process-stress` 不在 CI 矩阵（8 条 process-stress CI 从不跑、E 报告显式声明）。
3. **③runner shell 环境轴**（`RLM_*`/`PRIME_AGENT_INTERNAL_*`，含**二阶**落盘 header 通道）：本轮**深度门机制已定位子集 = 62 条**（auto-refine 50 + recursion 11 = 61 条一阶 + daemon-agent-roster 1 条二阶）；**第三轴合计 79 条**——其余 17 条（daemon-mode 4 / package-command-paths 4 / agent-session-goal 4 / 4600 'preserves a real resident faux worker…' 1 / acp-features 1 / agent-session-runtime 1 / 4606 1 / 4649 1）是由 `env -u`/`env -i` 双形态**同名转绿**坐实为 env 产物，但 `env -u` 一次掉 16 个变量 ⇒ **逐条变量归因未做**（S9 第56条：不 overstate 机制标签）。**一阶通道** `process.env.RLM_DEPTH=1` → `agent-session.ts:8261` auto-refine 门 `_rlmDepth !== 0 return false` 恒 false；**二阶通道** RLM_DEPTH=1 **烤进落盘 session header**（`session-manager.ts` `rootRlmDepthFromEnv()`）→ `rlm-ledger.ts:857` `(deletedInfo?.rlmDepth ?? 0) > 0` → knownChild=true → positivelyTopLevel=false → `:860 edges()` 抛。二阶要隔离落盘状态（全新 HOME/agent dir）；主红族 fixture 都 mkdtempSync 本次新建 ⇒ env -u 能救。
4. **④host 工具配置轴**（`~/.gitconfig` insteadOf / `GIT_*` / `SSH_*` / locale）：git-context 1 条——本机 `url.https://github.com/.insteadof git@github.com:` 把 scp 形 url 重写成 https，`src/utils/git.ts:264` 的 `git remote get-url origin` 应用 insteadOf。**单变量证明**：`10_cleanenv/cleanenv_envu_other10`（只 env -u、无 GIT_CONFIG_*）仍红 vs `13_axis_verification/git-context_hostaxis`（env -u + `GIT_CONFIG_GLOBAL=/dev/null` + `GIT_CONFIG_SYSTEM=/dev/null`）6/0 全绿 ⇒ 两组唯一差别是 GIT_CONFIG_* ⇒ host 第四轴成立、非「同时剥两轴」混淆。
5. **⑤本机服务/凭据轴**（Ollama provider / `ANTHROPIC_API_KEY` 类凭据）：coding-agent **34 凭证门 skip**（rpc 14 / agent-session-tree-navigation 10 / compaction-extensions 8 / compaction 2，门禁串 `skipIf(!API_KEY|!ANTHROPIC_API_KEY|!ANTHROPIC_OAUTH_TOKEN)`，recheck-final 逐条 grep 独立坐实）；ai 包 **Ollama 簇 6 红 + 714 skip**（**标出处**：上一轮 ai 包全量跑车道的工件，不在 E 批 json 工件集 `~/.prime/r3_e_json/`（全为 coding-agent 侧）内、recheck-final 无法独立重算，按 S9 第56条「无法独立核的数字必须标出处」记为引用值）。

**三段式标签**（基线 swap 只控代码轴、对 host/负载轴天然盲 ⇒「基线也红」只证「非本轮引入」不证「是代码红」；与 W25.3 同一纪律两面：归环境要核阈值本轮没改防 cop-out、归代码要核 host/负载轴已排除）：

1. **代码轴** = 基线 swap（同 scratch 只切 commit）：BASE=HEAD 同红 ⇒ 非本轮引入。
2. **host 轴** = `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` 隔离下转绿 ⇒ host-config 产物。
3. **能力/负载轴 vs 真代码轴** = 超时签名必须读完整 `failureMessages` 尾部区分（S9 第61条），再配预算对照（fixture timeoutMs vs 产品启动预算）与负载留证（vm_stat/loadavg 入 label）：被测进程 stderr 有 `listening` 行 = 进程已正常启动 ⇒ 不是能力缺口、要查断言/语义（4600 即此）；无 listening 行且全为握手超时 = 能力缺口（daemon-supervisor-process 族）。

**4600-unwinds 结论级更正（recheck-adv W31 + parent 独立核 + recheck-final 复核）**：**撤回**原「4600-unwinds→能力/负载轴（daemon 启动慢 flaky-by-design）」标签——那是只读签名首行 `Timed out waiting for fixture message` 的误判；**更正为 pre-existing 真代码红（fork-only defect）**。六条证据：

1. **语义冲突**：产品 `daemon-supervisor.ts:836-847` 注释与实现 `// Cron migration is best-effort: … must never keep the supervisor from starting.`（来自 `3d935f674` **#1249**）vs 测试 `4600-supervisor-singleton.test.ts:1165-1170` 写坏 cron JSON（`"{ malformed\n"`）后 `expect(await waitForType(postBindFailure, "failed")).toMatchObject({ error: expect.stringContaining("JSON") })`（来自 `d51590c41` **#1372**）⇒ 产品按 best-effort 继续启动、测试期望失败（`"failed"` 永不到来）⇒ `:218` 超时 `exit=null/null`（子进程活且已 listening）。
2. **完整 stderr 尾部**（1302 字符）：`Prime Agent daemon supervisor <uuid> listening on <sock>`，ts `21:44:51.552 → .666` = **0.114 s** 即启动监听 ⇒ supervisor 正常起来，「起不动/20s 不够」的能力缺口读法被工件自己的 stderr 推翻；只读首行就会误判。
3. **fork-only 硬证**：`git merge-base --is-ancestor 3d935f674 0c504e475` rc=0、`d51590c41` rc=0（#1249/#1372 都是 BASE 祖先）；`git branch -r --contains` 两者**只含 fork/\*、不含 upstream/main** ⇒ fork-only defect。
4. **本轮未动**：测试文件 blob BASE==HEAD 逐字相同（sha256 前 16 = `d55d16b741a9bd4b`，1187 行）；supervisor 文件本轮 +1311 行但那段 best-effort catch **逐字相同**；`timeoutMs = 20_000`（:205/:237）与 `DAEMON_STARTUP_TIMEOUT_MS = 30_000`（daemon-launch.ts:33）两边同值 ⇒ 20s<30s 预算错配也是既有的（作为设计观察成立、但不是本次失败原因）。
5. **签名同一**：4 份失败签名（BASE×2 + HEAD×2）归一化后 sha256 全等 `e3dca0d6a1b0e724`。
6. **处置**：记 **named-root-cause known-red（fork-only pre-existing defect：#1249 best-effort vs #1372 期望失败的语义冲突）**；fix 为 fork-improvement 候选（按 #1249 明示意图改测试：第二阶段期望从 `"failed"`+含 JSON 改成「启动继续成功 `ready`」+ 一条 warn 记录；反向让 supervisor fail-fast 与 `:844-845` 注释冲突）；**不现在修**（pre-existing 非本轮、超 R3 scope）。

**E 批红账最终口径（recheck-final 冷启动独立重算坐实）**：**撤回**原「红账 81→2 塌缩」与「零真代码红」两处表述，更正为：

- **81 条 test:ci 稳定红 = 79 第三轴（runner env 泄漏）+ 1 第四轴（git-context host config）+ 1 条 pre-existing 真代码红（4600）**，81=79+1+1 逐名闭合。
- **全批 = 0 本轮引入代码红 + 3 条 pre-existing 真代码红（4600 ×1，test:ci scope；roundtrip ×2，test:kernel scope）+ 80 环境（79 第三轴 + 1 第四轴）**；known-red 台账从 81 量级收敛到 3 条 named-root-cause pre-existing 真代码红，CI 与本机一致性恢复。

| 类 | 条数 | 定性 | 工件 |
| --- | --- | --- | --- |
| auto-refine 族（7文件） | 61 | ENVIRONMENT 第三轴一阶 | 干净环境 env-u + env-i 双确认 341 executed / 0 failed、61 红名逐名转绿 |
| daemon-agent-roster 等（9文件） | 18 | ENVIRONMENT 第三轴（1 条二阶已定位 `rlm-ledger.ts:857`；其余 17 条由 env-u/env-i 同名转绿坐实为 env 产物、逐条变量归因未做） | 干净环境 other10 357/2（18 转绿含 daemon-agent-roster 24/0、daemon-mode 186/0） |
| git-context | 1 | host 第四轴 | GIT_CONFIG_*/dev/null 转绿 6/0 + 本机 insteadOf 活体复现 + 单变量证明 |
| 4600-unwinds | 1 | pre-existing 真代码红（fork-only：#1249 best-effort vs #1372 期望失败语义冲突） | listening 0.114s 完整 stderr + 签名 sha256 全等 e3dca0d6a1b0e724 + blob BASE==HEAD d55d16b741a9bd4b |
| **test:ci scope 合计** | **81** | **79 环境（第三轴）+ 1 host（第四轴）+ 1 pre-existing 真代码红** | 0 本轮引入、逐名闭合 |
| roundtrip（test:kernel scope） | 2 | pre-existing 真代码红 | BASE swap 同名同签名（expected false to be true）env 无关 |

**四候选 + 2 真红最终定性（全有工件）**：两簇39 → ENVIRONMENT（干净环境转绿、撤回原「pre-existing 代码红」标签）| w7 flip2 + daemon-launch + 4685 → 资源/顺序产物（单文件 clean measure ×5 两层全绿）| proc 差1（restarts an adopted pre-roster worker）→ upstream #1897 新测试环境阻塞（merge-base --is-ancestor 硬证 + daemon 握手 1000ms 超时 + 两层 passed=0）| STAGE3 kernel2 = roundtrip2 → pre-existing 真代码红（BASE=HEAD 同名同签名）| git-context → host 第四轴（gitconfig insteadOf）| 4600-unwinds → 撤回原「能力/负载轴」标签、pre-existing 真代码红（#1249 vs #1372 语义冲突、fork-only）。

**「0 本轮引入」扩展到测试面本身（引 recheck-final §9.1/§9.2/§10，/tmp/fa_receipt_prelim.md）**：

1. 本轮新增 **23 个 `.test.ts`**（`git diff --name-status 0c504e475..HEAD packages/*/test/*` A=24 含 1 fixture）在两次 sanctioned 跑里**全部执行、0 缺席**，22 个全绿；唯一红 = `daemon-agent-roster`（第三轴二阶、干净环境同名转绿）。本轮钉子文件逐个绿：private-files-memo-ancestor 1/0（F7）、private-files-directory-memo 5/0、private-files-atomic-lines 2/0、agent-session-auto-refine-probe 3/0（F12 钉子所在文件）、agent-session-ui-dialog-pause 8/0（F4）、interactive-mode-extension-shortcut-ui 2/0（F3/A10）⇒ fix round 的 pins 全绿、新增测试面 0 代码红。
2. **17 个带红文件里 13 个 BASE..HEAD 逐字未动**（含两个最大簇 agent-session-serialized-refine 28 红、agent-session-queue 18 红与 git-context）；改过的 4 个（agent-session-recursion M 11 红第三轴+swap 双证、daemon-agent-roster A 新增 1 红第三轴二阶、daemon-mode M 4 红、agent-session-runtime M 1 红第三轴）里，**16 条红用例的用例体本轮 changed_inside=0**（同批文件里另有 9/2/7 个用例体确实被本轮改过并被解析器抓到 ⇒ 仪器有牙、0 非假 0）。
3. 第 17 条红所在文件 `daemon-agent-roster.test.ts` 由 **upstream `8d5722ee9` (#1897)** 新增（`--contains` 含 upstream/main、`is-ancestor … 0c504e475` rc=1），与 `daemon-supervisor-process` 差 1 那条是同一个 upstream commit。
4. **env 敏感性本身也是 pre-existing（§10 三层机械核）**：daemon-mode/agent-session-runtime/daemon-agent-roster 三个本轮改过的带红文件——红用例标题 BASE 存在（daemon-mode 4/4 + runtime 1/1 + recursion 11/11；roster 整文件本轮新增故 BASE 无）+ 16 条红用例体本轮逐字未动 ⇒ **本轮 merge/修复没有制造任何新的 env 敏感红；setupFiles 那条 fork-improvement 修的是既有脆弱性、不是本轮回归**。

**三覆盖缺口（形状不同修法不同、三类并列）**：

1. **E-1 调用口径层**（第二轴）：没有任何 sanctioned 命令真执行 `repl-kernel-parent-watchdog` 的 2 条 real-runtime 用例。**机制精度**：`test:ci` 命令（= `tsx src/core/kernel/bootstrap-cli.ts && vitest --run --exclude test/daemon-supervisor-process.test.ts`）**没有 tagsFilter 参数**，那 2 条是**被收集后报 skipped**（工件：ci1/ci2 该文件 per-file = `{passed: 6, skipped: 2}`，即 `6 passed` + `2 skipped`、两次跑 skip map 完全相同）；三重排除 = test:ci 下 config 默认 `tagsFilter: ["!kernel-heavy"]` 把 kernel-heavy 用例报 skipped + `test:kernel` 的 8 文件显式清单不含它 + 无任何其它 sanctioned 命令带该 tag。两条用例名：`runtime exits after its owner is SIGKILLed (stdin EOF watchdog)`、`runtime exits after owner death even while a non-yielding cell holds the loop`（:292 describeIf）。
2. **环境阻塞层**：跑了但 passed=0（daemon-supervisor-process 11 failed + 8 process-stress skipped：daemon 握手 1000ms 本机完不成、CI 单独 test:process job 能过）。
3. **执行掉出层**：pool kill 整文件缺席（STAGE1 5 文件 108 条、单文件重跑 108/108 全绿 = 纯掉出无藏红）。

**SKIP=62 分类记账**（「对账门报 SKIP 数」纪律）：**SKIP=62** = 34 凭证门（rpc 14 / agent-session-tree-navigation 10 / compaction-extensions 8 / compaction 2，门禁串 `skipIf(!API_KEY|!ANTHROPIC_API_KEY|!ANTHROPIC_OAUTH_TOKEN)`）+ 2 平台门（bash-close-hang-windows，win32）+ 24 kernel-heavy（对照面在 test:kernel、STAGE3 已执行：22 绿 + 2 pre-existing 真代码红）+ **2 条 = E-1 孤儿（watchdog，无对照面）**；ci1/ci2 的 **skip map** 完全相同 ⇒ 确定性 skip、非漂移；分类后 **0 条未归类**。

**分片口径偏离（残留）**：CI 矩阵对 coding-agent 是 `npm run test:ci -- --shard={1,2,3}/3`（`shard=1/3` 等三分片 + `test:process` + `test:kernel`），本轮 sanctioned 数据是**未分片整跑** ⇒ 内存/顺序压力更大，正是 5 文件掉出与 4 条 flip 的成因侧；归属结论不受影响（掉出 108 条 + flip 全部在隔离跑判绿），但「分片形态下这些产物是否出现」本地无工件。

**静态 list 工件 provenance 缺陷**：`03_vitest_list_static`（withdist，395 文件）vs ci1（403 文件）——**静态 list** 缺 **13** 个文件（含本轮新增的 `private-files-memo-ancestor.test.ts` 与全部带 tag/skip 的 kernel 文件）；ci1 缺 5 个（4 掉出 + daemon-supervisor-process 设计排除）；计数差只 **2 个文件各 +2**，都等于「run 报 skipped 而 **vitest list** 不枚举」的门禁用例（watchdog 2 条 kernel-heavy、compaction 2 条凭证门）⇒ W17.2 的 `collected − list = +N` 有了机械解释候选（**list provenance**：+70/+27/+39 未逐个重算、按 S9 第56条只记候选）。

**本地盲区（merge-back 诚实性重要）**：`daemon-client.ts` 的握手/重连面本轮被 merge 改过（waitForHello/connect/reconnect/disconnectForReconnect/resetTransportForReconnect，34 行），唯一本地覆盖簇 daemon-supervisor-process 两层 passed=0 全阻塞 ⇒ 该被改代码本机零测试信号、真覆盖只剩 CI test:process（ubuntu 能 1000ms 握手）。merge-back 后要 flag 给老板：daemon-client 握手面本轮被改但本地不可验证、依赖 CI。

**fork-improvement 候选（记台账、超 E 批 scope 不做）**：本仓测试对 runner env 零防护（`vitest.config.ts` 无 setupFiles、`test/suite/harness.ts` 不清 env）⇒ 任何人从 agent shell 跑都得 61+1 条假红。修法：加 setupFiles 统一 stub `RLM_DEPTH=0`（auto-refine 族）+ `GIT_CONFIG_GLOBAL=/dev/null`（git 族）。**产品侧不是 bug**（worker 里创建的会话真是 depth-1 子会话、header 记 rlmDepth:1 是正确行为，问题只在测试继承 runner 深度）；且按 §10 机械核本轮没造新 env 敏感红 ⇒ setupFiles 修的是**既有脆弱性**、不是本轮回归。**generalizable 判据**：凡断言里出现「人工设定某个由 env 派生的字段」都要问「这是 harness 设计还是 runner env 泄漏」——F12 钉子 `_rlmDepth = 0` = 泄漏防护（workaround 保留 + 注释改归因 rootRlmDepthFromEnv()/process.env.RLM_DEPTH、干净环境 no-op），auto-refine 族 61 红根因 = 泄漏没防护（干净环境转绿）。

**方法论（S9 第58/58b/59/60/61 条新增）**：

- **第58条（env 泄漏 + dogfooding 陷阱）**：归账任何测试红前先 `env|sort` × `grep process.env` 求交集、交集里每个变量都是能改被测行为的通道；dogfooding（审查/施工跑在产品自己里）时产品运行时变量污染产品测试、对 swap 天然免疫必须单独当轴控。
- **第58b条（二阶通道）**：env 不只被运行时读进逻辑直接影响（一阶）、还会**烤进落盘工件**被后续逻辑读（二阶）⇒ 干净环境重跑只救当次新建 fixture、既有落盘工件要隔离 HOME/agent dir。
- **第59条（git show/grep 0 命中先验路径）**：`git show <path>`=0 字符或 `grep -c`=0 先验证路径存在（`git ls-files|grep basename` 或 `git grep -l`）、0 字符 git show 是「路径错」不是「内容缺」（本轮 4600 曾因漏 suite/regressions/ 路径误读「用例基线不存在」、实际 BASE==HEAD byte 相同用例 pre-existing）。
- **第60条（三段式标签 + 五环境轴 canonical）**：基线 swap 只控代码轴、对 host/负载轴天然盲 ⇒「基线也红」只证「非本轮引入」不证「代码红」；完整定性一条红要三段式（代码轴 swap + host 轴 GIT_CONFIG 隔离 + 能力/负载轴按完整 stderr 区分）；环境轴按五轴 canonical 组织（①产物 ②调用口径 ③runner env ④host config ⑤本机服务凭据），台账/任务书/W 节编号一致防下轮引用打架。
- **第61条（两面、都本轮实测有工件）**：① **超时/握手类失败签名要读完整 `failureMessages` 尾部（尤其被测进程自己的 stderr）、不只首行**——4600 就是只读首行 `Timed out` 被误判成能力/负载缺口、完整 stderr 的 `listening`（0.114s）推翻之；反例对照：`daemon-supervisor-process` 的 11 条**读满**后无 listening 行、全是 `Timed out after 1000ms … daemon handshake` ⇒ 两种形状可区分（taxonomy 有牙）。② **跨 worktree 名集合差集前、先断言两层归一化文件键交集非空**——vitest json 报绝对路径，`/private/tmp/…`（macOS realpath）与 `/Users/…` 永不相交，同一条红会被报成「only-in-BASE + only-in-HEAD」两条层特有红、正好是 swap 判据的反面（pre-existing 误判成本轮引入 + 本轮修好各一条）；用 fullName/basename 做**路径归一化**键 + **断言键交集非空**（recheck-final 四次比较：roundtrip 1 / proc 1 / 两簇 2 / ci1×ci2 402 文件、无一次交集为 0）。
