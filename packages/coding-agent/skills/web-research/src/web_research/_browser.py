"""One headless Chromium per kernel, started on demand and closed when nobody uses it.

Headless is not a preference here: this runs on the owner's own Mac while they work, and a
browser window that appears or steals focus interrupts them. Every launch goes through
launch_options(), which forces headless=True whatever the caller passed, and uses Playwright's
Chrome Headless Shell: a plain binary with no .app bundle, so macOS shows no Dock icon either.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import signal
import subprocess
import sys
from typing import Any

from . import _net

HEADLESS = True
# How long the shared browser stays up after its last user leaves, so a burst of fetches does not
# pay the ~1s launch each time. After that nothing is left running.
LINGER_SECONDS = 20.0
_INSTALL_TIMEOUT = 900.0


def launch_options(**requested: Any) -> dict[str, Any]:
    """Chromium launch options. headless is forced on; headed/devtools/slow_mo requests are dropped."""
    opts: dict[str, Any] = {
        "headless": HEADLESS,
        "args": ["--no-first-run", "--no-default-browser-check", "--mute-audio", "--hide-scrollbars"],
        "handle_sigint": False,
        "handle_sigterm": False,
    }
    proxy = _net.proxy_url()
    if proxy and not proxy.startswith("socks"):
        opts["proxy"] = {"server": proxy, "bypass": "localhost,127.0.0.1,::1"}
    elif proxy:
        opts["proxy"] = {"server": proxy.replace("socks5h://", "socks5://"), "bypass": "localhost,127.0.0.1,::1"}
    for key in ("timeout",):
        if key in requested:
            opts[key] = requested[key]
    assert opts["headless"] is True, "web_research never opens a visible browser window"
    return opts


def _scrub_headed_env() -> None:
    # PWDEBUG=1 makes Playwright launch headed with the inspector; HEADED is read by some test runners.
    for name in ("PWDEBUG", "HEADED", "PLAYWRIGHT_HEADED"):
        os.environ.pop(name, None)


async def _run(args: list[str], timeout: float) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=dict(os.environ)
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return -1, f"timed out after {timeout:.0f}s"
    return proc.returncode or 0, out.decode(errors="replace")


async def _download_with_curl() -> str | None:
    """Fetch the headless shell zip with curl (resumable, retried) into the path Playwright expects.

    Measured 2026-09-25 behind this machine's proxy: Playwright's own Node downloader took 4-6
    minutes and then died with an SSL record error, while curl fetched the same 94 MB in 36s.
    Returns None on success, else why it did not work.
    """
    curl, unzip = shutil.which("curl"), shutil.which("unzip")
    if not curl or not unzip:
        return "curl/unzip not found"
    code, out = await _run([sys.executable, "-m", "playwright", "install", "--dry-run", "--only-shell", "chromium"], 60)
    if code != 0:
        return f"dry-run failed: {out[-200:]}"
    location = url = None
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("Install location:") and "headless_shell" in line:
            location = line.split(":", 1)[1].strip()
        elif line.startswith("Download url:") and location and url is None:
            url = line.split(":", 1)[1].strip()
    if not location or not url:
        return "could not read the download URL from playwright"
    os.makedirs(location, exist_ok=True)
    archive = os.path.join(location, "download.zip")
    code, out = await _run(
        [curl, "-fsSL", "--retry", "5", "--retry-all-errors", "-C", "-", "-o", archive, url], _INSTALL_TIMEOUT
    )
    if code != 0:
        return f"curl failed ({code}): {out[-200:]}"
    code, out = await _run([unzip, "-q", "-o", archive, "-d", location], 300)
    if code != 0:
        return f"unzip failed: {out[-200:]}"
    os.remove(archive)
    open(os.path.join(location, "INSTALLATION_COMPLETE"), "w").close()
    return None


async def _install_headless_shell() -> None:
    print(
        "web_research: first headless-browser use on this machine - downloading Chrome Headless Shell "
        "(about 95 MB, one time, usually under a minute)...",
        flush=True,
    )
    why = await _download_with_curl()
    if why is None:
        print("web_research: Chrome Headless Shell installed.", flush=True)
        return
    code, out = await _run(
        [sys.executable, "-m", "playwright", "install", "--only-shell", "chromium"], _INSTALL_TIMEOUT
    )
    if code != 0:
        raise RuntimeError(
            f"web_research: installing Chrome Headless Shell failed (curl path: {why}; playwright install exit {code}). "
            f"Manual command: {sys.executable} -m playwright install --only-shell chromium\n{out[-600:]}"
        )
    print("web_research: Chrome Headless Shell installed.", flush=True)


class _Pool:
    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock: asyncio.Lock | None = None
        self._pw: Any = None
        self._browser: Any = None
        self._users = 0
        self._closer: asyncio.Task[None] | None = None
        self.launches = 0

    def _bind_loop(self) -> None:
        loop = asyncio.get_running_loop()
        if self._loop is not loop:
            # A new event loop (asyncio.run in a script) cannot use objects bound to the old one.
            self._loop, self._lock = loop, asyncio.Lock()
            self._pw = self._browser = self._closer = None
            self._users = 0

    @property
    def running(self) -> bool:
        return self._browser is not None and self._browser.is_connected()

    async def acquire(self) -> Any:
        self._bind_loop()
        assert self._lock is not None
        async with self._lock:
            if self._closer is not None:
                closer, self._closer = self._closer, None
                closer.cancel()
            if not self.running:
                await self._start()
            self._users += 1
            return self._browser

    async def _start(self) -> None:
        from playwright.async_api import Error as PlaywrightError
        from playwright.async_api import async_playwright

        _scrub_headed_env()
        if self._pw is None:
            self._pw = await async_playwright().start()
        try:
            self._browser = await self._pw.chromium.launch(**launch_options())
        except PlaywrightError as exc:
            if "Executable doesn't exist" not in str(exc) and "playwright install" not in str(exc):
                raise
            await _install_headless_shell()
            self._browser = await self._pw.chromium.launch(**launch_options())
        self.launches += 1

    async def release(self, linger: float | None = None) -> None:
        self._bind_loop()
        self._users = max(0, self._users - 1)
        if self._users != 0:
            return
        if linger == 0:
            if self._closer is not None:
                closer, self._closer = self._closer, None
                closer.cancel()
            await self._stop()
        elif self._closer is None:
            delay = LINGER_SECONDS if linger is None else linger
            self._closer = asyncio.get_running_loop().create_task(self._close_later(delay))

    async def _close_later(self, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            # acquire() clears _closer before cancelling; if it still points here, the event loop
            # itself is shutting down (end of asyncio.run), and the browser must not outlive it.
            if self._closer is asyncio.current_task():
                self._closer = None
                self.abandon()
            return
        assert self._lock is not None
        async with self._lock:
            self._closer = None
            if self._users == 0:
                await self._stop()

    async def _stop(self) -> None:
        browser, pw = self._browser, self._pw
        self._browser = self._pw = None
        if browser is not None:
            try:
                await browser.close()
            except Exception:  # noqa: BLE001 - already gone is fine
                pass
        if pw is not None:
            try:
                await pw.stop()
            except Exception:  # noqa: BLE001
                pass

    def abandon(self) -> None:
        """Synchronous last resort when the event loop is ending (asyncio.run returning with a session open).

        Playwright cannot be awaited any more at that point (its connection task is cancelled in the
        same sweep), so the driver process is terminated directly. Chromium runs over a pipe to that
        driver and exits as soon as the pipe closes, so no browser outlives the loop.
        """
        self._browser = self._pw = None
        self._users = 0
        for pid in _driver_pids():
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass

    async def shutdown(self) -> None:
        """Close the browser now, whoever still holds it."""
        self._bind_loop()
        if self._closer is not None:
            closer, self._closer = self._closer, None
            closer.cancel()
        self._users = 0
        await self._stop()


def _driver_pids() -> list[int]:
    """Playwright driver processes that are direct children of this Python process."""
    try:
        import playwright

        marker = os.path.dirname(playwright.__file__)
        out = subprocess.run(["ps", "-Ao", "pid=,ppid=,command="], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    me, pids = str(os.getpid()), []
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and parts[1] == me and marker in parts[2] and "driver" in parts[2]:
            pids.append(int(parts[0]))
    return pids


POOL = _Pool()


class Context:
    """A browser context plus the payment-provider requests it aborted."""

    def __init__(self, ctx: Any) -> None:
        self.ctx = ctx
        self.blocked: list[str] = []


async def new_context(**kwargs: Any) -> Context:
    """A fresh, isolated context (own cookies/cart) on the shared browser. Caller must close_context()."""
    from ._guard import PAYMENT_HOST_PATTERN

    browser = await POOL.acquire()
    try:
        major = (browser.version or _net.CHROME_MAJOR).split(".")[0]
        ua = _net.USER_AGENT.replace(f"Chrome/{_net.CHROME_MAJOR}.", f"Chrome/{major}.")
        ctx = await browser.new_context(
            user_agent=kwargs.get("user_agent") or ua,
            locale=kwargs.get("locale") or "en-US",
            viewport=kwargs.get("viewport") or {"width": 1366, "height": 900},
            timezone_id=kwargs.get("timezone_id"),
            ignore_https_errors=False,
            accept_downloads=False,
        )
    except BaseException:
        await POOL.release()
        raise
    wrapped = Context(ctx)

    async def _abort_payment(route: Any) -> None:
        wrapped.blocked.append(route.request.url)
        await route.abort("blockedbyclient")

    await ctx.route(PAYMENT_HOST_PATTERN, _abort_payment)
    return wrapped


async def close_context(wrapped: Context, linger: float | None = None) -> None:
    try:
        await wrapped.ctx.close()
    except Exception:  # noqa: BLE001 - browser may already be gone
        pass
    await POOL.release(linger)
