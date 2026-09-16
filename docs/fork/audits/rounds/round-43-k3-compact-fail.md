# K3 手动 /compact「失败」实机复现与诊断（round-43）

日期：2026-09-16 · 执行：本席（r43 K3-compact 诊断席）· 全程沙箱隔离（PRIME_AGENT_CODING_AGENT_DIR=/tmp/k3compact/agent + 独立 --daemon-socket /tmp/k3compact/daemon.sock），生产 daemon（pid 85462，317 会话）零触碰，已复核健在。

## 结论（TL;DR）

**K3 压缩在「worker 内执行」的所有路径上全部成功（TUI 手敲 /compact、thinking low/high/max、小到 590k token 会话、流式中途排队触发，全部实测通过）。唯一复现出的失败形态是 daemon 有线协议的 30 秒客户端超时：凡经 daemon socket 发 `compact` 命令的客户端（`--mode rpc`、ACP、TUI 扩展上下文里的 compact），压缩 summarization 超过 30s 就报 `Timed out after 30000ms waiting for the Prime Agent daemon response to "compact"`。这不是 K3 专属代码路径——DS-flash 在 150k token、GLM-5.3 在 590k token 同样踩中——但 K3@max 是最慢的 summarizer（深度推理），在老板常用会话规模下最先、最稳定地越过 30s，所以体感「K3 会失败，换别的模型就没事」。**

**老板生产 daemon 跑的是旧构建 v0.9.1-760-geaed790f1（16h uptime，status=outdated，落后当前 dist 185 个提交，其中 9 个提交直接改 compaction/daemon-client）——若老板是在 TUI 里对小会话手敲 /compact 看到失败，当前代码无法解释，需要老板给出当时的确切错误文本或会话 id 才能再定位。**

## 复现矩阵（全部实测，沙箱 daemon = 当前 dist 构建）

| # | 路径 | 模型/thinking | 会话规模 | 结果 |
|---|------|--------------|---------|------|
| 1 | rpc `compact` 命令 | kimi-k3 / low | ~5 轮小会话 | ✅ 成功（9.6s） |
| 2 | rpc `compact` 命令 | kimi-k3 / max | 小会话 | ✅ 成功（15.6s） |
| 3 | rpc `compact` 命令 | kimi-k3 / high | 小会话 | ✅ 成功（13s） |
| 4 | rpc `compact` 命令 | kimi-k3 / max | ~590k token | ❌ **客户端 30.0s 超时**；服务端 45s（另一轮 29.9s 压线成功）后 compaction_end 正常落盘 |
| 5 | rpc `compact` 命令 | kimi-k3 / max | ~150k token | ❌ **客户端 30.0s 超时**；服务端 +72.7s 完成，summary 10576 字符正常 |
| 6 | rpc `compact` 命令 | kimi-k3 / max | ~100k token | ❌ **客户端 30.0s 超时**；服务端 +54.9s 完成 |
| 7 | TUI 手敲 /compact | kimi-k3 / max | ~590k token | ✅ 成功（~60-70s， spinner 期间无任何错误） |
| 8 | TUI 流式中途 /compact | kimi-k3 / max | 压缩后小会话 | ✅ 排队为 steering，回合结束后执行成功 |
| 9 | TUI 压缩后继续对话 | kimi-k3 / max | — | ✅ 正常（正确引用被压缩内容） |
| 10 | rpc `compact` 命令（正控） | deepseek-v4.1-flash / max | ~150k token | ❌ 同样 30.0s 超时；服务端 +37.0s 完成 |
| 11 | rpc `compact` 命令（正控） | deepseek-v4.1-flash / max | ~100k token | ❌ 同样 30.0s 超时；服务端 +50.0s 完成 |
| 12 | rpc `compact` 命令（正控） | glm-5.3 / low | ~590k token | ❌ 同样 30.0s 超时；服务端 ~100s 完成 |

正控说明：任务预期「同形态换 glm/deepseek 应成功」——实测在 daemon 有线路径上 **GLM/DS 也失败**（#10/#11/#12），这恰好证明失败环节不在模型/协议解析层，而在客户端 30s 预算。K3 的特殊性仅在于它最慢：小会话 K3 要 10-16s（DS 约 5s），中等会话 K3 稳定 >30s 而 DS/GLM 还在 30s 内，于是中等规模区间里「K3 必失败、别的模型没事」成立。

## 失败形态（逐字证据）

rpc 客户端收到的响应（/tmp/k3compact/rpc_big.jsonl 与 rpc_big2.jsonl，多次逐字一致）：

```
{"id":"c1","type":"response","command":"compact","success":false,
 "error":"Timed out after 30000ms waiting for the Prime Agent daemon response to \"compact\". Socket: /tmp/k3compact/daemon.sock. Daemon log: /tmp/k3compact/agent/logs/daemon.sock.0e3592b2.log."}
```

超时后服务端**继续**压缩并成功（rpc_big2.jsonl #5 轮）：`+30.0s` 客户端报错 → `+72.7s` `compaction_end` 事件携 10576 字符正常 summary 到达 → `get_state` 显示 `messageCount` 已塌缩。即：**用户看到失败，压缩其实成功了**（若客户端进程随即退出，如一次性 rpc/-p 驱动，worker 关断会把进行中的压缩打成 "Compaction cancelled"，summary 丢失——沙箱日志 /tmp/k3compact/agent/logs/agent.jsonl 有逐字堆栈）。

## 根因（file:line，当前 src）

1. `packages/coding-agent/src/modes/daemon/daemon-client.ts:391` — `request(command, timeoutMs = 30000)`：daemon 请求默认 30s 绝对超时。
2. `packages/coding-agent/src/modes/daemon/daemon-client.ts:536-549` — `armPendingRequestTimeout` 起绝对定时器，到点 reject `DaemonRequestTimeoutError`，错误文本即上面逐字消息（:548）。
3. `packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.ts:1477` — `compact()` 调 `requestData({type:"compact",...})` **不传 timeoutMs** → 吃 30s 默认。
4. 调用方：`packages/coding-agent/src/modes/rpc/rpc-mode.ts:284`（`case "compact": await connection.compact(...)`）；ACP 同走 connection；TUI 扩展上下文 `interactive-mode.ts:3229`。
5. 超时只是**客户端**放弃等待——`armPendingRequestTimeout` 注释自承 "whether it ran is unknown"；服务端 `_AgentSession._compact`（agent-session.ts:10263）继续跑完并落盘。

对照：TUI 手敲 /compact 走 `parseSlashCommand` → 会话命令队列 → worker 内 `_executeQueuedSessionCommand`（agent-session.ts:8577，`skipAbort:true`），**不经过 daemon 有线请求**，因此无 30s 闸（实测 #7/#8 证实）。summarization 本身（compaction.ts:885 `completeSimple`）不设 timeout，K3 返回的 thinking+文本解析正常。

## 为什么「K3 专属」（实测数据）

- 小会话压缩耗时：K3 low 9.6s / high 13s / max 15.6s；DS-flash 同形态约 5s 量级。K3 max 每次必带长推理（thinkingLevelMap 里 off→null，thinking 关不掉，且 bailian K3 端 max_tokens=1 都压不住 reasoning），summarization 延迟约为 DS 的 2-3 倍。
- 越过 30s 的规模阈值：DS ≈ 150k token（服务端 37s），K3 在 100-150k 已稳定 55-73s。老板日常压缩的会话规模（数万到十几万 token）里，K3 落在「必超」区、DS/GLM 落在「刚好不超」区——这就是「换别的模型就没事」的来源。
- 也排除了其它候选：输入长度上限（直探 K3 非流式 986,755 token 仍 200，不存在 qwen3.8-max-0902 那种 983,616 虚标）；thinking 透出/reasoning_content 回放（压缩请求是单 user 文本，不涉回放）；压缩后次回合（实测正常）；内容审核（无 400）。

## 修法建议（方案级）

1. **首选：把 compact 改成「受理即返回 + 事件交付结果」**。daemon `compact` 命令只负责受理（worker 内入队执行），立即回 ack；结果走已有的 `compaction_start`/`compaction_end` 事件流（rpc/TUI 都已在监听）。这与 TUI 会话命令模型同构，从根上消除这一类超时，也顺手修复「客户端断连把进行中压缩打死」的歧义态（压缩是会话状态，理应存活于客户端断连）。
2. **最小修：给 compact 单命令加大预算**。`daemon-agent-connection.ts:1477` 的 `requestData` 显式传 timeoutMs（如 10 分钟），或按 `model.contextWindow` 估一个下界。改动一行量级，但保留了「等一个长请求」的坏形态。
3. **错误消息兜底**：无论选哪个，超时报文应说明「服务端压缩仍在进行」并指引查事件/状态，避免用户以为失败而重试（重试会撞 "Already compacted" 或二次压缩）。
4. 附带发现（非本任务但同源）：`armPendingRequestTimeout` 触发后 `pendingRequests` 删除该 id，服务端随后到达的成功响应被静默丢弃——调用方完全无法事后对账，建议至少在 debug 日志记一行 late-response。

## 未决项（需要老板补一条信息）

若老板坚称是在 **TUI 手敲 /compact、小会话** 上看到 K3 失败：当前 dist 无法复现（#1-3、#7-9 全过），且其生产 daemon 是旧构建 eaed790f1（落后 185 提交，含 9 个 compaction 相关修复）。需要老板提供当时界面上的确切错误文本或会话 id/时间点，再到旧构建上对照。

## 取证位置

- 沙箱全套：/tmp/k3compact/（rpc_out*.jsonl、rpc_big*.jsonl 逐字事件流、agent/logs/agent.jsonl、fabricated 会话文件、probe_limit.py、rpc_drive*.py）
- 生产只读复核：`prime-agent status --json` 确认生产 daemon（pid 85462，317 会话）未受影响；生产 sessions 全文检索确认历史 "Summarization failed" 全部属于 qwen3.8-max-0902（983616 输入上限）与 grok-4.6，无一条挂在 kimi-k3 名下。
