# Providers

The arbitrage engines never import Amazon or eBay. They depend on interfaces,
which is what makes another marketplace an adapter rather than a rewrite.

## Interfaces

| Interface | Responsibility |
| --- | --- |
| `SourceProvider` | Search, fetch offers, find by identifier, **purchase** |
| `TargetMarketplaceProvider` | Search, market stats, publish/update/end listings, fetch sales, upload tracking, verify webhooks |
| `PriceProvider`, `InventoryProvider` | Narrow read-only views |
| `ShippingProvider` | Quote, create label, track |
| `FulfillmentProvider` | Receive, inspect, verify, repack, ship, process returns |
| `NotificationProvider` | Deliver one message on one channel |

Every method that costs money or touches an external system takes an
`idempotency_key`.

## Selection

`build_providers()` decides:

1. `DEMO_MODE=true`, **or any missing credential** → demo providers.
2. Credentials complete and `SIMULATION_MODE=true` → simulation.
3. Credentials complete and `SIMULATION_MODE=false` → live.

A half-configured system degrades to demo. Missing credentials are a
configuration state, not an exception to be handled three layers down inside
an order.

## Demo providers

`DemoAmazonProvider` and `DemoEbayProvider` serve a ten-product catalogue with
deterministic, hash-derived hourly price drift (so price history and
volatility have something real to work with, and results stay reproducible).

The catalogue is chosen to exercise the filters, not to flatter them:

| Entry | Exercises |
| --- | --- |
| Headphones, espresso machine, monitor | Pass every gate |
| USB-C cable | Below the €20 floor |
| Robot vacuum, garden hose | Below the 15% margin floor |
| Mechanical keyboard | Out of stock at source |
| Camera lens | Source delivery too slow to meet the promise |
| Diver watch | A 3.4× price ratio - the anomaly trap |
| Headphones (silver) | Same brand and model, different colour - the variant trap |

`DemoEbayProvider.simulate_sale()` produces a sale event so the full
sell-first workflow can be exercised without credentials.

## eBay Browse: a real adapter, read-only

`EbayBrowseProvider` speaks eBay's Browse API directly - no gateway. Two
application keys (`EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`) are all it needs, and
it is preferred over the generic gateway for reading whenever they are set.

| Method | Endpoint | Note |
| --- | --- | --- |
| `search_listings` | `/buy/browse/v1/item_summary/search?q=` | Fixed price only; an auction has no price until it ends |
| `find_by_identifier` | `…/search?gtin=` | **Works where the website does not** - the API indexes the structured product code |
| `get_listing_status` | `/buy/browse/v1/item/get_item_by_legacy_id` | Returns the EAN/MPN/EPID that search results omit |
| `get_market_stats` | derived from a search | Median, never the highest asking price |
| `sold_prices` | `/buy/marketplace_insights/…` | Restricted API; raises when the keyset is not approved |

What it refuses to do is as important as what it does. `publish_listing`,
`update_listing`, `end_listing` and `upload_tracking` raise: those are Sell API
calls behind a user-consent token, and an adapter that appeared to publish
would be worse than one that cannot. `verify_webhook` always returns `False` -
Browse sends no notifications, so anything claiming to be one is not ours.

Three further refusals, each of which would otherwise put a guess where the
engine expects an exact number:

- A listing priced in another currency is **dropped, not converted**. There is
  no exchange rate in this system, and inventing one would place a guess next
  to exact money.
- `realistic_sale_price` is the median of current asking prices. Never the
  highest: that is one seller's hope, not a sale.
- Sold prices come only from Marketplace Insights. No fallback to asking
  prices - a number labelled "sold" that is really an asking price is worse
  than no number.

Bad credentials fail with `retryable = False`: retrying cannot fix a wrong key,
and doing so spends the rate limit. The token is cached until a minute before
expiry, and a mid-session 401 buys exactly one refresh.

## Live adapters

Amazon's SP-API and eBay's Sell APIs each have their own auth flow,
throttling rules and payload shapes, and neither can be exercised honestly
without real credentials. Rather than ship untested guesses at those wire
formats, the live adapters speak one small, stable JSON contract and leave the
marketplace-specific translation in a single replaceable place.

**This is the remaining integration work, and it is stated plainly rather than
hidden: pointing `AMAZON_API_BASE_URL` at Amazon directly will not work.**
Reading eBay is the exception - that adapter is real; see above.

Two ways to go live:

1. Run a thin gateway of your own that speaks the contract below and holds the
   marketplace SDK.
2. Subclass `HttpSourceProvider` / `HttpTargetProvider`, overriding the
   request methods and parsers with the real endpoints.

Either way nothing above the provider layer changes.

### Source contract

```
GET  /health
GET  /offers/search?q=&limit=
GET  /offers/{external_id}
GET  /offers?ids=a,b,c
GET  /offers/by-identifier?type=EAN&value=...
POST /purchases            (Idempotency-Key header)
```

An offer:

```json
{
  "external_id": "B09XS7JWHH",
  "title": "...", "brand": "Sony", "model": "WH-1000XM5",
  "identifiers": {"EAN": "4548736134584", "ASIN": "B09XS7JWHH"},
  "price": "228.00", "shipping_cost": "0.00", "condition": "NEW",
  "stock_status": "IN_STOCK", "available_quantity": 42, "stock_confidence": "0.95",
  "delivery_min_days": 1, "delivery_max_days": 2, "delivery_speed": "FAST",
  "observed_at": "2026-01-01T12:00:00Z"
}
```

Monetary values are **decimal strings**. A gateway that sends JSON numbers for
money cannot be trusted to the cent.

A purchase request carries `max_unit_price`. **The gateway must refuse to buy
above it** — that ceiling is the last defence against a price move between
approval and execution.

### Target contract

```
GET    /health
GET    /listings/search?q=&limit=
GET    /listings/by-identifier?type=&value=
GET    /market/stats?identifier=&q=
POST   /listings                          (Idempotency-Key header)
POST   /listings/{id}/update
POST   /listings/{id}/end
GET    /listings/{id}
GET    /sales?since=
POST   /orders/{id}/tracking              (Idempotency-Key header)
```

`/market/stats` must return `realistic_sale_price` — what we can actually
expect to sell at, derived from the price distribution. The engine never
treats the highest observed listing as achievable.

## Webhooks

The live adapter verifies HMAC-SHA256 and **fails closed**: no secret or no
signature means rejected. An unauthenticated webhook can create orders, so it
must never be trusted by default. The demo provider accepts unsigned payloads
only because demo mode has no money at stake.

## Resilience

Every live call goes through `ProviderGuard`: a sliding-window rate limiter, a
circuit breaker (opens after consecutive failures, half-opens after a reset
timeout) and exponential backoff with jitter. Non-retryable errors are not
retried. Provider limits are configurable per adapter.

## Adding a marketplace

1. Implement `SourceProvider` or `TargetMarketplaceProvider`.
2. Return the shared DTOs (`OfferSnapshot`, `ListingSnapshot`, `MarketStats`).
3. Register it in `app/providers/registry.py`.
4. Make `purchase`/`publish_listing` idempotent on the supplied key.

No engine, service or model changes.
