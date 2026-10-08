# 显示审计修复计划 — 待办批次（2026-10-08）

> 交接文档：供其他窗口的 agent 直接领取批次开工。
> 依据：`docs/audits/2026-10-06-display-audit.md`（六轮审查，全部条目带 文件:行号 + 根因 + 修法）。
> 已完成：四批共约 75 条（High 10/10 全清），提交 `68ed41031` → `e5532068d` → `f4e701186` → `52dd02da8` → `c6c7fb17c`，CI 全绿，本地已 build 生效。

---

## 开工前必读（所有窗口通用）

1. **先读审计文档**：每条 bug 的 位置/触发条件/修法 都在 `docs/audits/2026-10-06-display-audit.md`，按条目 ID 检索。本文只做分组排序，细节以审计文档为准。
2. **仓规**：`AGENTS.md`（fork 覆盖节优先）。提交一律 `git commit -F <文件>`；只 add 自己改的文件；每批 push 前更新 `FORK_NOTES.md`；changelog fragment 放 `packages/<pkg>/.changes/<slug>.md`。
3. **改完必跑**：`npm run check`（全绿）+ 触及的测试文件（`env -u RLM_DEPTH -u RLM_SESSION_DIR npx tsx ../../node_modules/vitest/dist/cli.js --run test/<file>`，从包根跑）。新测试必须「修了就红」。
4. **测试对账表**：审计文档第四轮有一张「把 bug 钉成特性的测试」清单（tl-in-timeline / agents-view-mode / markdown-latex 等）——修复时这些测试要同步改，否则 CI 红。
5. **并行纪律**：多窗口共用 worktree 时，提交前 `git diff --cached --name-only` 核对只含自己的文件；commit 是文件粒度不是 hunk 粒度。
6. **生效提醒**：修复提交后需 `npm run build && prime-agent shutdown` 才对本地命令生效；push 后盯 CI（`gh run watch`）。

---

## 批次 A：HTML 导出（8 条，性价比最高，用户直接可见）

涉及文件集中在 `packages/coding-agent/src/core/export-html/`（template.js / template.css），互相独立，适合一个窗口一批发。

| 条目 | 问题 | 修法建议 |
|---|---|---|
| R2-M1 | bash 输出 ANSI 不剥离，导出后 `[31m` 乱码可见 | 渲染工具输出前 strip ANSI，或接 ansiToHtml 转带色 span |
| R2-M2 | 工具结果图片只在 read 工具渲染，MCP 截图工具导出丢图 | default/renderedTools 分支都调 `renderResultImages()` |
| R2-M3 | `findToolResult` 搜全部 entries 不限当前 path，fork 分支显示错结果 | navigateTo 时建当前 path 的 toolCallId→result 映射 |
| R5-M9 | Escape 三重损坏（搜索树不重建 / 静默跳回初始分支 / 滚底死代码） | Escape 只做清搜索+`forceTreeRerender()`；用 `currentLeafId` 不用模块级 `leafId`；滚底改 `window.scrollTo` |
| R5-M10 | T/O 展开开关状态分支切换后丢失且反相 | 状态写容器 class（`#messages.no-thinking`），CSS 控制显隐 |
| R5-M11 | 折叠输出初次渲染挂全量 DOM + 双份 hljs，10 万行打开即冻结 | 惰性构建：首次展开才生成 DOM/高亮 |
| R5-M12 | 移动端点树节点后全宽侧栏不收起，导航结果不可见 | 树节点 click 里 `if (isMobileLayout()) closeSidebar()` |
| R5-M13 | 长 URL 不换行，整页横向滚动 | `.markdown-content { overflow-wrap: anywhere }` |

验证方式：合成会话 → `exportFromFile` → linkedom 或 headless Chromium 实跑（第二轮蜂群有现成方法，见审计文档 R2 段）。

## 批次 B：时间线/块渲染细节（6 条，日常高频）

涉及 `turn-box.ts`、`block-focus.ts`、`live-turn-flow.ts`、`conversation-components.ts`、`timeline-rows.ts`。

| 条目 | 问题 | 修法建议 |
|---|---|---|
| R3-M15 | 块导航提示落框顶空行、首行 `N 步 ▸` 消失 | `isVisibleRow` 先过 `withoutGutter` 再判空（两处同口径） |
| R3-M17 | 心跳提示词被 userMessage reset lane、误标 startedByUser | 心跳判定提到 `turnFlow.userMessage` 之前 |
| R3-M18 | 另一视图按 Esc 后，live/replay 分组分裂 | runCutMidTask 排除 owner-stop stub 情形 |
| R3-M19 | 块复制（Y 键）全 trim + 丢空行，代码缩进全灭 | 这些卡片持有源文，改复制源文（参照 assistant-message 做法） |
| R5-M17 | steer 插话不可展开，长插话全文不可达 | 参照 fail 事件的 row 通道挂 fullText/detail |
| R5-M19 | replay 给有真实结果的中断工具盖编造「已中断」 | aborted 分支建 fabricatedTools 侧表，toolResult 先查 pending 再查它 |

注意：R3-M17/M18 与已修的 settle 账本（`timeline-lane.ts` 的 settle/takeSettles）有交互，改前先读 `agent-message.ts` 的 comeBack 当前实现。

## 批次 C：清洗残余（约 10 条，第四批 Text 中央门的补充）

> 第四批已在 `Text.render` 层做了中央门（`sanitizeRenderText`，tui/src/utils.ts）。走 Text 的路径已全覆盖。
> 剩下的是**不走 Text** 的渲染路径。逐点过 `sanitizeDisplayText` 或改走 Text。优先级低于 A/B——大多数注入向量已被中央门挡住。

| 条目 | 位置 | 问题 |
|---|---|---|
| R4-M1 | turn-box.ts 框头/meta | 直接插值裸文本（行体 stepWords 洗了，框头没洗） |
| R4-M2 | agent-message.ts 4 处 | 子代理报告渲染面全裸 |
| R4-M3 | system-notice.ts:113 | TimelineNoticeRow 展开 detail 直通 |
| R4-M4 | agents-view-state.ts | 行标题/状态/回答预览全裸 |
| R4-M5 | tree-selector.ts | /tree 整组件无清洗（7 个文本源） |
| R4-M6 | bash.ts 调用头 | `$ <命令>` 不剥控制字符 |
| R4-M7 | ipython-cell.ts | 顶行 label/errorName/代码行全裸 |
| R4-M14 | daemon-session-summarizer.ts | recap 不剥控制字符且持久化（重启复发） |
| R5-M30 | subagent-summary-line.ts | stall marker `name: text` 微格式解析错乱 |
| R5-M31 | subagent-summary-line.ts | chip 名含 `\n` 击穿单行契约 |

## 批次 D：假功能批（5 条，需要动文档+协议，建议单独窗口）

| 条目 | 问题 | 建议 |
|---|---|---|
| R3-M5 | `ctx.ui.setStatus()` footer 从不显示 | 恢复 footer 渲染 extension statuses（git 实证 `813b847b4` 删的），或删 API+改 docs/extensions.md |
| R3-M6 | `ctx.ui.custom()` daemon 模式静默 undefined | 短期文档注明限制；中期 daemon 协议加能力面 |
| R6-M5 | 扩展命令重名静默改名，诊断端口恒空 | `resolveRegisteredCommands` 在重名时 push 一条 diagnostic |
| R6-M6 | 扩展 renderCall/renderResult/registerMessageRenderer 在 daemon 下全灭 | 短期 docs/extensions.md 两大节注明「daemon 会话不生效」；长期按 R6-M6 协议方案 |
| R6-M3 | `daemon attach/open` 整面死代码但文档还宣传 | 恢复或删除，同步 usage.md / CHANGELOG / streaming-resend-design.md |

## 批次 E：providers 错误信息（4 条，packages/ai）

| 条目 | 问题 | 修法建议 |
|---|---|---|
| R3-M25 | anthropic.ts SSE 解析失败塞 50KB 原始帧进 errorMessage | 正文只放 `truncateRawPayload(sse.data)`，完整帧留 info.raw |
| R3-M26 | Codex 限额 friendlyMessage 被分类层丢弃、resets_at 没变 retryAfterMs | CodexApiError 构造时写 `retryAfterMs`；detail 用 friendlyMessage |
| R3-M27 | OAuth 错误带完整 stack + 无界响应体上屏 | formatErrorDetails 去 stack；响应体 redact + 定长截断 |
| R3-M28 | openai-completions 不读 `delta.refusal`，拒答误诊空响应白烧 5 分钟重试 | 识别 refusal 通道，`stopReasonRaw="refusal"` 收尾 |

## 批次 F：/update 链（3 条）

| 条目 | 问题 | 修法建议 |
|---|---|---|
| R6-M9 | fork 拒绝文案只在 alt screen 一闪而过 | handleUpdateCommand 先跑 `detectForkInstall()`，命中用 showError 会话内显示 |
| R6-M10 | `/update --help` 真重启 daemon 打断全部会话 | help 输出用独特退出码，父进程不能把 exit 0 等价「已安装」 |
| R6-M11 | manifest sha256 钉在 tarballs[]，读取方只认顶层 → 自更新永不激活 | `readManifestArtifactSha256` 按 basename 回查 tarballs[]；误诊文案同步 |

## 批次 G：settings/config 交互（5 条）

| 条目 | 问题 | 修法建议 |
|---|---|---|
| R4-M18 | settings.json 手改后通知零消费方 | 交互模式 reload 完成后 drain + showWarning |
| R4-M19 | 非字符串设置值（theme:42）崩 /settings 面板 | 四个 getter 加 typeof 守卫（对齐同文件既有模式） |
| R4-M20 | 项目层钉住的键切换被静默吞 | 面板项显示 scope 来源或提示「项目 settings.json 固定」 |
| R5-M27 | config 界面按空格误切换资源并写盘 | 参照 settings-list.ts:182-187 的搜索态门 |
| R6-M14 | config 写盘失败全程静默 | toggle 后查 persistenceFailure 并渲染错误行 |

## 批次 H：RPC/ACP 无头消费方（5 条，只有协议接入方碰到，最后做）

R5-M22（连接级事件全丢）、R5-M23（stall 报正常）、R5-M24（压缩失败假象）、R5-M25（`-p` 尾部通知致空输出 exit 0）、R5-M26（ipython 图片不可达+注释撒谎）。修法全在审计文档 R5 段，逐条有 wire 形状建议。

## 批次 I：终端底层 + 零散（按需）

- R5-M5 崩溃后 tty 零恢复（exit guard 只保鼠标）→ 加恢复 guard + probe-bus 修 kitty 复利
- R5-M6 全屏下 grapheme 2027 永不启用 → leaveAltScreen 补发 mode-set
- R3-M9 cron nextRunAt 三个界面三种时区 → 统一本地时区格式化
- R3-M10 kernelRestarted/kernelReset 显示字段死了 → readDetails 读这两个字段加提示行
- R3-M13/M14 编辑器深水区（paste marker 折行光标瞬移 / Ctrl+] 跳进原子标记）→ 递归传中间 VL；落点过 snapCursorOffset
- R5-M7/M8、R6-M8 Python 内核对齐（名字改写/id 撞号/幽灵台账）→ ok 记录带专用 `name` 字段；id 混启动 nonce
- R5-M20 lastAssistantTextPreview 改名无兼容读 → 加旧字段回退
- R5-M21 replay 缺字段零容错（一条坏行崩整个会话）→ 单条容错边界 + 写入侧校验

---

## 批次间依赖与并行建议

- **A（导出）/ E（providers）/ F（update）/ G（settings）互相独立**，四个窗口可并行。
- **B（时间线）与 C（清洗残余）都碰 turn-box/agent-message**，建议同一窗口串行做或先 B 后 C。
- **D（假功能）改文档+协议**，独立窗口，注意 daemon 协议改动按 AGENTS.md「协议改动」节登记 capability/revision。
- 每批完成后：集群审查（12 路规模）→ 修审查发现 → 推送 → 盯 CI → 更新 FORK_NOTES。参考前四批的节奏。

## 验收标准（每批通用）

1. `npm run check` EXIT 0
2. 触及测试全绿，新增回归测试「修了就红」
3. pristine tree 复验（`git archive HEAD | tar -x -C <tmp> && tsgo --noEmit`）
4. push 后 CI 11/11 绿（盯 `gh run watch <id>`；偶发 apt/计时 flake 重跑即绿，参考 run 37647168899 / 37730210501 的先例）
5. FORK_NOTES.md 新增一节 + `.changes/` fragment

## 陷阱清单（前四批踩过的坑，别再踩）

- 修 `--help` 类输出流之前先读 `test/stdout-cleanliness.test.ts`——显式机器模式 stdout 必须保持空。
- 修 agents-view 列宽/货币前先跑 `test/agents-view-columns.test.ts`——它钉着旧形态。
- 上游 CI 测试分片与本地不完全重合：推送前把触及文件按 `ci.yml` 矩阵查一遍落点（第二轮审查 agent-88 的方法）。
- 计时型测试（5ms 节流窗等）在重载 CI 上会 flake：本地三连跑全绿 + 重跑即绿 = flake，不是回归。
- latex 环境参数顺序有讲究：tabularx 是 `{width}[pos]{cols}`，其他是 `[pos]{cols}`。
