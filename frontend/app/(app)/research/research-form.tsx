"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Badge, Card, ExternalLink, Money, Table } from "@/components/ui";
import { confidence, percent } from "@/lib/format";
import { riskTone } from "@/lib/format";

import { analyseCsv, type ResearchActionResult } from "./actions";

const INITIAL: ResearchActionResult = { ok: false };

export function ResearchForm({ template }: { template: string }) {
  const [state, formAction, pending] = useActionState(analyseCsv, INITIAL);

  return (
    <>
      <Card
        title="Paste your products"
        subtitle="One row per product. Only title, source_price and target_price are required — but include the EAN, or the system cannot confirm the two sides are the same item."
      >
        <form action={formAction} className="space-y-3">
          <textarea
            name="csv"
            rows={10}
            spellCheck={false}
            defaultValue={template}
            className="numeric w-full rounded border border-border bg-surface px-3 py-2 text-xs"
            aria-label="Products as CSV"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {pending ? "Analysing..." : "Analyse these products"}
            </button>
            <p className="text-xs text-ink-muted">
              Comma, semicolon and tab separated files all work, as do European
              numbers like <span className="numeric">199,00</span>.
            </p>
          </div>
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

  return (
    <Card
      title={`Analysed ${summary.analysed} product${summary.analysed === 1 ? "" : "s"}`}
      subtitle={`${summary.actionable} worth acting on · ${summary.rejected} rejected · ${summary.blocked} blocked`}
    >
      {errors.length > 0 && (
        <div className="mb-3 rounded border border-caution/30 bg-caution/10 p-3">
          <p className="text-sm font-medium text-caution">Some rows could not be read</p>
          <ul className="mt-1 list-inside list-disc text-sm text-ink-muted">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      {opportunities.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing was analysed.</p>
      ) : (
        <Table head={["Product", "Verdict", "Net profit", "Margin", "Risk", "Match", "Check", ""]}>
          {opportunities.map((item) => {
            const why =
              item.rejected_reason ??
              item.blocked_reason ??
              (item.decision_reasons[0] ? String(item.decision_reasons[0]) : "");
            return (
              <tr key={item.id}>
                <td className="max-w-[16rem] px-3 py-2">
                  <div className="truncate font-medium" title={item.product?.title ?? undefined}>
                    {item.product?.title ?? item.reference}
                  </div>
                  <div className="numeric truncate text-xs text-ink-muted">
                    {item.product?.primary_identifier_value ?? item.reference}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <Verdict state={item.state} />
                </td>
                <td className="px-3 py-2">
                  <Money value={item.expected_net_profit} currency={item.currency} signed />
                </td>
                <td className="numeric px-3 py-2">{percent(item.profit_margin)}</td>
                <td className="px-3 py-2">
                  <Badge tone={riskTone(item.risk_score)}>{item.risk_score ?? "—"}</Badge>
                </td>
                <td className="numeric px-3 py-2">{confidence(item.match_confidence)}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <ExternalLink href={item.links?.source_product}>Amazon</ExternalLink>
                    <ExternalLink href={item.links?.target_sold}>eBay sold</ExternalLink>
                  </div>
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="max-w-xs truncate text-xs text-ink-muted" title={why}>
                    {why}
                  </div>
                  <Link
                    href={`/opportunities/${item.id}`}
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    Details
                  </Link>
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </Card>
  );
}

function Verdict({ state }: { state: string }) {
  if (state === "ACTIONABLE") return <Badge tone="positive">Worth doing</Badge>;
  if (state === "BLOCKED") return <Badge tone="negative">Blocked</Badge>;
  if (state === "REJECTED") return <Badge tone="caution">Not worth it</Badge>;
  return <Badge>{state}</Badge>;
}
