# 多代理稳定性大修 · 运维手册（2026-09-11）

> 适用范围：`merge/repl-kernel` `10b6b4e55..4b3399eb6`（50 笔，多代理稳定性大修全批次）。
> 入口与背景：`FORK_NOTES.md`「2026-09-11 · 多代理稳定性大修」；新 settings 键文档：`packages/coding-agent/docs/settings.md`；
> 缺口恢复开关档案（切换门禁）：`docs/fork/ma-p0-5c-recover-switch-archive.md`。
> 本手册四节：① 可观测签名清单 ② 回滚开关 ③ 部署日清单 ④ 已知 flaky 与既有红。
> 审查/施工/终审原始材料在 `/tmp/ma_audit/`（不在仓内，重启会消失；关键结论已收进 FORK_NOTES 与本手册）。

日志主战场：**`~/.prime/agent/logs/agent.jsonl`**（每行一条 JSON，sessionLog/kernelLog 都进这里，按 `msg` 字段 grep）；
daemon 面另有 `~/.prime/agent/` 下的 `daemon.sock.*.log` / `supervisor.sock.*.log`。
下文「签名」一律给可直接 `grep -F` 的字面量或事件名。

---

## 一、可观测签名清单（哪条日志意味着什么）

### 1.1 看门狗与豁免（批 1/1c）

| 签名 | 意味着什么 | 正常应该看到什么 | 越界动作 |
|---|---|---|---|
| `stall_warning`（事件） | 回合静默达 warnAfterSeconds（默认 300s）。vouch 生效时警告文案改写为「abort 已缓期 + 剩余预算」，不再承诺一个不会兑现的 900s 死线 | 低频；文案与实际行为一致 | 高频 ⇒ 查该会话是否真有长静默工作；文案若仍承诺死线 ⇒ 批 1c 回退事故 |
| `stall_abort` / `stall_unsettled`（事件） | 自动 abort 发出 / abort 发出后回合未 settle | `stall_unsettled` ≈0 | 非 0 ⇒ 有回合杀不干净，查 agent-loop settle 路径 |
| stall 诊断里的 `kernel.reasons` | abort 时的内核侧证据：`loop_stalled` 仅在心跳 tick 差分证明内核循环冻结时报告；`heartbeat_stale`=心跳线程死或连续拒帧；`no_kernel_facts` 只对协议 ≥4 的内核出现（协议 3 内核不欠心跳，报了是噪声） | 仍发生的 abort 大多带 `[loop_stalled]`；其余 reason 安静 | 出现「外部工作类」reason 却仍被杀 ⇒ 谓词误判，考虑回滚 `stallWatchdog.toolLivenessExemption`；`heartbeat_stale` 频发 ⇒ 查内核心跳线程/混版 |
| silentMs 分布（stall 日志字段） | 误杀治理的总指标 | 从 ~900000（旧一刀切）迁到预算耗尽级（存在档 ~20min / 进展档 ~50min 封顶后） | 无迁移 ⇒ vouch 未生效（查 `PRIME_AGENT_KERNEL_PROTOCOL`、心跳帧、`toolLivenessExemption`）；900s 级 abort 彻底消失且预算耗尽级也没有 ⇒ 怀疑永豁免类回归（终审 A1 形态），立即上报 |
| `Request was aborted.`（19 字符工具结果） | 被砍 cell 的输出被丢成了谜团（旧行为） | **0 条** | 复现 ⇒ 批 1 证据保全（`8a6b8f1f4`）回退事故 |
| `rlm_child_stall_activity`（capability）/ 子代理行 `excused` 旗标 | 被豁免的健康长任务在父侧显示 `long-running 12m` 而非 `stalled 12m`；stall 事实仍随快照流动 | agents view 不再对 vouched 子代理标红 stalled | 健康长任务又显示 stalled ⇒ B9（`9a2828d33`）回退 |
| vouch reason `kernel_finishing_result`（stall 诊断 / 豁免段 reason） | 内核已过 cell 主体、正在做收尾（`repr(value)` / `_drain_output`）：该相位同步阻塞事件循环，故心跳帧照发但 tick 冻结。宿主按「存在档」豁免（~20min 短档，永不升进展档），并且**不再**同时报 `loop_stalled` | 只在超大 repr / 慢收尾的格子上出现；出现时该格不被误杀 | 高频且伴随 abort ⇒ 查该 reason 是否被降级（K-P2-2 回退）；若 `loop_stalled` 与它同时出现 ⇒ 相位判定回归 |
| `rlm_terminal_notice_abandoned`（事件） | 终态通知走了「转录直落 + sidecar 下次启动 reflow」兜底（不再 5 分钟静默丢弃） | ≈0 | 非 0 ⇒ 父泵挂死形态仍在，查该父会话 |

### 1.2 内核（批 0/1c/2）

| 签名 | 意味着什么 | 正常应该看到什么 | 越界动作 |
|---|---|---|---|
| `kernel heartbeat frame rejected`（kernelLog.warn） | 一条畸形心跳帧被拒帧+计数（**不杀内核**，strict JSON/NaN 闸） | ≈0 | 持续非 0 ⇒ 混版或帧 schema 漂移，核对 runtime 与宿主版本 |
| stall 诊断 kernel 段的 `protocol` 字段（3/4） | 混版窗观测：宿主默认请求 4，`PRIME_AGENT_KERNEL_PROTOCOL=3` 可整体回滚；协议 3 的内核没有任何心跳帧（`kernelLiveness` 缺席即旁证） | build+重启后随发布迁移到 4 | 长期滞留 3 ⇒ dist 没刷新 / daemon 没重启 / venv 没换代 |
| `Python kernel exited unexpectedly (code=…, signal=…, origin=…)` | 内核意外死亡归因行：`oom_suspect` 仅当内核 stderr 有内存证据，否则 `unknown`；宿主有意杀（shutdown/kill/dispose/协议修复）**不发**这条 | 低频；origin 与真实死因相符 | 有意杀也出现此签名 ⇒ B6 谓词漏路径，死因账被污染 |
| 复活后首格结果头的 reset notice | 命名空间回滚点、未复活名单、丢失的宿主回话、**副作用不回滚**的明示 | 伴随每次意外死亡出现一次 | 缺失 ⇒ 复活链回归 |
| `restart budget of 3 ... stopped starting replacement kernels`（KernelUnavailableError） | 复活预算耗尽（3 次/1h 滑窗），会话 fail-closed，直到窗口自然过期或 `/reload`。账本挂在 provisioner 上（`KernelRestartLedger`）跨 manager 实例存续，**启动期死亡也计入**：破 venv / `Killed:9` / `PRIME_AGENT_KERNEL_PYTHON` 配错这类「ready 之前就死」的形状第 4 格即 fail-closed，不再每格重生一个必死内核（K-P1-1） | ≈0 | 非 0 ⇒ 读错误里携带的死亡链找 crash-loop 根因；确认是误伤再调 `kernelRestart.*`；只见 `Kernel exited before ready` 反复出现而**从不**见本签名 ⇒ 预算账本又变成实例级了（回退事故） |
| `kernel skill replacement deferred: generation in use`（bootstrapLog.warn，另有同名 UI 进度行） | 本 checkout 的技能内容与该 generation 已装的不同，但有活内核正从该目录跑 ⇒ 按 venv-in-use 不变式**不原地换** editable 安装，本次启动沿用已装那份 | ≈0（同 commit 的多 worktree 内容一致 ⇒ 走「内容指纹相同即满足」，根本不进这条分支） | 持续出现 ⇒ 某车道改了技能 Python 源且与他人共用 generation：等活内核退出后自动补装，或给该车道单独 `PRIME_AGENT_KERNEL_PYTHON` |
| `kernel state restore partial`（sessionLog.error）/ `state snapshot preserved`（info，带未复活名单数） | 部分恢复失败可见化 / preserve_names 合并写生效（快照单调变好） | 低频 | 高频 ⇒ 快照兼容性事故，查 runtime 版本与快照 manifest |
| `Timed out after Ns waiting for the kernel venv bootstrap lock`（KernelBootstrapLockTimeoutError，带持锁 pid） | 300s 锁超时显式失败（旧行为是无界挂到看门狗） | ≈0 | 非 0 ⇒ 惊群或锁泄漏；慢机可调 `kernelBootstrap.lockTimeoutMs`；按持锁 pid 查那个会话在干什么 |
| `venv rebuild deferred: N kernels in use`（KernelVenvRebuildDeferredError，启动显式失败） | 有活引用的 generation 拒绝原地重建（平台无关降级案：新 identity 落新兄弟目录，无 rename 换入） | ≈0 | 出现 ⇒ 该 identity 的目录已陈旧且仍被引用；查引用者 pid 与 identity 来源 |
| venv 换代证据（文件系统）：新 `~/.prime/agent/kernel-venv-<hash12>` 兄弟目录出现；无引用旧代保留 1 份后被 GC（`pruneKernelVenvGenerations`） | build/identity 变化后各会话内核落入新 generation，活内核脚下的目录永不动 | 仅发布窗/build 后 | 平峰换代 ⇒ 查 identity 哈希来源（dist 副本、双 checkout 漂移）。技能就绪判定已改为**路径无关的内容指纹**（`pyproject.toml` + `src/**`，排除 `__pycache__`/`.pyc`/`SKILL.md`），同 commit 多 checkout 共用一份安装且互不翻转；`.bootstrap-version` 里的 `contentHash` 即该指纹（K-P1-2） |
| `kernel venv in-use reference unavailable`（kernelLog.warn，带 reason/tombstoneWritten） | 在用引用写失败 ⇒ 留 tombstone，该 generation 按「引用状态未知=在用」保守处理（F1 修复，宁多保不误删） | ≈0 | 非 0 ⇒ 查目录权限/磁盘；持续出现会让旧代无法回收（磁盘缓涨） |
| `late kernel host reply` | 内核死后迟到的宿主回话被上报（不再静默丢弃），带请求类型与同名子代理是否已注册 | 低频 | 高频 ⇒ abort×宿主请求碰撞率高 |

### 1.3 daemon 生命周期与事件流（批 3/4）

| 签名 | 意味着什么 | 正常应该看到什么 | 越界动作 |
|---|---|---|---|
| `Failed to catch up client ... (catchup retry scheduled, attempt N/40, next in Xms)` | catch-up 失败进入有界重试（250ms→8s cap + 1min jitter，≈5min 预算），不再一次失败永久残缺视图 | 低频，attempt 小数字即恢复 | `attempt 40/40`（exhausted）非 0 ⇒ worker 恢复链断，查对应 worker |
| `event gap detected for <session>: expected sequence <e>, got <g>` | 事件序号缺口检测（**默认 log-only**，只记录不改行为） | log-only 观察窗内 ≈0 | 非 0 ⇒ 逐条对账（`docs/fork/ma-p0-5c-recover-switch-archive.md` gate 2 的对账表），这是切 recover 的门禁输入 |
| `re-pulling the session (streak N)` | recover 档的缺口重拉 | `"log"` 模式下必须 **0 条** | log 模式出现 ⇒ 有人绕过档案改了配置 |
| `event gap recovery circuit OPEN`（带 reason） | 熔断：3 次连续重拉没关上洞、或 10min 内 3 次 ⇒ 该连接余生降回 log-only（换连接/重 attach 重新武装） | 0 条 | 非 0 ⇒ 有真洞重拉关不上，先查洞再谈放宽界 |
| `Worker adoption timed out for ... after 300000ms` | 启动/恢复收养对单 worker 的 300s 有界请求超时（不再被 24h 档扣住） | ≈0；启动日志另列每个没起来的会话+原因+恢复命令 | 非 0 ⇒ 300s 不够，按附录参数表复裁 |
| `Reaped failed worker <id> (reaped failed worker: pid ..., ...)`（归档行，带真实 failure reason） | failed-worker reaper：双证死 + 无 schedule + 无 client，24h 后先归档再删除（failed descriptor 是 OOM 类事故唯一盘上物证） | 低频 | 高频 ⇒ worker 死亡率异常，先查死因再看 reaper |
| `supervisor unhandled rejection (count in the last ...)` | C18 护栏：rejection 被 log-and-isolate + 1h 滑窗计数，supervisor 标记 degraded | ≈0 | 计数增长 ⇒ 腐坏累积，考虑设 `daemon.supervisorRejectionExitThreshold` fail-fast |
| `supervisor exiting after N unhandled rejections` | 阈值 exit 真的触发（仅在设置了阈值时可能） | 0 条（默认阈值为 off） | 出现 ⇒ 事后读 1h 计数窗内的全部 rejection 行 |
| `daemon_hello` 里的 `degraded` / 收养中计数 | supervisor 降级状态与「还有多少 worker 在收养」对外可见 | 无 degraded；收养计数启动后短暂非 0 归零 | degraded 持续 ⇒ 按 reason 计数逐条查（簿记写失败、rejection 等） |
| `deliver message requeued for ... (delivery ..., attempt N, depth D, retry in Xms)` | pending-delivery 队列重投（每 5s 重试、24h deadline、100 条/会话上限；日志有节流） | 低频、attempt 小 | 持续重投 ⇒ 查目标 worker 状态 |
| `deliver queue overflow for ...` | 待投队列满（100/会话），新投递被拒（响亮失败，不静默丢） | 0 条 | 非 0 ⇒ 队列容量复裁；查为什么目标 24h 都不可达 |
| abandoned 回执里的 `undelivered` / `uncertain` | drain 放弃时的诚实回执：从未到达 worker =可重发；已派发 =可能已送达、**警告不要盲目重发**（重发重复由 exactly-once message_id 吸收） | ≈0 | `uncertain` 频发+重复投递投诉 ⇒ 查 sender 是否带 message_id（旧内核不带） |
| `agent message target wait timed out`（带 phase/target/waitedMs） | 四个等待点（passivation 120s / bind / hydrate / publication 各 60s）之一超时，retryable；同目标三连败转终态并指引写文件交付 | 低频 | 采集 waitedMs p95 回填 `agentMessage.targetWaitSeconds`（切换档案见 settings.md 该节） |

### 1.4 测试面

| 签名 | 意味着什么 | 正常应该看到什么 |
|---|---|---|
| `suppressed by test-hygiene-allow: N`（hygiene 门输出） | 带理由的行内豁免在压账（当前登记 23 条既有私有探测） | N 与登记数一致；增长必须逐条有具体理由 |

---

## 二、回滚开关（每个都能独立拉，不必回滚代码）

| 开关 | 拉下后的行为 | 代价 / 注意 |
|---|---|---|
| `stallWatchdog.toolLivenessExemption: false`（settings） | 回到旧语义：900s 静默一刀切 abort，无 vouch 豁免 | 长活儿误杀回归（死亡链①）；警告/诊断不受影响 |
| `PRIME_AGENT_KERNEL_PROTOCOL=3`（宿主 env，spawn 内核时透传） | v4 能力**单点全关**：内核不发心跳、不接 preserve_names；宿主降级只用宿主侧事实（in-flight host requests + journal） | 混版是设计内状态（协商式，C21）：旧内核+新宿主=能力降级、行为等价旧版；preserve 快照退回「部分失败封笔」的 fail-safe 旧行为 |
| `kernelRestart.maxUnexpectedRestarts: 0`（settings，活读） | 复活不限次 | crash-loop 会话会反复 spawn+restore+bootstrap，慎用 |
| `kernelRestart.revivalVouchMaxAgeSeconds: 0`（settings，活读） | 复活窗 vouch 无龄上界 | 重新打开「run(uv) 无超时 ⇒ vouch 无界 ⇒ 静默挂死」形态（红队 B7），仅排障时短用 |
| `agentMessage.targetWaitSeconds: 0`（settings） | 四个等待点回到无界等待（旧行为） | send 卡死重新变成「随调用方请求活多久挂多久」 |
| `subagentWake.policy: "always"`（settings） | 每条排队消息都唤醒挂起泵（P0-3 之前行为） | Esc 不再意味着「停」；失败聚合节流失效 |
| `daemon.eventGapRecovery: "log"`（默认值，即回滚位） | 缺口只记录不重拉；熔断器在 log 档惰性 | 切 `"recover"` 必须走 `ma-p0-5c-recover-switch-archive.md` 的三门禁（7 天窗+零误报对账+发号点复核），换连接即重新武装熔断 |
| `daemon.supervisorRejectionExitThreshold`（默认 off） | off=log-and-isolate（推荐默认形，待老板追认 C18）；设 N=1h 内 N 次 rejection 后 exit(1) | fail-fast 会把整个 daemon 带下去，只在腐坏扩散时开 |
| `daemon.failedWorkerReapEnabled: false` / `failedWorkerReapHours` 调大 | 停 reaper / 延长取证窗 | failed descriptor 堆积（每个都是 OOM 取证物证，占盘可忽略） |
| `kernelBootstrap.lockTimeoutMs: 0`（settings，活读） | 锁等待回到无界（旧行为） | bootstrap 卡死重新变成「挂到看门狗」 |
| `KERNEL_HEARTBEAT_INTERVAL_MS`（内核 env，clamp [100, 600000]） | 调心跳频率 | 调大接近 600s 时注意：abort 可能只看到 1 个样本，`loop_stalled` 判定按设计需要 previous 样本（N1） |
| 代码级回滚 | 每批独立验收、独立可回滚 | 批 0 回滚注意 `BOOTSTRAP_SCHEMA` 需再 +1（触发一次全量重写，安全方向）；**撤 P1-4（快照 preserve）必须连撤 P0-4（自动复活）**——缺 preserve 的复活会触发 restoreFailed 封写 |

---

## 三、部署日清单

> 前置纪律：T0-3（版本化 venv 目录）已落地，`npm run build` + daemon 重启的禁令解除；但 build 会刷新 dist ⇒
> runtime identity 哈希换代 ⇒ **全机 venv 换代**，以下步骤按序做。

1. **磁盘预检**：`df -h ~`。稳态上界 =（1 个当前 identity + N 个仍被引用的 identity）× **~523MB** + ≤1 份无引用保留旧版 + 一次性 legacy 残留 1 份。本机曾到 95%（11Gi 可用）——余量不足先做第 4 步清理；给 venv 重建安排预热线、错峰 boot（避免 523MB×并发数×全局锁惊群）。注意无引用旧代保留数是代码常量（`RETIRED_VENV_RETENTION=1`，venv-in-use.ts），调整属改代码不属拧旋钮。
2. **build + 重启**：根目录 `npm run build`（本 fork 的 `prime-agent` 命令是 dist/bundle/cli.js 的符号链接，build 即刷新已安装命令）→ `prime-agent shutdown` → 重开 `prime-agent`；旧会话 `prime-agent --resume` 或 `prime-agent attach <agent>`。**不重启 daemon 就还是旧 bundle**，协商 protocol 会停在 3（见签名表 1.2）。
3. **`npm run test:kernel` 必跑**（`packages/coding-agent` 目录）：kernel-heavy 用例不在默认 vitest 分片，不跑等于没验收；当前清单 11 文件。**skip ≠ 绿**：这些文件用能力探针（`import rlm.repl, dill`）决定跑不跑，纯净树里要先 `uv run` 生成 `prime-agent-runtime/.venv`（或显式设 `PRIME_AGENT_KERNEL_PYTHON`），探针失败会整文件 skip。
4. **legacy 目录清理（一次性，确认无 pre-T0-3 宿主在跑之后）**：`rm -rf ~/.prime/agent/kernel-venv`（回收 523MB）。注意：11 个 kernel 系测试文件把它当 python fallback（解析序 `PRIME_AGENT_KERNEL_PYTHON` → 仓内 `prime-agent-runtime/.venv` → legacy 目录；清单：ipython-bootstrap、repl-kernel-{bash-interrupt,execute,generation-isolation,heartbeat-live,mcp-reconnect,mcp-shutdown,parent-watchdog,partial-restore-snapshot,shutdown-escalation,state-roundtrip}），清掉后跑这些测试必须先满足前两者之一，否则整文件 skip。硬编码 fallback 的统一整改（改 `activeKernelVenvDir`）仍是遗留项。
5. **净化 env 验收**：所有测试/验收命令 `env -u` 掉 `RLM_*`、`PRIME_AGENT_*`、`PI_*` 泄漏变量（细则见根 `AGENTS.md`「Shared-Worktree Construction Discipline」）。
6. **部署后观察窗（对照第一节签名表）**：协商 protocol 迁移到 4；venv 换代窗内 `bootstrap lock timed out` ≈0；generation 换代与 `venv rebuild deferred` 只出现在发布窗；silentMs 分布开始迁移；`Request was aborted.` 19 字符残留为 0；`daemon_hello` 无持续 degraded。
7. **版本窗对账纪律**：观察窗内任何症状先对「症状末次时间戳 vs fix 提交时间」，防止把旧 bundle 的症状记到新版本头上（跨版本日志坑是本轮审查踩出来的）。

---

## 四、已知 flaky 与既有红（先查这里再怀疑新代码）

### 4.1 负载型 flaky（隔离/复跑即绿）

| 用例 | 形态 | 处置 |
|---|---|---|
| `stall-watchdog.test.ts` 两条 0.2/0.6s 阈值会话级用例 | 实测 0.8~2.3s 随负载波动 | 复跑/隔离跑再定性 |
| `4685-daemon-client-modes > drains accepted RPC prompt` | 118 文件并行下过载红，隔离双树绿 | 同上 |
| `daemon-supervisor-process > restarts an empty supervisor` | 全量并发窗内 socket ENOENT 红，单跑绿（同窗可伴 vitest worker 启动超时） | 同上 |
| `ipython-provisioner.test.ts` 两条 `vi.waitFor` | 1s 预算并行负载下假失败 | 已放宽到 5s（`bbcc003ec`） |
| runtime `test_repl_heartbeat.py` 时序窗 | 重载机器可 flake | 已放宽（`b49556902`） |

### 4.2 既有红（base 树 `10b6b4e55` 复跑同签名，非本轮引入）

| 红项 | 根因 | 状态 |
|---|---|---|
| `4600-supervisor-singleton`（'unwinds real pre-bind...'） | 上游 `3d935f674` 把 cron 迁移降级为 best-effort 但没同步改测试，测试与代码语义脱节 | 待单开小任务裁决（改测试还是修代码） |
| `agent-session-auto-refine-probe` | 净化 env 下必红（`_localHarnessStateDir` called 0） | 修法=测试自己净化或构造期不跑探针；未排 |
| `git-context`（ssh remote 原样保留） | 本机 git url 重写配置的环境依赖 | 环境项，不修 |
| `packages/ai` 6 条 Ollama E2E（context-overflow/stream） | 需本地 ollama 服务 | 环境项，不修 |

### 4.3 取证污染注意

- 测试 stderr 会写入与生产**同名**的 `.log`：过滤口径 = 栈路径 `dist/bundle` vs `src` + 夹具 socket 名。
- real-process 用例即使净化 env 也会在真实 `~/.prime/agent` 落 `daemon.sock.*.log`、`supervisor.sock.*.log`、session-leases（只增不改）；做盘上取证 diff 时先跑一遍空基线。

---

## 五、常用命令速查

```bash
# 签名检索（结构化主日志）
grep -F 'Python kernel exited unexpectedly' ~/.prime/agent/logs/agent.jsonl | tail -5
grep -F 'event gap detected' ~/.prime/agent/logs/agent.jsonl | wc -l
grep -F 'supervisor unhandled rejection' ~/.prime/agent/daemon.sock.*.log

# 纯净树复验（提交后纪律）
git archive HEAD | tar -x -C /tmp/pure-tree && cd /tmp/pure-tree
ln -s /path/to/repo/node_modules node_modules   # 各包 node_modules 同理
npx tsgo --noEmit; echo EXIT=$?

# kernel-heavy 验收（先备 python 环境，见部署日清单第 3 步）
cd packages/coding-agent && npm run test:kernel

# 净化 env 跑套件（示例；完整变量清单见 AGENTS.md）
env -u RLM_DEPTH -u RLM_MAX_DEPTH -u RLM_SESSION_DIR -u PRIME_AGENT_KERNEL_OWNER_PID \
  npx tsx ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts
```
