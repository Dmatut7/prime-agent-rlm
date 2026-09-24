"""Pick the price, spec, route and stock lines out of page text, and park full text on disk.

Printing a whole vendor page into the conversation is costly, and on Bailian models it can end the
turn outright: measured 2026-09-25 in six parallel VPS research subagents, raw vendor text (full of
DDoS/firewall/protection wording) made the provider answer 400 data_inspection_failed, which
cannot be retried. So results print these few lines first and keep the full text on request or in
a file.
"""

from __future__ import annotations

import os
import re
import tempfile
import time

PRICE = re.compile(
    r"([$€£¥￥]\s?\d|\d[\d,.]*\s?(usd|cny|rmb|eur|hkd|jpy|gbp|元|円)\b|"
    r"/\s?(mo|month|yr|year|annually|monthly|quarterly)\b|/\s?[月年季]|[月年季]付|每月|每年|每季|"
    r"\b(setup|renew|renewal|recurring|first\s+(month|year|term)|total|subtotal|due\s+today|discount)\b|"
    r"(续费|首年|首月|安装费|初装费|设置费|合计|总计|小计|优惠|原价|到期))",
    re.IGNORECASE,
)
SPEC = re.compile(
    r"(\b\d+(\.\d+)?\s?(vcpu|vcore|cores?|gb|tb|mb|gbps|mbps|gib|tib)\b|\bipv[46]\b|\bnvme\b|\bssd\b|"
    r"\d+\s?核|内存|硬盘|带宽|流量|端口)",
    re.IGNORECASE,
)
ROUTE = re.compile(
    r"(\bcn2\b|\bgia\b|\bcmi\b|\bcu2\b|9929|4837|\bbgp\b|\bas\d{3,6}\b|三网|直连|回程|精品网)", re.IGNORECASE
)
STOCK = re.compile(r"(out of stock|sold out|in stock|unavailable|缺货|售罄|无货|有货|库存|补货)", re.IGNORECASE)
_AMOUNT_ONLY = re.compile(r"^[\s$€£¥￥]*\d[\d,.]*\s*(usd|cny|rmb|eur|hkd|元|円)?\s*(/\S+)?$", re.IGNORECASE)

PREVIEW_CHARS = 1500


def key_lines(text: str, *, limit: int = 40, max_len: int = 160) -> list[str]:
    """Price/spec/route/stock lines in page order. A bare amount is joined to the label line above it
    ("每年 (8折优惠) | 845.00元"), because pages often put the two in separate blocks."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    out: list[str] = []
    seen: set[str] = set()
    for i, ln in enumerate(lines):
        if len(ln) > max_len or not (PRICE.search(ln) or SPEC.search(ln) or ROUTE.search(ln) or STOCK.search(ln)):
            continue
        if _AMOUNT_ONLY.match(ln) and i > 0 and len(lines[i - 1]) <= 60:
            if out and out[-1] == lines[i - 1]:
                out.pop()  # the label now travels with its amount
            ln = f"{lines[i - 1]} | {ln}"
        if ln in seen:
            continue
        seen.add(ln)
        out.append(ln)
        if len(out) >= limit:
            break
    return out


def save_text(text: str, path: str | None, stem: str) -> str:
    if path is None:
        folder = os.path.join(tempfile.gettempdir(), "web_research")
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, f"{stem}-{int(time.time() * 1000)}.md")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path
