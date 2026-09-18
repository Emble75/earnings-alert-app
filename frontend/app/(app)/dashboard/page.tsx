import { Card, EmptyState, ErrorNotice, LinkButton, Money, PageHeader, Stat, StateBadge, Table } from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";
import { money } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let analytics;
  try {
    analytics = await api.analytics();
  } catch (error) {
    return (
      <ErrorNotice
        title="Could not load the dashboard"
        message={error instanceof ApiRequestError ? error.message : String(error)}
      />
    );
  }

  const d = analytics.dashboard;
  const approvals = d.pending_approvals > 0 ? await api.pendingApprovals() : [];
  const riskTotal = Object.values(d.risk_distribution).reduce((a, b) => a + b, 0);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Counts here reflect only opportunities that clear the configured profit, margin, risk and match thresholds."
        actions={<LinkButton href="/opportunities" variant="primary">View opportunities</LinkButton>}
      />

      {approvals.length > 0 && (
        <Card
          title={`${approvals.length} order${approvals.length === 1 ? "" : "s"} waiting for approval`}
          subtitle="A sale has occurred. The source purchase needs one approval before anything is bought."
        >
          <Table head={["Order", "Sale", "Expected profit", "Worst case", "Capital", "Risk", ""]}>
            {approvals.map((order) => (
              <tr key={order.id}>
                <td className="px-3 py-2 font-medium">{order.reference}</td>
                <td className="px-3 py-2"><Money value={order.sale_price} currency={order.currency} /></td>
                <td className="px-3 py-2"><Money value={order.expected_net_profit} currency={order.currency} signed /></td>
                <td className="px-3 py-2"><Money value={order.worst_case_net_profit} currency={order.currency} signed /></td>
                <td className="px-3 py-2"><Money value={order.capital_required} currency={order.currency} /></td>
                <td className="numeric px-3 py-2">{order.risk_score ?? "—"}</td>
                <td className="px-3 py-2 text-right">
                  <LinkButton href={`/orders/${order.id}`} variant="primary">Review</LinkButton>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Opportunities today" value={d.opportunities_today} hint={`${d.blocked_opportunities} blocked, ${d.failed_opportunities} failed`} />
        <Stat label="Above threshold" value={d.opportunities_above_threshold} hint="clearing every configured filter" />
        <Stat label="Average expected profit" value={money(d.average_expected_profit, d.currency)} />
        <Stat label="Total expected profit" value={money(d.total_expected_profit, d.currency)} hint="across qualifying opportunities" />
        <Stat label="Actionable" value={d.actionable_count} hint={`${d.listed_count} listed`} />
        <Stat
          label="Open orders"
          value={d.orders_open}
          hint={`${d.pending_approvals} awaiting approval`}
          tone={d.pending_approvals > 0 ? "caution" : undefined}
        />
        <Stat label="Capital exposed" value={money(d.capital_exposed, d.currency)} hint="reserved or committed" />
        <Stat
          label="Realized profit"
          value={money(d.realized_profit_total, d.currency)}
          hint={`variance ${money(d.profit_variance_total, d.currency)} against expectation`}
          tone={d.realized_profit_total.startsWith("-") ? "negative" : "positive"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Risk distribution" subtitle="Deterministic scores across scored opportunities">
          {riskTotal === 0 ? (
            <EmptyState title="Nothing scored yet" body="Run discovery to populate the risk distribution." />
          ) : (
            <ul className="space-y-2">
              {Object.entries(d.risk_distribution).map(([level, count]) => (
                <li key={level} className="flex items-center gap-3">
                  <span className="w-20 text-xs text-ink-muted">{level}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded bg-border">
                    <div
                      className={`h-full ${level === "LOW" ? "bg-positive" : level === "MODERATE" ? "bg-accent" : "bg-negative"}`}
                      style={{ width: `${Math.round((count / riskTotal) * 100)}%` }}
                    />
                  </div>
                  <span className="numeric w-8 text-right text-xs">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Why opportunities were filtered out" subtitle="The false-positive report">
          {Object.keys(analytics.rejection_breakdown).length === 0 ? (
            <EmptyState title="Nothing rejected yet" body="Rejections and blocks are grouped here by reason." />
          ) : (
            <ul className="space-y-1 text-sm">
              {Object.entries(analytics.rejection_breakdown).slice(0, 8).map(([reason, count]) => (
                <li key={reason} className="flex items-start justify-between gap-4">
                  <span className="text-ink-muted">{reason}</span>
                  <span className="numeric shrink-0 font-medium">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {analytics.expected_vs_realized.length > 0 && (
        <Card title="Expected vs realized" subtitle="Completed orders, most recent first">
          <Table head={["Order", "Sale", "Expected", "Realized", "Variance", "State"]}>
            {analytics.expected_vs_realized.slice(0, 10).map((row) => (
              <tr key={row.order_reference}>
                <td className="px-3 py-2 font-medium">{row.order_reference}</td>
                <td className="px-3 py-2"><Money value={row.sale_price} currency={d.currency} /></td>
                <td className="px-3 py-2"><Money value={row.expected_net_profit} currency={d.currency} /></td>
                <td className="px-3 py-2"><Money value={row.realized_net_profit} currency={d.currency} /></td>
                <td className="px-3 py-2"><Money value={row.variance} currency={d.currency} signed /></td>
                <td className="px-3 py-2"><StateBadge state={row.state} /></td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}
