# r32 扫描——模型可见面第三轮（model-visible）

冻结 SHA：主仓 HEAD `7e9ae6e33`（merge/repl-kernel）。工作树 `/tmp/audit_r/round-32/wt_model`（detached，symlink node_modules，零提交零回写）。判据基线：`docs/fork/audits/decisions.jsonl`（266 条，全量比对去重）。

本轮四问与结论一览：
- ①注入提示 vs 运行时：**MVS-1（P2）** `os.environ[...]`→`bash()` 的教学句在 r28 BSH 剥离后成为谎言；**MVS-2（P4）** compact.run 回执的指令承诺被手动 /compact 抢跑后静默丢失。
- ②上下文组装：**MVS-3（P4）** `<ipython_state>` 不属 machine-block，二次压缩后陈旧名册折进叙事；MV-4/LAT-3/FR-5 的 r24-r31 修复本体复验均成立（正控）。
- ③错误可行动性：PASSTHROUGH 出口在**任何**模型可见面（提示词/工具描述/错误文案/SKILL.md）零出现——答案是否定的，见 MVS-1。
- ④工具结果诚实面：截断与超时标记全部诚实（正控 4 处）；唯一不诚实面是 env 剥离不可分辨（MVS-1 的第二面）。

---

## MVS-1（P2）REPL 提示教学的 `os.environ`→`bash()` 通道在 BSH 后是假话；出口零模型可见

**宣称**（模型逐字读到）：`packages/coding-agent/src/core/prompts/rlm.ts:60`（REPL_CONTROL_PROMPT）：

> "Each `bash()` call is its own process, so shell state does not persist between calls; use `os.chdir(...)` for the working directory and `os.environ[...]` for environment variables — both persist in the REPL and apply to later `bash()` calls."

**运行时**：`prime-agent-runtime/src/rlm/bash.py:782-830` `_CHILD_SAFE_ENV` 28 键白名单 + `_passthrough_env()`；同构副本在 `packages/coding-agent/src/utils/shell.ts:160-204`（`SHELL_CHILD_SAFE_ENV_KEYS` + `SHELL_ENV_PASSTHROUGH_VAR`）。非白名单键静默丢弃。

**红证（活体 kernel，本机 installed build + 冻结源码一致）**：
```
os.environ['AUDIT_R32_VAR'] = 'seen-by-child'
await bash('echo "child sees: [$AUDIT_R32_VAR]"')
# → "child sees: []"   exit_code=0
os.environ['PRIME_AGENT_ENV_PASSTHROUGH'] = 'AUDIT_R32_VAR'
await bash('echo "with passthrough: [$AUDIT_R32_VAR]"')
# → "with passthrough: [seen-by-child]"   （出口存在但模型不可知）
```
`os.chdir` 半句仍真（bash.py spawn 时 `cwd=os.getcwd()`）；`os.environ` 半句对 28 个白名单键（PATH/HOME/TZ/LC_ALL/…）仍真——**部分成功恰好给模型提供了确认假话的证据**，其余全静默失败。

**"模型会因此做错事"的具体输入**：
1. `os.environ['NODE_OPTIONS']='--max-old-space-size=8192'` → `bash('npm test')`：子进程没带该 flag，跑完的测试结果被模型错误归因（"8GB 也 OOM？内存泄漏！"）。
2. git push 被拒后模型自愈：`os.environ['GIT_SSH_COMMAND']='ssh -i /tmp/key'` → `bash('git push')`：同样被剥，auth 继续失败，模型得出"密钥无效"的错误结论并换钥匙重试。
3. `os.environ['CI']='true']`/`DATABASE_URL=...`/`PYTHONPATH=...` 全部同型：exit 0 + 空/异常输出，**无法区分"命令失败"与"环境被限制"**（④问的直接答案）。

**③问的答案（PASSTHROUGH 提示在错误里给出没有）——没有**：`grep PRIME_AGENT_ENV_PASSTHROUGH` 全仓（src+skills+prompts+docs）命中仅 `shell.ts:190`、`bash.py:813` 两处实现与测试；提示词、bash() docstring、classic bash 工具 description（`tools/bash.ts:365`）、SKILL.md、任何错误文案均零出现。BSH-4 只修了 `docs/security.md`（人类面），模型面从未跟进。`bash('FOO=1 cmd')` 前缀赋值这条真实出路也无人教。

**为什么 r12 的"现实闸"没拦住**：`test/prompt-command-reality.test.ts` 本轮实跑绿（8/8，`env -u RLM_* node ../../node_modules/vitest/dist/cli.js --run`，1.9s）：它只对 backtick 里的**命令**做替换实测，且用 `spawnSync('/bin/bash', ['-lc', run], { env: {...process.env, VIRTUAL_ENV: ''} })`——登录 shell + **完整宿主 env**，不是 kernel `bash()` 子进程的 `_child_env()`。env 契约整个在闸外，所以 r28 改 BSH 时这句话必然漏检。

**修法方向**：(a) rlm.ts:60 改真话（白名单语义 + `bash('VAR=v cmd')` 前缀 + `PRIME_AGENT_ENV_PASSTHROUGH` 出口）；(b) prompt-command-reality 补一条"env 宣称"现实测试，子进程 env 按 `_child_env()` 同构构造（或直接经 kernel 跑探针）；(c) bash() docstring 补一句剥离语义。**不修**错误文案侧（失败命令的输出属命令本身，往里塞提示会污染诚实面）。

**去重**：BSH-1/2/3 是路由/DNT/钉子键转发问题，BSH-4 是人类文档；MV-1..6 是 harness 注入面；均未覆盖此提示句与模型侧出口可见性。新条目。

## MVS-2（P4）compact.run 回执承诺的指令被手动 /compact 抢跑后静默丢失

**宣称**（三处一致）：`agent-session.ts:3922` 回执 "Compaction runs when the current turn ends; you resume automatically afterwards."；compact SKILL.md "calling `run` again before the turn ends only updates the instructions"；`_runAutoCompaction`（agent-session.ts:11528）注释 "**Any compaction consumes a pending model request and honors its instructions**"。

**运行时**：手动路径 `agent-session.ts:10086` 成功后 `this._pendingRequestedCompaction = undefined`——请求被"满足"，**指令不并入**本次手动压缩的 `customInstructions`。slash `/compact`（agent-session.ts:8424）与 SDK（:11950）都直达此路径。

**具体输入**：模型长任务中 `await compact.run("keep the failing test names and the migration checklist")`（scheduled:True），用户随后敲 `/compact` → turn 被 abort、以用户（或空）指令压缩 → 模型 resume 后拿到的摘要恰好丢了它点名要保的内容，且无任何"你的请求被另一种方式满足"的告知。与 K3R-7（manual×manual 不同指令排队）、K3R-11（manual 抢 auto 时保住排队续跑）形成第三种组合未覆盖。

**测试现状**：`suite/agent-session-compact-skill.test.ts:256` "clears a pending requested compaction when manual compaction succeeds" 把清除行为固化成预期，但该用例 `compact.run` **不带指令**，指令丢失子路径零断言。修法：手动 compact 成功时把 `pending.customInstructions` 并入（或至少在 resume 消息里告知被丢弃）。

**去重**：r25-1/K3R-7/K3R-11/FR-4 均为互斥与续跑语义，无指令丢失条目。新。

## MVS-3（P4）`<ipython_state>` 通知不属 machine-block：二次压缩后陈旧内核名册折进叙事

**事实**：machine-block 保护名单仅 4 个 tag（`compaction/machine-blocks.ts:47` `read-files/modified-files/fact-appendix/user-requests`）；`<ipython_state>` custom message（agent-session.ts:9829-9838）走 `compaction.ts:119-120` `custom_message → createCustomMessage` 进入压缩输入，无 display 过滤。压缩 #2 时，#1 的 `<ipython_state>`（"These names are still defined: A, B… Variables above the limit were removed: X"）要么整条留在 keepRecent 窗口（两代名册并存），要么被摘要器复述成叙事（无 byte-stable 保护，可失真/过时）；随后新鲜 `<ipython_state>` 再追加。`<ipython_state_restored>`（restore 面）在 restore+compact 循环后同理并存。

**具体输入**：压缩 #1 后模型删了变量 A 定义新变量 Z；压缩 #2 后摘要里"names: A,B"（陈旧）+ 尾部 `<ipython_state>`"names: Z"；随后 restart+restore 失败（DAT/K3P 系故障面）→ 模型按摘要先试 `A` → NameError，浪费回合且归因困难。危害有界（新鲜通知在尾部、live kernel 才是权威），P4。

**修法方向**：把 `<ipython_state>`/`<ipython_state_restored>` 纳入 machine-block tag 家族（render/strip/parse 三件套已有基础设施），或压缩输入侧对这两个 customType 直接丢弃旧代（名册每次全量重写，旧代无保留价值）。

**去重**：FR-5 是快照写失败文案的条件化（本轮复验成立）；LAT-3 是 child_usage_attributed 落盘合并（不入模型上下文，context-tree.ts:159 只算 usage）；均不同。新。

---

## 正控（r24-r31 修复复验成立，防"全盘怀疑"）

- **FR-5**：`kernel/state-snapshot.ts:118-180` `compactionKernelStateLines` 三分支（null 写、无快照机、pruned/skipped）全部条件化，无"persisted through compaction"无条件句。REPL_CONTROL_PROMPT 的 "16 MiB" 与 `DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024` 一致。
- **MV-4**：`ai/src/providers/transform-messages.ts:69-97,232-244` aborted assistant 保留文本 + `[assistant turn aborted: <cause≤200cp>]` 有界 trace；纯流式中断不再蒸发。
- **LAT-3**：`session-manager.ts:79` 每子一条合并行；`context-tree.ts:159-180` 只作 usage 折算，不进模型上下文。
- **MV-2/MV-3/MV-1**：`refinement.ts:755`（store 前缀语义）+ `harness.py:918` `overview(max_entries_per_kind=…, global_=…)` 实收参数并输出结构化行（活体验证：本会话 1035 memories 的 overflow hint 指向的调用形态真实存在）。
- **BSH-1/3**：`SUPERVISOR_SOCKET`/`ACTIVE_SESSION_ID`/`CODING_AGENT_DIR`/`SESSION_DIR`/`REGISTRY_DIR` 均在两侧白名单（shell.ts:176-180 / bash.py:801-806）。
- **④截断/超时诚实面**：kernel bash() head+tail 截断带 `... [N bytes dropped] ...`（bash.py:103-107）；REPL stdout 截断带 `[... output truncated at N chars ...]`（repl-manager.ts:2125-2128）；exec.ts `[Output truncated: showing last …]`（:110-115）；classic bash 工具超时文案给出再跑指引（tools/bash.ts:478-487）、`Full output: undefined` 谎言已修（:447-448）。均诚实。
- **①其余宣称抽查一致**：Pre-installed 12 包活体全 import 成功；rlm.collect 六字段（terminal_kind/stall_abort…）与 `rlm/__init__.py` dataclass 一致；refine.run/compact.run "never runs mid-cell" 与 host_request 实现一致；agent-message 回执 deliveryStatus/delivered/queued 与 SKILL.md 一致；16384 超长错误自带数字可自修。

## 验证记录

- 活体红证：本 kernel `bash()` 两次（上见 MVS-1）；出口探针正控一次。
- 仓内测试：`prompt-command-reality.test.ts` 单文件 8/8 绿（`env -u RLM_* -u PRIME_AGENT_KERNEL_PYTHON -u PRIME_AGENT_BASH_SHELL node ../../node_modules/vitest/dist/cli.js --run`，1.9s，EXIT 0）——绿即证明闸的盲区，非本仓缺陷修复轮。
- 主仓只读，零 git 写入，工作树仅 symlink node_modules。

## 建议入账（decisions.jsonl 候选）

1. MVS-1 P2（BSH×提示词互斥未同步：os.environ 教学句谎言 + PASSTHROUGH 零模型可见 + reality 闸 env 盲区）
2. MVS-2 P4（manual compact 丢弃 pending 指令，与 auto 路径"honors its instructions"注释矛盾）
3. MVS-3 P4（ipython_state 不属 machine-block，陈旧名册入叙事）
