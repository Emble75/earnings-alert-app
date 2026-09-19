"""Links back to the marketplaces.

The operator is constantly moving between this system and the two
marketplaces: check the Amazon price, check what the thing actually sells for
on eBay, come back. Making them paste URLs into a spreadsheet to get those
links is busywork, so they are derived from the product's identifier instead.

The eBay *sold* link matters most. An asking price tells you what one hopeful
seller wants; completed sales tell you what buyers actually paid, which is the
number the profit calculation should be built on.
"""

from __future__ import annotations

import re
from urllib.parse import quote_plus, urlparse

#: Amazon marketplace code -> domain. Codes follow the two-letter country
#: convention used by Amazon's own marketplace identifiers.
AMAZON_DOMAINS = {
    "DE": "www.amazon.de",
    "AT": "www.amazon.de",     # Austria is served by the German marketplace
    "US": "www.amazon.com",
    "GB": "www.amazon.co.uk",
    "UK": "www.amazon.co.uk",
    "FR": "www.amazon.fr",
    "IT": "www.amazon.it",
    "ES": "www.amazon.es",
    "NL": "www.amazon.nl",
    "PL": "www.amazon.pl",
    "SE": "www.amazon.se",
    "BE": "www.amazon.com.be",
    "IE": "www.amazon.ie",
    "CA": "www.amazon.ca",
}

#: eBay marketplace id -> domain.
EBAY_DOMAINS = {
    "EBAY_DE": "www.ebay.de",
    "EBAY_AT": "www.ebay.at",
    "EBAY_US": "www.ebay.com",
    "EBAY_GB": "www.ebay.co.uk",
    "EBAY_FR": "www.ebay.fr",
    "EBAY_IT": "www.ebay.it",
    "EBAY_ES": "www.ebay.es",
    "EBAY_NL": "www.ebay.nl",
    "EBAY_PL": "www.ebay.pl",
    "EBAY_IE": "www.ebay.ie",
    "EBAY_CA": "www.ebay.ca",
}

DEFAULT_AMAZON = "www.amazon.de"
DEFAULT_EBAY = "www.ebay.de"


def amazon_domain(marketplace: str | None) -> str:
    return AMAZON_DOMAINS.get((marketplace or "").upper(), DEFAULT_AMAZON)


def ebay_domain(marketplace: str | None) -> str:
    return EBAY_DOMAINS.get((marketplace or "").upper(), DEFAULT_EBAY)


def amazon_url(
    *,
    marketplace: str | None = None,
    asin: str | None = None,
    identifier: str | None = None,
    title: str | None = None,
) -> str | None:
    """Best available Amazon link: the product page, else a search.

    An ASIN addresses the exact listing. Without one, an EAN search is the
    closest honest equivalent - it may return several results, which is a true
    reflection of what we know.
    """
    domain = amazon_domain(marketplace)
    if asin:
        return f"https://{domain}/dp/{quote_plus(asin.strip())}"
    query = (identifier or title or "").strip()
    if not query:
        return None
    return f"https://{domain}/s?k={quote_plus(query)}"


def ebay_query(
    *,
    brand: str | None = None,
    model: str | None = None,
    title: str | None = None,
    identifier: str | None = None,
) -> tuple[str, bool]:
    """Build an eBay search that actually finds the product.

    Searching eBay by EAN returns nothing almost every time: sellers do not
    put the number in the listing title, and eBay's default search only looks
    at titles. Brand plus model is what matches a real listing.

    Returns the query and whether descriptions should be searched too - which
    only helps for the identifier fallback, where the number, if it appears at
    all, is buried in the description.
    """
    brand = (brand or "").strip()
    model = (model or "").strip()
    if brand and model:
        # "Sony WH-1000XM5" - how a seller actually titles it.
        return (f"{brand} {model}" if model.lower() not in brand.lower() else brand), False
    if model:
        return model, False
    if title:
        return title.strip(), False
    if identifier:
        return identifier.strip(), True
    return "", False


def ebay_search_url(
    *,
    marketplace: str | None = None,
    identifier: str | None = None,
    title: str | None = None,
    brand: str | None = None,
    model: str | None = None,
) -> str | None:
    """Current eBay listings - what other sellers are asking."""
    query, search_descriptions = ebay_query(
        brand=brand, model=model, title=title, identifier=identifier
    )
    if not query:
        return None
    url = f"https://{ebay_domain(marketplace)}/sch/i.html?_nkw={quote_plus(query)}"
    return url + "&LH_TitleDesc=1" if search_descriptions else url


def ebay_sold_url(
    *,
    marketplace: str | None = None,
    identifier: str | None = None,
    title: str | None = None,
    brand: str | None = None,
    model: str | None = None,
) -> str | None:
    """eBay listings that actually sold - what buyers actually paid.

    ``LH_Sold`` and ``LH_Complete`` restrict the search to completed sales.
    This is the link to trust when setting a target price.
    """
    query, search_descriptions = ebay_query(
        brand=brand, model=model, title=title, identifier=identifier
    )
    if not query:
        return None
    url = (
        f"https://{ebay_domain(marketplace)}/sch/i.html?_nkw={quote_plus(query)}"
        "&LH_Sold=1&LH_Complete=1&_sop=13"
    )
    return url + "&LH_TitleDesc=1" if search_descriptions else url


# ---------------------------------------------------------------------------
# Reading an exact offer out of a pasted URL
# ---------------------------------------------------------------------------
# The operator is already looking at the page. Pasting its address is less
# work than typing a product name, and it identifies one specific offer rather
# than a search that might return something else tomorrow.

#: An ASIN is ten characters, digits and capitals. It appears after /dp/,
#: /gp/product/ and a few older variants.
_ASIN_PATTERNS = (
    re.compile(r"/(?:dp|gp/product|gp/aw/d|product|gp/offer-listing)/([A-Z0-9]{10})(?:[/?#]|$)"),
    re.compile(r"[?&]asin=([A-Z0-9]{10})", re.IGNORECASE),
)

#: eBay item ids are 9-15 digits, after /itm/ (sometimes behind a slug).
_EBAY_PATTERNS = (
    re.compile(r"/itm/(?:[^/?#]*/)?(\d{9,15})(?:[/?#]|$)"),
    re.compile(r"[?&]item=(\d{9,15})"),
)

#: Shortened links cannot be read without following the redirect, which would
#: mean fetching the page. We ask for the full URL instead of guessing.
_SHORTENERS = {"amzn.to", "amzn.eu", "a.co", "ebay.us", "ebay.to"}


def is_shortened(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower().removeprefix("www.")
    except ValueError:
        return False
    return host in _SHORTENERS


def extract_asin(url: str | None) -> str | None:
    """The ASIN from an Amazon product URL, or ``None``."""
    if not url:
        return None
    candidate = url.strip()
    for pattern in _ASIN_PATTERNS:
        match = pattern.search(candidate)
        if match:
            return match.group(1).upper()
    # A bare ASIN pasted on its own is unambiguous enough to accept.
    if re.fullmatch(r"[A-Z0-9]{10}", candidate.upper()) and any(c.isdigit() for c in candidate):
        return candidate.upper()
    return None


def extract_ebay_item_id(url: str | None) -> str | None:
    """The item id from an eBay listing URL, or ``None``."""
    if not url:
        return None
    candidate = url.strip()
    for pattern in _EBAY_PATTERNS:
        match = pattern.search(candidate)
        if match:
            return match.group(1)
    if re.fullmatch(r"\d{9,15}", candidate):
        return candidate
    return None


def marketplace_from_url(url: str | None) -> str | None:
    """The domain of a pasted URL, so links stay on the site they came from."""
    if not url:
        return None
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return None
    return host or None


def amazon_offer_url(asin: str, *, marketplace: str | None = None, domain: str | None = None) -> str:
    """The exact Amazon product page."""
    return f"https://{domain or amazon_domain(marketplace)}/dp/{quote_plus(asin)}"


def ebay_offer_url(item_id: str, *, marketplace: str | None = None, domain: str | None = None) -> str:
    """The exact eBay listing."""
    return f"https://{domain or ebay_domain(marketplace)}/itm/{quote_plus(item_id)}"


def describe_url(url: str | None, *, site: str) -> str | None:
    """Why a pasted URL could not be used - shown to the operator verbatim."""
    if not url or not url.strip():
        return None
    if is_shortened(url):
        return (
            f"That is a shortened {site} link. Open it, then copy the full address "
            "from the browser bar."
        )
    if site == "Amazon" and extract_asin(url) is None:
        return (
            "No product code found in that Amazon link. It should contain /dp/ "
            "followed by ten characters, for example /dp/B09XS7JWHH."
        )
    if site == "eBay" and extract_ebay_item_id(url) is None:
        return (
            "No item number found in that eBay link. It should contain /itm/ "
            "followed by the item number."
        )
    return None
