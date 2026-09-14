# Fork 更新记录

本文件是这个独立维护版本的**更新日志，最新的在最上面**。每条记录写清楚：改了什么、为什么改、对用户 / AI 能力的影响。深入细节见每节末尾链接的 `docs/fork/` 文档。

- 唯一主仓：[`Dmatut7/prime-agent-rlm`](https://github.com/Dmatut7/prime-agent-rlm)（GitHub 上不是 fork；本地 remote 名 `origin`）
- 主分支：`merge/repl-kernel`（只推 `origin/merge/repl-kernel`）
- 上游：`PrimeIntellect-ai/prime-agent`（本地 remote 名 `upstream`，只拉不推）
- 旧地址（路牌，不再开发）：`Dmatut7/prime-agent`（GitHub fork 网络，remote 名 `fork`）、`Dmatut7/prime-agent-x`（已归档，remote 名 `archive-x`）
- 上游同步分支：`sync/upstream-r3`
- 旧审计文档（R1/R2）：`docs/fork/audit-findings.md`、`docs/fork/fix-plan-r1.md`、`docs/fork/fix-plan-r2.md`

---

## 一览（每轮一行，最新的在上）

| 日期 | 这轮干了什么 |
|---|---|
| 2026-09-14 深夜⁴ | 让模型能看见自己的"记笔记"结果：精修结果此前被 `convertToLlm` 整类过滤 ⇒ 模型分不清"记住了一条教训"和"被拒了"，静默无效（写/读/反馈三环同断）。现在渲染成显式系统回执（含"不是用户指令"框定；applied / refused+原因），空结果仍不进上下文；先红后绿回归测试（基线 3 红 1 绿＝空结果守卫，改后 10 绿） |
| 2026-09-14 深夜³ | 修子会话记账的二次方路径：每条子 assistant 消息都重扫整份转录去找父条目，而目标是整个 run 的常量（真实会话触发 56,622 次、单次 ~4.9ms ⇒ 分钟级主线程阻塞 + 数十 GB 短命数组）；改为 run 内解析一次，附"查表次数不随子消息条数增长"的先红后绿回归测试（红：3→9 次快照；绿：3→3） |
| 2026-09-14 深夜² | 修"窗口开着开着就变慢"的实现放大项：agents 视图每次事件都重算本会话用量，而每次都是**整份转录两遍全量扫描**（memo 因每条 message_end 都追加条目而必然失效）；一个回合里这种重算可达几十次，10 万条转录时单次 ~10ms ⇒ 每回合数百毫秒 + 上百 MB 短命垃圾。改为增量折叠（只算新条目，结果与全量一致，附逐边界对拍测试） |
| 2026-09-15 凌晨³ | **修掉一条真外泄路径**：`/share` 的密钥预检只认 6 种形状，本机真实 bailian key（`sk-ws-…`116 字含点）与 882 字 JWT **都能走穿**，而会话里已经有 `ps eww` 带出的真 key ⇒ 分享出去就是"有链接即可读"的 gist。现在四条路检出：补齐前缀表（含点号 sk-、JWT 三段、各家云/GitHub/GitLab/HF/npm 令牌）、名称驱动赋值（`NAME=value` 及其 JSON 形式）、锚定高熵串（前 40 字内须有凭证名 ⇒ 不把 hash/base64 淹进来）、**以及与本进程真实加载过的凭证值逐字比对**（env/auth.json/models.json/MCP/--api-key）。命中报位置+掩码、不打印密钥、需确认才分享；真事故会话（16MB）0.5 秒扫完被拦。红：0/5 拦 → 绿：5/5 拦 |
| 2026-09-15 凌晨² | 修 TUI 两处：①**粘贴里的字面 `ESC[201~` 会让粘贴提前结束、后续字节被当按键执行**（实测 ctrl+right 真被执行）——改成"只在字节流安静时才收口"，三层（stdin-buffer/editor/input）同规则，注入序列 30/30 漏 → 0/30。②超限/超时/非括号大输入被**逐字符**送进编辑器（单行 O(n²)：1M 字符 210 秒）——生产者改按"文本运行段"批量发送、消费者新增一次性批量插入（打字仍逐键即时）⇒ 200k 7.97s→0.6ms、1M 210.5s→8.1ms；顺带修掉批量事件会被 `isKeyRelease` 当按键丢掉的门 |
| 2026-09-15 凌晨 | 修凭证两条：①**登出不是真删**——迁移把旧 `oauth.json` 改名成 `oauth.json.migrated`（mode=644、逐字含 access+refresh），登出只删 `auth.json` ⇒ 同机其他用户可读、**登出后 refresh 仍能换新 access**；改为「先原子写新库（0600/tmp+rename+fsync）、成功后才删旧库」，启动清历史副本，登出后**逐字节复查"还有谁能读到"**、读得到就抛错（两条交互路径都接住显示）。②`openai-codex` 在响应缺字段时把整段响应 JSON（含 access 令牌）打进错误串 ⇒ 改为只报字段名/类型/缺失，并加正控测试证明"含令牌的合成响应也不会回显" |
| 2026-09-15 凌晨⁵ | 让"绿"变得可信：①`repl-kernel-execute` 的 6 条**真内核用例在 CI 任何 job 都只 skip**（测试侧候选写的是已弃用的无后缀 venv 路径，CI 建的是带哈希的），本地却全绿——改成按产品 bootstrap 解析候选（顺带修好"没有仓内 venv 的机器上 `test:kernel` 静默全跳过"），CI 等价复现：改前 `6 skipped` / 改后 `6 passed`。②覆盖率/跳过闸从"只有 kernel job 有"泛化到**全部 8 个 vitest job**（参数化最小运行数/零运行文件数），自测放进每轮都跑的 test-hygiene；用本机 ai 报告喂 `--max-nothing-files 0` 立刻 RED 点名 17 个零运行文件 |
| 2026-09-15 凌晨 | 修"改了代码却跑旧产物还不吭声"三处：①源码运行时（`./prime-agent.sh`）的内核候选把**构建产物排在活源码前** ⇒ 改 Python 不重建、内核跑旧代码；改为按"运行中的模块在哪"决定优先（装/编译版仍优先自己那包），并响亮提示"用了构建副本"。②新 venv 装完不复检就报 "✓ ready"；改为装后复检、缺口点名+给下一步。③daemon 复用不看 buildId（传了不比不记日志）⇒ `npm run build` 后新 CLI 静默接旧 daemon、一个 daemon 里可能跑两个 build；改为三态（同身份复用／同级入口替换／其余响亮告警），wire/schema/协议一律未动 |
| 2026-09-15 凌晨⁴ | 修"回退位置只活在内存"：`branch()` 只改内存 leaf、`--resume` 靠文件最后一行 ⇒ 回退后若在任何追加之前停机/被杀，重开会**静默回到回退前的位置**。改为转录内记账 entry（`leaf_position`，parentId 指向目标、追加即持久化、`_buildIndex` 解析回它、**不改"最后一行"规则**、老转录照读、marker 不进模型也不成为 leaf）；顺带关掉两条同族洞（pinned compaction 落在回退之后会把位置拖回；in-memory 会话同样丢位置）。红 4 失败/1 通过 → 8 通过，另跑 session-manager 家族 191 + agent-session 家族 412 等 |
| 2026-09-15 凌晨 | 修两条时钟缺陷：①心跳/定时任务的"后写覆盖前写"用墙钟时间戳，写者时钟落后时用户的暂停/恢复/删除**被磁盘旧状态吃掉**，而 API 把**被丢弃的内存副本**当成功报给模型（面板还会弹回）；现在写入时间戳取"刚读到的副本 +1ms"起、写完读回校验、被别人赢走时抛 `CronJobsWriteDroppedError` 并带上磁盘真值。②设置/凭证两处同步等待用 `Date.now()` 自旋且无上限，时钟在自旋中回拨即**死循环占满事件循环**（探针 6 秒不返回被 kill）；改为单调钟 deadline + 阻塞等待 + 迭代上限，正常情况仍等满指定时长 |
| 2026-09-15 凌晨³ | 修内核快照与它的通知"说了做不到的事"：自动快照只排"成功跑完的 cell"（先定义变量再抛异常的改动不落盘），而重生通知却写死宣称"快照写于死前约 1.5 秒内"——实测死前 4 秒定义的变量丢失、通知只字未提。现在 cell 结束即排队（debounce 仍合并，成本不涨）、措辞改成**实测年龄**并给出唯一恒真的界（"此后任何 cell 改动的都不在其中"）；被跳过没存下的名字（不可序列化/超限）也由快照 manifest 带进两张通知点名+原因 |
| 2026-09-15 凌晨² | 修共享日志丢记录：尾部修复用 `ftruncate` 截断，在"读过之后、落刀之前"另一个进程 append 且**已 fsync** 的完整记录会被剪掉（两进程都报成功、零错误）。改为**就地涂白**（同长度空格覆盖残尾，永不删字节）：并发记录起点必在写那刻的 EOF 之上 ⇒ 结构上不可能被吃，且涂白幂等可交换。母席用双进程 harness 亲自复现：基线树 `wRecordPresent=false`（被吃）、修复树 `true`（保住）；34 项既有测试全绿 |
| 2026-09-15 凌晨 | 修流式"每帧重发整段内容"的平方放大：默认交互式路径直连 worker，从不检查 streaming 能力，紧凑增量被旁路 ⇒ 2 万字符回答在线上走 109MB、10 万字符 2.64GB（单条回答！）。现在直连路径按 attach 能力账本选路，工具参数改走片段（新能力 `streaming_delta_fragments` + schema 29→30，缺能力方退化成原 wire）⇒ 2 万字符 109MB→0.72MB、CPU 247ms→4.3ms；10 万 2.64GB→3.6MB、6.2s→23ms |
| 2026-09-14 深夜⁵ | 机器块加固（对抗线把上一版修法打穿后）：尾部锚定解析（闭合标签必须是文档最后一行、开标签整行严格形状、同标签取最后一个匹配）+ 四个标签统一走渲染器 + 渲染期分隔符守卫 + 自证挪到锚定之后（伪造块头过不了 count 检查）+ 代计数以 details 为权威 + `fromHook` 门补齐 ⇒ 堵掉"用工具路径参数伪造块头替换账本""散文裸标签吃掉真块""generation=99 抬高代计数"三条；18 条回归基线 11 红 → 全绿，31 文件 345 项通过 |
| 2026-09-14 深夜 | 修 bash 长行输出整段消失：输出以换行结尾且末行超 50KB 时，截断函数把"结尾换行"当成一个空行占了位置，于是"还没保住任何行"的守卫永不成立、尾部一行都不取 ⇒ 模型看到 "(no output)"、`!` 面板只剩路径提示。改为按"是否已保住有内容的行"判断，并补先红后绿的回归测试 |
| 2026-09-14 夜 | 修机器块被内容截断的静默丢数据缺陷：块体承载用户原话与错误签名，却只转义了属性；正文里出现 `</user-requests>` / `</fact-appendix>` 字面量就会提前收口，让下一代少读记录，并把块 JSON 残留进喂给摘要模型的前文（details 在场也每代必走）。现在记录行内 `<` 写成 `\u003c`（解析侧零改动、老摘要照读、新摘要旧版本也能读），受损块按开标签的 count 自我报警，文件列表块无法承载分隔符时不再静默截断 |
| 2026-09-14 | 修 CI 红：昨晚两个提交给队列清过期终局通知时用了一种新写法，源码守卫测试的白名单没跟上被误红（写法本身安全，只删不增）；把该写法登记进白名单，CI 恢复绿 |
| 2026-09-13 深夜 | CI 首次真跑（run 34753200385）4 条红 job 逐枚归因并修：8 枚失败测试里 5 枚是我们自己的测试与源码脱节（502 / interactive-mode-status 的私有方法 harness 缺新协作者，4602×2 的 worker 夹具缺 `isConnected`，eviction 的 create 夹具没把新 worker 注册进 `workers`），1 枚是 4600 的「post-bind 启动失败」触发器失效——本 fork 把 cron 迁移降级为 best-effort（3d935f674，上游没有这层）后坏存档不再让启动失败，改为在真实 post-bind 步骤注入失败并让报错自证「socket 已绑定」，同时钉住「坏 cron 存档只降级不拦启动」；剩下 4603＋4606 是同一根因：`daemon ps`/`doctor --fix`/`shutdown --force` 是**全机**发现（`ss -lxp` 按进程名，见 daemon-ps.ts 头注），在并行分片里 4603 把 4606 刚起的无会话 supervisor 当「闲置后台服务」收走，两条互相拖红——改为 4603 单独一条 CI job 跑、`test:ci` 排除它（顺带拆掉「在开发机上跑全量测试会关掉你自己正在用的 daemon」这颗雷）。用户 / AI 可感面＝CI 信号可信度：agents 视图 Enter 的锚点宽限、换会话时的重试倒计时清理、快照替换后的 catch-up、a2a 投递按 create 时会话目录解析这四处行为重新有测试守着 |
| 2026-09-13 夜 | 修两条 CI 暗病：CI 触发面补上 `merge/repl-kernel`（此前只认 `main`，本 fork 日常推送从不跑 CI，只有给上游提 PR 时才跑）；`coding-agent kernel` 这条 job 不再假绿——先用产品自己的 bootstrap 造源码后端 venv（`bootstrap-cli.ts --with-bundled-skills`）并把解释器钉进 `PRIME_AGENT_KERNEL_PYTHON`，跑完再用 vitest JSON 报告过一道反假绿闸（`numTotalTests >= 30` 且整片 skip 的文件数 = 0，闸自带 planted-false-green 自测）。用户 / AI 可感面＝内核真运行时面的 28 枚测试（10 个文件）从此在 CI 上真跑，此前它们静默 `describe.skip` 而 job 照样报绿 |
| 2026-09-13 傍晚 | 按住的两个依赖升级修好并入：@google/genai 2.21（Gemini 新终局 `TOO_MANY_TOOL_CALLS` 归到工具协议类 `error`，现在带着原始 reason 走结构化 provider 失败并可重试，不再抛 "Unhandled stop reason"；用户可感面＝Gemini 连打工具被 provider 掐断时能自动重试而不是当轮报错收场）＋ vitest 5（去掉 v5 已删的 `describe.sequential`，Anthropic OAuth / MCP OAuth 两个套件此前被**静默丢掉的 17 个测试**全回来；收集面逐枚对账 ai 1178=1178=1180、agent 88=88、coding-agent 6131=6131、test:kernel 36=36、test:process 23=23，差 0） |
| 2026-09-13 上午 | 压缩保真度根治（实测报告 `/tmp/ma_audit/compaction_fidelity.md`）：硬事实不再走模型——SHA/路径/阈值数字/错误签名/issue 号由正则机械抽取成 `<fact-appendix>` 附在摘要后，用户原话与 `!command` 进 `<user-requests>` 逐字区，两块都结构化跨代 carry-forward 且**不再回喂摘要器**（模型改不了一位 SHA）；toolResult 截断改头 2000+尾 500（测试红的清单在尾部）；切割点对齐到 turn 起点（该轮原始请求逐字在场，常见情况少一次 LLM 调用）；附录预算按内容密度计费（CJK 1.5 字/token）。实测：三场会话回放事实保留 w≥6 100%、用户指令零丢失、再压 5 代零衰减 |
| 2026-09-13 凌晨 | core 其余面 + TUI 面围猎修复 10 条：/share 密钥预检此前扫的是 base64（明文形状永不命中，等于没有预检）改为扫上传件里可还原的明文；/share 的 `gh` spawn 失败会永久挂死改为报错 + 上界；bash/工具全量输出临时文件 0644→0600；单个会话 cron 存档损坏曾让全进程所有 cron/heartbeat 永久静默，改为隔离该会话 + 告警 + 下次写自愈，调度器读失败也不再永久失械；资源发现目录符号链接加环检测与深度上限（不再靠内核 ELOOP 兜底）且跳过必留痕；`!command` 凭证失败不再进程级永久负缓存（30 s 过期）；bash 流式解码收尾 flush；中断路径 4 个 best-effort abort 补 catch；重试倒计时/压缩 loader 在换会话与拆除时真正 dispose；Loader 与 CountdownTimer 定时器 unref |
| 2026-09-12 傍晚 | 修「进会话 / 进 agents 视图间歇 1–5 秒」：会话列表摘要落一份持久缓存（按 dev+ino+size+mtime 失效，内容变了必重扫）+ 三处串行转录扫描改并发；开一次 agents 视图的守护进程侧成本 3.35 s → 0.13 s，冷守护进程下 Enter→聊天 5.25 s → 0.22 s；顺带修 agents 视图 Enter 被目录刷新扣住、250 ms 动画定时器全量重建行 |
| 2026-09-12 凌晨 | 采纳外部贡献者 DZMing 的 5 个修复（时区孤儿/umask 锁死/测试环境耦合/导出 /tmp/Windows 测试）；移除假设置 bashTimeoutSeconds；修"记忆写入遇格式抖动整条丢"；大门从自动关 PR 改为人工审 |
| 2026-09-12 上午 | 官方动态对账：41 个新提交盘点 + 60 个开放 PR 逐件分析；摘官方 12 个提交级优点（litellm 超限识别/`$` 不再二次展开/agents-view 用量列/Bedrock 打包真修等）；移植 rlm.collect（子代理结果类型化回收） |
| 2026-09-13² | 压缩保真度大修：硬事实（SHA/路径/数字/错误签名）走确定性附录零衰减、用户指令原文保留不丢、toolResult 截断头尾保留、切割点不再落在 turn 中间、修掉一个会让压缩卡死 300 秒的正则回溯雷 |
| 2026-09-13² | 依赖升级轮：file-type/concurrently/anthropic-sdk 已验证合入；@google/genai 2.21 与 vitest 5 按住（各有一条破坏面：新 FinishReason 破穷举钉、vitest5 静默丢 17 个测试）——修好再合 |
| 2026-09-13 | 压缩超预算根治：token 估算按真实消耗锚定（CJK/代码不再低估 60%）、超限自动收缩重试、各模型按真实上限钳制、连续失败给出可行动恢复路径；主回合的"输入超限"400 也走进恢复路径 |
| 2026-09-12 深夜⁴ | 全仓六格审查（六家模型）+ 围猎修复全落地：孤儿日志有压缩了、投递回执不再谎报"可能已送达"、注册表原子写、reaper 超时兜底、命令日志 TTL 上限、daemon 面 16 条 P2 一揽子 |
| 2026-09-12 深夜³ | 全仓审查后续：agent-session 五修（切换失败回滚/import 不覆盖同名/流式 !cmd 落盘/用量口径统一/自治续跑竞态）；core 其余格十修（share 密钥预检三层扫描真的拦了/gh spawn 挂死修复/输出临时文件 0600/cron 坏档隔离/资源发现环检测/中断 abort 不裸抛等） |
| 2026-09-12 深夜² | 内核格三修：宿主回调异常不再崩 worker（warn+节流不静默）；venv 代际清理加"启动声明"护栏（并发 boot 不互删）；旧代际的迟到回包不再写进替身内核（走迟到通道如实归因） |
| 2026-09-12 深夜 | 内核面四修：启动期死亡不再无限重生（复活预算跨实例生效+给模型明确报错）；venv 技能就绪改内容指纹（多 checkout 不再互相翻转重装）；ready/心跳同帧不再误判协议损坏杀健康内核；收尾相位心跳带 id 使豁免生效 |
| 2026-09-12 晚² | daemon 面四修：kill 误报"已终结"、驱逐不再吞在飞投递（先排空再关）、投递循环不再认死旧 worker 空转 24h、catch-up 放弃后不再重开预算 |
| 2026-09-12 晚 | 修豁免预算按墙钟误杀健康长任务的缺陷（改记"被豁免的静默时长"，有产出不计时；真死锁照旧 15min 必杀）；六路围猎发现的缓存崩点/驱逐吞消息/启动期内核无限重生等修复陆续落地中 |
| 2026-09-12 下午² | 修掉"子代理回话被父会话排队后送达，父侧仍报没回话"的假警报（送达那一刻回补计数，未送达仍照报）；PR #13 全收官 |
| 2026-09-12 下午 | 合并 DZMing 的 PR #13（自审回归 4 条 + 存量 bug 8 条，三家模型独立复核全过；1 条缓收保上游契约）；修"父忙时子代理回话被误报没回话"的残留缺陷（在修） |
| 2026-09-12 中午 | 合并 DZMing 的 PR #12（13 簇，含导出 HTML 属性注入 XSS、压缩丢上文修复）与 PR #11（性能 7 簇，治"跑久了膨胀"）；摘上游 PR 急修 6 件（会话卡死冻全家/测试碰真凭证/管道杀 worker/内核安全路径/update 保护闸/卡死内核）；修 4603 测试双缺陷（此前多次"全机测试起不来"的真凶：硬链接毒死 node + runner 自停）；四模型研究团交付官方大重构的应对战略（已向官方 PR #2249 挂 4 条缝请求） |
| 2026-09-11 | 多代理稳定性大修：五段死亡链治理（长任务 15 分钟被误杀/误杀被瞒报/子代理回话焊死/内核死即残废/僵尸记账），60+ 提交，四家模型终审全过 |
| 2026-09-07 | 主仓迁到独立仓；根代理沟通契约（说人话、先复述目标、不给选择题） |
| 2026-09-05 | R3 上游同步（官方 40 提交零丢失合入）+ 全仓复审（28 缺陷簇）+ 第一批修复 |
| 2026-08-29 | R1 大合入（REPL kernel 线成型）+ R2 迭代 |

---

## 2026-09-13 上午 · 压缩保真度：硬事实与用户原话不再经过模型

> 缺陷定位报告 `/tmp/ma_audit/compaction_fidelity.md`（只读离线回放三场真实会话，含 45 代链取证），施工与验证全记录 `/tmp/ma_audit/build_compact_fidelity.md`。与同窗「压缩超预算根治」车道串行施工（对方 `791ce355f`/`5f26fb9e6`/`35d7723f5` 先落，本批叠在其上，`compaction.ts` 零 hunk 交叠事故）。

- **为什么**：压缩丢的不是叙事，是**能拿去执行的字面量**。实测首次压缩叙事面保住 73.5%，但硬事实逐字留存只有 3–20%（SHA 4.0%、数字 3.3%、路径 2.7%、issue 13.4%、符号 20.0%）；更新模式更糟，逐代衰减——B 会话 45 代链上第 0 代 28 个事实里 21 个活不过下一次再压缩，数字类平均只活 **1.1 代**，一代压缩抹掉 18 个 SHA（含回滚锚 `84a4401`/`30e7e4b`）；C 会话把 `4871d9223` 写成 `4871d92223`（多一位，git 命令直接失效）并凭空生成「worktree 372-399MB」。9 个真正丢内容的策划清单项**全部**是一次性用户指令与线上问题上报（「能不能提点速啊」「赶紧多个代理审查」「Error: Failed to resolve API key for provider "bailian"…」），全都对摘要器可见、系模型主动丢弃。另外三场切割点**全部** `isSplitTurn=true`：保留区从 turn 中段开始，该轮的发起消息（当轮原始请求）被压成 lossy 前缀摘要——保留的字节是真的，但「这轮在干什么」是摘要的。模板里那句 "PRESERVE exact file paths, function names, and error messages" 实测无效。
- **做了什么**：① **确定性事实附录** `<fact-appendix>`（新增 `compaction/fact-appendix.ts`）：五类事实（commit SHA / 路径 / 阈值数字 / 错误签名 / issue 号）用正则从「即将离开上下文的消息」里机械抽取，仿 `formatFileOperations` 拼在摘要后，**零模型参与**⇒零幻觉零衰减。每条带 `n`（提及它的**不同消息**的加权和：用户与助手正文 3、工具调用与 custom 2、工具输出与 thinking 1；一条消息只算一次，所以日志里刷 500 遍的值压不过用户打一遍的值）与 `g`（首末压缩代），数字与错误另带一段逐字上下文（窗口有界，一条 1M 字符输出里几千个数字不会退化成 O(n²)）。缩写 SHA 折进它所前缀的完整 SHA（一个锚不占两格、权重不被劈开）；错误按「数字归一」签名合并（`position 1871` 与 `position 2044` 是同一个反复失败）；路径抽取改**线性扫描**——原 `segment(?:/segment)+` 形状的正则在「长串无斜杠」上回溯成平方，一条 800k 字符的 `x` 输出能让一次压缩挂死几分钟（实测 300 s 超时），现在 11 ms。② **用户原话逐字区** `<user-requests>`（新增 `compaction/user-requests.ts`）：`user` 消息与 `!command` 原文进块，JSON 编码⇒多行/中文/引号**字节精确**往返，重发合并成 repeat 计数；预算绑住时三段退让——先把最旧的压到 160 字，再丢「被压过的长粘贴」（原长者优先），最后才整条丢，且丢了多少写进 `elided` 属性；一行短指令永不被压，所以它比所有粘贴都长寿。③ **机器块不再回喂摘要器**（新增 `compaction/machine-blocks.ts`）：`stripMachineBlocks` 在 `prepareCompaction` 里把四个块（`read-files`/`modified-files`/`fact-appendix`/`user-requests`）从 `previousSummary` 剥掉再送模型——模型看不见的东西它既丢不了也改不了；台账改走**结构化 carry-forward**（`CompactionEntry.details.facts` / `.userRequests` 优先，渲染块解析兜底，老条目/被迁移掉 details 的条目也不丢），文件列表同样从渲染块回补。④ **toolResult 截断改头 2000 + 尾 500**（`utils.ts`）：测试运行器把失败清单打在最后、构建把致命错打在最后、栈最内帧在最后，只留头部等于把判决全扔了（实测一场会话 62 条结果共 80,103 字符的尾部里有 183 个只存在于尾部的事实）。⑤ **切割点对齐 turn 起点**（`alignCutToTurnStart`）：多留的成本 ≤ `keepRecentTokens × 1` 才对齐，且拒绝对齐到区间首条（否则「什么都不摘要」会让阈值每回合重放）；超大 turn 仍走原 split-turn 双发路径（`isSplitTurn` 语义与既有钉全部保持）。落在 `bashExecution`/`custom_message`/`branch_summary` 上的切割也按 turn 起点计（此前会报 `isSplitTurn=true` 却带一个空前缀）。⑥ **生成块预算按内容密度计费**（新增 `compaction/content-density.ts`）：CJK 1.5 字/token、围栏代码 3、其余 4；纯 chars/4 给中文块算预算会低读 2.7 倍。这是「自己生成、还没有 provider 计数」那一侧的口径，与超预算车道的 `summarizationInflation`（provider usage 锚定、管**发出去的请求**）分工不重叠、互不改写（`estimateTokens` 一行未动）。
- **对用户 / AI 能力**：压缩后代理仍知道用户报过哪个线上错、下过哪条一次性指令（此前这两类是丢失率最高的一类，直接对应报告里两个真实事故面：用户报的 bailian key 解析失败蒸发、被明确要求的多代理审查静默消失）；回滚锚 SHA/路径/阈值不再逐代蒸发，也不会被模型改写一位；保留区从「turn 中段」变成「turn 起点」，该轮原始请求逐字在场，且常见情况少一次摘要 LLM 调用。**没有降能力**：叙事面模板与格式照旧（只多一句「机器块已由机械抽取保真，别复述/改数/改拼写，只记状态」），附录只在预算内取舍并把 elided 写在块属性里，不假装完整。
- **实测**（三场会话离线回放，只读、不发模型；驱动 `/tmp/ma_audit/replay_fidelity.mts` 与 `replay_chain.mts`）：**A**（本会战会话，1685 条消息 / 489k est token 切片 / 2252 个唯一事实）附录 643 条 14,660 token，按提及权重保留 **w≥6 = 333/333 = 100%**、w≥3 = 643/741 = 86.8%、w≥9 = 100%；用户原话 **92/92 逐字、0 丢失、0 elided**（块仅 7,901 字符）。**B**（sales-ai，110k 切片）w≥3 = **119/119 = 100%**、用户 19/19。**C**（fork 审查，295k 切片）w≥3 = **153/153 = 100%**、用户 8 逐字 + 1 长粘贴截断（截断量写明）、0 丢失；报告点名被写坏一位的 `4871d9223` 在 C 附录里是权重最高的一条（n=60）。**跨代零衰减**：三场各再压 5 代（叙事面对抗性返回空话），事实与用户条目 **0 丢失**，`details` 与「渲染文本兜底」两条回收路径逐条相同。**B 的 6 代真实链**：第 0 代 773 个显著事实，历史 LLM 摘要平均只活 **0.09（SHA）/0.11（路径）/0.12（数字）代**、活到最后一代的分别 0/4/3 条；台账口径为 **4.34/2.54/3.18 代**、活到最后一代 41/104/64 条（错误类 0 → 5.2 代）。切割点：三场 `isSplitTurn` 由**全 true → 全 false**。抽取成本：1M 字符混合日志 50 ms、纯 800k 长串 11 ms，均线性。
- **验证**：新增 6 个测试文件 105 条（content-density 6 / machine-blocks 8 / fact-appendix 48 / user-requests 20 / turn-alignment 14 / fidelity-pipeline 9）+ 更新 3 个既有文件（serialization 头尾截断 5 条；`agent-session-compaction` 与 `agent-session-semantic-edges` 各把「1 token 前缀」夹具改成真的会产生 split turn 的夹具，split-turn 双发路径的钉子一条没少）。**先红后绿**：同一份 `red_probe.test.ts`（只用基线已有 API）在基线树 `f51aaf481` 上三条断言**全红**（`isSplitTurn` 为 true／尾部判决被截掉／摘要里没有 SHA、路径、阈值与用户原话），修后树全绿（`/tmp/ma_audit/cf_red_probe_base.log`）。**变异 30 处全杀**（首轮 26 杀 5 存活，为 5 个存活各补断言级钉子后复跑全杀；含 recency 加权、每类保底、SHA 别名折叠、消息内只计一次、错误签名归一、短 SHA 的 git 语境门、预算强制、elided 诚实计数、解析拒未知类、预算随切片缩放、URL 不算路径、散文源判定、代码行过滤、上下文窗口有界、用户块三段退让次序、去重、头尾截断、strip 覆盖面、属性转义、对齐开关/护栏/区间首拒绝、previousSummary 剥离、附录拼接、prompt 注记、turn 前缀也收、代际号、details 持久化）。**全量**：527 文件 6148 条（排除 4603）⇒ 14 红；与基线树同环境隔离复跑对账后归因＝8 条 fork 既有红（daemon-supervisor-eviction/process、interactive-mode-status、4600、4602×2、502）+ `6008-headless-python-cancellation` 与 `kernel-attach-image-skill`/`repl-kernel-restart-budget`/`agent-session-autonomous` 的本机内核环境红与负载 flake（基线树同批同样红、且逐次红的子集不同；隔离复跑两侧都只剩 6008 红）⇒ **new red 0**。压缩家族 35 文件 428 条全绿。`npm run check` EXIT=0、`check:test-hygiene` 无新增探针、纯净树 `tsgo --noEmit` EXIT=0。
- **残留 / 交下一手**：① 报告修法 6（`refinement_outcome` 等 custom 消息被 `convertToLlm` 丢掉，复盘教训按构造到不了摘要器）未做——但这类消息的**事实**现在能进附录（抽取直接读 AgentMessage，不经 `convertToLlm`），叙事面仍看不见它。② `estimateTokens` 仍是 chars/4，触发阈值与 `keepRecentTokens` 的真实水位在 CJK 会话上偏低读（方向安全：留得比名义多），全局口径归超预算车道的 provider 锚定，本批没动它。③ 分支摘要（`/tree`）仍只带文件块，不带事实附录与用户原话区。④ 极端会话（B 那种 6 代 ~700 条用户消息）用户块按上述三段退让携带最近 ~156 条，`elided` 如实计数；不是零丢失，是**有界的诚实丢失**。

---

## 2026-09-13 凌晨 · core 其余面 + TUI 面围猎修复（10 条）

> 缺陷定位报告 `/tmp/ma_audit/full_corerest.md`（core 其余 ~30k 行）与 `/tmp/ma_audit/full_tui.md`（interactive/ + tui/ 40k 行），施工与验证全记录 `/tmp/ma_audit/build_corerest_fixes.md`。

- **为什么**：两条只读围猎车道交回 1 条 P1 + 9 条 P2。最重的一条是安全面：`/share` 上传前的密钥预检扫的是导出 HTML 全文，而会话内容在导出件里是 `Buffer.from(JSON).toString("base64")` 塞进 `<script id="session-data">` 的——base64 字母表里没有 `-`、`_`、空格，`sk-`/`AKIA`/`ghp_`/`Bearer ` 五个明文形状**永不可能命中**。结果是弹框恒不出现，用户被告知"看起来不含密钥"后照常上传，拿到一个可转发给任何人的 viewer URL。
- **做了什么**：① **/share 预检**：新增 `export-html/session-data-embedding.ts` 作为容器格式的唯一出处（导出侧 encode、预检侧 decode），预检改为扫「上传字节 ∪ 还原出的明文载荷 ∪ 载荷解开 JSON 转义后的文本」三层——第三层是施工中新发现的真洞：载荷里 `...\nAKIA...` 的换行是转义的两字符，`n` 紧贴在密钥前面，`\b` 锚点照样不命中（活体实测：只解 base64 不解转义，5 类密钥只命中 2 类）。顺带补 PEM 私钥形状。② **/share 上传不再挂死**：`spawn("gh")` 只注册了 `close`，spawn 本身失败（PATH 竞态 / EMFILE / EACCES）时 Node 只发 `error`，Promise 永不 settle；补 `error` 监听 + 5 分钟上界（超时即 kill 并报错，loader 的取消仍是快路径）。③ **临时文件 0600**：`bash-executor` 与 `tools/output-accumulator` 的全量输出落 `/tmp/pi-*.log` 用的是 `createWriteStream` 默认 mode（本机 umask 0022 实测 0644，世界可读），而这份文件里正是被上下文截断挡掉的那部分输出（密钥常在尾部窗口外）；两处都加 `{ mode: 0o600 }`。④ **cron 存档损坏不再全家静默**：`readJobsStateIfPresent` 对存在的文件直接 `JSON.parse` 无 try，一个会话的坏文件会顺着 `nextActiveRunAt` 抛进 `scheduleNext`，在 `setTimeout` 之前就把定时器打死，**全进程所有会话的 cron/heartbeat 直到重启都不再调度**，只留一条 warn；改为把坏文件隔离成空态（字节原样不动，读路径不销毁数据）、按 path 去重告警一次、下次写该会话时原子 rename 自然自愈；另外给 `scheduleNext` 兜底：store 读失败按 30 s 有界重试重新武装，"任何 store 故障最多丢 tick，绝不永久失械"。⑤ **资源发现环检测**：`collectFiles`/`collectSkillEntries`/`loadSkillsFromDirInternal` 对目录符号链接一律无条件递归，不记 visited、不限深度——活体实测 `skills/loop -> skills` 这种**走法层面**的环内核不会报 ELOOP（每次只解析一跳），会一路重复扫到路径名超长为止，同一个技能被收进结果 47 次；新增 `utils/discovery-walk.ts`（realpath 身份 + 分支栈，深度上限 32），命中即跳过该子树并留痕（skills 走 `ResourceDiagnostic`，package-manager 走 logger），原先被静默吞掉的扫描异常也改为带 path 告警。⑥ **`!command` 负缓存加 TTL**：失败结果此前进程级永久缓存，`!cat /run/secrets/token` 首次遇到文件还没生成就永远返回 undefined；改为成功值仍终身缓存、失败 30 s 过期（窗口同时保证坏命令不会被每次模型调用都 spawn 一遍）。⑦ **bash 流式解码收尾 flush**：命令被超时/kill 截在多字节字符中间时，尾部 1-2 字节此前直接消失，与同族 `OutputAccumulator.finish()` 行为不一致；settle 与 cancelled 两条路径都补 flush（表现为 U+FFFD，即"这里被截断了"）。⑧⑨⑩ **TUI 面**：`interruptOrClearInput` 里 4 个 best-effort abort 补 `.catch()`（一次 Escape 曾能造出 4 条 unhandled rejection）；`retryCountdown`/`retryLoader`/`autoCompactionLoader` 在 `stop()` 与 `resetCurrentSessionRenderState()` 里真正 dispose + 从 statusContainer 摘下（换会话不再残留上一会话的倒计时，teardown 不再被 interval 拖住）；`Loader` 与 `CountdownTimer` 的 interval 补 `unref()`。
- **对用户 / AI 能力**：`/share` 的密钥警告从"恒不出现"变成真的会出现（含 PEM）；`/share` 不会再挂死；同机其他用户读不到 agent 的命令全量输出；一个坏掉的会话存档不再让所有会话的定时任务与心跳停摆；仓库里有目录符号链接时启动不再重复扫整棵树、也不会静默少发现资源；凭证命令首次失败后 30 s 内自愈，不必重启。**没有降能力**：正常符号链接目录仍被跟随（一层），成功凭证仍终身缓存，导出 HTML 的字节形状不变。
- **验证**：10 条全部先红后绿（红都是行为级，不是"模块不存在"级）——例如 share 面在真导出件上实证 `findShareSecretHits(html) === []` 而载荷里 5 类密钥俱全；cron 面实证一个坏文件让 `store.list()` 直接抛 `SyntaxError`；发现面实证同一个技能被收 47 次；TUI 面实证 4 条 unhandled rejection 与 `hasRef() === true`。变异 25 处全杀（唯一一次"存活"是我的跑测命令把退出码吞在管道里，去掉管道重跑即杀；无等价变异）。新增 8 个测试文件、40 条用例；回归两批共 103 文件 1580 条全过（30 文件 538 条主批 + 73 文件 1042 条交叠批），tui 包 808 条全过（未跑 4603 全量）；`npm run check` 本车道文件零错、`check:test-hygiene` 无新增探针、纯净树 `tsgo --noEmit` EXIT=0。
- **顺手修正的既有测试**：`interactive-mode-ctrl-c.test.ts` 的 4 个 abort 假件此前返回 `undefined`（生产代码只 `void` 调用所以看不出），补 `.catch()` 后必须是真 Promise，已改为 `mockResolvedValue(undefined)`；新的 share 上传失败用例改用独立临时目录前缀，避免与 `interactive-mode-share-scan-ordering.test.ts`（断言 tmpdir 里 `prime-agent-share-*` 存活集合）在并行 worker 下互相踩。

---

## 2026-09-12 傍晚 · 进会话 / agents 视图间歇 1–5 秒（性能缺陷修）

> 详见 `docs/fork/ui-lag-durable-session-summary.md`；缺陷定位报告 `/tmp/ma_audit/ui_lag_measure.md`（只读取证车道），施工与验证全记录 `/tmp/ma_audit/build_ui_lag.md`。

- **为什么**：进 agents 视图 / 进会话时，守护进程要做一次 O(存活子代理边数 × 转录字节数) 的**串行**磁盘扫描，而缓存只有进程内一层 —— 换 worker、换 catalog 子进程、守护进程重启、passivate→hydrate 循环，每一次都从头重扫。本机实测：一次 `list_saved_sessions`（= 开一次 agents 视图）冷价 **3.33–3.72 秒**（sessions 目录 83 文件 430 MB 花 1.16 s + 被动后代 456 边 757 MB 花 2.19 s），同一次调用进程内热重复只要 40 ms（冷热差 267×），这就是「间歇 1~5 秒」的物理来源。不是新代码改坏的：三段最贵的代码与昨天大修前的基线逐字节相同，涨的是数据（存活边 456 条 / 转录 757 MB，`session-artifacts` 已 4.9 GB）。
- **做了什么**：① 新增**持久层摘要缓存** `<agentDir>/session-info-cache/`：一份 `SessionInfo` + `(dev, ino, size, mtimeMs)` 指纹，只有指纹全等才发，**内容变了必然重扫**；只在全量扫描后写、只覆盖代理自己的 sessions / session-artifacts（临时目录 fixture 零副作用）、0700/0600、temp+rename 不 fsync、每 7 天一次后台清理、写失败 3 次熔断、读永远降级为 miss。② 新增保序限流并发工具，把 `listSessionsFromDir`、`withPassiveRlmDescendantInfos`、`family()` 行循环、`listPassiveRlmSubagents` 的子树递归、`liveEdges()` 的存在性探测全部并发化（顺序、流式发射、`visited` 语义、resident 孩子不扫的既有优化都不变），并给 `canonicalSessionPath()`（阻塞 realpath）加记忆化。③ agents 视图 250 ms 动画定时器不再全量 `rebuildRows()`（536 条记录实测 24–28 ms/次），改为就地重算时间派生标签。④ Enter 不再被「目录刷新在飞」无条件一票否决：改成**停滞即放行** —— 死线 2 s 从「锚点最近一次被重新武装」起算，而流式期间每次 reconcile（节流 50 ms）都会重新武装它，所以目录在持续到货时 Enter 仍会等完整轮刷新（上限 = 该 RPC 自己的 30 s 超时），2 s 兜底只在刷新卡住不动时才踩；这不是回归（原逻辑无条件等到刷新对象活着为止），改的是「永久死路 → 停滞即放行」，而真正让这段等待变短的是 ①②（目录到货 2.2 s → 0.13 s）。⑤ 删除会话时顺手清掉它的持久摘要，并在递归删除 artifact 目录**之前**把被一起删掉的后代转录摘要也清掉（否则一个根被删会留下「每子一条」孤儿等 7 天周清）；删除路径与写入路径的拼写可能不同（账本存 realpath、目录扫描存配置拼写），所以按「字面 + realpath（文件已删时退回父目录 realpath + basename）」两种拼写各删一次。
- **对用户/AI 能力**：进 agents 视图不再间歇卡 1–5 秒；冷守护进程下按 Enter 进会话从 5.2 s 降到 0.22 s；视图里「行数还在爬、序还在变」的窗口从 1.7 s 缩到 0.28 s，且落定行数从 82（被动后代没到齐就假落定）变成 97（全量到齐）。**没有降能力**：一个子代理都没少显示、一段转录都没少读、搜索/用量/拓扑全部照旧。
- **实测**（同机同负载窗背靠背 A/B，隔离 home 用 APFS clone 的真实数据，两套 build 各自 `git archive` 出 /tmp 树后自建，未动仓库 `dist/`）：一次 `list_saved_sessions` 冷 **3349/3333/3373 ms → 173/138/129 ms（25×）**、热重复 41 → 27 ms；被动合并 2078–2484 → 46–49 ms（46×）；目录扫描 1156–1312 → 19 ms（60×）；最大根子树 769–784 → 18–20 ms（42×）；E2E 冷 Enter→聊天 5243/5253 → 221/221/223/233 ms（23.7×）。修后冷读的层构成是 `diskHits=539, fullScans=0`；持久缓存 708 条 / 8.4 MB（对应 1.5 GB 转录）。**受控反证**：把持久缓存目录删掉，修后 build 的冷 Enter→聊天回到 5259/5261 ms ≈ 基线 5243/5253 ms。
- **验证**：先红后绿（6 个新测试文件在基线树 `0429806b6` 全红、9 条断言失败，其中两条是断言级红：并发峰值 `expected 1 to be ≥ 2`、摘要目录 `expected false to be true`；修后树全绿，一致性审查这轮后 **7 文件 46 条**）；变异 19 处：18 杀 + 1 判定为等价变异（只摘 `toIsoString` 守卫、wire 仍在 try 内 ⇒ RangeError 被同一个 catch 接成 `skipped`，可观测结果逐字相同，不计杀、如实登记；整体回退 F1 修法的 M12a 已杀），其中六处是正确性/卫生方向（去掉指纹校验、任意路径都缓存、删除后不清条目、删根不清后代条目、Invalid Date 无守卫、prune 把读不出来当垃圾删）；回归 58 文件 905 条全过（session-manager 全目录 / rlm-ledger / agents-view×8 / daemon-catalog×3 / session-artifacts-delete / daemon-mode / daemon-supervisor×18，未跑 4603）；`npm run check`、`check:test-hygiene`、纯净树 `tsgo --noEmit` 均 EXIT=0。
- **一致性审查随访（sweep_meta F1–F5、F7）**：**F1 必修已修** —— 持久摘要写盘时 `info.created.toISOString()` 在 try 之外，一份头部时间戳不可解析的转录（手工编辑/截断/第三方导入）会让 `Date#toISOString` 抛 RangeError 穿到 `listSessionsFromDir` 的 catch，把**整个目录**的列表在每次冷读时打成 0 条（审查方脚本活体复现：`listAll returned 0 of 3`），且抛在计数之前所以熔断与 `writeErrors` 都够不着、每个新进程重演；修法是 wire 构造整体挪进 try + `toIsoString()` 守卫（不可表示就跳过该条目、计 `skipped`、绝不抛），修后同一脚本 `listAll returned 3 of 3`。**刻意没有**顺手改 `scanSessionInfo` 里 `created` 的语义（坏头部返回 Invalid Date 是加载路径的既有行为，改它牵动排序与显示，登记为残留）。**F4**：写失败按 errno 分类 —— 永久性连续 3 次才熔断，瞬时性（EMFILE/ENFILE/EAGAIN/EBUSY/EINTR/ENOMEM/ETIMEDOUT）改指数退避 250 ms→30 s 并自动半开恢复（本批自己把同进程 fd 压力放大了 8 倍，一次描述符尖峰不该让长跑进程余生全量重扫），并把此前零断言的三条自证声明（熔断 / 512 KiB 跳过 / prune-marker 周门控）各补一条测试。**F5**：prune 把「读不出来」与「内容是垃圾」拆成两个判决（readFile 抛错或 stat 抛瞬时 errno ⇒ 保留，只有解析失败 / 源已消失 / 指纹漂移才删），与它自己的注释「never touches an entry it cannot prove stale」重新对齐；顺带回收崩溃残留的 `.tmp`（>1 h）。**F7**：孤儿 JSDoc 归位。**F2/F3 changelog 归位**：删掉 `ma-batch4-pending-delivery-queue.md` 里与 `ma-batch4-send-drain-exemption.md` 重复的 bullet（四包 fragment 精确重复 0、近重复 0），并给 `packages/tui/.changes/` 补两条一行 fragment（stdin-buffer 粘贴二次方、truncated-text render-cache），使 tui 包按包折叠时不再缺今天这两处 TUI 修复。**F6 不属本车道**（别的提交在 `docs(fork)` 标签下夹带 provider 行为修复），未动、已转告。
- **残留（有据、未动）**：热档 Enter→聊天仍有 ~200 ms 地板 = 转录本体水合（81 MB / 8.5 万条 ≈ 248 ms，报告排第 4 的常数项，只能靠改 attach 传输策略压，属「少传」不是「少读」）；账本整份重放 ~65 ms/进程首次；`kill -9` 后守护进程锁恢复循环 ~4.9 s（E2E 冷档 `启动→viewUp` 两边同为 4.4–4.5 s 的真因，与本修无关，值得单独一轮）。

---

## 2026-09-12 凌晨 · 外部贡献 + 官方互动 + 上游优点摘取

- **做了什么**：① 采纳外部贡献者 DZMing 的 5 个修复（时区误判孤儿进程、umask 锁死私有文件、auto-refine 测试环境耦合、macOS 导出 /tmp 必败、Windows 测试 POSIX 报错），全部先验证再 cherry-pick，署名归他；② 移除半成品设置 `tools.bashTimeoutSeconds`（文档写了但从未接线，RLM 线模型拿不到经典 bash 工具）；③ 修复"记忆写入"（refinement）遇到模型输出格式小抖动整条丢失的问题：宽容解析 + 失败留证 `refinement-failures.jsonl`；④ 摘取上游三个优点：build 不再联网重拉模型目录、/compact 后目标停摆修复、daemon worker initTheme；⑤ 把大门从"非担保自动关 PR"改成"只提醒不关门"（DZMing 的 PR 就是这么被误伤的），并把他加进担保名单；⑥ 向官方提交完整反馈（27 条在官方 main 上逐条亲核的缺陷，走 Discussions 正门 #2239）；⑦ 新增运维手册 `docs/fork/ma-multistability-ops.md`、上游反馈稿 `docs/fork/upstream-feedback-20260911.md`。
- **对用户/AI 能力**：外部贡献者的修复开始流入；记忆系统不再因格式抖动丢偏好；官方同病的修复有机会回流。
- **验证**：各修复均带先红后绿与纯净树复验，详见各提交与 /tmp/ma_audit/ 施工报告。

---

## 2026-09-11 · 多代理稳定性大修（五段死亡链治理）

范围：`merge/repl-kernel` `10b6b4e55..e1eb54bd3`，**54 笔提交、152 文件 +27634/−826**。本节收口基准 `e1eb54bd3`（工作区零残留；批 2 复核发现的幂等键真洞已回修闭合 `e1eb54bd3`，B1c 的诊断 polish 已由收尾车道落地 `6777e77f7`）。运维面（可观测签名 / 回滚开关 / 部署日清单 / flaky 清单）见新建的 **`docs/fork/ma-multistability-ops.md`**；本轮新 settings 键已补进 `packages/coding-agent/docs/settings.md`。

### 一、为什么改：审查实证的一条五段串联死亡链

前置审查（材料在 `/tmp/ma_audit/`，缺陷总表 `FINAL.md`）：6 条只读车道（K3/0902/flash 异构分工）→ 3 个异构验证器逐条攻定级（K3↔0902 互攻 + deepseek 核量级）→ 3 个活体探针实证。主线发现：

> 等一个子代理（或跑一条长命令）超过 15 分钟 → 看门狗误杀 → 误杀连带把全家子代理的回话通道焊死 → 父侧看到的却是「正常完成」→ 僵尸记账就此留下。

| 段 | 机制 | 生产/活体实证 |
|---|---|---|
| ① 误杀 | stall 活性判据 =「当前 cell 最近写没写自己 stdout」；健康长活儿与死锁的可观测历史逐字节相同 | 43 次 abort 全部 silentMs≈900000、在飞工具 144/144 全是 ipython；37 个被砍 cell 只剩 19 字符「Request was aborted.」；活体探针 900.0 秒整被杀 |
| ② 焊死 | requestAbort 不级联子代理、反而挂起父代理输入泵：子代理 send(parent) 一律硬抛、终态通知 5 分钟后静默丢弃、无法自愈 | 内核死后连 agent_message 都发不出（活体复现） |
| ③ 粉饰 | 终态分类只认 `stopReason==="error"`：被误杀 ⇒ 父代理收到「completed without sending a reply」；stall_* 事件不在父代理订阅分支里，零用户可见信号 | 本轮审查自身两例逐字符合 |
| ④ 砖化 | 内核意外死亡（OOM/崩溃/被杀）后会话永久砖化：`restart()` 全仓零调用者、每次调用抛「Kernel has been shut down」、死因只进内存环形缓冲永不落盘 | 2 会话各 7 连败其后 0 成功；kill -9 活体复现 |
| ⑤ 僵尸 | 记账与真相发散 | 73%（94/128）会话租约指向死 pid；rlm-ledger 46%（770/1666）指向已消失子代理 |

放大器（孤儿环）：abort/dispose 只沿活跃子代理走 ⇒「已完成→被追发→又派孙」的中间层下面的活孙辈杀不到，而 `hasRunningRlmChildren` 仍报忙。

修法来源：双独立设计（0902 + K3）→ deepseek 中立合并（21 冲突）→ 四维异构评审（correctness/capability/complexity/engineering）→ 合修终裁 C1-C21（`FIXPLAN_FINAL.md`）→ 红队四报（59 条新风险）→ 批次重排补遗（批 0 前置保护先上）。全程总闸：**任何修复不得降低 AI 能力；降能点必须逐条登记**。

### 二、改了什么：逐批次（50 笔）

| 批次 | 提交 | 内容 | 用户能感觉到什么 |
|---|---|---|---|
| **批 0 · 前置保护**（11 笔，`46cc03254`…`c21d47a76`） | venv 治理三件：技能集就绪改**超集判定**+记录**并集写**（根除多技能集 ping-pong 重装，`dd62e6832`）；bootstrap 锁 300s 超时+可取消+settings 化（`46cc03254`）；**版本化目录** `kernel-venv-<hash12>`（每个 build identity 一个兄弟目录；有活引用的目录永不 rename/原地重建/删除，在用重建一律 `defer` 显式报错）+ `.in-use` 引用计数 + 保留 1 份无引用旧代 GC（`ca92e1b34`/`c21d47a76`）。内核协议 **env 协商**（`PRIME_AGENT_KERNEL_PROTOCOL`，宿主默认请求 4、clamp [3,4]，协商 <4 禁发一切 v4 帧；`30c726254`/`6209e1d80`）。快照 **preserve_names 合并写**：部分恢复失败不再永久封笔，坏名字按名保留旧 blob、快照单调变好（`5943aa551`/`f396cdd30`/`5172aea6e`/`33ade94b8`） | 子代理首格「Starting Python kernel...」分钟级卡顿消失；内核重建不再 rm -rf 别的会话正在用的 venv；resume 后「状态全丢且无提示」变成有名单、有日志 |
| **批 1 · 死亡链**（9 笔，`c2a388dd6`…`0ef41c246`） | 终态**四态化**（error/aborted/stall_killed/completed_without_reply），失败类通知无条件发（解开 `_parentReplyCount` 闸）、父代理订阅补 stall_* 分支（`ef788e0db`）；Esc **不级联**杀子代理（C1 裁乙：Esc=只停当前回合），但 abort 级联**补齐孙辈**（孤儿环，settled 子树也走 cascade）；挂起泵期间 send → **queued 事实回执**（不再硬抛）+ `subagentWake.policy` 默认 `failure_aggregated`（失败类终态聚合唤醒一次，`562262c07`）+ 不可达终态通知转录直落 + sidecar 下次启动 reflow（不再 5 分钟丢弃，`780a29fec`）；豁免预算**按谓词封顶**（vouched 与 paused 单一合计预算 max(10×warn, 30min)，先修 touch 不清零的累加器缺陷，`c2a388dd6`）；19 字符谜团 → **被砍工具输出保全**（1.25s 有界收割 + 8KB 尾段，`8a6b8f1f4`）+ ipython cell abort 结构化死因（`f60529a43`） | 子代理被杀不再报「完成未回话」；被砍的 cell 能看到死因和部分输出；Esc 语义确认（杀树走 agents-view 显式入口） |
| **批 1c · 心跳与 vouch**（13 笔，`211a16c6d`…`9a2828d33`） | 协议 4 **内核活性心跳**：线程带外帧（`KERNEL_HEARTBEAT_INTERVAL_MS` 默认 5s），带 loop_tick + 单调进展计数 + bash FIONREAD 事实族；strict JSON（NaN 拒帧不杀内核）、不进模型上下文（`be6570803`/`65dacb311`）；心跳陈旧时**降级 journal 兜底**（按 kernelPid 读盘，TTL 大于它所喂的预算，`29b18d204`/`58dc90bb8`）；看门狗 **vouch**：工具在飞 + 内核/宿主事实证明外部工作在跑 ⇒ abort 缓期（警告照发、文案改写为真实语义+剩余预算），两级预算（进展证据 50min / 仅存在性证据 20min）、宿主请求 vouch 龄上界 15min、**预算耗尽闩锁必杀**（`61a3ba890`）；`loop_stalled` 仅在 tick 差分证明时报告（`3046b0580`）、缺龄按 agedOut、`no_kernel_facts` 只对协议 ≥4 报（`d95021edd`）；**终审 A1 闭合**：vouch 闪烁（证据断档后重读）不再无限续命，断档前已积累的豁免时间结转、已见顶的 cap 保持已尽（`f307f943d`）；**B9**：被豁免的健康子代理不再对用户显示 stalled（agents view 显示 `long-running 12m`，stall 事实带 `excused` 旗标照流，`9a2828d33`） | 长 `await bash(...)`、长构建、等子代理不再 15 分钟被砍；真死锁仍必死（活句柄兜底档最坏 ~20min，合计预算封顶 50min，见登记降能） |
| **批 2 · 砖化与等待**（6 笔，`a5179de81`…`e1eb54bd3`，含复核回修 `e1eb54bd3`：errored 首发按 uncertain 记账、同键重发 fail-closed，重复投递窗机制性关闭） | 内核**死因归因**：code/signal/origin（`oom_suspect` 仅凭内存证据）、与宿主有意杀（shutdown/kill/dispose/协议修复）分账、双落盘（`a5179de81`）；**自动复活**：意外死亡由下一格复活（spawn+restore+re-bootstrap），结果头带 reset notice（回滚点、未复活名单、丢失的宿主回话、**副作用不回滚**），预算 3 次/1h 滑窗 fail-closed ⇒ `KernelUnavailableError` 带死亡链（`f18c2ba77`）；agent message 四个等待点**有界化**（`agentMessage.targetWaitSeconds` 120/60/60/60，retryable 错误带 phase/target/waitedMs，被等的操作永不取消，三连败转终态+写文件指引，`dfc3df92d`）；cell abort **只取消只读白名单**宿主请求（`rlm.find_models`/`list_subagents`、`agent_observe.*`、`model.info`、`agent_message.list_agents`），副作用类（`rlm.run`、`agent_message.send`）维持 teardown-only ⇒ Esc 不再风险杀掉刚 admit 的子代理（`ecfa71d37`）；**exactly-once 投递**：sender-minted message_id + 收端 1024 个 id 记忆，重发回执「第一次才算数」；同文本双发仍双达（有意不采内容幂等键，`4b3399eb6`）；迟到 host_reply 上报不再静默丢弃 | 内核 OOM 不再砖化整个会话；send 卡死有界、有事实回执；重试不再造出双胞胎消息 |
| **批 3 · daemon 生命周期**（4 笔，`0ec081a26`…`16c56168f`） | 启动**收养不堵 ready**（后台化、`daemon_hello` 报收养数、启动日志列每个未起会话+原因+恢复命令）、收养请求 300s 有界、失败退避重收养（30s/2min/10min）；**kill 全生命周期可达**（recovering/failed/stopped）、已消失目标回 `alreadyTerminal`、读命令不谎称成功；catch-up **有界重试**（250ms→8s cap + 1min jitter，40 次 ≈5min）+ 客户端快照 re-pull 失败降级可见；supervisor **崩溃护栏**（uncaughtException 记栈退出；unhandledRejection log-and-isolate + 1h 计数 + `degraded` 对外可见 + 可选阈值 exit）+ 簿记写失败不再拖垮 daemon；**failed-worker reaper**（24h + 双证死 + 无 schedule 无 client ⇒ 带真实 failure reason 归档后移除，degraded 时停摆）。SCHEMA_REVISION 27→**28** | 一个坏 worker 不再拖垮整个 daemon 启动；73% 死租约 / 46% 僵尸 ledger 有了清道夫；视图残缺 708 次/期的 catch-up 单点失败变有界重试 |
| **批 4 · 兜底与超时分层**（8 笔，`5f7354426`…`82c2340ec`） | daemon 超时**四档分层**（long 24h / adoption 300s / deliver 120s / read 30s，`5b37f330d`）+ 客户端重连预算（从收养档推导，后台重试）；长 send **移出 mutationDrain 闩**（独立可回滚，`7bf3e5f0d`）；**pending-delivery 队列**（100/会话、24h deadline、drain 显式回执、requeue 日志节流、abandoned 回执分 `undelivered|uncertain` 两种可数状态，`7406aa22d`/`dcfb7f6ea`/`82c2340ec`）；deferred 命令**瞬时重试提示**（retryAfterMs 预算内重试，`5f7354426`）；事件缺口恢复**熔断器**（3 连发或 10min 内 3 次 ⇒ 该连接余生降回 log-only；开关档案 `docs/fork/ma-p0-5c-recover-switch-archive.md`，默认仍 `"log"`，`cb749c7bc`）。SCHEMA_REVISION 28→**29** | 「双方都没错但用户看到死」的四组超时组合拳被拆档；消息不再在 drain 窗口静默蒸发 |

wire 纪律实况：批 1/1c 的加法全部走能力门（`rlm_child_stall_activity` 等 additive 字段，不占 revision 号）；取号发生在批 3（28）与批 4（29），HEAD=29，digest 自检绿。内核协议走 env 协商（C21 裁甲），`PRIME_AGENT_KERNEL_PROTOCOL=3` 是 v4 全部能力的单点回滚杠杆。

### 三、登记降能与行为变化（诚实清单）

- **hung bash 救援窗 15→20min**：活句柄但零进展（卡在 stdin 的交互客户端）按存在性档 20min 救，比旧的 900s 晚 5min；有裁（无人值守永久挂死 > 误杀）。
- **`time.sleep(1200)` 型同步阻塞格仍会被杀**（~20min 活性档封顶，与真死锁不可区分）——修复救的生产主形态是 `await bash(...)`/等子代理（心跳+vouch 豁免）；这是终审验收探针的既定口径，不是回归。
- **闩锁代价**：豁免 cap 吃满后，活动恢复不再救回本回合。
- **纯重定向命令只拿 20min 存在档**（无 stdout 进展可读）。
- **Esc = 只停当前回合、不动子代理**（C1 裁乙，产品语义已确认）；杀树走 agents-view 显式入口。
- **排队的子代理消息不再自动开新回合**（`subagentWake.policy` 默认 `failure_aggregated`）；要旧行为设 `"always"`。
- **内核复活 ≠ 无损**：命名空间回滚到最后快照点，其后定义全部丢失，但副作用（文件写、提交、已发消息、已派子代理）**不回滚**；reset notice 逐格明示。
- **bootstrap 锁 300s**：极慢机器全量装 >300s 会从「无界慢」变「显式失败+指引」（`kernelBootstrap.lockTimeoutMs` 可调）。
- **在用 venv 拒绝重建**：有活引用的 generation 永不原地重建，启动显式报 `venv rebuild deferred: N kernels in use`（平台无关降级案——新 identity 落新兄弟目录，根本没有 rename 换入可供 Windows 失败）。
- **有界等待新增一类 retryable 错误**（`agent message target wait timed out` 带 waitedMs），三连败转终态并指引写文件交付。

### 四、三起并行施工事故与纪律沉淀

多条施工车道（T0A/T0B/T1A/T1B/T3/T3b/B1c/B2/T4）同仓同工作区并行，husky pre-commit 的「重新暂存」机制（`for file in $(git diff --cached --name-only); do git add "$file"; done`，为回收 `biome --write` 的修复）使**索引级分离在本仓无效**，由此出了三起事故（同机制轻症另有一起：T0-2 的 6 行注释被 `f60529a43` 带走，commit message 已注明）：

1. **`30c726254`（T0A 车道）**：钩子把 T0B 在飞的 `repl-manager.ts` 半（~200 行）卷进提交，而其依赖文件未提交 ⇒ **HEAD 一度不可编译**（纯净树 8 条 tsgo error）。
2. **`ef788e0db`（T1A 车道）**：提交了引用 `SettingsManager.getSubagentWakePolicy` 的 `agent-session.ts`，而 `settings-manager.ts` 还在工作区 ⇒ 纯净树 6 条红。钩子查工作区所以放行——**半提交对钩子免疫，只有 `git archive` 纯净树能抓到**（由 T0B 的交付复验抓到）。
3. **`ecfa71d37`（T2-5 车道）**：串行约定下 `git add` 前只看了 `git status` 没逐 hunk 核对，把 B1c 按约定在飞的 `agent-session.ts` B9 半卷走。处置与前两起同款：**不 amend、不 revert、双向登记归属**。

沉淀为全员纪律（已写进根 `AGENTS.md`「Shared-Worktree Construction Discipline」节）：**共享文件全量提交铁律**（提交=文件粒度非 hunk 粒度；stage 前逐 hunk 核对；共享文件串行提交）；**每笔提交后 `git archive HEAD` 纯净树 tsgo=0 复验**；**测试环境净化**（`env -u` 掉 RLM_*/PRIME_AGENT_*/PI_* 泄漏变量，否则测试写真 `~/.prime/agent`、断言随机器漂移；Python 套件同样适用）；**半成品不落共享工作区的 `test/`**（一个车道的 WIP 会挡住所有车道的提交）；**等绿窗提交、禁 `--no-verify`**；**变异/纯净树验证钉 SHA 不钉 HEAD**。

### 五、终审结论（四条异构车道复核，全过）

交付面终审由四条独立异构车道承担，全部基于 `git archive` 纯净树 + 净化 env，复核范围 `10b6b4e55..a5179de81`（39 笔时点）：**不变量与量级核算**（final_invariants，逐条验算全部「有界」断言 + 自建时钟仿真）、**新引入问题猎手**（final_regression，逐 diff 通读全部 39 笔 + 亲跑定向套件）、**修复有效性**（final_effectiveness，HEAD 纯净树 342 例全绿 + base 树红验 27/34 红）、**集成冒烟与一致性**（final_smoke，全仓实测 + changelog/wire/文档一致性核对）。结论口径：

- **HEAD 上无一条今天引入的确定性回归**；全量红 = 2 条既有红复跑同签名 + 1 条环境依赖 + 2 条负载 flake（逐条 base 树对照）。
- 终审时点全仓实测：tsgo EXIT=0、biome 1089 files EXIT=0、coding-agent collected 5372 = 5287 passed + 5 failed（全部定性既有/环境/flake）+ 80 skipped、`npm run test:kernel` **30/30 绿**、runtime unittest **317 OK**。
- FINAL.md 五段死亡链逐条对照：①②③⑤ 真闭环、④ 死因归因半闭环（自动复活当时在飞）——**批 2 落地后 ④ 闭合**；D2 等待点/exactly-once 同批闭合。
- 终审发现的全部中/高级项已逐笔闭合（每笔先红后绿 + 变异 + 纯净树复验）：A1 豁免预算不闭合 ⇒ `f307f943d`；A2/B9 excused 子代理误标 stalled ⇒ `9a2828d33`；投递重复窗 ⇒ `82c2340ec` + `4b3399eb6`；reaper 归档 lastError 半盲 ⇒ `19f6f96f5`；requeue 日志放大 ⇒ `dcfb7f6ea`；心跳时序 flake ⇒ `b49556902`；catch-up 终态 close 的注释谎话 ⇒ `16c56168f`（诚实登记，行为变更留新立项）。
- 终审点名的三处文档滞后（settings.md 缺 `kernelBootstrap.lockTimeoutMs`、AGENTS.md 缺 `test-hygiene-allow` 通道、FORK_NOTES 缺本轮入口节）⇒ 本提交补齐。

### 六、遗留与待老板裁决

**待裁**（不裁不动工）：① C18 daemon 崩溃策略——已先落地推荐默认形（rejection log-and-isolate + 计数 + degraded 可见，阈值 exit 可开），追认 or 改；② C12 replay 真缓冲环——缓行单独立项（推荐）；③ C21 混版窗终态——维持协商式（推荐）vs 未来硬 bump；④ catch-up「放弃→踢下线」路径彻底移除——需客户端自治重连语义，能力变更单列（`16c56168f` 已在代码处登记）；⑤ F18 两个暂认值（venv.old 保留数 1、收养 create 超时 300s）。

**遗留工程项**：legacy `~/.prime/agent/kernel-venv`（523MB）不自动回收，清理命令与时机见运维手册；11 个 kernel 系测试文件仍硬编码 legacy 路径作 python fallback（收口基准实测；build 后统一改 `activeKernelVenvDir`，否则有「静默跑到旧 runtime」的假验收风险）；`ipython.ts` 的用户提示文案仍指 legacy 目录；P2 测试卫生真清债（recursion 11 条等）；既有红两条（`4600-supervisor-singleton` 上游测试与代码语义脱节、`agent-session-auto-refine-probe` 净化 env 必红）待单开小任务裁决；后台重连 timer 无 unref（低危登记）；schema digest 不覆盖 response 面（登记级）。

**在飞**：B1c 诊断 polish（`spentThisCycle`）在工作区未提交，归后续车道。

细节文档：运维手册 `docs/fork/ma-multistability-ops.md` · 缺口恢复开关档案 `docs/fork/ma-p0-5c-recover-switch-archive.md` · settings 新键 `packages/coding-agent/docs/settings.md` · 审查/施工/终审材料 `/tmp/ma_audit/`（不在仓内，关键结论已收进本节与运维手册）。

---

## 2026-09-07 · 主仓迁到独立仓 + 根代理对用户说话方式

这一轮两件事：把远程身份从「官方 fork + 两个实验仓」收成一个独立主仓；把昨晚未提交的根代理沟通契约入仓并记在这里。

### 一、远程仓库收口

- **做了什么**：唯一主仓定为 [`Dmatut7/prime-agent-rlm`](https://github.com/Dmatut7/prime-agent-rlm)。把本线 `merge/repl-kernel` **完整 git 历史**推上去，替换 rlm 原先那个 1 提交 squash import（`7c3e4c1ac`）。squash 会让之后 `git merge upstream/main` 变成无关历史，不能在那上面继续开发。
- **本地 remote**：`origin` → rlm；`upstream` → 官方；`fork` → 旧 `Dmatut7/prime-agent`（只读路牌）；原 `origin`（`prime-agent-x`）改名为 `archive-x`。
- **旧仓**：fork 最后快照的 README 已改口指向 rlm，之后不再往 fork 推新提交。`prime-agent-x` 在 GitHub 上 Archive（它停在官方 0.7.3，本来就不是这条 0.9.1 REPL 线）。
- **版本**：本线仍是 **0.9.1**。官方已发 **v0.9.3**，下一轮上游同步再跟。
- **为什么改**：三个仓的 README 都在抢「唯一主仓」，本地 `origin` 还指着已停更的 x。再拖只会推错地方。

### 二、根代理用户沟通契约（昨晚未提交工作，本轮入仓）

- **做了什么**：根代理（`rlmDepth === 0`）的用户可见指引从「默认简化技术英语 + 进度播报」换成「Working with the user」契约：用用户的语言、先复述目标再干非琐事、自己拍板不给 A/B 菜单、只在不可逆/花钱/出机/产品口味时提问、每条回复第一句就是结果。子代理不加这段。系统提示末尾再钉一句 reminder，避免长上下文把契约冲掉。
- **为什么改**：根代理是用户唯一在读的那层；子代理对用户不可见，不需要这套说话方式。
- **对用户 / AI 能力**：用户能感觉到根代理怎么回话（语言、结构、少问选择题）。工具调用、REPL、子代理调度不变。
- **验证**：`packages/coding-agent/test/system-prompt.test.ts` 27 passed。changelog 碎片 `packages/coding-agent/.changes/user-communication-contract.md`。提交 `eb03edbac`。
- **故意不纳入**：工作区里那份手改过的 `packages/ai/src/models.generated.ts` 已还原（禁止直接改 generated）；一组 visitor/kick 截图与本线无关，仍留在工作区未提交。

---

## 2026-09-05 · R3 上游同步 + 全面复审 + 第一批修复

这一轮做了三件事：① 把官方又新增的 40 个提交同步进来（R3）；② 对整个 fork 做一次全面复审（6 个维度 × 两个不同模型交叉对质）；③ 把复审出的最高优先 7 个缺陷修掉、并入主分支、推送。下面按"你能不能感觉到"排。

### 一、R3 上游同步（官方 40 个新提交，2026-07-23 ~ 07-29）
- **做了什么**：把官方 main 自上次同步后新增的 40 个提交合并进 fork（merge commit `3367d85c4`，涉及 197 个文件，43 处冲突逐块手工解）。
- **最大件**：daemon 协议 schema revision 26→27（digest `589a2219bc8b`）；CHANGELOG 恢复"只写 fragment、不直接改 CHANGELOG.md"的流程；cherry-pick 了 3 个官方 PR（#2027 / #1947 / #1896）。
- **本地东西一个没丢**：264 个本地独有文件、54 个本地独有测试全部保住、零覆盖（硬约束：全程用 merge，绝不 `git checkout upstream/main -- .` 整树覆盖）。
- **状态**：✅ **已合并回主分支 `merge/repl-kernel`（本次 merge-back，schema27 基线就位）**；F4（别车道未提交工作）已解决。完整同步详情（40 提交逐条 / schema 23→27 撞号史 / #1896 fork 适配 / S9 待办）见下节「2026-09-04 · R3 上游同步（详情）」。

### 二、全面复审（6 维度 × qwen3.8-max-0902 + kimi-k3 双向交叉）
- **做了什么**：6 个 lane（正确性 / 性能 / 业务逻辑 / 代码质量 / 优雅性 / 垃圾代码审计），每个 lane 由两个**不同**模型独立审、再逐条对质收敛——避免单模型盲区。
- **产出**：全新记录 `REVIEW_FINDINGS.md`（28 个修复簇，编号 F1-F28）+ `FIX_PLAN.md`（修复计划，经多模型双审通过）。这两份取代旧的 `docs/fork/audit-findings.md`。
- **沉淀的复核纪律（62 条）里最关键三条**：
  - **总闸原则**：任何优化都不能降低 AI 的能力。这条抓出并修正了 2 个"看似优化、实则降能力"的修法。
  - **验收恒真检测**：每个断言 / CI 门必须有"植入已知违规 → 必须红"的正控，否则门是假的（恒真）。
  - **grep ≠ 可达性**：grep 到危险模式只证明模式存在，必须读包住它的代码确认它真能触发。

### 三、第一批修复（7 条，已并入主分支 + 推送，HEAD `4871d9223`）
全部满足"对 AI 能力提升或中性"（总闸零违例）；每条带回归测试（先红后绿证明）+ 变异测试（锁住每个修法分量，半变异也得红）。

| 编号 | 用户能感觉到的问题 | 根因 → 修法 | 对 AI 能力 |
|---|---|---|---|
| **T12** | 长时间跑后终端报 MaxListenersExceededWarning、最后废掉 | 每次 sleep 调用泄漏一个 abort 监听器 → `{once:true}` + settle 时 clearTimeout | 中性（行为逐字不变；变异测试锁两段修法） |
| **T0** | （看不见——是防回归的门） | 测试债无门拦截、私有探测泛滥 → 加 `test-hygiene` CI job（私有探测扫描器）+ 测试可信度三修 | 中性（零生产代码改动） |
| **T5** | google/vertex 返回畸形工具调用时，工具竟被执行了 | stopReason 把畸形调用洗白成 end_turn → 路由到 malformed-tool-call 错误路径 | **提升**（畸形工具不再被误执行） |
| **T3a** | 编辑器输入某些宽字符（不可断 grapheme）→ 栈溢出 → 整个终端崩溃（E6） | 递归无守卫 → 加 `subSegments.length < 2` 守卫 | **提升**（拼接还原逐 code point，不丢输入） |
| **T9** | anthropic/bedrock 带 thinking 的会话，每个后续回合必挂 400 | thinking 签名跨回合重放污染 → 剥掉非末回合签名 + 降级为 text | **提升**（每回合必挂 → 可降级续聊） |
| **T7** | 高频 mutating command 时 daemon journal 每条 fsync 拖慢 | per-record fsync → 去 append fsync、compact 时 fsync 保留、journal 限界 | 中性（掉电窗口 ≤4096 条 / ≈5.4 分钟，已在 changelog 诚实披露） |
| **T1c** | 大工具参数时 UI 每帧 O(n²) 重算 argsSignature、卡顿 | 每渲染重算 → O(1) 缓存 | 中性（rebuild 触发集合 ⊇ 修前，不漏渲染） |

- **合并怎么做的**：先建一条干净集成分支、验证 7 条改动文件级零重叠（任意顺序合并无冲突）→ `npm run check` 全绿 → 受影响包测试全绿（tui 200/0、ai 36 passed、coding-agent 137/0）→ ff-only 并入主分支 → 推送。**全程别车道的未提交工作完整保留**（porcelain 始终 13 行）。

### 四、还没做（下一批 · R3 已合回 → schema27 基线就位、F4 已解决、可立即并行开工）
复审出的 28 簇里，第一批做了 7 个最高优先、且与 R3 零交集的。**R3 merge-back 已完成（本提交）、schema27 基线就位、F4（别车道未提交工作）已代提交解决**，剩下 21 簇现在都能在 schema27 基线上开工（不再冲突）：
- **第一批 R3-交集 10 条**：T1a/T1b（流式节流）、T2（fork 错误恢复四件套）、T4（崩溃放大器）、T6（压缩三机制）、T8（OSC133）、T10（retry 假死）、T11（BrandSplash）、T13（side-question 流停滞）、T14（refine 窗口）。
- **第二批 F9-F16**：bedrock token 口径、response.incomplete、schema digest 门、出站表、contract 工单、gpt-5.5 定价、handoff msg id、usage.input Math.max、垃圾代码纯删。
- **第三批架构 F17-F25**：god-object 拆分、循环依赖解除、测试与生产分歧。

细节文档：全面复审 `docs/fork/review-findings-r3.md`、修复计划 `docs/fork/fix-plan-r3.md`、R3 同步任务书 `docs/fork/sync-upstream-r3.md` + 附录 `docs/fork/sync-upstream-r3-appendix.md`（已随 R3 合入主分支）。

---


## 2026-09-04 · R3 上游同步（详情）

分支：`sync/upstream-r3`，基线 `merge/repl-kernel` @ `0c504e475`。任务书本轮起随代码入仓：`docs/fork/sync-upstream-r3.md` + `docs/fork/sync-upstream-r3-appendix.md`（`daemon-protocol.ts` 的 schema 注释直接引用其中的 S5.1 表）。

### 同步了什么

一次 `git merge upstream/main`（`d74a75fea`，**40 个上游提交**，197 文件 / +18437 −1704）：本地 **172** 个自研提交对上官方 0.9.x 线。冲突 **43 块 / 18 文件**全部手工解，每块记「取了谁、为什么、翻回把手」（12 份车道回执存档）。

| 提交 | 内容 |
| --- | --- |
| `3367d85c4` | merge commit（2 parent：`0c504e475` + `d74a75fea`） |
| `2f72fe3d1` | S5：`DAEMON_SCHEMA_REVISION` 26 → **27**，digest 重算为 `589a2219bc8b` |
| `ea68ff750` → `9ee1ea51c` | S6：先重建 4 个包的 CHANGELOG Unreleased（101 行），后按 AGENTS.md「不手改 CHANGELOG」**revert**，改走碎片单一真相流程 |
| `e59a452ce` | 碎片格式修正：#1249 碎片补 issue 引用、#1229 bullet 收口 |
| `bc012cfb2` | rlm-ledger `replayCache` 失效与克隆隔离的白盒钉（A-2 变体 A） |
| `ebb26a3ac` | S7 摘 **#2027**：RLM 子树取消改一次迭代 visited 遍历（治本地 `hasRunningRlmChildren` 等三个 walker 的 2^k 重走） |
| `7f5e1ba3a` | S7 摘 **#1947**：kernel stderr 落每会话日志文件 + fork 适配 3 处（`0o600` + no-follow，堵住 lane B 风险 R6 重开 F3 的口子） |
| `f22e65312` | 修 merge 引入的红：`fixq5-q7` 假 supervisor 缺 roster 桩（F73） |
| `13f623676` | 修 merge 引入的红：`agents-view-roster` 假 connection 缺 `streamReconstructor`（F74） |
| `bdd5bcd82` | 修 merge 引入的红：非持久化会话不再落 `semantic-edges.jsonl`（F72） |
| `bd35d1287` | 修测试污染：`agents-view-roster` attach 测试隔离 agent 日志目录（F77） |
| `b20f16427` | S7 摘 **#1896**：空终回合重试（最多 3 次，空的那次弹出、不进 provider 上下文与 transcript，第 3 次连续空当回合错误上报）+ **2 处 fork 适配** |
| `7a6e74c57` | 碎片归并：空回合重试的 2 个碎片合成每包 1 个 |

**#1896 已摘（`b20f16427`，6 文件自动合并零冲突，+235 −13）**，预判的两处 fork 适配都落地了：

1. `packages/agent/src/agent-loop.ts`：本地 stream-stall 返回路径（`finishStalledMessage`）在重试 wrapper 接管 `message_end` 发射之后仍保留自己那次 emit ⇒ 一个 stall 回合**双发 `message_end`**（`appendMessage` 无去重 ⇒ 同一条助手消息落盘两次，扩展 handler 与 telemetry usage 双触发）。删掉内层 emit，与 PR 处理 `finishAbortedMessage` 的方式对齐。
2. `packages/coding-agent/src/modes/interactive/interactive-mode.ts`：每次重试都发一个新的 `message_start`、被丢弃那次没有 `message_end`，而 `startAssistantStreamingMessage` 无条件覆盖 `this.streamingComponent` ⇒ 前一次的组件留在聊天树里未 settle。改成**先 settle（或移除）前一个组件**，对齐 `agent_end` 边的做法（这正是 lane B 风险 R5 预言的幽灵气泡）。

另记一笔（p11 实测）：`agent-session.ts` 那个 hunk 在本 fork 的生产路径里是**惰性**的——本地 F70（`f98d84ada`）的终错通知已经先回了父代理并 bump `_parentReplyCount`，而那正是该 hunk 的守卫条件。仍整取，因为上游的 recursion pin 用不带 agent-message controller 的夹具走它。

### schema 23/24/25/26 四层撞号 → 升 27 的由来

分叉点 `5b6c0e94e` 是 rev 23。此后**本地与上游各自把 23/24/25/26 用了一遍**，同号不同 wire：

| rev | fork 侧 | 上游侧 |
| --- | --- | --- |
| 23 | `omitStreamingMessages` on list | `list_agent_peers`（`ceb418049`, #1861） |
| 24 | 重编号，含 rev-23 两特征（`bf542ce7e`） | roster 订阅与推送（`1d2e91d3b`, #1900） |
| 25 | `streaming_deltas` + `assistant_stream_delta`（`c72b9940f`） | 直连 worker peer transport（`173d845a5`, #1926） |
| 26 | 服务端 capability 强制 + `control_plane` + `declare_client_capabilities`（`96d3db580`） | 会话行 usage 合计（`d74a75fea`, #2003） |

merge 后 wire 是两侧并集，**哪个 26 的 digest 都不匹配**；本地握手是 `schemaId + appVersion` 精确匹配、无协商降级 → 不升号则本地客户端把官方 daemon 判 stale、反之亦然。处置：`DAEMON_SCHEMA_REVISION = 27`，digest 用仓内算法重算（sha256 三段切片取前 12 hex = `589a2219bc8b`，**禁手写**），6 个切片锚点复验「各命中 1 次且严格递增」，公式对三个基线（本地 `31fb64b6f4ee` / 上游 `962b8b4c5e35` / 分叉点 `649fe649d15e`）逐一复现。**23-27 五个号永久退役**（27 已被本轮 R3 的并集 wire 消费，`DAEMON_SCHEMA_REVISION = 27`、下一个可用号是 **28**；下一轮取号前必须先读 `daemon-protocol.ts` 的头注，否则会出现第五次撞号），撞号表与两侧 digest 已写进 `daemon-protocol.ts:79-108` 的注释（行号会漂，按 "Revisions 23, 24, 25 and 26 were each claimed twice" 这句 grep 定位）。

### 丢了哪些本地实现（有意取舍，均带依据）

| 本地轴 | 处置 | 依据 |
| --- | --- | --- |
| 刷新节流轴：`scheduleWorkerSummaryRefresh` / `CoalescedSummaryRefresh` / `SUMMARY_REFRESH_MIN_INTERVAL_MS` / `lastSummaryRefreshAt` | **删净**（全仓 0 命中，无孤儿） | 上游 #1897 + #1900 改 roster 事件驱动 + delta 推送，「按 token 拉全量摘要」的路径本身消失 |
| `handleList` 每次向所有 worker 各拉一遍 list | **删**（取官方 roster 遍历，`handleList` 零 worker 往返） | 留 ours = 把 #1897/#1900 的收益原地废掉；本地轴「客户端 list 必拿新鲜数据」改由 roster 推送 + `scheduleRosterRepairPull` 兜（见 `docs/fork/local-axes.md` 第 3 条） |
| `propagateHeartbeatStateToAncestors`（祖先行 running 提升） | **删**（随官方 #1967 `d72beaf9e` 有意删除，不恢复调用点） | `git log -S` 双侧 + base 三方定位确认是上游有意删；官方改「心跳会话是普通会话」 |
| `syncAgentPeers`「名单没变不重发」 | 早在 `bf542ce7e`（R1 上游合并）就没了 | 本轮才把 README 表格里这条过期项删掉 |
| `omitStreamingMessages` 的 supervisor↔worker 半边 | **保留但休眠**（尾参恒 `false`，唯一读者是一个本地测试） | 根代理裁定 (A) 保持现状；风险与清理触发条件记 `docs/fork/local-axes.md` 第 1 条 |

### 已知红清单（任务书 S8.4 的 5 项）与消红

| 红项 | 从哪一步开始红 | 消红于 |
| --- | --- | --- |
| H1 的 PLANE 总量表破口（核查脚本第 3 项 = 1） | S1.2 第 6 步 | 同步消红（v2 已把 S2.3 并进第 6 步） |
| `test/daemon-protocol.test.ts` 的 schema digest 自检 | S1.2 第 6 步（块 1 临时取 ours 的 26） | **S5 `2f72fe3d1`**（该文件 28 passed / 0 failed） |
| `test/daemon-supervisor-streaming-list.test.ts` | merge 那一刻（静默存活成必炸文件） | **S4**（p9 重写，把上游「`handleList` 不再转发」钉成 `expect(requests).toEqual([])`） |
| `npm run check` 因 `grok-mermaid@0.2.3` 未装而编译不过 | merge commit 落地那一刻 | `npm install` 之后（门1 实测 EXIT=0，Checked 1022 files，`--write` 零改写） |
| `tsgo --noEmit` 因 `mermaid.ts` 解析失败而红（与上一条同源） | 同上 | 同上 |

父代理裁定新增的第 6 项**不属本轮**：`test/extensions-timeout.test.ts:102` 在 merge 之前就红（`0c504e475` 上逐字同失败，独立 scratch worktree 对照实测）→ 记 **F75**，S9 待办认领。

本轮 54 个本地独有测试文件的收口总账：collected **320** = passed **319** + failed **1**（= F75）+ skipped **0**（205 + kernel 5 + agent 3 + ai 5 + tui 107，自洽）。

### 本轮新缺陷

7 条续 F 编号记入 `docs/fork/audit-findings.md`：**F71-F77**（接 F70c）。4 条已修（F72 `bdd5bcd82` / F73 `f22e65312` / F74 `13f623676` / F77 `bd35d1287`），3 条待办（F71 / F75 / F76）。同文件另记：30 个新 PR 的裁定台账与 3 条新判据、3 条路径纠错、4 条门方法论。

### S9 待办清单

1. **F71**：`src/core/semantic-edges.ts` 的写入改走 `src/utils/private-files.ts`（0700 / 0600 / no-follow）。`bdd5bcd82` 只挡住了非持久化会话，**持久化会话的 ledger 仍是裸 `node:fs` 写的**（`:357` `mkdirSync` 无 mode、`:363`/`:367` `appendFileSync`）。
2. **F75**：**R3 全面审查已实测 ⇒ 不修测试、据此关闭或重审**。`test/extensions-timeout.test.ts:102`（`errors` 实得 2 vs 期望 1）是**既有 extension-loading 家族红**，红因在 `loadExtensionModule` 实现、**不在 `loader.ts`/`timeout.ts`**：把 `timeout.ts` 换回 B1 修复之前的原文（`git show HEAD:`，sha256 `9c0814a6309f2870`）重跑**逐字同样红** ⇒ 与 B1 无因果；代码层佐证 `loader.ts:427-456` 串行加载、超时只包 `factory(api)`、**转译在超时之外** ⇒ 40ms 不可能让同步的 `ok.ts` 失败。**别改测试断言**（会把正确行为钉成错误行为）；要动就转 `loadExtensionModule`。
3. **F76**：`WINDOWS_NAMED_PIPE_ACL_UNVERIFIED` 死导出接进 `test/windows-named-pipe.test.ts`（**建议接不建议删**：它承载「这条安全面未真机验证」这个事实，删了等于丢一条已知未覆盖面记录）。**R3 全面审查补的三条事实**：① win32 侧 ACL 是**唯一**鉴权闸门（`daemon-mode.ts:3277` 对主 daemon 一律 `authenticated: true`、全仓无 peer credential/token 握手；POSIX 还有 `daemon-socket.ts:186` 的 `chmod 0600` 兜底，win32 无对应）② ACL 是在 `listen()` 回调里用 `SetNamedSecurityInfo` 打在「当时那个实例」上（`daemon-mode.ts:667`/`daemon-supervisor.ts:827`），libuv 建后续实例传 `NULL` `SECURITY_ATTRIBUTES`，**Windows 无文档保证继承** ③ **R3 只把 `.changes/windows-named-pipe-acl.md` 的完成态断言降级为 best-effort（去 "Restricted"），不做 token 握手**；握手（capability + 协议版本 + 双向兼容测试 + 真机验证）**记下一轮**，仍是收口前提。
4. `omitStreamingMessages` 休眠接缝二选一：给尾参找回生产调用者，或连唯一读者测试一起删。**（R3 全面审查补两点）行号更正：客户端活点是 `src/modes/agents-view/agents-view-mode.ts:217-230`，不是 `daemon-mode.ts:1898`（那是 cron）—— `docs/fork/local-axes.md` 里本来就是对的，错的是派单文本。启用前陷阱：`daemon-mode.ts:4184-4185` 会**无条件继承上轮的 `streamingMessage`** ⇒ omit 期间结束的 turn 会把大对象永久钉在 roster 上；启用时改成 `summary.isStreaming ? previous.get(...)?.streamingMessage : undefined`。**
5. 门 2 口径扩三层（54 个本地独有文件 / 15 个官方新增测试文件 / 共有文件里的本地独有用例）——本轮 F72、F74 两条红都在文件级口径之外，只有全量跑才保险。
6. R2 遗留里 **F5/F6 实际已在 R2 末期落地**（`96d3db580` + `7efe4b467` + `6e86b3929` + 测试 `6b8d2585b`；服务端强制点在 `daemon-supervisor.ts:1825`、`daemon-mode.ts:3655`，控制面分流在 `daemon-mode.ts:3558`），`audit-findings.md` 的 `[ ]` 本轮已按代码证据勾掉。仍开着的是：F15/F17 窄时序窗、F27e 次要内存项、Windows 管道 ACL 实机验证、k3 终审 7 条低危。
7. 30 个新 PR 里 lane B 判「观察」的 7 个（#1928 / #1996 / #305 / #1177 / #1252 / #2028 / #1581）与 deps 线判 TAKE 的 5 条（#2018 / #2017 / #1576 / #1577 / #1579 改拿 18.0.10）**本轮一条都没动**（实测 `actions/checkout` 仍 v7.0.0、`actions/github-script` 仍 v7.0.1、`uv.lock` 零变化），下一轮按 `docs/fork/audit-findings.md` 的台账接着裁。
8. **【R3 全面审查新增】#1947 staleness 与下一轮任务 B**：本 fork 摘的是 #1947 的 **09-02 版（`ca7f26ca5`）**；上游 **09-04 已把同一处重设计**（head `56982582b`，**仍 OPEN**、当天还推了 5 个 commit）为 pipe + host 转发 + 5MiB 写预算 + `StringDecoder` + exit-drain + 等 close。**那些是上游第 4-9 个 commit，本 fork 未摘 ≠ 删除**。一旦上游合并，本 fork 的 `wireChild`/`openStderrLogFd`/`waitForReady`/`cleanupResources` **四处必冲突**。**任务 B 触发条件**：#1947 合进 upstream main，或下一轮同步启动（以先到者为准）⇒ 按 head 重取，届时 pipe-path 的 `StringDecoder`/drain/last-words 与 `M3(k)`（无 per-spawn 预算 + `.old` 长存）一并解决、`M1(pr)` 的 tail 挤压自动消失。**A 批（本轮）只做设计无关的纯 fork-side 加固，不半迁移、不给 fd-direct 加 drain。**

---

## 2026-08-29 晚 · R2 迭代

在 R1 基线上追加了第二轮工作。

### upstream 二次合并（15 提交）

upstream/main 新增 15 个 squash commit，已并入（`71eeb5629`）。含 #1756（worker 恢复后再复用）、#1842（队列状态单一来源）、#1845（RLM 子快照单一投影）、#1859（quiescence 事件唤醒替代轮询）、#1882（官方版 bash 并发 abort）、#1864（in-flight open 所有权）等。冲突逐 hunk 解，并入后跑常驻回归套件。

### W0-W9 工单结果

- **W0**（upstream 二次合并）：完成。15 提交并入，冲突 5 个文件逐 hunk 解。
- **W1**（F70 子代理错误通知父代理）：完成。耗尽/永久错误 → agent_message 通知父代理（`f98d84ada`）；不做从零退避。
- **W2**（F10 edit 原子写 + F11 exec 进程组/输出截断）：完成（`577f1032b` + `8dde3fdfa`）。
- **W3**（#1253 移植：宿主拆除取消在途 kernel host 请求）：完成（`4afca168e`）。
- **W4**（F42 分支切点对齐工具对）：完成（`43798f22d`）。
- **W5**（B8 键绑定迁移）：完成（`142022669`，12 处迁入配置表）。
- **W6**（k3 低危十条）：完成。5 修 5 留档（`204fe7811`）。
- **W7**（F5/F6 安全收口：supervisor capability 校验 + shutdown 鉴权）：**在跑**。
- **W8**（F4 Windows 管道 ACL）：完成（`2637973c1`），标注「Windows 未实机验证」。
- **W9**（F15/F17 窄时序窗）：留档未开工（k3 实证可达性极低）。

### 文档搬迁

fork 工作文档统一搬入 `docs/fork/`：审计总账 `audit-findings.md`、R1 任务书 `fix-plan-r1.md`（原 `FIX_PLAN_20260829.md`）、R2 任务书 `fix-plan-r2.md`。`FORK_NOTES.md` 保持为简洁入口（`acd9b3ed1`）。

### R2 遗留（截至 R2，部分已被 2026-09-05 全面复审重新评估）

- F5/F6 安全收口（W7，在跑）
- F15/F17 窄时序窗（W9，留档）
- F27e 次要内存项（subagentSnapshots/sideQuestionTurns 未加帽）
- Windows 管道 ACL 实机验证
- k3 终审 7 条低危

详见 `docs/fork/audit-findings.md` 未勾条目与 `docs/fork/fix-plan-r2.md` 状态列。

---

## 2026-08-29 · R1 大合入

### 这次更新是什么

一次大合入：官方最新内核 + 官方未合并 PR 精选 + 一整天源码审计出的缺陷自修。三管齐下，测试 4580+ 绿。

### 内容从哪来

1. **官方 main 合并（18 个提交）**：最大件是内核换血——Jupyter/ipykernel 换成官方自研的极简 CPython REPL（`rlm.repl`，启动 1.2s→30ms，内存更瘦）。注意：官方把 `%%bash`/`%cd` 这类魔法语法废了，改用 `bash('cmd')`/`os.chdir()`。
2. **官方未合并 PR 拿了 9 个**（官方合得太慢，不等了）：#1882（bash 并发 abort 修复）、#367（Anthropic 工具参数丢失）、#1700（消息重复投递）、#1249（文件权限 0600）、#1251、#1253、#1519、#413、#887。另外 60+ 个 PR 评估后放弃（名单与理由在 docs/fork/audit-findings.md）。
3. **自修 40+ 个缺陷**：9 个代理独立审计 + 多模型交叉对质 + 三轮逻辑复扫出来的，每一个都有代码级证据。

### 解决了什么问题（按你能不能感觉到排）

- **内存不再膨胀**：以前跑两三天 TUI 进程 2.4~3.5GB，现在聊天记录有上限、图片用完即释放。
- **「卡死」有救**：bash 命令默认 10 分钟超时；任何卡住 5 分钟报警+留现场日志、15 分钟自动救活会话；4 个具体卡死根因已修。
- **子代理可靠了**：父催子消息不再丢；print 模式不再误杀还在干活的子代理；子代理死了会被发现。
- **粘贴不再假死**：半截粘贴 30 秒自恢复，Esc 可取消。
- **安全收紧**：会话记录 0600（同机其他用户读不到）；/share 上传前扫描 API key 并警告。
- **MCP 断了能自愈**：MCP server 崩溃后自动重连。
- **compaction 不再风暴**：小窗口配置下不再每回合狂压。
- **老用户升级不炸**：cron 迁移失败降级为日志；存量 0755 目录自动收紧不报错。

### 验证口径

- 每次并入：`npm run check` 全绿 + 交叠区域测试并集
- 终检：全量套件 4580 绿；失败仅剩网络依赖（telemetry/git-update/version-check）与重负载偶发，均有分类结论
- 修复全部带回归测试（先红后绿验证）
