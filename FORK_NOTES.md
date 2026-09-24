## 2026-09-25（上午）0.11.14 业务流程体检：六路审查、六路修复

- 起因：老板一天内撞到两个「只想到一种用法」的洞：粘贴图片路径不走看图模型（主模型转手给子代理）；Ctrl+Y 打开的诊断详情关不掉。两处先修（9d0c31107），随后按真实使用场景分六块审查（看图、卡住与自愈、备用模型、子代理、联网搜索、界面），核实后分六路并行修，合并后全量检查、改动涉及的测试（coding-agent 759、ai 39、tui 87）与干净树类型检查全绿。
- 离开几天能放心的部分：服务商短暂故障不再一分钟就结束任务（共享请求额度在换模型/等待时重置，长等待能真正跑到）；换到备用模型期间重启后仍会按时回主模型，长等待重启后能自己续上；余额不足、免费额度用完会换模型；百炼内容审查拒答时把最近的网页原文换成说明后重试，不再整会话卡死；安静但在忙的长任务不再到 50 分钟被杀；子代理闲置关闭后结果仍能收回，追加任务不回话会通知父代理，新增 Alt+X 一键停掉全部子代理。
- 看图：被打断、恢复会话、事后追问图里内容都会再交给看图模型；Ctrl+V 的图存成文件可重新加载；拖文件/粘贴图片路径直接变成图片附件；看图模型出错只换看图模型、不动主模型；转交时对话里写明交给谁看。
- 其它：「没做完就停」的中文误判修正；值班记录不重复计数、自动模式不再只算几分钟、长时间挂着回来按键会弹出；诊断详情开头有中文说明；查价长网页不丢价格行、PDF 读出文字、SearXNG/Docker/VPN 挂了明确说搜索不可用；翻看模式（Alt+↑）不再卡死、全屏能滚动、消息时间带日期、若干英文提示改中文。

## 2026-09-25（凌晨）0.11.13 本地联网搜索、子代理面板、看图交接

- 新增内置技能 `web_research`：本机 SearXNG 搜索（引擎重调，8 条测试查询 0/8→8/8 有结果）、分层读网页（指纹 HTTP→无头浏览器→网页存档）、无头点到下单/购物车页读实际价（付款、下单、个人信息一律拒绝）、arXiv/Crossref/OpenAlex/Stack Exchange/GitHub。实测 RackNerd、搬瓦工、LisaHost 三家走到购物车，均停在付款前；全程不弹窗、无残留进程。打印结果先给价格/配置行、正文限长，避开百炼内容审核 400。老板全局规则搜索段把它列为要准确内容时的主通道。
- 老板实拍修：子代理面板回车直接打开选中子代理（原来只开会话列表）、超过 4 个可滚动；子代理闲置 20 分钟即关（`childIdleEvictionMinutes`，原 90 分钟且主会话开着时整窝不关）；全闲置时面板收成一行；用户气泡去掉大缩进。
- 看图交接：会话记录核实，看图模型两次都真收到图（image token 392/1015），交回 GLM 后占位符只写「已省略」，GLM 误认「没人看过」并写进记忆。占位符改为说明谁看过，误报提示改为只查真正带图的回复，那条错误记忆已按事实改写（有备份）。

## 2026-09-24（深夜）0.11.12 乱码工具调用只显示一行

- 老板实拍：GLM 写坏工具名（`ipythone_code</arg_key><arg_value>None</arg_value>`），界面把乱码、`{}`、英文 not found 摊成黑底大块，运行卡里也夹着乱码。工具名不像工具名时收成一行淡色提示、步骤标签「写错的工具调用」，展开仍见原文；测试钉住。发 0.11.12。

## 2026-09-24（深夜）0.11.11 左边距

- 老板实拍：`◆` 与 AI 竖线、运行卡紫边画在第 0 列，被终端切掉，看起来像没有抬头和竖线。统一挪到第 1 列（与其它行同一边距），测试钉住；记忆提示里下划线标题显示成 · 分隔。发 0.11.11。

## 2026-09-24（深夜）0.11.10 聊天分层界面 v3

- 按老板认可的设计稿第 10/11 页落地：用户气泡（you＋时间）、`◆ prime` 抬头＋青色竖线、操作记录收成回复首行、运行中卡片（此刻动作＋总账＋最近三步，1 分钟无输出变黄）、系统提示居中一行、底栏运行标签与两秒提示；修 Ctrl+Y 无效（卡住提示在回合结束时被拆掉）、「查找 .」「设置 files」标签；Ctrl+Y 诊断改为淡色「诊断详情」块。隔离后台实拍 120/80 列、运行中与结束后逐项对照设计稿。发 0.11.10。

## 2026-09-24（晚）0.11.9 卡住提示与常驻进程

- 老板实测百轮聊天：模型 `await bash("node _keep_open.mjs …")` 等一个设计上不退出的进程，5 分钟后被静默规则停掉，11 秒后改 nohup 后台启动自愈；同时卡住警告以「出错：」整段英文诊断刷进对话。改为动作条上一行中文摘要（等哪一步、多久、后台几个命令），诊断细节留在 Ctrl+Y；终止类只一行中文＋诊断记录路径；提示词补「常驻程序不 await」带原例。发 0.11.9。

## 2026-09-24（晚）0.11.8 搜索提速

- 老板实测搜新闻 3 分多钟等不到结果。实测定位：qwen3.8-flash 默认开思考，一次新闻检索 4747 个思考 token、91 秒；关思考 21 秒、答案等长。搜索默认 `enable_thinking: false`（可 `thinking=True` 打开），带测试钉住；发 0.11.8。

## 2026-09-24（晚）0.11.7 搜索超时与步骤标题

- 老板实测「搜今天的新闻」：默认 90 秒超时，新闻类检索超时，模型凭记忆改 300 秒重跑；默认改 240 秒。to_thread 形式的搜索步骤显示成「查看输出」，标签规则补上 bailian_web_search 与不带括号的写法。发 0.11.7。

## 2026-09-24（晚）0.11.6 搜索结果可 await

- 老板实测：模型照其它技能的习惯 `await bailian_web_search.search(...)`，同步函数返回 str 后 await 报错，190 秒搜索结果被吞。搜索改为返回可 await 的 str 子类（两种写法都能用），说明书同步；测试红→绿。发 0.11.6。

## 2026-09-24（晚）0.11.5

- 设置监听修复单独发版 0.11.5（手工改号），本机同步安装，免得等下一版。

## 2026-09-24（晚）三天提交的能力体检 + 0.11.4

- 四路只读审查（模型可见文字／行为控制／内核与工具／后台处置）核 9/21 起 187 笔提交，确认的能力退化全部修掉并各带红→绿测试：无活性证据的工具调用在 180 秒被杀（改为按静默规则：输出、进程树 CPU、在途 host 请求、显式超时都算活着）；daemon 卡住处置违背 9/17「只警告」决定默认打断（改为只在显式开启静默中止时动作，豁免实时复核）；自动继续越过「等你批准」；提示词在有其它工具时仍称「只有一个工具」；压缩丢改过的文件；一张图让整轮改用看图模型（读完即交回会话模型）；bailian 搜索技能示例写错；技能恢复误报另一路径；预导入覆盖恢复变量；yaml 兼容；uv 安装路径；重派前先删原子代理。
- 版本 0.11.3 → 0.11.4（手工改号，不再用 npm version）。
- 0.11.4 推送后远程 CI 唯一红是设置文件监听的真 bug：开始监听与轮询首次记录基准之间写入的文件会被当成「本来就有」，永远不触发重载（CI 慢机器上必现）。现在开始监听后两个周期再主动核对一次；该测试连跑 5 遍全绿。

## 2026-09-24（傍晚）0.11.3 发版

- 版本号 0.11.2 → 0.11.3（八个包同步），各包 `.changes/` 片段汇入 CHANGELOG 的 0.11.3 节，根 CHANGELOG.md 补大白话版本说明，打 `v0.11.3` 标签并在 GitHub 发布页附升级须知；一键安装 `install-fork.sh` 装的就是这一版。
- 根 CHANGELOG 的 0.11.3 节按老板要求重写成面向使用者的说明（先说你会遇到什么、能做什么、怎么开，不写施工过程与内部用语），往期写法不再沿用；发布页同步。

## 2026-09-24（下午）提示词「讲道理」改写，A/B 考试 16/16 对 14/16

- 按老板在客服 AI 上验证过的方法（教为什么、不教说什么）改写：内置提示词与五条近处提醒（自动继续、命令卡住、空回复恢复、技能不可用、子代理结束通知）每条规矩带原因、给判断标准；新增「做事」一节（说完成前先亲眼看到验证、先找原因再修、只改任务需要的）；内部简称要翻成大白话。本机全局规则 ~/.prime/agent/AGENTS.md 同法改写（事实写死、判断讲理，教训一条不丢，过期/矛盾两处删，带日期的历史挪到 AGENTS.history.md），长期笔记去掉「母席/子席/硬门」等内部叫法；旧文件备份在 ~/.prime/agent/backup-before-reasons-20260924/（含一键换回脚本）。
- 独立双后台 A/B（8 题×2 遍，同模型 glm-5.3-prime）：新 16/16、旧 14/16；旧版两遍都改测试文件塞假模块再报「全部验证通过」、两遍对老板说「子席」、一遍把 proj 当成整个仓库白跑 12 分钟；新版总 token 少一半多、花费约减半，没有一项比旧版差。

## 2026-09-24（午后）外部审查八条的处置 + 远程 CI 转绿

- **换模型更稳**：换模型链不再写死在源码里（源码默认不换），改在本机 settings.json 设 `providerFallbackModels`：kimi-k3 → qwen3.8-max-0902 → glm-5.3-prime（稳的、能看图的在前，GLM 因已知乱调工具放最后）。对话里有图时只换到能看图的模型。
- **自动继续更准**：答完后客套「接下来我可以……/如需要我再……/If you want, I can…」不再被当成没做完而续推。
- **内存**：已删子代理只保留核对通知用的几个字段，不再挂着整个子会话。
- **远程 CI**：此前一直红是 12 个老测试（已修）；最后一处是 eviction 测试把 24 小时超时写成精确值，慢机器上差 1 毫秒即红，改为容差。
- **工作区清理**：agent CHANGELOG 里重复的 0.11.0 标题改成 0.11.2（两条恢复功能正属该版）；仓根 sales-ai 截图/文本挪到 ~/Desktop/ai/misplaced-from-prime-agent-20260924/（未删）。
- **下次同步上游前待办**：上游 v0.9.6 revert 了 #2154/#2155（恢复按类型的 harness 包装与手工 refine 方法），本 fork r16 已改为 harness 条目身份唯一、最近优先注入，两边语义可能分叉，合并前先逐项对齐。
- 核对后无需改动：重试花费（长等待只由 5xx/过载触发，这类失败请求一般不计费；空回复重发有固定上限），daemon 8MB 写缓冲（每连接上限，超过即判卡死断开，连接数通常个位数）。

## 2026-09-24（中午）「部分 Python 技能不可用」误报根治

- 会话工作进程被回收重开（关窗口、后台重启）后恢复内核状态，旧状态里存着技能的原始模块，初始化把 agent_message / agent_observe / 联网搜索 / goal 等当成「名字被占用」拒绝，并把错误状态再存回去，每次恢复都复发。现在恢复出来的是技能自己目录里的模块就正常加载；冒名的（标准库、runtime 自带模块）照旧拒绝。已中招的会话下次恢复时自动好。

## 2026-09-24（上午）无人值守自救 + 值班记录 + 界面尾巴

- **命令卡住自动停**：一步命令既没输出、进程树也不耗 CPU，超过 5 分钟（`tools.timeout.silentStuckSeconds`）就停掉，并告诉 AI 卡在哪、换个办法；同一步卡两次会明确叫它别再跑。一直出输出或安静但在算（安静跑测试、装包、编译）的不会被误杀；AI 自己给命令设了更长 timeout 的按它的来。没人应答的「内核忙」询问 60 秒后自动重启内核。
- **提早停下自动继续**：AI 干了活、说「接下来我去…」却停了，自动推一下（每个请求最多 2 次）；最终答案、向你提问、等子代理都不推；推的话不算用户消息。
- **服务器出错自动换模型**：重试用完或额度用完后按 glm-5.3-prime → kimi-k3 → qwen3.8-max-0902 换（`providerFallbackModels`），GLM 连续 3 次乱调不存在的工具也换；30 分钟后换回主模型；全部不可用时按 5/10/20 分钟一轮等待重来（约一天），不直接结束任务；手动换模型优先。重试提示中文化。
- **值班记录**：离开 2 小时以上回来，输入框上方先出一段 ≤6 行中文小结（干了多久、完成几轮、出过什么问题是否已自动处理、需要你拍板的事、可能没做完、最后在做什么）；`/值班` 或 `/dutylog` 随时看。
- **子代理「没回话」误报修复**：子代理其实回了话（父代理正忙，回话在排队），父代理随后删掉/释放子代理，那条「完成但没回话」的通知仍会发出并把父代理多叫醒一轮；现在删除后仍保留运行记录用于核对，误报不再发。「提醒子代理回话」实测会造成重复消息，默认关闭（`selfRecovery.childReplyNudge` 可开）。
- **界面尾巴**：Alt+↑/↓ 逐块浏览（Enter 展开、y 复制、Esc 返回，可改键）；代理消息行对齐本轮步骤；排队预览中文；修好 12 个长期红的老测试。
- **无人值守考试**（`test/suite/unattended-exam.test.ts`）：同一轮里连续 500、命令卡死、提早停下，全部模型宕机一段时间，空回复——都自己恢复并在值班记录里写清；后台重启续跑由原有重启套件覆盖，全量测试通过。

## 2026-09-24（凌晨续）复测第二轮 + Python 技能误报修复

- **能力 bug**：内核重启/恢复后再初始化，把「技能已加载」误判成「名字被占用」，告诉 AI agent_message/agent_observe/联网搜索等「不可用」，AI 于是不用它们（9/23 起）。现在沿用已加载的技能，不再误报；真实内核两次初始化测试钉住。
- 复测剩余：中断只显示一次「已中断」且不再误报行数；过程摘要不截断命令；运行中不再重复步骤；「查看输出」不再泛滥；设置/登录/模型选择/斜杠命令/列表滚动提示中文化；启动页改「上次」；会话列表首列「状态」。

## 2026-09-24（深夜）系统挑刺后的 14 处修复

- 找茬 QA（所有快捷键连按、运行中操作、长会话回放、60–160 列）找出 14 处：T/P 后箭头不变、「看全文」无反应、运行中 Ctrl+C 一次就提示退出（连按两下会误退）、? 面板关不掉、中断显示 KeyboardInterrupt 堆栈、步骤标题截在参数中间、右侧耗时被挤掉、大量英文残留等，全部修掉；界面除 Thinking 外统一中文。
- 测试会往真实 ~/.prime/agent 写假会话（会话列表里的「(no messages) · $100.00」）：vitest 默认隔离到临时目录；已写入的 263 个假会话移到 ~/.prime/agent/trash-test-sessions-20260924/（未删除）。

## 2026-09-24（晚）界面对齐设计稿收尾 + 后台重同步风暴修复

- **后台性能 bug**：工具输出稍大（>16KB）时 daemon 把正常的写缓冲误判为客户端卡死，丢事件并整段重发会话、界面整段重画，会话越长越慢、越滚越频繁。现在只有积压超过 8MB 才算卡住；无协议变更。
- **展开不再自己收回**：重画时保留每轮的展开状态；重新接上运行中的会话仍显示「进行中」；运行中计时在步骤之间也走。
- **界面按设计稿补齐**：运行中状态移到底栏「◈ 运行中 12s」；输入框运行中提示「随时补充或纠正，Enter 立即告诉 AI」；过程行归纳成「运行 N 条命令 · 读取 N 个文件」并带「Thinking 6.1s」；展开后首行两行思考摘要；启动页「继续」上次会话；子代理面板逐个列出状态；UI 中「思考」统一改为 Thinking（老板不喜欢这两个中文字）。

## 2026-09-24（续）AI 少犯错 + 界面按设计稿补齐

- **说明书改对**：发给 AI 的 Python 用法说明里 6 处写错/写漏（命令结果字段、harness 调用不该 await、子代理字段名、技能调用写法）全部改对，并加测试逐字段对照真实代码，以后说明书和代码不会再悄悄对不上。
- **工具顺着 AI 的手癖**：`r.duration_ms`、`r.output()`、`h.exit_code`、`await` 同步 harness 调用、子代理记录 `.get()`/`.name` 都能用；内核启动预先导入 json/os/re/shlex/sys/Path（说明书教 AI 用 shlex，之前没导入就 NameError）。
- **独立后台 A/B 考试**（8 题×2 遍，新旧各自独立 daemon）：新版 16/16 做对、用错工具 0 次；旧版 15/16、4 次；新版工具调用少约 18%、token 少约 12%。AI 能力无下降。
- **界面补齐设计稿**：输入框上下细线、快捷键嵌在上沿；用户消息紫色 `›` 标记＋深底块；运行中「▾ 进行中 · 第 N 步」；展开后每步缩进在过程行下、白话标题（搜索/读取/列目录/编辑/运行）、耗时右对齐、每步最多 6 行输出且不折行，代码只在「看全文」里出现。

## 2026-09-24 TUI v5 界面重做（第一批：显示层，不改 AI 看到的任何内容）

- **过程行说人话**：每轮一行 ` ▸ 思考 · 3 步 · 14.8s   运行 npm check · 读取 footer.ts`，步骤从 python/bash 代码里识别成「读取/写入/运行/列目录」；本轮改过的文件以 `改动 路径 +3 −5` 行常驻显示；去掉「干了/想了想/[O][T][P]」。展开后每步标题同样改成白话，`↑ N ↓ M lines` 换成「N 行输出」。
- **中英混排换行修复**（packages/tui）：英文单词、路径、文件名整体换行不再被拦腰切断，中文逗号句号不落行首，组合字符不拆。
- **底部重排**：快捷键提示挪到输入框上方且只显示当前能用的键；底栏一行显示模型、目录·分支、右侧上下文，进度条只在接近压缩阈值时出现，越线显示「即将压缩」；去掉对话尾部的全局提示行和「← agents/resume」行。
- **启动页**：去掉 12 行大 logo，改为名字＋模型＋目录三行；开始提示、加载状态词、tmux 警告改中文。
- 用户能感觉到的：一眼看出 AI 这轮干了什么、改了哪些文件；屏幕更安静、层级更清楚。AI 能力零影响（纯渲染层）。设计稿与实拍对比：https://claude.ai/artifact/8NtnLEQyYZEHKYkbBVMTcd

## 2026-09-23(晚)` 日期节置于文件最上(现有最上节为「2026-09-23(凌晨)0.11.2 恢复三件套发版」);
> 若主链 T13 席选择并入凌晨节,去掉节头直接取两条 bullet。内容按任务书 R1-R5 拍板后的功能面写,
> 主链批2 收口(T6 折叠限高/T8 Esc 逐层收/T9 实测)后如有出入,以主席终稿为准。

## 2026-09-23(晚)TUI v4「安静的对话」

- **终端对话流改造(quiet 模式,默认开启)**:屏幕上只剩用户的问题和 AI 的结论全文,每轮 turn 头收成一行尾注(「干了 1 分 05 秒 · 14 步 [O] · 想 7 段 [T] · → 通讯 2 条 [P]」,键位高亮可点),中间旁白/思考/工具过程全部折叠进三块详情;Ctrl+O/T/P 三个键各自独立展开过程/思考/通讯(可同时开、互不关对方),长步数列表自动折叠保留关键步与失败步,Esc 从最后打开的开始逐层收。纯文本轮显示「想了想」;窄终端(<100 列)尾注自动换压缩写法。用户能感觉到的是:刷屏没了、结论一眼可见,过程信息想要时按一键或点尾注段直达。不想用的用户设 `ui.processMode: "legacy"` 一键回到老的摊开样子(设置面板有行)。
- **尾注组件为鼠标与重绑做准备**:键位提示字母从实际键位表取(Ctrl+O/T/P 重绑后尾注跟着变),尾注统计段可注册鼠标点击区(接线后点段直达对应块),全角中文按显示列宽截断不按字符数。

素材锚点:任务书 docs/fork/tui-v4-quiet-conversation-redesign-20260923.md(R1-R5 裁决);
提交链 30b9c0f9d(组件席 T2b)→ 1dcd121e0(T1 设置)→ d070056e0(T2a 旁白收块)→ 1c5217937(T2c turn 头一行化)
→ c9e1e30da(p1-fixes)→ 2b08e797c(R5-P2c3 全零轮想了想)→ d76dbd3cf(T5 三键独立)
→ 06dfdd4b9(T6 part1)→ b4ce86c07(T12 组件侧点击)→ b7962766e(本 fragment)。
(原型定稿:桌面 prime-agent终端UI-定稿v4_20260923.html;任务书含 R1-R5 拍板:docs/fork/tui-v4-quiet-conversation-redesign-20260923.md)

## 2026-09-23（凌晨）0.11.2 恢复三件套发版

- 自动恢复三件套（空响应升级/工具超时/daemon 处置/主会话策略/TUI 动作条）经设计三卷→施工两批→六家提示审＋三卷盲审→联合修单→四车道修复，全部红→绿钉死后发版；CI 一次红（新 CUSTOM_TYPE 漏登记输入分类，被仓内守卫钉抓到）即修即绿。
- 派工三教训入档：席位须在自有 worktree 提交（两席违规被抓）、同型供应商故障二死即换模型、审查发现一律分区并行派修不亲修。
- 新增内置 `bailian-web-search` 技能：联网搜索默认 `max` 等级、固定打公网兼容端（实测专属实例端会静默忽略 `enable_search`），key 从 `DASHSCOPE_API_KEY` 或 `~/.prime/agent/models.json` 自取，仓库零密钥；用户更新后配好自己的百炼 key 即可直接用（`bailian_search.search("问题")`），延迟 15~90 秒、引用需一手来源复核的口径写进了 SKILL.md。

## 2026-09-22（晚）0.11.1 发版与远程发布页启用

- 根 CHANGELOG.md 补 0.11.1 节（U6 重做／看图三件／提示词两笔／一键安装／日终补丁批），并把 GitHub Releases 页作为用户可读更新说明的主入口（v0.11.1 起每个 release 附升级须知）。
- 发版自伤记录：`npm version -ws` 的连带安装把依赖树从锁钉的 mistralai 2.2.1 漂到 2.7.1 并剪掉手工补的 @opentelemetry/api（bundle 炸）——`npm ci` 按锁还原即愈；版本同步补跑 `scripts/sync-versions.js`（8 包锁步＋examples 范围对账）。

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
---|---|
| 2026-09-18 深夜 | **perfC 压缩计价算法批三笔**（cherry-pick 自 perf-shrink 席 `/tmp/fixShrink`，base `edcc31ff7`；实测读数全部来自该席配对 bench）：①`e8b63f602` planEmergencyShrink 切点搜索 O(n²)→O(n)——原实现每个候选切点都重走一遍 span 的 content-density 计价，恰在上下文最大时同步冻结事件循环（压缩看门狗是 setTimeout，期间打不出）；改一趟扫描维护 suffixTokens/carriedTokens 两个滚动和、候选 O(1)，整数计价 ⇒ 折叠和与原走法等值非近似。实测：真 5MB 转录（2025 条）p50 **18396.67ms→1.93ms**、计划产物逐字节一致，合成 1k/10k/100k 条拟合指数 1.005（修前 3.96）；修前规划器逐字存进 `test/fixtures/emergency-shrink-reference.ts` 作对照，针跑随机分支×阈值×目标比的全计划比对，且把对照本身喂同一线性裁判判红 ⇒ 裁判不是摆设。②`d8964d3de` estimateTokensByContent 计价挂消息对象 WeakMap（无 provider usage 时每轮边界全转录逐字计价：50MB 分支单次 p50 468ms、turn 边界 p50 1342ms，全同步）；失效判据＝从计价器自己读的形状派生的足迹（块数/字符数/图数/工具参数一层哈希/八采样码元），命中只花一次块表扫描；消息对象本仓可变故校验而非信身份。实测 2万×400字符 warm/cold 0.180、五读边界 0.168（无 memo 基线 0.997/1.027＝仪器噪底，收益归 memo 不归仪器）；计数器在 oracle 前读。③`cae6d9ba6` extractFactsFromText 行分割两次→一次、full-SHA matchAll→线性扫描，输出字节一致由针对照保证（对照抽取器逐字拷自 base）；实测收益 3.0%/1.7% 小于审计预期（行分割只占该函数 1.5%），负控 0.9973/0.9917 照实登记。GLM 5.3 子席施工、perf-shrink 席复核复测；针 `9ed8dd978` |
| 2026-09-18 深夜² | **perfB daemon/TUI 性能批十笔**：①`3f7e0f228` 顶栏花费格与全屏头**共享一次盘扫描**——原一次回合结束触发三次同步树扫（544 子家族实测每拍 106.9ms 事件循环阻塞、载下 333ms，树扫同步 ⇒ 整个 daemon 循环等它），且全屏头不理 `ui.subagentSpendCell: false` 还零节流；改 `fetchSharedContextTree(notBefore)` 时间戳记忆（无定时器无句柄），窗口取格子自身节奏下限、重扫后放宽；急停开关同管两面（关掉后全屏头退化为本会话内存聚合，文档写明两条不能），`publishTopBarTotal` 四条过期丢弃＋零钳制改全路径生效。`d8c146199`+`5b861e31e` 补 uiServices 缺失面早退（prototype 装配的 resync 夹具每次重连 TypeError，4509 套件 1 红）。②`1f8ab25d3`/`38a041995`/`d7148cd67` 子树盘扫缓存三层修：驻留无界（600 子家族 560 次忙扫挂 **79MB**）→ 双层 BoundedCache（键上限＋估算字节上限＋LRU，640B/节点为实测口径）；连续两探针未中的目录 60s 无指纹旁路（忙家族带缓存反而 +52%/+116% 比没缓存还慢）；双 .jsonl 目录两个选择器各选各的（edges 刷新压过转录 ⇒ 孩子从 /context 与顶栏消失，实测语料 2374 目录中 60 个）→ 按 mtime 降序＋首行会话头判内容，指纹改记全目录 .jsonl 身份、不再选边。③`2d63e443d` 留存清扫切片让出事件循环（daemon 最重 tick ~82ms 同步 >95% 占拍）；`bc076d32e` append 尾检与写同描述符（每条记录 12→9 syscall，拒绝路径不变）；`19ad7fee1` 空闲 worker journal 压实按记录数间隔化（原每条 ~3.8ms rewrite+fsync+rename）；`bd3e84281` 工具块五种不变不重建；`c030f2147` 展开工具块渲染有界（ctrl+o 60 块×36KB 实测 p50 **12.8–15.7s→0.89–1.04s**，超预算尾部给「…还有 380 行（Option+O 看全文）」）；`92f0abce6` alt+o 入扩展冲突保留键。针 `c8bc46975`/`54c0e9979`/`67badd556`/`9b230a720`/`bab628c68`/`9fdeaedaf`/`81e2d89c6`/`b043dd406`，口径文档 `3470dabb6`/`14ffa59de`，扫描计数仪器 `f0b22f2e3` 落地＋`29a94b941` 重锚（`docs/fork/evidence/spend-cell-scan-count.*`） |
| 2026-09-18 深夜³ | **可靠性小修五笔**：`6709a66cf`/`baea72fd5` 看门狗掐断 hung 压缩／分支摘要后调用方才进 funnel，信号已 aborted 仍发**付费** provider 调用 ⇒ funnel 前置抛 AbortError，手动/自动压缩统一按取消结算（针 `e4aa9ce43`/`38df751ae`）；`247dcf727` 孤儿退出对 in-flight shutdown 加守卫（重入分支＝立即 process.exit ⇒ 截断优雅关闭并跳过唯一无退出钩子的 flushOrphanProcessJournal）＋拒绝不再静默（60s 节流日志点名活会话/跑动子/窗口龄）＋截断扫描记遗留数（针 `d17185972`）；`f78033997` owner 断连清理若停下忙会话记忙数归属（行为不变只补可归因，针 `ae8d47af1`）；`74c45b53d` daemon-pid 注册表读失败改 warn、不再静默回落 |
| 2026-09-18 深夜⁴ | **harness digest 排序跨语言 parity 仪器＋locale 独立修复**：`f653ea83a`/`3e86a83ba` 仪器与跨语言夹具，`ce4b7820d`（TS digest 窗钉 harness.search 排序）＋`f2aca097a`（runtime 钉 golden），证据 `fa82ee8a2`，`6e774aacc` 据实登记该仪器暂无闸覆盖；`44bb45d31` 发现 `localeCompare` 无 locale 随进程 ICU 走（"修复顺序".localeCompare("登录超时") 在 en_US 与 zh_CN 下相反 ⇒ golden 跨 locale 不可复现，zh_CN 下 13 漂红）→ golden 改记正分前缀＋零分集合（集合无 locale），三种 locale 下仪器 92 检 0 失×3；`d2a58bc35` 把 refinement.ts 五处 localeCompare tie-break 改码元三态比较——其中三处承重：注入序、ranked 窗 tie-break（窗序随 LANG 漂会打废 #2098 前缀缓存）、指纹物排序（两代理不同 LANG 互判对方 digest stale 互重投）；E 席仪器改造前后 93 检 0 失 ⇒ golden 无需重铸，323/323 绿、三变异各转红后逐字节还原；针 `9094b9b53`，文档 `fb0911ebf`/`5b6461c1f`/`4cb4eacdb`/`618f07821`/`4feacb5ce`（剩余 localeCompare 点实测计数与裁决） |
| 2026-09-19 凌晨 | **CI 闸诚实性批＋0.10.0 发布面冻结（本批 63 笔的 FORK_NOTES 记录为 09-19 02:00 后补，距前次记录 a367d1e7f）**：`b040da84d` fork 发布面闸——`npm run release:*` 在 fork checkout 拒绝 git tag/npm publish/push v* tag（脚本第一句即 exit 2），`.husky/pre-push` 拒含 `refs/tags/v*` 的推送，逃生门 `PRIME_AGENT_ALLOW_RELEASE=1`/`PRIME_AGENT_ALLOW_VTAG=1` 显式才放行（此前禁令只在散文里，而 `push: tags:['v*']` 的 build-binaries 工作流是活的）；`f54ca5d74` fragment 规则按读取点收窄。`5a2281267`/`9afed3ba6` specialty 面合成一步前置到组件套件前（套件现存红 ⇒ 原顺序三面不可达），内核解释器须过 CI 种子探针（import rlm.repl/dill/goal/agent_message；`uv run` 留的 .venv 实测过不了）否则 NOT RUN 绝不静默绿；`edb63c998` bundle-smoke 缺 esbuild 报值不崩闸；`0cc4fc5e7` ci-floor 溯源针读 checkout 深度。`17cf394db` **真红修复**：hygiene job 还在跑已删的 `scripts/lib/ci-process-smoke.mjs` ⇒ 每个 CI 跑都 ERR_MODULE_NOT_FOUND（35359758914/35360701254），改跑镜像自己的自测；`9f06b4eff` 把「聚合可达」型针改成按名读 hygiene job 自己的步骤＋run 块点名的脚本必须存在于 checkout。`6e7c34fe0`/`978f56d73` **0.10.0 冻结**：CHANGELOG 六句站不住的话逐条锚定或删除（「CI 14 job 全绿」写明批头曾红并留 RUN_ID_PENDING → `978f56d73` 填入 35366778047；「28 变异」订正为仪器口径 12；「p50 2.36x/3.27x」「真转录中位 0.9975」无源 ⇒ 删；五个车道内 sha 改挂主干落点 `1f8ab25d3`）；**代码面冻结在 `9f06b4eff`**（CI run 35366778047 十四 job 全绿），此后只许 docs/evidence 骑上 |
| 2026-09-18 上午⁴ | **#2241 query 排序二期落地（含一枚自抓真红）**：TS 侧 `0d353ae93`（#2392 IDF 加权 + #2400 稳定 tie-break + ranked marker）、Python `harness.search` IDF 折扣 `7baa7e5ab`、G5 接线 `4adab8a77`（`_buildHarnessDigestQueryTerms`：goal×3 + 近 4 条衰减、48 词封顶 → `_renderHarnessDigest`）、G6 状态指纹 `81f964022` + 不变量钉 `3c862d9fb`。**真红与真因**：G5 单落时 `agent-session-recursion.test.ts:2841` 确定性红（navigate 后 leaf 不等）；母席的"空状态灌空菜单"假设被施工席埋点**证伪**——真因是 digest **新鲜度判据用渲染文本比对**：同一 harness state（全局库 1243 条）首轮载体 6773B、navigate 冷边界重渲 7058B（query terms 不同⇒排序窗不同）⇒ 误判 stale ⇒ 多投一条载体 ⇒ leaf 动。修法＝改 **sha256 状态指纹**（覆盖渲染实际读的字段：条目打印字段/refinements 存储序/渲染 flags/shell flag 归一，**刻意排除 query terms**，故措辞漂移只影响下次投递的排序、不触发投递）；#2098 三机制职责不变（时间戳＝最新载体选择器、stamps＝lstat 预过滤、per-entry 版本图＝回执跳过）。干线保护：母席先 **forward revert**（`aea98d0ce`）保住可推，修好后按新笔复原（`4adab8a77`），**未 amend 未改历史**。闸：recursion 124/124（原红例复绿、断言未动）、refinement 全家+2098 digest+process smoke 合跑 248 例 0 fail、compaction 四件 85/85、`uv run python -m unittest test.test_harness` OK（**runtime 测试唯一口径＝unittest 发现，别给 runtime 装 pytest**）、tsgo/biome 0 |
| 2026-09-18 上午⁵ | **#2334 human 优先 × fork queue pins 调和落地（v2 十四笔，末端 `96af873b2`）**：上游 `dca77ecfe` 全量移植，排序＝**lane(QP-4 第一轴) > priority(只在 lane 内) > 到达序**；`selectFirst()`/`canSelectSessionAction()`/压缩闸判据/`input-classification.ts`/`moveQueued`/协议 rev38 **一字未动**。判据不抄上游启发式，从 fork 单一分类点派生（`sessionActionPriorityForInputClass`＝`inputClassOrigin(cls)==="human"?"user":"background"` + `isAgentSessionMessageId` 结构守卫），**副作用红利**＝#2098 新加的 harness_digest 分类行自动落 background（抄上游启发式就得加特例）。**双席异构对撞**：施工席（0902）出卷 → 复核席（DS）判 FAIL（F1 漏迁上游 hunk 致 daemon-mode 3 例真红／F2-F3 变异实测为假钉／F4 goal pinned 生产唯一使用点无钉），v2 逐条修完后复核席判 **PASS 可应用**（77 文件 runset base 1075 例 / after 1094 例 **0 fail**、daemon-mode **198/198**、tsgo/biome/hygiene 0、弱化扫描 0 命中、cherry-pick 到 `b2e1dc54c` 双干净）。**三条不互撕全部变异可红**：M6=2红/M6b=1红（手排跨 rank）、M7=1红（goal pinned 经生产路径）、F1b=3红+1红（daemon 机器流量 background）、M1=11红（含老板现场例）、C7=1红（human 不被压缩闸挡）。**F2 裁为设计债不裁为已钉**：复核席 4 例可达性探针实证闸的 human/system_fence 半支**在当前调用图不可达**（唯一调用点 `acceptAgentMessagePrompt`；human 类 customType 的 envelope 被 `isAgentSessionMessage()` 丢弃；兜底 envelope 对五种 source 全落 origin=agent；`incomingInputFactsFromMessage()` 无 isSystemFence 入口）⇒ M4=0红 与施工席 C5=0红 同源；处置＝16 行据实注释 + 保留 C6/C7 守可观测半支，**不写成已钉**。**闸口径教训**：v1 自报"75 文件 843 例 0 fail"不含 daemon-mode（被自己 src 改动打红的文件）⇒ 邻接集必须「关键词邻接集 ∪ 补丁波及测试」。**残余设计债（另立一席在修）**：①hung 压缩时 human 排队**无 stall 上界**（watchdog 只在 agent 回执命中闸时武装）＝唯一还会咬人的现场风险；②若把闸裁决挪进 `_admitSessionInput` 使 human 半支可达，须同笔补钉 |
| 2026-09-18 中午 | **两条残余设计债闭环（五笔 `ede1f8da8`/`08dd5c00f`/`02b0a6bdb`/`098bd2584`/`d7e390def`）**：①**hung 压缩时排队输入无 stall 上界**＝当天唯一还会咬人的现场风险（压缩 hung 时老板打字可能无限期不落地且 CI 全绿）。base 已复现：压缩在**队列空**时由 fill turn 的 `agent_end` 阈值启动 ⇒ `hasPendingSessionWork` 那处武装无可武装，之后 human prompt 进来 `isCompacting` 20s 不变、prompt 永不落地、其余 pin 全绿；同窗口两条正控证明不是夹具测不到 abort（agent 回执腿绿、`_startThresholdCompactionForIncomingInput` 腿绿）。**洞比原口径更宽**：同窗口 heartbeat（scheduled/background 优先级）在 base 上一样永挂 ⇒ 修法**不按 priority 过滤**，一行落在唯一入口 `_admitSessionInput`：`if (this.isCompacting) this._armCompactionGateWatchdog();`，不变式＝「只要有输入在压缩后面等，这个压缩就有上界」，与既有武装点对称；效果红线自查＝不排序/不延迟/不吞输入（human 反而更早落地），预算仍 `stallWatchdog.abortAfterSeconds`（出厂 0 回退 `COMPACTION_GATE_ABORT_AFTER_SECONDS` 600s），无 `_compactionOperation` 时 no-op（branch summary 计入 isCompacting 也不会被误切），QP-4 与 #2334 的 lane>priority>到达序未动。新钉两行（matrix 20→**22**，基线 20 例断言一字未改）；**变异实测**：M1 撤修⇒2 红（human+machine 两行）、M2 收窄成 `priority==="user"`⇒1 红（只红 machine 行＝不按 priority 过滤的机械依据）、M3 掏空 `abortCompaction()`⇒3 红（含既有 watchdog 行 ⇒ 钉量的是「压缩真被切」而非「定时器真被挂」）；**母席独立复跑 M1 亦 2 红、复位后 `git diff` 空**；new-red 另有直接证明（`git checkout 96af873b2 -- src/core/agent-session.ts` + 交付态测试面 ⇒ 2 failed，红的正是两行新钉各 20.4s 超时）。②**压缩闸 human/system_fence 半支仍不可达**⇒走「注释保留 + 说明为何仍不可达」：四环自复现，其中 ring4 **订正了原措辞**——`incomingInputFactsFromMessage()` 其实**有** `context.isSystemFence` 入口（显式给 true 能分类出 `system_fence`＝正控腿），但闸那处调用的 context 字面量只给 `{source, agentMessageId, streamingBehavior}` ⇒ 五种 source 下 `facts.isSystemFence` 全 undefined；M0 实测（删 stand-down 行）matrix(22)+2334(7)=**29 passed/0 failed** ⇒ 仍不可观测（注释计数 27→29 并写明拆分口径）；本次只加一次武装调用、未搬裁决、调用点集合仍为 1，注释明写「这不是所警告的那次搬迁」。另顺手改正 matrix 里一句**存量过期错误**注释（「retry 无上界」——base 实测 53ms 内连开两次 abort，13682 的武装早已覆盖 retry；只改注释未改断言）。闸：77 文件 runset **1096 例=1086 pass+0 fail+10 skip**（skip 全是真 provider 面 `skipIf(!API_KEY)`/`!ANTHROPIC_OAUTH_TOKEN`，base 同 skip、五笔未碰该两文件）、daemon-mode **198/198**、compaction 家族全绿、`check:process-smoke` GATE GREEN、tsgo/biome/test-hygiene 全 0（938 文件 497 探针无新增）、`interactive-mode-queue-compaction-line` 4 绿断言一字未改。新钉 stall 预算 0.05s→**0.2s**（新常量 `ADMISSION_WATCHDOG_SECONDS`）：一份预算同时管 hung 压缩与 abort 后 retry，retry 实测 ~31ms ⇒ 0.05s 只剩 ~19ms 余量、负载高会连 retry 一起切而被误读成「上界开了两次」；0.2s 余量 ~6×、鉴别力不变（撤修后根本没上界，任何预算都永挂），连跑 3 次 22/22 绿；既有 watchdog 例仍 0.05s **未碰**（其余量是存量问题，只登记不擅改） |
| 2026-09-18 上午 | **上游 e2fb7bfa1 窗（136 笔）吸收落地**：selective per-file 裁决图 861 行，merge commit `67334bf1a`（tree 83597764b，parents e744cfbf4 + e2fb7bfa1）＋应用波 12 笔＋perf 2 笔＋tui 接线 4 笔；六闸终读（9ff1e92c8）＝①行首冲突标记 0 ②主树/纯净树 tsgo 0 ③biome 0（1490 文件）④全量分量 7807 例 NEW-RED=0（治愈 1）⑤runtime 442 例/1 红＝基线同名 ⑥tui 847/847；合并文档 `docs/fork/merge-upstream-20260917.md` **v1.1**（460 行，§9 已落地清单逐笔 sha＋§9.1a 收尾波 15 行、§9.2 待办与两条登记、§10 验收七条对照）已推 |
| 2026-09-18 上午² | **#2098 harness digest 迁移四笔**（`49b326b51` 词汇面＋刀三 16 钉迁 `conversationMessages()` 助手 / `abae4f9bb` 刀二冷边界投递＋刀一系统提示移除＋F1-F4/F8 / `bdd1ad5b7` 正控 13 例 / `78af6fc4d` 版本感知豁免＋2 钉＝15 例 / `2eb768217` park re-arm 钉＝**16 例**（现行口径；血缘 13→15→16）；cancel 半 re-arm 无可达公开入口，`d51118e32` 据实标注为纵深防御不作已解）：digest 出系统提示（62,181→50,816 B、前缀不再每轮作废），改**冷边界投递**（构造尾/主压缩头/emergency shrink/树导航）＋**material-change 再注入为主路径**（`readHarnessStateStamp` 廉价扳机：stamp 未动那轮 harness_state.json 读取次数=0；判据＝条目 `kind:scope:id→version` 指纹差集并排掉本会话回执已报的**同一版本**；复用 `HARNESS_DIGEST_CUSTOM_TYPE`；cancel/park 剥到即 invalidate+re-arm；只尾追不改写在前载体）。三效果正控＝新记忆**下一轮可见**／MV-5 被拒条目带非空原因可见／背靠背缓存 round2 cacheRead=3959＝round1 冷输入的 95%（round3 故意破前缀掉到 866＝仪器能红；口径申报：faux 是字符前缀模拟器，证的是「序列化请求前缀未变」这一真 provider 赖以命中的机制，不是真 provider 命中率）。**自抓真回归并修**：digest 占 index 0 把首回合 user 挤到 1 ⇒ 翻转 `alignCutToTurnStart` 的 guard ⇒「超大首回合」压缩被整段跳过（生产上上下文继续涨），修法＝`boundaryStart` 跳过前导 digest 4 行、原钉零改动（上游无此 guard，只有我们会踩）。F8＝branch summary 不再携 digest（同文件自写 never summarizer input，两面对照钉）。异构复核（K3）结论 PASS：六闸零红、双基线 new-red=0、弱化扫描零命中、三正控读数可复现且判据经**变异实测**可红 |
| 2026-09-18 上午³ | **CI 绿五笔**（真因都不是运气）：`49e94f491` platform-coverage registry 登记 repl-kernel-startup 的平台条件（撤行即红正控）／`144bfa2e2` DAT-4 torn-write 注入改落 `writeSync`——原注入点自 `69fb8ead6` 起就死了（写者不再调 `writeFileSync`，mock 打在空气上＝**仪器腐烂却读成绿**），加正控＋变异对照／`91da42b93` supervisor monitor 回合改 **settle 闩锁**驱动——原「40 步预算」是**伪装的挂钟预算**（40 步只值 0.7-1.8ms 挂钟、回合实需 15-199 步，空闲绿跑余量仅 1.5-2.7×），4 正控／`e17535e07` startup gate 等**内容**不等存在（真因＝writeFileSync 的 open 一落地名字即可见且 size=0，测试放行后立刻 SIGKILL 子进程 ⇒ marker 永久 0 字节；本机 121 轮自然跑 0 红 ⇒ 正控改由确定性注入承担并显式登记自然红未复现，不用绿跑冒充已复现）／`de1ad0b06` afterEach 等 **daemon pid 退出**再拆目录（真因＝socket 消失≠进程退出，daemon 在 rmSync 期间重建 `<root>/agent` 子项 ⇒ ENOTEMPTY，而 Node 的 maxRetries 只重试 rmdir、从不重新下钻；照搬 4685 兄弟文件的既有成例，不发明新机制）。另 `b8375478c` 把 `REFINEMENT_NOTICE_CUSTOM_TYPE` 加进 headless 终值跳过表作纵深防御（本 fork 零生产者，但上游形态写的旧 journal 不该被当终值输出）；notice 词汇面保留作上游同步预留、durable 投递机制本窗不取（文档已对账） |
| 2026-09-18 | **上游合并 P5·版本面 lockstep + update-source 双保险**：全 workspace 抬到 **0.9.5**（`npm version 0.9.5 -ws --no-git-tag-version` → root 两处手工 → `sync-versions.js` 对齐 4 条 inter-package range → `npm install --package-lock-only` 重生成 lock；验收门 `OK 0.9.5 x5 + lock x5 + ranges x3 + root range x1`，unique 面 **17 件**；4 个 examples 包按 `-ws` 一起抬号＝偏离登记）。**update-source**：启动提示面加 fork 门（fork checkout 且发布源仍是上游默认时 `checkForNewPiVersion` 直接返回 undefined，不再让用户看到一条必然被拒的 “Run /update”）；README 明示本线更新方式是重建 checkout（`git pull --rebase && npm run build`）且提示报的是上游版本 |
| 2026-09-17 深夜⁵ | **daemon 面两笔**：a594e71db #2246 孤儿 worker 有界回收（重接进 deps 注入的 supervisor-availability 轮，门控用我们 isSessionActive‖hasRunningRlmChildren 折叠含活内核 bash；monitor harness 隐性 throw 一并修；退出有界非即时≤60s 一轮，换机风暴防护优先）；5421bd2a7 #2242 持久 SupervisorLink（新文件直取+三处重接+shutdown close，保留 1s 握手预算/不重试契约，复用测试 3 连接→1）。C5 串行交接闭环：p2-races 撤回存 patch→p2-daemon 落库→p2-races 重放 | 
| 2026-09-17 深夜⁴ | **压缩安全束八笔落地**（b407d0feb 触发比例制+密度校正、fb0d6496a 八类分类器、c9762ece6 压缩优先准入闸+降级阀、5067ed78a/48b5277b1/05dd41815 复现与阀 pin、2880924c5 queue 抬头、236faf357 文档）：kimi-k3 阈值 1,032,192→**800,000**、qwen3.8-max→786,892（min(窗,实收上限)×0.8，[0.5,0.95] 可配）；触发与 /usage 改中文密度口径（pin：1350 字中文扁平 338 不触发/密度 900 触发）；**压缩优先于子代理回执**（含空闲态不对称 bug 的修法：回执入口 skipPrePromptWork 导致 pre-turn 压缩被跳）；降级阀第 2 次失败起 keepRecent 减半、第 4 次有损紧急收缩+三处 loud notice；**裁示偏差一处（母席接受）**：human_interactive 未入队列——它自有 pre-turn 压缩已实现"压缩先跑"（pin0 钉 compaction_end 早于 message_start），字面排队会动 Esc/prompt-stash 语义。**#2276 append 半** 69fb8ead6（短写循环+flip-once guard，bench p50 走平）与 **#2310 限定范围** fb15fa08d（error verdict 落盘+wire 降档保老客户端）同窗落地。待办记账：~~keepRecent/切点仍 chars/4（CJK 保留片真实 token 约 1.6× 名义值，单开一笔重标 23 套件）~~、~~content-density 头注释口径统一~~（两条已由「切点/keepRecent 密度重标 + 单一口径表」一笔落地：切点与 keepRecent 改 estimateTokensByContent、附录切片份额同口径、content-density 头注释改为带出处的口径表；**实测无夹具需要重标**——家族 35 套件 651 例与全量 721 套件 7812 例在补丁前后逐例同红同绿，「23 套件」的估算不成立，详见该笔报告）、attached-daemon archived 行待 wire 枚举放开收口、append-hot-path 的 test-hygiene 探针待 p2-sessmgr 收口 | 
| 2026-09-17 深夜³ | **吸收审查回炉两笔**：db3c6cc32 回补 `streamProxy` 的 maxRetryDelayMs 转发（公开 SDK 面静默丢字段，非 daemon 内部链路——全仓无内部调用者，注释按实测写；新 pin 走公开入口+stub fetch，agent 包 108 绿）、5184b9e66 补 #2215「空 extension summary=普通分支移动」针（变异正控红/净树 51 绿）。**溯源补记**（审查 A ①）：0f02b089f(#2336-C7)、c09bdd358 与 06260455d(#2153) 三笔提交说明未注明上游出处，上游对应 cf07c5a3f / 4f4d51c5b，行为等价性已由审查 A 逐行确认 | 
| 2026-09-17 深夜² | **效果增益第三批**：93a53ef69 `harness.search` 排序查询 API（内核 Python 面，CJK 双字组/标点安全/limit/无命中五例钉死，f30fd9fa9 补 tokenizer 下限与 CJK 边界 pin）、c09bdd358 名册两入口合一（`agent_message.list_agents` 转调 family catalog，旧入口保留不报错，两入口同输出钉死）；验证 agent-observe 8/8、test_harness 60/60、钩子全绿 | 
| 2026-09-17 深夜 | **上游合并 P1 路径级摘取六簇落地**（e7b647d81 providers/oauth、6031c788d daemon/kernel utils、1bfb35d0b interactive/tui 组件、5d7ff1de4 干净面绿色测试、84c4a46af provider docs、2ee067a20 benchmarks/evals/PR-template 资产）：机制=路径级 take（`git checkout upstream/main -- <paths>`），实测零冲突零触碰我方改过文件，不拿族（mcp 目录/native 车道/onboarding/UI 简化族/#2336 删测）一笔未碰；**效果增益两笔**：7cb6e8b6c #2226（kernel 侧文件编辑进压缩摘要，`<modified-files>` 从恒空变有内容，200 封顶）与 05c60d6eb #2215（goal 记账跨摘要单调，预算门不再被分支重建重开），两笔均带模型可见面改前→改后对照正控 | 
| 2026-09-17 夜³ | **内核面 sweep 族入脏树守卫**：`prime-agent-runtime/src/rlm/bash.py` 把 `git add -A/--all/-A .`（根 pathspec）与裸 `git stash`（list/pop/apply/drop/clear/branch/show/-h 除外）纳入拒绝族，复用丢弃族 matcher 与 env bypass 口径；38 测试（含反向钉：定向 `git add -A docs/` 放行、stash 子命令放行）+ 回归 104/104 + 净树复验 38/38 + runtime 全量 432 仅基线既有的真网络 MCP error。至此内核面丢弃族+sweep 族均工具层机械化 | 
| 2026-09-17 夜² | **脏树保护补完（#2275 三面齐）**：Python 内核 `bash()` 面守卫（ac2f9eab4：丢弃族四正则+引号/注释遮蔽+全局选项块，命中才探针 `git status --porcelain`，脏树列路径拒绝，bypass 仅认内核 env；31 测试+回归 66/66+净树复验 31/31）、TS 面 sweep 族入拒绝族（15437361f：`git add -A/.`、`git stash` 裸形态；定向 `git add -A docs/` 不算）、bypass 归属收紧（d4fedc52b：daemon/SDK 面 schema 不暴露 `allowDestructiveGit` 参数、交互面保留）。**模型真正走的是内核 Python 面，此前面完全无防护**，本批把它与宿主面一起机械化；AGENTS.md 的禁 sweep/stash 从纯纪律变成工具层拒绝（内核面 sweep 族留作 follow-up，测试向量已备）。残余：内核面 cd 链/GIT_DIR 前缀等五形态 fail-open（测试钉死边界）、探针固定 10s 超时 fail-open | 
| 2026-09-17 夜 | **上游合并文档 v1.0**（`docs/fork/merge-upstream-20260917.md`，经 0902+DS 两席异构交叉复核逐条修订）＋**上游优点移植两批共 12 笔落地**：#2307 spawn handle（55c2530de）、#2219 非交互 shell（77587dcab）、#2285 stdin 守卫（d06cac12f）、#2220 精化走 auxiliaryModel（918044273）、#2218 全子树计数（d5f0dbad4）、auth.json 非对象拒绝（d65f2f5e2）、4603 断言去墙钟（0f02b089f）、#2243 斜杠纠错（dee08ba52）、#2228 Alt+M+12 处文档改真（84559b825）、#2308 选择器提示（1c49c3ba3）、#2275 bash 脏树保护 TS 面（b0aeef69a）；#2309 裁撤为休眠登记。文档要点：合并走**路径级 take**（整笔 cherry-pick 实测 16/136 不可用）、净面 243 路径、取号跳 38、digest 机器重算、#2098 量化（单次 refine 作废 76.1% 前缀）三刀方案、P0 冻结闸与冲突回执纪律；AGENTS.md 的 `--collect-only` 陈规同步更正为 `vitest list --json` | 
| 2026-09-17 深夜 | 上游合并**第一批·四笔小件日常移植**（非合并窗口，逐笔手移植＋先红后绿＋独立提交＋未 push）：①#2307 `rlm.delete_subagent` 接受 `RLMSpawnHandle`／子代理行／字符串三形态（`55c2530de`，collect 早已有、只补 delete）；②#2219 agent 起 shell 的十项非交互默认值（GIT_EDITOR/GIT_SEQUENCE_EDITOR/GIT_TERMINAL_PROMPTS/GIT_ASKPASS/SSH_ASKPASS_REQUIRE/EDITOR/VISUAL/PAGER/GIT_PAGER/DEBIAN_FRONTEND，双汇聚点＝TS `sanitizedChildEnv`＋内核 `_child_env`，不动既有 NO_COLOR/TERM 面；`77587dcab`）；③#2285 非交互 stdin 守卫（新 `utils/piped-stdin.ts` 逐字摘：PI_STDIN_TIMEOUT_MS 250ms 空闲窗/0 跳过/30s 封顶，main.ts 三调用点换 import，resume 跨项目/daemon attach/deprecation keypress 三处 TTY 门，daemon open 尊重 --json；`d06cac12f`）；④#2220 `auxiliaryModel` 设置让精化 review/plan 走辅助模型不踢会话前缀缓存（`918044273`；上游 catalog 11 行**不移植**——本仓 provider 层已有 anthropic cache_control 并有锁测试）。`.changes` fragment 4 件齐（均落 `packages/coding-agent/.changes/`，runtime 包无独立 fragment 目录、与上游同位）；每笔纯净树 `tsgo` EXIT 0、`npm run check` 0 错 0 警、runtime 全量 392 例仅存既有 test_mcp 真网络 1 error |
| 2026-09-17 晚 | 新增《上游合并文档》草稿 v0.3（`docs/fork/merge-upstream-20260917.md`）：把上游自基线起 136 笔的取舍（拿 10 / 改着拿 4 / 不拿 5 / no-take 白名单）、/tmp 独立 clone 的试合并冲突地图（215 冲突文件 / 611 块、承重四件裁法、六组同题双解）、五阶段分簇执行方案与验证对账矩阵（八级阶梯 + 三张对账表 + 两个现成 preflight 闸）落成一份可执行文档。**尚未进入合并窗口**：等 UX/协议两席回执并入并过 0902+K3 交叉复核出 v1.0，再按 P0 冻结纪律开工 |
| 2026-09-17 深夜 | 修欠账台账（review-findings-r3/审计）**5 条小缺陷，全部先红后绿**：①**F28 死 export**——`packages/coding-agent/package.json` 的 `"./hooks"` 指向早已并入 extensions 系统（c6fc08453）而删除的 `src/core/hooks`，对外 import 必然解析失败；连同根 `tsconfig.json` 与 `tsconfig.examples.json` 的两条同源死 paths 一起删。**契约面诚实标注：这是 API 破坏**，但删的是本来就解析失败的 export，上游同款 manifest 也没有它。新守卫 `test/package-exports-resolve.test.ts` 遍历 exports 每个 target、断言 dist 或对应 src 可解析（红证＝点名 `./hooks` 两个 target；负控即死路径本身）。②**F25 计费可负**——`openai-responses-shared.ts` 与 `google-shared.ts`（google+vertex 共用 `googleUsageCounts`）两处 `input = prompt - cached` 无钳制，坏代理报 cached>input 时 input 为负、冲减账单并污染 overflow 判据；统一 `Math.max(0, …)`（openai-completions 原本就有钳制，未动）。③**F24 handoff 重复消息 id**——无签名 text 块（anthropic→openai 交接、中断 trace）合成 id 原 `msg_${msgIndex}` 只按消息计数，同消息多个无签名块共享同一 id、被 Responses API 按 id 去重**静默丢历史文本**；改 `msg_${msgIndex}_${blockIndex}`（确定性保持，codex cached-context 前缀匹配不伤）。④**A10 auth.json 权限**——ai 包 CLI 落凭证原为裸 `writeFileSync`（0644、跟随符号链接、非原子）；抽出 `src/utils/private-file.ts`＋`src/utils/auth-store.ts`（ai 包不能反向 import coding-agent，故按同一契约精简实现）：0600、拒 symlink、temp+fsync+rename 原子替换；读路径与登出远端 revoke 明确范围外未动。⑤**F71 semantic-edges 账本**——`mkdirSync` 无 mode＋`appendFileSync` 裸写（0755/0644/穿 symlink），与同目录树其它写者口径不一致；改走本包 `private-files.ts`（`ensurePrivateDirectory` 0700＋`appendPrivateFile` 0600 **保 O_APPEND 并发追加语义**＋残尾修复的 truncate 改 O_NOFOLLOW fd）。官方两套件复跑全绿（semantic-edges 57＋agent-session-semantic-edges 23）。验证：每条先红后绿（详见各测试文件头注）；`npm run check` 0 错 0 警；提交用 `git commit --only` 点名文件、未 push |
| 2026-09-17 晚 | **TUI 子代理行常显花费**：subagents 那行的空白区（counts 与 `↓ select` 之间）现在显示 `Σ 子代理 ¥4.56 · 12M tok · 总 ¥5.10`。口径＝`getContextTree` 全树（直接子代理＋后代，活的＋落盘的）除根以外各节点 own-usage 之和，与 `/context` 的 Total 同折叠、不与母转录 `child_usage_attributed` 重复计；未定价模型（models.json 无 `cost`，如 kimi-k3）用 warning 色 `(kimi-k3 8.1M tok 未定价)` 标注、绝不静默当 0 混进合计；扫描被预算截断时全部数字带 `≈` 下界标记。事件驱动刷新（rlm_child_update/回合结束/assistant 消息落地，防抖 500ms＋活跃期至多 5s 一扫＋回合结束强制），拿不到数据该格留白、不显示 ¥0.00 噪声；窄屏按「总 ¥→注记 token 数→注记→整格」固定顺序降级，`↓ select` 永不被挤出；金额固定两位小数＋hint 右锚定＋整行 pad 到固定宽，数字变大只吃空白、不抖动。追补（同日晚，代价实测）：普通家族（4 子/28KiB 转录）单次树扫描 ~0.5-3ms/0.02MiB，字节预算咬住的大家族（251/544 子、220/743MiB 落盘）~150-320ms/≤64MiB（预算封顶）——据此节流下限做成自适应（上次扫描 >100ms ⇒ 5s→15s，最坏 duty ~6%→~2%），并顺手修掉实测暴露的节流公式 bug（原 `min` 是「最晚帽」非「下限」，持续事件风暴会退化成 ~600ms 一扫；改 `max` 下限＋强制刷新带 flag 穿过在飞扫描）；静默家族零扫描＝事件驱动无周期定时器（timer unref），假钟测试钉死 |
| 2026-09-17 下午 | 修两条 **CI 独红 flaky 测试**（r42 审计 A3 + 2026-09-17 唯一红点；产品码零行为变更，只加了测试注入口）：①`ma-p0-1-long-cell-survives` 全族改**注 fake clock 驱动**（`AgentSession`/测试 harness 新增 `stallWatchdogTimers` 注入口，照 stall-watchdog-tool-liveness 的 StallFakeClock 模板），warn/abort/deferral 级联在 `clock.advance()` 里确定性触发，不再拿真实 50/100ms 阈值跟满载 runner 赛跑；负断言全部换成"abort 死线本身跑过且 deferred（`abort_deferred` 日志行为证）+ 20 个 deferral re-check 周期"的事件驱动形态，裸 sleep 窗清零；只留一条真钟冒烟（wedged kernel 照常死，正断言全保留）。两支变异正控证明断言仍咬人：开 kill switch（= 豁免前行为）必红、"vouch 中途眨眼"（= CI 红点形态：abort 混进负窗）必红。该文件基线 ~8s → ~0.5s。②`4685-daemon-client-modes` 的 ENOTEMPTY 根因实锤：daemon 先删 socket 文件、再 flush 日志/journal、最后才 `process.exit`（探针实测：socket 消失后进程仍活 ~10ms，满载 CI 更长），而测试把"socket 没了"当"进程死了"立刻 rmSync——写者（daemon 的日志/注册表就在被删的 temp root 里）与删除赛跑；且 daemon 的 argv 里根本没有 socket 路径，ps 按路径找不到它。修法：从隔离 supervisor 注册表（`readRecordedDaemonSocketOwners`）读出 daemon pid，afterEach **有界等待进程真退**（10s，超时抛错并带 pid + `ps` 命令行），rmSync 失败不再吞、带上残留树 mtime 清单响亮报错。用户可感面＝CI 红面收敛：最近 60 次 17 红里这两形态不再出现 |
| 2026-09-17 凌晨 | 修**空闲逐出连带杀掉 kernel 里活着的后台脚本**（审计 round-44 的「形态 A / 主根因候选」；上游同有此链，所以不能靠「按官方来」解决）：子代理用 kernel 的 `bash()` 起长任务后结束回合 ⇒ 会话层面无新消息 ⇒ 90 分钟后被判 idle → passivate → 关 kernel → **kernel 内所有 bash 进程组被 SIGTERM**，而会话之后还能水合、transcript 完好 ⇒ **无人报错**。实质修复是**事实口径**：HEAD 的 `isKernelBashRunning` 只读最新心跳帧且**无新鲜度门控**，而 runtime 只在有请求在飞时发帧 ⇒ 双向失真——脚本早退出但最后一帧仍 >0 会**永久钉住整个 worker nest 且自持**（只有 kernel 死亡能解除，而驻留正阻止它死亡），短 cell 里起的句柄从未进帧则**漏检**。改为 **orphan-process journal 主源**（spawn 时入册、退出时销账）+ 心跳仅在 `kernelVouchedAlive === "fresh"` 时作回退。journal 是 lower bound 且只朝一个方向陈旧（子进程被 SIGKILL／行撕裂／丢退出钩子 ⇒ 记录长期呈活），所以这一读法与看门狗那侧不同：**逐候选做 pid 存活探测**（每读上限 32，超限的尾部**按活计**——驻留是可逆的、逐出不是）+ 正计数按文件身份缓存并带 **5s 双向 TTL**（同秒内销一行登一行可保持 size/mtime 不变）+ 不可读／kernel 已关一律 **fail-open 为「无活句柄」**（回到今天行为，绝不抛）。两层策略共用一个判据（`canPassivateSession` 与 `canEvictWorker` 都读 `isIdleEvictionThresholdMet`），空 worker 回收与 supervisor 侧逐出经既有 summary 折叠抵达该事实——折叠因此加了锁测试与交叉引用注释（删掉它会静默重开形态 A）；passivation 快照另带一份同事实作为**纵深冗余**（注释明写它不是承重墙，免得后人误判）。**取舍写明**：进程确实活着的句柄**无限期**驻留（杀合法长活脚本正是本次要修的 bug），年龄买到的不是回收而是解释——超 24h 每 gap warn 一次、驻留的建立与释放都记 info，且**只在该事实真是留驻原因时**才归因（因自身原因驻留的会话不会被记到 kernel 头上）；出路（删子代理／显式关机／杀脚本本身即销账）与故意拆台路径（update-restart、最终 shutdown、replaced/killed、kernel repair）不受阻。**保护边界写进用户文档**：只覆盖「正在执行的 cell」与「`bash()` 句柄」，kernel 内 detach 的 asyncio task／裸线程／不经 `bash()` 的 subprocess **不受保护**，长活工作须握住句柄、保持 cell 在飞、或注册 heartbeat/cron 故意 pin。**零 wire 变更**：事实搭既有 `SessionSummary.isSessionActive` 便车，无新字段、无 capability gate、不提 `DAEMON_PROTOCOL_VERSION`(7)/`DAEMON_SCHEMA_REVISION`(37)，老 worker 自然降级。验证：374/374（含 daemon-mode 193）、tsgo 0、biome 0、私有探针闸 OK；六席异构复核（其中两席各跑六支与五支破坏性正控证明护栏承重）、真运行时端到端探针 9/9（`bash("sleep 45")` → journal 出现 active → 空闲 1.6s 后心跳已非 fresh 而事实仍 true → `kill()` 后转 false）。已知残余记账：probe 上限无轮转（33+ 条死记录仍可能 pin，方向选择是有意的）、pid reuse 只靠 24h warn 兜、>4MB journal 截尾属少算方向 |
| 2026-09-17 凌晨 | 修外部用户报的 **issue #19** 及两条同源缺陷（三笔提交；四席异构审查三轮全通过，每席各自在纯净副本跑破坏性正控）：①**压缩摘要落旁支**——`appendCompaction()` 把「同分支向前追加」（子代理用量归属、label 写入等）误判成分支导航，摘要被挂到旁支而当前链保留未压缩历史 ⇒ 反复压缩无效、最终撞 `Range of input length should be [1, 1048576]`（报告者实测连续 10 条 compaction 记录、每条后紧跟 `leaf_position`）。现在提交时分类（同分支向前／真导航／未知 pin／无 pin），同分支时把 `parentId` 重定向到当前 leaf（`_appendEntry` 不改写 parentId，不重定向就会在旧 leaf 处分叉、把窗口内追加甩到旁支＝丢数据），并把「cut 指向永不落盘的延迟合并 id」回退到最近已落盘祖先（**两分支共用**：旁支摘要日后 `branch()` 回访同样会丢 kept tail）；取证经可选 `options.onCommit` 回调交调用方记 `sessionLog`（返回类型仍是 `string`＝零 API 破坏，且**不进 `details`**——下一代压缩会把上一代 `details` 读回去派生 fact/user-request 账本）。红→绿：报告者复现 `hasSummary:false→true`；正控：删掉 pin 则「导航手臂」用例必红、把归一退回单分支则「重开回访」用例必红（三席各自复跑结论一致）。②**`enable_thinking` 强制关闭**——`zai`/`qwen`/`qwen-chat-template`/`deepseek` 四个分支按 `!!reasoningEffort` 发关闭信号，而能力表 `off:null` 的模型（本机 glm-5.3）端点直接 400「The value of the enable_thinking parameter is restricted to True」⇒ 每回合结束的自动精化、auto-refine review、分支摘要、daemon 会话摘要**全废**。改为四态判定（给档位或显式开→开；能关→关；不能关→**不发该参数**，端点默认即开启，实测 200），谓词 `modelCannotDisableThinking` 为单一真值来源（含 `model.reasoning`，否则非 reasoning 模型会被误判需要预留）；连带修「不发参数＝真的开始思考」引发的预算截断（status 的 400 被思考吃到 389 ⇒ `parseAgentStatusResponse` 返回 undefined ⇒ 状态行**静默失能且无错误日志**），按路径给有界思考预留（status 2048／branch 4096／review 12288／plan 40192；实测门槛在 512~768、真实需求 ≈500，故**不得调到 512**），能关思考的模型预算一字节不变。真机 smoke 14/14 全 `finish=stop` 且可解析。**上游同一个 bug**（`openai-completions.ts:643-652` 一字不差、`SUMMARY_MAX_TOKENS=400` 同在），可回馈官方。③**子代理静默只会被杀、不会被报告**——看门狗的 warn 阶段只上名册，母代理唯一能收到的信号是「杀」产生的失败通知 ⇒ 关掉杀就等于连信号一起关掉（本机一度正是这个最差组合）。现在 warn 阶段往母代理转录推一条通知（静默时长、在飞工具、在飞证据、母代理自己的取消杠杆），能叫醒空闲母代理、每子代理 10 分钟限一条、删除/抑制态不发；并据此把**看门狗默认改为 warn-only**（`stallWatchdog.abortAfterSeconds` 默认 900→0，自动杀降为可选，无人值守机群可自行开 3600）：静默是长活的常态（安静的构建、cell 里 await 长任务、只在结束时汇报的子进程），豁免白名单永远补不全，而**上游根本没有会话看门狗**（本 fork 2026-08-29 `6678ba83c` 引入）。原计划的「延长杠杆」因此**取消**——没有死线就不需要延长。保留 `retry.provider.streamStallTimeoutMs`（上游没有；它修的是模型连接挂了、以可重试错误收尾，不是杀正在干活的孩子）。**仍未修（施工中）**：90 分钟空闲逐出会连带 SIGTERM kernel 内活着的后台 bash——`isBashRunning` 只数宿主侧 bash 工具的控制器，kernel 里 `bash()` 起的句柄不算，`lastActivityAt` 也不因后台脚本刷新 ⇒「起了长任务然后安静等」的子会话被判 idle → passivate → 关 kernel → 进程组全灭，而会话之后还能水合、transcript 完好，**无人报错**；此链**上游同有**，审计 round-44 判为主根因候选 |
| 2026-09-16 凌晨 | 修 r30 协议线四条（PROT-1/2，全先红后绿）：①**应答信封入 digest**——`DaemonResponse`（success/failure/error/errorInfo/retryAfterMs 所在的信封）此前在全部 15 个哈希切片之外，rev29 的 retryAfterMs 当年正是从这个洞上 wire（号动 digest 不动）；照 rev32/33/35 先例加第 16 切片，schema 36→**37**（`f14397289a30`，测试重算钉死），头注照 35 合并先例登记。②**55bae7c50 盲区钉死**——rev30 窗口内"快照树有界字段上 wire 但 digest 不动"的唯一历史实锤（父子 commit 的 DAEMON_SCHEMA_ID 逐字相同，50 分钟后 a5edee5ee 才升 31）；新增守卫测试逐字回放该 commit 的 diff 形状（快照 wrapper/连接契约/装配层/treeWire 四切片各一条反演变异，digest 必动），内置 rev30 三切片配方的红证对照（同一批变异在旧配方下 digest 纹丝不动＝盲区复现），另跑"删掉 treeWire 切片→守卫红"的守卫有效性证明；历史实例与 50 分钟盲区已按诚实账登记进 daemon-protocol.ts 头注。③**rev36 降级路径测试补齐**——"旧 daemon 声明 rlm_quiescence_barrier 但响应无 rlmQuiescence 字段 ⇒ 新客户端退回改前语义"这条 rev36 注释自宣的路径此前零测试；新测试钉住：客户端照发 barrier 请求、拿到无字段响应时干净退出（exit 0）且正常拆台（complete_owned_session 照发），fail-closed 变异（缺字段当 give-up）下红。④**rev35 双 claim 撞号登记**——`7409359a6`（repl-kernel 侧，digest `5100d7bec2ea`）与 `7a931c383`（k3q 侧，digest `0632e2e54e98`）同晚各写 rev35，`34589648d` 跳 36 收冲突但撞号未登记；照 23-27 先例补进 daemon-protocol.ts 头注与本条，**35 永久退役**，取号前先读头注 |
| 2026-09-15 凌晨³ | 磁盘保留策略落地（并根治"删了又被读路径建回来"）：回收器按类别+引用判定（**实测立刻可回收 2.6MiB**：bash 全量输出 127 文件含一个 21MB 巨物、2511 个空临时目录、151 条死租约、103 个已删会话空壳），dill/venv/转录**全都不按年龄删**（实测 7.1GB 里 99.96% 挂活引用，venv 唯一一代有 21 个活内核引用）；开关 `retention.*`（0/负=关）+ 三重 rollback + 熔断 512MB/2 万条；**删除先写墓碑**且 cron 自毁判据改读墓碑、artifact 目录默认不再自动重建 ⇒ 两树对拍 RED resurrected=true → GREEN false；全局记忆库字节与 mtime 未变（逐字断言） |
| 2026-09-15 凌晨 | 修 K3 复核的四条：①**粘贴内的 kitty 转义不再中止粘贴**（去两条中止通道，粘贴态内只进文本；78/78 + TUI 822/822）②kitty 去重只对"整条序列就是那一个码点"生效，**不再吞无括号粘贴的首字符**③共享日志修尾改为**先观察静默再涂白**（窗口内字节一变就重置；判不清写者死活**拒写**并抛 still being appended，**不退回截断**），代价：正常路径 0.059ms、真修一次 27.7ms ④cron 另四处写者也走 restamp（66/66）。保留 Ctrl+C 作为粘贴态唯一中断出路（与括号粘贴一致） |
| 2026-09-15 凌晨² | 修 P1 扫描位置漂移：会话文件读取器对**跨 64KiB 块的长行漏计字节**（真实文件偏小 16.6%/38.6%/31.4%）⇒ 活会话追加后**重复计行**（消息数 +27.1%、输入 token −58.7%，界面那一行就是错的），且每次追加白读 4.1/17.2/24.4MB。改为按流位置推导 offset（pending 不再独立加项）+ 两道守卫（可达字节数 ≥ 上次记录、offset 前 1 字节必须是换行，专治原地截断重写被当成 append）；真实三文件offset 归零误差、追加读取量 **4.1MB → 162 字节**，仍走增量不退化 |
| 2026-09-15 凌晨 | 异构复核（2×K3 + 千问）在我今晚的修复里挖洞并当场修掉：①机器块**尾部锚定失去合法读取**（块后仍有正文时整条账本被静默读成 null）⇒ 改为"锚定优先、回退到最后成行闭标签"且**每次回退都告警**；②流式**片段模式中途接入丢工具参数**（seed 不回填 ⇒ `{}`）⇒ seed 用已累积参数重建缓冲，fragments 与 snapshot 同输入同结果；③`sleepSync` 的迭代上限在拒绝 `Atomics.wait` 的宿主上**退化成几乎不睡**（200ms 只等 48ms）⇒ 改为按单调钟 spin 到 deadline，仅冻结钟才放弃并告警。附带：工具名冲突闸 + 重复 tool id 去重已合入 |
| 2026-09-15 凌晨 | 修「同一个工具调用 id 出现在两条调用上」的**不可判定配对**：provider 复用 id 时两条调用都执行、两个结果都带同一个 id，凡按 id 配对的下游（UI 行、停顿记账、下一次请求体）只能猜，线上还会出现两个 `tool_use` 与两个 `tool_result` 共用一个 id（协议层无法判定）。现在 agent loop 在**入口**就把重复 id 改成唯一（首次保留原 id，后续加长度受限的 `__dupN` 后缀，上限 40 字以免被 provider 出站截断后再撞；从左到右赋值 ⇒ 已发出去的 id 不会因后续分片而变），流式事件与最终消息**一起改名**（UI/记账不落空），并在消息上留 `tool_call_id_collision` 诊断、会话日志记下「原 id / 工具名 / 新 id」——修过的 id 不再静默。红：agent 侧新模块不存在（文件加载失败＝正确红）、coding-agent 侧 5 失败|5 → 绿 7 通过 + 5 通过 |
| 2026-09-15 凌晨⁷ | 让「工具名被顶掉」变得可见：扩展 / SDK 工具与内置工具**同名**时，旧行为是后来的赢、被顶掉的那个**从模型的可调用面消失却一声不响**（模型仍会照着文档去调它，然后拿到「未知工具」；两个扩展抢同一名字时是「先注册的赢」，也无人提）。现在会话与扩展运行器都能给出机器可读的冲突清单（`AgentSession.getToolDiagnostics()` / `ExtensionRunner.getToolDiagnostics()`），文案同时点名**两个来源**、哪个可用、哪个不可达，并给出一个**没被占用的替代名**；交互模式弹通知、headless/RPC/SDK 走 stderr、启动诊断清单同列。红 8 失败|8 → 绿 3 文件 42 通过（另跑 agent-session 家族与 extensions-runner 回归） |
| 2026-09-15 凌晨 | 修 openai-completions 流式**分片配对**：解析器以前只认「index 相同即同一次调用」，于是 provider 复用 index、丢掉 id 或 name、或把一次调用拆到不同 index 的流，会把两次**无关调用并成一个**（参数互相粘连、工具结果配对错乱、下一次请求体里带错 id）。现在只在有「第二次调用实证」（新 name，或已开块参数已完整且新分片另起对象）时另起一块，无 name/id 的碎片按「不可归属」丢弃并在消息 `diagnostics` + warn 日志留诊断（不再静默）；红 9 失败|2 通过 → 绿 11 通过，既有 `openai-completions-tool-choice` 23 通过不动。已知取舍：同 index 同 name 的两次调用仍并块（离线无正控） |
| 2026-09-15 凌晨⁶ | 修 daemon 两处**静默损坏**：①停机「入场券」只领不续——持有者的事件循环被 `ps`/`lsof` fork、机器休眠卡住超过 5s 租约窗口时，它手里那张票已经失效却照样当有效票用（实测：`shutdown --force` 在负载下报 `Daemon shutdown admission was lost`、失败退出；等待方则会把在世持有者的过期票抢走 ⇒ 两个进程可能同时停机）。现在持有者每次自检租约、过期即**重新领取**（同一 token 家族、先 red 4 失败|1 通过 → 绿 5 通过），等待方遇到「持有者还在世但票过期」改为等它续租或 60s 响亮拒绝，不再抢票（既有契约用例已按新语义重写）。②daemon catalog 往转录里追加「已归档」状态与 worker 恢复注记时，既不取会话租约也不修残尾——崩溃留下的半行尾部会把新行**粘上去**成不可解析的一行，所有读者跳过 ⇒ 归档状态与恢复注记**静默丢失**（红 3 失败|3 → 绿 3 通过）；现在先取会话租约、只在租约下就地修残尾、再追加、finally 释放，转录被另一个活进程持有时响亮拒绝且盘上字节零变化 |
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
| 2026-09-20 傍晚 | **上游 26 笔择取窗（双席背对背分析→对撞→定案→施工→复审）**：26 笔里拿 8（`e305d413c` kernel stderr 报错不再炸整个 worker／`1bef2a01a` 私有帧解码 O(n²)→线性，实测 297s→预算内／`01ef8afa4` 压缩保工具身份，保我方三参截断／`638d95450` spawn 撞名预留到落账／`0daddd5e1` skill-sync 标记增量落盘／`74ae2ff64` cron 目录 mtime 守卫＋我方加一根「解析路也冻结」针／`c57c26f69` 心跳列表快照免排队（只拿 supervisor 半，与 `58d0db497` 扇出修复叠加共存）／`140da3bf9` compose memo＋增量时间戳——**只拿一半：flushRoster 半不拿（我方 dirty-set 更强），指纹扩 isKernelWorkInFlight/stall/spawnCode 三键防 r44 复活，复审时顺带证出上游同部位有个潜伏 bug**）。不拿 18（`#2391` 重启等待因 fork 禁自更新而休眠、`#2387` 撞提示词契约、`#2372` 机制不在场、其余 13 笔不适用面）。纪律：双席独立分析对撞（两家独立抓到同一枚零冲突陷阱）、先红后绿、变异实测（含 cron 删针必红的补腿实证）、全量 8190 零新增红、K3 异构复审 PASS（592 例独立复跑＋机械指纹审计）。延迟登记：#2378 的 rlm-ledger 拆分半（原语不在场）。回滚：`git revert` 各笔独立可回 |
| 2026-09-20 下午 | **「完工子代理赖在 Running 区闪图标」修复落地**：老板实测发现子代理完工 7 小时后视图仍列 Running。根因（研究席全档 `docs/fork/stale-running-subagent-status.md`）：roster 的忙闲公式把「内核还托管着活后台 bash」（驻留安全轴）当成「正在干活」（显示轴）读，且完工不通报、账本无完成态。修复 `f617503fd`：段位判据改读显示轴（`isSessionSummaryDisplayBusy`＝activity working），驻留轴与 r44 驱逐面一字未动；`hasLiveWork` 安全闸补两条腿（后台句柄活着的行删除键仍显示 stop）；完工时补一次 roster 通报。先红后绿 7 针、变异 6 条（M6 无针缺口＝完工 flush，失效后果仅延迟翻篇，已裁定登记为技术债）、全量 8189 零新增红（基线轮对照更红）、pristine tsgo 带正控。**DS 施工 × K3 异构复审 PASS**（复审独立重跑 217/217＋亲手复做 M1 变异逐条一致）。回滚：`git revert f617503fd`。另：上游新 26 笔择取窗已盘点，`#2378`（心跳快照免扫）与 `#2391`（重启期打开会话改有界等待）列入待吸收 |
| 2026-09-19 中午 | **重启窗生效＋三件附带落地**：`6a5fbcc32` 教 harness 认识自己的工具面（系统提示补 `rlm.collect()` 完整字段清单——5 天 73 次猜错绝迹；`Tool not found` 报错附可用工具清单——幻觉调用一回合自愈）；flake 治理：`rlm-child-stream-scaling` 的计时比例针（三次加固仍在 CI 抖动）整维删除，改确定性计数探针（新 `rlmChildDeriveCounts` 测试缝，6 递增点，生产零行为变化；变异 4/4 红、10 连跑全绿）。窗后自证：扇出 315ms（案发时 ≥5000ms）、attach 即时应答 |
| 2026-09-19 凌晨 | **主↔子切换卡死大审查＋首批修复**：老板报「切换视图 5-6 秒不显示」，12 席 K3 全审 09-18 全天 198 笔（窗内零高危；GLM 抽查 20 笔最高风险无误判）＋DS/GLM 三席异构复核（删 1 条陈旧发现、降 2 条过度断言、改 4 条措辞、0 条低估）。根因三证钉死（复现器 ×3 含 dist 真码注入）：`_waitForIdleOrSettlement` 在「非终态动作滞留＋本轮无泵可调／disposing 期有排队」时纯微任务自旋烧死 worker 事件循环（agent-session.ts:10905）；`heartbeats_list` 全员扇出 5s 硬超时被它拖满 ⇒ 每次切换必卡 5s（90b841996a，07-16 上游祖传）。**已交付 `58d0db497`（F4/F5）**：心跳目录从切换关键路径拿下改 fire-and-forget（interactive-mode.ts:3298）、扇出 5s→1s＋Promise.allSettled 部分目录＋失败 worker 回退自身最后快照（全瞎才失败）、切视图加「Opening…」占位（tui.ts 新 `flushRender()`）；红→绿→变异 10 档全咬得住、DS 复审带条件 PASS（C1-C6 记账入台账）。**F1-F3 治本同晚落地 `a9023f569`**（_waitForIdleOrSettlement 宏任务让出+16 圈零进展自愈报错、deferred 路径已落盘动作终态化、disposeAsync 前置幂等清算队列；红→绿→变异四档咬得住、DS 复审带条件 PASS）。台账 `docs/fork/audit-20260919-findings.md`（含复现器路径与回滚把手 `git revert 58d0db497`）。用户可感变化：worker 再楔死时心跳徽章可能短暂缺席（自治愈），切换不再卡死 |
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
- **版本**：本线已跟到 **0.9.5**（随 2026-09-17 上游合并抬号，P5 落地）；窗尾仍有
  `cf07c5a3f`/`b6ac5d014`/`e9d68d92c`/`e2fb7bfa1` 等提交，故实际是 **0.9.5 + 若干笔**，不发明 0.9.6。
  默认发布源仍是上游 bucket（`PRIME_AGENT_DOWNLOAD_BASE_URL` 可覆盖）；`update --self` 被 fork 闸门
  拒绝（`--allow-official` 可越），启动的 “Update available” 提示报的是**上游**版本——它是「本线有东西要同步」的信号，
  不是一条要去跑的命令。
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
- 修复全部带回归测试（先红后绿验证）| 2026-09-15 凌晨³ | 粘贴与对抗修复的**共享文件冲突**已解并合入（`stdin-buffer.ts` 4 hunks + 测试 4 段，逐段给了"取了谁/为什么/翻回把手"）：采用对抗批的结构（**粘贴态内控制字节只进粘贴文本**、去掉"粘贴→键盘通路"入口、缓冲不再丢），**但把 Ctrl+C(0x03) 恢复为中断**（粘贴卡住时必须能脱身）。红＝未恢复 Ctrl+C 时 tui 830/827（失败的 3 条正是中断断言）；绿＝tui 830/830、stdin-buffer+input+editor 322/322、biome/tsgo/净化树全 0。残留两条已记：0x03 之后同 chunk 的余字节仍回键盘通路（翻回把手＝删 3 行）；与 `\x1b[200~` 同 chunk 到达的 0x03 仍算粘贴文本（已加边界测） |
| 2026-09-15 凌晨² | 切界面性能（老板亲报）三条里的两条落地：①agents 视图 **40 帧风暴的重建从 40 次降到 1 次**（接 50ms 合并窗 + 只算 dirty 行、别名未变则复用记录）：整目录 pass 6.6→2.6ms（大夹具 28.2→2.0）、带作用域 6.8→1.3（28.6→1.7）②**搜索文本惰性化+跨次复用**：空搜索框 0 次读取（改前每行每遍）、reconcile 21.9→1.1ms；顺带把 heartbeat 无 job 时的每行索引与 session 路径 realpath 结果做 memo（冷 pass 8ms→0.5ms 热）。红绿：基线 6F/1S/3P → 10/10，agents-view 全量 220 + 扩面 585 通过 |
| 2026-09-15 凌晨⁵ | 切界面性能第三条（**attach 只编码一次**，去掉同一份转录的二次序列化）并入：真 supervisor + 真 socket + 生产编码器 + 真 16.1MB 会话 A/B —— legacy 首 attach **1630.5→293.9ms**、chunked 122.9→70.8ms、再一次 legacy **1840.9→114.2ms**；**worker attach 请求 2→1**；worker 侧从「0ms 编码 / 102.9ms 全量响应」变「59.6ms 编码 / 0ms 全量」；legacy 客户端 1826 条消息不丢。合并树套件 207+585+56 全通过、净化树 tsgo=0 |
| 2026-09-15 凌晨³ | 配置漂移两条 P2：①`models.json` **每次加载都校验**（此前首次加载走"校验器未就绪"分支会**采用非法文件**、refresh 后又**整份作废**让自定义 provider 全消失）②凭据迁移改为"**先接管并证明再删**"（旧逻辑只看 `auth.json` 是否存在就删 `oauth.json`，本机 `auth.json` 恰是 2 字节 `{}` ⇒ 一旦存在旧库即被销毁；现走合并→重读证明→再删，本机现状为 no-op）。门禁全零（biome 1249 文件/tsgo/净化树 tsgo/卫生门），132 文件 1390 通过，3 条失败均证明为基线既有（各自在冻结树同红） |
| 2026-09-15 凌晨² | 遥测/trace 隐私三修：①**上传内容走同一道隐私闸**（新 `core/upload-privacy-gate.ts`：剥 URL userinfo + 复用 /share 的形状与逐字比对，命中替换 `***redacted***` 并只记形状/字段/计数——头与 PUT 体同一闸，Authorization 头故意跳过并注明理由）②**写入作用域在发起时解析一次**（收尾目录不存在则不写不重建；`uploaded` 只对真实传输记，"注入 transport"记 `not uploaded`）⇒ 测试残留不再污染真实 `~/.prime/agent`（本机 75 条 outbox 已剪空）③**显式退出开关**（新 `utils/privacy-opt-out.ts`）：`DO_NOT_TRACK`/`PI_OFFLINE` 只拦"没被点名的出网"（启动版本检查/自动 trace/遥测），点名要的（/share、/traces upload-*、update）不被拦；`/traces status` 明示 `suppressed by DO_NOT_TRACK`，文档写明边界 |
| 2026-09-15 傍晚 | 并行清账一批（6 条线同时施工、按文件归属切分避免撞车）：①**配置面**：`!command` 配置值缓存加上失效面（`auth.reload/set/remove` 清缓存）、settings 未知键响亮告警、`PI_HARDWARE_CURSOR` 改为 env 显式设置即胜并告警、弃用的 `compat.reasoningEffortMap` 给迁移提示（顺带删掉文档里那个代码从未读取的 `collapseChangelog` 行）②**daemon 身份**：agentDir 成为身份——默认 socket 无人听时按 canonical agentDir 从 `~/.prime/supervisor-owners` 找活 daemon，且**同一 agentDir 起第二个 daemon 会被拒**（点名对方 pid/generation/socket）③**重试语义**：自判永久的错误不再重试（保留 #4491 凭据刷新例外）、新增**跨层请求预算**（链计数 + `x-should-retry:false` 拒掉超预算的 SDK 重试，耗尽即停空回合重发并给诊断）④**会话文件边界**：首行读到完整内容（超 1MiB 才抛带路径的错误并记诊断），**花费口径统一为"整会话、每条分支都算"**（/context、getSessionStats、roster、catalog 四处同数）⑤**凭证写硬化**：prime CLI 配置改走私有原子写（拒绝 symlink 目标）、跨工具 logout 可见、traces outbox 收紧到 0600/0700 |
| 2026-09-15 下午 | 给两个**无上限缓存**加界（新 `utils/bounded-cache.ts`：条数+估算字节+LRU+空闲 TTL，清扫只在插入时触发、不建任何 timer）：子代理展示缓存 4096 条/16MiB/15min、墓碑缓存 1024 根/4MiB；上限依据来自真机量级（1540 个 json 共 9.8MB、p99 20KB ⇒ 容量低于全集就每轮全 miss，故取全集 1.6×）。堆曲线从 **1k/2k/4k/6k = +16/+32/+64/+95MB** 变成**平的 +15~16MB**，删光目录后由 **158.8MB → 15.7MB**；变异检验（短路驱逐）⇒ 9 失败/5 通过，证明测试真在守驱逐 |
| 2026-09-15 中午 | **给停机加作用域**（今晚那次误停 daemon 事故的根治）：`shutdown`/`doctor --fix` 默认**只作用自己那一套**（作用域＝daemon 身份键＝socket 目录），`--all` 是唯一全机开关，另有 `--socket-dir`/`--dry-run`/`--orphans`；三处全机扫描全部收进作用域 + protected pid（否则"收窄"名义下照杀）。停机前**逐条点名**（socket+pid+活会话数，>0 标 `[ACTIVE WORK]`）并给保留理由，`--force` 不再静默。真机对照：改前 `planShutdownAll` **7/7 全停**（含带 128 条活会话的），改后默认 **1 of 6**、`--all` 6/6、`--all --orphans` 停 5 且老板被保护。另修 liveness 判定（活＝有会话/身份复核过的活 worker/CPU>0）与 macOS `ps -o etimes` 整批失败导致 uptime/cpu 全空的采样缺陷 |
| 2026-09-15 上午³ | 文档与代码一致性系统扫 + 修：16 条逐一对着源码核实（transport 默认值写反并补 `websocket-cached`、entry 类型清单补 `leaf_position`、`isPersisted()` 真名 `allowsPersistence()`、内置主题 3 个含 `prime`、themes 必需 token 51→55 并补 3 个 diff token、keybindings 补 13 个 id、sessions 选择器键表改真值、json.md 补 `requested`、usage 补 `--mode daemon/--acp-resident`、skills 的 venv 代际目录与优先级与 13 个内置清单等），另顺手核实后修 README 的 Ctrl+P 假绑定、theme 默认值、`--thinking` 漏 max |
| 2026-09-15 上午² | 第三条 CI 红判为"**旧断言过时、代码无过**"并修好：逐 SHA 定位到保留 sweep 批次（`5338afe49`）在 `rm()` 前写墓碑、而私有存储法会把"不是正好 0700"的根重写成 0700（0555 也算太松）⇒ 只读根照样被扫掉，旧断言的前提失效。修法把删除屏障搬到删除路径碰不到的一层（artifact 目录 0555 + 内含 payload，断言 payload 仍在＝真控制），另立一条钉新契约（根 0555→0700、缓存被扫）；**非空转反证**：把改好的测试丢进旧 SHA，正控仍绿、新契约条红（`expected 365 to be 448`）⇒ 断言真在守契约。daemon-mode 188/188、分批 45/26/44 全绿 |
| 2026-09-15 上午 | CI 追红两条：①`proper-lockfile-compromise` 的旧断言依赖"已删会话目录被读路径复活"才可能抛错，而保留策略那批**故意堵掉了这条复活路**（store 缺失/tombstone ⇒ 早退）⇒ 改为在**真实存在**的 store 文件上驱动锁破坏、断言仍抛且文件逐字未变，并补正控与新契约条（缺文件不取锁不建目录）；变异检验（删早退→红、吞掉破坏→红）②`bash-executor-temp-file-failure` 是**测试卫生 bug**：`afterEach` 把 `TMPDIR` 还原成字符串 "undefined"（Node 会把 env 赋值 stringify，不是撤销），ubuntu runner 不导出 TMPDIR ⇒ 第一条测试即下毒、死在 fixture 而非断言（macOS 恒有 TMPDIR 所以本地永远绿）。抽出 `restoreTmpdir`（undefined ⇒ delete）+ 平台无关回归测试。两文件 17/17、相关批 239 项全绿 |
| 2026-09-15 凌晨 | 把"引用判定"抽成**唯一实现**（`core/kernel/reference-records.ts`：四态 judge + 删除前二次读 + 短写安全 writer），venv 与 kernel-snapshot 两边只留各自布局语义——病因就是"同一判定两份实现"。冻结源码真跑复现：**活 pid 的截断引用被删且它指名的整代被回收**（reclaimed=1）；改后同探针 referencesLeft=["<pid>.json"]、三代全在、reclaimed=0，且正控齐全（真死引用仍回收、pid 复用仍判 stale、二次确认两向、关开关仍扫 stale）。另登记**多份实现清单**（孤儿回收/守护身份判定/artifact 与 semantic-edges 另一套律等）与两条残留（snapshot 侧暂无 writer；lstat 任何失败都判 stale，硬化方向＝仅 ENOENT） |
| 2026-09-15 凌晨⁶ | 保留策略复核修正并入（解了 venv/租约共享文件的冲突）：取主线**四态判定 + 删除前二次确认**，取待合入侧**只读模式守卫**，逐段给了"取了谁/翻回把手"。附一条**环境误红根因**：我先前看到的租约测试红与 venv 改动无关——是测试卫生要求 unset 的 `PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID` 让"活租约"被判成"本进程泄漏"，同一源码只差该变量即可红/绿复现。红→绿三组（四态 3失败/48通过→52/52；干跑守卫 1失败/22通过→23/23；租约 fixture 钉 activeSessionId 而非放宽契约），7 套件 119/119、biome/tsgo/净化树/pre-commit 全绿 |


| 2026-09-18 夜 | **#2426 的 UI hunk 在合并时被解回 fork 侧**：rev38 的头号命令 `abort_and_send_queued` 在出货路径上零生产者（interactive-mode 的 Esc 仍调 `abort()`），CHANGELOG 却宣称可用；已接线（流式中断换回 `abortAndSendQueued()`）并补 8 针（含真 interruptOrClearInput × 真 DaemonAgentConnection × 假 transport 的跨层 wire 针）。教训：路径级 take 的范围表要含**生产者端**——六闸里没有一道核"上游该笔的调用点是否也过来了" |
| 2026-09-18 夜 | **steer()/followUp() 记 `source:"internal"` 而 priority 按 "interactive" 派生**：pre-#2334 快照恢复时这类人打的行降 background；TUI 的 Enter 走 `prompt()`（记 interactive）不受影响。未修（动 source 记录口径影响所有恢复/审计面），已钉针；另 `AGENT_TASK_STATES` 未进 digest 切片（加第 18 片会改 DAEMON_SCHEMA_ID、所有混合版本对 replace/refuse），现用扩域承认针顶着，代价不擅自付 |

## 2026-09-22 R4 上游同步＋UI/自愈一役

- TUI 大幅降噪（U4）：轮内工具活动折叠为一行摘要（Ctrl+O 展开）、thinking 一行化、bash 完成收行、提示全中文化去重——同屏机械行 24→1、正文占比 0.23→0.75，展开视图零内容丢失。
- agents view 三新列（U3）：settled（收口/开口）、会话时长、最后答案预览行（可搜索）；旧 daemon 无字段自动降级。
- 底栏常驻遥测（U1）：模型名＋上下文水位＋压缩线，GLM 系带 390k 风暴警戒线；连续工具错误 ≥3 显示 ⚠ 徽标（U2）；/speed 显示输出速率。
- 卡住的子代理现在会主动通知父会话（stall→父通知，U5）；agent_message 新增 abort 能力（能力门协商，老 daemon 自动降级）。
- GLM 修复双激活：toolStream=false 关工具分片流坏调用＋思考 token 不再被 32K 夹死；新增探针测试钉死生产配置。
- 吸收上游 43 笔计划：实拾 30 笔，8 笔实测 fork 已在场、2 笔按当年合并裁定跳过（机制成死码）；每笔独立可回滚，六次合流全零冲突、六道闸全绿。
- 修了 imageModel 设置误报、上游测试带来的 10 处私有探针已全部带理由登记。

## 2026-09-22 GLM 坏调用根治的用户侧迁移说明

- 根因（已修代码侧 cc4a17379）：百炼 GLM 家族默认 tool_stream 分片流，长上下文分片累积成乱码工具名＋空参数（实测修复前 269 条坏调用，82% 来自 GLM 两模；修复后 6304 次调用仅 4 条边缘形态）。
- **用户必配**：`~/.prime/agent/models.json` 里每枚 Bailian GLM 条目加 `"compat": { "toolStream": false }`——拉新版不配此键，坏调用依旧（网关默认仍开分片）。文档已进 packages/coding-agent/docs/models.md（compat.toolStream 节，含配置示例与探针测试说明），发版 fragment 已落（glm-toolstream-migration-note.md）。
- 探针测试 openai-completions-bailian-glm-toolstream.test.ts 钉死 payload `tool_stream===false`（含生产 models.json 实读断言，防配置漂移）。

## 2026-09-22 看图工作法（四家研究收口）

- 主模型无视觉时，带图轮自动路由到 settings.imageModel（现为 deepseek-v4.1-flash）；追问轮看不到历史图（官方文档既定设计）。
- **追问带一张新图＝历史里所有旧图一起重看**（实测 wireImages=2）——"改→再看→对照"零成本成立。
- 反复看图的活（UI 仿图、验收审查）派视觉子代理工位；playwright 截图传 filename 落盘再 attach（内联超 64K 截断）。

## 2026-09-22 日终补丁批（三席复审对撞欠账闭环）

- **丢图可疑告警补轮内工具结果图**：b89236119 的判据只算派发批携带的图，漏掉本仓旗舰送图路径（attach_image 落进轮内 toolResult、由续跑请求重放的图块）——现在「批带图 ∨ 轮内工具结果带图」任一即武装告警；正反两钉已落（撤修变异实测转红）。
- **0.11.0 更新日志中『只保留最新 harness digest』条目已随 revert 失效**：发布（10:57 折叠）早于 revert（11:03，`9cf71140f`），已发布段按仓规不可改——下次发版折叠反向 fragment `r4-revert-keep-newest-harness-digest.md` 更正（动机＝与 fork 自研 digest 窗口机制设计冲突、2098 套件 10 红实测；代价＝built context 回多 digest 堆叠约 1.5-2.5k token）；pick 台账 #38 行已同步改记 revert。
- 三笔欠账 fragment 补齐（digest revert 反向、agents-view 空字段区收起 set/dur 列、时长整秒量化）；五组复审点名缺钉补齐（blockImages 跳过、aborted 跳过、时长量化边界、收起分支、混合区列对齐），全部带变异红正控。
