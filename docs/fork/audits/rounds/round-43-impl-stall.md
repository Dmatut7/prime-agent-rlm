# r43 impl: stall 竞窗修复 —— turn-liveness 采样倒挂（判决钟先于事实钟）

冻结 SHA：6b9f828fd（主仓 HEAD）。工作树：/tmp/audit_r/round-43/wt-stall（detached @ 6b9f828fd，node_modules → 主仓 symlink）。
诊断输入：/tmp/audit_r/round-43/k3-stall-flake.md（K3 席）＋ 母席追加的 CI 第二红（"defers the abort" 期望 stall_abort 空却收到事件）。

## 改动（1 处源码 + 1 条红转绿测试 + changelog fragment）

**src/core/turn-liveness.ts `sample()`：两行对调 + 注释**（K3 推荐方案，原样落地）：
`const at = now()` 从 `options.kernel()` 之前挪到之后。判决时刻从"事实读取之前"改为"事实读完之后"：
- 生产路径不受影响：`recordHeartbeatFrame`（repl-manager.ts:725）在帧到达时盖 `receivedAt`，本来就先于采样，对调只把 `at` 推后了 kernel() 调用的时长（微秒级），`rawAgeMs` 只会更非负。
- `rawAgeMs < 0 → stale` 的 fail-closed 规则原样保留且仍可达（真墙钟回拨照旧触发）。
- 其余 `at` 消费点（revival 龄、degraded 龄/deadline、hostRequest 龄）锚点语义均严格更正确（as-of 事实读完）。

**test/turn-liveness.test.ts 新增 "reads the verdict clock after the kernel facts, not before (r43)"**：
- 红证夹具：注入单调抖动钟（每次读 +1ms，判决钟与事实钟同源），事实源在 `kernel()` 回调内盖 `receivedAt`——改前 `at` 恒早于 `receivedAt` 1ms，`rawAgeMs=-1`，fail-closed stale。改前实测红：`expected 'stale' to be 'fresh'`（37 测中 36 绿 1 红，恰为新测试）。
- 正控（同测内）：无抖动钟（两次读同值，读序不可观测）+ 完整字面量 `toEqual` 钉死全部字段（vouched/reasons/progress/kernelReasons/state/degraded/movementToken/protocol/livenessAgeMs:0/liveBashHandles/kernelPid/rejectedFrames/hostRequestCount）+ 事件流为空——读序修复对无抖动行为零改变，任何字段漂移即红。

**packages/coding-agent/.changes/r43-liveness-clock-order.md**：changelog fragment 一条。

## "defers the abort" 第二红 —— 同一根因，一并消灭

机制与 K3 诊断的 ordinary-threshold 红完全同源：`workingKernelFacts()`（ma-p0-1:51-55）在事实回调内盖 `receivedAt=Date.now()`；倒挂下跨 1ms 边界 → stale → `vouched=false` → 30min 豁免预算丢失 → 普通阈值 0.1s 处 abort → `stall_abort` 事件 → :153 断言红。修复后 `rawAgeMs≥0`（微秒级），恒 fresh，豁免恒在。未改该测试文件任何一行——按母席指令以"整个文件连跑 5 遍"验证而非改断言。

## 验证（全部在修复后工作树，unset 泄露变量 RLM_*/PRIME_AGENT_*/PI_*，node 直调 vitest）

| 步骤 | 结果 |
|---|---|
| 红测改前（turn-liveness.test.ts） | 36 绿 / 1 红（新测试，'stale'≠'fresh'）——红证成立 |
| 修复后 turn-liveness.test.ts | 37/37 绿 |
| ma-p0-1-long-cell-survives.test.ts 全文件 | 连跑 5 遍 9/9 绿（第 6 遍 pipefail 复核 exit=0，含 "defers the abort" 1100ms 绿、"still aborts at the ordinary threshold" 绿） |
| turn-liveness-degraded-closure + stall-watchdog-tool-liveness | 20/20 绿（K3 口径 56/56 = 36+7+13，本轮 57 = 37+7+13，新增 1 为红转绿测试） |
| `npm run check`（biome+tsgo+installer+browser-smoke+ci-honesty） | exit 0 |
| pre-commit hook | 同款 `npm run check`，通过后提交 |
| pristine-tree 复核 | `git archive HEAD` 解包 + symlink node_modules + `npx tsgo --noEmit` → EXIT=0（0 行输出） |

## 结论

- 倒挂是聚合器接缝的结构性地雷，修在读序（判决 as-of 事实读完之后），不为迁就测试改分类器互斥分支（stale 只报 heartbeat_stale 在生产语义下可辩护，K3 裁决维持）。
- 分类器、fail-closed 规则、预算/tier 算术、协议形状：零改动。
- 提交（点名 3 文件，无 --no-verify，无 amend）：`122ed6f54`（工作树 /tmp/audit_r/round-43/wt-stall，detached @ 6b9f828fd）

## 执行纪律备注

- 工作树是全新 checkout，husky 的 `.husky/_` 生成物不在其中 ⇒ pre-commit hook 实际未安装未运行；等价把关以提交前手动 `npm run check`（biome --write+tsgo+installer+browser-smoke+ci-honesty，exit 0）+ 提交后 pristine-tree tsgo（exit 0）+ 提交后全量重跑 turn-liveness 37/37 完成。biome --write 重排了新测试的 arrow 链（纯格式，语义零变化），提交的是重排后版本，提交后再跑仍 37/37。
- 测试全部 unset RLM_*/PRIME_AGENT_*/PI_* 泄露变量，node 直调 `node_modules/vitest/vitest.mjs --run`，单命令均 <60s（ma-p0-1 ×5 走后台 handle 轮询）。
- 未触碰主仓（只读）；未跑 doctor --fix / daemon ps -k；未 amend。
