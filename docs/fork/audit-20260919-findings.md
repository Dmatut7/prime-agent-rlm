# 2026-09-19 凌晨大审查·发现汇总台账（母席维护，持续更新）
窗口：09-18 00:00 起 198 笔提交（HEAD 6c907da66）；12 席 K3（5 席围卡顿+7 席分面）+ 3 席 DS/GLM 异构复核。**窗口内提交零高危**（限读口径：窗内引入、在 12 席全审＋GLM 席 20 笔最高风险抽查可及面上未发现；抽样率 10%，67334bf1a 合并大单 4.7k 行无法行级完备——作为完备断言可信度评中偏上）；两条高危在主案的老代码里（见主案节）。

## 主案：TUI 主↔子切换卡 5-6 秒（已破案，双席独立证实）
- 直接凶手：interactive-mode.ts:3278 `await refreshHeartbeatCatalog()` → daemon-supervisor.ts:3339/3378-3382 heartbeats_list 全员扇出、每 worker 5000ms、Promise.all 等最慢 ⇒ 每次切换烧满 5s（**复核订正：5s 是下限非上限**，扇出前可等 launch≤15s/recovery/被动任务收集；单 worker 失败拖垮整次列表代码属实但**本次大概率未触发**——楔死前的 fresh 缓存走了降档。5s 字面量引入订正：90b841996a **2026-07-16**，非 09-11）。
- 楔死真身：worker 068f98d2df0f (pid 19503) 03:17 起 promise 自旋 100% CPU 40+ 分钟；**代码级定位：agent-session.ts:10905 `_waitForIdleOrSettlement`**——退出需 5 条件同真。DS 复核席反证订正：isStreaming/refinementApply「卡真⇒自旋」不成立（isStreaming=true ⇒ activeRun 在 ⇒ agent.waitForIdle() 返回未落定 promise ⇒ 自然停泊）。真实自旋形态只有两种：①unfinishedActionCount>0 且 queued==0（本轮无泵可调，三 await 全瞬时 resolve）；②disposing 期间仍有排队动作（park 被 !\_disposing 排除 + \_scheduleSessionInputPump 在 disposing 下提前 return）。触发：杀子代理 teardown(_cancelRlmChildRun:15169)×终态通知入队(_enqueueRlmTerminalNoticeAction)×回合续跑，同 100ms 窗口叠加。CDP 三采同函数实锤。
- 待钉死：谁调的 waitForIdle（候选 wait_for_idle RPC/waitForRlmQuiescence/refine apply/压缩后续跑）、5 条件里谁卡死（isStreaming 卡真 vs 半途 notice 动作不算完）。
- 历史复发：08-24/08-25/09-10/09-17 同型 attach 30s 超时。
- 处置：僵尸已 SIGKILL（03:56），扇出回落 199ms，老板界面已恢复。


## 主案补完（review-daemon-reliability 阶段1）：自旋的自锁结构
- 完整死锁环：①follow-up 注入留下 unfinished action；②teardown 置 _disposing=true，但 _disposeAsyncOnce(agent-session.ts:6509) 先 await 子会话/内核 dispose、最后才 this.dispose() 清队列；③waitForIdle 等待者落进 10906 循环——park 条件 10916 刻意排除 disposing（注释自证），三个 await 全立即 resolve，出口条件因 unfinishedActionCount!==0 永假；④**自锁：内核 dispose 需要事件循环跑 I/O，自旋饿死它 ⇒ dispose() 永不执行**。DS 复核订正归因：「队列永不清」仅当滞留物是 queued 时成立；若滞留物是 committing/running 则 dispose() 跑完也清不动（CLEARABLE_STATES 只含 queued/selected/preparing）——结论更强但归因而异。唯一出口＝外部杀 worker。一个会话自旋＝整 worker 死（共享事件循环）。
- supervisor 半侧实锤：forwardToWorker 对 probe 超时只 log+rethrow（daemon-supervisor.ts:7317-7326），socket 不断 ⇒ handleWorkerClose 不触发 ⇒ 永不判死。109 次超时零处置由此而来。
- 两段病码都不是本窗口引入（park 来自 a31d520ce 09-12；超时档 09-11）⇒ 09-18/19 批次彻底洗清。
- 修复候选（施工席二选一或并用）：a) 10916 park 不排除 disposing（dispose() 的 _cancelSessionActions 会经 _notifySessionInputCheckpointChange 唤醒 park）；b) disposeAsync 开头先同步 _cancelSessionActions 再 await 内核。

## DS 复核新发现（一行级可修）
- _settleAbortedDispatchedTurnActions 谓词（queueVisible ‖ durable-notice 集合）漏 stall-notice 类动作（:8083-8094 建的 queueVisible:false 且不在集合）⇒ abort 当刻无人结算（实测 unfinished=1），只是被泵收尾兜住。修法：谓词放宽为「所有无 await 调用方的已落盘 dispatched turn」。
- R1/FIX-Q8 提交信息里的 "stayed committing/running forever" 只有同步断言支撑，"立刻"是真价值、"否则永久"未钉。
- supervisor「永不判死」表述要打折：既有恢复梯（adoption/recovery 置 recovering、recoverWorker 关 client、5 分钟 failed reaper）在，且设计取向是「identity 仍 current 的活 worker 故意继续探」⇒ 修复应限定为目录/请求面熔断＋记账降权，**不能无条件强杀活 worker**。

## 修复方案（按 DS 复核重排：能验/低风险/止血快优先）
a. interactive-mode.ts:3278 心跳目录改 fire-and-forget（一行级，消确定性 5s）【fix-switch-stall 席施工中，含扇出 per-worker 容错+部分结果】
b. abort 结算谓词放宽（上条新发现）
c. deferred 路径终态化已落盘动作 + disposeAsync 开头先同步清队列（**两者必配同批**）
d. 保险丝：_waitForIdleOrSettlement 末尾 setImmediate 让出 + 零进展自检 log/break
e. park 条件扩容放最后，且必须配超时轮询（落宏任务）或新唤醒源——否则把自旋换成 waiter 长挂、挡 passivation
（原 5-8 项：切换占位 / supervisor 熔断改降权式 / 盘扫 stale-while-revalidate / session-info-cache schema bump 顺延）

- 提交书两条断言收紧（DS 席订正）：「empty catalog 不发布」只在全员无应答时成立（空数组算 answered）；「徽章消失」限定为 stale+miss 组合窗口。
- 回滚把手：`git revert 58d0db497`。复审指派：DS（review-f4f5-diff）主审 + GLM 二席查徽章缺席后果。

## F4/F5 复审结论（DS 席，带条件 PASS，无阻断）
- 语义反转方向正确：新语义在每种可比情形下 ≥ 旧语义（健康 worker 拿最新、失败 worker 拿自己的最后完整快照）；「全瞎才失败」守住空目录语义。已另派 GLM 第二席专查「徽章缺席有无动作级后果」。
- 生效面口径：F4a（fire-and-forget）覆盖两条切换路径；F4b（1s 扇出预算）只覆盖全局扇出，client-owned 会话的 25s 档不受其管。
- 四个记账条件（入第二批）：C1 部分目录客户端不可区分（UI 弱提示或入文档）；C2 1s 预算「未被证伪≠被证成」，补边界针+成功时延打点；C3 超时日志 tier 名与实传预算不一致（一行级）；C4 「失败但有新鲜快照」新分支缺专属针。
- 顺带发现的既有小缺口：连接被替换时新连接的 rebind 会并进旧连接的僵死 promise、本次刷新被静默吞（一行级可修，入第二批）。
- 复审抽查 4 档变异复跑全部咬得住；占位残留实测为零（VirtualTerminal 双帧实证）。

## 第二批备案（施工席建议、母席裁准）
- 泵 blocked 早退回滚 preselected：会改变 accepted agent message 的 deferred 判定语义（10625/8689-8696），收尾期风险>收益，单独批次。
- _settleAbortedDispatchedTurnActions 谓词放宽：需新增「caller-awaited」判别位，直接放宽会误纳 direct prompt、撞 R1 既有针，单独批次。
- F6 supervisor 熔断降权、F7 盘扫 stale-while-revalidate、M1+L12-3 同批修、M2 preflight 拒绝补上、session-info-cache schema bump。

## 修复方案旧档（待老板拍板后施工）
1. refreshHeartbeatCatalog 改 fire-and-forget（:3278 不 await，徽章后补）——消确定性 5s。【一行级】
2. 扇出容错：per-worker 独立成败+先用缓存快照应答+超时降档。
3. 切换加载占位（"正在打开…"），切入/切回双向。
4. detach 不等回执（daemon-agent-connection.ts:1855 短超时不阻塞）。
5. get_context_tree 同步扫切片化/异步化（仿 2d63e443d；单次 0.18-0.44s×每 5-15s = 日常小卡源）。
6. supervisor 超时熔断（今晚 109 次超时零处置，42 分钟才回收）。
7. _waitForIdleOrSettlement 停泊条件补全 isStreaming/refinementApply 卡真形态（治本）。
8. session-info-cache schema 版本 bump（model 字段加了版本没 bump，考古席 §5-A）。

## 审查发现账（按严重度）
### 中
- M1 context-tree.ts:1611-1615 缓存命中分支漏 addScanCharge → 父帧缓存永久少算命中子树统计，/context 截断标记可丢（review-topbar-scan）。**已机械实锤**：复现器 /tmp/charge-rollup-proof3.mts（三层树混合命中场景），回放 scannedChildren=3/bytesRead=2871 vs 真值 4/3613；**DS 复核席把后果证成**：暖命中后 truncated 标记消失、/context 的「还有 N 个未显示」警告不再打印而名册确实缺员（/tmp/recheck-m1-truncation.mts 三采实证）。引入 1917d1049，后续五笔未碰，测试无 mixed-scan charge 断言。
- M2 preflight-push.sh:179-187 PRIME_AGENT_KERNEL_PYTHON 给错时 fail-open（自称 fail-closed）；——DS 复核订正措辞：真缺陷是**不拒绝**（该分支既不断 push 也不进 NOT-RUN 名单，收尾只打一行 faces red 仍印 preflight OK）；正控证明拒绝机制本身在别处是好的（review-ci-release 发现，xcheck-findings 机械复现）。
### 低（14 条：L1-L14 中删 L5、L8 降备案，+ L16）
- L1 删 harness 条目后删除新闻被重复投递 ~7KB（78af6fc4d 豁免覆盖不到自删；review-digest-ranking）。
- L2 指纹严于渲染的过度投递（180 字符截断后改动照样重投；方向安全）。
- L3 05c8f2972 位掩码串位（18 分钟窗口内已修 a5f4868c0，备案）。
- L4 harness-search-parity 接口字段陈旧（rank→rank_positive）。
- L6 价格 memo 对摘要类条目永不命中（compaction.ts:124-148 每次新建对象；纯 perf 缺口）。
- L7 fact-appendix prune 注释口径 overstated（localeCompare 决胜跨 locale 漂移；已有裁决 4feacb5ce）。
- L8【降为备案】_recoverSessionActions 掉档只影响 source=internal 行（RPC/daemon）；TUI 提交不受影响；有 pin 且 CHANGELOG 0.10.0 已登记为已知行为（DS 复核降级）。
- L9 压缩闸 watchdog 单次触发自清，abort 被吞时 isCompacting 永真无重武装（:7428-7462，需更深故障叠加）。
- L10 ci.yml hygiene job 两处自测双跑+一条腐注释（:454/:516, :461/:520, :512）。
- L11 preflight-push.sh step2 第 60 次白等 20s。
- L12 定价面 6 条：互斥标注同挂（subagent-summary-line.ts:101）、缓存浅拷贝共享引用（context-tree.ts:1184/1190）、回放绕过预算闸（:1111）、归因差口只钳负向、巨率溢出 $Infinity、subagentSpendCell 配置用 !==false。
- L13 凭证隔离 SIGKILL 用例空转（stub 立即 exit，杀的是已退进程，名义命题不可证伪）；waitForProbe existsSync 已知 flake 类（f93cd9a4e；DS 复核收窄：kill 腿空转属实但整用例仍有鉴别力，waitForProbe exists≠写完为真实 flake 类）。
- L14 压缩闸 watchdog 单槽位：branch summary 与 compaction 真并发时后者有窄窗无看门狗（9efce5abd；DS 复核订正：窗口实为「后者整段无守卫」，实测可永久，窄的是触发条件）。
- L16 tool-output-budget.ts 首行超预算按 UTF-16 码元切，可切裂代理对（装饰面）。
### 窗口内已修备案
- 8ed6d73bc 的 mkdir 搬进循环 $REPORT 未绑定（4612e8953 已修）。

## 洗清的面（零高危中危）
09-12 修复（12 不变量全在）/ digest 排序 / 压缩计价 / 队列优先级 / CI 发布闸 / 定价功能 / 昨天性能批（对卡顿无一构成新阻塞）。

## 补充环审查（daemon-reliability 终报）
- 候选2【低】daemon-supervisor.ts:7426 attach validation 等待环：同 generation 的 begin 分支直接置 undefined 不结算旧 promise ⇒ 等待者挂起至 24h 档。
- 候选3【低】resumeDeferredWorkerRecovery 每 5s 真定时器空转（不饿死，只贫转）。
- 触发路径二（topbar-scan 实锤）：_pumpSessionInputs 的 deferred 错误路径（agent-session.ts:9641-9656）对已落盘动作不回滚不置败 ⇒ 永久漏在 committing/running ⇒ unfinishedActionCount 永 ≥1 ⇒ 结构与dispose盲区成立（必修）；**DS 复核席曾判「自然触发未证」，fix-spin-core 席随后用纯公有 API 复现成功**（prompt 先落盘再抛错 + acquireQueuedWorkPause 推 epoch 判 deferred ⇒ unfinished 永为 1；test/suite/regressions/spin-deadlock-wait-for-idle.test.ts 针2）——自然触发链闭环。另实测补证 DS 推论：isStreaming 卡真形态只永挂不自旋（定时器不饿死）。。
- 修复四候选：a) 落穿分支加 setImmediate 宏任务让出（保险丝）；b) dispose 窗口禁入 waitForIdle 族；c) deferred 路径已落盘动作显式置 failed；d) supervisor 超时连击 N 次强杀+广播死因。

## 收官补遗（switch-path-2）
- 自旋复现成功：/tmp/spin-repro.ts 手造 committing 滞留+waitForIdle ⇒ 99% CPU 27 分钟、自身退出定时器被饿死——与线上签名逐帧吻合（红测雏形在此）。
- 【关键补强】dispose() 也清不动 committing/running：_cancelSessionActions 默认只取 {queued,selected,preparing}（store 262-267）⇒ 修复项(c)（deferred 路径显式终态化已落盘动作）是**必修**不是选修。
- 【历史复发机制·已被复核推翻】「按 Enter 即自旋」不成立——waitForSessionInputIdle(:10887) 只等泵链，不是自旋函数；真实入口是 waitForIdle 族（wait_for_idle RPC、headless-completion、扩展 ctx 等）。08-24/25、09-10/17 的同型超时是否同根**未证**。
- 【恢复安全性】恢复快照只含 queued 动作，滞留的 committing/running 不进快照 ⇒ 家族重开安全不复燃。
- 修复补强：a) 落穿分支除 setImmediate 外加「零进展自检」（连续 N 次迭代四状态全不变 ⇒ log+break 报错）；d) supervisor 连击计数已有雏形（consecutiveFailures 字段），只差动作。

## 复现三证（三席独立）
- switch-path-2 /tmp/spin-repro.ts：99% CPU 27 分钟，自身 8s 退出定时器被饿死。
- regression-diff 最小复现：正控通过；造出 committing 滞留后 waitForIdle 把 2s 观察与 8s 硬退定时器全部饿死。修复方向细化：停泊条件从「queued>0 && pump-busy」扩成「unfinished>0 且本轮无泵可调」，在 checkpoint waiter 上停泊。
- block-qualia-2 /tmp/spin_proof.mjs：**用 dist 真码注入假 this 复现**（agent.waitForIdle 被调数十万次、setTimeout/setImmediate 全饿死 1.5s+）。
- 触发链精化：abort 的两张终结网漏「queueVisible 的 selected 动作」——取消网要 !queueVisible（:11038-42）、终结网要 committing/running（:11091-92），selected 落缝成孤儿；孤儿生产者=泵 blocked 早退（:9566-72，preselected 不回滚且不重排泵）。
- 修复细化（block-qualia-2）：queued==0 时注册 _sessionInputCheckpointWaiters 停车（26 处既有通知点必唤醒）；泵 blocked 早退时对 preselected 回滚；get_context_tree 改 stale-while-revalidate（先回旧树+异步重扫）。
- switch-path-2 /tmp/spin-repro.ts：99% CPU 27 分钟，自身 8s 退出定时器被饿死。
- regression-diff 最小复现：正控通过；造出 committing 滞留后 waitForIdle 把 2s 观察与 8s 硬退定时器全部饿死。修复方向细化：停泊条件从「queued>0 && pump-busy」扩成「unfinished>0 且本轮无泵可调」，在 checkpoint waiter 上停泊。

## 舰队事故（本会话教训）
- 3 席真死（stopReason=toolUse 后回合戛止、文本断半句）：sub-82df0ec6、sub-8a5ca4b5、sub-e4d0816e。均 K3-max。死因未定位，疑似下一会话请求未发出。
- 2 席假完工（collect 说 done 但实际还在 streaming）：audit-switch-path、audit-regression-diff——先 observe 再判救了一次误重派。


## 异构复核终判（DS 席五路并行 + 亲验，2026-09-19）
- M1/M2 维持中危（双机械复现；M1 后果证得更实：暖命中后「还有 N 个未显示」警告消失而名册缺员）。**M1 与 L12-3（回放绕过预算闸）是同一个 replay/rollup 记账面，修复必须同批**。
- 删除 1 条：L5（错名在审查窗前 6.5 小时已被 8ed6d73bc 修掉，陈旧结论）。
- 降级 2 条：L8（→备案）、L15-b（「活会话自燃/永久」不成立，泵 1-2 拍内自行终态化；残留仅 queueVisible:false 且未注册进 durable-notice 集合的两类动作）。
- 措辞订正 4 条：L13/L14/候选2/L9（「无重武装」不成立，多处独立重武装）。
- 拆分 2 条：L12-6（①不成立=成文设计 ②畸形值读成 true 成立）；L15（a 高维持但触发理由改写为「非终态动作+三 await 全 resolve ⇒ 不可自愈+处置窗自锁」）。
- 升级：0 条（含 2 万次 fuzz 否掉两条升级假设）。备案1 症状订正：set -uo pipefail 无 -e，不是中止而是静默空转。
- 复核自证口径：M1/M2/L12-3 走真实模块导入复现；判"低"且靠"当前无调用方"支撑的条目（L12-2、L8）只保证读码+pin 范围内成立。
