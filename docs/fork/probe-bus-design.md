# 终端能力探测总线（probe bus）设计稿

- 日期：2026-10-02 · W15-D（wave-15 文档批）· 纯设计稿，不改代码
- 上游证据：`/tmp/wave10/res-terminal.md`（wave-10 RES-TERM，F2/F5 + P1~P9 台账）；本稿所有行号在 `HEAD=788e24897` 工作树实测
- 下游读者：实施波（照 §5 迁移顺序逐阶段红→绿落地）；本文档的接口草图（§4）是照做级的，不是意向级的

## 0. 先勘误：wave-10 台账里已落地的一条

wave-10 的 F3（alt 屏不重推 Kitty 旗标）**已在 wave-13 修复**（`6418574fe fix(tui): keep kitty keyboard enhancements alive on the alternate screen`）：`terminal.ts:576-590` 进 alt 屏重推 `KITTY_FLAGS_PUSH`，`:596-610` 退出前在对端栈上先 pop 再 `1049l`。实施波**不要**重复立项；但 wave-10 的其余探测类发现（F2 定时器栅栏、F5 分版本 DECRQM、P3 盲发、P4 双定时器、P5 剥离正则）全部仍然成立，逐条核对如下。

## 1. 现状盘点（为什么现在是三条互不相识的探测路径）

| 探测 | 发起 | 应答消费 | 判负机制 | 现状问题 |
|---|---|---|---|---|
| Kitty 键盘 `CSI ? u` | `terminal.ts:311` | `terminal.ts:256-273`（setupStdinBuffer 的 data handler 就地消费） | 150ms 固定定时器 → 兜底转 modifyOtherKeys（`terminal.ts:313-319`） | 慢链路下 150ms 到点即判负，晚到的应答掉进粘贴流（P4/P5 互为因果） |
| OSC 10/11 默认色 | `terminal.ts:330-340` | `terminal.ts:342-356`（handleDefaultColorProbeResponse） | 100ms 固定定时器封盘（`terminal.ts:336`） | 同上；且封盘后用户切深/浅色不重绘（P8） |
| cell size `CSI 16 t` | `tui.ts:832-840`（仅 `images` 开启时） | `tui.ts:1417-1435`（consumeCellSizeResponse） | **无超时**——不答就永远用默认单元格尺寸 | 第三条私有路径，无判负、无订阅 |

另有四处「探测不可行」的历史债务：

- mode 2026（synchronized output）8 处盲发：`fullscreen.ts:1031,1048`、`tui.ts:2140,2186,2219,2320,2350,2391,2469`；注释 `tui.ts:940-945` 写死「tmux never answers DECRQM」——wave-10 F5 已证伪（tmux 3.6 起应答鼠标族 DECRQM，3.7 起应答 2026）。
- 全仓无 mode 2027/2031 探测与开启（grep `2027|2031` 于 `packages/*/src` 无命中）；app 侧宽度已按 grapheme 分簇（`utils.ts:4,146-195`），与 kitty/tmux 的 wcwidth 渲染分歧悬空（P7）。
- 图片能力纯 env 静态检测（`terminal-image.ts:66-126`），Ghostty 默认 `images:null` + `PI_ENABLE_GHOSTTY_IMAGES=1` 逃逸门（`terminal-image.ts:70-72,95-102`，P1）；全屏下 Kitty 图片只能 `[image]` 占位（`terminal-image.ts:178`，P2）。
- 应答剥离正则 `stdin-buffer.ts:380`（`TERMINAL_RESPONSE_REGEX`）只认 `CSI ?…u` / `CSI 6;h;wt` / OSC 10/11 三类——**新探测上线前不认 DECRPM（`CSI ?…$y`）、DA 应答（`CSI ?…c`）、2031 推送（`CSI ?997;…n`），应答会被吞进粘贴文本**（P5 的扩面）。

## 2. 设计目标与原则

1. **一个总线，一个栅栏**：所有启动期探测注册进同一张表，统一发送、统一以 primary DA 应答为判负栅栏；现有的 150ms/100ms 固定定时器从「判负依据」降级为「最后保险」。
2. **单源订阅**：每能力一个状态机，消费方只订阅能力状态，不再各自 grep 输入流。三处就地消费点（§1 表）全部迁移。
3. **探测命中按应答决策，超时退回各能力自己的兜底**（2026 盲发危害低可激进；2027 开错会渲染分裂必须保守——见 §3.2 分级）。
4. **每能力 env 逃逸门**：探测可以错，用户必须能一把关掉/强制打开单个能力（§3.4）。
5. **剥离先行**：任何新探测上线之前，stdin-buffer 的剥离正则必须先认得它的应答（§3.3），否则 P5 复发。

## 3. 设计

### 3.1 DA 栅栏替代固定定时器

做法（kitty keyboard protocol spec「Detection of support」节的官方检测法，wave-10 F2 已引原文）：

- 启动时按序写出：各能力查询（`CSI ? u`、`CSI ? Ps $ p` × N、OSC 10/11、`CSI 16 t`）→ **最后**写 primary DA `CSI c`。
- 终端串行处理输入流并按序应答（SSH/慢链路下同样成立：TCP 保序 + 终端单线程解析）。**收到 DA 应答时，排在它前面而未应答的探测即判「不支持」**，不再等墙钟。
- tmux 代 pane 应答 primary DA（其终端模拟层既有行为），所以栅栏在 tmux 内同样可用——这正是一举替代「tmux 不答 DECRQM 所以探测不可行」历史结论的关键。
- 兜底定时器保留但降级：DA 也不答的病态终端（极少数裸 pty/conhost 路径）由单个兜底定时器（建议 1000ms）统一判负，替代现在的 150ms+100ms 两个。

**陷阱（实施波必读）**：DA 应答是 `CSI ? Psc ; … c`（**带 `?` 前缀与参数**，如 `\x1b[?64;1;2;6;9;15c`）。**裸 `\x1b[c`（无任何参数）在本仓是 shift+right 按键**（`keys.ts:380` 映射表、`:425` 反查表）。栅栏与剥离正则都必须要求 `?` 前缀，绝不可消费裸 `CSI c`——否则用户按 shift+right 会被当成探测应答吞掉。

### 3.2 分版本 DECRQM 语义

DECRQM 查询 `CSI ? Ps $ p`，应答 DECRPM `CSI ? Ps ; Pv $ y`，Pv 语义：`0`=不识别、`1`=set、`2`=reset、`3`=permanently set、`4`=permanently reset（后两者=终端不允许应用改这个模式）。

版本现实（wave-10 F5，tmux CHANGES 原文）：

- tmux < 3.6：不答 DECRQM → DA 栅栏判负 → 走各能力兜底。
- tmux 3.6（2025-11-26，本机实测 3.6a）：答鼠标族（`?12/?2004/?1004/?1006`）。
- tmux 3.7（2026-06-26）起：答 2026。**注意 tmux 答的是 pane 的透传状态，不等于外层终端支持**——所以 DECRPM 应答在 tmux 下的语义是「链路上允许发」。
- 不解析 `tmux -V`、不读版本字符串：版本判定一律以应答本身为准（版本检测是另一套会漂移的启发式）。

按能力分级的决策策略：

| 能力 | 应答 1/3（set）| 应答 2（reset）| 应答 0/4 或不答（unknown）|
|---|---|---|---|
| 2026 sync output | 照常包帧 | 照常包帧（应用自己会开）| 退回现状盲发（危害低：不支持的终端忽略 mode-set）；可选后续降频重绘优化 |
| 2027 grapheme | 开（`DECSET 2027`），宽度数学保持 grapheme | 开 | **不开**。kitty 明示拒做（kitty#7799，kovidgoyal 原话见 res-terminal.md §2），其对未识别模式答 0 还是不答待真机核实——两条路径都必须收敛到「不开」；维持现状 grapheme 数学，登记 `CSI 6 n` 光标实测宽度为后续降级（mitchellh 做法②） |
| 2031 深浅色 | 开（`DECSET 2031`），订阅 `CSI ? 997 ; 1|2 n` 主动推送 | 开 | 不开，维持 OSC 10/11 一次性探测（P8 不恶化） |

2027 的 per-screen 语义未经真机复核（同 wave-10 F3 先例）：进/出 alt 屏是否需要对称重开，实施波在 kitty/ghostty/foot 上按 F3 的复核方法确认后落地，确认前先在主屏开。

### 3.3 stdin-buffer 应答剥离扩展（一切新探测的前置）

`stdin-buffer.ts:380` 的 `TERMINAL_RESPONSE_REGEX` 与 `:383-384` 的 `TERMINAL_RESPONSE_PREFIX_REGEX` 同步扩：

- DECRPM 应答：`\x1b\[\?\d+(?:;\d+)*\$y`
- DA 应答：`\x1b\[\?[\d;]*c`（**必须带 `?`**，见 §3.1 陷阱）
- 2031 主动推送：`\x1b\[\?997;[12]n`——它不是启动窗口内的一次性应答，外观切换时随时到达；剥离（粘贴路径）与总线消费（普通 data 路径）都要认。

序列完整性判定（`isCompleteCsiSequence` 等，`stdin-buffer.ts:83-167`）**不需要改**：`$`（0x24）是中间字节、`y`/`n`/`c` 是终字节，现有「终字节 0x40-0x7E 即完整」规则已覆盖。要改的只有剥离正则 + 消费路由。

### 3.4 每能力 env 逃逸门

先例：Claude Code 为其可选/高风险特性逐一暴露环境变量开关（官方文档环境变量表；本批离线，具体清单以官方文档为准）；本仓先例 `PI_ENABLE_GHOSTTY_IMAGES`（`terminal-image.ts:70-72`）与 `PI_DISABLE_CLAUDE_CODE_DETECTION`。统一约定：

- 命名 `PI_TERMINAL_<CAP>`，取值三态：`0`=禁用（不探测、不开启）、`1`=强制（跳过探测直接按 supported 处理，后果自负）、缺省/`auto`=探测决策。
- 首批登记：`PI_TERMINAL_KITTY_KEYBOARD`、`PI_TERMINAL_SYNC_2026`、`PI_TERMINAL_GRAPHEME_2027`、`PI_TERMINAL_SCHEME_2031`、`PI_TERMINAL_OSC_COLORS`、`PI_TERMINAL_CELL_SIZE`。
- `PI_ENABLE_GHOSTTY_IMAGES` 保持现名不动（用户面已有契约，FORK_NOTES 有记录）；它门控的是「渲染路径」而非「探测」，与上表正交。
- env 覆盖在总线层实现（§4 的 `source: "env-override"`），消费方拿到的状态已含覆盖，不再各自读 `process.env`。
- 实施波同步在 `packages/coding-agent/src/cli/args.ts` env 文档与本文件登记。

## 4. 接口草图（照做级）

新文件 `packages/tui/src/probe-bus.ts`（实施波独占创建）：

```ts
export type ProbeCapability =
	| "kittyKeyboard" // CSI ? u
	| "sync2026" //      DECRQM 2026
	| "grapheme2027" //  DECRQM 2027
	| "scheme2031" //    DECRQM 2031 + CSI ? 997;n 推送
	| "oscColors" //     OSC 10/11
	| "cellSize"; //     CSI 16 t

export type ProbeVerdict = "pending" | "supported" | "unsupported" | "unknown";

export interface CapabilityState {
	verdict: ProbeVerdict;
	/** DECRPM 应答原文 Pv（0-4）；仅 DECRQM 类能力有 */
	decrpmValue?: 0 | 1 | 2 | 3 | 4;
	/** probe=终端应答；env-override=PI_TERMINAL_* 强制；default=栅栏/超时判负后的兜底 */
	source: "probe" | "env-override" | "default";
}

export type ProbeListener = (cap: ProbeCapability, state: CapabilityState) => void;

export class ProbeBus {
	/** 由 ProcessTerminal 在 start() 内构造并 start()；按 §3.1 顺序写出全部查询 + DA 栅栏 */
	start(write: (data: string) => void): void;
	/** stdin 序列入口（普通 data 路径 + 粘贴剥离路径共用）；认出探测应答/推送则消费并返回 true */
	handleSequence(sequence: string): boolean;
	query(cap: ProbeCapability): CapabilityState;
	onChange(cap: ProbeCapability, listener: ProbeListener): () => void;
	/** DA 栅栏到达（或兜底定时器到点）后 resolve；消费方可 await 后一次性读全量状态 */
	readonly settled: Promise<void>;
	dispose(): void;
}
```

接线（现状消费点的迁移目标）：

- `terminal.ts:256-273` 的 kitty 应答消费 → `bus.handleSequence(sequence)` 前置分支；kitty 判负（DA 栅栏到而未答）→ 触发 modifyOtherKeys 兜底（现 `terminal.ts:313-319` 逻辑平移，由总线事件驱动）。
- `terminal.ts:342-356` 的 OSC 10/11 消费 → 总线解析后仍调 `setDefaultTerminalColors`（`terminal-colors.ts` 的存储与 `onDefaultTerminalColorsChange` 订阅机制不动，总线只接管探测与应答路由）。
- `tui.ts:1417-1435` 的 cell size 消费 → `bus.onChange("cellSize", …)` 里 `setCellDimensions` + `requestRender`。
- `stdin-buffer.ts` 剥离出的应答经 `emitDataSequence` 上抛后同样进 `bus.handleSequence`——两条路径汇于一处，这就是「单源」。
- 2031 的 `CSI ? 997 ; 1|2 n` 推送由总线路由成一次 `oscColors` 状态刷新（重发 OSC 10/11 查询或直接用 997 的明暗位导出背景色档），驱动既有重绘。

## 5. 迁移顺序（实施波分片；每阶段红→绿，测试命令见 §6）

| 阶段 | 内容 | 独占文件 | 依赖 |
|---|---|---|---|
| 0 | （已完成，勿重复）F3 alt 屏 kitty 栈：wave-13 `6418574fe` | — | — |
| 1 | 剥离扩展：DECRPM / DA / 997n 三类应答+前缀正则；回归用例「粘贴内混入应答被剥离为 data 序列」「裸 `\x1b[c` 留在按键路径不被吞」 | `packages/tui/src/stdin-buffer.ts`、`packages/tui/test/stdin-buffer.test.ts` | 无 |
| 2 | 总线核心 + DA 栅栏：新建 `probe-bus.ts`；kitty/OSC 10/11 迁移上总线；150ms/100ms 定时器降级为单一兜底；env 逃逸门落地 | `packages/tui/src/probe-bus.ts`（新）、`packages/tui/src/terminal.ts`、`packages/tui/test/probe-bus.test.ts`（新） | 阶段 1 |
| 3 | 2026 决策化：8 处盲发点按 `sync2026` 状态包帧；`tui.ts:940-945` 注释按分版本现实重写；cell size 迁移订阅 | `packages/tui/src/tui.ts`、`packages/tui/src/fullscreen.ts` | 阶段 2 |
| 4 | 2027：探测+按 §3.2 表决策开启；`utils.ts` 宽度数学与模式位对齐；kitty 不答规避路径；per-screen 语义真机复核登记 | `packages/tui/src/utils.ts`、`packages/tui/src/terminal.ts`（与阶段 2 同文件，须串行不并行） | 阶段 2 |
| 5 | 2031：探测+开启+997n 推送订阅，外观切换即时重着色（消 P8） | `packages/tui/src/terminal-colors.ts`、`packages/tui/src/probe-bus.ts` | 阶段 2 |
| 6 | Kitty Unicode placeholders 图片（U+10EEEE，kitty 0.28+）：图片走文本网格占位，`isImageLine`（`terminal-image.ts:149-156`）改认占位行；先 Ghostty 小步试点（消 P1/P2） | `packages/tui/src/terminal-image.ts`、`packages/tui/src/fullscreen.ts`、`packages/tui/src/utils.ts` | 阶段 2（应答通道）+ 阶段 4（占位符宽度数学） |

阶段 4 与阶段 5 互不依赖可并行；阶段 3/4 都碰 `tui.ts`/`terminal.ts` 的相邻区域，实施波按共享 worktree 纪律串行提交。

## 6. 测试计划（每阶段先红后绿）

运行方式（tui 包）：

```bash
cd packages/tui && env -u RLM_DEPTH -u RLM_SESSION_DIR node --test --import tsx test/<file>.test.ts
```

- 阶段 1（`stdin-buffer.test.ts`，现有「terminal responses inside paste」族 `:959` 附近扩）：
  - 红→绿：粘贴内混入 `\x1b[?2027;1$y` / `\x1b[?64;1;2;6c` / `\x1b[?997;1n`，应剥离并以 data 序列交付，粘贴文本不含应答字节。
  - 红→绿：应答撕半跨 chunk（`…\x1b[?202` + `7;1$y…`）hold 住后重组剥离。
  - 守卫断言（直接绿）：粘贴内的裸 `\x1b[c`（shift+right 前缀形状）**不剥离**，留在文本/按键路径。
  - 数据驱动循环前先断言用例集非空（AGENTS.md 测试卫生）。
- 阶段 2（新 `probe-bus.test.ts`）：模拟应答序列驱动——kitty 应答先于 DA → supported；DA 先到 → unsupported 且触发 modifyOtherKeys 兜底事件；全不应答 → 兜底定时器 unknown；`PI_TERMINAL_*=0/1` 覆盖；`settled` 在 DA 到达时 resolve。只驱动公开入口（`start`/`handleSequence`），不断言私有成员（test-hygiene 门）。
- 阶段 3：2026 包帧按能力状态开/关的字节级断言（tui/fullscreen 既有测试族扩）；注释重写后 grep 复核 `940-945` 原句消失。
- 阶段 4：2027 开/关两条路径下 `visibleWidth` 与渲染网格一致性用例；kitty 形「不应答」夹具收敛到「不开」。
- 阶段 5：997n 推送 → `onDefaultTerminalColorsChange` 订阅者被调、重绘触发。
- 收尾门禁（实施波）：改动文件 `npx biome check --write`；根级 `npx tsgo --noEmit` 零新增；tui 全量 `node --test --import tsx test/*.test.ts`。

## 7. 风险与未决项

1. **kitty 对未识别 DECRQM 的应答行为未实测**（答 0 还是不答）——§3.2 已把两条路径都收敛到「不开 2027」，风险已对冲；实施波顺手在 kitty 真机记录一次实际行为进本文件。
2. **2027 per-screen 语义未复核**（同 F3 先例）——阶段 4 含真机复核项；复核前只在主屏开。
3. **2031 在 tmux 3.6 已支持**（CHANGES「Add mode 2031 support」，issue 4353）——但同样只代表 pane 透传；外层不推 997n 时退回 OSC 10/11 现状，不恶化。
4. **Windows conhost/裸 pty 不答 DA**——兜底定时器路径必须有测试覆盖（阶段 2 用例），不能因栅栏上线而删掉最后保险。
5. **OSC 10/11 在 tmux 下的可达性**随版本/配置（allow-passthrough）漂移——总线不为此做特判，unknown 即退回现状（COLORFGBG 启发式仍由 `terminal-colors.ts:163-178` 兜底）。
6. daemon wire 协议零改动：本设计全部发生在 TUI 进程与本机终端之间，不触碰 daemon 命令/事件/响应形状。

## 8. 证据索引

- wave-10 调研全文：`/tmp/wave10/res-terminal.md`（F2 DA 栅栏与 spec 出处、F4 2027 矩阵与 kitty#7799 原话、F5 tmux CHANGES 版本行、F6 2031 跨终端现状、F7 Unicode placeholders）
- kitty keyboard protocol spec（Detection of support / set-then-query / per-screen 栈）：https://sw.kovidgoyal.net/kitty/keyboard-protocol/
- mode 2027 综述与终端矩阵：https://mitchellh.com/writing/grapheme-clusters-in-terminals
- tmux CHANGES（3.6 DECRQM 鼠标族+2031；3.7 DECRQM/DECSET 2026）：https://github.com/tmux/tmux/blob/master/CHANGES
- kitty#7799（拒做 2027）：https://github.com/kovidgoyal/kitty/issues/7799
- kitty#8574（2031 已完成）：https://github.com/kovidgoyal/kitty/issues/8574
- 本仓行号（`HEAD=788e24897` 实测）：`terminal.ts:29,253,256-273,307-320,330-340,342-356,576-610`；`stdin-buffer.ts:380,383-384,404-411`；`tui.ts:832-840,940-945,1417-1435,2140,2186,2219,2320,2350,2391,2469`；`fullscreen.ts:1031,1048`；`keys.ts:380,425`；`terminal-image.ts:66-126,149-156,178`；`terminal-colors.ts:148-206`；`utils.ts:4,146-195`
