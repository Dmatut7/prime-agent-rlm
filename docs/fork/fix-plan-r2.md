# 迭代任务书 R2（2026-08-29 晚）

> 输入：docs/fork/audit-findings.md 的「未做」节 + k3 终审低危项 + upstream 新增 15 个合并。
> 基线：merge/repl-kernel @ bb5e3e851（已 push 到 fork）。

## 工单状态总览

| 工单 | 内容 | 状态 |
|------|------|------|
| W0 | upstream 二次合并（15 提交） | 完成 |
| W1 | F70 子代理错误通知父代理 | 完成 |
| W2 | F10 edit 原子写 + F11 exec 进程组 | 完成 |
| W3 | #1253 移植 kernel host 取消 | 完成 |
| W4 | F42 分支切点对齐工具对 | 完成 |
| W5 | B8 键绑定迁移 | 完成 |
| W6 | k3 低危十条（5 修 5 留档） | 完成 |
| W7 | F5/F6 安全收口 | 在跑 |
| W8 | F4 Windows 管道 ACL | 完成（Windows 未实机验证） |
| W9 | F15/F17 窄时序窗 | 留档（未开工） |
| W10 | PR 条件观察项重估 | 完成（所列 PR 均未入 upstream） |

## 0. 教训（本轮全程遵守，逐条对应真实事故）

1. **合并冲突禁止整文件取一边**；且**每个修复提交后都跑全量常驻回归套件**（不限于合并——4606 就是修复本身打红既有测试被抓的）——A8/#1249 被「取 theirs」吃掉两次。一律逐 hunk 解，解完跑常驻回归套件。
2. **二分定罪到 commit 粒度**，不到合并点粒度（waitForIdle 误判 exec-stuck，真凶是 E1）。
3. **测试环境必须清污**：`env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_MAX_DEPTH -u FORCE_COLOR -u PRIME_AGENT_INTERNAL_DAEMON_WORKER`；否则会假红/假绿。
4. **后台任务配看门狗**：日志 mtime 5 分钟不动 = 判死，杀掉重来；禁止前台 sleep 干等。
5. **子代理超时未回报就主动拉转录**，不干等投递。
6. **配置/文档声明 ≠ 运行时事实**（我自报模型翻车）；一切结论要有当前代码证据。
7. **修复代码本身必须复扫**（第二轮复扫抓出 9 个修复引入的缺陷）。
8. **grok 产出一律亲验后才采信**；k3 终审值得等。
9. **静默 catch 必须响亮**（F32 教训：写失败 catch 空 = 数据无声丢失）；任何吞错路径要么上报要么有文档级理由。
10. **总账清单要及时打勾**——grok 把未打勾的已修项当成漏项报了，文档状态必须反映代码事实（教训 6 的文档版）。
11. **同资源测试要分批隔离**——大批量同资源用例撞连接上限会造成 0.00s 假红；分批 + 每批重建环境。

## 1. W0 再并 upstream main（最先做，别的工作都排在它后面）— 状态：完成

（状态核对：k3 三刀 F70a/b/c 已在 bb5e3e851 前全部并入闭环，勿重复开单。）

upstream 新增 15 个 squash commit（d60fab8a7..5b6c0e94e，无 merge commit），其中含我们第一轮裁定「条件拿」的 #1756（worker 恢复后再复用）、#1845（RLM 子快照单一投影）、#1842（队列状态单一来源）、#1859（quiescence 事件唤醒替代轮询）、#1882（官方版，我们已摘过同内容）。
- 冲突预警（grok+k3 审查修正）：#1842 × 我们的 F1/Q1/Q3 队列族（同区域；第一轮裁决实为 SKIP 不是条件拿，更正记录）；#1845 × B2/快照；#1858（close 等 bash）× 我们重写的 closeSession/update-restart 区；#1847 × rlm-ledger；#1857 × agents-view-state quiet marker；#1882/#1700 官方版 × 我们的摘取版（9b1e7eaac/2ee4ef0e6）——**同内容不同提交，会撞不会自动净**，逐 hunk 解；两边都带 remote-message-single-send.md / execute-bash-abort-controller.md fragment，核对内容一致。
- 验收：merge + npm run check + 常驻回归套件 + daemon/queue 相关套件。
- 注意：#1864（所有权 in-flight open）也进来了——我们第一轮裁它低价值但既然官方并了就跟进复核它和我们 client_owned 语义的兼容。

## 2. 缺陷修复工单（按价值排）

- **W1 = F70 子代理永久错误后无人知晓**（high，grok+k3+runtime 三审收敛）— 状态：完成：**第一步先诊断**——exec-ext 案例（stopReason=error + key 解析失败）走的是哪类错误路径（回合前 throw vs 流内 error vs 重试耗尽），不同类不同修法；重试机制存在（retry 默认 enabled、maxRetries=3，settings-manager.ts:955-984）；缺口是**永久类错误（auth/invalid_request）耗尽后停在 needs_input、不通知父代理**（agent-session.ts:11164-11170, 11131）。改法：耗尽/永久错误 → agent_message 通知父代理（含错误摘要）+ 明确的终态标记；不做从零退避。活体案例：exec-ext 暴毙事件。
- **W2 = F10+F11 工具写盘/进程组**（med）— 状态：完成：edit 原子写（tempfile+rename、abort 预检）；exec.ts 杀进程组 + 输出截断（抄 bash-executor 方案）。
- **W3 = A7/#1253 移植**（med）— 状态：完成。grok 审查补正：移植点=HostRequestHandler 签名加 AbortSignal + repl-manager handleHostRequest 的 dispatch 透传 + cleanupResources 取消在途 rlm.run；不是只改 shutdown）：把「宿主拆除时取消在途 kernel host 请求」移植到 ReplKernelManager。**注意分层（审查指正）**：子代理级取消已存在（agent-session 的 _cancelActiveRlmChildRuns/run.abort），#1253 补的是 kernel host-request 级（HostRequestHandler 签名在 kernel/shared.ts，无 AbortSignal 透传；upstream af14f066c 已改 host-reply envelope）。别把两层搞混。
- 协议口径：当前 DAEMON_SCHEMA_REVISION=25（streaming_deltas 已落地），本轮任何协议面改动 bump 到 **26**。
- **W4 = F42 分支切点对齐工具对**（med）— 状态：完成：fork/navigate 的切点跳过未配对 toolResult（对齐 compaction 的 findValidCutPoints 做法）。
- **W5 = B8 键绑定迁移**（low，机械）— 状态：完成：先 grep matchesKey 重新盘点（k3 实测当前 12 处，审计原写 13），迁入配置表。
- **W6 = k3 低危十条**（low，逐条裁决修或留档说明）— 状态：完成（5 修 5 留档）：①stall 看门狗警告文案含可操作指引 ②watchdog 阈值与设置联动的构造快照（改设置不生效——与内核快照无关，k3 澄清）③流 stall 重试与 retry 家族不重复计次 ⑤reconstructor observe 按引用播种→克隆 ⑥内存 checkpoint 幽灵文件清理 ⑦ `/patch/` 未锚定前缀误伤扩展工具名 ⑧F-D：handler 30s 超时 × tool_call 里 await ui.confirm 的死锁推演 ⑨F-Ed：watchdog aborting 被 touch 重置回 armed（「无无限 abort 循环」注释失真）⑩F-I：E3 审计先于 stamp 守卫落盘，失败记录的 rollback 覆盖并发赢家写。
- （④「_prompt fence 纵深」与 W9/F37 同机制，已并入 F37 降档留档——k3 实证 _queuedWorkPauses 硬闸下可达性极低，不再开工。）

## 3. 安全收口（P1 遗留）

- **W7 = F5/F6**— 状态：在跑：supervisor 侧 capability 校验 + shutdown/restart 控制面鉴权（每连接 token 或控制角色握手）。
- **W8 = F4 Windows 管道 ACL**— 状态：完成（Windows 未实机验证）：写代码+单测，标注「未经 Windows 实机验证」。

## 4. 窄时序窗（评估后小步或不修）

- **W9 = F15/F17**— 状态：留档（未开工）：attach 竞态、驱逐注册窗。先写触发序列推演，确认可达再修。（F37 已降档留档：k3 实证 _queuedWorkPauses 硬闸下不可达。）

## 5. PR 条件观察项重估

W10：#485、#565、#1580、#569、#1523、#1631、#1854—— 状态：完成（所列 PR 均未入 upstream，维持原判）——先查哪些已被 upstream 合并（避免重复），剩下的按第一轮口径复审。

## 6. 执行纪律（沿用并强化）

- 工单分给多代理并行（各开 worktree），但 **W0 必须先单独完成**（后续工单基于新基线）。
- 每并入一趟：check + 常驻回归套件 + 交叠区并集测试。
- 每个修复带回归测试（先红后绿）+ .changes fragment。
