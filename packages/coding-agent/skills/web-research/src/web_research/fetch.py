"""Tiered page fetch: plain HTTP, then headless browser, then the Wayback Machine, then "needs a human"."""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

from . import _browser, _extract, _lines, _net

HTTP_TIMEOUT = 20.0
BROWSER_NAV_TIMEOUT_MS = 30_000
NETWORK_IDLE_MS = 8_000
ARCHIVE_TIMEOUT = 25.0
DEFAULT_MIN_CHARS = 400


@dataclass
class FetchResult:
    url: str
    ok: bool
    tier: str | None
    final_url: str = ""
    status: int | None = None
    title: str = ""
    content: str = ""
    content_mode: str = ""
    needs_human: bool = False
    reason: str = ""
    archived_at: str = ""
    elapsed: float = 0.0
    truncated: bool = False
    attempts: list[dict[str, Any]] = field(default_factory=list)

    @property
    def key_lines(self) -> list[str]:
        """Price, spec, route and stock lines of the content, in page order."""
        return _lines.key_lines(self.content)

    def save(self, path: str | None = None) -> str:
        """Write the full content to a file (default: a temp .md) and return the path."""
        return _lines.save_text(f"URL: {self.final_url or self.url}\n\n{self.content}", path, "page")

    def __str__(self) -> str:
        """Compact view: status, key lines and the first ~1500 chars. Full text: .content or .save()."""
        head = [f"URL: {self.final_url or self.url}"]
        if self.ok:
            head.append(
                f"tier: {self.tier}  status: {self.status}  {len(self.content)} chars ({self.content_mode})  "
                f"{self.elapsed:.1f}s"
            )
        else:
            head.append(f"FAILED after {self.elapsed:.1f}s: {self.reason}")
        if self.needs_human:
            head.append("NEEDS A HUMAN: open the page in a normal browser; do not guess its content.")
        if self.archived_at:
            head.append(f"ARCHIVED COPY from {self.archived_at} - may be stale; do not quote as a current price.")
        if self.title:
            head.append(f"title: {self.title}")
        tried = ", ".join(
            f"{a['tier']}={'ok' if a['ok'] else a.get('reason', 'fail')}({a['seconds']:.1f}s)" for a in self.attempts
        )
        head.append(f"tried: {tried}")
        keys = self.key_lines
        if keys:
            head.append("key lines (price/spec/route/stock):\n  " + "\n  ".join(keys))
        preview = self.content[: _lines.PREVIEW_CHARS]
        rest = len(self.content) - len(preview)
        if rest > 0:
            preview += f"\n[... {rest} more chars: print(page.content), or page.save() for a file]"
        elif self.truncated:
            preview += "\n[... cut at max_chars]"
        return "\n".join(head) + ("\n\n" + preview if preview else "")

    __repr__ = __str__


@dataclass
class _Page:
    html: str
    status: int | None
    final_url: str
    rendered_text: str | None = None


def _judge(page: _Page, min_chars: int, mode: str, expect: str | None = None) -> tuple[str | None, str, str, str]:
    """(failure_reason or None, content, content_mode, title) for one tier's page."""
    title = _extract.html_title(page.html)
    content, used = _extract.best_content(page.html, page.final_url, mode, page.rendered_text)
    text = page.rendered_text if page.rendered_text is not None else _extract.visible_text(page.html)
    if _extract.looks_like_challenge(page.html, text, page.status):
        return "captcha/challenge page", content, used, title
    if _extract.looks_like_login_wall(page.html, text, page.final_url):
        return "login wall", content, used, title
    if page.status is not None and page.status >= 400:
        return f"HTTP {page.status}", content, used, title
    thin = _extract.thin_reason(page.html, content, min_chars)
    if thin:
        return thin, content, used, title
    if expect and not re.search(expect, content, re.IGNORECASE):
        return f"expected text {expect!r} not on the page", content, used, title
    return None, content, used, title


async def _http_get(url: str, timeout: float) -> _Page:
    from curl_cffi import CurlOpt  # native lib; loaded on first fetch
    from curl_cffi.requests import AsyncSession

    proxy = _net.proxy_for(url)
    # libcurl reads the lowercase http_proxy/https_proxy variables by itself even with
    # trust_env=False, so a direct request has to switch the proxy off explicitly.
    options = {} if proxy else {CurlOpt.NOPROXY: "*"}
    async with AsyncSession(impersonate="chrome", timeout=timeout, trust_env=False, curl_options=options) as session:
        resp = await session.get(url, allow_redirects=True, proxy=proxy)
    raw = resp.content
    ctype = resp.headers.get("content-type", "")
    charset = resp.charset if hasattr(resp, "charset") else None
    html = _decode(raw, ctype, charset)
    return _Page(html=html, status=resp.status_code, final_url=str(resp.url))


def _decode(raw: bytes, ctype: str, charset: str | None) -> str:
    candidates = [c for c in (charset, _charset_from(ctype), _meta_charset(raw)) if c]
    for enc in [*candidates, "utf-8", "gb18030"]:
        try:
            return raw.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", errors="replace")


def _charset_from(ctype: str) -> str | None:
    for part in ctype.split(";"):
        part = part.strip().lower()
        if part.startswith("charset="):
            return part.split("=", 1)[1].strip("\"' ")
    return None


def _meta_charset(raw: bytes) -> str | None:
    head = raw[:4096].decode("ascii", errors="ignore").lower()
    idx = head.find("charset=")
    if idx < 0:
        return None
    rest = head[idx + 8 :].lstrip("\"' ")
    name = "".join(ch for ch in rest[:20] if ch.isalnum() or ch in "-_")
    return name or None


async def _browser_get(url: str, wait_for: str | None, wait_ms: int) -> _Page:
    wrapped = await _browser.new_context()
    try:
        page = await wrapped.ctx.new_page()
        resp = await page.goto(url, wait_until="domcontentloaded", timeout=BROWSER_NAV_TIMEOUT_MS)
        status = resp.status if resp is not None else None
        await _settle(page, wait_for, wait_ms)
        html = await page.content()
        text = await _inner_text(page)
        if _extract.looks_like_challenge(html, text, status):
            # A real browser often clears a non-interactive "checking your browser" page on its own.
            # Only waiting is done here; nothing is solved or clicked.
            for _ in range(6):
                await page.wait_for_timeout(2000)
                html = await page.content()
                text = await _inner_text(page)
                if not _extract.looks_like_challenge(html, text, None):
                    status = None  # the challenge response's status no longer describes the page shown
                    break
        return _Page(html=html, status=status, final_url=page.url, rendered_text=text)
    finally:
        await _browser.close_context(wrapped)


async def _settle(page: Any, wait_for: str | None, wait_ms: int) -> None:
    from playwright.async_api import TimeoutError as PlaywrightTimeout

    if wait_for:
        try:
            await page.wait_for_selector(wait_for, timeout=max(wait_ms, 10_000), state="visible")
        except PlaywrightTimeout:
            pass
    try:
        await page.wait_for_load_state("networkidle", timeout=wait_ms)
    except PlaywrightTimeout:
        pass


async def _inner_text(page: Any) -> str:
    try:
        return await page.evaluate("() => document.body ? document.body.innerText : ''")
    except Exception:  # noqa: BLE001 - page navigated away mid-read
        return ""


async def _archive_get(url: str) -> tuple[_Page, str]:
    api = f"https://archive.org/wayback/available?url={quote(url, safe='')}"
    async with _net.outbound_client(api, ARCHIVE_TIMEOUT) as client:
        info = (await client.get(api)).json()
    closest = (info.get("archived_snapshots") or {}).get("closest") or {}
    stamp = str(closest.get("timestamp") or "") if closest.get("available") else ""
    if not stamp:
        # The availability API intermittently answers an empty object for pages it does hold
        # (seen 2026-09-25 for docs.python.org and vultr.com); the CDX index is the second opinion.
        cdx = f"https://web.archive.org/cdx/search/cdx?url={quote(url, safe='')}&output=json&limit=-1&filter=statuscode:200"
        async with _net.outbound_client(cdx, ARCHIVE_TIMEOUT) as client:
            resp = await client.get(cdx)
        rows = resp.json() if resp.status_code == 200 and resp.text.strip() else []
        stamp = str(rows[-1][1]) if len(rows) > 1 else ""
    if not stamp:
        raise LookupError("no Wayback Machine snapshot")
    raw_url = f"https://web.archive.org/web/{stamp}id_/{url}"
    page = await _http_get(raw_url, ARCHIVE_TIMEOUT)
    when = f"{stamp[0:4]}-{stamp[4:6]}-{stamp[6:8]}"
    return page, when


def _classify_human(reasons: list[str]) -> str:
    joined = " ".join(reasons)
    if "login" in joined:
        return "login wall: the page needs an account"
    if "captcha" in joined or "challenge" in joined:
        return "captcha/bot challenge: a human has to pass it in a normal browser"
    if "HTTP 403" in joined or "HTTP 429" in joined or "HTTP 451" in joined:
        return "blocked: the site refuses automated access (403/429)"
    if "HTTP 404" in joined or "HTTP 410" in joined:
        return "not found (404/410) and no archived copy"
    return "unreachable or empty: " + (reasons[-1] if reasons else "no tier returned content")


async def fetch(
    url: str,
    *,
    render: str = "auto",
    max_chars: int = 20_000,
    mode: str = "auto",
    wait_for: str | None = None,
    wait_ms: int = NETWORK_IDLE_MS,
    min_chars: int = DEFAULT_MIN_CHARS,
    archive: bool = True,
    expect: str | None = None,
) -> FetchResult:
    """Fetch one page as readable text, escalating only when the cheaper tier did not get the page.

    render: "auto" (HTTP first, browser if the page is a JS shell/too short/challenge/blocked),
      "never" (HTTP only), "always" (skip straight to the headless browser).
    mode: "auto" (main-content markdown with tables, or full visible text when extraction dropped
      most of a large page such as a pricing grid), "main", or "full".
    wait_for: CSS selector the browser tier waits for (e.g. a price table) before reading.
    archive: fall back to the latest Wayback Machine snapshot (marked stale) when live tiers fail.
    expect: regex the content must contain, e.g. "[$¥][0-9]|[0-9]+元" on a pricing page. Pages whose
      prices are filled in by JavaScript read fine over HTTP but without the numbers; a miss
      escalates to the browser tier.
    """
    if render not in ("auto", "never", "always"):
        raise ValueError("render must be 'auto', 'never' or 'always'")
    if mode not in ("auto", "main", "full"):
        raise ValueError("mode must be 'auto', 'main' or 'full'")
    started = time.monotonic()
    result = FetchResult(url=url, ok=False, tier=None)
    reasons: list[str] = []

    async def attempt(tier: str, getter: Any, tier_min_chars: int = min_chars) -> bool:
        t0 = time.monotonic()
        try:
            got = await getter()
        except Exception as exc:  # noqa: BLE001 - each tier's failure is reported, then the next tier runs
            reason = f"{type(exc).__name__}: {str(exc).splitlines()[0][:160] if str(exc) else ''}"
            reasons.append(reason)
            result.attempts.append({"tier": tier, "ok": False, "reason": reason, "seconds": time.monotonic() - t0})
            return False
        page, archived = got if isinstance(got, tuple) else (got, "")
        failure, content, used, title = _judge(page, tier_min_chars, mode, expect)
        entry = {"tier": tier, "ok": failure is None, "status": page.status, "seconds": time.monotonic() - t0}
        if failure:
            entry["reason"] = failure
            reasons.append(failure)
        result.attempts.append(entry)
        if failure is None or not result.content:
            result.final_url, result.status, result.title = page.final_url, page.status, title
            result.content, result.content_mode = content, used
        if failure is None:
            result.ok, result.tier, result.archived_at = True, tier, archived
        return failure is None

    done = False
    if render != "always":
        done = await attempt("http", lambda: _http_get(url, HTTP_TIMEOUT))
    not_found = bool(result.attempts) and result.attempts[-1].get("status") in (404, 410)
    if not done and render != "never" and not not_found:
        # After a real render a short page is simply short (example.com is 113 chars), not a JS shell.
        done = await attempt("browser", lambda: _browser_get(url, wait_for, wait_ms), min(min_chars, 1))
    if not done and archive:
        done = await attempt("archive", lambda: _archive_get(url))
    if not done:
        result.reason = _classify_human(reasons)
        live = [r for r in reasons if "snapshot" not in r]
        result.needs_human = any(k in " ".join(live) for k in ("login", "captcha", "challenge", "HTTP 403", "HTTP 429"))
        result.content = ""  # a challenge or login page is not the page; never hand it back as content
    result.elapsed = time.monotonic() - started
    if len(result.content) > max_chars:
        result.content, result.truncated = result.content[:max_chars], True
    return result


async def fetch_many(urls: list[str], *, concurrency: int = 4, **kwargs: Any) -> list[FetchResult]:
    """fetch() several URLs concurrently (bounded), results in input order."""
    sem = asyncio.Semaphore(max(1, concurrency))

    async def one(u: str) -> FetchResult:
        async with sem:
            return await fetch(u, **kwargs)

    return list(await asyncio.gather(*(one(u) for u in urls)))
