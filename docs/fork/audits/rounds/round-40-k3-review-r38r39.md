# r40 K3 复核：r38/r39 落地四批"修 A 弄坏 B"专项

- 冻结点：HEAD `c060eb1a1`（四批 = 14a4e8811 L8L9+K3L / c87779e91 LIFE / f04078fa8+312cd5d2c tails / da31a6f31 QP）
- 仓零写入；探针与证据在 /tmp/audit_r/round-40/probe*.{py,mts,ts}
- 绿基线（HEAD 实测全过）：批内测试 17/17（retention-life-reclaim、r39-qp、orphan-journal-foreign-reap）+ 103/103（kernel-python-resolution、compaction-user-requests-child-direction、rlm-ledger-root-teardown、rlm-subagent-display×2、turn-liveness、r35-impl-rt、daemon-agent-roster）+ tui editor-paste-filter 3/3（node --test，注意 tui vitest.config 只 include wrap-ansi）+ runtime test_l8d_impl 5/5、test_r39_impl 5/5。
- decisions.jsonl 去重：无既有条目覆盖 F-3（cron 记账 × QP-2）。

## ① L8D-1 fail-closed × 合法旧快照 —— 无回归，误伤面已实测定量

**打穿输入实测（probe1_l8d1.py + probe1d_selfheal.py，真 `rlm.repl` 子进程，protocol 4）：**
- 正控（manifest 完整带 pythonVersion）：函数+类+数据全部 revived，`helper(1)` 可调用 = 42。✓
- manifest 整丢（torn/missing 形态）：`data` revived；`helper`、`K` 进 failed，原因 "python version unknown..."；`helper` 不可调用（NameError），`sum(data)`=6。fail-closed 语义如设计。✓
- legacy manifest（有 manifest 但无 pythonVersion 字段）：同上隔离。✓
- **自愈链实测成立**：fail-closed 后同路径 preserve_names 重快照 → 新 manifest 带版本 3.12.11、helper blob 被 carried over → 第三次恢复 helper 完整复活可调用。（注意：preserve 跨不同 path 会 "previous snapshot payload could not be read"，真实宿主恒用同一路径，无此问题。）

**误伤面边界**：runtime 自首提交（61eb64748）起就写 pythonVersion，同版本快照只在「manifest 独立丢失/撕毁」或「两次 os.replace 之间 crash（payload 新、manifest 旧/无）」时误伤。后果上限：函数隔离一个恢复周期、数据无损、下一次快照自愈；若会话此后再不快照，则每次 resume 重复隔离（仍可手工补 manifest 救回）。可接受，建议 docs 一行说明。

## ② L9F-1 外来回收 × journal compaction —— 无弄坏

**实测（probe2_l9f1.ts，真模块）**：预填 4094 条死外来 active 记录（贴近 4096 条阈值）+ 1 条活外来（当前进程，正控）+ 1 条 owner 记录（正控）：
- reap=4094 张 tombstone 追加，期间越界触发压缩；活外来记录与 owner 记录全部存活；二次 reap=0（幂等）。✓
- **无"误删"**：压缩对 (ownerPid,pid) 取最新条，tombstone(inactive) 与其 supersede 的旧 active 一起消失＝正是退休语义；后到的 active 永远赢过先到的 tombstone。
- 两个非阻塞观察：(a) 阈值下 2046/4096 对已 supersede 的记录物理滞留（下次越界压缩时清），纯空间账；(b) 活性检查与 tombstone 追加非原子，ms 级窗口内 pid 复用理论上可退休活进程记录——后果是漏回收（外来记录的旧现状），永不误杀。tombstone 风暴 4094 次 fsync ≈ 21s，一次性恢复路径可接受。

## ③ QP-2 准入暂停 × 心跳 tick —— **真发现 F-3（建议修）**

**实测（probe3_qp2_cron.mts，真 AgentCronScheduler+Store，runJob 抛真 SessionInputAdmissionPausedError——正是 daemon-mode.runCronJob 在暂停窗口的行为）：**
- 暂停期 tick：interval 心跳记 `outcome:"ran"`、**runCount+1、lastRunAt 前进、lastError=暂停消息**，不记 skipped（lastSkippedAt=null）。
- **`once` 任务在暂停窗口的 tick 直接 `status:"completed"`，runCount=1，永远不会再跑**（实测）。
- 正控：coalesced→"skipped"（runCount 不动、lastSkippedAt 落）、真跑→runCount+1。G5 记账本身工作正常。

**机理**：`promptHeartbeat→_promptInjectedMessage→_acquireDirectTurnAdmissionFence→_assertSessionActionAdmissionAvailable` 抛类型错误 → runCronJob 的 catch 只把 `unrunnableAtAdmission` 映成 "skipped"，其余重抛 → queueDispatch 记 "ran"+error。QP-2 把**排队路径**（`_admitSessionInput`，busy 会话的 cron followUp）也纳入暂停拒绝——改前该路径在 MCP reload 暂停窗口会排队并在暂停释放后送达；改后 run 被消耗、prompt 永不送达、账面记成"跑过"。QP-3 的 SessionInputCoalescingError 落同一坑。两个错误都带 `retryable:true`，但 cron 调度器不认这个类型契约。
**修法**：runCronJob 捕 SessionInputAdmissionPausedError/SessionInputCoalescingError → return "skipped"（语义正合 retryable＝下一 tick 重试）。严重度：once 任务 P2，interval P3（下一 tick 自愈；lastError 在后续 skip 后仍残留，cosmetic）。

## ④ QP-3 coalesce 票据 × 队列快照逐字节契约 —— 无回归

- coalesce 路径在 enqueue 之前 return：动作从不进 store、`_emitQueueUpdate` 不触发、`_sessionInputArrivalEpoch` 不动；既有测试（r39-qp.test.ts:264）用 JSON.stringify 逐字节正控钉死快照不变。重启 manifest 只捕 store 内动作，不受影响。
- 独立票据立即 settle（coalesced/not_applicable/completed），deferred 自带 catch 不会产生 unhandled rejection；不进 store.tickets，消费者枚举不到它。
- 既有不对称（非本批引入）：coalesce 路径 `_rejectAgentMessage` 文案 "...already pending." 不匹配 isRetryableAgentMessageSendError 的 /already committing/ 模式——语义上或正确（已合并的消息重试会双投），仅记录不对称。

## ⑤ LIFE-2 默认 30 天 × 活子代理保护（r34 裁决①）—— 边界对 ledger 时代成立，实测钉死

**实测（probe5_life2.mts，真 runRetentionSweep，默认设置 childTranscriptDays=30 已验证）：**
- A 有活 ledger edge 的被动子代理（40 天闲置）：**保住**（reference:ledger-live）。✓ r34 裁决①的边界对新注册子代理成立：raw replay 不做 LIFE-1 的文件系统调和，活边永远保护。
- B 已 tombstone：回收。✓（预期）
- D ledger 文件不可读（chmod 000）：reclaimed=0、全部 skip "unverifiable:ledger-scan"——fail-closed 成立。✓（ledger 目录不存在/无 .jsonl 时 readAny=false 同样 fail-closed。）
- **C 无 edge（pre-ledger 或 edge 写失败形态）：被回收**（实测）。30 天闲置+非 resident+非 leased 的无边子代理在新默认下会丢 transcript。ledger 2026-08-14 才上线（97b994c3d）；本机实测 pre-ledger sub-* 目录数=0，暴露面理论存在、本机为空；fleet 侧上限＝"比 ledger 老的子代理"。
- 次级缝隙：scanRlmLedgerDirectory 的 scanned=true 只需**任一** ledger 文件可读；某子代理 edge 所在文件单独读失败时该子代理不受保护（行级 JSON 错不致命，仅文件级 read 错才 skip——罕见）。
- 级联检查通过：有活边的子代理 transcript 永不被回收 → 目录不会变空 → empty-dir 类不会删目录 → LIFE-1 调和不会丢边 → 家族视图稳定，无"回收→空目录→丢边→失联"链。
