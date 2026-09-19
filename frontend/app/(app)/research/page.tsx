import Link from "next/link";

import { Card, ErrorNotice, PageHeader } from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";

import { ResearchForm } from "./research-form";

export const dynamic = "force-dynamic";

export default async function ResearchPage() {
  let template = "";
  let notes: string[] = [];
  // The tax position silently changes every number on this page, so it is
  // stated here rather than left to be discovered in Settings.
  let vatScheme: string | null = null;
  try {
    const payload = await api.researchTemplate();
    template = payload.template_csv;
    notes = payload.notes;
    try {
      vatScheme = String((await api.settings()).values.vat_scheme ?? "");
    } catch {
      vatScheme = null;
    }
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
        title="Check a product"
        description="Is there money in it? Type the brand, model and EAN, open the two lookup links, enter what you see, and get an answer."
      />

      {vatScheme && (
        <p className="rounded border border-border bg-surface px-3 py-2 text-xs text-ink-muted">
          {vatScheme === "STANDARD"
            ? "VAT is deducted from every sale price below (standard scheme)."
            : "No VAT is deducted: you are set up as a small business (§19 UStG)."}{" "}
          <Link href="/settings" className="font-medium text-accent hover:underline">
            Change
          </Link>
          {vatScheme !== "STANDARD" &&
            " - if you are actually on the standard scheme, every figure here is about a fifth too high."}
        </p>
      )}

      <Card title="The three numbers that decide it">
        <ol className="list-inside list-decimal space-y-1.5 text-sm text-ink-muted">
          <li>
            What you pay on <strong className="text-ink">Amazon</strong>.
          </li>
          <li>
            What it <strong className="text-ink">actually sold for</strong> on eBay —
            completed sales, not what hopeful sellers are asking.
          </li>
          <li>Whether Amazon can deliver it in time.</li>
        </ol>
        <p className="mt-3 border-t border-border pt-3 text-xs text-ink-muted">
          Everything else — eBay fees, postage, packaging, returns, a risk
          reserve — is worked out for you. The EAN is what proves the Amazon item
          and the eBay listing are the same product; without it the answer would
          be a guess, so it is required.
        </p>
      </Card>

      <ResearchForm template={template} />
    </>
  );
}
