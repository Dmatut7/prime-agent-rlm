# 更新日志

每个版本的更新内容记在这里。**发版即更新本文件**；逐日的施工台账见 `FORK_NOTES.md`，上游吸收的取舍明细见 `docs/fork/merge-upstream-20260917.md`。

## 0.10.0（2026-09-18）

吸收上游 `e2fb7bfa1` 窗（136 笔）的择取部分，加上本 fork 的一批效果与安全修复。CI 13 个 job 全绿。

### 从上游吸收

- **脏树保护**：代理执行 `git add -A/--all/-A .` 这类命令前先检查工作树，脏则拦下并给探针，避免一句命令毁掉你在飞的改动。
- **会话写入漏点补齐**：append/fork 热路径的短写补齐 4 处漏点，会话文件不再可能"写一半丢记录"。
- **孤儿 worker 回收**：无主 worker 有界回收；闸门用"有活会话或有在跑的子代理"判定，不会误杀长跑脚本。
- **内核崩溃日志落盘**：stderr 中继 + 写预算 + 轮转 + 双配额，出事能查因。
- **中断后发排队消息**：`abort_and_send_queued`（协议 schema 38 起），Esc 中断时可把已排队消息一并发出；老 daemon 退化但会响亮说明。
- **非交互 stdin 守卫**：脚本/管道调用不再因为等 stdin 挂住。
- **shell 非交互默认值**：非交互环境的终端变量默认值收敛，不再污染输出。
- **全屏顶栏与输入高亮**：top-bar 接线、prompt-highlight token 高亮进编辑器与排队预览。
- **记忆检索排序**：IDF 加权 + 稳定 tie-break + query terms 接线 + 状态指纹去重（措辞变化不再重复灌一份菜单）。
- **human 优先**（#2334 调和）：你的输入在 lane 内优先于机器流量（子代理回执/心跳/定时任务）；goal 上下文 pinned 前插；手动调过的顺序不被自动重排覆盖；恢复快照带 priority。
- **错误语义**：出错的回合不再被记成 completed；错误判决与实际所用模型上 wire。
- **自治续跑挂起**：autonomous 续跑在该挂起时挂起，不再抢回合。

### 本 fork 新增 / 修复

- **子代理花费格**：subagents 行显示 `Σ 子代理 ¥… · …tok · 总 ¥…`；节拍可配（`ui.subagentSpendCell.intervalMs`，默认 15s、5–120s 可配）、应急开关可把扫描打到 0。性能修复：每 60s 扫描 22→6 次、每分钟挡住事件循环 660→156ms、撞上那一下 p50 快 3.56×，不走缓存的一次性调用方无回归。
- **压缩触发点**：从贴近上限改为**真实 token 的 80%**（含密度校正、准入门、失败降级阀）。kimi-k3 = 1,000,000 × 0.8 = 800,000。
- **压缩优先**：子代理回执不再打断进行中的压缩；压缩 hung 时排队输入（含你的打字与 heartbeat）有了 stall 上界（以前可能无限期不落地且 CI 全绿）。
- **harness 菜单搬出系统提示**（#2098）：系统提示 62,181→50,816 字节；前缀不再每轮作废（背靠背第二轮缓存命中 95%，带"故意破前缀"正控）；新记忆/新技能**下一轮可见**；被拒的精修条目模型可见；修掉"别席改了你报过的同一条目就永不再注入"的版本盲洞。
- **真 bug 修复**：digest 占 index 0 曾让"超大首回合"的压缩被整段跳过（上下文继续涨），已修。
- **CI 六条红逐条挖真因修好**：platform registry 缺行、DAT-4 注入点死（仪器腐烂读成绿）、monitor"40 步预算"＝伪装挂钟预算、waitForFile 只等存在不等内容、afterEach 把 socket 消失当进程退出、process smoke 计数随 digest 进上下文的预期变化。
- **新增第四专 job 本地镜像闸** `npm run check:process-smoke`：兜住"一个测试面悄悄消失"（偷偷加 tag 时 vitest 与 coverage 闸都仍绿，只有 tag-skip ledger 闸会红）。

### 协议与版本面

- `DAEMON_SCHEMA_REVISION` 37→**38**（digest 由测试机器重算，禁手写）；`abort_and_send_queued` 的 minSchemaRevision 取 38。
- 全 workspace 版本 lockstep **0.10.0**；fork checkout 上抑制上游升级提示并在 README/FORK_NOTES 记录拒绝（双保险）。

### 已知挂账（不挡使用，见 `docs/fork/merge-upstream-20260917.md` §9.2）

- `session_recovering` 结构化错误需整批 #2028（105 文件）才有意义，只摘协议行会得到永不产生的错误码。
- `createHarness` 不隔离 agent dir（测试会渲染开发机真库，700+ 测试面，另开一笔）。
- `build-binaries.yml` 的活体发布面未裁决，故仍**禁推 `v*` 标签**。
- 升级那一次重启窗口内旧快照无 priority 字段，已排队的 human steer/followUp 会一次性降成 background（已知、不改实现）。

## 0.9.5（2026-09-18）

- P5 协议面：schema 38 取号、digest 两步机器重算、saved-session wire 带记录模型与错误判决、0.9.5 lockstep、update-source 双保险。
- 压缩安全束十笔：触发比例制 + 密度校正、八类输入分类器、压缩优先准入闸 + 降级阀、compaction 摘要旁支修复等。
- 花费格 v1/v1.1 落地（相位对齐补刷 + 可配节拍）。
- CI 绿修复第一批（ma-p0-1 stall 族、4685 daemon 清理）。

## 0.9.4 及更早

逐日台账见 `FORK_NOTES.md`（按日期记，含每条的动机、读数与变异/正控证据）。
