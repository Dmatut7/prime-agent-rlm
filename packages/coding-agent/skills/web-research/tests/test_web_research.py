"""Offline tests for web_research against a local fixture site. Run with the kernel venv's python:

    <kernel-venv>/bin/python -m unittest discover -s tests -v

The browser tests need Chrome Headless Shell (installed on first use) and are skipped when
WEB_RESEARCH_SKIP_BROWSER=1.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import web_research as wr  # noqa: E402
from web_research import _browser, _guard, _lines, _net  # noqa: E402

SKIP_BROWSER = os.environ.get("WEB_RESEARCH_SKIP_BROWSER") == "1"
ARTICLE = "<p>" + ("Structured concurrency keeps every child task inside a scope. " * 20) + "</p>"

PAGES: dict[str, tuple[int, str, str]] = {
    "/static": (
        200,
        "text/html",
        f"""<html><head><title>Static Doc</title></head><body><nav>Home | Docs</nav><article>
        <h1>TaskGroup guide</h1>{ARTICLE}
        <table><tr><th>Plan</th><th>RAM</th><th>Price</th></tr>
        <tr><td>Small</td><td>1 GB</td><td>$4.99/mo</td></tr>
        <tr><td>Large</td><td>4 GB</td><td>$19.99/mo</td></tr></table></article></body></html>""",
    ),
    "/js": (
        200,
        "text/html",
        """<html><head><title>JS Pricing</title></head><body><div id="root"></div>
        <script>fetch('/api/plans').then(r => r.json()).then(d => {
          document.getElementById('root').innerHTML = '<h1>Plans</h1>' + d.plans.map(p =>
            '<p>' + p.name + ' costs $' + p.price + ' per month with ' + p.ram + ' of memory and generous bandwidth ' +
            'on a premium CN2 GIA route to mainland China, renewing at the same price every month.</p>').join('');
        });</script><script></script><script></script></body></html>""",
    ),
    "/jsprice": (
        200,
        "text/html",
        f"""<html><head><title>Plans</title></head><body><article><h1>Our plans</h1>{ARTICLE}
        <p id="p">Price: loading</p></article>
        <script>setTimeout(() => {{ document.getElementById('p').textContent = 'Price: $7.50/mo'; }}, 300);</script>
        </body></html>""",
    ),
    "/api/plans": (
        200,
        "application/json",
        json.dumps(
            {
                "plans": [
                    {"name": n, "price": p, "ram": r}
                    for n, p, r in [("Nano", 3, "512MB"), ("Micro", 5, "1GB"), ("Mega", 9, "2GB")]
                ]
            }
        ),
    ),
    "/challenge": (
        403,
        "text/html",
        """<html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget">
        Checking your browser before accessing the site.</div><script src="/cdn-cgi/challenge-platform/x.js"></script></body></html>""",
    ),
    "/login": (
        200,
        "text/html",
        """<html><head><title>Client Login</title></head><body><h1>Please log in</h1>
        <form action="/dologin" method="post"><input name="username"><input type="password" name="password">
        <button type="submit">Login</button></form></body></html>""",
    ),
    "/shop": (
        200,
        "text/html",
        """<html><head><title>HK CN2 VPS</title></head><body><h1>Hong Kong CN2 GIA VPS</h1>
        <p>From $5.99/mo when paid annually. Renews at $9.99/mo.</p>
        <a href="/configure">Order Now</a> <a href="https://www.paypal.com/checkoutnow?token=x">Pay with PayPal</a>
        </body></html>""",
    ),
    "/configure": (
        200,
        "text/html",
        """<html><head><title>Configure</title><style>.hidden{position:absolute;opacity:0;width:0;height:0}</style></head><body>
        <h2>Configure your server</h2>
        <label for="cycle">Billing Cycle</label>
        <select id="cycle" name="billingcycle" onchange="quote()">
          <option value="monthly">Monthly $9.99</option><option value="annually">Annually $71.88</option></select>
        <label for="qty">Quantity</label><input id="qty" name="qty" type="number" value="1" onchange="quote()">
        <label for="promo">Promo Code</label><input id="promo" name="promocode">
        <label for="mail">Email Address</label><input id="mail" name="email" type="email">
        <label for="fname">First Name</label><input id="fname" name="firstname">
        <input type="radio" class="hidden" id="loc-hk" name="loc" value="hk"><label for="loc-hk">Hong Kong</label>
        <div id="price">Total Due Today: $9.99</div>
        <a href="/cart" id="continue">Continue</a>
        <script>
        function quote() {
          const c = document.getElementById('cycle').value, q = document.getElementById('qty').value;
          fetch('/api/quote?cycle=' + c + '&qty=' + q).then(r => r.json()).then(d => {
            document.getElementById('price').textContent = 'Total Due Today: $' + d.total + ' (setup fee $' + d.setup + ')';
          });
        }
        </script></body></html>""",
    ),
    "/cart": (
        200,
        "text/html",
        """<html><head><title>Shopping Cart</title></head><body><h1>Review &amp; Checkout</h1>
        <table><tr><td>HK CN2 GIA 1GB (Annually)</td><td>$71.88 USD</td></tr>
        <tr><td>Setup Fee</td><td>$5.00 USD</td></tr><tr><td>Recurring: $9.99 USD Monthly after first term</td></tr>
        <tr><td>Total Due Today</td><td>$76.88 USD</td></tr></table>
        <a href="/checkout">Checkout</a></body></html>""",
    ),
    "/checkout": (
        200,
        "text/html",
        """<html><head><title>Checkout</title></head><body><h1>Checkout</h1><p>Total Due Today $76.88 USD</p>
        <form action="/place-order" method="post"><label for="e">Email</label><input id="e" type="email" name="email">
        <label for="p">Password</label><input id="p" type="password" name="password">
        <button type="submit">Complete Order</button><button type="submit" id="plain">Next</button></form>
        <button id="paynow">立即付款</button>
        <button type="button" id="jscheckout" onclick="document.forms[0].submit()">结账</button>
        <button type="button" id="apply">Apply Coupon</button></body></html>""",
    ),
}


class _Handler(BaseHTTPRequestHandler):
    posts: list[str] = []
    hits: list[str] = []

    def log_message(self, *args: object) -> None:
        pass

    def _send(self, status: int, ctype: str, body: str) -> None:
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        parts = urlsplit(self.path)
        _Handler.hits.append(parts.path)
        if parts.path == "/api/quote":
            q = parse_qs(parts.query)
            cycle, qty = q.get("cycle", ["monthly"])[0], int(q.get("qty", ["1"])[0])
            total = round((71.88 if cycle == "annually" else 9.99) * qty + 5, 2)
            # text/plain on purpose: vendor APIs often mislabel JSON
            self._send(
                200,
                "text/plain",
                json.dumps({"cycle": cycle, "qty": qty, "total": total, "setup": 5, "price": total - 5}),
            )
            return
        if parts.path == "/search":
            q = parse_qs(parts.query)
            payload = {
                "results": [
                    {
                        "title": "Echo " + q["q"][0],
                        "url": "https://example.com/a",
                        "content": "  snippet   text ",
                        "engine": "google",
                        "engines": ["google", "yahoo"],
                        "publishedDate": "2026-09-01T00:00:00",
                    },
                    {
                        "title": "Second",
                        "url": "https://www.example.org/b",
                        "content": "",
                        "engine": "yandex",
                        "engines": ["yandex"],
                    },
                ],
                "unresponsive_engines": [["brave", "too many requests"]],
                "suggestions": ["alt query"],
                "echo": {k: v[0] for k, v in q.items()},
            }
            self._send(200, "application/json", json.dumps(payload))
            return
        page = PAGES.get(parts.path)
        if page is None:
            self._send(404, "text/html", "<html><title>Not Found</title><body>nope</body></html>")
            return
        self._send(*page)

    def do_POST(self) -> None:  # noqa: N802
        _Handler.posts.append(self.path)
        self._send(200, "text/html", "<html><body>order placed</body></html>")


def _start_server() -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def _headless_processes() -> list[str]:
    """Browser processes started by this test process (other agents may run their own browsers)."""
    out = subprocess.run(["ps", "-Ao", "pid=,ppid=,command="], capture_output=True, text=True).stdout
    rows = [ln.strip().split(None, 2) for ln in out.splitlines() if ln.strip()]
    children: dict[str, list[tuple[str, str]]] = {}
    for pid, ppid, cmd in (r for r in rows if len(r) == 3):
        children.setdefault(ppid, []).append((pid, cmd))
    found, stack = [], [str(os.getpid())]
    while stack:
        for pid, cmd in children.get(stack.pop(), []):
            stack.append(pid)
            if "chrome-headless-shell" in cmd or "Chromium" in cmd or "Google Chrome" in cmd:
                found.append(cmd)
    return found


class GuardTests(unittest.TestCase):
    def test_final_submit_labels_are_refused(self) -> None:
        refused = [
            "Complete Order",
            "Place Order",
            "Submit order",
            "Pay Now",
            "Pay $76.88",
            "Confirm and Pay",
            "Proceed to Payment",
            "Confirm Purchase",
            "支付",
            "立即付款",
            "提交订单",
            "确认支付",
            "去支付",
            "立即下单",
        ]
        self.assertTrue(refused)
        for label in refused:
            with self.subTest(label=label):
                self.assertIsNotNone(_guard.click_refusal({"text": label, "tag": "button"}))

    def test_navigation_toward_the_price_is_allowed(self) -> None:
        allowed = [
            "Order Now",
            "Buy Now",
            "Checkout",
            "Continue",
            "Add to Cart",
            "Pay yearly and save 20%",
            "Annually",
            "付款周期",
            "年付",
            "立即购买",
            "加入购物车",
            "下一步",
            "结算",
            "Configure",
        ]
        self.assertTrue(allowed)
        for label in allowed:
            with self.subTest(label=label):
                self.assertIsNone(_guard.click_refusal({"text": label, "tag": "a"}))

    def test_payment_links_and_sensitive_form_submits_are_refused(self) -> None:
        self.assertIsNotNone(_guard.click_refusal({"text": "PayPal", "tag": "a", "href": "https://www.paypal.com/x"}))
        self.assertIsNotNone(_guard.click_refusal({"text": "Next", "tag": "button", "form_sensitive": True}))
        self.assertIsNone(_guard.click_refusal({"text": "Next", "tag": "button", "form_sensitive": False}))
        self.assertIsNotNone(
            _guard.click_refusal({"text": "结账", "tag": "button", "type": "button", "page_sensitive": True})
        )
        self.assertIsNotNone(
            _guard.click_refusal({"text": "Checkout", "tag": "a", "href": "#", "page_sensitive": True})
        )
        self.assertIsNone(_guard.click_refusal({"text": "Apply", "tag": "button", "page_sensitive": True}))
        self.assertIsNone(
            _guard.click_refusal({"text": "Continue", "tag": "a", "href": "/cart", "page_sensitive": True})
        )
        self.assertIsNone(_guard.click_refusal({"text": "结账", "tag": "button", "page_sensitive": False}))

    def test_fill_allows_only_quote_shaping_fields(self) -> None:
        self.assertIsNone(_guard.fill_refusal({"label": "Quantity", "type": "number"}))
        self.assertIsNone(_guard.fill_refusal({"label": "Promo Code", "name": "promocode"}))
        self.assertIsNone(_guard.fill_refusal({"label": "Hostname", "name": "hostname"}))
        self.assertIsNone(_guard.fill_refusal({"label": "优惠码"}))
        for info in (
            {"label": "Email Address", "type": "email"},
            {"label": "Password", "type": "password"},
            {"label": "First Name", "name": "firstname"},
            {"label": "Root Password", "name": "rootpw"},
            {"label": "手机号码"},
            {"label": "Card number", "autocomplete": "cc-number"},
            {"label": "Captcha", "name": "captcha"},
            {"label": "Notes"},
        ):
            with self.subTest(info=info):
                self.assertIsNotNone(_guard.fill_refusal(info))


class CompactOutputTests(unittest.TestCase):
    def test_key_lines_join_bare_amounts_to_their_label(self) -> None:
        text = "Plans\n每年 (8折优惠)\n845.00元\n2核 CPU\n香港三网直连 CN2 线路\nSold out\nAbout us\nTotal Due Today:\n$49.99 USD"
        self.assertEqual(
            _lines.key_lines(text),
            [
                "每年 (8折优惠) | 845.00元",
                "2核 CPU",
                "香港三网直连 CN2 线路",
                "Sold out",
                "Total Due Today: | $49.99 USD",
            ],
        )

    def test_fetch_result_prints_compactly_and_saves_full_text(self) -> None:
        body = "Intro line\nKVM 2GB RAM\nPrice $5.00/mo\n" + ("filler text about DDoS protection " * 400)
        res = wr.FetchResult(
            url="https://x.example", ok=True, tier="http", status=200, content=body, content_mode="main"
        )
        printed = str(res)
        self.assertLess(len(printed), 2600)
        self.assertIn("key lines (price/spec/route/stock):\n  KVM 2GB RAM\n  Price $5.00/mo", printed)
        self.assertIn("more chars: print(page.content), or page.save()", printed)
        path = res.save()
        self.assertIn(body, Path(path).read_text(encoding="utf-8"))
        os.remove(path)


class HeadlessTests(unittest.TestCase):
    def test_launch_options_force_headless(self) -> None:
        self.assertIs(_browser.launch_options()["headless"], True)
        self.assertIs(_browser.launch_options(headless=False, devtools=True)["headless"], True)
        self.assertNotIn("devtools", _browser.launch_options(devtools=True))
        wr.BrowserSession(headless=False, slow_mo=500)  # accepted and ignored, not an error

    def test_pwdebug_is_scrubbed(self) -> None:
        os.environ["PWDEBUG"] = "1"
        _browser._scrub_headed_env()
        self.assertNotIn("PWDEBUG", os.environ)


class ProxyRoutingTests(unittest.TestCase):
    def test_loopback_goes_direct_and_outbound_uses_the_proxy(self) -> None:
        old = {k: os.environ.get(k) for k in ("HTTPS_PROXY", "NO_PROXY")}
        try:
            os.environ["HTTPS_PROXY"] = "http://proxy.invalid:3128"
            os.environ["NO_PROXY"] = "internal.example"
            self.assertIsNone(_net.proxy_for("http://127.0.0.1:18888/search"))
            self.assertIsNone(_net.proxy_for("http://localhost/x"))
            self.assertIsNone(_net.proxy_for("https://api.internal.example/x"))
            self.assertEqual(_net.proxy_for("https://www.racknerd.com/"), "http://proxy.invalid:3128")
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


class LocalSiteTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server, cls.base = _start_server()
        # A dead proxy proves loopback traffic never goes through the environment proxy.
        cls._old_proxy = os.environ.get("HTTPS_PROXY"), os.environ.get("HTTP_PROXY")
        os.environ["HTTPS_PROXY"] = os.environ["HTTP_PROXY"] = "http://127.0.0.1:9"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        for name, value in zip(("HTTPS_PROXY", "HTTP_PROXY"), cls._old_proxy, strict=False):
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    async def asyncTearDown(self) -> None:
        await wr.shutdown_browser()

    async def test_search_normalizes_results_and_bypasses_proxy(self) -> None:
        os.environ["WEB_RESEARCH_SEARXNG_URL"] = self.base
        try:
            res = await wr.search(
                "hk vps", categories=["it", "general"], engines="google", time_range="week", max_results=5
            )
        finally:
            os.environ.pop("WEB_RESEARCH_SEARXNG_URL")
        self.assertEqual(len(res), 2)
        first = res[0]
        self.assertEqual(first["snippet"], "snippet text")
        self.assertEqual(first["engines"], ["google", "yahoo"])
        self.assertEqual(first["published"], "2026-09-01")
        self.assertEqual(res[1]["domain"], "example.org")
        self.assertEqual(res.unresponsive, ["brave"])
        self.assertIn("1. Echo hk vps [2026-09-01] (google/yahoo)", str(res))
        self.assertIn("engines that failed this time: brave", str(res))

    async def test_search_down_says_how_to_start_it(self) -> None:
        os.environ["WEB_RESEARCH_SEARXNG_URL"] = "http://127.0.0.1:1"
        try:
            with self.assertRaises(wr.SearchUnavailable) as ctx:
                await wr.search("anything")
        finally:
            os.environ.pop("WEB_RESEARCH_SEARXNG_URL")
        self.assertIn("docker start prime-searxng", str(ctx.exception))

    async def test_static_page_stays_on_http_tier_with_table(self) -> None:
        res = await wr.fetch(self.base + "/static", archive=False)
        self.assertTrue(res.ok, str(res))
        self.assertEqual(res.tier, "http")
        self.assertEqual(res.title, "Static Doc")
        self.assertIn("| Small | 1 GB | $4.99/mo |", res.content)
        self.assertFalse(wr.browser_running())

    async def test_not_found_does_not_launch_a_browser(self) -> None:
        res = await wr.fetch(self.base + "/missing", archive=False)
        self.assertFalse(res.ok)
        self.assertEqual([a["tier"] for a in res.attempts], ["http"])
        self.assertIn("not found", res.reason)

    async def test_render_never_reports_js_shell(self) -> None:
        res = await wr.fetch(self.base + "/js", render="never", archive=False)
        self.assertFalse(res.ok)
        self.assertIn("js-shell", res.attempts[0]["reason"])

    @unittest.skipIf(SKIP_BROWSER, "WEB_RESEARCH_SKIP_BROWSER=1")
    async def test_expect_escalates_when_prices_are_filled_by_javascript(self) -> None:
        plain = await wr.fetch(self.base + "/jsprice", archive=False)
        self.assertEqual(plain.tier, "http")
        self.assertNotIn("$7.50", plain.content)
        res = await wr.fetch(self.base + "/jsprice", archive=False, expect=r"\$\d")
        self.assertEqual(res.tier, "browser", str(res))
        self.assertIn("$7.50/mo", res.content)

    @unittest.skipIf(SKIP_BROWSER, "WEB_RESEARCH_SKIP_BROWSER=1")
    async def test_js_page_escalates_to_browser(self) -> None:
        res = await wr.fetch(self.base + "/js", archive=False)
        self.assertTrue(res.ok, str(res))
        self.assertEqual(res.tier, "browser")
        self.assertEqual([a["tier"] for a in res.attempts], ["http", "browser"])
        self.assertIn("Micro costs $5 per month", res.content)

    @unittest.skipIf(SKIP_BROWSER, "WEB_RESEARCH_SKIP_BROWSER=1")
    async def test_challenge_and_login_walls_need_a_human(self) -> None:
        res = await wr.fetch(self.base + "/challenge", archive=False)
        self.assertFalse(res.ok)
        self.assertTrue(res.needs_human)
        self.assertIn("captcha", res.reason)
        self.assertEqual(res.content, "")
        self.assertIn("NEEDS A HUMAN", str(res))
        res = await wr.fetch(self.base + "/login", archive=False)
        self.assertTrue(res.needs_human)
        self.assertIn("login wall", res.reason)

    @unittest.skipIf(SKIP_BROWSER, "WEB_RESEARCH_SKIP_BROWSER=1")
    async def test_order_flow_reaches_cart_and_stops_before_payment(self) -> None:
        _Handler.posts.clear()
        async with wr.BrowserSession() as b:
            await b.open(self.base + "/shop")
            procs = _headless_processes()
            self.assertTrue(procs, "a headless shell process should be running during the session")
            self.assertTrue(all("--headless" in p for p in procs if "--type=" not in p), procs)
            with self.assertRaises(wr.PaymentGuardRefused):
                await b.click("Pay with PayPal")
            step = await b.click("Order Now")
            self.assertTrue(step.navigated)
            self.assertTrue(b.url.endswith("/configure"))
            await b.select("Billing Cycle", "Annually")
            await b.fill("Quantity", "2")
            await b.fill("Promo Code", "SAVE10")
            with self.assertRaises(wr.PaymentGuardRefused):
                await b.fill("Email Address", "someone@example.com")
            with self.assertRaises(wr.PaymentGuardRefused):
                await b.fill("First Name", "Alice")
            await b.click("Hong Kong")
            await b.wait(5, text="setup fee")
            snap = await b.snapshot()
            self.assertIn("Total Due Today: $148.76 (setup fee $5)", snap.price_lines)
            self.assertIn("price lines:", str(snap))
            saved = snap.save()
            self.assertIn("Total Due Today: $148.76", Path(saved).read_text(encoding="utf-8"))
            os.remove(saved)
            hk = [ln for ln in snap.outline_text().splitlines() if "Hong Kong" in ln and ln.startswith("[")]
            self.assertEqual(len(hk), 1, snap.outline_text())
            self.assertIn("(checked)", hk[0])
            quotes = b.json_responses("total")
            self.assertTrue(quotes, "the quote XHR (sent as text/plain) should be captured")
            self.assertEqual(quotes[-1].body["cycle"], "annually")
            self.assertEqual(quotes[-1].body["qty"], 2)
            await b.click("Continue")
            cart = await b.snapshot()
            self.assertIn("Total Due Today | $76.88 USD", cart.text.replace("\t", " | "))
            await b.click("Checkout")
            with self.assertRaises(wr.PaymentGuardRefused):
                await b.click("Complete Order")
            with self.assertRaises(wr.PaymentGuardRefused):
                await b.click(selector="#plain")  # harmless label, but it submits a login/personal form
            with self.assertRaises(wr.PaymentGuardRefused):
                await b.click("立即付款")
            with self.assertRaises(wr.PaymentGuardRefused):
                await b.click("结账")  # type=button outside the form that submits it from JS
            await b.click("Apply Coupon")  # cart-only buttons on the checkout page stay clickable
            shot = await b.screenshot()
            self.assertGreater(Path(shot).stat().st_size, 1000)
        self.assertEqual(_Handler.posts, [], "no order form may ever be submitted")

    @unittest.skipIf(SKIP_BROWSER, "WEB_RESEARCH_SKIP_BROWSER=1")
    async def test_browse_script_reports_guard_stop(self) -> None:
        res = await wr.browse(self.base + "/checkout", [("click", "Complete Order")])
        self.assertIn("final order/payment step", res.stopped)
        self.assertIsNotNone(res.snapshot)
        self.assertIn("Checkout", res.snapshot.title)

    @unittest.skipIf(SKIP_BROWSER, "WEB_RESEARCH_SKIP_BROWSER=1")
    async def test_idle_session_closes_and_browser_exits(self) -> None:
        b = wr.BrowserSession(idle_timeout=1)
        await b.open(self.base + "/static")
        self.assertTrue(wr.browser_running())
        await asyncio.sleep(3)
        with self.assertRaises(wr.SessionClosed):
            await b.snapshot()
        await asyncio.wait_for(self._wait_browser_gone(), timeout=_browser.LINGER_SECONDS + 15)
        self.assertEqual(_headless_processes(), [])

    async def _wait_browser_gone(self) -> None:
        while wr.browser_running() or _headless_processes():
            await asyncio.sleep(0.5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
