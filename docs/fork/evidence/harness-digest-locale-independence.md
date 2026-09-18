# Harness digest / 平手序的 locale 无关性证据（OBS-E1）

> 条目来源：L3a-e 证据文档 `harness-search-parity.md` §9（只报不修）→ 母席裁定 OBS-E1 交本席独立一笔落。
> 落地席：fix-perf-digest-2（子席 OBS-E1）。base `c8bc46975`（已含前一批八笔）。
> 一句话结论：**`refinement.ts` 5 处不带 locale 的 `localeCompare` 全部换成码点（code-unit）比较后，同一 harness state 在 `LC_ALL=C` / `en_US.UTF-8` / `zh_CN.UTF-8` 三个进程下渲染字节 sha256 与 `harnessDigestFingerprint` 逐字节相同**；修前 zh_CN 臂两者皆翻号（下表）。E 席对拍仪器 `--verify` 落地前后各两遍均 93 checks / 0 failure ⇒ 金标准未移动、**不需要重铸**。

---

## 0. 缺陷与触发面

`compareEntriesForInjection`、`rankHarnessEntriesWithRelevance` 的平手键、`harnessDigestFingerprint` 的 material 排序都以「稳定」为书面理由（`refinement.ts:367-370`：*"an ordering that drifts between turns would invalidate the prompt cache"*），但 5 处比较全部用不带 locale 参数的 `localeCompare`：collator 由**进程环境**解析，非 ASCII 键的顺序随机器/重启/shell 变。触发条件：排序键含非 ASCII（中文 id/title/path）＋同分或同 `updated_at` 平手＋两次渲染的进程 locale 不同。两个后果：

1. **digest 字节漂**：同一 state 在 zh_CN 与 en_US 进程下渲染顺序相反 ⇒ 前缀缓存失效——恰是注释声称要避免的事；#2098 的静态前缀收益被 LANG 击穿。
2. **指纹本身随 LANG 变**（`harnessDigestFingerprint` 的 material `.sort`）：不同 LANG 的两个 agent 对同一 state 算出不同指纹 ⇒ 新鲜度互不认 ⇒ 把对方刚投递的 digest 判过期而重投（冷边界重复追加 carrier）。

## 1. 两条独立实测证据

**证据 A（locale 翻号，node v22.22.0 同机同串只改环境，本席亲测）**：
`"修复登录".localeCompare("登录故障")` 在 `LC_ALL=C` 与 `en_US.UTF-8` 下 = **-1**，在 `LC_ALL=zh_CN.UTF-8`（Node ICU 解析为 `zh-CN`）下 = **+1**；`"zhang"` vs `"张"` 同样 -1→+1。注意 `LC_ALL=C` 时 ICU 也解析成 `en-US`，所以「C 与 en_US 同」不代表 locale 无关——对拍必须含 zh 臂。原始探针与三份 JSON：`/tmp/fixL3a-delivery/e1/EVIDENCE/probe-{C,enUS,zhCN}.json`（撤修臂）与 `probe-fixed-{C,enUS,zhCN}.json`（修后）。

**证据 B（非 ASCII 键是真实数据，非构造窄 case，E2 复审实测）**：`harness.py:46-49 _slug` 用 `ch.isalnum()` 过滤，中文字符 `isalnum()` 为真 ⇒ `_slug("登录故障") == "登录故障"`——**中文标题直接生成中文 id**，且真实生产 store 里已有大量中文 id。敏感三处作用在真实数据上。

## 2. 五处分层（母席令：不得说成同等风险）

**敏感三处**（排序键真实含非 ASCII、后果直连缓存与指纹）：

| 符号（按符号引） | base `c8bc46975` 实测行号 | 修后行号 | 作用 |
| --- | --- | --- | --- |
| `compareEntriesForInjection` 的 id 平手键 | `:377` | `:409` | 注入序（无查询词的每回合路径） |
| `rankedIdentifier` 平手键（`rankHarnessEntriesWithRelevance` 内） | `:1022` | `:1055` | ranked 窗序 ⇒ #2098 前缀缓存 |
| `harnessDigestFingerprint` 的 material `.sort` | `:1223` | `:1256` | **指纹本身随 LANG 变** ⇒ 新鲜度互不认 |

**实践不敏感两处**（键恒 ASCII，换它是为口径统一，防将来键形状变化时留下半 locale 依赖）：

| 符号 | base 行号 | 修后行号 | 为什么实践不敏感 |
| --- | --- | --- | --- |
| `compareEntriesForInjection` 的 recency 键 | `:373` | `:405` | ISO-8601 时间戳，恒 ASCII（降序方向保留：`compareCodePoints(entryRecency(b), entryRecency(a))`） |
| `compareEntriesForInjection` 的 scope 键 | `:381` | `:414` | `"global"`/`"local"`，恒 ASCII |

行号均为「把当前 HEAD checkout 后 grep」的实测值，禁 hunk 推算（E 席踩过：推算 1213 vs 实测 1223）。

## 3. 修法

新增**不导出**的内部函数（针全部走公开面 `formatHarnessStateForPrompt` / `harnessDigestFingerprint` / `rankHarnessEntriesForQuery`，无需导出）：

```ts
function compareCodePoints(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}
```

母席裁定**码点比较**（plain `<`/`>`，即 code-unit 序），**不用 `Intl.Collator`**：它仍带 locale 数据依赖与更大的选项面；码点序全域、全进程一致、更便宜。5 处逐一替换，各处语义方向不变（`:373` 降序、其余升序）。文档字符串内写明证据 A/B、后果与五处分层。

**平手序语义变化（有意）**：code-unit 序里 `"Zeta"`（Z=0x5A）排在 `"alpha"`（a=0x61）前，而 en collator 相反；CJK 之间 code-unit 序（修复 U+4FEE < 登录 U+767B）与 en collation 恰同、与 zh pinyin 序不同。这是口径从「进程 locale 序」换成「码点序」的直接结果，被新针逐条钉死。

## 4. 三环境对拍读数表

夹具：4 条同 `updated_at`、同 content 的 memory 条目（ids：`Zeta`/`alpha`/`修复登录`/`登录故障`）＋同分 ranked 窗。探针脚本 `/tmp/fixL3a-delivery/e1/EVIDENCE/locale-probe.mts`（**仓外**，`node --import tsx` 从包根跑，cwd 在仓内以解析 pi-ai）。

**修前（撤修臂＝base `c8bc46975` 原字节）**——zh 臂翻号实证：

| 臂（LC_ALL=LANG=） | ICU 解析 | `"修复".localeCompare("登录")` 符号 | 注入序 | digest sha256 | fingerprint |
| --- | --- | --- | --- | --- | --- |
| `C` | `en-US` | -1 | `alpha, Zeta, zhang, 修复登录, 张三, 登录故障, 登录超时` | `34bea650e3ca9dfc…6da59` | `60df5736d34474e5…4bda7` |
| `en_US.UTF-8` | `en-US` | -1 | 同 C | 同 C | 同 C |
| `zh_CN.UTF-8` | `zh-CN` | **+1** | **`登录超时, 登录故障, 修复登录, 张三, alpha, Zeta, zhang`** | **`d8692db5b8c0a16c…4f805`** | **`6d455429be9d4896…7282b8`** |

**修后（本笔落地）**——三臂全同：

| 臂 | ICU 解析 | 符号（自报，仍证明子进程真在 zh 排序下） | 注入序 | digest sha256 | fingerprint |
| --- | --- | --- | --- | --- | --- |
| `C` | `en-US` | -1 | `Zeta, alpha, zhang, 修复登录, 张三, 登录故障, 登录超时` | `a13bb4d817151d38…dc343` | `6489d3c581ec08f8…fd9cc2` |
| `en_US.UTF-8` | `en-US` | -1 | 同 C | 同 C | 同 C |
| `zh_CN.UTF-8` | `zh-CN` | +1 | 同 C | 同 C | 同 C |

node 版本各臂自报 `v22.22.0`；ranked 窗（top-3）修前 C/en=`alpha,Zeta,zhang`（en collation 序）、zh=`登录超时,登录故障,修复登录`（pinyin 序）；修后三臂=`Zeta,alpha,zhang`（码点序）。完整原始 JSON（含逐字段）在 `/tmp/fixL3a-delivery/e1/EVIDENCE/`（**不进仓**）。

**仓内对等物**：`packages/coding-agent/test/refinement-locale-independence.test.ts` 的 A 针在 vitest 里用 `spawnSync` 起三个 `node --import tsx` 子进程（env 清洗 `RLM_*`/`PRIME_AGENT_*`/`PI_*`），断言三臂 digest sha256 与 fingerprint 逐字节相同；zh 能力由子进程自报（resolved locale + CJK 比较符号），`it.skipIf` 只在「zh 臂解析不出 zh collator 或符号不翻」时跳过（理由写进谓词名与注释）；进程内正控断言 `Intl.Collator("zh-CN")` 与 `("en-US")` 对同一 CJK 对符号相反，防 skip 变空真过。

## 5. E 席仪器 `--verify`（只读跑，两遍采信）

命令（read-only，无 `--write`）：

```
cd /tmp/fixL3a-wt/e1 && node packages/coding-agent/scripts/perf/harness-parity.mjs \
  --python=python3.13 --verify --report=/tmp/fixL3a-delivery/e1/EVIDENCE/parity-<tag>.json
```

| 阶段 | 树状态 | 第 1 遍 | 第 2 遍 |
| --- | --- | --- | --- |
| 落地前（撤修臂） | `refinement.ts` = base `c8bc46975` 原字节（sha `82294d0f…`） | 93 checks / 0 failure / EXIT=0 | 93 checks / 0 failure / EXIT=0 |
| 落地后 | `refinement.ts` = 修复版（sha `37935269…`） | 93 checks / 0 failure / EXIT=0 | 93 checks / 0 failure / EXIT=0 |

两遍同结果（E2 曾 race 出假绿，故双遍）。两阶段 0 failure ⇒ **码点比较没有移动该夹具任何序**（E 席夹具平手组全 ASCII：`tie_alpha/beta/gamma`）⇒ **金标准不重铸**。两次落地后运行均带 `NOTE golden/refinement.ts moved since the golden was minted`——这是实现 sha 挪动的记账 NOTE（base 已含 OBS-1 等前批改动时同样出现），非 failure。读数原文：`EVIDENCE/parity-{pre,post}-{1,2}.log`。

## 6. 量法边界与复跑

- 本文档一切表内读数来自**实跑输出**，非转述；原始 log/JSON 在 `/tmp/fixL3a-delivery/e1/EVIDENCE/`（仓外，不进交付仓）。
- 仓外探针 `locale-probe.mts` 的 import 路径钉死本 worktree（`/tmp/fixL3a-wt/e1/...`）；**可复跑的仓内形态**是新针文件本身（每次 vitest 运行时生成子进程脚本到系统 tmpdir 并跑三臂），探针仅作留尸对照。
- 三臂子进程同 node 同 ICU；「zh 能力在场」由自报字段证明，CI runner 无 zh 数据时 A 针按谓词跳过（跳过理由可见，非静默）。
- digest 基线（base 净树，`c8bc46975`）：refinement 簇 8 文件 318 例全绿（`EVIDENCE/base-baseline/`）；修后同簇＋新针 9 文件 323 例全绿，**程序化红名差集为空**（见 NOTES §复量）。

## 7. 与其它车道的关系

- `harness-search-parity.md` §9 的「只报不修」由本笔消除；该文档 §9 与金标准的后续更新归 E 席（remint runbook `e-REMINT-RUNBOOK.md` §2）；本席不写那两处。
- `scripts/perf/**` 一个字未动（只读跑 `--verify`）；`prime-agent-runtime` / `agent-session.ts` / `FORK_NOTES.md` / `CHANGELOG.md` 未动。
- 全仓 `src/` 其余 **40 处** `localeCompare`（**24 个文件**；口径＝`grep -rn "localeCompare" packages/*/src --include="*.ts"` 得 42 处，其中 `refinement.ts` 的 2 处是本文件与源码文档字符串里的引用，其余 40 处逐条清单在 OBS-E1 交付 `EVIDENCE/localeCompare-rest-of-src.txt`）**只报不改**。**母席已裁（2026-09-18）**：40 处全部入 backlog、本批不动，按下述分层处置——
  - **优先第一＝`system-prompt.ts:182`**：enabled servers 排序**直接进 system prompt 渲染**，跨 locale 漂会作废**所有会话**的前缀缓存，影响面大于 digest 邻接面。
  - **其次＝`compaction/fact-appendix.ts:611,622`**：进压缩摘要文本。
  - **其余按 backlog 排**：`rlm-runtime.ts:260`（selector 序）、`core/kernel/bootstrap.ts` ＋ `core/retention/kernel-snapshot.ts`（内核装配序）。
  - **`model-selector.ts:364,407` 不动**：`localeCompare(x, undefined, { numeric: true })` 是**给人看的排序、刻意用法**（数字序正是它要的行为），不属"平手序必须 locale 无关"这一类；**禁止**在统一码点比较时顺手改掉。
  - **`utils/version-check.ts:42,48` 单独裁、不入此批**：那是**版本比较**，与"平手序排序"语义不同，不能混为一谈。
