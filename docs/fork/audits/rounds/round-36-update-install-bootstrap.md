# r36 泛扫 · 更新/安装/引导链端到端（产品安装面）

- 仓库 /Users/a1/Desktop/ai/prime-agent，冻结 SHA `89260d029a24b0fefea9419b280aba5f8c4bcb18`（HEAD 2026-09-16T07:41:54+08:00）
- 只读审计，仓内零写入；本线负责 ②prime-agent.sh ③fork-self-update 链 ⑤版本间升级兼容；①install.sh 与 ④bootstrap-cli/kernel venv 由两条子线单独交付（见 r36 目录 installment 报告）
- 去重依据：docs/fork/audits/decisions.jsonl（297 条，含 SUP-D / GL-5 / FR-1 / DAT-4 / X1）。本线结论与其中任何一条都不重复；GL-5/FR-1 只作为"已修的闸"被引用为背景。
- 每条给出：命题 / severity / file:line / 逐字证据 / 影响 / 可复现 / confidence / 正控。
- 复现脚本：`/tmp/r36_stale_run.mts`（用仓自带 tsx 跑：`cd <repo> && env -u RLM_DEPTH -u RLM_SESSION_DIR -u PRIME_AGENT_AGENT_DIR ./node_modules/.bin/tsx /tmp/r36_stale_run.mts`，实测 0.6s，exit 0）

---

## F1 · orphan prepared manifest 无年龄上限：协调器死亡后遗留的 manifest 会被任意久以后的 update 原样复活（P3）

**命题**：`prepare_update_restart` 落盘的 prepared manifest 只有"读到坏 JSON 就删"这一条清理路径；客户端读取它在**两条路径上都不带年龄/新鲜度判据**，因此一个在 update 中途死掉的协调器（或断电）留下的 manifest，可以在任意久之后的下一次 update 里被当成"待恢复现场"消费，把早已结束的会话重新拉起并注入"Prime Agent restarted after an update"续跑提示。

**逐字证据**
- `packages/coding-agent/src/package-manager-cli.ts:964-986`（唯一带年龄判据的读取器，判据是**入参可选**的）：
  ```
  function readPreparedDaemonUpdateRestartManifest(
      socketPath: string,
      agentDir: string,
      notBeforeMs?: number,
  ): DaemonUpdateRestartManifest | undefined {
  ...
          if (notBeforeMs !== undefined && modifiedAt < notBeforeMs - 1000) {
              continue;
          }
  ```
- `packages/coding-agent/src/package-manager-cli.ts:988-997`（无判据的包装；`notBeforeMs` 从未传入）：
  ```
  function tryReadPreparedDaemonUpdateRestartManifest(
      socketPath: string,
      agentDir: string,
  ): DaemonUpdateRestartManifest | undefined {
      try {
          return readPreparedDaemonUpdateRestartManifest(socketPath, agentDir);
  ```
- 消费点一（daemon 可达路径，`:1039`）：`const pendingManifest = tryReadPreparedDaemonUpdateRestartManifest(socketPath, agentDir);` → 只要 daemon 报"没有活跃会话"就直接 `return pendingManifest`（`:1041-1044`）。
- 消费点二（协调器的 daemon 不可达分支，`:1518-1521`）：
  ```
              manifest = tryReadPreparedDaemonUpdateRestartManifest(options.socketPath, options.agentDir);
              if (!hasRestorableDaemonUpdateRestart(manifest)) {
                  statusWriter.update({ phase: "skipped", message: "No running daemon needed to be restarted" });
  ```
  这里没有任何年龄判断，只要 `sessions.length > 0` 就继续走 `ensureInteractiveDaemonRunning` + `restoreDaemonUpdateRestart`（`:1545+`）。
- 消费点三（导出的入口函数，`:1089-1103`）：连不上 daemon 也照样返回 pending manifest：
  ```
  export async function prepareDaemonUpdateRestart(
      socketPath: string,
      agentDir: string,
  ): Promise<DaemonUpdateRestartManifest> {
      const pendingManifest = tryReadPreparedDaemonUpdateRestartManifest(socketPath, agentDir);
  ...
          if (!connected && pendingManifest && pendingManifest.sessions.length > 0) {
              return pendingManifest;
  ```
- 清理路径只有两条：读坏 JSON 时（`:995` `clearPreparedDaemonUpdateRestartManifest`）与协调器成功结束时（`:1504`、`:1560`）。

**正控（证明"这个仓知道怎么给 manifest 加年龄闸"，从而本条不是我的判读幻觉）**：
`packages/coding-agent/src/modes/daemon/daemon-supervisor.ts:8591-8592`（supervisor 侧同一份 checkpoint 的年龄窗口）：
```
		if (ageMs > UPDATE_RESTART_PREPARED_RESTORE_WINDOW_MS) return;
		if (ageMs < UPDATE_RESTART_PREPARED_RESTORE_MIN_AGE_MS) return;
```
常量：`daemon-supervisor.ts:265` `UPDATE_RESTART_PREPARED_RESTORE_WINDOW_MS = 30 * 60_000`、`:272` `..._MIN_AGE_MS = 5 * 60_000`。
即：**daemon 侧同一文件的复用被限制在 30 分钟窗口内，client 侧完全不受限**——不对称本身即是缺陷证据。且 `readPrepared...` 的 `notBeforeMs` 参数确实存在且被用于 catch-fallback（`:1078`），说明"该带判据"是可实现的，只是主路径没带。

**实测复现（本线真跑，非推理）**：`/tmp/r36_stale_run.mts`
```
CASE_A_stale_30d: {"formatVersion":1,"createdAt":"2026-01-01T00:00:00.000Z","sessions":[{"activeSessionId":"stale-active",...shouldResume":true,...
CASE_A_mtime: 2026-08-16T23:52:41.555Z        # 30 天前
CASE_C_garbage: "THREW: Failed to connect to the Prime Agent daemon: connect ENOENT .../no-such-daemon.sock..."
CASE_C_garbage_file_cleared: true
CASE_B_no_manifest: "THREW: Failed to connect to the Prime Agent daemon: connect ENOENT .../no-such-daemon.sock..."
```
- CASE_A：在 `agentDir/daemon-update-restarts/<sha256(socket)>.json` 放一份 mtime = 30 天前的合法 manifest，目标 socket 不存在（协调器已死、daemon 未运行）→ `prepareDaemonUpdateRestart` **原样返回该 30 天前 manifest**。
- CASE_C（正控 1，证明我命中的确实是代码真正读的那个路径）：同路径写坏 JSON → 返回连接错误**且该文件被删除**（`!existsSync == true`），与 `:995` 的清理路径逐字对应；若我路径猜错，坏文件不会被删。
- CASE_B（正控 2，证明"返回了 manifest"不是函数无条件造出来的）：无 manifest 时同一调用抛连接错误，不会凭空产出 manifest。

**影响**：一个中途死掉的 update（协调器 SIGKILL/断电/终端关闭）留下的 checkpoint 会长期驻留；下次任何 `update`（含 `--allow-official`/`--force`）会：daemon 不可达时把 daemon 拉起来并按旧 manifest `restoreDaemonUpdateRestart`——用 `UPDATE_RESTART_CONTINUATION_PROMPT`（`:668`）注入续跑提示，对早已结束的会话产生非用户发起的 LLM 轮次与 token 花费；daemon 可达但"无活跃会话"时同样返回旧 checkpoint 而非重新 prepare。
**可复现输入**：见上（脚本 + 30 天 mtime + 死 socket）。
**未覆盖/边界**：本线未做"真 daemon + 真协调器 SIGKILL"的端到端复现（时间为界），故"协调器路径下会话真被复活"这一步是读码推导；"读路径无年龄上限并可返回 30 天前 manifest"这一步是实测。
**confidence**：读路径与无年龄上限 = high；端到端后果 = medium。
**修复方向**：给 daemon 不可达分支与 `prepareDaemonUpdateRestart` 的复用加与 supervisor 相同的 age window（或至少 `notBeforeMs` 语义），并让 status/manifest 带 requestId 关联到一次真实更新会话。

---

## F2 · 更新成功是"自报"，安装结果零校验：半新/半坏的安装被打印成 "Updated ... from vX to vY"（P3）

**命题**：install 步骤返回退出码 0 之后，没有任何一步验证"装出来的东西能跑"或"版本真的是 manifest 指的那个"；成功文案直接取自 manifest 的 targetVersion。

**逐字证据**
- `packages/coding-agent/src/package-manager-cli.ts:1831` `await runSelfUpdate(selfUpdateCommand);` → `:1844`：
  ```
  					console.log(chalk.green(`Updated ${APP_NAME}${versionChange}`));
  ```
  其中 `versionChange` 来自 `:1841-1843` `selfUpdatePlan.targetVersion ? \` from v${VERSION} to v${selfUpdatePlan.targetVersion}\` : ""`——**targetVersion 是 manifest 声明的版本，不是读回来的实际安装版本**。
- 之后唯一的"实际效果"检查是启动重启协调器，失败仅告警：`:1859` `Warning: updated, but could not coordinate the daemon restart (...)`。

**负结论 + 正控**：`grep -rn "backup|verifyInstalled|postInstallVerify" packages/coding-agent/src/package-manager-cli.ts packages/coding-agent/src/config.ts` 对"安装后校验/安装前备份" **零命中**；同一文件对**下载的字节**却是有闸的——`package-manager-cli.ts:523` `if (!verifyUpdateArtifactHash(bytes, artifact.sha256))`（实现在 `config.ts:266`）。正控成立：该方法能检出同类校验（它检出了下载侧那一处），所以"安装侧没有"是真实缺口而非扫描假象。同理 `update-spec.test.ts`/`update-spec-trust.test.ts` 覆盖的是 spec 分类，不含安装后校验。

**影响**：npm/pnpm 静默不生效（prefix 推断错、权限只读被 --force 绕过、镜像给了旧版本）时用户被判为"已更新"；真正的症状要等下一次启动才出现，且归因困难。
**可复现输入**：读 `:1831/:1844` + 上述 grep；若要动态复现，可把 `npmCommand` 指向一个 exit 0 的假 npm（`:1577` 起的 `update --self` 路径入参），文案仍会打印 targetVersion。
**confidence**：high。

---

## F3 · 替换中途被中断 = 半新 CLI，且重启协调器正好从这个路径启动：中断后 daemon 静默停在旧 bundle（P3）

**命题**：安装是 `spawn(step.command, step.args, {stdio:"inherit"})` 的**原地覆盖**，无备份、无回滚、无"先装到旁路再原子切换"；而重启协调器子进程是用**父进程当前入口 `process.argv[1]`** 启动的，也就是刚被这次安装重写过的那个文件。因此安装中途被杀（Ctrl-C/断电/OOM）会同时打断"命令可用"与"能否重启 daemon"两件事，而后者只降级成一行 warning。

**逐字证据**
- `packages/coding-agent/src/package-manager-cli.ts:643-668` `runSelfUpdate`：`const child = spawn(step.command, step.args, { stdio: "inherit", ... })`，多步 install/uninstall 顺序执行（`uninstallAfterInstall` 顺序见 `config.ts:60-78`，artifact 安装是 install→uninstall，第二步失败即留下双份安装），全程无 rollback。
- `packages/coding-agent/src/cli/subprocess-launch.ts` `createCliSubprocessLaunchSpec`：
  ```
  	const resolvedEntrypoint = isAbsolute(entrypoint) ? entrypoint : resolve(entrypoint);
  	return { command: executable, args: [...execArgs, resolvedEntrypoint, ...args] };
  ```
  协调器调用处 `package-manager-cli.ts:1849` `await launchDaemonUpdateRestartCoordinator({...})`；被重写的入口正是它要加载的那份字节。
- 协调器启动失败只走 `:1859` warning，`process.exitCode` 不变（`:1856-1863` catch 内无 exitCode 赋值）→ 对调用方（含交互式父进程）看来仍是成功。

**影响**：用户升级中断后，`prime-agent` 可能是半写的 bundle（import 失败），且 daemon 未被重启、继续用旧代码服务——两端版本不一致且无任何提示；fork 文档要求"build 后必须重启 daemon"，这一路径恰好无法保证重启。
**可复现输入**：静态证据 + 顺序判读；动态复现建议：在 `/tmp` 假 prefix 下跑 `npm install -g <tarball>` 并在解包中途 SIGKILL（本线未做，避免动全局安装）。**标注为未实测**。
**confidence**：medium（代码顺序 high，"半新 CLI 的具体字节形态"未实测）。
**修复方向**：安装后校验 + 失败回滚（备份当前包目录）；协调器改用**新装成的** CLI 路径或 `command -v prime-agent` 解析入口，而不是父进程 argv[1]；协调器启动失败应反映为非 0 退出码。

---

## F4 · Node 版本不够时的引导把 fork 用户指向官方发布页（P4/informational）

`packages/coding-agent/src/cli/node-version-check.ts:53`:
```
	io.log("     https://github.com/PrimeIntellect-ai/prime-agent/releases/latest");
```
（同文本被打进 `packages/coding-agent/dist/bundle/cli.js`，`:45-56` 段）。本仓是 `Dmatut7/prime-agent-rlm` 独立维护版、`install.sh`/官方安装器**不含** fork 改动（AGENTS.md「Fork 覆盖」），而 `require Node >= 22.8` 又是首跑最可能触发的失败——此时给出的唯一指引是官方发布页，与 `fork-self-update.ts` 里专门立的反自毁闸方向相反。影响：引导错误而非数据损失。**可复现**：用 Node 20 跑 `./prime-agent.sh --dist` 或 `node packages/coding-agent/dist/bundle/cli.js`（本机 22.22.0，未实测旧 Node 分支；文本级证据）。**confidence**：high（文本）/ 影响面 low。

---

## ② prime-agent.sh 环境假设复核（结论：主要假设都有闸，两条残余）

逐条核对 `prime-agent.sh`：
- **node 版本**：脚本不查，但入口查——`packages/coding-agent/src/cli.ts:6` `const supported = assertNodeVersion({...})`，且守卫在动态 import 之前（注释：older Node 在 link 期就炸），bundle 亦含同一守卫（`dist/bundle/cli.js` 实测内容）。→ 无缺口（真实正控：F4 就是它触发的文案）。
- **tsx 解析**：`prime-agent.sh:69-77` 显式检查 `$SCRIPT_DIR/node_modules/.bin/tsx` 可执行，失败给可操作提示并 exit 1。→ 无缺口。
- **cwd 依赖**：脚本全程用 `SCRIPT_DIR`（`cd "$(dirname ...)/.."` 只在 setup-kernel-venv.sh），可任意 cwd 调用。→ 无缺口。
- **`--dist`**：检查 `packages/coding-agent/dist/bundle/cli.js` 存在，否则提示 `npm run build`（`prime-agent.sh:58-66`）。残余 R-1：**不校验 bundle 与 src 的新旧关系**——本机 `dist/bundle/cli.js` mtime 2026-09-16 07:48 而 HEAD 提交 07:41，二者接近纯属巧合；长期跑 `--dist` 的用户可能在自认为"最新源码"的情况下跑旧 bundle。**severity P4，confidence high，可复现**（`git log -1 --format=%cI` vs `ls -l dist/bundle/cli.js`）。
- 残余 R-2：`--no-env` 只 unset API key，但不动 `PRIME_AGENT_*`/`RLM_*`（`prime-agent.sh:19-57` 的 unset 列表逐项可查）；若意图是"干净环境复现"这是不够的。P4，informational。

---

## ⑤ 版本间升级：旧 settings / 旧会话文件向前兼容（结论：两条都有真迁移与真测试，一条边界未覆盖）

**settings 侧——有实测依据的正面结论**：写入是**读-改-写**，保留未知键。
- `packages/coding-agent/src/core/settings-manager.ts:1545-1550`：
  ```
  		this.storage.withLock(scope, (current) => {
  			const currentFileSettings = current
  				? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
  				: {};
  			const mergedSettings: Settings = { ...currentFileSettings };
  ...
  			// A write that carries unknown keys back to disk keeps them visible.
  			this.reportUnknownSettingsKeys(scope, mergedSettings);
  ```
- 未知键有专门诊断而非静默吞掉：`:1481-1489`（文案逐字："unknown settings key ... its value never takes effect. The value is kept in the file."）。
- 兼容语义的键级迁移：`:1136-1200`（queueMode→steeringMode、websockets→transport、skills 对象/数组、retry.provider 等）。
- **测试面**：`packages/coding-agent/test/settings-unknown-keys.test.ts` 共 10 例，含 `it("keeps the values a user wrote even when the key is unknown")`（:81）与显式 "positive controls" 段（:129-165，含"正确键不报警"）。→ 旧文件 → 新版本 方向有真验证，且含负控。
- **migrations.ts 面**：一次性迁移（auth.json/oauth.json/settings apiKeys/会话目录扁平化/keybindings）有 `test/migrations.test.ts` 22 例（含 control 例 `:420`、锁竞争例 `:439`）。

**会话文件侧**：有版本头与迁移链，有测试。
- `session-manager.ts:688-698`：`const version = header?.version ?? 1; if (version >= CURRENT_SESSION_VERSION) return false; if (version < 2) migrateV1ToV2(entries); if (version < 3) migrateV2ToV3(entries);`（`:117` 注释 "v1 sessions don't have this"，`:1207-1214` 对无 id/parentId 的 pre-v2 体盖章 version 1 以进入迁移）。
- 测试：`packages/coding-agent/test/session-manager/migration-id-collision.test.ts`、`test/suite/regressions/r2-catalog-append-tail-repair.test.ts` 均引用 `CURRENT_SESSION_VERSION`。
- **未覆盖面（本条唯一的负结论，带正控）**：`version > CURRENT_SESSION_VERSION`（新版本写的文件被旧 CLI 读）在 `:693` 直接 `return false` **不做任何迁移、也不报"文件来自更新版本"**；`grep -rn "CURRENT_SESSION_VERSION" package/coding-agent/test` 只命中上述两个文件，均覆盖 v<CURRENT 方向 → 降级/新旧混装方向的对外行为无测试。正控：同一 grep 方法命中了确实存在的 v1→v2 迁移测试，说明该方法能检出"有测试"的同类，因此"降级方向无测试"是真实覆盖缺口，不是没扫到。
- 影响：本机不存在降级常态，风险限于"多版本并存/回滚旧 CLI"；severity P4，confidence medium（未构造 v4 头文件实测其表现）。

---

## 与 decisions.jsonl 的去重说明
- SUP-D（fd/rg 走 releases/latest 无校验）：已 fixed；本线 F1-F3 均不涉及该面。
- GL-5（DOWNLOAD_BASE_URL 自拆闸 / registry 车道）与 FR-1（manifest 拉取失败归因文案）：已修，本线读过 `package-manager-cli.ts:573-576`（诚实文案在位），未重复报。
- DAT-4（update-restart manifest 直写终路径无原子性）：已修，本线确认 `daemon-update-restart.ts:writeJsonAtomically`（tmp+rename）在位；F1 是**另一件事**（复用无年龄闸），不是它的复发。
- X1（venv 解释器 win32 硬编码）：属 ④ 子线面，本报告不涉及。

## 结论摘要
1. **F1（P3，high/medium）**：prepared manifest 客户端复用零年龄判据；30 天前 manifest 被原样返回（已实测），与 daemon 侧 30 分钟窗口不对称。
2. **F2（P3，high）**：安装后零校验，"已更新到 vY"完全取自 manifest 自报；正控：同文件对下载字节有 sha256 闸。
3. **F3（P3，medium）**：安装原地无回滚 + 协调器从被重写过的 argv[1] 启动 + 失败仅 warning、退出码不变。
4. **F4（P4）**：Node 版本引导指向官方发布页（fork 场景错误引导）。
5. **② 残余（P4）**：`--dist` 无 bundle 新旧校验；`--no-env` 不清 `PRIME_AGENT_*`。
6. **⑤ 正面**：settings 未知键读-改-写保留 + 有测试负控；会话有 v1→v2→v3 迁移链与测试；唯一覆盖缺口是 `version > CURRENT` 的降级方向（P4）。


---

# 子线合并（①install.sh / ④bootstrap-cli+kernel venv）—— 编排席汇总

两条子线各自交付全文：`/tmp/audit_r/round-36/install-sh.md`（17.0 KB）、`/tmp/audit_r/round-36/bootstrap-kernel.md`（22.2 KB）。
编排席质量闸：对两条子线的关键引文做了逐字抽检复核，全部对上——
- `install.sh:1460` `checksums_url="$prime_agent_base_url/releases/v$version/SHA256SUMS"`（与 tarball 同源）与 `:1472/:1478` `curl -fsSL` 无 `--proto/--proto-redir/--max-time` → 子线 ①②⑧ 成立；
- `bootstrap.ts:656` `stdio: options.stdio ?? "ignore"` 与 `:674-675` `failed with ${reason}`（仅 exit code/signal）→ 子线 ④-F1 成立；`:1495-1499` 固定文案"First-time setup needs internet…"印证误归因；
- `bootstrap.ts:1473-1483` `kernelReady` = `hasPrimeAgentRuntime` + `bootstrapVersionCurrent`（不含默认包 import 检查，该检查只在 `:1509` env 覆盖路径与 `:721` 新建路径）→ 子线 ④-F3 成立。
另：审计期间 HEAD 前进到 `59f30009c`，diff 仅 `docs/fork/audits/decisions.jsonl` +4 行（新增 INS-1..INS-4，即本线上报的 F1-F4），所审文件零改动。
注意：本线 F1-F4 已被登账为 INS-1..INS-4；**install.sh 与 bootstrap 两条子线的全部条目尚未登账**（除 install.sh 子线第 7 条自陈属已记录的 F20 部分修复）。

## ① install.sh（14 条，全部在 /tmp 伪造 HOME + 本地 HTTP 源 + 假 npm 下实测，未向系统安装任何东西）
- **P2 · 校验和与 tarball 同源同目录、无签名**（`install.sh:1460/1478/1483-1500`）：实测把包换成 EVIL 并同步改 `SHA256SUMS` ⇒ **"OK" + exit 0 装上了被篡改包**；只改包则 `FAILED` + exit 1（正控证明检测本身有效）。confidence high。
- **P2 · 无 https 强制、无 `--proto/--proto-redir`**（`:9/961/1472/1478`）：明文 http 源实测装成功 exit 0；302 被跟随（curl 默认允许跨 scheme 重定向）⇒ https→http 降级可行。high。
- **P2 · 静默覆盖已有安装**（`:916-919/1601-1610`）：预先 `npm link` 的 dev 源码安装被换成发布版真目录，exit 0、无备份无提示；preflight 的 "Existing … found at" 说的是 PATH 解析结果而非被覆盖的 npm prefix。high。
- **P2 · 端到端只在发布工作流 happy path**（`build-binaries.yml:175(+208)`；`ci.yml` 0 处）：`npm run check` 里的 `check-installer.mjs` 只测渲染+npm flag 策略（实跑 exit 0）⇒ 篡改/非 https/非 tty/失败/并发零覆盖。high（含 `test -x .../bin/prime-agent` 正控）。
- **P2 · 并发两装无锁**（`:1601-1610`）：一方 exit 0 报成功、另一方 `EEXIST` exit 239，终态是后者版本 ⇒ 报告与事实三方矛盾。high。
- **P2 · 无备份/回滚，原子性全外包 npm**（`:158-170`）：坏包(253)/postinstall(7)/SIGINT(130) 旧版均保留（正面），但 **SIGKILL 中断残留 `bin` 僵尸链接 `.prime-agent-<rand>`**。high。
- **P2 · Node 候选选择器仍 20.6 阈值**（`:1054-1075`；preflight 已 22.8，`：899`）：Linux 无 NodeSource 时会先装不达标 Node 再被 22.8 闸拒。子线自陈属已记录 F20 的**部分修复**。med-high。
- P3：curl 无 `--connect-timeout/--max-time/--retry`（`:961/1472/1478`，黑洞镜像实测 12s 仍挂起）；成功判定用 `command -v` 看 PATH 上旧命令（`:120-125`，实测打印 "Run it with: prime-agent" 却指向本机旧装）；Node 自举同源无签名 + `latest-v22.x` 滚动目录（`:1184-1246`，未实跑）；SIGKILL 泄漏 `$TMPDIR/prime-agent-install.*`（`:158-170`，INT/TERM 会清=正控）；standalone Node 先 `rm -rf` 后解压、`current` 切换非原子（`:1220-1223`，解压失败毁掉已有 Node）；无 `--dir/--no-*` 且 `PRIME_AGENT_VERSION` 静默压过位置参数（`:932-955`，实测 beta+env→装 0.0.1）。
- 负结论（带正控）：临时目录权限 0700、无 bashism（`/bin/dash` 全流程 exit 0）、关键管道均有显式判据——"未见"是本次扫描范围内的判断。

## ④ bootstrap-cli / kernel venv（6 条）
- **P2 · 所有 uv 子进程 stderr 被丢弃**（`bootstrap.ts:647-678` 的 `:656` `stdio ?? "ignore"`；调用点 `:1323/:1324/:1325/:1444`）：磁盘满/权限/代理/TLS/索引错误同形为 "…failed with exit code N"，再被 `:1495-1499` 固定文案误归因成"需要联网"。假 uv 实测 + 真 ENOSPC 正控（uv 原话 "No space left on device (os error 28)" 只出现在被丢弃的 stderr）。high。
- **P2/P3 · 拿到锁后 uv 全部无 timeout**（`:647-678`；`lockTimeoutMs` 只界 `:828-830` 等锁循环）：黑洞网络下首跑长静默。medium（未复现，读码）。
- **P3 · "存在但不可写"绕过设计诊断**（`:561-581` 用 `mkdir(已存在父目录, recursive)` 当可写判据；`:1568` `acquireBootstrapLock` 在 `:1572` try 之外）：实测裸 `EACCES: permission denied, mkdir '<home>/.prime/agent/kernel-venv.bootstrap.lock'`、EXIT=1，消息无 kernel/python/venv 字样、无出路；正控（`.prime` 不存在 + 只读 HOME）才打印设计文案。high。
- **P3 · 热 venv 就绪判据不验默认包**（`:1473-1483`；默认包 import 检查只在 `:1509` 覆盖路径与 `:721` 新建复检）：实测把 warm venv 的 `import pandas` 改坏后重跑 ⇒ `kernel python: …` EXIT=0，无 rebuild 无 warning。high。
- **P3 · 坏机器每次 boot 都空转**（`:1604-1610` + `venv-in-use.ts:396-430`）：半成品**不中毒**（无 manifest 残留 → 打印 "rebuilding unreferenced kernel venv …" + ✓ready EXIT=0，正面），但满盘/只读卷/noexec 下每次启动都 `rm -rf` + 重跑三连 uv。high。
- **P3 · 交互首跑失败静默**（`tools/ipython.ts:409-412` prewarm 吞错 + `agent-session.ts:12247` + `main.ts:833`）：只看到 "setting up python kernel (one-time, ~30s)…" 之后无事，直到第一次 Python cell 才报。medium-high。
- **P3 · uv 获取链**（`:79/:851-883/:1323`）：无 pin 无校验无镜像、依赖 `sh -c`（win32 无 sh）、`[Y/n]` 提示因 `ipython.ts:604` 恒给 onProgress 成死代码；python 只锁 "3.11" 不锁 patch。high。
- 覆盖实测：直跑 vitest 5 文件（kernel-bootstrap/-lock/-in-use/runtime-pinning/python-resolution）= **66 tests passed，VITEST_EXIT=0**（先 unset RLM_*/PRIME_AGENT_*/PI_*）；CI 冷启动确被真跑（`test:ci` 首步 + `ci.yml:283-301`），但全 happy path——uv 缺失拒绝文案（`:860-865`）、`curl|sh` 安装器、只读目录、真 ENOSPC **零覆盖**（`grep "uv is required|PRIME_AGENT_INSTALL_UV" test/` 0 命中；同一 grep 能命中相邻已覆盖面 = 正控）。
- 正面：首跑判据是活探针 `hasPrimeAgentRuntime` + manifest（schema/runtime 内容哈希/pin 列表/skills 内容哈希），**不是目录存在**；半成品会被识别并重建；热路径实测 0.32–0.75s/次。默认包全 == pin（`:62-75`，dill 例外）；runtime 本地源码优先、裸名 registry 默认拒绝（`:1187-1199`）；锁 base-keyed + pid 存活 + 30s 无 pid 陈旧 + 默认 300s 上限（E5 用 3s 实测超时文案完整、EXIT=1、他人锁未破坏）。
- 未验证边界（子线自陈）：F6 黑洞网络未复现、win32 全链无 runner、F5 的 UI 侧、真 `curl|sh` 未跑。
