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

## 当前状态（2026-10-03 深夜，wave-33 已 SHIP）

- HEAD = 见 git log（六批：暖池二期、agents-view 同型修、ambient 间隙补检、autocompact 两洞、
  compile cache 分发、FORK_NOTES+账本）。
- wave-33 关键数字：暖池 claim 首建税 60ms 移出受理路径（首 create 86.4→75.8ms）；compile cache
  随包分发（首装冷启首帧 398→328ms、--help 185→115ms）；ambient 间隙补检（≥0.5s 间隙有界
  补检一次）；考题基线 7/7（stepfun step-5-preview，$0；2.29M tok；判分器自检 13/13）。
- 模型智能首条失败模式立项候选：过度自验（EX-4 约 60-70% 花费在答案完成后的冗余验证循环）——
  提示词/编排侧治，下波。
- 调研：暖池遥测三件套（Codex 命名可抄：spawn duration / spare age at claim / pool depth）立项
  wave-34；Z.AI 订阅页标题出现 GLM-5.3 满血/5.2/5-Turbo（下波复核模型集）。
- 门禁：check EXIT 0、hygiene OK、单测 9533 绿（3 例负载抖动隔离即绿）、suite 1669/1669、
  tui 1262/1262、python 768（1 例负载阈值隔离即绿）。
- 恢复指令：读 Backlog + 下一波主题。

## 波次日志（0~8 详见 swarm-loop-plan-20261001.md）

- 波次 1~8：30+ 项修复，schema rev 40→44，CI 转绿（run 36861026576/36866050779）。
- 波次 9（2026-10-02 收尾）：w9a~w9h 八批 + 主席 digest/泵调度/类型错修复，六路验证 + 四路修复，73 文件。
  教训沉淀：①门禁管道必须 pipefail；②test-hygiene 豁免 marker 必须在违规行紧邻上一行且单行；
  ③digest 覆盖连接侧镜像 DTO 的注释改动；④Python 套件用 .venv/bin/python -m unittest（uv run 捡错解释器）；
  ⑤tui 包用 node:test 不用 vitest。
- 波次 10（2026-10-02，AUDIT/RESEARCH，12 路并行，产物 /tmp/wave10/）：
  - 痛点：S1 goal 提前收工（09-30 一小时 4 连骂，goals.ts 无持续语义）与 S2 重启崩栈
    （daemon-supervisor-ownership.ts:652 active admission 直接抛，无 catch）为仅存 P0；磁盘垃圾 4.1GB 待收敛证据。
  - 走查：/model 菜单 claude-code 谎报登录态；Esc 静默销毁草稿不可恢复；截断策略不一（丢单位）；
    CLI/stdout 不做宽度换行；PRIME_AGENT_HOME 是假变量（真名 PRIME_AGENT_CODING_AGENT_DIR），
    daemon socket 不随 HOME 隔离。对照：双击 Esc 应直接编辑重发最近消息；单代理会话费用不可见。
  - 智能：GLM 工具名崩溃 152 连错 44 分钟（全库 195 次 100% GLM）；幻觉工具名跨家 37 次；
    组织记忆检索靠自觉（二次立项白烧一整波）。考题集 v1 已可跑（/tmp/wave10/exam-v1/）。
  - 调研：Anthropic Sonnet/Opus 5.5 破坏性变更未适配（anthropic.ts:870/1167/1180，Sonnet 4.5 退役死线
    2026-11-30）；OpenAI 过载 429→503 未适配（retry-cap.ts:28）；kitty 键盘模式栈疑似活 bug
    （terminal.ts:266 只主屏 push）；多家已上「探测后启用」范式。
  - 审计：isProcessAlive 6 份 3 语义（僵尸分歧）；sleep/delay 11 份本地拷贝 abort 契约相反；
    handleCommand cc=230/141 两个巨型 dispatch；MCP outcome 死族等死代码。
  - 画像：daemon 冷启 240-260ms、RPC 777ms、TUI 首帧 486ms、每会话边际 ~200MB；profile:tui 挂死
    （main.ts:264-268 无 daemon 路径等永不到来的 RPC）；bench-attach-bytes 协议过期且量错对象
    （真实 slim 收益 -88.4% 它测出 -0.0%）。
  - 事故披露：PERF 席误杀 2 个空闲 RLM 内核（父进程已自动重生）、经 claude-code 桥真实出网 1 条
    （~34 token 立即中止）；ux120 席登记 supervisor-owners mtime 瞬态碰一次（无持久写入）。

## Backlog（按影响×证据÷代价粗排；连续 3 波没人挑降级或删）

1. ~~S1 goal 提前收工~~ 销账（wave-11：/goal --persistent）。
2. ~~S2 重启崩栈~~ 销账（wave-11：有界等待+CLI 重试+干净报错）。
3. ~~Anthropic 5.5 缺口~~ 销账（wave-11：目录+塑形+默认切换+503 分类）。残余：Bedrock 5.5 实测、
   Sonnet 4.5 存量迁移提示、Prime 路由 1M/200k 实测（需 PRIME_API_KEY）。
4. ~~工具错误熔断~~ 销账（wave-11：warn 3 / terminate 5 + 自纠回执）。残余：settings.json 键位接线
   （现仅 loop 级可配）。
5. ~~画像基建~~ 销账（wave-11：profile:tui 修复 + bench 重写）。残余：kernel venv 硬编码 ~/.prime
   参数化（bootstrap.ts:585）、worker socket 不认 --daemon-socket。
6. 【UX 插队候选·部分销账】wave-12 已修：Esc stash、徽标诚实、截断统一、CLI 换行。残余：
   双击 Esc 落点=编辑重发最近用户消息（/tree 选择器默认高亮+Enter fork）；watermark 可选花费段
   （默认关）；claude-code 菜单内登录流仍是通用 API-key 对话框（应外链 `claude auth login`）；
   CLAUDE_CODE_OAUTH_TOKEN 单设时 daemon 侧不认（packages/ai env-api-keys）。
7. 【终端】kitty 键盘模式栈疑似活 bug（terminal.ts:266 主屏 push 一次，enterAltScreen 不重推）先真机
   复核；探测总线改 DA 栅栏+分版本 DECRQM（消盲发 2026/双定时器/粘贴内应答，是 2027/2031/图片占位前置）。
8. 【审计债】isProcessAlive 6 份 3 语义收敛（僵尸分歧=正确性）；sleep/delay 11 份本地拷贝收敛；
   MCP outcome 死族 + r3 F26 僵尸符号删除；handleCommand 双 switch 表化（cc 230/141）；
   AgentSession RLM child-run 簇抽出（god class 第一刀，churn 192 commits/30d）。
9. 【文档-3】流式增量全量重发：10 万字符→1.14GB 放大，需设计。对照：Claude Code 检查点剪枝 79×；
   首帧 486ms 有 3× 余量，先协议减帧不重写。
10. 【组织记忆】立项/开工前强制检索勘误台账+在途任务（C4/C5 教训：二次立项白烧一整波），编排层硬门。
11. 【文档-9 剩余】429 照表、重试定时器不可取消、子代理回合级错误无重试（SDK 层零事件已销账）。
12. 【跨会话背压】子代理 per-session 上限已有（853ea7dcb），残余跨会话背压；Anthropic 复盘：多代理
    15× token，提示词内嵌 effort 缩放规则。
13. 【slim 回填 inline 触发器】inline 模式无回填入口（动 core/keybindings.ts + slash-commands.ts）。
14. 【磁盘垃圾收敛证据】~/.prime/agent 仍 4.1GB（artifacts 2.1GB、3 代 venv 1.2GB vs 设计留 1 代）；
    回收器已上（wave-5），缺收敛数字。
15. 【环境假失败治理】ai 包 ollama 门控测试缺陷（beforeAll 提前 return 不真 skip）；
    image-model 8 例对 claude ambient 凭证敏感（改用限定名可根治）；tui vitest.config.ts 历史错配；
    python 两条 ResourceWarning；dev 机真实 key 时 getAvailable 断言漂移（W5-C 遗留③）；
    4603 shutdown 测试负载敏感（已知，未治）。
16. 【安全簇 文档-12/13】供应链校验、traces 上传零脱敏、auth.json 0644 —— 硬约束：先写方案问老板。
17. 【智能-4 边角】aborted 回合不占「最近思考保留」名额（minor）。
18. 【考题集运营】EX-3 恢复链无 CI 覆盖（faux 模型+真 CLI 子进程可补）；双模型 A/B 待首基线后定。

## 未决项 / 坑

- daemon digest 覆盖连接侧镜像 DTO：改 agent-connection/types.ts 里 AgentConnectionSnapshot 等切片区
  （含纯注释）都会动 digest，提交前必跑 daemon-protocol 测试。wave-8 栽过一次，wave-9 原地重算销账。
- CI 环境红与本机环境红要分开归因（claude CLI 探测有 PI_DISABLE_CLAUDE_CODE_DETECTION 豁免；ollama
  装了二进制没起 server 会触发 ai 包 6 条假失败，PI_NO_LOCAL_LLM=1 豁免）。
- 测试一律净化环境（unset RLM_*/PRIME_AGENT_*/PI_*），防写真实 ~/.prime；走查/画像用
  PRIME_AGENT_CODING_AGENT_DIR + --daemon-socket 双重隔离（PRIME_AGENT_HOME 不存在；socket 不随 HOME 隔离）。
- Python 套件用 prime-agent-runtime/.venv/bin/python -m unittest discover -s test；uv run 会捡错解释器。
- 已知豁免：Python 套件 2 条代理环境错误属预期（wave-10 未复现）。
- 并行纪律实证：wave-10 期间 3 席各自报告 ledger 被「别人」改——都是主席在写；lane 一律不写仓内文件。

## 下一波主题（wave-34 候选）

1. 【过度自验治理】考题基线头号失败模式（EX-4 冗余验证烧 60-70% 花费）：提示词加「答案落盘
   即交卷」约束 / 编排侧自检次数上限；改完重跑 EX-4 看 token 曲线。
2. 【暖池遥测三件套】照 Codex 命名：spawn duration{status} / spare age at claim{outcome} /
   pool depth gauge + 回收归因（/tmp/wave33/research.md §1）。
3. 【per-model 窗口/autocompact 主体】服务端权威窗口 + 首请求 ≤1.5s 有界等待 + 切模型即时
   重绑（安全子集 wave-33 已落：zero-usage 兜底 + refusal 换模型重试）。
4. 【Z.AI 模型集复核】订阅页标题出现 GLM-5.3 满血/5.2/5-Turbo，跑 generate-models.ts 核。
5. 【/model 两次 Enter】走查观察项复核（wave-32 遗留）。
6. 【记忆帽裁决】仍待老板三选一；turn 级内存观测（Codex codex.turn.memory 式）可先落。
