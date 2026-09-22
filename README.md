<p align="center">
  <a href="https://primeintellect.ai">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/40c36e38-c5bd-4c5a-9cb3-f7b902cd155d">
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8">
      <img alt="Prime Intellect" src="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8" width="312" style="max-width: 100%;">
    </picture>
  </a>
</p>

<h3 align="center">
Prime Agent: A Self-Improving RLM Harness
</h3>

<p align="center">
  <a href="packages/coding-agent/docs/index.md">Documentation</a> &bull;
  <a href="https://github.com/PrimeIntellect-ai/verifiers">Verifiers</a> &bull;
  <a href="https://github.com/PrimeIntellect-ai/prime-rl">PRIME-RL</a>
</p>

<p align="center">
  <a href="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/ci.yml">
    <img src="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/build-binaries.yml">
    <img src="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/build-binaries.yml/badge.svg" alt="Build Binaries" />
  </a>
  <a href="https://arxiv.org/abs/2608.23552">
    <img src="https://img.shields.io/badge/arXiv-2608.23552-b31b1b.svg" alt="arXiv" />
  </a>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/104249?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-104249" target="_blank" rel="noopener noreferrer">
    <img src="https://trendshift.io/api/badge/repositories/104249" alt="PrimeIntellect-ai%2Fprime-agent | Trendshift" width="250" height="55" />
  </a>
</p>

Prime Agent is an open-source coding and research agent for general and long-running work. It is designed around two core abstractions:

- The **[Recursive Language Model (RLM)](https://www.primeintellect.ai/blog/rlm)** treats context as variables (*prompt-as-a-variable*) and tools like recursive subagents as function calls (*programmatic tool /sub-agent calling*) inside a persistent REPL.
- The **[Continual Harness](https://arxiv.org/abs/2605.09998)** stores supplemental prompts, memories, skill descriptions, and reusable subagent specifications as durable state that Prime Agent can refine through small, evidence-backed updates, local to the session by default.

> [!NOTE]
> 本仓库是 Prime Agent 的**非官方独立维护版本**，不是官方仓库。官方仓库是 [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)。

## 项目介绍

[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) 是 Prime Intellect 开源的终端 coding / research agent，面向通用与长时自治任务，核心是两个抽象：把上下文当变量、把递归子代理当函数调用的 [Recursive Language Model（RLM）](https://www.primeintellect.ai/blog/rlm)，以及把补充提示、记忆、技能与子代理规格作为可自我精炼持久状态的 Continual Harness。

本仓库是它的**非官方独立维护版本**（unofficial / independent），与官方平行演进：定期从官方 main `git merge` 同步（当前已跟进 0.9.x 线），在其上维护一条自己的开发线。所有改动都标注来源与依据，不冒充官方、不歪曲上游。

本线当前重点：**本地 REPL kernel**（以极简 CPython REPL 承载 RLM 循环）、**daemon 协议演进**、**性能与正确性迭代**（由多模型交叉复审驱动的缺陷修复），以及 **upstream 同步策略**。只想要官方支持体验的，请用[官方仓库](https://github.com/PrimeIntellect-ai/prime-agent)；想跟进这条线的 REPL kernel / 协议 / 性能改动、或在其上二次开发的，本仓更合适。

与 upstream 的协作以**单向同步**为主：定期 merge 官方 main（保留本地独有实现、逐块解冲突并记录取舍），把上游更新跟进到本线，而不向官方推送。欢迎向本仓提 PR（见 [`CONTRIBUTING.md`](CONTRIBUTING.md)）；希望回馈官方的改动，建议先在本仓验证、整理成可独立 cherry-pick 的提交，再走官方贡献流程。同步历史与取舍记录见 [`FORK_NOTES.md`](FORK_NOTES.md) 与 [`docs/fork/`](docs/fork/)。

## 仓库说明

本仓 [`Dmatut7/prime-agent-rlm`](https://github.com/Dmatut7/prime-agent-rlm) 是这条开发线的**唯一主仓**：全新独立仓库（非 GitHub fork 网络），新提交、issue、release 只进这里。GitHub 默认搜索 `prime-agent` **无需勾选 Include forks** 即可找到。

旧地址不再维护：`Dmatut7/prime-agent`（上游 fork）、`Dmatut7/prime-agent-x`（早期实验线）。

## 本仓改了什么（相对官方 main）

基于官方 main，R3 已同步到 0.9.x 线（upstream `d74a75fea`，40 个上游提交）。针对两件实测过的事：**子代理一开 worker 打满**，**中文会话一长就卡输入**。

| 问题 | 改动 | 实测 |
| --- | --- | --- |
| 子代理每个 token 都触发全量会话列表重扫，活着的子代理被整份重扫一遍后当场丢掉 | 扫描**之前**先跳过活着的（resident）子代理 | worker 从 **228% CPU / 2GB** 下来；一个 732KB 子会话文件不再被同时打开 780 次 |
| 每个子代理的 display 文件毫无缓存，每条 ledger edge、每次遍历都重读一遍 | display 文件按 stat（size + mtime）缓存 | 同上（同一次 profile） |
| 中文宽度缓存只有 512 条，超过就每帧重新切字 | 按总字符数封顶（400 万字），不再按条数 | 中文过 512 条慢约 **950 倍**（0.01µs → 9.6µs/行）；ASCII 不受影响 |
| 每帧重拼整份 transcript | 没变的渲染工作不重做 | 12 行输入框 60fps 仅切字就要 1.1–2.5ms |
| 输入框每敲一个字就重排所有行 | 打字只重排当前行；wrap 结果跨帧复用，只有内容宽度或粘贴标记变了才整体失效 | 同上 |
| 正在跑的会话每次整文件重读（可到几十 MB） | 只扫新增字节；文件被整份改写（换 inode）才全量重读 | 活会话不再每次从文件头扫到尾 |
| RLM spawn ledger 每次读都重放整份文件 | `(size, mtime)` 没变就不重放；命中也交出一份克隆，调用方改不动缓存 | supervisor 不再按 token 做 GC 和拷缓冲 |
| 工具面板每个 token 都按“新”参数重建一次 | 工具参数签名没变就不拆面板 | 同上 |
| 同一事件游标上两次快照共用一个 id，字节不同被当成损坏 | 每次传输单独编号，不再用游标当身份 | worker 不再因此进入 recovering；Token/上下文栏能读到状态（[#1229](https://github.com/PrimeIntellect-ai/prime-agent/issues/1229)） |
| list 响应把每个会话正在生成的整段助手消息带上（一个 token 一次） | 协商 `list_without_streaming_messages` 能力后剥掉这条消息；已缓存的不丢 | supervisor 不再为每个 token 序列化数 MB 的 JSON |
| 自己泄漏的 session lease（release 失败、start-id 检测不可用）会把自己锁死 | 上游的 fail-closed 骨架 + 本地一条窄回收：同 pid、同 owner、且本进程没有活 lease 持有该目录才回收；进程内活着的 lease 仍然冲突 | 与上游 R3 的 lease 改写手工融合，三条本地符号的引用计数不变 |

每条改动的落点（文件:行号）、唯一读者或唯一正控、以及「什么动作会静默弄死它」记在 [`docs/fork/local-axes.md`](docs/fork/local-axes.md)。

**R3 上游同步后已消失的本地改动**（表格里的对应行已删）：

- 会话列表的**每 worker 一次 list 往返**，以及**按 token 的刷新节流与合并**（`scheduleWorkerSummaryRefresh` / `CoalescedSummaryRefresh` / `SUMMARY_REFRESH_MIN_INTERVAL_MS`）—— 上游 #1897 + #1900 改成 roster 事件驱动 + delta 推送，这条路径本身没了；`handleList` 现在零 worker 往返，客户端拿到的是 roster 快照，新鲜度靠 `roster_update` 推送与 repair pull 兜。
- **名单没变不重发**（`syncAgentPeers`）—— 早在 R1 的上游合并（`bf542ce7e`）就已消失，表格里的这行是过期项。
- **祖先行 running 提升**（`propagateHeartbeatStateToAncestors`）—— 随上游 #1967（心跳会话按普通会话处理）有意删除。
- `omitStreamingMessages` 只被**部分**吸收：协议字段、supervisor 侧剥离、客户端命令仍活着（客户端只剩一个调用点），supervisor↔worker 那一跳成了休眠接缝（尾参恒 `false`，唯一读者是一个本地测试）。

本轮同步的取舍、schema 23-26 四层撞号与升 27 的由来、已知红清单与待办见 [`FORK_NOTES.md`](FORK_NOTES.md) 的 R3 节；缺陷台账见 [`docs/fork/audit-findings.md`](docs/fork/audit-findings.md)。

官方 `install.sh` 装的还是没有这些改动的发布版。要跑本 fork：

```bash
git clone https://github.com/Dmatut7/prime-agent-rlm.git   # 默认分支 merge/repl-kernel(含本线全部改动)
cd prime-agent-rlm
./prime-agent.sh --daemon-socket /tmp/prime-agent-test/daemon.sock
```

`--daemon-socket` 必须加，否则会连上已经在跑的旧守护进程，子代理那几笔不会生效。从源码启动会比安装包慢（tsx 现场编译），进去之后的操作速度不受影响。

Prime Agent combines a persistent Python control environment with durable harness state, so useful working context and reusable operating patterns can outlive a single chat window.

- **Everything is programmatic:** a persistent Python REPL is the built-in model tool; file operations, shell commands, tool use, subagents, and context management happen through code.
- **Subagents are built in:** `rlm(...)` spawns real child agents for parallel or background work and returns their results programmatically.
- **The harness can improve:** `/refine` reviews the current trajectory and can apply small, evidence-backed updates to supplemental harness state. It never rewrites the immutable base system prompt, and recorded snapshots support rollback.
- **Skills are executable:** skills are importable Python packages, and the built-in skill creator can turn recurring workflows into project or personal skills.
- **Sessions run in the background:** daemon-backed agents keep running when the terminal disconnects and can be reattached later.
- **Agents communicate directly:** running agents can exchange messages and orchestrate one another without routing everything through the user.
- **Long tasks keep moving:** automatic compaction, persistent goals, heartbeats, schedules, autonomous mode, and retained subagents preserve progress across turns and terminal sessions.

## Getting Started

> **This repository is an independently maintained line, not the upstream release channel.**
> The official one-line installer installs the **upstream** release, which does **not** include
> this line's fixes (see [FORK_NOTES.md](FORK_NOTES.md)). Install **this** line with its own
> one-liner - it clones, builds, and installs the `prime-agent` command from this tree:

```bash
curl -fsSL https://raw.githubusercontent.com/Dmatut7/prime-agent-rlm/merge/repl-kernel/install-fork.sh | sh
```

Custom checkout dir (`$HOME/prime-agent-rlm` by default), or build an existing clone:

```bash
INSTALL_DIR=~/pa sh install-fork.sh          # custom dir
sh install-fork.sh /path/to/existing/clone   # update + rebuild a checkout
```

Manual equivalent of the one-liner:

```bash
git clone https://github.com/Dmatut7/prime-agent-rlm.git   # default branch merge/repl-kernel
cd prime-agent-rlm
npm ci && npm run build && npm link   # installs the `prime-agent` command from this tree
```

Or run straight from source without installing (slower startup, same runtime):

```bash
./prime-agent.sh --daemon-socket /tmp/prime-agent-fork/daemon.sock
```

If you actually want the official upstream release instead:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh   # upstream, without this line's changes
```

The installer refuses to overwrite an existing installation unless it can ask for
confirmation in a terminal; a non-interactive rerun (the plain `curl … | sh` path) is
rejected in that state. Pass `--force` to reinstall over the existing files without a
prompt — for example `sh install.sh 1.2.3 --force` when pinning a version. The flag is
honored wherever it appears on the command line (before or after the version or channel
argument) and still respects the installer lock: a live concurrent installer is never
overridden by it.

> **Updating this line.** On a checkout of this repository `prime-agent update --self` is
> refused: it installs the upstream release over this line's build, which does not contain this
> line's changes (`--allow-official` overrides the refusal, loudly). Update by rebuilding the
> checkout instead: `git pull --rebase && npm run build`, then restart the daemon
> (`prime-agent shutdown && prime-agent`). The startup "Update available" notice reports the
> **upstream** release - it is a signal that this line has something to sync, not a command to run.

Start Prime Agent from the repository or directory you want it to work in:

```bash
cd /path/to/project
prime-agent
```

On first launch, run `/login` to choose a subscription or API-key provider. Prime Agent works in the current directory and can run commands and modify files there. Use a disposable clone, clean worktree, or another checkpoint you can inspect and restore.

> [!WARNING]
> Prime Agent executes model-generated Python and project commands with your user permissions. Its worker and kernel processes improve lifecycle isolation and recovery; they are **not** a security sandbox. Review changes and use trusted repositories, instructions, skills, and extensions only. Run untrusted code or instructions in an external sandbox or restricted environment.

Useful commands:

```bash
prime-agent agents                   # Browse running, idle, and saved sessions
prime-agent attach <agent>           # Reattach to a running session
prime-agent --resume [path|id]       # Browse sessions or resume one directly
prime-agent status                   # Inspect background service state
prime-agent doctor [--fix]           # Inspect or repair background services
prime-agent update [--force]         # Update extensions; --self is refused on this fork (see below)
prime-agent shutdown [--force]       # Stop every agent, worker, and background service
```

## Built for Long-Running Work
Prime Agent is built for long-running work, especially for evaluations in research. These features are available in the TUI, and when run autonomously.

- **Continual Harness:** `/refine` can persist focused, reviewable lessons as supplemental prompts, memories, reusable skill descriptions, or subagent specifications, with recorded refinement history. It does not replace packaging and reviewing new executable skills.
- **Direct agent-to-agent communication:** running agents and retained subagents can discover one another, exchange messages, and steer active work.
- **Daemon-backed continuity:** active sessions, Python REPL state, schedules, and subagents keep running when the terminal detaches and can be reattached later.
- **Heartbeats and schedules:** `/heartbeat`, `rlm_heartbeat`, and `prime-agent schedule` can re-enter a session periodically or at a specific time.
- **Persistent goals:** `/goal` keeps an objective and its progress active across turns until it is completed, paused, or cleared.
- **Bounded autonomous mode:** `/autonomous` continues within configured turn, token, and time budgets and can run user-defined quality gates. A passed gate checks only what that gate verifies; reaching a limit does not imply task success.

## Documentation

- [Quickstart](packages/coding-agent/docs/quickstart.md) — install, authenticate, and run a first session
- [Security and sandboxing](packages/coding-agent/docs/security.md) — trust model, enforced controls, external isolation, persisted state, and unattended-run checklist
- [Usage and CLI reference](packages/coding-agent/docs/usage.md) — commands, sessions, autonomous limits, and output modes
- [Long-running and background agents](packages/coding-agent/docs/long-running-agents.md) — detach and reattach, goals, heartbeats, and schedules
- [RLM programming model](packages/coding-agent/docs/rlm.md) — the persistent Python REPL, subagents, skills, and the trust model
- [JSON mode](packages/coding-agent/docs/json.md) and [RPC mode](packages/coding-agent/docs/rpc.md) — headless automation and integrations
- [Skills](packages/coding-agent/docs/skills.md) — install and create reusable capabilities
- [Provider setup](packages/coding-agent/docs/providers.md) — subscription and API-key providers
- [Architecture overview](packages/coding-agent/docs/architecture.md) — daemon, worker, kernel, and persistence boundaries
- [Development](packages/coding-agent/docs/development.md) — build and run from source

## Contributing

Start with a GitHub Discussion for [general questions](https://github.com/PrimeIntellect-ai/prime-agent/discussions/categories/general), [bug reports](https://github.com/PrimeIntellect-ai/prime-agent/discussions/categories/bug-reports), and [feature requests](https://github.com/PrimeIntellect-ai/prime-agent/discussions/categories/feature-requests). Maintainers promote accepted work into Issues, and pull requests are reviewed from maintainers and vouched contributors.

Read the [contribution guidelines](CONTRIBUTING.md) for the full process. Report security vulnerabilities privately by following the [security policy](SECURITY.md).

## Acknowledgements

Our agent and TUI is built on top of [`pi`](https://github.com/earendil-works/pi). We thank the authors of `pi` for their valuable work.

## License

Prime Agent is fully open source and released under the [MIT License](LICENSE).

## Citation

If you use this codebase in your research, please cite Prime Agent:

```bibtex
@article{karten2026prime,
  title={Prime Agent: A Self-Improving RLM Harness},
  author={Karten, Seth and Zhang, Alex L. and Thomas, Kevin and Müller, Sebastian and Bakouch, Elie and Auras, Daniel and Senghaas, Mika and Obeid, Fares and Dunas, Konstantin and Hagemann, Johannes and Jaghouar, Sami},
  journal={arXiv preprint arXiv:2608.23552},
  year={2026}
}
```

Available at [https://arxiv.org/abs/2608.23552](https://arxiv.org/abs/2608.23552).
