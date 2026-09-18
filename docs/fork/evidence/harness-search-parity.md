# TS digest 窗 ↔ Python `harness.search` 同序证据

> 条目来源：终审席 B 第 74 条（母席 L3a 转达）。落地席：L3a-e。base `4c6623868`。
> 一句话结论：**在受限口径下两侧打分公式逐字同构，top-k id 序列逐位相同**（机器金标准 + 三方对拍 + 双侧密封针已钉死）；口径外有 **6 处分歧**，每处都登记为「有据可查的故意分歧」并被针锁住，其中 **1 处（零分）待 OBS-1 落地后收敛**，本仪器不钉那一面。
> 本文件不改任何实现：`refinement.ts` 与 `harness.py` 一个字未动（`git diff 4c6623868..HEAD -- '*/src/*'` 为空）。

---

## 0. 文件分工与拉起关系

| 文件 | 角色 | 谁来跑 |
| --- | --- | --- |
| `packages/coding-agent/scripts/perf/harness-parity.mjs` | **对拍仪器（orchestrator）**：解析参数、拉起两侧驱动、算第三方参考分、逐条比较、写金标准与报告 | 人 / 母席：`node …`（不属任何测试面） |
| `packages/coding-agent/scripts/perf/harness-parity-ts.ts` | **TS 面驱动**：`loadHarnessState` 真加载夹具，输出 idf/分数/排序/渲染窗 | 被 orchestrator 以 `node_modules/.bin/tsx` 拉起（必须住在仓内，tsx 才能按根 `tsconfig.json` 的 paths 解析到 `packages/*/src`） |
| `packages/coding-agent/scripts/perf/harness-parity-python.py` | **Python 面驱动**：`HarnessState` 真加载同一份字节，从 `search()` 自身反推 idf，输出分数/顺序 | 被 orchestrator 以 `<python> …  --runtime-src=prime-agent-runtime/src` 拉起 |
| `packages/coding-agent/scripts/perf/README.md` | 上面三件的分工与用法 | — |
| `packages/coding-agent/test/fixtures/harness-parity/state.json` | 共享夹具：一份 harness 状态文件（28 memory + 2 prompt + 1 skill + 1 subagent） | 两侧驱动各自真加载；两侧针各自真加载 |
| `…/terms.json` | 共享夹具：6 个 case 的显式 term 列表 + Python 查询串 + 期望关系（`expect`） | 同上 |
| `…/expected.json` | **机器生成的金标准**（禁手改）：两侧 idf/逐条分数/全序/top-k/渲染窗 + 参考公式的数 + regime 事实 + 生成命令 + base sha + 两侧实现 sha256 | 由仪器 `--write` 生成；两侧针读它 |
| `packages/coding-agent/test/harness-search-parity.test.ts` | **TS 侧密封针**（vitest，13 例，不 spawn python） | `npx vitest --run test/harness-search-parity.test.ts` |
| `prime-agent-runtime/test/test_harness_search_parity.py` | **Python 侧密封针**（unittest，11 例，不 spawn node，只用 stdlib） | `PYTHONPATH=src python3 -m unittest test.test_harness_search_parity -v` |

两个驱动都不 spawn 另一种语言；跨语言只发生在 orchestrator 里，且它自己不算「面」——它只比较与记录。
`packages/coding-agent/scripts/perf/**` 既不在 `biome.json` 的 `files.includes`（只含 `packages/*/src|test/**/*.ts` 与 examples），也不在根 `tsconfig.json` 的 `include`（同上），实测 `npx biome check packages/coding-agent/scripts/perf/` 报 “These paths were provided but ignored”。所以这三件只能靠**跑它**来验，本文档 §6 给命令。

---

## 1. 可钉的同序口径（5 个条件，缺一即出 §3 的分歧）

1. **同一 kind 当语料**：TS 侧 `formatHarnessStateForPrompt` 每 kind 各自为语料；Python 侧必须传 `kind=`，否则 `list(None)` 把四 kind 合一个 df 语料。
2. **同一份显式 term 列表**，两侧都绕过各自分词器（TS 传 `Map<term, weight>`，Python 走 `_search_score(entry, terms, idf)`）。
3. **TS 侧权重全为 1**（生产 digest 的权重见 §3 分歧④）。
4. **被打分字段全是字符串**（非字符串 `path` 见 §3 分歧③）。
5. **cut 之上分数互不相同且 > 0**（否则两侧各自的平手规则介入，见 §3 分歧⑥）。

满足这 5 条 ⇒ **top-k id 序列逐位相同**，k=6（TS 默认窗）与 k=10（Python 默认 limit）各钉一次。

实测（base `4c6623868`，仪器 clean run 92 checks / 0 failure）：

```
top-6  两侧同序：mem_quantum_harness > mem_session_worktree > mem_worktree_discipline
                 > mem_harness_digest_window > mem_quantum_session > mem_login_fix
top-10 两侧同序：… > mem_cjk_login_session > mem_worktree_cleanup > mem_session_ledger
                 > mem_session_prefix_cache
渲染窗（formatHarnessStateForPrompt, maxEntriesPerKind=6/10）== 上面的 top-k
逐条分数最大两侧差 = 8.88e-16（末位 ULP，见 §3 分歧⓪）；对参考公式：TS 差 0.0、Python 差 8.88e-16
```

---

## 2. 同构核心（两侧逐字引文）

**三槽 + 单 identifier 槽（path 与 id 合一）**

`refinement.ts:938-947`：
```
938: 		// One match per field counts once per term: coverage over distinct
939: 		// fields matters more than repetition inside a single field. Path
940: 		// and id form a single identifier slot: the id is often embedded in
941: 		// the path, so matching both is one signal, not two.
942: 		let fields = 0;
943: 		if (title.includes(term)) fields += 1;
944: 		if (content.includes(term)) fields += 1;
945: 		if (identifier.includes(term)) fields += 1;
946: 		if (fields > 0) {
947: 			score += weight * (idf?.get(term) ?? 1) * (1 + (fields - 1) * 0.5);
```
`harness.py:149-154`：
```
149:    identifier = _search_field(f"{entry.path} {entry.id}")
150:    total = 0.0
151:    for term in terms:
152:        slots = (term in title) + (term in content) + (term in identifier)
153:        if slots:
154:            total += (idf.get(term, 1.0) if idf is not None else 1.0) * (1 + (slots - 1) * 0.5)
```
⇒ `weight ≡ 1` 时两式逐字同构。针：`mem_embedded_id`（id 内嵌在 path 里）两侧都得 `idf("embedded") × 1.0` 而不是 `× 1.5`（字面出现两次、只算一槽）。

**idf = `log(1 + N/df)`，df=0 不入表**

`refinement.ts:917`（`harnessQueryTermIdf`）与 `:993`（`rankHarnessEntriesForQuery` 的单趟版）：
```
917: 		idf.set(term, Math.log(1 + documents / documentFrequency));
993: 		idf.set(term, Math.log(1 + fields.length / documentFrequency));
```
`harness.py:1178-1182`：
```
1178:        term_idf = {
1179:            term: math.log(1 + len(entries) / count)
1180:            for term, count in matches.items()
1181:            if count > 0
1182:        }
```
⇒ 同构。实测 10 个 term 的 idf 两侧在 1e-12 内全等（例：`worktree` 2.335374915817、`embedded` 3.367295829986、`ledger` 1.504077396776）。

**字段归一（字符串）**：`refinement.ts:828-830` `searchableField` 与 `harness.py:125-128` `_search_field` 逐字同意（非字符串 → 空串）。

**排序主键**：两侧都是 score 降序（`refinement.ts:1007`、`harness.py:1193`）。

---

## 3. 六条分歧（每条：两侧 file:line + 逐字引文 + 判定 + 谁钉 + 复跑）

### ⓪ 数值：末位 ULP（不是分歧，是口径）
两侧 `log` 实现差一个 ULP。实测逐条分数最大差 `8.88e-16`，同分三胞胎 TS `3.2386784521643808` / PY `3.2386784521643803`。
⇒ **分数比用 1e-12 容差，id 序列严格相等**（仪器 `TOLERANCE = 1e-12`，两侧针同款）。

### ① 分词下限（**故意分歧**，Python 侧 docstring 自证）
TS `refinement.ts:863-865`：
```
863: 			} else if (segment.length >= 4) {
864: 				// Short runs are noise (the, and, ids) and are dropped.
865: 				terms.push(segment);
```
Python `harness.py:96-100`（docstring 逐字写明是有意的）：
```
 96:    Minimum lengths stay below the digest builder's four-character cut
 97:    because ``search`` tokenizes explicit queries, not mined conversation:
 98:    three ASCII characters keep real terms (rlm, api, cli), two characters
 99:    keep short words of other scripts, and single characters are terms
100:    only for CJK, where one character is a word.
```
`harness.py:110`/`:114`：ASCII `>= 3`、其他文字 `>= 2`；CJK 双字两侧同（`refinement.ts:862` / `harness.py:108`）。
实测（case `tokenizer_floor`，查询 `rlm api мир 世界 worktree`）：Python terms `['rlm','api','мир','世界','worktree']`，TS terms `['世界','worktree']`，被切掉 `rlm/api/мир`。
**可观察后果**：只被 3 字符词命中的 `mem_kernel_bridge`，Python `search` 第 6 名返回它，TS digest 窗口里没有它（TS 侧该行分数 0）。
钉：TS 针 `keeps the four-character tokenizer floor…`；PY 针 `test_the_search_tokenizer_keeps_short_terms_the_digest_tokenizer_cuts`。
复跑：`node packages/coding-agent/scripts/perf/harness-parity.mjs --python=<py3.11+> --case=tokenizer_floor`
注：夹具只用 BMP CJK。astral 平面两侧切法不同（TS 按 code point、PY 按 code unit），**不要**加进夹具。

### ② df 语料：`kind=None` 合并（**分歧**，由构造决定）
TS `refinement.ts:1066-1069`：
```
1066: 		// The ranked corpus is the kind's own entries: they compete for the
1067: 		// same top-k slots, so document frequency discounts terms ubiquitous
1068: 		// within the kind rather than across unrelated kinds.
1069: 		const ranked = Object.values(state.entries[kind]);
```
Python `harness.py:1165` `entries = self.list(kind)`，`kind=None` 时 `list()` 走 `kinds = list(_KINDS)`（`harness.py:775`）⇒ 四 kind 合一个语料（`harness.py:778` 还把它按 `(kind,path,title,id)` 排序，TS 侧是状态文件的键序；两侧的排序都是全序，故内序不影响结果）。
实测（case `df_corpus`，同一 term 表）：TS 语料 28 条、Python 语料 32 条；**10 个 idf 值全不同**（`worktree`：TS 2.3353749158170367 vs PY 2.1972245773362196）；top-6 从第 4 位起分叉（PY 把 `mem_login_fix` 提到第 4，且第 10 名换成 `prompt_digest_carrier`——非 memory 行进了窗）。
判定：**kind 指定时同构；`kind=None` 时是分歧**。digest 面没有「合并语料」这个面，所以对齐只能靠调用方永远传 `kind`。
钉：TS 针 `ranks one kind at a time…`；PY 针 `test_kind_none_merges_the_corpus_which_the_digest_never_does`。

### ③ 非字符串字段（**分歧**，只有畸形状态文件可达）
TS `refinement.ts:828-830` + `:896`：
```
828: function searchableField(value: unknown): string {
829: 	return typeof value === "string" ? value.toLowerCase() : "";
830: }
896: 		identifier: `${searchableField(entry.path)} ${searchableField(entry.id)}`,
```
Python `harness.py:125-128`（title/content 与 TS 同意：非字符串 → 空串）**但 identifier 先拼后归一**（`harness.py:149` `f"{entry.path} {entry.id}"`），且 loader 会把非字符串 `path` 修成 `"general"`（`harness.py:541-542`）：
```
541:                        if not isinstance(entry_data.get("path"), str):
542:                            entry_data["path"] = "general"
```
⇒ 对 `state.json` 里 `path` 存成数字 `123` 的那行（`mem_numeric_path`）：Python loader 修成 `"general"`，identifier 变成 `general mem_numeric_path`，用词 `general` 能查到它（score `3.367295829986474`）；TS loader 不修，`searchableField(123)` 得空串，identifier 变成 `" mem_numeric_path"`，`general` 一个都查不到（该 case 下 TS 侧 idf 表为空、全语料 0 分）。
**母席表里这条要更正一处**：Python 不是「`str()` 出 `123`/`none`」——`_search_field` 对非字符串同样返回空串；分歧只出在 ①identifier 的「先拼后归一」②loader 的 `path` 兜底，且 `title`/`content` 两侧完全对称。id 两侧都恒为字符串（JSON 对象键 / `entry_data["id"] = str(entry_id)`），不参与分歧。
钉：TS 针 `loses a non-string path from the identifier slot…`；PY 针 `test_a_non_string_path_is_repaired_here_and_lost_by_the_ts_identifier_slot`。
注：这个 case 下 TS 侧 memory 语料**全零分**，故本仪器**不记录也不断言**它的渲染窗（金标准里 `digest_window` 为 `null`，`digest_face` 写明让面给 OBS-1）；只钉分数级。

### ④ term 权重（**分歧**，参数面）
TS `refinement.ts:825` `export type HarnessQueryTerms = Map<string, number>;`，`:947` 乘 `weight`；生产权重来自 `agent-session.ts:12712-12744 _buildHarnessDigestQueryTerms`：objective=3，最近 4 条消息 2→1.5→1→1（`Math.max(1, recencyWeight - 0.5)`），48 词上限。
Python `harness.py:151-154` 每 term 恒 1，`search()` 没有权重入参。
实测（case `weights`，term 表 `{worktree:3, session:2, digest:1.5, quantum:1}`）：TS top-6 `session_worktree > worktree_discipline > worktree_cleanup > quantum_session > session_prefix_cache > session_ledger`；Python top-6 `session_worktree > quantum_session > worktree_discipline > quantum_harness > session_prefix_cache > worktree_cleanup`；11 行分数不同。
判定：**权重全 1 时逐字同构；生产 digest 真用权重**，所以「同序」只在权重全 1 的口径下成立。
钉：TS 针 `keeps the digest's term weights…`；PY 针 `test_the_digest_term_weights_have_no_counterpart_here`。

### ⑤ 零分条目（**待 OBS-1 落地后收敛**；本仪器只钉分数级一致）
Python `harness.py:1187-1188` 丢弃：
```
1186:            score = _search_score(entry, terms, term_idf)
1187:            if score > 0:
1188:                scored.append((entry, score))
```
TS 旧面保留（`rankHarnessEntriesForQuery` 返回全序，零分行按 identifier 平手键排在有分之后）。
**OBS-1（fix-perf-digest-2 item46，patch base `4c6623868`）落地后**：某 kind **全零分**时 TS 渲染面回落 `entriesForInjection`（recency 序）且**不打** `(entries ranked by relevance…)` 标；有分 kind 的命中路径逐字不变，`rankHarnessEntriesForQuery` 导出签名与行为不变。
⇒ 处置（母席 21:0x 令）：**本仪器与两侧针一律不断言全零 kind 的渲染面**（既不断言旧面也不断言新面），零分只钉「两侧 score 都 = 0」+「Python 的 search 结果里没有它们」。集成顺序无论谁先谁后都不红。
钉：TS 针 `pins zero-score rows at the score level only…`；PY 针 `test_zero_score_rows_are_dropped_here_and_score_zero_on_both_faces`；仪器 face invariant `python drops zero-score rows` / `ts ranks the whole kind corpus`（每个 case 都跑，`--break` 时也跑）。
实测：4 行零分（`mem_parallel_lanes`/`mem_prompt_cache`/`mem_font_metrics`/`mem_numeric_path`），两侧分数都恰为 0，Python 24 条命中里没有它们。

### ⑥ 平手规则（**故意分歧**，母席 21:0x 已裁：不对齐）
TS `refinement.ts:1006-1012`：
```
1006: 	scored.sort((x, y) => {
1007: 		if (y.score !== x.score) return y.score - x.score;
1008: 		// Tie-break on the stable identifier order only: calling a score
1009: 		// comparator here would recompute both sides' scores on every
1010: 		// comparison and reintroduce the O(N log N) full-text sweep.
1011: 		return rankedIdentifier(x.entry).localeCompare(rankedIdentifier(y.entry));
```
（`rankedIdentifier` = `[path, title, id].join("\0")`，`refinement.ts:953-955`；选它是**渲染确定性/prompt 前缀缓存**承重件——recency 一动 digest 字节就漂。）
Python `harness.py:1144-1146`（docstring 自证）+ `:1189-1193`：
```
1144:        distinctive term outranks terms present in most entries. Zero-score
1145:        entries are dropped. Ties fall back to the most recently updated entry
1146:        and then to ``(kind, id)``, so one query always returns one order.
1189:        # Two stable passes: sort by the fallback key first, then by the primary
1190:        # keys descending, which yields score desc -> updated_at desc ->
1191:        # (kind, id) asc without making the identifier tiebreak reverse too.
1192:        scored.sort(key=lambda hit: (hit[0].kind, hit[0].id))
1193:        scored.sort(key=lambda hit: (hit[1], _search_recency(hit[0])), reverse=True)
```
实测（case `tie_window`，terms `quantum ledger`，三胞胎 `tie_alpha/beta/gamma` 同 title/content/path、分数全等 `3.238678452164380x`，只有 `updated_at` 不同）：
```
TS  top-6: mem_quantum_annealing, mem_quantum_harness, mem_quantum_session, tie_alpha, tie_beta, tie_gamma
PY  top-6: mem_quantum_harness, mem_quantum_session, mem_quantum_annealing, tie_beta, tie_gamma, tie_alpha
```
⇒ **同一 state 同一 query，两侧「模型看到的 6 条」完全不同**（既有同分三胞胎的序差，也有上面那组 3 条同分 quantum 行的序差）。这条不是数值细节，是可见面差。
判定：**故意分歧，母席已裁不对齐**（TS=渲染确定性/前缀缓存；PY=交互查询的新鲜度）。
**但 TS 这条平手键本身有一处环境依赖，见 §9 的顺带发现**：`localeCompare` 没传 locale，非 ASCII 排序键的序会随进程 ICU locale 变（实测 zh_CN 与 en_US 相反），而它被选中的理由正是「渲染确定性」。两侧各自的既有针也锁着这条：`refinement.test.ts:1789`（`breaks score ties by stable identifier order, not recency`）、`refinement.test.ts:1912-1948`（参考比较器写死 identifier 序）、`test_harness.py:1459-1484`（`test_search_orders_by_score_then_recency_then_identity`）。本席新针与它们同向，不冲突。
钉：TS 针 `holds the identifier tie-break…`；PY 针 `test_ties_fall_back_to_recency_which_the_ts_face_deliberately_does_not`。

### 附：top-k 参数面（不是分歧）
TS `DEFAULT_OVERVIEW_ENTRY_LIMIT = 6`（`refinement.ts:44`，`formatHarnessStateForPrompt` 的 `maxEntriesPerKind` 默认值）；Python `search(limit=10)`（`harness.py:1133`）。纯参数，两侧各钉 k=6 与 k=10。

---

## 4. 三方对拍仪器

**为什么要三方**：金标准若由一侧生成、再由同一侧自证，就是循环。所以仪器要求三个独立计算同分才写金标准：

1. **TS 面**：真 `loadHarnessState` + 真 `harnessQueryTermIdf` / `scoreHarnessEntryForQuery` / `rankHarnessEntriesForQuery` / `formatHarnessStateForPrompt`。
2. **Python 面**：真 `HarnessState` + 真 `search()`；**idf 不重算**，从 `search()` 自身反推——单词查询的命中分 ÷ 同一行 `_search_score(entry, [term], None)`（权重全 1 的槽因子）＝该 term 的生产 idf，多命中之间必须给出同一个值（否则仪器报错）。逐条分数再用 `_search_score(entry, terms, 反推 idf)` 算，并与 `search()` 的命中分互校。
3. **参考公式（第三方 oracle）**：`harness-parity.mjs` 里的 `referenceFace()`，按 §2 的文档化公式独立重写（三槽、`log(1+N/df)`、`1+(slots-1)*0.5`、score 降序），**两侧各一套约定**：字段归一（TS 逐槽归一 / Python 先拼后归一 + `path` 兜底 `general` + loader 丢弃 title/content 非字符串的行）、平手（TS identifier `localeCompare` / Python 两趟稳定排）、零分（TS 保留 / Python 丢弃）。
   **出处声明（母席要求）**：参考公式是本席按两侧的**文档化口径**（`refinement.ts:872-877`、`:922-926`、`harness.py:140-155`、`:1138-1147` 的 docstring）自己重写的第三份实现，不抄任一侧的代码路径（没有 `Uint8Array` 单趟、没有两趟稳定排的代码形状，排序键与归一约定按 §3 的引文逐条实现）。它**只当交叉校验**，不当任何一侧的金标准来源；金标准里的 `ts.*` 全部来自 TS 面实跑、`python.*` 全部来自 Python 面实跑、`reference.*` 单列，三者互比。实测：参考 vs TS 逐条差 `0.0`，参考 vs Python 逐条差 `≤8.88e-16`。

**正控（`--break=<side>:<name>`）**：一次只弄坏**一面**（同时弄坏两面会一起动，只能被金标准抓到，证明不了跨语言比较器）。5 个开关：`ts:idf`、`ts:slot-factor`、`py:idf`、`py:zero-drop`、`py:tiebreak`。装了开关而**没被抓到**⇒ 仪器报 “positive control held” 的反面并以 exit≠0 结束（比较器空转比红更坏）。实测 5/5 都被跨面检查（不只是金标准检查）抓到，见 §7。

**regime 守卫**：每次跑都重算并断言夹具还在口径内（≥24 memory、≥10 正分、top-10 分数互不相同、恰一个 ≥3 行的同分组且低于第 10 名、≥3 行零分、Python 丢零分、零分两侧都 = 0）。夹具被人改坏 ⇒ 仪器红，而不是让针变成空断言。

**其它口径**：`--python` 无静默回退（低于 3.11 直接 abort 并提示怎么传）；整体看门狗默认 180s、每个子进程取其一半；`--report=` 默认写系统临时目录（不往仓里留未跟踪文件）；exit 0=全过、1=有检查失败（含 `--break` 未被抓到）、2=看门狗或驱动起不来。

---

## 5. 金标准（`expected.json`）

- 生成：`node packages/coding-agent/scripts/perf/harness-parity.mjs --python=<py3.11+> --write`（**只有全部 side-vs-side 与参考检查通过才写**；有失败就拒写并 exit 1）。
- 内容：`generated_at` / `generated_by` / `base_sha` / `python_version` / `tolerance` / 两侧实现的 `path`+`sha256` / 两份夹具的 `sha256` / `regime` / 6 个 case 的 `ts`、`python`、`reference` 三面全量数（idf、逐条分数、全序、top-k、渲染窗、语料序、tokenizer 词表）。
- 本次金标准的出处：base `4c6623868a39a292e8cc5e022b7f5fd811af0eb5`，`refinement.ts` sha256 `57dcc35e9f00…21fc0f84`，`harness.py` sha256 `20e9f8e130b2…4f604`，Python 3.11.13。
- **实现文件 sha 变化只记 note、不判红**：OBS-1 落地会改 `refinement.ts` 的 sha，但命中路径逐字不变 ⇒ 仪器仍逐数比对，只在 sha 不等时打一条 note 提示「实现动过了，数仍逐条比对；只有数真变了才 `--write` 重铸」。这样集成顺序谁先谁后都不红。
- 可再生证明（删掉→重跑→两侧针仍绿）见 §7 的 G0 段。

---

## 6. 复跑命令（含 Python 口径差）

```sh
# 仪器（三方对拍 + 金标准漂移 + regime 守卫）
node packages/coding-agent/scripts/perf/harness-parity.mjs --python=<python3.11+>
# 重铸金标准
node packages/coding-agent/scripts/perf/harness-parity.mjs --python=<python3.11+> --write
# 正控（必须 exit≠0 且报 “positive control held”）
node packages/coding-agent/scripts/perf/harness-parity.mjs --python=<python3.11+> --break=py:idf

# TS 侧针（vitest 面密封，不 spawn python）
cd packages/coding-agent && npx vitest --run test/harness-search-parity.test.ts

# Python 侧针（unittest 面密封，不 spawn node）
cd prime-agent-runtime && PYTHONPATH=src python3 -m unittest test.test_harness_search_parity -v
```

**Python 口径差（母席要求写明）**：仓内 runtime 的 CI 口径是 `uv run python -m unittest …`，本席实测口径是 `PYTHONPATH=src <python3.11> -m unittest …`（本机用 kernel venv 的 3.11.13）。两者等价，理由是可证的：**`test_harness_search_parity.py` 只 import 标准库（`json/os/shutil/stat/tempfile/unittest/pathlib/typing`）+ `rlm.harness`**，不碰 `mcp`/`tyro`/`dill`，所以不需要 `uv` 装依赖；`rlm.harness` 自身也只 import 标准库。不用 `uv run` 的原因：它会在 `prime-agent-runtime/` 建未跟踪的 `.venv`（违「交付前树必须干净」的闸）且要联网解析依赖。
跑前清环境（AGENTS.md 卫生条）：`env -u PRIME_AGENT_CODING_AGENT_DIR -u PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID …`，否则子进程会写到真的 `~/.prime/agent`。

---

## 7. 变异与正控证据（22 条，全部实测 RED）

变异只在 scratch worktree（`git worktree add --detach /tmp/fixL3a-e-mut 189d5b3c5`，`node_modules` 符号链回交付树）里做，**针文件保持不动**；每条跑完 `git checkout -- <file>` 还原并用 sha256 核对（22/22 `restored=True`）。退出码卫生：一律 `cmd > log 2>&1; echo EXIT=$?`（不用管道，管道会把退出码换成 `tail` 的），判红用「真退出码 + 日志正文的 `Tests x failed` / `FAILED (…)` 行」互证。RED 原文（含用例名与断言原文）在 `/tmp/L3a/children/e-REPORT.md`，逐条日志在 `/tmp/L3a/children/e-probe/mutations/`。

**正控（针不是恒绿）**：worktree 未变异时两侧针先跑绿（TS `13 passed` EXIT=0 / PY `Ran 11 tests … OK` EXIT=0）；把金标准整份删掉，两侧针立刻红（TS `1 failed … no tests`，PY EXIT=1）⇒ 针真的在读金标准，不是空断言。

### 7.1 金标准变异（10+1 条，改数不改实现）

| # | 变异 | 红了的针（用例名） |
|---|---|---|
| G1 | `parity.ts.scores.mem_quantum_harness += 0.5` | TS `scores every entry exactly as the golden records for both languages`（`ts score …: 9.515154843168265 vs 10.015154843168265`）；PY `test_every_entry_scores_what_the_golden_records_for_both_languages` |
| G2 | 对调 `parity` top-6 前两个 id（**两侧同改**） | TS `ranks the top-6 window…` + `injects the same top-6 window into the rendered digest`；PY `test_top_k_window_matches_the_ts_digest_window (limit=6)` + `test_kind_none_merges_the_corpus…` |
| G3 | 对调 `tie_window` top-6 里的 `tie_alpha`/`tie_beta`（两侧同改） | TS `holds the identifier tie-break…`；PY `test_ties_fall_back_to_recency…`（`First differing element 3: 'tie_beta'`） |
| G4 | 对调 `parity.ts.digest_window["6"]` 前两个 id | TS `injects the same top-6 window into the rendered digest` |
| G5 | `regime.top10_distinct=false` + `regime.tie_groups=[]` | TS `keeps the fixture inside the regime…` + `holds the identifier tie-break…`；PY `test_fixture_stays_inside_the_regime…`(error) + `test_ties_fall_back_to_recency…` |
| G6 | `regime.zero_ids` 里把 `mem_font_metrics` 换成正分行 `mem_quantum_harness` | TS `pins zero-score rows at the score level only…`；PY `test_zero_score_rows_are_dropped_here_and_score_zero_on_both_faces`（2 处 subTest） |
| G7 | `nonstring_path.python.idf.general = 0` | TS `loses a non-string path from the identifier slot…` |
| G7b | `nonstring_path.python.top_k["6"] = []` | PY `test_a_non_string_path_is_repaired_here_and_lost_by_the_ts_identifier_slot` |
| G8 | `weights.python.top_k["6"] := ts.top_k["6"]`（分歧被抹平） | TS `keeps the digest's term weights…`；PY `test_the_digest_term_weights_have_no_counterpart_here` |
| G9 | `df_corpus.python.idf := ts.idf`（分歧被抹平） | TS `ranks one kind at a time…`；PY `test_kind_none_merges_the_corpus…` |
| G10 | `parity.python.scores.mem_embedded_id ×1.5`（单槽变两槽） | TS `counts path and id as one identifier slot…` + `scores every entry…`；PY `test_every_entry_scores…` |

G8/G9 是「分歧被抹平也要红」的针：它们证明分歧针不是恒真断言，而是钉住了**当前的不等关系**。

### 7.2 实现侧变异（TS 5 条，改 `refinement.ts`）

| # | 变异 | 红了的针 | 旁证（既有针也红） |
|---|---|---|---|
| I1 | 平手键改成 recency 优先（`entryRecency(y)` vs `entryRecency(x)`），identifier 退居第二 | TS `holds the identifier tie-break…` + `keeps the digest's term weights…`（2 failed / 11 passed） | `test/refinement.test.ts` 2 failed：`breaks score ties by stable identifier order, not recency`、`ranks a rare distinctive term over a common-term-dense entry` |
| I2 | 分词下限 `>= 4` → `>= 3` | TS `keeps the four-character tokenizer floor…` | `refinement.test.ts` 2 failed：`tokenizes "Fix the LOGIN bug" into ["login"]`、`tokenizes "Привет мир" into ["привет"]` |
| I3 | identifier 单槽拆成 path/id 两槽 | TS `counts path and id as one identifier slot…` + `scores every entry…` | — |
| I4 | 多槽因子 `0.5` → `0.25`（只改导出的逐条打分器） | TS `scores every entry…` + `holds the identifier tie-break…` | — |
| I5 | 排序窗忽略权重（`termList[t][1] *` → `1 *`） | TS `keeps the digest's term weights…` | — |

### 7.3 实现侧变异（Python 6 条，改 `harness.py`）

| # | 变异 | 红了的针 | 旁证（既有针也红） |
|---|---|---|---|
| I6 | 去掉 `if score > 0`（零分不再丢弃） | PY 7 failed，含 `test_zero_score_rows_are_dropped_here_and_score_zero_on_both_faces`、`test_top_k…`、`test_kind_none…`、`test_a_non_string_path…`、`test_path_and_id_share_one_identifier_slot…`、`test_the_digest_term_weights…`、`test_fixture_stays_inside_the_regime…` | `test/test_harness.py` 5 failed：`test_search_returns_empty_when_nothing_matches`、`test_search_treats_punctuation_as_separators`、`test_search_matches_cjk_bigram_inside_a_longer_word`、`test_search_keeps_upstream_tokenizer_floors_and_cjk_boundaries`、`test_search_hit_shape_snippet_and_score_weights` |
| I7 | 排序去掉 recency（`key=lambda hit: hit[1]`） | PY 3 failed：`test_ties_fall_back_to_recency…`、`test_the_search_tokenizer_keeps_short_terms…`、`test_zero_score_rows…` | `test_harness.py` 2 failed：`test_search_orders_by_score_then_recency_then_identity`、`test_search_discounts_common_terms_and_keeps_frequency_ties` |
| I8 | idf 分母 `count` → `count + 1` | PY 9 failed（几乎所有用例） | — |
| I9 | ASCII 分词下限 `>= 3` → `>= 4`（去贴 TS） | PY 7 failed，含 `test_explicit_terms_round_trip_through_the_production_tokenizer`、`test_the_search_tokenizer_keeps_short_terms…` | — |
| I10 | loader 不再把非字符串 `path` 兜底成 `"general"`（改 `str(...)`） | PY 1 error：`test_a_non_string_path_is_repaired_here_and_lost_by_the_ts_identifier_slot` | — |
| I11 | `entries = self.list(kind)` → `self.list(kind or "memory")`（`kind=None` 不再合语料） | PY 1 failed：`test_kind_none_merges_the_corpus_which_the_digest_never_does` | — |

**覆盖**：TS 侧 11 个 `it`（13 例）与 Python 侧 11 例，每一例都至少被一条变异打红（见上表用例名）。

### 7.4 仪器正控（`--break=<side>:<name>`，5/5 被抓，全部 exit=1）

一次只弄坏一面（同时弄坏两面会一起动，只有金标准能抓到，证明不了跨语言比较器）：

| 开关 | 弄坏什么 | 抓到它的检查（原文摘要） |
|---|---|---|
| `ts:idf` | TS 面打分不乘 idf | `FAIL parity/score parity: [{"key":"mem_worktree_discipline","ts":4,"python":7.909428283798453}, …]`（13 failures） |
| `ts:slot-factor` | TS 面多槽因子改 `0.25` | `FAIL parity/score parity: … "ts":6.741740825889936,"python":7.909428283798453`（15 failures） |
| `py:idf` | Python 面 `_search_score(…, idf=None)` | `FAIL parity/score parity: … "ts":7.909428283798453,"python":4`（13 failures） |
| `py:zero-drop` | Python 面把零分行留在结果里 | `FAIL parity/python drops zero-score rows: search returned mem_font_metrics,mem_numeric_path,mem_parallel_lanes,mem_prompt_cache at score 0`（face invariant，与金标准无关也抓得到） |
| `py:tiebreak` | Python 面平手改按 id 排 | `FAIL parity/top-6 order parity: ts mem_quantum_harness,… != python mem_harness_digest_window,…`（16 failures） |

每条都打印 `harness-parity: positive control held - --break=<name> produced N failure(s)` 并 exit 1；若某条开关**没被抓到**，仪器会打印 `--break=<name> was NOT caught; the comparator is vacuous` 并同样 exit 1（空转比红更坏）。开关名必须带面（`ts:` / `py:`），不带面的 `--break=idf` 会被拒并说明理由。

### 7.5 金标准可再生（删掉 → 重跑 → 两侧针仍绿）

在第二个 scratch worktree（`/tmp/fixL3a-e-regen` @`189d5b3c5`）里做的，交付树全程未动：

```
1) rm expected.json
2) TS 针 → EXIT=1（Test Files 1 failed / Tests no tests：金标准不在就起不来）
   PY 针 → EXIT=1
3) node packages/coding-agent/scripts/perf/harness-parity.mjs --python=<py3.11> --write
   → "harness-parity: wrote …/expected.json"，91 checks 0 failure，EXIT=0
   （91 而不是 92：金标准不存在时少一条 "live run reproduces expected.json"）
4) 重铸件 vs 已提交件逐字段对比（排除 generated_at）：differing fields = 1
   → 唯一差异是 base_sha（'4c6623868a39…' vs '189d5b3c5e99…'），因为重铸发生在
     更晚的 HEAD 上；两个 provenance 字段（generated_at / base_sha）都在仪器
     漂移比较的 VOLATILE_KEYS 里，所以不影响判红
5) TS 针 → 13 passed，EXIT=0；PY 针 → Ran 11 tests OK，EXIT=0
6) 仪器默认模式复跑 → "PASS golden/live run reproduces expected.json: 6 cases"，
   92 checks 0 failure，EXIT=0
```

⇒ 金标准里**没有一个手打数字**：删掉能原样长回来（除两条 provenance），两侧针照绿。

---

## 8. 不在本仪器面上的东西（让面声明）

- **全零 kind 的渲染面与 ranked 标记**：归 OBS-1（fix-perf-digest-2 item46，`/tmp/fixL3a-delivery/item46/000{1,2}-*.patch`，base `4c6623868`）。本仪器的 TS 驱动在「该 kind 全零分」时把 `digest_window` 记成 `null` 并写明让面理由，两侧针都不断言零分行的位置、不断言标记有无。
- **`rankHarnessEntriesWithRelevance`**：OBS-1 新增且**不导出**。需要「这个 kind 是不是全零分」这个事实时，用已导出的 `scoreHarnessEntryForQuery` + `harnessQueryTermIdf` 自算（本席针与驱动都是这么做的），不为拿这个事实去改导出面。
- **打分公式本身**：本席未改 `refinement.ts` / `harness.py` 一个字（母席硬纪律）。§3 的六条分歧一律「只钉不修」；要修哪条，先按 §3 的判定走裁定。

---

## 9. 顺带发现（不在本条目面内，**只报不修**，交母席裁）

### OBS-E1：TS 侧 5 处 `localeCompare` 都没传 locale ⇒ digest 的**序与指纹**随进程 locale 变

**现象（实测，node v22.22.0，同机同串只改环境）**：

| 比较 | `LC_ALL=en_US.UTF-8` | `LC_ALL=C` | `LC_ALL=zh_CN.UTF-8` |
|---|---|---|---|
| `"修复顺序".localeCompare("登录超时")` | `-1` | `-1` | **`+1`** |
| `"登录".localeCompare("修复")` | `+1` | `+1` | **`-1`** |
| `"登录".localeCompare("世界")` | `+1` | `+1` | **`-1`** |
| `"general\0修复顺序\0mem_fix_order"` vs `"general\0登录超时\0mem_login_timeout"`（`rankedIdentifier` 形状） | `-1` | `-1` | **`+1`** |

（`LC_ALL=C` 时 Node 的 ICU 解析成 `en-US`，所以「C 与 en_US 同」不代表 locale 无关；探针脚本与三份原始输出见 `/tmp/L3a/children/e-probe/locale-probe{,2}.mjs`、`locale-*.log`。）

**触碰面（全部在 `refinement.ts`，本席禁区，一个字未动）**：
- `:1011` ranked 平手键 `rankedIdentifier(x).localeCompare(rankedIdentifier(y))`，键含 **title**（模型写的，中文常态）；注释 `:1008-1010` 明写选它是为了不再扫全文，而 `:1025-1028` 的 docstring 明写「break score ties on stable identifier order, never recency」，`compareEntriesForInjection` 的注释 `:367-370` 更直说理由是「an ordering that drifts between turns would invalidate the prompt cache」。
- `:373/:377/:381` 默认注入序（recency → id → scope），**无查询词的普通会话每一回合都走这条**；id 可以是中文：`harness.py:46-49 _slug` 用 `ch.isalnum()` 过滤，而中文字符 `isalnum()` 为真 ⇒ 实测 `_slug("登录故障") == "登录故障"`、`_slug("世界书") == "世界书"`（不显式给 id 时由标题生成）。
- `:1195` `harnessDigestFingerprint` 的 material 排序键 `[scope, kind, id].join("\0").localeCompare(...)`。

**两个后果（都可复现，未在生产验证）**：
1. **digest 字节漂**：两条同分（或同 `updated_at`）且排序键首次在非 ASCII 处分岔的条目，在 zh_CN 进程下与 en_US 进程下**顺序相反** ⇒ 同一 harness state 渲染出不同字节 ⇒ prompt 前缀缓存失效（这正是 `:367-370` 注释要避免的事）。
2. **digest 重复交付**：`:1195` 的排序也随 locale 变 ⇒ 同一 state 的**指纹不同** ⇒ `_harnessDigestIsFresh` 判为不新鲜 ⇒ 冷边界重新追加一条 carrier（内容可能与上一条只有顺序差）。

**触发条件（窄但真实）**：需要「排序键含非 ASCII」+「同分或同时间戳」+「两次渲染的进程 locale 不同」。本机 boss 环境是中文 locale 可得的（`LANG=zh_CN.UTF-8` 一设即触发），daemon 与其 worker 的 locale 由启动环境继承，重启/换 shell/换 launchd 都可能变。

**建议修法（不属本席面，需母席裁 + 与 item46 的独占面协调）**：把 5 处比较换成 locale 无关的形式——`localeCompare(other, "en")`（或复用一个 `new Intl.Collator("en")`，比每次 `localeCompare` 快）、或直接 code-point 比较（`a < b ? -1 : a > b ? 1 : 0`）。**注意**：任何一种都会移动现有平手序 ⇒ 会打红 `refinement.test.ts:1789`（`breaks score ties by stable identifier order, not recency`）、`:1912-1948`（参考比较器写死 identifier 序）与本席 `tie_window` 那枚针的金标准，属「有意改口径」，必须走裁定而不是顺手改。

**本席面的自保（已做）**：夹具的平手组 identifier 全为 ASCII（`tie_alpha/beta/gamma` 同 path 同 title，只差 id 后缀），`weights` case 里唯一一对含中文标题的正分平手（`mem_session_ledger` vs `mem_cjk_login_session`）在 identifier 的 ASCII 前缀（`docs/…` vs `notes`）就分出胜负、不落到中文；仪器与两侧针在 `LC_ALL=en_US.UTF-8 / zh_CN.UTF-8 / C` 三种 locale 下**各自全绿**（TS 13 passed ×3、PY 11 OK ×3、仪器 92 checks 0 failure ×3）。仪器**不记录零分尾序**（零分区只由 `localeCompare` 决定，是唯一真正 locale 敏感的区），只记录零分行的**集合**；参考面的 TS 全序同样只存正分前缀。

### OBS-E2：母席公式对读表的一处机制更正（已认账）

见 §3③：非字符串字段那条不是「Python 会 `str()` 出 123/none」。`_search_field`（`harness.py:125-128`）对非字符串**同样返回空串**，与 TS 的 `searchableField`（`refinement.ts:828-830`）对称；真分歧只有两处：identifier「先拼后归一」（`harness.py:149`）与 loader 把非字符串 `path` 兜底成 `"general"`（`harness.py:541-542`）。
