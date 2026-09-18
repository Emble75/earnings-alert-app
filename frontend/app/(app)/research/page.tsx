import { Card, ErrorNotice, PageHeader } from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";

import { ResearchForm } from "./research-form";

export const dynamic = "force-dynamic";

export default async function ResearchPage() {
  let template = "";
  let notes: string[] = [];
  try {
    const payload = await api.researchTemplate();
    template = payload.template_csv;
    notes = payload.notes;
  } catch (error) {
    return (
      <ErrorNotice
        title="Could not load the research tool"
        message={error instanceof ApiRequestError ? error.message : String(error)}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Research"
        description="Analyse real products you have looked up yourself. No marketplace account needed — the same profit, risk and matching engine runs on the numbers you enter."
      />

      <Card title="How this works">
        <ol className="list-inside list-decimal space-y-2 text-sm text-ink-muted">
          <li>
            Find a product on Amazon. Note its price, its EAN (on the product
            page under &ldquo;Product information&rdquo;), and whether it is in stock.
          </li>
          <li>
            Search the same EAN on eBay. Note what comparable items{" "}
            <strong className="text-ink">actually sell for</strong> — completed
            listings, not the most optimistic asking price.
          </li>
          <li>Put both into a row below and analyse.</li>
        </ol>
        <ul className="mt-4 space-y-1 border-t border-border pt-3 text-xs text-ink-muted">
          {notes.map((note) => (
            <li key={note}>· {note}</li>
          ))}
        </ul>
      </Card>

      <ResearchForm template={template} />
    </>
  );
}
