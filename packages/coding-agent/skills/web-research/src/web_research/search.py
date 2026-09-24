"""Web search through the local SearXNG metasearch container.

SearXNG runs in a Docker container (`prime-searxng`) that was set up by hand on the owner's Mac;
nothing in prime-agent creates it. After a reboot Docker may not be running, and with the VPN off
every enabled engine (all foreign) fails at once. Both cases raise SearchUnavailable with what to
do next and the fallback, instead of an empty result list that reads like "no such thing".
"""

from __future__ import annotations

import os
import shutil
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx

from . import _net, _proc

SEARCH_TIMEOUT = 25.0
CONTAINER = "prime-searxng"
DEFAULT_URL = "http://127.0.0.1:18888"
_DOCKER_PATHS = (
    "/opt/homebrew/bin/docker",
    "/usr/local/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
)
FALLBACK_HINT = (
    "For this turn, search with `await bailian_web_search.asearch(query)` instead (Alibaba Bailian: it "
    "answers from mainland China without a VPN, but returns a summary without source URLs, so check "
    "the facts that matter with web_research.fetch on the source page)."
)


def searxng_url() -> str:
    return os.environ.get("WEB_RESEARCH_SEARXNG_URL", DEFAULT_URL).rstrip("/")


class SearchUnavailable(RuntimeError):
    """Search cannot work right now: SearXNG is down, or every search engine failed (network/VPN)."""


def _docker_path() -> str | None:
    override = os.environ.get("WEB_RESEARCH_DOCKER")
    if override:
        return override
    return shutil.which("docker") or next((p for p in _DOCKER_PATHS if os.path.exists(p)), None)


async def docker_state(docker: str | None) -> str:
    """ "running", "stopped", "no-daemon", "no-container", "no-docker" or "unknown" for the SearXNG container."""
    if not docker:
        return "no-docker"
    try:
        code, out = await _proc.run([docker, "inspect", "-f", "{{.State.Status}}", CONTAINER], 8)
    except OSError:
        return "no-docker"
    low = out.lower()
    if code == 0:
        return "running" if out.strip() == "running" else "stopped"
    if "no such object" in low or "no such container" in low:
        return "no-container"
    if "cannot connect" in low or "daemon" in low or "docker.sock" in low:
        return "no-daemon"
    return "unknown"


_STATE_HINTS = {
    "no-docker": "Docker is not installed or not on PATH here, so the local SearXNG cannot run.",
    "no-daemon": (
        "Docker itself is not running (usual after a reboot). From the bash tool: `open -a Docker`, wait until "
        f"`docker info` answers (30-90 s), then `docker start {CONTAINER}`, wait ~5 s and retry."
    ),
    "no-container": (
        f"The container {CONTAINER} does not exist on this machine: SearXNG is set up by hand (config in "
        "~/.prime/agent/searxng/settings.yml), so tell the owner search needs it."
    ),
    "stopped": f"The container is stopped: `docker start {CONTAINER}` from the bash tool, wait ~5 s and retry.",
    "running": (
        f"The container is running but not answering (it needs ~5 s after a start): wait and retry once, then "
        f"`docker restart {CONTAINER}`."
    ),
    "unknown": (
        f"From the bash tool: `docker start {CONTAINER}` (Docker must be running; `open -a Docker` starts it), "
        "wait ~5 s and retry."
    ),
}


async def _down_hint(base: str) -> str:
    if base != DEFAULT_URL:
        return f"Check the SearXNG instance at {base} (WEB_RESEARCH_SEARXNG_URL). {FALLBACK_HINT}"
    state = await docker_state(_docker_path())
    return f"{_STATE_HINTS[state]} {FALLBACK_HINT}"


_RATE_LIMIT_WORDS = ("too many requests", "429", "captcha", "access denied", "suspended")


def _engines_failed_message(failures: list[str]) -> str:
    listed = "; ".join(failures)[:300]
    if all(any(w in f.lower() for w in _RATE_LIMIT_WORDS) for f in failures):
        return (
            f"搜索服务不可用: no results, and the engines that failed refused this machine ({listed}). Engines "
            "punish bursts and SearXNG parks a refusing engine for up to an hour, so more queries now only "
            "extend that. Try engines='yahoo' or engines='yandex' once, or wait. " + FALLBACK_HINT
        )
    return (
        f"搜索服务不可用: no results, and {len(failures)} search engine(s) failed ({listed}). This is the network, "
        "not the query: Google, Brave and the other engines are foreign sites that fail together when the "
        "VPN/proxy is off or blocked, so rewording will not help. " + FALLBACK_HINT + " web_research.search "
        "works again once the network is back."
    )


def _engine_failures(data: dict[str, Any]) -> list[str]:
    out = []
    for item in data.get("unresponsive_engines") or []:
        if isinstance(item, list) and item:
            out.append(f"{item[0]}: {item[1]}" if len(item) > 1 and item[1] else str(item[0]))
        else:
            out.append(str(item))
    return out


@dataclass
class SearchResults:
    query: str
    results: list[dict[str, Any]]
    unresponsive: list[str] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)
    answers: list[str] = field(default_factory=list)
    elapsed: float = 0.0

    def __iter__(self) -> Any:
        return iter(self.results)

    def __len__(self) -> int:
        return len(self.results)

    def __getitem__(self, index: int) -> dict[str, Any]:
        return self.results[index]

    @property
    def urls(self) -> list[str]:
        return [r["url"] for r in self.results]

    @property
    def text(self) -> str:
        lines = [f"search: {self.query!r} - {len(self.results)} results in {self.elapsed:.1f}s"]
        if self.unresponsive:
            lines.append(f"engines that failed this time: {', '.join(self.unresponsive)}")
        for answer in self.answers[:2]:
            lines.append(f"answer: {answer[:300]}")
        for i, r in enumerate(self.results, 1):
            meta = "/".join(r["engines"]) or r["engine"]
            date = f" [{r['published']}]" if r.get("published") else ""
            lines.append(f"{i}. {r['title']}{date} ({meta})\n   {r['url']}")
            if r["snippet"]:
                lines.append(f"   {r['snippet'][:240]}")
        if not self.results:
            lines.append("no results - try other words, another language, or categories='it'/'science'/'news'")
        if self.suggestions:
            lines.append(f"suggestions: {', '.join(self.suggestions[:5])}")
        return "\n".join(lines)

    def __str__(self) -> str:
        return self.text

    __repr__ = __str__


def _as_csv(value: str | list[str] | tuple[str, ...] | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return ",".join(value)


def _normalize(item: dict[str, Any]) -> dict[str, Any]:
    url = str(item.get("url") or "")
    engines = [str(e) for e in item.get("engines") or []]
    return {
        "title": str(item.get("title") or "").strip(),
        "url": url,
        "domain": (urlsplit(url).hostname or "").removeprefix("www."),
        "snippet": " ".join(str(item.get("content") or "").split()),
        "engine": str(item.get("engine") or (engines[0] if engines else "")),
        "engines": engines,
        "published": str(item.get("publishedDate") or item.get("pubdate") or "")[:10] or None,
        "category": item.get("category"),
        "score": item.get("score"),
    }


async def search(
    query: str,
    *,
    categories: str | list[str] | None = None,
    engines: str | list[str] | None = None,
    max_results: int = 10,
    language: str | None = None,
    time_range: str | None = None,
    page: int = 1,
) -> SearchResults:
    """Search the web via the local SearXNG (Google, Yahoo, Yandex, Brave... merged and de-duplicated).

    categories: "general" (default), "it" (GitHub, Stack Overflow, MDN, PyPI, npm), "science"
      (arXiv, Crossref, OpenAlex, Google Scholar), "news".
    engines: restrict to named engines, e.g. "google" or ["yahoo", "yandex"], to cross-check.
    language: "zh-CN", "en", ... (default auto-detect from the query).
    time_range: "day", "week", "month" or "year".
    Returns SearchResults: iterate for dicts (title, url, domain, snippet, engine(s), published);
    print it for a compact numbered list.
    """
    if time_range not in (None, "day", "week", "month", "year"):
        raise ValueError("time_range must be None, 'day', 'week', 'month' or 'year'")
    params: dict[str, str] = {"q": query, "format": "json", "pageno": str(max(1, page))}
    for key, value in (
        ("categories", _as_csv(categories)),
        ("engines", _as_csv(engines)),
        ("language", language),
        ("time_range", time_range),
    ):
        if value:
            params[key] = value
    base = searxng_url()
    started = time.monotonic()
    try:
        async with _net.local_client(SEARCH_TIMEOUT) as client:
            resp = await client.get(f"{base}/search", params=params)
    except httpx.TransportError as exc:
        hint = await _down_hint(base)
        raise SearchUnavailable(
            f"搜索服务不可用: SearXNG at {base} is not reachable ({type(exc).__name__}). {hint}"
        ) from None
    if resp.status_code == 403:
        raise SearchUnavailable(
            f"SearXNG at {base} refused the JSON format (403). Add `json` to search.formats in settings.yml "
            "and restart the container."
        )
    if resp.status_code >= 400:
        hint = await _down_hint(base)
        raise SearchUnavailable(f"搜索服务不可用: SearXNG at {base} answered HTTP {resp.status_code}. {hint}")
    try:
        data = resp.json()
    except ValueError:
        hint = await _down_hint(base)
        raise SearchUnavailable(f"搜索服务不可用: SearXNG at {base} did not return JSON. {hint}") from None
    results = [_normalize(r) for r in data.get("results") or [] if r.get("url")]
    failures = _engine_failures(data)
    if not results and failures:
        # Rewording the query cannot fix a failed engine, and a model that reads an empty list as
        # "nothing exists" loops on query variants, so an empty answer with failures says why.
        raise SearchUnavailable(_engines_failed_message(failures))
    return SearchResults(
        query=query,
        results=results[: max(1, max_results)],
        unresponsive=[f.split(":", 1)[0] for f in failures],
        suggestions=[str(s) for s in data.get("suggestions") or []],
        answers=[str(a.get("answer") if isinstance(a, dict) else a) for a in data.get("answers") or []],
        elapsed=time.monotonic() - started,
    )
