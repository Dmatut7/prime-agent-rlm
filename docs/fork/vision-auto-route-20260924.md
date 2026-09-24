# 工单：主模型看不了图时，自动借看图模型（视觉路由）

- 派单：PM 口头工单 2026-09-24 晚（「拿他为什么不智能，能自己路由到对应的比较好的视觉模型呢」→「可以。到时候可以提 pr」）
- 起草：Qwen 值班会话（当晚现场排查后起草）
- 状态：**已施工（PM 直派）**——分支 `feat/image-route-midrun-bootstrap`，见文末施工记录；待 PR 合并
- 施工仓库：本仓（Dmatut7/prime-agent-rlm，主分支 merge/repl-kernel）
- 性质：源码功能新增（非 docs-only），按工单协议 v4 走「决策类=三模型同题盲出」规划

---

## 一、目标（4 格之 1）

一句话：**会话模型看不了图时，自动借一个能看图的模型把图读完交回**——不许丢图、不许整轮霸占看图模型、不许人肉切模型。

- 触发条件：本轮 user 消息或 toolResult 含 image 块，且当前模型在 models.json 的 `input` 不含 `"image"`
- 期望行为：有图的那次请求路由到看图模型跑；无图的请求一律仍用会话模型；读完即交回（沿用 0.11.4 已修好的语义）
- 生效范围：主会话与子代理会话都要生效

## 二、资源与禁区（4 格之 2）

**落点**（行号会漂，施工前按符号 grep）：

- `packages/ai/src/providers/openai-completions.ts`：user 消息进图门禁 ~1197、toolResult 门禁 ~1333–1370（`if (hasImages && model.input.includes("image"))`）——不含 image 的模型，图片**静默丢弃**，toolResult 只剩 `"(see attached image)"` 占位
- 换模型链：settings `providerFallbackModels`（settings-manager.ts）+ agent-session「对话里有图时只换到能看图的」分支——**现状只在失败/额度耗尽/乱调工具时触发（救火式），静默丢图不报错所以永远不触发**
- 0.11.4「一张图整轮切看图模型 → 读完即交回」的修复是本工单的机制底座：把触发条件从「失败回退」扩到「有图前置路由」

**禁区**：

- models.json 能力表语义不动（`input` 数组仍是唯一事实源）
- 无图时不许换模型（稳定性红线）
- 新设置项若需要，走会话命令正门（settings.json 有守卫，外部直写会被回滚——9/24 教训）
- 源码不写死模型名单（0.11.3 决定保持，选模顺序读配置与能力表）
- 子代理路由不得破坏 spawn ledger / stall 看门狗既有豁免口径

**两方案**（建议 B 为主、A 为降级；规划阶段可盲评裁决）：

- **方案 B（借脑整轮）**：有图的那次请求整体路由到看图模型，完成后交回。无损（图里的小字/图表数字不丢精度）；要求看图模型能带工具调用跑完该轮（如 kimi-k2.7-code）
- **方案 A（借眼转述）**：用看图模型把图转成文字描述插回上下文，主模型继续。降级路径：无可用看图模型、或该轮不能整体切换时
- 选模顺序：同 provider 能看图的 → `providerFallbackModels` 里能看图的 → models.json 全表能看图的（兼顾 reasoning / 上下文窗口）

## 三、边界预算（4 格之 3）

- 每条行为红→绿测试钉死，不许只改不钉（fork 既有规矩）
- 施工走席位规矩：自有 worktree 提交、不碰共享树脏态
- 夜间施工不打断生产 daemon 与在跑会话（当前主力机两 daemon 46266/68646 长期在跑）
- 本工单不动运行中的 models.json（改了也只有新进程读到）

## 四、报告格式（4 格之 4）

- `FORK_NOTES.md` 新增一节，大白话写「用户会遇到什么」（0.11.3 起的写法）
- 红绿测试清单 + 实测对照：glm-5.3-prime 会话贴图提问，改前 vs 改后
- **PR**：提交到本仓（唯一主仓 Dmatut7/prime-agent-rlm）；commits 独立可 cherry-pick；将来若回馈官方，按 CONTRIBUTING 整理成独立提交再走官方流程（单向同步规矩不变）

## 五、动机（当晚三起现场，共同根因）

1. 水务-夜班总指挥：登录验证码 OCR 瞎猜 28 次锁号（GLM 看不了图是根因，第二个账号又 26 次）
2. obsidian-note 会话：自己雇 qwen3-vl-flash 子代理看图，烧 8.7M token（土法绕行）
3. PM 本人被迫人肉切 kimi-k2.7-code

共同根因：**图片被静默丢弃、不报错 → 救火式换模型链永远不触发 → 系统不知道自己瞎**。

## 六、验收清单（红→绿）

1. glm-5.3-prime 会话贴图 + 问图内容 → 回答基于图（改前：`"(see attached image)"` 或瞎猜）
2. toolResult 带截图（如浏览器截图）同理
3. 路由全程无报错、无 400、无 Connection error
4. 无图请求仍用会话模型（模型使用与费用不漂移）
5. 下一轮无图 → 自动交回主模型（不霸占）
6. 子代理会话（rlm spawn）同样路由
7. 不可用看图模型时走方案 A 或明确告知，不许静默丢图

## 七、施工记录（2026-09-24，Qwen 值班会话，PM 直派）

排查结论：0.11.2 起 harness **已有**图片路由机制（发轮时按批路由 + 读完即交回 + 交回后再路由），PM 机器也已配置 imageModel=kimi-k3。真正卡住的是两个缺口，本 PR 修这两个：

- **缺口 1（技能门禁）**：attach_image 的预检只看「当前服务模型能不能看图」，不能就拒绝——路由层明明能借看图模型，技能却把第一张图拦死（鸡生蛋）。
- **缺口 2（中途无路由）**：运行中 toolResult 第一次带图时，只有「已路由且已交回」的轮次会再路由；从未路由过的纯文本轮次中途来图，图片被服务商静默丢弃。

改动（分支 `feat/image-route-midrun-bootstrap`，基于 v0.11.5）：

- `agent-session.ts`：`_rerouteToImageModelForNewImages` 扩出中途引导分支（无路由且会话模型看不了图时当场解析路由）；新增只读 host 请求 `image_route.info`（挂进 CANCELLABLE 白名单）；路由解析输入三处共用 `_imageRouteResolverInputs()`。中途解析失败（imageModel 没配/配坏）只记 warn 不打断运行——发轮路径的报错语义不变（用户亲手发的图照旧硬报错）。
- `attach_image.py`：门禁改为「model.info 看不了图 → 问 image_route.info → 可路由就放行」；宿主不认识该请求（老版本）退回原换模型提示；不可路由时报错文案直接给出 settings.imageModel 的修法。
- 测试：faux 套件 +3（中途首图引导、无路由不硬切、blockImages 不路由）；内核桥 +3、会话级 +2（放行并路由后续轮、无路由时报修法）；白名单钉 image_route.info。红→绿全程可复现（红：中途来图 served 全程 faux-1；绿：faux-vision 接手再交回）。
- 验证环境注意：主力机生产 venv 被在跑 daemon 占住（generation in use，技能替换被延迟），测试须 `PRIME_AGENT_KERNEL_VENV=<隔离目录>` 跑，否则跑的是共享树旧技能；CLI 走 daemon 的链路不认该变量（env 不穿透 worker），真机验证须在进程内直跑。
- 真机端到端（2026-09-24 下午，脚本在施工 worktree `.smoke/live-check.ts`，未入库可复现）：glm-5.3-prime 文本会话 + 真实百炼密钥，中途 attach_image 真图 → 服务序列 **glm-5.3-prime → kimi-k3**（真实请求，无 400、无 Connection error），kimi-k3 逐字读出图中暗号 **BANANA-7391**，交回会话模型收尾。验收 1/2/3/5 真机钉死；4/7 由红绿套件钉死；6（子代理）待合并后按第四格补做。
