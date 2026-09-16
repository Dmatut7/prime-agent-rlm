# r30 · 协议版本链 28→36 兼容矩阵（protocol-chain）

- 冻结：HEAD `b7f26e98b`（只读取证，仓库零写入；工作树仅他人遗留 3 个未跟踪 png/txt）
- 窗口：`0ec081a26`(rev28, 09-11) → `7aa03c9e7`(rev36, 09-16 01:06)，8 个号、13 个涉及提交
- 方法：git 逐 commit 取 `DAEMON_SCHEMA_REVISION/DAEMON_SCHEMA_ID`、逐 rev diff 协议文件、测试文件逐个点名、compat 两表按文本块抽取比对、decisions.jsonl（250 条）去重；跑过 1 个测试做正控
- 命令均 ≤60s；未跑任何 shutdown/doctor/ps 变体；测试 unset 泄露 env；vitest 直接 node 调

## 0. 版本链实测（每 commit 的 ID 与 digest 动没动）

| rev | commit | 日期(+0800) | DAEMON_SCHEMA_ID | digest 动 | wire 变更分类 |
|---|---|---|---|---|---|
| 27(基线) | 8901d21c1 | 09-05 | protocol-7-schema-27-589a2219bc8b | — | — |
| 28 | 0ec081a26 | 09-11 18:09 | protocol-7-schema-28-66299858b8b4 | **动** | 新能力 rlm_child_stall_activity + 4 个可选字段(daemon_hello.adopting/degraded、snapshot_failed.reason/purpose) |
| 29 | 5f7354426 | 09-11 19:19 | protocol-7-schema-29-66299858b8b4 | 不动 | 可选 retryAfterMs（response 面） |
| 29 | 59a924082 | 09-13 05:42 | protocol-7-schema-29-66299858b8b4 | 不动 | 读侧 64MB 行界 + 丢未知 capability（行为界，非形状） |
| 30 | 1b7cc8468 | 09-15 01:56 | protocol-7-schema-30-66299858b8b4 | 不动 | 新能力 streaming_delta_fragments |
| 30 | 55bae7c50 | 09-15 16:50 | protocol-7-schema-30-66299858b8b4 | **不动（F1）** | **快照树改有界 + 新 stats 上 wire，号也没升** |
| 31 | a5edee5ee | 09-15 17:39 | protocol-7-schema-31-66299858b8b4 | 不动 | 可选 scan / retainedFromDepth / leafIncluded |
| 32 | bf86e7fdf | 09-15 19:25 | protocol-7-schema-32-031a9f304364 | 动 | digest-only（treeWire 入哈希）+ SESSION_TREE_MAX_WIRE_NODES |
| 33 | 00fff2fe8 | 09-15 21:24 | protocol-7-schema-33-f3a2737855c2 | 动 | digest-only（stall 族入哈希）+ K3X-1 渲染防卫 |
| 34 | 476202349 | 09-15 22:04 | protocol-7-schema-34-3c415362acce | 动 | maxNodes 等诚实字段（session-manager 面） |
| 35 | 7409359a6 | 09-15 23:36 | protocol-7-schema-35-5100d7bec2ea | 动 | digest-only（X-6/X-11 包装装配层入哈希） |
| 35 | 7a931c383 | 09-16 00:04 | protocol-7-schema-35-0632e2e54e98 | 动 | **同一号第二 claim（F2）** |
| 36 | 34589648d | 09-16 00:08 | protocol-7-schema-36-ba0805ab003a | 动 | 合并解冲突升 36 + quiescence 族入哈希（K3Q-1） |
| 36 | 7aa03c9e7 | 09-16 01:06 | protocol-7-schema-36-ba0805ab003a | 不动 | 无 wire（K3R 行为/print 面；agent-session.ts 改动避开哈希切片） |

关键事实：rev29→31 三个号连跳期间 digest 后缀恒为 `66299858b8b4`（号是唯一身份信号）；digest 从 rev32 才开始随 wire 移动。"一晚连跳" 实为 09-15 16:50→09-16 00:08 约 7.3 小时内 31→36 六跳。

## 1. ① 双向测试矩阵（rev × 方向 × 测试点名）

方向 A＝新客户端×旧 daemon（降级面）；方向 B＝旧客户端×新 daemon（容忍面）。
判据：能在测试名级别指认=✓；只在同版本测生产侧=△；找不到=✗。

| rev | A：新客户端×旧 daemon | B：旧客户端×新 daemon |
|---|---|---|
| 28 | ✓ `daemon-agent-connection-stall-events.test.ts`："downgrades stalled activity and drops stall facts for a server without the capability"、"leaves non-stall activity alone when the capability is missing"、spy 正控 "exposes the capability gate as a spy-observable check"；未知事件面 "passes a stall_unsettled session event through without throwing" | △ 生产侧 `daemon-supervisor-startup-adoption.test.ts`(adopting/degraded 发出) 为同版本；旧客户端对 adopting/degraded/stall 字段的容忍无版本化测试（理由：digest 硬闸使混合对不可能出现；字段全可选） |
| 29 | ✓ `daemon-client-transient-retry.test.ts`："returns a failure immediately when it carries no retry hint"（旧 daemon 无 hint）+ `daemon-supervisor-transient-hint.test.ts` | ✗ 无"旧客户端遇到带 retryAfterMs 的失败响应"测试（加性可选，注释宣称"client that does not know the field keeps failing immediately"，无测试钉住） |
| 30 | ✓ `compact-session-stream.test.ts`："only drops the arguments snapshot when the consumer declares streaming_delta_fragments"（消费者未声明→生产者退回 snapshot） | △ 客户端声明面钉在 `agent-connection-daemon.test.ts`（attach capabilities 数组含 streaming_delta_fragments）；消费端碎片累积在同文件 DTO 层；无进程级旧客户端对测 |
| 31 | △ 仅同版本生产侧 `session-tree-wire-bounds.test.ts`（"reports what the flat tree bound left out..." 等 11 例）；混合对保护=号差（31≠30）触发硬闸 | △ 同左；无旧客户端对可选字段的容忍测试 |
| 32 | ✓（digest 本身）`daemon-protocol.test.ts`："keeps the advertised schema identity synchronized with wire type shapes"（重算 digest 钉 ID，本次实跑 1 passed）+ 截断面 `session-tree-wire-bounds.test.ts`："bounds the total node count of a wide tree, not only its depth" | △ 同上：混合对由 digest 硬闸挡（X-5 已记：忙 daemon 抛错） |
| 33 | ✓ `stall-diagnostics-render.test.ts`（K3X-1）："renders an event without a diagnostics payload instead of crashing"、"marks a missing busy segment unknown while the rest still renders"——真·旧 daemon 事件形状 | △ digest 硬闸 |
| 34 | △ `session-tree-wire-bounds.test.ts`："keeps the rewound live leaf inside both the flat and the nested bound" 等同版本；混合=硬闸 | △ |
| 35 | ✓ `daemon-protocol.test.ts`："counts wrapper, contract and assembly shape edits as identity changes"（6 个变异含 rev32 起已覆盖族的正控） | △ digest 硬闸 |
| 36 | △ `print-rlm-quiescence-timeout.test.ts`（字段在的 give-up 面）+ `suite/regressions/k3r-promote-failure.test.ts`（rlmQuiescence:{settled:false,timedOut:true}）；**注释宣称的降级面**（"an old daemon advertising the barrier but not the field degrades to the pre-fix behavior"）**无测试** | ✗ 无 |

矩阵结论：A 向（客户端降级）在 28/29/30/33 有真用例，36 缺其注释自宣的降级用例；B 向（旧客户端容忍）全线无版本化测试，仓的立场是"digest 硬闸使 B 向不可能发生"——该立场成立的前提正是每次 wire 变更 digest/号必动，而 F1 证明过一次没动。

## 2. ② 能力门控与两张兼容表

- **DAEMON_OUTBOUND_COMPATIBILITY（daemon-protocol.ts:1522-1545）与 DAEMON_COMMAND_COMPATIBILITY（:987-1095）在 8901d21c1→HEAD 全程零变更**（按文本块抽取逐字比对 changed=False）。8 个 rev 里没有一条新表项：stall_unsettled 走 `session_event: LEGACY_DAEMON_COMMAND`（无 capability 门），新能力只进了 capability 联合类型（rev28 rlm_child_stall_activity :213 区、rev30 streaming_delta_fragments :192/:273 区）。
- 门控实际位置：客户端 `DaemonAgentConnection.supportsServerCapability`（有 spy 正控测试）；生产侧 `compact-session-stream` 的 plan()。判定：无一条 rev 28-36 新增了"须查表才可发"的命令/事件，故两表空转是**设计上成立**的空转，不是漏改；但 AGENTS.md 的字面要求（"update the command/event compatibility maps for every wire change"）在 8 连跳里没有一次被字面履行——文本与实践不一致，无 live 缺口。
- 能力协商本身：rev28/30 的能力都进了 `DAEMON_DEFAULT_SERVER_CAPABILITIES`/`DAEMON_SUPPORTED_CLIENT_CAPABILITIES`（daemon-protocol.ts:227+/:273+），协商面无缺口。

## 3. ③ 混合版本实测（git archive 真握手）

- 已做：`git archive 8901d21c1` 抽 rev27 到 `/tmp/r30/old27`（node_modules 符号链接可行），尝试 `./prime-agent.sh daemon start` 起旧 daemon——rev27 的 `daemon` 前缀是 removed command（public-command.ts:rejectRemovedCommand → "Unknown command: daemon start"），daemon 只能经交互启动路径拉起；40 分钟预算内未完成交互路径拼接（TUI 需 tty），**真握手实测记 partial，不据此下负结论**。
- 替代证据链（非进程级但点名可查）：握手判据 `judgeDaemonReuse`（daemon-launch.ts:108-155）单测覆盖旧方向 `daemon-launch.test.ts` "replaces a daemon whose wire schema is stale"（schemaId: "protocol-7-schema-29-older" → replace）；进程级 `probeDaemonVersion` 假 daemon 测试同文件 "treats a daemon built from a different bundle as stale..."；`daemon-liveness.test.ts` classifyReachable "never calls a live service stale, whatever build it answers with"。替换/忙拒路径=X-5（已 note，不重报）。
- 能力降级路径（不是崩而是降级）在 28/29/30/33 有上表 ✓ 用例；36 的降级面无（见 F4）。
- 复现配方（留给下轮，5 分钟内可完成）：`git archive 8901d21c1 | tar -x -C /tmp/old && ln -s $REPO/node_modules /tmp/old/node_modules`，`cd /tmp/old && PRIME_AGENT_CODING_AGENT_DIR=/tmp/agentA ./prime-agent.sh`（交互起 daemon）→ 同 agent dir 用 HEAD `./prime-agent.sh` 交互启动 → 观察 client-errors 日志里 `daemon on .../daemon.sock: running daemon is stale (schema protocol-7-schema-27-... != ...)` + 空闲替换。

## 4. ④ bump 纪律缺口清单（新发现，与 decisions.jsonl 去重后）

### F1 · 55bae7c50 wire 变更骑在同一个 DAEMON_SCHEMA_ID 上（该 bump 没 bump 的实锤）
- 命题：rev30 窗口内，"bound the session tree on the wire"（快照树改有界+新 SessionTreeDepthStats/SessionFlatTreeStats 上 wire）既没升号也没动 digest，父子两 commit 的 ID 逐字相同。
- severity：P3（历史实例；HEAD 已闭合，但它是"digest 闸曾放过一个 wire 变更"的唯一实证）
- file:line：packages/coding-agent/src/modes/daemon/daemon-protocol.ts:179-180（现值）；历史 `55bae7c50` vs `55bae7c50^`
- 逐字证据：`git show 55bae7c50:...daemon-protocol.ts | grep DAEMON_SCHEMA_ID` → `protocol-7-schema-30-66299858b8b4`；`git show 55bae7c50^:...` → 同串。commit 文自述 "snapshot: carry the depth-bounded tree plus its stats, so a truncated tree is..."
- 影响：55bae7c50 daemon × 1b7cc8468 客户端（或反向）握手互认同身份；旧侧收到的是被截断的树+新 stats（旧客户端按完整树消费），语义差比字段差重。50 分钟后 a5edee5ee 才升 31。
- 可复现：上两条 git show 命令（每条 <1s）。
- confidence：高（两条 SHA 直证）。去重：CM-2/X-6 是"类"的通用结论（已 fixed），本条是该类在 09-15 16:50 的具名实例+SHA+时间窗，X-5 只讲替换次数不讲同 ID 混对。

### F2 · rev 35 被两条分支各 claim 一次（第五次撞号，撞号登记纪律未履行）
- 命题：`7409359a6`（merge/repl-kernel 侧，23:36）与 `7a931c383`（r25/k3q-fixes 侧，00:04）都写 `DAEMON_SCHEMA_REVISION = 35`，digest 一个 `5100d7bec2ea` 一个 `0632e2e54e98`；合并 `34589648d` 跳 36 收掉冲突，但头注只给 35 记了一个含义（digest 加宽），k3q 侧的 35 含义被折进 36 的注释，撞号事实未登记。
- severity：P4（无 live wire 风险：digest 仍互斥、混合对仍走硬闸；纯登记纪律）
- file:line：daemon-protocol.ts:81-108（23-27 撞号登记的先例段）；FORK_NOTES.md:305（"下一轮取号前必须先读头注，否则会出现第五次撞号"）
- 逐字证据：两 SHA 的 `DAEMON_SCHEMA_ID` 行（见 §0 表）；`grep -rn '0632e2e54e98'` 全仓（除测试）零命中。
- 影响：未来 sync/考古按注释对号时，"35" 只剩单义；重演 23-27 撞号复盘成本。判据：仓库自己立的规矩（撞号写头注+digest 表）这次没走。
- 可复现：§0 表两行 git show；`git log --oneline -S 'Revision 35 adds the' -- ...daemon-protocol.ts`。
- confidence：高。

### F3 · DaemonResponse 应答信封仍在全部哈希切片之外（CM-2 修后残余面）
- 命题：daemon-protocol.ts 里 `export type DaemonResponse`（:1284，含 success/failure/error/errorInfo/retryAfterMs）不在 15 个哈希切片任何一个区间内（command 切片 [26150,38587)、outbound [57080,61448)、savedSession、treeWire、stall 族、snapshotWrapper、treeAssembly、connection 契约、headless、quiescence），改它 digest 不动；rev29 加 retryAfterMs 时就靠这个洞没动 digest（号动了）。
- severity：P4（残余；修法=把 response 信封区间入哈希切片即可）
- file:line：daemon-protocol.ts:1284-1300；test/daemon-protocol.test.ts readDaemonSchemaSliceSources（切片区间表）
- 逐字证据：文件内偏移实测：DaemonResponse@52914，command 切片止于 38587，outbound 始于 57080；test/daemon-protocol.test.ts:124 `expect(DAEMON_SCHEMA_ID).toBe(...-${digest})` 只重算 15 切片。
- 影响：未来 response 信封加字段（再出一个 retryAfterMs 类）若忘了升号，digest 与测试都不报警；混合对旧握手互认。
- 可复现：对 daemon-protocol.ts 在 `retryAfterMs?: number;` 后加一个 `probeField?: number`，跑 `node ../../node_modules/vitest/dist/cli.js --run test/daemon-protocol.test.ts -t synchronized`（正控：同法改 outbound 切片内任一行即红）。
- confidence：高（切片边界实测 + 本次实跑该测试 1 passed 为基线）。去重：CM-2（fixed）修的是具名响应族；本条指出**通用信封**仍在外，类同但对象不同。

### F4 · rev36 注释自宣的降级路径无测试
- 命题：rev35/36 头注与 K3Q-1 注释宣称 "The field is optional and gated behind the existing rlm_quiescence_barrier capability (an old daemon advertising the barrier but not the field degrades to the pre-fix behavior)"，仓内没有"旧 daemon 声明了 barrier 但响应无 rlmQuiescence 字段"的用例。
- severity：P4
- file:line：daemon-protocol.ts:98-99（rev36 注释）；test/suite/regressions/print-rlm-quiescence-timeout.test.ts（只有字段在场路径）；suite/regressions/k3r-promote-failure.test.ts:105（字段在场）
- 逐字证据：`grep -rln rlmQuiescence packages/coding-agent/test` → 3 文件，均为字段在场或内部 mock，无缺字段降级例。
- 影响：K3Q-1 修的"吞掉 give-up"若在降级分支回归，测试面为 0。
- 可复现：在 print-rlm-quiescence 测试夹具的 wait_for_headless_completion 响应里删掉 rlmQuiescence，断言 print 模式退回旧行为（当前无此断言可删——这就是缺口本身）。
- confidence：高（穷举 rlmQuiescence 测试提及面 + 正控=字段在场用例存在）。

### 信息级（不计缺口）
- 59a924082 骑 rev29：读侧 64MB 行界/丢未知 capability 属行为界非形状，仓自分类成立，不判"该 bump"。
- digest 后缀 66299858b8b4 横跨 28/29/30/31 四个号：号是那窗口唯一身份信号，此事实被 F1 放大过一次。
- K3R-10（rev35 半截注释碎屑）确认已修：`grep -n 'Revision 35 adds'` HEAD 零命中（此前所见碎屑出自 merge diff 侧文本，误读已自纠）。

## 5. 去重对账（vs docs/fork/audits/decisions.jsonl, 250 条）
- X-5（硬闸/替换，note）、X-6（digest 覆盖面，fixed rev35）、CM-1/2/3（fixed）、X-13（fixed）、K3X-1（fixed）、O2/FR-4（fixed）、K3R-2/10（fixed）、PERF-TREE（fixed）——均不重报；F1 是 CM-2/X-6 类的具名历史实例（新 SHA/新时间窗），F2/F3/F4 为本线新命题。
- matrix/两表零变更/版本链全表：本报告首次成表。

## 6. 本次执行的命令（≤60s/条）
- git 系列：log/-S/show/grep（<1s each）；git archive+tar（<2s）
- vitest：`env -u RLM_DEPTH -u RLM_SESSION_DIR -u PRIME_AGENT_BUILD_ID -u PI_API_KEY node ../../node_modules/vitest/dist/cli.js --run test/daemon-protocol.test.ts -t 'synchronized'` → 1 passed（1.6s）
- 真握手尝试：/tmp/r30/old27 spawn 一次（失败即退，无遗留进程；socket 未创建，无需清理）

## 7. 判词
8 连跳的兼容实践总体是"号/digest 硬闸 + 可选字段本地降级"双轨：A 向降级测试在 4 个 rev 有真用例、digest 断言带变异正控是全链最硬的一环；缺口集中在 B 向（全线无版本化测试，靠硬闸立场支撑）与两个"注释自宣无测试"（rev36 降级面）+ 一个历史实锤（F1：硬闸立场曾在 55bae7c50 被自己的 digest 盲区击穿一次）。两表零变更是设计成立但与 AGENTS.md 字面不符。真握手进程级实测未完成，留了 5 分钟配方。
