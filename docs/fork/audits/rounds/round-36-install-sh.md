# r36 审计线：install.sh 安装面端到端

- 仓库（只读）：/Users/a1/Desktop/ai/prime-agent @ 89260d029a24b0fefea9419b280aba5f8c4bcb18
- 目标文件：install.sh（1641 行，`#!/bin/sh`，`set -eu`，无 pipefail）
- 实验环境：/tmp/audit_r/round-36/r36-installsh-work（伪造 HOME / NPM_CONFIG_PREFIX / 本地 127.0.0.1 HTTP 源 / 假 npm；**未向系统安装任何东西**）
- 去重台账：docs/fork/audits/decisions.jsonl（299 行）已读；install 相关已记录条目 4 条（SUP-B / SUP-D / P-2 x2，均 P2 fixed）。本报告不含这 4 条的重复项，只在 F13 处标注"F20 已记录但属部分修复"。

## 复现脚本（全部非破坏，可重跑）

`/tmp/audit_r/round-36/r36-installsh-work/` 下：
- `install-rendered.sh`：`sed s|__PRIME_AGENT_DOWNLOAD_BASE_URL__|http://127.0.0.1:18231|` 渲染后的安装器
- `www/`：`stable`、`releases/v0.0.1|v0.0.2|v0.0.3|v0.0.4/{*.tgz,SHA256SUMS}`（tgz 由 `npm pack` 现做，包内 cli.js 只 `console.log`）
- `fakebin/npm`：记录 argv+env 的假 npm（`FAKE_NPM_EXIT` 控制失败）
- 日志：A/C/F/G/H/I/J/K/K1/L/M/N1/N2/P/Q/R/S.log + 同名 .out/.err

统一运行环境（每次）：`HOME=$B/home NPM_CONFIG_PREFIX=$B/prefixN PRIME_AGENT_INSTALLER_PLAIN=1 TERM=dumb`，stdin=/dev/null，无 tty。

---

## ① 下载源与完整性

### F1 [P2] 校验和与安装包同源同目录，无签名 ⇒ 源被控即可同时改写两者（完整性只防传输损坏，不防源被攻陷）
- file:line：下载包 `install.sh:1478`（`curl -fsSL "$tarball_url"`）、校验和 `install.sh:1460`（`checksums_url="$prime_agent_base_url/releases/v$version/SHA256SUMS"`）、校验 `install.sh:1483-1500`
- 逐字证据（G 轮，正控）：把 `www/releases/v0.0.1/prime-agent-0.0.1.tgz` 换成 `npm pack` 出的 EVIL 包（cli.js 打印 `EVIL PAYLOAD`），同时把 SHA256SUMS 改成该文件的真 sha256 ⇒
  - 输出：`prime-agent-0.0.1.tgz: OK` / `Prime Agent was installed successfully.` / `EXIT=0`，npm 收到的是被篡改 tarball
- 反向对照（C 轮，证明检测方法有效）：只篡改 tarball、SHA256SUMS 不动 ⇒ `sha256sum: WARNING: 1 computed checksum did NOT match`、`prime-agent-0.0.1.tgz: FAILED`、`EXIT=1`，npm 完全未被调用（`A.log` 同形，npm 调用计数 0）
- 影响：任何能改写下载源（或在同源上拿到发布凭据）的人可让被篡改包通过校验；npm≥12 分支还显式放行生命周期脚本（见 F1 附），安装即代码执行。
- F1 附（S 轮逐字，FAKE_NPM_VERSION=12.0.2）：
  `npm install -g --no-fund --no-audit --loglevel=error --progress=false --allow-remote=all --allow-scripts=/tmp/.../prime-agent-0.0.1.tgz /tmp/.../prime-agent-0.0.1.tgz`
- 发布侧（scripts/pack-prime-agent-release.mjs:229,317-324）只 `createHash("sha256")`，全仓无 gpg/minisign/签名校验（`grep -rn 'gpg\|sign' scripts/pack-prime-agent-release.mjs` 无命中）
- 可复现输入：见 G/C 轮；confidence: high（端到端实测 + 正反控）
- 去重：与已记录 SUP-B（prime-agent **update** 接受任意 URL）不同物件（本项是 install.sh 的校验和同源），未重复报。

### F2 [P2] 传输层无 https 强制、无协议限制；`curl -L` 默认允许重定向降级到 http/ftp
- file:line：`install.sh:9`（`prime_agent_base_url="${PRIME_AGENT_DOWNLOAD_BASE_URL:-...}"`）、`:961`、`:1472`、`:1478`（全部 `curl -fsSL`，无 `--proto` / `--proto-redir`；`grep -n '\-\-proto' install.sh` 零命中）
- 逐字证据：
  - 全实验用 `http://127.0.0.1:18231` 作 base URL ⇒ 明文源安装成功 `EXIT=0`（A/G/H/R/S 轮）；脚本对 scheme 零校验（无 `case *https*`）
  - 重定向被跟随（L 轮，正控）：base URL 指向 302 服务器（`install.sh:961/1472/1478` 三处均命中），`prime-agent-0.0.1.tgz: OK`、`EXIT=0`、真实源收到请求
  - curl 本机 man：`By default curl only allows HTTP, HTTPS, FTP and FTPS on redirects (added in 7.65.2)` ⇒ 无 `--proto-redir` 时 https→http 重定向降级是被允许的
- 影响：配置的 https 源一旦被 302 到 http（或被 env/托管脚本指定为 http），tarball+校验和会明文下发，MITM 可同时改包与校验和 ⇒ F1 的组合拳在传输层即可达成。
- confidence: high（redirect 跟随与 http 全程为实测；https→http 降级路径为 man 语义 + 无 `--proto-redir` 的证据，未做真 TLS 降级实验，标注为推断）

### F3 [P3] 无任何超时/重试 ⇒ 黑洞镜像让安装永久挂起；瞬时 5xx 直接整体失败
- file:line：`install.sh:961/1191/1215/1472/1478`（无 `--connect-timeout` / `--max-time` / `--retry`）
- 逐字证据（P 轮）：假服务器 `accept()` 后不回任何字节 ⇒ 12s 后进程仍在跑（`still running: True`，尚未退出，`P.err` 只有 `Downloading release checksums`），只能 SIGKILL；正控：同一脚本对健康源 <2s 完成（A 轮）。
- 另一面（M 轮）：checksums 404 ⇒ `curl: (22) The requested URL returned error: 404`、`EXIT=22`，无重试。
- confidence: high

### F4 [P3] Node 自举下载同样无签名、且是滚动目录 + 同源 SHASUMS
- file:line：`install.sh:1184` `node_dist_base="https://nodejs.org/dist/latest-v22.x"`；`1191` 取 `SHASUMS256.txt`；`1215` 取 tar.xz；`1229-1246` 校验
- 证据：版本不固定（`latest-v22.x` 随时间移动），校验和与包同源同目录；无签名。影响：与 F1 同类（源被控即可通过校验），且安装的 Node 版本不可复现。
- 未在本机实跑该分支（会真装 Node），标注 static-only，confidence: medium-high（读码 + 与 F1 同构）
- 去重：与 SUP-D（fd/rg 走 releases/latest 无校验）不同物件，未重复。

---

## ② 失败中途的半安装形态

### F5 [P2] install.sh 不自带备份/回滚，原子性完全外包给 npm；SIGKILL 后留下僵尸符号链接
- file:line：清理只有 temp dir：`install.sh:158-170`（`trap prime_agent_cleanup EXIT` / `163-170` 只 `rm -rf "$prime_agent_download_dir"`）；安装单步 `install.sh:112-115`
- 实测矩阵（全部真实 npm 10.9.4，prefix 在 /tmp）：
  | 场景 | 轮次 | 入口 | EXIT | 旧安装状态 | 残留 |
  |---|---|---|---|---|---|
  | 坏 tarball（zlib 错） | I | :1478 通过校验后交给 npm | 253 | **保留**（`GOOD v0.0.1` 仍可跑） | 无 |
  | postinstall exit 7 | J | 同上（v0.0.2） | 7 | **保留**（npm 回滚） | 无 |
  | SIGINT 到进程组（模拟 Ctrl-C） | K | 同上（v0.0.3 sleep 30 postinstall） | 130 | **保留** | temp dir 已清 |
  | SIGKILL 到进程组 | K1 | 同上 | -9 | 包体已换成 v0.0.4 | **bin/ 里残留 `.prime-agent-kxz7G6q3 -> ../lib/node_modules/prime-agent/cli.js` 僵尸链接** + `$TMPDIR/prime-agent-install.zF4OGu` 泄漏 |
- 影响：常规失败是安全的（npm reify 回滚，正面结论）；但机器崩溃/`kill -9`/断电类中断既无检测也无后续提示，脚本下次运行时不会发现 `.prime-agent-*` 残留。
- confidence: high（四象限实测）

### F6 [P3] SIGKILL（trap 不执行）泄漏下载临时目录
- 证据：F5 表中 K1 行；正控：INT/TERM 有 trap（`install.sh:159-160`），K 轮实测 temp dir 被清（`ls -d $TMPDIR/prime-agent-install.*` 前后对比为空）。
- confidence: high

### F7 [P3] standalone Node 路径先删后解压、`current` 切换非原子 ⇒ 解压失败会毁掉用户已有的 Node
- file:line：`install.sh:1220` `rm -rf "$node_dir"` → `1221` `tar -xf ... -C "$node_base_dir"` → `1222-1223` `rm -f "$node_base_dir/current"; ln -s "$node_dir" "$node_base_dir/current"`
- 影响：磁盘满/解压中途失败 ⇒ 该版本 Node 目录已被删、`current` 可能已断；无备份、无恢复提示。
- confidence: medium（读码结论；未构造磁盘满，属推断）

### 未发现（带正控）
- 「PATH 已改但命令不存在」：profile 追加（`install.sh:1425-1427`）只在 npm 安装成功之后执行（`main:117-119`），且带 `[Y/n]` 询问；未观察到先改 PATH 后失败。confidence: medium（该分支未实跑，static）。

---

## ③ 对已有安装的覆盖语义

### F8 [P2] 静默覆盖已有安装（含 `npm link` 的源码安装），无备份、无提示、无检测
- file:line：preflight 只打印一行 `install.sh:916-919`（`Existing <cmd> found at: <command -v 结果>`）；覆盖动作在 `install.sh:1601-1610`（`npm install -g ...`），全程无备份/无 `--force` 语义判断
- 逐字证据（Q 轮）：先 `npm link`（prefix7 下 `lib/node_modules/prime-agent -> ../../../pkg`，即源码符号链接；bin 也是链接），再跑安装器 ⇒
  `changed 1 package in 131ms` / `Prime Agent was installed successfully.` / `EXIT=0`；事后 `lib/node_modules/prime-agent` 已变成**真目录**（发布包内容），dev 链接被无声销毁，`prime-agent` 命令输出 `GOOD v0.0.1`。
- 影响：本仓 README:125-129 正教用户 `npm ci && npm run build && npm link`；官方安装器会把这份 dev 安装覆盖成发布版且不提示 ⇒ 用户以为在跑本 fork，实际跑的是官方发布包（与本仓"独立线"的核心承诺冲突）。
- confidence: high（实测）

### F9 [P3] 成功判定看 PATH 上的旧命令，而非新装的命令 ⇒ 可能谎报"新安装可用"
- file:line：`install.sh:120` `elif command -v "$prime_agent_cmd" >/dev/null 2>&1; then` → `124-125` 打印 `Prime Agent was installed successfully. / Run it with: prime-agent`
- 逐字证据（A/H 轮）：本机 PATH 里有 `/Users/a1/.local/bin/prime-agent`（preflight 行 `Existing prime-agent found at: /Users/a1/.local/bin/prime-agent`），而 npm 装到 `NPM_CONFIG_PREFIX=/tmp/.../prefixN`（不在 PATH）⇒ 仍打印 "installed successfully. Run it with: prime-agent"，指的不是刚装的那份。
- confidence: high

### F10 [P3] flag/文档一致性：无 `--dir`/`--no-*`；位置参数只取 `$1`；`PRIME_AGENT_VERSION` 静默压过位置参数
- file:line：`install.sh:932-950`（`resolve_prime_agent_version`：`$1` 只认 `stable|beta|版本号`）、`:952-955`（env 覆盖）
- 逐字证据（M 轮）：`sh install-rendered.sh beta` → `EXIT=0`（走 www/beta）；`sh install-rendered.sh beta` + `PRIME_AGENT_VERSION=0.0.1` → 日志 `Downloading Prime Agent v0.0.1`（位置参数被静默忽略）；`install.sh stable 0.3.1` 形态的第二个位置参数被静默丢弃。
- 文档面：README.md:133 与 packages/coding-agent/docs/quickstart.md:10/16 只给 `curl -fsSL ... | sh [-s -- beta]`，未文档化任何 flag/env 优先级 ⇒ 「文档 vs 行为」的不一致点是**未文档化的 env 优先级**，而非缺失 flag。
- confidence: high（行为实测）/ medium（"第二个位置参数被忽略"为读码推断）

---

## ④ 测试覆盖

### F11 [P2] 端到端只在发布工作流覆盖 happy path；ci.yml 完全不跑 install.sh
- 逐字证据：
  - `.github/workflows/build-binaries.yml:175-208`（"Smoke test installer with npm 12"）：`sh /tmp/prime-agent-npm12-install.sh "$SMOKE_VERSION"` + `test -x "$NPM_CONFIG_PREFIX/bin/prime-agent"`，触发条件 `on: push[branches: main, tags: v*], workflow_dispatch`（该文件 4-15 行），无 step 级 `if:` ⇒ 每次该工作流都会真跑一遍（**正控：install.sh 的 happy path 确实有端到端 CI**，且用的是本地 `http://127.0.0.1:18188` 源，本身即 F2 的旁证）。
  - `.github/workflows/ci.yml`：`grep -c installer` = 0，无任何 install.sh 执行。
  - `package.json` → `check:installer: node scripts/check-installer.mjs`，被 `npm run check` 调用（ci.yml:96）。实跑 `env -u RLM_DEPTH node scripts/check-installer.mjs` ⇒ `Installer check passed.` `EXIT=0`；该脚本只做（a）渲染/尺寸断言（截取到最后一个 `main "$@"` 之前）+（b）假 npm 验证 `--allow-remote`/`--allow-scripts` 策略，**不碰下载、校验、失败路径、覆盖语义**。
- 结论：篡改/同源/非 https/非 tty/并发/失败回滚 六类零覆盖（负结论已带正控：同方法在 build-binaries.yml 里能检出并执行 install.sh）。
- confidence: high

---

## ⑤ 其它

### F12 [P2] 并发两个安装：一个报成功、一个报失败，最终状态与两者报告都对不上（无锁）
- 逐字证据（N 轮，同一 `NPM_CONFIG_PREFIX=/tmp/.../prefix6`，同时 `sh install-rendered.sh 0.0.1` 与 `... 0.0.4`）：
  - A(0.0.1)：`added 1 package in 143ms` → `Prime Agent was installed successfully.` `EXIT=0`
  - B(0.0.4)：`npm error code EEXIST / syscall symlink / errno -17 ... dest .../bin/prime-agent` `EXIT=239`
  - 终态：`lib/node_modules/prime-agent/package.json` = **0.0.4**，`prime-agent` 命令打印 `GOOD v0.0.4`
- 影响：两个用户/两条自动化同时装（CI 容器复用一个 prefix）会得到互相矛盾的结论、且失败方留下了自己的包体；脚本无 pidfile/锁/prefix 检查。
- confidence: high

### F13 [P2] 已记录 F20 属**部分修复**：preflight 已 22.8，但 Node 候选选择器仍 20.6 阈值
- 去重标注：**已记录（F20，decisions.jsonl，fixed，f12fcbdea）**；但 f12fcbdea 只改了 preflight 三处（`git show f12fcbdea -- install.sh` 显示改动集中在 874/895/1010 附近），选择器路径未动：
- file:line：`install.sh:1054-1075`（`node_version_string_is_new_enough`：`[ "$major" -gt 20 ]`、`[ "$major" -eq 20 ] && [ "$minor" -gt 6 ]`）+ 调用点 `:1044-1052`；而闸门是 `:899`/`:903`（22.8.0）
- 影响：Linux 无 NodeSource 时 `detect_node_install_method` 会选中 apt/apk 的 20.7+ 候选 ⇒ 装完一个不达标的 Node，随后立刻被 22.8 闸门拒绝（`exit` 该状态），用户白跑一轮并要求手动修 Node。
- confidence: medium-high（读码；未在 Linux 实跑 apt 分支）。**这条按"已记录但只修了一半"提交，不重复计 F20 本身。**

### F14 [P3] 临时目录权限正常（未见问题，带正控）
- 证据：`sh -c 'd=$(mktemp -d "${TMPDIR:-/tmp}/prime-agent-install.XXXXXX"); stat -f "%Sp" "$d"'` ⇒ `drwx------`；`install.sh:146-152` 在 mktemp 缺失时硬失败（不退回可预测路径）。TOCTOU：校验（:1480）→ npm 读同一路径（:1606）之间窗口存在，但目录 0700 且同用户 ⇒ 只能同用户自竞，标 P3/低。
- confidence: high

### F15 [P3] shell 兼容性：未见 bashism，`curl|sh` 与 `#!/bin/sh` 一致（未见问题，带正控）
- 证据：`/bin/sh -n` / `/bin/bash -n` / `/bin/dash -n` 全 `EXIT=0`；`grep -n '\[\[\|(^\|\s)local \|declare\|typeset\|\w+=(\)'` 零命中（唯一 "local" 命中是第 6 行英文注释）；**正控：`/bin/dash install-rendered.sh 0.0.1` 全流程 `EXIT=0`**（R 轮，`added 1 package` + `installed successfully`）。管道无 pipefail 但关键管道（awk 选择、curl、sha 校验）都带显式判据/返回值传递，未见吞错（M 轮 404 ⇒ 22、缺条目 ⇒ `error: checksum ... was not found` + 1，C 轮篡改 ⇒ 1）。
- confidence: high

---

## 汇总（严重度降序）

| # | sev | 位置 | 一句话 | conf |
|---|---|---|---|---|
| F1 | P2 | install.sh:1460/1478/1483-1500 | 校验和与包同源无签名，源被控即成对改写通过校验（实测 EVIL 包 OK/exit 0） | high |
| F2 | P2 | install.sh:9/961/1472/1478 | 无 https 强制、无 --proto-redir，http 源可直接装成功、302 被跟随 | high |
| F8 | P2 | install.sh:916-919/1601-1610 | 静默覆盖已有安装（实测 `npm link` dev 安装被换成发布版，无备份无提示） | high |
| F11 | P2 | build-binaries.yml:175 / ci.yml(0) | 端到端只在发布工作流跑 happy path；校验/失败/覆盖/并发零覆盖 | high |
| F12 | P2 | install.sh:1601-1610 | 并发安装无锁：一方报成功、一方 EEXIST 失败、终态与两者都矛盾 | high |
| F5 | P2 | install.sh:158-170 | 无备份/回滚，原子性靠 npm；SIGKILL 残留僵尸 bin 链接 | high |
| F13 | P2 | install.sh:1054-1075 | F20 部分修复：候选选择器仍 20.6 阈值，会先装不达标 Node 再被拒 | med-high |
| F3 | P3 | install.sh:961/1472/1478 | curl 无超时无重试，黑洞源永久挂起（实测 12s 未退） | high |
| F9 | P3 | install.sh:120-125 | 成功判定看 PATH 上的旧命令，可能谎报新装可用 | high |
| F4 | P3 | install.sh:1184-1246 | Node 自举无签名 + latest-v22.x 滚动 + 同源 SHASUMS | med-high |
| F6 | P3 | install.sh:158-170 | SIGKILL 泄漏下载临时目录 | high |
| F7 | P3 | install.sh:1220-1223 | standalone Node 先 rm -rf 后解压、current 切换非原子 | med |
| F10 | P3 | install.sh:932-955 | 无 --dir/--no-*；env 静默压过位置参数；文档未写优先级 | high |
| F14/F15 | P3 | — | 临时目录 0700、POSIX sh 兼容（未见问题，均已带正控） | high |

未实测分支（标注）：真 TLS 降级（F2 后半）、standalone Node 自举与 profile 追加（F4/F7/②PATH 项）、Linux apt/apk 候选选择（F13）。全部为读码 + 同构推断，已在各条注明 confidence。
