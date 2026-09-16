# r35-skill-loading

线②：技能加载与 `_PrimeAgentCallableSkillModule` 的导入副作用（reload / 状态残留 / 名字冲突）。

仓 `/Users/a1/Desktop/ai/prime-agent`，冻结点 `438d33383605ed22c6111cf05851486d948e9d5f`（只读，未写仓内任何路径；全部实验在 /tmp/audit_r/round-35 与 kernel-venv 解释器下进行，未安装、未改动任何 venv）。

**实验方法（可复现、驱动真实代码路径）**：用仓内 `node_modules/.bin/tsx` 直接调 `packages/coding-agent/src/core/tools/ipython.ts::buildRlmBootstrapCode(skills)`，把真实 bootstrap 源码落成 `/tmp/audit_r/round-35/bootstrap*.py`；再用**真实 kernel venv 解释器**（`~/.prime/agent/kernel-venv-44c3ee7b2bba/bin/python -P`，内含真 `rlm` 运行时）在新进程里 `exec(compile(open(boot).read()), {"__name__":"__main__"})` 复现内核启动那一刻，PYTHONPATH 指向 /tmp 下自造技能包（未安装）。下列证据均为该进程原始 stdout。

## 结论摘要

- **P3 F1** 技能 A 在导入期 `import B` 时，A 里的 `B` 永远指向**未包装的原始 module**，`await A.B(...)` 抛 `TypeError: 'module' object is not callable`（包装不全局一致）。
- **P3 F2** 包装出的 module 与原始 module 是**两个 dict**（`skill.run.__globals__ is not skill.__dict__`），内核命名空间里的技能名是启动时快照；技能函数里 `global X; X=...` 式的重绑定在内核名下永远看不到（劫持 asyncio/rlm 时该分歧扩大到标准库/运行时模块）。
- **P3 F3** `importlib.reload`：类不丢（好），但 wrap 期只设一次的 `__signature__` 变陈旧（`inspect.signature(技能名)` 说谎）；持有原始 module 的引用**无法** reload —— `importlib.reload(A.B)` 抛 `ImportError: module skill_beta not in sys.modules`（对象其实在 sys.modules 里，只是被换成了 wrapper）；而 reload wrapper 又会**顺带修好**幻影引用 `A.B`。
- **P3 F4** 技能导入失败时 `globals()[name]` 放的是 `_PrimeAgentUnavailableSkill`（非 module，且不进 sys.modules）：`import name` / `from name import run` 抛的是技能自己的原始依赖错误（`ModuleNotFoundError`），只有预注入的名字才给到那句友好 RuntimeError；`name.X` 抛 `AttributeError: '_PrimeAgentUnavailableSkill' object has no attribute 'X'`（内部类名泄漏给模型）。
- **P3 F5** **没有「技能 importName 不得占用内核/标准库模块名」的闸**（skills.ts 只查正则）：importName 为 `asyncio`/`rlm` 的技能包会把内核全局 `sys.modules['asyncio']` / `['rlm']` 换成 wrapper 副本（逐字证据见下）。
- **P3 F6** 两个技能共享同一 importName 时三处选择标准不一致：bootstrap 的 `[...new Set(importNames)]`（ipython.ts:78）取**按 packagePath 排序后的第一个**；`normalizePythonSkills`（bootstrap.ts:334-350）**不去重**（key=importName+packagePath），两条都 `--editable` 安装；`sortPythonSkillsForInstall`（bootstrap.ts:490-495）按 **project name 的 Map，后者覆盖前者**。真正 import 到谁由安装/sys.path 顺序决定（**live 未做**），而模型提示词里两个技能都写着同一个 `<python_import>`（skills.ts:487）。
- **负结论 N1/N2**（见文末）：`importlib.reload` **不会**把 wrapper 打回普通 module（正控：普通 module reload 后仍是 `module`）；`cli()` 脚本名与 import 名不符时**明确报错不静默**（正控：名字正确的 `edit` 走通并真的改了文件）。

## 发现

### F1（P3）跨技能模块引用绕过包装：`await A.B()` → TypeError

- 命题：技能包 A 在模块级 `import B` 后，`A.B` 在包装完成后仍指向原始 module 对象，只有 `sys.modules['B']` 被换成 callable wrapper；于是「技能名可直接当函数调」的契约对**技能内部持有的模块引用**不成立。
- severity: P3（不需要攻击者，两个互相依赖的 python 技能就会触发）
- file:line: `packages/coding-agent/src/core/tools/ipython.ts:116-134`（`_prime_agent_wrap_skill_module` 只在 wrap 时替换 `sys.modules[module.__name__]`，:131）、`:136-150`（按 importNames 逐个 import，先 import 的 A 拿到的是尚未替换的 B）。
- 逐字证据（构造：`skill_alpha` 模块级 `import skill_beta; B = skill_beta`，`skill_beta` 反向 `import skill_alpha`）：
```
== 1 cross-skill reference
sys.modules[skill_alpha] is A: True
sys.modules[skill_beta] is B: True
A.B is sys.modules[skill_beta]: False
A.B type: module | callable(A.B): False
await A.B() -> EXC TypeError: 'module' object is not callable
await A.B.run(): beta:1
```
- 影响：模型对这类技能的点名调用必然失败一次（`A.B.run(...)` 仍可用，但错误信息不指向技能包装，而是 Python 的 'module' object is not callable）。
- 复现：`node_modules/.bin/tsx /tmp/audit_r/round-35/gen_bootstrap.mts '<json>' /tmp/out.py`，再 `env -u RLM_DEPTH ... <kernel-venv>/bin/python -P /tmp/audit_r/round-35/exp1.py /tmp/out.py`。
- confidence: high（真 bootstrap 源码 + 真解释器，非读码推断）

### F2（P3）wrapper 与原 module 双 dict：技能模块级状态在内核名下不可见（模块名劫持时更严重）

- 命题：`wrapped.__dict__.update(module.__dict__)` 是**浅副本**；技能函数的 `__globals__` 仍绑原始 dict。凡「把模块当对象改状态」的操作（`global X; X=v`、`mod.attr=v`、库在 import 后对模块的惰性注入）只落在其中一个 dict 上。
- severity: P3（对普通技能多为 latent；对 sys.modules 被劫持的 asyncio/rlm 是内核级全局模块状态分裂）
- file:line: `ipython.ts:122-131`（:123 `wrapped.__dict__.update(module.__dict__)`，:131 `sys.modules[...] = wrapped`）
- 逐字证据：
```
A.run.__globals__ is A.__dict__: False            # 双 dict
raw module dict COUNTER: [1]                      # 原地改的 list 两边都看得到
after A.MARK=1: wrapper has MARK: True | real asyncio dict has MARK: False
```
- 影响：以「模块属性」为载体传递的状态在技能名与真实模块之间分裂；而 `reload` 之后双 dict 又收敛（F3），使现象更难归因。
- 复现：/tmp/audit_r/round-35/exp1.py + exp4.py。confidence: high

### F3（P3）reload 语义：类不丢，但 `__signature__` 陈旧 + 持有原始 module 的引用不可 reload

- 命题（三点，均实测）：(a) `importlib.reload(wrapper)` 仍返回同一 wrapper，`_PrimeAgentCallableSkillModule.__call__` 不丢；(b) wrap 期一次性的 `wrapped.__signature__`（ipython.ts:125）在 reload 后**不更新**，`inspect.signature(技能名)` 与 `技能名.run` 签名不一致；(c) `importlib.reload(<原始 module 引用>)` 直接抛 `ImportError`，因为 stdlib importlib 要求 `sys.modules.get(name) is module`；reload wrapper 又会把幻影引用 `A.B` 换成 wrapper（跨技能引用的**副作用修复**）。
- severity: P3（(c) 是模型自查/热更新技能的常见动作，报错信息与事实相反）
- file:line: `ipython.ts:123-131`（:125 `__signature__` 设一次）；stdlib `importlib/__init__.py:145-147`（`if sys.modules.get(name) is not module: raise ImportError('module {} not in sys.modules')`）
- 逐字证据：
```
before: inspect.signature(A): (x=1)
reload(A) returned same object: True | type after: _PrimeAgentCallableSkillModule
A.__signature__ after reload (stale?): (x=1) | == before: True
把 run() 改成 (x=1, y=2, *, z=3) 再 reload:
  inspect.signature(A) = (x=1)                        # 说谎
  inspect.signature(A.run) = (x=1, y=2, *, z=3)       # 真实
  A.run.__globals__ is A.__dict__ after reload: True  # reload 后双 dict 收敛到 wrapper
importlib.reload(A.B) -> ImportError: module skill_beta not in sys.modules
A.B after reload(A) is wrapped B: True                # 幻影被顺带修好
```
- 影响：模型用 `inspect.signature`/`help` 自查技能得到启动时快照；热更新技能用 `reload(<自己持有的 module 引用>)` 会得到自相矛盾的 ImportError（"not in sys.modules" 但它确实在里面）。
- 复现：/tmp/audit_r/round-35/exp2.py、exp6.py、exp7.py（exp6 临时改 /tmp 下技能源码并在结束时还原）。confidence: high

### F4（P3）导入失败的技能：友善错误只在一条访问路径出现，其余路径漏原始异常与内部类名

- 命题：失败技能只被塞进内核 `globals()`（ipython.ts:143-147），**不写 sys.modules**；因此 `import name` / `from name import run` 会重新触发**原始**依赖错误，`name.attr` 抛 `AttributeError: '_PrimeAgentUnavailableSkill' object has no attribute 'attr'`；只有直接 `await name.run()` 才给到 "Python skill X is unavailable in this kernel. Import error: ..."。
- severity: P3（模型最自然的纠正动作就是 `import` 一次看看）
- file:line: `ipython.ts:98-114`、`:142-147`
- 逐字证据（`skill_gamma` 模块顶 `import definitely_missing_module_xyz`）：
```
type(G['skill_gamma']): _PrimeAgentUnavailableSkill | is module: __main__
sys.modules has skill_gamma: False
await g.run() -> EXC RuntimeError: Python skill skill_gamma is unavailable in this kernel. Import error: No module named 'definitely_missing_module_xyz'
-- cell: import skill_gamma
   EXC ModuleNotFoundError: No module named 'definitely_missing_module_xyz' | last frame: import definitely_missing_module_xyz
-- cell: from skill_gamma import run
   EXC ModuleNotFoundError: No module named 'definitely_missing_module_xyz'
-- cell: skill_gamma.BOOM_ATTR
   EXC AttributeError: '_PrimeAgentUnavailableSkill' object has no attribute 'BOOM_ATTR'
-- cell: probe bound name -> _PrimeAgentUnavailableSkill True   (失败后 globals 里的名字没有被 import 覆盖)
```
- 影响：失败可见（非静默成功），但三条访问路径三种错误，AttributeError 文案把内部实现类名暴露给模型；模型易把技能自身的依赖缺失误判成内核坏了。
- 复现：/tmp/audit_r/round-35/exp3.py。confidence: high

### F5（P3）无「技能 importName 不得撞内核/标准库模块名」的闸：sys.modules['asyncio'] / ['rlm'] 可被技能包劫持

- 命题：加载器只校验 `^[A-Za-z_][A-Za-z0-9_]*$`（skills.ts:204、:227），没有保留名/已加载模块检查；bootstrap 的 `_prime_agent_wrap_skill_module(import_module(name))` 对**任何**有可调用 `run` 属性的模块生效，于是把标准库 `asyncio`（有 `asyncio.run`）或内核自身 `rlm`（有 `rlm.run`）的 `sys.modules` 条目换成 wrapper **浅副本**。
- severity: P3（内核级全局命名空间替换；需要以 asyncio/rlm 命名的技能包，非默认形态，但零闸零提示）
- file:line: `ipython.ts:116-131`（:120-121 只有「已包装则跳过」的幂等闸，无名字闸）、`:136-150`；`skills.ts:204-208`、`:227`；`bootstrap.ts:334`
- 逐字证据：
```
== 5b stdlib hijack (skill whose importName is 'asyncio')
G['asyncio'] type: _PrimeAgentCallableSkillModule | is sys.modules['asyncio']: True
cell: import asyncio; print(type(asyncio).__name__): _PrimeAgentCallableSkillModule True
A.run.__globals__ is A.__dict__: False
after A.MARK=1: wrapper has MARK: True | real asyncio dict has MARK: False
cell: asyncio.run(asyncio.sleep(0, result='ok')) -> ok        # 常用 API 仍能用
== 5c rlm hijack
G['rlm'] type: _PrimeAgentCallableSkillModule | is sys.modules['rlm']: True
G['rlm'] has .rlm/.harness/.bash/.host_request: True True True True
cell: from rlm import * -> ok, run= True harness= _HarnessProxy
cell: import rlm; print(type(rlm).__name__): _PrimeAgentCallableSkillModule
```
- 影响：`import asyncio` / `import rlm` 在内核里拿到的**不再是真实模块对象**（类型是内核 wrapper，dict 是启动时快照）；功能面大多仍可用（实测 `asyncio.run`、`from rlm import *` 正常），危害 latent：后续对真实模块的属性注入/重绑定分裂（F2）与 reload 语义畸变。实测一条负结果：劫持后 `importlib.reload(asyncio)` 仍成功且保持 wrapper（`ok: _PrimeAgentCallableSkillModule | is A: True`），未观察到硬崩。
- 复现：/tmp/audit_r/round-35/exp4.py、exp5.py。confidence: high（危害定性 latent：medium）

### F6（P3）同名 importName：三个选择标准不一致 + 提示词两处写同一个 python_import

- 命题：两个不同技能包共享 importName 时没有闸（只有 `warning` 诊断），且系统内部对「谁赢」用了三套标准：bootstrap 传给内核的名单是 `[...new Set(importNames)]`（ipython.ts:78，顺序=传入顺序，传入顺序来自 `normalizePythonSkills` 的 packagePath 排序 bootstrap.ts:366-370）→ 内核 `globals()[name]` 绑**排序第一**那个；`normalizePythonSkills` 用 `key = importName + "\0" + packagePath`（bootstrap.ts:339）**两个都保留**并都 `--editable` 安装（bootstrap.ts:1413 安装循环、:534-536 `--editable`）；`sortPythonSkillsForInstall` 用 project-name Map（bootstrap.ts:495，同 project name 后者覆盖前者）。
- severity: P3（同仓对「工具名冲突」已立过闸 ID-1；模块名冲突这边没有对应闸）
- file:line: `ipython.ts:78`；`bootstrap.ts:339`、`:366-370`、`:490-495`、`:534-536`、`:1413`；`skills.ts:576-579`（仅 warning）、`:487`（提示词里两个技能都写同一 `<python_import>`）
- 逐字证据（构造 dupA=from-A、dupB=from-B，传入名单顺序 dupB 在前、dupA 在后）：
```
== 5a duplicate importName: which one does the bootstrap bind?
G['skill_dup'] type: _PrimeAgentCallableSkillModule | ORIGIN: from-A
sys.modules['skill_dup'].ORIGIN: from-A
# 内核名绑的是 packagePath 排序第一的 dupA，而不是名单里第一个 dupB
```
- 影响：模型看到两个技能都标着同一 import 名时无法判断拿到谁；真实 import 的版本可能与内核名绑定的那个不同（由安装顺序决定）。
- 复现：/tmp/audit_r/round-35/exp4.py。confidence: high（选择标准不一致）/ low（真 venv 安装顺序赢家，live 未做）

## 负结论与正控

### N1 `importlib.reload` 不会把技能打回普通 module（类不丢、仍可调用）

- 结论：reload 后 `type(skill).__name__ == '_PrimeAgentCallableSkillModule'`、`isinstance(r, type(A))` 为真；reload 后 `await A.B()` 变为可用（见 F3）。未发现「reload 丢失 `__class__` 替换 / 技能不可调用」的残留。
- 正控（证明检出手段有效）：同一脚本对**普通 module** 引用做同类检测，类型就是 `module`：
```
rawB type: module | is sys.modules['skill_beta']: False
rawB type after reload call: module (positive control: a plain module stays type 'module')
```
- confidence: high。live 未做（真内核里的 reload 由模型触发，本轮用真 bootstrap+真解释器等价复现）。

### N2 `rlm.skill.cli()` 脚本名与 import 名不符时明确报错、不静默

- 结论：`prog = Path(sys.argv[0]).stem` + `__import__(prog)`，名字对不上时抛点名到具体名字的 RuntimeError；名字正确的实测走通（真的改了文件）。
- 逐字证据 + 正控：
```
argv0=agent-message -> RuntimeError: Could not import Python skill module 'agent-message'. The console-script name must match the skill import name exactly; use underscores instead of dashes.
argv0=email -> RuntimeError: email does not expose a callable run()      # 撞 stdlib 也报错（文案误导但非静默）
正控 argv0=edit + 真实参数 -> "Edited /private/tmp/audit_r/round-35/cli_target.txt" / file now: 'gamma beta\n'
```
- 唯一「错误归因」缺口（非静默）：脚本名撞上一个**有可调用 run 的**现成模块（如 `asyncio`）时，cli() 去跑那个模块的 run 并让 tyro 解析它，报的是 tyro 的类型错误而不是「这不是技能」：
```
╭─ Invalid input to tyro.cli() ╮
│ • Unsupported type annotation for field main with type typing.Any │
```
- 出厂的 3 个 console script（`packages/coding-agent/skills/{edit,attach-image,websearch}/pyproject.toml` 的 `= "rlm.skill:cli"`）名字都与 src 包名一致（edit / attach_image / websearch），未见出厂不匹配。
- confidence: high。

## 未做 / 存疑

- **live 未做**：本轮没有真内核（真 ipython 工具 + 真 REPL 协议）活体跑过任一场景；全部证据来自「真 bootstrap 源码 + 真 kernel-venv 解释器 + 真 rlm 运行时」的新进程复现（同一 exec 语义）。因此结果拼装层（`assembleIpythonToolResult`）与 UI 呈现未覆盖。
- **未验证**：同一进程内 bootstrap 被执行两次（会使 `_PrimeAgentCallableSkillModule` 类身份变化 → ipython.ts:119 的 `isinstance` 双包闸失效，静默二次包装）是否可达。读码看 `repl-manager.ts:1520 bootstrapRepairedKernel` 与 `:1634` 都在 `killChildToIdle` + `this.start()`（**新子进程**）之后调用，`pendingRebootstrap` 同样只在 fresh child 上；`ipython.ts:536` 的 restore-then-bootstrap 先 dispose 旧内核。故判「当前不可达」，但**未**做活体注入验证，也未为此构造正控。
- **未验证（live）**：F6 里「真 venv 中两个 --editable 同 importName 包谁赢」只能由安装/sys.path 顺序决定；我在 /tmp 用 PYTHONPATH 复现了「内核名单赢家 != 名单第一项」，但没有真往 kernel-venv 装包（不愿改动其它会话共用 venv）。
- **存疑（P4，未计入发现）**：`ipython.ts:24-30` 的 try 块同时覆盖 `import rlm` 与 `import rlm.mcp`，若 kernel venv 缺 `mcp` SDK，会把「mcp SDK 缺失」报成 "prime-agent-runtime is not installed in this kernel" 并整体换成 `_PrimeAgentMissingRlm`。仅读码，未构造缺 mcp 的 venv 实测。
- **未覆盖**：`rlm/__init__.py` 的 `_LAZY_MCP` / `__all__` / `_HarnessProxy` 一致性（仅顺带观察到劫持后 `from rlm import *` 仍成功）；`harness.py::_validate_python_skill_reference`（技能名 ↔ harness skill 条目 reference/arguments 契约）本轮未逐行读完并实测 —— 下一轮可做项。
