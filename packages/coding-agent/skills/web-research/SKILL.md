---
name: web-research
description: Research the live web from the kernel - search through the owner's local SearXNG container, reading exact page content (docs, pricing tables, PDFs), headless click-through to a vendor's real cart/order price (stops before payment), and free paper/Q&A APIs (arXiv, Crossref, OpenAlex, Stack Exchange, GitHub). Use for VPS/cloud price comparisons, docs lookups and technical research. No API key needed; search() needs Docker and the SearXNG container running (bailian_web_search is the fallback when it is not), everything else only needs the network.
---

# Web Research

The kernel binds this skill as `web_research`. Every function is async, so call it with `await`:

    results = await web_research.search("香港 CN2 GIA VPS 价格")
    page = await web_research.fetch("https://docs.python.org/3/library/asyncio-task.html")
    print(results); print(page)

Printing any result gives a compact view; the objects also carry structured fields.

## Keep page text out of the conversation

`print(page)` and `print(snapshot)` show the price, spec, route and stock lines first (amounts of
money first when a page has more than fit), then only the first ~1500 characters of the page with a
`[TRUNCATED: ...]` marker saying how much is left. The whole page stays in `page.content` /
`snap.text`, however long it is, and `page.save()` / `snap.save()` write it all to a file and return
the path; `page.key_lines` / `snap.price_lines` list every matching line of the whole page. Keep
the printing that way: a full vendor page costs thousands of tokens, and on Bailian models it can
end the turn. Measured 2026-09-25 in six parallel VPS research subagents: raw vendor text (full of
DDoS, firewall and protection wording) made the provider answer `400 data_inspection_failed`, the
turn could not be retried and the subagent died. When you need more than the key lines, save the
page and pull out just the lines you need with Python (`page.key_lines`, a regex over
`page.content`), printing a few hundred characters rather than the page.

## Which tool, and why

- **Prefer this over `bailian_web_search` whenever the exact page matters** (a price, a spec
  table, a docs signature). Bailian returns a model's summary without source URLs and has been
  seen attributing facts to the wrong vendor; here you read the page itself and keep its URL.
- **Prefer this over visible-browser skills (such as ego-browser) unless the user asked to
  watch.** Everything here is headless: no window opens and nothing takes focus on the owner's
  Mac, so they can keep working while you research.

### `search(query, *, categories=None, engines=None, max_results=10, language=None, time_range=None)`

Runs through the local SearXNG container (`prime-searxng` on port 18888), which merges Google, Yahoo, Yandex and Brave (plus
Naver and Wikipedia). Each result is a dict with `title`, `url`, `domain`, `snippet`, `engine`,
`engines`, `published`. `categories="it"` searches GitHub, Stack Overflow, MDN, PyPI and npm;
`"science"` searches arXiv, Crossref, OpenAlex and Google Scholar; `"news"` is thin (Yahoo News only).
`time_range` is `"day"`, `"week"`, `"month"` or `"year"`.

Search engines disagree and snippets are often months old, so treat a result as a lead, not a
fact. A result listed with several engines (`google/yahoo/yandex`) was found independently more
than once; one seen by a single engine deserves a second look. To cross-check, run the query
again with `engines="google"` and `engines="yandex"`, or in the other language. A search takes
2-6 s. `results.unresponsive` names engines that failed that time. Engines punish bursts: after a
few hundred test queries on 2026-09-25 Google answered with a CAPTCHA and SearXNG parked it for an
hour (Brave rate-limits sooner), while Yahoo and Yandex kept answering. So search with purpose,
a handful of well-chosen queries rather than a loop over dozens of variants.

That container was set up by hand on the owner's Mac; nothing in prime-agent creates or starts
it, and its engines are all foreign sites. So search can be down in two ways, and both raise
`web_research.SearchUnavailable` (message starts `搜索服务不可用`) instead of returning an empty list:

- SearXNG does not answer. The message has already checked Docker and says which case it is:
  Docker not running (usual after a reboot: `open -a Docker`, wait until `docker info` answers,
  then `docker start prime-searxng`), the container stopped (`docker start prime-searxng`), or
  the container missing (tell the owner search needs it set up).
- SearXNG answers but every engine failed and nothing came back: the VPN/proxy is off or the
  network is down (or the engines rate-limited this machine). Rewording the query cannot fix
  that, so do not loop over variants.

Either way, `await bailian_web_search.asearch(query)` still works from mainland China without a
VPN, so use it for this turn (its answer has no source URLs; confirm what matters with `fetch` on
the source page), and say in your report that SearXNG search was unavailable.

### `fetch(url, *, render="auto", max_chars=None, mode="auto", wait_for=None, expect=None, archive=True)`

Reads one page as markdown (tables kept as `| a | b |` rows). It tries the cheapest way first
and escalates only when that did not really get the page; `result.tier` says which worked and
`result.attempts` lists every try with its time:

1. `http` (1-4 s): a plain request with a real Chrome TLS fingerprint. Enough for docs, blogs and
   most vendor plan tables.
2. `browser` (5-15 s, plus ~1 s launch): headless Chromium, used when the HTTP page is a
   JavaScript shell, too short, a bot check, or blocked. Pass `wait_for="css selector"` to wait
   for a price table. A non-interactive "checking your browser" page gets up to 12 s to clear on
   its own; nothing is solved or clicked.
3. `archive` (5-25 s): the latest Wayback Machine copy, marked `archived_at`. It can be months
   old: never quote an archived price as today's price.

Some pricing pages read fine over HTTP but get their numbers from JavaScript afterwards (measured:
Tencent Cloud's Lighthouse sale page had 3 `元` amounts over HTTP and 9 after rendering). When you know
what the page must contain, say so: `fetch(url, expect="[$¥][0-9]|[0-9]+元")` escalates to the
browser when the pattern is missing.

If every tier fails, `result.ok` is False, `result.content` is empty and `result.reason` says why
("login wall", "captcha/bot challenge", "blocked (403/429)", "not found"); `needs_human` is True
for login, captcha and blocking. Report that to the owner instead of guessing what the page says.
`render="never"` stays on HTTP; `render="always"` goes straight to the browser. `mode="full"`
returns all visible text; the default switches to it by itself when main-content extraction
dropped most of a large page (pricing grids often look like boilerplate to it).
`fetch_many(urls, concurrency=4)` fetches several pages at once. `max_chars=` cuts `content` only;
`key_lines` and `save()` still cover the whole page.

A PDF URL returns the PDF's text (`content_mode == "pdf"`, first 150 pages). When the PDF has no
text layer, or the kernel lacks the PDF reader, `ok` is False and `reason` starts with `pdf` and
names the page to read instead (for arXiv: `arxiv.org/abs/<id>` or `arxiv.org/html/<id>`); other
binary files (images, archives) come back `ok=False` with `binary file`. Decoded as text they would
be pages of garbage that look like a successful read.

Sites for a Chinese audience (`.cn`, Aliyun, Tencent Cloud, Huawei Cloud...) are asked for Chinese
first so they show the mainland offer in CNY; other sites are asked for English first. Pass
`BrowserSession(locale="zh-CN")` / `browse(..., locale="zh-CN")` to override for a vendor that
switches currency by language.

### `BrowserSession` - clicking through to the real price

An advertised price is not the price. VPS promos are often annual-only or first-term-only, the
renewal can be double, setup or extra-IP fees appear only in the cart, and the cheapest tier is
often out of stock. The number to record is the one on the vendor's own order/cart page after
choosing the options, so walk there:

    async with web_research.BrowserSession() as b:
        await b.open("https://www.racknerd.com/kvm-vps")
        await b.click("ORDER NOW")                 # first match; use ref="e14" for another plan
        snap = await b.snapshot()                  # price lines, stock lines, clickable outline, text
        print(snap)
        await b.select("Choose Billing Cycle", "Annually")
        await b.click("Continue")                  # to the cart / order summary
        print((await b.snapshot()).price_lines)
        print(b.json_responses("price"))           # XHR/fetch JSON the page loaded
        await b.screenshot()                       # PNG path, evidence next to the number

- `print(snap)` shows price lines (a bare amount is joined to its label: `每年 (8折优惠) | 845.00元`),
  spec/route and stock lines, the first 60 controls and the start of the text. `snap.text`,
  `snap.outline_text()` and `snap.save()` give everything.
- `snapshot()` lists controls as `[e12] link 'ORDER NOW' -> ...`, `[e24] select 'Billing Cycle': *Monthly | Annually`.
  Target them by visible text, `ref="e12"` (refs change on every snapshot) or `selector="css"`.
- `json_responses(contains=None)` returns the JSON bodies the page fetched in the background.
  Vendor quote and stock APIs often live there and are more exact than the rendered text.
- `fill(field, value)` only types into quantity, coupon/promo code, hostname and search fields.
- Also: `open(url, wait_for=None)`, `wait(seconds, selector=None, text=None)`, `back()`, `html()`, `close()`.
- The first browser use on a machine downloads Chrome Headless Shell (~95 MB, usually under a
  minute; it gives up after ~7 minutes or sooner when the download stalls, and Esc stops it). If
  that fails, the failure is remembered for 2 hours so later fetches do not wait again: the
  browser tier reports `BrowserUnavailable` at once, `fetch` still answers from HTTP and the
  archive, and the message gives the one bash command that installs it by hand (the next call
  then uses it). A missing browser usually means the VPN/proxy was off during the download.
- The browser starts on first use; a session closes itself after 5 minutes idle (`idle_timeout=`),
  and the shared browser exits ~20 s after the last session. `web_research.shutdown_browser()`
  closes it at once; `web_research.browser_running()` reports whether it is up.

`browse(url, steps, screenshot=False, json_contains=None)` is the one-shot form for scripts and
parallel runs: steps like `("click", "Order Now")`, `("select", "Billing Cycle", "Annually")`,
`("fill", "Quantity", "2")`, `("wait", 2)`. It never raises for a step; a failure lands in
`.error`, a guard stop in `.stopped`, and `.snapshot` shows where it ended.

### Stop before payment

Research ends on the cart or order-review page. The click after it places an order, can bill the
owner, reserves stock in their name, or sends personal data to a vendor, and none of that can be
undone from here. So `click` raises `web_research.PaymentGuardRefused` for final-submit buttons
(pay now, place/submit/complete order, confirm purchase, 支付, 立即付款, 提交订单, 确认订单, 立即下单...),
for links to payment providers (PayPal, Alipay, Stripe checkout...), and for submit buttons of
forms that hold login or personal fields, and for every button on a page that shows login,
contact or card fields: that page is the checkout form, and its button (LisaHost's `结账`, for
one) is often a plain button outside the form that submits it from JavaScript. Cart-only buttons
there (apply coupon, remove, empty cart) stay clickable, as do ordinary links. Requests to
payment-provider hosts are aborted.
`fill` raises it for anything that is not a quote-shaping field: email, phone, name, address,
password, card, ID number, captcha answer. When the guard fires, you already have what you came
for: read the totals with `snapshot()`. Never try to route around it.

If the order page itself needs an account or a captcha, stop and report it as "login required"
or "captcha" with the URL; do not fill in a price from memory or from a review site.

### Papers and technical Q&A (keyless JSON APIs, no scraping)

    await web_research.arxiv("retrieval augmented generation survey", max_results=5)
    await web_research.crossref("asyncio structured concurrency", rows=5)
    await web_research.openalex("large language model agents", per_page=5)
    await web_research.stackexchange("asyncio TaskGroup cancel", site="stackoverflow")
    await web_research.github("playwright python headless", kind="repositories")

These return `Records` (iterate for dicts with `title`, `url`, `year`, `authors`, `summary`...).
They are faster and more exact than searching result pages. Crossref joins its faster polite pool
only when `CROSSREF_MAILTO` is set. Stack Exchange allows 300 keyless calls a day
(`STACKEXCHANGE_KEY` raises it). GitHub uses the logged-in `gh` CLI, else `GITHUB_TOKEN`, else
anonymous (no code search). Semantic Scholar is not included: its keyless pool answered 429 when
tested (2026-09-25); it needs a free API key.

## Recipe: compare VPS offers across vendors

Run vendors in parallel; each ends in one table row with the evidence URL. These three flows
were run live on 2026-09-25 (36 s wall time together) and each ended on the cart or checkout page:

    import asyncio
    VENDORS = {
        "RackNerd KVM-512MB": ("https://www.racknerd.com/kvm-vps", [("click", "ORDER NOW"), ("click", "Continue")]),
        "BandwagonHost 20G KVM": ("https://bandwagonhost.com/cart.php", [("click", "Order Now"), ("click", "Add to Cart")]),
        "LisaHost HK CN2 annual": ("https://www.lisahost.com/cart.php?gid=11",
                                   [("click", "立即订购"), ("click", "每年"), ("wait", 3), ("click", "继续")]),
    }
    runs = await asyncio.gather(*(web_research.browse(u, s) for u, s in VENDORS.values()))
    for name, r in zip(VENDORS, runs):
        print(name, r.snapshot.url if r.snapshot else "-", r.stopped or r.error or "")
        print("\n".join(r.snapshot.price_lines[:12]) if r.snapshot else "")

Clicking by text takes the first visible match, so on a page with many identical "Order Now"
buttons take a `snapshot()` first and click the plan you want by `ref=`.

Then write one row per offer: vendor, plan, CPU/RAM/disk, bandwidth and port, route (CN2 GIA,
CMI, 9929, BGP...), region, price due today, billing cycle, renewal price, setup/IP fees, stock,
and the cart URL you read it on. Mark every cell you could not confirm on the order page as
unconfirmed instead of filling it from the marketing page. For many vendors, or vendors needing
several steps, give each one to a subagent with this recipe so a slow site does not hold up the rest.
