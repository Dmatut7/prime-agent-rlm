# 同步任务书 R3 · v2（2026-09-04）

> **版本注记**：v1（446 行）经三个审查代理分镜头审查后重写。审查结论：**6 阻塞 / 22 重要 / 22 次要 / 79 条已二次验证的确认**。
> - rev-logic（kimi-k3，逻辑与流程镜头）：3 阻塞 / 8 重要 / 6 次要 / 18 确认 → `/tmp/rev_logic.md`
> - rev-facts（qwen3.8-max-0902，事实核查镜头）：3 阻塞 / 9 重要 / 16 次要 / 45 确认 → `/tmp/rev_facts.md`（+2 子报告）
> - rev-exec（qwen3.8-max-0902，可执行性镜头）：7 阻塞 / 13 重要 / 10 次要 / 16 确认 → `/tmp/rev_exec.md`
> **施工材料在附录** `docs/fork/sync-upstream-r3-appendix.md`（549 行）：确切 patch、可执行命令、20 步逐步缺口表。主文档只写决策与口径。
> v1 存档 `/tmp/sync_TASKBOOK.md`；lane B 的 PR 评估补充件已并入本版 S7，原 `sync-upstream-r3-addendum-B.md` 作废删除。

> 输入：upstream/main 40 个新提交（官方已发 v0.9.0 + v0.9.1）+ 官方 66 个 open PR 中 30 个上次审计后新出现的。
> 基线：`merge/repl-kernel` @ `0c504e475`，分叉点 `5b6c0e94e`（#1864）。本地版本停 0.8.1。
> 证据：`/tmp/sync_a_upstream40.md`(96KB) `/tmp/sync_b_newprs.md`(139KB) `/tmp/sync_c_localassets.md`(80KB) `/tmp/sync_d_conflicts.md`(103KB) + 三份子报告。

> **行号基准标记（v1 全程未标，是 IM2/I4 指出的缺陷，v2 一律标注）**：
> `[HEAD]` = 本地 `0c504e475`｜`[UP]` = `upstream/main d74a75fea`｜`[MT]` = merge-tree `3cd22c1a0` 合并树

## 工单状态总览

| 工单 | 内容 | 前置 | 状态 |
|------|------|------|------|
| S0 | 清障：脏树白名单核对 + worktree + **依赖引导** + 基线快照 | — | **阻塞，待裁定 3 条** |
| S1 | merge upstream/main（**统一 merge 模型**，43 块 / 18 文件 / 20 步） | S0 | 未开工 |
| S2 | 三个静默坑必修（**已并入 S1.2 第 6/9/10 步一次成型**） | 随 S1 | 未开工 |
| S3 | roster 族取舍落地（**v2 修正了 omitStreamingMessages 的误判**） | S1 | 未开工 |
| S4 | 测试面处置（**54 个本地独有测试**，含 3 个 node:test） | S1,S3 | 未开工 |
| S5 | schema **23/24/25/26 四层撞号** → 27 + 闸号 5 处 + 版本核实门 | S1-S4 | 未开工 |
| S6 | CHANGELOG 与碎片对账（**33 个碎片会被静默删**） | S5 | 未开工 |
| S7 | PR 增量：#2027 / #1947 / #1896（**deps 5 条本轮不进**） | S5 | 未开工 |
| S8 | 六道验收门（**v1 的第 4 道门跑错树，已修**） | 全部 | 未开工 |
| **S8.5** | **合回 `merge/repl-kernel`（v1 完全缺失此工单）** | S8 | 未开工 |
| S9 | 文档回写 | S8.5 | 未开工 |

**工期：61.5-87 小时**（去掉 S7 = 53.5-73h）。v1 写的 26-30h 不可信，理由见「工期」节。**待裁定 10 决定是否缩小本轮范围。**

## 0. 铁律（15 条）

前 6 条继承 R2 真实事故，7-12 是本轮新增，**13-15 是审查新加（15 来自老板合并纪律第 4 条）**。

1. **合并冲突禁止整文件取一边**，一律逐 hunk 解。R2 的 A8/#1249 被「取 theirs」吃掉两次。
   **【v2.2 修正悬空指针 = rev2-facts R3】** v2 曾说「43 块里只有 3 块能整块取一边，清单在附录第二部分第 6 步条目内」——**那个清单不存在**（附录第 6 步条目写的是 daemon-protocol.ts 的 5 个块描述，没有任何"可整块取一边"的清单）。v2 只是把 v1 的悬空指针从 `sync_d_conflicts.md §1` 换成了附录，**新指针同样悬空**，而这正是 v2 自己批评 v1 的 I8。
   **v2.2 口径：本轮不预设「可整块取一边」的块数。** 已明确许可整块取 theirs 的只有派单里点名的两处（第 2 步 `session-lease.ts:129-136`、第 3 步 `daemon-worker-client.ts`），理由都在 S3 表里。rev2-facts 复核的另两个候选（`agents-view-state.ts:724-728` / `:818-839`）**受 H8 约束不能无条件整取** → 所以「3 块」这个数本身不成立，**已删**。
   **每块解之前先问一句：整取这一边，块外有没有引用会断？**（S1.4b 的 7 个陷阱全是这么来的。）
2. **每个提交后跑回归**，两个口径先说清：
   - **「全量常驻回归套件」在本仓没有对应命令**，且与 `AGENTS.md` 的 "NEVER run npm test" 表面冲突 → **采老板 AGENTS.md 合并纪律第 5 条口径**：先 `--collect-only` 核 `collected == passed + failed + skipped`，对上才跑全量；SKIP 非 0 必须说明对照面为什么不在场；`EXIT=9` 或整数秒腰斩先疑看门狗。（裁定 8 根代理已按此自决，不再等老板。）
   - **【v2.1 衔接句】S1 期间铁律 2 降级为铁律 14 的机械门**（rev2-flow I4）：S1 是**一个 merge commit，20 步全程 0 个提交点**，「每个提交后跑回归」在 S1 内**不可执行**。S1 期间每步只跑机械门（`grep -c` 期望值 + `tsgo --noEmit`），**全量回归在 merge commit 落地后跑一次**。若 20 步每步都跑全量，385 个 `.test.ts` × 20 ≈ **6.6h+ 额外机器时间**，工期再爆。
   - **提交数账目修正**：v2 写「15-25 个」无依据。实际 = merge 1 + S4 1 + S5 1 + S6 1 + S7 三 PR 各 1-2 + 修复若干 ≈ **8-15 个**。
   - **【新】每步解完即 `git add <该文件>`**：merge 中 `git add` 是合法的进度固化（标记该文件已解）。不加则 `merge --abort` 或断电时**前 16 步成果一视同仁全丢**。
3. **测试环境必须清污（v2.4 改白名单式，build-stage-a 实测 5 变量黑名单远不够）**：跑测试前 `env | grep -E "^(PRIME_AGENT|RLM_)"` 必须为空（或 `env -i` + 只给 `PATH`/`HOME`/`TMPDIR`）。实测活会话 REPL 有 11 个 `PRIME_AGENT_*` + 5 个 `RLM_*`（含 `PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL` 指向自己会话的 orphans journal），5 变量黑名单漏掉它们造成 13 条假红（17 变量清污后 4 个文件整转绿 + python 1 条转绿）。**黑名单永远漏。**
   **双向污染警告（进 S9 + 已广播）**：在活会话里跑本仓测试，env 进来造假红、路径出去写真文件（`~/.prime/agent/logs/agent.jsonl`、orphans journal、session leases、supervisor socket）。跑完核 `~/.prime/agent/logs/agent.jsonl` 有无新增行。`bd35d1287` 修的正是这个方向之一。
   **kernel 面默认不 pin**（不 pin 时 `kernelReady` 直接命中、不改共享 venv，build-stage-a 与 rev3-facts 双向实测）；若必须 pin 则 pin 到 `$HOME/.prime/agent/kernel-venv/bin/python`（有全部默认包）。**禁 pin 到施工树 `prime-agent-runtime/.venv`**（只有 mcp/tyro/dill，缺默认包；`bootstrap.ts:857` 的默认包严格检查只在 override 分支 → pin 到它必红，本轮 1 条假红的成因）。整段 `test:kernel`（9 文件 --no-file-parallelism）会碰共享 venv mtime，单条/小批量不碰。k-mermaid@0.2.3`**。
6. **静默 catch 必须响亮**。本轮 P0-A 的病根就是 `.catch(()=>undefined)` 吞掉能力拒绝（`[MT] daemon-agent-connection.ts:492` 逐字命中，**另 `:1683` 还有一处同形状，v1 未提**）。
7. **绝对禁止整树覆盖**：`git checkout upstream/main -- .` / `git restore --source=upstream/main` 一类。本地独占文件（口径见 S3 注）含 7 个官方不存在的新模块（`stall-watchdog.ts` `share-session.ts` `private-files.ts` `windows-named-pipe.ts` `session-tool-pair.ts` `stall-diagnostics.ts` `extensions/timeout.ts`）+ 54 个新测试文件，三方合并时 **git 一句话都不会说**。
8. **`npm run check` 绿不等于合并成功**。3 个最危险的坑里 2 个（P0-A / P0-B）check 抓不到。**另注意 `npm run check` 带 `--write` 会改文件**（rev-exec I2）→ 只能在施工 worktree 跑，绝不在主仓跑。
9. **本地独有的 54 个测试文件不参与三方合并**（v1 写 49，**漏了 5 个，其中 3 个 tui 测试用 `node:test` 不是 vitest**，runner 命令见附录 §5.9），git 不会提示它们与新代码是否兼容。必须全跑。
10. **块外破坏 ≥21 处**，其中 8 处不改编译不过、5 处不改静默丢功能。核查必须**在当前工作树或 `git write-tree` 出的新树**上跑，**不是**在 `git archive <merge-tree-oid>` 的固定树上（v1 的门恒得 0/0/1，既抓不到新破坏也永远过不了 = K3 B-2）。**且那三个脚本原本不存在**（rev-exec Z7）：**第 3 条已由根代理实现并验证**（`/tmp/r3_check_tables.mjs`，实测复现基线破口 1 = H1），第 1、2 条仍需实现（估 ~3h，原估 2-4h）。详见 S8 门 4。
11. **schema 哈希不许手写**。必须所有 wire 改动落地后用附录 §5.2 的脚本重算（该脚本已实测复现三个基线值）。
12. **施工分支纪律**：所有提交落在 `sync/upstream-r3`（从 `merge/repl-kernel` 切），不直接在 `merge/repl-kernel` 上改。已合进 integration 的提交禁 amend / force-push，补内容一律新提交。多 lane 共仓提交用 `git commit --only -- <paths>`。
    **⚠ 老板合并纪律第 2 条后半句：`--only` 会把别人 staged 的删除覆盖回来。** 机制警告长期有效，但**本轮的具体事实已核实相反**（rev2-flow I1，根代理复验）：`git diff --cached --name-only` = **0 个文件**，别 lane 那 4 个改动**全部 unstaged**（`git status --short` 输出是 ` M`，第一列空格 = index 干净，第二列 M = 仅工作区改动）。v2 曾写「`models.generated.ts` 是 staged」，那是误读了第二列，**已删**。
    → 本轮 index 是干净的，`--only` 的覆盖风险当前不落地。但 S8.5 合回前仍必须 `git diff --cached --name-only` 复核一次（别 lane 随时可能 stage）。**要提交删除就得用普通 `git commit`（不带 `--only`），但那会扫进整个 index** → 两种都不能盲用。
13. **【新】摘取守门规则**（rev-exec I7 / lane B R2）：任何 cherry-pick 或取 theirs 之前，先跑 `git show --name-only <sha>` 与本地 54 个独有测试清单求交集。**若交集非空，说明这次操作会连测试一起覆盖掉，守门随之消失** —— 必须先把这些测试单独拎出来保住。铁律 1 管不到这种情况（cherry-pick 可以「干净地」覆盖）。
14. **【新】机械门优先**（rev-exec 建议 (e)，能砍掉 S1 一半以上验证开销）：每步的「什么算过」优先写成 `grep -c` 期望值 + 一次 `tsgo --noEmit`，而不是「相关测试跑通」（要起 runner、要等）。逐步的机械门见附录第二部分。

15. **【新】每块冲突必须落回执，含「翻回把手」**（老板合并纪律第 4 条：「每块冲突记『取了谁、为什么、翻回把手』，落审查报告」）。v2 原先只要求「写一句取舍理由」，不够。
    回执落 `/tmp/r3_conflict_receipts.md`，每块一条：
    ```
    [步N] <file> 块M  行区间 [MT]:a-b
      取了：ours / theirs / 手工融合（融合则贴最终代码要点）
      为什么：一句话 + 证据（sha / file:line / 测试名）
      翻回把手：要恢复另一边时改哪一行、跑哪条测试能验证（必须可执行）
    ```
    **翻回把手是硬要求**：43 块里任何一块事后发现问题，都要能在不重看原始 diff 的情况下翻回另一边。

## S0 · 清障（阻塞，需老板裁定 3 条）

### S0.1 脏树核对 —— **判据改为白名单式**（v1 的判据在开工那一刻就必然触发）
rev-exec M10 实测：审查/施工 lane 自己往 `docs/fork/` 落任务书与附录，`git status --porcelain` 就会多出 `??` 条目。v1 写的「若多出文件说明别的 lane 又动了，重新评估」是**自指失效**的判据。

**v2 判据（白名单式）**：只核这 5 条是否仍在，`??` 的 `docs/fork/*.md` 与 `*.png` 一律不计：
```
 M packages/ai/src/models.generated.ts          ← 注意：这条是 staged 状态（第一列 M）
 M packages/ai/src/providers/openai-completions.ts
 M packages/ai/src/types.ts
 M packages/coding-agent/src/core/model-registry.ts
?? packages/ai/test/openai-completions-preserve-thinking.test.ts
```
处置三选一（**待裁定 9**，推荐 (c)）：
- (a) 等那条 lane 收工提交后再开工（最稳）
- (b) 授权本轮用 `git commit --only -- <上述 5 路径>` 代它提交（**违反「只提交自己改的文件」铁律，需显式授权**）
- (c) **推荐**：在独立 worktree 从 `merge/repl-kernel` HEAD 切 `sync/upstream-r3` 施工，主仓脏树原地不动。代价：施工树里没有别 lane 的改动，**真正的撞点转移到 S8.5 合回时**（见该节）。

### S0.2 建 worktree + **依赖引导三步**（v1 完全缺失，rev-exec I1）
```bash
git worktree add /Users/a1/Desktop/_wt_prime/sync-r3 -b sync/upstream-r3 merge/repl-kernel
WT=/Users/a1/Desktop/_wt_prime/sync-r3
# ⚠️【v2.2 = rev2-facts R10】依赖引导已由根代理用 rsync 落好（独立真目录，不是 symlink）。**禁止重跑 ln -s**：
#   在已存在的目录上跑 ln -s 不会报错，会在里面建出 $WT/node_modules/node_modules，之后 npm install 的解析面更难查。
#   若走了附录 §5.10 的回滚路径 B（worktree remove + branch -D）需要重建，用下面的 rsync 版。
rsync -a /Users/a1/Desktop/ai/prime-agent/node_modules/                      "$WT/node_modules/"
rsync -a /Users/a1/Desktop/ai/prime-agent/packages/ai/node_modules/           "$WT/packages/ai/node_modules/"
rsync -a /Users/a1/Desktop/ai/prime-agent/packages/coding-agent/node_modules/ "$WT/packages/coding-agent/node_modules/"
```
**什么算过（四条全过，`[ -L ]` 检查已从 S5.4 前移到这里）**：
```bash
ls "$WT/node_modules/.bin/tsgo" && ls "$WT/node_modules/vitest/dist/cli.js"   # 两条都必须有输出
[ -L "$WT/node_modules" ] && echo '⚠️ 是 symlink：install 会反写主仓' || echo '✓ 真目录'
python3 -c "import os;p=os.path.realpath('$WT/node_modules/@earendil-works/pi-ai');assert p.startswith('$WT'),p;print('✓ pi-ai 指向施工树',p)"
ls -d /Users/a1/Desktop/ai/prime-agent/node_modules/grok-mermaid 2>/dev/null && echo '⚠️ 主仓被污染' || echo '✓ 主仓未污染'
```
根代理 2026-09-04 实测四条全过：真目录 408M + 2.8M + 6.2M；`realpath(pi-ai)` = `$WT/packages/ai`；主仓无 `grok-mermaid`。
**【S0.2 已实际完成，且方案已升级】根代理 2026-09-04 执行记录**：
- worktree 已建：`/Users/a1/Desktop/_wt_prime/sync-r3`，分支 `sync/upstream-r3` @ `0c504e475`，工作区 0 行改动
- 依赖引导：**原方案是三个 symlink 指向主仓**（照仓里既有 19 个 worktree 的做法），`tsgo` 与 `vitest/dist/cli.js` 自证通过
- **但 rev2-flow I9 抓到这样布局下 `npm install` 会经 symlink 反写主仓 `node_modules`** → 已改为**独立目录**（`rsync -a` 自主仓 398MB，保留 symlink 文本），详见 S5.4

**代价（I1）与其消解**：`node_modules/@earendil-works/pi-ai -> ../../packages/ai` 是**相对**链接。
- 在 symlink 布局下它指向**主仓** packages/ai → 施工树 `import "@earendil-works/pi-ai"` 拿到主仓 `dist`（含别 lane 未提交改动的构建产物）→ 官方改的 8 个 packages/ai 文件既不被 typecheck 也不被真跑。这是 v2 原裁定 (ii)「接受降级」的由来。
- **改独立目录后此降级自动消解**：`rsync -a` 保留 symlink 文本，相对链接在 `$WT` 内解析成 `$WT/packages/ai`（施工树自己）。
- → **v2 的裁定 10「(ii) 接受降级」作废**，改为「packages/ai 可正常 typecheck 与真跑」。**但施工代理必须亲手复核**：`python3 -c "import os;print(os.path.realpath('$WT/node_modules/@earendil-works/pi-ai'))"` 应输出 `$WT/packages/ai`。若仍指向主仓（说明 rsync 解引用了 symlink），**退回降级口径 (ii)**：packages/ai 只做只读 diff 复核，S8 的「已知未覆盖面」记一条

**什么算过**：`git -C $WT log --oneline -1` == `0c504e475`；`git -C $WT status --short` 除 S0.1 白名单外为空；上面两条 `ls` 都有输出。

### S0.4 【新】合并窗口冻结（老板 AGENTS.md 合并纪律第 1 条，v2 完全缺失）
纪律原文：「冻结：合并窗口期施工车道停提交；停不了先取 freeze-sha 清单，只合清单内提交。」
1. **开工前取 freeze-sha 清单**落 `/tmp/r3_freeze_shas.txt`：本地基线 `git rev-parse HEAD`（期望 `0c504e475`）、官方基线 `git rev-parse upstream/main`（期望 `d74a75fea`）、别 lane 的 5 个未提交路径（S0.1 白名单，**不在 freeze 清单内，本轮一律不合不碰**；**实测全部 unstaged，`git diff --cached` = 0**）。
   **【S0.4 已实际完成】** `/tmp/r3_freeze_shas.txt` 已生成：`local_base=0c504e4753b2b9c051f54ac334313bd3e5842033`、`upstream_base=d74a75fea3411136fdd2ba95c7f723ddefdadf05`、`merge_base=5b6c0e94e11a97fcfdd7a9fc9dc4f7acbda9c853`、`taken_at=2026-09-04T04:37:37Z`，5 个 excluded 路径已列。
2. **施工窗口期主仓 `merge/repl-kernel` 禁止任何新提交**，所有提交落 `sync/upstream-r3`。
3. 若别 lane 在施工期间往主仓提交 → **不追**，本轮只合 freeze 清单内的 sha；它的改动留给 S8.5 合回时处理，并记进冲突回执。
4. **什么算过**：`/tmp/r3_freeze_shas.txt` 存在且含两个基线 sha；主仓 `git rev-parse HEAD` 在整个施工期间保持 `0c504e475`（每阶段验收复核一次）。

### S0.3 基线快照与对账命令（v1 缺命令，附录 §5.2 已给）
```bash
git -C $WT rev-parse HEAD > /tmp/r3_base_sha.txt                       # 期望 0c504e475...
git merge-tree --write-tree HEAD upstream/main > /tmp/r3_mt.txt || true  # exit=1 是正常的（有冲突）
head -1 /tmp/r3_mt.txt                                                 # 期望 3cd22c1a012e811acefd8dbb29d403bdfc3177a8
awk 'NR>1 && $3 ~ /^[123]$/ {print $4}' /tmp/r3_mt.txt | sort -u | tee /tmp/r3_conflicts.txt | wc -l   # 期望 18
```
这棵树 `3cd22c1a0` 是**解冲突之前**的自动合并树，只作对账基准，**不作为核查脚本的运行树**（铁律 10）。

## S1 · merge upstream/main（主体）

### S1.1 执行模型：**统一走 merge**（v1 同时写了 merge 和 cherry-pick 四批，两套互斥 = 三审一致指出的最大自相矛盾）
- K3 B-1 / rev-facts BL3 / rev-exec Z3 三重确认：v1 的 S1.1c「四批推进」全是 cherry-pick 语义（依据单提交 `merge-tree --merge-base=<sha>^ HEAD <sha>` EXIT=0、「整提交直拿」、「批内顺序」），整树 merge 里这些动作**不存在**。混用则 43 块 / 18 文件 / 20 步的对账基准全废（lane D 的全部实测都是 HEAD × upstream/main **直接**合并的产物）。
- v1 的批次数字也不自洽：批 0「12 条 CLEAN」实为 **11 CLEAN + 1 REBASE**；批 3「8+11=19」重复计算（#1920/#1918/#1954 已在批 1、#1893/#1944 已在批 0）；**#1885/#1984 不在任何批的枚举里也不在 SKIP 6 里**；**#1929 #1946 #1951 #1960 #1899 #1965 #1966 七个提交在 v1 全文 0 次出现**。
- **v2 裁定**：走 merge。lane A 的分级（CLEAN 11 / REBASE 13 / CONFLICT 10 / SKIP 6）**保留为「解冲突时的取舍倾向参考」**，不作为推进批次。40 提交 → merge 模型的动作映射见附录 §5.8。

走 merge 的理由（lane D 实测，非推测）：
- 官方 #1926（direct session transport，3000 行级，schema 25）站在 #1897/#1900/#1909 之上；本地无 `agent-roster.ts` / `roster-store.ts`，**不能单独 cherry-pick**。
- 合并树里官方 **41 个 `this.roster()` 读点已全部自动合并进来**，本地 `worker.summaries` 从 18 处被削到 7 处（**v2.2 修正 = p3 实测：`[MT]` 7 命中里块内只有 2 处（`:2761/:2767`，块3 ours 侧）、块外 5 处；v2 原写「5 处在冲突块 ours 侧」正好反了**。解完剩 5 处全块外）。保住本地旧架构 = 手工重写官方 6 个 PR 约 2500 行。
- merge 让分叉点前进到 upstream/main，**下一轮同步不会再撞这 40 个提交**。

### S1.2 解冲突顺序（20 步，依赖根先定型）
```
 1 prime-agent-runtime/src/rlm/repl.py            ← 两侧都不能整取，见 S1.4 陷阱 0
 2 src/core/session-lease.ts
 3 src/modes/daemon/daemon-worker-client.ts
 4 src/modes/agent-connection/types.ts            ← 已核无需额外动作（core/usage.ts 是官方纯 add，会自动进来）
 5 test/daemon-mode.test.ts
 6 src/modes/daemon/daemon-protocol.ts            ← 依赖根。**S2.1 + S2.3 在此一次成型**（见下）
 7 src/main.ts
 8 src/cli/daemon-launch.ts
 9 src/core/session-manager.ts                    ← **S2.2 在此一次成型**
10 src/core/agent-session.ts                      ← 449KB，见 S1.4 陷阱 1 与 4
11 test/agent-session-recursion.test.ts
12 src/modes/agent-connection/daemon-agent-connection.ts
13 src/modes/agents-view/agents-view-state.ts     ← 见 S1.4 陷阱 3
14 src/modes/agents-view/agents-view-mode.ts
15 src/modes/daemon/daemon-mode.ts                ← 含 #1229 存活确认
16 src/modes/daemon/rlm-ledger.ts                 ← 唯一路径见 S7.6
17 src/modes/daemon/daemon-supervisor.ts          ← 最难（7 块），放最后。**估时最可能超：8-12h 而非 lane D 的 5h**
18 test/daemon-protocol.test.ts
19 孤儿测试处置（S4）
20 31 个自动合并文件复核（S1.5，深复核 5 个）
```
每步**什么算过**：⓪ **符号层核对（p4 NC4 + p7 实测的门盲区，v2.2 补）**：单文件门（esbuild/biome）**只证明结构没碎，抓不了符号错**——本轮 4 个真实陷阱（`listClient`/`client` 未定义、`liveCatalog*` 声明被自动合并删光、`const sessions` 重复声明 TS2451）esbuild 负控全 EXIT=0，biome 的 `noUnusedImports` 对未使用 import 与零调用者函数也不报。所以每步必须额外做：把块外每个使用点 grep 回块内找声明（声明在前、同作用域）+ 跨文件被调函数的**参数个数**核一遍 + 同函数体内同名 `const`/`let` 查重。符号正确性最终靠收口时全仓 tsgo。
① 无冲突标记（`grep -c -E "^<<<<<<<|^=======|^>>>>>>>" <f>` == 0
   **为什么统一用 ERE（build-stage-a 精确归因，v2.2 修正我上一版过头的措辞）**：BSD grep（2.6.0-FreeBSD）里 BRE 的 `$` **只有写在 `\|` 分支中间才会退化成字面量**（实测变体 `'^<<<<<<<\|^=======$\|^>>>>>>>'` 在 2 块文件上数出 4 而非 6，丢 2 行 `=======` → 留下 `=======` 的文件被判 0 = 假绿，p2 撞的就是这个语序）。而 S1.2 原文 `'^<<<<<<<\|^>>>>>>>\|^=======$'`（`$` 在 pattern 末尾）**在 BSD grep 上行为正确**（同文件数出 6），build-stage-a 第 1-5 步的 5 次门实测用它跑的、结论有效，**不要当作废**。
   统一改 ERE 的理由是**对语序不敏感**：`^=======` 不带 `$`，写在哪个分支都不会退化，且顺带能抓 `=========` 这种超长残留。**注意 ERE 里不要再写 `\|`**（那是 BRE 转义，混写两种语义都不对）。
   **【v2.2 补三条工具坑 = p6 ⑤-6 / p8 ⑤-2 / p3，都会造假结论】**：
   - **负控命令必须先把退码存进变量**（`rc=$?` 再打印）。p6 第一版写 `esbuild …; echo "$(basename $f) EXIT=$?"` —— `$(basename)` 在展开 `$?` **之前**执行，把退码覆盖成 0，导致 5 个负控全部假报 EXIT=0、得出与事实相反的结论。与「bash() 是 /bin/sh、静默空 stdout 被 or 兜底读成假结论」同族。
   - **biome 不能当 /tmp 副本的负控**：`biome check /tmp/x.ts` 输出 `Checked 0 files` + `These paths were provided but ignored` + exit=1，**但不是语法错**，会被读成假结论。biome 负控必须放仓内路径（p3 的做法：/tmp 复刻一棵 biome.json + 最小配置树；p8 直接放弃 /tmp 负控）。
   - **esbuild 的牙口精确化（p6 ⑤-5）**：esbuild 对「同作用域重复声明」**有牙**（EXIT=1 `The symbol "summary" has already been declared`），对「未定义引用」**零牙**。所以「esbuild 绿」的含意 = 排除同层重复声明 + 结构没碎；未定义/重复声明/实参个数仍靠 grep 配对 + 收口 tsgo。
   **正控两句（固化，build-stage-a 建议）**：① 解完前对同一文件跑一次，必须 >0；② 对人造的孤立 `=======` 文件跑一次，必须 =1（`/tmp/r3_posctrl.txt` 已放好可复用）。只做 ① 抓不到「命令本身数不全」这类问题。）② 该步的机械门（附录第二部分逐步给了 `grep -c` 期望值）③ `tsgo --noEmit` 不新增错误 ④ 三个核查脚本在**工作树**上跑，破口数 ≤ 已知红清单。

### S1.3 【B-3 根治】把 S2.1 / S2.3 并进第 6 步，S2.2 并进第 9 步，一次成型
K3 发现的依赖倒置：S2.1（P0-A）、S2.3（H1）、S1.2 第 6 步、S5 块 1 **四处改动全落在 `daemon-protocol.ts` 同一个文件**，v1 拆到四个阶段碰四次，中间态处处卡自己的门 → 第 6 步永远过不了自己的验收门（H1 破口排到 S2.3 才修），且会**诱导施工代理手写哈希提前消红，正好违反铁律 11**。

**v2 处置**：
- 第 6 步解 `daemon-protocol.ts` 时，**同时落地 S2.1（能力集）+ S2.3（PLANE 补键）**，该文件一次成型。
- 第 9 步解 `session-manager.ts` 时，**同时落地 S2.2（3 个 usage 累加器进 SessionScanState）**。
- S5 只留 **digest 重算 + revision 27 + 注释回写 + 闸号 5 处核对**，不再改 wire 形状。
- 第 6 步冲突块 1 里的 `DAEMON_SCHEMA_REVISION` / `DAEMON_SCHEMA_ID` 临时取值：**取 ours 的 26**（`[MT] :89/:90` 与 `:96/:97` 两份都取 ours），S5 最后统一改 27 并重算 digest（rev-exec I13 给的走法）。

### S1.4 五个陷阱（v1 只列 3 个，rev-exec 补 2 个）
**陷阱 0（新，Z5）· `repl.py` 两侧都不能整块取**：
- 取 ours → `serialized_payload` 的定义已被自动合并删掉 → **运行时 NameError**（编译期查不出，Python 无类型门）
- 取 theirs → 快照本体丢 `fsync` + `fchmod 0600`，而 manifest 侧还留着 → **不对称降级**（安全属性只保住一半）
- **且这一步没有可执行的验收门**：仓里没有 `.venv`，Python 环境不存在 → 只能用附录 §5.6 的融合代码 + 人工逐行核对。

**陷阱 1 · `agent-session.ts`**：若块 1 取 ours 会得到**两次 `appendCompaction`** —— 官方那份在 `[MT] :8082`（非冲突区，末参 `usage`）已存活，ours 侧在 `:8113`（末参 `compactionLeafId`）。解完必须核对调用点数量与末参语义。

**陷阱 2 · `rlm-ledger.ts`**：取 ours 取 theirs **都编译不过**。ours 缺 `readAllSync`/`statSync` 等**正好 5 个**符号；theirs 让 `[MT] :897` 的 `size`/`stats` 变未定义。唯一路径见 S7.6。

**陷阱 3 · `agents-view-state.ts`【v2.2 定性修正 = p7 实测，v2 原定性错】**：`propagateHeartbeatStateToAncestors` **不是本地独有函数**，merge base 里就有（`d51590c41` #1372 引入，`[BASE]:731` 定义 / `:688` 调用），是官方 **`d72beaf9e`(#1967) 连定义带调用点有意删除**的（commit message 原文点名："…the roster classifier, the unified agents-view classifier, **the ancestor-propagation overwrite**, and the subagent count projections all drop the heartbeat clause"）。本地只在函数体内改过一行（拼 `getQuietDurationLabel`）。
→ **处置是跟着删，不是恢复调用点**。v2 原写「必须决定恢复调用点还是删函数」把它当合并事故，错。
**决定性依据（测试面已先于源码定型）**：`test/agents-view-state.test.ts` 不在 unmerged 列表（已自动合并）；本地钉传播的 3 个测试（HEAD 版 `:112/:410/:452`）在合并树 grep 命中 **0**；官方反传播的 3 个已在树里（`:113` "armed heartbeats stay Idle between firings"、`:434` "counts a busy grandchild on every idle ancestor **without promoting them**"、`:479` "keeps heartbeat-armed descendants out of the busy tally"）。**恢复传播会立刻红 `:479` 与 `:434`。**
**p7 已落地**：块1 手工融合（theirs 新第二参 `heartbeat?: UnifiedSessionHeartbeat` + 保 ours 的 `getQuietDurationLabel` 尾巴）；块2 整块删除该函数、不恢复调用点。
**【v2.2 校订 = p4 实测】这一步不存在「取 ours 就自动保住功能」的选项**：调用点 `[HEAD]:688` 在**块外**已被官方覆盖删掉，整取 ours 只会得到「有定义、无调用点」的孤儿函数。要保功能必须手工把调用点接回官方新形状的 `buildAgentsViewRows`。
**【v2.2 裁定 = 根代理】不恢复 propagate，记 S9 行为变更 + 下轮可选待办**：
- 恢复整函数会红官方反传播测试（`test/agents-view-state.test.ts:434/:479`），且官方 #1967 明确认为祖先冒泡是 overwrite bug（commit message 点名）→ 不恢复
- 但本地在 propagate 体内加过一行增强（`[HEAD]:744` 的 `getQuietDurationLabel(ancestor.summary)`），随函数删除丢失 → **用户可见差异：祖先行不再显示 "(no activity Xm)"**（base row 的那半保住了：`:724` 调用点活着、有测试钉 `:138/:138/:141`）
- 若要在官方新形状上重新实现祖先行 quiet label，是**新增功能不是 merge 取舍** → 单独开下轮工单，不在本轮 sync 里块2 若原样保留 ours 会直接类型错（boolean 第二参已被换）+ 与 theirs 新的迭代式 busy-descendant tally（`:753-771`）争 `runningSubagentCount` 计数权 → 双重计数。本地损失已由块1 补偿（本地存活测试钉 base row，不依赖传播路径）。

**陷阱 4（新，Z6）· `appendCompaction` 签名块是第 4 个「取任一边都编译不过」的块**：`[MT] session-manager.ts:1760-1764`，函数体在块外**同时引用 `leafId` 与 `usage`**。融合代码见附录 §5.7（与陷阱 1 两半一起解）。

### S1.4b 【v2.2 新增】「取任一边都不行」的块实测是 **7 个**，不是 v2 写的 4 个（rev2-facts R2）
v2 的 S1.4 列了 4 个陷阱（repl.py / agent-session.ts / rlm-ledger.ts / agents-view-state.ts + appendCompaction）。rev2-facts 按「整取 ours / 整取 theirs 各自会不会编译不过或静默丢功能」扫了 18 文件全部 43 块，**新找到 3 个**，都在最难的第 14、17 步：

**陷阱 5 · `[MT] daemon-supervisor.ts:3-16`（第 17 步块 1，import 块）—— 两侧都不能整取**
- ours（`:4`）：`import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";`
- theirs（`:6-15`）：多行版，**有 `existsSync`、没有 `statSync`**
- 块外实际用法：`statSync` 在 `[MT] :6341`（`modifiedAtMs = statSync(manifestPath).mtimeMs;`）；`existsSync` 在 `[MT] :990` 与 `:6927`
→ 整取 ours 丢 `existsSync`（2 处未定义）、整取 theirs 丢 `statSync`（1 处未定义），**都编译不过**。**必须取并集（8+1 个符号）**。
⚠ 这是「看起来最机械」的 import 块，最容易顺手整取一边。

**陷阱 6 · `[MT] agents-view-mode.ts:862-875`（第 14 步块 1）—— 取 ours 编译不过，取 theirs 静默丢安全闸**
- ours（`:863-868`）：`new DaemonClient(..., { declaredCapabilities: DAEMON_FIRST_PARTY_SESSION_CAPABILITIES })` + `connect()` + `subscribeToClientClose(this.client)` + `this.client.onMessage(...)`，**没有声明 `client` 这个局部名**
- theirs（`:870-874`）：`this.persistentState.rosterClient ??= new DaemonClient(this.requireSocketPath());` + `const client = ...` + `reconnect()`，**没有 `declaredCapabilities`**
- 块外 `[MT] :880` `if (!(await this.rosterStore.attach(client))) {`、`:883` `this.subscribeToClientClose(client);` 都用 `client`
→ 整取 ours：`client` 未定义 = **编译不过**。
→ 整取 theirs：agents view 的连接**不再声明 capability** → 服务端 `missingDeclaredCommandCapability`（`[MT] daemon-protocol.ts:1120`）的 `if (declaredCapabilities !== true) return undefined;` **fail-open** → 本地 `96d3db580`（schema rev 26 本地那半边）的整个 capability 闸**对 agents view 静默失效**，且 S2.1 的修法在这个客户端上无从验证。
→ **正确形状（可直接抄）**：theirs 的 4 行 + 把 ours 的 `{ declaredCapabilities: DAEMON_FIRST_PARTY_SESSION_CAPABILITIES }` 加进那个 `new DaemonClient(...)`；ours 的 `subscribeToClientClose(this.client)` **不要保留**（块外 `:883` 已有同一调用）。

**陷阱 7 · `[MT] agents-view-mode.ts:1902-1906`（第 14 步块 2）—— 取 theirs 编译不过**
- ours（`:1903`）：`const listClient = this.requireClient();`；theirs（`:1905`）：只有一行注释
- 块外 `[MT] :1908`：`requireDaemonData(await listClient.request(createAgentsViewListCommand(listClient))),`
→ 整取 theirs：`listClient` 未定义 = 编译不过。**必须 ours + 保留 theirs 的注释**。

**为什么这条要紧**：第 17 步（7 块、8-12h）和第 14 步（4 块）是全轮最难的两步，而附录步骤 17 自己写着「缺 7 个块的位置与内容」——施工代理在这两步**没有任何块级喂饭料**。v2 又给了「只有 4 个块两边都不能整取 / 只有 3 块能整块取一边」的心理预期，容易在 import 块这种地方直接整取一边。

**【v2.2 补 = p4 实测】第 14 步实际是 4 块里 3 块不能整取任一边**（v2 只列了块1/块2）。**【v2.2 再补 = p3 ⑤-5：全轮「整取任一边都不行」的块是 8 个不是 7 个】** 第 8 个 = `daemon-supervisor.ts` 块3：`summaryWithoutStreamingMessage` 的 import 在块外 `[WT]:122`、本文件唯一使用点是块3 ours 侧 `[MT]:2763` → 整取 theirs 让它变零使用者、biome `noUnusedImports` 直接红（p3 负控 NC-B2 实测 EXIT=1 精确到 `:122`）：
- **块3（`[MT]:2156-2206`）取 ours 三处编译不过**：① `liveCatalogReady/liveCatalogGeneration/liveCatalogPollPromise/liveCatalogRefreshPending` 声明在 ours `:661-667`，已被自动合并删光（工作树 0 命中）② 工作树 `:2174` 与 `agents-view-state.ts:314` 都已是 `shouldApplyScopeResolution` 的 **2 参**形，ours 的 3 参调用面无处安放 ③ `refreshSavedSessionsIfLoaded` 调用点在块外 `:1679/:2107`
- **块4（`[MT]:2494-2502`）取 ours 是重复声明不是未定义**：块外 `:2446` 已有 `const sessions = this.rosterStore.summaries();`，ours 侧又 `const sessions = expectSessionList(data);` → TS2451
- p4 最终解法：块1/块2 手工融合（陷阱 6/7 正确形状）、块3/块4 整取 theirs，**已解完并 add**

**【v2.2 补 = p4 ⑤-3 + 第二轮，进 S9 行为变更清单】① 块3 取 theirs 丢了两条本地状态消息 + 一个重连触发点，全仓 0 测试钉住**：`formatError("Failed to refresh agents")`、`formatError("Failed to refresh current session")`（现已 0 命中）、refreshSessions catch 里的 `startClientReconnect`。theirs 的 refreshSessions 是纯本地读 rosterStore、结构上不会失败 → 官方设计的必然结果，不是漏解。**用户可见差异：daemon 挂掉时 agents view 的报错改由 heartbeat 轮询 / socket close 给出。** ② **祖先行不再显示 "(no activity Xm)"**（本地 propagate 体内的增强随官方 #1967 删除而丢失；base row 那半保住）。下轮可选待办：在官方新形状 `buildAgentsViewRows` 上重新实现祖先行 quiet label。

**【v2.2 补 = p4 ⑤-4，进 S8 已知未覆盖面】块1 新形状零单测覆盖**：`test/agents-view-mode.test.ts:39-46` 的 DaemonClient mock 只有 `connect/close/request`，缺 `isConnected/reconnect/onMessage/onClose`，且该测试用 `invoke()` 直接调私有方法、**从不驱动 `run()`** → 「roster client 声明 capability」这条接线跑不出红也跑不出绿（正是陷阱 6 theirs 方向「静默」的根因）。唯一可执行门 `grep -c declaredCapabilities ≥ 2`。**待办：给 mock 补 4 个成员 + 一条 run() 级断言**（本轮不修，记 S4/S9）。
- **【v2.2 补 = p2 ⑤，S1.5 步20 判据加一条】**：31 个自动合并文件的深复核，把「**末参新增 ↔ 调用点实参直方图配对**」加进判据。p2 实测 `branchWithSummary` 的第 5 参 `usage?: Usage` 是官方 #2003 新增的**末参嫁接**且在**块外自动合并区**（git 没提示）；只核「符号在不在」会漏掉这一类。p2 的扫描脚本 `/tmp/p2_arghist.py`（1029 个 .ts，括号平衡解析，正确处理嵌套与三种引号/转义）可复用。p2 的配对表结论：`appendCompaction` {3:7,5:2,6:1,7:2} 越界 0、**全仓 0 个站点在槽位 7 传裸 usage**；`branchWithSummary` {2:2,5:1} 越界 0；`scanSessionInfo` {3:1} 12 字段三方对齐。
- **【v2.2 补 = p2 ④，S8.6 双审要点：两条「不知道就写出假哨兵」的事实】**：① 初次 `attach()` **永远不会写降级日志**（`attachRosterStore` 第一行 `if (!store) return;`，而 `rosterStore` 唯一写入点是 `subscribeAgentRoster()` 里的 `??=`）→ 哨兵必须先绑 store 再触发走实例 `attach()` 的重连；任何在初次 attach 上断言「日志不存在」的测试都会**假绿**。② 普通 `FakeDaemonClient` + 普通 `Error` + 不传 `options.recoverDaemon` → **根本不进重连循环**（`handleTransportClose` 走最后分支直接 terminalClose）→ 哨兵必须照仓里既有模板 `:2853-2882` 传 `{ recoverDaemon, reconnectTimeoutMs }`。p2 已加**反向配对 it**（不删能力 → 断言日志不含 roster-attach:），两条合起来才钉死「只在降级时写、降级时一定写」。
- **【v2.2 补 = p2 ⑤，字段层盲区与 p5 三参外壳同族】**：`scanSessionInfo` 链上**少写一个 `resume?.X` 恢复而保留接口字段，esbuild/biome/tsgo 三者全绿**（接口字段仍被 `scan:{}` 填满、类型完备），只有 P0-B 哨兵能抓。→ 收口时 tsgo 绿 ≠ 字段层对，哨兵是唯一门。
**【v2.2 补 = p4 ⑤-5，不变量】**：`declaredCapabilities` 只在首次创建 rosterClient 时施加（`??=`）；将来若新增第二个不带选项的创建点，声明会静默缺失且无测试会红。当前只有 `:862` 一个创建点 → 成立。

### S1.5 **31 个**自动合并文件的复核（v2.2 定案 = rev2-facts R7，v1 的 35 与 v2 的 30+6−1 都复现不出）
lane D 三层机器核查：悬空 import 0 / 重复顶层声明 0 / 总量映射表破口 **1**（= S2.3 的 H1）。（注：lane D 说的「全仓 1017 个 .ts」也不准，实测 `[HEAD]` 1010 / `[MT]` 1034。）
**实测账目（可一条命令复现）**：本地改动面 **313**、官方改动面 **192**、**两侧都改 = 49** ✅（S3 注的「264 = 313 − 49」逐字对得上）。49 = **18 个冲突文件 + 31 个自动合并文件**。这 31 个的 `[MT]` blob **既不等于 HEAD 也不等于 UP**（逐个 `git rev-parse` 核过：`mt==head` 0 个、`mt==up` 0 个）→ 都是真三方融合。31 个里 `.ts` 29 个，另 2 个是 `install.sh` 与 `packages/coding-agent/package.json`。
```bash
comm -12 <(git diff --name-only 5b6c0e94e HEAD | sort) <(git diff --name-only 5b6c0e94e upstream/main | sort) \
  | comm -23 - <(sort /tmp/r3_conflicts.txt)      # 期望 31 行
```
**需深复核的是 5 个**（不是 6 个）：`compaction.ts`、`interactive-mode.ts`、`agent-session-runtime.ts`、`test/agent-connection-daemon.test.ts`、`daemon-socket.ts`。附录点名的第 6 个 `markdown.ts` **不在这 31 个里**（它是官方单侧改动，`local_changed=0`），另列。
**主文档与附录曾互相矛盾（35 vs 6），v2.2 统一为 31 / 深复核 5。**
**`interactive-mode.ts`（359KB，双方各 24-30 hunk，函数级映射失效）未做同深度诊断**，本轮按自动合并结果走，但 S8 必须单独跑它的测试族，并记入「已知未覆盖面」。

## S2 · 三个静默坑（修法已并入 S1.2 第 6/9 步；确切 patch 见附录 §5.3-5.5）

### S2.1 P0-A：本地 capability 闸会挡掉官方两个新特性
**事实（根代理 + rev-facts + rev-exec 三方独立验证）**：
- 官方 `[UP] daemon-supervisor.ts:182-186`：`SUPERVISOR_SERVER_CAPABILITIES = [...DAEMON_DEFAULT_SERVER_CAPABILITIES, "agent_roster", "direct_peer_transport"]` → 这两个能力**只在 SUPERVISOR 集，不在 DEFAULT 集**
- 本地 `[HEAD] daemon-protocol.ts:222-223`：`DAEMON_FIRST_PARTY_SESSION_CAPABILITIES = DAEMON_DEFAULT_SERVER_CAPABILITIES.filter(c => c !== "control_plane")` → 从 **DEFAULT** 派生，因此不含这两个
- 官方新命令门槛：`[UP] daemon-protocol.ts:803-804` `roster_subscribe/roster_unsubscribe: { minProtocol: 7, capability: "agent_roster" }`；`:743` `capability: "direct_peer_transport"`

**后果链（v2 修正了 v1 的因果与行号基准，rev-facts IM2）**：
1. `get_direct_worker_transport` 被本地 `missingDeclaredCommandCapability` 拒 → `[UP] daemon-routed-client.ts:229` `if (!response.success) return supervisor;` → **静默回落，#1926 整个特性等于没合**
2. `roster_subscribe` 被拒 → `[UP] roster-store.ts:55-60` 抛错 → `[MT] daemon-agent-connection.ts:492` `.catch(()=>undefined)` 吞掉（**另 `[MT] :1683` 还有一处同形状**）→ **#1900 的 subagents bar 永久降级**
3. **v1 写的因果不对**：`[UP] agents-view-mode.ts:2429`（合并树是 `:2500`；`[MT] :2429` 是 `finish()` 里的 `clearCtrlCExitHint`）那句 throw 只在 `attach()` **返回 false** 时触发。而 P0-A 之下 supervisor 广播的是 `SUPERVISOR_SERVER_CAPABILITIES`（`[MT] daemon-supervisor.ts:190-193` + `:1514`，**含** `agent_roster`）→ **真正抛的是 `[UP] roster-store.ts:57` 的 `roster_subscribe failed:`**，被 `[UP] :2440` catch 后循环到 deadline，agents view 表现为打不开/卡住。

**修法（v2 大改，v1 的修法被三审一致否决）**：
- ❌ v1 写法「加进 `DAEMON_DEFAULT_SERVER_CAPABILITIES`」→ **撞官方一条钉死的反向断言**：`[MT] test/daemon-protocol.test.ts:458` `expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).not.toContain("direct_peer_transport");`，官方注释原文 *"Only the supervisor issues tickets; workers and standalone daemons must not advertise it."* 而 DEFAULT 正是 **worker 自己广告的集**（`[HEAD] daemon-mode.ts:3183` / `[UP] :3246`）→ 照做等于让每个 worker 谎报能签直连 ticket。
- ❌ K3/rev-facts 的「只改 FIRST_PARTY 集」**也不生效**：`[HEAD] daemon-protocol.ts:204` `DAEMON_KNOWN_DECLARED_CAPABILITY_SET = new Set(DAEMON_DEFAULT_SERVER_CAPABILITIES)`，而 `normalizeDeclaredCapabilities()` 会把已知集之外的能力**静默剥掉** → 症状与没修一样。v1 全文 0 次提到这个集合。
- ✅ **v2 采 rev-exec §5.3 的确切改法**：新增 `DAEMON_SUPERVISOR_ONLY_SERVER_CAPABILITIES` 常量，**三处联动**（KNOWN set 并集 + 两个 FIRST_PARTY 集并集），**不动 DEFAULT**。可选把 `[UP] daemon-supervisor.ts:182-186` 改成引用同一常量防漂移（**注意该行在块外，且这个文件是第 17 步最难的，别在解块时顺手改**）。
- ✅ **永久门断言**（代码在附录 §5.3）：钉死「每条命令所需 capability 都能被对应的 first-party 集声明」+「`normalizeDeclaredCapabilities` 不剥掉 first-party 集里的任何能力」。放在官方那条 `not.toContain` 旁边，两条互相咬住。

**什么算过（v2.1 拆成两级，rev2-flow I5：v2 的「先红后绿」在原时序里不可达）**：
- **步级门（第 6 步解完当场验）**：① 块 3（`[MT] :220-266`）的形状符合附录 §5.3（有 `DAEMON_SUPERVISOR_ONLY_SERVER_CAPABILITIES`、KNOWN set 是并集、两个 FIRST_PARTY 集都并了它）② **`DAEMON_DEFAULT_SERVER_CAPABILITIES` 逐字未变**（`git diff` 该常量区块为空）③ 机械门：`grep -c DAEMON_SUPERVISOR_ONLY_SERVER_CAPABILITIES` ≥ 4（定义 1 + KNOWN 1 + 两个 FIRST_PARTY 各 1）④ PLANE 表已补 `declare_client_capabilities`，**核查脚本 3 破口归 0**（`node /tmp/r3_check_tables.mjs <工作树>`）。
  **注意**：第 6 步**不能**要求 `npm run check` 绿（其余 17 文件未解 + `grok-mermaid` 未装）。
- **工单级门（S8 时验）**：① 新永久门断言绿 ② **官方那条 `[MT] test/daemon-protocol.test.ts:458` `not.toContain("direct_peer_transport")` 仍然绿**（必须显式验，否则 Z1 重演）③ `npm run check` 全绿 ④ 手工验证见 S8 门 5。
- **「先红后绿」的正确操作顺序**（v2 原时序不可达，因为断言落在 `test/daemon-protocol.test.ts` = 第 18 步才解，而实现第 6 步就落了 → 第 18 步断言直接绿）：
  **第 6 步先只落「纯并集」版的块 3**（KNOWN set 与两个 FIRST_PARTY 集并上两个能力，但**不新增** `DAEMON_SUPERVISOR_ONLY_SERVER_CAPABILITIES` 常量）→ **第 18 步加永久门断言，此时应跑红**（因为 DEFAULT 集仍不含、断言的 `normalizeDeclaredCapabilities` 那条会挂）→ **再回到实现落附录 §5.3 的三处联动转绿**。
  若嫌来回麻烦，替代口径：**接受「断言一次绿」**，但必须在回执里写明「红窗未制造，断言有效性靠 §5.3 的构造性论证 + 官方 :458 反向断言互咬保证」，并由 S8.6 双审复核这一条。

### S2.2 P0-B：官方 3 个 usage 累加器不在本地 SessionScanState
**事实（根代理亲手验证因果链，rev-facts 二次确认「没有任何机制会兜住」）**：
- 官方 #2003（`d74a75fea`）给 `scanSessionInfo` 新增 3 个**函数局部 const**（`[UP] :967-969`）：`assistantUsageById = new Map<string, Usage>()`、`attributedChildUsages: Usage[] = []`、`summarizationUsages: Usage[] = []`
- 官方 `scanSessionInfo` **无 resume 参数**（`[UP] :956`）—— 官方根本没有增量扫描
- 本地 `[HEAD] session-manager.ts:1046-1057` 的 `SessionScanState` **正好 9 个字段**，这 3 个一个都没有
- 本地增量扫描 `[HEAD] :1107-1123`：每个累加器靠 `resume?.X ?? 默认值` 恢复，随后 `readFileLines(filePath, offset)` **只读 offset 之后的新增字节**
- **rev-facts 确认无兜底**：唯一的缓存失效路径是 `listSessions` 删掉已消失文件的条目（`[HEAD] :1340-1343`），不会触发全量重扫

**后果（v2.2 按 rev2-facts R1 改准 —— 原写法会让施工代理按错误场景复现，复现不出来就以为不用修）**：
首次全量扫描正确；之后每次增量扫描这 3 个从空开始 → 历史 usage 全丢。
**但活动会话不受影响**：官方 list 摘要有两条互斥 usage 来源 —— 活动会话走 `[UP] daemon-session-list.ts:263` `usage: session.getOwnUsageSummary?.()`（**内存实时、整文件、正确**；实现 `[MT] agent-session.ts:12582-12593`，完全不碰 `readSessionInfo`）；只有 inactive/saved 行才走 `[UP] :352` `usage: session.usage`（= 增量扫描产物）。消费侧 `[UP] agents-view-state.ts:252` `usage: record.daemon.usage ?? saved.usage`（活的优先）。
→ **真实症状 = 「会话 passivate 那一刻，agents view 里该行 cost 往下跳」+「已停会话的行长期少算」**，而这正是官方注释明说不许发生的事（`[MT] agent-session.ts:12581` 原文：*"Whole-file own spend, identical to the catalog scan so rows never shift at passivation."*）。
不抛错、不掉官方测试（官方无增量扫描路径）。**只有本地会中招，因为只有本地有增量扫描**（`619144b6e`）。

**修法**：附录 §5.4 给了 5 处确切改动（全在 `session-manager.ts`）。要点：
1. import 块（`[MT] :36-48`，冲突块 1）取并集
2. `SessionScanState`（`[MT] :1060-1071`，**块外，git 不会提示**）加 3 个字段，并把接口上方那段「Every field either only ever grows / keeps the newest value / is fixed by the first line」的注释覆盖到新字段
3. **`assistantUsageById` 是 Map，恢复时必须 `new Map(...)` 克隆**，否则多个缓存条目共享引用互相污染；两个数组同理需 slice 拷贝（grow-only 语义下共享引用会被后续 push 污染）
4. 可恢复性判定（lane C 已核）：`assistantUsageById` newest-wins（Map.set 覆盖）、另两个 grow-only（数组 push），**都满足本地增量扫描的可恢复规则**

**哨兵（防复发的唯一办法）**：`session-info-incremental-scan.test.ts` 补一条「同一会话文件，增量 resume 路径算出的 usage 总量 == 一次性全量扫描算出的 usage 总量」。**什么算过**：哨兵先红（不修实现时）后绿。

### S2.3 H1：`DAEMON_COMMAND_PLANE` 总量表缺键（必炸编译错）
**事实（根代理验证，rev-facts 逐键复核）**：
- `[UP] daemon-protocol.ts:864` `DAEMON_COMMAND_PLANE` = **106 键**，`:971` 结尾 `} as const satisfies Record<DaemonCommandName, "session" | "control">;`
- `[UP] :684` `type DaemonCommandName = DaemonCommand["type"];`（**派生自联合类型，不是字面量列表**）
- 本地在 `DaemonCommand` 联合里加了 `declare_client_capabilities`（`[HEAD] :744`），官方全仓 **0 命中**
- `DAEMON_COMMAND_COMPATIBILITY` 在合并树 **107 键完备**（本地独有 1 + 官方独有 3，差集为空、无重复、块内 0 冲突标记）→ **不用改**

**修法**：PLANE 表补 `declare_client_capabilities: "control"`。
**v1 说「按实际处理端点定，不要照抄」，rev-exec I7 把事实查清了：两端都处理** → 已定死为 `"control"`，理由与核对方法见附录 §5.5。
**什么算过**：`npm run check` 过（这条 check 能抓到）。

### S2.4 R4：【v2.2 三方独立确认 = 零施工，自动合并已落地】
lane A §8 R4 原说「不改 `attachedClients` → `attachedClientCount()` 会误 evict 正在被 TUI 直连观看的会话」。**build-stage-a、p5、rev2-facts N14 三方独立复核后结论改为：不需要任何施工。**
- p5 逐点判定：`daemon-agent-connection.ts` 里 `attachedClients`/`attachedClientCount` **双双 0 命中**（v2 原把落点挂在这个文件，挂错）；`daemon-mode.ts` 里 `attachedClients` 4 命中（`:2727/:3172/:3253/:6924`）但都是 **worker 侧自报**，`HEAD:2616`/`UP:2682`/`WT:2727` **三版逐字相同**（只行号偏移）→ 不是漏改；第 4 处是官方新增自动合进来的
- 直连观看者走**另一个字段** `directAttachedClients`（`daemon-session-list.ts:64/:248/:277`），且 `daemon-mode.ts:4001` 对所有 client（含直连）都 `state.clients.add(client)`，求和在 **supervisor 侧的 `attachedClientCount()`**（p3 的文件，已在块外自动存活）→ **不会误 evict**
- build-stage-a 的谱系证明：BASE 是裸算 `[...this.clients].filter(...).length`，HEAD 逐字未改，UP 换成 `attachedClientCount()` + 新增定义 + 第三用点 → 因本地从未碰这两行，三方合并无冲突地全取官方形，`[MT]` 里定义 `:5005` + 用点 `:1128/:1310/:5016` 四点齐备且都在冲突块外
- 官方已用测试钉死：`daemon-peer-transport.test.ts:361+:460`、`daemon-session-list.test.ts:69` `toMatchObject({ attachedClients: 2, directAttachedClients: 1 })`
→ **在 daemon-agent-connection.ts 或 daemon-mode.ts 里改它反而是错的**（会重复计入直连）。落点若真要动只在 `daemon-supervisor.ts`，而它已自动落地。
**S4 观察项**：`daemon-supervisor-eviction.test.ts` 与 `session-action-store.test.ts`（HEAD=Y/UP=Y、merge 状态 M）的 fixture 语义已从「仅 supervisor 直连」变成「+直连 peer」，若有按旧语义写死的期望值会在全量回归暴露。

### S2.5 澄清两件事（避免施工代理搞混）
**(a) 直连走 supervisor 路径不是缺陷，不要动**（lane D §5.5 三层自证）：官方 `DAEMON_COMMAND_PLANE` 把 `shutdown`/`restart`/`prepare_update_restart`/`retry_worker` 全标 `"control"`（是本地 `DAEMON_CONTROL_PLANE_COMMANDS` 的**超集**）；`[UP] daemon-routed-client.ts:148→:156-161` 对非 session-plane 命令强制 `this.supervisor.request(...)`；worker 侧 `[UP] daemon-mode.ts:3559-3568` 另有白名单闸。**本地闸调用点在官方 peer 闸之后，顺序安全无误伤。**
→ 别把这条与 S2.1 搞混：S2.1 是新命令的**能力声明**缺失，§5.5 说的是 control-plane 命令的**路由顺序**本来就对。

**(b) v1 的 R9 口径已随 S0.1(c) 过期**（rev-exec I2 / K3 I-2）：若采纳 worktree 施工，施工树里没有别 lane 的改动，「#1927 撞别 lane 未提交文件」在施工树内**不成立**。真正的撞点转移到 **S8.5 合回时**：本轮 merge 面里 packages/ai 只碰 `openai-completions.ts`(+5) 与 `anthropic.ts`，与别 lane 未提交的 `openai-completions.ts` **必撞**；而别 lane 的 `models.generated.ts` 是 **staged** 状态。

## S3 · roster 族取舍落地

**总纲（lane A 第 6 条）：按轴二选一，不要全二选一。**
- **名单/摘要刷新轴**：官方明显更好。本地地板是每 worker 每秒 4 次全量 list 重建，官方 0 次；`roster_delta` + `setImmediate` 合并 + `RosterSessionSummary = Omit<..., "streamingMessage">` 在**结构上不可能**带整段助手消息。
- **流式正文轴**：**官方本轮完全没解，本地是唯一解 → 必须留**（详见下表第 5 行，v1 在这里判错了）。
- **快照身份轴（#1229）**：不能删。supervisor 判损坏的代码在 base / HEAD / upstream **三处逐字相同**，且 upstream 对 `nextSnapshotId`|`snapshotTransferSeq` **零命中**。

| 本地资产 | v2 裁定 | 依据 |
|---|---|---|
| list 载荷瘦身 + 刷新节流（`8981a31c3` 的一半） | **丢，取官方** | 官方是类型级 `Omit<..., "streamingMessage">`（**注意：做这个 Omit 的是 #1897 `8d5722ee9`，不是 v1 写的 #1909**），`handleList` 已零 worker 往返 |
| #1229 快照身份（`nextSnapshotId`） | **留**（已自动存活，逐点确认） | `[UP]` 全仓 `nextSnapshotId`/`snapshotTransferSeq` **0 命中**；`[UP] daemon-mode.ts:3959/6677/7106` 三处仍用游标模板串当身份；合并树 `[MT] :1403` 定义 + `:4016/:6760/:7189` 调用 + `active-session-state.ts:61` 字段**四个行号已复核全对** |
| resident-skip 顺序 + display stat 缓存 | **留** | 官方无等价实现 |
| ledger `replayCache` | **留，接在调用侧** | 见 S7.6（v1 的「二选一」是伪二分，已改写） |
| **`omitStreamingMessages`** | **【v2.6 三态实况，p10 D1 纠正派单曾写反】**客户端半边**活**（`agents-view-mode.ts:217-230` 定义 + `:1898` 一处调用点 = 删除确认期 liveness，原 `:2164/:2495` 随块 3/块 4 取官方消失；rev2-facts R4 的 `:1908` 即此行漂移前行号，任何解法下都活着）；supervisor 剥离**活**（`:2725/:2734`）；**supervisor↔worker 尾参休眠**（`:4157`/`:4174`，src 12 处调用无一传第 5 实参，唯一读者 `daemon-supervisor-streaming-list.test.ts`）→ 三态都保留代码，「删无用参数」清理会连休眠尾参一起删 | **v1 判「丢，取官方」是错的，rev-facts BL2 三条反证 + rev-exec I5 独立复核，根代理已亲手验证**：① #1909(`15ef45668`) 是修 reconnect-loop 的，其 diff 里 `streamingMessage` **命中 0**；做 Omit 的是 **#1897**，Omit 的对象是 `RosterSessionSummary`（**roster wire，不是 list**）② 官方 `[UP] daemon-session-list.ts:68` `streamingMessage?: AgentMessage;`、`:270` `streamingMessage: session.state.streamingMessage,` → **官方 list 照旧带整段助手消息** ③ `omitStreamingMessages`/`summaryWithoutStreamingMessage`/`list_without_streaming_messages` 在 `[UP]` 全仓 **0 命中**，`[HEAD]` 有 **12 处**（agents-view-mode / daemon-mode / daemon-protocol / daemon-session-list / daemon-supervisor）④ `[UP] daemon-supervisor.ts:4088` 仍是裸 `pullSource.request({ type: "list" }, 5000)`。**照 v1 做会静默删掉一个官方零覆盖的本地独有优化。** |
| `syncAgentPeers`「名单没变不重发」 | **无需动作** | README 表格这一条**已过期**：该函数在本地 HEAD 里就被上一轮合并 `bf542ce7e` 删掉了，src 零命中。S9 要修 README |

**⚠ 这条决定会改 wire 形状 → 改 schema digest**（rev-exec I5）：`omitStreamingMessages` 在 `DaemonCommand` 联合里，删了它 digest 就变，**lane D 预算的 `589a2219bc8b` 立即作废**。既然 v2 裁定保留，digest 预算的前提不变，但仍必须在 S5 用附录 §5.2 的脚本重算，不许手写（铁律 11）。

另两条重复实现的去重（lane C 发现）：
- `a807f3055` 的 TZ/locale-stable start id 与官方 `0ba0423c5`(#1971, fixes #879) 撞同一处：**官方更完整**（pin 4 个环境变量 `LC_ALL`/`LC_TIME`/`LANG`/`TZ`，本地只 pin 2 个；官方还抽成可单测的 `getPsProcessStartId` + 98 行专属回归 + `withLeaseGuard` onCompromised 检测）→ **丢本地这半边**。但 `a807f3055` 另半边 `isReclaimableOwnLease`/`activeLeaseDirectories` 官方没有，**必须留**。
- `refreshWorkerSummaries` 签名：**别留本地 options-object 版**。官方回到位置参数且有 **12 处引用**，留错会「看着没冲突、跑起来全崩」。

> **本地独占文件数口径（rev-facts N-5）**：v1 写「264 个」是 `313 − 49` 的宽口径；严格算（去掉双方都改过但本地净零的、以及 add/delete 型）是 **173 个**。铁律 7 的保护范围按宽口径 264 执行（保守无害），但 S9 文档记严格口径。

## S4 · 测试面处置

| 测试文件 | 行数 | 处置 | 理由 |
|---|---|---|---|
| `test/suite/regressions/1229-snapshot-transfer-identity.test.ts` | 66 | **保留零改动** | 只依赖私有 `nextSnapshotId` + AgentDaemon 构造，官方 `daemon-mode.ts:582` 仍在 |
| `test/daemon-supervisor-streaming-list.test.ts` | 211 | **重写**（不是改写） | 7 条 it 全断言 options-object 签名 + `list_without_streaming_messages` 能力 + `handleList` 透传。**但 v2 裁定保留该 wire 字段（S3），所以重写目标是「按官方 roster 架构重述同一意图」，不是删掉这个能力的覆盖**。**危险点：合并时它不冲突，会静默存活成必炸文件** |
| `w7-capability-control-plane` | 247 | **【v2.2 改判】保留零改动** | rev2-facts R5：那一行是 `test/suite/regressions/w7-capability-control-plane.test.ts:165` `const omitted = await client.request({ type: "list", omitStreamingMessages: true }, 5000);` + `:168` `error: expect.stringContaining("list_without_streaming_messages")`。它成为编译错的**前提**是 `omitStreamingMessages` 从 `list` 命令类型里被删掉——但裁定 4 / S3 表第 5 行 / S3 末尾 digest 注**都明确保留 wire 字段**，附录 §5.3 的永久门断言里还专门写了 `expect(session.has("list_without_streaming_messages")).toBe(true);` 并注明 "Drop this line only together with the wire field." → **字段保留 ⇒ `:165` 不会编译错 ⇒ 不需要换样例**。这一行是 v1 裁定（整体删）的残留，v2 改了裁定没同步。**风险：施工代理照"换样例"去改，会把本地 capability 闸唯一的端到端覆盖删掉** |
| `fixq5-q7-streaming-seed-integrity` | 386 | 保留，需实测 | — |
| `interactive-mode-chat-cap` | 451 | 保留，需实测 | — |
| `compaction-branch-boundary` | 51 | 零改动 | — |
| `f1-*.test.ts` / `fixq3-*.test.ts` | — | **必须重跑并可能重述判据** | 官方 #1967 删掉了 `hasRegisteredHeartbeat` 的 idle-eviction 否决 → 本地 F1 的自愈假设「带心跳的会话下个 tick 自愈」成立条件变了。本地留档未修的 F17 也可能被它顺手治好或放大 |
| **本地独有测试共 54 个**（v1 写 49，**漏 5 个**） | — | **全跑** | 43 个可直接存活；**漏的 5 个里有 3 个 tui 测试用 `node:test` 不是 vitest**，runner 命令不同。枚举与两条 runner 命令见附录 §5.9 |

## S5 · schema 27 + 闸号 + 版本核实（**必须最后一笔**）

### S5.1 撞号事实：**是四层（23/24/25/26），不是 v1 写的三层**（rev-facts IM3，根代理已用哈希公式复现全链）
| rev | 提交 | 产出 DAEMON_SCHEMA_ID |
|---|---|---|
| 22 | `8981a31c3^` | `protocol-7-schema-22-4d515169dc6b` |
| **23** | **官方 `ceb418049`(#1861) 22→23** | **`protocol-7-schema-23-649fe649d15e`** ← 与分叉点相同 |
| **23** | **本地 `8981a31c3` 22→23** | **`protocol-7-schema-23-e719bbbdac64`** ← **同号不同 wire，第一次撞号** |
| **24** | **本地 `bf542ce7e`（上一轮 merge，解决 23 号撞号）** ／ **官方 `1d2e91d3b`(#1900 roster subscription push)** | **本地 `protocol-7-schema-24-3e65c87439aa`**（正是 FORK_NOTES 记的那个 ID）／ **官方 `protocol-7-schema-24-75f88f1a91df`** → **24 也是真撞号层，同号不同 wire**（v2.2 补官方一侧 = rev2-facts R9；S5.2 第 4 点要把这张表抄进源码注释，缺官方一侧会让下一轮的人只看到半截教训） |
| 25 | 本地 `c72b9940f`（compaction 流式增量）／官方 `173d845a5`(#1926 直连传输) | 本地 `protocol-7-schema-25-4044beb7c9f4`（**v2.2 已补算**，根代理用附录 §5.2 脚本对 `c72b9940f` 重算，基线自证通过）／ 官方 `protocol-7-schema-25-585ef1102921` → **撞号** |
| 26 | 本地 `96d3db580`（capability + 控制面鉴权）／官方 `d74a75fea`(#2003 agents view token/cost) | **第三次撞号** |
| — | 分叉点 `5b6c0e94e` | `protocol-7-schema-23-649fe649d15e`（rev 23） |

当前两侧：本地 `protocol-7-schema-26-31fb64b6f4ee`（三段切片 **12264/347/3258**）｜官方 `protocol-7-schema-26-962b8b4c5e35`（**11755/377/3326**）。两个 digest 与三组长度**根代理与 rev-facts 各自独立复现成功**。
→ **23 号那层上一轮已经用「升号 + 重算哈希」解决过一次，本轮有本仓验证过的先例可循。**

### S5.2 施工要求
1. union 后升 **27**。**不能沿用 26**。
2. **撞号后果的口径修正（rev-facts N-2 / lane D §2.1(b)）**：v1 写「沿用 26 会让新旧进程互认兼容而 wire 不同 → 静默错乱」**是错的**。实际机制：`DAEMON_SCHEMA_ID` 只在客户端侧比（`[UP] daemon-launch.ts:77`、`daemon-ps.ts:311`），**不等就判 stale → 杀 daemon 重启**，是 fail-fast 不是静默。真正的静默路径只有**无 capability 保护的纯数字闸**，本轮唯一那处是 `AGENT_PEER_LIST_COMMAND`，而它恰好不出事（见下）。沿用 26 仍不可接受，但理由是「stale 重启风暴 + 排障误导」，不是「静默错乱」。
3. **digest 不许手写**（铁律 11）。用附录 §5.2 的 `node` 脚本重算（该脚本已实测复现 `31fb64b6f4ee` / `962b8b4c5e35` / `649fe649d15e` 三值）。
   **【v2.2 补 = p8 ⑤-4】重算时同时跑 6 个 `indexOf` 锚点的「>=0 且严格递增」检查**：digest 三段切片靠 6 个锚点，锚点一旦被解块移动/改名，`indexOf` 返 −1、`slice` 静默产垃圾串，那条 digest 自检 it 会因「错误的原因」红并与已知红混在一起查不出来。p8 实测当前 6 锚点各命中 1 次且递增（18650<31087 / 46798<47175 / 48652<52003，切片长 12437/377/3351）。当前合并后 wire 真实 digest = **`589a2219bc8b`**（与 lane D 预算一致），实现里是 ours 的 `31fb64b6f4ee` → 该 it 红、消红于本步。**只有改到三个切片才要重算**；`minSchemaRevision` 重编号**不影响** digest（rev-exec I6 实测）。
4. 在 `DAEMON_SCHEMA_REVISION` 的注释里写清 **23/24/25/26 四个号都曾被双方各自占用**（把 S5.1 表格两侧语义都列进去），**否则下一轮同步会第四次撞号**。
5. **闸号重编号的完整工作面只有 5 处**（rev-exec 数全了，清单在附录 §5.2）：
   - `[MT] :841` `LIST_WITHOUT_STREAMING_MESSAGES_COMMAND = 24` 本地独有 → **不动**（裁定 6）
   - `[MT] :844` `AGENT_PEER_LIST_COMMAND = 24`(ours) → **留**；`:846` `= 23`(theirs) → **删**（冲突块 4 内）
   - `[MT] :849` `DIRECT_PEER_TRANSPORT_COMMAND = 25` → **留原号**（裁定 2：官方新增保留原号）
   - `[MT] :1378` `DAEMON_OUTBOUND_COMPATIBILITY.assistant_stream_delta = 25` 本地独有 → **不动**
   - 其余 13 处 floor（8/11/14/17×2/18/19/20/22）两侧逐字相同 → 无动作
   **裁定 2 的「本地新增命令用 27」这条规则本轮实际不需要用**：合并后本地独有的新命令只有 `declare_client_capabilities`，它走 capability 门（`CURRENT_DAEMON_COMMAND`，`[HEAD] :914`），**没有 `minSchemaRevision`**。
6. `DAEMON_PROTOCOL_VERSION`：**建议留 7**（裁定 1）。

### S5.3 版本号：merge 自动带入，**不是施工项，改为核实门**（rev-exec Z4）
- v1 把「跟到 0.9.1」写成工单并要求「必须在 schema 27 之后」。**实测这是幻影工单**：合并树里 5 个 `package.json` + 根 `package-lock.json` **已经全是 0.9.1**，依赖范围已是 `^0.9.1`，且 **lock 不在 18 个冲突文件里** → merge 自动完成，顺序约束**不可满足也不需要满足**。
- **v2 改为一条核实门**（命令在附录 §5.2），期望输出 `OK 0.9.1 x5 + lock x5 + ranges x3`。
- **新增依赖是真实存在的（v1 说「不新增依赖」是错误事实 = K3 I-4 / rev-facts BL1 双重抓到）**：官方 #1893(`c382f0985`) 新增第三方运行时依赖 **`"grok-mermaid": "0.2.3"`**（`[UP] packages/coding-agent/package.json:61`、根 `package-lock.json` +10 行、新文件 `mermaid.ts:1` 顶层 `import { type MermaidArt, render, type Span } from "grok-mermaid";`）。**40 条提交里只有这一条新增依赖**。
  → `npm install` **必须真装上它**，不是「重生成 lock」。已核合规：发布于 2026-07-28，距今 38 天，不挡 `.npmrc` 的 `min-release-age=7`。
  → **`npm install` 失败必须列入 S8 验收门**。批 0 若按 v1「今天可拿」拿完 #1893 而不装依赖，必撞 `npm run check` 编译不过。
- **【v2.1 修正】「14 个冲突」是单提交视角的幻影，整树 merge 下不存在**（rev2-flow I2，根代理已复验）：
  - 那 14 个（9 `package.json` + 4 `package-lock.json` + 1 `CHANGELOG.md`）来自 `git merge-tree --merge-base=81ae3cb34^ HEAD 81ae3cb34`，即**「只单独合 #1961 这个 release 提交」**的视角。
  - **整树 merge 的 18 个冲突文件里：零 `package.json`、零 lock、零 `CHANGELOG.md`**（根代理实测 `grep -E 'package.*json|CHANGELOG' /tmp/r3_conflicts.txt` 无输出）→ 这些文件整树 merge 下**自动合并成功**。
  - → v2 写的「4 个 `examples/extensions` 版本号要手工取官方」「3 个嵌套 lock 必须手工取官方」**都是无的放矢，已删**。那 4 个 examples 的版本号差异（本地 `0.0.1/0.0.1/1.4.0/0.0.1` vs 官方 `0.1.1/0.1.1/1.5.1/0.1.1`）会自动合并成官方值，**无需动作，S8 核一眼即可**。
  - 保留的有效结论只有 rev-exec Z4 那条：**版本号 merge 自动带入，S5.3 只是核实门**。

### S5.4 【新】`npm install` 的时点与隔离（rev2-flow I9，v2 把 install 排在 S5.3 太晚）
**事实（rev2-flow 实测 + 根代理复核）**：`[MT] packages/coding-agent/package.json:61` 已含 `"grok-mermaid": "0.2.3"`、`[MT] src/modes/interactive/components/mermaid.ts` 已存在、而主仓 `node_modules` **无** `grok-mermaid`（ABSENT）。
→ 从 merge 后第一次 `tsgo` 起，每步都会带 `mermaid.ts` 的解析失败红。**没有技术理由等到 S5.3**（package.json 合并后已是 0.9.1）。

**v2.1 裁定：merge commit 落地后立即 install。**

**⚠ 但必须先解决隔离问题（这是根代理在 S0.2 亲手埋的雷，rev2-flow I9 抓到）**：
S0.2 原方案把 worktree 的三个 `node_modules` 做成**指向主仓的符号链接**（照仓里既有 19 个 worktree 的做法）。在这种布局下，**在 `$WT` 跑 `npm install` 会经符号链接把主仓 `node_modules` 改写成 0.9.1 依赖树** —— 而别 lane 正在主仓用这套环境跑开发。S0.2 只意识到 `@earendil-works/pi-ai` 相对链接的**只读方向**（I1 降级），没意识到 install 的**反向写**。

**已执行的拆雷动作（根代理，2026-09-04）**：把三个 symlink 换成**独立目录**（`rsync -a` 自主仓，398MB，磁盘可用 44GB）。
- 拆雷前已核实主仓未被污染：`ls {root}/node_modules/grok-mermaid` → ABSENT
- **附带收益：I1 的 pi-ai 降级自动消解**。`@earendil-works/pi-ai` 是**相对**链接 `../../packages/ai`，`rsync -a` 保留 symlink 文本 → 在 worktree 里解析成 `$WT/packages/ai`（施工树自己），不再是主仓。
  → **所以 S0.2 的「(ii) 接受降级」裁定作废，改为「packages/ai 可以正常 typecheck 与真跑」**。施工代理必须在 merge 后**亲手复核** `os.path.realpath($WT/node_modules/@earendil-works/pi-ai)` 指向 `$WT/packages/ai`；若仍指向主仓，说明 rsync 解引用了 symlink，需退回降级口径 (ii)。
- **硬纪律：本轮任何 `npm install` 只允许在 `$WT` 里跑，且跑之前必须先确认 `$WT/node_modules` 不是 symlink**（`[ -L "$WT/node_modules" ] && echo 危险 || echo 安全`）。

**什么算过**：`ls $WT/node_modules/grok-mermaid/package.json` 存在；`node -e "require.resolve('grok-mermaid')"` 在 `$WT` 下成功；主仓 `ls {root}/node_modules/grok-mermaid` 仍 ABSENT（证明没反写）；`realpath` 复核 pi-ai 指向施工树。

## S6 · CHANGELOG 与碎片对账【v2.3 改判：碎片单一真相流程，S6 的 Unreleased 段已 revert】
**改判理由**：AGENTS.md Changelog 规则字面「Do NOT edit `packages/*/CHANGELOG.md` directly. Instead, add a fragment file」。S6（p10，commit `ea68ff750`）直接新建 4 个 `## [Unreleased]` 段（101 insertions / 0 deletions）= 违反字面；且 p10 实测 `release.mjs patch --dry-run` 会双写（写前 107 bullets → 写后 196，89 条重复，因 `buildReleaseSection` 把 Unreleased 段吸收进 release 段开头**同时**再追加盘上全部碎片）。碎片还在盘上（71 个），release 时折叠 → 本轮记录不丢，Unreleased 段是额外的重复记录。
**裁定 (C)+(D)**：`git revert ea68ff750` + 把 p10 的 3 处格式修正同步回 2 个碎片（`#1249` 两条裸引用改 `([#1249](…/pull/1249))`、`#1229` 补尾句号；`#1253` 链 /issues/ 实为 PR 那条不改，GitHub 会重定向，单方面改会让 CHANGELOG 与碎片分叉）。p10 执行中。
**p10 的对账结论保留有效**（revert 不否定它们）：
- 盘上 fork 自写碎片 **71** 个（70 个 HEAD-only + 1 个 merge commit 自建的 `sync-upstream-r3.md`）；ls-tree 集合运算 A−U=103、(A−U)−M=33、(A−U)∩M=70 ✓
- 碎片 bullet 与官方已发布段**零重复**（四级比对全 0 + 词级 Jaccard 最高 0.289 < 0.35 阈值；负控 NC1/NC2 证明检测器有牙）
- 89 条 bullet 全过去式动词开头、单行、85-300 字符、0 裸引用残留
**v2.3 修正任务书三处过期/错误**：
- ① 「index 里 33 D + 13 A」已过期：merge 已 commit（`3367d85c4`），`git diff --cached` 为空；那批增删在 merge commit 内完成。对账改用 `git diff --name-status 0c504e475 3367d85c4`
- ② 碎片核对命令 `git diff --name-only 5b6c0e94e 0c504e475 -- '*/.changes/*'` 实测返回 70 不是 103（该 diff 是 base→tip 双向差异，与「HEAD 独有」语义不等价；数字碰巧对但推导不成立）→ **改用 ls-tree 集合运算**（p10 的口径）
- ③ **原指令「在 `## [0.9.1]` 之前插入 Unreleased 段」作废**（它对 ai/tui 也不成立：首段是 `## [0.9.0]`、agent 包无 0.9.x 段首段 `## [0.8.0]`；且整体违反 AGENTS.md）。**正确口径：碎片留在盘上，由 `scripts/release.mjs` 下次 release 折叠；不要手写 CHANGELOG**（build-stage-a 失职自记的教训：核提交时除了任务书口径必须同时对一遍 AGENTS.md 与相关脚本实际行为；凡「往脚本自动折叠的产物里手写内容」的工单先读那个脚本——本轮读 `buildReleaseSection` 那 20 行就能预判双写）
- ④ 草稿头部的 HTML 来源注释**不能写进 CHANGELOG**（`unreleasedRe` 会把注释一起吸收进 release 段永久污染）；来源说明放 commit message body
**release 前置待办（S9 记）**：下次 `npm run release:*` 前无需额外动作（revert 后走默认碎片流程，无双写）。
**已知红清单最终版（v2.5 拼接总账版）**：merge 引入的红 = **5 条全修全绿**；**#1896 零回归**（受影响面 45 文件 1026 collected / 1025 passed / 1 failed，那 1 条是 build-stage-a 自己的 kernel pin 假红；拼接依据 = 旧基线 1025/1025、collected +1 = p11 加的 it、passed +0）。最终拼接总账 collected 7301 / passed 6428 / failed 81 / pending 792；假红扣除 81 − 12（env）− 1（pin）= **真实红 68 条，全部 local_base 既有红**（逐标题集合比对）；python 真实红 0（17 变量清污 291 passed + 11 subtests）。
既有红构成（S9 待办按优先级）：① extension 加载面同族 **58 条**（discovery 23 / runner 23 / input-event 7 / resource-loader 4 / timeout 1）无人认领最该先 ② ai 模型目录 6 条（getModel 返 undefined，疑似别 lane 未落地的 models.generated.ts）③ git-context 1 + 4600-supervisor-singleton 1 ④ repl-kernel-state-roundtrip 2。
**v2.5 新增教训（build-stage-a 自报）**：为规避危害而引入的缓解措施本身必须当变更验证——它把 kernel pin 到施工树残缺 venv（只有 mcp/tyro/dill）造成 1 条假红并广播给了 p11；三向实验坐实（pin 共享 venv 绿 / 不 pin 绿 / pin 残缺 venv 红）。正确口径：跑真 kernel 面要么不 pin、要么 pin 到 `$HOME/.prime/agent/kernel-venv/bin/python`；「真零污染需先给施工树 venv 补齐默认包」**不批**（等于复制共享 venv 依赖面，收益不抵复杂度；不 pin 已实测不改共享 venv）。
**已知红清单最终版（v2.4，build-stage-a 全量门 + 归因跑坐实）**：merge 引入的红 = **5 条，5 条全修全绿**（digest 自检 S5 / fixq5-q7 ×2 p9 / agents-view-roster ×1 p9 / agent-session-recursion ×1 build-stage-a）。剩余 **69 条 100% 是 local_base 既有红**（新 scratch @ 0c504e475 + 17 变量清污 + kernel pin worktree venv，10 个文件失败标题集合逐字相同 → merge 引入 0 条）。**本轮欠账清零。**
既有红待办（S9 立，按优先级）：① extension 加载面同族 **58 条**（extensions-discovery 23 / extensions-runner 23 / extensions-input-event 7 / resource-loader 4 / extensions-timeout 1 / 另 3 条同族）无人认领，最该先认领 ② ai 模型目录 6 条（`getModel(...)` 返回 undefined，疑似与别 lane 未落地的 models.generated.ts 有关）③ git-context 1（ssh remote url 归一化）④ 4600-supervisor-singleton 1 ⑤ repl-kernel-state-roundtrip 2 ⑥ python test_bash 文件内顺序依赖 1（12 处 enterContext mock.patch.dict，单跑绿全文件红，test_bash.py 与 src/rlm/bash.py 双向 IDENTICAL 结构上不可能是 merge 引入）。
全量门总账：collected 7297 / passed 6423 / failed 82 / pending 792；修正后真实 failed = 82 − 13 假红 = 69。SKIP 对照面：ai 714 pending = 真 provider key 门（AGENTS.md 明禁 suite 用真 key，设计如此）；CA 70 pending = kernel-heavy tag（已由 test:kernel 段覆盖）+ windows 门 + rpc 14 / tree-navigation 10 / compaction-extensions 8 / daemon-supervisor-process 8 / compaction 2。
**S9 audit-findings 清单（本轮累计 7 条）**：① repl.py #1249 硬化 Python 侧零测试覆盖 ② npm 10.9.4 静默忽略 `min-release-age=7` ③ 附录 §5.6 的 repl.py 门命令照抄会假红 40 条 ④ `edit` 技能相对路径按 REPL cwd 解析 → 多 worktree 写错树（build-stage-a 事故，已记 global memory）⑤ 附录 §5.2「13 处 floor」计数错（实 10 处漏 15）⑥ **build-stage-a 失职：核 `ea68ff750` 用任务书二手口径没对 AGENTS.md 一手规则，放过违规提交**（已自记 §12.7；教训=核提交必须对一手规则与脚本实际行为）⑦ **派单/附录路径错第 3 条：`src/core/rlm-ledger.ts` 不存在，真实路径 `src/modes/daemon/rlm-ledger.ts`**（p9 纠正）。

## S7 · PR 增量（必须在 S5 之后）

### S7.1 TAKE 清单（lane B 裁定 9 条，但 **deps 5 条本轮不进** = rev-exec I8）
| PR | 规模 | v2 裁定 | 备注 |
|---|---|---|---|
| **#2027** cancel RLM subtrees through one iterative visited walk | +167-92, 3f | **TAKE，本轮最高优先** | **治的是本地已在身上的病**：`[HEAD] agent-session.ts:10675-10691` / `:10771-10789` / `:10221-10249` **三个 walker 在两个 map 上无 visited 递归**（`:10555` 证明双成员成立）→ **2^k**；且 `hasRunningRlmChildren` **每次 roster flush 都跑**（`daemon-session-list.ts:244`、`daemon-mode.ts:5240`）= README 第一行那个病（worker 228%CPU/2GB）的**第二个根因**。**硬依赖**：`cancelRunningRlmDescendants` 本地与分叉点都 **0 命中**、官方 5 命中（`[UP] agent-session.ts:10448/10452/10469/10475/10480`），唯一引入者是待同步的 `616557280`(#1986) → **必须先做 S1** |
| **#1947** persist kernel stderr to disk and bound the in-memory tail | +140-17, 5f | **TAKE** | 与本地 F27 内存修复同方向，**施工前确认不互斥**（已知不确定项 5） |
| **#1896** retry empty final turns | +220-12, 6f | **TAKE，但适配点必须写死** | **v1 只写「需补一处 fork 侧适配」不够照做（K3 I-5 / lane B R5）**。适配点：空回合重试造成两次 assistant `message_start` 之间无 `message_end`，而本地 `[HEAD] interactive-mode.ts:5526-5528 → :5796-5811` 每次都 `new AssistantMessageComponent` + `addChild` → **聊天区留永不 settle 的 thinking 幽灵气泡（F65 同族）**。**不补就引入可见缺陷**；且适配点在 v1 自认「未深审」的 `interactive-mode.ts` 里 → 若不愿承担，**该 PR 降级为观察** |
| #1389 keep original session when forking | +1058-24, 12f | **可选 TAKE** | 巨型组唯一推荐（10 CLEAN + 2 新文件零冲突）。已知它 CONFLICTING 的成因是 schema 20 vs 26，**本轮升 27 后需重新复核** |
| **deps 5 条**（#2018 mcp / #2017 tyro / #1579 marked / #1577 github-script / #1576 checkout） | — | **本轮不进**（rev-exec I8） | 理由：① 根 lock 已被 `grok-mermaid` 强制再生，混入 dep 变化会**毁掉 S8 的归因** ② Bun 线（#1970）未表态，它会删 `.npmrc` + `package-lock.json` 把 7 天规则搬去 `bunfig minimumReleaseAge=604800` → **在 Bun 线落地前动 deps/lock 是赌方向** ③ #2017 tyro 是 Python 侧，**无门覆盖**。例外：**#1576/#1577 是纯 CI 面，可随手拿** |
| #524 import coding harness sessions | +3567, 29f | **可拆分摘取** | 只摘 `session-import/*` 11 个新文件 + 自己接线。**摘取前必过铁律 13** |
| #1994 harden native Windows runtime | +2073-172, 42f | **可拆分摘取 2 文件** | 只摘 `kernel/bootstrap.ts` + `utils/shell.ts`。整体不碰（base 是未合的 #1982）。**⚠ lane B R2：解 #1982/#1994 冲突取 theirs 会静默吃掉本地 F4(`2637973c1` 管道 DACL + `daemonIpcListenOptions`) 与 lease 双修(`a807f3055`+`3a450907d`)，且这四条的测试文件也在 PR 改动面内会一起被覆盖 → 动手前必过铁律 13** |
| #1928 hosted model catalog | +993-154, 21f | **观察不拿** | **与别 lane 未提交改动正面相撞**（同一 base blob `4ebf6c3b8d`）：它整块删掉 `model-registry.ts` 的 `OpenAICompletionsCompatSchema` 搬去 `packages/ai/src/model-compat-schema.ts`，而别 lane 正往里加 `preserveThinking`/`enableSearch`/`searchStrategy`/`forcedSearch`。严重度已下调（新 schema `additionalProperties: true` 非严格，PR 自带测试钉死 `Value.Check(..., {providerExtension:"value"}) === true`，fork 在用的 `~/.prime/agent/models.json` 已在用那 3 个字段 → 不会变 invalid），代价是 4 个 `Type.Optional` 声明需改落新位置。**本轮不动，S9 记这笔账** |
| #1996 root agents create sibling sessions | +553-16, 11f | **观察不拿** | **硬证据**：`createRlmRootSession` 用 `lifecycle:"resident"`，**不进** `_activeRlmChildRuns`/`_rlmChildSessions` → #2027 的迭代器、F2(`82683e4ee`) 的 quiescence、abort 级联**全都看不到它**；`grep quota\|budget` **0 命中** → 不受预算约束；**不受 `RLM_MAX_DEPTH` 约束**；且 `bootstrap.ts` 的 `RUNTIME_READY_CHECK` 新增 `assert callable(rlm.create_session)` 是**硬闸**。造出的会话躲开全部回收机制 |
| #305 plan mode | +1262-14, 28f | **观察** | 价值最高的一个，但**不能 cherry-pick**，建议当设计参考自研 |
| #1177 typed system-prompt provenance / #1252 clipboard | — | **观察** | 可白拿，收益低 |
| #2028 semantic-edge ledger onto event-log | +45-86, 5f | **观察（下一轮）** | **它不是提交，是 open PR**（v1 曾误列入）。依赖 `event-log.ts`/`semantic-edges.ts`（来自 #1987/#1885） |
| #525 harden dependency supply chain | +770-162, 22f | **SKIP** | — |
| #2025 #1970 #1982 #1980 #1157 #1169 | 巨型 | **不碰** | #2025 DRAFT +170636（`gh pr diff` 返回 HTTP 406）；#1970 Bun 主运行时 21 文件冲突 CONFLICTING/DIRTY，**且它用 `bunfig.toml` 的 `[test] pathIgnorePatterns` 永久排除 3 个测试文件（含 `daemon-supervisor-monitor.test.ts`，在 files_both 里、属本地 F24/F25 回归面同区）→ 全量绿但断言不执行**；#1982/#1980/#1994 base 是未合的 #1970；#1157/#1169 base 未合 |

### S7.2 提示词相关（本轮同步的净影响）
- **#1952 + #1955 净效果严格为零**，三条独立证据（rev-facts 已复核全中）：① blob 哈希 `ef610268e → 64f17830d → ef610268e` 回到原值 ② `git diff 3d639f7ba^ 48c69d412 --stat -- packages/coding-agent/` **无输出** ③ 当前会话系统提示词里那句仍是 revert 后的版本。
  → **两条都 SKIP，且必须成对处理**。只拿 #1952 对本 fork **有害**：本地 172 提交的核心战场是子代理资源治理，让空闲子代理默认常驻会加重正在治的病。
  → **#1955 的 commit message 声称加了 prompt coverage 测试，但 `git show 48c69d412 --numstat` 只有 2 个文件（`.changes` 删除 + `rlm.ts`），零测试文件** → 不要以为官方补了提示词回归测试。
- **#1910 是真改动**：本地 `prompts/rlm.ts` blob **三方相同 = `d5d13ba37`（从未改过）** → CLEAN 直拿，会进 `REPL_CONTROL_PROMPT` 那句 "Use `bash()` to invoke programs, not to write shell programs"，与本地已合的 #1685 内核换血同向，无冲突。

### S7.6 #1885 / #1984 / #2021 / #1987 / #1957 这一族（三个代理结论曾互相矛盾，根代理已实测裁定）
**实测事实（四条，决定性）**：
1. `[UP] rlm-ledger.ts:15` = `import { EventLog } from "../../core/event-log.js";`，另有 `:299` `private readonly eventLog: EventLog`、`:312` `new EventLog(this.path, {...})`、`:722-724` `this.eventLog.replaySync(...)`
2. `core/event-log.ts` 的**唯一引入者**是 `118c1d90d`(#1987)
3. **本地没有 `event-log.ts`**；本地 `rlm-ledger.ts` 自己实现 `readAllSync`(`[HEAD] :291`) 与 `replayCache`(`:334`)
4. 提交时序：**#1957 → #1987 → #1885 → #1984**（40 提交列表是倒序）

**由此推翻两个代理的口径**：
- **#1987 不是 #1885 的上层，是它的基座**（lane B 说"官方在 #1885 上盖了 #1987"方向说反了）
- **#1987 绕不开**，lane A 的"连带 #1987/#1957 延后"不成立
- **但 v1 写的「二选一」是伪二分（rev-facts 补强）**：`event-log.ts` 与 `test/event-log.test.ts` 都是**官方新增文件**，merge 时**无条件进来**，与 `rlm-ledger.ts` 怎么解无关

**v2 裁定：全拿（merge 的自然结果），`rlm-ledger.ts` 只有一条路**：
> **theirs 为主体手工融合** + 删本地 `readAllSync`/`truncateTornTailSync` + 把 `replayCache` 接在**合并树 `[MT] :864` 那次 `eventLog.replaySync` 的外侧**（不是接进 substrate 内部）。这与 S3 表第 4 行「下沉到调用侧」一致。

**但必须消掉 lane A 指出的两处性能白付**（它的性能担忧成立：每请求对完整 messages/tools 做 `JSON.stringify`+`sha256` 与 2 次同步 `appendFileSync`，正对本地主权区，多子代理乘 N）：
1. 确认 semantic-edge recorder 的**默认开关状态**（未查，已知不确定项 6）；若默认开启，评估在 fork 侧默认关掉（settings 门）
2. **修 `hashTurnBody` 的实参先求值**：recorder 已 disabled 仍白付一次 hash → 改成惰性求值（传函数或先判开关再算）。**这是纯收益的修法，与是否保留该特性无关**
3. 2 次同步 `appendFileSync` 在 fan-out 场景放大 → 施工后必须用多子代理场景实测（本仓有现成场景）

**什么算过**：`rlm-ledger.ts` 编译通过 + 本地 `replayCache` 已接在调用侧 + 多子代理场景下 semantic-edge 写盘的 CPU/IO 实测不高于合并前基线。

## S8 · 六道验收门（v1 五道，第 4 道跑错树已修，新增第 6 道）

1. **`npm run check` 全绿**（无 tail，看全量输出）。能抓 H1，**抓不到 P0-A / P0-B**。**⚠ 它带 `--write` 会改文件 → 只在施工 worktree 跑**（rev-exec I2）。
2. **本地独有的 54 个测试全跑**（v1 写 49）。枚举与两条 runner 命令见附录 §5.9（**3 个 tui 测试用 `node:test`，不是 vitest**）。
3. **三条便宜哨兵**：`test/daemon-protocol.test.ts:100`（schema 哈希）｜`test/session-info-incremental-scan.test.ts`（S2.2 新补的 usage resume == 全量）｜`test/suite/regressions/1229-snapshot-transfer-identity.test.ts`（保留零改动）
4. **【v2 修正】三个核查脚本跑在当前工作树**（或 `git write-tree` 出的新树），**不是** `git archive <merge-tree-oid>` 的固定树。施工期基线：悬空 import **0** / 重复顶层声明 **0** / 总量映射表破口 **≤1 且等于已知 H1**；S2.3 落地后归 **0/0/0**。
   **⚠ 那三个脚本原本不存在**（rev-exec Z7 双路搜索 0 命中，lane D 附录只留了 `/tmp/mt`、`/tmp/conf`、`merged_proto.ts`、`orphan_*.txt`）。
   **【已解决 1/3】第 3 条（总量映射表完备性，最便宜、收益最高，H1 就是它抓到的）根代理已实现并验证**：`/tmp/r3_check_tables.mjs`。
   - 实测基线（在 `git archive 3cd22c1a0 | tar -x -C /tmp/mt_r3` 的合并树上跑）：`DAEMON_COMMAND_COMPATIBILITY` 键=107 联合成员=107 ✓ 完备；`DAEMON_COMMAND_PLANE` 键=106 联合成员=107 ✗ **缺=[declare_client_capabilities]** → **破口 1，与 lane D 的 0/0/1 一致**。
   - 交叉验证：在 `[HEAD]` 单文件树上跑得 104/104 ✓、在 `[UP]` 上跑得 106/106 ✓（两张表），与 rev-facts 复核的数字吻合。
   - 反向验证：构造「官方文件 + 联合加一成员 + COMPATIBILITY 补键 + PLANE 故意不补」→ 输出与真合并树**逐字相同**，证明抓的是真问题不是巧合。
   - **实现过程中踩到两个坑，已修，施工代理若重写要注意**：① 联合成员内部含分号（`{ id?: string; type: "x" }`），终止符不能用 `;`，必须扫到下一个顶层声明，否则在干净树上也 100% 解析失败；② `list_saved_sessions` 定义在独立类型 `DaemonSavedSessionListCommand`（`[HEAD] :433`）里由 `DaemonCommand` 联合引用，**不递归展开子联合会漏成员，把合法键误报成「多」**。
   - 另发现 `KEYBINDINGS`（`[HEAD] keybindings.ts:299`）是 `satisfies Record<string, Keybinding>`，键类型是 `string` → **无有限约束，不做完备性检查**（58 键）。所以附录说「全仓 3 张表」里实际只有 **2 张**受总量约束。
   - **fail-closed 纪律**：解析不出键类型一律**计为破口**，绝不静默跳过（第一版就是静默跳过 → 在合并树上报「破口 0」的假绿）。
   - **仍需实现**：第 1 条（悬空 import，要递归展开 `export * from`，估 ~2h）、第 2 条（重复顶层声明，估 ~1h）。若来不及，按附录 §5.11 的兜底：S8 第 4 道门改写为「总量映射表完备性 = 0 破口」+ 替代门 `npx tsgo --noEmit`。
5. **门的局限要心里有数（p7 实测，v2.2 补）**：`biome` 的 `correctness/noUnusedImports` 对未使用 import **不报**（控制样本 rc=0 零诊断），零调用者函数也不报 → **H10（删孤儿符号）与陷阱 3 这类「孤儿/零调用者」判断 biome 兜不住，只能靠逐符号 grep + 全仓 tsgo**。`esbuild --format=esm` 只是语法门，对非「补括号」形状的块没有判定力（p7 的语义负控 esbuild EXIT=0、只有 biome lint EXIT=1）。所以 S8 的「孤儿符号」核查必须用 grep 计数，不能信 biome/esbuild 的 EXIT=0。
6. **手工验证两个静默坑真的修好了**（测试绿不代表行为对）：
   - P0-A：daemon 模式下 agents view 能打开 + subagents bar 有数据 + 直连传输没回落（日志里没有 `get_direct_worker_transport` 被拒、没有 `roster_subscribe failed:` 循环）
   - **P0-B（v2.2 改判据：原写法「长会话跑若干轮后比对」是假绿门 = rev2-facts R1）**：活动会话的 cost 走内存 `getOwnUsageSummary()`，**不修实现也绿**。正确验法是**跨 passivation 比对**：「同一会话：活动状态下 agents view 显示的 cost → 让它 passivate（或换一个非活动会话行）→ 再看同一行的 cost，**两者必须相等**」。
     **P0-B 唯一有效的机器门是门 3 的哨兵** `session-info-incremental-scan.test.ts`（rev2-facts 复核：不修实现必红）。手工项若嫌麻烦可删，但删了要在回执记明「只靠哨兵门」。
6. **对账门（采老板 AGENTS.md 合并纪律第 5、6 条口径，替代 v2 自造的「测试清点门」）**：
   - **先对账再全量**：`--collect-only` 核 `collected == passed + failed + skipped`，对上了才跑全量。
   - **SKIP 数必须报**：SKIP 非 0 时**必须说明对照面为什么不在场**（纪律第 6 条）。
   - **异常信号**：`EXIT=9` 或整数秒腰斩 → **先疑看门狗**，别当成测试失败去改代码。
   - 兼收 K3 I-6 / lane B R1 的原意（防「测试被配置排除」的假绿，如 #1970 的 `bunfig.toml` `pathIgnorePatterns` 永久排除 3 个测试文件）：**merge 前后各收集一次测试文件集合，差集逐条可解释**。对账门本身就能抓到这类问题——被排除的测试表现为 collected 数下降。
7. **`npm install` 必须成功且真装上 `grok-mermaid@0.2.3`**（S5.3）。install 失败 = 验收不过。

**已知未覆盖面（必须写进 S9 文档）**：① `interactive-mode.ts` 未深审 ② packages/ai 若采纳 S0.2 的 (ii) 降级，则本轮不做真跑 ③ 三个核查脚本是新写的，自身未经验证。

### 已知红清单（B-3 要求，铁律 2 据此豁免）
| 红项 | 从哪一步开始红 | 消红于 |
|---|---|---|
| H1 的 PLANE 总量表破口（核查脚本第 3 项 = 1） | S1.2 第 6 步 | **同步消红**（v2 已把 S2.3 并进第 6 步） |
| `test/daemon-protocol.test.ts` 的 schema digest 断言 | S1.2 第 6 步（块 1 临时取 ours 的 26） | **S5**（升 27 + 重算 digest） |
| `test/daemon-supervisor-streaming-list.test.ts` | merge 那一刻（静默存活成必炸文件） | **S4**（重写） |
| `npm run check` 因 `grok-mermaid` 未装而编译不过 | merge commit 落地那一刻 | **`npm install` 之后**（时点见 S5.4） |
| **`tsgo --noEmit` 因 `mermaid.ts` 解析失败而红（与上一条同源）** | merge commit 落地那一刻 | **同上，`npm install` 之后**。⚠ 铁律 14 要求每步跑 `tsgo --noEmit`，若不记这条同源红，施工代理每步都会撞「上表之外的红必须当场查」→ 白白排查 20 次（rev2-flow I9） |

铁律 2 在 v2 的口径：**全量回归除上表已知红之外全绿**。上表之外的任何红都是新问题，必须当场查。

## S8.5 · 合回 `merge/repl-kernel`（v1 完全缺失此工单 = K3 I-2）

S0-S9 没有任何一步说 `sync/upstream-r3` 怎么回到主分支。若采纳 S0.1(c)，这一步才是真正的撞点。

1. **前置**：确认别 lane 的 4 个 ` M` + 1 个 `??` 已落地或已明确交接。
2. **真撞点（rev-exec I2 实测）**：本轮 merge 面里 packages/ai 只碰 `openai-completions.ts`(+5) 与 `anthropic.ts`，与别 lane 未提交的 `openai-completions.ts` **必撞**。
   **index 状态已核实（rev2-flow I1，根代理复验）**：`git diff --cached --name-only` = **0**，别 lane 那 4 个改动**全部 unstaged**。所以合回时用 `git commit --only -- <paths>` 点名本轮文件即可，不会误提交别 lane 的工作区改动。但**合回前必须重跑一次 `git diff --cached --name-only`**（别 lane 随时可能 stage；一旦它 stage 了删除，`--only` 会把删除覆盖回来 = 老板纪律第 2 条）。
3. **交接顺序**：谁先落地谁后 rebase，需与别 lane 明确约定。**建议本轮后落地**（本轮改动面大，让它先提交）。
4. **合回方式**：`git checkout merge/repl-kernel && git merge --no-ff sync/upstream-r3`（保留分支痕迹便于回滚）。**禁止 fast-forward 后删分支**，直到 S8 全绿且观察期结束。
5. **回滚路径**（rev-exec I9，v1 全文没有一条可执行的放弃步骤）：四条命令见附录 §5.10，全部只在施工 worktree 内动作，不碰主仓。
6. **【v2.1 明示】「攻坚到一半保住已解部分」在结构上不存在**（rev2-flow I8 + B1）：merge 是原子的，第 17 步卡住时**没有合法的部分提交状态**。可选的只有两条：
   - **整体退**：`git merge --abort`（回到干净的 `0c504e475`），前 16 步成果全丢
   - **存盘续做**：每阶段把已解文件 `cp` 到 `/tmp/r3_wip/<阶段名>/`，恢复流程是 **重新 `git merge upstream/main` → `cp` 回已解文件 → `git add` 标记已解 → 从未解的那一步继续**（附录 §5.10 已补此流程）
   → 为降低这条风险，**铁律 2 新增的「每步解完即 `git add`」是硬要求**（merge 中 add 是合法进度固化），且**每阶段结束 cp 一次快照到 `/tmp/r3_wip/` 并在 `PROGRESS.md` 记一行**。

### S8.5b 【v2.2 新增 = build-stage-a 隔离仓实测】merge 期间的 commit 方式
**`git commit --only -- <paths>` 在 merge 期间被 git 硬拒**（我原派单里写的这条不可执行）：
```
$ git commit --only -- a.txt -qm "merge with --only"
fatal: cannot do a partial commit during a merge.
EXIT=128        # 失败是安全的，index 完好
```
→ **不必用 `--only`**：merge 期间 index 的内容**就是**合并结果（当前 193 文件 = 37 A / 33 D / 119 M / 1 R084）；`--only` 的立意（别扫进其他 lane 的 staged 改动）在本轮由另一事实保证——p1-p8 被明令禁止一切 git 写，index 只由根代理/收口代理写。
**commit 用普通 `git commit -F <msgfile>`**（隔离仓实测 EXIT=0、2 个 parent、树含自动合并新增文件、status 空）。
**commit 前必跑三条只读 safeguard**：
1. `git diff --name-only --diff-filter=U | wc -l` = 0（无未解冲突）
2. `git diff --cached --name-status HEAD | cut -f1 | sort | uniq -c` 期望只有 A/D/M/R **没有 U**
3. `git status --porcelain | grep -v '^M ' | grep -v '^A ' | grep -v '^D ' | grep -v '^R'` 期望**空输出**
**【v2.2 补 = p3 ⑤-7】`UU` ≠ 还有冲突**：别车道解完但没 add 的文件仍显示 UU 而标记数已是 0。**判进度必须用 `grep -c -E "^<<<<<<<|^=======|^>>>>>>>"`，不要用 `git status`**（p3 曾拿一个刚被别车道解完的文件当 biome 负控、得 EXIT=0，差点误判成 biome 盲点）。
**自带安全网（实测）**：仍有 UU 时直接 `git commit` → `error: Committing is not possible because you have unmerged files.` + `fatal: Exiting because of an unresolved conflict.` EXIT=128，**MERGE_HEAD 与 index 都不受损** → 收口顺序自带保护，不可能漏解就提交。
**S6 对账基准（build-stage-a 实测 index）**：33 个 `D` **全部**是 `packages/*/.changes/` 碎片（33/33 命中），与 I-3「merge 静默删 33 个碎片」逐字对上；`A` 里另有 **13 个新碎片** → **S6 对账 = 删 33 / 增 13**。

## S8.6 · 【新】双审工单（老板 AGENTS.md 流水线第 6 步 + 第 8 步，v2 完全未落实 = rev2-flow I7）
v2 的全部验收 = 机械门 + 施工代理自验 + 回执自证。**43 块取舍与 `repl.py` 的人工融合（全轮唯一无机器门的步骤，已知不确定项 8）没有第二双眼。**

1. **触发时点**：S8 六道门全绿之后、S8.5 合回之前。
2. **审查者**：按老板流水线第 6 步「K3 + 0902 一起审」——
   - `bailian/qwen3.8-max-0902`：逐块复核 43 块的 diff 与回执（`/tmp/r3_conflict_receipts.md`），重点核「取了 theirs 的地方有没有吃掉本地独有资产」
   - `bailian/kimi-k3`：**窄镜头**复核 `repl.py` 融合段 + 第 17 步 `daemon-supervisor.ts` 的 7 块（全轮最难、互相依赖），以及 21 处块外破坏是否真修完。**禁止让它通读全部 diff**（它历史上长读码卡死过两次），配看门狗（jsonl mtime 5 分钟不动判死）。
3. **审查输入**：`git diff merge/repl-kernel..sync/upstream-r3` 全量 diff + 回执 + 已知红清单的消红证据。
4. **问题在分支上修，不传染其他车道**（老板流水线第 6 步原文）。
5. **老板流水线第 8 步的收口**：K3 复核全部 diff 通过后，本轮无算法/数学面改动，**deepseek 环节可跳过**（若 S7 的 #2027 迭代器改动涉及复杂度论证，则派 `bailian/deepseek-v4-pro-0813` 复核该处）。
6. **什么算过**：两个审查代理都回「无阻塞」，且每条阻塞/重要项都有「已修 + 复验证据」或「老板裁定不修 + 理由」。

### S8.7 【v2.2 新增 = p5 ⑤.3/⑤.4 裁定】铁律 6 响亮化的哨兵与边界
- **哨兵排给 p2**（它正在做 session-info-incremental-scan 哨兵，最熟悉这套）：落在 `test/agent-connection-daemon.test.ts`，断言「daemon 不广告 `agent_roster` 时 `attach()` 仍成功**且** agent 日志出现 `roster-attach: attach degraded:`」。现状该测试的 FakeDaemonClient `case "roster_subscribe"` 恒 `success:true`（`:403-404`）、4 条 roster 测试都 `serverCapabilities.add("agent_roster")`（`:900/:956/:1003/:1063`）→ p5 的 `attachRosterStore` helper 在现有测试里永远走成功分支、一次日志都不写，**无哨兵则日后改回静默吞不会红**。
- **裁定：残留三处 `.catch(() => undefined)` 不动**（p5 ⑤.4）：`daemon-agent-connection.ts` `[WT]:1603`（rosterStore.dispose）/`:1612`（detach）/`:2093`（void promise）都是 dispose/detach 的 fire-and-forget，**拆除路径不该因日志失败而失败**；铁律 6 的病根是「能力拒绝被静默吞」，不在此。理由记此，双审据此不判漏。
- **p5 ⑤.2 收口必看**：`[MT]:1683` 在**非冲突区**，p5 为铁律 6 动了块外代码（授权范围内）→ 收口 diff 会显示为块外 hunk，专门核这一处。

### S8.7b 【v2.2 新增 = p2 第二轮：负控方法论修正 + P0-B 证据链】
- **假负控警告**：「删类型字段」式红跑变异在 vitest/esbuild 下**不会红**（接口字段是纯类型，转译时被擦除，运行时零影响）。真正复现 P0-B 的变异是**去掉 resume 恢复**（`session-manager.ts:1144-1146` 改回官方三行裸声明）。**所有「先红后绿」负控的变异必须落在运行时代码上。**
- **P0-B 证据链已实测**（`/tmp/p2_vitest_red.txt`，S8.6 直接引用）：resume 增量 `cost 110 → 10` = 「passivate 那一刻 cost 往下跳」的最小复现；失败点 = 有 usage 之后的**第一次 resume** 就炸；**5 条既有 it 全绿** = P0-B 对修复前整个测试面静默的硬证据（此前只是推理）。
- **哨兵已落地并先红后绿**：`test/session-info-incremental-scan.test.ts` 新 it「reports the same usage totals on a resumed scan as on a full one」（三趟 append、每趟与冷读对账、usage defined 断言防全零假绿、**另加绝对值断言防「冷读与增量一起错一起绿」**）。md5 `69f876262e4cf71976c79e7593fe2b96`。
- **两条测试互补、缺一个都不完整**：官方 `file-operations.test.ts:593-655` 只走冷读全量（证明折叠算法对，**结构上抓不到 P0-B**——把 3 字段与恢复全删它照样绿）；哨兵只走 resume 增量（证明累加器进了 SessionScanState 并被克隆恢复）。**官方测试面结构上不可能覆盖 P0-B**（官方 `scanSessionInfo` 无 resume 参数，增量扫描是本地独有 `619144b6e`）。
- **盲区（与 p4 NC4/p7 同族）**：删「融合出的新形参」esbuild+biome 都 EXIT=0（`options_sem` 负控实测）→ 陷阱 4 的回归只有全仓 tsgo 抓得到。
- **【v2.2 再深一层 = p5 实测】有一类错误连 tsgo 都抓不到**：「三参外壳」类融合（形参在非冲突区、调用点也在非冲突区、只有中间透传在块内）。整取 ours 时 esbuild/biome/**tsgo 三者全绿**（形参可选、未使用不报错），但被透传的能力/防护**静默失效**（p5 案例：`requestData(..., undefined, options)` 在块内，整取 ours 则 #1909 死锁防护静默失效）。
  **判据**：不是「形参有没有被用」，而是「**块外调用点传了几个实参 ↔ 块内有没有透传到位**」。做法：对块内涉及的每个被调函数做**调用点实参直方图**（p5 的 `requestData` 59 处 = {1:49, 2:6, 3:4}、越界 0），再核块内透传与直方图的最大实参数一致。收口时 tsgo 之外必须跑这层配对，p3 块5 / p2 appendCompaction / p6 replayCache 是重点。p2 顺手跑了三条运行时证据：`file-operations` 39 passed / `compaction-branch-boundary` 1 passed / `tree-traversal` 31 passed（**注意 `compaction-branch-boundary` 两种签名形状都能过，它只判别 leafId 语义没丢，不判别 options vs 8 位置参**）。
- **变异恢复纪律（p2 示范）**：红跑进程一结束先恢复再看输出，写回变异前存的原始 bytes，md5 逐字节核对（变异前=恢复后=`c63fa33391ac53d6a0979bf4b8ec05b5`），index 从未被动。pristine 副本留 /tmp。

### S8.8 【v2.2 新增 = p5 ⑤.5/⑤.6 口径纠正】
- **p1 转的 6 符号清单不在 `daemon-agent-connection.ts` 的 import 面里**（p5 纠正）：该文件从 `daemon-protocol.js` 只 import 10 个符号且不含那 6 个；它唯一的冲突 import 块是 `agents-view/roster-store.js` vs `daemon/compact-session-stream.js`。那 6 个（`DAEMON_CONTROL_PLANE_COMMANDS`/`DAEMON_COMMAND_PLANE`/`isSessionPlaneDaemonCommand`/`missingDeclaredCommandCapability`/`DAEMON_DEFAULT_SERVER_CAPABILITIES`/`salvageDaemonCommandId`）的落点是 **`daemon-mode.ts` 与 `daemon-supervisor.ts`**。别照错清单核 A。
- **核查脚本 3 的「破口 0」不含 keybindings 面**：`keybindings.ts` 那条输出是 `-`（跳过）不是 `✓`，因为它是 `Record<string, Keybinding>` 无有限约束、本就不该做完备性检查（键=58）。收口时别把「破口 0」当已覆盖 keybindings。


### S8.9 【v2.2 新增 = p9 ④ src 层备案 + 根代理裁定】
- **S-1 裁定 = ① 认上游语义（现状）**：合并后 `handleList`（`daemon-supervisor.ts:2718-2748`）完全不向 worker 拉取、改遍历 `this.roster().values()`；HEAD 版本是先 `Promise.all(refreshWorkerSummaries(w,{omitStreamingMessages}))` 再读 `worker.summaries`。本地轴「客户端要 list 就拿一份新鲜的」没了，现在拿最后一帧 delta / 最后一次 pull 的 roster 快照（新鲜度靠 roster_delta 推送 + `scheduleRosterRepairPull` 兜）。
  **不补回 pull** 的理由：补回 = 每次 list 都拉 worker = 回到本地 `8981a31c3` 想消除的每秒兆级老路，且与上游 event-driven roster 推送模型打架。p9 已把新行为钉成 `expect(requests).toEqual([])` 正控。若日后发现 roster 快照新鲜度不够（delta 丢失等），是上游模型的问题，单独开工单，不在本轮。
- **S-2 备案（记 docs/fork/ 本地轴清单，v2.6 措辞纠正）**：休眠接缝指 **supervisor↔worker 尾参**（`refreshWorkerSummaries` 第 5 位，`:4157`/`:4174`，src 12 处调用无一传第 5 实参，`:4174` 只是内部 retry 透传），唯一撑着它的是 `daemon-supervisor-streaming-list.test.ts`。**客户端半边不是休眠**（`:1898` 活调用点）。将来任何「删无用参数」清理会连这条本地轴一起删。活路径仍在：`agents-view-mode.ts:229` 发 → `daemon-supervisor.ts:2734` 剥 / `daemon-mode.ts:3899` 剥。
- **S-3 备案（推广为 fake 标配）**：`chainWorkerRosterApply`（`:4445-4448`）把 apply 异常吞成一条 warn + 修复拉取、不外抛 ⇒ 任何 `Object.create(DaemonSupervisor.prototype)` 造 fake 的测试，fixture 少给成员时会**静默假绿**（apply 被判 not current → 直接 return → 所有断言照绿）。p9 已加 `expect(log).not.toHaveBeenCalled()` 当哨兵 → **推广为这类 fake 的标配**，记进 S8.6 双审要点。
- **S-4 无需动**：`daemon-agent-roster.test.ts:1496` 与 `daemon-supervisor-lazy-subagents.test.ts:22` 两处窄化声明是真签名前缀、位置参对齐，与 monitor 撒谎声明性质不同。
- **p9 挂起两条（等解冻）**：A-1 compactionLeafId 端到端回归（`grep -rln compactionLeafId test/` = 0）；A-2 replayCache 两条（`test/rlm-ledger.test.ts` 里 `cache|Cache` = 0）。merge commit 落地后解冻。

## S9 · 文档回写
1. `FORK_NOTES.md`：加 R3 节（同步了什么、丢了哪些本地实现、schema 四层撞号的由来与解决、S8 的已知未覆盖面）。
2. `docs/fork/audit-findings.md`：更新 PR 裁定台账 + 记本轮校准教训（见下）+ 本轮新增的 fork 独有缺陷（P0-A / P0-B / H1 / 陷阱 0 / 陷阱 4 / 块外 21 处）续 F 编号。
3. `README.md` 的「这个 fork 改了什么」表格：**7 行不是 6 行**，拆成 12 条子项后 —— 6 条真独有零冲突存活、2 条手工融合/移植、2 条被官方架构级吸收应丢、1 条部分吸收需拆（= S3 表第 5 行，**v2 已改判为保留 worker 半边**）、**1 条已过期**（`syncAgentPeers`「名单没变不重发」在本地 HEAD 里已被 `bf542ce7e` 删掉，src 零命中）→ 必须修表格。
4. **记进下一轮自修清单（本轮不做）**：上游 main 有既存 **@types/node split-brain** —— lock 里 **4 份**（root `22.20.1` + undici `6.21.0` / 三个子包 `24.13.3` + `7.18.2`），而 `tsconfig.base.json:21` 是 `types: ["node"]` → **`npm run check` 按 Node22 检查全部源码、`npm run build` 按 Node24**。fork 可自修对齐到 CI 实跑的 22.x，不必等官方、与 Bun 线无关。本轮不碰，避免与 deps 面纠缠。

## 裁定项（10 条，需老板确认；不反对则按推荐执行）

| # | 分歧 | 推荐 | 理由 |
|---|---|---|---|
| 1 | `DAEMON_PROTOCOL_VERSION` 留 7 还是升 8 | **留 7** | 双方都是 7；官方新命令走 `minProtocol: 7 + capability` 门，本地 `declare_client_capabilities` 也是 capability 门 → 符合 AGENTS.md「新增可选特性走协商能力」口径 |
| 2 | revision 27 后闸号重编号规则 | **官方新增保留原号；本地独有不动** | rev-exec 实测工作面只有 5 处（S5.2 第 5 点），且「本地新增用 27」本轮**不需要用** |
| 3 | `wait_for_headless_completion` 算只读还是 mutating | **断言跟实现**，删官方那条 `toBe(true)` | 实现侧本地已赢：合并树 `READ_ONLY_DAEMON_COMMANDS` 含它；官方 `[UP] test:364` 那条 `toBe(true)` 与之矛盾（rev-facts 已复核成立） |
| 4 | `omitStreamingMessages` 客户端半边是否删 | **删客户端半边，worker↔supervisor 半边改造后保留** | **v1 判「整体丢」是错的**（S3 表第 5 行，BL2）。客户端半边已成死代码；worker 半边官方 0 覆盖 |
| 5 | 直连路径上 streaming delta 被官方有意关掉（`emitDirectOutbound` 只收 jsonl，别的直接 destroy socket）是否接受降级 | **接受**，记进 fork 文档 | 官方 #1926 的设计意图，不是遗漏 |
| 6 | `LIST_WITHOUT_STREAMING_MESSAGES_COMMAND` 的 `minSchemaRevision: 24` 是否重编号（官方 24 = roster 订阅，双向假阳性） | **不改** | 双重保护都不依赖数字：服务端 `meetsDaemonCommandCompatibility` 还要 `serverCapabilities.includes(...)`；客户端 `[UP] agents-view-mode.ts:229` 发字段前先 `supportsServerCapability(...)`。重编号更整齐但会收窄 merged client 对官方 26 daemon 的兼容性——而那种组合本来就被 schemaId 等值比较判 stale 替换 |
| 7 | #1885 / #1984 / #2021 / #1987 / #1957 族怎么处置 | **全拿 + 修两处性能白付** | S7.6。#1987 绕不开（实测 import）；revert 三个交织提交风险更高；#2021 还兼修 compaction slices 与 daemon subagent lineage |
| 8 | **铁律 2 到底跑哪条命令** | **待老板点名** | 「全量常驻回归套件」在本仓**没有对应命令**，且与 `AGENTS.md` 的 "NEVER run npm test" 表面冲突。裁定前按「受影响面 + 每阶段一次全量」执行。**这笔机器时间必须进预算**（385 个 `.test.ts` × 15-25 次提交） |
| 9 | **脏树处置**（S0.1 三选一） | **(c) 独立 worktree** | 代价是撞点转移到 S8.5，且需接受 S0.2 的 pi-ai 降级 |
| 10 | **本轮范围**（pi-ai 降级部分已由根代理自决，见 S0.2/S5.4） | **待老板拍：投 90h+ 做完整轮，或本轮不做** | **「做一半」在技术上不存在**（rev2-flow B1 四层反证，见「工期与范围」节）。merge 是原子的，留文件不解 = 无法提交；半合并状态下 agents view 确定性打不开、S8 门 5 必红、下轮冲突上下文被 git 永久翻篇 |

### 裁定 10 附带：本轮范围与工期（**唯一真正需要老板拍的一条**）
**v2.1 工期上修：按 90h+ 报**（rev2-flow Q6 判 87h 上界不保守：第 17 步 7 块互相依赖、返工概率高，且 v2 漏了 S8.6 双审与核查脚本 1/2 的实现时间）。
分解仍是 **61.5-87h**（去掉 S7 = 53.5-73h），加上 S8.6 双审（4-8h）与脚本 1/2（~3h，脚本 3 已由根代理实现）→ **约 70-98h**。

**且「缩范围」这个选项已删除**（B1）：不存在"做一半"，只有"做完整轮"或"本轮不做"。

v1 的 26-30h 不可信，三个原因：
- (a) 那个数自己就对不上：lane D 的阶段表 25.5h vs 它自己的逐文件表 27.9h，加 20% 缓冲应是 ~33.5h
- (b) 26-30h 只覆盖 S1 解冲突，不含 `interactive-mode.ts` 深审、不含 S7、不含批 0/批 1
- (c) **铁律 2 的机器时间一分没算**（385 个 `.test.ts`，15-25 个提交 → 15-25 次全量；哪怕一次 20 分钟也是 5-8h 墙钟，且铁律 4 要求配看门狗 = 不能并行干别的）

最可能超的四处：① **第 17 步 `daemon-supervisor.ts`**（lane D 估 5h，rev-exec 判 **8-12h**：7 块全轮最多 + 116 行 ours + H2 的 12 处调用点分两类 + H11 两孤儿声明 + omit 尾参改造 + #1929 的 HEAD-only 67 行块 + 签名统一，**互相依赖，任一处返工都要重跑该文件编译**）② 铁律 2 机器时间 ③ S7 零估时（**8-14h**）④ Z7 的脚本重写（原零估时，2-4h）→ **第 3 条已完成，剩第 1、2 条约 3h**

**【v2.1 删除】「缩范围方案」在 git / 编译 / 运行时三个层面都不成立**（rev2-flow B1，阻塞级，根代理已复核）：
1. **git 层**：S1 是**一个 merge commit，中途没有提交点**（附录 §5.10 自承）。留第 17 步 `daemon-supervisor.ts` 与 `agents-view-mode.ts` 不解 = **无法提交**；唯一能落地的做法是整块取一边，**直接违反铁律 1**。
2. **运行时层**：`[HEAD] daemon-supervisor.ts` 对 `roster_subscribe` **0 命中**，而 `[UP] roster-store.ts:30` 有 capability 门 → `attach()` 返回 false → `[UP] agents-view-mode.ts:2429` throw → **agents view 确定性打不开**（不是 v2 原写的"可能不可用"，是亲手重建了 P0-A）。
3. **验收层**：缩范围自列的 S8 门 5（agents view 能打开）**必红** → 本轮永远收不了口。
4. **下轮层**：若用占位提交先把 merge 落地，下轮再解，那 7 块冲突的上下文会被 git **永久翻篇**（diff3 基准丢失）。
→ **裁定 10 塌缩为一个二选一：投 90h+ 做完整轮，或者本轮不做。** 不存在"做一半"。
（工期口径同时上修：rev2-flow Q6 判 87h 上界不保守，**建议按 90h+ 报**，因为第 17 步 7 块互相依赖、返工概率高。）

## 上轮判定校准（S9.2 要写进 audit-findings）

**核心归因（lane B，比 v1 更准）：上轮偏差主要是「漏扫」不是「判错」** —— 这 30 个"新 PR"里有 **17 个在 2026-08-29 审计日之前就已存在**（sethkarten 08-10 同日开的 5 个 v0.8 栈、kevinjosethomas 4 个老 PR、5 个 dependabot 08-20 同批）。
**且上轮 TAKE 的 9 个本轮无一反证 → 判据可靠的是 TAKE 半边，SKIP 半边才是漏扫重灾区。**

上轮 SKIP 的 5 条已被官方合并：
- **#1885**：官方已合 `1768ace56`。**但 lane A 的二轮评估推翻了「白拿」结论**：上轮"+2308 新子系统"的行数论证不成立（实测生产码约 900 行、测试占 67%、单提交只冲突 `agent-session.ts` 1 个文件、15 hunk 里 7 个重叠但仅 2 处需人脑）；真理由是 #1984 注释原文 `no delivery endpoint exists yet`（无消费者）+ 每请求 `JSON.stringify`+`sha256` 与 2 次同步 `appendFileSync` 正对本地主权区 + #2028 仍是 open PR。**最终裁定见 S7.6：全拿但修两处白付。**
- **#1842**：官方已合，**本地已吸收**（`bab124212`）。但要记一笔：上轮判 SKIP 的同时，本地 F1/F43（`d9364b034`）在治同一族「队列状态」问题 —— **等于自修了一个官方已给答案的东西**。
- **#1864**：官方已合，而且**它就是本 fork 的分叉点** `5b6c0e94e`，本地 F16 已依赖它。上轮 SKIP 名单里混进了「本地其实已经依赖」的条目。
- **#1631**：官方已合 `083c68dc0`。与本地 update-restart 家族（F38 `e5eea4a6b`、F66 `f384214e3`）同区，同步后要单独跑 `test/interactive-update-relaunch.test.ts`。
- **#1633**：被 #1928 的 body 明写 `Supersedes #1633` → 作废。
另 #1756 / #1845 / #1859 / #1882 也已双向落地（本地 `ee8fd6996` / `c0334a176` / `dab03c00c`）。

**流程要加三步**：
1. 判 SKIP 前先跑 `git log --grep "(#N)"` 查它是不是已在本地/上游历史（**#1886 靠这一条直接出局**）
2. 判 SKIP 前先查它是不是官方演进链的**基座**（可查信号：作者是否 staff —— 本轮 `sethkarten`/`snimu`/`kevinjosethomas` 三人包了大部分基座 PR）
3. **「base 不是 main」应作第一道筛子**（本轮 5/9 巨型 PR 的 base 是未合兄弟 PR，4 个 perf sha 对本地 `--is-ancestor` 全 NO）
另：**「+N 行新子系统」不是 SKIP 的充分理由**（#1885 是反例）。deps 类还有一条：**跟任何 bump 前先查「今天合规的最新版本」，别照抄 PR 的目标版本**（#1582 与 #1579 都吃了这个亏；#1579 现在应改拿 `marked 18.0.10`，cooldown 证据：18.0.10 发布于 08-18，PR 创建于 08-20，只 2.02 天被挡 → dependabot 退到 18.0.9）。

## 已知不确定项（施工中要消解）

1. `interactive-mode.ts`（359KB，双方各 24-30 hunk，函数级映射失效）**未做同深度诊断**。本轮按自动合并结果走，S8 单独跑其测试族。
2. P0-B 的两个数组累加器（`attributedChildUsages` / `summarizationUsages`）在 grow-only 语义下是否需要拷贝，**未实测**，按 S2.2 第 3 点评估。
3. #1947 与本地 F27 内存修复是否互斥，**未实测**。
4. S7.6 的 semantic-edge recorder **默认开关状态未查**；多子代理场景的 CPU/IO 放大**未实测**。
5. `#1389` 已知 CONFLICTING 的成因是 schema 20 vs 26，本轮升 27 后**需重新复核**可合性。
6. 三个核查脚本要新写（附录 §5.11 只有规格），**脚本自身未经验证**。
7. 第 17 步 `daemon-supervisor.ts` 的 7 块互相依赖，**返工概率高**，估时区间 8-12h 可信度低。
8. ~~`repl.py` 没有可执行的验收门~~ **【v2.2 已解除 = build-stage-a 实测】**：门是 `uv sync --group dev && uv run --with pytest pytest test/test_repl.py -q`（**必须带 `--with pytest`**，否则穿透到 homebrew 的 pytest、缺 dill、假红 40 条）→ 实测 `100 passed, 2 subtests passed`。且那 100 个测试是本地针对 ours 架构写的、在融合实现上全绿 = 融合正确。人工核对降级为额外保险。
   **遗留缺口**：ours 的 4 行硬化（fsync/fchmod 0600）在 Python 侧零测试覆盖，进 S9 audit-findings。

### 已由审查消解的不确定项（不要再当未知处理）
- ~~官方 90 条 changelog 中「代码本地已有」的条数~~ → A 组 29 / B 组 32 / **C 组 29 真缺**（S6.2）
- ~~81 个碎片哪些该删~~ → **merge 静默删 33（31+2）**，本地独有须留 **70** 个（= 103 − 33），0 个部分重复（S6.5）
- ~~#1882/#1700 是否去重场景~~ → **不是**，官方合并早于分叉点，实测零差异（S6.3）
- ~~#1987 能否绕开~~ → **不能**，且 v1 的「二选一」是伪二分（S7.6）
- ~~schema 哈希公式~~ → 已复现两侧当前值 + 分叉点值，脚本在附录 §5.2
- ~~schema 撞号是几层~~ → **四层 23/24/25/26**，23 号上一轮已解过一次（S5.1）
- ~~`declare_client_capabilities` 归 control 还是 session~~ → **两端都处理，定死 `"control"`**（S2.3 / 附录 §5.5）
- ~~版本号要不要单独工单~~ → **不要，merge 自动带入，改为核实门**（S5.3）
- ~~本地独有测试是 49 还是 54~~ → **54**，含 3 个 `node:test`（S4 / 附录 §5.9）
- ~~P0-A 修法~~ → **v1 与两个审查代理的方案都被否，采 rev-exec §5.3 的三处联动**（S2.1）## S7 收工记录（v2.5，p11 交活）
4 个 commit：#2027 `ebb26a3ac`（3 文件 +167−92 与上游逐文件一致，1 块冲突 4 it 全留 theirs 前 ours 后）／#1947 `7f5e1ba3a`（5 文件 +164−17 = 上游 +140−17 + 0600 适配 24 行）／#1896 `b20f16427`（8 文件 +235−13 = 上游 +220−12 + 适配 A(+3−1) + B(+11) + 碎片(+1)）／碎片合规 `7a6e74c57`（docs only，未 amend）。
三个 PR 关键文件合并结果与 merge-tree 预判 blob **sha256 逐个相同**。回归全绿：#1947 24/24、#1896 agent 76/76 + coding-agent 618/0（扣 1 假红）+ 4509 38 全绿 + recursion 119/119、#2027 74/74。**S7 零回归**（build-stage-a 独立重跑 45 文件 1025/0 + agent 76/76 对齐）。
**碎片偏离处置（p11 按 AGENTS.md:121 自行纠正，可一键翻回 `git revert 7a6e74c57`）**：我点名的独立碎片 `empty-final-turn-retry.md` 会与上游自带 `empty-turn-retry.md` 同包撞「One fragment per PR per touched package」→ bullet 逐字追加进上游自带碎片（现 2 条 bullet）+ docs-only commit 收口。
**追认（K3 rev3-logic 独立证明）**：`bdd5bcd82` 的双守卫（`agent-session-services.ts` + `agent-session.ts:1361`）**必要且是最小面**——只守 services → recorder 仍写 ledger；只守 recorder → outbox 被写指向不存在文件的 entry（登记本身即盘写，`agent-traces.ts:1096-1098` 无 sessionFile 式守护）。build-stage-a 扩到我原裁位置之外是正确的偏差，追认。
**p11 撤回并记全局 memory 的教训**：它先前报的「12 条既有红」100% 是 env 假红（`RLM_DEPTH=2` 直接改变被测递归深度、`PRIME_AGENT_INTERNAL_*` 指向自己会话文件、第二条假红来自它自己设的 kernel pin）。判据：「失败原文里出现你自己会话的 env 值/路径 = 假红」；「跨 env 推断既有红一律无效」。
**适配 B 的行号重新定位**：任务书给的 interactive-mode.ts:5526/5796 是合并前基准，合并后该文件被双方各 24-30 hunk 改过、函数级映射失效 → p11 重新定位到 :5871。S8 若复核适配 B 以 :5871 为准。

## S9 裁定补充（v2.6，p10-docs 交活后）
- **D10 裁不改**：README NOTE 与 `git clone -b fix/subagent-storm-and-cjk-lag` 的对外分支口径（实际施工在 merge/repl-kernel → sync/upstream-r3）= 发布策略，超 S9 范围，记下轮由老板定。
- **追认 p10 两处主动改**：README 首句版本口径（→「已同步到 0.9.x（upstream d74a75fea）」）+ audit-findings 的 F5/F6 从 `[ ]` 改 `[x]`（代码证据 96d3db580+7efe4b467+6e86b3929+测试 6b8d2585b；现行落点 daemon-supervisor.ts:1825、daemon-mode.ts:3655、控制面分流 :3558）。回滚把手在 p10 回执 §11。
- **门口径补充**：biome 对 md 文件是 `Checked 0 files`（md 不在 files.includes）= 预期空跑不是绿，别当门引用。
- **p10 给下轮 S9 的建议采纳**：文档车道应最后开工或持 freeze-sha 清单，commit 前重跑 `git log <freeze>..HEAD` 核新增提交是否影响自己写的句子（它第一趟「#1896 未摘」当场过期，3d08ef7aa 回填）。
- **新 S9 待办（build-stage-a 从 K3 证据挖出，本轮不动）**：`agent-traces.ts` persist 钩子里 sessionFile 条有 `sessionFile &&` 守护（:1090-1094）而 ledger 条没有同类守护（:1096-1098）= 上游侧对称缺口；任何新调用点忘记传 undefined 就会重现 bdd5bcd82 修的同一个 bug。修法会碰官方模块，下轮单独开工单（不改 schema digest，agent-traces.ts 不在三个切片里）。
- **rev3-facts（0902）双审完成：阻塞 0 / 高 0 / 中 2 / 低 3**。核实通过：#2027 无损双向证明（diff(PR head, fork 摘取后) 745 变更行 == diff(base, fork 摘取前) 745 行保序全等 ⇒ fork 文件 == 上游 PR 文件 + 恰好原有 fork delta；4-it 全留 + theirs 前 ours 后坐实）；#1947 删除行 16/16 保序逐字全等、fork 独有 27−3=24 精确闭合；S5 digest 重算 + 三基线复现；红#5 双守卫「必要且同向加严」；p9 4 commit numstat/md5 全中；S6 `9ee1ea51c` 是 `ea68ff750` 的字节级精确逆（+ 行序列与 − 行序列 4/4 文件保序逐字相同）。
- **build-stage-a 重-1 处置完毕 + 核可它第二次改我措辞**（表头不照抄「抽样 10/10」，按全量校准实况写「13 条独立把手 10 OK / 2 行号错 / 1 区间偏移」；全量校准结果恰好 K3 抽样那 3 条、无第 4 条，它的外推担心撤销）。
- **新发现（比 :N: 更危险的锚，已列 S9 待办 12-14）**：`git show HEAD:<path>` 是**静默失效**锚（不报错、静默返回错内容；写作时点 HEAD=0c504e475，merge 后 HEAD=3d08ef7aa，同命令返回不同 blob）；`:1:/:2:/:3:` 失效会 fatal（响亮）而 HEAD: 不报错。全扫 13 份源回执：`HEAD:` 14 处（build-stage-a 6 / p9 5 / p7 2 / p4 1）静默失效、`MERGE_HEAD:` 1 处 fatal、`upstream/main:` 5 处仍有效。S9 待办新增：12 把手 sed 行号必须与它自己的 git 锚同基准并标注基准；13 翻回把手一律写显式 sha 禁写 HEAD/MERGE_HEAD/:N:；14 自动校准两陷阱（探针照抄原文且大小写敏感、区间类把手同时验首行否则抓不到 OFFSET）。
- **rev3-logic 补发 重-1（重要非阻塞，已列 S9 待办）**：旁挂把手的 sed 行号参数抽样 10 条实测 3 条取不到声称内容（p1 dp块1 :2: 89-90 拿到类型行而常量在 86-87；p3 sup块2 :2: 375,376 拿到 client/activeSessionId 而字段在 316-317；p3 sup块3 :2: 2229,2264 区间截断而 handleList 实际 2248 起）= 写作时点即错（把 [MT]/[WT] 基准行号套到 :2: blob），与 stage 锚失效无关。不定阻塞因三条错把手自带 grep 验证门会立刻红、不静默不丢资产；但铁律 15 字面落空 + 抽样错误率 3/10 ⇒ 43 块可能有同类未扫（集中 p1/p3 的 sed 把手）。处置：build-stage-a 把「sed 行号对解析后 blob 实跑校准」并进旁挂把手生成脚本（/tmp/r3_build_handles.py 重跑），S9 待办列「把手行号一律对解析后 blob 校准」。
- **中 M1 纪律**：审计期间 HEAD 动 4 次，复测结论不受影响，但「当前 HEAD」类判据必须钉 SHA（总账/回执已钉 c92e7e0d9 / 3d08ef7aa 复测同样成立）。
- **中 M2 基线标注**：S6 招牌数字被后续车道合法推高——终态 **75 碎片 / 94 bullet**；`release.mjs patch --dry-run` 实跑 = **112 bullet / 0 重复 / 88 碎片待 rm / EXIT=0**（DRY_RUN 分支在 stage/commit/publish/push 之前 exit(0)，跑完 status 0 行）。总账若把 107 当「下次 release 行数」会差 5 条 → 总账补基线标注（107 = bdd5bcd82 时点；112 = c92e7e0d9 终态）。
- **程序追认已补（供总账定稿）**：bdd5bcd82 双守卫必要且最小面，定案理由采 K3 两条读码证据（只守 services 不够因 `_loadExisting`/`_append` 只在 `_ledgerPath` 真值时跳过；只守 recorder 不够因登记动作本身就是盘写）。
- **D3 澄清**：删 `rlm-ledger.ts:730` 的 src 负控由 build-stage-a 在 scratch worktree 做了（Run 1 只变异 src → 白盒腿红吐真缓存对象；Run 2 src 变异+删白盒断言 → 30 passed = 行为腿观测不到 :730）；p9 的 MUT-①/② 是改测试自身的等价物。p10 的 local-axes §四.4 漏了 scratch 实验，已澄清。


