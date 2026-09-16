# Round-28 impl — BSH-1/2/3/4 (0902 簇③ SEC-4 bash 通道断点)

- 基线（冻结）：主仓 HEAD `40f781578538fd53d517fed37b726428b842fba7`（branch `merge/repl-kernel`，只读未动）。
- 工作树：`/tmp/wt_bsh`（`git worktree add`，node_modules symlink 自主仓），分支 **`r28/bsh-fixes`**，交付提交 **`8c941cd35`**（9 files, +266/-8）。未 push（无 FORK_NOTES 义务触发）。
- 依据：`/tmp/audit_r/round-28/0902-final.md` §14（P1/P2/P3/P7）＋子席报告 `/tmp/audit_r/round-28/cluster3-sec4-bash-paths.md` §8A。探针形状沿用 `/tmp/r28_c3_own/drive_poscontrol.mts`（生产 `createLocalBashOperations`→`getShellEnv()` 通道）。

## 1. 改动本体（两张表同步，逐名对称）

`packages/coding-agent/src/utils/shell.ts` `SHELL_CHILD_SAFE_ENV_KEYS` 与 `prime-agent-runtime/src/rlm/bash.py` `_CHILD_SAFE_ENV` 各新增 9 个非机密名，并同步改写两处 doc comment（说明“agent 自身 CLI 也走这条通道”+两表互为镜像）：

| 名字 | 类别 | 归属 |
|---|---|---|
| `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET` | 路由（socket 路径） | BSH-1 |
| `PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID` | 路由（会话 id） | BSH-1 |
| `DO_NOT_TRACK` / `PI_OFFLINE` / `PRIME_AGENT_TELEMETRY` | 隐私 opt-out | BSH-2 |
| `PRIME_AGENT_TRUSTED_UPDATE_ORIGINS` | 路由（可信镜像 origins） | BSH-2（“TRUSTED 同类”核查后并入） |
| `PRIME_AGENT_CODING_AGENT_DIR` / `PRIME_AGENT_SESSION_DIR` | 路由（目录钉子，P2） | BSH-3 |
| `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR` | 路由（ownership 注册表目录） | BSH-3 |

机密面不动：`PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN`、provider keys、`SSH_AUTH_SOCK`、`RLM_*` 仍被剥（既有测试继续断言）。

## 2. 红证（改前必红，均经生产 bash 通道）

新增 `packages/coding-agent/test/shell-env-routing.test.ts`（+fixture `test/fixtures/env-routing-child.ts`，导入生产 `backgroundNetworkOptOut()`，形状＝drive_poscontrol：父进程 stub 名字→生产 `createLocalBashOperations().exec` 起 tsx 子进程→断言子进程读到的值）：

- 改前（`40f781578`）：**6/6 FAIL**（optOut=null、socket/session/agentDir/sessionDir 全 null；worker token 剥离的负控断言本身成立）。
- 改后（`8c941cd35`）：**6/6 PASS**；`test/exec-env-filter.test.ts`（SEC-4 原测）3/3 PASS——机密剥离未回退。

kernel 侧 `prime-agent-runtime/test/test_bash_env.py` 新增 `test_bash_children_keep_routing_and_optout_names`（同测 9 名字转发 + 同 child 内 WORKER_TOKEN 负控）：

- 改前：**FAIL**（`'DO_NOT_TRACK=1' not found … DO_NOT_TRACK dropped from bash() child`，其余 3 测 PASS）。
- 改后：**4/4 PASS**。运行方式：`PYTHONPATH=/tmp/wt_bsh/prime-agent-runtime/src`（editable 安装指向主仓 src，须显式前置工作树路径；已验证 `rlm.__file__` 解析到工作树）。

## 3. BSH-3 逐名判断清单（加/不加＋理由）

**加（路由性、非机密，已进两张表）**：上表 9 名。要点：socket 路径/会话 id/目录路径均非凭据；agentDir 本就经 `getShellEnv()` 的 PATH 注入（`<agentDir>/bin` 前置）对子进程可见，无新增暴露面；supervisor socket 是同用户本地控制面（默认路径可枚举），真正的机密 WORKER_TOKEN 仍剥。

**不加（机密或另行裁）**：

| 名字 | 理由 |
|---|---|
| `PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN` | 机密（worker socket 凭据），SEC-4 核心，绝不加；两侧测试负控锁定。 |
| `PRIME_AGENT_INTERNAL_DAEMON_WORKER_INSTANCE_ID` / `_RECOVERY_JOURNAL` / `PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL` / `SESSION_LEASES*` | worker 内部簿记（路径/旗标，非机密），但嵌套 CLI 无生产读点需要它们；passthrough 可自救。 |
| `RLM_DEPTH` / `RLM_MAX_DEPTH`（P7） | 非机密整数账本，但**不加**：产品自己在 supervisor→worker spawn 显式 `delete workerEnvironment.RLM_DEPTH`（daemon-supervisor.ts:3940），且注明 TS 侧 spawn check 为权威（“RLM_MAX_DEPTH may be stale in an already-running kernel”）——经 env 继承可能带陈旧值过度约束嵌套跑；且子进程本可自设 `RLM_DEPTH=0`，从来不是对模型的边界，只是防意外递归的纵深。需要恢复谱系上限的部署可用 `PRIME_AGENT_ENV_PASSTHROUGH=RLM_DEPTH,RLM_MAX_DEPTH`。 |
| `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`（大小写共 6 名，P4） | 非机密路由，但超出 BSH-1/2/3 授权面；文档 passthrough 示例即以它为例。 |
| `TERM`/`NO_COLOR`（P8） | 两表一致性课题（kernel 钉 `TERM=dumb`、host 无），属子席建议 F，非 BSH。 |
| `PRIME_AGENT_KERNEL_PYTHON`/`_VENV`/`_DOWNLOAD_BASE_URL`（P6）、`_LAUNCHER_PATH`/`_BUILD_ID`（P9） | 非机密运行时身份钉子，嵌套 CLI 相关性低、超出授权面；passthrough 已文档化。 |

BSH-1 取舍：按母席“二选一按最小改动”指令走 **allowlist 路线**；产品侧显式传值（子席建议 D：`resolveUpdateDaemonSocketPath` 不静默回落默认 socket、记 `socket_source`）未做，留作后续加固项——本次只消“剥掉”这一半，静默回落逻辑本身仍在（若用户手清 env 仍可能错靶）。

## 4. BSH-4 文档

- `packages/coding-agent/docs/security.md`：新增 “Shell child environment” 小节——定位改口为**防被动泄漏/防被执行的第三方代码顺手读走**；明写 kernel 进程保留全量 env、模型可在 Python 里读 `os.environ` 拼进命令，真实边界是 OS 用户隔离；列出转发名与 `PRIME_AGENT_ENV_PASSTHROUGH`。
- `docs/settings.md`（Shell 节）与 `README.md`（env 表后）：各加一段＋例子 `PRIME_AGENT_ENV_PASSTHROUGH=HTTPS_PROXY,HTTP_PROXY,NO_PROXY prime-agent`（须在启动 agent 的进程上设置，children 从 agent 进程读取）。
- changelog fragment：`packages/coding-agent/.changes/r28-bsh-shell-env-routing.md`（runtime 包无 CHANGELOG/.changes 体系，未加）。

## 5. 验证矩阵（全部在 /tmp/wt_bsh，测试命令均带 17 个 `-u` 泄露变量清 单：RLM_*、PRIME_AGENT_INTERNAL_*、PRIME_AGENT_ENV_PASSTHROUGH、PRIME_AGENT_CODING_AGENT_DIR、PI_* 等；vitest 用 `node ../../node_modules/vitest/dist/cli.js --run`，py 用 `PYTHONPATH=<工作树>/src` + `/opt/homebrew/bin/pytest`）

| 检查 | 结果 |
|---|---|
| 新 TS 测改前红 | 6/6 FAIL（@40f781578） |
| 新 TS 测改后绿＋exec-env-filter | 9/9 PASS |
| 4606-update-restart-coordinator（回归） | 5/5 PASS（15.2s） |
| py test_bash_env 改前红/改后绿 | 1 FAIL（DO_NOT_TRACK dropped）→ 4/4 PASS |
| `npm run check`（biome --error-on-warnings + tsgo --noEmit + installer/browser-smoke/ci-honesty） | EXIT 0（15s） |
| `npm run check:test-hygiene` | OK（no new private-member probes） |
| 提交后 pristine 检查（`git archive HEAD`→临时树＋symlink node_modules→`npx tsgo --noEmit`） | EXIT 0 |

提交纪律：9 文件逐个 `git add`，staged 清单核对（无他人文件）；提交 `8c941cd35`；主仓零写入（status 仅原 lanes 的 decisions.jsonl/out.txt/png，未触碰）。禁令遵守：未跑 `doctor --fix`、未跑 `daemon ps -k`；单命令均 <60s（最长 4606 测 15.8s、check 15s）。

## 6. 残余/未做（供后续轮次）

1. BSH-1 的 D 建议（update 不静默回落默认 socket + `socket_source` 可观测）未做——allowlist 只修“经 bash 起的 CLI”一半，用户手清 env 的错靶风险仍在。
2. P4（代理变量）、P5（HERDR_* 双通道单一真源）、P6（kernel 钉子）、P8（TERM 两表一致性）、P9（运行时身份）未动，全部可经已文档化的 `PRIME_AGENT_ENV_PASSTHROUGH` 自救。
3. P7 判断为“不加”（见 §3 理由），若要恢复谱系上限继承需产品侧显式传值（走 session header 而非 env）。
4. `vi.stubEnv` 在有子进程 spawn 的测试间不回收（本轮实证，靠互补 stub 规避），vitest 行为备忘。
