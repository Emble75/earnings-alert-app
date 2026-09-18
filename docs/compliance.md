# Compliance

Server-side gates that run before anything touches a marketplace, a carrier or
the operator's money. Every verdict is persisted with the rules that produced
it, so "why did the system do that?" is answerable months later.

## What this layer is for

Making sure we only list what we can actually and lawfully supply, that the
buyer gets accurate information, and that the operator's own limits are
respected.

## What it is not for

This codebase contains no capability to evade marketplace policy, misrepresent
the seller, falsify the origin of goods, deceive a buyer, manipulate tracking,
conceal a sourcing arrangement or work around an account restriction — and it
must not gain one. **A compliance rule can only ever stop an action.** There is
no rule that enables one, and no configuration flag that turns the gates off
for a specific order.

## The gates

| Check | Runs before | Blocks on |
| --- | --- | --- |
| `checkListing` | Publishing | Missing title, undeclared condition, condition that does not match the goods we can source, restricted category, no price, unverified match, inactive account |
| `checkOrder` | Approving and again before purchase | Source out of stock or unknown, insufficient quantity, a delivery promise the source cannot meet, unverified match |
| `checkFulfillment` | Dispatch | Incomplete address, destination outside the configured area, inspection not passed, tracking without a carrier |
| `checkMarketplacePolicy` | Listing | Restricted category, implausible handling time |
| `checkSellerRequirements` | Listing | Inactive account, handling times that damage standing |

Outcomes are `PASS`, `REVIEW`, `REJECT` or `BLOCK`. Any blocking result stops
the action; `ComplianceService.require()` raises `ComplianceBlockedError`
rather than returning a value the caller might ignore.

## Three rules worth calling out

**Condition accuracy.** Listing an item in a condition it is not is a
misrepresentation to the buyer. There is no setting that permits it.

**Supply before sale.** Unknown source availability blocks the order. We do not
commit to supplying something we cannot confirm we can obtain.

**Tracking integrity.** Tracking must name the carrier that actually holds the
parcel. A tracking number without a carrier cannot be verified and is refused.

## Where it runs

- Opportunity evaluation, before an opportunity becomes `ACTIONABLE`
- Listing validation, before publication
- Order revalidation, before an approval screen is shown
- Immediately before the source purchase, as a final gate
- Before dispatch

The check immediately before the purchase is not redundant with the one at
revalidation: time passes between them, and stock can disappear in that time.
