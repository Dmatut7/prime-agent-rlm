"""Web search through the local SearXNG metasearch container."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx

from . import _net

SEARCH_TIMEOUT = 25.0
_START_HINT = (
    "Start it from the bash tool with `docker start prime-searxng` (Docker Desktop must be running), "
    "wait ~5s and retry. Config: ~/.prime/agent/searxng/settings.yml."
)


def searxng_url() -> str:
    return os.environ.get("WEB_RESEARCH_SEARXNG_URL", "http://127.0.0.1:18888").rstrip("/")


class SearchUnavailable(RuntimeError):
    """SearXNG is not reachable or not answering JSON."""


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
        raise SearchUnavailable(f"SearXNG at {base} is not reachable ({type(exc).__name__}). {_START_HINT}") from None
    if resp.status_code == 403:
        raise SearchUnavailable(
            f"SearXNG at {base} refused the JSON format (403). Add `json` to search.formats in settings.yml "
            "and restart the container."
        )
    if resp.status_code >= 400:
        raise SearchUnavailable(f"SearXNG at {base} answered HTTP {resp.status_code}. {_START_HINT}")
    try:
        data = resp.json()
    except ValueError:
        raise SearchUnavailable(f"SearXNG at {base} did not return JSON. {_START_HINT}") from None
    results = [_normalize(r) for r in data.get("results") or [] if r.get("url")]
    return SearchResults(
        query=query,
        results=results[: max(1, max_results)],
        unresponsive=[
            str(u[0]) if isinstance(u, list) and u else str(u) for u in data.get("unresponsive_engines") or []
        ],
        suggestions=[str(s) for s in data.get("suggestions") or []],
        answers=[str(a.get("answer") if isinstance(a, dict) else a) for a in data.get("answers") or []],
        elapsed=time.monotonic() - started,
    )
