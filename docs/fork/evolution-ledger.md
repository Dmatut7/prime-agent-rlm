# 演化账本（evolution ledger）

维护集群主席的长期记忆。窗口重开后读这一份恢复，不依赖聊天记录。
前身：swarm-loop-plan-20261001.md（波次 0~8 的完整台账，本文继承其格式并接管后续波次）。

恢复指令（一句话）：读本文件「当前状态」+「Backlog」→ 若 wave 有未提交批次先验证提交 → 按「下一波主题」开工。

## 循环与选题（任务书 v2，2026-10-02）

AUDIT → RESEARCH → PLAN → BUILD → VERIFY → REVIEW → SHIP → NEXT，永不停止。
六个选题入口每波各扫一遍：代码审计 / 联网调研（≥5 条带 URL，答不出「解决我们哪个实测问题」就扔）/
性能画像 / 体验走查（tmux 实机截图 + 视觉子代理逐帧审 + 对照 Claude Code/Codex CLI）/
模型智能（固定考题集 + 会话记录挖「模型干蠢」案例，先归因再换模型）/ 老板痛点（插队优先）。
超大集群：活大就放开派，产物落盘 /tmp 归档。
重构门槛：触发证据 + 研究清楚现状为什么是这样（git 历史/决策文档/上游对照）+ A/B 对照 + 全量门禁。

## 当前状态（2026-10-02，主席交接点 · 更新版）

- HEAD = ec85d1894（wave-8 收尾已推送）。version 0.11.18，wave-1~8 未发版。
- **wave-9 批次验证+修复完成，待提交**：73 文件 +3544/−510，changeset w9a~w9h + 主席补 w9a fragment。
- **两处红已清**：digest = HEAD 自带红（2f3f5a82d 加 AgentConnectionSnapshot.messagesOmitted 未重算），按 rev-37 先例原地重算为 protocol-7-schema-44-69c0ff689f92 + recovery 注释（34/34 绿）；类型错 = w9a-compaction 测试里 `getOriginalImplementation`（vitest v5 无此方法，tsgo TS2551），Q4 工兵已修。教训：门禁命令接管道必须 pipefail（`tsgo | head` 曾把 EXIT 2 洗成 0）。
- 验证集群六路结论：agent 148 绿 / ai 全绿（6 红为本机 ollama 装了二进制没起 server 的存量测试缺陷，PI_NO_LOCAL_LLM=1 下全 skip，非 wave-9）/ tui 全绿（node:test 1034 通，1 条 8MB paste 负载 flake；vitest 配置是历史错配）/ python 654 绿 0 错 / coding-agent 12 确定性红已分流修复。
- 主席裁决+处置：exceeds-cap/wait-abort 四路径补恢复轮 = 有意变更（注释明写），4 个旧契约测试已同步（Q2）；pump epoch 下沉后 deferred 分支不重调度 = wave-9 真回归（违反 wave4-e 书面契约），主席在 agent-session.ts:11368 blocked 分支补 `_scheduleSessionInputPump()` 修复，agent-session-queue 114/114 绿；w9a-compaction 测试注入点认错事件已重写为谓词 mock（Q4）；interactive-mode 两个假 this harness 补 slimOrphanToolResults（Q1）；test-hygiene 豁免注释压单行（marker 必须在违规行紧邻上一行）。
- 环境豁免登记：ai 包 ollama 门控假失败（PI_NO_LOCAL_LLM=1 豁免）；coding-agent image-model 8 红为本机 claude-code ambient 凭证致裸 id 二义（CI 无此环境，登记 Backlog）；负载 flake 若干（隔离重跑全绿）。
- npm run check（pipefail 真出口码）EXIT 0；debug-w9a.ts 移出仓库到 /tmp/wave9-scratch/。
- 待办：顶层+suite 全量复扫（跑中）→ 纯净树复验 → 分 6 批提交 → FORK_NOTES → push → wave-10。

## 波次日志（接管前摘要，详见 swarm-loop-plan-20261001.md）

- 波次 0：11 路审查+调研 → 发现清单（中断/命令/显示/体验/记忆/智能/文档七域）。
- 波次 1~8：30+ 项修复，schema rev 40→44，CI 从连红 4 跑到转绿（run 36861026576/36866050779）。
  重点：重试耗尽续跑、stall 恢复链、quota park 全链可见、slim attach（rev 44）、重放收敛单一实现、
  finish-gate 判官、回收器、机器块防伪造、Codex 计费、daemon 崩溃恢复、Esc/键位、thinking 收敛。

## Backlog（按影响×证据÷代价粗排；连续 3 波没人挑降级或删）

1. 【体验走查·新入口】从未跑过：tmux 实机 120x40/80x24 走主流程截图 + 视觉子代理审帧 + 对照 Claude Code/Codex CLI。证据获取成本中，预期高产。
2. 【模型智能·新入口】固定考题集 + 挖本机会话记录里的「模型干蠢」案例（先归因：模型/提示词/编排）。
3. 【文档-3】流式增量全量重发：10 万字符回答放大到 1.14GB（2026-09-14-fixes.md:139），需设计。性能画像入口。
4. 【显示-调研】终端宽度画像 + mode 2027 DECRQM 探测，设计项（swarm-loop-plan 显示域调研对策）。
5. 【文档-16】子代理调度无并发配额/背压（2026-09-14-fixes.md:455）。
6. 【文档-9 剩余 4 条】重试语义簇（429 照表、SDK 层重试零事件、重试定时器不可取消、子代理回合级错误无重试）。
7. 【slim 回填 inline 触发器】inline 模式无回填入口（click region 只 fullscreen+mouse；动 core/keybindings.ts + slash-commands.ts）。
8. 【W5-C 遗留③】dev 机设真实 provider key 时 getAvailable 断言漂移（只隔离了磁盘探测源）。
9. 【安全簇 文档-12/13】供应链校验、traces 上传零脱敏、auth.json 0644 —— 硬约束：先写方案问老板，不动手。
10. 【智能-4 边角】aborted 回合不占「最近思考保留」名额（minor，方向安全）。
11. 【wave-9 验证新发现】ai 包 ollama 门控测试缺陷：server 未起时 beforeAll 提前 return 但用例不真跳过 → 6 条 TypeError 假失败（stream.test.ts:1443、context-overflow.test.ts:430）。修法：门控改成真 skip 或 PI_NO_LOCAL_LLM 默认化。
12. 【wave-9 验证新发现】image-model/kernel-attach-image 8 例对本机 claude-code ambient 凭证敏感（裸 id claude-haiku-4-5 二义）：测试改用限定名 `anthropic/claude-haiku-4-5` 可根治。
13. 【wave-9 验证新发现】packages/tui/vitest.config.ts 是历史错配（该包真实 runner 是 node:test，vitest include 只列了 wrap-ansi 一个 node:test 文件）：要么删配置要么改成 passWithNoTests，防止误用 vitest 跑该包。
14. 【wave-9 验证新发现】python 测试两处 ResourceWarning: unclosed file（test_rt5_impl、test_repl.py:748），整洁度债。

## 未决项 / 坑

- daemon digest 覆盖连接侧镜像 DTO：改 agent-connection/types.ts 里 AgentConnectionSnapshot 等切片区
  （含纯注释）都会动 digest，提交前必跑 daemon-protocol 测试。wave-8 栽过一次，wave-9 主席原地重算。
- CI 环境红与本机环境红要分开归因（claude CLI 探测已有 PI_DISABLE_CLAUDE_CODE_DETECTION 豁免）。
- 测试一律净化环境（unset RLM_*/PRIME_AGENT_*/PI_*），防写真实 ~/.prime。
- Python 套件用 prime-agent-runtime/.venv/bin/python -m unittest discover -s test；uv run 会捡错解释器。
- 已知豁免：Python 套件 2 条代理环境错误属预期。

## 下一波主题（wave-10，验证 wave-9 提交后开工）

1. 体验走查首跑（Backlog-1）：产出体验问题清单进账本。
2. 模型智能考题集 v1（Backlog-2）：5~8 道固定题 + 会话记录挖掘。
3. 联网调研刷新（任务书要求每波 ≥5 条）：Anthropic/OpenAI agent 工程 + 终端 UI 新实践，对照 Backlog-3/4 答「解决我们哪个实测问题」。
