import { Card, EmptyState, ErrorNotice, Money, PageHeader, Table } from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";
import { relativeAge } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function PriceHistoryPage() {
  let page;
  try {
    page = await api.opportunities({ limit: 100, apply_defaults: false });
  } catch (error) {
    return <ErrorNotice title="Could not load price history" message={error instanceof ApiRequestError ? error.message : String(error)} />;
  }

  return (
    <>
      <PageHeader
        title="Price history"
        description="Observed source and target prices with their freshness. Volatility from this history feeds the risk engine and suppresses momentary anomalies."
      />
      <Card title={`${page.total} tracked opportunit${page.total === 1 ? "y" : "ies"}`}>
        {page.items.length === 0 ? (
          <EmptyState title="No observations yet" body="Run discovery to start collecting price history." />
        ) : (
          <Table head={["Reference", "Source price", "Observed", "Target price", "Observed", "Inventory checked"]}>
            {page.items.map((item) => (
              <tr key={item.id}>
                <td className="px-3 py-2 font-medium">{item.reference}</td>
                <td className="px-3 py-2"><Money value={item.source_price} currency={item.currency} /></td>
                <td className="px-3 py-2 text-xs text-ink-muted">{relativeAge(item.source_price_timestamp)}</td>
                <td className="px-3 py-2"><Money value={item.target_price} currency={item.currency} /></td>
                <td className="px-3 py-2 text-xs text-ink-muted">{relativeAge(item.source_price_timestamp)}</td>
                <td className="px-3 py-2 text-xs text-ink-muted">{relativeAge(item.inventory_timestamp)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
