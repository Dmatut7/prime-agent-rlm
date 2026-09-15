# win32 已知限制（known limits）

> 基线：R8 跨平台审计线（`docs/fork/audits/2026-09-14-fixes.md` "跨平台" 一节，X1–X6）。
> 本仓 CI 只有 Linux runner（platform-coverage gate 如实列 `NO RUNNER: bash-close-hang-windows.test.ts`），
> 所以本页所有 win32 结论都是读码级验证（unverified-by-runner）。
>
> 2026-09-15 裁决（记于 decisions.jsonl X6 resolution）：不申请 Windows runner；
> 只盲修"便宜且可盲修"的 X1/X4，其余四条按已知限制登记在本页。

## 已盲修（本轮，r21/win32-fixes）

- **X1（P1）**：内核 venv 解释器路径。`bootstrap.ts` 原来两处 `path.join(venv, "bin", "python")`，
  win32 上 uv 产出的是 `Scripts\python.exe` ⇒ 就绪探测恒 false、内核永不启动。
  修法：新增 `kernelVenvInterpreter(venv)`（win32 → `path.win32.join(venv, "Scripts", "python.exe")`，
  对齐 `venv-in-use.ts` 已认 bin|scripts 的先例与 `doctor-checks.ts` 的 `kernelInterpreterRelativePath`）。
  红测：`test/kernel-venv-interpreter-win32.test.ts`（纯函数级：安装参数含 `Scripts\python.exe`）。
  局限：无 runner，字面值级验证。
- **X4（P3）**：`shell.ts killProcessTree` 裸名 `taskkill` 且无 `error` 监听。
  修法：照 `orphan-process-journal.ts killOrphanProcess` 的 hardened 形状改为绝对
  `System32\taskkill.exe`（`SystemRoot ?? C:\Windows`）+ `NoDefaultCurrentDirectoryInExePath=1` + `error` 监听。
  红测：`test/kill-process-tree-win32.test.ts`（mock spawn 断言绝对路径与 error 监听）。

## 登记不修（X2 / X3 / X5 / X6）

### X2（P2）win32 优雅退出整层空转

- **现象**：Windows 上关控制台窗口 / 任务管理器结束时，清理逻辑不跑，bash 子进程泄漏。
- **根因**：Node 在 win32 上 `process.kill(pid, 'SIGTERM')` 是无条件终止、监听器收不到；
  而仓内 5 处 `win32 不注册 SIGHUP`（`print-mode.ts:83`、`rpc-mode.ts:200`、`daemon-supervisor.ts:9157`、
  `daemon-mode.ts:7714`、`interactive-mode.ts:7169`）恰好关掉了 Windows 关窗时**唯一**会投递的信号；
  `SIGBREAK`（win32 的 Ctrl+Break 等价物）全仓 0 监听。
- **影响面**：所有 win32 用户的优雅退出路径（关窗、kill、Ctrl+Break）；POSIX 不受影响。
- **为什么现在不修**：正确修法要重排整层信号语义（补 SIGBREAK/SIGHUP-on-win32、把 SIGTERM 假象换成
  Windows 控制台事件 API），跨 5 个 mode 文件，无 runner 无法验证回归；属结构性改动而非盲修。
- **解除条件**：有 Windows runner（CI-3 解除）后按 mode 逐个补 `SIGBREAK`/关窗信号注册并跑
  `bash-close-hang-windows.test.ts` 一族验证。

### X3（P2）win32 daemon 发现盲

- **现象**：win32 上 `status` / `doctor` / `shutdown` 打 "No background services found." 且 exit 0，
  一个 daemon 都不停。
- **根因**：`daemon-ps.ts` 两个发现源都 POSIX-only：`scanListeningDaemons()`（`ss`/`lsof`，`:670-673`）与
  `scanSocketDir()`（unix socket 文件枚举，`:759-763`）在 win32 直接 `return []`；win32 用命名管道传输
  （`windows-named-pipe.test.ts`），没有等价的枚举实现。
- **影响面**：win32 上 `prime-agent shutdown` 作为 AGENTS.md 认定的唯一停 daemon 手段失效；
  POSIX 不受影响。
- **为什么现在不修**：需要 win32 命名管道枚举（`\.\pipe\` 列举 + 归属判定 + 权限/复用语义），
  是一块新的发现层实现，且无 runner 验证；盲写大概率引入误杀（见 r17 停机作用域审计的教训）。
- **解除条件**：Windows runner + 命名管道发现设计过异构复核后实现；或裁决"win32 不支持 daemon 停机"
  并把 `shutdown` 在 win32 显式 fail-fast（比静默成功诚实）。

### X5（P2）"私有文件" 0600/0700 硬化在 win32 空转

- **现象**：自定义/共享 agentDir（多用户共用一台 Windows 机）下，会话记录/凭据/日志的权限收紧不生效。
- **根因**：`private-files.ts` 的 `PRIVATE_DIRECTORY_MODE=0700` / `PRIVATE_FILE_MODE=0600` 走 chmod，
  win32 的 chmod 只动只读位；文件级零 ACL 兜底（`SetNamedSecurityInfo` 全仓仅命名管道用，
  文件路径 0 命中）。
- **影响面**：win32 上同机其他账户可读 session jsonl / auth / 日志；POSIX 挡得住。
- **为什么现在不修**：正确做法是每处私有写入接 Win32 ACL（owner-only SD），涉及 fs 原语层与
  降级路径（非 NTFS/网络盘），无法在本机验证任何一行；且 fork 的默认安装场景是单用户机器，
  实际暴露面小。
- **解除条件**：Windows runner + owner 拍板"要挡多用户场景"后，在 `private-files.ts` 加
  `SetNamedSecurityInfo`/`SetFileSecurity` 文件级兜底并带正控测试。

### X6（P3）win32 整段禁用常驻 harness

- **现象**：Windows 上 memory/skill/prompt-note/subagent 的落盘与失败留证整体不可用，
  报 `Persistent harness storage is unsupported on Windows`。
- **根因**：`refinement.ts:19-27` `isPersistentHarnessStorageSupported()` 直接 `platform !== "win32"`，
  而所用原语（appendPrivateFile 等）在 win32 均有降级实现、同层被 44 处正常调用。
- **影响面**：win32 用户失去常驻 harness 全部能力；疑似"未验证"而非"做不到"。
- **为什么现在不修**：解除需要先有 win32 上私有文件语义的裁决（与 X5 同根），且需要 runner 验证
  并发锁/原子写在 NTFS 上的行为；属产品决策（owner 拍板）而非盲修。
- **解除条件**：owner 裁决支持等级（含 X5 的 ACL 决策）+ Windows runner 验证锁与原子写后，
  摘掉平台门或改为能力探测。

## 放大因素与已排除项（承审计原结论）

- CI-3（无 Windows runner）使 X1/X4/X5 的现有 CI 全抓不到；本轮盲修同样 unverified-by-runner。
- 已排除（附正控，见审计原文）：路径分隔符/大小写/`stat.mode` 私有性判定/CRLF/getuid 守卫/
  临时目录随机性/lockfile。
