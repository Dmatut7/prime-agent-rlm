---
name: bailian-web-search
description: Search the web via the Alibaba Bailian (DashScope) public endpoint with enable_search. Use for real-time facts, news, prices, and research material in Chinese or English. Requires a Bailian API key in ~/.prime/agent/models.json (bailian provider) or the DASHSCOPE_API_KEY env var.
---

# Bailian Web Search

Searches the web by asking a Bailian chat model with `enable_search` to
retrieve pages and synthesize an answer. The kernel already has the module
bound as `bailian_web_search`. In the kernel, call it like this:

    answer = await bailian_web_search.asearch("your query")

A search usually takes 10-30s and up to 240s (the search model's reasoning is off by default;
turning it on with `thinking=True` made the same news query take 91s instead of 21s).
`asearch` runs it in a worker thread, so the kernel's other work (subagents, browser sessions,
heartbeats) keeps running meanwhile and Esc stops the wait at once. `bailian_web_search.search(...)`
is the same call as a plain synchronous function for scripts and threads; on the kernel's own
thread it freezes all of that for the whole search, and says so on stderr afterwards. Its
answer is also awaitable, so `await bailian_web_search.search(...)` returns the text too (after
blocking), and `await asyncio.to_thread(bailian_web_search.search, "q")` equals `asearch`.

Both take the same arguments and return the answer text as a `str`. An empty answer comes back
as a sentence starting `(bailian_web_search found no answer ...` with the finish reason, rather
than `""`, because an empty string reads like "the web has nothing on this", which is rarely true.

It is also the fallback when `web_research.search` raises `SearchUnavailable` (Docker or the local
SearXNG down, or the VPN off): Bailian answers from mainland China without a VPN.

Key resolution (never stored in this repo): `DASHSCOPE_API_KEY` env var wins,
then `bailian.apiKey` in `~/.prime/agent/models.json`, then `bailian` in
`~/.prime/agent/auth.json`. Config values take the same forms prime-agent itself
accepts, so a key that works for the chat model works here: a literal key, the
name of an environment variable, or `!command` whose output is the key (for
example `!cat ~/.prime/agent/bailian.key`). Raises a clear error naming what was
tried if none resolves.

Behavior notes, all measured on 2026-09-23:

- Requests always go to the **public** compatible endpoint
  `https://dashscope.aliyuncs.com/compatible-mode/v1`, never to a
  provider-specific base URL: dedicated-instance endpoints
  (`llm-*.maas.aliyuncs.com`) silently ignore `enable_search` (qwen returned
  fabricated content after 100s, deepseek returned empty after 13s).
- Default `search_strategy="max"`: of the eight tiers
  (standard/lite/turbo/pro/pro_max/pro_ultra/max/image), max and the pro
  family return structured, citation-numbered answers whose numbers cross-
  check across tiers, at the same latency as the default tier (15-32s).
  Override with `strategy="lite"` etc. when speed matters more than depth.
- Latency is 15-90s per call because pages are really fetched. Do not call
  from latency-sensitive turns; schedule it and read the result later.

Quality red line (measured, keep): treat the answer as direction and
framework only. Citations and specific cases must be verified against a
primary source before being written into docs; the API returns citation
numbers but no source URLs on the compatible endpoint, and it has been
observed attributing sources to the wrong vendor.
