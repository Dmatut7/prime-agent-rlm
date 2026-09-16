# round-39 impl-tails：四条尾巴清偿（r33 TUI-3 / r35 RT-6 / r37 K3G-4 / r38 LIFE-4）

- 冻结 SHA＝主仓 HEAD `e8f6527dc44a548d961cdf336bd514bcafa24fa7`；独立工作树 `/tmp/audit_r/round-39/wt`（detached，symlink 根 node_modules），主仓零写入、零 push。
- 纪律执行：单命令 ≤60s；测试分批 ≤3 文件；每条先红后绿（红输出逐字留档于本报告）；vitest 用 node 直调 `node ../../node_modules/vitest/dist/cli.js --run …`，跑前 `env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_SUBAGENT -u PRIME_AGENT_KERNEL_PYTHON`；tui 包用自带 `node --test --import tsx`；未碰 `doctor --fix` / `daemon ps -k`；git add 逐文件加并核对 staged 与清单一致。

## ① TUI-3（r33 tui-render-internal.md · FR-3）粘贴每字符过滤 → 循环+单写

- 改动：`packages/tui/src/components/editor.ts` —— `handlePaste` 的 `cleanText.split("").filter(...).join("")`（8M 粘贴＝8M 元素数组×2）替换为模块级 `filterPasteControlChars(text)`：先扫首个需丢弃的控制字节（无则原串零拷贝返回），再按保留 run 切片一次拼接。过滤语义逐字节等价（保留 `\n` 与 `charCode>=32`），其余 handlePaste 全链路不动。
- 红测（改前，`node --test --import tsx test/editor-paste-filter.test.ts`）：`not ok 3 - does not freeze the editor on an 8MB paste … 8MB paste froze the editor for 150.8ms (>100ms)`（r33 基准 157ms 复现）；分配断言（≤64MB）因时间断言先炸未触发（r33 实测 heapUsed +217MB 为红侧依据）。
- 绿测：3/3 过（8MB 冻结 ≤100ms＋瞬时分配 ≤64MB 双断言；控制字节丢弃；换行保留）。
- 提交：`f04078fa8 fix(tui): filter pasted control characters in one pass`。

## ② RT-6（r35 r35-heartbeat-goal.md · H-1/H-2/H-3）

### H-1 节流 1s vs `3×interval` 的 <334ms 误判窗 —— 抬阈值对齐（不降节流）
- 改动：`turn-liveness.ts` 新增导出 `KERNEL_LIVENESS_MIN_SAMPLE_GAP_MS = 1_000`（单一事实源）；`kernelVouchedAlive` 陈旧阈值改 `staleAfterMs = max(staleAfterIntervals × intervalMs, gap + intervalMs)`（保留样本的真上界＝gap+interval：帧每 interval 到、隔 gap 才保留）。`repl-manager.ts` 删本地同名常量改 import，并修正 `recordHeartbeatFrame` 注释里"保留样本永远不到 1s 龄"的错误断言。默认 5s interval 阈值 15s 完全不变（3×5000>6000）。
- 红测（改前）：`expected 'stale' to be 'fresh'`（intervalMs=200、age=950ms＝被节流持有的健康样本年龄）；绿测：950→fresh、2000→stale、5s 边界 14999/15001 全过。相邻回归面：stall-watchdog-tool-liveness / turn-liveness-degraded-closure / kernel-heartbeat-liveness 共 31/31 过。
- live 内核实测（r35 的 /tmp 探针）未重跑——阈值改在纯函数层且红绿钉在单测，标注 [live 未做]。

### H-2 `buffered_bytes`/`pipe_pending` 无序子集 → 全量求和
- 改动：`prime-agent-runtime/src/rlm/bash.py` `live_handle_facts`：`handles[:_LIVENESS_PROBE_CAP]` 子集探针改全机队求和；`_buffer.size()` 为 O(1) 持锁记账、FIONREAD 为 µs 级 ioctl，现实机队（几十 handle）成本远低于一个心跳周期；删除失去引用的 `_LIVENESS_PROBE_CAP`，docstring/模块注释如实改口（写明动机：子集成员变化使报数无输出也上升→宿主误读 movement）。`shared.ts` 两字段注释同步改"full-fleet sum/count since r39"。
- 语义红利：宿主 delta 夹零（`Math.max(0, latest-previous)`）＋全量和 ⇒ delta 只能来自真实新输出；handle 死亡使和下降→夹零，不再伪造 movement，r35 H-2 的 fail-open 面关闭。
- 红测（改前，主仓 runtime venv 真解释器、PYTHONPATH 指工作树 src）：`FAIL test_buffered_bytes_is_a_fleet_sum_not_a_subset`（10 handle×10B 期望 100、实报子集和 80）；绿测 3/3（全量和 / pipe_pending 全量计数 / reaped 排除）。新测试文件 `prime-agent-runtime/test/test_r39_impl.py`（纯函数 pytest 风格；venv 无 pytest，用等价 assert 直跑验证，文件本身 pytest 可发现）。

### H-3 `cell_handles` 生产零读者 —— 留有据（评估后不接线、不删）
- 接线评估（负结论）：per-cell 归因**没有健全消费者**——一个 agent turn 跨多个 kernel cell，本 turn 早先 cell 起的 background handle 在当前 cell 计数为 0，per-cell 门会把正当的轮内后台工作误判无活；turn 边界内核侧不可见。fleet 级 `bash.handles` 才是 vouch 的正确粒度。
- 落地：字段保留为诊断上下文，`shared.ts` `bashCellHandles` 注释写明"diagnostic context only, deliberately not wired into the vouch"＋上述理由（对 r35 批评的"文档写成已交付事实"改口）；wire 帧形状不变（`repl.md` 帧文档仍准确，无需改）。
- 红测面：无——选择"留有据"＝零行为变更，测试盲区如实标注（现有 7 个测试文件构造该字段，全数继续通过，即兼容性正控）。

## ③ K3G-4（r37 k3-recheck.md ①残留c ＋ ⑤--force 脚枪）

### 快照失败回执措辞与实际语义相反 → 按实际分档改口
- 改动：`state-snapshot.ts` `snapshotFailureNoticeLines` 第三行：原 "this notice repeats only while writes keep failing"（与实际相反：失败期间 dedup 静默、成功写后才重新武装）→ "fires once per failing episode and re-arms only after a successful write, so it stays quiet while writes keep failing and reports the next failure as a new episode"。flap 重发（残留a）与 compaction 双报（残留b）行为本轮不改，措辞已如实分档。
- 红测（改前）：`expect(joined).not.toContain("this notice repeats only while writes keep failing")` 失败；绿测过（"once"/"re-arm" 语义词钉死）。测试并入 `r35-impl-rt.test.ts`，原 RT-2 dedup 用例全数仍过。

### install.sh --force 解析位置 + 文档
- 改动：`install.sh` main 参数循环在首个非 flag 参数即 break——`install.sh 1.2.3 --force` 静默丢 flag；补全位置扫描 `for remaining_arg in "$@"`（任意位置 --force 都置位；`resolve_prime_agent_version` 只读 $1，后续 --force 对其惰性无害）。README.md 官方安装段补 --force 段落（非交互重装被拒的语义、--force 覆盖、任意位置生效、不绕安装锁）。本仓无 man 页（find 无 *.1/man 目录）——man 侧不适用，文档落 README。
- 红测（改前，函数级沙箱：stub 参数循环之后全部动作、假 node/npm、未配置下载 URL）：`install.sh 1.2.3 --force` → `force=0`；绿测：`force=1`；正控：`--force`→1、`--force 1.2.3`→1、`stable`→0。
- 提交：`ce86f2092 fix(installer): honor --force wherever it appears on the command line`。

## ④ LIFE-4（r38 lifecycle.md · L5）running 无活性对账 —— 读侧最小改动

- 改动：`rlm-subagent-display.ts` 新增 `RLM_SUBAGENT_STALE_AFTER_MS = 6h`＋纯函数 `effectiveRlmSubagentDisplayStatus(entry, lastActivityMs, now)`（只重判 `running`；completed/deleted 是写侧持久事实；转录年龄未知不判）。`daemon-mode.ts` `passiveRlmSubagentEntryForEdge` display 路径对 running 项 stat 转录文件取 mtime（r38 L5 的判据＝sessionFile mtime，display 文件本身只在 spawn/complete/delete 写、其 updatedAt 不能当活性信号），`PassiveRlmSubagentEntry.status` 增 `stale`；读侧不回写文件（写侧所有权不动，对齐 parent 给的"读侧"选项而非 sweep 降级）。
- 消费面如实收敛：`rlmChildRegistryStatus` 摘要字段（agent-messages）不引入新枚举值——该字段语义＝注册表持久状态，会话侧本就把非 completed 渲染为 errored；`stale` 止于 daemon 内部 `PassiveRlmSubagentEntry`（读侧事实，供列表/未来消费，不再把 6h 静默的 running 当 running）。
- 红测（改前）：`TypeError: effectiveRlmSubagentDisplayStatus is not a function`；绿测 3/3（>6h→stale、<6h→running、completed/deleted/未知年龄不重判）。`rlm-subagent-display.test.ts` 9/9、`rlm-ledger.test.ts`＋`rlm-subagent-display-cache-bounds.test.ts` 35/35 过。
- ledger 压缩（L6）：按指示留 note 不做——`rlm-ledger.ts` 未动，本条即 note。

## 验证总账

| 线 | 红（改前，逐字） | 绿（改后） |
|---|---|---|
| TUI-3 | `8MB paste froze the editor for 150.8ms (>100ms)` | 3/3（node --test） |
| RT-6 H-1 | `expected 'stale' to be 'fresh'` | turn-liveness 36/36＋相邻 31/31 |
| RT-6 H-2 | `FAIL … fleet_sum`（80≠100） | 3/3（真 venv 直跑） |
| RT-6 H-3 | （留有据：零行为变更） | 7 个既有构造文件的兼容正控全绿 |
| K3G-4 措辞 | 旧句 `not.toContain` 失败 | r35-impl-rt 全过 |
| K3G-4 --force | `force=0` | `force=1`＋三正控 |
| LIFE-4 | `is not a function` | display 9/9＋ledger 35/35 |

- 类型/格式：`npx tsgo --noEmit` 工作树 EXIT=0（提交后树＝HEAD、零 diff，即 pristine 等价）；`git archive HEAD` 副本＋symlink node_modules 复检 tsgo EXIT=0；biome 对 11 个改动文件 `--write` 后干净。
- 测试批次全部 ≤3 文件、单命令 ≤60s；python 侧 3 断言一组单跑。

## 提交（工作树 /tmp/audit_r/round-39/wt，base＝e8f6527dc，未 push）

1. `f04078fa8 fix(tui): filter pasted control characters in one pass`（editor.ts＋新测＋changelog 片段）
2. `312cd5d2c fix(coding-agent): close the r39 liveness tails`（turn-liveness/repl-manager/shared/state-snapshot/daemon-mode/rlm-subagent-display＋runtime bash.py＋3 测试文件＋片段）
3. `ce86f2092 fix(installer): honor --force wherever it appears on the command line`（install.sh＋README）

未做/边界：H-1 live 内核探针未重跑（纯函数层红绿已钉）；H-3 留字段不接线（理由见上）；K3G-4 的 flap 重发/compaction 双报行为未改（仅措辞如实化）；LIFE-4 未做 sweep 降级与 ledger 压缩（按指示）；install.sh 无 man 页可补。
