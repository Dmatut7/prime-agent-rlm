# 2026-10-09 迭代复审蜂群账本（五天 108 提交全量复审，三波定稿）

> 范围：`09eae8d55..HEAD`（10 月 3 日晚 → 10 月 8 日 wave 6 收口，108 提交、543 文件、+42818/−9961）。
> 基准：HEAD = `3b57591a4`。审查当日实跑 `npm run check` EXIT 0（含 pre-push secret-scan 自测 44/44），第六波「门禁全绿」说法属实。
> 蜂群：三波 26 车道共 46 代理（~3.4M token）：第一波 14 车道审主体 → 查漏员指出盲区 → 第二波 8 车道补盲（Python 内核 / refine 簇 / wire 兼容 / harness-digest / 扩展+settings / CLI 面 / probe-bus / 图片路由+删除+导出）→ 第三波 4 车道收尾（rlm-child 宿主簇 / compaction 簇 / self-recovery+边角 / CI 工作流）。每条必修/应修发现各配一个对抗复核代理证伪；三波终评「闭环」，543 个改动文件逐一对账完毕。
> 口径：本档只记蜂群产出，不混入已知欠账（docs/audits/2026-10-06-display-audit.md、docs/audits/2026-10-08-fix-backlog.md）。第七波（协议簇 + Low 清欠，W7-HANDOFF-20261009.md）在独立 lane 分支进行中，不在本档范围。

## 总账

- 确认问题：**17 条**（must 0 / should 17）——每条均经对抗复核确认，三波合计证伪 0、待定 0。
- 低优先未复核：62 条（low 36 / note 26）——未派复核代理，低置信入档。
- 销账（主动查过没问题）：**436 条**，按波次/车道附于文末。
- 诚实性结论：几波修复的绝大多数声称属实（436 条销账佐证），但发现 **3 条「账面说修了、实际没修或修了一半」**：state-snapshot.ts:49（任务单新问题 6，未修）、agent-session.ts:3535（任务单第 3 条后半，goal 仍判死）、turn-timeline.ts:497（R5-M7，界面层没读 name 字段）。

## 一、第一波确认问题（12 条，逐条带复核确认依据）

### 1.1. restoreQuotaPark due-past branch drops a navigation-cancelled overdue park silently

- **级别**：should（车道 `session-core`）
- **位置**：`packages/coding-agent/src/core/quota-park.ts:785`
- **现状**：FORK_NOTES/commit f26a2ddaf 声称「restoreQuotaPark 区分接管与用户取消——park 跨重启延续」；实现里只有 future-scheduled 分支（restoreQuotaWakeJob）会查 _navigationCancelledWakeJobs 重建导航取消的唤醒，due-past 分支只看 cancelledBy 是否为 QUOTA_WAKE_TIMER_CANCEL_ORIGIN。
- **后果**：会话在分支 A 上 quota 停靠且唤醒时间已过（机器睡眠/挂起），用户切到分支 B（reloadQuotaParkFromBranch 对 previous.jobId 调 resolveQuotaResumeJob 无 cancelOrigin → store.cancel 不盖戳，加入 _navigationCancelledWakeJobs），再切回分支 A：restoreQuotaPark 走 due-past 分支，job.status === "cancelled" 且 cancelledBy !== QUOTA_WAKE_TIMER_CANCEL_ORIGIN → 直接 return。park 被静默丢弃：不落 wake-lost 记录（那是 jobId 消失才走的分支）、不重建唤醒、任务永不再恢复——比 wake-lost 还安静。重启后（_navigationCancelledWakeJobs 为内存态，新进程为空）同样命中该分支。
- **证据**：通读 quota-park.ts 全文：reloadQuotaParkFromBranch:719-725（无 cancelOrigin 的 store.cancel，cancelledBy 留空）、restoreQuotaWakeJob:686-705（查 _navigationCancelledWakeJobs）、restoreQuotaPark:749-805（due-past 分支仅判 cancelledBy，两个 return 均无记录写入）。对照 cron-jobs.ts:841-851 确认无 origin 的 cancel 不写 cancelledBy。
- **修法**：due-past 分支在判 cancelledBy 之前先查 host._navigationCancelledWakeJobs.has(jobId)，命中则与 future 分支同口径重建唤醒/恢复 park；或导航取消也盖一个可识别 origin（如 quota_wake_navigation），使重启后仍可区分。
- **复核确认**：核实全部成立，且比 finding 描述的更容易触达（不需要机器睡眠）。

(1) 代码确如 finding 所述。reloadQuotaParkFromBranch（quota-park.ts:712-727）对 previous.jobId 调 resolveQuotaResumeJob 无 cancelOrigin → 落到 store.cancel(jobId, undefined, undefined)（quota-park.ts:466-478），cron-jobs.ts:841-857 确认无 origin 的 cancel 不写 cancelledBy（851 行只在 options.origin 存在时才写）。返回 "cancelled" 后 jobId 加入 _navigationCancelledWakeJobs（723 行）。restoreQuotaWakeJob（686-705 行）确实只在 future-scheduled 分支查 _navigationCancelledWakeJobs 并重建唤醒（701-702 行）；due-past 分支（749-805 行）在 785 行只判 `job.status === "cancelled" && job.cancelledBy !== QUOTA_WAKE_TIMER_CANCEL_ORIGIN`，命中即 786 行裸 return——不查 _navigationCancelledWakeJobs、不落任何记录。wake-lost 记录只在 jobId 缺失或 job 查不到时走（758-780 行），此场景 job 存在，故比 wake-lost 更安静，与 failure 描述一致。

(2) 失败路径真实可达且比 finding 的睡眠场景更平常：navigateTree（agent-session.ts:17835，18084 调 _reloadQuotaParkFromBranch）无任何 park 守卫，parked 会话 turn 已干净结束、agent 空闲，waitForIdle 直接通过。可达序列：分支 A 在 T 时刻停靠（future 唤醒）→ 用户切到分支 B（job 被 cancel 无戳、入 in-memory 集合）→ 在 B 上停留超过 T → 切回 A：restoreQuotaPark 读到 resumeAtMs <= now 走 due-past 分支，job.status === "cancelled" 且 cancelledBy 为空 → 静默 return，任务永不再恢复、零记录。同一进程内 _navigationCancelledWakeJobs.has(jobId) 为 true 但 due-past 分支根本不看它——这正是与 future 分支的口径矛盾（同一颗导航取消的 job，赶在 T 前回来会重建、T 后回来被当用户取消丢弃）。重启后同样命中（in-memory 集合为空，future 分支也判 user-cancelled）。restoreQuotaWakeJob 的 docstring（683-684 行）声称「重启后接管是 cancelled job 出现在 overdue entry 下的唯一方式」，该断言被导航路径证伪——这是设计假设漏洞而非有意行为。现有测试只钉了两个半边：agent-session-retry-events.test.ts:1515-1532「user cancel 经导航+重启保持取消」（用户取消，非导航取消）、:1534-1554「moves the park with branch navigation」用 maxPauseMs:2_000 即时往返（future 分支重建）；due-past + 导航取消组合无测试。quota-park-wave40.test.ts:333 只覆盖 due-past + 用户取消。

(3) 09eae8d55..HEAD 范围内触及 quota-park.ts/cron-jobs.ts 的只有 f26a2ddaf 本身及无关切分提交，无别处补救。_navigationCancelledWakeJobs 在全仓只有 3 个使用点（接口声明、701 查询、723 添加），无清理无其他消费者。

(4) 非已知欠账：docs/audits/2026-10-06-display-audit.md 只列显示侧 quota 问题（R2-M9 chip 宽度、R2-M11 补发字段、R5-M22 RPC/ACP 事件丢弃），2026-10-08-fix-backlog.md 无 quota 相关条目；FORK_NOTES.md:98 确实声称「restoreQuotaPark 区分接管与用户取消——park 跨重启延续」，该声明与此缺陷直接冲突。

severity 维持 should：触发需要 quota 停靠 + 分支往返 + 唤醒超期三个条件叠加，无状态损坏，但对无人值守多日运行的用户，停靠任务静默死亡且无任何记录（连 wake-lost 都不如），不宜降级。

### 1.2. Emphasis-mask seal check scans the whole paragraph every frame (O(n) regression of the P1 incrementalization)

- **级别**：should（车道 `markdown-gate`）
- **位置**：`packages/tui/src/components/markdown.ts:959`
- **现状**：FORK_NOTES 2026-10-05 P1（495e6e2a3）声称「四处校验扫描增量化」、md 车道声称「流式保持 O(tail)/帧」；但必修 2（8cb21dcf9）把原本增量的 backtickParity（XOR 折叠进 seal/split 状态，每帧只扫 tail，git show 8cb21dcf9 可见删除痕迹）替换为 hasUnmaskedBacktick：每帧对整段 slice(split.paraFrom) 做一次字符串拷贝 + anyPunctuation/blockSkip 两个全局正则 replace（各分配一个段落大小的中间字符串）。只要段落含反引号（行内代码是常见形态），无论反引号是否已配对都要全量扫描；已配对（掩码吸收）时该扫描是纯新增开销，无任何 O(tail) 路径消化它。
- **后果**：流式输出一个 ≥4096 字符（MIN_SPLIT_LEX_BLOCK_CHARS）且含行内代码（如 `code`）的生长段落时，每帧都对全段落做两次复杂 Unicode 属性类正则扫描 + 三次全段长度字符串分配；100k 段落量级下按仓自测口径（wave-52 记录 100k 单帧 p95 ~1ms 为达标线）足以把帧预算推回 P1 修之前的量级，恰是 P1 要消灭的「校验扫描 O(n)/帧」形态在含反引号语料上回归。
- **证据**：读 markdown.ts:959/1513 调用形态与 emphasisMask 实现（两个 .replace 全量重扫）；git show 8cb21dcf9 确认删掉的是按 parityFrom 增量的 backtickParity；git log 确认 495e6e2a3(P1) 早于 8cb21dcf9；FORK_NOTES 122/97/5 行的声称文本与代码现实比对。
- **修法**：把掩码结果增量缓存：掩码对追加文本是单调的（新文本只会把更多反引号 run 吸收进 blockSkip span，不会反向解开）——verified 前缀无未掩反引号且本帧新增 tail 不含反引号/链接开合字符时跳过全量重扫；或只在 tail 含 ` 时才对全段掩码一次并把结果按 cutRel 缓存到下帧 cut 推进。
- **复核确认**：证据链全部坐实。(1) 代码与 finding 假设一致：markdown.ts:475-493 的 emphasisMask 是两个全段正则 replace（anyPunctuation/blockSkip，各分配一次全段长度字符串），hasUnmaskedBacktick 唯一快出是 text.includes("`")——无任何增量/缓存路径；markdown.ts:959 每帧无条件 slice(split.paraFrom)（又一次全段拷贝）+ 全段掩码，只要段落含反引号（含已配对的行内代码）就全额付费；1513 在 split-lex 未 engage 时再跑一遍。(2) git 证实替换史：495e6e2a3（P1，10-04）把 backtickParity 增量化为 split.parity ^ backtickParity(text, cut)（尾扫、去拷贝，提交说明明写 "dropping the whole-slice copy"）；8cb21dcf9（10-05）为修正确性 bug（字符奇偶不等于 run 配对，密封粗体脱配）删光 parity 状态、换成全段掩码检查——diff 可见 parity?: number / split.parity ^= / seal.parity ^= 全部删除。FORK_NOTES.md:122 的 wave-51 P1「四处校验扫描增量化」声称对反引号这一处已不再成立。(3) 可达：assistant-message.ts:391-417 流式期间对同一 Markdown 实例逐帧 setText（仅变化块=生长的尾块）→ markdown.ts:1307 render→lex→trySplitLex:959；splitLex 仅对 ≥4096 字符段落引导（markdown.ts:439/1074），默认开启。(4) 未在他处处理：8cb21dcf9..HEAD 触及 markdown.ts 的三个提交均未碰该守卫，全仓无 emphasisMask 缓存；两份审计文档的 R3-M1..M4/R6-M2/M4/R2-M11 全是 daemon/扩展面的账，无掩码性能欠账记录，FORK_NOTES 2026-10-05 必修 2 只记正确性升级不记性能代价。(5) 量级实测（独立 node 微基准，非仓测试）：100k 含行内代码段落 hasUnmaskedBacktick ≈ 0.43ms/帧，对比被删的增量奇偶 ≈ 0.0006ms——单守卫就吃掉仓自定 100k 单帧 p95 ~1ms 达标线的 ~43%，方向上确会把帧预算推回 P1 修前量级。severity 维持 should：真实可达的性能回归且推翻已发布的 P1 特性，但仅在 ≥4096 字符含反引号段落触发（常见 8-16k 段落每帧仅 ~0.03-0.07ms，可忽略；重灾区是仓基准追踪的 100k 单段形态），且引入它的是必要的正确性修复（fuzz 实证 5/40 命中），非无人知晓的随手回归；掩码对追加文本单调，finding 给的增量缓存修法可行。注意一处措辞溢出：FORK_NOTES:5 的「流式保持 O(tail)/帧」是 sanitize 车道的声称（属实，不受影响），真正被证伪的是 line 122 的「四处校验扫描增量化」——不影响裁定。

### 1.3. Forced-bulk short sequences with embedded newlines are inserted as raw \n inside one editor line

- **级别**：should（车道 `input-editor`）
- **位置**：`packages/tui/src/components/editor.ts:912`
- **现状**：commit 8ca369593 声称「Bulk paste no longer turns a CR into a spurious Enter」，R5-M3 修复把 CR 折叠成 LF 并给 pushTextRun 加了 forceBulk 传播：bulk run 被 \t 等控制字节切出的短文本段、或 CR 折叠后缩到 32 以下的 run，会被整体作为一个 <32 字符的序列发出。但 Editor 的 bulk 分支阈值是 `data.length >= BULK_TEXT_MIN_RUN`（editor.ts:912），一个 22 字符、内含 11 个 \n 的序列不算 bulk，落到键位匹配失败后的兜底分支（editor.ts:1146 `data.charCodeAt(0) >= 32 → insertCharacter(data)`），把整段含 \n 的字符串原样插进 state.lines 的同一行里。
- **后果**：无 bracketed paste 的终端（或管道）里粘贴带缩进的代码：如 "def f():\n\treturn 1\n\tx=1…" 整体 ≥32 字符触发 bulkRun，但每个 \t 之间的文本段（如 "def f():\n"，9 字符）被 forceBulk 成单序列发出 → 编辑器把 \n 当普通字符插进一行：多行粘贴被压成一行显示（可见宽度计算、光标移动、折行全部错乱），光标/退格行为随之损坏。w6 测试自己的用例 "a\r\n".repeat(11)（折叠后 22 字符）正是这个形状：StdinBuffer 层钉住了输出，但 Editor 层没有任何测试覆盖 <32 的 forced-bulk 序列。
- **证据**：静态核对：stdin-buffer.ts:229-246 pushTextRun 的 forceBulk 分支与 392-405 控制字节切分调用点；editor.ts:909-915 bulk 阈值、1053-1060 newLine 条件（首字符须为 \n 才算）、1140-1148 兜底插入；keys.ts parseKey 对多字符非转义串返回 undefined（无键位命中）；w6-stdin-input-lane.test.ts:77-82 的用例本身产出 22 字符多 \n 序列。修复前（无 forceBulk）短段逐字符下发，\n 是独立序列走 newLine 分支，行为正确。
- **修法**：Editor 的 bulk 判定改为「来自 bulk 的形状」而非纯长度：`data.length >= BULK_TEXT_MIN_RUN || data.includes("\n")` 走 insertBulkText（其 normalizeText+split 分行已正确）；或 StdinBuffer 对含 \n 且 <32 的 forced-bulk 段保持逐字符下发。补一条 Editor 层测试：handleInput("a\n".repeat(11)) 后 state.lines 应为 11 行。
- **复核确认**：追到完整可达失败路径，且用 HEAD 源码（tsx 现场跑 StdinBuffer + Editor）复现成功。

(1) 代码与 finding 假设完全一致：
- stdin-buffer.ts:229-246 pushTextRun 的 forceBulk 参数直接跳过长度检查；stdin-buffer.ts:384 `bulkRun = run.length >= BULK_TEXT_MIN_RUN` 在 CR 折叠（385-387）之前计算，之后 391-405 的控制字节切分把每个 <32 的文本段都以 forceBulk=true 下发。两种产生短含 \n 序列的路径都真实存在：a) \t 等控制字节（code < 32 且非 10）切分 ≥32 的 run；b) CR 折叠把 run 缩到 32 以下。
- 实测 `process("a\r\n".repeat(11))` 产出单个 22 字符序列 `"a\n".repeat(11)`（w6-stdin-input-lane.test.ts:72-73 钉死的就是这个形状）；实测 `process("def f():\n\treturn 1\n\tx=1\n\ty=2\n\tz=3")`（33 字符）产出 `["def f():\n","\t","return 1\n","\t","x=1\n","\t","y=2\n","\t","z=3"]`。
- editor.ts:912 bulk 分支只看 `data.length >= BULK_TEXT_MIN_RUN`（32），22/9 字符的序列不进 insertBulkText；1053-1060 newLine 条件要求首字符是 \n（pushTextRun:236-240 保证 bulk 序列永不以 \n 开头，所以永远不命中）；keys.ts:1434 decodePrintableKey 只解 CSI-u 形状，多字符纯文本返回 undefined；最终落到 editor.ts:1146-1148 `data.charCodeAt(0) >= 32 → insertCharacter(data)`，insertCharacter（editor.ts:1411-1417）把整段字符串原样拼进 `state.lines[cursorLine]`。
- 实测 Editor 收到 22 字符序列后 `state.lines === ["a\na\na\na\na\na\na\na\na\na\na\n"]`：11 行被压成 1 行、行内嵌 11 个字面 \n。渲染（visibleWidth/折行）、光标移动、退格全部基于「行内无 \n」的契约，随之损坏；\t 场景里独立 "\t" 序列还会走 handleTabCompletion 被当作 Tab 键吃掉缩进。

(2) 真实运行可达：terminal.ts:304 无条件开 bracketed paste，但不支持该模式的终端（正是 stdin-buffer.ts:379-383、editor.ts:909-911 注释明说的目标场景）粘贴不带标记，整体 ≥32 触发 bulk 路径。链路 StdinBuffer → terminal.ts:340 → tui.ts:1301/1362 handleInput → editor.handleInput 全程透传，多字符纯文本串不命中任何 keybinding（keys.ts matchesKey 各分支均为精确串或 CSI 形状匹配），tui.ts:1305-1320 的 inputListeners 也是 keybinding 匹配，不会拦截。

(3) 09eae8d55..HEAD 未在别处处理：之后只有 9c22d73ce 碰过这几个文件（全屏选择/overlay 合成），diff 中无 BULK/forceBulk 相关改动；全仓无其它消费方拆分这类序列。单行 TextInput（input.ts:209）同样只认 ≥32，短 forced-bulk 含控制字符的序列在那里被整段丢弃（数据丢失，顺带确认）。

(4) 不是登记在案的欠账：docs/audits/2026-10-08-fix-backlog.md 与 2026-10-06-display-audit.md 均无 forced-bulk 短序列条目（backlog 里只有 R2-M3/R4-M3/R6-M3 等无关项）；R5-M3 已随 8ca369593 关闭，这是该修复引入的残余回归，属新发现。

一点细化：纯 CRLF 折叠场景（"a\r\n".repeat(11)）里 getText() 恰好仍等于原文（\n 字符留在行内、join 时原样拼回），模型收到的文本可能碰巧正确，但显示/光标/退格已坏；\t 场景连文本都会进一步丢失缩进。severity 维持 should：真实正确性 bug，影响面限于无 bracketed-paste 终端的粘贴路径，非崩溃/安全级。

### 1.4. ipython error traceback rows rendered unwashed (escapes reach terminal)

- **级别**：should（车道 `wash-faces`）
- **位置**：`packages/coding-agent/src/modes/interactive/components/ipython-cell.ts:876`
- **现状**：FORK_NOTES 波五/波六宣称 ipython 输出面已由 normalizeErrorDetails 兜住（"CollapsibleError 行与 ipython 输出面不过 Text 门"），R4-M7 修了顶行 label/errorName/展开代码。
- **后果**：模型在 ipython cell 里执行 `raise SystemError("\x1b]52;c;<b64>\x07")` 之类（或 traceback 中回显带转义的文件内容）→ 内核 error.traceback 原样进 details.error（ipython.ts:1203 `error: r.error`，repl-manager.ts:2167 `asStringArray(event.traceback)`）→ 展开的错误 cell 经 renderTraceback 直接把每个 traceback 行喂给 addWrapped（wrapTextWithAnsi/truncateToWidth 均保留转义序列，theme.fg 只包色码）→ OSC52 写剪贴板、BEL 每次重绘响一次，绕过 Text 中央门与 normalizeErrorDetails 两道防线。而同函数里 details.stdout/stderr/result/backgroundOutput 及 splitTraceback 路径全部过了 normalizeErrorDetails——同一个 renderOutput 里唯独这条没洗。
- **证据**：逐行读 ipython-cell.ts renderOutput 全部出口（658/663/672/678/685/734 的 stdout/stderr/result/traceback.output/shown/backgroundOutput 都先 normalizeErrorDetails，唯独 721 的 details.error.traceback 没有）；readErrorDetails 只做类型检查不洗；ipython.ts:1203 `error: r.error` 原样进 details；repl-manager.ts:2167 `traceback: asStringArray(event.traceback)` 原样来自内核；a5bf990ce 新增的 ipython-cell-sanitize.test.ts:90 用例把 traceback 设为 []，恰好没钉这个面；核过 addWrapped→wrapTextWithAnsi 与 truncateToWidth（tui/src/utils.ts）都是 ANSI 保留型，不剥任何序列。
- **修法**：renderTraceback 的两处调用点（721 的 `details.error.traceback.join("\n")`）在传入前过一次 normalizeErrorDetails（与 splitTraceback/其他输出面同款），或在 renderTraceback 内部逐行洗；补一条 traceback 携带 OSC52/BEL 的先红测试。
- **复核确认**：逐环核实，finding 的每一环都成立，且未在 09eae8d55..HEAD 范围内被处理。

(1) 代码与假设一致。ipython-cell.ts:719-725 把 `details.error.traceback.join("\n")` 原样传 renderTraceback（876-880），逐行 addWrapped（883-891）→ wrapTextWithAnsi（tui/src/utils.ts:881，注释自证「ANSI codes preserved」，短行走 wrapSingleLine 的 visibleLength<=width 早退原样返回）→ truncateToWidth（utils.ts:1230，同样有「已符合宽度原样返回」早退，ANSI unit 只累积从不丢弃）→ theme.fg 只包 SGR 色码（theme.ts:562）。readErrorDetails（ipython-cell.ts:292-307）只做类型过滤不洗。同函数其他所有输出面（658/663/672/678/684/734）和 splitTraceback 路径（728，源头 334 行过 normalizeErrorDetails）都洗了，721 的 `||` 回退 formatIpythonErrorSummary 也洗（364-373）——唯独非空 traceback 不洗。tui.ts 写屏路径（2381/2428：`buffer += line; terminal.write(buffer)`）逐字节直写，只对超宽行 clamp、图片行特殊处理，无中央清洗。

(2) 失败路径可达。内核侧 prime-agent-runtime/src/rlm/repl.py:837-855 `_error_event` 用 `TracebackException.format()`/`format_exception_only`/`_safe_str(exc)`=str(exc)——无任何转义处理，`raise SystemError("\x1b]52;c;..\x07")` 的 traceback 行就是裸 OSC52 字节；repl-manager.ts:2167 `asStringArray(event.traceback)`（474-475 只滤字符串类型）→ ipython.ts:1203 `error: r.error` 原样进 details → 展开即中招。展开是生产行为：tool-execution.ts:347-354 setExpanded、527 行点击区、378-384 applyTurnExpansion 把打开的 block 映射为每个工具 expanded=true。716 行的中断抑制只拦 KeyboardInterrupt/aborted，普通 error 不拦。

(3) 范围内无别处处理。09eae8d55..HEAD 触及 ipython-cell.ts 的三个提交（b8455e1bb=R4-M7 顶行/展开代码、a1638d15a、c6c7fb17c）都不碰 traceback 面；当前 HEAD 721 行仍未洗。

(4) 不是登记在册的延后欠账。2026-10-08-fix-backlog.md:65 登记的 ipython 条目只有 R4-M7（顶行 label/errorName/代码行）；延后清单（R3-M1..M4、R6-M2/M4、R2-M11、未认领 Low）不含此项。相反，FORK_NOTES.md 第 6 行（波六）明文宣称「CollapsibleError 行与 ipython 输出面不过 Text 门」已由强化后的 normalizeErrorDetails 兜住，a5bf990ce 的提交说明也写「the ipython cell's output faces」——traceback 面恰恰是这个宣称的反例；配套测试 ipython-cell-sanitize.test.ts:90 把 traceback 设为 `[]`，正好没钉这个面。

severity 维持 should：需要用户展开 cell（一次点击/按键或 turn 展开才触发），常驻顶行已洗，够不到 must；但与审计中同类的清洗缺位（R4-M7 等 Medium 级）同档，且证伪了 FORK_NOTES 的已修宣称，不应降级。

### 1.5. duty log block renders model final-answer text unwashed (lastDoing/unfinished/pending)

- **级别**：should（车道 `wash-faces`）
- **位置**：`packages/coding-agent/src/core/duty-log.ts:582`
- **现状**：R3-M24/FORK_NOTES 宣称 duty-log「最后在做」已洗；实际只洗了 agent_status journal 摘要这一路（duty-log.ts:545），同一行/同一块的另外三个模型文本来源没洗。
- **后果**：无 agent_status 条目的会话（in-process 会话从不写 agent_status——appendAgentStatus 只有 daemon summarizer 调用；或 daemon 崩溃前的最后一轮）离开超过阈值后自动弹值班块 / /dutylog：模型最终回答里带 `\x1b]52;…\x07` 或 BEL（如回显了网页/文件里的转义内容）→ preview() 只塌空白不剥转义 → 「最后在做：…」「可能没做完：…」「需要你拍板：…」三行把原始转义序列送进 DutyLogBlock 自建行（truncateToWidth ANSI 保留、不经 Text 中央门）→ 钉在输入框上方的块每次重绘都重放注入序列。
- **证据**：读 duty-log.ts 全文：preview()（205 行）只做 markdown 标记剥离+空白塌缩+截断，无任何转义处理；lastFinalText 在 431 行取自 journal assistant message 的 textOf(content)；DutyLogBlock（duty-log-block.ts）的 factRow 用 truncateToWidth+theme.fg 自绘；grep 核实 agent_status 写入方只有 daemon-session-summarizer 两处（472/557，均已洗），确认 in-process 会话必然走未洗回退路径；a5bf990ce 的 duty-log.test.ts 新用例只钉 agent_status 路径。
- **修法**：在 summarizeDutyLog 的三个出口接 sanitizeRowText：decisionSentence 返回前、summary.unfinished 赋值处（575）、doing 回退处（582）；或在 formatDutyLog/DutyLogBlock.factRow 渲染层统一洗（后者一处盖全部行，含 pending/unfinished/lastDoing）。补「最终回答带 OSC52 → 值班块无注入」的先红测试。
- **复核确认**：追完整链路，finding 属实，且实际影响面比 finding 描述的还宽。

1. 代码与假设一致。duty-log.ts 里唯一的清洗点是 545 行（agent_status 摘要，`sanitizeRowText(status.summary)`）。preview()（duty-log.ts:205-214）只做 markdown 标记剥离 + `\s+` 塌缩 + 40 字符截断，不剥 ESC/BEL/OSC——`\x1b` 和 `\x07` 都不匹配 `\s`，原样存活。三个未洗出口均在：pending 问题（433 行 `decisionSentence(text)`、535 行 `preview(event.question)`）、unfinished（575 行）、doing 回退（582 行）。源头也确认：lastFinalText 在 431 行取自 journal assistant message 的 textOf，而落盘是裸的（agent-session.ts:5958 `sessionManager.appendMessage(event.message)`，provider 原文直写，无清洗）。

2. 失败路径可达，且不需要「无 agent_status」这个前提。grep 全仓确认 appendAgentStatus 只有 daemon-session-summarizer.ts:472/557 两个写入方（均已洗），所以 in-process 会话、以及 daemon 收敛出首个 idle verdict 之前的会话确实走 582 行未洗回退；但更重要的是：即便 agent_status 存在且 lastStatus 已洗，575 行的 unfinished 和 433/535 行的 pending 仍然来自未洗的模型最终回答/decision_needed 事件——「需要你拍板」「可能没做完」两行在所有会话里都可携带模型文本。触发条件只需模型最终回答回显含转义序列的内容（文件/网页里带 `\x1b]52;…\x07`），这正是本仓 sanitize 体系存在的全部理由（display-text.ts:1-15 的文档注释明说 journal/转录文本可携带这些序列，agents-view 对同源数据也是显示层洗：agents-view-state.ts:1505、daemon-session-summarizer.ts:181/537）。渲染层确认无兜底：interactive-mode.ts:9622 `new DutyLogBlock(formatDutyLog(summary, now))` 直接过；duty-log-block.ts:41-44 factRow 用 truncateToWidth + theme.fg 自绘，pi-tui 的 truncateToWidth（node_modules/@earendil-works/pi-tui/dist/utils.js:1074）是 ANSI 保留的（pendingAnsi 跟踪）；container.js/renderer.js/terminal.js 均无全局清洗。该块钉在输入框上方、每次重绘都重放。阈值触发点 interactive-mode.ts:9571/9588（离开超阈值自动弹）、6493（/dutylog）。

3. 09eae8d55..HEAD 无别处处理。a5bf990ce 提交信息自述「the duty log's 'last doing' line flattens a replayed multi-line journal summary」——即只处理 journal 回放路（agent_status）；FORK_NOTES.md 第 6 行「duty-log『最后在做』洗旧 journal 多行 summary（R3-M24）」同样只覆盖这一路。新增测试（test/duty-log.test.ts，"flattens a replayed multi-line status summary"）只钉 agent_status 路径。

4. 非已知欠账。2026-10-06-display-audit.md:323 的原始 R3-M24 就是「agent_status 摘要多行不塌缩」单项，已被 a5bf990ce 按原口径关掉；2026-10-08-fix-backlog.md 批次 C 列的是其他文件（turn-box/tree-selector 等），没有条目覆盖 duty-log 其余三个模型文本源。

severity 维持 should：是真实的终端转义注入路径（OSC52 可写剪贴板、CSI J 清屏、BEL 响铃），钉顶块高频重绘会反复重放，与同批已修的 R4-M16 等同级；但需要模型最终回答里恰好携带转义内容才触发，不是常规功能损坏，不到 must。fix 建议合理：在 summarizeDutyLog 三个出口接 sanitizeRowText，或在 formatDutyLog/DutyLogBlock.factRow 渲染层一处统一洗（后者连 incidents 回绕行也一并覆盖）。

### 1.6. anthropicSseError unparseable error-event frame still lands in errorMessage unbounded (R3-M25 half-fix)

- **级别**：should（车道 `ai-providers`）
- **位置**：`packages/ai/src/providers/anthropic.ts:467`
- **现状**：FORK_NOTES 车道 E 声称「anthropic SSE 坏帧 errorMessage 有界化（完整帧留 info.raw）」。实际只有 ANTHROPIC_MESSAGE_EVENTS 解析失败的路径（f83f9a9e8 修的那处）被有界化；同文件里 `event: error` 帧走 anthropicSseError()，其 catch 分支 `detail = data` 把整帧原文直接拼进 StreamFailureError 的 message，formatStreamFailureMessage 对 StreamFailureError 原样返回（只 redact 不截断），errorMessage 仍无界。
- **后果**：Anthropic 兼容代理（R3-M25 的原始场景就是 z.ai 类代理）返回 `event: error` + 一个 50KB 非 JSON data 帧（或 HTML 错误页）→ parseJsonWithRepair 抛错 → catch 分支 detail = 完整 50KB data → streamFailureMessage(info, detail) → errorMessage ≈ "Provider stream failed: <50KB 原文>" → 与 R3-M25 完全同款的「~100KB errorMessage 钉在输入框上方」症状复现，声称的修复只盖住了两条坏帧路径中的一条。
- **证据**：读 HEAD anthropic.ts L455-475（anthropicSseError 全函数）与 L900-905 终态 catch（errorMessage = formatStreamFailureMessage）；读 stream-failure.ts L296-302（StreamFailureError 分支无截断）与 L143-147（truncateRawPayload 只在 info.raw 用到）；对照 f83f9a9e8 diff 只改了 iterateAnthropicEvents 的 parse catch，anthropicSseError 未动（git show 09eae8d55:... 确认该函数与 L467 在基线即存在）。
- **修法**：把 anthropicSseError 的 catch 分支改为 `detail = truncateRawPayload(data)`（与 info.raw 同帽）；或统一在 formatStreamFailureMessage/streamFailureMessage 对 detail 做 truncateRawPayload。
- **复核确认**：代码核实（HEAD 3b57591a4）：

1. **代码与 finding 假设一致。** packages/ai/src/providers/anthropic.ts L457-476 `anthropicSseError` 的 catch 分支 L466-468 在 parseJsonWithRepair 抛错时 `detail = data`（整帧原文，无截断），L475 直接 `streamFailureMessage(info, detail)`；stream-failure.ts L62-71 的 streamFailureMessage 只做 `message += ": ${detail}"`，无任何长度上限。truncateRawPayload（stream-failure.ts L143-147）只用于 L473 的 info.raw，不碰 detail。终态 anthropic.ts L887 `output.errorMessage = formatStreamFailureMessage(error)`，而 stream-failure.ts L269-279 的 formatStreamFailureMessage 对 StreamFailureError 原样返回（仅 L273 redactSecrets，无截断）。

2. **失败路径可达。** iterateAnthropicEvents L496-499 对任何 `event: error` 帧调 `throw anthropicSseError(sse.data, requestId)`；data 为非 JSON（代理返回的 HTML 错误页）时 parseJsonWithRepair（json-parse.ts L85-95，repairJson 只修字符串内控制字符，HTML 仍过不了 JSON.parse）必然抛错进 catch。异常沿 streamAnthropic 的 try/catch（anthropic.ts L877-891）落到 L887 errorMessage，即被持久化进会话记录并上屏。这正是 R3-M25 审计场景（z.ai 类 Anthropic 兼容代理）里 `event: error` 帧的真实形态。

3. **范围内别处未处理。** 09eae8d55..HEAD 只有 f83f9a9e8 和 c9937500b 碰过 anthropic.ts：git show f83f9a9e8 diff 只改了 iterateAnthropicEvents 的 parse catch（把 data=…raw=… 双份无界改为单份截断），anthropicSseError 未动（git show 09eae8d55:…anthropic.ts L467 确认 `detail = data` 在基线即存在）；c9937500b 只改 diagnostic 去重。coding-agent 侧无任何 truncateRawPayload/MAX_RAW 消费点对 errorMessage 二次设界。

4. **不是已知欠账。** fix-backlog（docs/audits/2026-10-08-fix-backlog.md L84）把 R3-M25 记为已修，修法描述只覆盖 parse-catch 一条路径；未认领条目（R3-M1..M4、R6-M2/M4、R2-M11）均不涉及 anthropicSseError。FORK_NOTES L48 的「SSE 坏帧 errorMessage 有界化」覆盖面确实写大了——两条坏帧路径（普通帧 parse 失败 / error 帧解析失败）只修了前者。

**一处量级修正（不影响定级）**：原 R3-M25 是帧被贴两次（data= + raw= 双份，50KB→~100KB）；此路径只贴一次（detail=data，info.raw 是另存的截断副本），50KB 帧 → ~50KB errorMessage，非 finding 所说的「~100KB 同款」。症状性质（无界原文钉在错误消息里）相同，幅度减半，且仍经 redactSecrets 脱敏。

severity 维持 should：与审计已修条目同类、可达、有真实代理场景，但为单份、已脱敏、仅 error 帧解析失败这一非典型分支。修法同 finding：catch 分支改 `detail = truncateRawPayload(data)`。

### 1.7. Breaker budget exhaustion still kills the goal as non-resumable error state (half-fix of REVIEW-FIXUP item 3)

- **级别**：should（车道 `agent-loop`）
- **位置**：`packages/coding-agent/src/core/agent-session.ts:3535`
- **现状**：REVIEW-FIXUP-20261004.md 第 3 条（必修半修项）明确要求『到达总上限时，goal 的处理要和其它可恢复失败一致，不要直接判死』；提交 ec8edd643 的说明写『the terminal outcome goes through the recoverable-failure path instead of killing the goal outright』，FORK_NOTES 顶部节也写『goal 不再直接判死』。
- **后果**：无人值守的 persistent goal 遇上模型侧工具名劣化（FORK_NOTES 自己记载的 GLM 长上下文 XML 残片场景）：熔断预算耗尽后 runLoop 发出 stopReason:error 的终止消息（agent-loop.ts:2583）→ agent_end 处理链（agent-session.ts:6166）调 _finishGoalForTerminalAssistantMessage → _finishGoalWithError 把 goal 置 status:error、active:false。而 _resumeGoal（agent-session.ts:3465）只接受 paused/budget_limited，error 态无法 /goal resume；终止消息自己的指引『switch the session to another model (or fix the tool setup) before resuming』对 owner 不可执行——只能重建 goal。wave-11 宣称持久目标『只有 /goal clear（或 token 预算）能停』也被这条路径打破。恢复轮/预算/设置项/热刷新四项里前三项都真实落地，唯独这一子句是空的。
- **证据**：核实路径：git show ec8edd643 --stat 确认该提交未改 agent-session.ts 的 goal 代码（只改了 agent-loop/types/settings-manager/docs/测试）；读 agent-session.ts:6050-6175（agent_end 事件链：_isRetryableError→false（agent_lifecycle_failure 诊断，agent-session.ts:15491）、无 recovery-turn 拦截、compactionWillRetry=false）→ 6166 行 _finishGoalForTerminalAssistantMessage → 3514-3537 全文只有 abortInProgress 与 _quotaPark 两个豁免，无 breaker/lifecycle 豁免 → _finishGoalWithError 置 status error；读 _resumeGoal（3465-3496）确认只有 paused/budget_limited 可恢复；对照 REVIEW-FIXUP-20261004.md 第 46 行原文与 createToolNotFoundBreakerTerminalMessage 的 resuming 措辞（agent-loop.ts:2572-2578）。wave-11 的 FORK_NOTES 宣称持久目标只有 /goal clear 或 token 预算能停。
- **修法**：在 _finishGoalForTerminalAssistantMessage 里对带 agent_lifecycle_failure 诊断（或 stopReasonRaw === tool_not_found_breaker_tripped）的终止消息不调 _finishGoalWithError——落一个可恢复态（如 paused + lastReason=熔断说明）或让 _resumeGoal 接受该态；同时补一条先红测试：持久 goal + faux 模型连错工具名至预算耗尽，断言 goal 状态可经 /goal resume 恢复。
- **复核确认**：追到了完整可达的失败路径，finding 全部成立。(1) 代码与假设一致：熔断预算耗尽后 agent-loop.ts:924-935 发出 createToolNotFoundBreakerTerminalMessage（agent-loop.ts:2561-2608，stopReason:"error" 且携带 agent_lifecycle_failure 诊断），经 message_start/message_end/agent_end 真实事件流送达；agent-session.ts:5968 的 _lastAssistantMessage 接住，agent_end 链（agent-session.ts:6052-6166）里 _isRetryableError 因 agent_lifecycle_failure 返 false（agent-session.ts:15483-15486），非 empty-turn/provider-recovery 形状（诊断类型不同，无拦截），非上下文溢出故 compactionWillRetry=false，最终落到 agent-session.ts:6166 调 _finishGoalForTerminalAssistantMessage（agent-session.ts:3514-3537）——全函数只有 aborted、_goalAbortInProgress、_quotaPark 三个豁免，无任何 breaker/lifecycle 豁免，直接 _finishGoalWithError（agent-session.ts:3500-3510）置 status:"error"、active:false。git log -L 3514,3540 证实该函数自配额暂停提交 60f7ff393 后未再改动。(2) 失败场景可达：触发前置（模型连错工具名至每运行恢复预算耗尽）正是 FORK_NOTES.md:485 记载的 GLM 152 连错事故，且用户正是无人值守多日持久 goal 的使用方式；_resumeGoal（agent-session.ts:3472-3475）只接受 paused/budget_limited，error 态下 /goal resume 静默空转（仅 _emitGoalUpdate 后 return），持久 goal 心跳要求 status==="active"（agent-session.ts:5070），唯一出路是 /goal clear 后重建（丢目标与记账连续性）。(3) 09eae8d55..HEAD 范围内无他处处理：TOOL_NOT_FOUND_BREAKER_STOP_REASON_RAW 与诊断类型在 coding-agent/src 零引用（仅 settings-manager.ts:748 注释），导出的 isToolNotFoundBreakerFailure（agent-loop.ts:2339）无任何消费者，w11c 回归测试（packages/coding-agent/test/suite/regressions/w11c-tool-not-found-breaker.test.ts）与 packages/agent/test/tool-not-found-breaker.test.ts 均无 goal 断言。(4) 非刻意延后欠账：docs/audits/2026-10-06-display-audit.md 与 2026-10-08-fix-backlog.md 均无此条；ec8edd643 --stat 证实未碰 agent-session.ts（只改 agent-loop/types/settings-manager/docs/测试），但其提交说明"the terminal outcome goes through the recoverable-failure path instead of killing the goal outright"与 FORK_NOTES.md:108"goal 不再直接判死"均宣称已做——REVIEW-FIXUP-20261004.md 第 3 条最后一子句实际未落地。severity 维持 should：熔断只在模型真实反复乱调工具名后触发，停止本身是保护性行为，且新 /goal 可重建，够不上 must；但无人值守场景下的不可恢复缺口 + 交付记录失实，不宜降级。

### 1.8. Email rule: URL-userinfo exemption exempts any email after any '://' on the line

- **级别**：should（车道 `scripts-docs`）
- **位置**：`scripts/pre-push-secret-scan.mjs:170`
- **现状**：scanLine 的 email 规则用 `line.slice(0, match.index).includes("://")` 判定 URL userinfo 豁免（scripts/pre-push-secret-scan.mjs:170），意图是放行 https://user@host/… 形态；但只要同一行前面任何位置出现过 `://`，后面真实存在的邮箱就整体放行。同类的还有 :169 的 `local === "git"`（任何 git@域名 邮箱全放行）和 :171 的「邮箱后紧跟 `:` 即放行」（不限 scp 形态）。
- **后果**：新增 diff 行或提交说明行写作「文档见 https://internal.corp.io/guide，联系 ops@corp.io」时，ops@corp.io 命中 EMAIL_PATTERN 但因行内有 `://` 被跳过，真实账号邮箱随 push 公开——这正是 fd1dd4e4c 泄漏类的目标形态，门形同虚设。check-secret-scan.mjs 的用例只覆盖「邮箱紧跟在 URL 内」的合法形态，没有覆盖这个混排形态。 <!-- secret-scan: allow -->
- **证据**：通读 scanLine 全函数与 :164-175 三个 continue；对照 self-test 的 clean 判例（只测了 token@github.com 紧跟 URL 的形态）与 check-secret-scan.mjs 全部 23 个用例（无 URL+独立邮箱混排判例）；确认无其它路径兜底扫到该邮箱。 <!-- secret-scan: allow -->
- **修法**：把豁免收紧为「邮箱位于 URL 的 userinfo 段内」：向前看窗口止于最近的空白/`/`，且紧邻 `://`；`git@` 与后跟冒号的豁免同样要求 local part 形如主机名（如 git@host: 下一字符是路径段），并在 check-secret-scan.mjs 补「URL 与独立邮箱同行的混排判例」防回归。
- **复核确认**：代码与 finding 假设完全一致：scripts/pre-push-secret-scan.mjs:170 `line.slice(0, match.index).includes("://")` 只查邮箱匹配位置之前是否出现过 `://`，不要求邮箱真的位于 URL userinfo 段内。把 scanLine 的邮箱规则逐行复刻验证：「docs at https://internal.corp.io/guide, contact ops@corp.io」整行零命中（同一邮箱在无 URL 的行里正常报 Email address）；:169 使「contact git@corp.io for repo access」放行（任何 git@邮箱，不限 scp 形态）；:171 使「email ops@corp.io: ...」放行（冒号后豁免不限 scp 形态）。失败路径可达：scanLine(:154) 由 scanMessagesText(:194, 提交说明逐行) 和 scanPatchText(:229-234, 新增 diff 行) 驱动，.husky/pre-push 三段中只有 stage 3 看内容，前两段只读 refs；packages/coding-agent/src/core/share-secret-detectors.ts 无任何 email 规则，别处无兜底。09eae8d55..HEAD 范围内只有 c9937500b（wave-40 引入批次）动过这两个文件，其后无收紧。check-secret-scan.mjs 全部 23 个用例及 --self-test 的 clean 判例（pre-push-secret-scan.mjs:368 只测 https://token@github.com/o/r.git 邮箱嵌在 URL 内的形态）均无「URL + 独立邮箱同行混排」判例。非已知延后欠账：docs/audits/2026-10-06-display-audit.md 与 2026-10-08-fix-backlog.md 均未提及 secret-scan；且文件头 :24-28 写的意图是「URL userinfo (https://user@host/...)」——比实现窄，属意图与实现脱节而非刻意放宽。这正是 fd1dd4e4c 泄漏类（提交说明里的账号邮箱）的目标形态，门在现实写法下形同虚设。severity 维持 should：这是仓库防泄漏门（纵深防御）被实际形态绕过、且与自述意图不符，但不是产品正确性缺陷，升 must 不合适，降 low 则低估了其对该泄漏类的失效。附注：:169 的 git@ 豁免和 :171 的冒号豁免在文件头 :26-27 有部分文档化（「scp-style git URLs」「the git@ local part」），但实现比 scp 形态宽（git@host 后无冒号也放行、非 git 前缀邮箱后跟冒号也放行），与 :170 一起构成同一类过宽豁免；核心确认点是 :170。 <!-- secret-scan: allow -->

### 1.9. New problem 6 unfixed: snapshot notices still filter user `_`-prefixed vars by reason string, FORK_NOTES claims a prefix-list fix

- **级别**：should（车道 `fixup-ledger`）
- **位置**：`packages/coding-agent/src/core/kernel/state-snapshot.ts:49`
- **现状**：任务单新问题 6 要求按 bootstrap 前缀清单过滤、不按原因过滤；FORK_NOTES 2026-10-04 REVIEW-FIXUP 节声称「压缩/恢复通知恢复提醒用户 _ 前缀变量（按 bootstrap 前缀清单）」。
- **后果**：模型在 ipython 里绑定 `_cache = 耗时计算结果`（非 dunder、非 _prime_agent_/_PrimeAgent/_PRIME_AGENT_ 前缀）。runtime（repl.py:1314-1324）把它记入 skipped，reason 是 "private-name convention: leading-underscore names are not persisted"；而 isExpectedSnapshotSkip（state-snapshot.ts:49-53）按这个原因字符串整条滤掉——compactionKernelStateLines(:200)、restoreNoticeLines(:279)、reset-notice.ts(:115)、repl-manager.ts(:3286) 四个消费点全都看不到这个名字。压缩与恢复通知只字不提，模型以为该变量已持久化，重启后静默丢失。FORK_NOTES 说的「按 bootstrap 前缀清单」在 HEAD 不存在：过滤仍是原因字符串等值匹配。
- **证据**：通读 state-snapshot.ts 全文（isExpectedSnapshotSkip:49、compactionKernelStateLines:200、restoreNoticeLines:279）、repl.py:1299-1325、reset-notice.ts:115、repl-manager.ts:3286 四个消费点；通读 kernel-snapshot-notice-internal-names.test.ts 确认无用户 _ 名字用例；git log 09eae8d55..HEAD 显示 kernel/state-snapshot.ts 只有 c9937500b（wave-40，即引入该过滤的提交）动过，修复蜂群没有任何提交接手此条；grep coding-agent src 无任何 _prime_agent_ 前缀清单出现在快照通知路径。
- **修法**：isExpectedSnapshotSkip 不再匹配 "private-name convention" 原因字符串，改为按名字判断（dunder、_prime_agent_/_PrimeAgent/_PRIME_AGENT_ 前缀），保留 cannot pickle '_PrimeAgent 的 reason 匹配；补一条「用户 _foo 必须出现在压缩与恢复通知」的测试（现有 kernel-snapshot-notice-internal-names.test.ts 只测 _prime_agent_os 被滤、gen 保留，没有用户下划线名字用例）。
- **复核确认**：代码与 finding 假设完全一致。isExpectedSnapshotSkip（packages/coding-agent/src/core/kernel/state-snapshot.ts:49-54）仍按原因字符串整值匹配 "private-name convention: leading-underscore names are not persisted"，全 src 无任何按 _prime_agent_/_PrimeAgent/_PRIME_AGENT_ 前缀判断名字的过滤（grep 零命中）。失败路径可达且已实锤：prime-agent-runtime/src/rlm/repl.py:130 定义 _INTERNAL_NAME_PREFIXES，:1314-1324 把非 dunder、非内部前缀的下划线名字（即用户私有名字）记入 skipped 且 reason 正是那个字符串——:1307-1309 注释明说「用户绑定过、重启后可能还想要，所以像其他被跳过的名字一样报告」；但 wave-40（c9937500b）之后该 reason 只对应用户名字，四个消费点却仍按 reason 滤掉：compaction 通知（state-snapshot.ts:200，经 agent-session.ts:11827 渲染 <ipython_state>）、restore 通知（state-snapshot.ts:279，经 agent-session.ts:11952 渲染 <ipython_state_restored>）、回滚通知（reset-notice.ts:115）、日志分级门（repl-manager.ts:3286；:3280 的诊断行虽带名字，但那是宿主侧 kernel 诊断，不是模型可见通知）。结果：模型 _cache 在压缩/恢复/回滚通知中只字不提，模型以为已持久化，重启后静默丢失。别处未处理：git log 09eae8d55..HEAD 显示 kernel/state-snapshot.ts 只有 c9937500b 动过，其 repl.py 侧改动（内部名字离开 manifest）反而使 reason 字符串现在精确对应被滤掉的用户名字；测试 kernel-snapshot-notice-internal-names.test.ts 亦无用户下划线名字用例。也非刻意延后：docs/audits/2026-10-06-display-audit.md 与 2026-10-08-fix-backlog.md 均无此条。FORK_NOTES.md:110（2026-10-04 REVIEW-FIXUP 节）声称「压缩/恢复通知恢复提醒用户 _ 前缀变量（按 bootstrap 前缀清单）」在 HEAD 不成立——任务单 REVIEW-FIXUP-20261004.md 四·问题 6 要求「按 bootstrap 的前缀清单过滤，不要按原因过滤」，该修复未做。severity 维持 should：是通知诚实性缺口（静默丢失用户对持久化的信任），非崩溃/损坏，且下划线不持久化本身是 Python 约定行为。

### 1.10. Item 1-3 'goal not killed outright' claim is not backed by code: breaker terminal still marks active goal error, and an error goal cannot be resumed

- **级别**：should（车道 `fixup-ledger`）
- **位置**：`packages/coding-agent/src/core/agent-session.ts:3535`
- **现状**：任务单一-3 建议修法要求「到达总上限时，goal 的处理要和其它可恢复失败一致，不要直接判死」；ec8edd643 提交说明与 FORK_NOTES 均声称 goal 不再直接判死（terminal outcome goes through the recoverable-failure path）。
- **后果**：无人值守持久目标运行中模型连续幻觉工具名、3 次恢复预算耗尽：agent-loop.ts:924 以 stopReason:"error" + stopReasonRaw:"tool_not_found_breaker_tripped" 结束运行（带 agent_lifecycle_failure 诊断）→ agent-session.ts:6166 调 _finishGoalForTerminalAssistantMessage → :3535 _finishGoalWithError 把 active goal 置为 status:"error"。_resumeGoal(:3470) 只接受 paused/budget_limited，error 状态的 goal 无法 /goal resume（静默 no-op），只能整个重建目标。没有任何代码路径（grep 全 src 无 isToolNotFoundBreakerFailure/TOOL_NOT_FOUND 消费方）豁免 breaker 终局。任务单点名的半条修法在 HEAD 没有落地，蜂群的两个 breaker 提交（ec8edd643、814c26869）都只改 packages/agent + settings，未动 agent-session 的 goal 路径，也没有 goal 相关断言测试。
- **证据**：读 agent-loop.ts:919-936（trip 终局发射）与 2561-2611（终局消息构造，带 agent_lifecycle_failure 诊断）；读 agent-session.ts:6064-6176（agent_end 终局路径，6166 调 goal 判定）与 3514-3537、3465-3498（判死与 resume 限制）；grep 整个 coding-agent src：isToolNotFoundBreakerFailure / TOOL_NOT_FOUND_BREAKER 无任何生产消费方（仅 packages/agent 测试），agent-session.ts 里 toolNotFound 仅 2926 一处设置项接线；git show ec8edd643 与 814c26869 的 stat/diff 确认二者均未触碰 agent-session.ts 的 goal 路径；w11c 与 tool-not-found-breaker 测试 grep 无 goal 断言。
- **修法**：在 _finishGoalForTerminalAssistantMessage 的 error 分支对 isToolNotFoundBreakerFailure(message)（agent 包已导出）走可恢复分支（如置 paused + 明确 lastReason「模型持续幻觉工具名，换模型后 /goal resume」），或让 error 状态可被 /goal resume 恢复；补 goal 状态断言的回归测试（w11c 场景 + persistent goal）。
- **复核确认**：逐条核验后 finding 成立，且失败路径在 HEAD 可达：

1. 代码与 finding 假设一致。packages/agent/src/agent-loop.ts:919-936 在 breaker trip 时合成终局 assistant 消息并走 agent_end；:2576-2587 该消息 stopReason:"error" + stopReasonRaw:"tool_not_found_breaker_tripped"，:2588-2610 附 tool_not_found_breaker 诊断与 agent_lifecycle_failure 诊断。

2. 失败路径可达。agent-session.ts:6051 agent_end 取 _lastAssistantMessage（即 breaker 终局消息）；_isRetryableError(:15462) 经 _isAgentLifecycleFailure(:15483) 判为不可重试；空转/供应商恢复梯队（:6082/:6108）都不匹配该形状；落到 :6166 _finishGoalForTerminalAssistantMessage → :3524 stopReason==="error" 分支（无 aborted/goalAbortInProgress/quotaPark 豁免，breaker 不设这些）→ :3535 _finishGoalWithError → :3505-3511 把 active goal 置 status:"error"。随后 ：3470 _resumeGoal 只接受 paused/budget_limited，error 状态静默 no-op（仅 _emitGoalUpdate，不报错，:4220-4223 的 /goal resume 入口原样吞掉）；persistent goal 心跳也在 :4995/:5070 因 status!=="active" 停摆。终局诊断文本还建议「switch the session to another model … before resuming」，但 error goal 根本无法 resume，只能 /goal 重建——诊断误导。

3. 范围内无别处处理。grep 全仓：isToolNotFoundBreakerFailure / TOOL_NOT_FOUND_BREAKER_STOP_REASON_RAW 在生产代码的唯一消费方就是 agent-loop.ts 自身；coding-agent 侧仅 settings-manager 注释与 agent-session.ts:2926 的设置接线。ec8edd643 stat（agent-loop/types/两测试/settings-manager/docs）与 814c26869 stat（agent-loop/types/测试）均未触碰 agent-session.ts 的 goal 路径；范围内其它触碰 agent-session.ts 的提交（f679e6d5a 只加 abortRetry 的 _goalAbortInProgress 对齐，c9937500b 等）也无 breaker-goal 豁免。

4. 非已知欠账。docs/audits/2026-10-06-display-audit.md 与 2026-10-08-fix-backlog.md 均无 breaker/goal 相关条目。w11c 回归测试（w11c-tool-not-found-breaker.test.ts）grep 无任何 goal 断言。

5. 超claim核实。FORK_NOTES.md:108「goal 不再直接判死」与 ec8edd643 提交说明「the terminal outcome goes through the recoverable-failure path instead of killing the goal outright」在代码上无支撑——「recoverable」只体现在 loop 内每 run 最多 3 次恢复轮延迟 trip；一旦 trip，goal 仍被判死为 error，且不可恢复。任务单一-3 点名的半条修法确实未落地。

severity 维持 should：无崩溃/数据损坏，用户可 /goal 重建目标绕过；但本仓老板的核心用例是无人值守多日持久目标（「只有 /goal clear 或 token 预算能停」），breaker 终局成为第三种静默停摆方式，且诊断文本给出无法执行的 resume 建议，不降到 low。

### 1.11. Unguarded data-driven loop over the recovery journal: an empty journal passes vacuously

- **级别**：should（车道 `tests-quality`）
- **位置**：`packages/coding-agent/test/daemon-crash-recovery-chain.test.ts:397`
- **现状**：两处 `for (const record of WorkerRecoveryJournal.readLatest(journalPath)) { expect(record.busy).toBe(false); expect(record.operation).toBe("recovery_hold"); }` 的注释声称「journal is resolved」，但循环前没有 expect(records.length).toBeGreaterThan(0) 守卫——AGENTS.md 明确要求生产数据驱动的循环必须先断言非空，否则空集合静默通过。
- **后果**：若恢复实现的回归改成「解决 journal = 直接删除/丢弃 journal 文件」或 readLatest 因路径/环境问题返回 []（该文件自己就通过 DAEMON_WORKER_RECOVERY_JOURNAL_ENV 注入路径），循环体一次都不执行，「journal 已结算、尸体不再保留」这条命题零断言通过；该回归钉子静默腐烂，无人值守的 crash-recovery 链路失去保护。
- **证据**：对比 09eae8d55 版本确认该文件原有一处同形循环（旧债），397 行这处是本区间新增；读了 WorkerRecoveryJournal.readLatest 的其余 3 处调用点（205 行 survived 有 toContainEqual、281 行有 [0]?.queuedInputs、490 行有 toHaveLength(1) 显式守卫），说明同文件其他用点守卫齐全，唯独这两处循环裸奔。
- **修法**：先 `const records = WorkerRecoveryJournal.readLatest(journalPath); expect(records.length).toBeGreaterThan(0);`（或 expect 精确条数并断言每条 recovery_hold）再进循环；236 行的同形存量循环一并补。
- **复核确认**：代码属实：HEAD 的 packages/coding-agent/test/daemon-crash-recovery-chain.test.ts:236-239 与 397-400 确为两处 `for (const record of WorkerRecoveryJournal.readLatest(journalPath))` 裸循环，注释均称 "The journal is resolved, so the corpse is not kept"，循环前无任何非空守卫。历史也如 finding 所述：09eae8d55 基线上只有一处同形循环（基线 210 行，现 236 行，旧债），397 行这处是 09eae8d55..HEAD 区间新增（0c76de141/f7ad84c24 引入第三个测试）。

失败路径可达（回归保护缺口）：实现侧 daemon-supervisor.ts:6586-6594 在 uncertain 非空时以**追加** recovery_hold 记录方式结算 journal（不删文件），当前两测试里 uncertain 均非空，循环目前实际执行、确实钉住了现行为——所以这不是今天的活 bug。但 worker-recovery-journal.ts:77-79 的 parseJournal 对 ENOENT 返回空 map：一旦恢复语义被重构成「结算=删除 journal 文件」（finding 假设的回归），readLatest 返回 []，循环体一次不跑，「journal 已结算、尸体不再保留」命题零断言通过；且该测试文件 227/381 行的 interruptions 断言只覆盖 markInterrupted 调用，不构成间接守卫。全仓 grep 确认 recovery_hold 仅在此测试文件被断言，别无兜底。corrupt-write 型回归倒是会被抓住（latest map 保留旧 busy 记录，循环体执行并失败），唯删除/空读路径是真空通过——与 finding 的失败场景一致。

AGENTS.md 规则明确适用（"Guard data-driven loops: an expect inside for (const item of dataFromProduction) needs expect(data.length).toBeGreaterThan(0)"）：被迭代集合是被测恢复代码写到真实磁盘 journal 的产物，其空与否是行为而非 fixture 事实。也排查了 docs/audits/2026-10-06-display-audit.md 与 2026-10-08-fix-backlog.md（R3-M1..M4、R6-M2/M4、R2-M11 等），均未记录此欠账，非已知延后项。finding 的小瑕疵：把 281 行 `[0]?.queuedInputs` 列为「守卫齐全」的用点稍不精确（那不是长度守卫，但空集合时 undefined 对 toEqual(非空数组) 会失败，不会真空通过），不影响结论。修复建议（先 expect 非空/精确条数再进循环，236 存量一并补）正确。severity "should" 恰当：是测试卫生规则违规 + 可达的回归钉腐烂路径，非生产缺陷。

### 1.12. New private-member probes in gate-invisible forms (Reflect / prototype shadow types / non-underscore casts)

- **级别**：should（车道 `tests-quality`）
- **位置**：`packages/coding-agent/test/agents-view-mode.test.ts:1070`
- **现状**：本区间的修复蜂群向多个测试新增了私有成员探针，形态全部落在 check 脚本的可探测范围之外：agents-view-mode.test.ts 新增 14 处 Reflect.get/Reflect.set 直取 `private` 成员（rows/replyTarget/pendingDeleteAgent/expandedSubagentParents/scopedRecords/scopeRootSummary，均在 agents-view-mode.ts:959/1005/1017/1025 声明为 private）；interactive-mode-subagent-lifecycle-status.test.ts:239 Reflect.get(InteractiveMode.prototype, "reconcileSubagentTimeline")（interactive-mode.ts:7870 private）；interactive-mode-slim-transcript.test.ts:63 用同文件影子类型 `TurnStartProto`（成员无下划线、名字不以 Internals 结尾——正是 checker 自认的盲区，见 scripts/check-test-private-probes.mjs Non-goals 节）cast prototype 取 private 方法 restoreTurnStartFromMessages；daemon-crash-recovery-chain.test.ts:485-488 用无下划线的 brace cast 调 daemon-mode.ts:9837 的 private recordWorkerRecoveryState。而 235575b66 等提交的门禁记录写「test-hygiene OK（无新私有成员探针）」。
- **后果**：读形态（Reflect.get）重命名后大多响亮地红（undefined → TypeError/断言失败），但写形态是静默腐烂：把 `rows` 改名后 `Reflect.set(view, "rows", rows)` 会在对象上凭空造出一个生产代码从不读的幽灵属性，测试随后驱动/断言的是一份与实现脱钩的状态——编译零报错、hygiene 门零报错、测试照常绿，AGENTS.md「Renaming a private member must not be able to break a test silently」的意图被绕过。
- **证据**：git diff 统计 agents-view-mode.test.ts 新增 14 处 Reflect、移除 0 处；逐一在 agents-view-mode.ts / interactive-mode.ts / daemon-mode.ts grep 确认被探成员均为 `private` 关键字成员（无下划线前缀，checker 的三条规则 private-cast/private-cast-alias/private-spyon 均只认下划线成员或 *Internals 命名）；读 checker 的 SCANNER_NEGATIVE_CONTROLS 确认无下划线 brace cast 是声明的非目标。
- **修法**：按仓规二选一：给 AgentsViewMode/InteractiveMode/daemon 留出窄公共 seam（导出 helper、可注入选项或可观测事件），测试改走公共入口；或把 checker 扩到 non-underscore `private` 关键字成员（AST 级判定而非正则）。短期至少在这些行补带具名理由的 `test-hygiene-allow:` 标注，让欠账对 gate 可见。
- **复核确认**：逐项核实，finding 的事实链全部成立，且我用门脚本实跑验证了盲区本身。

1. 探针确凿、均在本区间新增（09eae8d55..HEAD）：
- packages/coding-agent/test/agents-view-mode.test.ts：git diff 统计新增 14 处 Reflect.get/Reflect.set、移除 0 处（由 497553d6d、68ed41031 引入）。被探成员在 packages/coding-agent/src/modes/agents-view/agents-view-mode.ts 均为 `private` 关键字、无下划线：rows:959、scopedRecords:967、scopeRootSummary:969、expandedSubagentParents:1005、replyTarget:1017、pendingDeleteAgent:1025。另：行 109 的 invoke helper（`Reflect.get(AgentsViewMode.prototype, method)`，可打 36 个多为 private 的方法，如 renderRow:3184、toggleReplyTarget:1968）正是 235575b66 自己引入的，而该提交 body 第 49/70 行写「test-hygiene OK（无新私有成员探针）」。
- interactive-mode-subagent-lifecycle-status.test.ts:239 `Reflect.get(InteractiveMode.prototype, "reconcileSubagentTimeline")`，区间内新增、区间内零删除；interactive-mode.ts:7870 声明为 private。
- interactive-mode-slim-transcript.test.ts:59-63 `type TurnStartProto`（成员无下划线、名字不以 Internals 结尾）cast prototype 调 private restoreTurnStartFromMessages（interactive-mode.ts:4568）；diff 显示为新增（无对应删除行，非纯移动）。
- daemon-crash-recovery-chain.test.ts:483-488 无下划线 brace cast `as unknown as { recordWorkerRecoveryState(...) }` 调 daemon-mode.ts:9837 的 private recordWorkerRecoveryState，区间内新增。

2. 盲区结构性成立并已实证：scripts/check-test-private-probes.mjs 三条规则只匹配 `as unknown as { _x }`（行 285 PRIVATE_MEMBER_RE 要求下划线成员）、`*Internals`/含下划线成员的同文件影子类型（行 290/315-334）、`spyOn(x, "_x")`（行 422 要求第二参首字符为 `_`）。`Reflect.get/set` 完全不在任何规则的模式里；非下划线 brace cast 与非 Internals 影子类型是脚本自认的非目标（行 31-35 Non-goals，行 724-726 负控制「an alias not suffixed Internals and without underscore members is not a probe」）。我在 HEAD 实跑 `node scripts/check-test-private-probes.mjs --base 09eae8d55`，输出「test-hygiene gate: OK (no new private-member probes)」——上述 20+ 处新探针一个都没被看见，门禁记录因此是「真实但空洞」的绿。

3. 失败场景可达：Reflect.set 的属性键是运行期字符串，编译期不检查。写形态的静默腐烂具体可达，例如 test 行 1295/1338 `Reflect.set(view, "ui", { terminal: { rows: 13 } })`——若 `ui` 改名，此行写幽灵属性、生产读真实 ui，13 行矮终端的截断场景被静默停止模拟而测试可能照常绿；行 1070 的 `Reflect.set(view, "rows", rows)` 之后 renderRow 以参数显式接收 row（行 1073），成员注入本身可能已与实现脱钩。读形态重命名后虽会运行期红（undefined → TypeError/断言失败），但依旧零编译期信号，与 AGENTS.md「Renaming a private member must not be able to break a test silently」的意图相悖。

4. 区间内别处未处理：四份测试的涉案行均无 test-hygiene-allow 标注；checker 在区间内未扩展（当前 HEAD 版本无 Reflect 规则）；docs/audits/2026-10-06-display-audit.md:169 反而明令「test-hygiene 门：不探私有成员，驱动公开入口断言可观察输出」——即这是对修复蜂群自身纪律要求的违反，而非刻意延后的已知欠账；2026-10-08-fix-backlog 的 R3-M1..M4/R6-M2/M4/R2-M11 均为显示/守护进程条目，与本条无关。

结论：claim、evidence、failure 三段与 HEAD 实况一致，门禁盲区经实跑复现。severity 维持 should：这是测试卫生/可维护性问题而非用户可见运行时故障，但规模（4 文件 20+ 处、门禁自认盲区被成批利用、门禁记录失真）足以排 must 之下、should 之位。

## 二、第二波确认问题（3 条，逐条带复核确认依据）

### 2.1. R5-M7 half-fix: timeline lanes still key subagent rows by the display label, not the new name field

- **级别**：should（车道 `python-runtime`）
- **位置**：`packages/coding-agent/src/modes/interactive/components/turn-timeline.ts:497`
- **现状**：提交 e4f1e7773（R5-M7）声称「host consumers (timeline lanes, turn box rows, the compaction handoff ledger) key subagent rows by the exact session name」，内核因此给 spawn 完成记录加了 display 管线外的 `name` 字段；但三个被点名的消费方里只有 compaction handoff ledger（34d56a68b, session-handoff.ts）真正读了 `activity.name`。parseActivityDisplay（effects.ts:124）和 readActivity（feed-data.ts:91）构造的 KernelActivity 根本没有 `name` 字段，字段在解析层就被丢弃。
- **后果**：子会话名含连续空格（如 "build  checker"，_safe_label 折叠成 "build checker"）、超过 160 字符被截断、或形似密钥被替换成 "subagent" 时：noteSpawns 用折叠后的 label 建 lane（childId=spawn:<label>），而 subagentReturned/reported 用真实会话名匹配（subagentLane(entry.sub) !== name），该行永远停在 running 状态（幽灵行），且与 snapshot 按真实名建的那行并存成重复 lane。
- **证据**：读 HEAD 最终态四处消费方代码（turn-timeline.ts noteSpawns、effects.ts parseActivityDisplay、feed-data.ts readActivity、session-handoff.ts applySubagentActivity），比对 e4f1e7773 提交说明；grep `KernelActivity` 全部使用点确认无 name 提取。
- **修法**：给 KernelActivity 增加 name?: string，在 parseActivityDisplay/readActivity 提取（校验非空字符串），noteSpawns 改用 activity.name ?? activity.label.trim() 作 lane 名；与 session-handoff.ts 的回退语义保持一致。
- **复核确认**：复核确认，代码事实与失败路径都成立，仅一个次要子场景（>160 截断）不可达。

【代码事实核对】
1. 内核侧确实加了 `name`：prime-agent-runtime/src/rlm/__init__.py:188-190 `extra = {"name": handle.name} if _effects.name_safe_to_record(handle.name) else {}`，随 `step.finish("ok", handle.model, label=handle.name, extra=extra)` 上报。但 `Step.finish`（prime-agent-runtime/src/rlm/effects.py:2864-2886）对 label 重新过 `_safe_label`（塌空白、按 MAX_LABEL=160 截断、形似密钥替换成 kind "subagent"），所以 ok 记录上 label=改写名、name=真名。
2. host 侧三个被点名消费方，只有 compaction handoff 真正读 name：packages/coding-agent/src/core/compaction/session-handoff.ts:100-110（parseActivity 提取 `name`）、:163 `activity.name ?? clip(activity.label, ...)`（34d56a68b，R6-M8）。而 `KernelActivity` 接口（packages/coding-agent/src/core/kernel/shared.ts:319-344）根本没有 `name` 字段；parseActivityDisplay（packages/coding-agent/src/core/kernel/effects.ts:124-155）和 readActivity（packages/coding-agent/src/modes/interactive/components/feed-data.ts:91-117）都只取 id/kind/label/status/detail/endedAt/background/commit，`name` 在两个解析层均被丢弃。grep 全部 KernelActivity 使用点无 name 提取。
3. noteSpawns（packages/coding-agent/src/modes/interactive/components/turn-timeline.ts:490-511，finding 的 line 497 即 `const name = activity.status === "ok" ? activity.label.trim() : ""`）仍以塌空白后的 label 建 lane（childId=`spawn:<label>`）。而 snapshot 路径 live-turn-flow.ts:766 用 `laneKey(child.sessionName, ...)`（agent-message.ts:149-151，sessionName.trim() 保留内部双空格）按真名建行；upsertSubagent 的去重（turn-timeline.ts:681-686）按 key=`sub:${childId}` 或 lane 相等匹配，与 noteSpawns 行的 `sub:spawn:<塌空白名>`/lane 均不匹配 → 同一子代理两行并存。子代理回报走 tracker.reported(真名)（timeline-lane.ts:144-152 → owners.get(name).subagentReturned(真名)），ghost 行的 lane 是塌空白名，subagentReturned（turn-timeline.ts:518-524）永远匹配不上 → 该行永远停在 running，且 reseedLane（turn-timeline.ts:534-552）按塌空白名查 returnedAt 也查不到。这正是 docs/audits/2026-10-06-display-audit.md:491 对 R5-M7 症状的原始描述（行卡 running + turn box 两行）。

【可达性】可达但触发面窄于 finding 所述：
- 双空格：会话名可由模型经 rlm.run 的 name 指定；sanitizeSessionName（packages/coding-agent/src/core/session-names.ts:12-15）只剥控制字符、normalize（rlm-runtime.ts:190-207）只 trim 两端，内部连续空格存活，_safe_label 塌掉 → label≠name。可达。
- 密钥形名字：name_safe_to_record 拒绝 → 记录无 name、label 被换成 "subagent"，错位更彻底。可达（模型可控）。
- finding 的「超 160 字符被截断」子场景不可达：会话名上限 64（rlm-runtime.ts:186 RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH=64），MAX_LABEL=160，永远不会截断；默认（未命名）spawn 的名字是 kebab slug（rlm-runtime.ts:243-259），与 label 恒等，不受影响。这不影响主论断。

【未在他处处理/非已知欠账】09eae8d55..HEAD 范围内 touching turn-timeline 的提交（cc01e9101 等）只删了 steady-text 死代码，未接 name；effects.ts/feed-data.ts 至 HEAD 仍无 name 提取。该条不在第一波已确认 12 条清单里；fix-backlog:118 把 R5-M7 记为「已对齐」，并非刻意延后的已知欠账——即 display-audit:491 描述的 timeline 症状其实没修完，只有 runtime 侧（e4f1e7773）和 handoff 侧（34d56a68b）落地。

severity 维持 should：触发需要模型显式起一个含连续空格或密钥形名字的子代理（默认命名路径不受影响），后果是 ghost 行 + 重复 lane（显示层错误，无数据损坏），但这是 e4f1e7773 提交说明点名要修的消费方之一，修一半留一半，should 合理。修复建议合理：KernelActivity 加 name?，在 parseActivityDisplay/readActivity 提取，noteSpawns 用 activity.name ?? label，回退语义与 session-handoff.ts:163 一致。

### 2.2. autocompact per-model entry can be pinned by project scope; the /settings toggle silently no-sticks

- **级别**：should（车道 `ext-settings`）
- **位置**：`packages/coding-agent/src/modes/interactive/components/settings-selector.ts:76`
- **现状**：同一批修复（377191179 的 projectPinnedSettingItems + 4560bf2f9 的 setCompactionEnabledForModel）里，/settings 的「自动压缩」开关写 globalSettings.compaction.perModel，读的却是 deepMerge(global, project) 后的合并值；projectPinnedSettingItems 枚举了 25 个面板项却漏掉新增的 "autocompact"（其背后是 compaction.perModel），项目层钉住该键时切换静默失效且无提示。
- **后果**：项目 settings.json 写了 compaction.perModel: {"anthropic/claude-x": false}；用户在 /settings 把「自动压缩」切到 true → setCompactionEnabledForModel 只写全局文件 → 合并读值仍是 project 的 false → 面板行翻了但重开面板/重启后回到 off，磁盘上留下一行永远不生效的全局条目，也没有 R4-M20 给其他键加的「项目 settings.json 固定了此项」提示。
- **证据**：读 settings-manager.ts:2911-2925（写 globalSettings + markModified）与 :2896-2904（读 this.settings 合并值）、deepMergeSettings/mergeSettingValue(1115-1156) 确认 project 同 key 覆盖 global；grep settings-selector.ts 全部 28 个面板 id 对比 pinned 集合的 25 项，"autocompact" 缺席；settings-compaction-per-model.test.ts 的 settingsPath 指向 agentDir（全局），无 project 钉住用例。
- **修法**：把 "autocompact" 加入 projectPinnedSettingItems（pin 依据 projectSettings.compaction?.perModel 非空，或至少 compaction 块存在），或让 setCompactionEnabledForModel 在 project 层钉住同 key 时显式告警/写 project 层。
- **复核确认**：复核结论：confirmed。逐点核实如下。

(1) 代码与 finding 假设一致。写侧：/settings 的「自动压缩」开关走 interactive-mode.ts:12255-12261 → agentConnection.setAutoCompactionEnabled → in-process-agent-connection.ts:555-561（daemon 路径 daemon-mode.ts:6358-6368 同形）→ settings-manager.ts:2911-2922 只写 this.globalSettings.compaction.perModel 并 markModified("compaction","perModel")（走全局写路径，无 project 层分支）。读侧：getCompactionEnabledForModel（settings-manager.ts:2896-2904）读 this.settings.compaction?.perModel?.[modelKey]，而 this.settings 是 recomputeMergedSettings（:2283-2288）里 deepMergeSettings(global, project) 的合并值，mergeSettingValue（:1115-1131）按 key 递归覆盖，project 同名 modelKey 的条目压过 global——save() 在 settings-manager.ts:2479-2480 保存后重算合并值，全局新写入的 true 被钉住的 project false 盖回。compaction（含 perModel）是合法的已知键（KNOWN_SETTINGS_KEYS:1223-1231），project 层 settings.json 没有任何 scope 限制阻止它（reload 时 :2057-2059 整体加载）。

(2) 失败场景可达且已追到完整链路。面板项 id 就是 "autocompact"（settings-selector.ts:292-298），projectPinnedSettingItems（settings-selector.ts:76-107）枚举的 25 项确实没有它，所以行上不会出现 PROJECT_PINNED_HINT（:109）。重开面板确实回到旧值：showSettingsSelector 每次打开都 await agentConnection.getState()（interactive-mode.ts:12198-12202），state.autoCompactionEnabled 来自 snapshot.ts:46 的合并读取；切换时行只靠 patchConnectionState 翻转（:12256），落盘后合并值仍是 project 的 false。更重的一层：自动压缩触发门 _compactionEnabledForCurrentModel（agent-session.ts:4394-4401）读的也是合并值，所以钉住时开关对实际行为零效果，不只是显示回退——磁盘上留下一条永远被项目层遮蔽的全局条目。

(3) 09eae8d55..HEAD 内无他处处理：projectPinnedSettingItems 只有定义与 interactive-mode.ts:12252 一个消费点；grep 全 src 无任何 autocompact 的钉住提示或写 project 层的路径。测试 settings-compaction-per-model.test.ts 全部写 agentDir/settings.json（全局），projectDir/.prime 只建目录不写文件，无 project 钉住用例——与 finding 所述一致。

(4) 非已知欠账：docs/audits/2026-10-06-display-audit.md 与 2026-10-08-fix-backlog.md grep autocompact/perModel 零命中；不在第一波 12 条已确认清单内；2026-10-09 iteration review 里也只有无关的 compaction 条目。

一处措辞修正（不影响结论）：finding 把 autocompact 说成「新增」——实际顺序相反，4560bf2f9（per-model 持久化，10-04）是 377191179（钉住集合，10-08）的祖先，即 R4-M20 写 projectPinnedSettingItems 时 per-model 持久化已存在四天，其注释「Session-state items (auto-compact, thinking level) have no settings.json key and are never in this set」（settings-selector.ts:73-74）从写下那天起就是错的，属于该修复自己的遗漏而非后续回归。

severity 维持 should：触发前提是有人在项目层 settings.json 手写 compaction.perModel 钉住当前模型（无任何 UI/代码路径会往 project 层写 compaction，只能手编），不常见，够不上 must；但 R4-M20 的整个目的就是给这种手编钉住加提示，同键漏网 + 触发门也读合并值导致功能性静默失效，不宜降级。

### 2.3. exit guard blind once the successor ProcessTerminal consumes the alt-screen handoff at construction

- **级别**：should（车道 `tty-probe-bus`）
- **位置**：`packages/tui/src/terminal.ts:826`
- **现状**：模块级 guard 用 `const altLive = this._altScreenActive || pendingAltScreenHandoff !== undefined` 判断备屏是否仍活着，但 `pendingAltScreenHandoff` 在继任 ProcessTerminal 构造时（字段初始化器 `consumeAltScreenHandoff()`，terminal.ts:248）就被吞掉，而继任实例自己的 guard 要到 start()（terminal.ts:302）才武装。构造到 start 之间的窗口里，前任 guard 读到 altLive 为 false：不写 1049l，且把主屏 kitty 的 POP 写在仍处于备屏的终端上（弹的是已弹空的备屏栈，真正的屏栈 entry 存活）。
- **后果**：agents-view 打开会话：finish() 里 ui.stop({preserveAltScreen:true}) 设置交接（agents-view-mode.ts:3011），随后 765 行 new InteractiveMode 构造 new ProcessTerminal 吞掉 handoff token，会话加载/初始化在 ui.start() 之前若发生未捕获异常（daemon 崩溃处理器 process.exit(1)）→ 仍武装的前任 guard 判 altLive=false → 不发 1049l（shell 提示符留在备屏、滚动历史被扣）且主屏 kitty entry 泄漏存活 → shell 里 kitty 协议仍启用，Ctrl+C 以 CSI-u 序列到达而非 SIGINT，需手动 reset。FORK_NOTES「alt-screen 交接期 guard 保持武装」与代码注释「a crash in the handoff gap is still covered by the old one」只对构造之前的间隙成立；terminal.test.ts:918 的故障注入正是在构造继任者之前触发的，构造后的窗口无测试。
- **证据**：静态追踪：agents-view-mode.ts:3011 preserve stop → resolveRun → 765 行 new InteractiveMode（2039 行 new ProcessTerminal 消耗 token）→ 后续 ui.start() 才换装 guard；guard 的 altLive 分支（terminal.ts:826-838）与 consumeAltScreenHandoff（terminal.ts:53-59）逐行核对；terminal.test.ts:918 的故障注入在构造继任者之前触发，未覆盖该窗口。
- **修法**：让 handoff 的消费发生在 start() 而不是构造器（构造器只记录意图），或给模块槽增加独立的「备屏仍在终端里」布尔（enterAltScreen/releaseAltScreen/guard 共同维护），guard 不再依赖 pendingAltScreenHandoff token 判断；并补一个「继任者已构造未 start 时崩溃」的故障注入测试。
- **复核确认**：静态逐行核实 + 调用点追踪，finding 的机制与后果都成立，且找到了比 finding 原叙述更硬的可达退出路径。

代码事实（HEAD 3b57591a4）：
1. 消费时机确实在构造器：terminal.ts:248 字段初始化器 `private _altScreenActive = consumeAltScreenHandoff()`，而 consumeAltScreenHandoff（terminal.ts:53-59）把模块槽 `pendingAltScreenHandoff` 清成 undefined。继任 ProcessTerminal 一构造，token 即被吞。
2. 前任 guard 此时仍武装：preserve-stop 不 disarm（terminal.ts:585-587，`!(options.preserveAltScreen && wasStarted)` 才 disarm；wasStarted=true 且 preserve → 保留）。继任者的 guard 要到 start() 里的 `this.armExitGuard()`（terminal.ts:302）才武装；全文件只有 armExitGuard（817-819）和 disarmExitGuard（868-870）会摘 guard，构造器不碰——所以构造到 start 的窗口里唯一武装的就是前任 guard。
3. guard 真瞎：terminal.ts:826 `const altLive = this._altScreenActive || pendingAltScreenHandoff !== undefined`——前任的 `_altScreenActive` 已在 stop 时清掉（terminal.ts:595），token 又被继任构造器吞掉 → altLive=false → 不写 `\x1b[?1049l`（831-834 跳过），而 `kittyMainScreenPushOutstanding` 仍为 true（agents-view 启动时主屏 push 的那条），835-838 把 KITTY_FLAGS_POP 写在仍处于备屏的终端上。preserve-stop 时 alt 栈那条已被 pop（terminal.ts:622 + 779-782，此时 ownsPendingAltScreenHandoff 为 true），所以这个 POP 打在空备屏栈上是 no-op，主屏真 entry 存活泄漏——与 finding 的「弹已弹空的备屏栈」逐字吻合。
4. 窗口真实且有异步内容：两条路径都有。(a) 回到 agents-view：agents-view-mode.ts:706 `new AgentsViewMode` → 构造器 1073 行 `new TUI(new ProcessTerminal())` 吞 token，run() 里先 `await client.reconnect()` / `await this.rosterStore.attach(client)`，ui.start() 在 1217 行才武装新 guard。(b) 打开会话：agents-view-mode.ts:765 `new InteractiveMode` → interactive-mode.ts:2039 吞 token，init() 里 `await Promise.all([ensureTool("fd"), ensureToolWithStatus("rg")])`（首跑要联网下载）等，ui.start() 在 2488 行。
5. 可达的未捕获退出路径（比 finding 原叙述更硬）：AgentsViewMode.run() 在 attach 失败时 `throw new Error(STALE_ROSTER_DAEMON_MESSAGE)`（agents-view-mode.ts:1207），reconnect 也可能 reject——这些都在 ui.start() 之前、token 已被吞之后。而 runAgentsViewLoop 里 `await view.run()`（agents-view-mode.ts:708）没有 try/catch，runAgentsViewMode（691）只有 finally，launchAgentsView/main 一路上抛到 cli 顶层 → 未处理 rejection → Node 默认退出进程 → 'exit' 事件触发前任 guard。守护契约（terminal.ts:806-809，R5-M5「uncaught exception, process.exit」）恰恰就是为这种死亡兜底的。
6. 测试缺口属实：terminal.test.ts:918 的 "a crash in the handoff gap" 在 `first.stop({preserveAltScreen:true})` 后立刻调 guard()，继任者尚未构造，测的是 token 还在时的路径；构造后窗口无覆盖。
7. 非已销账项：docs/audits/2026-10-06-display-audit.md 的 R5-M5 是这个 guard 的来源条目（已由 lane I 修复），两份 audit 与第一波 12 条确认项里都没有「构造到 start 窗口 guard 瞎」这条；FORK_NOTES.md:40「alt-screen 交接期 guard 保持武装」与 terminal.ts:95-98 注释「a crash in the handoff gap is still covered by the old one」声称的覆盖，在继任者构造之后实际不成立——设计与实现在这里真实分叉。

finding 原文一处小误差不影响结论：路径 (b) 里 init()/run() 的同步异常会被 runAgentsViewLoop 的 catch（agents-view-mode.ts:794-806 "Agent session crashed"）接住并 teardownSessionUi({preserveAltScreen:true}) 重新建立 handoff，不会退出进程；finding 引的「daemon 崩溃处理器 process.exit(1)」也在另一个进程。但路径 (a) 的 STALE_ROSTER/reconnect 异常是货真价实的未捕获进程退出，且任何窗口内事件回调抛出的 uncaughtException / fire-and-forget promise 的 unhandledRejection 都会终止进程——这正是 exit guard 存在的意义场景。

severity 维持 should：触发需要窗口内的异常退出（窗口含 daemon RPC 等待，daemon 重启/失联时可长达秒级，且 attach 失败是设计内的 throw），但一旦触发就静默击穿 R5-M5 的崩溃恢复保证——滚回历史被扣 + 主屏 kitty entry 泄漏（Ctrl+C 变 CSI-u，需手动 reset），用户可感知且无自愈。不到 must（正常路径不含此窗口退出），高于 low。修复建议合理：把 handoff 消费挪到 start()，或给模块槽加独立「备屏仍在终端里」布尔由 enter/release/guard 共同维护，并补「继任已构造未 start 时崩溃」的注入测试。

## 三、第三波确认问题（2 条，逐条带复核确认依据）

### 3.1. json-mode headless run ends on rlm_child_failure but exits 0

- **级别**：should（车道 `recovery-edge`）
- **位置**：`packages/coding-agent/src/modes/print-mode.ts:148`
- **现状**：R5-M25 修复把 rlmChildFailures 的 stderr 输出和 exitCode = 1 都写在 `if (mode === "text")` 分支内；json 模式（同样是 CI 消费面）既不打 stderr 也不置退出码，且 run_outcome 结构化终值事件只覆盖 rlm_quiescence_give_up 一种情况，没有子代理失败的对应事件。代码注释（:171-173「the exit code is what a CI consumer keys on」）和 FORK_NOTES 车道 H 的不区分模式的声称「子代理失败通知上 stderr 且 exit 1」都与 json 模式现实不符。
- **后果**：`prime-agent -p --output-format json` 的 run 以 rlm_child_failure 通知收尾（子代理崩溃/熔断而根会话无最终回答）时退出码为 0；按退出码判成败的 json CI 消费者把失败的 run 当成功。对照同函数里 rlmQuiescence.timedOut 和 autonomous gate failure 两类失败对两种模式都置 exitCode=1，行为不一致。
- **证据**：读 print-mode.ts:120-230（mode==="text" 分支边界、run_outcome 事件仅 rlmescence_give_up）；grep rlmChildFailures 全仓只有 print-mode.ts:174 一处消费；对照 FORK_NOTES.md:50 车道 H 声称。
- **修法**：把 rlmChildFailures 的 exitCode = 1 提到 mode 分支之外（与 autonomousStatus.rlmQuiescence?.timedOut 同层），json 模式下同时补发一条 reason 为 rlm_child_failure 的 run_outcome 终值事件，与 K3R-2 的机器面口径对齐。
- **复核确认**：结构确认：print-mode.ts:148 `if (mode === "text")` 分支内的 :174-177 才消费 rlmChildFailures（stderr + exitCode=1），json 模式整体跳过；json 面唯一置非零退出码的失败路径是 :144-147（rlmQuiescence.timedOut）和 :181-194（autonomous gate），均与模式无关；run_outcome 结构化终值事件只在 :217-231 的 rlm_quiescence_give_up（K3R-2）一种情况下对 json 发出，无 rlm_child_failure 对应事件。:171-173 注释、提交 c40ec6f0a 说明与 FORK_NOTES 车道 H 的「子代理失败通知上 stderr 且 exit 1」均未区分模式，与 json 现实不符。可达性：main.ts:2194-2200/:2377-2383 把 --mode json 经 toPrintOutputMode 送进同一函数并写 process.exitCode；rlm_child_failure 由真实失败通道生产（rlm-child-terminal.ts:220-256，stall_killed/aborted/error），子代理失败已结算不触发 quiescence timedOut，故 json 模式退出码确为 0。范围核对：不在已确认 15 条清单（print-mode.ts 不在列）；09eae8d55..HEAD 无别处补 json 退出码；rlmChildFailures 全仓消费仅 print-mode.ts:174 一处。但 docs/audits/2026-10-09-iteration-review.md:317 已按 [low] 记录同一条（车道 rpc-acp-machine），是当前波已知欠账而非新发现。severity 降为 low 的依据：json 消费者会收到完整事件流（print-mode.ts:114-117 把 rlm_child_failure custom message 作为 session_event 打到 stdout），流内可检出；且 json 模式连 primary stopReason error/aborted 也不置退出码（同在 text 分支 :152-155），退出码承载失败语义在 json 面本就是既有弱契约，R5-M25 的放置沿既有结构而非新引入的不一致；原始审计条目（display-audit:517）也只点名 -p 文本模式。

### 3.2. finish-gate green-run voiding silently depends on the display-only changeTracking setting

- **级别**：should（车道 `recovery-edge`）
- **位置**：`packages/coding-agent/src/core/self-recovery.ts:446`
- **现状**：REPL cell 写项目文件后只有靠 toolResult details.fileChanges（scope==="project"）才能作废先前的绿检查，但该字段由 PRIME_AGENT_CHANGE_TRACKING 控制：settings 的 changeTracking.enabled=false 时内核根本不装 tracker（prime-agent-runtime/src/rlm/effects.py install()→tracking_requested() 为 false，什么都不包装、零记录），fileChanges 和 changeTrackingIncomplete 两个字段同时消失；effects.py install() 内部异常也静默返回 false（追踪关了但没有 incomplete 信号）。ipython.ts:533-544 把这些 details 字段注释为 "Display-only"，而 finish gate 现在把它当正确性信号消费——UI 显示设置（默认开）一关，作废判定对 cell 写入（REPL 模式的主写入路径）整体失效。
- **后果**：无人值守 run：用户为省 UI 开销关掉 changeTracking.enabled（或某次 install() 异常）→ 模型先跑 `npm test` 得绿 → 再用 cell 改项目文件（open(...,'w')/Path.write_text）→ 声称完成 → runHasVerificationEvidence 判 verified=true，finish gate 直接放行，陈旧的绿结果被当作证据，任务实际未验证即报完成。与「追踪不完整则不作数」的既有保守原则自相矛盾：完全不追踪反而比不完整更被信任。
- **证据**：读 self-recovery.ts:436-473；effects.py:2724-2752（tracking_requested/install 的静默 false 路径）；agent-session.ts:14510-14513（env 由 UI 设置驱动）；ipython.ts:532-544 的 Display-only 注释；self-recovery.test.ts 无 changeTracking 关闭场景的用例。
- **修法**：gate 激活（selfRecovery.finishGate）时把「追踪关闭/未装上」视同 changeTrackingIncomplete（作废），或让 agent-session 在 finish gate 开启时无视显示设置强制向内核传 PRIME_AGENT_CHANGE_TRACKING=1，把正确性信号与 UI 显示层解耦。
- **复核确认**：finding 的机制链在 HEAD 3b57591a4 上逐环核实成立。

(1) 代码与假设一致。self-recovery.ts:437-461 的 resultChangedProjectFiles 对 cell 结果只认 details.fileChanges 中 scope==="project" 的条目（:446-456），cell 走 call.cell=true 时也不落到 SHELL_WRITE_COMMAND 兜底（:460）；resultHasIncompleteChangeTracking（:470-473）只认 changeTrackingIncomplete 字段存在。追踪关闭时这两个字段确实同时消失：agent-session.ts:14503-14513 由 _rlmKernelEnv 把 PRIME_AGENT_CHANGE_TRACKING 设为 settingsManager.getChangeTrackingEnabled() ? "1" : "0"（注释自述 "Display-only change tracking for the UI"），经 agent-session.ts:14080 传给内核 spawn；effects.py:2728-2757 的 install() 在 tracking_requested() 为 false 时直接 return False、不装任何 wrapper、零记录，repl.py:2445 的 install 调用处不看返回值，repl.py:941/948 的 begin/end_cell 变 no-op；TS 侧 kernel/effects.ts:268-275 的 resultFields() 全部条件展开，内核不发货架就没有 fileChanges 也没有 changeTrackingIncomplete，ipython.ts:1111-1118 的 finalEffectsDetails 照搬空。install() 内部异常路径同样静默 return False（effects.py:2749-2755），无 incomplete 信号。文档也确认这是用户可关的显示设置：packages/coding-agent/docs/settings.md:568（changeTracking.enabled 默认 true，"Off, the kernel installs no file wrappers"）。

(2) 失败场景可达。agent-session.ts:5282/5330 的 verifiedWork 调 runHasVerificationEvidence（self-recovery.ts:376-413）：先跑测试得绿 → cell 写项目文件（无任何 effect 帧到达）→ resultChangedProjectFiles 与 resultHasIncompleteChangeTracking 均为 false，绿不失效 → verified=true → completionClaimWithoutEvidence 在 options.verifiedWork 为 true 时直接返回 false（self-recovery.ts:498-499），finish gate 放行。settings-manager.ts:3278 显示 selfRecovery.finishGate 默认开，正是无人值守 run 的默认路径。REPL 分支上 cell 是主写入路径，shell 写命令有 SHELL_WRITE_COMMAND 兜底、edit 结果天然算改动，唯独 cell 写入完全依赖这个可被 UI 设置关掉的追踪器。

(3) 09eae8d55..HEAD 内未处理。引入该消费的是 bdfe0797b（"finish gate stops trusting green results after untracked writes"，commit message 自称 "cell code never takes this branch (it has real tracking)"——这句假设在 tracking 关闭时为假），之后没有补丁解耦。无任何代码在 finishGate 开启时强制 PRIME_AGENT_CHANGE_TRACKING=1，内核 ready 帧的 capabilities（repl.py:97-111）只含 preserve-names/message-notify，也不上报追踪状态。

(4) 非已知欠账。docs/audits/2026-10-06-display-audit.md、2026-10-08-fix-backlog.md 均无 changeTracking/finishGate 相关条目；2026-10-09-iteration-review.md:610 只记录了 changeTrackingIncomplete 作废与 SHELL_WRITE_COMMAND，未覆盖追踪关闭场景；给定的前两波 15 条确认清单里也没有本条。测试侧同样无覆盖：self-recovery.test.ts 与 test/suite/self-recovery.test.ts 只有 changeTrackingIncomplete 的用例（:266-275 / :738），无 tracking-off 场景。

severity 维持 should：默认设置不受影响、需要用户主动关一个文档标注 "Display-only" 的设置（或命中罕见的 install() 异常），但后果是无人值守 run 的完成检查对主写入路径整体失效，且与既有 "不完整则不作数" 的保守原则（self-recovery.ts:463-468）自相矛盾——完全不追踪反而比不完整更被信任。fix 建议方向（finishGate 开启时视追踪关闭为 incomplete，或强制传 PRIME_AGENT_CHANGE_TRACKING=1）与代码结构相符。

## 四、低优先 / 观察项（未复核，低置信，共 62 条）

**第一波**：

- **[low]** Held model-change notice flushes ahead of a mid-batch custom_message, re-splitting the tool batch on rebuild（`packages/coding-agent/src/core/session-manager.ts:1057`，车道 `session-core`）——wave-40/f679e6d5a 声称「换模型持久化顺序——合成提示挪到批后，AI 不再看到『那一步没有结果』」；实现把 custom_message 分支当作批终结事件无条件冲洗挂起通知。
- **[low]** User-cancelled retry leaves stale _terminalFailureAttemptCount in the sleep window（`packages/coding-agent/src/core/agent-session.ts:16306`，车道 `abort-esc`）——用户在重试倒计时中按 Esc（abortRetry）取消重试链后，sleep 的 catch 路径把 `_terminalFailureAttemptCount` 设回被取消链的 attempt 数；而 abortRetry 自身只在没有 controller 的窗口才清零（17385），且在该窗口它同步 return、catch 在微任务里后写，清零必然被覆盖。074f9a9f0 对 compaction handoff 的同类路径已明确裁定「clear, don't carry」（提交注释原话：a stale count here would credit a later non-retryable terminal error with this chain's attempts），此处与其相悖。
- **[low]** CPU evidence 60-min cap is not enforced when stallWatchdog.toolLivenessExemption is false（`packages/coding-agent/src/core/stall-watchdog-wiring.ts:355`，车道 `abort-esc`）——FORK_NOTES（2026-10-04 节）声称「CPU 豁免 60 分钟总上限+60s 平滑窗」。实现上 cap 只存在于 vouch 缓存（sampleStallCpuVouch 置位 capReached），而 sampleStallVouch 在 `toolLivenessExemption === false` 时于 355 行提前 return，永远不调 sampleStallCpuVouch；stepSilentMs 的 CPU 刷新（469-470）仍无条件执行，读到的 `stallCpuEvidenceSpent` 永远是 false。该配置下上限不存在。
- **[low]** Missing-session-cwd wake parking can loop at zero delay when the pause write fails（`packages/coding-agent/src/modes/daemon/daemon-supervisor.ts:2392`，车道 `supervisor`）——MissingSessionCwdError 分支在 pause 数为 0 时（pauseJob 持续抛错，如 session-artifacts 目录只读/写入失败，或 job 在 collect 与 pause 之间被并发改成非 active）也执行 scheduledWakeFailures.delete(rootKey)，把唯一的失败冷却地板清掉；recomputeScheduledSessionWake 随后对这个仍 active 且过期的 job 以 delay=0 重新布防，下一轮 wake 再次 launch 失败、再次尝试 pause。
- **[low]** Heartbeat/RLM resume keeps the missing-cwd pause reason on lastError（`packages/coding-agent/src/core/cron-jobs.ts:777`，车道 `supervisor`）——resumeHeartbeat 与 RLM heartbeat update 的 resume 分支都只改 status/nextRunAt，不清 lastError；missing-cwd 刹车把原因写在 lastError（pauseJob），交互界面 /crons 列表对任何 lastError 渲染『Error: …』（interactive-mode.ts:14892）。
- **[note]** Warm-pool build fingerprint re-stats the whole bundle dir synchronously on every create（`packages/coding-agent/src/modes/daemon/daemon-supervisor-warm-pool.ts:212`，车道 `supervisor`）——warmPoolBuildFingerprint() 每次调用对 dist/bundle 目录做 readdirSync + 每文件 statSync（HEAD 实测 115 个 .js）；takeWarmSpare 在每次 create、ensureWarmSpare 在每次成功 create 后、sweepWarmPool 每 60s 各调一次（takeWarmSpare 路径里最多两次），全部同步跑在 daemon 事件循环上且无缓存。
- **[low]** Final block keeps the streaming seal forever: indented code (or truncated fence) at message end stays plain-highlighted in the completed render（`packages/tui/src/components/markdown.ts:1910`，车道 `markdown-gate`）——FORK_NOTES 113 行只声称「流式期密封行素渲、闭合帧一次性上色」——把素渲描述为流式期暂态。但闭合判据 fenceRawClosed 只认「raw 末行是闭合 fence」；indented code（4 空格缩进代码块）没有 fence 开栏，永远判不闭合，而完成消息的最后一个块仍持续走 renderFinalBlockSealed（markdown.ts:1343，final block 不走 slot 缓存），seal.lines 里的素渲行被永久服出，不再有「闭合帧」纠正。
- **[low]** Washed-slice divergence: an escape payload containing \n leaks as visible text when a seal boundary falls inside the swallowed sequence（`packages/tui/src/components/markdown.ts:1941`，车道 `markdown-gate`）——中央门契约（sanitizeRenderText docstring 与 md 车道声称）是「未匹配转义序列整段丢弃、不留碎屑」；但 code/paragraph 密封按 UNWASHED 文本的 \n 边界切块（target 扫描在 token.text 上找 \n），每片独立过洗。串序列（OSC/DCS/APC）payload 可以含 \n：全量洗会把引入符到终止符整体吞掉（含内部 \n），切片洗时密封边界恰好落进 payload 内——前片把未终止序列整段剥掉，尾片从 payload 中间开始、把后半 payload 当可见文本渲染。
- **[note]** renderListItem text-token fallback bypasses the wash (only markdown leaf not behind sanitizeRenderText)（`packages/tui/src/components/markdown.ts:2507`，车道 `markdown-gate`）——md 车道声称「模型文本在每个叶子过洗涤点」；renderListItem 的 text 分支在 token.tokens 为空/缺省时直接 `token.text || ""` 插行，不经 sanitizeRenderText，是 markdown 渲染树里唯一裸叶。
- **[low]** splitFlushedInput turns a torn OSC/DCS/APC payload into typed key input, contradicting the "same bytes" claim（`packages/tui/src/stdin-buffer.ts:297`，车道 `input-editor`）——splitFlushedInput 的注释与 commit 8ca369593 声称真正撕裂的终端字符串「degrades to the same bytes」（退化为同样的字节）。实际不是：修复前 flush 把整个 blob 作为一个序列下发，Editor 对首字符为 ESC 的序列在键位兜底处被丢弃（charCodeAt(0)=27 < 32）；修复后 \x1b] / \x1bP / \x1b_ 前缀被拆成 2 字节和弦，余下 payload 被 extractCompleteSequences 当全新键盘输入重解析，可打印部分逐字符经 insertCharacter 打进编辑器草稿。
- **[low]** sanitizeRenderText leaks non-alphabetic CSI final bytes (~, @, { …) as visible text instead of dropping the sequence whole（`packages/tui/src/utils.ts:1418`，车道 `input-editor`）——sanitizeRenderText 的文档注释声称「drop every other escape sequence whole」——整条丢弃。实现里 CSI 分支要求 final 字节是 [A-Za-z] 才进入丢弃/保留判定；final 不是字母时（如 \x1b[3~ 的 ~、\x1b[2@ 的 @、{、} 等合法 CSI final 0x40-0x7E 非字母区），执行 `i = j`（不跳过 final），下一轮把该 final 字节当普通可打印字符写进输出。
- **[low]** Bulk (non-bracketed) multi-line paste into Input joins lines with no separator, diverging from the just-fixed bracketed path（`packages/tui/src/components/input.ts:210`，车道 `input-editor`）——8ca369593 修复 Input.handlePaste 时写了理由注释「joining lines without a separator silently rewrites the pasted content」，把 bracketed 粘贴的 \n 改成空格。但同一个组件的非 bracketed bulk 路径（input.ts:209-214）对 ≥32 的多行输入仍然 `filter(!isControl)` 把 \n 直接删掉、无分隔符拼接——正是注释里点名反对的行为。
- **[low]** kitty placeholder image id leaks when its covered row leaves the frame（`packages/tui/src/tui.ts:2084`，车道 `fullscreen-timeline`）——M4 的「浮层全覆盖期间图片 id 存活豁免」把被覆盖行的占位 id 从删除集里移除，但 updateKittyImageIds(newLines) 在同一帧已把该 id 从 previousKittyImageIds/kittyImageIdCounts 计数中扣掉（合成行不再含 KITTY_PLACEHOLDER_CHAR，extractKittyImageIds 读不到它）；若该行在浮层仍开着时从 newLines 中整体消失（聊天重建/收缩把行删了），下一帧 deleteChangedKittyImages 扫描的 previousLines 已是合成行（无占位符）、id 计数也为 0，删除永远不触发。
- **[low]** backfill measurement render spends the armed TURN_KEY_REVEAL marker（`packages/coding-agent/src/modes/interactive/interactive-mode.ts:9930`，车道 `fullscreen-timeline`）——本波为「测量渲染花掉单发 marker」专门修了 blankAt/renderForMeasurement（live-turn-flow.ts:114、conversation-components.ts:1202、turn-activity.ts:768），但 loadEarlierTranscriptPage 在 9930/9941 直接调 this.chatContainer.render(this.ui.terminal.columns) 量行数——render() 会把 TurnSummaryComponent.revealArmed 单发 marker 花进被丢弃的输出（turn-activity.ts:992-998 render() 无保护地消费 revealArmed）。
- **[note]** replay catch-all converts real bugs into silent "corrupted record" warnings（`packages/coding-agent/src/modes/interactive/components/conversation-components.ts:796`，车道 `fullscreen-timeline`）——FORK_NOTES 把「一条坏行跳过+可见告警行」当 replay 容错交付，但 catch 不区分 TypeError（坏数据）与实现自身的编程错误（任何 throw 都会被吞）——replay 代码里的 bug 现在表现为「⚠ 一条损坏的会话记录已跳过」，错误既不上抛也不进日志，半执行的分支（turnState 已建、行未挂）还会留下不一致的中间态。
- **[note]** formatTable still overflows when header-floor sum exceeds terminal width（`packages/coding-agent/src/cli/format-table.ts:55`，车道 `wash-faces`）——R2-M7 宣称表格不再溢出（240+ 列场景实测收敛），代码注释明示「每列至少保住表头整宽」是有意取舍。
- **[low]** Codex unparseable error body still reaches errorMessage unbounded（`packages/ai/src/providers/openai-codex-responses.ts:1532`，车道 `ai-providers`）——车道 E 重写了 codex 错误帧的 error 构造（friendlyMessage 优先、retryAfterMs 透传），但 unparseable-body 回退路径仍是 `message = raw`（完整响应体原文），随后 CodexApiError 的 error.message 也取该原文，extractStreamFailureParts 把它当 bodyMessage/detail，formatStreamFailureMessage 分类后拼进 errorMessage——与 R3-M25 同类的无界用户可见错误文本。
- **[note]** mapStopReason CONTINUATION case has no test; node_modules/lockfile genai version drift persists（`packages/ai/src/providers/google-shared.ts:380`，车道 `ai-providers`）——d48406ec1 新增的 FinishReason.CONTINUATION→"length" 映射没有任何测试（grep 全 test/ 无 CONTINUATION）；同时本地 node_modules 的 @google/genai 是 2.27.0 而 lockfile 钉 2.21.0——正是该提交自述的「本地重装导致 CI 红」的漂移至今仍在，Extract 写法保证了两种形状都能编译所以无运行时风险，但 2.21 环境下该 case 是死分支、2.27 环境下行为从未被钉住。
- **[note]** Throttled persistent-goal wake spends continuationsUsed at queue time with no repayment on post-admission cancel（`packages/coding-agent/src/core/agent-session.ts:5123`，车道 `agent-loop`）——c9937500b 引入的 _queueThrottledGoalContinuation 在队列时即 +1 continuationsUsed，注释称『counted at queue time, rolled back when admission rejects it』；poll 路径有 _goalContinuationHandout 偿还机制，这条队列路径没有对应物。
- **[low]** Extension-presence gate counts any directory entry (dotfiles)（`packages/coding-agent/src/main.ts:225`，车道 `rpc-acp-machine`）——cliExtensionsMayLoad 用 directoryHasEntries 判断 `<cwd>/.prime/agent/extensions` 与 `<agentDir>/extensions` 是否「可能有扩展」，只要有任意目录条目就算 true，包括 .DS_Store 等非扩展文件；这会把显式 `--model` 拼写错误的 preflight 从硬失败（exit 1）降级为 stderr 警告并静默回退默认模型。改动前只有 CLI `--extension` 标志才软化该门。
- **[low]** json mode ignores rlmChildFailures: failed-subagent run exits 0（`packages/coding-agent/src/modes/print-mode.ts:148`，车道 `rpc-acp-machine`）——R5-M25 的「子代理失败 → exit 1」修复只挂在 print-mode 的 `mode === "text"` 分支；`--mode json`（同样是机器/CI 面）下 rlmChildFailures 既不进退出码，也没有对应的 run_outmove 结构化终态事件——run_outcome 只在 rlm quiescence give-up（K3R-2）时发出。
- **[low]** commitExists fails open on git spawn error/timeout, contradicting the documented fail-closed policy（`scripts/pre-push-secret-scan.mjs:258`，车道 `scripts-docs`）——脚本头部声明「git errors fail closed, with one exception」，且 gitOut 一律 failClosed；但 commitExists（:258-260）只检查 `spawnSync(...).status === 0`，spawn 超时（timeout 15000）或 spawn 错误时 status 为 null，被当成「本地不可解析的 oid」走 :287 的静默跳过分支。
- **[low]** Gate's ambient-merge rule diverges from feed-data addEntry for origin-less records（`scripts/check-display-reconciliation.mjs:469`，车道 `scripts-docs`）——aggregateRecords 对同路径合并用 `if (record.ambient !== true) existing.ambient = false`（:469），即任何不带 ambient 标记的记录（edit 工具 diff、legacy 记录都没有 origin 字段）都会把合并项翻成 own；而它声称镜像的显示层 addEntry（packages/coding-agent/src/modes/interactive/components/feed-data.ts:423-425）只在 `entry.origin === "own"` 时置 own，origin 缺失的记录不动 existing.origin（ambient 保留）。
- **[note]** Patch walker misparses added lines whose content starts with '++ ' as file headers; '++ /dev/null' disables scanning for the rest of the file（`scripts/pre-push-secret-scan.mjs:218`，车道 `scripts-docs`）——scanPatchText 以行首 `+++ ` 识别文件头（:218）、`commit ` 识别提交头（:209），但不区分这些是 diff 元数据还是「新增内容行」：新增行内容以 `++ ` 开头时（diff 行 = `+++ …`）会被当成文件头，其中 `++ /dev/null` 使 file=null，该文件后续 hunk 的所有 added 行不再扫描。提交说明区（file=null 之前）以 `+++ `/`commit ` 开头的说明行同样会误置 file/commit。
- **[note]** One 'secret-scan: allow' marker exempts every pattern on that line; root CHANGELOG 0.11.20 carries stale mid-wave numbers and off-by-one-day date（`scripts/pre-push-secret-scan.mjs:155`，车道 `scripts-docs`）——scanLine 对含 `secret-scan: allow` 的行整体 return []（:155），一行放行所有命中，而不是只豁免 marker 所标注的那一处；另注：根 CHANGELOG.md 0.11.20 节与包内 CHANGELOG 存在三处小失真——日期写 2026-10-05（包内为 2026-10-04，release.mjs 取 UTC 日期）；:44 的「10664 行 / 18111 行」是 wave 中途快照，发布树实为 daemon-supervisor 10782 / agent-session 18477；「每运行上限」实为 decayPerResolvedCall（每次已解决调用的衰减），包内条目措辞才正确。
- **[low]** Item 5-1 unchanged: mid-run attach still anchors the run clock at the first message the client sees, snapshot carries no turn start time（`packages/coding-agent/src/modes/interactive/interactive-mode.ts:7206`，车道 `fixup-ledger`）——任务单五-1 的修法是「快照里带上本轮的开始时间」；52dd02da8 只修了 agents-view 子代理行的 endedAt 推导（durationMs），主会话 attach 的运行时长/步数没动。
- **[low]** Negative assertion after a fixed 900ms sleep instead of a state barrier（`packages/coding-agent/test/suite/agent-session-persistent-goal-budget.test.ts:159`，车道 `tests-quality`）——「Esc 后 wake 不得再触发」这条命题（真金 bug：Esc 后节流唤醒在主人背后继续烧 provider spend）的断言方式是固定 sleep 900ms（interval 400ms）后数 assistant 文本条数，违反仓规⑤「断言事件顺序/不发生用状态屏障，别 sleep 魔法数」。
- **[note]** Negative counting assertions behind fixed 300ms/1000ms settle sleeps（`packages/coding-agent/test/daemon-supervisor-warm-pool.test.ts:780`，车道 `tests-quality`）——两处「settle 之后再计数」用固定 300ms/1000ms 窗口：739 行「内存低于地板时 startup prebuild 不 spawn」与 780 行「3 并发 warm-up 上限 ≤3」都是负命题/上界命题，靠固定 sleep 而非负向状态屏障。
- **[note]** R5-M13 (long-URL wrap) is pinned only by a regex over the CSS text（`packages/coding-agent/test/export-html-template.test.ts:900`，车道 `tests-quality`）——「R5-M13 长 URL 不再整页横向滚动」的修复只有一条对 template.css 源文本的 overflow-wrap:anywhere 正则断言，是批次 A 八条里唯一没有行为级断言的（其余 12 条都过 MiniDOM 实跑 template.js）。
- **[low]** bare-ESC fallback swallows the following character, including newline（`packages/tui/src/utils.ts:1437`，车道 `merge-semantics`）——sanitizeRenderText 保留换行与制表符（display-text.ts 注释与函数契约），裸 ESC 兜底分支不会吞掉它声称保留的字符。
- **[low]** slim-page row measurement spends the armed one-shot reveal marker（`packages/coding-agent/src/modes/interactive/interactive-mode.ts:9930`，车道 `merge-semantics`）——loadEarlierTranscriptPage 的行数测量不产生副作用（lanes B/imode 把 scrollBy 换成 noteTranscriptPrepend 时引入的整树 render 测量）。

**第二波**：

- **[low]** User names matching _prime_agent_/_PrimeAgent prefixes vanish from snapshots with no skip notice（`prime-agent-runtime/src/rlm/repl.py:1317`，车道 `python-runtime`）——本波给 _snapshot_state 加了 _INTERNAL_NAME_PREFIXES = ("_prime_agent_", "_PrimeAgent", "_PRIME_AGENT_")，命中这些前缀的带下划线名字既不持久化也不进 skipped 报告（注释理由：bootstrap 每次启动都重建，报告是噪音）。
- **[note]** Subshell around a wrapper, e.g. ( bash -c 'git reset --hard' ), silently fails open on the Python face（`prime-agent-runtime/src/rlm/bash.py:1109`，车道 `python-runtime`）——wave-43/FORK_NOTES 声称「破坏性 git 守卫不再被包装壳绕过：bash -c / sh -c / eval 包裹的命令现在会剥开一层再判定」，并把剩余绕过面写进守卫注释（嵌套包裹、$(...) 命令替换、env/xargs 等执行器、here-doc、别名）。
- **[note]** Kernel arrival ledger and host undelivered-set use different baselines; id-less admissions would make the clamp erase live news（`prime-agent-runtime/src/rlm/repl.py:439`，车道 `python-runtime`）——送达清账本用 host 的「已承认未送达集合大小」clamp 内核的「到达推送台账」。两个计数基线不同：内核台账只降于 wait 排水，host 集合只降于送达/撤销；且内核台账按内核启动清零，host 集合跨内核重启存续。
- **[low]** refine() internal failure reporting bypasses the _emitRefineFailed shell (split-fidelity deviation)（`packages/coding-agent/src/core/refine-execution.ts:464`，车道 `refine-cluster`）——第十一刀提交说明声称「Conservation 20/20 byte-identical」且模块头注释声称 spy 拦截面完整保留；实际上拆分时把 refine() apply 失败路径的 this._emitRefineFailed(normalized, ...) 改成了直接调用模块函数 emitRefineFailed(host, normalized, ...)，绕过了类上的 _emitRefineFailed 壳。
- **[low]** Failed manual /refine row promises an automatic retry that never happens（`packages/coding-agent/src/modes/interactive/components/refinement-outcome-message.ts:97`，车道 `refine-cluster`）——失败/零编辑分支对无 source 的消息（createRefinementFailureMessage 生成的 failed:true receipt，不含 details.source）统一渲染「整理器这次没给出结果（reason），下一轮会再试」。
- **[low]** rev-46 claim 'an old client never receives it' is wrong for the rev-44/45 slim-client band（`packages/coding-agent/src/modes/daemon/daemon-protocol.ts:378`，车道 `wire-compat`）——rev-46 头注（daemon-protocol.ts:377-378）声称『the field is written only for a snapshot the supervisor windowed, which only happens for a client that declared slim_attach_transcript, so an old client never receives it』。但 slim_attach_transcript 是 rev-44 引入的能力：基线（09eae8d55，schema rev 45）的交互客户端就声明它（daemon-supervisor 基线 5942 行的能力表含 slim_attach）。因此 rev-44/45 的老客户端完全满足窗口化条件，会收到带 messagesOmitted 的 session_replaced——而老客户端的 session_replaced 处理（基线 daemon-agent-connection.ts）构造 latestSnapshot 时不映射该字段。
- **[note]** viewedActiveSessionIds rides an unchanged DAEMON_SCHEMA_ID: no digest slice covers the worker protocol file（`packages/coding-agent/src/modes/daemon/daemon-worker-protocol.ts:155`，车道 `wire-compat`）——本区间给 sweep_idle_sessions 命令加了 viewedActiveSessionIds 可选字段，并同步扩了 DAEMON_SCHEMA_REVISION 注释（46/47）；但 digest 的全部哈希切片（daemon-protocol.test.ts:43-80 的 18 个切片源）不含 daemon-worker-protocol.ts——worker 面命令形状的增删不动 DAEMON_SCHEMA_ID。
- **[note]** Comment claims extension_ui_request has a dedicated mode-layer handler; acp-mode drops it in this same default（`packages/coding-agent/src/modes/acp/acp-events.ts:267`，车道 `wire-compat`）——default 分支注释声称『heartbeats_changed, extension_error, and extension_ui_request have dedicated handlers in the mode layer』。acp-mode.ts 的订阅回调里只有 heartbeats_changed（:787）和 extension_error（:796）有专门分支；extension_ui_request 落进同一个非 session_event 转发，回到本函数 default 被丢弃（grep 全 acp/ 目录无 extension_ui_request 处理；有 handler 的是 rpc-mode.ts:144）。
- **[low]** corrupted-store entries inflate the small-corpus N on the TS face only（`packages/coding-agent/src/core/refinement/refinement.ts:2242`，车道 `harness-digest`）——refinement.ts loadHarnessState（620-637 行）不校验 title/content 类型，畸形条目留在 state 里；nearDuplicateMemoryMatches 的 corpus（refine-execution.ts:664 加载 → refinement.ts:2242 Object.values(records)）把它们计入 corpus.length，即决定 N<10 用 0.55 地板还是 0.40 带的 N，以及 idf 的 log(1+N/df) 的 N。Python harness.py:1224-1227 在加载时就丢弃这些条目，N 更小。
- **[low]** kernel harness-cap env snapshot is stale after mid-session settings changes（`packages/coding-agent/src/core/agent-session.ts:14519`，车道 `harness-digest`）——agent-session.ts:14503-14527 的 _rlmKernelEnv 只在 provisioner 构建时（系统提示重建/新建 kernel）求值一次；Python 写闸在写入时读 PRIME_AGENT_HARNESS_INDEX_MAX_BYTES / PATH_VOCABULARY / ENFORCE_INDEX_CAP（harness.py:70/112/116），但 env 值是 spawn 时快照。TS refine 路径却每笔读实时设置（refine-execution.ts:688-690）。
- **[note]** single-candidate gate float summation order is not reproducible across the two faces（`prime-agent-runtime/src/rlm/harness.py:2434`，车道 `harness-digest`）——Python _near_duplicate_memory_matches 的 candidate_norm 与 dot 对 frozenset 求和（harness.py:2434/2445，frozenset 迭代序随进程哈希随机化），TS nearDuplicateMemoryMatches 按 Set 插入序求和（refinement.ts:1323-1344）。批处理孪生 _similarity_pairs/harnessEntrySimilarityPairs 特意按码点排序 terms 来保证跨面浮点可复现（两侧 docstring 明说），单候选写闸却没有排序。
- **[note]** refinement-receipt skip can never suppress re-delivery after refine deletes (pre-window, moved verbatim)（`packages/coding-agent/src/core/harness-digest.ts:349`，车道 `harness-digest`）——harness-digest.ts:344-355 的「变化条目全部已被 refine 回执点名则跳过重投」对删除类 edit 永远不成立：recordRefinementOutcome（refine-execution.ts:588-595）为删除 edit 记录的是删除前版本号，而删除后的 fingerprint 不含该 key（fingerprint.get(key) 为 undefined），数字 !== undefined，every 失败，digest 照样重投。
- **[low]** Numeric settings getters lack the dirty-value guard lane G added for the crash class it claims closed（`packages/coding-agent/src/core/settings-manager.ts:3847`，车道 `ext-settings`）——lane G 只给 getSteeringMode/getFollowUpMode/getTheme/getTransport 四个枚举/字符串 getter 加了守卫；数值型 getter getEditorPaddingX（`this.settings.editorPaddingX ?? 0`）和 getAutocompleteMaxVisible（`?? 5`）原样透传任意 JSON 值，无 typeof 守卫、无迁移/扫描（migrateSettings 与 BOOLEAN_SWITCHES 都不碰数值字段）。
- **[low]** schedule list selector silently drops an agent literally named "list"（`packages/coding-agent/src/cli/daemon-command.ts:352`，车道 `cli-surface`）——runCron 的 list 路径用 `args.find((arg) => !arg.startsWith("-") && arg !== "list")` 挑选 agent 选择子，任何值为字面 "list" 的位置参数都被当作子命令词跳过。public 层 validateScheduleArgs 允许一个名为 "list" 的 agent（它只数非 flag 操作数）。
- **[note]** Dead "help" command arm connects to the daemon and exits 0 silently（`packages/coding-agent/src/cli/daemon-command.ts:80`，车道 `cli-surface`）——parseDaemonClientCommand 在 "--help"/"-h" 出现在任何子命令词之前时把 command 设为 "help"（daemon-command.ts:80），但 runDaemonClientCommand 的 switch（143-163 行）没有 "help" 分支：代码会先 client.connect() 连上 daemon，然后静默走完 finally、返回 void、退出码 0，什么都不打印。R6-M3 把 1825 行删到 556 行时保留了这条 --help 分支，却没有删掉或接上它的消费方。
- **[low]** leak-drain pop fires on pasted/forged nonzero answer bytes and on foreign non-leak entries（`packages/tui/src/probe-bus.ts:247`，车道 `tty-probe-bus`）——泄漏 pop 的判定只看「flags 非零 + verdict pending + 非 env-override」就写 POP，不区分应答来自真实泄漏还是伪造字节。stdin 的粘贴剥离路径（stdin-buffer，probe-bus-invariants.test.ts 明确测试「粘贴内的应答形状也会喂给 bus」）会把粘贴文本中字面出现的 kitty 应答形状路由进 handleSequence。
- **[low]** crash exit guard misses OSC 9;4 progress clear and DECSET 2031 disable that stop() performs（`packages/tui/src/terminal.ts:850`，车道 `tty-probe-bus`）——armExitGuard 的恢复序列覆盖 kitty 双栈、1049l、modifyOtherKeys、mouse、2027、bracketed-paste、raw，但不做 stop() 会做的两件事：清 OSC 9;4 进度指示、经 probeBus.dispose 复位 DECSET 2031。probe-bus.ts:380-383 明确以「dispose 写 2031l 使下一进程不继承未请求推送」为设计约束，崩溃路径上 dispose 不运行。
- **[note]** bus leak-pop is uncoordinated with the per-screen kitty marks (latent desync)（`packages/tui/src/probe-bus.ts:241`，车道 `tty-probe-bus`）——probe-bus 的 KITTY_KEYBOARD_POP 不感知 terminal.ts 的 kittyMainScreenPushOutstanding/kittyAltScreenPushOutstanding 模块 mark。若出现「新 ProbeBus 查询时活动屏上挂着本进程自己的 entry」的流程，pop 会把真实 entry 弹掉而 mark 仍为 true（记账与实栈失同步）。
- **[low]** preRenderCustomTools resolves custom-tool results globally (last write wins), outside the R2-M3 branch scoping（`packages/coding-agent/src/core/export-html/index.ts:212`，车道 `image-retention-export`）——R2-M3 的修复只把 template.js 的 findToolResult 换成按当前路径查 currentPathToolResults，但 renderEntryToNode 的 entryCache 按 entry.id 缓存整段渲染 HTML——工具结果是在首次渲染时通过 findToolResult 烘焙进这段 HTML 的，缓存永不过期。
- **[low]** entryCache freezes the first-rendered branch's tool result despite path-scoped findToolResult（`packages/coding-agent/src/core/export-html/template.js:1381`，车道 `image-retention-export`）——R2-M3 修复注释声称「Rebuilt on every navigateTo so a forked branch never shows another branch's result」，但 renderEntryToNode 对已渲染过的 entry 直接返回缓存克隆，currentPathToolResults 的重建只对尚未渲染过的 entry 生效。
- **[note]** Total cap no longer bounds non-snapshot artifact bytes (harness memory, pasted images) at all（`packages/coding-agent/src/core/retention/artifact-total-cap.ts:183`，车道 `image-retention-export`）——wave-40 把 sessionArtifactsMaxBytes 的口径从整树字节改为「仅本类可回收的 kernel-state.dill 字节」：受保护会话、harness 记忆、贴图、转录既不计入上限也不被本类回收，而年龄窗类只触达有删除记录的会话——从未显式删除的会话的非快照字节从此没有任何兜底。

**第三波**：

- **[note]** messages_pending mixes a wait-start delivered baseline with an answer-time arrival count（`packages/coding-agent/src/core/rlm-runtime.ts:608`，车道 `rlm-child-host`）——messages_pending = Math.max(1, arrivalCount(答案时刻) - deliveredCount(等待起点))，分子分母取自不同时刻；注释假设「delivery 只发生在回合边界」，一旦等待期间有已 admit 的消息被送进对话（deliveredCount 前移），数字即虚报。
- **[note]** Id-less agent-message admission permanently breaks the delivered-count wake baseline（`packages/coding-agent/src/core/agent-session.ts:7084`，车道 `rlm-child-host`）——wake 基线改为 deliveredCount() 后，不变式「每条 admission 都带 delivery id」成为硬前提：_noteAgentMessageAdmitted(admissionMessageId?) 里 id 为 undefined 时 arrivalCount++ 但 pending 集合永远收不到该 id，deliveredCount 永远追不上。
- **[low]** Self-reported terminal error writes no settle record; handoff lists the dead child as in-flight forever（`packages/coding-agent/src/core/rlm-child-terminal-outcome.ts:192`，车道 `compaction`）——in-range 提交 39c640e21 为 channel==="none" 的终态补 rlm_child_settled 记录，但只覆盖 facts.repliedDuringRun 为 true 的形态；子代理终态失败且已通过 agent_message 成功自报错误时（child._terminalErrorNoticeDelivered=true → classifyRlmChildTerminalOutcome 返回 {kind:"none", channel:"none", reason:"terminal error notice already delivered"}），既不写 settle 记录也不发 failure/terminal notice，而子代理的自报错误在父转录里是 agent_message 类 custom_message——session-handoff 的 applyEntry 只认 RLM_CHILD_FAILURE/RLM_CHILD_TERMINAL_NOTICE custom_message 与 rlm_child_settled custom entry 三种。
- **[note]** W29-B10 null (wall) verdict has no consumer: promised /model //new escalation never fires (pre-range, f02c77e68)（`packages/coding-agent/src/core/agent-session.ts:13627`，车道 `compaction`）——W29-B10（f02c77e68）给 over-threshold nothing-to-summarize skip 挂 emergencyShrink 评估，并注明 null=「最深切也切不动（单条超大条目即全部保留上下文）→ escalate to the user (/model, /new)」；但 agent-session.ts 唯一消费点 13627 是 truthiness 检查（`reason === "threshold" && error.emergencyShrink`），null 时既不计数也不收缩也不升级，compactionSkipMessage 的措辞仍是良性的「kept tail already covers the whole session」。
- **[note]** Compaction handoff never carries children admitted on an abandoned branch (pre-range W18-D composition gap)（`packages/coding-agent/src/core/compaction/session-handoff.ts:244`，车道 `compaction`）——分支导航时 branch-summarization 会为被离弃分支的仍在跑子代理渲染 <session-handoff>（slice-scoped，generation 1），但下一次压缩的台账重建只扫当前 path（buildSessionHandoff(pathEntries)），既不解析 branch summary 文本里的 handoff 块（parseSessionHandoff 只用于上一条 compaction entry），也无法到达旁支的 spawn 活动记录；settle/failure 终态通知随后到达新枝时 delete 一个从未加过的 key（no-op）。
- **[note]** Emergency shrink drops the superseded boundary's retained-tail user requests without collecting them (pre-range)（`packages/coding-agent/src/core/agent-session.ts:13344`，车道 `compaction`）——_runEmergencyContextShrink 采用被超越 compaction 的 details（supersededDetails）延续结构化台账，但不对待丢弃 span（上一边界保留尾 [spanStart, cut)）跑 buildUserRequestLedger——该区间的用户原话既不在被采用的旧台账里（旧台账只覆盖更早切片）、也不在 shrink 摘要里（shrink 只逐字携带 compaction/branch summary）。
- **[low]** SHELL_WRITE_COMMAND misses unzip/tar -x/curl -o style project-file writes（`packages/coding-agent/src/core/self-recovery.ts:307`，车道 `recovery-edge`）——SHELL_WRITE_COMMAND 覆盖 sed -i/perl -i/tee/mv/cp/rm/touch/patch/git apply 系/重定向，但不含 unzip、tar -x、gunzip、7z、curl -o、wget -O——这些都会向 cwd 写/覆盖项目文件；注释自己承认「cost of a missed one is a stale pass standing」，但解压和下载是模型真实高频的写文件途径。
- **[note]** recovery-turn suppression bypass is run-scoped, leaking onto gate-retry turns in the same run（`packages/coding-agent/src/core/agent-session.ts:5212`，车道 `recovery-edge`）——_isRecoveryTurnContinuation 用 `newMessages.some(custom PROVIDER_FAILURE_RECOVERY/EMPTY_RESPONSE_RECOVERY)` 判定整段 run；同一段 run 里若 provider 恢复消息之后又落下带 suppressAutonomousContinuation 的自主 gate 重试轮，该 gate 重试轮也被当作恢复轮豁免压制（FORK_NOTES 2026-10-08 记录的「恢复轮放行波及 gate 重试」回归的收窄是按消息类型收窄，不是按轮次收窄）。
- **[low]** fetched_at is a rounded placeholder that postdates the commit carrying it（`scripts/ci-floor-readings.json:12`，车道 `ci-workflows`）——source.fetched_at 写的是 "2026-10-08T00:00:00Z"，但携带这批读数的提交 52dd02da8 的 author/committer 时间均为 2026-10-07T17:11:06Z，且被引用的 run 37649262888 完成于 2026-10-07T16:28:02Z——该整点时间戳比提交本身晚约 7 小时，不可能是真实抓取时刻；上一版此处是精确时间戳（2026-09-18T12:20:18Z）。
- **[note]** shard 1 max_nothing_files pinned at the observed count with zero headroom under re-shard churn（`.github/workflows/ci.yml:199`，车道 `ci-workflows`）——shard 1/3 的 max_nothing_files=3 恰好等于实测值（3 个 kernel-heavy nothing-file），零余量；9 个带 kernel-heavy 标签但未被 test:ci 按名排除的文件在 vitest 分片间的归属随文件集变化而漂移（本次读数分布 3/0/6）。

## 五、销账清单（按波次/车道，共 436 条）

### 第一波

**session-core（19 条）**

- 换模型持久化顺序修复属实：buildSessionContext 的 openToolCallIds/heldModelChangeNotices 机制把落在未收齐工具批中的 model_change 合成提示挂到批收齐（最后一个 toolResult）后，路径中途的 user/assistant/branch_summary/持久结束也各有一致冲洗点；测试 test/session-manager/model-change-tool-batch.test.ts 真走 SessionManager.open → buildSessionContext → convertToLlm → transformMessages 全链，断言真实 toolResult 保留且无合成「No result provided」，crash 不闭批的第二例也钉了配对合成。
- 种子改 firstKeptEntryId 之前最后一个 model_change（session-manager.ts:1095-1109），seedBound 回退 compactionIdx 的 v1 迁移情形也覆盖；测试 3 钉住「通知夹在 summary 与新模型回答之间」的位置关系。
- 压缩/分支切换重建后 _pendingModelChangeMessages 清空（agent-session.ts:12507、18074），避免重建合成的通知在下次 flush 双落。
- 活跃路径换模型 deferral：isStreaming 时挂起、turn_end（非 error/abort）冲刷（agent-session.ts:5615、17710-17717），与重建路径语义一致。
- _estimateCurrentContextTokens 两个消费点（_resolveBackupModel:16379、_resolveNextFallbackModel:16476）都换过；全仓 grep 无残留的 `getContextUsage()?.tokens ?? 0` 窗口检查；旧代码 fallback 链用 `?? 0`、backup 无窗口检查，修后均按压缩后内容计价（对 f679e6d5a 前后逐行核对）。
- 超长分支 supersededByCompaction：_finishActiveRetryForCompactionHandoff（15756-15775）发 success:true+supersededByCompaction，agent_end 唯一调用点 6136 在 compactionWillRetry && _retryAttempt>0 时走它并 _resolveRetry（死锁修复保留）；interactive-mode.ts:7585 只在 success:false 才显示「重试失败 N 次后仍失败」——假失败上报消除，agent-connection/daemon 只透传事件无形状冲突。
- 额度暂停跨重启：restoreQuotaPark 恢复 parkCount/wakeRetries（793-805、829-838），构造期调用（agent-session.ts:2636）；timer takeover 在 resumeFromQuotaPark:517 盖 QUOTA_WAKE_TIMER_CANCEL_ORIGIN；resolveQuotaResumeJob 按 cancelledBy 区分接管与用户取消，completed 状态需 runCount>0 且无 lastError 才算 delivered（skipped/errored 的 dispatch 不算）；交互模式/测试（quota-park-wave40.test.ts 含 Esc 唤醒轮、重启接管、future-park 不取消）覆盖到位。
- Esc 只在唤醒轮/过期才取消（handleAbortedQuotaPark:563-573，waking || resumeAtMs<=Date.now()），并对 park 落 user-aborted 记录；_lastTurnAbortReason 在 recordStallWatchdogActivity 于 watchdog 门之前按 agent_start 无条件清（stall-watchdog-wiring.ts:719-726），requestAbort() 无 reason 的调用（abort()、daemon 7686 agent abort）不会残留旧值——1e86f5589 声称的「每轮无条件清」经代码核实属实（初看 agent-session.ts 只有赋值点，复位在 stall-watchdog-wiring.ts）。
- quota park 持久化失败不再吞 park：parkForQuotaReset/recoverQuotaParkWake/restore 重建/complete 各处 appendCustomEntry 全包 try/catch + _reportSessionPersistFailure（294-308、623-637、816-827），注释里「失败的 persist 不能吞掉 park」的失败场景与代码一致。
- 唤醒过早（时钟回拨）时 resumeFromQuotaPark 重挂 timer 而不是裸 return（506-516）；60s 时钟巡检 interval unref、park 消失自清（ensureQuotaParkClockCheck:386-407）。
- goal：满预算 resume --budget 延长 + 裸 resume 报错（_resumeGoal:3465-3498）；_startGoal 清节流钟与旧唤醒（3426-3431）；abortRetry 清唤醒（17350）；节流唤醒三重守卫（_queueThrottledGoalContinuation:5089-5113：quiescence/已排队 goal 上下文/暂停门）；persistent goal 无预算时补 10M 安全网（goals.ts normalizeGoalState），_goalContinuationBudgetExhausted 对 persistent 不可达、文案分母与实际 limit 一致。
- R3-M16：_endCompactionUnsuccessfully 先落 outcome（appendCustomEntryEntryWithRollback + message_start/end）再发 compaction_end（13258-13270），与声称的落盘顺序一致；live-turn-flow.customMessage 在 activeCompaction() 时 endCompaction 而非 addReplayCompaction（262-270），transferTo 幽灵注释与 turn-timeline activeCompaction/latestCompaction 语义核对一致；turn-box-live.test.ts 新例钉住（skipped 行 settledAt=消息时间戳）。
- R6-M7：compaction/branch summary 卡片展开视图过 stripMachineBlocks（compaction-summary-message.ts:16/58/101、branch-summary-message.ts:42），复制路径 copyFromSource 保留源文（含机器账本，符合「显示洗、存源」的口径）；convertToLlm 的 compactionSummary 仍带全量 summary 给模型/下一轮摘要器，未误伤。
- 压缩摘要失败路径：empty/length 结果按 SummarizationUnusableResultError 失败并进 summarizeWithInputLengthRetry 的收缩重试（compaction.ts:1776-1783、默认 isRetryable:1801-1806）；branch-summarization.ts 同款守卫且不再落「No summary generated」字面量；本地 abort 的 partial 文本原样返回由上层 signal.aborted 转「Compaction cancelled」，未误触发 unusable 判定。
- compaction 重试环（completeSummarizationRequest）：transient 失败按 providerRetryDelay 退避（参数核对 provider-retry.ts:178-190），permanent/lifecycle/faux-queue 立即失败，input-length/refusal 保持既有专用路径；retry 政策从 compact() 正确穿线（agent-session.ts:12547-12557 传 providerRetryPolicy(settingsManager)）。
- transform-messages：aborted 轮不再当 lastReplayableAssistant（152-162）、aborted 的 thinking 块丢弃（188-192）、abortedAssistantTrace 纯文本（99-110）、孤儿 toolResult 文本折入 trace（123-137、333-347）——与注释声称的三处行为全部对得上，无自相矛盾。
- session-handoff：decision_needed 通道整体移除（含旧 wire 解析的 legacy-only 兼容读）；RLM_CHILD_SETTLED settle 记录终结 replied 子代理的幽灵台账，写入方 _recordRlmChildSettled（agent-session.ts:5818-5828，sessionName 字段）与读取方 settledSessionName 同键；activity.name 精确键控修正 R5-M7/R6-M8（标签 fallback 保留旧记录兼容）。
- cron-jobs：cancel 带 origin 时才写 cancelledBy（841-851），isAgentCronJob 校验放行该字段（2697）——与 quota-park 的接管/用户取消区分口径一致。
- wave-40/fixup 蜂群已知开放欠账未重报：R3-M1..M4、R6-M2/M4、R2-M11 协议簇与 ~215 条 Low 按任务单跳过；本 lane 检查中未发现显示审计文档里已登记的重复项。

**abort-esc（16 条）**

- abortRetry 与 abort() 对齐已落地：重试在飞时设 _goalAbortInProgress 并按 requestAbort 同款字段暂停输入泵（agent-session.ts:17359-17365），更新重启栅栏字段不被误碰（注释与代码一致）
- Esc 在重试倒计时期间能从两条入口到达 abortRetry：interactive-mode.ts:10131（getRetryAttempt()>0 分支）与 daemon-mode.ts:6419（abort_retry 命令）；Esc-倒计时 goal 不误判 error 的三处 _goalAbortInProgress 消费（3520/3526、5598 agent_start、_finishGoalForTerminalAssistantMessage）均能自愈，无泄漏路径
- 中止丢弃未送达续跑+归还 goal 预算已落地：agent-session.ts:2882 安装 onUndeliveredMessages，source==="continuation" 且 poll signal 已中止时丢弃并 _repayUndeliveredGoalContinuation 归还 previousGoal/continuationsUsed/lastAt；goal 轮询在 signal.aborted 时于计数前返回空数组（5003-5005）；epoch 竞争路径同样回滚（5151-5158）；agent-loop 的 handBackUndelivered 时序（abort 同步、微任务先于任何新 run）核对无竞态
- 恢复轮只压自主续跑已收窄到位：suppressAutonomous 时仅 PROVIDER_FAILURE_RECOVERY/EMPTY_RESPONSE_RECOVERY 两类 custom 消息豁免以放行 _selfRecoveryContinuation（5160-5167 + _isRecoveryTurnContinuation），自主轮询本身仍被压住，不会重新打开自主循环；恢复轮的 recovery message 带 once-per-episode 上限，无自循环
- Esc 取消额度暂停判定已修：quota-park.ts:568 要求 park.waking===true 或 resumeAtMs<=now 才因 "user" 原因取消；_lastTurnAbortReason 在 stall-watchdog-wiring.ts:726-729 于 agent_start 无条件清空且在 if(!watchdog) return 之前，stall-watchdog-wiring.test.ts 钉住
- 恢复简报三态诚实：resume-briefing.ts queuedInputsReplayOfVerdict 把 verdict 映射为 replayed/skipped(stale|resume-loop)/not-replayed，daemon-mode.ts:2353-2360 bind 路径与 8781 行动路径共用同一 verdict，/resume 替换路径(2405)固定 not-replayed
- in-process 中止带 "user" 原因已修：in-process-agent-connection.ts:270/470/478 三处；daemon 的 abort/abort_and_send_queued/abort_and_clear_queue 也带（5729/5740/6154）；agent 起源的 abort（daemon-mode.ts:7684-7686）正确地不带 user；update-restart 级联改盖 "update_restart" 而非 "user"（agent-session.ts:11366-11380），不会误杀 parked 子会话
- wake ledger 计 accept 时间已落地：direct 路径在 accept guard 同步记 admission（agent-session.ts:8622，先于 ticket.delivered await）；suspended-pump/compaction-gate 两条 queue 路径在 queue 成功后记账；coalesce（accepted:false）不再计数（_queuePreparedPrompt 返回 .accepted，8610 分支不触发回调）；取消的 turn 在 _cancelSessionActions(3327) 与 clearQueue(10363) 结清 pending id；message_start 的 primary/reflowed 两条送达记账幂等（5643-5665）；admission/delivery id 口径一致（custom details.id 或 legacy 文本头解析）
- 双击 Esc 的 isSystemUserMessage 无误伤：SYSTEM_USER_PROMPT_PREFIXES 是默认自主续跑/worker-resume 提示的前 80 字符指纹，自定义续跑提示按 duty event 指纹精确匹配（tree-selector.ts:58-105）；普通用户消息需以同样 80 字符开头才会被误滤，实际不可达
- goal 节流钟/唤醒清理已落地：_startGoal 重置 _goalContinuationLastAt 并清唤醒（3430-3431），abortRetry/dispose 清唤醒（17350/6479），节流唤醒带 quiescence/K3R-11 去重/admission-pause/预算四重守卫（5086-5116），与 _maybeResumeGoalContinuationAfterRlmWork 镜像；/goal resume 满预算明确报错、--budget 延长（3478-3492）
- quota wake 重臂有界（QUOTA_WAKE_MAX_RETRIES，耗尽落 outcome 记录并撤 park），user-cancelled 记 user-aborted 条目；恢复轮抑制不影响 goal 轮询在前独立运行，无新自循环
- 加载更早记录偏移修复：interactive-mode.ts:9930-9942 改为拼接后实测行差（含 marker 移除）并走 noteTranscriptPrepend（tui fullscreen/tui 均有该方法），不再对 stale maxScroll 做 scrollBy
- CPU 豁免 60 分钟上限+60s 平滑窗在默认配置（toolLivenessExemption=true）下逻辑正确：silentMs 只在 moving 且未到顶时累计，noteStallCpuVouchActivity 在任何 agent 事件上重置（先于 watchdog 门），tool-timeout 谓词先采样 vouch 再让 stepSilentMs 读同一 cap；stall-vouch-collect-cpu.test.ts 的 30/31 分钟跳钟测试钉住上顶与产出重置
- requestAbort→abortRetry→sleep-catch 的事件顺序核对：取消时 auto_retry_end 只发一次（controller 与无 controller 两窗口互斥）；_markProviderAuthStaleForRetryFailure 无 auth 源时为 no-op，Esc 不会误标凭证过期
- abortAndSendQueued 的 forced-resume 语义与 abortRetry 暂停共存核对：requestAbort 先于 resumeQueuedWork，旧 run 的 agent_end（含 _handleAbortedQuotaPark/_finishGoalForTerminalAssistantMessage 对 abort 原因与 _goalAbortInProgress 的读取）先于新 run 的 agent_start 被处理，无顺序倒挂
- 新测试合规抽查：20261004-agent-message-wake-ledger.test.ts 走 acceptAgentMessagePrompt 公共入口驱动，_createKernelHostHandlers 的 cast 带 test-hygiene-allow 且理由具体；quota-park-wave40.test.ts 新增「未到唤醒轮的 Esc 不取消」用例走真实 session.prompt/requestAbort 故障注入，未 mock 被测段

**supervisor（22 条）**

- 暖池构建指纹（bf02cf8f4）：warmPoolBuildFingerprint（buildId+入口目录 *.js name/size/mtime）在 takeWarmSpare/ensureWarmSpare/sweepWarmPool/spawnWarmSpare 发布四点全部核对，rebuild 中途落地的 spare 在发布点（daemon-supervisor-warm-pool.ts:847）与认领点双重拒绝；无 fallback 目录、无认领旧 build 的路径。任务单第 7 条已闭环，与 FORK_NOTES 一致。
- 暖池 TTL/退出/环境指纹完整：takeWarmSpare 检查 expiresAt 与 child.exitCode/signalCode；TTL timer unref 并在 dispose/claim/childClosed 三路清理；env 指纹用 spare 自身 incarnation id 构建 candidate（daemon-supervisor-warm-pool.ts:599-610），per-incarnation 键相消后只剩 launchEnv/process.env 差异，DAEMON_WORKER_WARM_SPARE_ENV 被排除；miss 只留池不杀（env_mismatch 分支）。
- launchWorker 拒绝已删除目录（daemon-supervisor.ts:5148-5160）：isExistingDirectory 在 takeWarmSpare 之前抛 MissingSessionCwdError，注释明确『故意不回退到其他目录』，spawn cwd 与 guard 读的是同一个 createCommand.config.cwd；恢复路径（recoverWorker→launchWorker existing 分支、daemonOwnedCrashRecovery 的 durable command）同样过 guard，不会退回错误目录跑。
- 崩溃恢复读非 busy 排队记录（三·表）：worker 侧 recordWorkerRecoveryState（daemon-mode.ts:9840）每 checkpoint 记 queuedInputs（仅用户 turn、排除 slash/agent message）；supervisor 侧 recoverUncertainWorkerOperations（daemon-supervisor.ts:6477）filter busy||queuedInputs；markInterrupted wire 双向（daemon-catalog-process.ts:300/423）都带 queuedInputs+crashedAt；reaper hasUnconsumedRecoveryJournal 与 recovery_hold 解析记录（daemon-supervisor.ts:6586-6592）闭环——恢复后 journal 清 busy/queued，尸体可被 reap。链路完整。
- workerRecoveryResumeVerdict 三守卫（worker-recovery-resume.ts）：no-marker/stale(24h, 优先 details.crashedAt)/resume-loop(连续 2 次, replayedTexts 不误计 replay 的排队输入)；resume 路径先 replay queuedInputs（resumeIfIdle:false）再发 resume prompt（daemon-mode.ts:8810-8825），bind 路径与 briefing 共用同一 verdict（2347-2360），skip 不会谎称 replayed。
- failed worker 不再算覆盖定时唤醒：workerCoversPassiveScheduledJobs（daemon-supervisor.ts:2258-2266）区分 ownerClientId/recovery in-flight/armed re-adoption retry；daemon-crash-recovery-eviction 测试（eviction.test.ts:1586-1700）钉住 dormant-failed 覆盖、in-flight 覆盖、retry-armed 覆盖三种情形。
- cron cancel origin（wave 10-05 必修3）：AgentCronJob.cancelledBy 仅 quota_wake_timer 一种取值，isAgentCronJob 校验白名单（cron-jobs.ts:2697）；resolveQuotaResumeJob/restoreQuotaPark（quota-park.ts:464/785）区分 timer 接管与用户取消——重启后 park 不再被判成 user 取消；restoreQuotaWakeJob 对 future-scheduled 的 stamp 处理有注释依据。用户取消路径（/cron、daemon cron_cancel、session teardown）确实不落 origin。
- roster-sync 拆出（wave-51）零消费方丢失：supervisor 保留 19 个壳（roster/rosterEntriesForClient/writeRosterEntry/consumeWorkerRosterDelta/chainWorkerRosterApply/applyWorkerRosterSnapshot/syncRosterFromWorkerSummaries/markWorkerRosterEntries/flipWorkerRosterEntriesInactive/sweepRosterStaleness/clearRosterStaleness/handleRosterSubscribe/Unsubscribe/seedRosterLedger 等，daemon-supervisor.ts:6739-6804），帧路径 handleWorkerFrame→handleWorkerRosterDeltaFrame→host.consumeWorkerRosterDelta→壳→模块函数，与直驱路径同宿主；reaper/adoption 通过 class 壳调用 flipWorkerRosterEntriesInactive 保留 own-property 拦截。onRosterMutation/flushRosterUpdates/publishedIds 语义与拆前一致。
- reaper 簇拆出（10829→10664）：reapFailedWorkersOnce 逐候选物 (stopRequested/isWorkerStopping/recovery/deferredRecovery/retryTimers/scheduledJobs/attachedClient) 豁免、双证死亡（isProcessIdentityConfirmedDead）、degraded 只翻 roster 不删 descriptor、C17 归档日志、L9F-1 orphan journal 先 reap 后删——与拆前语义一致（对照 09eae8d55 版 hasUnconsumedRecoveryJournal 仅 busy→现补 queuedInputs，与恢复读取面同步）。
- vm_stat 缓存（warm-pool-memory.ts）：7.5s TTL、stale-while-revalidate 异步刷新、并发共享单个 refresh promise、失败也缓存 freemem 回退防每查一进程、linux/freemem 不缓存、parseVmStatAvailableBytes 对缺 page size/缺 free 返回 undefined 保守回退；purgeable 独立性是 C 层实证的声明（无法静态复核，声明与字段集一致）。
- daemon-owned 崩溃重启预算：daemonOwnedCrashRecovery（daemon-supervisor.ts:5752）10min 窗 3 次上限、窗内衰减、预算耗尽 parkedReason 落 lastError（刹车带恢复说明：client attach 或 retry_worker）；每 episode 只算一次（6355-6364）避免 journal 解析后重读翻转决策；预算计数在内存（跨 daemon 重启归零）——设计取舍。
- lastFailureAt ??= 保护：所有 park 路径（recoverWorker 三处、adoptOrRecoverWorker、最终 park）统一保留首次失败时间，reaper 衰减钟不被重试重置。
- warm pool 更新重启联动：prepare_update_restart drain(disable=false) 后失败路径重启 sweep timer（daemon-supervisor.ts:9739-9745）；shutdown/dispose drain(disable=true)；takeWarmSpare/ensureWarmSpare 在 shuttingDown/updateRestartPhase 双 gate，warming 等待后重读 gate；drain 取消 in-flight boot 避免 8s 探针阻塞退出。
- claim 健康检查回落冷启动（daemon-supervisor.ts:5412-5426）：仅 createRequest 未发出时回落，避免双 create；claim 失败/launch 前失败都有 reclaim 归因（claim_failed）。
- daemon-worker-protocol viewedActiveSessionIds：additive 可选字段，supervisor 采集 relayed viewer 集（2540-2546）、worker 侧 passivation 快照/判定消费（daemon-mode.ts:3665-3812），旧 worker 忽略等于旧行为——形状改动消费方齐。
- mark_interrupted wire 扩 queuedInputs/crashedAt：同一进程内协议（catalog 子进程），request 类型（daemon-catalog-process.ts:66/300/413）与 handler 双侧同步，旧字段不写时行为同旧。
- schedule-timestamp.ts（R3-M9）：新统一本地时区格式化 YYYY-MM-DD HH:mm，heartbeat-manager 与 interactive-mode 两消费方接线；agents-view 用相对倒计时（formatHeartbeatBadge）不受时区影响；无效字符串原样返回。
- handleModelChangeCommand 豁免 token：notice 帧先于响应帧在同一有序 worker 流上到达，relay 在 onFrame 同步路径读 modelChangeNoticeInitiators（9033/9122），注册窗口覆盖 notice 中继；无 token 的 notice（extension 驱动）不豁免任何人，行为符合设计。
- queueCatchup 触发日志 + deferredSessionPayloadsDropped 在 give-up 后清除（9509-9515）：修掉了 dark-until-detach 的坑，注释与行为一致。
- launchWorker 冷启动兜底 recursion 用原 command 重新走 storedCwd 重读与 guard，语义等价；warm claim 后 rootActiveSessionId/token/journal 全部继承 spare 自身 id，create 响应校验 summary.activeSessionId 一致。
- daemon-supervisor-ownership.ts 的 isProcessAlive→processIdExists（f7ad84c24）：zombie 计为存活、只推迟回收目录，注释如实声明该取舍，非语义损伤。
- scanPassiveScheduledJobs 的 pendingCancelRoots/ephemeral cancel、uncoveredRootFor 的祖先链 visited 防环、collectPassiveScheduledJobs 的 epoch CAS 发布与失效（含 shared scan detach）——多调用方（catalog/wake/recompute）一致性核对无误。

**markdown-gate（13 条）**

- 中央门状态机逐分支核对：CSI 参数扫描（[0-9;:?<=>!]）、中间字节（0x20-0x2f）、final 字母判定、OSC/DCS/APC/SOS/PM 串序列扫描、C0/C1/DEL 剥除、\n\t 保留——与 FORK_NOTES「中央门三处加固」一致，未发现误杀主题 SGR（含冒号子参数）或已终止 OSC8 的路径；\x1b[>…m 键盘模式与带中间字节的 CSI 整段丢弃，未终止 OSC8 整段剥不留半开
- 九个洗涤点逐一核对（html raw、default 块文本、applyTextWithNewlines、codespan、inlineMath、link href、renderCodeTextLines、renderMathBlock、窄表 fallback）：全部调用同一 sanitizeRenderText、洗后上色顺序正确，与 Text.render 同契约；heading/表格单元/blockquote 子块/def/checkbox/autolink 均经 renderInlineTokens 叶子覆盖
- 消费方核对：assistant/branch-summary/compaction/injected-prompt/custom/side-question/skill-invocation 及 thinking（assistant-message 内部 Markdown 块，getThinkingMarkdownTheme）全部 new Markdown(...)，随叶子洗涤自动覆盖，md 车道声称属实；display-text.ts（lane C）sanitizeRowText/sanitizeBlockText 契约一致
- md 车道 a24ea5ee7 单独 diff 复核：确实只加洗涤调用点，未动 lexCache/fence 密封结构（wrapPrevW/epoch/fenceRawClosed 等来自 8ec383a75/8cb21dcf9/72e6c67af 各自提交），「密封结构零改动」就本提交属实
- emphasisMask 与 node_modules/marked 18.0.14 实源码（marked.esm.js Lexer.inlineTokens 掩码）比对：anyPunctuation 定长替换、blockSkip 回调 (match,组1,组2) 参数序与 precode 组长度处理与 marked 自身逐字一致；未复制 reflink 预处理与 hook 掩码只会少掩（判定更保守，失效方向安全）；Lexer.rules.inline.gfm 在装 18.0.14 上存在
- 必修 2/必修 4 核对：computeLexCut mathOpen（i<=mathOpen 边界限定）、findSafeInlineCut 的 escape 数学定界符/strong-em-del 的 bracket 检查/任意 token raw 含 $$ 或 \[ 拒绝、trySplitLex 尾部 $$/\[ 每帧复检、hasDanglingBlockMathOpener 的 paragraph-contains 与他类-start 分层——与 FORK_NOTES 97/99 行声称一致
- wrapPrevW 整行 append 校验（8ec383a75）：renderFinalParagraphSealed/renderFinalCodeSealed/wrapSealGrowingLine 各清理点齐全，单行帧不再留 stale wrapSealedW；spliceInlineTokens 复用路径的 truncate+rebuild 在 prefix 数组身份校验下正确，不产陈旧 token
- H2 嵌套列表修复：/\^\s+\x1b\[36m/ 正则已删，改 kinds（text/nested/block）结构化判定；嵌套行原样、块内容 bullet 独行+缩进、无双 bullet；renderList/renderListItems/renderListItem 全调用点（含 list seal 的 contentWidth 与 renderToken 的 width）签名一致，无多车道合并残留错位
- H3/M11 列表内表格/引用/标题：else 分支走 renderToken(blockWidth=Math.max(1,width-(depth+1)*2)) 且先弹尾空行，表格不再整块蒸发
- latex 修复核对：\quad/\qquad 经 \uE000 sentinel 穿过空白塌缩（M12）、array/tabular/alignedat/tabularx 列格式与 [pos] 参数吞噬（R5-M4，OPTIONAL_POSITION/COLUMN_SPEC 名单与 TeX 语义相符）、\\[5pt] 行距参数在 ESCAPES 消费序下正确丢弃；ESCAPES["\\"]="\n" 核对无误
- H1/M1 核对：tui.ts 2360/2419/2642 三处 fullRender 循环均有 isImageLine 守卫 + clampOverwideLine + logClampedOverwideLines，行尾补 \x1b[0m\x1b]8;;\x07；clampOverwideLine 幂等、零宽后缀不影响列记账
- fenceRawClosed 闭合判定（末行、同 fence 字符、长度≥开栏、≤3 前导空格、尾随空格容忍）与 CommonMark 对齐，未闭合走安全方向；PI_MARKDOWN_FENCE_STREAM_HL=0 逃生门方向正确（FORK_NOTES 113 行声称相符）；fenceTailFitsHighlight 50 行/4096 字符上限确实钳住每帧高亮输入
- 测试质量抽查（只读未运行，按纪律不跑测试）：markdown-sanitize.test.ts 毒矩阵（表面×向量全组合）与 sanitize-render-text.test.ts 均驱动公开 render 入口断言输出，未 mock 被测逻辑；markdown-fence-stream-hl/markdown-pathological-corpus/markdown-line-seal/markdown-split-lex 测试文件在位

**input-editor（20 条）**

- CSI-u 码点上界修复核实：parseUnmodifiedKittyPrintableCodepoint 加 digits.length>7 与 <=0x10ffff 守卫，emitDataSequence 的 String.fromCodePoint 重放去重路径不再可能收到越界码点；w6 测试钉住 1114112、20 位超长参数、合法上界 1114111 三种输入
- Input 粘贴值洗涤核实：handlePaste 走 stripAnsi+\r 归一+\n→空格+控制字节/C1 剔除，render 在 width<=2 时 prompt.slice 钳宽；input.test.ts 旧断言（保留转义字节）已翻转为洗净口径，与 w6-stdin-input-lane.test 四组断言一致
- M3 meta-sends-escape 三处口径一致：stdin-buffer.ts 合并注释（\x1b\x1b[A=Alt+Up）、keys.ts:1298 递归 parseKey(slice(1)) 加 alt、docs/terminal-setup.md:112（读作和弦而非打断键）、keys.test.ts:633-636 与 stdin-buffer.test.ts:381 合并测试全部钉新口径；\x1b\x1b→ctrl+alt+[ 旧钉已从 keys.ts 与 keys.test.ts 删除，全仓 grep 无 ctrl+alt+[ 消费方，残留旧钉只在 coverage/ 陈旧产物里（非源码）
- 双 ESC 合并不吞鼠标/探测应答/粘贴开始：matchMetaPrefixedSequence 排除 < 参数、? 参数、M/m final；process() 的 BRACKETED_PASTE_START indexOf 检测先于 extractCompleteSequences，Escape+粘贴起点被正确切成 Escape+paste 模式（w6 测试钉住）
- 两个裸 ESC 仍拆成两次 Escape（合并仅在第二个 ESC 头部是 CSI/SS3 键序列时触发）；\x1b\x1b[1; 这类永不完成的 meta 序列 flush 时按测试钉的退化路径拆回 Escape+残片
- SS3 未知 final 消歧核实：\x1bOx（alt+shift+o 粘连后续键）拆成和弦+文本，\x1bO 后跟 ESC 再接 CSI 也先拆和弦再重解析；splitFlushedInput 对 \x1bP/\x1b]/\x1b_ 和弦拆分后 remainder 作为 tail 保留不丢
- 编辑器垂直移动越过折行 marker 的递归修复核实：moveToVisualLine 重入时传中间 targetVisualLine 为源并清 snappedFromCursorCol，坐标 frame 一致；lane-k-editor-markers.test 驱动 handleInput 公共入口断言 getCursor/getText/getExpandedText，无测试卫生问题
- jumpToChar 落点 snap+clamp 核实：snapCursorOffset 边界吸附 + Math.max(lineStartCol) 钳隐藏前缀；退格经 segment() 的原子 marker 合并整段删除，不再腐蚀 marker、提交不丢粘贴内容（测试含 marker 完整性断言）
- replay 三层容错核实：per-message try/catch + 「⚠ 一条损坏的会话记录已跳过」告警行；custom-message.ts 对 content 非字符串非数组的形状渲染 [malformed message] 行；sendCustomMessage 在 agent-session.ts:10175 用 customMessageShapeError 拒写，daemon handleAppendCustomMessage(daemon-mode.ts:5650) 走 sendCustomMessage，appendCustomMessageToExistingFile 的唯一外部调用方 daemon-catalog-process 只写常量字符串，无投毒面
- fabricatedTools（R5-M19）核实：aborted/error 分支建侧表，真实 toolResult 先查 pending 再查 fabricated 并替换；turn-timeline.ts:469-481 mergeStep 按 id set 替换 stepData，二次合并不产生重复行；循环尾部 turnOpen 只看 pendingTools，fabricated 残留不会让时钟永走
- 108 条存量 lastAssistantTextPreview 回退读核实：turn-timeline.ts:945 details.lastAssistantText ?? details.lastAssistantTextPreview，messages.ts:366 类型保留旧字段名，新字段优先
- addRowAboveClosingRow 的 blankAt 测量修复核实：TurnSummaryComponent.renderForMeasurement 保存/恢复 revealArmed，TurnStripComponent.render 无一次性状态（invalidate 注明 nothing cached），探测不再花掉 turn reveal 一次性标记
- probe-bus 非零 flags 泄漏弹出核实：pop（CSI < u）仅在 kittyKeyboard verdict=pending 且非 env-override 时发，自家 push 在 verdict 之后，不会误弹自家条目
- bulk CR 折叠对 ≥32 整段 bulk run 正确：CRLF/CR 折成 LF 后单序列，编辑器 insertBulkText→insertTextAtCursorInternal→normalizeText+split 分行正确（<32 的 forced-bulk 段除外，见 finding 1）
- select-list getFocusLine 与 editor autocomplete overlay 的 getFocusLine(+1 顶部空行偏移)、tui.ts aboveMarker 裁剪的 focusLine 随空行剥离递减——读 compositing 分支核实偏移一致
- expandable-custom-message getBlockCopyText 改 sourceCopyText 优先：skill-invocation/injected-prompt/refinement-outcome 各自 override sourceCopyText，无返回 undefined 的悬空调用
- legacy X10 鼠标释放映射（isLegacyMouseRelease + fullscreenLastMousePressButton）核实：SGR 释放自带键位不受影响（无 motion 的 button 3 仅来自 X10），滚轮（button>=64）不武装映射
- editor moveCursor/pageScroll/jumpToChar/placeCursorFromClick 的 cancelAutocomplete 补齐核实：caret 移动关闭补全列表，防 stale prefix 拼接错位
- conversation-components 大 diff 语义核对：git diff 逐块读，除容错边界+告警行+fabricatedTools+blankAt 外均为缩进重排，与 FORK_NOTES 车道 K「经 diff -w 核实」的声称一致
- w6/lane-k 两组新测试测试卫生核查：全部驱动 StdinBuffer.process / handleInput / buildConversationComponents / 真实 harness 公共入口，无私有成员探针、无 mock 掉被测逻辑

**fullscreen-timeline（23 条）**

- R2-M15 拖选扫过空白填充区：fullscreen.ts selectionFrameBounds 新增 contentEnd=lastHeaderHeight+max(0,lastTranscript.length-scrollTop)-1，frameLineToTranscriptLine 非钳制拖入填充区映射到 transcriptEnd（最近内容行），fullscreene.test.ts 有先红后绿用例（拖过 3 行内容+7 行填充仍复制 3 行）
- M2 含 tab 行选择/复制按上屏列对齐：highlightLine 与三处复制路径（getSelectedLines/copyTable 附近）统一先 normalizeTerminalOutput（tab→3 空格、泰 AM 分解），与上屏 applyLineResets 的规范化同源（tui.ts:1887 memoized），列位一致
- M4 浮层合成 kitty 占位行：compositeLineAt 从 isImageLine 放行为 isImageSequenceLine（序列行仍跳过），占位行正常合成；全覆盖时 id 入 occludedKittyPlaceholderIds 豁免删除、部分覆盖时补 SEGMENT_RESET 防占位色泄漏到下一行；compositeOverlays 头部 clear 与 doRender 2261 one-shot clear 双保险，顺序（composite→deleteChangedKittyImages）正确；fullscreen.test.ts 有 OVERLAY 落在占位行、hide 后占位恢复的用例
- R3-M7 autocomplete 裁剪保选中项：Component.getFocusLine 可选增量 + SelectList.getFocusLine（selectedIndex-startIndex，空表置 0）+ editor 覆盖组件 +1 补顶部空行；compositeOverlays 裁剪分支 start=max(0,focus-(markerRow-1)) 保证焦点行始终在窗内，前导空行 trim 时 focusLine 同步递减、负值有钳制
- R3-M15 块导航提示不落框顶空行：isVisibleRow 改为 rowWords（去 gutter+去样式+去零宽标记）判空，turn-box 的 firstVisible 经 rowShowsContent 用同一谓词（含 raw 分支），decorateFocusedBlock 的 firstContent 也是它——三处同口径；窄行 HINT_CUT_MIN_COLS 让位分支宽度算术核对无误（截断+hint 合计 width-1）
- R3-M17 心跳提示词：interactive-mode:7253 createLegacyHeartbeatPromptMessage 在 turnFlow.userMessage 之前判定并以 wokenBy 传入；userMessage 在 steer 分支之后、starterKind=user/ lane.reset 之前走 customMessage wake 通道——不 reset 子代理 lane、不清 settle 账本、不标 startedByUser；与 replay 的 renderReplayUserPrompt ownerOpened:false 对称（agent_start 先于 user message_start，事件序核对过 agent-loop.ts:744）
- R3-M18 Esc 后 live/replay 分组：runCutMidTask 排除 stubStopped（agentEnd 时 stepStop.endsTurn 入账、finish 时落 timeline.stopped、resumeTurn/第二次 finish 清账）；typed prompt 走事件路径时 agent_start 先到并清 lastStop，steered 判定不受残留 toolUse 影响；turn-box-live.test.ts:1149 用真实 abort stub 驱动（faux bash 工具被 abort），非 mock 被测段
- R3-M19 块复制源文：copyFromSource（tidyBlock 仅去两端空行）+ 四类卡片（skill/compaction/injected-prompt/refinement）override sourceCopyText/getBlockCopyText；renderedCopyText 兜底也保缩进段间空行；block-copy-source.test.ts 驱动公开 getBlockCopyText 断言缩进与 \n\n 存活
- R5-M17 steer 可展开：buildTimelineView steer 事件挂 stepsByGroup 的 BoxRow（detail=wrapped 全文）+ firstParagraph 的 more 标记；renderTurnBox steerDetail 分支接 right=eventRight(0,open)+onClick+展开 detail 行；textRoom 减去 STEER_LABEL 宽度；ui-block-render.test.ts 长插话闭合行 …▸、点开全文逐行拼回完整原文
- R5-M19 fabricatedTools 侧表：aborted/error 回复的 toolCall 先做「已中断」再入侧表，真结果到达时 updateResult 覆盖且从 orphan 判定中排除（不再是待重配对孤儿），setStepStatus/mergeStep 以真结果重落；与 live 路径 toolEnd 同口径
- R3-M20 bash Elapsed interval dispose：BashRenderState.dispose 存 clearInterval，renderResult 最终帧调用；丢弃路径核对——session swap 走 resetPendingToolState（interactive-mode:4172 逐个 component.dispose→rendererState.dispose）；chat 重建/cap 收缩虽 chatContainer.clear() 不 dispose，但 liveChatCapBlocked（isBashRunning 由 bash_start/bash_end 连接事件驱动 + isAgentStreaming + activeBashComponent + compaction）在 bash 运行期一律挡住重建，运行中的组件必在 pendingTools 内；未发现漏接 dispose 的丢弃路径
- R3-M16 压缩幻行：live-turn-flow customMessage 262 分支改为 activeCompaction→endCompaction（先落盘的 outcome 结清 live 行），else if !latestCompaction 才 addReplayCompaction——避免 replay 行永久遮蔽 activeCompaction
- R5-M16/R6-M7 死代码与清洗：BoxRow.sub/window 字段、steady/steadyPrefix/steadyLine 全系删除且全仓无残留引用；running-card.ts/turn-footnote.ts 零引用；compaction/branch 摘要卡片展示层过 stripMachineBlocks（复制仍取源文）
- R3-M8 heartbeat-manager formatTimestamp 收敛到共享 formatScheduleTimestamp（本地时区口径统一）
- lane settle 账本：TimelineLaneTracker.settle/takeSettles/restore 的闭环核对——restore 先回填 settled 再跑 returns 循环（顺序注释与实现一致）；comeBack 的 selfSettled 消费（真 report 覆盖自家过期 settle、他者 settle 计入本轮 back/tally，tally 三键齐全）；upsertSubagent 的 wasRunning 单次翻转防重复 settle，durationMs 换算 endedAt 有有限性守卫；cancelled 只从 fromReconcile 路径入账（live 通知自持显示）
- tui overwide 收敛：clampOverwideLine（补 \x1b[0m+OSC8 终止符防背景/链接泄漏到下行）统一替换三处 sliceByColumn；pi-crash.log 落盘 1s 节流（OVERWIDE_CRASH_LOG_THROTTLE_MS）防每帧全量写盘；preserve/full/diff 三条渲染路径同钳制
- legacy X10 鼠标释放映射：isLegacyMouseRelease 仅命中 button==3 且无 motion 位（X10 release），映射回 fullscreenLastMousePressButton；press 记录侧有 !motion/!=NONE/<64（排除滚轮与拖动）守卫；SGR 释放自带 button 不会被误映射
- Text 中央门 sanitizeRenderText：CSI 参数扫描对 ?/>/!/中间字节判非 SGR 整吞、OSC/DCS/APC/SOS/PM 到终止符、未终止整吞、OSC8 存活、C0/DEL/C1 剥除（\n\t 保留交各调用方宽度处理）——逐分支走查无死循环/半开序列
- 回填 prepend：noteTranscriptPrepend 延迟到 compose 消费（避免 scrollBy 撞旧 maxScroll）、unseenLines 扣除 prepended、scrollBy 与 prepend 叠加的净位移算术正确（+12-3）；inline 模式 no-op；fullscreen.test.ts 三用例（暂停窗口保行、following 贴底、同帧上下增长分别计数）
- renderForMeasurement/blankAt 双实现（live-turn-flow.ts:114 与 conversation-components.ts:1202）：测量渲染不再花掉 turn reveal 单发标记——TurnSummaryComponent.renderForMeasurement 用 try/finally 还原 revealArmed；measureBlockRows 对 QuietTurnSummary（extends TurnSummaryComponent）instanceof 判定成立
- decorateFocusedBlock 选中背景压制 INLINE_BG_SET/RESET 重述 selectionOpen：paintedEmpty 尾部 49m 剥离推导正确，g 正则 replace 无 lastIndex 残留问题
- conversation-components 逐消息 try/catch：坏形状跳过+可见告警行（lane K 声称），customMessageShapeError 写入侧拒收与 sendCustomMessage 咽喉（另一 lane，本 lane 只核了消费端容错分支存在）
- skill/compaction/injected-prompt/refinement 卡片 sourceCopyText 挂接与 expandable-custom-message 的 ?? renderedCopyText 兜底链核对无误

**wash-faces（26 条）**

- display-text.ts 洗涤器本体：sanitizeRowText=sanitizeRenderText+stripAnsi+空白塌缩、sanitizeBlockText 保留换行/制表符转四空格，操作幂等，双洗不损坏内容（bash 头先经 descriptor 再洗一次实测无害）
- code-preview.ts descriptor 唯一读取点：previewBashCommand/previewPythonCode/previewHeredoc 所有出口（含 cat-write/node/python 转发/apply_patch）都过 descriptor()=截断(sanitizeRowText(redactNoise))，四个消费面 bash formatBashCall:801、step-label:502/517/579、timeline-rows:695 全走 descriptor；/tree 虽自建文本不走 descriptor 但同点已 sanitizeRowText，两路均洗（仅 code-preview.ts 注释措辞与实际机制不符，非缺陷）
- bash.ts 调用头（R4-M6/R3-M21）：preview.text 已洗、空 preview 回退补 redactNoise+sanitizeRowText，头行经 new Text 中央门上屏，输出体 bashPreviewTail 也走 Text
- agents-view 标题/回答预览/recap/spawn code（R4-M4）：getAgentsViewSessionTitle、createAnswerRow、agentsViewRowRecap、buildSpawnCodeRows 均在状态层洗，answerPreview 洗空不再画空 ↳ 行，styleRowTitle 加粗判定按洗后名字，finalizeRenderedLine 有换行兜底塌缩
- subtitle 死字段删除：全仓 grep 无残留 row.subtitle/getSessionSubtitle 引用，AgentsViewRowText 备忘录同步改
- R2-M12 状态标签门：改为 row.statusLabel.length>0，getSessionStatusLabel 内 statusLabel/workerState/sessionActions label+kind 全接洗；新测试经 renderRow 端到端断言 stalled/running tools/starting 可见
- R2-M13 ←键：onAgentsBack 对非空草稿返回 false，custom-editor.ts:255 契约核实为落穿到编辑器光标移动，双分支（非空保留+空草稿解除）有测试
- R2-M14 删除确认：clearDeleteConfirmation 同时清 pendingDeleteAgent+pendingKillSubagent，toggleReplyTarget:1980 门读 pendingDeleteAgent；超时回落与按键取消两路均有先红测试
- R2-M19 选中背景：INLINE_BG_SET/RESET 正则恰好覆盖 theme 全部背景码（bgAnsi 只产 48;5/48;2/49），selectionOpen 从 paint("") 推导兼容 bg() 与 surface 混色两路径；agents-view 选中行的 \x1b[0m 拆分重涂为另一面且无内联背景码冲突
- R2-M20 ambient 过滤：formatTotalChangeSummary 与 interactive-mode:5016 回顾条两处都经 isSessionOwnedChange 过滤，quiet 侧 turn-strip 审计确认本就拆开
- R2-M7 formatTable：预算数学逐条核过（dropOrder 循环、表头下限 while 收敛、truncateToWidth(pad=true) 截断后补位、formatCell 上色在截断后宽度恒等）；daemon-list/daemon-ps 都传 getStdoutWidth()，非 TTY 回退 legacy 无界表（管道场景合理）；极窄终端表头下限和超宽为代码注释明示的取舍（见 note）
- R4-M16 被拒模型公告：落盘前 sanitizeRowText 后再 200 字截断；旧 journal 读侧经 createProviderFallbackNoticeRow 的 new Text 中央门补洗（核实 conversation-components.ts:587），attach 重放面安全
- R4-M14 recap：写侧 verdict（sanitizeRowText(result.summary)）与 turnError（terminalTurnError 洗 errorMessage）两入口、读侧 getLatestAgentStatus 补洗、recapLineText 收口洗两源且 isErrorRecap 判定在洗后，appendAgentStatus 仅 summarizer 两处调用均已覆盖
- normalizeErrorDetails（补剥 BEL/NUL/DEL/C1）：\r 先折行再洗、stripAnsi 收尾；ipython stdout/stderr/result/backgroundOutput/fallback text 五路全部经它（本切片逐行核对 renderOutput）
- ipython cell 顶行 label/errorName（含 errorEname legacy 字段）与展开代码（R4-M7）均洗，kernel 重置/重启提示为固定文案
- stall 诊断渲染：formatStallSummary/formatStallExplanation/formatStallDiagnosticsLines 三段 toolName/toolCallId 全洗（202/251/86），其余插值为 daemon 内部枚举与数字，exemption reasons 经 EXCUSE_TEXT 固定文案映射不直通
- dock strip（R5-M30/M31）：chipName/chipTag 洗、洗空落「子代理」/丢弃 tag；stall marker 通道整体删除后全仓无 setStallMarkers/formatSubagentStallMarker/SubagentStallMarker 残留
- tree-selector（R4-M5）：message 用户/AI 内容、errorMessage、toolName、bash command、ipython code、customType+content、branch summary、model/thinking/serviceTier/label/session_info title、label 12+ 个文本源逐个核对全洗，bash/ipython 50 字截断按洗后长度
- duty-log agent_status 摘要（R3-M24）：读侧 sanitizeRowText 塌多行+剥转义，测试钉死（duty-log.test.ts:369）；incidents 行文案为固定串不经模型文本
- 会话名边界：daemon handleRename 与 spawn 侧 sanitizeSessionName 剥 C0/C1/DEL（含 ESC），CLI list 表 name 列与 terminal title 面安全
- turn-box/turn-activity/timeline-rows 的错误行与步骤词：stepWords/stepStatus/verbSummary/preformatted/sanitizeDisplayText 各自接洗，timeline cmd 行 outputDetail 经 preformatted 洗
- R3-M23 被拒 refinement 原因首行截断：refinement-outcome-message.ts 核实 split("\n")[0] 已接
- agents-view statusMessage 通道：setStatusMessage/3801 formatError/330 notices 三路全过 formatAgentsViewStatusLine
- image_unread 公告（agent-session:16839）：cause 来自 describeProviderFailureCause 固定文案模板（仅数字插值），无需洗；其余 _emitFallbackNotice 位点插值为模型注册表固定 id/provider 与设置侧 reference
- stall-watchdog-wiring.ts:535 describeStepForRecovery 的 preview 空回退 code.split("\n")[0] 未洗，但核实该字段只进 self-recovery journal（模型面）与 duty-log incidents 计数（固定文案），无终端显示消费方
- agents-view-mode 新测试用 Reflect.get/set 探针：确认为该测试文件 09eae8d55 之前的既有风格（invoke 助手与 59 处 Reflect 调用存量），非本波引入，test-hygiene 门通过

**ai-providers（16 条）**

- anthropic SSE 解析失败路径：message 携带 truncateRawPayload(sse.data)（2000 字符封顶 + …），info.raw 存 sse.raw.join 也有界，requestId/kind 保留；anthropic-sse-parse-error-truncation 测试用假 SSE 驱动真实 streamAnthropic，断言 <3000 且 TAILMARKER 不在 message、raw 有界且保留 garbage- 前缀——与 FORK_NOTES「坏帧有界化（完整帧留 info.raw）」在该路径一致
- codex resets_at→retryAfterMs 链路端到端核实：parseErrorResponse L1556-1559（epoch 秒→ms、Math.max(0,…)）→ CodexApiError.retryAfterMs L421 → extractStreamFailureParts 读 err.retryAfterMs（>=0 才保留）→ recordStreamFailure 落进 provider_stream_failure details → provider-retry.ts providerStreamFailureRetryAfterMs L114 消费（providerRetryDelay 超帽走 exceeds-cap 返回）且 quota-park.ts L183 resetMs 取同一字段做 park；friendlyMessage 保留进 detail：plan_type.toLowerCase() 拼进 (pro plan)、test 断言 RAW-UPSTREAM-MARKER 不出现——FORK_NOTES 声称与代码相符
- oauth 六处响应体序列化点逐个数过：anthropic postJson(L190)/token-exchange invalid-JSON(L224)/refresh invalid-JSON(L378)、copilot fetchJson(L91)、codex exchange(L139)/refresh(L185) 全部过 truncateRawPayload(redactSecrets(...))；xai.ts 从不打印 body（requestFailure 注释明说不打）；其余消息构造点（describeTokenFields、device-flow 的 error/error_description 结构化字段、State mismatch）不含原始 body——没有第七处漏网
- oauth 去 stack：anthropic formatErrorDetails 删除 error.stack 分支；codex/copilot 本就没有 stack 路径；oauth-error-redaction 测试断言不含 stack= 与 \n\s+at 帧
- openai-completions refusal 判定不会误伤正常空响应：refusalText 仅在 typeof delta.refusal === "string" 且非空时累积，正常空响应（无 refusal delta）不触发；kind "refusal" 在 provider-retry.ts isPermanentProviderFailureKind L138 为永久（不再烧重试梯子），stopReasonRaw="refusal" 被 compaction.ts L1588 消费（压缩 refusal 换模型 fallback 链现在也能接住 openai-completions 的 refusal）；refusal detail 过 truncateRawPayload 有界；测试用真 HTTP 假服务器驱动真实 provider 代码
- codex WS 传输分类（818c21612）：CodexProtocolError 改为 transport 级会走 SSE 回退，但回退仅在 startWebSocketOutputOnFirstVisibleEvent 尚未点火（无可见输出）时发生，中途协议错误不会重发导致输出重复；StreamFailureError/CodexApiError 归为 nonTransport 后不再走 provider_transport_failure 诊断+recordWebSocketFailure 毒化会话 WS 簿记（openai-codex-stream 新测试断言 content filter 后 websocketFailures=0、第三 turn 仍走 WS、fetch 未被调用）；networkError: nonTransport ? undefined : true 语义与 request-budget.ts 注释一致；stale-continuation chain reset（canChainReset）在 nonTransport throw 之前求值，仍生效；codex-websocket-transport-classification 274 行测试覆盖三向（close 回退/坏帧回退/error 帧不回退不误标）
- Bedrock $metadata.httpStatusCode（497553d6d/R6-M1）：status > statusCode > $metadata.httpStatusCode 三级回退，显式 status 优先（测试钉死 409 覆盖 500）；状态缺失时回退 err.name/message 文本分类（ThrottlingException→rate_limit 等），4xx 不再进 15 分钟 transient 等待——与 w6-av 变更条目相符
- google/google-vertex promptFeedback 从 safety→invalid_request 重分类：invalid_request 在 isPermanentProviderFailureKind 与 providerWaitClass 两处都判 permanent（会话 never-resend 门生效）；coding-agent 无残留 "safety" kind 消费方；输出侧 finishReason SAFETY 仍走 streamFailureFromStopReason→classify("safety")，口径与测试注释一致（重发可能换答案的输出侧块保留 safety）
- transform-messages 中止 turn 处理（wave-40）：aborted turn 不再计入 lastReplayableAssistantIndex、其 thinking 在 flatMap 阶段先丢弃（否则会经 most-recent 扁平成文本混进 abort trace）——abortedAssistantTrace 本就只保留 text blocks+trace，语义自洽；stopReason 是必填类型，undefined 边缘仅存在于历史数据；两条测试（drops aborted partial thinking / skips trailing aborted turn）钉死新行为，与 CHANGELOG 0.11.20 条目相符
- anthropic unrouted 块事件去重（c9937500b）：appendAssistantMessageDiagnostic 按引用存入 output.diagnostics，后续 count/lastIndex 原地推进会被持久化；每 event shape 一条诊断+一次 log.warn 是有意收口；测试断言 count:3/lastIndex:4 且总共 2 条
- codex service tier（resolveCodexServiceTier）：仅当响应回 default 且请求为 flex/priority 时信任请求档，其余响应优先/缺省回退请求；resolver 只接在 codex 的 processStream/processWebSocketStream 两处，openai-responses/azure 保持 response-wins 默认；openai-codex-stream 测试方向翻转（按请求档计费）与上游 pi-mono #3307 口径一致
- genai FinishReason.CONTINUATION（d48406ec1）："CONTINUATION" as Extract<FinishReason,"CONTINUATION"> 在 2.21（enum、死分支）与 2.27（成员存在）两种类型形状下都可编译；lockfile 确实钉 2.21（本地 node_modules 2.27 漂移是环境态非代码缺陷）；映射到 "length"（按请求 token 上限截断）语义合理
- mistral 可选 opentelemetry peers 标 external：packages/coding-agent/scripts/bundle.mjs L59-62 四个 @opentelemetry/* 在 external 列表并带注释（可选 peer、仅显式开遥测才可达）——与 e10d96bab 提交声称相符
- zai glm-5.1 入表：models.generated 两条 glm-5.1（opencode/zai）中 zai 条目 baseUrl 为 api.z.ai/api/paas/v4（按量端点）且带 zai compat/zaiToolStream；generate-models.ts 的 ZAI_PAY_AS_YOU_GO_ONLY_MODELS 泛化与旧 flashx 特例语义等价（coding-plan 先推、去重先赢不变）；prime-inference-models 测试 0.99→0.72 价格钉与提交说明一致
- 变更账目对齐：packages/ai/.changes/ 留 lane-e-providers.md（f83f9a9e8）与 w6-av.md（497553d6d）两个未发布 fragment，CHANGELOG 0.11.20 节只折入发布前的提交（wave-40/818c/a767/发布），发布后提交的 fragment 待下次发布——无谎账；FORK_NOTES「新测试 4 文件 10 例」实数 1+2+5+2=10 相符
- 测试卫生五条过一遍：新测试只假造传输层（fake SSE Response/假 HTTP 服务器/MockWebSocket/vi.stubGlobal fetch），被测逻辑（解析/分类/重试判定）未被替换；无固定 sleep（全部 await .result() 状态屏障）；PI_CODING_AGENT_DIR 等环境变量进程内设置并恢复；密钥语料带 secret-scan: allow 同行标注；无私有成员探针（as unknown as Anthropic 是给公开 client 选项塞假实现，非探针）

**agent-loop（14 条）**

- 工具名熔断 (tool name, model) 归属：recordToolNotFound、prepareToolCall 的衰减、runLoop 回合关闭的重置三处都经 toolNotFoundBreakerModelKey(assistantMessage) 按 (provider\nmodel) 记账，fallback 健康 stint 不会洗掉主模型的计数（读了 agent-loop.ts:934-956/1996-2035/2405-2414 及 tool-not-found-breaker.test.ts 的 fallback-stint、switch-back-trips 用例，测试用 faux provider 真驱动、未 mock 被测逻辑）
- 恢复轮状态机逐条核对：每次触发（数值上限或恢复轮内再犯）授一轮、recovery.pending 防同批重复授、per-run 预算默认 3（recoveriesUsed 不退款）、recoveryTurns:0/1 的回退行为、干净回合关闭只清回合模型自己的 per-name 账——与 tool-not-found-breaker.test.ts 的 C1/C2/recoveryTurns 0 与 1/干净关闭/预算不退款用例逐一对上
- tools.notFoundBreaker 五键设置链完整：settings-manager.ts 的 KNOWN_SETTINGS_KEYS(tools)、KNOWN_NESTED_SETTINGS_KEYS(tools.notFoundBreaker 五键)、BOOLEAN_SWITCHES(tools.notFoundBreaker.enabled)、getToolNotFoundBreakerSettings() → AgentSession._refreshAgentLoopRuntimeSettings()（构造 2647 + 输入泵 9976 + 压缩后续 12729 + 延迟重试 16329 四个 dispatch 点全覆盖）→ agent.toolNotFoundBreaker → agent-loop config（agent.ts:555）；provider-fallback.test.ts 钉了传递；docs/settings.md 六行与代码一致（含『before every run』的说法与四个刷新点相符）
- 熔断触发消息分类：stopReason error + stopReasonRaw tool_not_found_breaker_tripped + agent_lifecycle_failure 诊断 → _isRetryableError 判不可重试（agent-session.ts:15491），不会再把同一上下文重喂给出错模型
- rlm 送达账本配对：直投路径在 _admitSessionInput 接受后同步调 agentMessageAdmissionAccepted（agent-session.ts:8618，先于任何 delivery await）；suspended-pump/compaction-gate 两个队列分支在 await queueAgentMessagePrompt 之后记账——按微任务 FIFO 排序，投递所需的 agent.prompt/emit 链每一步 await 都排在该记账微任务之后，message_start 不可能抢在前面，无幻影风险
- 送达/清理/取消三处结清兜底齐全：message_start 主记录与 reflow 前缀记录都调 _noteAgentMessageDelivered（5654/5662），clearQueuedAgentMessages 路径（10363）、_cancelSessionActions 取消路径（3327）都补结清；coalesce 重复投递不计 arrival（第二次 followUpQueueKey 相同的投递被拒、preflight false，_noteAgentMessageAdmitted 不跑）；回归测试 20261004-agent-message-wake-ledger.test.ts 两用例（直投配对、coalesce 不计）均为先红后绿的真驱动
- wake_on_message 基线从『上次早答的 arrival 数』换成 deliveredCount()：rlm-collect-message-wake.test.ts 覆盖已送达不算新闻、同轮未送达算新闻、只报未送达 delta、非阻塞读与无 wake 源的旧行为；Math.max(1, pendingNow-since) 在单调计数下冗余但无害；session 侧 messageWake 三方法（arrivalCount/deliveredCount/waitForArrival）接线在 agent-session.ts:14293
- onUndeliveredMessages：packages/agent/src/agent.ts:573-583 默认把 continuation 放回 followUpQueue（steering 回 steeringQueue）；AgentSession 覆写在 agent-session.ts:2894-2901——只在 source===continuation 且 _continuationPollSignal 已中止时丢弃并经 _goalContinuationHandout 偿还预算，steering 原路 steer、followUp 原路回队；偿还用引用相等匹配 handout.messages，不误偿别的批次
- goal continuation 在 signal.aborted 时先返回空数组（agent-session.ts:4994-4996），continuationsUsed 递增在其后，中止不消耗预算；_getContinuationMessages 里 arrivalEpoch 竞争时回滚 handout 与 goal 快照（5149-5155），不双计
- 取消路径新增的 primaryDeliveryRecord(action) 调用不会抛：所有 turn payload 都经 _createPreparedTurnAction 构造，records 恒含 primary 记录（agent-session.ts:9167-9171，全库唯一构造点）
- stream stall/EOF 的 kind:unknown 修复真实：createStalledAssistantMessage 无 Retry-After 分支与 createStreamEofAssistantMessage 都补 provider_stream_failure(kind unknown)，providerWaitClass 把 unknown 归 transient（provider-retry.ts:289），备用模型/等待链可介入；agent-loop-exit-semantics.test.ts 与 stream-stall.test.ts 的新用例为真驱动且断言诊断形状
- goal 节流唤醒三重守卫（FORK_NOTES 声称）：_queueThrottledGoalContinuation 里未结算 RLM 工作、已有排队 goal 续跑（K3R-11）、admission pause/暂停泵三处都在（agent-session.ts:5088-5116）；/goal resume --budget 可延长已耗尽预算、bare resume 明确报错、_startGoal 重置 _goalContinuationLastAt 并清 wake（REVIEW-FIXUP 第 92 行三项全落地）；abortRetry parity 设 _goalAbortInProgress 并暂停输入泵（f679e6d5a）
- rlm 会话名 sanitizeSessionName（剥 C0/DEL/C1）接入 normalizeRequestedRlmSubagentSessionName，防 OSC/BEL/换行注入终端标题
- settings-manager 畸形值守卫（getSteeringMode/getFollowUpMode/getTheme/getTransport）与 onExternalSettingsReload 监听/不可解析分支也通知，均与声明相符

**rpc-acp-machine（21 条）**

- R5-M25 尾部扫描改写核过：headless-completion.ts 扫描对 compaction outcome 与非 slash 的 custom 通知一律跳过、user/slash-request 停扫、slash-result 可作 primary；rlmChildFailures 倒序 unshift 保持时间序；print-mode text 分支消费（stderr + exit 1），print-mode.test.ts 428/441 两条真跑 runPrintMode 断言退出码与 stderr 文案，未 mock 被测选择逻辑。
- R5-M23 ACP turnFailure 把 aborted 计为失败核过：acp-mode.ts:456 stopReason error/aborted 都算失败；客户端取消在 promptAndWait 前后共五处 abort.signal.aborted 检查（889-944），取消不会经 turnFailure 误报；stall watchdog 击杀现在报 prime-agent turn failed 而非正常 end_turn。
- R5-M24 compaction_end 失败字段核过：acp-events.ts compaction_end 分支带 aborted/willRetry/errorMessage/errorSeverity，AgentConnectionSessionEvent 的 compaction_end 类型定义里这四个字段都存在（types.ts:752 附近）。
- R5-M26 ipython 图片 1:1 转发核过：ipythonImageBlocks 从 result.content 取 type:image 且 data/mimeType 均为 string 的块；工具端 ipython.ts:1181 确实组装 [text, ...imageBlocks]；text 仍走 textContent，meta attachments 只报解码字节数/路径不内联 payload；tool_call_update 的 content 条目形状与既有 text 条目同构（{type:"content",content:...}）。
- R5-M22 连接级事件映射核过：acpUpdatesForConnectionEvent 覆盖 quota_park_status/connection_status/session_status/session_replaced/session_resynced/closed，字段名与 AgentConnectionEvent 联合类型（types.ts:873-921）逐一吻合；heartbeats_changed/extension_error 在 catch-all 之前有专门分支不会双发；side_question_event 映射返回 []（注释说明 daemon 只把 side question 路由给发起客户端）；RPC 端 closed→shutdown+return，其余 outputConnectionEvent 逐字转发且复用 promptResponsePending 缓冲通道；docs/rpc.md:809 与 docs/acp.md:86 已同步新事件。
- 「纯 additive wire 改动、协议版本未动」的说法核过：连接级事件是客户端 AgentConnectionEvent 的既有成员（范围内 types.ts 只加了 supportsMessagesWindow 文档注释），daemon 线上未新增事件形状；DAEMON_SCHEMA_REVISION 45→47 的两跳（rev46 session_replaced.messagesOmitted、rev47 set_model/cycle_model.changeNoticeToken）均在 daemon-protocol.ts 注释里写明兼容路径与 capability 门（slim_attach_transcript 才窗口化、旧 worker 忽略新字段降级），属推迟协议簇之外的正当 additive 改动。
- meta 输出分流判定核过：print 是纯 boolean flag（args.ts:332），-p/--mode json|rpc|acp|daemon 全部计入 explicitMachineMode；--mode text 不计入但 resolveAppMode 对 text 不产生独占 stdout 的机器流（TTY→interactive，非 TTY→text print 与隐式同形，且 --version/--help 先退出不污染流）；--version/--help 走 metaWrite，隐式 print（stdin 非 TTY）经 writeRawStdout 绕过 takeover 可被 $( ) 捕获；--mode json --help 与 -p -h 的 stdout 清洁契约在 public-command 的 prompt-intent flag 分支（-p/--mode 列表）先行放行后由 main 分流兜住。
- list-models 与 --export 输出通道修复核过：list-models.ts 全部 console.log→writeRawStdout（调用点 main.ts:2245 在 takeover 之后，旧写法在隐式 print 下会落 stderr，此为真修复）；export 分支同样改 writeRawStdout。
- R6-M9 fork 拒绝会话内显示核过：handleUpdateCommand 在 spawn 子进程之前本地判 detectForkInstall，拒绝文案 showUpdateNoticeBlock（warning 口吻）会话内显示，不再走 alt-screen gap + exit 1 误读为失败；bare /update 的 extensions 半仍运行（buildExtensionsOnlyUpdateArgs 保 --extension/--daemon-socket 的值对、丢 --self 与 self 位置参数、兜底补 --extensions）；--allow-official 保留子进程 override 路径。
- R6-M10 /update --help 刹车+恢复核过：help 分支 spawn 子进程 stdio pipe 捕获（handlePublicCommand 先于 takeover，子进程 console.log 落真 stdout，捕获成立），不 relaunch、不重启 daemon；SELF_UPDATE_HELP_EXIT_CODE=76 只在 SELF_UPDATE_INTERACTIVE_CHILD_ENV=1 的 update 子命令 help 分支设置（package-manager-cli.ts:1652-1664），父端 selfUpdateHelpShown 跳过 relaunch，与 75（not attempted）互不混淆；interactive-update-relaunch.test.ts 517 行伪造 status:76、541 行伪造 status:2 故障注入验证刹车不吞真失败。
- R6-M11 manifest sha256 核过：readManifestArtifactSha256 先读顶层 pin 再按 data.tarball 的 basename（剥 query/fragment）匹配 tarballs[].file；pack 脚本里 manifest 的 tarball 字段与 primaryTarball 查找同源于 artifactFiles.get("coding-agent")（都是 npmTarballName 产出的同名文件），basename 匹配恒成立；primaryTarball 必被找到，sha256:undefined 会被 JSON.stringify 丢弃不会写出假 pin；version-check.test.ts:108 / package-command-paths.test.ts:449 / r36-self-update.test.ts:83 用真实 pack 形状钉死。
- R6-M3 daemon 死子命令核过：REMOVED_COMMAND_NAMES=app/daemon/install/manage/remove/uninstall，公共命令 list/stop/rename/send/schedule/status/shutdown/attach 均不在其中；DAEMON_CLIENT_COMMANDS={list,kill,rename,send,cron} 恰好覆盖 public-command 合成的全部内部调用（stop→kill、schedule→cron、status→runPs、shutdown→runShutdownSelection）；直接 prime-agent daemon … 在 public-command 层先被拒，parseDaemonClientCommand 对未知子命令抛错文案指向 help。
- public-command 边界组合核过：redirectFlagLeadingCommand 对 -- 分隔符/prompt-intent flag（-p/--mode/-c/-r/--fork）/同词多次出现/--version 全部放弃重定向；normalizeLeadingDaemonSocketOption 不把 socket 对搬到 -- 之后（消息内容区）；rejectBareCommandTypo 对 help/version 与 prompt-intent flag 放行；update 案例先提升 --daemon-socket 值对再 parseBooleanOptions，socket 不再被当旧包名 target。
- validateScheduleArgs 的 scope flag 值对跳过逻辑核过（list/cancel 两条路径），fail() 设 exitCode=1 且调用方返回 HANDLED，不会静默成功。
- formatTable 预算路径核过：truncateToWidth(pad=true) 会补空格到列宽，列对齐保持；每轮至少缩 1 列宽（floor 钳制仍保证递减）不会死循环；dropOrder 只删在册列，未列列永不删；piped stdout（width undefined）退回无界旧表。
- startup Ctrl+C watcher 核过：engageEarlyRawMode 不 resume stdin 的窗口由 'data' 监听自然转 flowing 补上，非 0x03 字节缓存后 pause+unshift 归还给首个消费者；promptConfirm/promptForMissingSessionCwd/deprecation gate/TUI run/agents view 各消费点都先 releaseStartupCtrlC；startup-ctrl-c.test.ts 覆盖。
- recoverDaemonUnlessShutdownTombstoned 刹车+恢复核过：tombstone 由 deliberate shutdown 写（daemon-ps.ts:2073/daemon-supervisor.ts:10690），fresh start（非 worker relaunch 的 ownership acquire）rm 掉 tombstone 恢复自愈（daemon-supervisor-ownership.ts:766-771），错误信息明说窗口会在 daemon 再启动后重连。
- R6-H1 attach TOCTOU 回落核过：isUnknownActiveSessionError 谓词导出，list→attach 窗口的 Unknown active session 回落 create 路径不再崩栈。
- early daemon kick 的 --flag=value 展开核过：shouldStartDaemonEarly/earlyDaemonLaunchTarget 都先过 expandEqualsFormOptions（幂等，二次展开无害），--mode=daemon 与 --daemon-socket=/x 的 equals 形态不再逃过早期判定。
- restoreSavedSessionModel 补 await 是正确修复（model-resolver.ts:682 本就是 async，旧代码没 await 会把 Promise 当结果用）。
- preflightCliModelDiagnostics 的 extensionsMayLoad 降级路径与 cliExtensionsMayLoad 的四个来源（--extension/settings extensions/settings packages/两个 extensions 目录）核过，settings 来源的软化是正当的（扩展确实可能注册静态目录外的模型）；测试 model-cli-preflight.test.ts 覆盖空目录/有扩展文件两态。

**scripts-docs（14 条）**

- pre-push-secret-scan 豁免门槛：PRIME_AGENT_ALLOW_SECRET_PUSH 仅 ==="1" 生效（"true" 不放行，check-secret-scan.mjs 有判例），放行时打 warning；hook 三段(v-tag→mirror→scan)共用一次 stdin 快照，snapshot 在每条失败路径都 rm。
- pre-push-secret-scan 漂移守卫：用与 check-secret-scan.mjs 相同的 entry 正则实测提取两表，share-secret-detectors.ts 与 scanner 各 23 条，label/regex/flags/valueGroup 全等，无 missing/diverged/extra；表为单行条目时漂移守卫可提取（条目改多行会红，失败方向正确）。
- secret-scan marker 同行语义与 FORK_NOTES 记载一致（marker 在上一行注释不算）；commit message 里 marker 不生效（有 self-test 判例）；message/diff 双通道、merge 提交无 patch（用例覆盖）、只扫 added 行、binary/--no-textconv 处理、256MB fail-closed、unresolvable-local-oid 跳过、malformed stdin fail-closed 均有 check-secret-scan 实仓用例覆盖。
- check-node-test-coverage 引号感知修正（wave-50）：正则逐段推演——引号分支吃掉属性值里的字面 >、懒惰量词保 /> 自闭合优先、引号字符只能走引号分支（分解唯一，无指数回溯）、<testsuites 根元素不误匹配（\b）、跨行 testcase 仍由 [\s\S]*? 覆盖；自控判例 literalGtNamesReport 已加。
- pack-prime-agent-release 顶层 sha256 + tarballs[] 双钉：primaryTarball 按 artifactFiles.get("coding-agent") 取（与 tarball 字段同指），JSON.stringify 丢弃 undefined 时读取方回落 tarballs[]；version-check.ts readManifestArtifactSha256 先顶层后 basename 匹配 tarballs[]，两形态均有 version-check.test.ts 判例；SHA256SUMS 与 tarballs[] 同源。
- lane J 文档钉测试仍活着且钉点与 HEAD 代码一致：custom<T> 工厂签名/execute(toolCallId,params,signal,onUpdate,ctx) 顺序（types.ts）、tui.md 的 daemon-session resolves undefined、footer.ts 即将压缩 marker 与 settings.md 文案一致、theme.ts colors 块实数 55 必填/74 可选且 74 个 token 全部出现在 themes.md、stdin-buffer "Merge when the second ESC heads a key" 注释在、terminal-setup.md metaSendsEscape/Option-as-Meta 措辞在、examples/extensions 5 个文件与 sdk 6 个示例全部指向 ~/.prime/agent 无 ~/.pi 残留；wave-6 的 M3 现实翻转（3b57591a4）同步改了 terminal-setup.md 和 lane-j D7 钉点，无再次失真；cc01e9101 对 types.ts 仅改注释，未破坏钉点。
- README Escape 语义与 interactive-mode.ts 现实一致（Escape | Interrupt active work + 草稿 stash Ctrl+S 恢复、双 Esc /tree 只在空闲空输入）；README footer 描述与 footer.telemetry 默认 on 一致。
- 根 CHANGELOG 0.11.20 抽查：zai-org/GLM-5.1 确在 models.generated.ts；kimi-k3 input 0.99→0.72、cacheRead 0.8→0.7 与生成文件 diff 一致；/goal resume --budget 在 agent-session.ts:3581 实存；tools.notFoundBreaker 五子键在 settings-manager.ts:1352 实存（包内 CHANGELOG 措辞正确）。
- CHANGELOG 碎片账目：发布提交 8bae351ca 时 .changes/ 只剩 README（预发布碎片已折叠删除）；HEAD 现存全部碎片均为发布后新增（lane/w6 波次），碎片格式为无小节头的过去式单行 bullet，符合 AGENTS.md。
- test.sh AZURE/新增 unset 清单与 env-api-keys.ts envMap 逐键对账：23 个 provider 键（含 AZURE_OPENAI_API_KEY、四个 XIAOMI_TOKEN_PLAN、DEEPSEEK/MOONSHOT/CLOUDFLARE/GOOGLE_CLOUD/PRIME）全部覆盖，无遗漏键。
- test-hygiene 门 *Internals 命名信号扩充：SHADOW_ALIAS_NAME_RE 只在 as unknown as 投射时触发、baseline 冻结存量只缩不涨、正控/负控（ForeignInternals 跨文件、SessionInternal 无 s 后缀）齐全，误拦面可控。
- check-browser-smoke external ["@opentelemetry/*"]：esbuild 0.28.2 支持 external 通配，语义为可选观测依赖不进浏览器 bundle，正确。
- ci-floor-readings.json 更新自真实 run 37649262888（head f4e701186），log_line 与数字字段一致，why_this_run 说明成立；地板只做下限。
- display-audit 两份审计文档与 fix-backlog 的已知开放欠账未在本 lane 重报；协议簇 R3-M1..M4、R6-M2/M4、R2-M11 延后项未触碰。

**fixup-ledger（27 条）**

- 一-1 换模型持久化顺序：buildSessionContext 持有批中 model_change 提示到 toolResults 后+种子改 firstKeptEntryId 前（session-manager.ts，09eae8d55..HEAD 内仅 session-name 无关改动）；test/session-manager/model-change-tool-batch.test.ts 走 SessionManager.open→buildSessionContext→convertToLlm→transformMessages 全重建路径，断言真实结果保留、无 'No result provided' 合成、批不闭合时提示不丢、种子边界——修好且有会红的测试。
- 一-2 fallback 用量：_estimateCurrentContextTokens（agent-session.ts:12965-12980）被 _resolveNextFallbackModel(16476) 与备用模型路径(16379) 共用，压缩后 stale anchor 弃用按内容计价；超长分支走 _finishActiveRetryForCompactionHandoff(15756) 发 success:true+supersededByCompaction 而非假失败；agent-session-retry-compaction-deadlock.test.ts 两用例分别钉住「tokens:null 按 0 放行小窗」与「stale 900k anchor 拒掉合身备用」两个半边，retry-events.test.ts:750 断言事件形状。
- 一-3 熔断核心与设置：每次触发授恢复轮、每运行 recoveryTurns(默认 3) 上限（agent-loop.ts:2482-2512、resolveToolNotFoundBreaker 2457-2479）；tools.notFoundBreaker 五子键经 settings-manager.ts:736/3400 与 _refreshAgentLoopRuntimeSettings(2926) 热刷新进 Agent；docs/settings.md 已更新；814c26869 再修 per-(name,model) 计数衰减乒乓；tool-not-found-breaker.test.ts、settings-manager.test.ts、w11c 回归齐。goal 半条除外（见 findings 2）。
- 二-4 恢复轮：_isRecoveryTurnContinuation（agent-session.ts:5208-5215）让 provider/empty recovery 轮的自我恢复穿过 suppressAutonomousContinuation；agent-session-retry-events.test.ts:475「a provider-failure recovery turn still gets its self-recovery continue」用 faux harness 断言 callCount=5（恢复轮后自我续跑发生）。
- 二-5 abortRetry parity：abortRetry 设 _goalAbortInProgress+暂停输入泵（agent-session.ts:17346-17366）；agent-session-goal.test.ts:972 断言 Esc 后 goal 不变 error、排队工作不被跑。
- 二-6 未送达续跑：agent.onUndeliveredMessages 装在 2882；_handBackUndeliveredMessages(2894) 在 poll signal 已中止时丢弃并经 _repayUndeliveredGoalContinuation(2904-2912) 归还 goal 预算与节流钟；agent-session-goal.test.ts:1007 断言丢弃+还款。
- 二-7 暖池构建指纹：warmPoolBuildFingerprint（daemon-supervisor-warm-pool.ts:212-241）= runtime buildId + 入口目录 *.js 名/大小/mtime 哈希，take/ensure/sweep 三处校验（720/847/963）；rmSync 窗口降级为仅 buildId 且必然不匹配旧指纹；daemon-supervisor-warm-pool.test.ts +114。
- 新-1 Esc 取消额度暂停：handleAbortedQuotaPark（quota-park.ts:563-580）只在 park.waking 或 resumeAtMs 已到时取消并落 user-aborted entry；_lastTurnAbortReason 改在 agent_start 无条件清空且位于 watchdog gate 之前（stall-watchdog-wiring.ts:721-732）；quota-park-wave40.test.ts 新用例「Esc while parked for hours does not cancel the pending wake」。
- 新-3 goal 满预算：_resumeGoal（agent-session.ts:3465-3498）--budget 延长、裸 resume 报明确错误；_startGoal 重置 _goalContinuationLastAt(3430)；abortRetry 清 _clearGoalContinuationWake(17350)；agent-session-persistent-goal-budget.test.ts 新文件。
- 新-4 定时任务目录被删：pauseJob（cron-jobs.ts:885-910）+ wake 路径 pausePassiveScheduledJobsForMissingCwd（daemon-supervisor.ts:2414-2439）记 lastError 停重试；launchWorker 拒绝 MissingSessionCwdError；c2bdbae92 补 pause-on-missing-cwd 覆盖。
- 新-5 CPU 豁免：STALL_CPU_EVIDENCE_CAP_MS=60min 无输出总上限 + STALL_CPU_VOUCH_WINDOW_MS=60s 平滑窗（stall-watchdog-wiring.ts:191/200，sampleStallCpuVouch 230-279）；观测活动重置 silentMs（noteStallCpuVouchActivity 727）；stall-vouch-collect-cpu.test.ts 四个新用例覆盖低量化步进不闪烁、超上限停止豁免、输出重置、烧 CPU 步骤被中断。
- 新-7 collect 基线：deliveredCount 基线（rlm-runtime.ts:556-566）+ kernel 侧 agent_message_delivered notify 清账（repl.py:439-445、2036-2055，带无效 count 降级）；rlm-collect-message-wake.test.ts +96、test_repl_message_wake.py +72、kernel-protocol-negotiation.test.ts 双向降级用例。
- 新-10 vm_stat：warm-pool-memory.ts 达尔文分支缓存 7.5s、过期后异步刷新（仅首探同步）、失败也缓存 freemem 回退避免每检一进程；purgeable 与 inactive 独立性有 C 级验证记载；daemon-warm-pool-memory.test.ts +38。
- 新-8/9 假「重试失败」与压缩后估算偏大：随一-2 的 _finishActiveRetryForCompactionHandoff 与共用估算器一并消失（20261004-compaction-handoff-retry-count.test.ts 亦断言 supersededByCompaction）。
- 三-1 完成检查：finish_gate 文案加「检查只在覆盖的代码未改时保持通过」（messages.ts:518）；SHELL_WRITE_COMMAND（self-recovery.ts:307-308）认 sed/perl -i、tee/mv/cp/rm/touch、git apply/checkout/restore 等、> >> 重定向（排除 2>&1/>=）；changeTrackingIncomplete 的 cell 结果不算已验证（self-recovery.ts:460-472）；self-recovery.test.ts +124 与 suite/self-recovery.test.ts +53。
- 三-2 压缩交接子代理：replied 结束（channel none）的子代理落 transcript-only rlm_child_settled 记录（rlm-child-terminal.ts / rlm-child-terminal-outcome.ts / session-handoff.ts +31），input-classification 登记 internal_continuation 修发现门；rlm-child-settled-marker.test.ts +239、compaction-session-handoff.test.ts +75。
- 三-3 近重复提醒措辞：harness.py:2468-2470 与 refinement.ts:1371 均改为「先确认是不是同一件事：是才 update（会整条覆盖），不是就保持新建」；refinement-near-duplicate.test.ts 与 test_harness_near_duplicate.py 同步。
- 三-4 in-process 中止 user 原因：in-process-agent-connection.ts 270/470/478 三处 requestAbort/abortAndSendQueued 带 {reason:"user"}；agent-connection-in-process.test.ts +110。
- 三-5 崩溃排队消息：崩溃恢复 journal 过滤改为 record.busy || (queuedInputs 非空)（0c76de141，daemon-supervisor.ts），idle/Esc 暂停/额度暂停的排队输入进 marker 重放；daemon-supervisor-crash-queued-inputs.test.ts 含负控（空队列不落 marker）。
- 三-6 加载更早记录偏移：最后一页移除标记行时 noteTranscriptPrepend(pageHeight - markerHeight)（interactive-mode.ts:9671-9682 附近，4aaf9fa76）；tree-selector.test.ts +56 与 interactive-mode-chat-cap.test.ts +44。
- 新-2 恢复简报：queuedInputsReplayOfVerdict 三态 replayed/skipped(stale|resume-loop)/not-replayed（resume-briefing.ts:45-53、112-120），两界面共用 verdict；b2990a17c。
- 较低-1 failed worker 覆盖定时唤醒：workerCoversPassiveScheduledJobs（daemon-supervisor.ts:2253-2259）failed 且无 owner/recovery/deferredRecovery/adoption-retry 时不覆盖；daemon-supervisor-eviction.test.ts +182。
- 较低-2 续跑防循环：中断时间读 marker details.crashedAt（worker-recovery-resume.ts workerRecoveryInterruptedAtMs，回退 marker 写入时间）解决停机后发现的老崩溃显新；countConsecutiveAutoResumes 按同样 24h 窗口衰减。
- 五-2 双击 Esc：SYSTEM_USER_PROMPT_PREFIXES 加 WORKER_RECOVERY_RESUME_PROMPT 指纹 + duty-event 里自定义续跑 prompt 指纹（tree-selector.ts:47-70、continuationPromptFingerprints）；双 Esc 不再预选系统续跑。
- 五-3 --model 预检：扩展可能加载（settings/包/项目/全局）时预检降为警告不拒绝（main.ts preflightCliModelDiagnostics，9d49b65e9）；model-cli-preflight.test.ts +92；4685-daemon-client-modes.test.ts 相应放宽。
- 五-4 影子类型门禁：check-test-private-probes.mjs 识别 as unknown as XInternals 后缀影子类型（scripts:31-33/288），基线重冻结 524 只缩不增。
- 验收面：每个修复带 changelog fragment（packages/*/.changes/review-fixup-*.md 多枚）；FORK_NOTES 在推送前更新（920febbcc）；f679e6d5a 提交说明如实披露 agent-session.ts 混入 lane D delivered-ledger hunks（核实 39c640e21 同含这些符号，披露属实）；无人值守条目故障注入（断网=overloaded_error 脚本、额度=quotaFailure 脚本、Esc=abortRetry/abort、进程重启=worker kill 测试）在 suite 各文件均有对应形态。

**tests-quality（21 条）**

- export-html-template.test.ts（新 903 行）：真跑 src/core/export-html/template.js（new Function + 自建 MiniDOM），R2-M1/R2-M2/R2-M3/R5-M9/M10/M11/M12 断言全部落在渲染输出上；marked/hljs 只是平台替身，被测洗涤/惰性构建/分支解析逻辑未被 mock，回退实现必红
- suite/quota-park-wave40.test.ts：faux provider 真会话 + 真 AgentCronJobStore.claimDue/recordDispatchResult 驱动 delivered 判定；断言用 vi.waitFor 状态屏障；appendCustomEntry mock 只打磁盘写边界（注入 disk full），被测 park 生命周期本体真跑
- suite/agent-session-retry-compaction-deadlock.test.ts：真 compaction 接管路径 + vi.waitFor 状态屏障断言「finally done」与 isRetrying=false；响应在 serve 时盖时间戳避免 prebuilt 时间戳绕过溢出检查，注释自陈
- turn-key-reveal.test.ts（466 行新）：走 ReplayHost 调 mode 自身 key handler，渲染产物过真 FullscreenViewport，断言屏幕落点而非内部状态；tl-fix-host.ts 本体在范围外（存量冻结，非本次新增）
- daemon-command.test.ts 767→361 行收缩与 daemon-command.ts 1825→556 的真实删除一一对应（create/attach/prompt/agent-messages 等死臂确已从实现移除），并新增「死子命令被拒」回归与 list/kill/rename 冒烟——是删代码不是删测试
- daemon-agent-roster.test.ts（410 行重写）：断言 seam 从内部访问器（roster()/consumeWorkerRosterDelta）提升到 handleWorkerFrame 线框级（rosterFrame/rootShutdownFrame），20 条移除断言逐条有等价替换，重写是提升不是削弱
- agent/tool-not-found-breaker.test.ts：22 例覆盖 warn/terminate 阈值、recoveryTurns 0/1/默认、per-run budget 不退还、decay、并行整批计数、model 切换不清计数——规则④要求的恢复路径有故障注入式钉（回退 recovery 逻辑必红）
- display-sanitize-residual / agents-view-sanitize / tui markdown-sanitize：注毒（OSC52/CSI-2J/BEL/超链接/纯转义）后做字节级断言且保留词仍在；markdown-sanitize 的 poison 矩阵前有 assert.ok(VECTORS.length>0 && SURFACES.length>0) 非空守卫
- tui markdown-fence-stream-hl / markdown-pathological-corpus：流式 vs 全量 fresh 渲染的差分 oracle，corpus 为手写字面量常量（非生产数据），逐帧 byte-identical 断言配 per-test timeout 反指数看门狗
- R6-M5 旧钉 expect(diagnostics).toEqual([]) 改为钉 warning 详情 + 新增无冲突负例——变强不变弱
- R5-M30 stall marker 通道删除后 5 个测试文件改钉行状态形态；excused-stall 语义仍由 rlm-child-stall-excused.test.ts（isStalledSubagentSnapshot 3 例）与「⚠ 卡住」行断言钉住，不构成钉子丢失
- ipython-cell-sanitize 重钉 truecolor 主题断言 38;2：测试从环境相关（COLORTERM 下确定性红）改为环境无关，与 FORK_NOTES 声明一致
- interactive-mode-slim-transcript.test.ts：唯一移除断言 scrollBy 有等价替换 noteTranscriptPrepend（与实现的 backfill 通知 seam 改名同步），等强度
- retention-total-cap.test.ts：断言从整目录存在改为 kernel-state.dill 文件级 + 新增 reclaimed/skipped/bytes 计数断言，与 warm/cold 内核态实现语义变更匹配，不是收窄
- compaction-summarization-retry.test.ts 只 mock completeSimple（provider 线），重试策略/永久拒绝/输入收缩/abort 路径本体真跑——mock 的是边界不是被测逻辑
- agent-session-recursion.test.ts 本区间新增的 3 处 _rlmKernelEnv 探针均带具名 test-hygiene-allow 理由，文件计数与基线（11 存量 + 3 抑制）吻合，未超基线
- acp-aborted-turn.test.ts：真 runAcpModeWithConnection prompt 流，connection 只 stub IO，断言 stall 击杀（stopReason=aborted）计入 turnFailure——lane H 声明与代码相符
- lane-j-docs-truth.test.ts：optionalTokens 循环前有 expect(optionalTokens.length).toBeGreaterThan(0) 守卫，文件名循环为显式字面量集合
- rpc-connection-events.test.ts 的 jsonl/output-guard/theme vi.mock 只捕获 IO（lineHandler/outputLines），RPC 事件路由本体真跑
- 全区间仅一处 skip 新增：git-context.test.ts 的 it.skipIf(!supportsReftable())（条件化，符合仓规形态）；未发现无条件 it.skip/describe.skip 新增
- 全区间未发现「mock 掉被测逻辑」的新 vi.mock（fs/promises、pi-ai completeSimple、warm-pool-memory 度量、settings-selector 均为边界/平台 seam）；未发现 error-response 形状事实类空断言（errorMessage 断言均带具体内容）

**merge-semantics（26 条）**

- tui 包入口导出面：sanitizeRenderText 在 src/index.ts:169 与 dist/index.js:29、dist/index.d.ts:31 均已导出，dist 比最新 src 还新（Oct 8 21:41 晚于 18:55）且含加固版实现（plainParams/OSC8 终止判定都在）——第五波「导出没进 dist」的坑已闭合，coding-agent 经 workspace symlink 解析到同一 dist。
- 洗涤/截断顺序：所有新洗涤点都是先洗后截——agent-session.ts:16764 sanitizeRowText 后 slice(0,200)、tree-selector.ts:869 洗后 slice(0,80)、agent-message.ts:60 洗后 truncateToWidth、daemon-session-summarizer.ts:181 cleanRecap 洗后再跑 REASONING_TRAILER 正则（注释所述顺序成立）；不存在把转义序列截半的路径。
- 双重洗路径：sanitizeRowText/sanitizeBlockText 幂等（纯剥除操作），落盘前洗+读侧再洗（R4-M14 duty-log、recap）不变形内容；sanitizeDisplayText（diff-rows.ts:34）只是 sanitizeBlockText 的具名别名，非第二份实现。
- lane J D7 钉与 M3 和弦修复三处口径一致：stdin-buffer.ts:321 源码注释「Merge when the second ESC heads a key」、terminal-setup.md:112（箭头和弦已合并、Option+字母仍警告避开 Option-as-Meta）、stdin-buffer.test.ts:386 钉双 ESC+上箭头合并输出、keys.ts:824/1300 双 ESC 前缀解析与 matchesKey 递归、lane-j-docs-truth.test.ts D7 用例对齐——主席改钉无残留。
- live-turn-flow 心跳 wokenBy 与 replay 口径一致：步进中两路都走 addSteer（replay conversation-components.ts 与 live userMessage 首分支同形）；空闲唤醒走 customMessage → endLiveTurnForNewRun → addMessageToChat 渲染 InjectedPromptMessageComponent，与 renderUserPrompt ownerOpened:false 一致。
- R3-M16 压缩幻行双路径对账：outcome 消息先到（customMessage）→ activeCompaction 存在则 endCompaction 结清；compaction_end 事件先到（compactionEnd 从聊天尾部全扫描）→ 结清后 latestCompaction 抑制重放行不双行；跨 turn 的活动行由事件路径全扫描兜底。
- S1 收口完整：reconcileSubagentTimeline 只对终态子代理以 fromReconcile:true 放行，subagentUpdate 的 cancelled 分支带 settleKind:cancelled，upsertSubagent 的 settle 调 laneTracker.settle 关 lane（turn-timeline.ts:704-712），重复 reconcile 幂等。
- R3-M20 bash timer：ToolExecutionComponent.dispose → bash rendererState.dispose；bash.ts:1362 renderResult 里 state.dispose 先于 interval 创建赋值，interval 存在时 dispose 必已定义，clearInterval 幂等；resetPendingToolState 在会话切换（4143）、流终止（7319）、终止事件（7064/7449）各路径覆盖。
- R3-M18 stubStopped/runCutMidTask：agentStart 处计算 stub 守卫，settle 定时器处 delete（1037-1038），WeakSet 无泄漏。
- 死代码删除干净：formatSubagentStallMarker/setStallMarkers/SubagentStallMarker/running-card/turn-footnote 在 src 与 scripts 全仓零残留（R5-M16）。
- reveal marker 机制：disarmRevealMarker 幂等；setViewportRevealMarker 换槽时解除武装；全局 toggle（toggleAgentMessageExpansion 等）只 arm 最新 turn 一次，不存在多个 armed 头的 marker 字节漏出屏的路径；componentRowOffset 只渲染 chat 之前的兄弟，不碰 turn 头。
- update 链：--help 会话内分支 + SELF_UPDATE_HELP_EXIT_CODE 双刹车；fork gate detectForkInstall + buildExtensionsOnlyUpdateArgs 与子进程语义对齐（--extensions 保底追加）；SELF_UPDATE_INTERACTIVE_CHILD_ENV 语义在两 spawn 路径的用法一致（extensions-only 子进程非 self 更新不需标记）。
- buildSessionContext model_change hold/flush：toolResult 配对关闭批、compaction 分支 retainedMessages flush、尾部 flush 三处齐；user 消息介入时 flush 不新增配对破坏（该破坏本就由 steering 消息造成）。
- wake ledger：agentMessageAdmissionAccepted 只在 accept guard 触发一次，suspended-pump/compaction-gate 分支 return 在 _prompt 之前互斥不双记；coalesce 排除；cancelled turn 的 settle 以 pending-id delete 守卫幂等。
- _queueThrottledGoalContinuation 三个 defer 分支（quiescence/已排队/pause-suspended）均有消费者 _maybeResumeGoalContinuationAfterRlmWork（3874），无死 defer。
- strips 为 WeakMap（live-turn-flow.ts:152），页面 replay 的 attachStrip(summary, pageContainer) 复用同一 map 无泄漏；pageReplay 故意不传 subagentLane（fresh lane）只读 userLane，与注释口径一致。
- showStatus/showError 中央洗（sanitizeDisplayLine）；showWarning 虽未显式洗但其 FocusableTextBlock extends Text，走 Text.render 中央门（sanitizeRenderText 剥 OSC52/CSI-J）。
- R2-M16 贴图 marker 上界完整：attach 路径 populateHistory → addMessageToEditorHistory → reconcileImageMarkerUpperBound（8999），slim 省略前缀由 scheduleEditorHistoryBackfill（9815）覆盖，stash 恢复由 hydratePromptStash（2186-2189）覆盖。
- R5-M29 settings reload-on-close：onCancel → close() → done() + handleReloadCommand；Escape 经 selectList.onCancel 走同一出口；requestChatRebuild 的 renderSessionContext 不动 editorContainer，打开中的面板不被拆。
- M6 修复签名对齐：UserMessageSelectorComponent 第 5 参 getAvailableRows 存在（user-message-selector.ts:107-112），TreeSelectorComponent 已改 live getter（interactive-mode.ts:13293）。
- noteTranscriptPrepend 在 tui.ts:1098 与 fullscreen viewport（prependedLines 被下一帧消费）两级实现，loadEarlierTranscriptPage 的 splice 偏移契约成立；rowsBefore/rowsAdded 用二次 render 差值，行数不受 marker 前缀影响。
- supportsMessagesWindow 能力门：daemon-agent-connection.ts:872 读 slim_attach_transcript server capability，未重启旧 daemon 正确禁用分页 marker（R3 系 stale-build 洞闭合）。
- resetExtensionUI 只下扩展自己的 overlay（extensionCustomOverlays Set，close 时 delete + handle.hide()），登录框不再被误弹（R5-M28）。
- agent-session a5bf990ce 持久公告洗涤：sanitizeRowText 先于 200 字符截断，attach 不再重放转义字节（R4-M16）。
- settings 面板 onThemeChange 只在 setTheme 成功后落盘（防坏名字写进 settings.json），失败文案与「回退默认主题」一致。
- carryPromptStashAcrossFork 三入口（/fork 面板、消息选择器 fork、/clone）都先 renderCurrentSessionState 再 carry，priorState !== this.promptStashState 的 no-op 守卫正确；fork 会话自带 stash 优先不覆盖。

### 第二波

**python-runtime（14 条）**

- 送达清账本两侧口径一致：agent-session.ts:7064-7104 的 arrival/delivered 双计数 + _pendingAgentMessageDeliveryIds 集合（进出各一次、reflow 不重复计）与 repl.py:439 note_message_delivered 的只降不升 clamp、malformed pending 帧忽略、不唤醒 waiter 完全对应；rlm-runtime.ts:566 的 since=deliveredCount 基线正是任务单新问题 7 的处方；测试（DeliveredNotifyTest 4 例 + CollectWakeLedgerAccountingTest）钉住 clamp-down-never-up、取消路径清账、协议 3 回退只记一次。
- wake_on_message 与 collect 的竞态处理：请求 abort 抢先于 arrival 时不虚报（woken 需 !signal.aborted）、collect 自行结束后释放 arrival waiter（removeEventListener + abort）、Math.max(1,…) 只在真唤醒后出现——race 顺序逐一走查无双重计数或漏报路径。
- bash.py 包装壳封堵与 TS 面逐字对等：_SHELL_WRAPPER_PATTERN/_EVAL_WRAPPER_PATTERN 与 bash.ts:414-416 同型；mask 位置守恒（\" 成对抹除、双引号内 $()/反引号保活）经手工推演验证 payload 切片不错位；echo/sudo/cd/嵌套/nesting/$() 组装等正反向量在 test_bash_git_guard.py 双向钉死；已知绕过面（嵌套、命令替换、env/xargs/ssh、here-doc、别名）在守卫注释中如实列出且两面共享。
- bash.py env 名单补全（wave-44）：6 个 macOS 会话键在 bash.py:1417-1422 与 shell.ts SHELL_CHILD_SAFE_ENV_KEYS:173-178 逐项一致；test_bash_env.py 带负面对照（SERPER_API_KEY 仍被剔除）；PRIME_AGENT_ENV_PASSTHROUGH 逃生门语义不变。
- harness.py 合并盾正确：merge_targets 使 pass 2 的 containment（:1759）与 age（:1781）都不删合并目标，而目标仍可当 containment 容器（texts 用 pre-merge 正文，包含关系只增不减）；与 consolidation.ts:400/491/515 同构；两条新测试（containment/age）先红后绿语义成立。
- _merge_pieces/_merged_content 与 consolidation.ts 逐字对等：保护正则三分支同序（fenced→inline→URL）、分隔符集合一致（。！？；!?\n）、strip/去重/「合并补充：」拼接两边同构；URL 内 ?/!、fenced 换行、CJK 断句两侧测试互为镜像。
- slim_title_chars 默认改 None 与 TS 默认 undefined 对齐（两边都 opt-in）；小库频段（N<10→0.55）与 refinement.ts:104-105 常量一致，且两边 corpus 都含 candidate 本体、按 id 排除、len(corpus) 口径相同，边界 N=10 不会错位一格。
- effects.py 归因 ctime 扩展：mv/cp -p/tar 三个新测试（含无 git 路径）真实执行命令断言 origin=own，未 mock 被测段；_owns_write 的 OR 语义只扩大到窗口内 inode 变更，与原 mtime 窗口同类，注释明示取舍。
- unasked_untracked（blob 上限外的 untracked 报 created 而非 no-baseline）：probe_untracked 过滤确保 tracked 超限仍走降级；test_effects_tracked_never_created.py 用 MAX_GIT_BLOBS+30 真实跑出 230 个文件断言全为 created。
- linecache 有界保留 200：deque 上限 + 逐出最老，测试钉住逐出顺序与 inspect.getsource；repl.md 声称与代码一致（wave-40 第 4 条）。
- fork 子进程 stale _TaggedWriter 直写 fd：短写循环处理管道容量、OSError 吞掉不炸子进程代码；test_repl.py 新增用例走真实 os.fork 断言字节经 parent pump 到达（id:null）。
- activity id 混 nonce（R5-M8）：grep 全 TS 面无任何消费方解析 id 数字后缀（sentActivities/subagentKeys/droppedIds 全按整串 key）；Python 测试自身同步改为 rsplit("-",1)；两 boot id 不碰撞有真双进程测试。
- _note_collect_message_wake 恰好一次记账：按 kernel_capabilities()（协商协议门控）区分通道，协议 3 时 reply 是唯一通道、协议 5 时 push 是唯一记录，测试双向钉死，不会双计也不会漏记。
- 压缩 handoff 幽灵台账（R6-M8，34d56a68b）：session-handoff.ts parseActivity 提取 name、applySubagentActivity 以 activity.name ?? clip(label) 为键并迁移 previousKey——与 Python 侧 extra={"name":...} 闭环成立，ghost 测试先红后绿。

**refine-cluster（15 条）**

- 两刀拆分保真用 token 级脚本对账：refine-execution 11 个方法（1607a15c5^ agent-session vs 1607a15c5 模块）与 refine-scheduler 21 个方法（90f1fb4c1^ vs 90f1fb4c1）全部等价，仅有 this.→host. 与 5 个无壳 helper（_resolveRefinementModel/_loadRefinementHistory/_recordRefinementOutcome/_appendDurableRefineMessage/_recordRefinementFailureReceipt）的调用形变；split-plan 的守恒声称基本属实（唯一例外见 findings）。
- 922f51557 去重提交逐站点对账：16 处冷却盖章、3 处仅重置、6 处冷却判断与原内联代码逐条等价，maybeAutoRefine 的 at: nowMs（review 开始时刻语义）保留，stamp-before-reset 顺序不变；runRefinePlanPhase/withRefineApplyGuard 与原三份内联 scaffolding 的 finally 顺序（先 resolve → 按身份清字段 → notify → pump）一致，refine() 中守卫设置仍先于 waitForIdle。
- agent-session.ts 全部壳方法逐一核过（refine/_planRefine/_applyRefine/_waitForRefineIdle/_reviewAutoRefine/_emitRefineFailed + scheduler 21 个），均以 this 委托到模块函数；_applyRefine 墳新增的 trigger 参数所有调用方（refine-execution.ts:454、refine-scheduler.ts:429/605）都已带上，消费方无丢失；壳外 helper 无残留调用点。
- 并发 refine 合并守卫：refine() 的 while 等待循环从退出到设置 _refinePlanInFlight 之间无 await 让出（runRefinePlanPhase 同步前缀），两个并发 refine 严格顺序化，不会被吞；consumeSerializedBackgroundPlan 的 claim/"waited" 路径不丢 pending——未被本边界服务的请求留到下一 shouldStopAfterTurn 边界或 dispose drain 补服务。
- aborted 回合丢计划有正主：agent-session.ts:13040 一带在 stopReason=aborted 时已显式丢 pending refine.run、abort 并清 _serializedPlanInFlight/_serializedExplicitRefineOptions；refine-execution.ts:417 的「丢已 settle 计划」只是兜底，不构成显式请求静默丢失。
- 计时器无泄漏：scheduleAutoRefine 的 setTimeout(0) 全部登记进 _scheduledAutoRefineTimers（回调自删），drainPendingRefinementForDisposal 先清、allSettled(_autoRefineOperations) 后再清一遍；operation.finally(...).catch(...) 挂了 handler 不会产生 unhandled rejection。
- 错误路径调度状态回滚完整：runRefinePlanPhase 失败时清 _refineAbortController（按身份）+ _scheduleSessionInputPump + 重抛；withRefineApplyGuard finally 三步顺序正确；applyRefine finally 清 controller 并 _reconnectToAgent。
- 近重复两段阈值与护段正则与 prime-agent-runtime/src/rlm/harness.py 逐字对齐：_NEAR_DUPLICATE_SMALL_CORPUS=10/0.55、候选在语料内按 id 排除、idf=log(1+N/df)、排序 (-score, id)；MERGE_PIECE_PROTECT 的 fence→inline→URL 分支顺序与 Python 相同（TS 用 [\s\S]*? 等价 re.DOTALL），URL 尾部排除 CJK 句读。
- consolidation 的 merge-target 护盾（containment 与 age 两 pass 均跳过 canonical）和 slimTitleChars 默认改关闭均与 harness.py 完全一致；并查集簇内 canonical 与 absorbed 不相交，护盾语义自洽；isPlannableEntry 过滤对应「Python 面不加载畸形条目」的文档化理由。
- details.source 为可选新增字段：createRefinementOutcomeMessage 四参全有默认值，旧调用/旧回放消息不受影响；isRefinementOutcomeMessage 校验不检查 source；无 source 的失败 receipt（failed:true）走 amber 永不隐藏分支，正确。
- R3-M23 修复属实：render 拒绝原因 sanitizeDisplayText(error).split("\n")[0] 取首行，带先红测试（refinement-outcome-message.test.ts:206），sanitizeRenderText 会剥 \r 故 CRLF 不残留。
- refine-outcome-source.test 走公共入口（session.prompt("/refine") 与 session.refine(trigger:"auto")）钉 source 标记，未 mock 被测段；三个 refinement 测试无私有成员探针、无固定 sleep 断言顺序；"auto and legacy" 数据驱动循环带 sources.length 守卫。
- 失败上报去重链路成立：refine() 内部 _asError 归一化后 emitRefineFailed，queued /refine 的 catch（agent-session.ts:10064）对同一归一化对象再上报，WeakSet 幂等生效不双发；RefineSkippedError 早退在 receipt-set 之前（K3R-8）语义保留。
- handleRefineHostRequest 的 wire 形状（refine.status 的 pending/in_flight、refine.run 的 scheduled/reason/note）与区间基线 09eae8d55 完全一致，无 daemon 协议影响。
- 无效化的 serialized plan 替换路径（handleRefineHostRequest refine.run 撞在飞计划时）核过：branchVersion++ 后 abort 或换 resolved invalidated，旧 promise 无人引用、_serializedExplicitRefineOptions 在 consume 时按身份清理，新 pending 由边界同步服务。

**wire-compat（12 条）**

- rev 46/47 各自单笔认领无撞号（46=c9937500b、47=2b14a6208），DAEMON_SCHEMA_ID 随切片重算，DAEMON_PROTOCOL_VERSION 维持 7；两个加法（set_model/cycle_model.changeNoticeToken、session_replaced.messagesOmitted）都落在被哈希的 daemon-protocol.ts command/outbound 切片内，digest 身份随之变动。
- 旧 worker 忽略 changeNoticeToken 属实：daemon-mode 命令解析只 JSON.parse + type 分发（daemon-mode.ts:4471），无未知字段拒绝；新 worker 对直连 peer 自铸 token 的广播豁免（daemon-mode.ts:8618-8621）与 supervisor relay 豁免（daemon-supervisor.ts:9122-9129）两层都已接线，token 注册期与转发响应同序（notice 帧先于命令响应到达 worker 流）。
- kernel notify agent_message_delivered 双向安全：基线 runtime 的 _handle_notify 对非 agent_message kind 直接 return（已读 09eae8d55 源码），新 runtime 校验 pending 为非负 int 且拒 bool；宿主侧 gated on 已协商的 message_notify 能力，旧 runtime 收到未知 kind 静默忽略，与注释声明一致。
- supervisor drain 修复真实且等价：基线条件只查 chunked_snapshot，slim+chunked 客户端进 streamed 分支因 slim 窗口已消费 transcript 而 throw『Session worker did not provide a snapshot transcript』放弃客户端；HEAD 补 !slim_attach_transcript 走 inline 分支（daemon-supervisor.ts:9432），新客户端把 messagesOmitted 映入 latestSnapshot（daemon-agent-connection.ts:2522），UI renderInitialMessages 从 snapshot 读 slimTranscriptOmitted（interactive-mode.ts:9551）；daemon-mode 直连侧 streamed replacement 的 session_snapshot_begin 一直携带含 messagesOmitted 的 snapshot（daemon-mode.ts:6824），非只有 event 字段一条路。
- /autocompact per-model 化（4560bf2f9）为设计决策（FORK_NOTES 已记）：所有生产调用方统一读写 compaction.perModel+裸 enabled 默认——interactive /autocompact、daemon handleSetAutoCompaction（daemon-mode.ts:6362）、in-process/RPC setAutoCompactionEnabled、快照 createAgentConnectionState（snapshot.ts:46）、触发闸 _compactionEnabledForCurrentModel（agent-session.ts:4395）；写裸默认的旧入口 session.setAutoCompactionEnabled 无生产调用方残留，无双真值源分叉。
- FORK_NOTES『纯 additive wire』的车道 H 声称属实：compaction_end 失败字段（aborted/willRetry/errorMessage/errorSeverity）只进 _meta；quotaPark/connectionStatus/sessionSync/connectionClosed/recap 的 _meta 字段名与 attach snapshot 的 quotaPark 逐字段镜像（types.ts:409 vs acp-meta.ts:104）；AcpSessionUpdate 为本仓自有松类型（sessionUpdate:string），session_info_update 是既有 kind；docs/acp.md:86 与 rpc.md 已同步；RPC 侧连接级事件原样 JSON 转发（rpc-mode.ts:177-183），未知事件类型透传有注释依据。
- ACP ipython image block 1:1 转发声称属实：工具结果 content 真带 image 块（ipython.ts:1181-1182 imageBlocksFromAttachments），toolResultText 只拼 type==="text" 块故无重复投递，meta attachments 仅尺寸/路径索引不含 payload。
- worker-recovery-journal 的 queuedInputs 为加法：旧解析器按已知字段类型校验、接受多余字段；写侧 mark_interrupted 的 details 为自由 Record，旧读取方忽略未知键；restore/skip 过滤在渲染层不动 payload 形状（state-snapshot.ts:200/279，其中 _ 前缀用户变量误滤为第一波已报已知项，未重报）。
- stall marker（SubagentStallMarker 一族）src 内零残留引用，确系进程内 UI 类型，删除不动线缆面；agent_status journal 在本区间无形状改动；FORK_NOTES 相关声称与现实相符。
- in-process abort/abortAndSendQueued/abortAndClearQueue 补 requestAbort({reason:"user"}) 与 daemon 侧同命令 handler 口径一致（签名存在，agent-session.ts:11163）；setSessionName 走 sanitizeSessionName 与 daemon rename 边界一致。
- supportsMessagesWindow 消费方口径自洽：daemon 适配器做活的 slim_attach_transcript capability 检查（daemon-agent-connection.ts:872），in-process 无 getMessagesWindow 故调用方不进分页分支，interactive-mode.ts:9302-9304 仅在方法存在时才以 ?? true 默认支持，与接口注释约定一致。
- settle 账本（agent_message_delivered clamp）：admission id 来源为 custom envelope details.id 或 legacy 文本头（agent-messages.ts:780），账本集合与 clamp 计数同源；KernelClient.notifyAgentMessageDelivered 为可选方法，旧 provisioner manager 无方法时 optional chain 静默 no-op。

**harness-digest（12 条）**

- 十刀搬迁等价性独立复核：harness-digest.ts 全部 19 个函数体与搬出前 agent-session.ts（21af3533e^）逐体比对（剥注释/空白、this.→host. 机械重命名后）——20 个中 16 个逐字一致，4 处差异全为内联调用改写（this._foo() → foo(host)）及 appendHarnessDigestIfStale 从 _ensureHarnessDigestContext 内联体拆成独立函数，无语义漂移；第二刀 4205d2e8d 只改注释行（grep 验证无代码行变化）。
- agent-session.ts 九个委托 shell 全部保留（12821-12863），全部原调用点（2662/3360/3379/9846/9928-9945/12466/13367/18078）仍在，拆分无消费方丢失。
- 写闸失败模式与证据文档一致：Python harness.py:1520-1529 在 save 成功后计算告警、异常吞掉告警（写保留），TS refinement.ts:2235-2248 在 records[id]=after 之后 try/catch——两侧都 fail-open，advisory 永不阻断已落盘写入；告警文案两侧逐字一致（含 2026-10-04 新版「先确认是不是同一件事」）。
- 两 band 阈值口径一致：0.40/0.55/SMALL_CORPUS=10/MAX_MATCHES=3 常量两侧相同（harness.py:50-60 vs refinement.ts:98-105）；corpus 都含写入后的候选条目、df 都以整个 memory kind 为语料、候选按 id 自排除；TS refine 路径按单 store 加载状态（refine-execution.ts:663-664），与 Python 的 store 内比较口径一致，不跨 global/local 误报（两侧均有 scope 测试）。
- 分词器口径一致：harnessSearchQueryTerms 与 _harness_query_terms 的 CJK 区间表逐段相同、CJK bigram、ASCII≥3、其他文字≥2、run 在 CJK 边界切开——逐条核对等价。
- 批处理孪生一致：consolidation.ts harnessEntrySimilarityPairs 与 harness.py _similarity_pairs 的 terms 码点序求和、entry 按 id 排序、输出按 (-score, idA, idB) 排序、idf 形状 log(1+N/df) 一致；union-find 路径压缩、cluster 收集、canonicalOrder（recency 降序 + content 码点长降序 + 稳定 id 序）一致；merge-target 护盾（removed/mergeTargets，containment 与 age 两处跳过）两侧一致且有测试（test_merge_target_is_never_a_containment_delete 等）。
- merge 拆句保护正则同序同形（fenced → inline code → URL 尾排除 CJK 标点）；slimTitle/_slim_title 码点截断一致；harnessStoreDigest/_harness_store_digest 的 kind 序（prompt,memory,skill,subagent）、id 码点序、(kind,id,version,updated_at) 字段一致。
- 对抗性测试覆盖到位：近重复两侧都有 related-but-distinct 共享模板不告警、小库真重写仍告警（0.746>0.55）、N=11 回 0.40 带（0.44 仍告警）、非 memory kind 不告警、删除孪生后停告警、纯标点无 token 不告警、首条不告警、回执不落盘不污染 get/reload；TS 有跨面 pin（refinement-near-duplicate.test.ts:259-291 把 0.7463 钉在 0.7-0.8 带），两侧 fixture 逐字镜像。
- Python 加载路径（harness.py:1224-1227）拒收非字符串 title/content 的条目，consolidation 因此在 Python 侧永远只见良构条目，与 consolidation.ts:144-147 的「the Python face never loads them」声称相符；两侧 plan 的 malformed 行为（TS 跳过并给诊断、Python 不加载）为双方注释明示的既定设计。
- 跨进程 env 显式传递：agent-session.ts:14519-14526 显式把 PRIME_AGENT_HARNESS_ENFORCE_INDEX_CAP / INDEX_MAX_BYTES / PATH_VOCABULARY 的解析值传给 kernel（显式 shell 导出优先、缺键不覆盖），Python 侧 harness.py:70/112/116 读同名键——仓规第 2 条满足。
- FORK_NOTES 声称逐条核对成立：十刀「逐字节守恒」（独立复核通过）；「记忆近重复提醒的 TS 侧与内核小库频段对齐（N<10 不扰）」（常量+两侧测试）；「合并目标不再被误删、标题截断改可选、拆句避开网址和代码、小库不再误报近重复」（均与代码及测试相符）。
- digest 判定误拒面查过无问题：harnessDigestIsFresh 指纹含 entry 内容/版本/render flags/indexMaxBytes、不含 query terms（#2400 设计意图）；legacy 文本比较分支仅强制一次；latestContextHarnessDigestDetails 按最大时间戳取最新载体（compaction 头与 custom 载体都算），旧载体顶不掉新载体；appendHarnessDigest 持久化失败降级 context-only 并 warn（仅限已持久化会话），下次冷边界会重投；取消首回合时 digest 随回执剥离并失效基线/重挂 pending。

**ext-settings（14 条）**

- runner.ts R6-M5：重名扩展命令的诊断（owners+可用 invocation 名）经 getRegisteredCommands 走 ui.notify/console.warn，两组去重集合防刷屏；getCommand 路径行为不变；ResourceDiagnostic 形状（type/message/path）与既有类型一致。
- daemon-extension-binding.ts R3-M6：ctx.ui.custom() 仍 resolve undefined，但每个 binding 首次调用 emitUiRequest("notify") 提示；客户端 interactive-mode resolveConnectionExtensionUiRequest 的 "notify" 分支确实消费并 showExtensionNotify，链路完整。
- R6-M6 文档口径与代码一致：extensions.md（2028/2381/2490/2571 行）声称 renderCall/renderResult/renderShell/registerMessageRenderer/ctx.ui.custom 在 daemon 会话不生效；代码侧 daemon-backed interactive 无 localSessionHost（getLocalSessionHost 会 throw，bindLocalSessionExtensions 关闭），getMessageRenderer/getToolRendererDefinition 只从 local host 取——文档非假话。
- examples 11+6 文件：改动仅注释/路径/版本号；~/.prime/agent 与 package.json piConfig.configDir ".prime/agent" 及 main.ts:237 项目路径一致；ExtensionAPI/registerProvider/registerTool/getCommands/setActiveTools/session.subscribe/session.prompt/AuthStorage.create/ModelRegistry.create 全部存在；README 的 execute 参数序已改成与 types.ts:470 真实签名一致（toolCallId, params, signal, onUpdate, ctx）；examples 里无 ~/.pi 残留。
- settings 四个脏值 getter 守卫属实：getSteeringMode/getFollowUpMode（=== "all" 白名单）、getTheme（typeof string）、getTransport（枚举白名单）——theme:42 不再崩面板。
- 外部改文件通知链完整：reloadExternalEdit 两个分支（parse 失败仍保留旧快照、SEC-7 注释未破坏）都 recordWarning + notifyExternalSettingsReload（逐 listener try/catch）；interactive-mode 构造函数一次性注册 drainWarnings+showWarning 消费方。
- tools.notFoundBreaker 五键热刷新接线完整：KNOWN_SETTINGS_KEYS/nested keys/BOOLEAN_SWITCHES 都登记，getToolNotFoundBreakerSettings 在 agent-session._refreshAgentLoopRuntimeSettings 读取，而该函数在 4 个 dispatch 点（2647/9976/12729/16329）每次发 run 前重解——手改 settings.json 下个 turn 即生效，无需重启。
- keybindings 仓规硬规则：全量 diff grep 无新增硬编码键检查；repeatable 均加在可配置的 KEYBINDINGS 注册表里，tui matches() 经 definitions[keybinding]?.repeatable 判定；测试用公共 KeybindingsManager.matches 且数据驱动循环前有 expect(cases.length).toBe(10) 守卫，无私有探针。
- config-selector：空格不再误切换写盘（Input.handleInput 无条件吃掉可打印字符），表头提示改为 enter toggle；写盘失败行经 persistenceFailure().then + onRenderRequest→requestRender 渲染，persistenceFailure 先 flush 再 drainErrors；四个行为各有先红测试。
- SELF_UPDATE_HELP_EXIT_CODE(76) 链路自洽：子进程仅在 SELF_UPDATE_INTERACTIVE_CHILD_ENV=1 且 update --help 时置 76（package-manager-cli.ts:1661，普通 CLI help 仍 0）；父进程 /update --help 分支在会话内直接答（spawn 不带 child 标记），relaunch 门同时排除 75/76；协调器子进程 env 显式擦掉 child 标记（daemon-update-restart.ts:524），恢复路径在 config.ts 注释写明。
- settings-manager 里 sessionArtifactsMaxBytes 注释重写（只回收 kernel-state.dill、largest-first）与 retention/artifact-total-cap.ts 实现（回收单元 kernel-state.dill、largest first、保护规则）逐条对得上，非文档假话。
- bash 1s Elapsed tick 的 dispose 链闭合：bash.ts renderResult 里 state.dispose ??= clearInterval 且非 partial 时调用；tool-execution.ts dispose() 调 rendererState.dispose；types.ts:404 写明契约。
- compaction perModel 读写两侧 key 格式 "provider/id" 一致（snapshot.ts、in-process-agent-connection.ts、daemon-mode handleSetAutoCompaction、agent-session 触发门、interactive footer），wire 形状未变（4560bf2f9 声称属实）。
- lane J 文档真相对账：tui 的 clampOverwideLine/logClampedOverwideLines 确实存在；lane-j-docs-truth.test.ts 19 例在仓。

**cli-surface（15 条）**

- R6-M3 死面删除反查：旧 DAEMON_CLIENT_COMMANDS 21 项 − 保留 5 项（list/kill/rename/send/cron）+ 默认 open = 17 个被删子命令，与 daemon-command.ts 头部注释、.changes/lane-d-fake-features.md、FORK_NOTES 三处清单完全一致；全仓 grep（src/test/docs/scripts/README/示例）对 17 个子命令的 CLI 形态零活引用，唯一提法是 streaming-resend-design.md 里已自我声明的删除记录与不可变的 CHANGELOG 历史。
- REMOVED_COMMAND_NAMES 无幽灵无裸 404：app/install/manage/remove/uninstall 六个前缀在 CLI 层只剩拒绝+替换提示，grep 确认无任何残留 handler；daemon 前缀拒绝自 09eae8d55（上游 ebb240e5a）就存在，删除的是真死代码。
- 搬动等价性：diff 逐函数比对，保留的 runList/runRename/runSend/parseSendArgs/runCron/resolveLiveSessionSelector/printResponseData 及全部尾部类型守卫 helper 与 09eae8d55 字节一致；唯一差异是 497553d6d 给 formatSessionListTable 传 width（签名向后兼容，默认参保持旧行为）。
- 孤儿反查：559 行文件内所有函数均被调用；DaemonAttachTerminal 及独占 helper（runOpen/runStart/runPsCommand/runCreate/runAttach/runJsonAttach/runPrompt/runAgentMessages/runMessageCommand/requireSuccessAsync/createDaemonMessageWaiter/waitForSessionEnd/waitUntilInterrupted/nextDefaultSessionName/printJsonLine 等）全仓无引用残留；DaemonAttachResult 类型仍有 daemon-agent-connection 等活消费方；canConnectToDaemon 命中的是 daemon-launch.ts 自己的同名副本，非孤儿。
- DAEMON_CLIENT_COMMANDS 与 public-command.ts 路由同步：list→list、stop→kill、rename→rename、send→send、schedule→cron，无幽灵入口。
- 公共命令冒烟核对：stop/rename 的 requireOperandCount 对 --json 与 --socket/--daemon-socket 值对跳过正确，缺值由 daemon 层二次校验兜底；send 的 --from/--steer/--follow-up/--message/-- 分隔符解析、未知 flag 拒绝、双模式互斥、旧 daemon 能力门（send_message_delivery_mode 缺失时发送前拒绝）均有测试且错误路径置 exitCode=1；schedule list/cancel 的 validateScheduleArgs 正确跳过 scope 值对。
- helpIndex 逻辑核对：--help/-h 出现在 index>0 且在首个 "--" 之前一律转 help 输出；分隔符后的 --help 作为消息字面量保留（有测试）；`prime-agent help daemon ps` 正确落入 REMOVED 拒绝。
- normalizeLeadingDaemonSocketOption 的分隔符感知插入核对：--daemon-socket X send worker -- hi 重组为 [send, worker, --daemon-socket, X, --, hi]，daemon 层解析器在 parseSendArgs 之前剥离该值对，消息不被污染；无分隔符时追加尾部同样正确（w40/w41 测试覆盖）。
- redirectFlagLeadingCommand 核对：`--help list` 现在打印 list 帮助（基线同样是报错，新行为严格更优）；-p/--mode/-c/-r/--fork 提示意图 flag 正确放行为 prompt；--version 让位 main；flag 值与命令词重合时按 indexOf/lastIndexOf 唯一性放弃重定向。
- update --socket 值对抬升核对：socket 路径不再被误读为 legacy package target（`update X --daemon-socket Y` 现在报 'Package updates moved...' 而非误导性的 'separate' 错误）；缺值报错；SELF_UPDATE_HELP_EXIT_CODE=76 刹车在 interactive-mode 有文档化恢复（会话内 help 分支直接 return，不走 relaunch），并有 package-command-paths.test.ts:162 回归测试——满足仓规「刹车必带恢复」。
- list-models.ts：writeRawStdout 在 stdout 未被接管时等价 console.log（手动补 \n），被接管时正确绕过 stderr 重定向走真 stdout；调用点（main.ts --list-models / model list 重写）在区间内未变形。
- package-manager.ts 坏配置源容错：update/remove/add 单条坏 entry 只跳过+stderr 告警不再整命令失败；update(identity) 目标本身仍响亮失败（正确）；buildNoMatchingPackageMessage 静默跳过有注释依据；新增 5 个测试驱动公开入口断言可观察行为，非 mock 被测段。
- formatTable 共享格式化器：budget 路径用 truncateToWidth(…, pad=true) 既截断也补齐（列不会错位）；width=undefined（管道/重定向）走字节等价的 legacy 路径，脚本消费方不受影响；dropOrder 循环保底 1 列、列宽不低于表头宽；两个消费方（daemon-list-format、daemon-ps-format）都已带上 width+dropOrder。
- 测试卫生：daemon-command.test.ts / public-command.test.ts / 622 回归只 mock 边界依赖（DaemonClient、package-manager-cli、daemon-ps），被测解析/路由逻辑未替换；新测试无固定 sleep、无未守卫数据驱动循环（循环均为字面量数组）。
- FORK_NOTES 声称核对：'1825→556 行'（HEAD 559，3dacdab6c 时点 558，后续 commit 增 3 行，实质相符）；'767→361 行测试'（HEAD 360，相符）；'usage.md 与 streaming-resend-design.md 同步'（两处 diff 已核）。

**tty-probe-bus（12 条）**

- exit 监听器故障注入测试真实存在：terminal.test.ts:801-957 通过 process.listeners("exit") 公开 diff 定位 guard 并直接调用，恢复序列逐字节断言（含 alt kitty pop、1049l、main kitty pop 的先后顺序），全程无私有成员探针，符合 test-hygiene。
- guard 替换不叠加：armExitGuard 先摘除模块槽前任再挂新 guard；测试 883-916 验证 preserve 交接期恰一个 guard、下实例 start() 替换而非堆叠、干净 stop() 卸下（863-881）。
- CSI ? flags u 解析正确：正则与 kitty 应答形状一致；flags 0、verdict 已落、env-override 三种不 pop 的情形有专测（probe-bus.test.ts:60-93）。
- pop 与本进程 push 的字节序正确：pop 在 setStateUnlessOverridden（进而 enableKittyProtocol 的 push）之前写入，同一条同步链上完成。
- 干净退出双栈 pop 顺序符合 kitty 每屏栈语义：drainInput pop 活动屏 entry，stop()/releaseAltScreen 按模块 mark pop 另一屏（alt 活着时先 pop alt、再 1049l、再 pop main），干净退出不再泄漏 Ctrl+C entry。
- 挂起（Ctrl+Z，interactive-mode.ts:10582）与 $EDITOR（11907）流程都走完整 terminal.stop()——交接 tty 前两屏 entry 均已 pop，恢复后 re-probe 应答为 flags 0，不会误触发泄漏 pop；suspend 窗口内主屏 kitty entry 保留的行为与改动前一致（非本波回归），最终退出时按 mark pop 掉。
- agents-view 正常会话切换路径 mark 记账自洽：preserve stop pop alt entry、主屏 entry 由下实例 adopt，leaveAltScreen 因 mark 为 true 不重复 push，最终 stop mark-driven pop。
- R5-M6 2027 欠账逻辑正确：stop() 在 releaseAltScreen 之前清 grapheme2027PendingMainScreen（不会补发后立即复位），leaveAltScreen 补发 2027h，测试 960-988 覆盖。
- setTitle 清洗 C0/DEL/C1 控制字节，持久化会话名里的 BEL/ESC 无法提前终止 OSC 序列注入转义（terminal.test.ts:1235 附近断言无注入存活）。
- guard 与 daemon 崩溃处理器交互路径核实：installDaemonCrashHandlers（daemon-mode.ts:748、daemon-supervisor.ts:613）统一 process.exit(1) 收尾，exit 监听器（即 guard）在该路径会同步执行；无 handler 的信号击杀本就不可恢复，是与改动前相同的固有限制，非本波引入。
- 旧 mouseExitGuard API 无悬空引用（全仓 grep 零命中）；probe-bus-invariants 测试 fixture 从 flags 1 改 0 只为避开新 pop 副作用，「应答不进用户输入流」的消耗不变式覆盖未削弱（pop 行为另有专测）。
- 逐条核对 09eae8d55..HEAD 触及本切片的三个提交（c9937500b、68ed41031、a1638d15a）说明与代码一致：故障注入测试、guard 替换语义、mark 记账均在提交说明所述位置真实存在。

**image-retention-export（13 条）**

- image-routing.ts 第九刀搬迁：14 个方法体与原 agent-session 私有实现逐段比对等价（含 imageRouteForTurns/maybeHandBackFromImageModel/rerouteToImageModelForNewImages/maybeNoticeImageDeliverySuspicion），ImageRoutingHost 结构 seam 只做 this→host 重命名；agent-session 保留的一行 shell 委托正确；类型仅 type-import，运行时无环。FORK_NOTES「16/17 逐字节全等」属实。
- R2-M16 回填贴图 id 上界：两个历史入口（addMessageToEditorHistory:8999 覆盖 populateHistory 全量回放、slim backfill:9815）都调用 reconcileImageMarkerUpperBound；新 paste 走 nextImageMarkerId++ 不会与旧 marker 碰撞；红先测试覆盖两路径。声称与代码一致。
- retention artifact-total-cap（wave-40 重写）：largest-first + path localeCompare 决定性排序；删除走 rename→rm 两步，崩溃残留 .retention-trash-* 由 trash.ts 类回收、幂等（快照已删则下次不再入选）；signature（dev:ino:size:mtimeMs）拒绝判断后被重写的文件；accounted=reclaimed+skipped 补账循环数学正确（每个已处理 request 恰好落入两计数之一且按序）；嵌套 session-artifacts 根各计一次（有专项测试）；移除 descendantBlocker 定点循环对文件级回收单元不必要。
- bash 守卫一层解包（8c1da0fd2）：maskQuotedSpans 位置保持使 wrapperStart/payload 切片与 synthetic 命令的索引算术自洽；commandPrefix 内的 wrapper 被强制按前缀 discard 拒绝（boundary=command.length+1 使 UNRESOLVABLE）；cd 前缀/env 赋值/git -C 在 synthetic 上解析正确；TS 与内核 Python 两面实现逐段对齐（含残余绕过面清单），两面均带红先测试。残余绕过面（嵌套包裹、$() 组装、env/xargs/find -exec、heredoc、别名）在守卫注释与 FORK_NOTES 如实登记，非假修。
- utils/shell.ts macOS 会话键转发（e76a6dbda，仓规②）：SHELL_CHILD_SAFE_ENV_KEYS 与 Python _CHILD_SAFE_ENV 同步新增 6 键（TS+Python 双面、双面测试），暖池指纹测试钉死「哈希全环境不受白名单影响」的声称；无静默跨进程丢失。
- export-html 转义面：marked html()/tag() tokenizer 返回 undefined 禁原始 HTML；link/image renderer 拦 javascript:/vbscript:/data: 且 escapeHtml(href)；代码块走 hljs（自身转义）失败兜底 escapeHtml；新增 stripAnsi/懒加载 buildLazyToolOutput/renderResultImages 全部经 escapeHtml 或 hljs；未发现注入面。CommonMark 链接目标不含换行/控制符，java\nscript: 形态经 marked 不可达。
- ¥ 修复后 template.js 仅 Cost 行一处硬编码货币（全文 grep $/USD/美元 无其他命中）；「真 ¥」修复属实。
- bash timer 泄漏修复（cc01e9101）：state.dispose 定义于 renderResult，丢弃路径两条均接线（ToolExecutionComponent.dispose:457 + resetPendingToolState 对 pendingTools 逐个 dispose），非半修。
- formatBashCall 头行清洗（R4-M6/R3-M21）：raw fallback 现在也过 redactNoise+sanitizeRowText，preview 路径经 descriptor 已脱敏再洗一次（幂等无害）；label 逻辑与旧行为等价。
- window.scrollTo 替代 content.scrollTop：#app 用 min-height 非固定高、#content overflow 不构成实际滚动容器，文档级滚动才是真容器——旧代码才是错的，修复方向正确。
- R2-M1 stripAnsi：bash/read/write/edit/ls/default 各出口（formatExpandableOutput 与 getResultText）均过 stripAnsi，OSC/CSI/单字符转义覆盖充分。
- guard 懒加载与 toggle 状态：tools-expanded 挂在持久 #messages 容器（navigateTo 只清 innerHTML 不换元素），懒记录在模块级 Map 跨导航存活，克隆节点重复展开幂等。
- 本车道新增测试均为真实驱动（retention 用 mkdtemp 真实 FS、guard 直接调真函数、export-html 在 DOM harness 里跑真 template.js、image-routing 用真 session 做 host），未发现 mock 掉被测段的情形。

### 第三波

**rlm-child-host（13 条）**

- 三阶段拆分保真：ac38f9578 的 subscribeRlmChildRunEvents / settleRlmChildRun 抽取与拆分前逐字节等价（脚本化文本比对 09eae8d55..ac38f9578^ 的内联 finally：四条 retention 分支、deletionRunFinished/settled/settlement.resolve/goal+autonomous 唤醒全部一致），FORK_NOTES「零行为变化」属实
- settleRlmChildRun 新增「error 且从未绑定 session」闭账分支：closed record 字段与 rlmCollectEntryForRun 逐字段一致（snake_case、settled:true、rlmCollectStallAbort 序列化），先 _removeRlmSubagentTracking 再 _rememberClosedRlmChild 的顺序正确（removal 会清 closed records），_rememberClosedRlmChild 有 CLOSED_RLM_CHILD_COLLECT_ENTRIES_MAX 界
- 并发上限 admission slot（_pendingRlmChildAdmissions）：检查与占位在同一同步段、admission 失败 catch 释放、run 注册后释放、名字预留（requested+minted）在 admission settle 时释放——四个出口齐；两条并行 spawn 只有一条能过 cap，settlement 测试用真实 harness 钉住
- quota-park 等待环：emitChildUpdate 的 nudge 位于 unchanged-fields 早退之前（取消不改任何 volatile 字段也能唤醒等待）；30s 兜底 recheck 覆盖「无事件的 park 拆除」；park 自身有 maxPauseMs abort 界（默认 24h、钳 7d），无人值守运行不会无限挂死；parked 期间 run 保持 running/settled:false 语义与 collect/prune/上限一致
- deliverRlmChildTerminalOutcome 的 quota-park 跳过：成功路径不可达（while 循环退出条件与跳过条件互斥、循环退出到分类入口之间无 await 插入点），catch 路径窄；run.status=cancelled 时跳过不生效，取消通知照发
- update_restart 章：abortForUpdateRestart→_abortRlmSubtree(turnAbortReason:"update_restart")→requestAbort 记入 _lastTurnAbortReason；分类器把它落到 cancelled（第一优先级）而非 stall/user；quota-park 的 handleAbortedQuotaPark 只认 ==="user"，parked 子代理不再被重启级联误吃（FORK_NOTES 声称与代码一致）
- rlm_child_settled 台账闭环：producer _recordRlmChildSettled→appendCustomEntry(entry.data)；consumer session-handoff.ts settledSessionName 读 entry.data.sessionName；键与 kernel subagent activity 的 name 同为 admitted sessionName，历史名编号规则防撞；terminalErrorNoticeDelivered/stall_survived 两条 none 也带 repliedDuringRun→落标记，任务单三·表「回复结束也移出」已修且 rlm-child-settled-marker.test.ts 用真实 harness 钉往返+反控
- wake 账本改 accept 时点 + delivered 基线：admission（_noteAgentMessageAdmitted，pending 集合防重）、message_start 主/非主 record、cancelled-turn、cleared-before-delivery 四条路径都结清 delivered；kernel 侧 repl.py note_message_delivered 只降不升、未知 kind 忽略、无 pending 字段的帧忽略——老 runtime 双向降级成立，kernel-protocol-negotiation.test.ts:347 钉帧形状
- prune 的 unsettled 守卫：run 离开 _activeRlmChildRuns 与 settled=true 之间无 await（原子窗口），守卫读同一 map 不会漏；retained/deletion/closed 三形态与 prune 测试覆盖一致
- kernel/repl-manager 进程生命周期、state-snapshot 载荷往返、shared.ts：范围内分别只有 notifyAgentMessageDelivered 方法（messageNotifySupported 门 + try/catch 不抛入投递路径）、渲染层例行 skip 过滤（:49 已知条目的范围内）和纯接口增量，无生命周期/往返语义改动
- 测试锚点：rlm-child-run-settlement / rlm-child-settled-marker 全程 harness+faux provider 驱动真实状态机（park、cap、startup 失败、prune 均无被测段 mock）；rlm-collect-message-wake 的 fake 只替换 wake 源 seam，被测 handler 是真实现；断言用 vi.waitFor 状态屏障，唯一 sleep(250) 是「确认坏通知不落地」的负检宽限，非顺序断言
- normalizeRequestedRlmSubagentSessionName 消毒（C0/C1/DEL 剥除）：rlm.run 与 rlm.create_session 两个名字入口都过同一函数，注册名/预留名/后续 selector 全用消毒后的同一字符串，无消毒不对称
- discardForSender 陈旧回执清理与 provisionalNoReplyReplyIds/failureVerdict 机制均在 09eae8d55 之前已存在（范围内无改动），同回合投递抑制回兜仍在

**compaction（15 条）**

- completeSummarizationRequest 新增 transient 重试环核对：attempt 计数 1+maxRetries、input-length/refusal/permanent 提前 break 顺序、sleep abort 转 AbortError、providerRetryStreamOptions 保 provider 单发；compaction-summarization-retry.test.ts 钉 1+2 次、400 不重试、无 policy 单发、backoff 期 abort 记 cancellation。
- shrunkKeepRecentTokens 从第 2 次连续失败起折半、floor 4096、结果不超过配置值，公式与 _compactionSettingsForAttempt 调用一致。
- planEmergencyShrink 线性化等价：measureShrinkSpanTotals 的 suffix/carried 折叠与逐 cut walk 数学等价（cut>spanStart 保证 carriedTokens[cut-1] 有定义、整数价格保证折叠精确），随机分支等价 + 线性成本 + 结构边界测试均覆盖；tokensBefore/cut 选择/最深兜底语义与旧 walk 一致。
- R6-M8 入账/删除同口径核对：kernel 侧 rlm/__init__.py step.finish("ok", handle.model, label=handle.name, extra={"name": handle.name})，name 即 session_name 且不经 label 清洗（name_safe_to_record 拒绝时留 label 回退，注释声明保守方向）；与 RLM_CHILD_FAILURE/TERMINAL_NOTICE 的 details.sessionName、rlm_child_settled 的 data.sessionName 同口径；seedScan+全分支重放不会复活已结清子代理（终态记录在分支内按序删除，generation 2 钉子测试在）。
- emergency shrink 与正常压缩并发互斥：manual compact 经 _manualCompactionInFlight 合并/抢占 auto（abort 标记），_compact 先等 _compactionOperation；shrink 在持锁 scope 的 catch 内同步执行（appendCompaction 后才 resolve），无并行写双头。
- 重试链压缩交接（supersededByCompaction）：_finishActiveRetryForCompactionHandoff 以非失败事件收链并清 _terminalFailureAttemptCount/_retryAttempt/_providerWait/auth sources，agent_end 处 compactionWillRetry 分支先于 _finishActiveRetryWithFailure；回归 20261004-compaction-handoff-retry-count.test.ts 钉死不再误报 attempt 数。
- user-requests 跨代不丢不重：boundaryStart=上代 compaction 的 firstKeptEntry（保留尾起点），上代台账只含更早切片、新代从保留尾起收集 → 无重叠无空洞；merge 按 text+kind 折叠 repeats；summarizer 输入 elision（budgetSummarizationInput）不影响台账（台账用完整 source）；parseUserRequests/FromDetails 兜底含损坏行容错与 self-count 校验，branch 头变体钉子测试在。
- compact() retry 参数线程化（c9937500b 声称）核实：generateSummary 与 generateTurnPrefixSummary 均接收 retry 并传入 completeSummarizationRequest，与 FORK_NOTES 声称一致；sessionId 仍 biome-ignore 未用，但注释如实标注「未线程化」。
- 局部 abort 的部分摘要不落盘：completeSummarizationRequest 对 stopReason=aborted+signal.aborted 返回部分切片，但 _performCompaction 在 appendCompaction 前有 `if (signal.aborted) throw "Compaction cancelled"`；无本地 signal 的服务端 abort 记为失败（可重试）。
- 分支摘要 length/empty 守卫（新 in-range）：_navigateTreeUnderPause 对 result.error 抛错终止本次导航（不再落盘 "No summary generated"/截断片段作分支永久记录），aborted 返回 cancelled；abort 预检在 wire 调用前。
- decisions 通道移除消费方全清：pendingDecisions/HANDOFF_MAX_DECISIONS/parseDutyEvent 在 session-handoff 之外零残留消费者；旧块 decision 行仅计数保 self-count、details 旧键忽略不读——仓规③（形状改动列消费方）满足。
- compaction_end 失败字段 _meta 生产端（lane H 声称）核实：acp-events.ts:366 输出 aborted/willRetry/errorMessage/errorSeverity（后两者条件出现），agent-session 各失败/取消/跳过路径均经 _endCompactionUnsuccessfully 或直接 emit 携带这些字段，与声明一致。
- 压缩/分支摘要卡片 R6-M7 展示层 stripMachineBlocks（compaction-summary-message.ts displaySummary），复制路径保留源文含机器块（lane B 刻意的「复制卡片持有的源文」口径），行为一致。
- 簇内测试卫生：deadlock/compaction 套件用 vi.waitFor 状态屏障无固定 sleep（仓规⑤）；compaction-summarization-retry mock 的是 completeSimple（wire 层）而被测重试环真实运行（仓规①）；emergency-shrink-linear 对旧实现的淘汰有判据测试。
- FORK_NOTES 其余声称抽查相符：wave-40「transient 失败重试进压缩线」与代码一致；lane I「session-handoff 幽灵台账修复（入账删除同口径）」与 R6-M8+settle 组合后的主路径一致（残余缺口见 findings/note）。

**recovery-edge（13 条）**

- sdk.ts:196 `await restoreSavedSessionModel` 修复正确：函数本就是 async（model-resolver.ts:682），旧代码在未 await 的 Promise 上取 .model/.verifiedUnavailable 恒为 undefined，必然走回退分支且 savedSelection 误判；修后与 main.ts:1151 同路径一致。
- atomic-file.ts：fsync 容错（EINVAL/ENOTSUP/EPERM）在 sync/async 双侧一致；async 路径 fsync 描述符从 "r" 改 "r+" 正确（写侧 fd）；写→fsync→chmod→rename→fsyncDir 顺序不变，崩溃窗口内目标文件要么旧版要么完整新版；异常路径 temp 清理（sync finally rmSync force / async unlink().catch）保留，成功改名后清理为无害 no-op。
- git.ts：isGitDirShape（HEAD+refs+objects，GIT_OBJECT_DIRECTORY 重定位）与 git 自身发现行为一致——/tmp 实测：内层无效 .git 目录会被 git 跳过并发现外层仓库（rev-parse --git-dir 返回外层），新 walk 逻辑与之一致；reftable 仓正确降级到 CLI（captureHeadFromFiles:349）；git CLI 缺失/非仓库时 runGit 返回 null、captureGitContext 返回 null，消费方安全降级为无 git 上下文；.git 文件（worktree）分支行为不变。
- schedule-timestamp.ts：输入恒为 cron-jobs/heartbeat 的 toISOString() UTC ISO（cron-jobs.ts:428 等逐点核实），本地时区渲染正确、DST 由 Date 本地 getter 正确处理；解析失败回退原值；两处消费（heartbeat-manager.ts:328、interactive-mode.ts:1560）均为 ISO 串，`formatScheduleTimestamp` 全仓恰两消费点，无残留 raw ISO/toLocaleString 渲染。
- shell.ts：新增 6 个 macOS 会话键（SECURITYSESSIONID/__CF_USER_TEXT_ENCODING/XPC_FLAGS/TERM_PROGRAM* 等）均为非密钥的身份/会话上下文值，无凭证泄露面；与 prime-agent-runtime/src/rlm/bash.py `_CHILD_SAFE_ENV`（:1401）逐键同步，两侧注释互指，符合仓规②的显式清单要求。
- prompts/rlm.ts：enforceIndexCap「默认关、harness.enforceIndexCap 设置才开」与 harness.py `_enforce_index_cap()`（:119，默认 off）及 settings-manager.ts:3066 一致；设置跨进程显式转发（agent-session.ts:14519-14521，用户显式 export 优先）；「cap 恒作用于 digest 索引层」与代码一致（写入侧拒绝才走 _index_max_bytes，digest 渲染层独立截断，plan_consolidation 注释明说）；DOING_THE_WORK_PROMPT 新增的「绿检查被后续编辑作废」措辞与 self-recovery.ts 新判定逻辑互为表里。
- REVIEW-FIXUP 第 4 条「恢复轮不压制自我恢复」修复核实：agent-session.ts:5174 收窄正确——自主续跑（/autonomous）在恢复轮仍被压制（:5176 要求 !suppressAutonomous），放行的只有 _selfRecoveryContinuation，其受 maxAutoContinues 每提示预算 + FINISH_GATE_MAX_STRIKES 上限约束，不会重开无限自主循环；恢复轮一次性由 _providerFailureRecoveryUsed>=1（:15862）保证、真实应答后重置（:6003），停摆问题已闭合。
- 恢复轮与 park 的交互：_finishGoalForTerminalAssistantMessage（agent-session.ts:3528-3532）在 _quotaPark 存活时不清 goal——park 是暂停不是判死，wake（resumeFromQuotaPark）负责恢复；parkForQuotaReset 持久化失败被捕获且不吞 park（注释与代码一致），wake 预算/一次性由 park 结构保证。
- headless-completion.ts R5-M25 主修：未知 custom 类型改为跳过而非中断扫描，user 消息与 slash-command request/result 边界仍正确 break（:52），不会把过期回答伪造成终值输出；rlmChildFailures 只收集 rlm_child_failure 类型且 unshift 保序。
- runHasVerificationEvidence 的字段契约：toolResult 消息确有 toolName（pi-ai types.d.ts:207-215），edit 工具名恰为 "edit"（edit.ts:364）；details.fileChanges 元素带 scope: "project"/"scratch"/"memory"（kernel/shared.ts:260、effects.ts:23），changeTrackingIncomplete 为 string 理由，均与 self-recovery 读取一致；fileChanges 缺省=该 cell 从未写过（filesReported 语义，effects.ts:270），不误判。
- void 判定与绿判定在同一 result 上的顺序正确（先 void 后判绿）：覆盖写入型验证命令（npm run build > log、make check 产生 coverage 文件）不会作废自己携带的判定，与 doc 注释声明一致；后红超前绿、后写超前绿均正确作废（前向扫描语义）。
- finish-gate nudge 文案已带上「编辑使绿检查失效」例外（messages.ts:515 finish_gate 分支），与 REVIEW-FIXUP 第三部分遗留项「文案没加例外」对账闭合。
- CELL_FAIL_TEXT 先于 CELL_PASS_TEXT 检查，混合汇总（"2 failed, 47 passed"）正确读红；2>&1 的 fd 复制不会被 (?:\d+)?>>?(?![&=]) 误匹配（node 实测 false）；CELL_ASSERTS_EXIT_CODE 要求 assert 与 exit_code 同行，误绿面极窄且 CELL_FAIL_TEXT 仍先行。

**ci-workflows（10 条）**

- ci.yml 地板注释与 scripts/ci-floor-readings.json 同源一致：两者引用同一 run 37649262888（head_sha f4e701186 为本分支祖先、conclusion success、branch merge/repl-kernel），9 行读数逐字相同；进一步用 gh run view 37649262888 --log 提取 gate 自身输出行，JSON 里 9 条 log_line 与真实日志逐字一致，包括未改动的 process-smoke 行（24/12，该 run 实测同为 24/12，保留不动是对的）。
- 地板算术全部符合策略 ceil(0.9×读数)：agent 155/155(172)、ai 1384/712(1537/791)、tui 1218/1218(1353)、shard1 3550/3527(3944/3918)、shard2 3858/3848(4286/4275)、shard3 3146/3112(3495/3457)、machine-wide 7/7(ceil(6.3)=7)、process-smoke 22/11(24/12)；kernel 异常项 49/39 与 packages/coding-agent/package.json test:kernel:ci 的 --min-tests 49 --min-ran-tests 39 完全一致。
- 一致性并非只靠手查：packages/coding-agent/test/ci-floor-policy.test.ts（本窗口内同步更新）机器校验 ci.yml 每行 = ceil(0.9×reading)、log_line 与行字段一致、mirror 行读取、kernel 异常项钉住 package.json，该测试随 shard 在 CI 里跑。
- 地板上调不构成 flake 放大器：全部行按策略留 10% 余量；machine-wide 7/7 零余量是注释明示的故意设计，且 test/suite/regressions/4603-worker-recovery.test.ts 无 skipIf/条件跳过，测试数恒定；落地新地板的提交 52dd02da8 的 CI run 37657184209 与最终 HEAD 3b57591a4 的 run 37786389313 均为 success（读数 sha 之后窗口内又新增约 38 个测试文件，地板依然绿）。
- timeout 15→30 注释证据成立：run 37649262888 的 Test (coding-agent 3/3) 作业 run_attempt=2、第二次 attempt 16:23:10 才启动而 run 创建于 16:05:13，与第一次 attempt 撞 15 分钟超时后重跑成功吻合；apt-get 安装步骤（cairo/pango 等）确实存在于 build-check 与 Test 两个作业。
- runner 全部固定 ubuntu-24.04：6 个 workflow 共 17 处 runs-on 无一遗留 ubuntu-latest（behavioral-evals.yml 窗口前已固定，不在 diff 内）。
- build-binaries / contribution-gate / changelog-fragment / nightly-process-stress 仅改 runs-on；触发条件（on:）、缓存键、permissions 面零改动，release-context/publish 的 contents: write 权限与原状一致。
- workflows 引用的脚本/路径全部存在：check-vitest-coverage.mjs、check-node-test-coverage.mjs、check-process-smoke.sh、lib/ci-matrix-row.mjs、ci-floor-policy.test.ts、evals/short_swe 全套 8 个 py、scripts/benchmarks/pyproject.toml、release.mjs、lib/fork-gate.mjs、preflight-push.sh、latest-ci-run.sh、check-platform-coverage.sh、check-tag-skip-ledger.sh、check-browser-smoke.mjs、check-installer.mjs、sync-versions.js、check-test-private-probes.mjs、check-npm-release-cooldown.mjs、test-private-probe-baseline.json 逐一 ls 验证。
- test-hygiene 5 分钟 timeout 未动且该作业无 apt 安装步骤，不受 apt 停摆风险影响。
- ai 行 nothing 预算 19 与窗口内新增的 4 个 ai 测试文件（sse-parse-error-truncation / codex-usage-limit / oauth-error-redaction / openai-refusal，均为非 live-provider 单测）不冲突，run 日志确认 nothing-files 仍为 19。

## 六、修复排序建议（供第八波排期）

> 顺序上先并第七波（W7-HANDOFF-20261009.md，已在 lane 分支），再修本账——两波共享 interactive-mode.ts / agent-session.ts 等文件，先并后修冲突面最小。

- **批 A（诚实性 + 无人值守，先修）**：agent-session.ts:3535 熔断耗尽 goal 判死（连带改 FORK_NOTES 口径）；state-snapshot.ts:49 恢复提醒按前缀清单过滤（连带改 FORK_NOTES）；print-mode.ts:148 json 模式 rlm_child_failure 退出码 0；self-recovery.ts:446 完成门信任了显示层设置 changeTracking；quota-park.ts:785 导航取消+过期 park 静默丢弃。
- **批 B（终端与输入）**：terminal.ts:826 alt-screen 交接后 exit guard 失明；editor.ts:912 短 forced-bulk 多行粘贴压一行；anthropic.ts:467 不可解析错误帧无界。
- **批 C（显示与性能）**：markdown.ts:959 emphasis 掩码全段扫描（P1 增量化回退）；turn-timeline.ts:497 KernelActivity 补 name 字段；ipython-cell.ts:876 traceback 未洗；duty-log.ts:582 模型终答未洗；settings-selector.ts:76 autocompact 项目层钉死。
- **批 D（工具与测试债）**：pre-push-secret-scan.mjs:170 邮箱豁免收窄；daemon-crash-recovery-chain.test.ts:397 循环守卫；agents-view-mode.test.ts:1070 探针改公共入口驱动。
- 低优先 62 条按批内顺带处理或挂观察（清单见第四节）。

## 八、合并后对抗复审（W7+W8 合入后、推送前，2026-10-09）

> 8 车道 13 代理审 3b57591a4..HEAD（W7 九车道内容从未被审 + W8 16 修核验）。确认 5 条 should（0 must）、26 条低优先、143 条销账、证伪 0。W8 的 16 修核验车道零确认问题——修复批全部存活。

### 8.1. Remote-image downgrade guard misses single-slash / colon-only scheme URLs, export still phones home

- **级别**：should（车道 `w7-tui-render`）
- **位置**：`packages/coding-agent/src/core/export-html/template.js:1533`
- **现状**：w7-render 给 template.js 的 image renderer 加了远程图片降级：`/^(?:[a-z][a-z0-9+.-]*:)?\/\//i` 命中才降级为纯链接，否则仍输出 `<img src>`。提交声明是「打开导出不会向模型文本点名的任意主机回连」。但按 WHATWG URL 解析规则，特殊 scheme（http/https/ftp）后的斜杠数量与形态会被归一：`https:/evil.com/x.png`、`https:evil.com/x.png`、`https:/\/evil.com/x.png` 都解析为 `https://evil.com/...`，全部绕过该正则。
- **后果**：会话中的模型可控文本包含 `![x](https:/evil.com/pixel.png)`（单斜杠或零斜杠写法）：marked 产出 image token，href 不匹配降级正则，导出 HTML 里保留 `<img src="https:/evil.com/pixel.png">`；浏览器归一后打开导出即自动请求 evil.com——恰好复现该修复要堵的回连/追踪泄漏。
- **证据**：template.js:1533 `if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(href)) {`；1537 行 `<img src=" + escapeHtml(href)`；WHATWG URL 标准 special authority slashes/ignore-slashes 状态接受 0-N 个 '/' 或 '\\'。
- **修法**：不要用形态正则判断「远程」：在渲染端用 `new URL(href, document.baseURI)` 解析后检查 protocol 是否为 http/https/ftp（或非 file: 且非相对路径），解析失败再退回正则；这样覆盖单斜杠、零斜杠与反斜杠变体。
- **复核确认**：(1) 代码与 finding 假设一致：template.js image renderer（实际守卫在 1532-1536 行，`if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(href))` 命中才降级为 `<a class="image-link">`，不命中则在 1537 行输出 `<img src="…">`。正则要求 scheme 后紧跟字面 `//`。

(2) 失败场景可达，已实证两端：
- 渲染端：用仓库实际依赖的 marked 18.0.14（`marked.Lexer`，gfm+breaks，与 template.js 1497-1498 行配置相同）解析 `![x](https:/evil.com/pixel.png)` 与 `![y](https:evil.com/x.png)`，均产出 image token 且 href 原样保留为单斜杠/零斜杠形态（marked 不做 URL 归一）。这两种形态都不匹配守卫正则（scheme 组后缺 `//`），落入 1537 行 `<img src>` 分支。
- 浏览器端：WHATWG URL 解析对 special scheme（http/https/ftp/ws/wss/file）在 scheme 后进入 special authority slashes → special authority ignore slashes 状态，跳过任意数量（含零个）的 `/` 与 `\`，故 `https:/evil.com/pixel.png`、`https:evil.com/x.png` 都归一为 `https://evil.com/...`，img 自动加载即回连。导出 HTML 无 CSP meta、无 `<base>`（grep template.html/main.ts/template.js 无 Content-Security-Policy/sandbox 命中），回连不被任何层拦截。

(3) 别处未处理：git log 显示 template.js 最后一次改动就是引入该守卫的 w7-render 提交 c486c7846，提交声明即「opening an export does not phone home to hosts named in model-controlled session text」；后续 w8 各批（990b966d5 等）未再触及。现有回归测试 test/export-html-template.test.ts:995 只用规范形态 `https://tracker.example/pixel.png`，且测试自己的检测正则 `^(?:https?:)?\/\//`（1002 行）与守卫同构，同样看不见单斜杠/零斜杠变体——测试绿灯与绕过并存。

(4) 非已知延后欠账：FORK_NOTES / W7-HANDOFF / W8 计划中均无此项处置记录。

修复建议（与 finding 一致）：渲染端改用 `new URL(href)`（或 `try { new URL(href) } catch` 相对路径分支）判定 protocol ∈ http/https/ftp 即降级，形态正则只作解析失败的兜底。severity 维持 should：完整恢复了该修复要堵的打开即回连/追踪信标泄漏，但仅泄露「文件被打开」这一信号，不泄露会话内容，且需要模型输出畸形形态 URL。

### 8.2. TS stripControlCharacters OSC branch over-consumes after an ST terminator, unlike the Python fix in the same wave

- **级别**：should（车道 `w7-backend`）
- **位置**：`packages/ai/src/utils/sanitize-control.ts:11`
- **现状**：同一波里 Python 侧（commit 046682ba9，prime-agent-runtime/src/rlm/effects.py:165 与 mcp.py:30）把 OSC 内容类从 [^\x07] 修成 [^\x07\x1b]，理由写明「[^\x07]* would swallow the ST terminator and everything after it」；但同波新增的 TS 洗涤（commit 1a5d185fb）ANSI_SEQUENCE 仍是 \][^\x07]*(?:\x07|\x1b\\)?，ST 终止的 OSC（含 OSC 8 超链接，Claude Code CLI 常用）会贪婪吃到下一个 BEL 或字符串末尾，把后面的正文一并删掉。claude-code.ts:1183 的 stderr 尾洗涤和 proxy.ts 的 sanitizeProxyErrorText 都用它。
- **后果**：claude-code CLI 失败时 stderr 先输出一条 OSC 8 超链接（\x1b]8;;file:///x\x1b\）再输出真正的错误行：stripControlCharacters 把从 ESC 起到字符串末尾整段吞掉，持久化的 errorMessage 丢失全部诊断文本，用户只看到「the CLI exited with code 1」而无原因；proxy 错误体同样受影响。Python 侧同场景已修复，两侧口径不一致正是车道要点问的「Python 侧与 TS 侧同口径吗」的否定答案。
- **证据**：sanitize-control.ts:11 与 effects.py:165 / mcp.py:30 的模式逐字符对比；claude-code stderr-escape 测试只覆盖 CSI+BEL（\x1b[2J\x07），无 OSC-ST 用例，故未红。
- **修法**：把 ANSI_SEQUENCE 的 OSC 分支改成与 Python 侧同口径：\][^\x07\x1b]*(?:\x07|\x1b\\)?，并补一条 ST 终止 OSC 的单元测试（当前该函数无直接测试）。
- **复核确认**：(1) 代码与 finding 假设完全一致。HEAD 的 packages/ai/src/utils/sanitize-control.ts:11 ANSI_SEQUENCE OSC 分支是 `\][^\x07]*(?:\x07|\x1b\\)?`，内容类未排除 ESC；而同波 Python 侧 prime-agent-runtime/src/rlm/effects.py:167 与 mcp.py:30（commit 046682ba9，squash 进 f4579bdd0）均为 `\][^\x07\x1b]*(?:\x07|\x1b\\)?`，且提交说明明确写了排除理由「[^\\x07]* would swallow the ST terminator and everything after it」。实测验证：`"prefix \x1b]8;;file:///x\x1b\\real error: auth failed"` 经该正则替换后只剩 `"prefix "`，ESC 起到串尾整段被吞；BEL 终止用例（`\x1b]8;;url\x07real error`）行为正确，即缺陷仅限 ST 终止的 OSC——与 finding 描述逐点吻合（贪婪的 [^\x07]* 先吃到串尾，可选终止符以空匹配成功，无需回溯）。

(2) 失败路径可达。两个调用点都真实存在：packages/ai/src/providers/claude-code.ts:1183（onExit 里 `stripControlCharacters(this.stderrTail).trim()` 拼进持久化 failure message，行 1185）；packages/agent/src/proxy.ts:23-24（sanitizeProxyErrorText，注释自述处理 server-controlled 文本）。proxy 路径的错误体是外部服务器控制的内容，出现 ST 终止 OSC（如 OSC 8 超链接）后跟诊断文本即可触发，errorMessage 诊断文本全丢。claude-code CLI stderr 是否必发 OSC 8 虽不确定，但只要出现任意 ST 终止 OSC 即触发，路径本身无任何前置洗涤。测试覆盖佐证 finding 的 evidence：packages/ai/test/claude-code.test.ts:349-350 的 stderr-escape 场景只发 `\x1b[2J\x07`（CSI+BEL），812-826 行断言也只查这两种字符，无 OSC-ST 用例，故现有测试不会红。

(3) 别处未处理。后续 CONTROL_CHARACTER 遍只能删除残留裸 ESC，无法找回已被整段删除的文本；git log 显示 sanitize-control.ts 自创建（1a5d185fb/f4579bdd0）后无任何后续修改，HEAD 正则仍是旧形状；后续 w8 各 fix 提交（990b966d5、5137c8eae 等）均未触及此文件。

(4) 不是已知延后欠账。W7-HANDOFF-20261009.md、W8-FIX-PLAN-20261009.md、REVIEW-FIXUP-20261004.md 中均无 sanitize-control/OSC 相关条目；046682ba9 提交说明只提 mcp.py 同步，未提 TS 侧拷贝——两侧口径不一致属实且未登记。

severity 维持 should：无安全或数据损坏后果，但这是可达的错误信息保真缺陷（持久化 errorMessage 丢诊断文本），修复是一处字符类改动加一条单测，且破坏了同波刻意建立的 Python/TS 同口径，不应降级，也够不上 must。

### 8.3. Grapheme-safe preview cut is half-landed: the streaming accumulator still slices code units

- **级别**：should（车道 `w7-backend`）
- **位置**：`packages/coding-agent/src/core/rlm-child-run.ts:574`
- **现状**：commit 2584f94d2 只把 compactRlmText 换成 truncateGraphemes，其声称的增量等价物 RlmChildStreamPreview.applyCap（rlm-child-run.ts:574）仍是 trimmed.slice(0, maxLength - 3) 码元切，类注释（:508）还承诺 update() 返回值与 compactRlmText(textSoFar, maxLength) 完全一致——现在字素文本下两者不再相等。
- **后果**：子代理流式回答含 emoji/ZWJ 连字且超过 160 字符时，agents-view 的流式预览（走 RlmChildStreamPreview）在第 157 码元处把代理对切成两半，下游渲染出 U+FFFD——正是该提交 changelog（「compactRlmText cuts previews on grapheme boundaries … agents-view rows then render as U+FFFD litter」）声称消灭的现象；冻结的 cappedResult 会带着半个代理对持续显示到消息落定才被 compactRlmText 的结果替换。
- **证据**：rlm-child-run.ts:574 的 cappedResult 赋值仍是 slice；2584f94d2 对 rlm-child-run.ts 的 diff 只有 compactRlmText 一处 + import；新增测试 rlm-child-stream-scaling.test.ts:496 只测 compactRlmText 未测 RlmChildStreamPreview。
- **修法**：applyCap 里用同一个 truncateGraphemes(trimmed, maxLength - 3)（去掉 trimEnd 或在截断前做），并给 RlmChildStreamPreview 补一条与 compactRlmText 等价性的字素边界测试。
- **复核确认**：HEAD (merge/repl-kernel, 990b966d5) 实测全部命中 finding：(1) rlm-child-run.ts:570-577 的 applyCap 仍是 `trimmed.slice(0, Math.max(0, this.maxLength - 3)).trimEnd() + "..."` 码元切（还带 compactRlmText 已删掉的 trimEnd），2584f94d2 对该文件的 diff 仅改 compactRlmText(:316-321 换 truncateGraphemes)+import；类注释 rlm-child-run.ts:506 仍承诺 `update()` 返回值与 `compactRlmText(textSoFar, maxLength)` 完全一致，字素文本下已不成立（截边界不同 + trimEnd 差异）。(2) 失败路径可达：message_update → rlmChildStreamingPreviewText(rlm-child-run.ts:797-801) 写 run.answerPreview → 快照(:400) → rlm_child_update(:1112) → daemon-agent-connection.ts:2451-2461 转发 → live-turn-flow.ts:776-779 时间线子代理行 report 与 agents-view-state.ts:1093-1094/1142 的 answer 行（经 sanitizeRowText，display-text.ts:25-27 只洗转义/控制符、不洗孤立代理项）都会渲染；Node UTF-8 输出把孤立高位代理编为 U+FFFD，且 cappedResult 冻结后 buf 清空，半个代理对持续显示到 :794-795 消息落定才被 compactRlmText 替换。(3) 无别处处理：后续仅 f4579bdd0 再触此文件，diff 只复用 compactRlmText 改动；W7-HANDOFF/W8-FIX-PLAN/REVIEW-FIXUP 三文档均无 RlmChildStreamPreview/applyCap 记载，FORK_NOTES 只提 truncateGraphemes 的三方合并冲突。(4) 非已知欠账：新增测试 rlm-child-stream-scaling.test.ts:496-507 只测 compactRlmText，既有等价断言(:256/:391/:434)用纯 ASCII 故仍绿。severity 维持 should：用户可见但会自愈的渲染缺陷 + 文档不变量失效，无功能损坏。

### 8.4. pendingWakeComms survives a session switch and leaks into the next session's first turn

- **级别**：should（车道 `w7-panel`）
- **位置**：`packages/coding-agent/src/modes/interactive/interactive-mode.ts:4175`
- **现状**：pendingWakeComms（1863 行声明，7379 行在报告落到已结束回合之后自增）只在 setCurrent 创建新回合摘要时清零（4319-4324 行）。会话切换路径 session_replaced → resetCurrentSessionRenderState（4095-4180 行）把 currentTurnState/currentTurnSummary、activityTracker、liveTurnFlowStore 等所有会话级状态全部重置，唯独不清 pendingWakeComms；renderSessionContext 重建（9584-9592 行）也直接赋值 currentTurnSummary、绕过 setCurrent 的清零。
- **后果**：会话 A 中一条子代理报告落在回合之间（比如配额 park 中断了上一回合、新回合未起，无人值守多日场景常见），此时切到会话 B（agents-view / session_replaced）：字段带着 A 的 1 进入 B。B 的第一个回合摘要经 setCurrent 创建时把这条陈旧计数灌进去，首回合的通信计数虚报 +N；而 B 的 replay 重建从 transcript 重新推导为 0，live 与 replay 计数从此分叉——正是车道声称的「replay 与 live 计数相等」被打破的路径。
- **证据**：resetCurrentSessionRenderState 尾部（4172-4175 行）: `this.liveTurnFlowStore?.reset(); this.currentTurnState = undefined; this.currentTurnSummary = undefined;` —— 无 pendingWakeComms 重置；字段自增在 7379 行 `else this.pendingWakeComms += 1;`，清零仅在 setCurrent（4319-4324 行）。同一函数把 activityTracker.reset() 等并列会话级状态都清了。
- **修法**：在 resetCurrentSessionRenderState 里与 currentTurnSummary = undefined 并列加一行 this.pendingWakeComms = 0（若担心重建路径，可在 renderSessionContext 完成后按「无 open turn 时同样清零」处理）。补一个回归测试：报告挂起 → session_replaced → 新会话首回合通信计数为 0。
- **复核确认**：代码与 finding 完全一致，且失败路径可达。(1) 字段仅在 interactive-mode.ts:1863 声明、7379 行自增（`else this.pendingWakeComms += 1;`，条件是 agent 会话报告消息在无未结束回合时到达——7371-7375 行注释明说这是设计场景「报告落在回合关闭后/首个之前」）、4319-4323 行 setCurrent 里清零，全仓 grep 无第四处写入。resetCurrentSessionRenderState（4095-4180）把并列的会话级状态全部清掉：activityTracker.reset()（4155）、liveTurnFlowStore?.reset()（4173）、currentTurnState/currentTurnSummary = undefined（4174-4175），唯独不清 pendingWakeComms。(2) 切换路径真实存在：会话切换经 daemon-agent-connection.ts:2565/2958 与 in-process-agent-connection.ts:109 发出 session_replaced，interactive-mode 6837-6850 处理：先 resetCurrentSessionRenderState()（6844，不清字段），再 renderInitialMessages → renderSessionContext，而 9584-9592 直接赋值 currentTurnSummary、绕过 setCurrent 的清零，所以挂起计数原样带入会话 B。(3) B 的首回合：live-turn-flow.ts ensureCurrent()（178-194）创建新回合摘要后调 host.setCurrent(summary)（190）→ interactive-mode.ts:4319-4323 把陈旧 N 灌进 B 首回合的 addCommMessage；而 replay 路径用函数局部变量 pendingWakeComms（conversation-components.ts:648，903-906 处同样清入回合）从 B 自己的 transcript 推导为 0——报告消息属于 A 的 transcript——live 与 replay 通信计数自此分叉，恰好破坏 7374-7375 行注释承诺的「keeping the live and replay comm counts equal」。前置条件（报告落在回合之间后用户切会话，如配额 park 打断后无人值守多日）正是本仓用户画像下的常见状态。(4) 无已处理痕迹：git log --grep=pendingWakeComms 为空，REVIEW-FIXUP-20261004.md / W7-HANDOFF / W8-FIX-PLAN 均未提此字段，不是已知延后欠账。修复建议（在 4175 行旁加 this.pendingWakeComms = 0）与代码风格一致。严重度维持 should：纯显示计数缺陷（首回合通信数虚报 + live/replay 分叉），不损数据不致崩溃，但破坏代码内明文承诺的不变量且可达。

### 8.5. Extension overlayOptions factory now runs per render and per keypress with no error containment

- **级别**：should（车道 `w7-ui`）
- **位置**：`packages/coding-agent/src/modes/interactive/interactive-mode.ts:5603`
- **现状**：daa970736 把 showOverlay(component, resolveOptions()) 改为传入函数本身，TUI 由此在每帧 compositeOverlays（tui.ts:1726 render 路径）、每次按键路由（tui.ts:838 → getTopmostVisibleOverlay:757）、以及鼠标跟踪判定时都会调用扩展提供的 overlayOptions 工厂；但整条渲染/输入路径没有任何 catch（doRender 与 compositeOverlays 调用点 tui.ts:2327 无 try，withFullscreenImageFallback 只有 finally 无 catch），而改动前该工厂只在 showOverlay 的 promise 链里求值一次，异常被 .catch 捕获并经 showExtensionError 呈现为扩展错误后关闭对话框。
- **后果**：扩展传入 overlayOptions: () => compute(state)（extensions/types.ts:188 声明的公开函数形式），某次 state 使工厂抛错：旧代码只在打开时抛一次、显示扩展错误并正常收尾；现在每次 requestRender 的 process.nextTick 里 doRender 都抛出 → uncaughtException，daemon 进程按 daemon-mode.ts:752 的处理器退出整个进程（无人值守多日运行中断），客户端进程则直接崩溃，且每次重渲染都会再抛。
- **证据**：git show daa970736 -- packages/tui/src/tui.ts（签名 OverlayOptions|(()=>OverlayOptions) 与 resolveOverlayOptions 四处调用点）；tui.ts:2327 `newLines = this.compositeOverlays(...)` 无 try；components/image.ts:18-26 withFullscreenImageFallback 仅有 finally；tui.ts:757-759 getTopmostVisibleOverlay 在 tui.ts:838 输入路径被调用；daemon-mode.ts:752-755 uncaughtException 处理器。
- **修法**：在 interactive-mode 的 resolveOptions 或 tui.ts 的 resolveOverlayOptions 内用 try/catch 包住工厂调用，抛错时回退 undefined（或退回打开时的静态快照），并把错误经 showExtensionError 路由出去，与改动前的错误收纳面等价。
- **复核确认**：代码与假设一致。daa970736 确实把 interactive-mode.ts:5603 的 `this.ui.showOverlay(component, resolveOptions)`（求值一次）改为传入函数本身（`showOverlay(component, resolveOptions)`，见该 commit diff；HEAD 同形），tui.ts 侧签名随之变为 `OverlayOptions | (() => OverlayOptions | undefined)`（tui.ts:631）。HEAD 上 `resolveOverlayOptions`（tui.ts:740-744）裸调用工厂，无任何 try；调用点覆盖：compositeOverlays 每帧（tui.ts:1727，函数内无 try）、`visible` 判定（tui.ts:749）、按键路由 handleInput→reclaimModalFocus→getTopmostVisibleOverlay（tui.ts:1330→1296-1303→757-761，handleInput 全程无 try，stdin data 事件裸派发 terminal.ts:382-389）、鼠标跟踪判定（tui.ts:771）。渲染侧 doRender（tui.ts:2290）对 `newLines = this.compositeOverlays(...)`（tui.ts:2326-2327）无 try，且 doRender 经 requestRender 的 `process.nextTick`（tui.ts:977、988）调度——此处抛错即 uncaughtException；fullscreen 路径的 withFullscreenImageFallback（image.ts:18-26）确实只有 try/finally，rethrow。扩展 API 公开声明函数形式（extensions/types.ts:186-188「Can be static or a function for dynamic updates」），且 interactive-mode 的 resolveOptions（interactive-mode.ts:5587-5599）直接调用扩展工厂、无 catch。旧代码（改动前）工厂只在 showExtensionCustom 的 .then 里求值一次，抛错由 .catch→reject（interactive-mode.ts:5605-5609）回到扩展调用点，被 runner 的错误边界（runner.ts:605-633 emitError）经 onError→showExtensionError（interactive-mode.ts:3613-3615、5626）收纳——旧收纳面描述属实。

失败路径可达但机制需修正一处：崩溃发生在本地 in-process 扩展会话的交互客户端进程，不是 daemon worker。daemon 会话不支持 custom overlay——daemon-extension-binding.ts:243-254 的 `custom()` 直接按 cancelled 返回并提示一次，工厂在 daemon 侧根本不会跑；daemon-mode.ts:752 的 uncaughtException 处理器（exit(1)）只装在 detached daemon 进程（daemon-mode.ts:1024-1032），TUI 不在其中。而交互客户端进程没有任何 uncaughtException 处理器（全仓只有 daemon/ supervisor 装），所以实际表现是客户端进程 Node 默认崩溃（打栈、退出）——对无人值守挂着 TUI 的运行同样是中断，finding 的「无人值守多日运行中断」结论方向成立，只是「daemon 进程退出」这一环归因错了进程。

别处无处置：daa970736 之后没有任何 commit 再动 packages/tui/src/tui.ts；990b966d5（w8 display 批）未触及 overlay options 路径；REVIEW-FIXUP-20261004.md / W8-FIX-PLAN-20261009.md / W7-HANDOFF-20261009.md 均未提及此项。也不是已知欠账：w7-ui changelog fragment（packages/coding-agent/.changes/w7-ui.md:10「Fixed extension overlayOptions functions being evaluated only instead of live」）把这当作有意修复，未记录错误收纳被丢掉。结论：per-frame / per-keypress 无收纳地调用扩展回调、一旦抛错即进程级崩溃的回归成立，建议按 fix 所述在 resolveOptions/resolveOverlayOptions 加 try 并路由 showExtensionError。severity 维持 should：触发需要一个会抛错的第三方扩展工厂（非默认路径），但相对改动前的收纳面是明确回归，且冲击面是整进程。

### 低优先 / 观察项（未复核）

- **[low]** Preserved quotaPark on a field-less session_replaced can revive an already-lifted park（`packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.ts:2546`，车道 `w7-protocol`）——R2-M11 的「字段缺席 = 保持现状」把 quotaPark 从 previousSnapshot 原样保留到新的 latestSnapshot，但 latestSnapshot.quotaPark 在收到终态 parked:false 心跳时不会被清除（daemon-agent-connection 的 quota_park_status 分支只 forward 不写快照缓存，interactive 的 handleQuotaParkStatus(parked:false) 只 clearQuotaPark 清 UI 不清快照）。于是 park 解除之后再收到一帧不带字段的 session_replaced（worker 现场 rebind 广播从不带字段；supervisor drain 在未 park 时也省略字段），renderInitialMessages 会把过期 park 重新种回 UI。
- **[note]** setEditorText insert payload flag grew without protocol classification and RPC docs still describe the old semantics（`packages/coding-agent/src/modes/daemon/daemon-extension-binding.ts:258`，车道 `w7-protocol`）——w7-ui 合入的 pasteToEditor→emitUiRequest("setEditorText",{text,insert:true}) 改变了 extension_ui_request 的 payload 形状（RPC 面的 set_editor_text 事件也随之多出 insert 键），但 squash 提交 daa970736 的提交说明既没按 AGENTS.md「Daemon Protocol Changes」给出分类，也没列 setEditorText payload 的消费方清单；docs/rpc.md 仍写「pasteToEditor() delegates to setEditorText() (no paste/collapse handling)」且 set_editor_text 节没有 insert 字段。
- **[low]** Degraded-only partial restore collapses to the routine recovered label（`packages/coding-agent/src/modes/interactive/components/injected-prompt-message.ts:376`，车道 `w7-restore-route`）——restoreLabel() 只把 failed+notSaved 计入 lost 并据此决定告警色；一个 restore 若所有名字都 degraded（模型侧通知明说这些名字『can silently misbehandle』要重建）而 failed/notSaved 为空，收起态标签是『◆ Python 环境已恢复』且无 warning 色，与模型侧对该档的严重性定性相矛盾。
- **[note]** Legacy pre-roster messages still collapse to the boolean recovered label even when their own prose names lost names（`packages/coding-agent/src/modes/interactive/components/injected-prompt-message.ts:382`，车道 `w7-restore-route`）——R6-M4 的目标是让部分恢复失败对主人可见，但对本波之前写下的消息（details 只有 restored 布尔），内容里写着『These could not be restored: old_df』的旧部分恢复，收起标签仍是『Python 环境已恢复』；4530 的 legacy 用例自己就钉住了这个行为。
- **[note]** rename/cron_add to a passivated row by id-suffix selector still fails (pre-existing, now in the user's words)（`packages/coding-agent/src/modes/daemon/daemon-mode.ts:2262`，车道 `w7-restore-route`）——supervisor 的 matchWorkers 支持 id 后缀选择符（matchesSessionIdSuffix），会把被动行匹配到并原样转发后缀；但 worker 侧 findPassiveRlmSubagent 只匹配 childId/完整路径/完整 info.id/name，不匹配后缀，被动行的后缀 rename/cron_add 仍然失败（错误按用户原词返回）。resident 行的后缀经 resolveActiveSessionState 可匹配。
- **[low]** Non-SGR strip regex either swallows the rest of a line (unterminated OSC) or leaks it — claim of clean stripping only holds for BEL/ST-terminated sequences（`packages/coding-agent/src/core/export-html/ansi-to-html.ts:223`，车道 `w7-tui-render`）——w7-render 声明非 SGR 转义「剥离而非泄漏为可见垃圾」。NON_SGR_ESCAPE_REGEX 的 OSC 分支是 `\x1b[\]P_X^][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)`：终止符只能是 BEL、ST 或串尾。两个相反的缺口：(1) 行内出现一个未终止的 `\x1b]`（后面既无 BEL 也无 ESC）时，`[...]*` 贪婪吃到行尾且 `$` 命中，整段后续文本被当转义剥掉；(2) 未终止 OSC 后紧跟的是 ESC 开头的其他序列（如 `\x1b]8;;u\x1b[31m`）时终止符全不命中，整个匹配失败，`]8;;u` 作为可见垃圾泄漏。
- **[note]** OSC 52 copy fallback silently no-ops above the 100k cap with no user feedback（`packages/tui/src/tui.ts:1192`，车道 `w7-tui-render`）——w7 给 TUI 的 OSC 52 复制回退加了 100_000 base64 上限，超限直接 return。coding-agent 路径 onCopy 走原生剪贴板（pbcopy/wl-copy 等）失败会抛错并提示；但未设置 onCopy 的纯 tui 消费者（库的直接使用方）落回这条静默路径。
- **[low]** truncateRawPayload halves surrogate pairs at the 2000-code-unit cap（`packages/ai/src/utils/stream-failure.ts:146`，车道 `w7-backend`）——truncateRawPayload 用 raw.slice(0, MAX_RAW_LENGTH) 纯码元切，第 2000/2001 码元处若是一个代理对会被切半；同波其它截断点（mistral truncateErrorText、display-text truncateGraphemes）专门为此改成字素切，唯独这个被 w8 新路由进用户可见 errorMessage 的截断点没改。
- **[note]** Claim mismatch: neither errorMessage nor info.raw keeps the full unparseable frame（`packages/ai/src/providers/anthropic.ts:469`，车道 `w7-backend`）——w8 commit 6aa772a44 的 changelog 说「the full frame stays on the structured diagnostic」，anthropic.ts:468 的代码注释说「the full frame survives only there (info.raw)」，但 info.raw 本身就是 truncateRawPayload(data)（:475，MAX_RAW_LENGTH=2000，stream-failure.ts:143-146）；新加的 catch 分支 detail 同样截断。没有任何地方保留全文。车道重点问的「errorMessage 有界 + info.raw 全文」分层实际是两层都只有 2000 字符界。
- **[note]** Aborted-marker removal rests on an untested reachability claim for partial cells（`packages/coding-agent/src/modes/interactive/components/ipython-cell.ts:529`，车道 `w7-backend`）——被删的 case "aborted"（warning ✗）依赖新注释「interrupt gate 先返回、status 只随落定结果到达」。marker 的 gate（ipython-cell.ts:518）要求 !this.state.isPartial，而 isPartial 是工具调用流式未完标志；details.status 出现在结果块里，结果块先到、消息仍 isPartial 的窗口内若 status=aborted，现在落入 default 渲染成排队中的 ◇ 而非原先的 ✗。未能构造出确定可达的生产路径（abort 通常直接 settle 结果），但「总是先落 interrupted gate」这一断言没有测试背书。
- **[low]** Pinned quota-park row ellipsis-cuts the shortest form, which can cut into the re-park count digits（`packages/coding-agent/src/modes/interactive/interactive-mode.ts:8746`，车道 `w7-panel`）——w7-panel 把 pinned 状态行的兜底从「整行截断 fullest」改成「先按宽选形，全放不下才对最短形做省略号硬切」。quotaParkForms 把第 N 次重 park 的计数缀在包括最短形在内的每个形上（footer.ts:267 行 `额度等待${count}`），于是硬切可以落在计数中间；这与 R2-M9 修好的配额 chip 选形口径（梯级只整段丢弃、注释明言 segments never truncate into a wrong number）不一致。
- **[low]** Bare async-bash completion preview label escapes the 后台命令 queue label and reads as an interjection（`packages/coding-agent/src/modes/interactive/interactive-mode.ts:534`，车道 `w7-panel`）——Q 组把后台命令完成纳入队列预览标签表，但前缀键写死为 `${ASYNC_BASH_COMPLETION_PREVIEW_LABEL}: `（带冒号空格）。queuedAgentMessagePreview 对 customType 匹配而 details 缺失的排队消息返回裸标签 `Background command finished`（agent-session.ts:1293-1294 行，作者显式处理了该分支），不带 `: ` 后缀，startsWith 不命中。
- **[low]** Extension editor spawn errors stack one row per retry without dedup（`packages/coding-agent/src/modes/interactive/components/extension-editor.ts:151`，车道 `w7-ui`）——showErrorLine 每次调用都在底栏前插入一行新的错误 Text，不清理也不去重上一次的错误行；「编辑器命令为空」守卫（:110）与 spawn 失败（:146）两个调用点都可被反复触发。
- **[low]** Settings panel maxVisible is frozen at construction; resizing while open does not re-adapt（`packages/coding-agent/src/modes/interactive/components/settings-selector.ts:597`，车道 `w7-ui`）——本次修复让 maxVisible 按终端行数自适应，但 getRows 只在 SettingsSelectorComponent 构造时求值一次并固化进 SettingsList。
- **[low]** Hidden search field at critical row shortage keeps an invisible filter applied（`packages/coding-agent/src/modes/interactive/components/oauth-selector.ts:413`，车道 `w7-ui`）——criticalShortage 时隐藏搜索区并停止把按键送入 searchInput（handleInput 的 else if (!this.criticalShortage) 分支），但既不清空已输入的过滤词，filteredProviders 也仍按旧词过滤；prime-team-selector 同构。
- **[note]** RPC binding still maps pasteToEditor to a wholesale draft replace（`packages/coding-agent/src/modes/rpc/rpc-extension-ui-context.ts:116`，车道 `w7-ui`）——insert 语义只在 daemon 线（daemon-extension-binding.ts:258）和 in-process 线（interactive-mode.ts:5173）落地；RPC 绑定的 pasteToEditor 直接调 setEditorText 整段替换，insert 意图在 RPC 面被丢弃。这是既存差异（本提交未声称覆盖 RPC），但与「pasteToEditor 在光标处插入」的统一语义目标相悖，记录为风险。
- **[note]** Skill name check misses invisible non-whitespace characters (ZWSP/BOM/WJ)（`packages/coding-agent/src/core/skills.ts:160`，车道 `w7-ui`）——nameIsUnaddressable 只测 \s 与 C0/C1/DEL；零宽类字符（U+200B、U+2060、U+FEFF 等）不属于 \s 也不在控制字节区间，携带它们的 name 照常载入（validateName 的 charset 检查仅是警告）。
- **[low]** Snapshot routine-skip keeps a reason-string fallback that can hide a real user loss（`packages/coding-agent/src/core/kernel/state-snapshot.ts:63`，车道 `w8-verify`）——isExpectedSnapshotSkip 保留 `entry.reason.includes("cannot pickle '_PrimeAgent")` 的按 reason 分类，与函数 docstring「classification is by name, never by the drop reason」直接矛盾：用户自命名的绑定若持有宿主注入对象（如 cell 里 `helper = websearch`），丢弃 reason 是 cannot pickle '_PrimeAgentCallableSkillModule'，会被按 routine 过滤掉。
- **[note]** changeTracking.enabled=false no longer suppresses the UI file-change rows when the finish gate is on（`packages/coding-agent/src/core/agent-session.ts:14546`，车道 `w8-verify`）——修法选了「tracker 保持安装 + 记录照发」：feed-data.readDetails 无条件读 details.fileChanges 进 feed，UI 没有独立的 changeTracking.enabled 显示门。display-only 开关关掉后，只要 finishGate 开（默认），文件改动行照常出现在时间线/活动面板。
- **[note]** scp exemption still passes email-colon-nospace-word shapes that are prose, not paths（`scripts/pre-push-secret-scan.mjs:180`，车道 `w8-verify`）——收窄后的 scp 豁免只要求冒号后第一个字符是路径形字符（字母/数字/./~/_//）；散文里「email:紧跟一个无空格词」与 scp 形状在该正则下不可区分。
- **[note]** Markdown memo perf A/B is a wall-clock assertion that can flake on a loaded machine（`packages/tui/test/markdown-backtick-guard.test.ts:140`，车道 `w8-verify`）——「memo run 必须 40%+ 快于 no-memo run」与「no-memo > 50ms」是单进程墙钟断言，受同机负载影响；正确性另有流式-vs-全量重lex 的差分 oracle 钉住，此条纯属测试稳定性风险。
- **[low]** Evicted extension dialog is never disposed: countdown interval keeps ticking until expiry（`packages/coding-agent/src/modes/interactive/interactive-mode.ts:5219`，车道 `cross-lane`）——R3-M4 的逐出路径 cancelActiveExtensionDialog 先把 activeExtensionDialog 置 undefined 再调 active?.cancel()，被逐对话框的 hide* 进入 stale-hide 守卫提前返回，跳过 component.dispose()；resetExtensionUI 的注释与 w8 测试的理由都声称逐出时已释放计时器，实际靠守卫挡住拆除而非释放。
- **[low]** pendingWakeComms survives session replacement and inflates the first turn of the next session（`packages/coding-agent/src/modes/interactive/interactive-mode.ts:4095`，车道 `cross-lane`）——T6/w8 的 pendingWakeComms 在 turn 结束后暂存待醒 comm、下一 turn 建立时冲入其 summary；但 resetCurrentSessionRenderState 清 currentTurnSummary/currentTurnState/liveTurnFlowStore 却不清 pendingWakeComms，换会话后计数跨会话存活。
- **[note]** formatBoxTokens near-million renders 1.0M where the footer renders 1M; comment claims the same rule（`packages/coding-agent/src/modes/interactive/components/turn-timeline.ts:889`，车道 `cross-lane`）——w8 把 formatBoxTokens 的 k 上限从 1,000,000 收到 999,500，注释称与页脚的「近百万提升为 1M」同一规则；但页脚 formatTokens 有 .replace(/\.0$/, "") 把 1.0M 写成 1M，turn 框的 M 分支没有这个去零，同值两处显示不一致。
- **[note]** Dead session.setAutoCompactionEnabled still writes the bare compaction.enabled key, diverging from every live per-model write path（`packages/coding-agent/src/core/agent-session.ts:13701`，车道 `cross-lane`）——所有活路径（in-process 连接、daemon 连接）的自动压缩开关都经 settingsManager.setCompactionEnabledForModel 写 per-model 键，agent-session 上的 session.setAutoCompactionEnabled（写裸 compaction.enabled）在 src 内已无调用者，语义与全部活路径相左。
- **[note]** BARE_LANE_ID misclassifies a hex-and-dash session name as a bare id, hiding the child's name（`packages/coding-agent/src/modes/interactive/components/turn-box.ts:519`，车道 `cross-lane`）——w8 为「不在 shown 的裸会话 id」加的 BARE_LANE_ID 正则把仅由十六进制字符与连字符组成（≥6 字符）的子代理名字误判为会话 id，例如 kebab 名 add-123、fba-42a 全部命中。

## 九、低优先积压四问分拣（2026-10-09，88 条）

> 老板四问（会再改吗/具体后果/正在发生吗/机会成本）作为**排序直觉**对 88 条低优先逐条分拣（4 路代理查代码与近 30 天提交热度）。结果：**12 条先修（GO）、76 条缓修**——缓修不弃置，属理论路径/罕见配置/复合触发，等碰到文件时捎带。

### 先修清单（GO，按工作量排）

1. **User-cancelled retry leaves stale _terminalFailureAttemptCount in the sleep window**（`packages/coding-agent/src/core/agent-session.ts:16306`）——过：Esc 取消重试倒计时后 _terminalFailureAttemptCount 残留被取消链的 attempt 数（abortRetry 在 17403 提前 return，跳过 17420 的清零；sleep catch 在 16341 后写），同会话后续一次非重试类失败的终端通报（16048 读、无写路径） 工作量：约 15 分钟：catch 路径不再携带被取消链的计数（clear, don't carry），补一条 Esc 取消后新失败报数正确的测试
2. **Heartbeat/RLM resume keeps the missing-cwd pause reason on lastError**（`packages/coding-agent/src/core/cron-jobs.ts:777`）——过：missing-cwd 刹车把原因写进 lastError（pauseJob，940 行），resumeHeartbeat（771-793）与 rlm heartbeat 的 resume 分支（670 行）都只改 status/nextRunAt、原样携带 lastError；heartbeat-manager. 工作量：约 15 分钟：两个 resume 分支各加 lastError: undefined
3. **backfill measurement render spends the armed TURN_KEY_REVEAL marker**（`packages/coding-agent/src/modes/interactive/interactive-mode.ts:9930`）——过：loadEarlierTranscriptPage 在 10017/10023 两次裸调 chatContainer.render() 量行数，级联到 TurnActivityComponent/TurnSummaryComponent 的 render() 会把 revealArmed 单发 marker 花进被 工作量：约 1 小时：让 Container 测量渲染经 renderForMeasurement 级联（本波已有三个同类先例可照抄）
4. **Patch walker misparses added lines whose content starts with '++ ' as file headers; '++ /dev/null' disables scanning for the rest of the file**（`scripts/pre-push-secret-scan.mjs:218`）——diff 里内容以 `+ /dev/null` 开头的 added 行（diff 行 `+++ /dev/null`）把 file 置 null（scanPatchText:229-234），该文件后续 hunk 的所有 added 行不再扫描——秘密静默漏过直达公开远端，正是该门存在要拦的 fd1dd4e4c 类事故 工作量：约 30-45 分钟（hunk 内不再把 `+++ `/`commit ` 当元数据 + 扩自测）
5. **Item 5-1 unchanged: mid-run attach still anchors the run clock at the first message the client sees, snapshot carries no turn start time**（`packages/coding-agent/src/modes/interactive/interactive-mode.ts:7206`）——slim 中途 attach（尾部窗口=100 条，daemon-protocol.ts:936）时状态栏「工作中 X」从窗口内最旧可见消息起算——restoreTurnStartFromMessages:4604-4611 注释自己承认「有界少报」；长工具回合下少报可达小时级，而本用户恰是多天无人值守后 attach 工作量：约 1-1.5 小时（快照字段+协议注释+digest+测试）
6. **Failed manual /refine row promises an automatic retry that never happens**（`packages/coding-agent/src/modes/interactive/components/refinement-outcome-message.ts:97`）——手动 /refine 失败时收据（messages.ts:1253-1273 的 createRefinementFailureMessage 不带 details.source）渲染成「整理器这次没给出结果（reason），下一轮会再试」（:97）；而调度器失败语义明确不重试（refine-scheduler.ts: 工作量：约 30-45 分钟（收据带 source+显示分支+测试）
7. **refinement-receipt skip can never suppress re-delivery after refine deletes (pre-window, moved verbatim)**（`packages/coding-agent/src/core/harness-digest.ts:349`）——删除类 edit 记录的是删除前版本号（refine-execution.ts:589-593 取 edit.before.version），删除后 fingerprint 不含该 key，harness-digest.ts:349-352 的 every 比对 number !== undefined 恒失败——本会 工作量：约 30-45 分钟（删除哨兵版本+测试）
8. **SHELL_WRITE_COMMAND misses unzip/tar -x/curl -o style project-file writes**（`packages/coding-agent/src/core/self-recovery.ts:307`）——后果具体：模型跑绿测试后用 curl -o/unzip/tar -x 写项目文件再宣称完成，正则不 void 这次 green，守门放行假完成——正是注释自认的「stale pass standing」，在无人值守多日跑里直接骗到老板。 工作量：30 分钟内（正则加四个分支+测试）
9. **Preserved quotaPark on a field-less session_replaced can revive an already-lifted park**（`packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.ts:2546`）——后果具体且持续：额度 park 解除后（parked:false 只在解除瞬间广播一次），快照缓存里的旧 quotaPark 未清（quota_park_status 分支纯 forward 不写 latestSnapshot）；随后任一带不上字段的 session_replaced（daemon-mode.ts:10 工作量：30-45 分钟（清缓存点+回归测试）
10. **Degraded-only partial restore collapses to the routine recovered label**（`packages/coding-agent/src/modes/interactive/components/injected-prompt-message.ts:376`）——后果具体：恢复后所有名字都 degraded（内核侧明说「读快照冻结值、身份不匹配、会静默行为不准、用前须重定义」，state-snapshot.ts:279）时，restoreLabel 只把 failed/notSaved 计入 lost——收起行显示无警示色的「◆ Python 环境已恢复」；非技术老板只看收起行 工作量：20 分钟（label 分支+测试）
11. **rename/cron_add to a passivated row by id-suffix selector still fails (pre-existing, now in the user's words)**（`packages/coding-agent/src/modes/daemon/daemon-mode.ts:2262`）——用户对已被 idle sweep 被动化的子代理行用 id 后缀执行 rename/cron_add：supervisor 按后缀匹配到该行并把后缀原样转发（daemon-supervisor.ts:4617 的 preservesSelector 分支），worker 侧 findPassiveRlmSubagent 工作量：约 45-60 分钟：findPassiveRlmSubagent 补 matchesSessionIdSuffix 匹配 + 歧义处理 + 回归测试
12. **Snapshot routine-skip keeps a reason-string fallback that can hide a real user loss**（`packages/coding-agent/src/core/kernel/state-snapshot.ts:63`）——模型在 cell 里把宿主对象起别名（如 helper = bash，bash/rlm/mcp 是内核公共绑定）后，快照丢弃该名字的 reason 含 cannot pickle '_PrimeAgent…，被 reason 字符串兜底归为例行跳过，notSaved 通知不再提示；恢复后该名字无声消失，后续 cell  工作量：约 30-45 分钟（删 reason 兜底分支 + 核对通知噪音并调整测试）

### 缓修统计（NO-GO 76 条）

主因：Q3 不成立（理论/罕见形态）占绝大多数；少数 Q2 无具体后果（毫秒级性能、终端侧有界泄漏）；1 条经 HEAD 复核已修（claim 过期）。明细见分拣原始产出（本会话 /tmp/w9-triage-items.json + 蜂群 journal）。
