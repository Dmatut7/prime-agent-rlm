# Compaction & Branch Summarization

LLMs have limited context windows. When conversations grow too long, Prime Agent uses compaction to summarize older content while preserving recent work. This page covers both auto-compaction and branch summarization.

**Source files:**
- [`compaction.ts`](../src/core/compaction/compaction.ts) - Auto-compaction logic
- [`branch-summarization.ts`](../src/core/compaction/branch-summarization.ts) - Branch summarization
- [`utils.ts`](../src/core/compaction/utils.ts) - Shared utilities (file tracking, serialization)
- [`fact-appendix.ts`](../src/core/compaction/fact-appendix.ts) - Machine-extracted fact ledger (`<fact-appendix>`)
- [`user-requests.ts`](../src/core/compaction/user-requests.ts) - Verbatim user-request ledger (`<user-requests>`)
- [`machine-blocks.ts`](../src/core/compaction/machine-blocks.ts) - Shared render/parse/strip for those blocks
- [`content-density.ts`](../src/core/compaction/content-density.ts) - CJK/code-aware token pricing for generated blocks
- [`session-manager.ts`](../src/core/session-manager.ts) - Entry types (`CompactionEntry`, `BranchSummaryEntry`)
- [`extensions/types.ts`](../src/core/extensions/types.ts) - Extension event types

For TypeScript definitions in your project, inspect `node_modules/@earendil-works/pi-coding-agent/dist/`.

## Overview

Prime Agent has two summarization mechanisms:

| Mechanism | Trigger | Purpose |
|-----------|---------|---------|
| Compaction | Context exceeds threshold, or `/compact` | Summarize old messages to free up context |
| Branch summarization | `/tree` navigation | Preserve context when switching branches |

Both use the same structured summary format and track file operations cumulatively.

## Compaction

### When It Triggers

Auto-compaction triggers when:

```
contextTokens > min(triggerBase * triggerRatio, triggerBase - reserveTokens)
```

The lower of the two ceilings wins:

- `triggerBase` — the catalog `contextWindow` clamped to the provider's measured input limit ([`model-input-limits.ts`](../src/core/model-input-limits.ts)).
- `triggerRatio` — the share of `triggerBase` at which the trigger fires: `compaction.triggerRatio`, default `0.8`, clamped to `[0.5, 0.95]`.
- `triggerBase - reserveTokens` — the retained slice plus the response reserve has to fit, or compaction re-fires every turn. `reserveTokens` is 16384 by default (configurable in `~/.prime/agent/settings.json` or `<project-dir>/.prime/agent/settings.json`).

The old formula was `contextTokens > contextWindow - reserveTokens` - about 98.4% of a 1M window. Two independent measurement errors sat under it, and both push the same way:

- The estimate prices text at chars/4, which under-counts CJK by about 1.6x: a Chinese-heavy session measured ~1.6x low, because CJK costs about one token per 1.5 characters, not one per four.
- The catalog `contextWindow` can exceed the input the provider actually accepts: `kimi-k3` declares 1048576 while DashScope accepts 1000000, and `qwen3.8-max-0902` declares 1000000 while DashScope accepts 983616. Both limits are measured and recorded in [`model-input-limits.ts`](../src/core/model-input-limits.ts), because such a provider answers an oversized prompt with HTTP 400 instead of truncating it.

Both errors point the same direction - the estimated context looks smaller than it is, and the wall it was compared against sat further away than the provider's real one - so the old threshold let a session reach the provider's 400 on an ordinary request before the trigger ever fired. Compaction then woke up after the rejection, sometimes too late to run at all, because the summarization request itself was over the provider's input limit. 80% of the measured limit leaves room for both errors on the same context.

Two token calibers exist on purpose ([`compaction.ts`](../src/core/compaction/compaction.ts), [`content-density.ts`](../src/core/compaction/content-density.ts)):

- `estimateTokens` prices every character at chars/4. It is the budgeting caliber: cut points, `keepRecentTokens` and the summarization inflation anchor are all expressed in it. It is flat and cheap, and it under-counts dense (CJK, code) text.
- `estimateTokensByContent` prices by content density - CJK at 1.5 chars/token, fenced code at 3 chars/token, ASCII at 4 chars/token. It is the trigger caliber and what `/usage` reports, because both numbers are compared against a limit the provider measured. A chars/4 trigger on a CJK-heavy session fires after the provider has already rejected the request.

The trigger's `contextTokens` is anchored on the newest readable assistant usage - the provider's own count, which needs no correction - with the messages after it priced by content density.

When the configured `reserveTokens` consumes the whole `triggerBase`, no sustainable threshold exists: any retained context, including a fresh summary, would sit above it again immediately and retrigger every turn. Threshold compaction then stands down; overflow recovery remains the backstop.

You can also trigger manually with `/compact [instructions]`, where optional instructions focus the summary — for example `/compact focus on the auth refactor, remember the exact migration command`. The instructions are passed to the summarization prompt with high priority, persisted on the `CompactionEntry`, and shown on the `[compaction]` message in the TUI.

### How It Works

1. **Find cut point**: Walk backwards from newest message, accumulating token estimates until `keepRecentTokens` (default 20k, configurable in `~/.prime/agent/settings.json` or `<project-dir>/.prime/agent/settings.json`) is reached
2. **Extract messages**: Collect messages from the previous kept boundary (or session start) up to the cut point
3. **Generate summary**: Call LLM to summarize with structured format, passing the previous summary as iterative context when present
4. **Append entry**: Save `CompactionEntry` with summary and `firstKeptEntryId`
5. **Reload**: Session reloads, using summary + messages from `firstKeptEntryId` onwards

```
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

On repeated compactions, the summarized span starts at the previous compaction's kept boundary (`firstKeptEntryId`), not at the compaction entry itself, falling back to the entry after the previous compaction if that kept entry cannot be found in the path. This preserves messages that survived the earlier compaction by including them in the next summarization pass as well. Prime Agent also recalculates `tokensBefore` from the rebuilt session context before writing the new `CompactionEntry`, so the token count reflects the actual pre-compaction context being replaced.

### Split Turns

A "turn" starts with a user message and includes all assistant responses and tool calls until the next user message. Normally, compaction cuts at turn boundaries.

When a single turn exceeds `keepRecentTokens`, the cut point lands mid-turn at an assistant message. This is a "split turn":

```
Split turn (one huge turn exceeds budget):

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         turnStartIndex = 1                  firstKeptEntryId = 7
                │                                     │
                └──── turnPrefixMessages (1-6) ───────┘
                                                      └── kept (7-8)

  isSplitTurn = true
  messagesToSummarize = []  (no complete turns before)
  turnPrefixMessages = [usr, ass, tool, ass, tool, tool]
```

For split turns, Prime Agent generates two summaries and merges them:
1. **History summary**: Previous context (if any)
2. **Turn prefix summary**: The early part of the split turn

### Cut Point Rules

Valid cut points are:
- User messages
- Assistant messages
- BashExecution messages
- Custom messages (custom_message, branch_summary)

Never cut at tool results (they must stay with their tool call).

### Turn Alignment

A cut in the middle of a turn keeps recent bytes but summarizes the message that opened the turn, so the retained work loses its own request. `alignCutToTurnStart()` therefore moves such a cut back to the start of its turn whenever that is affordable:

```
extra = estimated tokens of [turnStart, cutPoint)
align only if  extra <= keepRecentTokens * TURN_ALIGNMENT_EXTRA_SHARE   (share = 1)
           and turnStart > startIndex
```

Refusing when the turn start is the range start keeps a compaction from summarizing nothing, and the slack bound keeps a single oversized turn on the split-turn path above instead of retaining a turn larger than the whole keep budget. Alignment is what makes `isSplitTurn` rare rather than the norm: on the three sessions measured for the fidelity audit all three cuts landed mid-turn, and with alignment two of the three retain their turn whole and need one summarizer call instead of two.

A cut that lands on a `bashExecution`, `custom_message` or `branch_summary` entry is also a turn start, so it is reported as `isSplitTurn: false` — the retained region begins at a user-initiated boundary and there is no prefix to summarize.

### CompactionEntry Structure

Defined in [`session-manager.ts`](../src/core/session-manager.ts):

```typescript
interface CompactionEntry<T = unknown> {
  type: "compaction";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
  customInstructions?: string;  // user instructions from /compact <instructions>
}

// Default compaction uses this for details (from compaction.ts):
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
  facts?: FactLedger;            // behind <fact-appendix>
  userRequests?: UserRequestLedger;  // behind <user-requests>
}
```

Extensions can store any JSON-serializable data in `details`. The default compaction tracks file operations plus the two ledgers described in [Fidelity](#fidelity-what-survives-without-the-model), and custom extension implementations can use their own structure. `details` is the structured carry-forward for the next compaction; the rendered blocks in `summary` are the fallback for entries that have no details.

See [`prepareCompaction()` and `compact()`](../src/core/compaction/compaction.ts) for the implementation.

## Branch Summarization

### When It Triggers

When you use `/tree` to navigate to a different branch, Prime Agent offers to summarize the work you're leaving. This injects context from the left branch into the new branch.

### How It Works

1. **Find common ancestor**: Deepest node shared by old and new positions
2. **Collect entries**: Walk from old leaf back to common ancestor
3. **Prepare with budget**: Include messages up to token budget (newest first)
4. **Generate summary**: Call LLM with structured format
5. **Append entry**: Save `BranchSummaryEntry` at navigation point

```
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D ─ [summary of B,C,D]
    A ───┤
         └─ E ─ F (new leaf)
```

### Cumulative File Tracking

Both compaction and branch summarization track files cumulatively. When generating a summary, Prime Agent extracts file operations from:
- Tool calls in the messages being summarized
- Previous compaction or branch summary `details` (if any)

This means file tracking accumulates across multiple compactions or nested branch summaries, preserving the full history of read and modified files.

### BranchSummaryEntry Structure

Defined in [`session-manager.ts`](../src/core/session-manager.ts):

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  fromId: string;      // Entry we navigated from
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default branch summarization uses this for details (from branch-summarization.ts):
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Same as compaction, extensions can store custom data in `details`.

See [`collectEntriesForBranchSummary()`, `prepareBranchEntries()`, and `generateBranchSummary()`](../src/core/compaction/branch-summarization.ts) for the implementation.

## Fidelity: What Survives Without The Model

A narrative summary is lossy by design, and the losses are not evenly spread. Measured over three real sessions (a 490k-token first compaction, a 46-generation update chain, and a 12-generation merge review): the narrative kept 73.5% of the items that carried the work, but hard facts survived verbatim only 3-20% of the time (SHAs 4%, numbers 3.3%, paths 2.7%), one-off user instructions were the single largest loss (9 of the 9 dropped curated items), and update mode compounded it — numbers lived 1.1 generations on average, one pass dropped 18 SHAs including the session's rollback anchors, and another restated a SHA with one extra digit, which breaks every git command that uses it. Telling the summarizer to "PRESERVE exact file paths, function names, and error messages" did not change that.

So the values that must be exact no longer go through the model. Compaction appends deterministic blocks after the narrative, and [`stripMachineBlocks()`](../src/core/compaction/machine-blocks.ts) removes them from the previous summary before it is sent back to the summarizer: a block the model never sees is a block it can neither drop nor "correct".

| Block | Source | Contents |
|-------|--------|----------|
| `<read-files>`, `<modified-files>` | tool calls + previous `details` | cumulative file lists |
| `<fact-appendix>` | regex over the summarized slice | error signatures, commit SHAs, paths, threshold numbers, issue refs |
| `<user-requests>` | user messages and `!commands` | the user's own words, verbatim |

### Fact appendix

[`fact-appendix.ts`](../src/core/compaction/fact-appendix.ts) extracts five kinds of fact from every message leaving the context:

- **sha** — 40-hex anywhere; 7-10 hex only on a line with git context, or in prose somebody wrote (a user or assistant message), where a hex-shaped word like `feedback` is the only real false positive. An abbreviated SHA is folded into the full one it prefixes so one anchor keeps one slot and one weight.
- **path** — absolute, `~/`, and repo-relative paths. Relative paths need an extension or three segments, so branch names are not paths; URLs, `node_modules`, `.git` and `.venv` are excluded. Extracted by a linear scan rather than a `segment(?:/segment)+` regex, which backtracks quadratically on a long run without a slash and hung a compaction for minutes on an 800k-character tool result.
- **number** — `identifier: 123` (including quoted JSON keys, which is how settings reach a transcript), keyword pairs written as prose (`exit code 2`, `line 22`), and unit numbers (`900s`, `523MB`, `1.41x`). Each carries a verbatim snippet of the line it came from, because a bare number is not a fact.
- **error** — lines that report a failure rather than mention one. Source lines, diff hunks and serialized tool calls are filtered out; re-runs of one failure collapse by signature with digits normalized, so `bad JSON at position 1871` and `... 2044` are one recurring error.
- **issue** — `#4603` and `issues/4603` / `pull/4603` spellings.

Each record carries `n` (the weight of the distinct messages that mentioned it — one message counts once, so a value printed 500 times in one log does not outvote a value the user typed once; user and assistant prose weigh 3, tool calls and custom messages 2, tool output and thinking 1) and `g` (the first and last compaction generation that carried it). Records are JSON lines, so a value containing a quote, a newline or CJK round-trips byte-exactly.

Facts never expire by age. The ledger is folded forward structurally, and eviction happens only when the block has to fit its budget: per-kind caps, then a minimum representation per kind (so a transcript full of paths cannot wipe out its SHAs), then a global ranking by weight with a boost for the current generation. Whatever is dropped is counted in the block's `elided` attribute, so a bounded appendix is never a silent one.

The budget is derived, not configured: `factAppendixTokenBudget(keepRecentTokens, summarizedTokens)` takes 3% of what the appendix stands in for and 25% of what the compaction retains, whichever is larger, clamped to `[400, min(20000, keepRecentTokens)]`. A slice can never exceed the model's window, so the share is window-proportionate on its own — a 490k-token slice gets ~14.7k tokens of appendix, a 90k slice gets the 5k floor.

### Verbatim user requests

[`user-requests.ts`](../src/core/compaction/user-requests.ts) keeps what the user actually said: `user` message text and `!command` bash executions, oldest first, JSON-encoded so multi-line and CJK text is byte-exact. A re-sent message collapses into a repeat count instead of a second record. The budget is `userRequestsTokenBudget(keepRecentTokens)` — 30% of the retained window, clamped to `[400, 16000]` — which held all 93 user messages of the measured 490k-token session inside 8k characters.

When the budget binds, three stages run in order: re-clip the oldest requests to `USER_REQUEST_COMPRESSED_CHARS` (160), then drop the requests that were clipped (longest original first — a pasted log is the least likely thing to still be a live obligation), and only then drop requests outright, oldest first. A one-line instruction is never clipped, so it outlives every paste in the ledger. Drops are counted in the `elided` attribute.

### Sizing generated blocks

Both budgets are spent in [`content-density.ts`](../src/core/compaction/content-density.ts) tokens, not characters: CJK is priced at 1.5 characters per token, fenced code at 3, other text at the usual 4. A block sized in raw characters under-reads a Chinese instruction by ~2.7x, which is how a "6000-token" block becomes a 16k-token one. This is separate from the `inflation` anchor in [Summarization Request Budget](#summarization-request-budget): that one converts a provider's own count into the estimator's caliber for a request about to be sent, this one prices text that has no provider count yet.

### Guarantees

Replaying the three measured sessions through this code, with no model in the loop:

- Facts mentioned by 6 or more weighted messages: retained 100% (session B and C: 100% of everything mentioned 3+ times; session A retains 100% at weight ≥6 and 80% at weight ≥3, because one 490k-token slice holds 2251 unique facts and the appendix is bounded).
- User requests: 0 dropped, all verbatim (one long paste clipped with the elision disclosed).
- Across five further generations of compaction that add nothing: 0 facts and 0 requests lost, whether the ledger is carried through `details` or recovered from the rendered block.
- Extraction cost on a 1M-character slice: tens of milliseconds, and linear in the input.

## Summary Format

Both compaction and branch summarization use the same structured format:

```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>

<fact-appendix generation="3" facts="41" elided="12" elidedDetail="path:9,number:3">
Machine-extracted from the transcript by regex, no model involved: ...
{"k":"error","v":"Error: Failed to resolve API key for provider \"bailian\"","n":3,"g":"1-3"}
{"k":"sha","v":"4871d9223bac88ac6da9796f4b0c4d33b7566178","n":6,"g":"2-3"}
{"k":"path","v":"/tmp/ma_audit/rollback-anchor.md","n":3,"g":"1-3"}
{"k":"number","v":"reserveTokens=16384","n":2,"g":"3-3","c":"settings compaction reserveTokens: 16384"}
</fact-appendix>

<user-requests generation="3" count="5">
The user's own words from the compacted transcript, ...
{"g":1,"s":0,"k":"user","r":1,"t":"不要 push，先跑测试"}
{"g":2,"s":1,"k":"bash","r":2,"t":"git log --oneline -3"}
</user-requests>
```

Record lines are JSON, and `<` is written as `\u003c` inside them: a payload that quotes a
block delimiter (`</user-requests>`, say) therefore cannot end its block early, while `JSON.parse`
restores the character exactly and a block written before this rule still parses. The file-list
blocks carry paths verbatim instead — they have no JSON layer to hide behind, and inventing one
would make a path containing the literal `\u003c` ambiguous — so an entry that reads as a delimiter
is left out of the rendered list and reported. `details.readFiles` / `details.modifiedFiles` still
carry it: the rendered list is the fallback, not the ledger.

The blocks are anchored at the end of the document, because the renderer is the only code that
writes the tail. A block is read back only there: its closing tag has to be the document's last
line, its opening tag a whole line of strict shape (`<user-requests-evil>` and
`<user-requests /evil>` are not openers) that starts a paragraph wherever a candidate does, and
the last matching opener wins. So a tool `path` argument or a narrative that merely names a tag can
write a look-alike ahead of the real block without becoming the block that is read.

Everything from `<read-files>` down is machine-generated (see [Fidelity](#fidelity-what-survives-without-the-model)). The narrative above it is the model's; the blocks are rebuilt from the transcript on every compaction and are stripped out of the previous summary before it is sent back to the model. Branch summaries carry the file blocks only.

### Message Serialization

Before summarization, messages are serialized to text via [`serializeConversation()`](../src/core/compaction/utils.ts):

```
[User]: What they said
[Assistant thinking]: Internal reasoning
[Assistant]: Response text
[Assistant tool calls]: ipython(code="open('foo.ts').read()"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

This prevents the model from treating it as a conversation to continue.

Tool results are truncated in the middle during serialization: the first `TOOL_RESULT_HEAD_CHARS` (2000) and the last `TOOL_RESULT_TAIL_CHARS` (500) characters are kept, and the dropped span is replaced with a marker saying how many characters went. The tail matters because that is where a tool run's verdict lives — a test runner prints its failure list last, a build prints the stopping error last, a stack trace puts the innermost frame last. Head-only truncation discarded all of it: on one measured session 183 facts existed only past the 2000-character cut, across 62 results whose dropped tails totalled 80k characters. Truncation still keeps summarization requests within budget, since tool results, especially from `ipython` and optional `bash`, are typically the largest contributors to context size.

### Summarization Request Budget

The summarization call is itself one request, and a provider that rejects it rejects the whole compaction: the context stays above the threshold and every later attempt fails the same way. The budget in [`summarization-budget.ts`](../src/core/compaction/summarization-budget.ts) therefore pays for every part of the request, not just the conversation:

```
inputLimit          = min(model.contextWindow, measured provider input limit)
safetyMargin        = ceil(inputLimit * 0.02)
conversationReal    = inputLimit - reserveTokens - systemPromptTokens - wrapperTokens - safetyMargin
conversationEstimate = floor(conversationReal / inflation)
```

- **`inputLimit`** — a provider can accept less input than the catalog declares for the window. Bailian's DashScope compatible-mode answers an oversized prompt with `Range of input length should be [1, 983616]` for a model whose `models.json` entry says `contextWindow: 1000000`. Measured limits live in [`model-input-limits.ts`](../src/core/model-input-limits.ts) and clamp the declaration; only limits with recorded evidence are listed. A cap the provider announced in a rejection clamps it further (see below).
- **`wrapperTokens`** — the elision note, the `<conversation>` and `<previous-summary>` delimiters, the instruction template, any `/compact` instructions, and the kernel-persistence note. The previous summary and the instructions are user-sized, so they are measured rather than assumed small.
- **`safetyMargin`** — 2% of the input limit for overhead no character count can see (chat template, per-message framing, tokenizer drift).
- **`inflation`** — `estimateTokens` is a chars/4 heuristic and reads CJK- and code-heavy transcripts low by a wide margin (the session that produced the production 400 measured 614k estimated tokens against 982k provider-reported prompt tokens). The newest assistant usage inside the slice is the provider's own count of nearly the same content, so it anchors the conversion; it is floored at 1 and capped at 4.

Two further guards, because an estimate can still be wrong:

- The serialized conversation is clamped to the budget by dropping its oldest characters, with a marker saying how many. The message-level trimmer always keeps the newest message, so one oversized paste used to be sent verbatim.
- If the provider still rejects the request for input length, the call is retried up to `SUMMARIZATION_INPUT_RETRY_LIMIT` times with `inflation` raised by `SUMMARIZATION_INPUT_RETRY_SHRINK` each time. Every attempt is a separate wire call with its own request identity, so a shrunk body never reuses an idempotency key. Aborts and unrelated errors are never retried.
- A rejection usually states the cap it applied (`Range of input length should be [1, 983616]`, `prompt is too long: N tokens > M maximum`, and the other formats `announcedInputLimit()` knows). That number is fed back into the retry as the input limit, so a model missing from the measured table still gets an exact budget on its second attempt. Announced values below 1024 tokens are ignored as mis-parses.

### When Compaction Keeps Failing

Failures are counted across auto and manual attempts. From `COMPACTION_RECOVERY_HINT_THRESHOLD` (3) consecutive failures on, the failure notice carries the ways out instead of only the provider error: `/compact <instructions>`, `/tree` or `/fork` to continue from a smaller context, `/model` for a larger window, `/new` for a fresh session, and the `compaction.reserveTokens` setting that widens the summarization budget. A compaction that produces a summary clears the streak; aborts and "nothing to compact" skips do not count.

Two further valves sit between the streak and giving up:

- From the second consecutive failure on, each retry halves `keepRecentTokens` (floor 4096 tokens, never above the configured value - a session configured below the floor keeps its own number). A summarization that keeps failing is usually failing because the slice it has to carry does not fit the provider's input limit, and a smaller retained tail is the one knob that shrinks the request without user input.
- From the fourth consecutive failure on (`COMPACTION_EMERGENCY_SHRINK_FAILURES`), the lossy emergency shrink runs: the oldest non-summary context entries are dropped - without being summarized - until the estimate lands under `thresholdTokens * 0.7` (`EMERGENCY_SHRINK_TARGET_RATIO`), far enough under the trigger that the next message does not re-fire it.

The shrink is deliberately conservative with what it destroys:

- Summaries inside the dropped span - a previous compaction summary, branch summaries - are carried verbatim into the replacement summary, not lost.
- The cut is always a legal cut point: a tool result is never separated from the tool call it answers, because a provider rejects that pair outright and the shrink would turn into a new failure.
- Nothing is deleted from the session transcript on disk. `/export`, `/tree` and `/fork` still reach every dropped message, and the notices say so. When even the deepest cut cannot reach the target - the newest turn alone is larger than it - the notices say that too and name `/model` or `/new` as the remaining way out.
- The loss is never silent. It is named in three places: the replacement summary the model reads next turn (headlined `EMERGENCY CONTEXT SHRINK`), a compaction-outcome notice in the transcript that the user reads, and a warn-level session log line.

The failure streak survives the shrink: a further failure shrinks again instead of earning three fresh retries. A successful compaction still clears it.

## Custom Summarization via Extensions

Extensions can intercept and customize both compaction and branch summarization. See [`extensions/types.ts`](../src/core/extensions/types.ts) for event type definitions.

### session_before_compact

Fired before auto-compaction or `/compact`. Can cancel or provide custom summary. See `SessionBeforeCompactEvent` and `CompactionPreparation` in the types file.

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, signal } = event;

  // preparation.messagesToSummarize - messages to summarize
  // preparation.turnPrefixMessages - split turn prefix (if isSplitTurn)
  // preparation.previousSummary - previous compaction summary
  // preparation.fileOps - extracted file operations
  // preparation.tokensBefore - context tokens before compaction
  // preparation.firstKeptEntryId - where kept messages start
  // preparation.settings - compaction settings

  // branchEntries - all entries on current branch (for custom state)
  // signal - AbortSignal (pass to LLM calls)

  // Cancel:
  return { cancel: true };

  // Custom summary:
  return {
    compaction: {
      summary: "Your summary...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: { /* custom data */ },
    }
  };
});
```

#### Converting Messages to Text

To generate a summary with your own model, convert messages to text using `serializeConversation`:

```typescript
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

pi.on("session_before_compact", async (event, ctx) => {
  const { preparation } = event;
  
  // Convert AgentMessage[] to Message[], then serialize to text
  const conversationText = serializeConversation(
    convertToLlm(preparation.messagesToSummarize)
  );
  // Returns:
  // [User]: message text
  // [Assistant thinking]: thinking content
  // [Assistant]: response text
  // [Assistant tool calls]: ipython(code="open('...').read()"); bash(command="...")
  // [Tool result]: output text

  // Now send to your model for summarization
  const summary = await myModel.summarize(conversationText);
  
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    }
  };
});
```

See [custom-compaction.ts](../examples/extensions/custom-compaction.ts) for a complete example using a different model.

### session_before_tree

Fired before `/tree` navigation. Always fires regardless of whether user chose to summarize. Can cancel navigation or provide custom summary.

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - where we're navigating to
  // preparation.oldLeafId - current position (being abandoned)
  // preparation.commonAncestorId - shared ancestor
  // preparation.entriesToSummarize - entries that would be summarized
  // preparation.userWantsSummary - whether user chose to summarize

  // Cancel navigation entirely:
  return { cancel: true };

  // Provide custom summary (only used if userWantsSummary is true):
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "Your summary...",
        details: { /* custom data */ },
      }
    };
  }
});
```

See `SessionBeforeTreeEvent` and `TreePreparation` in the types file.

## Settings

Configure compaction in `~/.prime/agent/settings.json` or `<project-dir>/.prime/agent/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "triggerRatio": 0.8,
    "priorityOverAgentMessages": true
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable auto-compaction |
| `reserveTokens` | `16384` | Tokens to reserve for the LLM response; also subtracted from the summarization request budget, so lowering it widens that request at the cost of summary length |
| `keepRecentTokens` | `20000` | Recent tokens to keep (not summarized) |
| `triggerRatio` | `0.8` | Share of the provider's real input limit at which threshold compaction fires; clamped to `0.5`-`0.95`, and the threshold never exceeds `base - reserveTokens` |
| `priorityOverAgentMessages` | `true` | Queue incoming agent messages behind a pending or in-flight compaction instead of letting them open a turn on an over-threshold context; `false` restores the old ordering (message first, compaction at the turn boundary). See [settings.md](settings.md) for the full admission matrix |

Threshold compaction can also be disabled by configuration: when `reserveTokens` consumes the whole input limit, no sustainable threshold exists and the trigger stands down (overflow recovery remains). See [When It Triggers](#when-it-triggers) for the formula and why it is a ratio of the measured limit.

Disable auto-compaction with `"enabled": false`. You can still compact manually with `/compact`.
