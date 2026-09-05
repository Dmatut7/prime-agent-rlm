# 全面复审发现（R3 · 2026-09-05）

> 2026-09-05 对整个 fork 做的全面复审发现记录。汇总入口见根目录 **`FORK_NOTES.md`**；修复计划见 **`fix-plan-r3.md`**。

## 复审方法
- **6 个维度（lane）**：L1 业务逻辑正确性/健壮性、L2 性能、L3 代码质量/优雅性/架构、L4 daemon 协议/wire 兼容、L5 AI provider 层、L0 垃圾代码审计。
- **异构双审**：每个 lane 由两个**不同**模型（`qwen3.8-max-0902` 与 `kimi-k3`）独立审，再双向 cross-check 逐条对质收敛——避免单模型盲区。每条发现标注 **[收敛度]**（几个 lane / 几个模型独立撞到同一根因）与 **[证据级]**（执行复现 / 磁盘实证 / bench / 行号静态 / 外部事实）。
- **总闸原则**：任何优化都不能降低 AI 的能力（凌驾于性能 / 简洁 / 行数之上）。每个修复带强制验收字段「capability impact」：提升 / 中性（须证输出逐字不变）/ 禁止降低。这条原则在实战中抓出并否决了 2 个"看似优化、实则降能力"的修法。

## 严重度排序
严重度 = 影响 × 触发概率（和解"按影响评级"与"按触发概率评级"两种口径）。下面 28 个修复簇（F1-F28）按优先级分四批：第一批=高影响×高触发概率（多 lane 收敛），第二批=高影响×条件触发，第三批=架构重构（高工程），第四批=垃圾代码清理。

## §6 跨 lane 综合 · 去重 · 严重度总排(影响×触发概率)· 修复簇
方法:5 lane × 0902+K3 双向 cross-check 全收口后,按"同一根因跨 lane/跨模型收敛"去重,严重度=影响×触发概率(和解 0902 按影响评级 vs K3 按触发概率评级)。每条标 [收敛度](几 lane/几模型独立撞到)+[证据级](执行复现/磁盘实证/bench/行号静态/外部事实)。

### 第一优先簇(高影响×高触发概率·多 lane 收敛·fix-plan 第一批)
**F1 ★O(n²) 流式 tool-call arguments**[3-lane收敛:perf-0902 H1/H5+perf-K3 H1+protocol-0902 H3][bench:115.8ms/40KB·1.79s/100KB]。provider 每 chunk 全量重 parse 累积 JSON(7处)+daemon 每 chunk 带全量快照出站+UI 每 chunk JSON.stringify 签名。日常场景(edit 大文件/ipython 大 cell)。修法(cross-check 已收敛边界):provider 节流 parse(≥4KB/≥50ms)+toolcall_end 唯一权威点;daemon seed 注入 partialJson 一行修(中途 attach 客户端是硬约束);UI argsSignature→O(1)。
**F2 ★fork 主干道错误恢复四件套全缺**[provider-0902 H5+provider-K3 证实+M9+M11][外部事实:models.json 实测 bailian 全模型 api=openai-completions]。①不快速退出(invalid_request/refusal 无 fallback、DashScope 400 重试满3次全量重发)②不触发压缩(overflow.ts 23模式对 DashScope 两种超限文案零匹配)③无归因(completions/codex 不接 stream-failure 基础设施→agent-session 重试/恢复只认 provider_stream_failure 诊断、这两条生产逻辑在 fork 主干道死)④侧问必炸(side-question.ts:91 克隆含 tool 历史的全量消息+tools:[]→DashScope 400)。**这是 bailian 模型(fork 主力、跑这次审查的模型自己)错误恢复系统性失效=fork 最高优先**。
**F3 ★E6 终端废掉(editor 无限递归)**[correctness-0902+correctness-K3 双重独立 dist 执行复现][执行级]。tmux 竖分屏≤6列+输入框一个汉字/emoji→wordWrapLine 栈溢出→交互 TUI 零 crash 保护(无 uncaughtException、RangeError 在 layoutText 阶段够不着 tui.ts:1915 恢复路径)→终端留 raw+alt-screen+kitty 废掉。本项目常态(tmux+中文)。修法:递归收敛守卫+宽度下限钉2非1+交互 TUI 装 uncaughtException 走终端恢复。
**F4 ★崩溃放大器框架**[correctness-0902 A1/E1/E6/A6+correctness-K3 更正][行号级+K3更正]。"未处理 rejection/未捕获异常=进程级死亡":supervisor 进程 0 crash handler(main.ts:1354 独立进程、installCrashHandlers 只装 worker)+交互 TUI 0 保护+Node>=22 默认 unhandledRejection=throw;活口≥6(A1 persistWorker 裸 fs 一次磁盘失败杀整 daemon、E1 cron 锁争用 1 秒杀会话 worker、E6 栈溢出、A6 WriteStream 无 error 监听、E7 补全链、abort 4 助手)。**修法:先修放大器(supervisor 入口+persistWorker 本体兜 try+交互 TUI 装进程级兜底+退出走优雅关闭)再堵活口**(否则每修一处只降概率)。
**F5 google/google-vertex stopReason 洗白**[3-way:provider-0902 H4+provider-K3 H3+correctness-0902 A3][行号级三方]。无条件覆盖 toolUse 缺 `&& stopReason==="stop"` 守卫→MAX_TOKENS 的 length(refinement length 重试失效)+MALFORMED_FUNCTION_CALL 的 error(agent-loop 执行半截工具吞掉错误)+stopReasonRaw 永不记录。修法:加守卫(两文件,也是 junk 345行重复该合并的力证)。
**F6 压缩烧钱三独立机制(分别立单不合并)**[correctness 双向][A4/A5 dist执行复现·K1/K7 行号级]。①A4/A5 阈值抖动(capKeepRecentTokens 零余量+摘要13107token不占keep预算→每轮白烧1-3次摘要、CJK chars/4低估2.4-4×、修法验证 keepRecentTokens 20000→8000 一次收敛)②K1 overflow 护栏复位循环(message_end 对 stopReason!=="error" 无条件复位 _overflowRecovery→overflow→compact→retry 真无界、三闸都不在 overflow 分支)③K7 reserveTokens>=contextWindow 区间恢复结构性失效(阈值压缩永久禁用+摘要不裁带全量→摘要自己必溢出→压缩失败→用户只被告知"Try reducing context"、失效不可见)。
**F7 journal 35MB/天/worker + fsync 阻塞**[perf-0902 H6/H7+perf-K3 磁盘实证][活体磁盘:本机35.2MB还在长]。每 event 同步 fsync(worker 事件循环4.7%永久阻塞)+compact 门要全 session idle(99.5%busy→永不压缩)。修法(cross-check 已定 fsync 下限:journal 加载本就按无 fsync 崩溃窗口设计、per-record fsync 无消费者):去 per-record fsync(或批量250ms/16条)+删冗余 chmodSync+修 compact 门(参照 COMPACT_AFTER_RECORDS=4096)+record() 全量展开改计数。
**F8 H10 OSC133 marker 无界累积 + inline 整屏重画**[perf 三层异构迭代收敛][bench+exp33]。三组件原地改写 memoized 数组拼 marker(200帧24483游离marker≈196KB)+inline 每 token 整屏重画21-27×。修法(三层迭代定稿):decorated 缓存{src,width,out}+单行边界特判(length===1 时 [B+C+A+l0] 与现状逐字一致、否则 [A+l0,...slice,B+C+last])+hasToolCalls 提前 return 不进 decorate。

### 第二优先簇(高影响×条件触发·fix-plan 第二批)
**F9 bedrock/cache token 口径**[provider-0902 H2+provider-K3 自我推翻证实+M5][外部AWS文档+仓内自证]。totalTokens 不含 cache(AWS 文档+total-tokens.test.ts:80 全provider不变量但 Bedrock skipIf 门几乎不跑、实现直接抄 vendor 字段→不变量按构造不可能成立)→bedrock+caching 用户 context 系统性低估→压缩失灵。修法:bedrock 本地四项求和+calculateContextTokens 一律四项求和+抽 promptTokens/contextTokens 单一 helper(overflow.ts:127/137 也漏 cacheWrite 同根因)。
**F10 response.incomplete 无分支**[provider 双向][外部SDK文档+codex对照]。openai-responses-shared.ts 事件链无 incomplete 分支→max_output_tokens 截断时 usage/cost 全0+stopReason 假"stop"+半截 toolCall 被执行+partialJson 漏进 JSONL。修法:加 incomplete 分支复用 completed 逻辑(mapStopReason "incomplete"→"length" 已就位)。
**F11 schema digest 半盲+不强制 bump revision**[protocol 双向 CONFIRMED][行号级+K3扫遍CI/pre-commit/test证实无补偿门+docs行92政策已写enforcement缺]。digest 只哈希三段源切片(21出站类型只覆盖17、53导出类型50个在外含 CompactAssistantDelta)+门不强制 bump(右边三量全取自被测源码、4条 toBeGreaterThanOrEqual 只防调低)+efab56cac 警告注释已删→改盲区忘 bump→schemaId 不变→probeDaemonVersion 判 stale daemon 为 current→自愈不触发。修法:R 塞进 digest 输入+CI bump 门+恢复警告注释。
**F12 anthropic 签名历史污染**[correctness-K3 K3+0902 补第2处][行号级]。anthropic.ts:1136-1140+amazon-bedrock.ts:699-706 两处同形:sanitizeSurrogates 改文本但原样回传 signature→400 invalid_request 不可重试→同模型重放每回合必挂(可达性窄:需中间层发畸形但完整收尾的流)。修法一行×2处(文本被改过就降级丢签名)、修复优先级高于严重度(400 不指向签名难诊断)。
**F13 K5 retry 假死 pump 永久停摆**[correctness-K3+0902 找到真路径][行号级]。nothing-to-continue × navigateTree:重试 backoff 期间用户跳到以 assistant 结尾的叶节点→定时器触发抛 nothing-to-continue→被吞→_retryPromise 永挂→isRetrying 永真→canSelectSessionAction 永假→pump 永久停摆、后续输入静默排队、零诊断、逃生只 Esc 而用户看不到提示。修法:catch 里 _resolveRetry()+emit auto_retry_end+写诊断+_navigateTree 开头补 abortRetry()。
**F14 DAEMON_OUTBOUND_COMPATIBILITY 表漂移**[protocol 双向][行号级+根代理亲读 docs/daemon.md 裁决]。表与运行时双向漂移(heartbeats_changed 谎标门/extension_ui 漏标/session_snapshot LEGACY 错标)。裁决(K3 证据强但略 overstate、根代理核 docs):保留为 Public Daemon Protocol 契约登记表+按运行时校准+加表↔运行时对照测试+补 docs/daemon.md 纳入出站表(当前只文档化命令侧)。
**F15 字符串嗅探反模式 / 契约靠人守不靠编译器(T3 主线)**[quality-0902 H5+quality-K3 H6+T1 五switch+as强转][行号级+0902量化16消费位点]。三症状:①as强转绕过完整性检查(5类:agent-session 5处/loader.ts:319 as ExtensionAPI 24成员不受检/daemon-client as DaemonWorkerCommandBody 掩盖3缺字段/runner undefined as never/openai-completions as any 24处)②分发点无穷尽断言(T1:同契约5消费者各自switch、3 fail-open、daemon-mode 100case 0default/supervisor 31case 0default/TUI handleEvent 29case 0default 实测丢 recap_update、唯 RPC 全量转发证明做得到)③人类文案承载机器判定(H5 faux文案4+K3 H6 daemon版本 message.includes 12=16位点、跨进程跨版本改措辞静默失守)。修法:结构化码+`{[K in T["type"]]:handler}` satisfies 穷尽+CI 门 rg 'message.includes(' 契约判定处为0+对象字面量 as 改 satisfies。
**F16 gpt-5.5 codex resolveServiceTier 多算**[provider-0902 cross-check 新发现][外部官方FAQ]。codex:476-484 响应回"default"时仍用请求 priority/flex 计价、官方 ramp 超限回落 Standard→多算2×/2.5×(非 codex 路径响应优先正确)。修法:条件收窄 responseServiceTier===undefined。(注:K3 原判"少收20%"被 0902 推翻——pro 进不了 priority)。

### 第三优先簇(架构重构·高工程·fix-plan 第三批/独立工单)
**F17 AgentSession god-object 拆分**[quality 双向][0902数据驱动内聚+K3测试锁+双向cross-check]。11407-12517行/553成员/15职责域/两周+14%/自我繁殖。**排期(cross-check 实质改写)**:前置先解 sdk:88→runtime:774→services:18 唯一值级互环(K3 自纠 Tarjan 后确认);**第一批 P0 SessionRetryController(262行/内聚0.96/入边0)+P1 SessionKernelBridge(461行/0.80/入边0)=723行6.3%零结构前置零测试锁立即开工**;P2 RlmSubagentOrchestrator(1876行)+SessionInputScheduler(1843行)合并工单(3719行30.6%、16入边先接口化 RlmChildrenView、必须合并做);P3 refine/P4 compaction 需先测试重写(139私有spyOn里refine108+compaction19=91.4%、178位点68.5%在1文件 serialized-refine.test.ts、最小集4-6人日完整6-9人日)。立规矩:新测试禁 as unknown as {_/vi.spyOn(x,"_")+CI grep 门。
**F18 H8 76模块运行时环+假注释**[quality 双向][0902发现+K3独立重算同数命中]。loader.ts:343 内联动态 import(违 AGENTS.md)撑76模块环、bundled-modules.ts:18-19 注释"loader exports NOT re-exported"是假的。严重度精修(K3):架构债高/即时崩溃低(ESM live bindings 今天不炸、是潜伏脆弱+假注释误导)。修法:反转依赖(启动侧 setBundledModules 注入或虚拟模块窄入口)+改顶层 import+删假注释;AGENTS.md 补 loader 动态 import 例外条款(Bun 打包辩护)。
**F19 InteractiveMode god-class**[quality 双向]。9298-10150行/513成员+handleEvent 447行29case无default(丢recap_update)+slash注册表42项但分发34叉if链(注册表按设计只承载元数据、行为分发从未表驱动化)。修法:handleEvent 补 default+slash 新增 handle? 字段对 execution==="client" 33项填充(可分批)。
**F20 测试与生产分叉系统性(T2 主线)**[quality 双向]。5证据同根:①harness 逐字复制 sdk 三回调(接线零覆盖、但 drain 有9处直调覆盖=H4部分推翻)②cleanup 生产 disposeAsync vs suite dispose ③AgentDaemon 构造反号(生产必带 worker、new AgentDaemon 127处=src1+test126、114处不带 worker)④看门狗 it 三重门永不执行(=F-看门狗)⑤ai matrix CI 全 skip 假绿。修法按性价比:test:kernel 补1文件名+tag/script 集合 diff 门→harness 改走 createAgentSession(前置4行透传)+"harness 不得 new Agent("门→cleanup 改 disposeAsync→126处 new AgentDaemon 收敛 createTestDaemon 工厂默认与生产一致。
**F21 AgentConnection 85方法胖接口**[quality 双向][硬顺序依赖]。必须先修 F17(H1 窄契约)再拆(85方法是 AgentSession 153 public 的镜像、先拆 connection 不修 H1=收益接近零)。
**F22 BrandSplashHeader 搬移(最高ROI·不等任何重构)**[quality 双向][410→74行修正]。agents-view 为74行纯展示组件静态 import 10151行 god-file 拉起整张 import 图。修法:移74行到 modes/interactive/components/ 或 modes/shared/+改2个 import、砍一条 mode→god-file 加载期依赖。
**F23 sleep/delay abort 语义分化+泄漏**[quality 双向]。delay×10+跨包11份、sleep.ts 唯一被复用却唯一有泄漏(reject+addEventListener 从不 remove/没 once→listener 累积)、reject 版与142处.catch(()=>undefined)组合→abort 吞成正常继续。修法:修 sleep.ts 泄漏+收敛10份 delay(归 M7 工单)。
**F24 跨provider handoff 重复 msg id**[provider-K3 H4+0902 证实代码事实危害部分][行号级+外部400证据但stateless未证实]。anthropic→openai 无签名 text 块共享 msg_${msgIndex}→item id 重复→可能合并去重静默丢历史文本(400 在 stateless 未证实)。修法零风险 msg_${msgIndex}_${blockIdx}。
**F25 usage.input 无 Math.max(0,)**[provider-K3 H5+0902 证实定低-中]。shared:481/google:222/vertex:239 无保护(completions 有)→buggy代理报 cached>input→cost.input 负冲减账单+污染 overflow 判据。修法:三处统一 Math.max(0,)。

### 第四优先簇(垃圾代码清理·安全删/合)
**F26 junk T0 16条收敛死代码**(core/index.ts 死barrel、tui/vitest.config.ts 死配置、legacy-rlm-host-types.d.ts、13孤儿脚本1757行、daemon-protocol 8别名、resolveHeaders/computeEditDiff/isLightTheme/WINDOWS_NAMED_PIPE_ACL_UNVERIFIED/AGENT_*_IMPORT_NAME/getNewEntries+compareVersions 死符号、writeJsonAtomically/prefixIgnorePattern/normalizePath 重复)=两侧收敛零引用、删/合安全、净掉~2000行负债。
**F27 junk T1/T2 大重复**(google/google-vertex 345行、resolveCacheRetention×4+applyServiceTierPricing×2 计费、isProcessAlive×5、errorMessage×5、editDistance×2、formatValidationPath 跨包、formatTable×2、14份抽文本逻辑、测试助手大面积复制)=合并(计费类 F9 已含正确性、此处是去重)。
**F28 K3-only 死配置**:package.json "./hooks"+2 tsconfig paths→指向已删 src/core/hooks/=**对外 import 解析失败(真bug非纯垃圾)**。

### §6.X 待老板裁(T4·fix-plan 前需决策)
1. **DAEMON_OUTBOUND_COMPATIBILITY heartbeats_changed 该不该 capability 门控**(协议决策:F14 校准方向取决此)。
2. **OAuth 废弃层+streamProxy/validateToolCall/ToolRenderResultLike/RpcCommandType 等 README 明写公共 API 死导出删不删**(@earendil-works/pi-* 是发布包、删=breaking、本 fork 发布策略:跟上游 lockstep?允许 minor breaking?)。
3. **tui/keys.ts Key 常量表 79项60零引用**(AGENTS.md 要求所有键位可配置、完整键名表可能有意为之 API 面、0902 倾向留观察)。
4. **修复范围与节奏**(全做?先做第一优先簇 F1-F8?架构重构 F17-F21 投入大要不要这轮做?)。
5. **Astra 玩法⑤"放手让它合并"的信任阶梯**(哪些我可自主合并、哪些 gate 在你)。
6. **R3 merge-back(F4)** 仍停着(与本审查独立、但 F11/F14 与 R3 的 schema27/daemon 改动相关、合并顺序需协调)。

### §6.Y 跨 lane/跨努力收敛总账(doctrine 价值实证)
- **3-lane 收敛**:O(n²)流式(F1)、google stopReason(F5)。
- **2-lane/2-努力收敛**:看门狗死测试(quality A1+R3破口#4)、字符串嗅探(quality H5+K3 H6)、bedrock cache(provider H2+K3 M4)、压缩烧钱(correctness A4/A5+K1+K7 三机制)。
- **异构双向纠错实证**:K3 推翻 0902 的 protocol H2/H4(false-positive)、provider gpt-5.5少收(0902 反推翻 K3)、quality H4 drain零覆盖(部分推翻);0902 推翻 K3 的 cacheRead双算子claim、lexer阻断担忧、AgentConnection89→85、BrandSplashHeader410→74;K3 自我纠错 Tarjan两bug、bedrock M4;0902 自我纠错 B3精度、拆分排期、表过期猜测。**三层异构迭代**:H10 修法(0902naive→K3decorated→0902单行边界)。
- **仪器纪律**:两 K3 lane+R3 recheck-final 独立踩中 .strip() 吃 porcelain 前导空格陷阱;覆写事故(scan-tui)→assert守卫函数+pop短名"宁可崩不可写"全波次采纳。
