# Prime Agent Fork 修复任务书 v3（2026-08-29，审查修订定稿版）

> v3 变更（审查轮：glm+qwen+grok 三模型挑错，父代理裁决 15/16 条采纳）：
> ① 全部锚点改为符号定位（内核合并后行号已漂，行号仅参考）；
> ② 补列 B9=F2（print/json 杀子代理，v2 漏列）；
> ③ A3 移出快赢（与本地 daemon-mode.ts 冲突）；
> ④ B1b 改为复用 initialRenderMessages 窗口化机制（不自造卸载轮子）；
> ⑤ B1d 撤销 pastedImages 子项（64MB 帽已存在 evictImagesToBudget）；
> ⑥ B1a/B1c 路径修正（packages/tui/src/components/ 下）；
> ⑦ B2 病在 supervisor→客户端第二跳（worker→supervisor 已是 compact delta）；
> ⑧ A5 摘取范围修正（state-snapshot 而非 kernel/index.ts；changelog 用 .changes fragment）；
> ⑨ B5 措辞修正（google 全文无重试实现）；⑩ B8 先重 grep matchesKey 再列清单。
> v3.2 终审修正：B1c 撤销（blockCache 每次 render 全量重建、自限于单消息，LRU 是负优化——mechanics 发现、父代理亲验 markdown.ts:254,270）；B1a 简化为「fallbackOnly 构造后即丢 base64Data」（全仓 Image 均 fallbackOnly，亲验 tool-execution.ts:435、earendil-announcement.ts:45）；A5 落点补 $EDITOR 临时文件/extension-editor/export-html/harness.py 四处；B7 保留（mechanics 称 upstream 已实现，父代理亲验驳回——merge 树里 isClientOwnedDaemonSession 仍是 2 参数老版，mechanics 误读了 exec-daemon 的 worktree）；A1 改「先 dry-run 再合」。
> 执行架构：7 个执行代理各占一个 git worktree（/Users/a1/Desktop/_wt_prime/exec-*，分支 wt/exec-*），并行开工，完工后父代理逐个并回 merge/repl-kernel 统一验收。

> 输入：`docs/fork/audit-findings.md`（F1–F28 + PR 裁决 + 内存根因 S1–S8）。
> 基线：`merge/repl-kernel` @ bf542ce7e（新内核 rlm.repl 已合并，check + 117 测试全绿）。
> 本文档是执行级工单：每项含机制、精确锚点、改法、冲突分析、验收标准。

## 0. 纪律与约束（每个工单通用）

1. 一次只做一项，完成即提交；提交前 `npm run check` 全绿 + 该工单的靶向测试通过。
2. 测试命令（包根目录）：`npx tsx ../../node_modules/vitest/dist/cli.js --run test/<file>`。禁止 `npm run dev/build/test`。
3. 新功能/修复带 `.changes/` fragment（纯内部改动可免）；回归测试放 `test/suite/regressions/` 或就近。
4. git 纪律：只 `git add` 本工单文件；禁 `git add -A`、`git reset --hard`、`git stash`、`git checkout .`、`--no-verify`。
5. 每个 PR 集成前先 `gh pr diff <N> -R PrimeIntellect-ai/prime-agent > /tmp/pr-<N>.diff` 审一遍再决定 cherry-pick 还是 `git apply`。
6. 涉及 daemon 协议面的改动：按仓规分类（兼容/capability 门/不兼容），bump `DAEMON_SCHEMA_REVISION`（当前 24）并更新双方向兼容测试。
7. 验证命令：`npm run check`；TUI 行为变更需 tmux 真机冒烟（AGENTS.md 方法）。

## 1. 阶段 A：官方 PR 集成（9 项，低风险→高风险）

### A1 ← #1882 bash 并发 AbortController（+97/-7，MERGEABLE）
- 病：并发 executeBash 共享单 AbortController，先完成者清掉别人的控制器；abortBash 只杀最新一个。
- 改动：Set 逐调用管理 + abort-all。文件：`agent-session.ts` + `agent-session-bash-persistence.test.ts`。
- 冲突：与本地 8 提交零重叠（mechanics 已核）。head=3563b21d8f。
- 集成：cherry-pick `3563b21d8f`（base 是 upstream main，我们已含其全部祖先，预期干净）。
- 验收：合入后 3 个新测试绿 + 现有 bash persistence 测试不回归。

### A2 ← #367 Anthropic Record schema（+183/-2，MERGEABLE）
- 病：Type.Record 的 catch-all 被本地 convertTools 静默清空（`schema.properties ?? {}`，anthropic.ts:1228-1240），非端点拒收。
- 改动：递归改写为 additionalProperties；只动唯一 catch-all 且无命名 properties 的节点。只碰 packages/ai。
- 集成：cherry-pick `b5e633de8f`。验收：anthropic-eager-tool-input-compat 测试通过。

### A3 ← #1700 远程消息重复投递（+111/-28，MERGEABLE）
- 病：sendRemoteAgentSessionMessage 连接重试导致重复投递。
- 改动：daemon-mode.ts 送达后单次 + 测试钉 requestCount==1。runtime 亲验过这个病真实存在。
- 集成：cherry-pick `29e994ac2e`。验收：daemon-mode.test.ts 相关用例。

### A4 ← #413 Ghostty 图片默认关（+32/-4，MERGEABLE）
- 病：Ghostty 内联图 escape 进 redraw 可冻会话。
- 改动：images 默认 null，`PI_ENABLE_GHOSTTY_IMAGES` 才开。与 #427 互斥（不拿 427）。
- 集成：cherry-pick `19773341ce`。验收：terminal-image.test.ts。

### A5 ← #1249 私有 session 文件权限（+1462/-313，24 文件，对官方 main 已 CONFLICTING）
- 病：F3 —— session jsonl/日志 0644、目录 0755。
- 改动：`appendPrivateFile`/`writePrivateFileAtomicLines` 强制 0o600（O_EXCL+O_NOFOLLOW），目录 0o700。
- 冲突分析：碰 `config.ts, agent-session.ts, auth-storage.ts, kernel/index.ts（已换血！）, state-snapshot.ts, refinement.ts` 等 24 文件。与我们 619144b6e（session-manager 增量扫描）和新内核（kernel/index.ts 已被 repl-manager 取代）双重冲突。
- 集成：**不 cherry-pick，手工摘**：只摘权限原语（appendPrivateFile 等）+ 落点（session-manager append、日志 sink、config 写入），kernel/state-snapshot 部分按新内核路径重做。
- 验收：PR 的 1105-session-storage-security 测试移植后通过（断言 0o600/0o700）；我们 session-manager 相关测试不回归。

### A6 ← #1251 no-session 子代不落盘（+258/-97，21 文件，MERGEABLE）
- 病：--no-session 的子代理仍 SessionManager.create 落盘（agent-session.ts:9390、daemon-mode.ts:2477）。
- 改动：子代继承 inMemory。注意它碰 daemon-protocol.ts（我们刚升 24，需手工解开）。
- 依赖：A5 之后。验收：child/grandchild 无 session 文件的断言测试。

### A7 ← #1253 宿主拆除取消 RLM 子代理（+195/-43，CONFLICTING）
- 病：宿主 teardown 时孤儿 RLM 子代理继续跑。
- 改动：把 AbortSignal 打进 rlm.run，teardown 时 cancel 已准入子。原 PR 改 kernel/index.ts——**需移植到 ReplKernelManager**（rlm.repl 的 interrupt/shutdown 语义不同，先读 repl-manager.ts 的 shutdown/interrupt 路径再动手）。
- 验收：PR 测试（dispose 后 run.status===cancelled）移植后通过。

### A8 ← #1519 Enter 恢复 parked queue（+201/-2，10 文件，MERGEABLE）
- 定位：F1 同族的用户侧出口（不治 F1 本体）。拿它的测试脚手架 agent-session-parked-queue.test.ts 给 B3 用。
- 集成：cherry-pick `04fe9b9ef6`。验收：5 个测试文件通过。

### A9 ← #887 滚轮 3→1 行（+5/-4，MERGEABLE）
- 纯 UX。碰 tui.ts 与我们 3c3716595（渲染复用）同文件不同区，预期干净。cherry-pick `8adcef12cf`。

### 阶段 A 执行分工（v3 并行化）
exec-queue：A1+B3；exec-memory：A8+B1b；exec-ai：A2+B4+B5；exec-daemon：A3+B7+D；exec-security：A5+A6；exec-tui：A4+A9+B1a+B1c+B1d+B6；exec-headless：B9。A3 与本地 daemon-mode.ts 预期冲突，单独解。

## 2. 阶段 B：自修 P0（用户痛点排序）

### B1 = F27 内存第一刀（快赢包，预计 1 天）
用户实测：TUI 38 小时 RSS 2.4GB（峰值 3.5GB），daemon 同期 204MB。根因三头：流式全量事件 RSS 棘轮、transcript 三份拷贝、图片 base64 常驻。

- [ ] **B1a 图片 base64 用后释放（分两档，runtime 审查简化）**：①fallbackOnly 的图（tool-execution.ts:430-441 全部是）构造/渲染后直接丢 base64Data——fallback 渲染只用 mimeType+dimensions（image.ts:87-90），零风险；②非 fallback 路径（仅 earendil-announcement 一处）保留或加源回调，可缓。pastedImages 64MB 帽已存在，不在本子项。
  验收：新测试——渲染 N 张图后组件持有的 base64 总字节 < 阈值；tmux 冒烟确认图片显示/回看正常。
- [ ] **B1b chatContainer 直播加帽**：直播 addMessageToChat 无上限（grep 定位）。改法（审查裁定）：超限（800 组件）时复用 initialRenderMessages 的同一套窗口化+tool 配对修复路径重建组件树，不自造卸载机制；回看走 agentConnection.getMessages() 重建旧段。耦合点（runtime 审查补）：全屏滚动区=mainViewContainer（pageUp 滚全量）、setHiddenThinkingLabel 与 applyChatExpansion 遍历全部 children、tool 配对必须复用 renderInitialMessages 的 toolCallMessages map；释放必须连组件子树（Image.cachedLines、tool 结果数据）否则 RSS 不降。验收含：展开切换/隐藏思考标签/全屏滚动位置一致。
  验收：模拟 10k 消息注入，TUI 进程 RSS 曲线平顶；回看旧消息功能正常（tmux 冒烟）。
- [x] ~~B1c blockCache LRU~~ **v3.2 撤销**：render() 每次 nextCache 全量替换（markdown.ts:254,270），自限于当前消息，非无界累积器。LRU 反而让长消息反复重渲。
- [ ] **B1d 编辑器加帽**：UndoStack 上限 500 步（packages/tui/src/undo-stack.ts）；KillRing 改真环形 60 项（kill-ring.ts）；修「会话重置走 setText("") 不清 undo 栈」。（pastedImages 子项撤销：64MB 帽已存在。）
  验收：各加帽单测。
- 总验收（B1 整包）：长跑模拟脚本（10k 消息 + 100 图）RSS 稳定在预算内（目标 < 800MB，当前同负载预期 > 1.5GB）。

### B2 = F27a 流式增量（大活，独立排期）
病在第二跳：worker→supervisor 已是 compact delta；supervisor→公开客户端每 token 重建全量 message JSON（daemon-supervisor.ts 里 grep 广播处），TUI 每 token 全量 parse + 全文 markdown re-lex。spike 方向：对有 streaming_deltas capability 的客户端跳过 reconstruct 直发增量。
- 改法（二选一，先做 spike 再定）：
  (i) 公开 JSONL 增 capability `streaming_deltas`：协商后直发增量 delta，TUI 侧累积；
  (ii) TUI 侧对 message_update 做增量 diff（对比上一版消息只重渲染变化块），不动协议。
- 协议纪律：走 capability 门 + schema revision 24→25 + 双向兼容测试。
- 验收：同负载下 TUI CPU 与 RSS 棘轮显著下降（给出前后对比数）；旧客户端协商不到 capability 时行为不变。

### B3 = F1 队列唤醒（小改，高价值）
机制（runtime 审查对当前树亲验）：合并后 upstream #1861 改了语义——`_assertSessionActionAdmissionAvailable` 泵悬置时直接抛错（直发路径响亮失败），排队路径仍是 wake=on_lower_boundary 不唤醒。修法按三态：①排队路径补唤醒（F1 本体）②直发路径保留悬置抛错 ③空队列报错语义不动。**先实测当前树两分支行为再动手；若 upstream 已顺手修好则只写防回归测试。**
- 改法：agent-message 入队路径在「泵悬置 且 队列非空」时补唤醒（对齐 TUI steer/follow_up/heartbeat 的 resumeIfIdle:true 做法）。注意保留空队列时的显式报错语义（:4815,:5517-5519）。
- 验收：回归测试——子代理 streaming → abort → agent_message 入队 → 断言泵唤醒、消息被消费、回合完成。放 `test/suite/regressions/`。另跑 A8 带进来的 parked-queue 测试确认不打架。

### B4 = F8 Codex 重试三修（packages/ai 单包）
锚点：openai-codex-responses.ts:90-94（status 白名单）、:217-264（重试循环）、:48（MAX_RETRIES=3）。
- (a) catch 门 B 加 status 检查：4xx（除 429）不重试（当前 401/400 也重试 4 次）；
- (b) 429 读 Retry-After（cap 在 maxRetryDelayMs）；
- (c) 尊重 options.maxRetries（当前硬编码 4 次）。
- 验收：本地 SSE 桩单测（学 #1115 的 writeHead(429)+retry-after 做法），断言 401 不重试、429 按 Retry-After 等待、maxRetries=0 时一次即失败。

### B5 = F9 重试接线
maxRetryDelayMs 当前全链路传递零消费者（types.ts:126-133 → simple-options.ts:18 死端）：接入重试消费者或删选项+改文档。Mistral（强制 retries none）/Google/Vertex（全文无重试实现）不新造重试引擎，文档明写「当前不重试 429」。

### B6 = F12 paste 兜底（stdin-buffer.ts:266-300）
pasteMode 无 201~ 时：加 30s 超时自动 flush 退出 + 缓冲字节上限 + Esc 强制退出。验收：单测喂 200~ 不喂 201~，断言超时后按键恢复正常。

### B7 = F14 ACP EOF 收口
main.ts:197/1545 + daemon-agent-connection.ts:1456-1456：ACP stdin EOF 默认走 complete_owned_session；保留显式 resident 开关（如 `--acp-resident`）给编辑器重连场景。daemon.md 补 ACP 进 client-owned 名单。注意与 #1236 方向相反，commit message 写明取舍。

### B9 = F2 print/json 等 RLM 子代理静默（v2 漏列，审查补）
病：print-mode.ts 的 waitForHeadlessCompletion() 不传 waitForRlmQuiescence → root 回合一结束即 complete_owned_session → 级联 abort 在途子代理。ACP 已显式传 true（acp-mode.ts:638，能力门 rlm_quiescence_barrier）。
改法：print/json 复用同一能力门，协商到 rlm_quiescence_barrier 时传 true。
验收：回归测试——print 模式 root 结束但子代理在途 → 不 complete 直到静默。

### B8 = F13 键绑定迁移（机械，面广）
先 `grep -rn matchesKey packages/` 重新盘点（部分点已半迁移如 editor.ts kb.matches），把确认硬编码的迁入 DEFAULT_EDITOR_KEYBINDINGS / DEFAULT_APP_KEYBINDINGS：tui.ts:935、editor.ts:850/854/885/967/1330、settings-list.ts:173、input.ts:86、config-selector.ts:400/404、scoped-models-selector.ts:314/324、extension-selector.ts:143/146/149、extension-input.ts:75。（select-list.ts 已全走 kb.matches 无硬编码，审查后移除；pageUp/pageDown 登记无人消费是功能缺失，另立小项。）
验收：新增「配置覆盖生效」测试；现有 keybinding 测试不回归。

## 3. 阶段 C：P1（次轮，按序）
C1 F4 Windows 管道 ACL（**需 Windows 实机**，先标注未验证）；C2 F5 supervisor 侧 capability 校验；C3 F6 shutdown 控制面鉴权；C4 F15 事件序号+缺口检测；C5 F16/F17 重映射孤儿兜底+驱逐时序；C6 F10/F11 edit 原子写+exec 进程组击杀与输出截断；C7 F22–F25 测试网（429 回归、bash abort OS 级断言、风暴回归、Windows 假绿清理）。

## 4. 阶段 D：文档漂移（顺手做）
F18 daemon.md v4→v7 与 v1-retained 过时说法；F19 settings.md xhigh→medium；F20 Node 版本 install.sh 与 development.md 取齐；F21 usage.md 补 acp + `--mode text` 死参数（修码或修文档取一）。

## 5. 明确不做
#795（DRAFT，熔断器方向不对，且把 SDK maxRetries 默认 0 会放大我们子代理密集场景的 429 抖动）；#1236（与 B7 反向）；#506/#480/#522（架构重写太险）；#1885/#1166/#1168/#1170（DRAFT 新子系统）；F27 的 S6–S8（MB 级，先吃 GB 级三大头）。

## 6. 风险登记
- R1 A5/A6 × 619144b6e（增量扫描）：手工调和后必跑 session-manager 全套测试。
- R2 A7 移植到新内核：ReplKernelManager 的 cancel/shutdown 语义不同，先读 repl-manager.ts 再动手；移植后跑 recursion 全套。
- R3 B1b 窗口化是 TUI 行为变更：tmux 真机冒烟 + 用户确认回看体验无损。
- R4 B2 动公开协议：capability 门 + 双向兼容测试，缺一门不提交。
- R5 阶段 A 逐项叠加冲突：一次一个，合完即提交即测。
- R6 新内核刚落地：任何 kernel 相关工单（A7）先在 merge/repl-kernel 上跑 kernel 全量测试做基线。
