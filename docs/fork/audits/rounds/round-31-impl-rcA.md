# r31 impl-rcA — ps fork 税族修复（RC-1 / RC-4）

冻结 SHA：`516f46e636e3fc3fa3286d3ab663ef0c5f2911ad`（主仓 HEAD，merge/repl-kernel）
工作树：`/tmp/r31_rcA_wt`（detached @ 冻结 SHA，node_modules symlink 指主仓）
对应发现：`/tmp/audit_r/round-31/multi-session-resource-contention.md` R31-14（RC-1）、R31-9（RC-4）；微基准 T6：`getProcessStartId`＝55.17ms/次（execFileSync `ps -p`）。
方法：先红后绿；测试批 ≤3 文件；`npm run check`（biome+tsgo+gates）EXIT 0；全部测试跑在 unset 泄露变量（RLM_* / PRIME_AGENT* / PI_*）后的环境。

## RC-1 — supervisor spawn 流程同步 fork ps（daemon-supervisor.ts:3989）

**修复**：`launchWorker` 内 `childProcessStartId = getProcessStartId(childPid)` → `await getProcessStartIdAsync(childPid)`（仓内既有异步孪生，identity 格式相同）。1 行语义改动 + 注释。事件循环不再被每次 worker launch 的 ~55ms execFileSync 阻塞；N 并发 launch 的队头阻塞从 N×55ms 降为 0（同步路径）。

**红测**（`test/daemon-supervisor-launch-startid-async.test.ts`）：
- 探针：in-process `DaemonSupervisor`（真实 `start()`，temp agentDir/registry）+ `vi.mock("node:child_process")` 的假 worker child（真实 `stdio` FD3 启动闸 Writable，`spawn` 事件 setImmediate，pid 取自短命子进程＝死 pid）+ `vi.spyOn(session-lease, "getProcessStartId")` 注入 80ms 确定性 busy-wait（Atomics.wait，不真 fork）。
- 断言：5 并发 `createOrReuseWorker` 期间 ①同步 identity 调用数＝0 ②事件循环心跳最大间隙 < 48ms（2ms 心跳）。改前红：`expected 5 to be +0`（5 次同步调用）+ 心跳间隙 ≥80ms；改后绿（实测最大间隙 ~10-25ms）。修复后曾回退源码复核红态（同最终测试形态），仍红。
- 正控：①`getProcessStartId(pid) === await getProcessStartIdAsync(pid)`（活 pid，同 identity）②`daemon-supervisor-process.test.ts`（真实 tsx worker 进程，11 passed/8 skipped）全绿——launch→connect→adoption 端到端仍按 identity 工作。

## RC-4 — referenceIsLive 每条引用 fork 一次 ps（venv-in-use 读路径）

**修复**（批量，方案②）：
1. `session-lease.ts`：新增 `psStartIdsQuery`/`parsePsStartIds`（`ps -p p1,p2,... -o pid=,lstart=`，locale/TZ 与单 pid 版同钳制，identity 字符串逐字节同构）+ `getProcessStartIdsAsync(pids)`：去重→/proc 先行（免费）→剩余 pids 一次 ps 批量查询；查询失败＝全部未观测（保守方向与单查询失败一致）；win32 逐 pid 异步回退。
2. `reference-records.ts`：`referenceIsLive(record, currentStartIdOf?)`/`judgeReferenceEntry(path, pidName, currentStartIdOf?)` 可注入批量 lookup；拆出 `inspectReferenceEntry`（lstat+parse 证据，不跟随 symlink——保持原 foreign 判定的读序）+ `verdictFromEntryFacts`；默认参数＝原同步行为，旧调用方（kernel-snapshot、confirmReferenceIsStale）签名不变。
3. `venv-in-use.ts` `readKernelVenvInUseState`：两遍式——先收集全部 entry 证据（0 fork），对"记录了 processStartId 且 pid 活着"的集合做一次 `getProcessStartIdsAsync`，再用 map lookup 判定；sweep 确认读（`confirmReferenceIsStale`）保持逐条新鲜读（unlink 授权语义不动）。判活语义不变：pid 死→stale（kill -0 先行，不查 ps）；map miss（查询失败/pid 查询时已死）→"无法证伪"＝保留，与单查询失败同向；唯一微观偏差＝收集与判定间 pid 复用的极窄窗口内从 stale 变保守保留（方向＝模块明文的 keep 法则）。

**红测**（`test/kernel-venv-ps-fork-budget.test.ts`）：
- 探针：`vi.mock("node:child_process")` 透传计数 execFileSync/execFile 的 `ps` 调用；27 个真实活 pid holder（node -e setInterval）+ `recordKernelVenvInUseSync` 写真实 identity 引用（setup 计数后清零）。
- 断言：`readKernelVenvInUseState`（sweepStale:false）后 ps 调用数 ≤1。改前红：`expected 27 to be less than or equal to 1`（27 次同步 fork，与 T6×27≈1.5s/boot 同构）；改后绿：1 次（批量）。
- 正控：27 条活引用全部判 live 且带原 identity（批量返回真实 identity 的行为证明）；死 pid 记录判 stale；活 pid+错误 identity（`ps:replaced-identity`）判 stale；`kernel-venv-in-use.test.ts`(29)/`session-lease.test.ts`(16)/`kernel-snapshot-reference-states.test.ts`(10)/`kernel-bootstrap-in-use.test.ts`+`retention-sweep`+`kernel-snapshot-final-flush`(43)/`kernel-snapshot-write-policy`+新测(17)/`daemon-supervisor-monitor`+`failed-reaper`(108) 全绿。
- 受益路径：`pruneKernelVenvGenerations` 每次 kernel boot（bootstrap GC trigger 1）对非 active 代际的 in-use 读：27 活引用场景从 ~27×55ms 同步阻塞 → 1 次异步 ps（~55ms，不阻塞事件循环）。

## 残余与边界（未在本轮范围）

- supervisor 侧其余同步 `getProcessStartId`：adoption 路径 `daemon-supervisor.ts:4703/4734`（boot 时逐 descriptor）、`processIdentity` :8677（reaper/stop 惰性核查，有节流）、eviction :5176——同型税，非 spawn 路径，留待后续轮。
- `kernel-snapshot.ts` 的 judge 循环仍逐条同步 ps；新 `currentStartIdOf` 注入点已就绪，可后续接批量。
- `getProcessStartIdsAsync` 未对超大 pid 集分块（`-p` 参数长度上界 ~10^5 pid，实际每代际引用数为几十）。
- fsync 风暴（R31-11）与 guard 临界区（R31-1/2）、socket 泄漏（R31-5）不在本任务范围。

## 验证记录（本机 2026-09-16）

| 步骤 | 命令 | 结果 |
|---|---|---|
| RC-4 红 | vitest --run kernel-venv-ps-fork-budget | 1 failed：expected 27 ≤ 1 |
| RC-1 红 | vitest --run daemon-supervisor-launch-startid-async | 1 failed：expected 5 = 0 |
| RC-4/RC-1 绿（+回归 3 批） | 同上 + 既有 8 文件 | 全绿（含 process 真进程 11 passed）|
| 仓库检查 | `npm run check`（biome+tsgo+installer+browser-smoke+ci-honesty） | EXIT 0，6 个触碰文件 biome 零诊断 |
| 干净树类型检查 | `git archive HEAD`→tmp+symlink node_modules→`npx tsgo --noEmit` | EXIT 0（提交后复核）|

提交：工作树 `/tmp/r31_rcA_wt`（detached @ 516f46e63）单提交 `1da9c1289`（pre-commit hook `npm run check` 通过）；staged 仅上述 7 文件（逐文件 add 后核对）；changelog fragment `packages/coding-agent/.changes/r31-ps-fork-tax.md`。

提交 SHA：`1da9c1289`；干净树 `npx tsgo --noEmit` EXIT=0（git archive 解包 + symlink node_modules）。
