"use client";

import { useActionState } from "react";

import { Card, EmptyState, ExternalLink, Money, Table } from "@/components/ui";
import type { Candidate, ScanResponse } from "@/types/api";

import { runScan, type ScanActionResult } from "./actions";

const INITIAL: ScanActionResult = { ok: false };

const FIELD =
  "mt-1 w-full rounded border border-border bg-surface-raised px-3 py-2 text-sm";
const LABEL = "text-xs font-medium text-ink-muted";

export function ScanForm() {
  const [state, formAction, pending] = useActionState(runScan, INITIAL);

  return (
    <>
      <Card
        title="Scan eBay"
        subtitle="Search a slice of eBay Germany, and get back the products worth pricing against Amazon."
      >
        <form action={formAction} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="query" className={LABEL}>What to look through</label>
              <input id="query" name="query" placeholder="bluetooth kopfhörer" className={FIELD} />
              <p className="mt-1 text-xs text-ink-muted">
                A product type, not one product. Narrow beats broad.
              </p>
            </div>
            <div>
              <label htmlFor="category_ids" className={LABEL}>
                eBay category number (optional)
              </label>
              <input id="category_ids" name="category_ids" placeholder="9355"
                className={`${FIELD} numeric`} />
              <p className="mt-1 text-xs text-ink-muted">
                From the address bar of an eBay category page, after{" "}
                <span className="numeric">/b/</span>. Leave empty to search by words.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <label htmlFor="min_price" className={LABEL}>Cheapest to consider</label>
              <input id="min_price" name="min_price" inputMode="decimal" defaultValue="40"
                className={`${FIELD} numeric`} />
            </div>
            <div>
              <label htmlFor="max_price" className={LABEL}>Dearest to consider</label>
              <input id="max_price" name="max_price" inputMode="decimal" placeholder="your capital limit"
                className={`${FIELD} numeric`} />
            </div>
            <div>
              <label htmlFor="pages" className={LABEL}>Pages of listings</label>
              <select id="pages" name="pages" defaultValue="1" className={FIELD}>
                <option value="1">1 (up to 200)</option>
                <option value="2">2 (up to 400)</option>
                <option value="3">3 (up to 600)</option>
              </select>
            </div>
            <div>
              <label htmlFor="detail_budget" className={LABEL}>Products to look up</label>
              <input id="detail_budget" name="detail_budget" inputMode="numeric" defaultValue="40"
                className={`${FIELD} numeric`} />
              <p className="mt-1 text-xs text-ink-muted">Each one costs an eBay call.</p>
            </div>
          </div>

          <button type="submit" disabled={pending}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
            {pending ? "Scanning eBay..." : "Find deals"}
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

function Results({ data }: { data: ScanResponse }) {
  if (!data.available) {
    return (
      <Card title="Scanning is not switched on">
        <p className="text-sm text-ink-muted">{data.notes[0]}</p>
      </Card>
    );
  }

  const workable = data.candidates.filter((c) => c.max_amazon_price !== null);
  const hopeless = data.candidates.length - workable.length;

  return (
    <Card
      title={`${workable.length} worth checking`}
      subtitle={
        `${data.listings_seen} listings · ${data.products_found} distinct products · ` +
        `${data.detail_lookups} looked up` +
        (hopeless > 0 ? ` · ${hopeless} cannot work at any price` : "")
      }
    >
      {data.notes.length > 0 && (
        <ul className="mb-3 space-y-1 rounded border border-border bg-surface p-3 text-xs text-ink-muted">
          {data.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}

      {workable.length === 0 ? (
        <EmptyState
          title="Nothing here clears your thresholds"
          body="Every product found sells for too little to carry the fees, postage and your minimum profit. Try a dearer price band, or a category where the items are worth more."
        />
      ) : (
        <>
          <p className="mb-3 rounded border border-accent/30 bg-accent/5 p-3 text-sm">
            Open the Amazon link on a row. <strong>If it costs less than the price in
            the &ldquo;buy below&rdquo; column, it is worth doing.</strong> That figure already has
            eBay fees, postage, packaging, returns, your risk reserve and VAT taken off.
          </p>
          <Table
            head={["Product", "Sells for", "Buy below", "Headroom", "Sellers", "Check"]}
          >
            {workable.map((candidate) => <Row key={candidate.item_id} candidate={candidate} />)}
          </Table>
        </>
      )}
    </Card>
  );
}

function Row({ candidate }: { candidate: Candidate }) {
  return (
    <tr>
      <td className="max-w-[22rem] px-3 py-2">
        <ExternalLink href={candidate.item_url}>
          <span className="line-clamp-1">{candidate.title}</span>
        </ExternalLink>
        <span className="mt-0.5 block text-xs text-ink-muted">
          {candidate.ean ? `EAN ${candidate.ean}` : "no EAN on the listing"}
          {candidate.brand ? ` · ${candidate.brand}` : ""}
        </span>
      </td>
      <td className="numeric px-3 py-2">
        <Money value={candidate.ebay_price} />
        <span className="mt-0.5 block text-xs text-ink-muted">
          <Money value={candidate.lowest} />–<Money value={candidate.highest} />
        </span>
      </td>
      <td className="numeric px-3 py-2 font-semibold text-positive">
        <Money value={candidate.max_amazon_price} />
      </td>
      <td className="numeric px-3 py-2 text-ink-muted">{candidate.headroom_percent}%</td>
      <td className="numeric px-3 py-2 text-ink-muted">{candidate.listing_count}</td>
      <td className="px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <ExternalLink href={candidate.amazon_search_url}>Amazon</ExternalLink>
          <ExternalLink href={candidate.sold_url}>eBay sold</ExternalLink>
        </div>
      </td>
    </tr>
  );
}
