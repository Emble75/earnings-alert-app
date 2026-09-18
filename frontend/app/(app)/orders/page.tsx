import { Card, EmptyState, ErrorNotice, LinkButton, Money, PageHeader, StateBadge, Table } from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";
import { dateTime, percent } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  let page;
  try {
    page = await api.orders({ limit: 100 });
  } catch (error) {
    return (
      <ErrorNotice
        title="Could not load orders"
        message={error instanceof ApiRequestError ? error.message : String(error)}
      />
    );
  }

  const awaiting = page.items.filter((o) => o.state === "APPROVAL_REQUIRED");

  return (
    <>
      <PageHeader
        title="Orders"
        description="Every order starts from a sale. Nothing is bought until it has been revalidated and approved."
      />

      {awaiting.length > 0 && (
        <Card title={`${awaiting.length} awaiting approval`} subtitle="These need a decision before the source can be purchased.">
          <Table head={["Order", "Sale", "Expected profit", "Worst case", "Capital", ""]}>
            {awaiting.map((order) => (
              <tr key={order.id}>
                <td className="px-3 py-2 font-medium">{order.reference}</td>
                <td className="px-3 py-2"><Money value={order.sale_price} currency={order.currency} /></td>
                <td className="px-3 py-2"><Money value={order.expected_net_profit} currency={order.currency} signed /></td>
                <td className="px-3 py-2"><Money value={order.worst_case_net_profit} currency={order.currency} signed /></td>
                <td className="px-3 py-2"><Money value={order.capital_required} currency={order.currency} /></td>
                <td className="px-3 py-2 text-right"><LinkButton href={`/orders/${order.id}`} variant="primary">Review</LinkButton></td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <Card title={`${page.total} order${page.total === 1 ? "" : "s"}`}>
        {page.items.length === 0 ? (
          <EmptyState
            title="No orders yet"
            body="Orders appear when a listing sells. Publish a listing from the Opportunities page first."
          />
        ) : (
          <Table head={["Order", "State", "Sale", "Expected", "Realized", "Variance", "Margin", "Created", ""]}>
            {page.items.map((order) => (
              <tr key={order.id}>
                <td className="px-3 py-2 font-medium">{order.reference}</td>
                <td className="px-3 py-2"><StateBadge state={order.state} /></td>
                <td className="px-3 py-2"><Money value={order.sale_price} currency={order.currency} /></td>
                <td className="px-3 py-2"><Money value={order.expected_net_profit} currency={order.currency} signed /></td>
                <td className="px-3 py-2"><Money value={order.realized_net_profit} currency={order.currency} signed /></td>
                <td className="px-3 py-2"><Money value={order.profit_variance} currency={order.currency} signed /></td>
                <td className="numeric px-3 py-2">{percent(order.expected_margin)}</td>
                <td className="px-3 py-2 text-xs text-ink-muted">{dateTime(order.created_at)}</td>
                <td className="px-3 py-2 text-right"><LinkButton href={`/orders/${order.id}`}>Open</LinkButton></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
