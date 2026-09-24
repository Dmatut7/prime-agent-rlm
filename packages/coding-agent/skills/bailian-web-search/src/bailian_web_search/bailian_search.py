"""Bailian web search skill implementation.

Searches the web via a Bailian chat model with enable_search, always against
the public compatible endpoint. Key resolution: DASHSCOPE_API_KEY env var,
then ~/.prime/agent/models.json (bailian provider), then auth.json.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

PUBLIC_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"

# 2026-09-23: dedicated-instance endpoints (llm-*.maas.aliyuncs.com) silently
# ignore enable_search; the public endpoint executes it correctly.
_TIERS = (
    "standard",
    "lite",
    "turbo",
    "pro",
    "pro_max",
    "pro_ultra",
    "max",
    "image",
)


def _agent_dir() -> Path:
    raw = (
        os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
        or os.environ.get("PI_CODING_AGENT_DIR")
        or str(Path.home() / ".prime" / "agent")
    )
    return Path(raw).expanduser()


def _resolve_api_key() -> str:
    env_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if env_key:
        return env_key
    try:
        cfg = json.loads((_agent_dir() / "models.json").read_text())
        key = cfg["providers"]["bailian"]["apiKey"]
        if isinstance(key, str) and key.strip():
            return key.strip()
    except (OSError, ValueError, KeyError, TypeError):
        pass
    try:
        auth = json.loads((_agent_dir() / "auth.json").read_text())
        cred = auth.get("bailian") if isinstance(auth, dict) else None
        if isinstance(cred, dict) and isinstance(cred.get("key"), str):
            return cred["key"].strip()
    except (OSError, ValueError):
        pass
    return ""


class SearchAnswer(str):
    """The answer text, usable as a plain str and also awaitable.

    Every other kernel skill is called with `await`, so models await this one
    too. The search has already finished when the value comes back, so awaiting
    it just hands back the text instead of raising and losing a 15-90s result.
    """

    def __await__(self):
        return str(self)
        yield  # pragma: no cover - makes this a generator; never reached


def search(
    query: str,
    model: str = "qwen3.8-flash",
    strategy: str = "max",
    max_tokens: int = 1500,
    timeout: int = 240,
    thinking: bool = False,
) -> str:
    """Search the web and return the synthesized answer text.

    Args:
        query: the question; keep it specific so search hits are focused.
        model: any Bailian chat model id (default qwen3.8-flash, cheap+fast).
        strategy: search tier, one of standard/lite/turbo/pro/pro_max/
            pro_ultra/max/image (default "max"; pro family and max return
            structured, citation-numbered answers at the same latency).
        max_tokens: answer length cap.
        timeout: per-call timeout in seconds; a search usually answers in
            10-30s, the default leaves room for slow broad queries.
        thinking: let the search model reason before answering (default off).
            Measured 2026-09-24 on a news query: with thinking on, qwen3.8-flash
            spent ~4.7k reasoning tokens and 91s for the same answer it gives in
            21s without, so it only costs time and money here.

    Returns the answer text. Raises RuntimeError when no API key is found and
    urllib.error.HTTPError on API errors (400 with the valid tier list means a
    bad strategy value).
    """
    if strategy and strategy not in _TIERS:
        raise ValueError(
            f"invalid strategy {strategy!r}; one of {_TIERS}"
        )
    key = _resolve_api_key()
    if not key:
        raise RuntimeError(
            "no Bailian API key found: set DASHSCOPE_API_KEY or configure "
            "providers.bailian.apiKey in ~/.prime/agent/models.json"
        )
    payload = {
        "model": model,
        "messages": [
            {"role": "user", "content": "请联网检索并回答:" + query}
        ],
        "enable_search": True,
        "search_options": {
            "forced_search": True,
            "enable_source": True,
            "enable_citation": True,
            "search_strategy": strategy,
        },
        "stream": False,
        "max_tokens": max_tokens,
        "enable_thinking": thinking,
    }
    req = urllib.request.Request(
        PUBLIC_BASE + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:300]
        raise RuntimeError(f"bailian search HTTP {e.code}: {body}") from e
    content = (data.get("choices") or [{}])[0].get("message", {}).get("content")
    return SearchAnswer(content or "")
