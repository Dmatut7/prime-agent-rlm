# The "back-to-back cache hit 95%" reading: what it is, what it is not, and how to re-run it

**For**: B4-ops-16 (the CHANGELOG's cache claim omits its 口径), plus the evidence leg the parent
asked to land in-repo.
**Base**: `8ed6d73bc813891679dec7bd11f2160ff218abda`.

## 1. The claim under review

`CHANGELOG.md:31` (release-note prose for the fork's 0.10.0):

> **harness 菜单搬出系统提示**（#2098）：系统提示 62,181→50,816 字节；前缀不再每轮作废
> （背靠背第二轮缓存命中 95%，带"故意破前缀"正控）；新记忆/新技能**下一轮可见**；…

The number is real and the pin behind it is real. What is missing is the instrument's name: the 95%
comes from the fork's **faux prefix simulator**, not from a provider. `FORK_NOTES.md:22` says so
("口径申报：faux 是字符前缀模拟器，证的是「序列化请求前缀未变」…，**不是真 provider 命中率**"),
but the CHANGELOG reader does not see `FORK_NOTES.md:22`, and "缓存命中 95%" reads as a live
provider hit rate. A reader who takes it that way is wrong by construction.

## 2. The instrument - it is in the repo, and it is re-runnable

There is nothing to reconstruct. The reading is written by the pin that asserts it:

```
packages/coding-agent/test/suite/regressions/2098-static-prompt-harness-digest.test.ts
  describe  #2098 static system prompt with an in-context harness digest
  it        keeps the provider prefix cached across a refinement, and the reading can go red
```

- reading sink: `READINGS_PATH = process.env.P2098_CACHE_READINGS ?? "/tmp/p2098/cache-readings.json"`
  (`:80`), written from `afterAll` (`:144`) with `mkdirSync` + `writeFileSync`;
- base sha stamp: `P2098_BASE_SHA` (`:130`, defaults to the literal `"unspecified"`);
- the three readings are collected by `record(...)` (`:245-256`) at `:180` (round 1, cold),
  `:199` (round 2, after a landed refinement) and `:212` (round 3, the deliberate positive control);
- what the pin asserts, in its own words (`:187-196`): round 2 must re-read round 1's prefix
  (`cacheRead >= floor(round1.input * 0.9)`) and repay only this round's tail
  (`input < round1.input * 0.25`), and the positive control - clearing the active tools to break the
  prompt - must collapse the reading (`round3.cacheRead < round2.cacheRead * 0.5`). The 0.9 floor
  rather than 1.0 is documented in place: the faux serializer appends the tool schema after the
  messages, so round 1's tail is not literally a prefix of round 2's.

The provider behind it is `packages/ai/src/providers/faux.ts`: `withUsageEstimate` (`:201-236`)
keeps the **previous serialized prompt text per stream `sessionId`**, sets
`cacheRead = estimateTokens(previousPrompt.slice(0, commonPrefixLength(previousPrompt, promptText)))`
and `input = promptTokens - cacheRead`, with `estimateTokens = ceil(text.length / 4)` (`:129`).
That is the whole mechanism: **a character-prefix comparison on the serialized request, priced at
4 chars/token.** No provider, no cache blocks, no TTL, no minimum cacheable prefix, no tool-schema
rules.

### Re-run (verified in this clone, exit 0)

```bash
cd /tmp/fixD/packages/coding-agent
P2098_BASE_SHA=8ed6d73bc \
P2098_CACHE_READINGS=/tmp/fixD/logs/cache-readings.repro.json \
  npx vitest --run test/suite/regressions/2098-static-prompt-harness-digest.test.ts --reporter=default
```

Output (`logs/2098-instrument.log`):

```
 ✓ test/suite/regressions/2098-static-prompt-harness-digest.test.ts (19 tests) 3515ms
     ✓ keeps the provider prefix cached across a refinement, and the reading can go red 330ms
 Test Files  1 passed (1)
      Tests  19 passed (19)
   Duration  9.53s
```

Rename the sink to the default (`/tmp/p2098/cache-readings.json`) and you overwrite the shared
artifact instead of making your own copy. That is not hypothetical: the shared file carried
`"generatedAt": "2026-09-18T11:53:30.793Z"` when this pass started, `"2026-09-18T12:04:57.817Z"`
when I read it next, and `"2026-09-18T12:10:36.352Z"` when I went to copy it - three different
writers (the terminal-review seat and sibling lanes' suite runs all land on the same path), all
producing the identical three readings. Hence the committed copy above is my own run, and the
shared path is quoted only as "same values, whatever the timestamp".

## 3. The baseline reading, in-repo

Committed next to this file as `provider-prefix-cache.reading.json`: that is **my own re-run at
`8ed6d73bc`** (`"baseSha": "8ed6d73bc"`, `"generatedAt": "2026-09-18T12:08:28.675Z"`), not a copy of
the shared `/tmp` file - see §5 for why the shared file cannot be the committed copy. Inline below
with `generatedAt`/`baseSha` dropped and the readings one per line:

```json
{
  "baseSha": "unspecified",
  "provider": "faux (packages/ai/src/providers/faux.ts withUsageEstimate: prefix-cache simulation keyed by stream sessionId, tokens = ceil(chars/4))",
  "workload": "same session, same prompt text, one landed refinement between round 1 and round 2",
  "verdict": {
    "round2CacheReadCoversRound1Prefix": true,
    "round2InputCollapsed": true,
    "positiveControlCollapses": true
  },
  "readings": [
    { "label": "round1-cold",                          "input": 4168, "cacheRead":    0, "cacheWrite": 4168, "promptTokens": 4168, "systemPromptBytes": 12360, "messageCount": 3 },
    { "label": "round2-after-refine",                  "input":  322, "cacheRead": 3959, "cacheWrite":  322, "promptTokens": 4281, "systemPromptBytes": 12360, "messageCount": 6 },
    { "label": "round3-prefix-broken-positive-control", "input": 1016, "cacheRead":  866, "cacheWrite": 1016, "promptTokens": 1882, "systemPromptBytes":  3564, "messageCount": 8 }
  ]
}
```

`cacheRead 3959 / input 4168 = 94.98%` on round 2 - that is where the CHANGELOG's "95%" comes from,
and it is a **ratio inside the simulator**.

**Reproduced, not copied.** My own run at `8ed6d73bc` (12:08:28Z, `logs/cache-readings.repro.json`)
produced the three readings and all three verdicts **identically** - compared field by field with
`logs/compare-readings.py`:

```
verdict equality: True
readings equality: True
  round1-cold: identical
  round2-after-refine: identical
  round3-prefix-broken-positive-control: identical
```

Only `generatedAt` differs, and `baseSha` because I passed `P2098_BASE_SHA` where the shared file has
the `"unspecified"` default. The reading is deterministic across trees.

## 4. What the reading proves - and what it does not

**It proves** the thing #2098 actually changed: between two back-to-back rounds in one session, with
one refinement landed in between, **the serialized request prefix is unchanged**. Round 2's
`cacheRead` equals round 1's whole input, and round 2's repaid `input` collapses to 322 tokens (7.7%
of round 1). The round-3 control is the other half of the claim: when the prompt is deliberately
broken, the same instrument reads 866 - it can still see a broken prefix. Instrument, verdicts and
control are all in one run.

**It does not prove** a provider hit rate, a token saving, or a bill. Specifically it assumes away:
provider cache granularity (real caches work in blocks, not characters), minimum cacheable prefix
lengths, cache TTL and eviction, whether tools/system prompt are cached as part of the prefix at all
(the pin's own comment says the faux serializer puts the tool schema *after* the messages, unlike a
real provider), and per-provider `cache_control` placement. Each of those can take a 95% on this
instrument and still bill full price.

So the honest form of the claim is: **"the serialized request prefix survives a landed refinement"** -
a *mechanism* result, which is what #2098 needed to verify; the *saving* result is a different
measurement.

### Side note on the shared artifact (reported, not independently verified here)

The terminal-review seat (`/tmp/reviewB/parent-report-supplement4.md` item 48) reports that
`/tmp/p2098/cache-readings.json` was at one point rewritten to `"readings": []` with all three
verdicts `false` (observed 19:29, not by them), and back to the three-reading shape by 19:53. I did
**not** reproduce that empty state - by the time this lane looked, the file held the three readings
and three `true` verdicts - so I record it as **reported, unverified**. It is consistent with what I
did verify directly: the path is written by whoever runs the test file, in any tree, and any run
that dies early (or any lane copying a partial file) leaves whatever it left.

## 5. The 94.3% figure: a real-provider number whose artifact is not on disk

The parent's brief (and the terminal-review seat) point at a genuine provider-side reading:

> `docs/fork/merge-upstream-20260917.md:133` - **#2098 量化与三刀方案（08 号件，provider 侧实测）**：
> 31 天 / 137 个 root 会话 / 35,628 次请求，**精化落地导致的前缀缓存全量作废 = 290.4M token
> 重付（占全价输入 32.5%）**，有价模型实测 **$193.32/31 天**…**排序硬约束**：#2241 二期…若先上，
> 缓存命中率从**实测 94.3%** 掉到接近 0，同批会话 prompt 账单 $3,019→**$14,976（5.0x）**。

restated at `:340`.

**How checkable is it?** As far as this lane can tell: **出处不可核.**

```bash
cd /tmp/fixD && grep -rn "94\.3" --exclude-dir=node_modules --exclude-dir=.git .
# -> only docs/fork/merge-upstream-20260917.md:133 and :340
cd /tmp && grep -rl "35,628\|35628" --include="*.json" --include="*.md" --include="*.log" --include="*.txt" \
  /tmp/p2098 /tmp/reviewB /tmp/p2* /tmp/fixD/docs 2>/dev/null
# -> (no output)
```

- The figure appears in exactly two places, both the same fork document, both restating one measurement.
- No script, no raw provider export, no per-session cost table, and no cohort listing for
  "31 天 / 137 个 root 会话 / 35,628 次请求" is in the repo or in the `/tmp` evidence dirs I can reach.
- The doc is the fork's own document, not an external artifact: it cannot corroborate itself.

**What is checkable** is the cohort description's shape (31 days, 137 root sessions, 35,628 requests,
$193.32 of full-price input on a $888 base, 290.4M re-paid tokens = 32.5% of full-price input), and
nothing in it is arithmetically inconsistent. But "consistent prose" is not evidence. Until someone
re-derives it (or produces the export), any release note that quotes 94.3% should say where it came
from and that it is a historical, un-reproduced measurement - not present it beside a re-runnable
pin as if the two had the same standing.

## 6. Suggested CHANGELOG wording (for the parent to land - this lane does not edit CHANGELOG.md)

One 口径 sentence, replacing the parenthetical in `CHANGELOG.md:31`:

> 前缀不再每轮作废（**faux 前缀模拟器**读数：背靠背第二轮读回 round 1 全部输入、只补 322 token，
> 带"故意破前缀"正控；该口径证的是**序列化请求前缀未变**，**不是 provider 命中率**）。

Optionally add the stronger number with its provenance attached, in the same bullet:

> 真 provider 侧另有 31 天实测命中率 **94.3%**（出处：`docs/fork/merge-upstream-20260917.md`
> §133，**历史读数、无仓内工件可复核**）。

And, if the parent wants the coverage the terminal-review seat asked for, the sentence could instead
point at this file:

> 可复跑读数与仪器见 `docs/fork/evidence/provider-prefix-cache-reading.md`。

## 7. Business impact

The release note currently states a simulator ratio in provider vocabulary. #2098's whole business
case is cost ($193-440/month in the fork's own accounting), so the number a reader takes away from
the CHANGELOG is the number they will use to judge the month of work. Understating the *standing* of
the evidence is the one error that makes the cost claim unfalsifiable: if "95%" is presented as a
provider hit rate, a reader who later measures their own bill and sees no such saving cannot tell
whether the fix failed or the number was never that kind of number. The mechanism result is solid
and re-runnable; say that, and say the 94.3% is a historical reading with no artifact.
