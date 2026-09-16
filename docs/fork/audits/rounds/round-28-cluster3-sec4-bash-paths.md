# Round-28 / cluster-3 / SEC-4：env allowlist 剥离 × 全部"产品自身经 bash 拉起"的路径

- 审计基线：**冻结 SHA d6977ad29**（`test: pass the 4606 launcher env inline through the bash allowlist`），SEC-4 修复本体 = a2590d038（经 7ede3da34 合入）。
- 行号一律 **@ d6977ad29**；已用 `grep -n` 逐一核对，与主仓 HEAD 40f781578 的同一批文件**同内容同行号**（HEAD 期间无这些文件的改动落到行号上）。
- 只读审计：未改主仓、未改工作树源码、未跑 `doctor --fix`、未跑 `daemon ps -k`；产物全部在 /tmp 与本席 session artifact 目录。
- 工件（三份落地，见 §9）：`probe.mts` / `drive.mts` / `drive_e2e.mts` / `drive_poscontrol.mts` / `run_*.sh` + 7 个 `.log`。

---

## 0. 结论摘要

1. **SEC-4 的剥离面精确为 9 个 spawn 点**（host 3 + kernel 6，§1 全列）。全仓 `grep -rnE 'sanitizedChildEnv|getShellEnv|mergeExecEnv'`（排除 node_modules/dist）只命中 `utils/shell.ts`、`core/tools/bash.ts`、`core/exec.ts` 三个 src 文件 + 一个测试；kernel 侧只命中 `rlm/bash.py`。**其余所有产品 spawn 都是全量 env 继承**（§5、§7）。
2. **找到 8 类生产断点（P1–P8）+ 1 类次要（P9）**，全部是"产品自己的 CLI/子进程被会话 shell 拉起"这一条通道上的断点，不是测试专属。**4606 那条被修的是测试，生产代码同一形状的三处读法一处没修**（P1 是它的生产版）。
3. 最高危两条：
   - **P1 自更新打错 daemon**：`package-manager-cli.ts:420-422` 用 `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET` 决定"要重启哪个 daemon"，被剥后**静默回落到默认 socket**；`:1845` 的 origin session id 同时丢失。
   - **P2 agentDir 钉子丢失**：`config.ts:801` 读 `PRIME_AGENT_CODING_AGENT_DIR`（产品自己在 `agent-session.ts:12378` 注入的那个），被剥后 `resolveDaemonSocketForAgentDir()`（`daemon-agent-endpoint.ts:33-52`）按**错的 agent dir** 查 owner 注册表 → 明明在跑的 daemon 查不到（ENOENT / "no sessions"），或 `daemon-launch.ts:703` 判定无人拥有此 dir → **再起第二个 daemon**。
4. **红证**：同一份父 env、同一条命令，直连子进程 vs 走**生产 host bash 工具 spawn 路径**（`createLocalBashOperations` → `getShellEnv()`），11 个生产读法全部 BROKEN（`broken_count=11`）；端到端用**出厂 CLI** `prime-agent doctor --json` 复现 → `same_command_same_parent_env=DIVERGENT`。加上 `PRIME_AGENT_ENV_PASSTHROUGH`（12 个名字）→ `broken_count=0`，证明机制就是 allowlist、逃生口可用。
5. **正控**：同一套检测法对**已修的 4606 变量**报红——`test/fixtures/eng-4606-update-launcher.ts` 经生产 bash 工具，pre-fix 形状 exit 1 且报 `Missing PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID`，fixed 形状（inline 赋值）exit 0；已合并的 `4606-update-restart-coordinator.test.ts` 5/5 绿、`exec-env-filter.test.ts` 3/3 绿。
6. **一处需要产品裁决的反向缺口**：SEC-4 把机密挡在 bash 子进程外，但 **`ipython` 工具的 kernel 进程本身是全量 env**（`repl-manager.ts:959-970`，"刻意不动"已核实）——模型写的 Python cell 直接 `os.environ` 就能读到 `PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN` 和各 provider key。本席实测：同一 kernel 进程可见 17 个 `PRIME_AGENT*/RLM_*/PI_*` 名，它的 `bash()` 子进程可见 **0** 个。所以 SEC-4 是"防机密顺手流进第三方命令"的卫生修复，**不是对模型自身的机密性边界**，残余风险要按这个定位评估（§7.6）。

---

## 1. SEC-4 剥离面（精确清单，全仓枚举结果）

### 1.1 allowlist 定义（两张表，19 个键完全一致）

| 位置 | 内容 |
|---|---|
| `packages/coding-agent/src/utils/shell.ts:146-167` | `SHELL_CHILD_SAFE_ENV_KEYS` = HOME PATH SHELL USER LOGNAME LANG LC_ALL LC_CTYPE TZ TMPDIR TEMP TMP SystemRoot WINDIR COMSPEC PATHEXT OS SYSTEMDRIVE USERPROFILE |
| `shell.ts:169` | `SHELL_ENV_PASSTHROUGH_VAR = "PRIME_AGENT_ENV_PASSTHROUGH"` |
| `shell.ts:171-187` | `sanitizedChildEnv()` = 19 键 ∩ process.env + passthrough 名单 |
| `shell.ts:189-201` | `getShellEnv()` = sanitized + **把 `getBinDir()`（= `<agentDir>/bin`，`config.ts:970`）前置到 PATH**（:191） |
| `prime-agent-runtime/src/rlm/bash.py:772-791` | `_CHILD_SAFE_ENV` = **同样 19 键，逐字相同** |
| `bash.py:793-804` | `_ENV_PASSTHROUGH_VAR` + `_passthrough_env()`（同语义） |
| `bash.py:806-810` | `_child_env()` = 19 键 + passthrough + **`NO_COLOR=1 TERM=dumb CLICOLOR=0 FORCE_COLOR=0`** |
| `bash.py:831-832` | `_helper_env()` = `_child_env()` + `NoDefaultCurrentDirectoryInExePath=1` |
| `bash.py:835-840` | `_ps_env()` = `_child_env()` + `LC_ALL=C LC_TIME=C LANG=C TZ=UTC` |

**两表差异（P8）**：kernel 侧钉 `TERM=dumb`/`NO_COLOR`/`CLICOLOR`/`FORCE_COLOR`，host 侧一个都不钉 → **host bash 工具的子进程连 TERM 都没有**（红证 `b.term=null`，父进程是 `xterm-256color`）；host 侧前置 binDir 到 PATH，kernel 侧不前置（与 `docs/fork/audits/2026-09-14-fixes.md:681` 记的"kernel venv bin 不在 PATH"同源）。

### 1.2 被过滤的 spawn 点（host 3 + kernel 6 = 全部）

host（`packages/coding-agent/src`）：
1. `core/tools/bash.ts:105` — `createLocalBashOperations()` 的 `env: env ?? getShellEnv()`。**这一条同时服务三个生产入口**：bash 工具（模型）、`!`/`!!` 用户命令（`agent-session.ts:15110` → `interactive-mode.ts:5090`）、RPC/daemon 客户端 `execute_bash`（`rpc-mode.ts:305`、`daemon-mode.ts:4645/4659`）。
2. `core/tools/bash.ts:163` → `:472` — `resolveSpawnContext()` 的 `env: { ...getShellEnv() }`，spawn 时用 `spawnContext.env`；`spawnHook` 是扩展点（全仓只有 `examples/extensions/bash-spawn-hook.ts:17` 用它，**生产无人往这里注入 session env**，见 P5）。
3. `core/exec.ts:114-127 mergeExecEnv()` → `:153 env: mergeExecEnv(options?.env)` — 唯一生产调用者是扩展 API `ctx.exec`（`core/extensions/loader.ts:265-272`）。

kernel（`prime-agent-runtime/src/rlm/bash.py`）：
4. `:201` 持久 shell `subprocess.Popen(..., env=_child_env())`（POSIX）
5. `:209` win32 job 路径 `spawn_in_job(..., env=_child_env())`
6. `:851` taskkill `_helper_env()`；`:876` powershell `_helper_env()`；`:898` `ps -o lstart=` `_ps_env()`

> `_helper_env`/`_ps_env` 的三个消费者（taskkill / powershell / ps）**不依赖任何被剥变量**，且 `_ps_env` 重新钉死 `LC_ALL/LC_TIME/LANG/TZ`，与 host 侧 `session-lease.ts:206`（`{...process.env, LC_ALL:"C", LC_TIME:"C", LANG:"C", TZ:"UTC"}`）保持同一渲染 → 进程起始时间身份比对不受影响（这是 `timezone-stable-process-identity` 那条旧修复的不变量，已核）。

---

## 2. 生产断点（P1–P9）

> 判定口径：**生产路径 = 真用户/真 agent 会走到的通道**（模型 bash 工具、用户 `!` 命令、RPC/daemon `execute_bash`、扩展 `ctx.exec`）。每条都给"谁读、读什么、被剥后回落到哪、后果"。

### P1 自更新（`prime-agent update --self`）打错 daemon + 丢 origin session —— **4606 的生产版，未修**

- 读点：
  - `package-manager-cli.ts:420-422` `resolveUpdateDaemonSocketPath()` = `explicit ?? process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] ?? defaultDaemonSocketPath()`
  - `package-manager-cli.ts:1812` 调用它拿 `daemonSocketPath`；`:1813` 用它 `probeRunningDaemonSessions()`；`:1845` `originActiveSessionId: process.env[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV]`
  - `cli/daemon-update-restart.ts:548` `const inheritedOrigin = process.env[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV]`（**同一个变量的第二处读**）
- 这两个变量在真 worker 里确实存在（`daemon-supervisor.ts:3926-3938` 给 worker 注入 `DAEMON_WORKER_SUPERVISOR_SOCKET_ENV` / `DAEMON_WORKER_ACTIVE_SESSION_ID_ENV`；本席自己 env 里两个都有）。
- 触发：**会话内跑 `prime-agent update --self`**——模型用 bash 工具跑、用户 `!prime-agent update` 跑、或 RPC 客户端 `execute_bash` 跑。4606 测试的 `it("outlives a daemon-owned updater ...")` 建模的正是这条链（fixture 经 `execute_bash` 拉起 → `launchDaemonUpdateRestartCoordinator`）。
- 后果（自定义 socket 的 daemon，即 `--daemon-socket` 非默认、或客户端在外来 `$TMPDIR`）：
  1. `probeRunningDaemonSessions()` 探到的是**默认 socket**（`$TMPDIR/prime-agent-<uid>/daemon.sock`）→ `confirmDaemonSessionLossBeforeUpdate()` 基于错的会话数（常见为 0 → 直接跳过确认）；
  2. `launchDaemonUpdateRestartCoordinator()` 停/起的是**错的那个 daemon**（或对不存在的 socket 报 `skipped`），真正拥有本会话的 daemon **继续跑旧代码**，用户却看到 "Updated prime-agent"；
  3. origin session id 丢失 → 协调器不带 `--internal-update-restart-origin`，**发起更新的那个会话收不到 `prime-agent.update_complete`**（正是 4606 测试断言的那条 custom message），也不按 origin 恢复。
- 红证：`probe_direct_vs_bashtool.log` 第 1、2 行 `BROKEN`：`a="/tmp/.../custom-daemon.sock"` → `b="/var/folders/.../T/prime-agent-501/daemon.sock"`；`a="abc123def456"` → `b=null`。

### P2 agentDir / sessionDir 钉子丢失 → 嵌套 CLI 全线打错目录，可能再起一个 daemon

- 读点：`config.ts:801-807 getAgentDir()` 读 `ENV_AGENT_DIR = PRIME_AGENT_CODING_AGENT_DIR`（`config.ts:778`）；`config.ts:983-986 getSessionDirEnvOverride()` 读 `PRIME_AGENT_SESSION_DIR`（+ legacy 名）。
- 这个 pin **是产品自己注入的**：`agent-session.ts:12376-12379`（`_addWebsearchKeyEnv`）`env.PRIME_AGENT_CODING_AGENT_DIR = this._agentDir` → 进 kernel env（`agent-session.ts:12029`）；worker 侧由 `createCliSubprocessEnv()`（全量继承）带着。
- 被剥后的下游消费者（全部按错目录工作）：
  - `modes/daemon/daemon-agent-endpoint.ts:33-52 resolveDaemonSocketForAgentDir()` ← `main.ts:1417`（**所有不带 `--daemon-socket` 的 client 命令**）、`cli/daemon-command.ts:148`、`cli/daemon-launch.ts:703`
  - `cli/daemon-ps.ts:995` `findLiveDaemonOwnersForAgentDir(getAgentDir())`（doctor/`daemon ps` 的服务表）
  - `cli/daemon-stop-scope.ts:116`（stop/shutdown 的范围解析）
  - `cli/doctor-checks.ts:48-56 resolveDoctorCheckRoots()`（auth.json / kernel-venv / sessions 三个根）
  - `config.ts:970 getBinDir()` = `<agentDir>/bin`、`getAuthPath()`、`getSessionsDir()`、`getLogsDir()`
- 后果：`daemon-agent-endpoint.ts:16-31` 的文档自己写明了这条不变量——默认 socket 名"names a *shell*, not a daemon"，所以要用 agentDir 注册表兜底。agentDir 一错：① 默认 socket 没在听时（自定义 socket / 外来 `$TMPDIR`）**查不到 owner → 报 ENOENT / "no sessions"，而 daemon 好好在跑**；② `daemon-launch.ts:703` 判定"没有 daemon 拥有这个 agentDir" → **再起第二个 daemon**；③ `doctor` 体检的是**另一个目录**（红证里可见）。
- 红证：`e2e_doctor.log`（出厂 CLI，同命令同父 env）：
  - (a) 直连：`no auth.json found at /tmp/.../red_proof/agentdir/auth.json`、`PRIME_AGENT_KERNEL_PYTHON points at a usable interpreter at ...`、`0 session file(s) scanned`
  - (b) 经生产 bash 工具：`no auth.json found at /tmp/.../red_proof/home/.prime/agent/auth.json`、`no kernel venv found at .../home/.prime/agent/kernel-venv`、`no sessions directory at .../home/.prime/agent/sessions`
  - `same_command_same_parent_env=DIVERGENT`

### P3 文档化的隐私 opt-out 在嵌套 CLI 里静默失效（仓内自定义为 bug）

- 读点：`utils/privacy-opt-out.ts:15-16, 47-56`（`DO_NOT_TRACK` / `PI_OFFLINE`）、`core/telemetry.ts:192`（PI_OFFLINE）、`:195`（DO_NOT_TRACK）、`:198`（`PRIME_AGENT_TELEMETRY`）、`:311`（endpoint）；`core/agent-traces.ts:951-952, 1254` 用同一对开关当"standing do-not-call-home answer"闸自动上传。
- 三个名字**都不在 allowlist**。而 `privacy-opt-out.ts:1-13` 的注释是硬话："Both are read here so that every background outbound path — the startup release check, pseudonymous telemetry and automatic trace sharing — answers the same way, and **a path that ignores them is a bug instead of a policy choice**."
- 用户文档面：`docs/settings.md:91`（`PRIME_AGENT_TELEMETRY=0 prime-agent`）、`README.md:685-686`、`agent-session-services.ts:117`（"Disable this with telemetry.enabled=false, PRIME_AGENT_TELEMETRY=0, DO_NOT_TRACK=1, or offline mode"）。
- 后果：只用 env 关遥测/开离线的用户，一旦会话内起了任何 `prime-agent` 子进程（P1/P2 的同一通道），该子进程**回到默认：遥测开、startup release check 开、trace 上传闸看不到 opt-out**。（用 `settings.json` 关的不受影响——文件不走 env。）
- 红证：probe 第 5、6 行 `BROKEN`：`backgroundNetworkOptOut() a="DO_NOT_TRACK" → b=null`；`PRIME_AGENT_TELEMETRY a="0" → b=null`。

### P4 代理变量丢失 → 会话内自更新/嵌套 CLI 的网络调用直接失败

- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`（+ 小写三名）不在 allowlist（`packages/ai/src` 与 `coding-agent/src` 都有读点，见 §5.4 清单）。
- 后果：需要代理才能出网的环境里，会话内 `prime-agent update`（→ `package-manager.ts:2559/2573/2640` 的 npm 子进程用 `getEnv()` = **它自己那份已被剥的 process.env**）与任何嵌套 CLI 的联网（release check、npm、git https）全部失败，报错指向 npm/网络而非 env。
- 红证：probe 第 7 行 `BROKEN`（`a="http://proxy.internal:3128" → b=null`）。

### P5 `DAEMON_CLIENT_ENV_KEYS`（HERDR_*）只在 exec.ts 生效，bash 工具不生效 —— 双通道语义不一致

- 产品有一套**按会话下发**的 exec env：`modes/daemon/daemon-protocol.ts:436-441`（`HERDR_ENV/HERDR_PANE_ID/HERDR_SOCKET_PATH/HERDR_TAB_ID/HERDR_WORKSPACE_ID`）→ `daemon-client-env.ts:24-38 execEnvForSession()`，其文档自称 "**Exec env for a session's subprocesses**: pins every allowlisted key to the session's value"，并由 `daemon-extension-binding.ts:55` 挂到 session 上。
- 实际只有一条通道消费它：`extensions/loader.ts:265-272`（`ctx.exec` → `execCommand(..., env: {...sessionEnv, ...options.env})` → `exec.ts:120` 在 sanitized 基座上叠回）。**bash 工具（`bash.ts:105/163`）完全没有这条通道**（`spawnHook` 生产无人用）。
- 后果：herdr pane 里的会话，扩展 `ctx.exec` 跑的命令有 pane identity，模型/用户跑的 bash 命令**没有** → 任何 herdr 感知脚本/CLI 在 bash 通道里认不出自己在哪个 pane。
- 红证：probe 第 8 行 `BROKEN`（`HERDR_PANE_ID a="pane-7" → b=null`）。

### P6 kernel 解释器 / venv / 下载源钉子丢失

- `PRIME_AGENT_KERNEL_PYTHON`（`doctor-checks.ts:52`、`core/kernel/bootstrap.ts`）、`PRIME_AGENT_KERNEL_VENV`、`PRIME_AGENT_DOWNLOAD_BASE_URL`、`PRIME_AGENT_INSTALL_UV`、`PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL` / `..._TOOLS_ON_INSTALL` 全部不在 allowlist。
- 后果：会话内起的嵌套 `prime-agent`（或 `doctor`）**忽略用户钉的解释器/venv/镜像**，改走默认下载源现场 bootstrap —— 慢，且在镜像/内网/防火墙环境直接失败。
- 红证：`e2e_doctor.log` 的 `kernel-venv` 一行（(a) "points at a usable interpreter at ..." vs (b) "no kernel venv found at ..."）+ probe 第 9 行 `BROKEN`。

### P7 `RLM_*` 递归账本丢失（纵深防御退化，不是功能断）

- `RLM_DEPTH` / `RLM_MAX_DEPTH` / `RLM_MAX_CHILDREN` 被剥（消费者：`session-manager.ts:1269`、`agent-session.ts:1949`、`:14142` 的深度上限报错）。
- 正规 `rlm()` 派生**不受影响**：`agent-session.ts:12353-12372 _rlmKernelEnv()` 自己写 `RLM_DEPTH`/`RLM_MAX_DEPTH`/`RLM_SESSION_DIR`，不靠继承。
- 后果：从会话 shell 直接起 `prime-agent ...` 形成的嵌套谱系**从 depth 0 重新计数**，`RLM_MAX_DEPTH` 天花板不再约束这条谱系（SEC-4 的注释把 RLM_* 归为"recursion bookkeeping 不该外流"，但外流的副作用是深度账本断代）。
- 红证：probe 第 10 行 `BROKEN`（`RLM_DEPTH a="2" → b=null`）。

### P8 两张表不一致：host 侧 TERM 缺失（kernel 侧钉 `TERM=dumb`）

- 见 §1.1 差异段。host bash 工具的子进程**没有 TERM**：curses/pager/`tmux`/`tput`、以及产品自己的 TUI 主题判定（`modes/interactive/theme/theme.ts:212` `process.env.TERM || ""`、`packages/tui/src/terminal-image.ts:44`）在子进程里都会退化或报错。
- 附带：`NO_COLOR/CLICOLOR/FORCE_COLOR` 也只有 kernel 侧钉，host 侧不钉 → 子进程可能输出 ANSI 色码进 transcript。
- 红证：probe 第 11 行 `BROKEN`（`TERM a="xterm-256color" → b=null`）。

### P9（次要）`PRIME_AGENT_BUILD_ID` / `PRIME_AGENT_LAUNCHER_PATH` 丢失 → 运行时身份漂移

- `modes/daemon/daemon-runtime-identity.ts:14-23`：`buildId = env[PRIME_AGENT_BUILD_ID] ?? bundledBuildId() ?? release-<VERSION>`，`launcherPath` 直接来自 env；`cli/subprocess-launch.ts:38-45 formatCurrentCliCommand()` 也读 `PRIME_AGENT_LAUNCHER_PATH`。
- 这两个由 `prime-agent.sh:5-8` 导出（本 fork 的免构建入口）。用 `prime-agent.sh ...` 当命令时脚本会**自己重新导出**（自愈）；走 binDir shim / 已安装二进制时就丢 → 嵌套 CLI 报的 build id 与它在talk 的 daemon 不一致（`r19-status-build-id` 那条链的输入被改）。
- 未单独做红证（P1/P2 已覆盖同一通道）；机制与 probe 第 9/10 行同类。

---

## 3. 红证（可执行，全部已跑通两次：删除前 + 02:4x 重建导出后）

工件目录：`/tmp/r28_c3_own/`（私有，权威副本）、`<session-artifact>/sec4-red-proof/`、`/tmp/audit_r/round-28/red_proof/`。

| 脚本 | 干什么 | 结果 |
|---|---|---|
| `probe.mts` | 只 import 生产函数（`config.getAgentDir/getSessionsDir`、`package-manager-cli.resolveUpdateDaemonSocketPath`、`privacy-opt-out.backgroundNetworkOptOut`）+ 直读 8 个 env 名，打印 JSON | — |
| `drive.mts` + `run_red.sh` | (a) 直连子进程（模拟 worker env）vs (b) **`createLocalBashOperations().exec()`**（= `bash.ts:105` 生产 spawn 路径） | **`broken_count=11`**，两个"该剥的"（SERPER_API_KEY / SSH_AUTH_SOCK）`OK-stripped` → 证明探针不误报 |
| `run_red_passthrough.sh` | 同 (b)，父 env 加 `PRIME_AGENT_ENV_PASSTHROUGH=`12 个名字 | **`broken_count=0`**，机密仍 `OK-stripped` → 机制确认为 allowlist，逃生口有效 |
| `drive_e2e.mts` + `run_e2e.sh` | **出厂 CLI** `prime-agent doctor --json`（只读；HOME/TMPDIR/agentDir 全沙箱化）同命令同父 env 两跑 | **`DIVERGENT`**：(a) 读沙箱 agentdir + 认 KERNEL_PYTHON 钉子；(b) 读 `$HOME/.prime/agent` + 钉子消失 |
| `drive_poscontrol.mts` + `run_poscontrol.sh` | 4606 launcher fixture 经生产 bash 工具，pre-fix vs fixed 形状 | (1) `exitCode=1` + `Missing PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID`；(2) `exitCode=0` |
| `run_tests.sh` | 两个相关 suite（按仓测试卫生 unset 泄露变量） | `4606-update-restart-coordinator.test.ts` **5 passed (11.2s)**；`exec-env-filter.test.ts` **3 passed** |
| `kernel_child_env.log` | 活体证据：本席（真 daemon worker，depth 2）的 kernel `bash()` 子进程 | `grep -cE '^(PRIME_AGENT\|RLM_\|HERDR\|PI_)'` = **0**；子进程可见键只有 `_ CLICOLOR COMPOSER_PLATFORM_CHECK FORCE_COLOR HOME LANG LOGNAME NO_COLOR PATH PWD SHELL SHLVL TERM TMPDIR USER` |
| `kernel_vs_child_asymmetry.log` | 同一 kernel 的**进程内** os.environ | **17** 个 `PRIME_AGENT*/RLM_*/PI_*` 名可见（含 `PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN`，值未打印）→ §7.6 |

复跑命令（任意一条，≤60s）：
```
bash /tmp/r28_c3_own/run_red.sh          # broken_count=11
bash /tmp/r28_c3_own/run_e2e.sh          # DIVERGENT
bash /tmp/r28_c3_own/run_poscontrol.sh   # (1) exit 1 Missing ... / (2) exit 0
bash /tmp/r28_c3_own/run_tests.sh        # 5 passed / 3 passed
```

---

## 4. 正控（负结论的可检出性证明）

1. **同法检出已知断点**：`drive_poscontrol.mts` 用的是**生产 spawn 路径 + 已修的 4606 fixture + 已修的 4606 变量**。把 d6977ad29 的 inline 前缀去掉（= pre-fix 形状）→ `exitCode=1`，错误串正是 `Missing PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID`；加回 inline（= fixed 形状）→ `exitCode=0`。即：**我的检测方法对"这条已知曾经红过的路径"确实报红、对修好的形状确实报绿**。
2. **合并态绿**：`test/suite/regressions/4606-update-restart-coordinator.test.ts` 5/5 passed（含那条 180s 上限的重活，实测 6.7s）；`test/exec-env-filter.test.ts` 3/3 passed（其中一条专测 `PRIME_AGENT_ENV_PASSTHROUGH` 转发）。
3. **探针自带阴性对照**：`drive.mts` 的 `intended strip` 两行（SERPER_API_KEY / SSH_AUTH_SOCK）在 (b) 必须为 null —— 实测 `OK-stripped`，说明 11 个 BROKEN 不是"整个 env 都没传"的假阳性（PATH/HOME/LANG/... 确实传到了，`getShellEnv()` 7 个键在日志首行打印）。
4. **逃生口对照**：passthrough 一开，11 个 BROKEN 全部转 `unchanged` 而机密仍被剥 → 排除"父 env 本身没设"这类环境性假红。

---

## 5. 负结论：这些路径**没有**断点（附扫过的调用链）

> 判据：该 spawn 点的 env **不来自** §1.2 的 9 个过滤点（即全量 `process.env` 继承或自建 env），且它读的东西不依赖被剥变量。

### 5.1 doctor（`prime-agent doctor` / `doctor --fix`）
- 只读体检 `cli/doctor-checks.ts` **全文 0 个 spawn/exec**（纯 `existsSync/readFileSync/readdirSync/accessSync` + `SESSION_ID_PATTERN` 解析），三根来自 `resolveDoctorCheckRoots()`。
- `cli/public-command.ts:383-411 runDoctor()`：`--json` 走 `collectReadonlyDoctorChecks()` + `discoverDaemons()`；非 json 加 `runPs(false)`；`--fix` 走 `runReap()`。
- `cli/daemon-ps.ts:710/714/717/721/791/1960` 的 `ss`/`lsof`/`ps` 与 `orphan-process-journal.ts:676-682` 的绝对路径 `taskkill.exe`（`env: {...process.env, NoDefaultCurrentDirectoryInExePath:"1"}`）**全部未过滤**。
- 结论：doctor 自身没有 env 断点；它受影响的只是**输入**（P2 的 agentDir、P6 的 KERNEL_PYTHON），已由 `e2e_doctor.log` 定量。
- 正控：同一份 `doctor --json` 在 (a)/(b) 输出 DIVERGENT → 证明这条链的检出能力（不是"扫过没发现"而是"扫过并测过"）。

### 5.2 worktree / git
- **产品没有 git-worktree 工具**：`grep -rn worktree packages/coding-agent/src` 只命中 `utils/git.ts:205` 的一句注释（".git 是文件还是目录"）与 `cli/daemon-ps-format.ts`；`scripts/preflight-push.sh` 是开发脚本，跑在用户 shell。
- `utils/git.ts:251-258 runGit()` = `spawnSync("git", ["--no-optional-locks", ...])`，**无 env 选项** → 全量继承；`core/footer-data-provider.ts:9/21`（`git symbolic-ref` / `execFile`）同。
- `core/package-manager.ts:6-23 getEnv()`（linux `/proc/self/environ` 兜底）→ `:2559/2573/2640` 的 npm/git 子进程全量；`:1639-1646 runGitRemoteCommand` 只额外加 `GIT_TERMINAL_PROMPT=0`。

### 5.3 install.sh / prime-agent.sh / scripts/*
- 三者都跑在**用户自己的 shell**，产品不经 §1.2 的任何一点拉起它们（`grep -rn 'install.sh' packages/coding-agent/src` 只出现在自更新失败的**提示文案**里，`printSelfUpdateFallback`）。
- `install.sh:1606/1609` 的 `env "$@" npm install -g` 只在用户执行 install.sh 时到达。
- `prime-agent.sh:5-8` 导出 `PRIME_AGENT_LAUNCHER_PATH` / `PRIME_AGENT_BUILD_ID`：脚本自身是入口时会重新导出（自愈），只有走 binDir shim 才丢 → 归 P9，不算 install/launcher 断点。
- `scripts/`（bench-*、check-*、release.mjs、browser-smoke、render-logo.py、setup-kernel-venv.sh 等）与 tmux 助手：CI/开发 shell 路径；仓内 tmux 只有 `modes/shared/startup-notices.ts:74`（`spawnSync("tmux", ["show","-gv",option])`，全量 env）与 `test/startup-notices.test.ts`（mock）。

### 5.4 MCP stdio server 拉起（任务点 5：对比 `_SAFE_ENV`）
- kernel `rlm/mcp.py:28` `_SAFE_ENV = ("HOME","PATH","TMPDIR","TEMP","TMP","SystemRoot","WINDIR")` —— **7 键，是 bash 表（19 键）的真子集**，且**没有** `PRIME_AGENT_ENV_PASSTHROUGH` 通道。
- `rlm/mcp.py:604-620 _stdio_env()` = `_SAFE_ENV` + **配置里显式的 `{"env": "NAME"}` 引用**（从 kernel 全量 `os.environ` 取值；缺失即 `ValueError`，fail-closed），ACP 场景允许直给字符串。
- host 侧**不 spawn** stdio MCP（`core/mcp/mcp-manager.ts` 只分类配置/查 bearer token，`mcp-command.ts:107-149` 只组装配置），所以 host allowlist 与 MCP 无交集。
- 结论：**MCP 无断点**（用户配置的凭据走"显式引用"而非环境继承）；但 `bash.py:769-771` 注释里 "Mirrors `rlm.mcp._SAFE_ENV`" 只是**近似成立**（bash 表是超集 + passthrough + TERM/NO_COLOR），MCP 表少 LANG/LC_*/TZ/SHELL/USER/COMSPEC/PATHEXT/OS/SYSTEMDRIVE/USERPROFILE，且无逃生口 —— 建议改注释或对齐两表（文档级）。

### 5.5 kernel / worker / daemon supervisor 的子进程（任务点："刻意不动"核实）
逐个核过 env 实参，**没有一个走 shell.ts / exec.ts / bash.py 的过滤**：
- `core/kernel/repl-manager.ts:959-970`：`spawn(python, [...KERNEL_PYTHON_SAFE_PATH_ARGS, "-m","rlm.repl"], { env: { ...process.env, ...this.options.env, [KERNEL_PROTOCOL_ENV_VAR]:..., PRIME_AGENT_KERNEL_OWNER_PID:... } })` → **确实"刻意不动"**，kernel 保留全量 env（`RLM_*`、`PRIME_AGENT_INTERNAL_*`、`SERPER_API_KEY`、`PRIME_AGENT_CODING_AGENT_DIR`），因此 in-kernel skills（`rlm/harness.py:52-53`、`rlm/mcp_base.py:74-75`、`skills/websearch/.../websearch.py:23-24` 都读 `PRIME_AGENT_CODING_AGENT_DIR`）**不受影响**；也**不受 shell.ts 影响**（shell.ts 只在 bash 工具/exec 的 spawn 上生效，kernel spawn 不经它）。
- `core/kernel/bootstrap.ts:654-655`（`env: process.env`）、`core/tools/ipython.ts:557-561`（构造 `ReplKernelManager` 的 `env`，只加 `PRIME_AGENT_BASH_SHELL` / `PRIME_AGENT_BASH_COMMAND_PREFIX`）。
- `modes/daemon/daemon-supervisor.ts:3925-3946`（worker：`createCliSubprocessEnv({...process.env, ...launchEnv, 8 个 PRIME_AGENT_INTERNAL_*})`，另 `delete RLM_DEPTH`）、`:9405-9419`（替换 supervisor，逐个 delete 内部变量）。
- `modes/daemon/daemon-mode.ts:953-966`、`cli/daemon-launch.ts:476-487`、`cli/daemon-command.ts:717-720`（`env: process.env`）、`cli/owned-session-worker.ts:338-341`、`modes/daemon/daemon-catalog-process.ts:397-414`、`cli/daemon-update-restart.ts:526-562`（`coordinatorEnvironment()` = 全量 env 减 9 个内部名）、`modes/interactive/interactive-mode.ts:9078-9086`（`updateEnv` = 全量 + `SELF_UPDATE_INTERACTIVE_CHILD_ENV`）与 `:9149-9153`（relaunch，`env: process.env`）、`modes/rpc/rpc-client.ts:106-108`。
- 结论：这些**自身没有断点**；但它们**继承断点**——当它们的父进程本身就是 §1.2 的过滤子进程时（P1/P2/P3 的传导方式），`{...process.env}` 复制的是那份已被剥的 env。

### 5.6 其余全量继承的 spawn 点（一并扫过，无断点）
`core/autonomous.ts:497`（`runChildProcess`，无 env 选项）、`core/session-lease.ts:164/173/206`、`core/session-file-actions.ts:84`（trash）、`core/resolve-config-value.ts:63/92`、`core/model-registry.ts:527`、`config.ts:445`、`utils/child-process.ts:42`、`utils/clipboard.ts:14-94`、`utils/clipboard-image.ts:82-85`、`utils/tools-manager.ts:188/380`、`utils/shell.ts:19/34/277`、`modes/shared/startup-notices.ts:74`、`modes/interactive/interactive-mode.ts:7643`（$EDITOR）/`9368`（gh auth）/`9480`（gh gist）、`modes/interactive/components/extension-editor.ts:112`、`components/login-dialog.ts:185`、`modes/daemon/windows-named-pipe.ts:54/123`、`cli/daemon-ps.ts:710-791/1960`、`packages/tui/src/autocomplete.ts:164`（fd）、`packages/tui/src/tui.ts:843`。
- 正控：这批的"未过滤"结论由 §1 的穷举 grep 支撑（`sanitizedChildEnv|getShellEnv|mergeExecEnv` 全仓只 3 个 src 文件命中；kernel 侧 `_child_env()|_helper_env()|_ps_env()` 只 5 个调用点），且 §3 的 (b) 通道对**同一条命令**能报红 → 检出能力已证。

---

## 6. 三张表逐字对比

| | host `SHELL_CHILD_SAFE_ENV_KEYS`（shell.ts:146） | kernel `_CHILD_SAFE_ENV`（bash.py:772） | kernel MCP `_SAFE_ENV`（mcp.py:28） |
|---|---|---|---|
| 键数 | 19 | 19（**逐字相同**） | 7（真子集） |
| passthrough | `PRIME_AGENT_ENV_PASSTHROUGH`（shell.ts:169/179） | 同（bash.py:793-804） | **无**（改用配置 `{"env":"NAME"}` 显式引用） |
| 额外注入 | binDir 前置 PATH（shell.ts:191-198） | `NO_COLOR=1 TERM=dumb CLICOLOR=0 FORCE_COLOR=0`（bash.py:809） | 无 |
| TERM | **缺失**（P8） | `dumb` | 缺失 |
| 差异风险 | 子进程无色/无 TERM 语义两边走不同路 | | MCP 子进程拿不到 LANG/LC_*/TZ（对日期/编码敏感的 server 可能行为不同） |

---

## 7. 反向缺口（SEC-4 未覆盖的 spawn 面，与"剥离"方向相反）

1. `core/resolve-config-value.ts:63/92`：settings 里 `!command` 形式的取值（常用来从密码管理器取 key）用 `spawnSync(shell,...)` / `execSync` **全量 env** → 用户自己写的命令能看到 worker 全部机密。`core/model-registry.ts:527` 同形。是否有意需产品裁（用户自declared vs 模型 authored 的信任差别），但**与 SEC-4 的信任模型不一致**，建议至少在 docs 里写明。
2. `core/autonomous.ts:497`、`core/package-manager.ts:2559/2573/2640`（npm/git，含**第三方 npm postinstall**）→ 全量 env。npm postinstall 属于 SEC-4 注释点名的"third-party code"，但走的是 package-manager 通道，不在 allowlist 覆盖内。
3. `examples/extensions/subagent/index.ts:274`：`spawn(invocation.command, invocation.args, {...})` **无 env 选项** → 这个官方示例扩展起嵌套 `pi`/`prime-agent` CLI 时用全量 env（与 4606 同类形状，但走未过滤通道，因此"能跑"）；`examples/extensions/interactive-shell.ts:167` 显式 `env: process.env`；`sandbox/index.ts:142`、`truncated-tool.ts:66`、`ssh.ts:27/64`、`notify.ts:38`、`overlay-qa-tests.ts:468` 同类。示例不是出厂件，但它们是文档化的复制起点。
4. `modes/rpc/rpc-client.ts:106-108`：`env: {...process.env, ...this.options.env}` 起 CLI 子进程 → 全量。
5. **`PRIME_AGENT_ENV_PASSTHROUGH` 只在 `.changes/r27-sec-env-auth.md:2` 出现**：README 的 env 表（`packages/coding-agent/README.md:680-690` 一带）、`docs/settings.md`、`docs/security.md` **都没有**它，也没写"会话内子进程会丢哪些 env"。唯一的逃生口没有用户文档 → P1–P6 全部只能靠读代码发现。
6. **`ipython` kernel 进程 = 模型作者代码 + 全量 env**（`repl-manager.ts:959-970`，见 §5.5）：本席活体实测同一 kernel 内 `os.environ` 可见 `PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN`、`PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET`、`RLM_*` 共 17 名，而它的 `bash()` 子进程 0 名。所以模型只要 `os.environ` 一读、再显式拼进 bash 命令，allowlist 就绕过了。**SEC-4 的实际保证应表述为**："机密不会*被动*流进第三方命令"，而不是"模型拿不到机密"。这一点建议在 `docs/security.md` 里写明，避免下游把它当沙箱用。

---

## 8. 修复建议（按代价排序，均为最小面）

- **A（一行级，覆盖 P1/P2/P3/P4/P6/P8/P9）**：两张 allowlist 同时补"运行必需且非机密"的名字：
  `PRIME_AGENT_CODING_AGENT_DIR`、`PRIME_AGENT_SESSION_DIR`、`PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET`、`PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID`、`DO_NOT_TRACK`、`PI_OFFLINE`、`PRIME_AGENT_TELEMETRY`、`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`（+ 小写三名）、`TERM`、`PRIME_AGENT_KERNEL_PYTHON`/`PRIME_AGENT_KERNEL_VENV`/`PRIME_AGENT_DOWNLOAD_BASE_URL`、`PRIME_AGENT_LAUNCHER_PATH`/`PRIME_AGENT_BUILD_ID`。
  **不要**加：`PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN`、provider keys、`SSH_AUTH_SOCK`（SEC-4 的核心意图）；`RLM_*` 建议也不加（见 B/C 的替代）。
- **B（消 P5 的双通道）**：把 `DAEMON_CLIENT_ENV_KEYS`（HERDR_*）并进 `sanitizedChildEnv()`，或让 bash 工具与 `ctx.exec` 共用 `execEnvForSession()` 同一条通道（单一真源），否则"session 的 subprocess env"这句文档只对一半通道成立。
- **C（消 P7 的静默断代）**：要么在 `RLM_DEPTH` 存在时被剥的谱系里显式报错/警告（"从会话 shell 起的 CLI 是新谱系，深度上限不继承"），要么把 `RLM_DEPTH`/`RLM_MAX_DEPTH` 视为非机密账本放行（它们不是凭据，只是整数）。
- **D（消 P1 的静默错靶）**：`resolveUpdateDaemonSocketPath()` 在"自己是 daemon worker 的后代但 env 里没有 supervisor socket"时**不要静默回落默认 socket**——要么要求显式 `--daemon-socket`，要么把回落打成 warning（并让协调器状态里记 `socket_source: "default-fallback"`）。同理 `daemon-agent-endpoint.ts:33-52` 在 agentDir 来自回落值时应可观测。
- **E（文档）**：README env 表 + `docs/security.md` + `docs/settings.md` 补 `PRIME_AGENT_ENV_PASSTHROUGH`（含"哪些名字被剥、怎么加回、passthrough 必须在 daemon 启动前设好"），并写明 §7.6 的残余风险边界。
- **F（一致性）**：host 侧钉 `TERM`（哪怕 `dumb`）与 `NO_COLOR`，或 kernel 侧去掉；两表在注释里改成"19 键一致 + 各自的额外注入"，MCP 表单独说明（§6）。

---

## 9. 事故与纪律记录

- **02:35–02:37 之间外部把 `/tmp/audit_r` 与 `/tmp/wt_r28` 整体删除**（parent 已确认同现象，另一子席报告也被删）。本席全部红证在删除**之前**已跑完并被 kernel 变量捕获，逐字落盘，无结论损失。
- 为让脚本可复跑，用 `git -C /Users/a1/Desktop/ai/prime-agent archive d6977ad29 | tar -x -C /tmp/wt_r28` **只读重建**了同 SHA 的导出（+ node_modules symlink + `.audit-export-sha` 标记文件说明来历），并在 02:4x 用它把四条红证**全部重跑一遍，结果逐字一致**（`REPRO_after_tmp_sweep.log`）。未对主仓写入任何东西；**未触碰 `/tmp/audit_r/round-28/wt_impl`（另一条 impl 车道的 worktree）**。
- 产物三份：① 本席 session artifact `.../sub-e06e1638/sec4-red-proof/`（权威）② `/tmp/r28_c3_own/`（parent 指定的私有目录）③ `/tmp/audit_r/round-28/red_proof/` + 本报告 `/tmp/audit_r/round-28/cluster3-sec4-bash-paths.md`。
- 纪律自查：未改主仓、未改工作树源码；未跑 `doctor --fix`；未跑 `daemon ps -k`；单命令 ≤60s（重活全部 `bash()` handle 后台 + 轮询）；`doctor --json` 为只读，会 probe 本机 9 个 daemon 的 hello/list（无写入），且 HOME/TMPDIR/agentDir 全沙箱化——真实 `~/.prime/agent/update-restarts` 的 mtime 仍是 8 月 24 日，未被本席触碰。
- 未验证项（诚实标注）：① P4/P6/P9 只做了"变量确实拿不到"的红证，没有真的在代理/镜像环境跑一次失败的 `npm install -g`（避免联网副作用）；② P5 的 herdr 侧真实消费者不在本仓，只能证明"产品自己的 per-session exec env 契约在 bash 通道不生效"；③ P1 的"重启错 daemon"没有在真双 daemon 环境端到端跑（会动活的 daemon），证据链是代码路径 + socket 解析红证 + 4606 测试对同一条链的既有断言。
