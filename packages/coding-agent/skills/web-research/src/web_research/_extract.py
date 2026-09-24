"""HTML to readable text, and the checks that decide whether a fetch tier really got the page."""

from __future__ import annotations

import re
from typing import Any

import lxml.html

_BLOCK_TAGS = {
    "p",
    "div",
    "section",
    "article",
    "header",
    "footer",
    "main",
    "aside",
    "nav",
    "li",
    "ul",
    "ol",
    "tr",
    "table",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "br",
    "hr",
    "pre",
    "blockquote",
    "dt",
    "dd",
    "form",
    "label",
    "option",
}
_DROP_TAGS = ("script", "style", "noscript", "template", "svg", "canvas", "iframe", "head")

CHALLENGE_MARKERS = (
    "cf-chl",
    "challenge-platform",
    "just a moment...",
    "attention required! | cloudflare",
    "cf-turnstile",
    "checking your browser",
    "verify you are human",
    "are you a robot",
    "px-captcha",
    "_incapsula_resource",
    "ddos-guard",
    "captcha-delivery",
    "geetest",
    "h-captcha",
    "hcaptcha.com",
    "recaptcha/api",
    "滑动验证",
    "安全验证",
    "人机验证",
    "请完成验证",
    "访问验证",
)
_JS_SHELL_MARKERS = (
    'id="root"></div>',
    'id="app"></div>',
    'id="__next"',
    'id="__nuxt"',
    "enable javascript",
    "requires javascript",
    "javascript is disabled",
    "需要启用 javascript",
    "请开启javascript",
    "请启用javascript",
)
_LOGIN_URL = re.compile(r"/(login|signin|sign-in|sign_in|logon|passport|auth/|account/login|clientarea\.php)", re.I)
_LOGIN_TEXT = re.compile(r"(\blog\s?in\b|\bsign\s?in\b|登录|登入|请先登录)", re.I)


def html_title(html: str) -> str:
    match = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
    if not match:
        return ""
    return re.sub(r"\s+", " ", lxml.html.fromstring(f"<p>{match.group(1)}</p>").text_content()).strip()


def tidy(text: str) -> str:
    """Strip indentation outside code fences and collapse blank runs, so tables and headings read cleanly."""
    out: list[str] = []
    in_fence = False
    for raw in text.splitlines():
        line = raw.rstrip()
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            out.append(line.lstrip())
            continue
        out.append(line if in_fence else line.strip())
    joined = "\n".join(out)
    return re.sub(r"\n{3,}", "\n\n", joined).strip()


def visible_text(html: str) -> str:
    """All human-visible text, one block per line. Keeps what main-content extraction may drop (price cards)."""
    try:
        root = lxml.html.fromstring(html)
    except (ValueError, lxml.etree.ParserError):
        return ""
    for bad in list(root.iter(*_DROP_TAGS)):
        if bad.getparent() is not None:
            bad.drop_tree()
    parts: list[str] = []

    def walk(el: Any) -> None:
        tag = el.tag if isinstance(el.tag, str) else ""
        if tag in _BLOCK_TAGS:
            parts.append("\n")
        if tag in ("td", "th"):
            parts.append(" | ")
        if el.text:
            parts.append(el.text)
        for child in el:
            walk(child)
            if child.tail:
                parts.append(child.tail)
        if tag in _BLOCK_TAGS:
            parts.append("\n")

    walk(root)
    lines = [re.sub(r"[ \t ]+", " ", ln).strip(" |") for ln in "".join(parts).splitlines()]
    return "\n".join(ln for ln in lines if ln)


def main_markdown(html: str | bytes, url: str | None) -> str:
    import trafilatura  # heavy (dateparser, justext); loaded on first fetch, not at kernel start

    md = trafilatura.extract(
        html,
        url=url,
        output_format="markdown",
        include_tables=True,
        include_links=False,
        include_comments=False,
        include_images=False,
        favor_recall=True,
        deduplicate=False,
    )
    return tidy(md or "")


def best_content(html: str, url: str | None, mode: str, rendered_text: str | None = None) -> tuple[str, str]:
    """Pick main-content markdown or the full visible text. Returns (content, mode_used).

    Main-content extraction is built for articles and can drop pricing cards and plan grids as
    boilerplate. When it keeps under a quarter of the visible text on a large page, the full text
    is the honest view of what the page shows.
    """
    full = tidy(rendered_text) if rendered_text else visible_text(html)
    if mode == "full":
        return full, "full"
    main = main_markdown(html, url)
    if mode == "main":
        return main, "main"
    if len(full) > 1500 and len(main) < 0.25 * len(full):
        return full, "full"
    return (main, "main") if main else (full, "full")


def looks_like_challenge(html: str, text: str, status: int | None) -> bool:
    low = html[:200_000].lower()
    hit = any(m in low for m in CHALLENGE_MARKERS)
    return hit and (len(text) < 1500 or status in (403, 429, 503))


def looks_like_login_wall(html: str, text: str, final_url: str) -> bool:
    low = html[:200_000].lower()
    has_password = 'type="password"' in low or "type='password'" in low or "type=password" in low
    short = len(text) < 2500
    return (
        short and (has_password or bool(_LOGIN_URL.search(final_url))) and bool(_LOGIN_TEXT.search(text + low[:5000]))
    )


def thin_reason(html: str, text: str, min_chars: int) -> str | None:
    """Why the text is too thin to trust, or None. A JS shell is named separately because a browser fixes it."""
    if len(text) >= min_chars:
        return None
    low = html[:300_000].lower()
    if any(m in low for m in _JS_SHELL_MARKERS) or low.count("<script") >= 3:
        return f"js-shell ({len(text)} chars of text, page is built by JavaScript)"
    return f"too-short ({len(text)} chars of text)"
