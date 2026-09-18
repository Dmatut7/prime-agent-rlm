# 2026-09-19 凌晨大审查·发现汇总台账（母席维护，持续更新）
窗口：09-18 00:00 起 198 笔提交（HEAD 6c907da66）；12 席 K3（5 席围卡顿+7 席分面）。全场零高危。

## 主案：TUI 主↔子切换卡 5-6 秒（已破案，双席独立证实）
- 直接凶手：interactive-mode.ts:3278 `await refreshHeartbeatCatalog()` → daemon-supervisor.ts:3339/3378-3382 heartbeats_list 全员扇出、每 worker 5000ms、Promise.all 等最慢；一台 worker 楔死 ⇒ 每次切换烧满 5s。单 worker 失败还拖垮整次列表（:3404-3407）。
- 楔死真身：worker 068f98d2df0f (pid 19503) 03:17 起 promise 自旋 100% CPU 40+ 分钟；**代码级定位：agent-session.ts:10905 `_waitForIdleOrSettlement`**——退出需 5 条件同真，而停泊分支(:10916)只在 pump-busy 时生效；_isBusyForSessionInput("pump")(:9764) 不含 isStreaming/refinementApply 但 canSelectSessionAction(:552-563) 含 ⇒ 「有排队动作+isStreaming 卡真+pump 不忙」时每圈追加新泵链永不退出。触发：杀子代理 teardown(_cancelRlmChildRun:15169)×终态通知入队(_enqueueRlmTerminalNoticeAction)×回合续跑，同 100ms 窗口叠加。CDP 三采同函数实锤。
- 待钉死：谁调的 waitForIdle（候选 wait_for_idle RPC/waitForRlmQuiescence/refine apply/压缩后续跑）、5 条件里谁卡死（isStreaming 卡真 vs 半途 notice 动作不算完）。
- 历史复发：08-24/08-25/09-10/09-17 同型 attach 30s 超时。
- 处置：僵尸已 SIGKILL（03:56），扇出回落 199ms，老板界面已恢复。


## 主案补完（review-daemon-reliability 阶段1）：自旋的自锁结构
- 完整死锁环：①follow-up 注入留下 unfinished action；②teardown 置 _disposing=true，但 _disposeAsyncOnce(agent-session.ts:6509) 先 await 子会话/内核 dispose、最后才 this.dispose() 清队列；③waitForIdle 等待者落进 10906 循环——park 条件 10916 刻意排除 disposing（注释自证），三个 await 全立即 resolve，出口条件因 unfinishedActionCount!==0 永假；④**自锁：内核 dispose 需要事件循环跑 I/O，自旋饿死它 ⇒ dispose() 永不执行 ⇒ 队列永不清 ⇒ 环永续**。唯一出口＝外部杀 worker。一个会话自旋＝整 worker 死（共享事件循环）。
- supervisor 半侧实锤：forwardToWorker 对 probe 超时只 log+rethrow（daemon-supervisor.ts:7317-7326），socket 不断 ⇒ handleWorkerClose 不触发 ⇒ 永不判死。109 次超时零处置由此而来。
- 两段病码都不是本窗口引入（park 来自 a31d520ce 09-12；超时档 09-11）⇒ 09-18/19 批次彻底洗清。
- 修复候选（施工席二选一或并用）：a) 10916 park 不排除 disposing（dispose() 的 _cancelSessionActions 会经 _notifySessionInputCheckpointChange 唤醒 park）；b) disposeAsync 开头先同步 _cancelSessionActions 再 await 内核。

## 修复方案（待老板拍板后施工）
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
- M1 context-tree.ts:1611-1615 缓存命中分支漏 addScanCharge → 父帧缓存永久少算命中子树统计，/context 截断标记可丢（review-topbar-scan）。
- M2 preflight-push.sh:179-187 PRIME_AGENT_KERNEL_PYTHON 给错时 fail-open（自称 fail-closed）；且不查 PREFLIGHT_KERNEL_REASON 逃生门，PREFLIGHT_REQUIRE_ALL_FACES=1 也拦不住（review-ci-release）。
### 低（12 条）
- L1 删 harness 条目后删除新闻被重复投递 ~7KB（78af6fc4d 豁免覆盖不到自删；review-digest-ranking）。
- L2 指纹严于渲染的过度投递（180 字符截断后改动照样重投；方向安全）。
- L3 05c8f2972 位掩码串位（18 分钟窗口内已修 a5f4868c0，备案）。
- L4 harness-search-parity 接口字段陈旧（rank→rank_positive）。
- L5 check-process-smoke.sh usage 注释写错名。
- L6 价格 memo 对摘要类条目永不命中（compaction.ts:124-148 每次新建对象；纯 perf 缺口）。
- L7 fact-appendix prune 注释口径 overstated（localeCompare 决胜跨 locale 漂移；已有裁决 4feacb5ce）。
- L8 _recoverSessionActions 恢复快照时人类 prompt 被降 background（agent-session.ts:8937-8944，触发链窄）。
- L9 压缩闸 watchdog 单次触发自清，abort 被吞时 isCompacting 永真无重武装（:7428-7462，需更深故障叠加）。
- L10 ci.yml hygiene job 两处自测双跑+一条腐注释（:454/:516, :461/:520, :512）。
- L11 preflight-push.sh step2 第 60 次白等 20s。
- L12 定价面 6 条：互斥标注同挂（subagent-summary-line.ts:101）、缓存浅拷贝共享引用（context-tree.ts:1184/1190）、回放绕过预算闸（:1111）、归因差口只钳负向、巨率溢出 $Infinity、subagentSpendCell 配置用 !==false。
- L13 凭证隔离 SIGKILL 用例空转（stub 立即 exit，杀的是已退进程，名义命题不可证伪）；waitForProbe existsSync 已知 flake 类（f93cd9a4e，review-daemon-reliability）。
- L14 压缩闸 watchdog 单槽位：branch summary 与 compaction 真并发时后者有窄窗无看门狗（9efce5abd）。
### 窗口内已修备案
- 8ed6d73bc 的 mkdir 搬进循环 $REPORT 未绑定（4612e8953 已修）。

## 洗清的面（零高危中危）
09-12 修复（12 不变量全在）/ digest 排序 / 压缩计价 / 队列优先级 / CI 发布闸 / 定价功能 / 昨天性能批（对卡顿无一构成新阻塞）。

## 补充环审查（daemon-reliability 终报）
- 候选2【低】daemon-supervisor.ts:7426 attach validation 等待环：同 generation 的 begin 分支直接置 undefined 不结算旧 promise ⇒ 等待者挂起至 24h 档。
- 候选3【低】resumeDeferredWorkerRecovery 每 5s 真定时器空转（不饿死，只贫转）。
- 触发路径二（topbar-scan 实锤）：_pumpSessionInputs 的 deferred 错误路径（agent-session.ts:9641-9656）对已落盘动作不回滚不置败 ⇒ 永久漏在 committing/running ⇒ unfinishedActionCount 永 ≥1 ⇒ **活会话无需 teardown 也会在此后任何 waitForIdle 调用上自旋**（慢性病，人人有份）。
- 修复四候选：a) 落穿分支加 setImmediate 宏任务让出（保险丝）；b) dispose 窗口禁入 waitForIdle 族；c) deferred 路径已落盘动作显式置 failed；d) supervisor 超时连击 N 次强杀+广播死因。

## 舰队事故（本会话教训）
- 3 席真死（stopReason=toolUse 后回合戛止、文本断半句）：sub-82df0ec6、sub-8a5ca4b5、sub-e4d0816e。均 K3-max。死因未定位，疑似下一会话请求未发出。
- 2 席假完工（collect 说 done 但实际还在 streaming）：audit-switch-path、audit-regression-diff——先 observe 再判救了一次误重派。
