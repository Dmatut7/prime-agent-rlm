# r36 实施线：INSB-1..4（install.sh + kernel bootstrap）

- 工作树：/tmp/audit_r/round-36/wt-insb（detached @ 冻结 SHA 03fd4ae84 → 提交 **b69ece1a5**，8 文件 +546/−32）
- 纪律执行：单命令 ≤60s；vitest 分批 ≤3 文件（3+3+2）；先红后绿（红/绿证据见下）；unset 泄露 env；git add 逐文件、staged 核对过；仓零 `doctor --fix`/`daemon ps -k`；主仓只读
- 验证：tsgo --noEmit EXIT=0（工作树与 `git archive HEAD` 裸树双跑）；biome 干净；`node scripts/check-installer.mjs` EXIT=0；`/bin/sh|bash|dash -n` 全过

## INSB-1 传输与完整性（install.sh）
- 全部 5 处 curl（channel :961 / SHASUMS :1191 / node tar :1215 / SHA256SUMS :1472 / tarball :1478）加 `--proto '=https' --proto-redir 'https'` + `--max-time`（默认 600，`PRIME_AGENT_CURL_MAX_TIME` 可覆写）
- 校验和分源：`PRIME_AGENT_CHECKSUM_BASE_URL`（缺省回落同源）。**取舍**：本 fork 无第二校验和发布源，默认仍同源（源被控即可成对改写，F1 本体未除）——只加了"可分源"的机制并在脚本注释文档化；报告如实记为部分修复
- 逃生口：`PRIME_AGENT_INSTALLER_ALLOW_INSECURE_TRANSPORT=1`（build-binaries.yml 的 npm12 smoke 步已加该 env，本地 http 测试同用）。理由：CI smoke 走 127.0.0.1 loopback http；能控制 env 的攻击者本就能直接指 base URL，此开关不实质降低威胁模型
- 红测 T1（改前必红）：本地 http 源安装 EXIT=0、装成功 → 改后 EXIT=1（curl 协议拒绝），prefix 零安装。**实测红→绿**

## INSB-2 并发锁 + 覆盖检测（install.sh）
- 锁：`$npm prefix -g/.prime-agent-install.lock` 原子 mkdir + pid 活性 + 无 pid 30s 陈旧窗 + 默认 300s（`PRIME_AGENT_INSTALL_LOCK_TIMEOUT_MS`）等待超时；EXIT trap 释放；prefix 解析失败/不可写降级为警告不锁
- 覆盖检测：下载校验后、npm install 前查 `$prefix/lib/node_modules/prime-agent`；symlink（`npm link` dev 形态）显式 warning；TTY 询问 Reinstall? [Y/n]；非 TTY 拒绝并提示 `--force`（exit 1）；`--force`（前置位参数）跳过询问
- 红测：T3 锁被活 pid 持有 → 改前 EXIT=0 直接装 / 改后 EXIT=1 带 lock 文案；T4 真二并发（真 npm）→ 改前 exits=[0,239(EEXIST)]、终态矛盾 → 改后 exits=[0,1]，败方带 "existing…--force"，终态=胜者版本；T5 预置安装非 TTY → 改前静默覆盖 EXIT=0 → 改后 EXIT=1 版本未动；T5b `--force` → EXIT=0 覆盖成功；T6 dev link → 改前链被毁 EXIT=0 → 改后 warning + EXIT=1 链保留。**全对红→绿**

## INSB-3 bootstrap 失败诊断（bootstrap.ts）
- `run()`：`captureStderr`（stderr pipe + 截尾 4KB 进错误消息）+ `timeoutMs`（显式定时器 SIGKILL + "timed out after Nms"）+ `stdinScript`
- 三条 uv 安装命令 + skill sync uv + uv 安装器全部带 `uvCommandTimeoutMs()`（默认 900s，`PRIME_AGENT_KERNEL_UV_TIMEOUT_MS` 覆写）；uv 安装器 curl 本身加 `--max-time 120`
- `formatBootstrapFailure`：错误带 uv stderr 时**不再**输出 "First-time setup needs internet"（换成"上面的输出是 uv 自己的诊断"）——磁盘/权限失败不再被归因为网络
- `acquireBootstrapLock` 的 mkdir/writeFile 非 EEXIST 失败 → 新 `KernelBootstrapLockCreateError`（"couldn't create the kernel bootstrap lock at …; Fix permissions …; or set PRIME_AGENT_KERNEL_PYTHON …"）并入 formatBootstrapFailure 直通类（等价于把 :1568 挪进 try，但保留类型化直通）
- 红测（kernel-bootstrap-failure-diagnostics.test.ts，改前 5 红）：假 uv ENOSPC stderr → 断言错误含 "No space left on device"（改前只有 exit code 2）；断言不含 "First-time setup needs internet"（改前含）；假 uv venv 挂 60s + 500ms 覆写 → 断言 /timed out after 500ms/（改前 15s 看门狗内挂死）；chmod 500 父目录 → 断言含 "couldn't create"+"PRIME_AGENT_KERNEL_PYTHON"（改前裸 EACCES）。**红→绿**

## INSB-4 热路径探针 / 静默首跑 / 阈值对齐 / max-time
- 热路径：`kernelReady` 与 `kernelBaseReady` 各加**单探针**（`python -P -` + stdin 脚本一次性 import 全部 12 个默认包；stdin 形态使既有测试假 python 不需改）——E2c 盲区（import 坏掉的 venv 永远"就绪"）闭合，且 base-ready 分支不再把坏代际当只差 skill
- 静默首跑：`IpythonKernelProvisioner.prewarm()` 失败经新 `onStartupFailure` 回调上抛；agent-session 接线 → sessionLog.error + `sendCustomMessage`（display:true, nextTurn，`<ipython_bootstrap_failed>` 消息）——用户/模型在下一回合看到原因，首次 ensure() 照旧重试
- Node 选择器：`node_version_string_is_new_enough` 20.6 → **22.8**（与 preflight 闸门一致，Linux apt/apk 候选不再先装后拒）
- curl `--max-time`：install.sh 5 处（见 INSB-1）+ bootstrap 的 uv 安装器
- 红测：探针（改前 1 次 venv 构建/无 rebuild → 改后 ≥2 次，假 python 只对 `-P -` 探针 exit 1）；prewarm 回调（改前永不触发 → 改后带错误消息触发）；node 阈值 7 用例（改前 20.7/22.7.9 误收）；T2 黑洞 https 源（改前 15s 挂死 → 改后 max-time 3s EXIT=28）。**全红→绿**

## 测试账
- 新 shell 驱动：/tmp/audit_r/round-36/insb-work/run_tests.py（T1–T9，红跑=pristine install.sh 0/9，绿跑=9/9；复用审计线 www + 本地 http/黑洞 https 服务，真 npm，prefix 全在 /tmp）
- 新 vitest：kernel-bootstrap-failure-diagnostics.test.ts（5 测，先红后绿）；ipython-provisioner.test.ts +1（prewarm 上报，先红后绿）
- 回归：kernel-bootstrap{,-lock,-in-use}.test.ts 52 全绿；kernel-runtime-pinning/skill-content/skills-superset 22 全绿；ipython-provisioner 25 全绿（含新增）

## 未做 / 边界（诚实清单）
- F1 本体（同源校验和无签名）未除：无第二可信源可指，只做了可分源 env + 文档化；真签名（minisign/gpg）属发布链改造，超出本轮
- https→http 真降级未实测（本地无 TLS 拦截面）；--proto-redir 语义为 man 证据 + flag 形状断言
- prewarm 失败经 sendCustomMessage 的 UI 实机呈现未在 TUI 里人眼验证（机制与 `_onIpythonStateRestored` 同构，单测只断回调与传递）
- Windows `sh -c` uv 安装器分支仍未验证（无 win32 runner，与审计线同盲区）
