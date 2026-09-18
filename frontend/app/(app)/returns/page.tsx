import { Card, EmptyState, ErrorNotice, Money, PageHeader, StateBadge, Table } from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";
import { dateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ReturnsPage() {
  let page;
  try {
    page = await api.returns();
  } catch (error) {
    return <ErrorNotice title="Could not load returns" message={error instanceof ApiRequestError ? error.message : String(error)} />;
  }

  return (
    <>
      <PageHeader title="Returns" description="Returns reduce realized profit. Their real cost is booked against the order." />
      <Card title={`${page.total} return${page.total === 1 ? "" : "s"}`}>
        {page.items.length === 0 ? (
          <EmptyState title="No returns" body="Returns opened by buyers appear here." />
        ) : (
          <Table head={["Order", "State", "Reason", "Refund", "Return shipping", "Total cost", "Requested", "Closed"]}>
            {page.items.map((record) => (
              <tr key={record.id}>
                <td className="numeric px-3 py-2">{record.order_id}</td>
                <td className="px-3 py-2"><StateBadge state={record.state} /></td>
                <td className="max-w-xs truncate px-3 py-2 text-sm text-ink-muted">{record.reason ?? "—"}</td>
                <td className="px-3 py-2"><Money value={record.refund_amount} currency={record.currency} /></td>
                <td className="px-3 py-2"><Money value={record.return_shipping_cost} currency={record.currency} /></td>
                <td className="px-3 py-2"><Money value={record.total_return_cost} currency={record.currency} /></td>
                <td className="px-3 py-2 text-xs text-ink-muted">{dateTime(record.requested_at)}</td>
                <td className="px-3 py-2 text-xs text-ink-muted">{dateTime(record.closed_at)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
