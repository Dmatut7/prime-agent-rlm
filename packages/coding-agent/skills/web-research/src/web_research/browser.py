"""Interactive headless browsing for pages that only show the real price after clicks.

Typical path on a VPS vendor: product page -> "Order Now" -> choose billing cycle / location ->
cart or order-review page with the total, setup fee and renewal price. BrowserSession walks that
path headless and refuses the one step after it (see _guard).
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
from dataclasses import dataclass, field
from typing import Any

from . import _browser, _guard, _lines
from .fetch import _inner_text, _settle

DEFAULT_IDLE_TIMEOUT = 300.0
NAV_WAIT_SECONDS = 10.0
OUTLINE_PREVIEW = 60
_MAX_CAPTURED = 300
_MAX_JSON_BYTES = 1_000_000

_OUTLINE_JS = r"""
(maxItems) => {
  document.querySelectorAll('[data-wr-ref]').forEach(e => e.removeAttribute('data-wr-ref'));
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],' +
    '[role=tab],[role=radio],[role=checkbox],[role=option],[role=menuitem],[role=switch],[onclick],label,' +
    'h1,h2,h3,h4';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => {
    if (el.labels && el.labels.length) return clean(el.labels[0].innerText);
    const id = el.getAttribute('aria-labelledby');
    if (id) { const l = document.getElementById(id); if (l) return clean(l.innerText); }
    return clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '');
  };
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= maxItems) break;
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-4]$/.test(tag)) { out.push({kind: 'heading', tag, text: clean(el.innerText).slice(0, 120)}); continue; }
    // A label whose control is visible is listed with that control; a label over a hidden
    // (custom-styled) radio or checkbox is the thing to click, so it stays.
    if (tag === 'label' && el.control && visible(el.control)) continue;
    const ref = 'e' + (++n);
    el.setAttribute('data-wr-ref', ref);
    const item = {kind: 'control', ref, tag, role: el.getAttribute('role') || '', type: (el.getAttribute('type') || '').toLowerCase()};
    if (tag === 'select') {
      item.label = labelOf(el);
      item.options = Array.from(el.options).slice(0, 40).map(o => ({text: clean(o.text), value: o.value, selected: o.selected}));
    } else if (tag === 'input' && ['submit', 'button', 'image', 'reset'].includes(item.type)) {
      item.text = clean(el.value || el.getAttribute('alt') || el.getAttribute('aria-label') || '').slice(0, 100);
      item.role = item.role || 'button';
      if (!item.text) continue;
    } else if (tag === 'input' || tag === 'textarea') {
      item.label = labelOf(el);
      item.value = ['password'].includes(item.type) ? '' : clean(el.value).slice(0, 80);
      if (['radio', 'checkbox'].includes(item.type)) item.checked = el.checked;
    } else {
      item.text = clean(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 100);
      if (tag === 'a') item.href = el.getAttribute('href');
      const ar = el.getAttribute('aria-checked') || el.getAttribute('aria-selected') || el.getAttribute('aria-pressed');
      if (ar) item.state = ar;
      if (tag === 'label' && el.control && ['radio', 'checkbox'].includes(el.control.type)) {
        item.state = el.control.checked ? 'checked' : 'unchecked';
      }
      if (!item.text) continue;
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    out.push(item);
  }
  return out;
}
"""

_ELEMENT_INFO_JS = r"""
(hit) => {
  const el = hit.closest('button,a,[role=button],input[type=submit],input[type=image]') || hit;
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const form = el.form || el.closest('form');
  let sensitive = false;
  if (form) {
    for (const f of form.querySelectorAll('input,select,textarea')) {
      const t = (f.getAttribute('type') || '').toLowerCase();
      const ac = (f.getAttribute('autocomplete') || '').toLowerCase();
      const nm = ((f.name || '') + ' ' + (f.id || '')).toLowerCase();
      if (['password', 'email', 'tel'].includes(t) || /cc-|email|tel|address|password/.test(ac) ||
          /card|cvv|cvc|password|passwd|email|phone|firstname|lastname|address/.test(nm)) { sensitive = true; break; }
    }
  }
  // The checkout form: any visible login, contact or card field anywhere on the page. Its submit
  // button is often a type=button outside the <form> that submits it from JavaScript.
  let pageSensitive = false;
  for (const f of document.querySelectorAll('input,select,textarea')) {
    const r = f.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const t = (f.getAttribute('type') || '').toLowerCase();
    const ac = (f.getAttribute('autocomplete') || '').toLowerCase();
    const nm = ((f.name || '') + ' ' + (f.id || '')).toLowerCase();
    if (['password', 'email', 'tel'].includes(t) || /cc-|email|tel|street|address-line|password/.test(ac) ||
        /cardnumber|card_number|ccnumber|cvv|cvc|password|passwd|email|phonenumber|firstname|lastname|address1/.test(nm)) {
      pageSensitive = true; break;
    }
  }
  let label = '';
  if (el.labels && el.labels.length) label = clean(el.labels[0].innerText);
  return {
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute('type') || '').toLowerCase(),
    text: clean(el.innerText).slice(0, 200),
    value: ['password'].includes((el.getAttribute('type') || '').toLowerCase()) ? '' : clean(el.value || '').slice(0, 120),
    aria: clean(el.getAttribute('aria-label')),
    title: clean(el.getAttribute('title')),
    alt: clean(el.getAttribute('alt')),
    href: el.getAttribute('href') || (form && el.type === 'submit' ? form.getAttribute('action') : '') || '',
    name: el.getAttribute('name') || '',
    id: el.id || '',
    placeholder: el.getAttribute('placeholder') || '',
    autocomplete: el.getAttribute('autocomplete') || '',
    label,
    form_sensitive: sensitive,
    page_sensitive: pageSensitive,
    in_form: !!form,
  };
}
"""


class PaymentGuardRefused(RuntimeError):
    """A click or fill was refused because it is the final order/payment step or personal data."""


class SessionClosed(RuntimeError):
    """The session was closed (explicitly or by the idle timeout)."""


@dataclass
class CapturedResponse:
    url: str
    status: int
    method: str
    body: Any
    size: int
    request_data: str = ""

    def __repr__(self) -> str:
        preview = json.dumps(self.body, ensure_ascii=False)[:300] if self.body is not None else ""
        return f"<{self.method} {self.status} {self.url[:120]} {self.size}B {preview}>"


@dataclass
class Snapshot:
    url: str
    title: str
    outline: list[dict[str, Any]]
    text: str
    price_lines: list[str]
    stock_lines: list[str]
    json_count: int
    blocked: list[str] = field(default_factory=list)
    truncated: bool = False
    key_lines: list[str] = field(default_factory=list)

    def outline_text(self) -> str:
        lines: list[str] = []
        for it in self.outline:
            if it["kind"] == "heading":
                lines.append(f"{it['tag']} {it['text']}")
                continue
            ref, tag = it["ref"], it["tag"]
            flags = " (disabled)" if it.get("disabled") else ""
            if tag == "select":
                opts = " | ".join(("*" if o["selected"] else "") + o["text"] for o in it.get("options", []))
                lines.append(f"[{ref}] select {it.get('label', '')!r}: {opts}{flags}")
            elif tag in ("input", "textarea") and "text" not in it:
                state = ""
                if "checked" in it:
                    state = " [x]" if it["checked"] else " [ ]"
                val = f" = {it['value']!r}" if it.get("value") and it["type"] not in ("radio", "checkbox") else ""
                lines.append(f"[{ref}] {it['type'] or tag}{state} {it.get('label', '')!r}{val}{flags}")
            else:
                kind = it.get("role") or ("link" if tag == "a" else tag)
                href = (
                    f" -> {it['href'][:90]}" if it.get("href") and not str(it["href"]).startswith("javascript") else ""
                )
                state = f" ({it['state']})" if it.get("state") else ""
                lines.append(f"[{ref}] {kind} {it['text']!r}{state}{href}{flags}")
        return "\n".join(lines)

    def __str__(self) -> str:
        """Compact view: key lines, a trimmed outline and a text preview (see _lines for why)."""
        parts = [f"URL: {self.url}", f"title: {self.title}"]
        if self.blocked:
            parts.append(f"payment-provider requests blocked: {len(self.blocked)}")
        if self.price_lines:
            parts.append("price lines:\n  " + "\n  ".join(self.price_lines[:30]))
        other = [ln for ln in self.key_lines if ln not in self.price_lines]
        if other:
            parts.append("spec/route lines:\n  " + "\n  ".join(other[:15]))
        if self.stock_lines:
            parts.append("stock lines:\n  " + "\n  ".join(self.stock_lines[:10]))
        parts.append(f"captured JSON responses: {self.json_count} (session.json_responses())")
        outline = self.outline_text().splitlines()
        more = (
            f"\n  ... {len(outline) - OUTLINE_PREVIEW} more (snap.outline_text())"
            if len(outline) > OUTLINE_PREVIEW
            else ""
        )
        parts.append(
            "outline (click/select/fill by [ref], visible text, or selector=):\n"
            + "\n".join(outline[:OUTLINE_PREVIEW])
            + more
        )
        preview = self.text[: _lines.PREVIEW_CHARS]
        rest = len(self.text) - len(preview)
        tail = f"\n[... {rest} more chars: print(snap.text), or snap.save() for a file]" if rest > 0 else ""
        parts.append("page text (start):\n" + preview + tail)
        return "\n\n".join(parts)

    def save(self, path: str | None = None) -> str:
        """Write URL, key lines, full outline and full text to a file; returns the path."""
        body = "\n\n".join(
            [f"URL: {self.url}\ntitle: {self.title}", "\n".join(self.key_lines), self.outline_text(), self.text]
        )
        return _lines.save_text(body, path, "snapshot")

    __repr__ = __str__


@dataclass
class ActionResult:
    action: str
    target: str
    url: str
    title: str
    navigated: bool
    new_tab: bool = False
    note: str = ""

    def __str__(self) -> str:
        moved = "navigated to" if self.navigated else "still on"
        tab = " (opened in a new tab; session switched to it)" if self.new_tab else ""
        note = f" - {self.note}" if self.note else ""
        return f"{self.action} {self.target!r}: {moved} {self.url} [{self.title}]{tab}{note}"

    __repr__ = __str__


class BrowserSession:
    """A headless browser tab with its own cookies/cart. Use `async with`, or call close().

    The browser starts on the first open() and the session closes itself after `idle_timeout`
    seconds without a call, so nothing keeps running if a turn ends without close().
    """

    def __init__(
        self,
        *,
        idle_timeout: float = DEFAULT_IDLE_TIMEOUT,
        locale: str | None = None,
        timezone_id: str | None = None,
        headless: bool = True,
        **_ignored: Any,
    ) -> None:
        # headless and any headed/devtools/slow_mo option are accepted and ignored on purpose:
        # a visible window on the owner's Mac is never opened (see _browser.launch_options).
        del headless
        self.idle_timeout = idle_timeout
        self._ctx_opts = {"locale": locale, "timezone_id": timezone_id}
        self._wrapped: _browser.Context | None = None
        self._page: Any = None
        self._captured: list[CapturedResponse] = []
        self._pending: set[asyncio.Task[None]] = set()
        self._last_used = time.monotonic()
        self._watchdog: asyncio.Task[None] | None = None
        self._closed = False
        self.closed_reason = ""

    async def __aenter__(self) -> BrowserSession:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    @property
    def page(self) -> Any:
        """The underlying Playwright page, for reading only; clicks must go through click()."""
        return self._page

    @property
    def url(self) -> str:
        return self._page.url if self._page is not None else ""

    def _touch(self) -> None:
        if self._closed:
            raise SessionClosed(
                f"browser session is closed ({self.closed_reason or 'close() was called'}); "
                "open a new BrowserSession - cart state from the old one is gone"
            )
        self._last_used = time.monotonic()

    async def _ensure(self) -> None:
        self._touch()
        if self._wrapped is not None:
            return
        self._wrapped = await _browser.new_context(**self._ctx_opts)
        self._wrapped.ctx.on("page", self._on_new_page)
        self._page = await self._wrapped.ctx.new_page()
        self._attach(self._page)
        self._watchdog = asyncio.get_running_loop().create_task(self._idle_watch())

    def _on_new_page(self, page: Any) -> None:
        self._attach(page)

    def _attach(self, page: Any) -> None:
        page.on("response", self._on_response)

    def _on_response(self, response: Any) -> None:
        try:
            rtype = response.request.resource_type
            ctype = (response.headers or {}).get("content-type", "")
        except Exception:  # noqa: BLE001
            return
        # XHR/fetch bodies are parsed even without a JSON content type: many vendor price APIs
        # answer JSON as text/html or text/plain.
        if rtype not in ("xhr", "fetch") and "json" not in ctype:
            return
        task = asyncio.get_running_loop().create_task(self._capture(response))
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)

    async def _capture(self, response: Any) -> None:
        try:
            raw = await response.body()
        except Exception:  # noqa: BLE001 - body gone after navigation
            return
        if len(raw) > _MAX_JSON_BYTES:
            return
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            return
        req = response.request
        data = ""
        try:
            data = (req.post_data or "")[:500]
        except Exception:  # noqa: BLE001 - binary post data
            data = ""
        self._captured.append(
            CapturedResponse(
                url=response.url, status=response.status, method=req.method, body=body, size=len(raw), request_data=data
            )
        )
        if len(self._captured) > _MAX_CAPTURED:
            del self._captured[: len(self._captured) - _MAX_CAPTURED]

    async def _idle_watch(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(min(5.0, max(0.2, self.idle_timeout / 4)))
                if time.monotonic() - self._last_used > self.idle_timeout:
                    await self._close(f"idle for {self.idle_timeout:.0f}s", from_watchdog=True)
                    return
        except asyncio.CancelledError:
            # close() cancels this task after marking the session closed; any other cancel means
            # the event loop is ending, and the browser must not outlive it.
            if not self._closed:
                self._closed = True
                self.closed_reason = "event loop shut down"
                _browser.POOL.abandon()

    async def open(self, url: str, *, wait_for: str | None = None, wait_ms: int = 8000) -> ActionResult:
        """Go to url and wait for the page to settle (network idle, or `wait_for` selector)."""
        await self._ensure()
        resp = await self._page.goto(url, wait_until="domcontentloaded", timeout=45_000)
        await _settle(self._page, wait_for, wait_ms)
        self._touch()
        status = resp.status if resp is not None else None
        return ActionResult("open", url, self._page.url, await self._title(), True, note=f"HTTP {status}")

    async def _title(self) -> str:
        try:
            return await self._page.title()
        except Exception:  # noqa: BLE001
            return ""

    async def _locate(self, target: str | None, selector: str | None, ref: str | None, kinds: tuple[str, ...]) -> Any:
        page = self._page
        if ref:
            loc = page.locator(f'[data-wr-ref="{ref}"]')
            if await loc.count() == 0:
                raise LookupError(f"no element [{ref}] - refs change on every snapshot(); take a new snapshot")
            return loc.first
        if selector:
            loc = page.locator(selector)
            if await loc.count() == 0:
                raise LookupError(f"no element matches selector {selector!r}")
            return loc.first
        if not target:
            raise ValueError("give visible text, selector= or ref=")
        candidates = []
        for kind in kinds:
            if kind == "label":
                candidates.append(page.get_by_label(target, exact=False))
            elif kind == "placeholder":
                candidates.append(page.get_by_placeholder(target, exact=False))
            elif kind == "text":
                candidates.append(page.get_by_text(target, exact=False))
            else:
                candidates.append(page.get_by_role(kind, name=target, exact=False))
        for loc in candidates:
            n = await loc.count()
            for i in range(min(n, 10)):
                item = loc.nth(i)
                if await item.is_visible():
                    return item
        raise LookupError(f"nothing visible matches {target!r}; call snapshot() and use a [ref] or selector=")

    async def _settle_after(self, before_url: str, before_pages: int, expect_nav: float = 0.0) -> tuple[bool, bool]:
        from playwright.async_api import TimeoutError as PlaywrightTimeout

        await asyncio.sleep(0.4)
        # Submit-like controls often post over XHR first and redirect later (WHMCS "Continue"
        # spins ~2-5s before going to the cart), so give them time to leave the page.
        deadline = time.monotonic() + expect_nav
        assert self._wrapped is not None
        while self._page.url == before_url and len(self._wrapped.ctx.pages) <= before_pages:
            if time.monotonic() >= deadline:
                break
            await asyncio.sleep(0.25)
        new_tab = False
        pages = self._wrapped.ctx.pages
        if len(pages) > before_pages:
            self._page = pages[-1]
            new_tab = True
        for state, ms in (("domcontentloaded", 15_000), ("networkidle", 6_000)):
            try:
                await self._page.wait_for_load_state(state, timeout=ms)
            except PlaywrightTimeout:
                pass
        return (self._page.url != before_url or new_tab), new_tab

    async def click(
        self, target: str | None = None, *, selector: str | None = None, ref: str | None = None
    ) -> ActionResult:
        """Click by visible text (buttons, links, tabs, radios, then any text), CSS `selector`, or snapshot `ref`.

        Raises PaymentGuardRefused for the final order/payment step (pay, place/submit/complete
        order, 支付, 提交订单, 立即付款 ...), payment-provider links, and submits of forms holding
        login or personal fields.
        """
        await self._ensure()
        loc = await self._locate(
            target, selector, ref, ("button", "link", "tab", "radio", "checkbox", "option", "text")
        )
        info = await loc.evaluate(_ELEMENT_INFO_JS)
        refusal = _guard.click_refusal(info)
        if refusal:
            raise PaymentGuardRefused(refusal)
        before_url, before_pages = self._page.url, len(self._wrapped.ctx.pages) if self._wrapped else 1
        await loc.scroll_into_view_if_needed(timeout=5000)
        from playwright.async_api import Error as PlaywrightError

        try:
            await loc.click(timeout=6_000)
        except PlaywrightError as exc:
            if "intercepts pointer events" not in str(exc):
                raise
            # Styled radios/checkboxes (iCheck and similar) lay a helper element over the real
            # input; clicking the input's own label is what a person does and what those widgets
            # listen to. Without a label the event goes to the element the guard checked.
            label = await self._label_for(loc, str(info.get("id") or ""))
            if label is not None:
                await label.click(timeout=6_000)
            else:
                await loc.dispatch_event("click")
        href = str(info.get("href") or "")
        leaves = (
            (info.get("tag") == "a" and bool(href) and not href.startswith(("#", "javascript")))
            or info.get("type") == "submit"
            or (info.get("tag") == "button" and info.get("in_form"))
        )
        navigated, new_tab = await self._settle_after(before_url, before_pages, NAV_WAIT_SECONDS if leaves else 0.0)
        self._touch()
        label = target or selector or ref or ""
        return ActionResult("click", label, self._page.url, await self._title(), navigated, new_tab)

    async def _label_for(self, loc: Any, element_id: str) -> Any:
        candidates = [loc.locator("xpath=ancestor::label[1]")]
        if element_id:
            candidates.insert(0, self._page.locator(f'label[for="{element_id}"]'))
        for cand in candidates:
            if await cand.count() and await cand.first.is_visible():
                return cand.first
        return None

    async def select(
        self, target: str | None, option: str, *, selector: str | None = None, ref: str | None = None
    ) -> ActionResult:
        """Choose `option` (visible text or value) in a <select> found by label, selector or ref.

        For styled dropdowns that are not a real <select>, click() the dropdown and then the option.
        """
        await self._ensure()
        loc = await self._locate(target, selector, ref, ("label", "combobox"))
        tag = await loc.evaluate("el => el.tagName.toLowerCase()")
        if tag != "select":
            raise LookupError(f"{target or selector or ref!r} is a <{tag}>, not a <select>; use click() on it instead")
        options = await loc.evaluate("el => Array.from(el.options).map(o => [o.text.trim(), o.value])")
        chosen = None
        for text, value in options:
            if option == value or option.strip().lower() == text.lower():
                chosen = value
                break
        if chosen is None:
            for text, value in options:
                if option.strip().lower() in text.lower():
                    chosen = value
                    break
        if chosen is None:
            raise LookupError(f"no option {option!r}; available: {[t for t, _ in options][:30]}")
        before_url, before_pages = self._page.url, len(self._wrapped.ctx.pages) if self._wrapped else 1
        await loc.select_option(value=chosen, timeout=10_000)
        navigated, new_tab = await self._settle_after(before_url, before_pages)
        self._touch()
        return ActionResult(
            "select", f"{target or selector or ref} = {option}", self._page.url, await self._title(), navigated, new_tab
        )

    async def fill(
        self, target: str | None, value: str, *, selector: str | None = None, ref: str | None = None
    ) -> ActionResult:
        """Type into a quote-shaping field (quantity, coupon/promo code, hostname, search box).

        Raises PaymentGuardRefused for anything that may be a login or personal data (password,
        email, phone, name, address, card, ID, captcha answer...). Does not press Enter.
        """
        await self._ensure()
        loc = await self._locate(target, selector, ref, ("label", "placeholder", "textbox", "spinbutton"))
        info = await loc.evaluate(_ELEMENT_INFO_JS)
        refusal = _guard.fill_refusal(info)
        if refusal:
            raise PaymentGuardRefused(refusal)
        await loc.fill(str(value), timeout=10_000)
        self._touch()
        return ActionResult(
            "fill", f"{target or selector or ref} = {value}", self._page.url, await self._title(), False
        )

    async def wait(self, seconds: float = 2.0, *, selector: str | None = None, text: str | None = None) -> None:
        """Wait a fixed time, or until `selector` / `text` is visible (max `seconds` then)."""
        await self._ensure()
        from playwright.async_api import TimeoutError as PlaywrightTimeout

        try:
            if selector:
                await self._page.wait_for_selector(selector, state="visible", timeout=seconds * 1000)
            elif text:
                await self._page.get_by_text(text, exact=False).first.wait_for(state="visible", timeout=seconds * 1000)
            else:
                await self._page.wait_for_timeout(seconds * 1000)
        except PlaywrightTimeout:
            pass
        self._touch()

    async def back(self) -> ActionResult:
        await self._ensure()
        await self._page.go_back(wait_until="domcontentloaded", timeout=20_000)
        self._touch()
        return ActionResult("back", "", self._page.url, await self._title(), True)

    async def snapshot(self, *, max_chars: int = 12_000, max_items: int = 250) -> Snapshot:
        """What the page shows now: price and stock lines, a clickable outline with [ref]s, and the text."""
        await self._ensure()
        outline = await self._page.evaluate(_OUTLINE_JS, max_items)
        text = await _inner_text(self._page)
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        clean = "\n".join(lines)
        keys = _lines.key_lines(clean, limit=80)
        prices = [ln for ln in keys if _lines.PRICE.search(ln)]
        stock = [ln for ln in keys if _lines.STOCK.search(ln)]
        await asyncio.sleep(0)  # let queued response captures land
        self._touch()
        return Snapshot(
            url=self._page.url,
            title=await self._title(),
            outline=outline,
            text=clean[:max_chars],
            price_lines=prices,
            stock_lines=stock,
            json_count=len(self._captured),
            blocked=list(self._wrapped.blocked) if self._wrapped else [],
            truncated=len(clean) > max_chars,
            key_lines=keys,
        )

    def json_responses(
        self, contains: str | None = None, *, url_contains: str | None = None, limit: int = 20
    ) -> list[CapturedResponse]:
        """JSON bodies of XHR/fetch responses seen so far, newest last. Vendor price APIs often live here.

        contains: keep responses whose URL or body text contains this (case-insensitive), e.g. "price".
        """
        self._touch()
        out = self._captured
        if url_contains:
            out = [r for r in out if url_contains.lower() in r.url.lower()]
        if contains:
            needle = contains.lower()
            out = [
                r for r in out if needle in r.url.lower() or needle in json.dumps(r.body, ensure_ascii=False).lower()
            ]
        return out[-limit:]

    async def screenshot(self, path: str | None = None, *, full_page: bool = True) -> str:
        """Save a PNG and return its path (default: a temp file). Useful as evidence next to the price."""
        await self._ensure()
        if path is None:
            folder = os.path.join(tempfile.gettempdir(), "web_research")
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, f"shot-{int(time.time() * 1000)}.png")
        await self._page.screenshot(path=path, full_page=full_page, timeout=30_000)
        self._touch()
        return path

    async def html(self) -> str:
        await self._ensure()
        return await self._page.content()

    async def close(self) -> None:
        await self._close("close() was called")

    async def _close(self, reason: str, from_watchdog: bool = False) -> None:
        if self._closed:
            return
        self._closed = True
        self.closed_reason = reason
        if self._watchdog is not None and not from_watchdog:
            self._watchdog.cancel()
        for task in list(self._pending):
            task.cancel()
        if self._wrapped is not None:
            await _browser.close_context(self._wrapped)
            self._wrapped = None
        self._page = None


@dataclass
class BrowseResult:
    url: str
    steps: list[str]
    snapshot: Snapshot | None
    json: list[CapturedResponse]
    screenshot: str | None
    stopped: str = ""
    error: str = ""

    def __str__(self) -> str:
        head = [f"browse {self.url}"] + [f"  {s}" for s in self.steps]
        if self.stopped:
            head.append(f"STOPPED BY GUARD: {self.stopped}")
        if self.error:
            head.append(f"ERROR: {self.error}")
        if self.screenshot:
            head.append(f"screenshot: {self.screenshot}")
        return "\n".join(head) + ("\n\n" + str(self.snapshot) if self.snapshot else "")

    __repr__ = __str__


async def browse(
    url: str,
    steps: list[Any] | tuple[Any, ...] = (),
    *,
    screenshot: bool | str = False,
    json_contains: str | None = None,
    wait_for: str | None = None,
    locale: str | None = None,
) -> BrowseResult:
    """One-shot scripted visit: open url, run steps, snapshot, close. Never raises for a step.

    steps: ("click", "Order Now"), ("select", "Billing Cycle", "Annually"), ("fill", "Quantity", "2"),
      ("wait", 2) or ("wait", "#total"), ("open", other_url); dicts like {"click": "Order Now"} work too.
    A guard refusal stops the script and is reported in `.stopped`; the snapshot is taken where it stopped.
    """
    log: list[str] = []
    stopped = error = ""
    shot: str | None = None
    snap: Snapshot | None = None
    captured: list[CapturedResponse] = []
    async with BrowserSession(locale=locale) as s:
        try:
            log.append(str(await s.open(url, wait_for=wait_for)))
            for raw in steps:
                step = _normalize_step(raw)
                verb, args = step[0], step[1:]
                if verb == "click":
                    log.append(str(await s.click(str(args[0]))))
                elif verb == "select":
                    log.append(str(await s.select(str(args[0]), str(args[1]))))
                elif verb == "fill":
                    log.append(str(await s.fill(str(args[0]), str(args[1]))))
                elif verb == "wait":
                    arg = args[0] if args else 2
                    if isinstance(arg, (int, float)):
                        await s.wait(float(arg))
                    else:
                        await s.wait(10, selector=str(arg))
                    log.append(f"wait {arg!r}")
                elif verb == "open":
                    log.append(str(await s.open(str(args[0]))))
                else:
                    raise ValueError(f"unknown step {verb!r}")
        except PaymentGuardRefused as exc:
            stopped = str(exc)
        except Exception as exc:  # noqa: BLE001 - reported with the snapshot of where it failed
            error = f"{type(exc).__name__}: {exc}"
        try:
            snap = await s.snapshot()
            captured = s.json_responses(json_contains)
            if screenshot:
                shot = await s.screenshot(screenshot if isinstance(screenshot, str) else None)
        except Exception as exc:  # noqa: BLE001
            error = error or f"{type(exc).__name__}: {exc}"
    return BrowseResult(url=url, steps=log, snapshot=snap, json=captured, screenshot=shot, stopped=stopped, error=error)


def _normalize_step(raw: Any) -> tuple[Any, ...]:
    if isinstance(raw, dict):
        if len(raw) != 1:
            raise ValueError(f"step dict needs exactly one key: {raw!r}")
        verb, arg = next(iter(raw.items()))
        return (verb, *arg) if isinstance(arg, (list, tuple)) else (verb, arg)
    if isinstance(raw, (list, tuple)) and raw:
        return tuple(raw)
    raise ValueError(f"bad step {raw!r}")
