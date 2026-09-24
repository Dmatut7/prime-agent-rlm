"""Proxy routing, language preference and HTTP clients.

This machine reaches the internet through a proxy (Clash). In TUN mode no proxy setting is needed;
in system-proxy mode the proxy lives only in macOS network settings, and a kernel started without
the shell's HTTP(S)_PROXY variables would go direct and fail. So the proxy comes from the
environment first and from the macOS system settings (`scutil --proxy`) second.

The local SearXNG container answers 502 when a request to 127.0.0.1 goes through that proxy, so
loopback and NO_PROXY hosts always go direct and everything else uses the proxy explicitly,
instead of letting each library read the environment its own way (httpx also mounts
ALL_PROXY=socks5://, which needs an extra package and fails at client construction).
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import time
from urllib.parse import urlsplit

import httpx

CHROME_MAJOR = "140"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
    f"Chrome/{CHROME_MAJOR}.0.0.0 Safari/537.36"
)
_LOOPBACK = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
_SYSTEM_PROXY_TTL = 30.0
_system_cache: tuple[float, str | None, list[str]] | None = None

# Sites that serve a Chinese audience: asked in Chinese first, so they show CNY prices and the
# mainland offer rather than an international page. Everything else is asked in English first
# (docs and international vendors), with Chinese as the second choice.
_ZH_SUFFIXES = (".cn", ".中国")
_ZH_DOMAINS = (
    "aliyun.com",
    "tencent.com",
    "qcloud.com",
    "huaweicloud.com",
    "volcengine.com",
    "baidu.com",
    "bce.baidu.com",
    "qq.com",
    "jd.com",
    "jdcloud.com",
    "ucloud.cn",
    "ctyun.cn",
    "ksyun.com",
    "qiniu.com",
    "upyun.com",
    "bilibili.com",
    "zhihu.com",
    "csdn.net",
    "cnblogs.com",
    "juejin.cn",
    "v2ex.com",
    "lisahost.com",
    "hostloc.com",
)


def _env(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def parse_scutil(text: str) -> tuple[str | None, list[str]]:
    """(proxy URL or None, exception hosts) from `scutil --proxy` output. HTTPS wins over HTTP over SOCKS."""
    values: dict[str, str] = {}
    exceptions: list[str] = []
    in_exceptions = False
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("ExceptionsList"):
            in_exceptions = True
            continue
        if in_exceptions:
            if line.startswith("}"):
                in_exceptions = False
            elif ":" in line:
                exceptions.append(line.split(":", 1)[1].strip())
            continue
        if " : " in line:
            key, value = line.split(" : ", 1)
            values[key.strip()] = value.strip()
    proxy = None
    for enable, host, port, scheme in (
        ("HTTPSEnable", "HTTPSProxy", "HTTPSPort", "http"),
        ("HTTPEnable", "HTTPProxy", "HTTPPort", "http"),
        ("SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks5"),
    ):
        if values.get(enable) == "1" and values.get(host):
            proxy = f"{scheme}://{values[host]}:{values.get(port) or '80'}"
            break
    return proxy, exceptions


def _scutil_output() -> str:
    scutil = shutil.which("scutil") or ("/usr/sbin/scutil" if os.path.exists("/usr/sbin/scutil") else None)
    if sys.platform != "darwin" or not scutil:
        return ""
    try:
        return subprocess.run([scutil, "--proxy"], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def _system_proxy() -> tuple[str | None, list[str]]:
    """The macOS system proxy, re-read at most every 30 s so a Clash mode switch is picked up."""
    global _system_cache
    now = time.monotonic()
    if _system_cache is None or now - _system_cache[0] > _SYSTEM_PROXY_TTL:
        proxy, exceptions = parse_scutil(_scutil_output())
        _system_cache = (now, proxy, exceptions)
    return _system_cache[1], _system_cache[2]


def _no_proxy_hosts() -> list[str]:
    raw = _env("NO_PROXY", "no_proxy")
    hosts = [h.strip().lower().lstrip(".") for h in raw.split(",") if h.strip()]
    if not _env_proxy():
        hosts += [h.lower().removeprefix("*.").lstrip(".") for h in _system_proxy()[1] if h and "/" not in h]
    return hosts


def is_direct(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    if host in _LOOPBACK or host.endswith(".localhost"):
        return True
    for entry in _no_proxy_hosts():
        if entry == "*" or host == entry or host.endswith("." + entry):
            return True
    return False


def _env_proxy() -> str | None:
    return _env("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy") or None


def proxy_url() -> str | None:
    """The outbound proxy: environment first (SOCKS-only setups fall back to ALL_PROXY), then macOS system settings."""
    return _env_proxy() or _system_proxy()[0]


def proxy_for(url: str) -> str | None:
    return None if is_direct(url) else proxy_url()


def prefers_chinese(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return host.endswith(_ZH_SUFFIXES) or any(host == d or host.endswith("." + d) for d in _ZH_DOMAINS)


def accept_language(url: str) -> str:
    return "zh-CN,zh;q=0.9,en;q=0.8" if prefers_chinese(url) else "en-US,en;q=0.9,zh-CN;q=0.8"


def browser_locale(url: str) -> str:
    return "zh-CN" if prefers_chinese(url) else "en-US"


def _httpx_proxy(url: str) -> str | None:
    proxy = proxy_for(url)
    if proxy and proxy.startswith("socks") and importlib.util.find_spec("socksio") is None:
        # httpx cannot speak SOCKS without socksio; going direct works in Clash TUN mode and
        # fails with a clear connect error otherwise, instead of an ImportError at construction.
        return None
    return proxy


def local_client(timeout: float) -> httpx.AsyncClient:
    """Client for loopback services (SearXNG). Never uses a proxy."""
    return httpx.AsyncClient(trust_env=False, timeout=timeout)


def outbound_client(url: str, timeout: float, headers: dict[str, str] | None = None) -> httpx.AsyncClient:
    merged = {"User-Agent": USER_AGENT, "Accept-Language": accept_language(url)}
    merged.update(headers or {})
    return httpx.AsyncClient(
        trust_env=False,
        proxy=_httpx_proxy(url),
        timeout=timeout,
        follow_redirects=True,
        headers=merged,
    )
