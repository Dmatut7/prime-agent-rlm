# r42 簇A 实施报告：XA-1/XA-7 typed 契约 + XA-2 defer 有界性（方案 xa12-retry-defer-plan.md v2）

- 冻结基线：`a5456df68`（含 TC 时钟基）。工作树 `/tmp/audit_r/round-42/wt-a`（detached，node_modules 软链真仓），真仓零写入。
- 交付提交（工作树 HEAD）：`e8fbe952b`（主实施，16 文件，+1053/−138）＋ `73da24bde`（A6 写放大护栏补钉）。分支无推送。

## 实施内容（按方案推荐顺序，单车道独占 cron-jobs.ts）

1. **② A2 typed 契约 + D1a**：`prompt-admission.ts` 新增抽象基类 `SessionInputRefusedBeforeDeliveryError{deliveredNothing: true; retryNowSucceeds: boolean}`，三类 refusal 全部 extends；`retryable` 字段更名 `retryNowSucceeds`（构造签名不变，`retryable=` 消息 token 逐字保留并文档注明其序列化的是 retryNowSucceeds）；`isRetryableSessionInputRefusal` 删除，唯一 typed 谓词 `isSessionInputRefusedBeforeDelivery`，3 调用点（cron-jobs queueDispatch、daemon-mode×2）同提交改齐；D1a：`acquireSessionInputPause({forUpdateRestart})`（Set→Map），仅 `abortForUpdateRestart` 的 lease 传旗标，其 Paused 报 `retryNowSucceeds=false` 并追加 restart 句（历史子串不动）。
2. **③ E2 字符串兜底**：`classifyAgentMessageSendFailureByMessage(msg): {deliveredNothing; retryNowSucceeds|undefined}` 取代 `isRetryableAgentMessageSendError`（删除，grep=0）；七式老真集全保留为 (a)；(b) 只在可解码处答（Suspended 的 `retryable=` token/栅栏句、Paused teardown 句、Coalescing 恒 true），其余 undefined（不猜）。三消费点分工：`rememberFailure` 只读 (a)；广播 uncertain 只读 (a)；M6b 三连计数读 (a)、终局文案读 (b)（`formatAgentMessageRetryExhaustedError` 增 fenced 分支，通用文案逐字不变）。
3. **④ B1+C2**：`AgentCronJob` 增可选 `lastDeferredAt/deferCount/deferredSince`（`isAgentCronJob` 存在时类型校验＋`sanitizeDeferralFields` 坏值按缺省、不丢整条记录）；deferred 分支不再写 `lastSkippedAt`；cadence= f(tier, deferCount)：transient 5s×3→翻倍→300s 封顶，fence 30s 起步同退避；升级（deferCount≥20 或串龄≥15min）写 `lastError="Deferred N times since …; admission window has not released"` 并切 1h 重查，**job 恒 active、once 绝不因 defer completed**；ran/skipped 清零链。C2：daemon-mode `runCronJob` 两处 refusal catch 删除（unrunnableAtAdmission→skipped 保留），refusal 上抛至 queueDispatch——`"deferred"` 生产产出点全仓唯一。`formatAgentCronJob` 增 `deferred=<ts> defers=<n>`。时钟基复用 TC（StepCompensatedClock/schedulerNowMs/unref 均在冻结基线内，本实施零重复）。

## 方案外发现（红测打出的缺口，已修并披露）

- **runDue 后置重臂缺失**：once job 被 claim 后 `nextRunAt` 被摘除，而原 runDue 的 `finally` 在 dispatch 结果落账**之前**重臂——timer 路径下 deferred once 的 5s 重试写入 nextRunAt 后无臂可走，重试永不触发（A9 红测在 HEAD 上正是因此红）。修法：`runDue` 在 `Promise.all` settle 后再 `scheduleNext()`（幂等，读全库最小 nextRunAt）。这是 A9「真实 5s 后照跑」护栏的必要条件，方案书未列，非自创修法（护栏字面要求）。

## 护栏执行（§5 全量）

- **红测先行**：两新测试文件 19 用例在未改动实现上 17 红 2 绿（红日志 `/tmp/audit_r/round-42/red-run1.log`；2 绿=A5 过宽反控＋通用文案正控，与方案一致）。
- **A1-A9**（`test/r41-xa-cron-refusal-accounting.test.ts`，9 用例全绿）：A once+栅栏→deferred@30s/runCount0/lastDeferredAt；D 挂起→5s；C recurring→不记 run/error；B 正控 5s 存活；过宽反控普通 Error→ran；A6 cadence 序列 [5,5,5,10,20,40,80,160,300,300]＋deferCount＋age 档升级（once@11 次）＋count 档升级（recurring@20 次）＋**写次数≤N+1**（公共 API 子类化 CountingStore 计数）；A7 栅栏首 defer=30s；A8 ran 清零重来；A9 defer 写后墙钟回拨 30min→真实 5s 照跑（step 补偿＋后置重臂）。
- **B10-B14**（`test/r41-xa-message-failure-classifier.test.ts`，11 用例全绿）：栅栏 (true,false)/挂起 (true,true)/裸前缀+retryable=false token→(true,false)；老真集 deliveredNothing 全 true（等价正控）；unanswered 形状 (b)=undefined；M6b 栅栏三连→fenced 终局文案（含 restart 引导；HEAD 上实证为通用文案）；D1a teardown Paused (true,false)+restart 句；四类 refusal 后同 id 重发都达 delivery leg（id 账等价正控）。
- **C15 grep**：`isRetryableSessionInputRefusal`=0、`isRetryableAgentMessageSendError`=0；(a) 答者恰两个（typed 谓词＋字符串分类器）；(b) 答者唯一 `retryNowSucceeds`。
- **D16 回归**：20 个测试文件 502 passed | 8 skipped（cron 全家、corrupt-store、wallclock、clock-rollback(TC)、daemon-mode、daemon-mode-supervisor-probe、daemon-supervisor-process、r40-k3q3、r39-qp、agent-message 全家、f1、fixq3、agent-session-queue、4527/4657）＋宽面 15 文件 410/411。`npm run check` EXIT=0；pristine-tree（`git archive HEAD`＋软链 node_modules）`npx tsgo --noEmit` EXIT=0。
- **既有红（非本线）**：`agent-session-recursion.test.ts > loads the ephemeral RLM harness path into the host system prompt` 在纯净冻结 HEAD `a5456df68` 上同样红（本机 harness 状态相关），已实证与本改动无关。
- 测试全程 `env -u RLM_* -u PRIME_AGENT_*` 泄露清洗；`bash()` 句柄驱动、无 `doctor --fix`/`daemon ps -k`。

## 跟随规格迁移的既有断言（命题不弱化，全部披露）

- r39-qp:221/248/310、queued-receipt:169/174、f1:180/153、agent-session-queue:1798、fixq3:109：`retryable`→`retryNowSucceeds` 机械改名；D1a 三处 teardown 窗口（r39-qp:227、f1:126、fixq3）随契约改写为 `retryNowSucceeds===false`＋restart 句断言（「拒绝而非 queue-and-lose＋重启后可重发」命题保留）。
- r40-k3q3：deferred 戳 `lastSkippedAt`→`lastDeferredAt`（ran/skip 路径的 lastSkippedAt 断言不动——busy-skip 语义未变，daemon-supervisor-process 的 lastSkippedAt 断言实测不受影响）。
- bounded-wait/duplicate-window/queued-receipt 的 `isRetryableAgentMessageSendError` 断言迁移至分类器 (a)（老真集⊆新 (a) 集）。

## 对方案字面的一处解释性偏差（非行为偏差）

- §5 A6 序列写 `[5s×3,10,20,40,80,160,320,300…]`——320 已超 300s 封顶，按「翻倍退避至 300s 封顶」语义实现为 …160,**300**,300…（320 为未封顶的原值）；测试按实现序列断言。

## 相邻缺口登记（本方案面外，下轮）

① skipped 把 once 置 completed 的更新窗口变体；② claim 后进程死亡→`recoverInterruptedDispatches` 判 completed+"Interrupted"；③ coalesce 路径 promptResult.admitted:false 走 skipped 非 deferred；④ XA-3 wire 信任闸。
