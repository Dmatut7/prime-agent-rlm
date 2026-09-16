# impl-rt5 — RT-5 修复交付（round-36）

冻结 SHA `89260d029a24b0fefea9419b280aba5f8c4bcb18`（主仓只读，零写入）。施工在独立工作树
`/tmp/rt5_wt`（`git worktree add` + symlink node_modules），交付提交 `3d0a7d764`
（在其上）。运行时验证用工作树自带 editable venv（`/tmp/rt5_wt/prime-agent-runtime/.venv`，
dill 0.4.1，Python 3.12）+ `PRIME_AGENT_KERNEL_PYTHON` 指向它。

## 修了什么

### ① 技能模块包装 6 条（`packages/coding-agent/src/core/tools/ipython.ts`，bootstrap Python 代码）

| 项 | 修法 |
|---|---|
| F1 跨技能引用拿 raw module（`await A.B()` TypeError） | wrap 时注册 `_PRIME_AGENT_SKILL_WRAPPERS`（raw module → wrapper，键即模块对象本身，防 id 复用）；import 循环后跑 `_prime_agent_repoint_cross_skill_references()`，把每个 wrapper dict 里指向 raw skill module 的属性换成 wrapper。函数 global 名（F2 重绑后同 dict）一并修好 |
| F2 浅副本双 dict（`global` 重绑不可见） | `_prime_agent_rebind_function_globals`：wrap 时把**本模块定义的**模块级函数重建为 `FunctionType(code, wrapped.__dict__, …)`（带 closure/kwdefaults/annotations/qualname），`A.run.__globals__ is A.__dict__` 成立；从其它模块 import 的函数不动（仍指其定义模块的 dict） |
| F3 reload：`__signature__` 陈旧 + `reload(A.B)` 反向 ImportError | `__signature__` 从实例属性改为类级 property（每次按当前 `self.run` 现算，reload 后即新）；`A.B` 经 F1 fixup 变成 wrapper 后 `importlib.reload(A.B)` 直接可用（wrapper 在 sys.modules 里，身份检查通过） |
| F4 失败技能三路径三错 | 失败时把 `_PrimeAgentUnavailableSkill` 同时塞进 `sys.modules[name]`（import/from-import 绑定 stub）；stub 加 `__getattr__`，除 import 机制探测的 `__path__`/`__all__` 外一律抛同一条带技能名的 RuntimeError——`import x`、`from x import run`、`x.attr`、`await x()` 四路径同错 |
| F5 importName 撞内置/rlm 无闸 | import 循环前快照保留名集合 = `sys.modules ∪ globals() ∪ sys.stdlib_module_names ∪ sys.builtin_module_names`，命中即拒绝：记 `_PRIME_AGENT_SKILL_IMPORT_ERRORS`、不动真实绑定。asyncio/rlm 不再被 wrapper 替换（注意：`sys.modules['rlm']` 本来就是运行时自设的 `_CallableModule`，断言改为「未被换成 `_PrimeAgentCallableSkillModule`」） |
| F6 同名 importName 三标准不一致 | **唯一权威 = 模型可见列表中第一个声明该 importName 的技能**：`getPythonSkillRuntimeInfo` 按 importName 去重（首见者胜）——内核 import 名单、venv 安装名单都从它流出，双 `--editable` 安装消失；`formatSkillsForPrompt` 只给拥有者打 `<python_import>`，被遮蔽技能仍列 name/description/location 但不再认领该 import 名 |

### ② dill「成功但错」诚实面（`prime-agent-runtime/src/rlm/repl.py` + 3 个 TS 文件）

- `_restore_state` 载完所有 blob 后跑 `_revival_degraded_names(staged, ns)`：函数（含绑定方法的 `__func__`）且 `__globals__` 既不是活 ns、也不是任何已加载模块的 dict（= 按值带走的私有副本），且其 `co_names` 读到的某个 staged/ns 名在冻结副本里**不是同一对象** → 记入新字段 `degraded`（name+reason："revived with a frozen copy of its defining namespace…"）。
- 保守性：从真实模块按引用复活的函数（globals = 模块 dict）不误报（红测 `test_rt5_imported_function_stays_fully_restored`）；不读任何复活名的自包含函数不误报（`test_rt5_self_contained_function_stays_fully_restored`；小整数同值同对象这类假阴性是接受的边界）。
- 值**仍然写入 ns**（可用但不可信），但**移出 `restored`**，所以旧 host 的 "available again" 也不再谎称它们。字段为增量 additive（空则不发）。
- TS：`RestoreResult.degraded?: RestoreDegradedName[]`；`restoreNoticeLines` 新增第三档 "revived with reduced semantics…" 行，`restored` 为空但 degraded 非空时不再说 "could not be revived / starting fresh"；`repl-manager.runRestoreAttempt` 用 `asReasonArray` 解析透传；`reset-notice.ts` 回滚行同档补一句。
- 通知分档：available again（restored）/ reduced semantics（degraded）/ must be recreated（failed）/ never saved（notSaved）。

## 红测（改前必红，全部实测红过）

- Python（`prime-agent-runtime/test/test_rt5_impl.py`，新文件）：`test_rt5_frozen_globals_function_is_degraded_not_restored` 改前红于 `degraded` 通道不存在（`'helper' not found in []`）；改前还实证了降级是真的：`lst = [1]` 后 `helper()` 仍返回 3（冻结副本）。
- `test/ipython-bootstrap.test.ts` 新增 describe（tag kernel-heavy）5 测改前全红：F1 `await sa.B()` TypeError；F2 `shared: False` + `sees: None`；F3 reload 后签名陈旧 / `reload(sa.B)` ImportError；F4 `import skill_gamma` ModuleNotFoundError + AttributeError 泄内部类名；F5 `asyncio_type: _PrimeAgentCallableSkillModule`。
- `test/skills.test.ts` 新增 2 测改前红：runtime entries=2、prompt 双 `<python_import>`。
- `test/repl-kernel-snapshot-honesty.test.ts` 新增 2 测改前红：真运行时 `restore.restored` 含 helper（通知谎称 available again）；纯文案无 reduced-semantics 档。

## 绿测（改后全部通过）

- `uv run --with pytest python -m pytest`：`test_rt5_impl.py + test_r35_impl.py + test_repl.py` = 121 passed；`test_repl_snapshot_preserve.py + test_repl_perf.py` = 26 passed（env 泄露变量已 unset）。
- vitest：`skills.test.ts` 34✓；`repl-kernel-snapshot-honesty.test.ts` 默认滤 9✓（含新文案测）+ kernel-heavy 滤真运行时 5✓；`ipython-bootstrap.test.ts` 默认滤 8✓（含 edit 技能 canonical-paths 回归，证明函数重绑无破坏）+ kernel-heavy 滤 5✓；`kernel-snapshot-write-policy` 13✓；`repl-kernel-state-roundtrip` 10✓；`repl-kernel-partial-restore-snapshot` 2✓；`repl-kernel-restart-budget` 10✓。
- 冻结树校验：`git archive 3d0a7d764` 落 /tmp/rt5_pristine + symlink node_modules，`npm run check`（biome 全仓 + tsgo + installer + browser-smoke + ci-honesty）**EXIT=0**。
- biome 对全部改动文件 check 通过；git add 逐文件核对 staged，提交 `3d0a7d764`（11 files, +686/−13，含 changelog fragment `packages/coding-agent/.changes/rt5-skill-wrapping-and-restore-honesty.md`）。

## 残留与边界（诚实申报）

1. F2 只重绑「本模块定义的模块级函数」；类方法的 `__globals__`、从其它模块 import 进来的函数仍指原 dict（代码注释已钉死该边界）。
2. F6 的 sibling-dependency 自动补包（`resolveSiblingPythonSkillDependency`）理论上仍可能引入第二个同 importName 的包；r35 报告里「真 venv 安装顺序赢家」的 live 验证仍未做（本轮以首见权威 + 单一安装口径替代）。
3. ② 检测是保守子集：纯别名断裂（两个名字指向同一 list、无任何函数）不在最小修范围内，仍会进 restored（任务指定最小修=函数对象校验）；isinstance/类同一性断裂只在有函数读到该名字时才连带浮出。
4. 运行时 venv 的 `degraded` 字段对旧 host 是纯增量；`restored` 语义变化（排除 degraded）对只消费 failed 的 `unrestoredNames`/preserve_names 链路无影响（`kernel-snapshot-write-policy` 13 测仍绿）。
5. r35 报告 F3 的「类身份随 bootstrap 双执行漂移导致 isinstance 双包闸失效」可达性未验证（r35 已标未做，本轮未改）。

## 复现命令

```bash
cd /tmp/rt5_wt/prime-agent-runtime && env -u RLM_DEPTH uv run --with pytest python -m pytest test/test_rt5_impl.py test/test_r35_impl.py test/test_repl.py -q
cd /tmp/rt5_wt/packages/coding-agent && env -u RLM_DEPTH -u RLM_SESSION_DIR   PRIME_AGENT_KERNEL_PYTHON=/tmp/rt5_wt/prime-agent-runtime/.venv/bin/python   node ../../node_modules/vitest/dist/cli.js --run --no-file-parallelism --tagsFilter kernel-heavy   test/ipython-bootstrap.test.ts test/repl-kernel-snapshot-honesty.test.ts
```
（kernel-heavy 测默认被 `tagsFilter` 排除，必须显式 `--tagsFilter kernel-heavy`；`PRIME_AGENT_KERNEL_PYTHON` 指向工作树 editable venv 才能覆盖 repl.py 改动。）
