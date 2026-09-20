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
   "Product information"), and whether it is in stock. **Copy the address
   from the browser bar.**
2. Search that EAN on eBay. Note what comparable items *actually sell for* -
   completed listings, not the most hopeful asking price. **Copy the address
   of the listing you priced against.**
3. Paste a row per product and analyse.

The engine that runs is the same engine. Only the data collection is manual.

### Paste the two addresses

They are optional, and they change what you get back. With them the result
links to **those two offers** - `amazon.de/dp/B09XS7JWHH` and
`ebay.de/itm/123456789012` - rather than to a search that may return something
else tomorrow. The ASIN and the eBay item number are read out of the address
and stored with the offer, so the numbers in the calculation stay attached to
the pages they came from.

Shortened links (`amzn.eu/d/...`, `ebay.us/...`) are reported, not resolved:
following one would mean fetching the page. Open it and copy the full address.

## Finding candidates instead of thinking them up

**Find deals** scans a slice of eBay and hands back a worklist. It needs the
eBay keys below.

The direction is deliberate. Searching Amazon for cheap things and asking
whether eBay wants them finds plenty of cheap things nobody buys. Starting on
eBay inverts it: a product with several sellers at similar prices is evidence
that it sells. The only question left is what it would have to cost on Amazon,
and that has an exact answer.

So each row gives you one number - **buy below** - the most you could pay and
still clear your minimum profit and margin, with eBay fees, postage,
packaging, return exposure, the risk reserve and VAT already taken off. Open
the Amazon link, compare one price, move on.

| Product | Sells for | Buy below | Sellers |
| --- | --- | --- | --- |
| Sony WH-1000XM5 | 299.00 | **197.50** | 3 |
| Logitech MX Keys | 104.00 | **59.23** | 2 |

That figure is the profit engine run backwards - a binary search over the real
engine, not a second copy of the formula that could drift from it. It is exact
to the cent: at 197.50 the margin is 15.00%, at 197.51 it is 14.99% and the
deal fails.

### What the scan will not do

- **It does not invent an Amazon price.** There is no free source of them, so
  there is no column for one. You get a short list and the number to beat.
- **It ignores products with one listing.** A single asking price says nothing
  about what something sells for.
- **It uses the median of the competing listings, never the highest.**
- **It says when nothing can work.** A product selling for 8.20 cannot carry
  the fees at any purchase price, and is reported that way rather than shown
  with a tiny margin.

### The call budget

eBay allows a few thousand calls a day. One search returns 200 listings for a
single call, but the product codes needed for matching cost one call each - so
listings are grouped by eBay's own catalogue id first and only one
representative per product is looked up. Twenty listings of one product cost
one call, not twenty. "Products to look up" caps the rest.

## Letting eBay find the listing for you

With two eBay application keys the **Find the listing on eBay** button returns
real listings - title, asking price, shipping, condition, seller feedback and,
crucially, the item number - and one click fills the eBay side of the form.

### Getting the keys

1. Sign in at [developer.ebay.com](https://developer.ebay.com) and register as
   a developer. The account has to be verified by eBay before **production**
   keys are issued; a **sandbox** keyset is available immediately.
2. Application Keys → create a keyset. Two values matter:
   **App ID (Client ID)** and **Cert ID (Client Secret)**.
3. Put them in `.env`:

   ```
   EBAY_CLIENT_ID=YourApp-Name-PRD-abc123...
   EBAY_CLIENT_SECRET=PRD-abc123...
   EBAY_ENVIRONMENT=production      # or sandbox while you are waiting
   EBAY_MARKETPLACE=EBAY_DE
   ```

4. Restart. `/api/health` will report the eBay provider as `ebay-browse`.

### "Your keyset is currently disabled"

A new production keyset is disabled until the application either handles
eBay's **marketplace account deletion / account closure notifications** or holds
an **exemption** from that requirement. Until then eBay refuses the keys with
`invalid_client` - the same answer it gives for a wrong password, which makes
this look like a typo when it is not. The banner on the Application Keys page
is what distinguishes them.

Handling the notifications means running an HTTPS endpoint that eBay can reach,
which a laptop is not. The exemption is the route that fits a local research
install: it reads public listings through the Browse API with an application
token, and holds no eBay user data at all - no buyer names, no addresses, no
user tokens. Describe your own use when applying; eBay decides.

Sandbox is worth setting up while production is pending, but be clear about
what it is: an empty shop. It proves the wiring works. It will not find you a
product to trade, because there is almost nothing listed in it.

### What these keys can and cannot do

They are *application* keys, obtained through the client-credentials grant.
They carry one scope, public read, and the adapter implements only reads. It
cannot list, revise, end a listing or upload tracking - those are Sell API
calls behind a user-consent token from your own seller account, and the
adapter raises rather than pretending. This is why the keys are safe to
configure in research mode: the system reads the real eBay and still cannot
act on it.

### The one thing the API does that the website cannot

Type an EAN into ebay.de and you get nothing. Sellers do not put the number in
the title, and the site searches titles. The API searches eBay's **structured**
product field, so `?ean=4548736134584` returns the right listings - and an EAN
that comes back from eBay's own catalogue is evidence the matcher can use to
confirm that an Amazon offer and an eBay listing are the same item, rather than
a similarity score over two titles.

### What is still not automatic

Asking prices are what the Browse API returns. **What buyers actually paid**
comes from the Marketplace Insights API, which eBay grants per keyset on
application. Without that grant the system reports sold data as unavailable; it
does not quietly substitute asking prices, because a number labelled "sold"
that is really an asking price is worse than no number at all.

The Amazon side has no free equivalent. Its price still has to be entered, or
pasted as a `/dp/` address.

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

### Set your tax position first

The one setting that changes every number on the page. Under Settings → Vat:

- **Small business (§19 UStG)** - the default. No VAT is deducted.
- **Standard** - 19% of every sale price goes to the tax office, and the input
  VAT on the purchase comes back only if you tick the reclaim.

The difference is around a fifth of the margin, which is more than the entire
20 EUR profit floor on a typical order: the same product reads *worth doing*
under one scheme and *not worth it* under the other. The research page states
which one is in force, so you are never reading figures that assume the wrong
answer. See [profit-engine.md](profit-engine.md#vat).

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
