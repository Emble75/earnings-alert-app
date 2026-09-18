# Amazon → eBay Sell-First Arbitrage Platform

Finds products that can be bought on Amazon and sold on eBay, **lists them
before buying**, and only spends money once a sale has happened and every
input has been re-checked against live data.

> This repository also contains an earlier, unrelated Streamlit
> "earnings alert" prototype at the repository root
> (`streamlit_app.py`, `scraper.py`, `gpt_analyzer.py`,
> `earnings_watchlist.csv`). It is untouched and still deployable — see
> [below](#the-earlier-earnings-alert-app).

## Quick start

No Docker, no database server, nothing to configure:

```bash
python3 start.py        # macOS / Linux
py start.py             # Windows
```

It sets everything up, starts both servers, prints a login and opens
http://localhost:3000. You need [Python 3.11+](https://www.python.org/downloads/)
and [Node.js 20+](https://nodejs.org/) installed; the script checks and tells
you if either is missing.

This starts in **research mode**: it analyses real products but is
structurally incapable of listing, buying or shipping anything. Go to
**Research** in the menu to analyse your own products - no Amazon or eBay
developer account required. See [docs/research-mode.md](docs/research-mode.md).

<details>
<summary>With Docker instead (adds PostgreSQL, Redis and background workers)</summary>

```bash
cp .env.example .env          # set BOOTSTRAP_USER_PASSWORD
docker compose up
```

- Console: http://localhost:3000
- API docs: http://localhost:8000/docs

Demo mode is on by default. Seed it with
`python scripts/seed_demo.py --full-order`.
</details>

## The four modes

| Mode | Data | Can it act? | For |
| --- | --- | --- | --- |
| **Research** | Real, including your own entered products | **No** - blocked at three layers | Finding out whether this works for you |
| Demo | Built-in catalogue | No | Seeing the system run end to end |
| Simulation | Real | Simulated only | Testing the full workflow before going live |
| Live | Real | Yes, with one approval per purchase | Trading |

Research mode is the only one that is safe to point at live credentials,
because it removes the write paths rather than relying on a flag.

## Why sell-first

Buying inventory and hoping it sells carries inventory risk. Listing first
carries *supply* risk instead, which is the risk this system is built to
manage: the moment a buyer commits, it re-verifies — against live data — that
the item can still be sourced at a price that leaves a profit, and asks for
one approval before spending anything.

```
Discover → Match → Price → Profit → Risk → Compliance → ACTIONABLE
  → Listing candidate → revalidate → LISTED
    → SALE → mandatory live revalidation → APPROVAL_REQUIRED
      → one approval → purchase → receive → inspect → repack
        → ship → tracking → delivered → realized profit
```

## What the system refuses to do

Each of these is enforced by a mechanism and covered by a test.

**Use floating point for money.** Every amount is a `Decimal` inside a `Money`
value object, persisted as integer cents. `Money(1.5)` raises `TypeError`, and
so does binding a float to a money column.

**Charge you for your own time.** Version 1 fulfils by hand. There is no
labour rate, handling charge, warehouse allocation or opportunity cost
anywhere in the profit engine, and a test fails if one is ever added. Twenty
minutes of packing does not change the net cash profit. The operational
exposure that manual fulfilment creates is scored by the *risk* engine
instead, which is the honest place for it.

**Buy without an approval.** `APPROVED` is reachable only from
`APPROVAL_REQUIRED`, which is reachable only from `REVALIDATION_REQUIRED`.
`SOURCE_PURCHASE_PENDING` has exactly one predecessor. An unapproved purchase
is unreachable, not merely discouraged.

**Act on stale data.** Every observation is timestamped and re-read before
every commitment. Missing data counts as stale.

**Believe a price gap.** A target/source ratio past the configured threshold
produces a hard blocker, not a risk deduction. During development the demo
catalogue's trap — a €139 watch against a €479 listing — scored 24/100 as a
weighted deduction and would have been shown as a €141 opportunity. It now
blocks and goes to review.

**Match on titles.** Identifiers are checksum-validated; a broken check digit
is recorded as evidence of nothing. Variant, condition and pack-quantity
disagreements block rather than deduct. Confidence is ceilinged by evidence
class, so a title-only match cannot reach the 95 default threshold.

**Act at all, in research mode.** The providers are wrapped so `purchase`,
`publish_listing` and `upload_tracking` raise rather than execute; the
services refuse independently; and compliance blocks it a third time.

**Buy twice after a crash.** Purchases, listings, labels and tracking uploads
are idempotency-keyed with unique constraints behind them.

**Pay more than you approved.** The purchase carries the approved source price
as a hard ceiling. A price move between approval and execution fails the order
and releases the capital, rather than quietly eating the margin.

## Defaults

```
MINIMUM_NET_PROFIT       = €20.00      MAX_CAPITAL_EXPOSURE  = €2000
MINIMUM_PROFIT_MARGIN    = 15%         MAX_CAPITAL_PER_ORDER = €400
MINIMUM_MATCH_CONFIDENCE = 95          MAX_DAILY_CAPITAL     = €1000
MAXIMUM_RISK_SCORE       = 35          MAX_DAILY_ORDERS      = 10
AUTOMATION_LEVEL         = 2           MAX_UNITS_PER_PRODUCT = 3
```

All of them are editable at runtime in Settings and stored in the database,
not the environment, so every change is auditable. The target is meaningful
profit, not a long list: on the demo catalogue, 10 discovered opportunities
produce 3 actionable ones, and the other 7 are rejected or blocked with a
stated reason.

## The profit calculation

```
eBay sale price:                    €159.99
Amazon purchase price:             -€100.00
eBay fees:                          -€24.00
Payment fees:                        -€0.00
Amazon → operator shipping:          -€0.00
Fulfillment cost:                    -€0.00     ← manual handling is not a cash cost
Packaging:                           -€1.00
Operator → customer shipping:        -€5.99
Expected return cost:                -€0.00
Risk reserve:                        -€4.00
------------------------------------------
Expected net profit:                 €25.00     margin 15.63%
```

That exact case is a test
(`tests/test_profit_engine.py::test_critical_case_yields_exactly_twenty_five_euro`)
and asserts `Decimal("25.00")`, not a float comparison.

## Stack

FastAPI · SQLAlchemy 2 · Alembic · PostgreSQL 16 · Redis · Celery · Pydantic v2
· Next.js 15 · TypeScript · Tailwind

## Verification

```bash
./scripts/check.sh
```

Current state: **174 backend tests pass**, ruff clean, `alembic check` reports
no drift against PostgreSQL 16, frontend typecheck and lint clean, production
build succeeds, and all 14 console pages render against a live backend.

## Documentation

Start at [docs/index.md](docs/index.md). The
[architecture](docs/architecture.md) document states the system's **known
limitations** plainly, including the fact that the live marketplace adapters
speak a documented gateway contract rather than Amazon SP-API and eBay Sell
API wire formats — that mapping is the remaining integration work and must be
done with credentials in hand.

## Before going live

Read the [production checklist](docs/deployment.md#production-checklist). In
short: set your real fee schedules, set capital limits you can afford to lose,
stay in simulation mode until expected-vs-realized looks right, and leave the
automation level at 2 until you trust the numbers.

---

## The earlier earnings-alert app

The repository root still contains a small Streamlit tool that checks which
companies report quarterly results today and summarises the IR release with
GPT. It is unrelated to the arbitrage platform and is left exactly as it was
so its Streamlit Cloud deployment (which points at `streamlit_app.py`) keeps
working.

```bash
pip install -r requirements.txt
streamlit run streamlit_app.py
```

It needs `OPENAI_API_KEY` in a `.env` file or as a Streamlit secret.
