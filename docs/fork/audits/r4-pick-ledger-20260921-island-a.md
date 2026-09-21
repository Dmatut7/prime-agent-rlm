# R4 拾取台账 · 岛席 A（r4/island-a）

施工仓：/Users/a1/Desktop/ai/pa-r4-island-a（分支 r4/island-a）。任务：bootstrap 岛 3 笔＋孤点 1 笔，共 4 笔。
拾取序＝母席任务卡编号清单：1df880d81(#3) → fc9f2ae24(#7) → d96a990b4(#19) → c13e03113(#1)。
说明：表格上游序为 c13e03113(#1)→1df880d81(#3)→fc9f2ae24(#7)→d96a990b4(#19)（git 祖先序已核实）；四笔文件面不相交，孤点先后不影响终态与冲突内容，按卡序（孤点殿后）执行，合流序由母席统一。

| # | sha | 落点commit | 冲突文件数 | 真MD处置 | 撞名/弃hunk | 定向测试结果 | 备注 |
|---|---|---|---|---|---|---|---|
| #3 | 1df880d81 | d42f55e28 | 1（bootstrap.ts 两 hunk：fork 结构＋上游 readyForCaller 语义，保 claimedPython/base 键锁） | 0（三件全在场） | 上游测试两例按 fork 生成目录范式适配（base/activeKernelVenvDir/contentHash），已并入同笔 commit（amend，分支未合流） | kernel-bootstrap.test.ts 29/29 绿（消毒跑法） | 上游自带 .changes fragment 随笔落盘 |
| #7 | fc9f2ae24 | f7a7a96c0 | 2（bootstrap.ts：保 fork uvRun/kernelInstallArgs/基线 marker 结构＋取上游去 --seed 与注释；test：fork 恒 rebuild 结构＋去 --seed，弃上游 existsync/rebuilds 参数化写法——fork 无该参数化测试） | 0 | 弃 hunk：上游 rebuilds 参数化断言形态（fork 各测试独立恒 rebuild）；删 prompt-command-reality「seeded one, contrary to the old claim」死命题探针（提示词已不再宣称 seed；对活 venv 反转会假红） | kernel-bootstrap＋superset＋prompt-command-reality 44/44 绿（消毒跑法） | fork 侧语义耦合适配：rlm.ts KERNEL_PACKAGE_INSTALL_PROMPT 删 `-m pip` 教法与 seed 宣称（fresh venv 上为假命令）、prompt-command-reality 断言 >1→>0；fragment 随笔落盘 |
| #19 | d96a990b4 | 42971d131 | 2 文件 7 块（bootstrap.ts 5 块＋test 2 块＋追加适配；fork 已自研等价机制：原子换名/基线 marker/增量写/marge 读取全在场） | 0 | 弃 hunk：上游 writeMergedBootstrapVersion（fork writeBootstrapVersion 内建 merge 等价）；上游 it.each 压缩版 rebuild 测试＋writeFakePython deniedProbes 重构（fork 分立测试已覆盖同 5 场景）；上游「writes the base marker…」新测试（命题 ⊂ fork 既有「lands the base marker…」，弃之并恢复被换位吃掉的 fork「continues when…failed install retries」测试保住失败重试语义钉） | kernel-bootstrap.test.ts 30/30 绿（含新增真 SIGKILL 子进程恢复测试，消毒跑法） | 净增量＝真进程 kill/resume 测试＋helpers/kernel-sync-child.ts（新建测试旁文件）；源侧 4 行净变化（注释/常量去重归位）；fragment 随笔落盘 |
| #1 | c13e03113 | 246661f8e | 1（ci.yml 一处：保 fork 覆盖门/标签账步骤＋fork 自有 test-hygiene job（fork 有意以 test-hygiene 替换上游 standalone job），上游 behavioral harness 步骤缀 matrix job 步骤尾，条件面 fork 的 runtime python 行在场；.gitignore/CONTRIBUTING/SECURITY 自动并） | 0 | 弃 hunk：上游上下文 `standalone:` job 头（fork 无此 job，build-check-test 已引 test-hygiene，不复活） | 本笔自带模型无关自测：ruff check ✓ / ruff format --check 15 files ✓ / pytest 39/39 ✓（uv 消毒跑法）；两 workflow YAML 解析 ✓ | 上游 fragment 规则不适用（scripts 侧无 .changes 机制）；evals/short_swe 17 新文件全量落盘 |


## 收尾发现（本席实测）

1. **worktree 席位 hooks 静默旁路**：`core.hooksPath=.husky/_`（共享配置），但 `.husky/_` 是 husky 安装期生成的 per-worktree 目录；新建 worktree 里它为空 → cherry-pick/commit 全部**不跑 pre-commit**（本席 4 笔拾取皆如此；非 --no-verify，是环境缺口）。本席已在 worktree 内执行 `npx husky` 补生成；**合流侧请以主仓 armed hook 再验**。
2. **linked worktree 内 hook 必红（两处同根病，均己修）**：git 对 linked worktree 的 hook 导出**绝对 GIT_DIR＋GIT_INDEX_FILE**（主 worktree 只导出相对 GIT_INDEX_FILE、不导 GIT_DIR——/tmp 探针仓实测对照），exported GIT_DIR 会劫持普通 git 命令的仓发现：
   - `scripts/latest-ci-run.sh` self-test 的 `resolver_case`：`git init` 对 exported gitdir no-op、`git -C "$repo" remote add origin` 命中本 checkout 的仓 → `remote origin already exists` exit 3 → `set -e` 杀链。修法：self_test() 顶部与既有 `unset PREFLIGHT_GH_REPO` 并排 `unset GIT_DIR GIT_INDEX_FILE`。
   - `scripts/check-process-smoke.sh` ROOT 发现：`git -C "$SCRIPT_DIR" rev-parse --show-toplevel` 在 exported GIT_DIR 下**答 cwd（scripts/）而非 checkout 根** → `not a prime-agent checkout` exit 2。修法：发现调用剥 GIT_DIR/GIT_INDEX_FILE（保留既有 REPO_ROOT 覆盖与逐级上溯回退）。
   - 正负控（配对）：修前 `GIT_DIR=<worktree gitdir> npm run check` 依次死于 latest-ci-run（exit 3）→ process-smoke（exit 2）；修后同模拟全链 **EXIT=0**（/tmp/r4_island_a_hooksim_check2.txt，195 行）；净 env 自测无回归（18/7 controls, 0 mismatches）；链尾 installer/browser-smoke/pre-push 三自测在模拟 env 下逐项 rc=0。
   - 两修法经 armed pre-commit hook 提交本身就是活体正控（修前该 hook 在 linked worktree 必红）。
3. **影响面**：任何 linked worktree 席位（r4/first-hour、r4/island-b 等）补生成 husky hooks 后同样受此病；不生成的则静默旁路。43 笔拾取清单零笔触碰这两个脚本（已全量扫），无撞车道风险。

## 收尾三笔（母席 2026-09-22 裁定后落地，均过 armed hook）

| 笔 | commit | 内容 |
|---|---|---|
| 收1 | 7c96e6679 | fix(scripts)：latest-ci-run.sh resolver_case＋check-process-smoke.sh ROOT 发现剥 hook 导出 GIT_DIR/GIT_INDEX_FILE（发现 2 的两处修法，带正负控说明） |
| 收2 | b9dc50d13 | style(prompts)：rlm.ts KERNEL_PACKAGE_INSTALL_PROMPT 的 biome 引号风格修正（#2387 拾取的格式化余波，内容转义后逐字节同） |
| 收3 | （本笔） | docs(fork)：本台账落盘 |

终验：worktree 根 `npm run check` 全量（/tmp/r4_island_a_check_final.txt，不截断）＋`bash scripts/latest-ci-run.sh --self-test` 全绿；分支未 push、未动干线。
