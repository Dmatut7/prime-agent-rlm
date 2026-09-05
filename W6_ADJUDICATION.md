# W6: k3 低危十条逐条裁决

## 已修（5 条）

| # | 条目 | commit | 修法 |
|---|------|--------|------|
| ① | stall 看门狗警告文案含可操作指引 | 2c823b5b4 | warn 消息补「interrupt the turn manually + check daemon log」指引 |
| ② | watchdog 阈值构造快照（改设置不生效） | 3e80d1c01 | warnAfterMs/abortAfterMs/enabled 改接受 getter 函数；session 传 live getter |
| ⑤ | reconstructor observe 按引用播种→克隆 | f3f5f07db | observe() message_start 分支浅克隆 message+content blocks（同 seed()） |
| ⑦ | `/patch/` 未锚定前缀误伤扩展工具名 | 6bf1b5b6b | WRITING_TOOL_PATTERN 全部锚定 `^(?:…)$`，消除 `dispatch` 等子串误匹配 |
| ⑨ | watchdog aborting 被 touch 重置回 armed | deae9ac2d | touch() 在 aborting 态直接 return，保留 settle 定时器，不重启 warn→abort 循环 |

## 留档（5 条）

| # | 条目 | 裁决 | 理由 |
|---|------|------|------|
| ③ | 流 stall 重试与 retry 家族不重复计次 | 不修 | stall abort 调 requestAbort() → abortRetry() → _isAgentLifecycleFailure 判定为不可重试，stall 与 retry 不会叠加计次；k3 终审亦确认流 stall 为无问题区域。 |
| ④ | _prompt fence 纵深 | 不修 | k3 实证 _queuedWorkPauses 硬闸下可达性极低，已并入 F37 降档留档，不再开工。 |
| ⑥ | 内存 checkpoint 幽灵文件清理 | 不修 | memory checkpoint 文件在 cancel 路径有清理（cancelPreparedUpdateRestart）；commit 成功路径不清理因新进程需从文件恢复会话，恢复后无清理机制——需 daemon 级生命周期清理（非最小补丁范围），留待后续。 |
| ⑧ | handler 30s 超时 × tool_call await ui.confirm 死锁推演 | 不修 | awaitWithTimeout 不取消底层 Promise：用户 30s 内响应则 handler 正常完成，超时则 tool_call 被阻断但 ui.confirm 对象最终 resolve（非死锁）；超时可配（0=禁用）；当前无扩展在 tool_call handler 内调 ui.confirm。 |
| ⑩ | E3 审计先于 stamp 守卫落盘，失败记录的 rollback 覆盖并发赢家写 | 不修 | audit-first 顺序是刻意的崩溃安全设计（崩溃后仍可 /refine rollback）；stamp 守卫失败需并发 refine（设计上已串行化），orphaned audit record 为极低概率边界 case；调换顺序会逆转崩溃安全属性。 |
