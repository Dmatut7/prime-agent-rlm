# tl2 批次审查 → 修复任务书（2026-09-30）

> 审查对象：`a826cd63f..03ddbe201`（15 个非合并提交，会话时间线 UI，76 文件 +7285/-454）。
> 审查方式：10 条车道（5×deepseek-v4.1-flash + 5×glm-5.3-prime，全部 thinking=high）+ 母席机器验证与逐条复核。
> 尖端其后有 `56edabae8`（release 0.11.17，折叠 fragment、版本号）与 `24c4850e4`（prompt 下方空行，interactive-mode.ts +6 行、两个测试小改）——均为批外新落，不属本批审查范围；任务书行号取自当前工作树，修复车道开工前先 `git status`＋`git log --oneline -3` 复核尖端。
> 修复开工前置条件：`git status` 干净（除本文件与既存未跟踪 `docs/fork/u6-status-area-redesign-20260922.md`）。

## 一、总账（全部经母席亲手复核或复现）

| 级别 | 条数 | 说明 |
|---|---|---|
| P0 | 0 | 机器侧双跑全绿（母席 + tl2-build 各自归档树：tsgo 0、npm run check 0、test-hygiene 0 新增、本批改动的 45 个测试文件 792 测试全过、SKIP=0。v2 复审补口径：全量套件 898 文件/10321 用例在本机有 14 条环境性既有红/112 skipped，与本批无关） |
| P1 | 3（4 症状） | 三组根因：①隐藏回合条带泄漏（v2 复审改判：1 条 P1 两个症状，母席重跑探针复现）②车道播种点亮 dispatch 之前的行（母席源码级核实）③live/replay「报告落在跑着的步骤里」分叉（A/B 树证据） |
| P2 | 42 | 显示一致性/边界/文案/测试卫生，各车道报告逐条带证据 |
| 批外 | 19 | 含 B1 工具坑（vitest list --json 位置参数覆盖测试源文件）、发版口径问题 |

证据索引（全部保留，勿删）：
- 车道报告：`/tmp/review_tl2_msgs_20260930_0106.md`、`/tmp/review_tl2-strip_20260930_0106.md`、`/tmp/review_tl2_tl2-box_20260930_0107.md`、`/tmp/review_tl2_tl2-blocks_20260930_0113.md`、`/tmp/review_tl2_tl2-commits_20260930_0113.md`、`/tmp/review_tl2_tl2-tests_20260930_0116.md`、`/tmp/review_tl2_tl2-lane_20260930_0118.md`、`/tmp/review_tl2_tl2-build_20260930_0120.md`、`/tmp/review_tl2_tl2-rounds_20260930_0121.md`、`/tmp/review_tl2_wake_20260930_0122.md`
- 母席机器读数：`/tmp/review_tl2_mother_machine_20260930_0103.md`（日志同目录 tl2_mother_*.log）
- 复审进度（两轮制，逐条回填）：v1-p1c（K3）FIX-C 的 P1 维持、修法已按其修正；v4-p2（glm-5.3-prime）26 项全维持、零推翻；v3-p1b（glm-5.3）FIX-B 的 P1 维持、修法定死方向一并推翻方向二；v6-msgsbox（K3）msgs/box 全维持＋四条新发现（已入 FIX-D）；v8-tlrows（K3）13 项第二意见全维持＋FIX-A 三条施工钉；v2-p1a（0902）FIX-A 两 P1 维持但改判「1 条 P1 两症状」、根因定位更正、字面修法被证会引入过期点击区（已换 S1/S2）、全量套件口径纠正、V8 子决定与 O1/第二迟到路径入册；v5/v7/v9 在跑（v5 已续命补做剩余五块）。
- P1 复现探针：`/tmp/tl2probe/compact-hidden{,2,3}.test.ts`（FIX-A 用）、`/tmp/tl2_probe2.mts` + `/tmp/tl2_probe2_{tip,base}.json`（FIX-C 用）、`/tmp/tl2-lane-probe/`（FIX-B 用）

## 二、修复任务（按文件所有权划分，一文件一写者）

通用验收（每个任务都必须，缺一不算完成）：
1. **红绿证明**：新增回归测试先在 `git archive 03ddbe201` 的 /tmp 归档树上跑出红（失败），再在工作树上跑出绿；红绿两次运行的真实输出留在 /tmp。
2. **目标测试**：本任务触及的测试文件 + 相邻受影响簇，`npx tsx ../../node_modules/vitest/dist/cli.js --run test/<文件>` 全绿（从 packages/coding-agent 包根跑；禁 `npm test`/`npm run build`/`npm run dev`）。
3. **门**：`npx tsgo --noEmit` 退出码 0；`biome check` 只查自己改的文件（禁在共享工作树跑 `biome check --write .` 全仓——会动别人的在飞文件）。
4. **提交纪律**：只 `git add` 自己名下文件；提交后 `git archive HEAD | tar -x -C /tmp/<任务名>_pristine`＋软链 node_modules 跑 `npx tsgo --noEmit` 退出码 0 才算交付；禁 `--no-verify`、禁 `git add -A`、禁 amend 已推提交。
5. **changelog fragment**：`packages/coding-agent/.changes/<slug>.md`，一行一条、过去式动词开头、只写用户可见变化。
6. **回滚**：每任务独立提交，回滚=git revert 该提交；不留半成品在工作树。
7. **连续推进**：一气呵成到提交完成才结束回合；卡 30 分钟写死因交付；每步进展追加写进自己的报告文件。

---

### FIX-A（P1×1 两症状＋P2 簇）隐藏回合的条带泄漏 —— fragment `tl-fixc.md`
- 文件（写权限）：`src/modes/interactive/components/turn-strip.ts`、`timeline-rows.ts`、`conversation-components.ts`；测试可新增 `test/tl-fixc-hidden-round.test.ts` 并可更新 `test/tl-fh-compaction.test.ts`、`test/tl-fixa-flow.test.ts` 的受影响断言。
- 问题（v2 复审改判：**P1×1，两个症状，不是一个根因两条 P1**——打了补丁的树上实测「修症状一即自愈症状二」，勿重复修、勿写两套测试）：
  - P1 症状一（rounds/v2）：被 isAckRound 隐藏的回合，其 strip 仍把 sections 印在上一可见回合收尾行之后——收尾行不再是最后一行，违背 0.11.17 文案第 57/63/66/70 行的承诺。复现：`/tmp/tl2probe/compact-hidden.test.ts`；v2 另证触发面比原探针宽：普通事件顺序（agent_start→静默通知→compaction→本回合第一条消息）即漏，不需人造时序——新回合 state 要到 assistantStart 才建（live-turn-flow.ts:341），压缩被 continuableTurn() 记到上一回合（:567-573/1041-1051）。泄漏面不止 afterAnswer：隐藏回合里跑过 git commit 会画出「已提交 abc1234」；changeTrackingIncomplete 会画出「（有些改动没记全）」（这两条按基线对比是批外，但只掐 afterAnswer 的修法堵不住）。
  - P1 症状二（rounds）：迟到的记忆整理行落到收尾行之下。复现：`/tmp/tl2probe/compact-hidden2.test.ts`；真实调用方（RefinementOutcomeMessageComponent，interactive-mode.ts:8286-8287）同样复现。修症状一后此症状自愈（v2 补丁树实测）。
  - P2（strip-3）：endsRequest=false 且只有 afterAnswer 时尾部 gap() 悬挂空 rail 行。
  - P2（blocks-1）：endsInBlankLine 把隐藏 ack 回合的 TurnSummaryComponent 当「画了东西」的边界，多叠一条前导空行。
  - P2（rounds-5/6）：取消的压缩仍用失败口径文案「这次没整理成：已取消」；COMPACTION_CANCELLED 用显示字符串当状态跨模块耦合。
- 修法方向（**v2 复审裁定，取代 rounds 原建议**）：
  - **硬警告：任务书原字面「render() 开头 return []」会引入新缺陷**——它跳过 turn-strip.ts:219-220 的 regions/order 重置，留下过期点击区（v2 在打了字面补丁的归档树上用真实 LiveTurnFlow 实测：strip 渲染 0 行但容器 region 表仍有一条 line=19 属于下一个问题的竖线行，pi-tui 按累计行数偏移不看组件自己画了几行，点那里会莫名开关「完整过程」，两次点击即触发；键盘侧不可达，如实标注）。
  - 安全写法二选一（均经 v2 实测）：S1（推荐）：把门放在 turn-strip.ts:221 之后（facts 检查同一处，形如「facts 为空或本轮回合被隐藏则 return 空行」），5 行补丁在 v2 报告第十三节可直接抄——v2 的 16 个用例全绿、tsgo 退出码 0；S2：把门放进 stripSource.facts()（连接口都不用改）。
  - 根因定位更正（v2 对 rounds 的部分推翻）：不是「StripSource 缺 hidden 信号」——endsRequest（live-turn-flow.ts:781）就是「!isAckRound(state) 且无后一轮被画」，信号在，只是和「后面还有一轮被画」挤在一个布尔里。准确定位是 render() 的 sections 段（turn-strip.ts:269-311）没有任何可见性门。原「不要复用 endsRequest」的警告成立（v2 补实证：前一轮被画、后一轮也被画时 endsRequest=false 而 sections 必须照画）。
  - 「addRowAboveClosingRow 跳过隐藏 strip」是冗余的（render 归零后 :275 的 walk 自动跳过），加了无害但别顺手改 drawsClosingRow() 的语义。
  - 文案改中性口径（如「已取消，未整理」），状态信号用 compaction.cancelled 而非字符串比对（rounds-5/6 维持不变）。
  - V8 子决定（v2 提出，默认已选）：门一加，隐藏回合的「已提交」/「（有些改动没记全）」行从错位显示变成完全不显示——默认把 commitId/trackingIncomplete 纳入 roundHasNews（conversation-components.ts 在本任务写权限内；提交是真活，该回合本就该可见），补测试钉住；若施工时判定语义影响过大，退而在提交说明里明写「接受不显示」，不许默默发生。同时按 O3 在注释里点明 hasEditsRow（turn-strip.ts:269）与 roundHasNews（conversation-components.ts:216-229）口径相反这个深层原因。
- 验收补充（v2 收窄口径）：「收尾行恢复为回合最后一行」**只限隐藏回合场景**——v2 实测存在与本 P1 无关的第二条迟到行路径（最后一个能画的子组件不是画收尾行的 strip 时，live-turn-flow.ts:278 直接 addChild 到末尾；无隐藏回合、空闲时到达报告行也会发生），FIX-A 修不到它，别误判没修好。隐藏回合零渲染行；live 与 replay 两路径一致；regions/order 无残留（开关「完整过程」后点击下一个问题的行不得误触发）。
- 测试写法要求（v2）：新回归测试必须用 fullScreen 风格断言——tl-fd-helpers.ts:122-127 与 :136 的 screenLines/outline 把 TurnStripComponent 过滤掉了，旧风格断言看不见 strip。
- 修法注意（v4 复审）：blocks-1 禁用「先 render 再判空」的朴素修法（每帧多一次全盒渲染），用 isAckRound 状态判定。
- 施工钉（v8 复审）：①hidden 检查必须放在 regions/order 重置**之后**；②与 timelineShowAll/steer 揭示路径不冲突（已核）；③P1-2（迟到记忆行落轮外）在 hidden 信号修好后自愈，不必单独修。
- 复审状态：v4-p2（glm-5.3-prime）四项全部维持、零推翻（探针重跑复现，含 E/F 正反对照）；报告 /tmp/verify_tl2_v4-p2_20260930_0140.md。v2-p1a（0902）断言式探针在 live 与 mode 回放两路复现、4 条应有行为断言当前树全红，「有意设计」推翻角度不成立（CHANGELOG 承诺为真且未兑现）；字面修法补丁 vs 未打补丁同 SHA 各跑全量 898 文件/10321 用例，聚合数字完全相同（8 failed 文件/14 failed 用例/112 skipped，失败集合仅差 1 条计时型红且轻载复跑即绿）→ 补丁新增失败=0；报告 /tmp/verify_tl2_v2-p1a_20260930_0135.md（32.7KB 13 节）。
- 建议模型：glm-5.3-prime，thinking=high。

### FIX-C（P1）live 与 replay「报告落在跑着的步骤里」对齐 —— fragment `tl-fixd.md`
- 文件（写权限）：`src/modes/interactive/live-turn-flow.ts`（注意：与 FIX-B 同文件，**必须排在 FIX-B 之前或之后串行**，本表定 C 先 B 后）；测试新增 live 用例（可用 `test/tl-fixd-live-report-in-step.test.ts`）。
- 问题（wake P1-1）：子代理报告在主人首条回复仍在流式（工具调用已发出、消息未结束）时落地，live 侧会把回合当场封口（finish force）、报告掉到轮外、同一命令在两轮各记一步、收尾行闪现后消失；builder/replay 侧 790ac052d 已修对（awaitsStepResults），两侧成了两幅画。live 侧行为基线即存在，但本批只修一半造成分叉，且提交说明声称已修。
- 根因：live 用 lastStop 判「步骤在跑」，而流式消息 stopReason 初值即 "stop"（openai-completions.ts:184 初始化，:558 才按 finish_reason 改）；`live-turn-flow.ts:212-226` 的唤醒分支因此在工具已发出时仍成立 → `finish({force:true})`。
- 修法方向（**v1-p1c 复审修正版，取代 wake 原建议**）：
  - 两条原方向均被推翻，勿按字面施工：①「把 awaitsStepResults 用到 live 侧」不行——该谓词要求 stopReason==="toolUse"（conversation-components.ts:408），而 live 在跑消息的 stopReason 恰是初值 "stop"（根因本身）；②「lastStop 未定时不起唤醒分支」不行——reset()（live-turn-flow.ts:930）后 lastStop 也是 undefined，簿记轮靠该分支创建 WakeCause 才能被隐藏，砍掉会让簿记轮裸奔上屏。
  - 正确信号：未结束消息带 toolCall 内容，或 state.steps 存在非 done 步（S6 落地时 steps 已是 ["k1:queued"]，信号现成）。
  - 两处共用同一谓词：customMessage 唤醒分支（live-turn-flow.ts:212-226）与 userMessage 的 steered 判（:293-294）——后者同族问题：主人插话撞上首条回复流式发工具调用时同样会拆轮。
  - 安全性（v1 实测）：不误伤「报告先于首答」（tl-fixa-flow:165/182 不命中谓词），不妨碍「回合已 stop 后该拆轮」。
  - 补 live 用例与 builder/replay 对齐（探针 `/tmp/tl2_probe2.mts` 的 S6/S7 场景可直接转正；v1 两树产物 /tmp/v1p1c_{tip,base}.json 可作对照）。
- 复审状态：v1-p1c（K3）独立两树重跑，P1 事实与分级维持；修法按上述修正。报告 /tmp/verify_tl2_v1-p1c_20260930_0138.md。
- 建议模型：deepseek-v4.1-flash，thinking=high。

### FIX-D（P2 簇）行内 markdown 补齐显示路径与边界 —— fragment `tl-fixe.md`
- 文件（写权限）：`src/modes/interactive/components/inline-markdown.ts`、`agent-message.ts`、`user-message.ts`、`system-notice.ts`、`refinement-outcome-message.ts`；测试新增 `test/tl-fixe-inline-markdown.test.ts`。
- 问题（msgs 车道 1-6 ＋ v6 深读新增）：①第三条显示路径没接 inline-markdown——报告行头只删 `**`/反引号（agent-message.ts:107），链接语法连 URL 上屏；报告正文（:427）、system-notice detail、refinement 摘要全部 raw。②双反引号 span 漏字面反引号；③URL 含括号被吞一半；④粗体内反引号被静默删除；⑤支持清单只活在注释里，无单测钉住；⑥（v6，漏报）verdictLevel 否定词表缺口——NEGATED_LEVEL 要求否定词紧邻级别词且词表缺「未/零/查无/并无」，「未发现 P0」「没有发现 P0」「零 P0」「无新增 P0」全部误判红 must，干净报告被画成必修（agent-message.ts:85-90）；⑦（v6，漏报）reportParts 结论只取第一句——「结论：没有 P0。发现 2 个 P1」显示成 ok 灰色，判决被稀释（agent-message.ts:95-98、111）；⑧（v6，**本批引入**）quiet 单行提问 OSC133 标记倒序——user-message.ts:301-302 对单行同时前置 START 与 END+FINAL，输出 B,C,A,文本（本批删 TIMELINE_GAP_ROWS 后单行提问每发必中；legacy 3 行不受影响；现有测试只测 legacy，故漏网）。
- 注意：agent-message.ts 有 bodyCache/contentCache 换行缓存（上批 64f163918），改动后 `turn-box-acceptance` 的 M-3 性能用例与 `tl-report-rows` 断言必须保持绿（v4 复审点名 reportParts 下游）。
- **性能硬门槛（v6 N4）**：splitInline 对「[」密集文本 O(n²)（实测 50KB→1.1s、200KB→18.5s；主循环每轮 text.slice＋LINK.exec 对剩余全文回溯）——把 styling 接进报告正文/notice detail 前必须先加长度护栏（超长文本跳过行内样式或限扫描窗），否则大报告冻帧。
- 复审状态：v4-p2 五项全部维持；v6-msgsbox（K3）二遍深读 msgs 1-6、box 1-4 全维持并独立复现，另交 N1-N4 四条新发现（⑥⑦⑧与性能门槛已入册；N5 hid 折叠行 toggle 待核、N6 news 上限 3 条设计内，均 P3 不入修复）；报告 /tmp/deep_tl2_v6-msgsbox_20260930_0156.md、探针 /tmp/deepv6/。
- 建议模型：glm-5.3-prime，thinking=high。

### FIX-E（P2 簇）turn-box 折叠判词、文案与 light 主题 —— fragment `tl-fixf.md`
- 文件（写权限）：`src/modes/interactive/components/turn-box.ts`、`src/modes/interactive/theme/light.json`；测试更新/新增 `test/tl-fixf-*.test.ts`。
- 问题：①EVENT_NEWS 把「没问题」当消息（turn-box.ts:56 子串 `问题` 命中），长串少折；②文档注释「超过三条就折叠」实际门槛 5 条（两条车道独立撞出）、「钉住切开 run」实际化解 run——注释改对；③「完整过程」不展开折叠行（timelineShowAll 未被 turn-box 认）；④light 主题 timelineLane 3.70:1、timelineOk 4.30:1 两个带字 token 未进本轮修复（strip 车道对比度复算在案）。
- 修法注意（v4 复审）：light.json 里 timelineLane（#b07a2f）拉到 4.5 时注意与 timelineSub（#b05f00）橙色撞色；timelineFaint 是否也拉到 4.5 是老板拍板项（见第五节 3）。
- 复审状态：v4-p2 五项全部维持（box-1 count=4 不折、box-2 钉住化解整串、box-3「没问题」命中均探针重跑复现；box-1/2 错的只是 docstring——tl-int-real.test.ts:542-548 把行为钉死成 [2,3,4] 零折叠）。
- 建议模型：glm-5.3-prime，thinking=high。

### FIX-B（P1＋P2）车道播种与收账（排在 FIX-C 之后串行）—— fragment `tl-fixg.md`
- 文件（写权限）：`src/modes/interactive/components/timeline-lane.ts`、`src/modes/interactive/live-turn-flow.ts`；测试新增 `test/tl-fixg-lane-seed.test.ts`。
- 问题：①P1（lane 车道）：新窗口播种把 dispatch 之前整段点亮——seedLane 用 `windowStart-1` 当出战时刻（live-turn-flow.ts:890），而 LaneSpans.open() 对同名已开 span 不收紧 from（timeline-lane.ts:29「already out: nothing changes」），回放学到的真实出战时刻覆盖不了。修法（**v3-p1b 复审裁定：只采方向一**）：open() 对已开 span 用 Math.max 收紧 from。「播种仅限 dispatch 确在窗口外」（方向二）被推翻——判据要预扫 windowed，存在同名重派反例（旧问的同名记录在窗口内 → 误判 → 跳过播种 → 新孩子车道整段消失，比现状更糟）。可加「播种 span 打标记」防御 timeline-lane.ts:106 的 Date.now() 兜底。方向一安全性经运行时补丁模拟实测：bug 场景 from 修正为真实出战时刻、dispatch 前行归零、与无快照对照逐字段一致；设计场景（dispatch 在窗口外，tl-fg-lane.test.ts:229-248）零回归；反例搜索未找到（open 调用传的都是条目自己的 startedAt）。②P2（wake 待核；v8 复审收窄口径：只丢「无 span 的孤立 return」）＋ v8 N1（P2·待核，同族第二机制）：turn-timeline.ts upsertSubagent 按 lane 合并旧条目，重派孩子 status=running 却残留上一任 endedAt，reseedLane 用过期 returnedAt 把仍在跑的重派孩子直接标 done（probe1 实测；可达性受同辈名唯一约束影响，待核）——与 wake P2-3 合并修。③P2（wake 待核）：「交回过报告的孩子」按 sessionName 记（conversation-components.ts:140-144），车道键却带 activeSessionId——同名重派时新孩子的静默结束被当重复、整轮被藏。④P2（lane）：子代理块短名撞名（audit-a-quick/check-a-slow 都显示「A」），撞名退回原名前 16 列。
- 验收补充：带播种的窗口里 dispatch 之前的行不带 ┆（回归测试直接用 v3 探针 A/B/C/D 四场景：/tmp/verify_tl2_v3p1b/probe-v3p1b.ts，含设计场景零回归的对照）。
- 复审状态：v3-p1b（glm-5.3）维持 P1——原探针重跑＋机制插桩证实（播种 span 经 interactive-mode.ts:8636 的 restore()→add() 装入，回放侧 open() 被 timeline-lane.ts:29 早退挡住）；三条对抗线全败（仓库自己的 tl-int-real.test.ts:164-167 断言 dispatch 前不亮）。报告 /tmp/verify_tl2_v3-p1b_20260930_0142.md。
- 建议模型：deepseek-v4.1-flash，thinking=high。

### FIX-F（P2 簇）测试卫生与假宿主去重（排在 FIX-A 之后串行）—— 无 fragment（内部改动，走 no-changelog 口径）
- 文件（写权限）：`test/tl-fc-host.ts`、`test/tl-fd-helpers.ts`、`test/tl-fixa-flow.test.ts`、`test/tl-fd-box.test.ts`、`test/tl-fc-spawn.test.ts`、`test/tl-int-real.test.ts`、`test/tl-fg-closing.test.ts`、`test/tl-fixb-*.test.ts`（断言质量项）、新增共享助手 `test/tl-fix-host.ts`。
- 问题（tests 车道 2.1-2.8）：四处「影子宿主＋影子原型」探私有成员（规则明文禁止，闸门只认下划线成员所以看不见）；四份逐行相同的 createHost 假宿主；两处数据驱动循环缺长度守卫；`?? []` 把「组件不存在」与「渲染为空」等价；plainLines 把空行规则归一化掉；低信息量断言。
- 修法：优先改走公共入口；确属冻结存量的写法补 `// test-hygiene-allow: <具体可查理由>`；createHost 合并成一份共享助手。**是否扩展 check-test-private-probes.mjs 让它认得出原型强转**（会让仓内存量 156 处现形、需动基线）单列为决策项，不在本任务内擅自做。
- 复审状态：v4-p2 七项＋低信息断言一项全部维持（闸门重跑 ok:true/1136 文件，2.1-2.8 各 file:line 核实）。
- 建议模型：deepseek-v4.1-flash，thinking=high。

### FIX-G（P2）回放与 live 的重试文案一致 —— fragment `tl-fixh.md`
- 文件（写权限）：`src/core/agent-session.ts`（如需 `src/core/messages.ts`）；测试新增/更新对应回放用例。
- 问题（rounds-2）：live「换到备用模型 glm-5.3，已自动重试」vs 回放「模型服务繁忙，已自动重试」——转写不带 reason/backupModel（agent-session.ts:20186-20193）。修法：把 reason/backupModel 落进持久化消息，回放同文案。新字段必须可选——旧会话转写没有这两个字段也要能回放（v4 复审）。施工时顺手判 v8 N3：回放合成重试行对「compaction 续跑」也一律说「已自动重试」（timeline-rows.ts:1388-1408），看是否该区分口径。
- 复审状态：v4-p2 维持（live/回放文案分叉探针重跑复现）。
- 建议模型：glm-5.3，thinking=high。

## 三、调度表（并发上限 8；「还有窗口在工作」期间不启动）

| 波次 | 任务 | 并行性 | 前置 |
|---|---|---|---|
| 1 | FIX-A、FIX-C、FIX-D、FIX-E、FIX-G | 5 条并行（文件集两两不相交） | 工作树干净 |
| 2 | FIX-B | 单独 | FIX-C 已提交（同文件 live-turn-flow.ts） |
| 3 | FIX-F | 单独 | FIX-A 已提交（同测试域） |

## 四、不修/缓修/记录项（不在本修复批内动手）

1. **已发布 CHANGELOG 的两句矛盾**（0.11.17 小节 31 行 vs 42 行）与 tl-fixa 措辞差：仓库规则明文禁止修改已发布版本小节——只记录，下个发版 fragment 里写清「合并口径」。
2. **`ui.startLane` 死状态移除**：仓库规则「删除看似有意的功能前先问」——待老板确认是否保留给后续功能再动。
3. **Python cell 判据只认内核 cell 记录**（detached 任务里 rlm.run 零记录）：运行时设计级改动，另立设计任务。
4. **同毫秒消息合并身份只比时间戳**（rounds-4，默认 baseDelayMs=500 不可达；wake 确认机制真但入口不可达）：低优先加固项，可与 FIX-C 同顺手做（同一片代码），不强制。
5. **合并提交 bfd6391fa 带入两个父都没有的守卫**：追溯性记录，无需改码；后续合并解冲突时独立提交或提交说明写明。
8. **压缩归属（v2 O1）**：compactionStart 用 continuableTurn() 不问回合是否被画（live-turn-flow.ts:567-573/1041-1051），压缩常被记到上一回合——FIX-A 的门只堵显示后果，改归属牵动 4 个调用点，另议。
9. **迟到行落收尾行之下的第二路径（v2 第十一节）**：与隐藏回合无关，只要最后一个能画的子组件不是画收尾行的 strip，live-turn-flow.ts:278 就 addChild 到末尾（空闲时报告行+整理行实测复现）——FIX-A 修不到，需独立分析后另立任务。
6. **B1 工具坑**：AGENTS.md「Commands」节补一句警示（`vitest list --json` 禁带位置参数、只在 /tmp 归档树带过滤器跑）——文档微改，单独一笔提交，等安静窗口。
7. **`docs/fork/u6-status-area-redesign-20260922.md` 未跟踪文件**：非本批所留，不动，待其归属方处置。

## 五、需老板拍板（带默认）

1. **发版口径**：fork 门禁（assertReleaseAllowed，唯一通道 PRIME_AGENT_ALLOW_RELEASE=1）vs 已推 origin 的 v0.11.16/v0.11.17 标签。`.changes/README.md` 说「fragment 只收集不消费、fork 上拒绝发版」，实际 0.11.17 把 15 个 fragment 折叠进 CHANGELOG 并打了标签。默认按「有意放行（本人设了逃逸变量）」处理，README 补一句实况；若非本人所为则按流程事故追查。
2. **测试卫生闸门要不要扩**（FIX-F 的决策项）：扩展会让存量 156 处原型强转现形。默认不扩，先清新增、存量随基线自然收缩。
3. **timelineFaint 要不要一并拉到 4.5**（v4 复审提出的不对称）：timelineFaint（#7d829a，白底 3.80:1）承担的正文（收尾行/折叠行）比 timelineLane（#b07a2f，3.70:1）更多，但一个不修、一个进 FIX-E——现行分界是「42b83a598 的提交信息背书过 3.5/3.0 折衷」而非「带多少字」。默认保持现状（成文折衷、测试已钉），要拉就把两个一起拉并同步改测试阈值。

## 六、修复完成后的收尾（提醒，不属本批）

- 全量回归：45＋新增测试文件一次跑完对账（collected == passed+failed+skipped）。
- FORK_NOTES.md 更新（本仓推送硬规则）后统一 push；推送前不 amend。
- 母席复核：抽读 diff＋重跑 P1 探针三件套确认修复后行为。
