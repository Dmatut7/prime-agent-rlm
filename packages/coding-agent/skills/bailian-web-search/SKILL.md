---
name: bailian-web-search
description: Search the web via the Alibaba Bailian (DashScope) public endpoint with enable_search. Use for real-time facts, news, prices, and research material in Chinese or English. Requires a Bailian API key in ~/.prime/agent/models.json (bailian provider) or the DASHSCOPE_API_KEY env var.
---

# Bailian Web Search

Searches the web by asking a Bailian chat model with `enable_search` to
retrieve pages and synthesize an answer. The kernel already has the module
bound as `bailian_web_search`; `search` is a plain synchronous function that
returns the answer text as a `str`:

    answer = bailian_web_search.search("your query")

The returned value is also awaitable, so `answer = await bailian_web_search.search("your query")`
works the same way. A search usually takes 10-30s (the search model's reasoning is off by default;
turning it on with `thinking=True` made the same news query take 91s instead of
21s) and blocks the kernel while it runs;
to keep the turn responsive, run it in a worker thread:

    answer = await asyncio.to_thread(bailian_web_search.search, "your query")

Key resolution (never stored in this repo): `DASHSCOPE_API_KEY` env var wins,
then `bailian.apiKey` in `~/.prime/agent/models.json`, then `bailian` in
`~/.prime/agent/auth.json`. Raises a clear error if none is found.

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
