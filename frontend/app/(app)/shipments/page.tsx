import { Card, EmptyState, ErrorNotice, Money, PageHeader, StateBadge, Table } from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";
import { dateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ShipmentsPage() {
  let page;
  try {
    page = await api.shipments();
  } catch (error) {
    return <ErrorNotice title="Could not load shipments" message={error instanceof ApiRequestError ? error.message : String(error)} />;
  }

  return (
    <>
      <PageHeader title="Shipments" description="Outbound and return legs. Tracking is idempotent: a retry never creates a second label." />
      <Card title={`${page.total} shipment${page.total === 1 ? "" : "s"}`}>
        {page.items.length === 0 ? (
          <EmptyState title="Nothing shipped yet" body="Shipments appear once an inspected order is dispatched." />
        ) : (
          <Table head={["Order", "Direction", "State", "Carrier", "Tracking", "Cost", "Estimated", "Delivered"]}>
            {page.items.map((shipment) => (
              <tr key={shipment.id}>
                <td className="numeric px-3 py-2">{shipment.order_id}</td>
                <td className="px-3 py-2 text-xs">{shipment.direction}</td>
                <td className="px-3 py-2"><StateBadge state={shipment.state} /></td>
                <td className="px-3 py-2">{shipment.carrier ?? "—"}</td>
                <td className="numeric px-3 py-2 text-xs">{shipment.tracking_number ?? "—"}</td>
                <td className="px-3 py-2"><Money value={shipment.shipping_cost} currency={shipment.currency} /></td>
                <td className="px-3 py-2 text-xs text-ink-muted">{dateTime(shipment.estimated_delivery)}</td>
                <td className="px-3 py-2 text-xs text-ink-muted">{dateTime(shipment.actual_delivery)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
