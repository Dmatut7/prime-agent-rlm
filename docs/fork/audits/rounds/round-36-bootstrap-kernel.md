# r36 审计线：bootstrap-cli 与 kernel venv 引导链（首跑冷启动失败恢复）

- 仓：/Users/a1/Desktop/ai/prime-agent @ `89260d029a24b0fefea9419b280aba5f8c4bcb18`（只读，仓内零写入；所有实验在 /tmp/r36 下的假 HOME/假 uv/假体积卷）
- 时间：2026-09-16
- 方法：源码通读（bootstrap.ts 1683 行全文 + venv-in-use.ts 关键路径 + 调用方 ipython.ts/repl-manager.ts/postinstall.ts/config.ts/ci.yml）+ /tmp 非破坏性复现（假 uv、假 HOME、只读 HOME、8MB APFS 卷真 ENOSPC、活 pid 持锁）+ 直接 vitest 跑首跑面套件（先 unset 泄露 env）
- 去重：先读 docs/fork/audits/decisions.jsonl（297 条）。最接近的是 X1（win32 `bin/python` 写死，已修）、RC-4（每活引用 fork ps）、SUP-D（fd/rg 走 releases/latest 无校验无固定）。本线 6 条均为**未记录**新增。

---

## ① 首跑路径：入口、触发时机、判据

**入口链（逐字）**

| 环节 | 位置 | 事实 |
|---|---|---|
| 脚本入口 | `scripts/setup-kernel-venv.sh:4` | 4 行壳：`npx tsx packages/coding-agent/src/core/kernel/bootstrap-cli.ts`。仓内**无**其它调用者（`grep -rn setup-kernel-venv` 只命中自身 + package.json 注释 + ci.yml 说明） |
| CLI | `packages/coding-agent/src/core/kernel/bootstrap-cli.ts:46` | `await ensureKernelPython(...)`；`:52` 捕错 `process.exit(1)`；`:47` 成功打印 `kernel python: <path>` |
| 真产品入口 A（交互首跑） | `src/main.ts:833` `prewarmIpythonKernel: true` → `src/core/agent-session.ts:12247-12249` 会话起手即 `prewarm()` → `src/core/tools/ipython.ts:410` `void this.ensure().catch(() => {})` → `:604 onBootstrapProgress` → `repl-manager.ts:936 ensureKernelPython({...})` |
| 真产品入口 B | `src/postinstall.ts:28` `await ensureKernelPython()`，但仅当 `PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=1`（`postinstall.ts:4-13`，且此时自动置 `PRIME_AGENT_INSTALL_UV=1`） |
| 测试入口 | `packages/coding-agent/package.json:41,42`（`test:ci` / `test:machine-wide` 第一步）、`ci.yml:293`（kernel job 播种步） |

**每次启动都跑吗**：跑，但每次都先过"热判据"；进程内还有一次记忆化（`bootstrap.ts:1659-1682`，`inFlightEnsureKernelPython`）。冷启动只在 `kernelReady===false` 且拿到机器级锁之后发生（`:1564` 热早返回在锁之前）。实测热路径墙钟 **0.32–0.75s**（stub python，本机 3 次；真 CPython 略高），成本 = 1 次解释器 spawn（`hasPrimeAgentRuntime`，`:689-696` 跑 `RUNTIME_READY_CHECK`，`:102` 约 2.4KB 检查脚本）+ 读 manifest。

**"已引导"判据 = 活探针 + 清单，不是目录存在**（正面结论，无误判）：

- `kernelReady = hasPrimeAgentRuntime(python) && bootstrapVersionCurrent(manifest, ...)`（`:1473-1483`）。
- `bootstrapVersionCurrent`（`:981-991`）= schema==10 ∧ runtime==内容哈希 ∧ snapshot=="dill" ∧ 默认包 pin 列表逐字相等 ∧ 本次请求的 Python skills 内容哈希全中（`:968-979`，paths-independent，K-P1-2）。
- `hasPrimeAgentRuntime` 是**真跑** venv 里的 python 验 rlm API 面（harness CRUD/reference/global_/bash handle/PROTOCOL_VERSION 3..4 等），不是 `existsSync`。
- 因此"半成品 venv 目录存在即就绪"**不成立**：实测（E2）失败后残留 `<base>-<suffix>/bin/python`、无 `.bootstrap-version`，下次启动走 replace 分支（`venv-in-use.ts:396-430`：`generationDirExists && !unknown && liveReferences===0 → "replace"`），删掉重建，见 ③。
- **盲区（本轮新增 F3）**：热判据不验默认包导入。`missingRlmExtraImportLabels`（`:732-740`）只在 `PRIME_AGENT_KERNEL_PYTHON` 覆盖路径（`:1509`）与**新建后**复检（`verifyFreshKernelRuntime`，`:721-730`）用。实测 E2c：把热 venv 里 `import pandas` 改成 exit 1 后重跑 bootstrap-cli → `kernel python: ...` / **EXIT=0**，既无 rebuild 也无 warning。

---

## ② 依赖来源

| 项 | 事实 | 位置 |
|---|---|---|
| uv 从哪来 | ① PATH 里找 `uv`（win32 试 `uv.exe`）② `~/.local/bin/uv` ③ 否则报错让你自己装，或 `PRIME_AGENT_INSTALL_UV=1` 时跑 `curl -LsSf https://astral.sh/uv/install.sh \| sh` | `:837-883`，命令常量 `:79` |
| uv 版本 | **不检查**。旧 uv 没有 `uv python install`/`--seed` 时只能看到不透明的 exit code（见 F1） | — |
| python 版本 | `PYTHON_VERSION = "3.11"`（`:29`），只锁 minor，不锁 patch；由 `uv python install 3.11` 解析 | `:1323` |
| 构建命令（逐字） | `uv python install 3.11` → `uv venv <venv> --python 3.11 --seed` → `uv pip install --python <py> <runtime源码目录> dill requests==2.34.2 httpx==0.28.1 pyyaml==6.0.3 tomli==2.4.1 python-dotenv==1.2.3 pandas==3.0.5 numpy==2.4.6 scipy==1.17.1 beautifulsoup4==4.15.0 lxml==6.1.3 pydantic==2.13.5 tyro==1.0.16` | `:1310-1327`，`kernelInstallArgs` `:1298-1308` |
| 包列表/是否 pin | 内联常量 `DEFAULT_RLM_EXTRA_PACKAGES`（`:62-75`），**逐个 `==` 精确 pin**，且是 venv 代际身份的一部分（`:596-603`）。`dill` unpin（仅名字） | `:51` |
| runtime 本体 | 本地源码优先（`prime-agent-runtime/`，内容 sha256 作身份）；无本地源码时**拒绝**裸名 registry 安装，只有 `PRIME_AGENT_KERNEL_ALLOW_REGISTRY_RUNTIME=1` + `..._SPEC_ENV` 精确 pin 才允许 | `:1101-1108`、`:1187-1199`、`:1130-1145` |
| 网络端点 | astral.sh（uv 安装器）、python-build-standalone（uv 下 python）、PyPI（显式 opt-in 时） | — |
| 离线/镜像 | 产品层**无**任何镜像/离线开关（无 `UV_INDEX`/`PIP_INDEX_URL`/`--offline` 处理，grep 全仓仅命中注释）；离线只能靠"预先填好的 uv cache"，该说法只出现在错误文案里（`:1497`）。uv 自身 env 变量（`UV_CACHE_DIR`/`UV_PYTHON_INSTALL_DIR` 等）会继承（`run()` 传 `env: process.env`，`:655`），故镜像在实操上可行但**未文档化、未验证** | — |

---

## ③ 失败恢复：用户看到什么 / 会不会中毒 / 锁

**逐例实测（全部 exit code 取自 `echo EXIT=$?`）**

| 情形 | 复现 | 用户逐字看到 | EXIT | 残留状态 |
|---|---|---|---|---|
| uv 不存在 + 非 TTY | 假 HOME，PATH 无 uv/`~/.local/bin`，`env -i` | `› setting up python kernel (one-time, ~30s)…` / `Failed to set up the Python kernel runtime. uv is required to set up the Python kernel. Install uv yourself: curl -LsSf https://astral.sh/uv/install.sh \| sh, or set PRIME_AGENT_INSTALL_UV=1 to let prime-agent run that installer.` + 一段"首次要联网" | **1** | 无（未建目录） |
| 网络断在 `uv pip install` | 假 uv：`python`/`venv` 成功、`pip` exit 1 且 stderr 打印 `error: Failed to install prime-agent-runtime: network error (connection reset by peer)` | **只有**：`Failed to set up the Python kernel runtime. …/uv pip install --python …/bin/python <源码目录> dill requests==2.34.2 … failed with exit code 1` + "首次要联网" | **1** | **半成品 venv**：`<base>-51a5d2acd0db/bin/python` 在，无 `.bootstrap-version`；锁目录已清（无 `.bootstrap-lock` 残留） |
| 重试一次（同目录，uv 恢复） | 同假 uv，`pip` 改为 exit 0 | `› setting up python kernel (one-time, ~30s)…` / `rebuilding unreferenced kernel venv kernel-venv-51a5d2acd0db` / `✓ ready` / `kernel python: …` | **0** | 正常，**证明半成品不是中毒态，会自愈重建** |
| 只读 `~/.prime/agent`（默认路径，父目录已存在） | chmod 500 假 HOME 全树 | **裸 errno**：`EACCES: permission denied, mkdir '/tmp/r36/h9/.prime/agent/kernel-venv.bootstrap.lock'` | 1 | 无 |
| 只读 HOME 且 `.prime` 不存在 | chmod 500 假 HOME，无 `.prime` | 设计文案：`couldn't create kernel venv directory at <A> or <B>; set PRIME_AGENT_KERNEL_PYTHON to a python with a current prime-agent-runtime installed. EACCES: permission denied, mkdir '<HOME>/.local'` | 1 | 无 |
| 磁盘满（真 ENOSPC，8MB APFS 卷 + 真 uv） | `hdiutil create -size 8m`，`PRIME_AGENT_KERNEL_VENV=/tmp/r36/tinyvol/kernel-venv` | **只有**：`Failed to set up the Python kernel runtime. /opt/homebrew/bin/uv venv /tmp/r36/tinyvol/kernel-venv-51a5d2acd0db --python 3.11 --seed failed with exit code 2` + "首次要联网" | 1 | **真半成品**（`bin/python`、`bin/python3.11`…，无 manifest；卷剩 1.0Mi） |
| 同卷 uv 的原话（正控，手工跑同命令） | `uv venv … --seed` 直接跑 | `error: Failed to create virtual environment / Caused by: failed to create file '…/pyvenv.cfg': No space left on device (os error 28)` / UV_EXIT=2 | — | —— 这一行**被产品丢弃**（见 F1） |
| 锁被活进程持有（3s 超时） | 假 HOME 写 `settings.json {"kernelBootstrap":{"lockTimeoutMs":3000}}`，`sleep 300 &` 的 pid 写进 `kernel-venv.bootstrap.lock/pid` | `Timed out after 3s waiting for the kernel venv bootstrap lock at …/kernel-venv.bootstrap.lock (held by pid N). Another prime-agent process is preparing the Python kernel there: wait for it, stop it, or remove that lock directory if it is wedged. Raise kernelBootstrap.lockTimeoutMs in settings to wait longer (0 waits forever), or set PRIME_AGENT_KERNEL_PYTHON …` | 1 | 别人的锁目录**未被破坏**（正确） |

**中毒态结论**：`无 → 不会永久坏掉`。半成品目录不会被当成就绪（判据见 ①），下次启动 `rm -rf` + 重建（`bootstrap.ts:1604-1610`）并打印 `rebuilding unreferenced kernel venv <name>`。唯一"永久阻塞"分支是 **defer**：目录存在但需要重建且有活引用/引用状态不可读 → `KernelVenvRebuildDeferredError`（`venv-in-use.ts:132-154`），文案自带出路（等 kernel 退出 / 设 `PRIME_AGENT_KERNEL_PYTHON`）。**但**：无退避/计数，坏机器（无盘、只读卷、noexec）上每次 kernel 启动都重跑整套 rm+三连 uv 安装并再次失败。

**锁/并发**：base-keyed 锁目录（`bootstrapLockDir` `:763-765`，`acquireBootstrapLock` `:801-835`）＋ pid 存活性检查（`processIsRunning` `:767-774`，EPERM 视为活）＋ 无 pid 时 30s mtime 陈旧窗口（`:786-793`）；默认上限 `DEFAULT_KERNEL_BOOTSTRAP_LOCK_TIMEOUT_MS = 300_000`（settings-manager.ts:52），可设 0=永久等；进程内并发记忆化按 key（`ensureKernelPythonKey` `:538-546`：venv override + HOME + XDG + skills 哈希）；"返回路径→spawn 记录引用"的窗口由 boot claim 覆盖（`:1543-1555`）。均有单测，我另用 E5 端到端验了超时路径。

---

## ④ 自动化测试 / CI 覆盖

**单测（直接跑，exit code 实测）**

```
cd packages/coding-agent && env -u RLM_* -u PRIME_AGENT_* -u PI_CODING_AGENT \
  node ../../node_modules/vitest/dist/cli.js --run \
  test/kernel-bootstrap.test.ts test/kernel-bootstrap-lock.test.ts \
  test/kernel-bootstrap-in-use.test.ts test/kernel-runtime-pinning.test.ts \
  test/kernel-python-resolution.test.ts --reporter=json --outputFile.json=/tmp/r36/vitest-kernel.json
→ Test Files 5 passed (5) / Tests 66 passed (66) / VITEST_EXIT=0（39.2s）
```

覆盖到的失败/分支（名字即命题）：`rebuilds a broken venv`、`rebuilds a warm venv whose recorded runtime hash no longer matches local source`、`rebuilds a warm venv with a stale rlm runtime`、`rejects a freshly installed venv whose runtime is not ready`、`rejects a freshly installed venv missing a default package the install claimed`、`continues when a Python skill editable install fails and retries it next startup`、`fails with an actionable typed error once the lock wait exceeds its bound`、`breaks a lock whose holder pid is gone`、`breaks a pid-less lock older than the stale window`、`retries on the next call after a lock timeout instead of caching the failure`、`cancels an in-flight uv install when the waiting session aborts`、`rebuilds an unreferenced generation in place (positive control)`、`defers instead of rebuilding a generation a kernel is running from`、`leaves a partial generation with a failed build behind nothing to sweep`、`fails closed when the install ships no local runtime source`。

**没覆盖的失败分支（负结论 + 正控）**

- 负结论：`grep -rn "uv is required\|install uv yourself\|PRIME_AGENT_INSTALL_UV" packages/coding-agent/test` → **0 命中**（只在 src 命中 5 处）。即"uv 不存在"拒绝文案（`:860-865`）与 `curl|sh` 安装器分支（`:867-882`）**无任何测试**。
- 同一条 grep 能命中相邻已覆盖面（`PRIME_AGENT_KERNEL_PYTHON` 契约、rebuild、defer、锁陈旧）⇒ 方法有效（正控）；failing 的另有：只读目录/权限拒绝（F2）、ENOSPC（F4 只有 `leaves a partial generation … behind` 这一条**静态**断言，非真 ENOSPC）、被丢弃的 uv stderr（F1，按构造测不到）、热路径默认包盲区（F3）。
- CI：冷启动**真的跑**（每个 coding-agent shard 的 `test:ci` 第一步 = `tsx src/core/kernel/bootstrap-cli.ts`，package.json:41；kernel job 另有 `--with-bundled-skills` 播种 + pin，ci.yml:283-301），但**全为 happy path**（runner 有网、uv 由 `python3 -m pip install --user uv` 预装、`PRIME_AGENT_INSTALL_UV=1` 只在播种步设置）。没有任何 job 覆盖 uv 缺失/网络失败/只读 HOME/`curl|sh` 安装器。

---

## ⑤ 其它

- **非交互 shell**：无 TTY 时 `confirmUvInstall` 直接 `false`（`stdin.isTTY/stderr.isTTY`，`:887`）→ 只报错不装，文案给出 `PRIME_AGENT_INSTALL_UV=1`，可接受。**但**交互会话路径永远拿不到那个 [Y/n] 提示：`shouldInstallUv = PRIME_AGENT_INSTALL_UV==="1" || (!options.onProgress && confirmUvInstall())`（`:858-859`），而 `ipython.ts:604` 恒给 `onProgress` ⇒ 提示在真产品路径上是**死代码**（只有直接跑 bootstrap-cli 或 postinstall 时可达）。
- **Windows/受限 shell**：解释器路径已按 `Scripts/python.exe` 分派（`:1288-1292`，X1 已修面）；uv 查找试 `uv.exe`（`:840`）；但自动装 uv 走 `run("sh", ["-c", …])`（`:869`）——Win32 无 `sh`（Git Bash 之外）→ spawn 失败，文案仍可操作；**无 win32 runner ⇒ 未验证**。
- **超时**：`run()` **无超时**（`:647-678`）；`lockTimeoutMs` 只覆盖"等锁"，一旦拿到锁，三连 uv 安装**不受任何产品级时间界**，只有调用方 AbortSignal 与更上层的 kernel 启动/stall watchdog。网络黑洞（代理挂住、SYN 半开、DNS 卡死）下用户只看到 `› setting up python kernel (one-time, ~30s)…` 然后长时间静默。**未复现**（未构造黑洞），结论由源码得出。
- **代理**：`run()` 继承 `process.env`（`:655`），curl/uv 各自认 `HTTPS_PROXY` 等；产品无额外代理配置需求，也未在文档里说明。
- **权限/磁盘前置检查**：无（无剩余空间、无文件系统可写性、无 noexec 预检）。

---

## 缺陷清单（去重后新增）

### F1 [P2] 所有 uv 子进程的 stderr 被丢弃，"根本原因"对用户不可见，并被错误归因成"需要联网"
- `packages/coding-agent/src/core/kernel/bootstrap.ts:647-678`（`run()`；`stdio: options.stdio ?? "ignore"`，`:656`），调用点 `:1323`、`:1324`、`:1325`（三条 uv 命令）与 `:1444-1448`（skill 安装）；唯一例外是 uv 安装器 `:869-871`（无 onProgress 时 `inherit`）。
- 逐字证据：假 uv 把 `error: Failed to install prime-agent-runtime: network error (connection reset by peer)` 写 stderr，用户侧只看到 `… uv pip install … failed with exit code 1`；真 ENOSPC 正控显示 uv 原话是 `No space left on device (os error 28)`，产品侧只看到 `uv venv … --seed failed with exit code 2`。两段用户可见文本里都跟着 "First-time setup needs internet…"，把权限/磁盘/代理错误统一说成网络问题。
- 影响：首跑最可能的三类失败（磁盘满、EACCES、代理/TLS/索引异常）**同形不可辨**；用户按提示"检查网络"无效，且没有任何可复制的诊断信息（uv 自己建议的 `--verbose`、缓存路径都拿不到）。
- 复现：`/tmp/r36/bin/uv`（假 uv，`UV_FAIL=1`）→ `env -i PATH=/tmp/r36/bin:/usr/bin:/bin HOME=… PRIME_AGENT_KERNEL_VENV=… node …/tsx bootstrap-cli.ts`。
- confidence：**high**（直接实测，含真 uv 正控）。

### F2 [P3] 目标目录"存在但不可写"绕过设计好的诊断，并在 try/catch 之外漏出裸 errno
- `bootstrap.ts:561-581` `resolveWritableKernelVenvDir` 用 `mkdir(dirname(primary), {recursive:true})` 当可写性判据——目录**已存在**时它必然成功，于是 XDG 回退与"couldn't create kernel venv directory at A or B"文案在该情形下不可达；随后 `:1568 acquireBootstrapLock(base)` 内部 `:817 mkdir(lockDir)` 抛 EACCES，而这次调用在 `:1572-1623` 的 try/catch **之外**，`formatBootstrapFailure`（`:1485-1500`）不参与包装。
- 逐字证据：`EACCES: permission denied, mkdir '/tmp/r36/h9/.prime/agent/kernel-venv.bootstrap.lock'`（EXIT=1）；正控（`.prime` 不存在 + 只读 HOME）显示设计文案 `couldn't create kernel venv directory at … or …`。
- 影响：只读 HOME / 只读 `~/.prime/agent` / 容器只读挂载 / NFS-RO / `.prime` 目录属主异常 时，首跑用户拿到一行 errno，消息里**没有** kernel/Python/venv 字样，也没有 `PRIME_AGENT_KERNEL_PYTHON` 出路。同类形状还有：锁目录里写 pid（`:818`）遇到 ENOSPC/EACCES 也走同一条未包装路径。
- 复现：`/tmp/r36/h9`（chmod 500 全树，`.prime/agent` 已存在）跑 bootstrap-cli。
- confidence：**high**。

### F3 [P3] 热路径就绪判据不验默认包导入 → 被外部破坏的 venv 永久"就绪"
- `kernelReady`（`:1473-1483`）＋`bootstrapVersionCurrent`（`:981-1000`，纯清单字符串比对）；12 个默认包的 import 检查（`missingRlmExtraImportLabels` `:732-740`）只挂在 `PRIME_AGENT_KERNEL_PYTHON` 路径（`:1509`）与新建后复检（`:721-730`）。
- 逐字证据：改坏热 venv 的 `import pandas` 后重跑 → `kernel python: /tmp/r36/h2/kernel-venv-51a5d2acd0db/bin/python` / `EXIT=0`（无 rebuild、无 warning）。
- 影响：外部 pip uninstall / site-packages 半删 / 缓存清理后的 venv 永远被判就绪；模型第一次 `import pandas` 才在 kernel 里失败，故障点离原因很远。属**成本取向的取舍**（全量复检=每次 boot 多 13 次 spawn），审计只指出新建路径查、热路径不查的不对称。
- confidence：**high**（源码 + e2e）。

### F4 [P3] 无任何资源前置检查/退避：坏环境下每次 boot 都 rm -rf 全量重建
- `:1604-1610`（`reportProgress` + `rm -rf` + `bootstrapVenv` 三连 uv），`decideKernelVenvRebuild`（`venv-in-use.ts:396-430`）对"无引用且状态已知"一律 `replace`。
- 逐字证据：E2 残留半成品 → E2b `rebuilding unreferenced kernel venv kernel-venv-51a5d2acd0db` + `✓ ready` EXIT=0（自愈，无中毒）；真 ENOSPC 下 E4 留下真半成品（`bin/python` 等），下次启动同样先删再建再看 uv 失败。
- 影响：磁盘满/只读卷/noexec 主机上每次 kernel 启动重跑整套下载+安装（含 `uv python install`），并**每次都删掉可能已完好的一部分**；没有失败计数、没有"先探测目标目录可写/剩余空间"的短路。不是中毒，是昂贵的空转。
- confidence：**high**（自愈与残留均实测）。

### F5 [P3] 交互首跑的失败是静默的
- `src/core/tools/ipython.ts:409-412` `prewarm()` 注释与实现均明确吞掉错误（`void this.ensure().catch(() => {})`），只在下次 `ensure()`（第一次 Python cell）才抛；触发点 `agent-session.ts:12247-12249`，由 `main.ts:833`（交互主会话 rlm depth 0）打开。
- 影响：首跑断网时用户只看到 `Starting Python kernel...` / `› setting up python kernel (one-time, ~30s)…` 之后**什么都没有**；若该会话从未用到 python，则引导失败全程无提示。叠加 F1，唯一可见错误还是一句不透明的 `failed with exit code N`。
- confidence：**medium-high**（prewarm 吞错为源码事实；"UI 上确实什么都不显示"未在 TUI 里实机看）。

### F6 [P2/P3] uv 安装步骤没有产品级超时
- `run()` 无 timeout（`:647-678`）；`lockTimeoutMs` 只界住"等锁"循环（`:828-830`），拿到锁后的 `uv python install` / `uv venv` / `uv pip install` 完全无界，只受调用方 `AbortSignal` 与上层 kernel 启动/停滞看门狗约束。
- 影响：代理半开、DNS 卡死、TCP 黑洞时首跑长时间静默（用户最后看到的一行是"~30s"），只能靠上层中止。
- **未复现**（未构造黑洞网络），结论为读码得出；confidence：**medium**。

### F7 [P3] uv 获取链缺 pin/校验/镜像，且交互同意提示在真产品路径不可达
- `:79` `curl -LsSf https://astral.sh/uv/install.sh | sh`（无版本 pin、无校验和、依赖 PATH 里的 `sh`）；`:851-883` 只查 PATH 与 `~/.local/bin`；`:858-859`+`:885-898` 的 [Y/n] 提示被 `onProgress`（`ipython.ts:604` 恒给）短路成死代码；`:1323` 用 `"3.11"` 不锁 patch；无镜像/离线开关（②）。
- 影响：供应链面与 SUP-D（fd/rg 走 releases/latest）同类但**独立机制**（decisions.jsonl 未记录 uv 安装器）；企业内网无镜像时首跑只能整机联网到 astral.sh/PyPI；`PRIME_AGENT_INSTALL_UV=1` 是唯一非交互通路。
- confidence：**high**（源码逐字；未实跑 `curl|sh`，避免改动本机 uv）。

---

## 未验证 / 诚实边界

- 黑洞网络下的挂起（F6）——未构造，纯读码。
- win32 全链（`sh -c` 安装器、Scripts 布局、锁目录语义）——本机无 Windows runner，与 X1 记录同源盲区。
- F5 的 UI 侧"什么都不显示"未在 TUI 实机确认（只确认 prewarm 吞错）。
- 真 `curl -LsSf astral.sh | sh` 分支未执行（防止改动本机 uv 安装）；对应 E1 的"uv 缺失"拒绝路径已实测。
- 所用假 uv/假 python 只替代"子进程是否成功"，就绪探针与代际/清单/锁逻辑走的是产品原码，故 F1/F2/F3/F4 的结论不受替身影响；ENOSPC 一条用真 uv + 真小卷。
