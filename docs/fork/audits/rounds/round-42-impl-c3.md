# r42 簇C PR-C3 施工报告：retention sweep 跨进程锁（ADC-3 候选 3A）

席：c3-sweep-lock（分支 r42/c3-sweep-lock，基线 a5456df68）
commit：**f4ddf3bee0f66d0a0de15cbee6f85a84f0bac961** — `fix(coding-agent): serialize retention sweeps across processes with a sweep guard`

## 结论（一句话）

按方案书 ②/③/⑥ 的 3A 裁剪版实施完成：`runRetentionSweepOnce` 现在持有 `<retentionDir>/sweep.guard`
（proper-lockfile，realpath:false，stale 30min，显式 onCompromised）并罩住 `writeRetentionReport`，
ELOCKED 时 CLI 返回 last report + in-flight 文案 exit 0、daemon tick 跳过且不推进
`lastRetentionSweepAtMs`，非 ELOCKED 锁失败降级为无锁运行+记日志，`retention.sweepLockEnabled`
（默认开）是回滚杆；红测 6 条在 a5456df68 纯净导出树上全红、改后全绿，`npm run check` 与
`check:test-hygiene` 退出 0。

## 工作树事故（先记，免得被当成我的改动）

开工时 `/tmp/audit_r/round-42/wt-c3` 在会话中途被外部删除（spawn 时存在、`git status` 干净、
我当时尚未写任何文件）。用 `git worktree add /tmp/audit_r/round-42/wt-c3 r42/c3-sweep-lock`
在原路径按同分支同基线重建 + 重新 symlink `node_modules`，未丢任何证据或提交（重建时分支仍指向
a5456df68）。重建动了主仓 `.git/worktrees` 元数据（注册 worktree 必需），主仓 working tree 零改动。

## 红测证据（见 /tmp/audit_r/round-42/c3-red.txt）

**Section 1 = 行为红**（`npx tsx /tmp/c3-red-probe.mts`，未改 src，只走公共入口）：测试进程用
真实 `lockSync` 持住 `sweep.guard`（同 pid 第二次 lockSync 也 ELOCKED，无需子进程），再触发 sweep：

```
guard held by another (same-pid) lockSync holder: true
oldLog still on disk after the contended sweep : false
logs class reclaimed while guard was held       : 1
history.jsonl gained a line while guard held    : true
outcome.lockHeld field                          : undefined
```

即 ADC-3 的症状本体：争用方照样全量扫树、照样删、照样花第二份 per-sweep 预算、照样进
history.jsonl 的读-改-写。

**Section 2 = 交付的 test/retention-lock.test.ts 在 a5456df68 的 `git archive` 纯净导出树上跑**
（同 env 清洗、node 直调 vitest）：

```
 ❯ test/retention-lock.test.ts (6 tests | 6 failed) 32ms
   × runs nothing and moves no account while another process holds the guard
   × serializes the history read-modify-write instead of losing a line
   × still sweeps when the guard cannot be created, and reports the missing lock
   × breaks a guard older than the stale threshold instead of skipping forever
   × publishes who holds the guard for exactly the duration of the sweep
   × goes back to concurrent sweeps when retention.sweepLockEnabled is off
AssertionError: expected -1 to be greater than or equal to 1   // 基线直接返回 report，.report 不存在
```

形状性失败（`lockHeld`/`lockUnavailable`/`SWEEP_GUARD_FILE_NAME` 在基线不存在）与行为性失败
（第一条：争用时 reclaimed>=1 的断言）同时出现；行为红由 Section 1 独立钉死。

## 改动清单（逐文件；staged 恰好这 10 个，`git diff --cached --name-only` 已核对）

1. `src/core/retention/runner.ts`（主体）
   - `RetentionSweepOutcome { lockHeld, lockUnavailable, report?, lastReport?, holder? }`；
     `runRetentionSweepOnce` 返回它（原返回 `RetentionSweepReport`）。
   - `acquireSweepGuard()`：`lockSync(roots.retentionDir, {realpath:false, lockfilePath:
     sweepGuardPath(roots), stale: SWEEP_GUARD_STALE_MS, onCompromised})`；
     `retentionDir` 只在缺失时创建（注释写明：`ensurePrivateDirectory` 会顺手改回 mode，
     从而把只读目录这个降级条件抹掉）。
   - `SWEEP_GUARD_STALE_MS = 30 * 60_000`，注释给理由：一次 sweep 被 breaker 封顶
     （512MiB/20000 条）、实测秒到分钟级，30min 高一个量级 → 活的 sweep 永不被抢；
     崩溃持有者最多卡半个默认 `sweepIntervalMinutes: 60` 周期；被抢的最坏后果回到今天的
     并发态（账目抖动，不是误删）。proper-lockfile 把 stale 下限钳到 2s、按 stale/2 刷新
     mtime，所以真跑过 15min 的 sweep 能自续锁。
   - `onCompromised` 显式化：只置标志，绝不从 timer 里 throw（默认行为会掀掉 daemon）；
     获取阶段就发现被抢 → 释放并按 held 跳过；sweep 中途被抢 → 记 warn，账照写（删除已发生，
     不写等于隐瞒回收量）。release 一律 try/catch，锁被别人抢走后释放失败不炸。
   - 持锁期间 best-effort 写 `<retentionDir>/sweep-in-progress.json`（pid/startedAt/agentDir，
     `writePrivateFileAtomic`），释放时 best-effort 删；ELOCKED 时读它拼 `holder` 文案。
   - 锁范围罩住 `writeRetentionReport`（history.jsonl ≥HISTORY_LIMIT 的全量重写分支被串行化）。
   - `sweep()` 私有 helper：`runRetentionSweep` + `writeRetentionReport` + 进程内 lastReport。
   - 进程内 `inFlight` 守卫原样保留（含注释里那句"跨进程看不见"的说明）。
   - 头注释写死方案书那句话：**锁护的是账目完整性不是删除安全**（删除安全来自类判定 +
     签名复检 + rename-then-remove），所以锁不可用可以降级跑。
2. `src/core/retention/reports.ts` — 新增 `SWEEP_GUARD_FILE_NAME="sweep.guard"`、
   `SWEEP_IN_PROGRESS_FILE_NAME="sweep-in-progress.json"` 与 `sweepGuardPath()/sweepInProgressPath()`
   （和 last-sweep/history 路径 helper 放同一处；runner 重导出两个文件名常量）。
3. `src/core/retention/types.ts` — `ResolvedRetentionSettings.sweepLockEnabled: boolean`。
4. `src/core/settings-manager.ts` — `RetentionSettings.sweepLockEnabled?`、
   `KNOWN_SETTINGS_KEYS.retention` 增项、`resolveRetentionSettings` → `!== false`（默认开）。
5. `src/cli/public-command.ts` — `retention sweep` 读 outcome：锁占用时打
   `Retention sweep already in flight (pid …, since …); reading sweep-in-progress.json instead of
   sweeping again.` + 上一份报告（`Last sweep: reclaimed …` 及原有逐类行/stalled/report 路径），
   exit 0；`--json` 正常路径输出形状不变，锁占用时输出 `{lockHeld:true, holder, report}`。
6. `src/modes/daemon/daemon-supervisor.ts` — `runRetentionSweepIfDue`：
   `lastRetentionSweepAtMs = now` 移到 sweep 之后；`lockHeld` 直接 return（不置位，下个 check
   tick 重试），日志 `retention sweep skipped: another sweep holds the guard (pid …)`；
   降级跑时日志追加 `(no sweep guard)`。
7. `docs/settings.md` — 表行 `retention.sweepLockEnabled` + 回滚杆段（方案书 ⑤ 措辞：
   账目锁非删除锁、不可用即降级无锁运行、holder 记录在哪）。
8. `test/retention-lock.test.ts`（新）— 6 条，见下。
9. `test/retention-tmp-and-logs.test.ts` — `baseSettings` 补 `sweepLockEnabled: true`
   （新必填 resolved 字段，纯类型补齐）。
10. `.changes/r42-retention-sweep-lock.md` — 一行用户可感句式。

## 等价与正控

- **触发面语义不变**：`test/retention-sweep.test.ts` 全量绿（23 tests，同 class 顺序、同 skip
  词表），另 `retention-life-reclaim`(5)/`retention-tmp-and-logs`(21)/`retention-root-fix`(11)/
  `public-command`(38)/`proper-lockfile-compromise`(10)/`daemon-supervisor-heartbeats`(6) 全绿。
- **正控（锁真的会挡、也会放）**：争用测里 release 后同一触发方照常回收；stale 测里"同形状但
  mtime 新鲜"的 guard 目录 → held，"mtime 拨老 2h" → 自动 break 并照常回收。
- **正控（回收确实活着）**：每条锁测都断言 `logs` 类 reclaimed ≥1 且目标文件消失；锁关测断言
  带 holder 时仍回收（回滚杆有效）。
- **账目完整性**：预置 200 行 history（RMW 分支），持锁触发 → 文件逐字节不变；释放后触发 →
  行数 ≥200、`lines[0..198] === seeded[1..199]`（除 cap 淘汰的最老一条外零丢行），末行 `at`
  等于本次 report.at。
- **降级不停摆**：`chmod 0500 retentionDir` → `lockUnavailable:true` + 照常回收，warn 日志实测
  输出 `retention sweep running unlocked, sweep guard unavailable: EACCES: … mkdir '…/sweep.guard'`
  （`it.skipIf(!permissionDenialIsEnforced)`，win32/root 下跳过并说明原因）。

## check 与测试结果

- `npm run check`（全量，无 tail）：**CHECK_EXIT=0**（biome --write 无未清诊断 → tsgo --noEmit →
  check:installer → check:browser-smoke → check:ci-honesty 全绿）。
- `npm run check:test-hygiene`：**OK (no new private-member probes)**（无 as unknown as 私有、
  无 spyOn 私有，全部走公共入口 + 可观测磁盘状态）。
- 提交后纯净树复验：`git archive HEAD | tar -x` + symlink node_modules + `npx tsgo --noEmit`
  → **PRISTINE_TSGO_EXIT=0**。
- 绿测总数（一次跑 8 个文件：retention-lock / retention-sweep / retention-life-reclaim /
  retention-tmp-and-logs / retention-root-fix / public-command / proper-lockfile-compromise /
  daemon-supervisor-heartbeats）：**Test Files 8 passed (8)，Tests 120 passed (120)**，
  其中新文件 `test/retention-lock.test.ts` **6 passed**；另跑过一轮 6 文件组合
  （含 settings-unknown-keys）**109 passed**。
- 跑法：包根 + `env -u …`（19 个泄漏变量）+ `node ../../node_modules/vitest/dist/cli.js --run`。
- `git status` 提交后干净，无遗留改动；只 `git add` 我自己那 10 个文件，未用 -A/.，未 --no-verify，
  未 amend。

## 偏差（逐条）

1. **新增文件 `reports.ts` 改动**（方案书 ⑥ 的 PR-C3 清单只点名 runner / public-command /
   daemon-supervisor）：守卫文件名常量与两个路径 helper 落在 `reports.ts`，和
   `lastSweepPath()/retentionHistoryPath()` 同处；`runner.ts` 重导出两个文件名常量给测试与 CLI 用。
   没有这个就必须把 `"sweep.guard"` 字符串在 runner、测试和 CLI 文案里各写一遍。
2. **outcome 字段名**：方案书示例是 `{report?, lockHeld?}`，实现用
   `{lockHeld, lockUnavailable, report?, lastReport?, holder?}`——多出的 `lockUnavailable`
   是降级路径的可观测出口（否则"无锁运行"只能靠探 logger 私有成员断言，违反仓规），
   `holder` 是 CLI 文案要显示的 pid/startedAt。属方案书授权的"最小改法自设计"。
3. **`retentionDir` 只在缺失时创建，不用 `ensurePrivateDirectory` 无条件硬化**：
   后者会把 0500 目录 fchmod 回 0700，等于把"只读 retention 目录"这个降级条件自己抹掉；
   硬化仍由 `writeRetentionReport` 负责。注释写在那段代码上。
4. **sweep 中途 onCompromised 的处置**与方案书字面"当 held 跳过"有半格偏离：此时删除已经发生，
   跳过写报告等于隐瞒回收量，所以选择"照写 + warn 记日志"；**获取阶段**就被判被抢的情况仍按
   held 跳过。取舍写进 runner 注释与本报告。另外 `onCompromised` 无法在测试里定时触发
   （proper-lockfile 的刷新 timer = stale/2 = 15min，测试里 sweep 是毫秒级；且把 stale 做成
   注入参数就是给测试开后门），故按任务书允许的等价断言覆盖：ELOCKED → held 跳过不抛、
   非 ELOCKED → 无锁降级不抛、陈旧 guard → 自动 break 并回收、guard 被外部删掉后 release 不抛。
5. **降级测用 `chmod 0500` 并 `it.skipIf(!permissionDenialIsEnforced)`**（win32 或 root 下
   chmod 不挡写）：命名谓词 + 原因在代码里，非无条件 skip。
6. **CLI `--json` 在锁占用时的形状**是 `{lockHeld, holder, report}`（正常路径与今天逐字节一致）。
   新状态没有旧消费者，但仍是对外可见契约变化，记此。
7. **剩余项（未做）**：
   - `retention sweep` 的 in-flight 文案没有自动化测（`public-command.test.ts` 现在完全不覆盖
     retention 子命令，补 mock 超出本轮 12 分钟窗口）；文案是 outcome 的纯渲染，语义由 runner 层
     `lockHeld/lastReport/holder` 断言钉住。
   - 没有真·双子进程测（同 pid 的 `lockSync` 争用在 proper-lockfile 层与跨进程同形：mkdir EEXIST
     + guard 目录 mtime 判定；Section 1 探针实测了这一点）。
   - 方案书 2B 的 sweep 侧 opportunistic ledger 压实不在本 PR（属 PR-C2 车道）。
8. 其余按方案书实施：无自创修法、不提供 `--force` 旁门（R5 有意），进程内 `inFlight` 守卫保留不动。

## 反向变异对照（防止"断言只是挂在返回形状上"的误读）

同一份 c3-mutation 导出树里把 `SWEEP_GUARD_STALE_MS` 改成 `1`（proper-lockfile 会把 stale 钳到
2s 下限并按 stale/2 刷新 mtime，所以测试时长内锁不会被视为过期）→ **6 条仍全绿**。
这条负对照说明红/绿变化不是由某个可调常数造成，而是由"守卫在不在触发路径上"造成；
上面那个摘掉守卫的正对照（5 红 1 绿）与它成对。

## 交付物

- commit `f4ddf3bee0f66d0a0de15cbee6f85a84f0bac961`（分支 r42/c3-sweep-lock，基线 a5456df68，
  10 files changed, 619 insertions(+), 29 deletions(-)；未 push——合并窗口归母席）
- 红测证据 /tmp/audit_r/round-42/c3-red.txt（行为红 + 基线纯净导出树 6/6 红 + 归因说明）
- 绿测 /tmp/audit_r/round-42/c3-green.txt（8 文件 120 passed）、c3-green-lock.txt（新文件 6 passed）
- 等价 /tmp/audit_r/round-42/c3-equiv.txt（6 文件 109 passed，含 retention-sweep 23）
- check /tmp/audit_r/round-42/c3-check.txt（CHECK_EXIT=0 + test-hygiene OK）、
  c3-biome.txt（BIOME_EXIT=0）、c3-pristine-tsgo.txt（PRISTINE_TSGO_EXIT=0）
- 变异控制 /tmp/audit_r/round-42/c3-mutation-control.txt（摘掉守卫 → 5/6 红，回滚杆测仍绿）
- 三个一次性对照树（c3-baseline / c3-mutation / c3-pristine，均为 `git archive` 导出副本）跑完即删，
  留下的只有上面这些 .txt 证据；施工树只有 wt-c3 一份，HEAD=f4ddf3bee，工作树干净。
