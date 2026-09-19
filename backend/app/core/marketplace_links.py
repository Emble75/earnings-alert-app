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

from urllib.parse import quote_plus

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


def ebay_search_url(
    *, marketplace: str | None = None, identifier: str | None = None, title: str | None = None
) -> str | None:
    """Current eBay listings - what other sellers are asking."""
    query = (identifier or title or "").strip()
    if not query:
        return None
    return f"https://{ebay_domain(marketplace)}/sch/i.html?_nkw={quote_plus(query)}"


def ebay_sold_url(
    *, marketplace: str | None = None, identifier: str | None = None, title: str | None = None
) -> str | None:
    """eBay listings that actually sold - what buyers actually paid.

    ``LH_Sold`` and ``LH_Complete`` restrict the search to completed sales.
    This is the link to trust when setting a target price.
    """
    query = (identifier or title or "").strip()
    if not query:
        return None
    domain = ebay_domain(marketplace)
    return (
        f"https://{domain}/sch/i.html?_nkw={quote_plus(query)}"
        "&LH_Sold=1&LH_Complete=1&_sop=13"
    )
