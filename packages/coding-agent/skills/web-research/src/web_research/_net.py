"""Proxy routing and HTTP clients.

This machine reaches the internet through an HTTP proxy set in the environment, but the local
SearXNG container answers 502 when a request to 127.0.0.1 goes through that proxy. So loopback
and NO_PROXY hosts always go direct and everything else uses the proxy explicitly, instead of
letting each library read the environment its own way (httpx also mounts ALL_PROXY=socks5://,
which needs an extra package and fails at client construction).
"""

from __future__ import annotations

import os
from urllib.parse import urlsplit

import httpx

CHROME_MAJOR = "140"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
    f"Chrome/{CHROME_MAJOR}.0.0.0 Safari/537.36"
)
_LOOPBACK = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}


def _env(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def _no_proxy_hosts() -> list[str]:
    raw = _env("NO_PROXY", "no_proxy")
    return [h.strip().lower().lstrip(".") for h in raw.split(",") if h.strip()]


def is_direct(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    if host in _LOOPBACK or host.endswith(".localhost"):
        return True
    for entry in _no_proxy_hosts():
        if entry == "*" or host == entry or host.endswith("." + entry):
            return True
    return False


def proxy_url() -> str | None:
    """The outbound HTTP(S) proxy from the environment, or None. SOCKS-only setups fall back to ALL_PROXY."""
    return _env("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy") or None


def proxy_for(url: str) -> str | None:
    return None if is_direct(url) else proxy_url()


def local_client(timeout: float) -> httpx.AsyncClient:
    """Client for loopback services (SearXNG). Never uses a proxy."""
    return httpx.AsyncClient(trust_env=False, timeout=timeout)


def outbound_client(url: str, timeout: float, headers: dict[str, str] | None = None) -> httpx.AsyncClient:
    merged = {"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8"}
    merged.update(headers or {})
    return httpx.AsyncClient(
        trust_env=False,
        proxy=proxy_for(url),
        timeout=timeout,
        follow_redirects=True,
        headers=merged,
    )
