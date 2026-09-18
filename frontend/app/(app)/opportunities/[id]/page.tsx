import { notFound } from "next/navigation";

import { ActionButton } from "@/components/actions";
import { Badge, Card, DefinitionList, ErrorNotice, Money, PageHeader, StateBadge, Table } from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";
import { confidence, dateTime, money, percent, relativeAge, riskTone, titleCase } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  if (Number.isNaN(numericId)) notFound();

  let detail;
  try {
    detail = await api.opportunity(numericId);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    return (
      <ErrorNotice
        title="Could not load this opportunity"
        message={error instanceof ApiRequestError ? error.message : String(error)}
      />
    );
  }

  const base = detail.profit_calculations.find((c) => c.scenario === "BASE_CASE");
  const worst = detail.profit_calculations.find((c) => c.scenario === "WORST_CASE");
  const best = detail.profit_calculations.find((c) => c.scenario === "BEST_CASE");
  const risk = detail.risk_assessments.at(-1);

  const costRows: Array<[string, string | null]> = base
    ? [
        ["Source purchase cost", base.source_purchase_cost],
        ["Source → operator shipping", base.source_shipping_cost],
        ["Marketplace fees", base.marketplace_fees],
        ["Payment fees", base.payment_fees],
        ["Fulfillment cost", base.fulfillment_cost],
        ["Operator → customer shipping", base.outbound_shipping_cost],
        ["Packaging", base.packaging_cost],
        ["Expected return cost", base.expected_return_cost],
        ["Risk reserve", base.risk_reserve],
        ["Other variable costs", base.other_variable_costs],
      ]
    : [];

  return (
    <>
      <PageHeader
        title={detail.reference}
        description={`Discovered ${dateTime(detail.created_at)}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <ActionButton kind="revalidate-opportunity" id={numericId} label="Revalidate" />
            {detail.state === "ACTIONABLE" && (
              <ActionButton
                kind="publish-listing"
                id={numericId}
                label="Create and publish listing"
                variant="primary"
                confirm="Publishing makes this a live offer to buyers. The system will revalidate first. Continue?"
              />
            )}
            <ActionButton kind="reject-opportunity" id={numericId} label="Reject" variant="danger" />
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <StateBadge state={detail.state} />
        {detail.risk_score !== null && (
          <Badge tone={riskTone(detail.risk_score)}>Risk {detail.risk_score}/100</Badge>
        )}
        {detail.match_confidence && <Badge>Match {confidence(detail.match_confidence)}</Badge>}
        {detail.staleness.length > 0 && <Badge tone="caution">Stale data</Badge>}
      </div>

      {detail.blocked_reason && (
        <ErrorNotice title="Blocked" message={detail.blocked_reason} />
      )}
      {detail.rejected_reason && (
        <ErrorNotice title="Rejected" message={detail.rejected_reason} />
      )}
      {detail.staleness.length > 0 && (
        <Card title="Data freshness" subtitle="These inputs must be refreshed before money is committed">
          <ul className="list-inside list-disc space-y-1 text-sm text-caution">
            {detail.staleness.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Cost breakdown" subtitle="Base case. Every component is shown separately.">
          {base ? (
            <>
              <DefinitionList
                rows={[
                  ["Sale revenue", <Money key="r" value={base.sale_revenue} currency={base.currency} />],
                  ...costRows.map(([label, value]) => [
                    label,
                    <Money key={label} value={value ? `-${value}` : null} currency={base.currency} />,
                  ] as [string, React.ReactNode]),
                ]}
              />
              <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
                <span className="text-sm font-semibold">Expected net profit</span>
                <span className="text-lg font-semibold">
                  <Money value={base.net_profit} currency={base.currency} signed />
                </span>
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
                <div><dt className="text-ink-muted">Margin</dt><dd className="numeric font-medium">{percent(base.profit_margin)}</dd></div>
                <div><dt className="text-ink-muted">ROI</dt><dd className="numeric font-medium">{percent(base.roi)}</dd></div>
                <div><dt className="text-ink-muted">Capital</dt><dd className="numeric font-medium">{money(base.capital_required, base.currency)}</dd></div>
              </dl>
              {base.assumptions.length > 0 && (
                <ul className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-ink-muted">
                  {base.assumptions.map((note) => <li key={note}>{note}</li>)}
                </ul>
              )}
            </>
          ) : (
            <p className="text-sm text-ink-muted">No profit calculation yet.</p>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="Scenarios" subtitle="The base case is the decision metric">
            <Table head={["Scenario", "Net profit", "Margin", "ROI"]}>
              {[best, base, worst].filter(Boolean).map((c) => (
                <tr key={c!.scenario}>
                  <td className="px-3 py-2">{titleCase(c!.scenario)}</td>
                  <td className="px-3 py-2"><Money value={c!.net_profit} currency={c!.currency} signed /></td>
                  <td className="numeric px-3 py-2">{percent(c!.profit_margin)}</td>
                  <td className="numeric px-3 py-2">{percent(c!.roi)}</td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title="Freshness" subtitle="Nothing irreversible runs on stale data">
            <DefinitionList
              rows={[
                ["Source price", relativeAge(detail.source_price_timestamp)],
                ["Inventory", relativeAge(detail.inventory_timestamp)],
                ["Last revalidated", relativeAge(detail.last_revalidated_at)],
              ]}
            />
          </Card>
        </div>
      </div>

      {risk && (
        <Card
          title={`Risk score ${risk.score}/100 (${risk.level})`}
          subtitle={`Deterministic, reproducible, model version ${risk.risk_model_version}`}
        >
          {risk.blockers.length > 0 && (
            <div className="mb-3 rounded border border-negative/30 bg-negative/10 p-3">
              <p className="text-sm font-medium text-negative">Hard blockers</p>
              <ul className="mt-1 list-inside list-disc text-sm text-ink-muted">
                {risk.blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            </div>
          )}
          <Table head={["Factor", "Score", "Weight", "Reason"]}>
            {risk.factors.map((factor) => (
              <tr key={factor.factor}>
                <td className="px-3 py-2">{titleCase(factor.factor)}</td>
                <td className="px-3 py-2">
                  <Badge tone={riskTone(factor.score)}>{factor.score}</Badge>
                </td>
                <td className="numeric px-3 py-2 text-ink-muted">{factor.weight}</td>
                <td className="px-3 py-2 text-ink-muted">{factor.reason}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {detail.decision_reasons.length > 0 && (
        <Card title="Decision" subtitle={detail.decision ?? undefined}>
          <ul className="list-inside list-disc space-y-1 text-sm text-ink-muted">
            {detail.decision_reasons.map((reason) => <li key={String(reason)}>{String(reason)}</li>)}
          </ul>
        </Card>
      )}
    </>
  );
}
