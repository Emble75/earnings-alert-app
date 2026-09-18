import { ActionButton } from "@/components/actions";
import { Card, EmptyState, ErrorNotice, LinkButton, PageHeader, StateBadge, Table } from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";
import { titleCase } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Order states the operator physically works on. */
const WORK_STATES = [
  "SOURCE_PURCHASED", "SOURCE_SHIPPING", "SOURCE_RECEIVED", "INSPECTION", "FULFILLMENT", "OUTBOUND_SHIPPING",
];

export default async function FulfillmentPage() {
  let page;
  try {
    page = await api.orders({ limit: 100 });
  } catch (error) {
    return <ErrorNotice title="Could not load the fulfilment queue" message={error instanceof ApiRequestError ? error.message : String(error)} />;
  }

  const queue = page.items.filter((order) => WORK_STATES.includes(order.state));

  return (
    <>
      <PageHeader
        title="Fulfillment"
        description="Manual fulfilment: receive the parcel, inspect it, repack if needed, ship it and upload tracking. Handling costs nothing in the financial model - only packaging and postage do."
      />
      <Card title={`${queue.length} order${queue.length === 1 ? "" : "s"} in the queue`}>
        {queue.length === 0 ? (
          <EmptyState title="Nothing to handle" body="Approved and purchased orders appear here when they need physical work." />
        ) : (
          <Table head={["Order", "State", "Next step", ""]}>
            {queue.map((order) => (
              <tr key={order.id}>
                <td className="px-3 py-2 font-medium">{order.reference}</td>
                <td className="px-3 py-2"><StateBadge state={order.state} /></td>
                <td className="px-3 py-2 text-sm text-ink-muted">
                  {order.state === "SOURCE_PURCHASED" || order.state === "SOURCE_SHIPPING"
                    ? "Receive the parcel"
                    : order.state === "INSPECTION"
                      ? "Verify SKU, quantity and condition"
                      : order.state === "FULFILLMENT"
                        ? "Repack if needed, then ship"
                        : titleCase(order.state)}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    {(order.state === "SOURCE_PURCHASED" || order.state === "SOURCE_SHIPPING") && (
                      <ActionButton kind="receive" id={order.id} label="Receive" variant="primary" />
                    )}
                    {order.state === "INSPECTION" && (
                      <ActionButton kind="inspect" id={order.id} label="Inspection passed" variant="primary" />
                    )}
                    {order.state === "FULFILLMENT" && (
                      <>
                        <ActionButton kind="repack" id={order.id} label="Repack" />
                        <ActionButton kind="ship" id={order.id} label="Ship" variant="primary" />
                      </>
                    )}
                    <LinkButton href={`/orders/${order.id}`}>Open</LinkButton>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
