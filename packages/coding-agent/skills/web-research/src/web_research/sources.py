"""Free, keyless APIs for papers and technical Q&A. Structured data beats scraping result pages."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

from . import _net
from .fetch import _http_get

API_TIMEOUT = 30.0


@dataclass
class Records:
    source: str
    query: str
    items: list[dict[str, Any]]
    note: str = ""

    def __iter__(self) -> Any:
        return iter(self.items)

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int) -> dict[str, Any]:
        return self.items[index]

    def __str__(self) -> str:
        lines = [f"{self.source}: {self.query!r} - {len(self.items)} items"]
        if self.note:
            lines.append(self.note)
        for i, it in enumerate(self.items, 1):
            meta = " ".join(
                f"{k}={it[k]}"
                for k in ("year", "score", "answers", "stars", "cited_by", "state")
                if it.get(k) is not None
            )
            lines.append(f"{i}. {it.get('title', '')} {('(' + meta + ')') if meta else ''}\n   {it.get('url', '')}")
            if it.get("authors"):
                lines.append(f"   {', '.join(it['authors'][:4])}{' et al.' if len(it['authors']) > 4 else ''}")
            if it.get("summary"):
                lines.append(f"   {it['summary'][:260]}")
        return "\n".join(lines)

    __repr__ = __str__


async def _get_json(url: str, params: dict[str, Any], headers: dict[str, str] | None = None) -> Any:
    async with _net.outbound_client(url, API_TIMEOUT, headers) as client:
        resp = await client.get(url, params=params)
    if resp.status_code == 429:
        raise RuntimeError(f"{url} rate-limited this machine (429); wait a minute or narrow the query")
    resp.raise_for_status()
    return resp.json()


def _squash(text: Any) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", str(text or ""))).strip()


async def arxiv(query: str, *, max_results: int = 10, sort: str = "relevance") -> Records:
    """arXiv papers. query uses arXiv syntax: plain words, or ti:/au:/abs:/cat: fields (e.g. "cat:cs.CL AND abs:agents").

    sort: "relevance", "lastUpdatedDate" or "submittedDate" (newest first).
    """
    q = query if re.search(r"\b(ti|au|abs|cat|all|co|jr|rn|id):", query) else f"all:{query}"
    params = {"search_query": q, "start": 0, "max_results": max_results, "sortBy": sort, "sortOrder": "descending"}
    url = "https://export.arxiv.org/api/query?" + urlencode(params)
    # Measured 2026-09-25: arXiv's frontend answers 406 to Python's TLS/HTTP client but 200 to curl,
    # so this request goes through the same Chrome-fingerprint client as fetch().
    page = await _http_get(url, API_TIMEOUT)
    if page.status != 200:
        raise RuntimeError(f"arXiv API answered HTTP {page.status}; wait a few seconds (limit ~1 request/3s) and retry")
    ns = {"a": "http://www.w3.org/2005/Atom"}
    root = ET.fromstring(page.html.encode())
    items = []
    for entry in root.findall("a:entry", ns):
        link = entry.findtext("a:id", default="", namespaces=ns)
        pdf = next((ln.get("href") for ln in entry.findall("a:link", ns) if ln.get("title") == "pdf"), None)
        items.append(
            {
                "title": _squash(entry.findtext("a:title", default="", namespaces=ns)),
                "url": link,
                "pdf": pdf,
                "year": (entry.findtext("a:published", default="", namespaces=ns) or "")[:4] or None,
                "published": (entry.findtext("a:published", default="", namespaces=ns) or "")[:10],
                "updated": (entry.findtext("a:updated", default="", namespaces=ns) or "")[:10],
                "authors": [
                    _squash(a.findtext("a:name", default="", namespaces=ns)) for a in entry.findall("a:author", ns)
                ],
                "summary": _squash(entry.findtext("a:summary", default="", namespaces=ns)),
            }
        )
    return Records("arxiv", query, items)


async def crossref(query: str, *, rows: int = 10, filter: str | None = None) -> Records:
    """Crossref works (journal articles, proceedings, books) with DOIs and citation counts.

    filter: Crossref filter string, e.g. "from-pub-date:2024-01-01,type:journal-article".
    Set CROSSREF_MAILTO to join Crossref's faster "polite pool"; no address is sent otherwise.
    """
    params: dict[str, Any] = {"query": query, "rows": rows}
    if filter:
        params["filter"] = filter
    mailto = os.environ.get("CROSSREF_MAILTO", "").strip()
    if mailto:
        params["mailto"] = mailto
    data = await _get_json("https://api.crossref.org/works", params)
    items = []
    for w in (data.get("message") or {}).get("items") or []:
        parts = ((w.get("issued") or {}).get("date-parts") or [[None]])[0]
        items.append(
            {
                "title": _squash((w.get("title") or [""])[0]),
                "url": w.get("URL") or (f"https://doi.org/{w['DOI']}" if w.get("DOI") else ""),
                "doi": w.get("DOI"),
                "year": parts[0] if parts else None,
                "type": w.get("type"),
                "venue": _squash((w.get("container-title") or [""])[0]),
                "authors": [" ".join(_nonempty((a.get("given"), a.get("family")))) for a in w.get("author") or []],
                "cited_by": w.get("is-referenced-by-count"),
                "summary": _squash(w.get("abstract")),
            }
        )
    note = "" if mailto else "(public pool; set CROSSREF_MAILTO for the faster polite pool)"
    return Records("crossref", query, items, note)


def _nonempty(values: tuple[Any, ...]) -> list[str]:
    return [str(v) for v in values if v]


async def openalex(query: str, *, per_page: int = 10, filter: str | None = None) -> Records:
    """OpenAlex scholarly works (keyless as of 2026-09-25): title, year, venue, citations, open-access URL.

    filter: OpenAlex filter, e.g. "publication_year:>2023,is_oa:true".
    """
    params: dict[str, Any] = {"search": query, "per-page": per_page}
    if filter:
        params["filter"] = filter
    mailto = os.environ.get("OPENALEX_MAILTO", "").strip()
    if mailto:
        params["mailto"] = mailto
    data = await _get_json("https://api.openalex.org/works", params)
    items = []
    for w in data.get("results") or []:
        loc = w.get("primary_location") or {}
        oa = (w.get("open_access") or {}).get("oa_url")
        items.append(
            {
                "title": _squash(w.get("display_name")),
                "url": oa or loc.get("landing_page_url") or w.get("doi") or w.get("id"),
                "doi": w.get("doi"),
                "year": w.get("publication_year"),
                "venue": ((loc.get("source") or {}) or {}).get("display_name"),
                "authors": [((a.get("author") or {}).get("display_name") or "") for a in w.get("authorships") or []],
                "cited_by": w.get("cited_by_count"),
                "summary": _abstract(w.get("abstract_inverted_index")),
            }
        )
    return Records("openalex", query, items)


def _abstract(index: dict[str, list[int]] | None) -> str:
    if not index:
        return ""
    words: dict[int, str] = {}
    for word, positions in index.items():
        for pos in positions:
            words[pos] = word
    return " ".join(words[i] for i in sorted(words))


async def stackexchange(
    query: str,
    *,
    site: str = "stackoverflow",
    pagesize: int = 10,
    accepted_only: bool = False,
    tagged: str | None = None,
) -> Records:
    """Stack Exchange questions ranked by relevance (site: stackoverflow, serverfault, superuser, unix, askubuntu...).

    Keyless quota is 300 requests/day per IP; set STACKEXCHANGE_KEY for 10k/day.
    """
    params: dict[str, Any] = {
        "q": query,
        "site": site,
        "order": "desc",
        "sort": "relevance",
        "pagesize": pagesize,
        "filter": "withbody",
    }
    if accepted_only:
        params["accepted"] = "True"
    if tagged:
        params["tagged"] = tagged
    key = os.environ.get("STACKEXCHANGE_KEY", "").strip()
    if key:
        params["key"] = key
    data = await _get_json("https://api.stackexchange.com/2.3/search/advanced", params)
    items = [
        {
            "title": _squash(q.get("title")),
            "url": q.get("link"),
            "score": q.get("score"),
            "answers": q.get("answer_count"),
            "accepted": bool(q.get("accepted_answer_id")),
            "tags": q.get("tags"),
            "year": None,
            "summary": _squash(q.get("body"))[:400],
        }
        for q in data.get("items") or []
    ]
    note = f"quota left today: {data.get('quota_remaining')}" if data.get("quota_remaining") is not None else ""
    return Records(f"stackexchange/{site}", query, items, note)


async def _gh_api(path: str, params: dict[str, Any]) -> Any:
    gh = shutil.which("gh")
    if not gh:
        raise FileNotFoundError("gh")
    args = [gh, "api", "-X", "GET", path]
    for k, v in params.items():
        args += ["-f", f"{k}={v}"]
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await asyncio.wait_for(proc.communicate(), timeout=API_TIMEOUT)
    if proc.returncode != 0:
        raise RuntimeError(f"gh api failed: {err.decode(errors='replace').strip()[:200]}")
    return json.loads(out)


async def github(query: str, *, kind: str = "repositories", limit: int = 10, sort: str | None = None) -> Records:
    """GitHub search. kind: "repositories", "issues" (issues and PRs) or "code" (code needs auth).

    Uses the logged-in `gh` CLI when available, else GITHUB_TOKEN/GH_TOKEN, else anonymous
    (10 searches/minute, no code search). Query syntax is GitHub's: "playwright stealth language:python stars:>100".
    """
    if kind not in ("repositories", "issues", "code"):
        raise ValueError("kind must be 'repositories', 'issues' or 'code'")
    params: dict[str, Any] = {"q": query, "per_page": limit}
    if sort:
        params["sort"] = sort
    via = "gh"
    try:
        data = await _gh_api(f"search/{kind}", params)
    except (FileNotFoundError, RuntimeError, asyncio.TimeoutError):
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        headers = {"Accept": "application/vnd.github+json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
            via = "token"
        else:
            via = "anonymous"
        data = await _get_json(f"https://api.github.com/search/{kind}", params, headers)
    items = []
    for it in data.get("items") or []:
        if kind == "repositories":
            items.append(
                {
                    "title": it.get("full_name"),
                    "url": it.get("html_url"),
                    "stars": it.get("stargazers_count"),
                    "summary": _squash(it.get("description")),
                    "updated": (it.get("pushed_at") or "")[:10],
                    "language": it.get("language"),
                }
            )
        elif kind == "issues":
            items.append(
                {
                    "title": _squash(it.get("title")),
                    "url": it.get("html_url"),
                    "state": it.get("state"),
                    "summary": _squash(it.get("body"))[:300],
                    "updated": (it.get("updated_at") or "")[:10],
                }
            )
        else:
            items.append(
                {
                    "title": f"{(it.get('repository') or {}).get('full_name')}: {it.get('path')}",
                    "url": it.get("html_url"),
                }
            )
    return Records(f"github/{kind}", query, items, f"via {via}; total matches {data.get('total_count')}")
