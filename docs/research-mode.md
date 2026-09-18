# Research mode

Analyse real products with real numbers, while the system is structurally
incapable of listing, buying or shipping anything.

This is the mode to start in. It answers the only question worth answering
first: *would this actually make money on products I care about?*

## Turning it on

```bash
RESEARCH_MODE=true
```

or flip `research_mode` in Settings. The launcher (`python3 start.py`) sets it
automatically.

When it is on, the header of every page says so, and `/api/health` reports
`"execution_mode": "RESEARCH", "read_only": true`.

## What it cannot do

Three independent defences, because the failure being prevented is spending
real money by accident:

1. **The provider layer.** The source and target providers are wrapped in
   `ReadOnlySourceProvider` / `ReadOnlyTargetProvider`. Reads pass through;
   `purchase`, `publish_listing`, `update_listing`, `end_listing` and
   `upload_tracking` raise `ResearchModeError`. The method that would spend
   money is not connected to anything that can.
2. **The services.** `ListingEngine.publish_listing`, `OrderService.approve`,
   `OrderService.execute` and `FulfillmentService.ship` refuse before doing
   any work.
3. **Compliance.** `checkListing`, `checkOrder` and `checkFulfillment` return
   a hard block.

Any one alone would be enough. Tests assert all three.

## What it still does

Everything that is analysis:

- Product matching, with identifier checksums and variant blocking
- The full profit calculation, every cost line, all three scenarios
- The 12-factor risk score with per-factor explanations
- Minimum viable sale price (what you would have to list at)
- Capital requirement, margin, ROI
- The audit trail

## Research mode is the one mode that is safe against live credentials

Every other mode degrades to demo when credentials are incomplete. Research
mode does the opposite: if real provider credentials exist it uses them, so
the *data* is real, and removes the write paths so the *actions* are
impossible. It is never silently downgraded by `DEMO_MODE` or
`SIMULATION_MODE`.

## No sign-in on a local install

`start.py` skips the sign-in screen: it is a single-user tool on your own
machine, and a password you have to look up is friction without a benefit.

The backend only honours this when **all three** hold:

1. It was asked to (`LOCAL_NO_AUTH=true`)
2. The environment is not production
3. The system cannot spend money - research or demo mode

Anything able to list, buy or ship always requires credentials, whatever the
flag says, and the server refuses to start on that combination rather than
quietly ignoring it. Requests from anywhere other than this machine are
rejected even when it is on.

Want a login anyway:

```bash
python3 start.py --require-login          # ask for email and password
python3 start.py --password yourpassword  # set a known one
python3 start.py --show-login             # print the saved details
```

## Analysing your own products - no marketplace account needed

Getting an official product API is the slow part of this business. Amazon's
needs a seller account or an Associates account with qualifying sales; eBay's
needs a developer registration (free, and usually quick - it is much less of
an obstacle than Amazon's).

Scraping either site is against their terms, is actively blocked, and returns
data too unreliable to base money decisions on. **This system does not scrape
and will not be given the ability to.**

So the **Research** page takes the products you have looked up yourself:

1. Find the product on Amazon. Note the price, the EAN (product page →
   "Product information"), and whether it is in stock.
2. Search that EAN on eBay. Note what comparable items *actually sell for* -
   completed listings, not the most hopeful asking price.
3. Paste a row per product and analyse.

The engine that runs is the same engine. Only the data collection is manual.

### The columns

| Column | Needed | Notes |
| --- | --- | --- |
| `title` | required | |
| `source_price` | required | What you would pay on Amazon |
| `target_price` | required | What you realistically expect on eBay |
| `ean`, `brand`, `model` | **needed to pass** | Without all three the match cannot reach 95% confidence and the row is rejected |
| `source_stock` | recommended | `IN_STOCK`, `LOW_STOCK`, `OUT_OF_STOCK`; unknown stock blocks |
| `source_delivery_days` | recommended | Too slow to meet the buyer's expectation blocks |
| `median_competitor_price` | recommended | What the market really pays; used instead of your optimistic figure |
| `source_shipping`, `target_shipping`, `competitor_count`, `lowest_competitor_price`, `highest_competitor_price`, `source_quantity_available`, `condition`, `category`, `source_url`, `target_url`, `notes` | optional | Sharpen the analysis |

Comma, semicolon and tab separated files all work, as do European numbers
(`199,00` and `1.319,50`), so an Excel export from a German locale loads
as-is.

### Why a row gets rejected

The same thresholds apply as everywhere else - that is the point. Common ones:

| Verdict | Meaning |
| --- | --- |
| **Worth doing** | Clears profit, margin, risk and match thresholds |
| **Not worth it** | Real, but under €20 profit or under 15% margin |
| **Blocked: out of stock / unknown stock** | Cannot commit to supplying it |
| **Blocked: delivery** | The source cannot arrive in time |
| **Blocked: anomalous price ratio** | The gap is too large to believe; almost always a variant, bundle, used unit or regional model |
| **Rejected: match confidence** | Add the `ean`, `brand` and `model` - an identifier alone does not prove two listings are the same item |

A rejection is not a failure of the tool. Filtering out false positives is
what it is for.

## When you have finished researching

Research mode off, simulation mode on, is the next step: it runs the full
sell-first workflow end to end without committing anything externally. Only
after that does live mode make sense, and only with real fee schedules and
capital limits set. See [deployment.md](deployment.md#production-checklist).
