# PR-C1 实施报告：窗口单一权威（ADC-1 候选A）

## 结论（一句话）

按方案书 ② ADC-1 候选 A 实施完成：`judgeChildTranscriptAge` 成为子转录年龄的唯一权威（一个函数、两个调用点：child-transcripts 类 + artifact-dirs 的 descendantBlocker），混合目录在树内受保护字节各自窗口走完前被整目录保住（`young:child-transcript:30d`），过窗后一次回收到位；红测（改动前 2 failed）、正控、两等价面、保守面全部按方案书 ⑤ 落地并绿。**偏差=none**。

- commit：`2755faa8c`（基线 a5456df68，分支 r42/c1-window-authority，工作树 /tmp/audit_r/round-42/wt-c1）
- 红测证据：`/tmp/audit_r/round-42/c1-red.txt`（未改动代码上跑新测试）
- 绿测证据：`/tmp/audit_r/round-42/c1-green.txt`、`/tmp/audit_r/round-42/c1-green-postcheck.txt`

## 1. 红测证据（先红后绿，未改动代码的真实输出）

新文件 `packages/coding-agent/test/retention-adc1-window.test.ts`（6 例），在**未改动**的源码上跑：

```
 ❯ test/retention-adc1-window.test.ts (6 tests | 2 failed) 31ms
     × keeps a deleted child's transcript, and its parent directory, until the transcript window passes 10ms
     ✓ reclaims the whole directory once the transcript window passes (positive control) 4ms
     × keeps the whole directory in the middle of the two windows and reports the transcript as young 4ms
     ✓ reclaims a pure residue directory on the residue window, with no protected bytes inside 3ms
     ✓ keeps an unrecorded transcript directory unconditionally when the ledger was not scanned 3ms
     ✓ has the same end state at 7d/childTranscriptDays=7 as at 31d/childTranscriptDays=30 7ms
  Test Files  1 failed (1)
       Tests  2 failed | 4 passed (6)
  EXIT=1
```

两条失败正是 ADC-1 打穿点（residue 整目录回收把 30d 窗内的子转录一起带走）：

```
 FAIL ... > keeps a deleted child's transcript, and its parent directory, until the transcript window passes
AssertionError: expected false to be true   (test/retention-adc1-window.test.ts:192)
  192|   expect(existsSync(f.transcriptPath)).toBe(true);
 FAIL ... > keeps the whole directory in the middle of the two windows and reports the transcript as young
AssertionError: expected false to be true   (test/retention-adc1-window.test.ts:224)
  224|   expect(existsSync(f.parentDir)).toBe(true);
```

fixture 与方案书一致：父 P 墓碑在役（`recordSessionArtifactTombstone`，deletedAt = -8d）、P 树 9d 无写、`<P>/sub-abcdefgh/<C>.jsonl`（9d，ledger `rlm-ledger/x.jsonl` 里 C 的 v:1 spawn+delete）、`<P>/harness/` residue。

## 2. 改动清单（逐文件）

| 文件 | 改动 |
|---|---|
| `packages/coding-agent/src/core/retention/fs-walk.ts` | `TreeAggregate` 增 `transcripts: {id, path}[]`，在现有 `transcriptIds` 同一判定处收集（复用 walk 已有的 lstat，零新增 syscall）；初始化补 `transcripts: []` |
| `packages/coding-agent/src/core/retention/child-transcripts.ts` | 新增导出 `judgeChildTranscriptAge({transcriptPath, now, days, tree?})` → `unverifiable("gone"/"tree")` / `young` / `expired`，公式逐字保持：`ageMs = now - Math.max(转录 lstat.mtimeMs, aggregateTree(subDir, {maxDepth:2}).newestMtimeMs)`，窗口 `days * 86400000`，tree.unreadable → 保守；类内 scanAndReclaim 与 blocker 共用；新增常量 `CHILD_TRANSCRIPT_TREE_MAX_DEPTH = 2`（两调用点同参数） |
| `packages/coding-agent/src/core/retention/artifact-dirs.ts` | `descendantBlocker` 改为遍历 `candidate.tree.transcripts`：ledger 记为已删子的转录 → 调共享 helper（subDir=dirname(path)，默认 maxDepth 2）；未过窗 → `{path: candidate.path, reason: young:child-transcript:${days}d}` 保住父目录；过窗 → 维持现状豁免（continue）；helper 报 unverifiable（sub 树不可读）→ `unverifiable:child-transcript-tree` 保守保住；活边（不在 `ledgerDeletedChildIds`）与 ledger 未扫描（集合 undefined）→ 现行为不动（`reference:descendant-transcript:<id>`） |
| `packages/coding-agent/docs/settings.md` | 新增 "Which window applies to which bytes" 小节：方案书 ② 的权威表（转录 / display 墓碑 / 其余 residue / 全空目录 / ledger 各自窗口与唯一判定实现）+ max-window 规则句（混合目录寿命 = 树内受保护字节各自窗口的最大值，7~30d 之间报 `young:child-transcript:30d`，30d 后一次回收） |
| `packages/coding-agent/test/retention-adc1-window.test.ts` | 新文件，6 例（见下） |
| `packages/coding-agent/.changes/r42-adc1-window-authority.md` | changelog fragment 一行用户可感句式 |

词表未动：`young:${string}` / `unverifiable:${string}` 已在 types.ts，未改 `types.ts`。

## 3. 等价与正控结果（方案书 ⑤）

测试名 → 断言（全部绿，来自 `c1-green.txt`）：

1. **红/回归**：sweep 后 `existsSync(子转录)=true`、`existsSync(父目录)=true`、父目录 skip = `young:child-transcript:30d`、residue 类 reclaimed=0、转录自身 skip = `young:30d`（两个调用点对同一字节同一窗口同一答复）。
2. **正控**：同树 now +31d → 转录与父目录均消失、residue 类 reclaimed=1、父目录无 skip（证明测试真能检出删除，不是把打穿换成永不删除）。
3. **中间态对照面**：now +20d（树 29d）→ 父目录与转录都在，父目录 `young:child-transcript:30d`，child-transcripts 类对该转录报 `young:30d`（residue 7d 窗已过，只有转录窗拦着）。
4. **等价1（无混合内容行为不变）**：纯 residue 目录（树内无 sub-* 转录）在 residue 窗内照旧回收（reclaimed=1）；另外全量绿 `test/retention-sweep.test.ts`(23) / `test/retention-life-reclaim.test.ts`(5) / `test/retention-root-fix.test.ts`(11)。
5. **等价2（end-state 等价）**：同一 fixture 两跑 —— A `childTranscriptDays:7, now=+7d`、B `childTranscriptDays:30, now=+31d`：两次 `classes[].{class,scanned,reclaimed,bytes}` 逐字段相等、artifactRoot 最终路径集合相等、被回收路径集合相等且非空（`expect(earlyRemoved.length).toBeGreaterThan(0)` 防空洞相等）。
6. **保守面不回退**：ledger 目录缺失 → 树内转录无条件保目录，reason = `reference:descendant-transcript:<childId>`（不是 young），直接断言。

## 4. check 与测试结果

- 测试（包根、清泄漏 env、node 直调 vitest）：
  `test/retention-adc1-window.test.ts` + `retention-sweep.test.ts` + `retention-life-reclaim.test.ts` + `retention-root-fix.test.ts` → **4 files passed / 45 tests passed / EXIT=0**（改动后与 `npm run check` 后各跑一次，结果一致）。
- `npm run check` → **EXIT=0**（biome `--error-on-warnings` + tsgo --noEmit + check:installer + check:browser-smoke + check:ci-honesty 全过）。全量输出里 34 条 `info` 全部落在**我未触碰的** `packages/coding-agent/src/core/stall-diagnostics-render.ts`（`lint/complexity/useLiteralKeys`，标注为 unsafe fix）——是基线既存项，不是本次改动引入；本次 4 个源文件与测试文件无任何 error/warning/info 诊断（输出里不含 retention 相关路径）。
- `npm run check:test-hygiene` → **EXIT=0**（`no new private-member probes`；新测试不探私有成员、无 shadow type/spyOn 私有、数据驱动比较前有非空断言、无 skip）。
- 纯净树复核（仓规）：`git archive HEAD | tar -x -C /tmp/audit_r/round-42/c1-pristine` + symlink node_modules → `tsgo --noEmit` **EXIT=0**。
- 提交：`git add` 只加了自己改的 6 个文件，`git diff --cached --name-only` 核对恰好这 6 个；提交后 `git status --porcelain` 为空（无落东西）。

## 5. 偏差

- **偏差=none**。方案书 ⑥ PR-C1 的 5 项改动面（fs-walk / child-transcripts / artifact-dirs / docs / 红测）+ changelog 逐项落地，未自创修法，未触碰 types.ts 词表、ledger 与锁面（C2/C3 领地）。
- 方案留白处的一处实现选择（已在代码注释写清）：blocker 遇 `unverifiable`（子目录树不可读/转录 stat 失败）时的 reason 取 `unverifiable:child-transcript-tree`（词表内），detail 带转录路径——方案书只规定了"保守保住"和 young 分支的字面 reason。
- 有意行为变化（方案书 R1/R2 已列）：混合目录寿命 7d → 30d；30d 后 end-state 与今天 7d 后一致（等价2 机械证明）。
