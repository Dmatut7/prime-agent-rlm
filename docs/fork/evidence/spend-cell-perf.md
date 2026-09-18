# 花费格「每 60s 扫描 22→6 次 / 660→156ms / p50 快 3.56×」——仓内落点核查与新仪器

对象：`CHANGELOG.md:26`（0.10.0 节，母席记账，本席**未改**）
本席基线：`/tmp/fixL-fixops-evidence`（`$R`）@ `6e1e4e95b`（= 主仓克隆；两侧对照用的改前树 = `0186a1247`）

## 0. 先核「这些数字/仪器在仓里到底有没有」

```bash
$ git grep -n -- "22→6" 6e1e4e95b
CHANGELOG.md:26:- **子代理花费格**：… 性能修复：每 60s 扫描 22→6 次、每分钟挡住事件循环 660→156ms、撞上那一下 p50 快 3.56×，不走缓存的一次性调用方无回归。
$ git grep -n -- "660→156" 6e1e4e95b     # 同上，仅 CHANGELOG.md:26 一处
$ git grep -n -- "156ms"    6e1e4e95b     # 仅 CHANGELOG.md:26 一处
$ git grep -n -- "3.56"     6e1e4e95b     # 仅 CHANGELOG.md:26（其余命中是无关文件里的 0123456789 等子串）
$ ls -d /tmp/spend-perf /tmp/wk2098
ls: /tmp/spend-perf: No such file or directory
ls: /tmp/wk2098: No such file or directory
```

结论（可核）：三条读数**只出现在 CHANGELOG.md:26 这一行**，仓内没有任何性能门/仪器产生它们；
`/tmp/spend-perf/`（v1/v1.1 的补丁与量测件）已被清掉。

仓内**确实存在**的（本席逐条核过）：

- 代码：`packages/coding-agent/src/modes/interactive/interactive-mode.ts:329-345`（`SUBAGENT_SPEND_DEBOUNCE_MS=500`、
  `MIN_INTERVAL=5000`、`HEAVY_SCAN_MS=100`、`HEAVY_INTERVAL=15000`、`SUBAGENT_SPEND_IDLE_TICK_MS=15000`）、
  `:6373-6414`（schedule）、`:6435-6456`（sync）、`:6483-6502`（idle tick）、`:6527-6566`（refresh）；
  节拍常量同名导出在 `src/core/settings-manager.ts:667-671`（`DEFAULT=15000`、`MIN=5000`、`MAX=120000`）。
- 行为钉（**不是**性能门）：`test/subagent-summary-line.test.ts:821-848`（可见格 60s 内 `getContextTree` 5 次、
  家族消失后冻结在 5），`:905-928`（`intervalMs=5000` 时节拍间隔 ≈5s），`:850-...`（关掉/挂起时零扫描）；
  `test/settings-manager.test.ts:829-...`（默认 15000、clamp、对象形=调参非关闭）。
- 改前树**在 git 历史里**（这点与任务书的假设不同）：`git merge-base --is-ancestor 1917d1049 HEAD` ⇒ 真；
  v1=`1917d1049`、v1.1=`9ff1e92c8` 都是 HEAD 祖先，v1 的父提交 `0186a1247` 可 checkout。
  即：**扫描次数腿的「改前」是可以复跑的**（本席做了，见 §3）；不可复现的是两个墙钟数字与它的量法。

## 1. 新仪器：`spend-cell-scan-count.test.mjs`（同一个文件跑两条腿）

- 位置：`docs/fork/evidence/spend-cell-scan-count.test.mjs`；它**不进** `packages/*/test`，所以不进 CI 的 vitest 收集，
  也不在 `scripts/check-test-private-probes.mjs` 的扫描范围（该脚本只扫 `packages/<pkg>/test/**`，见其 `:140`）。
- 量什么：60s 假时钟窗口内 `agentConnection.getContextTree`（真·磁盘扫描 RPC）被调用几次；
  跑的是真节拍代码（`updateSubagentSummary → refreshSubagentSummary → updateSubagentSummaryLine →
  syncSubagentSpendCell → scheduleSubagentSpendRefresh/startSubagentSpendIdleTick → refreshSubagentSpend`），
  只有连接、settings 面、顶行是替身。
- 量不到什么：墙钟毫秒与 p50——仓内没有这类仪器，那三个数字里只有「扫描次数」这一条能变成本仪器。

复跑（cwd 必须在仓根，vitest 配置的 workspace alias 相对它解析）：

```bash
# 当前侧（本席实测 2026-09-18 20:23 +0800，7 passed）
cd <repo> && SPEND_CELL_BASE_SHA=$(git rev-parse HEAD) \
  SPEND_CELL_READINGS=<repo>/docs/fork/evidence/spend-cell-scan-count.baseline.json \
  npx vitest run --root . --config packages/coding-agent/vitest.config.ts \
    docs/fork/evidence/spend-cell-scan-count.test.mjs

# 改前侧（v1 之前那一棵：0186a1247；同一文件、同一夹具、同一假时钟）
cd <repo> && git worktree add /tmp/spend-base-wt 0186a1247 && ln -s $PWD/node_modules /tmp/spend-base-wt/node_modules
cp docs/fork/evidence/spend-cell-scan-count.test.mjs /tmp/spend-base-wt/docs/fork/evidence/
cd /tmp/spend-base-wt && SPEND_CELL_LEG=pre-v1 SPEND_CELL_BASE_SHA=0186a1247 \
  SPEND_CELL_READINGS=/tmp/spend-cell-scan-count.pre-v1.json \
  npx vitest run --root . --config packages/coding-agent/vitest.config.ts \
    docs/fork/evidence/spend-cell-scan-count.test.mjs      # 3 passed | 4 skipped
```

## 2. 读数（假时钟⇒确定性；同一条场景在两条腿上唯一变化的就是被测代码）

| 场景（60s 窗口） | 当前侧 `6e1e4e95b` | 改前侧 `0186a1247` | 差 |
|---|---|---|---|
| 安静可见家族（只有开头那一下） | **5**（1 次首次填充 + 15s/30s/45s/60s 四次 tick） | **1**（只有首次填充，无 tick） | +4 |
| 持续工作家族（10 事件/s） | **5** | **12**（5s floor，整分钟每 5s 一次） | **−7** |
| 安静 + 一次回合结束（forced） | **6** | 未测（该腿无 tick，语义不同） | — |
| 负控：`intervalMs=5000` | **13**（1+12） | 不适用（改前无可配节拍） | — |
| 负控：应急开关关掉 | **0** | 1（`0186a1247` 的守卫只有 `subagentCounts.total === 0`，没有可见性短路，仍付一次首次填充） | −1 |
| 负控：家族中途消失 | **2**（此后冻结） | 1（冻结） | — |

读数件：`spend-cell-scan-count.baseline.json`（当前侧，含每笔时间戳与间隔）与
`spend-cell-scan-count.pre-v1.baseline.json`（改前侧）。

**与 CHANGELOG 的「22→6」的关系（如实说）**

- `6` **是**可复现的：本仪器唯一的 6 = 「1 次首次填充 + 4 次 tick + 1 次回合结束 forced」；
  但 CHANGELOG 的 6 与我的 6 是不是同一个口径，仓内无从对证（原件没了）。
- `22` **复现不出来**：改前侧在这条仪器上最多是 12/60s（`MIN_INTERVAL=5000` 是硬上界，间隔实测全部 5000ms）。
  更关键的是改前侧还多一个反方向的数：**安静家族在新树上更贵**（1→5）。
- ⇒ 「22→6」作为**一对**读数在仓内不成立；能成立的是「工作家族 12→5、安静家族 1→5」这一对，
  且后者是代价不是收益，写发布说明时必须同列。
- `660→156ms`、`p50 快 3.56×`：仓内无任何仪器、无改前树上的量测件，**不可复现**，只能标注为一次性读数。

## 3. 变异实测（负控不是「再跑一次得到同一个数」，是「把修撤掉数就变」）

全部在 scratch 工作树里做，源文件改动**只存在于 scratch**，交付树零改动。可照抄的完整配方
（`$R` = 本仓绝对路径；本席用 `/tmp/fixL-fixops-evidence`）：

```bash
# 三个 scratch 树 + 一份仪器副本（node_modules 只做符号链接，不 npm install）
cd $R   # `git worktree add` 必须在仓内跑
for n in default tick vis; do git worktree add /tmp/spend-mut-$n-wt HEAD; ln -s $R/node_modules /tmp/spend-mut-$n-wt/node_modules; \
  mkdir -p /tmp/spend-mut-$n-wt/docs/fork/evidence; cp $R/docs/fork/evidence/spend-cell-scan-count.test.mjs /tmp/spend-mut-$n-wt/docs/fork/evidence/; done

# M1 默认节拍变快
perl -pi -e 's/DEFAULT_SUBAGENT_SPEND_CELL_INTERVAL_MS = 15_000/DEFAULT_SUBAGENT_SPEND_CELL_INTERVAL_MS = 5_000/' \
  /tmp/spend-mut-default-wt/packages/coding-agent/src/core/settings-manager.ts
# M2 兜底节拍变快
perl -pi -e 's/SUBAGENT_SPEND_IDLE_TICK_MS = 15_000/SUBAGENT_SPEND_IDLE_TICK_MS = 5_000/' \
  /tmp/spend-mut-tick-wt/packages/coding-agent/src/modes/interactive/interactive-mode.ts
# M3 摘掉可见性短路（守卫体换成直接 true）
perl -0pi -e 's/(private isSubagentSpendCellVisible\(\): boolean \{\n\t\treturn \()\n\t\t\t!this\.terminalSuspended && this\.subagentCounts\.total > 0 && this\.settingsManager\.getSubagentSpendCellEnabled\(\)\n\t\t\);/$1true);/' \
  /tmp/spend-mut-vis-wt/packages/coding-agent/src/modes/interactive/interactive-mode.ts
# 确认每棵树只有一个 hunk 改动（防 perl 打歪）
for n in default tick vis; do (cd /tmp/spend-mut-$n-wt && git diff --stat); done

# 逐棵树跑仪器
for n in default tick vis; do (cd /tmp/spend-mut-$n-wt && SPEND_CELL_READINGS=/tmp/mut-$n.json \
  npx vitest run --root . --config packages/coding-agent/vitest.config.ts \
  docs/fork/evidence/spend-cell-scan-count.test.mjs); echo "EXIT=$?"; done
```

实测结果（本席 2026-09-18 20:24 +0800，逐棵树都是同一个仪器文件；本节配方随后又从零在
`/tmp/rc-{default,tick,vis}-wt` 重跑了一遍，结果逐条相同：4 failed / 1 failed / 2 failed、EXIT 全 1）：

| 变异 | 结果 | 红在哪 |
|---|---|---|
| M1 默认节拍 15s→5s | **EXIT=1，4 failed | 3 passed** | `expected 13 to be 5`（安静）、`expected 13 to be 5`（工作）、`expected 14 to be 6`（回合结束）、`expected 4 to be 2`（家族消失） |
| M2 兜底节拍 15s→5s | **EXIT=1，1 failed | 6 passed** | 只有「无 settings 方法时走兜底常量」那条 `expected 13 to be 5` ⇒ 两条节拍腿互不掩盖 |
| M3 可见性短路→`return true` | **EXIT=1，2 failed | 5 passed** | `expected 5 to be +0`（应急开关关掉仍扫 5 次）、`expected 5 to be 2`（家族消失后继续扫） |

红输出摘录（M1，逐字）：

```
 Failed Tests 4 ⎯⎯⎯⎯⎯
 FAIL  docs/fork/evidence/spend-cell-scan-count.test.mjs > … > a quiet visible family costs one leading fill plus one scan per 15s tick
AssertionError: expected 13 to be 5 // Object.is equality
- Expected
- 5
+ Received
+ 13
 ❯ docs/fork/evidence/spend-cell-scan-count.test.mjs:225:18
    225|    expect(total).toBe(expectations.quiet);
```

**仪器自己也差点是自证（这条请母席记账）**：本仪器第一版把 fixtures 的默认节拍写成字面 `15_000`，
于是 M2 撤掉源常量后它 **7 passed 全绿**（假绿）。改成从源码导入 `DEFAULT_SUBAGENT_SPEND_CELL_INTERVAL_MS`
后 M1/M2 才分别能红。复现这条假绿（M2 那棵树上，把仪器改成 fixtures 自带字面量）：

```bash
cd /tmp/spend-mut-tick-wt
sed 's/intervalMs ?? DEFAULT_SUBAGENT_SPEND_CELL_INTERVAL_MS/intervalMs ?? 15_000/; s/omitIntervalMethod: true/intervalMs: 15_000/' \
  docs/fork/evidence/spend-cell-scan-count.test.mjs > docs/fork/evidence/_hardcoded-variant.test.mjs
npx vitest run --root . --config packages/coding-agent/vitest.config.ts docs/fork/evidence/_hardcoded-variant.test.mjs
# 实测：Test Files 1 passed (1) | Tests 7 passed (7) | EXIT=0   ← 源常量已被撤成 5s，仪器却全绿
```

收工清理：`git worktree remove --force /tmp/spend-mut-*-wt /tmp/spend-base-wt`（本席交付时已清）。

## 4. 供母席记账的 CHANGELOG 措辞（逐字替换，母席可直接抄；本席未改 CHANGELOG）

### 4.1 `CHANGELOG.md:26`（花费格那行）

**旧行（现状）**：

```
- **子代理花费格**：subagents 行显示 `Σ 子代理 ¥… · …tok · 总 ¥…`；节拍可配（`ui.subagentSpendCell.intervalMs`，默认 15s、5–120s 可配）、应急开关可把扫描打到 0。性能修复：每 60s 扫描 22→6 次、每分钟挡住事件循环 660→156ms、撞上那一下 p50 快 3.56×，不走缓存的一次性调用方无回归。
```

**新行（建议替换；只改性能那半句，其余逐字保留）**：

```
- **子代理花费格**：subagents 行显示 `Σ 子代理 ¥… · …tok · 总 ¥…`；节拍可配（`ui.subagentSpendCell.intervalMs`，默认 15s、5–120s 可配）、应急开关可把扫描打到 0。性能修复：**工作家族**每 60s 扫描次数 12→5、**安静家族** 1→5（代价，同列）；读数＝仓内确定性仪器 `docs/fork/evidence/spend-cell-scan-count.test.mjs`（假时钟计数 RPC 调用，改前树 `0186a1247`、当前树 `6e1e4e95b`），负控＝`intervalMs=5s`(5→13)/应急开关(5→0)/撤掉可见性短路(红)；**660→156ms 与 p50 快 3.56× 是一次性墙钟读数，仓内无仪器、量测件 /tmp/spend-perf 已消失，不可复跑**，如需保留请标「一次性读数」。
```

### 4.2 `CHANGELOG.md:31`（#2098 那行的「缓存命中 95%」）

**旧行（现状）**：

```
- **harness 菜单搬出系统提示**（#2098）：系统提示 62,181→50,816 字节；前缀不再每轮作废（背靠背第二轮缓存命中 95%，带"故意破前缀"正控）；新记忆/新技能**下一轮可见**；被拒的精修条目模型可见；修掉"别席改了你报过的同一条目就永不再注入"的版本盲洞。
```

**新行（建议替换；把 95% 的口径与真 provider 出处补齐，其余逐字保留）**：

```
- **harness 菜单搬出系统提示**（#2098）：系统提示 62,181→50,816 字节（一次性真机读数，出处 docs/fork/merge-upstream-20260917.md:133）；前缀不再每轮作废（**faux 模拟器**口径：背靠背第二轮 cacheRead 3959＝冷输入 4168 的 95%，证的是"序列化请求前缀未变"这一真 provider 赖以命中的机制，不是真 provider 命中率；仓内可复跑基线 docs/fork/evidence/p2098-cache-readings.baseline.json，配方见同目录 p2098-cache-readings.md；真 provider 侧历史实测命中率 94.3%，出处 docs/fork/merge-upstream-20260917.md:133/:340，一次性统计不可复跑；正控＝故意破前缀掉到 866）；新记忆/新技能**下一轮可见**；被拒的精修条目模型可见；修掉"别席改了你报过的同一条目就永不再注入"的版本盲洞。
```

（两条替换文案的共同点：把「可复跑」与「一次性」分开标注、每条读数给出落点或明写不可复跑。若母席不想加长，
最低要求是把 `95%` 前面加上 `faux 口径` 四个字、把 `660→156ms / p50 3.56×` 标成一次性读数。）

## 5. 残留风险 / 未做的事

- **改前侧的「22」没能复现**：本席复现的是同一场景下的 12（硬上界 5s floor）。若母席要保留 22，
  必须找回 `/tmp/spend-perf/` 的量测口径（例如它是否把别的调用点也算成"扫描"）；仓内无法自证，本席不替它编解释。
- **墙钟腿零覆盖**：`660→156ms`、`p50 3.56×` 本席没有造仪器（造了也没基线可比，且共享机器上墙钟数不可信）。
- **fixtures 是替身**：连接/settings/顶行是替身，量的是**调用次数与节拍**，不是真 TUI 一帧的开销。
- **两个 JSON 是快照**：`generatedAt` 与 `scanStamps`（假时钟从进程启动的真实时刻起算，所以是绝对毫秒）
  会随复跑变化；可比的是 `scans` 与 `gapsMs`，判据（测试里的断言）才是持久的那部分。
- **交付自证**：把本席补丁 `git apply` 到一个干净的 `6e1e4e95b` 工作树后按 §1 配方重跑，
  仪器 7 passed、读数件的 `scans`/`gapsMs` 与入库基线逐条相同（仅 `scanStamps`/`generatedAt` 不同）。
- 未做的事：未改任何源码、未改 CHANGELOG/FORK_NOTES、未进 CI（本席只被授权动 `docs/fork/evidence/`）。


---

## Status on base `1b5175c0b` (this delta, 2026-09-18 late)

The instrument above and its two baselines are the reading side of the spend-cell claim. Two things
about the *prose* side changed under this delivery, and they are recorded here rather than papered
over:

1. **`CHANGELOG.md:26` now points at `scripts/perf/`, which does not exist in this tree.** Another
   lane rewrote that sentence to read "性能修复（读数口径＝仓内可复跑仪器 `scripts/perf/`，见
   `docs/fork/evidence/`）". At `1b5175c0b` there is no `scripts/perf/` directory and no spend-cell
   evidence document in `docs/fork/evidence/`, so the sentence cites a landing point that is not
   there - the same shape as the finding this delivery exists for. Whoever owns that lane should
   land it or re-point the sentence at the instrument in this file.

2. **The numbers in that sentence are not the numbers this instrument produces.** It says "每 60s 约
   5 次扫描（变异拆掉节流变 28 次）" and "p50 仪器复现 2.36×/3.27× 更快". This instrument measures
   **5 scans / 60s for the working family with the throttle in place and 12 without it** (and 1 -> 5
   for the quiet family, which is the cost side), and it deliberately does not measure wall clock or
   p50 at all (see "WHAT IT DOES NOT MEASURE" in the instrument header: that baseline is not in the
   tree and its artifacts are gone). So the scan count agrees with the sentence's "5" while the
   mutation leg (12 vs 28) and the p50 ratios (unmeasured here) do not.

Neither point is a reason to keep this instrument out: it is what makes the *scan-count* claim
reproducible in-repo, which was the ask for B4-ops-16. It is a reason for the parent to decide which
instrument the sentence should name, and to make the sentence name one that exists.

### Closed on base `4feacb5ce` (2026-09-18 late, the 0.10.0 closure lane)

Both points above are now actions rather than observations:

1. **The sentence names instruments that exist.** `CHANGELOG.md:26` reads its readings from
   `docs/fork/evidence/spend-cell-scan-count.test.mjs` (this scan count) and from
   `packages/coding-agent/scripts/perf/` (the bench instruments), not from a `scripts/perf/` that was
   never there.
2. **The numbers are this instrument's.** The mutation leg is stated as **12** (its `pre-v1` row,
   measured on the same fixture), and the `p50 2.36×/3.27×` claim is gone: no instrument in this tree
   produces it, and this one deliberately does not measure wall clock.

The turn-end expectation was re-anchored in the same lane. `3f7e0f228` made the top bar and the spend
cell share one scan, so a turn end whose aim lands on the moment a tick has already scanned is served
by that scan: the leg that expected `turnEnd: 6` now reads **5** (equal to the tick-only reading, and
with no two stamps in one millisecond - the pre-share baseline recorded two at the same ms). Because
that reading would also come out 5 if the forced refresh stopped being scheduled at all, a second leg
was added: a turn end aiming one second *past* the shared scan still pays its own (**6**). Both rows
and the two runs behind them are in `spend-cell-scan-count.baseline.json`; each leg's mutation is named
in the instrument header.
