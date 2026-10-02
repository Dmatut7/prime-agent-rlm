# 记忆系统召回设计稿（2026-10-02，wave-16 调研 → wave-17 施工依据）

老板指令：记忆优化不要带缺陷的优化，好好研究。本文是五路调研（M16-1~5，证据在 /tmp/wave16/）的综合裁决。

## 一、实测现状（数字，不是感觉）

- 库存：global store 1574 条 / 7.2MB，47% 挤在默认 `general` path（path 分类塌缩：597 个 path）；无 TTL、无去重（实测 28 组同日近重复）、无容量上限。
- 召回窗：TS digest 每 kind 6 条 × 180 字符 → **99.6% 的条目在窗外不存在**（0.38% 条目、0.017% 字节）。
- 检索器：harness.search（tf-idf + CJK bigram）实测 28ms/query、孪生探针召回 96.5%——质量够，但 prompt 从不教它：263 份真实会话里只用了 31 次/5 会话（1.9%），overview 用了 1102 次。**prompt 文档化什么，模型就用什么。**
- 溢出不一致：TS digest 溢出行匿名（`+1568 more`），Python overview 具名（id+title，封顶 50 行）。
- 失败归因（M16-2 实案）：写入端没写（旗舰案：08-31 裁定没入库，09-20 被骂）、召回靠自觉、压缩摘要 94.5% 无文件交接、重启断片（wave-14 已修一半：resume briefing 已上）。

## 二、外部范式（全部带 URL，见 /tmp/wave16/memory-peers.md、memory-frameworks.md）

**关键事实：2025-2026 没有一家主流 agent 产品在核心记忆管道里用向量嵌入。** Claude Code（MEMORY.md 索引 200 行/25KB 硬上限、超限写报错回环）、Codex（memory v2：后台抽取→独立 consolidation→版本化隔离）、Gemini（候选 patch→审批 inbox→原子应用）、Anthropic context engineering（hybrid=预载+JIT 检索）、Chroma context-rot（18 模型 19 万次调用：focused ~300 token 显著优于全量塞入）、Lost-in-the-Middle。

明确否决：cognee 图谱（过重）、mem0 ADD-only（与 versioned rollback 冲突）、MIRIX 多 agent 路由（过度工程）、MemAgent RL（无训练设施）、embedding 栈本期不引入（零依赖约束 + 实测词面缺口仅「英文 query 打中文库」一类 + 全量目录 12 万 token 物理不可注入）。embedding 复活条件：插桩数据显示跨语言/语义类召回失败占比显著上升。

## 三、设计决策（按序施工，每步独立可验证、可回滚）

### 阶段 1：接线（零新机制，先红后绿）

1. prompt 教检索：`rlm.ts:105` 的工具面只列 CRUD+overview——补 search/get 的教学与「开工前、派单前、被问『记得吗』前必检索」的纪律句；digest 溢出行从匿名改具名（移植 Python overview 的 id+title 目录，refinement.ts:427-429）。
2. 写路径软门：refine.run()/create 前强制先 search 同类（防 28 组近重复），回执加「0 hits ≠ 不存在」标注。
3. 排序多信号化（零依赖）：BM25-lite + path/id 前缀 + 时间感知 + scope 先验融合（mem0 式本地融合，不加库）。

### 阶段 2：digest 两层重构

全量紧凑索引（id+title 一行一条，总字节硬上限——参考 Claude 25KB/Codex 32KiB——超限在写入侧报错回环）+ 相关度 top-k 详情保留。红线：digest 总面值 ≤ 现值 2 倍（context-rot 证据）。顺带归并 597 个塌缩 path（写入侧引导归到受控词表）。

### 阶段 3：写入侧防腐烂

写入规约补两条通例（「代码可推导者不写」「与其他层重复的不写」）+ 定期 consolidation 独立工序（合并/过期/删除，Codex memory v2 范本，不依赖模型当场自觉 update）。

### A/B 验证（先建基线再动工）

- 离线召回率：harness.search 现有 parity 仪器上跑 recall@k（基线 96.5%）。
- 在线插桩：每会话检索次数/命中率（基线 31 次/5 会话=1.9%）。
- 考题集加记忆题（EX-8：跨会话回忆一道只有记忆库才知道答案的题）。
- token 红线：digest 面值 ≤2 倍现值。

## 四、明确不做

单独加大窗口（context-rot/lost-in-the-middle 实证否决）；embedding 栈（本期）；审批 inbox（Gemini 式）——写入审批与「自主无人值守」冲突，用 consolidation 工序替代；任何 <7 天的新依赖。
