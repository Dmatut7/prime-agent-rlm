# r41 终审 · 「修了但没测·实跑抽查」子线报告

- 审范围：`b7f26e98b..HEAD`（HEAD = `eb0825e634b0df63842bfc63c246151efc72ea37`，今夜推送）
- 纯净树：`/tmp/audit_r/round-41/resid-run/wt`（`git archive HEAD | tar -x`，根 + `packages/{agent,ai,coding-agent}` 的 `node_modules` 软链回主仓）
- 主仓 `/Users/a1/Desktop/ai/prime-agent` 全程只读：零 git 写操作、零文件编辑、零 build
- 本线临时物：`/tmp/audit_r/round-41/resid-run/`、`/tmp/audit_r/round-41/resid-run-work/`
- 测试环境纪律：`env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_CHILD_ID -u RLM_SUBAGENT -u RLM_NAME -u RLM_MODEL -u PRIME_AGENT_KERNEL_PYTHON -u PRIME_AGENT_SESSION_DIR -u PI_SESSION_DIR npx tsx ../../node_modules/vitest/dist/cli.js --run test/<file>`
- 冻结 SHA 说明：本线全部实跑以 `eb0825e63`（建树时刻）为准。收口时主仓 HEAD 已推进到 `3a29e212c`，两笔新提交（`887c15b44`、`3a29e212c`）**均为 `docs(audits)` 账本改动，不触碰代码面**，故本报告结论对本窗口仍成立（`git log --oneline eb0825e63..HEAD` 逐字列出）。
- 主仓工作区状态核对（收口时）：`git status --porcelain` 只有三个非本线产生的未跟踪项（`00a_visitor_first_paint.png`、`out.txt`、`visitor_rail_no_group.png`），本线零写入；两个探针文件只存在于 /tmp 纯净树副本内。
- 收口状态：母席 12:2x 下令收口。3 条抽查均已实跑完成（1 条 TS 既有用例 + 探针、1 条 TS cron + 探针、1 条 shell 沙箱端到端）；TC-1/2/3 时钟族为 `status=fixing/commit=null`（不属"声称已修"，见第 4 节，标注未实跑）。

---

## 抽查 1（TS 侧）· r39 QP 队列栅栏族 `da31a6f31`（ledger QP-1/2/3，status=fixed，verified_by "DS r39 队列线+母席独立实测"）

### 1a. 既有测试覆盖：有
命令（纯净树内，未改测试文件）：

    cd /tmp/audit_r/round-41/resid-run/wt/packages/coding-agent && \
      env -u RLM_DEPTH ... npx tsx ../../node_modules/vitest/dist/cli.js --run test/r39-qp.test.ts
    → 写入 /tmp/audit_r/round-41/qp-run.log

关键输出（逐字）：

     ✓ test/r39-qp.test.ts (10 tests) 1299ms
       ✓ r39 QP-1: the update-restart fence survives queue mutation and compaction resumes (3)
         ✓ a manual compact finishing during teardown keeps the fence up (preempted-auto finally) 803ms
      Test Files  1 passed (1)
           Tests  10 passed (10)
     QP_EXIT=0

判定：QP-1/2/3 的**已修声称在本机实跑下成立**（10/10 绿，exit 0），且有真测试覆盖（`packages/coding-agent/test/r39-qp.test.ts`，348 行，本提交自带）。

### 1b. 探针 A（本轮补写，只在 /tmp 纯净树里）：披露残留 #1（prepare→commit 准入窗口）实测为**真**
文件：`/tmp/audit_r/round-41/resid-run/wt/packages/coding-agent/test/r41-probe-a.test.ts`
命令：同上，`--run test/r41-probe-a.test.ts` → `/tmp/audit_r/round-41/probe-a.log`，`PROBEA_EXIT=1`（失败点见 1c，是探针的断言前提被实测推翻，非实现崩溃）

逐字输出：

     A-PREPARE-LEASE: {"prompt_outcome":"PENDING","ms":1502,"isQueuedWorkSuspended":false,"unfinishedActionCount":0}
     A-TEARDOWN-LEASE: {"name":"SessionInputSuspendedError","retryable_field":false,"guard":false,"string_list":true}
     A-PARKED-VARIANT: {"retryable_field":true,"isRetryableSessionInputRefusal":false,"string_list_says_retryable":true}

机理与位置（逐字代码）：
- `packages/coding-agent/src/modes/daemon/daemon-mode.ts:6652`
  `this.updateRestartQueuePauses.set(state.activeSessionId, state.runtime.session.acquireQueuedWorkPause());`
  —— prepare 段只持 **queuedWorkPause（停泵不停准入）**；QP-2 的准入暂停只加在 `agent-session.ts:9693-9694`（`abortForUpdateRestart` 内的 teardown 段）。
- 探针实测：在 `acquireQueuedWorkPause()` 持有期间，一条 `session.prompt(...)` **既不被拒也不交付**（`prompt_outcome:"PENDING"`、`unfinishedActionCount:0`）——即准入是开着的、动作在飞；`impl-qp.md` 残留 #1 记载"manifest 快照到 closeSession 之间到达的消息仍会被收下且不在 manifest 内"，与实测方向一致。
- **未验证（诚实标注）**：我没有真 daemon + 真 `update-restart` 事务端到端跑（需要活 supervisor 与 22 分钟时间盒外的窗口构造），所以"这条在飞消息在重启后确实丢失"这一步是**读码 + 本机进程内探针旁证**，不是端到端复现。复现命令（如需继续）：在本探针上改持 `prepareUpdateRestartCheckpoint` 的 lease 序列并 `closeSession` 后读 manifest。

### 1c. 附带实测到的**契约三方不一致**（typed 字段 vs 字符串清单 vs cron 守卫）——缺陷，且用户可感知
三条"这条拒绝能不能重试"的真相来源互不相同：

1. typed 字段：`src/core/prompt-admission.ts:19`
   `const retryable = options.retryable ?? !options.suspendedForUpdateRestart;`
   → 栅栏变体 `retryable=false`；普通挂起（泵被 Esc 停）变体 `retryable=true`。
2. 字符串清单：`src/core/agent-messages.ts:823-843`，其中 `:827` 一条 pattern
   `/queued session input is suspended/i.test(message) ||`
   而 `prompt-admission.ts:21` 的 message 逐字为
   `` `Cannot admit a session action while queued session input is suspended.` ``
   —— **栅栏变体（字段 retryable=false）与挂起变体（true）共用同一句话**，所以清单对两者一律判可重试。实测：`A-TEARDOWN-LEASE ... "retryable_field":false,"string_list":true`。
3. cron 守卫：`src/core/prompt-admission.ts:89-93`
   `return error instanceof SessionInputAdmissionPausedError || error instanceof SessionInputCoalescingError;`
   —— **不含 `SessionInputSuspendedError`**，连 `retryable=true` 的挂起变体也不认。实测：`A-PARKED-VARIANT "retryable_field":true,"isRetryableSessionInputRefusal":false`。

生产投递路径上谁会读到：
- 清单（2）被 `src/core/agent-messages.ts:1087`（`rememberFailure`）读：`if (isRetryableAgentMessageSendError(message)) return;` —— 判可重试就**不**把 message id 记 `uncertain`。于是栅栏期间被硬拒（`retryable=false`，重试注定失败）的子代理回执，其 id 被当成未花掉、发件侧继续按"可重试"引导重发；这与 typed 字段自相矛盾（`impl-qp.md` 残留 #4 也登记了这条：「字符串清单仍把它判可重试（与 retryable=false 字段矛盾）——预存问题，未动」）。
- cron 守卫（3）被 `src/core/cron-jobs.ts:1312` 与 `daemon-mode.ts:2013`（followUp 支路）、`daemon-mode.ts:2061`（prompt catch 支路）读，后果见抽查 2。
- 正控（证明我的检法能检出"一致"的情形）：`A-PREPARE`/`B-CONTROL` 两条里 `SessionInputAdmissionPausedError`（字段 true、清单命中 `:833`、守卫命中 `:92`）三方一致，cron 正确 deferred（见抽查 2 的 `ran:0`）。所以差异不是工具误差。
- 为什么算缺陷：一个 `boolean retryable` 字段 + 两个不同的字符串清单判定给出三种答案，调用方无法稳定选择；对用户可见面是（a）栅栏期子代理回执被引导无限重试、id 记账口径不一；（b）cron 少认一类可重试拒绝（见下）。

---

## 抽查 2（TS 侧）· r40 cron tick 延迟记账 `1b40c5b3e`（ledger K3Q-3，status=fixed，verified_by "K3 r40 复核（真 AgentCronScheduler 实测）"）

### 2a. 既有测试覆盖：有
命令：`--run test/r40-k3q3-cron-pause-deferred.test.ts` → `/tmp/audit_r/round-41/cron-run.log`

关键输出：

     ✓ test/r40-k3q3-cron-pause-deferred.test.ts (3 tests) 148ms
      Test Files  1 passed (1)
           Tests  3 passed (3)
     CRON_EXIT=0

### 2b. 探针 B：第三条 retryable 拒绝（`SessionInputSuspendedError` 挂起变体）**不在**守卫里 → once 任务被烧掉。声称"defer cron ticks refused by a retryable admission window"在这一类上**不成立**
文件：`/tmp/audit_r/round-41/resid-run/wt/packages/coding-agent/test/r41-probe-b.test.ts`（真 `AgentCronJobStore` + 真 `AgentCronScheduler`，`runJob` 抛真错误类型）
命令：`--run test/r41-probe-b.test.ts` → `/tmp/audit_r/round-41/probe-b.log`，`PROBEB_EXIT=0`（3/3 通过；探针只测量，不断言新行为）

逐字输出：

     B-CONTROL pause:    {"ran":0,"status":"active","runCount":0,"lastSkippedAt":"2026-01-01T12:35:01.000Z","nextRunAt":"2026-01-01T12:35:06.000Z"}
     B-GUARD:   {"name":"SessionInputSuspendedError","retryable_field":true,"isRetryableSessionInputRefusal":false}
     B-MEASURE suspended: {"ran":1,"status":"completed","runCount":1,"lastRunAt":"2026-01-01T12:35:01.000Z","lastError":"Cannot admit a session action while queued session input is suspended. 1 action(s) already queued; retryable=true."}
     B-GUARD fence: {"retryable_field":false,"guard":false}
     B-MEASURE fence:   {"ran":1,"status":"completed","runCount":1,"lastError":"... retrying cannot wake it. 0 action(s) already queued; retryable=false."}

判定：**部分不成立**。`SessionInputAdmissionPausedError`/`SessionInputCoalescingError` 两类（正控 `B-CONTROL`）确实按设计 deferred：`ran:0`、`runCount:0`、无 `lastRunAt`/`lastError`、`lastSkippedAt` 落戳、once 保持 `active` 且 `nextRunAt=+5s`。但**同为 retryable=true 的 `SessionInputSuspendedError` 挂起变体**走 `cron-jobs.ts:1312` 守卫判 false → `queueDispatch` 落 `outcome:"ran"`（`:1325` `error === undefined ? ... : "ran"`）→ `recordDispatchResult` 默认分支（`cron-jobs.ts:897-905`，其中 `:899` `status: job.schedule.kind === "once" ? "completed" : job.status`、`:902` `runCount: job.runCount + 1`）记 `runCount+1`、`lastRunAt` 前进、写 `lastError`，且 **once 任务直接 `status:"completed"`、`nextRunAt` 不再挂**——即 K3Q-3 报告要打穿的"once 撞暂停窗永不执行"在**这一类拒绝上原样保留**。这不是新引入的回归（`impl-k3q3.md` 的「已知边界」一节自己登记了这条），但 ledger 的 K3Q-3 条目写成 `status=fixed` 且未标注范围只覆盖两类，读者会以为整类记账已诚实。
复现命令（纯净树）：

    cd /tmp/audit_r/round-41/resid-run/wt/packages/coding-agent && \
      env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_CHILD_ID -u RLM_SUBAGENT -u RLM_NAME -u RLM_MODEL \
          -u PRIME_AGENT_KERNEL_PYTHON -u PRIME_AGENT_SESSION_DIR -u PI_SESSION_DIR \
      npx tsx ../../node_modules/vitest/dist/cli.js --run test/r41-probe-b.test.ts

（探针文件在 /tmp 纯净树内，主仓未写入；如需长期回归，应把 `B-MEASURE suspended` 那条改成"期望 deferred"的红测并扩 `isRetryableSessionInputRefusal`。）

### 2c. 测试覆盖缺口的负结论 + 正控
- 负：`grep -rln "isRetryableSessionInputRefusal" test/ src/` → 命中只有我这两个探针 + 三个 `src/` 生产文件，**没有任何既有测试**引用该守卫；`grep -rln "prepareUpdateRestartCheckpoint|updateRestartQueuePauses" test/` 只命中 `test/suite/regressions/4257-update-restart-resume.test.ts`（恢复流，不测 prepare 段准入）。
- 正控（证明该 grep 法能命中真实存在的测试）：同一命令风格 `grep -rln "abortForUpdateRestart" test/` → `test/r39-qp.test.ts`、`test/suite/agent-session-queue.test.ts`、`test/suite/agent-session-action-races.test.ts` 等 5 处；`grep -rln "SessionInputSuspendedError" test/` → `test/suite/regressions/f1-agent-message-wakes-suspended-pump.test.ts`、`test/agent-message-queued-receipt.test.ts`。所以"守卫无测试覆盖"是方法可检出的真负结论。

---

## 抽查 3（shell/install 侧）· r36 安装链 `--force` 位置无关 `ce86f2092`（ledger K3G-4 内 "--force 只在领先位置解析且无文档"，status=fixed）+ 顺带 `b69ece1a5` 的锁与拒绝面

### 3a. 是否有测试覆盖：**无（仓内零测试引用）**，正控如下
- 负：`grep -rln "prime_agent_force_install" packages/*/test packages/*/src scripts` → **无输出**（该变量只存在于 `install.sh:116-131`（lead 循环 + `:128-131` 全位置扫描））；`grep -rn -- "--force" packages/coding-agent/test/*.ts` 命中的是 `daemon-ps.test.ts:194/198/251`、`daemon-shutdown-scope.test.ts:73-125` 里的 `shutdown --force`，与安装器无关。
- 正控 1（证明 grep 能命中安装器面的真实现存测试）：`grep -rln "install.sh" packages/*/test packages/*/src scripts` → `packages/coding-agent/test/ipython-bootstrap.test.ts`、`test/kernel-runtime-pinning.test.ts`、`src/core/kernel/bootstrap.ts`、`scripts/check-installer.mjs`。
- 正控 2（证明"无覆盖"不是键名拼错）：`grep -n -- "--force" install.sh` → `118:`、`125-131`、`1650`、`1662`，符号确实存在。
⇒ `install.sh` 的参数解析面在本仓**只能靠外部沙箱实跑取证**，本线照 r36 打法做（假 HOME + 假 npm prefix + 本地 http 源 + 非 tty）。

### 3b. 沙箱实跑（端到端，真 npm 安装/覆盖）
驱动：`/tmp/audit_r/round-41/resid-run-work/force_probe.py`；源包 `www` 复用 `/tmp/audit_r/round-36/insb-work/www`（4 个假版本 + 各自 SHA256SUMS），http 源 `http://127.0.0.1:18377`，`PRIME_AGENT_INSTALLER_ALLOW_INSECURE_TRANSPORT=1`、`PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=0`、`stdin=DEVNULL`。
命令：`cd /tmp/audit_r/round-41/resid-run-work && python3 force_probe.py > force_probe.out 2>&1` → `FORCE_EXIT=0`

逐字输出：

     PASS A-trailing-force :: exit=0 final_version=0.0.4 force_msg=True tail='... Verifying Prime Agent download
       Replacing the existing Prime Agent installation at /tmp/audit_r/round-41/resid-run-work/force-trailing-prefix/lib/node_modules/prime-agent (--force).
       Installing Prime Agent'
     PASS B-leading-force-control :: exit=0 final_version=0.0.4
     PASS C-noforce-refuses        :: exit=1 final_version=0.0.1 refusal=True
     PASS D-force-respects-lock    :: exit=1 tail='error: another prime-agent install appears to be running (lock /tmp/.../force-lock-prefix/.prime-agent-install.lock, held by pid 69804). Wait for it to finish, or remove the lock directory if it is wedged, then re-run this installer.'
     SUMMARY: 4/4 passed
     FORCE_EXIT=0

判定：**已修声称在实跑下成立**。
- A：`install.sh 0.0.4 --force`（flag 在版本**之后**，即 ce86f2092 修的形态）→ exit 0、终态版本 0.0.4、走了 `install.sh:1650` 的 `(--force)` 分支。改前该 flag 被 `:115-117` 的 `*) break` 丢掉（`ce86f2092` 之前只有领先位置生效）。
- B：领先位置 `--force 0.0.4` 照常生效（正控，证明我的旗标判据不是只对外部变量为真）。
- C：无 flag + 非 tty → exit 1、旧安装 0.0.1 **未被改动**、报 `no terminal is available ... Re-run this installer with --force`（`install.sh:1662`）。负路径正控成立。
- D：`--force` **不绕安装锁**（README 承诺一致），锁被活 pid 持有时 exit 1（`install.sh:1617-1618` 的 `lock_deadline` 超时文案）。

### 3c. 该面顺带实测到的 `b69ece1a5` 传输硬化形状（未做完整攻陷链，标 unverified）
本轮未重跑 INSB-1 的"换 EVIL 包 + 同步改 SHA256SUMS"攻陷链（r36 已实测过一次，`/tmp/audit_r/round-36/impl-insb.md`），只核了实现面：`install.sh:65` 定义 `prime_agent_curl_transport_flags="--proto =https --proto-redir =https"`，`:66-68` 在 `PRIME_AGENT_INSTALLER_ALLOW_INSECURE_TRANSPORT=1` 时清空；`:1499` `checksums_base="${PRIME_AGENT_CHECKSUM_BASE_URL:-$prime_agent_base_url}"`（同源默认仍在，注释也明写"this fork publishes no second checksum origin"）。**判定**：与声称一致，但"篡改包能否仍通过校验"这条本轮**未实跑**（unverified，仅沿用 r36 结论）。

---

## 4. 今夜新增里我**没有**实跑的条目（如实登记）
- `TC-1/TC-2/TC-3`（ledger，`status=fixing`、`commit=null`，verified_by "GLM r41 时钟线（fake clock 注入实测）"）：无 commit ⇒ 不属"声称已修"，本轮不做实跑。只做了代码面核对，`Math.max(0, ...)` 钳位与 `TC-1` 描述一致且**仍在 HEAD**：`turn-liveness.ts:302,311,312,313,474`；`stall-watchdog.ts:418,448,455,557,690,726,763,801`（共 13 处，含 `801` 的 `delayMs = Math.max(0, abortAfterMs - (this.timers.now() - this.lastActivityAt))`）。同仓已有单调钟先例：`src/utils/sleep.ts`（`Atomics.wait` 注释："times out on the runtime's own monotonic timer, so a wall-clock change during the wait cannot extend it"）。⇒ 与 TC-1 的"≥6 处 clamp + 已有单调钟先例"表述相符，未跑到"回拨 30 次 fire 无 abort"那一步（unverified）。
- `DO-2`（`status=fixed`、`6b2aa3038`、verified_by "GLM 发现线（md5 + 读码）"）：是历史条目、不在 `b7f26e98b..HEAD` 今夜窗口的代码改动内（仅账本），未跑。
- 其余 `status=fixed` 条目的 `verified_by` 字段虽写作"读码"，但 `b7f26e98b..HEAD` 内的 5 个 fix 提交都自带测试文件（`git show --stat` 逐一核过：da31a6f31 +`test/r39-qp.test.ts`；14a4e8811 +4 测试文件（TS×3、py×1）；1b40c5b3e +`test/r40-k3q3-cron-pause-deferred.test.ts`；b69ece1a5 +`test/kernel-bootstrap-failure-diagnostics.test.ts`；ce86f2092 仅 README+install.sh ⇒ 唯一真"零测试"的修，本线已用沙箱端到端补上）。

## 5. 三条结论一览
1. **r39 QP（da31a6f31）**：有测试覆盖、实跑 10/10 exit 0 ⇒ 声称成立。披露残留 #1（prepare 段只停泵不停准入）本机探针旁证为真（端到端未跑，unverified）；另实测到 typed 字段 / `isRetryableAgentMessageSendError` 清单（`agent-messages.ts:827`）/ cron 守卫（`prompt-admission.ts:89-93`）三方对"可重试"给出不一致答案，`retryable=false` 的栅栏拒绝仍被清单判可重试。
2. **r40 cron（1b40c5b3e）**：有测试覆盖、实跑 3/3 exit 0；但探针 B 实测**第三条 retryable 拒绝（`SessionInputSuspendedError` 挂起变体）绕过 deferred 通道**：`ran=1`、`runCount=1`、`lastError` 写、once `status:"completed"` 永不执行 ⇒ "retryable 拒绝记账诚实"这一声称在该类上**不成立**（属自陈已知边界，但 ledger 写成 fixed 未标范围）。该类**零测试覆盖**（带正控）。
3. **install.sh --force（ce86f2092）**：仓内**零测试覆盖**（带两条正控），本线端到端沙箱 4/4 PASS ⇒ 声称成立；顺带证伪风险为零（无 flag 非 tty 拒装不动旧版；`--force` 不绕安装锁）。
