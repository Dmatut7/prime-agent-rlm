# R4 拾取台账 · U3 席（agents-view 三列扩展）

> 席位：r4-u3（glm-5.3-prime）。分支 r4/u3，基线 a2f864744，worktree /Users/a1/Desktop/ai/pa-r4-u3。本台账只记本席施工件；主干总台账由母席维护。格式照 runbook §六。SKIP/弃 hunk/撞名处置均记。

| # | sha/件 | 落点 commit | 冲突文件数 | 真MD处置 | 撞名/弃 hunk | 定向测试结果 | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | U3 agents-view 三列（任务卡§四-U3） | 1bd2db8e4 | 0（纯 fork 新件，基线 a2f864744 干净树施工） | —（无上游笔；本席原生 UI 件） | 无撞名；无弃 hunk | 新建 test/agents-view-columns.test.ts 7/7 绿；定向簇 468/468 绿（agents-view 9 文件＋daemon-session-list＋agent-roster＋daemon-mode）；npm run check EXIT=0 全输出落盘 /tmp/r4_u3_full_check_20260922_034211.log；check:test-hygiene 本席新增探针 0（门红 10 处＝主干笔带入的既有库存，git show a2f864744 实证在基线就存在，归主干席 --update-baseline 处置） | 三刀：①daemon-session-list.ts（roster 透出点）SessionSummary 增可选 settled/durationMs/answerPreview（U2 wire 口径：旧 daemon 缺字段→UI 本地降级），summaryForActiveSession 组装＋指纹值比较防 memo 冻结陈旧值，inactive 行派生 durationMs/settled，answer 预览=最后一条 assistant 消息首行 compactRlmText 截 200 字（WeakMap 按消息对象缓存、扫描 512 字上限）；②agents-view-state.ts 增 answer 行 kind（非选中上下文行，仿 subagent-code），行下紧贴 ↳ 预览行（行数增的来源），resolveAgentsViewSettled/SessionDurationMs 降级规则（含 needs_input＝开口不算收口），daemon 搜索语料并入 answerPreview；③agents-view-mode.ts usage 布局前置 set/dur 两列（✓/…/空＋45s/1h10m/2d4h 格式），既有测试锚全部保绿（前置设计）。验收：改前后渲染 8→10 行（每个有回复的行 +1 预览行），行信息密度＋3 列，读数 /tmp/r4_u3_before_render.txt 与 /tmp/r4_u3_after_render.txt。fragment u3-agents-view-columns.md 已落 |
