"""Stop-before-payment guard. Pure stdlib so it can be checked without a browser.

Research needs the price a vendor shows on its cart or order page, and that page is always one
click before the step that places the order or takes a payment. Placing an order can bill the
owner, reserve stock under their name or send personal data to a vendor, and none of that is
reversible from here, so the final-submit step is refused outright rather than left to judgment.
"""

from __future__ import annotations

import re
from typing import Any

# Final-submit wording. "Checkout" / "Continue" / "Order now" / "Buy now" / "立即购买" stay allowed:
# on VPS and cloud sites they lead to the configure, cart or order-review page where the real price
# (promo vs renewal, setup fees) is shown, and nothing is placed until the button matched below.
_FINAL_SUBMIT_EN = re.compile(
    r"\b("
    r"pay\s+(now|securely|online|with\b|by\s+card|by\s+paypal|via\b|[$¥€£]|\d)|"
    r"(make|submit|confirm|authori[sz]e|complete|process)\s+(the\s+)?payment|"
    r"(proceed|continue|go)\s+to\s+payment|"
    r"place\s+(my\s+|your\s+|the\s+)?order|submit\s+(my\s+|your\s+|the\s+)?order|"
    r"complete\s+(my\s+|your\s+|the\s+)?(order|purchase|checkout)|"
    r"confirm\s+(and\s+pay|(my\s+|your\s+|the\s+)?(order|purchase|subscription))|"
    r"finish\s+(order|checkout|purchase)|purchase\s+now|complete\s+now|subscribe\s+and\s+pay"
    r")\b",
    re.IGNORECASE,
)
# A button whose whole label is one of these is the final step on its own.
_FINAL_SUBMIT_EXACT = {"pay", "payment", "purchase", "checkout and pay", "支付", "付款", "购买并支付"}
# Billing-cycle wording such as 付款周期 / 年付 / "Pay yearly" must stay clickable, so only explicit
# pay-now and submit-order phrases are listed.
_FINAL_SUBMIT_ZH = re.compile(
    r"(立即支付|去支付|前往支付|确认支付|马上支付|支付并开通|扫码支付|在线支付|"
    r"立即付款|去付款|确认付款|马上付款|确认并付款|结算并付款|"
    r"提交订单|确认订单|确认下单|立即下单|提交并下单|完成订单|确认购买|确定购买|确认开通)"
)

# A fill is allowed only into fields that shape the quote. Everything else (name, email, phone,
# address, password, card, ID number, captcha answer) is personal data or a login, and typing it
# into a vendor form is exactly what research must never do.
_FILL_ALLOWED = re.compile(
    r"(quantity|qty|amount_of|coupon|promo|voucher|discount|gift\s*code|hostname|host\s*name|"
    r"search|keyword|query|domain|数量|优惠|折扣|促销|代金券|兑换码|主机名|搜索|关键词|域名)",
    re.IGNORECASE,
)
_FILL_FORBIDDEN = re.compile(
    r"(pass(word|wd|code)?|pwd|e-?mail|phone|mobile|tel\b|telephone|first\s*name|last\s*name|full\s*name|"
    r"\bname\b|address|street|city|zip|postal|postcode|country|state|province|company|card|cvv|cvc|"
    r"expir|iban|account|ssn|passport|id\s*number|tax|vat|login|user\s*name|username|captcha|otp|"
    r"verification|2fa|token|secret|"
    r"密码|邮箱|邮件|手机|电话|姓名|名字|地址|城市|邮编|国家|省|公司|银行卡|卡号|身份证|证件|账号|帐号|"
    r"用户名|验证码|登录|注册)",
    re.IGNORECASE,
)
_SENSITIVE_INPUT_TYPES = {"password", "email", "tel", "file"}
_SENSITIVE_AUTOCOMPLETE = re.compile(
    r"(name|email|tel|address|postal|country|cc-|bday|sex|username|password|organization|one-time-code)",
    re.IGNORECASE,
)

_PAYMENT_HOSTS = (
    "paypal.com",
    "paypal.me",
    "alipay.com",
    "alipayobjects.com",
    "tenpay.com",
    "wx.tenpay.com",
    "pay.weixin.qq.com",
    "unionpay.com",
    "95516.com",
    "checkout.stripe.com",
    "js.stripe.com/v3/checkout",
    "pay.stripe.com",
    "buy.stripe.com",
    "paddle.com",
    "checkout.paddle.com",
    "2checkout.com",
    "2co.com",
    "coinpayments.net",
    "nowpayments.io",
    "commerce.coinbase.com",
    "payssion.com",
    "checkout.com",
    "adyen.com",
    "braintreegateway.com",
    "authorize.net",
    "skrill.com",
    "payoneer.com",
    "pay.google.com",
    "pay.amazon.com",
)

# Matches the host part of a URL for Playwright routing: every request to these hosts is aborted.
PAYMENT_HOST_PATTERN = re.compile(
    r"^https?://([^/]*\.)?(" + "|".join(re.escape(h.split("/")[0]) for h in _PAYMENT_HOSTS) + r")(:\d+)?(/|$)",
    re.IGNORECASE,
)


# On a checkout form these still only change the cart, never submit it.
_HARMLESS_ON_CHECKOUT = re.compile(
    r"(apply|validate|redeem|coupon|promo|remove|delete|empty\s+cart|continue\s+shopping|"
    r"验证|应用|使用优惠|兑换|删除|移除|清空购物车|继续购买|继续购物)",
    re.IGNORECASE,
)


def _label(info: dict[str, Any]) -> str:
    parts = [info.get(k) or "" for k in ("text", "value", "aria", "title", "alt")]
    return " ".join(str(p) for p in parts if p).strip()


def click_refusal(info: dict[str, Any]) -> str | None:
    """Why a click must be refused, or None when it is allowed.

    `info` describes the resolved element: text, value, aria, title, alt, tag, type, role, href,
    form_sensitive (its form holds a password, card or other personal field) and page_sensitive
    (such a field is visible anywhere on the page, i.e. this is the checkout form).
    """
    label = re.sub(r"\s+", " ", _label(info))
    href = str(info.get("href") or "")
    exact = label.strip(" .!:>»→").lower()
    if _FINAL_SUBMIT_EN.search(label) or _FINAL_SUBMIT_ZH.search(label) or exact in _FINAL_SUBMIT_EXACT:
        return (
            f"refused to click {label[:80]!r}: it reads as the final order/payment step. "
            "web_research stops before payment so nothing is ordered or charged and no personal "
            "data leaves this machine. The cart/order page already on screen holds the price; "
            "read it with snapshot() and record promo, renewal, fees and stock from there."
        )
    if href and PAYMENT_HOST_PATTERN.search(href):
        return f"refused to click {label[:80]!r}: it links to a payment provider ({href[:80]})."
    submit_like = str(info.get("tag") or "").lower() == "button" or str(info.get("type") or "").lower() in {
        "submit",
        "image",
    }
    role = str(info.get("role") or "").lower()
    # A link with a real href is a GET navigation and submits nothing; buttons and script-only
    # anchors ("#", "javascript:") are how checkout pages submit their form.
    tag = str(info.get("tag") or "").lower()
    script_link = tag == "a" and (not href.strip("#") or href.lower().startswith("javascript"))
    buttonish = submit_like or role == "button" or script_link
    if info.get("page_sensitive") and buttonish and not _HARMLESS_ON_CHECKOUT.search(label):
        return (
            f"refused to click {label[:80]!r}: this page is the checkout form (it asks for login, "
            "contact or card details), and its buttons submit the order even when they sit outside "
            "the form. The totals shown here are the research result; read them with snapshot()."
        )
    if submit_like and info.get("form_sensitive"):
        return (
            f"refused to click {label[:80]!r}: it submits a form that holds login, personal or "
            "payment fields. Submitting it would send data the owner never agreed to share."
        )
    return None


def fill_refusal(info: dict[str, Any]) -> str | None:
    """Why typing into a field must be refused, or None when the field only shapes the quote."""
    kind = str(info.get("type") or "").lower()
    names = " ".join(
        str(info.get(k) or "") for k in ("name", "id", "label", "placeholder", "aria", "autocomplete")
    ).strip()
    if kind in _SENSITIVE_INPUT_TYPES:
        return f"refused to fill a {kind} field ({names[:60]!r}): logins and personal data are never entered."
    if _SENSITIVE_AUTOCOMPLETE.search(str(info.get("autocomplete") or "")):
        return f"refused to fill {names[:60]!r}: the page marks it as personal data (autocomplete)."
    if _FILL_ALLOWED.search(names) and not _FILL_FORBIDDEN.search(names):
        return None
    if kind == "number" and not _FILL_FORBIDDEN.search(names):
        return None
    return (
        f"refused to fill {names[:60] or 'an unlabeled field'!r}: only quote-shaping fields "
        "(quantity, coupon/promo code, hostname, search box) are filled. Anything else may be a "
        "login or personal data; report the field to the owner instead."
    )
