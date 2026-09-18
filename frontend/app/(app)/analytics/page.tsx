import { Card, EmptyState, ErrorNotice, Money, PageHeader, Stat, Table } from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";
import { dateTime, money } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  let analytics;
  let backtest;
  try {
    [analytics, backtest] = await Promise.all([api.analytics(), api.backtest()]);
  } catch (error) {
    return <ErrorNotice title="Could not load analytics" message={error instanceof ApiRequestError ? error.message : String(error)} />;
  }

  const d = analytics.dashboard;

  return (
    <>
      <PageHeader title="Analytics" description="Expected against realized, and why opportunities were filtered out." />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Realized profit" value={money(d.realized_profit_total, d.currency)} />
        <Stat
          label="Profit variance"
          value={money(d.profit_variance_total, d.currency)}
          hint="realized minus expected"
          tone={d.profit_variance_total.startsWith("-") ? "negative" : "positive"}
        />
        <Stat label="Capital exposed" value={money(d.capital_exposed, d.currency)} />
        <Stat label="Returns open" value={d.returns_open} />
      </div>

      <Card title="Expected vs realized" subtitle="An expectation is a forecast; this is what actually landed.">
        {analytics.expected_vs_realized.length === 0 ? (
          <EmptyState title="No completed orders yet" body="Complete an order to compare its realized profit against the approved expectation." />
        ) : (
          <Table head={["Order", "Completed", "Sale", "Expected", "Realized", "Variance"]}>
            {analytics.expected_vs_realized.map((row) => (
              <tr key={row.order_reference}>
                <td className="px-3 py-2 font-medium">{row.order_reference}</td>
                <td className="px-3 py-2 text-xs text-ink-muted">{dateTime(row.completed_at)}</td>
                <td className="px-3 py-2"><Money value={row.sale_price} currency={d.currency} /></td>
                <td className="px-3 py-2"><Money value={row.expected_net_profit} currency={d.currency} /></td>
                <td className="px-3 py-2"><Money value={row.realized_net_profit} currency={d.currency} /></td>
                <td className="px-3 py-2"><Money value={row.variance} currency={d.currency} signed /></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Backtest" subtitle="Replayed against recorded history only">
        {!backtest.available ? (
          <div className="rounded border border-caution/30 bg-caution/10 p-4 text-sm text-caution">
            <p className="font-medium">Backtesting is unavailable</p>
            <p className="mt-1 text-ink-muted">{backtest.reason}</p>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Stat label="Observations" value={backtest.observations} hint={`${backtest.products_covered} products`} />
              <Stat label="Passed the filters" value={backtest.passed_filters} hint={`of ${backtest.opportunities_evaluated} evaluated`} />
              <Stat label="Reached the profit floor" value={backtest.reached_profit_threshold} hint={money(backtest.total_expected_profit, d.currency)} />
              <Stat label="Source price changes" value={backtest.source_price_changes} />
              <Stat label="Stock disappearances" value={backtest.stock_disappearances} />
              <Stat label="Window" value={`${dateTime(backtest.window_start)}`} hint={`to ${dateTime(backtest.window_end)}`} />
            </div>
            <ul className="mt-4 space-y-1 border-t border-border pt-3 text-xs text-ink-muted">
              {backtest.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          </>
        )}
      </Card>

      <Card title="Rejection breakdown" subtitle="The primary optimisation target is fewer false positives, not more rows.">
        {Object.keys(analytics.rejection_breakdown).length === 0 ? (
          <EmptyState title="Nothing filtered out yet" body="Run discovery to see why opportunities are rejected or blocked." />
        ) : (
          <Table head={["Reason", "Count"]}>
            {Object.entries(analytics.rejection_breakdown).map(([reason, count]) => (
              <tr key={reason}>
                <td className="px-3 py-2 text-sm text-ink-muted">{reason}</td>
                <td className="numeric px-3 py-2 font-medium">{count}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
