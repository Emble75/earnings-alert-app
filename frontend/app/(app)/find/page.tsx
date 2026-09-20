import { Card, PageHeader } from "@/components/ui";

import { ScanForm } from "./scan-form";

export const dynamic = "force-dynamic";

export default function FindPage() {
  return (
    <>
      <PageHeader
        title="Find deals"
        description="Search eBay for products that sell, and get the exact Amazon price each one would have to beat."
      />

      <Card title="How this works, and what it cannot do">
        <p className="text-sm text-ink-muted">
          The search starts on <strong className="text-ink">eBay</strong>, because eBay is
          where the demand is. A product with several sellers at similar prices is
          evidence that it sells; a cheap Amazon offer for something nobody buys is not
          an opportunity.
        </p>
        <p className="mt-2 text-sm text-ink-muted">
          For each product found, the profit engine is run backwards to give one number:
          the <strong className="text-ink">most you could pay on Amazon</strong> and still
          clear your minimum profit and margin, after every cost.
        </p>
        <p className="mt-3 border-t border-border pt-3 text-xs text-ink-muted">
          There is no free source of Amazon prices, so the system does not have one and
          does not pretend to. It gives you a short list and the number to beat; you open
          the Amazon link and compare. Paste a promising one into{" "}
          <strong className="text-ink">Check a product</strong> for the full breakdown.
        </p>
      </Card>

      <ScanForm />
    </>
  );
}
