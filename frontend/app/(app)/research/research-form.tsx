"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";

import { Badge, Card, ExternalLink, Money, Table } from "@/components/ui";
import { confidence, percent, riskTone } from "@/lib/format";

import type { EbayListing, EbaySearchResponse, ProfitCalculation } from "@/types/api";

import { analyseCsv, checkOneProduct, findOnEbay, type ResearchActionResult } from "./actions";

const INITIAL: ResearchActionResult = { ok: false };

const FIELD =
  "mt-1 w-full rounded border border-border bg-surface-raised px-3 py-2 text-sm";
const LABEL = "text-xs font-medium text-ink-muted";

// Mirrors the backend extraction, only to give immediate feedback while typing.
// The backend result is what is stored; this is the echo that tells the
// operator the address was understood before they spend time on the prices.
const ASIN = /\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?#]|$)/;
const EBAY_ITEM = /\/itm\/(?:[^/?#]*\/)?(\d{9,15})(?:[/?#]|$)/;
const SHORTENER = /^https?:\/\/(?:www\.)?(?:amzn\.to|amzn\.eu|a\.co|ebay\.us|ebay\.to)\//i;

function readUrl(url: string, pattern: RegExp, label: string) {
  const value = url.trim();
  if (!value) return null;
  if (SHORTENER.test(value)) {
    return { ok: false, text: "Shortened link - open it and copy the full address." };
  }
  const found = value.match(pattern)?.[1];
  return found
    ? { ok: true, text: `${label} ${found}` }
    : { ok: false, text: `No ${label.toLowerCase()} in that address.` };
}

export function ResearchForm({ template }: { template: string }) {
  const [state, formAction, pending] = useActionState(checkOneProduct, INITIAL);
  const [showBulk, setShowBulk] = useState(false);

  // Typed live so the lookup links work before any price is known - that is
  // the order the work actually happens in: look it up, then price it.
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [ean, setEan] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  // Controlled, because picking a real eBay listing fills it in.
  const [targetPrice, setTargetPrice] = useState("");

  const [ebay, setEbay] = useState<EbaySearchResponse | null>(null);
  const [ebayError, setEbayError] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();

  const asin = readUrl(sourceUrl, ASIN, "ASIN");
  const item = readUrl(targetUrl, EBAY_ITEM, "Item number");

  function lookUpOnEbay() {
    setEbayError(null);
    startSearch(async () => {
      const result = await findOnEbay({ q: [brand, model].filter(Boolean).join(" "), ean });
      if (result.ok && result.data) setEbay(result.data);
      else setEbayError(result.message ?? "the lookup failed");
    });
  }

  /** Take a real listing as the eBay side of the comparison. */
  function useListing(listing: EbayListing) {
    if (listing.url) setTargetUrl(listing.url);
    if (listing.price) setTargetPrice(listing.price);
    // eBay's own product codes are better evidence than anything typed by
    // hand, so they fill empty fields - but never overwrite what is there.
    if (!ean && listing.identifiers.EAN) setEan(listing.identifiers.EAN);
    if (!model && listing.identifiers.MPN) setModel(listing.identifiers.MPN);
  }

  const query = [brand, model].filter(Boolean).join(" ").trim();
  const amazonUrl = ean
    ? `https://www.amazon.de/s?k=${encodeURIComponent(ean)}`
    : query
      ? `https://www.amazon.de/s?k=${encodeURIComponent(query)}`
      : null;
  // eBay is searched by brand and model: sellers do not put the EAN in a title.
  const ebaySoldUrl = query
    ? `https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1&_sop=13`
    : null;

  return (
    <>
      <Card
        title="Check a product"
        subtitle="Paste the two pages you are looking at, fill in the prices, and get a verdict."
      >
        <form action={formAction} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="source_url" className={LABEL}>Amazon product link</label>
              <input id="source_url" name="source_url" type="url" spellCheck={false}
                placeholder="https://www.amazon.de/dp/B09XS7JWHH" className={FIELD}
                value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
              <Echo result={asin} />
            </div>
            <div>
              <label htmlFor="target_url" className={LABEL}>eBay listing link</label>
              <input id="target_url" name="target_url" type="url" spellCheck={false}
                placeholder="https://www.ebay.de/itm/123456789012" className={FIELD}
                value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} />
              <Echo result={item} />
            </div>
          </div>
          <p className="text-xs text-ink-muted">
            Optional, but with them the result links back to those exact two offers
            instead of a search.
          </p>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="brand" className={LABEL}>Brand *</label>
              <input id="brand" name="brand" required placeholder="Sony" className={FIELD}
                value={brand} onChange={(e) => setBrand(e.target.value)} />
            </div>
            <div>
              <label htmlFor="model" className={LABEL}>Model *</label>
              <input id="model" name="model" required placeholder="WH-1000XM5" className={FIELD}
                value={model} onChange={(e) => setModel(e.target.value)} />
            </div>
            <div>
              <label htmlFor="ean" className={LABEL}>EAN *</label>
              <input id="ean" name="ean" required placeholder="4548736134584"
                className={`${FIELD} numeric`} value={ean} onChange={(e) => setEan(e.target.value)} />
            </div>
          </div>

          {(amazonUrl || ebaySoldUrl) && (
            <div className="flex flex-wrap items-center gap-4 rounded border border-border bg-surface px-3 py-2">
              <span className="text-xs text-ink-muted">Look it up:</span>
              <ExternalLink href={amazonUrl}>Amazon (buy price)</ExternalLink>
              <ExternalLink href={ebaySoldUrl}>eBay — what it sold for</ExternalLink>
              <button type="button" onClick={lookUpOnEbay} disabled={searching}
                className="ml-auto text-xs font-medium text-accent hover:underline disabled:opacity-60">
                {searching ? "Searching eBay..." : "Find the listing on eBay"}
              </button>
            </div>
          )}

          {ebayError && (
            <p className="rounded border border-caution/30 bg-caution/10 p-3 text-sm text-caution">
              {ebayError}
            </p>
          )}
          {ebay && <EbayResults data={ebay} onPick={useListing} />}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label htmlFor="source_price" className={LABEL}>Amazon price *</label>
              <input id="source_price" name="source_price" required inputMode="decimal"
                placeholder="199.00" className={`${FIELD} numeric`} />
            </div>
            <div>
              <label htmlFor="target_price" className={LABEL}>eBay sold price *</label>
              <input id="target_price" name="target_price" required inputMode="decimal"
                placeholder="319.00" className={`${FIELD} numeric`}
                value={targetPrice} onChange={(e) => setTargetPrice(e.target.value)} />
              <p className="mt-1 text-xs text-ink-muted">What it sold for, not asking prices.</p>
            </div>
            <div>
              <label htmlFor="source_stock" className={LABEL}>In stock on Amazon?</label>
              <select id="source_stock" name="source_stock" defaultValue="IN_STOCK" className={FIELD}>
                <option value="IN_STOCK">Yes, in stock</option>
                <option value="LOW_STOCK">Only a few left</option>
                <option value="OUT_OF_STOCK">Out of stock</option>
                <option value="UNKNOWN">Not sure</option>
              </select>
            </div>
            <div>
              <label htmlFor="source_delivery_days" className={LABEL}>Amazon delivery (days)</label>
              <input id="source_delivery_days" name="source_delivery_days" inputMode="numeric"
                defaultValue="2" className={`${FIELD} numeric`} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={pending}
              className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
              {pending ? "Checking..." : "Is this worth doing?"}
            </button>
            <button type="button" onClick={() => setShowBulk((open) => !open)}
              className="text-xs font-medium text-accent hover:underline">
              {showBulk ? "Hide bulk check" : "Check many at once instead"}
            </button>
          </div>

          {state.message && !state.ok && (
            <p className="rounded border border-negative/30 bg-negative/10 p-3 text-sm text-negative">
              {state.message}
            </p>
          )}
        </form>
      </Card>

      {showBulk && <BulkForm template={template} />}
      {state.ok && state.data && <Results data={state.data} />}
    </>
  );
}

function BulkForm({ template }: { template: string }) {
  const [state, formAction, pending] = useActionState(analyseCsv, INITIAL);
  return (
    <>
      <Card title="Check many at once" subtitle="One row per product. Comma, semicolon or tab separated.">
        <form action={formAction} className="space-y-3">
          <textarea name="csv" rows={8} spellCheck={false} defaultValue={template}
            className="numeric w-full rounded border border-border bg-surface px-3 py-2 text-xs"
            aria-label="Products as CSV" />
          <button type="submit" disabled={pending}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
            {pending ? "Analysing..." : "Analyse all of them"}
          </button>
          {state.message && !state.ok && (
            <p className="rounded border border-negative/30 bg-negative/10 p-3 text-sm text-negative">
              {state.message}
            </p>
          )}
        </form>
      </Card>
      {state.ok && state.data && <Results data={state.data} />}
    </>
  );
}

function Results({ data }: { data: NonNullable<ResearchActionResult["data"]> }) {
  const { summary, opportunities, errors } = data;
  const single = opportunities.length === 1 ? opportunities[0] : null;

  // One product gets a verdict, not a table. It is the question that was asked.
  if (single) {
    const worthIt = single.state === "ACTIONABLE";
    const why =
      single.rejected_reason ??
      single.blocked_reason ??
      (single.decision_reasons[0] ? String(single.decision_reasons[0]) : "");
    return (
      <Card title={single.product?.title ?? "Result"}>
        <div className="flex flex-wrap items-baseline gap-4">
          <Verdict state={single.state} large />
          <span className="text-3xl font-semibold">
            <Money value={single.expected_net_profit} currency={single.currency} signed />
          </span>
          <span className="text-sm text-ink-muted">
            {percent(single.profit_margin)} margin · risk {single.risk_score ?? "—"}/100 ·
            match {confidence(single.match_confidence)}
          </span>
        </div>
        {!worthIt && why && (
          <p className="mt-3 rounded border border-caution/30 bg-caution/10 p-3 text-sm text-caution">
            {why}
          </p>
        )}
        {single.profit && <Breakdown profit={single.profit} />}
        <div className="mt-4 flex flex-wrap gap-4">
          <ExternalLink href={single.links?.source_product}>Open on Amazon</ExternalLink>
          {single.links?.target_product && (
            <ExternalLink href={single.links.target_product}>Open this eBay listing</ExternalLink>
          )}
          <ExternalLink href={single.links?.target_sold}>eBay sold listings</ExternalLink>
          <Link href={`/opportunities/${single.id}`}
            className="text-xs font-medium text-accent hover:underline">
            Full breakdown
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title={`Checked ${summary.analysed} products`}
      subtitle={`${summary.actionable} worth doing · ${summary.rejected} not worth it · ${summary.blocked} blocked`}
    >
      {errors.length > 0 && (
        <div className="mb-3 rounded border border-caution/30 bg-caution/10 p-3">
          <p className="text-sm font-medium text-caution">Some rows could not be read</p>
          <ul className="mt-1 list-inside list-disc text-sm text-ink-muted">
            {errors.map((error) => <li key={error}>{error}</li>)}
          </ul>
        </div>
      )}
      {opportunities.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing was analysed.</p>
      ) : (
        <Table head={["Product", "Verdict", "Net profit", "Margin", "Risk", "Check", "Why"]}>
          {opportunities.map((item) => {
            const why =
              item.rejected_reason ??
              item.blocked_reason ??
              (item.decision_reasons[0] ? String(item.decision_reasons[0]) : "");
            return (
              <tr key={item.id}>
                <td className="max-w-[15rem] px-3 py-2">
                  <Link href={`/opportunities/${item.id}`}
                    className="block truncate font-medium hover:underline"
                    title={item.product?.title ?? undefined}>
                    {item.product?.title ?? item.reference}
                  </Link>
                </td>
                <td className="px-3 py-2"><Verdict state={item.state} /></td>
                <td className="px-3 py-2">
                  <Money value={item.expected_net_profit} currency={item.currency} signed />
                </td>
                <td className="numeric px-3 py-2">{percent(item.profit_margin)}</td>
                <td className="px-3 py-2">
                  <Badge tone={riskTone(item.risk_score)}>{item.risk_score ?? "—"}</Badge>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <ExternalLink href={item.links?.source_product}>Amazon</ExternalLink>
                    <ExternalLink href={item.links?.target_product ?? item.links?.target_sold}>
                      {item.links?.target_product ? "eBay listing" : "eBay sold"}
                    </ExternalLink>
                  </div>
                </td>
                <td className="max-w-xs px-3 py-2 text-xs text-ink-muted">
                  <span className="line-clamp-2">{why}</span>
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </Card>
  );
}

function EbayResults({
  data,
  onPick,
}: {
  data: EbaySearchResponse;
  onPick: (listing: EbayListing) => void;
}) {
  if (!data.available) {
    return (
      <div className="rounded border border-border bg-surface p-3 text-sm text-ink-muted">
        {data.reason}
      </div>
    );
  }
  if (data.listings.length === 0) {
    return (
      <div className="rounded border border-border bg-surface p-3 text-sm text-ink-muted">
        {data.reason ?? `Nothing on eBay for "${data.query}".`}
      </div>
    );
  }
  return (
    <div className="rounded border border-border bg-surface p-3">
      <p className="mb-2 text-xs text-ink-muted">
        {data.listings.length} live listing{data.listings.length === 1 ? "" : "s"}. These are
        asking prices - pick the one you would be competing with, then correct the price to
        what it actually sells for.
      </p>
      <ul className="divide-y divide-border">
        {data.listings.map((listing) => (
          <li key={listing.item_id} className="flex items-baseline gap-3 py-2">
            <span className="numeric w-24 shrink-0 text-sm font-medium">
              {listing.total ?? listing.price} {listing.currency}
            </span>
            <span className="min-w-0 flex-1">
              <ExternalLink href={listing.url}>
                <span className="line-clamp-1">{listing.title}</span>
              </ExternalLink>
              <span className="mt-0.5 block text-xs text-ink-muted">
                {listing.condition.toLowerCase().replace("_", " ")} · item {listing.item_id}
                {listing.seller_feedback ? ` · ${listing.seller_feedback}` : ""}
                {listing.has_identifier ? " · EAN on file" : ""}
              </span>
            </span>
            <button type="button" onClick={() => onPick(listing)}
              className="shrink-0 rounded border border-border px-2 py-1 text-xs font-medium hover:border-accent hover:text-accent">
              Use this one
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Every cent, in the order it leaves the account. */
function Breakdown({ profit }: { profit: ProfitCalculation }) {
  const rows: Array<[string, string]> = [
    ["What you buy it for", profit.source_purchase_cost],
    ["Shipping to you", profit.source_shipping_cost],
    ["eBay fees", profit.marketplace_fees],
    ["Payment fees", profit.payment_fees],
    ["Postage to the buyer", profit.outbound_shipping_cost],
    ["Packaging", profit.packaging_cost],
    ["Expected cost of returns", profit.expected_return_cost],
    ["Risk reserve", profit.risk_reserve],
    ["Other costs", profit.other_variable_costs],
    ["VAT, less input tax", profit.net_vat],
  ];
  const shown = rows.filter(([, amount]) => Number(amount) !== 0);

  return (
    <div className="mt-4 rounded border border-border bg-surface p-3">
      <table className="w-full text-sm">
        <tbody>
          <tr>
            <td className="py-1">Sale price</td>
            <td className="numeric py-1 text-right font-medium">
              <Money value={profit.sale_revenue} currency={profit.currency} />
            </td>
          </tr>
          {shown.map(([label, amount]) => {
            // Costs are subtracted. Net VAT is the one line that can come
            // back the other way, when more input tax was deductible than
            // was charged on the sale - so it is shown as the credit it is.
            const credit = Number(amount) < 0;
            return (
              <tr key={label} className="text-ink-muted">
                <td className="py-1 pl-3">{label}</td>
                <td className="numeric py-1 text-right">
                  {credit ? "+" : "−"}
                  <Money
                    value={credit ? amount.replace("-", "") : amount}
                    currency={profit.currency}
                  />
                </td>
              </tr>
            );
          })}
          <tr className="border-t border-border font-medium">
            <td className="py-1">Left over</td>
            <td className="numeric py-1 text-right">
              <Money value={profit.net_profit} currency={profit.currency} signed />
            </td>
          </tr>
        </tbody>
      </table>
      {profit.assumptions.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-border pt-2 text-xs text-ink-muted">
          {profit.assumptions.map((assumption) => (
            <li key={String(assumption)}>{String(assumption)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Echo({ result }: { result: { ok: boolean; text: string } | null }) {
  if (!result) return null;
  return (
    <p className={`mt-1 text-xs ${result.ok ? "text-positive" : "text-caution"}`}>
      {result.ok ? "✓ " : ""}{result.text}
    </p>
  );
}

function Verdict({ state, large = false }: { state: string; large?: boolean }) {
  const label =
    state === "ACTIONABLE" ? "Worth doing"
    : state === "BLOCKED" ? "Blocked"
    : state === "REJECTED" ? "Not worth it"
    : state;
  const tone = state === "ACTIONABLE" ? "positive" : state === "BLOCKED" ? "negative" : "caution";
  if (!large) return <Badge tone={tone}>{label}</Badge>;
  return (
    <span className={`text-lg font-semibold ${
      tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : "text-caution"
    }`}>
      {label}
    </span>
  );
}
