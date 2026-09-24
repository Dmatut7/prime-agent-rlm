"""Web research for the kernel: search, read pages, click through to real prices, query paper/Q&A APIs.

    results = await web_research.search("香港 CN2 GIA VPS 价格")
    page = await web_research.fetch("https://docs.python.org/3/library/asyncio-task.html")
    async with web_research.BrowserSession() as b: ...
    papers = await web_research.arxiv("retrieval augmented generation")

See the skill's SKILL.md for when to use which.
"""

from ._browser import POOL as _POOL
from .browser import (
    BrowseResult,
    BrowserSession,
    CapturedResponse,
    PaymentGuardRefused,
    SessionClosed,
    Snapshot,
    browse,
)
from .fetch import FetchResult, fetch, fetch_many
from .search import SearchResults, SearchUnavailable, search
from .sources import Records, arxiv, crossref, github, openalex, stackexchange


async def shutdown_browser() -> None:
    """Close the shared headless browser now (it also closes itself ~20s after the last user)."""
    await _POOL.shutdown()


def browser_running() -> bool:
    """Whether the shared headless browser process is up right now."""
    return _POOL.running


__all__ = [
    "BrowseResult",
    "BrowserSession",
    "CapturedResponse",
    "FetchResult",
    "PaymentGuardRefused",
    "Records",
    "SearchResults",
    "SearchUnavailable",
    "SessionClosed",
    "Snapshot",
    "arxiv",
    "browse",
    "browser_running",
    "crossref",
    "fetch",
    "fetch_many",
    "github",
    "openalex",
    "search",
    "shutdown_browser",
    "stackexchange",
]
