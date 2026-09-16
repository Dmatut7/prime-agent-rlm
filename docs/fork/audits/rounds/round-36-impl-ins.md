# r36 修复交付 · INS-1 / INS-2 / INS-4（安装线 impl）

- 冻结基线：主仓 HEAD `59f30009c1afcec6bf748cb1f16d929f49b4d1d8`（与审计报告冻结点之后的最新主仓 HEAD，父令指定）
- 实现工作树：`/tmp/r36_ins`（detached，node_modules symlink 主仓），提交 **`e6db9230e`** `fix(coding-agent): r36 install-chain integrity (INS-1/2/4)`
- 基线对照工作树：`/tmp/r36_base`（同 SHA 原样，用于甄别环境性失败）
- INS-3 不修（备份/回滚是产品取舍，按父令留登记）。

## 改动文件（9 个，全部本会话内新增/修改，逐文件 git add，staged 已核对）

| 文件 | INS | 内容 |
|---|---|---|
| `src/package-manager-cli.ts` | 1,2 | manifest 读器加 `maxAgeMs` 上界 + 过窗删除并打 warning；`tryReadPreparedDaemonUpdateRestartManifest` 传入 30 分钟窗（两条复用路径 :1039/:1518 与导出入口 :1089 全部经它）；更新回执改为读实际安装版本比对 |
| `src/config.ts` | 2 | 新增导出 `readInstalledSelfVersion()`：从 `getPackageJsonPath()` 现读磁盘上的版本（npm 全局原地覆盖后即为新装的版本；装错 prefix 时读到旧值→如实报差异） |
| `src/core/session-manager.ts` | 4b | `migrateToCurrentVersion`：`version > CURRENT_SESSION_VERSION` 显式 throw（"newer than this Prime Agent supports…Upgrade"），不再静默 return false |
| `src/cli/node-version-check.ts` | 4a | 旧 Node 指引改为本仓 build-from-source 路径（`npm ci && npm run build && npm link` + README "Getting Started"/FORK_NOTES.md），去掉官方 releases/latest 误导 |
| `test/r36-stale-manifest-age.test.ts` | 1 | 红测：30 天前 manifest → 必须 reject + 文件被删 + warning 含 "stale"；正控：新鲜 manifest 照常返回 |
| `test/r36-self-update-installed-version.test.ts` | 2 | 红测：fake npm 装出 88.0.0、manifest target 99.99.99 → 回执不得出现 `to v99.99.99` 且 stderr 报 88.0.0/99.99.99；正控：装出版本==target 时照旧打绿行 |
| `test/session-manager/r36-newer-session-version.test.ts` | 4b | 红测：v(CURRENT+1) 头 → `toThrow(/newer/)`；正控：v2→v3 照常迁移、v3 不动不炸 |
| `test/node-version-check.test.ts` | 4a | 原"官方 releases"断言改为 fork 断言（含 npm run build + FORK_NOTES.md + not 官方 URL） |
| `.changes/r36-update-install-integrity.md` | — | changelog fragment（4 条 bullet） |

## 先红后绿实证（每条改前跑过红）

- INS-1 红：`promise resolved "{formatVersion: 1, …}" instead of rejecting`（30 天 manifest 原样返回＝审计 F1 复现）；绿：2/2 pass。
- INS-2 红：`expected 'Updating prime-agent…' not to contain 'to v99.99.99'`（回执照抄 manifest）；绿：2/2 pass（含匹配正控）。
- INS-4a 红：`to contain 'npm run build'`（现文案只有官方 releases URL）；绿：11/11 pass。
- INS-4b 红：`expected [Function] to throw an error`（静默不迁移）；绿：3/3 pass。
- 审计原脚本 `/tmp/r36_stale_run.mts` 对修复后源码（改 import 路径版 `/tmp/r36_stale_run_fixed.mts`，tsx 0.6s）：CASE_A 从"原样返回 manifest"变为 **throw 连接错误**（当作不存在），stderr 出现 `Discarded a stale prepared daemon update restart manifest (older than 30 minutes): …`，且脚本自身随后的 `statSync` ENOENT（文件已被删）＝审计复现的逐字反向。

## 回归（全部 node 直调 vitest、unset 泄露变量、分批 ≤3 文件）

- 绿：package-self-update-daemon(9)、dat4-manifest-atomic-write、interactive-update-relaunch、public-command(38)、startup-package-update-privacy(4)、k3r2-package-cli-settings-warnings、fork-self-update(9)、session-manager/migration(2)+migration-id-collision、update-spec、update-spec-trust、git-update、session-manager/{damaged-header-salvage,torn-tail-repair,k3p4-oversize-trailing-record,save-entry,session-state,flat-storage}、suite/regressions/4257-update-restart-resume(34)、r2-catalog-append-tail-repair。
- `package-command-paths.test.ts` 17 例中 4 例红（非 --force 的 self-update 用例：exitCode 1 / busy-session 拒绝文案）。**基线甄别**：同 4 例在 pristine `/tmp/r36_base`（无本次改动）逐字同样红——本机真 daemon 应答探针（"4 busy sessions"＝本会话家族）所致的环境性失败，与本改动无关（--force 用例与全部 manifest 用例在本工作树仍绿）。

## 质量闸

- `tsgo --noEmit`（根 tsconfig，含 test）：工作树 EXIT 0；**pristine tree**（`git archive HEAD`+symlink node_modules）EXIT 0。
- biome check（8 个触碰文件）EXIT 0。pre-commit hook 走完（commit exit 0）。
- 纪律：单命令 ≤60s、分批 ≤3、无 `doctor --fix`/`daemon ps -k`、主仓零写入（仅 symlink 读）、git add 逐文件 + staged 核对、先报告后回话。

## 遗留 / 未做（如实登记）

1. **dist bundle 未重建**：改的是 src；`prime-agent` 命令 symlink → `dist/bundle/cli.js` 仍是旧 bundle（含旧 Node 指引文案）。生效需 `npm run build` + `prime-agent shutdown` 重启（fork 规则）；45 分钟窗口内未做。
2. 未 push（无推送则不触发 FORK_NOTES 更新义务）；如需 push 需先补 FORK_NOTES 一节。
3. INS-1 的 30 分钟窗常量为客户端侧独立定义（`package-manager-cli.ts`），与 daemon-supervisor 的 `UPDATE_RESTART_PREPARED_RESTORE_WINDOW_MS` 数值对齐但未共享常量（跨模块 import daemon-supervisor 会拖重模块，按最小改动取舍）。
