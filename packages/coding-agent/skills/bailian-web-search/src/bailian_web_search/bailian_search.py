"""Bailian web search skill implementation.

Searches the web via a Bailian chat model with enable_search, always against
the public compatible endpoint. Key resolution: DASHSCOPE_API_KEY env var,
then ~/.prime/agent/models.json (bailian provider), then auth.json. Config
values take the same forms the host accepts (resolve-config-value.ts): a
literal key, the name of an environment variable, or `!command` whose stdout
is the key.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

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


_COMMAND_TIMEOUT = 10
_command_cache: dict[str, str] = {}


def _resolve_config_value(raw: str) -> tuple[str, str]:
    """(value, problem) for a config value, resolved like the host's resolveConfigValue.

    `!command` runs through /bin/sh and its trimmed stdout is the value (cached once it
    succeeds, as the host does); a name that is set in the environment resolves to that
    variable (set-but-empty is a missing key, never the name); anything else is the literal.
    """
    if raw.startswith("!"):
        # Only the program is named in a problem: the rest of the command may hold a secret.
        shown = f"`!{(raw[1:].split() or [''])[0]} ...`"
        cached = _command_cache.get(raw)
        if cached:
            return cached, ""
        try:
            done = subprocess.run(
                raw[1:],
                shell=True,
                capture_output=True,
                text=True,
                timeout=_COMMAND_TIMEOUT,
                stdin=subprocess.DEVNULL,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return "", f"command {shown} timed out after {_COMMAND_TIMEOUT}s"
        except OSError as exc:
            return "", f"command {shown} could not run ({type(exc).__name__})"
        value = done.stdout.strip()
        if done.returncode != 0 or not value:
            return "", f"command {shown} exited {done.returncode} with no key on stdout"
        _command_cache[raw] = value
        return value, ""
    if raw in os.environ:
        value = os.environ[raw].strip()
        return value, "" if value else f"environment variable {raw} is empty"
    return raw.strip(), ""


def _find_api_key() -> tuple[str, list[str]]:
    """(key, problems met on the way) from the env var, models.json, then auth.json."""
    problems: list[str] = []
    env_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if env_key:
        return env_key, problems
    try:
        cfg = json.loads((_agent_dir() / "models.json").read_text())
        raw = cfg["providers"]["bailian"]["apiKey"]
        if isinstance(raw, str) and raw.strip():
            key, problem = _resolve_config_value(raw.strip())
            if key:
                return key, problems
            problems.append(f"models.json providers.bailian.apiKey: {problem}")
    except (OSError, ValueError, KeyError, TypeError):
        pass
    try:
        auth = json.loads((_agent_dir() / "auth.json").read_text())
        cred = auth.get("bailian") if isinstance(auth, dict) else None
        if isinstance(cred, dict) and isinstance(cred.get("key"), str) and cred["key"].strip():
            key, problem = _resolve_config_value(cred["key"].strip())
            if key:
                return key, problems
            problems.append(f"auth.json bailian.key: {problem}")
    except (OSError, ValueError):
        pass
    return "", problems


def _resolve_api_key() -> str:
    return _find_api_key()[0]


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

    Returns the answer text; an empty answer comes back as a sentence that says
    so. Raises RuntimeError when no API key is found and on API errors (400 with
    the valid tier list means a bad strategy value).

    This call blocks its thread for the whole search. Inside the kernel use
    `await asearch(...)`, which runs it in a worker thread so the kernel's other
    tasks (subagents, browser sessions, heartbeats) keep running meanwhile.
    """
    if strategy and strategy not in _TIERS:
        raise ValueError(
            f"invalid strategy {strategy!r}; one of {_TIERS}"
        )
    key = _resolve_api_key()
    if not key:
        problems = _find_api_key()[1]
        detail = f" ({'; '.join(problems)})" if problems else ""
        raise RuntimeError(
            "no Bailian API key found: set DASHSCOPE_API_KEY or configure "
            f"providers.bailian.apiKey in ~/.prime/agent/models.json{detail}"
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
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:300]
        raise RuntimeError(f"bailian search HTTP {e.code}: {body}") from e
    finally:
        _note_if_blocked_loop(time.monotonic() - started)
    choice = (data.get("choices") or [{}])[0] or {}
    content = (choice.get("message") or {}).get("content")
    if not isinstance(content, str) or not content.strip():
        # An empty string reads like "the web has nothing on this", which is rarely true: the
        # usual causes are a filtered answer or a question too broad for the search tier.
        return SearchAnswer(
            f"(bailian_web_search found no answer for {query!r}: the search model returned empty text, "
            f"finish_reason={choice.get('finish_reason')!r}. Usually the answer was filtered or the "
            "question was too broad; ask a narrower question, or read primary pages with "
            "web_research.search / web_research.fetch.)"
        )
    return SearchAnswer(content)


def _note_if_blocked_loop(seconds: float) -> None:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return  # a worker thread or a plain script: nothing else was waiting on this thread
    print(
        f"bailian_web_search: search() held the kernel's event loop for {seconds:.0f}s, pausing every "
        "background task meanwhile; `await bailian_web_search.asearch(...)` runs it in a worker thread.",
        file=sys.stderr,
        flush=True,
    )


async def asearch(query: str, **kwargs: Any) -> str:
    """search() in a worker thread: same arguments and answer, and the kernel keeps running meanwhile.

    Interrupting the cell stops the wait at once; the request itself ends on its own within `timeout`.
    """
    return await asyncio.to_thread(search, query, **kwargs)
